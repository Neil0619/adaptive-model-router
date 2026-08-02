[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._/-]*$')]
    [string]$CandidateRef,

    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\docs\release-evidence\v0.4.0')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Repository = 'https://github.com/Neil0619/adaptive-model-router.git'
$SmokeId = [guid]::NewGuid().ToString('N')
$SmokeRoot = Join-Path ([IO.Path]::GetTempPath()) ('adaptive-router-windows-smoke-' + $SmokeId)
$Source = Join-Path $SmokeRoot 'source checkout 空格'
$Project = Join-Path $SmokeRoot '测试 project with spaces'
$Project2 = Join-Path $SmokeRoot '第二个 project'
$HookProject = Join-Path $SmokeRoot 'hook verification project'
$RawRoot = Join-Path $SmokeRoot 'private raw events'
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
    $selected = @($commands | Where-Object { $_.Extension -eq '.ps1' } | Select-Object -First 1)
    if ($selected.Count -eq 0) { $selected = @($commands | Where-Object { $_.Extension -eq '.exe' } | Select-Object -First 1) }
    if ($selected.Count -eq 0) { $selected = @($commands | Where-Object { $_.Extension -in @('.cmd', '.bat') } | Select-Object -First 1) }
    if ($selected.Count -eq 0) { $selected = @($commands | Where-Object { $_.Extension -notin @('.cmd', '.bat', '') } | Select-Object -First 1) }
    if ($selected.Count -eq 0) {
        throw "no directly executable or PowerShell command was found for $Name"
    }
    if ($selected[0].Extension -eq '.ps1') {
        $pwsh = [string]@(Get-Command -Name 'pwsh' -CommandType Application -ErrorAction Stop)[0].Source
        return [pscustomobject]@{ FilePath = $pwsh; Prefix = @('-NoProfile', '-File', [string]$selected[0].Source) }
    }
    if ($selected[0].Extension -in @('.cmd', '.bat')) {
        $pwsh = [string]@(Get-Command -Name 'pwsh' -CommandType Application -ErrorAction Stop)[0].Source
        return [pscustomobject]@{ FilePath = $pwsh; Prefix = @('-NoProfile', '-File', $CommandShimPath, [string]$selected[0].Source) }
    }
    return [pscustomobject]@{ FilePath = [string]$selected[0].Source; Prefix = @() }
}

function Invoke-Process {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList,
        [string]$WorkingDirectory = $PWD.Path,
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
    foreach ($argument in (@($resolvedCommand.Prefix) + $ArgumentList)) { [void]$startInfo.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { throw "unable to start process" }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0 -and -not $AllowFailure) {
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
        $arguments = @('exec', 'resume', '--json', '-o', $lastMessage, '-m', $Model, $ResumeSession, $Prompt)
    }
    else {
        $arguments = @('exec', '--json', '-o', $lastMessage, '-C', $WorkingProject, '-m', $Model, $Prompt)
    }
    $result = Invoke-Process -FilePath 'codex' -ArgumentList $arguments -WorkingDirectory $WorkingProject
    $events = [Collections.Generic.List[object]]::new()
    foreach ($line in ($result.Stdout -split "`r?`n")) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $events.Add(($line | ConvertFrom-Json -Depth 30)) } catch { throw 'Codex emitted a non-JSON event in --json mode' }
    }
    $thread = @($events | Where-Object { $_.type -eq 'thread.started' } | Select-Object -Last 1)
    $resolvedSession = if ($ResumeSession) { $ResumeSession } elseif ($thread.Count -eq 1) { [string]$thread[0].thread_id } else { $null }
    if ([string]::IsNullOrWhiteSpace($resolvedSession)) { throw 'Codex did not emit thread.started' }
    return [pscustomobject]@{ SessionId = $resolvedSession; Events = $events }
}

function Read-RouterState {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('doctor', 'status', 'history', 'learning')][string]$Command,
        [Parameter(Mandatory = $true)][string]$Context,
        [Parameter(Mandatory = $true)][string]$WorkingProject
    )
    $routerCli = Join-Path $Source 'plugins\adaptive-model-router\scripts\codex-route.mjs'
    $arguments = @($routerCli, $Command, '--context', $Context)
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
    $pairs = @(
        @((Join-Path $PSScriptRoot 'windows-smoke.ps1'), (Join-Path $Source 'scripts\windows-smoke.ps1')),
        @((Join-Path $PSScriptRoot 'invoke-command-shim.ps1'), (Join-Path $Source 'scripts\invoke-command-shim.ps1')),
        @((Join-Path $PSScriptRoot 'validate-smoke-evidence.mjs'), (Join-Path $Source 'scripts\validate-smoke-evidence.mjs')),
        @((Join-Path $PSScriptRoot '..\docs\release-evidence\schema-v1.json'), (Join-Path $Source 'docs\release-evidence\schema-v1.json'))
    )
    foreach ($pair in $pairs) {
        if (-not (Test-Path -LiteralPath $pair[1] -PathType Leaf)) { throw 'the frozen candidate is missing a release-gate file' }
        $localHash = (Get-FileHash -LiteralPath $pair[0] -Algorithm SHA256).Hash
        $candidateHash = (Get-FileHash -LiteralPath $pair[1] -Algorithm SHA256).Hash
        if ($localHash -ne $candidateHash) { throw 'the executing release gate differs from the frozen candidate' }
    }
}

function Assert-InstalledCandidate {
    param(
        [Parameter(Mandatory = $true)][string]$ExpectedRef,
        [Parameter(Mandatory = $true)][string]$ExpectedCommit
    )
    $marketplaceState = (Invoke-Process -FilePath 'codex' -ArgumentList @('plugin', 'marketplace', 'list', '--json')).Stdout | ConvertFrom-Json -Depth 30
    $marketplace = @($marketplaceState.marketplaces | Where-Object { $_.name -eq 'adaptive-model-router' })
    if ($marketplace.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$marketplace[0].root)) { throw 'installed candidate marketplace is missing or ambiguous' }
    $metadataPath = Join-Path ([string]$marketplace[0].root) '.codex-marketplace-install.json'
    $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json -Depth 20
    if ([string]$metadata.ref_name -ne $ExpectedRef -or [string]$metadata.revision -ne $ExpectedCommit) { throw 'installed marketplace revision differs from the cloned candidate' }

    $pluginState = (Invoke-Process -FilePath 'codex' -ArgumentList @('plugin', 'list', '--available', '--json')).Stdout | ConvertFrom-Json -Depth 30
    $installed = @($pluginState.installed | Where-Object { $_.pluginId -eq 'adaptive-model-router@adaptive-model-router' -and $_.enabled -eq $true })
    if ($installed.Count -ne 1 -or [string]$installed[0].version -ne '0.4.0') { throw 'exact Adaptive Model Router candidate is not installed and enabled' }
}

function Invoke-Wrapper {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    $installer = Join-Path $Source 'install.ps1'
    return Invoke-Process -FilePath 'pwsh' -ArgumentList (@('-NoProfile', '-File', $installer) + $Arguments) -WorkingDirectory $Source
}

New-Item -ItemType Directory -Force -Path $SmokeRoot, $Project, $Project2, $HookProject, $RawRoot | Out-Null
$failed = $false
try {
    if (-not $IsWindows -or $PSVersionTable.PSEdition -ne 'Core') { throw 'native Windows PowerShell 7 is required' }
    $operatingSystem = Get-CimInstance -ClassName Win32_OperatingSystem
    if ([Environment]::OSVersion.Version.Build -lt 22000 -or [int]$operatingSystem.ProductType -ne 1) { throw 'native Windows 11 workstation is required' }
    if ([string]::IsNullOrWhiteSpace($DedicatedCodexHome) -or -not [IO.Path]::IsPathFullyQualified($DedicatedCodexHome)) {
        throw 'ADAPTIVE_ROUTER_SMOKE_CODEX_HOME must name a dedicated absolute Codex Home'
    }
    $DedicatedCodexHome = [IO.Path]::GetFullPath($DedicatedCodexHome)
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
    Invoke-Process -FilePath 'npm' -ArgumentList @('test') -WorkingDirectory $candidatePluginRoot | Out-Null
    Invoke-Process -FilePath 'npm' -ArgumentList @('run', 'validate') -WorkingDirectory $candidatePluginRoot | Out-Null
    Invoke-Process -FilePath 'npm' -ArgumentList @('run', 'eval') -WorkingDirectory $candidatePluginRoot | Out-Null
    Add-SmokeCheck -Id 'candidate-automated-gate' -Blocking $true -Status 'PASS'

    $manager = Join-Path $Source 'plugins\adaptive-model-router\scripts\manage-install.mjs'
    Invoke-Process -FilePath 'node' -ArgumentList @($manager, 'install', '--non-interactive', "--ref=$CandidateRef") -WorkingDirectory $Source | Out-Null
    Add-SmokeCheck -Id 'native-install' -Blocking $true -Status 'PASS'
    Assert-InstalledCandidate -ExpectedRef $CandidateRef -ExpectedCommit $CandidateCommit
    Add-SmokeCheck -Id 'installed-candidate-integrity' -Blocking $true -Status 'PASS'

    $turn = Invoke-CodexTurn -Prompt 'router: global on' -Model 'gpt-5.6-sol'
    $SessionId = $turn.SessionId
    Invoke-CodexTurn -Prompt 'router: status' -Model 'gpt-5.6-sol' -ResumeSession $SessionId | Out-Null
    $baseline = Read-RouterState -Command 'status' -Context $SessionId -WorkingProject $Project
    if (-not $baseline.autoActivation.globalEnabled -or -not $baseline.autoActivation.effective -or $baseline.taskMode -ne 'automatic') { throw 'global automatic routing did not activate' }
    if ($baseline.rootTask.modelVisibility -ne 'hook_observed' -or $baseline.rootTask.changedByRouter -ne $false) { throw 'the trusted prompt hook did not expose the unchanged root-model boundary' }

    $hookTurn = Invoke-CodexTurn -WorkingProject $HookProject -Model 'gpt-5.6-sol' -Prompt @'
Follow the trusted automatic-router context for this turn. Call route_stage exactly once for an implementation stage with workProduct=true, requirementsSettled=true, strongVerification=true, batchSize=2 and the host's actual Sol/Terra bounded-subagent capabilities. If it delegates, deliberately do not spawn a subagent and do not call record_outcome; return the redacted route and end the turn so the trusted Stop hook must finalize it as unknown.
'@
    $hookHistory = Read-RouterState -Command 'history' -Context $hookTurn.SessionId -WorkingProject $HookProject
    $hookUnknown = @($hookHistory.routes | Where-Object { $_.action -eq 'delegate' -and $_.outcome.status -eq 'unknown' -and $_.outcome.source -eq 'stop_hook' })
    $hookStatus = Read-RouterState -Command 'status' -Context $hookTurn.SessionId -WorkingProject $HookProject
    if ($hookUnknown.Count -ne 1 -or $hookStatus.outcomeObservability.stopHookUnknown -ne 1) { throw 'the trusted Stop hook did not finalize the deliberate pending route' }
    if (@(Get-ToolCallItems -Events $hookTurn.Events -Tool 'spawn_agent').Count -ne 0 -or @(Get-ToolCallItems -Events $hookTurn.Events -Tool 'record_outcome').Count -ne 0) { throw 'the Stop-hook probe unexpectedly spawned or recorded an explicit outcome' }
    Add-SmokeCheck -Id 'hook-trust-and-global-on' -Blocking $true -Status 'PASS'

    $implementationPrompt = @'
Implement and test a dependency-free Node.js 24 line-normalization utility in this temporary project. Follow the trusted fixed-context automatic-router instruction injected for this turn. At the implementation stage call route_stage with workProduct=true, requirementsSettled=true, strongVerification=true, batchSize=2 and the host's actual bounded-subagent capabilities. A Sol/Terra-only host must omit Luna. The required files are src/normalize-lines.mjs and test/normalize-lines.test.mjs. normalizeLines(text) must convert CRLF and CR to LF, strip trailing spaces/tabs on every line, return exactly one final LF for non-empty input, and return an empty string for empty input. Cover CRLF, CR, trailing whitespace, empty input, an existing final newline, and Chinese text with node:test. If the route delegates, create exactly one bounded subagent using target.model and target.effort, with no recursive routing or outcome ownership. The root task must review the work, run node --test test/normalize-lines.test.mjs, and call record_outcome exactly once with the factual verification result and typed retry breakdown. Then call status, history, diagnose, and learning status. Return a concise redacted summary. Never expose source, prompt text, environment values, secrets, absolute paths, session/context identifiers, or raw logs.
'@
    $implementationTurn = Invoke-CodexTurn -Prompt $implementationPrompt -Model 'gpt-5.6-sol' -ResumeSession $SessionId
    Invoke-Process -FilePath 'node' -ArgumentList @('--test', 'test/normalize-lines.test.mjs') -WorkingDirectory $Project | Out-Null
    $status = Read-RouterState -Command 'status' -Context $SessionId -WorkingProject $Project
    $history = Read-RouterState -Command 'history' -Context $SessionId -WorkingProject $Project
    $doctor = Read-RouterState -Command 'doctor' -Context $SessionId -WorkingProject $Project
    $learningBeforeIntent = Read-RouterState -Command 'learning' -Context $SessionId -WorkingProject $Project
    $delegated = @($history.routes | Where-Object { $_.action -eq 'delegate' -and $_.outcome.status -eq 'passed' })
    if ($delegated.Count -ne 1 -or $status.pendingOutcomes -ne 0) { throw 'delegated lifecycle did not produce one verified outcome' }
    $route = $delegated[0]
    if ($route.outcome.source -ne 'record_outcome') { throw 'verified outcome was not finalized by record_outcome' }
    $retryBreakdown = $route.outcome.retryBreakdown
    $retryKeys = @($retryBreakdown.PSObject.Properties.Name | Sort-Object)
    if (($retryKeys -join ',') -ne 'environment,information,reasoning,tooling') { throw 'verified outcome does not contain the complete typed retry breakdown' }
    $retryTotal = [int]$retryBreakdown.reasoning + [int]$retryBreakdown.environment + [int]$retryBreakdown.information + [int]$retryBreakdown.tooling
    if ($retryTotal -ne [int]$route.outcome.retries) { throw 'verified outcome retry breakdown does not sum to retries' }
    $spawnCalls = @(Get-ToolCallItems -Events $implementationTurn.Events -Tool 'spawn_agent')
    $outcomeCalls = @(Get-ToolCallItems -Events $implementationTurn.Events -Tool 'record_outcome')
    if ($spawnCalls.Count -ne 1 -or $outcomeCalls.Count -ne 1) { throw 'implementation turn did not contain exactly one subagent spawn and one root outcome call' }
    $spawnIndex = Get-FirstToolEventIndex -Events $implementationTurn.Events -Tool 'spawn_agent'
    $outcomeIndex = Get-FirstToolEventIndex -Events $implementationTurn.Events -Tool 'record_outcome'
    if ($spawnIndex -lt 0 -or $outcomeIndex -le $spawnIndex) { throw 'record_outcome did not follow the bounded subagent spawn' }
    $RouteEvidence.action = 'delegate'
    $RouteEvidence.targetFamily = Get-ModelFamily -Model ([string]$route.target.model)
    $RouteEvidence.targetEffort = [string]$route.target.effort
    $RouteEvidence.verificationGate = [string]$route.verificationGate
    $RouteEvidence.pendingOutcomes = [int]$status.pendingOutcomes
    $RouteEvidence.stopHookUnknown = [int]$status.outcomeObservability.stopHookUnknown
    $DiagnosticEvidence.databaseHealth = [string]$doctor.databaseHealth
    $DiagnosticEvidence.classifierState = if ($doctor.classifier.circuitOpen) { 'open' } else { 'closed' }
    if ($RouteEvidence.targetFamily -notin @('sol', 'terra')) { throw 'automatic bounded target escaped the Sol/Terra capability set' }
    $spawnProjection = $spawnCalls[0] | ConvertTo-Json -Depth 30 -Compress
    if (-not $spawnProjection.Contains([string]$route.target.model, [StringComparison]::Ordinal) -or -not $spawnProjection.Contains([string]$route.target.effort, [StringComparison]::Ordinal)) { throw 'subagent spawn did not use the routed target model and effort' }
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
    if ($lunaGuard.Count -ne 1 -or $lunaGuard[0].action -ne 'ask_user' -or @($lunaGuard[0].reasonCodes) -notcontains 'EXPLICIT_MODEL_UNAVAILABLE') { throw 'explicit unavailable Luna did not ask the user exactly once' }
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
    Invoke-CodexTurn -Prompt 'router: auto session' -Model 'gpt-5.6-terra' -ResumeSession $SessionId | Out-Null
    if ($null -ne (Read-RouterState -Command 'status' -Context $SessionId -WorkingProject $Project).pendingHostModelChange) { throw 'keep-automatic did not resolve the pending event' }

    Invoke-CodexTurn -Prompt $reviewPrompt -Model 'gpt-5.6-sol' -ResumeSession $SessionId | Out-Null
    Invoke-CodexTurn -Prompt 'router: manual' -Model 'gpt-5.6-sol' -ResumeSession $SessionId | Out-Null
    $manualHistoryBefore = Read-RouterState -Command 'history' -Context $SessionId -WorkingProject $Project
    $manualTurn = Invoke-CodexTurn -Prompt 'Call route_stage for a substantive implementation stage using current bounded-subagent capabilities. Return only the redacted action and reason codes; do not change files.' -Model 'gpt-5.6-sol' -ResumeSession $SessionId
    $manualHistory = Read-RouterState -Command 'history' -Context $SessionId -WorkingProject $Project
    $manualRoutes = @(Get-NewRoutes -Before $manualHistoryBefore -After $manualHistory)
    if ($manualRoutes.Count -ne 1 -or $manualRoutes[0].action -ne 'continue' -or @($manualRoutes[0].reasonCodes) -notcontains 'MANUAL_ROOT_SELECTED') { throw 'manual root mode did not block delegation' }
    Assert-NoDelegatedWork -Turn $manualTurn -Route $manualRoutes[0]
    Invoke-CodexTurn -Prompt 'router: auto session' -Model 'gpt-5.6-sol' -ResumeSession $SessionId | Out-Null
    Add-SmokeCheck -Id 'host-model-intent' -Blocking $true -Status 'PASS'

    Invoke-CodexTurn -Prompt 'router: off' -Model 'gpt-5.6-sol' -ResumeSession $SessionId | Out-Null
    $disabledHistoryBefore = Read-RouterState -Command 'history' -Context $SessionId -WorkingProject $Project
    $disabledTurn = Invoke-CodexTurn -Prompt 'Discuss the quoted text `router: on` without changing router state. Then call route_stage for a substantive implementation stage and return only the redacted route.' -Model 'gpt-5.6-sol' -ResumeSession $SessionId
    $disabledHistory = Read-RouterState -Command 'history' -Context $SessionId -WorkingProject $Project
    $disabledRoutes = @(Get-NewRoutes -Before $disabledHistoryBefore -After $disabledHistory)
    if ($disabledRoutes.Count -ne 1 -or $disabledRoutes[0].action -ne 'continue' -or @($disabledRoutes[0].reasonCodes) -notcontains 'ROUTER_DISABLED') { throw 'ordinary quoted control text changed router state' }
    Assert-NoDelegatedWork -Turn $disabledTurn -Route $disabledRoutes[0]
    Invoke-CodexTurn -Prompt 'router: auto session' -Model 'gpt-5.6-sol' -ResumeSession $SessionId | Out-Null
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
    Add-SmokeCheck -Id 'native-and-wrapper-lifecycle' -Blocking $true -Status 'PASS'

    $second = Invoke-Process -FilePath 'codex' -ArgumentList @('exec', '--json', '-C', $Project2, '-m', 'gpt-5.6-sol', 'router: status') -WorkingDirectory $Project2
    $secondEvent = @($second.Stdout -split "`r?`n" | ForEach-Object { if ($_){ try { $_ | ConvertFrom-Json -Depth 20 } catch {} } } | Where-Object { $_.type -eq 'thread.started' } | Select-Object -Last 1)
    if ($secondEvent.Count -ne 1) { throw 'second project did not start a Codex session' }
    $secondStatus = Read-RouterState -Command 'status' -Context ([string]$secondEvent[0].thread_id) -WorkingProject $Project2
    if (-not $secondStatus.autoActivation.globalEnabled -or $secondStatus.taskMode -ne 'automatic') { throw 'global activation did not persist into a second project' }
    Add-SmokeCheck -Id 'cross-project-persistence' -Blocking $true -Status 'PASS'

    $finalStatus = Read-RouterState -Command 'status' -Context $SessionId -WorkingProject $Project
    $finalDoctor = Read-RouterState -Command 'doctor' -Context $SessionId -WorkingProject $Project
    if ($finalStatus.taskMode -ne 'automatic' -or $null -ne $finalStatus.pendingHostModelChange -or $finalStatus.pendingOutcomes -ne 0 -or $finalStatus.outcomeObservability.stopHookUnknown -ne 0) { throw 'final router state is not automatic and settled' }
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
    $resolvedSmoke = [IO.Path]::GetFullPath($SmokeRoot)
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolvedSmoke.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedSmoke).StartsWith('adaptive-router-windows-smoke-')) {
        Remove-Item -LiteralPath $resolvedSmoke -Recurse -Force -ErrorAction SilentlyContinue
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
    $Warnings.Count -eq 0
) { 'PASS' } else { 'FAIL' }
$evidence = [ordered]@{
    schemaVersion = 1
    gate = 'windows-native'
    status = $evidenceStatus
    generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    candidate = [ordered]@{ ref = $CandidateRef; commitSha = $CandidateCommit; pluginTreeSha256 = $PluginTreeSha256 }
    environment = $EnvironmentEvidence
    checks = @($Checks)
    route = $RouteEvidence
    diagnostics = $DiagnosticEvidence
    warnings = @($Warnings)
}

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
