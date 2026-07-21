"""Multi-instance / Firefox-variant identification (moved verbatim from mc_host.py — Task C1).

_FIREFOX_CACHE is owned here (single-ownership rule): launching_firefox rebinds
it in this module's namespace. All callees are module-private, so references
stay bare.
"""
import configparser
import os
import shutil

# ---- multi-instance: which Firefox launched this host? -------------------
# Several Firefox variants share one native-host registration, so each spawns its
# own host process. We identify OUR Firefox by walking up the process tree, key
# the config per-variant, and (in the guardian) restart only our own Firefox.
_FIREFOX_CACHE = "?"   # "?" = unresolved; None = not found


def _proc_snapshot():
    """pid -> (exe_name_lower, ppid) for all processes (Windows toolhelp)."""
    import ctypes
    from ctypes import wintypes

    class PE(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
                    ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ctypes.c_void_p),
                    ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                    ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long),
                    ("dwFlags", wintypes.DWORD), ("szExeFile", ctypes.c_wchar * 260)]
    k32 = ctypes.windll.kernel32
    snap = k32.CreateToolhelp32Snapshot(0x2, 0)
    out = {}
    try:
        e = PE(); e.dwSize = ctypes.sizeof(e)
        if k32.Process32FirstW(snap, ctypes.byref(e)):
            while True:
                out[int(e.th32ProcessID)] = (e.szExeFile.lower(), int(e.th32ParentProcessID))
                if not k32.Process32NextW(snap, ctypes.byref(e)):
                    break
    finally:
        k32.CloseHandle(snap)
    return out


def _pid_exe_path(pid):
    import ctypes
    from ctypes import wintypes
    k32 = ctypes.windll.kernel32
    h = k32.OpenProcess(0x1000, False, pid)   # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(1024)
        if k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return buf.value
    finally:
        k32.CloseHandle(h)
    return ""


def launching_firefox():
    """Full path of the firefox.exe that spawned this host (walking up past the
    .bat/cmd wrapper). Cached for the process lifetime; None if not found."""
    global _FIREFOX_CACHE
    if _FIREFOX_CACHE != "?":
        return _FIREFOX_CACHE
    _FIREFOX_CACHE = None
    if os.name == "nt":
        try:
            procs = _proc_snapshot()
            pid = os.getpid()
            for _ in range(8):
                info = procs.get(pid)
                if not info:
                    break
                name, ppid = info
                if name == "firefox.exe":
                    _FIREFOX_CACHE = _pid_exe_path(pid) or None
                    break
                pid = ppid
        except Exception:
            _FIREFOX_CACHE = None
    return _FIREFOX_CACHE


def _variant_key():
    p = (launching_firefox() or "").lower()
    if "nightly" in p:
        return "nightly"
    if "developer" in p or "aurora" in p:
        return "dev"
    if p.endswith("firefox.exe"):
        return "release"
    return "default"


def find_firefox():
    """Locate a firefox.exe — prefers the one that launched us, then registry,
    then common install dirs (including Developer Edition)."""
    if os.name == "nt":
        ff = launching_firefox()
        if ff and os.path.isfile(ff):
            return ff
    if os.name != "nt":
        return shutil.which("firefox")
    # App Paths registry
    try:
        import winreg
        for root in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            try:
                k = winreg.OpenKey(root, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe")
                val, _ = winreg.QueryValueEx(k, None)
                if val and os.path.isfile(val):
                    return val
            except Exception:
                pass
    except Exception:
        pass
    for p in [
        r"C:\Program Files\Firefox Developer Edition\firefox.exe",
        r"C:\Program Files\Mozilla Firefox\firefox.exe",
        r"C:\Program Files (x86)\Mozilla Firefox\firefox.exe",
        r"C:\Program Files (x86)\Firefox Developer Edition\firefox.exe",
    ]:
        if os.path.isfile(p):
            return p
    return None


def find_profile():
    """Best-effort: the Firefox profile directory in use (from profiles.ini)."""
    base = os.path.join(os.environ.get("APPDATA", ""), "Mozilla", "Firefox")
    ini = os.path.join(base, "profiles.ini")
    if not os.path.isfile(ini):
        return None
    cp = configparser.ConfigParser()
    try:
        cp.read(ini)
    except Exception:
        return None

    def resolve(path, is_rel):
        return os.path.join(base, path) if str(is_rel) == "1" else path

    # Prefer an [InstallXXChecksum] Default (the profile the last-used install opened).
    for sec in cp.sections():
        if sec.startswith("Install") and cp.has_option(sec, "Default"):
            d = cp.get(sec, "Default")
            cand = os.path.join(base, d)
            if os.path.isdir(cand):
                return cand
    # Else a [ProfileN] with Default=1, else the first profile.
    first = None
    for sec in cp.sections():
        if sec.startswith("Profile") and cp.has_option(sec, "Path"):
            p = resolve(cp.get(sec, "Path"), cp.get(sec, "IsRelative", fallback="1"))
            if first is None:
                first = p
            if cp.get(sec, "Default", fallback="0") == "1":
                return p
    return first
