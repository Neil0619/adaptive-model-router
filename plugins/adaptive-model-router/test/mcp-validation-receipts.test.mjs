import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { temporaryProject, withRouterEnvironment, routeInput, CATALOG } from "./fixtures.mjs";
import { enrollRuntimeFixture } from "./runtime-fixtures.mjs";
import { RouterStore } from "../scripts/lib/database.mjs";
import { beginHookDispatch, endRuntimeDispatch, rejectMcpValidationReceipt } from "../scripts/lib/runtime-dispatch.mjs";
import { routeStage } from "../scripts/lib/router.mjs";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = join(pluginRoot, "scripts/mcp-server.mjs");
const owner = "validation-receipt-owner";

async function fixture(callback) {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      try {
        enrollRuntimeFixture({ home: project.home, shellRoot: pluginRoot, cwd: project.root, contextId: owner, store });
        let sequence = 0;
        const pre = (name, args) => {
          const dispatch = beginHookDispatch({ hook_event_name: "PreToolUse", session_id: owner,
            cwd: project.root, turn_id: "validation-turn", tool_use_id: `validation-call-${++sequence}`,
            tool_name: `mcp__adaptive_model_router__${name}`, tool_input: args }, { shellRoot: pluginRoot });
          endRuntimeDispatch(dispatch);
          return dispatch.receiptKey;
        };
        const call = (name, args, { threadId = "" } = {}) => {
          const env = { ...process.env, CODEX_THREAD_ID: threadId, ADAPTIVE_ROUTER_INVOCATION_ID: "" };
          const child = spawnSync(process.execPath, [serverPath], { cwd: project.root, env, encoding: "utf8", timeout: 10_000,
            input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) + "\n" });
          assert.equal(child.status, 0, child.stderr);
          const response = JSON.parse(child.stdout.trim());
          return { response, error: response.result.isError ? JSON.parse(response.result.content[0].text) : null };
        };
        const receipt = (id) => store.db.prepare("SELECT * FROM runtime_call_receipts WHERE id=?").get(id);
        const business = () => Object.fromEntries([
          "routes", "outcomes", "delegation_attempts", "delegation_children", "runtime_tasks", "runtime_stages",
          "runtime_generations", "runtime_defaults", "runtime_invocations", "runtime_migrations",
        ].filter((name) => store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
          .map((name) => [name, store.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
        const events = () => {
          const db = new DatabaseSync(join(project.home, "observations.sqlite3"), { readOnly: true });
          try { return db.prepare("SELECT payload_json FROM events WHERE component='mcp' ORDER BY seq").all().map((r) => JSON.parse(r.payload_json)); }
          finally { db.close(); }
        };
        await callback({ project, store, pre, call, receipt, business, events });
      } finally { store.close(); }
    });
  } finally { await project.cleanup(); }
}

for (const [label, name, args] of [
  ["overlong phase", "route_stage", { contextId: owner, goal: "bounded validation", phase: "x".repeat(500), evidence: {} }],
  ["malformed stage reference", "record_outcome", { contextId: owner, routeId: { mustNotReachSQLite: true } }],
  ["unknown tool", "not_a_router_tool", { contextId: owner }],
]) {
  test(`MCP ${label} rejects its exact Pre without dispatch or business changes`, async () => fixture((f) => {
    const id = f.pre(name, args), before = f.business();
    const { error } = f.call(name, args);
    assert.equal(error.code, "INVALID_INPUT");
    assert.equal(f.receipt(id).state, "rejected");
    assert.deepEqual(f.business(), before);
    const finished = f.events().findLast((e) => e.event === "finished");
    assert.equal(finished.operation, "rejected");
    assert.equal(finished.receiptKey, id);
    assert.equal(finished.identitySource, "native_hook");
    assert.match(finished.shellRuntimeDigest, /^[a-f0-9]{64}$/u);
    assert.equal(finished.runtimeDigest, null, "rejected before selected service execution");
    assert.equal(finished.runtimeState, "unknown");
    assert.equal(finished.invocationId, null);
  }));
}

test("matching trusted task env still settles only the exact invalid Pre", async () => fixture((f) => {
  const args = { contextId: owner, extra: true }, id = f.pre("get_route_status", args);
  assert.equal(f.call("get_route_status", args, { threadId: owner }).error.code, "INVALID_INPUT");
  assert.equal(f.receipt(id).state, "rejected");
}));

for (const threadId of ["", owner]) {
  test(`duplicate exact Pre payloads remain ambiguous with env=${threadId || "absent"}`, async () => fixture((f) => {
    const args = { contextId: owner, extra: true }, first = f.pre("get_route_status", args), second = f.pre("get_route_status", args);
    const before = f.business();
    assert.equal(f.call("get_route_status", args, { threadId }).error.code, "INVALID_INPUT");
    assert.equal(f.receipt(first).state, "pending"); assert.equal(f.receipt(second).state, "pending");
    assert.deepEqual(f.business(), before);
  }));
}

test("conflicting native env cannot reject another task's receipt", async () => fixture((f) => {
  const args = { contextId: owner, extra: true }, id = f.pre("get_route_status", args), before = f.business();
  assert.equal(f.call("get_route_status", args, { threadId: "another-native-task" }).error.code, "INVALID_INPUT");
  assert.equal(f.receipt(id).state, "pending"); assert.deepEqual(f.business(), before);
}));

test("a different invalid payload or context cannot clear the pending Pre", async () => fixture((f) => {
  const args = { contextId: owner, extra: true }, id = f.pre("get_route_status", args), before = f.business();
  for (const input of [{ ...args, extra: false }, { ...args, contextId: "unknown-task" }, {}, [], null]) {
    assert.equal(f.call("get_route_status", input).error.code, "INVALID_INPUT");
    assert.equal(f.receipt(id).state, "pending");
  }
  assert.deepEqual(f.business(), before);
}));

test("already rejected receipts and a missing receipt create no dispatch", async () => fixture((f) => {
  const args = { contextId: owner, extra: true }, id = f.pre("get_route_status", args);
  f.store.db.prepare("UPDATE runtime_call_receipts SET state='rejected' WHERE id=?").run(id);
  const before = f.business();
  assert.equal(f.call("get_route_status", args, { threadId: owner }).error.code, "INVALID_INPUT");
  assert.equal(f.call("get_route_status", { ...args, extra: false }, { threadId: owner }).error.code, "INVALID_INPUT");
  assert.equal(f.receipt(id).state, "rejected"); assert.deepEqual(f.business(), before);
}));

test("unregistered generation and unreferenced shell retain the receipt", async () => fixture((f) => {
  const args = { contextId: owner, extra: true }, id = f.pre("get_route_status", args);
  const generation = f.receipt(id).generation;
  f.store.db.prepare("UPDATE runtime_call_receipts SET generation=? WHERE id=?").run("0".repeat(64), id);
  assert.equal(f.call("get_route_status", args).error.code, "INVALID_INPUT");
  assert.equal(f.receipt(id).state, "pending");
  f.store.db.prepare("UPDATE runtime_call_receipts SET generation=? WHERE id=?").run(generation, id);
  f.store.db.prepare("UPDATE runtime_host_entries SET state='released'").run();
  assert.equal(f.call("get_route_status", args).error.code, "INVALID_INPUT");
  assert.equal(f.receipt(id).state, "pending");
}));

test("failed rejection settlement preserves original validation response and pending evidence", async () => fixture((f) => {
  const args = { contextId: owner, extra: true }, id = f.pre("get_route_status", args), before = f.business();
  f.store.db.exec("CREATE TRIGGER fail_receipt_settlement BEFORE UPDATE ON runtime_call_receipts BEGIN SELECT RAISE(ABORT,'fixture rejection write failure'); END;");
  assert.equal(f.call("get_route_status", args).error.code, "INVALID_INPUT");
  assert.equal(f.receipt(id).state, "pending"); assert.deepEqual(f.business(), before);
  assert.ok(f.events().some((e) => e.event === "detail" && e.operation === "failed"));
}));

test("valid MCP calls retain ordinary invocation semantics after a validation rejection", async () => fixture((f) => {
  const invalid = { contextId: owner, extra: true }, invalidId = f.pre("get_route_status", invalid);
  assert.equal(f.call("get_route_status", invalid).error.code, "INVALID_INPUT");
  assert.equal(f.receipt(invalidId).state, "rejected");
  const valid = { contextId: owner }, validId = f.pre("get_route_status", valid);
  assert.equal(f.call("get_route_status", valid).response.result.isError, false);
  assert.equal(f.receipt(validId).state, "consumed");
  const invocation = f.store.db.prepare("SELECT * FROM runtime_invocations WHERE kind='mcp:get_route_status'").all();
  assert.equal(invocation.length, 1); assert.equal(invocation[0].state, "completed");
}));

test("failed validation rollback still closes its connection and releases the write lock", async () => fixture((f) => {
  const args = { contextId: owner, extra: true }, id = f.pre("get_route_status", args);
  f.store.db.exec("CREATE TRIGGER abort_reject BEFORE UPDATE ON runtime_call_receipts BEGIN SELECT RAISE(ABORT,'injected update failure'); END;");
  const exec = DatabaseSync.prototype.exec, close = DatabaseSync.prototype.close;
  let handle, closed = false;
  try {
    DatabaseSync.prototype.exec = function(sql) {
      if (sql === "BEGIN IMMEDIATE" && this !== f.store.db) handle = this;
      if (sql === "ROLLBACK" && this === handle) throw new Error("injected rollback failure");
      return exec.call(this, sql);
    };
    DatabaseSync.prototype.close = function() {
      close.call(this);
      if (this === handle) closed = true;
    };
    assert.throws(() => rejectMcpValidationReceipt("get_route_status", args, {
      cwd: f.project.root, shellRoot: pluginRoot, env: {},
    }), /injected rollback failure/u);
    assert.equal(closed, true);
  } finally {
    DatabaseSync.prototype.exec = exec; DatabaseSync.prototype.close = close;
    if (handle && !closed) {
      try { if (handle.isTransaction) exec.call(handle, "ROLLBACK"); }
      finally { close.call(handle); }
    }
  }
  assert.equal(f.receipt(id).state, "pending");
  f.store.db.exec("BEGIN IMMEDIATE; ROLLBACK;");
}));

test("invalid unbound MCP does not initialize an existing empty business database", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, () => {
      mkdirSync(project.home, { recursive: true });
      const path = join(project.home, "router.sqlite3"), empty = new DatabaseSync(path);
      empty.close();
      const result = spawnSync(process.execPath, [serverPath], { cwd: project.root,
        env: { ...process.env, CODEX_THREAD_ID: "", ADAPTIVE_ROUTER_INVOCATION_ID: "" }, encoding: "utf8", timeout: 10_000,
        input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
          name: "get_route_status", arguments: { contextId: "unbound", extra: true },
        } }) + "\n" });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(JSON.parse(result.stdout).result.content[0].text).code, "INVALID_INPUT");
      const read = new DatabaseSync(path, { readOnly: true });
      try {
        assert.equal(read.prepare("PRAGMA user_version").get().user_version, 0);
        assert.equal(read.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n, 0);
      } finally { read.close(); }
    });
  } finally { await project.cleanup(); }
});

test("invalid unbound MCP cannot reconcile an unrelated legacy pre-dispatch outcome", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      let route;
      try {
        route = await routeStage(routeInput({ contextId: "unrelated-legacy-owner" }), {
          store, cwd: project.root, catalog: CATALOG, enforceLifecycleHooks: false, diskProbe: () => 20n * 1024n ** 3n,
        });
        assert.equal(route.action, "delegate");
      } finally { store.close(); }
      // Model an actual old persisted shape, then use no RouterStore opens
      // while asserting that this invalid caller cannot reconcile it.
      const raw = new DatabaseSync(join(project.home, "router.sqlite3"));
      try {
        const row = raw.prepare("SELECT * FROM routes WHERE route_id=?").get(route.routeId);
        raw.prepare(`INSERT INTO outcomes(route_id,project_id,context_key,category,status,gate,failure_type,
          retries,retry_reasoning,retry_environment,retry_information,retry_tooling,escalations,user_correction,payload_hash,recorded_at)
          VALUES(?,?,?,?,'failed',?,'tooling',0,0,0,0,0,0,0,?,?)`)
          .run(row.route_id, row.project_id, row.context_key, row.category, row.verification_gate, "legacy-fixture", new Date().toISOString());
        raw.prepare("UPDATE delegation_attempts SET outcome_recorded=1,outcome_status='failed' WHERE route_id=?").run(route.routeId);
        raw.prepare("UPDATE route_score_snapshots SET eligible_learning=1 WHERE route_id=?").run(route.routeId);
        const snapshot = () => Object.fromEntries(["routes", "outcomes", "delegation_attempts", "route_score_snapshots", "runtime_tasks"]
          .map(name => [name, raw.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
        const before = snapshot();
        const result = spawnSync(process.execPath, [serverPath], { cwd: project.root,
          env: { ...process.env, CODEX_THREAD_ID: "unbound", ADAPTIVE_ROUTER_INVOCATION_ID: "" }, encoding: "utf8", timeout: 10_000,
          input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
            name: "get_route_status", arguments: { contextId: "unbound", extra: true },
          } }) + "\n" });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(JSON.parse(result.stdout).result.content[0].text).code, "INVALID_INPUT");
        assert.deepEqual(snapshot(), before);
      } finally { raw.close(); }
    });
  } finally { await project.cleanup(); }
});
