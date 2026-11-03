import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { RouterStore } from "../scripts/lib/database.mjs";
import { inspectRootOperationCoverage, observeRootOperationCoverage, rootCoverageKey } from "../scripts/lib/runtime-root-operations.mjs";
import { inspectRuntimeBoundary } from "../scripts/lib/runtime-boundary.mjs";
import { temporaryProject, withRouterEnvironment } from "./fixtures.mjs";

const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;

async function fixture(run) {
  const project = await temporaryProject("root-coverage-order-");
  try { await withRouterEnvironment(project, async () => {
    const store = new RouterStore();
    try {
      const context = store.context({ cwd: project.root, contextId: "root" });
      const records = [
        { timestamp: "2026-09-30T00:00:00Z", ordinal: 0, type: "session_meta", payload: {
          session_id: "root", id: "root", timestamp: "2026-09-30T00:00:00Z", cwd: project.root,
          runtime_workspace_roots: [project.root], originator: "codex", cli_version: "native",
          source: "vscode", thread_source: "codex", model_provider: "openai",
          base_instructions: { text: "unchanged instructions", provenance: { type: "model", model: "original-model" } },
          history_mode: "full", context_window: { window_id: "original-window" },
          git: { commit_hash: "commit", branch: "branch", repository_url: "repository" },
        } },
        { type: "event_msg", payload: { type: "task_started", turn_id: "old" } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "keep this" }] } },
        { type: "event_msg", payload: { type: "task_complete", turn_id: "old" } },
      ];
      const path = join(project.root, "root.jsonl");
      const write = () => writeFileSync(path, records.map(JSON.stringify).join("\n") + "\n");
      write();
      const input = { hook_event_name: "UserPromptSubmit", session_id: "root", turn_id: "new", transcript_path: path };
      const proof = inspectRootOperationCoverage(store.db, context, input, { deadline: Date.now() + 5000 });
      assert.ok(proof);
      observeRootOperationCoverage(store.db, context, input, proof);
      const saved = () => store.db.prepare("SELECT value FROM meta WHERE key=?").get(rootCoverageKey(context)).value;
      const original = saved();
      const boundary = () => inspectRuntimeBoundary(input, "old", { db: store.db, context, deadline: Date.now() + 5000 });
      assert.ok(boundary());
      await run({ records, write, boundary, saved, original });
      assert.equal(saved(), original, "verification must never replace the original coverage hash");
    } finally { store.close(); }
  }); } finally { await project.cleanup(); }
}

test("native metadata reserialization preserves a boundary only by matching the original full prefix hash", async () => {
  await fixture(f => {
    f.records[0] = sorted(f.records[0]); f.write();
    assert.ok(f.boundary(), "same native metadata values in sorted member order must match their original serialization");
  });
});

test("metadata values, later prefix records, and uncompleted operations cannot inherit reordered coverage", async () => {
  for (const change of [
    f => { f.records[0].payload.id = "other"; },
    f => { f.records[0].payload.base_instructions.text = "changed"; },
    f => { f.records[0].payload.base_instructions.provenance.model = "other-model"; },
    f => { f.records[0].payload.runtime_workspace_roots.push("other"); },
    f => { f.records[0].payload.context_window.window_id = "other"; },
    f => { f.records[0].payload.unreviewed_field = "extra"; },
    f => { delete f.records[0].payload.git; },
    f => { f.records[2].payload.content[0].text = "changed"; },
    f => { f.records[2] = sorted(f.records[2]); },
    f => { f.records.splice(3, 1, { type: "response_item", payload: { type: "function_call", call_id: "pending", name: "exec_command", arguments: "{}" } }); },
  ]) await fixture(f => {
    f.records[0] = sorted(f.records[0]); change(f); f.write();
    assert.equal(f.boundary(), null);
  });
});
