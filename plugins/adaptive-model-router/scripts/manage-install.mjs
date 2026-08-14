#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  AGENTS_MARKER_END,
  AGENTS_MARKER_START,
  ROUTER_VERSION,
} from "./lib/constants.mjs";
import {
  LEGACY_V04_COMPATIBILITY,
  readCompatibilityDescriptor,
  sameLiveCompatibility,
} from "./lib/compatibility.mjs";
import { resolveCodexCommandSync, spawnSpec } from "./lib/codex-command.mjs";
import { canonicalJson, sanitizedError } from "./lib/io.mjs";
import { assertRuntime } from "./lib/runtime.mjs";
import {
  compareRuntimeVersions,
  parseRuntimeDescriptor,
} from "./lib/runtime-loader.mjs";

const MARKETPLACE = "adaptive-model-router";
const PLUGIN_ID = "adaptive-model-router@adaptive-model-router";
const REPOSITORY = "Neil0619/adaptive-model-router";
const DEFAULT_REF = "stable";
const LEGACY_MARKETPLACE = "adaptive-local";
const LEGACY_PLUGIN_ID = "adaptive-model-router@adaptive-local";
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = resolve(PLUGIN_ROOT, "..", "..");
const SOURCE_MANIFEST = JSON.parse(readFileSync(join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"), "utf8"));
const SOURCE_RUNTIME = parseRuntimeDescriptor(
  JSON.parse(readFileSync(join(PLUGIN_ROOT, "runtime.json"), "utf8")),
);
const SOURCE_COMPATIBILITY = readCompatibilityDescriptor(PLUGIN_ROOT);
const INSTALL_VERSION = SOURCE_MANIFEST.version;
const REQUIRED_TASK_TOOLS = Object.freeze(["diagnose_router", "record_outcome", "route_stage"]);
const LIVE_TASK_SMOKE_TOOLS = Object.freeze(["diagnose_router", "route_stage"]);
const HOOK_EVENTS = Object.freeze(["SubagentStart", "UserPromptSubmit", "Stop"]);
const LIVE_BRIDGE_FILES = Object.freeze([
  "compatibility.json",
  "scripts/lib/plugin-data.mjs",
  "scripts/stdio-tool.mjs",
  "skills/adaptive-model-router/SKILL.md",
]);
const HOST_SURFACE_FILES = Object.freeze([
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "hooks/hooks.json",
  "skills/adaptive-model-router/SKILL.md",
  "skills/adaptive-model-router/agents/openai.yaml",
]);
const MUTABLE_RUNTIME_FILES = Object.freeze([
  ".mcp.json",
  "hooks/hooks.json",
  ...LIVE_BRIDGE_FILES,
]);
const installWait = new Int32Array(new SharedArrayBuffer(4));
const DESKTOP_NODE_BRIDGE_MARKER = "adaptive-model-router Desktop PATH compatibility bridge";

if (
  SOURCE_MANIFEST.name !== "adaptive-model-router" ||
  SOURCE_RUNTIME.runtimeVersion !== INSTALL_VERSION ||
  INSTALL_VERSION.split("+")[0] !== ROUTER_VERSION
) {
  throw new Error("installer source version metadata is inconsistent");
}

class InstallError extends Error {
  constructor(message, exitCode, errorCode = null) {
    super(message);
    this.exitCode = exitCode;
    this.errorCode = errorCode;
  }
}

function parseArgs(values) {
  const parsed = {
    action: "install",
    patchAgents: false,
    nonInteractive: false,
    verifyTaskTools: false,
    yes: false,
    ref: DEFAULT_REF,
  };
  for (const value of values) {
    if (["install", "upgrade", "uninstall"].includes(value)) parsed.action = value;
    else if (value === "--patch-agents") parsed.patchAgents = true;
    else if (value === "--non-interactive") parsed.nonInteractive = true;
    else if (value === "--verify-task-tools") parsed.verifyTaskTools = true;
    else if (value === "--yes") parsed.yes = true;
    else if (value.startsWith("--ref=")) parsed.ref = value.slice("--ref=".length);
    else throw new InstallError(`unknown installer argument: ${value}`, 2);
  }
  if (
    parsed.ref.length === 0 ||
    parsed.ref.length > 255 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(parsed.ref) ||
    parsed.ref.includes("..") ||
    parsed.ref.includes("//") ||
    parsed.ref.endsWith("/")
  ) {
    throw new InstallError("marketplace ref contains unsupported characters", 2);
  }
  return parsed;
}

function codexExecutable() {
  return resolveCodexCommandSync().path;
}

function commandSpec(command, args) {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) {
    return spawnSpec({ path: command, kind: "cmd" }, args);
  }
  return { command, args };
}

function run(command, args, { json = false, quiet = false } = {}) {
  const spec = commandSpec(command, args);
  const result = spawnSync(spec.command, spec.args, {
    encoding: "utf8",
    windowsHide: true,
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    const failureText = `${result.error?.message || ""}\n${result.stderr || ""}`;
    if (
      args[0] === "plugin" &&
      /failed to (?:back up|remove) (?:existing )?plugin cache entry|used by another process/iu.test(failureText)
    ) {
      throw new InstallError(
        "CACHE_LOCKED: Codex plugin cache is in use on Windows; fully exit Codex Desktop and every Codex CLI session, then retry",
        5,
        "CACHE_LOCKED",
      );
    }
    throw new InstallError(`${command} ${args.join(" ")} failed`, 5);
  }
  if (!quiet && result.stdout) process.stdout.write(result.stdout);
  if (!quiet && result.stderr) process.stderr.write(result.stderr);
  if (!json) return result.stdout;
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new InstallError("Codex CLI returned invalid JSON", 5);
  }
}

function preflight() {
  assertRuntime();
  run(process.execPath, ["--version"], { quiet: true });
  run("git", ["--version"], { quiet: true });
  run(codexExecutable(), ["--version"], { quiet: true });
}

function codex(args, options = {}) {
  return run(codexExecutable(), args, options);
}

function loadState() {
  const marketplaces = codex(["plugin", "marketplace", "list", "--json"], { json: true, quiet: true }).marketplaces || [];
  const plugins = codex(["plugin", "list", "--available", "--json"], { json: true, quiet: true });
  const mcpServers = codex(["mcp", "list", "--json"], { json: true, quiet: true });
  return {
    marketplaces,
    installed: plugins.installed || [],
    available: plugins.available || [],
    mcpServers: Array.isArray(mcpServers) ? mcpServers : [],
  };
}

function entryName(entry) {
  return entry.name || entry.marketplaceName;
}

function pluginId(entry) {
  return entry.pluginId || `${entry.name}@${entry.marketplaceName}`;
}

function runtimeHealthAtRoot(root) {
  try {
    const manifest = JSON.parse(readFileSync(join(root, ".codex-plugin", "plugin.json"), "utf8"));
    const runtime = JSON.parse(readFileSync(join(root, "runtime.json"), "utf8"));
    JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8"));
    readFileSync(join(root, "skills", "adaptive-model-router", "SKILL.md"), "utf8");
    const descriptor = parseRuntimeDescriptor(runtime);
    if (
      manifest?.name !== "adaptive-model-router" ||
      typeof manifest?.version !== "string" ||
      manifest.version.split("+")[0] !== ROUTER_VERSION ||
      descriptor.runtimeVersion !== manifest.version
    ) {
      return null;
    }
    let compatibility;
    try {
      compatibility = readCompatibilityDescriptor(root);
    } catch (error) {
      if (
        existsSync(join(root, "compatibility.json")) ||
        manifest.version.split("+")[0] !== ROUTER_VERSION
      ) {
        throw error;
      }
      compatibility = LEGACY_V04_COMPATIBILITY;
    }
    return {
      root: resolve(root),
      version: manifest.version,
      descriptor,
      compatibility,
    };
  } catch {
    return null;
  }
}

function mcpConfigAtRoot(root) {
  const path = join(root, ".mcp.json");
  const document = JSON.parse(readFileSync(path, "utf8"));
  const server = document?.mcpServers?.["adaptive-model-router"];
  if (
    !server ||
    typeof server !== "object" ||
    !Array.isArray(server.args) ||
    JSON.stringify(server.args) !== JSON.stringify([
      "./scripts/node-launcher.mjs",
      "./scripts/mcp-server.mjs",
    ])
  ) {
    throw new Error("Router MCP launch configuration is invalid");
  }
  return { path, document, server };
}

function isNodeCommand(command) {
  return typeof command === "string" && /^(?:.*[\\/])?node(?:\.exe)?$/iu.test(command);
}

function parsedCommandExecutable(command) {
  if (typeof command !== "string") throw new Error("Hook command is invalid");
  const match = /^(?:"([^"]+)"|'([^']+)'|(\S+))(?=\s)/u.exec(command);
  const executable = match?.[1] || match?.[2] || match?.[3];
  if (!match || !isNodeCommand(executable)) {
    throw new Error("Hook command is not a recognized Node executable");
  }
  return { executable, suffix: command.slice(match[0].length) };
}

function quotedExecutable(executable) {
  if (executable.includes('"')) throw new Error("Node executable path contains an unsupported quote");
  return `"${executable}"`;
}

function hookConfigAtRoot(root) {
  const path = join(root, "hooks", "hooks.json");
  const document = JSON.parse(readFileSync(path, "utf8"));
  const handlers = HOOK_EVENTS.map((event) => {
    const handler = document?.hooks?.[event]?.[0]?.hooks?.[0];
    if (
      !handler ||
      handler.type !== "command" ||
      typeof handler.command !== "string" ||
      typeof handler.commandWindows !== "string"
    ) {
      throw new Error(`Router ${event} Hook configuration is invalid`);
    }
    parsedCommandExecutable(handler.command);
    parsedCommandExecutable(handler.commandWindows);
    return { event, handler };
  });
  return { path, document, handlers };
}

function materializeHookNodeCommands(root) {
  const config = hookConfigAtRoot(root);
  const field = process.platform === "win32" ? "commandWindows" : "command";
  let changed = false;
  for (const { handler } of config.handlers) {
    const parsed = parsedCommandExecutable(handler[field]);
    if (parsed.executable === process.execPath) continue;
    if (
      parsed.executable !== "node" &&
      isAbsolute(parsed.executable) &&
      existsSync(parsed.executable)
    ) continue;
    handler[field] = `${quotedExecutable(process.execPath)}${parsed.suffix}`;
    changed = true;
  }
  if (changed) atomicWrite(config.path, `${JSON.stringify(config.document, null, 2)}\n`);
  return changed;
}

function materializeLaunchCommands(root) {
  const mcpChanged = materializeMcpNodeCommand(root);
  const hookChanged = materializeHookNodeCommands(root);
  return mcpChanged || hookChanged;
}

function materializeMcpNodeCommand(root) {
  const config = mcpConfigAtRoot(root);
  if (config.server.command === process.execPath) return false;
  if (config.server.command !== "node") {
    if (!isNodeCommand(config.server.command) || !isAbsolute(config.server.command)) {
      throw new Error("Router MCP command is not a recognized Node executable");
    }
    if (existsSync(config.server.command)) return false;
  }
  config.server.command = process.execPath;
  atomicWrite(config.path, `${JSON.stringify(config.document, null, 2)}\n`);
  return true;
}

function normalizedHostSurface(root, relative) {
  if (relative === ".codex-plugin/plugin.json") {
    const manifest = JSON.parse(readFileSync(join(root, relative), "utf8"));
    if (
      manifest?.name !== "adaptive-model-router" ||
      typeof manifest?.version !== "string"
    ) {
      throw new Error("Router plugin manifest is invalid");
    }
    manifest.version = manifest.version.split("+")[0];
    return Buffer.from(canonicalJson(manifest));
  }
  if (relative === ".mcp.json") {
    const config = mcpConfigAtRoot(root);
    if (!isNodeCommand(config.server.command)) throw new Error("Router MCP command is invalid");
    config.server.command = "node";
    return Buffer.from(JSON.stringify(config.document));
  }
  if (relative === "hooks/hooks.json") {
    const config = hookConfigAtRoot(root);
    for (const { handler } of config.handlers) {
      for (const field of ["command", "commandWindows"]) {
        const parsed = parsedCommandExecutable(handler[field]);
        handler[field] = `node${parsed.suffix}`;
      }
    }
    return Buffer.from(JSON.stringify(config.document));
  }
  if (relative === "skills/adaptive-model-router/SKILL.md") {
    const skill = readFileSync(join(root, relative), "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(skill)?.[1];
    const name = /^name:\s*(.+)$/mu.exec(frontmatter || "")?.[1]?.trim();
    const description = /^description:\s*(.+)$/mu.exec(frontmatter || "")?.[1]?.trim();
    if (!name || !description) throw new Error("Router skill metadata is invalid");
    return Buffer.from(JSON.stringify({ name, description }));
  }
  return readFileSync(join(root, relative));
}

function compatibleRuntimeRoots(root) {
  const versionsRoot = dirname(root);
  const roots = [];
  for (const entry of readdirSync(versionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const health = runtimeHealthAtRoot(join(versionsRoot, entry.name));
    if (
      health &&
      sameRuntimeContract(health.descriptor, SOURCE_RUNTIME) &&
      sameLiveCompatibility(health.compatibility, SOURCE_COMPATIBILITY)
    ) {
      roots.push(health.root);
    }
  }
  return roots.sort();
}

function refreshLiveBridgeFiles(root) {
  for (const relative of LIVE_BRIDGE_FILES) {
    const source = join(PLUGIN_ROOT, relative);
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    atomicWrite(target, readFileSync(source));
  }
}

function snapshotFile(path) {
  if (!existsSync(path)) return { path, exists: false, content: null, mode: null };
  return {
    path,
    exists: true,
    content: readFileSync(path),
    mode: statSync(path).mode & 0o777,
  };
}

function restoreFile(snapshot) {
  if (!snapshot.exists) {
    rmSync(snapshot.path, { force: true });
    return;
  }
  atomicWrite(snapshot.path, snapshot.content);
  chmodSync(snapshot.path, snapshot.mode);
}

function snapshotRuntimeShells(roots) {
  return roots.flatMap((root) => MUTABLE_RUNTIME_FILES.map((relative) =>
    snapshotFile(join(root, relative))));
}

function restoreSnapshots(snapshots) {
  for (const snapshot of [...snapshots].reverse()) restoreFile(snapshot);
}

function defaultDesktopOverrideDirectory() {
  if (process.env.ADAPTIVE_ROUTER_DESKTOP_OVERRIDE_DIR) {
    return resolve(process.env.ADAPTIVE_ROUTER_DESKTOP_OVERRIDE_DIR);
  }
  const fromPath = String(process.env.PATH || "")
    .split(delimiter)
    .filter(Boolean)
    .map((entry) => resolve(entry))
    .find((entry) => entry.replaceAll("\\", "/").toLowerCase()
      .endsWith("/dependencies/bin/override"));
  if (fromPath) return fromPath;
  const known = join(
    homedir(),
    ".cache",
    "codex-runtimes",
    "codex-primary-runtime",
    "dependencies",
    "bin",
    "override",
  );
  if (existsSync(known)) return known;
  return null;
}

function rootRequiresDesktopNodeBridge(root) {
  try {
    if (mcpConfigAtRoot(root).server.command === "node") return true;
    const field = process.platform === "win32" ? "commandWindows" : "command";
    return hookConfigAtRoot(root).handlers.some(({ handler }) =>
      parsedCommandExecutable(handler[field]).executable === "node");
  } catch {
    return true;
  }
}

function desktopNodeBridgePath(directory) {
  return join(directory, process.platform === "win32" ? "node.cmd" : "node");
}

function desktopNodeBridgeContent() {
  if (process.execPath.includes('"')) throw new Error("Node executable path contains an unsupported quote");
  if (process.platform === "win32") {
    return `@echo off\r\nrem ${DESKTOP_NODE_BRIDGE_MARKER}\r\n"${process.execPath}" %*\r\n`;
  }
  return `#!/bin/sh\n# ${DESKTOP_NODE_BRIDGE_MARKER}\nexec "${process.execPath}" "$@"\n`;
}

function verifyDesktopNodeBridge(directory) {
  const spec = commandSpec(desktopNodeBridgePath(directory), ["--version"]);
  const result = spawnSync(spec.command, spec.args, {
    encoding: "utf8",
    env: { ...process.env, PATH: directory },
    windowsHide: true,
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
    timeout: 5_000,
  });
  return !result.error && result.status === 0 && /^v?\d+\.\d+\.\d+/u.test(result.stdout.trim());
}

function installDesktopNodeBridge({ required = false } = {}) {
  const directory = defaultDesktopOverrideDirectory();
  if (!directory || !existsSync(directory)) {
    if (required) {
      throw new InstallError(
        "DESKTOP_PATH_BRIDGE_REQUIRED: a historical Router shell still uses bare node, but the Codex Desktop runtime override directory is unavailable; no plugin cache files were changed",
        5,
        "DESKTOP_PATH_BRIDGE_REQUIRED",
      );
    }
    process.stdout.write(
      "Desktop Node compatibility bridge status=not-required; installed commands are absolute and no legacy bare command was detected.\n",
    );
    return null;
  }
  const path = desktopNodeBridgePath(directory);
  if (existsSync(path)) {
    let owned = false;
    try {
      owned = readFileSync(path, "utf8").includes(DESKTOP_NODE_BRIDGE_MARKER);
    } catch {}
    if (!owned && verifyDesktopNodeBridge(directory)) {
      process.stdout.write(
        `Desktop Node compatibility bridge path=${JSON.stringify(path)} ownership=external probe=passed.\n`,
      );
      return { path, owned: false };
    }
    if (!owned) {
      throw new InstallError(
        "DESKTOP_PATH_BRIDGE_FAILED: the Codex runtime override already contains an unrelated broken node command",
        5,
        "DESKTOP_PATH_BRIDGE_FAILED",
      );
    }
  }
  atomicWrite(path, desktopNodeBridgeContent());
  if (process.platform !== "win32") chmodSync(path, 0o755);
  if (!verifyDesktopNodeBridge(directory)) {
    throw new InstallError(
      "DESKTOP_PATH_BRIDGE_FAILED: the installed node compatibility bridge did not start under the Desktop PATH",
      5,
      "DESKTOP_PATH_BRIDGE_FAILED",
    );
  }
  process.stdout.write(
    `Desktop Node compatibility bridge path=${JSON.stringify(path)} ownership=installer probe=passed.\n`,
  );
  return { path, owned: true };
}

function removeDesktopNodeBridge() {
  const directory = defaultDesktopOverrideDirectory();
  if (!directory) return;
  const path = desktopNodeBridgePath(directory);
  try {
    if (readFileSync(path, "utf8").includes(DESKTOP_NODE_BRIDGE_MARKER)) unlinkSync(path);
  } catch {}
}

function installedPluginHealth(state) {
  const entry = state.installed.find((candidate) => pluginId(candidate) === PLUGIN_ID);
  if (!entry) return { state: "missing" };
  const registered = state.mcpServers?.find((candidate) => candidate?.name === "adaptive-model-router");
  const registeredRoot = registered?.transport?.type === "stdio" && typeof registered.transport.cwd === "string"
    ? resolve(registered.transport.cwd)
    : null;
  const root = registeredRoot && existsSync(registeredRoot) ? registeredRoot : entry?.source?.path;
  if (typeof root !== "string" || root.length === 0) return { state: "unverifiable" };
  const health = runtimeHealthAtRoot(root);
  return health ? { state: "healthy", ...health } : { state: "damaged" };
}

function verifyInstalledPlugin(state) {
  const health = installedPluginHealth(state);
  if (health.state === "missing") {
    throw new InstallError(
      "PLUGIN_INSTALL_INCOMPLETE: Codex did not report Adaptive Model Router as installed after plugin add",
      5,
      "PLUGIN_INSTALL_INCOMPLETE",
    );
  }
  if (health.state === "unverifiable") {
    throw new InstallError(
      "PLUGIN_INSTALL_INCOMPLETE: Codex reported Adaptive Model Router as installed but did not expose a verifiable cache path",
      5,
      "PLUGIN_INSTALL_INCOMPLETE",
    );
  }
  if (health.state === "damaged") {
    throw new InstallError(
      "CACHE_DAMAGED: RECOVERY_REQUIRED: Adaptive Model Router is listed as installed but required plugin files are missing or invalid; fully exit Codex and reinstall the exact reviewed ref",
      5,
      "CACHE_DAMAGED",
    );
  }
  if (health.version !== INSTALL_VERSION) {
    throw new InstallError(
      `PLUGIN_INSTALL_INCOMPLETE: Codex installed ${health.version} instead of ${INSTALL_VERSION}`,
      5,
      "PLUGIN_INSTALL_INCOMPLETE",
    );
  }
  return health;
}

function waitForInstalledPlugin() {
  let state;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    state = loadState();
    const health = installedPluginHealth(state);
    if (health.state === "healthy" && health.version === INSTALL_VERSION) return health;
    if (attempt < 9) Atomics.wait(installWait, 0, 0, 100);
  }
  return verifyInstalledPlugin(state);
}

function sameRuntimeContract(left, right) {
  return left.shellProtocolVersion === right.shellProtocolVersion &&
    left.toolContractVersion === right.toolContractVersion &&
    left.storageContractVersion === right.storageContractVersion;
}

function sameHostSurface(installedRoot) {
  try {
    return HOST_SURFACE_FILES.every((relative) =>
      normalizedHostSurface(installedRoot, relative)
        .equals(normalizedHostSurface(PLUGIN_ROOT, relative)));
  } catch {
    return false;
  }
}

function assertCompatibleHotUpgrade(beforeHealth) {
  if (!sameRuntimeContract(beforeHealth.descriptor, SOURCE_RUNTIME)) {
    throw new InstallError(
      `HOST_RELOAD_REQUIRED: the update changes a Router shell, tool, or storage contract; fully exit Codex Desktop and other Codex sessions, run "codex plugin add ${PLUGIN_ID}" from a fresh terminal, then start a genuinely new non-forked task`,
      6,
      "HOST_RELOAD_REQUIRED",
    );
  }
  if (!sameLiveCompatibility(beforeHealth.compatibility, SOURCE_COMPATIBILITY)) {
    throw new InstallError(
      `HOST_RELOAD_REQUIRED: the update changes the Router live workflow or stdio bridge contract; fully exit Codex Desktop and other Codex sessions, run "codex plugin add ${PLUGIN_ID}" from a fresh terminal, review Hooks, then start a genuinely new non-forked task`,
      6,
      "HOST_RELOAD_REQUIRED",
    );
  }
  if (!sameHostSurface(beforeHealth.root)) {
    throw new InstallError(
      `HOST_RELOAD_REQUIRED: the update changes Router MCP registration, Hooks, or Skill instructions and cannot preserve the current Desktop task tool inventory; fully exit Codex Desktop and other Codex sessions, run "codex plugin add ${PLUGIN_ID}" from a fresh terminal, review Hooks, then start a genuinely new non-forked task`,
      6,
      "HOST_RELOAD_REQUIRED",
    );
  }
  if (compareRuntimeVersions(INSTALL_VERSION, beforeHealth.version) < 0) {
    throw new InstallError(
      "HOT_UPGRADE_REJECTED: the installed runtime version did not advance monotonically",
      5,
      "HOT_UPGRADE_REJECTED",
    );
  }
}

function stageCompatibleRuntime(beforeHealth) {
  assertCompatibleHotUpgrade(beforeHealth);
  if (beforeHealth.version === INSTALL_VERSION) return beforeHealth;
  const versionsRoot = dirname(beforeHealth.root);
  const targetRoot = resolve(versionsRoot, INSTALL_VERSION);
  if (dirname(targetRoot) !== versionsRoot) {
    throw new InstallError(
      "HOT_UPGRADE_STAGE_FAILED: the target runtime directory is invalid",
      5,
      "HOT_UPGRADE_STAGE_FAILED",
    );
  }
  if (existsSync(targetRoot)) {
    const existing = runtimeHealthAtRoot(targetRoot);
    if (
      existing?.version === INSTALL_VERSION &&
      sameRuntimeContract(existing.descriptor, SOURCE_RUNTIME) &&
      sameLiveCompatibility(existing.compatibility, SOURCE_COMPATIBILITY)
    ) {
      materializeLaunchCommands(targetRoot);
      return { state: "healthy", ...existing };
    }
    throw new InstallError(
      "HOT_UPGRADE_STAGE_FAILED: the immutable target runtime already exists but is incomplete or inconsistent",
      5,
      "HOT_UPGRADE_STAGE_FAILED",
    );
  }
  const temporaryContainer = join(
    versionsRoot,
    `.stage-${process.pid}-${randomBytes(5).toString("hex")}`,
  );
  const temporaryRoot = join(temporaryContainer, INSTALL_VERSION);
  try {
    mkdirSync(temporaryContainer, { mode: 0o700 });
    cpSync(PLUGIN_ROOT, temporaryRoot, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    });
    materializeLaunchCommands(temporaryRoot);
    const staged = runtimeHealthAtRoot(temporaryRoot);
    if (
      staged?.version !== INSTALL_VERSION ||
      !sameRuntimeContract(staged.descriptor, SOURCE_RUNTIME) ||
      !sameLiveCompatibility(staged.compatibility, SOURCE_COMPATIBILITY)
    ) {
      throw new Error("staged runtime failed integrity validation");
    }
    verifyInstalledToolContract(staged, INSTALL_VERSION);
    verifyInstalledHookContract(staged);
    verifyInstalledStdioBridge(staged);
    renameSync(temporaryRoot, targetRoot);
    rmSync(temporaryContainer, { recursive: true, force: true });
    return { state: "healthy", ...runtimeHealthAtRoot(targetRoot) };
  } catch {
    rmSync(temporaryContainer, { recursive: true, force: true });
    const concurrent = runtimeHealthAtRoot(targetRoot);
    if (
      concurrent?.version === INSTALL_VERSION &&
      sameRuntimeContract(concurrent.descriptor, SOURCE_RUNTIME) &&
      sameLiveCompatibility(concurrent.compatibility, SOURCE_COMPATIBILITY)
    ) {
      materializeLaunchCommands(targetRoot);
      return { state: "healthy", ...concurrent };
    }
    throw new InstallError(
      "HOT_UPGRADE_STAGE_FAILED: the compatible runtime could not be staged without invoking Codex plugin re-registration",
      5,
      "HOT_UPGRADE_STAGE_FAILED",
    );
  }
}

function verifyMcpRegistration(afterHealth, acceptableRoots = [afterHealth.root]) {
  const servers = codex(["mcp", "list", "--json"], { json: true, quiet: true });
  const router = Array.isArray(servers)
    ? servers.find((entry) => entry?.name === "adaptive-model-router")
    : null;
  const transport = router?.transport;
  const cwd = typeof transport?.cwd === "string" ? resolve(transport.cwd) : null;
  let configured;
  try {
    configured = cwd && acceptableRoots.includes(cwd) ? mcpConfigAtRoot(cwd).server : null;
  } catch {}
  if (
    !router?.enabled ||
    transport?.type !== "stdio" ||
    !configured ||
    configured.command === "node" ||
    !isNodeCommand(configured.command) ||
    transport?.command !== configured.command ||
    JSON.stringify(transport?.args) !== JSON.stringify(configured.args) ||
    !acceptableRoots.includes(cwd)
  ) {
    throw new InstallError(
      "MCP_REGISTRATION_INCOMPLETE: Codex did not register the installed Adaptive Model Router MCP for new tasks",
      5,
      "MCP_REGISTRATION_INCOMPLETE",
    );
  }
}

function verifyInstalledToolContract(shellHealth, expectedRuntimeVersion = shellHealth.version) {
  const temporary = mkdtempSync(join(tmpdir(), "adaptive-router-installed-tools-"));
  try {
    const mcp = mcpConfigAtRoot(shellHealth.root).server;
    if (mcp.command === "node" || !isNodeCommand(mcp.command)) {
      throw new Error("installed MCP command is not materialized");
    }
    const input = [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "diagnose_router", arguments: { contextId: "installer-runtime-probe" } },
      }),
    ].join("\n");
    const result = spawnSync(mcp.command, mcp.args, {
      cwd: shellHealth.root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: "",
        ADAPTIVE_ROUTER_HOME: temporary,
        ADAPTIVE_ROUTER_LOCAL_ONLY: "1",
      },
      input: `${input}\n`,
      timeout: 15_000,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) throw new Error("installed MCP process failed");
    const responses = result.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    const names = responses.find((entry) => entry?.id === 2)?.result?.tools?.map((tool) => tool.name);
    const diagnosis = responses.find((entry) => entry?.id === 3)?.result;
    if (!Array.isArray(names) || REQUIRED_TASK_TOOLS.some((tool) => !names.includes(tool))) {
      throw new Error("installed MCP tool contract is incomplete");
    }
    if (
      diagnosis?.isError ||
      diagnosis?.structuredContent?.runtime?.runtimeVersion !== expectedRuntimeVersion
    ) {
      const observed = diagnosis?.structuredContent?.runtime?.runtimeVersion || "unavailable";
      throw new Error(`pinned MCP shell runtime ${observed} did not match ${expectedRuntimeVersion}`);
    }
  } catch (error) {
    const detail = [
      "installed MCP process failed",
      "installed MCP tool contract is incomplete",
      "installed MCP command is not materialized",
    ].includes(error?.message) || /^pinned MCP shell runtime [^ ]+ did not match [^ ]+$/u.test(error?.message)
      ? `: ${error.message}`
      : "";
    throw new InstallError(
      `MCP_TOOL_CONTRACT_INCOMPLETE: the installed Router MCP verification failed${detail}`,
      5,
      "MCP_TOOL_CONTRACT_INCOMPLETE",
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function verifyInstalledHookContract(shellHealth) {
  const temporary = mkdtempSync(join(tmpdir(), "adaptive-router-installed-hook-"));
  try {
    const config = hookConfigAtRoot(shellHealth.root);
    const field = process.platform === "win32" ? "commandWindows" : "command";
    for (const { handler } of config.handlers) {
      const parsed = parsedCommandExecutable(handler[field]);
      if (
        parsed.executable === "node" ||
        !isAbsolute(parsed.executable) ||
        !existsSync(parsed.executable)
      ) {
        throw new Error("installed Hook command is not materialized");
      }
    }
    const promptHook = config.handlers.find(({ event }) => event === "UserPromptSubmit").handler;
    const command = promptHook[field];
    const shell = process.platform === "win32"
      ? {
          executable: join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"),
          args: ["/d", "/s", "/c", `"${command}"`],
          windowsVerbatimArguments: true,
        }
      : { executable: "/bin/sh", args: ["-c", command], windowsVerbatimArguments: false };
    const result = spawnSync(shell.executable, shell.args, {
      cwd: shellHealth.root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: "",
        PLUGIN_ROOT: shellHealth.root,
        PLUGIN_DATA: temporary,
        ADAPTIVE_ROUTER_LOCAL_ONLY: "1",
      },
      input: JSON.stringify({
        cwd: shellHealth.root,
        session_id: "installer-hook-probe",
        model: "gpt-5.6-sol",
        prompt: "router: global on",
      }),
      timeout: 15_000,
      windowsHide: true,
      windowsVerbatimArguments: shell.windowsVerbatimArguments,
    });
    if (result.error || result.status !== 0) throw new Error("installed Hook process failed");
    const output = JSON.parse(result.stdout);
    if (!/already been applied atomically by the trusted UserPromptSubmit hook/iu.test(
      output?.hookSpecificOutput?.additionalContext || "",
    )) {
      throw new Error("installed Hook output contract is incomplete");
    }
  } catch (error) {
    const detail = [
      "installed Hook command is not materialized",
      "installed Hook process failed",
      "installed Hook output contract is incomplete",
    ].includes(error?.message) ? `: ${error.message}` : "";
    throw new InstallError(
      `HOOK_CONTRACT_INCOMPLETE: the installed Router Hook verification failed${detail}`,
      5,
      "HOOK_CONTRACT_INCOMPLETE",
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function verifyInstalledStdioBridge(shellHealth) {
  const temporary = mkdtempSync(join(tmpdir(), "adaptive-router-installed-bridge-"));
  try {
    const result = spawnSync(process.execPath, [join(shellHealth.root, "scripts", "stdio-tool.mjs")], {
      cwd: shellHealth.root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: "",
        ADAPTIVE_ROUTER_HOME: temporary,
        ADAPTIVE_ROUTER_LOCAL_ONLY: "1",
      },
      input: JSON.stringify({
        name: "route_stage",
        arguments: {
          goal: "installed stdio bridge verification",
          phase: "verification",
          evidence: {
            workProduct: false,
            requirementsSettled: true,
            strongVerification: true,
            hostCanDelegate: false,
          },
          contextId: "installer-stdio-bridge-probe",
        },
      }),
      timeout: 20_000,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) throw new Error("installed stdio bridge failed");
    const output = JSON.parse(result.stdout);
    if (
      output?.transport !== "stdio-bridge" ||
      output?.tool !== "route_stage" ||
      output?.isError ||
      typeof output?.structuredContent?.routeId !== "string"
    ) {
      throw new Error("installed stdio bridge contract is incomplete");
    }
  } catch (error) {
    const detail = [
      "installed stdio bridge failed",
      "installed stdio bridge contract is incomplete",
    ].includes(error?.message) ? `: ${error.message}` : "";
    throw new InstallError(
      `STDIO_BRIDGE_INCOMPLETE: the installed old-task Router bridge verification failed${detail}`,
      5,
      "STDIO_BRIDGE_INCOMPLETE",
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function verifyTaskTools() {
  try {
    run(process.execPath, [join(PLUGIN_ROOT, "scripts", "verify-task-tools.mjs")], { quiet: true });
  } catch {
    throw new InstallError(
      "TASK_TOOL_EXPOSURE_MISSING: a disposable Codex CLI task could not use the installed Router tools; trust the current plugin Hooks and retry",
      7,
      "TASK_TOOL_EXPOSURE_MISSING",
    );
  }
}

function addPluginWithIntegrityCheck(beforeState, { verifyTaskToolExposure = false } = {}) {
  const beforeHealth = installedPluginHealth(beforeState);
  try {
    codex(["plugin", "add", PLUGIN_ID]);
  } catch (error) {
    if (error?.errorCode === "CACHE_LOCKED") {
      try {
        const afterHealth = installedPluginHealth(loadState());
        if (
          ["damaged", "unverifiable"].includes(afterHealth.state) ||
          (beforeHealth.state !== "missing" && ["missing", "unverifiable"].includes(afterHealth.state))
        ) {
          throw new InstallError(
            "CACHE_DAMAGED: RECOVERY_REQUIRED: plugin replacement failed after the existing Adaptive Model Router cache became incomplete; fully exit Codex and reinstall the exact reviewed ref",
            5,
            "CACHE_DAMAGED",
          );
        }
      } catch (inspectionError) {
        if (inspectionError?.errorCode === "CACHE_DAMAGED") throw inspectionError;
        throw new InstallError(
          "CACHE_DAMAGED: RECOVERY_REQUIRED: plugin replacement failed and the resulting cache state could not be verified; fully exit Codex and reinstall the exact reviewed ref",
          5,
          "CACHE_DAMAGED",
        );
      }
    }
    throw error;
  }
  const afterHealth = waitForInstalledPlugin();
  materializeLaunchCommands(afterHealth.root);
  refreshLiveBridgeFiles(afterHealth.root);
  installDesktopNodeBridge();
  verifyMcpRegistration(afterHealth);
  verifyInstalledToolContract(afterHealth);
  verifyInstalledHookContract(afterHealth);
  verifyInstalledStdioBridge(afterHealth);
  if (verifyTaskToolExposure) verifyTaskTools();
  return afterHealth;
}

function hotUpgradeWithIntegrityCheck(beforeHealth, { verifyTaskToolExposure = false } = {}) {
  assertCompatibleHotUpgrade(beforeHealth);
  const roots = compatibleRuntimeRoots(beforeHealth.root);
  const runtimeSnapshots = snapshotRuntimeShells(roots);
  const desktopDirectory = defaultDesktopOverrideDirectory();
  const desktopSnapshot = desktopDirectory
    ? snapshotFile(desktopNodeBridgePath(desktopDirectory))
    : null;
  const targetRoot = resolve(dirname(beforeHealth.root), INSTALL_VERSION);
  const targetExisted = existsSync(targetRoot);
  const existingTarget = targetExisted ? runtimeHealthAtRoot(targetRoot) : null;
  const expectedRuntimeVersion =
    existingTarget?.version === INSTALL_VERSION &&
    sameRuntimeContract(existingTarget.descriptor, SOURCE_RUNTIME) &&
    sameLiveCompatibility(existingTarget.compatibility, SOURCE_COMPATIBILITY)
      ? INSTALL_VERSION
      : beforeHealth.version;
  try {
    installDesktopNodeBridge({ required: rootRequiresDesktopNodeBridge(beforeHealth.root) });
    for (const root of roots) {
      materializeLaunchCommands(root);
      refreshLiveBridgeFiles(root);
    }
    verifyMcpRegistration(beforeHealth, roots);
    verifyInstalledToolContract(beforeHealth, expectedRuntimeVersion);
    verifyInstalledHookContract(beforeHealth);
    verifyInstalledStdioBridge(beforeHealth);
    if (verifyTaskToolExposure) verifyTaskTools();
    return stageCompatibleRuntime(beforeHealth);
  } catch (error) {
    try {
      if (!targetExisted) rmSync(targetRoot, { recursive: true, force: true });
      restoreSnapshots(runtimeSnapshots);
      if (desktopSnapshot) restoreFile(desktopSnapshot);
    } catch {
      throw new InstallError(
        "HOT_UPGRADE_ROLLBACK_FAILED: verification failed and the installer could not restore every compatibility-surface file; stop Router processes and repair from the reviewed candidate before continuing",
        5,
        "HOT_UPGRADE_ROLLBACK_FAILED",
      );
    }
    throw error;
  }
}

function canonicalRepository(source) {
  if (typeof source !== "string") return null;
  let normalized = source.trim().toLowerCase().replaceAll("\\", "/");
  normalized = normalized.replace(/^git\+/, "");
  normalized = normalized.replace(/^https?:\/\/(?:www\.)?github\.com\//, "");
  normalized = normalized.replace(/^ssh:\/\/git@github\.com\//, "");
  normalized = normalized.replace(/^git@github\.com:/, "");
  normalized = normalized.replace(/^github\.com\//, "");
  normalized = normalized.replace(/\.git\/?$/, "").replace(/\/+$/, "");
  return normalized;
}

function marketplaceSource(entry) {
  return entry?.marketplaceSource?.source || entry?.source;
}

function marketplaceRef(entry) {
  const explicit = [
    entry?.ref,
    entry?.refName,
    entry?.ref_name,
    entry?.marketplaceSource?.ref,
    entry?.marketplaceSource?.refName,
    entry?.marketplaceSource?.ref_name,
  ].find((value) => typeof value === "string" && value.length > 0);
  if (explicit) return explicit;

  if (typeof entry?.root !== "string" || entry.root.length === 0) return null;
  try {
    const metadata = JSON.parse(readFileSync(join(entry.root, ".codex-marketplace-install.json"), "utf8"));
    if (canonicalRepository(metadata.source) !== REPOSITORY.toLowerCase()) return null;
    const metadataRef = [metadata.ref, metadata.refName, metadata.ref_name]
      .find((value) => typeof value === "string" && value.length > 0) || null;
    if (metadataRef) return metadataRef;
  } catch {}

  let gitDirectory = join(entry.root, ".git");
  try {
    const gitFile = readFileSync(gitDirectory, "utf8");
    const match = /^gitdir:\s*(.+)\s*$/i.exec(gitFile);
    if (!match) return null;
    gitDirectory = resolve(entry.root, match[1]);
  } catch {}
  try {
    const head = readFileSync(join(gitDirectory, "HEAD"), "utf8").trim();
    return /^ref:\s+refs\/heads\/(.+)$/.exec(head)?.[1] || null;
  } catch {
    return null;
  }
}

function desiredMarketplace(entry, ref = DEFAULT_REF) {
  return localRepositoryMarketplace(entry) || (
    canonicalRepository(marketplaceSource(entry)) === REPOSITORY.toLowerCase() &&
    marketplaceRef(entry) === ref
  );
}

function localRepositoryMarketplace(entry) {
  const source = marketplaceSource(entry);
  if (entry?.marketplaceSource?.sourceType !== "local" || typeof source !== "string") return false;
  const actual = resolve(source);
  if (process.platform === "win32") return actual.toLowerCase() === REPOSITORY_ROOT.toLowerCase();
  return actual === REPOSITORY_ROOT;
}

function codexHome() {
  return process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), ".codex");
}

function agentsPath() {
  return join(codexHome(), "AGENTS.md");
}

const AGENTS_INSTRUCTION = "When adaptive routing context is present and route_stage returns action=delegate, the applicable router skill explicitly authorizes and requires exactly one bounded subagent under conditional policies that allow skill-requested delegation; this action is not a suggestion. Use the returned model and reasoning effort, keep the root task as orchestrator, avoid overlapping writers, never silently continue the delegated stage in the root task or ask the user to re-authorize it, verify the delegated work, and record exactly one final outcome. Only an actual host-tool rejection enters the documented failed/tooling flow.";
const AGENTS_RESTORE_PATTERN = /<!-- adaptive-model-router:restore separator=([012]) created=([01]) -->/;

function agentsBlock({ separatorLength, created }) {
  return `${AGENTS_MARKER_START}\n` +
    `<!-- adaptive-model-router:restore separator=${separatorLength} created=${created ? 1 : 0} -->\n` +
    `${AGENTS_INSTRUCTION}\n` +
    `${AGENTS_MARKER_END}`;
}

function markerState(path = agentsPath()) {
  const exists = existsSync(path);
  const content = exists ? readFileSync(path, "utf8") : "";
  const starts = content.split(AGENTS_MARKER_START).length - 1;
  const ends = content.split(AGENTS_MARKER_END).length - 1;
  if (starts !== ends || starts > 1) throw new InstallError("AGENTS.md contains partial or duplicate Adaptive Model Router markers", 6);
  return { path, content, exists, present: starts === 1 };
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.adaptive-router-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function patchAgents(state = markerState()) {
  if (state.present) return false;
  const separator = state.content.length === 0 ? "" : state.content.endsWith("\n") ? "\n" : "\n\n";
  const block = agentsBlock({ separatorLength: separator.length, created: !state.exists });
  atomicWrite(state.path, `${state.content}${separator}${block}\n`);
  return true;
}

function unpatchAgents(state = markerState()) {
  if (!state.present) return false;
  const start = state.content.indexOf(AGENTS_MARKER_START);
  const end = state.content.indexOf(AGENTS_MARKER_END, start) + AGENTS_MARKER_END.length;
  const ownedBlock = state.content.slice(start, end);
  const metadata = AGENTS_RESTORE_PATTERN.exec(ownedBlock);
  if (!metadata) {
    const updated = `${state.content.slice(0, start)}${state.content.slice(end)}`;
    atomicWrite(state.path, updated);
    return true;
  }

  const separatorLength = Number(metadata[1]);
  const created = metadata[2] === "1";
  const removeStart = start - separatorLength;
  const expectedSeparator = "\n".repeat(separatorLength);
  if (removeStart < 0 || state.content.slice(removeStart, start) !== expectedSeparator) {
    throw new InstallError("AGENTS.md owned block restore metadata does not match its boundary", 6);
  }

  const removeEnd = state.content[end] === "\n" ? end + 1 : end;
  const prefix = state.content.slice(0, removeStart);
  const suffix = state.content.slice(removeEnd);
  const joiner = separatorLength === 2 && prefix.length > 0 && suffix.length > 0 ? "\n" : "";
  const updated = `${prefix}${joiner}${suffix}`;
  if (created && updated.length === 0) unlinkSync(state.path);
  else atomicWrite(state.path, updated);
  return true;
}

async function confirmLegacy(args) {
  if (args.yes) return true;
  if (args.nonInteractive || !process.stdin.isTTY || !process.stdout.isTTY) return false;
  const { createInterface } = await import("node:readline/promises");
  const interfaceHandle = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await interfaceHandle.question("Remove the legacy adaptive-local installation and continue? [y/N] ");
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    interfaceHandle.close();
  }
}

function printLegacyCleanup() {
  process.stderr.write("Legacy adaptive-local installation detected. No changes were made. Run:\n");
  process.stderr.write(`codex plugin remove ${LEGACY_PLUGIN_ID}\n`);
  process.stderr.write(`codex plugin marketplace remove ${LEGACY_MARKETPLACE}\n`);
}

async function installOrUpgrade(args, state) {
  const currentMarketplace = state.marketplaces.find((entry) => entryName(entry) === MARKETPLACE);
  if (currentMarketplace && !desiredMarketplace(currentMarketplace, args.ref)) {
    throw new InstallError("marketplace name adaptive-model-router is already configured from a different source or ref", 4);
  }
  const legacyInstalled = state.installed.some((entry) => pluginId(entry) === LEGACY_PLUGIN_ID);
  if (legacyInstalled) {
    if (!await confirmLegacy(args)) {
      printLegacyCleanup();
      throw new InstallError("legacy migration requires explicit confirmation", 3);
    }
    codex(["plugin", "remove", LEGACY_PLUGIN_ID]);
    if (state.marketplaces.some((entry) => entryName(entry) === LEGACY_MARKETPLACE)) {
      codex(["plugin", "marketplace", "remove", LEGACY_MARKETPLACE]);
    }
  }
  if (!currentMarketplace) codex(["plugin", "marketplace", "add", REPOSITORY, "--ref", args.ref]);
  else if (!localRepositoryMarketplace(currentMarketplace)) {
    codex(["plugin", "marketplace", "upgrade", MARKETPLACE]);
  }
  const beforeHealth = installedPluginHealth(state);
  const hotUpgrade = beforeHealth.state === "healthy";
  if (hotUpgrade) {
    hotUpgradeWithIntegrityCheck(beforeHealth, { verifyTaskToolExposure: args.verifyTaskTools });
  } else {
    addPluginWithIntegrityCheck(state, { verifyTaskToolExposure: args.verifyTaskTools });
  }
  if (args.patchAgents) patchAgents();
  if (hotUpgrade) {
    process.stdout.write(
      `Adaptive Model Router runtime ${INSTALL_VERSION} was staged and activated without invoking Codex plugin re-registration.\n`,
    );
    process.stdout.write("Existing tasks that still expose Router tools keep their host tool inventory.\n");
  } else {
    process.stdout.write(`Adaptive Model Router ${INSTALL_VERSION} is installed and its MCP is registered for new tasks.\n`);
  }
  if (args.verifyTaskTools) {
    process.stdout.write(`A disposable Codex CLI task completed live ${LIVE_TASK_SMOKE_TOOLS.join(", ")} calls.\n`);
  } else {
    process.stdout.write("Task-level MCP exposure was not exercised; after Hook trust, rerun with --verify-task-tools for the logged-in smoke.\n");
  }
  process.stdout.write("Tasks whose host tool inventory was already frozen use the verified stdio bridge on their next routed stage; no replacement task is required.\n");
  process.stdout.write("When Codex reports changed Hook definitions, review and trust those exact definitions before using Router controls.\n");
  process.stdout.write("Compatible v0.4.x+ runtime-only updates activate on the next Hook or MCP call without reopening an existing task.\n");
  process.stdout.write('To opt into automatic routing for all local projects, send "router: global on" once; upgrades preserve this setting.\n');
}

function uninstall(args, state) {
  const currentMarketplace = state.marketplaces.find((entry) => entryName(entry) === MARKETPLACE);
  if (currentMarketplace && !desiredMarketplace(currentMarketplace, args.ref)) {
    throw new InstallError("refusing to remove a same-name marketplace from a different source", 4);
  }
  if (state.installed.some((entry) => pluginId(entry) === PLUGIN_ID)) codex(["plugin", "remove", PLUGIN_ID]);
  if (currentMarketplace) codex(["plugin", "marketplace", "remove", MARKETPLACE]);
  removeDesktopNodeBridge();
  unpatchAgents();
  process.stdout.write("Adaptive Model Router is uninstalled. Project learning data was left intact.\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  preflight();
  if (args.patchAgents || args.action === "uninstall") markerState();
  const state = loadState();
  if (args.action === "uninstall") uninstall(args, state);
  else await installOrUpgrade(args, state);
}

main().catch((error) => {
  const message = sanitizedError(error, "installation failed");
  process.stderr.write(`adaptive-model-router installer: ${message}\n`);
  process.exitCode = error?.exitCode || 2;
});
