import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNativeCodexCommand } from "../scripts/lib/native-host-executable.mjs";

test("native qualification selects the actual Codex ancestor ahead of an unrelated PATH CLI", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "router-native-host-")));
  try {
    const directory = join(root, "ChatGPT App");
    mkdirSync(directory);
    const native = join(directory, "codex");
    writeFileSync(native, "native host identity fixture");
    const records = new Map([
      [41, { pid: 41, parentPid: 40, executable: "/runtime/node" }],
      [40, { pid: 40, parentPid: 30, executable: native }],
    ]);
    let fallbackCalls = 0;
    const value = await resolveNativeCodexCommand({ platform: "darwin", parentPid: 41,
      readProcess: (pid) => records.get(pid),
      resolveCommand: async () => { fallbackCalls++; return { path: "/old-cli/codex", kind: "direct" }; } });
    assert.deepEqual(value, { path: native, kind: "direct" });
    assert.equal(fallbackCalls, 0);
    let reads = 0;
    await assert.rejects(resolveNativeCodexCommand({ platform: "darwin", parentPid: 40,
      readProcess: () => ({ ...records.get(40), parentPid: ++reads === 1 ? 30 : 99 }) }), /ancestry changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native host discovery does not guess through missing, cyclic, relative, or oversized ancestry", async () => {
  for (const readProcess of [
    () => null,
    (pid) => ({ pid: pid + 1, parentPid: 1, executable: "/bin/zsh" }),
    (pid) => ({ pid, parentPid: pid, executable: "/runtime/node" }),
    (pid) => ({ pid, parentPid: 1, executable: "codex" }),
    (pid) => ({ pid, parentPid: pid + 1, executable: "/runtime/node" }),
  ]) {
    await assert.rejects(resolveNativeCodexCommand({ platform: "darwin", parentPid: 40, readProcess,
      resolveCommand: async () => assert.fail("uncertain native ancestry must not fall back to PATH") }), /native host/);
  }
});

test("standalone callers and other platforms retain existing command discovery", async () => {
  const fallback = { path: "/configured/codex", kind: "direct" };
  for (const platform of ["darwin", "win32", "linux"]) {
    const value = await resolveNativeCodexCommand({ platform, parentPid: 40,
      readProcess: (pid) => ({ pid, parentPid: 1, executable: "/bin/codex-helper" }),
      resolveCommand: async () => fallback });
    assert.equal(value, fallback);
    await assert.rejects(resolveNativeCodexCommand({ platform, parentPid: 40, requireAncestor: true,
      readProcess: (pid) => ({ pid, parentPid: 1, executable: "/bin/codex-helper" }),
      resolveCommand: async () => assert.fail("call-time host attestation cannot borrow a PATH version") }), /owning host is unproven/);
  }
});
