import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { auditNativeLifecycle1534Transcript } from "../scripts/lib/native-recovery-audit.mjs";
import { auditNativeUnconsumed1534Transcript, isMetadataRecoveryAudit } from "../scripts/lib/native-metadata-recovery-audit.mjs";

function fixture() {
  const child = { id: "child", cliVersion: "0.153.4", model: "gpt-6-astra", reasoningEffort: "low",
    turns: [{ id: "turn", items: [{ type: "agentMessage", id: "final", phase: "final_answer", text: "Stopped." }] }] };
  const call = { type: "custom_tool_call", status: "completed", name: "exec", call_id: "lookup",
    input: 'text(ALL_TOOLS.filter(x=>/context|route|stage|status/.test(x.name)&&/router|adaptive/i.test(x.name+" "+x.description)));\n' };
  const output = { type: "custom_tool_call_output", call_id: "lookup", output: [
    { type: "input_text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n" },
    { type: "input_text", text: JSON.stringify([{ name: "mcp__adaptive_model_router__get_route_status", description: "Tool metadata." }]) },
  ] };
  const records = [
    { type: "session_meta", payload: { id: "child", parent_thread_id: "parent", cli_version: "0.153.4" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
    { type: "turn_context", payload: { turn_id: "turn", model: child.model, effort: child.reasoningEffort } },
    { type: "response_item", payload: call }, { type: "response_item", payload: output },
    { type: "response_item", payload: { type: "message", id: "final", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Stopped." }] } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "turn" } },
  ];
  return { child, call, output, records, bytes: () => Buffer.from(records.map(JSON.stringify).join("\n") + "\n") };
}

test("the exact pure metadata query can close a failed dispatch but never qualifies as a no-tool child", () => {
  const f = fixture(), bytes = f.bytes();
  assert.throws(() => auditNativeLifecycle1534Transcript(bytes, f.child, "parent"));
  const audit = auditNativeUnconsumed1534Transcript(bytes, f.child, "parent");
  assert.equal(audit.rawAuditAdapter, "codex-0.153.4-tool-metadata-only/1");
  assert.equal(audit.rawAuditDigest, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(audit.sourceBytes, bytes.length);
  assert.equal(isMetadataRecoveryAudit({ ...audit, cliVersion: "0.153.4" }), true);
  for (const change of [{ metadataOnlyCalls: 2 }, { metadataQueryDigest: "0".repeat(64) }, { cliVersion: "0.153.3" }]) {
    assert.equal(isMetadataRecoveryAudit({ ...audit, cliVersion: "0.153.4", ...change }), false);
  }
});

test("metadata recovery rejects extra work, unknown code, incomplete results, and cross-build evidence", () => {
  for (const mutate of [
    (f) => { f.call.input += "await tools.exec_command({cmd:'true'});"; },
    (f) => { f.call.input = "text(ALL_TOOLS);"; },
    (f) => { f.call.namespace = "unexpected"; },
    (f) => { f.call.status = "in_progress"; },
    (f) => { f.output.call_id = "different"; },
    (f) => { f.output.output[0].text = "Script failed"; },
    (f) => { f.output.output[1].text = "{}"; },
    (f) => { f.output.output.push({ type: "input_text", text: "unexplained output" }); },
    (f) => { f.records.splice(4, 1); },
    (f) => { f.records.splice(3, 0, ...structuredClone(f.records.slice(3, 5))); },
    (f) => { f.records.splice(3, 0, { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "hidden" } }); },
    (f) => { f.records.splice(3, 0, { type: "response_item", payload: { type: "future_action" } }); },
    (f) => { f.child.cliVersion = f.records[0].payload.cli_version = "0.153.3"; },
    (f) => { f.records.at(-1).payload.turn_id = "different"; },
  ]) {
    const f = fixture(); mutate(f);
    assert.throws(() => auditNativeUnconsumed1534Transcript(f.bytes(), f.child, "parent"));
  }
});
