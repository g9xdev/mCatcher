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
import os
import struct
import subprocess
import sys

import pytest

from conftest import HOST, load_host, wait_for

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


# ---------------------------------------------------------------------------
# 2. `open` / `reveal` — what the host will hand to the shell
# ---------------------------------------------------------------------------

def test_open_refuses_an_executable(monkeypatch, tmp_path):
    """C1a. os.startfile is ShellExecuteW: it RUNS the file with its registered
    handler. The only gate used to be os.path.isfile, so any .exe/.bat/.ps1/.lnk
    the extension could name was a sandbox escape."""
    evil = tmp_path / "payload.exe"
    evil.write_bytes(b"MZ")

    ran = []
    if hasattr(mc.os, "startfile"):
        monkeypatch.setattr(mc.os, "startfile", lambda p: ran.append(p))
    monkeypatch.setattr(mc.subprocess, "Popen", lambda *a, **k: ran.append(a))
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)

    mc.handle_open({"id": "n1", "path": str(evil)})
    assert wait_for(lambda: bool(sent), timeout=2.0), "handle_open answered"
    assert ran == [], "the .exe was never handed to the shell"
    assert sent[0].get("type") == "error" and sent[0].get("id") == "n1", sent
    assert "refus" in sent[0].get("error", "").lower(), \
        "the refusal is reported to the user, not silent"


def test_open_allows_a_media_file(monkeypatch, tmp_path):
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"\0")

    ran = []
    if hasattr(mc.os, "startfile"):
        monkeypatch.setattr(mc.os, "startfile", lambda p: ran.append(p))
    monkeypatch.setattr(mc.subprocess, "Popen", lambda *a, **k: ran.append(a))
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)

    mc.handle_open({"id": "n2", "path": str(clip)})
    assert wait_for(lambda: bool(ran), timeout=2.0), "the .mp4 opened"
    assert sent == [], "no error for a legitimate media file"


def test_reveal_refuses_a_non_media_path(monkeypatch, tmp_path):
    evil = tmp_path / "payload.exe"
    evil.write_bytes(b"MZ")

    ran = []
    monkeypatch.setattr(mc.subprocess, "Popen", lambda *a, **k: ran.append(a))
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)

    mc.handle_reveal({"id": "n3", "path": str(evil)})
    assert wait_for(lambda: bool(sent), timeout=2.0), "handle_reveal answered"
    assert ran == [], "explorer was never spawned for the .exe"
    assert sent[0].get("type") == "error" and sent[0].get("id") == "n3", sent


def test_refuse_open_covers_the_windows_shapes(tmp_path):
    r = guard.refuse_open

    assert r(str(tmp_path / "a.mp4")) is None
    assert r(str(tmp_path / "a.MKV")) is None       # case-insensitive
    assert r(str(tmp_path / "a.m4a")) is None
    assert r(str(tmp_path / "a.vtt")) is None

    for bad in ("a.exe", "a.bat", "a.cmd", "a.ps1", "a.lnk", "a.scr", "a.hta",
                "a.msi", "a.js", "a.vbs", "a.reg", "a.url", "a.pif", "a.com",
                "a.dll", "a.cpl", "a.msc", "a.jar", "a.py", "a.wsf", "a.chm",
                "a.settingcontent-ms", "a.appref-ms", "a"):
        assert r(str(tmp_path / bad)) is not None, bad

    # no extension at all, and the empty/awkward inputs
    for bad in (None, "", "   ", 7, {"a": 1}, ["a"]):
        assert r(bad) is not None, bad

    # an NTFS alternate data stream must not smuggle one past the split
    assert r(str(tmp_path / "a.mp4") + ":evil.exe") is not None
    assert r(str(tmp_path / "a.mp4") + ":evil") is not None

    # trailing dot/space: Win32 strips them, so ".mp4 " would resolve to ".mp4"
    # while any suffix check saw something else. Refuse the shape outright.
    assert r(str(tmp_path / "a.exe.")) is not None
    assert r(str(tmp_path / "a.exe ")) is not None


# ---------------------------------------------------------------------------
# 2b. `badapple` — a third shell verb on the same allowlist
#
# This is a new process-execution path, so it is worth being explicit about
# which half of it the extension owns. It owns the FILE and nothing else. The
# program that runs is chosen here, from a fixed list this host writes down;
# there is no field, in this command or in any config the extension can reach,
# that names an executable. That is the whole difference between "open this
# video in a player" and "run this program", and it is the reason the argv
# assertions below check position 0 specifically.
# ---------------------------------------------------------------------------

def test_badapple_is_typed_like_open_and_reveal_plus_a_url():
    assert guard.MESSAGE_SCHEMA["badapple"] == {
        "id": guard.ID, "path": guard.STR, "url": guard.STR,
        "show": guard.BOOL,
        "headers": {"Cookie": guard.STR, "Referer": guard.STR,
                    "User-Agent": guard.STR},
    }, ("badapple takes a correlation id, ONE source — a file path or a URL — "
        "the sign-in that source needs (only alongside a URL), and whether "
        "the window the beam lands in should be brought up")


def _fake_badapple(monkeypatch, tmp_path, installed=True):
    """Stand in for the installed app, so the tests never depend on this
    machine having BadApple. Returns the path find_badapple should report."""
    from mchost import downloads as d

    app = tmp_path / "Programs" / "BadApple" / "BadApple.App.exe"
    if installed:
        app.parent.mkdir(parents=True, exist_ok=True)
        app.write_bytes(b"MZ")
    monkeypatch.setattr(d, "find_badapple",
                        lambda: str(app) if installed else None)
    return str(app)


def test_badapple_refuses_a_non_media_file(monkeypatch, tmp_path):
    """The same guard.refuse_open allowlist `open` and `reveal` use. A media
    player is still a program being handed a caller-supplied path."""
    _fake_badapple(monkeypatch, tmp_path)
    evil = tmp_path / "payload.exe"
    evil.write_bytes(b"MZ")

    ran = []
    monkeypatch.setattr(mc.subprocess, "Popen", lambda *a, **k: ran.append((a, k)))
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)

    mc.handle_badapple({"id": "b1", "path": str(evil)})
    assert wait_for(lambda: bool(sent), timeout=2.0), "handle_badapple answered"
    assert ran == [], "BadApple was never spawned for the .exe"
    assert sent[0].get("type") == "error" and sent[0].get("id") == "b1", sent
    assert "refus" in sent[0].get("error", "").lower()


def test_badapple_vets_the_path_before_it_stats_it(monkeypatch, tmp_path):
    """The ORDER of the two file-arm checks, which is a property on its own.

    guard.refuse_open's docstring commits to it in as many words -- "evaluated
    BEFORE that stat so a refused path is never probed for existence on the
    caller's behalf" -- and handle_badapple's says why it matters: isfile() is
    a stat on a caller-supplied path, and one naming a dead network share
    blocks for as long as the SMB timeout takes, on a worker thread holding
    nothing and answering nobody.

    Swapping the two leaves every other assertion about this handler green,
    because both orders refuse exactly the same paths. What changes is only
    WHEN the filesystem is touched -- so nothing but this test can tell the
    documented boundary from a coincidence.
    """
    from mchost import downloads as d

    _fake_badapple(monkeypatch, tmp_path)
    evil = tmp_path / "payload.exe"
    evil.write_bytes(b"MZ")

    # A spy that still answers truthfully: patching os.path.isfile is process
    # wide for the life of the test, so it delegates rather than replaces.
    statted = []
    real_isfile = d.os.path.isfile
    monkeypatch.setattr(d.os.path, "isfile",
                        lambda pth: (statted.append(pth), real_isfile(pth))[1])

    ran, sent = [], []
    monkeypatch.setattr(mc.subprocess, "Popen", lambda *a, **k: ran.append((a, k)))
    monkeypatch.setattr(mc, "send", sent.append)

    mc.handle_badapple({"id": "b7", "path": str(evil)})
    assert wait_for(lambda: bool(sent), timeout=2.0), "handle_badapple answered"
    assert ran == [], "nothing was spawned"
    assert str(evil) not in statted,         "the allowlist refused it without the filesystem ever being asked"


def test_badapple_that_cannot_start_says_so_rather_than_going_quiet(monkeypatch, tmp_path):
    """A spawn that raises is still an answer owed to whoever clicked.

    Popen fails for ordinary reasons -- the executable replaced mid-upgrade, a
    policy denying execution, an exhausted desktop heap. With the handler for
    that made `pass`, the overlay's click resolves against nothing: no error
    frame, no id, no message, and a person left watching a TV that was never
    going to play. Every other refusal in this handler carries req["id"] for
    exactly that reason, and this one is a refusal too.
    """
    _fake_badapple(monkeypatch, tmp_path)
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"x")

    def denied(*a, **k):
        raise OSError(5, "Access is denied")

    monkeypatch.setattr(mc.subprocess, "Popen", denied)
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)

    mc.handle_badapple({"id": "b8", "path": str(clip)})
    assert wait_for(lambda: bool(sent), timeout=2.0),         "the failure was answered, not swallowed"
    assert sent[0].get("type") == "error", sent
    assert sent[0].get("id") == "b8",         "the id is what lets the extension put this in front of the right row"
    assert "failed to start" in sent[0].get("error", "").lower(), sent


def test_badapple_opens_a_media_file_without_a_shell(monkeypatch, tmp_path):
    app = _fake_badapple(monkeypatch, tmp_path)
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"\0")

    ran = []
    monkeypatch.setattr(mc.subprocess, "Popen", lambda *a, **k: ran.append((a, k)))
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)

    mc.handle_badapple({"id": "b2", "path": str(clip)})
    assert wait_for(lambda: bool(ran), timeout=2.0), "BadApple was spawned"
    assert sent == [], "no error for a legitimate media file"
    argv, kwargs = ran[0]
    # --beam is BadApple's documented entry point: it forwards the path to an
    # already-running instance instead of opening a second window. Launching
    # the exe with a bare path is a different, undocumented interface.
    assert argv[0] == [app, "--beam", str(clip)], argv
    assert kwargs.get("shell") is not True, "argv list, never a shell string"


def test_the_extension_cannot_choose_the_program_that_runs(monkeypatch, tmp_path):
    """C1 reopened would look exactly like this: a field on the message that
    reaches argv[0]. Unlisted keys are ignored rather than refused, so the
    proof that they are inert has to be that none of them lands in the argv."""
    app = _fake_badapple(monkeypatch, tmp_path)
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"\0")
    payload = str(tmp_path / "payload.exe")

    ran = []
    monkeypatch.setattr(mc.subprocess, "Popen", lambda *a, **k: ran.append((a, k)))
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)

    mc.handle_badapple({
        "id": "b3", "path": str(clip),
        # Every shape a caller might hope the handler reads.
        "exe": payload, "app": payload, "player": payload, "command": payload,
        "argv": [payload], "cwd": str(tmp_path), "shell": True,
    })
    assert wait_for(lambda: bool(ran), timeout=2.0), "BadApple was spawned"
    argv, kwargs = ran[0]
    assert argv[0][0] == app, "the host chose the program, not the message"
    assert not any("payload.exe" in str(part) for part in argv[0]), argv
    assert kwargs.get("shell") is not True


def test_badapple_gate_is_media_exts_not_a_second_list(monkeypatch, tmp_path):
    """The decision recorded as behaviour, not only as prose in the docstring.

    BadApple's own filter is narrower than MEDIA_EXTS, and the two are NOT
    intersected: one allowlist governs all three shell verbs, so there is no
    second list to drift. What that costs is a .srt reaching an app that will
    ignore it. What it buys is that .iso — the one suffix BadApple takes and
    this host never writes — does not widen the shell-facing allowlist.
    """
    _fake_badapple(monkeypatch, tmp_path)
    ran, sent = [], []
    monkeypatch.setattr(mc.subprocess, "Popen", lambda *a, **k: ran.append((a, k)))
    monkeypatch.setattr(mc, "send", sent.append)

    iso = tmp_path / "disc.iso"
    iso.write_bytes(b"\0")
    mc.handle_badapple({"id": "b5", "path": str(iso)})
    assert wait_for(lambda: bool(sent), timeout=2.0), "handle_badapple answered"
    assert ran == [], "an .iso is outside MEDIA_EXTS and is refused"
    assert ".iso" not in guard.MEDIA_EXTS

    subs = tmp_path / "clip.srt"
    subs.write_bytes(b"\0")
    mc.handle_badapple({"id": "b6", "path": str(subs)})
    assert wait_for(lambda: bool(ran), timeout=2.0), \
        "a MEDIA_EXTS suffix is passed on even where BadApple has no use for it"
    assert len(sent) == 1, "the .srt drew no refusal of its own"


def test_badapple_not_installed_answers_with_an_error(monkeypatch, tmp_path):
    _fake_badapple(monkeypatch, tmp_path, installed=False)
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"\0")

    ran = []
    monkeypatch.setattr(mc.subprocess, "Popen", lambda *a, **k: ran.append((a, k)))
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)

    mc.handle_badapple({"id": "b4", "path": str(clip)})
    assert wait_for(lambda: bool(sent), timeout=2.0), "handle_badapple answered"
    assert ran == [], "nothing was spawned"
    assert sent[0].get("type") == "error" and sent[0].get("id") == "b4", sent
    assert "badapple" in sent[0].get("error", "").lower(), \
        "the UI can say what is missing"


# ---------------------------------------------------------------------------
# 2c. `badapple` — the URL arm
#
# The overlay beams what a page is PLAYING, and that is an address, not a file
# this host wrote. So `badapple` grew a second, mutually exclusive source.
#
# The two arms are gated by different predicates because they are different
# dangers. A path becomes a ShellExecuteW/argv target on this machine's disk,
# so it goes through refuse_open's MEDIA_EXTS allowlist. A URL never touches
# the disk; what it can do is choose a SCHEME, and yt-dlp's lane already
# learned what that buys (guard.refuse_url's docstring). Reusing that one
# predicate is the point: a second URL list here would be free to drift from
# the one the downloader uses, and drift in the permissive direction is a hole.
# ---------------------------------------------------------------------------

def test_badapple_beams_an_http_url_and_never_stats_it(monkeypatch, tmp_path):
    """A URL is spawned as-is. It is not a path, so the isfile() gate that
    guards the file arm must not run on it — if it did, every URL would answer
    "file not found" instead of reaching BadApple."""
    app = _fake_badapple(monkeypatch, tmp_path)
    ran, sent = [], []
    monkeypatch.setattr(mc.subprocess, "Popen", lambda *a, **k: ran.append((a, k)))
    monkeypatch.setattr(mc, "send", sent.append)

    url = "https://cdn.example/live/master.m3u8?token=SIGNED"
    mc.handle_badapple({"id": "u1", "url": url})
    assert wait_for(lambda: bool(ran), timeout=2.0), "BadApple was spawned for the URL"
    assert sent == [], "a well-formed http(s) URL drew no refusal"
    argv, kwargs = ran[0]
    assert argv[0] == [app, "--beam", url], argv
    assert kwargs.get("shell") is not True, "argv list, never a shell string"


def test_badapple_url_arm_is_guard_refuse_url_and_not_a_second_list(monkeypatch, tmp_path):
    """Pinned by substitution: the handler must ASK guard.refuse_url rather
    than re-deciding what a URL is. Swap the predicate and the answer changes."""
    _fake_badapple(monkeypatch, tmp_path)
    ran, sent, asked = [], [], []
    monkeypatch.setattr(mc.subprocess, "Popen", lambda *a, **k: ran.append((a, k)))
    monkeypatch.setattr(mc, "send", sent.append)
    monkeypatch.setattr(guard, "refuse_url",
                        lambda u: (asked.append(u), "refused: sentinel")[1])

    mc.handle_badapple({"id": "u2", "url": "https://cdn.example/clip.mp4"})
    assert wait_for(lambda: bool(sent), timeout=2.0), "handle_badapple answered"
    assert asked == ["https://cdn.example/clip.mp4"], asked
    assert ran == [], "the substituted refusal stopped the spawn"
    assert sent[0].get("error") == "refused: sentinel", sent


# ---------------------------------------------------------------------------
# The beam arm's SECOND gate: where a beam may point.
#
# refuse_url answers "is this a URL yt-dlp may be handed". It does not answer
# "should this host fetch it", and for the beam arm those differ: the overlay's
# address comes from a PAGE, and the fetch happens outside the browser where no
# origin policy applies. Loopback services, router admin pages and the cloud
# metadata endpoint were all measured accepted before this gate.
#
# Deliberately NOT in refuse_url, which the yt-dlp download lane shares. That
# lane is reached from the popup by a person who picked the address; the beam
# arm is reached by a page. Widening refuse_url would change a lane nobody
# asked to change -- the scoping is pinned by its own test below.
#
# HONEST LIMIT: addresses, not destinations. A NAME resolving into one of these
# ranges is not caught, because resolving it here would be a different check at
# a different time from the one that connects.
# ---------------------------------------------------------------------------

BEAM_INSIDE_THIS_MACHINE = [
    'http://127.0.0.1:8080/admin',
    'http://localhost:8080/x.mp4',
    'http://sub.localhost/x.mp4',
    'http://0.0.0.0/x.mp4',
    'http://10.0.0.5/x.mp4',
    'http://172.16.4.4/x.mp4',
    'http://172.31.255.255/x.mp4',
    'http://192.168.1.1/setup.mp4',
    'http://169.254.169.254/latest/meta-data/',
    'https://169.254.169.254/latest/meta-data/',
    'http://[::1]:8080/x.mp4',
    'http://[fe80::1]/x.mp4',
    'http://[fc00::1]/x.mp4',
]


def test_badapple_url_arm_refuses_an_address_inside_this_machine(monkeypatch, tmp_path):
    _fake_badapple(monkeypatch, tmp_path)
    for i, url in enumerate(BEAM_INSIDE_THIS_MACHINE):
        ran, sent = [], []
        monkeypatch.setattr(mc.subprocess, "Popen", lambda *a, **k: ran.append((a, k)))
        monkeypatch.setattr(mc, "send", sent.append)
        rid = "n%d" % i
        mc.handle_badapple({"id": rid, "url": url})
        assert wait_for(lambda: bool(sent), timeout=2.0), url
        assert ran == [], "nothing was spawned for %s" % url
        assert sent[0].get("type") == "error", (url, sent)
        assert sent[0].get("id") == rid, (url, sent)


def test_badapple_url_arm_still_beams_an_ordinary_public_address(monkeypatch, tmp_path):
    """The positive control. A gate that refused everything would satisfy every
    assertion above while shipping a feature that does nothing."""
    app = _fake_badapple(monkeypatch, tmp_path)
    for i, url in enumerate([
        "https://cdn.example/a.mp4",
        "http://cdn.example:8080/a.mp4",
        "https://172.32.0.1/a.mp4",       # just outside 172.16/12
        "https://11.0.0.1/a.mp4",         # just outside 10/8
        "https://192.169.0.1/a.mp4",      # just outside 192.168/16
        "https://169.253.0.1/a.mp4",      # just outside 169.254/16
    ]):
        ran, sent = [], []
        monkeypatch.setattr(mc.subprocess, "Popen", lambda *a, **k: ran.append((a, k)))
        monkeypatch.setattr(mc, "send", sent.append)
        mc.handle_badapple({"id": "p%d" % i, "url": url})
        assert wait_for(lambda: bool(ran), timeout=2.0), url
        assert sent == [], (url, sent)
        assert ran[0][0][0] == [app, "--beam", url], ran


def test_the_download_lane_is_deliberately_left_alone():
    """The scoping decision, recorded as behaviour.

    The owner chose (2026-08-20) to gate the BEAM arm only. yt-dlp's lane
    already accepts these addresses and is reached from the popup by a person
    who picked one -- a self-hosted server on the LAN is a legitimate download
    target. If someone later widens refuse_url, this test is what tells them
    they changed a second lane, rather than a bug report six months on.
    """
    for url in BEAM_INSIDE_THIS_MACHINE:
        assert guard.refuse_url(url) is None,             "refuse_url still admits %s; the beam gate is a separate one" % url


def test_badapple_refuses_every_url_shape_that_is_not_http(monkeypatch, tmp_path):
    """blob: is the one the overlay meets daily — an MSE-fed <video> has a
    blob: currentSrc, which means nothing outside the page that minted it."""
    _fake_badapple(monkeypatch, tmp_path)
    ran, sent = [], []
    monkeypatch.setattr(mc.subprocess, "Popen", lambda *a, **k: ran.append((a, k)))
    monkeypatch.setattr(mc, "send", sent.append)

    refused = [
        "blob:https://site.example/2f1c-4a",
        "file:///C:/Windows/System32/calc.exe",
        "ftp://host/x.mp4",
        "javascript:alert(1)",
        "data:video/mp4;base64,AAAA",
        "\\\\attacker\\share\\clip.mp4",
        "https://",                       # no host
        " https://cdn.example/a.mp4",     # padded: what is checked is not what ships
        "https://cdn.example/a\tb.mp4",   # control character
        "--exec=calc.exe",                # dash-leading: an option, not an address
    ]
    for i, bad in enumerate(refused):
        sent.clear()
        mc.handle_badapple({"id": "u%d" % i, "url": bad})
        assert wait_for(lambda: bool(sent), timeout=2.0), "answered for %r" % (bad,)
        assert sent[0].get("type") == "error", (bad, sent)
        assert sent[0].get("id") == "u%d" % i, \
            "the refusal carries the request id, or the popup never sees it"
        # Every refuse_url message names the ADDRESS. Requiring that here is
        # what makes this test able to fail before the url arm exists: without
        # it the frame falls into the file arm and answers "no file path
        # given", which is a true sentence about the wrong field.
        assert "address" in sent[0].get("error", "").lower(), (bad, sent)
    assert ran == [], "nothing was spawned for any of them"


def test_badapple_refuses_a_frame_naming_both_a_file_and_a_url(monkeypatch, tmp_path):
    """Mutually exclusive, and refused rather than silently preferring one.
    A frame carrying both is a caller that does not know what it is asking
    for; picking an arm for it would make which gate ran depend on an
    ordering nobody wrote down."""
    _fake_badapple(monkeypatch, tmp_path)
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"\0")
    ran, sent = [], []
    monkeypatch.setattr(mc.subprocess, "Popen", lambda *a, **k: ran.append((a, k)))
    monkeypatch.setattr(mc, "send", sent.append)

    mc.handle_badapple({"id": "u7", "path": str(clip), "url": "https://cdn.example/a.mp4"})
    assert wait_for(lambda: bool(sent), timeout=2.0), "handle_badapple answered"
    assert ran == [], "nothing was spawned"
    assert sent[0].get("type") == "error" and sent[0].get("id") == "u7", sent
    assert "refus" in sent[0].get("error", "").lower(), sent


def test_badapple_refuses_a_frame_naming_neither(monkeypatch, tmp_path):
    _fake_badapple(monkeypatch, tmp_path)
    ran, sent = [], []
    monkeypatch.setattr(mc.subprocess, "Popen", lambda *a, **k: ran.append((a, k)))
    monkeypatch.setattr(mc, "send", sent.append)

    mc.handle_badapple({"id": "u8"})
    assert wait_for(lambda: bool(sent), timeout=2.0), "handle_badapple answered"
    assert ran == [], "nothing was spawned"
    assert sent[0].get("type") == "error" and sent[0].get("id") == "u8", sent
    # Names both arms. The pre-url handler answered "no file path given",
    # which stops being the whole truth once a URL is also a way to ask.
    reason = sent[0].get("error", "").lower()
    assert "file" in reason and "address" in reason, sent


def test_badapple_url_arm_still_cannot_choose_the_program(monkeypatch, tmp_path):
    """The same assertion the file arm carries, repeated for the new arm: a
    second entry point into one Popen is a second chance to reach argv[0]."""
    app = _fake_badapple(monkeypatch, tmp_path)
    payload = str(tmp_path / "payload.exe")
    ran, sent = [], []
    monkeypatch.setattr(mc.subprocess, "Popen", lambda *a, **k: ran.append((a, k)))
    monkeypatch.setattr(mc, "send", sent.append)

    mc.handle_badapple({
        "id": "u10", "url": "https://cdn.example/a.mp4",
        "exe": payload, "app": payload, "player": payload, "command": payload,
        "argv": [payload], "cwd": str(tmp_path), "shell": True,
    })
    assert wait_for(lambda: bool(ran), timeout=2.0), "BadApple was spawned"
    argv, kwargs = ran[0]
    assert argv[0][0] == app, "the host chose the program, not the message"
    assert not any("payload.exe" in str(part) for part in argv[0]), argv
    assert kwargs.get("shell") is not True


def test_badapple_url_arm_answers_when_badapple_is_not_installed(monkeypatch, tmp_path):
    _fake_badapple(monkeypatch, tmp_path, installed=False)
    ran, sent = [], []
    monkeypatch.setattr(mc.subprocess, "Popen", lambda *a, **k: ran.append((a, k)))
    monkeypatch.setattr(mc, "send", sent.append)

    mc.handle_badapple({"id": "u11", "url": "https://cdn.example/a.mp4"})
    assert wait_for(lambda: bool(sent), timeout=2.0), "handle_badapple answered"
    assert ran == [], "nothing was spawned"
    assert sent[0].get("type") == "error" and sent[0].get("id") == "u11", sent
    assert "badapple" in sent[0].get("error", "").lower()


def test_find_badapple_reads_only_host_owned_candidates(monkeypatch, tmp_path):
    """The locator is the security boundary: if a path could come from anywhere
    the extension writes, naming the executable would be back."""
    from mchost import tools

    local = tmp_path / "Local"
    app = local / "Programs" / "BadApple" / "BadApple.App.exe"
    app.parent.mkdir(parents=True)
    app.write_bytes(b"MZ")
    monkeypatch.setenv("LOCALAPPDATA", str(local))
    assert tools.find_badapple() == str(app)

    # An install that is not there is absent, not something else. A config file
    # sitting next to the host does not get to answer the question.
    empty = tmp_path / "Empty"
    empty.mkdir()
    monkeypatch.setenv("LOCALAPPDATA", str(empty))
    cfg = tmp_path / "mc_config.json"
    cfg.write_text(json.dumps({"badapple": str(tmp_path / "payload.exe")}))
    monkeypatch.setattr(tools, "HERE", str(tmp_path))
    assert tools.find_badapple() is None


# ---------------------------------------------------------------------------
# 3. A recording id is not a path component
# ---------------------------------------------------------------------------

def test_recording_id_cannot_escape_tmpdir(monkeypatch):
    """H5. handle_record interpolated the caller's `id` straight into the temp
    path, so `../..` walked out of TMPDIR — an arbitrary .mp4 create/overwrite,
    and handle_discard's os.remove followed it back out."""
    import mchost.downloads as d

    monkeypatch.setattr(d, "run_job", lambda job, req: None)
    monkeypatch.setattr(mc, "FFMPEG", "ffmpeg")

    tmproot = os.path.realpath(mc.TMPDIR)
    hostile = ["../../../../Windows/Temp/pwn",
               "..\\..\\..\\..\\Windows\\Temp\\pwn",
               "mc_..",            # Win32 strips trailing dots -> a literal "mc_"
               "a/b", "C:\\abs", "\\\\unc\\share\\x", "con", ""]
    for jid in hostile:
        try:
            mc.handle_record({"id": jid, "videoUrl": "http://v/x.m3u8"})
            job = d.JOBS.get(jid)
            assert job is not None, jid
            base = os.path.basename(job.temp)
            assert os.path.dirname(job.temp) == mc.TMPDIR, (jid, job.temp)
            assert os.path.dirname(os.path.realpath(job.temp)) == tmproot, \
                (jid, job.temp)
            assert "/" not in base and "\\" not in base and ".." not in base, \
                (jid, base)
        finally:
            with d.JOBS_LOCK:
                d.JOBS.pop(jid, None)


def test_distinct_recording_ids_get_distinct_temp_files():
    """Sanitizing a caller-supplied id collapses characters, so two live
    recordings must not be handed the same temp file by that collapse."""
    a = guard.temp_basename("a/b")
    b = guard.temp_basename("a\\b")
    c = guard.temp_basename("a_b")
    assert len({a, b, c}) == 3, (a, b, c)
    assert guard.temp_basename("x") == guard.temp_basename("x"), "stable"


# ---------------------------------------------------------------------------
# 4. What this host is willing to WRITE
#
# The suffix allowlist that governs `open` governs creation too. The reason is
# the escape it closes: the dangerous primitive an unvalidated destination hands
# an attacker is not "write into an odd folder", it is "drop a file the OS will
# later execute" -- %APPDATA%\...\Start Menu\Programs\Startup\x.exe is logon
# persistence and needs no `open` at all. Constrain the basename and that
# primitive is gone whatever the directory turns out to be.
#
# The name is not merely extension-controlled: background.js derives it from the
# URL and Content-Disposition (`sanitizeFilename(filename || item.name)`, then
# `guessExt` only when there is no suffix already), so a hostile PAGE reaches
# this without the extension being compromised at all.
# ---------------------------------------------------------------------------

import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

_BODY = b"MZ" + b"\0" * 62


class _Ranged(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def do_HEAD(self):
        self.send_response(200)
        self.send_header("Content-Length", str(len(_BODY)))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()

    def do_GET(self):
        rng = self.headers.get("Range")
        if rng:
            lo, hi = rng.split("=")[1].split("-")
            lo = int(lo)
            hi = int(hi) if hi else len(_BODY) - 1
            chunk = _BODY[lo:hi + 1]
            self.send_response(206)
            self.send_header("Content-Range", "bytes %d-%d/%d" % (lo, hi, len(_BODY)))
            self.send_header("Content-Length", str(len(chunk)))
            self.end_headers()
            self.wfile.write(chunk)
            return
        self.send_response(200)
        self.send_header("Content-Length", str(len(_BODY)))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        self.wfile.write(_BODY)


@pytest.fixture(scope="module")
def served():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Ranged)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        yield "http://127.0.0.1:%d/x" % httpd.server_address[1]
    finally:
        httpd.shutdown()


def _pget(monkeypatch, jid, url, name, out_dir):
    sent = []
    monkeypatch.setattr(mc, "send", lambda m: sent.append(dict(m)))
    mc.handle_pget({"id": jid, "urls": [url], "name": name, "dir": str(out_dir),
                    "maxConnections": 1})
    assert wait_for(lambda: any(m.get("type") == "pget-result" for m in sent),
                    timeout=15), sent
    return [m for m in sent if m.get("type") == "pget-result"][-1]


@pytest.mark.parametrize("name", [
    "payload.exe", "payload.bat", "payload.ps1", "payload.lnk", "payload.dll",
    "payload.scr", "payload.hta", "payload.js", "payload.settingcontent-ms",
])
def test_pget_refuses_a_name_outside_the_media_allowlist(monkeypatch, tmp_path,
                                                         served, name):
    res = _pget(monkeypatch, "j-" + name, served, name, tmp_path)
    assert res["status"] == "failed", res
    assert res["failureCategory"] == "permanent", res
    assert list(tmp_path.iterdir()) == [], "nothing written, not even a .part"


@pytest.mark.parametrize("name", ["con", "con.mp4", "NUL.mp4", "lpt1.mp4",
                                  "com9.mp4", "aux.mp4", "prn"])
def test_pget_refuses_a_reserved_device_name(monkeypatch, tmp_path, served, name):
    """con/prn/aux/nul/com1-9/lpt1-9 are DEVICES on Windows, with or without a
    suffix -- "con.mp4" passes any suffix check and still opens the console."""
    res = _pget(monkeypatch, "jdev-" + name, served, name, tmp_path)
    assert res["status"] == "failed", res
    assert list(tmp_path.iterdir()) == [], name


def test_pget_does_not_create_a_missing_directory_tree(monkeypatch, tmp_path,
                                                       served):
    """os.makedirs(out_dir, exist_ok=True) was the first thing either pget
    handler touched, so a destination that did not exist was built on demand --
    anywhere the user can write."""
    missing = tmp_path / "not" / "an" / "approved" / "root"
    res = _pget(monkeypatch, "jtree", served, "clip.mp4", missing)
    assert res["status"] == "failed", res
    assert not (tmp_path / "not").exists(), "no part of the tree was created"


def test_the_live_executable_drop_is_refused(monkeypatch, tmp_path, served):
    """The exact repro that worked before this change: drop payload.exe into a
    directory tree that does not exist, then open it."""
    missing = tmp_path / "not" / "an" / "approved" / "root"
    res = _pget(monkeypatch, "jchain", served, "payload.exe", missing)
    assert res["status"] == "failed", res
    assert not (tmp_path / "not").exists()

    sent = []
    monkeypatch.setattr(mc, "send", lambda m: sent.append(dict(m)))
    ran = []
    if hasattr(mc.os, "startfile"):
        monkeypatch.setattr(mc.os, "startfile", lambda p: ran.append(p))
    mc.handle_open({"id": "chain", "path": str(missing / "payload.exe")})
    assert wait_for(lambda: bool(sent), timeout=2.0)
    assert ran == [] and sent[0]["type"] == "error", sent


def test_pget_still_writes_a_media_file(monkeypatch, tmp_path, served):
    """The rule must not cost the flow it exists to protect."""
    res = _pget(monkeypatch, "jok", served, "clip.mp4", tmp_path)
    assert res["status"] == "completed", res
    assert (tmp_path / "clip.mp4").is_file()


def test_file_open_refuses_a_non_media_basename(monkeypatch, tmp_path):
    """The native file sink writes requestedFilename verbatim -- _is_safe_basename
    vets its SHAPE but never its suffix, so payload.exe passed."""
    sent = []
    monkeypatch.setattr(mc, "send", lambda m: sent.append(dict(m)))
    mc.handle_file_open({"jobId": "jx", "attemptToken": "a1",
                         "requestedFilename": "payload.exe", "dir": str(tmp_path)})
    assert not any(m.get("type") == "file-opened" for m in sent), sent
    assert list(tmp_path.iterdir()) == [], "no .part was created"


def test_refuse_basename_covers_the_shapes():
    r = guard.refuse_basename

    for ok in ("clip.mp4", "a.MKV", "song.m4a", "subs.vtt", "poster.jpg",
               "11238-makemebi.net.mp4", "con-artist.mp4", "nul-and-void.mp4"):
        assert r(ok) is None, ok

    for bad in ("payload.exe", "payload.bat", "payload.ps1", "payload.lnk",
                "payload.dll", "payload.hta", "payload.settingcontent-ms",
                "noext", "con", "CON.mp4", "nul", "com1.mp4", "LPT9.mp4",
                "aux.tar.mp4", "a/b.mp4", "a\\b.mp4", ".", "..", "C:\\x.mp4",
                "trailing.mp4 ", "trailing.mp4.", "null\x00.mp4", "", "   ",
                None, 7, ["a.mp4"]):
        assert r(bad) is not None, bad


def test_resolve_existing_dir():
    import tempfile

    real, err = guard.resolve_existing_dir(tempfile.gettempdir())
    assert err is None and os.path.isdir(real)

    # absent / null / blank fall back to the default, as .get() already did
    for blank in (None, "", "   "):
        real, err = guard.resolve_existing_dir(blank)
        assert err is None and os.path.isdir(real), blank

    for bad in ("relative-not-abs",
                os.path.join(tempfile.gettempdir(), "no-such-dir-xyz"),
                7, {"a": 1}):
        real, err = guard.resolve_existing_dir(bad)
        assert real is None and err, bad


def test_sanitize_neutralises_a_reserved_device_stem():
    """handle_save builds sanitize(base) + ".mp4", so a base of "con" produced
    con.mp4 -- a device, not a file. The suffix is host-chosen here and the user
    must not lose the recording, so this one coerces rather than refuses."""
    assert guard.refuse_basename(mc.sanitize("con") + ".mp4") is None
    assert guard.refuse_basename(mc.sanitize("LPT1") + ".mp4") is None
    assert mc.sanitize("congress") == "congress", "only the exact device names"


# ---------------------------------------------------------------------------
# 5. Review closure
#
# Each of these pins a claim the prose makes, because prose is where this repo
# keeps drifting from the code. The suffixless-name rule in particular is
# asserted in BOTH directions here so the comment describing it cannot outlive
# it.
# ---------------------------------------------------------------------------

def test_a_suffixless_name_is_refused_in_both_directions(tmp_path):
    """The rule that ships: every name this host writes carries a suffix from
    MEDIA_EXTS, and so does every path it will open. No asymmetry -- an earlier
    comment claimed a suffixless name could be written but not opened, and the
    code never did that."""
    assert guard.refuse_basename("myvideo") is not None
    assert guard.refuse_open(str(tmp_path / "myvideo")) is not None
    assert guard.refuse_basename("myvideo.mp4") is None
    assert guard.refuse_open(str(tmp_path / "myvideo.mp4")) is None
    # ...which is why the fallback name carries one.
    import mchost.downloads as d
    assert guard.refuse_basename(d._PGET_DEFAULT_NAME) is None


def test_convert_subfields_are_typed():
    """`convert` was typed as a dict and nothing inside it, so
    {"codec":"h265","quality":{}} passed the gate, reached _finalize_move, and
    raised TypeError on an un-try'd worker AFTER shutil.move had run: the file
    landed, the `saved` frame never did, and the row hung. That is the exact
    failure class the gate exists to stop."""
    v = guard.validate_message

    assert v({"cmd": "save", "id": 1,
              "convert": {"codec": "h265", "quality": "balanced",
                          "encoder": "auto"}}) is None
    assert v({"cmd": "save", "id": 1, "convert": None}) is None
    assert v({"cmd": "save", "id": 1, "convert": {}}) is None

    for bad, field in (({"codec": "h265", "quality": {}}, "quality"),
                       ({"codec": ["h265"]}, "codec"),
                       ({"encoder": 7}, "encoder"),
                       ({"quality": ["a"]}, "quality")):
        r = v({"cmd": "save", "id": 1, "convert": bad})
        assert r and field in r, (bad, r)
    # every command that carries `convert` gets the same treatment
    for cmd in ("save", "saveAs", "pget", "pget-single"):
        r = v({"cmd": cmd, "id": 1, "convert": {"quality": {}}})
        assert r and "quality" in r, cmd


def test_no_schema_field_types_a_container_without_its_contents():
    """The standing form of the bug above: a field typed as a container whose
    values nobody typed is a hole the gate cannot see into. Nested specs and
    "strlist" both type their contents; a bare container kind does not."""
    untyped = {"dict", "list"}
    offenders = []
    for cmd, fields in guard.MESSAGE_SCHEMA.items():
        for name, spec in fields.items():
            if isinstance(spec, dict):
                continue            # nested spec: its contents are typed below
            if spec in untyped:
                offenders.append("%s.%s" % (cmd, name))
    assert offenders == [], offenders

    # and a nested spec may only contain leaf kinds, not another bare container
    for cmd, fields in guard.MESSAGE_SCHEMA.items():
        for name, spec in fields.items():
            if not isinstance(spec, dict):
                continue
            for sub, subspec in spec.items():
                assert subspec not in untyped, "%s.%s.%s" % (cmd, name, sub)


@pytest.mark.parametrize("name", [
    "com0.mp4", "lpt0.mp4", "COM¹.mp4", "LPT².mp4", "com³.mp4",
    "CONIN$.mp4", "conout$.mp4",
])
def test_device_names_cover_zero_and_superscript_digits(name):
    """Win32's device parser reads U+00B9/B2/B3 as the digits 1/2/3, so COM<sup>1</sup>
    is COM1. COM0/LPT0 are refused for the same two lines rather than left to
    argument."""
    assert guard.refuse_basename(name) is not None, name


def test_media_exts_cover_every_ytdlp_remux_target():
    """yt-dlp --remux-video / --audio-format targets, read off the bundled
    binary's own --help, plus the audio-only merge mapping it applies
    (mkv->mka, webm->weba, mp4->m4a, ogg->oga). A file it can produce and the
    popup cannot open is a usability bug, and .mka/.weba were exactly that."""
    targets = ["avi", "flv", "gif", "mkv", "mov", "mp4", "webm",
               "aac", "aiff", "alac", "flac", "m4a", "mka", "mp3", "ogg",
               "opus", "wav",
               # audio-only merge outputs
               "mka", "weba", "m4a", "oga"]
    missing = [t for t in targets if ("." + t) not in guard.MEDIA_EXTS]
    assert missing == [], missing
    # vorbis is a codec yt-dlp writes into .ogg, not a suffix of its own
    assert ".vorbis" not in guard.MEDIA_EXTS


def test_no_untyped_container_kind_can_be_declared():
    """Item 1 again, in the fix for item 1: the comment said there was no bare
    "dict" kind while _KINDS still defined one, so a spec of "dict" typed an
    object's outer shape and nothing inside it. Only the DICT alias had gone.

    Made true by construction rather than by comment — the kind is not in
    _KINDS, so declaring one is not a weaker check, it is not a check at all
    and the table refuses to import. The schema scan stays as the backstop.
    """
    assert "dict" not in guard._KINDS and "list" not in guard._KINDS

    # A leftover spec cannot quietly pass: it has no checker to consult.
    with pytest.raises(KeyError):
        guard._check_fields({"convert": {"quality": {}}},
                            {"convert": "dict"}, "save")

    # ...and the table is checked at import, so it cannot ship in the first place.
    guard._assert_kinds_declared(guard.MESSAGE_SCHEMA)
    with pytest.raises(ValueError):
        guard._assert_kinds_declared({"save": {"convert": "dict"}})
    with pytest.raises(ValueError):
        guard._assert_kinds_declared({"save": {"convert": {"quality": "dict"}}})


def test_refuse_url_covers_the_scheme_shapes():
    r = guard.refuse_url
    for ok in ("http://a.test/x", "https://a.test/x", "HTTPS://A.TEST/x",
               "https://a.test:8443/v?q=1#f", "https://user:pw@a.test/x"):
        assert r(ok) is None, ok
    for bad in ("file:///C:/Windows/win.ini", "ftp://a.test/x",
                "javascript:alert(1)", "data:text/plain,x", "ws://a.test/x",
                r"C:\Windows\win.ini", r"\\a.test\share\x", "//a.test/x",
                "http://", "http:/a", "not a url", "", "   ", None, 5, b"x",
                " https://a.test/x", "https://a.test/x ",
                "ht\ttp://a.test/x", "https://a.test/\x00x",
                "https://a.test/x\n--exec"):
        assert r(bad) is not None, repr(bad)


def test_cast_url_is_not_a_yt_dlp_url():
    """The two "url" fields mean different things, and the schema is per-cmd.

    cast's "url" is a media SOURCE: mchost/cast/legacy.py serves anything that
    is not ^https?:// as a file on disk, which is how casting a finished
    recording works. A kind on ytdl's url would not have reached this one --
    MESSAGE_SCHEMA is keyed by command, so the two entries are independent, and
    the comment above refuse_url no longer claims otherwise. What actually
    keeps refuse_url out of the schema is the shape of the refusal; see
    test_a_schema_refusal_cannot_carry_an_attempt_token.
    """
    from mchost.cast import legacy

    assert guard.MESSAGE_SCHEMA["cast"]["url"] == guard.STR
    # Per-command, so the fields are not one declaration shared by name.
    assert guard.MESSAGE_SCHEMA["cast"] is not guard.MESSAGE_SCHEMA["ytdl"]
    assert guard.validate_message(
        {"cmd": "cast", "sub": "start", "id": "d1",
         "url": r"C:\Users\me\Videos\clip.mp4"}) is None
    entry = legacy._dlna_media_url(r"C:\Users\me\Videos\clip.mp4", None)
    assert isinstance(entry, tuple)


def test_refuse_url_covers_argv_injection_not_only_scheme():
    """The url is the LAST argv entry, which is where an option is read from.

    yt-dlp parses with optparse, and optparse reads a dash-leading trailing
    argument as an option, not as a positional. Being the only
    caller-controlled token in argv is therefore not protection. This asserts
    the parser behaviour that makes it matter, so the reason written above
    refuse_url cannot quietly stop being true.
    """
    import optparse

    p = optparse.OptionParser()
    p.add_option("-f", dest="fmt")
    p.add_option("-o", dest="out")
    opts, args = p.parse_args(["-f", "b", "-o", "t", "-o://evil"])
    assert opts.out == "://evil", opts.out
    assert args == [], args        # consumed as an option; no positional at all

    # ...which is why every dash-leading shape is refused before argv.
    for bad in ("--exec=calc.exe", "-o://evil", "--paths=C:/x",
                "--enable-file-urls", "-", "--"):
        assert guard.refuse_url(bad) is not None, bad


def test_a_schema_refusal_cannot_carry_an_attempt_token():
    """The true reason refuse_url is a handler call, not a schema kind.

    A schema refusal IS correlated -- mc_host echoes guard.message_id on it --
    but message_id only ever returns an id, never the attemptToken, and the
    frame is a {"type":"error"}, not the ytdl-error a structured row waits for.
    """
    msg = {"cmd": "ytdl", "id": "j1", "attemptToken": "atk-1", "url": 5}
    assert guard.validate_message(msg) is not None
    assert guard.message_id(msg) == "j1"
    assert guard.message_id({"cmd": "ytdl", "attemptToken": "atk-1"}) is None


# ---------------------------------------------------------------------------
# 6. The record lane's URLs are attacker text too
#
# Every other URL this host takes arrived from webRequest or a gated content
# script. record's did not: it is a URI lifted from the BODY of a fetched HLS
# manifest. The live route is background.js "record-live" -> resolveVideoUrl,
# which fetches the master playlist and returns pickVariant(...).uri, and
# media-catcher/lib/hls.js resolveUrl returns an absolute URI unchanged, so
# the playlist decides the string. ffmpeg opens "file://attacker.test/s/x" as
# the UNC path \\attacker.test\s\x -- an outbound SMB connection carrying the
# user's NTLM credentials -- which is the threat 2c3e0aa gated mirrors
# against. audioUrl is gated for the same reason rather than because a shipped
# producer reaches it: findSiblingAudio only returns a same-stream-directory
# or token-swapped sibling of a URL that already passed, so it is pinned by
# construction rather than by test. The point is that the lane has a boundary.
#
# The headers are the same lane's second half: ffmpeg_cmd interpolates referer
# and userAgent into one -headers value separated by a literal \r\n, so a
# control character in either appends headers of the page's choosing to every
# request ffmpeg makes for that stream.
# ---------------------------------------------------------------------------

def _record_argv(monkeypatch, req):
    """handle_record end to end: (ffmpeg argv or None if none was built, frames).

    Popen raises so nothing is launched, which also settles job.finished on the
    worker — the argv is captured at the real spawn point, not from ffmpeg_cmd.
    """
    import mchost.downloads as d

    calls, sent = [], []
    monkeypatch.setattr(mc, "FFMPEG", "ffmpeg")
    monkeypatch.setattr(mc, "send", lambda m: sent.append(dict(m)))
    monkeypatch.setattr(mc, "_hlog", lambda *a, **k: None)

    def fake_popen(cmd, **kw):
        calls.append(list(cmd))
        raise OSError("test: ffmpeg is not really launched")

    monkeypatch.setattr(d.subprocess, "Popen", fake_popen)
    try:
        mc.handle_record(req)
        job = d.JOBS.get(req.get("id"))
        if job is not None:
            assert job.finished.wait(5), "run_job never finished"
    finally:
        with d.JOBS_LOCK:
            d.JOBS.pop(req.get("id"), None)
    return (calls[0] if calls else None), sent


def _record_error(sent, jid):
    errs = [m for m in sent if m.get("type") == "error" and m.get("id") == jid]
    assert errs, sent
    return errs[-1]


def test_record_refuses_a_non_http_audio_url(monkeypatch):
    """The reviewer's scenario: the audio URI of a master playlist is a UNC."""
    jid = "recUncAudio"
    argv, sent = _record_argv(monkeypatch, {
        "id": jid, "base": "clip",
        "videoUrl": "https://cdn.test/v.m3u8",
        "audioUrl": "file://attacker.test/s/x",
    })
    assert argv is None, argv
    _record_error(sent, jid)


def test_record_refuses_a_non_http_video_url(monkeypatch):
    """The local-read half of the same shape, and the required field."""
    for bad in ("file:///C:/Users/me/.ssh/id_rsa", "ftp://attacker.test/x",
                "//attacker.test/s/x", " https://cdn.test/v.m3u8",
                "https://cdn.test/v\r\n.m3u8", ""):
        jid = "recBadVideo"
        argv, sent = _record_argv(monkeypatch, {
            "id": jid, "base": "clip", "videoUrl": bad,
        })
        assert argv is None, (bad, argv)
        _record_error(sent, jid)


def test_record_refuses_control_characters_in_referer_and_user_agent(monkeypatch):
    """ffmpeg's -headers value is CRLF-separated, so a CRLF here adds headers."""
    for field in ("referer", "userAgent"):
        jid = "recHdr_" + field
        argv, sent = _record_argv(monkeypatch, {
            "id": jid, "base": "clip",
            "videoUrl": "https://cdn.test/v.m3u8",
            field: "http://page/\r\nX-Injected: 1",
        })
        assert argv is None, (field, argv)
        _record_error(sent, jid)


def test_record_still_records_an_ordinary_stream(monkeypatch):
    """The gate is a gate, not a wall: the shipped shape still reaches ffmpeg."""
    jid = "recOk"
    argv, sent = _record_argv(monkeypatch, {
        "id": jid, "base": "clip",
        "videoUrl": "https://cdn.test/v.m3u8",
        "audioUrl": "https://cdn.test/a.m3u8",
        "referer": "https://page.test/watch", "userAgent": "UA/1.0",
    })
    assert argv is not None
    assert argv.count("-i") == 2, argv
    assert "https://cdn.test/a.m3u8" in argv, argv


def test_record_keeps_a_referer_that_merely_spells_a_header_inside_its_own(
        monkeypatch):
    """Legal but adjacent: an injection's text without the CRLF that makes one.

    ffmpeg_cmd joins Referer and User-Agent into ONE -headers value with a
    literal CRLF between them, so the property worth pinning is that this
    referer rides INSIDE the Referer line instead of becoming a third header,
    and that the gate refuses on the control character rather than on the text.
    The refusal half is test_record_refuses_control_characters_in_referer_and_
    user_agent, which asserts argv is None; this is the other half.
    """
    jid = "recAdjacentHeaderText"
    argv, sent = _record_argv(monkeypatch, {
        "id": jid, "base": "clip",
        "videoUrl": "https://cdn.test/v.m3u8",
        "referer": "https://page.test/watch?q=X-Injected:%201",
        "userAgent": "UA/1.0",
    })
    assert argv is not None, sent
    headers = argv[argv.index("-headers") + 1]
    lines = [ln for ln in headers.split("\r\n") if ln]
    assert lines == ["Referer: https://page.test/watch?q=X-Injected:%201",
                     "User-Agent: UA/1.0"], lines
    assert all(not ln.startswith("X-Injected") for ln in lines), lines


# ---------------------------------------------------------------------------
# 2c. `delete` and `thumb` — the two verbs that take a path and then act on the
#     FILE, rather than handing it to another program
#
# `open`, `reveal` and `badapple` all end in "hand this path to something
# else", and guard.refuse_open is the whole gate because the danger is what the
# shell does with a suffix. These two are different: delete removes the file
# permanently, and thumb reads its bytes. Both need a second answer refuse_open
# cannot give.
#
# refuse_open answers a question about SHAPE — is this the KIND of file this
# helper deals in. A .mp4 the user shot on a phone and copied into Downloads
# has exactly the same shape as one this host produced, so shape alone would
# let the extension delete it. mchost/written.py answers the other question,
# "did THIS HOST write it", and both verbs require BOTH answers.
#
# The refusal tests below come in pairs on purpose: one satisfies the ledger
# and is refused on shape, one satisfies the shape and is refused on the
# ledger. Either check deleted on its own leaves one of the pair red.
#
# There is deliberately NO `url` field on thumb. Host-side fetching of a remote
# stream URL would make this helper an HTTP client pointed wherever the
# extension says, reaching whatever this machine can route to; the frame takes
# a local path this host wrote, and nothing else.
# ---------------------------------------------------------------------------


# A real clip, decoded by the real ffmpeg. These tests are about a frame THIS
# HOST produced, so a stubbed decoder would pin the stub.
@pytest.fixture(scope="module")
def _clip_master(tmp_path_factory):
    from mchost import tools

    if not tools.FFMPEG:
        pytest.skip("no ffmpeg on this machine to decode a frame with")
    out = str(tmp_path_factory.mktemp("clipsrc") / "master.mp4")
    subprocess.run([tools.FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
                    "-f", "lavfi",
                    "-i", "testsrc=size=640x360:rate=15:duration=3",
                    "-pix_fmt", "yuv420p", out], check=True, timeout=180)
    return out


@pytest.fixture
def host_clip(_clip_master, tmp_path):
    """A per-test copy: one of these tests appends to the file on purpose."""
    import shutil

    dest = os.path.join(str(tmp_path), "clip.mp4")
    shutil.copyfile(_clip_master, dest)
    return dest


def _ledger(monkeypatch, tmp_path):
    """Point the written-files ledger at this test's own file."""
    from mchost import written

    monkeypatch.setattr(written, "_PATH_OVERRIDE",
                        str(tmp_path / "written-files.jsonl"))
    written.forget_cache()
    return written


def _media(where, name="clip.mp4", body=b"video-bytes"):
    p = os.path.join(str(where), name)
    with open(p, "wb") as fh:
        fh.write(body)
    return p


def _replies(sent, kind):
    """Only the frames of this kind. The host interleaves {"type":"log"} ones
    -- thumb writes ffmpeg's own text there when a seek finds no frame -- so a
    wait on "anything arrived" can wake on the log and read the reply before
    it exists."""
    return [m for m in sent if m.get("type") == kind]


def _answer(sent, kind, timeout=90.0, n=1):
    wait_for(lambda: len(_replies(sent, kind)) >= n, timeout=timeout)
    got = _replies(sent, kind)
    assert len(got) >= n, "fewer than %d %s frames in %s" % (n, kind, sent)
    return got[n - 1]


# --- the schema, by equality (the discipline `badapple` is already pinned with)

def test_delete_is_typed_as_a_request_id_and_one_path():
    assert guard.MESSAGE_SCHEMA["delete"] == {
        "reqId": guard.ID, "path": guard.STR,
    }, ("delete takes a correlation id and the one file to remove — no "
        "directory, no glob, no recursion flag")


def test_badapple_stop_is_typed_as_a_request_id_and_nothing_else():
    assert guard.MESSAGE_SCHEMA["badapple-stop"] == {
        "reqId": guard.ID,
    }, ("--stop is a bare flag: there is nothing for the caller to name, and "
        "the program that runs is find_badapple's answer, not a field")


def test_thumb_is_typed_as_a_local_path_and_an_offset_with_no_url():
    assert guard.MESSAGE_SCHEMA["thumb"] == {
        "reqId": guard.ID, "path": guard.STR, "atSeconds": guard.NUM,
    }, "thumb reads ONE local file at ONE offset"
    assert "url" not in guard.MESSAGE_SCHEMA["thumb"], (
        "a url field here would have the host fetch an address the extension "
        "chose, reaching whatever this machine can route to. The frame carries "
        "a path this host itself wrote and nothing else.")


def test_thumb_never_reads_a_url_field_even_when_one_is_sent():
    """Unlisted keys are ignored by the schema by design, so the handler is
    where a smuggled `url` has to die. Read off the SOURCE: there is no code
    in handle_thumb that could give one any effect."""
    import io as _io

    src = _io.open(os.path.join(os.path.dirname(HOST), "mchost", "fileops.py"),
                   encoding="utf-8").read()
    start = src.index("def handle_thumb")
    end = src.find("\ndef ", start + 1)
    body = src[start:end if end > 0 else len(src)]
    assert 'get("url")' not in body and "get('url')" not in body, (
        "handle_thumb reads a url field; there is no such field and there is "
        "not meant to be one")


# --- delete: the two halves of the AND, each killed on its own ---

def test_delete_refuses_a_media_file_this_host_never_wrote(monkeypatch, tmp_path):
    """The ledger half. Shape alone admits this file — it IS a .mp4 — so what
    refuses it is that nothing here produced it."""
    _ledger(monkeypatch, tmp_path)
    theirs = _media(tmp_path, "holiday.mp4")
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)

    mc.handle_delete({"reqId": "d1", "path": theirs})
    r = _answer(sent, "delete-result", timeout=5.0)
    assert r["reqId"] == "d1" and r["ok"] is False, r
    assert os.path.isfile(theirs), "the file is still there"
    # A reason a person can act on: it names the file and says what is missing,
    # rather than "refused".
    assert "holiday.mp4" in r["error"], r
    assert "download" in r["error"].lower(), r


def test_delete_refuses_an_executable_even_when_it_is_in_the_ledger(
        monkeypatch, tmp_path):
    """The shape half, with the ledger half deliberately satisfied.

    A ledger record is not permission to remove anything. Recording the .exe
    first is what makes this test kill the refuse_open call specifically."""
    written = _ledger(monkeypatch, tmp_path)
    evil = _media(tmp_path, "payload.exe", b"MZ")
    assert written.record(evil) is True
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)

    mc.handle_delete({"reqId": "d2", "path": evil})

    r = _answer(sent, "delete-result")
    assert r["ok"] is False, r
    assert os.path.isfile(evil), "the executable is still there"
    assert "payload.exe" in r["error"], r


def test_delete_refuses_a_traversal_out_of_a_folder_it_did_write_in(
        monkeypatch, tmp_path):
    """`..` is not refused by spelling — it is resolved, and the file it
    RESOLVES ONTO is the one asked about. A path that walks out of the folder
    this host saved into, onto something it never wrote, is refused because of
    where it lands, which is the check that survives a change of spelling."""
    written = _ledger(monkeypatch, tmp_path)
    sub = os.path.join(str(tmp_path), "saved")
    os.mkdir(sub)
    written.record(_media(sub, "clip.mp4"))
    theirs = _media(tmp_path, "elsewhere.mp4")

    sent = []
    monkeypatch.setattr(mc, "send", sent.append)
    mc.handle_delete({"reqId": "d3",
                      "path": os.path.join(sub, "..", "elsewhere.mp4")})

    r = _answer(sent, "delete-result")
    assert r["ok"] is False, r
    assert os.path.isfile(theirs), "the file the traversal pointed at survives"


def test_delete_resolves_a_detour_back_onto_the_file_it_did_write(
        monkeypatch, tmp_path):
    from mchost import fileops

    """The same resolution, in the direction that has to keep WORKING.

    The popup's copy of a path travels out through the extension and back, so
    the spelling that arrives is not guaranteed to be the one recorded.
    saved/../saved/clip.mp4 is the same file as saved/clip.mp4, and one ledger
    answer covers both."""
    written = _ledger(monkeypatch, tmp_path)
    sub = os.path.join(str(tmp_path), "saved")
    os.mkdir(sub)
    mine = _media(sub, "clip.mp4")
    written.record(mine)

    sent = []
    monkeypatch.setattr(mc, "send", sent.append)
    monkeypatch.setattr(fileops, "find_badapple", lambda: None)
    mc.handle_delete({"reqId": "d4",
                      "path": os.path.join(sub, "..", "saved", "clip.mp4")})

    r = _answer(sent, "delete-result")
    assert r["ok"] is True, r
    assert not os.path.exists(mine), "the recorded file was removed"


def test_delete_refuses_a_non_media_suffix_it_never_recorded(monkeypatch, tmp_path):
    """Both halves failing at once, across suffixes the allowlist exists for."""
    _ledger(monkeypatch, tmp_path)
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)

    for i, name in enumerate(("notes.txt", "run.bat", "task.lnk", "key.pem",
                              "noext")):
        target = _media(tmp_path, name, b"x")
        mc.handle_delete({"reqId": "dn%d" % i, "path": target})
        r = _answer(sent, "delete-result", timeout=5.0, n=i + 1)
        assert r["ok"] is False, (name, r)
        assert os.path.isfile(target), name


def test_delete_removes_a_recorded_file_permanently(monkeypatch, tmp_path):
    from mchost import fileops

    """The verb doing its job, the way the owner chose it: os.remove, not a
    Recycle Bin move. The confirm step lives in the popup."""
    written = _ledger(monkeypatch, tmp_path)
    mine = _media(tmp_path)
    written.record(mine)

    sent = []
    monkeypatch.setattr(mc, "send", sent.append)
    monkeypatch.setattr(fileops, "find_badapple", lambda: None)

    mc.handle_delete({"reqId": "d5", "path": mine})

    assert _answer(sent, "delete-result") == {
        "type": "delete-result", "reqId": "d5", "ok": True, "error": None}, sent
    assert not os.path.exists(mine)
    # Permanent: nothing moved it aside, so the folder holds only the ledger.
    assert sorted(os.listdir(str(tmp_path))) == ["written-files.jsonl"], \
        os.listdir(str(tmp_path))


def test_delete_releases_the_local_holders_before_it_removes(monkeypatch, tmp_path):
    """Two things IN THIS PROCESS's reach can be holding the file open, and
    both are let go BEFORE os.remove — an order that matters, because a
    release after the remove releases nothing.

      (a) BadApple, which may be playing it, through the same --stop the
          popup's stop button uses, so there is one way to stop it.
      (b) this host's OWN local media server (mchost/cast/legacy.py), which
          serves a cast file over plain HTTP and opens it per request.
          Stopping BadApple does not touch that one.

    (a) is CONDITIONAL — see the three tests below it. This one is about the
    ORDER, so both conditions are forced true and the order is what is read.
    """
    from mchost import badapple_ipc, fileops
    from mchost.cast import legacy

    written = _ledger(monkeypatch, tmp_path)
    mine = _media(tmp_path)
    written.record(mine)
    app = _fake_badapple(monkeypatch, tmp_path)
    monkeypatch.setattr(fileops, "find_badapple", lambda: app)
    monkeypatch.setattr(fileops, "_file_is_held", lambda p: True)
    monkeypatch.setattr(badapple_ipc, "is_running", lambda: True)
    # A probe stubbed to "held forever" means the wait after the stop runs its
    # whole bound. This test is about the ORDER, not the bound, so the clock is
    # the fake one and the seconds are not spent.
    monkeypatch.setattr(fileops, "time", _FakeClock())

    order = []
    monkeypatch.setattr(fileops.subprocess, "Popen",
                        lambda argv, **k: order.append(("spawn", tuple(argv))))
    monkeypatch.setattr(legacy, "release_local_path",
                        lambda p: (order.append(("release", p)), 0)[1])
    real_remove = os.remove
    monkeypatch.setattr(fileops.os, "remove",
                        lambda p: (order.append(("remove", p)), real_remove(p))[1])
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)

    mc.handle_delete({"reqId": "d6", "path": mine})
    assert _answer(sent, "delete-result")["ok"] is True, sent

    kinds = [k for k, _ in order]
    assert "spawn" in kinds and "release" in kinds and "remove" in kinds, order
    assert kinds.index("spawn") < kinds.index("remove"), order
    assert kinds.index("release") < kinds.index("remove"), order
    assert order[kinds.index("spawn")][1] == (app, "--stop"), order


def test_delete_reports_a_sharing_violation_and_does_not_retry(
        monkeypatch, tmp_path):
    """Windows refuses to unlink a file another process still has open. That is
    an answer, not a transient: something is holding it and will go on holding
    it. Report the reason and stop — a retry loop here is a worker spinning on
    a file the user was told nothing about."""
    from mchost import fileops

    written = _ledger(monkeypatch, tmp_path)
    mine = _media(tmp_path)
    written.record(mine)
    monkeypatch.setattr(fileops, "find_badapple", lambda: None)

    calls = []

    def _held(path):
        calls.append(path)
        raise PermissionError(32, "The process cannot access the file because "
                                  "it is being used by another process")

    monkeypatch.setattr(fileops.os, "remove", _held)
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)

    mc.handle_delete({"reqId": "d7", "path": mine})

    r = _answer(sent, "delete-result")
    assert r["ok"] is False, r
    assert "another process" in r["error"], r
    assert len(calls) == 1, "one attempt, then the reason; no loop: %s" % calls


def test_delete_of_a_recorded_file_that_is_already_gone_says_so(
        monkeypatch, tmp_path):
    from mchost import fileops

    written = _ledger(monkeypatch, tmp_path)
    gone = os.path.join(str(tmp_path), "gone.mp4")
    written.record(gone)
    monkeypatch.setattr(fileops, "find_badapple", lambda: None)
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)

    mc.handle_delete({"reqId": "d8", "path": gone})
    r = _answer(sent, "delete-result")
    assert r["ok"] is False and "gone.mp4" in r["error"], r


def test_the_media_server_stops_serving_a_path_it_is_asked_to_release():
    """The half of (b) that is a claim about the cast lane's own state.

    _DLNA["media"] maps an opaque token to a file, and a token stays registered
    for the whole session — a cast that ended without an explicit stop leaves
    its entry behind, still fetchable and still opened per request. Releasing
    the path is what makes the token stop resolving.

    What it does NOT do is close a handle a response already holds: _serve_file
    keeps the file open for the length of one response. delete reports the
    sharing violation that follows rather than retrying.
    """
    from mchost.cast import legacy

    mine = os.path.join(os.path.dirname(HOST), "mchost", "written.py")
    before = dict(legacy._DLNA["media"])
    legacy._DLNA["media"] = {
        "a" * 32: {"path": mine.upper(), "ctype": "video/mp4"},
        "b" * 32: {"path": mine.replace("\\", "/"), "ctype": "video/mp4"},
        "c" * 32: {"url": "https://cdn.test/v.mp4", "ctype": "video/mp4"},
    }
    try:
        assert legacy.release_local_path(mine) == 2, (
            "both spellings of the same file went; a remote entry is not a "
            "local holder and stays")
        assert list(legacy._DLNA["media"]) == ["c" * 32], legacy._DLNA["media"]
        assert legacy.release_local_path(mine) == 0, "releasing twice is a no-op"
    finally:
        legacy._DLNA["media"] = before


# --- delete does not stop a BadApple that has nothing to do with this file ---
#
# _release_local_holders spawns `BadApple --stop` before the remove. Spawning
# it UNCONDITIONALLY means every tidy-up of a finished download ends whatever
# the user happens to be watching — and, when BadApple is not running at all,
# STARTS a process purely to tell it to stop.
#
# What this host can and cannot establish, stated plainly:
#
#   * "BadApple is playing THIS file" is NOT answerable from here. Their
#     command pipe's grammar is `--beam "<target>" [--headers <token>]` — one
#     verb, no query, no reply channel (mchost/badapple_ipc.py, and BadApple's
#     own docs/protocol/wire-contract.json "ipc").
#   * "something on this machine holds this file open" IS answerable, by
#     asking Windows for the file with no sharing and reading the refusal.
#   * "a BadApple is hosting this session's command pipe" IS answerable, by
#     looking in the pipe namespace — which is the same fact send_beam learns
#     by connecting, learned without connecting.
#
# So the stop is gated on the conjunction of the two answerable ones. It is
# narrower than the question we would rather ask, and it is honest about which
# question it is.


def test_a_file_nothing_has_open_is_not_held_and_one_this_process_opened_is(
        tmp_path):
    """The probe, against real handles rather than a stub of itself.

    CreateFileW with dwShareMode 0 fails with a sharing violation when ANY
    other handle on the file is open, whatever sharing that handle allowed —
    so Python's own open() is enough to make it say so.
    """
    from mchost import fileops

    mine = _media(tmp_path)
    assert fileops._file_is_held(mine) is False, "nothing has it open"
    with open(mine, "rb"):
        assert fileops._file_is_held(mine) is True, "this process has it open"
    assert fileops._file_is_held(mine) is False, "and let it go again"
    assert fileops._file_is_held(os.path.join(str(tmp_path), "nope.mp4")) is False, (
        "a file that is not there is not one anybody is holding")


def test_the_badapple_pipe_probe_does_not_spend_the_instance_it_finds():
    """`is_running` LOOKS; it does not CONNECT — and this is what tells the two
    apart, because a probe that DID connect would answer the same True.

    Connecting is not free. A single-instance server has ONE waiting instance
    and hands it to whoever gets there first, so a probe that took it would
    give BadApple a connection that writes no line — and leave the real beam
    behind it to find the pipe busy. Enumerating the namespace touches no
    server at all.

    The pipe here is created with nMaxInstances 1, the shape BadApple's is, so
    a connect is SPENDABLE and the difference is observable. The second half is
    the control: it connects for real and shows the instance is gone
    afterwards, which is what makes the first half's assertion mean anything.

    Driven against a pipe this test creates, under a name of its own — never
    BadApple's, because standing up `badapple-cmd-<session>` on a machine where
    BadApple is running is squatting on the name it needs.
    """
    import ctypes
    from ctypes import wintypes

    from mchost import badapple_ipc

    name = r"\\.\pipe\mchost-probe-%d" % os.getpid()
    assert badapple_ipc._pipe_is_hosted(name) is False, "nothing hosts it yet"

    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.CreateNamedPipeW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD,
                                   wintypes.DWORD, wintypes.DWORD,
                                   wintypes.DWORD, wintypes.DWORD,
                                   wintypes.DWORD, wintypes.LPVOID]
    k.CreateNamedPipeW.restype = wintypes.HANDLE
    k.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                              wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD,
                              wintypes.HANDLE]
    k.CreateFileW.restype = wintypes.HANDLE
    k.CloseHandle.argtypes = [wintypes.HANDLE]
    invalid = ctypes.c_void_p(-1).value
    _ERROR_PIPE_BUSY = 231

    def connect():
        """A client, opened the way _open_pipe opens it."""
        return k.CreateFileW(name, 0x40000000, 0, None, 3, 0, None)

    # PIPE_ACCESS_INBOUND, byte mode, ONE instance.
    handle = k.CreateNamedPipeW(name, 1, 0, 1, 512, 512, 0, None)
    assert handle and handle != invalid, ctypes.get_last_error()
    try:
        for _ in range(3):
            assert badapple_ipc._pipe_is_hosted(name) is True

        # Three answers later the waiting instance is STILL waiting, so a real
        # client can take it. A probe built on CreateFileW would have spent it
        # on the first question and this open would fail.
        client = connect()
        assert client and client != invalid, (
            "the probe took the instance the beam needs: error %d"
            % ctypes.get_last_error())
        k.CloseHandle(client)

        # The control, and the reason the line above is not vacuous:
        # connecting DOES spend it. The server has not called
        # DisconnectNamedPipe, so the next open is refused with
        # ERROR_PIPE_BUSY — which is exactly what _open_pipe reads as "nothing
        # is hosting it yet" and would then LAUNCH a second BadApple over.
        spent = connect()
        assert spent == invalid and ctypes.get_last_error() == _ERROR_PIPE_BUSY, (
            "a connect that cost nothing would make the check above prove "
            "nothing: handle %r, error %d" % (spent, ctypes.get_last_error()))
    finally:
        k.CloseHandle(handle)
    assert badapple_ipc._pipe_is_hosted(name) is False, "and gone with it"


def test_is_running_asks_about_this_sessions_pipe(monkeypatch):
    """The name matters: it is machine-global and suffixed with the session id,
    so a BadApple in another logon of this user is not this session's."""
    from mchost import badapple_ipc

    asked = []
    monkeypatch.setattr(badapple_ipc, "_pipe_is_hosted",
                        lambda n: (asked.append(n), True)[1])
    assert badapple_ipc.is_running() is True
    assert asked == [badapple_ipc.pipe_name()], asked
    assert asked[0].startswith(badapple_ipc.PIPE_PREFIX), asked


def test_delete_does_not_start_badapple_when_nothing_is_holding_the_file(
        monkeypatch, tmp_path):
    """The ordinary delete: a finished download, nobody playing it.

    Nothing needs releasing, so nothing is spawned. Before this, deleting a
    row ended whatever BadApple was showing — a file it had never been given.
    """
    from mchost import badapple_ipc, fileops

    written = _ledger(monkeypatch, tmp_path)
    mine = _media(tmp_path)
    written.record(mine)
    app = _fake_badapple(monkeypatch, tmp_path)
    monkeypatch.setattr(fileops, "find_badapple", lambda: app)
    monkeypatch.setattr(badapple_ipc, "is_running", lambda: True)  # and playing

    ran = []
    monkeypatch.setattr(fileops.subprocess, "Popen",
                        lambda argv, **k: ran.append(tuple(argv)))
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)

    mc.handle_delete({"reqId": "d20", "path": mine})

    assert _answer(sent, "delete-result")["ok"] is True, sent
    assert not os.path.exists(mine)
    assert ran == [], (
        "nothing had the file open, so there was nothing to stop: %s" % (ran,))


def test_delete_does_not_start_badapple_merely_to_tell_it_to_stop(
        monkeypatch, tmp_path):
    """The file IS held — by something that is not BadApple, because BadApple
    is not running.

    Spawning `--stop` here starts a process that cannot possibly be holding
    the file, and _spawn_badapple_stop's own docstring says the host cannot
    promise that process puts no window up. The remove that follows reports
    Windows' own sentence about who is holding it, which is the answer.
    """
    from mchost import badapple_ipc, fileops

    written = _ledger(monkeypatch, tmp_path)
    mine = _media(tmp_path)
    written.record(mine)
    app = _fake_badapple(monkeypatch, tmp_path)
    monkeypatch.setattr(fileops, "find_badapple", lambda: app)
    monkeypatch.setattr(fileops, "_file_is_held", lambda p: True)
    monkeypatch.setattr(badapple_ipc, "is_running", lambda: False)

    ran = []
    monkeypatch.setattr(fileops.subprocess, "Popen",
                        lambda argv, **k: ran.append(tuple(argv)))
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)

    mc.handle_delete({"reqId": "d21", "path": mine})
    assert _answer(sent, "delete-result")["ok"] is True, sent
    assert ran == [], "no BadApple was running to stop: %s" % (ran,)


def test_delete_stops_badapple_when_it_is_running_and_the_file_is_held(
        monkeypatch, tmp_path):
    """The case the stop is FOR, and the only one it fires in.

    The probe is stubbed to "held forever" while the file itself is free, which
    is also the case where a probe is WRONG — and the delete still succeeds.
    _file_is_held is a probe; os.remove is the authority, and a probe that says
    the wrong thing must not be able to veto a delete that works.
    """
    from mchost import badapple_ipc, fileops

    written = _ledger(monkeypatch, tmp_path)
    mine = _media(tmp_path)
    written.record(mine)
    app = _fake_badapple(monkeypatch, tmp_path)
    monkeypatch.setattr(fileops, "find_badapple", lambda: app)
    monkeypatch.setattr(fileops, "_file_is_held", lambda p: True)
    monkeypatch.setattr(badapple_ipc, "is_running", lambda: True)
    monkeypatch.setattr(fileops, "time", _FakeClock())   # the bound, not spent

    ran = []
    monkeypatch.setattr(fileops.subprocess, "Popen",
                        lambda argv, **k: ran.append(tuple(argv)))
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)

    mc.handle_delete({"reqId": "d22", "path": mine})
    assert _answer(sent, "delete-result")["ok"] is True, sent
    assert ran == [(app, "--stop")], ran


# --- asking BadApple to stop is not the same as it having stopped ---
#
# `--stop` is a Popen: it returns as soon as the process is CREATED, and the
# release it asks for happens later, in another process, after that process's
# runtime has started and written the single-instance pipe. An os.remove fired
# the instant Popen returns therefore runs while the handle is still open, and
# fails with a sharing violation — in precisely the case the gate above exists
# to serve, a file BadApple is playing.
#
# So the release is WAITED for, on the condition itself (_file_is_held) rather
# than on a guessed interval, and the wait is bounded because the condition may
# never come true: the stop is best effort and the gate is over-broad on
# purpose, so the holder may be something `--stop` has no authority over.


class _FakeClock:
    """time.monotonic and time.sleep, wound by the sleeps themselves.

    The bound is a number of SECONDS, and a test that actually spent them would
    be a several-second test for a branch that is pure arithmetic. Winding a
    fake clock from sleep() makes the assertion about the bound exact and costs
    no wall time — and it is also how a test can tell "waited the whole bound"
    from "returned early", which a real clock only makes probable.
    """

    def __init__(self):
        self.now = 0.0
        self.slept = []

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.slept.append(seconds)
        self.now += seconds


def test_delete_waits_for_the_stop_to_land_and_then_removes_the_file(
        monkeypatch, tmp_path):
    """The case the whole button was asked for: BadApple is playing the file,
    and deleting it WORKS.

    The hold here is a REAL handle, not a stub of one. CPython's open() takes
    the CRT's default sharing, which does not include FILE_SHARE_DELETE, so
    os.remove on this file genuinely fails with Windows' own sharing violation
    while it is open — which is what makes this test fail if the remove stops
    waiting for the release.

    The release is tied to the POLL, not to the wall clock: the handle goes on
    the third question, so "it let go partway through the wait" happens at a
    defined point rather than a probable one.
    """
    from mchost import badapple_ipc, fileops

    written = _ledger(monkeypatch, tmp_path)
    mine = _media(tmp_path)
    written.record(mine)
    app = _fake_badapple(monkeypatch, tmp_path)
    monkeypatch.setattr(fileops, "find_badapple", lambda: app)
    monkeypatch.setattr(badapple_ipc, "is_running", lambda: True)

    holder = open(mine, "rb")
    probe = fileops._file_is_held
    seen = []

    def held(path):
        seen.append(path)
        if len(seen) == 3 and not holder.closed:
            holder.close()          # the stop lands, mid-wait
        return probe(path)

    monkeypatch.setattr(fileops, "_file_is_held", held)
    ran = []
    monkeypatch.setattr(fileops.subprocess, "Popen",
                        lambda argv, **k: ran.append(tuple(argv)))
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)

    try:
        mc.handle_delete({"reqId": "d23", "path": mine})
        r = _answer(sent, "delete-result", timeout=30.0)
    finally:
        if not holder.closed:
            holder.close()

    assert r["ok"] is True, r
    assert not os.path.exists(mine), "the file the user asked about is gone"
    assert ran == [(app, "--stop")], ran
    assert len(seen) >= 3, (
        "the remove fired straight after the spawn instead of waiting for the "
        "release it asked for: the file was asked about %d time(s)" % len(seen))


def test_delete_that_waits_out_the_bound_names_what_it_asked_to_stop(
        monkeypatch, tmp_path):
    """The holder that never lets go. Two claims, and the second is the one a
    wait like this gets wrong:

      * the answer NAMES what was asked to release the file and what the person
        can do about it. "Access denied" is true and useless.
      * the wait ENDS. A condition that never comes true is the ordinary way a
        poll becomes a worker spinning forever on a file nobody was told about.

    The clock is injected, so "it waited the whole bound and no further" is read
    off exact numbers. The poll ceiling is the safety net: an unbounded wait
    trips it and the test reports THAT, rather than hanging the run.
    """
    from mchost import badapple_ipc, fileops

    written = _ledger(monkeypatch, tmp_path)
    mine = _media(tmp_path)
    written.record(mine)
    app = _fake_badapple(monkeypatch, tmp_path)
    monkeypatch.setattr(fileops, "find_badapple", lambda: app)
    monkeypatch.setattr(badapple_ipc, "is_running", lambda: True)
    clock = _FakeClock()
    monkeypatch.setattr(fileops, "time", clock)

    holder = open(mine, "rb")           # and it never lets go
    probe = fileops._file_is_held
    seen = []
    overrun = []
    # Four times the polls the bound allows, so an honest bound cannot reach it
    # and a missing one always does. Answering False at the ceiling ends the
    # loop, which is what turns "unbounded" into a failed assertion instead of
    # a run that never finishes.
    ceiling = int(4 * fileops.STOP_RELEASE_TIMEOUT_S / fileops._RELEASE_POLL_S)

    def held(path):
        seen.append(path)
        if len(seen) > ceiling:
            overrun.append(len(seen))
            return False
        return probe(path)

    monkeypatch.setattr(fileops, "_file_is_held", held)
    ran = []
    monkeypatch.setattr(fileops.subprocess, "Popen",
                        lambda argv, **k: ran.append(tuple(argv)))
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)

    try:
        mc.handle_delete({"reqId": "d24", "path": mine})
        r = _answer(sent, "delete-result", timeout=30.0)
    finally:
        holder.close()

    assert overrun == [], (
        "the wait went past %d polls — four times what the bound allows — so "
        "there is no bound" % ceiling)
    assert ran == [(app, "--stop")], ran
    assert r["ok"] is False, r
    assert os.path.exists(mine), "nothing was removed"

    # It waited the WHOLE bound before saying so, and stopped there.
    assert clock.now >= fileops.STOP_RELEASE_TIMEOUT_S, clock.now
    assert clock.now < fileops.STOP_RELEASE_TIMEOUT_S + 2 * fileops._RELEASE_POLL_S, \
        clock.now
    assert len(seen) <= ceiling, len(seen)

    # The reason, in the terms the person reading it can act in.
    assert "clip.mp4" in r["error"], r
    assert "BadApple" in r["error"], r
    assert ("%g" % fileops.STOP_RELEASE_TIMEOUT_S) in r["error"], (
        "the answer says how long it waited, so 'still open' is a fact with a "
        "size rather than a shrug: %r" % (r["error"],))
    # Windows' own sentence survives inside it: it is the part that covers the
    # holder this host never asked, because it could not name it.
    assert "another process" in r["error"], r


def test_delete_of_a_file_nothing_holds_never_waits_at_all(
        monkeypatch, tmp_path):
    """The ordinary delete — a finished download, nobody playing it — pays
    nothing for the wait above.

    BadApple is running here, and still nothing is spawned and nothing is
    slept: the condition that opens that whole branch is "something has this
    file open", and it is false. One question, asked once, then the remove.
    """
    from mchost import badapple_ipc, fileops

    written = _ledger(monkeypatch, tmp_path)
    mine = _media(tmp_path)
    written.record(mine)
    app = _fake_badapple(monkeypatch, tmp_path)
    monkeypatch.setattr(fileops, "find_badapple", lambda: app)
    monkeypatch.setattr(badapple_ipc, "is_running", lambda: True)   # and playing

    clock = _FakeClock()
    monkeypatch.setattr(fileops, "time", clock)
    probe = fileops._file_is_held
    seen = []
    monkeypatch.setattr(fileops, "_file_is_held",
                        lambda p: (seen.append(p), probe(p))[1])
    ran = []
    monkeypatch.setattr(fileops.subprocess, "Popen",
                        lambda argv, **k: ran.append(tuple(argv)))
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)

    mc.handle_delete({"reqId": "d25", "path": mine})
    assert _answer(sent, "delete-result")["ok"] is True, sent
    assert not os.path.exists(mine)
    assert ran == [], "nothing had it open, so there was nothing to stop: %s" % (ran,)
    assert clock.slept == [], (
        "a delete of a free file waited on something: %s" % (clock.slept,))
    assert len(seen) == 1, (
        "the fast path asks once and goes: %d question(s)" % len(seen))


def test_the_stop_button_is_not_gated_the_way_delete_is(monkeypatch, tmp_path):
    """The gate belongs to `delete`, not to `--stop`.

    The popup's stop button IS the user asking for playback to end. It takes no
    path — there is no file to ask about — and a person pressing stop has said
    what they want more clearly than any probe could.
    """
    from mchost import badapple_ipc, fileops

    app = _fake_badapple(monkeypatch, tmp_path)
    monkeypatch.setattr(fileops, "find_badapple", lambda: app)
    monkeypatch.setattr(fileops, "_file_is_held", lambda p: False)
    monkeypatch.setattr(badapple_ipc, "is_running", lambda: False)
    ran = []
    monkeypatch.setattr(fileops.subprocess, "Popen",
                        lambda argv, **k: ran.append(tuple(argv)))
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)

    mc.handle_badapple_stop({"reqId": "s3"})
    assert _answer(sent, "badapple-stop-result")["ok"] is True, sent
    assert ran == [(app, "--stop")], ran


# --- badapple-stop ---

def test_badapple_stop_spawns_a_bare_stop_flag(monkeypatch, tmp_path):
    """argv list, shell=False, and position 0 is the host's own answer. The
    caller names nothing: no field on this frame can reach argv at all."""
    from mchost import fileops

    app = _fake_badapple(monkeypatch, tmp_path)
    monkeypatch.setattr(fileops, "find_badapple", lambda: app)
    ran = []
    monkeypatch.setattr(fileops.subprocess, "Popen",
                        lambda argv, **k: ran.append((argv, k)))
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)

    # The two fields the OTHER badapple verb takes, smuggled onto this one.
    mc.handle_badapple_stop({"reqId": "s1", "path": r"C:\evil.exe",
                             "url": "http://evil.test/"})
    assert wait_for(lambda: bool(sent), timeout=3.0)

    assert len(ran) == 1, ran
    argv, kwargs = ran[0]
    assert isinstance(argv, list), "a list, so nothing is parsed as a command line"
    assert argv == [app, "--stop"], argv
    assert kwargs.get("shell", False) is False, kwargs
    assert _answer(sent, "badapple-stop-result") == {
        "type": "badapple-stop-result", "reqId": "s1", "ok": True,
        "error": None}, sent


def test_badapple_stop_says_so_when_badapple_is_not_installed(
        monkeypatch, tmp_path):
    from mchost import fileops

    monkeypatch.setattr(fileops, "find_badapple", lambda: None)
    ran = []
    monkeypatch.setattr(fileops.subprocess, "Popen",
                        lambda *a, **k: ran.append(a))
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)

    mc.handle_badapple_stop({"reqId": "s2"})
    assert wait_for(lambda: bool(sent), timeout=3.0)

    assert ran == [], ran
    r = _answer(sent, "badapple-stop-result")
    assert r["ok"] is False and "BadApple" in r["error"], r


def test_badapple_show_rides_alongside_the_beam_only_when_asked(
        monkeypatch, tmp_path):
    """The existing verb gains one optional flag. Absent and false must produce
    the argv the shipped extension already sends, unchanged."""
    from mchost import downloads as d

    app = _fake_badapple(monkeypatch, tmp_path)
    clip = _media(tmp_path)

    def _argv(req):
        ran = []
        monkeypatch.setattr(d.subprocess, "Popen",
                            lambda argv, **k: ran.append(argv))
        sent = []
        monkeypatch.setattr(mc, "send", sent.append)
        mc.handle_badapple(req)
        assert wait_for(lambda: bool(ran) or bool(sent), timeout=3.0), sent
        return ran[0] if ran else None

    assert _argv({"id": "b1", "path": clip}) == [app, "--beam", clip]
    assert _argv({"id": "b2", "path": clip, "show": False}) == [app, "--beam", clip]
    assert _argv({"id": "b3", "path": clip, "show": True}) == [
        app, "--beam", clip, "--show"]


# --- thumb ---

def test_thumb_refuses_the_same_two_ways_delete_does(monkeypatch, tmp_path):
    """Reading a file is milder than removing one, but the path is the same
    caller-supplied path, so it is held to the same rule."""
    from mchost import fileops

    written = _ledger(monkeypatch, tmp_path)
    theirs = _media(tmp_path, "holiday.mp4")          # media, not recorded
    evil = _media(tmp_path, "payload.exe", b"MZ")
    written.record(evil)                              # recorded, not media

    ran = []
    monkeypatch.setattr(fileops, "_run_ffmpeg_frame",
                        lambda *a, **k: ran.append(a))
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)

    outside = os.path.join(str(tmp_path), "saved", "..", "holiday.mp4")
    for i, bad in enumerate((theirs, evil, outside)):
        mc.handle_thumb({"reqId": "t%d" % i, "path": bad})
        r = _answer(sent, "thumb-result", timeout=5.0, n=i + 1)
        assert r["dataUrl"] is None, r
        assert r["error"], r
    assert ran == [], "ffmpeg never ran on a refused path"


def test_thumb_returns_a_jpeg_data_url_and_echoes_the_offset(
        monkeypatch, tmp_path, host_clip):
    import base64

    written = _ledger(monkeypatch, tmp_path)
    written.record(host_clip)
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)

    mc.handle_thumb({"reqId": "t9", "path": host_clip, "atSeconds": 2})

    r = _answer(sent, "thumb-result")
    assert r["error"] is None, r
    assert r["atSeconds"] == 2, r
    assert r["dataUrl"].startswith("data:image/jpeg;base64,"), r["dataUrl"][:40]
    raw = base64.b64decode(r["dataUrl"].split(",", 1)[1])
    assert raw[:2] == b"\xff\xd8" and raw[-2:] == b"\xff\xd9", "a whole JPEG"


def test_thumb_falls_back_to_the_first_second_of_a_short_clip(
        monkeypatch, tmp_path, host_clip):
    """The default offset is 15s and most saved videos are longer than that.
    Seeking past the end of a 3-second one returns no frame at all, so the
    fallback is what keeps a short download from showing nothing."""
    written = _ledger(monkeypatch, tmp_path)
    written.record(host_clip)
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)

    mc.handle_thumb({"reqId": "t10", "path": host_clip})   # no atSeconds -> 15

    r = _answer(sent, "thumb-result")
    assert r["error"] is None, r
    assert r["dataUrl"].startswith("data:image/jpeg;base64,"), r
    assert r["atSeconds"] == 1, (
        "the frame that came back is the one near the start, and the reply "
        "says so rather than repeating the 15 that was asked for: %r"
        % {k: v for k, v in r.items() if k != "dataUrl"})


def test_thumb_answers_a_second_time_without_running_ffmpeg_again(
        monkeypatch, tmp_path, host_clip):
    """Cached on (realpath, mtime, size). The popup asks for every visible row
    each time it opens."""
    from mchost import fileops

    written = _ledger(monkeypatch, tmp_path)
    written.record(host_clip)
    fileops.forget_thumb_cache()
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)

    mc.handle_thumb({"reqId": "t11", "path": host_clip, "atSeconds": 2})
    first = _answer(sent, "thumb-result")["dataUrl"]
    assert first

    runs = []
    monkeypatch.setattr(fileops, "_run_ffmpeg_frame",
                        lambda *a, **k: (runs.append(a), (None, "must not run"))[1])
    mc.handle_thumb({"reqId": "t12", "path": host_clip, "atSeconds": 2})
    second = _answer(sent, "thumb-result", timeout=10.0, n=2)
    assert runs == [], "the second ask was answered from the cache"
    assert second["dataUrl"] == first, second


def test_thumb_re_reads_a_file_that_changed_under_the_same_name(
        monkeypatch, tmp_path, host_clip):
    """A re-download lands on the same deduplicated name. A cache keyed on the
    path alone would serve the OLD file's frame for the new one."""
    from mchost import fileops

    written = _ledger(monkeypatch, tmp_path)
    written.record(host_clip)
    fileops.forget_thumb_cache()
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)
    mc.handle_thumb({"reqId": "t13", "path": host_clip, "atSeconds": 2})
    assert _answer(sent, "thumb-result")["dataUrl"], sent

    with open(host_clip, "ab") as fh:
        fh.write(b"\x00" * 4096)          # size changes, so the cache key does
    runs = []
    real = fileops._run_ffmpeg_frame
    monkeypatch.setattr(fileops, "_run_ffmpeg_frame",
                        lambda *a, **k: (runs.append(a), real(*a, **k))[1])
    mc.handle_thumb({"reqId": "t14", "path": host_clip, "atSeconds": 2})
    _answer(sent, "thumb-result", n=2)
    assert len(runs) == 1, "the changed file was decoded again, not served stale"


def test_a_boolean_offset_is_not_read_as_one_second(monkeypatch, tmp_path):
    """bool is a subclass of int in Python, so `{"atSeconds": true}` would seek
    to 1s without the exclusion — the same trap guard's own "num" kind spells
    out for `{"seq": true}`.

    guard.validate_message refuses a boolean there first, and this is the
    second line: _at_seconds is also reached by handle_thumb calls that did not
    come off the wire, and a guard whose only proof is another module's guard
    is one refactor from being nothing.
    """
    from mchost import fileops

    assert guard._is_num(True) is False, "the wire refuses it first"
    for value in (True, False):
        assert fileops._at_seconds(value) == fileops.DEFAULT_AT_SECONDS, value


def test_a_negative_offset_reads_as_the_default_and_never_reaches_ffmpeg(
        monkeypatch, tmp_path):
    """guard.NUM admits -5: a negative offset DOES arrive here off the wire.

    It is not a position in a file, and `-ss -5` is an argument to ffmpeg
    rather than an error, so it reads as the default instead.
    """
    from mchost import fileops

    assert fileops._at_seconds(-5) == fileops.DEFAULT_AT_SECONDS
    assert fileops._at_seconds(-0.001) == fileops.DEFAULT_AT_SECONDS
    assert fileops._at_seconds(0) == 0, "zero IS a position in a file"

    written = _ledger(monkeypatch, tmp_path)
    clip = _media(tmp_path)
    written.record(clip)
    offsets = []
    monkeypatch.setattr(
        fileops, "_run_ffmpeg_frame",
        lambda path, at: (offsets.append(at), (None, "no frame"))[1])
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)

    mc.handle_thumb({"reqId": "t20", "path": clip, "atSeconds": -5})
    _answer(sent, "thumb-result")
    assert offsets and all(at >= 0 for at in offsets), offsets
    assert offsets[0] == fileops.DEFAULT_AT_SECONDS, offsets


def test_ffmpeg_output_that_is_not_a_jpeg_is_not_sent_as_one(monkeypatch, tmp_path):
    """returncode 0 is not the same claim as "this is a picture".

    ffmpeg exits 0 having written nothing at all when a filter produces no
    frame, and the bytes on stdout are whatever the muxer put there. They are
    about to be base64'd into a data:image/jpeg URL the popup renders, so the
    magic number is what makes that label true rather than assumed.
    """
    from mchost import fileops

    class _Done(object):
        def __init__(self, out):
            self.returncode = 0
            self.stdout = out
            self.stderr = b""

    for body in (b"", b"<!doctype html>", b"RIFF\x00\x00\x00\x00WEBP"):
        monkeypatch.setattr(fileops.subprocess, "run",
                            lambda *a, **k: _Done(body))
        data, error = fileops._run_ffmpeg_frame(str(tmp_path / "clip.mp4"), 2)
        assert data is None, (body, data[:16])
        assert error and "clip.mp4" in error, (body, error)

    monkeypatch.setattr(fileops.subprocess, "run",
                        lambda *a, **k: _Done(b"\xff\xd8\xff\xdb-and-so-on"))
    data, error = fileops._run_ffmpeg_frame(str(tmp_path / "clip.mp4"), 2)
    assert data == b"\xff\xd8\xff\xdb-and-so-on" and error is None, (data, error)


def test_the_thumb_cache_keeps_the_row_the_popup_keeps_asking_for():
    """Eviction is least-recently-USED, and a read is a use.

    The popup asks for every visible row each time it opens, and an answer off
    the cache writes nothing. Under plain insertion order those re-asks count
    for nothing, and the row the user looks at every time is evicted in favour
    of one decoded once and never asked for again.
    """
    from mchost import fileops

    fileops.forget_thumb_cache()
    try:
        keys = [("row%d" % i, 0, 0, 1) for i in range(fileops._THUMB_CACHE_MAX)]
        for key in keys:
            fileops._cache_put(key, ("x", 1))

        assert fileops._cache_get(keys[0]) == ("x", 1), "still there, and read"
        fileops._cache_put(("row-new", 0, 0, 1), ("x", 1))   # forces one out

        assert keys[0] in fileops._THUMB_CACHE, (
            "the row that was asked for again survived")
        assert keys[1] not in fileops._THUMB_CACHE, (
            "and the one nobody has looked at since it was decoded went")
    finally:
        fileops.forget_thumb_cache()


def test_the_thumb_cache_is_bounded_by_bytes_as_well_as_by_count():
    """A count bound alone is not a memory bound here.

    An entry is a data: URL, and MAX_JPEG_BYTES permits one of 512KB base64;
    64 of those is 32MB held by a helper that is otherwise idle waiting on a
    pipe. Both bounds evict least-recently-used first — see the test above for
    what makes a read a use."""
    from mchost import fileops

    fileops.forget_thumb_cache()
    try:
        big = "d" * (1024 * 1024)
        for i in range(20):
            fileops._cache_put(("big%d" % i, 0, 0, 1), (big, 1))
        assert fileops._THUMB_CACHE_HELD[0] <= fileops._THUMB_CACHE_BYTES, (
            fileops._THUMB_CACHE_HELD[0])
        assert ("big19", 0, 0, 1) in fileops._THUMB_CACHE, "the newest stayed"

        fileops.forget_thumb_cache()
        for i in range(fileops._THUMB_CACHE_MAX * 2):
            fileops._cache_put(("small%d" % i, 0, 0, 1), ("x", 1))
        assert len(fileops._THUMB_CACHE) <= fileops._THUMB_CACHE_MAX, (
            len(fileops._THUMB_CACHE))
    finally:
        fileops.forget_thumb_cache()


def test_a_very_tall_video_is_fitted_into_the_box_not_just_narrowed(
        monkeypatch, tmp_path, _clip_master):
    """The other half of the ceiling, and the one that decides the REAL sizes.

    "320px wide" bounds one dimension. A 320x1706 frame is still 320px wide,
    and the same random-noise content that measured 111,709 bytes at 320x320
    measured 595,793 at 320x1706 — five times as much, from a constraint that
    looks satisfied. So the scale has to be a BOX, and this decodes an actual
    tall video rather than reading the filter string, because what matters is
    the picture that comes out.
    """
    from mchost import tools, written as w, fileops

    if not tools.FFMPEG:
        pytest.skip("no ffmpeg on this machine to decode a frame with")
    tall = os.path.join(str(tmp_path), "tall.mp4")
    subprocess.run([tools.FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
                    "-f", "lavfi",
                    "-i", "testsrc=size=240x1600:rate=10:duration=2",
                    "-pix_fmt", "yuv420p", tall], check=True, timeout=180)
    _ledger(monkeypatch, tmp_path)
    w.record(tall)
    fileops.forget_thumb_cache()
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)

    mc.handle_thumb({"reqId": "t16", "path": tall, "atSeconds": 1})
    r = _answer(sent, "thumb-result")
    assert r["error"] is None, r

    import base64
    raw = base64.b64decode(r["dataUrl"].split(",", 1)[1])
    assert len(raw) <= fileops.MAX_JPEG_BYTES, len(raw)
    width, height = _jpeg_size(raw)
    assert width <= fileops.THUMB_BOX and height <= fileops.THUMB_BOX, (
        "%dx%d does not fit the %dpx box"
        % (width, height, fileops.THUMB_BOX))
    # and it is still the video's own shape, not a squashed square
    assert height > width, "a 240x1600 source stays taller than it is wide"


def _jpeg_size(raw):
    """(width, height) off the JPEG's own SOF marker — no image library."""
    i = 2
    while i + 9 < len(raw):
        assert raw[i] == 0xFF, i
        marker = raw[i + 1]
        seglen = (raw[i + 2] << 8) | raw[i + 3]
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            return ((raw[i + 7] << 8) | raw[i + 8],
                    (raw[i + 5] << 8) | raw[i + 6])
        i += 2 + seglen
    raise AssertionError("no SOF marker in the JPEG")


def test_a_thumb_frame_cannot_exceed_the_native_messaging_ceiling(
        monkeypatch, tmp_path):
    """MEASURED, not assumed.

    Firefox's own modules/NativeMessaging.sys.mjs (read out of omni.ja on this
    machine) caps what a native application may SEND at
    MAX_READ = 1024 * 1024 bytes, lowerable by the pref
    webextensions.native-messaging.max-input-message-bytes. A frame over the
    cap does not fail one request: _startRead throws an ExtensionError and the
    whole port goes down, taking every live download row with it.

    So the frame this verb produces has to be bounded BY CONSTRUCTION, and the
    bound is checked on the encoded bytes rather than argued from the pixel
    dimensions — JPEG size depends on content, and a 320px-wide frame of a very
    tall video is not small. Worst case measured with ffmpeg on pure random
    noise fitted into the 320x320 box this verb scales into: 111,709 bytes at
    -q:v 2, which is 149KB base64 and 14% of the ceiling.

    fileops.MAX_JPEG_BYTES is the bound, enforced on the encoder's ACTUAL
    output: a frame that comes out over it is answered as an error, never sent.
    """
    from mchost import fileops

    assert fileops.NATIVE_FRAME_CEILING == 1024 * 1024
    # base64 is 4 bytes out per 3 in, plus the data: prefix and the JSON
    # envelope; the budget has to leave room for all of it.
    encoded = (fileops.MAX_JPEG_BYTES + 2) // 3 * 4
    assert encoded + 4096 < fileops.NATIVE_FRAME_CEILING, (
        "MAX_JPEG_BYTES=%d base64-encodes to %d, which does not fit under %d"
        % (fileops.MAX_JPEG_BYTES, encoded, fileops.NATIVE_FRAME_CEILING))

    written = _ledger(monkeypatch, tmp_path)
    clip = _media(tmp_path)
    written.record(clip)
    monkeypatch.setattr(
        fileops, "_run_ffmpeg_frame",
        lambda *a, **k: (b"\xff\xd8" + b"Z" * fileops.MAX_JPEG_BYTES, None))
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)

    mc.handle_thumb({"reqId": "t15", "path": clip, "atSeconds": 2})
    r = _answer(sent, "thumb-result")
    assert r["dataUrl"] is None and r["error"], r
    assert len(json.dumps(r).encode("utf-8")) < fileops.NATIVE_FRAME_CEILING, r
