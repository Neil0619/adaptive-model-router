import { NativeActivity } from "./native-activity.mjs";
import { payloadHash } from "./io.mjs";
import { openPrivateState } from "./private-state.mjs";
import { readStableRollout } from "./native-rollout-reader.mjs";
import { readChildTurnEvidence } from "./child-turn-evidence.mjs";
import { readChildCommands } from "./child-command-journal.mjs";
import { stageClosureStatus } from "./stage-closure.mjs";
import { rememberedRootTranscript } from "./stage-reconciliation.mjs";
import { GLOBAL_PENDING_LIMIT, reservationInventory, saveReservationRelease, sourceFingerprint } from "./reservation-ledger.mjs";

function rootActivity(path, parentId, deadline, maintenanceCalls) {
  let started = null, ended = null, pendingInput = false;
  const activity = new NativeActivity({ maintenanceCalls });
  readStableRollout(path, (entry, line) => {
    activity.observe(entry);
    const p = entry.payload;
    if (line === 1 && (entry.type !== "session_meta" || p?.id !== parentId
      || p.parent_thread_id || p.source?.subagent)) throw new Error("root identity changed");
    if (entry.type === "event_msg" && p?.type === "task_started") started = p.turn_id;
    if (entry.type === "response_item" && p?.type === "message" && p.role === "user") pendingInput = true;
    if (entry.type === "event_msg" && p?.type === "task_complete") { ended = p.turn_id; pendingInput = false; }

  }, { deadline });
  return { idle: Boolean(started && ended === started && !pendingInput), lastActivity: activity.result() };
}

function retainResult(locator, facts, deadline) {
  const retained = { inputs: [], finals: [], final: null, transcriptDigest: facts.transcriptDigest };
  let bytes = 0;
  const source = readStableRollout(locator.transcriptPath, (entry, line) => {
    const p = entry.payload;
    if (entry.type !== "response_item") return;
    if (p?.type === "agent_message" || (p?.type === "message" && p.role === "assistant" && p.phase === "final_answer")) {
      bytes += Buffer.byteLength(JSON.stringify(p));
      if (bytes > 1024 * 1024) throw new Error("retained stage evidence exceeds bounded storage");
      if (p.type === "agent_message") retained.inputs.push(p);
      else { retained.finals.push(p); if (line === facts.lastFinal.line) retained.final = p; }
    }
  }, { deadline });
  if (!retained.final || source.transcriptDigest !== facts.transcriptDigest) throw new Error("retained result changed");
  return retained;
}

export function inspectReclamationCandidate(db, attempt, { deadline = Infinity } = {}) {
  const context = { projectId: attempt.project_id, contextKey: attempt.context_key };
  const child = db.prepare("SELECT * FROM delegation_children WHERE route_id=?").get(attempt.route_id);
  if (!child || (attempt.maintenance_only ? child.state !== "settled" : (attempt.ambiguous || !attempt.agent_id || !attempt.post_observed))) return { reason: "unproven_identity" };
  try {
    const locator = JSON.parse(openPrivateState(db, child.locator));
    const rootPath = rememberedRootTranscript(db, context);
    if (!rootPath) return { reason: "missing_root_evidence" };
    const paths = [rootPath, locator.transcriptPath], before = paths.map(sourceFingerprint);
    const maintenance = db.prepare("SELECT start_revision FROM delegation_maintenance WHERE route_id=?").get(attempt.route_id);
    const firstIntent = db.prepare("SELECT MIN(revision) AS revision FROM delegation_stage_journal WHERE route_id=? AND kind='intent'").get(attempt.route_id);
    const maintenanceStart = firstIntent?.revision ?? maintenance?.start_revision;
    const messages = db.prepare("SELECT * FROM delegation_messages WHERE route_id=? ORDER BY revision").all(attempt.route_id);
    const maintenanceCalls = new Set(messages.filter((m) => maintenance && m.revision > maintenanceStart)
      .map((m) => JSON.stringify([m.caller_turn_id, m.call_id])));
    const root = rootActivity(rootPath, locator.parentContextId, deadline, maintenanceCalls);
    if (!root.idle) return { reason: "root_active_or_unknown" };
    const maintenanceInputOffset = maintenance ? 1 + messages.filter((m) => m.revision <= maintenanceStart
      && m.status === "accepted" && m.kind !== "interrupt_agent").length : Infinity;
    const facts = readChildTurnEvidence(locator, { commands: readChildCommands(db, attempt.route_id), deadline, maintenanceInputOffset });
    if (facts.pendingOperations.length || facts.pendingCalls.length) return { reason: "operations_pending" };
    if (!facts.finished) return { reason: "child_active_or_inputs_pending" };
    const closure = stageClosureStatus(db, context, attempt.route_id, { deadline });
    if (closure?.state !== "ready") return { reason: closure?.reason || "closure_unproven" };
    if (!root.lastActivity || !facts.lastActivity) return { reason: "activity_time_unproven" };
    const retained = retainResult(locator, facts, deadline);
    if (payloadHash(before) !== payloadHash(paths.map(sourceFingerprint))) return { reason: "evidence_changed" };
    return { eligible: true, kind: (attempt.outcome_recorded || attempt.maintenance_only) ? "verified_terminal" : "verified_deferral",
      lastActivity: Math.max(root.lastActivity, facts.lastActivity), paths, fingerprints: before,
      closureToken: closure.token, context, retained };
  } catch { return { reason: "evidence_unavailable" }; }
}

// Called only by real admission inside BEGIN IMMEDIATE. No model, child tools,
// background scheduler or status read performs this mutation. Unresolved work
// remains attached to its original owner and gate; only the global slot leaves.
export function reclaimGlobalReservations(db, requester, { maximumPending = GLOBAL_PENDING_LIMIT, required = 1 } = {}) {
  if (!db.isTransaction) throw new Error("global reclamation requires a write transaction");
  const deadline = Date.now() + 1500;
  const inventory = reservationInventory(db, { deadline });
  if (inventory.pending.length + required <= maximumPending) return { released: 0, skipped: {} };
  const candidates = [], skipped = {};
  const skip = (reason) => { skipped[reason] = (skipped[reason] || 0) + 1; };
  if (inventory.verificationDeferred) skipped.inventory_budget_exhausted = inventory.verificationDeferred;
  for (const attempt of inventory.pending) {
    if (Date.now() > deadline) { skip("scan_budget_exhausted"); break; }
    if (attempt.project_id === requester.projectId && attempt.context_key === requester.contextKey) { skip("requester_gate"); continue; }
    const view = inspectReclamationCandidate(db, attempt, { deadline });
    if (!view.eligible) { skip(view.reason); continue; }
    candidates.push({ attempt, view });
  }
  candidates.sort((a, b) => Number(b.view.kind === "verified_terminal") - Number(a.view.kind === "verified_terminal")
    || a.view.lastActivity - b.view.lastActivity || a.attempt.route_id.localeCompare(b.attempt.route_id));
  let released = 0;
  const verificationDeadline = deadline + 1000;
  for (const { attempt, view } of candidates) {
    if (reservationInventory(db, { deadline: verificationDeadline }).pending.length + required <= maximumPending) break;
    if (Date.now() > verificationDeadline) { skip("scan_budget_exhausted"); break; }
    const fresh = inspectReclamationCandidate(db, attempt, { deadline: verificationDeadline });
    if (!fresh.eligible || fresh.closureToken !== view.closureToken
      || payloadHash(fresh.fingerprints) !== payloadHash(view.fingerprints)) { skip("evidence_changed"); continue; }
    try { saveReservationRelease(db, attempt, { kind: view.kind, sources: view.paths, expectedSources: fresh.fingerprints,
      lastActivity: view.lastActivity, retained: fresh.retained,
      requesterContextId: requester.contextId || requester.contextKey,
      basis: "Global capacity pressure: native child and owning root turns have ended, current inputs and operations are verified. Preserve the original stage, results and remaining verification with its owner for deferred resumption; do not claim business success." });
    } catch { skip("evidence_changed"); continue; }
    released++;
  }
  return { released, skipped };
}
