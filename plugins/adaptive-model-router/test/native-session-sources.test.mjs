import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isNativeSessionSource, nativeSessionSourceIndex } from "../scripts/lib/native-session-sources.mjs";

test("native segment discovery is bounded to exact owner tokens and regular host directories", () => {
  const home = mkdtempSync(join(tmpdir(), "router-native-sources-")), previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const owner = "11111111-1111-1111-1111-111111111111", segment = "22222222-2222-2222-2222-222222222222";
    const sessions = join(home, "sessions", "2026", "09", "24"), archive = join(home, "archived_sessions");
    mkdirSync(sessions, { recursive: true }); mkdirSync(archive);
    const name = `rollout-2026-09-24T10-00-00-${owner}.jsonl`;
    const original = join(archive, name), rotated = join(sessions, `rollout-2026-09-24T11-00-00-${owner}_${segment}.jsonl`);
    for (const path of [original, rotated, join(sessions, name + ".untrusted"), join(sessions, `prefix-${name}`)]) writeFileSync(path, "{}");
    assert.equal(isNativeSessionSource(original, owner), true);
    assert.equal(isNativeSessionSource(rotated, owner), true);
    assert.equal(isNativeSessionSource(rotated, segment), false);
    assert.equal(isNativeSessionSource(join(home, name), owner), false);
    assert.equal(isNativeSessionSource(null, owner), false);
    assert.deepEqual(nativeSessionSourceIndex(Date.now() + 5000).get(owner), [original, rotated]);
    assert.throws(() => nativeSessionSourceIndex(Infinity), /finite deadline/);
    assert.throws(() => nativeSessionSourceIndex(Date.now() - 1), /budget exhausted/);
    const alias = join(sessions, name); symlinkSync(original, alias);
    assert.throws(() => nativeSessionSourceIndex(Date.now() + 5000), /not a regular file/);
    rmSync(alias); symlinkSync(archive, join(home, "sessions", "2027"));
    assert.throws(() => nativeSessionSourceIndex(Date.now() + 5000), /not a regular directory/);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
