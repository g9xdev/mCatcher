<#
  build.ps1 - compile the Media Catcher host setup.exe with Inno Setup.

  Installs Inno Setup with winget if the compiler (ISCC.exe) is not found, then
  compiles media-catcher-host.iss into dist\MediaCatcherHostSetup.exe.

      powershell -ExecutionPolicy Bypass -File build.ps1
#>
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

function Find-ISCC {
  $c = Get-Command ISCC.exe -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($p in @(
      "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
      "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
      "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe")) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

$iscc = Find-ISCC
if (-not $iscc) {
  Write-Host "Inno Setup not found - installing it with winget..." -ForegroundColor Yellow
  & winget install -e --id JRSoftware.InnoSetup --silent --accept-package-agreements --accept-source-agreements | Out-Null
  $iscc = Find-ISCC
}
if (-not $iscc) { throw "Could not find or install Inno Setup (ISCC.exe). Install it from https://jrsoftware.org/isdl.php and re-run." }
Write-Host ("Compiler: " + $iscc) -ForegroundColor Green

& $iscc "media-catcher-host.iss"
if ($LASTEXITCODE -ne 0) { throw "Inno Setup compile failed (exit $LASTEXITCODE)." }

$out = Join-Path $here "dist\MediaCatcherHostSetup.exe"
if (Test-Path $out) {
  $mb = "{0:N1}" -f ((Get-Item $out).Length / 1MB)
  Write-Host ("Built: " + $out + " (" + $mb + " MB)") -ForegroundColor Cyan
} else {
  throw "Compile reported success but $out is missing."
}

# Optional code signing. Unsigned by default: no certificate belongs in this repo.
# Set MC_SIGN_PFX (path) and MC_SIGN_PASS to produce a signed setup.exe.
if ($env:MC_SIGN_PFX) {
  if (-not (Test-Path $env:MC_SIGN_PFX)) { throw "MC_SIGN_PFX is set but $($env:MC_SIGN_PFX) does not exist." }
  $signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if (-not $signtool) { throw "MC_SIGN_PFX is set but signtool.exe is not on PATH (install the Windows SDK)." }
  & $signtool.Source sign /fd SHA256 /f $env:MC_SIGN_PFX /p $env:MC_SIGN_PASS `
      /tr http://timestamp.digicert.com /td SHA256 $out
  if ($LASTEXITCODE -ne 0) { throw "signtool failed (exit $LASTEXITCODE)." }
  Write-Host "Signed: $out" -ForegroundColor Green
} else {
  Write-Host "Unsigned build (set MC_SIGN_PFX to sign)." -ForegroundColor Yellow
}
