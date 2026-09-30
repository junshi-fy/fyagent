# Plays the "user" in a third-party vendor installer wizard that FyAgent opened
# (QoderWork / TRAE / WorkBuddy on Windows). Uses UI Automation only: accepts
# the licence, keeps per-user scope, presses Next/Install/Finish until the
# wizard window disappears or the timeout expires. Writes a JSON log.
param([string]$Out = "smoke-out", [string]$Tag = "wizard", [int]$TimeoutS = 240)
$ErrorActionPreference = "Continue"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$T = [System.Windows.Automation.TreeScope]
$C = [System.Windows.Automation.Condition]::TrueCondition
$log = New-Object System.Collections.ArrayList
$skip = @("fyagent", "OpenCode", "explorer", "msedgewebview2", "powershell", "pwsh", "node", "conhost", "WindowsTerminal", "Codex")
$accept = '^(I accept|I Agree|I agree|我接受|我同意|同意)'
$press = @('^Install Now$', '^I Agree$', '^Accept$', '^Install$', '^Next ?>?$', '^下一步', '^安装$', '^立即安装$', '^Finish$', '^完成$', '^Close$', '^关闭$')
$deadline = (Get-Date).AddSeconds($TimeoutS)
$idle = 0
while ((Get-Date) -lt $deadline) {
  $wins = $A::RootElement.FindAll($T::Children, $C) | Where-Object {
    $p = $null; try { $p = Get-Process -Id $_.Current.ProcessId -ErrorAction Stop } catch {}
    $p -and ($skip -notcontains $p.ProcessName) -and ($_.Current.Name -match 'Setup|安装|Install|Wizard|向导')
  }
  if (-not $wins) { $idle += 1; if ($idle -ge 6) { break }; Start-Sleep 5; continue }
  $idle = 0
  foreach ($w in $wins) {
    $name = $w.Current.Name
    $all = $w.FindAll($T::Descendants, $C)
    foreach ($e in $all) {
      $ct = $e.Current.ControlType.ProgrammaticName; $n = $e.Current.Name
      if ($ct -eq "ControlType.RadioButton" -and ($n -match $accept -or $n -match 'Only for me|仅为我|当前用户')) {
        try { $e.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select(); [void]$log.Add("[$name] select '$n'") } catch {}
      }
      if ($ct -eq "ControlType.CheckBox" -and $n -match $accept) {
        try { $tp = $e.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern); if ($tp.Current.ToggleState -ne "On") { $tp.Toggle(); [void]$log.Add("[$name] check '$n'") } } catch {}
      }
    }
    $buttons = $all | Where-Object { $_.Current.ControlType.ProgrammaticName -eq "ControlType.Button" -and $_.Current.IsEnabled }
    $done = $false
    foreach ($rx in $press) {
      $b = $buttons | Where-Object { $_.Current.Name -match $rx } | Select-Object -First 1
      if ($b) {
        try { $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); [void]$log.Add("[$name] press '$($b.Current.Name)'"); $done = $true } catch { [void]$log.Add("[$name] press failed '$($b.Current.Name)': $_") }
        break
      }
    }
    if (-not $done) { [void]$log.Add("[$name] waiting (buttons: $((($buttons | ForEach-Object { $_.Current.Name }) -join ' / ')))") }
  }
  Start-Sleep 4
}
$left = $A::RootElement.FindAll($T::Children, $C) | ForEach-Object { $_.Current.Name } | Where-Object { $_ -match 'Setup|安装|Install' }
[ordered]@{ tag = $Tag; finishedAt = (Get-Date).ToUniversalTime().ToString("o"); actions = $log; remainingWindows = @($left) } |
  ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $Out "wizard-$Tag.json")
