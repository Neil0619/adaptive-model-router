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
const releaseVerifier = join(repoRoot, "scripts", "verify-release-evidence.mjs");
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
  "same-task-hot-upgrade",
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
      ref: "codex/windows-smoke",
      commitSha: "a".repeat(40),
      pluginTreeSha256: "b".repeat(64),
    },
    environment: {
      platform: "windows",
      surface: "desktop",
      osVersion: "Microsoft Windows NT 10.0.26100.0",
      codexVersion: "codex-cli 0.145.0",
      nodeVersion: "v24.18.0",
      gitVersion: "git version 2.45.1.windows.1",
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
    continuity: {
      candidateCommitSha: "a".repeat(40),
      taskIdentityBeforeSha256: "c".repeat(64),
      taskIdentityAfterSha256: "c".repeat(64),
      contextIdentityBeforeSha256: "d".repeat(64),
      contextIdentityAfterSha256: "d".repeat(64),
      rootModelBefore: "gpt-5.6-sol",
      rootModelAfter: "gpt-5.6-sol",
      runtimeBefore: "0.4.0+codex.20260812000000",
      runtimeAfter: "0.4.0+codex.20260814000000",
      transportBefore: "unavailable",
      transportAfter: "stdio-bridge",
      shimStatus: "verified",
      routeIdSha256: "e".repeat(64),
      outcomeRouteIdSha256: "e".repeat(64),
      outcomeStatus: "passed",
      delegatedTargetCount: 1,
      recordedOutcomeCount: 1,
      desktopStayedOpen: true,
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

    const replacedTask = validEvidence();
    replacedTask.continuity.taskIdentityAfterSha256 = "f".repeat(64);
    const replacedTaskResult = await runEvidence(project, replacedTask);
    assert.notEqual(replacedTaskResult.result.status, 0);
    assert.match(replacedTaskResult.result.stderr, /status disagrees/u);

    const cliOnly = validEvidence();
    cliOnly.environment.surface = "cli";
    const cliOnlyResult = await runEvidence(project, cliOnly);
    assert.notEqual(cliOnlyResult.result.status, 0);
    assert.match(cliOnlyResult.result.stderr, /status disagrees/u);

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
      "--expected-ref=codex/windows-smoke",
      `--expected-commit=${"a".repeat(40)}`,
    ]);
    assert.equal(result.status, 0, result.stderr);

    const templateResult = spawnSync(process.execPath, [validator, macosTemplate], { encoding: "utf8" });
    assert.equal(templateResult.status, 0, templateResult.stderr);
    const requiredTemplateResult = spawnSync(
      process.execPath,
      [validator, macosTemplate, "--require-pass"],
      { encoding: "utf8" },
    );
    assert.notEqual(requiredTemplateResult.status, 0);
    assert.match(requiredTemplateResult.stderr, /require-pass/u);
    assert.match(templateResult.stdout, /macos-native FAIL/u);
  } finally {
    await project.cleanup();
  }
});

test("release evidence gate binds both native PASS artifacts to one unchanged candidate tree", async () => {
  const project = await temporaryProject("adaptive release evidence ");
  const runGit = (...args) => spawnSync("git", args, {
    cwd: project.root,
    encoding: "utf8",
    windowsHide: true,
  });
  try {
    await mkdir(join(project.root, "plugins", "adaptive-model-router"), { recursive: true });
    await writeFile(join(project.root, "plugins", "adaptive-model-router", "fixture.txt"), "candidate\n");
    assert.equal(runGit("init", "-b", "codex/windows-smoke").status, 0);
    assert.equal(runGit("config", "user.name", "Router Test").status, 0);
    assert.equal(runGit("config", "user.email", "router@example.invalid").status, 0);
    assert.equal(runGit("add", ".").status, 0);
    assert.equal(runGit("commit", "-m", "candidate").status, 0);
    const commit = runGit("rev-parse", "HEAD").stdout.trim();
    const listing = runGit(
      "ls-tree",
      "-r",
      "--full-tree",
      commit,
      "plugins/adaptive-model-router",
    ).stdout.replace(/\r\n?/gu, "\n");
    const pluginTreeSha256 = createHash("sha256").update(listing, "utf8").digest("hex");
    const windows = validEvidence();
    windows.candidate.commitSha = commit;
    windows.candidate.pluginTreeSha256 = pluginTreeSha256;
    windows.continuity.candidateCommitSha = commit;
    const macos = structuredClone(windows);
    macos.gate = "macos-native";
    macos.environment.platform = "macos";
    macos.environment.osVersion = "macOS 15.6.1";
    const evidenceDirectory = join(project.root, "docs", "release-evidence", "v0.4.0");
    const windowsPath = join(evidenceDirectory, "windows.json");
    const macosPath = join(evidenceDirectory, "macos.json");
    const waiverPath = join(project.root, "docs", "release-waivers", "v0.4.0-windows-native.json");
    await mkdir(evidenceDirectory, { recursive: true });
    await mkdir(dirname(waiverPath), { recursive: true });
    await writeFile(windowsPath, `${JSON.stringify(windows)}\n`);
    await writeFile(macosPath, `${JSON.stringify(macos)}\n`);

    const accepted = spawnSync(process.execPath, [
      releaseVerifier,
      "--expected-ref=codex/windows-smoke",
      windowsPath,
      macosPath,
    ], { cwd: project.root, encoding: "utf8", windowsHide: true });
    assert.equal(accepted.status, 0, accepted.stderr);

    const staleWindows = structuredClone(windows);
    staleWindows.status = "FAIL";
    staleWindows.candidate.commitSha = "a".repeat(40);
    staleWindows.candidate.pluginTreeSha256 = "b".repeat(64);
    staleWindows.continuity.candidateCommitSha = "a".repeat(40);
    staleWindows.checks.find((check) => check.id === "same-task-hot-upgrade").status = "SKIP";
    staleWindows.warnings = ["EVIDENCE_INVALIDATED_BY_CONTINUITY_GATE"];
    await writeFile(windowsPath, `${JSON.stringify(staleWindows)}\n`);

    const defaultRejected = spawnSync(process.execPath, [
      releaseVerifier,
      "--expected-ref=codex/windows-smoke",
      windowsPath,
      macosPath,
    ], { cwd: project.root, encoding: "utf8", windowsHide: true });
    assert.notEqual(defaultRejected.status, 0);
    assert.match(defaultRejected.stderr, /does not bind one frozen candidate/u);

    const waiver = {
      schemaVersion: 1,
      releaseTag: "v0.4.0",
      gate: "windows-native",
      scope: "same-task-continuity",
      authorizedAt: "2026-08-14T07:00:00.000Z",
      authorizedBy: "Neil0619",
      reasonCode: "WINDOWS_NATIVE_SAME_TASK_SMOKE_DEFERRED",
      candidate: {
        ref: "codex/windows-smoke",
        commitSha: commit,
        pluginTreeSha256,
      },
      retainedEvidence: {
        path: "docs/release-evidence/v0.4.0/windows.json",
        sha256: createHash("sha256").update(await readFile(windowsPath)).digest("hex"),
        status: "FAIL",
      },
      riskAcknowledgements: [
        "DESKTOP_REDUCED_PATH_UNVERIFIED",
        "NATIVE_FILE_LOCKING_UNVERIFIED",
        "OLD_TASK_STDIO_BRIDGE_UNVERIFIED",
      ],
      futureReleaseReuse: false,
    };
    await writeFile(waiverPath, `${JSON.stringify(waiver, null, 2)}\n`);

    const localBypassRejected = spawnSync(process.execPath, [
      releaseVerifier,
      "--expected-ref=codex/windows-smoke",
      `--temporary-windows-waiver=${waiverPath}`,
      windowsPath,
      macosPath,
    ], { cwd: project.root, encoding: "utf8", windowsHide: true });
    assert.notEqual(localBypassRejected.status, 0);
    assert.match(localBypassRejected.stderr, /official v0\.4\.0 GitHub tag workflow/u);

    assert.equal(runGit("checkout", "-b", "release").status, 0);
    assert.equal(runGit("add", "docs/release-waivers/v0.4.0-windows-native.json").status, 0);
    assert.equal(runGit("commit", "-m", "record one-time waiver").status, 0);

    const bypassAccepted = spawnSync(process.execPath, [
      releaseVerifier,
      "--expected-ref=codex/windows-smoke",
      `--temporary-windows-waiver=${waiverPath}`,
      windowsPath,
      macosPath,
    ], {
      cwd: project.root,
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: "Neil0619/adaptive-model-router",
        GITHUB_REF_TYPE: "tag",
        GITHUB_REF_NAME: "v0.4.0",
      },
    });
    assert.equal(bypassAccepted.status, 0, bypassAccepted.stderr);
    assert.match(bypassAccepted.stdout, /Windows evidence bypass active for v0\.4\.0/u);

    const wrongTagBypassRejected = spawnSync(process.execPath, [
      releaseVerifier,
      "--expected-ref=codex/windows-smoke",
      `--temporary-windows-waiver=${waiverPath}`,
      windowsPath,
      macosPath,
    ], {
      cwd: project.root,
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: "Neil0619/adaptive-model-router",
        GITHUB_REF_TYPE: "tag",
        GITHUB_REF_NAME: "v0.4.1",
      },
    });
    assert.notEqual(wrongTagBypassRejected.status, 0);
    assert.match(wrongTagBypassRejected.stderr, /official v0\.4\.0 GitHub tag workflow/u);

    await writeFile(windowsPath, `${JSON.stringify(windows)}\n`);

    await writeFile(join(project.root, "plugins", "adaptive-model-router", "fixture.txt"), "changed\n");
    assert.equal(runGit("add", ".").status, 0);
    assert.equal(runGit("commit", "-m", "changed release tree").status, 0);
    const rejected = spawnSync(process.execPath, [
      releaseVerifier,
      "--expected-ref=codex/windows-smoke",
      windowsPath,
      macosPath,
    ], { cwd: project.root, encoding: "utf8", windowsHide: true });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /release-relevant files differ/u);
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
    ref: "codex/windows-smoke",
    revision: expectedCommit,
  };
  assert.doesNotThrow(() => verifyInstalledCandidate({
    marketplaceState,
    pluginState,
    identity,
    expectedRef: "codex/windows-smoke",
    expectedCommit,
  }));
  assert.throws(() => verifyInstalledCandidate({
    marketplaceState,
    pluginState,
    identity: { ...identity, revision: "b".repeat(40) },
    expectedRef: "codex/windows-smoke",
    expectedCommit,
  }), /revision differs/u);
  assert.throws(() => verifyInstalledCandidate({
    marketplaceState,
    pluginState,
    identity: { ...identity, source: "https://github.com/example/other.git" },
    expectedRef: "codex/windows-smoke",
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
    assert.equal(spawnSync("git", ["init", "--initial-branch=codex/windows-smoke", marketplaceRoot], { encoding: "utf8" }).status, 0);
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
      "--ref=codex/windows-smoke",
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
