import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { RouterStore } from "../scripts/lib/database.mjs";
import { routeStage } from "../scripts/lib/router.mjs";
import { recoverDelegation, readNativeRecoveryReceipt } from "../scripts/lib/delegation-recovery.mjs";
import { readNativeParentTranscript } from "../scripts/lib/native-predispatch-audit.mjs";
import { consumeDelegationTicket, inspectRouterChildBudget } from "../scripts/lib/delegation-gate.mjs";
import { qualificationReadiness, runtimeSourceDigest } from "../scripts/lib/lifecycle-qualification.mjs";
import { payloadHash } from "../scripts/lib/io.mjs";
import { CATALOG, routeInput, temporaryProject, withRouterEnvironment } from "./fixtures.mjs";

const parentId = "predispatch-parent";
const turnId = "predispatch-turn";
const rejection = "Tool call blocked by PreToolUse hook: Router-marked Agent model or reasoning effort does not match the admitted route.. Tool: collaborationspawn_agent";
function consume(f) {
  return consumeDelegationTicket(f.store.db, f.context, { taskName: f.route.carrier.taskName,
    turnId, toolUseId: "concurrent-valid-call", toolInput: { ...f.args,
      model: f.route.target.model, reasoning_effort: f.route.target.effort } });
}

async function incident(run, { qualification = false } = {}) {
  const project = await temporaryProject("router-predispatch-");
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      try {
        const context = store.context({ cwd: project.root, contextId: parentId });
        const binding = qualification ? { digest: "a".repeat(64), runtimeDigest: runtimeSourceDigest(),
          taskCwdDigest: payloadHash(project.root), shellRoots: [payloadHash(resolve("."))], cliVersion: "0.153.4" } : null;
        const route = await routeStage(routeInput({ contextId: parentId }), {
          store, cwd: project.root, catalog: CATALOG,
          diskProbe: () => 16n * 1024n * 1024n * 1024n,
          ...(qualification ? { lifecycleHookProbe: async () => qualificationReadiness(store.db, context, binding) } : {}),
        });
        assert.equal(route.action, "delegate");
        if (qualification) assert.deepEqual(route.reasonCodes, ["HOST_LIFECYCLE_QUALIFICATION"]);
        const parent = { id: parentId, cwd: project.root, cliVersion: "0.153.4",
          parentThreadId: null, path: "/native/parent.jsonl",
          turns: [{ id: turnId, status: "inProgress", itemsView: "full", items: [] }] };
        const args = { task_name: route.carrier.taskName, message: "host-encrypted-activation", fork_turns: "none" };
        const records = [
          { type: "session_meta", payload: { id: parentId, cwd: project.root, cli_version: "0.153.4", originator: "Codex Desktop", source: "vscode" } },
          { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
          { type: "turn_context", payload: { turn_id: turnId, cwd: project.root, model: "gpt-6-astra", effort: "max" } },
          { type: "response_item", payload: { type: "function_call", name: "spawn_agent", namespace: "collaboration", call_id: "rejected-call", arguments: JSON.stringify(args) } },
          { type: "response_item", payload: { type: "function_call_output", call_id: "rejected-call", output: rejection } },
        ];
        const raw = () => Buffer.from(`${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
        const options = { store, cwd: project.root, readThread: async () => structuredClone(parent),
          readParentTranscript: raw };
        await run({ project, store, context, route, parent, records, args, options,
          input: { contextId: parentId, routeId: route.routeId } });
      } finally { store.close(); }
    });
  } finally { await project.cleanup(); }
}

test("automatic launch instructions include the complete host parameter mapping", async () => {
  await incident(async ({ project, store, context }) => {
    store.configure(context, { autoActivate: true }, "global");
    const result = spawnSync(process.execPath, [resolve("scripts/hook.mjs"), "prompt"], {
      input: JSON.stringify({ cwd: project.root, session_id: parentId, model: "gpt-6-astra", prompt: "Review the next change." }),
      encoding: "utf8", env: { ...process.env, ADAPTIVE_ROUTER_HOME: project.home, ADAPTIVE_ROUTER_LOCAL_ONLY: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
    const text = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    const line = text.split("\n").find((value) => value.startsWith("For delegate, call"));
    for (const field of ["task_name", "message", "fork_turns", "model", "reasoning_effort"]) {
      assert.match(line, new RegExp(`\\b${field}\\b`), `missing host parameter ${field}`);
    }
    assert.match(line, /target\.model.*model/);
    assert.match(line, /target\.effort.*reasoning_effort/);
  });
});

test("the returned carrier repeats every required host launch parameter", async () => {
  await incident(async ({ route }) => {
    for (const field of ["task_name", "message", "fork_turns", "model", "reasoning_effort"]) {
      assert.match(route.carrier.instruction, new RegExp(`\\b${field}\\b`));
    }
    assert.match(route.carrier.instruction, /target\.model.*model/);
    assert.match(route.carrier.instruction, /target\.effort.*reasoning_effort/);
  });
});

test("native pre-dispatch rejection closes the reservation without inventing a dispatch or outcome", async () => {
  await incident(async ({ store, context, route, options, input, records }) => {
    const before = inspectRouterChildBudget(store.db, context);
    const inspected = await recoverDelegation(input, options);
    assert.equal(inspected.status, "recoverable");
    assert.equal(inspected.recoveryKind, "rejected_before_dispatch");
    assert.equal(store.status(context).delegationGate.state, "occupied");
    // A live parent may keep working between inspect and apply. Unrelated
    // complete records must not invalidate an unchanged, fully audited denial.
    records.push({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Continuing the root work." }] } });
    const recovered = await recoverDelegation({ ...input, apply: true, expectedEvidenceDigest: inspected.evidenceDigest }, options);
    assert.equal(recovered.status, "reconciled_failure");
    assert.equal(recovered.gateReleased, true);
    const row = store.db.prepare("SELECT * FROM delegation_attempts WHERE route_id=?").get(route.routeId);
    for (const field of ["ticket_consumed", "post_observed", "stop_observed", "no_child", "outcome_recorded"]) assert.equal(row[field], 0);
    assert.equal(row.ticket_hash, null);
    assert.equal(row.context_package, null);
    assert.ok(row.finalized_at);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n, 0);
    assert.equal(store.status(context).delegationGate.state, "available");
    assert.equal(store.status(context).currentStage.state, "reconciled_failure");
    const after = inspectRouterChildBudget(store.db, context);
    assert.equal(after.pending, before.pending - 1);
    assert.equal(after.usedBytes, before.usedBytes, "parent transcript is not child storage");
    const replay = await recoverDelegation({ ...input, apply: true, expectedEvidenceDigest: inspected.evidenceDigest }, options);
    assert.equal(replay.idempotent, true);
    const stale = consumeDelegationTicket(store.db, context, { taskName: route.carrier.taskName,
      turnId, toolUseId: "retry-call", toolInput: { task_name: route.carrier.taskName, message: "encrypted",
        fork_turns: "none", model: route.target.model, reasoning_effort: route.target.effort } });
    assert.equal(stale.allowed, false, "a closed ticket cannot be retried");
  });
});

test("a profile refusal prevents ticket reuse and Stop directs recovery instead of another spawn", async () => {
  await incident(async (f) => {
    const denied = consumeDelegationTicket(f.store.db, f.context, {
      taskName: f.route.carrier.taskName, turnId, toolUseId: "rejected-call", toolInput: f.args,
    });
    assert.equal(denied.allowed, false);
    assert.match(denied.reason, /model or reasoning effort/);
    assert.equal(consume(f).allowed, false, "correcting fields cannot reuse the rejected ticket");
    const stop = f.store.handleStop(f.context);
    assert.equal(stop.action, "block");
    assert.match(stop.reason, /native recovery/i);
    assert.doesNotMatch(stop.reason, /call the direct spawn_agent tool now/);
    assert.equal(f.store.handleStop(f.context, { stopHookActive: true }).action, "allow");
    assert.equal(f.store.status(f.context).delegationGate.state, "occupied");
    const inspected = await recoverDelegation(f.input, f.options);
    assert.equal(inspected.status, "recoverable");
    const applied = await recoverDelegation({ ...f.input, apply: true, expectedEvidenceDigest: inspected.evidenceDigest }, f.options);
    assert.equal(applied.status, "reconciled_failure");
    assert.equal(f.store.status(f.context).delegationGate.state, "available");
  });
});

test("pre-dispatch recovery rejects incomplete, conflicting, or generic failure evidence", async () => {
  const mutations = [
    (f) => { f.records[4].payload.output = "Error: no agent created"; },
    (f) => { f.records[4].payload.call_id = "other-call"; },
    (f) => { f.records[4] = { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: rejection }] } }; },
    (f) => { f.records.splice(4, 0,
      { type: "event_msg", payload: { type: "task_started", turn_id: "other-turn" } },
      { type: "turn_context", payload: { turn_id: "other-turn" } }); },
    (f) => { f.records[3].payload.namespace = "functions"; },
    (f) => { f.records[3].payload.arguments = JSON.stringify({ ...f.args, model: f.route.target.model, reasoning_effort: f.route.target.effort }); },
    (f) => { f.records[3].payload.arguments = JSON.stringify({ ...f.args, fork_turns: "all" }); },
    (f) => { f.records.push(structuredClone(f.records[3])); },
    (f) => { f.records.push(structuredClone(f.records[4])); },
    (f) => { f.records[0].payload.cli_version = "0.153.5"; },
    (f) => { f.parent.cliVersion = "0.153.5"; },
    (f) => { f.parent.turns[0].itemsView = "truncated"; },
    (f) => { f.records[2].payload.turn_id = "other-turn"; },
    (f) => { f.records.push({ type: "unknown_native_record", payload: {} }); },
    (f) => { f.records.push({ type: "event_msg", payload: { type: "unknown_native_event" } }); },
    (f) => { f.records.push({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: `spawn(${f.route.carrier.taskName})` } }); },
    (f) => { f.parent.turns[0].items.push({ type: "subAgentActivity", kind: "started", agentPath: `/root/${f.route.carrier.taskName}`, agentThreadId: "unexpected-child" }); },
    (f) => { f.records.push({ type: "event_msg", payload: { type: "item_completed", item: { type: "subAgentActivity", kind: "started", agentPath: `/root/${f.route.carrier.taskName}` } } }); },
    (f) => { const read = f.options.readParentTranscript; f.options.readParentTranscript = () => read().subarray(0, -1); },
    (f) => { f.store.db.prepare("UPDATE delegation_attempts SET early_agent_id='child' WHERE route_id=?").run(f.route.routeId); },
    (f) => { assert.equal(consume(f).allowed, true); },
  ];
  for (const mutate of mutations) await incident(async (f) => {
    mutate(f);
    const result = await recoverDelegation(f.input, f.options);
    assert.equal(result.status, "unresolved");
    assert.equal(f.store.status(f.context).delegationGate.state, "occupied");
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n, 0);
  });
});

test("changed denial or reservation between audit reads cannot release the gate", async () => {
  for (const change of ["output", "child", "state", "route", "digest"]) await incident(async (f) => {
    const inspected = await recoverDelegation(f.input, f.options);
    assert.equal(inspected.status, "recoverable");
    let calls = 0;
    const read = f.options.readParentTranscript;
    f.options.readParentTranscript = () => {
      if (++calls === 2) {
        if (change === "output") f.records[4].payload.output = "ambiguous";
        if (change === "child") f.parent.turns[0].items.push({ type: "subAgentActivity", agentPath: `/root/${f.route.carrier.taskName}` });
        if (change === "state") assert.equal(consume(f).allowed, true);
        if (change === "route") f.store.db.prepare("UPDATE routes SET reason_codes_json=? WHERE route_id=?")
          .run(JSON.stringify(["HOST_LIFECYCLE_QUALIFICATION"]), f.route.routeId);
      }
      return read();
    };
    const result = await recoverDelegation({ ...f.input, apply: true,
      expectedEvidenceDigest: change === "digest" ? "a".repeat(64) : inspected.evidenceDigest }, f.options);
    assert.equal(result.status, "unresolved", change);
    assert.equal(f.store.status(f.context).delegationGate.state, "occupied");
  });
});

test("qualification routes cannot enter ordinary recovery when their metadata is absent or invalid", async () => {
  for (const mutation of ["intact", "missing", "invalid", "wrong-route"]) await incident(async (f) => {
    const key = `native_qualification:${f.context.projectId}:${f.context.contextKey}`;
    if (mutation === "missing") f.store.db.prepare("DELETE FROM meta WHERE key=?").run(key);
    if (mutation === "invalid") f.store.db.prepare("UPDATE meta SET value=? WHERE key=?").run("{}", key);
    if (mutation === "wrong-route") {
      const value = JSON.parse(f.store.db.prepare("SELECT value FROM meta WHERE key=?").get(key).value);
      f.store.db.prepare("UPDATE meta SET value=? WHERE key=?").run(JSON.stringify({ ...value, routeId: "other-route" }), key);
    }
    const result = await recoverDelegation(f.input, f.options);
    assert.equal(result.status, "unresolved", mutation);
    assert.equal(f.store.status(f.context).delegationGate.state, "occupied");
  }, { qualification: true });
  for (const mutation of ["invalid-qualification", "invalid-reasons"]) await incident(async (f) => {
    if (mutation === "invalid-qualification") f.store.db.prepare("INSERT INTO meta(key,value) VALUES(?,?)")
      .run(`native_qualification:${f.context.projectId}:${f.context.contextKey}`, "{}");
    else f.store.db.prepare("UPDATE routes SET reason_codes_json=? WHERE route_id=?").run("{}", f.route.routeId);
    assert.equal((await recoverDelegation(f.input, f.options)).status, "unresolved", mutation);
  });
});

test("incomplete pre-dispatch receipts are not treated as verified recovery", async () => {
  await incident(async (f) => {
    const inspected = await recoverDelegation(f.input, f.options);
    const applied = await recoverDelegation({ ...f.input, apply: true, expectedEvidenceDigest: inspected.evidenceDigest }, f.options);
    assert.equal(applied.status, "reconciled_failure");
    for (const patch of [
      { schemaVersion: "unknown" }, { rawAuditAdapter: "future" }, { cliVersion: "0.153.5" },
      { recoveryKind: "ordinary" }, { originalHandshakeProven: true }, { originalDispatchConsumed: true },
      { transcriptBytes: 1 }, { sourceBytes: 0 }, { subjectDigest: "a".repeat(64) },
      { launchItemDigest: null }, { rejectionItemDigest: null }, { dispatchInputDigest: null },
      { rawAuditDigest: null }, { sourceDigest: null }, { evidenceDigest: null },
    ]) {
      f.store.db.prepare("UPDATE meta SET value=? WHERE key=?")
        .run(JSON.stringify({ ...applied.receipt, ...patch }), `native_recovery:${f.route.routeId}`);
      assert.equal(readNativeRecoveryReceipt(f.store.db, f.context, f.route.routeId), null);
    }
  });
});

test("native parent audit reads only regular files inside Codex transcript roots", async () => {
  const project = await temporaryProject("router-parent-source-");
  const previousCodexHome = process.env.CODEX_HOME;
  try {
    await mkdir(resolve(project.home, "sessions"), { recursive: true });
    process.env.CODEX_HOME = await realpath(project.home);
    const directory = resolve(process.env.CODEX_HOME, "sessions");
    const path = resolve(directory, "parent.jsonl");
    const bytes = Buffer.from('{"type":"session_meta","payload":{}}\n');
    await writeFile(path, bytes);
    assert.deepEqual(readNativeParentTranscript(path), bytes);
    const outside = resolve(await realpath(project.root), "outside.jsonl");
    await writeFile(outside, bytes);
    assert.throws(() => readNativeParentTranscript(outside));
    const link = resolve(directory, "linked.jsonl");
    await symlink(process.platform === "win32" ? directory : path, link,
      process.platform === "win32" ? "junction" : "file");
    assert.throws(() => readNativeParentTranscript(process.platform === "win32" ? resolve(link, "parent.jsonl") : link));
    assert.throws(() => readNativeParentTranscript(directory));
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await project.cleanup();
  }
});
