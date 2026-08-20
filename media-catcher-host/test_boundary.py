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
    """Why refuse_url is a handler call and not a schema kind on the field name.

    cast's "url" is a media SOURCE: mchost/cast/legacy.py serves anything that
    is not ^https?:// as a file on disk, which is how casting a finished
    recording works. Typing every field named "url" would refuse that.
    """
    from mchost.cast import legacy

    assert guard.MESSAGE_SCHEMA["cast"]["url"] == guard.STR
    assert guard.validate_message(
        {"cmd": "cast", "sub": "start", "id": "d1",
         "url": r"C:\Users\me\Videos\clip.mp4"}) is None
    entry = legacy._dlna_media_url(r"C:\Users\me\Videos\clip.mp4", None)
    assert isinstance(entry, tuple)
