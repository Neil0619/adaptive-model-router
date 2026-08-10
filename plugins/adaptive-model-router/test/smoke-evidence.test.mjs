import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { temporaryProject } from "./fixtures.mjs";
import { verifyInstalledCandidate } from "../../../scripts/verify-installed-candidate.mjs";
import {
  filesMatchIgnoringLineEndings,
  normalizeLineEndings,
} from "../../../scripts/compare-gate-content.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const validator = join(repoRoot, "scripts", "validate-smoke-evidence.mjs");
const macosTemplate = join(repoRoot, "docs", "release-evidence", "templates", "macos-v1.json");
const requiredCheckIds = [
  "native-preflight",
  "candidate-frozen",
  "candidate-automated-gate",
  "native-install",
  "installed-candidate-integrity",
  "hook-trust-and-global-on",
  "route-subagent-outcome",
  "root-target-boundary",
  "capability-boundary",
  "redacted-observability",
  "learning-and-shadow",
  "host-model-intent",
  "negative-control",
  "native-and-wrapper-lifecycle",
  "cross-project-persistence",
  "final-state-settled",
];

test("release gate comparison ignores only line-ending transformations", async () => {
  assert.deepEqual(normalizeLineEndings(Buffer.from("one\r\ntwo\rthree\n")), Buffer.from("one\ntwo\nthree\n"));
  const project = await temporaryProject("adaptive gate comparison ");
  try {
    const lf = join(project.root, "gate-lf.txt");
    const crlf = join(project.root, "gate-crlf.txt");
    const changed = join(project.root, "gate-changed.txt");
    await writeFile(lf, "alpha\nbeta\n");
    await writeFile(crlf, "alpha\r\nbeta\r\n");
    await writeFile(changed, "alpha\r\nchanged\r\n");
    assert.equal(await filesMatchIgnoringLineEndings(lf, crlf), true);
    assert.equal(await filesMatchIgnoringLineEndings(lf, changed), false);
  } finally {
    await project.cleanup();
  }
});

function validEvidence() {
  return {
    schemaVersion: 1,
    gate: "windows-native",
    status: "PASS",
    generatedAt: "2026-08-02T12:00:00.000Z",
    candidate: {
      ref: "codex/windows-zero-approval-smoke-v9",
      commitSha: "a".repeat(40),
      pluginTreeSha256: "b".repeat(64),
    },
    environment: {
      platform: "windows",
      surface: "cli",
      osVersion: "Microsoft Windows NT 10.0.26100.0",
      codexVersion: "codex-cli 0.145.0",
      nodeVersion: "v24.18.0",
      gitVersion: "git version 2.45.1.windows.1",
    },
    permissions: {
      contract: "zero-approval-v1",
      hostProfile: "danger-full-access",
      hostApprovalPolicy: "never",
      managedApprovalPolicy: "never",
      managedSandboxMode: "read-only",
      approvalRequests: 0,
      sandboxEscalations: 0,
      permissionFailures: 0,
    },
    checks: requiredCheckIds.map((id) => ({ id, blocking: true, status: "PASS" })),
    route: {
      action: "delegate",
      targetFamily: "sol",
      targetEffort: "high",
      verificationGate: "structured-check",
      pendingOutcomes: 0,
      stopHookUnknown: 0,
    },
    diagnostics: { databaseHealth: "ok", classifierState: "closed", privacy: "PASS" },
    warnings: [],
  };
}

async function runEvidence(project, evidence, extra = []) {
  const output = join(project.root, "evidence", "windows.json");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  return { output, result: spawnSync(process.execPath, [validator, output, ...extra], { encoding: "utf8" }) };
}

test("smoke evidence validator accepts a strict redacted PASS and writes deterministic derivatives", async () => {
  const project = await temporaryProject("adaptive smoke evidence ");
  try {
    const { output, result } = await runEvidence(project, validEvidence(), ["--write-derivatives"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(await readFile(output.replace(/\.json$/u, ".md"), "utf8"), /route-subagent-outcome/u);
    const canonical = await readFile(output, "utf8");
    const expectedChecksum = `${createHash("sha256").update(canonical).digest("hex")}  windows.json\n`;
    assert.equal(await readFile(`${output}.sha256`, "utf8"), expectedChecksum);

    await writeFile(output, canonical.replaceAll("\n", "\r\n"));
    const crlfResult = spawnSync(process.execPath, [validator, output, "--write-derivatives"], { encoding: "utf8" });
    assert.equal(crlfResult.status, 0, crlfResult.stderr);
    assert.equal(await readFile(`${output}.sha256`, "utf8"), expectedChecksum);
  } finally {
    await project.cleanup();
  }
});

test("smoke evidence validator rejects path leaks and inconsistent PASS claims", async () => {
  const project = await temporaryProject("adaptive smoke evidence reject ");
  try {
    const leaked = validEvidence();
    leaked.environment.osVersion = "C:\\Users\\operator\\secret";
    const leakResult = await runEvidence(project, leaked);
    assert.notEqual(leakResult.result.status, 0);
    assert.match(leakResult.result.stderr, /absolute Windows/u);

    for (const path of ["/private/secret", "/Volumes/team/file", "/opt/company/config", "failure at /etc/secret"]) {
      const posixLeak = validEvidence();
      posixLeak.environment.osVersion = path;
      const posixLeakResult = await runEvidence(project, posixLeak);
      assert.notEqual(posixLeakResult.result.status, 0);
      assert.match(posixLeakResult.result.stderr, /absolute POSIX/u);
    }

    const inconsistent = validEvidence();
    inconsistent.route.pendingOutcomes = 1;
    const inconsistentResult = await runEvidence(project, inconsistent);
    assert.notEqual(inconsistentResult.result.status, 0);
    assert.match(inconsistentResult.result.stderr, /status disagrees/u);

    for (const counter of ["approvalRequests", "sandboxEscalations", "permissionFailures"]) {
      const permissionFailure = validEvidence();
      permissionFailure.permissions[counter] = 1;
      const permissionResult = await runEvidence(project, permissionFailure);
      assert.notEqual(permissionResult.result.status, 0);
      assert.match(permissionResult.result.stderr, /status disagrees.*permissions/u);
    }

    for (const [field, value] of [
      ["contract", "unavailable"],
      ["hostProfile", "unavailable"],
      ["hostApprovalPolicy", "unavailable"],
      ["managedApprovalPolicy", "unavailable"],
      ["managedSandboxMode", "unavailable"],
    ]) {
      const invalidPermission = validEvidence();
      invalidPermission.permissions[field] = value;
      const permissionResult = await runEvidence(project, invalidPermission);
      assert.notEqual(permissionResult.result.status, 0);
      assert.match(permissionResult.result.stderr, /status disagrees.*permissions/u);
    }

    const incomplete = validEvidence();
    incomplete.checks.pop();
    const incompleteResult = await runEvidence(project, incomplete);
    assert.notEqual(incompleteResult.result.status, 0);
    assert.match(incompleteResult.result.stderr, /too few items|complete canonical gate set/u);

    const uxWitness = validEvidence();
    uxWitness.uxWitness = { selectorObserved: true };
    const uxWitnessResult = await runEvidence(project, uxWitness);
    assert.notEqual(uxWitnessResult.result.status, 0);
    assert.match(uxWitnessResult.result.stderr, /contains additional field uxWitness/u);

    const schemaInvalidDate = validEvidence();
    schemaInvalidDate.generatedAt = "2026-08-02";
    const schemaInvalidDateResult = await runEvidence(project, schemaInvalidDate);
    assert.notEqual(schemaInvalidDateResult.result.status, 0);
    assert.match(schemaInvalidDateResult.result.stderr, /RFC 3339 date-time/u);

    const unknownGate = validEvidence();
    unknownGate.route.verificationGate = "invented-check";
    const unknownGateResult = await runEvidence(project, unknownGate);
    assert.notEqual(unknownGateResult.result.status, 0);
    assert.match(unknownGateResult.result.stderr, /schema enum|allowed value/u);

    const placeholder = validEvidence();
    placeholder.candidate.commitSha = "0".repeat(40);
    placeholder.environment.nodeVersion = "unavailable";
    const placeholderResult = await runEvidence(project, placeholder);
    assert.notEqual(placeholderResult.result.status, 0);
    assert.match(placeholderResult.result.stderr, /status disagrees/u);
  } finally {
    await project.cleanup();
  }
});

test("smoke evidence contract accepts macOS evidence and its checked-in FAIL template", async () => {
  const project = await temporaryProject("adaptive macos smoke evidence ");
  try {
    const macos = validEvidence();
    macos.gate = "macos-native";
    macos.environment.platform = "macos";
    macos.environment.osVersion = "macOS 15.6.1";
    const { result } = await runEvidence(project, macos, [
      "--expected-ref=codex/windows-zero-approval-smoke-v9",
      `--expected-commit=${"a".repeat(40)}`,
    ]);
    assert.equal(result.status, 0, result.stderr);

    const templateResult = spawnSync(process.execPath, [validator, macosTemplate], { encoding: "utf8" });
    assert.equal(templateResult.status, 0, templateResult.stderr);
    assert.match(templateResult.stdout, /macos-native FAIL/u);
  } finally {
    await project.cleanup();
  }
});

test("installed candidate verification binds repository, ref, revision, enabled state, and version", () => {
  const expectedCommit = "a".repeat(40);
  const marketplaceState = { marketplaces: [{ name: "adaptive-model-router", root: "/redacted/cache" }] };
  const pluginState = {
    installed: [{
      pluginId: "adaptive-model-router@adaptive-model-router",
      enabled: true,
      version: "0.4.0",
    }],
  };
  const identity = {
    source: "https://github.com/Neil0619/adaptive-model-router.git",
    ref: "codex/windows-zero-approval-smoke-v9",
    revision: expectedCommit,
  };
  assert.doesNotThrow(() => verifyInstalledCandidate({
    marketplaceState,
    pluginState,
    identity,
    expectedRef: "codex/windows-zero-approval-smoke-v9",
    expectedCommit,
  }));
  assert.throws(() => verifyInstalledCandidate({
    marketplaceState,
    pluginState,
    identity: { ...identity, revision: "b".repeat(40) },
    expectedRef: "codex/windows-zero-approval-smoke-v9",
    expectedCommit,
  }), /revision differs/u);
  assert.throws(() => verifyInstalledCandidate({
    marketplaceState,
    pluginState,
    identity: { ...identity, source: "https://github.com/example/other.git" },
    expectedRef: "codex/windows-zero-approval-smoke-v9",
    expectedCommit,
  }), /reviewed repository/u);
});

test("installed candidate CLI discovers Codex from PATH and verifies a git checkout without metadata", async () => {
  const project = await temporaryProject("adaptive installed verifier ");
  try {
    const marketplaceRoot = join(project.root, "marketplace checkout 中文");
    const bin = join(project.root, "fake verifier bin");
    await mkdir(marketplaceRoot, { recursive: true });
    await mkdir(bin, { recursive: true });
    assert.equal(spawnSync("git", ["init", "--initial-branch=codex/windows-zero-approval-smoke-v9", marketplaceRoot], { encoding: "utf8" }).status, 0);
    assert.equal(spawnSync("git", ["-C", marketplaceRoot, "config", "user.email", "smoke@example.invalid"], { encoding: "utf8" }).status, 0);
    assert.equal(spawnSync("git", ["-C", marketplaceRoot, "config", "user.name", "Smoke Fixture"], { encoding: "utf8" }).status, 0);
    await writeFile(join(marketplaceRoot, "fixture.txt"), "fixture\n");
    assert.equal(spawnSync("git", ["-C", marketplaceRoot, "add", "fixture.txt"], { encoding: "utf8" }).status, 0);
    assert.equal(spawnSync("git", ["-C", marketplaceRoot, "commit", "-m", "fixture"], { encoding: "utf8" }).status, 0);
    assert.equal(spawnSync("git", ["-C", marketplaceRoot, "remote", "add", "origin", "https://github.com/Neil0619/adaptive-model-router.git"], { encoding: "utf8" }).status, 0);
    const commit = spawnSync("git", ["-C", marketplaceRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

    const fakeSource = join(bin, "fake-codex.mjs");
    const fakeSourceText = `
const args = process.argv.slice(2).join(" ");
const root = process.env.FAKE_MARKETPLACE_ROOT;
if (args === "plugin marketplace list --json") {
  process.stdout.write(JSON.stringify({ marketplaces: [{ name: "adaptive-model-router", root, marketplaceSource: { sourceType: "git", source: "https://github.com/Neil0619/adaptive-model-router.git" } }] }));
  process.exit(0);
}
if (args === "plugin list --available --json") {
  process.stdout.write(JSON.stringify({ installed: [{ pluginId: "adaptive-model-router@adaptive-model-router", enabled: true, version: "0.4.0" }] }));
  process.exit(0);
}
process.exit(2);
`;
    await writeFile(fakeSource, fakeSourceText);
    if (process.platform === "win32") {
      await writeFile(join(bin, "codex.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.mjs" %*\r\n`, "ascii");
    } else {
      const executable = join(bin, "codex");
      await writeFile(executable, `#!${process.execPath}\n${fakeSourceText}`);
      await chmod(executable, 0o755);
    }
    const { CODEX_BIN: _ignored, ...baseEnv } = process.env;
    const pathKey = Object.keys(baseEnv).find((key) => key.toLowerCase() === "path") || "PATH";
    const env = {
      ...baseEnv,
      FAKE_MARKETPLACE_ROOT: marketplaceRoot,
    };
    env[pathKey] = `${bin}${delimiter}${baseEnv[pathKey] || ""}`;
    const result = spawnSync(process.execPath, [
      join(repoRoot, "scripts", "verify-installed-candidate.mjs"),
      "--ref=codex/windows-zero-approval-smoke-v9",
      `--commit=${commit}`,
    ], {
      encoding: "utf8",
      env,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ref, revision, and plugin version verified/u);
  } finally {
    await project.cleanup();
  }
});
