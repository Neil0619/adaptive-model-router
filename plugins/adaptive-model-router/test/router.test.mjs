import test from "node:test";
import assert from "node:assert/strict";
import { RouterStore } from "../scripts/lib/database.mjs";
import { routeStage } from "../scripts/lib/router.mjs";
import { normalizeCatalog } from "../scripts/lib/catalog.mjs";
import { resolveModelTarget } from "../scripts/lib/model-policy.mjs";
import { desiredRoute, scoreTask } from "../scripts/lib/scorer.mjs";
import { CATALOG, HOST_CAPABILITIES, routeInput, temporaryProject, withRouterEnvironment, completeNoChildRoute } from "./fixtures.mjs";

async function fixture(run) {
  const project = await temporaryProject();
  try { await withRouterEnvironment(project, async () => {
    const store = new RouterStore();
    const options = { store, cwd: project.root, catalog: CATALOG };
    const route = (overrides = {}, extra = {}) => routeStage(JSON.parse(JSON.stringify(routeInput(overrides))), { ...options, ...extra });
    const finish = (value, contextId = "test-context", status = "passed", failureType = null) =>
      completeNoChildRoute(value, { ...options, contextId, status, failureType });
    try { await run({ store, project, route, finish }); } finally { store.close(); }
  }); } finally { await project.cleanup(); }
}

test("legacy score bands retain their historical meaning", () => {
  const base = {
    category: "general",
    hardSignalCount: 0,
    signals: {
      mechanical: false,
      implementation: false,
      review: false,
      risk: false,
      security: false,
      migration: false,
    },
  };
  const cases = [
    [25, 0, "luna", "low"],
    [26, 0, "terra", "low"],
    [45, 0, "terra", "low"],
    [46, 0, "terra", "medium"],
    [60, 0, "terra", "medium"],
    [61, 0, "sol", "medium"],
    [80, 0, "sol", "medium"],
    [81, 0, "sol", "high"],
    [92, 0, "sol", "high"],
    [93, 0, "sol", "xhigh"],
    [97, 0, "sol", "xhigh"],
    [98, 1, "sol", "xhigh"],
    [98, 2, "sol", "max"],
    [100, 2, "sol", "max"],
  ];
  for (const [score, hardSignalCount, family, effort] of cases) {
    const result = desiredRoute({ ...base, score, hardSignalCount });
    assert.deepEqual(
      { family: result.family, effort: result.effort },
      { family, effort },
      `score=${score}, hardSignalCount=${hardSignalCount}`,
    );
  }
});

test("active Grill with Docs and Plan mode each add 18 points and stack without hard signals", () => {
  const base = { goal: "Prepare a work product.", phase: "implementation", evidence: {} };
  const plainMention = scoreTask({
    ...base,
    goal: "Discuss Grill with Docs and Plan mode without activating either workflow.",
  });
  const grill = scoreTask({ ...base, evidence: { grillWithDocs: true } });
  const plan = scoreTask({ ...base, evidence: { planMode: true } });
  const stacked = scoreTask({
    ...base,
    evidence: { grillWithDocs: true, planMode: true },
  });
  const legacy = scoreTask({
    ...base,
    evidence: { grillWithDocs: true, planMode: true },
    profile: { profileVersion: 1 },
  });

  assert.equal(plainMention.score, 40);
  assert.equal(grill.score, 58);
  assert.equal(plan.score, 58);
  assert.equal(stacked.score, 76);
  assert.equal(stacked.hardSignalCount, 0);
  assert.equal(legacy.score, 40);
});


test("workflow scores remain diagnostic and all uninformed work defaults to GPT-6 high", async () => {
  await fixture(async ({ route }) => {
    for (const [index, evidence] of [{}, { grillWithDocs: true }, { grillWithDocs: true, planMode: true }].entries()) {
      const result = await route({ contextId: `workflow-${index}`, evidence });
      assert.deepEqual(result.target, { model: "gpt-6-astra", effort: "high" });
    }
  });
});

test("simple replies and exact single steps stay local, verified batches use low", async () => {
  await fixture(async ({ route }) => {
    const reply = await route({ goal: "Hello!", evidence: {} });
    assert.equal(reply.action, "continue");
    const task = { goal: "Sort these keys", phase: "formatting",
      evidence: { workProduct: true, mechanical: true, exactOutputCheck: true, requirementsSettled: true, strongVerification: true } };
    assert.equal((await route(task)).action, "continue");
    const batch = await route({ ...task, evidence: { ...task.evidence, batchSize: 2 } });
    assert.equal(batch.target.effort, "low");
  });
});

test("override precedence stays request, once, session, project, global", async () => {
  await fixture(async ({ store, project, route, finish }) => {
    const context = store.context({ cwd: project.root, contextId: "test-context" });
    store.configure(context, { allowGlobalOverride: true }, "global");
    for (const [scope, effort] of [["global","low"],["project","medium"],["session","high"],["once","xhigh"]])
      store.setOverride(context, { scope, model: "gpt-6-astra", effort });
    const request = await route({ override: { effort: "max" } });
    assert.equal(request.target.effort, "max"); finish(request);
    for (const [scope, effort] of [["once","xhigh"],["session","high"],["project","medium"],["global","low"]]) {
      const result = await route(); assert.equal(result.target.effort, effort); finish(result);
      if (scope !== "once") store.clearOverrides(context, scope);
    }
  });
});

test("immutable policy targets can be routed without mutating the caller input", async () => {
  await fixture(async ({ store, project }) => {
    const target = resolveModelTarget({ catalog: normalizeCatalog(CATALOG), purpose: "qualification" }).target;
    assert.equal(Object.isFrozen(target), true);
    const input = Object.freeze(routeInput({ override: target }));
    const result = await routeStage(input, { store, cwd: project.root, catalog: CATALOG });
    assert.equal(result.action, "delegate");
    assert.deepEqual(result.target, target);
    assert.equal(input.override, target);
  });
});

test("locks outside scope fail before persistence; unavailable exact effort retains once", async () => {
  await fixture(async ({ store, project, route, finish }) => {
    const context = store.context({ cwd: project.root, contextId: "test-context" });
    assert.throws(() => store.setOverride(context, { scope: "once", model: "gpt-5.6-sol", effort: "high" }), /MODEL_SCOPE_DENIED/);
    store.setOverride(context, { scope: "once", model: "gpt-6-astra", effort: "ultra" });
    const capabilities = structuredClone(HOST_CAPABILITIES); capabilities.delegation.targets[0].efforts = ["high"];
    const denied = await route({ hostCapabilities: capabilities });
    assert.equal(denied.action, "ask_user"); assert.ok(denied.reasonCodes.includes("EXPLICIT_TARGET_UNAVAILABLE"));
    assert.equal(store.resolveOverride(context).source, "once");
    const explicit = await route(); assert.equal(explicit.target.effort, "ultra"); finish(explicit);
    assert.equal(store.resolveOverride(context).source, null);
  });
});

test("actual direct interface capabilities are authoritative and strictly validated", async () => {
  await fixture(async ({ route }) => {
    for (const hostCapabilities of [undefined, { delegation: { available: false, invocation: "unavailable", targets: [] } },
      { delegation: { ...HOST_CAPABILITIES.delegation, invocation: "code_mode_nested" } }]) {
      assert.equal((await route({ hostCapabilities })).action, "continue");
    }
    const explicit = await route({ hostCapabilities: undefined, override: { effort: "high" } });
    assert.equal(explicit.action, "ask_user");
    assert.ok(explicit.reasonCodes.includes("EXPLICIT_TARGET_UNAVAILABLE"));
    const allowed = await route({}, { catalog: [] });
    assert.equal(allowed.target.model, "gpt-6-astra");
    const bad = structuredClone(HOST_CAPABILITIES); bad.delegation.targets[0].efforts.push("high");
    await assert.rejects(route({ contextId: "bad", hostCapabilities: bad }), /duplicate/);
    await assert.rejects(route({ contextId: "bad", category: "mechanical" }), /not allowed/);
  });
});

test("hidden or unrelated root catalog entries cannot invent delegate capabilities", async () => {
  await fixture(async ({ route }) => {
    const unavailable = { delegation: { available: true, invocation: "direct", targets: [{ model: "gpt-5.6-sol", efforts: ["high"] }] } };
    const result = await route({ hostCapabilities: unavailable });
    assert.equal(result.action, "continue"); assert.ok(result.reasonCodes.includes("NO_ALLOWED_TARGET"));
    const denied = await route({ override: { model: "gpt-5.6-sol", effort: "high" } });
    assert.equal(denied.action, "ask_user"); assert.ok(denied.reasonCodes.includes("MODEL_SCOPE_DENIED"));
  });
});

for (const initialEffort of ["low", "medium", "high", "xhigh", "max", "ultra"]) {
  test(`reasoning escalation is bounded and monotonic from ${initialEffort}`, async () => {
    await fixture(async ({ route, finish }) => {
      let previous = await route({ override: { model: "gpt-6-astra", effort: initialEffort } });
      const expected = { low: ["high","xhigh"], medium: ["high","xhigh"], high: ["xhigh","max"],
        xhigh: ["max","ultra"], max: ["ultra"], ultra: [] }[initialEffort];
      for (const [index, effort] of expected.entries()) {
        finish(previous, "test-context", "failed", "reasoning");
        previous = await route({ goal: "Reworded bounded work " + "detail ".repeat(index * 300), evidence: { workProduct: true } });
        assert.equal(previous.target.effort, effort); assert.equal(previous.escalation.count, index + 1);
      }
      finish(previous, "test-context", "failed", "reasoning");
      const stopped = await route(); assert.equal(stopped.action, "ask_user");
      assert.ok(stopped.reasonCodes.some((code) => ["ESCALATION_LIMIT_REACHED","MONOTONIC_ESCALATION_UNAVAILABLE"].includes(code)));
    });
  });
}

for (const failureType of ["environment", "information", "tooling"]) {
  test(`${failureType} failure and description changes do not strengthen a stage`, async () => {
    await fixture(async ({ route, finish }) => {
      const first = await route(); finish(first, "test-context", "failed", failureType);
      const held = await route({ goal: "A longer restatement " + "context ".repeat(400) });
      assert.deepEqual(held.target, first.target); assert.equal(held.escalation.count, 0);
      assert.equal(held.escalation.state, "held");
    });
  });
}

test("a successful stage resets classification and explicit predecessors are context bound", async () => {
  await fixture(async ({ route, finish }) => {
    const first = await route({ evidence: {} }); finish(first);
    const next = await route(); assert.equal(next.target.effort, "medium"); assert.equal(next.escalation.count, 0);
    await assert.rejects(route({ contextId: "another", previousRouteId: first.routeId }), /current project and context/);
  });
});

test("reasoning failure requires recorded evidence; a current manual choice does not spend automatic budget", async () => {
  await fixture(async ({ route, finish }) => {
    const first = await route({ evidence: {} }); finish(first, "test-context", "failed", "reasoning");
    const held = await route({ previousRouteId: first.routeId, override: { effort: "high" },
      evidence: { verificationFailed: true, failureType: "reasoning" } });
    assert.equal(held.target.effort, "high"); assert.equal(held.escalation.count, 0); finish(held);
    await assert.rejects(route({ previousRouteId: held.routeId, evidence: { verificationFailed: true, failureType: "tooling" } }), /matching recorded/);
    await assert.rejects(route({ evidence: { verificationFailed: true, failureType: "reasoning" } }), /previousRouteId/);
  });
});

test("an explicit ultra request is possible after two automatic enhancements without resetting the budget", async () => {
  await fixture(async ({ route, finish }) => {
    let previous = await route({ evidence: {} });
    const originalId = previous.routeId;
    for (const effort of ["xhigh", "max"]) {
      finish(previous, "test-context", "failed", "reasoning");
      previous = await route();
      assert.equal(previous.target.effort, effort);
    }
    finish(previous, "test-context", "failed", "reasoning");
    assert.ok((await route()).reasonCodes.includes("ESCALATION_LIMIT_REACHED"));
    await assert.rejects(route({ previousRouteId: originalId,
      evidence: { verificationFailed: true, failureType: "reasoning" } }), /latest delegated attempt/);
    const explicit = await route({ override: { effort: "ultra" } });
    assert.equal(explicit.target.effort, "ultra");
    assert.equal(explicit.escalation.count, 2);
    finish(explicit, "test-context", "failed", "reasoning");
    assert.ok((await route()).reasonCodes.includes("ESCALATION_LIMIT_REACHED"));
  });
});

test("a persistent lock cannot silently substitute for an automatic enhancement", async () => {
  await fixture(async ({ store, project, route, finish }) => {
    const context = store.context({ cwd: project.root, contextId: "test-context" });
    store.setOverride(context, { scope: "session", model: "gpt-6-astra", effort: "high" });
    const first = await route(); finish(first, "test-context", "failed", "reasoning");
    const blocked = await route();
    assert.equal(blocked.action, "ask_user");
    assert.ok(blocked.reasonCodes.includes("MONOTONIC_ESCALATION_UNAVAILABLE"));
    assert.equal(blocked.escalation.count, 0);
    assert.equal(store.resolveOverride(context).source, "session");
  });
});

test("a current explicit target can replace an unknown-stage target subject to the risk floor", async () => {
  await fixture(async ({ route, finish }) => {
    const first = await route({ override: { effort: "xhigh" } });
    finish(first, "test-context", "unknown");
    const manual = await route({ override: { effort: "medium" } });
    assert.equal(manual.target.effort, "medium");
    assert.equal(manual.escalation.count, 0);
    finish(manual, "test-context", "unknown");
    const unsafe = await route({ override: { effort: "low" }, evidence: { highRisk: true } });
    assert.ok(unsafe.reasonCodes.includes("RISK_TARGET_CONFLICT"));
  });
});

test("risk floors override explicit low effort and ultra rejects overlapping writers", async () => {
  await fixture(async ({ route }) => {
    const unsafe = await route({ override: { effort: "low" }, evidence: { highRisk: true, requirementsSettled: true, strongVerification: true, mechanical: true } });
    assert.equal(unsafe.action, "ask_user"); assert.ok(unsafe.reasonCodes.includes("RISK_TARGET_CONFLICT"));
    const parallel = await route({ override: { effort: "ultra" }, evidence: { parallelWriteRisk: true } });
    assert.equal(parallel.action, "ask_user"); assert.ok(parallel.reasonCodes.includes("ULTRA_PARALLEL_WRITE_RISK"));
  });
});
