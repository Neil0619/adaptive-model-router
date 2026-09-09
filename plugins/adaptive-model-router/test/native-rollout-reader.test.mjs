import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readStableRollout } from "../scripts/lib/native-rollout-reader.mjs";

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "router-rollout-snapshot-"));
  const path = join(root, "parent.jsonl"), bytes = '{"value":1}\n{"value":2}\n';
  writeFileSync(path, bytes);
  try { run({ path, bytes }); } finally { rmSync(root, { recursive: true, force: true }); }
}

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

test("append permission cannot hide modified prefixes, truncation or path replacement", () => {
  for (const mutation of [
    (path, bytes) => writeFileSync(path, bytes.replace('"value":1', '"value":9') + '{"value":3}\n'),
    (path) => writeFileSync(path, '{"value":1}\n'),
    (path, bytes) => { renameSync(path, `${path}.old`); writeFileSync(path, bytes); },
  ]) fixture(({ path, bytes }) => {
    assert.throws(() => readStableRollout(path, (_value, line) => {
      if (line === 1) mutation(path, bytes);
    }, { allowAppend: true }), /changed during evidence read/);
  });
});
