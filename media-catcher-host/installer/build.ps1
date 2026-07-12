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
