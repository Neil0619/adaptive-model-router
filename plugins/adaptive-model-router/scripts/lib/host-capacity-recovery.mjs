import { parseJson, payloadHash } from "./io.mjs";
import { readTaskQualification } from "./lifecycle-qualification.mjs";

export const CAPACITY_RECOVERY_SCHEMA = "native-thread-host-capacity-rejection-recovery/1";
export const CAPACITY_AUDIT_ADAPTER = "codex-0.153.4-parent-agent-limit-rejection-v1";
export const CAPACITY_REJECTION = "collab spawn failed: agent thread limit reached";
export const CAPACITY_REASON = "HOST_AGENT_LIMIT_REACHED";
export const CAPACITY_SOURCE_BYTE_LIMIT = 512 * 1024 * 1024;
export const capacityStateKey = (context) => `host_capacity_rejection:${context.projectId}:${context.contextKey}`;
const nativeTurnKey = (context) => `capacity_native_turn:${context.projectId}:${context.contextKey}`;
const observationKey = (context) => `capacity_native_list:${context.projectId}:${context.contextKey}`;
const recoveredKey = (context) => `capacity_recovered:${context.projectId}:${context.contextKey}`;
const present = (value) => typeof value === "string" && value.length > 0;
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

const getMeta = (db, key) => db.prepare("SELECT value FROM meta WHERE key=?").get(key)?.value;
const setMeta = (db, key, value) => db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);

export function createCapacitySchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS capacity_refusals (
    route_id TEXT PRIMARY KEY REFERENCES routes(route_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL, context_key TEXT NOT NULL, stage_key TEXT, epoch TEXT NOT NULL
  )`);
  const legacy = db.prepare(`SELECT r.*,a.root_turn_id,m.value FROM routes r JOIN delegation_attempts a USING(route_id)
    JOIN meta m ON m.key='native_recovery:'||r.route_id WHERE a.root_turn_id IS NOT NULL`).all();
  for (const row of legacy) {
    const context = { projectId: row.project_id, contextKey: row.context_key };
    if (isHostCapacityRecoveryReceipt(parseJson(row.value, {}) || {}, context, row.route_id)) rememberCapacityRefusal(db, context, row.route_id);
  }
}

export function rememberCapacityRefusal(db, context, routeId) {
  const row = db.prepare("SELECT r.stage_key,a.root_turn_id FROM routes r JOIN delegation_attempts a USING(route_id) WHERE r.route_id=?")
    .get(routeId);
  if (row?.root_turn_id) db.prepare("INSERT OR IGNORE INTO capacity_refusals(route_id,project_id,context_key,stage_key,epoch) VALUES(?,?,?,?,?)")
    .run(routeId, context.projectId, context.contextKey, row.stage_key, payloadHash(row.root_turn_id));
}

export function observeCapacityTurn(db, context, turnId) {
  if (present(turnId)) setMeta(db, nativeTurnKey(context), payloadHash(turnId));
}

export function observeCapacityList(db, context, input) {
  if (!/^(?:collaboration)?list_agents$/u.test(input.tool_name || "") || !present(input.turn_id) || !present(input.tool_use_id)) return false;
  const output = typeof input.tool_response === "string" ? parseJson(input.tool_response, null) : input.tool_response;
  if (!Array.isArray(output?.agents)) return false;
  const rows = output.agents.filter((agent) => typeof agent.agent_name === "string" && agent.agent_name.startsWith("/root/"));
  if (new Set(rows.map((agent) => agent.agent_name)).size !== rows.length) return false;
  const terminal = (status) => status && typeof status === "object" && (Object.hasOwn(status, "completed") || Object.hasOwn(status, "errored"));
  const running = rows.filter((agent) => agent.agent_status === "running" || agent.agent_status === "pending_init").length;
  const unknown = rows.filter((agent) => !terminal(agent.agent_status) && !["running", "pending_init"].includes(agent.agent_status)).length;
  setMeta(db, observationKey(context), JSON.stringify({ epoch: payloadHash(input.turn_id), call: payloadHash(input.tool_use_id),
    running, unknown, observedChildren: rows.length, rejectionRouteId: getMeta(db, capacityStateKey(context)) || null }));
  observeCapacityTurn(db, context, input.turn_id);
  return true;
}

export function invalidateCapacityList(db, context) {
  db.prepare("DELETE FROM meta WHERE key=?").run(observationKey(context));
}

export function capacityWasRecovered(db, context) {
  const rejection = getMeta(db, capacityStateKey(context));
  const recovered = parseJson(getMeta(db, recoveredKey(context)), null);
  return Boolean(rejection && recovered?.rejectionRouteId === rejection && digest(recovered.proofDigest));
}

export function observeCapacitySpawn(db, context, routeId) {
  const attempt = db.prepare("SELECT * FROM delegation_attempts WHERE route_id=? AND project_id=? AND context_key=?")
    .get(routeId, context.projectId, context.contextKey);
  const rejection = getMeta(db, capacityStateKey(context));
  const sequence = db.prepare("SELECT (SELECT rowid FROM routes WHERE route_id=?) > (SELECT rowid FROM routes WHERE route_id=?) AS newer")
    .get(routeId, rejection || "");
  if (rejection && sequence?.newer === 1 && attempt?.post_observed === 1 && attempt.agent_id && !attempt.no_child && !attempt.ambiguous) {
    setMeta(db, recoveredKey(context), JSON.stringify({ rejectionRouteId: rejection, successfulRouteId: routeId,
      proofDigest: payloadHash({ routeId, agent: attempt.agent_id, turn: attempt.root_turn_id, call: attempt.tool_use_id, input: attempt.dispatch_input_digest }) }));
    invalidateCapacityList(db, context);
  }
}

/** Only native observations affect temporary capacity. The history marker is
 * retained, but never serves as a permanent ban on this root's future stages. */
export function capacityAdmissionDecision(db, context, stageKey) {
  if (db.prepare(`SELECT 1 FROM delegation_maintenance m JOIN delegation_children c USING(route_id)
    WHERE c.project_id=? AND c.context_key=? AND m.state='active'`).get(context.projectId, context.contextKey)) {
    return { allowed: false, reasonCode: "CHILD_MAINTENANCE_PENDING" };
  }
  const rejectionId = getMeta(db, capacityStateKey(context));
  if (!rejectionId || capacityWasRecovered(db, context)) return { allowed: true };
  const receipt = parseJson(getMeta(db, `native_recovery:${rejectionId}`), null);
  if (!receipt || !isHostCapacityRecoveryReceipt(receipt, context, rejectionId)) return { allowed: false, reasonCode: "HOST_CAPACITY_EVIDENCE_UNPROVEN" };
  const rejectedAttempt = db.prepare("SELECT root_turn_id FROM delegation_attempts WHERE route_id=?").get(rejectionId);
  const epoch = getMeta(db, nativeTurnKey(context)) || (rejectedAttempt?.root_turn_id ? payloadHash(rejectedAttempt.root_turn_id) : null);
  const refusals = db.prepare("SELECT count(*) AS n FROM capacity_refusals WHERE project_id=? AND context_key=? AND stage_key=? AND epoch=?")
    .get(context.projectId, context.contextKey, stageKey, epoch).n;
  if (refusals >= 2) return { allowed: false, reasonCode: "HOST_CAPACITY_RETRY_EXHAUSTED" };
  const observation = parseJson(getMeta(db, observationKey(context)), null);
  if (!observation || observation.epoch !== epoch || observation.rejectionRouteId !== rejectionId) {
    return { allowed: false, reasonCode: "HOST_CAPACITY_RECHECK_REQUIRED" };
  }
  if (observation.running >= 3) return { allowed: false, reasonCode: "HOST_CAPACITY_TEMPORARY_BUSY" };
  // Unknown residency is not proof of a free slot. With no known conflicting
  // execution, one real, still-needed admission can ask the native allocator.
  return { allowed: true };
}

export function capacityAttemptEligible(attempt) {
  return attempt?.ticket_consumed === 1 && [0, 1].includes(attempt.post_observed)
    && attempt.stop_observed === 0 && attempt.no_child === 0 && !attempt.finalized_at
    && !attempt.agent_id && !attempt.early_agent_id && attempt.early_transcript_bytes == null
    && attempt.transcript_bytes == null && digest(attempt.ticket_hash)
    && present(attempt.root_turn_id) && present(attempt.tool_use_id) && digest(attempt.dispatch_input_digest);
}

export function hostCapacityRecoverySubject(db, context, attempt) {
  if (!capacityAttemptEligible(attempt)) return null;
  const route = db.prepare("SELECT * FROM routes WHERE route_id=? AND project_id=? AND context_key=?")
    .get(attempt.route_id, context.projectId, context.contextKey);
  const qualification = readTaskQualification(db, context);
  const reasons = parseJson(route?.reason_codes_json, null);
  if (route?.action !== "delegate" || route.model !== attempt.model || route.effort !== attempt.effort
    || !Array.isArray(reasons) || reasons.length === 0 || !reasons.every(present)
    || reasons.includes("HOST_LIFECYCLE_QUALIFICATION") || qualification?.state === "invalid"
    || qualification?.routeId === attempt.route_id) return null;
  const outcome = db.prepare("SELECT * FROM outcomes WHERE route_id=?").get(attempt.route_id) || null;
  if (attempt.outcome_recorded === 0) {
    if (outcome || attempt.outcome_status !== null) return null;
  } else if (attempt.outcome_recorded !== 1 || attempt.outcome_status !== "failed"
    || outcome?.status !== "failed" || outcome.failure_type !== "tooling"
    || outcome.project_id !== context.projectId || outcome.context_key !== context.contextKey) return null;
  return { schemaVersion: CAPACITY_RECOVERY_SCHEMA,
    stateDigest: payloadHash({ attempt, route, qualification, outcome }),
    receiptFields: { retainedOutcomeDigest: payloadHash(outcome) } };
}

export function isHostCapacityRecoveryReceipt(receipt, context, routeId) {
  return receipt.schemaVersion === CAPACITY_RECOVERY_SCHEMA
    && receipt.recoveryKind === "host_agent_limit_rejected"
    && receipt.rawAuditAdapter === CAPACITY_AUDIT_ADAPTER && receipt.cliVersion === "0.153.4"
    && receipt.subjectDigest === payloadHash([context.projectId, context.contextKey, routeId])
    && receipt.status === "reconciled_failure" && receipt.failureType === "tooling"
    && receipt.source === "native_thread_read" && receipt.originalHandshakeProven === true
    && receipt.originalDispatchConsumed === true && receipt.transcriptBytes === 0
    && receipt.rejectionCode === CAPACITY_REASON
    && present(receipt.recordedAt) && Number.isFinite(Date.parse(receipt.recordedAt))
    && Number.isSafeInteger(receipt.sourceBytes) && receipt.sourceBytes > 0 && receipt.sourceBytes <= CAPACITY_SOURCE_BYTE_LIMIT
    && ["evidenceDigest", "rawAuditDigest", "sourceDigest", "parentTurnDigest", "launchItemDigest",
      "rejectionItemDigest", "dispatchInputDigest", "retainedOutcomeDigest"].every((key) => digest(receipt[key]));
}
