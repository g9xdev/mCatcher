"""In-process yt-dlp, so the frequent, worst hangs never happen.

Design: docs/superpowers/specs/ (settings-probe + this refactor). yt-dlp's exe
launch was the biggest and most frequent target for antivirus image scanning —
every version probe, every metadata probe, every download resolve spawned it,
and under a browser-descended process each launch was held. Imported into the
resident host instead, there is no per-call PE image to scan: the host is
scanned once at startup and yt-dlp runs as Python.

`parse_options` converts the EXACT CLI args the host already builds into a
YoutubeDL opts dict, so this stays at parity with the exe instead of guessing at
internal opts-key shapes. deno (JS challenge) and ffmpeg (merge) are still
subprocesses yt-dlp shells out to — less frequent, one binary each — so this is
a large reduction in scan surface, not total immunity. The exe path remains as a
fallback for installs without the library.

Cross-module names resolve through the mc_host shim at CALL time (`_h().<name>`).
"""
import os
import sys
import threading

_UNIT = {"K": 1024, "M": 1048576, "G": 1073741824, "T": 1099511627776}


def _h():
    import mc_host
    return mc_host


# ---- availability ---------------------------------------------------------

def lib_dir():
    """The vendored dependency directory: HERE/pylib, populated by bootstrap's
    `pip install --target`. Kept off system Python so nothing is polluted."""
    return os.path.join(_h().HERE, "pylib")


def available(pylib=None):
    """True when yt_dlp can be imported from the vendored dir. Cheap file check,
    not an import, so calling it does not drag yt_dlp into the process before we
    have decided to use it."""
    pylib = pylib if pylib is not None else lib_dir()
    return os.path.isfile(os.path.join(pylib, "yt_dlp", "__init__.py"))


_import_lock = threading.Lock()
_yt_dlp = None


def _yt(pylib=None):
    """Import yt_dlp from the vendored dir once, with the dir on sys.path."""
    global _yt_dlp
    if _yt_dlp is not None:
        return _yt_dlp
    with _import_lock:
        if _yt_dlp is None:
            d = pylib if pylib is not None else lib_dir()
            if d not in sys.path:
                sys.path.insert(0, d)
            import yt_dlp  # noqa: E402
            _yt_dlp = yt_dlp
    return _yt_dlp


def lib_version(pylib=None):
    if not available(pylib):
        return None
    try:
        return _yt(pylib).version.__version__
    except Exception:
        return None


# ---- pure mapping: yt-dlp hook dicts -> the ytdl-progress message shape ----
# Must match _parse_yt_progress so the extension sees no difference between the
# exe's stdout lines and the library's hook callbacks.

def hook_to_progress(d):
    """A yt-dlp progress_hook dict -> {stage, pct, total, bps}, or None if the
    dict is not a download-in-flight line."""
    if not d or d.get("status") != "downloading":
        return None
    total = d.get("total_bytes") or d.get("total_bytes_estimate")
    got = d.get("downloaded_bytes") or 0
    out = {"stage": "downloading"}
    if total:
        out["pct"] = 100.0 * got / total
        out["total"] = total
    else:
        out["pct"] = None       # unknown size: the extension keeps the last total
    speed = d.get("speed")
    if speed:                   # None between samples; a bogus 0 would jitter the ETA
        out["bps"] = int(speed)
    return out


def pp_to_progress(d):
    """A postprocessor_hook dict -> the merging marker, or None. Only the Merger
    start matters; the stdout path emitted pct 99 there."""
    if d and d.get("status") == "started" and d.get("postprocessor") == "Merger":
        return {"stage": "merging", "pct": 99}
    return None


def final_path(info):
    """The saved file from a finished info dict. requested_downloads carries the
    post-merge path; the top-level filepath is the fallback."""
    rd = info.get("requested_downloads") if isinstance(info, dict) else None
    if rd and isinstance(rd, list) and rd[0].get("filepath"):
        return rd[0]["filepath"]
    return (info or {}).get("filepath")


# ---- options ---------------------------------------------------------------

class HostLogger:
    """Routes yt-dlp's log output to a sink, NEVER to stdout — stdout is the
    native-messaging channel and any byte on it corrupts the framing. Shapes to
    yt-dlp's logger interface (debug/info/warning/error)."""

    def __init__(self, sink):
        self._sink = sink

    def debug(self, msg):
        # yt-dlp prefixes real debug lines with "[debug] "; the rest are info.
        if not (msg or "").startswith("[debug] "):
            self._sink("info", msg)

    def info(self, msg):
        self._sink("info", msg)

    def warning(self, msg):
        self._sink("warn", msg)

    def error(self, msg):
        self._sink("error", msg)


def harden_opts(opts, sink=None):
    """Force yt-dlp silent regardless of what the args asked for. --no-quiet on
    the exe forced status lines back on; in-process that would dump them to the
    messaging channel. Progress and notes come from hooks only."""
    opts["quiet"] = True
    opts["no_warnings"] = True
    opts["noprogress"] = True
    opts["logger"] = HostLogger(sink or (lambda level, msg: _h()._hlog(level, msg, "ytdlp")))
    return opts


def build_opts(argv, pylib=None, sink=None):
    """Convert CLI-style args (exactly what the host builds for the exe) into a
    (ydl_opts, urls) pair via yt-dlp's own parser — guaranteed exe parity — then
    harden so nothing can reach stdout."""
    parsed = _yt(pylib).parse_options(list(argv))
    ydl_opts = getattr(parsed, "ydl_opts", None)
    urls = getattr(parsed, "urls", None)
    if ydl_opts is None:        # older tuple form (parser, opts, urls, ydl_opts)
        ydl_opts = parsed[-1]
        urls = parsed[2]
    harden_opts(ydl_opts, sink)
    return ydl_opts, urls


# ---- extract (the -J probe, in-process) -----------------------------------

def extract_info(argv, pylib=None):
    """Run the metadata probe in-process. Returns the info dict, or raises."""
    yt = _yt(pylib)
    opts, urls = build_opts(argv, pylib)
    with yt.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(urls[0], download=False)
        return ydl.sanitize_info(info)


# ---- the subprocesses yt-dlp still spawns ---------------------------------
# "In-process" removed yt-dlp's own exe, not the ones it shells out to. deno
# solves the JS challenge through `Popen.communicate_or_kill` with NO timeout,
# so a hung deno parks the calling thread emitting nothing — no progress hook,
# no log line, and therefore no poll of the caller's cancel flag. Bounding that
# silence is not enough; something has to take the child away.
#
# Every yt-dlp spawn site — the JS runtimes, ffmpeg, the cookie helpers — writes
# `from yt_dlp.utils import Popen`, which binds the CLASS OBJECT. So wrapping
# that class's __init__ IN PLACE reaches all of them whatever the import order,
# where rebinding yt_dlp.utils.Popen would miss everything already imported.
#
# This module only watches. _safe_kill and the process-tree policy live in
# downloads.py, and the caller decides what a child is worth doing anything to.

_child_lock = threading.Lock()
_child_sinks = {}               # launching thread ident -> sink(proc)
_HOOK_MARK = "_mchost_child_hook"
_hook_warned = [False]


def _announce_child(proc):
    """Hand a just-spawned process to whatever the LAUNCHING thread registered.

    Keyed by thread because each download owns a worker thread and yt-dlp does
    its resolve work, JS challenge included, on the thread that called
    extract_info. Concurrent jobs therefore never see each other's children, so
    one job's stall cannot take another job's healthy deno. A thread with no
    entry is a thread nobody asked about.
    """
    with _child_lock:
        sink = _child_sinks.get(threading.get_ident())
    if sink is None:
        return
    try:
        sink(proc)
    except Exception:
        pass        # watching is never worth failing a download that would work


def _warn_hook_off(why):
    """Say once that the hook is not in effect. Silence here would be the worst
    kind: downloads keep working, so nothing looks wrong, while every stall goes
    back to leaking a worker thread — the very symptom the hook exists to end."""
    if _hook_warned[0]:
        return
    _hook_warned[0] = True
    try:
        _h()._hlog("warn", "yt-dlp: not watching subprocesses (%s); a wedged "
                           "child cannot be killed" % why, "ytdlp")
    except Exception:
        pass


def _install_child_hook(pylib=None):
    """Wrap yt_dlp.utils.Popen.__init__ in place, once. True if it is in effect.

    Fails soft on every path: a yt-dlp that renames or drops the spawn funnel
    leaves downloads working exactly as they do today, minus this lever — but
    never quietly, because the lever going missing is invisible otherwise.
    """
    try:
        cls = getattr(getattr(_yt(pylib), "utils", None), "Popen", None)
        if cls is None:
            _warn_hook_off("no utils.Popen")
            return False
        # __dict__, not getattr: a subclass would inherit the mark and go unwrapped.
        if cls.__dict__.get(_HOOK_MARK):
            return True
        original = cls.__init__

        def __init__(self, *args, **kwargs):
            original(self, *args, **kwargs)
            _announce_child(self)       # only once a spawn has actually happened

        cls.__init__ = __init__
        setattr(cls, _HOOK_MARK, True)
        return True
    except Exception as e:
        # e.g. a C-implemented Popen, whose __init__ cannot be assigned.
        _warn_hook_off("could not wrap utils.Popen: %s" % e)
        return False


def _arm_child_sink(sink, pylib=None):
    """Report this thread's yt-dlp spawns to `sink` until disarmed."""
    _install_child_hook(pylib)
    with _child_lock:
        _child_sinks[threading.get_ident()] = sink


def _disarm_child_sink():
    with _child_lock:
        _child_sinks.pop(threading.get_ident(), None)


# ---- download (in-process, with progress + cancellation) ------------------

class Cancelled(Exception):
    pass


def download(argv, on_progress=None, on_note=None, should_cancel=None,
             on_child=None, pylib=None):
    """Run a download in-process.

    on_progress(msg): the {stage,pct,...} dicts, ready to forward as ytdl-progress.
    on_note(text):    a resolution-phase label (Reading page, Choosing format, …).
    should_cancel():  polled inside the hook; when it returns True the download is
                      aborted by raising, which yt-dlp unwinds cleanly.
    on_child(proc):   each subprocess yt-dlp spawns for THIS call — deno for the
                      JS challenge, ffmpeg for the merge. The lever for a wedge
                      no hook and no log line can reach; see _announce_child.

    Returns the saved file path, or None. Raises Cancelled on user cancel.
    """
    yt = _yt(pylib)
    if on_child is not None:
        _arm_child_sink(on_child, pylib)
    try:
        return _download(yt, argv, on_progress, on_note, should_cancel, pylib)
    finally:
        if on_child is not None:
            _disarm_child_sink()


def _download(yt, argv, on_progress, on_note, should_cancel, pylib):
    """The body of download(), split out so the child sink is disarmed on every
    exit — return, cancel, and throw alike."""
    # The logger sink doubles as the resolution-phase note source: yt-dlp's
    # "[youtube] Downloading webpage" etc. arrive here as info lines, the same
    # text _yt_stage_note mapped from stdout. Anything not a note still gets
    # logged to the console.
    from mchost.downloads import _yt_stage_note   # the same mapper the exe path used

    def _sink(level, msg):
        # The progress hooks do not fire until bytes flow, so this is the only
        # poll that can see a cancel during resolve — yt-dlp logs here from its
        # first "[youtube] Downloading webpage".
        if should_cancel is not None and should_cancel():
            raise Cancelled()
        if on_note and level == "info":
            note = _yt_stage_note(msg or "")
            if note:
                on_note(note)
                return
        _h()._hlog(level, msg, "ytdlp")

    opts, urls = build_opts(argv, pylib, sink=_sink)

    def _hook(d):
        if should_cancel and should_cancel():
            raise Cancelled()
        msg = hook_to_progress(d)
        if msg and on_progress:
            on_progress(msg)

    def _pp(d):
        if should_cancel and should_cancel():
            raise Cancelled()
        msg = pp_to_progress(d)
        if msg and on_progress:
            on_progress(msg)

    opts.setdefault("progress_hooks", []).append(_hook)
    opts.setdefault("postprocessor_hooks", []).append(_pp)

    with yt.YoutubeDL(opts) as ydl:
        try:
            info = ydl.extract_info(urls[0], download=True)
        except Cancelled:
            raise
        info = ydl.sanitize_info(info)
        return final_path(info)


def update(pylib=None):
    """In-process installs update by re-running pip; the exe's -U does not apply.
    Left as a no-op hook so callers have one shape; bootstrap owns the pip path."""
    return None
