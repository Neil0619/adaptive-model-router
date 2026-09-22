import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { temporaryProject } from "./fixtures.mjs";
import { enrollRuntimeFixture } from "./runtime-fixtures.mjs";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = join(pluginRoot, "scripts", "mcp-server.mjs");
const runtimeVersion = JSON.parse(readFileSync(join(pluginRoot, "runtime.json"), "utf8")).runtimeVersion;

function checkClosed(schema, path = "schema") {
  if (schema.type === "object") assert.equal(schema.additionalProperties, false, path);
  for (const [key, child] of Object.entries(schema.properties || {})) checkClosed(child, `${path}.${key}`);
  if (schema.items) checkClosed(schema.items, `${path}[]`);
}

test("MCP implements parse errors, discovery, strict validation, and unknown methods", async () => {
  const project = await temporaryProject();
  try {
    enrollRuntimeFixture({ home: project.home, shellRoot: pluginRoot, cwd: project.root, contextId: "mcp" });
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
      JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "route_stage", arguments: {
        goal: "Rename 100 generated fixture keys using the fixed mapping.",
        phase: "implementation",
        evidence: { workProduct: true, mechanical: true, requirementsSettled: true, batchSize: 100 },
        contextId: "mcp",
        hostCapabilities: {
          delegation: {
            available: true,
            invocation: "direct",
            targets: [
              { model: "gpt-6-astra", efforts: ["low", "medium", "high"] },
            ],
          },
        },
      } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "configure_router", arguments: {
        contextId: "mcp", scope: "project", autoActivate: true,
      } } }),
    ];
    const result = spawnSync(process.execPath, [serverPath], {
      input: `${messages.join("\n")}\n`,
      encoding: "utf8",
      cwd: project.root,
      env: { ...process.env, ADAPTIVE_ROUTER_HOME: project.home, CODEX_THREAD_ID: "mcp", ADAPTIVE_ROUTER_LOCAL_ONLY: "1" },
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const responses = result.stdout.trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(responses.length, 10);
    assert.equal(responses[0].error.code, -32700);
    assert.equal(responses[1].result.serverInfo.version, runtimeVersion);
    const tools = responses[2].result.tools;
    assert.deepEqual(tools.map((tool) => tool.name), [
      "get_model_policy", "preview_model_policy", "activate_model_policy", "rollback_model_policy",
      "route_stage",
      "record_outcome",
      "manage_stage",
      "get_route_status",
      "get_route_history",
      "set_route_override",
      "list_policy_proposals",
      "approve_policy_proposal",
      "reject_policy_proposal",
      "rollback_policy",
      "rebase_policy_proposal",
      "get_learning_status",
      "reanchor_scoring_profile",
      "shadow_route_stage",
      "configure_router",
      "resolve_host_model_intent",
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
      reasoningEffortVisibility: "host_only",
      changedByRouter: false,
    });
    assert.deepEqual(responses[6].result.structuredContent.routes, []);
    assert.equal(responses[7].result.isError, true);
    assert.match(responses[7].result.content[0].text, />= 1/);
    assert.equal(responses[8].result.isError, false);
    assert.equal(responses[8].result.structuredContent.action, "continue");
    assert.ok(responses[8].result.structuredContent.reasonCodes.some((reasonCode) => [
      "HOOK_TRUST_REQUIRED",
      "HOST_HOOK_SET_MISMATCH",
      "HOST_HOOK_STATUS_UNAVAILABLE",
      "HOST_LIFECYCLE_ROUND_TRIP_UNPROVEN",
    ].includes(reasonCode)));
    assert.equal(responses[8].result.structuredContent.target, undefined);
    assert.equal(responses[9].result.isError, true);
    const journal = new DatabaseSync(join(project.home, "observations.sqlite3"), { readOnly: true });
    const main = new DatabaseSync(join(project.home, "router.sqlite3"), { readOnly: true });
    try {
      const observed = journal.prepare("SELECT payload_json FROM events WHERE component='mcp' AND event='finished' ORDER BY seq").all().map((row) => JSON.parse(row.payload_json));
      assert.equal(observed.length, 6);
      assert.deepEqual(observed.map((e) => e.operation), ["rejected", "succeeded", "succeeded", "rejected", "degraded", "rejected"]);
      const failed = observed.at(-1);
      assert.equal(failed.lifecycle, "completed");
      assert.equal(failed.identitySource, "native_dispatch");
      assert.equal(main.prepare("SELECT state FROM runtime_invocations WHERE id=?").get(failed.invocationId).state, "completed");
      assert.equal(failed.runtimeState, "entered");
      assert.match(failed.runtimeDigest, /^[a-f0-9]{64}$/u);
    } finally { main.close(); journal.close(); }
  } finally {
    await project.cleanup();
  }
});
