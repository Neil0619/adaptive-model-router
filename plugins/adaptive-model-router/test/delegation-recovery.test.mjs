import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { RouterStore } from "../scripts/lib/database.mjs";
import { routeStage } from "../scripts/lib/router.mjs";
import { formatRouteHistory, formatRouteStatus } from "../scripts/lib/presentation.mjs";
import { CATALOG, routeInput, temporaryProject, withRouterEnvironment } from "./fixtures.mjs";

const parentId = "recovery-parent";
const childId = "recovery-child";
const digest = (value) => createHash("sha256").update(value).digest("hex");

async function recoveryModule() {
  return import("../scripts/lib/delegation-recovery.mjs");
}

async function withIncident(run) {
  const project = await temporaryProject("router-native-recovery-");
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      try {
        const route = await routeStage(routeInput({ contextId: parentId }), {
          store, cwd: project.root, catalog: CATALOG,
          diskProbe: () => 16n * 1024n * 1024n * 1024n,
        });
        assert.equal(route.action, "delegate");
        const context = store.context({ cwd: project.root, contextId: parentId });
        const agentPath = `/root/${route.carrier.taskName}`;
        const parent = {
          id: parentId, cwd: project.root, cliVersion: "0.153.0-alpha.5",
          turns: [{ id: "root-turn", status: "completed", itemsView: "full", items: [
            { type: "subAgentActivity", id: "launch-call", kind: "started", agentThreadId: childId, agentPath },
            { type: "subAgentActivity", id: "subagent-completed-child-turn", kind: "completed", agentThreadId: childId, agentPath },
          ] }],
        };
        const child = {
          id: childId, parentThreadId: parentId, forkedFromId: null,
          cwd: project.root, cliVersion: parent.cliVersion, model: route.target.model,
          reasoningEffort: route.target.effort, path: "/host-owned/child.jsonl",
          source: { subAgent: { thread_spawn: {
            parent_thread_id: parentId, depth: 1, agent_path: agentPath,
          } } },
          turns: [{ id: "child-turn", status: "completed", error: null, itemsView: "full", items: [
            { type: "reasoning", id: "reason", summary: [] },
            { type: "subAgentActivity", id: "report", kind: "interacted", agentThreadId: parentId, agentPath: "/root" },
            { type: "agentMessage", id: "final", phase: "final_answer", text: "Validation failed; no work was performed." },
          ] }],
        };
        const readThread = async (id) => structuredClone(id === parentId ? parent : child);
        const measureTranscript = () => ({ bytes: 4096, identityDigest: digest("stable-file") });
        const rawRecords = [
          { type: "session_meta", payload: { id: childId, parent_thread_id: parentId, cli_version: parent.cliVersion } },
          { type: "event_msg", payload: { type: "task_started", turn_id: "child-turn" } },
          { type: "turn_context", payload: { turn_id: "child-turn", model: route.target.model, effort: route.target.effort } },
          { type: "response_item", payload: { type: "function_call", name: "send_message", namespace: "collaboration", call_id: "report" } },
          { type: "response_item", payload: { type: "function_call_output", call_id: "report", output: "Message sent." } },
          { type: "response_item", payload: { type: "message", id: "final", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: child.turns[0].items.at(-1).text }] } },
          { type: "event_msg", payload: { type: "task_complete", turn_id: "child-turn" } },
        ];
        const readTranscript = () => Buffer.from(`${rawRecords.map((record) => JSON.stringify(record)).join("\n")}\n`);
        const options = { store, cwd: project.root, readThread, measureTranscript, readTranscript };
        const input = { contextId: parentId, routeId: route.routeId };
        await run({ project, store, route, context, parent, child, rawRecords, options, input });
      } finally {
        store.close();
      }
    });
  } finally {
    await project.cleanup();
  }
}

test("native recovery closes the actual unconsumed-child incident without inventing lifecycle events or outcomes", async () => {
  await withIncident(async ({ store, context, options, input, route }) => {
    const { recoverDelegation } = await recoveryModule();
    const inspected = await recoverDelegation(input, options);
    assert.equal(inspected.status, "recoverable");
    assert.equal(store.status(context).delegationGate.state, "occupied");
    const recovered = await recoverDelegation({ ...input, apply: true, expectedEvidenceDigest: inspected.evidenceDigest }, options);
    assert.equal(recovered.status, "reconciled_failure");
    const attempt = store.db.prepare("SELECT * FROM delegation_attempts WHERE route_id = ?").get(route.routeId);
    for (const field of ["ticket_consumed", "post_observed", "stop_observed", "no_child", "outcome_recorded"]) {
      assert.equal(attempt[field], 0, `${field} must not be fabricated`);
    }
    assert.ok(attempt.finalized_at);
    assert.equal(attempt.ticket_hash, null);
    assert.equal(attempt.context_package, null);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n, 0);
    assert.equal(store.status(context).delegationGate.state, "available");
    assert.equal(store.status(context).pendingOutcomes, 0);
    assert.equal(store.status(context).currentStage.state, "reconciled_failure");
    const history = store.routeHistory(context).routes[0];
    assert.equal(history.outcome, null);
    assert.equal(history.reconciliation.status, "reconciled_failure");
    assert.equal(history.reconciliation.failureType, "tooling");
    assert.match(formatRouteStatus(store.status(context)), /closed by native recovery; no fabricated outcome/u);
    assert.match(formatRouteHistory(store.routeHistory(context), { locale: "zh" }), /未补造委派结果/u);
    const replay = await recoverDelegation({ ...input, apply: true, expectedEvidenceDigest: inspected.evidenceDigest }, options);
    assert.equal(replay.idempotent, true);
    assert.equal(store.db.prepare("SELECT total_transcript_bytes FROM delegation_usage").get().total_transcript_bytes, 4096);
    const receipts = store.db.prepare("SELECT value FROM meta WHERE key LIKE 'native_recovery:%'").all();
    assert.equal(receipts.length, 1);
    const serialized = JSON.stringify(receipts);
    for (const secret of [parentId, childId, route.carrier.taskName, "/host-owned", "Validation failed;"]) {
      assert.equal(serialized.includes(secret), false, `recovery audit leaked ${secret}`);
    }
  });
});

test("native recovery rejects tool calls omitted from the native thread projection", async () => {
  for (const item of [
    { type: "custom_tool_call", name: "exec", namespace: "functions", call_id: "hidden-code" },
    { type: "function_call", name: "exec_command", call_id: "hidden-shell" },
    { type: "future_native_action", id: "unknown-action" },
  ]) await withIncident(async ({ input, options, rawRecords, store, context }) => {
    const { recoverDelegation } = await recoveryModule();
    rawRecords.splice(-2, 0, { type: "response_item", payload: item });
    assert.equal((await recoverDelegation(input, options)).status, "unresolved");
    assert.equal(store.status(context).delegationGate.state, "occupied");
  });
});

test("recovery source audit rejects unknown builds, truncated streams, broken pairs, and changing bytes", async () => {
  const mutations = [
    ({ parent, child, rawRecords }) => {
      parent.cliVersion = child.cliVersion = rawRecords[0].payload.cli_version = "0.154.0";
    },
    ({ rawRecords }) => { rawRecords[0].payload.parent_thread_id = "different-parent"; },
    ({ rawRecords }) => { rawRecords.splice(4, 1); },
    ({ rawRecords }) => { rawRecords.push({ type: "future_host_record", payload: {} }); },
    ({ options }) => {
      const read = options.readTranscript;
      options.readTranscript = () => read().subarray(0, -1);
    },
    ({ options }) => { options.readTranscript = () => Buffer.alloc(2 * 1024 * 1024 + 1); },
    ({ options, rawRecords }) => {
      const read = options.readTranscript;
      let sequence = 0;
      options.readTranscript = () => {
        rawRecords[0].timestamp = ++sequence;
        return read();
      };
    },
  ];
  for (const mutate of mutations) await withIncident(async (fixture) => {
    const { recoverDelegation } = await recoveryModule();
    mutate(fixture);
    assert.equal((await recoverDelegation(fixture.input, fixture.options)).status, "unresolved");
    assert.equal(fixture.store.status(fixture.context).delegationGate.state, "occupied");
  });
});

test("native recovery never accepts an ambiguous, live, mutated, or unbound child", async () => {
  const mutations = [
    ({ parent }) => parent.turns[0].items.pop(),
    ({ parent }) => parent.turns[0].items.push({ ...parent.turns[0].items[0], id: "second-launch" }),
    ({ parent }) => { parent.turns[0].items[1].agentThreadId = "different-child"; },
    ({ child }) => { child.parentThreadId = "different-parent"; },
    ({ child }) => { child.source.subAgent.thread_spawn.depth = 2; },
    ({ child }) => { child.model = "different-model"; },
    ({ child }) => { child.turns[0].status = "inProgress"; },
    ({ parent }) => { parent.turns[0].itemsView = "summary"; },
    ({ child }) => { child.turns[0].itemsView = "summary"; },
    ({ child }) => { delete child.turns[0].itemsView; },
    ({ child }) => { child.turns[0].items.push({ type: "commandExecution", id: "write" }); },
    ({ child }) => { child.turns[0].items.push({ type: "futureUnknownTool", id: "unknown" }); },
    ({ child }) => { child.turns[0].items[1].agentThreadId = "another-agent"; },
    ({ child }) => { child.turns.push({ id: "resumed", status: "completed", items: [] }); },
  ];
  for (const mutate of mutations) await withIncident(async (fixture) => {
    const { recoverDelegation } = await recoveryModule();
    mutate(fixture);
    const result = await recoverDelegation(fixture.input, fixture.options);
    assert.equal(result.status, "unresolved");
    assert.equal(fixture.store.status(fixture.context).delegationGate.state, "occupied");
    assert.equal(fixture.store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n, 0);
  });
});

test("incomplete recovery metadata cannot masquerade as an applied native receipt", async () => {
  await withIncident(async ({ store, context, route, input, options }) => {
    const { readNativeRecoveryReceipt, recoverDelegation } = await recoveryModule();
    const { payloadHash } = await import("../scripts/lib/io.mjs");
    store.db.prepare("INSERT INTO meta(key, value) VALUES(?, ?)").run(`native_recovery:${route.routeId}`, JSON.stringify({
      schemaVersion: "native-thread-delegation-recovery/2",
      subjectDigest: payloadHash([context.projectId, context.contextKey, route.routeId]),
    }));
    assert.equal(readNativeRecoveryReceipt(store.db, context, route.routeId), null);
    assert.equal((await recoverDelegation(input, options)).status, "recoverable");
    assert.equal(store.status(context).delegationGate.state, "occupied");
  });
});

test("recovery requires fresh stable native evidence and exact inspect-to-apply binding", async () => {
  await withIncident(async ({ input, options, child, store, context }) => {
    const { recoverDelegation } = await recoveryModule();
    const first = await recoverDelegation(input, options);
    const invalid = await recoverDelegation({ ...input, apply: true, expectedEvidenceDigest: digest("wrong") }, options);
    assert.equal(invalid.status, "unresolved");
    child.turns[0].items.at(-1).text = "Changed result";
    const changed = await recoverDelegation({ ...input, apply: true, expectedEvidenceDigest: first.evidenceDigest }, options);
    assert.equal(changed.status, "unresolved");
    let measurement = 0;
    const unstable = await recoverDelegation(input, { ...options, measureTranscript: () => ({ bytes: ++measurement * 4096, identityDigest: digest(String(measurement)) }) });
    assert.equal(unstable.status, "unresolved");
    assert.equal(store.status(context).delegationGate.state, "occupied");
  });
});

test("native recovery refuses consumed attempts and source failures without changing state", async () => {
  await withIncident(async ({ input, options, store, context, route }) => {
    const { recoverDelegation } = await recoveryModule();
    const unavailable = await recoverDelegation(input, { ...options, readThread: async () => { throw new Error("private path /secret"); } });
    assert.equal(unavailable.status, "unresolved");
    assert.equal(JSON.stringify(unavailable).includes("/secret"), false);
    store.db.prepare("UPDATE delegation_attempts SET ticket_consumed = 1, root_turn_id = 'turn', tool_use_id = 'tool', dispatch_input_digest = 'digest' WHERE route_id = ?").run(route.routeId);
    const consumed = await recoverDelegation(input, options);
    assert.equal(consumed.status, "unresolved");
    assert.equal(store.status(context).delegationGate.state, "occupied");
  });
});
