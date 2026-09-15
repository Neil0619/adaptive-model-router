#!/usr/bin/env node
// Deployment is separate from this repository entry. No plugin/default/trust edits.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fsyncSync, lstatSync, openSync, readFileSync,
  realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const FIXED = Object.freeze({
  candidate: '4b950f2687b1a8da98ce87a66a5c813a51f7ccd76c8292f7ad38e9d7862176a9',
  sourceFingerprint: 'd8b0e9a1a56a096d3dab94d7dd0b1dad6cca3ae1bf6632e74162a282f73a254d',
  shellDigest: '8732d9524390ff549a3e9fc616dacc41ffc7341ae8d6049ace8de0d27cc05989',
  excludedTask: '01a08905-50bf-7051-9f76-29c3d7fc811a',
  excludedCwd: '/Users/niuzhenya/Documents/windows-codex',
});
export const PUBLICATIONS = Object.freeze({
  '22a9d720b0aabc5be18d12478f3b0e50c97c411ca1dfd32ca64934dbdb19ae31': '242bef83a8e037f78fe767da4b6af868c91e3a5d6e5540d5b2de8adbce4c043f',
  '9d23b8ae47f6d9bd6b388a33b75c7f94741546116efa29d3e33d9ebc72a1c9b2': '1138fe78e9ae02492b77cb8815765a07e6f9a723882341113a41e60ee9c352c5',
  'dc3797f7539e861e71bb4481604c5b309a82828e1a34c80179347ec177a6f7e1': '2df84c0ff28dd465088fbd2168f74c09ab7e7de79e0c9343d4115137a006c1ae',
  [FIXED.shellDigest]: 'd9d05b7368aa22c609354a6125ecca46954044f58890465705e61d385a138688',
});
export const hash = (value) => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value)
  ? value : JSON.stringify(value)).digest('hex');
export function check(fact, code) { if (!fact) throw new Error(code); }
const canonicalPath = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
const under = (path, root) => path === root || path.startsWith(root + '/');
export function allowedThread(thread) {
  if (!thread || typeof thread.id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(thread.id) || thread.id === FIXED.excludedTask
    || typeof thread.cwd !== 'string' || !isAbsolute(thread.cwd) || thread.archived === true
    || thread.parentThreadId || thread.ephemeral === true) return false;
  const source = thread.source;
  if (typeof source !== 'string' || !['cli', 'vscode', 'exec', 'appServer', 'unknown'].includes(source)) return false;
  if (under(resolve(thread.cwd), FIXED.excludedCwd) || under(canonicalPath(thread.cwd), FIXED.excludedCwd)) return false;
  // A metadata read may report the archived rollout after list/read raced.
  return !thread.path?.split(/[\\/]/u).includes('archived_sessions');
}
export function assertThread(thread) { check(allowedThread(thread), 'excluded_or_non_root_task'); }

// Unknown fields fail closed. Paths and timing policy, not unrelated host model
// settings, define this coordinator's recovery boundary. C2 owns Hook trust.
export function validateConfig(input) {
  const required = ['schema', 'dataHome', 'codexHome', 'shellRoot', 'statePath', 'lockPath', 'nativeCommand'];
  const defaults = { pageSize: 64, pollMs: 30_000, cooldownMs: 60_000, rescanMs: 300_000 };
  check(input && typeof input === 'object' && !Array.isArray(input), 'config_object_required');
  check(Object.keys(input).every((key) => [...required, ...Object.keys(defaults)].includes(key)), 'unknown_config_field');
  check(input.schema === 'runtime-epoch-coordinator/1', 'config_schema_mismatch');
  for (const key of required.slice(1)) check(typeof input[key] === 'string' && isAbsolute(input[key])
    && resolve(input[key]) === input[key] && !under(input[key], FIXED.excludedCwd), `invalid_config_${key}`);
  const config = Object.fromEntries([...required, ...Object.keys(defaults)].map((key) => [key, input[key] ?? defaults[key]]));
  for (const [key, min, max] of [['pageSize', 1, 64], ['pollMs', 30_000, 3_600_000],
    ['cooldownMs', 60_000, 86_400_000], ['rescanMs', 300_000, 86_400_000]]) {
    check(Number.isInteger(config[key]) && config[key] >= min && config[key] <= max, `invalid_config_${key}`);
  }
  check(basename(config.nativeCommand) === 'codex', 'native_codex_binary_required');
  check(config.statePath !== config.lockPath, 'state_and_lock_must_differ');
  for (const path of [config.statePath, config.lockPath]) {
    const destination = join(canonicalPath(dirname(path)), basename(path));
    check(!under(destination, canonicalPath(config.dataHome)) && !under(destination, canonicalPath(config.shellRoot))
      && destination !== join(canonicalPath(config.codexHome), 'config.toml'), 'private_state_must_be_outside_runtime');
  }
  return Object.freeze(config);
}
export const policyFingerprint = (config) => hash({ schema: 'coordinator-policy/1', config, fixed: FIXED, publications: PUBLICATIONS });

export function atomicState(path, state) {
  const parent = statSync(dirname(path));
  check(parent.isDirectory() && (parent.mode & 0o077) === 0 && parent.uid === process.getuid(), 'state_directory_must_be_private');
  const temporary = path + '.' + randomUUID() + '.tmp';
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { fchmodSync(fd, 0o600); writeFileSync(fd, JSON.stringify(state) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  try {
    renameSync(temporary, path);
    const directory = openSync(dirname(path), constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
export function initialState(policy, nativeBoundary) {
  return { schema: 'runtime-epoch-coordinator-state/1', policyFingerprint: policy, nativeBoundary,
    discovery: { cursor: null, nextRescanAt: 0, boundary: { updatedAt: 0, ids: [] }, mode: 'full' }, tasks: {} };
}
export function restoreState(path, policy, nativeBoundary) {
  let state;
  try {
    const info = lstatSync(path);
    check(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0
      && info.uid === process.getuid() && info.size <= 16 * 1024 * 1024, 'unsafe_state_file');
    state = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return initialState(policy, nativeBoundary);
    throw error;
  }
  // State is a disposable scheduling cache; admission/receipt recovery is DB-owned.
  if (state.schema !== 'runtime-epoch-coordinator-state/1' || state.policyFingerprint !== policy
    || state.nativeBoundary !== nativeBoundary || !state.discovery || !state.tasks) return initialState(policy, nativeBoundary);
  return state;
}

export function safeReason(error) {
  const message = String(error.message || '');
  const c2 = /^Host compatibility epoch blocked: ([a-zA-Z0-9_]+)(?::|$)/u.exec(message);
  if (c2) return `C2:${c2[1]}`;
  return /^[a-zA-Z0-9_]{1,100}$/u.test(message) ? message
    : `evidence_unavailable:${/^[A-Z0-9_]{1,30}$/u.test(error.code || '') ? error.code : 'unverified'}`;
}

export function temporaryEvidenceFailure(error, phase) {
  if (['COORDINATOR_EVIDENCE_UNAVAILABLE', 'COORDINATOR_RESTART', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'EBUSY'].includes(error.code)) return true;
  const message = error.message || '';
  // C2's historical reader uses its own native clients. Preserve their exact
  // transport failures without treating a C2 responsibility/budget refusal as
  // permission to retry unchanged business evidence.
  if (/^(?:(?:initialize|thread\/(?:read|turns\/list)|hooks\/list) exceeded the classifier deadline|classifier deadline exceeded|app-server is not running|codex app-server (?:exited with code .+|failed: .+))$/u.test(message)) return true;
  return phase === 'native_metadata' && /deadline|timeout|timed out|exited|not running|temporar|ECONN|EPIPE/iu.test(message);
}

// Injected adapters are used only by deterministic tests. The CLI always creates
// the fixed published C2 adapter; it has no adapter/module-path flag.
export class EpochCoordinator {
  constructor({ config, adapter, state = initialState(policyFingerprint(config), adapter.nativeBoundary),
    save = () => {}, log = () => {}, clock = Date.now, inspectOnly = false }) {
    Object.assign(this, { config, adapter, state, save, log, clock, inspectOnly });
    this.stopping = false;
  }
  stop() { this.stopping = true; }
  persist() { this.save(this.state); }
  update(id, patch) {
    const previous = this.state.tasks[id] || {};
    const next = { ...previous, ...patch };
    this.state.tasks[id] = next;
    if (previous.state !== next.state || previous.reason !== next.reason || previous.receiptId !== next.receiptId) {
      this.log({ taskDigest: hash(id), state: next.state, reason: next.reason || null, receiptId: next.receiptId || null });
    }
  }
  async discover() {
    const progress = this.state.discovery, now = this.clock(), seen = new Map();
    const previousBoundary = progress.boundary.updatedAt;
    const recent = await this.adapter.list(null, progress.mode, this.config.pageSize);
    if (recent.mode) progress.mode = recent.mode;
    const add = (page) => {
      for (const item of page.data) {
        if (!allowedThread(item)) continue;
        seen.set(item.id, item);
        // Store same-second IDs; never use updatedAt > boundary as a filter.
        const updatedAt = Number(item.updatedAt) || 0, boundary = progress.boundary;
        if (updatedAt > boundary.updatedAt) { boundary.updatedAt = updatedAt; boundary.ids = [item.id]; }
        else if (updatedAt === boundary.updatedAt && !boundary.ids.includes(item.id)) boundary.ids.push(item.id);
      }
    };
    add(recent);
    let cursor = progress.cursor;
    if (!cursor) {
      const fullScan = now >= progress.nextRescanAt;
      // Continue incremental discovery when a busy head page has not crossed
      // the previous second (including overlap). The periodic full pass also
      // checks DB-only entry changes on less recently updated native roots.
      const overlaps = progress.mode !== 'minimal' && recent.data.length > 0
        && Math.min(...recent.data.map((item) => Number(item.updatedAt) || 0)) >= previousBoundary - 1;
      if (fullScan || overlaps) {
        cursor = recent.nextCursor || null;
        progress.scanFloor = fullScan ? null : previousBoundary - 1;
      }
    }
    if (cursor && !this.stopping && !recent.degraded) {
      try {
        const older = await this.adapter.list(cursor, progress.mode, this.config.pageSize);
        if (older.mode) progress.mode = older.mode;
        add(older);
        // A looping server cursor must not spin; retry a bounded scan later.
        const crossed = typeof progress.scanFloor === 'number'
          && older.data.some((item) => Number(item.updatedAt) < progress.scanFloor);
        progress.cursor = !crossed && older.nextCursor && older.nextCursor !== cursor ? older.nextCursor : null;
      } catch (error) {
        if (!/cursor/iu.test(error.message || '')) throw error;
        progress.cursor = null; progress.nextRescanAt = now + this.config.pollMs;
        this.log({ state: 'discovery_cursor_reset' });
      }
    } else if (!cursor) progress.cursor = null;
    // Full passes wrap at low frequency. Recent pages still run every 30s;
    // persisted backfill ensures candidates beyond the head are not starved.
    if (!progress.cursor && progress.nextRescanAt <= now) progress.nextRescanAt = now + this.config.rescanMs;
    // This cache can be discarded without losing an epoch receipt. Bound it
    // independently of the lifetime size of the host task inventory.
    const entries = Object.entries(this.state.tasks);
    if (entries.length > 4096) for (const [id] of entries.sort((a, b) => (a[1].lastSeenAt || 0) - (b[1].lastSeenAt || 0))
      .slice(0, entries.length - 4096)) delete this.state.tasks[id];
    this.persist();
    return [...seen.values()];
  }
  async tick() {
    if (this.stopping) return { attempts: 0 };
    await this.adapter.validate();
    const listed = await this.discover(), candidates = [], now = this.clock();
    for (const item of listed) {
      if (this.stopping || !allowedThread(item)) continue;
      try {
        const info = await this.adapter.inspect(item); // DB and stat only; no transcript reads.
        if (!info) continue;
        if (info.receipt) {
          this.update(item.id, { state: info.receipt.ready ? 'active' : 'adopted_awaiting_native_acceptance',
            receiptId: info.receipt.id, generation: FIXED.candidate, reason: info.receipt.ready ? null : 'HOST_EPOCH_ENTRY_UNCONFIRMED' });
          continue;
        }
        if (!PUBLICATIONS[info.generation] || [FIXED.shellDigest, FIXED.candidate].includes(info.generation)) continue;
        const previous = this.state.tasks[item.id] || {};
        const fingerprint = hash({ policy: this.state.policyFingerprint, native: this.state.nativeBoundary,
          updatedAt: item.updatedAt, path: item.path, source: info.evidence, entryId: info.entryId });
        this.update(item.id, { generation: info.generation, entryId: info.entryId || null,
          triggerFingerprint: fingerprint, nativeUpdatedAt: item.updatedAt, lastSeenAt: now });
        if (!info.entryId) { this.update(item.id, { state: 'waiting_native_entry', reason: 'completed_B_root_entry_missing' }); continue; }
        const sameEvidence = previous.attemptFingerprint === fingerprint;
        if (sameEvidence && previous.retryKind !== 'transient' && previous.state !== 'verifying') continue;
        const earliest = sameEvidence ? previous.nextAttemptAt || 0
          : previous.lastAttemptAt == null ? 0 : previous.lastAttemptAt + this.config.cooldownMs;
        if (now < earliest) continue;
        if (this.inspectOnly) {
          this.update(item.id, { state: 'metadata_candidate_unverified', reason: 'C2_admission_not_run' });
        } else candidates.push({ item, info, fingerprint, previous });
      } catch (error) { this.update(item.id, { state: 'metadata_unavailable', reason: safeReason(error) }); }
    }
    this.persist();
    // One expensive serial candidate per pass. Persist the attempt before any
    // C2 work so a process crash cannot create an uncontrolled retry loop.
    const selected = candidates.sort((a, b) => (a.previous.lastAttemptAt || 0) - (b.previous.lastAttemptAt || 0))[0];
    if (!selected || this.stopping) return { discovered: listed.length, attempts: 0 };
    const { item, fingerprint, previous } = selected;
    const failures = previous.attemptFingerprint === fingerprint ? Math.min(10, previous.failures || 0) : 0;
    this.update(item.id, { state: 'verifying', attemptFingerprint: fingerprint, lastAttemptAt: now,
      // A crash or graceful stop has not established a responsibility refusal.
      // Recovery first checks the DB receipt, then prepares a fresh token after
      // this cooldown. No persisted token or previous success is trusted.
      retryKind: 'transient',
      nextAttemptAt: now + Math.max(this.config.cooldownMs, Math.min(1_800_000, 60_000 * 2 ** failures)) });
    this.persist();
    let receipt, phase = 'native_metadata';
    try {
      assertThread(item);
      const parent = await this.adapter.readMetadata(item);
      assertThread(parent);
      check(parent.id === item.id && canonicalPath(parent.cwd) === canonicalPath(item.cwd), 'native_task_identity_changed');
      const turn = await this.adapter.latestTurn(parent);
      check(turn && typeof turn.id === 'string', 'latest_native_turn_missing');
      // notLoaded / interrupted / completed are hints, never idle proofs.
      if (this.stopping) return { discovered: listed.length, attempts: 1 };
      phase = 'C2_prepare';
      const token = await this.adapter.prepare(parent, turn);
      if (this.stopping) return { discovered: listed.length, attempts: 1 };
      assertThread(parent);
      phase = 'C2_commit';
      receipt = await this.adapter.commit(token, parent);
      this.update(item.id, { state: 'adopted_awaiting_native_acceptance', generation: FIXED.candidate,
        receiptId: receipt.id, reason: 'HOST_EPOCH_ENTRY_UNCONFIRMED', failures: 0 });
    } catch (error) {
      if (receipt) throw error;
      const transient = temporaryEvidenceFailure(error, phase);
      this.update(item.id, { state: 'waiting_source_verification', reason: safeReason(error), failures: failures + 1,
        retryKind: transient || error.code === 'COORDINATOR_RESTART' ? 'transient' : 'evidence' });
      if (error.code === 'COORDINATOR_RESTART') { this.persist(); throw error; }
    }
    // Reporting/persistence failure after commit must escape. Next process
    // reconciles C2's actual epoch receipt instead of repeating the handover.
    this.persist();
    return { discovered: listed.length, attempts: 1 };
  }
}

function assertInheritedLock(config) {
  const fd = Number(process.env.RUNTIME_EPOCH_COORDINATOR_LOCK_FD);
  check(Number.isInteger(fd) && fd >= 3, 'run_through_runtime_epoch_coordinator_lock_py');
  const helper = join(dirname(fileURLToPath(import.meta.url)), 'runtime-epoch-coordinator-lock.py');
  const result = spawnSync('/usr/bin/python3', [helper, '--verify-fd', '3', config.lockPath],
    { stdio: ['ignore', 'ignore', 'ignore', fd] });
  check(result.status === 0, 'inherited_OS_lock_missing');
}

// Exit 75 hands off only this service to its supervisor. The next process
// verifies the replaced host and resets the discovery cache's native boundary.
// Protocol/proof failures stay closed; request timeouts retain normal backoff.
export async function runCoordinatorLoop({ coordinator, adapter, inspectOnly, pause, report }) {
  try {
    do {
      try {
        const summary = await coordinator.tick();
        if (inspectOnly) report({ state: 'inspection_complete', ...summary,
          prepares: 0, commits: 0, installationComplete: false });
      } catch (error) {
        report({ state: error.code === 'COORDINATOR_RESTART' ? 'coordinator_restart_required' : 'coordinator_blocked',
          reason: safeReason(error) });
        if (error.code === 'COORDINATOR_RESTART') return 75;
        if (inspectOnly) throw error;
      }
      if (inspectOnly || coordinator.stopping) break;
      await pause(coordinator.config.pollMs);
    } while (!coordinator.stopping);
    return 0;
  } finally { adapter.close(); }
}

export async function main(argv = process.argv.slice(2)) {
  check(argv.length === 2 || argv.length === 3 && argv[2] === '--inspect-once', 'usage_config_path_inspect_once');
  check(argv[0] === '--config', 'usage_config_path_inspect_once');
  const config = validateConfig(JSON.parse(readFileSync(argv[1], 'utf8')));
  assertInheritedLock(config);
  const { createPublishedAdapter } = await import('./runtime-epoch-coordinator-c2.mjs');
  const inspectOnly = argv.includes('--inspect-once');
  const adapter = await createPublishedAdapter(config, { inspectOnly });
  let state;
  try { state = restoreState(config.statePath, policyFingerprint(config), adapter.nativeBoundary); }
  catch (error) { adapter.close(); throw error; }
  const coordinator = new EpochCoordinator({ config, adapter, inspectOnly,
    state,
    save: (state) => atomicState(config.statePath, state), log: (record) => console.log(JSON.stringify(record)) });
  let timer, wake;
  const stop = () => { coordinator.stop(); clearTimeout(timer); wake?.(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    process.exitCode = await runCoordinatorLoop({ coordinator, adapter, inspectOnly,
      report: (record) => console.log(JSON.stringify(record)),
      pause: (ms) => new Promise((done) => { wake = done; timer = setTimeout(done, ms); }) });
  } finally {
    clearTimeout(timer); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(JSON.stringify({ state: 'coordinator_failed', reason: safeReason(error) })); process.exitCode = 1; });
}
