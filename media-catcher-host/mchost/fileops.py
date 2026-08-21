"""What this host does to a saved file itself: remove it, or read one frame.

WHY THIS IS NOT downloads.py
----------------------------
`open`, `reveal` and `badapple` all end the same way: a path is handed to
another program and this host is finished with it. guard.refuse_open is the
whole gate there, because the danger is what the SHELL makes of a suffix.

The two verbs here do not hand the path anywhere. `delete` removes the file
permanently, and `thumb` reads its bytes. That is a different question, and it
needs a second answer refuse_open cannot give.

THE TWO GATES, AND WHY BOTH
---------------------------
guard.refuse_open answers a question about SHAPE — is this the KIND of file
this helper deals in. It cannot answer "did this helper write it": a .mp4 the
user shot on a phone and copied into Downloads has exactly the same shape as
one this host produced. mchost/written.py is the ledger that answers the
second question, and _guarded_target requires BOTH before either verb touches
anything.

Neither gate is an authorisation check in the sandbox sense. A compromised
extension can ask this host to download a file and then ask it to delete that
same file, and both are things the popup legitimately does. What the pair
removes is the class where a path this host never touched is handed to
os.remove because it happened to end in .mp4.

`..` IS NOT REFUSED BY SPELLING. It is resolved, and the file it resolves onto
is the one both gates are asked about. That is what keeps working when the
spelling changes — the popup's copy of a path travels out through the
extension and back before it arrives here.

WHAT DELETE DOES, AND WHAT IT DOES NOT
--------------------------------------
os.remove, permanently. Not a Recycle Bin move: the owner chose a permanent
delete with a confirm step in the popup, so the reversal the user gets is the
dialog, not a second copy of the file taking up the space they were trying to
free.

Before removing, it lets go of the file HERE — see _release_local_holders. A
sharing violation after that is REPORTED with the reason Windows gave, and not
retried: something outside this process is holding the file and will go on
holding it, so a loop is a worker spinning on a file the user was told nothing
about.

WHAT THUMB DOES, AND WHAT IT WILL NOT DO
----------------------------------------
One ffmpeg frame from a LOCAL PATH, scaled into a 320x320 box, as a JPEG data:
URL. There is deliberately no `url` field on the frame and no code here that
would read one: fetching a remote stream URL from the host would make this
helper an HTTP client pointed wherever the extension says, reaching whatever
this machine can route to, and that is a bigger surface than the picture is
worth. The path it takes is one this host itself wrote.

THE FRAME CEILING IS MEASURED, NOT ASSUMED. Firefox's own
modules/NativeMessaging.sys.mjs caps what a native application may SEND at
MAX_READ = 1024 * 1024 bytes (lowerable by the pref
webextensions.native-messaging.max-input-message-bytes), and a frame over the
cap does not fail one request — _startRead throws and the whole port goes
down, taking every live download row with it. So MAX_JPEG_BYTES below is
enforced on the encoder's ACTUAL output rather than argued from pixel
dimensions: JPEG size depends on content, and a 320px-WIDE frame of a very
tall video is not small.
"""
import base64
import ctypes
import os
import subprocess
import threading
from ctypes import wintypes

from mchost import badapple_ipc
from mchost import guard
from mchost import tools
from mchost import written
# _no_window is downloads.py's, and stays there: one definition of "hide the
# child console" rather than a second free to drift from it.
from mchost.downloads import _no_window
from mchost.tools import find_badapple


def _h():
    """Call-time shim lookup, the same convention downloads/hlog/config use."""
    import mc_host
    return mc_host


# ---------------------------------------------------------------------------
# Win32, for the one question Python's own file API cannot ask
#
# CPython's open() and os.open() take the CRT's default sharing (_SH_DENYNO),
# so they succeed on a file another process is holding and tell us nothing.
# Asking for the file with NO sharing is the question _file_is_held needs, and
# CreateFileW is the only way to ask it.
#
# Declared here rather than borrowed from badapple_ipc's identical block: that
# module's is part of writing to a pipe, and a file-lock probe reaching into
# another module's private handle for a DLL is a coupling that buys nothing.
# ---------------------------------------------------------------------------

_GENERIC_READ = 0x80000000
_FILE_SHARE_NONE = 0
_OPEN_EXISTING = 3
_ERROR_SHARING_VIOLATION = 32
_INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value

_K32 = None


def _kernel32():
    global _K32
    if _K32 is None:
        k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                  wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD,
                                  wintypes.HANDLE]
        k.CreateFileW.restype = wintypes.HANDLE
        k.CloseHandle.argtypes = [wintypes.HANDLE]
        _K32 = k
    return _K32


# ---------------------------------------------------------------------------
# Sizes
# ---------------------------------------------------------------------------

# Firefox's cap on a frame FROM this host, read out of
# browser/omni.ja -> modules/NativeMessaging.sys.mjs on this machine:
#     const MAX_READ = 1024 * 1024;
#     ... if (len > lazy.maxRead) throw new ExtensionError(...)
# It is the READ side of the port, so it is this host's WRITE limit.
NATIVE_FRAME_CEILING = 1024 * 1024

# The budget for the JPEG itself. base64 costs 4 bytes out per 3 in, so this
# encodes to 524,288 characters; the rest of the frame (type, reqId,
# atSeconds, the data: prefix, JSON punctuation) is under a hundred bytes, and
# the 4KiB of headroom the test checks is there so a later field cannot creep
# the frame over the line unnoticed.
#
# Measured against the shape this verb actually produces: ffmpeg on pure
# random noise fitted into the 320x320 box below came out at 111,709 bytes at
# -q:v 2 and 80,170 at -q:v 6 — noise being the worst case JPEG has, since it
# is what the DCT cannot compress. A real 640x360 test pattern at -q:v 3 was
# 7,154 bytes. The budget is therefore roughly 3.5x the measured worst case,
# and it is still enforced on the real output because "measured worst case" is
# a statement about the files measured.
MAX_JPEG_BYTES = 384 * 1024

# A BOX, not a width. Capping the width alone leaves the height free, and a
# 320px-wide frame of a very tall video is not a thumbnail: 320x1706 noise
# measured 595,793 bytes, five times the 320x320 worst case.
THUMB_BOX = 320
JPEG_QUALITY = 3                # mjpeg -q:v, 2 (best) .. 31

# Where in the clip the frame comes from. 15s skips the title cards and black
# frames most downloads open on; a clip shorter than that has no frame there
# at all, so the fallback is what keeps a short download from showing nothing.
DEFAULT_AT_SECONDS = 15
SHORT_CLIP_AT_SECONDS = 1

# One decode is a few hundred milliseconds. This is the bound on a decode that
# is not going to finish — a file on a share that went away mid-read.
FFMPEG_TIMEOUT = 30

# Bounded twice, and evicted least-recently-USED first -- dict order, with
# _cache_get moving a key it answers to the end. The count is the working set
# the popup actually asks for (one screen of rows, re-asked each time it opens);
# the byte budget is what keeps the count honest, because an entry is a data:
# URL and MAX_JPEG_BYTES says one can be 512KB base64. 64 of those would be
# 32MB held by a helper that is otherwise idle.
_THUMB_CACHE_MAX = 64
_THUMB_CACHE_BYTES = 8 * 1024 * 1024
_THUMB_CACHE = {}
_THUMB_CACHE_HELD = [0]
_THUMB_LOCK = threading.Lock()


def forget_thumb_cache():
    """Drop what this module holds in memory. Tests, and nothing else."""
    with _THUMB_LOCK:
        _THUMB_CACHE.clear()
        _THUMB_CACHE_HELD[0] = 0


# ---------------------------------------------------------------------------
# The gate both verbs share
# ---------------------------------------------------------------------------

def _guarded_target(path):
    """(resolved path, None) for a file BOTH gates admit, else (None, reason).

    refuse_open runs first, for the reason handle_open's docstring already
    gives: a refused path is never probed for existence on the caller's
    behalf, and the ledger lookup resolves the path, which touches the
    filesystem.
    """
    refusal = guard.refuse_open(path)
    if refusal:
        return None, refusal
    if not written.was_written(path):
        # Names the file and says what is missing, so the person reading it in
        # the popup can tell "this is not one of mine" from "this is broken".
        return None, ("refused: %s is not a file this helper downloaded or "
                      "recorded, so it is not one it will act on"
                      % os.path.basename(path))
    try:
        return os.path.realpath(path), None
    except Exception:
        return None, "refused: %s could not be resolved" % os.path.basename(path)


# ---------------------------------------------------------------------------
# delete
# ---------------------------------------------------------------------------

def _file_is_held(path):
    """True when some process on this machine has `path` open.

    CreateFileW with dwShareMode 0 asks Windows for the file with NO sharing,
    and Windows refuses that with a sharing violation when ANY other handle on
    the file is open, whatever sharing THAT handle allowed. So this is a direct
    answer to "would the os.remove below hit a sharing violation", without
    reading a byte and without a second guess about which programs lock what.

    The handle is closed immediately. Nothing is read, written or truncated:
    GENERIC_READ with OPEN_EXISTING creates nothing and modifies nothing.

    FALSE when the file is free, when it is not there, and when the probe
    itself fails. All three answer the only question the caller asks — should
    this host go stopping a player over this file — with "no reason to".
    """
    try:
        k = _kernel32()
        handle = k.CreateFileW(path, _GENERIC_READ, _FILE_SHARE_NONE, None,
                               _OPEN_EXISTING, 0, None)
    except Exception:
        return False
    if handle == _INVALID_HANDLE_VALUE or handle is None:
        return ctypes.get_last_error() == _ERROR_SHARING_VIOLATION
    k.CloseHandle(handle)
    return False


def _release_local_holders(path):
    """Let go of `path` here, so the os.remove after it is not fighting us.

    TWO holders this process can reach, and both have to go BEFORE the remove
    — a release afterwards releases nothing.

      (a) BadApple, which may be PLAYING the file. Stopped through the same
          --stop the popup's stop button uses, so there is one way to stop it
          rather than two that can drift. CONDITIONAL — see below.

      (b) this host's OWN local media server (mchost/cast/legacy.py). It
          serves a cast file over plain HTTP from _DLNA["media"] and opens the
          file per request; a cast that ended without an explicit stop leaves
          its token registered for the rest of the session. Stopping BadApple
          does not touch it, which is the part that is easy to miss.

    (b) IS UNCONDITIONAL, because it costs the user nothing: retiring a token
    in this process's own dict is not something they can see. (a) is a process
    the user is watching, and ending it is not a side effect a delete gets to
    have for free.

    WHAT THE CONDITION CAN AND CANNOT BE. "Is BadApple playing THIS file" is
    not answerable from here: their command pipe takes `--beam "<target>"` and
    an optional credential, with no query verb and no reply channel. The two
    facts that ARE answerable are asked instead, and the stop needs both:

        the file is held open by SOMETHING   (_file_is_held, above)
      AND a BadApple is running at all       (badapple_ipc.is_running)

    Neither is the question we would rather ask. Together they rule out the
    two cases that were plainly wrong — a delete of a file nobody has open
    ending someone's unrelated playback, and a `--stop` that STARTS BadApple
    purely to tell it to stop — and they leave one case over-broad: BadApple
    running, the file held by something else, playback of something unrelated
    ended. Narrowing that one needs a verb on their side, not a cleverer probe
    on this one.

    What (b) CANNOT do is close a handle a response already holds: _serve_file
    keeps the file open for the length of one response, and a response in
    flight when this runs keeps its handle until it ends. Retiring the entry
    stops a NEW request opening one. The remove that follows reports whatever
    is left.

    Best effort on both: a holder that will not let go is a reason for the
    remove to fail with a message, not a reason to fail before trying.
    """
    if _file_is_held(path) and badapple_ipc.is_running():
        _spawn_badapple_stop()
    try:
        from mchost.cast import legacy
        legacy.release_local_path(path)
    except Exception:
        pass


def _remove_failure(path, exc):
    """The user-facing half of an OSError from os.remove.

    strerror is Windows' own sentence ("The process cannot access the file
    because it is being used by another process"), which says more than any
    rewording of it would.
    """
    detail = getattr(exc, "strerror", None) or str(exc)
    return "could not delete %s: %s" % (os.path.basename(path), detail)


def handle_delete(req):
    """Remove one saved file, permanently.

    On a worker, like handle_open and handle_reveal: every filesystem touch
    below is on a caller-supplied path, and one naming a dead network share
    blocks a stat for as long as the SMB timeout takes. The read loop is not
    where that lands.

    EVERY answer carries reqId, including the refusals. The popup correlates
    on it and drops what it cannot place, so an answer without one is a click
    that did nothing with no way to say so.
    """
    def worker():
        req_id = req.get("reqId")

        def answer(ok, error=None):
            _h().send({"type": "delete-result", "reqId": req_id,
                       "ok": ok, "error": error})

        target, refusal = _guarded_target(req.get("path"))
        if refusal:
            answer(False, refusal)
            return
        if not os.path.isfile(target):
            answer(False, "could not delete %s: it is no longer there"
                          % os.path.basename(target))
            return

        _release_local_holders(target)
        try:
            os.remove(target)
        except OSError as e:
            # ONE attempt. A sharing violation is an answer about who is
            # holding the file, not a transient to sit on.
            answer(False, _remove_failure(target, e))
            return
        except Exception as e:
            answer(False, _remove_failure(target, e))
            return
        answer(True)

    threading.Thread(target=worker, daemon=True).start()


# ---------------------------------------------------------------------------
# badapple-stop
# ---------------------------------------------------------------------------

def _spawn_badapple_stop():
    """(ok, error). Spawn the installed BadApple with a bare --stop.

    THE PROGRAM IS NOT CALLER-SUPPLIED. find_badapple reads a fixed list
    compiled into this host, and this frame has no field beyond reqId, so
    there is nothing on it that could reach argv at all. An argv LIST with
    shell=False, the same spawn discipline the beam uses: nothing is parsed as
    a command line.

    ONE THING THIS SIDE CANNOT GUARANTEE. If BadApple is not already running,
    starting it with --stop starts a process; whether that process puts a
    window up before it exits is decided by BadApple's own argv handling, not
    here. _no_window() suppresses a console window, which is not the same
    thing as suppressing a WPF one. Making --stop a no-op when no instance is
    running belongs on the BadApple side.
    """
    app = find_badapple()
    if not app:
        return False, "BadApple is not installed on this computer."
    cf, si = _no_window()
    try:
        subprocess.Popen([app, "--stop"], creationflags=cf, startupinfo=si)
    except Exception as e:
        return False, "BadApple would not stop: %s" % e
    return True, None


def handle_badapple_stop(req):
    """Stop whatever BadApple is playing.

    On a worker: a process start is not instant, and the popup's stop button
    must not be able to hold the read loop.
    """
    def worker():
        ok, error = _spawn_badapple_stop()
        _h().send({"type": "badapple-stop-result", "reqId": req.get("reqId"),
                   "ok": ok, "error": error})

    threading.Thread(target=worker, daemon=True).start()


# ---------------------------------------------------------------------------
# thumb
# ---------------------------------------------------------------------------

def _at_seconds(value):
    """The offset to decode at: the caller's number, or the default.

    bool is excluded the way guard's own "num" kind excludes it — {"atSeconds":
    true} must not read as one second. A negative offset is not a position in
    a file, so it reads as the default rather than as an ffmpeg argument.
    """
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if value >= 0:
            return value
    return DEFAULT_AT_SECONDS


def _run_ffmpeg_frame(path, at):
    """(jpeg bytes, None) for one frame at `at` seconds, else (None, reason).

    -ss BEFORE -i is the input seek: ffmpeg jumps to the keyframe rather than
    decoding from the start, which is what makes this cheap on a long file.

    The scale is a BOX, not a width — see THUMB_BOX. force_original_aspect_
    ratio=decrease fits the frame inside it without stretching, and
    force_divisible_by=2 keeps both sides even, which the encoder requires.
    """
    cmd = [tools.FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin",
           "-ss", "%g" % at, "-i", path, "-frames:v", "1",
           "-vf", ("scale=w=%d:h=%d:force_original_aspect_ratio=decrease"
                   ":force_divisible_by=2" % (THUMB_BOX, THUMB_BOX)),
           "-q:v", str(JPEG_QUALITY), "-f", "image2pipe", "-c:v", "mjpeg",
           "pipe:1"]
    cf, si = _no_window()
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=FFMPEG_TIMEOUT, creationflags=cf,
                           startupinfo=si)
    except subprocess.TimeoutExpired:
        return None, ("reading a frame from %s took longer than %ds"
                      % (os.path.basename(path), FFMPEG_TIMEOUT))
    except Exception as e:
        return None, "could not read a frame from %s: %s" % (
            os.path.basename(path), e)

    out = p.stdout or b""
    if p.returncode != 0 or not out.startswith(b"\xff\xd8"):
        # ffmpeg's own text goes to the log console rather than into the
        # frame: seeking past the end of a clip produces a paragraph about
        # colour ranges, which is not what happened.
        try:
            _h()._hlog("info", "thumb: no frame at %gs in %s: %s"
                               % (at, os.path.basename(path),
                                  (p.stderr or b"").decode("utf-8", "replace")[-400:]))
        except Exception:
            pass
        return None, "there is no frame at %gs in %s" % (
            at, os.path.basename(path))
    return out, None


def _cache_get(key):
    """The entry, and reading it COUNTS as using it.

    The eviction below walks insertion order, so without the re-insert here it
    is FIFO: the popup asks for every visible row each time it opens, an answer
    off the cache writes nothing, and the row the user looks at every single
    time would be evicted in favour of one decoded once and never asked for
    again. Moving the key to the end makes the order least-recently-USED.
    """
    with _THUMB_LOCK:
        hit = _THUMB_CACHE.get(key)
        if hit is not None:
            _THUMB_CACHE.pop(key)
            _THUMB_CACHE[key] = hit
        return hit


def _cache_put(key, value):
    with _THUMB_LOCK:
        old = _THUMB_CACHE.pop(key, None)
        if old is not None:
            _THUMB_CACHE_HELD[0] -= len(old[0])
        _THUMB_CACHE[key] = value
        _THUMB_CACHE_HELD[0] += len(value[0])
        while _THUMB_CACHE and (len(_THUMB_CACHE) > _THUMB_CACHE_MAX
                                or _THUMB_CACHE_HELD[0] > _THUMB_CACHE_BYTES):
            dropped = _THUMB_CACHE.pop(next(iter(_THUMB_CACHE)))
            _THUMB_CACHE_HELD[0] -= len(dropped[0])


def handle_thumb(req):
    """One frame of a saved file, as a JPEG data: URL.

    LOCAL PATH ONLY. There is no `url` field on this frame and no read of one
    here; see the module docstring for why that is a decision rather than an
    omission.

    The path is held to the SAME two gates `delete` is: it is still a
    caller-supplied path, and reading an arbitrary file's first bytes back to
    the extension is a disclosure even when nothing is removed.

    CACHED on (resolved path, mtime, size, offset). mtime and size are what
    make a re-download safe: a second download of the same name lands on the
    same deduplicated path, and a cache keyed on the path alone would serve
    the old file's frame for the new one. The offset is in the key because two
    offsets are two different pictures.

    On a worker: ffmpeg is a process start plus a decode.
    """
    def worker():
        req_id = req.get("reqId")
        asked = _at_seconds(req.get("atSeconds"))

        def answer(data_url, at_used, error=None):
            _h().send({"type": "thumb-result", "reqId": req_id,
                       "dataUrl": data_url, "atSeconds": at_used,
                       "error": error})

        target, refusal = _guarded_target(req.get("path"))
        if refusal:
            answer(None, asked, refusal)
            return
        try:
            st = os.stat(target)
        except Exception:
            # Not just OSError: an embedded NUL raises ValueError here, which
            # is the same answer as far as the caller is concerned.
            answer(None, asked, "could not read %s: it is no longer there"
                                % os.path.basename(target))
            return

        key = (os.path.normcase(target), st.st_mtime_ns, st.st_size, asked)
        hit = _cache_get(key)
        if hit is not None:
            answer(hit[0], hit[1])
            return

        if not tools.FFMPEG:
            answer(None, asked, "ffmpeg not found. Re-run the installer or "
                                "put ffmpeg.exe next to the helper.")
            return

        used = asked
        data, error = _run_ffmpeg_frame(target, asked)
        if data is None and asked > SHORT_CLIP_AT_SECONDS:
            # A clip shorter than the offset has no frame there. Ask again near
            # the start, and SAY which frame came back rather than repeating
            # the offset that did not work.
            used = SHORT_CLIP_AT_SECONDS
            data, error = _run_ffmpeg_frame(target, used)
        if data is None:
            answer(None, asked, error)
            return

        if len(data) > MAX_JPEG_BYTES:
            # Never sent. A frame over Firefox's ceiling does not fail this
            # one request, it takes the port down with every live download.
            answer(None, used,
                   "the frame from %s came out at %d bytes, over the %d this "
                   "port can carry" % (os.path.basename(target), len(data),
                                       MAX_JPEG_BYTES))
            return

        data_url = "data:image/jpeg;base64," + base64.b64encode(data).decode("ascii")
        _cache_put(key, (data_url, used))
        answer(data_url, used)

    threading.Thread(target=worker, daemon=True).start()
