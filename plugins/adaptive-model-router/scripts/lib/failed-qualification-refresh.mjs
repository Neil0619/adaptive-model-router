import { canonicalJson, payloadHash } from "./io.mjs";
import { readFailedChildReceipt, verifiedFailedChild } from "./failed-child-takeover.mjs";
import { observedNativeRootTurn } from "./host-capacity-recovery.mjs";

// A provider refusal proves neither success nor a broken Hook contract. After
// exact failed takeover, a later native root turn may attempt one fresh proof.
// Keep the old qualification/outcome immutable; never enable ordinary work
// without a new successful qualification.
export function failedQualificationRefresh(db, context, previous, binding) {
  if (previous?.state !== "failed" || previous.proof !== null || previous.failure
    || previous.binding?.digest !== binding?.digest) return null;
  const routeId = previous.routeId;
  const attempt = db.prepare("SELECT * FROM delegation_attempts WHERE route_id=? AND project_id=? AND context_key=?")
    .get(routeId, context.projectId, context.contextKey);
  const outcome = db.prepare("SELECT * FROM outcomes WHERE route_id=? AND project_id=? AND context_key=?")
    .get(routeId, context.projectId, context.contextKey);
  const route = db.prepare("SELECT * FROM routes WHERE route_id=? AND project_id=? AND context_key=?")
    .get(routeId, context.projectId, context.contextKey);
  const epoch = observedNativeRootTurn(db, context);
  if (!epoch || !attempt?.root_turn_id || epoch === payloadHash(attempt.root_turn_id)
    || !attempt.finalized_at || attempt.outcome_recorded !== 1 || attempt.outcome_status !== "failed"
    || attempt.ticket_consumed !== 1 || attempt.post_observed !== 1 || attempt.ambiguous !== 0
    || attempt.no_child !== 0 || attempt.stop_observed !== 0
    || route?.reason_codes_json !== '["HOST_LIFECYCLE_QUALIFICATION"]'
    || outcome?.status !== "failed" || outcome.failure_type !== "tooling"
    || !verifiedFailedChild(db, routeId)
    || db.prepare("SELECT 1 FROM delegation_attempts WHERE project_id=? AND context_key=? AND finalized_at IS NULL")
      .get(context.projectId, context.contextKey)
    || db.prepare("SELECT 1 FROM meta WHERE key=?").get(`native_qualification_archive:${routeId}`)) return null;
  const receipt = readFailedChildReceipt(db, routeId);
  if (receipt?.terminal.code !== "model_not_found") return null;
  const normalized = { status: outcome.status, gate: outcome.gate, failureType: outcome.failure_type,
    retries: outcome.retries, retryBreakdown: { reasoning: outcome.retry_reasoning, environment: outcome.retry_environment,
      information: outcome.retry_information, tooling: outcome.retry_tooling }, escalations: outcome.escalations,
    userCorrection: outcome.user_correction === 1 };
  if (payloadHash(normalized) !== outcome.payload_hash) return null;
  return { priorRouteId: routeId, epoch, basisDigest: payloadHash({ previous, attempt, outcome, route, receipt }) };
}

export function consumeFailedQualificationRefresh(db, context, previous, next, ticketHash, qualificationKey) {
  const refresh = failedQualificationRefresh(db, context, previous, next.binding);
  if (!refresh || payloadHash(refresh) !== payloadHash(next.failedRefresh)
    || next.requalification || next.passedRefresh || next.state !== "pending" || next.proof !== undefined
    || Object.keys(next.hooks).length !== 0 || next.routeId === previous.routeId || next.marker === previous.marker
    || !/^[a-f0-9]{64}$/u.test(ticketHash) || ticketHash === previous.ticketHash) return false;
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?)")
    .run(`native_qualification_archive:${previous.routeId}`, canonicalJson(previous));
  db.prepare("UPDATE meta SET value=? WHERE key=?").run(canonicalJson({ ...next, ticketHash }), qualificationKey);
  return true;
}
