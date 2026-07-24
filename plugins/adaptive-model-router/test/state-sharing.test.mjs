import test from "node:test";
import assert from "node:assert/strict";
import { access, cp, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { temporaryProject } from "./fixtures.mjs";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("installed hook and MCP share state and observed context without inherited plugin env or cwd", async () => {
  const project = await temporaryProject("adaptive shared state 空格 ");
  const codexHome = join(project.root, "fallback codex home");
  const installedRoot = join(
    codexHome,
    "plugins",
    "cache",
    "test-marketplace",
    "adaptive-model-router",
    "0.3.1",
  );
  const pluginData = join(codexHome, "plugins", "data", "test-marketplace-adaptive-model-router");
  const staleMcpCwd = join(project.root, "stale MCP cwd");
  await cp(pluginRoot, installedRoot, { recursive: true });
  await mkdir(pluginData, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await mkdir(staleMcpCwd, { recursive: true });
  const hookEnv = {
    ...process.env,
    PLUGIN_ROOT: installedRoot,
    PLUGIN_DATA: pluginData,
    CODEX_HOME: codexHome,
    ADAPTIVE_ROUTER_LOCAL_ONLY: "1",
  };
  delete hookEnv.ADAPTIVE_ROUTER_HOME;
  delete hookEnv.CLAUDE_PLUGIN_DATA;
  const mcpEnv = { ...hookEnv };
  delete mcpEnv.PLUGIN_DATA;

  try {
    const contextId = "shared-plugin-data-session";
    const installedLauncher = join(installedRoot, "scripts", "node-launcher.mjs");
    const installedHook = join(installedRoot, "scripts", "hook.mjs");
    const installedServer = join(installedRoot, "scripts", "mcp-server.mjs");
    const hookResult = spawnSync(process.execPath, [installedLauncher, installedHook, "prompt"], {
      cwd: project.root,
      env: hookEnv,
      input: JSON.stringify({
        cwd: project.root,
        session_id: contextId,
        model: "gpt-5.6-sol",
        prompt: "router: global on",
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    assert.equal(hookResult.status, 0, hookResult.stderr);

    const pendingHookResult = spawnSync(process.execPath, [installedLauncher, installedHook, "prompt"], {
      cwd: project.root,
      env: hookEnv,
      input: JSON.stringify({
        cwd: project.root,
        session_id: contextId,
        model: "gpt-5.6-terra",
        prompt: "Review the utility without changing files.",
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    assert.equal(pendingHookResult.status, 0, pendingHookResult.stderr);

    const messages = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
        name: "get_route_status",
        arguments: { contextId },
      } }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
        name: "route_stage",
        arguments: {
          contextId,
          goal: "Review the utility for missing edge cases.",
          phase: "review",
          evidence: {
            workProduct: true,
            requirementsSettled: true,
            strongVerification: true,
            review: true,
            hostCanDelegate: true,
          },
        },
      } }),
    ];
    const mcpResult = spawnSync(process.execPath, [installedLauncher, installedServer], {
      cwd: staleMcpCwd,
      env: mcpEnv,
      input: `${messages.join("\n")}\n`,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    assert.equal(mcpResult.status, 0, mcpResult.stderr);
    const responses = mcpResult.stdout.trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(responses[1].result.structuredContent.autoActivation.globalEnabled, true);
    assert.deepEqual(responses[1].result.structuredContent.rootTask, {
      model: "gpt-5.6-terra",
      modelVisibility: "hook_observed",
      reasoningEffortVisibility: "host_only",
      changedByRouter: false,
    });
    assert.equal(responses[2].result.structuredContent.action, "continue");
    assert.deepEqual(responses[2].result.structuredContent.reasonCodes, ["HOST_MODEL_INTENT_PENDING"]);
    assert.equal(Object.hasOwn(responses[2].result.structuredContent, "target"), false);

    await access(join(pluginData, "router.sqlite3"));
    await assert.rejects(access(join(codexHome, "adaptive-model-router-v2", "router.sqlite3")));
  } finally {
    await project.cleanup();
  }
});
