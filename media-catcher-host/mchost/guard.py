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

No mchost sibling is imported here: guard sits under everything else so any
module can use it without an import-order hazard.
"""

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
