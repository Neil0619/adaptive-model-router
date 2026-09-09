import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RouterStore } from "../scripts/lib/database.mjs";
import { routeStage } from "../scripts/lib/router.mjs";
import { consumeDelegationTicket, claimDelegationSubagent, observeAgentResult, observeSubagentStop } from "../scripts/lib/delegation-gate.mjs";
import { callRouterTool } from "../scripts/lib/service.mjs";
import { recordOutcome } from "../scripts/lib/learning.mjs";
import { payloadHash } from "../scripts/lib/io.mjs";
import { lifecycleBinding, observeQualificationHook, provenQualificationShellRoots, readTaskQualification, qualificationReadiness, reserveTaskQualification, runtimeSourceDigest } from "../scripts/lib/lifecycle-qualification.mjs";
import { inspectLifecycleHookReadiness } from "../scripts/lib/hook-readiness.mjs";
import { authorizeRequalification } from "../scripts/lib/qualification-retry.mjs";
import { resolveHookIdentity } from "../scripts/lib/hook-identity.mjs";
import { registerManagedChild, observeManagedMessage } from "../scripts/lib/stage-closure.mjs";
import { CATALOG, routeInput, temporaryProject, withRouterEnvironment } from "./fixtures.mjs";

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("native source identity includes the model policy as well as executable code", async () => {
  const project = await temporaryProject("router-source-policy-");
  try {
    const copied = resolve(project.root, "candidate");
    cpSync(resolve(SOURCE_ROOT, "scripts"), resolve(copied, "scripts"), { recursive: true });
    const source = readFileSync(resolve(SOURCE_ROOT, "model-policy.json"), "utf8");
    writeFileSync(resolve(copied, "model-policy.json"), source);
    assert.equal(runtimeSourceDigest(copied), runtimeSourceDigest());
    const changed = JSON.parse(source); changed.id = "changed-bindings-candidate";
    writeFileSync(resolve(copied, "model-policy.json"), JSON.stringify(changed));
    assert.notEqual(runtimeSourceDigest(copied), runtimeSourceDigest());
  } finally { await project.cleanup(); }
});

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
    assert.deepEqual(route.target, { model: "gpt-6-astra", effort: "low" });
    assert.equal(route.verificationGate, "structured-check");
    for (const field of ["task_name", "message", "fork_turns", "model", "reasoning_effort"]) {
      assert.match(route.carrier.instruction, new RegExp(`\\b${field}\\b`));
    }
    assert.match(route.carrier.instruction, /target\.model.*model/);
    assert.match(route.carrier.instruction, /target\.effort.*reasoning_effort/);
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
    store.setOverride(context, { scope: "once", model: "gpt-6-astra", effort: "high" });
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

async function completedQualification(value, admitted = null) {
  const { store, project, input, context, options, binding } = value;
  const route = admitted || await routeStage(input, options);
  assert.equal(route.action, "delegate");
  const turnId = `root-turn-${route.routeId}`, toolUseId = `spawn-call-${route.routeId}`;
  const childId = `child-${route.routeId}`;
  const marker = readTaskQualification(store.db, context).marker;
  const toolInput = { task_name: route.carrier.taskName, message: route.carrier.message,
    model: route.target.model, reasoning_effort: route.target.effort, fork_turns: "none" };
  if (!value.omitHookDispatch) store.transaction(() => {
    consumeDelegationTicket(store.db, context, { taskName: route.carrier.taskName, turnId, toolUseId, toolInput });
    const claim = claimDelegationSubagent(store.db, context, { taskName: route.carrier.taskName, agentId: childId, model: route.target.model });
    assert.equal(claim.allowed, true);
    assert.match(claim.contextPackage, /Do not call tools/u);
    assert.equal(claim.contextPackage.includes("SECRET_ORIGINAL_WORK"), false);
    observeAgentResult(store.db, context, { turnId, toolUseId, toolInput, toolResponse: { agent_id: childId } });
    if (!value.managedChild) observeSubagentStop(store.db, context, route.carrier.taskName, childId, 4096);
    for (const event of ["pre", "post", "start", "stop"]) observeQualificationHook(store.db, context, route.routeId, event, value.hookShells?.[event] || SOURCE_ROOT);
  });
  const agentPath = `/root/${route.carrier.taskName}`;
  const parent = { id: input.contextId, cwd: project.root, turns: [{ id: turnId, itemsView: "full", items: [
    { type: "subAgentActivity", kind: "started", id: toolUseId, agentThreadId: childId, agentPath },
    { type: "subAgentActivity", kind: "completed", id: "subagent-completed-child-turn", agentThreadId: childId, agentPath },
  ] }] };
  const child = { id: childId, parentThreadId: input.contextId, forkedFromId: null, cwd: project.root,
    cliVersion: binding.cliVersion, model: route.target.model, reasoningEffort: route.target.effort, path: "/native/child.jsonl",
    source: { subAgent: { thread_spawn: { parent_thread_id: input.contextId, depth: 1, agent_path: agentPath } } },
    turns: [{ id: "child-turn", status: "completed", error: null, itemsView: "full", items: [
      { type: "agentMessage", id: "final", phase: "final_answer", text: marker },
    ] }] };
  const records = [
    { type: "session_meta", payload: { id: childId, parent_thread_id: input.contextId, cli_version: binding.cliVersion } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "child-turn" } },
    { type: "turn_context", payload: { turn_id: "child-turn", model: route.target.model, effort: route.target.effort } },
    { type: "response_item", payload: { type: "message", id: "final", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: marker }] } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "child-turn" } },
  ];
  if (value.managedChild) {
    child.path = resolve(project.root, "managed-child.jsonl");
    Object.assign(records[0].payload, { session_id: input.contextId, cwd: project.root, agent_path: agentPath,
      source: { subagent: { thread_spawn: { parent_thread_id: input.contextId, depth: 1, agent_path: agentPath } } } });
    records.splice(1, 0,
      { type: "inter_agent_communication_metadata", payload: { trigger_turn: true } },
      { type: "response_item", payload: { type: "agent_message", id: "activation", author: "/root", recipient: agentPath,
        content: [{ type: "input_text", text: "native qualification activation" }],
        internal_chat_message_metadata_passthrough: { turn_id: "child-turn" } } });
    records.find((row) => row.payload.type === "message").payload.internal_chat_message_metadata_passthrough = { turn_id: "child-turn" };
    writeFileSync(child.path, records.map(JSON.stringify).join("\n") + "\n");
    registerManagedChild(store.db, context, route.routeId, { taskName: route.carrier.taskName, childId,
      parentContextId: input.contextId, agentPath, transcriptPath: child.path });
    observeSubagentStop(store.db, context, route.carrier.taskName, childId, 4096,
      { turnId: "child-turn", lastAssistantMessage: marker });
  }
  const outcome = { routeId: route.routeId, contextId: input.contextId, status: "passed", gate: route.verificationGate,
    failureType: null, retries: 0, retryBreakdown: { reasoning: 0, environment: 0, information: 0, tooling: 0 },
    escalations: 0, userCorrection: false };
  const serviceOptions = { store, cwd: project.root, qualificationOptions: {
    inspectBinding: async () => ({ binding }), readNative: async () => ({ parent, child }),
    auditOptions: { readTranscript: () => Buffer.from(records.map(JSON.stringify).join("\n") + "\n") },
  } };
  return { ...value, route, parent, child, records, outcome, serviceOptions };
}

test("managed qualification verifies current closure before minting and consuming its proof", async () => {
  await fixture(async (value) => {
    value.binding.cliVersion = "0.153.4";
    const f = await completedQualification({ ...value, managedChild: true });
    assert.equal(f.store.status(f.context).stageClosure.state, "ready");
    assert.equal(f.store.db.prepare("SELECT stop_observed FROM delegation_attempts WHERE route_id=?").get(f.route.routeId).stop_observed, 0);
    // Force the outcome transaction to repeat verification on a later clock
    // tick. It must not invalidate the already source-owned proof by rewriting
    // an unchanged attempt timestamp.
    const read = f.serviceOptions.qualificationOptions.readNative;
    f.serviceOptions.qualificationOptions.readNative = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return read(...args);
    };
    assert.equal((await callRouterTool("record_outcome", f.outcome, f.serviceOptions)).recorded, true);
    assert.equal(readTaskQualification(f.store.db, f.context).state, "passed");
    assert.equal(f.store.status(f.context).delegationGate.state, "available");
    assert.equal((await callRouterTool("record_outcome", f.outcome, f.serviceOptions)).idempotent, true);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n, 1);
  });
});

test("a pending managed requirement prevents qualification proof without poisoning its retry state", async () => {
  await fixture(async (value) => {
    value.binding.cliVersion = "0.153.4";
    const f = await completedQualification({ ...value, managedChild: true });
    const accepted = observeManagedMessage(f.store.db, f.context, { tool_name: "followup_task",
      turn_id: "next-root-turn", tool_use_id: "new-input", tool_input: { target: f.parent.turns[0].items[0].agentPath, message: "pending native input" } });
    assert.equal(accepted.allowed, true);
    await assert.rejects(callRouterTool("record_outcome", f.outcome, f.serviceOptions), /Stage closure is pending/);
    assert.equal(readTaskQualification(f.store.db, f.context).state, "pending");
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n, 0);
  });
});

test("new managed input after proof preparation still invalidates outcome admission", async () => {
  await fixture(async (value) => {
    value.binding.cliVersion = "0.153.4";
    const f = await completedQualification({ ...value, managedChild: true });
    const before = f.serviceOptions.qualificationOptions.inspectBinding;
    let reads = 0;
    f.serviceOptions.qualificationOptions.inspectBinding = async () => {
      if (++reads === 2) observeManagedMessage(f.store.db, f.context, { tool_name: "followup_task",
        turn_id: "next-root-turn", tool_use_id: "racing-input", tool_input: { target: f.parent.turns[0].items[0].agentPath, message: "new native input" } });
      return before();
    };
    await assert.rejects(callRouterTool("record_outcome", f.outcome, f.serviceOptions), /Stage closure is pending/);
    assert.equal(readTaskQualification(f.store.db, f.context).state, "pending");
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n, 0);
  });
});

async function passedQualification(run) {
  await fixture(async (value) => {
    const completed = await completedQualification(value);
    await callRouterTool("record_outcome", completed.outcome, completed.serviceOptions);
    const qualificationKey = `native_qualification:${value.context.projectId}:${value.context.contextKey}`;
    const changeQualification = (change) => {
      const qualification = readTaskQualification(value.store.db, value.context);
      change(qualification);
      value.store.db.prepare("UPDATE meta SET value=? WHERE key=?").run(JSON.stringify(qualification), qualificationKey);
    };
    await run({ ...completed, changeQualification, qualificationKey,
      original: readTaskQualification(value.store.db, value.context) });
  });
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

test("a passed qualification with a changed trusted binding admits only a fresh no-tool proof", async () => {
  await fixture(async (value) => {
    const { store, context, input, options, binding, outcome, serviceOptions } = await completedQualification(value);
    await callRouterTool("record_outcome", outcome, serviceOptions);
    const previous = readTaskQualification(store.db, context);
    binding.digest = "d".repeat(64);
    const next = await routeStage(input, options);
    assert.equal(next.action, "delegate");
    assert.deepEqual(next.reasonCodes, ["HOST_LIFECYCLE_QUALIFICATION"]);
    const pending = readTaskQualification(store.db, context);
    assert.equal(pending.state, "pending");
    assert.notEqual(pending.marker, previous.marker);
    assert.notEqual(pending.ticketHash, previous.ticketHash);
    assert.equal(pending.proof, undefined);
    assert.deepEqual(pending.binding, binding);
    assert.deepEqual(JSON.parse(store.db.prepare("SELECT value FROM meta WHERE key=?")
      .get(`native_qualification_archive:${previous.routeId}`).value), previous);
    assert.equal(qualificationReadiness(store.db, context, binding).ready, false);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM delegation_attempts").get().n, 2);
  });
});

test("refresh requires a complete new proof before ordinary work and preserves the once override", async () => {
  await passedQualification(async (f) => {
    const { store, context, input, options, binding, original } = f;
    assert.equal(qualificationReadiness(store.db, context, binding).ready, true);
    assert.equal(qualificationReadiness(store.db, context, binding).passedRefresh, undefined);
    store.setOverride(context, { scope: "once", model: "gpt-6-astra", effort: "high" });
    binding.digest = "d".repeat(64);
    const refreshed = await completedQualification(f);
    assert.deepEqual(refreshed.route.reasonCodes, ["HOST_LIFECYCLE_QUALIFICATION"]);
    assert.equal(readTaskQualification(store.db, context).state, "pending");
    assert.equal(readTaskQualification(store.db, context).passedRefresh.priorRouteId, original.routeId);
    assert.equal((await callRouterTool("record_outcome", f.outcome, f.serviceOptions)).idempotent, true);
    assert.equal(qualificationReadiness(store.db, context, binding).ready, false);
    assert.equal((await routeStage(input, options)).blockingRouteId, refreshed.route.routeId);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM overrides WHERE scope='once'").get().n, 1);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM delegation_attempts WHERE finalized_at IS NULL").get().n, 1);
    assert.equal((await callRouterTool("record_outcome", refreshed.outcome, refreshed.serviceOptions)).recorded, true);
    assert.equal(qualificationReadiness(store.db, context, binding).ready, true);
    const ordinary = await routeStage(input, options);
    assert.equal(ordinary.action, "delegate");
    assert.equal(ordinary.reasonCodes.includes("HOST_LIFECYCLE_QUALIFICATION"), false);
    assert.deepEqual(ordinary.target, { model: "gpt-6-astra", effort: "high" });
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM overrides WHERE scope='once'").get().n, 0);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM outcomes WHERE status='passed'").get().n, 2);
  });
});

test("failed refresh stays blocked even after further drift and cannot reuse the old success", async () => {
  await passedQualification(async (f) => {
    f.binding.digest = "d".repeat(64);
    const refreshed = await completedQualification(f);
    refreshed.records.splice(-2, 0, { type: "response_item", payload: { type: "custom_tool_call", namespace: "functions", name: "exec" } });
    await assert.rejects(callRouterTool("record_outcome", refreshed.outcome, refreshed.serviceOptions), /qualification verification failed/u);
    assert.equal((await routeStage(f.input, f.options)).action, "busy");
    await callRouterTool("record_outcome", { ...refreshed.outcome, status: "failed", failureType: "tooling" }, refreshed.serviceOptions);
    assert.deepEqual((await routeStage(f.input, f.options)).reasonCodes, ["HOST_LIFECYCLE_QUALIFICATION_FAILED"]);
    f.binding.digest = "e".repeat(64);
    assert.deepEqual((await routeStage(f.input, f.options)).reasonCodes, ["HOST_HOOK_SET_MISMATCH"]);
    assert.equal(readTaskQualification(f.store.db, f.context).state, "failed");
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM delegation_attempts").get().n, 2);
    assert.equal(f.store.db.prepare("SELECT status FROM outcomes WHERE route_id=?").get(f.route.routeId).status, "passed");
    assert.deepEqual(JSON.parse(f.store.db.prepare("SELECT value FROM meta WHERE key=?")
      .get(`native_qualification_archive:${f.route.routeId}`).value), f.original);
  });
});

test("refresh rejects invalid success evidence, mismatched retained policy, and inconsistent terminal attempts", async () => {
  const mutations = [
    (f) => f.changeQualification((q) => { q.state = "pending"; }),
    (f) => f.changeQualification((q) => { q.state = "failed"; }),
    (f) => f.changeQualification((q) => { q.state = "invalid"; }),
    (f) => f.changeQualification((q) => { delete q.proof; }),
    (f) => f.changeQualification((q) => { q.proof.passed = false; }),
    (f) => f.changeQualification((q) => { q.proof.rawAuditDigest = "invalid"; }),
    (f) => f.changeQualification((q) => { q.proof.rawAuditAdapter = "codex-0.153.3-no-work/1"; }),
    (f) => f.changeQualification((q) => { q.proof.sourceBytes = 0; }),
    (f) => f.changeQualification((q) => { q.proof.childDigest = "b".repeat(64); }),
    (f) => f.changeQualification((q) => { q.proof.rootTurnDigest = "b".repeat(64); }),
    (f) => f.changeQualification((q) => { q.proof.toolUseDigest = "b".repeat(64); }),
    (f) => f.changeQualification((q) => { delete q.hooks.pre; }),
    (f) => f.changeQualification((q) => { q.hooks.stop.runtimeDigest = "b".repeat(64); }),
    (f) => f.changeQualification((q) => { q.modelPolicy.digest = "b".repeat(64); }),
    (f) => f.changeQualification((q) => { q.modelPolicy.target.effort = "high"; }),
    (f) => { f.binding.taskCwdDigest = "b".repeat(64); },
    (f) => f.store.db.prepare("DELETE FROM outcomes WHERE route_id=?").run(f.route.routeId),
    (f) => f.store.db.prepare("UPDATE outcomes SET status='unknown' WHERE route_id=?").run(f.route.routeId),
    (f) => f.store.db.prepare("UPDATE outcomes SET gate='review' WHERE route_id=?").run(f.route.routeId),
    (f) => f.store.db.prepare("UPDATE outcomes SET payload_hash=? WHERE route_id=?").run("b".repeat(64), f.route.routeId),
    (f) => f.store.db.prepare("UPDATE outcomes SET context_key='other' WHERE route_id=?").run(f.route.routeId),
    (f) => f.store.db.prepare("UPDATE routes SET context_key='other' WHERE route_id=?").run(f.route.routeId),
    (f) => f.store.db.prepare("UPDATE routes SET reason_codes_json='[]' WHERE route_id=?").run(f.route.routeId),
    (f) => f.store.db.prepare("UPDATE routes SET effort='high' WHERE route_id=?").run(f.route.routeId),
    (f) => f.store.db.prepare("UPDATE delegation_attempts SET ambiguous=1 WHERE route_id=?").run(f.route.routeId),
    (f) => f.store.db.prepare("UPDATE delegation_attempts SET no_child=1, agent_id=NULL WHERE route_id=?").run(f.route.routeId),
    (f) => f.store.db.prepare("UPDATE delegation_attempts SET outcome_recorded=0, outcome_status=NULL WHERE route_id=?").run(f.route.routeId),
    (f) => f.store.db.prepare("UPDATE delegation_attempts SET outcome_status='failed' WHERE route_id=?").run(f.route.routeId),
    (f) => f.store.db.prepare("UPDATE delegation_attempts SET transcript_bytes=0 WHERE route_id=?").run(f.route.routeId),
    (f) => f.store.db.prepare("UPDATE delegation_attempts SET stop_observed=0 WHERE route_id=?").run(f.route.routeId),
    (f) => f.store.db.prepare("UPDATE delegation_attempts SET context_key='other' WHERE route_id=?").run(f.route.routeId),
  ];
  for (const mutate of mutations) await passedQualification(async (f) => {
    f.binding.digest = "d".repeat(64);
    mutate(f);
    const readiness = qualificationReadiness(f.store.db, f.context, f.binding);
    assert.equal(readiness.ready, false);
    assert.equal(readiness.qualificationBinding, undefined);
    assert.equal((await routeStage(f.input, f.options)).action, "continue");
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'native_qualification_archive:%'").get().n, 0);
  });
});

test("retained proof survives terminal-attempt pruning before readiness or during admission", async () => {
  for (const pruneDuringAdmission of [false, true]) await passedQualification(async (f) => {
    f.binding.digest = "d".repeat(64);
    const prune = () => f.store.db.prepare("DELETE FROM delegation_attempts WHERE route_id=? AND finalized_at IS NOT NULL").run(f.route.routeId);
    if (pruneDuringAdmission) {
      const probe = f.options.lifecycleHookProbe;
      f.options.lifecycleHookProbe = async () => { const readiness = await probe(); prune(); return readiness; };
    } else prune();
    const refreshed = await completedQualification(f);
    assert.deepEqual(refreshed.route.reasonCodes, ["HOST_LIFECYCLE_QUALIFICATION"]);
    await callRouterTool("record_outcome", refreshed.outcome, refreshed.serviceOptions);
    assert.equal(qualificationReadiness(f.store.db, f.context, f.binding).ready, true);
    assert.equal((await routeStage(f.input, f.options)).reasonCodes.includes("HOST_LIFECYCLE_QUALIFICATION"), false);
  });
});

test("refresh admission rechecks the exact prior proof, outcome, route, target binding, and archive", async () => {
  const mutations = [
    (f) => f.changeQualification((q) => { q.proof.rawAuditDigest = "b".repeat(64); }),
    (f) => f.changeQualification((q) => { q.completedAt = "2000-01-01T00:00:00Z"; }),
    (f) => f.store.db.prepare("UPDATE outcomes SET recorded_at='2000-01-01T00:00:00Z' WHERE route_id=?").run(f.route.routeId),
    (f) => f.store.db.prepare("UPDATE routes SET created_at='2000-01-01T00:00:00Z' WHERE route_id=?").run(f.route.routeId),
    (f) => f.store.db.prepare("UPDATE delegation_attempts SET ambiguous=1 WHERE route_id=?").run(f.route.routeId),
    (f) => f.store.db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run(`native_qualification_archive:${f.route.routeId}`, "archive conflict"),
    (f) => { f.binding.runtimeDigest = "b".repeat(64); },
  ];
  for (const mutate of mutations) await passedQualification(async (f) => {
    f.binding.digest = "d".repeat(64);
    const probe = f.options.lifecycleHookProbe;
    let before;
    f.options.lifecycleHookProbe = async () => {
      const readiness = await probe();
      assert.ok(readiness.passedRefresh);
      mutate(f);
      before = readTaskQualification(f.store.db, f.context);
      return readiness;
    };
    const routed = await routeStage(f.input, f.options);
    assert.deepEqual(routed.reasonCodes, ["HOST_LIFECYCLE_QUALIFICATION_FAILED"]);
    assert.deepEqual(readTaskQualification(f.store.db, f.context), before);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM delegation_attempts").get().n, 1);
    const archive = f.store.db.prepare("SELECT value FROM meta WHERE key=?").get(`native_qualification_archive:${f.route.routeId}`);
    assert.ok(!archive || archive.value === "archive conflict");
  });
});

test("refresh reservation cannot replay or cross task context", async () => {
  await passedQualification(async (f) => {
    f.binding.digest = "d".repeat(64);
    const commit = f.store.commitRoute.bind(f.store);
    let admission;
    f.store.commitRoute = (context, route, onceId, value) => {
      if (value?.qualification) admission = { qualification: structuredClone(value.qualification), ticket: value.ticket };
      return commit(context, route, onceId, value);
    };
    assert.equal((await routeStage(f.input, f.options)).action, "delegate");
    const before = readTaskQualification(f.store.db, f.context);
    assert.equal(f.store.transaction(() => reserveTaskQualification(f.store.db, f.context, admission.qualification, admission.ticket.ticketHash)), false);
    const other = f.store.context({ cwd: f.project.root, contextId: "other-parent" });
    assert.equal(f.store.transaction(() => reserveTaskQualification(f.store.db, other, admission.qualification, admission.ticket.ticketHash)), false);
    assert.deepEqual(readTaskQualification(f.store.db, f.context), before);
    assert.equal(readTaskQualification(f.store.db, other), null);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'native_qualification_archive:%'").get().n, 1);
  });
});

test("storage rejection and admission rollback retain the old proof and unused override", async () => {
  for (const rollback of [false, true]) await passedQualification(async (f) => {
    f.binding.digest = "d".repeat(64);
    f.store.setOverride(f.context, { scope: "once", model: "gpt-6-astra", effort: "high" });
    if (rollback) f.store.db.exec("CREATE TRIGGER reject_refresh BEFORE INSERT ON delegation_attempts BEGIN SELECT RAISE(ABORT, 'test admission rollback'); END");
    const blocked = await routeStage(f.input, { ...f.options, ...(rollback ? {} : { routerChildByteLimit: 0 }) });
    assert.equal(blocked.action, "continue");
    assert.deepEqual(blocked.reasonCodes, [rollback ? "STORAGE_UNAVAILABLE" : "ROUTER_CHILD_STORAGE_LIMIT"]);
    assert.deepEqual(readTaskQualification(f.store.db, f.context), f.original);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM overrides WHERE scope='once'").get().n, 1);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'native_qualification_archive:%'").get().n, 0);
    if (rollback) f.store.db.exec("DROP TRIGGER reject_refresh");
    assert.deepEqual((await routeStage(f.input, f.options)).reasonCodes, ["HOST_LIFECYCLE_QUALIFICATION"]);
  });
});

test("an ordinary child admitted during refresh inspection keeps exclusive ownership", async () => {
  await passedQualification(async (f) => {
    f.binding.digest = "d".repeat(64);
    const probe = f.options.lifecycleHookProbe;
    let ordinary;
    f.options.lifecycleHookProbe = async () => {
      const readiness = await probe();
      assert.ok(readiness.passedRefresh);
      ordinary = await routeStage(f.input, { ...f.options, lifecycleHookProbe: async () => ({ ready: true }) });
      return readiness;
    };
    const routed = await routeStage(f.input, f.options);
    assert.equal(routed.action, "busy");
    assert.equal(routed.blockingRouteId, ordinary.routeId);
    assert.equal((await routeStage(f.input, f.options)).blockingRouteId, ordinary.routeId);
    assert.equal(qualificationReadiness(f.store.db, f.context, f.binding).qualificationBinding, undefined);
    assert.deepEqual(readTaskQualification(f.store.db, f.context), f.original);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM delegation_attempts WHERE finalized_at IS NULL").get().n, 1);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'native_qualification_archive:%'").get().n, 0);
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

test("hot upgrade retains the separately observed child Hook shell and requires its equivalent definition", async () => {
  await fixture(async (f) => {
    const { recordHookIdentityDiagnostic } = await import("../scripts/lib/hook-diagnostics.mjs");
    const identity = resolveHookIdentity({ hook_event_name: "UserPromptSubmit",
      session_id: f.input.contextId, turn_id: "current-native-turn" });
    recordHookIdentityDiagnostic(identity.audit, "context_emitted", process.env, identity);
    const parentRoot = resolve(realpathSync(f.project.root), "cache", "parent-shell");
    const childRoot = resolve(realpathSync(f.project.root), "cache", "child-shell");
    const configuredRoot = resolve(realpathSync(f.project.root), "cache", "configured-shell");
    for (const root of [parentRoot, childRoot, configuredRoot, resolve(realpathSync(f.project.root), "cache", "unobserved-shell")]) cpSync(SOURCE_ROOT, root, { recursive: true });
    const host = { platform: "darwin", cliVersion: "0.153.0", executableDigest: "a".repeat(64) };
    const inventory = (root) => {
      const document = JSON.parse(readFileSync(resolve(root, "hooks", "hooks.json"), "utf8"));
      return { data: [{ cwd: f.project.root, hooks: Object.entries(document.hooks).flatMap(([event, groups]) => groups.flatMap(group => group.hooks.map(hook => ({
        eventName: event[0].toLowerCase() + event.slice(1), handlerType: "command", command: hook.command,
        matcher: group.matcher ?? null, timeoutSec: hook.timeout, statusMessage: hook.statusMessage,
        async: false, source: "plugin", sourcePath: resolve(root, "hooks", "hooks.json"),
        pluginId: "adaptive-model-router@adaptive-model-router", currentHash: `sha256:${"a".repeat(64)}`, enabled: true, trustStatus: "trusted",
      })))) }] };
    };
    Object.assign(f.binding, lifecycleBinding(inventory(childRoot).data[0].hooks, parentRoot, childRoot, host, f.project.root));
    f.hookShells = { pre: parentRoot, post: parentRoot, start: childRoot, stop: childRoot };
    const original = await completedQualification(f);
    await callRouterTool("record_outcome", original.outcome, original.serviceOptions);
    assert.deepEqual(provenQualificationShellRoots(f.store.db, f.context).sort(), [payloadHash(parentRoot), payloadHash(childRoot)].sort());
    const inspect = () => inspectLifecycleHookReadiness({ cwd: f.project.root, pluginRoot: parentRoot,
      store: f.store, context: f.context, contextId: f.input.contextId,
      appServer: async (run) => run({ start: async () => {}, request: async (method) => method === "thread/turns/list"
        ? { data: [{ id: "current-native-turn" }] } : { thread: { id: f.input.contextId, cwd: f.project.root } }, listHooks: async () => inventory(configuredRoot) }),
      nativeHost: async () => host,
    });
    const readiness = await inspect();
    assert.equal(readiness.reasonCode, "HOST_LIFECYCLE_ROUND_TRIP_UNPROVEN");
    assert.deepEqual(readiness.binding.shellRoots, [parentRoot, childRoot, configuredRoot].map(payloadHash).sort());
    Object.assign(f.binding, readiness.binding);
    const refreshed = await completedQualification(f);
    await callRouterTool("record_outcome", refreshed.outcome, refreshed.serviceOptions);
    assert.equal((await inspect()).ready, true);
    const changed = JSON.parse(readFileSync(resolve(childRoot, "hooks", "hooks.json"), "utf8"));
    changed.hooks.SubagentStart[0].hooks[0].command += " unexpected";
    writeFileSync(resolve(childRoot, "hooks", "hooks.json"), JSON.stringify(changed));
    const rejected = await inspect();
    assert.equal(rejected.ready, false);
    assert.equal(rejected.qualificationBinding, undefined);
  });
});

async function completedFailedNoop(run) {
  await fixture(async (f) => {
    f.binding.cliVersion = "0.153.4";
    f.binding.configurationDigest = "c".repeat(64);
    f.hookShells = { start: f.project.root, stop: f.project.root };
    const completed = await completedQualification(f);
    assert.equal(readTaskQualification(f.store.db, f.context).failure, "HOST_HOOK_SET_MISMATCH");
    await callRouterTool("record_outcome", { ...completed.outcome, status: "failed", failureType: "tooling" }, completed.serviceOptions);
    const failed = readTaskQualification(f.store.db, f.context);
    const authorizationInput = { contextId: f.input.contextId, routeId: completed.route.routeId };
    const authorizationOptions = { store: f.store, cwd: f.project.root, inspectBinding: async () => ({ binding: f.binding }),
      noopAuditOptions: completed.serviceOptions.qualificationOptions };
    await run({ ...completed, failed, authorizationInput, authorizationOptions });
  });
}

test("only explicit native-audited recovery permits one retry of a completed failed no-op", async () => {
  await completedFailedNoop(async (f) => {
    assert.equal((await routeStage(f.input, f.options)).action, "continue");
    f.binding.digest = "d".repeat(64);
    f.binding.shellRoots.push(payloadHash(realpathSync(f.project.root)));
    const preview = await authorizeRequalification(f.authorizationInput, f.authorizationOptions);
    assert.equal(preview.status, "authorizable");
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'native_requalification:%'").get().n, 0);
    assert.equal((await authorizeRequalification({ ...f.authorizationInput, apply: true, expectedEvidenceDigest: "0".repeat(64) }, f.authorizationOptions)).status, "unresolved");
    const approved = await authorizeRequalification({ ...f.authorizationInput, apply: true, expectedEvidenceDigest: preview.evidenceDigest }, f.authorizationOptions);
    assert.equal(approved.status, "authorized");
    assert.equal(approved.ordinaryDelegationEnabled, false);
    assert.deepEqual(readTaskQualification(f.store.db, f.context), f.failed);
    const fresh = await completedQualification(f);
    assert.equal(readTaskQualification(f.store.db, f.context).state, "pending");
    assert.deepEqual(JSON.parse(f.store.db.prepare("SELECT value FROM meta WHERE key=?").get(`native_qualification_archive:${f.route.routeId}`).value), f.failed);
    await callRouterTool("record_outcome", fresh.outcome, fresh.serviceOptions);
    assert.equal(qualificationReadiness(f.store.db, f.context, f.binding).ready, true);
    assert.equal(f.store.db.prepare("SELECT status FROM outcomes WHERE route_id=?").get(f.route.routeId).status, "failed");
    assert.equal((await authorizeRequalification(f.authorizationInput, f.authorizationOptions)).status, "consumed");
    assert.equal((await routeStage(f.input, f.options)).reasonCodes.includes("HOST_LIFECYCLE_QUALIFICATION"), false);
  });
});

test("completed failed recovery rejects hidden work, native mismatch and ambiguous or tampered retained evidence", async () => {
  for (const mutate of [
    (f) => f.records.splice(-1, 0, { type: "response_item", payload: { type: "custom_tool_call", namespace: "functions", name: "exec" } }),
    (f) => { f.parent.turns[0].items[0].id = "wrong-call"; },
    (f) => { f.child.model = "gpt-5.6-sol"; },
    (f) => f.store.db.prepare("UPDATE delegation_attempts SET ambiguous=1 WHERE route_id=?").run(f.route.routeId),
    (f) => f.store.db.prepare("UPDATE outcomes SET payload_hash='tampered' WHERE route_id=?").run(f.route.routeId),
  ]) await completedFailedNoop(async (f) => {
    mutate(f);
    assert.equal((await authorizeRequalification(f.authorizationInput, f.authorizationOptions)).status, "unresolved");
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'native_requalification:%'").get().n, 0);
  });
});

test("an unused authorization made stale by expiry or source changes needs fresh approval and retains its prior record", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-07T00:00:00Z") });
  for (const mode of ["expired", "configuration-changed"]) await completedFailedNoop(async (f) => {
    f.binding.digest = "d".repeat(64);
    f.binding.shellRoots.push(payloadHash(realpathSync(f.project.root)));
    const preview = await authorizeRequalification(f.authorizationInput, f.authorizationOptions);
    await authorizeRequalification({ ...f.authorizationInput, apply: true, expectedEvidenceDigest: preview.evidenceDigest }, f.authorizationOptions);
    const key = `native_requalification:${f.route.routeId}`;
    const original = f.store.db.prepare("SELECT value FROM meta WHERE key=?").get(key).value;
    if (mode === "expired") t.mock.timers.tick(60 * 60 * 1000 + 1);
    else f.binding.configurationDigest = "f".repeat(64);
    assert.equal((await routeStage(f.input, f.options)).action, "continue");
    const renewal = await authorizeRequalification(f.authorizationInput, f.authorizationOptions);
    assert.equal(renewal.status, "authorizable");
    assert.notEqual(renewal.evidenceDigest, preview.evidenceDigest);
    assert.equal(f.store.db.prepare("SELECT value FROM meta WHERE key=?").get(key).value, original);
    assert.equal((await authorizeRequalification({ ...f.authorizationInput, apply: true, expectedEvidenceDigest: preview.evidenceDigest }, f.authorizationOptions)).status, "unresolved");
    const applied = await authorizeRequalification({ ...f.authorizationInput, apply: true, expectedEvidenceDigest: renewal.evidenceDigest }, f.authorizationOptions);
    assert.equal(applied.status, "authorized");
    const archive = f.store.db.prepare("SELECT value FROM meta WHERE key=?").get(`native_requalification_archive:${payloadHash(JSON.parse(original))}`);
    assert.equal(archive.value, original);
    assert.deepEqual(readTaskQualification(f.store.db, f.context), f.failed);
    const fresh = await completedQualification(f);
    await callRouterTool("record_outcome", fresh.outcome, fresh.serviceOptions);
    assert.equal((await authorizeRequalification(f.authorizationInput, f.authorizationOptions)).status, "consumed");
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM delegation_attempts").get().n, 2);
    assert.equal(f.store.db.prepare("SELECT status FROM outcomes WHERE route_id=?").get(f.route.routeId).status, "failed");
  });
});

test("expired authorization renewal rejects raw evidence changes and concurrent authorization replacement", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-07T00:00:00Z") });
  for (const mode of ["hidden-work", "changed-basis", "race"]) await completedFailedNoop(async (f) => {
    const preview = await authorizeRequalification(f.authorizationInput, f.authorizationOptions);
    await authorizeRequalification({ ...f.authorizationInput, apply: true, expectedEvidenceDigest: preview.evidenceDigest }, f.authorizationOptions);
    t.mock.timers.tick(60 * 60 * 1000 + 1);
    const renewal = await authorizeRequalification(f.authorizationInput, f.authorizationOptions);
    assert.equal(renewal.status, "authorizable");
    if (mode === "hidden-work") f.records.splice(-1, 0, { type: "response_item", payload: { type: "custom_tool_call", namespace: "functions", name: "exec" } });
    if (mode === "changed-basis") f.store.db.prepare("UPDATE outcomes SET payload_hash='changed' WHERE route_id=?").run(f.route.routeId);
    if (mode === "race") {
      let inspections = 0;
      f.authorizationOptions.inspectBinding = async () => {
        if (++inspections === 2) f.store.db.prepare("DELETE FROM meta WHERE key=?").run(`native_requalification:${f.route.routeId}`);
        return { binding: f.binding };
      };
    }
    assert.equal((await authorizeRequalification({ ...f.authorizationInput, apply: true, expectedEvidenceDigest: renewal.evidenceDigest }, f.authorizationOptions)).status, "unresolved");
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'native_requalification_archive:%'").get().n, 0);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM delegation_attempts").get().n, 1);
  });
});

test("native recovery closes an unconsumed qualification across parent and child builds without fabricating outcomes", async () => {
  const { recoverDelegation } = await import("../scripts/lib/delegation-recovery.mjs");
  for (const metadataOnly of [false, true]) await fixture(async (f) => {
    f.binding.cliVersion = "0.153.4";
    f.binding.configurationDigest = "c".repeat(64);
    f.omitHookDispatch = true;
    const old = await completedQualification(f);
    old.parent.cliVersion = "0.153.3";
    if (metadataOnly) old.records.splice(-2, 0,
      { type: "response_item", payload: { type: "custom_tool_call", status: "completed", name: "exec", call_id: "metadata",
        input: 'text(ALL_TOOLS.filter(x=>/context|route|stage|status/.test(x.name)&&/router|adaptive/i.test(x.name+" "+x.description)));\n' } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "metadata", output: [
        { type: "input_text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n" },
        { type: "input_text", text: '[{"name":"mcp__adaptive_model_router__get_route_status","description":"Metadata"}]' },
      ] } });
    const input = { contextId: f.input.contextId, routeId: old.route.routeId };
    const nativeOptions = { store: f.store, cwd: f.project.root,
      readThread: async (id) => structuredClone(id === f.input.contextId ? old.parent : old.child),
      readTranscript: old.serviceOptions.qualificationOptions.auditOptions.readTranscript,
      measureTranscript: () => ({ bytes: 4096, identityDigest: "e".repeat(64) }) };
    const original = readTaskQualification(f.store.db, f.context);
    const preview = await recoverDelegation(input, nativeOptions);
    assert.equal(preview.status, "recoverable");
    const applied = await recoverDelegation({ ...input, apply: true, expectedEvidenceDigest: preview.evidenceDigest }, nativeOptions);
    assert.equal(applied.status, "reconciled_failure");
    assert.equal(applied.receipt.cliVersion, "0.153.4");
    assert.equal(applied.receipt.rawAuditAdapter, metadataOnly ? "codex-0.153.4-tool-metadata-only/1" : "codex-0.153.4-no-work/1");
    assert.deepEqual(readTaskQualification(f.store.db, f.context), original);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n, 0);
    const attempt = f.store.db.prepare("SELECT * FROM delegation_attempts WHERE route_id=?").get(old.route.routeId);
    for (const field of ["ticket_consumed", "post_observed", "stop_observed", "no_child", "outcome_recorded"]) assert.equal(attempt[field], 0);
    assert.equal((await routeStage(f.input, f.options)).action, "continue");
    const authOptions = { store: f.store, cwd: f.project.root, inspectBinding: async () => ({ binding: f.binding }) };
    const authorization = await authorizeRequalification(input, authOptions);
    assert.equal(authorization.status, "authorizable");
    await authorizeRequalification({ ...input, apply: true, expectedEvidenceDigest: authorization.evidenceDigest }, authOptions);
    f.omitHookDispatch = false;
    const fresh = await completedQualification(f);
    await callRouterTool("record_outcome", fresh.outcome, fresh.serviceOptions);
    assert.equal(qualificationReadiness(f.store.db, f.context, f.binding).ready, true);
    assert.deepEqual(JSON.parse(f.store.db.prepare("SELECT value FROM meta WHERE key=?").get(`native_qualification_archive:${old.route.routeId}`).value), original);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outcomes WHERE route_id=?").get(old.route.routeId).n, 0);
  });
});

test("cross-version qualification recovery rejects hidden work, a changed binding and unknown child builds", async () => {
  const { recoverDelegation } = await import("../scripts/lib/delegation-recovery.mjs");
  for (const mode of ["hidden-work", "binding", "unknown-build"]) await fixture(async (f) => {
    f.binding.cliVersion = "0.153.4"; f.omitHookDispatch = true;
    const native = await completedQualification(f);
    native.parent.cliVersion = "0.153.3";
    if (mode === "hidden-work") native.records.splice(-1, 0, { type: "response_item", payload: { type: "custom_tool_call", name: "exec", namespace: "functions" } });
    if (mode === "unknown-build") native.child.cliVersion = native.records[0].payload.cli_version = "0.154.0";
    if (mode === "binding") native.child.cliVersion = native.records[0].payload.cli_version = "0.153.3";
    const result = await recoverDelegation({ contextId: f.input.contextId, routeId: native.route.routeId }, {
      store: f.store, cwd: f.project.root,
      readThread: async (id) => structuredClone(id === f.input.contextId ? native.parent : native.child),
      readTranscript: native.serviceOptions.qualificationOptions.auditOptions.readTranscript,
      measureTranscript: () => ({ bytes: 4096, identityDigest: "e".repeat(64) }),
    });
    assert.equal(result.status, "unresolved");
    assert.equal(f.store.status(f.context).delegationGate.state, "occupied");
  });
});
