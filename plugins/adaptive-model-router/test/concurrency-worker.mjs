import { RouterStore } from "../scripts/lib/database.mjs";
import { consumeDelegationTicket, observeAgentResult } from "../scripts/lib/delegation-gate.mjs";
import { approvePolicyProposal, recordOutcome } from "../scripts/lib/learning.mjs";
import { routeStage } from "../scripts/lib/router.mjs";

const operation = process.argv[2];
const cwd = process.argv[3];
const contextId = process.argv[4];
const value = process.argv[5];
import { CATALOG as catalog, HOST_CAPABILITIES } from "./fixtures.mjs";

if (operation === "migrate") {
  const store = new RouterStore();
  const context = store.context({ cwd, contextId });
  const diagnosis = store.diagnose(context);
  store.close();
  process.stdout.write(`${JSON.stringify({ version: diagnosis.databaseVersion, health: diagnosis.databaseHealth })}\n`);
} else if (["route-outcome", "route-outcome-complete"].includes(operation)) {
  const index = Number(value);
  const route = await routeStage({
    goal: `Rename generated fixture group ${index} using the fixed mapping.`,
    phase: "implementation",
    evidence: { workProduct: true, mechanical: true, requirementsSettled: true, batchSize: 50 },
    contextId,
    hostCapabilities: HOST_CAPABILITIES,
  }, { catalog, cwd });
  let outcome = null;
  let dispatch = null;
  if (route.action === "delegate") {
    const status = index < 4 ? "failed" : "passed";
    const store = new RouterStore();
    const context = store.context({ cwd, contextId });
    const toolInput = {
      message: route.carrier.message,
      task_name: route.carrier.taskName,
      model: route.target.model,
      reasoning_effort: route.target.effort,
      fork_turns: "none",
    };
    const turnId = `worker-turn-${index}`;
    const toolUseId = `worker-tool-${index}`;
    store.transaction(() => consumeDelegationTicket(store.db, context, {
      taskName: route.carrier.taskName,
      turnId,
      toolUseId,
      toolInput,
    }));
    if (operation === "route-outcome-complete") {
      store.transaction(() => observeAgentResult(store.db, context, {
        turnId,
        toolUseId,
        toolInput,
        toolResponse: { no_agent_created: true },
      }));
    }
    dispatch = { turnId, toolUseId };
    outcome = recordOutcome({
    routeId: route.routeId,
    contextId,
    status,
    gate: route.verificationGate,
    failureType: status === "failed" ? "reasoning" : null,
    retries: index === 0 ? 1 : 0,
    retryBreakdown: { reasoning: index === 0 ? 1 : 0, environment: 0, information: 0, tooling: 0 },
    escalations: route.escalation.count,
    userCorrection: false,
    }, { store, cwd });
    store.close();
  }
  process.stdout.write(`${JSON.stringify({ route, outcome, dispatch })}\n`);
} else if (operation === "route-only") {
  const route = await routeStage({
    goal: "Implement the specified parser with targeted tests.",
    phase: "implementation",
    evidence: { workProduct: true, requirementsSettled: true, strongVerification: true },
    contextId,
    hostCapabilities: HOST_CAPABILITIES,
  }, { catalog, cwd });
  process.stdout.write(`${JSON.stringify(route)}\n`);
} else if (operation === "approve") {
  const result = approvePolicyProposal({ contextId, proposalId: value }, { cwd });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else if (operation === "stop") {
  const store = new RouterStore();
  const context = store.context({ cwd, contextId });
  const result = store.handleStop(context);
  store.close();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else if (operation === "record-existing") {
  const payload = JSON.parse(value);
  try {
    const result = recordOutcome({
      routeId: payload.routeId,
      contextId,
      status: "passed",
      gate: payload.gate,
      failureType: null,
      retries: 0,
      retryBreakdown: { reasoning: 0, environment: 0, information: 0, tooling: 0 },
      escalations: payload.escalations,
      userCorrection: false,
    }, { cwd });
    process.stdout.write(`${JSON.stringify({ action: "record", result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      action: "record",
      conflict: /conflicting final outcome/u.test(String(error?.message || "")),
    })}\n`);
  }
} else {
  throw new Error("unknown worker operation");
}
