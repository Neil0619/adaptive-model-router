import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RouterStore } from "../scripts/lib/database.mjs";
import { errorObservation, publicRequestError } from "../scripts/lib/request-errors.mjs";
import { classifyDiagnosticError } from "../scripts/lib/diagnostics.mjs";
import { observationPath } from "../scripts/lib/observability.mjs";
import { temporaryProject, withRouterEnvironment } from "./fixtures.mjs";
import { enrollRuntimeFixture } from "./runtime-fixtures.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function finished(path, component) {
  const db = new DatabaseSync(observationPath(path), { readOnly: true });
  try {
    return JSON.parse(db.prepare("SELECT payload_json FROM events WHERE component=? AND event='finished' ORDER BY seq DESC LIMIT 1")
      .get(component).payload_json);
  } finally { db.close(); }
}
async function fixture(run) {
  const project = await temporaryProject("router-error-classification-");
  try { await withRouterEnvironment(project, async () => {
    const store = new RouterStore();
    try { await run({ project, store }); } finally { store.close(); }
  }); } finally { await project.cleanup(); }
}

test("unmarked internal syntax failures are not caller input failures or public exception text", () => {
  const secret = "private persisted state marker";
  const error = new SyntaxError(secret);
  assert.deepEqual(errorObservation(error), { errorCode: "INTERNAL_ERROR", errorCategory: "internal" });
  assert.equal(classifyDiagnosticError(error), "unknown", "opt-in diagnostics must not invent an input origin either");
  const result = JSON.parse(publicRequestError(error));
  assert.equal(result.code, "INTERNAL_ERROR");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test("a valid MCP request with corrupt retained generation is observed as failed internal state", async () => {
  await fixture(({ project, store }) => {
    const contextId = "private-error-classification";
    enrollRuntimeFixture({ home: project.home, shellRoot: root, cwd: project.root, contextId, store });
    const invoke = (args = { contextId }) => {
      const rpc = spawnSync(process.execPath, [join(root, "scripts/mcp-server.mjs")], {
        cwd: project.root, env: { ...process.env, CODEX_THREAD_ID: contextId, ADAPTIVE_ROUTER_INVOCATION_ID: "" },
        input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_route_status", arguments: args } }) + "\n",
        encoding: "utf8", timeout: 15000,
      });
      assert.equal(rpc.status, 0, rpc.stderr);
      return JSON.parse(rpc.stdout.trim()).result;
    };
    assert.equal(invoke().isError, false);
    const marker = "private-corrupt-record";
    store.db.prepare("UPDATE runtime_generations SET record=?").run(`{${marker}`);
    const result = invoke(), error = JSON.parse(result.content[0].text);
    assert.equal(result.isError, true);
    assert.equal(error.code, "INTERNAL_ERROR");
    assert.doesNotMatch(JSON.stringify(error), new RegExp(marker));
    const event = finished(store.path, "mcp");
    assert.equal(event.operation, "failed");
    assert.equal(event.errorCategory, "internal");
    assert.equal(event.errorCode, "INTERNAL_ERROR");
    const invalid = invoke({ contextId, unsupported: true });
    assert.equal(JSON.parse(invalid.content[0].text).code, "INVALID_INPUT", "schema rejection stays an input error before state dispatch");
    assert.equal(finished(store.path, "mcp").operation, "rejected");
  });
});

for (const [name, script, args, component] of [
  ["launcher", "node-launcher.mjs", [join(root, "scripts/hook.mjs"), "session-start"], "launcher"],
  ["direct hook", "hook.mjs", ["session-start"], "hook"],
  ["stdio bridge", "stdio-tool.mjs", [], "bridge"],
]) test(`malformed external JSON remains an input error at the ${name} boundary`, async () => {
  await fixture(({ project, store }) => {
    const result = spawnSync(process.execPath, [join(root, "scripts", script), ...args], {
      cwd: project.root, env: { ...process.env, ADAPTIVE_ROUTER_NODE: process.execPath, ADAPTIVE_ROUTER_INVOCATION_ID: "" },
      encoding: "utf8", input: "{malformed-external-json\n", timeout: 15000,
    });
    assert.notEqual(result.status, null, result.stderr);
    const event = finished(store.path, component);
    assert.equal(event.errorCode, "INVALID_INPUT", result.stderr);
    assert.equal(event.errorCategory, "input_validation");
    assert.equal(event.lifecycle, "completed");
    assert.doesNotMatch(result.stderr, /malformed-external-json/);
  });
});

test("malformed MCP framing retains the JSON-RPC parse error", async () => {
  await fixture(({ project }) => {
    const result = spawnSync(process.execPath, [join(root, "scripts/mcp-server.mjs")], {
      cwd: project.root, env: process.env, encoding: "utf8", input: "{malformed-json\n", timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).error.code, -32700);
  });
});
