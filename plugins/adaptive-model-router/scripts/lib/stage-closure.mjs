import { parseJson, payloadHash } from "./io.mjs";
import { openPrivateState, sealPrivateState } from "./private-state.mjs";
import { readChildTurnEvidence } from "./child-turn-evidence.mjs";
import { readThreadSpawnIdentity } from "./subagent-session.mjs";
import { createHash } from "node:crypto";
import { reconcileStageMessages, rejectionHostCurrent } from "./stage-reconciliation.mjs";
import { createChildCommandSchema, readChildCommands } from "./child-command-journal.mjs";
import { applyOperationReviews, readOperations, reconcileOperations } from "./operation-reconciliation.mjs";
import { readStableRollout } from "./native-rollout-reader.mjs";
import { readReservationRelease, reacquireReservation } from "./reservation-ledger.mjs";

const now = () => new Date().toISOString();
const present = (value) => typeof value === "string" && value.length > 0;
const MESSAGE_TOOLS = new Map([
  ["send_message", "send_message"], ["collaborationsend_message", "send_message"],
  ["interrupt_agent", "interrupt_agent"], ["collaborationinterrupt_agent", "interrupt_agent"],
  ["followup_task", "followup_task"], ["collaborationfollowup_task", "followup_task"],
]);

export const isRouterChildTarget = (target) => typeof target === "string"
  && /^(?:\/root\/)?router_[a-f0-9]{32}$/u.test(target);

export function createStageMessageSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS delegation_messages (
    route_id TEXT NOT NULL REFERENCES delegation_children(route_id) ON DELETE CASCADE,
    caller_turn_id TEXT NOT NULL, call_id TEXT NOT NULL, author TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('send_message','followup_task','interrupt_agent')),
    input_digest TEXT NOT NULL, revision INTEGER NOT NULL, source_order INTEGER,
    status TEXT NOT NULL CHECK (status IN ('pending','accepted','unknown','rejected')),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(route_id, caller_turn_id, call_id), UNIQUE(route_id, revision)
  )`);
}

export function createStageClosureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS delegation_children (
      route_id TEXT PRIMARY KEY REFERENCES routes(route_id) ON DELETE CASCADE,
      project_id TEXT NOT NULL, context_key TEXT NOT NULL,
      task_hash TEXT NOT NULL, agent_hash TEXT NOT NULL, locator TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','settled','unknown')),
      verified_revision INTEGER, verified_digest TEXT,
      accounted_bytes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(project_id, context_key, task_hash), UNIQUE(project_id, context_key, agent_hash)
    );
    CREATE TABLE IF NOT EXISTS delegation_child_stops (
      route_id TEXT NOT NULL REFERENCES delegation_children(route_id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL, result_digest TEXT NOT NULL, observed_at TEXT NOT NULL,
      PRIMARY KEY(route_id, turn_id, result_digest)
    );
    CREATE INDEX IF NOT EXISTS delegation_children_pending
      ON delegation_children(project_id, context_key, state);
    CREATE TABLE IF NOT EXISTS delegation_maintenance (
      route_id TEXT PRIMARY KEY REFERENCES delegation_children(route_id) ON DELETE CASCADE,
      intent TEXT NOT NULL CHECK(intent IN ('collect','cancelled','superseded','deferred')),
      state TEXT NOT NULL CHECK(state IN ('active','verified')),
      start_revision INTEGER NOT NULL, record TEXT NOT NULL,
      verified_token TEXT, accounted_bytes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS delegation_stage_journal (
      route_id TEXT NOT NULL REFERENCES delegation_children(route_id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, kind TEXT NOT NULL, record TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(route_id,revision,kind)
    );
    CREATE TRIGGER IF NOT EXISTS require_current_stage_closure BEFORE INSERT ON outcomes
      WHEN EXISTS (SELECT 1 FROM delegation_children c WHERE c.route_id=NEW.route_id
        AND (c.state!='open' OR COALESCE(c.verified_revision,-1)!=c.revision OR c.verified_digest IS NULL))
      BEGIN SELECT RAISE(ABORT, 'managed stage outcome requires current closure verification'); END;
  `);
  createStageMessageSchema(db);
  createChildCommandSchema(db);
}

export function registerManagedChild(db, context, routeId, locator, { trackCommands = false } = {}) {
  if (!present(locator?.transcriptPath)) return;
  const existing = db.prepare("SELECT * FROM delegation_children WHERE route_id=?").get(routeId);
  const taskHash = payloadHash(locator.taskName);
  const agentHash = payloadHash(locator.childId);
  if (existing && (existing.task_hash !== taskHash || existing.agent_hash !== agentHash)) {
    throw new Error("stage child identity changed");
  }
  // Only the trusted startup path can establish prospective Hook coverage.
  // Adoption or a later startup must never retroactively cover legacy calls.
  const saved = { ...locator };
  delete saved.commandCoverage;
  const previousCoverage = existing && JSON.parse(openPrivateState(db, existing.locator)).commandCoverage;
  if (previousCoverage) saved.commandCoverage = previousCoverage;
  else if (!existing && trackCommands) {
    const prefix = createHash("sha256");
    let throughLine = 0;
    try {
      readStableRollout(locator.transcriptPath, (entry, line) => {
        prefix.update(JSON.stringify(entry) + "\n"); throughLine = line;
      }, { allowAppend: true });
      saved.commandCoverage = { version: 1, throughLine, prefixDigest: prefix.digest("hex") };
    } catch { /* Unreadable history has no coverage; never infer an empty prefix. */ }
  }
  const timestamp = now();
  db.prepare(`INSERT INTO delegation_children(route_id, project_id, context_key, task_hash,
    agent_hash, locator, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(route_id) DO UPDATE SET locator=excluded.locator, updated_at=excluded.updated_at`)
    .run(routeId, context.projectId, context.contextKey, taskHash, agentHash,
      sealPrivateState(db, JSON.stringify(saved)), timestamp, timestamp);
}

export function targetedChild(db, context, target) {
  if (!present(target)) return null;
  const taskName = target.startsWith("/root/") ? target.slice(6) : target;
  return db.prepare(`SELECT * FROM delegation_children WHERE project_id=? AND context_key=?
    AND (task_hash=? OR agent_hash=?)`).get(context.projectId, context.contextKey,
    payloadHash(taskName), payloadHash(target)) || null;
}

export function observeManagedMessage(db, context, input, { post = false, author = "/root" } = {}) {
  const kind = MESSAGE_TOOLS.get(input.tool_name);
  if (!kind) return { matched: false };
  const child = targetedChild(db, context, input.tool_input?.target);
  if (!child) return isRouterChildTarget(input.tool_input?.target)
    ? { matched: true, allowed: false, reason: "This Router child has no current trusted ownership record. Wait for its startup or reconcile its historical identity before sending work; keep the requirement with the root." }
    : { matched: false };
  const deny = (reason) => ({ matched: true, allowed: false, routeId: child.route_id, reason });
  if (!present(author)) return deny("The message sender identity is unavailable; do not guess its stage ownership.");
  const authorKey = payloadHash(author);
  if (!present(input.turn_id) || !present(input.tool_use_id)) return deny("Managed followup is missing native call identity.");
  const key = [child.route_id, input.turn_id, input.tool_use_id];
  const maintenance = db.prepare("SELECT * FROM delegation_maintenance WHERE route_id=?").get(child.route_id);
  const digest = payloadHash(input.tool_input);
  const existing = db.prepare(`SELECT * FROM delegation_messages
    WHERE route_id=? AND caller_turn_id=? AND call_id=?`).get(...key);
  if (post) {
    if (!existing || existing.input_digest !== digest || existing.author !== authorKey || existing.kind !== kind) {
      db.prepare("UPDATE delegation_children SET state='unknown', updated_at=? WHERE route_id=?").run(now(), child.route_id);
      return deny("Managed message result could not be correlated; retain the pending work.");
    }
    const response = typeof input.tool_response === "string" ? parseJson(input.tool_response, null) : input.tool_response;
    const accepted = kind === "interrupt_agent" ? Boolean(response && Object.hasOwn(response, "previous_status")) : input.tool_response === "";
    const state = accepted ? "accepted" : "unknown";
    if (existing.status === "accepted" && !accepted) {
      db.prepare("UPDATE delegation_children SET state='unknown', updated_at=? WHERE route_id=?").run(now(), child.route_id);
    }
    db.prepare(`UPDATE delegation_messages SET status=?, updated_at=?
      WHERE route_id=? AND caller_turn_id=? AND call_id=?`).run(state, now(), ...key);
    return { matched: true, allowed: accepted, routeId: child.route_id, revision: existing.revision };
  }
  if (!maintenance && readReservationRelease(db, child.route_id)) return deny("This stage's global reservation was deferred. Read its disposition and begin bounded maintenance before sending more work; preserve original requirements.");
  if (kind === "interrupt_agent" && !maintenance) return deny("Record the explicit cancellation, replacement or deferral with manage_stage before interrupting this Router child; preserve partial results and outstanding operation references.");
  if (maintenance && (maintenance.state !== "active" || !["followup_task", "interrupt_agent"].includes(kind) || author !== "/root")) {
    return deny("This child accepts only the root's bounded maintenance followup. Preserve business requirements with the root; no QueueOnly or new-stage work.");
  }
  if (child.state !== "open" && maintenance?.state !== "active") return deny("This child stage is closed or awaiting reconciliation. Preserve the requirement and assign it to the current stage; do not send new business work to the old child.");
  if (existing) {
    // Hook delivery can repeat before the native handler runs. A changed payload
    // or a replay after its Post result is not a new permission to send.
    return existing.status === "pending" && existing.input_digest === digest && existing.author === authorKey && existing.kind === kind
      ? { matched: true, allowed: true, routeId: child.route_id, revision: existing.revision }
      : deny("The managed message call was already used or changed.");
  }
  if (db.prepare("SELECT 1 FROM delegation_messages WHERE route_id=? AND status NOT IN ('accepted','rejected')").get(child.route_id)) {
    return deny("A previous message is still awaiting its native result; reconcile that call before sending another.");
  }
  if (!maintenance && db.prepare("SELECT 1 FROM outcomes WHERE route_id=?").get(child.route_id)) {
    return deny("This stage already has a final outcome; use bounded maintenance for any historical pending input.");
  }
  if (kind === "followup_task" && !reacquireReservation(db, child.route_id)) return deny("ROUTER_GLOBAL_PENDING_LIMIT: bounded collection must reacquire a global slot before resuming this deferred child. Retain its requirements and retry only after current work releases capacity.");
  const revision = child.revision + 1;
  db.prepare(`INSERT INTO delegation_messages(route_id, caller_turn_id, call_id, author, kind,
    input_digest, revision, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?,'pending',?,?)`)
    .run(...key, authorKey, kind, digest, revision, now(), now());
  db.prepare(`UPDATE delegation_children SET revision=?, verified_revision=NULL, verified_digest=NULL,
    updated_at=? WHERE route_id=?`).run(revision, now(), child.route_id);
  db.prepare(`UPDATE delegation_attempts SET stop_observed=0, early_transcript_bytes=NULL,
    updated_at=? WHERE route_id=? AND finalized_at IS NULL`).run(now(), child.route_id);
  return { matched: true, allowed: true, routeId: child.route_id, revision };
}

export function observeManagedStop(db, routeId, { turnId, lastAssistantMessage } = {}) {
  if (!db.prepare("SELECT 1 FROM delegation_children WHERE route_id=?").get(routeId)) return false;
  if (present(turnId) && typeof lastAssistantMessage === "string") {
    db.prepare(`INSERT OR IGNORE INTO delegation_child_stops(route_id, turn_id, result_digest, observed_at)
      VALUES(?,?,?,?)`).run(routeId, turnId, payloadHash(lastAssistantMessage), now());
  }
  return true;
}

export function stageClosureStatus(db, context, routeId = null, { deadline = Infinity } = {}) {
  const child = routeId
    ? db.prepare("SELECT * FROM delegation_children WHERE project_id=? AND context_key=? AND route_id=?")
      .get(context.projectId, context.contextKey, routeId)
    : db.prepare(`SELECT * FROM delegation_children WHERE project_id=? AND context_key=? AND
      (state!='settled' OR route_id IN (SELECT route_id FROM delegation_maintenance WHERE state='active')) ORDER BY created_at LIMIT 1`)
      .get(context.projectId, context.contextKey);
  if (!child) return null;
  const maintenance = db.prepare("SELECT * FROM delegation_maintenance WHERE route_id=?").get(child.route_id);
  if (child.state === "settled" && maintenance?.state !== "active") return null;
  let locator;
  try { locator = JSON.parse(openPrivateState(db, child.locator)); } catch { /* Remain pending with no guessed target. */ }
  const target = locator?.agentPath;
  const pending = (reason, extra = {}) => ({ state: "pending", routeId: child.route_id, revision: child.revision, reason, ...extra,
    ...(maintenance ? { intent: maintenance.intent, maintenance: true } : {}),
    ...(target ? { target } : {}),
    nextAction: maintenance?.state === "active" && ["accepted_message_not_consumed", "maintenance_followup_required"].includes(reason) ? "followup_bounded_collection"
      : reason === "accepted_message_not_consumed" ? "followup_same_stage"
      : reason === "child_operations_pending" ? (extra.pendingOperations?.some((op) => op.kind === "unknown")
        ? "read_operations_and_verify_evidence" : extra.pendingOperations?.some((op) => op.kind !== "command")
        ? "poll_existing_operations" : "collect_existing_operation_result")
      : reason === "latest_child_turn_not_complete" ? "wait_for_current_child"
      : "reconcile_existing_operation" });
  if (child.state !== "open" && maintenance?.state !== "active") return pending("child_requires_reconciliation");
  const attempt = db.prepare("SELECT * FROM delegation_attempts WHERE route_id=?").get(child.route_id);
  if (child.state !== "settled") {
    if (!attempt || attempt.ambiguous !== 0) return pending("child_lifecycle_requires_reconciliation");
    if (attempt.post_observed !== 1 || !attempt.agent_id || attempt.no_child) return pending("child_launch_result_pending");
  }
  const messages = db.prepare("SELECT * FROM delegation_messages WHERE route_id=? ORDER BY author,COALESCE(source_order,9007199254740991),revision").all(child.route_id);
  if (messages.some((op) => !["accepted", "rejected"].includes(op.status)
    || (op.status === "rejected" && !rejectionHostCurrent(db, child, op)))) return pending("message_result_pending");
  const operations = messages.filter((op) => op.status === "accepted");
  let facts;
  const commands = readChildCommands(db, child.route_id);
  try { facts = applyOperationReviews(db, context, child, commands, readChildTurnEvidence(locator, { commands, deadline })); }
  catch { return pending("child_evidence_unavailable"); }
  if (facts.pendingOperations.length) return pending("child_operations_pending", { pendingOperations: facts.pendingOperations });
  if (!facts.finished) return pending("latest_child_turn_not_complete");
  if (maintenance?.state === "active" && !operations.some((op) => op.revision > maintenance.start_revision && op.kind === "followup_task")) return pending("maintenance_followup_required");
  const expected = new Map([[payloadHash("/root"), [true]]]); // The native spawn activation is the first input.
  for (const op of operations) {
    if (op.kind === "interrupt_agent") continue; // Request acceptance is not a new child input or a completion receipt.
    if (!expected.has(op.author)) expected.set(op.author, []);
    expected.get(op.author).push(op.kind === "followup_task");
  }
  for (const message of facts.messages) {
    const modes = expected.get(payloadHash(message.author));
    if (!modes?.length || modes.shift() !== message.triggerTurn) return pending("message_history_requires_reconciliation");
  }
  if ([...expected.values()].some((modes) => modes.length)) return pending("accepted_message_not_consumed");
  const final = facts.lastFinal;
  const stop = db.prepare("SELECT 1 FROM delegation_child_stops WHERE route_id=? AND turn_id=? AND result_digest=?");
  if (!stop.get(child.route_id, final.turnId, final.digest)
    && !(final.stopDigest && stop.get(child.route_id, final.turnId, final.stopDigest))) return pending("latest_stop_not_observed");
  const token = payloadHash({ routeId: child.route_id, revision: child.revision,
    commands, commandCompletions: facts.commandCompletions,
    operationSnapshotDigest: facts.operationSnapshotDigest, operationReviewDigest: facts.operationReviewDigest,
    final: { turnId: final.turnId, digest: final.digest,
      ...(final.stopDigest ? { stopDigest: final.stopDigest, stopEvidenceDigest: final.stopEvidenceDigest } : {}) },
    inputs: facts.messages.map(({ line: _line, ...message }) => message) });
  return { state: "ready", routeId: child.route_id, revision: child.revision,
    ...(maintenance ? { intent: maintenance.intent, maintenance: true } : {}),
    target, nextAction: maintenance?.state === "active" ? "verify_maintenance_dispositions" : "verify_current_result_and_record_outcome",
    finalTurnId: final.turnId, resultDigest: final.digest, token, transcriptBytes: facts.transcriptBytes,
    inputReferences: facts.messages.map(({ id, author, turnId, digest }) => ({ id, author, turnId, digest })) };
}

export function verifyStageClosure(db, context, routeId, token) {
  const closure = stageClosureStatus(db, context, routeId);
  if (!closure) return null; // Legacy records retain their existing recovery path.
  const maintenance = db.prepare("SELECT * FROM delegation_maintenance WHERE route_id=?").get(routeId);
  if (maintenance?.state === "active") throw new Error("Verify the bounded maintenance result and its dispositions with manage_stage before the final outcome.");
  if (closure.state !== "ready") {
    const error = new Error(`Stage closure is pending: ${closure.reason}. Complete or reconcile the current child work before recording an outcome.`);
    error.code = "STAGE_CLOSURE_PENDING";
    throw error;
  }
  if (closure.revision > 0 && token !== closure.token) {
    const error = new Error("Verify the current stageClosure result from get_route_status and pass its token as closureToken; an older result cannot settle the followup.");
    error.code = "STAGE_CLOSURE_REQUIRED";
    throw error;
  }
  db.prepare(`UPDATE delegation_children SET verified_revision=?, verified_digest=?, updated_at=? WHERE route_id=?
    AND (verified_revision IS NOT ? OR verified_digest IS NOT ?)`)
    .run(closure.revision, closure.token, now(), routeId, closure.revision, closure.token);
  // Older additive-compatible runtimes cannot silently bypass the new command
  // journal: the database outcome trigger requires this current verification.
  db.prepare("UPDATE delegation_child_commands SET verified=1 WHERE route_id=? AND verified=0").run(routeId);
  // Qualification preparation and final outcome admission both verify the
  // current closure. An unchanged projection must preserve its proof binding;
  // newly accepted input still resets stop_observed and invalidates that proof.
  db.prepare(`UPDATE delegation_attempts SET stop_observed=1, transcript_bytes=?, updated_at=? WHERE route_id=?
    AND (stop_observed != 1 OR transcript_bytes IS NOT ?)`)
    .run(closure.transcriptBytes, now(), routeId, closure.transcriptBytes);
  return closure;
}

export function childToolRestriction(db, context, target, input = {}) {
  const child = targetedChild(db, context, target);
  if (!child) return { restricted: true, reason: "Router child ownership is unavailable. Stop business tools and return the missing identity to the root." };
  const maintenance = db.prepare("SELECT * FROM delegation_maintenance WHERE route_id=?").get(child.route_id);
  if (maintenance?.state === "active") {
    try {
      const locator = JSON.parse(openPrivateState(db, child.locator));
      if (readChildTurnEvidence(locator, { commands: readChildCommands(db, child.route_id) }).permitsPoll(input)) return { restricted: false, existingOperationPoll: true };
    } catch { /* An unknown operation never grants a tool exception. */ }
  }
  if (maintenance || child.state !== "open" || readReservationRelease(db, child.route_id)) return { restricted: true, reason:
    "This Router child is in collection, cancellation, deferral or finalized state. No business tools, shell, file access, delegation or messaging are permitted. During active maintenance only, an exact previously observed native process/cell may be polled without input. A code-mode process poll must use only text(await tools.write_stdin({...})); with literal arguments and empty input; arbitrary code remains denied. Return the outstanding requirements, partial results and operation references to the root in your final reply; do not execute the old task." };
  return { restricted: false };
}

export function stageResponsibilities(db, context) {
  const rows = db.prepare(`SELECT c.route_id,c.revision,m.record FROM delegation_children c
    JOIN delegation_maintenance m USING(route_id) WHERE c.project_id=? AND c.context_key=? AND m.state='verified'`)
    .all(context.projectId, context.contextKey);
  return rows.flatMap((row) => {
    try {
      const report = JSON.parse(openPrivateState(db, row.record));
      const pending = report.requirements.filter((r) => ["deferred", "transferred"].includes(r.disposition));
      return pending.length ? [{ routeId: row.route_id, revision: row.revision,
        pending: pending.map(({ messageId, disposition }) => ({ messageId, disposition })),
        nextAction: "read_disposition_and_resume_or_resolve_requirements" }] : [];
    } catch {
      return [{ routeId: row.route_id, revision: row.revision, nextAction: "restore_unreadable_disposition", unreadable: true }];
    }
  });
}

/** Root-owned business disposition. Native facts are still checked separately;
 * a cancelled intent does not prove that an executing operation has stopped. */
export function manageStage(db, context, input, cwd) {
  if (input.action === "read_disposition") {
    const owned = db.prepare("SELECT route_id FROM delegation_attempts WHERE route_id=? AND project_id=? AND context_key=?")
      .get(input.routeId, context.projectId, context.contextKey);
    if (owned) {
      const release = readReservationRelease(db, input.routeId);
      if (release && !db.prepare("SELECT 1 FROM delegation_maintenance WHERE route_id=?").get(input.routeId)) return { state: "reservation_released", gateRetained: true, release,
        nextAction: "collect_and_verify_original_stage_before_new_business" };
    }
  }
  let child = db.prepare("SELECT * FROM delegation_children WHERE project_id=? AND context_key=? AND route_id=?")
    .get(context.projectId, context.contextKey, input.routeId);
  if (!child && ["reconcile_messages", "begin_maintenance"].includes(input.action) && input.childId && input.childTranscriptPath) {
    if (input.expectedRevision !== 0) throw new Error("Stage revision changed; historical adoption starts at revision zero.");
    const locator = readThreadSpawnIdentity({ cwd, session_id: input.contextId, agent_id: input.childId, transcript_path: input.childTranscriptPath });
    const attempt = db.prepare("SELECT * FROM delegation_attempts WHERE route_id=? AND project_id=? AND context_key=?")
      .get(input.routeId, context.projectId, context.contextKey);
    const agentHash = createHash("sha256").update(input.childId.normalize("NFC")).digest("hex");
    if (!locator || !isRouterChildTarget(locator.taskName) || !attempt || attempt.agent_id !== agentHash
      || attempt.ambiguous || !attempt.ticket_consumed || !attempt.post_observed) throw new Error("Historical child identity cannot be correlated to this route; preserve the reconciliation item.");
    registerManagedChild(db, context, input.routeId, locator);
    if (attempt.finalized_at) markManagedStageSettled(db, input.routeId);
    child = db.prepare("SELECT * FROM delegation_children WHERE route_id=?").get(input.routeId);
  }
  if (!child) throw new Error("No trusted child is registered for this route. Use reconcile_messages with its exact native identity before inspecting operations.");
  if (input.action === "reconcile_operations") return reconcileOperations(db, context, child, input);
  if (input.expectedRevision !== child.revision) throw new Error("Stage revision changed; inspect the latest state before changing its intent.");
  if (input.action === "read_operations") return readOperations(db, context, child);
  if (["read_disposition", "resolve_requirements"].includes(input.action)) {
    const maintenance = db.prepare("SELECT * FROM delegation_maintenance WHERE route_id=?").get(child.route_id);
    if (!maintenance) throw new Error("No stage disposition is recorded.");
    const current = JSON.parse(openPrivateState(db, maintenance.record));
    if (input.action === "read_disposition") {
      const release = readReservationRelease(db, child.route_id);
      return { state: maintenance.state, revision: child.revision, disposition: current,
        ...(release ? { release, gateRetained: !db.prepare("SELECT finalized_at FROM delegation_attempts WHERE route_id=?").get(child.route_id)?.finalized_at } : {}) };
    }
    if (maintenance.state !== "verified" || !input.disposition?.resultReview || !input.disposition.basis
      || !input.disposition.requirements.length || input.disposition.pendingOperations.length) throw new Error("Resolve retained work only after its actual result or intent change is verified.");
    const changes = input.disposition.requirements;
    if (new Set(changes.map((r) => r.messageId)).size !== changes.length || changes.some((change) => {
      const previous = current.requirements.find((r) => r.messageId === change.messageId);
      return !previous || !["deferred", "transferred"].includes(previous.disposition)
        || !["fulfilled", "cancelled", "superseded", "no_work", "deferred"].includes(change.disposition);
    })) throw new Error("Only a retained pending requirement can receive a concrete terminal disposition.");
    const updated = { ...current, requirements: current.requirements.map((r) => changes.find((change) => change.messageId === r.messageId) || r) };
    const revision = child.revision + 1;
    db.prepare("INSERT INTO delegation_stage_journal(route_id,revision,kind,record,created_at) VALUES(?,?,'responsibility_resolution',?,?)")
      .run(child.route_id, revision, sealPrivateState(db, JSON.stringify(input.disposition)), now());
    db.prepare("UPDATE delegation_maintenance SET record=?,updated_at=? WHERE route_id=?")
      .run(sealPrivateState(db, JSON.stringify(updated)), now(), child.route_id);
    db.prepare("UPDATE delegation_children SET revision=?,updated_at=? WHERE route_id=?").run(revision, now(), child.route_id);
    return { resolved: changes.length, revision };
  }
  if (input.action === "reconcile_messages") return reconcileStageMessages(db, context, child, input.parentTranscriptPath, input.senderTranscriptPaths);
  if (input.action === "begin_maintenance") {
    const existing = db.prepare("SELECT * FROM delegation_maintenance WHERE route_id=?").get(child.route_id);
    let retained;
    if (existing) {
      const priorIntent = db.prepare("SELECT record FROM delegation_stage_journal WHERE route_id=? AND kind='intent' ORDER BY revision DESC LIMIT 1").get(child.route_id);
      if (openPrivateState(db, priorIntent?.record || existing.record) === JSON.stringify(input.disposition)) {
        return { state: existing.state, revision: child.revision, idempotent: true };
      }
      if (existing.state !== "verified") throw new Error("Maintenance already has an intent; complete or explicitly resolve it before replacing the record.");
      retained = JSON.parse(openPrivateState(db, existing.record));
      if (input.disposition?.requirements?.some((requirement) => {
        const prior = retained.requirements.find((r) => r.messageId === requirement.messageId);
        return prior && payloadHash(prior) !== payloadHash(requirement);
      })) throw new Error("A new collection must preserve previous dispositions; resolve retained responsibility explicitly.");
    }
    if (!input.disposition?.intent || !input.disposition?.basis) throw new Error("Maintenance needs an explicit intent and its source; age or apparent idleness is insufficient.");
    reconcileStageMessages(db, context, child, input.parentTranscriptPath, input.senderTranscriptPaths);
    child = db.prepare("SELECT * FROM delegation_children WHERE route_id=?").get(child.route_id);
    if (existing) {
      db.prepare("UPDATE delegation_children SET revision=revision+1 WHERE route_id=?").run(child.route_id);
      child = db.prepare("SELECT * FROM delegation_children WHERE route_id=?").get(child.route_id);
    }
    const record = retained ? { ...input.disposition, requirements: [...retained.requirements,
      ...input.disposition.requirements.filter((r) => !retained.requirements.some((prior) => prior.messageId === r.messageId))] } : input.disposition;
    db.prepare(`INSERT INTO delegation_maintenance(route_id,intent,state,start_revision,record,created_at,updated_at)
      VALUES(?,?,'active',?,?,?,?) ON CONFLICT(route_id) DO UPDATE SET intent=excluded.intent,state='active',
        start_revision=excluded.start_revision,record=excluded.record,verified_token=NULL,updated_at=excluded.updated_at`)
      .run(child.route_id, input.disposition.intent, child.revision, sealPrivateState(db, JSON.stringify(record)), now(), now());
    db.prepare("INSERT INTO delegation_stage_journal(route_id,revision,kind,record,created_at) VALUES(?,?,'intent',?,?)")
      .run(child.route_id, child.revision, sealPrivateState(db, JSON.stringify(input.disposition)), now());
    db.prepare("UPDATE delegation_children SET verified_revision=NULL,verified_digest=NULL WHERE route_id=?").run(child.route_id);
    const locator = JSON.parse(openPrivateState(db, child.locator));
    return { state: "active", revision: child.revision, target: locator.agentPath, nextAction: "followup_bounded_collection",
      instruction: "Use native followup_task for this exact child. Collect every pending requirement, its original source, partial results, and any running or unknown operation references. Do not execute business work. Only an already observed native process/cell may be polled without input through its exact native wait tool. On code-mode hosts use only text(await tools.write_stdin({...})); with literal arguments for that known process and empty input. All other tools and arbitrary code remain denied. Return these facts in a final reply for root disposition. Preserve missing facts explicitly." };
  }
  if (input.action !== "verify_maintenance") throw new Error("Unsupported stage management action.");
  const maintenance = db.prepare("SELECT * FROM delegation_maintenance WHERE route_id=?").get(child.route_id);
  if (!maintenance) throw new Error("No bounded maintenance is active.");
  if (maintenance.state === "verified") {
    if (input.closureToken !== maintenance.verified_token) throw new Error("Maintenance verification differs from the retained result.");
    return { state: "verified", idempotent: true };
  }
  const closure = stageClosureStatus(db, context, child.route_id);
  if (closure?.state !== "ready" || closure.token !== input.closureToken) throw new Error("The current maintenance result is not ready or its verification token changed.");
  const report = input.disposition;
  if (!report || report.intent !== maintenance.intent || !report.basis || !report.resultReview
    || report.pendingOperations.length || report.requirements.some((r) => !r.source || !r.receipt || !r.owner)) {
    throw new Error("Verify the actual maintenance result, disposition each requirement, and resolve pending operations before closure.");
  }
  const locator = JSON.parse(openPrivateState(db, child.locator));
  const inputs = readChildTurnEvidence(locator).messages.slice(1);
  if (new Set(report.requirements.map((r) => r.messageId)).size !== report.requirements.length
    || inputs.some((message) => !report.requirements.some((r) => r.messageId === message.id))
    || report.requirements.some((r) => !inputs.some((message) => message.id === r.messageId))) {
    throw new Error("Every collected native input needs exactly one explicit disposition; preserve its source, result or receiving owner.");
  }
  // A new collection can disposition new inputs, but its terminal report cannot
  // rewrite responsibilities retained from an earlier verified collection.
  const priorVerification = db.prepare("SELECT record FROM delegation_stage_journal WHERE route_id=? AND kind='verification' AND revision<=? ORDER BY revision DESC LIMIT 1")
    .get(child.route_id, maintenance.start_revision);
  if (priorVerification) {
    // The active record includes any explicit resolve_requirements changes made
    // after the previous verification, so preserve that current version.
    const retained = JSON.parse(openPrivateState(db, maintenance.record));
    const previous = JSON.parse(openPrivateState(db, priorVerification.record));
    if (previous.requirements.some(({ messageId }) => {
      const original = retained.requirements.find((r) => r.messageId === messageId);
      return !original || payloadHash(original) !== payloadHash(report.requirements.find((r) => r.messageId === messageId));
    })) throw new Error("A new verification must preserve retained dispositions; use resolve_requirements for actual completion or an explicit intent change.");
  }
  const previousBytes = Math.max(maintenance.accounted_bytes, child.accounted_bytes);
  if (child.state === "settled") {
    const delta = Math.max(0, closure.transcriptBytes - previousBytes);
    db.prepare(`INSERT INTO delegation_usage(project_id,context_key,total_transcript_bytes,untrusted,updated_at)
      VALUES(?,?,?,0,?) ON CONFLICT(project_id,context_key) DO UPDATE SET
        total_transcript_bytes=total_transcript_bytes+excluded.total_transcript_bytes,updated_at=excluded.updated_at`)
      .run(context.projectId, context.contextKey, delta, now());
  }
  if (child.state === "settled") db.prepare("UPDATE delegation_children SET accounted_bytes=MAX(accounted_bytes,?) WHERE route_id=?").run(closure.transcriptBytes, child.route_id);
  db.prepare("UPDATE delegation_maintenance SET state='verified',record=?,verified_token=?,accounted_bytes=?,updated_at=? WHERE route_id=?")
    .run(sealPrivateState(db, JSON.stringify(report)), closure.token, closure.transcriptBytes, now(), child.route_id);
  db.prepare("INSERT INTO delegation_stage_journal(route_id,revision,kind,record,created_at) VALUES(?,?,'verification',?,?)")
    .run(child.route_id, child.revision, sealPrivateState(db, JSON.stringify(report)), now());
  return { state: "verified", revision: child.revision, resultDigest: closure.resultDigest,
    nextAction: child.state === "settled" ? "continue_current_authorized_stage" : "record_unique_failed_outcome_for_terminated_stage" };
}

export function managedStageCanFinalize(db, routeId) {
  const child = db.prepare("SELECT * FROM delegation_children WHERE route_id=?").get(routeId);
  return !child || (child.state === "open" && child.verified_revision === child.revision && child.verified_digest);
}

export function markManagedStageSettled(db, routeId) {
  db.prepare(`UPDATE delegation_children SET state='settled',accounted_bytes=MAX(accounted_bytes,
    COALESCE((SELECT transcript_bytes FROM delegation_attempts WHERE route_id=?),0)),updated_at=? WHERE route_id=?`)
    .run(routeId, now(), routeId);
}
