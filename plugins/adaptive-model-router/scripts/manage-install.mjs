#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  AGENTS_MARKER_END,
  AGENTS_MARKER_START,
  ROUTER_VERSION,
} from "./lib/constants.mjs";
import { spawnSpec } from "./lib/app-server.mjs";
import { sanitizedError } from "./lib/io.mjs";
import { assertRuntime } from "./lib/runtime.mjs";

const MARKETPLACE = "adaptive-model-router";
const PLUGIN_ID = "adaptive-model-router@adaptive-model-router";
const REPOSITORY = "Neil0619/adaptive-model-router";
const REF = "stable";
const LEGACY_MARKETPLACE = "adaptive-local";
const LEGACY_PLUGIN_ID = "adaptive-model-router@adaptive-local";

class InstallError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

function parseArgs(values) {
  const parsed = { action: "install", patchAgents: false, nonInteractive: false, yes: false };
  for (const value of values) {
    if (["install", "upgrade", "uninstall"].includes(value)) parsed.action = value;
    else if (value === "--patch-agents") parsed.patchAgents = true;
    else if (value === "--non-interactive") parsed.nonInteractive = true;
    else if (value === "--yes") parsed.yes = true;
    else throw new InstallError(`unknown installer argument: ${value}`, 2);
  }
  return parsed;
}

function codexExecutable() {
  return process.env.CODEX_BIN || "codex";
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
    env: process.env,
  });
  if (result.error || result.status !== 0) {
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
  return { marketplaces, installed: plugins.installed || [], available: plugins.available || [] };
}

function entryName(entry) {
  return entry.name || entry.marketplaceName;
}

function pluginId(entry) {
  return entry.pluginId || `${entry.name}@${entry.marketplaceName}`;
}

function desiredMarketplace(entry) {
  const serialized = JSON.stringify(entry).toLowerCase();
  const repositoryMatch = serialized.includes(REPOSITORY.toLowerCase()) ||
    serialized.includes(`github.com/${REPOSITORY.toLowerCase()}`);
  const refMatch = serialized.includes(`"${REF}"`) || serialized.includes(`ref=${REF}`) || serialized.includes(`/${REF}`);
  return repositoryMatch && refMatch;
}

function codexHome() {
  return process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), ".codex");
}

function agentsPath() {
  return join(codexHome(), "AGENTS.md");
}

const AGENTS_BLOCK = `${AGENTS_MARKER_START}\n` +
  "When adaptive routing context is present, route only bounded task stages to a subagent using the model and reasoning effort returned by route_stage. Keep the root task as orchestrator, avoid overlapping writers, verify the delegated work, and record exactly one final outcome.\n" +
  `${AGENTS_MARKER_END}`;

function markerState(path = agentsPath()) {
  const content = existsSync(path) ? readFileSync(path, "utf8") : "";
  const starts = content.split(AGENTS_MARKER_START).length - 1;
  const ends = content.split(AGENTS_MARKER_END).length - 1;
  if (starts !== ends || starts > 1) throw new InstallError("AGENTS.md contains partial or duplicate Adaptive Model Router markers", 6);
  return { path, content, present: starts === 1 };
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
  atomicWrite(state.path, `${state.content}${separator}${AGENTS_BLOCK}\n`);
  return true;
}

function unpatchAgents(state = markerState()) {
  if (!state.present) return false;
  const start = state.content.indexOf(AGENTS_MARKER_START);
  const end = state.content.indexOf(AGENTS_MARKER_END, start) + AGENTS_MARKER_END.length;
  const updated = `${state.content.slice(0, start)}${state.content.slice(end)}`;
  atomicWrite(state.path, updated);
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
  if (currentMarketplace && !desiredMarketplace(currentMarketplace)) {
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
  if (currentMarketplace) codex(["plugin", "marketplace", "upgrade", MARKETPLACE]);
  else codex(["plugin", "marketplace", "add", REPOSITORY, "--ref", REF]);
  codex(["plugin", "add", PLUGIN_ID]);
  if (args.patchAgents) patchAgents();
  process.stdout.write(`Adaptive Model Router ${ROUTER_VERSION} is installed.\n`);
  process.stdout.write("Trust the plugin hooks when Codex prompts, then start a new task.\n");
}

function uninstall(args, state) {
  const currentMarketplace = state.marketplaces.find((entry) => entryName(entry) === MARKETPLACE);
  if (currentMarketplace && !desiredMarketplace(currentMarketplace)) {
    throw new InstallError("refusing to remove a same-name marketplace from a different source", 4);
  }
  if (state.installed.some((entry) => pluginId(entry) === PLUGIN_ID)) codex(["plugin", "remove", PLUGIN_ID]);
  if (currentMarketplace) codex(["plugin", "marketplace", "remove", MARKETPLACE]);
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
