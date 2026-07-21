param(
    [ValidateSet("Install", "Upgrade", "Uninstall")]
    [string]$Action = "Install",
    [string]$Ref = "stable",
    [switch]$PatchAgents,
    [switch]$NonInteractive,
    [switch]$Yes
)

$ErrorActionPreference = "Stop"

$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) {
    Write-Error "Adaptive Model Router requires Node.js 24.15.0 or newer."
    exit 2
}

$nodeVersionText = & $node.Source -p "process.versions.node"
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

$codex = Get-Command codex -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
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
if ($Yes) { $managerArgs += "--yes" }

& $node.Source $manager @managerArgs
exit $LASTEXITCODE
