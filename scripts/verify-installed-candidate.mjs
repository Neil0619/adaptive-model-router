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

export function verifyInstalledCandidate({ marketplaceState, pluginState, identity, expectedRef, expectedCommit }) {
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
  const installed = (pluginState?.installed || []).filter((entry) => entry?.pluginId === PLUGIN_ID && entry?.enabled === true);
  if (installed.length !== 1 || installed[0].version !== VERSION) {
    fail("plugin is not installed and enabled at version 0.4.0");
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
    env: process.env,
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

async function main() {
  const { expectedRef, expectedCommit } = parseArgs(process.argv.slice(2));
  const marketplaceState = codexJson(["plugin", "marketplace", "list", "--json"]);
  const marketplace = (marketplaceState.marketplaces || []).filter((entry) => entry?.name === MARKETPLACE);
  if (marketplace.length !== 1 || typeof marketplace[0].root !== "string" || marketplace[0].root.length === 0) {
    fail("marketplace is missing or ambiguous");
  }
  const identity = await marketplaceIdentity(marketplace[0]);
  const pluginState = codexJson(["plugin", "list", "--available", "--json"]);
  verifyInstalledCandidate({ marketplaceState, pluginState, identity, expectedRef, expectedCommit });
  process.stdout.write("Installed candidate ref, revision, and plugin version verified.\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
