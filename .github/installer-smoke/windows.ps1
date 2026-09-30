# Installer smoke test on a throwaway GitHub-hosted Windows VM.
# Phases: install | probe <label> | tools | opencode-desktop
# Env: SMOKE_OUT, SMOKE_ASSET (verified setup.exe path)
param(
  [Parameter(Mandatory = $true)][string]$Phase,
  [string]$Label = "probe"
)
$ErrorActionPreference = "Continue"
$Out = $env:SMOKE_OUT
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Save-Json($Name, $Object) {
  $Object | ConvertTo-Json -Depth 12 | Set-Content -Encoding utf8 -Path (Join-Path $Out $Name)
}

function Get-SignatureInfo($Path) {
  if (-not (Test-Path $Path)) { return $null }
  $sig = Get-AuthenticodeSignature -FilePath $Path
  [ordered]@{
    path          = $Path
    status        = "$($sig.Status)"
    statusMessage = $sig.StatusMessage
    signer        = $sig.SignerCertificate.Subject
    issuer        = $sig.SignerCertificate.Issuer
    timestamper   = $sig.TimeStamperCertificate.Subject
  }
}

function Get-FileVersionInfoSafe($Path) {
  try {
    $v = (Get-Item $Path).VersionInfo
    [ordered]@{ productName = $v.ProductName; productVersion = $v.ProductVersion; fileVersion = $v.FileVersion; companyName = $v.CompanyName }
  } catch { $null }
}

function Get-UninstallEntries($Pattern) {
  $roots = @(
    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"
  )
  foreach ($root in $roots) {
    if (-not (Test-Path $root)) { continue }
    Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
      $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
      if ($p.DisplayName -like $Pattern) {
        [ordered]@{
          hive = $root; key = $_.PSChildName; displayName = $p.DisplayName; displayVersion = $p.DisplayVersion
          publisher = $p.Publisher; installLocation = $p.InstallLocation; displayIcon = $p.DisplayIcon
          uninstallString = $p.UninstallString; quietUninstallString = $p.QuietUninstallString
        }
      }
    }
  }
}

function Save-DesktopScreenshot($Name) {
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bmp.Size)
    $bmp.Save((Join-Path $Out $Name), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    return "$($bounds.Width)x$($bounds.Height)"
  } catch { return "screenshot failed: $_" }
}

function Get-PeMachine($Path) {
  try {
    $fs = [IO.File]::OpenRead($Path); $br = New-Object IO.BinaryReader($fs)
    $fs.Seek(0x3C, 'Begin') | Out-Null; $off = $br.ReadInt32()
    $fs.Seek($off + 4, 'Begin') | Out-Null; $m = $br.ReadUInt16(); $fs.Close()
    switch ($m) { 0x8664 { "x64" } 0xAA64 { "arm64" } 0x014C { "x86" } default { "0x{0:X4}" -f $m } }
  } catch { "unknown" }
}

function Get-FyAgentExe {
  $state = Get-Content (Join-Path $Out "install.json") -Raw | ConvertFrom-Json
  return $state.exe
}

switch ($Phase) {
  "install" {
    $asset = $env:SMOKE_ASSET
    $result = [ordered]@{
      phase = "install"; asset = $asset; runner = $env:RUNNER_NAME; arch = $env:PROCESSOR_ARCHITECTURE
      os = (Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, OSArchitecture)
      user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
      isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
      uacEnableLUA = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" -ErrorAction SilentlyContinue).EnableLUA
      explorerRunning = [bool](Get-Process explorer -ErrorAction SilentlyContinue)
      installerSignature = Get-SignatureInfo $asset
      installerZoneIdentifier = (Get-Content -Path $asset -Stream Zone.Identifier -ErrorAction SilentlyContinue) -join "`n"
      webView2Runtime = @(
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
      ) | ForEach-Object { (Get-ItemProperty $_ -ErrorAction SilentlyContinue).pv } | Where-Object { $_ }
    }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $p = Start-Process -FilePath $asset -ArgumentList "/S" -Wait -PassThru
    $result.installerExitCode = $p.ExitCode
    $result.installSeconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    $entries = @(Get-UninstallEntries "FyAgent*")
    $result.uninstallEntries = $entries
    $location = ($entries | Where-Object { $_.installLocation } | Select-Object -First 1).installLocation
    if (-not $location) {
      foreach ($c in @("$env:ProgramFiles\FyAgent", "${env:ProgramFiles(x86)}\FyAgent", "$env:LOCALAPPDATA\Programs\FyAgent")) {
        if (Test-Path $c) { $location = $c; break }
      }
    }
    $location = "$location".Trim('"')
    $result.installLocation = $location
    if ($location -and (Test-Path $location)) {
      $result.files = @(Get-ChildItem -Path $location -Recurse -File -ErrorAction SilentlyContinue |
        Select-Object @{n = "path"; e = { $_.FullName.Substring($location.Length).TrimStart('\') } }, Length)
      $exe = @(Get-ChildItem -Path $location -Filter "*.exe" -File | Where-Object { $_.Name -notmatch "uninstall|helper" } | Select-Object -First 1).FullName
      $result.exe = $exe
      $result.exeSignature = Get-SignatureInfo $exe
      $result.exeVersionInfo = Get-FileVersionInfoSafe $exe
      $helper = @(Get-ChildItem -Path $location -Recurse -Filter "fyagent-user-helper*.exe" -File | Select-Object -First 1).FullName
      $result.helper = $helper
      $result.helperSignature = Get-SignatureInfo $helper
      if ($exe) {
        $bytes = [IO.File]::ReadAllBytes($exe)
        $peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
        $machine = [BitConverter]::ToUInt16($bytes, $peOffset + 4)
        $result.exePeMachine = "0x{0:X4}" -f $machine
      }
    }
    $result.startMenu = @(Get-ChildItem "$env:ProgramData\Microsoft\Windows\Start Menu\Programs" -Recurse -Filter "*FyAgent*" -ErrorAction SilentlyContinue | ForEach-Object FullName)
    $result.ok = ($result.installerExitCode -eq 0) -and [bool]$result.exe
    Save-Json "install.json" $result
    $result | ConvertTo-Json -Depth 6
    if (-not $result.ok) { exit 1 }
  }

  { $_ -in @("probe", "e2e") } {
    $exe = Get-FyAgentExe
    $port = 9222
    $env:SMOKE_CDP_PORT = "$port"
    # The formal build runs elevated, and elevated WebView2 hosts ignore the
    # WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS environment variable. Use the
    # machine-wide WebView2 policy override for this exe name on the throwaway
    # VM only, and remove it again after the probe.
    $policyKey = "HKLM:\SOFTWARE\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments"
    New-Item -Path $policyKey -Force | Out-Null
    $policyNames = @((Split-Path $exe -Leaf), "com.fyagent.desktop")
    foreach ($n in $policyNames) {
      New-ItemProperty -Path $policyKey -Name $n -Value "--remote-debugging-port=$port" -PropertyType String -Force | Out-Null
    }
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port"
    $result = [ordered]@{ phase = "probe"; label = $Label; exe = $exe; startedAt = (Get-Date).ToString("o") }
    $stdout = Join-Path $Out "app-stdout-$Label.log"
    $stderr = Join-Path $Out "app-stderr-$Label.log"
    $p = Start-Process -FilePath $exe -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $result.pid = $p.Id
    Start-Sleep -Seconds 20
    $p.Refresh()
    $result.aliveAfter20s = -not $p.HasExited
    if ($p.HasExited) { $result.exitCode = $p.ExitCode }
    $result.processes = @(Get-Process | Where-Object { $_.ProcessName -match "fyagent|msedgewebview2" } |
      Select-Object ProcessName, Id, @{n = "mainWindowTitle"; e = { $_.MainWindowTitle } }, @{n = "path"; e = { $_.Path } })
    Push-Location $ScriptDir
    if ($Phase -eq "e2e") {
      # Diagnostics (hidden, 25 min): helper process trace and package-bridge
      # ancestor identity watch; optional sibling-directory churn.
      $diag = Join-Path $ScriptDir "diag-watch.ps1"
      $modes = @(@("-Mode", "procs"), @("-Mode", "bridge"), @("-Mode", "shellprobe"))
      if ($env:SMOKE_E2E_CHURN_DIR) { $modes += , @("-Mode", "churn", "-Dir", "`"$($env:SMOKE_E2E_CHURN_DIR)`"") }
      foreach ($m in $modes) {
        Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -ArgumentList (@("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$diag`"", "-Out", "`"$Out`"") + $m) | Out-Null
      }
      node (Join-Path $ScriptDir "cdp-e2e.mjs")
      $result.e2eExit = $LASTEXITCODE
    }
    node (Join-Path $ScriptDir "cdp-probe.mjs") $Label
    Pop-Location
    $result.desktopScreenshot = "desktop-$Label.png"
    $result.desktopResolution = Save-DesktopScreenshot "desktop-$Label.png"
    $p.Refresh()
    $result.aliveAfterProbe = -not $p.HasExited
    $result.mainWindowTitle = (Get-Process -Id $p.Id -ErrorAction SilentlyContinue).MainWindowTitle
    # Quit: ask the window to close, then stop the process tree.
    if (-not $p.HasExited) {
      $null = $p.CloseMainWindow()
      Start-Sleep -Seconds 5
      Get-Process | Where-Object { $_.ProcessName -match "^fyagent" } | Stop-Process -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
    $result.stillRunningAfterQuit = [bool](Get-Process | Where-Object { $_.ProcessName -match "^fyagent" })
    foreach ($n in $policyNames) { Remove-ItemProperty -Path $policyKey -Name $n -ErrorAction SilentlyContinue }
    $logDir = Join-Path $env:USERPROFILE ".fyagent\logs"
    if (Test-Path $logDir) {
      New-Item -ItemType Directory -Force (Join-Path $Out "fyagent-logs-$Label") | Out-Null
      Copy-Item "$logDir\*" (Join-Path $Out "fyagent-logs-$Label") -Recurse -ErrorAction SilentlyContinue
    }
    $result.finishedAt = (Get-Date).ToString("o")
    Save-Json "launch-$Label.json" $result
    $result | ConvertTo-Json -Depth 5
  }

  "tools" {
    $env:npm_config_loglevel = "error"
    $packages = @(
      @{ tool = "codex"; pkg = "@openai/codex"; bin = "codex" },
      @{ tool = "claude"; pkg = "@anthropic-ai/claude-code"; bin = "claude" },
      @{ tool = "gemini"; pkg = "@google/gemini-cli"; bin = "gemini" },
      @{ tool = "opencode"; pkg = "@opencode/cli"; bin = "opencode" },
      @{ tool = "grok"; pkg = "@xai-official/grok"; bin = "grok" },
      @{ tool = "openclaw"; pkg = "openclaw"; bin = "openclaw" }
    )
    $results = @()
    foreach ($item in $packages) {
      $sw = [Diagnostics.Stopwatch]::StartNew()
      $log = Join-Path $Out "npm-install-$($item.tool).log"
      cmd /c "npm install -g $($item.pkg)@latest > `"$log`" 2>&1"
      $code = $LASTEXITCODE
      $version = (cmd /c "$($item.bin) --version 2>&1" | Select-Object -First 3) -join " "
      $where = (cmd /c "where $($item.bin) 2>&1") -join "; "
      $results += [ordered]@{ tool = $item.tool; pkg = $item.pkg; npmExit = $code; seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1); versionOutput = $version; where = $where }
    }
    $npmPrefix = (cmd /c "npm prefix -g")
    Save-Json "tools-install.json" ([ordered]@{ npmPrefix = $npmPrefix; node = (node --version); results = $results })
    $results | ForEach-Object { "$($_.tool): exit=$($_.npmExit) $($_.versionOutput)" }
  }

  "opencode-desktop" {
    $locateOnly = $Label -eq "locate"
    $url = if ($env:SMOKE_OPENCODE_URL) { $env:SMOKE_OPENCODE_URL } else { "https://opencode.ai/download/stable/windows-x64-nsis" }
    $dest = Join-Path $Out "assets\opencode-desktop-setup.exe"
    New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
    $result = [ordered]@{ phase = "opencode-desktop"; mode = $(if ($locateOnly) { "locate-after-fyagent" } else { "direct-install" }); sourceUrl = $(if ($locateOnly) { $null } else { $url }) }
    if (-not $locateOnly) { try {
      $resp = Invoke-WebRequest -Uri $url -OutFile $dest -PassThru -UseBasicParsing
      $result.finalUrl = $resp.BaseResponse.RequestMessage.RequestUri.AbsoluteUri
    } catch { $result.downloadError = "$_" } }
    if ($locateOnly -or (Test-Path $dest)) {
     if (-not $locateOnly) {
      $result.installerSha256 = (Get-FileHash $dest -Algorithm SHA256).Hash.ToLower()
      $result.installerSize = (Get-Item $dest).Length
      $result.installerSignature = Get-SignatureInfo $dest
      $result.installerVersionInfo = Get-FileVersionInfoSafe $dest
      $before = @(Get-UninstallEntries "*OpenCode*")
      $sw = [Diagnostics.Stopwatch]::StartNew()
      $p = Start-Process -FilePath $dest -ArgumentList "/S" -Wait -PassThru
      $result.installerExitCode = $p.ExitCode
      $result.installSeconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
      Start-Sleep -Seconds 5
      Get-Process | Where-Object { $_.ProcessName -match "^opencode" } | Stop-Process -Force -ErrorAction SilentlyContinue
      $result.uninstallEntriesBefore = $before
     }
      $result.uninstallEntries = @(Get-UninstallEntries "*OpenCode*")
      $roots = [ordered]@{
        localAppDataPrograms = "$env:LOCALAPPDATA\Programs"
        programFiles         = "$env:ProgramFiles"
        programFilesX86      = "${env:ProgramFiles(x86)}"
        roamingAppData       = "$env:APPDATA"
      }
      $found = @()
      foreach ($k in $roots.Keys) {
        $root = $roots[$k]
        if (-not $root -or -not (Test-Path $root)) { continue }
        Get-ChildItem -Path $root -Filter "OpenCode*.exe" -Recurse -Depth 3 -File -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -notmatch "^Uninstall" } | ForEach-Object {
            $found += [ordered]@{
              root = $k; rootPath = $root; path = $_.FullName
              relative = $_.FullName.Substring($root.Length).TrimStart('\').Replace('\', '/')
              versionInfo = Get-FileVersionInfoSafe $_.FullName
              signature = Get-SignatureInfo $_.FullName
              peMachine = Get-PeMachine $_.FullName
            }
          }
      }
      $result.foundExecutables = $found
      $appPaths = @()
      foreach ($hive in @("HKCU:", "HKLM:")) {
        $key = "$hive\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\OpenCode.exe"
        if (Test-Path $key) { $appPaths += [ordered]@{ key = $key; default = (Get-ItemProperty $key).'(default)' } }
      }
      $result.appPaths = $appPaths
      # Candidates hard-coded in src-tauri/src/agent_install/desktop.rs (v0.4.9).
      $candidates = @("@opencodedesktop/OpenCode.exe", "@opencode-aidesktop/OpenCode.exe", "OpenCode/OpenCode.exe")
      $result.codeCandidates = $candidates
      $result.candidateHits = @($found | Where-Object { ($_.root -in @("localAppDataPrograms", "programFiles")) -and ($candidates -contains $_.relative) } | ForEach-Object { $_.path })
      $result.matchesCodeCandidate = $result.candidateHits.Count -gt 0
    }
    Save-Json $(if ($locateOnly) { "opencode-desktop-e2e.json" } else { "opencode-desktop.json" }) $result
    $result | ConvertTo-Json -Depth 6
  }

  default { throw "unknown phase $Phase" }
}
