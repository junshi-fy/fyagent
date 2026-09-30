# Diagnostics for the Windows e2e scenario (runs detached for up to 25 minutes).
#  -Mode bridge : poll the native identity (volume serial, file index, size,
#                 link count) of every directory FyAgent's package bridge holds
#                 (volume root, ProgramData, bridge root, v1, operation dirs)
#                 every 50 ms and log each change.
#  -Mode procs  : log every helper / node / npm / installer process seen.
#  -Mode churn  : create a sibling directory under -Dir every 200 ms.
param([string]$Mode, [string]$Out, [string]$Dir = "")
$ErrorActionPreference = "Continue"
$end = (Get-Date).AddMinutes(25)
function Log($file, $obj) { $obj["at"] = (Get-Date).ToUniversalTime().ToString("o"); ($obj | ConvertTo-Json -Compress) | Add-Content -Encoding utf8 -Path $file }
if ($Mode -eq "procs") {
  $f = Join-Path $Out "proc-trace.jsonl"; Log $f ([ordered]@{ event = "started" })
  $seen = @{}
  while ((Get-Date) -lt $end) {
    Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'fyagent-user-helper|node|npm|claude|grok|AppInstaller|msiexec|Setup|codex' } | ForEach-Object {
      if (-not $seen.ContainsKey($_.ProcessId)) { $seen[$_.ProcessId] = 1; Log $f ([ordered]@{ event = "seen"; pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; cmd = $_.CommandLine; path = $_.ExecutablePath; session = $_.SessionId }) }
    }
    Start-Sleep -Milliseconds 300
  }
  exit 0
}
if ($Mode -eq "churn") {
  $f = Join-Path $Out "churn.jsonl"; Log $f ([ordered]@{ event = "started"; dir = $Dir }); $i = 0
  while ((Get-Date) -lt $end) { $i++; try { New-Item -ItemType Directory -Force -Path (Join-Path $Dir ("smoke-churn-" + $i)) -ErrorAction Stop | Out-Null } catch { Log $f ([ordered]@{ event = "error"; i = $i; error = "$_" }) }; if ($i % 50 -eq 0) { Log $f ([ordered]@{ event = "count"; i = $i }) }; Start-Sleep -Milliseconds 200 }
  exit 0
}
if ($Mode -eq "bridge") {
  Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles;
public static class SmokeFileId {
  [StructLayout(LayoutKind.Sequential)] public struct BHFI { public uint attr, c1, c2, a1, a2, w1, w2, vol, sizeHigh, sizeLow, links, idxHigh, idxLow; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern SafeFileHandle CreateFileW(string n, uint acc, uint share, IntPtr sa, uint disp, uint flags, IntPtr t);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out BHFI i);
  public static string Id(string p) {
    using (var h = CreateFileW(p, 0x80, 7, IntPtr.Zero, 3, 0x02000000 | 0x00200000, IntPtr.Zero)) {
      if (h.IsInvalid) return "open_error=" + Marshal.GetLastWin32Error();
      BHFI i; if (!GetFileInformationByHandle(h, out i)) return "query_error=" + Marshal.GetLastWin32Error();
      return string.Format("vol={0:x} idx={1:x8}{2:x8} size={3} links={4} attr={5:x}", i.vol, i.idxHigh, i.idxLow, ((ulong)i.sizeHigh << 32) | i.sizeLow, i.links, i.attr);
    }
  }
}
"@
  $f = Join-Path $Out "bridge-watch.jsonl"
  $pd = [Environment]::GetFolderPath("CommonApplicationData")
  $vol = [IO.Path]::GetPathRoot($pd)
  $root = Join-Path $pd "FyAgent.PackageBridge-{96F39D37-0F42-486F-8C86-3631C12171C5}"
  $v1 = Join-Path $root "v1"
  $fs = (Get-Volume -DriveLetter $vol.Substring(0, 1) -ErrorAction SilentlyContinue)
  Log $f ([ordered]@{ event = "started"; programData = $pd; volumeRoot = $vol; fileSystem = $fs.FileSystem; fsType = $fs.FileSystemType })
  $last = @{}
  while ((Get-Date) -lt $end) {
    $paths = @($vol, $pd, $root, $v1)
    if (Test-Path -LiteralPath $v1) { $paths += (Get-ChildItem -LiteralPath $v1 -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }) }
    foreach ($p in $paths) {
      $id = [SmokeFileId]::Id($p)
      if ($last[$p] -ne $id) { Log $f ([ordered]@{ event = "identity"; path = $p; before = $last[$p]; now = $id }); $last[$p] = $id }
    }
    Start-Sleep -Milliseconds 50
  }
  exit 0
}
