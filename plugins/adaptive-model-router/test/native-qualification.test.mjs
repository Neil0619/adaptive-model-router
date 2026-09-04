import test from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RouterStore } from "../scripts/lib/database.mjs";
import { routeStage } from "../scripts/lib/router.mjs";
import { consumeDelegationTicket, claimDelegationSubagent, observeAgentResult, observeSubagentStop } from "../scripts/lib/delegation-gate.mjs";
import { callRouterTool } from "../scripts/lib/service.mjs";
import { recordOutcome } from "../scripts/lib/learning.mjs";
import { payloadHash } from "../scripts/lib/io.mjs";
import { observeQualificationHook, readTaskQualification, qualificationReadiness, runtimeSourceDigest } from "../scripts/lib/lifecycle-qualification.mjs";
import { CATALOG, routeInput, temporaryProject, withRouterEnvironment } from "./fixtures.mjs";

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function fixture(run) {
  const project = await temporaryProject("router-qualification-");
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const input = routeInput({ goal: "SECRET_ORIGINAL_WORK: implement an authentication migration" });
      const context = store.context({ cwd: project.root, contextId: input.contextId });
      store.observeHostModel(context, "gpt-5.6-sol");
      const binding = { digest: "a".repeat(64), runtimeDigest: runtimeSourceDigest(),
        taskCwdDigest: payloadHash(realpathSync(project.root)),
        shellRoots: [payloadHash(SOURCE_ROOT)], cliVersion: "0.153.0" };
      const options = { store, cwd: project.root, catalog: CATALOG,
        diskProbe: () => 16n * 1024n ** 3n,
        lifecycleHookProbe: async () => qualificationReadiness(store.db, context, binding) };
      try { await run({ store, project, input, context, options, binding }); }
      finally { store.close(); }
    });
  } finally { await project.cleanup(); }
}

test("first eligible stage issues only a fixed no-tool qualification, without the original work", async () => {
  await fixture(async ({ store, input, context, options }) => {
    const route = await routeStage(input, options);
    assert.equal(route.action, "delegate");
    assert.deepEqual(route.reasonCodes, ["HOST_LIFECYCLE_QUALIFICATION"]);
    assert.deepEqual(route.target, { model: "gpt-5.6-sol", effort: "low" });
    assert.equal(route.verificationGate, "structured-check");
    const toolInput = { task_name: route.carrier.taskName, message: route.carrier.message,
      model: route.target.model, reasoning_effort: route.target.effort, fork_turns: "none" };
    const consumed = store.transaction(() => consumeDelegationTicket(store.db, context, {
      taskName: route.carrier.taskName, turnId: "root-turn", toolUseId: "spawn-call", toolInput,
    }));
    assert.equal(consumed.allowed, true);
    const claim = store.transaction(() => claimDelegationSubagent(store.db, context, {
      taskName: route.carrier.taskName, agentId: "child", model: route.target.model,
    }));
    assert.equal(claim.allowed, true);
    assert.match(claim.contextPackage, /NATIVE_ROUTER_NOOP_[a-f0-9]{24}/u);
    assert.match(claim.contextPackage, /Do not call tools/u);
    assert.equal(claim.contextPackage.includes("SECRET_ORIGINAL_WORK"), false);
    const snapshot = store.db.prepare("SELECT eligible_learning FROM route_score_snapshots WHERE route_id = ?").get(route.routeId);
    assert.equal(snapshot.eligible_learning, 0);
  });
});

test("qualification retains the ordinary one-child gate and never consumes a once override", async () => {
  await fixture(async ({ store, input, context, options }) => {
    store.setOverride(context, { scope: "once", model: "gpt-5.6-terra", effort: "high" });
    const first = await routeStage(input, options);
    assert.equal(first.action, "delegate");
    const second = await routeStage(input, options);
    assert.equal(second.action, "busy");
    assert.equal(second.blockingRouteId, first.routeId);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM delegation_attempts").get().n, 1);
    assert.equal(store.status(context).pendingOutcomes, 1);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM overrides WHERE scope = 'once'").get().n, 1);
  });
});

async function completedQualification(value) {
  const { store, project, input, context, options, binding } = value;
  const route = await routeStage(input, options);
  assert.equal(route.action, "delegate");
  const marker = readTaskQualification(store.db, context).marker;
  const toolInput = { task_name: route.carrier.taskName, message: route.carrier.message,
    model: route.target.model, reasoning_effort: route.target.effort, fork_turns: "none" };
  store.transaction(() => {
    consumeDelegationTicket(store.db, context, { taskName: route.carrier.taskName, turnId: "root-turn", toolUseId: "spawn-call", toolInput });
    claimDelegationSubagent(store.db, context, { taskName: route.carrier.taskName, agentId: "child", model: route.target.model });
    observeAgentResult(store.db, context, { turnId: "root-turn", toolUseId: "spawn-call", toolInput, toolResponse: { agent_id: "child" } });
    observeSubagentStop(store.db, context, route.carrier.taskName, "child", 4096);
    for (const event of ["pre", "post", "start", "stop"]) observeQualificationHook(store.db, context, route.routeId, event, SOURCE_ROOT);
  });
  const agentPath = `/root/${route.carrier.taskName}`;
  const parent = { id: input.contextId, cwd: project.root, turns: [{ id: "root-turn", itemsView: "full", items: [
    { type: "subAgentActivity", kind: "started", id: "spawn-call", agentThreadId: "child", agentPath },
    { type: "subAgentActivity", kind: "completed", id: "subagent-completed-child-turn", agentThreadId: "child", agentPath },
  ] }] };
  const child = { id: "child", parentThreadId: input.contextId, forkedFromId: null, cwd: project.root,
    cliVersion: binding.cliVersion, model: route.target.model, reasoningEffort: route.target.effort, path: "/native/child.jsonl",
    source: { subAgent: { thread_spawn: { parent_thread_id: input.contextId, depth: 1, agent_path: agentPath } } },
    turns: [{ id: "child-turn", status: "completed", error: null, itemsView: "full", items: [
      { type: "agentMessage", id: "final", phase: "final_answer", text: marker },
    ] }] };
  const records = [
    { type: "session_meta", payload: { id: "child", parent_thread_id: input.contextId, cli_version: binding.cliVersion } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "child-turn" } },
    { type: "turn_context", payload: { turn_id: "child-turn", model: route.target.model, effort: route.target.effort } },
    { type: "response_item", payload: { type: "message", id: "final", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: marker }] } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "child-turn" } },
  ];
  const outcome = { routeId: route.routeId, contextId: input.contextId, status: "passed", gate: route.verificationGate,
    failureType: null, retries: 0, retryBreakdown: { reasoning: 0, environment: 0, information: 0, tooling: 0 },
    escalations: 0, userCorrection: false };
  const serviceOptions = { store, cwd: project.root, qualificationOptions: {
    inspectBinding: async () => ({ binding }), readNative: async () => ({ parent, child }),
    auditOptions: { readTranscript: () => Buffer.from(records.map(JSON.stringify).join("\n") + "\n") },
  } };
  return { ...value, route, parent, child, records, outcome, serviceOptions };
}

test("only source-verified qualification unlocks normal routing, idempotently and outside learning", async () => {
  await fixture(async (value) => {
    const { store, context, input, options, outcome, serviceOptions, route } = await completedQualification(value);
    assert.throws(() => recordOutcome(outcome, { store, cwd: value.project.root }), /qualification/u);
    assert.throws(() => recordOutcome(outcome, { store, cwd: value.project.root, qualificationProof: {} }), /qualification/u);
    const result = await callRouterTool("record_outcome", outcome, serviceOptions);
    assert.equal(result.recorded, true);
    assert.equal(result.proposal, null);
    assert.equal(result.safety, null);
    assert.equal(readTaskQualification(store.db, context).state, "passed");
    assert.equal(store.status(context).delegationGate.state, "available");
    assert.equal((await callRouterTool("record_outcome", outcome, serviceOptions)).idempotent, true);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n, 1);
    const next = await routeStage(input, options);
    assert.equal(next.action, "delegate");
    assert.equal(next.reasonCodes.includes("HOST_LIFECYCLE_QUALIFICATION"), false);
    assert.notEqual(next.routeId, route.routeId);
  });
});

test("failed audit never records a passed outcome or permits a replacement qualification", async () => {
  await fixture(async (value) => {
    const { store, context, input, options, records, outcome, serviceOptions } = await completedQualification(value);
    records.splice(-2, 0, { type: "response_item", payload: { type: "custom_tool_call", namespace: "functions", name: "exec", call_id: "hidden" } });
    await assert.rejects(callRouterTool("record_outcome", outcome, serviceOptions), /qualification verification failed/u);
    assert.equal(readTaskQualification(store.db, context).state, "failed");
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n, 0);
    assert.equal((await routeStage(input, options)).action, "busy");
    await callRouterTool("record_outcome", { ...outcome, status: "failed", failureType: "tooling" }, serviceOptions);
    const next = await routeStage(input, options);
    assert.equal(next.action, "continue");
    assert.deepEqual(next.reasonCodes, ["HOST_LIFECYCLE_QUALIFICATION_FAILED"]);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM delegation_attempts").get().n, 1);
  });
});

test("changed qualification bindings invalidate admission without silently re-qualifying", async () => {
  await fixture(async (value) => {
    const { store, context, input, options, binding, outcome, serviceOptions } = await completedQualification(value);
    await callRouterTool("record_outcome", outcome, serviceOptions);
    binding.digest = "d".repeat(64);
    const next = await routeStage(input, options);
    assert.equal(next.action, "continue");
    assert.deepEqual(next.reasonCodes, ["HOST_HOOK_SET_MISMATCH"]);
    assert.equal(readTaskQualification(store.db, context).state, "passed");
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM delegation_attempts").get().n, 1);
  });
});

test("qualification rejects mismatched native invocation, missing Hooks and changed sources", async () => {
  for (const mutate of [
    ({ parent }) => { parent.turns[0].items[0].id = "other-spawn"; },
    ({ parent }) => { parent.turns[0].items.push({ ...parent.turns[0].items[0], id: "duplicate-spawn", agentThreadId: "another-child" }); },
    ({ child }) => { child.cliVersion = "0.154.0"; },
    ({ serviceOptions }) => { serviceOptions.qualificationOptions.inspectBinding = async () => ({ binding: { digest: "d".repeat(64) } }); },
    ({ store, context }) => {
      const row = store.db.prepare("SELECT key, value FROM meta WHERE key LIKE 'native_qualification:%'").get();
      const value = JSON.parse(row.value); delete value.hooks.pre;
      store.db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(JSON.stringify(value), row.key);
    },
  ]) await fixture(async (value) => {
    const completed = await completedQualification(value);
    mutate(completed);
    await assert.rejects(callRouterTool("record_outcome", completed.outcome, completed.serviceOptions), /qualification verification failed/u);
    assert.equal(completed.store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n, 0);
  });
});

test("a missing qualification target remains root-only without issuing a ticket", async () => {
  await fixture(async ({ store, input, options }) => {
    input.hostCapabilities = { delegation: { available: true, invocation: "direct",
      targets: [{ model: "gpt-5.6-terra", efforts: ["high"] }] } };
    const route = await routeStage(input, options);
    assert.equal(route.action, "continue");
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM delegation_attempts").get().n, 0);
  });
});

test("source verification accepts a cache-cwd MCP only for its native bound task directory", async () => {
  await fixture(async (value) => {
    const { outcome, serviceOptions } = await completedQualification(value);
    serviceOptions.cwd = SOURCE_ROOT;
    assert.equal((await callRouterTool("record_outcome", outcome, serviceOptions)).recorded, true);
  });
  await fixture(async (value) => {
    const { parent, child, outcome, serviceOptions } = await completedQualification(value);
    parent.cwd = SOURCE_ROOT;
    child.cwd = SOURCE_ROOT;
    await assert.rejects(callRouterTool("record_outcome", outcome, serviceOptions), /qualification verification failed/u);
  });
});
