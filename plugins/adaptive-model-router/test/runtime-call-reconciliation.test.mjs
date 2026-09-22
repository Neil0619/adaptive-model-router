import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, realpathSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RouterStore } from "../scripts/lib/database.mjs";
import { inspectRuntimePackage } from "../scripts/lib/runtime-package.mjs";
import { publishRuntime, ensureRuntimeTask } from "../scripts/lib/runtime-isolation.mjs";
import { beginHookDispatch, beginMcpDispatch, endRuntimeDispatch } from "../scripts/lib/runtime-dispatch.mjs";
import { rememberRootTranscript } from "../scripts/lib/stage-reconciliation.mjs";
import { payloadHash } from "../scripts/lib/io.mjs";
import { prepareRejectedRuntimeCalls, commitRejectedRuntimeCalls } from "../scripts/lib/runtime-call-reconciliation.mjs";
import { temporaryProject, withRouterEnvironment } from "./fixtures.mjs";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const event = (type, extra) => ({ type: "event_msg", payload: { type, ...extra } });
async function fixture(run, { legacyErrors = true } = {}) {
  const project = await temporaryProject("router-call-recovery-");
  try { await withRouterEnvironment(project, async () => {
    const root = join(project.root, "shell"); cpSync(source, root, { recursive: true });
    // Recovery proves the immutable old validation-before-dispatch entry.
    // Keep that actual reviewed entry, not a new server with prevention
    // disabled and not manually manufactured pending receipt state.
    const oldServer = readFileSync(join(source, "test/support/legacy-mcp-validation-server.mjs"));
    assert.equal(createHash("sha256").update(oldServer).digest("hex"), "bfe38a1cd4f83ee2580d3c0b84fb68f17b608178553733162822c3582bdb0c08");
    writeFileSync(join(root, "scripts/mcp-server.mjs"), oldServer);
    // The historical validator's dependency is frozen too. New error handling
    // cannot stand in for bytes that produced the original native rejection.
    const oldErrors = readFileSync(join(source, "test/support/legacy-request-errors.mjs"));
    assert.equal(createHash("sha256").update(oldErrors).digest("hex"), "d865446d2d13ef68c79bec11235471e45187a45bf6d6d8a204a4de9f8bcae970");
    if (legacyErrors) writeFileSync(join(root, "scripts/lib/request-errors.mjs"), oldErrors);
    const generation = inspectRuntimePackage(root), store = new RouterStore();
    try {
      store.transaction(() => publishRuntime(store.db, generation, project.home, { bootstrap: true, shellRoot: root }));
      const contextId = "fixture-root", cwd = project.root;
      const context = store.context({ cwd, contextId, authoritative: true });
      store.transaction(() => ensureRuntimeTask(store.db, context, { trustedHook: true, turnId: "old-turn" }));
      mkdirSync(join(process.env.CODEX_HOME, "sessions"), { recursive: true });
      const path = join(realpathSync(join(process.env.CODEX_HOME, "sessions")), "rollout-2026-09-22T00-00-00-fixture-root.jsonl");
      rememberRootTranscript(store.db, context, path);
      const records = [{ type: "session_meta", payload: { id: contextId, cwd } }, event("task_started", { turn_id: "old-turn" })];
      const input = { contextId, extraUnsupportedProperty: true };
      const pre = (id, args = input) => {
        const hook = spawnSync(process.execPath, [join(root, "scripts/node-launcher.mjs"), join(root, "scripts/hook.mjs"), "pre-tool-use"],
          { cwd, env: process.env, encoding: "utf8", timeout: 15000, input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: contextId,
            turn_id: "old-turn", tool_use_id: id, cwd, tool_name: "mcp__adaptive_model_router__get_route_status", tool_input: args }) });
        assert.equal(hook.status, 0, hook.stderr);
        return payloadHash([contextId, "old-turn", id]);
      };
      const call = (id, args = input) => {
        const receiptId = pre(id, args);
        const rpc = spawnSync(process.execPath, [join(root, "scripts/mcp-server.mjs")], { cwd, env: { ...process.env, CODEX_THREAD_ID: contextId },
          input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_route_status", arguments: args } }) + "\n", encoding: "utf8", timeout: 15000 });
        assert.equal(rpc.status, 0, rpc.stderr);
        const result = JSON.parse(rpc.stdout.trim()).result;
        assert.equal(result.isError, true);
        assert.equal(JSON.parse(result.content[0].text).code, "INVALID_INPUT");
        const native = event("item_completed", { thread_id: contextId, turn_id: "old-turn", started_at_ms: 1000, completed_at_ms: 1010,
          item: { type: "McpToolCall", id, server: "adaptive-model-router", tool: "get_route_status", arguments: args,
            pluginId: "adaptive-model-router@adaptive-model-router", status: "failed", result } });
        records.push(native); return { receiptId, native };
      };
      const flush = (complete = true) => writeFileSync(path, [...records, ...(complete ? [event("task_complete", { turn_id: "old-turn" })] : [])].map(JSON.stringify).join("\n") + "\n");
      const rows = () => store.db.prepare("SELECT * FROM runtime_call_receipts ORDER BY id").all();
      await run({ project, store, context, contextId, cwd, root, generation, path, records, call, pre, flush, rows,
        retainedRoot: JSON.parse(store.db.prepare("SELECT record FROM runtime_generations WHERE digest=?").get(generation.digest).record).root,
        prepare: () => prepareRejectedRuntimeCalls(store, { contextId, cwd }) });
    } finally { store.close(); }
  }); } finally { await project.cleanup(); }
}

test("real Pre to MCP schema rejection strands a receipt; proven recovery is exact, retained and idempotent", async () => {
  await fixture(async (f) => {
    const first = f.call("native-call-1");
    const unresolved = f.pre("native-call-2"); // Same payload, different native identity, no terminal result.
    f.flush();
    assert.equal(f.rows().filter(r => r.state === "pending").length, 2, "reproduces the installed validation-before-dispatch defect");
    const before = f.store.db.prepare("SELECT count(*) AS n FROM outcomes").get();
    const token = await f.prepare();
    assert.deepEqual(token.eligible.map(r => r.receiptId), [first.receiptId]);
    const result = commitRejectedRuntimeCalls(f.store, token);
    assert.equal(result.reconciled, 1);
    assert.equal(f.rows().find(r => r.id === first.receiptId).state, "rejected");
    assert.equal(f.rows().find(r => r.id === unresolved).state, "pending");
    assert.deepEqual(f.store.db.prepare("SELECT count(*) AS n FROM outcomes").get(), before);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM runtime_call_reconciliations").get().n, 1);
    assert.throws(() => f.store.db.exec("DELETE FROM runtime_call_reconciliations"), /retained/);
    assert.throws(() => f.store.db.exec("UPDATE runtime_call_reconciliations SET record='changed'"), /immutable/);
    assert.throws(() => f.store.db.exec("INSERT OR REPLACE INTO runtime_call_reconciliations SELECT * FROM runtime_call_reconciliations"), /immutable/);
    const again = commitRejectedRuntimeCalls(f.store, await f.prepare());
    assert.equal(again.reconciled, 0); assert.equal(again.alreadyReconciled, 1);
  });
});

test("new error handling cannot impersonate the reviewed historical validation dependency", async () => {
  await fixture(async f => {
    f.call("native-new-errors"); f.flush();
    const preview = await f.prepare();
    assert.equal(preview.eligible.length, 0);
    assert.match(preview.unresolved[0].reason, /unreviewed schema dependency/);
    assert.equal(f.rows()[0].state, "pending");
  }, { legacyErrors: false });
});

for (const [name, change] of [
  ["wrong native call identity", f => { f.records[2].payload.item.id = "different-call"; }],
  ["mismatched payload", f => { f.records[2].payload.item.arguments.extraUnsupportedProperty = false; }],
  ["generic terminal error", f => { f.records[2].payload.item.result.content[0].text = JSON.stringify({ code: "INTERNAL_ERROR" }); }],
  ["duplicate result identity", f => { f.records.push(structuredClone(f.records[2])); }],
  ["unfinished native turn", () => {}],
  ["wrong native thread", f => { f.records[2].payload.thread_id = "foreign-root"; }],
  ["different validation message", f => { const r = JSON.parse(f.records[2].payload.item.result.content[0].text); r.message += " changed"; f.records[2].payload.item.result.content[0].text = JSON.stringify(r); }],
  ["restarted same turn", f => { f.records.push(event("task_started", { turn_id: "old-turn" })); }],
  ["result outside its turn", f => { f.records.splice(2, 0, event("task_started", { turn_id: "foreign-turn" })); }],
  ["result after terminal marker", f => { f.records.splice(2, 0, event("task_complete", { turn_id: "old-turn" })); }],
]) test(`reconciliation preserves pending on ${name}`, async () => {
  await fixture(async f => {
    f.call("native-call-1"); change(f); f.flush(name !== "unfinished native turn");
    const token = await f.prepare(); assert.equal(token.eligible.length, 0);
    commitRejectedRuntimeCalls(f.store, token); assert.equal(f.rows()[0].state, "pending");
  });
});

test("commit rejects copied tokens, changed transcript and stale ledger atomically", async () => {
  await fixture(async f => {
    f.call("native-call-1"); f.flush();
    let token = await f.prepare();
    assert.throws(() => commitRejectedRuntimeCalls(f.store, structuredClone(token)), /proof/);
    appendFileSync(f.path, JSON.stringify(event("task_started", { turn_id: "new-turn" })) + "\n");
    assert.throws(() => commitRejectedRuntimeCalls(f.store, token), /changed/);
    token = await f.prepare();
    f.store.db.prepare("UPDATE runtime_call_receipts SET state='consumed'").run();
    assert.throws(() => commitRejectedRuntimeCalls(f.store, token), /changed/);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='runtime_call_reconciliations'").get().n, 0);
  });
});

test("a replaced source root or changed reviewed runtime cannot authorize recovery", async () => {
  await fixture(async f => {
    f.call("native-call-1"); f.flush();
    f.records[0].payload.id = "foreign-root"; f.flush();
    await assert.rejects(f.prepare(), /identity/);
    f.records[0].payload.id = f.contextId; f.flush();
    appendFileSync(join(f.retainedRoot, "scripts/mcp-server.mjs"), "\n// changed\n");
    const token = await f.prepare(); assert.equal(token.eligible.length, 0);
    assert.equal(f.rows()[0].state, "pending");
  });
});

test("an interrupted old turn supports exact completed rejection without claiming business success", async () => {
  await fixture(async f => {
    f.call("native-call-1");
    f.records.push(event("turn_aborted", { turn_id: "old-turn", reason: "interrupted" })); f.flush(false);
    const token = await f.prepare(); assert.equal(token.eligible.length, 1);
    const result = commitRejectedRuntimeCalls(f.store, token);
    assert.equal(result.records[0].terminalKind, "turn_aborted");
    assert.equal(result.businessOutcomesChanged, false);
  });
});

test("two-row recovery is atomic when one original receipt changes", async () => {
  await fixture(async f => {
    const a = f.call("call-a"), b = f.call("call-b"); f.flush();
    const proof = await f.prepare(); assert.equal(proof.eligible.length, 2);
    f.store.db.prepare("UPDATE runtime_call_receipts SET payload_digest=? WHERE id=?").run("a".repeat(64), b.receiptId);
    assert.throws(() => commitRejectedRuntimeCalls(f.store, proof), /ledger changed/);
    assert.equal(f.rows().find(r => r.id === a.receiptId).state, "pending");
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='runtime_call_reconciliations'").get().n, 0);
  });
});

for (const [name, change] of [
  ["remembered path", f => { const other = join(dirname(f.path), "rollout-2026-09-22T01-00-00-fixture-root.jsonl"); writeFileSync(other, readFileSync(f.path)); rememberRootTranscript(f.store.db, f.context, other); }],
  ["runtime generation row", f => { f.store.db.prepare("UPDATE runtime_generations SET record=json_set(record,'$.testMutation',1) WHERE digest=?").run(f.generation.digest); }],
  ["retained package bytes", f => { appendFileSync(join(f.retainedRoot, "scripts/lib/schema.mjs"), "\n// changed\n"); }],
]) test(`prepared recovery rejects changed ${name}`, async () => {
  await fixture(async f => {
    f.call("call-a"); f.flush(); const proof = await f.prepare(); assert.equal(proof.eligible.length, 1);
    change(f); assert.throws(() => commitRejectedRuntimeCalls(f.store, proof), /changed/);
    assert.equal(f.rows()[0].state, "pending");
  });
});

test("immutable recovery audit survives real terminal receipt retention pruning", async () => {
  await fixture(async f => {
    const { receiptId } = f.call("call-original"); f.flush(); commitRejectedRuntimeCalls(f.store, await f.prepare());
    for (let i = 0; i < 130; i++) {
      const args = { contextId: f.contextId };
      const pre = beginHookDispatch({ hook_event_name: "PreToolUse", session_id: f.contextId, turn_id: "old-turn", tool_use_id: `gc-${i}`,
        cwd: f.cwd, tool_name: "mcp__adaptive_model_router__get_route_status", tool_input: args }); endRuntimeDispatch(pre);
      endRuntimeDispatch(beginMcpDispatch("get_route_status", args, { cwd: f.cwd, env: { CODEX_THREAD_ID: f.contextId } }));
    }
    assert.ok(!f.rows().some(r => r.id === receiptId));
    const repeated = commitRejectedRuntimeCalls(f.store, await f.prepare());
    assert.equal(repeated.reconciled, 0); assert.equal(repeated.alreadyReconciled, 1);
  });
});

test("loaded verifier refuses changed dependency bytes before preparation", async () => {
  await fixture(async f => {
    const code = `import {appendFileSync} from 'node:fs';
      const {prepareRejectedRuntimeCalls}=await import(${JSON.stringify(new URL("../scripts/lib/runtime-call-reconciliation.mjs", new URL(`file://${join(f.root, "test/test.mjs")}`)).href)});
      appendFileSync(${JSON.stringify(join(f.root, "scripts/lib/io.mjs"))}, '\\n// changed after import\\n');
      try { await prepareRejectedRuntimeCalls({}, {}); process.exitCode=1; }
      catch(error) { if(!/loaded verifier changed/.test(error.message)) throw error; }`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: f.cwd, env: process.env, encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
  });
});

test("validating shell evidence changed at the transaction seam blocks recovery", async () => {
  await fixture(async f => {
    const call = f.call("call-a"); f.flush(); const token = await f.prepare(); assert.equal(token.eligible.length, 1);
    const transaction = f.store.transaction.bind(f.store);
    f.store.transaction = action => {
      const observations = new DatabaseSync(join(f.project.home, "observations.sqlite3"));
      try { observations.prepare("UPDATE events SET payload_json=json_set(payload_json,'$.shellRuntimeDigest',?) WHERE json_extract(payload_json,'$.receiptKey')=?")
        .run("a".repeat(64), call.receiptId); } finally { observations.close(); }
      return transaction(action);
    };
    assert.throws(() => commitRejectedRuntimeCalls(f.store, token), /shell observation changed/);
    assert.equal(f.rows()[0].state, "pending");
  });
});

test("CLI refuses a reviewed preview when exact native evidence changed", async () => {
  await fixture(async f => {
    const call = f.call("call-a"); f.flush();
    const cli = args => spawnSync(process.execPath, [join(source, "scripts/reconcile-native-call-rejections.mjs"), "--context", f.contextId, ...args],
      { cwd: f.cwd, env: process.env, encoding: "utf8", timeout: 15000 });
    const preview = cli([]); assert.equal(preview.status, 0, preview.stderr);
    const digest = JSON.parse(preview.stdout).evidenceDigest;
    call.native.payload.started_at_ms -= 1; f.flush();
    const applied = cli(["--apply", "--expect-digest", digest]);
    assert.equal(applied.status, 7, applied.stderr); assert.match(applied.stderr, /preview changed/);
    assert.equal(f.rows()[0].state, "pending");
  });
});
