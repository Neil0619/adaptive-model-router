import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RouterStore } from "../scripts/lib/database.mjs";
import { archiveHistoricalRuntime } from "./support/historical-runtime.mjs";
import { inspectRuntimePackage } from "../scripts/lib/runtime-package.mjs";
import { runtimeSourceDigest } from "../scripts/lib/lifecycle-qualification.mjs";
import { publishRuntime, runtimeGeneration } from "../scripts/lib/runtime-isolation.mjs";
import { prepareColdHostEpochInstallation, relocateColdHostEpochEntries, inspectColdHostEpochRetirement,
  commitColdHostEpochRetirement, assertColdEpochRetirement, restoreColdHostEpochEntries } from "../scripts/lib/runtime-cold-install.mjs";
import { payloadHash } from "../scripts/lib/io.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let work, frozen, fingerprint;
before(() => {
  fingerprint = runtimeSourceDigest(root);
  work = realpathSync(mkdtempSync(join(tmpdir(), "router-cold-upgrade-")));
  const archive = archiveHistoricalRuntime(resolve(root, "../.."), "16c439dd0bf3657ba06707ff15c1465613d49554");
  assert.equal(archive.status, 0);
  assert.equal(spawnSync("tar", ["-xf", "-", "-C", work], { input: archive.stdout }).status, 0);
  frozen = join(work, "plugins/adaptive-model-router");
});
after(() => {
  try { assert.equal(runtimeSourceDigest(root), fingerprint); }
  finally { rmSync(work, { recursive: true, force: true }); }
});
const state = db => payloadHash(["runtime_defaults", "runtime_tasks", "runtime_stages", "runtime_generations", "runtime_host_entries",
  "runtime_epoch_installations", "runtime_epoch_publications", "runtime_epoch_retirements", "runtime_epoch_entry_recoveries"]
  .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));

function fixture(run) {
  const cwd = realpathSync(mkdtempSync(join(work, "case-"))), home = join(cwd, "state");
  const values = { ADAPTIVE_ROUTER_HOME: home, PLUGIN_DATA: home, CODEX_HOME: join(cwd, "codex"),
    ADAPTIVE_ROUTER_LOCAL_ONLY: "1", ADAPTIVE_ROUTER_INVOCATION_ID: "", CODEX_THREAD_ID: "" };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  const store = new RouterStore();
  try {
    for (const [name, source] of [["a", frozen], ["b", root], ["c", root]]) cpSync(source, join(cwd, name), { recursive: true });
    writeFileSync(join(cwd, "c", "release-note.txt"), "A distinct candidate with the same source verifier.\n");
    const [a, b, c] = ["a", "b", "c"].map(name => inspectRuntimePackage(join(cwd, name)));
    store.transaction(() => publishRuntime(store.db, a, home, { bootstrap: true, shellRoot: a.root }));
    const first = prepareColdHostEpochInstallation(store, { source: a, candidate: b, shellRoot: b.root });
    relocateColdHostEpochEntries(store, first.id, { inventory: () => [] });
    commitColdHostEpochRetirement(store, inspectColdHostEpochRetirement(store, first.id, { inventory: () => [] }));
    assertColdEpochRetirement(store.db, a.digest, b.digest);
    run({ store, a, b, c, first, cwd });
  } finally {
    store.close();
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

test("repeated preparation rejects a live host before changing prior retirement authority", () => {
  for (const appearsAfterVerification of [false, true]) fixture(({ store, a, b, c }) => {
    const before = state(store.db); let calls = 0;
    const inventory = () => ++calls === 1 && appearsAfterVerification ? [] : [{ pid: 1, executable: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" }];
    assert.throws(() => prepareColdHostEpochInstallation(store, { source: runtimeGeneration(store.db, b.digest), candidate: c,
      shellRoot: c.root, inventory }), /Cold bootstrap requires native Codex hosts to be stopped/);
    assert.equal(state(store.db), before);
    assertColdEpochRetirement(store.db, a.digest, b.digest);
  });
});

test("a second cold preparation retains absent old paths and re-proves retirement before changing the default", () => fixture(({ store, a, b, c, first }) => {
  const oldReceipt = store.db.prepare("SELECT record FROM runtime_epoch_retirements WHERE installation_id=?").get(first.id).record;
  const second = prepareColdHostEpochInstallation(store, { source: runtimeGeneration(store.db, b.digest), candidate: c,
    shellRoot: c.root, inventory: () => [] });
  assert.equal(second.state, "prepared"); assert.equal(second.taskBindingsChanged, 0);
  assert.equal(store.db.prepare("SELECT current_digest FROM runtime_defaults").get().current_digest, b.digest);
  assert.deepEqual(second.recoveryEntries.map(e => e.generation).sort(), [a.digest, b.digest].sort());
  assert.deepEqual(second.publications.map(p => p.source).sort(), [a.digest, b.digest].sort());
  assert.throws(() => inspectColdHostEpochRetirement(store, second.id, { inventory: () => [] }), /old_entry_still/);
  const moved = relocateColdHostEpochEntries(store, second.id, { inventory: () => [] });
  assert.equal(moved.relocated.length, 1); assert.equal(moved.relocated[0].originalPath, b.root);
  commitColdHostEpochRetirement(store, inspectColdHostEpochRetirement(store, second.id, { inventory: () => [] }));
  assert.equal(store.db.prepare("SELECT current_digest FROM runtime_defaults").get().current_digest, c.digest);
  for (const source of [a, b]) assertColdEpochRetirement(store.db, source.digest, c.digest);
  assert.equal(store.db.prepare("SELECT record FROM runtime_epoch_retirements WHERE installation_id=?").get(first.id).record, oldReceipt);
  assert.equal(inspectRuntimePackage(runtimeGeneration(store.db, a.digest).root).digest, a.digest);
  assert.equal(readFileSync(join(c.root, "release-note.txt"), "utf8"), "A distinct candidate with the same source verifier.\n");
}));

test("atomic repeated preparation preserves prior authority when publication or installation fails", () => {
  for (const table of ["runtime_epoch_publications", "runtime_epoch_installations"]) fixture(({ store, a, b, c }) => {
    const before = state(store.db);
    store.db.exec(`CREATE TEMP TRIGGER interrupt_preparation BEFORE INSERT ON ${table}
      BEGIN SELECT RAISE(ABORT, 'interrupted cold preparation'); END`);
    assert.throws(() => prepareColdHostEpochInstallation(store, { source: runtimeGeneration(store.db, b.digest),
      candidate: c, shellRoot: c.root, inventory: () => [] }), /interrupted cold preparation/);
    assert.equal(state(store.db), before, "A failed preparation cannot partially revoke the installed runtime");
    assertColdEpochRetirement(store.db, a.digest, b.digest);
    store.db.exec("DROP TRIGGER interrupt_preparation");
  });
});

for (const mode of ["missing-retained", "changed-present", "dangling-old-entry"])
  test(`repeated cold preparation rejects ${mode} without changing its registry`, () => fixture(({ store, a, b, c, cwd }) => {
    const before = state(store.db);
    if (mode === "missing-retained") rmSync(runtimeGeneration(store.db, a.digest).root, { recursive: true });
    if (mode === "changed-present") writeFileSync(join(b.root, "changed-entry.txt"), "Unexpected package change.\n");
    if (mode === "dangling-old-entry") symlinkSync(join(cwd, "missing-target"), a.root);
    assert.throws(() => prepareColdHostEpochInstallation(store, { source: runtimeGeneration(store.db, b.digest), candidate: c,
      shellRoot: c.root, inventory: () => [] }));
    assert.equal(state(store.db), before);
  }));

for (const retired of [false, true]) test(`repeated cold recovery restores the original boundary after ${retired ? "retirement" : "preparation"}`,
  () => fixture(({ store, a, b, c, first }) => {
    const registry = payloadHash(store.db.prepare("SELECT * FROM runtime_host_entries ORDER BY path").all());
    const oldReceipt = store.db.prepare("SELECT record FROM runtime_epoch_retirements WHERE installation_id=?").get(first.id).record;
    const next = prepareColdHostEpochInstallation(store, { source: runtimeGeneration(store.db, b.digest), candidate: c, shellRoot: c.root, inventory: () => [] });
    if (retired) {
      relocateColdHostEpochEntries(store, next.id, { inventory: () => [] });
      commitColdHostEpochRetirement(store, inspectColdHostEpochRetirement(store, next.id, { inventory: () => [] }));
    }
    restoreColdHostEpochEntries(store, next.id, { inventory: () => [] });
    assert.equal(existsSync(a.root), false, "An entry already retired before this upgrade remains absent");
    assert.equal(inspectRuntimePackage(b.root).digest, b.digest);
    assert.equal(payloadHash(store.db.prepare("SELECT * FROM runtime_host_entries ORDER BY path").all()), registry);
    assertColdEpochRetirement(store.db, a.digest, b.digest);
    assert.equal(store.db.prepare("SELECT record FROM runtime_epoch_retirements WHERE installation_id=?").get(first.id).record, oldReceipt);
    const completed = state(store.db);
    assert.equal(restoreColdHostEpochEntries(store, next.id, { inventory: () => [] }).idempotent, true);
    assert.equal(state(store.db), completed);
    assert.throws(() => inspectColdHostEpochRetirement(store, next.id, { inventory: () => [] }), /cold_source_registry_changed/);
    assert.throws(() => relocateColdHostEpochEntries(store, next.id, { inventory: () => [] }), /cold_source_registry_changed/);
  }));

test("repeated recovery resumes durable interruption and refuses late hosts, registry changes and unexpected old paths", () => {
  for (const mode of ["after-revoke", "late-host", "changed-registry", "restored-old-path"]) fixture(({ store, a, b, c }) => {
    const registry = payloadHash(store.db.prepare("SELECT * FROM runtime_host_entries ORDER BY path").all());
    const next = prepareColdHostEpochInstallation(store, { source: runtimeGeneration(store.db, b.digest), candidate: c, shellRoot: c.root, inventory: () => [] });
    relocateColdHostEpochEntries(store, next.id, { inventory: () => [] });
    commitColdHostEpochRetirement(store, inspectColdHostEpochRetirement(store, next.id, { inventory: () => [] }));
    const transact = store.transaction.bind(store), extraPath = c.root + "-unrelated";
    if (mode === "after-revoke") store.transaction = callback => {
      const result = transact(callback);
      if (JSON.parse(store.db.prepare("SELECT record FROM runtime_epoch_entry_recoveries ORDER BY rowid DESC LIMIT 1").get()?.record || "null")?.phase === "started")
        throw new Error("Interrupted after durable recovery revocation");
      return result;
    };
    if (mode === "restored-old-path") cpSync(runtimeGeneration(store.db, a.digest).root, a.root, { recursive: true });
    let checks = 0;
    const inventory = () => {
      checks++;
      if (checks === 3 && mode === "late-host") return [{ pid: 1, executable: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" }];
      if (checks === 3 && mode === "changed-registry") store.db.prepare("INSERT INTO runtime_host_entries VALUES(?,?,'referenced')").run(extraPath, a.digest);
      return [];
    };
    const expected = { "after-revoke": /Interrupted after durable/, "late-host": /Cold bootstrap requires/,
      "changed-registry": /cold_source_registry_changed/, "restored-old-path": /cold_previously_absent_entry_restored/ }[mode];
    assert.throws(() => restoreColdHostEpochEntries(store, next.id, { inventory }), expected);
    store.transaction = transact;
    if (mode === "changed-registry") {
      assert.equal(store.db.prepare("SELECT generation FROM runtime_host_entries WHERE path=?").get(extraPath).generation, a.digest);
      store.db.prepare("DELETE FROM runtime_host_entries WHERE path=?").run(extraPath); // Resolve only the isolated injected change.
    }
    if (mode === "restored-old-path") rmSync(a.root, { recursive: true });
    else {
      assert.throws(() => assertColdEpochRetirement(store.db, a.digest, c.digest), /cold_retirement_revoked_by_recovery/);
      assert.equal(JSON.parse(store.db.prepare("SELECT record FROM runtime_epoch_entry_recoveries ORDER BY rowid DESC LIMIT 1").get().record).phase, "started");
    }
    restoreColdHostEpochEntries(store, next.id, { inventory: () => [] });
    assert.equal(existsSync(a.root), false); assert.equal(inspectRuntimePackage(b.root).digest, b.digest);
    assert.equal(payloadHash(store.db.prepare("SELECT * FROM runtime_host_entries ORDER BY path").all()), registry);
    assertColdEpochRetirement(store.db, a.digest, b.digest);
  });
});
