import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { temporaryProject } from "./fixtures.mjs";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const hook = join(pluginRoot, "scripts", "hook.mjs");
const launcher = join(pluginRoot, "scripts", "node-launcher.mjs");
const prefix = "Adaptive Model Router diagnostic ";
const allowedKeys = ["category", "component", "elapsedMs", "nodeMajor", "pluginData", "stage", "stateRootSource"];

function diagnostic(stderr) {
  const line = stderr.split(/\r?\n/).find((value) => value.startsWith(prefix));
  assert.ok(line, "expected an opt-in diagnostic line");
  const value = JSON.parse(line.slice(prefix.length));
  assert.deepEqual(Object.keys(value).sort(), allowedKeys);
  assert.match(value.component, /^(hook|launcher)$/);
  assert.match(value.stage, /^(runtime|database_import|input|prompt|stop|arguments|runtime_discovery|spawn|child)$/);
  assert.match(value.category, /^(missing_target|runtime_unavailable|spawn_failed|child_exit|invalid_input|state_dir_unwritable|sqlite_busy|sqlite_readonly|runtime|unknown)$/);
  assert.match(value.pluginData, /^(present|absent)$/);
  assert.match(value.stateRootSource, /^(adaptive_override|plugin_data|codex_home)$/);
  assert.equal(Number.isInteger(value.nodeMajor) && value.nodeMajor >= 0, true);
  assert.equal(Number.isInteger(value.elapsedMs) && value.elapsedMs >= 0, true);
  return value;
}

test("hook emits sanitized diagnostics for invalid JSON input", () => {
  const secret = "secret-prompt secret-path secret-env";
  const result = spawnSync(process.execPath, [hook, "prompt"], {
    input: `{${secret}`,
    encoding: "utf8",
    env: { ...process.env, ADAPTIVE_ROUTER_DIAGNOSTICS: "1", ADAPTIVE_ROUTER_HOME: secret, PLUGIN_DATA: secret },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr.startsWith("Adaptive Model Router hook failed safely.\n"), true);
  assert.deepEqual(diagnostic(result.stderr), {
    component: "hook",
    stage: "input",
    category: "invalid_input",
    nodeMajor: Number.parseInt(process.versions.node, 10),
    pluginData: "present",
    stateRootSource: "adaptive_override",
    elapsedMs: diagnostic(result.stderr).elapsedMs,
  });
  assert.equal(result.stderr.includes(secret), false);
});

test("hook classifies oversized stdin as invalid input without echoing it", () => {
  const secret = "oversized-secret-value";
  const result = spawnSync(process.execPath, [hook, "prompt"], {
    input: `${secret}${"x".repeat(1_000_001)}`,
    encoding: "utf8",
    env: { ...process.env, ADAPTIVE_ROUTER_DIAGNOSTICS: "1" },
  });
  assert.equal(result.status, 0);
  const value = diagnostic(result.stderr);
  assert.equal(value.component, "hook");
  assert.equal(value.stage, "input");
  assert.equal(value.category, "invalid_input");
  assert.equal(result.stderr.includes(secret), false);
});

test("hook diagnoses an invalid state root without disclosing it", async () => {
  const project = await temporaryProject("diagnostic secret root ");
  try {
    const invalidRoot = join(project.root, "secret-state-file");
    await writeFile(invalidRoot, "not a directory");
    const result = spawnSync(process.execPath, [hook, "prompt"], {
      input: JSON.stringify({ prompt: "secret prompt", session_id: "secret-session", cwd: project.root }),
      encoding: "utf8",
      env: { ...process.env, ADAPTIVE_ROUTER_DIAGNOSTICS: "1", ADAPTIVE_ROUTER_HOME: invalidRoot },
    });
    const value = diagnostic(result.stderr);
    assert.equal(value.component, "hook");
    assert.equal(value.stage, "prompt");
    assert.equal(value.category, "state_dir_unwritable");
    assert.equal(result.stderr.includes(project.root), false);
    assert.equal(result.stderr.includes("secret prompt"), false);
    assert.equal(result.stderr.includes("secret-session"), false);
  } finally {
    await project.cleanup();
  }
});

test("launcher emits sanitized diagnostics when no target is supplied", () => {
  const secret = "secret-launcher-env";
  const result = spawnSync(process.execPath, [launcher], {
    encoding: "utf8",
    env: { ...process.env, ADAPTIVE_ROUTER_DIAGNOSTICS: "1", ADAPTIVE_ROUTER_HOME: secret },
  });
  assert.equal(result.status, 2);
  const value = diagnostic(result.stderr);
  assert.equal(value.component, "launcher");
  assert.equal(value.stage, "arguments");
  assert.equal(value.category, "missing_target");
  assert.equal(result.stderr.includes(secret), false);
});
