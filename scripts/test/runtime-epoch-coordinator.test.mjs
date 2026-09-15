import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, realpathSync,
  rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { EpochCoordinator, FIXED, PUBLICATIONS, allowedThread, assertThread, atomicState,
  initialState, policyFingerprint, restoreState, runCoordinatorLoop, validateConfig } from '../runtime-epoch-coordinator.mjs';
import { assertClientAlive, packageDigest, restartRequired, validatePublications,
  preparePublishedHandover } from '../runtime-epoch-coordinator-c2.mjs';
import { payloadHash } from '../../plugins/adaptive-model-router/scripts/lib/io.mjs';
import { inspectLifecycleHookReadiness } from '../../plugins/adaptive-model-router/scripts/lib/hook-readiness.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const helper = join(root, 'runtime-epoch-coordinator-lock.py');
const OLD = Object.keys(PUBLICATIONS)[0];
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const thread = (n, extra = {}) => ({ id: id(n), cwd: '/tmp/coordinator-fixture-project', path: `/tmp/rollout-${n}.jsonl`,
  source: 'vscode', updatedAt: 100, parentThreadId: null, status: { type: 'notLoaded' }, ...extra });
const config = (extra = {}) => validateConfig({ schema: 'runtime-epoch-coordinator/1', dataHome: '/tmp/coordinator-fixture-router',
  codexHome: '/tmp/coordinator-fixture-codex', shellRoot: '/tmp/coordinator-fixture-shell',
  statePath: '/tmp/coordinator-fixture-private/state.json', lockPath: '/tmp/coordinator-fixture-private/instance.lock',
  nativeCommand: '/Applications/Codex.app/Contents/Resources/codex', ...extra });

function fixture({ rows = [thread(1)], entry = true, fail = null, inspectOnly = false, save = () => {} } = {}) {
  let now = 1_000_000;
  const calls = { list: [], inspect: [], read: [], turns: [], prepare: [], commit: [] };
  const receipts = new Map(), evidence = new Map(), generations = new Map();
  const adapter = {
    nativeBoundary: 'test-native-boundary',
    async validate() {},
    async list(cursor, mode, limit) {
      calls.list.push({ cursor, mode, limit });
      const start = Number(cursor || 0);
      return { data: rows.slice(start, start + limit), nextCursor: start + limit < rows.length ? String(start + limit) : null };
    },
    async inspect(item) {
      calls.inspect.push(item.id);
      return receipts.has(item.id) ? { receipt: receipts.get(item.id), generation: FIXED.candidate }
        : { generation: generations.get(item.id) || OLD, entryId: entry ? 'entry-' + item.id : null,
          evidence: evidence.get(item.id) || 'original-source' };
    },
    async readMetadata(item) { calls.read.push(item.id); return { ...item }; },
    async latestTurn(item) { calls.turns.push(item.id); return { id: 'latest-turn', status: 'interrupted', items: [] }; },
    async prepare(item) { calls.prepare.push(item.id); if (fail) throw fail; return Object.freeze({}); },
    async commit(token, item) { calls.commit.push(item.id); const receipt = { id: 'receipt-' + item.id, ready: false };
      receipts.set(item.id, receipt); return receipt; },
  };
  const instance = new EpochCoordinator({ config: config(), adapter, inspectOnly, clock: () => now, save });
  return { instance, adapter, calls, receipts, evidence, generations, rows,
    advance: (ms = 30_000) => { now += ms; }, clock: () => now };
}

test('fixed policy rejects broad config or runtime-state destinations', () => {
  assert.equal(config().pollMs, 30_000);
  assert.throws(() => config({ candidate: 'other' }), /unknown_config_field/);
  assert.throws(() => config({ configDigest: 'whole-host-config' }), /unknown_config_field/);
  assert.throws(() => config({ pollMs: 1 }), /invalid_config_pollMs/);
  assert.throws(() => config({ statePath: '/tmp/coordinator-fixture-router/state.json' }), /outside_runtime/);
  assert.equal(policyFingerprint(config()), policyFingerprint(config()));
});

test('hard exclusions, archived records and non-root sources never reach directed inspection', async () => {
  const rows = [thread(1, { id: FIXED.excludedTask }), thread(2, { cwd: FIXED.excludedCwd }),
    thread(3, { cwd: FIXED.excludedCwd + '/nested' }), thread(4, { archived: true }),
    thread(5, { source: { subAgent: {} } }), thread(6, { parentThreadId: id(1) }),
    thread(7, { path: '/tmp/archived_sessions/rollout.jsonl' }), thread(8, { ephemeral: true })];
  const f = fixture({ rows });
  await f.instance.tick();
  for (const key of ['inspect', 'read', 'turns', 'prepare', 'commit']) assert.deepEqual(f.calls[key], [], key);
  assert.throws(() => assertThread(rows[0]), /excluded/);
});

test('canonical excluded directory aliases are rejected before directed reads', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'epoch-exclusion-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // The permanent target need not exist for the direct lexical exclusion.
  assert.equal(allowedThread(thread(1, { cwd: FIXED.excludedCwd + '/../windows-codex/a' })), false);
  assert.equal(allowedThread(thread(1, { source: 'subAgentReview' })), false);
});

test('417 old bindings without a completed B root entry require no metadata/history preparation', async () => {
  const f = fixture({ rows: Array.from({ length: 417 }, (_, n) => thread(n + 1)), entry: false });
  for (let pass = 0; pass < 7; pass++) {
    const before = f.calls.list.length;
    await f.instance.tick(); f.advance();
    assert.ok(f.calls.list.length - before <= 2);
  }
  assert.equal(new Set(f.calls.inspect).size, 417);
  assert.equal(Object.keys(f.instance.state.tasks).length, 417);
  assert.equal(f.instance.state.tasks[id(417)].state, 'waiting_native_entry');
  for (const key of ['read', 'turns', 'prepare', 'commit']) assert.deepEqual(f.calls[key], [], key);
});

test('new B bindings and unapproved source generations are never candidates', async () => {
  const f = fixture({ rows: [thread(1), thread(2), thread(3)] });
  f.generations.set(id(1), FIXED.shellDigest); f.generations.set(id(2), FIXED.candidate); f.generations.set(id(3), 'unpublished');
  await f.instance.tick();
  assert.deepEqual(f.calls.read, []); assert.deepEqual(f.calls.prepare, []);
});

test('inspect-once is metadata-only even when an old source has a real entry', async () => {
  const f = fixture({ inspectOnly: true });
  assert.equal((await f.instance.tick()).attempts, 0);
  assert.equal(f.instance.state.tasks[id(1)].state, 'metadata_candidate_unverified');
  for (const key of ['read', 'turns', 'prepare', 'commit']) assert.deepEqual(f.calls[key], [], key);
});

test('notLoaded and interrupted cannot override C2 active-root rejection', async () => {
  const f = fixture({ fail: new Error('Host compatibility epoch blocked: root_turn_still_active') });
  await f.instance.tick();
  assert.equal(f.calls.prepare.length, 1);
  assert.equal(f.calls.commit.length, 0);
  assert.equal(f.instance.state.tasks[id(1)].reason, 'C2:root_turn_still_active');
  f.advance(3_600_000); await f.instance.tick();
  assert.equal(f.calls.prepare.length, 1, 'unchanged C2 evidence is not parsed again after a timer');
});

test('unknown execution or ownership stays with C2 and no business settlement is invented', async () => {
  for (const reason of ['in_flight_or_unknown_Hook_MCP_call', 'unknown_message_delivery', 'unknown_child_ownership']) {
    const f = fixture({ fail: new Error('Host compatibility epoch blocked: ' + reason) });
    await f.instance.tick();
    assert.equal(f.calls.commit.length, 0);
    assert.equal(f.instance.state.tasks[id(1)].reason, 'C2:' + reason);
  }
});

test('preserved business responsibility is not a coordinator veto; only C2 decides', async () => {
  const f = fixture();
  f.evidence.set(id(1), { responsibility: 'unverified_preserved' });
  await f.instance.tick();
  assert.equal(f.calls.commit.length, 1);
  assert.equal(f.instance.state.tasks[id(1)].state, 'adopted_awaiting_native_acceptance');
});

test('new source evidence observes minimum cooldown and resets an older exponential backoff', async () => {
  const f = fixture({ fail: new Error('Host compatibility epoch blocked: root_turn_still_active') });
  await f.instance.tick();
  f.instance.state.tasks[id(1)].nextAttemptAt = f.clock() + 1_800_000;
  f.evidence.set(id(1), 'new-completed-entry');
  f.advance(30_000); await f.instance.tick(); assert.equal(f.calls.prepare.length, 1);
  f.advance(30_000); await f.instance.tick(); assert.equal(f.calls.prepare.length, 2);
  assert.equal(f.instance.state.tasks[id(1)].failures, 1, 'new source resets the older failure count');
});

test('transient native RPC failures retry unchanged evidence after bounded backoff', async () => {
  const f = fixture();
  f.adapter.readMetadata = async (item) => { f.calls.read.push(item.id); throw new Error('thread/read exceeded the classifier deadline'); };
  await f.instance.tick();
  assert.equal(f.instance.state.tasks[id(1)].retryKind, 'transient');
  f.advance(30_000); await f.instance.tick(); assert.equal(f.calls.read.length, 1);
  f.advance(30_000); await f.instance.tick(); assert.equal(f.calls.read.length, 2);
  f.advance(60_000); await f.instance.tick(); assert.equal(f.calls.read.length, 2);
  f.advance(60_000); await f.instance.tick(); assert.equal(f.calls.read.length, 3);
  assert.equal(f.calls.prepare.length, 0);
});

test('only one candidate enters serial C2 work in each round', async () => {
  const f = fixture({ rows: [thread(1), thread(2), thread(3)] });
  await f.instance.tick(); assert.equal(f.calls.prepare.length, 1);
  f.advance(); await f.instance.tick(); assert.equal(f.calls.prepare.length, 2);
  f.advance(); await f.instance.tick(); assert.equal(f.calls.prepare.length, 3);
});

test('same-second overlap and cursor continuation survive state restoration', async () => {
  const f = fixture({ rows: Array.from({ length: 140 }, (_, n) => thread(n + 1)), entry: false });
  await f.instance.tick();
  assert.equal(f.instance.state.discovery.cursor, '128');
  const restored = JSON.parse(JSON.stringify(f.instance.state));
  f.rows.push(thread(141)); // Same timestamp after the persisted scan frontier.
  f.advance();
  const second = new EpochCoordinator({ config: config(), adapter: f.adapter, state: restored, clock: f.clock });
  await second.tick();
  assert.equal(second.state.discovery.boundary.ids.length, 141);
  assert.ok(second.state.tasks[id(141)]);
  assert.equal(f.calls.list.at(-1).cursor, '128');
});

test('invalid continuation cursor resets without a third RPC or lost same-second discovery', async () => {
  const f = fixture({ rows: Array.from({ length: 130 }, (_, n) => thread(n + 1)), entry: false });
  f.instance.state.discovery.cursor = 'expired';
  const base = f.adapter.list;
  f.adapter.list = async (cursor, ...rest) => {
    if (cursor === 'expired') { f.calls.list.push({ cursor }); throw new Error('invalid cursor'); }
    return base(cursor, ...rest);
  };
  await f.instance.tick();
  assert.equal(f.calls.list.length, 2); assert.equal(f.instance.state.discovery.cursor, null);
  f.advance(); await f.instance.tick();
  assert.equal(f.calls.list.at(-1).cursor, '64');
  assert.ok(f.instance.state.tasks[id(128)]);
});

test('minimal native fallback uses its two-page budget without continuing a backfill', async () => {
  const f = fixture({ entry: false });
  f.instance.state.discovery.cursor = '64';
  f.adapter.list = async () => { f.calls.list.push({}); return { data: f.rows, mode: 'minimal', degraded: true }; };
  await f.instance.tick();
  assert.equal(f.calls.list.length, 1, 'adapter already spent the second RPC on fallback');
  assert.equal(f.instance.state.discovery.mode, 'minimal');
});

test('archived task removed from native list is not awakened from cached scheduling state', async () => {
  const f = fixture({ fail: new Error('Host compatibility epoch blocked: root_turn_still_active') });
  await f.instance.tick();
  f.rows.length = 0; f.advance(60_000); f.evidence.set(id(1), 'changed');
  await f.instance.tick();
  assert.equal(f.calls.read.length, 1); assert.equal(f.calls.prepare.length, 1);
});

test('exclusion is rechecked after metadata and immediately before commit', async () => {
  const f = fixture();
  f.adapter.readMetadata = async (item) => ({ ...item, cwd: FIXED.excludedCwd });
  await f.instance.tick(); assert.equal(f.calls.prepare.length, 0);
  const second = fixture();
  second.adapter.prepare = async (item) => { item.cwd = FIXED.excludedCwd; return {}; };
  await second.instance.tick(); assert.equal(second.calls.commit.length, 0);
});

test('state write lost after commit recovers actual receipt and waits for genuine C2 entry', async () => {
  const f = fixture({ save: (state) => {
    if (state.tasks[id(1)]?.receiptId) throw new Error('simulated state disk failure after commit');
  } });
  await assert.rejects(f.instance.tick(), /disk failure/);
  assert.equal(f.calls.commit.length, 1);
  const restarted = new EpochCoordinator({ config: config(), adapter: f.adapter, clock: f.clock });
  await restarted.tick();
  assert.equal(restarted.state.tasks[id(1)].state, 'adopted_awaiting_native_acceptance');
  assert.equal(f.calls.commit.length, 1); assert.equal(f.calls.prepare.length, 1);
  f.receipts.get(id(1)).ready = true;
  await restarted.tick();
  assert.equal(restarted.state.tasks[id(1)].state, 'active');
});

test('graceful stop between prepare and commit leaves token ephemeral and never commits', async () => {
  const f = fixture();
  f.adapter.prepare = async () => { f.instance.stop(); return Object.freeze({}); };
  await f.instance.tick();
  assert.equal(f.calls.commit.length, 0);
  assert.equal(JSON.stringify(f.instance.state).includes('token'), false);
});

test('interrupted preparation recovers with fresh proof after cooldown, including older verifying snapshots', async () => {
  for (const stopAt of ['metadata', 'prepare', 'older_snapshot']) {
    const f = fixture();
    if (stopAt === 'metadata') f.adapter.latestTurn = async () => { f.instance.stop(); return { id: 'turn' }; };
    else f.adapter.prepare = async (item) => { f.calls.prepare.push(item.id); f.instance.stop(); return Object.freeze({}); };
    await f.instance.tick();
    const saved = JSON.parse(JSON.stringify(f.instance.state));
    assert.equal(saved.tasks[id(1)].state, 'verifying');
    assert.equal(f.calls.commit.length, 0);
    if (stopAt === 'older_snapshot') saved.tasks[id(1)].retryKind = 'evidence';
    const before = f.calls.prepare.length;
    f.adapter.latestTurn = async () => ({ id: 'turn' });
    f.adapter.prepare = async (item) => { f.calls.prepare.push(item.id); return Object.freeze({}); };
    const restored = new EpochCoordinator({ config: config(), adapter: f.adapter, state: saved, clock: f.clock });
    await restored.tick();
    assert.equal(f.calls.prepare.length, before, 'restarting cannot skip the minimum cooldown');
    f.advance(3_600_000);
    await restored.tick();
    assert.equal(f.calls.prepare.length, before + 1, 'the interrupted attempt must obtain a new preparation');
    assert.equal(f.calls.commit.length, 1);
    assert.equal(restored.state.tasks[id(1)].state, 'adopted_awaiting_native_acceptance');
    assert.equal(JSON.stringify(saved).includes('token'), false);
  }
});

function preparationApi({ failAt = 0, unavailableReason = null } = {}) {
  let inspections = 0;
  const api = {
    runtimeTask: () => ({ generation: OLD }),
    sourceTaskQualification: () => ({ qualification: { state: 'passed', routeId: 'original-route' }, sourceGeneration: OLD }),
    async inspectLifecycleHookReadiness(options) {
      inspections++;
      if (unavailableReason) return { ready: false, reasonCode: unavailableReason };
      if (inspections === failAt) {
        // Exercise the original verifier's actual exception projection, not an
        // invented transport-shaped return value in the coordinator fixture.
        return inspectLifecycleHookReadiness({ ...options, appServer: async () => {
          throw new Error('hooks/list exceeded the classifier deadline');
        } });
      }
      return { ready: false, binding: { digest: 'original-binding' } };
    },
    async prepareHistoricalQualificationAdoption(_input, options) {
      await options.inspectBinding();
      await options.inspectBinding(); // Original C2 rechecks before and after native history.
      return Object.freeze({});
    },
    async prepareHostEpochHandover(_store, reference, options) {
      await options.inspect({ contextId: reference.contextId });
      return Object.freeze({});
    },
  };
  return { api, store: { db: {}, context: () => ({ projectId: 'project', contextKey: 'context' }) }, inspections: () => inspections };
}

test('actual C2 unavailable Hook projection retries at initial, historical and final preparation checks', async () => {
  for (const failAt of [1, 2, 3, 4]) {
    const f = fixture(), prepared = preparationApi({ failAt });
    f.adapter.prepare = async (parent, turn) => {
      f.calls.prepare.push(parent.id);
      return preparePublishedHandover(prepared.api, prepared.store, config(), parent, turn);
    };
    await f.instance.tick();
    assert.equal(f.instance.state.tasks[id(1)].retryKind, 'transient');
    assert.equal(f.instance.state.tasks[id(1)].reason, 'HOST_HOOK_STATUS_UNAVAILABLE');
    assert.equal(f.calls.commit.length, 0, 'no unavailable verifier may produce a committed handover');
    await f.instance.tick();
    assert.equal(f.calls.prepare.length, 1);
    f.advance(60_000);
    await f.instance.tick();
    assert.equal(f.calls.prepare.length, 2);
    assert.equal(f.calls.commit.length, 1, 'recovered evidence still traverses the full C2 preparation');
  }
});

test('real Hook trust, identity and inventory refusals keep their reason and wait for changed evidence', async () => {
  for (const unavailableReason of ['HOOK_TRUST_REQUIRED', 'HOST_HOOK_SET_MISMATCH', 'HOST_HOOK_DISPATCH_NOT_OBSERVED']) {
    const f = fixture(), prepared = preparationApi({ unavailableReason });
    f.adapter.prepare = (parent, turn) => preparePublishedHandover(prepared.api, prepared.store, config(), parent, turn);
    await f.instance.tick();
    assert.equal(f.instance.state.tasks[id(1)].retryKind, 'evidence');
    assert.equal(f.instance.state.tasks[id(1)].reason, unavailableReason);
    f.advance(3_600_000);
    await f.instance.tick();
    assert.equal(prepared.inspections(), 1);
    assert.equal(f.calls.commit.length, 0);
  }
});

test('historical C2 native read timeout retries but C2 responsibility refusal does not', async () => {
  for (const [message, expected] of [['thread/read exceeded the classifier deadline', 2],
    ['Host compatibility epoch blocked: child_native_work_pending', 1]]) {
    const f = fixture({ fail: new Error(message) });
    await f.instance.tick(); f.advance(60_000); await f.instance.tick();
    assert.equal(f.calls.prepare.length, expected);
    assert.equal(f.calls.commit.length, 0);
  }
});

test('private atomic state survives replacement; policy/native changes drop scheduling cache', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'epoch-state-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  chmodSync(directory, 0o700);
  const path = join(directory, 'state.json'), state = initialState('policy', 'native');
  atomicState(path, state); assert.equal(lstatSync(path).mode & 0o777, 0o600);
  state.tasks[id(1)] = { state: 'waiting_native_entry' }; atomicState(path, state);
  assert.deepEqual(restoreState(path, 'policy', 'native'), state);
  assert.deepEqual(restoreState(path, 'changed-policy', 'native').tasks, {});
  assert.deepEqual(restoreState(path, 'policy', 'changed-native').tasks, {});
  writeFileSync(path, '{bad'); assert.deepEqual(restoreState(path, 'policy', 'native').tasks, {});
  chmodSync(path, 0o644); assert.throws(() => restoreState(path, 'policy', 'native'), /unsafe_state/);
});

test('package pre-import hashing rejects redirected files and detects changed bytes', (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'epoch-package-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'source.mjs'), 'export const x=1;');
  const before = packageDigest(directory);
  writeFileSync(join(directory, 'source.mjs'), 'export const x=2;');
  assert.notEqual(packageDigest(directory), before);
  symlinkSync(join(directory, 'source.mjs'), join(directory, 'alias'));
  assert.throws(() => packageDigest(directory), /non_regular/);
});

test('the production adapter calls only fixed C2 preparation/commit and metadata native APIs', () => {
  const code = readFileSync(join(root, 'runtime-epoch-coordinator-c2.mjs'), 'utf8');
  assert.match(code, /includeTurns: false/); assert.match(code, /itemsView: 'notLoaded'/);
  assert.match(code, /useStateDbOnly: true/);
  assert.doesNotMatch(code, /readStableRollout|writeFileSync|INSERT |UPDATE |DELETE |CREATE TABLE/);
  for (const name of ['sourceTaskQualification', 'inspectLifecycleHookReadiness', 'prepareHistoricalQualificationAdoption',
    'prepareHostEpochHandover', 'commitHostEpochHandover', 'epochAdmissionState']) assert.ok(code.includes('api.' + name));
  assert.doesNotMatch(code, /observeEpochExecution\(/);
});

test('OS lock survives exec into Node, rejects duplicates/forged descriptors and releases on exit', { timeout: 15_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'epoch-flock-'));
  chmodSync(directory, 0o700);
  const path = join(directory, 'instance.lock');
  const program = `process.stdout.write('ready\\n'); setInterval(()=>{},1000);`;
  const holder = spawn('/usr/bin/python3', [helper, path, '--', process.execPath, '-e', program], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (holder.exitCode === null) holder.kill('SIGTERM'); rmSync(directory, { recursive: true, force: true }); });
  await Promise.race([once(holder.stdout, 'data'), once(holder, 'exit').then(() => { throw Error('lock holder exited early'); })]);
  const duplicate = spawnSync('/usr/bin/python3', [helper, path, '--', process.execPath, '-e', 'process.exit(99)']);
  assert.equal(duplicate.status, 73);
  assert.equal(lstatSync(path).mode & 0o777, 0o600);
  const forged = openSync(path, 'r+');
  try {
    const check = spawnSync('/usr/bin/python3', [helper, '--verify-fd', '3', path], { stdio: ['ignore', 'ignore', 'ignore', forged] });
    assert.equal(check.status, 1, 'same inode locked by another process is not our owned inherited descriptor');
  } finally { closeSync(forged); }
  holder.kill('SIGTERM'); await once(holder, 'exit');
  assert.equal(spawnSync('/usr/bin/python3', [helper, '--probe', path]).status, 0);
  const verifyProgram = `const {spawnSync}=require('node:child_process');
    const fd=Number(process.env.RUNTIME_EPOCH_COORDINATOR_LOCK_FD);
    const out=spawnSync('/usr/bin/python3',[${JSON.stringify(helper)},'--verify-fd','3',${JSON.stringify(path)}],{stdio:['ignore','ignore','ignore',fd]});
    process.exit(out.status);`;
  assert.equal(spawnSync('/usr/bin/python3', [helper, path, '--', process.execPath, '-e', verifyProgram]).status, 0);
  assert.equal(spawnSync('/usr/bin/python3', [helper, '--probe', path]).status, 0);
});

test('CLI refuses an unlocked launch before imports or DB access', () => {
  const directory = mkdtempSync(join(tmpdir(), 'epoch-cli-'));
  try {
    const file = join(directory, 'config.json'); writeFileSync(file, JSON.stringify(config()));
    const env = { ...process.env }; delete env.RUNTIME_EPOCH_COORDINATOR_LOCK_FD;
    const result = spawnSync(process.execPath, [join(root, 'runtime-epoch-coordinator.mjs'), '--config', file, '--inspect-once'],
      { env, encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, /run_through_runtime_epoch_coordinator_lock_py/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('real service loop closes only its client and exits 75 for host replacement; restart discovers with a new boundary', async () => {
  const f = fixture({ entry: false });
  let closed = 0, paused = 0;
  f.adapter.close = () => { closed++; };
  f.adapter.validate = async () => { throw restartRequired('native_boundary_changed_restart_coordinator'); };
  const code = await runCoordinatorLoop({ coordinator: f.instance, adapter: f.adapter, inspectOnly: false,
    pause: async () => { paused++; }, report: () => {} });
  assert.equal(code, 75); assert.equal(closed, 1); assert.equal(paused, 0); assert.equal(f.calls.list.length, 0);
  const next = fixture({ entry: false }); next.adapter.nativeBoundary = 'new-native-boundary';
  next.adapter.close = () => {};
  next.instance = new EpochCoordinator({ config: config(), adapter: next.adapter, clock: next.clock });
  await runCoordinatorLoop({ coordinator: next.instance, adapter: next.adapter, inspectOnly: true,
    pause: async () => assert.fail('inspect cannot sleep'), report: () => {} });
  assert.equal(next.instance.state.nativeBoundary, 'new-native-boundary');
  assert.equal(next.calls.list.length, 1); assert.equal(next.calls.prepare.length, 0);
});

test('dead native client restarts from the actual loop, while a live-client timeout keeps its retry state', async () => {
  assert.throws(() => assertClientAlive({ closedError: new Error('native exited') }), { code: 'COORDINATOR_RESTART' });
  assert.doesNotThrow(() => assertClientAlive({ closedError: null }));
  const f = fixture(); let closed = 0;
  f.adapter.close = () => { closed++; };
  f.adapter.readMetadata = async () => { throw restartRequired('native_client_exited_restart_coordinator'); };
  assert.equal(await runCoordinatorLoop({ coordinator: f.instance, adapter: f.adapter, inspectOnly: false,
    pause: async () => assert.fail('dead client must exit promptly'), report: () => {} }), 75);
  assert.equal(closed, 1); assert.equal(f.instance.state.tasks[id(1)].retryKind, 'transient');
  const timeout = fixture(); let pauses = 0, timeoutClosed = 0;
  timeout.adapter.close = () => { timeoutClosed++; };
  timeout.adapter.readMetadata = async () => { throw new Error('thread/read exceeded the classifier deadline'); };
  assert.equal(await runCoordinatorLoop({ coordinator: timeout.instance, adapter: timeout.adapter, inspectOnly: false,
    pause: async () => { pauses++; timeout.instance.stop(); }, report: () => {} }), 0);
  assert.equal(pauses, 1, 'a simple timeout stays in the service with normal backoff');
  assert.equal(timeoutClosed, 1);
});

test('real B publication and native shell have distinct fixed paths, with exact publication records and host boundary', (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'epoch-registration-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const current = config({ dataHome: join(directory, 'data'), shellRoot: join(directory, 'native-shell') });
  mkdirSync(current.shellRoot);
  const host = { schema: 1, dataHome: current.dataHome, shellRoot: current.shellRoot };
  writeFileSync(join(current.shellRoot, 'runtime-host.json'), JSON.stringify(host));
  const candidateRoot = join(current.dataHome, 'runtime-v2', 'published', FIXED.candidate);
  const records = new Map([FIXED.candidate, ...Object.keys(PUBLICATIONS)].map((digest) => [digest,
    { digest, root: join(current.dataHome, 'runtime-v2', 'published', digest) }]));
  const publications = Object.entries(PUBLICATIONS).map(([source, id]) => {
    const record = { schema: 'runtime-epoch-publication/1', source, candidate: FIXED.candidate,
      verifier: FIXED.sourceFingerprint, suite: source === FIXED.shellDigest
        ? 'real-A-B-writers-and-isolated-v2-entry/2' : 'real-A-B-writers-and-isolated-cold-entry/2',
      ...(source === FIXED.shellDigest ? {} : { entryMode: 'cold' }) };
    assert.equal(payloadHash(record), id, 'known publication identity must match the original proof body');
    return { id, source, candidate: FIXED.candidate, record: JSON.stringify({ ...record, id }) };
  });
  const verified = [];
  const api = { runtimeGeneration: (_, digest) => records.get(digest), runtimeSourceDigest: () => FIXED.sourceFingerprint,
    verifyRuntimePackage: (record) => { verified.push(record.root); }, payloadHash,
    publishedDefault: () => ({ current_digest: FIXED.shellDigest }) };
  const db = { prepare(sql) {
    if (sql.includes('runtime_host_entries')) return { get: (path, digest) => path === current.shellRoot && digest === FIXED.shellDigest ? { ok: 1 } : null };
    if (sql.includes('runtime_epoch_publications')) return { all: () => publications };
    if (sql.includes('runtime_generations')) return { get: () => ({ state: 'published' }) };
    throw Error('unexpected SQL');
  } };
  validatePublications(db, api, current, candidateRoot);
  assert.ok(verified.includes(current.shellRoot));
  assert.ok(verified.includes(records.get(FIXED.shellDigest).root));
  assert.notEqual(current.shellRoot, records.get(FIXED.shellDigest).root);
  const original = publications[0].record;
  publications[0].record = JSON.stringify({ ...JSON.parse(original), verifier: 'forged' });
  assert.throws(() => validatePublications(db, api, current, candidateRoot), /publication_record_changed/);
  publications[0].record = original;
  writeFileSync(join(current.shellRoot, 'runtime-host.json'), JSON.stringify({ ...host, dataHome: '/wrong-data' }));
  assert.throws(() => validatePublications(db, api, current, candidateRoot), /frozen_shell_data_boundary_changed/);
});
