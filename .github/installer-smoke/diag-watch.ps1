# Diagnostics for the Windows e2e scenario (runs detached for up to 25 minutes).
#  -Mode bridge : poll the native identity (volume serial, file index, size,
#                 link count) of every directory FyAgent's package bridge holds
#                 (volume root, ProgramData, bridge root, v1, operation dirs)
#                 every 50 ms and log each change.
#  -Mode procs  : log every helper / node / npm / installer process seen.
#  -Mode churn  : create a sibling directory under -Dir every 200 ms.
#  -Mode explorerprep : synchronous; probe the Explorer desktop view that
#                 FyAgent's helper launch uses and, with -Dir restart, restart
#                 explorer.exe until FindWindowSW(SWC_DESKTOP) returns S_OK.
#                 Test-environment preparation only; writes explorer-prep.json.
param([string]$Mode, [string]$Out, [string]$Dir = "")
$ErrorActionPreference = "Continue"
$end = (Get-Date).AddMinutes(25)
function Log($file, $obj) { $obj["at"] = (Get-Date).ToUniversalTime().ToString("o"); ($obj | ConvertTo-Json -Compress) | Add-Content -Encoding utf8 -Path $file }
function Add-SmokeShell {
  Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
[ComImport, Guid("85CB6900-4D95-11CF-960C-0080C7F4EE85"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ISmokeShellWindows {
  void GetTypeInfoCount(); void GetTypeInfo(); void GetIDsOfNames(); void Invoke();
  [PreserveSig] int get_Count(out int c);
  void Item(); void NewEnum(); void Register(); void RegisterPending(); void Revoke(); void OnNavigate(); void OnActivated();
  [PreserveSig] int FindWindowSW([In] ref object loc, [In] ref object locRoot, int swClass, out int hwnd, int options, [MarshalAs(UnmanagedType.IDispatch)] out object disp);
}
public static class SmokeShell {
  public static object Desktop(out string info) {
    var t = Type.GetTypeFromCLSID(new Guid("9BA05972-F6A8-11CF-A442-00A0C90A8F39"));
    object sw = Activator.CreateInstance(t);
    var raw = (ISmokeShellWindows)sw;
    int count; int hrc = raw.get_Count(out count);
    object e1 = null, e2 = null; int hwnd; object disp;
    int hr = raw.FindWindowSW(ref e1, ref e2, 8, out hwnd, 1, out disp);
    info = string.Format("count_hr=0x{0:X8} count={1} find_hr=0x{2:X8} hwnd=0x{3:X} disp={4}", hrc, count, hr, hwnd, disp != null);
    return disp;
  }
}
"@
}
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
if ($Mode -eq "explorerprep") {
  Add-SmokeShell
  function Probe { $i = ""; try { $null = [SmokeShell]::Desktop([ref]$i) } catch { $i = "error=$($_.Exception.Message)" }; $i }
  $before = Probe
  $res = [ordered]@{ before = $before; restarted = $false; after = $null; attempts = @() }
  if ($Dir -eq "restart" -and $before -notmatch "find_hr=0x00000000") {
    $res.restarted = $true
    Get-Process explorer -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 5
    if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }
    for ($k = 0; $k -lt 20; $k++) {
      Start-Sleep -Seconds 3
      $now = Probe; $res.attempts += $now
      if ($now -match "find_hr=0x00000000") { break }
    }
  }
  $res.after = Probe
  $res.explorer = (Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | ForEach-Object { "pid=$($_.ProcessId) session=$($_.SessionId)" }) -join "; "
  ($res | ConvertTo-Json -Depth 4) | Set-Content -Encoding utf8 -Path (Join-Path $Out "explorer-prep.json")
  $res | ConvertTo-Json -Depth 4
  exit 0
}
if ($Mode -eq "shellprobe") {
  # One-shot: replay FyAgent's pre-launch helper steps outside FyAgent to see
  # which one fails (Explorer desktop ShellWindows route, helper image open).
  $f = Join-Path $Out "shellprobe.jsonl"
  Start-Sleep -Seconds 20
  function Step($name, [scriptblock]$body) { try { $r = & $body; Log $f ([ordered]@{ step = $name; ok = $true; result = "$r" }) } catch { Log $f ([ordered]@{ step = $name; ok = $false; error = "$($_.Exception.GetType().FullName): $($_.Exception.Message)"; hresult = ('0x{0:X8}' -f $_.Exception.HResult) }) } }
  Add-SmokeShell
  Step "whoami" { (whoami) + " elevated=" + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
  Step "explorer" { (Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | ForEach-Object { "pid=$($_.ProcessId) session=$($_.SessionId) owner=$((Invoke-CimMethod -InputObject $_ -MethodName GetOwner).User)" }) -join "; " }
  Step "os" { (Get-CimInstance Win32_OperatingSystem | ForEach-Object { "$($_.Caption) $($_.Version) $($_.OSArchitecture)" }) }
  $script:desk = $null
  Step "findwindowsw-desktop" { $i = ""; $script:desk = [SmokeShell]::Desktop([ref]$i); $i }
  Step "desktop-document" { $d = $script:desk.Document; "doc=" + ($null -ne $d) }
  Step "desktop-application-shellexecute" { $marker = Join-Path $Out "shellprobe-marker.txt"; $script:desk.Document.Application.ShellExecute("cmd.exe", "/c echo launched-by-explorer > `"$marker`"", "", "", 0); Start-Sleep -Seconds 3; "marker=" + (Test-Path $marker) }
  $helper = "C:\Program Files\FyAgent\fyagent-user-helper.exe"
  Step "helper-open-share-read" { $h = [IO.File]::Open($helper, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read); $len = $h.Length; $h.Close(); "len=$len" }
  Step "helper-pe-machine" { $b = [IO.File]::ReadAllBytes($helper); $pe = [BitConverter]::ToInt32($b, 0x3c); '0x{0:X4}' -f [BitConverter]::ToUInt16($b, $pe + 4) }
  Step "helper-run-direct" { $p = Start-Process -FilePath $helper -ArgumentList "--version" -PassThru -WindowStyle Hidden; if (-not $p.WaitForExit(10000)) { $p.Kill(); "timeout" } else { "exit=$($p.ExitCode)" } }
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
