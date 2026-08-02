#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ID = "adaptive-model-router@adaptive-model-router";
const MARKETPLACE = "adaptive-model-router";
const VERSION = "0.4.0";

function fail(message) {
  throw new Error(`installed candidate invalid: ${message}`);
}

export function verifyInstalledCandidate({ marketplaceState, pluginState, metadata, expectedRef, expectedCommit }) {
  const marketplaces = (marketplaceState?.marketplaces || []).filter((entry) => entry?.name === MARKETPLACE);
  if (marketplaces.length !== 1 || typeof marketplaces[0].root !== "string" || marketplaces[0].root.length === 0) {
    fail("marketplace is missing or ambiguous");
  }
  if (metadata?.ref_name !== expectedRef || metadata?.revision !== expectedCommit) {
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
  const stdout = execFileSync("codex", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(stdout);
}

async function main() {
  const { expectedRef, expectedCommit } = parseArgs(process.argv.slice(2));
  const marketplaceState = codexJson(["plugin", "marketplace", "list", "--json"]);
  const marketplace = (marketplaceState.marketplaces || []).filter((entry) => entry?.name === MARKETPLACE);
  if (marketplace.length !== 1 || typeof marketplace[0].root !== "string" || marketplace[0].root.length === 0) {
    fail("marketplace is missing or ambiguous");
  }
  const metadata = JSON.parse(await readFile(join(marketplace[0].root, ".codex-marketplace-install.json"), "utf8"));
  const pluginState = codexJson(["plugin", "list", "--available", "--json"]);
  verifyInstalledCandidate({ marketplaceState, pluginState, metadata, expectedRef, expectedCommit });
  process.stdout.write("Installed candidate ref, revision, and plugin version verified.\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
