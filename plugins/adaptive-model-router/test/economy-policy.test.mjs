import test from "node:test";
import assert from "node:assert/strict";
import { compileModelPolicy, DEFAULT_MODEL_POLICY, ECONOMY_MODEL_POLICY, decideWorkLevel, resolveModelTarget } from "../scripts/lib/model-policy.mjs";
import { activateModelPolicy, rollbackModelPolicy, readModelPolicy, modelPolicyStatus, previewModelPolicy } from "../scripts/lib/model-policy-store.mjs";
import { normalizeCatalog, selectDelegateCatalog } from "../scripts/lib/catalog.mjs";
import { scoreTask } from "../scripts/lib/scorer.mjs";
import { RouterStore } from "../scripts/lib/database.mjs";
import { routeStage } from "../scripts/lib/router.mjs";
import { callRouterTool } from "../scripts/lib/service.mjs";
import { temporaryProject, withRouterEnvironment, routeInput, completeNoChildRoute } from "./fixtures.mjs";

const policy = ECONOMY_MODEL_POLICY;
const definition = () => structuredClone(policy.definition);
const capabilities = { delegation: { available: true, invocation: "direct", targets: policy.definition.allowedModels } };
// Expected targets are independently stated rather than derived from the policy.
const expected = {
  low: { model: "gpt-6-luna", effort: "low" }, medium: { model: "gpt-6-luna", effort: "medium" },
  high: { model: "gpt-6-sol", effort: "high" }, xhigh: { model: "gpt-6-sol", effort: "xhigh" },
  max: { model: "gpt-6-astra", effort: "high" }, ultra: { model: "gpt-6-astra", effort: "max" },
};
const catalog = normalizeCatalog([
  { model: "gpt-6-luna", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
  { model: "gpt-6-sol", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { model: "gpt-6-astra", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
]);
function demand(evidence = {}) {
  return decideWorkLevel(scoreTask({ goal: "Bounded task", phase: "work", evidence }), evidence, policy);
}
function select(evidence = {}, options = {}) {
  return resolveModelTarget({ policy, catalog, demand: demand(evidence), ...options });
}
async function fixture(run) {
  const project = await temporaryProject();
  try { await withRouterEnvironment(project, async () => {
    const store = new RouterStore();
    try { await run(store, project); } finally { store.close(); }
  }); } finally { await project.cleanup(); }
}
const activate = (store) => activateModelPolicy(store, { definition: definition(), expectedDigest: readModelPolicy(store.db).digest });

test("economy uses the six requested pairs and keeps the legacy definition unchanged", () => {
  assert.equal(DEFAULT_MODEL_POLICY.digest, "eeef1f9773b931b8651fea7c7804a1ed7170da8d14694a16e5aea3e2e67c3a78");
  const settled = { requirementsSettled: true, strongVerification: true };
  for (const [evidence, level] of [[{ ...settled, mechanical: true, exactOutputCheck: true }, "low"],
    [settled, "medium"], [{}, "high"], [{ crossCutting: true, ambiguous: true }, "xhigh"],
    [{ securitySensitive: true, architectureTradeoff: true, highFailureCost: true }, "max"]]) {
    for (const available of [catalog, catalog.toReversed()]) assert.deepEqual(select(evidence, { catalog: available }).target, expected[level]);
  }
  assert.deepEqual(select({}, { override: expected.ultra }).target, expected.ultra);
  for (const effort of ["low", "medium", "xhigh", "ultra"]) assert.equal(select({}, { override: { model: "gpt-6-astra", effort } }).reason, "MODEL_SCOPE_DENIED");
  assert.equal(select({}, { override: { model: "gpt-6-luna", effort: "high" } }).reason, "MODEL_SCOPE_DENIED");
  const legacy = structuredClone(DEFAULT_MODEL_POLICY.definition);
  legacy.targets.max.effort = "high";
  assert.throws(() => compileModelPolicy(legacy), /decrease effort|effort floor/);
});

test("schema2 rejects ambiguous upgrade anchors, model downgrades and weakened risk rules", () => {
  for (const mutate of [
    d => delete d.modelOrder, d => d.modelOrder.reverse(), d => d.modelOrder.push("unknown"),
    d => d.criticalRisk.signals.pop(), d => d.criticalRisk.minimumLevel = "high",
    d => d.criticalRisk.minimumLevel = "ultra", d => d.targets.ultra = d.targets.max,
    d => d.allowedModels[0].efforts.push("high"), d => d.escalation.next.high = "medium",
    d => d.conditions.medium.forbids.splice(0, 1),
  ]) { const d = definition(); mutate(d); assert.throws(() => compileModelPolicy(d)); }
});

test("effort-only overrides resolve permitted bindings and preserve risk and monotonic floors", () => {
  for (const [effort, level] of [["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "xhigh"], ["max", "ultra"]]) {
    for (const available of [catalog, catalog.toReversed()]) {
      assert.deepEqual(select({}, { override: { effort }, catalog: available }).target, expected[level]);
    }
  }
  assert.deepEqual(select({ irreversible: true }, { override: { effort: "high" } }).target, expected.max);
  assert.equal(select({ irreversible: true }, { override: { effort: "medium" } }).reason, "RISK_TARGET_CONFLICT");
  assert.equal(select({}, { override: { effort: "ultra" } }).reason, "MODEL_SCOPE_DENIED");
  const astraOnly = catalog.filter(entry => entry.model === "gpt-6-astra");
  assert.deepEqual(select({}, { override: { effort: "high" }, catalog: astraOnly }).target, expected.max);
  assert.equal(select({}, { override: expected.high, catalog: astraOnly }).reason, "EXPLICIT_TARGET_UNAVAILABLE");
  assert.deepEqual(select({}, { override: { effort: "high" }, previous: expected.high, escalation: true }).target, expected.max);
  assert.equal(select({}, { override: { effort: "high" }, previous: expected.max, escalation: true }).reason, "MONOTONIC_ESCALATION_UNAVAILABLE");
});

test("request and persisted effort locks route correctly without consuming an unavailable once lock", async () => {
  await fixture(async (store, project) => {
    activate(store);
    const input = routeInput({ goal: "Bounded work", phase: "work", evidence: { workProduct: true }, hostCapabilities: capabilities });
    const context = store.context({ cwd: project.root, contextId: input.contextId });
    for (const [effort, level] of [["low", "low"], ["medium", "medium"], ["max", "ultra"]]) {
      for (const kind of ["request", "once"]) {
        if (kind === "once") store.setOverride(context, { scope: "once", effort });
        const result = await routeStage({ ...input, stageId: `${kind}-${effort}`, ...(kind === "request" ? { override: { effort } } : {}) },
          { store, cwd: project.root, catalog });
        assert.equal(result.action, "delegate"); assert.deepEqual(result.target, expected[level]);
        completeNoChildRoute(result, { store, cwd: project.root, contextId: input.contextId });
        assert.equal(store.resolveOverride(context).source, null);
      }
    }
    store.setOverride(context, { scope: "once", effort: "max" });
    const unavailable = structuredClone(capabilities);
    unavailable.delegation.targets = unavailable.delegation.targets.filter(entry => entry.model !== "gpt-6-astra");
    const rejected = await routeStage({ ...input, stageId: "missing-max", hostCapabilities: unavailable }, { store, cwd: project.root, catalog });
    assert.ok(rejected.reasonCodes.includes("EXPLICIT_TARGET_UNAVAILABLE"));
    assert.equal(store.resolveOverride(context).source, "once");
  });
});

test("critical risk selects Astra/high even for otherwise settled tasks and explicit cheaper locks", () => {
  for (const field of ["highFailureCost", "irreversible"]) {
    const evidence = { [field]: true, requirementsSettled: true, strongVerification: true };
    assert.deepEqual(select(evidence).target, expected.max);
    assert.equal(demand(evidence).rule, "CRITICAL_RISK_FLOOR");
    assert.equal(select(evidence, { override: expected.high }).reason, "RISK_TARGET_CONFLICT");
    assert.equal(select(evidence, { catalog: catalog.filter(e => e.model !== "gpt-6-astra") }).target, null);
  }
  assert.deepEqual(select({ review: true }).target, expected.high);
  assert.deepEqual(select({ architectureTradeoff: true }).target, expected.high);
  assert.equal(select({ review: true }, { override: expected.medium }).reason, "RISK_TARGET_CONFLICT");
});

test("capability fallback can reach Astra/high but never spends Astra/max implicitly", () => {
  const astraOnly = catalog.filter(e => e.model === "gpt-6-astra");
  assert.deepEqual(select({}, { catalog: astraOnly }).target, expected.max);
  assert.equal(select({}, { catalog: astraOnly }).reason, "MODEL_CAPABILITY_FALLBACK");
  assert.equal(select({}, { catalog: [{ ...astraOnly[0], supportedReasoningEfforts: ["max", "ultra"] }] }).target, null);
  assert.equal(select({}, { catalog: astraOnly, override: expected.high }).reason, "EXPLICIT_TARGET_UNAVAILABLE");
  assert.equal(select({}, { catalog: selectDelegateCatalog(catalog) }).target, null);
  assert.equal(select({}, { demand: { workLevel: "ultra", minimumLevel: "low" } }).target, null);
  assert.deepEqual(select({}, { demand: { workLevel: "ultra", minimumLevel: "max" }, previous: expected.max, escalation: true }).target, expected.ultra);
  assert.equal(select({}, { demand: { workLevel: "ultra", minimumLevel: "high" }, previous: expected.high, escalation: true }).target, null);
  for (const purpose of ["classifier", "qualification"]) assert.deepEqual(select({}, { purpose }).target, expected.low);
  assert.deepEqual(select({}, { purpose: "smoke" }).target, expected.high);
});

test("delegated route lifecycle reaches Astra within two enhancements and never resets the budget", async () => {
  for (const [startEvidence, chain] of [
    [{ requirementsSettled: true, strongVerification: true, mechanical: true, exactOutputCheck: true, batchSize: 3 }, ["low", "high", "max"]],
    [{ requirementsSettled: true, strongVerification: true }, ["medium", "high", "max"]],
    [{}, ["high", "max", "ultra"]],
    [{ crossCutting: true, ambiguous: true }, ["xhigh", "max", "ultra"]],
  ]) await fixture(async (store, project) => {
    activate(store);
    const input = routeInput({ goal: "Bounded work", phase: "work", stageId: "economy-retry", evidence: { ...startEvidence, workProduct: true }, hostCapabilities: capabilities });
    for (const [index, level] of chain.entries()) {
      const result = await routeStage(input, { store, cwd: project.root, catalog });
      assert.equal(result.action, "delegate"); assert.deepEqual(result.target, expected[level]);
      assert.equal(result.decision.workLevel, level); assert.equal(result.decision.policyVersion, 2);
      assert.equal(result.escalation.count, index);
      completeNoChildRoute(result, { store, cwd: project.root, contextId: input.contextId, status: "failed", failureType: "reasoning" });
    }
    const exhausted = await routeStage(input, { store, cwd: project.root, catalog });
    assert.ok(exhausted.reasonCodes.includes("ESCALATION_LIMIT_REACHED"));
  });
});

test("environment failures hold their target and top-level parallel overrides are guarded", async () => {
  await fixture(async (store, project) => {
    activate(store);
    const input = routeInput({ goal: "Bounded work", phase: "work", stageId: "held-economy", evidence: { workProduct: true }, hostCapabilities: capabilities });
    const first = await routeStage(input, { store, cwd: project.root, catalog });
    completeNoChildRoute(first, { store, cwd: project.root, contextId: input.contextId, status: "failed", failureType: "environment" });
    const held = await routeStage(input, { store, cwd: project.root, catalog });
    assert.deepEqual(held.target, expected.high); assert.equal(held.escalation.count, 0);
    completeNoChildRoute(held, { store, cwd: project.root, contextId: input.contextId });
    const top = await routeStage({ ...input, stageId: "top", override: expected.ultra, evidence: { workProduct: true, parallelWriteRisk: true } }, { store, cwd: project.root, catalog });
    assert.ok(top.reasonCodes.includes("ULTRA_PARALLEL_WRITE_RISK"));
  });
});

test("v2 activation preserves legacy pointers, previews without writes, and rolls back exact history", async () => {
  await fixture(async (store) => {
    const oldDigest = readModelPolicy(store.db).digest;
    const legacyBefore = store.db.prepare("SELECT * FROM meta WHERE key IN ('model_policy:active','model_policy:activation-lineage')").all();
    const before = store.db.prepare("SELECT count(*) n FROM meta").get().n;
    const preview = previewModelPolicy(store.db, definition());
    assert.equal(preview.activationScope, "v2-interpreters");
    assert.equal(store.db.prepare("SELECT count(*) n FROM meta").get().n, before);
    assert.equal(activate(store).digest, policy.digest);
    const reopened = new RouterStore();
    try { assert.equal(readModelPolicy(reopened.db).digest, policy.digest); } finally { reopened.close(); }
    assert.deepEqual(store.db.prepare("SELECT * FROM meta WHERE key IN ('model_policy:active','model_policy:activation-lineage')").all(), legacyBefore);
    assert.equal(readModelPolicy(store.db).digest, policy.digest);
    assert.equal(modelPolicyStatus(store.db).legacyRuntimePolicy.digest, oldDigest);
    // An old interpreter may independently change its own schema1 channel.
    const alternate = structuredClone(DEFAULT_MODEL_POLICY.definition); alternate.id = "legacy-independent";
    const { retainModelPolicy } = await import("../scripts/lib/model-policy-store.mjs");
    const other = compileModelPolicy(alternate); retainModelPolicy(store.db, other, oldDigest);
    store.db.prepare("UPDATE meta SET value=? WHERE key='model_policy:active'").run(other.digest);
    assert.equal(rollbackModelPolicy(store, { expectedDigest: policy.digest }).digest, oldDigest);
    assert.equal(readModelPolicy(store.db).digest, oldDigest, "rollback must not expose independently changed legacy active policy");
    assert.equal(modelPolicyStatus(store.db).legacyRuntimePolicy.digest, other.digest);
    assert.equal(activateModelPolicy(store, { definition: alternate, expectedDigest: oldDigest }).digest, other.digest);
    assert.equal(readModelPolicy(store.db).digest, other.digest);
    assert.equal(rollbackModelPolicy(store, { expectedDigest: other.digest }).digest, oldDigest);
  });
});

test("v2 activation is atomic, CAS-protected and cannot bypass an active delegation", async () => {
  await fixture(async (store, project) => {
    assert.equal(activateModelPolicy(store, { definition: definition(), expectedDigest: "0".repeat(64) }).reasonCode, "MODEL_POLICY_CONFLICT");
    const input = routeInput();
    const first = await routeStage(input, { store, cwd: project.root });
    assert.equal(activate(store).reasonCode, "MODEL_POLICY_BUSY");
    completeNoChildRoute(first, { store, cwd: project.root, contextId: input.contextId });
    store.db.exec("CREATE TEMP TRIGGER reject_v2 BEFORE INSERT ON meta WHEN NEW.key='model_policy:v2:active' BEGIN SELECT RAISE(ABORT,'atomic v2 failure'); END");
    assert.throws(() => activate(store), /atomic v2 failure/);
    assert.equal(readModelPolicy(store.db).digest, DEFAULT_MODEL_POLICY.digest);
    assert.equal(store.db.prepare("SELECT count(*) n FROM meta WHERE key LIKE 'model_policy:v2:%'").get().n, 0);
    assert.equal(store.db.prepare("SELECT count(*) n FROM meta WHERE key=?").get(`model_policy:revision:${policy.digest}`).n, 0);
    store.db.exec("DROP TRIGGER reject_v2");
    const result = await callRouterTool("activate_model_policy", { contextId: "economy-admin", definition: definition(), expectedDigest: DEFAULT_MODEL_POLICY.digest, confirm: "ACTIVATE_MODEL_POLICY" }, { store });
    assert.equal(result.digest, policy.digest);
  });
});
