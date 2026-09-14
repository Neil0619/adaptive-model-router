#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";

const [a, b, home, worker] = process.argv.slice(2);
// Fail before importing either writer or opening SQLite. The third argument
// is the disposable fixture root, never a substitute for explicit data env.
try {
  if (!home || !/^router-writer-qualification-[A-Za-z0-9]+$/u.test(basename(home))
    || realpathSync(dirname(home)) !== realpathSync(tmpdir()) || !lstatSync(home).isDirectory() || lstatSync(home).isSymbolicLink()
    || process.env.ADAPTIVE_ROUTER_LOCAL_ONLY !== "1"
    || !process.env.ADAPTIVE_ROUTER_HOME || resolve(process.env.ADAPTIVE_ROUTER_HOME) !== resolve(home, "state")
    || !process.env.PLUGIN_DATA || resolve(process.env.PLUGIN_DATA) !== resolve(home, "state")
    || !process.env.CODEX_HOME || resolve(process.env.CODEX_HOME) !== resolve(home, "codex")) throw new Error("inconsistent or non-disposable verification home");
  for (const path of [join(home, "state"), join(home, "codex"), ...["router.sqlite3", "router.sqlite3-wal", "router.sqlite3-shm"].map((file) => join(home, "state", file))]) {
    try { if (lstatSync(path).isSymbolicLink()) throw new Error("redirected verification state"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
} catch {
  process.stderr.write("Writer verification requires an explicit consistent isolated temporary home; no writer was opened.\n");
  process.exit(2);
}
const moduleAt = (root, name) => import(pathToFileURL(join(root, "scripts/lib", `${name}.mjs`)).href);
const catalog = [{ slug: "gpt-6-astra", visibility: "list", priority: 0, supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"] }];

async function stage(root, id, { hold = false, existing = null, limited = false } = {}) {
  const [{ RouterStore }, { routeStage }, gate, { recordOutcome }, { openPrivateState }] = await Promise.all([
    moduleAt(root, "database"), moduleAt(root, "router"), moduleAt(root, "delegation-gate"), moduleAt(root, "learning"), moduleAt(root, "private-state")]);
  const store = new RouterStore();
  try {
    const context = store.context({ cwd: home, contextId: id });
    const route = existing || await routeStage({ contextId: id, goal: "Implement the specified Unicode parser 数据 with tests.", phase: "implementation",
      evidence: { workProduct: true, requirementsSettled: true, strongVerification: true },
      hostCapabilities: { delegation: { available: true, invocation: "direct", targets: [{ model: "gpt-6-astra", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] }] } } },
    { store, cwd: home, catalog, enforceLifecycleHooks: false, diskProbe: () => 20n * 1024n ** 3n });
    if (limited) { assert.equal(route.action, "continue"); assert.deepEqual(route.reasonCodes, ["ROUTER_GLOBAL_PENDING_LIMIT"]); return; }
    assert.equal(route.action, "delegate");
    const attempt = store.db.prepare("SELECT * FROM delegation_attempts WHERE route_id=?").get(route.routeId);
    assert.ok(openPrivateState(store.db, attempt.context_package).includes("数据"));
    if (hold) return route;
    const toolInput = { task_name: route.carrier.taskName, message: route.carrier.message, model: route.target.model,
      reasoning_effort: route.target.effort, fork_turns: "none" };
    const handshake = { taskName: route.carrier.taskName, turnId: `turn-${id}`, toolUseId: `tool-${id}`, toolInput };
    store.transaction(() => assert.equal(gate.consumeDelegationTicket(store.db, context, handshake).allowed, true));
    store.transaction(() => gate.observeAgentResult(store.db, context, { ...handshake, toolResponse: { no_agent_created: true } }));
    const outcome = { contextId: id, routeId: route.routeId, status: "failed", gate: route.verificationGate,
      failureType: "tooling", retries: 0, retryBreakdown: { reasoning: 0, environment: 0, information: 0, tooling: 0 }, escalations: 0, userCorrection: false };
    assert.equal(recordOutcome(outcome, { store, cwd: home }).recorded, true);
    assert.equal(recordOutcome(outcome, { store, cwd: home }).idempotent, true);
    assert.throws(() => recordOutcome({ ...outcome, status: "passed", failureType: null }, { store, cwd: home }));
    assert.throws(() => store.db.prepare("UPDATE outcomes SET status='invented' WHERE route_id=?").run(route.routeId));
    assert.equal(store.db.prepare("SELECT finalized_at FROM delegation_attempts WHERE route_id=?").get(route.routeId).finalized_at !== null, true);
  } finally { store.close(); }
}

try {
  if (worker) { for (let i = 0; i < 3; i++) await stage(a, `${worker}-${i}`); }
  else {
    for (let i = 0; i < 4; i++) await stage(i % 2 ? b : a, `alternating-${i}`);
    const run = (root, id) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), root, root, home, id], { env: process.env, stdio: ["ignore", "ignore", "pipe"] });
      let errors = ""; child.stderr.on("data", (data) => { errors += data; });
      child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(errors)));
    });
    const results = await Promise.allSettled([run(a, "concurrent-a"), run(b, "concurrent-b")]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    const held = [];
    for (let i = 0; i < 10; i++) held.push(await stage(i % 2 ? b : a, `held-${i}`, { hold: true }));
    for (const root of [a, b]) await stage(root, `over-cap-${root === a ? "a" : "b"}`, { limited: true });
    // Each opposite writer consumes the other's real encrypted ticket and
    // settles its terminal outcome. All ten shared reservations release once.
    for (let i = 0; i < held.length; i++) await stage(i % 2 ? a : b, `held-${i}`, { existing: held[i] });
    for (const root of [a, b]) {
      const { RouterStore } = await moduleAt(root, "database");
      const store = new RouterStore();
      try {
        assert.equal(store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n, 20);
        assert.equal(store.db.prepare("SELECT count(*) AS n FROM delegation_attempts WHERE finalized_at IS NULL").get().n, 0);
        assert.equal(store.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
        assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
      } finally { store.close(); }
    }
    process.stdout.write("20 real alternating/concurrent/shared-cap stages; global ten, cross-writer tickets, constraints, encoding, idempotency and outcomes verified\n");
  }
} catch (error) { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; }
