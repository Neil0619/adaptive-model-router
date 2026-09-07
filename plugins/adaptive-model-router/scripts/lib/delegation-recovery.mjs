import { createHash } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { AppServerClient } from "./app-server.mjs";
import { parseCarrierTaskName } from "./delegation-gate.mjs";
import { canonicalJson, parseJson, payloadHash } from "./io.mjs";
import { auditNativeRecoveryTranscript, auditNativeLifecycle1533Transcript,
  readNativeRecoveryTranscript, RECOVERY_AUDIT_ADAPTER, LIFECYCLE_AUDIT_ADAPTER,
  LIFECYCLE_1533_AUDIT_ADAPTER, LIFECYCLE_1534_AUDIT_ADAPTER } from "./native-recovery-audit.mjs";
import { QUALIFICATION_RECOVERY_SCHEMA, failedQualificationRecoverySubject, auditFailedQualificationTranscript } from "./qualification-recovery.mjs";
import { readTaskQualification } from "./lifecycle-qualification.mjs";
import { qualificationTargetMatches } from "./qualification-policy.mjs";
import { auditNativeUnconsumed1534Transcript, isMetadataRecoveryAudit } from "./native-metadata-recovery-audit.mjs";
import { inspectNativePredispatchRejection, isPredispatchRecoveryReceipt } from "./native-predispatch-audit.mjs";

const PREFIX = "native_recovery:";
const SCHEMA = "native-thread-delegation-recovery/2";
const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
const present = (value) => typeof value === "string" && value.length > 0;
const isDigest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const UNCONSUMED_AUDITORS = Object.freeze({
  "0.153.0-alpha.5": { audit: auditNativeRecoveryTranscript, adapter: RECOVERY_AUDIT_ADAPTER },
  "0.153.3": { audit: auditNativeLifecycle1533Transcript, adapter: LIFECYCLE_1533_AUDIT_ADAPTER },
  "0.153.4": { audit: auditNativeUnconsumed1534Transcript, adapter: LIFECYCLE_1534_AUDIT_ADAPTER },
});

function unresolved(reasonCode = "RECOVERY_EVIDENCE_UNPROVEN") {
  return { status: "unresolved", reasonCode, gateReleased: false };
}

export function readNativeRecoveryReceipt(db, context, routeId) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(`${PREFIX}${routeId}`);
  if (!row) return null;
  try {
    const receipt = JSON.parse(row.value);
    if (isPredispatchRecoveryReceipt(receipt, context, routeId)) return receipt;
    const supported = receipt.schemaVersion === SCHEMA
      ? Object.hasOwn(UNCONSUMED_AUDITORS, receipt.cliVersion)
        && (receipt.rawAuditAdapter === UNCONSUMED_AUDITORS[receipt.cliVersion].adapter || isMetadataRecoveryAudit(receipt))
        && (receipt.recoveryKind === undefined || (receipt.recoveryKind === "unconsumed_qualification"
          && receipt.qualificationState === "pending" && receipt.ordinaryDelegationEnabled === false
          && receipt.originalDispatchConsumed === false && isDigest(receipt.qualificationDigest)))
      : receipt.schemaVersion === QUALIFICATION_RECOVERY_SCHEMA
        && receipt.rawAuditAdapter === LIFECYCLE_AUDIT_ADAPTER && receipt.cliVersion === "0.153.0"
        && receipt.recoveryKind === "failed_qualification" && receipt.qualificationState === "failed"
        && receipt.ordinaryDelegationEnabled === false && receipt.originalDispatchConsumed === true
        && ["qualificationDigest", "retainedOutcomeDigest", "dispatchInputDigest"].every((key) => isDigest(receipt[key]));
    return supported
      && receipt.subjectDigest === payloadHash([context.projectId, context.contextKey, routeId])
      && receipt.status === "reconciled_failure" && receipt.failureType === "tooling"
      && receipt.source === "native_thread_read" && receipt.originalHandshakeProven === false
      && isDigest(receipt.rawAuditDigest)
      && present(receipt.cliVersion) && present(receipt.recordedAt) && Number.isFinite(Date.parse(receipt.recordedAt))
      && Number.isSafeInteger(receipt.transcriptBytes) && receipt.transcriptBytes >= 0
      && ["evidenceDigest", "parentTurnDigest", "launchItemDigest", "childDigest", "childTurnDigest",
        "completionItemDigest", "finalResultDigest", "childItemsDigest"].every((key) => isDigest(receipt[key]))
      ? receipt : null;
  } catch {
    return null;
  }
}

function requireFact(condition) {
  if (!condition) throw new Error("native recovery evidence is incomplete or inconsistent");
}

function launchBinding(parent, attempt, input, cwd, subject) {
  requireFact(parent?.id === input.contextId && resolve(parent.cwd) === resolve(cwd));
  requireFact(!parent.parentThreadId && present(parent.cliVersion));
  requireFact(Array.isArray(parent.turns) && parent.turns.length <= 10_000);
  const activities = [];
  for (const turn of parent.turns) {
    requireFact(present(turn.id) && turn.itemsView === "full" && Array.isArray(turn.items));
    for (const item of turn.items) if (item.type === "subAgentActivity") {
      activities.push({ ...item, rootTurnId: turn.id });
    }
  }
  requireFact(activities.length <= 10_000);
  const matches = activities.filter((item) => {
    if (!item.agentPath?.startsWith("/root/")) return false;
    const carrier = parseCarrierTaskName(item.agentPath.slice(6));
    return carrier.valid && hash(carrier.ticket) === attempt.ticket_hash;
  });
  const starts = matches.filter((item) => item.kind === "started");
  const completions = matches.filter((item) => item.kind === "completed");
  requireFact(matches.length === 2 && starts.length === 1 && completions.length === 1);
  const [start] = starts;
  const [completion] = completions;
  requireFact(present(start.id) && present(start.agentThreadId));
  requireFact(completion.agentThreadId === start.agentThreadId);
  requireFact(completion.agentPath === start.agentPath && completion.rootTurnId === start.rootTurnId);
  // An interaction, second launch, or conflicting path is not this closed no-work case.
  requireFact(activities.filter((item) => item.agentThreadId === start.agentThreadId).length === 2);
  if (subject.schemaVersion === QUALIFICATION_RECOVERY_SCHEMA) {
    requireFact(start.rootTurnId === attempt.root_turn_id && start.id === attempt.tool_use_id);
  }
  // Existing parent metadata can predate the build that actually ran the child.
  // Only the qualification branch has a stored exact child-build binding.
  return { start, completion, cliVersion: subject.cliVersion || null };
}

function closedChild(child, binding, attempt, input, cwd, subject) {
  const { start, completion } = binding;
  // A long-lived parent may predate the executable that created this child.
  // Pin the actual child build, then verify that same build in its raw source.
  const cliVersion = binding.cliVersion || child?.cliVersion;
  requireFact(subject.schemaVersion !== SCHEMA || Object.hasOwn(UNCONSUMED_AUDITORS, cliVersion));
  const spawn = child?.source?.subAgent?.thread_spawn;
  requireFact(child?.id === start.agentThreadId && child.parentThreadId === input.contextId);
  requireFact(child.forkedFromId === null && resolve(child.cwd) === resolve(cwd));
  requireFact(child.cliVersion === cliVersion && child.model === attempt.model);
  requireFact(child.reasoningEffort === attempt.effort && present(child.path));
  requireFact(spawn?.parent_thread_id === input.contextId && spawn.depth === 1);
  requireFact(spawn.agent_path === start.agentPath);
  requireFact(Array.isArray(child.turns) && child.turns.length === 1);
  const [turn] = child.turns;
  requireFact(present(turn.id) && turn.status === "completed" && turn.error == null);
  requireFact(turn.itemsView === "full");
  requireFact(completion.id === `subagent-completed-${turn.id}`);
  requireFact(Array.isArray(turn.items) && turn.items.length > 0 && turn.items.length <= 128);
  if (subject.schemaVersion === QUALIFICATION_RECOVERY_SCHEMA) {
    requireFact(turn.items.every((item) => ["reasoning", "agentMessage"].includes(item.type)));
  }
  const finals = [];
  for (const item of turn.items) {
    requireFact(present(item.id));
    if (item.type === "reasoning") continue;
    if (item.type === "agentMessage") {
      requireFact(["commentary", "final_answer"].includes(item.phase) && present(item.text));
      if (item.phase === "final_answer") finals.push(item);
      continue;
    }
    requireFact(item.type === "subAgentActivity" && item.kind === "interacted"
      && item.agentThreadId === input.contextId && item.agentPath === "/root");
  }
  requireFact(finals.length === 1 && turn.items.at(-1).id === finals[0].id);
  // No text assertion is interpreted as proof of no work or no child. Only this
  // exact host-authored activity/turn projection is eligible; any tool or unknown
  // item, resumed turn, descendant, or incomplete terminal evidence is rejected.
  return {
    parentTurnDigest: hash(start.rootTurnId), launchItemDigest: hash(start.id),
    childDigest: hash(child.id), childTurnDigest: hash(turn.id),
    completionItemDigest: hash(completion.id), finalResultDigest: payloadHash(finals[0]),
    childItemsDigest: payloadHash(turn.items), cliVersion,
  };
}

function measureNativeTranscript(path) {
  const codexRoot = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
  const actual = realpathSync(path);
  requireFact(actual === resolve(path) && !lstatSync(path).isSymbolicLink());
  requireFact(["sessions", "archived_sessions"].some((directory) => {
    const child = relative(join(codexRoot, directory), actual);
    return child && !child.startsWith(`..${sep}`) && child !== ".." && !child.startsWith(sep);
  }));
  const stats = statSync(actual);
  requireFact(stats.isFile() && Number.isSafeInteger(stats.size));
  const bytes = Math.max(stats.size, Number(stats.blocks) * 512);
  requireFact(Number.isSafeInteger(bytes) && bytes >= 0);
  return {
    bytes,
    identityDigest: payloadHash([stats.dev, stats.ino, stats.size, stats.blocks, stats.mtimeMs, stats.ctimeMs]),
  };
}

function eligible(attempt) {
  return attempt && attempt.ticket_consumed === 0 && attempt.outcome_recorded === 0
    && attempt.post_observed === 0 && attempt.stop_observed === 0
    && attempt.no_child === 0 && !attempt.finalized_at && present(attempt.ticket_hash);
}

function recoverySubject(store, context, attempt, cwd) {
  if (eligible(attempt)) {
    const qualification = readTaskQualification(store.db, context);
    const route = store.db.prepare("SELECT * FROM routes WHERE route_id=? AND project_id=? AND context_key=?")
      .get(attempt.route_id, context.projectId, context.contextKey);
    const reasons = parseJson(route?.reason_codes_json, null);
    if (route?.action !== "delegate" || route.model !== attempt.model || route.effort !== attempt.effort
      || !Array.isArray(reasons) || reasons.length === 0 || !reasons.every(present)
      || qualification?.state === "invalid") return null;
    // The immutable route class owns this boundary. Missing or malformed
    // qualification metadata cannot turn a self-test into ordinary work.
    const isQualification = reasons.includes("HOST_LIFECYCLE_QUALIFICATION");
    if (isQualification || qualification?.routeId === attempt.route_id) {
      if (!isQualification || qualification?.routeId !== attempt.route_id
        || qualification.state !== "pending" || qualification.proof !== undefined
        || qualification.ticketHash !== attempt.ticket_hash || !qualificationTargetMatches(store.db, qualification, route)) return null;
      return { schemaVersion: SCHEMA, stateDigest: payloadHash({ attempt, qualification, route }),
        cliVersion: qualification.binding.cliVersion,
        receiptFields: { recoveryKind: "unconsumed_qualification", qualificationDigest: payloadHash(qualification),
          qualificationState: "pending", ordinaryDelegationEnabled: false, originalDispatchConsumed: false } };
    }
    return { schemaVersion: SCHEMA, stateDigest: payloadHash({ attempt, qualification, route }), receiptFields: {} };
  }
  return failedQualificationRecoverySubject(store.db, context, attempt, cwd);
}

function finishRecovery(store, context, input, stateDigest, receipt, cwd) {
  return store.transaction(() => {
    const current = store.db.prepare("SELECT * FROM delegation_attempts WHERE route_id = ?").get(input.routeId);
    const subject = recoverySubject(store, context, current, cwd);
    if (!subject || subject.stateDigest !== stateDigest) return unresolved("RECOVERY_STATE_CHANGED");
    const recordedAt = new Date().toISOString();
    const saved = { ...receipt, recordedAt };
    store.db.prepare("INSERT INTO meta(key, value) VALUES(?, ?)")
      .run(`${PREFIX}${input.routeId}`, canonicalJson(saved));
    // Preserve every missing original lifecycle field. This separate recovery
    // receipt is not a retroactive Pre/Post/Stop observation or normal outcome.
    store.db.prepare(`
      UPDATE delegation_attempts SET finalized_at = ?, updated_at = ?, ambiguous = 1,
        ticket_hash = NULL, context_package = NULL
      WHERE route_id = ? AND project_id = ? AND context_key = ? AND finalized_at IS NULL
    `).run(recordedAt, recordedAt, input.routeId, context.projectId, context.contextKey);
    store.db.prepare(`
      INSERT INTO delegation_usage(project_id, context_key, total_transcript_bytes, untrusted, updated_at)
      VALUES(?, ?, ?, 0, ?)
      ON CONFLICT(project_id, context_key) DO UPDATE SET
        total_transcript_bytes = total_transcript_bytes + excluded.total_transcript_bytes,
        updated_at = excluded.updated_at
    `).run(context.projectId, context.contextKey, receipt.transcriptBytes, recordedAt);
    store.db.prepare("UPDATE route_score_snapshots SET eligible_learning = 0 WHERE route_id = ?").run(input.routeId);
    return { status: "reconciled_failure", gateReleased: true, idempotent: false, receipt: saved };
  });
}

/** Operator-invoked recovery only. Not a route, outcome, admission bypass, or a
 * general terminal inference. readThread/measureTranscript are in-process test
 * seams; the CLI exposes neither source substitution nor caller-written proof. */
export async function recoverDelegation(input, {
  store, cwd, readThread = null, measureTranscript = measureNativeTranscript,
  readTranscript = readNativeRecoveryTranscript,
  readParentTranscript,
} = {}) {
  if (!present(input?.contextId) || !present(input.routeId)
    || (input.apply !== undefined && typeof input.apply !== "boolean")
    || (input.expectedEvidenceDigest !== undefined && !isDigest(input.expectedEvidenceDigest))
    || Object.keys(input).some((key) => !["contextId", "routeId", "apply", "expectedEvidenceDigest"].includes(key))) {
    return unresolved("RECOVERY_INVALID_INPUT");
  }
  const context = store.context({ cwd, contextId: input.contextId, create: false });
  const oldReceipt = readNativeRecoveryReceipt(store.db, context, input.routeId);
  if (oldReceipt) return input.apply && input.expectedEvidenceDigest !== oldReceipt.evidenceDigest
    ? unresolved("RECOVERY_EVIDENCE_CHANGED")
    : { status: "reconciled_failure", gateReleased: true, idempotent: true, receipt: oldReceipt };
  const attempt = store.db.prepare(`
    SELECT * FROM delegation_attempts WHERE route_id = ? AND project_id = ? AND context_key = ?
  `).get(input.routeId, context.projectId, context.contextKey);
  const subject = recoverySubject(store, context, attempt, cwd);
  if (!subject) return unresolved("RECOVERY_ATTEMPT_INELIGIBLE");
  const attemptDigest = subject.stateDigest;
  const auditTranscript = (bytes, child, parentId) => subject.schemaVersion === SCHEMA
    ? UNCONSUMED_AUDITORS[child.cliVersion].audit(bytes, child, parentId)
    : auditFailedQualificationTranscript(bytes, child, parentId, cwd);
  const client = readThread ? null : new AppServerClient({ timeoutMs: 20_000 });
  const deadline = Date.now() + 20_000;
  const read = readThread || (async (threadId) => {
    await client.start(deadline);
    const value = await client.request("thread/read", { threadId, includeTurns: true }, deadline);
    return value.thread;
  });
  try {
    const parent = await read(input.contextId);
    // A separate, exact native adapter covers ordinary launches rejected by
    // PreToolUse before dispatch. Qualification recovery keeps its own proof
    // and retry contracts; generic errors never enter this branch.
    if (subject.schemaVersion === SCHEMA && subject.receiptFields.recoveryKind === undefined) {
      let denial = null;
      try {
        denial = await inspectNativePredispatchRejection({ parent, read, attempt,
          contextId: input.contextId, cwd, readParentTranscript });
      } catch { /* Existing child recovery remains available for its own case. */ }
      if (denial) {
        const subjectDigest = payloadHash([context.projectId, context.contextKey, input.routeId]);
        const evidenceDigest = payloadHash({ subjectDigest, attemptDigest, projection: denial.projection });
        if (input.apply !== true) return { status: "recoverable", evidenceDigest, gateReleased: false,
          disposition: "reconciled_failure", failureType: "tooling", transcriptBytes: 0,
          recoveryKind: "rejected_before_dispatch" };
        if (input.expectedEvidenceDigest !== evidenceDigest) return unresolved("RECOVERY_EVIDENCE_CHANGED");
        return finishRecovery(store, context, input, attemptDigest, {
          ...denial.projection, subjectDigest, evidenceDigest, sourceBytes: denial.sourceBytes,
          sourceDigest: denial.sourceDigest, status: "reconciled_failure", failureType: "tooling",
          source: "native_thread_read", originalHandshakeProven: false, transcriptBytes: 0,
        }, cwd);
      }
    }
    const binding = launchBinding(parent, attempt, input, cwd, subject);
    const child = await read(binding.start.agentThreadId);
    const projection = closedChild(child, binding, attempt, input, cwd, subject);
    const firstMeasure = await measureTranscript(child.path);
    const firstAudit = auditTranscript(await readTranscript(child.path), child, input.contextId);
    const nextChild = await read(binding.start.agentThreadId);
    const nextParent = await read(input.contextId);
    const nextBinding = launchBinding(nextParent, attempt, input, cwd, subject);
    const nextProjection = closedChild(nextChild, nextBinding, attempt, input, cwd, subject);
    const secondAudit = auditTranscript(await readTranscript(nextChild.path), nextChild, input.contextId);
    const secondMeasure = await measureTranscript(nextChild.path);
    requireFact(payloadHash(projection) === payloadHash(nextProjection));
    requireFact(payloadHash(firstMeasure) === payloadHash(secondMeasure));
    requireFact(payloadHash(firstAudit) === payloadHash(secondAudit) && secondAudit.sourceBytes <= secondMeasure.bytes);
    requireFact(Number.isSafeInteger(secondMeasure.bytes) && secondMeasure.bytes >= 0
      && /^[a-f0-9]{64}$/u.test(secondMeasure.identityDigest));
    const subjectDigest = payloadHash([context.projectId, context.contextKey, input.routeId]);
    const evidenceDigest = payloadHash({ schemaVersion: subject.schemaVersion, subjectDigest, attemptDigest, projection,
      measurement: secondMeasure, audit: secondAudit });
    if (input.apply !== true) return {
      status: "recoverable", evidenceDigest, gateReleased: false,
      disposition: "reconciled_failure", failureType: "tooling", transcriptBytes: secondMeasure.bytes,
      ...subject.receiptFields,
    };
    if (input.expectedEvidenceDigest !== evidenceDigest) return unresolved("RECOVERY_EVIDENCE_CHANGED");
    return finishRecovery(store, context, input, attemptDigest, {
      schemaVersion: subject.schemaVersion, subjectDigest, evidenceDigest, status: "reconciled_failure",
      failureType: "tooling", source: "native_thread_read", originalHandshakeProven: false,
      ...projection, ...secondAudit, transcriptBytes: secondMeasure.bytes,
      ...subject.receiptFields,
    }, cwd);
  } catch {
    return unresolved();
  } finally {
    client?.close();
  }
}
