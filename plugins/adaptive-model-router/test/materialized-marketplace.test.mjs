import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createManagedMarketplace, inspectManagedMarketplace, switchManagedMarketplace } from "../scripts/lib/materialized-marketplace.mjs";
import { temporaryProject } from "./fixtures.mjs";

function nativeClient({ source = "/reviewed/repository", mode = "ok", filePath = "/codex/config.toml" } = {}) {
  let current = { source_type: "local", source, last_updated: "keep", ref: "old" };
  let version = 1;
  const writes = [];
  return { filePath, writes, get current() { return current; }, change(value) { current = value; version++; },
    async request(method, params) {
      if (method === "config/read") {
        assert.deepEqual(params, { includeLayers: true });
        const layer = { name: { type: "user", file: filePath }, version: String(version), config: { marketplaces: { "adaptive-model-router": current } } };
        return { layers: mode === "duplicate-layer" ? [layer, layer] : [layer] };
      }
      assert.equal(method, "config/batchWrite");
      assert.equal(params.filePath, filePath);
      assert.equal(params.reloadUserConfig, false);
      assert.equal(params.edits.length, 1);
      assert.equal(params.edits[0].keyPath, "marketplaces.adaptive-model-router");
      assert.equal(params.edits[0].mergeStrategy, "replace");
      assert.equal(params.expectedVersion, String(version));
      writes.push(params);
      if (mode === "conflict") throw new Error("version conflict");
      current = structuredClone(params.edits[0].value);
      version++;
      return { status: mode === "overridden" && writes.length === 1 ? "okOverridden" : "ok" };
    } };
}

test("native switch resolves an existing config pathname before matching the base user layer", async () => {
  const project = await temporaryProject("materialized-config-path-");
  try {
    const path = join(project.root, "config.toml");
    writeFileSync(path, "");
    const client = nativeClient({ filePath: realpathSync(path) });
    await switchManagedMarketplace({ client, filePath: path, expectedSource: "/reviewed/repository",
      generation: { root: "/data/generation" }, verify() {} });
    assert.equal(client.writes[0].filePath, realpathSync(path));
  } finally { await project.cleanup(); }
});

test("native source switch uses the base user CAS and preserves unrelated marketplace keys", async () => {
  const client = nativeClient();
  let verified = false;
  await switchManagedMarketplace({ client, filePath: client.filePath, expectedSource: "/reviewed/repository",
    generation: { root: "/data/generation" }, verify: () => { verified = true; } });
  assert.equal(verified, true);
  assert.deepEqual(client.current, { source_type: "local", source: "/data/generation", last_updated: "keep" });
  assert.equal(client.writes.length, 1);
});

test("native switch fails closed on layer ambiguity, CAS conflict and overridden writes", async (t) => {
  for (const mode of ["duplicate-layer", "conflict", "overridden"]) {
    await t.test(mode, async () => {
      const client = nativeClient({ mode });
      await assert.rejects(switchManagedMarketplace({ client, filePath: client.filePath, expectedSource: "/reviewed/repository",
        generation: { root: "/data/generation" }, verify: () => assert.fail("must not verify failed switch") }));
      assert.equal(client.current.source, "/reviewed/repository");
      assert.equal(client.writes.length, mode === "duplicate-layer" ? 0 : mode === "conflict" ? 1 : 2);
    });
  }
});

test("verification failure rolls back only its own generation and keeps concurrent source edits", async (t) => {
  for (const concurrent of [false, true]) {
    await t.test(String(concurrent), async () => {
      const client = nativeClient();
      await assert.rejects(switchManagedMarketplace({ client, filePath: client.filePath, expectedSource: "/reviewed/repository",
        generation: { root: "/data/generation" }, verify: () => {
          if (concurrent) client.change({ source_type: "local", source: "/another/owner" });
          throw new Error("MCP verification failed");
        } }), new RegExp(`rollback=${concurrent ? "concurrent-source-preserved" : "restored"}`, "u"));
      assert.equal(client.current.source, concurrent ? "/another/owner" : "/reviewed/repository");
      assert.equal(client.writes.length, concurrent ? 1 : 2);
    });
  }
});

test("generation validation rejects payload changes, forged provenance and symbolic links", async (t) => {
  for (const mode of ["payload", "receipt", "generation-link", "receipt-link", "parent-link"]) {
    await t.test(mode, async (subtest) => {
      const project = await temporaryProject("materialized-integrity-");
      try {
        const sourceRoot = join(project.root, "source");
        for (const directory of [".codex-plugin", "hooks"]) mkdirSync(join(sourceRoot, directory), { recursive: true });
        mkdirSync(project.home);
        writeFileSync(join(sourceRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "adaptive-model-router", version: "0.4.0" }));
        writeFileSync(join(sourceRoot, "runtime.json"), JSON.stringify({ runtimeVersion: "0.4.0" }));
        writeFileSync(join(sourceRoot, "hooks", "hooks.json"), "{}\n");
        const generation = createManagedMarketplace({ dataRoot: project.home, sourceRoot, originalSource: sourceRoot,
          prepare() {}, verify() {} });
        assert.equal(inspectManagedMarketplace(generation.root, { dataRoot: project.home }).receipt.runtimeVersion, "0.4.0");
        if (mode === "payload") writeFileSync(join(generation.pluginRoot, "runtime.json"), "{}");
        if (mode === "receipt") {
          const receipt = { ...generation.receipt, owner: "stranger" };
          writeFileSync(join(generation.root, ".adaptive-router-generation.json"), JSON.stringify(receipt));
        }
        if (mode.endsWith("link")) {
          const path = mode === "generation-link" ? generation.root : mode === "parent-link" ? join(project.home, "materialized-marketplace") : join(generation.root, ".adaptive-router-generation.json");
          const target = mode === "receipt-link" ? join(project.root, "outside.json") : sourceRoot;
          if (mode === "receipt-link") writeFileSync(target, readFileSync(path));
          rmSync(path, { recursive: true });
          try { symlinkSync(target, path, mode === "receipt-link" ? "file" : "junction"); }
          catch (error) {
            if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) { subtest.skip("symlink permission unavailable"); return; }
            throw error;
          }
        }
        assert.throws(() => inspectManagedMarketplace(generation.root, { dataRoot: project.home }));
      } finally { await project.cleanup(); }
    });
  }
});
