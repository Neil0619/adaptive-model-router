import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { readStableRollout, resolveRolloutPath, rolloutIdentity, COLD_ROLLOUT_FILE_LIMIT } from "../scripts/lib/native-rollout-reader.mjs";
import { zstdCompressSync, constants } from "node:zlib";
import { nativeSessionSourceIndex } from "../scripts/lib/native-session-sources.mjs";

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "router-rollout-snapshot-"));
  const path = join(root, "parent.jsonl"), bytes = '{"value":1}\n{"value":2}\n';
  writeFileSync(path, bytes);
  try { run({ path, bytes }); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("native compressed archives preserve full content proofs and enforce byte, record, time and stability bounds", () => fixture(({ path, bytes }) => {
  const compressed = `${path}.zst`;
  writeFileSync(compressed, zstdCompressSync(bytes));
  const seen = [], snapshot = readStableRollout(compressed, entry => seen.push(entry.value));
  assert.deepEqual(seen, [1, 2]);
  assert.equal(snapshot.transcriptDigest, readStableRollout(path, () => {}).transcriptDigest);
  assert.ok(snapshot.transcriptBytes >= Buffer.byteLength(bytes));
  const identity = rolloutIdentity(compressed);
  assert.throws(() => readStableRollout(compressed, () => {}, { deadline: Date.now() - 1 }), /budget exhausted/);
  assert.equal(rolloutIdentity(compressed), identity);
  writeFileSync(compressed, zstdCompressSync(JSON.stringify({ value: "x".repeat(10000) }) + "\n"));
  assert.throws(() => readStableRollout(compressed, () => assert.fail("expanded bomb admitted"), { maxBytes: 1024 }), /exceeds evidence bounds/);
  writeFileSync(compressed, zstdCompressSync('{"value":1}'));
  assert.throws(() => readStableRollout(compressed, () => {}), /incomplete records/);
  writeFileSync(compressed, Buffer.from("invalid frame"));
  assert.throws(() => readStableRollout(compressed, () => {}), /compressed transcript is invalid/);
  const packed = zstdCompressSync(bytes); writeFileSync(compressed, packed.subarray(0, packed.length - 1));
  assert.throws(() => readStableRollout(compressed, () => {}), /compressed transcript is invalid/);
  writeFileSync(compressed, zstdCompressSync(JSON.stringify({ value: "x".repeat(16 * 1024 * 1024) }) + "\n"));
  assert.throws(() => readStableRollout(compressed, () => {}), /line exceeds evidence bounds/);
  writeFileSync(compressed, packed);
  assert.throws(() => readStableRollout(compressed, (_entry, line) => {
    if (line === 1) writeFileSync(compressed, zstdCompressSync(bytes + '{"value":3}\n'));
  }, { allowAppend: true }), /changed during evidence read/);
}));

test("native path discovery resolves compression and archiving without replacing an existing plain source", () => fixture(({ path }) => {
  const home = join(path, "..", "home"), oldHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  const owner = "11111111-1111-1111-1111-111111111111";
  const directory = join(home, "sessions", "2026", "10", "22"), archive = join(home, "archived_sessions");
  mkdirSync(directory, { recursive: true }); mkdirSync(archive);
  const name = `rollout-2026-10-22T00-00-00-${owner}.jsonl`, plain = join(directory, name), packed = `${plain}.zst`;
  try {
    writeFileSync(packed, zstdCompressSync('{"value":1}\n'));
    assert.equal(resolveRolloutPath(plain), packed);
    assert.deepEqual(nativeSessionSourceIndex(Date.now() + 5000).get(owner), [packed]);
    renameSync(packed, join(archive, `${name}.zst`));
    assert.equal(resolveRolloutPath(plain), join(archive, `${name}.zst`));
    assert.deepEqual(nativeSessionSourceIndex(Date.now() + 5000).get(owner), [join(archive, `${name}.zst`)]);
    writeFileSync(plain, "malformed original");
    assert.equal(resolveRolloutPath(plain), plain);
    assert.throws(() => readStableRollout(plain, () => {}));
  } finally { if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome; }
}));

test("compressed archives verify every concatenated frame and reject truncated complete JSON prefixes", () => fixture(({ path, bytes }) => {
  const compressed = `${path}.zst`, frame = zstdCompressSync(bytes, { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
  writeFileSync(compressed, Buffer.concat([frame, frame]));
  const seen = []; readStableRollout(compressed, row => seen.push(row.value));
  assert.deepEqual(seen, [1, 2, 1, 2]);
  for (const bad of [frame.subarray(0, frame.length - 1), Buffer.concat([frame, frame.subarray(0, frame.length - 1)]),
    Buffer.concat([frame, Buffer.from([0x28, 0xb5])]), Buffer.concat([frame.subarray(0, -1), Buffer.from([frame.at(-1) ^ 1])])]) {
    writeFileSync(compressed, bad);
    assert.throws(() => readStableRollout(compressed, () => {}), /compressed transcript is invalid/);
  }
}));

test("expanded cold byte budget remains finite and preserves complete hashing, record and source checks", () => fixture(({ path, bytes }) => {
  const options = { maxBytes: COLD_ROLLOUT_FILE_LIMIT, deadline: Date.now() + 5000 };
  for (const maxBytes of [0, -1, NaN, Infinity, 1.5, COLD_ROLLOUT_FILE_LIMIT + 1])
    assert.throws(() => readStableRollout(path, () => {}, { ...options, maxBytes }), /byte budget is invalid/);
  assert.throws(() => readStableRollout(path, () => {}, { maxBytes: COLD_ROLLOUT_FILE_LIMIT }), /requires a finite deadline/);
  assert.throws(() => readStableRollout(path, () => {}, { maxBytes: Buffer.byteLength(bytes) - 1 }), /exceeds evidence bounds/);
  const seen = [];
  const result = readStableRollout(path, entry => seen.push(entry.value), options);
  assert.deepEqual(seen, [1, 2]);
  assert.equal(result.transcriptDigest, createHash("sha256").update(bytes).digest("hex"));
  assert.throws(() => readStableRollout(path, () => {}, { ...options, deadline: Date.now() - 1 }), /budget exhausted/);
  assert.throws(() => readStableRollout(path, (_entry, line) => {
    if (line === 1) appendFileSync(path, '{"value":3}\n');
  }, options), /changed during evidence read/);
  writeFileSync(path, '{"value":1}');
  assert.throws(() => readStableRollout(path, () => {}, options), /incomplete records/);
  writeFileSync(path, JSON.stringify({ value: "x".repeat(16 * 1024 * 1024) }) + "\n");
  assert.throws(() => readStableRollout(path, () => assert.fail("oversized business record admitted"), options), /line exceeds evidence bounds/);
}));

test("ordinary reads keep 512 MiB while cold reads reject files beyond their 1 GiB cap before parsing", () => fixture(({ path }) => {
  truncateSync(path, 512 * 1024 * 1024 + 1);
  assert.throws(() => readStableRollout(path, () => assert.fail("oversized ordinary file parsed")), /exceeds evidence bounds/);
  truncateSync(path, COLD_ROLLOUT_FILE_LIMIT + 1);
  assert.throws(() => readStableRollout(path, () => assert.fail("oversized cold file parsed"),
    { maxBytes: COLD_ROLLOUT_FILE_LIMIT, deadline: Date.now() + 5000 }), /exceeds evidence bounds/);
}));

test("parent reconciliation reads a fixed complete prefix while native events append", () => fixture(({ path, bytes }) => {
  const seen = [];
  const snapshot = readStableRollout(path, (value, line) => {
    seen.push(value.value);
    if (line === 1) appendFileSync(path, '{"value":3}\n');
  }, { allowAppend: true });
  assert.deepEqual(seen, [1, 2], "new events belong to the next reconciliation snapshot");
  assert.equal(snapshot.transcriptDigest, createHash("sha256").update(bytes).digest("hex"));
  assert.ok(readFileSync(path, "utf8").endsWith('{"value":3}\n'));
}));

test("child result verification still rejects a concurrent append by default", () => fixture(({ path }) => {
  assert.throws(() => readStableRollout(path, (_value, line) => {
    if (line === 1) appendFileSync(path, '{"value":3}\n');
  }), /changed during evidence read/);
}));

const compactedMetadata = () => ({ timestamp: "2026-09-01T00:00:00.000Z", ordinal: 1, type: "compacted", payload: {
  message: "x".repeat(16 * 1024 * 1024), replacement_history: [{ type: "compaction", encrypted_content: "opaque" }],
  guardian_history: [], window_number: 1, first_window_id: "11111111-1111-1111-1111-111111111111",
  previous_window_id: "22222222-2222-2222-2222-222222222222", window_id: "33333333-3333-3333-3333-333333333333",
  compaction_response_id: "response-compaction", latest_token_usage_record: { thread_id: "thread", turn_id: "turn", session_id: "session",
    root_turn_id: "root", response_id: "response", usage: {}, turn_token_usage: {}, thread_token_usage: {} },
} });

test("message source reads bounded verified compaction metadata whole and hashes it without admitting oversized business rows", () => fixture(({ path }) => {
  const entry = compactedMetadata(), bytes = JSON.stringify(entry) + "\n";
  writeFileSync(path, bytes);
  assert.throws(() => readStableRollout(path, () => {}), /line exceeds evidence bounds/);
  let seen;
  const result = readStableRollout(path, (value) => { seen = value; }, { allowCompactedMetadata: true, deadline: Date.now() + 5000 });
  assert.deepEqual(seen, entry);
  assert.equal(result.transcriptDigest, createHash("sha256").update(bytes).digest("hex"));
  for (const mutate of [
    (value) => { value.type = "response_item"; },
    (value) => { delete value.payload.guardian_history; },
    (value) => { value.payload.window_id = "not-a-window-identity"; },
    (value) => { value.payload.replacement_history = "not-history"; },
    (value) => { value.payload.message = "x".repeat(32 * 1024 * 1024); },
  ]) {
    const changed = structuredClone(entry); mutate(changed); writeFileSync(path, JSON.stringify(changed) + "\n");
    assert.throws(() => readStableRollout(path, () => assert.fail("invalid metadata reached evidence consumer"),
      { allowCompactedMetadata: true, deadline: Date.now() + 5000 }), /line exceeds evidence bounds|compaction metadata/);
  }
}));

test("compaction metadata never relaxes the source identity or caller read deadline", () => fixture(({ path }) => {
  writeFileSync(path, JSON.stringify(compactedMetadata()) + "\n");
  assert.throws(() => readStableRollout(path, () => {}, { allowCompactedMetadata: true, deadline: Date.now() - 1 }), /budget exhausted/);
  assert.throws(() => readStableRollout(path, () => appendFileSync(path, '{"value":3}\n'),
    { allowCompactedMetadata: true, deadline: Date.now() + 5000 }), /changed during evidence read/);
}));

for (const [name, mutation] of [
  ["modified prefix", (path, bytes) => writeFileSync(path, bytes.replace('"value":1', '"value":9') + '{"value":3}\n')],
  ["truncation", (path) => writeFileSync(path, '{"value":1}\n')],
  ["path replacement", (path, bytes) => { renameSync(path, `${path}.old`); writeFileSync(path, bytes); }],
]) test(`append permission cannot hide ${name}`, () => fixture(({ path, bytes }) => {
    assert.throws(() => readStableRollout(path, (_value, line) => {
      if (line === 1) mutation(path, bytes);
    }, { allowAppend: true }), /changed during evidence read/);
}));

test("path replacement rejects distinct file IDs that round to the same Number", (t) => fixture(({ path, bytes }) => {
  const original = 2n ** 54n, replacement = original + 1n;
  assert.equal(Number(original), Number(replacement));
  const nativeFstat = fs.fstatSync, nativeStat = fs.statSync;
  let replaced = false;
  const withIdentity = (stats, identity, options) => {
    stats.ino = options?.bigint ? identity : Number(identity);
    return stats;
  };
  t.mock.method(fs, "fstatSync", (fd, options) => withIdentity(nativeFstat(fd, options), original, options));
  t.mock.method(fs, "statSync", (file, options) => withIdentity(nativeStat(file, options), replaced ? replacement : original, options));
  syncBuiltinESMExports();
  try {
    assert.throws(() => readStableRollout(path, (_value, line) => {
      if (line === 1) {
        renameSync(path, `${path}.old`);
        writeFileSync(path, bytes);
        replaced = true;
      }
    }, { allowAppend: true }), /changed during evidence read/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
}));
