import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function source(path) {
  return readFile(join(repoRoot, ...path.split("/")), "utf8");
}

test("native Windows smoke has one fail-closed zero-approval contract", async () => {
  const [agents, runner, runbook, release, evidenceReadme, validator, schema, workflow, packageJson, codexRoute] = await Promise.all([
    source("AGENTS.md"),
    source("scripts/windows-smoke.ps1"),
    source("docs/WINDOWS_SMOKE.md"),
    source("docs/RELEASE.md"),
    source("docs/release-evidence/README.md"),
    source("scripts/validate-smoke-evidence.mjs"),
    source("docs/release-evidence/schema-v1.json"),
    source(".github/workflows/ci.yml"),
    source("plugins/adaptive-model-router/package.json"),
    source("plugins/adaptive-model-router/scripts/codex-route.mjs"),
  ]);

  for (const document of [agents, runner, runbook, release]) {
    assert.doesNotMatch(document, /--dangerously-bypass-approvals-and-sandbox/u);
  }
  assert.doesNotMatch(runner, /--dangerously-bypass-hook-trust/u);
  assert.doesNotMatch(runner, /GetTempPath/u);
  assert.match(runner, /ADAPTIVE_ROUTER_SMOKE_ROOT/u);
  assert.match(runner, /CODEX_PERMISSION_PROFILE/u);
  assert.match(runner, /host permission profile must be danger-full-access/u);
  assert.match(runner, /@\('-a', 'never', '-s', 'read-only', 'exec', '-c', \$ManagedShellPathConfig, 'resume'/u);
  assert.match(runner, /@\('-a', 'never', '-s', 'read-only', 'exec', '-c', \$ManagedShellPathConfig, '--json'/u);
  assert.doesNotMatch(runner, /@\('exec', '-a'/u);
  assert.doesNotMatch(runner, /deliberately do not spawn/u);
  assert.match(runner, /@\(\$InstalledRouterLauncher, \$InstalledRouterCli, 'stop-probe', '--confirm', 'STOP_HOOK_SMOKE'/u);
  assert.match(codexRoute, /stop-probe requires exact confirmation/u);
  assert.match(runner, /ManagedCodexPath/u);
  assert.match(runner, /shell_environment_policy\.set\.PATH=/u);
  assert.match(runner, /WindowsApps/u);
  assert.match(runner, /EnvironmentOverrides @\{ PATH = \$ManagedCodexPath \}/u);
  assert.match(runner, /itemType -eq 'command_execution'/u);
  assert.match(runner, /Register-CodexPermissionTelemetry/u);
  assert.match(runner, /ValidateZeroApprovalContract/u);

  for (const document of [runbook, release, evidenceReadme]) {
    assert.match(document, /zero-approval-v1/u);
    assert.match(document, /approvalRequests/u);
    assert.match(document, /permissionFailures/u);
  }

  const parsedSchema = JSON.parse(schema);
  const permissions = parsedSchema.properties.permissions.properties;
  for (const key of [
    "contract",
    "hostProfile",
    "hostApprovalPolicy",
    "managedApprovalPolicy",
    "managedSandboxMode",
    "approvalRequests",
    "sandboxEscalations",
    "permissionFailures",
  ]) {
    assert.ok(permissions[key], `schema lacks permissions.${key}`);
  }
  assert.match(validator, /approvalRequests === 0/u);
  assert.match(validator, /sandboxEscalations === 0/u);
  assert.match(validator, /permissionFailures === 0/u);
  assert.match(JSON.parse(packageJson).scripts.test, /test\/\*\.test\.mjs/u);
  assert.match(workflow, /windows-latest/u);
  assert.match(workflow, /Exercise Windows zero-approval preflight/u);
});

test("Stop-hook probe seeds a pending route outside the model turn and finalizes it once", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "adaptive-router-stop-probe-test-"));
  const project = join(fixture, "probe project");
  const routerHome = join(fixture, "router home");
  const codexRoute = join(repoRoot, "plugins", "adaptive-model-router", "scripts", "codex-route.mjs");
  const hook = join(repoRoot, "plugins", "adaptive-model-router", "scripts", "hook.mjs");
  const contextId = "stop-probe-context";
  const env = {
    ...process.env,
    ADAPTIVE_ROUTER_HOME: routerHome,
    ADAPTIVE_ROUTER_LOCAL_ONLY: "1",
  };
  try {
    await mkdir(project, { recursive: true });
    await mkdir(routerHome, { recursive: true });
    assert.equal(spawnSync("git", ["init", project], { encoding: "utf8" }).status, 0);
    const probe = spawnSync(process.execPath, [
      codexRoute, "stop-probe", "--confirm", "STOP_HOOK_SMOKE", "--context", contextId,
    ], { cwd: project, encoding: "utf8", env });
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(JSON.parse(probe.stdout).action, "delegate");

    const stopped = spawnSync(process.execPath, [hook, "stop"], {
      cwd: project,
      input: JSON.stringify({ cwd: project, session_id: contextId, hook_event_name: "Stop", stop_hook_active: false }),
      encoding: "utf8",
      env,
    });
    assert.equal(stopped.status, 0, stopped.stderr);

    const history = spawnSync(process.execPath, [codexRoute, "history", "--context", contextId], {
      cwd: project, encoding: "utf8", env,
    });
    assert.equal(history.status, 0, history.stderr);
    const routes = JSON.parse(history.stdout).routes;
    assert.equal(routes.length, 1);
    assert.equal(routes[0].outcome.status, "unknown");
    assert.equal(routes[0].outcome.source, "stop_hook");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("native Windows zero-approval preflight enforces policy and path containment", { skip: process.platform !== "win32" }, async () => {
  const fixture = await mkdtemp(join(tmpdir(), "adaptive-router-zero-approval-test-"));
  const smokeRoot = join(fixture, "controlled root");
  const smokeHome = join(smokeRoot, ".codex-home");
  const outside = join(fixture, "outside");
  const runner = join(repoRoot, "scripts", "windows-smoke.ps1");
  try {
    await mkdir(smokeHome, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(smokeRoot, ".adaptive-router-smoke-root"), "adaptive-model-router smoke root v1");
    await writeFile(join(smokeHome, ".adaptive-router-smoke-home"), "adaptive-model-router smoke home v1");
    await writeFile(join(outside, ".adaptive-router-smoke-home"), "adaptive-model-router smoke home v1");

    const baseEnv = {
      ...process.env,
      CODEX_PERMISSION_PROFILE: ":danger-full-access",
      ADAPTIVE_ROUTER_SMOKE_ROOT: smokeRoot,
      ADAPTIVE_ROUTER_SMOKE_CODEX_HOME: smokeHome,
      ADAPTIVE_ROUTER_SMOKE_HOST_APPROVAL_POLICY: "never",
    };
    const invoke = (env, output = join(smokeRoot, "evidence")) => spawnSync("pwsh", [
      "-NoProfile", "-File", runner,
      "-CandidateRef", "codex/windows-zero-approval-smoke-v5",
      "-OutputDirectory", output,
      "-ValidateZeroApprovalContract",
    ], { encoding: "utf8", env });

    const valid = invoke(baseEnv);
    assert.equal(valid.status, 0, valid.stderr || valid.stdout);
    assert.match(valid.stdout, /zero-approval-v1 preflight passed/u);
    assert.notEqual(invoke({ ...baseEnv, ADAPTIVE_ROUTER_SMOKE_HOST_APPROVAL_POLICY: "on-request" }).status, 0);
    assert.notEqual(invoke({ ...baseEnv, CODEX_PERMISSION_PROFILE: ":workspace-write" }).status, 0);
    assert.notEqual(invoke({ ...baseEnv, ADAPTIVE_ROUTER_SMOKE_CODEX_HOME: outside }).status, 0);
    assert.notEqual(invoke(baseEnv, join(outside, "evidence")).status, 0);
    await assert.rejects(readFile(join(outside, "evidence", "windows.json")));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
