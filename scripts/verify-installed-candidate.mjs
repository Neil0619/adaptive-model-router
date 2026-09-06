#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveCodexCommandSync,
  spawnSpec,
} from "../plugins/adaptive-model-router/scripts/lib/codex-command.mjs";

const PLUGIN_ID = "adaptive-model-router@adaptive-model-router";
const MARKETPLACE = "adaptive-model-router";
const VERSION = "0.4.0";
const REPOSITORY = "neil0619/adaptive-model-router";
const VERSION_PATTERN = /^0\.4\.0(?:\+codex\.[0-9A-Za-z][0-9A-Za-z.-]*)?$/u;
const HOST_COMMAND_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

function fail(message) {
  throw new Error(`installed candidate invalid: ${message}`);
}

function canonicalRepository(source) {
  if (typeof source !== "string") return null;
  return source.trim().toLowerCase()
    .replaceAll("\\", "/")
    .replace(/^git\+/u, "")
    .replace(/^https?:\/\/(?:www\.)?github\.com\//u, "")
    .replace(/^ssh:\/\/git@github\.com\//u, "")
    .replace(/^git@github\.com:/u, "")
    .replace(/^github\.com\//u, "")
    .replace(/\.git\/?$/u, "")
    .replace(/\/+$/u, "");
}

export function verifyInstalledCandidate({
  marketplaceState,
  pluginState,
  mcpState,
  identity,
  expectedRef,
  expectedCommit,
  candidateVersion,
  runtimeManifestVersion,
}) {
  const marketplaces = (marketplaceState?.marketplaces || []).filter((entry) => entry?.name === MARKETPLACE);
  if (marketplaces.length !== 1 || typeof marketplaces[0].root !== "string" || marketplaces[0].root.length === 0) {
    fail("marketplace is missing or ambiguous");
  }
  const source = identity?.source || marketplaces[0]?.marketplaceSource?.source;
  if (canonicalRepository(source) !== REPOSITORY) {
    fail("marketplace source differs from the reviewed repository");
  }
  if (identity?.ref !== expectedRef || identity?.revision !== expectedCommit) {
    fail("marketplace ref or revision differs from the frozen candidate");
  }
  if (typeof candidateVersion !== "string" || !VERSION_PATTERN.test(candidateVersion)) {
    fail("candidate manifest version is invalid");
  }
  const candidateBaseVersion = candidateVersion.split("+", 1)[0];
  const installed = (pluginState?.installed || []).filter((entry) => entry?.pluginId === PLUGIN_ID && entry?.enabled === true);
  const reportedVersion = installed[0]?.version;
  if (
    installed.length !== 1 ||
    ![candidateVersion, candidateBaseVersion].includes(reportedVersion)
  ) {
    fail("installed plugin version differs from the frozen candidate manifest");
  }
  const routerMcp = (Array.isArray(mcpState) ? mcpState : []).filter((entry) =>
    entry?.name === "adaptive-model-router" &&
    entry?.enabled === true &&
    entry?.transport?.type === "stdio" &&
    typeof entry?.transport?.cwd === "string" &&
    entry.transport.cwd.length > 0
  );
  if (routerMcp.length !== 1) fail("the active Router MCP runtime is missing or ambiguous");
  if (runtimeManifestVersion !== candidateVersion) {
    fail("the active Router MCP cache version differs from the frozen candidate manifest");
  }
  return { marketplaceRoot: marketplaces[0].root };
}

function parseArgs(values) {
  let expectedRef = null;
  let expectedCommit = null;
  for (const value of values) {
    if (value.startsWith("--ref=")) expectedRef = value.slice(6);
    else if (value.startsWith("--commit=")) expectedCommit = value.slice(9);
    else fail("usage: verify-installed-candidate.mjs --ref=REF --commit=SHA");
  }
  if (!expectedRef || !/^[0-9a-f]{40}$/u.test(expectedCommit || "")) {
    fail("a candidate ref and full lowercase commit SHA are required");
  }
  return { expectedRef, expectedCommit };
}

function codexJson(args) {
  const spec = spawnSpec(resolveCodexCommandSync(), args);
  const stdout = execFileSync(spec.command, spec.args, {
    encoding: "utf8",
    maxBuffer: HOST_COMMAND_MAX_BUFFER_BYTES,
    env: spec.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
  });
  return JSON.parse(stdout);
}

function gitText(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

async function marketplaceIdentity(marketplace) {
  const metadataPath = join(marketplace.root, ".codex-marketplace-install.json");
  try {
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    return {
      source: metadata.source || marketplace?.marketplaceSource?.source,
      ref: metadata.ref || metadata.refName || metadata.ref_name,
      revision: metadata.revision,
    };
  } catch (error) {
    if (error?.code !== "ENOENT") fail("marketplace install metadata is unreadable");
  }
  try {
    return {
      source: gitText(marketplace.root, ["remote", "get-url", "origin"]),
      ref: gitText(marketplace.root, ["branch", "--show-current"]),
      revision: gitText(marketplace.root, ["rev-parse", "HEAD"]),
    };
  } catch {
    fail("marketplace checkout identity is unavailable");
  }
}

async function manifestVersion(pluginRoot, label) {
  try {
    const manifest = JSON.parse(await readFile(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
    if (typeof manifest.version !== "string") fail(`${label} manifest version is invalid`);
    return manifest.version;
  } catch (error) {
    if (String(error?.message || "").startsWith("installed candidate invalid:")) throw error;
    fail(`${label} manifest is unreadable`);
  }
}

async function main() {
  const { expectedRef, expectedCommit } = parseArgs(process.argv.slice(2));
  const marketplaceState = codexJson(["plugin", "marketplace", "list", "--json"]);
  const marketplace = (marketplaceState.marketplaces || []).filter((entry) => entry?.name === MARKETPLACE);
  if (marketplace.length !== 1 || typeof marketplace[0].root !== "string" || marketplace[0].root.length === 0) {
    fail("marketplace is missing or ambiguous");
  }
  const identity = await marketplaceIdentity(marketplace[0]);
  const pluginState = codexJson(["plugin", "list", "--available", "--json"]);
  const mcpState = codexJson(["mcp", "list", "--json"]);
  const candidatePluginRoot = join(marketplace[0].root, "plugins", "adaptive-model-router");
  const candidateVersion = await manifestVersion(candidatePluginRoot, "candidate");
  const routerMcp = (Array.isArray(mcpState) ? mcpState : []).filter((entry) =>
    entry?.name === "adaptive-model-router" &&
    entry?.enabled === true &&
    entry?.transport?.type === "stdio" &&
    typeof entry?.transport?.cwd === "string" &&
    entry.transport.cwd.length > 0
  );
  if (routerMcp.length !== 1) fail("the active Router MCP runtime is missing or ambiguous");
  const runtimeManifestVersion = await manifestVersion(routerMcp[0].transport.cwd, "active Router MCP cache");
  verifyInstalledCandidate({
    marketplaceState,
    pluginState,
    mcpState,
    identity,
    expectedRef,
    expectedCommit,
    candidateVersion,
    runtimeManifestVersion,
  });
  process.stdout.write("Installed candidate ref, revision, and plugin version verified.\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
