#!/usr/bin/env python3
"""
mc_host.py — Media Catcher native messaging host.

The browser extension talks to this over stdio (Firefox native messaging). It
drives ffmpeg to record live HLS to a real file on disk, muxing the paired
video + audio the extension supplies. Recordings land in a temp file; the
extension commits them with "save" (move to Downloads) or drops them with
"discard" — so an unsaved recording is discarded when its tab closes.

Protocol (JSON, native-messaging framed: 4-byte native-endian length + payload)
  extension -> host:
    {"cmd":"ping"}
    {"cmd":"record","id":N,"videoUrl":U,"audioUrl":U?,"referer":R,"userAgent":UA,"base":"name"}
    {"cmd":"stop","id":N}
    {"cmd":"snapshot","id":N,"base":"name","dir":D?}  # save current bytes WITHOUT stopping
    {"cmd":"save","id":N,"base":"name","dir":D?}      # auto-save into dir (or Downloads)
    {"cmd":"saveAs","id":N,"base":"name","dir":D?}    # native Save-As dialog
    {"cmd":"pickFolder","requestId":R,"dir":D?}       # native folder picker ("reqId" accepted)
      # replies with exactly one terminal frame:
      #   {"type":"folder","requestId":R,"status":"selected","directory":D}
      #   {"type":"folder","requestId":R,"status":"cancelled"}
      #   {"type":"folder","requestId":R,"status":"error","code":"picker_unavailable"|"invalid_selection"}
    {"cmd":"open","path":P}        # open a saved file with the OS default app
      # P must carry a media/container/subtitle suffix this host produces
      # (mchost.guard.MEDIA_EXTS) — os.startfile RUNS the file, so anything
      # else is refused with an error frame rather than launched. Same for
      # "reveal".
      # The same list governs what the host will CREATE: a pget/ytdl "name"
      # whose suffix is outside it, or that names a Windows device, is
      # refused. "dir" must already exist for pget, pget-single and the
      # ytdl legacy path; the ytdl structured (Save As) path still creates
      # missing components by handle on purpose -- see
      # guard.resolve_existing_dir.
    {"cmd":"badapple","path":P}    # open a saved file in the BadApple player
      # Same MEDIA_EXTS allowlist as "open". The message names the FILE only;
      # the host locates BadApple itself (mchost.tools.find_badapple), so no
      # field here can choose which program runs. Answers with an error frame
      # when BadApple is not installed.
    {"cmd":"update","extDir":D,"zipDir":D?,"profileDir":D?}  # self-update from a packaged zip
    {"cmd":"watch","enable":bool,"extDir":D?,"zipDir":D?}    # auto-install when a package appears
    {"cmd":"checkGithub","auto":bool?,"extDir":D?,"zipDir":D?}  # pull the latest GitHub release
    {"cmd":"discard","id":N}       # delete temp file
  host -> extension:
    {"type":"pong","ffmpeg":bool,"ffmpegPath":str,"version":str,"badapple":bool}
    {"type":"started","id":N}
    {"type":"progress","id":N,"bytes":B,"seconds":S}
    {"type":"stopped","id":N,"file":path,"bytes":B,"seconds":S}
    {"type":"snapshot","id":N,"file":path,"bytes":B,"seconds":S}
    {"type":"saved","id":N,"file":path}
    {"type":"save-cancelled","id":N}
    {"type":"folder","reqId":R,"dir":path}
    {"type":"discarded","id":N}
    {"type":"github-update","reached":bool,"latest":str?,"newer":bool?,"downloaded":[str]?}
    {"type":"error","id":N?,"error":str}
"""
# Canonical-module alias (plan round-2 C1, MANDATORY first executable lines):
# production runs this file as __main__ (mc_host.bat) and the tests spec-load
# it registered as "mc_host" — either way, mchost/ submodules doing
# `import mc_host` must resolve to THIS instance, never a second copy that
# would split all patched/mutable state. The .get() guard covers loaders that
# exec without registering __name__ at all.
import sys as _sys
_m = _sys.modules.get(__name__)
if _m is not None:
    _sys.modules.setdefault("mc_host", _m)

import sys, os, json, struct, subprocess, threading, tempfile, shutil, time, re

VERSION = "1.10.0"

# ---- the extension/host boundary ----------------------------------------
# The schema every message is checked against before main() dispatches it, and
# the allowlist that decides what open/reveal may hand to the shell. Imported
# as a module (not name-by-name) so the table stays one object shared with the
# invariant test in test_host.py — two copies would drift.
from mchost import guard   # noqa: E402,F401


# ---- stdio framing: moved to mchost/nm.py (Task C1) ----------------------
# The IN/OUT globals stay OWNED by nm (init_io rebinds them there; a shim copy
# would go stale), so only the functions are re-exported here.
from mchost.nm import init_io, send, read_message   # noqa: E402,F401


# ---- tool discovery: moved to mchost/tools.py (Task C1) ------------------
from mchost.tools import (HERE, TMPDIR, FFMPEG, find_ffmpeg, downloads_dir,   # noqa: E402,F401
                          find_badapple, sanitize, update_staging_dir)


# ---- self-update ----------------------------------------------------------
# Moved to mchost/updates.py (Task C2), together with the updater helpers, the
# GitHub release auto-update, and the auto-update watcher below. zipfile stays
# imported here for the update-flow code still in the shim (concurrent.futures
# left with pget — Task C3 part 2).
import zipfile, glob, configparser
from mchost.updates import EXT_ID   # noqa: E402,F401

# Per-variant config persistence: moved to mchost/config.py (Task C1).
from mchost.config import _config_path, load_config, save_config   # noqa: E402,F401


# ---- diagnostics: structured log + durable update history -----------------
# Moved to mchost/hlog.py (Task C1). The guardian-monitoring / updater-
# environment / archive-hash / version-parse / package-selection helpers that
# followed moved to mchost/updates.py (Task C2, round-2 I2 boundary);
# _last_avail (updater dedup state) is OWNED there — _install_updates rebinds
# it, so a shim copy would go stale.
from mchost.hlog import _HOST_LOG, _HISTORY_PATH, _now_ms, _hlog, _log_event, _read_history   # noqa: E402,F401
from mchost.updates import (_backup_root, _guardian_log_tail, _is_elevated,   # noqa: E402,F401
                            _update_env, _apply_comps, _watch_guardian_outcome,
                            _vtuple, _zip_manifest_version, _installed_version,
                            _sha, _installed_host_hash, _host_zip_hash,
                            _parse_host_version, _host_zip_version,
                            _installed_host_version, _pkg_version, _newest_zip)


# ---- multi-instance: which Firefox launched this host? -------------------
# Moved to mchost/variant.py (Task C1; round-2 I2 — BEFORE config, which keys
# off _variant_key). _FIREFOX_CACHE is owned by variant.py (launching_firefox
# rebinds it there), so it is not re-exported here.
from mchost.variant import (_proc_snapshot, _pid_exe_path, launching_firefox,   # noqa: E402,F401
                            _variant_key, find_firefox, find_profile)


def restart_firefox(firefox_path):
    """Spawn a DETACHED helper that gracefully closes ONLY this Firefox variant
    (by exe path, leaving other variants running), waits, then relaunches it.
    Detached so it survives this host dying when Firefox closes."""
    if not firefox_path:
        return False
    ff = firefox_path.replace("'", "''")
    script = os.path.join(TMPDIR, "mc_restart.ps1")
    body = (
        "Start-Sleep -Milliseconds 1200\n"
        "$ff = '" + ff + "'\n"
        "$mine = { Get-CimInstance Win32_Process -Filter \"Name='firefox.exe'\" | Where-Object { $_.ExecutablePath -eq $ff } }\n"
        "& $mine | ForEach-Object { taskkill /PID $_.ProcessId *>$null }\n"
        "for ($i=0; $i -lt 80; $i++) { if (-not (& $mine)) { break }; Start-Sleep -Milliseconds 500 }\n"
        "Start-Sleep -Seconds 1\n"
        "Start-Process -FilePath $ff\n"
    )
    try:
        with open(script, "w", encoding="utf-8") as f:
            f.write(body)
    except Exception:
        return False
    try:
        flags = 0
        if os.name == "nt":
            flags = 0x00000008 | 0x00000200 | 0x08000000  # DETACHED | NEW_GROUP | NO_WINDOW
        subprocess.Popen(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
                         creationflags=flags, close_fds=True)
        return True
    except Exception:
        return False


def _messagebox(title, msg, flags):
    """Native Windows MessageBox via user32 — no tkinter/Tcl dependency, so it works
    on any Python install. Returns the dialog's result code (0 on failure)."""
    try:
        import ctypes
        MB_TOPMOST = 0x00040000
        MB_SETFOREGROUND = 0x00010000
        return ctypes.windll.user32.MessageBoxW(0, str(msg), str(title),
                                                flags | MB_TOPMOST | MB_SETFOREGROUND)
    except Exception:
        return 0


def _yesno(title, msg):
    IDYES = 6
    return _messagebox(title, msg, 0x04 | 0x20) == IDYES   # MB_YESNO | MB_ICONQUESTION


def _ask_restart_plan(plan):
    return _yesno("Media Catcher — update ready",
                  "Installed: %s.\n\nFirefox needs to restart to load it.\n\n"
                  "Restart Firefox now? Your tabs will be restored." % (plan_summary(plan) or "update"))


def _ask_install_restart_plan(plan):
    return _yesno("Media Catcher — update available",
                  "Update available: %s.\n\nInstall it and restart Firefox now? "
                  "Your tabs will be restored." % (plan_summary(plan) or "new build"))


def _info(title, msg):
    _messagebox(title, msg, 0x00 | 0x40)   # MB_OK | MB_ICONINFORMATION


def _zip_complete(path):
    """True once the zip is fully written and passes its integrity check."""
    try:
        with zipfile.ZipFile(path) as z:
            return z.testzip() is None
    except Exception:
        return False


def _await_zip(path, tries=10, delay=0.5):
    """Wait for a zip that may still be mid-write (belt-and-suspenders on top of
    the watcher's settle window)."""
    for _ in range(tries):
        if _zip_complete(path):
            return True
        time.sleep(delay)
    return _zip_complete(path)


# Decide what (if anything) is newer than what's installed — extension and host
# are considered INDEPENDENTLY, so a package that bumps only one still updates.
def plan_update(ext_dir, host_dir, zip_dir):
    ext_zip = _newest_zip(zip_dir, "media_catcher*.zip")
    ext_to = _zip_manifest_version(ext_zip) if ext_zip else None
    ext_from = _installed_version(ext_dir)
    ext_newer = bool(ext_zip and ext_to and (not ext_from or _vtuple(ext_to) > _vtuple(ext_from)))

    host_zip = _newest_zip(zip_dir, "media-catcher-host*.zip")
    host_to = _host_zip_version(host_zip) if host_zip else None
    host_from = _installed_host_version(host_dir)
    host_newer = bool(host_zip and host_to and (not host_from or _vtuple(host_to) > _vtuple(host_from)))
    # Content-hash fallback: same version but the code actually changed (version
    # not bumped). We don't auto-apply this — the flow asks the user first.
    host_same_ver_changed = False
    if host_zip and not host_newer and host_to and host_from and _vtuple(host_to) == _vtuple(host_from):
        hz, hi = _host_zip_hash(host_zip), _installed_host_hash(host_dir)
        host_same_ver_changed = bool(hz and hi and hz != hi)

    return {
        "ext_zip": ext_zip, "ext_from": ext_from, "ext_to": ext_to, "ext_newer": ext_newer,
        "host_zip": host_zip, "host_from": host_from, "host_to": host_to, "host_newer": host_newer,
        "host_same_ver_changed": host_same_ver_changed,
        "any": ext_newer or host_newer,
    }


def plan_summary(plan):
    parts = []
    if plan["ext_newer"]:
        parts.append("extension %s → %s" % (plan["ext_from"] or "?", plan["ext_to"]))
    if plan["host_newer"]:
        parts.append("helper %s → %s" % (plan["host_from"] or "?", plan["host_to"]))
    return " · ".join(parts)


_DOS_DEVICES = frozenset({
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
})


def _win32_component_key(part):
    """Case/trailing-dot-space key used to detect Win32-normalized collisions."""
    s = part.casefold()
    while s.endswith(".") or s.endswith(" "):
        s = s[:-1]
    return s


def _validate_host_path_component(part, *, name):
    if part == "":
        raise ValueError("host archive member has empty path component: %r" % name)
    if part in (".", ".."):
        raise ValueError("host archive member has dot path component: %r" % name)
    if ":" in part:
        raise ValueError("host archive member has colon/ADS component: %r" % name)
    for ch in part:
        o = ord(ch)
        if o < 0x20 or o == 0x7F or 0x80 <= o <= 0x9F:
            raise ValueError("host archive member has control character: %r" % name)
    if part.endswith(".") or part.endswith(" "):
        raise ValueError("host archive member has trailing dot/space: %r" % name)
    stem = part.split(".", 1)[0].upper()
    if stem in _DOS_DEVICES:
        raise ValueError("host archive member uses DOS device name: %r" % name)


def _validate_host_archive_member(name):
    """Validate one host-zip member name before any write.

    Returns (relative_path_parts_tuple, is_directory). A single terminal
    separator may mark a directory member; those are skipped only after the
    rest of the name passes validation. Rejects absolute/drive/UNC/device,
    '.'/'..', empty components, NUL/C0/DEL/C1, colon/ADS, DOS devices,
    trailing dot/space, and mixed traversal forms.
    """
    if name is None or name == "":
        raise ValueError("host archive member name is empty")
    if "\x00" in name:
        raise ValueError("host archive member name contains NUL")
    for ch in name:
        o = ord(ch)
        if o < 0x20 or o == 0x7F or 0x80 <= o <= 0x9F:
            raise ValueError("host archive member has control character: %r" % name)
    is_dir = name.endswith("/") or name.endswith("\\")
    core = name[:-1] if is_dir else name
    if core == "":
        raise ValueError("host archive member name is empty")
    if core[0] in "/\\" or core.startswith("//") or core.startswith("\\\\"):
        raise ValueError("host archive member is absolute or UNC: %r" % name)
    if len(core) >= 2 and core[1] == ":":
        raise ValueError("host archive member is drive-qualified: %r" % name)
    if ":" in core:
        raise ValueError("host archive member has colon/ADS: %r" % name)
    unified = core.replace("\\", "/")
    if unified.startswith("/") or unified.startswith("//"):
        raise ValueError("host archive member is absolute or UNC: %r" % name)
    parts = unified.split("/")
    for p in parts:
        _validate_host_path_component(p, name=name)
    return tuple(parts), is_dir


def _host_member_norm_key(parts):
    return tuple(_win32_component_key(p) for p in parts)


def _host_member_destination(host_dir, rel):
    """Lexical join only — not filesystem authority. Prefer handle writers."""
    if isinstance(rel, (tuple, list)):
        rel = os.path.join(*rel) if rel else ""
    host_abs = os.path.abspath(host_dir)
    dest_abs = os.path.abspath(os.path.join(host_dir, rel))
    if dest_abs != host_abs and not dest_abs.startswith(host_abs + os.sep):
        raise ValueError("host archive member escapes destination: %r" % rel)
    return dest_abs


# ---- Windows handle-authority destination containment --------------------
if sys.platform == "win32":
    import ctypes
    from ctypes import wintypes

    _k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _ntdll = ctypes.WinDLL("ntdll", use_last_error=True)

    _INVALID_HANDLE_VALUE = wintypes.HANDLE(-1).value
    _GENERIC_READ = 0x80000000
    _GENERIC_WRITE = 0x40000000
    _FILE_SHARE_READ = 0x00000001
    _FILE_SHARE_WRITE = 0x00000002
    _OPEN_EXISTING = 3
    _FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
    _FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
    _FILE_ATTRIBUTE_DIRECTORY = 0x00000010
    _FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400
    # FILE_INFO_BY_HANDLE_CLASS values (winbase.h)
    _FileStandardInfo = 1
    _FileAttributeTagInfo = 9
    _FileIdInfo = 18
    _FILE_OPEN = 0x00000001
    _FILE_CREATE = 0x00000002
    _FILE_OPEN_IF = 0x00000003
    _FILE_OVERWRITE_IF = 0x00000005
    _FILE_DIRECTORY_FILE = 0x00000001
    _FILE_NON_DIRECTORY_FILE = 0x00000040
    _FILE_OPEN_REPARSE_POINT = 0x00200000
    _FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020
    _FILE_OPEN_FOR_BACKUP_INTENT = 0x00004000
    _OBJ_CASE_INSENSITIVE = 0x00000040
    _DELETE = 0x00010000
    _SYNCHRONIZE = 0x00100000
    _FILE_READ_ATTRIBUTES = 0x0080
    _FILE_WRITE_DATA = 0x0002
    _FILE_READ_DATA = 0x0001
    _FILE_APPEND_DATA = 0x0004
    _STATUS_OBJECT_NAME_NOT_FOUND = 0xC0000034
    _STATUS_OBJECT_PATH_NOT_FOUND = 0xC000003A
    _STATUS_DELETE_PENDING = 0xC0000056

    class _FILE_ATTRIBUTE_TAG_INFO(ctypes.Structure):
        _fields_ = [("FileAttributes", wintypes.DWORD),
                    ("ReparseTag", wintypes.DWORD)]

    class _FILE_STANDARD_INFO(ctypes.Structure):
        _fields_ = [("AllocationSize", ctypes.c_longlong),
                    ("EndOfFile", ctypes.c_longlong),
                    ("NumberOfLinks", wintypes.DWORD),
                    ("DeletePending", wintypes.BOOLEAN),
                    ("Directory", wintypes.BOOLEAN)]

    class _IO_STATUS_BLOCK(ctypes.Structure):
        _fields_ = [("Status", ctypes.c_long),
                    ("Information", ctypes.c_void_p)]

    class _UNICODE_STRING(ctypes.Structure):
        _fields_ = [("Length", wintypes.USHORT),
                    ("MaximumLength", wintypes.USHORT),
                    ("Buffer", wintypes.LPWSTR)]

    class _OBJECT_ATTRIBUTES(ctypes.Structure):
        _fields_ = [("Length", wintypes.ULONG),
                    ("RootDirectory", wintypes.HANDLE),
                    ("ObjectName", ctypes.POINTER(_UNICODE_STRING)),
                    ("Attributes", wintypes.ULONG),
                    ("SecurityDescriptor", ctypes.c_void_p),
                    ("SecurityQualityOfService", ctypes.c_void_p)]

    _k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                 ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD,
                                 wintypes.HANDLE]
    _k32.CreateFileW.restype = wintypes.HANDLE
    _k32.CloseHandle.argtypes = [wintypes.HANDLE]
    _k32.CloseHandle.restype = wintypes.BOOL
    _k32.GetFileInformationByHandleEx.argtypes = [
        wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    _k32.GetFileInformationByHandleEx.restype = wintypes.BOOL
    _k32.WriteFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                               ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
    _k32.WriteFile.restype = wintypes.BOOL
    _k32.SetEndOfFile.argtypes = [wintypes.HANDLE]
    _k32.SetEndOfFile.restype = wintypes.BOOL
    _k32.SetFilePointerEx.argtypes = [
        wintypes.HANDLE, ctypes.c_longlong, ctypes.POINTER(ctypes.c_longlong),
        wintypes.DWORD]
    _k32.SetFilePointerEx.restype = wintypes.BOOL

    _ntdll.NtCreateFile.argtypes = [
        ctypes.POINTER(wintypes.HANDLE), wintypes.ULONG,
        ctypes.POINTER(_OBJECT_ATTRIBUTES), ctypes.POINTER(_IO_STATUS_BLOCK),
        ctypes.c_void_p, wintypes.ULONG, wintypes.ULONG, wintypes.ULONG,
        wintypes.ULONG, ctypes.c_void_p, wintypes.ULONG]
    _ntdll.NtCreateFile.restype = ctypes.c_long

    def _close_handle(h):
        if h and h != _INVALID_HANDLE_VALUE:
            _k32.CloseHandle(h)

    def _query_attr_tag(h):
        info = _FILE_ATTRIBUTE_TAG_INFO()
        if not _k32.GetFileInformationByHandleEx(
                h, _FileAttributeTagInfo, ctypes.byref(info), ctypes.sizeof(info)):
            raise OSError(ctypes.get_last_error(), "FileAttributeTagInfo failed")
        return info

    def _query_standard(h):
        info = _FILE_STANDARD_INFO()
        if not _k32.GetFileInformationByHandleEx(
                h, _FileStandardInfo, ctypes.byref(info), ctypes.sizeof(info)):
            raise OSError(ctypes.get_last_error(), "FileStandardInfo failed")
        return info

    def _open_path_reparse(path, access=_GENERIC_READ | _FILE_READ_ATTRIBUTES | _SYNCHRONIZE):
        flags = _FILE_FLAG_OPEN_REPARSE_POINT | _FILE_FLAG_BACKUP_SEMANTICS
        h = _k32.CreateFileW(
            path, access, _FILE_SHARE_READ | _FILE_SHARE_WRITE, None,
            _OPEN_EXISTING, flags, None)
        if h == _INVALID_HANDLE_VALUE or h is None:
            raise OSError(ctypes.get_last_error(), "CreateFileW failed for %r" % path)
        return h

    def _nt_open_relative(root, name, *, directory, create=False, write=False):
        """Open/create name relative to root handle; never follows reparse."""
        buf = ctypes.create_unicode_buffer(name)
        us = _UNICODE_STRING()
        us.Length = len(name) * 2
        us.MaximumLength = (len(name) + 1) * 2
        us.Buffer = ctypes.cast(buf, wintypes.LPWSTR)
        oa = _OBJECT_ATTRIBUTES()
        oa.Length = ctypes.sizeof(_OBJECT_ATTRIBUTES)
        oa.RootDirectory = root
        oa.ObjectName = ctypes.pointer(us)
        oa.Attributes = _OBJ_CASE_INSENSITIVE
        oa.SecurityDescriptor = None
        oa.SecurityQualityOfService = None
        iosb = _IO_STATUS_BLOCK()
        handle = wintypes.HANDLE()
        access = _FILE_READ_ATTRIBUTES | _SYNCHRONIZE
        if write:
            access |= _GENERIC_WRITE | _FILE_WRITE_DATA | _FILE_APPEND_DATA | _FILE_READ_DATA
        else:
            access |= _GENERIC_READ
        if directory:
            access |= _FILE_READ_DATA  # enumeration
        options = _FILE_OPEN_REPARSE_POINT | _FILE_SYNCHRONOUS_IO_NONALERT | _FILE_OPEN_FOR_BACKUP_INTENT
        if directory:
            options |= _FILE_DIRECTORY_FILE
        else:
            options |= _FILE_NON_DIRECTORY_FILE
        if create:
            disposition = _FILE_OPEN_IF if directory else _FILE_OVERWRITE_IF
        else:
            disposition = _FILE_OPEN
        # Never share DELETE so components cannot be swapped mid-operation.
        share = _FILE_SHARE_READ | _FILE_SHARE_WRITE
        status = _ntdll.NtCreateFile(
            ctypes.byref(handle), access, ctypes.byref(oa), ctypes.byref(iosb),
            None, _FILE_ATTRIBUTE_DIRECTORY if directory else 0,
            share, disposition, options, None, 0)
        status_u = status & 0xFFFFFFFF
        if status_u == _STATUS_OBJECT_NAME_NOT_FOUND or status_u == _STATUS_OBJECT_PATH_NOT_FOUND:
            return None
        if status_u == _STATUS_DELETE_PENDING:
            raise ValueError("host destination is delete-pending: %r" % name)
        if status < 0:
            raise OSError(status_u, "NtCreateFile failed for %r (0x%08X)" % (name, status_u))
        return handle.value

    def _validate_handle_no_reparse(h, *, expect_dir, allow_missing_nlink=False, final_file=False):
        tag = _query_attr_tag(h)
        attrs = tag.FileAttributes
        if attrs & _FILE_ATTRIBUTE_REPARSE_POINT:
            raise ValueError("host destination path contains a reparse point")
        if tag.ReparseTag not in (0, None):
            # Some volumes report tag only with reparse attribute; treat non-zero as reparse.
            if attrs & _FILE_ATTRIBUTE_REPARSE_POINT:
                raise ValueError("host destination path contains a reparse point")
        is_dir = bool(attrs & _FILE_ATTRIBUTE_DIRECTORY)
        if expect_dir and not is_dir:
            raise ValueError("host destination component is not a directory")
        if not expect_dir and is_dir:
            raise ValueError("host destination final component is a directory")
        std = _query_standard(h)
        if std.DeletePending:
            raise ValueError("host destination is delete-pending")
        if final_file:
            if std.NumberOfLinks != 1:
                raise ValueError("host destination is a hard-link alias (nlink=%s)" % std.NumberOfLinks)
        return tag, std

    def _open_host_root(host_dir):
        # Absolute path for the initial open only; authority is the retained handle.
        path = os.path.abspath(host_dir)
        if not path:
            raise ValueError("host directory is empty")
        h = _open_path_reparse(path)
        try:
            _validate_handle_no_reparse(h, expect_dir=True)
        except Exception:
            _close_handle(h)
            raise
        return h

    def _preflight_member_chain(root_h, parts):
        """Walk existing chain under root; reject reparse/hardlink; return missing suffix idx."""
        cur = root_h
        owned = []
        try:
            for i, part in enumerate(parts):
                is_final = i == len(parts) - 1
                h = _nt_open_relative(cur, part, directory=not is_final, create=False, write=False)
                if h is None:
                    # Remaining components must be created later; none may exist as reparse.
                    return i
                owned.append(h)
                if is_final:
                    _validate_handle_no_reparse(h, expect_dir=False, final_file=True)
                else:
                    _validate_handle_no_reparse(h, expect_dir=True)
                cur = h
            return len(parts)
        finally:
            for h in owned:
                _close_handle(h)

    def _nt_create_relative(root, name, *, directory, write=False, disposition=None):
        """NtCreateFile relative open/create with explicit disposition."""
        buf = ctypes.create_unicode_buffer(name)
        us = _UNICODE_STRING()
        us.Length = len(name) * 2
        us.MaximumLength = (len(name) + 1) * 2
        us.Buffer = ctypes.cast(buf, wintypes.LPWSTR)
        oa = _OBJECT_ATTRIBUTES()
        oa.Length = ctypes.sizeof(_OBJECT_ATTRIBUTES)
        oa.RootDirectory = root
        oa.ObjectName = ctypes.pointer(us)
        oa.Attributes = _OBJ_CASE_INSENSITIVE
        oa.SecurityDescriptor = None
        oa.SecurityQualityOfService = None
        iosb = _IO_STATUS_BLOCK()
        handle = wintypes.HANDLE()
        access = _FILE_READ_ATTRIBUTES | _SYNCHRONIZE
        if write:
            access |= _GENERIC_WRITE | _FILE_WRITE_DATA | _FILE_APPEND_DATA | _FILE_READ_DATA
        else:
            access |= _GENERIC_READ
        if directory:
            access |= _FILE_READ_DATA
        options = (_FILE_OPEN_REPARSE_POINT | _FILE_SYNCHRONOUS_IO_NONALERT
                   | _FILE_OPEN_FOR_BACKUP_INTENT)
        if directory:
            options |= _FILE_DIRECTORY_FILE
        else:
            options |= _FILE_NON_DIRECTORY_FILE
        if disposition is None:
            disposition = _FILE_OPEN
        share = _FILE_SHARE_READ | _FILE_SHARE_WRITE
        status = _ntdll.NtCreateFile(
            ctypes.byref(handle), access, ctypes.byref(oa), ctypes.byref(iosb),
            None, _FILE_ATTRIBUTE_DIRECTORY if directory else 0,
            share, disposition, options, None, 0)
        status_u = status & 0xFFFFFFFF
        if status_u in (_STATUS_OBJECT_NAME_NOT_FOUND, _STATUS_OBJECT_PATH_NOT_FOUND):
            return None, status_u
        if status_u == _STATUS_DELETE_PENDING:
            raise ValueError("host destination is delete-pending: %r" % name)
        if status < 0:
            return None, status_u
        return handle.value, status_u

    def _write_member_handle(root_h, parts, data_iter):
        """Create intermediate dirs and write final file relative to retained root."""
        cur = root_h
        owned = []
        file_h = None
        try:
            for part in parts[:-1]:
                h, st = _nt_create_relative(
                    cur, part, directory=True, write=False, disposition=_FILE_OPEN_IF)
                if h is None:
                    raise ValueError(
                        "failed to open/create host directory component: %r (0x%08X)" % (part, st or 0))
                owned.append(h)
                _validate_handle_no_reparse(h, expect_dir=True)
                cur = h
            final = parts[-1]
            # Open existing without truncate; reject reparse/hardlink before any write.
            existing, _ = _nt_create_relative(
                cur, final, directory=False, write=False, disposition=_FILE_OPEN)
            if existing is not None:
                try:
                    _validate_handle_no_reparse(existing, expect_dir=False, final_file=True)
                finally:
                    _close_handle(existing)
                file_h, st = _nt_create_relative(
                    cur, final, directory=False, write=True, disposition=_FILE_OPEN)
                if file_h is None:
                    raise ValueError("failed to reopen host file for write: %r" % final)
            else:
                # Create new only — never OPEN_IF/OVERWRITE_IF (those can touch aliases).
                file_h, st = _nt_create_relative(
                    cur, final, directory=False, write=True, disposition=_FILE_CREATE)
                if file_h is None:
                    raise ValueError(
                        "failed to create host file: %r (0x%08X)" % (final, st or 0))
            _validate_handle_no_reparse(file_h, expect_dir=False, final_file=True)
            if not _k32.SetFilePointerEx(file_h, 0, None, 0):
                raise OSError(ctypes.get_last_error(), "SetFilePointerEx failed")
            if not _k32.SetEndOfFile(file_h):
                raise OSError(ctypes.get_last_error(), "SetEndOfFile failed")
            for chunk in data_iter:
                if not chunk:
                    continue
                written = wintypes.DWORD(0)
                buf = ctypes.create_string_buffer(chunk)
                if not _k32.WriteFile(file_h, buf, len(chunk), ctypes.byref(written), None):
                    raise OSError(ctypes.get_last_error(), "WriteFile failed")
                if written.value != len(chunk):
                    raise OSError(0, "short WriteFile")
        finally:
            if file_h is not None:
                _close_handle(file_h)
            for h in owned:
                _close_handle(h)

    def _apply_host_zip_windows(z, host_dir):
        accepted = []
        seen = {}
        for n in z.namelist():
            parts, is_dir = _validate_host_archive_member(n)
            key = _host_member_norm_key(parts)
            if key in seen:
                raise ValueError(
                    "host archive has duplicate destination %r / %r" % (seen[key], n))
            seen[key] = n
            if is_dir:
                continue
            accepted.append((n, parts))
        root = _open_host_root(host_dir)
        try:
            for n, parts in accepted:
                _preflight_member_chain(root, parts)
            for n, parts in accepted:
                def _chunks(member=n):
                    with z.open(member) as src:
                        while True:
                            b = src.read(1024 * 1024)
                            if not b:
                                break
                            yield b
                _write_member_handle(root, parts, _chunks())
        finally:
            _close_handle(root)

else:
    def _apply_host_zip_windows(z, host_dir):
        raise RuntimeError("Windows handle-authority apply is unavailable")


def _apply_host_zip(z, host_dir):
    """Validate every member, then write with filesystem-handle authority on Windows."""
    if sys.platform == "win32":
        _apply_host_zip_windows(z, host_dir)
        return
    # Non-Windows: lexical validation + realpath containment (symlink-safe).
    accepted = []
    seen = {}
    host_real = os.path.realpath(host_dir)
    if not os.path.isdir(host_real):
        raise ValueError("host directory is not a directory")
    for n in z.namelist():
        parts, is_dir = _validate_host_archive_member(n)
        key = _host_member_norm_key(parts)
        if key in seen:
            raise ValueError("host archive has duplicate destination %r / %r" % (seen[key], n))
        seen[key] = n
        if is_dir:
            continue
        accepted.append((n, parts))
    for n, parts in accepted:
        dest = os.path.realpath(os.path.join(host_real, *parts))
        if dest != host_real and not dest.startswith(host_real + os.sep):
            raise ValueError("host archive member escapes destination: %r" % (parts,))
        parent = os.path.dirname(dest)
        if parent:
            os.makedirs(parent, exist_ok=True)
        # Refuse to write through a symlink final leaf.
        if os.path.lexists(dest) and os.path.islink(dest):
            raise ValueError("host destination is a symlink: %r" % (parts,))
        with z.open(n) as src, open(dest, "wb") as dst:
            shutil.copyfileobj(src, dst)


def apply_update(plan, ext_dir, host_dir):
    """Apply only the parts that are newer. Returns {staged: bool}."""
    # No lexical preflight here any more: _apply_host_zip validates by HANDLE as
    # it walks, which closes the check-then-open race the pathname walk left open.
    staged = False
    if plan["ext_newer"]:
        if not _await_zip(plan["ext_zip"]):
            raise RuntimeError("extension package is incomplete or corrupt")
        with zipfile.ZipFile(plan["ext_zip"]) as z:
            z.extractall(ext_dir)
        cfg = load_config()
        profile = cfg.get("profileDir") or find_profile()
        if profile and os.path.isdir(profile):
            cfg["profileDir"] = profile; save_config(cfg)
            try:
                exd = os.path.join(profile, "extensions")
                os.makedirs(exd, exist_ok=True)
                shutil.copyfile(plan["ext_zip"], os.path.join(exd, EXT_ID + ".xpi"))
                staged = True
            except Exception:
                staged = False
    if plan["host_newer"] and _await_zip(plan["host_zip"]):
        with zipfile.ZipFile(plan["host_zip"]) as z:
            _apply_host_zip(z, host_dir)
    return {"staged": staged}


def _console_python():
    """The CONSOLE interpreter for subprocess checks. The host runs under pythonw.exe
    (no console, so Firefox spawning it doesn't flash a window), but
    `pythonw.exe -m py_compile` returns no exit code PowerShell can read — so the
    guardian's verify step read it as a failure and reverted EVERY host update. Hand
    the guardian python.exe instead."""
    exe = sys.executable or ""
    if exe.lower().endswith("pythonw.exe"):
        cand = exe[:-len("pythonw.exe")] + "python.exe"
        if os.path.exists(cand):
            return cand
    return exe


def _guardian_config(cfg, apply_ext, apply_host, plan, ext_dir, host_dir, profile, firefox, restart):
    """Build the JSON config handed to guardian.ps1."""
    return {
        "applyExt": bool(apply_ext), "applyHost": bool(apply_host),
        "extZip": plan["ext_zip"] if apply_ext else None,
        "hostZip": plan["host_zip"] if apply_host else None,
        "extDir": ext_dir, "hostDir": host_dir,
        "profileDir": profile or "", "extId": EXT_ID,
        "expectExtVersion": plan["ext_to"] if apply_ext else None,
        "expectHostVersion": plan["host_to"] if apply_host else None,
        "python": _console_python(), "firefox": firefox, "restart": bool(restart),
        "backupRoot": _backup_root(),
        "keep": 3,
    }


def launch_guardian(apply_ext, apply_host, plan, ext_dir, host_dir, restart=True):
    """Hand the install off to the PowerShell reliability guardian, which backs up
    the current versions, applies, verifies, and reverts on failure — surviving
    this host being killed when Firefox restarts. Falls back to in-process apply
    if the guardian script isn't present."""
    cfg = load_config()
    profile = cfg.get("profileDir") or find_profile()
    firefox = find_firefox() or ""
    guardian = os.path.join(HERE, "guardian.ps1")
    conf = _guardian_config(cfg, apply_ext, apply_host, plan, ext_dir, host_dir, profile, firefox, restart)
    confpath = os.path.join(TMPDIR, "guardian_config.json")
    try:
        with open(confpath, "w", encoding="utf-8") as f:
            json.dump(conf, f, indent=2)
    except Exception:
        pass

    if not os.path.isfile(guardian):
        # No guardian available — apply in-process (no backup/verify/revert).
        p2 = dict(plan); p2["ext_newer"] = apply_ext; p2["host_newer"] = apply_host
        try:
            apply_update(p2, ext_dir, host_dir)
        except Exception:
            return "error"
        if restart:
            restart_firefox(firefox)
        return "fallback"

    argv = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
            "-File", guardian, "-Config", confpath]
    if os.name != "nt":
        try:
            subprocess.Popen(argv, close_fds=True)
            return "guardian"
        except Exception:
            return "error"
    # CREATE_NO_WINDOW, NOT DETACHED_PROCESS. A detached process has no console, and
    # Windows PowerShell can't start its host without one — it exits before running a
    # single line, so the guardian silently never applied anything (no log, no update).
    # NO_WINDOW gives it a hidden console. NEW_PROCESS_GROUP + BREAKAWAY_FROM_JOB let it
    # outlive this host when Firefox restarts; breakaway raises if the job forbids it,
    # so fall back without it.
    NO_WINDOW, NEW_GROUP, BREAKAWAY = 0x08000000, 0x00000200, 0x01000000
    for extra in (BREAKAWAY, 0):
        try:
            subprocess.Popen(argv, creationflags=NO_WINDOW | NEW_GROUP | extra, close_fds=True)
            return "guardian"
        except Exception:
            continue
    return "error"


# ---- GitHub release auto-update ------------------------------------------
# Moved to mchost/updates.py (Task C2). _github_poll_started (rebound by
# start_github_poll) and _update_lock are owned by updates — a shim copy of
# the flag would go stale, so neither is re-exported here.
from mchost.updates import (GITHUB_REPO, GITHUB_RELEASES_URL, _GITHUB_POLL_INTERVAL,   # noqa: E402,F401
                            _http_get, _tag_to_version, github_latest_release,
                            _download, github_stage_release, handle_check_github,
                            _github_poll_loop, start_github_poll, _install_updates,
                            handle_update, handle_get_report)


# ---- auto-update watcher (event-driven, no polling) -----------------------
# Moved to mchost/updates.py (Task C2). _WATCH (the stop-event/dir registry)
# is owned by updates and not re-exported.
from mchost.updates import (_parse_notify, _dir_watcher, _auto_update_check,   # noqa: E402,F401
                            start_watch, stop_watch, handle_watch,
                            _resolve_zip_dir)


# ---- jobs ----
# Moved to mchost/downloads.py (Task C3 part 1), together with the HEVC/AV1
# conversion and the save/open/reveal/discard handlers below. JOBS/JOBS_LOCK
# (the recording registry) are owned by downloads — shim code reaches them
# through the module, never via a stale copy.
from mchost.downloads import (Job, ffmpeg_cmd, run_job, handle_record,   # noqa: E402,F401
                              handle_stop, _copy_prefix, handle_snapshot, _dedup)


# ---- optional H.265 (HEVC) conversion ----------------------------------------
# Moved to mchost/downloads.py (Task C3 part 1). _HEVC_ENC/_ENC_CACHE (encoder
# probe caches) are owned by downloads and not re-exported.
from mchost.downloads import (_no_window, find_encoder, _codec_args, _safe_kill,   # noqa: E402,F401
                              _probe_media, _TARGET_BPP, _transcode_worthwhile,
                              transcode, _finalize_move, _ask_save_path, _ask_folder)


# ---- save / save-as / pick-folder / open / reveal / badapple / discard -----
# Moved to mchost/downloads.py (Task C3 part 1).
from mchost.downloads import (handle_save, handle_save_as, handle_pick_folder,   # noqa: E402,F401
                              handle_open, handle_reveal, handle_badapple,
                              handle_discard)


# ---- YouTube (and other sites) via yt-dlp + bgutil PO-token provider ------
# Moved to mchost/downloads.py (Task C3 part 2). YTDLP/NODE/DENO (rebound by
# ensure_ytdlp/ensure_deno), _YTDLP_VER (rebound by ytdlp_update and main()'s
# _yt_probe) and _POT are owned by downloads — main() reads them through the
# module object (_downloads), never via a shim copy that would go stale.
import mchost.downloads as _downloads   # noqa: E402
from mchost.downloads import (find_ytdlp, find_node, find_deno, _POT_PORT,   # noqa: E402,F401
                              _ytdlp_version, ytdlp_version_cached, ytdlp_update,
                              ensure_ytdlp, ensure_deno, _pot_server_entry,
                              _pot_alive, start_pot_provider, _YT_ERR,
                              _map_yt_error, _yt_stage_note, _parse_yt_progress,
                              _simplify_vcodec, handle_ytmeta, handle_ytdl)

# ==================== Casting — DLNA/UPnP + AirPlay ====================
# Moved to mchost/cast/legacy.py (Task C4 step 2) behind the CastBackend
# socket: the DLNA/UPnP stack, the local media server that feeds both
# protocols, and the AirPlay/pyatv stack. LegacyBackend binds onto these; the
# names stay re-exported here so the shim remains the single patch surface
# (the warm-discovery tests patch _cast_seen_devices/_cast_merged_discover/
# _CAST_SEEN on it). _DLNA/_CAST/_CAST_SEEN are mutated IN PLACE and never
# rebound, so these are not stale copies; _DLNA_SRV_LOCK/_CAST_SEEN_LOCK stay
# internal to legacy.py. The interim _DISCOVER_LOCK is gone — mchost/cast/
# __init__.py owns scan coalescing now (plan round-3 I6).
from mchost.cast.legacy import (_DLNA, _lan_ip, _ssdp_discover, _dlna_describe,   # noqa: E402,F401
                                _dlna_soap, _dlna_soap_retry, _ensure_media_server,
                                _ensure_media_server_locked, _dlna_media_url,
                                _stop_media_server, _close_media_server,
                                _dlna_discover, _hms, _from_hms, _DLNA_STATE,
                                _dlna_status, _dlna_start, _dlna_control,
                                _dlna_start_poller)
from mchost.cast.legacy import (_PYLIBS, _CAST, _PYATV_SRC, ensure_pyatv,   # noqa: E402,F401
                                _cast_loop, _cast_run, _cast_storage, _find_config,
                                _CAST_SEEN, _CAST_SEEN_TTL, _cast_seen_devices,
                                _is_apple_tv, _cast_merged_discover, _cast_discover,
                                _cast_pair_begin, _cast_pair_cancel, _cast_pair_pin,
                                _cast_start, _cast_status_once, _cast_control,
                                _cast_teardown, _cast_err, _cast_start_poller,
                                _cast_stop_poller, _cast_stop_active)


# ==================== Casting — the CastBackend socket ====================
# handle_cast moved to mchost/cast/__init__.py (Task C4): the dispatcher owns
# the worker thread, the warm-discovery protocol, discovery coalescing (which
# replaces the interim _DISCOVER_LOCK that used to live here), teardown
# ordering, reply correlation and error normalization. The transport lives
# behind CastBackend — LegacyBackend (mchost/cast/legacy.py) binds onto the
# DLNA/AirPlay functions still in this file until Task C4 step 2 moves them.
from mchost.cast import handle_cast   # noqa: E402,F401

# ---- Settings probe -------------------------------------------------------
# The checks that isolated the Defender-scanning incident, in their own module:
# downloads.py is already past 4000 lines and this is not downloads.
from mchost.probe import handle_probe   # noqa: E402,F401


def main():
    init_io()
    _hlog("info", "host v%s connected — %s" % (VERSION, os.path.basename(sys.executable or "python")))
    # Learn the yt-dlp version in the background so the handshake can report it
    # without delaying startup.
    def _yt_probe():
        # YTDLP/NODE/_YTDLP_VER live in mchost.downloads — read/write them on
        # the module object; a shim-local global would be a stale copy.
        _downloads._YTDLP_VER = _ytdlp_version() or ""
        if _downloads.YTDLP:
            _hlog("info", "yt-dlp %s%s" % (_downloads._YTDLP_VER or "?", "" if _downloads.NODE else " (no Node — PO-token provider unavailable)"))
    threading.Thread(target=_yt_probe, daemon=True).start()
    # Resume watching the package folder if auto-update was left on.
    try:
        cfg = load_config()
        if cfg.get("autoUpdate") and cfg.get("extDir") and os.name == "nt":
            start_watch(_resolve_zip_dir(cfg))
            start_github_poll()
    except Exception:
        pass
    try:
        while True:
            try:
                msg = read_message()
            except Exception as e:
                send({"type": "error", "error": "read failed: %s" % e})
                break
            if msg is None:
                break
            # The schema gate — everything below this point may assume the
            # message is an object, that its cmd is one this loop dispatches,
            # and that every field the handler reads is of the type it expects.
            # It may NOT assume any of those values is safe: a str is still an
            # attacker's str (see mchost/guard.py's own note on what this buys).
            #
            # Above the try on purpose: `msg.get("cmd")` was here, outside it,
            # so a frame carrying a JSON array raised AttributeError straight
            # out of the while loop and killed the host — every live recording
            # with it. Refusals are frames, never drops and never throws.
            refusal = guard.validate_message(msg)
            if refusal:
                try:
                    send({"type": "error", "id": guard.message_id(msg),
                          "error": refusal})
                except Exception:
                    pass
                continue
            cmd = msg.get("cmd")
            try:
                if cmd == "ping":
                    send({"type": "pong", "ffmpeg": bool(FFMPEG), "ffmpegPath": FFMPEG or "", "version": VERSION,
                          "ytdlp": bool(_downloads.YTDLP), "ytdlpVersion": ytdlp_version_cached(),
                          "node": bool(_downloads.NODE), "deno": bool(_downloads.DENO), "pot": _pot_alive(),
                          "cast": True,  # DLNA casting is stdlib — always available
                          # Probed per beat, not cached: installing BadApple
                          # while Firefox is up must not need a restart before
                          # the popup offers the button.
                          "badapple": bool(find_badapple()),
                          "ytdlProtocol": 2})
                elif cmd == "ytdl":
                    handle_ytdl(msg)
                elif cmd == "ytmeta":
                    handle_ytmeta(msg)
                elif cmd == "cast":
                    handle_cast(msg)
                elif cmd == "ytdlUpdate":
                    threading.Thread(target=ytdlp_update, daemon=True).start()
                elif cmd == "record":
                    handle_record(msg)
                elif cmd == "stop":
                    handle_stop(msg)
                elif cmd == "snapshot":
                    handle_snapshot(msg)
                elif cmd == "save":
                    handle_save(msg)
                elif cmd == "saveAs":
                    handle_save_as(msg)
                elif cmd == "pickFolder":
                    handle_pick_folder(msg)
                elif cmd == "open":
                    handle_open(msg)
                elif cmd == "reveal":
                    handle_reveal(msg)
                elif cmd == "badapple":
                    handle_badapple(msg)
                elif cmd == "update":
                    handle_update(msg)
                elif cmd == "watch":
                    handle_watch(msg)
                elif cmd == "checkGithub":
                    handle_check_github(msg)
                elif cmd == "discard":
                    handle_discard(msg)
                elif cmd == "pget":
                    handle_pget(msg)
                elif cmd == "pget-single":
                    handle_pget_single(msg)
                elif cmd == "pget-set-limit":
                    handle_pget_set_limit(msg)
                elif cmd == "getReport":
                    handle_get_report(msg)
                elif cmd == "probe":
                    handle_probe(msg)
                elif cmd == "pget-cancel":
                    _pget_cancel(msg)
                elif cmd == "file-open":
                    handle_file_open(msg)
                elif cmd == "file-chunk":
                    handle_file_chunk(msg)
                elif cmd == "file-commit":
                    handle_file_commit(msg)
                elif cmd == "file-abort":
                    handle_file_abort(msg)
            except Exception as e:
                send({"type": "error", "id": msg.get("id"), "error": str(e)})
    finally:
        # Bound .part files from this process must not block a retry after
        # native-messaging EOF / read failure. No frames — stdout may be gone.
        cleanup_file_sinks()


# ---- parallel multi-mirror direct download --------------------------------
# Moved to mchost/downloads.py (Task C3 part 2). _PGET (the cancel registry —
# shared with handle_ytdl, which registers its yt-dlp proc there) is owned by
# downloads and not re-exported.
from mchost.downloads import (_pget_open, _pget_probe, _pget_segment,   # noqa: E402,F401
                              _pget_cleanup, _pget_cancel, handle_pget,
                              handle_pget_single, handle_pget_set_limit,
                              _pget_send_result, _pget_classify_exc,
                              _pget_classify_http_status, _PGET)


# ---- native JSON file sink (browser-fetched HLS/DASH bytes) ---------------
# Owned by mchost/filesink.py (Task 15). Registry/mutable sink state lives
# there; handlers re-exported so monkeypatch.setattr(mc_host, "send", ...) is
# honored via filesink's call-time _h() lookup.
from mchost.filesink import (handle_file_open, handle_file_chunk,   # noqa: E402,F401
                             handle_file_commit, handle_file_abort,
                             cleanup_file_sinks)


if __name__ == "__main__":
    main()
