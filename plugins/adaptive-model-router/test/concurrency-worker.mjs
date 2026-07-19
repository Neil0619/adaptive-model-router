import { RouterStore } from "../scripts/lib/database.mjs";
import { approvePolicyProposal, recordOutcome } from "../scripts/lib/learning.mjs";
import { routeStage } from "../scripts/lib/router.mjs";

const operation = process.argv[2];
const cwd = process.argv[3];
const contextId = process.argv[4];
const value = process.argv[5];
const catalog = [
  { slug: "gpt-5.6-sol", visibility: "list", priority: 1, supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { slug: "gpt-5.6-terra", visibility: "list", priority: 2, supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { slug: "gpt-5.6-luna", visibility: "list", priority: 3, supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"] },
];

if (operation === "migrate") {
  const store = new RouterStore();
  const context = store.context({ cwd, contextId });
  const diagnosis = store.diagnose(context);
  store.close();
  process.stdout.write(`${JSON.stringify({ version: diagnosis.databaseVersion, health: diagnosis.databaseHealth })}\n`);
} else if (operation === "route-outcome") {
  const index = Number(value);
  const route = await routeStage({
    goal: `Rename generated fixture group ${index} using the fixed mapping.`,
    phase: "implementation",
    evidence: { workProduct: true, mechanical: true, requirementsSettled: true, batchSize: 50 },
    contextId,
  }, { catalog, cwd });
  const status = index < 4 ? "failed" : "passed";
  const outcome = recordOutcome({
    routeId: route.routeId,
    contextId,
    status,
    gate: route.verificationGate,
    failureType: status === "failed" ? "reasoning" : null,
    retries: index === 0 ? 1 : 0,
    escalations: route.escalation.count,
    userCorrection: false,
  }, { cwd });
  process.stdout.write(`${JSON.stringify({ route, outcome })}\n`);
} else if (operation === "approve") {
  const result = approvePolicyProposal({ contextId, proposalId: value }, { cwd });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
  throw new Error("unknown worker operation");
}
