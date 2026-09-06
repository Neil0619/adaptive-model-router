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

function authorizationBasis(db, context, qualification, binding) {
  // The existing failed-qualification recovery remains restricted to its
  // proven host. An upgrade of a successful qualification is a separate case.
  const recovered = binding?.cliVersion === "0.153.0" ? recoveredBasis(db, context, qualification) : null;
  if (recovered) return { kind: "recovered_failure", digest: recovered };
  const previousFingerprint = fingerprint(qualification?.binding);
  const currentFingerprint = fingerprint(binding);
  if (qualification?.schema !== 1 || qualification.state !== "passed"
    || !digest(qualification.proof?.rawAuditDigest) || !previousFingerprint || !currentFingerprint
    || payloadHash(previousFingerprint) === payloadHash(currentFingerprint)
    || qualification.binding?.taskCwdDigest !== binding.taskCwdDigest) return null;
  const routeId = qualification.routeId;
  const values = [routeId, context.projectId, context.contextKey];
  const attempt = db.prepare("SELECT * FROM delegation_attempts WHERE route_id=? AND project_id=? AND context_key=?").get(...values);
  const outcome = db.prepare("SELECT * FROM outcomes WHERE route_id=? AND project_id=? AND context_key=?").get(...values);
  const route = db.prepare("SELECT * FROM routes WHERE route_id=? AND project_id=? AND context_key=?").get(...values);
  if (!attempt?.finalized_at || attempt.ticket_consumed !== 1 || attempt.post_observed !== 1
    || attempt.stop_observed !== 1 || attempt.outcome_recorded !== 1 || attempt.no_child !== 0
    || attempt.ambiguous !== 0 || !digest(attempt.agent_id)
    || outcome?.status !== "passed" || outcome.gate !== "structured-check"
    || !qualificationTargetMatches(db, qualification, route)
    || route.reason_codes_json !== '["HOST_LIFECYCLE_QUALIFICATION"]') return null;
  return { kind: "verified_upgrade", digest: payloadHash({ qualification, attempt, outcome, route }) };
}

function isFresh(value, now = Date.now()) {
  const issued = Date.parse(value?.issuedAt), expires = Date.parse(value?.expiresAt);
  return Number.isFinite(issued) && Number.isFinite(expires) && issued <= now && now < expires
    && expires - issued === DURATION_MS;
}

export function activeRequalification(db, context, qualification, binding) {
  const authorization = read(db, retryKey(qualification?.routeId));
  const current = fingerprint(binding);
  const basis = authorizationBasis(db, context, qualification, binding);
  const basisDigest = basis?.digest;
  if (!current || authorization?.schema !== 1 || authorization.state !== "authorized" || !isFresh(authorization)
    || !basisDigest || !digest(authorization.contextDigest)
    || authorization.priorRouteId !== qualification.routeId
    || authorization.basisDigest !== basisDigest || (authorization.basisKind || "recovered_failure") !== basis.kind
    || authorization.evidenceDigest !== payloadHash({ contextDigest: authorization.contextDigest, basisDigest, binding: authorization.binding })
    || payloadHash(authorization.binding) !== payloadHash(current)) return null;
  if (basis.kind === "verified_upgrade") return { priorRouteId: qualification.routeId, evidenceDigest: authorization.evidenceDigest };
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
export async function authorizeRequalification(input, { store, cwd, inspectBinding } = {}) {
  if (typeof input?.contextId !== "string" || !input.contextId || typeof input.routeId !== "string" || !input.routeId
    || (input.apply !== undefined && typeof input.apply !== "boolean")
    || (input.expectedEvidenceDigest !== undefined && !digest(input.expectedEvidenceDigest))
    || Object.keys(input).some((field) => !["contextId", "routeId", "apply", "expectedEvidenceDigest"].includes(field))) return denied();
  const context = store.context({ cwd, contextId: input.contextId, create: false });
  const existing = read(store.db, retryKey(input.routeId));
  if (existing && (existing.contextDigest !== payloadHash(input.contextId)
    || (input.apply && input.expectedEvidenceDigest !== existing.evidenceDigest))) return denied();
  if (existing?.state === "consumed") return { status: "consumed", ordinaryDelegationEnabled: false };
  const qualification = read(store.db, qualificationKey(context));
  if (qualification?.routeId !== input.routeId) return denied();
  const inspect = inspectBinding || (async () => {
    const { inspectLifecycleHookReadiness } = await import("./hook-readiness.mjs");
    return inspectLifecycleHookReadiness({ cwd, store, context, contextId: input.contextId });
  });
  const inspectedBinding = (await inspect())?.binding;
  const binding = fingerprint(inspectedBinding);
  if (!binding || binding.taskCwdDigest !== payloadHash(realpathSync(cwd))) return denied();
  const basis = authorizationBasis(store.db, context, qualification, inspectedBinding);
  if (!basis) return denied();
  const basisDigest = basis.digest;
  if (basis.kind === "recovered_failure") {
    const { readNativeRecoveryReceipt } = await import("./delegation-recovery.mjs");
    if (!readNativeRecoveryReceipt(store.db, context, input.routeId)) return denied();
  }
  const contextDigest = payloadHash(input.contextId);
  const evidenceDigest = payloadHash({ contextDigest, basisDigest, binding });
  if (existing) return existing.evidenceDigest === evidenceDigest && isFresh(existing)
    ? { status: "authorized", evidenceDigest, idempotent: true, ordinaryDelegationEnabled: false } : denied();
  if (!input.apply) return { status: "authorizable", evidenceDigest, ordinaryDelegationEnabled: false };
  if (input.expectedEvidenceDigest !== evidenceDigest
    || payloadHash(fingerprint((await inspect())?.binding)) !== payloadHash(binding)) return denied();
  return store.transaction(() => {
    if (read(store.db, retryKey(input.routeId)) || store.activeDelegationRouteId(context)
      || authorizationBasis(store.db, context, read(store.db, qualificationKey(context)), inspectedBinding)?.digest !== basisDigest) return denied();
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.parse(issuedAt) + DURATION_MS).toISOString();
    const authority = { schema: 1, state: "authorized", priorRouteId: input.routeId, contextDigest,
      basisKind: basis.kind, basisDigest, binding, evidenceDigest, issuedAt, expiresAt };
    store.db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run(retryKey(input.routeId), canonicalJson(authority));
    if (basis.kind === "recovered_failure") store.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
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
