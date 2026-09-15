import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RouterStore } from "../scripts/lib/database.mjs";
import { inspectRuntimePackage, copyRuntimePackage, managedRuntimeDestination } from "../scripts/lib/runtime-package.mjs";
import { ensureRuntimeTask, runtimeTask, publishedDefault } from "../scripts/lib/runtime-isolation.mjs";
import { readNativeRootBirth } from "../scripts/lib/subagent-session.mjs";
import { runtimeSourceDigest } from "../scripts/lib/lifecycle-qualification.mjs";
import { qualifyHostEpochPublication, publishHostEpoch, prepareHostEpochHandover } from "../scripts/lib/runtime-epoch.mjs";
import { prepareColdHostEpochInstallation, inspectColdHostEpochRetirement, commitColdHostEpochRetirement,
  assertColdEpochRetirement, relocateColdHostEpochEntries, restoreColdHostEpochEntries } from "../scripts/lib/runtime-cold-install.mjs";
import { prepareRuntimeHostEntry } from "../scripts/lib/runtime-host-entry.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const emptyInventory = () => [];
let work, templates, candidate, sourceAtStart;
before(() => {
  sourceAtStart = runtimeSourceDigest(root);
  work = realpathSync(mkdtempSync(join(tmpdir(), "router-cold-sources-test-")));
  const archive = spawnSync("git", ["archive", "16c439dd0bf3657ba06707ff15c1465613d49554", "plugins/adaptive-model-router"],
    { cwd: resolve(root, "../.."), maxBuffer: 32 * 1024 * 1024 });
  assert.equal(archive.status, 0, "Exact historical commit is required; never read the global live cache");
  assert.equal(spawnSync("tar", ["-xf", "-", "-C", work], { input: archive.stdout }).status, 0);
  templates = {};
  for (const [name, variable] of [["legacy", "ADAPTIVE_ROUTER_LEGACY_FIXTURE"], ["default", "ADAPTIVE_ROUTER_DEFAULT_FIXTURE"], ["mcp", "ADAPTIVE_ROUTER_MCP_FIXTURE"]]) {
    const path = join(work, name);
    cpSync(process.env[variable] || join(work, "plugins/adaptive-model-router"), path, { recursive: true });
    // CI also exercises three independent immutable publications without a
    // machine-specific fixture. Supplied installed packages remain exact.
    if (!process.env[variable]) writeFileSync(join(path, "source-fixture.txt"), name);
    templates[name] = inspectRuntimePackage(path, { legacy: name === "legacy" && Boolean(process.env[variable]) });
  }
  cpSync(root, join(work, "candidate"), { recursive: true });
  candidate = inspectRuntimePackage(join(work, "candidate"));
});
after(() => {
  try {
    assert.equal(runtimeSourceDigest(root), sourceAtStart, "Repeat verification if source changed during the run");
    for (const source of Object.values(templates || {})) assert.equal(inspectRuntimePackage(source.root,
      { legacy: source.descriptor.shellProtocolVersion === 1 }).digest, source.digest);
  } finally { if (work) rmSync(work, { recursive: true, force: true }); }
});

const preserved = (db) => JSON.stringify(["runtime_tasks", "runtime_stages", "routes", "outcomes", "delegation_attempts",
  "delegation_children", "delegation_messages"].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));

async function fixture(run, { entryNames = ["legacy", "default", "mcp"] } = {}) {
  const cwd = realpathSync(mkdtempSync(join(work, "case-"))), home = join(cwd, "state");
  const environment = { ADAPTIVE_ROUTER_HOME: home, PLUGIN_DATA: home, CODEX_HOME: join(cwd, "codex"),
    ADAPTIVE_ROUTER_LOCAL_ONLY: "1", ADAPTIVE_ROUTER_INVOCATION_ID: "", CODEX_THREAD_ID: "" };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment); mkdirSync(process.env.CODEX_HOME, { recursive: true });
  const store = new RouterStore(), sources = {}, entries = {};
  try {
    for (const [name, template] of Object.entries(templates)) {
      sources[name] = copyRuntimePackage(template, managedRuntimeDestination(home, "published", template.digest));
      store.db.prepare("INSERT INTO runtime_generations VALUES(?,?,'published')").run(template.digest, JSON.stringify(sources[name]));
      if (entryNames.includes(name)) {
        entries[name] = copyRuntimePackage(template, join(cwd, `native-${name}`));
        store.db.prepare("INSERT INTO runtime_host_entries VALUES(?,?,'referenced')").run(entries[name].root, template.digest);
      }
    }
    store.db.prepare("INSERT INTO runtime_defaults VALUES(1,?,?)").run(sources.default.digest, sources.legacy.digest);
    const originalCutover = Date.now() - 60_000;
    const bootstrap = ` {"legacyDigest":"${sources.legacy.digest}","defaultDigest":"${sources.default.digest}","cutoverTime":${originalCutover},"basis":"original bootstrap evidence"} `;
    store.db.prepare("INSERT INTO meta VALUES('runtime_legacy_bootstrap',?)").run(bootstrap);
    const context = store.context({ cwd, contextId: "existing-owner" });
    store.db.prepare("INSERT INTO runtime_tasks(project_id,context_key,generation) VALUES(?,?,?)")
      .run(context.projectId, context.contextKey, sources.default.digest);
    for (const [name, generation] of Object.entries(sources)) store.db.prepare("INSERT INTO runtime_stages VALUES(?,?,?,?)")
      .run(`original-${name}`, context.projectId, context.contextKey, generation.digest);
    store.db.prepare(`INSERT INTO routes(route_id,project_id,context_key,schema_version,action,category,
      verification_gate,reason_codes_json,classifier_state,created_at) VALUES('original-business',?,?,'1','continue','general','checks',' [ "original" ] ','known','2026-01-01')`)
      .run(context.projectId, context.contextKey);
    const prepare = () => prepareColdHostEpochInstallation(store, { source: sources.default, candidate, shellRoot: candidate.root });
    const retire = (installation) => {
      relocateColdHostEpochEntries(store, installation.id, { inventory: emptyInventory });
      return commitColdHostEpochRetirement(store, inspectColdHostEpochRetirement(store, installation.id, { inventory: emptyInventory }));
    };
    const bind = (id, time, extra = {}) => {
      const context = store.context({ cwd, contextId: id }), transcript = join(cwd, `${id}.jsonl`);
      writeFileSync(transcript, JSON.stringify({ type: "session_meta", timestamp: time == null ? undefined : new Date(time).toISOString(),
        payload: { id, cwd, ...extra } }) + "\n");
      const rootBirth = readNativeRootBirth({ session_id: id, cwd, transcript_path: transcript });
      return store.transaction(() => ensureRuntimeTask(store.db, context, { trustedHook: true, rootBirth })).generation;
    };
    await run({ store, cwd, home, sources, entries, context, originalCutover, bootstrap, prepare, retire, bind });
  } finally { store.close(); for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}

test("one cold installation qualifies all three actual sources and retires only native entries without relabeling old rows", async () => {
  await fixture(async (f) => {
    const before = preserved(f.store.db), installation = f.prepare();
    assert.deepEqual(f.store.db.prepare("SELECT source FROM runtime_epoch_publications ORDER BY source").all().map((row) => row.source),
      Object.values(f.sources).map((source) => source.digest).sort());
    assert.equal(preserved(f.store.db), before);
    assert.equal(installation.recoveryEntries.length, 3);
    assert.equal(installation.recoveryEntries.some((entry) => entry.path.includes("/runtime-v2/published/")), false);
    f.retire(installation);
    for (const source of Object.values(f.sources)) {
      assert.equal(assertColdEpochRetirement(f.store.db, source.digest, candidate.digest).id, installation.id);
      assert.equal(existsSync(source.root), true, "Retained package is never an old native path");
    }
    assert.equal(preserved(f.store.db), before);
    assert.equal(f.store.db.prepare("SELECT value FROM meta WHERE key='runtime_legacy_bootstrap'").get().value, f.bootstrap);
  });
});

test("all three exact sources qualify a materialized candidate without writing its original bound database", async () => {
  await fixture(async (f) => {
    const bound = prepareRuntimeHostEntry(candidate.root, join(f.cwd, "materialized-candidate/entry"), f.home);
    const snapshot = () => JSON.stringify(f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      .map(({ name }) => [name, f.store.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
    const before = snapshot();
    for (const source of Object.values(f.sources)) {
      assert.ok(qualifyHostEpochPublication(source, bound, { cold: true }));
      assert.equal(snapshot(), before, "Original bound database, including all meta/runtime rows, remains untouched");
      assert.equal(inspectRuntimePackage(bound.root).digest, bound.digest);
    }
  });
});

test("task stage bootstrap and default references contribute sources even without their own native entry", async () => {
  await fixture(async (f) => {
    const installation = f.prepare();
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM runtime_epoch_publications").get().n, 3);
    assert.equal(installation.recoveryEntries.length, 1);
    f.retire(installation);
    for (const source of Object.values(f.sources)) assertColdEpochRetirement(f.store.db, source.digest, candidate.digest);
  }, { entryNames: ["mcp"] });
});

test("dormant roots retain both birth cutovers and unknown birth never admits B", async () => {
  await fixture(async (f) => {
    const installation = f.prepare(); f.retire(installation);
    const retirement = JSON.parse(f.store.db.prepare("SELECT record FROM runtime_epoch_retirements").get().record);
    for (const [id, time, expected] of [["before-first", f.originalCutover - 1, f.sources.legacy.digest],
      ["at-first", f.originalCutover, f.sources.legacy.digest], ["between", f.originalCutover + 1, f.sources.default.digest],
      ["at-second", retirement.retiredAt, f.sources.default.digest], ["after-second", retirement.retiredAt + 1, candidate.digest],
      ["unknown", null, f.sources.legacy.digest]]) assert.equal(f.bind(id, time), expected, id);
    assert.equal(f.bind("child-shaped-birth", retirement.retiredAt + 1, { parent_thread_id: "root" }), f.sources.legacy.digest);
  });
});

test("preparation refuses an unreviewed source before publishing or changing assignment", async () => {
  await fixture(async (f) => {
    const path = join(f.cwd, "unknown-writer"); cpSync(templates.mcp.root, path, { recursive: true });
    writeFileSync(join(path, "scripts/lib/runtime-dispatch.mjs"), readFileSync(join(path, "scripts/lib/runtime-dispatch.mjs"), "utf8") + "\n// unreviewed writer\n");
    const unknown = inspectRuntimePackage(path);
    f.store.db.prepare("INSERT INTO runtime_generations VALUES(?,?,'published')").run(unknown.digest, JSON.stringify(unknown));
    f.store.db.prepare("INSERT INTO runtime_stages VALUES('unknown-stage',?,?,?)").run(f.context.projectId, f.context.contextKey, unknown.digest);
    const before = preserved(f.store.db);
    assert.throws(f.prepare, /unreviewed_invocation_registration/);
    assert.equal(preserved(f.store.db), before);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM runtime_epoch_publications").get().n, 0);
  });
});

test("entry registration changes after preparation or after inspection invalidate retirement", async () => {
  for (const afterInspection of [false, true]) await fixture(async (f) => {
    const installation = f.prepare();
    relocateColdHostEpochEntries(f.store, installation.id, { inventory: emptyInventory });
    const token = afterInspection ? inspectColdHostEpochRetirement(f.store, installation.id, { inventory: emptyInventory }) : null;
    f.store.db.prepare("INSERT INTO runtime_host_entries VALUES(?,?,'referenced')").run(join(f.cwd, "new-unretired-native-entry"), f.sources.default.digest);
    assert.throws(() => token ? commitColdHostEpochRetirement(f.store, token)
      : inspectColdHostEpochRetirement(f.store, installation.id, { inventory: emptyInventory }), /cold_.*(registry|source|history).*changed/);
    assert.equal(publishedDefault(f.store.db).current_digest, f.sources.default.digest);
  });
});

test("preparation snapshot rejects changed generation registration and bootstrap before moving any old entry", async () => {
  for (const mode of ["generation", "bootstrap", "default"]) await fixture(async (f) => {
    const installation = f.prepare();
    if (mode === "generation") f.store.db.prepare("UPDATE runtime_generations SET state='archived' WHERE digest=?").run(f.sources.mcp.digest);
    if (mode === "bootstrap") f.store.db.prepare("UPDATE meta SET value=? WHERE key='runtime_legacy_bootstrap'").run(f.bootstrap + " ");
    if (mode === "default") f.store.db.prepare("UPDATE runtime_defaults SET current_digest=?").run(f.sources.mcp.digest);
    assert.throws(() => relocateColdHostEpochEntries(f.store, installation.id, { inventory: emptyInventory }), /cold_(source_registry_changed|default_changed)/);
    for (const entry of Object.values(f.entries)) assert.equal(existsSync(entry.root), true);
  });
});

test("a cold historical stage cannot borrow another source retirement even with its own A/B publication", async () => {
  await fixture(async (f) => {
    const installation = f.prepare(); f.retire(installation);
    const path = join(f.cwd, "later-source"); cpSync(templates.mcp.root, path, { recursive: true });
    writeFileSync(join(path, "independent-source.txt"), "not included in the retired source inventory");
    const source = inspectRuntimePackage(path);
    f.store.db.prepare("INSERT INTO runtime_generations VALUES(?,?,'published')").run(source.digest, JSON.stringify(source));
    publishHostEpoch(f.store, qualifyHostEpochPublication(source, candidate, { cold: true }));
    f.store.db.prepare("UPDATE runtime_stages SET generation=? WHERE route_id='original-mcp'").run(source.digest);
    const before = preserved(f.store.db);
    await assert.rejects(prepareHostEpochHandover(f.store, { contextId: "existing-owner", cwd: f.cwd },
      { candidate: candidate.digest, shellRoot: candidate.root, inspect: async () => ({}) }), /cold_entry_retirement_missing/);
    assert.equal(preserved(f.store.db), before);
  });
});

test("cold recovery restores the exact prior default and boundary while retaining immutable retirement evidence", async () => {
  await fixture(async (f) => {
    const before = preserved(f.store.db), defaults = publishedDefault(f.store.db), installation = f.prepare(); f.retire(installation);
    const retired = JSON.stringify(f.store.db.prepare("SELECT * FROM runtime_epoch_retirements").all());
    restoreColdHostEpochEntries(f.store, installation.id, { inventory: emptyInventory });
    assert.deepEqual(publishedDefault(f.store.db), defaults);
    assert.equal(f.store.db.prepare("SELECT value FROM meta WHERE key='runtime_legacy_bootstrap'").get().value, f.bootstrap);
    assert.equal(preserved(f.store.db), before);
    assert.equal(JSON.stringify(f.store.db.prepare("SELECT * FROM runtime_epoch_retirements").all()), retired);
    assert.equal(f.bind("after-restoration", Date.now() + 1), f.sources.default.digest);
    for (const source of Object.values(f.sources)) assert.throws(() => assertColdEpochRetirement(f.store.db, source.digest, candidate.digest), /revoked_by_recovery/);
    f.retire(installation);
    for (const source of Object.values(f.sources)) assertColdEpochRetirement(f.store.db, source.digest, candidate.digest);
  });
});

test("recovery rejects subsequent default changes and real candidate task use", async () => {
  for (const mode of ["default", "task"]) await fixture(async (f) => {
    const installation = f.prepare(); f.retire(installation);
    if (mode === "default") f.store.db.prepare("UPDATE runtime_defaults SET current_digest=?").run(f.sources.mcp.digest);
    else f.bind("actual-B-task", Date.now() + 1);
    assert.throws(() => restoreColdHostEpochEntries(f.store, installation.id, { inventory: emptyInventory }),
      /cold_(default_changed|recovery_requires_task_rollback_first)/);
    for (const entry of Object.values(f.entries)) assert.equal(existsSync(entry.root), false);
  });
});
