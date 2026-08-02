import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { temporaryProject } from "./fixtures.mjs";
import { verifyInstalledCandidate } from "../../../scripts/verify-installed-candidate.mjs";

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
      surface: "cli",
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
      verificationGate: "full-checks",
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
    assert.match(await readFile(`${output}.sha256`, "utf8"), /^[0-9a-f]{64}  windows\.json\n$/u);
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

    const incomplete = validEvidence();
    incomplete.checks.pop();
    const incompleteResult = await runEvidence(project, incomplete);
    assert.notEqual(incompleteResult.result.status, 0);
    assert.match(incompleteResult.result.stderr, /too few items|complete canonical gate set/u);

    const schemaInvalidDate = validEvidence();
    schemaInvalidDate.generatedAt = "2026-08-02";
    const schemaInvalidDateResult = await runEvidence(project, schemaInvalidDate);
    assert.notEqual(schemaInvalidDateResult.result.status, 0);
    assert.match(schemaInvalidDateResult.result.stderr, /RFC 3339 date-time/u);

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
    assert.match(templateResult.stdout, /macos-native FAIL/u);
  } finally {
    await project.cleanup();
  }
});

test("installed candidate verification binds ref, revision, enabled state, and version", () => {
  const expectedCommit = "a".repeat(40);
  const marketplaceState = { marketplaces: [{ name: "adaptive-model-router", root: "/redacted/cache" }] };
  const pluginState = {
    installed: [{
      pluginId: "adaptive-model-router@adaptive-model-router",
      enabled: true,
      version: "0.4.0",
    }],
  };
  const metadata = { ref_name: "codex/windows-smoke", revision: expectedCommit };
  assert.doesNotThrow(() => verifyInstalledCandidate({
    marketplaceState,
    pluginState,
    metadata,
    expectedRef: "codex/windows-smoke",
    expectedCommit,
  }));
  assert.throws(() => verifyInstalledCandidate({
    marketplaceState,
    pluginState,
    metadata: { ...metadata, revision: "b".repeat(40) },
    expectedRef: "codex/windows-smoke",
    expectedCommit,
  }), /revision differs/u);
});
