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
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time


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
    try:
        if p and p.poll() is None:
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
    """Native folder picker for the settings page. Replies {type:folder,dir}."""
    def worker():
        d = _ask_folder(req.get("dir") or _h().downloads_dir())
        _h().send({"type": "folder", "reqId": req.get("reqId"), "dir": d or ""})
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
    manual installer re-run."""
    global YTDLP
    if YTDLP:
        return YTDLP
    if os.name != "nt":
        return None
    dest = os.path.join(_h().HERE, "yt-dlp.exe")
    try:
        import urllib.request
        _h()._hlog("info", "fetching yt-dlp (first YouTube use)…")
        tmp = dest + ".part"
        req = urllib.request.Request("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe",
                                     headers={"User-Agent": "MediaCatcher-Host/%s" % _h().VERSION})
        with urllib.request.urlopen(req, timeout=180) as r, open(tmp, "wb") as f:
            shutil.copyfileobj(r, f)
        os.replace(tmp, dest)
        YTDLP = dest
        _h()._hlog("info", "yt-dlp installed")
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
    if s.startswith("[download] destination"):
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


def handle_ytdl(req):
    """Download a YouTube (or other yt-dlp-supported) URL at the highest quality:
    best video + best audio, merged to mp4 by yt-dlp+ffmpeg, using the PO-token
    provider and Firefox cookies for reliability. Streams progress; maps failures
    to explicit reasons instead of silently downgrading."""
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
        cmd = [ytdlp, "--no-playlist", "--no-mtime", "--newline", "--progress", "--no-warnings", "--force-overwrites",
               "-f", fmt, "--merge-output-format", "mp4",
               "--cookies-from-browser", "firefox",
               "-o", outtmpl,
               # --print puts yt-dlp in quiet mode; --progress above forces the bar back on.
               "--print", "after_move:@@FILE@@ %(filepath)s"]
        if _h().FFMPEG:
            cmd += ["--ffmpeg-location", os.path.dirname(_h().FFMPEG)]
        if deno:     # solve the 'n' challenge -> unlocks the real (incl. 4K) formats
            cmd += ["--js-runtimes", "deno:%s" % deno]
        if pot:      # only when the optional PO-token provider is actually running
            cmd += ["--extractor-args", "youtubepot-bgutilhttp:base_url=http://127.0.0.1:%d" % _POT_PORT]
        cmd += [url]
        _h()._hlog("info", "yt-dlp: downloading %s (pot=%s)" % (url, "on" if pot else "off"))
        _h().send({"type": "ytdl-progress", "id": jid, "pct": 0, "stage": "resolving", "note": "Preparing"})
        cf, si = _no_window()
        try:
            p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 creationflags=cf, startupinfo=si, text=True, bufsize=1)
        except Exception as e:
            _h().send({"type": "ytdl-error", "id": jid, "reason": "spawn", "error": str(e)})
            return
        errbuf = []
        filepath = None
        last_pct = -1.0
        last_note = ""
        last_note_ts = 0.0
        _PGET[jid] = {"proc": p}               # so a cancel can kill it
        for line in p.stdout:
            s = line.strip()
            if not s:
                continue
            if s.startswith("@@FILE@@"):
                filepath = s[len("@@FILE@@"):].strip()
                continue
            if s.startswith("[download]"):
                prog = _parse_yt_progress(s)
                if prog:
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
        p.wait()
        _PGET.pop(jid, None)
        if p.returncode == 0 and filepath and os.path.isfile(filepath):
            _h().send({"type": "ytdl-done", "id": jid, "file": filepath, "bytes": os.path.getsize(filepath)})
            _h()._hlog("info", "yt-dlp: saved %s" % os.path.basename(filepath))
        else:
            reason, msg = _map_yt_error("\n".join(errbuf))
            _h()._hlog("error", "yt-dlp failed (%s): %s" % (reason, ("\n".join(errbuf[-6:]))[:500]))
            _h().send({"type": "ytdl-error", "id": jid, "reason": reason, "error": msg})
    threading.Thread(target=worker, daemon=True).start()

# ---- parallel multi-mirror direct download --------------------------------
# Fetch a direct file from one or more mirror URLs using several range requests
# at once, with per-segment failover to another mirror. Each segment streams to
# its own part file (no concurrent writes to one handle), then the parts are
# stitched into a sibling .part path and committed with os.replace. Terminal
# outcomes are structured pget-result messages (never browser handoff).
_PGET = {}  # id -> operation dict (stop Event, cancel flag, optional yt-dlp proc)
_PGET_MAX_CONN = 6
_PGET_CR_PROBE = re.compile(r"^bytes 0-0/(\d+)$")
_PGET_CR_SEG = re.compile(r"^bytes (\d+)-(\d+)/(\d+)$")
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


def _pget_send_result(id, attemptToken, status, mode, failureCategory, partState):
    """Emit exactly one structured terminal pget-result (caller enforces once)."""
    _h().send({
        "type": "pget-result",
        "id": id,
        "attemptToken": attemptToken,
        "status": status,
        "mode": mode,
        "failureCategory": failureCategory,
        "partState": partState,
    })


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


def _pget_probe_one(url, referer, ua, timeout=30):
    """Probe a single mirror with Range: bytes=0-0 after redirects.

    Returns one of:
      ("ok", total, url)
      ("range_unsupported", None, url)
      ("fail", category, url)
    """
    import urllib.error as _ue

    resp = None
    try:
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


def _pget_probe(urls, referer, ua, timeout=30):
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
        kind, total, _u = _pget_probe_one(u, referer, ua, timeout=timeout)
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
                  seg_done, stop, timeout=30):
    """Download bytes [start, end] into part_path with mirror failover.

    Validates 206 + exact Content-Range, reads exactly the expected length, and
    closes handles before returning. Raises _PgetError on failure.
    """
    import urllib.error as _ue

    length = end - start + 1
    order = urls[idx % len(urls):] + urls[:idx % len(urls)]
    errors = []
    for u in order:
        if stop.is_set():
            raise _PgetError("cancelled")
        got = 0
        try:
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
                with open(part_path, "wb") as f:
                    while got < length:
                        if stop.is_set():
                            raise _PgetError("cancelled")
                        chunk = r.read(min(65536, length - got))
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
                # No point trying other mirrors for conclusive no-range on this
                # resource shape; still record and continue only if others remain.
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


def _pget_cancel(req):
    j = _PGET.get(req.get("id"))
    if not j:
        return
    j["cancel_requested"] = True
    if j.get("stop"):
        j["stop"].set()          # segmented pget: signal the workers
    if j.get("proc"):
        _safe_kill(j["proc"])    # yt-dlp job: kill the process


def _pget_unregister(jid, op):
    """Pop registry only if it still points at this exact operation."""
    if _PGET.get(jid) is op:
        _PGET.pop(jid, None)


def _pget_lease(req, size):
    """Initial finite connection lease from maxConnections, clamped safely."""
    try:
        raw = int(req.get("maxConnections") or 1)
    except (TypeError, ValueError):
        raw = 1
    lease = max(1, min(_PGET_MAX_CONN, raw))
    # Segment count never exceeds lease, file size (bytes), or safe cap.
    by_mib = max(1, size // (1024 * 1024)) if size >= 1024 * 1024 else 1
    n = max(1, min(lease, _PGET_MAX_CONN, size, by_mib))
    return lease, n


def handle_pget(req):
    """Multi-range native transfer with structured pget-result terminal contract.

    Probe is conclusive before any worker/file write. Assembly uses a sibling
    .part path; os.replace is the commit point. Live pget-set-limit is Task 13.

    Operation is registered before the worker thread starts so cancel works as
    soon as handle_pget returns. Every registered exit emits exactly one
    structured pget-result. After a successful os.replace the terminal is always
    completed/committed; optional progress/convert work is best-effort.
    """
    jid = req.get("id")
    attempt = req.get("attemptToken")
    mode = "multi-range"
    terminal = {"sent": False}
    stop = threading.Event()
    op = {
        "stop": stop,
        "cancel_requested": False,
        "lease": None,
        "n": 0,
        "final_path": None,
    }

    def finish(status, failure_category, part_state):
        if terminal["sent"]:
            return
        # Mark before send so a send-side failure cannot double-terminal later.
        terminal["sent"] = True
        try:
            _pget_send_result(jid, attempt, status, mode, failure_category, part_state)
        except Exception:
            # Terminal intent already recorded; never leak raw send errors.
            pass

    def _honest_part_state(final_path, n):
        if not final_path:
            return "empty"
        return _pget_part_state(final_path, n)

    # Register before the worker starts so pget-cancel after handle_pget returns
    # is never a silent no-op during probe/path setup.
    _PGET[jid] = op

    def worker():
        final_path = None
        n = 0
        committed = False
        try:
            urls = [u for u in (req.get("urls") or []) if u]
            referer = req.get("referer") or ""
            ua = req.get("userAgent") or ""
            name = _h().sanitize(req.get("name") or "download")
            out_dir = req.get("dir") or _h().downloads_dir()

            if op.get("cancel_requested") or stop.is_set():
                finish("cancelled", "cancelled", "empty")
                return

            if not urls:
                finish("failed", "permanent", "empty")
                return

            try:
                size, ok_urls, probe_fail = _pget_probe(urls, referer, ua)
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
            op["lease"] = _lease
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
                _h().send({"type": "pget-progress", "id": jid, "bytes": size, "total": size})
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
            _pget_unregister(jid, op)

    try:
        threading.Thread(target=worker, daemon=True).start()
    except Exception:
        # Starting the worker must not leave a permanent registry entry.
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
