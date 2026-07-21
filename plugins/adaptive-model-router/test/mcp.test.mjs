import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { temporaryProject } from "./fixtures.mjs";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = join(pluginRoot, "scripts", "mcp-server.mjs");

function checkClosed(schema, path = "schema") {
  if (schema.type === "object") assert.equal(schema.additionalProperties, false, path);
  for (const [key, child] of Object.entries(schema.properties || {})) checkClosed(child, `${path}.${key}`);
  if (schema.items) checkClosed(schema.items, `${path}[]`);
}

test("MCP implements parse errors, discovery, strict validation, and unknown methods", async () => {
  const project = await temporaryProject();
  try {
    const messages = [
      "not-json",
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "unknown/method", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "route_stage", arguments: {
        goal: "hello", phase: "question", evidence: {}, contextId: "mcp", forged: true,
      } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_route_status", arguments: { contextId: "mcp" } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "get_route_history", arguments: {
        contextId: "mcp", limit: 5, action: "delegate",
      } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "get_route_history", arguments: {
        contextId: "mcp", limit: 0,
      } } }),
    ];
    const result = spawnSync(process.execPath, [serverPath], {
      input: `${messages.join("\n")}\n`,
      encoding: "utf8",
      cwd: project.root,
      env: { ...process.env, ADAPTIVE_ROUTER_HOME: project.home, ADAPTIVE_ROUTER_LOCAL_ONLY: "1" },
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const responses = result.stdout.trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(responses.length, 8);
    assert.equal(responses[0].error.code, -32700);
    assert.equal(responses[1].result.serverInfo.version, "0.2.0");
    const tools = responses[2].result.tools;
    assert.deepEqual(tools.map((tool) => tool.name), [
      "route_stage",
      "record_outcome",
      "get_route_status",
      "get_route_history",
      "set_route_override",
      "list_policy_proposals",
      "approve_policy_proposal",
      "reject_policy_proposal",
      "rollback_policy",
      "configure_router",
      "diagnose_router",
      "clear_project_data",
    ]);
    for (const tool of tools) checkClosed(tool.inputSchema, tool.name);
    assert.equal(responses[3].error.code, -32601);
    assert.equal(responses[4].result.isError, true);
    assert.match(responses[4].result.content[0].text, /not allowed/);
    assert.equal(responses[5].result.isError, false);
    assert.doesNotMatch(JSON.stringify(responses[5]), new RegExp(project.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(responses[6].result.isError, false);
    assert.deepEqual(responses[6].result.structuredContent.rootTask, {
      modelVisibility: "host_managed",
      changedByRouter: false,
    });
    assert.deepEqual(responses[6].result.structuredContent.routes, []);
    assert.equal(responses[7].result.isError, true);
    assert.match(responses[7].result.content[0].text, />= 1/);
  } finally {
    await project.cleanup();
  }
});
