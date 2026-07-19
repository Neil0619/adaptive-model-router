#!/usr/bin/env node
import { spawn } from "node:child_process";
import { discoverNodeRuntime } from "./lib/node-discovery.mjs";

const target = process.argv[2];
const targetArgs = process.argv.slice(3);
const failure = "Adaptive Model Router requires Node.js 24.15.0 or newer\n";

if (!target) {
  process.stderr.write(failure);
  process.exit(2);
}

const runtime = discoverNodeRuntime();
if (!runtime) {
  process.stderr.write(failure);
  process.exit(2);
}

const child = spawn(runtime.executable, [target, ...targetArgs], {
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
  shell: false,
});

let settled = false;
const signals = process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGHUP", "SIGINT", "SIGTERM"];
const forwarders = new Map(signals.map((signal) => [signal, () => {
  if (!child.killed) child.kill(signal);
}]));
for (const [signal, forward] of forwarders) process.on(signal, forward);

function cleanup() {
  for (const [signal, forward] of forwarders) process.off(signal, forward);
}

child.once("error", () => {
  if (settled) return;
  settled = true;
  cleanup();
  process.stderr.write(failure);
  process.exitCode = 2;
});

child.once("exit", (code) => {
  if (settled) return;
  settled = true;
  cleanup();
  process.exitCode = Number.isInteger(code) ? code : 1;
});
