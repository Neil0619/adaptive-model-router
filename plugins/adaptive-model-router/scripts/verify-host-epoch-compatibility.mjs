#!/usr/bin/env node
// Source-owned companion to the shared-writer suite. No arbitrary fixture home.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureHostEpochSchema } from "./lib/host-epoch-storage.mjs";
import { assertEpochVerificationHome, prepareEpochVerificationEntry, assertEpochEntryProcess, assertEpochHookInvocation } from "./lib/epoch-verification-entry.mjs";
const [a, b, home] = process.argv.slice(2);
const moduleAt = (root, name) => import(pathToFileURL(join(root, "scripts/lib", `${name}.mjs`)));
try {
  assertEpochVerificationHome(home);
  const A = await moduleAt(a, "database"), B = await moduleAt(b, "database");
  const ai = await moduleAt(a, "runtime-isolation"), ap = await moduleAt(a, "runtime-package");
  const source = ap.inspectRuntimePackage(a), candidate = ap.inspectRuntimePackage(b);
  const entry = prepareEpochVerificationEntry(source, home, "source");
  const store = new A.RouterStore();
  let context, baseline;
  try {
    // This separate fixture has real writer history from the first suite. A
    // cold enrollment would deliberately reject it; the registry setup below
    // is reachability-only and never qualifies a production epoch by itself.
    ensureHostEpochSchema(store.db);
    context = store.context({ cwd: home, contextId: "epoch-entry-owner", authoritative: true });
    store.transaction(() => {
      for (const record of [source, candidate, entry]) store.db.prepare("INSERT OR IGNORE INTO runtime_generations VALUES(?,?,'published')")
        .run(record.digest, JSON.stringify(record));
      store.db.prepare("INSERT OR IGNORE INTO runtime_defaults(singleton,current_digest) VALUES(1,?)").run(source.digest);
      store.db.prepare("INSERT OR IGNORE INTO runtime_host_entries VALUES(?,?,'referenced')").run(entry.root, entry.digest);
      ai.ensureRuntimeTask(store.db, context, { trustedHook: true, turnId: "entry-turn" });
      store.db.prepare("UPDATE runtime_tasks SET generation=? WHERE project_id=? AND context_key=?")
        .run(candidate.digest, context.projectId, context.contextKey);
      store.db.prepare("INSERT INTO runtime_epoch_origins VALUES(?,?,?,?,?)")
        .run(context.projectId, context.contextKey, "fixture-retention", source.digest, ' {"schema":"fixture/1","bytes":"unchanged"} ');
    });
    baseline = JSON.stringify(store.db.prepare("SELECT * FROM outcomes ORDER BY seq").all());
  } finally { store.close(); }
  for (const Constructor of [B.RouterStore, A.RouterStore, B.RouterStore, A.RouterStore]) {
    const reader = new Constructor();
    try {
      assert.equal(JSON.stringify(reader.db.prepare("SELECT * FROM outcomes ORDER BY seq").all()), baseline);
      assert.equal(reader.db.prepare("SELECT record FROM runtime_epoch_origins").get().record, ' {"schema":"fixture/1","bytes":"unchanged"} ');
    } finally { reader.close(); }
  }
  const dispatch = await moduleAt(a, "runtime-dispatch");
  const entered = dispatch.beginMcpDispatch("get_route_status", { contextId: "epoch-entry-owner" }, {
    cwd: home, env: { CODEX_THREAD_ID: "epoch-entry-owner" }, shellRoot: entry.root,
  });
  try { assert.equal(entered.selected.digest, candidate.digest); }
  finally { dispatch.endRuntimeDispatch(entered); }
  const before = new B.RouterStore();
  const previous = new Set(before.db.prepare("SELECT id FROM runtime_invocations").all().map((row) => row.id)); before.close();
  const hook = spawnSync(process.execPath, [join(entry.root, "scripts/node-launcher.mjs"), join(entry.root, "scripts/hook.mjs"), "session-start"],
    { cwd: home, encoding: "utf8", timeout: 15_000, env: { ...process.env, PLUGIN_ROOT: entry.root, ADAPTIVE_ROUTER_SHELL_ROOT: entry.root,
      ADAPTIVE_ROUTER_NODE: process.execPath }, input: JSON.stringify({ hook_event_name: "SessionStart", source: "compact",
      session_id: "epoch-entry-owner", turn_id: "entry-turn", cwd: home, model: "gpt-6-astra" }) });
  const completed = new B.RouterStore();
  try { assertEpochHookInvocation(completed.db, context, candidate.digest, hook, previous, "SessionStart"); }
  finally { completed.close(); }
  const rpc = spawnSync(process.execPath, [join(entry.root, "scripts/node-launcher.mjs"), join(entry.root, "scripts/mcp-server.mjs")],
    { cwd: home, encoding: "utf8", timeout: 15_000, env: { ...process.env, PLUGIN_ROOT: entry.root, ADAPTIVE_ROUTER_SHELL_ROOT: entry.root,
      ADAPTIVE_ROUTER_NODE: process.execPath, CODEX_THREAD_ID: "epoch-entry-owner" },
      input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_route_status",
        arguments: { contextId: "epoch-entry-owner" } } }) + "\n" });
  assertEpochEntryProcess(rpc);
  assert.equal(JSON.parse(rpc.stdout.trim()).result?.isError, false, rpc.stdout);
  const lifecycle = await moduleAt(a, "runtime-lifecycle");
  const reader = new B.RouterStore();
  try {
    const selected = await lifecycle.createRuntimeLifecycleProbe(candidate, entry.root, {
      inspect: async (options) => typeof options.lifecycle.prepareHistoricalQualificationAdoption,
    })({ store: reader, context, contextId: "epoch-entry-owner", cwd: home });
    assert.equal(selected, "function");
    const completed = reader.db.prepare("SELECT * FROM runtime_invocations WHERE project_id=? AND context_key=?")
      .all(context.projectId, context.contextKey);
    assert.ok(completed.some((row) => row.kind === "hook:SessionStart" && row.generation === candidate.digest && row.state === "completed"));
    assert.equal(JSON.stringify(reader.db.prepare("SELECT * FROM outcomes ORDER BY seq").all()), baseline);
  } finally { reader.close(); }
  assert.equal(ap.inspectRuntimePackage(a).digest, source.digest);
  assert.equal(ap.inspectRuntimePackage(b).digest, candidate.digest); entry.verify();
  process.stdout.write("real A/B constructors, old dispatcher/Hook/lifecycle, additive receipts and immutable historical outcomes verified\n");
} catch (error) { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; }
