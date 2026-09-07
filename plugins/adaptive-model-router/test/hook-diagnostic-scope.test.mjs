import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordHookIdentityDiagnostic, readHookIdentityDiagnostic } from "../scripts/lib/hook-diagnostics.mjs";
import { temporaryProject } from "./fixtures.mjs";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const audit = { schemaVersion: 1, hookEvent: "UserPromptSubmit", source: "none", sessionId: "present",
  turnId: "present", boundedSubagent: false, identityStatus: "accepted" };

test("Hook dispatch from another task or turn cannot establish current-task readiness", async () => {
  const p = await temporaryProject("router-hook-receipts-");
  const env = { ...process.env, ADAPTIVE_ROUTER_HOME: p.home };
  try {
    recordHookIdentityDiagnostic(audit, "context_emitted", env, { contextId: "private-task-A", turnId: "private-turn-1" });
    assert.equal(readHookIdentityDiagnostic(env, { contextId: "private-task-B" }).available, false);
    assert.equal(readHookIdentityDiagnostic(env, { contextId: "private-task-A", turnId: "private-turn-2" }).available, false);
    const scoped = readHookIdentityDiagnostic(env, { contextId: "private-task-A", turnId: "private-turn-1" });
    assert.equal(scoped.available, true);
    assert.equal(scoped.scope, "turn");
    assert.equal(scoped.lastObservation.contextInjection, "context_emitted");
    assert.equal(readHookIdentityDiagnostic(env).scope, "global_latest");
    const cli = spawnSync(process.execPath, [join(pluginRoot, "scripts/codex-route.mjs"), "hook-doctor"], {
      env: { ...env, CODEX_THREAD_ID: "private-task-B" }, encoding: "utf8",
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).available, false);
    for (const index of ["hook-tasks-v1", "hook-turns-v1"]) {
      const directory = join(p.home, "diagnostics", index);
      for (const name of await readdir(directory)) {
        assert.equal(name.includes("private"), false);
        assert.equal((await readFile(join(directory, name), "utf8")).includes("private"), false);
      }
    }
    const directory = join(p.home, "diagnostics", "hook-turns-v1");
    const path = join(directory, (await readdir(directory))[0]);
    await writeFile(path, "malformed");
    assert.equal(readHookIdentityDiagnostic(env, { contextId: "private-task-A", turnId: "private-turn-1" }).available, false);
    await rm(path);
    assert.equal(readHookIdentityDiagnostic(env, { contextId: "private-task-A", turnId: "private-turn-1" }).available, true,
      "a missing new index can still use the exact legacy turn receipt");
  } finally { await p.cleanup(); }
});

test("a real prompt Hook persists a receipt for the emitted context and exact turn", async () => {
  const p = await temporaryProject("router-hook-output-");
  const env = { ...process.env, ADAPTIVE_ROUTER_HOME: p.home };
  try {
    const result = spawnSync(process.execPath, [join(pluginRoot, "scripts/hook.mjs"), "prompt"], {
      encoding: "utf8", env, input: JSON.stringify({ session_id: "receipt-task", turn_id: "receipt-turn",
        hook_event_name: "UserPromptSubmit", cwd: p.root, model: "gpt-6-astra", prompt: "路由器：全局开启" }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(JSON.parse(result.stdout).hookSpecificOutput.additionalContext);
    const receipt = readHookIdentityDiagnostic(env, { contextId: "receipt-task", turnId: "receipt-turn" });
    assert.equal(receipt.available, true);
    assert.equal(receipt.lastObservation.contextInjection, "context_emitted");
  } finally { await p.cleanup(); }
});

test("turnless compaction keeps the real turn receipt without inventing another turn", async () => {
  const p = await temporaryProject("router-compact-receipt-");
  const env = { ...process.env, ADAPTIVE_ROUTER_HOME: p.home };
  try {
    recordHookIdentityDiagnostic(audit, "context_emitted", env, { contextId: "compact-task", turnId: "real-turn" });
    const result = spawnSync(process.execPath, [join(pluginRoot, "scripts/hook.mjs"), "session-start"], {
      encoding: "utf8", env, input: JSON.stringify({ session_id: "compact-task", source: "compact",
        hook_event_name: "SessionStart", cwd: p.root, model: "gpt-6-astra" }),
    });
    assert.equal(result.status, 0, result.stderr);
    const retained = readHookIdentityDiagnostic(env, { contextId: "compact-task", turnId: "real-turn" });
    assert.equal(retained.available, true);
    assert.equal(retained.lastObservation.hookEvent, "UserPromptSubmit");
    const latest = readHookIdentityDiagnostic(env, { contextId: "compact-task" });
    assert.equal(latest.lastObservation.hookEvent, "SessionStart");
    assert.equal(latest.lastObservation.source, "compact");
    assert.equal(readHookIdentityDiagnostic(env, { contextId: "compact-task", turnId: "new-turn" }).available, false);
    assert.equal(readHookIdentityDiagnostic(env, { contextId: "other-task", turnId: "real-turn" }).available, false);
    recordHookIdentityDiagnostic(audit, "context_emitted", env, { contextId: "compact-task", turnId: "new-turn" });
    assert.equal(readHookIdentityDiagnostic(env, { contextId: "compact-task", turnId: "real-turn" }).available, false);
    assert.equal(readHookIdentityDiagnostic(env, { contextId: "compact-task", turnId: "new-turn" }).available, true);
  } finally { await p.cleanup(); }
});

test("new and legacy exact-turn receipts reject incomplete or inconsistent audit objects", async () => {
  const p = await temporaryProject("router-receipt-shape-");
  const env = { ...process.env, ADAPTIVE_ROUTER_HOME: p.home };
  try {
    for (const index of ["hook-turns-v1", "hook-tasks-v1"]) {
      recordHookIdentityDiagnostic(audit, "context_emitted", env, { contextId: "shape-task", turnId: "shape-turn" });
      if (index === "hook-tasks-v1") await rm(join(p.home, "diagnostics", "hook-turns-v1"), { recursive: true });
      const directory = join(p.home, "diagnostics", index);
      const path = join(directory, (await readdir(directory))[0]);
      const valid = JSON.parse(await readFile(path, "utf8"));
      const mutations = [
        ...Object.keys(valid).map((key) => { const changed = { ...valid }; delete changed[key]; return changed; }),
        { ...valid, identityStatus: "rejected" }, { ...valid, identityStatus: "missing_session_id" },
        { ...valid, sessionId: "missing" }, { ...valid, turnId: "absent" },
        { ...valid, schemaVersion: 2 }, { ...valid, hookEvent: "unknown" },
        { ...valid, hookEvent: "FutureHook" }, { ...valid, source: "future" },
        { ...valid, observedAt: "yesterday" }, { ...valid, boundedSubagent: true },
        { ...valid, boundedSubagent: "false" }, { ...valid, contextInjection: "" },
        { ...valid, unexpectedPayload: "not audited" },
      ];
      for (const changed of mutations) {
        await writeFile(path, JSON.stringify(changed));
        const result = readHookIdentityDiagnostic(env, { contextId: "shape-task", turnId: "shape-turn" });
        assert.equal(result.available, false, `${index}: ${JSON.stringify(changed)}`);
      }
      await writeFile(path, JSON.stringify(valid));
      assert.equal(readHookIdentityDiagnostic(env, { contextId: "shape-task", turnId: "shape-turn" }).available, true);
    }
  } finally { await p.cleanup(); }
});
