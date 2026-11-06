import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { readNativeRootHistory } from "../scripts/lib/native-root-history.mjs";
import { rootCoverageCheck } from "../scripts/lib/runtime-root-operations.mjs";

const id = "01a1a448-29ab-76c0-8a55-038356ed73df";
const encode = (rows) => rows.map(JSON.stringify).join("\n") + "\n";
const hash = (text) => createHash("sha256").update(text).digest("hex");
function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "router-root-history-")), previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  const dir = join(root, "sessions", "2026", "11", "06"); mkdirSync(dir, { recursive: true });
  const oldPath = join(dir, `rollout-2026-11-06T01-00-00-${id}.jsonl`);
  const currentPath = join(dir, `rollout-2026-11-06T02-00-00-${id}_01a1af87-9dcc-7de0-a8d4-26bfac467af0.jsonl`);
  const meta = (ordinal, extra = {}) => ({ ordinal, type: "session_meta", payload: { id, cwd: root, source: "vscode", ...extra } });
  const old = [meta(0), { ordinal: 1, type: "event_msg", payload: { type: "task_started", turn_id: "old" } },
    { ordinal: 2, type: "event_msg", payload: { type: "task_complete", turn_id: "old" } }];
  const base = { thread_id: id, end_ordinal_exclusive: 3, end_byte_offset: Buffer.byteLength(encode(old)) };
  const current = [meta(3, { history_mode: "paginated", history_base: base }),
    { ordinal: 4, type: "event_msg", payload: { type: "task_started", turn_id: "resumed" } },
    { ordinal: 5, type: "event_msg", payload: { type: "task_complete", turn_id: "resumed" } }];
  const save = () => { writeFileSync(oldPath, encode(old)); writeFileSync(currentPath, encode(current)); };
  const read = (accept = () => {}) => readNativeRootHistory(currentPath, { contextId: id, cwd: root, deadline: Date.now() + 5000 }, accept);
  save();
  try { run({ root, dir, old, current, base, save, read, oldPath, currentPath }); }
  finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; rmSync(root, { recursive: true, force: true }); }
}

test("resumed history retains original coverage and reads only the exact ancestor prefix", () => fixture((f) => {
  const digest = hash(encode(f.old)), coverage = rootCoverageCheck({ throughLine: 3, prefixDigest: digest });
  f.old.push({ ordinal: 3, type: "response_item", payload: { type: "function_call", call_id: "excluded-old-tail" } }); f.save();
  const seen = []; let matched = false;
  const result = f.read((entry, line) => { const check = coverage(entry, line); if (check !== null) matched = check; seen.push(entry); });
  assert.equal(matched, true);
  assert.deepEqual(seen.map((e) => e.ordinal), [0, 1, 2, 3, 4, 5]);
  assert.ok(!JSON.stringify(seen).includes("excluded-old-tail"));
  assert.equal(result.sources.length, 2);
  assert.equal(f.base.end_byte_offset, Buffer.byteLength(encode(f.old.slice(0, 3))));
}));

test("history references reject foreign identity, broken boundaries, missing prefixes and ambiguity", () => {
  for (const mode of ["foreign", "partial-byte", "wrong-ordinal", "bad-origin", "missing", "ambiguous"]) fixture((f) => {
    if (mode === "foreign") f.base.thread_id = "another-thread";
    if (mode === "partial-byte") f.base.end_byte_offset--;
    if (mode === "wrong-ordinal") f.base.end_ordinal_exclusive++;
    if (mode === "bad-origin") f.old[0].payload.id = "another-thread";
    f.save();
    if (mode === "missing") rmSync(f.oldPath);
    if (mode === "ambiguous") {
      const other = readFileSync(f.oldPath, "utf8").replaceAll('"old"', '"bad"');
      writeFileSync(join(f.dir, `rollout-2026-11-06T00-00-00-${id}.jsonl`), other);
    }
    assert.throws(() => f.read(), /reference|prefix|origin/);
  });
});

test("a source changed during history verification cannot authorize handover", () => fixture((f) => {
  assert.throws(() => f.read((_entry, line) => {
    if (line === 4) writeFileSync(f.oldPath, readFileSync(f.oldPath, "utf8") + "\n");
  }), /changed/);
}));
