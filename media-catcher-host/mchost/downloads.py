"""Recording jobs, optional H.265/AV1 conversion, the save / save-as /
pick-folder / open / reveal / discard handlers, the yt-dlp section, and the
parallel multi-mirror downloader (moved verbatim from mc_host.py — Task C3,
two commits).

Cross-module/patched names (send, _hlog, FFMPEG, TMPDIR, HERE, VERSION,
sanitize, downloads_dir, load_config) resolve through the mc_host shim at
CALL time (`_h().<name>`) so monkeypatched fakes are always honored — the
splitting-modules-under-monkeypatch rule. JOBS/JOBS_LOCK (the recording
registry), _HEVC_ENC/_ENC_CACHE (encoder probe caches), YTDLP/NODE/DENO/
_YTDLP_VER/_POT (yt-dlp tool state) and _PGET (the cancel registry shared by
handle_ytdl and handle_pget) are mutable state OWNED here; the shim carries
no copies (a shim copy would go stale when this module rebinds them).
subprocess is the GLOBAL module object, so the test suite's
setattr(mc_host.subprocess, "Popen", ...) patch is seen here too.
"""
import concurrent.futures
import ctypes
import json
import os
import re
import shutil
import stat as _stat
import subprocess
import sys
import threading
import time
import unicodedata
import uuid
from ctypes import wintypes


def _h():
    """Call-time shim lookup (same convention as hlog/config/updates after the
    b9043cd review closure): a module-level `import mc_host` breaks
    package-first import order — the shim itself imports mchost.downloads
    mid-initialisation. sys.modules caches the shim, so this is a dict hit
    per call."""
    import mc_host
    return mc_host


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

    cmd = [_h().FFMPEG, "-hide_banner", "-loglevel", "error",
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
        _h().send({"type": "error", "id": job.id, "error": "ffmpeg failed to start: %s" % e})
        job.finished.set()
        return
    _h().send({"type": "started", "id": job.id})

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
                _h().send({"type": "progress", "id": job.id, "bytes": job.bytes, "seconds": round(job.seconds, 1)})

    job.proc.wait()
    try:
        if os.path.isfile(job.temp):
            job.bytes = os.path.getsize(job.temp)
    except Exception:
        pass
    job.finished.set()
    _h().send({"type": "stopped", "id": job.id, "file": job.temp,
               "bytes": job.bytes, "seconds": round(job.seconds, 1)})


def handle_record(req):
    if not _h().FFMPEG:
        _h().send({"type": "error", "id": req.get("id"), "error": "ffmpeg not found. Re-run the installer or put ffmpeg.exe next to the helper."})
        return
    jid = req.get("id")
    temp = os.path.join(_h().TMPDIR, "mc_%s.mp4" % jid)
    job = Job(jid, temp)
    job.base = _h().sanitize(req.get("base"))
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
        _h().send({"type": "error", "id": jid, "error": "nothing recorded yet"})
        return
    base = _h().sanitize(req.get("base") or job.base)
    d = req.get("dir") or _h().downloads_dir()
    if not os.path.isdir(d):
        d = _h().downloads_dir()
    dest = os.path.join(d, base + " (partial).mp4")
    try:
        _copy_prefix(job.temp, dest)      # overwrites the previous partial (latest is fullest)
        job.partial = dest
        _h().send({"type": "snapshot", "id": jid, "file": dest, "bytes": os.path.getsize(dest),
                   "seconds": round(job.seconds, 1)})
    except Exception as e:
        _h().send({"type": "error", "id": jid, "error": "save-now failed: %s" % e})


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
        if _h().FFMPEG:
            try:
                cf, si = _no_window()
                out = subprocess.run([_h().FFMPEG, "-hide_banner", "-encoders"],
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

def _safe_kill(p):
    """Kill p AND its descendants.

    yt-dlp's PyInstaller onefile build is a launcher that re-execs the real
    program as a CHILD, and that grandchild inherits our stdout pipe. Killing
    only the launcher orphans it: the pipe never closes, so `for line in
    p.stdout` never ends, p.wait() is never reached, and the job hangs on
    "Preparing" forever with no terminal message — the stall watchdog fires and
    is then unable to report. taskkill /T takes the whole tree; the direct
    p.kill() below still covers the non-Windows and taskkill-unavailable cases.
    """
    try:
        if not p or p.poll() is not None:
            return
    except Exception:
        return
    if os.name == "nt":
        try:
            cf, si = _no_window()
            subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           creationflags=cf, startupinfo=si, timeout=15)
        except Exception:
            pass
    try:
        p.kill()
    except Exception:
        pass


def _probe_media(path):
    """Parse ffmpeg's header read (no ffprobe binary needed): duration (us), overall
    bitrate, and the first video stream's codec, WxH, and fps. Missing fields are None."""
    info = {"dur_us": 0, "bitrate": None, "codec": None, "width": None, "height": None, "fps": None}
    if not _h().FFMPEG:
        return info
    cf, si = _no_window()
    try:
        r = subprocess.run([_h().FFMPEG, "-hide_banner", "-i", path], stdout=subprocess.DEVNULL,
                           stderr=subprocess.PIPE, creationflags=cf, startupinfo=si, timeout=30)
        txt = r.stderr.decode("utf-8", "replace")
    except Exception:
        return info
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", txt)
    if m:
        info["dur_us"] = int((int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))) * 1_000_000)
    m = re.search(r"bitrate:\s*(\d+)\s*kb/s", txt)
    if m:
        info["bitrate"] = int(m.group(1)) * 1000
    vline = re.search(r"Stream #\d+:\d+[^\n]*Video:\s*([^\n]+)", txt)
    if vline:
        v = vline.group(1)
        cm = re.match(r"([a-z0-9]+)", v)
        if cm:
            info["codec"] = cm.group(1).lower()
        rm = re.search(r"(\d{2,5})x(\d{2,5})", v)
        if rm:
            info["width"], info["height"] = int(rm.group(1)), int(rm.group(2))
        fm = re.search(r"(\d+(?:\.\d+)?)\s*fps", v)
        if fm:
            info["fps"] = float(fm.group(1))
    return info


# Bits-per-pixel a target codec/quality roughly needs. If the SOURCE is already at or
# below this, a re-encode would grow it (the source is more compressed than the target
# would be), so we skip without encoding. Deliberately conservative.
_TARGET_BPP = {
    ("h265", "visually-lossless"): 0.050, ("h265", "balanced"): 0.030, ("h265", "true-lossless"): 1e9,
    ("av1", "visually-lossless"): 0.038, ("av1", "balanced"): 0.024,
}


def _transcode_worthwhile(media, codec, quality):
    """Predict — before encoding — whether re-encoding will actually shrink the file.
    Returns (worth: bool, reason_if_not: str|None). Only says 'no' on strong evidence;
    when data is missing it says 'yes' and lets the encode + early-abort decide."""
    sc = (media.get("codec") or "")
    if sc == "av1":
        return False, "source is already AV1 (most efficient) — re-encoding would grow it"
    if sc in ("hevc", "h265") and codec == "h265":
        return False, "source is already H.265 — re-encoding would grow it"
    w, h, fps, br = media.get("width"), media.get("height"), media.get("fps"), media.get("bitrate")
    if w and h and fps and br and fps > 0:
        bpp = br / float(w * h * fps)
        thr = _TARGET_BPP.get((codec, quality), 0.045)
        if bpp <= thr:
            return False, ("already ~%.3f bpp — leaner than %s %s needs, so it would grow"
                           % (bpp, codec.upper(), quality))
    return True, None


def transcode(src, codec="h265", quality="visually-lossless", prefer="auto", on_progress=None):
    """Re-encode src to codec ('h265'|'av1') and, if the result is smaller, replace src
    with it (deleting the original). The saved file is NEVER larger than the original:
    the encode is ABORTED the moment the output exceeds the source size (re-encoding an
    already-compressed stream at a visually-lossless target usually grows it — no point
    finishing a file we'd discard), and a runaway encode is killed by a deadline.
    on_progress(pct) is called with 0..99 while encoding.
    Returns {path, converted, note, srcBytes, hevcBytes} (hevcBytes = new size)."""
    if not _h().FFMPEG or not os.path.isfile(src) or codec not in ("h265", "av1"):
        return {"path": src, "converted": False, "note": "no ffmpeg", "srcBytes": None, "hevcBytes": None}
    src_bytes = os.path.getsize(src)
    media = _probe_media(src)
    dur_us = media["dur_us"]
    # Predict whether it can shrink at all; if not, skip WITHOUT encoding (no wasted work).
    worth, why = _transcode_worthwhile(media, codec, quality)
    if not worth:
        _h()._hlog("info", "convert skipped (%s): %s" % (codec.upper(), why))
        return {"path": src, "converted": False, "note": why, "srcBytes": src_bytes, "hevcBytes": None}
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
        """Encode with progress + safeguards. Returns 'ok' | 'fail' | 'toobig'."""
        if not enc:
            return "fail"
        cmd = [_h().FFMPEG, "-hide_banner", "-loglevel", "error", "-nostats", "-y",
               "-i", src] + _codec_args(codec, enc, quality) + \
              ["-tag:v", tag, "-c:a", "copy", "-movflags", "+faststart", "-progress", "pipe:1", out]
        cf, si = _no_window()
        try:
            p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                 creationflags=cf, startupinfo=si, text=True)
        except Exception:
            return "fail"
        # Deadline for a genuinely hung encode: 20x realtime, floor 5 min (30 if unknown).
        limit = max(300, int((dur_us / 1_000_000) * 20)) if dur_us else 1800
        killer = threading.Timer(limit, lambda: _safe_kill(p)); killer.daemon = True; killer.start()
        toobig = False
        last_speed = last_fps = None
        try:
            for line in p.stdout:
                line = line.strip()
                if line.startswith("total_size="):
                    try:
                        if int(line.split("=", 1)[1]) >= src_bytes:
                            toobig = True; _safe_kill(p); break     # would be discarded — stop now
                    except Exception:
                        pass
                elif line.startswith("out_time_us=") and dur_us and on_progress:
                    try:
                        on_progress(max(0, min(99, int(int(line.split("=", 1)[1]) * 100 / dur_us))))
                    except Exception:
                        pass
                elif line.startswith("speed="):
                    last_speed = line.split("=", 1)[1].strip()
                elif line.startswith("fps="):
                    last_fps = line.split("=", 1)[1].strip()
        finally:
            killer.cancel()
            try: p.wait(timeout=10)
            except Exception: _safe_kill(p)
        # Real encoder throughput -> the Settings console, so GPU-vs-CPU speed is visible.
        _h()._hlog("info", "convert %s via %s: speed %s, %s fps%s" % (
            codec.upper(), enc, last_speed or "?", last_fps or "?",
            " — aborted (would be larger)" if toobig else ""))
        if toobig:
            return "toobig"
        return "ok" if (p.returncode == 0 and os.path.isfile(out) and os.path.getsize(out) > 0) else "fail"

    st = run(encoder)
    if st == "fail" and encoder != sw:     # HW encoder present but unusable -> software fallback
        _rm(out)
        st = run(sw)
    if st == "toobig":
        _rm(out)
        return {"path": src, "converted": False, "note": "%s would be larger - kept original" % codec.upper(),
                "srcBytes": src_bytes, "hevcBytes": None}
    if st != "ok":
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
        _h().send({"type": "error", "id": jid, "error": "save failed: %s" % e})
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
        _h().send({"type": "converting", "id": jid, "file": dest, "codec": codec})
        res = transcode(dest, codec, conv.get("quality", "visually-lossless"), conv.get("encoder", "auto"),
                        on_progress=lambda pct, j=jid, c=codec: _h().send({"type": "convert-progress", "id": j, "pct": pct, "codec": c}))
        dest = res["path"]
        conv_info = {"converted": res["converted"], "note": res["note"], "codec": codec,
                     "srcBytes": res["srcBytes"], "hevcBytes": res["hevcBytes"],
                     "kept": codec if res["converted"] else "orig"}

    bytes_ = os.path.getsize(dest) if os.path.isfile(dest) else 0
    _h().send({"type": "saved", "id": jid, "file": dest, "bytes": bytes_, "convert": conv_info})


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


class _WinFolderApi:
    """Narrow Win32 shell adapter so picker policy stays testable off-Windows."""

    def foreground_window(self):
        import ctypes
        return ctypes.windll.user32.GetForegroundWindow()

    def browse(self, owner, initial_dir):
        """Show the folder dialog owned by `owner`, opened at `initial_dir`.

        Returns the selected path, or None when the user cancelled. Raises on a
        genuine shell failure so the caller can tell the two apart.
        """
        import ctypes
        from ctypes import wintypes

        BFFM_INITIALIZED = 1
        BFFM_SETSELECTIONW = 0x467
        MAX_PATH = 260

        co_ok = False
        try:
            ctypes.windll.ole32.CoInitialize(None)
            co_ok = True
        except Exception:
            co_ok = False
        try:
            class BROWSEINFO(ctypes.Structure):
                _fields_ = [
                    ("hwndOwner", wintypes.HWND), ("pidlRoot", ctypes.c_void_p),
                    ("pszDisplayName", wintypes.LPWSTR), ("lpszTitle", wintypes.LPCWSTR),
                    ("ulFlags", wintypes.UINT), ("lpfn", ctypes.c_void_p),
                    ("lParam", ctypes.c_void_p), ("iImage", ctypes.c_int),
                ]

            user32 = ctypes.windll.user32
            shell32 = ctypes.windll.shell32

            # Preselect the caller's directory and pull the dialog to the front
            # once it exists — otherwise it can open behind the browser.
            callback_type = ctypes.WINFUNCTYPE(
                ctypes.c_int, wintypes.HWND, wintypes.UINT,
                ctypes.c_void_p, ctypes.c_void_p)
            selection = ctypes.create_unicode_buffer(initial_dir or "")

            def _on_message(hwnd, message, _lparam, _data):
                if message == BFFM_INITIALIZED:
                    try:
                        user32.SendMessageW(hwnd, BFFM_SETSELECTIONW, 1,
                                            ctypes.cast(selection, ctypes.c_void_p))
                        user32.SetForegroundWindow(hwnd)
                    except Exception:
                        pass
                return 0

            # Keep the callback and buffers alive for the dialog's whole life.
            callback = callback_type(_on_message)
            display = ctypes.create_unicode_buffer(MAX_PATH)

            info = BROWSEINFO()
            info.hwndOwner = owner
            info.pszDisplayName = ctypes.cast(display, wintypes.LPWSTR)
            info.lpszTitle = "Select a folder"
            info.ulFlags = 0x1 | 0x40   # BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE
            info.lpfn = ctypes.cast(callback, ctypes.c_void_p)

            shell32.SHBrowseForFolderW.restype = ctypes.c_void_p
            pidl = shell32.SHBrowseForFolderW(ctypes.byref(info))
            if not pidl:
                return None                      # user cancelled
            try:
                path = ctypes.create_unicode_buffer(MAX_PATH)
                if not shell32.SHGetPathFromIDListW(ctypes.c_void_p(pidl), path):
                    raise OSError("SHGetPathFromIDListW failed")
                return path.value
            finally:
                try:
                    ctypes.windll.ole32.CoTaskMemFree(ctypes.c_void_p(pidl))
                except Exception:
                    pass
        finally:
            if co_ok:
                try:
                    ctypes.windll.ole32.CoUninitialize()
                except Exception:
                    pass


def _ask_folder(default_dir, api=None):
    """Foreground-owned folder picker with three distinct outcomes.

    Cancellation and failure used to be indistinguishable (both ""), so the
    extension could not tell "user changed their mind" from "picker broke".
    Never logs `default_dir` or the selected path.
    """
    api = api or _WinFolderApi()
    try:
        owner = api.foreground_window()
    except Exception:
        return {"status": "error", "code": "picker_unavailable"}
    if not owner:
        return {"status": "error", "code": "picker_unavailable"}
    try:
        selected = api.browse(owner, default_dir)
    except Exception:
        return {"status": "error", "code": "picker_unavailable"}
    if selected is None:
        return {"status": "cancelled"}
    if not isinstance(selected, str) or not selected or not os.path.isdir(selected):
        return {"status": "error", "code": "invalid_selection"}
    return {"status": "selected", "directory": selected}


def handle_save(req):
    """Auto-save into the configured folder (or Downloads) — no dialog."""
    jid = req.get("id")
    with JOBS_LOCK:
        job = JOBS.get(jid)
    if not job:
        _h().send({"type": "error", "id": jid, "error": "unknown recording"})
        return

    def worker():
        job.finished.wait(timeout=30)
        if not os.path.isfile(job.temp):
            _h().send({"type": "error", "id": jid, "error": "temp file missing"})
            return
        d = req.get("dir") or _h().downloads_dir()
        if not os.path.isdir(d):
            d = _h().downloads_dir()
        dest = _dedup(os.path.join(d, _h().sanitize(req.get("base") or job.base) + ".mp4"))
        _finalize_move(job, jid, dest, req)
    threading.Thread(target=worker, daemon=True).start()


def handle_save_as(req):
    """Pop a native Save-As dialog so the user picks the path per file."""
    jid = req.get("id")
    with JOBS_LOCK:
        job = JOBS.get(jid)
    if not job:
        _h().send({"type": "error", "id": jid, "error": "unknown recording"})
        return

    def worker():
        job.finished.wait(timeout=30)
        if not os.path.isfile(job.temp):
            _h().send({"type": "error", "id": jid, "error": "temp file missing"})
            return
        default_dir = req.get("dir") or _h().downloads_dir()
        name = _h().sanitize(req.get("base") or job.base) + ".mp4"
        path = _ask_save_path(default_dir, name)
        if not path:
            _h().send({"type": "save-cancelled", "id": jid})   # keep it cached to retry
            return
        _finalize_move(job, jid, path, req)
    threading.Thread(target=worker, daemon=True).start()


def handle_pick_folder(req):
    """Native folder picker. Replies with exactly one terminal folder frame:
    {type:folder,requestId,status:selected,directory} | {...,status:cancelled} |
    {...,status:error,code:picker_unavailable|invalid_selection}.
    """
    request_id = req.get("requestId")
    if request_id is None:
        request_id = req.get("reqId")          # legacy settings-page callers
    default_dir = req.get("dir") or _h().downloads_dir()

    def worker():
        try:
            outcome = _ask_folder(default_dir)
        except Exception:
            outcome = {"status": "error", "code": "picker_unavailable"}
        # Allowlist-copy: never echo anything else the picker returned.
        frame = {"type": "folder", "requestId": request_id}
        status = outcome.get("status") if isinstance(outcome, dict) else None
        if status == "selected":
            frame["status"] = "selected"
            frame["directory"] = outcome.get("directory")
        elif status == "cancelled":
            frame["status"] = "cancelled"
        else:
            frame["status"] = "error"
            code = outcome.get("code") if isinstance(outcome, dict) else None
            frame["code"] = code if code in ("picker_unavailable", "invalid_selection") \
                else "picker_unavailable"
        _h().send(frame)
    threading.Thread(target=worker, daemon=True).start()


def handle_open(req):
    """Open a saved file with the OS default application (notification click)."""
    path = req.get("path")
    if not path or not os.path.isfile(path):
        _h().send({"type": "error", "id": req.get("id"), "error": "file not found: %s" % path})
        return
    try:
        if os.name == "nt":
            os.startfile(path)               # noqa: default handler
        elif sys.platform == "darwin":
            subprocess.Popen(["open", path])
        else:
            subprocess.Popen(["xdg-open", path])
    except Exception as e:
        _h().send({"type": "error", "error": "open failed: %s" % e})


def handle_reveal(req):
    """Show a saved file in its containing folder (popup "Folder" button)."""
    path = req.get("path")
    if not path or not os.path.isfile(path):
        _h().send({"type": "error", "id": req.get("id"), "error": "file not found: %s" % path})
        return
    try:
        if os.name == "nt":
            # String form on purpose: explorer's "/select," argument must not be
            # split/re-quoted by list2cmdline. '"' can't appear in a Windows path.
            subprocess.Popen('explorer /select,"%s"' % path)
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", path])
        else:
            subprocess.Popen(["xdg-open", os.path.dirname(path) or "."])
    except Exception as e:
        _h().send({"type": "error", "error": "reveal failed: %s" % e})


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
    _h().send({"type": "discarded", "id": jid})


# ---- YouTube (and other sites) via yt-dlp + bgutil PO-token provider ------
# YouTube's stream URLs, signatures and PO-token rules change constantly, so we
# lean on yt-dlp (the maintained extractor) instead of reinventing it. The top
# 4K/VP9/AV1 formats now require a PO token, minted by the bundled bgutil provider
# (a small Node HTTP server); Firefox cookies supply auth (age-gate, members,
# the user's account). All three are optional at runtime — missing pieces just
# cap quality or surface a clear error rather than crashing.
def find_ytdlp():
    exe = "yt-dlp.exe" if os.name == "nt" else "yt-dlp"
    local = os.path.join(_h().HERE, exe)
    return local if os.path.isfile(local) else shutil.which("yt-dlp")


def find_node():
    if os.name == "nt":
        for c in (os.path.join(_h().HERE, "node", "node.exe"), os.path.join(_h().HERE, "node.exe")):
            if os.path.isfile(c):
                return c
    return shutil.which("node")


def find_deno():
    if os.name == "nt":
        c = os.path.join(_h().HERE, "deno.exe")
        if os.path.isfile(c):
            return c
    return shutil.which("deno")


# YTDLP/NODE/DENO are initialised at the BOTTOM of this module (their
# find_* calls resolve _h().HERE, and a module-level _h() may `import
# mc_host`, whose re-imports need every name here already defined).
_POT_PORT = 4416          # bgutil-ytdlp-pot-provider HTTP server default
_POT = {"proc": None}
_YTDLP_VER = None


def _ytdlp_version():
    if not YTDLP:
        return None
    cf, si = _no_window()
    try:
        r = subprocess.run([YTDLP, "--version"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           creationflags=cf, startupinfo=si, timeout=20)
        return (r.stdout.decode("utf-8", "replace").strip() or None)
    except Exception:
        return None


def ytdlp_version_cached():
    return _YTDLP_VER or ""


def ytdlp_update():
    """Ask yt-dlp to update itself (it breaks often as YouTube changes). Best-effort."""
    global _YTDLP_VER
    if not YTDLP:
        return None
    cf, si = _no_window()
    try:
        r = subprocess.run([YTDLP, "-U"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           creationflags=cf, startupinfo=si, timeout=180)
        out = r.stdout.decode("utf-8", "replace").strip()
        _h()._hlog("info", "yt-dlp self-update: %s" % (out.splitlines()[-1] if out else "done"))
        _YTDLP_VER = _ytdlp_version() or _YTDLP_VER
        return out
    except Exception as e:
        _h()._hlog("warn", "yt-dlp self-update failed: %s" % e)
        return None


def ensure_ytdlp():
    """Return a path to yt-dlp, fetching the official release into HERE if it's missing.
    Lets auto-updated installs (which don't ship the binary) get YouTube without a
    manual installer re-run.

    Fetches the DIRECTORY build (yt-dlp_win.zip: yt-dlp.exe + _internal/), never
    the onefile exe. The onefile launcher re-extracts ~145 files to %TEMP% on
    EVERY launch; under a browser-descended process each extraction is rescanned,
    which stalled host-spawned yt-dlp for ~90s during DLL load while the same
    command from a shell started in about a second. The directory build extracts
    nothing and starts in ~0.4s.
    """
    global YTDLP
    if YTDLP:
        return YTDLP
    if os.name != "nt":
        return None
    here = _h().HERE
    dest = os.path.join(here, "yt-dlp.exe")
    try:
        import urllib.request, zipfile, io
        _h()._hlog("info", "fetching yt-dlp (first YouTube use)…")
        req = urllib.request.Request(
            "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_win.zip",
            headers={"User-Agent": "MediaCatcher-Host/%s" % _h().VERSION})
        with urllib.request.urlopen(req, timeout=180) as r:
            blob = r.read()
        with zipfile.ZipFile(io.BytesIO(blob)) as z:
            for name in z.namelist():
                rel = name.replace("\\", "/").lstrip("/")
                # Refuse absolute/traversing members: this unpacks into the host
                # directory, so a crafted archive must not reach outside it.
                if not rel or rel.endswith("/") or ".." in rel.split("/"):
                    continue
                out = os.path.join(here, *rel.split("/"))
                os.makedirs(os.path.dirname(out) or here, exist_ok=True)
                with z.open(name) as src, open(out, "wb") as f:
                    shutil.copyfileobj(src, f)
        if not os.path.isfile(dest):
            raise RuntimeError("yt-dlp.exe missing from archive")
        YTDLP = dest
        _h()._hlog("info", "yt-dlp installed (directory build)")
        return YTDLP
    except Exception as e:
        _h()._hlog("error", "yt-dlp download failed: %s" % e)
        return None


def ensure_deno():
    """Return a path to Deno — the JS runtime yt-dlp needs to solve YouTube's 'n' challenge
    (without it, only storyboard images are downloadable). Fetches the official portable
    build into HERE if missing. ~40MB compressed."""
    global DENO
    if DENO:
        return DENO
    if os.name != "nt":
        return None
    dest = os.path.join(_h().HERE, "deno.exe")
    try:
        import urllib.request, zipfile, io
        _h()._hlog("info", "fetching Deno (JS runtime for YouTube — one-time)…")
        req = urllib.request.Request(
            "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip",
            headers={"User-Agent": "MediaCatcher-Host/%s" % _h().VERSION})
        with urllib.request.urlopen(req, timeout=300) as r:
            blob = r.read()
        with zipfile.ZipFile(io.BytesIO(blob)) as z, z.open("deno.exe") as src, open(dest + ".part", "wb") as f:
            shutil.copyfileobj(src, f)
        os.replace(dest + ".part", dest)
        DENO = dest
        _h()._hlog("info", "Deno installed")
        return DENO
    except Exception as e:
        _h()._hlog("error", "Deno download failed: %s" % e)
        return None


def _pot_server_entry():
    for c in (os.path.join(_h().HERE, "pot-provider", "build", "main.js"),
              os.path.join(_h().HERE, "pot-provider", "server", "build", "main.js"),
              os.path.join(_h().HERE, "pot-provider", "main.js")):
        if os.path.isfile(c):
            return c
    return None


def _pot_alive():
    import socket
    try:
        socket.create_connection(("127.0.0.1", _POT_PORT), timeout=1.5).close()
        return True
    except Exception:
        return False


def start_pot_provider():
    """Ensure the bgutil PO-token HTTP server is running (idempotent). Returns bool."""
    if _pot_alive():
        return True
    entry = _pot_server_entry()
    if not (NODE and entry):
        return False
    cf, si = _no_window()
    try:
        _POT["proc"] = subprocess.Popen([NODE, entry], cwd=os.path.dirname(entry),
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                        creationflags=cf, startupinfo=si)
    except Exception as e:
        _h()._hlog("warn", "PO-token provider failed to start: %s" % e)
        return False
    for _ in range(24):                       # up to ~6s to bind
        time.sleep(0.25)
        if _pot_alive():
            _h()._hlog("info", "PO-token provider ready on :%d" % _POT_PORT)
            return True
    return _pot_alive()


# (regex, reason, friendly message) — yt-dlp's stderr mapped to explicit UI text.
_YT_ERR = [
    (r"sign in to confirm your age|age.?restricted|inappropriate", "age",
     "Age-restricted — sign in to YouTube in Firefox so your cookies unlock it."),
    (r"members[- ]only|available to .*members|join this channel to", "members",
     "Members-only — needs a channel membership on your signed-in account."),
    (r"private video|video is private", "private", "This video is private."),
    (r"premiere|will begin|scheduled", "scheduled", "This is a scheduled premiere — not available yet."),
    (r"n challenge|only images are available|challenge solv|js.?runtime|\bejs\b", "jschallenge",
     "Couldn't solve YouTube's JS challenge — the Deno runtime is installing in the background; give it a moment and retry."),
    (r"requested format is not available|no video formats|po.?token|formats? have been skipped|http error 403", "token",
     "YouTube blocked the high-quality formats (PO-token). yt-dlp may need updating; your log console shows the details."),
    (r"video unavailable|video is unavailable|has been removed|no longer available|not available in your", "unavailable",
     "Video unavailable."),
    (r"drm|protected content|widevine", "drm", "DRM-protected — cannot be downloaded."),
    (r"confirm you.?re not a bot|not a bot|too many requests|http error 429", "bot",
     "YouTube asked to confirm you're not a bot — sign in to YouTube in Firefox, then retry."),
]


def _map_yt_error(text):
    low = (text or "").lower()
    for pat, reason, msg in _YT_ERR:
        if re.search(pat, low):
            return reason, msg
    return "generic", "Download failed — open the log console for yt-dlp's output."


def _yt_stage_note(s):
    """A yt-dlp status line → a short 'what it's doing now' label for the pre-download
    phase (cookies/player/n-challenge/format pick), so the bar isn't a dead 0%."""
    low = s.lower()
    if "cookies from" in low:
        return "Reading cookies"
    if "downloading webpage" in low:
        return "Reading page"
    if "player" in low and "download" in low:
        return "Loading player"
    if "api json" in low or "player api" in low:
        return "Reading video info"
    if "n challenge" in low or "solving" in low or "[jsc" in low:
        return "Solving JS challenge"
    if s.startswith("[info]") and "format" in low:
        return "Choosing format"
    if low.startswith("[download] destination"):   # yt-dlp capitalises "Destination"
        return "Starting download"
    if "m3u8" in low and "download" in low:
        return "Reading streams"
    if s.startswith("[youtube"):
        return "Contacting YouTube"
    if s.startswith("[info]"):
        return "Preparing"
    return ""


def _parse_yt_progress(line):
    # yt-dlp default (--newline): "[download]  42.3% of  229.20MiB at   53.67MiB/s ETA 00:04"
    m = re.search(r"\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+)\s*([KMGT]?)i?B", line)
    if not m:
        return None
    def _bytes(num, unit):
        return int(float(num) * {"K": 1024, "M": 1048576, "G": 1073741824, "T": 1099511627776}.get(unit, 1))
    out = {"stage": "downloading", "pct": float(m.group(1)), "total": _bytes(m.group(2), m.group(3))}
    sm = re.search(r"at\s+([\d.]+)\s*([KMGT]?)i?B/s", line)
    if sm:
        out["bps"] = _bytes(sm.group(1), sm.group(2))
    return out


def _simplify_vcodec(vc):
    """yt-dlp's vcodec strings (av01.0.08M.08, vp09.00.., avc1.640028) → a short label."""
    vc = (vc or "").lower()
    if vc in ("", "none"):
        return ""
    if vc.startswith(("av01", "av1")):
        return "AV1"
    if vc.startswith(("vp9", "vp09")):
        return "VP9"
    if vc.startswith("vp8"):
        return "VP8"
    if vc.startswith(("avc", "h264")):
        return "H.264"
    if vc.startswith(("hev", "hvc", "h265")):
        return "HEVC"
    return vc.split(".")[0].upper()


def handle_ytmeta(req):
    """Probe a yt-dlp URL (yt-dlp -J, no download) for its real formats so the popup
    can show codec/resolution/bitrate/size + a quality picker. Best format per height,
    with a video+audio size estimate. Replies once with a {type:"ytmeta"} message."""
    def worker():
        reqid = req.get("reqId")
        url = req.get("url") or ""
        ytdlp = find_ytdlp()   # display-only; don't self-fetch here — download still can
        if not ytdlp:
            _h().send({"type": "ytmeta", "reqId": reqid, "ok": False, "error": "yt-dlp not installed"})
            return
        deno = DENO or find_deno()
        cmd = [ytdlp, "-J", "--no-warnings", "--no-playlist", "--skip-download",
               "--cookies-from-browser", "firefox"]
        if deno:
            cmd += ["--js-runtimes", "deno:%s" % deno]
        cmd += [url]
        cf, si = _no_window()
        try:
            # Kept under the extension's 60s wait so a completed probe is never orphaned.
            r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               creationflags=cf, startupinfo=si, timeout=45)
        except Exception as e:
            _h().send({"type": "ytmeta", "reqId": reqid, "ok": False, "error": str(e)})
            return
        if r.returncode != 0 or not r.stdout:
            _reason, emsg = _map_yt_error((r.stderr or b"").decode("utf-8", "replace"))
            _h().send({"type": "ytmeta", "reqId": reqid, "ok": False, "error": emsg})
            return
        try:
            info = json.loads(r.stdout.decode("utf-8", "replace"))
        except Exception as e:
            _h().send({"type": "ytmeta", "reqId": reqid, "ok": False, "error": "parse: %s" % e})
            return
        fmts = info.get("formats") or []
        dur = info.get("duration") or 0
        # Best audio-only stream (for the size estimate + an audio-only download option).
        best_a = None
        for f in fmts:
            if f.get("acodec") and f.get("acodec") != "none" and f.get("vcodec") in (None, "none"):
                abr = f.get("abr") or f.get("tbr") or 0
                if not best_a or abr > (best_a.get("abr") or best_a.get("tbr") or 0):
                    best_a = f
        a_size = 0
        if best_a:
            a_size = best_a.get("filesize") or best_a.get("filesize_approx") or 0
            if not a_size and dur:
                a_size = int((best_a.get("abr") or 128) * 1000 / 8 * dur)
        # Best video stream per height.
        by_h = {}
        for f in fmts:
            if not f.get("vcodec") or f.get("vcodec") == "none":
                continue
            h = f.get("height") or 0
            if not h:
                continue
            tbr = f.get("tbr") or f.get("vbr") or 0
            cur = by_h.get(h)
            if not cur or tbr > (cur.get("tbr") or cur.get("vbr") or 0):
                by_h[h] = f
        out = []
        for h in sorted(by_h.keys(), reverse=True):
            f = by_h[h]
            tbr = int(round(f.get("tbr") or f.get("vbr") or 0))
            vsize = f.get("filesize") or f.get("filesize_approx") or 0
            if not vsize and tbr and dur:
                vsize = int(tbr * 1000 / 8 * dur)
            # A muxed/progressive format (itag 18/22) already carries audio, so don't
            # add the separate audio stream again; DASH video-only formats do need it.
            muxed = f.get("acodec") not in (None, "none")
            out.append({
                "height": h,
                "fps": int(f.get("fps") or 0),
                "codec": _simplify_vcodec(f.get("vcodec")),
                "tbr": tbr,                       # kbps
                "size": int((vsize or 0) + (0 if muxed else (a_size or 0))),
                "id": f.get("format_id") or "",
            })
        _h().send({"type": "ytmeta", "reqId": reqid, "ok": True,
              "title": info.get("title") or "",
              "duration": int(dur or 0),
              "thumb": info.get("thumbnail") or "",
              "audioSize": int(a_size or 0),
              "audioAbr": int((best_a or {}).get("abr") or 0),
              "formats": out})
    threading.Thread(target=worker, daemon=True).start()


def _ytdl_exact_nonblank_str(val):
    """True only for a nonblank built-in str (rejects subclasses/wrappers)."""
    return type(val) is str and bool(val.strip())


def _ytdl_control_free_str(val):
    """True when val is a built-in str with no Unicode control characters (Cc).

    Rejects C0 (U+0000–001F), DEL (U+007F), and C1 (U+0080–009F) among others.
    """
    if type(val) is not str:
        return False
    for ch in val:
        if unicodedata.category(ch) == "Cc":
            return False
    return True


def _ytdl_default_outdir():
    """Config saveFolder when set, otherwise the user's Downloads directory."""
    try:
        folder = (_h().load_config().get("saveFolder") or "") or ""
    except Exception:
        folder = ""
    if folder:
        return folder
    return _h().downloads_dir()


def _ytdl_escape_outtmpl(path):
    """Escape % so yt-dlp does not treat user filename characters as templates."""
    return (path or "").replace("%", "%%")


# ---- Structured yt-dlp: Windows handle-owned stage/commit/cleanup ------------
# Pathname hardlink / O_EXCL-copy / lstat-unlink promotion is intentionally gone.
# Token-bound structured commits pin destination + stage + source by handle and
# rename with ntdll NtSetInformationFile(FileRenameInformation) only.

_YTDL_WIN = None
_YTDL_WIN_LOCK = threading.Lock()
_YTDL_DEST_LOCK = threading.Lock()
_YTDL_DEST_LEASES = {}  # canonical path key -> lease dict

# NTSTATUS / Win32 constants used by the structured path.
_YTDL_STATUS_SUCCESS = 0
_YTDL_STATUS_NO_MORE_FILES = 0x80000006
_YTDL_STATUS_OBJECT_NAME_COLLISION = 0xC0000035
_YTDL_STATUS_BUFFER_OVERFLOW = 0x80000005
_YTDL_STATUS_INFO_LENGTH_MISMATCH = 0xC0000004

_YTDL_DELETE = 0x00010000
_YTDL_SYNCHRONIZE = 0x00100000
_YTDL_FILE_LIST_DIRECTORY = 0x0001
_YTDL_FILE_ADD_FILE = 0x0002
_YTDL_FILE_ADD_SUBDIRECTORY = 0x0004
_YTDL_FILE_TRAVERSE = 0x0020
_YTDL_FILE_READ_ATTRIBUTES = 0x0080
_YTDL_FILE_READ_DATA = 0x0001
_YTDL_FILE_WRITE_DATA = 0x0002
_YTDL_FILE_SHARE_READ = 0x00000001
_YTDL_FILE_SHARE_WRITE = 0x00000002
_YTDL_OPEN_EXISTING = 3
_YTDL_FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
_YTDL_FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
_YTDL_FILE_ATTRIBUTE_DIRECTORY = 0x00000010
_YTDL_FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400
_YTDL_FILE_ATTRIBUTE_NORMAL = 0x00000080

_YTDL_FILE_DIRECTORY_FILE = 0x00000001
_YTDL_FILE_NON_DIRECTORY_FILE = 0x00000040
_YTDL_FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020
_YTDL_FILE_OPEN_REPARSE_POINT = 0x00200000
_YTDL_FILE_CREATE = 2
_YTDL_FILE_OPEN = 1
_YTDL_OBJ_CASE_INSENSITIVE = 0x00000040

_YTDL_FileDirectoryInformation = 1  # NtQueryDirectoryFile class; 64-byte header
_YTDL_FileStandardInfo = 1
_YTDL_FileDispositionInfo = 4
_YTDL_FileAttributeTagInfo = 9
_YTDL_FileIdInfo = 18
_YTDL_FileRenameInformation = 10  # NtSetInformationFile class (not Win32 FileRenameInfo=3)
_YTDL_INVALID_HANDLE_VALUE = wintypes.HANDLE(-1).value

# FileDirectoryInformation fixed header: NextEntryOffset@0, FileNameLength@60, FileName@64.
_YTDL_DIR_INFO_HEADER = 64
_YTDL_DIR_INFO_NAME_LEN_OFF = 60
_YTDL_DIR_INFO_NAME_OFF = 64

# Finite cleanup bounds — exhaustion returns False and safely leaks.
_YTDL_CLEANUP_MAX_DEPTH = 64
_YTDL_CLEANUP_MAX_QUERIES = 4096
_YTDL_CLEANUP_MAX_ENTRIES = 65536
_YTDL_CLEANUP_BUF_SIZE = 4096

# DOS device reserved basenames (case-insensitive), including extension variants.
_YTDL_DOS_RESERVED = frozenset(
    ["CON", "PRN", "AUX", "NUL"]
    + ["COM%d" % i for i in range(1, 10)]
    + ["LPT%d" % i for i in range(1, 10)]
)


class _YTDL_UNICODE_STRING(ctypes.Structure):
    _fields_ = [
        ("Length", wintypes.USHORT),
        ("MaximumLength", wintypes.USHORT),
        ("Buffer", ctypes.c_void_p),
    ]


class _YTDL_OBJECT_ATTRIBUTES(ctypes.Structure):
    _fields_ = [
        ("Length", wintypes.ULONG),
        ("RootDirectory", wintypes.HANDLE),
        ("ObjectName", ctypes.POINTER(_YTDL_UNICODE_STRING)),
        ("Attributes", wintypes.ULONG),
        ("SecurityDescriptor", ctypes.c_void_p),
        ("SecurityQualityOfService", ctypes.c_void_p),
    ]


class _YTDL_IO_STATUS_BLOCK(ctypes.Structure):
    _fields_ = [
        ("Status", ctypes.c_long),
        ("Information", ctypes.c_size_t),
    ]


class _YTDL_FILE_ATTRIBUTE_TAG_INFO(ctypes.Structure):
    _fields_ = [
        ("FileAttributes", wintypes.DWORD),
        ("ReparseTag", wintypes.DWORD),
    ]


class _YTDL_FILE_STANDARD_INFO(ctypes.Structure):
    _fields_ = [
        ("AllocationSize", ctypes.c_longlong),
        ("EndOfFile", ctypes.c_longlong),
        ("NumberOfLinks", wintypes.DWORD),
        ("DeletePending", wintypes.BOOLEAN),
        ("Directory", wintypes.BOOLEAN),
    ]


class _YTDL_FILE_ID_INFO(ctypes.Structure):
    _fields_ = [
        ("VolumeSerialNumber", ctypes.c_ulonglong),
        ("FileId", ctypes.c_ubyte * 16),
    ]


class _YTDL_FILE_DISPOSITION_INFO(ctypes.Structure):
    _fields_ = [
        ("DeleteFile", wintypes.BOOLEAN),
    ]


class _YTDL_FILE_RENAME_INFORMATION(ctypes.Structure):
    """Prefix layout for Nt FileRenameInformation (class 10).

    On x64: ReplaceIfExists@0, RootDirectory@8, FileNameLength@16, FileName@20.
    """
    _fields_ = [
        ("ReplaceIfExists", ctypes.c_ubyte),
        ("RootDirectory", wintypes.HANDLE),
        ("FileNameLength", wintypes.ULONG),
        ("FileName", wintypes.WCHAR * 1),
    ]


def _ytdl_rename_info_offsets():
    """Portable FILE_RENAME_INFORMATION field offsets for tests/ABI checks."""
    return {
        "ReplaceIfExists": _YTDL_FILE_RENAME_INFORMATION.ReplaceIfExists.offset,
        "RootDirectory": _YTDL_FILE_RENAME_INFORMATION.RootDirectory.offset,
        "FileNameLength": _YTDL_FILE_RENAME_INFORMATION.FileNameLength.offset,
        "FileName": _YTDL_FILE_RENAME_INFORMATION.FileName.offset,
        "sizeof_prefix": ctypes.sizeof(_YTDL_FILE_RENAME_INFORMATION),
    }


def _ytdl_build_rename_buffer(root_handle, leaf):
    """Build an Nt FileRenameInformation buffer for a relative leaf rename.

    FileNameLength is the exact UTF-16LE byte count excluding any terminator.
    ReplaceIfExists is zero (no-replace). RootDirectory is the pinned dest handle.
    """
    if type(leaf) is not str:
        raise TypeError("leaf")
    enc = leaf.encode("utf-16-le")
    off = _YTDL_FILE_RENAME_INFORMATION.FileName.offset
    size = max(ctypes.sizeof(_YTDL_FILE_RENAME_INFORMATION), off + len(enc))
    buf = ctypes.create_string_buffer(size)
    root_v = wintypes.HANDLE(int(root_handle))
    ctypes.memmove(
        ctypes.addressof(buf) + _YTDL_FILE_RENAME_INFORMATION.RootDirectory.offset,
        ctypes.byref(root_v),
        ctypes.sizeof(wintypes.HANDLE),
    )
    flen = wintypes.ULONG(len(enc))
    ctypes.memmove(
        ctypes.addressof(buf) + _YTDL_FILE_RENAME_INFORMATION.FileNameLength.offset,
        ctypes.byref(flen),
        ctypes.sizeof(wintypes.ULONG),
    )
    if enc:
        ctypes.memmove(ctypes.addressof(buf) + off, enc, len(enc))
    return buf, size, len(enc), enc


def _ytdl_is_dos_device_name(name):
    """True for CON/PRN/AUX/NUL/COM1-9/LPT1-9 including extension variants."""
    if type(name) is not str or not name:
        return False
    stem = name.split(".", 1)[0]
    return stem.upper() in _YTDL_DOS_RESERVED


def _ytdl_is_safe_relative_leaf(name):
    """True for a single built-in nonblank control-free path leaf (no ADS/traversal)."""
    if type(name) is not str or not name or not name.strip():
        return False
    if not _ytdl_control_free_str(name):
        return False
    if name in (".", ".."):
        return False
    if "/" in name or "\\" in name or "\x00" in name:
        return False
    if ":" in name:
        return False
    if name.rstrip(" .") != name:
        return False
    if _ytdl_is_dos_device_name(name):
        return False
    return True


def _ytdl_norm_seps_case(path):
    """Case-insensitive separator normalization that does not collapse components."""
    if type(path) is not str:
        return None
    try:
        return os.path.normcase(path.replace("/", "\\"))
    except Exception:
        return None


def _ytdl_split_dest_path(path):
    """Split an ordinary absolute DOS or UNC path into (root, components).

    Returns None for device/global-root/drive-relative/ADS/control/dot-dot/
    reserved/trailing-dot-space shapes. Components are validated leaves.
    """
    if type(path) is not str or not path or not path.strip():
        return None
    if not _ytdl_control_free_str(path):
        return None
    p = path.replace("/", "\\")
    if p.startswith("\\\\.\\") or p.startswith("\\\\?\\"):
        return None
    if "\x00" in p:
        return None

    root = None
    rest = None
    if p.startswith("\\\\"):
        body = p[2:]
        if not body or body.startswith("\\"):
            return None
        parts = [x for x in body.split("\\")]
        if len(parts) < 2 or not parts[0] or not parts[1]:
            return None
        if any(x == "" for x in parts):
            return None
        server, share = parts[0], parts[1]
        # Server and share are independent Windows components (not bypasses).
        if not _ytdl_is_safe_relative_leaf(server):
            return None
        if not _ytdl_is_safe_relative_leaf(share):
            return None
        root = "\\\\" + server + "\\" + share
        rest = parts[2:]
    else:
        if len(p) < 3 or p[1] != ":" or not p[0].isalpha() or p[2] != "\\":
            return None
        if ":" in p[2:]:
            return None
        root = p[:3]
        rest = [x for x in p[3:].split("\\")] if len(p) > 3 else []
        if rest == [""]:
            rest = []
        elif any(x == "" for x in rest):
            return None

    comps = []
    for c in rest:
        if c in (".", ".."):
            return None
        if not _ytdl_is_safe_relative_leaf(c):
            return None
        comps.append(c)
    return root, comps


def _ytdl_is_allowed_dest_path(path):
    """Ordinary absolute DOS drive or UNC share path suitable for Save As."""
    return _ytdl_split_dest_path(path) is not None


def _ytdl_is_local_abs_win_path(path):
    """Backward-compatible name: allowed structured destination path shapes."""
    return _ytdl_is_allowed_dest_path(path)


def _ytdl_canon_path_key(path):
    try:
        return os.path.normcase(os.path.abspath(path))
    except Exception:
        return None


def _ytdl_display_join(base, leaf):
    """Join base display path with a single leaf using native separators."""
    if type(base) is not str or type(leaf) is not str:
        raise TypeError("display join")
    b = base.replace("/", "\\")
    if b.endswith("\\"):
        return b + leaf
    return b + "\\" + leaf


class _YtdlWinApi:
    """Lazy kernel32/ntdll binding. Import of downloads.py must stay non-Windows-safe."""

    def __init__(self):
        self.k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self.ntdll = ctypes.WinDLL("ntdll", use_last_error=True)

        self.k32.CreateFileW.argtypes = [
            wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
            wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
        ]
        self.k32.CreateFileW.restype = wintypes.HANDLE

        self.k32.CloseHandle.argtypes = [wintypes.HANDLE]
        self.k32.CloseHandle.restype = wintypes.BOOL

        self.k32.GetCurrentProcess.argtypes = []
        self.k32.GetCurrentProcess.restype = wintypes.HANDLE

        self.k32.DuplicateHandle.argtypes = [
            wintypes.HANDLE, wintypes.HANDLE, wintypes.HANDLE,
            ctypes.POINTER(wintypes.HANDLE), wintypes.DWORD,
            wintypes.BOOL, wintypes.DWORD,
        ]
        self.k32.DuplicateHandle.restype = wintypes.BOOL

        self.k32.GetFileInformationByHandleEx.argtypes = [
            wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
        ]
        self.k32.GetFileInformationByHandleEx.restype = wintypes.BOOL

        self.k32.SetFileInformationByHandle.argtypes = [
            wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
        ]
        self.k32.SetFileInformationByHandle.restype = wintypes.BOOL

        self.k32.GetFinalPathNameByHandleW.argtypes = [
            wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD,
        ]
        self.k32.GetFinalPathNameByHandleW.restype = wintypes.DWORD

        self.ntdll.NtCreateFile.argtypes = [
            ctypes.POINTER(wintypes.HANDLE), wintypes.ULONG,
            ctypes.POINTER(_YTDL_OBJECT_ATTRIBUTES),
            ctypes.POINTER(_YTDL_IO_STATUS_BLOCK),
            ctypes.c_void_p, wintypes.ULONG, wintypes.ULONG, wintypes.ULONG,
            wintypes.ULONG, ctypes.c_void_p, wintypes.ULONG,
        ]
        self.ntdll.NtCreateFile.restype = ctypes.c_long

        self.ntdll.NtSetInformationFile.argtypes = [
            wintypes.HANDLE, ctypes.POINTER(_YTDL_IO_STATUS_BLOCK),
            ctypes.c_void_p, wintypes.ULONG, wintypes.ULONG,
        ]
        self.ntdll.NtSetInformationFile.restype = ctypes.c_long

        self.ntdll.NtQueryDirectoryFile.argtypes = [
            wintypes.HANDLE, wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p,
            ctypes.POINTER(_YTDL_IO_STATUS_BLOCK), ctypes.c_void_p, wintypes.ULONG,
            wintypes.ULONG, wintypes.BOOLEAN, ctypes.POINTER(_YTDL_UNICODE_STRING),
            wintypes.BOOLEAN,
        ]
        self.ntdll.NtQueryDirectoryFile.restype = ctypes.c_long

        self.ntdll.RtlNtStatusToDosError.argtypes = [ctypes.c_long]
        self.ntdll.RtlNtStatusToDosError.restype = wintypes.ULONG


def _ytdl_winapi():
    """Return the shared WinAPI wrapper, or None if unavailable on this host."""
    global _YTDL_WIN
    if _YTDL_WIN is not None:
        return _YTDL_WIN if _YTDL_WIN is not False else None
    with _YTDL_WIN_LOCK:
        if _YTDL_WIN is not None:
            return _YTDL_WIN if _YTDL_WIN is not False else None
        if os.name != "nt":
            _YTDL_WIN = False
            return None
        try:
            _YTDL_WIN = _YtdlWinApi()
        except Exception:
            _YTDL_WIN = False
            return None
        return _YTDL_WIN


def _ytdl_close_handle(handle):
    """Close an owned raw handle once. Returns True only on BOOL success.

    CloseHandle FALSE or any exception returns False. Callers that own the
    handle must treat False as cleanup failure and must not retry the same
    integer.
    """
    if not handle:
        return True
    api = _ytdl_winapi()
    if not api:
        return False
    try:
        # Pass a primitive integer so both real ctypes CloseHandle and
        # Python-level BOOL doubles accept the same exact-once value.
        hv = int(handle)
        ok = api.k32.CloseHandle(hv)
        return bool(ok)
    except Exception:
        return False


def _ytdl_set_disposition_delete(handle):
    """Mark the exact held object for delete-on-close. Never path-based."""
    if not handle:
        return False
    api = _ytdl_winapi()
    if not api:
        return False
    info = _YTDL_FILE_DISPOSITION_INFO()
    info.DeleteFile = True
    try:
        ok = api.k32.SetFileInformationByHandle(
            wintypes.HANDLE(int(handle)),
            _YTDL_FileDispositionInfo,
            ctypes.byref(info),
            ctypes.sizeof(info),
        )
        return bool(ok)
    except Exception:
        return False


def _ytdl_query_tag_std(handle):
    """Return (attrs, is_dir, delete_pending, is_reparse, std) or None."""
    api = _ytdl_winapi()
    if not api or not handle:
        return None
    tag = _YTDL_FILE_ATTRIBUTE_TAG_INFO()
    std = _YTDL_FILE_STANDARD_INFO()
    try:
        if not api.k32.GetFileInformationByHandleEx(
            wintypes.HANDLE(int(handle)), _YTDL_FileAttributeTagInfo,
            ctypes.byref(tag), ctypes.sizeof(tag),
        ):
            return None
        if not api.k32.GetFileInformationByHandleEx(
            wintypes.HANDLE(int(handle)), _YTDL_FileStandardInfo,
            ctypes.byref(std), ctypes.sizeof(std),
        ):
            return None
    except Exception:
        return None
    attrs = int(tag.FileAttributes)
    is_reparse = bool(attrs & _YTDL_FILE_ATTRIBUTE_REPARSE_POINT)
    is_dir = bool(std.Directory) or bool(attrs & _YTDL_FILE_ATTRIBUTE_DIRECTORY)
    delete_pending = bool(std.DeletePending)
    return attrs, is_dir, delete_pending, is_reparse, std


def _ytdl_query_file_id(handle):
    api = _ytdl_winapi()
    if not api or not handle:
        return None
    info = _YTDL_FILE_ID_INFO()
    try:
        if not api.k32.GetFileInformationByHandleEx(
            wintypes.HANDLE(int(handle)), _YTDL_FileIdInfo,
            ctypes.byref(info), ctypes.sizeof(info),
        ):
            return None
    except Exception:
        return None
    serial = int(info.VolumeSerialNumber)
    fid = bytes(info.FileId)
    if serial == 0 and fid == b"\x00" * 16:
        return None
    return serial, fid


def _ytdl_final_path(handle):
    """Optional diagnostic GetFinalPathNameByHandleW; never authority for validation."""
    api = _ytdl_winapi()
    if not api or not handle:
        return None
    try:
        buflen = 512
        while buflen <= 32768:
            buf = ctypes.create_unicode_buffer(buflen)
            n = api.k32.GetFinalPathNameByHandleW(
                wintypes.HANDLE(int(handle)), buf, buflen, 0
            )
            if n == 0:
                return None
            if n < buflen:
                return buf.value
            buflen = int(n) + 2
    except Exception:
        return None
    return None


def _ytdl_paths_compatible(requested_abs, final_path):
    """Best-effort check that a final path names the same local location."""
    if type(requested_abs) is not str or type(final_path) is not str:
        return False
    try:
        a = os.path.normcase(os.path.abspath(requested_abs))
        b = final_path
        if b.startswith("\\\\?\\UNC\\"):
            b = "\\\\" + b[8:]
        elif b.startswith("\\\\?\\"):
            b = b[4:]
        b = os.path.normcase(os.path.abspath(b))
        return a == b
    except Exception:
        return False


def _ytdl_make_unicode_string(leaf, keep):
    """Build UNICODE_STRING for a relative leaf; keep holds the buffer alive.

    Length/MaximumLength use the exact UTF-16LE byte length (surrogate-aware),
    not Python code-point count.
    """
    if type(leaf) is not str:
        raise TypeError("leaf")
    enc = leaf.encode("utf-16-le")
    raw = ctypes.create_string_buffer(len(enc) + 2)
    if enc:
        ctypes.memmove(raw, enc, len(enc))
    us = _YTDL_UNICODE_STRING()
    us.Length = len(enc)
    us.MaximumLength = len(enc) + 2
    us.Buffer = ctypes.addressof(raw)
    keep.append(raw)
    return us


def _ytdl_nt_create_relative(
    root_handle, leaf, desired_access, share_access, create_disposition, create_options,
    file_attributes=0,
):
    """NtCreateFile relative to root_handle for a single safe leaf. Returns handle or None."""
    h, code = _ytdl_nt_create_relative_status(
        root_handle, leaf, desired_access, share_access, create_disposition,
        create_options, file_attributes=file_attributes,
    )
    return h


def _ytdl_nt_create_relative_status(
    root_handle, leaf, desired_access, share_access, create_disposition, create_options,
    file_attributes=0,
):
    """Like _ytdl_nt_create_relative but returns (handle_or_None, ntstatus_code)."""
    api = _ytdl_winapi()
    if not api or not root_handle:
        return None, 0xC0000001
    if not _ytdl_is_safe_relative_leaf(leaf):
        return None, 0xC0000001
    keep = []
    try:
        us = _ytdl_make_unicode_string(leaf, keep)
        oa = _YTDL_OBJECT_ATTRIBUTES()
        oa.Length = ctypes.sizeof(_YTDL_OBJECT_ATTRIBUTES)
        oa.RootDirectory = wintypes.HANDLE(int(root_handle))
        oa.ObjectName = ctypes.pointer(us)
        oa.Attributes = _YTDL_OBJ_CASE_INSENSITIVE
        oa.SecurityDescriptor = None
        oa.SecurityQualityOfService = None
        iosb = _YTDL_IO_STATUS_BLOCK()
        handle = wintypes.HANDLE()
        status = api.ntdll.NtCreateFile(
            ctypes.byref(handle),
            int(desired_access),
            ctypes.byref(oa),
            ctypes.byref(iosb),
            None,
            int(file_attributes),
            int(share_access),
            int(create_disposition),
            int(create_options),
            None,
            0,
        )
        code = status & 0xFFFFFFFF
        if code != _YTDL_STATUS_SUCCESS:
            return None, code
        return int(handle.value), code
    except Exception:
        return None, 0xC0000001


def _ytdl_validate_dir_handle(handle):
    """Require disk directory, non-reparse, non-delete-pending. FileId required."""
    meta = _ytdl_query_tag_std(handle)
    if meta is None:
        return False
    _attrs, is_dir, delete_pending, is_reparse, _std = meta
    if not is_dir or delete_pending or is_reparse:
        return False
    if _ytdl_query_file_id(handle) is None:
        return False
    return True


def _ytdl_dir_access_min():
    """Traverse/list access sufficient to pin an ancestor without SHARE_DELETE."""
    return (
        _YTDL_FILE_LIST_DIRECTORY
        | _YTDL_FILE_TRAVERSE
        | _YTDL_FILE_READ_ATTRIBUTES
        | _YTDL_SYNCHRONIZE
    )


def _ytdl_dir_access_full():
    """Full dir access for create/rename-root/stage parents when granted."""
    return (
        _YTDL_DELETE
        | _YTDL_FILE_LIST_DIRECTORY
        | _YTDL_FILE_ADD_FILE
        | _YTDL_FILE_ADD_SUBDIRECTORY
        | _YTDL_FILE_TRAVERSE
        | _YTDL_FILE_READ_ATTRIBUTES
        | _YTDL_SYNCHRONIZE
    )


def _ytdl_open_path_root(root_display):
    """Open a DOS drive root or UNC share root with no SHARE_DELETE.

    Drive roots commonly deny DELETE/ADD; open with traverse/list only and
    BACKUP_SEMANTICS. Always OPEN_REPARSE_POINT; never retry without it.
    """
    api = _ytdl_winapi()
    if not api or type(root_display) is not str:
        return None
    access = _ytdl_dir_access_min()
    share = _YTDL_FILE_SHARE_READ | _YTDL_FILE_SHARE_WRITE
    flags = (
        _YTDL_FILE_FLAG_BACKUP_SEMANTICS
        | _YTDL_FILE_FLAG_OPEN_REPARSE_POINT
    )
    try:
        h = api.k32.CreateFileW(
            root_display, access, share, None, _YTDL_OPEN_EXISTING, flags, None,
        )
    except Exception:
        return None
    hv = int(h) if h else 0
    if not hv or hv == int(_YTDL_INVALID_HANDLE_VALUE):
        return None
    if not _ytdl_validate_dir_handle(hv):
        _ytdl_close_handle(hv)
        return None
    return hv


def _ytdl_open_or_create_component(parent_handle, leaf):
    """Open existing or atomically create a directory component relative to parent.

    Never exists-checks via pathname. On FILE_CREATE name collision, reopen + validate.
    Prefer full access; fall back to traverse/list when the object denies ADD/DELETE.
    Every open uses FILE_OPEN_REPARSE_POINT; never retry without it.
    """
    share = _YTDL_FILE_SHARE_READ | _YTDL_FILE_SHARE_WRITE
    options_open = (
        _YTDL_FILE_DIRECTORY_FILE
        | _YTDL_FILE_SYNCHRONOUS_IO_NONALERT
        | _YTDL_FILE_OPEN_REPARSE_POINT
    )

    def _try_open(desired, options):
        return _ytdl_nt_create_relative(
            parent_handle, leaf, desired, share, _YTDL_FILE_OPEN, options,
        )

    h = None
    for desired in (_ytdl_dir_access_full(), _ytdl_dir_access_min()):
        h = _try_open(desired, options_open)
        if h:
            break
    if h:
        if not _ytdl_validate_dir_handle(h):
            _ytdl_close_handle(h)
            return None
        return h

    # Missing: atomic create with full access.
    options_create = (
        _YTDL_FILE_DIRECTORY_FILE
        | _YTDL_FILE_SYNCHRONOUS_IO_NONALERT
        | _YTDL_FILE_OPEN_REPARSE_POINT
    )
    h, code = _ytdl_nt_create_relative_status(
        parent_handle, leaf, _ytdl_dir_access_full(), share,
        _YTDL_FILE_CREATE, options_create,
        file_attributes=_YTDL_FILE_ATTRIBUTE_DIRECTORY,
    )
    if h:
        if not _ytdl_validate_dir_handle(h):
            _ytdl_set_disposition_delete(h)
            _ytdl_close_handle(h)
            return None
        return h
    if code == _YTDL_STATUS_OBJECT_NAME_COLLISION:
        # Collision: only the same reparse-aware open + revalidate.
        for desired in (_ytdl_dir_access_full(), _ytdl_dir_access_min()):
            h = _try_open(desired, options_open)
            if h:
                break
        if not h:
            return None
        if not _ytdl_validate_dir_handle(h):
            _ytdl_close_handle(h)
            return None
        return h
    return None


def _ytdl_close_chain(chain):
    """Close handles in reverse order exactly once."""
    if not chain:
        return
    for h in reversed(list(chain)):
        if h:
            _ytdl_close_handle(h)


def _ytdl_acquire_dest_lease(out_path):
    """Pin the full destination directory chain by handle with process-local refcount.

    Opens the immutable drive/UNC root, then each component relative to its retained
    parent (FILE_OPEN + OPEN_REPARSE_POINT, no SHARE_DELETE). Missing components are
    created with FILE_CREATE|FILE_DIRECTORY_FILE (collision -> reopen). Never uses
    os.makedirs. GetFinalPathNameByHandleW is diagnostic only.
    """
    api = _ytdl_winapi()
    if not api:
        return None
    split = _ytdl_split_dest_path(out_path)
    if split is None:
        return None
    root_display, components = split
    display = root_display
    for c in components:
        display = _ytdl_display_join(display, c)
    key = _ytdl_canon_path_key(display)
    if not key:
        return None

    with _YTDL_DEST_LOCK:
        existing = _YTDL_DEST_LEASES.get(key)
        if existing and existing.get("handle") and existing.get("refcount", 0) > 0:
            existing["refcount"] += 1
            return existing

        chain = []
        try:
            root_h = _ytdl_open_path_root(root_display)
            if not root_h:
                return None
            chain.append(root_h)
            parent = root_h
            for leaf in components:
                child = _ytdl_open_or_create_component(parent, leaf)
                if not child:
                    _ytdl_close_chain(chain)
                    return None
                chain.append(child)
                parent = child
            final_h = chain[-1]
            try:
                _ytdl_final_path(final_h)
            except Exception:
                pass

            lease = {
                "key": key,
                "handle": final_h,
                "chain": list(chain),
                "refcount": 1,
                "display_path": display,
                "closed": False,
            }
            _YTDL_DEST_LEASES[key] = lease
            return lease
        except Exception:
            _ytdl_close_chain(chain)
            return None


def _ytdl_release_dest_lease(lease):
    if not lease or not isinstance(lease, dict):
        return
    with _YTDL_DEST_LOCK:
        key = lease.get("key")
        cur = _YTDL_DEST_LEASES.get(key) if key else None
        if cur is not lease:
            if lease.get("closed"):
                return
            rc = int(lease.get("refcount") or 0) - 1
            if rc < 0:
                rc = 0
            lease["refcount"] = rc
            if rc == 0 and not lease.get("closed"):
                lease["closed"] = True
                chain = list(lease.get("chain") or [])
                lease["handle"] = None
                lease["chain"] = []
                if chain:
                    _ytdl_close_chain(chain)
            return
        rc = int(cur.get("refcount") or 0) - 1
        if rc < 0:
            rc = 0
        cur["refcount"] = rc
        if rc == 0:
            _YTDL_DEST_LEASES.pop(key, None)
            cur["closed"] = True
            chain = list(cur.get("chain") or [])
            cur["handle"] = None
            cur["chain"] = []
            if chain:
                _ytdl_close_chain(chain)


def _ytdl_create_stage_dir(dest_lease):
    """Create `.mc-ytdl-<uuid>` relative to the pinned final destination handle."""
    if not dest_lease or not dest_lease.get("handle"):
        return None, None, None
    leaf = ".mc-ytdl-%s" % uuid.uuid4().hex
    if not _ytdl_is_safe_relative_leaf(leaf):
        return None, None, None
    desired = (
        _YTDL_DELETE
        | _YTDL_FILE_LIST_DIRECTORY
        | _YTDL_FILE_TRAVERSE
        | _YTDL_FILE_READ_ATTRIBUTES
        | _YTDL_SYNCHRONIZE
    )
    share = _YTDL_FILE_SHARE_READ | _YTDL_FILE_SHARE_WRITE
    options = (
        _YTDL_FILE_DIRECTORY_FILE
        | _YTDL_FILE_SYNCHRONOUS_IO_NONALERT
        | _YTDL_FILE_OPEN_REPARSE_POINT
    )
    h = _ytdl_nt_create_relative(
        dest_lease["handle"], leaf, desired, share,
        _YTDL_FILE_CREATE, options,
        file_attributes=_YTDL_FILE_ATTRIBUTE_DIRECTORY,
    )
    if not h:
        return None, None, None
    if not _ytdl_validate_dir_handle(h):
        _ytdl_set_disposition_delete(h)
        _ytdl_close_handle(h)
        return None, None, None
    display = _ytdl_display_join(dest_lease["display_path"], leaf)
    return h, leaf, display


def _ytdl_raw_direct_child_leaf(parent_display, child_path):
    """Return leaf if child_path is an exact absolute direct child of parent_display.

    Rejects raw dot/dotdot/nested/ADS/relative/device/trailing-dot-space forms
    before any NtCreateFile. Case-insensitive separator normalization only —
    does not collapse components via abspath.
    """
    if type(parent_display) is not str or type(child_path) is not str:
        return None
    if not child_path or not child_path.strip():
        return None
    if not _ytdl_control_free_str(child_path):
        return None
    c = child_path.replace("/", "\\")
    if c.startswith("\\\\.\\") or c.startswith("\\\\?\\"):
        return None
    is_unc = c.startswith("\\\\")
    is_drive = len(c) >= 3 and c[1] == ":" and c[0].isalpha() and c[2] == "\\"
    if not is_unc and not is_drive:
        return None
    if is_drive and ":" in c[2:]:
        return None
    if c.endswith("\\") or c.endswith(" "):
        return None
    idx = c.rfind("\\")
    if idx < 0:
        return None
    raw_parent = c[:idx]
    leaf = c[idx + 1:]
    if not leaf:
        return None
    pn = _ytdl_norm_seps_case(parent_display.rstrip("\\/"))
    cn = _ytdl_norm_seps_case(raw_parent.rstrip("\\/"))
    if pn is None or cn is None or pn != cn:
        return None
    if not _ytdl_is_safe_relative_leaf(leaf):
        return None
    return leaf


def _ytdl_open_stage_source(stage_handle, stage_display, filepath):
    """Open @@FILE@@ as a direct child of the pinned stage handle.

    Returns dict(handle, size, leaf) or None. Handle authority only — no path
    stat/lstat/realpath/getsize after open. Raw marker must be an exact absolute
    direct child; abspath is never used to normalize traversal away.
    """
    if not stage_handle or type(stage_display) is not str:
        return None
    leaf = _ytdl_raw_direct_child_leaf(stage_display, filepath)
    if leaf is None:
        return None

    desired = (
        _YTDL_FILE_READ_DATA
        | _YTDL_FILE_READ_ATTRIBUTES
        | _YTDL_DELETE
        | _YTDL_SYNCHRONIZE
    )
    share = _YTDL_FILE_SHARE_READ
    options = (
        _YTDL_FILE_NON_DIRECTORY_FILE
        | _YTDL_FILE_SYNCHRONOUS_IO_NONALERT
        | _YTDL_FILE_OPEN_REPARSE_POINT
    )
    h = _ytdl_nt_create_relative(
        stage_handle, leaf, desired, share, _YTDL_FILE_OPEN, options,
    )
    if not h:
        return None
    meta = _ytdl_query_tag_std(h)
    if meta is None:
        _ytdl_close_handle(h)
        return None
    attrs, is_dir, delete_pending, is_reparse, std = meta
    if is_dir or delete_pending or is_reparse:
        _ytdl_close_handle(h)
        return None
    if bool(attrs & _YTDL_FILE_ATTRIBUTE_REPARSE_POINT):
        _ytdl_close_handle(h)
        return None
    if int(std.NumberOfLinks) != 1:
        _ytdl_close_handle(h)
        return None
    eof = int(std.EndOfFile)
    if type(eof) is not int or eof < 0:
        _ytdl_close_handle(h)
        return None
    if _ytdl_query_file_id(h) is None:
        _ytdl_close_handle(h)
        return None
    return {"handle": h, "size": eof, "leaf": leaf}


def _ytdl_candidate_leaves(safe_name, max_attempts=32):
    """Bounded single-leaf candidates: name, name (1).ext, ... (max 32)."""
    if not _ytdl_is_safe_relative_leaf(safe_name):
        return []
    root, ext = os.path.splitext(safe_name)
    out = [safe_name]
    limit = max(1, int(max_attempts))
    for n in range(1, limit):
        cand = "%s (%d)%s" % (root, n, ext)
        if _ytdl_is_safe_relative_leaf(cand):
            out.append(cand)
    return out[:limit]


def _ytdl_prebuild_commit_candidates(dest_lease, safe_name, max_attempts=32):
    """Prebuild rename buffers and display paths before acquiring ytdl_lock.

    Every leaf, UTF-16 rename buffer, and full display path is constructed here
    so the lock-held commit path never performs path construction after NT success.
    """
    if not dest_lease or not dest_lease.get("handle"):
        return []
    base = dest_lease.get("display_path")
    dest_h = dest_lease["handle"]
    if type(base) is not str:
        return []
    leaves = _ytdl_candidate_leaves(safe_name, max_attempts=max_attempts)
    out = []
    for leaf in leaves:
        try:
            buf, size, flen, enc = _ytdl_build_rename_buffer(dest_h, leaf)
            display = _ytdl_display_join(base, leaf)
        except Exception:
            return []
        if type(display) is not str or not display:
            return []
        out.append({
            "leaf": leaf,
            "buf": buf,
            "size": size,
            "display": display,
            "flen": flen,
            "enc": enc,
        })
    return out


def _ytdl_nt_rename_no_replace(source_handle, dest_handle, leaf):
    """NtSetInformationFile FileRenameInformation=10 relative no-replace rename.

    Returns 'ok', 'collision', or 'error'. Never uses Win32 FileRenameInfo=3.
    """
    api = _ytdl_winapi()
    if not api or not source_handle or not dest_handle:
        return "error"
    if not _ytdl_is_safe_relative_leaf(leaf):
        return "error"
    try:
        buf, size, _flen, _enc = _ytdl_build_rename_buffer(dest_handle, leaf)
        iosb = _YTDL_IO_STATUS_BLOCK()
        status = api.ntdll.NtSetInformationFile(
            wintypes.HANDLE(int(source_handle)),
            ctypes.byref(iosb),
            buf,
            int(size),
            _YTDL_FileRenameInformation,
        )
        code = status & 0xFFFFFFFF
        if code == _YTDL_STATUS_SUCCESS:
            return "ok"
        if code == _YTDL_STATUS_OBJECT_NAME_COLLISION:
            return "collision"
        return "error"
    except Exception:
        return "error"


def _ytdl_commit_with_candidates(source_handle, candidates, op=None):
    """Lock-held bounded no-replace commit using prebuilt candidates.

    Before each rename attempt, when op is provided, store the prebuilt display
    path as pending claim metadata. On NT success, `op['commit_claimed'] = True`
    and `op['claimed_path']` are set as the immediately adjacent Python state
    mutation before any fallible path construction, allocation, helper return
    transfer, diagnostic, logging, cleanup, or lock release.
    Returns the prebuilt display path on success, or None.
    """
    api = _ytdl_winapi()
    if not api or not source_handle or not candidates:
        return None
    for cand in candidates:
        buf = cand.get("buf")
        size = cand.get("size")
        display = cand.get("display")
        if buf is None or not size or type(display) is not str:
            return None
        # Authoritative prebuilt display path is staged before the rename so a
        # post-claim return-transfer fault still has nonfallible claim metadata.
        if op is not None:
            op["pending_claim_path"] = display
        try:
            iosb = _YTDL_IO_STATUS_BLOCK()
            status = api.ntdll.NtSetInformationFile(
                wintypes.HANDLE(int(source_handle)),
                ctypes.byref(iosb),
                buf,
                int(size),
                _YTDL_FileRenameInformation,
            )
            code = status & 0xFFFFFFFF
        except Exception:
            return None
        if code == _YTDL_STATUS_SUCCESS:
            if op is not None:
                # Adjacent claim: rename success + claimed path/size authority.
                op["claimed_path"] = display
                op["commit_claimed"] = True
            return display
        if code == _YTDL_STATUS_OBJECT_NAME_COLLISION:
            continue
        return None
    return None


def _ytdl_commit_source(source_handle, dest_lease, safe_name, max_attempts=32, op=None):
    """Atomic bounded no-replace commit.

    Prefer calling _ytdl_prebuild_commit_candidates outside the lock, then
    _ytdl_commit_with_candidates under the lock. This helper still prebuilds
    first (before any rename) so post-rename path construction cannot run.
    On success returns the prebuilt display path and leaves source_handle open
    on the committed object. On failure returns None.
    """
    candidates = _ytdl_prebuild_commit_candidates(
        dest_lease, safe_name, max_attempts=max_attempts,
    )
    if not candidates:
        return None
    return _ytdl_commit_with_candidates(source_handle, candidates, op=op)


def _ytdl_duplicate_readonly_pin(handle):
    """Duplicate a read/attributes pin of an open file handle (no DELETE).

    Used after commit so a later close-accounting fault can leak the pin without
    holding DELETE access that blocks ordinary readers of the final path.
    Returns a new owned handle integer, or None.
    """
    if not handle:
        return None
    api = _ytdl_winapi()
    if not api:
        return None
    desired = (
        _YTDL_FILE_READ_DATA
        | _YTDL_FILE_READ_ATTRIBUTES
        | _YTDL_SYNCHRONIZE
    )
    out = wintypes.HANDLE()
    try:
        ok = api.k32.DuplicateHandle(
            api.k32.GetCurrentProcess(),
            wintypes.HANDLE(int(handle)),
            api.k32.GetCurrentProcess(),
            ctypes.byref(out),
            desired,
            False,
            0,
        )
    except Exception:
        return None
    if not ok:
        return None
    hv = int(out.value) if out else 0
    if not hv or hv == int(_YTDL_INVALID_HANDLE_VALUE):
        return None
    return hv


def _ytdl_adopt_committed_pin(source_handle):
    """After claim, prefer a read-only pin and consume the DELETE-capable handle.

    Performs at most one close attempt on the original handle here. Returns the
    handle the worker should hold through the terminal:
      - pin, when the original close succeeded or reported FALSE (consumed)
      - original, when close raised (ownership not confirmed released; worker
        will attempt one later close via dispose)
      - original, when no pin could be created
    """
    # Exact-handle validation (no truthiness traps: 0 / INVALID are not owned).
    if source_handle is None:
        return None
    try:
        source_hv = int(source_handle)
    except (TypeError, ValueError):
        return None
    if source_hv == 0 or source_hv == int(_YTDL_INVALID_HANDLE_VALUE):
        return None

    pin = None
    try:
        pin = _ytdl_duplicate_readonly_pin(source_handle)
    except Exception:
        # Duplication fault: retain the original committed handle; never close it here.
        return source_handle

    pin_hv = None
    if pin is not None:
        try:
            pin_hv = int(pin)
        except (TypeError, ValueError):
            pin_hv = None
    if (
        pin_hv is None
        or pin_hv == 0
        or pin_hv == int(_YTDL_INVALID_HANDLE_VALUE)
    ):
        # No valid replacement pin: keep original ownership through terminal.
        return source_handle

    # Only with a valid replacement may we attempt the single original close.
    raised = False
    try:
        _ytdl_close_handle(source_handle)
    except Exception:
        raised = True
    if raised:
        # Close accounting raised before a confirmed release: keep original for
        # exactly one later worker-level dispose; drop the unused pin once.
        try:
            _ytdl_close_handle(pin_hv)
        except Exception:
            pass
        return source_handle
    # TRUE or FALSE: one close attempt consumed on original; hold the pin.
    return pin_hv


def _ytdl_dispose_handle(handle, delete=False):
    """Exact-once close; optional disposition-delete first.

    Ownership is consumed before the single close attempt. CloseHandle FALSE or
    an exception must not retry the same raw handle integer. Best-effort only —
    never pathname delete, never demote a commit-claimed final.
    """
    if not handle:
        return
    # Consume ownership first so exception/FALSE cannot re-enter the same handle.
    h = int(handle)
    try:
        if delete:
            try:
                _ytdl_set_disposition_delete(h)
            except Exception:
                pass
        _ytdl_close_handle(h)
    except Exception:
        pass


def _ytdl_parse_dir_info_entries(buf, info):
    """Strict bounded FileDirectoryInformation parser over exact Information bytes.

    Yields decoded names. Returns None on any malformed/truncated/nonterminated
    frame, loop, or alignment fault. The final in-buffer record must have
    NextEntryOffset == 0; a nonzero offset may never land exactly at end.
    """
    if info is None:
        return None
    try:
        info = int(info)
    except Exception:
        return None
    if info < 0 or info > _YTDL_CLEANUP_BUF_SIZE:
        return None
    if info == 0:
        return []
    names = []
    offset = 0
    seen_offsets = set()
    terminated = False
    while offset < info:
        if offset in seen_offsets:
            return None
        seen_offsets.add(offset)
        if offset + _YTDL_DIR_INFO_HEADER > info:
            return None
        if (offset & 7) != 0:
            return None
        next_off = int.from_bytes(bytes(buf[offset:offset + 4]), "little")
        name_len = int.from_bytes(
            bytes(buf[offset + _YTDL_DIR_INFO_NAME_LEN_OFF:
                      offset + _YTDL_DIR_INFO_NAME_LEN_OFF + 4]),
            "little",
        )
        if name_len <= 0 or (name_len & 1) != 0:
            return None
        name_off = offset + _YTDL_DIR_INFO_NAME_OFF
        entry_end = name_off + name_len
        if entry_end > info:
            return None
        try:
            name = bytes(buf[name_off:name_off + name_len]).decode("utf-16-le")
        except Exception:
            return None
        names.append(name)
        if next_off == 0:
            leftover = info - entry_end
            if leftover < 0 or leftover > 7:
                return None
            terminated = True
            break
        if next_off < _YTDL_DIR_INFO_HEADER or (next_off & 7) != 0:
            return None
        # Nonzero offset must leave room for another record; never land at end.
        if offset + next_off >= info:
            return None
        if next_off < (entry_end - offset):
            return None
        offset += next_off
    if not terminated:
        return None
    if len(names) > _YTDL_CLEANUP_MAX_ENTRIES:
        return None
    return names


def _ytdl_dir_is_empty(dir_handle, api):
    """Recheck directory emptiness from the handle. Returns True/False/None(uncertain)."""
    buf = ctypes.create_string_buffer(_YTDL_CLEANUP_BUF_SIZE)
    iosb = _YTDL_IO_STATUS_BLOCK()
    try:
        status = api.ntdll.NtQueryDirectoryFile(
            wintypes.HANDLE(int(dir_handle)),
            None, None, None,
            ctypes.byref(iosb),
            buf, _YTDL_CLEANUP_BUF_SIZE,
            _YTDL_FileDirectoryInformation,
            False,
            None,
            True,
        )
    except Exception:
        return None
    code = status & 0xFFFFFFFF
    if code == _YTDL_STATUS_NO_MORE_FILES:
        return True
    if code not in (_YTDL_STATUS_SUCCESS, _YTDL_STATUS_BUFFER_OVERFLOW):
        return None
    info = int(iosb.Information)
    names = _ytdl_parse_dir_info_entries(buf, info)
    if names is None:
        return None
    for name in names:
        if name not in (".", ".."):
            return False
    return True


def _ytdl_cleanup_stage_tree(stage_handle):
    """Handle-relative stage cleanup. Safe-leak on any uncertainty.

    Enumerates via NtQueryDirectoryFile FileDirectoryInformation (class 1) with
    strict Information bounds. Opens each child with OPEN_REPARSE_POINT + DELETE,
    disposes reparse as the reparse object (never traverse), recurses only
    non-reparse directories, checks every disposition result, rechecks emptiness
    before disposing directories. Returns True only when fully disposed.
    """
    if not stage_handle:
        return True
    api = _ytdl_winapi()
    if not api:
        _ytdl_close_handle(stage_handle)
        return False

    stats = {"queries": 0, "entries": 0}

    def _enum_and_clean(dir_handle, depth=0):
        if depth > _YTDL_CLEANUP_MAX_DEPTH:
            return False
        restart = True
        while True:
            if stats["queries"] >= _YTDL_CLEANUP_MAX_QUERIES:
                return False
            stats["queries"] += 1
            buf = ctypes.create_string_buffer(_YTDL_CLEANUP_BUF_SIZE)
            iosb = _YTDL_IO_STATUS_BLOCK()
            try:
                status = api.ntdll.NtQueryDirectoryFile(
                    wintypes.HANDLE(int(dir_handle)),
                    None, None, None,
                    ctypes.byref(iosb),
                    buf, _YTDL_CLEANUP_BUF_SIZE,
                    _YTDL_FileDirectoryInformation,
                    False,
                    None,
                    restart,
                )
            except Exception:
                return False
            restart = False
            code = status & 0xFFFFFFFF
            if code == _YTDL_STATUS_NO_MORE_FILES:
                break
            if code not in (_YTDL_STATUS_SUCCESS, _YTDL_STATUS_BUFFER_OVERFLOW):
                return False
            info = int(iosb.Information)
            names = _ytdl_parse_dir_info_entries(buf, info)
            if names is None:
                return False
            if not names:
                break
            for name in names:
                if name in (".", ".."):
                    continue
                if stats["entries"] >= _YTDL_CLEANUP_MAX_ENTRIES:
                    return False
                stats["entries"] += 1
                if not _ytdl_is_safe_relative_leaf(name):
                    return False
                child = _ytdl_nt_create_relative(
                    dir_handle,
                    name,
                    _YTDL_DELETE
                    | _YTDL_FILE_LIST_DIRECTORY
                    | _YTDL_FILE_TRAVERSE
                    | _YTDL_FILE_READ_ATTRIBUTES
                    | _YTDL_FILE_READ_DATA
                    | _YTDL_SYNCHRONIZE,
                    _YTDL_FILE_SHARE_READ | _YTDL_FILE_SHARE_WRITE,
                    _YTDL_FILE_OPEN,
                    _YTDL_FILE_SYNCHRONOUS_IO_NONALERT | _YTDL_FILE_OPEN_REPARSE_POINT,
                )
                if not child:
                    child = _ytdl_nt_create_relative(
                        dir_handle,
                        name,
                        _YTDL_DELETE
                        | _YTDL_FILE_READ_ATTRIBUTES
                        | _YTDL_FILE_READ_DATA
                        | _YTDL_SYNCHRONIZE,
                        _YTDL_FILE_SHARE_READ,
                        _YTDL_FILE_OPEN,
                        _YTDL_FILE_NON_DIRECTORY_FILE
                        | _YTDL_FILE_SYNCHRONOUS_IO_NONALERT
                        | _YTDL_FILE_OPEN_REPARSE_POINT,
                    )
                if not child:
                    return False
                meta = _ytdl_query_tag_std(child)
                if meta is None:
                    _ytdl_close_handle(child)
                    return False
                _attrs, is_dir, _dp, is_reparse, _std = meta

                def _close_child_ok(h):
                    return bool(_ytdl_close_handle(h))

                if is_reparse:
                    if not _ytdl_set_disposition_delete(child):
                        _close_child_ok(child)
                        return False
                    if not _close_child_ok(child):
                        return False
                elif is_dir:
                    if not _enum_and_clean(child, depth + 1):
                        _close_child_ok(child)
                        return False
                    empty = _ytdl_dir_is_empty(child, api)
                    if empty is not True:
                        _close_child_ok(child)
                        return False
                    if not _ytdl_set_disposition_delete(child):
                        _close_child_ok(child)
                        return False
                    if not _close_child_ok(child):
                        return False
                else:
                    if not _ytdl_set_disposition_delete(child):
                        _close_child_ok(child)
                        return False
                    if not _close_child_ok(child):
                        return False
        return True

    def _fail_close_stage(h):
        try:
            _h()._hlog("info", "yt-dlp: stage cleanup leaked private debris")
        except Exception:
            pass
        try:
            _ytdl_close_handle(h)
        except Exception:
            pass
        return False

    try:
        if not _enum_and_clean(stage_handle, 0):
            return _fail_close_stage(stage_handle)
        empty = _ytdl_dir_is_empty(stage_handle, api)
        if empty is not True:
            return _fail_close_stage(stage_handle)
        if not _ytdl_set_disposition_delete(stage_handle):
            return _fail_close_stage(stage_handle)
        if not _ytdl_close_handle(stage_handle):
            try:
                _h()._hlog("info", "yt-dlp: stage cleanup leaked private debris")
            except Exception:
                pass
            return False
        return True
    except Exception:
        return _fail_close_stage(stage_handle)




# Seconds of TOTAL silence from yt-dlp while still resolving before we call the
# job stuck. Resolution normally takes 2-5s, so this is deliberately generous —
# it only has to beat "forever", and it is disarmed once bytes start flowing.
_YTDL_RESOLVE_STALL = 90


class _StallWatch:
    """Kills a yt-dlp that goes completely silent while still resolving.

    A dropped (not refused) packet leaves yt-dlp blocked in a socket read that
    never returns, emitting nothing — the row then sits on "Preparing" forever
    with nothing to time out against. Armed only until the first real progress
    line: once bytes flow, a long download or a slow merge is healthy and must
    never be killed. Both yt-dlp reader loops share this.
    """

    def __init__(self, proc):
        self.stalled = threading.Event()
        self._proc = proc
        self._downloading = threading.Event()
        self._done = threading.Event()
        self._ts = time.time()
        threading.Thread(target=self._run, daemon=True).start()

    def touch(self):
        """Any output at all counts as liveness."""
        self._ts = time.time()

    def downloading(self):
        """First parsed progress line — disarm for the rest of the job."""
        self._downloading.set()

    def finish(self):
        """Reader loop is done; release the watchdog thread."""
        self._done.set()

    def _run(self):
        while not self._done.wait(2.0):
            if self._downloading.is_set():
                return
            if time.time() - self._ts > _YTDL_RESOLVE_STALL:
                self.stalled.set()
                _safe_kill(self._proc)      # unblocks the reader loop
                return


def _ytdl_build_cmd(ytdlp, fmt, outtmpl, url, deno, pot):
    cmd = [ytdlp, "--no-playlist", "--no-mtime", "--newline", "--progress", "--no-warnings",
           "--force-overwrites",
           "-f", fmt, "--merge-output-format", "mp4",
           "--cookies-from-browser", "firefox",
           "-o", outtmpl,
           # A dropped (not refused) packet leaves a socket read blocked forever.
           # Bound every read so yt-dlp surfaces an error instead of hanging.
           "--socket-timeout", "30",
           # --print puts yt-dlp in QUIET mode, which suppresses the very status
           # lines _yt_stage_note parses (so the bar sat on "Preparing" all the
           # way through). --no-quiet keeps them; --print still emits @@FILE@@.
           "--no-quiet",
           "--print", "after_move:@@FILE@@ %(filepath)s"]
    if _h().FFMPEG:
        cmd += ["--ffmpeg-location", os.path.dirname(_h().FFMPEG)]
    if deno:     # solve the 'n' challenge -> unlocks the real (incl. 4K) formats
        cmd += ["--js-runtimes", "deno:%s" % deno]
    if pot:      # only when the optional PO-token provider is actually running
        cmd += ["--extractor-args",
                "youtubepot-bgutilhttp:base_url=http://127.0.0.1:%d" % _POT_PORT]
    cmd += [url]
    return cmd


def handle_ytdl(req):
    """Download a YouTube (or other yt-dlp-supported) URL via yt-dlp.

    Two wire modes share the same command name:
      - Legacy (attemptToken key ABSENT): title/ID output template and tokenless
        event shapes for old extensions.
      - Structured (attemptToken key PRESENT): token-fenced Save As protocol —
        exact name/dir, pre-deduped target, % output-template escaping, and
        attemptToken on every progress/terminal frame.

    yt-dlp entries share the pget registry under the same CAS helpers. They are
    tagged without lease_cv so pget-set-limit never acknowledges them. Cancel
    still kills the exact captured proc; unregister is identity-safe.
    """
    if not isinstance(req, dict):
        return

    # KEY ABSENCE selects legacy protocol only. A present key never downgrades.
    structured = "attemptToken" in req

    if structured:
        _handle_ytdl_structured(req)
    else:
        _handle_ytdl_legacy(req)


def _handle_ytdl_structured(req):
    """Token-bound Save As path: validate, register, then prepare asynchronously."""
    token = req.get("attemptToken")
    jid = req.get("id")
    url = req.get("url")
    name = req.get("name")

    # Fail closed on invalid present token — never fall through to legacy.
    if not _ytdl_exact_nonblank_str(token):
        return

    if not _ytdl_exact_nonblank_str(jid) or not _ytdl_exact_nonblank_str(url) \
            or not _ytdl_exact_nonblank_str(name):
        _h().send({
            "type": "ytdl-error",
            "id": jid if _ytdl_exact_nonblank_str(jid) else None,
            "attemptToken": token,
            "reason": "permanent",
            "error": "Invalid download request.",
        })
        return

    # Directory: absent / null / "" → default Downloads; else exact nonblank str.
    if "dir" not in req or req.get("dir") is None or req.get("dir") == "":
        outdir = None  # resolve default later (still token-bound on failure)
        explicit_dir = False
    else:
        dval = req.get("dir")
        if not _ytdl_exact_nonblank_str(dval):
            _h().send({
                "type": "ytdl-error",
                "id": jid,
                "attemptToken": token,
                "reason": "permanent",
                "error": "Invalid download request.",
            })
            return
        outdir = dval
        explicit_dir = True

    # Format: omitted → default; present must be control-free built-in str.
    if "format" not in req or req.get("format") is None:
        fmt = "bv*+ba/b"
    else:
        fval = req.get("format")
        if not _ytdl_control_free_str(fval):
            _h().send({
                "type": "ytdl-error",
                "id": jid,
                "attemptToken": token,
                "reason": "permanent",
                "error": "Invalid download request.",
            })
            return
        fmt = fval or "bv*+ba/b"

    safe_name = _pget_safe_filename(name)
    if not safe_name:
        _h().send({
            "type": "ytdl-error",
            "id": jid,
            "attemptToken": token,
            "reason": "permanent",
            "error": "Invalid download request.",
        })
        return

    # Register BEFORE async prep so matching cancel cannot race past setup.
    op = {
        "proc": None,
        "kind": "ytdl",
        "attemptToken": token,
        "cancel_requested": False,
        "ytdl_lock": threading.Lock(),  # cancel vs final-commit linearization
        "commit_claimed": False,
    }
    if not _pget_register(jid, op):
        _h().send({
            "type": "ytdl-error",
            "id": jid,
            "attemptToken": token,
            "reason": "permanent",
            "error": "Download id already in use.",
        })
        return

    terminal = {"sent": False}

    def emit(msg):
        if terminal["sent"]:
            return
        terminal["sent"] = True
        # Identity-unregister BEFORE the terminal so a synchronous same-id
        # retry inside send() can register; finally CAS cleanup is a no-op then.
        _pget_unregister(jid, op)
        try:
            _h().send(msg)
        except Exception:
            pass

    def emit_error(reason, error):
        emit({
            "type": "ytdl-error",
            "id": jid,
            "attemptToken": token,
            "reason": reason,
            "error": error,
        })

    def emit_done(path, size):
        emit({
            "type": "ytdl-done",
            "id": jid,
            "attemptToken": token,
            "file": path,
            "bytes": size,
        })

    def progress_msg(**fields):
        msg = {"type": "ytdl-progress", "id": jid, "attemptToken": token}
        msg.update(fields)
        try:
            _h().send(msg)
        except Exception:
            pass

    def cancelled():
        return bool(op.get("cancel_requested"))

    def worker():
        dest_lease = None
        stage_handle = None
        stage_display = None
        source_handle = None
        committed_handle = None
        done_path = None
        done_size = None
        close_counts = op.setdefault("_ytdl_close_counts", {
            "source": 0, "final": 0, "stage": 0, "dest": 0,
        })

        def _close_source(delete=False):
            nonlocal source_handle
            h = source_handle
            source_handle = None
            if h:
                close_counts["source"] += 1
                _ytdl_dispose_handle(h, delete=delete)

        def _close_committed():
            nonlocal committed_handle
            h = committed_handle
            committed_handle = None
            if h:
                close_counts["final"] += 1
                _ytdl_dispose_handle(h, delete=False)

        def _close_stage():
            nonlocal stage_handle
            h = stage_handle
            stage_handle = None
            if h:
                close_counts["stage"] += 1
                _ytdl_cleanup_stage_tree(h)

        def _release_dest():
            nonlocal dest_lease
            lease = dest_lease
            dest_lease = None
            if lease:
                close_counts["dest"] += 1
                _ytdl_release_dest_lease(lease)

        try:
            try:
                if cancelled():
                    emit_error("cancelled", "Cancelled.")
                    return

                # Structured path requires Windows handle APIs; never fall back
                # to the rejected pathname hardlink/O_EXCL/unlink scheme.
                if _ytdl_winapi() is None:
                    emit_error("local_io", "Couldn't prepare the save path.")
                    return

                ytdlp = ensure_ytdlp()
                if cancelled():
                    emit_error("cancelled", "Cancelled.")
                    return
                if not ytdlp:
                    emit_error(
                        "noytdlp",
                        "Couldn't get yt-dlp (needed for YouTube). Check your connection, or re-run the helper installer.",
                    )
                    return

                deno = ensure_deno()
                if cancelled():
                    emit_error("cancelled", "Cancelled.")
                    return

                if not explicit_dir:
                    try:
                        out = _ytdl_default_outdir()
                    except Exception:
                        emit_error("local_io", "Couldn't access the save folder.")
                        return
                else:
                    out = outdir

                if type(out) is not str or not out.strip():
                    emit_error("local_io", "Couldn't access the save folder.")
                    return
                # Validate the exact primitive output string before abspath /
                # normpath / realpath / directory creation / handle open / staging
                # so raw `.`/`..` components cannot be erased into an accepted path.
                if not _ytdl_is_allowed_dest_path(out):
                    emit_error("local_io", "Couldn't create the save folder.")
                    return
                try:
                    out_abs = os.path.abspath(out)
                except Exception:
                    emit_error("local_io", "Couldn't create the save folder.")
                    return
                if not _ytdl_is_allowed_dest_path(out_abs):
                    emit_error("local_io", "Couldn't create the save folder.")
                    return

                if cancelled():
                    emit_error("cancelled", "Cancelled.")
                    return

                # Full destination chain is opened/created handle-relative inside
                # the lease helper — never os.makedirs / pathname exists-check.
                dest_lease = _ytdl_acquire_dest_lease(out_abs)
                if dest_lease is None:
                    emit_error("local_io", "Couldn't prepare the save path.")
                    return

                stage_handle, _stage_leaf, stage_display = _ytdl_create_stage_dir(dest_lease)
                if not stage_handle or not stage_display:
                    emit_error("local_io", "Couldn't prepare the save path.")
                    return

                # Stage file basename is the requested safe name (not pre-deduped).
                # Final name is chosen atomically at Nt rename time.
                if not _ytdl_is_safe_relative_leaf(safe_name):
                    emit_error("local_io", "Couldn't prepare the save path.")
                    return
                try:
                    stage_file = _ytdl_display_join(stage_display, safe_name)
                except Exception:
                    emit_error("local_io", "Couldn't prepare the save path.")
                    return

                pot = start_pot_provider()
                if cancelled():
                    emit_error("cancelled", "Cancelled.")
                    return

                outtmpl = _ytdl_escape_outtmpl(stage_file)
                cmd = _ytdl_build_cmd(ytdlp, fmt, outtmpl, url, deno, pot)
                _h()._hlog("info", "yt-dlp: downloading (structured, pot=%s)" % ("on" if pot else "off"))
                progress_msg(pct=0, stage="resolving", note="Preparing")

                cf, si = _no_window()
                try:
                    p = subprocess.Popen(
                        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                        creationflags=cf, startupinfo=si, text=True, bufsize=1,
                        # yt-dlp emits UTF-8. A bare text=True decodes as the
                        # locale codepage (cp1252 here), which mojibakes any
                        # non-ASCII @@FILE@@ path -- yt-dlp substitutes fullwidth
                        # quotes (U+FF02) for '"' -- so os.path.isfile missed a
                        # file that was really there and a finished download was
                        # reported as a generic failure.
                        encoding="utf-8", errors="replace",
                    )
                except Exception:
                    if cancelled():
                        emit_error("cancelled", "Cancelled.")
                    else:
                        emit_error("spawn", "Couldn't start the download.")
                    return

                op["proc"] = p
                if cancelled():
                    _safe_kill(p)
                    emit_error("cancelled", "Cancelled.")
                    return

                errbuf = []
                filepath = None
                last_pct = -1.0
                last_note = ""
                last_note_ts = 0.0
                watch = _StallWatch(p)
                try:
                    for line in p.stdout:
                        watch.touch()
                        if cancelled():
                            break
                        raw = line if isinstance(line, str) else str(line)
                        # Preserve trailing spaces/dots on @@FILE@@ paths for validation.
                        if raw.lstrip().startswith("@@FILE@@"):
                            marker = raw.lstrip()
                            # Drop only line endings from the marker line.
                            marker = marker.rstrip("\r\n")
                            rest = marker[len("@@FILE@@"):]
                            if rest.startswith(" "):
                                rest = rest[1:]
                            filepath = rest
                            continue
                        s = raw.strip()
                        if not s:
                            continue
                        if s.startswith("[download]"):
                            prog = _parse_yt_progress(s)
                            if prog:
                                watch.downloading()
                                pct = prog.get("pct", 0.0)
                                if pct < last_pct or pct - last_pct >= 1.0 or pct >= 100.0:
                                    last_pct = pct
                                    progress_msg(**prog)
                                continue
                        errbuf.append(s)
                        if "Merging formats" in s or s.startswith("[Merger]"):
                            progress_msg(pct=99, stage="merging")
                            continue
                        if last_pct < 0:
                            note = _yt_stage_note(s)
                            now = time.time()
                            if note and (note != last_note or now - last_note_ts > 0.5):
                                last_note = note
                                last_note_ts = now
                                progress_msg(pct=0, stage="resolving", note=note)
                    watch.finish()
                    p.wait()
                except Exception:
                    if cancelled():
                        emit_error("cancelled", "Cancelled.")
                        return
                    emit_error("permanent", "Download failed.")
                    return
                finally:
                    watch.finish()      # idempotent; also covers the exception path

                if cancelled():
                    emit_error("cancelled", "Cancelled.")
                    return
                if watch.stalled.is_set():
                    emit_error("stalled",
                               "No response while preparing the download. The connection is "
                               "being blocked (check your firewall/VPN) or the network is down.")
                    return

                if p.returncode == 0:
                    owned = _ytdl_open_stage_source(stage_handle, stage_display, filepath)
                    if owned is None:
                        emit_error(
                            "local_io",
                            "Download finished but the file could not be verified.",
                        )
                        return
                    source_handle = owned["handle"]
                    owned_size = owned["size"]
                    if type(owned_size) is not int or owned_size < 0:
                        _close_source(delete=True)
                        emit_error(
                            "local_io",
                            "Download finished but the file could not be verified.",
                        )
                        return

                    outcome = None
                    done_path = None
                    done_size = None
                    # Prebuild every leaf/buffer/display path BEFORE ytdl_lock so
                    # post-rename path construction cannot run under the lock.
                    try:
                        candidates = _ytdl_prebuild_commit_candidates(
                            dest_lease, safe_name, max_attempts=32,
                        )
                    except Exception:
                        candidates = []
                    if not candidates:
                        _close_source(delete=True)
                        emit_error(
                            "local_io",
                            "Download finished but the file could not be verified.",
                        )
                        return
                    # Holding the op-local lock across bounded Nt rename is intended.
                    with op["ytdl_lock"]:
                        if op.get("cancel_requested") or op.get("commit_claimed"):
                            outcome = "cancelled"
                        else:
                            # Store validated nonnegative size before rename so a
                            # post-claim return-transfer fault still has authority.
                            op["claimed_size"] = owned_size
                            final_path = _ytdl_commit_with_candidates(
                                source_handle, candidates, op=op,
                            )
                            if not final_path and not op.get("commit_claimed"):
                                outcome = "local_io"
                            elif op.get("commit_claimed"):
                                # Claimed metadata is authority even if helper
                                # return/assignment was interrupted.
                                outcome = "done"
                                done_path = (
                                    final_path
                                    if type(final_path) is str
                                    else op.get("claimed_path")
                                )
                                done_size = owned_size
                                # Prefer a read-only pin so a later close-accounting
                                # fault cannot leak a DELETE-capable handle that
                                # blocks ordinary readers of the surviving final.
                                try:
                                    committed_handle = _ytdl_adopt_committed_pin(
                                        source_handle
                                    )
                                except Exception:
                                    committed_handle = source_handle
                                source_handle = None
                                # Optional diagnostic only — failure must not demote.
                                try:
                                    _ytdl_final_path(committed_handle)
                                except Exception:
                                    pass
                            else:
                                outcome = "local_io"

                    if outcome == "cancelled":
                        _close_source(delete=True)
                        emit_error("cancelled", "Cancelled.")
                        return
                    if outcome == "done":
                        # Hold committed handle through terminal so replacement is denied.
                        # Send/log/cleanup/close failures after claim cannot demote done
                        # or disposition-delete the committed final.
                        if done_path is None:
                            done_path = op.get("claimed_path")
                        if done_size is None:
                            done_size = op.get("claimed_size")
                        try:
                            emit_done(done_path, done_size)
                        except Exception:
                            pass
                        try:
                            _close_committed()
                        except Exception:
                            committed_handle = None
                        try:
                            _h()._hlog(
                                "info",
                                "yt-dlp: saved %s" % (
                                    os.path.basename(done_path)
                                    if type(done_path) is str else "file"
                                ),
                            )
                        except Exception:
                            pass
                        return
                    _close_source(delete=True)
                    emit_error(
                        "local_io",
                        "Download finished but the file could not be verified.",
                    )
                    return

                reason, msg = _map_yt_error("\n".join(errbuf))
                _h()._hlog(
                    "error",
                    "yt-dlp failed (%s): %s" % (reason, ("\n".join(errbuf[-6:]))[:500]),
                )
                emit_error(reason, msg)
            except Exception:
                # Once Nt rename claimed the final, fallible post-claim work must
                # not demote success into an error terminal — including helper
                # return/tuple transfer faults after commit_claimed is set.
                if op.get("commit_claimed"):
                    if not terminal["sent"]:
                        path = done_path if done_path is not None else op.get("claimed_path")
                        size = done_size if done_size is not None else op.get("claimed_size")
                        if type(path) is str and type(size) is int and size >= 0:
                            try:
                                emit_done(path, size)
                            except Exception:
                                pass
                elif cancelled():
                    emit_error("cancelled", "Cancelled.")
                else:
                    emit_error("permanent", "Download failed.")
        finally:
            # Never delete a committed final. Dispose only uncommitted source.
            # After commit_claimed, the source handle is a committed final even if
            # transferring locals/diagnostics/send/log/cleanup/close raises.
            try:
                if source_handle is not None:
                    delete_src = not bool(op.get("commit_claimed"))
                    _close_source(delete=delete_src)
            except Exception:
                source_handle = None
            try:
                if committed_handle is not None:
                    _close_committed()
            except Exception:
                committed_handle = None
            try:
                if stage_handle is not None:
                    _close_stage()
            except Exception:
                stage_handle = None
            try:
                if dest_lease is not None:
                    _release_dest()
            except Exception:
                dest_lease = None
            try:
                _pget_unregister(jid, op)
            except Exception:
                pass

    threading.Thread(target=worker, daemon=True).start()


def _handle_ytdl_legacy(req):
    """Token-omitted path: preserve title/ID template and tokenless wire shapes."""
    def worker():
        jid = req.get("id")
        url = req.get("url") or ""
        ytdlp = ensure_ytdlp()
        if not ytdlp:
            _h().send({"type": "ytdl-error", "id": jid, "reason": "noytdlp",
                  "error": "Couldn't get yt-dlp (needed for YouTube). Check your connection, or re-run the helper installer."})
            return
        deno = ensure_deno()   # yt-dlp needs a JS runtime to solve YouTube's 'n' challenge
        outdir = req.get("dir") or (_h().load_config().get("saveFolder") or "") or _h().downloads_dir()
        try:
            os.makedirs(outdir, exist_ok=True)
        except Exception:
            pass
        pot = start_pot_provider()            # best-effort; without it, quality caps ~1080p
        outtmpl = os.path.join(outdir, "%(title).150B [%(id)s].%(ext)s")
        # Optional format selector from the popup's quality picker; default = best.
        fmt = req.get("format") or "bv*+ba/b"
        cmd = _ytdl_build_cmd(ytdlp, fmt, outtmpl, url, deno, pot)
        _h()._hlog("info", "yt-dlp: downloading %s (pot=%s)" % (url, "on" if pot else "off"))
        _h().send({"type": "ytdl-progress", "id": jid, "pct": 0, "stage": "resolving", "note": "Preparing"})
        cf, si = _no_window()
        try:
            p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 creationflags=cf, startupinfo=si, text=True, bufsize=1,
                                 # See the structured path: yt-dlp emits UTF-8, and
                                 # decoding it as the locale codepage mojibakes the
                                 # @@FILE@@ path, failing an already-finished job.
                                 encoding="utf-8", errors="replace")
        except Exception as e:
            _h().send({"type": "ytdl-error", "id": jid, "reason": "spawn", "error": str(e)})
            return
        # Tagged yt-dlp op: same CAS registry as pget; no lease_cv so set-limit ignores it.
        # Legacy keeps spawn-then-register so a duplicate id still kills the new proc.
        op = {"proc": p, "kind": "ytdl", "cancel_requested": False, "attemptToken": None}
        if not _pget_register(jid, op):
            # Duplicate id owns the registry — kill the just-spawned process, do not overwrite.
            _safe_kill(p)
            _h().send({
                "type": "ytdl-error",
                "id": jid,
                "reason": "spawn",
                "error": "Download id already in use.",
            })
            return
        errbuf = []
        filepath = None
        last_pct = -1.0
        last_note = ""
        last_note_ts = 0.0
        watch = _StallWatch(p)
        try:
            for line in p.stdout:
                watch.touch()
                s = line.strip() if isinstance(line, str) else str(line).strip()
                if not s:
                    continue
                if s.startswith("@@FILE@@"):
                    filepath = s[len("@@FILE@@"):].strip()
                    continue
                if s.startswith("[download]"):
                    prog = _parse_yt_progress(s)
                    if prog:
                        watch.downloading()
                        pct = prog.get("pct", 0.0)
                        # throttle to ~1% steps; resend on a reset (audio stream starts after video)
                        if pct < last_pct or pct - last_pct >= 1.0 or pct >= 100.0:
                            last_pct = pct
                            _h().send({"type": "ytdl-progress", "id": jid, **prog})
                        continue
                errbuf.append(s)
                if "Merging formats" in s or s.startswith("[Merger]"):
                    _h().send({"type": "ytdl-progress", "id": jid, "pct": 99, "stage": "merging"})
                    continue
                # Before the first real byte, echo yt-dlp's resolution steps as a live label.
                if last_pct < 0:
                    note = _yt_stage_note(s)
                    now = time.time()
                    if note and (note != last_note or now - last_note_ts > 0.5):
                        last_note = note
                        last_note_ts = now
                        _h().send({"type": "ytdl-progress", "id": jid, "pct": 0, "stage": "resolving", "note": note})
            watch.finish()
            p.wait()
            if op.get("cancel_requested"):
                _h().send({"type": "ytdl-error", "id": jid, "reason": "cancelled",
                           "error": "Cancelled."})
            elif watch.stalled.is_set():
                _h()._hlog("error", "yt-dlp: no response for %ds while resolving %s — killed"
                           % (_YTDL_RESOLVE_STALL, url))
                _h().send({"type": "ytdl-error", "id": jid, "reason": "stalled",
                           "error": "No response while preparing the download. The connection "
                                    "is being blocked (check your firewall/VPN) or the network "
                                    "is down."})
            elif p.returncode == 0 and filepath and os.path.isfile(filepath):
                try:
                    size = os.path.getsize(filepath)
                except Exception:
                    size = None
                if type(size) is int and size >= 0:
                    _h().send({"type": "ytdl-done", "id": jid, "file": filepath, "bytes": size})
                    _h()._hlog("info", "yt-dlp: saved %s" % os.path.basename(filepath))
                else:
                    reason, msg = _map_yt_error("\n".join(errbuf))
                    _h().send({"type": "ytdl-error", "id": jid, "reason": reason, "error": msg})
            else:
                reason, msg = _map_yt_error("\n".join(errbuf))
                _h()._hlog("error", "yt-dlp failed (%s): %s" % (reason, ("\n".join(errbuf[-6:]))[:500]))
                _h().send({"type": "ytdl-error", "id": jid, "reason": reason, "error": msg})
        finally:
            watch.finish()          # idempotent; also covers the exception path
            _pget_unregister(jid, op)
    threading.Thread(target=worker, daemon=True).start()

# ---- parallel multi-mirror direct download --------------------------------
# Fetch a direct file from one or more mirror URLs using several range requests
# at once, with per-segment failover to another mirror. Each segment streams to
# its own part file (no concurrent writes to one handle), then the parts are
# stitched into a sibling .part path and committed with os.replace. Terminal
# outcomes are structured pget-result messages (never browser handoff).
_PGET = {}  # id -> operation dict (stop Event, cancel flag, optional yt-dlp proc)
_PGET_LOCK = threading.Lock()  # short CAS only: register / lookup / unregister
_PGET_MAX_CONN = 6
_PGET_CR_PROBE = re.compile(r"^bytes 0-0/(\d+)$")
_PGET_CR_SEG = re.compile(r"^bytes (\d+)-(\d+)/(\d+)$")
_PGET_INT_RE = re.compile(r"^-?\d+$")
# Deterministic failure priority (higher wins). User cancel is handled separately.
_PGET_FAIL_PRIORITY = {
    "range_unsupported": 90,
    "http_429": 80,
    "http_5xx_temporary": 70,
    "timeout": 60,
    "connection_reset": 50,
    "short_read": 40,
    "local_io": 30,
    "permanent": 10,
    "cancelled": 5,  # only if not user-cancel path; user cancel short-circuits
}


class _PgetError(Exception):
    """Normalized transfer/probe failure with a failureCategory."""
    def __init__(self, category, local=False):
        self.category = category
        self.local = local
        super().__init__(category)


def _pget_nonneg_int_bytes(val):
    """Integral nonnegative byte count, or None.

    Rejects bool, int subclasses (hostile __lt__), floats, strings, and negatives.
    No lossy coercion — only exact built-in int values >= 0 are accepted.
    Returns a plain int.
    """
    if type(val) is not int:
        return None
    if val < 0:
        return None
    return int(val)


def _pget_attempt_token_allows(req, op):
    """True when cancel / set-limit may act on the live op.

    ONLY ABSENCE of the attemptToken key enables legacy id-only compatibility.
    When the key is present, its value must be a nonblank exact built-in str
    that exactly equals the stored active token (also an exact built-in str).
    Present null/None, empty/whitespace, bool, number, object, str subclass,
    or different string is a no-op — even when the stored token is None.
    """
    if not isinstance(req, dict) or "attemptToken" not in req:
        return True
    provided = req.get("attemptToken")
    if type(provided) is not str or not provided.strip():
        return False
    stored = op.get("attemptToken") if isinstance(op, dict) else None
    if type(stored) is not str or not stored.strip():
        return False
    return provided == stored


def _pget_send_result(id, attemptToken, status, mode, failureCategory, partState,
                      file=None, bytes=None):
    """Emit exactly one structured terminal pget-result (caller enforces once).

    file/bytes are an optional pair only on completed/committed terminals.
    Failed/cancelled keep the exact seven-field base shape. Never emit
    one-sided metadata; invalid sizes omit the pair entirely.
    """
    msg = {
        "type": "pget-result",
        "id": id,
        "attemptToken": attemptToken,
        "status": status,
        "mode": mode,
        "failureCategory": failureCategory,
        "partState": partState,
    }
    if status == "completed" and partState == "committed" and file is not None:
        size = _pget_nonneg_int_bytes(bytes)
        if size is not None:
            msg["file"] = file
            msg["bytes"] = size
    _h().send(msg)


_PGET_NAME_MAX = 150
_PGET_UNSAFE_NAME = re.compile(r'[\\/:*?"<>|]+')


def _pget_safe_filename(name):
    """Pget-local basename normalizer capped at 150 characters.

    Already-safe basenames of length <=150 are preserved exactly. Invalid
    path characters are replaced like the legacy host sanitizer; empty
    results fall back to "download". Does not call or mutate tools.sanitize.
    """
    raw = name if isinstance(name, str) else ("" if name is None else str(name))
    cleaned = _PGET_UNSAFE_NAME.sub("_", raw or "download").strip()
    if not cleaned:
        cleaned = "download"
    if len(cleaned) <= _PGET_NAME_MAX:
        return cleaned
    root, ext = os.path.splitext(cleaned)
    if ext and len(ext) < _PGET_NAME_MAX:
        keep = _PGET_NAME_MAX - len(ext)
        root = root[:keep]
        cleaned = (root + ext) if root else cleaned[:_PGET_NAME_MAX]
    else:
        cleaned = cleaned[:_PGET_NAME_MAX]
    return cleaned or "download"


def _pget_terminal_file_bytes(op):
    """Best-effort (file, bytes) for a committed op final path. Never raises.

    Returns (None, None) when the path is missing, unreadable, or size is not an
    integral nonnegative int (bool/float/negative/hostile values are invalid).
    Metadata failure never revokes an already-committed success — callers still
    emit completed/committed without the optional pair.
    """
    if not isinstance(op, dict):
        return None, None
    path = op.get("final_path")
    if not path or not isinstance(path, str):
        return None, None
    try:
        if not os.path.isfile(path):
            return None, None
        size = _pget_nonneg_int_bytes(os.path.getsize(path))
        if size is None:
            return None, None
        return path, size
    except Exception:
        return None, None


def _pget_open(url, referer, ua, range_header=None, timeout=30):
    import urllib.request
    headers = {"User-Agent": ua or "Mozilla/5.0", "Accept": "*/*"}
    if referer:
        headers["Referer"] = referer
    if range_header:
        headers["Range"] = range_header
    return urllib.request.urlopen(
        urllib.request.Request(url, headers=headers), timeout=timeout
    )


def _pget_classify_exc(exc):
    """Map a transport/OS exception to a normalized failure category."""
    import errno as _errno
    import socket as _socket
    import urllib.error as _ue

    if isinstance(exc, _PgetError):
        return exc.category
    if isinstance(exc, (_socket.timeout, TimeoutError)):
        return "timeout"
    if isinstance(exc, (ConnectionResetError, BrokenPipeError, ConnectionAbortedError)):
        return "connection_reset"
    if isinstance(exc, _ue.HTTPError):
        return _pget_classify_http_status(exc.code)
    if isinstance(exc, _ue.URLError):
        reason = exc.reason
        if isinstance(reason, (_socket.timeout, TimeoutError)):
            return "timeout"
        if isinstance(reason, (ConnectionResetError, BrokenPipeError, ConnectionAbortedError)):
            return "connection_reset"
        if isinstance(reason, OSError):
            return _pget_classify_exc(reason)
        # Some platforms wrap timeout as URLError(str/timeout message)
        rtxt = str(reason).lower() if reason is not None else ""
        if "timed out" in rtxt or "timeout" in rtxt:
            return "timeout"
        if "reset" in rtxt or "aborted" in rtxt or "broken pipe" in rtxt:
            return "connection_reset"
        return "connection_reset" if reason is not None else "permanent"
    if isinstance(exc, OSError):
        en = getattr(exc, "errno", None)
        if en in (_errno.ETIMEDOUT, getattr(_errno, "WSAETIMEDOUT", -1)):
            return "timeout"
        if en in (
            _errno.ECONNRESET,
            _errno.ECONNABORTED,
            _errno.EPIPE,
            getattr(_errno, "WSAECONNRESET", -1),
            getattr(_errno, "WSAECONNABORTED", -1),
        ):
            return "connection_reset"
        # Local filesystem-ish errors callers may reclassify as local_io
        return "permanent"
    return "permanent"


def _pget_classify_http_status(code):
    if code == 429:
        return "http_429"
    if 500 <= int(code) <= 599:
        return "http_5xx_temporary"
    return "permanent"


def _pget_pick_category(categories):
    """Choose the deterministic highest-priority category from a list."""
    best = None
    best_p = -1
    for c in categories:
        if not c:
            continue
        p = _PGET_FAIL_PRIORITY.get(c, 0)
        if p > best_p:
            best_p = p
            best = c
    return best or "permanent"


def _pget_close_resp(resp):
    try:
        if resp is not None:
            resp.close()
    except Exception:
        pass


# How long a stalled body read waits before re-checking cancellation.
_PGET_CANCEL_POLL = 0.25


def _pget_response_socket(resp):
    """The live socket behind an HTTPResponse, or None when unavailable.

    Used ONLY to wait for readability. Never call settimeout() on it: SocketIO
    latches _timeout_occurred on the first timeout and every later read raises
    "cannot read from timed out object", which would break the transfer.
    """
    import socket as _socket
    try:
        raw = getattr(getattr(resp, "fp", None), "raw", None)
        sock = getattr(raw, "_sock", None)
        if not isinstance(sock, _socket.socket):
            return None
        if sock.fileno() < 0:
            return None
        return sock
    except Exception:
        return None


def _pget_response_has_buffered(resp):
    """True when the response already holds bytes select() cannot see.

    Covers the BufferedReader's own buffer and any decrypted-but-unread TLS
    bytes. Best-effort: a False here only costs one poll slice.
    """
    try:
        fp = getattr(resp, "fp", None)
        buf = getattr(fp, "_read_buf", None)
        pos = getattr(fp, "_read_pos", None)
        if buf is not None and pos is not None and (len(buf) - pos) > 0:
            return True
    except Exception:
        pass
    try:
        sock = getattr(getattr(getattr(resp, "fp", None), "raw", None), "_sock", None)
        pending = getattr(sock, "pending", None)
        if callable(pending) and pending() > 0:
            return True
    except Exception:
        pass
    return False


class _PgetReader:
    """Chunk reader that lets a stalled transfer still observe cancellation.

    A plain resp.read() parks inside recv until the server sends more, so a
    cancel could go unnoticed for as long as the server stalled (bounded only
    by the socket timeout). On Windows neither closing the response nor
    shutting the socket down wakes that parked read, so instead of trying to
    interrupt it we never enter it blind: wait for readability in short slices,
    checking cancellation between them, and only read once data is there.

    Falls back to a plain blocking read whenever the socket handle is
    unavailable — notably at EOF, where http.client has already closed the
    connection — so behaviour is never worse than before.
    """

    def __init__(self, resp, idle_budget):
        self._resp = resp
        self._sock = _pget_response_socket(resp)
        self._idle = 0.0
        self._budget = idle_budget if idle_budget and idle_budget > 0 else 30.0

    def read(self, size, cancelled):
        """Up to `size` bytes; b"" at EOF.

        Raises _PgetError("cancelled") as soon as `cancelled()` turns true, and
        _PgetError("timeout") once the idle budget is exhausted — matching the
        category a socket timeout produced before.
        """
        import select as _select
        while True:
            if cancelled():
                raise _PgetError("cancelled")
            if self._sock is None:
                return self._resp.read(size)
            if not _pget_response_has_buffered(self._resp):
                try:
                    ready, _w, _x = _select.select([self._sock], [], [], _PGET_CANCEL_POLL)
                except Exception:
                    # Closed or otherwise unusable: degrade to a blocking read.
                    self._sock = None
                    continue
                if not ready:
                    self._idle += _PGET_CANCEL_POLL
                    if self._idle >= self._budget:
                        raise _PgetError("timeout")
                    continue
            self._idle = 0.0
            return self._resp.read1(size)


def _pget_safe_int(val, default=0):
    """Parse a finite integer; bool is never a valid generation/limit."""
    if isinstance(val, bool) or val is None:
        return default
    try:
        if isinstance(val, float):
            import math
            if not math.isfinite(val):
                return default
        return int(val)
    except (TypeError, ValueError, OverflowError):
        return default


def _pget_strict_int(val):
    """Mathematical integer or None. Rejects bool/NaN/inf/fractional/objects.

    Integer-valued floats (4.0) and digit strings ("2") are accepted; decimal
    strings ("1.5", "2.0") and truncated floats (1.5) are not.
    """
    if isinstance(val, bool) or val is None:
        return None
    if isinstance(val, int):
        return val
    if isinstance(val, float):
        import math
        if not math.isfinite(val) or not val.is_integer():
            return None
        return int(val)
    if isinstance(val, str):
        s = val.strip()
        if not s or not _PGET_INT_RE.match(s):
            return None
        try:
            return int(s)
        except (TypeError, ValueError, OverflowError):
            return None
    return None


def _pget_initial_cap(req, single=False):
    """Initial connection cap for an operation (single mode always 1)."""
    if single:
        return 1
    raw = _pget_safe_int(req.get("maxConnections"), 1)
    if raw < 1:
        raw = 1
    return max(1, min(_PGET_MAX_CONN, raw))


def _pget_seed_generation(req):
    gen = _pget_safe_int(req.get("providerGeneration"), 0)
    if gen < 0:
        gen = 0
    return gen


def _pget_lease_acquire(op):
    """Acquire one connection slot under the live lease. False if cancelled.

    At limit zero, wait without busy-spinning until a newer positive limit or
    cancellation wakes the condition. Never exceed the current positive limit.
    """
    cv = op.get("lease_cv")
    if cv is None:
        return True
    with cv:
        while True:
            if op.get("cancel_requested") or (op.get("stop") is not None and op["stop"].is_set()):
                return False
            limit = int(op.get("maxConnections") or 0)
            open_n = int(op.get("openConnections") or 0)
            if limit > 0 and open_n < limit:
                op["openConnections"] = open_n + 1
                return True
            cv.wait(timeout=0.5)


def _pget_lease_release(op):
    """Release one connection slot exactly once for a prior successful acquire."""
    cv = op.get("lease_cv")
    if cv is None:
        return
    with cv:
        op["openConnections"] = max(0, int(op.get("openConnections") or 0) - 1)
        cv.notify_all()


def _pget_make_op(req, stop, single=False):
    """Build a pget operation record with a seeded live connection lease."""
    initial_cap = _pget_initial_cap(req, single=single)
    gen = _pget_seed_generation(req)
    return {
        "stop": stop,
        "cancel_requested": False,
        "lease_cv": threading.Condition(),
        "ack_lock": threading.RLock(),
        "ack_sending": False,
        "ack_pending": False,
        "last_sent_gen": None,
        "last_sent_lim": None,
        "initial_cap": initial_cap,
        "maxConnections": initial_cap,
        "providerGeneration": gen,
        "openConnections": 0,
        "lease": initial_cap,
        "n": 0,
        "final_path": None,
        # Immutable start attempt token (fencing for cancel / set-limit).
        "attemptToken": req.get("attemptToken") if isinstance(req, dict) else None,
        "kind": "pget-single" if single else "pget",
    }


def _pget_probe_one(url, referer, ua, timeout=30, op=None):
    """Probe a single mirror with Range: bytes=0-0 after redirects.

    Returns one of:
      ("ok", total, url)
      ("range_unsupported", None, url)
      ("fail", category, url)
    """
    import urllib.error as _ue

    resp = None
    acquired = False
    try:
        if op is not None:
            if not _pget_lease_acquire(op):
                return ("fail", "cancelled", url)
            acquired = True
        resp = _pget_open(url, referer, ua, "bytes=0-0", timeout=timeout)
        status = getattr(resp, "status", None) or getattr(resp, "code", None)
        if status == 206:
            cr = (resp.headers.get("Content-Range") or "").strip()
            m = _PGET_CR_PROBE.match(cr)
            if not m:
                return ("fail", "permanent", url)
            total = int(m.group(1))
            if total <= 0:
                return ("fail", "permanent", url)
            # Require exactly one readable body byte for the probe range.
            first = resp.read(1)
            if len(first) != 1:
                return ("fail", "short_read" if len(first) == 0 else "permanent", url)
            return ("ok", total, url)
        if status == 200:
            # Final successful 200 that ignored the Range request.
            return ("range_unsupported", None, url)
        # Any other successful open with non-206/200 is permanent.
        return ("fail", _pget_classify_http_status(status or 0), url)
    except _ue.HTTPError as e:
        # HTTPError is a response; classify by status and close.
        try:
            cat = _pget_classify_http_status(e.code)
        finally:
            _pget_close_resp(e)
        return ("fail", cat, url)
    except Exception as e:
        return ("fail", _pget_classify_exc(e), url)
    finally:
        _pget_close_resp(resp)
        if acquired:
            _pget_lease_release(op)


def _pget_probe(urls, referer, ua, timeout=30, op=None):
    """Probe every mirror. Return (size, ok_mirrors, failure_category_or_None).

    If at least one mirror proves valid ranges, ok_mirrors holds only valid
    same-size mirrors and failure_category is None. If none are valid, size is
    None, ok_mirrors is empty, and failure_category is the deterministic
    normalized outcome (range_unsupported only when a conclusive 200 was seen;
    a single transient-only probe retains its transient category).
    """
    size = None
    ok = []
    fails = []
    saw_no_range = False
    for u in urls:
        if op is not None and (
            op.get("cancel_requested")
            or (op.get("stop") is not None and op["stop"].is_set())
        ):
            return None, [], "cancelled"
        kind, total, _u = _pget_probe_one(u, referer, ua, timeout=timeout, op=op)
        if kind == "ok":
            if size is None:
                size = total
            if total == size:
                ok.append(u)
            else:
                fails.append("permanent")  # size mismatch across mirrors
        elif kind == "range_unsupported":
            saw_no_range = True
            fails.append("range_unsupported")
        else:
            fails.append(total)  # total carries category on fail
    if ok:
        return size, ok, None
    if saw_no_range:
        return None, [], "range_unsupported"
    if fails:
        return None, [], _pget_pick_category(fails)
    return None, [], "permanent"


def _pget_segment(part_path, urls, idx, start, end, total_size, referer, ua,
                  seg_done, stop, timeout=30, op=None):
    """Download bytes [start, end] into part_path with mirror failover.

    Validates 206 + exact Content-Range, reads exactly the expected length, and
    closes handles before returning. Raises _PgetError on failure. Each HTTP
    open acquires the operation lease immediately before _pget_open and releases
    it exactly once after response close or open failure.
    """
    import urllib.error as _ue

    length = end - start + 1
    order = urls[idx % len(urls):] + urls[:idx % len(urls)]
    errors = []
    for u in order:
        if stop.is_set():
            raise _PgetError("cancelled")
        got = 0
        acquired = False
        try:
            if op is not None:
                if not _pget_lease_acquire(op):
                    raise _PgetError("cancelled")
                acquired = True
            # Open response first; only create the segment file after headers OK
            # enough to begin streaming (status checked immediately).
            with _pget_open(u, referer, ua, "bytes=%d-%d" % (start, end),
                            timeout=timeout) as r:
                status = getattr(r, "status", None) or getattr(r, "code", None)
                if status == 200:
                    # Conclusive full body for a ranged request.
                    raise _PgetError("range_unsupported")
                if status != 206:
                    raise _PgetError(_pget_classify_http_status(status or 0))
                cr = (r.headers.get("Content-Range") or "").strip()
                m = _PGET_CR_SEG.match(cr)
                if not m:
                    raise _PgetError("permanent")
                cr_start, cr_end, cr_total = int(m.group(1)), int(m.group(2)), int(m.group(3))
                if cr_start != start or cr_end != end or cr_total != total_size:
                    raise _PgetError("permanent")
                reader = _PgetReader(r, timeout)
                cancelled = lambda: stop.is_set()
                with open(part_path, "wb") as f:
                    while got < length:
                        chunk = reader.read(min(65536, length - got), cancelled)
                        if not chunk:
                            break
                        f.write(chunk)
                        got += len(chunk)
                        seg_done[idx] = got
            if got == length:
                return
            if got < length:
                raise _PgetError("short_read")
            raise _PgetError("permanent")
        except _PgetError as e:
            errors.append(e.category)
            if e.category == "range_unsupported":
                # Prefer reporting range_unsupported after all mirrors tried.
                pass
            elif e.category == "cancelled":
                raise
        except _ue.HTTPError as e:
            try:
                errors.append(_pget_classify_http_status(e.code))
            finally:
                _pget_close_resp(e)
        except OSError as e:
            # File open/write errors are local_io; transport OSErrors classify.
            if getattr(e, "filename", None) or (
                getattr(e, "errno", None) in (
                    getattr(__import__("errno"), "EACCES", -1),
                    getattr(__import__("errno"), "EPERM", -1),
                    getattr(__import__("errno"), "ENOSPC", -1),
                    getattr(__import__("errno"), "EROFS", -1),
                )
            ):
                raise _PgetError("local_io", local=True)
            errors.append(_pget_classify_exc(e))
        except Exception as e:
            errors.append(_pget_classify_exc(e))
        finally:
            if acquired:
                _pget_lease_release(op)
        seg_done[idx] = 0
        # Remove partial segment before trying next mirror
        try:
            if os.path.exists(part_path):
                os.remove(part_path)
        except Exception:
            pass
    if stop.is_set():
        raise _PgetError("cancelled")
    raise _PgetError(_pget_pick_category(errors))


def _pget_work_paths(final_path, n):
    """Assembly .part path plus per-segment paths. Never includes final_path."""
    part = final_path + ".part"
    segs = ["%s.part%d" % (final_path, i) for i in range(n)]
    return part, segs


def _pget_cleanup_work(final_path, n):
    """Remove assembly .part and segment files only — never the final path."""
    part, segs = _pget_work_paths(final_path, n)
    for p in [part] + segs:
        try:
            if os.path.exists(p):
                os.remove(p)
        except Exception:
            pass


def _pget_part_state(final_path, n):
    """empty only when no work artifacts remain; else partial.

    The final committed file is not a work artifact for failure partState.
    """
    part, segs = _pget_work_paths(final_path, n)
    for p in [part] + segs:
        try:
            if os.path.exists(p):
                return "partial"
        except Exception:
            return "partial"
    return "empty"


def _pget_cleanup(path, n):
    """Back-compat name: clean work files only (does not delete final path)."""
    _pget_cleanup_work(path, n)


def _pget_registry_get(jid):
    """Snapshot the current registry entry (short lock)."""
    with _PGET_LOCK:
        return _PGET.get(jid)


def _pget_registry_is(jid, op):
    """True only while the registry still points at this exact operation."""
    with _PGET_LOCK:
        return _PGET.get(jid) is op


def _pget_register(jid, op):
    """CAS-register a pget op. False if another active entry already owns jid."""
    with _PGET_LOCK:
        if jid in _PGET:
            return False
        _PGET[jid] = op
        return True


def _pget_cancel(req):
    j = _pget_registry_get(req.get("id"))
    if not j:
        return
    # Present attemptToken must be a nonblank string equal to the stored token.
    # Omitted property preserves legacy id-only cancel; present null does not.
    if not _pget_attempt_token_allows(req, j):
        return

    # Structured yt-dl ops carry ytdl_lock so cancel and final commit share one
    # linearization point. Do not hold _PGET_LOCK here (already released).
    ytdl_lock = j.get("ytdl_lock") if isinstance(j, dict) else None
    if ytdl_lock is not None:
        with ytdl_lock:
            if j.get("commit_claimed"):
                return  # success already linearized — cancel is inert
            j["cancel_requested"] = True
            proc = j.get("proc")
        # Kill / wake outside the op lock (never hold it across process ops).
        if j.get("stop"):
            j["stop"].set()
        if proc:
            _safe_kill(proc)
        cv = j.get("lease_cv")
        if cv is not None:
            with cv:
                cv.notify_all()
        return

    j["cancel_requested"] = True
    if j.get("stop"):
        j["stop"].set()          # segmented pget: signal the workers
    if j.get("proc"):
        _safe_kill(j["proc"])    # yt-dlp job: kill the process
    cv = j.get("lease_cv")
    if cv is not None:
        # Wake zero-limit waiters so they can observe cancel without busy-spin.
        with cv:
            cv.notify_all()


def _pget_unregister(jid, op):
    """Pop registry only if it still points at this exact operation.

    When the op has an ack_lock, acquire it before the registry lock so an
    in-flight limit-ack send (which holds ack_lock across send) remains the
    live registry owner until that send finishes. Lock order: ack_lock →
    _PGET_LOCK. Never holds either across network I/O.
    """
    if not isinstance(op, dict):
        with _PGET_LOCK:
            if _PGET.get(jid) is op:
                _PGET.pop(jid, None)
        return
    ack_lock = op.get("ack_lock")
    if ack_lock is not None:
        with ack_lock:
            with _PGET_LOCK:
                if _PGET.get(jid) is op:
                    _PGET.pop(jid, None)
        return
    with _PGET_LOCK:
        if _PGET.get(jid) is op:
            _PGET.pop(jid, None)


def _pget_lease(req, size):
    """Initial finite connection lease from maxConnections, clamped safely."""
    raw_v = req.get("maxConnections")
    if isinstance(raw_v, bool) or raw_v is None:
        raw = 1
    else:
        try:
            raw = int(raw_v)
        except (TypeError, ValueError, OverflowError):
            raw = 1
    if raw < 1:
        raw = 1
    lease = max(1, min(_PGET_MAX_CONN, raw))
    # Segment count never exceeds lease, file size (bytes), or safe cap.
    by_mib = max(1, size // (1024 * 1024)) if size >= 1024 * 1024 else 1
    n = max(1, min(lease, _PGET_MAX_CONN, size, by_mib))
    return lease, n


def _pget_apply_limit_locked(op, gen, lim):
    """Apply a validated generation/limit under lease_cv. Caller holds lease_cv."""
    cur_gen = int(op.get("providerGeneration") or 0)
    initial_cap = int(op.get("initial_cap") or 1)
    if gen > cur_gen:
        new_lim = max(0, min(initial_cap, lim))
        op["providerGeneration"] = gen
        op["maxConnections"] = new_lim
        op["lease_cv"].notify_all()
    # gen < cur_gen: stale — no overwrite; may still ack current state
    # gen == cur_gen: idempotent — cannot raise
    return (
        int(op.get("providerGeneration") or 0),
        int(op.get("maxConnections") or 0),
    )


def _pget_snapshot_live_limit(jid, op):
    """Identity-fenced live gen/limit under canonical nested locks.

    Caller must already hold op['ack_lock']. Nested order is
    _PGET_LOCK → lease_cv. Returns (gen, lim) or None if op is not live.
    """
    cv = op.get("lease_cv")
    if cv is None:
        return None
    with _PGET_LOCK:
        if _PGET.get(jid) is not op:
            return None
        with cv:
            if _PGET.get(jid) is not op:
                return None
            return (
                int(op.get("providerGeneration") or 0),
                int(op.get("maxConnections") or 0),
            )


def handle_pget_set_limit(req):
    """Apply a live connection lease generation to a pget operation.

    One operation-local acknowledgement serializer covers: live registry
    identity fence → apply/snapshot under lease_cv → message send. Nested lock
    order is ack_lock → _PGET_LOCK → lease_cv for the short apply/snapshot;
    only ack_lock is held across host send. Unregister takes ack_lock before
    the registry lock, so the exact op remains the live owner through an ack
    send without holding the global registry lock across I/O.

    Stale generations cannot overwrite newer leases; same-generation updates
    are idempotent and cannot raise the limit. A newer generation may resume
    from zero with a reduced positive limit, never above the operation's
    initial cap. Negative generation or limit is an invalid command (no
    mutation, no ack). Does not acknowledge yt-dlp or unknown ids.

    Re-entrant send (set-limit invoked from within an in-flight ack send) may
    apply a newer generation and mark ack_pending; the outer sender drains the
    live state so observers never see a regression or an obsolete trailing ack.
    """
    jid = req.get("id")
    gen = _pget_strict_int(req.get("providerGeneration"))
    lim = _pget_strict_int(req.get("maxConnections"))
    # Wholly invalid command: no mutate, no ack. Negative limit is invalid
    # (distinct from a valid zero lease).
    if gen is None or lim is None or gen < 0 or lim < 0:
        return

    op = _pget_registry_get(jid)
    # yt-dlp entries only carry proc; lack of lease_cv means non-pget.
    if not op or op.get("lease_cv") is None:
        return

    # Attempt-token fence: present key requires nonblank string exact match to
    # stored token. Present null/empty/typed/stale → no mutate, no ack.
    # Omitted property preserves legacy id-only set-limit.
    if not _pget_attempt_token_allows(req, op):
        return

    ack_lock = op.get("ack_lock")
    if ack_lock is None:
        ack_lock = threading.RLock()
        op["ack_lock"] = ack_lock

    with ack_lock:
        # Apply under short nested locks; release before any send.
        cv = op.get("lease_cv")
        if cv is None:
            return
        with _PGET_LOCK:
            if _PGET.get(jid) is not op:
                return
            with cv:
                if _PGET.get(jid) is not op:
                    return
                # Re-check token under identity fence in case of same-id replace.
                if not _pget_attempt_token_allows(req, op):
                    return
                _pget_apply_limit_locked(op, gen, lim)

        # Re-entered from an in-flight outer send: apply only; outer drains ack.
        if op.get("ack_sending"):
            op["ack_pending"] = True
            return

        op["ack_sending"] = True
        try:
            while True:
                op["ack_pending"] = False
                snap = _pget_snapshot_live_limit(jid, op)
                if snap is None:
                    return
                live_gen, live_lim = snap
                last_gen = op.get("last_sent_gen")
                if last_gen is not None and live_gen < int(last_gen):
                    return
                # Echo the STORED active token, never request-controlled input.
                msg = {
                    "type": "pget-limit-ack",
                    "id": jid,
                    "maxConnections": live_lim,
                    "providerGeneration": live_gen,
                    "attemptToken": op.get("attemptToken"),
                }
                # Claim before send so concurrent waiters cannot emit lower gens.
                op["last_sent_gen"] = live_gen
                op["last_sent_lim"] = live_lim
                try:
                    _h().send(msg)
                except Exception:
                    pass
                # No stale mutation after send: only re-snapshot / re-send if
                # re-entrant apply marked pending or live state advanced.
                if op.get("ack_pending"):
                    continue
                snap2 = _pget_snapshot_live_limit(jid, op)
                if snap2 is None:
                    return
                if snap2 != (live_gen, live_lim):
                    continue
                break
        finally:
            op["ack_sending"] = False


def handle_pget(req):
    """Multi-range native transfer with structured pget-result terminal contract.

    Probe is conclusive before any worker/file write. Assembly uses a sibling
    .part path; os.replace is the commit point. Live pget-set-limit updates the
    operation lease under the same lock used by openers.

    Operation is registered before the worker thread starts so cancel / set-limit
    work as soon as handle_pget returns. Every registered exit emits exactly one
    structured pget-result. After a successful os.replace the terminal is always
    completed/committed; optional progress/convert work is best-effort.
    """
    jid = req.get("id")
    mode = "multi-range"
    terminal = {"sent": False}
    stop = threading.Event()
    op = _pget_make_op(req, stop, single=False)
    # Immutable start token captured on the op (fencing + progress identity).
    attempt = op.get("attemptToken")

    def finish(status, failure_category, part_state):
        if terminal["sent"]:
            return
        # Mark before send so a send-side failure cannot double-terminal later.
        terminal["sent"] = True
        file_path = None
        file_bytes = None
        if status == "completed" and part_state == "committed":
            file_path, file_bytes = _pget_terminal_file_bytes(op)
        # Unregister this exact op before the terminal so a synchronous same-id
        # fallback (range→single) can register. Identity-safe: never pops a
        # different owner. Final finally-block unregister remains harmless cleanup.
        _pget_unregister(jid, op)
        try:
            _pget_send_result(
                jid, attempt, status, mode, failure_category, part_state,
                file=file_path, bytes=file_bytes,
            )
        except Exception:
            # Terminal intent already recorded; never leak raw send errors.
            pass

    def _honest_part_state(final_path, n):
        if not final_path:
            return "empty"
        return _pget_part_state(final_path, n)

    # Register before the worker starts so pget-cancel / pget-set-limit after
    # handle_pget returns is never a silent no-op during probe/path setup.
    # Reject same-id overwrite so an active worker is never stranded.
    if not _pget_register(jid, op):
        finish("failed", "permanent", "empty")
        return

    def worker():
        final_path = None
        n = 0
        committed = False
        try:
            urls = [u for u in (req.get("urls") or []) if u]
            referer = req.get("referer") or ""
            ua = req.get("userAgent") or ""
            name = _pget_safe_filename(req.get("name") or "download")
            out_dir = req.get("dir") or _h().downloads_dir()

            if op.get("cancel_requested") or stop.is_set():
                finish("cancelled", "cancelled", "empty")
                return

            if not urls:
                finish("failed", "permanent", "empty")
                return

            try:
                size, ok_urls, probe_fail = _pget_probe(urls, referer, ua, op=op)
            except Exception as e:
                size, ok_urls, probe_fail = None, [], _pget_classify_exc(e)

            # Cancel during/after a blocking probe must not start segments.
            if op.get("cancel_requested") or stop.is_set():
                finish("cancelled", "cancelled", "empty")
                return

            if not size or not ok_urls:
                finish("failed", probe_fail or "permanent", "empty")
                return

            try:
                os.makedirs(out_dir, exist_ok=True)
                final_path = _dedup(os.path.join(out_dir, name))
                op["final_path"] = final_path
            except Exception:
                if op.get("cancel_requested") or stop.is_set():
                    finish("cancelled", "cancelled", "empty")
                else:
                    finish("failed", "local_io", "empty")
                return

            if op.get("cancel_requested") or stop.is_set():
                finish("cancelled", "cancelled", "empty")
                return

            _lease, n = _pget_lease(req, size)
            # Keep initial_cap as the true ceiling; n never exceeds it.
            n = max(1, min(n, op["initial_cap"]))
            op["lease"] = op["initial_cap"]
            op["n"] = n
            seg = size // n
            ranges = [
                (i * seg, (size - 1 if i == n - 1 else (i + 1) * seg - 1))
                for i in range(n)
            ]
            seg_done = [0] * n

            if op.get("cancel_requested") or stop.is_set():
                finish("cancelled", "cancelled", "empty")
                return

            def monitor():
                while not stop.is_set() and not terminal["sent"]:
                    try:
                        _h().send({
                            "type": "pget-progress",
                            "id": jid,
                            "attemptToken": attempt,
                            "bytes": sum(seg_done),
                            "total": size,
                        })
                    except Exception:
                        pass
                    if sum(seg_done) >= size:
                        break
                    time.sleep(0.5)

            threading.Thread(target=monitor, daemon=True).start()

            errors = []
            try:
                with concurrent.futures.ThreadPoolExecutor(max_workers=n) as ex:
                    futs = [
                        ex.submit(
                            _pget_segment,
                            "%s.part%d" % (final_path, i),
                            ok_urls, i, s, e, size, referer, ua, seg_done, stop,
                            30, op,
                        )
                        for i, (s, e) in enumerate(ranges)
                    ]
                    for fu in concurrent.futures.as_completed(futs):
                        try:
                            fu.result()
                        except Exception as exc:
                            cat = _pget_classify_exc(exc)
                            errors.append(cat)
                            stop.set()
                            # Wake lease waiters so other workers can exit promptly.
                            cv = op.get("lease_cv")
                            if cv is not None:
                                with cv:
                                    cv.notify_all()
                    # Ensure all workers joined before any terminal classification
                    # (as_completed already waited; context manager shuts down).
            except Exception as exc:
                errors.append(_pget_classify_exc(exc))
                stop.set()

            # Prefer explicit user cancel over generic segment errors.
            if op.get("cancel_requested"):
                _pget_cleanup_work(final_path, n)
                finish("cancelled", "cancelled", _honest_part_state(final_path, n))
                return

            if errors:
                # range_unsupported only after workers joined (above) and cleanup
                _pget_cleanup_work(final_path, n)
                cat = _pget_pick_category(errors)
                # After cleanup for range_unsupported, partState must be empty
                # when nothing remains; compute honestly either way.
                finish("failed", cat, _honest_part_state(final_path, n))
                return

            part_path, _segs = _pget_work_paths(final_path, n)
            try:
                with open(part_path, "wb") as out:
                    for i in range(n):
                        seg_p = "%s.part%d" % (final_path, i)
                        with open(seg_p, "rb") as pf:
                            shutil.copyfileobj(pf, out, 1024 * 1024)
                for i in range(n):
                    try:
                        os.remove("%s.part%d" % (final_path, i))
                    except Exception:
                        pass
                if os.path.getsize(part_path) != size:
                    _pget_cleanup_work(final_path, n)
                    finish("failed", "local_io", _honest_part_state(final_path, n))
                    return
                # Cancel during assembly still wins if replace has not happened.
                if op.get("cancel_requested"):
                    _pget_cleanup_work(final_path, n)
                    finish("cancelled", "cancelled", _honest_part_state(final_path, n))
                    return
                # Commit point: atomic replace into the final deduplicated name.
                os.replace(part_path, final_path)
                committed = True
            except Exception:
                stop.set()
                if not committed:
                    _pget_cleanup_work(final_path, n)
                    if op.get("cancel_requested"):
                        finish("cancelled", "cancelled", _honest_part_state(final_path, n))
                    else:
                        finish("failed", "local_io", _honest_part_state(final_path, n))
                    return
                # Replace already succeeded — fall through to completed.

            # Late cancel after successful replace loses: retain completed.
            # Optional progress / convert is best-effort and must not void commit.
            try:
                _h().send({
                    "type": "pget-progress",
                    "id": jid,
                    "attemptToken": attempt,
                    "bytes": size,
                    "total": size,
                })
            except Exception:
                pass
            try:
                conv = req.get("convert")
                if conv and conv.get("codec") in ("h265", "av1") and _h().FFMPEG:
                    codec = conv["codec"]
                    try:
                        _h().send({
                            "type": "converting",
                            "id": jid,
                            "file": final_path,
                            "codec": codec,
                        })
                    except Exception:
                        pass
                    try:
                        tres = transcode(
                            final_path, codec,
                            conv.get("quality", "visually-lossless"),
                            conv.get("encoder", "auto"),
                            on_progress=lambda pct, j=jid, c=codec: _h().send(
                                {"type": "convert-progress", "id": j, "pct": pct, "codec": c}
                            ),
                        )
                        final_path = tres["path"]
                        op["final_path"] = final_path
                    except Exception:
                        pass
            except Exception:
                pass

            finish("completed", None, "committed")
        except Exception as e:
            # Narrow escape hatch for unexpected registered failures.
            if committed:
                finish("completed", None, "committed")
            elif op.get("cancel_requested"):
                if final_path:
                    _pget_cleanup_work(final_path, n)
                finish("cancelled", "cancelled", _honest_part_state(final_path, n))
            else:
                if final_path:
                    _pget_cleanup_work(final_path, n)
                cat = _pget_classify_exc(e)
                # Path-ish failures already use local_io elsewhere; unexpected
                # internal errors stay structured and non-leaking.
                if cat not in _PGET_FAIL_PRIORITY:
                    cat = "permanent"
                finish("failed", cat, _honest_part_state(final_path, n))
        finally:
            stop.set()
            cv = op.get("lease_cv")
            if cv is not None:
                with cv:
                    cv.notify_all()
            if not terminal["sent"]:
                # Last-chance exactly-one terminal for any registered exit.
                if committed:
                    finish("completed", None, "committed")
                elif op.get("cancel_requested"):
                    if final_path:
                        try:
                            _pget_cleanup_work(final_path, n)
                        except Exception:
                            pass
                    finish("cancelled", "cancelled", _honest_part_state(final_path, n))
                else:
                    if final_path:
                        try:
                            _pget_cleanup_work(final_path, n)
                        except Exception:
                            pass
                    finish("failed", "permanent", _honest_part_state(final_path, n))
            # Identity-safe cleanup: no-op if finish already unregistered this op
            # or a same-id replacement now owns the slot.
            _pget_unregister(jid, op)

    try:
        threading.Thread(target=worker, daemon=True).start()
    except Exception:
        # Starting the worker must not leave a permanent registry entry.
        _pget_unregister(jid, op)
        finish("failed", "permanent", "empty")


def handle_pget_single(req):
    """Native single-connection full-body transfer with structured pget-result.

    One full GET without a Range header. Writes a freshly truncated sibling
    .part, validates Content-Length when present, and commits with os.replace.
    Uses the same live connection lease as multi-range (cap always 1). Exactly
    one intended pget-result on every registered/thread-start exit.

    Failure terminals are emitted only after the response is closed and the
    connection lease is released (openConnections == 0 at observation).
    """
    jid = req.get("id")
    mode = "single-connection"
    terminal = {"sent": False}
    stop = threading.Event()
    op = _pget_make_op(req, stop, single=True)
    attempt = op.get("attemptToken")
    n = 1

    def finish(status, failure_category, part_state):
        if terminal["sent"]:
            return
        terminal["sent"] = True
        file_path = None
        file_bytes = None
        if status == "completed" and part_state == "committed":
            file_path, file_bytes = _pget_terminal_file_bytes(op)
        # Unregister before terminal so same-id re-entry can register.
        _pget_unregister(jid, op)
        try:
            _pget_send_result(
                jid, attempt, status, mode, failure_category, part_state,
                file=file_path, bytes=file_bytes,
            )
        except Exception:
            pass

    def _honest_part_state(final_path):
        if not final_path:
            return "empty"
        return _pget_part_state(final_path, n)

    if not _pget_register(jid, op):
        finish("failed", "permanent", "empty")
        return

    def worker():
        final_path = None
        committed = False
        import urllib.error as _ue

        try:
            urls = [u for u in (req.get("urls") or []) if u]
            referer = req.get("referer") or ""
            ua = req.get("userAgent") or ""
            name = _pget_safe_filename(req.get("name") or "download")
            out_dir = req.get("dir") or _h().downloads_dir()

            if op.get("cancel_requested") or stop.is_set():
                finish("cancelled", "cancelled", "empty")
                return

            if not urls:
                finish("failed", "permanent", "empty")
                return

            # Scheduler-issued single-connection: one selected candidate only.
            url = urls[0]

            try:
                os.makedirs(out_dir, exist_ok=True)
                final_path = _dedup(os.path.join(out_dir, name))
                op["final_path"] = final_path
                op["n"] = n
            except Exception:
                if op.get("cancel_requested") or stop.is_set():
                    finish("cancelled", "cancelled", "empty")
                else:
                    finish("failed", "local_io", "empty")
                return

            if op.get("cancel_requested") or stop.is_set():
                finish("cancelled", "cancelled", "empty")
                return

            part_path = final_path + ".part"
            got = 0
            expected = None
            acquired = False
            resp = None
            # Record outcome only; cleanup + terminal run after close/release.
            outcome = None  # (status, category) or None while in progress
            try:
                if not _pget_lease_acquire(op):
                    raise _PgetError("cancelled")
                acquired = True
                if op.get("cancel_requested") or stop.is_set():
                    raise _PgetError("cancelled")
                resp = _pget_open(url, referer, ua, range_header=None, timeout=30)
                status = getattr(resp, "status", None) or getattr(resp, "code", None)
                if status != 200:
                    raise _PgetError(_pget_classify_http_status(status or 0))
                cl_hdr = resp.headers.get("Content-Length")
                if cl_hdr is not None and str(cl_hdr).strip() != "":
                    try:
                        expected = int(cl_hdr)
                        if expected < 0:
                            expected = None
                    except (TypeError, ValueError):
                        expected = None

                # wb truncates any pre-existing stale .part (never append).
                reader = _PgetReader(resp, 30)
                cancelled = lambda: bool(op.get("cancel_requested") or stop.is_set())
                with open(part_path, "wb") as f:
                    while True:
                        chunk = reader.read(65536, cancelled)
                        if not chunk:
                            break
                        f.write(chunk)
                        got += len(chunk)
                        try:
                            _h().send({
                                "type": "pget-progress",
                                "id": jid,
                                "attemptToken": attempt,
                                "bytes": got,
                                "total": expected if expected is not None else got,
                            })
                        except Exception:
                            pass

                if expected is not None and got != expected:
                    raise _PgetError("short_read")

                if op.get("cancel_requested") or stop.is_set():
                    raise _PgetError("cancelled")

                # Commit point.
                os.replace(part_path, final_path)
                committed = True
            except _PgetError as e:
                if e.category == "cancelled" or op.get("cancel_requested"):
                    outcome = ("cancelled", "cancelled")
                else:
                    outcome = ("failed", e.category)
            except _ue.HTTPError as e:
                try:
                    cat = _pget_classify_http_status(e.code)
                finally:
                    _pget_close_resp(e)
                if op.get("cancel_requested"):
                    outcome = ("cancelled", "cancelled")
                else:
                    outcome = ("failed", cat)
            except OSError as e:
                if op.get("cancel_requested"):
                    outcome = ("cancelled", "cancelled")
                else:
                    cat = "local_io"
                    if not getattr(e, "filename", None):
                        c2 = _pget_classify_exc(e)
                        if c2 in ("timeout", "connection_reset"):
                            cat = c2
                    outcome = ("failed", cat)
            except Exception as e:
                if op.get("cancel_requested"):
                    outcome = ("cancelled", "cancelled")
                else:
                    cat = _pget_classify_exc(e)
                    if cat not in _PGET_FAIL_PRIORITY:
                        cat = "permanent"
                    outcome = ("failed", cat)
            finally:
                # Quiesce: close response and release lease before any terminal.
                _pget_close_resp(resp)
                resp = None
                if acquired:
                    _pget_lease_release(op)
                    acquired = False

            if committed:
                # Late cancel after successful replace loses: retain completed.
                try:
                    total = expected if expected is not None else got
                    _h().send({
                        "type": "pget-progress",
                        "id": jid,
                        "attemptToken": attempt,
                        "bytes": got,
                        "total": total,
                    })
                except Exception:
                    pass
                try:
                    conv = req.get("convert")
                    if conv and conv.get("codec") in ("h265", "av1") and _h().FFMPEG:
                        codec = conv["codec"]
                        try:
                            _h().send({
                                "type": "converting",
                                "id": jid,
                                "file": final_path,
                                "codec": codec,
                            })
                        except Exception:
                            pass
                        try:
                            tres = transcode(
                                final_path, codec,
                                conv.get("quality", "visually-lossless"),
                                conv.get("encoder", "auto"),
                                on_progress=lambda pct, j=jid, c=codec: _h().send(
                                    {
                                        "type": "convert-progress",
                                        "id": j,
                                        "pct": pct,
                                        "codec": c,
                                    }
                                ),
                            )
                            final_path = tres["path"]
                            op["final_path"] = final_path
                        except Exception:
                            pass
                except Exception:
                    pass
                finish("completed", None, "committed")
                return

            # Non-commit path: clean work only after close/release above.
            if final_path:
                try:
                    _pget_cleanup_work(final_path, n)
                except Exception:
                    pass
            if outcome is None:
                outcome = ("failed", "permanent")
            status, category = outcome
            finish(status, category, _honest_part_state(final_path))
        except Exception as e:
            if committed:
                finish("completed", None, "committed")
            elif op.get("cancel_requested"):
                if final_path:
                    try:
                        _pget_cleanup_work(final_path, n)
                    except Exception:
                        pass
                finish("cancelled", "cancelled", _honest_part_state(final_path))
            else:
                if final_path:
                    try:
                        _pget_cleanup_work(final_path, n)
                    except Exception:
                        pass
                cat = _pget_classify_exc(e)
                if cat not in _PGET_FAIL_PRIORITY:
                    cat = "permanent"
                finish("failed", cat, _honest_part_state(final_path))
        finally:
            stop.set()
            cv = op.get("lease_cv")
            if cv is not None:
                with cv:
                    cv.notify_all()
            if not terminal["sent"]:
                if committed:
                    finish("completed", None, "committed")
                elif op.get("cancel_requested"):
                    if final_path:
                        try:
                            _pget_cleanup_work(final_path, n)
                        except Exception:
                            pass
                    finish("cancelled", "cancelled", _honest_part_state(final_path))
                else:
                    if final_path:
                        try:
                            _pget_cleanup_work(final_path, n)
                        except Exception:
                            pass
                    finish("failed", "permanent", _honest_part_state(final_path))
            # Identity-safe cleanup if finish already unregistered this op.
            _pget_unregister(jid, op)

    try:
        threading.Thread(target=worker, daemon=True).start()
    except Exception:
        _pget_unregister(jid, op)
        finish("failed", "permanent", "empty")

# yt-dlp tool discovery state (owned here; ensure_ytdlp/ensure_deno and the
# shim main()'s _yt_probe rebind these). Initialised at the BOTTOM of the
# module, not at the original in-section position: find_* resolve _h().HERE,
# and when mchost.downloads is imported BEFORE mc_host the _h() call imports
# the shim, whose `from mchost.downloads import ...` lines need every name in
# this module already defined. By this line they all are, so the standalone
# import completes cleanly. Same values as the original init.
YTDLP = find_ytdlp()
NODE = find_node()
DENO = find_deno()
