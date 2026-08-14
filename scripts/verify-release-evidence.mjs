#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const validator = join(scriptRoot, "validate-smoke-evidence.mjs");
const repository = "Neil0619/adaptive-model-router";
const oneTimeWindowsBypassTag = "v0.4.0";
const oneTimeWindowsBypassWarning = "EVIDENCE_INVALIDATED_BY_CONTINUITY_GATE";
const oneTimeWindowsWaiverPath = "docs/release-waivers/v0.4.0-windows-native.json";
const retainedWindowsEvidencePath = "docs/release-evidence/v0.4.0/windows.json";
const requiredWaiverRisks = Object.freeze([
  "DESKTOP_REDUCED_PATH_UNVERIFIED",
  "NATIVE_FILE_LOCKING_UNVERIFIED",
  "OLD_TASK_STDIO_BRIDGE_UNVERIFIED",
]);
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
  `:(exclude)${oneTimeWindowsWaiverPath}`,
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
  const parsed = { expectedRef: null, windowsWaiverPath: null, evidencePaths: [] };
  for (const value of values) {
    if (value.startsWith("--expected-ref=")) parsed.expectedRef = value.slice(15);
    else if (value.startsWith("--temporary-windows-waiver=")) {
      parsed.windowsWaiverPath = resolve(value.slice("--temporary-windows-waiver=".length));
    } else if (value.startsWith("--")) fail(`unknown argument ${value}`);
    else parsed.evidencePaths.push(resolve(value));
  }
  if (
    !parsed.expectedRef ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(parsed.expectedRef) ||
    parsed.expectedRef.includes("..") ||
    parsed.evidencePaths.length !== 2
  ) {
    fail("usage: verify-release-evidence.mjs --expected-ref=REF [--temporary-windows-waiver=FILE] WINDOWS.json MACOS.json");
  }
  return parsed;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(`${label} has an unexpected contract shape`);
}

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function validateOneTimeWindowsWaiver(path, { candidateCommit, expectedRef, pluginTreeSha256, windowsPath }) {
  if (path === null) return false;
  const relativePath = relative(realpathSync(process.cwd()), realpathSync(path)).replaceAll("\\", "/");
  if (relativePath !== oneTimeWindowsWaiverPath) {
    fail(`the native Windows exception requires ${oneTimeWindowsWaiverPath}`);
  }
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_REPOSITORY !== repository ||
    process.env.GITHUB_REF_TYPE !== "tag" ||
    process.env.GITHUB_REF_NAME !== oneTimeWindowsBypassTag
  ) {
    fail("the native Windows exception is valid only in the official v0.4.0 GitHub tag workflow");
  }
  const waiver = JSON.parse(readFileSync(path, "utf8"));
  exactKeys(waiver, [
    "schemaVersion", "releaseTag", "gate", "scope", "authorizedAt", "authorizedBy",
    "reasonCode", "candidate", "retainedEvidence", "riskAcknowledgements", "futureReleaseReuse",
  ], "Windows waiver");
  exactKeys(waiver.candidate, ["ref", "commitSha", "pluginTreeSha256"], "Windows waiver candidate");
  exactKeys(waiver.retainedEvidence, ["path", "sha256", "status"], "Windows waiver retainedEvidence");
  if (
    waiver.schemaVersion !== 1 ||
    waiver.releaseTag !== oneTimeWindowsBypassTag ||
    waiver.gate !== "windows-native" ||
    waiver.scope !== "same-task-continuity" ||
    waiver.authorizedBy !== "Neil0619" ||
    waiver.reasonCode !== "WINDOWS_NATIVE_SAME_TASK_SMOKE_DEFERRED" ||
    waiver.futureReleaseReuse !== false ||
    Number.isNaN(Date.parse(waiver.authorizedAt)) ||
    waiver.candidate.ref !== expectedRef ||
    waiver.candidate.commitSha !== candidateCommit ||
    waiver.candidate.pluginTreeSha256 !== pluginTreeSha256 ||
    waiver.retainedEvidence.path !== retainedWindowsEvidencePath ||
    waiver.retainedEvidence.status !== "FAIL" ||
    waiver.retainedEvidence.sha256 !== fileSha256(windowsPath) ||
    JSON.stringify(waiver.riskAcknowledgements) !== JSON.stringify(requiredWaiverRisks)
  ) {
    fail("the v0.4.0 native Windows waiver is invalid or does not bind the frozen candidate and retained FAIL evidence");
  }
  return true;
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
if (macos.candidate?.ref !== args.expectedRef) fail("macOS evidence does not bind the frozen candidate ref");
const candidateCommit = resolveRef(args.expectedRef);
const candidatePluginTreeSha256 = pluginTreeHash(candidateCommit);
const bypassWindows = validateOneTimeWindowsWaiver(args.windowsWaiverPath, {
  candidateCommit,
  expectedRef: args.expectedRef,
  pluginTreeSha256: candidatePluginTreeSha256,
  windowsPath: byGate.get("windows-native").path,
});
if (!bypassWindows && (
  windows.candidate?.ref !== args.expectedRef ||
  windows.candidate?.commitSha !== macos.candidate?.commitSha ||
  windows.candidate?.pluginTreeSha256 !== macos.candidate?.pluginTreeSha256
)) fail("native evidence does not bind one frozen candidate");
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
if (bypassWindows) {
  validateArtifact(byGate.get("windows-native").path);
  if (
    windows.status !== "FAIL" ||
    !windows.warnings?.includes(oneTimeWindowsBypassWarning)
  ) {
    fail(`the v0.4.0 Windows exception requires a retained FAIL artifact with ${oneTimeWindowsBypassWarning}`);
  }
} else {
  validateArtifact(byGate.get("windows-native").path, {
    expectedRef: args.expectedRef,
    expectedCommit: candidateCommit,
    requirePass: true,
  });
}
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

if (bypassWindows) {
  process.stdout.write(`WARNING: native Windows evidence bypass active for ${oneTimeWindowsBypassTag}; retained artifact status is FAIL.\n`);
}
process.stdout.write(`Release evidence valid for ${candidateCommit}.\n`);
