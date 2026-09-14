import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RouterStore } from "../scripts/lib/database.mjs";
import { ensureRuntimeIsolationSchema } from "../scripts/lib/runtime-isolation.mjs";
import { prepareRuntimeHostEntry } from "../scripts/lib/runtime-host-entry.mjs";
import { inspectRuntimePackage } from "../scripts/lib/runtime-package.mjs";
import { createRuntimeLifecycleProbe, equivalentMaterializedHookEntries } from "../scripts/lib/runtime-lifecycle.mjs";
import { temporaryProject, withRouterEnvironment } from "./fixtures.mjs";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("materialization accepts only exact launcher path substitution", () => {
  const root = "/fixture/stable router/plugin";
  const before = [{ eventName: "stop", command: '"/verified/node" "$PLUGIN_ROOT/scripts/node-launcher.mjs" "$PLUGIN_ROOT/scripts/hook.mjs" stop', timeoutSec: 15 }];
  const after = [{ ...before[0], command: `"/verified/node" "${root}/scripts/node-launcher.mjs" "${root}/scripts/hook.mjs" stop` }];
  assert.equal(equivalentMaterializedHookEntries(before, after, root), true);
  for (const mutation of [
    (e) => { e.command += " --extra"; },
    (e) => { e.command = e.command.replace("/verified/node", "/other/node"); },
    (e) => { e.command = e.command.replace("hook.mjs", "other.mjs"); },
    (e) => { e.timeoutSec++; },
    (e) => { e.matcher = ".*"; },
  ]) {
    const changed = structuredClone(after); mutation(changed[0]);
    assert.equal(equivalentMaterializedHookEntries(before, changed, root), false);
  }
  assert.equal(equivalentMaterializedHookEntries(before, after, "/wrong/entry"), false);
});

test("stable lifecycle adapter selects the actual runtime API and refuses changed or unregistered packages", async () => {
  const project = await temporaryProject("router-lifecycle-adapter-");
  try { await withRouterEnvironment(project, async () => {
    const selectedPath = join(project.root, "selected");
    cpSync(source, selectedPath, { recursive: true });
    // A different immutable API identity must never be replaced by the shell's.
    const apiPath = join(selectedPath, "scripts/lib/lifecycle-qualification.mjs");
    writeFileSync(apiPath, readFileSync(apiPath, "utf8") + "\n// selected runtime identity\n");
    const selected = inspectRuntimePackage(selectedPath);
    const shell = prepareRuntimeHostEntry(source, join(project.root, "host/plugin"), project.home);
    const store = new RouterStore();
    try {
      ensureRuntimeIsolationSchema(store.db);
      for (const record of [selected, shell]) store.db.prepare("INSERT INTO runtime_generations VALUES(?,?,'published')")
        .run(record.digest, JSON.stringify(record));
      store.db.prepare("INSERT INTO runtime_host_entries VALUES(?,?,'referenced')").run(shell.root, shell.digest);
      const api = await import(pathToFileURL(apiPath));
      let calls = 0;
      const probe = createRuntimeLifecycleProbe(selected, shell.root, { inspect: async (options) => {
        calls++;
        assert.equal(options.lifecycle.lifecycleBinding, api.lifecycleBinding);
        assert.equal(options.lifecycle.qualificationReadiness, api.qualificationReadiness);
        assert.equal(options.nativeHost, api.nativeQualificationHost);
        assert.equal(options.pluginRoot, shell.root);
        assert.equal(typeof options.equivalentEntries, "function");
        return { ready: false, reasonCode: "HOST_LIFECYCLE_ROUND_TRIP_UNPROVEN" };
      } });
      assert.equal((await probe({ store })).ready, false, "adapter cannot manufacture passed evidence");
      const transportPath = join(project.root, "transport");
      cpSync(shell.root, transportPath, { recursive: true });
      const hostPath = join(transportPath, "runtime-host.json"), host = JSON.parse(readFileSync(hostPath));
      host.shellRoot = transportPath; host.hookShellRoot = shell.root;
      writeFileSync(hostPath, JSON.stringify(host));
      const transport = inspectRuntimePackage(transportPath);
      store.db.prepare("INSERT INTO runtime_generations VALUES(?,?,'published')").run(transport.digest, JSON.stringify(transport));
      store.db.prepare("INSERT INTO runtime_host_entries VALUES(?,?,'referenced')").run(transport.root, transport.digest);
      const repaired = createRuntimeLifecycleProbe(selected, transport.root, { inspect: async (options) => {
        assert.equal(options.pluginRoot, shell.root, "actual retained Hook executes from the old stable directory");
        assert.ok(options.retainedShellRoots.includes(shell.root));
        assert.equal(options.lifecycle.lifecycleBinding, api.lifecycleBinding);
        return { ready: false };
      } });
      assert.equal((await repaired({ store })).ready, false);
      store.db.prepare("UPDATE runtime_host_entries SET state='released'").run();
      await assert.rejects(probe({ store }), /not enrolled/);
      store.db.prepare("UPDATE runtime_host_entries SET state='referenced'").run();
      store.db.prepare("UPDATE runtime_host_entries SET state='released' WHERE path=?").run(shell.root);
      await assert.rejects(repaired({ store }), /dependency is not exactly proven/);
      store.db.prepare("UPDATE runtime_host_entries SET state='referenced'").run();
      store.db.prepare("UPDATE runtime_generations SET state='archived' WHERE digest=?").run(selected.digest);
      await assert.rejects(probe({ store }), /selected published/);
      store.db.prepare("UPDATE runtime_generations SET state='published' WHERE digest=?").run(selected.digest);
      writeFileSync(apiPath, readFileSync(apiPath, "utf8") + "// changed after publication\n");
      await assert.rejects(probe({ store }), /integrity changed/);
      assert.equal(calls, 1);
    } finally { store.close(); }
  }); } finally { await project.cleanup(); }
});
