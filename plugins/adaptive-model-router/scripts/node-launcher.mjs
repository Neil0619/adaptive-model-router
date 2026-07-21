#!/usr/bin/env node
import { spawn } from "node:child_process";
import { discoverNodeRuntime } from "./lib/node-discovery.mjs";
import { emitDiagnostic } from "./lib/diagnostics.mjs";

const target = process.argv[2];
const targetArgs = process.argv.slice(3);
const failure = "Adaptive Model Router requires Node.js 24.15.0 or newer\n";
const startedAt = Date.now();
let stage = "arguments";

if (!target) {
  process.stderr.write(failure);
  emitDiagnostic({ component: "launcher", stage, category: "missing_target", startedAt });
  process.exit(2);
}

stage = "runtime_discovery";
const runtime = discoverNodeRuntime();
if (!runtime) {
  process.stderr.write(failure);
  emitDiagnostic({ component: "launcher", stage, category: "runtime_unavailable", startedAt });
  process.exit(2);
}

let child;
try {
  stage = "spawn";
  child = spawn(runtime.executable, [target, ...targetArgs], {
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  });
} catch (error) {
  process.stderr.write(failure);
  emitDiagnostic({ component: "launcher", stage, error, category: "spawn_failed", startedAt });
  process.exit(2);
}

let settled = false;
const signals = process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGHUP", "SIGINT", "SIGTERM"];
const forwarders = new Map(signals.map((signal) => [signal, () => {
  if (!child.killed) child.kill(signal);
}]));
for (const [signal, forward] of forwarders) process.on(signal, forward);

function cleanup() {
  for (const [signal, forward] of forwarders) process.off(signal, forward);
}

child.once("error", (error) => {
  if (settled) return;
  settled = true;
  cleanup();
  process.stderr.write(failure);
  emitDiagnostic({ component: "launcher", stage: "spawn", error, category: "spawn_failed", startedAt });
  process.exitCode = 2;
});

child.once("exit", (code) => {
  if (settled) return;
  settled = true;
  cleanup();
  process.exitCode = Number.isInteger(code) ? code : 1;
  if (process.exitCode !== 0) {
    emitDiagnostic({ component: "launcher", stage: "child", category: "child_exit", startedAt });
  }
});
