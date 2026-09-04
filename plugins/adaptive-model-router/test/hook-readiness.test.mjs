import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateLifecycleHookInventory,
  inspectLifecycleHookReadiness,
  resolveLifecyclePluginRoot,
} from "../scripts/lib/hook-readiness.mjs";
import { RouterStore } from "../scripts/lib/database.mjs";
import { payloadHash } from "../scripts/lib/io.mjs";
import { callRouterTool } from "../scripts/lib/service.mjs";
import { CATALOG, routeInput, temporaryProject, withRouterEnvironment } from "./fixtures.mjs";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("lifecycle readiness resolves the pinned host shell before a hot runtime module", () => {
  assert.equal(resolveLifecyclePluginRoot({
    env: {},
    argv: [process.execPath, join(pluginRoot, "scripts", "mcp-server.mjs")],
    moduleRoot: join(pluginRoot, "runtime-vault", "candidate"),
  }), pluginRoot);
  assert.equal(resolveLifecyclePluginRoot({
    env: { PLUGIN_ROOT: join(pluginRoot, ".") },
    argv: [process.execPath, "/different/scripts/mcp-server.mjs"],
    moduleRoot: "/different/runtime",
  }), pluginRoot);
});

function hostEventName(eventName) {
  return `${eventName[0].toLowerCase()}${eventName.slice(1)}`;
}

function fixture(cwd, { trustStatus = "trusted", enabled = true } = {}) {
  const sourcePath = join(pluginRoot, "hooks", "hooks.json");
  const document = JSON.parse(readFileSync(sourcePath, "utf8"));
  const hooks = [];
  let index = 0;
  for (const [eventName, groups] of Object.entries(document.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        hooks.push({
          key: `fixture:${index++}`,
          eventName: hostEventName(eventName),
          handlerType: "command",
          command: process.platform === "win32" ? hook.commandWindows : hook.command,
          async: hook.async === true,
          matcher: group.matcher ?? null,
          timeoutSec: hook.timeout,
          statusMessage: hook.statusMessage ?? null,
          sourcePath,
          source: "plugin",
          pluginId: "adaptive-model-router@adaptive-model-router",
          enabled,
          currentHash: `sha256:${"a".repeat(64)}`,
          trustStatus,
        });
      }
    }
  }
  return { data: [{ cwd, hooks, warnings: [], errors: [] }] };
}

test("exact enabled and trusted Router lifecycle hooks are ready", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "router-hook-readiness-"));
  try {
    assert.deepEqual(evaluateLifecycleHookInventory(fixture(cwd), { cwd, pluginRoot }), {
      ready: true,
      reasonCode: null,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("modified or disabled Router lifecycle hooks require user trust", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "router-hook-readiness-"));
  try {
    for (const mutation of [
      (value) => { value.data[0].hooks[0].trustStatus = "modified"; },
      (value) => { value.data[0].hooks[0].enabled = false; },
    ]) {
      const value = fixture(cwd);
      mutation(value);
      assert.deepEqual(evaluateLifecycleHookInventory(value, { cwd, pluginRoot }), {
        ready: false,
        reasonCode: "HOOK_TRUST_REQUIRED",
      });
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("missing, duplicated, or altered Router hooks fail closed as a set mismatch", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "router-hook-readiness-"));
  try {
    const mutations = [
      (value) => { value.data[0].hooks.pop(); },
      (value) => { value.data[0].hooks.push({ ...value.data[0].hooks[0], key: "duplicate" }); },
      (value) => { value.data[0].hooks.find((hook) => hook.eventName === "preToolUse").matcher = "Agent"; },
      (value) => { value.data[0].hooks[0].sourcePath = join(cwd, "other-hooks.json"); },
    ];
    for (const mutation of mutations) {
      const value = fixture(cwd);
      mutation(value);
      assert.deepEqual(evaluateLifecycleHookInventory(value, { cwd, pluginRoot }), {
        ready: false,
        reasonCode: "HOST_HOOK_SET_MISMATCH",
      });
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("unavailable hooks/list data is a typed root-only result", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "router-hook-readiness-"));
  try {
    assert.deepEqual(evaluateLifecycleHookInventory({}, { cwd, pluginRoot }), {
      ready: false,
      reasonCode: "HOST_HOOK_STATUS_UNAVAILABLE",
    });
    const result = await inspectLifecycleHookReadiness({
      cwd,
      pluginRoot,
      appServer: async () => { throw new Error("unavailable"); },
    });
    assert.deepEqual(result, {
      ready: false,
      reasonCode: "HOST_HOOK_STATUS_UNAVAILABLE",
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("trusted hook inventory alone cannot prove the native lifecycle round trip", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "router-hook-readiness-"));
  try {
    const calls = [];
    const result = await inspectLifecycleHookReadiness({
      cwd,
      pluginRoot,
      appServer: async (run, options) => {
        calls.push(options);
        return run({
          listHooks: async (observedCwd) => {
            calls.push(observedCwd);
            return fixture(cwd);
          },
        }, Date.now() + 1_000);
      },
    });
    assert.deepEqual(result, {
      ready: false,
      reasonCode: "HOST_LIFECYCLE_ROUND_TRIP_UNPROVEN",
    });
    assert.equal(calls[0].timeoutMs, 5_000);
    assert.equal(calls[1], cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a source-owned native lifecycle proof can complete readiness after hook trust", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "router-hook-readiness-"));
  try {
    const proofCalls = [];
    const result = await inspectLifecycleHookReadiness({
      cwd,
      pluginRoot,
      appServer: async (run) => run({
        listHooks: async () => fixture(cwd),
      }, Date.now() + 1_000),
      dispatchRoundTripProbe: async (input) => {
        proofCalls.push(input);
        return { ready: true, reasonCode: null };
      },
    });
    assert.deepEqual(result, { ready: true, reasonCode: null });
    assert.deepEqual(proofCalls, [{ cwd, pluginRoot, platform: process.platform }]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("the MCP service enforcement boundary delegates only after a trusted readiness result", async () => {
  const project = await temporaryProject("router-service-readiness-");
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      try {
        const blocked = await callRouterTool("route_stage", routeInput({ contextId: "service-blocked" }), {
          store,
          cwd: project.root,
          routeOptions: {
            enforceLifecycleHooks: true,
            catalog: CATALOG,
            diskProbe: () => 16n * 1024n * 1024n * 1024n,
            lifecycleHookProbe: async () => ({ ready: false, reasonCode: "HOOK_TRUST_REQUIRED" }),
          },
        });
        assert.equal(blocked.action, "continue");
        assert.deepEqual(blocked.reasonCodes, ["HOOK_TRUST_REQUIRED"]);

        const delegated = await callRouterTool("route_stage", routeInput({ contextId: "service-trusted" }), {
          store,
          cwd: project.root,
          routeOptions: {
            enforceLifecycleHooks: true,
            catalog: CATALOG,
            diskProbe: () => 16n * 1024n * 1024n * 1024n,
            lifecycleHookProbe: async () => ({ ready: true, reasonCode: null }),
          },
        });
        assert.equal(delegated.action, "delegate");
        assert.match(delegated.carrier?.taskName, /^router_[a-f0-9]{32}$/u);
        assert.equal(typeof delegated.carrier?.message, "string");
      } finally {
        store.close();
      }
    });
  } finally {
    await project.cleanup();
  }
});

test("production readiness offers only qualification and binds the full ordered Hook set", async () => {
  const project = await temporaryProject("router-qualification-readiness-");
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      try {
        const context = store.context({ cwd: project.root, contextId: "native-binding" });
        const inventory = fixture(project.root);
        const inspect = () => inspectLifecycleHookReadiness({ cwd: project.root, pluginRoot, store, context, contextId: "native-binding",
          appServer: async (run) => run({ start: async () => {}, request: async () => ({ thread: { id: "native-binding", cwd: project.root } }), listHooks: async () => inventory }),
          nativeHost: async () => ({ platform: "darwin", arch: "arm64", cliVersion: "0.153.0", executableDigest: "a".repeat(64) }),
        });
        const first = await inspect();
        assert.equal(first.ready, false);
        assert.equal(first.reasonCode, "HOST_LIFECYCLE_ROUND_TRIP_UNPROVEN");
        assert.match(first.qualificationBinding.digest, /^[a-f0-9]{64}$/u);
        inventory.data[0].hooks.push({ ...inventory.data[0].hooks[0], pluginId: null, source: "user", matcher: "Bash" });
        const otherHook = await inspect();
        assert.notEqual(first.qualificationBinding.digest, otherHook.qualificationBinding.digest);
        inventory.data[0].hooks.reverse();
        assert.notEqual(otherHook.qualificationBinding.digest, (await inspect()).qualificationBinding.digest);
        inventory.data[0].hooks.find((hook) => hook.pluginId !== null).trustStatus = "modified";
        const untrusted = await inspect();
        assert.equal(untrusted.reasonCode, "HOOK_TRUST_REQUIRED");
        assert.equal(untrusted.qualificationBinding, undefined);
      } finally { store.close(); }
    });
  } finally { await project.cleanup(); }
});

test("equivalent hot-shell paths allow an inert qualification, never an inventory-only pass", async () => {
  const project = await temporaryProject("router-hot-qualification-");
  try {
    await withRouterEnvironment(project, async () => {
      const configured = join(project.root, "configured-plugin");
      await mkdir(join(configured, "hooks"), { recursive: true });
      await writeFile(join(configured, "hooks", "hooks.json"), readFileSync(join(pluginRoot, "hooks", "hooks.json")));
      const inventory = fixture(project.root);
      for (const hook of inventory.data[0].hooks) hook.sourcePath = join(configured, "hooks", "hooks.json");
      assert.equal(evaluateLifecycleHookInventory(inventory, { cwd: project.root, pluginRoot }).reasonCode, "HOST_HOOK_SET_MISMATCH");
      const store = new RouterStore();
      try {
        const context = store.context({ cwd: project.root, contextId: "hot-binding" });
        const result = await inspectLifecycleHookReadiness({ cwd: project.root, pluginRoot, store, context, contextId: "hot-binding",
          appServer: async (run) => run({ start: async () => {}, request: async () => ({ thread: { id: "hot-binding", cwd: project.root } }), listHooks: async () => inventory }),
          nativeHost: async () => ({ platform: "darwin", cliVersion: "0.153.0" }),
        });
        assert.equal(result.ready, false);
        assert.equal(result.qualificationBinding.shellRoots.length, 2);
      } finally { store.close(); }
    });
  } finally { await project.cleanup(); }
});

test("production readiness discovers and binds the native task cwd, not the MCP cache cwd", async () => {
  const project = await temporaryProject("router-native-cwd-");
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      try {
        const contextId = "native-cwd";
        const context = store.context({ cwd: project.root, contextId });
        const calls = [];
        let nativeCwd = project.root;
        const inspect = () => inspectLifecycleHookReadiness({ cwd: pluginRoot, pluginRoot, store, context, contextId,
          appServer: async (run) => run({
            start: async () => {},
            request: async (method, args) => { calls.push([method, args]); return { thread: { id: contextId, cwd: nativeCwd } }; },
            listHooks: async (cwd) => { calls.push(["hooks/list", cwd]); return fixture(cwd); },
          }),
          nativeHost: async () => ({ platform: "darwin", arch: "arm64", cliVersion: "0.153.0", executableDigest: "a".repeat(64) }),
        });
        const result = await inspect();
        assert.equal(result.qualificationBinding?.taskCwdDigest, payloadHash(realpathSync(project.root)));
        assert.deepEqual(calls, [["thread/read", { threadId: contextId, includeTurns: false }], ["hooks/list", realpathSync(project.root)]]);
        nativeCwd = pluginRoot;
        const mismatch = await inspect();
        assert.equal(mismatch.ready, false);
        assert.equal(mismatch.qualificationBinding, undefined);
      } finally { store.close(); }
    });
  } finally { await project.cleanup(); }
});
