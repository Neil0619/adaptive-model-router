# Native Windows 11 smoke test

This is the blocking automated Windows gate for `v0.4.0`. Run it in native
Windows 11 with PowerShell, not inside WSL2. WSL2 is a separate non-blocking
smoke target.

<!-- smoke-contract: post-trust-automatic-v1 selector-optional-v1 -->

The operator may give this entire document to Codex on the Windows machine.
Do not create or push the release tag from the smoke task.

The canonical automated entry point is
[`scripts/windows-smoke.ps1`](../scripts/windows-smoke.ps1):

```powershell
.\scripts\windows-smoke.ps1 `
  -CandidateRef 'codex/v040-hot-upgrade-release' `
  -ContinuityReceiptPath 'C:\path\to\redacted-continuity-receipt.json'
```

It accepts the frozen candidate ref, the app-orchestrated continuity receipt,
and an optional evidence output directory. It uses native `codex exec
--json`/`resume` turns for supplementary checks, never bypasses
Hook trust, independently reads router status/history/diagnostics, exercises
the lifecycle in this runbook, and emits a strict redacted JSON artifact plus
derived Markdown and SHA-256 files under `docs/release-evidence/v0.4.0/`.
Its candidate gate normalizes only CRLF/CR versus LF when comparing tracked
text files, so ordinary Windows checkout conversion is accepted while every
other byte change remains blocking.
The receipt must be produced by the persistent Codex App orchestrator from
the real task that stayed open across the compatible upgrade. It contains no
raw task, context, route, or outcome identifiers—only their SHA-256 digests—
and records the candidate commit, unchanged root model, old/new runtime,
native-versus-bridge transport, shim status, exactly one delegated target and
recorded outcome, and `desktopStayedOpen=true`. The runner rejects a receipt
for another candidate; the schema validator rejects mismatched identity pairs
or a CLI-only lifecycle.
Start from `docs/release-evidence/templates/continuity-receipt-v1.json`; never
copy forward a receipt or fill it from a new/forked task.
Review and trust all four hooks (`SessionStart(source=compact)`,
`SubagentStart`, `UserPromptSubmit`, and `Stop`) before running it. A failure produces only
stable warning codes in the artifact; raw prompts, events, session/context
identifiers, errors, source, secrets, logs, and absolute paths are excluded.
Hook trust is the only required interactive action. After trust, the canonical
runner owns every prompt, control message, model-slug transition, verification,
and final restoration; it must not ask the operator to repeat sections 5 or 6.

The runner refuses to use the default Codex Home. Prepare a disposable Windows
test account or dedicated Codex Home, add the explicit smoke marker, log in
there, install the exact candidate once, and trust its four Hook hashes. A real
Desktop task in that Home is mandatory for the compatible-upgrade continuity
gate; the runner's disposable CLI lifecycle is supplementary. Then expose only
that directory to the runner:

```powershell
$SmokeCodexHome = 'D:\codex-smoke-home'
New-Item -ItemType Directory -Force -Path $SmokeCodexHome | Out-Null
Set-Content -LiteralPath (Join-Path $SmokeCodexHome '.adaptive-router-smoke-home') -Value 'adaptive-model-router smoke home v1' -NoNewline
$env:CODEX_HOME = $SmokeCodexHome
$env:ADAPTIVE_ROUTER_SMOKE_CODEX_HOME = $SmokeCodexHome
$ContinuityReceipt = Join-Path $SmokeCodexHome 'redacted-continuity-receipt.json'
.\scripts\windows-smoke.ps1 `
  -CandidateRef 'codex/v040-hot-upgrade-release' `
  -ContinuityReceiptPath $ContinuityReceipt
```

All plugin, marketplace, AGENTS marker, global-routing, session, and learning
mutations are confined to this dedicated home. Delete it after retaining the
validated evidence. The runner intentionally will not copy authentication or
trust state out of the operator's normal Codex Home.
It also rejects filesystem roots and broad system/user directories even when a
marker is present. The marker explicitly declares that the directory may be
mutated by install, upgrade, uninstall, AGENTS, session, and learning tests.

Suggested handoff prompt after the four Hook definitions are trusted:

```text
请完整读取 docs/WINDOWS_SMOKE.md。在我完成四个 Hook 的审查和信任后，只运行
使用 Codex App 原生任务协调为同一 Desktop 任务生成脱敏 continuity receipt，然后运行
scripts/windows-smoke.ps1 的 canonical 自动流程；不要让我手工粘贴第 5/6 节提示、
切换模型或发送 router 控制。遇到 Stop conditions 中任一情况立即停止并返回 FAIL。
不要创建或推送 v0.4.0 tag，也不要调用 clear_project_data。
```

## Pass criteria

The smoke passes only when all of the following succeed:

- installation from the frozen reviewed candidate ref with the two native
  Codex commands while published `stable` remains on v0.3.0;
- the exact cloned candidate passes `npm test`, `npm run validate`, and
  `npm run eval`, and the installed marketplace metadata or Git checkout
  identity equals the reviewed repository, ref, and cloned 40-character commit
  SHA before and after lifecycle testing;
- review and trust of all four plugin-bundled command hooks, including
  `SessionStart(source=compact)`;
- one persisted global automatic-routing opt-in and an ordinary substantive
  task that does not name the skill or repeat a trigger phrase;
- one substantive `delegate` route and exactly one bounded subagent using the
  returned model and effort;
- confirmation that `delegate` is executed as the applicable skill's explicit
  authorization under conditional multi-agent policies, never weakened into a
  suggestion, blanket prohibition, user re-authorization request, or silent
  root-only continuation;
- bounded-subagent isolation: no recursive route, root-model intent event,
  control mutation, or child-owned outcome;
- host capabilities containing only Sol/Terra never return Luna as the bounded
  target; explicit Luna returns `ask_user` without starting a subagent;
- root verification followed by one strict final outcome;
- visible status/history that preserve the root-model versus bounded-target
  boundary and include the delegated route;
- two host-model slug transitions that stay root-only while pending, including
  a distinct second event, keep-automatic, current-task manual-root behavior,
  and restoration of the initial model;
- machine-verified route and execution metadata showing that the root-model
  boundary remains unchanged while the bounded target is recorded separately;
- redacted status and diagnostics with no prompt, source, secret, or absolute
  project path;
- native upgrade and uninstall;
- idempotent PowerShell wrapper install/upgrade/uninstall/reinstall;
- one real Desktop task kept open across a compatible upgrade, followed in the
  same Hook-injected context by one ordered `route_stage → delegate →
  record_outcome` lifecycle with unchanged root model and the expected native
  or `stdio-bridge` transport;
- visible shim path/ownership/reduced-`PATH` evidence whenever continuity uses
  an already-loaded bare command; skipped or unverifiable shim setup fails;
- optional AGENTS marker insertion exactly once and complete marker removal.

## 1. Prerequisites

- Windows 11, running natively.
- A logged-in current Codex Desktop session for the same-task continuity gate;
  the canonical CLI session remains supplementary orchestration evidence.
- A dedicated, disposable Codex Home named by
  `ADAPTIVE_ROUTER_SMOKE_CODEX_HOME`; the default `~/.codex` is rejected.
- Git.
- Node.js 24.15.0 or newer.
- PowerShell as the agent/terminal environment.

Record the environment evidence:

```powershell
$DedicatedCodexHome = [IO.Path]::GetFullPath($env:ADAPTIVE_ROUTER_SMOKE_CODEX_HOME)
$env:CODEX_HOME = $DedicatedCodexHome
[System.Environment]::OSVersion.VersionString
node --version
git --version
codex --version
```

Stop if Node is older than `24.15.0` or Codex is not logged in.

## 2. Clone into a path with spaces and Unicode

```powershell
$CandidateRef = "codex/v040-hot-upgrade-release"
$SmokeRoot = Join-Path $env:TEMP ("Adaptive Router Windows 冒烟 " + (Get-Date -Format "yyyyMMdd-HHmmss"))
$Source = Join-Path $SmokeRoot "source checkout"
$Project = Join-Path $SmokeRoot "测试 project with spaces"

New-Item -ItemType Directory -Force -Path $SmokeRoot | Out-Null
git clone --branch $CandidateRef --single-branch https://github.com/Neil0619/adaptive-model-router.git $Source
$CandidateCommit = (git -C $Source rev-parse HEAD).Trim()
New-Item -ItemType Directory -Force -Path $Project | Out-Null
Set-Location $Project
git init
```

This covers a Windows drive path, backslashes, spaces, and non-ASCII
characters. Keep `$Source` and `$Project` for the complete smoke run.

## 3. Install through native Codex commands

```powershell
codex plugin marketplace list
codex plugin list
```

Before replacing an earlier candidate with the same plugin version, fully exit
Codex Desktop and every Codex CLI session. An active plugin MCP process uses
the cached plugin directory as its working directory on Windows, so the native
`plugin add` backup step can otherwise fail with a file-in-use or access-denied
error. If this runbook was handed to an active Codex task, checkpoint the task,
exit Codex, run the native remove/add commands below from an external
PowerShell window, then reopen the task. Run each mutating command separately;
do not let a later list command hide an earlier nonzero exit status.

If a same-name marketplace remains from this repository's earlier `stable`
smoke, remove only that known plugin and marketplace before adding the
candidate ref. If no same-name marketplace exists, skip the first two commands:

```powershell
codex plugin remove adaptive-model-router@adaptive-model-router
codex plugin marketplace remove adaptive-model-router
codex plugin marketplace add Neil0619/adaptive-model-router --ref $CandidateRef
codex plugin add adaptive-model-router@adaptive-model-router
codex plugin marketplace list
codex plugin list
```

If the same-name marketplace points to any other repository, stop and report
it. Do not silently replace an unrelated marketplace.

## 4. Start a fresh task and trust hooks

Open `$Project` as a project in Codex Desktop, or start the CLI there:

```powershell
Set-Location $Project
codex
```

In the new task:

1. Open `/hooks`.
2. Review and trust the plugin's `SubagentStart` handler.
3. Review and trust the plugin's `UserPromptSubmit` handler.
4. Review and trust the plugin's `Stop` handler.
5. Do not use `--dangerously-bypass-hook-trust`.

If the plugin or hooks are not visible, restart the ChatGPT desktop app and
start another new task. If they remain unavailable, stop and report the failure.

After Hook trust is complete, exit the interactive trust task so the installed
plugin cache is no longer active. Start the canonical runner from the external
PowerShell window. The runner sends this exact-prefix control through its
dedicated persistent CLI session:

```text
router: global on
```

The trusted `UserPromptSubmit` Hook must process the control. The runner then
sends `router: status`, independently reads installed router state, and proves
that global automatic routing is on, task mode is automatic, and the first
valid host model establishes only a baseline. No manual prompt, `/statusline`
configuration, or `/status` transcription is part of the blocking gate.

An operator may optionally watch the Desktop selector or CLI model status line
while the runner executes. This is a non-blocking UX observation only; absence
of that visual witness cannot change an otherwise valid canonical artifact.

## 5. Run the route → subagent → verification → outcome smoke

Do not paste an implementation prompt or create a separate smoke task. The
canonical runner seeds a deterministic fixture and owns the complete managed
route lifecycle. Its ordinary prompt intentionally does not name the skill or
contain a router control prefix.

The runner requires exactly one `delegate` route, one bounded subagent using the
returned target model and effort, one completed wait, root-owned verification,
and exactly one strict `record_outcome`. It proves the root boundary remains
unchanged, the child does not route recursively or own the outcome, and the
ordered lifecycle is route → spawn → completed wait → outcome. The native host
then executes the fixture tests and checks that neither the managed review nor
the tests changed the fixture.

The runner validates both fixed-key review summaries against the
`structured-check` gate and reads only the required lifecycle metadata from the
dedicated smoke Home. Status, history, diagnostics, and learning reports must
remain redacted and show a healthy database, a versioned scoring profile, zero
pending outcomes, and zero unexpected Stop-finalized unknown outcomes. These
assertions are blocking and are derived from JSONL lifecycle and
installed-router state, not from an operator transcription.

The returned `delegate` action is the applicable skill's explicit authorization
under conditional multi-agent policies and must produce the one bounded
SubagentStart recorded by the canonical runner. It is required, not a
suggestion: a blanket prohibition, user re-authorization request, or silent
root-only continuation fails the gate unless the host subagent tool actually
rejects the declared target and the documented tooling-failure flow runs.

## 6. Exercise host-model intent protection

The runner establishes a `gpt-5.6-sol` baseline in its disposable session, then
uses the host CLI's `-m` argument on resumed turns to select
`gpt-5.6-terra`. Two ordinary review turns must remain root-only with
`HOST_MODEL_INTENT_PENDING`, create no bounded work, and reuse one pending
change ID. The runner then sends `router: auto session` and verifies that the
pending event is resolved.

The runner next returns the disposable session to `gpt-5.6-sol`, creates a new
pending event, sends `router: manual`, and proves that a substantive route
returns `continue` with `MANUAL_ROOT_SELECTED` and no subagent. Finally it sends
`router: auto session`, verifies automatic mode, and leaves no pending change.
This Sol → Terra → Sol sequence is confined to the dedicated smoke session and
does not alter the operator's normal Codex environment.

The Hook cannot observe reasoning effort, so effort-only changes remain outside
this contract. A visible `/model` selector exercise may be performed as an
optional non-blocking host UX check, but it must never be required to establish
the router's host-model-intent PASS result.

## 7. Verify an ordinary prompt does not act as a control

The runner disables the router for its current session with this standalone
exact-prefix user message:

```text
router: off
```

It then sends this separate ordinary prompt, which does not begin with a
control prefix:

```text
Discuss the quoted text `router: on` without changing router state. Then call
route_stage for a substantive implementation stage using the same current
session contextId and hostCapabilities.delegation. Return only the redacted
route.
```

The route must return `continue` with `ROUTER_DISABLED`. The runner restores
normal behavior with this standalone user message:

```text
router: auto session
```

## 8. Exercise scoring-evolution visibility

In the same temporary project, the runner asks Codex to call
`get_learning_status`, then `shadow_route_stage` for a risk-sensitive review
using the active scoring definition. It confirms:

- database version 3 is healthy and the active scoring profile is versioned;
- learning status contains only redacted aggregates and enum/numeric fields;
- shadow output reports `shadow: true` and `sideEffects: false`;
- route, outcome, proposal, and learning-cursor counts do not change;
- the completed smoke outcome includes all four `retryBreakdown` counters and
  their sum equals `retries`.

The runner uses this exact prompt for the shadow check:

```text
This is read-only router inspection, not a substantive work-product stage.
Call shadow_route_stage exactly once for a risk-sensitive review using the
active scoring definition and the same current task contextId. Do not call
route_stage before or after it, do not pass hostCapabilities, and do not create
a subagent or record an outcome. Then call get_learning_status once more.
Return only: shadow, sideEffects, preferred family/effort, active profile
identity/version, and shadow_route_stage's stateCounts before/after object.
```

Stop immediately if a live route appears, any count changes, or the Stop hook
requests an outcome for the shadow preference.

The automated suite covers destructive re-anchor, proposal rebase, and hard
safety auto-rollback. Do not mutate the smoke project's active profile.

## 9. Exercise upgrade, uninstall, and wrappers

The runner stops the smoke target and every Adaptive Router launcher/server,
then executes the native lifecycle below as an explicitly destructive cold
replacement test. These commands are not the compatible hot-upgrade path and
the operator does not run them as separate smoke steps:

```powershell
codex plugin marketplace upgrade adaptive-model-router
codex plugin add adaptive-model-router@adaptive-model-router
codex plugin remove adaptive-model-router@adaptive-model-router
codex plugin marketplace remove adaptive-model-router
```

It then tests the repository wrapper from the Unicode checkout:

```powershell
Set-Location $Source
.\install.ps1 -PatchAgents -Ref $CandidateRef
.\install.ps1 -Action Upgrade -PatchAgents -VerifyTaskTools -Ref $CandidateRef
```

For the compatible upgrade, `-VerifyTaskTools` runs pinned in-place MCP, Hook,
and stdio-bridge probes and must not launch a disposable CLI task. The persistent
native smoke target remains the blocking continuity consumer.

Verify the owned marker occurs exactly once:

```powershell
$AgentsPath = Join-Path $DedicatedCodexHome 'AGENTS.md'
# This token is intentionally stable for backward-compatible owned-block removal.
$StartMarker = "<!-- adaptive-model-router:start v0.2.0 -->"
$EndMarker = "<!-- adaptive-model-router:end -->"
$AgentsText = if (Test-Path $AgentsPath) { Get-Content -Raw $AgentsPath } else { "" }

if ([regex]::Matches($AgentsText, [regex]::Escape($StartMarker)).Count -ne 1) { throw "start marker count is not one" }
if ([regex]::Matches($AgentsText, [regex]::Escape($EndMarker)).Count -ne 1) { throw "end marker count is not one" }
```

Uninstall and verify that only the owned block is removed:

```powershell
.\install.ps1 -Action Uninstall -Ref $CandidateRef
$AgentsText = if (Test-Path $AgentsPath) { Get-Content -Raw $AgentsPath } else { "" }

if ($AgentsText.Contains($StartMarker) -or $AgentsText.Contains($EndMarker)) { throw "owned AGENTS marker remains after uninstall" }
```

The runner finishes with two candidate-ref installs to prove idempotence and
leave the candidate installed without patching AGENTS:

```powershell
.\install.ps1 -Ref $CandidateRef
.\install.ps1 -Ref $CandidateRef
codex plugin marketplace list
codex plugin list
```

The runner confirms that wrapper output distinguishes cold host-surface
replacement from later compatible v0.4.x+ runtime-only updates, and that the
compatible path never invokes `plugin add` or requests Desktop plugin
re-registration. It also verifies the strict stable-plugin-data vault and any
indexed historical-cache restoration, and requires matching `liveWorkflowContractVersion` and
`stdioBridgeContractVersion` values.
The automated `runtime-hot-upgrade.test.mjs` must have demonstrated one
long-lived MCP process, concurrent old Hook shells, damaged-candidate
quarantine, active-runtime rollback, and a path-free pointer. That
implementation test is not same-task Desktop evidence.

Before the compatible wrapper upgrade, keep one real Desktop task open and
record its task/thread identity, Hook-injected Router context, root-model
baseline, active runtime, and native-versus-frozen inventory state. Run the
upgrade without closing Desktop or reopening, forking, or replacing that task.
Then dispatch an ordinary substantive stage to that same task and require one
ordered `route_stage → delegate → record_outcome` lifecycle. Verify one
bounded target, one final outcome, unchanged root model, the new compatible
runtime, and the expected native or `stdio-bridge` transport. A local fail-open,
shim/bridge skip, changed consumer identity, or missing outcome fails the
canonical smoke. Hook JSON, MCP schemas, storage semantics, Skill identity/UI
metadata, or either workflow contract changing incompatibly remains a cold-
replacement and genuinely-new-non-forked-task boundary.

The runner starts Codex again from a second temporary project without sending
`router: global on` again:

```powershell
$Project2 = Join-Path $SmokeRoot "第二个 project"
New-Item -ItemType Directory -Force -Path $Project2 | Out-Null
Set-Location $Project2
git init
codex
```

An unchanged trusted Hook hash must not require another normal operator step.
If Codex unexpectedly asks again, stop and investigate the installed candidate
identity or trust record. The runner sends `router: status` and proves global
automatic routing remains on while the new task has its own automatic mode and
root-model baseline. This confirms persistence across reinstall/restart and
isolation of task-specific manual state.

## 10. Canonical report

Retain the generated `windows.json`, `windows.md`, and
`windows.json.sha256` files. The validated JSON artifact is the sole
functional source of truth for sections 5–9. It binds the frozen candidate,
environment, all 17 blocking checks, route/target/gate summary, settled outcome
counts, diagnostics, and privacy result. No separate operator-completed report
or model-selector transcript is required.

The artifact must also bind the pre/post-upgrade task/thread identity, exact
Router context, root-model baseline, old/new runtime, transport, route ID, and
recorded outcome for the same-Desktop-task continuity gate. The validator
requires these bindings and rejects CLI-only evidence.

Record that the four current Hook definitions were reviewed and trusted before
the run. An optional visual UX note may state whether the Desktop selector or
CLI model status line was observed, but it is not part of the canonical
artifact and cannot change the release gate.

## Stop conditions

Mark the smoke `FAIL` and do not create the release tag if any required step
fails, the route does not return `delegate`, a returned `delegate` is weakened
into a suggestion or no real SubagentStart occurs without an actual host-tool
rejection, the host cannot use the returned model/effort, a hook cannot be
trusted, a model-change request delegates while pending/manual, an outcome
remains pending, diagnostics leak sensitive content or an absolute project
path, or installation is not idempotent.

Do not call `clear_project_data` as part of this smoke. Uninstall deliberately
leaves learning data intact.
