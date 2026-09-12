import { qualificationTargetMatches } from "./qualification-policy.mjs";
import { realpathSync } from "node:fs";
import { canonicalJson, payloadHash } from "./io.mjs";
import { NATIVE_LIFECYCLE_CLI_VERSIONS } from "./native-lifecycle-audit.mjs";

const DURATION_MS = 60 * 60 * 1000;
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const qualificationKey = (context) => `native_qualification:${context.projectId}:${context.contextKey}`;
const retryKey = (routeId) => `native_requalification:${routeId}`;
const diagnosticKey = (contextDigest) => `native_lifecycle_diagnostic:${contextDigest}`;
const denied = () => ({ status: "unresolved", ordinaryDelegationEnabled: false });

function read(db, key) {
  try { return JSON.parse(db.prepare("SELECT value FROM meta WHERE key=?").get(key)?.value); }
  catch { return null; }
}

function fingerprint(binding) {
  if (!NATIVE_LIFECYCLE_CLI_VERSIONS.includes(binding?.cliVersion) || !["runtimeDigest", "configurationDigest", "taskCwdDigest"].every((field) => digest(binding[field]))) return null;
  // The configured host/Hook set is shared by the CLI and the task's pinned
  // shell. Each new qualification still binds and verifies its own shell roots.
  return Object.fromEntries(["cliVersion", "runtimeDigest", "configurationDigest", "taskCwdDigest"].map((field) => [field, binding[field]]));
}

function recoveredBasis(db, context, qualification) {
  if (qualification?.state === "pending") return recoveredUnconsumedBasis(db, context, qualification);
  if (qualification?.schema !== 1 || qualification.state !== "failed" || qualification.proof !== null) return null;
  const routeId = qualification.routeId;
  const receipt = read(db, `native_recovery:${routeId}`);
  const attempt = db.prepare("SELECT * FROM delegation_attempts WHERE route_id=? AND project_id=? AND context_key=?")
    .get(routeId, context.projectId, context.contextKey);
  const outcome = db.prepare("SELECT * FROM outcomes WHERE route_id=? AND project_id=? AND context_key=?")
    .get(routeId, context.projectId, context.contextKey);
  const route = db.prepare("SELECT * FROM routes WHERE route_id=? AND project_id=? AND context_key=?")
    .get(routeId, context.projectId, context.contextKey);
  if (receipt?.schemaVersion !== "native-thread-delegation-recovery/3" || receipt.recoveryKind !== "failed_qualification"
    || receipt.status !== "reconciled_failure" || receipt.qualificationState !== "failed"
    || receipt.ordinaryDelegationEnabled !== false || receipt.originalDispatchConsumed !== true
    || receipt.subjectDigest !== payloadHash([context.projectId, context.contextKey, routeId])
    || receipt.qualificationDigest !== payloadHash(qualification) || receipt.retainedOutcomeDigest !== payloadHash(outcome)
    || receipt.dispatchInputDigest !== attempt?.dispatch_input_digest
    || !digest(receipt.evidenceDigest) || !digest(receipt.rawAuditDigest)
    || !attempt?.finalized_at || attempt.ambiguous !== 1 || attempt.ticket_hash !== null || attempt.context_package !== null
    || attempt.ticket_consumed !== 1 || attempt.post_observed !== 1 || attempt.stop_observed !== 0
    || attempt.agent_id !== null || attempt.no_child !== 0 || attempt.outcome_recorded !== 1
    || outcome?.status !== "failed" || outcome.failure_type !== "tooling" || outcome.gate !== "structured-check"
    || !qualificationTargetMatches(db, qualification, route)
    || route.reason_codes_json !== '["HOST_LIFECYCLE_QUALIFICATION"]') return null;
  return payloadHash({ qualification, receipt, attempt, outcome, route });
}

function recoveredUnconsumedBasis(db, context, qualification) {
  const routeId = qualification.routeId;
  const receipt = read(db, `native_recovery:${routeId}`);
  const attempt = db.prepare("SELECT * FROM delegation_attempts WHERE route_id=? AND project_id=? AND context_key=?")
    .get(routeId, context.projectId, context.contextKey);
  const route = db.prepare("SELECT * FROM routes WHERE route_id=? AND project_id=? AND context_key=?")
    .get(routeId, context.projectId, context.contextKey);
  if (qualification.schema !== 1 || qualification.proof !== undefined
    || receipt?.schemaVersion !== "native-thread-delegation-recovery/2" || receipt.recoveryKind !== "unconsumed_qualification"
    || receipt.status !== "reconciled_failure" || receipt.qualificationState !== "pending"
    || receipt.ordinaryDelegationEnabled !== false || receipt.originalDispatchConsumed !== false
    || receipt.subjectDigest !== payloadHash([context.projectId, context.contextKey, routeId])
    || receipt.qualificationDigest !== payloadHash(qualification) || receipt.cliVersion !== qualification.binding.cliVersion
    || !digest(receipt.evidenceDigest) || !digest(receipt.rawAuditDigest)
    || !attempt?.finalized_at || attempt.ambiguous !== 1 || attempt.ticket_hash !== null || attempt.context_package !== null
    || attempt.ticket_consumed !== 0 || attempt.post_observed !== 0 || attempt.stop_observed !== 0
    || attempt.outcome_recorded !== 0 || attempt.outcome_status !== null || attempt.no_child !== 0
    || attempt.agent_id !== null || attempt.dispatch_input_digest !== null || attempt.root_turn_id !== null || attempt.tool_use_id !== null
    || db.prepare("SELECT 1 FROM outcomes WHERE route_id=?").get(routeId)
    || !qualificationTargetMatches(db, qualification, route)
    || route.reason_codes_json !== '["HOST_LIFECYCLE_QUALIFICATION"]') return null;
  return payloadHash({ qualification, receipt, attempt, route });
}

function isFresh(value, now = Date.now()) {
  const issued = Date.parse(value?.issuedAt), expires = Date.parse(value?.expiresAt);
  return Number.isFinite(issued) && Number.isFinite(expires) && issued <= now && now < expires
    && expires - issued === DURATION_MS;
}

function completedFailedBasis(db, context, qualification) {
  if (qualification?.schema !== 1 || qualification.state !== "failed" || qualification.proof !== null
    || !["HOST_HOOK_SET_MISMATCH", "NATIVE_QUALIFICATION_EVIDENCE_UNPROVEN"].includes(qualification.failure)) return null;
  const routeId = qualification.routeId;
  const route = db.prepare("SELECT * FROM routes WHERE route_id=? AND project_id=? AND context_key=?")
    .get(routeId, context.projectId, context.contextKey);
  const outcome = db.prepare("SELECT * FROM outcomes WHERE route_id=? AND project_id=? AND context_key=?")
    .get(routeId, context.projectId, context.contextKey);
  const attempt = db.prepare("SELECT * FROM delegation_attempts WHERE route_id=? AND project_id=? AND context_key=?")
    .get(routeId, context.projectId, context.contextKey);
  if (route?.action !== "delegate" || route.verification_gate !== "structured-check"
    || route.reason_codes_json !== '["HOST_LIFECYCLE_QUALIFICATION"]' || !qualificationTargetMatches(db, qualification, route)
    || outcome?.status !== "failed" || outcome.gate !== "structured-check" || outcome.failure_type !== "tooling"
    || !attempt?.finalized_at || attempt.outcome_recorded !== 1 || attempt.outcome_status !== "failed"
    || attempt.ticket_consumed !== 1 || attempt.post_observed !== 1 || attempt.stop_observed !== 1
    || attempt.ambiguous !== 0 || attempt.no_child !== 0 || !digest(attempt.agent_id)
    || !digest(attempt.dispatch_input_digest) || attempt.ticket_hash !== null || attempt.context_package !== null
    || !Number.isSafeInteger(attempt.transcript_bytes) || attempt.transcript_bytes <= 0) return null;
  const normalized = { status: outcome.status, gate: outcome.gate, failureType: outcome.failure_type,
    retries: outcome.retries, retryBreakdown: { reasoning: outcome.retry_reasoning, environment: outcome.retry_environment,
      information: outcome.retry_information, tooling: outcome.retry_tooling }, escalations: outcome.escalations,
    userCorrection: outcome.user_correction === 1 };
  if (payloadHash(normalized) !== outcome.payload_hash) return null;
  return payloadHash({ qualification, route, outcome, attempt });
}

function authorizationEvidence(contextDigest, basisDigest, binding, audit = null, renewedFrom = null) {
  return payloadHash({ contextDigest, basisDigest, binding,
    ...(audit ? { kind: "completed-failed-noop", rawAuditDigest: audit } : {}),
    ...(renewedFrom ? { renewedFrom } : {}) });
}

function authorizedBasis(db, context, qualification, authorization) {
  return authorization?.kind === "completed-failed-noop" && digest(authorization.rawAuditDigest)
    ? completedFailedBasis(db, context, qualification) : recoveredBasis(db, context, qualification);
}

function authorizationEvidenceMatches(value) {
  return (value.renewedFrom === undefined || digest(value.renewedFrom))
    && value.evidenceDigest === authorizationEvidence(value.contextDigest, value.basisDigest, value.binding,
      value.kind === "completed-failed-noop" ? value.rawAuditDigest : null, value.renewedFrom);
}

function renewableAuthorization(value, { routeId, basisDigest, contextDigest, binding }, now = Date.now()) {
  const issued = Date.parse(value?.issuedAt), expires = Date.parse(value?.expiresAt);
  return value?.schema === 1 && value.state === "authorized" && !value.routeId && !value.consumedAt
    && value.priorRouteId === routeId && value.contextDigest === contextDigest && value.basisDigest === basisDigest
    && fingerprint(value.binding) && authorizationEvidenceMatches(value)
    && Number.isFinite(issued) && Number.isFinite(expires) && expires - issued === DURATION_MS && issued <= now
    && (expires <= now || payloadHash(value.binding) !== payloadHash(binding));
}

export function activeRequalification(db, context, qualification, binding) {
  const authorization = read(db, retryKey(qualification?.routeId));
  const current = fingerprint(binding);
  const basisDigest = authorizedBasis(db, context, qualification, authorization);
  if (!current || authorization?.schema !== 1 || authorization.state !== "authorized" || !isFresh(authorization)
    || !basisDigest || !digest(authorization.contextDigest)
    || authorization.priorRouteId !== qualification.routeId
    || authorization.basisDigest !== basisDigest
    || !authorizationEvidenceMatches(authorization)
    || payloadHash(authorization.binding) !== payloadHash(current)) return null;
  const diagnostic = read(db, diagnosticKey(authorization.contextDigest));
  if (diagnostic?.schema !== 1 || diagnostic.enabled !== true || diagnostic.contextDigest !== authorization.contextDigest
    || diagnostic.authorizationDigest !== authorization.evidenceDigest || diagnostic.expiresAt !== authorization.expiresAt
    || !isFresh(diagnostic)) return null;
  return { priorRouteId: qualification.routeId, authorizationDigest: authorization.evidenceDigest };
}

export function consumeRequalification(db, context, previous, next, ticketHash) {
  const authority = activeRequalification(db, context, previous, next.binding);
  if (!authority || payloadHash(authority) !== payloadHash(next.requalification)) return false;
  const authorization = read(db, retryKey(previous.routeId));
  const archive = `native_qualification_archive:${previous.routeId}`;
  if (db.prepare("SELECT 1 FROM meta WHERE key=?").get(archive)) return false;
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run(archive, canonicalJson(previous));
  db.prepare("UPDATE meta SET value=? WHERE key=?").run(canonicalJson({ ...next, ticketHash }), qualificationKey(context));
  db.prepare("UPDATE meta SET value=? WHERE key=?").run(canonicalJson({ ...authorization,
    state: "consumed", routeId: next.routeId, consumedAt: new Date().toISOString() }), retryKey(previous.routeId));
  return true;
}

/** Explicit operator command only. Inspection and public route/outcome tools
 * cannot grant this one-use authority. No caller-selected proof or model. */
export async function authorizeRequalification(input, { store, cwd, inspectBinding, noopAuditOptions } = {}) {
  if (typeof input?.contextId !== "string" || !input.contextId || typeof input.routeId !== "string" || !input.routeId
    || (input.apply !== undefined && typeof input.apply !== "boolean")
    || (input.expectedEvidenceDigest !== undefined && !digest(input.expectedEvidenceDigest))
    || Object.keys(input).some((field) => !["contextId", "routeId", "apply", "expectedEvidenceDigest"].includes(field))) return denied();
  const context = store.context({ cwd, contextId: input.contextId, create: false });
  const existingRaw = store.db.prepare("SELECT value FROM meta WHERE key=?").get(retryKey(input.routeId))?.value;
  const existing = read(store.db, retryKey(input.routeId));
  if ((existingRaw && !existing) || (existing && existing.contextDigest !== payloadHash(input.contextId))) return denied();
  if (existing?.state === "consumed") return input.apply && input.expectedEvidenceDigest !== existing.evidenceDigest
    ? denied() : { status: "consumed", ordinaryDelegationEnabled: false };
  const qualification = read(store.db, qualificationKey(context));
  if (qualification?.routeId !== input.routeId) return denied();
  const legacyBasis = recoveredBasis(store.db, context, qualification);
  const basisDigest = legacyBasis || completedFailedBasis(store.db, context, qualification);
  if (!basisDigest) return denied();
  let rawAuditDigest = null;
  if (legacyBasis) {
    const { readNativeRecoveryReceipt } = await import("./delegation-recovery.mjs");
    if (!readNativeRecoveryReceipt(store.db, context, input.routeId)) return denied();
  } else {
    try {
      const { auditFailedQualificationNoop } = await import("./lifecycle-qualification.mjs");
      rawAuditDigest = (await auditFailedQualificationNoop(input, { store, cwd, ...noopAuditOptions })).rawAuditDigest;
      if (!digest(rawAuditDigest) || completedFailedBasis(store.db, context, read(store.db, qualificationKey(context))) !== basisDigest) return denied();
    } catch { return denied(); }
  }
  const inspect = inspectBinding || (async () => {
    const { inspectLifecycleHookReadiness } = await import("./hook-readiness.mjs");
    return inspectLifecycleHookReadiness({ cwd, store, context, contextId: input.contextId });
  });
  const binding = fingerprint((await inspect())?.binding);
  if (!binding || binding.taskCwdDigest !== payloadHash(realpathSync(cwd))) return denied();
  const contextDigest = payloadHash(input.contextId);
  const renewal = existing && renewableAuthorization(existing, { routeId: input.routeId, basisDigest, contextDigest, binding });
  const renewedFrom = renewal ? payloadHash(existing) : existing?.renewedFrom;
  const evidenceDigest = authorizationEvidence(contextDigest, basisDigest, binding, rawAuditDigest, renewedFrom);
  if (existing && !renewal) return existing.state === "authorized" && existing.evidenceDigest === evidenceDigest
    && isFresh(existing) && (!input.apply || input.expectedEvidenceDigest === evidenceDigest)
    ? { status: "authorized", evidenceDigest, idempotent: true, ordinaryDelegationEnabled: false } : denied();
  if (!input.apply) return { status: "authorizable", evidenceDigest, ordinaryDelegationEnabled: false };
  if (input.expectedEvidenceDigest !== evidenceDigest
    || payloadHash(fingerprint((await inspect())?.binding)) !== payloadHash(binding)) return denied();
  return store.transaction(() => {
    if (store.db.prepare("SELECT value FROM meta WHERE key=?").get(retryKey(input.routeId))?.value !== existingRaw
      || store.activeDelegationRouteId(context)
      || (legacyBasis ? recoveredBasis : completedFailedBasis)(store.db, context, read(store.db, qualificationKey(context))) !== basisDigest) return denied();
    // An unused grant made stale by expiry or changed source/configuration may
    // be renewed only by this explicit command,
    // after the full source audit above. Preserve it exactly and bind the new
    // approval to that record so its old preview cannot authorize the renewal.
    if (renewal) {
      const archive = `native_requalification_archive:${renewedFrom}`;
      if (!renewableAuthorization(read(store.db, retryKey(input.routeId)), { routeId: input.routeId, basisDigest, contextDigest, binding })
        || read(store.db, archive)) return denied();
      store.db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run(archive, existingRaw);
    }
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.parse(issuedAt) + DURATION_MS).toISOString();
    const authority = { schema: 1, state: "authorized", priorRouteId: input.routeId, contextDigest,
      basisDigest, binding, evidenceDigest, issuedAt, expiresAt,
      ...(rawAuditDigest ? { kind: "completed-failed-noop", rawAuditDigest } : {}),
      ...(renewal ? { renewedFrom } : {}) };
    store.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(retryKey(input.routeId), canonicalJson(authority));
    store.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(diagnosticKey(contextDigest), canonicalJson({ schema: 1, enabled: true, contextDigest,
        authorizationDigest: evidenceDigest, taskCwdDigest: binding.taskCwdDigest, issuedAt, expiresAt }));
    return { status: "authorized", evidenceDigest, expiresAt, idempotent: false, ordinaryDelegationEnabled: false };
  });
}

export function closeQualificationDiagnostics(store, contextId) {
  const key = diagnosticKey(payloadHash(contextId));
  return store.transaction(() => {
    const value = read(store.db, key);
    if (!value) return { status: "absent" };
    store.db.prepare("UPDATE meta SET value=? WHERE key=?").run(canonicalJson({ ...value, enabled: false }), key);
    return { status: "closed", authorizationDigest: value.authorizationDigest };
  });
}
