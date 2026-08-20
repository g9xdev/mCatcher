"""A beam's SIGN-IN DETAILS: what may ride one, and how they travel.

Why this file exists
--------------------
The overlay can beam a stream a page is playing. A login-gated stream answers
403 to anyone who asks without the sign-in the browser had, so the beam has to
carry one — and a credential is the one field on this port where "it arrived"
is not the whole of the requirement. WHERE it travelled matters as much.

BadApple accepts sign-in details on its single-instance IPC PIPE and nowhere
else. Its own contract says why, and the sentence is worth keeping in front of
whoever edits this file:

    Do NOT launch it as `BadApple.App.exe --beam <target> --headers <token>`:
    argv is readable by every process running as this user
    (Win32_Process.CommandLine), which is the whole reason the credential field
    exists on this pipe and not on the command line. argv accepts
    `--beam <target>` and nothing else.

So this host keeps TWO routes and picks between them by whether a credential is
present, not by taste: no credential still goes on argv exactly as it always
did, and a credential goes down the pipe. `test_a_credential_never_reaches_argv`
is the test that would catch someone collapsing the two back into one.

THE FIXTURES BELOW ARE COPIED FROM BADAPPLE, NOT INVENTED HERE. Every literal
in _CONTRACT is quoted from `docs/protocol/wire-contract.json` on BadApple's
`feat/beam-url` (read at f390505), and they are asserted as byte strings rather
than rebuilt by the same code they are meant to check. That is the point of the
file: if BadApple's side drifts, this suite goes red HERE rather than shipping
beams their engine refuses by name at the far end.
"""
import base64
import ctypes
import json
import os
import threading
import uuid
from ctypes import wintypes

import pytest

from conftest import load_host, wait_for

mc = load_host()

from mchost import badapple_ipc, guard   # noqa: E402


# ---------------------------------------------------------------------------
# 1. The contract, quoted
#
# Copied verbatim from BadApple docs/protocol/wire-contract.json, "ipc" and
# commands.beam.fields.headers. Written as literals so that reproducing them
# from our own encoder cannot make this suite agree with itself.
# ---------------------------------------------------------------------------

_CONTRACT = {
    # commands.beam.fields.headers: "Names are limited to Cookie, Referer and
    # User-Agent, matched case-insensitively and carried in exactly that
    # casing".
    "names": ("Cookie", "Referer", "User-Agent"),
    # ipc.line.headers: "{"Cookie":"sid=1"} -> eyJDb29raWUiOiJzaWQ9MSJ9"
    "token_example": "eyJDb29raWUiOiJzaWQ9MSJ9",
    "token_source": {"Cookie": "sid=1"},
    # ipc.example.plain / .url / .gated
    "line_plain": '--beam "C:\\Videos\\Some Movie.mp4"',
    "line_url": '--beam "https://cdn.example.test/live/master.m3u8"',
    "line_gated": ('--beam "https://cdn.example.test/live/master.m3u8"'
                   ' --headers eyJDb29raWUiOiJzaWQ9MSJ9'),
    # ipc.transport.name
    "pipe_prefix": "\\\\.\\pipe\\badapple-cmd-",
}


def test_the_allowlist_is_badapples_three_names_in_badapples_casing():
    """Not a superset and not a re-spelling. The engine refuses every other
    name BY NAME (serving.normalize_beam_headers) and so does the shell
    (BeamHeaders.Allowed), so a fourth name here would not be a feature — it
    would be a beam that dies at the far end carrying a credential it was told
    to send."""
    assert guard.BEAM_HEADERS == _CONTRACT["names"], (
        "the host's allowlist must equal BadApple's, exact casing included")


def test_the_token_is_the_spelling_badapple_documents():
    """base64 (standard alphabet, padded, no whitespace) of the UTF-8 JSON
    object. Asserted against BadApple's own worked example rather than against
    a second call to our encoder."""
    token = badapple_ipc.encode_headers(_CONTRACT["token_source"])
    assert token == _CONTRACT["token_example"], token
    # "base64's alphabet has neither whitespace nor quotes, so the value is
    # always exactly one token" -- the parser rejects a token with whitespace
    # in it, so this is a property their side depends on.
    assert token.strip() == token and " " not in token


def test_the_token_decodes_to_the_object_badapple_will_read():
    """BadApple decodes with Convert.FromBase64String then deserializes to a
    Dictionary<string,string>. A value that is not a string is refused there,
    so nothing but strings may be encoded here."""
    token = badapple_ipc.encode_headers(
        {"Cookie": "sid=1", "Referer": "https://page.example/watch"})
    decoded = json.loads(base64.b64decode(token).decode("utf-8"))
    assert decoded == {"Cookie": "sid=1", "Referer": "https://page.example/watch"}
    assert all(isinstance(v, str) for v in decoded.values())


@pytest.mark.parametrize("target,token,expected", [
    ("C:\\Videos\\Some Movie.mp4", None, _CONTRACT["line_plain"]),
    ("https://cdn.example.test/live/master.m3u8", None, _CONTRACT["line_url"]),
    ("https://cdn.example.test/live/master.m3u8",
     _CONTRACT["token_example"], _CONTRACT["line_gated"]),
])
def test_the_line_is_byte_for_byte_the_documented_grammar(target, token, expected):
    """`--beam "<target>" [--headers <token>]`. The target is ALWAYS quoted —
    their parser reads a bare target to the end of the line, so a bare one
    cannot carry a second field — and the token is written bare and last."""
    assert badapple_ipc.format_beam_command(target, token) == expected


def test_the_pipe_is_named_per_windows_session():
    """`\\\\.\\pipe\\badapple-cmd-<SessionId>`, where SessionId is the WRITER's
    own session. A pipe name is machine-global while its ACL is not, so without
    the suffix a forward from one interactive session could be delivered to
    another session's window."""
    name = badapple_ipc.pipe_name()
    assert name.startswith(_CONTRACT["pipe_prefix"]), name
    assert name[len(_CONTRACT["pipe_prefix"]):].isdigit(), name
    assert name.endswith(str(badapple_ipc.session_id()))


# ---------------------------------------------------------------------------
# 2. The gate: which names, and which values
#
# Mirrored from serving.normalize_beam_headers. Where the two differ, this side
# is the STRICTER one and deliberately so: handle_badapple's docstring already
# records that two rules guarding one danger are free to drift and that drift
# in the permissive direction is the hole. Refusing more than BadApple refuses
# costs a beam that would have worked; refusing less ships a credential their
# engine bounces.
# ---------------------------------------------------------------------------

def test_a_name_outside_the_allowlist_is_refused_by_name():
    """By NAME, not dropped. Silently discarding it would send a beam that
    looks signed-in and is not, and the 403 that follows reads as a broken
    stream rather than a missing credential."""
    canonical, refusal = guard.normalize_beam_headers({"Authorization": "Bearer x"})
    assert canonical is None
    assert refusal and "Authorization" in refusal, refusal


@pytest.mark.parametrize("spelling", ["cookie", "COOKIE", "CoOkIe", " Cookie "])
def test_a_name_is_matched_case_insensitively_and_carried_canonically(spelling):
    """"matched case-insensitively and carried in exactly that casing". Their
    engine keys its map on the canonical spelling, so settling the casing is
    this side's job, not theirs."""
    canonical, refusal = guard.normalize_beam_headers({spelling: "sid=1"})
    assert refusal is None, refusal
    assert canonical == {"Cookie": "sid=1"}


@pytest.mark.parametrize("bad", ["a\rb", "a\nb", "a\x00b", "a\r\nSet-Cookie: x"])
def test_a_value_carrying_a_line_break_is_refused(bad):
    """CR, LF and NUL are how one header becomes two of the caller's choosing.
    Refused for every allowed name, not only for Cookie."""
    for name in guard.BEAM_HEADERS:
        canonical, refusal = guard.normalize_beam_headers({name: bad})
        assert canonical is None
        assert refusal, (name, bad)


def test_the_value_rule_is_at_least_as_strict_as_badapples():
    """BadApple refuses CR, LF and NUL. This host refuses every C0 and DEL --
    guard._has_control_char, the same class refuse_url uses. A superset is
    safe; a subset would be a credential their engine refuses after we told the
    user it was sent."""
    for ch in ("\r", "\n", "\x00", "\x1b", "\x7f", "\t"):
        _, refusal = guard.normalize_beam_headers({"Cookie": "a%sb" % ch})
        assert refusal, "control char %r must be refused" % ch


def test_absent_and_empty_both_mean_no_credential():
    """"ABSENT means this beam has no credential, and it must not be spelled as
    an empty object." An empty object reaching this host is therefore not an
    error to report — it is a beam with nothing to carry, and what leaves here
    must be the absent spelling either way."""
    for empty in (None, {}):
        canonical, refusal = guard.normalize_beam_headers(empty)
        assert refusal is None
        assert canonical == {}


def test_a_non_object_is_refused_rather_than_coerced():
    for junk in ("Cookie: sid=1", ["Cookie"], 7):
        canonical, refusal = guard.normalize_beam_headers(junk)
        assert canonical is None and refusal, junk


def test_a_non_string_value_is_refused():
    """BadApple deserializes to Dictionary<string,string>; a number there is a
    JsonException and a refused beam. Refusing here says so in a sentence
    instead."""
    canonical, refusal = guard.normalize_beam_headers({"Cookie": 1})
    assert canonical is None and refusal, refusal


# ---------------------------------------------------------------------------
# 3. The handler: where a credential goes, and where it must never go
# ---------------------------------------------------------------------------

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


def _capture(monkeypatch):
    """Both routes out of handle_badapple, captured. argv is the credential-free
    one; the pipe is the other."""
    ran, beamed, sent = [], [], []
    monkeypatch.setattr(mc.subprocess, "Popen", lambda *a, **k: ran.append((a, k)))
    monkeypatch.setattr(badapple_ipc, "send_beam",
                        lambda *a, **k: beamed.append((a, k)))
    monkeypatch.setattr(mc, "send", sent.append)
    return ran, beamed, sent


SECRET = "sid=SUPERSECRETSESSION"


def test_a_credential_never_reaches_argv(monkeypatch, tmp_path):
    """THE point of this file. Win32_Process.CommandLine is readable by every
    process running as this user, so a cookie on a command line is a cookie
    published to the machine for as long as the process lives."""
    app = _fake_badapple(monkeypatch, tmp_path)
    ran, beamed, sent = _capture(monkeypatch)

    url = "https://cdn.example.test/live/master.m3u8"
    mc.handle_badapple({"id": "c1", "url": url,
                        "headers": {"Cookie": SECRET}})
    assert wait_for(lambda: bool(beamed), timeout=2.0), "the beam went somewhere"
    assert sent == [], sent
    assert ran == [], "a gated beam is not spawned with argv at all"

    args, kwargs = beamed[0]
    flat = repr(args) + repr(kwargs)
    assert SECRET not in flat, "the raw cookie must not be an argument either"
    assert base64.b64encode(
        json.dumps({"Cookie": SECRET}, separators=(",", ":")).encode()
    ).decode() in flat, "the token is what travels"
    assert args[0] == app and args[1] == url, args


def test_absence_stays_absence_and_keeps_the_argv_route(monkeypatch, tmp_path):
    """Every beam predating this feature sends no headers field, and the engine
    branches on its presence. A beam with nothing to carry must therefore look
    exactly like it did before — same argv, no pipe, no empty object."""
    app = _fake_badapple(monkeypatch, tmp_path)
    ran, beamed, sent = _capture(monkeypatch)

    url = "https://cdn.example.test/live/master.m3u8"
    for frame in ({"id": "c2", "url": url},
                  {"id": "c3", "url": url, "headers": {}},
                  {"id": "c4", "url": url, "headers": None}):
        ran[:], beamed[:], sent[:] = [], [], []
        mc.handle_badapple(frame)
        assert wait_for(lambda: bool(ran), timeout=2.0), frame
        assert beamed == [], "nothing to carry means nothing on the pipe: %r" % (frame,)
        assert sent == [], sent
        argv, _ = ran[0]
        assert argv[0] == [app, "--beam", url], argv
        assert "--headers" not in argv[0], argv


def test_a_credential_on_a_local_file_is_refused(monkeypatch, tmp_path):
    """Mirrors the engine: "Sign-in details can only ride an http/https link".
    There is no origin to send them to, and accepting them would teach the
    caller that BadApple took a credential it in fact discarded."""
    _fake_badapple(monkeypatch, tmp_path)
    ran, beamed, sent = _capture(monkeypatch)
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"\x00")

    mc.handle_badapple({"id": "c5", "path": str(clip),
                        "headers": {"Cookie": SECRET}})
    assert wait_for(lambda: bool(sent), timeout=2.0), "handle_badapple answered"
    assert ran == [] and beamed == [], "nothing was launched"
    assert sent[0].get("id") == "c5"
    assert SECRET not in json.dumps(sent[0]), "the refusal does not quote the cookie"


def test_a_refused_header_name_answers_the_click(monkeypatch, tmp_path):
    _fake_badapple(monkeypatch, tmp_path)
    ran, beamed, sent = _capture(monkeypatch)

    mc.handle_badapple({"id": "c6", "url": "https://cdn.example.test/a.m3u8",
                        "headers": {"Authorization": "Bearer " + SECRET}})
    assert wait_for(lambda: bool(sent), timeout=2.0), "handle_badapple answered"
    assert ran == [] and beamed == []
    assert sent[0].get("id") == "c6"
    assert "Authorization" in sent[0].get("error", "")
    assert SECRET not in json.dumps(sent[0]), "a refusal never quotes the value"


def test_a_refusal_never_carries_the_value(monkeypatch, tmp_path):
    """A refusal is written to the extension's log ring and shown in a panel on
    the page. Naming the header is what makes it actionable; quoting the value
    would put the credential somewhere it was never going to travel."""
    _fake_badapple(monkeypatch, tmp_path)
    ran, beamed, sent = _capture(monkeypatch)

    mc.handle_badapple({"id": "c7", "url": "https://cdn.example.test/a.m3u8",
                        "headers": {"Cookie": SECRET + "\r\nX-Evil: 1"}})
    assert wait_for(lambda: bool(sent), timeout=2.0), "handle_badapple answered"
    assert ran == [] and beamed == []
    assert SECRET not in json.dumps(sent[0]), sent


# ---------------------------------------------------------------------------
# 4. The pipe, for real
#
# Everything above substitutes send_beam, which proves the handler CHOOSES the
# pipe and never proves the pipe works. These two stand up an actual Windows
# named pipe and make the real ctypes writer talk to it, because a suite that
# only ever exercises a stub is a suite agreeing with itself.
#
# The pipe is given a unique name rather than badapple_ipc.pipe_name(): a real
# BadApple running on this machine already owns that one, and a test that fails
# depending on whether the user has the app open is a test nobody trusts.
# test_the_pipe_is_named_per_windows_session pins the real name separately.
# ---------------------------------------------------------------------------

_PIPE_ACCESS_INBOUND = 1
_PIPE_TYPE_BYTE = 0
_PIPE_WAIT = 0


def _serve_one_line(name, got, ready):
    """A one-shot named-pipe server. Appends the decoded line to `got`."""
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.CreateNamedPipeW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                   wintypes.DWORD, wintypes.DWORD, wintypes.DWORD,
                                   wintypes.DWORD, wintypes.LPVOID]
    k.CreateNamedPipeW.restype = wintypes.HANDLE
    h = k.CreateNamedPipeW(name, _PIPE_ACCESS_INBOUND,
                           _PIPE_TYPE_BYTE | _PIPE_WAIT, 1, 4096, 4096, 0, None)
    ready.set()
    if h == ctypes.c_void_p(-1).value:
        return
    try:
        k.ConnectNamedPipe(h, None)
        buf = ctypes.create_string_buffer(8192)
        read = wintypes.DWORD(0)
        if k.ReadFile(h, buf, 8192, ctypes.byref(read), None):
            got.append(buf.raw[:read.value].decode("utf-8"))
    finally:
        k.CloseHandle(h)


@pytest.fixture
def pipe(monkeypatch):
    """A live pipe on a unique name, with badapple_ipc pointed at it."""
    name = "\\\\.\\pipe\\mc-beam-test-%d-%s" % (os.getpid(), uuid.uuid4().hex)
    got, ready = [], threading.Event()
    t = threading.Thread(target=_serve_one_line, args=(name, got, ready),
                         daemon=True)
    t.start()
    assert ready.wait(5), "the test pipe server came up"
    monkeypatch.setattr(badapple_ipc, "pipe_name", lambda: name)
    yield got, t


def test_a_real_pipe_receives_the_documented_line_and_nothing_else(pipe):
    """The whole writer, end to end: CreateFileW onto a live pipe, the
    current-user check against a pipe we really own, WriteFile, and a UTF-8
    LF-terminated line. If the ctypes below were wrong, this is what would say
    so rather than a green stub."""
    got, thread = pipe
    token = badapple_ipc.encode_headers({"Cookie": SECRET})

    badapple_ipc.send_beam("C:\\nope\\BadApple.App.exe",
                           "https://cdn.example.test/live/master.m3u8", token)
    thread.join(5)
    assert got, "the line arrived"

    assert got[0].endswith("\n"), "LF-terminated, one line per connection"
    assert got[0][:-1] == (
        '--beam "https://cdn.example.test/live/master.m3u8" --headers %s' % token)
    # base64 is a framing, not a cipher: the cookie must not be readable, but
    # the token that carries it plainly is -- which is why nothing logs it.
    assert SECRET not in got[0]
    assert got[0].encode("utf-8")[:3] != b"\xef\xbb\xbf", "no BOM"


def test_a_pipe_that_is_not_up_yet_is_waited_for_after_a_bare_launch(monkeypatch):
    """"If Connect fails, launch BadApple.App.exe with NO arguments, wait for
    the pipe, and then write." NO ARGUMENTS is the load-bearing half: the
    launch must not carry the target (that would beam twice) and must not carry
    the credential (that is the command line this whole route avoids)."""
    name = "\\\\.\\pipe\\mc-beam-test-%d-%s" % (os.getpid(), uuid.uuid4().hex)
    monkeypatch.setattr(badapple_ipc, "pipe_name", lambda: name)
    got, ready, launched = [], threading.Event(), []
    server = {}

    def fake_launch(app):
        launched.append(app)
        t = threading.Thread(target=_serve_one_line, args=(name, got, ready),
                             daemon=True)
        t.start()
        server["t"] = t

    monkeypatch.setattr(badapple_ipc, "_launch_bare", fake_launch)

    token = badapple_ipc.encode_headers({"Referer": "https://page.example/watch"})
    badapple_ipc.send_beam("C:\\nope\\BadApple.App.exe",
                           "https://cdn.example.test/a.m3u8", token, timeout=10)
    server["t"].join(5)

    assert launched == ["C:\\nope\\BadApple.App.exe"], (
        "launched by path alone — no target and no credential on that argv")
    assert got and got[0][:-1] == (
        '--beam "https://cdn.example.test/a.m3u8" --headers %s' % token)


def test_the_schema_types_the_three_names_it_will_forward():
    """Unlisted keys are ignored by the table rather than refused (it types
    fields, it does not express relations), so the ALLOWLIST is enforced in the
    handler. What the table buys here is that a listed name cannot arrive as
    the wrong type."""
    assert guard.MESSAGE_SCHEMA["badapple"]["headers"] == {
        "Cookie": guard.STR, "Referer": guard.STR, "User-Agent": guard.STR,
    }
    assert guard.validate_message(
        {"cmd": "badapple", "url": "https://a.test/v.m3u8",
         "headers": {"Cookie": 1}}), "a non-string value is a schema refusal"
    assert guard.validate_message(
        {"cmd": "badapple", "url": "https://a.test/v.m3u8",
         "headers": "Cookie: sid=1"}), "a string where an object belongs is refused"
