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

VERSION = "1.4.4"

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

CONFIG_PATH = os.path.join(HERE, "mc_config.json")


def load_config():
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_config(cfg):
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
    except Exception:
        pass


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


def find_firefox():
    """Locate a firefox.exe — prefers whatever launched us, then registry, then
    common install dirs (including Developer Edition)."""
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
    """Spawn a DETACHED helper that gracefully closes Firefox, waits, and
    relaunches it (Firefox restores the previous session per its own setting).
    Detached so it survives this host dying when Firefox closes."""
    if not firefox_path:
        return False
    script = os.path.join(TMPDIR, "mc_restart.py")
    body = (
        "import time, subprocess\n"
        "time.sleep(1.2)\n"
        "subprocess.run(['taskkill','/IM','firefox.exe'], capture_output=True)\n"
        "for _ in range(80):\n"
        "    out = subprocess.run(['tasklist','/FI','IMAGENAME eq firefox.exe'], capture_output=True, text=True).stdout\n"
        "    if 'firefox.exe' not in out.lower(): break\n"
        "    time.sleep(0.5)\n"
        "time.sleep(1.0)\n"
        "subprocess.Popen([%r])\n" % firefox_path
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
        exe = sys.executable  # pythonw
        subprocess.Popen([exe, script], creationflags=flags, close_fds=True)
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
        "python": sys.executable, "firefox": firefox, "restart": bool(restart),
        "backupRoot": os.path.join(tempfile.gettempdir(), "media-catcher-backups"),
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

    flags = (0x00000008 | 0x00000200) if os.name == "nt" else 0  # DETACHED | NEW_GROUP
    try:
        subprocess.Popen(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
             "-File", guardian, "-Config", confpath],
            creationflags=flags, close_fds=True)
        return "guardian"
    except Exception:
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
        status = github_stage_release(cfg, force=bool(req.get("force")), ext_version=req.get("extVersion"))
        send({"type": "github-update", **status})
        if not status.get("reached"):
            if not auto:
                _info("Media Catcher", "Couldn't reach GitHub to check for updates.")
            return
        if not status.get("newer"):
            if not auto:
                _info("Media Catcher", "You're on the latest release (v%s)." % (status.get("latest") or "?"))
            return
        # Newer packages are staged in the watched folder — install them now.
        # _install_updates is single-flight, so the folder-watcher firing on the
        # same downloads can't double-prompt.
        _install_updates(cfg.get("extDir"), cfg.get("zipDir") or downloads_dir(), silent=auto)
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


def _install_updates(ext_dir, zip_dir, silent=False):
    """Install whatever in zip_dir is newer than what's installed.

    The host updates regardless of the extension folder. The extension is only
    overwritten when we actually have its source folder — a signed add-on lives in
    the Firefox profile and only Firefox can update it, so we never touch it. When a
    newer extension exists that we can't apply, we tell the extension so it can point
    the user at the download. Single-flight: the folder-watcher and an explicit check
    can't both prompt at once."""
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

        # Content-hash fallback: a same-version host package whose code changed.
        if plan["host_same_ver_changed"] and not apply_host:
            if _yesno("Media Catcher — content change detected",
                      "A helper package with the SAME version (v%s) but DIFFERENT code was found.\n\n"
                      "The version number wasn't bumped, yet the contents changed. Install it anyway?"
                      % (plan["host_to"] or "?")):
                apply_host = True

        if apply_ext or apply_host:
            summary = plan_summary(plan) or ("helper v%s (content change)" % plan["host_to"] if apply_host else "update")
            if not _yesno("Media Catcher — update ready",
                          "About to install: %s\n\nThe reliability guardian will back up your current "
                          "version, apply the update, verify it, and restart Firefox — reverting "
                          "automatically if anything fails.\n\nProceed?" % summary):
                send({"type": "update-result", "ok": True, "available": True, "deferred": True, "summary": summary})
                return
            mode = launch_guardian(apply_ext, apply_host, plan, ext_dir if have_ext else "", HERE, restart=True)
            send({"type": "update-result", "ok": True, "available": True, "summary": summary, "mode": mode})
            if mode == "error":
                _info("Media Catcher", "Couldn't start the update guardian.")
            return

        # Nothing the guardian can install. A newer *extension* may still exist that
        # only Firefox can install (signed add-on, no source folder) — surface it.
        if plan["ext_newer"] and not apply_ext and plan["ext_to"]:
            send({"type": "ext-update-available", "version": plan["ext_to"]})
            if not silent:
                _info("Media Catcher — update available",
                      "Media Catcher v%s is available.\n\nThe extension is a signed add-on, so it "
                      "updates through Firefox — install the signed .xpi from the Releases page, or it "
                      "will auto-update on Firefox's next check." % plan["ext_to"])
            return
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
        _install_updates(ext_dir, zip_dir, silent=bool(req.get("silent")))
    threading.Thread(target=worker, daemon=True).start()


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
    _install_updates(cfg.get("extDir"), cfg.get("zipDir") or downloads_dir(), silent=False)


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

def find_hevc_encoder():
    """Prefer a hardware HEVC encoder (much faster); fall back to software x265."""
    global _HEVC_ENC
    if _HEVC_ENC is not None:
        return _HEVC_ENC
    _HEVC_ENC = "libx265"
    if FFMPEG:
        try:
            cf, si = _no_window()
            out = subprocess.run([FFMPEG, "-hide_banner", "-encoders"],
                                 capture_output=True, text=True, timeout=15,
                                 creationflags=cf, startupinfo=si).stdout
            for enc in ("hevc_nvenc", "hevc_qsv", "hevc_amf"):
                if enc in out:
                    _HEVC_ENC = enc
                    break
        except Exception:
            pass
    return _HEVC_ENC

def _hevc_args(encoder, quality):
    """Codec args per encoder + quality. 'visually-lossless' (CRF 18) is the
    default and target: the re-encode is transparent - indistinguishable from the
    source in normal viewing - while still smaller than the H.264 original.
    'balanced' trades a little quality for a smaller file. 'true-lossless' is
    bit-exact and forces software x265 (hardware encoders cannot do it)."""
    q = {"visually-lossless": 18, "balanced": 24}.get(quality, 18)
    if quality == "true-lossless":
        return ["-c:v", "libx265", "-x265-params", "lossless=1", "-preset", "medium"]
    if encoder == "hevc_nvenc":
        # NVENC's QP scale is less efficient than x265's CRF, so hold the QP a
        # touch lower to stay transparent; p6 is a slow, high-quality preset.
        return ["-c:v", "hevc_nvenc", "-preset", "p6", "-rc", "constqp", "-qp", str(q)]
    if encoder == "hevc_qsv":
        return ["-c:v", "hevc_qsv", "-global_quality", str(q)]
    if encoder == "hevc_amf":
        return ["-c:v", "hevc_amf", "-rc", "cqp", "-qp_i", str(q), "-qp_p", str(q)]
    # 'slow' gives noticeably better compression at the same visual quality.
    return ["-c:v", "libx265", "-crf", str(q), "-preset", "slow"]

def transcode_h265(src, quality):
    """Re-encode src to HEVC and, if the result is smaller, replace src with it
    (deleting the H.264 original). Returns a dict:
        {"path": <final file>, "converted": bool, "note": <str or None>}
    The saved file is NEVER larger than the original: if the HEVC is not smaller
    (which can happen at a visually-lossless target on an already-compressed
    stream), the HEVC is discarded and the untouched H.264 is kept."""
    if not FFMPEG or not os.path.isfile(src):
        return {"path": src, "converted": False, "note": "no ffmpeg", "srcBytes": None, "hevcBytes": None}
    src_bytes = os.path.getsize(src)
    encoder = find_hevc_encoder()
    root, _ext = os.path.splitext(src)
    out = root + ".hevc.mp4"

    def _rm(p):
        try:
            if os.path.exists(p): os.remove(p)
        except Exception:
            pass

    def run(enc):
        cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-nostats", "-y",
               "-i", src] + _hevc_args(enc, quality) + \
              ["-tag:v", "hvc1", "-c:a", "copy", "-movflags", "+faststart", out]
        cf, si = _no_window()
        try:
            r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               creationflags=cf, startupinfo=si)
            return r.returncode == 0 and os.path.isfile(out) and os.path.getsize(out) > 0
        except Exception:
            return False

    ok = run(encoder)
    if not ok and encoder != "libx265":     # HW encoder present but unusable (no GPU/driver)
        _rm(out)
        ok = run("libx265")
    if not ok:
        _rm(out)
        return {"path": src, "converted": False, "note": "encode failed - kept H.264",
                "srcBytes": src_bytes, "hevcBytes": None}

    hevc_bytes = os.path.getsize(out)
    # Guarantee: never keep a file larger than the original.
    if hevc_bytes >= src_bytes:
        _rm(out)
        return {"path": src, "converted": False, "note": "H.265 was not smaller - kept H.264",
                "srcBytes": src_bytes, "hevcBytes": hevc_bytes}

    try:
        os.remove(src)          # delete the H.264 original
        os.replace(out, src)    # keep the original .mp4 name/path, now HEVC
        return {"path": src, "converted": True, "note": None, "srcBytes": src_bytes, "hevcBytes": hevc_bytes}
    except Exception:
        return {"path": out, "converted": True, "note": None, "srcBytes": src_bytes, "hevcBytes": hevc_bytes}


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
    if conv and conv.get("codec") == "h265":
        send({"type": "converting", "id": jid, "file": dest, "codec": "h265"})
        res = transcode_h265(dest, conv.get("quality", "visually-lossless"))
        dest = res["path"]
        conv_info = {"converted": res["converted"], "note": res["note"],
                     "srcBytes": res["srcBytes"], "hevcBytes": res["hevcBytes"], "kept": "h265" if res["converted"] else "h264"}

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
        send({"type": "pget-done", "id": jid, "file": path, "bytes": size})
    threading.Thread(target=worker, daemon=True).start()


if __name__ == "__main__":
    main()
