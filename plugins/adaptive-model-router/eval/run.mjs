import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { parseControlPrompt } from "../scripts/lib/control.mjs";
import { routeStage } from "../scripts/lib/router.mjs";
import { desiredRoute } from "../scripts/lib/scorer.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const dataset = JSON.parse(await readFile(join(root, "routes.json"), "utf8"));
const temporary = await mkdtemp(join(tmpdir(), "adaptive-router-eval-"));
const previousHome = process.env.ADAPTIVE_ROUTER_HOME;
const previousLocal = process.env.ADAPTIVE_ROUTER_LOCAL_ONLY;
process.env.ADAPTIVE_ROUTER_HOME = join(temporary, "state");
process.env.ADAPTIVE_ROUTER_LOCAL_ONLY = "1";

const catalog = [{ slug: "gpt-6-astra", visibility: "list", supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"] }];
const hostCapabilities = { delegation: { available: true, invocation: "direct",
  targets: [{ model: "gpt-6-astra", efforts: catalog[0].supported_reasoning_levels }] } };
function family(model) { return model === "gpt-6-astra" ? "astra" : null; }
// Historical score-band compatibility is evaluated separately from the new policy.
function expectedScoreBand(score, hardSignalCount) {
  if (score <= 25) return { family: "luna", effort: "low" };
  if (score <= 45) return { family: "terra", effort: "low" };
  if (score <= 60) return { family: "terra", effort: "medium" };
  if (score <= 80) return { family: "sol", effort: "medium" };
  if (score <= 92) return { family: "sol", effort: "high" };
  if (score <= 97 || hardSignalCount < 2) return { family: "sol", effort: "xhigh" };
  return { family: "sol", effort: "max" };
}

try {
  let agreements = 0;
  let riskTotal = 0;
  let riskRecalled = 0;
  const mismatches = [];
  let routeIndex = 0;
  for (const item of dataset.routes) {
    process.env.ADAPTIVE_ROUTER_HOME = join(temporary, `state-${routeIndex}`);
    routeIndex += 1;
    const result = await routeStage({
      goal: item.goal,
      phase: item.phase,
      evidence: item.evidence,
      contextId: `eval-${item.id}`,
      hostCapabilities,
      ...(item.override ? { override: item.override } : {}),
    }, { catalog, cwd: temporary });
    const matches = result.action === item.action && (!item.effort || (family(result.target?.model) === "astra" && result.target?.effort === item.effort));
    if (matches) agreements += 1;
    else mismatches.push({ id: item.id, action: result.action, family: family(result.target?.model), effort: result.target?.effort });
    if (item.risk) {
      riskTotal += 1;
      const effort = ["high", "xhigh", "max", "ultra"].includes(result.target?.effort);
      if (result.action === "delegate" && family(result.target?.model) === "astra" && effort) riskRecalled += 1;
    }
  }
  let scoreBandAgreements = 0;
  const scoreBandCases = [];
  for (let score = 0; score <= 100; score += 1) {
    for (const hardSignalCount of [0, 2]) {
      const expected = expectedScoreBand(score, hardSignalCount);
      const actual = desiredRoute({
        score,
        hardSignalCount,
        category: "general",
        signals: {
          mechanical: false,
          implementation: false,
          review: false,
          risk: false,
          security: false,
          migration: false,
        },
      });
      const matches = actual.family === expected.family && actual.effort === expected.effort;
      if (matches) scoreBandAgreements += 1;
      else mismatches.push({
        id: `score-${score}-hard-${hardSignalCount}`,
        family: actual.family,
        effort: actual.effort,
      });
      scoreBandCases.push({ score, hardSignalCount });
    }
  }
  const totalCases = dataset.routes.length + scoreBandCases.length;
  const agreement = (agreements + scoreBandAgreements) / totalCases;
  const riskRecall = riskTotal === 0 ? 1 : riskRecalled / riskTotal;
  const negativeControlMutations = dataset.controls
    .filter((item) => !item.changesState && parseControlPrompt(item.prompt) !== null).length;
  const positiveControlMisses = dataset.controls
    .filter((item) => item.changesState && parseControlPrompt(item.prompt) === null).length;
  const result = {
    kind: "offline-policy-conformance",
    measuresModelQuality: false,
    cases: totalCases,
    bilingualRouteCases: dataset.routes.length,
    scoreBandCases: scoreBandCases.length,
    routeAgreement: Number(agreement.toFixed(3)),
    riskFloorRecall: Number(riskRecall.toFixed(3)),
    negativeControlMutations,
    positiveControlMisses,
    mismatches,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (riskRecall !== 1 || agreement !== 1 || negativeControlMutations !== 0 || positiveControlMisses !== 0) process.exitCode = 1;
} finally {
  if (previousHome == null) delete process.env.ADAPTIVE_ROUTER_HOME;
  else process.env.ADAPTIVE_ROUTER_HOME = previousHome;
  if (previousLocal == null) delete process.env.ADAPTIVE_ROUTER_LOCAL_ONLY;
  else process.env.ADAPTIVE_ROUTER_LOCAL_ONLY = previousLocal;
  await rm(temporary, { recursive: true, force: true });
}
