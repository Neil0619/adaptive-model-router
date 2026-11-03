import { realpathSync } from "node:fs";
import { parseJson, payloadHash } from "./io.mjs";
import { capacityAttemptEligible, CAPACITY_SOURCE_BYTE_LIMIT } from "./host-capacity-recovery.mjs";
import { inspectNativeSpawnRejection } from "./native-host-capacity-audit.mjs";
import { recoveryRecordIntact } from "./native-recovery-receipt.mjs";
import { qualificationTargetMatches } from "./qualification-policy.mjs";
import { AppServerClient } from "./app-server.mjs";
import { rolloutIdentity } from "./native-rollout-reader.mjs";

const AUDITS = new WeakMap();

export const MODEL_REJECTION_SCHEMA = "native-thread-model-rejection-recovery/1";
const ADAPTER = "native-spawn-unknown-model-rejection/1";
export const MODEL_REJECTION_REASON = "HOST_MODEL_UNAVAILABLE";
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

export function acceptsUnknownModel(output, attempt) {
  if (typeof output !== "string") return false;
  const match = /^Unknown model `([a-z0-9.-]+)` for spawn_agent\.(?: |\n)Available models: ([a-z0-9.-]+(?:, [a-z0-9.-]+)*)$/u.exec(output);
  if (!match || match[1] !== attempt.model) return false;
  const available = match[2].split(", ");
  return !available.includes(attempt.model) && new Set(available).size === available.length;
}

// The operator CLI may have no runtime invocation. Locate only the original
// route's unique qualification within this exact project/context, never another
// task or an arbitrarily selected runtime generation.
export function rejectedModelQualification(db, context, routeId) {
  const prefix = `native_qualification:${context.projectId}:${context.contextKey}`;
  const rows = db.prepare("SELECT key,value FROM meta WHERE key=? OR key GLOB ?")
    .all(prefix, `${prefix}:runtime:*`)
    .map(row => ({ key: row.key, value: parseJson(row.value, null) }))
    .filter(row => row.value?.routeId === routeId);
  if (rows.length !== 1) return null;
  const row = rows[0];
  if (row.key !== prefix) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_stages'").get()) return null;
    const stage = db.prepare("SELECT generation FROM runtime_stages WHERE route_id=? AND project_id=? AND context_key=?")
      .get(routeId, context.projectId, context.contextKey);
    if (!digest(stage?.generation) || row.key !== `${prefix}:runtime:${stage.generation}`) return null;
  }
  return row.value;
}

export function hostModelRejectionSubject(db, context, attempt, cwd) {
  if (!capacityAttemptEligible(attempt) || ![0, 1].includes(attempt.ambiguous)) return null;
  const route = db.prepare("SELECT * FROM routes WHERE route_id=? AND project_id=? AND context_key=?")
    .get(attempt.route_id, context.projectId, context.contextKey);
  const outcome = db.prepare("SELECT * FROM outcomes WHERE route_id=?").get(attempt.route_id) || null;
  const reasons = parseJson(route?.reason_codes_json, null);
  if (route?.action !== "delegate" || route.model !== attempt.model || route.effort !== attempt.effort
    || !Array.isArray(reasons) || !reasons.length) return null;
  if (attempt.outcome_recorded !== 1 || attempt.outcome_status !== "failed" || outcome?.status !== "failed"
    || outcome.failure_type !== "tooling" || outcome.gate !== route.verification_gate
    || outcome.project_id !== context.projectId || outcome.context_key !== context.contextKey) return null;
  for (const table of ["delegation_children", "delegation_messages", "delegation_child_stops", "delegation_child_commands", "delegation_stage_journal", "delegation_maintenance"]) {
    if (db.prepare(`SELECT 1 FROM ${table} WHERE route_id=? LIMIT 1`).get(attempt.route_id)) return null;
  }
  const qualification = rejectedModelQualification(db, context, attempt.route_id);
  const isQualification = reasons.includes("HOST_LIFECYCLE_QUALIFICATION");
  if (isQualification) {
    if (reasons.length !== 1 || qualification?.state !== "failed" || qualification.proof !== null
      || !Number.isFinite(Date.parse(qualification.completedAt))
      || qualification.ticketHash !== attempt.ticket_hash || !qualificationTargetMatches(db, qualification, route)
      || qualification.binding.taskCwdDigest !== payloadHash(realpathSync(cwd))
      || !qualification.hooks.pre || Object.keys(qualification.hooks).some(key => !["pre", "post"].includes(key))
      || !Object.values(qualification.hooks).every(hook => hook.runtimeDigest === qualification.binding.runtimeDigest
        && qualification.binding.shellRoots.includes(hook.shellRoot))
      || route.verification_gate !== "structured-check"
      || !["retries", "retry_reasoning", "retry_environment", "retry_information", "retry_tooling", "escalations", "user_correction"]
        .every(field => outcome[field] === 0)) return null;
  } else if (qualification) return null;
  return { schemaVersion: MODEL_REJECTION_SCHEMA, stateDigest: payloadHash({ attempt, route, outcome, qualification }),
    receiptFields: { retainedOutcomeDigest: payloadHash(outcome), qualificationDigest: payloadHash(qualification),
      qualificationState: isQualification ? "failed" : null, ordinaryDelegationEnabled: false } };
}

export function inspectNativeModelRejection(options) {
  return inspectNativeSpawnRejection(options, { schemaVersion: MODEL_REJECTION_SCHEMA,
    recoveryKind: "host_model_rejected", adapter: ADAPTER, reason: MODEL_REJECTION_REASON,
    accepts: acceptsUnknownModel });
}

export function isModelRejectionReceipt(receipt, context, routeId) {
  return receipt?.schemaVersion === MODEL_REJECTION_SCHEMA && receipt.rawAuditAdapter === ADAPTER
    && recoveryRecordIntact(receipt) && receipt.recoveryKind === "host_model_rejected"
    && receipt.subjectDigest === payloadHash([context.projectId, context.contextKey, routeId])
    && receipt.status === "reconciled_failure" && receipt.failureType === "tooling"
    && receipt.source === "native_thread_read" && receipt.originalHandshakeProven === true
    && receipt.originalDispatchConsumed === true && receipt.transcriptBytes === 0
    && receipt.rejectionCode === MODEL_REJECTION_REASON && receipt.ordinaryDelegationEnabled === false
    && [null, "failed"].includes(receipt.qualificationState) && Number.isFinite(Date.parse(receipt.recordedAt))
    && Number.isSafeInteger(receipt.sourceBytes) && receipt.sourceBytes > 0 && receipt.sourceBytes <= CAPACITY_SOURCE_BYTE_LIMIT
    && ["evidenceDigest", "rawAuditDigest", "sourceDigest", "parentTurnDigest", "launchItemDigest",
      "rejectionItemDigest", "dispatchInputDigest", "retainedOutcomeDigest", "qualificationDigest"].every(key => digest(receipt[key]));
}

function retainedModelState(db, context, qualification) {
  if (qualification?.state !== "failed" || qualification.proof !== null) return null;
  const routeId = qualification.routeId;
  const original = rejectedModelQualification(db, context, routeId);
  const receipt = parseJson(db.prepare("SELECT value FROM meta WHERE key=?").get(`native_recovery:${routeId}`)?.value, null);
  const attempt = db.prepare("SELECT * FROM delegation_attempts WHERE route_id=? AND project_id=? AND context_key=?")
    .get(routeId, context.projectId, context.contextKey);
  const route = db.prepare("SELECT * FROM routes WHERE route_id=?").get(routeId);
  const outcome = db.prepare("SELECT * FROM outcomes WHERE route_id=?").get(routeId);
  if (!isModelRejectionReceipt(receipt, context, routeId) || receipt.qualificationState !== "failed"
    || payloadHash(original) !== payloadHash(qualification) || receipt.qualificationDigest !== payloadHash(qualification)
    || receipt.retainedOutcomeDigest !== payloadHash(outcome) || !qualificationTargetMatches(db, qualification, route)
    || !attempt?.finalized_at || attempt.ambiguous !== 1 || attempt.ticket_hash !== null || attempt.context_package !== null
    || attempt.ticket_consumed !== 1 || attempt.stop_observed !== 0 || attempt.no_child !== 0
    || attempt.agent_id !== null || attempt.early_agent_id !== null || attempt.transcript_bytes !== null
    || attempt.early_transcript_bytes !== null || attempt.outcome_recorded !== 1 || attempt.outcome_status !== "failed"
    || attempt.dispatch_input_digest !== receipt.dispatchInputDigest || outcome?.status !== "failed"
    || outcome.failure_type !== "tooling" || route.reason_codes_json !== '["HOST_LIFECYCLE_QUALIFICATION"]') return null;
  return { qualification, receipt, attempt, route, outcome };
}

export function recoveredModelQualificationBasis(db, context, qualification) {
  const state = retainedModelState(db, context, qualification);
  return state ? payloadHash(state) : null;
}

export function modelQualificationAuditCurrent(store, result, context = null) {
  const audit = AUDITS.get(result);
  return Boolean(audit && audit.store === store
    && (!context || ["projectId", "contextKey", "runtimeDigest"].every(key => (context[key] || null) === (audit.context[key] || null)))
    && rolloutIdentity(audit.path) === audit.identity
    && recoveredModelQualificationBasis(store.db, audit.context, audit.qualification) === audit.basis);
}

// Re-read the original native refusal before an epoch handover or explicit
// one-use requalification. The retained failure is never changed into success.
export async function auditRecoveredModelQualification(input, { store, cwd, context, readThread, readParentTranscript } = {}) {
  const q = rejectedModelQualification(store.db, context, input.routeId);
  const state = retainedModelState(store.db, context, q);
  if (!state) return { status: "unresolved", gateReleased: false };
  const client = readThread ? null : new AppServerClient({ timeoutMs: 20_000 });
  try {
    const read = readThread || (async threadId => {
      await client.start(); return (await client.request("thread/read", { threadId, includeTurns: true })).thread;
    });
    const parent = await read(input.contextId), identity = rolloutIdentity(parent.path);
    const attempt = { ...state.attempt, finalized_at: null, ticket_hash: q.ticketHash };
    const audit = await inspectNativeModelRejection({ parent, read, attempt, contextId: input.contextId, cwd, readParentTranscript });
    if (audit.projection.rawAuditDigest !== state.receipt.rawAuditDigest || identity !== rolloutIdentity(parent.path)
      || recoveredModelQualificationBasis(store.db, context, q) !== payloadHash(state)) return { status: "unresolved", gateReleased: false };
    const result = { status: "reconciled_failure", gateReleased: true, ordinaryDelegationEnabled: false,
      evidenceDigest: state.receipt.evidenceDigest, rawAuditDigest: audit.projection.rawAuditDigest };
    AUDITS.set(result, { store, context, qualification: q, basis: payloadHash(state), path: parent.path, identity });
    return result;
  } finally { client?.close(); }
}
