#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const validator = join(scriptRoot, "validate-smoke-evidence.mjs");
const releasePaths = Object.freeze([
  ".agents",
  ".github/workflows/release.yml",
  "plugins",
  "scripts",
  "docs",
  "README.md",
  "README.zh-CN.md",
  "CHANGELOG.md",
  "install.sh",
  "install.ps1",
  ":(exclude)docs/release-evidence/v0.4.0/**",
]);

function fail(message) {
  throw new Error(`release evidence verification failed: ${message}`);
}

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  });
  if (!allowFailure && (result.error || result.status !== 0)) fail("git inspection failed");
  return result;
}

function parseArgs(values) {
  const parsed = { expectedRef: null, evidencePaths: [] };
  for (const value of values) {
    if (value.startsWith("--expected-ref=")) parsed.expectedRef = value.slice(15);
    else if (value.startsWith("--")) fail(`unknown argument ${value}`);
    else parsed.evidencePaths.push(resolve(value));
  }
  if (
    !parsed.expectedRef ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(parsed.expectedRef) ||
    parsed.expectedRef.includes("..") ||
    parsed.evidencePaths.length !== 2
  ) {
    fail("usage: verify-release-evidence.mjs --expected-ref=REF WINDOWS.json MACOS.json");
  }
  return parsed;
}

function validateArtifact(path, { expectedRef = null, expectedCommit = null, requirePass = false } = {}) {
  const command = [validator, path];
  if (requirePass) command.push("--require-pass");
  if (expectedRef) command.push(`--expected-ref=${expectedRef}`);
  if (expectedCommit) command.push(`--expected-commit=${expectedCommit}`);
  const result = spawnSync(process.execPath, command, {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) fail("a native evidence artifact failed schema validation");
}

function resolveRef(ref) {
  for (const candidate of [`refs/remotes/origin/${ref}`, `refs/heads/${ref}`, ref]) {
    const result = git(["rev-parse", "--verify", `${candidate}^{commit}`], { allowFailure: true });
    const commit = result.status === 0 ? result.stdout.trim() : "";
    if (/^[0-9a-f]{40}$/u.test(commit)) return commit;
  }
  fail("the frozen candidate ref is unavailable");
}

function pluginTreeHash(commit) {
  const listing = git([
    "ls-tree",
    "-r",
    "--full-tree",
    commit,
    "plugins/adaptive-model-router",
  ]).stdout.replace(/\r\n?/gu, "\n");
  return createHash("sha256").update(listing, "utf8").digest("hex");
}

const args = parseArgs(process.argv.slice(2));
const evidence = args.evidencePaths.map((path) => JSON.parse(readFileSync(path, "utf8")));
const byGate = new Map(evidence.map((entry, index) => [entry.gate, { entry, path: args.evidencePaths[index] }]));
if (byGate.size !== 2 || !byGate.has("windows-native") || !byGate.has("macos-native")) {
  fail("both native platform gates are required exactly once");
}
const windows = byGate.get("windows-native").entry;
const macos = byGate.get("macos-native").entry;
const candidateCommit = resolveRef(args.expectedRef);
const candidatePluginTreeSha256 = pluginTreeHash(candidateCommit);
if (
  windows.candidate?.ref !== args.expectedRef ||
  macos.candidate?.ref !== args.expectedRef ||
  windows.candidate?.commitSha !== macos.candidate?.commitSha ||
  windows.candidate?.pluginTreeSha256 !== macos.candidate?.pluginTreeSha256
) fail("native evidence does not bind one frozen candidate");
if (candidateCommit !== macos.candidate.commitSha) {
  fail("the frozen candidate ref moved after evidence collection");
}
if (candidatePluginTreeSha256 !== macos.candidate.pluginTreeSha256) {
  fail("the candidate plugin tree hash differs from native evidence");
}
validateArtifact(byGate.get("macos-native").path, {
  expectedRef: args.expectedRef,
  expectedCommit: candidateCommit,
  requirePass: true,
});
validateArtifact(byGate.get("windows-native").path, {
  expectedRef: args.expectedRef,
  expectedCommit: candidateCommit,
  requirePass: true,
});
const diff = git([
  "diff",
  "--quiet",
  candidateCommit,
  "HEAD",
  "--",
  ...releasePaths,
], { allowFailure: true });
if (diff.error || ![0, 1].includes(diff.status)) fail("release-relevant tree comparison failed");
if (diff.status === 1) fail("release-relevant files differ from the smoked candidate");

process.stdout.write(`Release evidence valid for ${candidateCommit}.\n`);
