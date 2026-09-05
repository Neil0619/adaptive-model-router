import test from "node:test";
import assert from "node:assert/strict";
import { compileModelPolicy, DEFAULT_MODEL_POLICY, decideWorkLevel, resolveModelTarget } from "../scripts/lib/model-policy.mjs";
import { normalizeCatalog, selectDelegateCatalog } from "../scripts/lib/catalog.mjs";
import { scoreTask } from "../scripts/lib/scorer.mjs";
import { RouterStore } from "../scripts/lib/database.mjs";
import { callRouterTool } from "../scripts/lib/service.mjs";
import { routeStage } from "../scripts/lib/router.mjs";
import { temporaryProject, withRouterEnvironment, routeInput, completeNoChildRoute } from "./fixtures.mjs";

const definition = () => structuredClone(DEFAULT_MODEL_POLICY.definition);
const capabilities = { delegation: { available: true, invocation: "direct", targets: DEFAULT_MODEL_POLICY.definition.allowedModels } };
const catalog = normalizeCatalog(capabilities.delegation.targets.map((entry) => ({ model: entry.model, supportedReasoningEfforts: entry.efforts })));
function demand(evidence = {}, goal = "Bounded task", phase = "work") {
  return decideWorkLevel(scoreTask({ goal, phase, evidence }), evidence);
}
function select(evidence, options = {}) {
  return resolveModelTarget({ catalog, demand: demand(evidence), ...options });
}

test("quality-first rules use facts, default high, and prioritize independent difficulty", () => {
  assert.equal(demand().workLevel, "high");
  assert.equal(demand({}, "A specified task with tests").workLevel, "high");
  const settled = { requirementsSettled: true, strongVerification: true };
  assert.equal(demand(settled).workLevel, "medium");
  assert.equal(demand({ ...settled, mechanical: true, exactOutputCheck: true }).workLevel, "low");
  assert.equal(demand({ ...settled, mechanical: true }).workLevel, "medium");
  for (const field of ["review", "highRisk", "publicContract", "securitySensitive", "migration", "architectureTradeoff", "ambiguous"]) {
    assert.ok(["high", "xhigh", "max"].includes(demand({ ...settled, [field]: true }).workLevel), field);
  }
  assert.equal(demand({ crossCutting: true, ambiguous: true }).workLevel, "xhigh");
  assert.equal(demand({ securitySensitive: true, migration: true }).workLevel, "high");
  assert.equal(demand({ securitySensitive: true, highRisk: true }).workLevel, "xhigh");
  assert.equal(demand({ securitySensitive: true, highFailureCost: true, architectureTradeoff: true }).workLevel, "max");
  assert.equal(demand({ securitySensitive: true, highRisk: true, architectureTradeoff: true }).workLevel, "xhigh");
});

test("five additional allowed candidates, shuffled catalogs, scores and text length do not change selection", () => {
  const candidate = definition();
  for (let n = 0; n < 5; n++) candidate.allowedModels.unshift({ model: `test-next-${n}`, efforts: ["high"] });
  const expanded = normalizeCatalog(candidate.allowedModels.map((entry, priority) => ({ model: entry.model, priority,
    supportedReasoningEfforts: entry.efforts })));
  const policy = compileModelPolicy(candidate);
  for (const values of [expanded, expanded.toReversed()]) {
    const chosen = resolveModelTarget({ policy, catalog: values, demand: demand({}, "Bounded task" + " details".repeat(900)) });
    assert.deepEqual(chosen.target, { model: "gpt-6-astra", effort: "high" });
  }
  const scored = scoreTask({ goal: "Bounded task", evidence: {} });
  assert.deepEqual(decideWorkLevel({ ...scored, score: 0 }, {}), decideWorkLevel({ ...scored, score: 100, policyOffset: 15 }, {}));
});

test("model replacement is configuration-only and validation rejects broken scope and backwards edges", () => {
  const candidate = definition();
  candidate.allowedModels[0].model = "test-next-flagship";
  Object.values(candidate.targets).forEach((target) => { target.model = "test-next-flagship"; });
  const policy = compileModelPolicy(candidate);
  const available = normalizeCatalog([{ model: "test-next-flagship", supportedReasoningEfforts: ["high"] }]);
  assert.equal(resolveModelTarget({ policy, catalog: available, demand: demand() }).target.model, "test-next-flagship");
  candidate.targets.high.model = "outside-scope";
  assert.throws(() => compileModelPolicy(candidate), /outside/);
  const backward = definition(); backward.escalation.next.high = "low";
  assert.throws(() => compileModelPolicy(backward), /forward/);
  const decreasing = definition(); decreasing.targets.high.effort = "max";
  assert.throws(() => compileModelPolicy(decreasing), /decrease effort/);
  const unknown = definition(); unknown.hiddenBypass = true;
  assert.throws(() => compileModelPolicy(unknown), /not allowed/);
});

test("capability intersection never invents efforts, infers delegates from root, or implicitly selects ultra", () => {
  assert.deepEqual(normalizeCatalog([{ model: "gpt-6-astra" }])[0].supportedReasoningEfforts, []);
  assert.deepEqual(selectDelegateCatalog(catalog), []);
  const maxOnly = normalizeCatalog([{ model: "gpt-6-astra", supportedReasoningEfforts: ["max"] }]);
  assert.equal(select({ crossCutting: true, ambiguous: true }, { catalog: maxOnly }).target, null);
  assert.equal(select({}, { override: { model: "gpt-5.6-sol", effort: "high" } }).reason, "MODEL_SCOPE_DENIED");
  assert.equal(select({ highRisk: true }, { override: { effort: "low" } }).reason, "RISK_TARGET_CONFLICT");
  assert.equal(select({}, { override: { effort: "ultra" }, catalog: maxOnly }).reason, "EXPLICIT_TARGET_UNAVAILABLE");
  assert.equal(select({}, { override: { model: "gpt-6-astra" } }).target.effort, "high");
  assert.equal(select({}, { catalog: catalog.map((entry) => ({ ...entry, visibility: "unknown" })) }).target, null);
});

test("route/outcome history binds policy, reasoning escalates twice, and missing previousRouteId cannot reset a stage", async () => {
  const project = await temporaryProject();
  try { await withRouterEnvironment(project, async () => {
    const store = new RouterStore();
    try {
      const input = routeInput({ goal: "Bounded task", phase: "work", stageId: "same-stage", evidence: { workProduct: true }, hostCapabilities: capabilities });
      const first = await routeStage(input, { store, cwd: project.root });
      assert.equal(first.target.effort, "high");
      const busy = await routeStage(input, { store, cwd: project.root });
      assert.equal(busy.action, "busy");
      for (const [prior, expected] of [[first, "xhigh"]]) {
        completeNoChildRoute(prior, { store, cwd: project.root, contextId: input.contextId, status: "failed", failureType: "reasoning" });
        const second = await routeStage({ ...input, goal: "Same task" + " context".repeat(500) }, { store, cwd: project.root });
        assert.equal(second.target.effort, expected);
        assert.equal(second.escalation.count, 1);
        completeNoChildRoute(second, { store, cwd: project.root, contextId: input.contextId, status: "failed", failureType: "reasoning" });
        const third = await routeStage(input, { store, cwd: project.root });
        assert.equal(third.target.effort, "max");
        assert.equal(third.escalation.count, 2);
        completeNoChildRoute(third, { store, cwd: project.root, contextId: input.contextId, status: "failed", failureType: "reasoning" });
        assert.ok((await routeStage(input, { store, cwd: project.root })).reasonCodes.includes("ESCALATION_LIMIT_REACHED"));
      }
      const history = store.routeHistory(store.context({ cwd: project.root, contextId: input.contextId }));
      assert.equal(history.routes.at(-1).decision.policyDigest, DEFAULT_MODEL_POLICY.digest);
      assert.equal(store.db.prepare("SELECT count(*) AS count FROM route_score_snapshots WHERE eligible_learning=1").get().count, 0);
    } finally { store.close(); }
  }); } finally { await project.cleanup(); }
});

test("preview is read-only, activation is compare-and-swap, busy inference blocks and rollback restores", async () => {
  const project = await temporaryProject();
  try { await withRouterEnvironment(project, async () => {
    const store = new RouterStore();
    try {
      const args = { contextId: "policy-admin" };
      const original = await callRouterTool("get_model_policy", args, { store });
      const candidate = definition(); candidate.id = "reviewed-candidate"; candidate.conditions.xhighHardSignals = 3;
      const before = store.db.prepare("SELECT count(*) AS count FROM meta").get().count;
      const preview = await callRouterTool("preview_model_policy", { ...args, definition: candidate }, { store });
      assert.equal(store.db.prepare("SELECT count(*) AS count FROM meta").get().count, before);
      const activate = { ...args, definition: candidate, expectedDigest: original.digest, confirm: "ACTIVATE_MODEL_POLICY" };
      const input = routeInput({ hostCapabilities: capabilities });
      const active = await routeStage(input, { store, cwd: project.root });
      assert.equal((await callRouterTool("activate_model_policy", activate, { store })).reasonCode, "MODEL_POLICY_BUSY");
      completeNoChildRoute(active, { store, cwd: project.root, contextId: input.contextId });
      assert.equal((await callRouterTool("activate_model_policy", activate, { store })).digest, preview.candidateDigest);
      assert.equal((await callRouterTool("activate_model_policy", activate, { store })).reasonCode, "MODEL_POLICY_CONFLICT");
      const restored = await callRouterTool("rollback_model_policy", { ...args, expectedDigest: preview.candidateDigest, confirm: "ROLLBACK_MODEL_POLICY" }, { store });
      assert.equal(restored.digest, original.digest);
    } finally { store.close(); }
  }); } finally { await project.cleanup(); }
});

async function policyFixture(run) {
  const project = await temporaryProject();
  try { await withRouterEnvironment(project, async () => {
    const store = new RouterStore();
    try { await run(store, project); } finally { store.close(); }
  }); } finally { await project.cleanup(); }
}

test("conditions live in the policy and cannot remove safety or verified-downgrade guards", () => {
  const stronger = definition(); stronger.conditions.medium.requires.push("documentation");
  const settled = { requirementsSettled: true, strongVerification: true };
  assert.equal(decideWorkLevel(scoreTask({ goal: "Bounded work", evidence: settled }), settled, compileModelPolicy(stronger)).workLevel, "high");
  for (const mutate of [
    (value) => value.conditions.medium.forbids.splice(0, 1),
    (value) => value.conditions.low.requires.pop(),
    (value) => value.conditions.riskFloorSignals.pop(),
    (value) => value.conditions.maxRequiresAny.push("security"),
  ]) { const value = definition(); mutate(value); assert.throws(() => compileModelPolicy(value)); }
});

test("activation failure is atomic and a read-only policy lookup does not create context rows", async () => {
  await policyFixture(async (store) => {
    const before = store.db.prepare("SELECT count(*) AS n FROM projects").get().n;
    await callRouterTool("get_model_policy", { contextId: "read-only" }, { store });
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM projects").get().n, before);
    const candidate = definition(); candidate.id = "transaction-failure";
    const { activateModelPolicy, readModelPolicy } = await import("../scripts/lib/model-policy-store.mjs");
    const current = readModelPolicy(store.db);
    store.db.exec(`CREATE TEMP TRIGGER reject_policy_activation BEFORE UPDATE ON meta WHEN NEW.key='model_policy:active'
      BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END`);
    assert.throws(() => activateModelPolicy(store, { definition: candidate, expectedDigest: current.digest }), /simulated storage failure/);
    assert.equal(readModelPolicy(store.db).digest, current.digest);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM meta WHERE key=?").get(`model_policy:revision:${compileModelPolicy(candidate).digest}`).n, 0);
  });
});

test("activation cannot race the final route admission or consume its once lock", async () => {
  await policyFixture(async (store, project) => {
    const { activateModelPolicy } = await import("../scripts/lib/model-policy-store.mjs");
    const context = store.context({ cwd: project.root, contextId: "race" });
    store.setOverride(context, { scope: "once", model: "gpt-6-astra", effort: "high" });
    const candidate = definition(); candidate.id = "admission-race";
    const result = await routeStage(routeInput({ contextId: "race" }), { store, cwd: project.root, lifecycleHookProbe: async () => {
      assert.equal(activateModelPolicy(store, { definition: candidate, expectedDigest: DEFAULT_MODEL_POLICY.digest }).activated, true);
      return { ready: true };
    } });
    assert.equal(result.action, "continue"); assert.ok(result.reasonCodes.includes("MODEL_POLICY_CHANGED"));
    assert.equal(store.resolveOverride(context).source, "once");
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM delegation_attempts").get().n, 0);
  });
});

test("auxiliary calls hold the global policy lease and failure releases it", async () => {
  await policyFixture(async (store) => {
    const { withModelPolicyLease, activateModelPolicy, previewModelPolicy } = await import("../scripts/lib/model-policy-store.mjs");
    const candidate = definition(); candidate.id = "inference-lease";
    await assert.rejects(withModelPolicyLease(store, DEFAULT_MODEL_POLICY, async () => {
      assert.equal(activateModelPolicy(store, { definition: candidate, expectedDigest: DEFAULT_MODEL_POLICY.digest }).reasonCode, "MODEL_POLICY_BUSY");
      throw new Error("inference failed");
    }), /inference failed/);
    assert.equal(previewModelPolicy(store.db, candidate).canActivate, true);
    // Missing ownership stays fail closed; merely old timestamps cannot clear inference.
    store.db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run("model_policy:inference:unknown", "{}");
    assert.equal(previewModelPolicy(store.db, candidate).canActivate, false);
  });
});

test("reactivating a past definition rolls back through actual activation order", async () => {
  await policyFixture(async (store) => {
    const { activateModelPolicy, rollbackModelPolicy, modelPolicyStatus } = await import("../scripts/lib/model-policy-store.mjs");
    const original = definition();
    const second = definition(); second.id = "second";
    const third = definition(); third.id = "third";
    let current = DEFAULT_MODEL_POLICY.digest;
    const visited = [current];
    for (const candidate of [second, third, original]) {
      current = activateModelPolicy(store, { definition: candidate, expectedDigest: current }).digest;
      visited.push(current);
    }
    assert.equal(current, DEFAULT_MODEL_POLICY.digest);
    for (const expected of visited.slice(0, -1).toReversed()) {
      assert.equal(modelPolicyStatus(store.db).parentDigest, expected);
      current = rollbackModelPolicy(store, { expectedDigest: current }).digest;
      assert.equal(current, expected);
    }
    assert.equal(rollbackModelPolicy(store, { expectedDigest: current }).reasonCode, "MODEL_POLICY_NO_PREVIOUS");
    assert.equal(rollbackModelPolicy(store, { expectedDigest: compileModelPolicy(third).digest }).reasonCode, "MODEL_POLICY_CONFLICT");
  });
});

test("rollback refuses active calls and rolls its lineage back atomically after a storage failure", async () => {
  await policyFixture(async (store) => {
    const { activateModelPolicy, rollbackModelPolicy, readModelPolicy, modelPolicyStatus, withModelPolicyLease } = await import("../scripts/lib/model-policy-store.mjs");
    const candidate = definition(); candidate.id = "rollback-failure";
    const { digest } = activateModelPolicy(store, { definition: candidate, expectedDigest: DEFAULT_MODEL_POLICY.digest });
    await withModelPolicyLease(store, readModelPolicy(store.db), async () => {
      assert.equal(rollbackModelPolicy(store, { expectedDigest: digest }).reasonCode, "MODEL_POLICY_BUSY");
    });
    const before = modelPolicyStatus(store.db);
    store.db.exec(`CREATE TEMP TRIGGER reject_policy_rollback BEFORE UPDATE ON meta WHEN NEW.key='model_policy:active'
      BEGIN SELECT RAISE(ABORT, 'simulated rollback failure'); END`);
    assert.throws(() => rollbackModelPolicy(store, { expectedDigest: digest }), /simulated rollback failure/);
    assert.deepEqual(modelPolicyStatus(store.db), before);
  });
});

test("legacy out-of-scope locks stay readable, context scoped and unconsumed", async () => {
  await policyFixture(async (store, project) => {
    const context = store.context({ cwd: project.root, contextId: "legacy-lock" });
    store.setOverride(context, { scope: "once", model: "gpt-6-astra", effort: "high" });
    // Import a historical projection; the live setter itself must reject Sol.
    store.db.prepare("UPDATE overrides SET model='gpt-5.6-sol' WHERE scope='once'").run();
    assert.equal(store.status(context).modelPolicy.invalidLocks, 1);
    const other = store.context({ cwd: project.root, contextId: "other-task" });
    assert.equal(store.status(other).modelPolicy.invalidLocks, 0);
    const result = await routeStage(routeInput({ contextId: "legacy-lock" }), { store, cwd: project.root });
    assert.equal(result.action, "ask_user"); assert.ok(result.reasonCodes.includes("MODEL_SCOPE_DENIED"));
    assert.equal(store.resolveOverride(context).source, "once");
  });
});

test("failed and unknown stages preserve their target and policy identity across calls", async () => {
  await policyFixture(async (store, project) => {
    const { activateModelPolicy } = await import("../scripts/lib/model-policy-store.mjs");
    const input = routeInput({ contextId: "stage-policy", stageId: "bounded-work", evidence: {} });
    const first = await routeStage(input, { store, cwd: project.root });
    completeNoChildRoute(first, { store, cwd: project.root, contextId: input.contextId, status: "unknown" });
    const held = await routeStage({ ...input, goal: "Changed text", evidence: { requirementsSettled: true, strongVerification: true } }, { store, cwd: project.root });
    assert.deepEqual(held.target, first.target);
    completeNoChildRoute(held, { store, cwd: project.root, contextId: input.contextId, status: "failed", failureType: "reasoning" });
    const candidate = definition(); candidate.id = "next-policy";
    assert.equal(activateModelPolicy(store, { definition: candidate, expectedDigest: DEFAULT_MODEL_POLICY.digest }).activated, true);
    const denied = await routeStage(input, { store, cwd: project.root });
    assert.equal(denied.action, "ask_user"); assert.ok(denied.reasonCodes.includes("MODEL_STAGE_POLICY_CHANGED"));
  });
});

test("qualification proof checks its actual allowed fallback, retaining exact legacy semantics", async () => {
  await policyFixture(async (store) => {
    const { qualificationTargetMatches } = await import("../scripts/lib/qualification-policy.mjs");
    const target = { model: "gpt-6-astra", effort: "medium" };
    const qualification = { modelPolicy: { digest: DEFAULT_MODEL_POLICY.digest, target } };
    const route = { ...target, decision_json: JSON.stringify({ policyDigest: DEFAULT_MODEL_POLICY.digest }) };
    assert.equal(qualificationTargetMatches(store.db, qualification, route), true);
    assert.equal(qualificationTargetMatches(store.db, qualification, { ...route, effort: "max" }), false);
    assert.equal(qualificationTargetMatches(store.db, null, { model: "gpt-5.6-sol", effort: "low" }), true);
    assert.equal(qualificationTargetMatches(store.db, null, { model: "gpt-5.6-terra", effort: "low" }), false);
  });
});
