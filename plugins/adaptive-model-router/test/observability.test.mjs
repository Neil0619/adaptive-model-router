import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { temporaryProject, withRouterEnvironment, routeInput, CATALOG, observeNoChildRoute } from "./fixtures.mjs";
import { RouterStore } from "../scripts/lib/database.mjs";
import { callRouterTool } from "../scripts/lib/service.mjs";
import { routeStage } from "../scripts/lib/router.mjs";
import { recordOutcome } from "../scripts/lib/learning.mjs";
import { appendObservation, observationPath, observationGapPath, beginObservation } from "../scripts/lib/observability.mjs";
import { readHealth } from "../scripts/lib/health-reader.mjs";

function events(path) {
  const db = new DatabaseSync(observationPath(path), { readOnly: true });
  try { return db.prepare("SELECT payload_json FROM events ORDER BY seq").all().map((r) => JSON.parse(r.payload_json)); }
  finally { db.close(); }
}
async function fixture(run) {
  const project = await temporaryProject();
  try { await withRouterEnvironment(project, async () => {
    const store = new RouterStore();
    try { await run({ store, project }); } finally { store.close(); }
  }); } finally { await project.cleanup(); }
}

const GAP_DIAGNOSTIC = "Adaptive Model Router observation unavailable; evidence coverage is incomplete.\n";

function journalWriter(project, path, count, onReady = (start) => start()) {
  const module = new URL("../scripts/lib/observability.mjs", import.meta.url).href;
  const code = `import {appendObservation} from ${JSON.stringify(module)};
    import {randomUUID} from 'node:crypto';
    process.stdout.write('READY\\n');
    await new Promise(resolve => process.stdin.once('data', resolve));
    process.stdin.pause();
    const results = [];
    for(let i=0;i<${count};i++) {
      const eventId = randomUUID(), diagnostics = [], started = performance.now();
      const accepted = appendObservation({eventId,component:'service',event:'finished',operation:'succeeded'},
        {mainPath:process.argv[1],stderr:{write(value){diagnostics.push(value);}}});
      results.push({eventId,accepted,elapsedMs:performance.now()-started,diagnostics});
    }
    process.stdout.write(JSON.stringify(results)+'\\n');`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, path], {
      env: { ...process.env, CODEX_HOME: join(project.root, "codex"), ADAPTIVE_ROUTER_HOME: project.home, PLUGIN_DATA: project.home },
      // This writer has no descendants. A broken wait must fail and close the
      // owned process before the caller releases its lock and removes files.
      timeout: 20_000, killSignal: "SIGKILL", windowsHide: true,
    });
    let stdout = "", stderr = "", ready = false, childError;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!ready && stdout.startsWith("READY\n")) {
        ready = true;
        onReady(() => child.stdin.end("GO\n"));
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { childError = error; });
    child.stdin.on("error", (error) => { childError ||= error; });
    child.once("close", (status, signal) => {
      try {
        assert.ifError(childError);
        assert.equal(status, 0, JSON.stringify({ status, signal, stdout, stderr }));
        assert.equal(ready, true);
        resolve(JSON.parse(stdout.slice("READY\n".length)));
      } catch (error) { reject(error); }
    });
  });
}

function verifyJournalResults(path, results, priorIds = []) {
  assert.equal(new Set(results.map((r) => r.eventId)).size, results.length);
  const accepted = results.filter((r) => r.accepted), rejected = results.filter((r) => !r.accepted);
  assert.deepEqual(events(path).map((r) => r.eventId).sort(), [...priorIds, ...accepted.map((r) => r.eventId)].sort());
  for (const result of accepted) assert.deepEqual(result.diagnostics, []);
  for (const result of rejected) {
    assert.deepEqual(result.diagnostics, [GAP_DIAGNOSTIC]);
    assert.ok(result.elapsedMs >= 140, `writer failed before its lock wait: ${JSON.stringify(result)}`);
  }
  if (rejected.length) {
    const gap = JSON.parse(readFileSync(observationGapPath(path)));
    assert.equal(gap.state, "incomplete");
    assert.equal(gap.droppedCount, "at_least_one");
    assert.equal(gap.errorCode, "STORAGE_BUSY");
    assert.equal(gap.errorCategory, "storage_busy");
  } else assert.equal(existsSync(observationGapPath(path)), false);
  return { accepted, rejected };
}

test("observation fields are closed and never capture arguments, paths, exception text or arbitrary codes", async () => {
  await fixture(({ store }) => {
    const secret = "never-persist-this-secret";
    const observation = beginObservation({ component: "mcp", tool: secret, projectKey: secret, goal: secret, input: { token: secret } }, { mainPath: store.path });
    observation.finish({ error: Object.assign(new TypeError(secret), { code: secret }), result: { carrier: { message: secret } } });
    observation.finish({ operation: "succeeded" });
    const rows = events(store.path);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].operation, "failed");
    assert.equal(rows[1].lifecycle, "completed");
    assert.equal(rows[1].errorCode, "INTERNAL_ERROR");
    assert.equal(rows[1].tool, null);
    assert.equal(rows[1].projectKey, null);
    assert.equal(rows[1].callId, rows[0].callId);
    assert.doesNotMatch(readFileSync(observationPath(store.path)).toString(), new RegExp(secret));
  });
});

test("rejected input, retry misuse and busy calls are observed without inventing routes or outcomes", async () => {
  await fixture(async ({ store, project }) => {
    const options = { store, cwd: project.root, routeOptions: { enforceLifecycleHooks: false, catalog: CATALOG } };
    await assert.rejects(callRouterTool("route_stage", routeInput({ phase: "x".repeat(129) }), options), /too long/);
    await assert.rejects(callRouterTool("route_stage", routeInput({ evidence: { verificationFailed: true } }), options), /previousRouteId/);
    const first = await callRouterTool("route_stage", routeInput(), options);
    const second = await callRouterTool("route_stage", routeInput(), options);
    assert.equal(first.action, "delegate");
    assert.equal(second.action, "busy");
    const finished = events(store.path).filter((e) => e.event === "finished");
    assert.deepEqual(finished.map((e) => e.operation), ["rejected", "rejected", "succeeded", "busy"]);
    assert.deepEqual(finished.slice(0, 2).map((e) => e.errorCategory), ["input_validation", "retry_contract"]);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM routes").get().n, 1);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n, 0);
    assert.ok(finished.every((e) => e.identitySource === "declared_context"));
  });
});

test("capacity and time pruning retain a durable coverage ledger", async () => {
  await fixture(({ store }) => {
    const start = Date.parse("2026-09-01T00:00:00.000Z"), retention = { days: 7, maxEvents: 3, maxContextEvents: 2 };
    for (let i = 0; i < 5; i++) assert.equal(appendObservation({ event: "detail", projectKey: "a".repeat(64), contextKey: "b".repeat(64) }, { mainPath: store.path, now: start + i, retention }), true);
    assert.equal(events(store.path).length, 2);
    assert.equal(appendObservation({ event: "detail" }, { mainPath: store.path, now: start + 8 * 86_400_000, retention }), true);
    const db = new DatabaseSync(observationPath(store.path), { readOnly: true });
    try {
      const coverage = db.prepare("SELECT * FROM coverage").get();
      assert.equal(coverage.pruned_capacity, 3);
      assert.equal(coverage.pruned_age, 2);
      assert.equal(coverage.started_at, new Date(start).toISOString());
      assert.equal(db.prepare("SELECT count(*) AS n FROM events").get().n, 1);
    } finally { db.close(); }
  });
});

test("an unavailable observation store leaves a gap and does not replace a successful operation", async () => {
  await fixture(async ({ store, project }) => {
    mkdirSync(observationPath(store.path));
    const result = await callRouterTool("route_stage", routeInput({ goal: "hello", evidence: {} }), { store, cwd: project.root });
    assert.equal(result.action, "continue");
    assert.equal(existsSync(observationGapPath(store.path)), true);
    assert.equal(JSON.parse(readFileSync(observationGapPath(store.path))).state, "incomplete");
  });
});

test("health does not create missing databases, migrate old schemas, or change stored bytes", async () => {
  const project = await temporaryProject();
  try {
    const path = join(project.home, "router.sqlite3");
    const absent = readHealth({ mainPath: path, scope: "local" });
    assert.equal(absent.integrity.router, "absent");
    assert.equal(absent.operationHealth.state, "unknown");
    assert.equal(existsSync(project.home), false);
    mkdirSync(project.home);
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE legacy_fixture(value TEXT); INSERT INTO legacy_fixture VALUES('untouched'); PRAGMA user_version=2");
    db.close();
    const before = readFileSync(path), names = readdirSync(project.home);
    readHealth({ mainPath: path, scope: "local" });
    assert.deepEqual(readFileSync(path), before);
    assert.deepEqual(readdirSync(project.home), names);
    const ro = new DatabaseSync(path, { readOnly: true });
    try { assert.equal(ro.prepare("PRAGMA user_version").get().user_version, 2); } finally { ro.close(); }
  } finally { await project.cleanup(); }
});

test("health paginates a pinned time window and separates historical unknowns from observations", async () => {
  await fixture(async ({ store, project }) => {
    for (const contextId of ["a", "b", "c"]) await callRouterTool("route_stage", routeInput({ contextId }), { store, cwd: project.root, routeOptions: { enforceLifecycleHooks: false, catalog: CATALOG } });
    const from = new Date(Date.now() - 60_000).toISOString(), to = new Date(Date.now() + 60_000).toISOString();
    const first = readHealth({ mainPath: store.path, scope: "local", from, to, limit: 2 });
    assert.equal(first.tasks.length, 2);
    assert.equal(first.totalTasks, 3);
    assert.equal(first.operationHealth.toolCalls.succeeded, 3);
    assert.equal(first.operationHealth.reservations.charged, 3);
    assert.equal(first.evidenceCoverage.acceptedRoutesWithoutObservation, 0);
    const second = readHealth({ mainPath: store.path, scope: "local", cursor: first.nextCursor, limit: 2 });
    assert.equal(second.tasks.length, 1);
    assert.equal(second.nextCursor, null);
    assert.equal(new Set([...first.tasks, ...second.tasks].map((t) => t.contextKey)).size, 3);
    assert.ok([...first.tasks, ...second.tasks].every((t) => t.taskOrigin === "unknown"));
    assert.throws(() => readHealth({ mainPath: store.path, scope: "local", cursor: first.nextCursor, to: new Date(Date.now() + 120_000).toISOString() }), /does not belong/);
    // Compare closed stores, including the journal: a health read cannot create
    // migration tables, regenerate a salt or reconcile terminal responsibility.
    store.close();
    const paths = [store.path, observationPath(store.path)];
    const hashFiles = () => paths.map((p) => createHash("sha256").update(readFileSync(p)).digest("hex"));
    const before = hashFiles();
    readHealth({ mainPath: store.path, scope: "local", from, to });
    assert.deepEqual(hashFiles(), before);
  });
});

test("outcome evidence is bounded, atomic, immutable and cannot retrofit an old final outcome", async () => {
  await fixture(async ({ store, project }) => {
    const route = await routeStage(routeInput(), { store, cwd: project.root, catalog: CATALOG });
    const contextId = "test-context";
    observeNoChildRoute(route, { store, cwd: project.root, contextId });
    const input = { routeId: route.routeId, contextId, status: "passed", gate: route.verificationGate,
      failureType: null, retries: 0, retryBreakdown: { reasoning: 0, environment: 0, information: 0, tooling: 0 }, escalations: 0, userCorrection: false,
      verificationEvidence: { schemaVersion: 1, checks: [{ kind: "unit", status: "passed", reference: `artifact:${"a".repeat(64)}`, commandTemplate: "npm test", resultDigest: "b".repeat(64), exitCode: 0 }] } };
    assert.throws(() => recordOutcome({ ...input, verificationEvidence: { ...input.verificationEvidence, output: "secret" } }, { store, cwd: project.root }), /not allowed/);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM outcome_verification_evidence").get().n, 0);
    assert.equal(recordOutcome(input, { store, cwd: project.root }).recorded, true);
    assert.equal(recordOutcome(input, { store, cwd: project.root }).idempotent, true);
    assert.throws(() => recordOutcome({ ...input, verificationEvidence: { schemaVersion: 1, checks: [{ kind: "unit", status: "failed", reference: `check:${"c".repeat(64)}` }] } }, { store, cwd: project.root }), /immutable/);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM outcome_verification_evidence").get().n, 1);
    const next = await routeStage(routeInput({ contextId: "old" }), { store, cwd: project.root, catalog: CATALOG });
    observeNoChildRoute(next, { store, cwd: project.root, contextId: "old" });
    const old = { ...input, routeId: next.routeId, contextId: "old" }; delete old.verificationEvidence;
    recordOutcome(old, { store, cwd: project.root });
    assert.throws(() => recordOutcome({ ...old, verificationEvidence: input.verificationEvidence }, { store, cwd: project.root }), /cannot be backfilled/);
  });
});

test("health keeps age-pruned windows and diagnostic truncation visibly incomplete", async () => {
  await fixture(({ store }) => {
    const now = Date.parse("2026-09-21T00:00:00Z"), start = now - 8 * 86_400_000;
    appendObservation({ component: "mcp", event: "finished", operation: "failed" }, { mainPath: store.path, now: start });
    appendObservation({ component: "mcp", event: "finished", operation: "succeeded" }, { mainPath: store.path, now });
    const args = { mainPath: store.path, scope: "local", from: new Date(start).toISOString(), to: new Date(now + 1).toISOString(), now };
    const pruned = readHealth(args);
    assert.equal(pruned.evidenceCoverage.prunedAge, 1);
    assert.equal(pruned.evidenceCoverage.state, "partial");
    assert.notEqual(pruned.operationHealth.state, "no_observed_errors");
    appendObservation({ component: "retention", event: "truncated", evidenceKind: "lifecycle_diagnostic", count: 1 }, { mainPath: store.path, now });
    appendObservation({ component: "retention", event: "pruned", evidenceKind: "hook_task_receipt", count: 17 }, { mainPath: store.path, now });
    assert.deepEqual(readHealth(args).evidenceCoverage.diagnosticPruning, { lifecycle_diagnostic: 1, hook_task_receipt: 17 });
  });
});

test("health separates claimed identity, actual runtime entry, transport failure and cleanup errors", async () => {
  await fixture(({ store }) => {
    const now = Date.now(), base = { projectKey: "a".repeat(64), contextKey: "b".repeat(64) };
    appendObservation({ ...base, component: "mcp", event: "finished", operation: "rejected", identitySource: "declared_context", error: { code: "CALLER_BINDING_UNPROVEN" } }, { mainPath: store.path, now });
    appendObservation({ ...base, component: "launcher", event: "finished", operation: "failed", identitySource: "native_hook", runtimeDigest: "c".repeat(64), runtimeState: "selected" }, { mainPath: store.path, now });
    appendObservation({ component: "bridge", event: "finished", operation: "failed" }, { mainPath: store.path, now });
    appendObservation({ component: "mcp", event: "detail", operation: "failed", error: new TypeError("private") }, { mainPath: store.path, now });
    const h = readHealth({ mainPath: store.path, scope: "local", from: new Date(now - 1).toISOString(), to: new Date(now + 1).toISOString() });
    assert.deepEqual(h.operationHealth.unattributedToolCalls, { rejected: 1 });
    assert.deepEqual(h.tasks[0].operations, {});
    assert.deepEqual(h.tasks[0].runtime.observedExecutions, []);
    assert.deepEqual(h.operationHealth.transportProblems, { launcher: 1, bridge: 1 });
    assert.deepEqual(h.operationHealth.detailProblems, { INTERNAL_ERROR: 1 });
    assert.equal(h.operationHealth.state, "attention");
  });
});

test("health reads committed WAL and leaves the original files, including absent sidecars, unchanged", async () => {
  const project = await temporaryProject();
  try {
    mkdirSync(project.home);
    const path = join(project.home, "router.sqlite3"), writer = new DatabaseSync(path);
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE meta(key TEXT,value TEXT); INSERT INTO meta VALUES('fixture','committed-in-wal')");
    writer.exec("CREATE TABLE routes(route_id TEXT,project_id TEXT,context_key TEXT,action TEXT,reason_codes_json TEXT,created_at TEXT); CREATE TABLE outcomes(route_id TEXT,status TEXT)");
    writer.prepare("INSERT INTO routes VALUES(?,?,?,?,?,?)").run("fixture", "a".repeat(64), "b".repeat(64), "continue", "[]", new Date(Date.now() - 100).toISOString());
    const snapshot = () => readdirSync(project.home).sort().map((name) => [name, createHash("sha256").update(readFileSync(join(project.home, name))).digest("hex")]);
    const before = snapshot();
    const h = readHealth({ mainPath: path, scope: "local" });
    assert.equal(h.integrity.router, "ok");
    assert.equal(h.tasks[0].routes.continue, 1, "the committed row exists only in WAL");
    assert.deepEqual(snapshot(), before);
    writer.close();
    const closed = snapshot();
    assert.equal(closed.length, 1);
    readHealth({ mainPath: path, scope: "local" });
    assert.deepEqual(snapshot(), closed);
    // A corrupt independent journal must not conceal the valid main store.
    writeFileSync(observationPath(path), "not-a-database");
    const damaged = readHealth({ mainPath: path, scope: "local" });
    assert.equal(damaged.integrity.router, "ok");
    assert.equal(damaged.integrity.observations, "unavailable_or_corrupt");
    assert.equal(damaged.evidenceCoverage.state, "partial");
  } finally { await project.cleanup(); }
});

test("Hook identity and child-context rejection remain visible despite safe exit zero", async () => {
  const project = await temporaryProject();
  try {
    new RouterStore({ path: join(project.home, "router.sqlite3") }).close();
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/hook.mjs", import.meta.url)), "prompt"], {
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "fixture" }), encoding: "utf8", timeout: 5000,
      env: { ...process.env, ADAPTIVE_ROUTER_HOME: project.home, PLUGIN_DATA: project.home, CODEX_HOME: join(project.root, "codex"), ADAPTIVE_ROUTER_INVOCATION_ID: "" },
    });
    assert.equal(result.status, 0);
    const rows = events(join(project.home, "router.sqlite3"));
    assert.equal(rows.at(-1).operation, "rejected");
    assert.ok(rows.some((e) => e.errorCode === "HOOK_IDENTITY_MISSING"));
    const h = readHealth({ mainPath: join(project.home, "router.sqlite3"), scope: "local", from: rows[0].observedAt, to: new Date(Date.now() + 1).toISOString() });
    assert.equal(h.operationHealth.state, "attention");
  } finally { await project.cleanup(); }
});

test("health counts maintenance after the original bounded attempt was pruned", async () => {
  const project = await temporaryProject();
  try {
    mkdirSync(project.home);
    const path = join(project.home, "router.sqlite3"), db = new DatabaseSync(path);
    db.exec(`CREATE TABLE meta(key TEXT,value TEXT); CREATE TABLE routes(route_id TEXT,project_id TEXT,context_key TEXT,created_at TEXT);
      CREATE TABLE delegation_attempts(route_id TEXT,project_id TEXT,context_key TEXT,finalized_at TEXT,created_at TEXT);
      CREATE TABLE delegation_maintenance(route_id TEXT,state TEXT,start_revision INTEGER);
      CREATE TABLE delegation_children(route_id TEXT,project_id TEXT,context_key TEXT,created_at TEXT,state TEXT);`);
    const p = "a".repeat(64), c = "b".repeat(64), r = "abeb1260-a6c9-47f3-b44d-091ee1a54af7", now = new Date().toISOString();
    db.prepare("INSERT INTO routes VALUES(?,?,?,?)").run(r, p, c, now);
    db.prepare("INSERT INTO delegation_children VALUES(?,?,?,?,?)").run(r, p, c, now, "active");
    db.prepare("INSERT INTO delegation_maintenance VALUES(?,?,?)").run(r, "active", 1);
    db.prepare("INSERT INTO meta VALUES(?,?)").run(`global_maintenance_reservation:${r}`, "1"); db.close();
    const h = readHealth({ mainPath: path, scope: "local" });
    assert.equal(h.operationHealth.reservations.charged, 1);
    assert.equal(h.tasks[0].pendingResponsibilities[0].kind, "maintenance");
    assert.deepEqual(h.tasks[0].pendingResponsibilities[0].missing, ["maintenance_verification"]);
  } finally { await project.cleanup(); }
});

test("an uncontended journal writer accepts every observation", async () => {
  const project = await temporaryProject();
  try {
    const path = join(project.home, "router.sqlite3");
    const results = await journalWriter(project, path, 25);
    assert.equal(verifyJournalResults(path, results).accepted.length, 25);
  } finally { await project.cleanup(); }
});

test("concurrent journal writers retain accepted events and account for bounded lock failures", async () => {
  const project = await temporaryProject();
  try {
    const path = join(project.home, "router.sqlite3"), starts = [];
    const results = (await Promise.all(Array.from({ length: 4 }, () => journalWriter(project, path, 25, (start) => {
      starts.push(start);
      if (starts.length === 4) starts.forEach((release) => release());
    })))).flat();
    assert.equal(results.length, 100);
    // The journal has a finite lock wait. A busy disk may exhaust it; success
    // must be exact, and every rejected append must leave honest gap evidence.
    const { accepted } = verifyJournalResults(path, results);
    assert.ok(accepted.length > 0);
    const gap = existsSync(observationGapPath(path)) ? readFileSync(observationGapPath(path)) : null;
    const recovery = await journalWriter(project, path, 1);
    assert.equal(recovery[0].accepted, true);
    assert.deepEqual(events(path).map((r) => r.eventId).sort(), [...accepted, ...recovery].map((r) => r.eventId).sort());
    if (gap) assert.deepEqual(readFileSync(observationGapPath(path)), gap);
  } finally { await project.cleanup(); }
});

for (const warm of [false, true]) for (const short of [true, false]) {
  test(`${warm ? "warm transaction" : "cold journal"} ${short ? "recovers after a short lock" : "records a bounded lock failure and recovers"}`, async () => {
    const project = await temporaryProject();
    let lock, timer;
    try {
      const path = join(project.home, "router.sqlite3");
      mkdirSync(project.home, { recursive: true });
      const prior = warm ? await journalWriter(project, path, 1) : [];
      if (warm) assert.equal(prior[0].accepted, true);
      lock = new DatabaseSync(observationPath(path));
      // A reserved rollback-journal lock makes cold WAL enrollment return
      // SQLITE_BUSY immediately, exercising the explicit bounded WAL retry.
      lock.exec(warm ? "BEGIN IMMEDIATE" : "CREATE TABLE lock_control(id INTEGER); BEGIN IMMEDIATE");
      const results = await journalWriter(project, path, 1, (start) => {
        start();
        if (short) timer = setTimeout(() => lock.exec("ROLLBACK"), 55);
      });
      clearTimeout(timer);
      // A wall-clock release can precede the writer's actual SQLite attempt
      // on a busy host. Sustain this lock until the bounded writer has closed.
      if (!short) assert.equal(lock.isTransaction, true);
      if (lock.isTransaction) lock.exec("ROLLBACK");
      lock.close(); lock = null;
      assert.equal(results[0].accepted, short, JSON.stringify(results));
      assert.ok(results[0].elapsedMs < 1500, JSON.stringify(results));
      if (warm || short) verifyJournalResults(path, results, prior.map((r) => r.eventId));
      else {
        // A cold failure can precede schema creation, so inspect rows after recovery.
        assert.deepEqual(results[0].diagnostics, [GAP_DIAGNOSTIC]);
        assert.ok(results[0].elapsedMs >= 140, JSON.stringify(results));
        const gap = JSON.parse(readFileSync(observationGapPath(path)));
        assert.equal(gap.state, "incomplete");
        assert.equal(gap.droppedCount, "at_least_one");
        assert.equal(gap.errorCode, "STORAGE_BUSY");
        assert.equal(gap.errorCategory, "storage_busy");
      }
      const gap = short ? null : readFileSync(observationGapPath(path));
      const recovery = await journalWriter(project, path, 1);
      assert.equal(recovery[0].accepted, true);
      assert.deepEqual(events(path).map((r) => r.eventId).sort(),
        [...prior, ...results.filter((r) => r.accepted), ...recovery].map((r) => r.eventId).sort());
      if (gap) assert.deepEqual(readFileSync(observationGapPath(path)), gap);
    } finally {
      clearTimeout(timer);
      if (lock?.isTransaction) lock.exec("ROLLBACK");
      lock?.close();
      await project.cleanup();
    }
  });
}

test("health isolates malformed observation records and incompatible store schemas", async () => {
  await fixture(async ({ store, project }) => {
    await callRouterTool("route_stage", routeInput({ goal: "hello", evidence: {} }), { store, cwd: project.root });
    const journal = new DatabaseSync(observationPath(store.path));
    journal.prepare("UPDATE events SET payload_json='{' WHERE seq=(SELECT min(seq) FROM events)").run();
    journal.close();
    const partial = readHealth({ mainPath: store.path, scope: "local" });
    assert.equal(partial.tasks[0].routes.continue, 1);
    assert.equal(partial.operationHealth.toolCalls.succeeded, 1);
    assert.equal(partial.evidenceCoverage.invalidObservationRecords, 1);
    assert.equal(partial.evidenceCoverage.state, "partial");
    assert.equal(partial.integrity.observations, "partial");
    store.db.exec("ALTER TABLE routes RENAME COLUMN project_id TO incompatible_project_id");
    const incompatible = readHealth({ mainPath: store.path, scope: "local" });
    assert.equal(incompatible.integrity.router, "unavailable_or_corrupt");
    assert.equal(incompatible.operationHealth.toolCalls.succeeded, 1);
    assert.equal(incompatible.evidenceCoverage.state, "partial");
  });
});

test("child execution origin never replaces the owning root task origin", async () => {
  await fixture(({ store }) => {
    const owner = { projectKey: "a".repeat(64), contextKey: "b".repeat(64), identitySource: "native_hook", originSource: "native_metadata" };
    appendObservation({ ...owner, component: "hook", event: "finished", taskOrigin: "interactive_root" }, { mainPath: store.path });
    appendObservation({ ...owner, component: "hook", event: "finished", taskOrigin: "bounded_child" }, { mainPath: store.path });
    const h = readHealth({ mainPath: store.path, scope: "local", to: new Date(Date.now() + 1000).toISOString() });
    assert.equal(h.tasks[0].taskOrigin, "interactive_root");
    assert.ok(h.tasks[0].executionOrigins.includes("bounded_child"));
  });
});

test("health isolates missing query dependencies without requiring unrelated new tables", async () => {
  const project = await temporaryProject();
  try {
    mkdirSync(project.home);
    const path = join(project.home, "router.sqlite3"), db = new DatabaseSync(path);
    db.exec("CREATE TABLE delegation_attempts(route_id TEXT,project_id TEXT,context_key TEXT,created_at TEXT,finalized_at TEXT)");
    db.prepare("INSERT INTO delegation_attempts VALUES(?,?,?,?,NULL)").run("fixture", "a".repeat(64), "b".repeat(64), new Date().toISOString());
    db.close();
    appendObservation({ component: "service", event: "finished", operation: "succeeded" }, { mainPath: path });
    const result = readHealth({ mainPath: path, scope: "local", to: new Date(Date.now() + 1000).toISOString() });
    assert.equal(result.integrity.router, "unavailable_or_corrupt");
    assert.equal(result.operationHealth.toolCalls.succeeded, 1);
    assert.equal(result.evidenceCoverage.state, "partial");
  } finally { await project.cleanup(); }
});
