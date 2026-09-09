import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createChildCommandSchema, observeChildCommand, readChildCommands } from "../scripts/lib/child-command-journal.mjs";
import { NativeOperationEvidence } from "../scripts/lib/native-operation-evidence.mjs";

const call = (id = "exec-one", command = "node task.mjs --secret=private-value") => ({ tool_name: "Bash",
  tool_use_id: id, turn_id: "start-turn", tool_input: { command } });
function withJournal(run) {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE delegation_children(route_id TEXT PRIMARY KEY); CREATE TABLE outcomes(route_id TEXT); INSERT INTO delegation_children VALUES('route-one'),('route-two')");
    createChildCommandSchema(db);
    run(db);
  } finally { db.close(); }
}

test("command receipts are route-scoped, idempotent, and never persist command text or output", () => withJournal((db) => {
  for (const route of ["route-one", "route-two"]) {
    observeChildCommand(db, route, call()); observeChildCommand(db, route, call());
  }
  observeChildCommand(db, "route-one", { ...call(), turn_id: "poll-turn", tool_response: "private terminal output" }, { post: true });
  const ended = readChildCommands(db, "route-one");
  assert.equal(ended.length, 1); assert.equal(ended[0].terminal, true); assert.equal(ended[0].turnId, "start-turn");
  assert.equal(readChildCommands(db, "route-two")[0].terminal, false);
  assert.doesNotMatch(JSON.stringify(db.prepare("SELECT * FROM delegation_child_commands").all()), /private|node task/);
  assert.equal(observeChildCommand(db, "route-one", call()).allowed, false, "late Pre cannot reexecute the ended call");
  assert.deepEqual(readChildCommands(db, "route-one"), ended);
}));

test("a late start receipt can correlate an earlier delivered terminal without reopening it", () => withJournal((db) => {
  observeChildCommand(db, "route-one", { ...call(), turn_id: "later-turn", tool_response: "" }, { post: true });
  assert.equal(observeChildCommand(db, "route-one", call()).allowed, false);
  const [command] = readChildCommands(db, "route-one");
  assert.equal(command.started, true); assert.equal(command.terminal, true); assert.equal(command.turnId, "start-turn");
}));

test("changed command receipts remain a conflict even when later output claims completion", () => withJournal((db) => {
  observeChildCommand(db, "route-one", call());
  observeChildCommand(db, "route-one", { ...call("exec-one", "different command"), tool_response: "done" }, { post: true });
  observeChildCommand(db, "route-one", { ...call(), tool_response: "done" }, { post: true });
  const commands = readChildCommands(db, "route-one");
  assert.equal(commands[0].conflicted, true);
  assert.equal(new NativeOperationEvidence({ childId: "child", commands }).active.size, 1);
}));

test("missing Post or malformed output cannot invent terminal evidence", () => withJournal((db) => {
  observeChildCommand(db, "route-one", call());
  assert.throws(() => observeChildCommand(db, "route-one", { ...call(), tool_response: null }, { post: true }), /incomplete/);
  assert.equal(readChildCommands(db, "route-one")[0].terminal, false);
  assert.equal(observeChildCommand(db, "route-one", { tool_name: "write_stdin" }).matched, false);
}));

const commandEnd = (overrides = {}, payload = {}) => ({ type: "event_msg", payload: { type: "item_completed",
  thread_id: "child", turn_id: "start-turn", ...payload, item: { type: "CommandExecution", id: "exec-one",
    source: "unified_exec_startup", status: "completed", exit_code: 0, ...overrides } } });

const patchEnd = (overrides = {}, payload = {}) => ({ type: "event_msg", payload: { type: "item_completed",
  thread_id: "child", turn_id: "start-turn", ...payload, item: { type: "FileChange", id: "exec-one",
    changes: { "result.txt": { type: "add", content: "private patch contents" } },
    status: "completed", stdout: "private patch result", stderr: "", ...overrides } } });

for (const status of ["completed", "failed", "declined"]) {
  test(`an intercepted patch has its own ${status} terminal without a Bash Post`, () => withJournal((db) => {
    observeChildCommand(db, "route-one", call());
    const evidence = new NativeOperationEvidence({ childId: "child", commands: readChildCommands(db, "route-one") });
    const terminal = patchEnd({ status });
    evidence.observe(terminal); evidence.observe(terminal);
    assert.equal(evidence.active.size, 0);
    assert.equal(evidence.commandEnds.size, 1);
    const end = evidence.commandEnds.get("exec-one");
    assert.equal(end.source, "native_file_change");
    assert.equal(end.status, status, "termination does not imply that the patch or business task succeeded");
    assert.match(end.resultDigest, /^[a-f0-9]{64}$/u);
    assert.doesNotMatch(JSON.stringify(end), /private|result\.txt/u);
    assert.equal(readChildCommands(db, "route-one")[0].terminal, false, "do not fabricate the absent Bash Post");
  }));
}

test("an unrelated, nonterminal, incomplete or printed patch result cannot settle a command", () => withJournal((db) => {
  observeChildCommand(db, "route-one", call());
  const evidence = new NativeOperationEvidence({ childId: "child", commands: readChildCommands(db, "route-one") });
  for (const event of [patchEnd({}, { thread_id: "another-child" }), patchEnd({}, { turn_id: "another-turn" }),
    patchEnd({ id: "another-call" }), patchEnd({ status: null }), patchEnd({ changes: null }),
    patchEnd({ stdout: null }), patchEnd({ stderr: null }),
    { type: "event_msg", payload: { ...patchEnd().payload, type: "item_started" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: JSON.stringify(patchEnd()) } }]) {
    evidence.observe(event); assert.equal(evidence.active.size, 1); assert.equal(evidence.commandEnds.size, 0);
  }
  const noStart = new NativeOperationEvidence({ childId: "child", commands: [] });
  noStart.observe(patchEnd()); assert.equal(noStart.commandEnds.size, 0);
}));

test("conflicting patch receipts or a second execution kind retain the original unresolved operation", () => withJournal((db) => {
  observeChildCommand(db, "route-one", call());
  for (const conflict of [patchEnd({ status: "failed" }), patchEnd({ stdout: "changed result" }), commandEnd()]) {
    const evidence = new NativeOperationEvidence({ childId: "child", commands: readChildCommands(db, "route-one") });
    evidence.observe(patchEnd()); evidence.observe(conflict); evidence.observe(patchEnd());
    assert.equal(evidence.active.get("command:exec-one")?.state, "conflicting_receipts");
  }
}));

test("only this child's original command terminal can resolve its pending execution", () => withJournal((db) => {
  observeChildCommand(db, "route-one", call());
  const evidence = new NativeOperationEvidence({ childId: "child", commands: readChildCommands(db, "route-one") });
  for (const event of [commandEnd({}, { thread_id: "other-child" }), commandEnd({}, { turn_id: "other-turn" }),
    commandEnd({ id: "other-call" }), commandEnd({ source: "unified_exec_interaction" }),
    commandEnd({ status: "in_progress" }), commandEnd({ exit_code: null }),
    { type: "response_item", payload: { type: "message", role: "assistant", content: JSON.stringify(commandEnd()) } }]) {
    evidence.observe(event); assert.equal(evidence.active.size, 1);
  }
  evidence.observe(commandEnd({ status: "failed", exit_code: 1 }));
  assert.equal(evidence.active.size, 0, "nonzero exit proves termination, not business success");
}));

test("a natural command end clears the exact forwarded handle but not another same-turn command", () => withJournal((db) => {
  observeChildCommand(db, "route-one", call("exec-one", "node task.mjs"));
  observeChildCommand(db, "route-one", call("exec-two", "node other.mjs"));
  const evidence = new NativeOperationEvidence({ childId: "child", commands: readChildCommands(db, "route-one") });
  evidence.observe({ type: "event_msg", payload: { type: "task_started", turn_id: "start-turn" } });
  evidence.observe({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "outer",
    input: 'text(await tools.exec_command({cmd:"node task.mjs"}));' } });
  evidence.observe({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "outer", output: [
    { type: "input_text", text: "Script completed\nOutput:\n" },
    { type: "input_text", text: JSON.stringify({ session_id: 42, wall_time_seconds: 1, output: "still running" }) },
  ] } });
  assert.equal(evidence.active.size, 3);
  evidence.observe(commandEnd({ process_id: "42" }));
  assert.deepEqual([...evidence.active.keys()], ["command:exec-two"]);
}));

for (const transport of ["direct", "code_mode"]) {
  test(`a delayed ${transport} running result cannot reopen an already ended native command`, () => withJournal((db) => {
    observeChildCommand(db, "route-one", call("exec-one", "node task.mjs"));
    const evidence = new NativeOperationEvidence({ childId: "child", commands: readChildCommands(db, "route-one") });
    evidence.observe({ type: "event_msg", payload: { type: "task_started", turn_id: "start-turn" } });
    const forwarded = transport === "code_mode";
    const id = forwarded ? "outer" : "exec-one";
    evidence.observe({ type: "response_item", payload: forwarded
      ? { type: "custom_tool_call", name: "exec", call_id: id, input: 'text(await tools.exec_command({cmd:"node task.mjs"}));' }
      : { type: "function_call", name: "exec_command", call_id: id, arguments: '{"cmd":"node task.mjs"}' } });
    evidence.observe(commandEnd({ process_id: "42" }));
    evidence.observe({ type: "response_item", payload: forwarded
      ? { type: "custom_tool_call_output", call_id: id, output: [
        { type: "input_text", text: "Script completed\nOutput:\n" },
        { type: "input_text", text: JSON.stringify({ session_id: 42, wall_time_seconds: 1, output: "still running" }) },
      ] }
      : { type: "function_call_output", call_id: id,
        output: "Chunk ID: yielded\nWall time: 1 second\nProcess running with session ID 42\nOutput:\nstill running" } });
    assert.equal(evidence.unanswered.size, 0);
    assert.equal(evidence.active.size, 0, "a stale running envelope does not supersede the exact native terminal");
  }));
}

test("a legacy child without a Hook command journal retains a real native start behind arbitrary code-mode output", () => {
  const evidence = new NativeOperationEvidence({ childId: "child", commands: [] });
  evidence.observe({ type: "event_msg", payload: { type: "task_started", turn_id: "start-turn" } });
  evidence.observe({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "outer",
    input: 'text(await tools.exec_command({cmd:"node task.mjs"})); text("extra");' } });
  const start = { type: "event_msg", payload: { ...commandEnd({ process_id: "42" }).payload,
    type: "item_started", item: { type: "CommandExecution", id: "exec-one", source: "unified_exec_startup",
      process_id: "42", status: "in_progress", exit_code: null } } };
  evidence.observe(start);
  evidence.observe({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "outer", output: [
    { type: "input_text", text: "Script completed\nOutput:\n" },
    { type: "input_text", text: JSON.stringify({ session_id: 42, wall_time_seconds: 1, output: "still running" }) },
    { type: "input_text", text: "extra" },
  ] } });
  assert.equal(evidence.unanswered.size, 0);
  assert.ok(evidence.active.size > 0, "the historical native start cannot disappear because no new Hook ledger exists");
  evidence.observe(commandEnd({ process_id: "42" }));
  assert.equal(evidence.active.has("command:exec-one"), false, "the exact native command is finished");
  assert.equal(evidence.active.get("unknown:outer")?.state, "execution_coverage_unknown",
    "one inner terminal cannot prove that arbitrary legacy code did not start additional work");
});

test("a later call may reuse the same command and handle after an earlier command ended", () => withJournal((db) => {
  observeChildCommand(db, "route-one", call("exec-one", "node task.mjs"));
  const evidence = new NativeOperationEvidence({ childId: "child", commands: readChildCommands(db, "route-one") });
  evidence.observe({ type: "event_msg", payload: { type: "task_started", turn_id: "start-turn" } });
  evidence.observe(commandEnd({ process_id: "42" }));
  evidence.observe({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "later-outer",
    input: 'text(await tools.exec_command({cmd:"node task.mjs"}));' } });
  evidence.observe({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "later-outer", output: [
    { type: "input_text", text: "Script completed\nOutput:\n" },
    { type: "input_text", text: '{"session_id":42,"wall_time_seconds":1,"output":"new work"}' },
  ] } });
  assert.equal(evidence.active.get("process:42")?.callId, "later-outer");
}));

const directCall = (id, name, args) => ({ type: "response_item", payload: {
  type: "function_call", name, call_id: id, arguments: JSON.stringify(args) } });
const directResult = (id, running) => ({ type: "response_item", payload: { type: "function_call_output", call_id: id,
  output: `Chunk ID: receipt\n${running ? "Process running with session ID 42" : "Process exited with code 0"}\nOutput:\nresult` } });
const wrappedCall = (id, name, args) => ({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: id,
  input: `text(await tools.${name}(${JSON.stringify(args)}));` } });
const wrappedResult = (id, running) => ({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output: [
  { type: "input_text", text: "Script completed\nOutput:\n" },
  { type: "input_text", text: JSON.stringify({ ...(running ? { session_id: 42 } : { exit_code: 0 }), wall_time_seconds: 1, output: "result" }) },
] } });

for (const wrapped of [false, true]) test(`a delayed ${wrapped ? "wrapped" : "direct"} poll terminal cannot clear a reused handle`, () => {
  const evidence = new NativeOperationEvidence({ childId: "child" });
  const pollCall = wrapped ? wrappedCall : directCall, pollResult = wrapped ? wrappedResult : directResult;
  evidence.observe({ type: "event_msg", payload: { type: "task_started", turn_id: "start-turn" } });
  evidence.observe(directCall("exec-one", "exec_command", { cmd: "A" })); evidence.observe(directResult("exec-one", true));
  evidence.observe(pollCall("poll-A", "write_stdin", { session_id: 42 }));
  evidence.observe(commandEnd({ process_id: "42" }));
  evidence.observe(directCall("exec-B", "exec_command", { cmd: "B" })); evidence.observe(directResult("exec-B", true));
  evidence.observe(pollResult("poll-A", false));
  assert.equal(evidence.active.get("process:42")?.callId, "exec-B");
  assert.equal(evidence.unanswered.size, 0);
});

for (const wrapped of [false, true]) test(`a delayed ${wrapped ? "wrapped" : "direct"} poll running result binds the sole opaque command across turns`, () => withJournal((db) => {
  observeChildCommand(db, "route-one", call("exec-one", "opaque A"));
  const evidence = new NativeOperationEvidence({ childId: "child", commands: readChildCommands(db, "route-one") });
  evidence.observe({ type: "event_msg", payload: { type: "task_started", turn_id: "start-turn" } });
  evidence.observe({ type: "event_msg", payload: { type: "task_started", turn_id: "poll-turn" } });
  evidence.observe((wrapped ? wrappedCall : directCall)("poll-A", "write_stdin", { session_id: 42 }));
  evidence.observe(commandEnd({ process_id: "42" }));
  evidence.observe((wrapped ? wrappedResult : directResult)("poll-A", true));
  assert.equal(evidence.active.size, 0);
  assert.equal(evidence.unanswered.size, 0);
}));

for (const currentPost of [false, true]) test(`a completed old command without a native end cannot block orphan poll closure (current Post=${currentPost})`, () => {
  const command = (callId, turnId, terminal) => ({ callId, turnId, commandDigest: callId,
    started: true, terminal, conflicted: false });
  const evidence = new NativeOperationEvidence({ childId: "child", commands: [
    command("old", "old-turn", true), command("exec-one", "start-turn", currentPost),
  ] });
  for (const turn_id of ["old-turn", "start-turn", "poll-turn"]) evidence.observe({ type: "event_msg", payload: { type: "task_started", turn_id } });
  evidence.observe(directCall("poll-A", "write_stdin", { session_id: 42 }));
  evidence.observe(commandEnd({ process_id: "42" }));
  evidence.observe(directResult("poll-A", true));
  assert.equal(evidence.active.size, 0);
});
