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
    {"cmd":"pickFolder","reqId":R,"dir":D?}           # native folder picker (settings)
    {"cmd":"open","path":P}        # open a saved file with the OS default app
    {"cmd":"update","extDir":D,"zipDir":D?,"profileDir":D?}  # self-update from a packaged zip
    {"cmd":"watch","enable":bool,"extDir":D?,"zipDir":D?}    # auto-install when a package appears
    {"cmd":"checkGithub","auto":bool?,"extDir":D?,"zipDir":D?}  # pull the latest GitHub release
    {"cmd":"discard","id":N}       # delete temp file
  host -> extension:
    {"type":"pong","ffmpeg":bool,"ffmpegPath":str,"version":str}
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
import sys, os, json, struct, subprocess, threading, tempfile, shutil, time, re

VERSION = "1.4.8"

# ---- stdio (bound in init_io so importing this module has no side effects) ----
IN = None
OUT = None
_write_lock = threading.Lock()


def init_io():
    """Bind fd 0/1 in binary mode. Works under pythonw where sys.stdin is None."""
    global IN, OUT
    if os.name == "nt":
        import msvcrt
        msvcrt.setmode(0, os.O_BINARY)
        msvcrt.setmode(1, os.O_BINARY)
    IN = os.fdopen(0, "rb", 0)
    OUT = os.fdopen(1, "wb", 0)


def send(msg):
    data = json.dumps(msg).encode("utf-8")
    with _write_lock:
        OUT.write(struct.pack("@I", len(data)))
        OUT.write(data)
        OUT.flush()


def read_message():
    raw = IN.read(4)
    if len(raw) < 4:
        return None
    (length,) = struct.unpack("@I", raw)
    if length == 0:
        return {}
    data = IN.read(length)
    if len(data) < length:
        return None
    return json.loads(data.decode("utf-8"))


# ---- tool discovery ----
HERE = os.path.dirname(os.path.abspath(__file__))


def find_ffmpeg():
    exe = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    local = os.path.join(HERE, exe)
    if os.path.isfile(local):
        return local
    return shutil.which("ffmpeg")


FFMPEG = find_ffmpeg()
TMPDIR = os.path.join(tempfile.gettempdir(), "media-catcher")
os.makedirs(TMPDIR, exist_ok=True)


def downloads_dir():
    d = os.path.join(os.path.expanduser("~"), "Downloads")
    return d if os.path.isdir(d) else os.path.expanduser("~")


def sanitize(name):
    name = re.sub(r'[\\/:*?"<>|]+', "_", name or "recording").strip()
    return (name[:120] or "recording")


# ---- self-update ----------------------------------------------------------
# The extension's gecko id — the persistent XPI must be named <id>.xpi.
EXT_ID = "{27383706-fb43-40dc-9e94-d2578818bd6a}"
import zipfile, glob, configparser, concurrent.futures

# Config is keyed per Firefox variant (Developer / Nightly / release) so several
# Firefoxes sharing one native-host registration don't clobber each other's
# settings. _variant_key() lives with the process-tree helpers below.
def _config_path():
    return os.path.join(HERE, "mc_config_%s.json" % _variant_key())


def load_config():
    try:
        with open(_config_path(), "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_config(cfg):
    try:
        with open(_config_path(), "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
    except Exception:
        pass


# ---- diagnostics: structured logging + durable update history ------------
# Everything the Settings "Log console" and "Update history" panels show comes
# from here. _hlog streams a line to the extension (live console) and appends to
# a rolling file; _log_event records a durable history entry (what changed, when,
# from where, and how it turned out) so a FAILED update explains itself instead of
# vanishing silently — the gap that let the guardian bug hide for so long.
_HOST_LOG = os.path.join(TMPDIR, "host.log")
_HISTORY_PATH = os.path.join(HERE, "update-history.jsonl")
_log_lock = threading.Lock()
_last_avail = None   # last extension version we recorded as 'update-available' (dedup)


def _now_ms():
    return int(time.time() * 1000)


def _hlog(level, msg, src="host"):
    """Emit one structured log line: to the extension for the live console, and to
    a rolling on-disk file for after-the-fact inspection. Never raises."""
    try:
        send({"type": "log", "ts": _now_ms(), "level": level, "src": src, "msg": str(msg)})
    except Exception:
        pass
    try:
        with _log_lock:
            if os.path.exists(_HOST_LOG) and os.path.getsize(_HOST_LOG) > 512 * 1024:
                # keep the last ~half when it grows past 512 KB
                try:
                    with open(_HOST_LOG, "r", encoding="utf-8", errors="replace") as f:
                        tail = f.readlines()[-1500:]
                    with open(_HOST_LOG, "w", encoding="utf-8") as f:
                        f.writelines(tail)
                except Exception:
                    pass
            with open(_HOST_LOG, "a", encoding="utf-8") as f:
                f.write("%s  [%s/%s] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), src, level, msg))
    except Exception:
        pass


def _log_event(component, outcome, frm=None, to=None, source=None, detail=None):
    """Record a durable update-history entry and mirror it to the live console."""
    rec = {"ts": _now_ms(), "component": component, "outcome": outcome,
           "from": frm, "to": to, "source": source, "detail": detail}
    try:
        with _log_lock:
            # Cap growth (repeated 'update-available' checks would otherwise append forever).
            if os.path.exists(_HISTORY_PATH) and os.path.getsize(_HISTORY_PATH) > 256 * 1024:
                try:
                    with open(_HISTORY_PATH, "r", encoding="utf-8", errors="replace") as f:
                        tail = f.readlines()[-1500:]
                    with open(_HISTORY_PATH, "w", encoding="utf-8") as f:
                        f.writelines(tail)
                except Exception:
                    pass
            with open(_HISTORY_PATH, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec) + "\n")
    except Exception:
        pass
    try:
        send({"type": "update-event", "event": rec})
    except Exception:
        pass
    bad = outcome in ("verify-failed", "reverted", "error", "guardian-did-not-run")
    arrow = (" %s→%s" % (frm or "?", to or "?")) if (frm or to) else ""
    _hlog("error" if bad else "info",
          "update: %s %s%s%s%s" % (component, outcome, arrow,
                                   (" via %s" % source) if source else "",
                                   (" — %s" % detail) if detail else ""))


def _read_history(limit=200):
    out = []
    try:
        with open(_HISTORY_PATH, "r", encoding="utf-8") as f:
            for ln in f:
                ln = ln.strip()
                if ln:
                    try:
                        out.append(json.loads(ln))
                    except Exception:
                        pass
    except Exception:
        pass
    return out[-limit:]


def _backup_root():
    return os.path.join(tempfile.gettempdir(), "media-catcher-backups")


def _guardian_log_tail(lines=150):
    try:
        with open(os.path.join(_backup_root(), "guardian.log"), "r", encoding="utf-8-sig", errors="replace") as f:
            return "".join(f.readlines()[-lines:])
    except Exception:
        return ""


def _is_elevated():
    try:
        import ctypes   # imported lazily like every other ctypes use in this module
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def _update_env():
    """A snapshot of everything the update path depends on — the things that, when
    wrong, silently break auto-update. Surfaced in Settings so failures are legible."""
    guardian = os.path.join(HERE, "guardian.ps1")
    def _which(n):
        try:
            return shutil.which(n) or ""
        except Exception:
            return ""
    return {
        "hostVersion": VERSION,
        "hostDir": HERE,
        "configVariant": _variant_key(),
        "python": sys.executable,
        "consolePython": _console_python(),
        "runningPythonw": (sys.executable or "").lower().endswith("pythonw.exe"),
        "powershell": _which("powershell"),
        "firefox": find_firefox() or "",
        "guardianPresent": os.path.isfile(guardian),
        "hostDirWritable": bool(os.access(HERE, os.W_OK)),
        "backupRoot": _backup_root(),
        "guardianLogExists": os.path.exists(os.path.join(_backup_root(), "guardian.log")),
        "elevated": _is_elevated(),
        "ffmpeg": FFMPEG or "",
    }


def _apply_comps(apply_ext, apply_host, plan):
    """The (component, from, to) tuples for each package actually being applied, so a
    combined extension+host update records BOTH transitions in history — not just one."""
    comps = []
    if apply_host:
        comps.append(("host", plan.get("host_from"), plan.get("host_to")))
    if apply_ext:
        comps.append(("extension", plan.get("ext_from"), plan.get("ext_to")))
    return comps


def _watch_guardian_outcome(apply_ext, apply_host, plan, source, base_size):
    """After the guardian is spawned, tail its log to learn what ACTUALLY happened —
    streaming each line to the console and recording a final history entry. Crucially,
    if the guardian writes nothing at all, that's detected and reported ('did-not-run')
    instead of failing silently — the precise blind spot that hid the spawn bug."""
    logf = os.path.join(_backup_root(), "guardian.log")

    def worker():
        start = time.time()
        pos = base_size
        seen = False
        outcome = None
        detail = None
        while time.time() - start < 120:
            time.sleep(1.0)
            if not os.path.exists(logf):
                continue
            try:
                with open(logf, "r", encoding="utf-8-sig", errors="replace") as f:
                    f.seek(pos)
                    chunk = f.read()
                    pos = f.tell()
            except Exception:
                continue
            for ln in chunk.splitlines():
                ln = ln.strip()
                if not ln:
                    continue
                seen = True
                low = ln.lower()
                lvl = "error" if ("fail" in low or "fatal" in low or "error" in low) else "info"
                _hlog(lvl, ln, src="guardian")
                if "verify ok" in low:
                    outcome, detail = "applied", None
                elif "verify failed" in low:
                    outcome = "verify-failed"
                    detail = ln.split("FAILED:", 1)[-1].strip() if "FAILED:" in ln else ln
                elif "reverted to previous" in low:
                    outcome = outcome or "reverted"
                elif "fatal" in low:
                    outcome, detail = "error", ln
            # 'verify-failed' must terminate too: the guardian reverts and then
            # restarts Firefox, which kills THIS host — so the outcome has to be
            # recorded within a second, before that teardown, or it's lost.
            if outcome in ("applied", "reverted", "verify-failed", "error"):
                break
        if not seen:
            final = "guardian-did-not-run"
            det = "guardian spawned but wrote no log in 120s — a spawn or environment problem"
        else:
            final, det = (outcome or "unknown"), detail
        # One entry per component actually applied (a combined update touches both).
        for comp, frm, to in _apply_comps(apply_ext, apply_host, plan):
            _log_event(comp, final, frm, to, source, det)

    threading.Thread(target=worker, daemon=True).start()


def _vtuple(s):
    return tuple(int(x) for x in re.findall(r"\d+", s or "0")[:4]) or (0,)


def _zip_manifest_version(zip_path):
    try:
        with zipfile.ZipFile(zip_path) as z:
            with z.open("manifest.json") as m:
                return json.loads(m.read().decode("utf-8")).get("version", "0")
    except Exception:
        return None


def _installed_version(ext_dir):
    try:
        with open(os.path.join(ext_dir, "manifest.json"), "r", encoding="utf-8") as f:
            return json.load(f).get("version", "0")
    except Exception:
        return None


import hashlib


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _installed_host_hash(host_dir):
    try:
        with open(os.path.join(host_dir, "mc_host.py"), "rb") as f:
            return _sha(f.read())
    except Exception:
        return None


def _host_zip_hash(zip_path):
    try:
        with zipfile.ZipFile(zip_path) as z:
            for n in z.namelist():
                if os.path.basename(n) == "mc_host.py":
                    return _sha(z.read(n))
    except Exception:
        pass
    return None


# The host carries its own VERSION constant, so host packages version-compare too.
def _parse_host_version(text):
    m = re.search(r'VERSION\s*=\s*["\']([\d.]+)["\']', text or "")
    return m.group(1) if m else None


def _host_zip_version(zip_path):
    try:
        with zipfile.ZipFile(zip_path) as z:
            for n in z.namelist():
                if os.path.basename(n) == "mc_host.py":
                    return _parse_host_version(z.read(n).decode("utf-8", "ignore"))
    except Exception:
        pass
    return None


def _installed_host_version(host_dir):
    try:
        with open(os.path.join(host_dir, "mc_host.py"), "r", encoding="utf-8") as f:
            return _parse_host_version(f.read())
    except Exception:
        return None


def _pkg_version(path, pattern):
    return _zip_manifest_version(path) if pattern.startswith("media_catcher") else _host_zip_version(path)


def _newest_zip(zip_dir, pattern):
    """Newest package by version (extension: manifest; host: VERSION), mtime tie-break."""
    best, best_v = None, None
    for c in glob.glob(os.path.join(zip_dir, pattern)):
        key = _vtuple(_pkg_version(c, pattern) or "0")
        if best is None or key > best_v or (key == best_v and os.path.getmtime(c) > os.path.getmtime(best)):
            best, best_v = c, key
    return best


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


def apply_update(plan, ext_dir, host_dir):
    """Apply only the parts that are newer. Returns {staged: bool}."""
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
            for n in z.namelist():
                if n.endswith("/"):
                    continue
                with z.open(n) as src, open(os.path.join(host_dir, os.path.basename(n)), "wb") as dst:
                    shutil.copyfileobj(src, dst)
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
# Pull new releases straight from GitHub Releases and drop the packages into
# the watched folder, where the same guardian flow installs and verifies them.
GITHUB_REPO = "g9xdev/mCatcher"
# The releases list — the API behind https://github.com/g9xdev/mCatcher/releases.
# Each tag keeps its assets under its own path (…/releases/download/<tag>/<file>),
# so the helper reads the whole list and drills down to the highest version
# rather than assuming a fixed URL or trusting a single "latest" endpoint.
GITHUB_RELEASES_URL = "https://api.github.com/repos/%s/releases?per_page=30" % GITHUB_REPO
_GITHUB_POLL_INTERVAL = 6 * 3600      # seconds between background checks
_github_poll_started = False


def _http_get(url, timeout=30):
    """GET a URL and return the raw bytes. GitHub rejects API calls without a
    User-Agent, so always send one."""
    import urllib.request
    r = urllib.request.Request(url, headers={
        "User-Agent": "MediaCatcher-Host/%s" % VERSION,
        "Accept": "application/vnd.github+json",
    })
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return resp.read()


def _tag_to_version(tag):
    tag = (tag or "").strip()
    return tag[1:] if tag[:1] in ("v", "V") else tag


def github_latest_release():
    """Scan the releases list and return (version, {asset_name: url}) for the
    highest-versioned published release. Draft and pre-release tags are skipped.
    Returns (None, {}) when there is no usable release or GitHub can't be reached.

    GitHub stores each tag's assets under its own version path, so we read the
    list and pick the newest by version number — the download URLs the API hands
    back already point into the right per-version path, so nothing is hardcoded."""
    try:
        releases = json.loads(_http_get(GITHUB_RELEASES_URL).decode("utf-8", "ignore"))
    except Exception:
        return None, {}
    if not isinstance(releases, list):
        return None, {}
    best, best_vt, best_ver = None, None, None
    for rel in releases:
        if rel.get("draft") or rel.get("prerelease"):
            continue
        ver = _tag_to_version(rel.get("tag_name"))
        if not ver:
            continue
        vt = _vtuple(ver)
        if best is None or vt > best_vt:
            best, best_vt, best_ver = rel, vt, ver
    if best is None:
        return None, {}
    assets = {a.get("name"): a.get("browser_download_url")
              for a in (best.get("assets") or [])
              if a.get("name") and a.get("browser_download_url")}
    return best_ver, assets


def _download(url, dest):
    """Download url to dest atomically via a .part temp file."""
    tmp = dest + ".part"
    with open(tmp, "wb") as f:
        f.write(_http_get(url))
    os.replace(tmp, dest)


def github_stage_release(cfg, force=False, ext_version=None):
    """If the latest GitHub release is newer than what's installed, download its
    extension/host packages into the watched folder. Returns a status dict and
    never raises."""
    ext_dir = cfg.get("extDir")
    zip_dir = cfg.get("zipDir") or downloads_dir()
    version, assets = github_latest_release()
    if not version:
        return {"reached": False}
    # Prefer the extension's own reported version (works for signed installs with
    # no source folder); fall back to reading a source folder's manifest.
    ext_from = ext_version or (_installed_version(ext_dir) if ext_dir else None)
    newer = ((not ext_from or _vtuple(version) > _vtuple(ext_from))
             or _vtuple(version) > _vtuple(VERSION))
    if not (newer or force):
        return {"reached": True, "latest": version, "newer": False, "downloaded": []}
    got = []
    try:
        os.makedirs(zip_dir, exist_ok=True)
        for name, url in assets.items():
            low = name.lower()
            if low.endswith(".zip") and (low.startswith("media_catcher")
                                         or low.startswith("media-catcher-host")):
                dest = os.path.join(zip_dir, name)
                if not os.path.exists(dest):
                    _download(url, dest)
                got.append(name)
    except Exception as e:
        return {"reached": True, "latest": version, "newer": True, "downloaded": got, "error": str(e)}
    return {"reached": True, "latest": version, "newer": True, "downloaded": got}


def handle_check_github(req):
    """Check GitHub for a newer release; download and install it if found.
    'auto' keeps quiet when already up to date (for background checks)."""
    def worker():
        cfg = load_config()
        if req.get("extDir"):
            cfg["extDir"] = req["extDir"]
        if req.get("zipDir"):
            cfg["zipDir"] = req["zipDir"]
        save_config(cfg)
        auto = bool(req.get("auto"))
        _hlog("info", "checking GitHub for updates%s…" % (" (auto)" if auto else ""))
        status = github_stage_release(cfg, force=bool(req.get("force")), ext_version=req.get("extVersion"))
        send({"type": "github-update", **status})
        if not status.get("reached"):
            _hlog("warn", "couldn't reach GitHub to check for updates")
            if not auto:
                _info("Media Catcher", "Couldn't reach GitHub to check for updates.")
            return
        if not status.get("newer"):
            _hlog("info", "GitHub: already on the latest release (v%s)" % (status.get("latest") or "?"))
            if not auto:
                _info("Media Catcher", "You're on the latest release (v%s)." % (status.get("latest") or "?"))
            return
        _hlog("info", "GitHub has v%s — staged %s" % (status.get("latest") or "?",
              ", ".join(status.get("downloaded") or []) or "nothing new"))
        # Newer packages are staged in the watched folder — install them now.
        # _install_updates is single-flight, so the folder-watcher firing on the
        # same downloads can't double-prompt.
        _install_updates(cfg.get("extDir"), cfg.get("zipDir") or downloads_dir(), silent=auto, source="github")
    threading.Thread(target=worker, daemon=True).start()


def _github_poll_loop():
    time.sleep(90)   # let startup settle before the first check
    while True:
        try:
            cfg = load_config()
            if cfg.get("autoUpdate"):
                status = github_stage_release(cfg)
                if status.get("newer") and status.get("downloaded"):
                    send({"type": "github-update", **status})
        except Exception:
            pass
        time.sleep(_GITHUB_POLL_INTERVAL)


def start_github_poll():
    """Start the background GitHub poll once (idempotent)."""
    global _github_poll_started
    if _github_poll_started:
        return
    _github_poll_started = True
    threading.Thread(target=_github_poll_loop, daemon=True).start()


_update_lock = threading.Lock()


def _install_updates(ext_dir, zip_dir, silent=False, source="manual"):
    """Install whatever in zip_dir is newer than what's installed.

    The host updates regardless of the extension folder. The extension is only
    overwritten when we actually have its source folder — a signed add-on lives in
    the Firefox profile and only Firefox can update it, so we never touch it. When a
    newer extension exists that we can't apply, we tell the extension so it can point
    the user at the download. Single-flight: the folder-watcher and an explicit check
    can't both prompt at once. Every branch records to the update history/console."""
    if not _update_lock.acquire(blocking=False):
        return
    try:
        have_ext = bool(ext_dir and os.path.isdir(ext_dir))
        plan = plan_update(ext_dir if have_ext else "", HERE, zip_dir)
        # Only overwrite the extension folder if it is ACTUALLY an extension source
        # (has a manifest). Guards against a mis-set folder like C:\Code getting an
        # extension unpacked into it.
        apply_ext = bool(plan["ext_newer"] and have_ext and plan["ext_from"])
        apply_host = bool(plan["host_newer"])
        _hlog("info", "update check (%s): extension %s→%s, helper %s→%s" % (
            source, plan["ext_from"] or "?", plan["ext_to"] or "?",
            plan["host_from"] or "?", plan["host_to"] or "?"))

        # Content-hash fallback: a same-version host package whose code changed.
        if plan["host_same_ver_changed"] and not apply_host:
            if _yesno("Media Catcher — content change detected",
                      "A helper package with the SAME version (v%s) but DIFFERENT code was found.\n\n"
                      "The version number wasn't bumped, yet the contents changed. Install it anyway?"
                      % (plan["host_to"] or "?")):
                apply_host = True

        if apply_ext or apply_host:
            comps = _apply_comps(apply_ext, apply_host, plan)
            summary = plan_summary(plan) or ("helper v%s (content change)" % plan["host_to"] if apply_host else "update")
            if not _yesno("Media Catcher — update ready",
                          "About to install: %s\n\nThe reliability guardian will back up your current "
                          "version, apply the update, verify it, and restart Firefox — reverting "
                          "automatically if anything fails.\n\nProceed?" % summary):
                for c, f, t in comps:
                    _log_event(c, "deferred", f, t, source, "user chose not to install now")
                send({"type": "update-result", "ok": True, "available": True, "deferred": True, "summary": summary})
                return
            logf = os.path.join(_backup_root(), "guardian.log")
            base = os.path.getsize(logf) if os.path.exists(logf) else 0
            _hlog("info", "handing off to guardian: %s" % summary)
            mode = launch_guardian(apply_ext, apply_host, plan, ext_dir if have_ext else "", HERE, restart=True)
            send({"type": "update-result", "ok": True, "available": True, "summary": summary, "mode": mode})
            if mode == "guardian":
                _watch_guardian_outcome(apply_ext, apply_host, plan, source, base)
            elif mode == "fallback":
                for c, f, t in comps:
                    _log_event(c, "applied", f, t, source, "in-process apply (guardian script absent)")
            elif mode == "error":
                for c, f, t in comps:
                    _log_event(c, "error", f, t, source, "couldn't start the guardian process")
                _info("Media Catcher", "Couldn't start the update guardian.")
            return

        # Nothing the guardian can install. A newer *extension* may still exist that
        # only Firefox can install (signed add-on, no source folder) — surface it.
        if plan["ext_newer"] and not apply_ext and plan["ext_to"]:
            # Record the durable history row once per version — repeated checks would
            # otherwise append the same 'update-available' line on every poll.
            global _last_avail
            if plan["ext_to"] != _last_avail:
                _last_avail = plan["ext_to"]
                _log_event("extension", "update-available", plan["ext_from"], plan["ext_to"], source,
                           "signed add-on — Firefox installs it (or install the .xpi)")
            else:
                _hlog("info", "extension v%s available (signed add-on — install via Firefox)" % plan["ext_to"])
            send({"type": "ext-update-available", "version": plan["ext_to"]})
            if not silent:
                _info("Media Catcher — update available",
                      "Media Catcher v%s is available.\n\nThe extension is a signed add-on, so it "
                      "updates through Firefox — install the signed .xpi from the Releases page, or it "
                      "will auto-update on Firefox's next check." % plan["ext_to"])
            return
        _hlog("info", "up to date (extension v%s, helper v%s)" % (plan["ext_from"] or "?", plan["host_from"] or "?"))
        send({"type": "update-result", "ok": True, "available": False, "version": plan["ext_from"]})
        if not silent:
            _info("Media Catcher", "You're up to date (extension v%s, helper v%s)." %
                  (plan["ext_from"] or "?", plan["host_from"] or "?"))
    finally:
        _update_lock.release()


def handle_update(req):
    """'Check & install update' from the extension: persist paths, then install
    whatever is newer (host always; extension only for a source install)."""
    def worker():
        cfg = load_config()
        ext_dir = req.get("extDir") or cfg.get("extDir")
        zip_dir = req.get("zipDir") or cfg.get("zipDir") or downloads_dir()
        if ext_dir and os.path.isdir(ext_dir):
            cfg["extDir"] = ext_dir
        cfg["zipDir"] = zip_dir
        save_config(cfg)
        _install_updates(ext_dir, zip_dir, silent=bool(req.get("silent")), source="manual")
    threading.Thread(target=worker, daemon=True).start()


def handle_get_report(req):
    """Answer the Settings 'diagnostics' request: the environment the update path
    depends on, the durable update history, and a tail of the guardian log. Also
    narrates the key facts to the live console so a glance tells the story."""
    env = _update_env()
    send({"type": "report", "reqId": req.get("reqId"), "host": VERSION,
          "env": env, "history": _read_history(200), "guardianTail": _guardian_log_tail(150)})
    _hlog("info", "diagnostics: host v%s (%s) · powershell=%s · guardian.ps1=%s · Firefox=%s · guardian.log=%s" % (
        VERSION, "pythonw" if env["runningPythonw"] else "python",
        "ok" if env["powershell"] else "MISSING",
        "ok" if env["guardianPresent"] else "MISSING",
        "found" if env["firefox"] else "not found",
        "present" if env["guardianLogExists"] else "never written"))


# ---- auto-update watcher (event-driven, no polling) -----------------------
# Registers interest in the package folder via ReadDirectoryChangesW; the OS
# wakes us only when files change, so nothing polls.
_WATCH = {"stop": None, "dir": None}


def _parse_notify(data):
    """Decode FILE_NOTIFY_INFORMATION records into a list of file names."""
    names, off = [], 0
    while off + 12 <= len(data):
        next_off = int.from_bytes(data[off:off + 4], "little")
        name_len = int.from_bytes(data[off + 8:off + 12], "little")
        names.append(data[off + 12:off + 12 + name_len].decode("utf-16-le", "ignore"))
        if next_off == 0:
            break
        off += next_off
    return names


def _dir_watcher(path, stop_event, on_relevant):
    import ctypes
    from ctypes import wintypes
    k32 = ctypes.windll.kernel32
    k32.CreateFileW.restype = wintypes.HANDLE
    k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    FILE_LIST_DIRECTORY = 1
    SHARE = 1 | 2 | 4
    OPEN_EXISTING = 3
    BACKUP = 0x02000000
    FLAGS = 0x1 | 0x8 | 0x10  # FILE_NAME | SIZE | LAST_WRITE
    h = k32.CreateFileW(path, FILE_LIST_DIRECTORY, SHARE, None, OPEN_EXISTING, BACKUP, None)
    invalid = ctypes.c_void_p(-1).value
    if not h or h == invalid:
        return
    buf = ctypes.create_string_buffer(16384)
    nbytes = wintypes.DWORD()
    try:
        while not stop_event.is_set():
            ok = k32.ReadDirectoryChangesW(h, buf, len(buf), False, FLAGS, ctypes.byref(nbytes), None, None)
            if not ok or stop_event.is_set():
                break
            for name in _parse_notify(buf.raw[:nbytes.value]):
                low = name.lower()
                # Match BOTH the extension (media_catcher*.zip) and host
                # (media-catcher-host*.zip) packages so the debounce settles
                # only after the last of the two has finished landing.
                if low.endswith(".zip") and (low.startswith("media_catcher") or low.startswith("media-catcher")):
                    on_relevant()
                    break
    finally:
        try: k32.CloseHandle(h)
        except Exception: pass


def _auto_update_check():
    cfg = load_config()
    _install_updates(cfg.get("extDir"), cfg.get("zipDir") or downloads_dir(), silent=False, source="watcher")


def start_watch(zip_dir):
    stop_watch()
    if os.name != "nt" or not zip_dir or not os.path.isdir(zip_dir):
        return
    ev = threading.Event()
    debounce = {"timer": None}

    def on_relevant():
        # Settle window: each matching write resets it, so a short gap between
        # the extension and host zips is absorbed before we act.
        if debounce["timer"]:
            debounce["timer"].cancel()
        debounce["timer"] = threading.Timer(3.0, _auto_update_check)
        debounce["timer"].daemon = True
        debounce["timer"].start()

    _WATCH["stop"] = ev
    _WATCH["dir"] = zip_dir
    threading.Thread(target=_dir_watcher, args=(zip_dir, ev, on_relevant), daemon=True).start()


def stop_watch():
    if _WATCH["stop"]:
        _WATCH["stop"].set()   # takes effect on the next change (then the thread exits)
    _WATCH["stop"] = None
    _WATCH["dir"] = None


def handle_watch(req):
    cfg = load_config()
    if req.get("extDir"):
        cfg["extDir"] = req["extDir"]
    if req.get("zipDir"):
        cfg["zipDir"] = req["zipDir"]
    enable = bool(req.get("enable"))
    cfg["autoUpdate"] = enable
    save_config(cfg)
    zdir = cfg.get("zipDir") or downloads_dir()
    if enable and os.name == "nt":
        start_watch(zdir)
        start_github_poll()
        send({"type": "watch", "enabled": True, "dir": zdir})
    else:
        stop_watch()
        send({"type": "watch", "enabled": False})


# ---- jobs ----
class Job:
    def __init__(self, id, temp):
        self.id = id
        self.temp = temp
        self.proc = None
        self.base = "recording"
        self.bytes = 0
        self.seconds = 0.0
        self.partial = None          # last "save now" snapshot path, if any
        self.finished = threading.Event()


JOBS = {}
JOBS_LOCK = threading.Lock()


def ffmpeg_cmd(job, req):
    headers = ""
    if req.get("referer"):
        headers += "Referer: %s\r\n" % req["referer"]
    if req.get("userAgent"):
        headers += "User-Agent: %s\r\n" % req["userAgent"]

    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error",
           "-progress", "pipe:1", "-nostats", "-y"]
    if headers:
        cmd += ["-headers", headers]
    cmd += ["-i", req["videoUrl"]]
    audio = req.get("audioUrl")
    if audio:
        if headers:
            cmd += ["-headers", headers]
        cmd += ["-i", audio, "-map", "0:v:0", "-map", "1:a:0"]
    # Fragmented mp4: playable even if interrupted, finalized cleanly on 'q'.
    cmd += ["-c", "copy",
            "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
            job.temp]
    return cmd


def run_job(job, req):
    cmd = ffmpeg_cmd(job, req)
    # Hide ffmpeg's console window — the host runs windowless (pythonw), so each
    # ffmpeg child would otherwise pop its own console. Graceful stop uses a 'q'
    # on stdin, so we don't need a separate process group.
    creationflags = 0
    startupinfo = None
    if os.name == "nt":
        creationflags = subprocess.CREATE_NO_WINDOW
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = 0  # SW_HIDE
    try:
        job.proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, creationflags=creationflags, startupinfo=startupinfo)
    except Exception as e:
        send({"type": "error", "id": job.id, "error": "ffmpeg failed to start: %s" % e})
        job.finished.set()
        return
    send({"type": "started", "id": job.id})

    # Parse ffmpeg -progress key=value lines from stdout.
    for line in job.proc.stdout:
        try:
            s = line.decode("utf-8", "replace").strip()
        except Exception:
            continue
        if s.startswith("total_size="):
            v = s.split("=", 1)[1]
            if v.isdigit():
                job.bytes = int(v)
        elif s.startswith("out_time_ms="):
            v = s.split("=", 1)[1]
            if v.lstrip("-").isdigit():
                job.seconds = max(0.0, int(v) / 1_000_000.0)
                send({"type": "progress", "id": job.id, "bytes": job.bytes, "seconds": round(job.seconds, 1)})

    job.proc.wait()
    try:
        if os.path.isfile(job.temp):
            job.bytes = os.path.getsize(job.temp)
    except Exception:
        pass
    job.finished.set()
    send({"type": "stopped", "id": job.id, "file": job.temp,
          "bytes": job.bytes, "seconds": round(job.seconds, 1)})


def handle_record(req):
    if not FFMPEG:
        send({"type": "error", "id": req.get("id"), "error": "ffmpeg not found. Re-run the installer or put ffmpeg.exe next to the helper."})
        return
    jid = req.get("id")
    temp = os.path.join(TMPDIR, "mc_%s.mp4" % jid)
    job = Job(jid, temp)
    job.base = sanitize(req.get("base"))
    with JOBS_LOCK:
        JOBS[jid] = job
    threading.Thread(target=run_job, args=(job, req), daemon=True).start()


def handle_stop(req):
    jid = req.get("id")
    with JOBS_LOCK:
        job = JOBS.get(jid)
    if not job or not job.proc:
        return
    # Graceful stop: 'q' on ffmpeg's stdin -> finalize the file cleanly.
    try:
        job.proc.stdin.write(b"q")
        job.proc.stdin.flush()
    except Exception:
        try:
            job.proc.terminate()
        except Exception:
            pass


def _copy_prefix(src, dst):
    """Copy the first os.path.getsize(src) bytes — a clean prefix even while the
    source keeps growing. Fragmented mp4 stays playable up to the last whole
    fragment, so a trailing partial fragment is harmless."""
    size = os.path.getsize(src)
    with open(src, "rb") as f, open(dst, "wb") as g:
        remaining = size
        while remaining > 0:
            chunk = f.read(min(1024 * 1024, remaining))
            if not chunk:
                break
            g.write(chunk)
            remaining -= len(chunk)


def handle_snapshot(req):
    """Save what's recorded so far WITHOUT stopping — a crash-safety checkpoint."""
    jid = req.get("id")
    with JOBS_LOCK:
        job = JOBS.get(jid)
    if not job or not os.path.isfile(job.temp) or os.path.getsize(job.temp) == 0:
        send({"type": "error", "id": jid, "error": "nothing recorded yet"})
        return
    base = sanitize(req.get("base") or job.base)
    d = req.get("dir") or downloads_dir()
    if not os.path.isdir(d):
        d = downloads_dir()
    dest = os.path.join(d, base + " (partial).mp4")
    try:
        _copy_prefix(job.temp, dest)      # overwrites the previous partial (latest is fullest)
        job.partial = dest
        send({"type": "snapshot", "id": jid, "file": dest, "bytes": os.path.getsize(dest),
              "seconds": round(job.seconds, 1)})
    except Exception as e:
        send({"type": "error", "id": jid, "error": "save-now failed: %s" % e})


def _dedup(dest):
    root, ext = os.path.splitext(dest)
    n = 1
    while os.path.exists(dest):
        dest = "%s (%d)%s" % (root, n, ext)
        n += 1
    return dest


# ---- optional H.265 (HEVC) conversion ----------------------------------------
# Recordings are stream-copied H.264. If the user turns on H.265 conversion, we
# re-encode the finished file to HEVC (which is ~40-50% smaller at the same
# visual quality) and delete the H.264 original. This runs AFTER the recording is
# finalized, so recording itself stays a fast, reliable stream copy.

_HEVC_ENC = None  # cached probe result

def _no_window():
    """(creationflags, startupinfo) that hide a child console on Windows."""
    if os.name != "nt":
        return 0, None
    si = subprocess.STARTUPINFO()
    si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    si.wShowWindow = 0
    return subprocess.CREATE_NO_WINDOW, si

_ENC_CACHE = {}   # codec -> hardware encoder name (or None), probed once


def find_encoder(codec, prefer="auto"):
    """Pick an encoder for the target codec. prefer: 'auto' (hardware if present,
    else software), 'gpu' (hardware only; None if absent), 'cpu' (software)."""
    sw = {"h265": "libx265", "av1": "libsvtav1"}.get(codec, "libx265")
    if prefer == "cpu":
        return sw
    if codec not in _ENC_CACHE:
        hw = None
        if FFMPEG:
            try:
                cf, si = _no_window()
                out = subprocess.run([FFMPEG, "-hide_banner", "-encoders"],
                                     capture_output=True, text=True, timeout=15,
                                     creationflags=cf, startupinfo=si).stdout
                cands = {"h265": ("hevc_nvenc", "hevc_qsv", "hevc_amf"),
                         "av1": ("av1_nvenc", "av1_qsv", "av1_amf")}.get(codec, ())
                for enc in cands:
                    if enc in out:
                        hw = enc
                        break
            except Exception:
                hw = None
        _ENC_CACHE[codec] = hw
    hw = _ENC_CACHE[codec]
    if prefer == "gpu":
        return hw
    return hw or sw

def _codec_args(codec, encoder, quality):
    """ffmpeg -c:v args for the chosen encoder + quality. 'visually-lossless' is
    transparent (indistinguishable in normal viewing) yet smaller; 'balanced'
    trades a little quality for a smaller file; 'true-lossless' (H.265 only) is
    bit-exact and forces software x265."""
    if codec == "av1":
        q = {"visually-lossless": 30, "balanced": 38}.get(quality, 30)
        if encoder == "av1_nvenc":
            return ["-c:v", "av1_nvenc", "-preset", "p6", "-rc", "constqp", "-qp", str(q)]
        if encoder == "av1_qsv":
            return ["-c:v", "av1_qsv", "-global_quality", str(q)]
        if encoder == "av1_amf":
            return ["-c:v", "av1_amf", "-rc", "cqp", "-qp_i", str(q), "-qp_p", str(q)]
        return ["-c:v", "libsvtav1", "-crf", str(q), "-preset", "6"]
    q = {"visually-lossless": 18, "balanced": 24}.get(quality, 18)
    if quality == "true-lossless":
        return ["-c:v", "libx265", "-x265-params", "lossless=1", "-preset", "medium"]
    if encoder == "hevc_nvenc":
        return ["-c:v", "hevc_nvenc", "-preset", "p6", "-rc", "constqp", "-qp", str(q)]
    if encoder == "hevc_qsv":
        return ["-c:v", "hevc_qsv", "-global_quality", str(q)]
    if encoder == "hevc_amf":
        return ["-c:v", "hevc_amf", "-rc", "cqp", "-qp_i", str(q), "-qp_p", str(q)]
    return ["-c:v", "libx265", "-crf", str(q), "-preset", "slow"]

def transcode(src, codec="h265", quality="visually-lossless", prefer="auto"):
    """Re-encode src to codec ('h265'|'av1') and, if the result is smaller, replace
    src with it (deleting the original). The saved file is NEVER larger than the
    original: if the re-encode isn't smaller (common at a visually-lossless target
    on an already-compressed stream), it is discarded and src is kept untouched.
    Returns {path, converted, note, srcBytes, hevcBytes} (hevcBytes = new size)."""
    if not FFMPEG or not os.path.isfile(src) or codec not in ("h265", "av1"):
        return {"path": src, "converted": False, "note": "no ffmpeg", "srcBytes": None, "hevcBytes": None}
    src_bytes = os.path.getsize(src)
    encoder = find_encoder(codec, prefer)
    sw = {"h265": "libx265", "av1": "libsvtav1"}[codec]
    tag = "hvc1" if codec == "h265" else "av01"
    root, _ext = os.path.splitext(src)
    out = root + ".enc.mp4"

    def _rm(p):
        try:
            if os.path.exists(p): os.remove(p)
        except Exception:
            pass

    def run(enc):
        if not enc:
            return False
        cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-nostats", "-y",
               "-i", src] + _codec_args(codec, enc, quality) + \
              ["-tag:v", tag, "-c:a", "copy", "-movflags", "+faststart", out]
        cf, si = _no_window()
        try:
            r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               creationflags=cf, startupinfo=si)
            return r.returncode == 0 and os.path.isfile(out) and os.path.getsize(out) > 0
        except Exception:
            return False

    ok = run(encoder)
    if not ok and encoder != sw:     # HW encoder present but unusable -> software fallback
        _rm(out)
        ok = run(sw)
    if not ok:
        _rm(out)
        return {"path": src, "converted": False, "note": "encode failed - kept original",
                "srcBytes": src_bytes, "hevcBytes": None}

    new_bytes = os.path.getsize(out)
    if new_bytes >= src_bytes:        # never keep a file larger than the original
        _rm(out)
        return {"path": src, "converted": False, "note": "%s was not smaller - kept original" % codec.upper(),
                "srcBytes": src_bytes, "hevcBytes": new_bytes}

    try:
        os.remove(src)              # delete the original
        os.replace(out, src)        # keep the original .mp4 name/path, now re-encoded
        return {"path": src, "converted": True, "note": None, "srcBytes": src_bytes, "hevcBytes": new_bytes}
    except Exception:
        return {"path": out, "converted": True, "note": None, "srcBytes": src_bytes, "hevcBytes": new_bytes}


def _finalize_move(job, jid, dest, req=None):
    try:
        shutil.move(job.temp, dest)
    except Exception as e:
        send({"type": "error", "id": jid, "error": "save failed: %s" % e})
        return
    # The full recording supersedes any (partial) checkpoint we wrote.
    if job.partial and os.path.isfile(job.partial):
        try:
            os.remove(job.partial)
        except Exception:
            pass
    with JOBS_LOCK:
        JOBS.pop(jid, None)

    # Optional: convert the finished file to H.265 (kept only if it is smaller;
    # otherwise the H.264 original is kept, so the saved file is never larger).
    conv_info = None
    conv = (req or {}).get("convert")
    if conv and conv.get("codec") in ("h265", "av1"):
        codec = conv["codec"]
        send({"type": "converting", "id": jid, "file": dest, "codec": codec})
        res = transcode(dest, codec, conv.get("quality", "visually-lossless"), conv.get("encoder", "auto"))
        dest = res["path"]
        conv_info = {"converted": res["converted"], "note": res["note"], "codec": codec,
                     "srcBytes": res["srcBytes"], "hevcBytes": res["hevcBytes"],
                     "kept": codec if res["converted"] else "orig"}

    bytes_ = os.path.getsize(dest) if os.path.isfile(dest) else 0
    send({"type": "saved", "id": jid, "file": dest, "bytes": bytes_, "convert": conv_info})


def _ask_save_path(default_dir, default_name):
    """Native Win32 Save-As dialog (comdlg32, no tkinter). Returns "" on cancel."""
    try:
        import ctypes
        from ctypes import wintypes
        try: ctypes.windll.ole32.CoInitialize(None)
        except Exception: pass

        class OPENFILENAME(ctypes.Structure):
            _fields_ = [
                ("lStructSize", wintypes.DWORD), ("hwndOwner", wintypes.HWND),
                ("hInstance", wintypes.HINSTANCE), ("lpstrFilter", wintypes.LPCWSTR),
                ("lpstrCustomFilter", wintypes.LPWSTR), ("nMaxCustFilter", wintypes.DWORD),
                ("nFilterIndex", wintypes.DWORD), ("lpstrFile", wintypes.LPWSTR),
                ("nMaxFile", wintypes.DWORD), ("lpstrFileTitle", wintypes.LPWSTR),
                ("nMaxFileTitle", wintypes.DWORD), ("lpstrInitialDir", wintypes.LPCWSTR),
                ("lpstrTitle", wintypes.LPCWSTR), ("Flags", wintypes.DWORD),
                ("nFileOffset", wintypes.WORD), ("nFileExtension", wintypes.WORD),
                ("lpstrDefExt", wintypes.LPCWSTR), ("lCustData", ctypes.c_void_p),
                ("lpfnHook", ctypes.c_void_p), ("lpTemplateName", wintypes.LPCWSTR),
                ("pvReserved", ctypes.c_void_p), ("dwReserved", wintypes.DWORD),
                ("FlagsEx", wintypes.DWORD),
            ]
        buf = ctypes.create_unicode_buffer(4096)
        buf.value = default_name or "recording.mp4"
        flt = ctypes.create_unicode_buffer("MP4 video\0*.mp4\0All files\0*.*\0\0")
        ofn = OPENFILENAME()
        ofn.lStructSize = ctypes.sizeof(ofn)
        ofn.lpstrFile = ctypes.cast(buf, wintypes.LPWSTR)
        ofn.nMaxFile = 4096
        ofn.lpstrFilter = ctypes.cast(flt, wintypes.LPCWSTR)
        ofn.lpstrInitialDir = default_dir or None
        ofn.lpstrTitle = "Save recording as"
        ofn.lpstrDefExt = "mp4"
        # OVERWRITEPROMPT | NOCHANGEDIR | PATHMUSTEXIST | EXPLORER
        ofn.Flags = 0x2 | 0x8 | 0x800 | 0x80000
        if ctypes.windll.comdlg32.GetSaveFileNameW(ctypes.byref(ofn)):
            return buf.value
    except Exception:
        pass
    return ""


def _ask_folder(default_dir):
    """Native Win32 folder picker (shell32, no tkinter). Returns "" on cancel."""
    try:
        import ctypes
        from ctypes import wintypes
        try: ctypes.windll.ole32.CoInitialize(None)
        except Exception: pass

        class BROWSEINFO(ctypes.Structure):
            _fields_ = [
                ("hwndOwner", wintypes.HWND), ("pidlRoot", ctypes.c_void_p),
                ("pszDisplayName", wintypes.LPWSTR), ("lpszTitle", wintypes.LPCWSTR),
                ("ulFlags", wintypes.UINT), ("lpfn", ctypes.c_void_p),
                ("lParam", ctypes.c_void_p), ("iImage", ctypes.c_int),
            ]
        disp = ctypes.create_unicode_buffer(260)
        bi = BROWSEINFO()
        bi.pszDisplayName = ctypes.cast(disp, wintypes.LPWSTR)
        bi.lpszTitle = "Select a folder"
        bi.ulFlags = 0x1 | 0x40   # BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE
        shell32 = ctypes.windll.shell32
        shell32.SHBrowseForFolderW.restype = ctypes.c_void_p
        pidl = shell32.SHBrowseForFolderW(ctypes.byref(bi))
        if not pidl:
            return ""
        path = ctypes.create_unicode_buffer(260)
        shell32.SHGetPathFromIDListW(ctypes.c_void_p(pidl), path)
        try: ctypes.windll.ole32.CoTaskMemFree(ctypes.c_void_p(pidl))
        except Exception: pass
        return path.value or ""
    except Exception:
        pass
    return ""


def handle_save(req):
    """Auto-save into the configured folder (or Downloads) — no dialog."""
    jid = req.get("id")
    with JOBS_LOCK:
        job = JOBS.get(jid)
    if not job:
        send({"type": "error", "id": jid, "error": "unknown recording"})
        return

    def worker():
        job.finished.wait(timeout=30)
        if not os.path.isfile(job.temp):
            send({"type": "error", "id": jid, "error": "temp file missing"})
            return
        d = req.get("dir") or downloads_dir()
        if not os.path.isdir(d):
            d = downloads_dir()
        dest = _dedup(os.path.join(d, sanitize(req.get("base") or job.base) + ".mp4"))
        _finalize_move(job, jid, dest, req)
    threading.Thread(target=worker, daemon=True).start()


def handle_save_as(req):
    """Pop a native Save-As dialog so the user picks the path per file."""
    jid = req.get("id")
    with JOBS_LOCK:
        job = JOBS.get(jid)
    if not job:
        send({"type": "error", "id": jid, "error": "unknown recording"})
        return

    def worker():
        job.finished.wait(timeout=30)
        if not os.path.isfile(job.temp):
            send({"type": "error", "id": jid, "error": "temp file missing"})
            return
        default_dir = req.get("dir") or downloads_dir()
        name = sanitize(req.get("base") or job.base) + ".mp4"
        path = _ask_save_path(default_dir, name)
        if not path:
            send({"type": "save-cancelled", "id": jid})   # keep it cached to retry
            return
        _finalize_move(job, jid, path, req)
    threading.Thread(target=worker, daemon=True).start()


def handle_pick_folder(req):
    """Native folder picker for the settings page. Replies {type:folder,dir}."""
    def worker():
        d = _ask_folder(req.get("dir") or downloads_dir())
        send({"type": "folder", "reqId": req.get("reqId"), "dir": d or ""})
    threading.Thread(target=worker, daemon=True).start()


def handle_open(req):
    """Open a saved file with the OS default application (notification click)."""
    path = req.get("path")
    if not path or not os.path.isfile(path):
        send({"type": "error", "id": req.get("id"), "error": "file not found: %s" % path})
        return
    try:
        if os.name == "nt":
            os.startfile(path)               # noqa: default handler
        elif sys.platform == "darwin":
            subprocess.Popen(["open", path])
        else:
            subprocess.Popen(["xdg-open", path])
    except Exception as e:
        send({"type": "error", "error": "open failed: %s" % e})


def handle_discard(req):
    jid = req.get("id")
    with JOBS_LOCK:
        job = JOBS.pop(jid, None)
    if job:
        if job.proc and job.proc.poll() is None:
            try:
                job.proc.stdin.write(b"q"); job.proc.stdin.flush()
            except Exception:
                try: job.proc.terminate()
                except Exception: pass
            job.finished.wait(timeout=10)
        try:
            if os.path.isfile(job.temp):
                os.remove(job.temp)
        except Exception:
            pass
    send({"type": "discarded", "id": jid})


def main():
    init_io()
    _hlog("info", "host v%s connected — %s" % (VERSION, os.path.basename(sys.executable or "python")))
    # Resume watching the package folder if auto-update was left on.
    try:
        cfg = load_config()
        if cfg.get("autoUpdate") and cfg.get("extDir") and os.name == "nt":
            start_watch(cfg.get("zipDir") or downloads_dir())
            start_github_poll()
    except Exception:
        pass
    while True:
        try:
            msg = read_message()
        except Exception as e:
            send({"type": "error", "error": "read failed: %s" % e})
            break
        if msg is None:
            break
        cmd = msg.get("cmd")
        try:
            if cmd == "ping":
                send({"type": "pong", "ffmpeg": bool(FFMPEG), "ffmpegPath": FFMPEG or "", "version": VERSION})
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
            elif cmd == "getReport":
                handle_get_report(msg)
            elif cmd == "pget-cancel":
                _pget_cancel(msg)
        except Exception as e:
            send({"type": "error", "id": msg.get("id"), "error": str(e)})


# ---- parallel multi-mirror direct download --------------------------------
# Fetch a direct file from one or more mirror URLs using several range requests
# at once, with per-segment failover to another mirror. Each segment streams to
# its own part file (no concurrent writes to one handle), then the parts are
# stitched in order. Any failure emits "pget-fallback" so the extension hands off
# to the browser's own downloader — so it is never worse than a plain download.
_PGET = {}  # id -> {"stop": threading.Event}


def _pget_open(url, referer, ua, range_header=None, timeout=30):
    import urllib.request
    headers = {"User-Agent": ua or "Mozilla/5.0", "Accept": "*/*"}
    if referer:
        headers["Referer"] = referer
    if range_header:
        headers["Range"] = range_header
    return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout)


def _pget_probe(urls, referer, ua):
    """Probe every mirror with a 1-byte range request. Return (size, ok_mirrors),
    where ok_mirrors is the list of URLs that answered 206 with a Content-Range
    whose total matches the reference size — i.e. mirrors that both support ranges
    AND serve the same file. A mirror that ignores the range (returns 200) or
    reports a different size is dropped, since assigning it a segment would write
    the wrong bytes. Empty list => no usable mirror (caller falls back)."""
    size = None
    ok = []
    for u in urls:
        try:
            with _pget_open(u, referer, ua, "bytes=0-0") as r:
                if getattr(r, "status", None) != 206:
                    continue                       # 200 => server ignored the range
                cr = r.headers.get("Content-Range") or ""
                if "/" not in cr:
                    continue
                total = int(cr.rsplit("/", 1)[1])
                if size is None:
                    size = total
                if total == size:                  # only mirrors serving the same-size file
                    ok.append(u)
        except Exception:
            continue
    return size, ok


def _pget_segment(part_path, urls, idx, start, end, referer, ua, seg_done, stop):
    """Download bytes [start, end] into part_path, trying the assigned mirror
    first, then the others. Raises if every mirror fails."""
    length = end - start + 1
    order = urls[idx % len(urls):] + urls[:idx % len(urls)]
    last = "no mirror"
    for u in order:
        got = 0
        try:
            with _pget_open(u, referer, ua, "bytes=%d-%d" % (start, end)) as r, open(part_path, "wb") as f:
                if getattr(r, "status", None) != 206:
                    raise RuntimeError("not partial content (status %s)" % getattr(r, "status", None))
                while got < length:
                    if stop.is_set():
                        raise RuntimeError("cancelled")
                    chunk = r.read(65536)
                    if not chunk:
                        break
                    if got + len(chunk) > length:
                        chunk = chunk[:length - got]
                    f.write(chunk)
                    got += len(chunk)
                    seg_done[idx] = got
            if got >= length:
                return
            last = "short read %d/%d" % (got, length)
        except Exception as e:
            last = str(e)
        seg_done[idx] = 0
    raise RuntimeError("segment %d failed on all mirrors: %s" % (idx, last))


def _pget_cleanup(path, n):
    for p in [path] + ["%s.part%d" % (path, i) for i in range(n)]:
        try: os.remove(p)
        except Exception: pass


def _pget_cancel(req):
    j = _PGET.get(req.get("id"))
    if j:
        j["stop"].set()


def handle_pget(req):
    def worker():
        jid = req.get("id")
        urls = [u for u in (req.get("urls") or []) if u]
        referer = req.get("referer") or ""
        ua = req.get("userAgent") or ""
        name = sanitize(req.get("name") or "download")
        out_dir = req.get("dir") or downloads_dir()
        if not urls:
            send({"type": "pget-fallback", "id": jid, "reason": "no-urls"}); return
        try:
            size, ok_urls = _pget_probe(urls, referer, ua)
        except Exception:
            size, ok_urls = None, []
        if not size or not ok_urls:
            send({"type": "pget-fallback", "id": jid, "reason": "no-range"}); return
        try:
            os.makedirs(out_dir, exist_ok=True)
            path = _dedup(os.path.join(out_dir, name))
        except Exception:
            send({"type": "pget-fallback", "id": jid, "reason": "path"}); return

        n = max(1, min(6, size // (1024 * 1024)))
        seg = size // n
        ranges = [(i * seg, (size - 1 if i == n - 1 else (i + 1) * seg - 1)) for i in range(n)]
        seg_done = [0] * n
        stop = threading.Event()
        _PGET[jid] = {"stop": stop}

        def monitor():
            while not stop.is_set():
                send({"type": "pget-progress", "id": jid, "bytes": sum(seg_done), "total": size})
                if sum(seg_done) >= size:
                    break
                time.sleep(0.5)
        threading.Thread(target=monitor, daemon=True).start()

        errors = []
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=n) as ex:
                futs = [ex.submit(_pget_segment, "%s.part%d" % (path, i), ok_urls, i, s, e, referer, ua, seg_done, stop)
                        for i, (s, e) in enumerate(ranges)]
                for fu in concurrent.futures.as_completed(futs):
                    try:
                        fu.result()
                    except Exception as e:
                        errors.append(str(e)); stop.set()
        finally:
            stop.set()
            _PGET.pop(jid, None)

        if errors:
            _pget_cleanup(path, n)
            send({"type": "pget-fallback", "id": jid, "reason": errors[0]}); return

        try:  # stitch the parts in order into the final file
            with open(path, "wb") as out:
                for i in range(n):
                    with open("%s.part%d" % (path, i), "rb") as pf:
                        shutil.copyfileobj(pf, out, 1024 * 1024)
            for i in range(n):
                try: os.remove("%s.part%d" % (path, i))
                except Exception: pass
        except Exception as e:
            _pget_cleanup(path, n)
            send({"type": "pget-fallback", "id": jid, "reason": "stitch: %s" % e}); return

        if os.path.getsize(path) != size:
            _pget_cleanup(path, n)
            send({"type": "pget-fallback", "id": jid, "reason": "size-mismatch"}); return
        send({"type": "pget-progress", "id": jid, "bytes": size, "total": size})
        # Optional re-encode (H.265 / AV1) — same as recordings, kept only if smaller.
        conv_info = None
        conv = req.get("convert")
        if conv and conv.get("codec") in ("h265", "av1") and FFMPEG:
            codec = conv["codec"]
            send({"type": "converting", "id": jid, "file": path, "codec": codec})
            res = transcode(path, codec, conv.get("quality", "visually-lossless"), conv.get("encoder", "auto"))
            path = res["path"]
            conv_info = {"converted": res["converted"], "note": res["note"], "codec": codec,
                         "srcBytes": res["srcBytes"], "hevcBytes": res["hevcBytes"],
                         "kept": codec if res["converted"] else "orig"}
        send({"type": "pget-done", "id": jid, "file": path, "bytes": os.path.getsize(path), "convert": conv_info})
    threading.Thread(target=worker, daemon=True).start()


if __name__ == "__main__":
    main()
