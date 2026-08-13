[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$CommandPath,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CommandArguments
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

& $CommandPath @CommandArguments
exit $LASTEXITCODE
