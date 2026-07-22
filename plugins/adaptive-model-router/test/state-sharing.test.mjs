import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { temporaryProject } from "./fixtures.mjs";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(pluginRoot, "scripts", "node-launcher.mjs");
const hook = join(pluginRoot, "scripts", "hook.mjs");
const server = join(pluginRoot, "scripts", "mcp-server.mjs");

test("hook and MCP share the writable PLUGIN_DATA state root", async () => {
  const project = await temporaryProject("adaptive shared state 空格 ");
  const pluginData = join(project.root, "plugin data 数据");
  const codexHome = join(project.root, "fallback codex home");
  await mkdir(pluginData, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  const env = {
    ...process.env,
    PLUGIN_ROOT: pluginRoot,
    PLUGIN_DATA: pluginData,
    CODEX_HOME: codexHome,
    ADAPTIVE_ROUTER_LOCAL_ONLY: "1",
  };
  delete env.ADAPTIVE_ROUTER_HOME;
  delete env.CLAUDE_PLUGIN_DATA;

  try {
    const contextId = "shared-plugin-data-session";
    const hookResult = spawnSync(process.execPath, [launcher, hook, "prompt"], {
      cwd: project.root,
      env,
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

    const messages = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
        name: "get_route_status",
        arguments: { contextId },
      } }),
    ];
    const mcpResult = spawnSync(process.execPath, [launcher, server], {
      cwd: project.root,
      env,
      input: `${messages.join("\n")}\n`,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    assert.equal(mcpResult.status, 0, mcpResult.stderr);
    const responses = mcpResult.stdout.trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(responses[1].result.structuredContent.autoActivation.globalEnabled, true);
    assert.deepEqual(responses[1].result.structuredContent.rootTask, {
      model: "gpt-5.6-sol",
      modelVisibility: "hook_observed",
      reasoningEffortVisibility: "host_only",
      changedByRouter: false,
    });

    await access(join(pluginData, "router.sqlite3"));
    await assert.rejects(access(join(codexHome, "adaptive-model-router-v2", "router.sqlite3")));
  } finally {
    await project.cleanup();
  }
});
