<#
  install.ps1 — register the Media Catcher native helper with Firefox.

  What it does:
    1. Locates pythonw.exe and writes mc_host.bat (a windowless launcher).
    2. Writes the native-messaging manifest (com.mediacatcher.host.json).
    3. Registers it under HKCU so Firefox can find it.
    4. Ensures ffmpeg.exe is available (downloads it if missing, unless -SkipFfmpeg).

  Run from an ordinary (non-admin) PowerShell:
      powershell -ExecutionPolicy Bypass -File install.ps1
#>
param(
  [switch]$SkipFfmpeg,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$HostName   = "com.mediacatcher.host"
$ExtId      = "{27383706-fb43-40dc-9e94-d2578818bd6a}"
$HostDir    = $PSScriptRoot
$Manifest   = Join-Path $HostDir "$HostName.json"
$Bat        = Join-Path $HostDir "mc_host.bat"
$RegKey     = "HKCU:\Software\Mozilla\NativeMessagingHosts\$HostName"

if ($Uninstall) {
  if (Test-Path $RegKey) { Remove-Item $RegKey -Force }
  Write-Host "Unregistered $HostName. (Left files in $HostDir.)" -ForegroundColor Yellow
  return
}

Write-Host "Media Catcher helper installer" -ForegroundColor Cyan
Write-Host "  location: $HostDir"

# 1. Find pythonw.exe -------------------------------------------------------
$pythonw = $null
$cmd = Get-Command pythonw.exe -ErrorAction SilentlyContinue
if ($cmd) { $pythonw = $cmd.Source }
if (-not $pythonw) {
  $py = Get-Command python.exe -ErrorAction SilentlyContinue
  if ($py) {
    $cand = Join-Path (Split-Path $py.Source) "pythonw.exe"
    if (Test-Path $cand) { $pythonw = $cand }
  }
}
if (-not $pythonw) {
  # py launcher fallback
  $viaPy = & py -3 -c "import sys,os;print(os.path.join(os.path.dirname(sys.executable),'pythonw.exe'))" 2>$null
  if ($viaPy -and (Test-Path $viaPy)) { $pythonw = $viaPy }
}
if (-not $pythonw) { throw "Could not find pythonw.exe. Install Python 3 from python.org and re-run." }
Write-Host "  python:   $pythonw" -ForegroundColor Green

# 2. Launcher .bat ----------------------------------------------------------
# %~dp0 is the folder of the bat; keeps everything relative/portable.
$batBody = "@echo off`r`n`"$pythonw`" `"%~dp0mc_host.py`"`r`n"
Set-Content -Path $Bat -Value $batBody -Encoding ASCII -NoNewline
Write-Host "  launcher: $Bat" -ForegroundColor Green

# 3. Native manifest --------------------------------------------------------
$manifestObj = [ordered]@{
  name        = $HostName
  description = "Media Catcher recording helper"
  path        = $Bat
  type        = "stdio"
  allowed_extensions = @($ExtId)
}
($manifestObj | ConvertTo-Json -Depth 5) | Set-Content -Path $Manifest -Encoding UTF8
Write-Host "  manifest: $Manifest" -ForegroundColor Green

# 4. Register in HKCU -------------------------------------------------------
if (-not (Test-Path $RegKey)) { New-Item -Path $RegKey -Force | Out-Null }
Set-ItemProperty -Path $RegKey -Name "(Default)" -Value $Manifest
Write-Host "  registry: $RegKey -> manifest" -ForegroundColor Green

# 5. ffmpeg -----------------------------------------------------------------
$localFfmpeg = Join-Path $HostDir "ffmpeg.exe"
$haveFfmpeg  = (Test-Path $localFfmpeg) -or ((Get-Command ffmpeg.exe -ErrorAction SilentlyContinue) -ne $null)
if ($haveFfmpeg) {
  Write-Host "  ffmpeg:   found" -ForegroundColor Green
} elseif ($SkipFfmpeg) {
  Write-Host "  ffmpeg:   MISSING (skipped). Put ffmpeg.exe in $HostDir before recording." -ForegroundColor Yellow
} else {
  Write-Host "  ffmpeg:   downloading (gyan.dev essentials build)..." -ForegroundColor Yellow
  try {
    $zip = Join-Path $env:TEMP "ffmpeg-mc.zip"
    Invoke-WebRequest -Uri "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" -OutFile $zip
    $ex = Join-Path $env:TEMP "ffmpeg-mc"
    if (Test-Path $ex) { Remove-Item $ex -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $ex -Force
    $found = Get-ChildItem -Path $ex -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
    if ($found) { Copy-Item $found.FullName $localFfmpeg -Force; Write-Host "  ffmpeg:   installed -> $localFfmpeg" -ForegroundColor Green }
    else { throw "ffmpeg.exe not found in archive" }
    Remove-Item $zip -Force; Remove-Item $ex -Recurse -Force
  } catch {
    Write-Host "  ffmpeg:   download failed ($_). Download ffmpeg.exe manually and drop it in $HostDir." -ForegroundColor Red
  }
}

Write-Host ""
Write-Host "Done. Restart Firefox, then Media Catcher will use the helper automatically." -ForegroundColor Cyan
Write-Host "To remove: powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall"
