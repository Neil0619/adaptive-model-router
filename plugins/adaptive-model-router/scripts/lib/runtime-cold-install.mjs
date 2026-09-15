import { lstatSync, realpathSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { AppServerClient } from "./app-server.mjs";
import { canonicalJson, payloadHash } from "./io.mjs";
import { copyRuntimePackage, managedRuntimeDestination, verifyRuntimePackage } from "./runtime-package.mjs";
import { ensureRuntimeIsolationSchema, publishedDefault, runtimeGeneration } from "./runtime-isolation.mjs";
import { ensureHostEpochSchema } from "./host-epoch-storage.mjs";
import { qualifyHostEpochPublication, publishHostEpoch } from "./runtime-epoch.mjs";
import { runtimeSourceDigest } from "./lifecycle-qualification.mjs";
import { nativeProcessInventory, assertColdProcessInventory } from "./runtime-cold-transition.mjs";
import { pendingNativeMessageBatch } from "./message-checkpoint.mjs";

// Separate from coldLegacy: that historical bridge still freezes Hook bytes.
// These records authorize only installation preparation / entry retirement.
// A task handover additionally requires its real B Hook and operation evidence.
const RETIREMENTS = new WeakMap();
const blocked = (reason) => { throw new Error(`Host compatibility epoch blocked: ${reason}`); };
function schema(db) {
  ensureRuntimeIsolationSchema(db); ensureHostEpochSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS runtime_epoch_installations (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, candidate TEXT NOT NULL, record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runtime_epoch_retirements (
    id TEXT PRIMARY KEY, installation_id TEXT NOT NULL REFERENCES runtime_epoch_installations(id), record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runtime_epoch_entry_recoveries (
    id TEXT PRIMARY KEY, installation_id TEXT NOT NULL REFERENCES runtime_epoch_installations(id), record TEXT NOT NULL);`);
  for (const table of ["runtime_epoch_installations", "runtime_epoch_retirements", "runtime_epoch_entry_recoveries"]) db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'cold installation evidence is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'cold installation evidence is retained'); END;`);
}
const history = (db) => payloadHash(["routes", "outcomes", "delegation_attempts", "delegation_children", "delegation_messages",
  "runtime_tasks", "runtime_stages", "runtime_invocations", "runtime_call_receipts", "runtime_defaults", "runtime_epoch_entry_recoveries",
  "runtime_generations", "runtime_host_entries", "runtime_epoch_publications", "runtime_epoch_retirements"]
  .map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
const bootstrapRecord = (db) => db.prepare("SELECT value FROM meta WHERE key='runtime_legacy_bootstrap'").get()?.value || null;
function sourceDigests(db) {
  const sources = new Set(db.prepare(`SELECT generation FROM runtime_host_entries WHERE state='referenced'
    UNION SELECT generation FROM runtime_tasks UNION SELECT candidate FROM runtime_tasks WHERE candidate IS NOT NULL
    UNION SELECT generation FROM runtime_stages UNION SELECT generation FROM runtime_invocations
    UNION SELECT generation FROM runtime_call_receipts UNION SELECT current_digest FROM runtime_defaults
    UNION SELECT rollback_digest FROM runtime_defaults WHERE rollback_digest IS NOT NULL`).all().map((row) => row.generation));
  const bootstrap = JSON.parse(bootstrapRecord(db) || "null");
  for (const digest of [bootstrap?.legacyDigest, bootstrap?.defaultDigest]) if (digest) sources.add(digest);
  return [...sources].sort();
}
const entryRegistry = (db) => db.prepare("SELECT * FROM runtime_host_entries ORDER BY path").all();
const sourceSnapshot = (db, candidate) => payloadHash({ entries: entryRegistry(db), bootstrap: bootstrapRecord(db),
  registry: db.prepare("SELECT * FROM runtime_generations ORDER BY digest").all(),
  sources: sourceDigests(db).filter((digest) => digest !== candidate) });
const latestRecovery = (db, id) => db.prepare("SELECT id FROM runtime_epoch_entry_recoveries WHERE installation_id=? ORDER BY rowid DESC LIMIT 1").get(id)?.id || null;
function activeRetirement(db, id) {
  const row = db.prepare("SELECT * FROM runtime_epoch_retirements WHERE installation_id=? ORDER BY rowid DESC LIMIT 1").get(id);
  if (!row) return null;
  const record = JSON.parse(row.record);
  return record.recovery === latestRecovery(db, id) ? { ...row, record } : null;
}
function assertPreparedSources(db, record) {
  if (sourceSnapshot(db, record.candidate) !== record.sourceSnapshot) blocked("cold_source_registry_changed");
  if (canonicalJson(publishedDefault(db)) !== canonicalJson(record.defaults)) blocked("cold_default_changed");
}
function installation(db, id) {
  const row = db.prepare("SELECT * FROM runtime_epoch_installations WHERE id=?").get(id);
  if (!row) blocked("cold_installation_missing");
  const record = JSON.parse(row.record);
  if (record.id !== id || record.verifier !== runtimeSourceDigest()) blocked("cold_installation_source_changed");
  if (payloadHash(entryRegistry(db)) !== record.entryRegistryDigest || bootstrapRecord(db) !== record.bootstrap)
    blocked("cold_source_registry_changed");
  for (const source of record.sources) {
    verifyRuntimePackage(runtimeGeneration(db, source.generation));
    const proof = db.prepare("SELECT record FROM runtime_epoch_publications WHERE id=? AND source=? AND candidate=?")
      .get(source.publicationId, source.generation, record.candidate);
    if (!proof || JSON.parse(proof.record).verifier !== record.verifier || JSON.parse(proof.record).entryMode !== "cold")
      blocked("cold_source_publication_changed");
  }
  verifyRuntimePackage({ ...runtimeGeneration(db, record.candidate), root: record.shellRoot });
  return record;
}
function absentEntries(record) {
  for (const entry of record.entries) {
    // lstat detects dangling symlinks too. Re-creating even an exact old entry
    // revokes retirement; restoration is recovery, never admission evidence.
    try { lstatSync(entry.path); blocked("cold_old_entry_still_executable_or_restored"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

export function coldPendingMessageResponsibilities(db, context = null) {
  const children = context ? db.prepare("SELECT * FROM delegation_children WHERE project_id=? AND context_key=?").all(context.projectId, context.contextKey)
    : db.prepare("SELECT * FROM delegation_children").all();
  return pendingNativeMessageBatch(db, children, { coldBatch: context === null });
}
export function assertColdMessageCheckpoint(db, context = null) {
  if (coldPendingMessageResponsibilities(db, context).length) blocked("cold_accepted_input_checkpoint_required");
}

export function prepareColdHostEpochInstallation(store, { source, candidate, shellRoot }) {
  shellRoot = realpathSync(shellRoot);
  verifyRuntimePackage({ ...candidate, root: shellRoot });
  schema(store.db);
  const dataRoot = dirname(store.path);
  const before = sourceSnapshot(store.db, candidate.digest), originalDefaults = publishedDefault(store.db);
  const entries = store.db.prepare("SELECT path,generation FROM runtime_host_entries WHERE state='referenced' ORDER BY path").all();
  const enrolled = new Set(entries.map((entry) => entry.path));
  // A --source may be a retained package, not an executable native entry.
  // Only an initial unenrolled installation needs the explicit old entry.
  const managedSource = ["published", "archive"].some((area) => source.root === managedRuntimeDestination(dataRoot, area, source.digest));
  if (!originalDefaults && !managedSource && !enrolled.has(source.root)) entries.push({ path: source.root, generation: source.digest });
  const originals = new Map(sourceDigests(store.db).filter((digest) => digest !== candidate.digest)
    .map((digest) => [digest, digest === source.digest ? source : runtimeGeneration(store.db, digest)]));
  if (source.digest === candidate.digest) blocked("cold_source_is_candidate");
  originals.set(source.digest, source);
  // Review and execute each A/B pair before publishing any one of them.
  const tokens = [...originals.values()].map((original) => qualifyHostEpochPublication(original, candidate, { cold: true }));
  const retained = new Map([...originals.values()].map((original) => [original.digest,
    copyRuntimePackage(original, managedRuntimeDestination(dataRoot, "published", original.digest))]));
  const retainedCandidate = copyRuntimePackage(candidate, managedRuntimeDestination(dataRoot, "published", candidate.digest));
  for (const entry of entries) {
    if (entry.path === shellRoot) continue;
    const original = originals.get(entry.generation);
    if (!original) blocked("cold_old_entry_source_uncovered");
    if (["published", "archive"].some((area) => entry.path === managedRuntimeDestination(dataRoot, area, original.digest)))
      blocked("cold_retained_package_registered_as_native_entry");
    verifyRuntimePackage({ ...original, root: entry.path });
  }
  const nativeCache = resolve(process.env.CODEX_HOME, "plugins/cache");
  const inCache = (path) => { const tail = relative(nativeCache, path); return tail && !isAbsolute(tail) && tail !== ".." && !tail.startsWith(`..${sep}`); };
  const record = { schema: "runtime-epoch-cold-installation/2", source: source.digest, candidate: candidate.digest,
    shellRoot, entries: entries.filter((entry) => entry.path !== shellRoot).map((entry) => ({ ...entry,
      ownership: enrolled.has(entry.path) ? "enrolled_native_entry" : inCache(entry.path) ? "native_plugin_cache" : "reference_only",
      archivePath: managedRuntimeDestination(dataRoot, "native-entry-archive", payloadHash([entry.path, entry.generation])) })), verifier: runtimeSourceDigest(),
    recovery: "restore exact retained package to its original path only in a cold recovery window; this revokes retirement" };
  if (!record.entries.length) blocked("cold_old_entry_inventory_empty");
  store.transaction(() => {
    if (sourceSnapshot(store.db, candidate.digest) !== before || canonicalJson(publishedDefault(store.db)) !== canonicalJson(originalDefaults))
      blocked("cold_source_registry_changed");
    for (const copy of retained.values()) {
      const current = store.db.prepare("SELECT record,state FROM runtime_generations WHERE digest=?").get(copy.digest) || null;
      if (current) store.db.prepare("UPDATE runtime_generations SET record=?,state='published' WHERE digest=?").run(canonicalJson(copy), copy.digest);
      else store.db.prepare("INSERT INTO runtime_generations VALUES(?,?,'published')").run(copy.digest, canonicalJson(copy));
    }
    if (!publishedDefault(store.db)) {
      // Additive enrollment records effective A ownership without relabeling
      // historical creators, touching qualification, or settling any business.
      store.db.prepare("INSERT INTO runtime_defaults(singleton,current_digest) VALUES(1,?)").run(source.digest);
      store.db.prepare(`INSERT OR IGNORE INTO runtime_tasks(project_id,context_key,generation)
        SELECT project_id,context_key,? FROM (SELECT project_id,context_key FROM host_model_state
        UNION SELECT project_id,context_key FROM routes UNION SELECT project_id,context_key FROM delegation_attempts
        UNION SELECT project_id,context_key FROM delegation_children)`).run(source.digest);
      store.db.prepare(`INSERT OR IGNORE INTO runtime_stages(route_id,project_id,context_key,generation)
        SELECT route_id,project_id,context_key,? FROM (SELECT route_id,project_id,context_key FROM routes WHERE action='delegate'
        UNION SELECT route_id,project_id,context_key FROM delegation_attempts
        UNION SELECT route_id,project_id,context_key FROM delegation_children)`).run(source.digest);
      store.db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES('runtime_legacy_bootstrap',?)")
        .run(canonicalJson({ legacyDigest: source.digest, defaultDigest: source.digest, cutoverTime: Date.now(),
          basis: "cold epoch preparation; effective execution only, historical creator remains unchanged" }));
    }
    for (const entry of record.entries) store.db.prepare("INSERT OR IGNORE INTO runtime_host_entries VALUES(?,?,'referenced')")
      .run(entry.path, entry.generation);
    store.db.prepare("INSERT OR IGNORE INTO runtime_generations VALUES(?,?,'published')").run(candidate.digest, canonicalJson(retainedCandidate));
    store.db.prepare("INSERT OR IGNORE INTO runtime_host_entries VALUES(?,?,'referenced')").run(record.shellRoot, candidate.digest);
    if (!store.db.prepare("SELECT 1 FROM runtime_host_entries WHERE path=? AND generation=? AND state='referenced'").get(record.shellRoot, candidate.digest))
      blocked("cold_candidate_entry_registration_changed");
    record.defaults = publishedDefault(store.db);
    record.bootstrap = bootstrapRecord(store.db);
    record.entryRegistryDigest = payloadHash(entryRegistry(store.db));
    record.sourceSnapshot = sourceSnapshot(store.db, candidate.digest);
  });
  const publications = tokens.map((token) => publishHostEpoch(store, token));
  record.sources = publications.map((publication) => ({ generation: publication.source, publicationId: publication.id }))
    .sort((a, b) => a.generation.localeCompare(b.generation));
  record.id = payloadHash(record);
  store.transaction(() => {
    assertPreparedSources(store.db, record);
    if (canonicalJson(publishedDefault(store.db)) !== canonicalJson(record.defaults)) blocked("cold_default_changed");
    store.db.prepare("INSERT OR IGNORE INTO runtime_epoch_installations VALUES(?,?,?,?)")
      .run(record.id, record.source, record.candidate, canonicalJson(record));
  });
  return { id: record.id, publication: publications.find((proof) => proof.source === source.digest), publications,
    state: "prepared", installationComplete: false, taskBindingsChanged: 0,
    pendingMessages: coldPendingMessageResponsibilities(store.db),
    nextAction: "cold_native_install_then_source_verified_retirement; per_task_Hook_confirmation_still_required",
    recoveryEntries: record.entries.map((entry) => ({ ...entry, retainedPath: runtimeGeneration(store.db, entry.generation).root })) };
}

// Only the source verifier can mint this in-memory capability. The production
// CLI exposes no inventory, passed, retirement, or proof JSON argument. Unit
// fixtures replace the OS inventory, but still need absent real old paths and
// exact original and candidate package bytes in an isolated home.
export function inspectColdHostEpochRetirement(store, id, { inventory = nativeProcessInventory } = {}) {
  const record = installation(store.db, id);
  assertColdMessageCheckpoint(store.db);
  const processes = assertColdProcessInventory(inventory());
  if (!activeRetirement(store.db, id)) assertPreparedSources(store.db, record);
  absentEntries(record);
  const token = Object.freeze({});
  RETIREMENTS.set(token, { id: randomUUID(), store, record, history: history(store.db), inventory,
    recovery: latestRecovery(store.db, id),
    processDigest: payloadHash(processes), deadline: Date.now() + 5_000 });
  return token;
}
export function commitColdHostEpochRetirement(store, token) {
  const saved = RETIREMENTS.get(token);
  if (saved?.store !== store) blocked("source_owned_cold_retirement_missing");
  assertColdProcessInventory(saved.inventory());
  return store.transaction(() => {
    const record = installation(store.db, saved.record.id); absentEntries(record);
    const previous = store.db.prepare("SELECT record FROM runtime_epoch_retirements WHERE id=?").get(saved.id);
    if (previous) {
      if (JSON.parse(previous.record).recovery !== latestRecovery(store.db, record.id)) blocked("cold_retirement_revoked_by_recovery");
      return { id: record.id, state: "awaiting_task_entries", idempotent: true, installationComplete: false };
    }
    if (Date.now() > saved.deadline || history(store.db) !== saved.history) blocked("cold_history_changed");
    const defaults = publishedDefault(store.db);
    const active = activeRetirement(store.db, record.id);
    if (active) {
      if (canonicalJson(defaults) !== canonicalJson(active.record.appliedDefaults)) blocked("cold_default_changed");
      return { id: record.id, state: "awaiting_task_entries", idempotent: true, installationComplete: false };
    }
    assertPreparedSources(store.db, record);
    if (canonicalJson(defaults) !== canonicalJson(record.defaults)) blocked("cold_default_changed");
    const appliedDefaults = { ...defaults, current_digest: record.candidate, rollback_digest: defaults.current_digest };
    store.db.prepare("INSERT INTO runtime_epoch_retirements VALUES(?,?,?)").run(saved.id, record.id, canonicalJson({
      schema: "runtime-epoch-cold-retirement/2", installationId: record.id, source: record.source, candidate: record.candidate,
      sources: record.sources, previousDefaults: defaults, appliedDefaults,
      recovery: saved.recovery,
      verifier: record.verifier, baselineDigest: saved.history, processDigest: saved.processDigest, retiredAt: Date.now(),
      scope: "original native launch paths only; no task or child entry is inferred" }));
    store.db.prepare("UPDATE runtime_defaults SET rollback_digest=current_digest,current_digest=? WHERE singleton=1").run(record.candidate);
    // The retirement appends a new birth cutover. The original v1 bootstrap
    // remains byte-for-byte evidence of the first boundary, including recovery.
    return { id: record.id, state: "awaiting_task_entries", installationComplete: false, taskBindingsChanged: 0 };
  });
}
export function assertColdEpochRetirement(db, source, candidate) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_epoch_retirements'").get()) blocked("cold_entry_retirement_missing");
  const row = db.prepare(`SELECT i.id,r.record FROM runtime_epoch_installations i JOIN runtime_epoch_retirements r ON r.installation_id=i.id
    WHERE i.candidate=? AND EXISTS(SELECT 1 FROM json_each(i.record,'$.sources') s
      WHERE json_extract(s.value,'$.generation')=?) ORDER BY r.rowid DESC LIMIT 1`).get(candidate, source);
  if (!row) blocked("cold_entry_retirement_missing");
  const recovery = latestRecovery(db, row.id);
  if (JSON.parse(row.record).recovery !== recovery) blocked("cold_retirement_revoked_by_recovery");
  const record = installation(db, row.id); absentEntries(record); return record;
}

// Native installation prunes caches, but old absolute stable-shell commands can
// point outside them. Move only exact registry-owned entries, in a proven cold
// window, to deterministic recovery paths. A crash between renames is resumable
// from those exact paths; neither bytes nor responsibilities are rewritten.
export function relocateColdHostEpochEntries(store, id, { inventory = nativeProcessInventory } = {}) {
  assertColdProcessInventory(inventory());
  const record = installation(store.db, id), before = history(store.db);
  if (!activeRetirement(store.db, id)) assertPreparedSources(store.db, record);
  const present = [];
  for (const entry of record.entries) {
    if (!existsSync(entry.path)) {
      if (existsSync(entry.archivePath)) verifyRuntimePackage({ ...runtimeGeneration(store.db, entry.generation), root: entry.archivePath });
      continue;
    }
    if (!["enrolled_native_entry", "native_plugin_cache"].includes(entry.ownership)) blocked("cold_old_path_ownership_unproven");
    verifyRuntimePackage({ ...runtimeGeneration(store.db, entry.generation), root: entry.path });
    if (existsSync(entry.archivePath)) blocked("cold_original_and_archive_both_present");
    present.push(entry);
  }
  assertColdProcessInventory(inventory());
  if (history(store.db) !== before) blocked("cold_history_changed");
  for (const entry of present) {
    mkdirSync(dirname(entry.archivePath), { recursive: true, mode: 0o700 });
    renameSync(entry.path, entry.archivePath);
    verifyRuntimePackage({ ...runtimeGeneration(store.db, entry.generation), root: entry.archivePath });
  }
  return { id, relocated: present.map((entry) => ({ originalPath: entry.path, archivePath: entry.archivePath })),
    state: "old_entry_paths_archived", installationComplete: false };
}

// The one-time native installation runs only after preparation and a cold
// boundary. It never edits native trust. The owned installer process is awaited
// to its actual exit before retirement, including failure cleanup. Native
// registration success is reported independently from every task's admission.
export async function installColdHostEpoch(store, id, { marketplacePath, client = new AppServerClient({ timeoutMs: 20_000 }),
  inventory = nativeProcessInventory } = {}) {
  const record = installation(store.db, id);
  if (!activeRetirement(store.db, id)) assertPreparedSources(store.db, record);
  assertColdMessageCheckpoint(store.db);
  const manifestPath = realpathSync(marketplacePath);
  const marketplace = JSON.parse(readFileSync(manifestPath, "utf8"));
  const plugin = marketplace.plugins?.find((entry) => entry.name === "adaptive-model-router");
  if (!manifestPath.endsWith("/.agents/plugins/marketplace.json") && !manifestPath.endsWith("\\.agents\\plugins\\marketplace.json"))
    blocked("native_marketplace_manifest_required");
  if (plugin?.source?.source !== "local" || realpathSync(resolve(dirname(dirname(dirname(manifestPath))), plugin.source.path)) !== record.shellRoot)
    blocked("native_marketplace_candidate_changed");
  assertColdProcessInventory(inventory());
  let nativeReceipt;
  try {
    await client.start();
    nativeReceipt = await client.request("plugin/install", { marketplacePath: manifestPath, pluginName: "adaptive-model-router" });
  } finally {
    const child = client.process;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); client.close();
      let timer;
      try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Owned native installer exit is unproven")), 5000); })]); }
      finally { clearTimeout(timer); }
    } else client.close();
  }
  // A native installation may have succeeded without removing all historical
  // executable paths. Preserve that useful receipt and return concrete pending
  // state; never convert it to a retirement capability or a task proof.
  try {
    relocateColdHostEpochEntries(store, id, { inventory });
    const retired = commitColdHostEpochRetirement(store, inspectColdHostEpochRetirement(store, id, { inventory }));
    return { ...retired, nativeRegistration: "completed", nativeReceipt,
      nextAction: "resume_native_tasks_then_watch_actual_root_and_child_entries; unchanged_or_untrusted_Hooks_remain_pending" };
  } catch (error) {
    return { id, state: "native_installed_retirement_pending", nativeRegistration: "completed", nativeReceipt,
      installationComplete: false, reason: error.message,
      nextAction: "inspect_exact_old_entry_or_live_process_and_resume_retirement_in_a_cold_window" };
  }
}

export function restoreColdHostEpochEntries(store, id, { inventory = nativeProcessInventory } = {}) {
  assertColdProcessInventory(inventory());
  const record = installation(store.db, id);
  const assertUnused = () => {
    if (store.db.prepare("SELECT 1 FROM runtime_tasks WHERE generation=? OR candidate=?").get(record.candidate, record.candidate)
      || store.db.prepare("SELECT 1 FROM runtime_stages WHERE generation=?").get(record.candidate)
      || store.db.prepare("SELECT 1 FROM runtime_epoch_receipts WHERE candidate=?").get(record.candidate))
      blocked("cold_recovery_requires_task_rollback_first");
  };
  assertUnused();
  const active = activeRetirement(store.db, id), before = history(store.db);
  const expectedDefaults = active?.record.appliedDefaults || record.defaults;
  if (canonicalJson(publishedDefault(store.db)) !== canonicalJson(expectedDefaults)) blocked("cold_default_changed");
  // A later cold cutover owns the default even if its digest happens to match.
  if (active && store.db.prepare("SELECT id FROM runtime_epoch_retirements ORDER BY rowid DESC LIMIT 1").get()?.id !== active.id)
    blocked("cold_default_changed");
  for (const entry of record.entries) {
    const original = runtimeGeneration(store.db, entry.generation);
    for (const path of [entry.path, entry.archivePath]) if (existsSync(path)) verifyRuntimePackage({ ...original, root: path });
  }
  assertColdProcessInventory(inventory());
  // Revoke before restoring even the first path. An interrupted restoration
  // must not leave a still-valid retirement row after the path disappears again.
  store.transaction(() => {
    installation(store.db, id); assertUnused();
    if (history(store.db) !== before) blocked("cold_history_changed");
    if (canonicalJson(publishedDefault(store.db)) !== canonicalJson(expectedDefaults)) blocked("cold_default_changed");
    store.db.prepare("INSERT INTO runtime_epoch_entry_recoveries VALUES(?,?,?)")
      .run(randomUUID(), id, canonicalJson({ schema: "runtime-epoch-entry-recovery/2", verifier: runtimeSourceDigest(), startedAt: Date.now(),
        retirementId: active?.id || null, previousDefaults: expectedDefaults, restoredDefaults: record.defaults,
        scope: "revoke this cold cutover and restore its exact prior default; retain original bootstrap and all task history" }));
    store.db.prepare("UPDATE runtime_defaults SET current_digest=?,rollback_digest=? WHERE singleton=1")
      .run(record.defaults.current_digest, record.defaults.rollback_digest);
  });
  const restored = [];
  for (const entry of record.entries) {
    const original = runtimeGeneration(store.db, entry.generation);
    if (!existsSync(entry.path) && existsSync(entry.archivePath)) {
      verifyRuntimePackage({ ...original, root: entry.archivePath });
      mkdirSync(dirname(entry.path), { recursive: true }); renameSync(entry.archivePath, entry.path);
      verifyRuntimePackage({ ...original, root: entry.path }); restored.push(entry.path);
    } else restored.push(copyRuntimePackage(original, entry.path).root);
  }
  return { id, restored, state: "recovery_entries_restored", installationComplete: false,
    nextAction: "cold_retirement_is_revoked_until_original_paths_are_retired_again" };
}
