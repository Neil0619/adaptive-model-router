[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._/-]*$')]
    [string]$CandidateRef,

    [string]$OutputDirectory,

    [string]$SmokeWorkspaceRoot = [string]$env:ADAPTIVE_ROUTER_SMOKE_ROOT,

    [switch]$ValidateZeroApprovalContract
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Repository = 'https://github.com/Neil0619/adaptive-model-router.git'
$SmokeId = [guid]::NewGuid().ToString('N')
$SmokeRoot = $null
$Source = $null
$Project = $null
$Project2 = $null
$HookProject = $null
$RawRoot = $null
$ManagedCodexPath = $null
$ManagedShellPathConfig = $null
$CommandShimPath = Join-Path $PSScriptRoot 'invoke-command-shim.ps1'
$DedicatedCodexHome = [string]$env:ADAPTIVE_ROUTER_SMOKE_CODEX_HOME
$OriginalCodexHome = [string]$env:CODEX_HOME
$Checks = [Collections.Generic.List[object]]::new()
$Warnings = [Collections.Generic.List[string]]::new()
$RequiredWindowsChecks = @(
    'native-preflight',
    'candidate-frozen',
    'candidate-automated-gate',
    'native-install',
    'installed-candidate-integrity',
    'hook-trust-and-global-on',
    'route-subagent-outcome',
    'root-target-boundary',
    'capability-boundary',
    'redacted-observability',
    'learning-and-shadow',
    'host-model-intent',
    'negative-control',
    'native-and-wrapper-lifecycle',
    'cross-project-persistence',
    'final-state-settled'
)
$SessionId = $null
$InitialRootModel = $null
$InstalledRouterLauncher = $null
$InstalledRouterCli = $null
$CandidateCommit = ('0' * 40)
$PluginTreeSha256 = ('0' * 64)
$RouteEvidence = [ordered]@{
    action = 'unavailable'
    targetFamily = 'none'
    targetEffort = 'none'
    verificationGate = 'unavailable'
    pendingOutcomes = 0
    stopHookUnknown = 0
}
$DiagnosticEvidence = [ordered]@{
    databaseHealth = 'unavailable'
    classifierState = 'unavailable'
    privacy = 'FAIL'
}
$EnvironmentEvidence = [ordered]@{
    platform = 'windows'
    surface = 'cli'
    osVersion = [Environment]::OSVersion.VersionString
    codexVersion = 'unavailable'
    nodeVersion = 'unavailable'
    gitVersion = 'unavailable'
}
$PermissionEvidence = [ordered]@{
    contract = 'zero-approval-v1'
    hostProfile = 'unavailable'
    hostApprovalPolicy = 'unavailable'
    managedApprovalPolicy = 'never'
    managedSandboxMode = 'read-only'
    approvalRequests = 0
    sandboxEscalations = 0
    permissionFailures = 0
}

function Register-CodexPermissionTelemetry {
    param(
        [AllowNull()][object[]]$Events,
        [AllowNull()][string]$Text
    )
    foreach ($event in @($Events)) {
        $eventType = if ($null -ne $event -and $event.PSObject.Properties.Name -contains 'type') { [string]$event.type } else { '' }
        $itemType = if ($null -ne $event -and $event.PSObject.Properties.Name -contains 'item' -and $null -ne $event.item -and $event.item.PSObject.Properties.Name -contains 'type') { [string]$event.item.type } else { '' }
        if ($eventType -match '(?i)(?:approval.*request|request.*approval)' -or $itemType -match '(?i)(?:approval.*request|request.*approval)') {
            $PermissionEvidence.approvalRequests = [int]$PermissionEvidence.approvalRequests + 1
            $PermissionEvidence.sandboxEscalations = [int]$PermissionEvidence.sandboxEscalations + 1
        }
        elseif ($eventType -match '(?i)(?:sandbox.*escalat|escalat.*sandbox)' -or $itemType -match '(?i)(?:sandbox.*escalat|escalat.*sandbox)') {
            $PermissionEvidence.sandboxEscalations = [int]$PermissionEvidence.sandboxEscalations + 1
        }
        if ($eventType -in @('error', 'turn.failed')) {
            $eventText = $event | ConvertTo-Json -Depth 30 -Compress
            if ($eventText -match '(?i)(?:CreateProcessAsUserW failed|windows sandbox: runner failed|access is denied|permission denied|拒绝访问)') {
                $PermissionEvidence.permissionFailures = [int]$PermissionEvidence.permissionFailures + 1
            }
        }
        elseif ($eventType -eq 'item.completed' -and $itemType -eq 'command_execution' -and [string]$event.item.status -eq 'failed') {
            $commandFailure = [string]$event.item.aggregated_output
            if ($commandFailure -match '(?i)(?:CreateProcessAsUserW failed|windows sandbox: runner failed|access is denied|permission denied|拒绝访问)') {
                $PermissionEvidence.permissionFailures = [int]$PermissionEvidence.permissionFailures + 1
            }
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($Text) -and $Text -match '(?i)(?:CreateProcessAsUserW failed|windows sandbox: runner failed|access is denied|permission denied|拒绝访问)') {
        $PermissionEvidence.permissionFailures = [int]$PermissionEvidence.permissionFailures + 1
    }
}

function Add-SmokeCheck {
    param(
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][bool]$Blocking,
        [Parameter(Mandatory = $true)][ValidateSet('PASS', 'FAIL', 'SKIP')][string]$Status
    )
    $existing = @($Checks | Where-Object { $_.id -eq $Id })
    if ($existing.Count -ne 0) { throw "duplicate smoke check id: $Id" }
    $Checks.Add([ordered]@{ id = $Id; blocking = $Blocking; status = $Status })
}

function Add-WarningCode {
    param([Parameter(Mandatory = $true)][ValidatePattern('^[A-Z][A-Z0-9_]{2,63}$')][string]$Code)
    if (-not $Warnings.Contains($Code)) { $Warnings.Add($Code) }
}

function Resolve-ProcessCommand {
    param([Parameter(Mandatory = $true)][string]$Name)
    if ([IO.Path]::IsPathFullyQualified($Name)) {
        $commands = @([pscustomobject]@{ Source = $Name; Extension = [IO.Path]::GetExtension($Name) })
    }
    else {
        $commands = @(
            Get-Command -Name $Name -All -ErrorAction Stop |
                Where-Object { $_.Source } |
                ForEach-Object { [pscustomobject]@{ Source = $_.Source; Extension = [IO.Path]::GetExtension($_.Source) } }
        )
    }
    # Do not launch npm/codex shims through a Store-installed pwsh.exe. Store
    # PowerShell prepends its WindowsApps package directory to PATH at startup,
    # undoing the managed PATH filter before Codex detects its default shell.
    $selected = @($commands | Where-Object { $_.Extension -in @('.cmd', '.bat') } | Select-Object -First 1)
    if ($selected.Count -eq 0) { $selected = @($commands | Where-Object { $_.Extension -eq '.exe' -and $_.Source -notmatch '(?i)[\\/]WindowsApps(?:[\\/]|$)' } | Select-Object -First 1) }
    if ($selected.Count -eq 0) { $selected = @($commands | Where-Object { $_.Extension -eq '.ps1' } | Select-Object -First 1) }
    if ($selected.Count -eq 0) { $selected = @($commands | Where-Object { $_.Extension -notin @('.cmd', '.bat', '.exe', '.ps1', '') } | Select-Object -First 1) }
    if ($selected.Count -eq 0) {
        throw "no non-Store executable or script command was found for $Name"
    }
    if ($selected[0].Extension -eq '.ps1') {
        $systemPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        if (-not (Test-Path -LiteralPath $systemPowerShell -PathType Leaf)) {
            throw 'system Windows PowerShell is required to launch PowerShell scripts without WindowsApps PATH reinjection'
        }
        return [pscustomobject]@{ FilePath = $systemPowerShell; Prefix = @('-NoProfile', '-File', [string]$selected[0].Source) }
    }
    if ($selected[0].Extension -in @('.cmd', '.bat')) {
        $systemPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        if (-not (Test-Path -LiteralPath $systemPowerShell -PathType Leaf)) {
            throw 'system Windows PowerShell is required to launch command shims without WindowsApps PATH reinjection'
        }
        return [pscustomobject]@{ FilePath = $systemPowerShell; Prefix = @('-NoProfile', '-File', $CommandShimPath, [string]$selected[0].Source) }
    }
    return [pscustomobject]@{ FilePath = [string]$selected[0].Source; Prefix = @() }
}

function Invoke-Process {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList,
        [string]$WorkingDirectory = $PWD.Path,
        [hashtable]$EnvironmentOverrides,
        [switch]$AllowFailure
    )
    $resolvedCommand = Resolve-ProcessCommand -Name $FilePath
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $resolvedCommand.FilePath
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    if ($EnvironmentOverrides) {
        foreach ($entry in $EnvironmentOverrides.GetEnumerator()) {
            if ($null -eq $entry.Value) {
                [void]$startInfo.Environment.Remove([string]$entry.Key)
            }
            else {
                $startInfo.Environment[[string]$entry.Key] = [string]$entry.Value
            }
        }
    }
    foreach ($argument in (@($resolvedCommand.Prefix) + $ArgumentList)) { [void]$startInfo.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        try {
            if (-not $process.Start()) { throw "unable to start process" }
        }
        catch {
            Register-CodexPermissionTelemetry -Text $_.Exception.Message
            throw
        }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0 -and -not $AllowFailure) {
            Register-CodexPermissionTelemetry -Text $stderr
            throw "process failed with exit code $($process.ExitCode)"
        }
        return [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = $stdout; Stderr = $stderr }
    }
    finally {
        $process.Dispose()
    }
}

function Invoke-CodexTurn {
    param(
        [Parameter(Mandatory = $true)][string]$Prompt,
        [Parameter(Mandatory = $true)][string]$Model,
        [string]$ResumeSession,
        [string]$WorkingProject = $Project
    )
    $lastMessage = Join-Path $RawRoot (([guid]::NewGuid().ToString('N')) + '.last.txt')
    if ($ResumeSession) {
        $arguments = @('-a', 'never', '-s', 'read-only', 'exec', '-c', $ManagedShellPathConfig, 'resume', '--json', '-o', $lastMessage, '-m', $Model, $ResumeSession, $Prompt)
    }
    else {
        $arguments = @('-a', 'never', '-s', 'read-only', 'exec', '-c', $ManagedShellPathConfig, '--json', '-o', $lastMessage, '-C', $WorkingProject, '-m', $Model, $Prompt)
    }
    $result = Invoke-Process -FilePath 'codex' -ArgumentList $arguments -WorkingDirectory $WorkingProject -EnvironmentOverrides @{ PATH = $ManagedCodexPath }
    $events = [Collections.Generic.List[object]]::new()
    foreach ($line in ($result.Stdout -split "`r?`n")) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $events.Add(($line | ConvertFrom-Json -Depth 30)) } catch { throw 'Codex emitted a non-JSON event in --json mode' }
    }
    Register-CodexPermissionTelemetry -Events @($events) -Text $result.Stderr
    $thread = @($events | Where-Object { $_.type -eq 'thread.started' } | Select-Object -Last 1)
    $resolvedSession = if ($ResumeSession) { $ResumeSession } elseif ($thread.Count -eq 1) { [string]$thread[0].thread_id } else { $null }
    if ([string]::IsNullOrWhiteSpace($resolvedSession)) { throw 'Codex did not emit thread.started' }
    if (-not (Test-Path -LiteralPath $lastMessage -PathType Leaf)) { throw 'Codex did not write its final response' }
    $lastMessageText = Get-Content -LiteralPath $lastMessage -Raw
    if ([string]::IsNullOrWhiteSpace($lastMessageText)) { throw 'Codex wrote an empty final response' }
    return [pscustomobject]@{ SessionId = $resolvedSession; Events = $events; LastMessage = $lastMessageText }
}

function Read-RouterState {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('doctor', 'status', 'history', 'learning')][string]$Command,
        [Parameter(Mandatory = $true)][string]$Context,
        [Parameter(Mandatory = $true)][string]$WorkingProject
    )
    if ([string]::IsNullOrWhiteSpace($InstalledRouterLauncher) -or [string]::IsNullOrWhiteSpace($InstalledRouterCli)) {
        throw 'installed router state reader is unavailable'
    }
    $arguments = @($InstalledRouterLauncher, $InstalledRouterCli, $Command, '--context', $Context)
    if ($Command -eq 'history') { $arguments += @('--limit', '50', '--action', 'all') }
    $result = Invoke-Process -FilePath 'node' -ArgumentList $arguments -WorkingDirectory $WorkingProject
    return ($result.Stdout | ConvertFrom-Json -Depth 50)
}

function Test-ReasonCode {
    param([Parameter(Mandatory = $true)]$History, [Parameter(Mandatory = $true)][string]$Code)
    return @($History.routes | Where-Object { @($_.reasonCodes) -contains $Code }).Count -gt 0
}

function Get-ToolCallItems {
    param([Parameter(Mandatory = $true)][object[]]$Events, [Parameter(Mandatory = $true)][string]$Tool)
    $items = @{}
    foreach ($event in $Events) {
        if ($event.PSObject.Properties.Name -notcontains 'item' -or $null -eq $event.item) { continue }
        $toolName = if ($event.item.PSObject.Properties.Name -contains 'tool') { [string]$event.item.tool } elseif ($event.item.PSObject.Properties.Name -contains 'name') { [string]$event.item.name } else { '' }
        if ($toolName -eq $Tool -or $toolName.EndsWith("__$Tool", [StringComparison]::Ordinal)) {
            $items[[string]$event.item.id] = $event.item
        }
    }
    return @($items.Values)
}

function Get-FirstToolEventIndex {
    param([Parameter(Mandatory = $true)][object[]]$Events, [Parameter(Mandatory = $true)][string]$Tool)
    for ($index = 0; $index -lt $Events.Count; $index += 1) {
        $event = $Events[$index]
        if ($event.PSObject.Properties.Name -notcontains 'item' -or $null -eq $event.item) { continue }
        $toolName = if ($event.item.PSObject.Properties.Name -contains 'tool') { [string]$event.item.tool } elseif ($event.item.PSObject.Properties.Name -contains 'name') { [string]$event.item.name } else { '' }
        if ($toolName -eq $Tool -or $toolName.EndsWith("__$Tool", [StringComparison]::Ordinal)) { return $index }
    }
    return -1
}

function Get-NestedPropertyValue {
    param(
        [AllowNull()][object]$InputObject,
        [Parameter(Mandatory = $true)][string[]]$Path
    )
    $value = $InputObject
    foreach ($segment in $Path) {
        if ($null -eq $value) { return $null }
        $property = $value.PSObject.Properties[$segment]
        if ($null -eq $property) { return $null }
        $value = $property.Value
    }
    return $value
}

function Read-CodexSessionTrace {
    param([Parameter(Mandatory = $true)][string]$Context)
    $sessionRoot = Join-Path $DedicatedCodexHome 'sessions'
    $sessionFiles = @(Get-ChildItem -LiteralPath $sessionRoot -Recurse -File -Filter ("*-{0}.jsonl" -f $Context))
    if ($sessionFiles.Count -ne 1) { throw 'Codex parent session trace was not uniquely identifiable' }
    $entries = [Collections.Generic.List[object]]::new()
    foreach ($line in (Get-Content -LiteralPath $sessionFiles[0].FullName)) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $entries.Add(($line | ConvertFrom-Json -Depth 50)) } catch { throw 'Codex parent session trace contains invalid JSONL' }
    }
    return @($entries)
}

function Read-BoundedSubagentExecution {
    param(
        [Parameter(Mandatory = $true)][string]$ParentContext,
        [Parameter(Mandatory = $true)][string]$AgentPath,
        [Parameter(Mandatory = $true)][datetime]$StartedAfter
    )
    $sessionRoot = Join-Path $DedicatedCodexHome 'sessions'
    $matches = [Collections.Generic.List[object]]::new()
    foreach ($file in (Get-ChildItem -LiteralPath $sessionRoot -Recurse -File -Filter '*.jsonl' | Where-Object { $_.LastWriteTimeUtc -ge $StartedAfter.AddSeconds(-2) })) {
        $entries = [Collections.Generic.List[object]]::new()
        $isMatch = $false
        foreach ($line in (Get-Content -LiteralPath $file.FullName)) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            try { $entry = $line | ConvertFrom-Json -Depth 50 } catch { throw 'Codex bounded-subagent trace contains invalid JSONL' }
            $entries.Add($entry)
            $spawn = Get-NestedPropertyValue -InputObject $entry -Path @('payload', 'source', 'subagent', 'thread_spawn')
            if ($null -ne $spawn -and [string](Get-NestedPropertyValue -InputObject $spawn -Path @('parent_thread_id')) -eq $ParentContext -and [string](Get-NestedPropertyValue -InputObject $spawn -Path @('agent_path')) -eq $AgentPath) { $isMatch = $true }
        }
        if ($isMatch) { $matches.Add(@($entries)) }
    }
    if ($matches.Count -ne 1) { throw 'bounded-subagent execution trace was not uniquely identifiable' }
    $turnContexts = @($matches[0] | Where-Object {
        (Get-NestedPropertyValue -InputObject $_ -Path @('type')) -eq 'turn_context' -and
        -not [string]::IsNullOrWhiteSpace([string](Get-NestedPropertyValue -InputObject $_ -Path @('payload', 'model'))) -and
        -not [string]::IsNullOrWhiteSpace([string](Get-NestedPropertyValue -InputObject $_ -Path @('payload', 'effort')))
    })
    if ($turnContexts.Count -lt 1) { throw 'bounded-subagent execution trace lacks model and effort metadata' }
    return [pscustomobject]@{
        Model = [string](Get-NestedPropertyValue -InputObject $turnContexts[-1] -Path @('payload', 'model'))
        Effort = [string](Get-NestedPropertyValue -InputObject $turnContexts[-1] -Path @('payload', 'effort'))
    }
}

function Get-NewRoutes {
    param(
        [Parameter(Mandatory = $true)]$Before,
        [Parameter(Mandatory = $true)]$After
    )
    $beforeIds = @($Before.routes | ForEach-Object { [string]$_.routeId })
    return @($After.routes | Where-Object { [string]$_.routeId -notin $beforeIds })
}

function Assert-NoDelegatedWork {
    param(
        [Parameter(Mandatory = $true)]$Turn,
        [Parameter(Mandatory = $true)]$Route
    )
    if (@(Get-ToolCallItems -Events $Turn.Events -Tool 'spawn_agent').Count -ne 0) { throw 'a root-only route created a subagent' }
    if (@(Get-ToolCallItems -Events $Turn.Events -Tool 'record_outcome').Count -ne 0) { throw 'a root-only route recorded a child outcome' }
    $target = $Route.PSObject.Properties['target']
    if ($null -ne $target -and $null -ne $target.Value) { throw 'a root-only route returned a bounded target' }
}

function Assert-PrivateProjection {
    param([Parameter(Mandatory = $true)][object[]]$Values)
    $serialized = $Values | ConvertTo-Json -Depth 50 -Compress
    if ($serialized.Contains($Project, [StringComparison]::OrdinalIgnoreCase)) { throw 'router projection contains the smoke project path' }
    if ($serialized -match '(?:[A-Za-z]:[\\/]|\\\\)[^\s"}]+' -or $serialized -match '(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{12,}') {
        throw 'router projection contains path-like or secret-like text'
    }
}

function Get-ModelFamily {
    param([AllowNull()][string]$Model)
    if ($Model -match 'sol') { return 'sol' }
    if ($Model -match 'terra') { return 'terra' }
    if ($Model -match 'luna') { return 'luna' }
    return 'none'
}

function Get-PluginTreeHash {
    param([Parameter(Mandatory = $true)][string]$Commit)
    $listing = Invoke-Process -FilePath 'git' -ArgumentList @('-C', $Source, 'ls-tree', '-r', '--full-tree', $Commit, 'plugins/adaptive-model-router')
    $bytes = [Text.Encoding]::UTF8.GetBytes($listing.Stdout.Replace("`r`n", "`n"))
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}

function Assert-CandidateGateFiles {
    $comparator = Join-Path $Source 'scripts\compare-gate-content.mjs'
    if (-not (Test-Path -LiteralPath $comparator -PathType Leaf)) { throw 'the frozen candidate is missing its gate-file comparator' }
    $pairs = @(
        @((Join-Path $PSScriptRoot 'windows-smoke.ps1'), (Join-Path $Source 'scripts\windows-smoke.ps1')),
        @((Join-Path $PSScriptRoot 'invoke-command-shim.ps1'), (Join-Path $Source 'scripts\invoke-command-shim.ps1')),
        @((Join-Path $PSScriptRoot 'validate-smoke-evidence.mjs'), (Join-Path $Source 'scripts\validate-smoke-evidence.mjs')),
        @((Join-Path $PSScriptRoot '..\docs\release-evidence\schema-v1.json'), (Join-Path $Source 'docs\release-evidence\schema-v1.json'))
    )
    foreach ($pair in $pairs) {
        if (-not (Test-Path -LiteralPath $pair[1] -PathType Leaf)) { throw 'the frozen candidate is missing a release-gate file' }
        $comparison = Invoke-Process -FilePath 'node' -ArgumentList @($comparator, $pair[0], $pair[1]) -WorkingDirectory $Source -AllowFailure
        if ($comparison.ExitCode -ne 0) { throw 'the executing release gate differs from the frozen candidate' }
    }
}

function Assert-InstalledCandidate {
    param(
        [Parameter(Mandatory = $true)][string]$ExpectedRef,
        [Parameter(Mandatory = $true)][string]$ExpectedCommit
    )
    $verifier = Join-Path $Source 'scripts\verify-installed-candidate.mjs'
    Invoke-Process -FilePath 'node' -ArgumentList @($verifier, "--ref=$ExpectedRef", "--commit=$ExpectedCommit") -WorkingDirectory $Source | Out-Null
}

function Assert-InstalledPluginBytes {
    param([Parameter(Mandatory = $true)][string]$InstalledRoot)
    $comparator = Join-Path $Source 'scripts\compare-gate-content.mjs'
    $candidateRoot = Join-Path $Source 'plugins\adaptive-model-router'
    $relativeFiles = @(
        '.codex-plugin\plugin.json',
        '.mcp.json',
        'hooks\hooks.json',
        'runtime.json',
        'scripts\codex-route.mjs',
        'scripts\hook.mjs',
        'skills\adaptive-model-router\SKILL.md'
    )
    foreach ($relativeFile in $relativeFiles) {
        $candidateFile = Join-Path $candidateRoot $relativeFile
        $installedFile = Join-Path $InstalledRoot $relativeFile
        if (-not (Test-Path -LiteralPath $candidateFile -PathType Leaf) -or -not (Test-Path -LiteralPath $installedFile -PathType Leaf)) {
            throw 'installed candidate integrity file is missing'
        }
        $comparison = Invoke-Process -FilePath 'node' -ArgumentList @($comparator, $candidateFile, $installedFile) -WorkingDirectory $Source -AllowFailure
        if ($comparison.ExitCode -ne 0) { throw 'installed Hook, Skill, MCP, manifest, runtime, or hook implementation differs from the frozen candidate' }
    }
}

function Invoke-Wrapper {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    $installer = Join-Path $Source 'install.ps1'
    return Invoke-Process -FilePath $installer -ArgumentList $Arguments -WorkingDirectory $Source
}

function Write-SmokeFixture {
    param([Parameter(Mandatory = $true)][string]$Root)
    $sourceDirectory = Join-Path $Root 'src'
    $testDirectory = Join-Path $Root 'test'
    New-Item -ItemType Directory -Force -Path $sourceDirectory, $testDirectory | Out-Null
    $source = @'
export function normalizeLines(text) {
  if (text === "") return "";
  const normalized = text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .replace(/\n+$/u, "");
  return `${normalized}\n`;
}
'@
    $test = @'
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLines } from "../src/normalize-lines.mjs";

test("normalizes CRLF", () => assert.equal(normalizeLines("a\r\nb"), "a\nb\n"));
test("normalizes CR", () => assert.equal(normalizeLines("a\rb"), "a\nb\n"));
test("strips trailing whitespace", () => assert.equal(normalizeLines("a  \n b\t"), "a\n b\n"));
test("preserves empty input", () => assert.equal(normalizeLines(""), ""));
test("keeps exactly one final newline", () => assert.equal(normalizeLines("a\n\n"), "a\n"));
test("preserves Chinese text", () => assert.equal(normalizeLines("你好  \r\n世界"), "你好\n世界\n"));
'@
    $utf8NoBom = [Text.UTF8Encoding]::new($false)
    [IO.File]::WriteAllText((Join-Path $sourceDirectory 'normalize-lines.mjs'), ($source + "`n"), $utf8NoBom)
    [IO.File]::WriteAllText((Join-Path $testDirectory 'normalize-lines.test.mjs'), ($test + "`n"), $utf8NoBom)
}

function Get-SmokeFixtureHash {
    param([Parameter(Mandatory = $true)][string]$Root)
    $relativeFiles = @(Get-ChildItem -LiteralPath (Join-Path $Root 'src'), (Join-Path $Root 'test') -File -Recurse |
        ForEach-Object { [IO.Path]::GetRelativePath($Root, $_.FullName).Replace('\', '/') } |
        Sort-Object)
    $hashes = [ordered]@{}
    foreach ($relativeFile in $relativeFiles) {
        $hashes[$relativeFile] = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Root $relativeFile)).Hash
    }
    return [ordered]@{
        files = $relativeFiles
        hashes = $hashes
    }
}

function Assert-StructuredReviewSummary {
    param([Parameter(Mandatory = $true)][string]$Text)
    try { $summary = $Text | ConvertFrom-Json -Depth 20 } catch { throw 'managed review did not return valid JSON' }
    $summaryKeys = @($summary.PSObject.Properties.Name | Sort-Object)
    if (($summaryKeys -join ',') -ne 'agreement,rootReview,subagentReview,testExecution') { throw 'managed review summary fields differ from the fixed contract' }
    $checkKeys = @('chineseText', 'cr', 'crlf', 'dependencyFree', 'emptyInput', 'existingFinalNewline', 'nonEmptyFinalLf', 'trailingWhitespace')
    foreach ($reviewName in @('rootReview', 'subagentReview')) {
        $review = $summary.$reviewName
        $reviewKeys = @($review.PSObject.Properties.Name | Sort-Object)
        if (($reviewKeys -join ',') -ne 'checks,verdict') { throw "$reviewName fields differ from the fixed contract" }
        if ([string]$review.verdict -ne 'passed') { throw "$reviewName did not pass" }
        $actualCheckKeys = @($review.checks.PSObject.Properties.Name | Sort-Object)
        if (($actualCheckKeys -join ',') -ne ($checkKeys -join ',')) { throw "$reviewName checklist differs from the fixed contract" }
        foreach ($checkKey in $checkKeys) {
            if ($review.checks.$checkKey -ne $true) { throw "$reviewName checklist contains a failed item" }
        }
    }
    if ($summary.agreement -ne $true -or [string]$summary.testExecution -ne 'deferred-to-native-runner') {
        throw 'managed reviews did not agree or claimed executable verification'
    }
}

$failed = $false
try {
    if (-not $IsWindows -or $PSVersionTable.PSEdition -ne 'Core') { throw 'native Windows PowerShell 7 is required' }
    if (-not $ValidateZeroApprovalContract) {
        $operatingSystem = Get-CimInstance -ClassName Win32_OperatingSystem
        if ([Environment]::OSVersion.Version.Build -lt 22000 -or [int]$operatingSystem.ProductType -ne 1) { throw 'native Windows 11 workstation is required' }
    }
    if ([string]::IsNullOrWhiteSpace($SmokeWorkspaceRoot) -or -not [IO.Path]::IsPathFullyQualified($SmokeWorkspaceRoot)) {
        throw 'ADAPTIVE_ROUTER_SMOKE_ROOT must name a controlled absolute workspace root'
    }
    $SmokeWorkspaceRoot = [IO.Path]::GetFullPath($SmokeWorkspaceRoot)
    if (-not (Test-Path -LiteralPath $SmokeWorkspaceRoot -PathType Container)) {
        throw 'the controlled smoke workspace root does not exist'
    }
    $workspaceMarker = Join-Path $SmokeWorkspaceRoot '.adaptive-router-smoke-root'
    if (-not (Test-Path -LiteralPath $workspaceMarker -PathType Leaf) -or (Get-Content -LiteralPath $workspaceMarker -Raw).Trim() -ne 'adaptive-model-router smoke root v1') {
        throw 'the controlled smoke workspace root is missing its explicit marker'
    }
    $unsafeWorkspaceRoots = @(
        [IO.Path]::GetPathRoot($SmokeWorkspaceRoot),
        [Environment]::GetFolderPath('UserProfile'),
        [Environment]::GetFolderPath('Windows'),
        [Environment]::GetFolderPath('ProgramFiles'),
        [Environment]::GetFolderPath('CommonApplicationData')
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | ForEach-Object { [IO.Path]::GetFullPath([string]$_) }
    if (@($unsafeWorkspaceRoots | Where-Object { $SmokeWorkspaceRoot.Equals($_, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0) {
        throw 'the controlled smoke workspace root resolves to a broad system or user directory'
    }
    $SmokeRoot = Join-Path $SmokeWorkspaceRoot ('run-' + $SmokeId)
    $Source = Join-Path $SmokeRoot 'source checkout 空格'
    $Project = Join-Path $SmokeRoot '测试 project with spaces'
    $Project2 = Join-Path $SmokeRoot '第二个 project'
    $HookProject = Join-Path $SmokeRoot 'hook verification project'
    $RawRoot = Join-Path $SmokeRoot 'private raw events'
    if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
        $OutputDirectory = Join-Path $SmokeWorkspaceRoot 'evidence\v0.4.0'
    }
    $resolvedOutputCandidate = [IO.Path]::GetFullPath($OutputDirectory)
    $workspacePrefix = $SmokeWorkspaceRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedOutputCandidate.StartsWith($workspacePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        $OutputDirectory = $null
        throw 'smoke evidence output must be contained by ADAPTIVE_ROUTER_SMOKE_ROOT'
    }
    $OutputDirectory = $resolvedOutputCandidate
    $hostPermissionProfile = ([string]$env:CODEX_PERMISSION_PROFILE).Trim().TrimStart(':')
    if ($hostPermissionProfile -ne 'danger-full-access') {
        throw 'host permission profile must be danger-full-access for zero-approval-v1'
    }
    $PermissionEvidence.hostProfile = $hostPermissionProfile
    $hostApprovalPolicy = ([string]$env:ADAPTIVE_ROUTER_SMOKE_HOST_APPROVAL_POLICY).Trim()
    if ($hostApprovalPolicy -ne 'never') {
        throw 'host approval policy attestation must be never for zero-approval-v1'
    }
    $PermissionEvidence.hostApprovalPolicy = $hostApprovalPolicy
    if ([string]::IsNullOrWhiteSpace($DedicatedCodexHome) -or -not [IO.Path]::IsPathFullyQualified($DedicatedCodexHome)) {
        throw 'ADAPTIVE_ROUTER_SMOKE_CODEX_HOME must name a dedicated absolute Codex Home'
    }
    $DedicatedCodexHome = [IO.Path]::GetFullPath($DedicatedCodexHome)
    if (-not $DedicatedCodexHome.StartsWith($workspacePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'the dedicated Codex Home must be contained by ADAPTIVE_ROUTER_SMOKE_ROOT'
    }
    $defaultCodexHome = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex'))
    if ($DedicatedCodexHome.Equals($defaultCodexHome, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'the smoke runner refuses to mutate the default Codex Home'
    }
    if (-not (Test-Path -LiteralPath $DedicatedCodexHome -PathType Container)) {
        throw 'the dedicated smoke Codex Home does not exist'
    }
    $unsafeHomes = @(
        [IO.Path]::GetPathRoot($DedicatedCodexHome),
        [Environment]::GetFolderPath('UserProfile'),
        [Environment]::GetFolderPath('Windows'),
        [Environment]::GetFolderPath('ProgramFiles'),
        [Environment]::GetFolderPath('CommonApplicationData')
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | ForEach-Object { [IO.Path]::GetFullPath([string]$_) }
    if (@($unsafeHomes | Where-Object { $DedicatedCodexHome.Equals($_, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0) {
        throw 'the dedicated smoke Codex Home resolves to a broad system or user directory'
    }
    $homeMarker = Join-Path $DedicatedCodexHome '.adaptive-router-smoke-home'
    if (-not (Test-Path -LiteralPath $homeMarker -PathType Leaf) -or (Get-Content -LiteralPath $homeMarker -Raw).Trim() -ne 'adaptive-model-router smoke home v1') {
        throw 'the dedicated Codex Home is missing its explicit smoke-home marker'
    }
    New-Item -ItemType Directory -Force -Path $SmokeRoot, $Project, $Project2, $HookProject, $RawRoot | Out-Null
    $pathEntries = @([string]$env:PATH -split [regex]::Escape([string][IO.Path]::PathSeparator) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $managedPathEntries = @($pathEntries | Where-Object { $_ -notmatch '(?i)[\\/]WindowsApps(?:[\\/]|$)' })
    if ($managedPathEntries.Count -eq 0) {
        throw 'managed Codex PATH is empty after excluding WindowsApps entries'
    }
    $ManagedCodexPath = $managedPathEntries -join [IO.Path]::PathSeparator
    $escapedManagedCodexPath = $ManagedCodexPath.Replace('\', '\\').Replace('"', '\"')
    $ManagedShellPathConfig = 'shell_environment_policy.set.PATH="' + $escapedManagedCodexPath + '"'
    if (-not (Test-Path -LiteralPath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -PathType Leaf)) {
        throw 'system Windows PowerShell is required for managed sandbox turns'
    }
    $pathProbe = Invoke-Process -FilePath 'cmd' -ArgumentList @('/d', '/c', 'echo %PATH%') -EnvironmentOverrides @{ PATH = $ManagedCodexPath }
    if ($pathProbe.Stdout -match '(?i)[\\/]WindowsApps(?:[\\/]|;|$)') {
        throw 'managed command launch reintroduced a WindowsApps PATH entry'
    }
    if ($ValidateZeroApprovalContract) {
        Write-Output 'Windows zero-approval-v1 preflight passed.'
        return
    }
    $env:CODEX_HOME = $DedicatedCodexHome
    $node = Invoke-Process -FilePath 'node' -ArgumentList @('--version')
    $git = Invoke-Process -FilePath 'git' -ArgumentList @('--version')
    $codex = Invoke-Process -FilePath 'codex' -ArgumentList @('--version')
    Invoke-Process -FilePath 'codex' -ArgumentList @('login', 'status') | Out-Null
    $nodeVersion = [version](($node.Stdout.Trim()).TrimStart('v').Split('-')[0])
    if ($nodeVersion -lt [version]'24.15.0') { throw 'Node.js 24.15.0 or newer is required' }
    $EnvironmentEvidence.nodeVersion = $node.Stdout.Trim()
    $EnvironmentEvidence.gitVersion = $git.Stdout.Trim()
    $EnvironmentEvidence.codexVersion = $codex.Stdout.Trim()
    Add-SmokeCheck -Id 'native-preflight' -Blocking $true -Status 'PASS'

    Invoke-Process -FilePath 'git' -ArgumentList @('clone', '--branch', $CandidateRef, '--single-branch', $Repository, $Source) | Out-Null
    $CandidateCommit = (Invoke-Process -FilePath 'git' -ArgumentList @('-C', $Source, 'rev-parse', 'HEAD')).Stdout.Trim()
    if ($CandidateCommit -notmatch '^[0-9a-f]{40}$') { throw 'candidate commit is not a full SHA' }
    $PluginTreeSha256 = Get-PluginTreeHash -Commit $CandidateCommit
    Assert-CandidateGateFiles
    Invoke-Process -FilePath 'git' -ArgumentList @('-C', $Project, 'init') | Out-Null
    Invoke-Process -FilePath 'git' -ArgumentList @('-C', $Project2, 'init') | Out-Null
    Invoke-Process -FilePath 'git' -ArgumentList @('-C', $HookProject, 'init') | Out-Null
    Add-SmokeCheck -Id 'candidate-frozen' -Blocking $true -Status 'PASS'

    $candidatePluginRoot = Join-Path $Source 'plugins\adaptive-model-router'
    $automatedGateEnvironment = @{ CODEX_HOME = $null }
    Invoke-Process -FilePath 'npm' -ArgumentList @('test') -WorkingDirectory $candidatePluginRoot -EnvironmentOverrides $automatedGateEnvironment | Out-Null
    Invoke-Process -FilePath 'npm' -ArgumentList @('run', 'validate') -WorkingDirectory $candidatePluginRoot -EnvironmentOverrides $automatedGateEnvironment | Out-Null
    Invoke-Process -FilePath 'npm' -ArgumentList @('run', 'eval') -WorkingDirectory $candidatePluginRoot -EnvironmentOverrides $automatedGateEnvironment | Out-Null
    Add-SmokeCheck -Id 'candidate-automated-gate' -Blocking $true -Status 'PASS'

    $manager = Join-Path $Source 'plugins\adaptive-model-router\scripts\manage-install.mjs'
    Invoke-Process -FilePath 'node' -ArgumentList @($manager, 'install', '--non-interactive', "--ref=$CandidateRef") -WorkingDirectory $Source | Out-Null
    Add-SmokeCheck -Id 'native-install' -Blocking $true -Status 'PASS'
    Assert-InstalledCandidate -ExpectedRef $CandidateRef -ExpectedCommit $CandidateCommit
    $pluginManifest = Get-Content -LiteralPath (Join-Path $candidatePluginRoot '.codex-plugin\plugin.json') -Raw | ConvertFrom-Json
    $installedPluginRoot = Join-Path $DedicatedCodexHome ("plugins\cache\adaptive-model-router\adaptive-model-router\{0}" -f [string]$pluginManifest.version)
    $InstalledRouterLauncher = Join-Path $installedPluginRoot 'scripts\node-launcher.mjs'
    $InstalledRouterCli = Join-Path $installedPluginRoot 'scripts\codex-route.mjs'
    if (-not (Test-Path -LiteralPath $InstalledRouterLauncher -PathType Leaf) -or -not (Test-Path -LiteralPath $InstalledRouterCli -PathType Leaf)) {
        throw 'installed router state reader files are missing'
    }
    Assert-InstalledPluginBytes -InstalledRoot $installedPluginRoot
    Add-SmokeCheck -Id 'installed-candidate-integrity' -Blocking $true -Status 'PASS'

    $turn = Invoke-CodexTurn -Prompt 'router: global on' -Model 'gpt-5.6-sol'
    $SessionId = $turn.SessionId
    Invoke-CodexTurn -Prompt 'router: status' -Model 'gpt-5.6-sol' -ResumeSession $SessionId | Out-Null
    $baseline = Read-RouterState -Command 'status' -Context $SessionId -WorkingProject $Project
    if (-not $baseline.autoActivation.globalEnabled -or -not $baseline.autoActivation.effective -or $baseline.taskMode -ne 'automatic') { throw 'global automatic routing did not activate' }
    if ($baseline.rootTask.modelVisibility -ne 'hook_observed' -or $baseline.rootTask.changedByRouter -ne $false) { throw 'the trusted prompt hook did not expose the unchanged root-model boundary' }
    $InitialRootModel = [string]$baseline.rootTask.model
    if ([string]::IsNullOrWhiteSpace($InitialRootModel)) { throw 'the initial root-model baseline is unavailable' }

    $hookSeedTurn = Invoke-CodexTurn -WorkingProject $HookProject -Model 'gpt-5.6-sol' -Prompt 'Return only: stop-hook-probe-ready. This is a simple lifecycle acknowledgement with no work product. Do not call router tools, create a subagent, or record an outcome.'
    $probe = Invoke-Process -FilePath 'node' -ArgumentList @($InstalledRouterLauncher, $InstalledRouterCli, 'stop-probe', '--confirm', 'STOP_HOOK_SMOKE', '--context', $hookSeedTurn.SessionId) -WorkingDirectory $HookProject
    $probeRoute = $probe.Stdout | ConvertFrom-Json -Depth 30
    if ($probeRoute.action -ne 'delegate') { throw 'the external Stop-hook probe did not create one pending delegated route' }
    $hookTurn = Invoke-CodexTurn -WorkingProject $HookProject -Model 'gpt-5.6-sol' -ResumeSession $hookSeedTurn.SessionId -Prompt 'Return only: stop-hook-probe-complete. This is a simple lifecycle acknowledgement with no work product. Do not call router tools, create a subagent, or record an outcome.'
    $hookHistory = Read-RouterState -Command 'history' -Context $hookTurn.SessionId -WorkingProject $HookProject
    $hookUnknown = @($hookHistory.routes | Where-Object { $_.action -eq 'delegate' -and $_.outcome.status -eq 'unknown' -and $_.outcome.source -eq 'stop_hook' })
    $hookStatus = Read-RouterState -Command 'status' -Context $hookTurn.SessionId -WorkingProject $HookProject
    if ($hookUnknown.Count -ne 1 -or $hookStatus.outcomeObservability.stopHookUnknown -ne 1) { throw 'the trusted Stop hook did not finalize the deliberate pending route' }
    if (@(Get-ToolCallItems -Events $hookTurn.Events -Tool 'spawn_agent').Count -ne 0 -or @(Get-ToolCallItems -Events $hookTurn.Events -Tool 'record_outcome').Count -ne 0) { throw 'the Stop-hook probe unexpectedly spawned or recorded an explicit outcome' }
    Add-SmokeCheck -Id 'hook-trust-and-global-on' -Blocking $true -Status 'PASS'

    Write-SmokeFixture -Root $Project
    $fixtureHashBefore = Get-SmokeFixtureHash -Root $Project
    $reviewHistoryBefore = Read-RouterState -Command 'history' -Context $SessionId -WorkingProject $Project
    $sessionTraceBeforeCount = @(Read-CodexSessionTrace -Context $SessionId).Count
    $reviewStartedAt = [DateTime]::UtcNow
    $implementationPrompt = @'
Review the existing dependency-free Node.js 24 line-normalization utility and tests in this temporary project without modifying files. Follow the trusted fixed-context automatic-router instruction injected for this turn. For every shell tool call in this smoke, request at least a 30-second initial yield and, if it still returns a running cell, call the wait tool until that cell completes; include this same rule in the bounded subagent task. Call route_stage exactly once for a bounded review stage with phase=review and evidence review=true, workProduct=true, requirementsSettled=true, strongVerification=true, batchSize=2 plus the host's actual bounded-subagent capabilities. A Sol/Terra-only host must omit Luna. The root task and exactly one bounded subagent must independently inspect the existing source and tests against this fixed checklist: CRLF normalization, CR normalization, trailing spaces/tabs removal, exactly one final LF for non-empty input, empty input preservation, existing final newline handling, Chinese text preservation, and no runtime dependencies. When the route delegates, call the spawn_agent collaboration tool exactly once using target.model and target.effort; the subagent must return only its structured checklist and must not route recursively or own record_outcome. The root must complete its own checklist, call wait_agent until the subagent's final checklist is available, compare both results, and call record_outcome exactly once using the returned structured-check gate. Pass only when both reviews pass and agree. Do not run Node tests or any write command; the native runner performs the executable test immediately after this read-only review. Then call status, history, diagnose, and learning status. Return only one redacted JSON object with exactly rootReview, subagentReview, agreement, and testExecution. Each review must contain exactly verdict and checks; verdict must be passed, and checks must contain exactly the boolean keys crlf, cr, trailingWhitespace, nonEmptyFinalLf, emptyInput, existingFinalNewline, chineseText, dependencyFree. Set agreement to true and testExecution to deferred-to-native-runner. Never expose source, prompt text, environment values, secrets, paths, session/context identifiers, or raw logs.
'@
    $implementationTurn = Invoke-CodexTurn -Prompt $implementationPrompt -Model 'gpt-5.6-sol' -ResumeSession $SessionId
    $implementationTrace = @(Read-CodexSessionTrace -Context $SessionId | Select-Object -Skip $sessionTraceBeforeCount)
    Assert-StructuredReviewSummary -Text $implementationTurn.LastMessage
    $fixtureHashAfterReview = Get-SmokeFixtureHash -Root $Project
    if (($fixtureHashBefore | ConvertTo-Json -Depth 20 -Compress) -ne ($fixtureHashAfterReview | ConvertTo-Json -Depth 20 -Compress)) {
        throw 'fixture changed during managed read-only review'
    }
    Invoke-Process -FilePath 'node' -ArgumentList @('--test', 'test/normalize-lines.test.mjs') -WorkingDirectory $Project | Out-Null
    $fixtureHashAfterTest = Get-SmokeFixtureHash -Root $Project
    if (($fixtureHashBefore | ConvertTo-Json -Depth 20 -Compress) -ne ($fixtureHashAfterTest | ConvertTo-Json -Depth 20 -Compress)) {
        throw 'fixture changed during native executable verification'
    }
    $status = Read-RouterState -Command 'status' -Context $SessionId -WorkingProject $Project
    $history = Read-RouterState -Command 'history' -Context $SessionId -WorkingProject $Project
    $doctor = Read-RouterState -Command 'doctor' -Context $SessionId -WorkingProject $Project
    $learningBeforeIntent = Read-RouterState -Command 'learning' -Context $SessionId -WorkingProject $Project
    $reviewRoutes = @(Get-NewRoutes -Before $reviewHistoryBefore -After $history)
    if ($reviewRoutes.Count -ne 1 -or $reviewRoutes[0].action -ne 'delegate' -or $reviewRoutes[0].outcome.status -ne 'passed' -or $status.pendingOutcomes -ne 0) { throw 'managed review did not add exactly one verified delegated route' }
    $route = $reviewRoutes[0]
    if ($route.outcome.source -ne 'record_outcome') { throw 'verified outcome was not finalized by record_outcome' }
    if ($route.category -ne 'review' -or $route.verificationGate -ne 'structured-check' -or $route.outcome.gate -ne 'structured-check') { throw 'read-only review did not preserve the structured-check contract' }
    if (@($route.reasonCodes) -notcontains 'REVIEW_STAGE' -or @($route.reasonCodes) -notcontains 'STRONG_VERIFICATION') { throw 'review route did not preserve its review and verification signals' }
    $retryBreakdown = $route.outcome.retryBreakdown
    $retryKeys = @($retryBreakdown.PSObject.Properties.Name | Sort-Object)
    if (($retryKeys -join ',') -ne 'environment,information,reasoning,tooling') { throw 'verified outcome does not contain the complete typed retry breakdown' }
    $retryTotal = [int]$retryBreakdown.reasoning + [int]$retryBreakdown.environment + [int]$retryBreakdown.information + [int]$retryBreakdown.tooling
    if ($retryTotal -ne [int]$route.outcome.retries) { throw 'verified outcome retry breakdown does not sum to retries' }
    $outcomeCalls = @(Get-ToolCallItems -Events $implementationTurn.Events -Tool 'record_outcome')
    $routeTrace = @($implementationTrace | Where-Object { (Get-NestedPropertyValue -InputObject $_ -Path @('payload', 'type')) -eq 'mcp_tool_call_end' -and (Get-NestedPropertyValue -InputObject $_ -Path @('payload', 'invocation', 'tool')) -eq 'route_stage' })
    $spawnTrace = @($implementationTrace | Where-Object { (Get-NestedPropertyValue -InputObject $_ -Path @('payload', 'type')) -eq 'function_call' -and (Get-NestedPropertyValue -InputObject $_ -Path @('payload', 'namespace')) -eq 'collaboration' -and (Get-NestedPropertyValue -InputObject $_ -Path @('payload', 'name')) -eq 'spawn_agent' })
    $waitTrace = @($implementationTrace | Where-Object { (Get-NestedPropertyValue -InputObject $_ -Path @('payload', 'type')) -eq 'function_call' -and (Get-NestedPropertyValue -InputObject $_ -Path @('payload', 'namespace')) -eq 'collaboration' -and (Get-NestedPropertyValue -InputObject $_ -Path @('payload', 'name')) -eq 'wait_agent' })
    $recordTrace = @($implementationTrace | Where-Object { (Get-NestedPropertyValue -InputObject $_ -Path @('payload', 'type')) -eq 'mcp_tool_call_end' -and (Get-NestedPropertyValue -InputObject $_ -Path @('payload', 'invocation', 'tool')) -eq 'record_outcome' })
    if ($routeTrace.Count -ne 1 -or $spawnTrace.Count -ne 1 -or $waitTrace.Count -ne 1 -or $recordTrace.Count -ne 1 -or $outcomeCalls.Count -ne 1) { throw 'managed review lifecycle call cardinality differs from one route, spawn, wait, and outcome' }
    $spawnCallId = [string](Get-NestedPropertyValue -InputObject $spawnTrace[0] -Path @('payload', 'call_id'))
    $waitCallId = [string](Get-NestedPropertyValue -InputObject $waitTrace[0] -Path @('payload', 'call_id'))
    $spawnOutput = @($implementationTrace | Where-Object { (Get-NestedPropertyValue -InputObject $_ -Path @('payload', 'type')) -eq 'function_call_output' -and (Get-NestedPropertyValue -InputObject $_ -Path @('payload', 'call_id')) -eq $spawnCallId })
    $waitOutput = @($implementationTrace | Where-Object { (Get-NestedPropertyValue -InputObject $_ -Path @('payload', 'type')) -eq 'function_call_output' -and (Get-NestedPropertyValue -InputObject $_ -Path @('payload', 'call_id')) -eq $waitCallId })
    if ($spawnOutput.Count -ne 1 -or $waitOutput.Count -ne 1) { throw 'managed review collaboration calls did not complete exactly once' }
    try { $spawnResult = (Get-NestedPropertyValue -InputObject $spawnOutput[0] -Path @('payload', 'output')) | ConvertFrom-Json -Depth 20 } catch { throw 'bounded-subagent spawn result is invalid' }
    try { $waitResult = (Get-NestedPropertyValue -InputObject $waitOutput[0] -Path @('payload', 'output')) | ConvertFrom-Json -Depth 20 } catch { throw 'bounded-subagent wait result is invalid' }
    $agentPath = [string](Get-NestedPropertyValue -InputObject $spawnResult -Path @('task_name'))
    if ([string]::IsNullOrWhiteSpace($agentPath) -or (Get-NestedPropertyValue -InputObject $waitResult -Path @('timed_out')) -ne $false -or [string](Get-NestedPropertyValue -InputObject $waitResult -Path @('message')) -notmatch 'finished|completed|final') { throw 'bounded subagent was not observed to finish before outcome recording' }
    $tracePositions = [ordered]@{}
    for ($traceIndex = 0; $traceIndex -lt $implementationTrace.Count; $traceIndex += 1) {
        $entry = $implementationTrace[$traceIndex]
        $payloadType = Get-NestedPropertyValue -InputObject $entry -Path @('payload', 'type')
        $toolName = Get-NestedPropertyValue -InputObject $entry -Path @('payload', 'invocation', 'tool')
        if ($payloadType -eq 'mcp_tool_call_end' -and $toolName -eq 'route_stage') { $tracePositions.route = $traceIndex }
        if ($payloadType -eq 'function_call' -and (Get-NestedPropertyValue -InputObject $entry -Path @('payload', 'namespace')) -eq 'collaboration' -and (Get-NestedPropertyValue -InputObject $entry -Path @('payload', 'name')) -eq 'spawn_agent') { $tracePositions.spawn = $traceIndex }
        if ($payloadType -eq 'function_call_output' -and (Get-NestedPropertyValue -InputObject $entry -Path @('payload', 'call_id')) -eq $waitCallId) { $tracePositions.waited = $traceIndex }
        if ($payloadType -eq 'mcp_tool_call_end' -and $toolName -eq 'record_outcome') { $tracePositions.outcome = $traceIndex }
    }
    if (-not ($tracePositions['route'] -lt $tracePositions['spawn'] -and $tracePositions['spawn'] -lt $tracePositions['waited'] -and $tracePositions['waited'] -lt $tracePositions['outcome'])) { throw 'managed review lifecycle order is not route, spawn, wait completion, outcome' }
    $RouteEvidence.action = 'delegate'
    $RouteEvidence.targetFamily = Get-ModelFamily -Model ([string]$route.target.model)
    $RouteEvidence.targetEffort = [string]$route.target.effort
    $RouteEvidence.verificationGate = [string]$route.verificationGate
    $RouteEvidence.pendingOutcomes = [int]$status.pendingOutcomes
    $RouteEvidence.stopHookUnknown = [int]$status.outcomeObservability.stopHookUnknown
    $DiagnosticEvidence.databaseHealth = [string]$doctor.databaseHealth
    $DiagnosticEvidence.classifierState = if ($doctor.classifier.circuitOpen) { 'open' } else { 'closed' }
    if ($RouteEvidence.targetFamily -notin @('sol', 'terra')) { throw 'automatic bounded target escaped the Sol/Terra capability set' }
    $subagentExecution = Read-BoundedSubagentExecution -ParentContext $SessionId -AgentPath $agentPath -StartedAfter $reviewStartedAt
    if ($subagentExecution.Model -ne [string]$route.target.model -or $subagentExecution.Effort -ne [string]$route.target.effort) { throw 'bounded-subagent execution did not use the routed target model and effort' }
    if ($route.rootTask.changedByRouter -ne $false -or [string]::IsNullOrWhiteSpace([string]$route.rootTask.model)) { throw 'history did not preserve the root versus bounded-target boundary' }
    if ($DiagnosticEvidence.databaseHealth -ne 'ok' -or $DiagnosticEvidence.classifierState -ne 'closed') { throw 'router diagnostics are not healthy' }
    Assert-PrivateProjection -Values @($status, $history, $doctor, $learningBeforeIntent)
    Add-SmokeCheck -Id 'route-subagent-outcome' -Blocking $true -Status 'PASS'
    Add-SmokeCheck -Id 'root-target-boundary' -Blocking $true -Status 'PASS'
    Add-SmokeCheck -Id 'redacted-observability' -Blocking $true -Status 'PASS'

    $capabilityHistoryBefore = Read-RouterState -Command 'history' -Context $SessionId -WorkingProject $Project
    $lunaTurn = Invoke-CodexTurn -Prompt 'Call route_stage once for a substantive implementation stage with an explicit request override model gpt-5.6-luna/high while hostCapabilities.delegation contains only the actual Sol and Terra bounded targets. Do not create a subagent or change files. Return only the redacted action and reason codes.' -Model 'gpt-5.6-sol' -ResumeSession $SessionId
    $capabilityHistory = Read-RouterState -Command 'history' -Context $SessionId -WorkingProject $Project
    $lunaGuard = @(Get-NewRoutes -Before $capabilityHistoryBefore -After $capabilityHistory)
    if ($lunaGuard.Count -ne 1 -or $lunaGuard[0].action -ne 'ask_user' -or @($lunaGuard[0].reasonCodes) -notcontains 'EXPLICIT_TARGET_UNAVAILABLE') { throw 'explicit unavailable Luna did not ask the user exactly once' }
    Assert-NoDelegatedWork -Turn $lunaTurn -Route $lunaGuard[0]
    Add-SmokeCheck -Id 'capability-boundary' -Blocking $true -Status 'PASS'

    $shadowHistoryBefore = Read-RouterState -Command 'history' -Context $SessionId -WorkingProject $Project
    $shadowStatusBefore = Read-RouterState -Command 'status' -Context $SessionId -WorkingProject $Project
    $shadowDoctorBefore = Read-RouterState -Command 'doctor' -Context $SessionId -WorkingProject $Project
    $shadowLearningBefore = Read-RouterState -Command 'learning' -Context $SessionId -WorkingProject $Project
    $shadowTurn = Invoke-CodexTurn -Prompt 'This is read-only router inspection. Call shadow_route_stage exactly once for a risk-sensitive review using the active scoring definition and this task context. Do not call route_stage, do not create a subagent, and do not record an outcome. Then return only shadow, sideEffects, preferred family/effort, profile version, and before/after state counts.' -Model 'gpt-5.6-sol' -ResumeSession $SessionId
    $shadowHistoryAfter = Read-RouterState -Command 'history' -Context $SessionId -WorkingProject $Project
    $shadowStatusAfter = Read-RouterState -Command 'status' -Context $SessionId -WorkingProject $Project
    $shadowDoctorAfter = Read-RouterState -Command 'doctor' -Context $SessionId -WorkingProject $Project
    $shadowLearningAfter = Read-RouterState -Command 'learning' -Context $SessionId -WorkingProject $Project
    foreach ($projection in @(
        @($shadowHistoryBefore, $shadowHistoryAfter),
        @($shadowStatusBefore, $shadowStatusAfter),
        @($shadowDoctorBefore, $shadowDoctorAfter),
        @($shadowLearningBefore, $shadowLearningAfter)
    )) {
        if (($projection[0] | ConvertTo-Json -Depth 50 -Compress) -ne ($projection[1] | ConvertTo-Json -Depth 50 -Compress)) { throw 'shadow route changed a protected router projection' }
    }
    $shadowCalls = @(Get-ToolCallItems -Events $shadowTurn.Events -Tool 'shadow_route_stage')
    if ($shadowCalls.Count -ne 1 -or @(Get-ToolCallItems -Events $shadowTurn.Events -Tool 'route_stage').Count -ne 0) { throw 'shadow inspection did not call only shadow_route_stage exactly once' }
    if (@(Get-ToolCallItems -Events $shadowTurn.Events -Tool 'spawn_agent').Count -ne 0 -or @(Get-ToolCallItems -Events $shadowTurn.Events -Tool 'record_outcome').Count -ne 0) { throw 'shadow inspection created lifecycle side effects' }
    $shadowProjection = $shadowCalls[0] | ConvertTo-Json -Depth 50 -Compress
    if ($shadowProjection -notmatch '\\?"shadow\\?"\s*:\s*true' -or $shadowProjection -notmatch '\\?"sideEffects\\?"\s*:\s*false' -or $shadowProjection -notmatch '\\?"profileVersion\\?"\s*:\s*[1-9][0-9]*') { throw 'shadow result did not expose the required read-only and versioned fields' }
    if ([int]$shadowDoctorAfter.databaseVersion -ne 3 -or [int]$shadowDoctorAfter.supportedDatabaseVersion -ne 3) { throw 'database v3 is not active and supported' }
    if ([string]::IsNullOrWhiteSpace([string]$shadowStatusAfter.scoringProfile.profileId) -or [int]$shadowStatusAfter.scoringProfile.profileVersion -lt 1) { throw 'active scoring profile identity/version is missing' }
    Add-SmokeCheck -Id 'learning-and-shadow' -Blocking $true -Status 'PASS'

    $reviewPrompt = 'Review the line-normalization utility and tests for missing edge cases. Follow the automatic router context, make no file changes, call route_stage for this substantive review, and return only a concise finding plus the redacted route action and reason codes.'
    $pendingHistoryBefore = Read-RouterState -Command 'history' -Context $SessionId -WorkingProject $Project
    $pendingTurnOne = Invoke-CodexTurn -Prompt $reviewPrompt -Model 'gpt-5.6-terra' -ResumeSession $SessionId
    $pendingOne = Read-RouterState -Command 'status' -Context $SessionId -WorkingProject $Project
    $pendingTurnTwo = Invoke-CodexTurn -Prompt $reviewPrompt -Model 'gpt-5.6-terra' -ResumeSession $SessionId
    $pendingTwo = Read-RouterState -Command 'status' -Context $SessionId -WorkingProject $Project
    $pendingHistory = Read-RouterState -Command 'history' -Context $SessionId -WorkingProject $Project
    $pendingRoutes = @(Get-NewRoutes -Before $pendingHistoryBefore -After $pendingHistory)
    if ($pendingRoutes.Count -ne 2) { throw 'model intent did not produce exactly two root-only observations' }
    foreach ($pendingRoute in $pendingRoutes) {
        if ($pendingRoute.action -ne 'continue' -or @($pendingRoute.reasonCodes) -notcontains 'HOST_MODEL_INTENT_PENDING') { throw 'model intent did not remain root-only' }
    }
    Assert-NoDelegatedWork -Turn $pendingTurnOne -Route $pendingRoutes[1]
    Assert-NoDelegatedWork -Turn $pendingTurnTwo -Route $pendingRoutes[0]
    if ($null -eq $pendingOne.pendingHostModelChange -or $pendingOne.pendingHostModelChange.changeId -ne $pendingTwo.pendingHostModelChange.changeId) { throw 'model reminder did not reuse one pending event' }
    $firstPendingChangeId = [string]$pendingOne.pendingHostModelChange.changeId
    Invoke-CodexTurn -Prompt 'router: auto session' -Model 'gpt-5.6-terra' -ResumeSession $SessionId | Out-Null
    $postKeepAutomatic = Read-RouterState -Command 'status' -Context $SessionId -WorkingProject $Project
    if ($postKeepAutomatic.taskMode -ne 'automatic' -or $null -ne $postKeepAutomatic.pendingHostModelChange) { throw 'keep-automatic did not restore automatic mode and resolve the pending event' }

    $secondPendingHistoryBefore = Read-RouterState -Command 'history' -Context $SessionId -WorkingProject $Project
    $secondPendingTurn = Invoke-CodexTurn -Prompt $reviewPrompt -Model $InitialRootModel -ResumeSession $SessionId
    $secondPendingStatus = Read-RouterState -Command 'status' -Context $SessionId -WorkingProject $Project
    $secondPendingHistory = Read-RouterState -Command 'history' -Context $SessionId -WorkingProject $Project
    $secondPendingRoutes = @(Get-NewRoutes -Before $secondPendingHistoryBefore -After $secondPendingHistory)
    if ($secondPendingRoutes.Count -ne 1 -or $secondPendingRoutes[0].action -ne 'continue' -or @($secondPendingRoutes[0].reasonCodes) -notcontains 'HOST_MODEL_INTENT_PENDING') { throw 'returning to the initial root model did not create a new pending event' }
    Assert-NoDelegatedWork -Turn $secondPendingTurn -Route $secondPendingRoutes[0]
    if ($null -eq $secondPendingStatus.pendingHostModelChange -or [string]$secondPendingStatus.pendingHostModelChange.changeId -eq $firstPendingChangeId) { throw 'the second model change did not create a distinct pending event' }

    Invoke-CodexTurn -Prompt 'router: manual' -Model $InitialRootModel -ResumeSession $SessionId | Out-Null
    $manualHistoryBefore = Read-RouterState -Command 'history' -Context $SessionId -WorkingProject $Project
    $manualTurn = Invoke-CodexTurn -Prompt 'Call route_stage for a substantive implementation stage using current bounded-subagent capabilities. Return only the redacted action and reason codes; do not change files.' -Model $InitialRootModel -ResumeSession $SessionId
    $manualHistory = Read-RouterState -Command 'history' -Context $SessionId -WorkingProject $Project
    $manualRoutes = @(Get-NewRoutes -Before $manualHistoryBefore -After $manualHistory)
    if ($manualRoutes.Count -ne 1 -or $manualRoutes[0].action -ne 'continue' -or @($manualRoutes[0].reasonCodes) -notcontains 'MANUAL_ROOT_SELECTED') { throw 'manual root mode did not block delegation' }
    Assert-NoDelegatedWork -Turn $manualTurn -Route $manualRoutes[0]
    Invoke-CodexTurn -Prompt 'router: auto session' -Model $InitialRootModel -ResumeSession $SessionId | Out-Null
    Add-SmokeCheck -Id 'host-model-intent' -Blocking $true -Status 'PASS'

    Invoke-CodexTurn -Prompt 'router: off' -Model $InitialRootModel -ResumeSession $SessionId | Out-Null
    $disabledHistoryBefore = Read-RouterState -Command 'history' -Context $SessionId -WorkingProject $Project
    $disabledTurn = Invoke-CodexTurn -Prompt 'Discuss the quoted text `router: on` without changing router state. Then call route_stage for a substantive implementation stage and return only the redacted route.' -Model $InitialRootModel -ResumeSession $SessionId
    $disabledHistory = Read-RouterState -Command 'history' -Context $SessionId -WorkingProject $Project
    $disabledRoutes = @(Get-NewRoutes -Before $disabledHistoryBefore -After $disabledHistory)
    if ($disabledRoutes.Count -ne 1 -or $disabledRoutes[0].action -ne 'continue' -or @($disabledRoutes[0].reasonCodes) -notcontains 'ROUTER_DISABLED') { throw 'ordinary quoted control text changed router state' }
    Assert-NoDelegatedWork -Turn $disabledTurn -Route $disabledRoutes[0]
    Invoke-CodexTurn -Prompt 'router: auto session' -Model $InitialRootModel -ResumeSession $SessionId | Out-Null
    Add-SmokeCheck -Id 'negative-control' -Blocking $true -Status 'PASS'

    Invoke-Process -FilePath 'codex' -ArgumentList @('plugin', 'marketplace', 'upgrade', 'adaptive-model-router') | Out-Null
    Invoke-Process -FilePath 'codex' -ArgumentList @('plugin', 'add', 'adaptive-model-router@adaptive-model-router') | Out-Null
    Invoke-Process -FilePath 'codex' -ArgumentList @('plugin', 'remove', 'adaptive-model-router@adaptive-model-router') | Out-Null
    Invoke-Process -FilePath 'codex' -ArgumentList @('plugin', 'marketplace', 'remove', 'adaptive-model-router') | Out-Null
    $wrapperInstall = Invoke-Wrapper -Arguments @('-PatchAgents', '-Ref', $CandidateRef)
    $wrapperUpgrade = Invoke-Wrapper -Arguments @('-Action', 'Upgrade', '-PatchAgents', '-Ref', $CandidateRef)
    foreach ($wrapperResult in @($wrapperInstall, $wrapperUpgrade)) {
        if ($wrapperResult.Stdout -notmatch 'v0\.3\.x' -or $wrapperResult.Stdout -notmatch 'Compatible v0\.4\.x\+' -or $wrapperResult.Stdout -notmatch 'upgrades preserve this setting') {
            throw 'wrapper lifecycle did not emit the required upgrade and persistence guidance'
        }
    }
    $agentsPath = Join-Path $DedicatedCodexHome 'AGENTS.md'
    $agentsText = if (Test-Path -LiteralPath $agentsPath) { Get-Content -LiteralPath $agentsPath -Raw } else { '' }
    if ([regex]::Matches($agentsText, [regex]::Escape('<!-- adaptive-model-router:start v0.2.0 -->')).Count -ne 1) { throw 'AGENTS start marker count differs from one' }
    if ([regex]::Matches($agentsText, [regex]::Escape('<!-- adaptive-model-router:end -->')).Count -ne 1) { throw 'AGENTS end marker count differs from one' }
    Invoke-Wrapper -Arguments @('-Action', 'Uninstall', '-Ref', $CandidateRef) | Out-Null
    $agentsAfter = if (Test-Path -LiteralPath $agentsPath) { Get-Content -LiteralPath $agentsPath -Raw } else { '' }
    if ($agentsAfter.Contains('<!-- adaptive-model-router:start v0.2.0 -->') -or $agentsAfter.Contains('<!-- adaptive-model-router:end -->')) { throw 'AGENTS owned marker remained after uninstall' }
    Invoke-Wrapper -Arguments @('-Ref', $CandidateRef) | Out-Null
    Invoke-Wrapper -Arguments @('-Ref', $CandidateRef) | Out-Null
    Assert-InstalledCandidate -ExpectedRef $CandidateRef -ExpectedCommit $CandidateCommit
    Assert-InstalledPluginBytes -InstalledRoot $installedPluginRoot
    Add-SmokeCheck -Id 'native-and-wrapper-lifecycle' -Blocking $true -Status 'PASS'

    $second = Invoke-Process -FilePath 'codex' -ArgumentList @('-a', 'never', '-s', 'read-only', 'exec', '-c', $ManagedShellPathConfig, '--json', '-C', $Project2, '-m', 'gpt-5.6-sol', 'router: status') -WorkingDirectory $Project2 -EnvironmentOverrides @{ PATH = $ManagedCodexPath }
    $secondEvents = @($second.Stdout -split "`r?`n" | ForEach-Object { if ($_){ try { $_ | ConvertFrom-Json -Depth 20 } catch {} } })
    Register-CodexPermissionTelemetry -Events $secondEvents -Text $second.Stderr
    $secondEvent = @($secondEvents | Where-Object { $_.type -eq 'thread.started' } | Select-Object -Last 1)
    if ($secondEvent.Count -ne 1) { throw 'second project did not start a Codex session' }
    $secondStatus = Read-RouterState -Command 'status' -Context ([string]$secondEvent[0].thread_id) -WorkingProject $Project2
    if (-not $secondStatus.autoActivation.globalEnabled -or $secondStatus.taskMode -ne 'automatic') { throw 'global activation did not persist into a second project' }
    Add-SmokeCheck -Id 'cross-project-persistence' -Blocking $true -Status 'PASS'

    $finalStatus = Read-RouterState -Command 'status' -Context $SessionId -WorkingProject $Project
    $finalDoctor = Read-RouterState -Command 'doctor' -Context $SessionId -WorkingProject $Project
    if ($finalStatus.taskMode -ne 'automatic' -or $null -ne $finalStatus.pendingHostModelChange -or $finalStatus.pendingOutcomes -ne 0 -or $finalStatus.outcomeObservability.stopHookUnknown -ne 0) { throw 'final router state is not automatic and settled' }
    if ($finalStatus.rootTask.modelVisibility -ne 'hook_observed' -or [string]$finalStatus.rootTask.model -ne $InitialRootModel) { throw 'final root model did not return to the initial baseline' }
    if ($finalDoctor.databaseHealth -ne 'ok' -or $finalDoctor.classifier.circuitOpen) { throw 'final router diagnostics are not healthy' }
    Assert-PrivateProjection -Values @(
        $finalStatus,
        $finalDoctor,
        $capabilityHistory,
        $shadowHistoryAfter,
        $shadowStatusAfter,
        $shadowDoctorAfter,
        $shadowLearningAfter,
        $pendingHistory,
        $postKeepAutomatic,
        $secondPendingStatus,
        $secondPendingHistory,
        $manualHistory,
        $disabledHistory,
        $secondStatus
    )
    $RouteEvidence.pendingOutcomes = [int]$finalStatus.pendingOutcomes
    $RouteEvidence.stopHookUnknown = [int]$finalStatus.outcomeObservability.stopHookUnknown
    $DiagnosticEvidence.databaseHealth = [string]$finalDoctor.databaseHealth
    $DiagnosticEvidence.classifierState = if ($finalDoctor.classifier.circuitOpen) { 'open' } else { 'closed' }
    $DiagnosticEvidence.privacy = 'PASS'
    Add-SmokeCheck -Id 'final-state-settled' -Blocking $true -Status 'PASS'
}
catch {
    $failed = $true
    Add-WarningCode -Code 'SMOKE_FAILED'
    $failedCheck = @()
    foreach ($requiredCheck in $RequiredWindowsChecks) {
        if (@($Checks | Where-Object { $_.id -eq $requiredCheck }).Count -eq 0) { $failedCheck = @($requiredCheck); break }
    }
    if ($failedCheck.Count -eq 1) {
        Add-WarningCode -Code ('CHECK_' + ([string]$failedCheck[0]).Replace('-', '_').ToUpperInvariant())
    }
    foreach ($requiredCheck in $RequiredWindowsChecks) {
        if (@($Checks | Where-Object { $_.id -eq $requiredCheck }).Count -eq 0) {
            Add-SmokeCheck -Id $requiredCheck -Blocking $true -Status 'SKIP'
        }
    }
}
finally {
    if ([string]::IsNullOrWhiteSpace($OriginalCodexHome)) { Remove-Item Env:\CODEX_HOME -ErrorAction SilentlyContinue }
    else { $env:CODEX_HOME = $OriginalCodexHome }
    if (-not [string]::IsNullOrWhiteSpace($SmokeRoot) -and -not [string]::IsNullOrWhiteSpace($SmokeWorkspaceRoot)) {
        $resolvedSmoke = [IO.Path]::GetFullPath($SmokeRoot)
        $resolvedWorkspace = [IO.Path]::GetFullPath($SmokeWorkspaceRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        if ($resolvedSmoke.StartsWith($resolvedWorkspace, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedSmoke).StartsWith('run-')) {
            Remove-Item -LiteralPath $resolvedSmoke -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

$blockingFailure = @($Checks | Where-Object { $_.blocking -and $_.status -ne 'PASS' }).Count -gt 0
$environmentUnavailable = @($EnvironmentEvidence.Values | Where-Object { $_ -eq 'unavailable' }).Count -gt 0
$evidenceStatus = if (
    -not $failed -and
    -not $blockingFailure -and
    -not $environmentUnavailable -and
    $CandidateCommit -ne ('0' * 40) -and
    $PluginTreeSha256 -ne ('0' * 64) -and
    $RouteEvidence.action -eq 'delegate' -and
    $RouteEvidence.targetFamily -in @('sol', 'terra') -and
    $RouteEvidence.targetEffort -ne 'none' -and
    $RouteEvidence.verificationGate -ne 'unavailable' -and
    $RouteEvidence.pendingOutcomes -eq 0 -and
    $RouteEvidence.stopHookUnknown -eq 0 -and
    $DiagnosticEvidence.databaseHealth -eq 'ok' -and
    $DiagnosticEvidence.classifierState -eq 'closed' -and
    $DiagnosticEvidence.privacy -eq 'PASS' -and
    $PermissionEvidence.hostProfile -eq 'danger-full-access' -and
    $PermissionEvidence.hostApprovalPolicy -eq 'never' -and
    $PermissionEvidence.managedApprovalPolicy -eq 'never' -and
    $PermissionEvidence.managedSandboxMode -eq 'read-only' -and
    $PermissionEvidence.approvalRequests -eq 0 -and
    $PermissionEvidence.sandboxEscalations -eq 0 -and
    $PermissionEvidence.permissionFailures -eq 0 -and
    $Warnings.Count -eq 0
) { 'PASS' } else { 'FAIL' }
$evidence = [ordered]@{
    schemaVersion = 1
    gate = 'windows-native'
    status = $evidenceStatus
    generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    candidate = [ordered]@{ ref = $CandidateRef; commitSha = $CandidateCommit; pluginTreeSha256 = $PluginTreeSha256 }
    environment = $EnvironmentEvidence
    permissions = $PermissionEvidence
    checks = @($Checks)
    route = $RouteEvidence
    diagnostics = $DiagnosticEvidence
    warnings = @($Warnings)
}

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { throw 'smoke preflight failed before a safe evidence output was established' }
$resolvedOutput = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $resolvedOutput | Out-Null
$evidencePath = Join-Path $resolvedOutput 'windows.json'
$json = $evidence | ConvertTo-Json -Depth 20
[IO.File]::WriteAllText($evidencePath, ($json + "`n"), [Text.UTF8Encoding]::new($false))
$validator = Join-Path $PSScriptRoot 'validate-smoke-evidence.mjs'
$validation = Invoke-Process -FilePath 'node' -ArgumentList @($validator, $evidencePath, '--write-derivatives', "--expected-ref=$CandidateRef", "--expected-commit=$CandidateCommit") -WorkingDirectory $PSScriptRoot -AllowFailure
if ($validation.ExitCode -ne 0) { throw 'smoke evidence validation failed' }
Write-Output "Native Windows smoke: $evidenceStatus"
Write-Output "Evidence: $evidencePath"
if ($evidenceStatus -ne 'PASS') { exit 1 }
