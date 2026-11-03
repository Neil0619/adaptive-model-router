import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookTaskCwd, readThreadSpawnIdentity } from "../scripts/lib/subagent-session.mjs";

test("command directory never replaces immutable child identity or lifecycle cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "router-command-cwd-"));
  try {
    const cwd = join(root, "task"), workdir = join(root, "command");
    mkdirSync(cwd); mkdirSync(workdir);
    const transcript_path = join(root, "child.jsonl"), agent_path = "/root/router_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const meta = { id: "child", session_id: "parent", parent_thread_id: "parent", cwd, agent_path,
      source: { subagent: { thread_spawn: { parent_thread_id: "parent", depth: 1, agent_path } } } };
    const save = (payload) => writeFileSync(transcript_path, JSON.stringify({ type: "session_meta", payload }) + "\n");
    save(meta);
    const input = { session_id: "parent", agent_id: "child", transcript_path, cwd: workdir,
      hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "pwd" } };
    for (const hook_event_name of ["PreToolUse", "PostToolUse"]) {
      assert.equal(readThreadSpawnIdentity({ ...input, hook_event_name })?.childId, "child");
      assert.equal(hookTaskCwd({ ...input, hook_event_name }), cwd);
    }
    for (const changed of [{ session_id: "other-parent" }, { agent_id: "other-child" },
      { tool_name: "exec_command" }, { tool_input: {} }, { hook_event_name: "SubagentStart" }, { hook_event_name: "Stop" }]) {
      assert.equal(readThreadSpawnIdentity({ ...input, ...changed }), null);
    }
    for (const changed of [{ parent_thread_id: "other-parent" }, { session_id: "other-parent" },
      { agent_path: "/root/other" }, { source: { subagent: { thread_spawn: { parent_thread_id: "parent", depth: 2, agent_path } } } }]) {
      save({ ...meta, ...changed });
      assert.equal(readThreadSpawnIdentity(input), null);
      assert.throws(() => hookTaskCwd(input), /identity/);
    }
    save({ ...meta, cwd: null });
    assert.throws(() => hookTaskCwd(input), /identity/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("root command cwd is derived only from its own native root metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "router-root-cwd-"));
  try {
    const transcript_path = join(root, "root.jsonl");
    const input = { session_id: "root", transcript_path, cwd: tmpdir(), hook_event_name: "PreToolUse",
      tool_name: "Bash", tool_input: { command: "pwd" } };
    const save = (payload) => writeFileSync(transcript_path, JSON.stringify({ type: "session_meta", payload }) + "\n");
    save({ id: "root", cwd: root });
    assert.equal(hookTaskCwd(input), root);
    for (const payload of [{ id: "other", cwd: root }, { id: "root", cwd: root, parent_thread_id: "parent" },
      { id: "root", cwd: root, source: { subagent: {} } }, { id: "root", cwd: null }]) {
      save(payload); assert.throws(() => hookTaskCwd(input), /identity/);
    }
    // Other host event contracts are deliberately not reinterpreted.
    assert.equal(hookTaskCwd({ ...input, tool_name: "other" }), tmpdir());
    assert.throws(() => hookTaskCwd({ ...input, transcript_path: undefined }), /identity/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
