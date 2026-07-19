import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { parseControlPrompt } from "../scripts/lib/control.mjs";
import { routeStage } from "../scripts/lib/router.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const dataset = JSON.parse(await readFile(join(root, "routes.json"), "utf8"));
const temporary = await mkdtemp(join(tmpdir(), "adaptive-router-eval-"));
const previousHome = process.env.ADAPTIVE_ROUTER_HOME;
const previousLocal = process.env.ADAPTIVE_ROUTER_LOCAL_ONLY;
process.env.ADAPTIVE_ROUTER_HOME = join(temporary, "state");
process.env.ADAPTIVE_ROUTER_LOCAL_ONLY = "1";

const catalog = [
  { slug: "gpt-5.6-sol", visibility: "list", priority: 1, supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { slug: "gpt-5.6-terra", visibility: "list", priority: 2, supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { slug: "gpt-5.6-luna", visibility: "list", priority: 3, supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"] },
];

function family(model) {
  return model?.endsWith("-sol") ? "sol" : model?.endsWith("-terra") ? "terra" : model?.endsWith("-luna") ? "luna" : null;
}

try {
  let agreements = 0;
  let riskTotal = 0;
  let riskRecalled = 0;
  const mismatches = [];
  for (const item of dataset.routes) {
    const result = await routeStage({
      goal: item.goal,
      phase: item.phase,
      evidence: item.evidence,
      contextId: `eval-${item.id}`,
    }, { catalog, cwd: temporary });
    const matches = result.action === item.action && (!item.family || family(result.target?.model) === item.family);
    if (matches) agreements += 1;
    else mismatches.push({ id: item.id, action: result.action, family: family(result.target?.model) });
    if (item.risk) {
      riskTotal += 1;
      const effort = ["high", "xhigh", "max", "ultra"].includes(result.target?.effort);
      if (result.action === "delegate" && family(result.target?.model) === "sol" && effort) riskRecalled += 1;
    }
  }
  const agreement = agreements / dataset.routes.length;
  const riskRecall = riskTotal === 0 ? 1 : riskRecalled / riskTotal;
  const negativeControlMutations = dataset.controls
    .filter((item) => !item.changesState && parseControlPrompt(item.prompt) !== null).length;
  const positiveControlMisses = dataset.controls
    .filter((item) => item.changesState && parseControlPrompt(item.prompt) === null).length;
  const result = {
    cases: dataset.routes.length,
    routeAgreement: Number(agreement.toFixed(3)),
    riskFloorRecall: Number(riskRecall.toFixed(3)),
    negativeControlMutations,
    positiveControlMisses,
    mismatches,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (riskRecall !== 1 || agreement < 0.85 || negativeControlMutations !== 0 || positiveControlMisses !== 0) process.exitCode = 1;
} finally {
  if (previousHome == null) delete process.env.ADAPTIVE_ROUTER_HOME;
  else process.env.ADAPTIVE_ROUTER_HOME = previousHome;
  if (previousLocal == null) delete process.env.ADAPTIVE_ROUTER_LOCAL_ONLY;
  else process.env.ADAPTIVE_ROUTER_LOCAL_ONLY = previousLocal;
  await rm(temporary, { recursive: true, force: true });
}
