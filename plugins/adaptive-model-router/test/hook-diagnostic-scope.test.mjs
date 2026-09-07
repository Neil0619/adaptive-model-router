import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
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
    const directory = join(p.home, "diagnostics", "hook-tasks-v1");
    for (const name of await readdir(directory)) {
      assert.equal(name.includes("private"), false);
      assert.equal((await readFile(join(directory, name), "utf8")).includes("private"), false);
    }
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
