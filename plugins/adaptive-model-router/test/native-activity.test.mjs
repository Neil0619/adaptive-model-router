import test from "node:test";
import assert from "node:assert/strict";
import { NativeActivity } from "../scripts/lib/native-activity.mjs";
const old = "2026-09-01T01:00:00Z", recent = "2026-09-11T01:00:00Z";
const event = (type, turn, timestamp = recent, extra = {}) => ({ timestamp, type: "event_msg", payload: { type, turn_id: turn, ...extra } });
function activity(tail, options) {
  const tracker = new NativeActivity(options);
  [event("task_started", "original", old), event("task_complete", "original", old),
    event("task_started", "inspection"), ...tail, event("task_complete", "inspection")].forEach((e) => tracker.observe(e));
  return tracker.result();
}
const mcp = (tool, server = "adaptive_model_router") => event("item_completed", "inspection", recent, { item: { type: "McpToolCall", server, tool } });
test("inspection-only native turns and code-mode wrappers do not refresh business age", () => {
  for (const tool of ["get_route_status", "get_route_history", "diagnose_router", "manage_stage", "record_outcome"]) {
    assert.equal(activity([mcp(tool)]), Date.parse(old));
    assert.equal(activity([{ timestamp: recent, type: "response_item", payload: { type: "custom_tool_call", namespace: "functions", name: "exec", input: "opaque wrapper" } }, mcp(tool)]), Date.parse(old));
  }
});
test("business tools, mixed turns and unclassified no-tool work still refresh age", () => {
  for (const tail of [[], [mcp("route_stage")], [mcp("get_route_status"), mcp("write", "external")],
    [mcp("get_route_status"), event("item_completed", "inspection", recent, { item: { type: "CommandExecution" } })]]) {
    assert.equal(activity(tail), Date.parse(recent));
  }
});
test("trusted maintenance input does not refresh age, but actual new tools do", () => {
  const input = { timestamp: recent, type: "response_item", payload: { type: "agent_message" } };
  assert.equal(activity([input], { maintenanceInputOffset: 0 }), Date.parse(old));
  assert.equal(activity([input, mcp("write", "external")], { maintenanceInputOffset: 0 }), Date.parse(recent));
});
