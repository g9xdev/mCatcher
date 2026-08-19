"""Self-update, GitHub release auto-update, and the auto-update watcher
(moved verbatim from mc_host.py — Task C2, round-2 I2 boundary).

Cross-module/patched names (send, _hlog, _log_event, _read_history,
load_config, save_config, downloads_dir, find_firefox, _variant_key, HERE,
FFMPEG, VERSION, plan_update, plan_summary, launch_guardian, _console_python,
_yesno, _info) resolve through the mc_host shim at CALL time (`_h().<name>`) so
monkeypatched fakes are always honored — the splitting-modules-under-
monkeypatch rule. _last_avail, _github_poll_started, _update_lock and _WATCH
are mutable updater state OWNED here; the shim carries no copies (a shim copy
would go stale when this module rebinds them).
"""
import glob
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import zipfile

def _h():
    """Call-time shim lookup (same convention as hlog/config after the b9043cd
    review closure): a module-level `import mc_host` breaks package-first
    import order — worse here, since the shim itself imports mchost.updates
    mid-initialisation (import mchost.updates before mc_host -> circular
    ImportError on EXT_ID). sys.modules caches the shim, so this is a dict
    hit per call."""
    import mc_host
    return mc_host

# ---- self-update ----------------------------------------------------------
# The extension's gecko id — the persistent XPI must be named <id>.xpi.
EXT_ID = "{27383706-fb43-40dc-9e94-d2578818bd6a}"

_last_avail = None   # last extension version we recorded as 'update-available' (dedup)


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
    guardian = os.path.join(_h().HERE, "guardian.ps1")
    def _which(n):
        try:
            return shutil.which(n) or ""
        except Exception:
            return ""
    return {
        "hostVersion": _h().VERSION,
        "hostDir": _h().HERE,
        "configVariant": _h()._variant_key(),
        "python": sys.executable,
        "consolePython": _h()._console_python(),
        "runningPythonw": (sys.executable or "").lower().endswith("pythonw.exe"),
        "powershell": _which("powershell"),
        "firefox": _h().find_firefox() or "",
        "guardianPresent": os.path.isfile(guardian),
        "hostDirWritable": bool(os.access(_h().HERE, os.W_OK)),
        "backupRoot": _backup_root(),
        "guardianLogExists": os.path.exists(os.path.join(_backup_root(), "guardian.log")),
        "elevated": _is_elevated(),
        "ffmpeg": _h().FFMPEG or "",
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
                _h()._hlog(lvl, ln, src="guardian")
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
            _h()._log_event(comp, final, frm, to, source, det)

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
        "User-Agent": "MediaCatcher-Host/%s" % _h().VERSION,
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


# ---- where update packages are staged ------------------------------------
# ONE resolution for the watched folder, because there were five and they
# disagreed about nothing except how they spelled downloads_dir().
#
# `req` is the extension's message. background.js sends `settings.updateZipDir
# || ""`, so a non-blank req["zipDir"] IS the user's explicit choice and blank
# means "you pick" — that empty string is the fallback this function defines.
#
# The browser's own download folder is refused rather than honoured, in BOTH
# positions. As a request value it is the setting that recreates the plant
# vector this function exists to close; as a config value it is very likely not
# a choice at all -- handle_update used to write its resolved zip_dir back
# unconditionally, so one press of "Check & install update" on a host that had
# never been configured persisted downloads_dir() as if the user had asked for
# it. There is no field that distinguishes those two, so neither is followed.
# The refusal is logged, never silent, and only the folder ITSELF is refused:
# a subfolder of Downloads is not where a drive-by download lands.
def _is_downloads_dir(path):
    # normcase as well as realpath: on Win32 realpath resolves the links but
    # leaves the case as written, so "C:\Users\x\downloads" would otherwise
    # slip past a folder named "Downloads".
    def key(p):
        return os.path.normcase(os.path.realpath(p))
    try:
        return key(path) == key(_h().downloads_dir())
    except Exception:
        return False


def _resolve_zip_dir(cfg, req=None):
    """The folder to watch and stage packages in: the user's explicit choice if
    there is one, else the host's own staging folder."""
    for src in ((req or {}).get("zipDir"), (cfg or {}).get("zipDir")):
        if isinstance(src, str) and src.strip():
            if _is_downloads_dir(src):
                _h()._hlog("warn", "update: ignoring %s as the package folder — "
                                   "the browser writes there; using %s instead"
                           % (src, _h().update_staging_dir()))
                break
            return src
    return _h().update_staging_dir()


def github_stage_release(cfg, force=False, ext_version=None):
    """If the latest GitHub release is newer than what's installed, download its
    extension/host packages into the watched folder. Returns a status dict and
    never raises."""
    ext_dir = cfg.get("extDir")
    zip_dir = _resolve_zip_dir(cfg)
    version, assets = github_latest_release()
    if not version:
        return {"reached": False}
    # Prefer the extension's own reported version (works for signed installs with
    # no source folder); fall back to reading a source folder's manifest.
    ext_from = ext_version or (_installed_version(ext_dir) if ext_dir else None)
    newer = ((not ext_from or _vtuple(version) > _vtuple(ext_from))
             or _vtuple(version) > _vtuple(_h().VERSION))
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
        cfg = _h().load_config()
        if req.get("extDir"):
            cfg["extDir"] = req["extDir"]
        if req.get("zipDir"):
            cfg["zipDir"] = req["zipDir"]
        _h().save_config(cfg)
        auto = bool(req.get("auto"))
        _h()._hlog("info", "checking GitHub for updates%s…" % (" (auto)" if auto else ""))
        status = github_stage_release(cfg, force=bool(req.get("force")), ext_version=req.get("extVersion"))
        _h().send({"type": "github-update", **status})
        if not status.get("reached"):
            _h()._hlog("warn", "couldn't reach GitHub to check for updates")
            if not auto:
                _h()._info("Media Catcher", "Couldn't reach GitHub to check for updates.")
            return
        if not status.get("newer"):
            _h()._hlog("info", "GitHub: already on the latest release (v%s)" % (status.get("latest") or "?"))
            if not auto:
                _h()._info("Media Catcher", "You're on the latest release (v%s)." % (status.get("latest") or "?"))
            return
        _h()._hlog("info", "GitHub has v%s — staged %s" % (status.get("latest") or "?",
              ", ".join(status.get("downloaded") or []) or "nothing new"))
        # Newer packages are staged in the watched folder — install them now.
        # _install_updates is single-flight, so the folder-watcher firing on the
        # same downloads can't double-prompt.
        _install_updates(cfg.get("extDir"), _resolve_zip_dir(cfg), silent=auto, source="github")
    threading.Thread(target=worker, daemon=True).start()


def _github_poll_loop():
    time.sleep(90)   # let startup settle before the first check
    while True:
        try:
            cfg = _h().load_config()
            if cfg.get("autoUpdate"):
                status = github_stage_release(cfg)
                if status.get("newer") and status.get("downloaded"):
                    _h().send({"type": "github-update", **status})
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
        plan = _h().plan_update(ext_dir if have_ext else "", _h().HERE, zip_dir)
        # Only overwrite the extension folder if it is ACTUALLY an extension source
        # (has a manifest). Guards against a mis-set folder like C:\Code getting an
        # extension unpacked into it.
        apply_ext = bool(plan["ext_newer"] and have_ext and plan["ext_from"])
        apply_host = bool(plan["host_newer"])
        _h()._hlog("info", "update check (%s): extension %s→%s, helper %s→%s" % (
            source, plan["ext_from"] or "?", plan["ext_to"] or "?",
            plan["host_from"] or "?", plan["host_to"] or "?"))

        # Content-hash fallback: a same-version host package whose code changed.
        if plan["host_same_ver_changed"] and not apply_host:
            if _h()._yesno("Media Catcher — content change detected",
                      "A helper package with the SAME version (v%s) but DIFFERENT code was found.\n\n"
                      "The version number wasn't bumped, yet the contents changed. Install it anyway?"
                      % (plan["host_to"] or "?")):
                apply_host = True

        if apply_ext or apply_host:
            comps = _apply_comps(apply_ext, apply_host, plan)
            summary = _h().plan_summary(plan) or ("helper v%s (content change)" % plan["host_to"] if apply_host else "update")
            if not _h()._yesno("Media Catcher — update ready",
                          "About to install: %s\n\nThe reliability guardian will back up your current "
                          "version, apply the update, verify it, and restart Firefox — reverting "
                          "automatically if anything fails.\n\nProceed?" % summary):
                for c, f, t in comps:
                    _h()._log_event(c, "deferred", f, t, source, "user chose not to install now")
                _h().send({"type": "update-result", "ok": True, "available": True, "deferred": True, "summary": summary})
                return
            logf = os.path.join(_backup_root(), "guardian.log")
            base = os.path.getsize(logf) if os.path.exists(logf) else 0
            _h()._hlog("info", "handing off to guardian: %s" % summary)
            mode = _h().launch_guardian(apply_ext, apply_host, plan, ext_dir if have_ext else "", _h().HERE, restart=True)
            _h().send({"type": "update-result", "ok": True, "available": True, "summary": summary, "mode": mode})
            if mode == "guardian":
                _watch_guardian_outcome(apply_ext, apply_host, plan, source, base)
            elif mode == "fallback":
                for c, f, t in comps:
                    _h()._log_event(c, "applied", f, t, source, "in-process apply (guardian script absent)")
            elif mode == "error":
                for c, f, t in comps:
                    _h()._log_event(c, "error", f, t, source, "couldn't start the guardian process")
                _h()._info("Media Catcher", "Couldn't start the update guardian.")
            return

        # Nothing the guardian can install. A newer *extension* may still exist that
        # only Firefox can install (signed add-on, no source folder) — surface it.
        if plan["ext_newer"] and not apply_ext and plan["ext_to"]:
            # Record the durable history row once per version — repeated checks would
            # otherwise append the same 'update-available' line on every poll.
            global _last_avail
            if plan["ext_to"] != _last_avail:
                _last_avail = plan["ext_to"]
                _h()._log_event("extension", "update-available", plan["ext_from"], plan["ext_to"], source,
                           "signed add-on — Firefox installs it (or install the .xpi)")
            else:
                _h()._hlog("info", "extension v%s available (signed add-on — install via Firefox)" % plan["ext_to"])
            _h().send({"type": "ext-update-available", "version": plan["ext_to"]})
            if not silent:
                _h()._info("Media Catcher — update available",
                      "Media Catcher v%s is available.\n\nThe extension is a signed add-on, so it "
                      "updates through Firefox — install the signed .xpi from the Releases page, or it "
                      "will auto-update on Firefox's next check." % plan["ext_to"])
            return
        _h()._hlog("info", "up to date (extension v%s, helper v%s)" % (plan["ext_from"] or "?", plan["host_from"] or "?"))
        _h().send({"type": "update-result", "ok": True, "available": False, "version": plan["ext_from"]})
        if not silent:
            _h()._info("Media Catcher", "You're up to date (extension v%s, helper v%s)." %
                  (plan["ext_from"] or "?", plan["host_from"] or "?"))
    finally:
        _update_lock.release()


def handle_update(req):
    """'Check & install update' from the extension: persist paths, then install
    whatever is newer (host always; extension only for a source install)."""
    def worker():
        cfg = _h().load_config()
        ext_dir = req.get("extDir") or cfg.get("extDir")
        zip_dir = _resolve_zip_dir(cfg, req)
        if ext_dir and os.path.isdir(ext_dir):
            cfg["extDir"] = ext_dir
        # Only an explicit choice is persisted. Writing the resolved folder back
        # unconditionally is what turned the old implicit Downloads fallback
        # into a stored setting.
        if req.get("zipDir"):
            cfg["zipDir"] = req["zipDir"]
        _h().save_config(cfg)
        _install_updates(ext_dir, zip_dir, silent=bool(req.get("silent")), source="manual")
    threading.Thread(target=worker, daemon=True).start()


def handle_get_report(req):
    """Answer the Settings 'diagnostics' request: the environment the update path
    depends on, the durable update history, and a tail of the guardian log. Also
    narrates the key facts to the live console so a glance tells the story."""
    env = _update_env()
    _h().send({"type": "report", "reqId": req.get("reqId"), "host": _h().VERSION,
          "env": env, "history": _h()._read_history(200), "guardianTail": _guardian_log_tail(150)})
    _h()._hlog("info", "diagnostics: host v%s (%s) · powershell=%s · guardian.ps1=%s · Firefox=%s · guardian.log=%s" % (
        _h().VERSION, "pythonw" if env["runningPythonw"] else "python",
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
    cfg = _h().load_config()
    _install_updates(cfg.get("extDir"), _resolve_zip_dir(cfg), silent=False, source="watcher")


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
    cfg = _h().load_config()
    if req.get("extDir"):
        cfg["extDir"] = req["extDir"]
    if req.get("zipDir"):
        cfg["zipDir"] = req["zipDir"]
    enable = bool(req.get("enable"))
    cfg["autoUpdate"] = enable
    _h().save_config(cfg)
    zdir = _resolve_zip_dir(cfg)
    if enable and os.name == "nt":
        start_watch(zdir)
        start_github_poll()
        _h().send({"type": "watch", "enabled": True, "dir": zdir})
    else:
        stop_watch()
        _h().send({"type": "watch", "enabled": False})
