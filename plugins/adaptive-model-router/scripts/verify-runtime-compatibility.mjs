#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { inspectRuntimePackage } from "./lib/runtime-package.mjs";
import { readRuntimeDescriptor } from "./lib/runtime-loader.mjs";
import { reviewedLegacyRuntime } from "./lib/reviewed-legacy-runtime.mjs";

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
const catalog = [
  { slug: "gpt-6-astra", visibility: "list", priority: 0, supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { slug: "gpt-6-sol", visibility: "list", priority: 1, supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { slug: "gpt-6-luna", visibility: "list", priority: 2, supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"] },
];
const limits = new Map();
for (const root of new Set([a, b])) {
  const legacy = readRuntimeDescriptor(root).shellProtocolVersion === 1;
  const record = inspectRuntimePackage(root, { legacy });
  const limit = legacy ? reviewedLegacyRuntime(record)
    : { pendingLimit: 10, capacityReason: "ROUTER_GLOBAL_PENDING_LIMIT" };
  assert.ok(limit, "An unreviewed legacy writer cannot choose the verification contract");
  assert.equal((await moduleAt(root, "delegation-gate")).ROUTER_GLOBAL_PENDING_LIMIT, limit.pendingLimit);
  limits.set(root, limit);
}

async function stage(root, id, { hold = false, existing = null, limited = false, evidence = {}, goal = "Implement the specified Unicode parser 数据 with tests." } = {}) {
  const [{ RouterStore }, { routeStage }, gate, { recordOutcome }, { openPrivateState }] = await Promise.all([
    moduleAt(root, "database"), moduleAt(root, "router"), moduleAt(root, "delegation-gate"), moduleAt(root, "learning"), moduleAt(root, "private-state")]);
  const store = new RouterStore();
  try {
    const context = store.context({ cwd: home, contextId: id });
    const route = existing || await routeStage({ contextId: id, goal, phase: "work",
      evidence: { workProduct: true, requirementsSettled: true, strongVerification: true, ...evidence },
      hostCapabilities: { delegation: { available: true, invocation: "direct", targets: catalog.map(entry => ({ model: entry.slug, efforts: entry.supported_reasoning_levels })) } } },
    { store, cwd: home, catalog, enforceLifecycleHooks: false, diskProbe: () => 20n * 1024n ** 3n });
    if (limited) { assert.equal(route.action, "continue"); assert.deepEqual(route.reasonCodes, [limits.get(root).capacityReason]); return; }
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
    return route;
  } finally { store.close(); }
}

async function economyPolicyCompatibility() {
  const policies = await Promise.all([moduleAt(a, "model-policy"), moduleAt(b, "model-policy")]);
  const upgraded = policies.findIndex(module => module.ECONOMY_MODEL_POLICY);
  if (upgraded < 0) return;
  const root = [a, b][upgraded], other = [b, a][upgraded];
  const { RouterStore } = await moduleAt(root, "database");
  const api = await moduleAt(root, "model-policy-store");
  const candidate = policies[upgraded].ECONOMY_MODEL_POLICY;
  const store = new RouterStore();
  try {
    const original = api.readModelPolicy(store.db);
    const observedReaders = new Map();
    const legacy = () => store.db.prepare("SELECT * FROM meta WHERE key IN ('model_policy:active','model_policy:activation-lineage') ORDER BY key").all();
    const current = () => store.db.prepare("SELECT * FROM meta WHERE key IN ('model_policy:v2:active','model_policy:v2:activation-lineage') ORDER BY key").all();
    const originalLegacy = legacy();
    assert.equal(api.activateModelPolicy(store, { definition: candidate.definition, expectedDigest: original.digest }).digest, candidate.digest);
    assert.deepEqual(legacy(), originalLegacy, "v2 activation cannot change retained v1 pointers or lineage");
    for (const [index, [evidence, target]] of [
      [{}, { model: "gpt-6-luna", effort: "medium" }],
      [{ strongVerification: false }, { model: "gpt-6-sol", effort: "high" }],
      [{ highFailureCost: true }, { model: "gpt-6-astra", effort: "high" }],
    ].entries()) {
      const id = `economy-${index}`;
      const route = await stage(root, id, { evidence, hold: true });
      assert.deepEqual(route.target, target);
      // A real retained writer settles B's ticket and outcome without needing
      // to interpret B's policy or changing historical decision meaning.
      await stage(other, id, { existing: route });
      for (const [readerIndex, reader] of [a, b].entries()) {
        const { RouterStore: Reader } = await moduleAt(reader, "database");
        const readerApi = await moduleAt(reader, "model-policy-store");
        const instance = new Reader();
        try {
          const observed = readerApi.readModelPolicy(instance.db).digest;
          assert.equal(observed, policies[readerIndex].ECONOMY_MODEL_POLICY ? candidate.digest : original.digest);
          const role = observed === candidate.digest ? "v2" : "legacy";
          if (observedReaders.has(readerIndex)) assert.equal(observedReaders.get(readerIndex), role);
          observedReaders.set(readerIndex, role);
          const context = instance.context({ cwd: home, contextId: id });
          assert.deepEqual(instance.routeHistory(context).routes[0].target, target);
          assert.ok(instance.status(context).modelPolicy);
        } finally { instance.close(); }
      }
    }
    let legacyUpdate = null;
    if (observedReaders.get(0) === "legacy" && observedReaders.get(1) === "v2") {
      const held = await stage(a, "retained-policy-reader", { hold: true });
      const unfinished = store.db.prepare("SELECT * FROM delegation_attempts WHERE route_id=?").get(held.routeId);
      assert.equal(unfinished.finalized_at, null);
      const { RouterStore: LegacyStore } = await moduleAt(a, "database"), legacyApi = await moduleAt(a, "model-policy-store");
      const retainedReader = new LegacyStore();
      try { assert.equal(legacyApi.readModelPolicy(retainedReader.db).digest, original.digest); }
      finally { retainedReader.close(); }
      assert.equal(api.readModelPolicy(store.db).digest, candidate.digest);
      assert.deepEqual(store.db.prepare("SELECT * FROM delegation_attempts WHERE route_id=?").get(held.routeId), unfinished);
      assert.deepEqual(legacy(), originalLegacy);
      await stage(b, "retained-policy-reader", { existing: held });
      const legacyWriter = new LegacyStore();
      try {
        const currentBefore = current();
        const definition = { ...original.definition, id: "legacy-isolation-characterization" };
        const changed = legacyApi.activateModelPolicy(legacyWriter, { definition, expectedDigest: original.digest });
        assert.equal(changed.activated, true);
        assert.equal(legacyApi.readModelPolicy(legacyWriter.db).digest, changed.digest);
        assert.equal(api.readModelPolicy(store.db).digest, candidate.digest, "actual legacy policy writes cannot select a v2 reader policy");
        assert.deepEqual(current(), currentBefore, "legacy activation preserves the v2 pointer and lineage");
        legacyUpdate = { digest: changed.digest, snapshot: legacy() };
      } finally { legacyWriter.close(); }
    }
    assert.equal(api.rollbackModelPolicy(store, { expectedDigest: candidate.digest }).digest, original.digest);
    assert.equal(api.readModelPolicy(store.db).digest, original.digest);
    assert.deepEqual(legacy(), legacyUpdate?.snapshot || originalLegacy, "v2 rollback cannot overwrite the independently changed legacy namespace");
    assert.equal(store.db.prepare("SELECT value FROM meta WHERE key='model_policy:v2:active'").get().value, original.digest);
    if (legacyUpdate) {
      const { RouterStore: LegacyStore } = await moduleAt(a, "database"), legacyApi = await moduleAt(a, "model-policy-store");
      const legacyWriter = new LegacyStore();
      const currentBefore = current();
      try { assert.equal(legacyApi.rollbackModelPolicy(legacyWriter, { expectedDigest: legacyUpdate.digest }).digest, original.digest); }
      finally { legacyWriter.close(); }
      assert.deepEqual(current(), currentBefore, "legacy rollback preserves the v2 pointer and lineage");
      // The real legacy activate/rollback pair initializes its own lineage
      // when none existed. Its active policy returns to the original value;
      // that legitimate legacy history must not be erased for this check.
      const expectedLegacy = originalLegacy.some(row => row.key === "model_policy:activation-lineage")
        ? originalLegacy : [{ key: "model_policy:activation-lineage", value: JSON.stringify([original.digest]) }, ...originalLegacy];
      assert.deepEqual(legacy().map(row => ({ ...row })), expectedLegacy.map(row => ({ ...row })));
    }
    process.stdout.write("Schema2 policy isolation, three economy targets, retained startup/history and cross-writer outcomes verified\n");
    process.stdout.write(`MODEL_POLICY_READER_ISOLATION=${JSON.stringify({ schema: "model-policy-reader-isolation/1",
      sourceReader: observedReaders.get(0), candidateReader: observedReaders.get(1) })}\n`);
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
    const owners = [];
    const sharedLimit = Math.min(limits.get(a).pendingLimit, limits.get(b).pendingLimit);
    for (let i = 0; i < 10; i++) {
      const preferred = i % 2 ? b : a;
      const owner = i < limits.get(preferred).pendingLimit ? preferred
        : [a, b].find(root => i < limits.get(root).pendingLimit);
      assert.ok(owner, "The current writer must admit ten unresolved reservations");
      owners.push(owner);
      held.push(await stage(owner, `held-${i}`, { hold: true }));
      if (i + 1 === sharedLimit && sharedLimit < 10) {
        for (const root of [a, b].filter(root => limits.get(root).pendingLimit === sharedLimit))
          await stage(root, `legacy-cap-${root === a ? "a" : "b"}`, { limited: true });
      }
    }
    for (const root of [a, b]) await stage(root, `over-cap-${root === a ? "a" : "b"}`, { limited: true });
    // Each opposite writer consumes the other's real encrypted ticket and
    // settles its terminal outcome. All ten shared reservations release once.
    for (let i = 0; i < held.length; i++) await stage(owners[i] === a ? b : a, `held-${i}`, { existing: held[i] });
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
    process.stdout.write("20 real alternating/concurrent/shared-cap stages; global ten, original legacy caps, cross-writer tickets, constraints, encoding, idempotency and outcomes verified\n");
    await economyPolicyCompatibility();
  }
} catch (error) { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; }
