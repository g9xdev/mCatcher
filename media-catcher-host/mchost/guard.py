"""The extension/host boundary.

The extension runs inside Firefox's sandbox. This host does not. Every frame
that crosses the native-messaging port is therefore attacker-controlled input
for as long as anything can reach the extension's message path, and a field
taken from one of those frames and used as a filesystem path, a subprocess
argument or a shell verb is a sandbox escape, not a convenience.

MESSAGE_SCHEMA / validate_message say what each `cmd` may carry, and of what
type. This is the FIRST thing main() does with a message. Its job is narrow and
worth stating plainly: it stops type confusion (a dict where a str is expected,
a list where an int is), it stops unknown commands, and it stops a malformed
frame from throwing out of the read loop. A `str` check on a path does NOT make
that path safe — containment checks at the point of use are what do that.

MEDIA_EXTS is the one list of suffixes this helper deals in, in both
directions: refuse_open says what `open` and `reveal` may hand to the OS, and
refuse_basename says what this host may create.
os.startfile is ShellExecuteW: it RUNS the file with its registered handler, so
an extension that could name a path could run it. Windows has far too many
executable suffixes to blocklist (.exe .bat .cmd .ps1 .lnk .scr .hta .msi .js
.vbs .wsf .cpl .msc .pif .com .url .settingcontent-ms …, plus whatever the next
shell integration adds), so this is an ALLOWLIST of the media, container,
subtitle and thumbnail suffixes this host actually produces.

temp_basename turns a caller-supplied job id into a single contained filename.
A job id is an opaque correlation token, not a path component.

No mchost sibling is imported here: guard sits under everything else so any
module can use it without an import-order hazard.
"""
import hashlib
import os
import re

# ---------------------------------------------------------------------------
# Field kinds
#
# Every field is OPTIONAL and null is always legal — that is exactly how the
# handlers already read them (`req.get(name)` yielding None). `required` names
# the few whose absence is not a default but a crash.
#
# bool is a subclass of int in Python, so "int"/"num" exclude it explicitly:
# {"seq": true} must not be read as segment 1.
# ---------------------------------------------------------------------------

def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def _is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


_KINDS = {
    "str": (lambda v: isinstance(v, str), "a string"),
    # ids and request ids are opaque correlation tokens; the extension has used
    # both numbers and strings for them since the first protocol.
    "id": (lambda v: isinstance(v, str) or _is_int(v), "a string or an integer"),
    "int": (_is_int, "an integer"),
    "num": (_is_num, "a number"),
    "bool": (lambda v: isinstance(v, bool), "a boolean"),
    "scalar": (lambda v: isinstance(v, str) or _is_num(v), "a string or a number"),
    "strlist": (lambda v: isinstance(v, list) and all(isinstance(x, str) for x in v),
                "a list of strings"),
    "dict": (lambda v: isinstance(v, dict), "an object"),
}

STR, ID, INT, NUM, BOOL = "str", "id", "int", "num", "bool"
SCALAR, STRLIST, DICT = "scalar", "strlist", "dict"


# ---------------------------------------------------------------------------
# The table
#
# One entry per `cmd == "..."` branch in mc_host.main(). test_host.py asserts
# that this table and the branches it guards name the SAME set of commands, so
# a command added to the loop without an entry here fails the suite rather than
# arriving unvalidated.
#
# Fields listed are the ones the handler (and everything it delegates to) reads.
# Unlisted keys are ignored rather than refused: the extension adds fields ahead
# of the host from time to time, and refusing them would make every such rollout
# a hard break. The security property is that no LISTED field can arrive as the
# wrong type, and that nothing dispatches on an unlisted `cmd`.
# ---------------------------------------------------------------------------

MESSAGE_SCHEMA = {
    "ping": {},
    "ytdl": {"id": ID, "url": STR, "name": STR, "dir": STR, "format": STR,
             "attemptToken": STR},
    "ytmeta": {"reqId": ID, "url": STR},
    "cast": {"sub": STR, "reqId": ID, "id": STR, "action": STR, "value": SCALAR,
             "pin": STR, "timeout": NUM, "warm": BOOL, "device": STR,
             "title": STR, "url": STR},
    "ytdlUpdate": {},
    "record": {"id": ID, "base": STR, "videoUrl": STR, "audioUrl": STR,
               "referer": STR, "userAgent": STR},
    "stop": {"id": ID},
    "snapshot": {"id": ID, "base": STR, "dir": STR},
    "save": {"id": ID, "base": STR, "dir": STR, "convert": DICT},
    "saveAs": {"id": ID, "base": STR, "dir": STR, "convert": DICT},
    "pickFolder": {"requestId": ID, "reqId": ID, "dir": STR},
    "open": {"id": ID, "path": STR},
    "reveal": {"id": ID, "path": STR},
    "update": {"extDir": STR, "zipDir": STR, "profileDir": STR, "silent": BOOL},
    "watch": {"enable": BOOL, "extDir": STR, "zipDir": STR},
    "checkGithub": {"auto": BOOL, "force": BOOL, "extDir": STR, "zipDir": STR,
                    "extVersion": STR},
    "discard": {"id": ID},
    "pget": {"id": ID, "urls": STRLIST, "name": STR, "dir": STR, "referer": STR,
             "userAgent": STR, "maxConnections": NUM, "convert": DICT,
             "attemptToken": STR},
    "pget-single": {"id": ID, "urls": STRLIST, "name": STR, "dir": STR,
                    "referer": STR, "userAgent": STR, "maxConnections": NUM,
                    "convert": DICT, "attemptToken": STR},
    "pget-set-limit": {"id": ID, "maxConnections": NUM, "providerGeneration": NUM,
                       "attemptToken": STR},
    "getReport": {"reqId": ID},
    "probe": {"reqId": ID},
    "pget-cancel": {"id": ID, "attemptToken": STR},
    "file-open": {"jobId": STR, "attemptToken": STR, "requestedFilename": STR,
                  "dir": STR},
    "file-chunk": {"sinkId": STR, "jobId": STR, "attemptToken": STR, "seq": INT,
                   "length": INT, "dataB64": STR},
    "file-commit": {"sinkId": STR, "jobId": STR, "attemptToken": STR},
    "file-abort": {"sinkId": STR, "jobId": STR, "attemptToken": STR},
}

# Fields whose absence is not a default but a fault. Kept deliberately small:
# every handler below already answers a missing optional field with its own,
# more specific frame, and promoting those to schema errors would replace good
# messages with a generic one. run_job's `req["videoUrl"]` is the exception —
# it runs on a worker thread, so the KeyError died silently with no frame at
# all and the recording row hung forever.
REQUIRED_FIELDS = {
    "record": ("id", "videoUrl"),
}


def validate_message(msg):
    """None when `msg` may be dispatched; otherwise a refusal naming the fault.

    Never raises. This runs BEFORE main()'s per-message try/except — a throw
    here is a dead host, not an error frame — so every access is defensive.
    """
    try:
        if not isinstance(msg, dict):
            return ("invalid message: expected an object, got %s"
                    % type(msg).__name__)

        cmd = dict.get(msg, "cmd")
        if not isinstance(cmd, str):
            return "invalid message: field 'cmd' must be a string"
        fields = MESSAGE_SCHEMA.get(cmd)
        if fields is None:
            return "invalid message: unknown cmd %r" % (cmd,)

        for name in REQUIRED_FIELDS.get(cmd, ()):
            if dict.get(msg, name) is None:
                return ("invalid message: field %r is required (cmd=%s)"
                        % (name, cmd))

        for name, kind in fields.items():
            if name not in msg:
                continue
            value = dict.get(msg, name)
            if value is None:
                continue        # null reads the same as absent through .get()
            check, described = _KINDS[kind]
            if not check(value):
                return ("invalid message: field %r must be %s (cmd=%s)"
                        % (name, described, cmd))
        return None
    except Exception as e:                     # pragma: no cover - belt and braces
        return "invalid message: %s" % (e,)


def message_id(msg):
    """The correlation id to echo on a refusal, or None.

    Read defensively and only accepted as a scalar: a refusal frame carrying an
    attacker-shaped object back out would just move the problem to the
    extension's own message handling.
    """
    try:
        if not isinstance(msg, dict):
            return None
        for key in ("id", "reqId", "requestId", "jobId"):
            v = dict.get(msg, key)
            if isinstance(v, str) or _is_num(v):
                return v
    except Exception:
        pass
    return None


# ---------------------------------------------------------------------------
# The suffixes this helper deals in
#
# ONE list, used in both directions. A file this host WRITES and a file it will
# later hand to the shell are the same category of thing: everything it writes
# is something the extension may later ask it to open. Two lists would drift,
# and either drift is a bug -- a wider write list means files the user cannot
# open from the popup, a wider open list means opening suffixes this host never
# produced, which is the residual the missing directory check already leaves.
#
# One asymmetry, deliberate: a name with NO suffix may be written but not
# opened. An extensionless file has no registered handler, so it cannot be the
# executable drop this list exists to stop, and there is nothing for
# ShellExecuteW to do with it either.
# ---------------------------------------------------------------------------

MEDIA_EXTS = frozenset({
    # containers / video
    ".mp4", ".m4v", ".mkv", ".webm", ".mov", ".avi", ".flv", ".ts", ".m2ts",
    ".mts", ".mpg", ".mpeg", ".mpe", ".wmv", ".ogv", ".3gp", ".3g2", ".mxf",
    ".divx", ".rmvb", ".vob",
    # audio
    ".m4a", ".m4b", ".mp3", ".aac", ".flac", ".wav", ".opus", ".ogg", ".oga",
    ".wma", ".aiff", ".aif", ".ac3", ".dts", ".alac", ".ape",
    # subtitles the downloader writes alongside a video
    ".srt", ".vtt", ".ass", ".ssa", ".lrc", ".sub",
    # thumbnails / poster art
    ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif",
})


# CON/PRN/AUX/NUL/COM1-9/LPT1-9 are DEVICES on Windows, not files, and they are
# devices in EVERY directory. "con.mp4" passes any suffix check and still opens
# the console — the match is on the stem before the FIRST dot, so a suffix
# cannot launder one.
_WIN_DEVICE_NAMES = frozenset(
    ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"]
    + ["COM%d" % i for i in range(1, 10)]
    + ["LPT%d" % i for i in range(1, 10)]
)

_WIN_RESERVED_CHARS = frozenset('\\/:*?"<>|')


def _ext_ok(path):
    ext = os.path.splitext(path)[1].lower()
    return bool(ext) and ext in MEDIA_EXTS


def _is_device_name(name):
    return name.split(".")[0].strip().upper() in _WIN_DEVICE_NAMES


def refuse_basename(name):
    """None when `name` is a filename this host may CREATE, else a reason.

    The escape an unvalidated destination hands an attacker is not "write into
    an odd folder", it is "drop a file the OS will later execute" — a .exe in
    the per-user Startup folder is logon persistence and needs no `open` at
    all. Constraining the basename removes that primitive whatever the
    directory turns out to be, which is what matters here because the directory
    question is still open.

    Nor is the name reachable only by a compromised extension: background.js
    derives it from the URL and Content-Disposition, so a hostile PAGE reaches
    this too.

    The shape rules mirror filesink._is_safe_basename, which vets shape but
    never the suffix; the suffix and device rules are the half that was missing
    everywhere.
    """
    if not isinstance(name, str) or not name.strip():
        return "refused: no filename given"
    if "/" in name or "\\" in name or os.path.isabs(name):
        return "refused: %r is a path, not a filename" % (name,)
    if name in (".", "..") or os.path.basename(name) != name:
        return "refused: %r is a path, not a filename" % (name,)
    for ch in name:
        if ord(ch) < 32 or ord(ch) == 127 or ch in _WIN_RESERVED_CHARS:
            return "refused: %r contains a character a filename may not" % (name,)
    if name[-1] in (" ", "."):
        # Win32 strips these when it creates the file, so the name checked would
        # not be the name written.
        return "refused: %r ends in a space or a dot" % (name,)
    if _is_device_name(name):
        return "refused: %r names a Windows device, not a file" % (name,)
    if not _ext_ok(name):
        return "refused: %r is not a media file this helper writes" % (name,)
    return None


def neutralize_device_name(stem):
    """A display name the host will give its OWN suffix to, made non-device.

    Used where the host chose the suffix and the user must not lose the file
    (a finished recording), so this coerces rather than refusing: "con" becomes
    "_con" and is a file again. Anything already safe is returned untouched.
    """
    if isinstance(stem, str) and _is_device_name(stem):
        return "_" + stem
    return stem


def resolve_existing_dir(dir_val, default_dir=None):
    """(realpath, None) for a destination this host may write into, else
    (None, reason).

    The directory must ALREADY EXIST. Both pget handlers opened with
    os.makedirs(out_dir, exist_ok=True), so a destination that did not exist was
    built on demand anywhere the user can write — a primitive worth removing on
    its own, and mchost/filesink.py has required an existing directory since it
    was written.

    Absent / null / blank falls back to `default_dir` (Downloads by default),
    which is exactly how `req.get("dir") or downloads_dir()` already read, so a
    picked folder that exists and the default both still work.

    NOT an approved-roots check. The host still cannot tell a user-chosen
    destination from an attacker-chosen one, because the only channel carrying
    the user's choice is the one the attacker controls — see the boundary
    report. This narrows the primitive; it does not close the question.
    """
    if dir_val is None or (isinstance(dir_val, str) and not dir_val.strip()):
        if default_dir is None:
            import mc_host
            default_dir = mc_host.downloads_dir()
        dir_val = default_dir
    if not isinstance(dir_val, str) or not dir_val.strip():
        return None, "destination folder is not a path"
    if not os.path.isabs(dir_val):
        return None, "destination folder is not an absolute path"
    try:
        real = os.path.realpath(dir_val)
    except Exception:
        return None, "destination folder could not be resolved"
    if not os.path.isdir(real):
        return None, "destination folder does not exist"
    return real, None


def refuse_open(path):
    """None when `path` is safe to hand to the shell, else a user-facing reason.

    Shape only — the caller still does its own existence check. Deliberately
    evaluated BEFORE that stat so a refused path is never probed for existence
    on the caller's behalf.

    The suffix is checked on the path as given AND on its realpath: a symlink,
    junction or hardlink named clip.mp4 that resolves onto payload.exe is
    exactly the case a name-only check misses.
    """
    if not isinstance(path, str) or not path.strip():
        return "refused: no file path given"

    # NTFS alternate data stream — "clip.mp4:payload.exe" is one file to the
    # shell and two different suffixes to anything that splits on the last dot.
    _drive, rest = os.path.splitdrive(path)
    if ":" in rest:
        return "refused: %s is not a file this helper can open" % os.path.basename(path)

    # Win32 strips a trailing dot or space when it opens the file, so a name
    # ending in one resolves to a DIFFERENT suffix than any check can see.
    if path[-1] in (" ", "."):
        return "refused: %s is not a file this helper can open" % os.path.basename(path)

    if not _ext_ok(path):
        return ("refused: %s is not a media file this helper produced"
                % os.path.basename(path))

    try:
        real = os.path.realpath(path)
    except Exception:
        return "refused: %s could not be resolved" % os.path.basename(path)
    if not _ext_ok(real):
        return ("refused: %s resolves to something this helper cannot open"
                % os.path.basename(path))
    return None


# ---------------------------------------------------------------------------
# A job id is not a path component
# ---------------------------------------------------------------------------

_UNSAFE_ID = re.compile(r"[^A-Za-z0-9_-]+")


def temp_basename(job_id, prefix="mc_", ext=".mp4"):
    """One contained filename for a caller-supplied job id.

    Dots go too, not just separators: on Win32 a trailing dot is stripped by the
    filesystem, so "mc_.." normalises to a literal "mc_" directory and an
    attacker buys a level of traversal with one extra "..".

    The collapse is lossy, so a short digest of the ORIGINAL id is appended:
    two live recordings whose ids differ only in collapsed characters would
    otherwise share one temp file and overwrite each other.
    """
    raw = job_id if isinstance(job_id, str) else ("" if job_id is None else str(job_id))
    token = _UNSAFE_ID.sub("_", raw)[:64].strip("_")
    digest = hashlib.sha1(raw.encode("utf-8", "surrogatepass")).hexdigest()[:10]
    return "%s%s%s%s" % (prefix, (token + "_") if token else "", digest, ext)


def temp_path(tmpdir, job_id, prefix="mc_", ext=".mp4"):
    """temp_basename joined under `tmpdir`, with the containment re-checked.

    The basename cannot carry a separator by construction; the check is here so
    that stays true if the character class above is ever widened.
    """
    name = temp_basename(job_id, prefix=prefix, ext=ext)
    if os.path.basename(name) != name:          # pragma: no cover - invariant
        raise ValueError("temp_basename produced a path, not a name: %r" % name)
    return os.path.join(tmpdir, name)
