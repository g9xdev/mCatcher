"""The durable record of files THIS HOST WROTE.

WHAT IT ANSWERS, AND WHAT IT DOES NOT
-------------------------------------
`delete` removes a file permanently and `thumb` reads one, and both take the
path from the extension. guard.refuse_open answers a question about SHAPE --
is this the kind of file this helper deals in -- and that is all it can
answer: a .mp4 the user recorded with another program has exactly the shape of
one this host saved. This module answers the other question, "did we write
it", and `delete` requires BOTH answers before it removes anything.

It is not an authorisation check in the sandbox sense. A compromised extension
can ask this host to write a file and then ask it to delete that file, and
both are things the popup legitimately does. What the ledger removes is the
class where a path this host never touched -- a document, a key file, a
media file the user made elsewhere -- is handed to os.remove because it
happened to end in .mp4.

APPEND-ONLY, AND NO TOMBSTONES
------------------------------
A delete does NOT remove the line. A file can be written again to the same
path (a re-download of the same name lands on the same dedup'd name), and a
tombstone would then have to be un-done to keep that second file deletable.
Growth is one line, about 120 bytes, per file this host finishes; the read is
cached against the file's own (mtime, size) so the ordinary case is one stat.

WHERE IT LIVES
--------------
Beside the host's other durable state (mchost/hlog.py's update-history.jsonl),
in the host's own install directory -- the folder tools.py already describes as
the host's private state, written by nothing but the host and its installer.

WHEN IT CANNOT BE WRITTEN
-------------------------
record() answers False and nothing else changes: the download still completes
and the frame still goes out. The cost is that the file cannot later be
deleted from the popup, which is the direction that fails safe.
"""
import io
import json
import os
import threading
import time

from mchost import tools

# Tests point this at a ledger of their own. Deliberately not read from the
# environment or from a config file: which files this host admits to having
# written is not a setting, for the same reason tools.py's BadApple candidate
# list is not one.
_PATH_OVERRIDE = None

_LOCK = threading.Lock()

# Parsed keys plus the (mtime_ns, size) of the file they were parsed from.
# Another host process (a second Firefox variant) appends to the same file, so
# the stamp is what makes a cached answer safe: an append always changes the
# size.
_CACHE = {"stamp": None, "keys": frozenset()}

# One line is a path plus a timestamp. A line longer than this is not one this
# module wrote, so it is skipped rather than parsed.
_MAX_LINE = 8192


# Joined ONCE, at import. record() runs on paths a caller is about to be told
# about, and one of those callers (the ytdl structured lane's emit_done) is
# inside a window test_ytdl_protocol.py pins as doing no path arithmetic at
# all: after its NT rename has succeeded, an os.path.join that throws would
# lose a claim on a file already on disk. A constant costs nothing there.
_DEFAULT_PATH = os.path.join(tools.HERE, "written-files.jsonl")


def ledger_path():
    return _PATH_OVERRIDE or _DEFAULT_PATH


def _key(path):
    """The one spelling of `path` this module compares on, or None.

    normcase over realpath: Windows compares paths case-insensitively and
    accepts either separator, and the popup's copy of a path travels through
    the extension and back. realpath additionally resolves the junctions a
    profile directory can sit behind, so the spelling recorded at write time
    and the spelling checked at delete time agree.
    """
    if not isinstance(path, str) or not path.strip():
        return None
    try:
        return os.path.normcase(os.path.realpath(path))
    except Exception:
        return None


def forget_cache():
    """Drop what this module holds in memory. Tests, and nothing else."""
    with _LOCK:
        _CACHE["stamp"] = None
        _CACHE["keys"] = frozenset()


def _stamp(path):
    try:
        st = os.stat(path)
        return (st.st_mtime_ns, st.st_size)
    except Exception:
        return None


def _load_locked(path):
    stamp = _stamp(path)
    if stamp is None:
        _CACHE["stamp"] = None
        _CACHE["keys"] = frozenset()
        return _CACHE["keys"]
    if stamp == _CACHE["stamp"]:
        return _CACHE["keys"]
    keys = set()
    try:
        with io.open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line or len(line) > _MAX_LINE:
                    continue
                try:
                    entry = json.loads(line)
                except Exception:
                    continue        # a torn append costs its own line, not the file
                if not isinstance(entry, dict):
                    continue
                key = entry.get("key")
                if isinstance(key, str) and key:
                    keys.add(key)
    except Exception:
        return _CACHE["keys"]
    _CACHE["stamp"] = stamp
    _CACHE["keys"] = frozenset(keys)
    return _CACHE["keys"]


def record(path):
    """Append `path` to the ledger. True when a line was written.

    Never raises: every caller is a download that has already succeeded, and a
    ledger this host cannot write is not a reason to fail one.
    """
    key = _key(path)
    if key is None:
        return False
    line = json.dumps({"path": os.path.realpath(path), "key": key,
                       "at": int(time.time() * 1000)},
                      ensure_ascii=True)
    try:
        with _LOCK:
            with io.open(ledger_path(), "a", encoding="utf-8") as fh:
                # One write of one line: O_APPEND makes concurrent appends from
                # a second host process interleave by line rather than by byte.
                fh.write(line + "\n")
            # The stamp this cache was built against is now stale; rather than
            # re-read the file here, add the key and re-stamp.
            _CACHE["keys"] = frozenset(_CACHE["keys"] | {key})
            _CACHE["stamp"] = _stamp(ledger_path())
        return True
    except Exception:
        return False


def was_written(path):
    """True when this host recorded writing `path`."""
    key = _key(path)
    if key is None:
        return False
    with _LOCK:
        return key in _load_locked(ledger_path())
