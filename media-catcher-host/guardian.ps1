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

function Assert-NoReparsePath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) {
    throw "host update path is empty"
  }
  $full = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetPathRoot($full)
  if ([string]::IsNullOrWhiteSpace($root)) {
    throw "host update path must be absolute"
  }
  $current = $root
  $relative = $full.Substring($root.Length)
  foreach ($part in ($relative -split '[\\/]')) {
    if (-not $part) { continue }
    $current = [IO.Path]::Combine($current, $part)
    try {
      $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
    } catch [System.Management.Automation.ItemNotFoundException] {
      break
    }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "host update path contains a reparse point"
    }
  }
}

$cfg = Get-Content -Raw -LiteralPath $Config | ConvertFrom-Json
if ($cfg.applyHost) {
  # Validate before backup/log directory creation or payload access. Checking
  # the complete string alone follows a junction in an ancestor of hostDir.
  Assert-NoReparsePath $cfg.hostDir
}
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

# Handle-authority helpers for host destination containment (no pathname write fallback).
$script:HostSafeTypeReady = $false
function Ensure-HostSafeType {
  if ($script:HostSafeTypeReady) { return }
  $zipAsm = [System.Reflection.Assembly]::LoadWithPartialName('System.IO.Compression').Location
  $zipFsAsm = [System.Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem').Location
  Add-Type -ReferencedAssemblies @($zipAsm, $zipFsAsm) -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
using System.IO.Compression;

public static class McHostSafe {
  const uint GENERIC_READ = 0x80000000;
  const uint GENERIC_WRITE = 0x40000000;
  const uint FILE_SHARE_READ = 0x1;
  const uint FILE_SHARE_WRITE = 0x2;
  const uint OPEN_EXISTING = 3;
  const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
  const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
  const uint FILE_ATTRIBUTE_DIRECTORY = 0x10;
  const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
  const int FileStandardInfo = 1; // FILE_INFO_BY_HANDLE_CLASS
  const int FileAttributeTagInfo = 9;
  const uint FILE_OPEN = 1;
  const uint FILE_CREATE = 2;
  const uint FILE_OPEN_IF = 3;
  const uint FILE_DIRECTORY_FILE = 0x1;
  const uint FILE_NON_DIRECTORY_FILE = 0x40;
  const uint FILE_OPEN_REPARSE_POINT = 0x00200000;
  const uint FILE_SYNCHRONOUS_IO_NONALERT = 0x20;
  const uint FILE_OPEN_FOR_BACKUP_INTENT = 0x4000;
  const uint OBJ_CASE_INSENSITIVE = 0x40;
  const uint SYNCHRONIZE = 0x100000;
  const uint FILE_READ_ATTRIBUTES = 0x80;
  const uint FILE_WRITE_DATA = 0x2;
  const uint FILE_READ_DATA = 0x1;
  const uint FILE_APPEND_DATA = 0x4;
  const int STATUS_OBJECT_NAME_NOT_FOUND = unchecked((int)0xC0000034);
  const int STATUS_OBJECT_PATH_NOT_FOUND = unchecked((int)0xC000003A);

  [StructLayout(LayoutKind.Sequential)]
  struct FILE_ATTRIBUTE_TAG_INFO {
    public uint FileAttributes;
    public uint ReparseTag;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct FILE_STANDARD_INFO {
    public long AllocationSize;
    public long EndOfFile;
    public uint NumberOfLinks;
    public byte DeletePending;
    public byte Directory;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IO_STATUS_BLOCK {
    public int Status;
    public IntPtr Information;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct UNICODE_STRING {
    public ushort Length;
    public ushort MaximumLength;
    public IntPtr Buffer;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct OBJECT_ATTRIBUTES {
    public int Length;
    public IntPtr RootDirectory;
    public IntPtr ObjectName;
    public uint Attributes;
    public IntPtr SecurityDescriptor;
    public IntPtr SecurityQualityOfService;
  }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode,
    IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr hObject);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandleEx(IntPtr hFile, int FileInformationClass, IntPtr lpFileInformation, uint dwBufferSize);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool WriteFile(IntPtr hFile, byte[] lpBuffer, uint nNumberOfBytesToWrite, out uint lpNumberOfBytesWritten, IntPtr lpOverlapped);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetEndOfFile(IntPtr hFile);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetFilePointerEx(IntPtr hFile, long liDistanceToMove, IntPtr lpNewFilePointer, uint dwMoveMethod);
  [DllImport("ntdll.dll")]
  static extern int NtCreateFile(out IntPtr FileHandle, uint DesiredAccess, ref OBJECT_ATTRIBUTES ObjectAttributes,
    ref IO_STATUS_BLOCK IoStatusBlock, IntPtr AllocationSize, uint FileAttributes, uint ShareAccess,
    uint CreateDisposition, uint CreateOptions, IntPtr EaBuffer, uint EaLength);

  static readonly HashSet<string> DosDevices = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
    "CON","PRN","AUX","NUL",
    "COM1","COM2","COM3","COM4","COM5","COM6","COM7","COM8","COM9",
    "LPT1","LPT2","LPT3","LPT4","LPT5","LPT6","LPT7","LPT8","LPT9"
  };

  static string Win32Key(string part) {
    var s = part.ToLowerInvariant();
    while (s.EndsWith(".") || s.EndsWith(" ")) s = s.Substring(0, s.Length - 1);
    return s;
  }

  public static string[] ValidateMember(string name) {
    if (string.IsNullOrEmpty(name)) throw new InvalidOperationException("empty member");
    foreach (var ch in name) {
      int o = (int)ch;
      if (o < 0x20 || o == 0x7F || (o >= 0x80 && o <= 0x9F))
        throw new InvalidOperationException("control character in member");
    }
    bool isDir = name.EndsWith("/") || name.EndsWith("\\");
    string core = isDir ? name.Substring(0, name.Length - 1) : name;
    if (core.Length == 0) throw new InvalidOperationException("empty member");
    if (core[0] == '/' || core[0] == '\\') throw new InvalidOperationException("absolute member");
    if (core.Length >= 2 && core[1] == ':') throw new InvalidOperationException("drive member");
    if (core.IndexOf(':') >= 0) throw new InvalidOperationException("colon/ADS member");
    string unified = core.Replace('\\', '/');
    var parts = unified.Split('/');
    foreach (var p in parts) {
      if (p.Length == 0) throw new InvalidOperationException("empty component");
      if (p == "." || p == "..") throw new InvalidOperationException("dot component");
      if (p.IndexOf(':') >= 0) throw new InvalidOperationException("colon component");
      if (p.EndsWith(".") || p.EndsWith(" ")) throw new InvalidOperationException("trailing dot/space");
      foreach (var ch in p) {
        int o = (int)ch;
        if (o < 0x20 || o == 0x7F || (o >= 0x80 && o <= 0x9F))
          throw new InvalidOperationException("control in component");
      }
      string stem = p.Split('.')[0];
      if (DosDevices.Contains(stem)) throw new InvalidOperationException("DOS device member");
    }
    if (isDir) return null;
    return parts;
  }

  static void ValidateHandle(IntPtr h, bool expectDir, bool finalFile) {
    int size = Marshal.SizeOf(typeof(FILE_ATTRIBUTE_TAG_INFO));
    IntPtr buf = Marshal.AllocHGlobal(size);
    try {
      if (!GetFileInformationByHandleEx(h, FileAttributeTagInfo, buf, (uint)size))
        throw new InvalidOperationException("FileAttributeTagInfo failed");
      var tag = (FILE_ATTRIBUTE_TAG_INFO)Marshal.PtrToStructure(buf, typeof(FILE_ATTRIBUTE_TAG_INFO));
      if ((tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
        throw new InvalidOperationException("reparse point in destination");
      bool isDir = (tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
      if (expectDir && !isDir) throw new InvalidOperationException("not a directory");
      if (!expectDir && isDir) throw new InvalidOperationException("final is directory");
    } finally { Marshal.FreeHGlobal(buf); }
    size = Marshal.SizeOf(typeof(FILE_STANDARD_INFO));
    buf = Marshal.AllocHGlobal(size);
    try {
      if (!GetFileInformationByHandleEx(h, FileStandardInfo, buf, (uint)size))
        throw new InvalidOperationException("FileStandardInfo failed");
      var std = (FILE_STANDARD_INFO)Marshal.PtrToStructure(buf, typeof(FILE_STANDARD_INFO));
      if (std.DeletePending != 0) throw new InvalidOperationException("delete-pending");
      if (finalFile && std.NumberOfLinks != 1)
        throw new InvalidOperationException("hard-link alias");
    } finally { Marshal.FreeHGlobal(buf); }
  }

  static IntPtr OpenRoot(string hostDir) {
    string path = Path.GetFullPath(hostDir);
    IntPtr h = CreateFileW(path, GENERIC_READ | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);
    if (h == IntPtr.Zero || h == new IntPtr(-1))
      throw new InvalidOperationException("CreateFileW hostDir failed");
    try { ValidateHandle(h, true, false); }
    catch { CloseHandle(h); throw; }
    return h;
  }

  static IntPtr NtOpenRel(IntPtr root, string name, bool directory, uint disposition, bool write) {
    IntPtr nameBuf = Marshal.StringToHGlobalUni(name);
    try {
      var us = new UNICODE_STRING();
      us.Length = (ushort)(name.Length * 2);
      us.MaximumLength = (ushort)((name.Length + 1) * 2);
      us.Buffer = nameBuf;
      IntPtr usPtr = Marshal.AllocHGlobal(Marshal.SizeOf(us));
      try {
        Marshal.StructureToPtr(us, usPtr, false);
        var oa = new OBJECT_ATTRIBUTES();
        oa.Length = Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES));
        oa.RootDirectory = root;
        oa.ObjectName = usPtr;
        oa.Attributes = OBJ_CASE_INSENSITIVE;
        var iosb = new IO_STATUS_BLOCK();
        uint access = FILE_READ_ATTRIBUTES | SYNCHRONIZE | GENERIC_READ;
        if (write) access = FILE_READ_ATTRIBUTES | SYNCHRONIZE | GENERIC_WRITE | FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_READ_DATA;
        if (directory) access |= FILE_READ_DATA;
        uint options = FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_FOR_BACKUP_INTENT;
        options |= directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE;
        IntPtr handle;
        int st = NtCreateFile(out handle, access, ref oa, ref iosb, IntPtr.Zero,
          directory ? FILE_ATTRIBUTE_DIRECTORY : 0, FILE_SHARE_READ | FILE_SHARE_WRITE,
          disposition, options, IntPtr.Zero, 0);
        if (st == STATUS_OBJECT_NAME_NOT_FOUND || st == STATUS_OBJECT_PATH_NOT_FOUND) return IntPtr.Zero;
        if (st < 0) throw new InvalidOperationException(string.Format("NtCreateFile 0x{0:X8} for {1}", st, name));
        return handle;
      } finally { Marshal.FreeHGlobal(usPtr); }
    } finally { Marshal.FreeHGlobal(nameBuf); }
  }

  static void PreflightChain(IntPtr root, string[] parts) {
    IntPtr cur = root;
    var owned = new List<IntPtr>();
    try {
      for (int i = 0; i < parts.Length; i++) {
        bool isFinal = (i == parts.Length - 1);
        IntPtr h = NtOpenRel(cur, parts[i], !isFinal, FILE_OPEN, false);
        if (h == IntPtr.Zero) return;
        owned.Add(h);
        ValidateHandle(h, !isFinal, isFinal);
        cur = h;
      }
    } finally {
      foreach (var h in owned) CloseHandle(h);
    }
  }

  static void WriteChain(IntPtr root, string[] parts, byte[] data) {
    IntPtr cur = root;
    var owned = new List<IntPtr>();
    IntPtr fileH = IntPtr.Zero;
    try {
      for (int i = 0; i < parts.Length - 1; i++) {
        IntPtr h = NtOpenRel(cur, parts[i], true, FILE_OPEN_IF, false);
        if (h == IntPtr.Zero) throw new InvalidOperationException("dir create failed: " + parts[i]);
        owned.Add(h);
        ValidateHandle(h, true, false);
        cur = h;
      }
      string finalName = parts[parts.Length - 1];
      IntPtr existing = NtOpenRel(cur, finalName, false, FILE_OPEN, false);
      if (existing != IntPtr.Zero) {
        try { ValidateHandle(existing, false, true); }
        finally { CloseHandle(existing); }
        fileH = NtOpenRel(cur, finalName, false, FILE_OPEN, true);
        if (fileH == IntPtr.Zero) throw new InvalidOperationException("reopen write failed");
      } else {
        fileH = NtOpenRel(cur, finalName, false, FILE_CREATE, true);
        if (fileH == IntPtr.Zero) throw new InvalidOperationException("create failed");
      }
      ValidateHandle(fileH, false, true);
      if (!SetFilePointerEx(fileH, 0, IntPtr.Zero, 0)) throw new InvalidOperationException("seek failed");
      if (!SetEndOfFile(fileH)) throw new InvalidOperationException("truncate failed");
      if (data != null && data.Length > 0) {
        uint written;
        if (!WriteFile(fileH, data, (uint)data.Length, out written, IntPtr.Zero) || written != data.Length)
          throw new InvalidOperationException("WriteFile failed");
      }
    } finally {
      if (fileH != IntPtr.Zero) CloseHandle(fileH);
      foreach (var h in owned) CloseHandle(h);
    }
  }

  public static void PreflightHost(string hostDir, string zipPath) {
    var seen = new Dictionary<string, string>(StringComparer.Ordinal);
    using (var fs = File.OpenRead(zipPath))
    using (var zip = new ZipArchive(fs, ZipArchiveMode.Read)) {
      var members = new List<string[]>();
      foreach (var e in zip.Entries) {
        var parts = ValidateMember(e.FullName);
        if (parts == null) continue;
        var key = string.Join("\\", Array.ConvertAll(parts, Win32Key));
        if (seen.ContainsKey(key))
          throw new InvalidOperationException("duplicate destination");
        seen[key] = e.FullName;
        members.Add(parts);
      }
      IntPtr root = OpenRoot(hostDir);
      try {
        foreach (var parts in members) PreflightChain(root, parts);
      } finally { CloseHandle(root); }
    }
  }

  public static void ApplyHostZip(string hostDir, string zipPath) {
    var seen = new Dictionary<string, string>(StringComparer.Ordinal);
    using (var fs = File.OpenRead(zipPath))
    using (var zip = new ZipArchive(fs, ZipArchiveMode.Read)) {
      var items = new List<KeyValuePair<string[], ZipArchiveEntry>>();
      foreach (var e in zip.Entries) {
        var parts = ValidateMember(e.FullName);
        if (parts == null) continue;
        var key = string.Join("\\", Array.ConvertAll(parts, Win32Key));
        if (seen.ContainsKey(key))
          throw new InvalidOperationException("duplicate destination");
        seen[key] = e.FullName;
        items.Add(new KeyValuePair<string[], ZipArchiveEntry>(parts, e));
      }
      IntPtr root = OpenRoot(hostDir);
      try {
        foreach (var it in items) PreflightChain(root, it.Key);
        foreach (var it in items) {
          byte[] data;
          using (var s = it.Value.Open())
          using (var ms = new MemoryStream()) {
            s.CopyTo(ms);
            data = ms.ToArray();
          }
          WriteChain(root, it.Key, data);
        }
      } finally { CloseHandle(root); }
    }
  }
}
'@ -ErrorAction Stop
  $script:HostSafeTypeReady = $true
}

function Assert-HostDestinationSafe {
  param([string]$HostDir, [string]$HostZip)
  Ensure-HostSafeType
  [McHostSafe]::PreflightHost($HostDir, $HostZip)
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
    Ensure-HostSafeType
    [McHostSafe]::ApplyHostZip([string]$cfg.hostDir, [string]$cfg.hostZip)
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
    $pkgInit = Join-Path $cfg.hostDir "mchost\__init__.py"
    if (-not (Test-Path -LiteralPath $pkgInit)) { $errs += "mchost/__init__.py is missing" }
    if (-not (Test-Path -LiteralPath $mh)) { $errs += "mc_host.py is missing" }
    else {
      if ($cfg.python) {
        # Use a CONSOLE python: pythonw.exe leaves $LASTEXITCODE unset, which read as a
        # compile failure and reverted EVERY host update. Prefer python.exe next to it.
        $py = $cfg.python
        if ($py -match 'pythonw\.exe$') {
          $c = ($py -replace 'pythonw\.exe$', 'python.exe')
          if (Test-Path -LiteralPath $c) { $py = $c }
        }
        # Native stderr under ErrorActionPreference=Stop would terminate Verify,
        # so merge stderr and judge purely by the exit code, inside try/catch.
        $compileOk = $true
        try {
          $global:LASTEXITCODE = 0
          $null = & $py -m py_compile $mh 2>&1
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

function Ff-Mine { Get-CimInstance Win32_Process -Filter "Name='firefox.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -eq $cfg.firefox } }

function Log-Landscape {
  # Transparency for multi-instance setups: which Firefox variants are running,
  # and which profiles carry the Media Catcher extension. We only ever touch our
  # own variant ($cfg.firefox); the rest is logged so nothing hides as a surprise.
  $ffs = @(Get-CimInstance Win32_Process -Filter "Name='firefox.exe'" -ErrorAction SilentlyContinue |
           Select-Object -ExpandProperty ExecutablePath -Unique | Where-Object { $_ })
  Log ("firefox running: " + $(if ($ffs.Count) { $ffs -join '; ' } else { 'none' }))
  Log ("updating (our variant): " + $(if ($cfg.firefox) { $cfg.firefox } else { '(unknown)' }))
  $withExt = @()
  $base = Join-Path $env:APPDATA 'Mozilla\Firefox\Profiles'
  if (Test-Path $base) {
    foreach ($d in Get-ChildItem $base -Directory -ErrorAction SilentlyContinue) {
      if (Test-Path -LiteralPath (Join-Path $d.FullName ("extensions\" + $cfg.extId + ".xpi"))) { $withExt += $d.Name }
    }
  }
  Log ("profiles with Media Catcher installed: " + $(if ($withExt.Count) { $withExt -join ', ' } else { 'none (or source-loaded)' }))
}

function Schedule-Relaunch($exe) {
  # Reopen Firefox from OUTSIDE our process tree via Task Scheduler. This guardian is a
  # descendant of the Firefox it is about to close (Firefox -> native host -> guardian),
  # so it can be torn down together with that Firefox before it reaches a direct relaunch.
  # A scheduled task survives that and reopens Firefox a few seconds later in the user's
  # session (Firefox restores the saved session per the user's settings).
  try {
    Unregister-ScheduledTask -TaskName 'MediaCatcherRelaunch' -Confirm:$false -ErrorAction SilentlyContinue
    $trigger  = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddSeconds(7))
    $action   = New-ScheduledTaskAction -Execute $exe
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::FromMinutes(2))
    Register-ScheduledTask -TaskName 'MediaCatcherRelaunch' -Trigger $trigger -Action $action -Settings $settings -Force -ErrorAction Stop | Out-Null
    return $true
  } catch {
    Log ("scheduler relaunch registration failed: {0}" -f $_)
    return $false
  }
}

function Restart-Firefox {
  if (-not $cfg.firefox -or $NoRestart) { return }
  $others = @(@(Get-CimInstance Win32_Process -Filter "Name='firefox.exe'" -ErrorAction SilentlyContinue) |
              Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ne $cfg.firefox } |
              Select-Object -ExpandProperty ExecutablePath -Unique)
  if ($others.Count) { Log ("leaving other Firefox variant(s) running: {0}" -f ($others -join '; ')) }
  # Register the relaunch BEFORE closing Firefox, so it survives us being killed with it.
  $scheduled = Schedule-Relaunch $cfg.firefox
  Log ("relaunch via scheduler: {0}" -f $(if ($scheduled) { 'registered (~7s)' } else { 'unavailable' }))
  Start-Sleep -Milliseconds 800
  Log "closing our Firefox variant"
  @(Ff-Mine) | ForEach-Object { & taskkill /PID $_.ProcessId *>$null }
  for ($i = 0; $i -lt 40; $i++) {
    if (-not (@(Ff-Mine).Count)) { break }
    Start-Sleep -Milliseconds 500
  }
  # If the scheduler was unavailable AND we're still alive, relaunch directly. When the
  # task registered, it owns the relaunch — don't double-launch here.
  if (-not $scheduled) {
    Start-Sleep -Seconds 1
    try { Start-Process -FilePath $cfg.firefox; Log "relaunched Firefox directly" }
    catch { Log ("direct relaunch failed: {0}" -f $_) }
  } else {
    Log "closed; scheduled task will reopen Firefox"
  }
}

# ---- main ----
# Single-flight across Firefox instances: only one guardian modifies the shared
# host/extension files at a time; a second (from another Firefox) defers.
$guardMutex = New-Object System.Threading.Mutex($false, 'MediaCatcherGuardian')
try { $haveLock = $guardMutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $haveLock = $true }
if (-not $haveLock) { Log 'another guardian is already running - deferring this update'; exit 0 }
Log ("start: applyExt={0} applyHost={1} extZip={2} hostZip={3}" -f $cfg.applyExt, $cfg.applyHost, $cfg.extZip, $cfg.hostZip)
Log-Landscape
# Security preflight for host destinations BEFORE backup/apply/revert so a
# reparse/hardlink/alias rejection never walks path-based backup/revert through
# the same alias. Ordinary trees continue into backup/apply as before.
if ($cfg.applyHost) {
  try {
    Assert-HostDestinationSafe -HostDir ([string]$cfg.hostDir) -HostZip ([string]$cfg.hostZip)
  } catch {
    Log ("FATAL: host destination security preflight failed, aborting without backup/apply: {0}" -f $_)
    if (-not $NoUi) {
      Dialog-Info "Media Catcher - update aborted" `
        "Host update refused: unsafe destination or archive member.`n`n$_"
    }
    exit 1
  }
}
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
