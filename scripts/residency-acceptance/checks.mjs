import assert from "node:assert/strict";
import { readStableRollout } from "../../plugins/adaptive-model-router/scripts/lib/native-rollout-reader.mjs";
import { forwardedToolCall } from "../../plugins/adaptive-model-router/scripts/lib/code-mode-tool-evidence.mjs";

export function ledger(text, records) {
  const expected = { ids: records.map((record) => record.id).sort(), sum: records.reduce((sum, record) => sum + record.value, 0), count: records.length };
  const actual = JSON.parse(text);
  assert.deepEqual(actual, expected, "the final result must retain every current record exactly once");
  return expected;
}

export function collection(text, marker) {
  const actual = JSON.parse(text);
  assert.equal(actual.marker, marker);
  assert.ok(Array.isArray(actual.requirements) && actual.requirements.length > 0, "collection must preserve the original requirements");
  assert.equal(typeof actual.partialResult, "string");
  assert.ok(actual.partialResult.length > 0);
  assert.deepEqual(actual.pendingOperations, [], "an unverified operation cannot disappear behind maintenance completion");
  return actual;
}

export function dispositions(closure, intent, source, review, disposition = "fulfilled") {
  return { intent, basis: source, resultReview: review, pendingOperations: [],
    requirements: closure.inputReferences.slice(1).map(({ id }) => ({ messageId: id, source,
      disposition, receipt: review, owner: "/root" })) };
}

export function hasNativeGuardDenial(path, afterLine = 0, expectedCommand) {
  if (typeof expectedCommand !== "string" || !expectedCommand) return false;
  const calls = new Map();
  const prefix = "Command blocked by PreToolUse hook: This Router child is in collection, cancellation, deferral or finalized state";
  let denied = false;
  readStableRollout(path, (entry, line) => {
    if (line <= afterLine) return;
    const item = entry.payload;
    if (entry.type !== "response_item") return;
    if (item?.type === "function_call" && item.name === "exec_command") {
      try {
        if (JSON.parse(item.arguments).cmd === expectedCommand) calls.set(item.call_id, "function_call_output");
      } catch { /* Missing or malformed arguments do not attest the test command. */ }
    } else if (item?.type === "custom_tool_call" && item.name === "exec") {
      const call = forwardedToolCall(item.input);
      if (call?.name === "exec_command" && call.args.cmd === expectedCommand) calls.set(item.call_id, "custom_tool_call_output");
    } else if (calls.get(item?.call_id) === item?.type) {
      if (item.type === "function_call_output") {
        denied ||= typeof item.output === "string" && item.output.startsWith(prefix);
      } else {
        try {
          const blocks = typeof item.output === "string" ? JSON.parse(item.output) : item.output;
          // A failed native code-mode call has a runtime header and an error.
          // Printed JSON or successful shell stdout cannot substitute for it.
          denied ||= Array.isArray(blocks) && blocks.length === 2
            && blocks.every((part) => part.type === "input_text" && typeof part.text === "string")
            && blocks[0].text.startsWith("Script failed\n")
            && blocks[1].text.startsWith(`Script error:\n${prefix}`);
        } catch { /* An opaque output remains unverified. */ }
      }
    }
  });
  return denied;
}
