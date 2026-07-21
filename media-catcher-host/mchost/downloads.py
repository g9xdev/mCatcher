"""Recording jobs, optional H.265/AV1 conversion, and the save / save-as /
pick-folder / open / reveal / discard handlers (moved verbatim from
mc_host.py — Task C3 part 1).

Cross-module/patched names (send, _hlog, FFMPEG, TMPDIR, sanitize,
downloads_dir) resolve through the mc_host shim at CALL time (`_h().<name>`)
so monkeypatched fakes are always honored — the splitting-modules-under-
monkeypatch rule. JOBS/JOBS_LOCK (the recording registry) and
_HEVC_ENC/_ENC_CACHE (encoder probe caches) are mutable state OWNED here;
the shim carries no copies (a shim copy would go stale when this module
rebinds them). subprocess is the GLOBAL module object, so the test suite's
setattr(mc_host.subprocess, "Popen", ...) patch is seen here too.
"""
import os
import re
import shutil
import subprocess
import sys
import threading


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
