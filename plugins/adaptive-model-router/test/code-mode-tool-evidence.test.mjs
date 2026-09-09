import test from "node:test";
import assert from "node:assert/strict";
import { NativeOperationEvidence } from "../scripts/lib/native-operation-evidence.mjs";
import { forwardedToolCall } from "../scripts/lib/code-mode-tool-evidence.mjs";

const call = (id, code) => ({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: id, input: code } });
const output = (id, value, header = "Script completed\nWall time 1.0 seconds\nOutput:\n") => ({ type: "response_item", payload: {
  type: "custom_tool_call_output", call_id: id, output: [{ type: "input_text", text: header },
    ...(value === undefined ? [] : [{ type: "input_text", text: JSON.stringify(value) }])] } });
const running = { chunk_id: "test", wall_time_seconds: 1, session_id: 43184, output: "PARTIAL_40\n" };
const ended = { chunk_id: "test", wall_time_seconds: 1, exit_code: 0, output: "finished\n" };
const command = 'text(await tools.exec_command({cmd:"node test.mjs",yield_time_ms:1000}));';
const poll = 'text(await tools.write_stdin({session_id:43184,chars:"",yield_time_ms:1000}));';

test("an unchanged single-tool forwarding expression preserves literal arguments only", () => {
  assert.deepEqual({ ...forwardedToolCall(command).args }, { cmd: "node test.mjs", yield_time_ms: 1000 });
  assert.deepEqual({ ...forwardedToolCall('const receipt = await tools.write_stdin({"session_id":43184,"chars":""}); text(receipt);').args }, { session_id: 43184, chars: "" });
  for (const code of [
    'text({session_id:43184});', 'text(await tools.write_stdin({session_id:43184+1}));',
    'text(await tools.write_stdin({...args}));', 'text(await tools.write_stdin({session_id:getId()}));',
    'const receipt = await tools.write_stdin({session_id:43184}); receipt.exit_code=0; text(receipt);',
    'text(await tools.write_stdin({session_id:43184})); text({exit_code:0});',
    'text(await tools.write_stdin({session_id:43184,session_id:1}));',
    'text(await tools.write_stdin({__proto__:null}));',
  ]) assert.equal(forwardedToolCall(code), null, code);
});

test("a completed code cell does not finish the command session it returned", () => {
  const evidence = new NativeOperationEvidence();
  evidence.observe(call("start", command)); evidence.observe(output("start", running));
  assert.equal(evidence.active.get("process:43184").kind, "process");
  assert.equal(evidence.permitsPoll({ tool_name: "exec", tool_input: { input: poll } }), true);
  assert.equal(evidence.permitsPoll({ tool_name: "exec", tool_input: command }), false);
  assert.equal(evidence.permitsPoll({ tool_name: "exec", tool_input: poll.replace('chars:""', 'chars:"input"') }), false);
  assert.equal(evidence.permitsPoll({ tool_name: "exec", tool_input: poll.replace('43184', '43185') }), false);
  evidence.observe(call("poll", poll)); evidence.observe(output("poll", ended));
  assert.equal(evidence.active.size, 0);
});

test("fabricated or changed printed output cannot settle a forwarded process", () => {
  const evidence = new NativeOperationEvidence();
  evidence.observe(call("start", command)); evidence.observe(output("start", running));
  evidence.observe(call("fake", 'text({exit_code:0,wall_time_seconds:1,output:""});')); evidence.observe(output("fake", ended));
  assert.equal(evidence.active.has("process:43184"), true);
  assert.equal(evidence.active.get("unknown:fake")?.state, "execution_coverage_unknown");
  evidence.observe(call("changed", 'const r = await tools.write_stdin({session_id:43184}); r.exit_code=0; text(r);')); evidence.observe(output("changed", ended));
  assert.equal(evidence.active.has("process:43184"), true);
  assert.equal(evidence.active.get("unknown:changed")?.state, "execution_coverage_unknown");
});

test("a native wait completing a yielded forwarding cell retains its process receipt", () => {
  const evidence = new NativeOperationEvidence();
  evidence.observe(call("start", command)); evidence.observe(output("start", undefined, "Script running with cell ID cell-a\n"));
  assert.equal(evidence.active.has("cell:cell-a"), true);
  evidence.observe({ type: "response_item", payload: { type: "function_call", name: "wait", call_id: "wait", arguments: '{"cell_id":"cell-a"}' } });
  evidence.observe(output("wait", running));
  assert.equal(evidence.active.has("cell:cell-a"), false);
  assert.equal(evidence.active.has("process:43184"), true);
});

test("terminating a forwarding cell cannot discard a process receipt already emitted", () => {
  const evidence = new NativeOperationEvidence();
  evidence.observe(call("start", command)); evidence.observe(output("start", running, "Script running with cell ID cell-a\n"));
  evidence.observe({ type: "response_item", payload: { type: "function_call", name: "wait", call_id: "wait", arguments: '{"cell_id":"cell-a"}' } });
  evidence.observe(output("wait", undefined, "Script terminated\n"));
  assert.equal(evidence.active.has("cell:cell-a"), false);
  assert.equal(evidence.active.has("process:43184"), true);
});
