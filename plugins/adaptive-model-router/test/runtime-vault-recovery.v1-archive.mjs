import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntime, runtimePublicState } from "../scripts/lib/runtime-loader.mjs";
import { temporaryProject } from "./fixtures.mjs";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function fixture() {
  const project = await temporaryProject("router-cache-recovery-");
  const current = join(project.root, "cache", "0.4.0");
  const vault = join(project.home, "runtime-shell-vault");
  const active = join(vault, "0.4.1");
  for (const [root, version] of [[current, "0.4.0"], [active, "0.4.1"]]) {
    await cp(pluginRoot, root, { recursive: true });
    for (const [file, field] of [["runtime.json", "runtimeVersion"], [".codex-plugin/plugin.json", "version"]]) {
      const path = join(root, file);
      const value = JSON.parse(await readFile(path, "utf8"));
      value[field] = version;
      await writeFile(path, JSON.stringify(value));
    }
  }
  await mkdir(join(project.home, "runtime"), { recursive: true });
  const pointer = { schemaVersion: 1, activeDirectory: "0.4.1", activeVersion: "0.4.1",
    previousDirectory: "0.4.0", previousVersion: "0.4.0", failedDirectories: [] };
  await writeFile(join(project.home, "runtime", "active.json"), JSON.stringify(pointer));
  await writeFile(join(vault, "index.json"), JSON.stringify({ schemaVersion: 1, directories: ["0.4.1"] }));
  return { ...project, current, vault, active, pointer,
    env: { ...process.env, ADAPTIVE_ROUTER_HOME: project.home, PLUGIN_DATA: project.home, PLUGIN_ROOT: current } };
}

test("cache reconstruction keeps the activated runtime through the stable indexed vault", async () => {
  const f = await fixture();
  try {
    const resolution = resolveRuntime(f.current, { env: f.env, allowTrial: false });
    assert.equal(resolution.candidate.root, f.active);
    const state = runtimePublicState(resolution, f.env);
    assert.equal(state.runtimeVersion, "0.4.1");
    assert.equal(state.activeSource, "vault");
    assert.equal(state.requestedActiveVersion, "0.4.1");
    assert.equal(state.activePointerStatus, "matched");
    assert.deepEqual(JSON.parse(await readFile(join(f.home, "runtime", "active.json"), "utf8")), f.pointer);

    // Both native entry paths must work in new processes after the cache loss.
    await writeFile(join(f.active, "scripts", "hook.mjs"), "process.stdout.write('VAULT_HOOK_OK\\n');\n");
    const hook = spawnSync(process.execPath, [join(f.current, "scripts/node-launcher.mjs"),
      join(f.current, "scripts/hook.mjs"), "prompt"], { encoding: "utf8", env: f.env, input: "{}" });
    assert.equal(hook.status, 0, hook.stderr);
    assert.equal(hook.stdout.trim(), "VAULT_HOOK_OK");
    const servicePath = join(f.active, "scripts", "lib", "service.mjs");
    await writeFile(servicePath, 'process.stderr.write("VAULT_SERVICE_OK\\n");\n' + await readFile(servicePath, "utf8"));
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {},
        clientInfo: { name: "vault-recovery-test", version: "1" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "diagnose_router",
        arguments: { contextId: "cache-recovery-test" } } },
    ];
    const mcp = spawnSync(process.execPath, [join(f.current, "scripts/mcp-server.mjs")], {
      encoding: "utf8", env: f.env, input: requests.map((request) => JSON.stringify(request)).join("\n") + "\n",
    });
    assert.equal(mcp.status, 0, mcp.stderr);
    const responses = mcp.stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(responses.find((response) => response.id === 1).result.serverInfo.version, "0.4.1");
    const call = responses.find((response) => response.id === 2);
    assert.equal(call.error, undefined);
    assert.equal(call.result.isError, false);
    assert.equal(call.result.structuredContent.databaseHealth, "ok");
    assert.equal(call.result.structuredContent.runtime.runtimeVersion, "0.4.1");
    assert.equal(call.result.structuredContent.runtime.activeSource, "vault");
    assert.match(mcp.stderr, /VAULT_SERVICE_OK/u);
  } finally { await f.cleanup(); }
});

test("vault recovery rejects unindexed, damaged, quarantined and redirected runtimes", async (t) => {
  for (const mode of ["unindexed", "bad-index", "mismatch", "incompatible", "quarantined", "symlink", "symlink-module"]) {
    await t.test(mode, async (subtest) => {
      const f = await fixture();
      try {
        if (mode === "unindexed") await rm(join(f.vault, "index.json"));
        if (mode === "bad-index") await writeFile(join(f.vault, "index.json"), '{"schemaVersion":1,"directories":["../0.4.1"]}');
        if (mode === "quarantined") await writeFile(join(f.home, "runtime", "active.json"),
          JSON.stringify({ ...f.pointer, failedDirectories: ["0.4.1"] }));
        if (["mismatch", "incompatible"].includes(mode)) {
          const descriptor = JSON.parse(await readFile(join(f.active, "runtime.json"), "utf8"));
          if (mode === "mismatch") descriptor.runtimeVersion = "0.4.2";
          else descriptor.toolContractVersion += 1;
          await writeFile(join(f.active, "runtime.json"), JSON.stringify(descriptor));
        }
        if (mode.startsWith("symlink")) {
          const target = mode === "symlink" ? f.active : join(f.active, "scripts", "lib", "service.mjs");
          const outside = join(f.root, "redirected");
          await cp(target, outside, { recursive: true });
          await rm(target, { recursive: true });
          try { await symlink(outside, target, mode === "symlink" ? "junction" : "file"); }
          catch (error) {
            if (process.platform === "win32" && ["EACCES", "EPERM"].includes(error.code)) {
              subtest.skip("Windows symlink permission unavailable"); return;
            }
            throw error;
          }
        }
        const resolution = resolveRuntime(f.current, { env: f.env });
        assert.equal(resolution.candidate.root, f.current);
        const state = runtimePublicState(resolution, f.env);
        assert.equal(state.activePointerStatus, "unavailable");
        assert.equal(state.requestedActiveVersion, "0.4.1");
      } finally { await f.cleanup(); }
    });
  }
});
