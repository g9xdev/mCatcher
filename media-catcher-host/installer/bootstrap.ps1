<#
  bootstrap.ps1 - the brains of the Media Catcher host installer.

  Ensures the host's dependencies are present and registers it with Firefox:
    1. Python 3 (installs it with winget if missing).
    2. ffmpeg.exe (downloads a static build if missing).
    3. Copies the host files into the install directory (unless already there).
    4. Writes a windowless launcher (mc_host.bat).
    5. Writes the native-messaging manifest and registers it under HKCU.
    6. Verifies the result.

  It runs two ways: standalone (double-clicked via Install bat, source = repo),
  or as the post-install step of the packaged setup.exe (source = install dir).
  Per-user; no administrator rights required.

  ASCII only on purpose: Windows PowerShell 5.1 reads a -File script as ANSI, so
  non-ASCII characters would corrupt it.
#>
[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "MediaCatcher\Host"),
  [string]$SourceDir  = "",                                   # where the host files live; default = parent of this script
  [string]$RegRoot    = "HKCU:\Software\Mozilla\NativeMessagingHosts",  # overridable for tests
  [switch]$SkipPython,
  [switch]$SkipFfmpeg,
  [switch]$SkipYtdlp,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$HostName = "com.mediacatcher.host"
$ExtId    = "{27383706-fb43-40dc-9e94-d2578818bd6a}"
$RegKey   = Join-Path $RegRoot $HostName
$Manifest = Join-Path $InstallDir "$HostName.json"
$Bat      = Join-Path $InstallDir "mc_host.bat"

function Say($m, $c = "Gray") { Write-Host $m -ForegroundColor $c }
function Step($m) { Write-Host ("  " + $m) -ForegroundColor Green }
function Warn($m) { Write-Host ("  " + $m) -ForegroundColor Yellow }

# ---------- uninstall ----------
if ($Uninstall) {
  Say "Removing Media Catcher host..." "Cyan"
  if (Test-Path $RegKey) { Remove-Item $RegKey -Force; Step "unregistered $HostName" }
  if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force; Step "removed $InstallDir" }
  Say "Done. Restart Firefox to finish removal." "Cyan"
  return
}

if (-not $SourceDir) { $SourceDir = Split-Path -Parent $PSScriptRoot }   # installer/ -> repo root
Say "Media Catcher host installer" "Cyan"
Say ("  install dir: " + $InstallDir)
Say ("  source dir:  " + $SourceDir)

# ---------- 1. Python ----------
function Find-Pythonw {
  $c = Get-Command pythonw.exe -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  $py = Get-Command python.exe -ErrorAction SilentlyContinue
  if ($py) { $p = Join-Path (Split-Path $py.Source) "pythonw.exe"; if (Test-Path $p) { return $p } }
  try { $viaPy = & py -3 -c "import sys,os;print(os.path.join(os.path.dirname(sys.executable),'pythonw.exe'))" 2>$null
        if ($viaPy -and (Test-Path $viaPy)) { return $viaPy } } catch {}
  # known winget / installer locations (PATH is stale in the current shell right after an install)
  foreach ($ver in @("Python314","Python313","Python312","Python311")) {
    foreach ($base in @("$env:LOCALAPPDATA\Programs\Python", "$env:ProgramFiles", "${env:ProgramFiles(x86)}")) {
      $p = Join-Path (Join-Path $base $ver) "pythonw.exe"; if (Test-Path $p) { return $p }
    }
  }
  return $null
}

$pythonw = Find-Pythonw
if (-not $pythonw -and -not $SkipPython) {
  Warn "Python not found - installing Python 3.12 with winget (this can take a minute)..."
  try {
    & winget install -e --id Python.Python.3.12 --scope user --silent --accept-package-agreements --accept-source-agreements | Out-Null
  } catch { Warn ("winget install failed: " + $_) }
  $pythonw = Find-Pythonw
  if (-not $pythonw) {
    Warn "winget did not expose Python - downloading the official installer..."
    try {
      $pyExe = Join-Path $env:TEMP "python-mc-setup.exe"
      Invoke-WebRequest -Uri "https://www.python.org/ftp/python/3.12.7/python-3.12.7-amd64.exe" -OutFile $pyExe
      & $pyExe /quiet InstallAllUsers=0 PrependPath=1 Include_launcher=1 | Out-Null
      Start-Sleep -Seconds 3
      $pythonw = Find-Pythonw
      Remove-Item $pyExe -Force -ErrorAction SilentlyContinue
    } catch { Warn ("python.org install failed: " + $_) }
  }
}
if (-not $pythonw) { throw "Could not find or install Python 3. Install it from python.org and re-run." }
Step ("python: " + $pythonw)

# ---------- 2. copy host files ----------
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$srcResolved = (Resolve-Path $SourceDir).Path
$dstResolved = (Resolve-Path $InstallDir).Path
if ($srcResolved -ne $dstResolved) {
  foreach ($f in @("mc_host.py", "guardian.ps1", "README.md")) {
    $s = Join-Path $SourceDir $f
    if (Test-Path $s) { Copy-Item $s (Join-Path $InstallDir $f) -Force }
  }
  # seed an empty config only if one is not already installed (preserve user settings)
  $cfg = Join-Path $InstallDir "mc_config.json"
  if (-not (Test-Path $cfg)) { Set-Content -Path $cfg -Value "{}" -Encoding UTF8 }
  Step "copied host files"
} else {
  Step "host files already in place"
}
# install a copy of this script so the uninstaller lives next to what it removes
try { Copy-Item $PSCommandPath (Join-Path $InstallDir "bootstrap.ps1") -Force -ErrorAction Stop } catch { }

# ---------- 3. ffmpeg ----------
$localFfmpeg = Join-Path $InstallDir "ffmpeg.exe"
if (Test-Path $localFfmpeg) {
  Step "ffmpeg: present"
} elseif ((Get-Command ffmpeg.exe -ErrorAction SilentlyContinue)) {
  Copy-Item (Get-Command ffmpeg.exe).Source $localFfmpeg -Force
  Step "ffmpeg: copied from PATH"
} elseif ($SkipFfmpeg) {
  Warn "ffmpeg: skipped - recording will not work until ffmpeg.exe is in $InstallDir"
} else {
  Warn "ffmpeg: downloading a static build (gyan.dev essentials)..."
  try {
    $zip = Join-Path $env:TEMP "ffmpeg-mc.zip"
    Invoke-WebRequest -Uri "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" -OutFile $zip
    $ex = Join-Path $env:TEMP "ffmpeg-mc"
    if (Test-Path $ex) { Remove-Item $ex -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $ex -Force
    foreach ($tool in @("ffmpeg.exe", "ffprobe.exe")) {
      $hit = Get-ChildItem -Path $ex -Recurse -Filter $tool | Select-Object -First 1
      if ($hit) { Copy-Item $hit.FullName (Join-Path $InstallDir $tool) -Force }
    }
    Remove-Item $zip -Force; Remove-Item $ex -Recurse -Force
    if (Test-Path $localFfmpeg) { Step "ffmpeg: installed" } else { throw "ffmpeg.exe missing from archive" }
  } catch { Warn ("ffmpeg: download failed (" + $_ + "). Put ffmpeg.exe in " + $InstallDir + " to enable recording.") }
}

# ---------- 3b. yt-dlp (YouTube + many other sites) ----------
# One self-contained binary. It self-updates (yt-dlp -U, triggered by the host) because
# YouTube breaks it often. YouTube Premium cookies unlock 4K without a PO-token provider,
# so no Node runtime is bundled.
$localYtdlp = Join-Path $InstallDir "yt-dlp.exe"
if (Test-Path $localYtdlp) {
  Step "yt-dlp: present (self-updates)"
} elseif ($SkipYtdlp) {
  Warn "yt-dlp: skipped - YouTube downloads will be unavailable"
} else {
  Warn "yt-dlp: downloading the latest release..."
  try {
    Invoke-WebRequest -Uri "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" -OutFile $localYtdlp
    if (Test-Path $localYtdlp) { Step "yt-dlp: installed" } else { throw "yt-dlp.exe not written" }
  } catch { Warn ("yt-dlp: download failed (" + $_ + "). Put yt-dlp.exe in " + $InstallDir + " to enable YouTube.") }
}

# ---------- 4. launcher ----------
$batBody = "@echo off`r`n`"$pythonw`" `"%~dp0mc_host.py`"`r`n"
Set-Content -Path $Bat -Value $batBody -Encoding ASCII -NoNewline
Step ("launcher: " + $Bat)

# ---------- 5. native manifest + registry ----------
$manifestObj = [ordered]@{
  name = $HostName; description = "Media Catcher recording helper"
  path = $Bat; type = "stdio"; allowed_extensions = @($ExtId)
}
($manifestObj | ConvertTo-Json -Depth 5) | Set-Content -Path $Manifest -Encoding UTF8
if (-not (Test-Path $RegKey)) { New-Item -Path $RegKey -Force | Out-Null }
Set-ItemProperty -Path $RegKey -Name "(Default)" -Value $Manifest
Step ("registered: " + $RegKey)

# ---------- 6. verify ----------
# Use the console python.exe (not the windowless pythonw) so the exit code is reliable.
$ok = $true
$pythonExe = $pythonw -replace 'pythonw\.exe$', 'python.exe'
if (-not (Test-Path $pythonExe)) { $pythonExe = $pythonw }
try { $null = & $pythonExe -m py_compile (Join-Path $InstallDir "mc_host.py") 2>&1; if ($LASTEXITCODE -ne 0) { $ok = $false } } catch { $ok = $false }
if (-not (Test-Path $Manifest)) { $ok = $false }
$regVal = (Get-ItemProperty -Path $RegKey -Name "(Default)" -ErrorAction SilentlyContinue)."(Default)"
if ($regVal -ne $Manifest) { $ok = $false }
Write-Host ""
if ($ok) { Say "Verified. Restart Firefox and Media Catcher will use the helper automatically." "Cyan" }
else     { Say "Installed, but verification found a problem - check the messages above." "Red" }
Say ("To uninstall: powershell -ExecutionPolicy Bypass -File `"" + (Join-Path $InstallDir 'bootstrap.ps1') + "`" -Uninstall")
if (-not $ok) { exit 1 }
