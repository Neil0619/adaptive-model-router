import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditNativeLifecycleNoop } from "../scripts/lib/native-lifecycle-audit.mjs";
import { newTaskQualification } from "../scripts/lib/lifecycle-qualification.mjs";
import { auditNativeLifecycleTranscript } from "../scripts/lib/native-recovery-audit.mjs";

function fixture(cliVersion = "0.153.0") {
  const parentId = "probe-root";
  const taskName = `router_${"a".repeat(32)}`;
  const target = { model: cliVersion === "0.153.3" ? "gpt-6-astra" : "gpt-5.6-sol", effort: "low" };
  const marker = `NATIVE_ROUTER_NOOP_${"a".repeat(24)}`;
  const child = {
    id: "probe-child", parentThreadId: parentId, forkedFromId: null,
    cliVersion, model: target.model, reasoningEffort: target.effort,
    path: "/native-owned/probe.jsonl",
    source: { subAgent: { thread_spawn: {
      parent_thread_id: parentId, depth: 1, agent_path: `/root/${taskName}`,
    } } },
    turns: [{ id: "probe-turn", status: "completed", error: null, itemsView: "full", items: [
      { type: "reasoning", id: "reason", summary: [] },
      { type: "agentMessage", id: "final", phase: "final_answer", text: marker },
    ] }],
  };
  const records = [
    { type: "session_meta", payload: { id: child.id, parent_thread_id: parentId, cli_version: child.cliVersion } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "probe-turn" } },
    { type: "turn_context", payload: { turn_id: "probe-turn", model: target.model, effort: target.effort } },
    { type: "response_item", payload: { type: "message", id: "final", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: marker }] } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "probe-turn" } },
  ];
  const readTranscript = () => Buffer.from(`${records.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return { input: { child, parentId, taskName, target, marker }, records, options: { readTranscript } };
}

test("native no-op probe accepts an exact completed marker and its full source stream", () => {
  const { input, options } = fixture();
  const result = auditNativeLifecycleNoop(input, options);
  assert.equal(result.passed, true);
  assert.equal(result.rawAuditAdapter, "codex-0.153.0-no-work/1");
  assert.match(result.rawAuditDigest, /^[a-f0-9]{64}$/u);
});

test("native no-op probe keeps the separately pinned earlier-build adapter", () => {
  const { input, options } = fixture("0.153.0-alpha.5");
  const result = auditNativeLifecycleNoop(input, options);
  assert.equal(result.passed, true);
  assert.equal(result.rawAuditAdapter, "codex-0.153.0-alpha.5-no-work/1");
});

test("CLI 0.153.3 uses its reviewed adapter without rebinding old receipts or accepting adjacent builds", () => {
  const { input, options } = fixture("0.153.3");
  const result = auditNativeLifecycleNoop(input, options);
  assert.equal(result.passed, true);
  assert.equal(result.rawAuditAdapter, "codex-0.153.3-no-work/1");
  assert.throws(() => auditNativeLifecycleTranscript(options.readTranscript(), input.child, input.parentId), /unproven/);
  const binding = { digest: "a".repeat(64), runtimeDigest: "b".repeat(64), taskCwdDigest: "c".repeat(64),
    shellRoots: ["d".repeat(64)], cliVersion: "0.153.3" };
  assert.equal(newTaskQualification(binding, "test-route").state, "pending");
  for (const cliVersion of ["0.153.2", "0.153.4", "0.153.3-alpha.1", "0.154.0", "toString", "__proto__"]) {
    const other = fixture(cliVersion);
    assert.equal(auditNativeLifecycleNoop(other.input, other.options).passed, false, cliVersion);
    assert.equal(newTaskQualification({ ...binding, cliVersion }, "test-route"), null, cliVersion);
  }
});

test("native no-op probe reads only stable regular native session files by default", () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "router-noop-audit-")));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(scratch, "codex");
  try {
    const { input, options } = fixture();
    const sessions = join(process.env.CODEX_HOME, "sessions");
    mkdirSync(sessions, { recursive: true });
    input.child.path = join(sessions, "child.jsonl");
    writeFileSync(input.child.path, options.readTranscript());
    assert.equal(auditNativeLifecycleNoop(input).passed, true);
    const alias = join(sessions, "alias.jsonl");
    symlinkSync(input.child.path, alias);
    input.child.path = alias;
    assert.equal(auditNativeLifecycleNoop(input).passed, false);
    input.child.path = join(scratch, "outside.jsonl");
    writeFileSync(input.child.path, options.readTranscript());
    assert.equal(auditNativeLifecycleNoop(input).passed, false);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("native no-op probe rejects hidden actions even when the native projection looks inert", () => {
  for (const cliVersion of ["0.153.0", "0.153.3"]) for (const payload of [
    { type: "custom_tool_call", name: "exec", namespace: "functions", call_id: "hidden" },
    { type: "function_call", name: "exec_command", call_id: "hidden" },
    { type: "future_native_action", id: "hidden" },
  ]) {
    const { input, options, records } = fixture(cliVersion);
    records.splice(-2, 0, { type: "response_item", payload });
    assert.equal(auditNativeLifecycleNoop(input, options).passed, false, payload.type);
  }
});

test("native no-op probe rejects incomplete, mismatched, resumed and unknown-build children", () => {
  for (const cliVersion of ["0.153.0", "0.153.3"]) for (const mutate of [
    ({ child }) => { child.parentThreadId = "different-root"; },
    ({ child }) => { child.source.subAgent.thread_spawn.agent_path = "/root/other"; },
    ({ child }) => { child.source.subAgent.thread_spawn.depth = 2; },
    ({ child }) => { child.forkedFromId = "history"; },
    ({ child }) => { child.model = "different-model"; },
    ({ child }) => { child.reasoningEffort = "high"; },
    ({ child }) => { child.cliVersion = "0.154.0"; },
    ({ child }) => { child.turns[0].itemsView = "summary"; },
    ({ child }) => { child.turns[0].status = "inProgress"; },
    ({ child }) => { child.turns[0].error = { message: "error" }; },
    ({ child }) => { child.turns.push({ ...child.turns[0] }); },
  ]) {
    const { input, options } = fixture(cliVersion);
    mutate(input);
    assert.equal(auditNativeLifecycleNoop(input, options).passed, false, String(mutate));
  }
});

test("native no-op probe rejects truncated, missing and changing raw source evidence", () => {
  for (const cliVersion of ["0.153.0", "0.153.3"]) for (const mutate of [
    (value) => { value.options.readTranscript = () => { throw new Error("unavailable /private"); }; },
    (value) => {
      const read = value.options.readTranscript;
      value.options.readTranscript = () => read().subarray(0, -1);
    },
    (value) => { value.records[0].payload.id = "other-child"; },
    (value) => { value.records.pop(); },
    (value) => {
      const read = value.options.readTranscript;
      let count = 0;
      value.options.readTranscript = () => { value.records[0].timestamp = ++count; return read(); };
    },
  ]) {
    const value = fixture(cliVersion);
    mutate(value);
    const result = auditNativeLifecycleNoop(value.input, value.options);
    assert.equal(result.passed, false, String(mutate));
    assert.equal(JSON.stringify(result).includes("/private"), false);
  }
});
