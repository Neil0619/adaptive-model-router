// Read-only discovery plus direct calls into one verified, published C2 package.
// No schema creation, runtime SQL writes, rollout parsing or proof fabrication.
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { FIXED, PUBLICATIONS, hash, check, assertThread } from './runtime-epoch-coordinator.mjs';

// Verify bytes before importing any executable from the package. C2's own
// verifier then checks descriptors, writer/source fingerprints and DB records.
export function packageDigest(root) {
  check(realpathSync(root) === root && !lstatSync(root).isSymbolicLink(), 'runtime_root_redirected');
  const files = [];
  const visit = (directory, prefix = '') => {
    for (const name of readdirSync(directory).sort()) {
      const relative = prefix + name, path = join(directory, name), info = lstatSync(path);
      if (info.isDirectory()) visit(path, relative + '/');
      else { check(info.isFile() && !info.isSymbolicLink(), 'runtime_non_regular_file'); files.push([relative, hash(readFileSync(path))]); }
    }
  };
  visit(root);
  return hash(files);
}
const fileIdentity = (path) => {
  if (!path) return null;
  try {
    const info = statSync(path);
    return { path, dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
  } catch (error) { return { path, unavailable: error.code || 'unverified' }; }
};
export function restartRequired(reason) { return Object.assign(new Error(reason), { code: 'COORDINATOR_RESTART' }); }
export function assertClientAlive(client) {
  if (client.closedError) throw restartRequired('native_client_exited_restart_coordinator');
}

// Keep the original verifier's result. An unavailable inventory is an evidence
// acquisition failure, never a passed binding or a permanent business refusal.
export async function inspectAvailableHookBinding(api, options) {
  const readiness = await api.inspectLifecycleHookReadiness(options);
  if (!readiness?.binding) {
    const reason = readiness?.reasonCode || 'current_Hook_binding_missing';
    if (reason === 'HOST_HOOK_STATUS_UNAVAILABLE') {
      throw Object.assign(new Error(reason), { code: 'COORDINATOR_EVIDENCE_UNAVAILABLE' });
    }
    throw new Error(reason);
  }
  return readiness;
}

export async function preparePublishedHandover(api, store, config, parent, turn) {
  assertThread(parent);
  const context = store.context({ cwd: parent.cwd, contextId: parent.id, create: false });
  const task = api.runtimeTask(store.db, context);
  check(task && PUBLICATIONS[task.generation] && ![FIXED.shellDigest, FIXED.candidate].includes(task.generation), 'old_published_source_required');
  const { qualification: prior, sourceGeneration } = api.sourceTaskQualification(store.db, context, task.generation);
  const inspect = (options) => inspectAvailableHookBinding(api, options);
  const inspectBinding = () => inspect({ store, context: { ...context, runtimeDigest: FIXED.candidate },
    contextId: parent.id, cwd: parent.cwd, pluginRoot: config.shellRoot, historicalAdoption: false });
  const readiness = await inspectBinding();
  let adoptionToken = null;
  if (prior?.state === 'passed') adoptionToken = await api.prepareHistoricalQualificationAdoption({ contextId: parent.id,
    routeId: prior.routeId, turnId: turn.id, generation: FIXED.candidate },
  { store, cwd: parent.cwd, sourceGeneration, binding: readiness.binding, inspectBinding });
  else if (prior) throw new Error('historical_qualification_requires_its_existing_reconciliation');
  assertThread(parent);
  return api.prepareHostEpochHandover(store, { contextId: parent.id, cwd: parent.cwd, turnId: turn.id, transcriptPath: parent.path },
    { candidate: FIXED.candidate, adoptionToken, shellRoot: config.shellRoot, inspect });
}

export function validatePublications(db, api, config, candidateRoot) {
  const candidate = api.runtimeGeneration(db, FIXED.candidate);
  check(candidate && candidate.root === candidateRoot, 'candidate_registration_mismatch');
  api.verifyRuntimePackage(candidate);
  check(api.runtimeSourceDigest(candidateRoot) === FIXED.sourceFingerprint, 'published_verifier_changed');
  const shell = api.runtimeGeneration(db, FIXED.shellDigest);
  // runtime_generations addresses immutable published bytes. The native shell
  // is a separate exact copy addressed by runtime_host_entries; conflating the
  // two paths rejects the real, already deployed B installation.
  check(shell && shell.root === join(config.dataHome, 'runtime-v2', 'published', FIXED.shellDigest), 'shell_registration_mismatch');
  api.verifyRuntimePackage(shell);
  api.verifyRuntimePackage({ ...shell, root: config.shellRoot });
  const boundary = JSON.parse(readFileSync(join(config.shellRoot, 'runtime-host.json'), 'utf8'));
  check(boundary.schema === 1 && boundary.dataHome === config.dataHome && boundary.shellRoot === config.shellRoot,
    'frozen_shell_data_boundary_changed');
  check(db.prepare("SELECT 1 FROM runtime_host_entries WHERE path=? AND generation=? AND state='referenced'")
    .get(config.shellRoot, FIXED.shellDigest), 'frozen_shell_entry_not_registered');
  const defaults = api.publishedDefault(db);
  check(defaults?.current_digest === FIXED.shellDigest, 'global_default_boundary_changed');
  const rows = db.prepare('SELECT * FROM runtime_epoch_publications WHERE candidate=? ORDER BY source').all(FIXED.candidate);
  check(rows.length === Object.keys(PUBLICATIONS).length, 'publication_set_changed');
  for (const row of rows) {
    const record = JSON.parse(row.record), { id, ...body } = record;
    const expected = { schema: 'runtime-epoch-publication/1', source: row.source, candidate: FIXED.candidate,
      verifier: FIXED.sourceFingerprint,
      suite: row.source === FIXED.shellDigest ? 'real-A-B-writers-and-isolated-v2-entry/2' : 'real-A-B-writers-and-isolated-cold-entry/2',
      ...(row.source === FIXED.shellDigest ? {} : { entryMode: 'cold' }) };
    check(PUBLICATIONS[row.source] === row.id && id === row.id && api.payloadHash(body) === id
      && api.payloadHash(body) === api.payloadHash(expected), 'publication_record_changed');
    const source = api.runtimeGeneration(db, row.source);
    check(source && source.digest === row.source, 'source_registration_missing');
    api.verifyRuntimePackage(source);
  }
  check(db.prepare("SELECT state FROM runtime_generations WHERE digest=?").get(FIXED.candidate)?.state === 'published',
    'candidate_not_published');
}

// The immutable package has a constructor that migrates/reconciles. Inspect
// mode must never call it. These are its actual read methods, attached to an
// existing read-only connection and existing salt, with no initialization SQL.
function readOnlyStore(api, path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const salt = db.prepare("SELECT value FROM meta WHERE key='local_salt'").get()?.value;
    check(salt, 'existing_router_salt_missing');
    return Object.assign(Object.create(api.RouterStore.prototype), { db, path, salt, identityCache: new Map(), runtimeInvocation: null });
  } catch (error) { db.close(); throw error; }
}

export async function createPublishedAdapter(config, { inspectOnly = false } = {}) {
  const candidateRoot = join(config.dataHome, 'runtime-v2', 'published', FIXED.candidate);
  for (const path of [config.dataHome, config.codexHome, config.shellRoot]) {
    check(realpathSync(path) === path, 'configured_root_redirected');
  }
  check(packageDigest(candidateRoot) === FIXED.candidate, 'fixed_C2_package_changed');
  check(packageDigest(config.shellRoot) === FIXED.shellDigest, 'fixed_B_shell_changed');
  const database = join(config.dataHome, 'router.sqlite3');
  check(realpathSync(database) === database && statSync(database).isFile(), 'existing_router_database_required');
  check(realpathSync(config.nativeCommand) === config.nativeCommand, 'native_command_redirected');
  const nativeBoundary = hash({ path: config.nativeCommand, digest: hash(readFileSync(config.nativeCommand)), codexHome: config.codexHome });
  // This process is the coordinator, never a task's active Hook or MCP lease.
  process.env.ADAPTIVE_ROUTER_HOME = config.dataHome;
  process.env.PLUGIN_DATA = config.dataHome;
  process.env.CODEX_HOME = config.codexHome;
  process.env.CODEX_BIN = config.nativeCommand;
  process.env.ADAPTIVE_ROUTER_INVOCATION_ID = '';
  delete process.env.CODEX_SQLITE_HOME;
  check(process.env.ADAPTIVE_ROUTER_LOCAL_ONLY !== '1', 'production_adapter_rejects_local_only_mode');
  const api = {};
  for (const name of ['database', 'runtime-isolation', 'runtime-package', 'lifecycle-qualification', 'runtime-epoch',
    'runtime-epoch-sweep', 'hook-readiness', 'app-server', 'io']) {
    Object.assign(api, await import(pathToFileURL(join(candidateRoot, 'scripts/lib', name + '.mjs'))));
  }
  let store = readOnlyStore(api, database), client;
  try {
    validatePublications(store.db, api, config, candidateRoot);
    if (!inspectOnly) {
      store.close();
      store = new api.RouterStore({ path: database }); // Existing C2 owns all runtime initialization/writes.
      validatePublications(store.db, api, config, candidateRoot);
    }
    client = new api.AppServerClient({ timeoutMs: 20_000,
      resolveImpl: async () => ({ path: config.nativeCommand, kind: 'direct' }) });
    await client.start();
  } catch (error) { client?.close(); store?.close(); throw error; }
  const request = async (...args) => {
    assertClientAlive(client);
    try { return await client.request(...args); }
    catch (error) { assertClientAlive(client); throw error; }
  };
  const contextFor = (thread) => {
    assertThread(thread);
    return store.context({ cwd: thread.cwd, contextId: thread.id, create: false });
  };
  const tables = ['runtime_invocations', 'runtime_root_commands', 'runtime_call_receipts', 'runtime_stages',
    'delegation_attempts', 'delegation_children'];
  const stageTables = ['delegation_messages', 'delegation_child_stops', 'delegation_child_commands',
    'delegation_stage_journal', 'runtime_message_checkpoints', 'runtime_message_continuations', 'runtime_message_arrival_reviews'];
  const existingStageTables = stageTables.filter((table) => store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  const relatedEvidence = (context) => {
    const values = [];
    for (const table of tables) values.push(store.db.prepare(`SELECT * FROM ${table} WHERE project_id=? AND context_key=? ORDER BY rowid`)
      .all(context.projectId, context.contextKey));
    for (const table of existingStageTables) values.push(store.db.prepare(`SELECT v.* FROM ${table} v JOIN runtime_stages s
      ON s.route_id=v.route_id WHERE s.project_id=? AND s.context_key=? ORDER BY v.rowid`).all(context.projectId, context.contextKey));
    values.push(store.db.prepare('SELECT key,value FROM meta WHERE key LIKE ? ORDER BY key')
      .all(`native_qualification:${context.projectId}:${context.contextKey}%`));
    return api.payloadHash(values);
  };
  let closed = false;
  return {
    nativeBoundary,
    async validate() {
      assertClientAlive(client);
      validatePublications(store.db, api, config, candidateRoot);
      // Native replacement is a discovery-boundary change, not permission to
      // trust a new protocol or mutate any task. Restart re-establishes it.
      let current;
      try { current = hash({ path: config.nativeCommand, digest: hash(readFileSync(config.nativeCommand)), codexHome: config.codexHome }); }
      catch (error) { if (error.code === 'ENOENT') throw restartRequired('native_boundary_replacing_restart_coordinator'); throw error; }
      if (current !== nativeBoundary) throw restartRequired('native_boundary_changed_restart_coordinator');
    },
    async list(cursor, mode, limit) {
      const params = { limit, archived: false, useStateDbOnly: true, ...(cursor ? { cursor } : {}) };
      if (mode !== 'minimal') Object.assign(params, { sortKey: 'updated_at', sortDirection: 'desc',
        sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'] });
      let page;
      try { page = await request('thread/list', params); }
      catch (error) {
        // Never drop useStateDbOnly: an older host may scan/repair all rollouts.
        // A minimal fallback consumes this round's second and final RPC page.
        if (cursor || mode === 'minimal' || !/unknown field|invalid (?:params|variant)|unsupported/iu.test(error.message || '')) throw error;
        if (/useStateDbOnly/u.test(error.message || '')) throw new Error('host_state_db_only_capability_missing');
        page = await request('thread/list', { limit, archived: false, useStateDbOnly: true });
        check(Array.isArray(page.data), 'native_list_schema_changed');
        return { ...page, mode: 'minimal', degraded: true };
      }
      check(Array.isArray(page.data) && page.data.length <= limit, 'native_list_schema_changed');
      return { ...page, mode };
    },
    async inspect(thread) {
      const context = contextFor(thread), task = api.runtimeTask(store.db, context);
      if (!task) return null;
      if (task.generation === FIXED.candidate) {
        const epoch = store.db.prepare(`SELECT e.receipt_id,r.id,r.candidate,r.source,r.record FROM runtime_epoch_tasks e
          JOIN runtime_epoch_receipts r ON r.id=e.receipt_id AND r.project_id=e.project_id AND r.context_key=e.context_key
          WHERE e.project_id=? AND e.context_key=? AND e.generation=?`).get(context.projectId, context.contextKey, FIXED.candidate);
        check(epoch?.candidate === FIXED.candidate && PUBLICATIONS[epoch.source], 'C2_binding_without_epoch_receipt');
        const { id, ...body } = JSON.parse(epoch.record);
        check(id === epoch.id && api.payloadHash(body) === id, 'epoch_receipt_identity_changed');
        const admission = api.epochAdmissionState(store.db, context);
        return { generation: task.generation, receipt: { id: epoch.id, ready: admission.required && admission.ready } };
      }
      if (!PUBLICATIONS[task.generation] || task.generation === FIXED.shellDigest) return null;
      const entries = store.db.prepare(`SELECT e.invocation_id,e.record FROM runtime_epoch_native_entries e
        JOIN runtime_epoch_completed_invocations c ON c.invocation_id=e.invocation_id AND c.generation=e.generation
        WHERE e.project_id=? AND e.context_key=? AND e.subject='task' AND e.generation=? ORDER BY e.rowid DESC`)
        .all(context.projectId, context.contextKey, task.generation);
      const entry = entries.find((row) => {
        const record = JSON.parse(row.record);
        return record.schema === 'runtime-epoch-native-entry/1' && record.shellDigest === FIXED.shellDigest
          && record.shellRootDigest === api.payloadHash(config.shellRoot);
      });
      if (!entry) return { generation: task.generation, entryId: null };
      // Stat is only a trigger. Full native reading and proof interpretation
      // remain in original C2 prepare/commit and the original B retirement API.
      return { generation: task.generation, entryId: entry.invocation_id,
        evidence: { task, entryDigest: api.payloadHash(entries), related: relatedEvidence(context), rollout: fileIdentity(thread.path) } };
    },
    async readMetadata(thread) {
      assertThread(thread);
      const parent = (await request('thread/read', { threadId: thread.id, includeTurns: false })).thread;
      assertThread(parent);
      return parent;
    },
    async latestTurn(thread) {
      assertThread(thread);
      const result = await request('thread/turns/list', { threadId: thread.id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
      check(Array.isArray(result.data) && result.data.length <= 1, 'native_turn_schema_changed');
      return result.data[0] || null;
    },
    async prepare(parent, turn) {
      check(!inspectOnly, 'inspect_mode_cannot_prepare');
      return preparePublishedHandover(api, store, config, parent, turn);
    },
    commit(token, parent) {
      check(!inspectOnly, 'inspect_mode_cannot_commit');
      assertThread(parent);
      return api.commitHostEpochHandover(store, token);
    },
    close() { if (!closed) { closed = true; client.close(); store.close(); } },
  };
}
