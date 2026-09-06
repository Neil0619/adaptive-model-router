param([Parameter(Mandatory=$true)][string]$CodexHome)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if (-not $IsWindows -or -not [IO.Path]::IsPathFullyQualified($CodexHome)) { throw 'native Windows and an absolute smoke Home are required' }
$marker=Join-Path $CodexHome '.adaptive-router-smoke-home'
if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -or (Get-Content -LiteralPath $marker -Raw).Trim() -ne 'adaptive-model-router smoke home v1') { throw 'dedicated smoke Home marker is missing' }
$cache=[IO.Path]::GetFullPath((Join-Path $CodexHome 'plugins\cache\adaptive-model-router\adaptive-model-router')).TrimEnd('\')
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class SmokeRouterProcessDirectory {
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int id);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr handle, IntPtr address, byte[] buffer, int size, out IntPtr read);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle, int kind, byte[] data, int length, out int returned);
    static byte[] Read(IntPtr h, long address, int length) {
        var bytes = new byte[length];
        if (!ReadProcessMemory(h, new IntPtr(address), bytes, length, out var count) || count.ToInt64() != length) throw new InvalidOperationException("PROCESS_DIRECTORY_READ_FAILED");
        return bytes;
    }
    public static string Get(int id) {
        var h = OpenProcess(0x410, false, id);
        if (h == IntPtr.Zero) throw new InvalidOperationException("PROCESS_OPEN_FAILED");
        try {
            var info = new byte[48];
            if (NtQueryInformationProcess(h, 0, info, info.Length, out var returned) != 0) throw new InvalidOperationException("PROCESS_QUERY_FAILED");
            long peb = BitConverter.ToInt64(info, 8);
            long parameters = BitConverter.ToInt64(Read(h, peb + 0x20, 8), 0);
            var unicode = Read(h, parameters + 0x38, 16);
            int length = BitConverter.ToUInt16(unicode, 0);
            if (length < 2 || length > 32766) throw new InvalidOperationException("PROCESS_DIRECTORY_INVALID");
            return Encoding.Unicode.GetString(Read(h, BitConverter.ToInt64(unicode, 8), length));
        } finally { CloseHandle(h); }
    }
}
'@
if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne [Runtime.InteropServices.Architecture]::X64) { throw 'verified process-directory inspection requires Windows x64' }
$stopped=0
$candidates=@(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -match '(?:node-launcher|mcp-server)\.mjs' })
foreach ($entry in $candidates) {
    if (-not (Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue)) { continue }
    try { $directory=[IO.Path]::GetFullPath([SmokeRouterProcessDirectory]::Get($entry.ProcessId)).TrimEnd('\') }
    catch {
        if (-not (Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue)) { continue }
        throw
    }
    if (-not $directory.StartsWith($cache+'\',[StringComparison]::OrdinalIgnoreCase)) { continue }
    $current=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$entry.ProcessId)
    if ($null -eq $current) { continue }
    if ($current.CreationDate -ne $entry.CreationDate) { throw 'PROCESS_ID_REUSED' }
    try { $verified=[IO.Path]::GetFullPath([SmokeRouterProcessDirectory]::Get($entry.ProcessId)).TrimEnd('\') }
    catch {
        if (-not (Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue)) { continue }
        throw
    }
    if ($verified -ne $directory) { throw 'PROCESS_DIRECTORY_CHANGED' }
    try { Stop-Process -Id $entry.ProcessId -ErrorAction Stop }
    catch {
        if (-not (Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue)) { continue }
        throw
    }
    $process=Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue
    if ($process -and -not $process.WaitForExit(5000)) { throw 'PROCESS_STOP_TIMEOUT' }
    $stopped++
}
[pscustomobject]@{StoppedRouterProcesses=$stopped;Scope='dedicated-smoke-plugin-cache'} | ConvertTo-Json -Compress
