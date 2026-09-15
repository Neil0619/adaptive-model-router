#!/usr/bin/env node
// Executable source-owned reachability check, never a native retirement proof.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { inspectRuntimePackage } from "./lib/runtime-package.mjs";
import { readRuntimeDescriptor } from "./lib/runtime-loader.mjs";
import { ensureHostEpochSchema } from "./lib/host-epoch-storage.mjs";
import { assertEpochVerificationHome, prepareEpochVerificationEntry, assertEpochHookInvocation } from "./lib/epoch-verification-entry.mjs";
const [a, b, home] = process.argv.slice(2);
const moduleAt = (root, name) => import(pathToFileURL(join(root, "scripts/lib", `${name}.mjs`)));
try {
  assertEpochVerificationHome(home);
  const source = inspectRuntimePackage(a, { legacy: readRuntimeDescriptor(a).shellProtocolVersion === 1 }), candidate = inspectRuntimePackage(b);
  const entry = prepareEpochVerificationEntry(candidate, home, "candidate");
  const A = await moduleAt(a, "database"), B = await moduleAt(b, "database"), dispatch = await moduleAt(b, "runtime-dispatch");
  const store = new B.RouterStore(), contextId = "cold-epoch-source-fixture";
  let context, baseline;
  try {
    context = store.context({ cwd: home, contextId });
    ensureHostEpochSchema(store.db);
    for (const record of [source, candidate, entry]) store.db.prepare("INSERT OR IGNORE INTO runtime_generations VALUES(?,?,'published')").run(record.digest, JSON.stringify(record));
    store.db.prepare("INSERT INTO runtime_defaults(singleton,current_digest) VALUES(1,?)").run(source.digest);
    store.db.prepare("INSERT INTO runtime_host_entries VALUES(?,?,'referenced')").run(entry.root, entry.digest);
    store.db.prepare("INSERT INTO runtime_tasks(project_id,context_key,generation) VALUES(?,?,?)").run(context.projectId, context.contextKey, source.digest);
    store.db.prepare("INSERT INTO runtime_epoch_origins VALUES(?,?,?,?,?)").run(context.projectId, context.contextKey, "fixture", source.digest, ' {"bytes":"original"} ');
    baseline = JSON.stringify(store.db.prepare("SELECT * FROM outcomes ORDER BY seq").all());
  } finally { store.close(); }
  for (const Constructor of [A.RouterStore, B.RouterStore, A.RouterStore]) {
    const read = new Constructor();
    try {
      assert.equal(JSON.stringify(read.db.prepare("SELECT * FROM outcomes ORDER BY seq").all()), baseline);
      assert.equal(read.db.prepare("SELECT record FROM runtime_epoch_origins").get().record, ' {"bytes":"original"} ');
    } finally { read.close(); }
  }
  const entered = dispatch.beginMcpDispatch("get_route_status", { contextId }, { cwd: home, env: { CODEX_THREAD_ID: contextId }, shellRoot: entry.root });
  try { assert.equal(entered.selected.digest, source.digest); }
  finally { dispatch.endRuntimeDispatch(entered); }
  const read = new B.RouterStore();
  // Isolated reachability fixture only: no production admission token is
  // produced by this script or by these deliberately synthetic registry rows.
  read.db.prepare("UPDATE runtime_tasks SET generation=? WHERE project_id=? AND context_key=?").run(candidate.digest, context.projectId, context.contextKey);
  read.db.prepare("UPDATE runtime_defaults SET current_digest=?").run(candidate.digest); read.close();
  const transcript = join(home, "cold-epoch-root.jsonl"), records = [
    { type: "session_meta", timestamp: "2026-01-01T00:00:00Z", payload: { id: contextId, cwd: home } }];
  for (const turn of ["cold-first-turn", "cold-later-turn"]) {
    records.push({ type: "event_msg", payload: { type: "task_started", turn_id: turn } });
    writeFileSync(transcript, records.map(JSON.stringify).join("\n") + "\n");
    const before = new B.RouterStore();
    const previous = new Set(before.db.prepare("SELECT id FROM runtime_invocations").all().map((row) => row.id)); before.close();
    const hook = spawnSync(process.execPath, [join(entry.root, "scripts/node-launcher.mjs"), join(entry.root, "scripts/hook.mjs"), "prompt"], {
      cwd: home, encoding: "utf8", timeout: 15000, env: { ...process.env, PLUGIN_ROOT: entry.root, ADAPTIVE_ROUTER_SHELL_ROOT: entry.root, ADAPTIVE_ROUTER_NODE: process.execPath },
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: contextId, turn_id: turn, cwd: home,
        transcript_path: transcript, prompt: "Read current status", model: "gpt-6-astra" }) });
    const completed = new B.RouterStore();
    try {
      assertEpochHookInvocation(completed.db, context, candidate.digest, hook, previous, "UserPromptSubmit");
      assert.equal(completed.db.prepare("SELECT turn_id FROM runtime_tasks WHERE project_id=? AND context_key=?").get(context.projectId, context.contextKey).turn_id, turn);
      assert.equal(JSON.stringify(completed.db.prepare("SELECT * FROM outcomes ORDER BY seq").all()), baseline);
    } finally { completed.close(); }
    records.push({ type: "event_msg", payload: { type: "task_complete", turn_id: turn } });
  }
  assert.equal(inspectRuntimePackage(a, { legacy: source.descriptor.shellProtocolVersion === 1 }).digest, source.digest);
  assert.equal(inspectRuntimePackage(b).digest, candidate.digest); entry.verify();
  process.stdout.write("exact A/B writers, new shell selecting retained A, current B subsequent prompts and immutable history verified\n");
} catch (error) { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; }
