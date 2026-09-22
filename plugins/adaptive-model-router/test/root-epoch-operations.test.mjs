import test from "node:test";
import assert from "node:assert/strict";
import { RootEpochOperations } from "../scripts/lib/root-epoch-operations.mjs";
import { NativeOperationEvidence } from "../scripts/lib/native-operation-evidence.mjs";

const call = (id, name, input) => ({ type: "response_item", payload: { type: "custom_tool_call", namespace: "functions", name,
  call_id: id, ...(name === "exec" ? { input } : { arguments: JSON.stringify(input) }) } });
const result = (id, header, ...blocks) => ({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: id,
  output: [{ type: "input_text", text: header }, ...blocks.map((x) => ({ type: "input_text", text: JSON.stringify(x) }))] } });
const terminal = (overrides = {}) => ({ type: "event_msg", payload: { type: "item_completed", thread_id: "root", turn_id: "turn",
  item: { type: "CommandExecution", source: "unified_exec_startup", id: "exec-native", process_id: "27",
    command: ["/bin/zsh", "-lc", "some command"], status: "failed", exit_code: 2 }, ...overrides } });
function replay(entries) {
  const native = new NativeOperationEvidence({ childId: "root" }), epoch = new RootEpochOperations("root");
  for (const entry of [{ type: "event_msg", payload: { type: "task_started", turn_id: "turn" } }, ...entries]) {
    native.observe(entry); epoch.observe(entry, native);
  }
  return { native, retained: epoch.reconcile(native) };
}

const cuaCall = { type: "response_item", payload: { type: "function_call", namespace: "mcp__cua_repl", name: "js", call_id: "cua", arguments: JSON.stringify({ code: "await page.click()" }) } };
const cuaResult = { type: "response_item", payload: { type: "function_call_output", call_id: "cua", output: "opaque tool response" } };
const cuaTerminal = { type: "event_msg", payload: { type: "item_completed", thread_id: "root", turn_id: "turn",
  item: { type: "McpToolCall", id: "cua", server: "cua_repl", tool: "js", arguments: { code: "await page.click()" },
    status: "completed", result: { content: [], isError: false, _meta: { "codex/nodeReplExecutionDurationMs": 10 } } } } };
test("root CUA calls require an exact native terminal and retain their unverified external business", () => {
  assert.ok(replay([cuaCall, cuaResult]).native.active.size);
  const done = replay([cuaCall, cuaTerminal, cuaResult]);
  assert.equal(done.native.active.size, 0);
  assert.equal(done.retained.length, 1);
  assert.equal(done.retained[0].businessState, "unverified_preserved");
  for (const patch of [{ thread_id: "other" }, { turn_id: "other" }, { item: { ...cuaTerminal.payload.item, id: "other" } },
    { item: { ...cuaTerminal.payload.item, status: "in_progress" } },
    { item: { ...cuaTerminal.payload.item, arguments: { code: "other" } } },
    { item: { ...cuaTerminal.payload.item, result: { content: [], isError: false } } }])
    assert.ok(replay([cuaCall, { ...cuaTerminal, payload: { ...cuaTerminal.payload, ...patch } }, cuaResult]).native.active.size);
  assert.ok(replay([cuaCall, cuaTerminal]).native.unanswered.size);
});

test("epoch retains opaque root business while a native terminal proves only its code interpreter returned", () => {
  for (const status of ["completed", "failed", "terminated"]) {
    const { native, retained } = replay([call("opaque", "exec", "await tools.external_action({})"), result("opaque", `Script ${status}`)]);
    assert.equal(native.active.size, 0); assert.equal(native.unanswered.size, 0);
    assert.equal(retained.length, 1); assert.equal(retained[0].interpreterState, status);
    assert.equal(retained[0].businessState, "unverified_preserved");
    // NativeOperationEvidence and child closure continue to reject unknown work.
    const child = new NativeOperationEvidence({ childId: "root" });
    child.observe(call("opaque", "exec", "await tools.external_action({})")); child.observe(result("opaque", `Script ${status}`));
    assert.equal(child.active.size, 1);
  }
});

test("epoch cannot replace a missing native result or running cell with text printed by an inner tool", () => {
  assert.equal(replay([call("missing", "exec", "anything")]).native.unanswered.size, 1);
  const x = replay([call("running", "exec", "anything"), result("running", "Script running with cell ID cell", "Script completed")]);
  assert.ok(x.native.active.has("cell:cell")); assert.equal(x.retained.length, 0);
  const ended = replay([call("running", "exec", "anything"), result("running", "Script running with cell ID cell"),
    call("poll", "wait", { cell_id: "cell" }), result("poll", "Script failed")]);
  assert.equal(ended.native.active.size, 0);
});

const started = () => [call("launch", "exec", 'text(await tools.exec_command({cmd:"some command"}));'),
  result("launch", "Script completed", { output: "", wall_time_seconds: 1, session_id: 27 })];
test("exact legacy native terminal completes its root process without requiring a later Hook ledger", () => {
  const x = replay([...started(), terminal()]);
  assert.equal(x.native.active.size, 0); assert.equal(x.retained.length, 1);
  assert.equal(x.retained[0].exitCode, 2); assert.equal(x.retained[0].businessState, "unverified_preserved");
});

test("changed identity, handle, command, nonterminal receipt, or reused process ownership cannot close root work", () => {
  for (const patch of [{ thread_id: "other" }, { turn_id: "other" }, { item: { ...terminal().payload.item, process_id: "28" } },
    { item: { ...terminal().payload.item, command: ["/bin/zsh", "-lc", "other command"] } },
    { item: { ...terminal().payload.item, status: "in_progress", exit_code: null } }])
    assert.ok(replay([...started(), terminal(patch)]).native.active.has("process:27"));
  assert.ok(replay([terminal(), ...started()]).native.active.has("process:27"));
  assert.ok(replay([...started(), ...started().map((entry) => ({ ...entry, payload: { ...entry.payload, call_id: "launch2" } })), terminal()])
    .native.active.has("process:27"));
});

test("a completed code cell polling a legacy handle needs the unique later native process terminal", () => {
  const entries = [call("poll", "exec", 'text(await tools.write_stdin({session_id:27,chars:""}));'),
    result("poll", "Script running with cell ID waiting"),
    call("wait", "wait", { cell_id: "waiting" }),
    result("wait", "Script completed", { output: "", wall_time_seconds: 1, session_id: 27 })];
  assert.ok(replay(entries).native.active.has("process:27"));
  assert.equal(replay([...entries, terminal()]).native.active.size, 0);
  assert.ok(replay([terminal(), ...entries]).native.active.has("process:27"));
  assert.ok(replay([...entries, terminal(), terminal({ item: { ...terminal().payload.item, id: "other" } })]).native.active.has("process:27"));
});
