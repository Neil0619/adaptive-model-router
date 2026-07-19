param(
    [ValidateSet("Install", "Upgrade", "Uninstall")]
    [string]$Action = "Install",
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

& $node.Source -e 'const v=process.versions.node.split(".").map(Number); process.exit(v[0]>24 || (v[0]===24 && v[1]>=15) ? 0 : 1)'
if ($LASTEXITCODE -ne 0) {
    Write-Error "Adaptive Model Router requires Node.js 24.15.0 or newer."
    exit 2
}

$git = Get-Command git -ErrorAction SilentlyContinue
if ($null -eq $git) {
    Write-Error "Adaptive Model Router requires Git."
    exit 2
}

$codex = Get-Command codex.exe -ErrorAction SilentlyContinue
if ($null -eq $codex) { $codex = Get-Command codex.cmd -ErrorAction SilentlyContinue }
if ($null -eq $codex) { $codex = Get-Command codex -ErrorAction SilentlyContinue }
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
$managerArgs = @($Action.ToLowerInvariant())
if ($PatchAgents) { $managerArgs += "--patch-agents" }
if ($NonInteractive) { $managerArgs += "--non-interactive" }
if ($Yes) { $managerArgs += "--yes" }

& $node.Source $manager @managerArgs
exit $LASTEXITCODE
