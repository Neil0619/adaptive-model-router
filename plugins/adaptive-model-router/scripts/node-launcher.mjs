#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { discoverNodeRuntime, supportsNodeRuntime } from "./lib/node-discovery.mjs";
import { emitDiagnostic } from "./lib/diagnostics.mjs";
import { environmentWithPluginData } from "./lib/plugin-data.mjs";
import { pluginRootFrom, runtimeEntrypoint } from "./lib/runtime-loader.mjs";

const target = process.argv[2];
const targetArgs = process.argv.slice(3);
const failure = "Adaptive Model Router requires Node.js 24.15.0 or newer\n";
const startedAt = Date.now();
let stage = "arguments";

function runtimeSelectionFailureCategory(error) {
  if (error?.message === "runtime pointer is busy") return "pointer_busy";
  if (["EACCES", "EBUSY", "EEXIST", "ENOENT", "EPERM"].includes(error?.code)) {
    return `pointer_${error.code.toLowerCase()}`;
  }
  return "selection_failed";
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

if (!supportsNodeRuntime(process.versions.node)) {
  const relaunched = spawnSync(runtime.executable, [fileURLToPath(import.meta.url), target, ...targetArgs], {
    env: process.env, stdio: "inherit", windowsHide: true, shell: false,
  });
  process.exit(Number.isInteger(relaunched.status) ? relaunched.status : 2);
}
const ownRoot = pluginRootFrom(import.meta.url);
let launchEnv;
let endRuntimeDispatch = () => {};
let resolvedTarget = target;
let selectedDispatch = null;
let hookInput = null;
let nativeHookInput = null;
try {
  const hookTarget = /[\\/]scripts[\\/]hook\.mjs$/u.test(target);
  if (hookTarget) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 1048576) throw new Error("Hook input exceeds the bounded read limit");
      chunks.push(chunk);
    }
    hookInput = Buffer.concat(chunks);
    nativeHookInput = JSON.parse(hookInput.toString("utf8"));
  }
  const hostConfig = join(ownRoot, "runtime-host.json");
  if (existsSync(hostConfig)) {
    const host = JSON.parse(readFileSync(hostConfig, "utf8"));
    if (host.schema !== 1 || realpathSync(host.shellRoot) !== realpathSync(ownRoot) || typeof host.dataHome !== "string") throw new Error("Stable shell host binding is invalid");
    process.env.ADAPTIVE_ROUTER_HOME = host.dataHome;
    process.env.PLUGIN_DATA = host.dataHome;
    process.env.PLUGIN_ROOT = ownRoot;
  }
  launchEnv = environmentWithPluginData(import.meta.url);
  // Dispatcher and launched runtime use the same resolved persistent domain.
  Object.assign(process.env, launchEnv);
  const currentRoot = launchEnv.PLUGIN_ROOT ? resolve(launchEnv.PLUGIN_ROOT) : ownRoot;
  if (hookTarget) {
    if (realpathSync(target) !== realpathSync(resolve(currentRoot, "scripts/hook.mjs"))) throw new Error("Hook target differs from the stable shell");
    const dispatcher = await import("./lib/runtime-dispatch.mjs"); endRuntimeDispatch = dispatcher.endRuntimeDispatch;
    selectedDispatch = dispatcher.beginHookDispatch(nativeHookInput, { env: launchEnv, shellRoot: currentRoot });
    if (selectedDispatch.unmanaged) process.exit(0);
    resolvedTarget = runtimeEntrypoint(selectedDispatch.selected, "hook");
    launchEnv.ADAPTIVE_ROUTER_INVOCATION_ID = selectedDispatch.invocation.id;
    // Qualification still validates the actual stable, trusted host entry.
    launchEnv.ADAPTIVE_ROUTER_SHELL_ROOT = currentRoot;
    if (launchEnv.ADAPTIVE_ROUTER_RUNTIME_TRACE === "1") process.stderr.write(`Adaptive Model Router runtime=${selectedDispatch.selected.descriptor.runtimeVersion} digest=${selectedDispatch.selected.digest}\n`);
  }
} catch (error) {
  process.stderr.write(`Adaptive Model Router runtime dispatch refused: ${error.message}\n`);
  // Failure only closes Router-owned operations. An ordinary root command must
  // remain usable to diagnose/repair Router. No command coverage or completion
  // receipt is emitted on this path; later migration must prove it separately.
  const input = nativeHookInput, targetName = input?.tool_input?.target || "";
  const managed = !input || input.agent_id || input.agent_type
    || /^router_[a-f0-9]{32}$/u.test(input.tool_input?.task_name || "")
    || String(input.tool_input?.message || "").startsWith("[[adaptive-model-router:ticket:")
    || /^(?:\/root\/)?router_[a-f0-9]{32}$/u.test(targetName) || /^[a-f0-9-]{36}$/u.test(targetName)
    || /adaptive[-_]model[-_]router/iu.test(input.tool_name || "");
  process.stderr.write("Adaptive Model Router runtime_coverage_gap: native Hook dispatch was not recorded.\n");
  if (targetArgs[0] === "pre-tool-use" && managed) {
    process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"Runtime ownership could not be verified."}}) + "\n");
    process.exit(2);
  }
  process.exit(managed ? 2 : 0);
}

let child;
try {
  stage = "spawn";
  child = spawn(runtime.executable, [resolvedTarget, ...targetArgs], {
    env: launchEnv,
    stdio: hookInput === null ? "inherit" : ["pipe", "inherit", "inherit"],
    windowsHide: true,
    shell: false,
  });
} catch (error) {
  endRuntimeDispatch(selectedDispatch, false);
  process.stderr.write(failure);
  emitDiagnostic({ component: "launcher", stage, error, category: "spawn_failed", startedAt });
  process.exit(2);
}

if (hookInput !== null) child.stdin.end(hookInput);

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
  endRuntimeDispatch(selectedDispatch, false);
  process.stderr.write(failure);
  emitDiagnostic({ component: "launcher", stage: "spawn", error, category: "spawn_failed", startedAt });
  process.exitCode = 2;
});

child.once("exit", (code, signal) => {
  if (settled) return;
  settled = true;
  cleanup();
  process.exitCode = Number.isInteger(code) ? code : 1;
  endRuntimeDispatch(selectedDispatch, signal == null && code === 0);
  if (process.exitCode !== 0) {
    emitDiagnostic({ component: "launcher", stage: "child", category: "child_exit", startedAt });
  }
});
