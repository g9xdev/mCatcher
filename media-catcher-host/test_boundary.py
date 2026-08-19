"""The extension/host boundary: what the host accepts from the extension, and
what it is willing to do with it.

Why this file exists
--------------------
The host does not run in Firefox's sandbox; the extension does. So the port
between them is a privilege boundary, and every field crossing it is attacker
input for as long as any content script, compromised page or malicious update
can reach the extension's message path. Before this file, `main()` dispatched
on `cmd` and handed the raw dict to each handler, which read fields with
`req.get(...)` and used them directly as filesystem paths and subprocess argv.

What the schema buys, honestly: it stops TYPE CONFUSION (a dict where a str is
expected, a list where an int is) and it stops silent drops. It does NOT make a
string safe to use as a path — containment at the point of use is what does
that.
"""
import json
import struct
import subprocess
import sys

from conftest import HOST, load_host

mc = load_host()

from mchost import guard   # noqa: E402


# ---------------------------------------------------------------------------
# Framed conversation helpers (same shape as test_host.py's)
# ---------------------------------------------------------------------------

def _write(p, obj):
    data = json.dumps(obj).encode("utf-8")
    p.stdin.write(struct.pack("@I", len(data)) + data)
    p.stdin.flush()


def _read_reply(p, max_frames=10):
    """Next NON-LOG frame, or None at EOF. The host interleaves {"type":"log"}
    frames (startup banner, async yt-dlp probe) with replies."""
    for _ in range(max_frames):
        raw = p.stdout.read(4)
        if len(raw) < 4:
            return None
        (n,) = struct.unpack("@I", raw)
        frame = json.loads(p.stdout.read(n).decode())
        if frame.get("type") != "log":
            return frame
    return None


def _host():
    return subprocess.Popen([sys.executable, HOST], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)


# ---------------------------------------------------------------------------
# 1. The dispatch-level schema gate
# ---------------------------------------------------------------------------

def test_malformed_messages_are_refused_and_the_loop_survives():
    """Three malformed frames, then a ping.

    The ping is the point: each refusal must be an error frame the extension can
    correlate, and the read loop must still be turning afterwards. A JSON array
    used to reach `msg.get("cmd")` — which is OUTSIDE main()'s per-message
    try/except — so one such frame raised AttributeError out of the while loop
    and took the host down with every recording it was driving.
    """
    p = _host()
    try:
        # (a) valid JSON, not an object
        _write(p, [1, 2, 3])
        r = _read_reply(p)
        assert r is not None, "host answered a non-object message (it did not die)"
        assert r.get("type") == "error", r
        assert "object" in r.get("error", ""), r

        # (b) an unknown command: refused, never a silent drop
        _write(p, {"cmd": "definitely-not-a-command", "id": 42})
        r = _read_reply(p)
        assert r is not None and r.get("type") == "error", r
        assert r.get("id") == 42, "the refusal is correlatable"
        assert "definitely-not-a-command" in r.get("error", ""), r

        # (c) a field of the wrong type: refused, naming the field
        _write(p, {"cmd": "open", "id": 5, "path": {"evil": 1}})
        r = _read_reply(p)
        assert r is not None and r.get("type") == "error", r
        assert r.get("id") == 5, r
        assert "path" in r.get("error", ""), r

        # the loop is still turning
        _write(p, {"cmd": "ping"})
        r = _read_reply(p)
        assert r is not None and r.get("type") == "pong", \
            "the read loop survived three malformed frames"
    finally:
        try:
            p.stdin.close()
        except Exception:
            pass
        p.wait(timeout=10)


def test_validate_message_refuses_by_shape():
    v = guard.validate_message

    assert v({"cmd": "ping"}) is None
    assert v({"cmd": "pget", "id": "j1", "urls": ["http://x/"],
              "dir": "D:\\Vids", "name": "a.mp4"}) is None

    # non-dict
    for bad in ([], "cmd", 3, None):
        r = v(bad)
        assert r and "object" in r, bad

    # cmd itself
    assert "cmd" in v({})
    assert "cmd" in v({"cmd": 7})
    assert "nope" in v({"cmd": "nope"})

    # type confusion, named
    assert "path" in v({"cmd": "open", "path": ["a"]})
    assert "dir" in v({"cmd": "pget", "dir": {"a": 1}})
    assert "urls" in v({"cmd": "pget", "urls": "http://x/"})
    assert "urls" in v({"cmd": "pget", "urls": ["http://x/", 7]})
    assert "enable" in v({"cmd": "watch", "enable": "yes"})
    assert "maxConnections" in v({"cmd": "pget-set-limit", "maxConnections": "4"})
    assert "seq" in v({"cmd": "file-chunk", "seq": True}), \
        "bool is not an integer here — True would index segment 1"

    # absent / null is how .get() already reads them, so both stay legal
    assert v({"cmd": "pget", "dir": None}) is None
    assert v({"cmd": "snapshot"}) is None

    # required fields exist and are named when missing
    assert "videoUrl" in v({"cmd": "record", "id": "j"})
    assert v({"cmd": "record", "id": "j", "videoUrl": "http://v/"}) is None


def test_validate_message_never_raises():
    """The gate runs before the per-message try/except, so a throw there is a
    host crash, not an error frame."""
    class Hostile(dict):
        def get(self, *a, **k):
            raise RuntimeError("boom")

    for bad in (Hostile(), {"cmd": object()}, {"cmd": "open", "path": object()}):
        assert isinstance(guard.validate_message(bad), (str, type(None)))
