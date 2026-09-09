import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { RouterStore } from "../scripts/lib/database.mjs";
import { routeStage } from "../scripts/lib/router.mjs";
import { recordOutcome } from "../scripts/lib/learning.mjs";
import { callRouterTool } from "../scripts/lib/service.mjs";
import { recoverDelegation, readNativeRecoveryReceipt } from "../scripts/lib/delegation-recovery.mjs";
import { CAPACITY_REJECTION, CAPACITY_REASON, capacityStateKey, observeCapacityList, observeCapacitySpawn, observeCapacityTurn } from "../scripts/lib/host-capacity-recovery.mjs";
import { consumeDelegationTicket, inspectRouterChildBudget, observeAgentResult } from "../scripts/lib/delegation-gate.mjs";
import { CATALOG, routeInput, temporaryProject, withRouterEnvironment } from "./fixtures.mjs";

const parentId = "capacity-parent", turnId = "capacity-turn", callId = "capacity-spawn";
const ampleDisk = () => 16n * 1024n * 1024n * 1024n;
async function incident(run, { recorded = true } = {}) {
  const project = await temporaryProject("router-host-capacity-");
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      try {
        const context = store.context({ cwd: project.root, contextId: parentId });
        const route = await routeStage(routeInput({ contextId: parentId }), { store, cwd: project.root, catalog: CATALOG, diskProbe: ampleDisk });
        assert.equal(route.action, "delegate");
        const args = { task_name: route.carrier.taskName, message: "host-encrypted-activation", fork_turns: "none",
          model: route.target.model, reasoning_effort: route.target.effort };
        assert.equal(consumeDelegationTicket(store.db, context, { taskName: args.task_name, turnId, toolUseId: callId, toolInput: args }).allowed, true);
        const outcome = { routeId: route.routeId, contextId: parentId, status: "failed", gate: route.verificationGate,
          failureType: "tooling", retries: 0, retryBreakdown: { reasoning: 0, environment: 0, information: 0, tooling: 0 },
          escalations: route.escalation.count, userCorrection: false };
        if (recorded) recordOutcome(outcome, { store, cwd: project.root });
        const parent = { id: parentId, cwd: project.root, cliVersion: "0.153.4", parentThreadId: null,
          path: "/native/parent.jsonl", turns: [{ id: turnId, status: "inProgress", itemsView: "full", items: [] }] };
        const records = [
          { type: "session_meta", payload: { id: parentId, cwd: project.root, cli_version: "0.153.4", originator: "Codex Desktop", source: "vscode" } },
          { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
          { type: "turn_context", payload: { turn_id: turnId, cwd: project.root } },
          { type: "response_item", payload: { type: "function_call", name: "spawn_agent", namespace: "collaboration", call_id: callId, arguments: JSON.stringify(args) } },
          { type: "response_item", payload: { type: "function_call_output", call_id: callId, output: CAPACITY_REJECTION } },
        ];
        const raw = () => Buffer.from(`${records.map(JSON.stringify).join("\n")}\n`);
        const options = { store, cwd: project.root, readThread: async () => structuredClone(parent), readParentTranscript: raw };
        await run({ project, store, context, route, parent, records, args, outcome, options, raw,
          input: { contextId: parentId, routeId: route.routeId } });
      } finally { store.close(); }
    });
  } finally { await project.cleanup(); }
}
const attempt = (f) => f.store.db.prepare("SELECT * FROM delegation_attempts WHERE route_id=?").get(f.route.routeId);
async function apply(f) {
  const inspection = await recoverDelegation(f.input, f.options);
  assert.equal(inspection.status, "recoverable");
  assert.equal(inspection.recoveryKind, "host_agent_limit_rejected");
  const result = await recoverDelegation({ ...f.input, apply: true, expectedEvidenceDigest: inspection.evidenceDigest }, f.options);
  assert.equal(result.status, "reconciled_failure");
  return result;
}

for (const recorded of [false, true]) test(`capacity recovery preserves lifecycle and ${recorded ? "the existing" : "the absent"} outcome`, async () => {
  await incident(async (f) => {
    const before = attempt(f), budget = inspectRouterChildBudget(f.store.db, f.context);
    const outcomes = f.store.db.prepare("SELECT * FROM outcomes").all();
    const result = await apply(f), after = attempt(f);
    for (const field of ["ticket_consumed", "post_observed", "stop_observed", "no_child", "outcome_recorded", "outcome_status", "transcript_bytes"]) {
      assert.equal(after[field], before[field]);
    }
    assert.equal(after.ticket_hash, null);
    assert.equal(after.context_package, null);
    assert.ok(after.finalized_at);
    assert.deepEqual(f.store.db.prepare("SELECT * FROM outcomes").all(), outcomes);
    assert.equal(result.receipt.originalHandshakeProven, true);
    assert.equal(result.receipt.originalDispatchConsumed, true);
    assert.equal(result.receipt.transcriptBytes, 0);
    assert.equal(f.store.status(f.context).delegationGate.state, "available");
    assert.equal(f.store.status(f.context).currentStage.state, "reconciled_failure");
    assert.equal(f.store.status(f.context).hostCapacityRejection.reasonCode, CAPACITY_REASON);
    const nextBudget = inspectRouterChildBudget(f.store.db, f.context);
    assert.equal(nextBudget.pending, budget.pending - 1);
    assert.equal(nextBudget.usedBytes, budget.usedBytes);
    const replay = await recoverDelegation({ ...f.input, apply: true, expectedEvidenceDigest: result.receipt.evidenceDigest }, f.options);
    assert.equal(replay.idempotent, true);
    assert.deepEqual(inspectRouterChildBudget(f.store.db, f.context), nextBudget);
    assert.equal(consumeDelegationTicket(f.store.db, f.context, { taskName: f.args.task_name, turnId, toolUseId: "retry", toolInput: f.args }).allowed, false);
  }, { recorded });
});

test("the native MCP outcome path automatically closes a proven capacity refusal", async () => {
  await incident(async (f) => {
    const result = await callRouterTool("record_outcome", f.outcome, { store: f.store, cwd: f.project.root, recoveryOptions: f.options });
    assert.equal(result.recorded, true);
    assert.deepEqual(result.delegationRecovery, { status: "reconciled_failure", gateReleased: true, reasonCode: CAPACITY_REASON });
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n, 1);
    assert.equal(attempt(f).post_observed, 0);
    assert.equal(f.store.status(f.context).delegationGate.state, "available");
  }, { recorded: false });
});

test("automatic recovery retains a generic error and never repairs through status reads", async () => {
  await incident(async (f) => {
    f.records[4].payload.output = "collab spawn failed: connection lost";
    const before = attempt(f);
    await callRouterTool("get_route_status", { contextId: parentId }, { store: f.store, cwd: f.project.root });
    assert.deepEqual(attempt(f), before);
    const result = await callRouterTool("record_outcome", f.outcome, { store: f.store, cwd: f.project.root, recoveryOptions: f.options });
    assert.equal(result.delegationRecovery, undefined);
    assert.equal(attempt(f).finalized_at, null);
    assert.equal(f.store.status(f.context).delegationGate.state, "occupied");
  }, { recorded: false });
});

const list = (f, statuses, turn = turnId) => observeCapacityList(f.store.db, f.context, { turn_id: turn,
  tool_name: "collaborationlist_agents", tool_use_id: "capacity-list", tool_response: JSON.stringify({ agents:
    statuses.map((agent_status, i) => ({ agent_name: `/root/child_${i}`, agent_status })) }) });

test("capacity rejection requests a native recheck and allows a later real admission in the same root", async () => {
  await incident(async (f) => {
    await apply(f);
    for (const extra of [{}, { override: { model: "gpt-6-astra", effort: "high" } }]) {
      const next = await routeStage(routeInput({ contextId: parentId, stageId: "later", ...extra }), { store: f.store, cwd: f.project.root, catalog: CATALOG, diskProbe: ampleDisk });
      assert.equal(next.action, "continue");
      assert.deepEqual(next.reasonCodes, ["HOST_CAPACITY_RECHECK_REQUIRED"]);
      assert.equal(next.carrier, undefined);
    }
    list(f, ["running", "running", "running"]);
    const busy = await routeStage(routeInput({ contextId: parentId, stageId: "later" }), { store: f.store, cwd: f.project.root, catalog: CATALOG, diskProbe: ampleDisk });
    assert.deepEqual(busy.reasonCodes, ["HOST_CAPACITY_TEMPORARY_BUSY"]);
    assert.equal(f.store.hasAuthoritativeToolingRejection(f.context, f.route.routeId), true);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM delegation_attempts").get().n, 1);
    list(f, [{ completed: "result retained" }, { completed: "result retained" }, { completed: "result retained" }]);
    const resumed = await routeStage(routeInput({ contextId: parentId, stageId: "later" }), { store: f.store, cwd: f.project.root, catalog: CATALOG, diskProbe: ampleDisk });
    assert.equal(resumed.action, "delegate");
    assert.notEqual(resumed.carrier.taskName, f.route.carrier.taskName);
    assert.equal(f.store.status(f.context).hostCapacityRejection.state, "recheck_required", "admission alone is not recovery proof");
    const args = { task_name: resumed.carrier.taskName, message: resumed.carrier.message, fork_turns: "none", model: resumed.target.model, reasoning_effort: resumed.target.effort };
    consumeDelegationTicket(f.store.db, f.context, { taskName: args.task_name, turnId, toolUseId: "resumed", toolInput: args });
    observeAgentResult(f.store.db, f.context, { turnId, toolUseId: "resumed", toolInput: args, toolResponse: { agent_id: "resumed-child" } });
    observeCapacitySpawn(f.store.db, f.context, resumed.routeId);
    assert.equal(f.store.status(f.context).hostCapacityRejection.state, "recovered");
    const other = await routeStage(routeInput({ contextId: "other-task" }), { store: f.store, cwd: f.project.root, catalog: CATALOG, diskProbe: ampleDisk });
    assert.equal(other.action, "delegate");
  });
});

test("one recovery startup is allowed, a second refusal stops this stage until a later native turn", async () => {
  await incident(async (f) => {
    await apply(f);
    list(f, [{ completed: "unknown mailbox; native allocation will decide" }]);
    const next = await routeStage(routeInput({ contextId: parentId }), { store: f.store, cwd: f.project.root, catalog: CATALOG, diskProbe: ampleDisk });
    assert.equal(next.action, "delegate");
    const args = { task_name: next.carrier.taskName, message: next.carrier.message, fork_turns: "none", model: next.target.model, reasoning_effort: next.target.effort };
    consumeDelegationTicket(f.store.db, f.context, { taskName: args.task_name, turnId, toolUseId: "second-refusal", toolInput: args });
    const outcome = { ...f.outcome, routeId: next.routeId, gate: next.verificationGate, escalations: next.escalation.count };
    recordOutcome(outcome, { store: f.store, cwd: f.project.root });
    f.records.push({ type: "response_item", payload: { type: "function_call", namespace: "collaboration", name: "spawn_agent", call_id: "second-refusal", arguments: JSON.stringify(args) } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "second-refusal", output: CAPACITY_REJECTION } });
    await apply({ ...f, input: { contextId: parentId, routeId: next.routeId } });
    list(f, [{ completed: "still no physical proof" }]);
    const exhausted = await routeStage(routeInput({ contextId: parentId }), { store: f.store, cwd: f.project.root, catalog: CATALOG, diskProbe: ampleDisk });
    assert.deepEqual(exhausted.reasonCodes, ["HOST_CAPACITY_RETRY_EXHAUSTED"]);
    assert.equal(exhausted.carrier, undefined);
    observeCapacityTurn(f.store.db, f.context, "next-real-turn");
    list(f, [{ completed: "updated result" }], "next-real-turn");
    const later = await routeStage(routeInput({ contextId: parentId }), { store: f.store, cwd: f.project.root, catalog: CATALOG, diskProbe: ampleDisk });
    assert.equal(later.action, "delegate");
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n, 2);
  });
});

test("a plain-error PostToolUse ambiguity can be reconciled only through the exact native proof", async () => {
  await incident(async (f) => {
    observeAgentResult(f.store.db, f.context, { turnId, toolUseId: callId, toolInput: f.args, toolResponse: CAPACITY_REJECTION });
    assert.equal(attempt(f).ambiguous, 1);
    assert.equal(attempt(f).post_observed, 1);
    await apply(f);
    assert.equal(attempt(f).no_child, 0);
  });
});

test("incomplete, replayed, misbound and conflicting native rejection evidence cannot unlock", async () => {
  const cases = [
    f => { f.records[4].payload.output = "collab spawn failed: unknown"; },
    f => { f.records[4].payload.output = `${CAPACITY_REJECTION}\n`; },
    f => { f.records[4].payload.output = { error: CAPACITY_REJECTION }; },
    f => { f.records[4].payload.call_id = "other"; },
    f => { f.records[3].payload.namespace = "functions"; },
    f => { f.records[3].payload.arguments = JSON.stringify({ ...f.args, model: "gpt-5.5" }); },
    f => { f.records[3].payload.arguments = JSON.stringify({ ...f.args, message: "changed-ciphertext" }); },
    f => { f.records[3].payload.arguments = JSON.stringify({ ...f.args, reasoning_effort: "low" }); },
    f => { f.records.push(structuredClone(f.records[3])); },
    f => { f.records.push(structuredClone(f.records[4])); },
    f => { f.records.push({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "replay", input: f.args.task_name } }); },
    f => { [f.records[3], f.records[4]] = [f.records[4], f.records[3]]; },
    f => { f.parent.cliVersion = "0.153.5"; },
    f => { f.records[0].payload.cli_version = "0.153.3"; },
    f => { f.records[0].payload.cwd += "/other"; },
    f => { f.parent.turns[0].itemsView = "summary"; },
    f => { f.parent.turns[0].id = "other-turn"; },
    f => { f.parent.turns[0].items.push({ type: "subAgentActivity", kind: "started", id: callId, agentPath: `/root/${f.args.task_name}`, agentThreadId: "late-child" }); },
    f => { f.records.push({ type: "event_msg", payload: { type: "item_completed", item: { type: "subAgentActivity", kind: "started", agentPath: `/root/${f.args.task_name}` } } }); },
    f => { f.options.readParentTranscript = () => f.raw().subarray(0, f.raw().length - 1); },
    f => { f.records.push({ type: "unknown-native-record", payload: {} }); },
  ];
  for (const [index, change] of cases.entries()) await incident(async f => {
    const before = attempt(f); change(f);
    const result = await recoverDelegation(f.input, f.options);
    assert.equal(result.status, "unresolved", `negative case ${index}`);
    assert.deepEqual(attempt(f), before);
    assert.equal(f.store.hostCapacityRejection(f.context), null);
  });
});

test("recovery binds retained outcome, ordinary route class and all late lifecycle evidence in CAS", async () => {
  const changes = [
    f => f.store.db.prepare("UPDATE delegation_attempts SET early_agent_id=? WHERE route_id=?").run("a".repeat(64), f.route.routeId),
    f => f.store.db.prepare("UPDATE outcomes SET failure_type='reasoning' WHERE route_id=?").run(f.route.routeId),
    f => f.store.db.prepare("UPDATE outcomes SET gate='none' WHERE route_id=?").run(f.route.routeId),
    f => f.store.db.prepare("UPDATE routes SET reason_codes_json='[\"HOST_LIFECYCLE_QUALIFICATION\"]' WHERE route_id=?").run(f.route.routeId),
    f => f.store.db.prepare("UPDATE delegation_attempts SET root_turn_id='wrong-turn' WHERE route_id=?").run(f.route.routeId),
  ];
  for (const change of changes) await incident(async f => {
    const inspected = await recoverDelegation(f.input, f.options);
    assert.equal(inspected.status, "recoverable");
    change(f);
    const result = await recoverDelegation({ ...f.input, apply: true, expectedEvidenceDigest: inspected.evidenceDigest }, f.options);
    assert.equal(result.status, "unresolved");
    assert.equal(attempt(f).finalized_at, null);
  });
  await incident(async f => {
    let reads = 0;
    f.options.readThread = async () => {
      if (++reads === 3) f.store.db.prepare("UPDATE delegation_attempts SET early_agent_id=? WHERE route_id=?").run("a".repeat(64), f.route.routeId);
      return structuredClone(f.parent);
    };
    const inspection = await recoverDelegation(f.input, f.options);
    const result = await recoverDelegation({ ...f.input, apply: true, expectedEvidenceDigest: inspection.evidenceDigest }, f.options);
    assert.equal(result.status, "unresolved");
    assert.equal(attempt(f).finalized_at, null);
  });
});

test("unrelated parent progress and historical children preserve an exact denied launch", async () => {
  await incident(async f => {
    f.parent.turns[0].items.push({ type: "subAgentActivity", kind: "completed", agentPath: "/root/earlier-child", agentThreadId: "old-child", id: "old-completed" });
    const inspected = await recoverDelegation(f.input, f.options);
    assert.equal(inspected.status, "recoverable");
    f.records.push({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Root progress" }] } });
    const applied = await recoverDelegation({ ...f.input, apply: true, expectedEvidenceDigest: inspected.evidenceDigest }, f.options);
    assert.equal(applied.gateReleased, true);
  });
});

test("streaming native audit recovers a parent over 64 MiB without loading the complete log", async () => {
  await incident(async f => {
    const oldHome = process.env.CODEX_HOME;
    try {
      await mkdir(resolve(f.project.home, "sessions"), { recursive: true });
      process.env.CODEX_HOME = await realpath(f.project.home);
      f.parent.path = resolve(process.env.CODEX_HOME, "sessions", "large-parent.jsonl");
      const file = await open(f.parent.path, "wx", 0o600);
      try {
        await file.write(f.raw());
        const largeRecord = `${JSON.stringify({ type: "world_state", payload: { text: "x".repeat(1024 * 1024) } })}\n`;
        for (let i = 0; i < 65; i += 1) await file.write(largeRecord);
      } finally { await file.close(); }
      delete f.options.readParentTranscript;
      const result = await apply(f);
      assert.ok(result.receipt.sourceBytes > 64 * 1024 * 1024);
      assert.equal(result.receipt.transcriptBytes, 0);
    } finally {
      if (oldHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldHome;
    }
  });
});

test("the final native projection and transaction reject newly appearing child or changed outcome", async () => {
  for (const kind of ["child", "outcome"]) await incident(async f => {
    const inspected = await recoverDelegation(f.input, f.options);
    let reads = 0;
    f.options.readThread = async () => {
      if (++reads === 3) {
        if (kind === "child") f.parent.turns[0].items.push({ type: "subAgentActivity", id: callId, agentPath: "/root/unknown" });
        else f.store.db.prepare("UPDATE outcomes SET retry_tooling=1, retries=1 WHERE route_id=?").run(f.route.routeId);
      }
      return structuredClone(f.parent);
    };
    const result = await recoverDelegation({ ...f.input, apply: true, expectedEvidenceDigest: inspected.evidenceDigest }, f.options);
    assert.equal(result.status, "unresolved");
    assert.equal(attempt(f).finalized_at, null);
  });
});

test("malformed or cross-context receipts cannot establish authoritative capacity recovery", async () => {
  await incident(async f => {
    const { receipt } = await apply(f);
    for (const patch of [{ originalHandshakeProven: false }, { originalDispatchConsumed: false }, { transcriptBytes: 1 }, { retainedOutcomeDigest: "bad" }, { rejectionCode: "generic" }, { cliVersion: "0.153.5" }]) {
      f.store.db.prepare("UPDATE meta SET value=? WHERE key=?").run(JSON.stringify({ ...receipt, ...patch }), `native_recovery:${f.route.routeId}`);
      assert.equal(readNativeRecoveryReceipt(f.store.db, f.context, f.route.routeId), null);
      assert.equal(f.store.hostCapacityRejection(f.context).reasonCode, "HOST_CAPACITY_EVIDENCE_UNPROVEN");
    }
    f.store.db.prepare("UPDATE meta SET value=? WHERE key=?").run(JSON.stringify(receipt), `native_recovery:${f.route.routeId}`);
    const other = f.store.context({ cwd: f.project.root, contextId: "other-task" });
    f.store.db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run(capacityStateKey(other), f.route.routeId);
    assert.equal(readNativeRecoveryReceipt(f.store.db, other, f.route.routeId), null);
    assert.equal(f.store.hostCapacityRejection(other).reasonCode, "HOST_CAPACITY_EVIDENCE_UNPROVEN");
  });
});
