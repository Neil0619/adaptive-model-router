import { qualificationTargetMatches } from "./qualification-policy.mjs";
import { realpathSync } from "node:fs";
import { payloadHash, parseJson } from "./io.mjs";
import { readTaskQualification } from "./lifecycle-qualification.mjs";
import { auditNativeLifecycleTranscript } from "./native-recovery-audit.mjs";
import { readThreadSpawnIdentity } from "./subagent-session.mjs";

export const QUALIFICATION_RECOVERY_SCHEMA = "native-thread-delegation-recovery/3";
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const present = (value) => typeof value === "string" && value.length > 0;

// Operator recovery only. This is not a new qualification attempt or a way to
// admit ordinary work. In particular, a generic consumed attempt is ineligible.
export function failedQualificationRecoverySubject(db, context, attempt, cwd) {
  try {
    if (!attempt || attempt.ticket_consumed !== 1 || attempt.post_observed !== 1
      || attempt.stop_observed !== 0 || attempt.no_child !== 0 || attempt.ambiguous !== 0
      || attempt.outcome_recorded !== 1 || attempt.outcome_status !== "failed"
      || attempt.finalized_at || attempt.agent_id !== null || attempt.early_agent_id !== null
      || attempt.transcript_bytes !== null || attempt.early_transcript_bytes !== null
      || !digest(attempt.ticket_hash) || !digest(attempt.dispatch_input_digest)
      || !present(attempt.root_turn_id) || !present(attempt.tool_use_id)) return null;
    const qualification = readTaskQualification(db, context);
    const route = db.prepare("SELECT * FROM routes WHERE route_id=? AND project_id=? AND context_key=?")
      .get(attempt.route_id, context.projectId, context.contextKey);
    const outcome = db.prepare("SELECT * FROM outcomes WHERE route_id=? AND project_id=? AND context_key=?")
      .get(attempt.route_id, context.projectId, context.contextKey);
    if (qualification?.state !== "failed" || qualification.routeId !== attempt.route_id
      || qualification.proof !== null || qualification.ticketHash !== attempt.ticket_hash
      || !Number.isFinite(Date.parse(qualification.completedAt))
      || qualification.binding.cliVersion !== "0.153.0"
      || qualification.binding.taskCwdDigest !== payloadHash(realpathSync(cwd))
      || Object.keys(qualification.hooks).sort().join(",") !== "post,pre"
      || !["pre", "post"].every((event) => {
        const observation = qualification.hooks[event];
        return observation?.runtimeDigest === qualification.binding.runtimeDigest
          && qualification.binding.shellRoots.includes(observation.shellRoot);
      })
      || route?.action !== "delegate" || !qualificationTargetMatches(db, qualification, route)
      || attempt.model !== route.model || attempt.effort !== route.effort
      || route.verification_gate !== "structured-check"
      || parseJson(route.reason_codes_json, []).join(",") !== "HOST_LIFECYCLE_QUALIFICATION"
      || outcome?.status !== "failed" || outcome.failure_type !== "tooling"
      || outcome.gate !== "structured-check"
      || !["retries", "retry_reasoning", "retry_environment", "retry_information", "retry_tooling",
        "escalations", "user_correction"].every((field) => outcome[field] === 0)) return null;
    return {
      schemaVersion: QUALIFICATION_RECOVERY_SCHEMA, cliVersion: qualification.binding.cliVersion,
      stateDigest: payloadHash({ attempt, qualification, route, outcome }),
      receiptFields: { recoveryKind: "failed_qualification", qualificationState: "failed",
        ordinaryDelegationEnabled: false, originalDispatchConsumed: true,
        qualificationDigest: payloadHash(qualification), retainedOutcomeDigest: payloadHash(outcome),
        dispatchInputDigest: attempt.dispatch_input_digest },
    };
  } catch { return null; }
}

export function auditFailedQualificationTranscript(bytes, child, parentId, cwd) {
  const audit = auditNativeLifecycleTranscript(bytes, child, parentId);
  const firstLine = bytes.toString("utf8").split("\n", 1)[0];
  const identity = readThreadSpawnIdentity({ transcript_path: child.path,
    agent_id: child.id, session_id: parentId, cwd }, { readLine: () => firstLine });
  const meta = JSON.parse(firstLine).payload;
  if (!identity || identity.agentPath !== child.source.subAgent.thread_spawn.agent_path
    || !present(meta.cwd) || realpathSync(meta.cwd) !== realpathSync(cwd)) {
    throw new Error("qualification recovery source identity is unproven");
  }
  return audit;
}
