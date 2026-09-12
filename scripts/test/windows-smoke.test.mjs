import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { delimiter, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../windows-smoke.ps1", import.meta.url));
const bootstrap = `
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$errors=$null; $tokens=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($env:ROUTER_SMOKE_TEST_RUNNER,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'PowerShell syntax error'}
foreach($definition in $ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true)){Invoke-Expression $definition.Extent.Text}
$SmokeModel='gpt-6-astra'; $InitialRootModel=$SmokeModel; $SmokeEffort='high'; $HostIntentModel=$null
$Source='fixture'; $Project='fixture'; $SessionId='native-smoke-fixture'
`;
function run(script) {
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", bootstrap + script], {
    encoding: "utf8", timeout: 10_000, windowsHide: true,
    env: { ...process.env, ROUTER_SMOKE_TEST_RUNNER: runner },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("native host-model smoke restores the original model and effort after a failed override", () => {
  const result = run(`
function Read-NativeRootBinding { [pscustomobject]@{Model='gpt-6-astra';Effort='high'} }
function Invoke-Process { [pscustomobject]@{Stdout='{"model":"gpt-5.6-sol","effort":"high","source":"native-model-list"}'} }
$script:calls=[Collections.Generic.List[object]]::new()
function Invoke-CodexTurn {
  param($Prompt,$Model,$Effort,$ResumeSession,[switch]$HostModelControl)
  $script:calls.Add(@{prompt=$Prompt;model=$Model;effort=$Effort;context=$ResumeSession;hostControl=$HostModelControl.IsPresent})
  if($Prompt -ne 'router: auto session'){throw 'INJECTED_NATIVE_OVERRIDE_FAILURE'}
}
function Read-RouterState { [pscustomobject]@{rootTask=@{model='gpt-6-astra'};taskMode='automatic';pendingHostModelChange=$null;pendingOutcomes=0} }
$failure=$null
try { Invoke-HostModelIntentSmoke } catch { $failure=$_.Exception.Message }
@{failure=$failure;calls=@($script:calls)} | ConvertTo-Json -Depth 5 -Compress
`);
  assert.equal(result.failure, "INJECTED_NATIVE_OVERRIDE_FAILURE");
  assert.equal(result.calls.length, 2);
  assert.equal(result.calls[0].model, "gpt-5.6-sol");
  assert.deepEqual(result.calls[1], {
    prompt: "router: auto session", model: "gpt-6-astra", effort: "high",
    context: "native-smoke-fixture", hostControl: true,
  });
});

test("ordinary smoke work cannot use the host-control exception to escape its target", () => {
  const result = run(`
$failures=@()
foreach($case in @(@{Model='gpt-5.6-sol'},@{Model='gpt-6-astra';Effort='low'},@{Model='gpt-5.6-sol';HostModelControl=$true},@{Model='gpt-6-astra';HostModelControl=$true})) {
  try { Invoke-CodexTurn -Prompt 'unreachable' @case } catch { $failures+= $_.Exception.Message }
}
ConvertTo-Json -InputObject @($failures) -Compress
`);
  assert.deepEqual(result, [
    "model escaped the shared smoke target binding", "model escaped the shared smoke target binding",
    "invalid native root-model control target", "invalid native root-model control target",
  ]);
});

test("native child completion remains valid when a later mailbox wait times out", () => {
  const result = run(`
$events=@(
  @{type='event_msg';payload=@{type='item_completed';item=@{type='SubAgentActivity';kind='started';agent_path='/root/review';agent_thread_id='child'}}},
  @{type='event_msg';payload=@{type='item_completed';item=@{type='SubAgentActivity';kind='completed';agent_path='/root/review';agent_thread_id='child'}}},
  @{type='response_item';payload=@{type='function_call_output';output='{"timed_out":true,"message":"Wait timed out."}'}}
) | ConvertTo-Json -Depth 8 | ConvertFrom-Json -Depth 8
Get-BoundedLifecyclePositions -Trace $events -AgentPath '/root/review' | ConvertTo-Json -Compress
`);
  assert.deepEqual(result, { Started: 0, Completed: 1 });
});

test("native child completion rejects another child, a missing stop, and reversed lifecycle events", () => {
  const result = run(`
function Event($kind,$id='child',$path='/root/review') { @{type='event_msg';payload=@{type='item_completed';item=@{type='SubAgentActivity';kind=$kind;agent_path=$path;agent_thread_id=$id}}} }
$failures=@()
$cases=@(@((Event 'started'),(Event 'completed' 'other-child')),@((Event 'started'),(Event 'completed' 'child' '/root/other')),@((Event 'completed'),(Event 'started')))
foreach($case in $cases){
  $events=ConvertTo-Json -InputObject $case -Depth 8 | ConvertFrom-Json -Depth 8
  try { Get-BoundedLifecyclePositions -Trace $events -AgentPath '/root/review' | Out-Null } catch { $failures += $_.Exception.Message }
}
ConvertTo-Json -InputObject @($failures) -Compress
`);
  assert.deepEqual(result, Array(3).fill("native subagent start and completion do not identify one finished child"));
});

test("Windows lifecycle stops only Router processes in the marked Home cache", { skip: process.platform !== "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "adaptive-router-process-scope-"));
  const home = join(root, "dedicated");
  const inside = join(home, "plugins/cache/adaptive-model-router/adaptive-model-router/fixture");
  const outside = join(root, "outside");
  const children = [];
  try {
    mkdirSync(inside, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(home, ".adaptive-router-smoke-home"), "adaptive-model-router smoke home v1");
    for (const cwd of [inside, outside]) {
      const script = join(cwd, "node-launcher.mjs");
      writeFileSync(script, 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);\n');
      const child = spawn(process.execPath, [script], { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const exited = once(child, "exit");
      children.push({ child, exited });
      await once(child.stdout, "data");
    }
    const helper = fileURLToPath(new URL("../stop-windows-smoke-router-processes.ps1", import.meta.url));
    // PowerShell startup, Add-Type compilation and CIM queries can nearly
    // consume 15 seconds on hosted Windows runners before process checks finish.
    const result = spawnSync("pwsh", ["-NoProfile", "-File", helper, "-CodexHome", home], {
      encoding: "utf8", timeout: 60_000, windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).StoppedRouterProcesses, 1);
    await children[0].exited;
    assert.doesNotThrow(() => process.kill(children[1].child.pid, 0));
  } finally {
    for (const { child, exited } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    assert.ok(root.includes("adaptive-router-process-scope-"));
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows wrapper uninstall exits successfully when it removes the PATH node.cmd bridge", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "adaptive-router-uninstall-shim-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  try {
    mkdirSync(home); mkdirSync(bin);
    const nodeShim = join(bin, "node.cmd");
    writeFileSync(nodeShim, `@echo off\r\nrem adaptive-model-router Desktop PATH compatibility bridge\r\n"${process.execPath}" %*\r\n`, "ascii");
    const codex = join(bin, "codex.cmd");
    writeFileSync(codex, `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.mjs" %*\r\n`, "ascii");
    writeFileSync(join(bin, "fake-codex.mjs"), `
const args=process.argv.slice(2).join(" ");
if(args==="--version") console.log("codex 1.0.0");
else if(args==="plugin marketplace list --json") console.log('{"marketplaces":[]}');
else if(args==="plugin list --available --json") console.log('{"installed":[],"available":[]}');
else if(args==="mcp list --json") console.log('[]');
else throw new Error("unexpected fake Codex command");
`);
    const env = { ...process.env, CODEX_HOME: home, CODEX_BIN: codex, ADAPTIVE_ROUTER_DESKTOP_OVERRIDE_DIR: bin };
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
    env[pathKey] = [bin, env[pathKey] || ""].join(delimiter);
    const installer = fileURLToPath(new URL("../../install.ps1", import.meta.url));
    const result = spawnSync("pwsh", ["-NoProfile", "-File", installer, "-Action", "Uninstall"], {
      encoding: "utf8", timeout: 20_000, windowsHide: true, env,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Adaptive Model Router is uninstalled/u);
    assert.equal(existsSync(nodeShim), false);
    assert.equal(existsSync(codex), true);
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    assert.ok(root.includes("adaptive-router-uninstall-shim-"));
    rmSync(root, { recursive: true, force: true });
  }
});
