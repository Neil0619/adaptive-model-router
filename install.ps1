param(
    [ValidateSet("Install", "Upgrade", "Repair", "Uninstall")]
    [string]$Action = "Install",
    [string]$Ref = "stable",
    [switch]$PatchAgents,
    [switch]$NonInteractive,
    [switch]$VerifyTaskTools,
    [switch]$Yes
)

$ErrorActionPreference = "Stop"

$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) {
    Write-Error "Adaptive Model Router requires Node.js 24.15.0 or newer."
    exit 2
}

# Uninstall removes the Desktop node.cmd compatibility bridge. Resolve its
# real executable before running the manager so cmd.exe never resumes a batch
# file that the uninstall just deleted.
$nodePathText = & $node.Source -p "process.execPath"
if ($LASTEXITCODE -ne 0 -or -not [IO.Path]::IsPathRooted([string]$nodePathText)) {
    Write-Error "Unable to resolve the installed Node.js executable."
    exit 2
}
$nodePath = ([string]$nodePathText).Trim()
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
    Write-Error "The installed Node.js executable is unavailable."
    exit 2
}
$nodeVersionText = & $nodePath -p "process.versions.node"
try {
    $nodeVersion = [System.Version]$nodeVersionText.Trim()
} catch {
    Write-Error "Unable to determine the installed Node.js version."
    exit 2
}
if ($LASTEXITCODE -ne 0 -or $nodeVersion -lt [System.Version]"24.15.0") {
    Write-Error "Adaptive Model Router requires Node.js 24.15.0 or newer."
    exit 2
}

$git = Get-Command git -ErrorAction SilentlyContinue
if ($null -eq $git) {
    Write-Error "Adaptive Model Router requires Git."
    exit 2
}

$codex = $null
if ($env:CODEX_BIN) {
    $codex = Get-Command -Name $env:CODEX_BIN -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
} else {
    $codex = Get-Command codex.exe -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -eq $codex) {
        $codex = Get-Command codex -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -First 1
    }
}
if ($null -eq $codex) {
    Write-Error "Adaptive Model Router requires the Codex CLI."
    exit 2
}

$codexPath = $codex.Source
if ($codexPath.EndsWith(".ps1", [System.StringComparison]::OrdinalIgnoreCase)) {
    $cmdShim = [System.IO.Path]::ChangeExtension($codexPath, ".cmd")
    if (Test-Path $cmdShim) {
        $codexPath = $cmdShim
    } else {
        Write-Error "Adaptive Model Router requires codex.exe or codex.cmd, not only a PowerShell shim."
        exit 2
    }
}

$env:CODEX_BIN = $codexPath
$manager = Join-Path $PSScriptRoot "plugins/adaptive-model-router/scripts/manage-install.mjs"
$managerArgs = @($Action.ToLowerInvariant(), "--ref=$Ref")
if ($PatchAgents) { $managerArgs += "--patch-agents" }
if ($NonInteractive) { $managerArgs += "--non-interactive" }
if ($VerifyTaskTools) { $managerArgs += "--verify-task-tools" }
if ($Yes) { $managerArgs += "--yes" }

& $nodePath $manager @managerArgs
exit $LASTEXITCODE
