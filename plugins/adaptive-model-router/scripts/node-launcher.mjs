#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverNodeRuntime } from "./lib/node-discovery.mjs";
import { emitDiagnostic } from "./lib/diagnostics.mjs";
import {
  markRuntimeFailed,
  markRuntimeHealthy,
  pluginRootFrom,
  resolveRuntime,
  RUNTIME_PROBE_TIMEOUT_MS,
  runtimeEntrypoint,
} from "./lib/runtime-loader.mjs";

const target = process.argv[2];
const targetArgs = process.argv.slice(3);
const failure = "Adaptive Model Router requires Node.js 24.15.0 or newer\n";
const startedAt = Date.now();
let stage = "arguments";

function inferInstalledPluginData() {
  // Windows hook launches receive PLUGIN_DATA, but MCP launches may only expose
  // the installed cache path. Mirror Codex's adjacent plugins/data layout.
  const scriptsRoot = dirname(fileURLToPath(import.meta.url));
  const versionRoot = dirname(scriptsRoot);
  const pluginRoot = dirname(versionRoot);
  const marketplaceRoot = dirname(pluginRoot);
  const cacheRoot = dirname(marketplaceRoot);
  const pluginsRoot = dirname(cacheRoot);
  if (basename(cacheRoot).toLowerCase() !== "cache" || basename(pluginsRoot).toLowerCase() !== "plugins") {
    return null;
  }
  return join(pluginsRoot, "data", `${basename(marketplaceRoot)}-${basename(pluginRoot)}`);
}

function childEnvironment() {
  const env = { ...process.env };
  if (!env.ADAPTIVE_ROUTER_HOME && !env.PLUGIN_DATA && !env.CLAUDE_PLUGIN_DATA) {
    const pluginData = inferInstalledPluginData();
    if (pluginData) env.PLUGIN_DATA = pluginData;
  }
  return env;
}

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

const launchEnv = childEnvironment();
let resolvedTarget = target;
let selectedResolution = null;
let attemptedResolution = null;
try {
  const currentRoot = launchEnv.PLUGIN_ROOT
    ? resolve(launchEnv.PLUGIN_ROOT)
    : pluginRootFrom(import.meta.url);
  let resolution = resolveRuntime(currentRoot, { env: launchEnv });
  const currentHook = runtimeEntrypoint(resolution.current, "hook");
  if (resolve(target) === resolve(currentHook)) {
    if (resolution.candidate.root !== resolution.current.root) attemptedResolution = resolution;
    if (resolution.provisional) {
      const contractProbe = spawnSync(runtime.executable, [
        runtimeEntrypoint(resolution.current, "probe"),
        resolution.candidate.root,
      ], {
        env: launchEnv,
        encoding: "utf8",
        windowsHide: true,
        timeout: RUNTIME_PROBE_TIMEOUT_MS,
      });
      const healthProbe = !contractProbe.error && contractProbe.status === 0
        ? spawnSync(runtime.executable, [runtimeEntrypoint(resolution.candidate, "probe")], {
          env: launchEnv,
          encoding: "utf8",
          windowsHide: true,
          timeout: RUNTIME_PROBE_TIMEOUT_MS,
        })
        : null;
      const probesPassed =
        !contractProbe.error &&
        contractProbe.status === 0 &&
        healthProbe &&
        !healthProbe.error &&
        healthProbe.status === 0;
      if (!probesPassed) {
        markRuntimeFailed(resolution, launchEnv);
        resolution = resolveRuntime(currentRoot, { env: launchEnv, allowTrial: false });
      }
    }
    resolvedTarget = runtimeEntrypoint(resolution.candidate, "hook");
    selectedResolution = resolution;
    attemptedResolution = null;
    if (launchEnv.ADAPTIVE_ROUTER_RUNTIME_TRACE === "1") {
      process.stderr.write(`Adaptive Model Router runtime=${resolution.candidate.descriptor.runtimeVersion}\n`);
    }
  } else if (launchEnv.ADAPTIVE_ROUTER_RUNTIME_TRACE === "1") {
    process.stderr.write("Adaptive Model Router runtime=unmapped\n");
  }
} catch {
  // A damaged optional hot-runtime candidate must not block the pinned shell.
  if (attemptedResolution) markRuntimeFailed(attemptedResolution, launchEnv);
  resolvedTarget = target;
  if (launchEnv.ADAPTIVE_ROUTER_RUNTIME_TRACE === "1") {
    process.stderr.write("Adaptive Model Router runtime=pinned\n");
  }
}

let child;
try {
  stage = "spawn";
  child = spawn(runtime.executable, [resolvedTarget, ...targetArgs], {
    env: launchEnv,
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  });
} catch (error) {
  if (selectedResolution && selectedResolution.candidate.root !== selectedResolution.current.root) {
    markRuntimeFailed(selectedResolution, launchEnv);
  }
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
  if (selectedResolution && selectedResolution.candidate.root !== selectedResolution.current.root) {
    markRuntimeFailed(selectedResolution, launchEnv);
  }
  process.stderr.write(failure);
  emitDiagnostic({ component: "launcher", stage: "spawn", error, category: "spawn_failed", startedAt });
  process.exitCode = 2;
});

child.once("exit", (code) => {
  if (settled) return;
  settled = true;
  cleanup();
  process.exitCode = Number.isInteger(code) ? code : 1;
  if (selectedResolution && selectedResolution.candidate.root !== selectedResolution.current.root) {
    if (process.exitCode === 0) markRuntimeHealthy(selectedResolution, launchEnv);
    else markRuntimeFailed(selectedResolution, launchEnv);
  }
  if (process.exitCode !== 0) {
    emitDiagnostic({ component: "launcher", stage: "child", category: "child_exit", startedAt });
  }
});
