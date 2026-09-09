import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledger, collection, hasNativeGuardDenial } from "./checks.mjs";

test("delivery rejects lost original records, duplicates and incorrect totals", () => {
  const records = [{ id: "a", value: 17 }, { id: "b", value: 23 }, { id: "c", value: 42 }];
  assert.deepEqual(ledger('{"ids":["a","b","c"],"sum":82,"count":3}', records).ids, ["a", "b", "c"]);
  for (const value of ['{"ids":["c"],"sum":42,"count":1}', '{"ids":["a","a","c"],"sum":76,"count":3}', '{"ids":["a","b","c"],"sum":83,"count":3}']) {
    assert.throws(() => ledger(value, records));
  }
});

test("collection cannot hide missing requirements, partial results or pending operations", () => {
  const value = { marker: "same-stage", requirements: ["original"], partialResult: "known result", pendingOperations: [] };
  assert.deepEqual(collection(JSON.stringify(value), "same-stage"), value);
  for (const change of [{ marker: "another-stage" }, { requirements: [] }, { partialResult: "" }, { pendingOperations: ["still running"] }]) {
    assert.throws(() => collection(JSON.stringify({ ...value, ...change }), "same-stage"));
  }
});

test("guard verification requires a correlated native tool result after the maintenance boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "residency-guard-check-"));
  const path = join(root, "child.jsonl");
  const command = "printf canary > /tmp/residency-test-canary";
  const denied = "Command blocked by PreToolUse hook: This Router child is in collection, cancellation, deferral or finalized state";
  const save = (records) => writeFileSync(path, records.map((payload) => JSON.stringify({ type: "response_item", payload })).join("\n") + "\n");
  try {
    save([{ type: "message", role: "assistant", content: denied }]);
    assert.equal(hasNativeGuardDenial(path, 0, command), false);
    save([{ type: "function_call_output", call_id: "unrelated", output: denied }]);
    assert.equal(hasNativeGuardDenial(path, 0, command), false);
    save([{ type: "function_call", call_id: "actual", name: "exec_command", arguments: JSON.stringify({ cmd: command }) }, { type: "function_call_output", call_id: "actual", output: denied }]);
    assert.equal(hasNativeGuardDenial(path, 0, command), true);
    assert.equal(hasNativeGuardDenial(path, 2, command), false);
    assert.equal(hasNativeGuardDenial(path, 0, "different command"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("code-mode guard evidence rejects printed denial text and a different command", () => {
  const root = mkdtempSync(join(tmpdir(), "residency-code-guard-check-"));
  const path = join(root, "child.jsonl");
  const command = "printf canary > /tmp/residency-test-canary";
  const reason = "Command blocked by PreToolUse hook: This Router child is in collection, cancellation, deferral or finalized state";
  const nativeError = JSON.stringify([
    { type: "input_text", text: "Script failed\nWall time 0.1 seconds\nOutput:\n" },
    { type: "input_text", text: `Script error:\n${reason}` },
  ]);
  const save = (input, output = nativeError) => writeFileSync(path, [
    { type: "custom_tool_call", name: "exec", call_id: "actual", input },
    { type: "custom_tool_call_output", call_id: "actual", output },
  ].map((payload) => JSON.stringify({ type: "response_item", payload })).join("\n") + "\n");
  try {
    save(`text(${JSON.stringify(reason)});`);
    assert.equal(hasNativeGuardDenial(path, 0, command), false, "printing a refusal is not a command refusal");
    save(`text(await tools.exec_command(${JSON.stringify({ cmd: "printf unrelated" })}));`);
    assert.equal(hasNativeGuardDenial(path, 0, command), false, "the exact canary command must be attempted");
    const canonical = `text(await tools.exec_command(${JSON.stringify({ cmd: command })}));`;
    save(canonical, JSON.stringify([{ type: "input_text", text: JSON.stringify({ output: reason, exit_code: 0, wall_time_seconds: 0.1 }) }]));
    assert.equal(hasNativeGuardDenial(path, 0, command), false, "successful shell output is not a native guard error");
    save(canonical);
    assert.equal(hasNativeGuardDenial(path, 0, command), true);
    assert.equal(hasNativeGuardDenial(path), false, "the verifier requires the intended command");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
