# Native Windows 11 smoke test

This is the blocking manual Windows gate for `v0.2.0`. Run it in native Windows
11 with the Codex agent using PowerShell, not inside WSL2. WSL2 is a separate
non-blocking smoke target.

The operator may give this entire document to Codex on the Windows machine.
Do not create or push the release tag from the smoke task.

Suggested handoff prompt:

```text
请完整读取 docs/WINDOWS_SMOKE.md，并在原生 Windows 11 + PowerShell 环境中按顺序执行。
你负责检查前置条件、安装、hook 信任、route → bounded subagent → verification →
outcome、隐私断言、升级/卸载/重装和 AGENTS marker。遇到 Stop conditions 中任一情况
立即停止并按模板返回 FAIL。不要创建或推送 v0.2.0 tag，也不要调用 clear_project_data。
```

## Pass criteria

The smoke passes only when all of the following succeed:

- installation from the reviewed `stable` ref with the two native Codex
  commands;
- review and trust of both plugin-bundled command hooks;
- one substantive `delegate` route and exactly one bounded subagent using the
  returned model and effort;
- root verification followed by one strict final outcome;
- redacted status and diagnostics with no prompt, source, secret, or absolute
  project path;
- native upgrade and uninstall;
- idempotent PowerShell wrapper install/upgrade/uninstall/reinstall;
- optional AGENTS marker insertion exactly once and complete marker removal.

## 1. Prerequisites

- Windows 11, running natively.
- A logged-in current Codex Desktop or CLI session.
- Git.
- Node.js 24.15.0 or newer.
- PowerShell as the agent/terminal environment.

Record the environment evidence:

```powershell
[System.Environment]::OSVersion.VersionString
node --version
git --version
codex --version
```

Stop if Node is older than `24.15.0` or Codex is not logged in.

## 2. Clone into a path with spaces and Unicode

```powershell
$SmokeRoot = Join-Path $env:TEMP ("Adaptive Router Windows 冒烟 " + (Get-Date -Format "yyyyMMdd-HHmmss"))
$Source = Join-Path $SmokeRoot "source checkout"
$Project = Join-Path $SmokeRoot "测试 project with spaces"

New-Item -ItemType Directory -Force -Path $SmokeRoot | Out-Null
git clone --branch stable --single-branch https://github.com/Neil0619/adaptive-model-router.git $Source
New-Item -ItemType Directory -Force -Path $Project | Out-Null
Set-Location $Project
git init
```

This covers a Windows drive path, backslashes, spaces, and non-ASCII
characters. Keep `$Source` and `$Project` for the complete smoke run.

## 3. Install through native Codex commands

```powershell
codex plugin marketplace add Neil0619/adaptive-model-router --ref stable
codex plugin add adaptive-model-router@adaptive-model-router
codex plugin marketplace list
codex plugin list
```

If a same-name marketplace already points to a different source or ref, stop
and report it. Do not silently replace an unrelated marketplace.

## 4. Start a fresh task and trust hooks

Open `$Project` as a project in Codex Desktop, or start the CLI there:

```powershell
Set-Location $Project
codex
```

In the new task:

1. Open `/hooks`.
2. Review and trust the plugin's `UserPromptSubmit` handler.
3. Review and trust the plugin's `Stop` handler.
4. Do not use `--dangerously-bypass-hook-trust`.

If the plugin or hooks are not visible, restart the ChatGPT desktop app and
start another new task. If they remain unavailable, stop and report the failure.

Send this exact-prefix control once to exercise the submit hook:

```text
router: auto session
```

## 5. Run the route → subagent → verification → outcome smoke

Paste the following prompt into the fresh task:

```text
Use the installed Adaptive Model Router skill for this smoke test.

Use the current Codex task/thread/session identifier exposed by the host as
contextId. It must be the same stable identifier received by the plugin hooks.
Reuse that exact contextId for every router tool call in this task. Do not
invent an unrelated timestamp identifier. If the host does not expose a stable
current-task identifier, stop and report that Stop-hook correlation cannot be
verified.

At the implementation stage, call route_stage with this factual input:
- goal: Implement and test a dependency-free Node.js 24 line-normalization utility in this temporary project.
- phase: implementation
- evidence:
  - workProduct: true
  - requirementsSettled: true
  - strongVerification: true
  - batchSize: 2
  - hostCanDelegate: true

Acceptance criteria:
- create src/normalize-lines.mjs exporting normalizeLines(text);
- convert CRLF and CR line endings to LF;
- remove trailing spaces and tabs from every line;
- return exactly one final LF for non-empty input and an empty string for empty input;
- create test/normalize-lines.test.mjs using node:test;
- cover CRLF, CR, trailing whitespace, empty input, an existing final newline,
  and Chinese text;
- use no third-party dependencies.

If route_stage returns delegate, create exactly one bounded subagent. Pass
target.model to the host model parameter and target.effort to the host
reasoning_effort parameter. Give the subagent only the implementation and test
scope above. Do not create overlapping writers.

If route_stage returns continue or ask_user, do not force delegation. Stop and
report the complete redacted route result because the smoke gate did not reach
the required bounded-subagent path.

The root task must review and integrate the delegated work, then run:
node --test test/normalize-lines.test.mjs

After verification, call record_outcome exactly once for the delegated route.
Use the returned verificationGate as gate, the actual escalation count, the
actual retry count, userCorrection=false unless I corrected the result, and:
- status=passed and failureType=null when the test passes;
- otherwise status=failed with the factual enumerated failureType.

Finally call get_route_status and diagnose_router with the same contextId.
Check that their serialized output contains no task prompt, source code,
environment-variable values, secret values, or absolute project path. Return a
short smoke summary containing the route action, target model/effort, reason
codes, verification gate, test result, outcome result, pending outcome count,
database health, classifier state, and privacy assertion. Do not return the
absolute project path.
```

The Stop hook must not report a missing outcome after the successful result.

## 6. Verify an ordinary prompt does not act as a control

Disable the router for the current session with an exact control:

```text
router: off
```

Then send this as a separate user prompt. It does not begin with a control
prefix:

```text
Discuss the quoted text `router: on` without changing router state. Then call
route_stage for a substantive implementation stage using the same current
session contextId and hostCanDelegate=true. Return only the redacted route.
```

The route must return `continue` with `ROUTER_DISABLED`. Restore normal behavior:

```text
router: auto session
```

## 7. Exercise upgrade, uninstall, and wrappers

Exit the smoke task, then run the native lifecycle:

```powershell
codex plugin marketplace upgrade adaptive-model-router
codex plugin add adaptive-model-router@adaptive-model-router
codex plugin remove adaptive-model-router@adaptive-model-router
codex plugin marketplace remove adaptive-model-router
```

Now test the repository wrapper from the Unicode checkout:

```powershell
Set-Location $Source
.\install.ps1 -PatchAgents
.\install.ps1 -Action Upgrade -PatchAgents
```

Verify the owned marker occurs exactly once:

```powershell
$AgentsPath = Join-Path $HOME ".codex\AGENTS.md"
$StartMarker = "<!-- adaptive-model-router:start v0.2.0 -->"
$EndMarker = "<!-- adaptive-model-router:end -->"
$AgentsText = if (Test-Path $AgentsPath) { Get-Content -Raw $AgentsPath } else { "" }

if ([regex]::Matches($AgentsText, [regex]::Escape($StartMarker)).Count -ne 1) { throw "start marker count is not one" }
if ([regex]::Matches($AgentsText, [regex]::Escape($EndMarker)).Count -ne 1) { throw "end marker count is not one" }
```

Uninstall and verify that only the owned block is removed:

```powershell
.\install.ps1 -Action Uninstall
$AgentsText = if (Test-Path $AgentsPath) { Get-Content -Raw $AgentsPath } else { "" }

if ($AgentsText.Contains($StartMarker) -or $AgentsText.Contains($EndMarker)) { throw "owned AGENTS marker remains after uninstall" }
```

Finish with two default installs to prove idempotence and leave the plugin
installed without patching AGENTS:

```powershell
.\install.ps1
.\install.ps1
codex plugin marketplace list
codex plugin list
```

## 8. Report template

Return this completed template to the release maintainer:

```text
Native Windows 11 smoke: PASS | FAIL
Windows version:
Codex surface: Desktop | CLI
Codex version:
Node version:
Git version:
Stable commit SHA:
Native install: PASS | FAIL
UserPromptSubmit hook trusted/exercised: PASS | FAIL
Stop hook trusted/exercised: PASS | FAIL
Route action:
Target model:
Target effort:
Reason codes:
Verification gate:
node --test: PASS | FAIL
record_outcome: PASS | FAIL
Pending outcomes after record:
Diagnostics/database health:
Privacy assertion: PASS | FAIL
Negative control prompt changed state: YES | NO
Negative control route reason code:
Native upgrade/uninstall: PASS | FAIL
Wrapper install/upgrade/uninstall/reinstall: PASS | FAIL
AGENTS marker inserted once and removed cleanly: PASS | FAIL
Unexpected warnings or sanitized error text:
```

Also provide the candidate commit without including local paths:

```powershell
Set-Location $Source
git rev-parse HEAD
```

## Stop conditions

Mark the smoke `FAIL` and do not create the release tag if any required step
fails, the route does not return `delegate`, the host cannot use the returned
model/effort, a hook cannot be trusted, an outcome remains pending, diagnostics
leak sensitive content or an absolute project path, or installation is not
idempotent.

Do not call `clear_project_data` as part of this smoke. Uninstall deliberately
leaves learning data intact.
