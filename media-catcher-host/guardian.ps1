<#
  guardian.ps1 - Media Catcher reliability guardian.

  Runs detached (spawned by mc_host.py) so it survives Firefox being restarted.
  Given a config JSON, it:
    1. BACKS UP the current extension folder, host folder, and staged XPI
       (keeping the last N snapshots),
    2. APPLIES the update (extract extension, stage XPI, refresh host files),
    3. VERIFIES it (manifest parses + version; mc_host.py compiles + VERSION;
       XPI staged),
    4. on failure, REVERTS from the backup and explains what happened,
    5. restarts Firefox (restoring the session) on success or after revert.

  Testing (headless): -NoUi auto-reverts without dialogs; -NoRestart skips the
  Firefox restart. Exit codes: 0 ok ? 1 fatal (no backup) ? 2 reverted ? 3 left
  broken by user choice.
#>
param(
  [Parameter(Mandatory = $true)][string]$Config,
  [switch]$NoUi,
  [switch]$NoRestart
)
$ErrorActionPreference = "Stop"

$cfg = Get-Content -Raw -LiteralPath $Config | ConvertFrom-Json
$backupRoot = $cfg.backupRoot
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
$logFile = Join-Path $backupRoot "guardian.log"
$stamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
$bdir = Join-Path $backupRoot $stamp

function Log($m) {
  ("{0}  {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $m) | Out-File -FilePath $logFile -Append -Encoding utf8
}

function Copy-Tree($src, $dst) {
  if (-not (Test-Path -LiteralPath $src)) { return }
  New-Item -ItemType Directory -Force -Path $dst | Out-Null
  Copy-Item -Path (Join-Path $src "*") -Destination $dst -Recurse -Force -ErrorAction SilentlyContinue
}

function Dialog-YesNo($title, $msg) {
  Add-Type -AssemblyName System.Windows.Forms
  ([System.Windows.Forms.MessageBox]::Show($msg, $title, "YesNo", "Warning")) -eq [System.Windows.Forms.DialogResult]::Yes
}
function Dialog-Info($title, $msg) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show($msg, $title, "OK", "Information") | Out-Null
}

function Xpi-Path {
  if (-not $cfg.profileDir) { return $null }
  Join-Path (Join-Path $cfg.profileDir "extensions") ($cfg.extId + ".xpi")
}

function Do-Backup {
  New-Item -ItemType Directory -Force -Path $bdir | Out-Null
  $state = @{ stamp = $stamp; ext = $false; host = $false; xpi = $false;
              extDir = $cfg.extDir; hostDir = $cfg.hostDir; xpiPath = (Xpi-Path) }
  if ($cfg.applyExt) {
    Copy-Tree $cfg.extDir (Join-Path $bdir "ext"); $state.ext = $true
    $xpi = Xpi-Path
    if ($xpi -and (Test-Path -LiteralPath $xpi)) {
      Copy-Item -LiteralPath $xpi -Destination (Join-Path $bdir "staged.xpi") -Force; $state.xpi = $true
    }
  }
  if ($cfg.applyHost) { Copy-Tree $cfg.hostDir (Join-Path $bdir "host"); $state.host = $true }
  ($state | ConvertTo-Json) | Out-File -FilePath (Join-Path $bdir "state.json") -Encoding utf8
}

function Prune-Backups {
  Get-ChildItem -Directory $backupRoot | Sort-Object Name -Descending |
    Select-Object -Skip ([int]$cfg.keep) |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
}

function Apply-Update {
  if ($cfg.applyExt) {
    Expand-Archive -LiteralPath $cfg.extZip -DestinationPath $cfg.extDir -Force
    $xpi = Xpi-Path
    if ($xpi) {
      New-Item -ItemType Directory -Force -Path (Split-Path $xpi) | Out-Null
      Copy-Item -LiteralPath $cfg.extZip -Destination $xpi -Force
    }
  }
  if ($cfg.applyHost) {
    $tmp = Join-Path $env:TEMP ("mc-host-" + $stamp)
    Expand-Archive -LiteralPath $cfg.hostZip -DestinationPath $tmp -Force
    Get-ChildItem -Recurse -File $tmp | ForEach-Object {
      Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $cfg.hostDir $_.Name) -Force
    }
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Verify-Update {
  $errs = @()
  if ($cfg.applyExt) {
    $mf = Join-Path $cfg.extDir "manifest.json"
    if (-not (Test-Path -LiteralPath $mf)) { $errs += "extension manifest.json is missing" }
    else {
      $m = $null
      try { $m = Get-Content -Raw -LiteralPath $mf | ConvertFrom-Json } catch { $errs += "manifest.json is not valid JSON" }
      if ($m -and -not $m.version) { $errs += "manifest.json has no version" }
      if ($m -and $cfg.expectExtVersion -and $m.version -ne $cfg.expectExtVersion) {
        $errs += ("extension version {0} != expected {1}" -f $m.version, $cfg.expectExtVersion)
      }
    }
    $xpi = Xpi-Path
    if ($xpi -and -not (Test-Path -LiteralPath $xpi)) { $errs += "staged XPI is missing" }
  }
  if ($cfg.applyHost) {
    $mh = Join-Path $cfg.hostDir "mc_host.py"
    if (-not (Test-Path -LiteralPath $mh)) { $errs += "mc_host.py is missing" }
    else {
      if ($cfg.python) {
        # Native stderr under ErrorActionPreference=Stop would terminate Verify,
        # so merge stderr and judge purely by the exit code, inside try/catch.
        $compileOk = $true
        try {
          $null = & $cfg.python -m py_compile $mh 2>&1
          if ($LASTEXITCODE -ne 0) { $compileOk = $false }
        } catch { $compileOk = $false }
        if (-not $compileOk) { $errs += "mc_host.py failed to compile" }
      }
      $txt = Get-Content -Raw -LiteralPath $mh
      $vm = [regex]::Match($txt, 'VERSION\s*=\s*["'']([\d.]+)["'']')
      if (-not $vm.Success) { $errs += "mc_host.py has no VERSION" }
      elseif ($cfg.expectHostVersion -and $vm.Groups[1].Value -ne $cfg.expectHostVersion) {
        $errs += ("host version {0} != expected {1}" -f $vm.Groups[1].Value, $cfg.expectHostVersion)
      }
    }
  }
  return $errs
}

function Revert-Update {
  $st = Get-Content -Raw -LiteralPath (Join-Path $bdir "state.json") | ConvertFrom-Json
  if ($st.ext) { Copy-Item -Path (Join-Path (Join-Path $bdir "ext") "*") -Destination $st.extDir -Recurse -Force -ErrorAction SilentlyContinue }
  if ($st.host) { Copy-Item -Path (Join-Path (Join-Path $bdir "host") "*") -Destination $st.hostDir -Recurse -Force -ErrorAction SilentlyContinue }
  if ($st.xpiPath) {
    if ($st.xpi) { Copy-Item -LiteralPath (Join-Path $bdir "staged.xpi") -Destination $st.xpiPath -Force -ErrorAction SilentlyContinue }
    else { Remove-Item -LiteralPath $st.xpiPath -Force -ErrorAction SilentlyContinue }  # no prior XPI - remove the bad one
  }
}

function Restart-Firefox {
  if (-not $cfg.firefox -or $NoRestart) { return }
  Start-Sleep -Milliseconds 800
  & taskkill /IM firefox.exe *>$null            # graceful close (session saved)
  for ($i = 0; $i -lt 80; $i++) {
    if (-not (Get-Process -Name firefox -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
  }
  Start-Sleep -Seconds 1
  Start-Process -FilePath $cfg.firefox
}

# ---- main ----
Log ("start: applyExt={0} applyHost={1} extZip={2} hostZip={3}" -f $cfg.applyExt, $cfg.applyHost, $cfg.extZip, $cfg.hostZip)
try {
  Do-Backup
  Prune-Backups
} catch {
  Log ("FATAL: backup failed, aborting without applying: {0}" -f $_)
  if (-not $NoUi) { Dialog-Info "Media Catcher - update aborted" "Couldn't back up the current version, so the update was NOT applied.`n`n$_" }
  exit 1
}

$applyErr = $null
try { Apply-Update } catch { $applyErr = "$_"; Log ("apply error: {0}" -f $_) }
$errs = @(Verify-Update)

if ($errs.Count -eq 0 -and -not $applyErr) {
  Log "verify OK - update applied"
  Restart-Firefox
  exit 0
}

$reason = ($errs -join "; ")
if ($applyErr) { $reason = "apply failed: $applyErr" + $(if ($reason) { "; $reason" } else { "" }) }
Log ("verify FAILED: {0}" -f $reason)

$doRevert = $true
if (-not $NoUi) {
  $doRevert = Dialog-YesNo "Media Catcher - update failed" `
    "The Media Catcher update did not verify:`n`n$reason`n`nRevert to the previous working version?"
}
if ($doRevert) {
  try { Revert-Update; Log "reverted to previous version" } catch { Log ("revert error: {0}" -f $_) }
  if (-not $NoUi) { Dialog-Info "Media Catcher" "Reverted to the previous working version." }
  Restart-Firefox
  exit 2
} else {
  Log "left in updated (failing) state by user choice"
  exit 3
}
