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

# ---- stdio framing: moved to mchost/nm.py (Task C1) ----------------------
# The IN/OUT globals stay OWNED by nm (init_io rebinds them there; a shim copy
# would go stale), so only the functions are re-exported here.
from mchost.nm import init_io, send, read_message   # noqa: E402,F401


# ---- tool discovery: moved to mchost/tools.py (Task C1) ------------------
from mchost.tools import HERE, TMPDIR, FFMPEG, find_ffmpeg, downloads_dir, sanitize   # noqa: E402,F401


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


def _validate_host_archive_member(name):
    """Validate one host-zip member name before any write.

    Returns (relative_path, is_directory). A single terminal separator may mark
    a directory member; those are skipped only after the rest of the name
    passes validation. Rejects absolute, drive-qualified, UNC, '.'/'..',
    empty-name or interior-empty-component, NUL, mixed/backslash traversal,
    and otherwise escaping names.
    """
    if name is None or name == "":
        raise ValueError("host archive member name is empty")
    if "\x00" in name:
        raise ValueError("host archive member name contains NUL")
    is_dir = name.endswith("/") or name.endswith("\\")
    core = name[:-1] if is_dir else name
    if core == "":
        raise ValueError("host archive member name is empty")
    # Absolute / UNC / drive-qualified (before separator normalization).
    if core[0] in "/\\" or core.startswith("//") or core.startswith("\\\\"):
        raise ValueError("host archive member is absolute or UNC: %r" % name)
    if len(core) >= 2 and core[1] == ":":
        raise ValueError("host archive member is drive-qualified: %r" % name)
    # Component checks on a unified separator view; empty segments catch
    # interior empties (mchost//x) and reject '.' / '..' traversal.
    unified = core.replace("\\", "/")
    if unified.startswith("/") or unified.startswith("//"):
        raise ValueError("host archive member is absolute or UNC: %r" % name)
    parts = unified.split("/")
    if any(p == "" for p in parts):
        raise ValueError("host archive member has empty path component: %r" % name)
    if any(p in (".", "..") for p in parts):
        raise ValueError("host archive member has dot path component: %r" % name)
    rel = os.path.join(*parts)
    return rel, is_dir


def _host_member_destination(host_dir, rel):
    """Resolve rel under host_dir; raise if it escapes the destination root."""
    host_abs = os.path.abspath(host_dir)
    dest_abs = os.path.abspath(os.path.join(host_dir, rel))
    if dest_abs != host_abs and not dest_abs.startswith(host_abs + os.sep):
        raise ValueError("host archive member escapes destination: %r" % rel)
    return dest_abs


def _reject_reparse_components(path):
    """Reject a pre-existing symlink/junction anywhere in an absolute path.

    Walk the lexical path from its drive/share root so a junction above the
    configured host directory is inspected before it can redirect updater I/O.
    Missing tail components are allowed; the updater may create them later.
    """
    if os.name != "nt":
        return
    full = os.path.abspath(os.fspath(path))
    drive, tail = os.path.splitdrive(full)
    if not drive or not tail.startswith((os.sep, "/", "\\")):
        raise ValueError("host update path must be absolute")

    current = drive + os.sep
    parts = [part for part in tail.replace("\\", "/").split("/") if part]
    for part in parts:
        current = os.path.join(current, part)
        try:
            info = os.lstat(current)
        except FileNotFoundError:
            break
        attrs = getattr(info, "st_file_attributes", 0)
        if attrs & 0x400 or os.path.islink(current):  # FILE_ATTRIBUTE_REPARSE_POINT
            raise RuntimeError("host update path contains a reparse point")


def apply_update(plan, ext_dir, host_dir):
    """Apply only the parts that are newer. Returns {staged: bool}."""
    if plan["host_newer"]:
        # Preflight before extension staging, host directory creation, or any
        # payload write. A junction above host_dir otherwise redirects every
        # later abspath/open call outside the configured lexical destination.
        _reject_reparse_components(host_dir)
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
            # Validate every member before the first directory creation or write.
            accepted = []
            for n in z.namelist():
                rel, is_dir = _validate_host_archive_member(n)
                _host_member_destination(host_dir, rel)
                if is_dir:
                    continue
                accepted.append((n, rel))
            for n, rel in accepted:
                dest = _host_member_destination(host_dir, rel)
                parent = os.path.dirname(dest)
                if parent:
                    os.makedirs(parent, exist_ok=True)
                with z.open(n) as src, open(dest, "wb") as dst:
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
                            start_watch, stop_watch, handle_watch)


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


# ---- save / save-as / pick-folder / open / reveal / discard ---------------
# Moved to mchost/downloads.py (Task C3 part 1).
from mchost.downloads import (handle_save, handle_save_as, handle_pick_folder,   # noqa: E402,F401
                              handle_open, handle_reveal, handle_discard)


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
            start_watch(cfg.get("zipDir") or downloads_dir())
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
            cmd = msg.get("cmd")
            try:
                if cmd == "ping":
                    send({"type": "pong", "ffmpeg": bool(FFMPEG), "ffmpegPath": FFMPEG or "", "version": VERSION,
                          "ytdlp": bool(_downloads.YTDLP), "ytdlpVersion": ytdlp_version_cached(),
                          "node": bool(_downloads.NODE), "deno": bool(_downloads.DENO), "pot": _pot_alive(),
                          "cast": True,  # DLNA casting is stdlib — always available
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
