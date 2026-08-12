"""Native JSON file-sink protocol tests (Task 15).

Covers open/chunk/commit/abort, stale-attempt isolation, path rejection,
chunk validation, MAX_UNACKED=4 backpressure, races, and allowlisted frames.
Never expects pget-fallback or browser-download instructions from the host.
"""
from __future__ import annotations

import base64
import errno
import inspect
import os
import threading
import time

import pytest

from conftest import load_host, wait_for

mc = load_host()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

ALLOWED_TYPES = frozenset({
    "file-opened",
    "file-chunk-ack",
    "file-committed",
    "file-aborted",
    "file-error",
})

# Fields that must never appear on any emitted sink frame (privacy/allowlist).
FORBIDDEN_KEYS = frozenset({
    "url", "urls", "cookie", "cookies", "header", "headers",
    "authorization", "referer", "userAgent", "dataB64", "secret",
    "signedUrl", "rawUrl", "extra", "error", "exc", "traceback",
    "pget-fallback", "browserDownload", "useFirefox",
})

SECRET_SENTINEL = "SECRET-COOKIE-SENTINEL-DO-NOT-ECHO"


@pytest.fixture(autouse=True)
def _reset_file_sinks():
    """Clear live sink registry between tests when the module exists."""
    try:
        import mchost.filesink as fs
        if hasattr(fs, "_reset_for_tests"):
            fs._reset_for_tests()
        elif hasattr(fs, "_SINKS"):
            with getattr(fs, "_LOCK", threading.RLock()):
                for s in list(getattr(fs, "_SINKS", {}).values()):
                    h = getattr(s, "handle", None)
                    if h is not None:
                        try:
                            h.close()
                        except Exception:
                            pass
                    part = getattr(s, "part_path", None)
                    if part and os.path.isfile(part):
                        try:
                            os.remove(part)
                        except Exception:
                            pass
                fs._SINKS.clear()
                if hasattr(fs, "_PART_OWNERS"):
                    fs._PART_OWNERS.clear()
                if hasattr(fs, "_BINDINGS"):
                    fs._BINDINGS.clear()
    except Exception:
        pass
    yield
    try:
        import mchost.filesink as fs
        if hasattr(fs, "_reset_for_tests"):
            fs._reset_for_tests()
    except Exception:
        pass


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _open(tmp_path, monkeypatch, sent, job="j", token="a1", name="out.mp4",
          dir_=None, extra=None):
    monkeypatch.setattr(mc, "send", lambda m: sent.append(dict(m)))
    req = {
        "jobId": job,
        "attemptToken": token,
        "requestedFilename": name,
        "dir": str(tmp_path) if dir_ is None else dir_,
    }
    if extra:
        req.update(extra)
    mc.handle_file_open(req)
    opened = [m for m in sent if m.get("type") == "file-opened"]
    return opened[0] if opened else None


def _chunk(sent, sink, job, token, seq, data, length=None, **extra):
    payload = {
        "sinkId": sink,
        "jobId": job,
        "attemptToken": token,
        "seq": seq,
        "dataB64": _b64(data) if isinstance(data, (bytes, bytearray)) else data,
        "length": len(data) if length is None and isinstance(data, (bytes, bytearray)) else length,
    }
    payload.update(extra)
    mc.handle_file_chunk(payload)


def _errors(sent):
    return [m for m in sent if m.get("type") == "file-error"]


def _assert_frames_safe(sent):
    for m in sent:
        assert m.get("type") in ALLOWED_TYPES, m
        for k in m:
            assert k not in FORBIDDEN_KEYS, "forbidden key %r in %r" % (k, m)
            if isinstance(m[k], str):
                assert SECRET_SENTINEL not in m[k], m
                assert "Traceback" not in m[k], m
        if m.get("type") == "file-error":
            assert m.get("failureCategory") == "local_io", m
            assert isinstance(m.get("reason"), str) and m["reason"], m


# ---------------------------------------------------------------------------
# Plan examples + core happy paths
# ---------------------------------------------------------------------------

def test_commit_atomically_promotes_part(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda m: sent.append(dict(m)))
    mc.handle_file_open({
        "jobId": "j", "attemptToken": "a1",
        "requestedFilename": "out.mp4", "dir": str(tmp_path),
    })
    opened = [m for m in sent if m.get("type") == "file-opened"][0]
    sink = opened["sinkId"]
    data = b"hello-video"
    mc.handle_file_chunk({
        "sinkId": sink, "jobId": "j", "attemptToken": "a1", "seq": 0,
        "dataB64": _b64(data), "length": len(data),
    })
    mc.handle_file_commit({"sinkId": sink, "jobId": "j", "attemptToken": "a1"})
    committed = [m for m in sent if m.get("type") == "file-committed"]
    assert committed, sent
    assert committed[0]["sinkId"] == sink
    assert committed[0]["bytes"] == len(data)
    assert committed[0]["file"] == str(tmp_path / "out.mp4")
    assert (tmp_path / "out.mp4").read_bytes() == data
    assert not (tmp_path / "out.mp4.part").exists()
    _assert_frames_safe(sent)


def test_abort_removes_partial(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda m: sent.append(dict(m)))
    mc.handle_file_open({
        "jobId": "j2", "attemptToken": "a1",
        "requestedFilename": "partial.mp4", "dir": str(tmp_path),
    })
    sink = [m for m in sent if m.get("type") == "file-opened"][0]["sinkId"]
    data = b"partial-bytes"
    mc.handle_file_chunk({
        "sinkId": sink, "jobId": "j2", "attemptToken": "a1", "seq": 0,
        "dataB64": _b64(data), "length": len(data),
    })
    part = tmp_path / "partial.mp4.part"
    assert wait_for(lambda: part.exists(), timeout=2)
    mc.handle_file_abort({"sinkId": sink, "jobId": "j2", "attemptToken": "a1"})
    assert any(m.get("type") == "file-aborted" for m in sent)
    assert not part.exists()
    assert not (tmp_path / "partial.mp4").exists()
    _assert_frames_safe(sent)


def test_stale_attempt_token_cannot_commit(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda m: sent.append(dict(m)))
    mc.handle_file_open({
        "jobId": "j3", "attemptToken": "gen-1",
        "requestedFilename": "x.mp4", "dir": str(tmp_path),
    })
    sink = [m for m in sent if m.get("type") == "file-opened"][0]["sinkId"]
    mc.handle_file_chunk({
        "sinkId": sink, "jobId": "j3", "attemptToken": "gen-1", "seq": 0,
        "dataB64": _b64(b"abc"), "length": 3,
    })
    mc.handle_file_commit({
        "sinkId": sink, "jobId": "j3", "attemptToken": "stale-gen",
    })
    assert not any(m.get("type") == "file-committed" for m in sent)
    err = [m for m in sent if m.get("type") in ("file-error", "file-rejected")]
    assert err, "stale token must produce an error/reject frame"
    assert err[-1].get("failureCategory") == "local_io" or err[-1].get("reason") == "stale-attempt"
    assert not (tmp_path / "x.mp4").exists()
    # Live sink still has its partial; correct token can still finish.
    part = tmp_path / "x.mp4.part"
    assert part.exists()
    before = part.read_bytes()
    n_before = len(sent)
    mc.handle_file_commit({
        "sinkId": sink, "jobId": "j3", "attemptToken": "gen-1",
    })
    assert any(m.get("type") == "file-committed" for m in sent[n_before:])
    assert (tmp_path / "x.mp4").read_bytes() == before
    assert not part.exists()


def test_path_rejection_is_local_io_not_fallback(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda m: sent.append(dict(m)))
    bad_dir = tmp_path / "not-a-dir"
    bad_dir.write_text("x", encoding="utf-8")
    mc.handle_file_open({
        "jobId": "j4", "attemptToken": "a1",
        "requestedFilename": "out.mp4", "dir": str(bad_dir),
    })
    assert any(m.get("type") in ("file-error", "file-rejected") for m in sent)
    bad = [m for m in sent if m.get("type") in ("file-error", "file-rejected")][-1]
    assert bad.get("failureCategory") == "local_io"
    assert not any(m.get("type") == "pget-fallback" for m in sent)
    assert not any(m.get("type") == "file-opened" for m in sent)
    _assert_frames_safe(sent)


# ---------------------------------------------------------------------------
# Stale token isolation (chunk / abort / cannot disturb)
# ---------------------------------------------------------------------------

def test_stale_token_cannot_chunk_or_abort_live_sink_still_works(tmp_path, monkeypatch):
    sent = []
    opened = _open(tmp_path, monkeypatch, sent, job="js", token="live", name="s.mp4")
    sink = opened["sinkId"]
    part = tmp_path / "s.mp4.part"
    assert part.exists()
    size0 = part.stat().st_size

    mc.handle_file_chunk({
        "sinkId": sink, "jobId": "js", "attemptToken": "stale",
        "seq": 0, "dataB64": _b64(b"XXX"), "length": 3,
    })
    mc.handle_file_abort({
        "sinkId": sink, "jobId": "js", "attemptToken": "stale",
    })
    assert part.exists()
    assert part.stat().st_size == size0
    assert not any(m.get("type") == "file-aborted" for m in sent)
    assert not (tmp_path / "s.mp4").exists()
    stale_errs = [m for m in _errors(sent) if m.get("reason") == "stale-attempt"]
    assert len(stale_errs) >= 2

    # Correct token can still abort cleanly.
    mc.handle_file_abort({
        "sinkId": sink, "jobId": "js", "attemptToken": "live",
    })
    assert any(m.get("type") == "file-aborted" for m in sent)
    assert not part.exists()
    assert not (tmp_path / "s.mp4").exists()


# ---------------------------------------------------------------------------
# Open validation
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("name", [
    "../escape.mp4",
    "..\\escape.mp4",
    "a/b.mp4",
    "a\\b.mp4",
    "/abs.mp4",
    "C:\\abs.mp4",
    ".",
    "..",
    "",
    "   ",
    "bad:name.mp4",
    "bad*name.mp4",
    "bad?name.mp4",
    "bad|name.mp4",
    "bad<name.mp4",
    'bad"name.mp4',
    "ends-with-space.mp4 ",
    "ends-with-dot.mp4.",
    "\x00null.mp4",
])
def test_unsafe_filename_rejected(tmp_path, monkeypatch, name):
    sent = []
    monkeypatch.setattr(mc, "send", lambda m: sent.append(dict(m)))
    mc.handle_file_open({
        "jobId": "ju", "attemptToken": "a1",
        "requestedFilename": name, "dir": str(tmp_path),
    })
    assert not any(m.get("type") == "file-opened" for m in sent), sent
    err = _errors(sent)
    assert err and err[-1]["failureCategory"] == "local_io"
    assert not any(p.suffix == ".part" for p in tmp_path.iterdir())
    assert not any(m.get("type") == "pget-fallback" for m in sent)


@pytest.mark.parametrize("job,token,name", [
    (None, "a", "f.mp4"),
    ("", "a", "f.mp4"),
    ("  ", "a", "f.mp4"),
    ("j", None, "f.mp4"),
    ("j", "", "f.mp4"),
    ("j", "  ", "f.mp4"),
    ("j", "a", None),
    (1, "a", "f.mp4"),
    ("j", True, "f.mp4"),
    ("j", "a", 12),
])
def test_invalid_identity_on_open_rejected(tmp_path, monkeypatch, job, token, name):
    sent = []
    monkeypatch.setattr(mc, "send", lambda m: sent.append(dict(m)))
    req = {"dir": str(tmp_path)}
    if job is not None or "job" in ("job",):
        req["jobId"] = job
    if token is not None:
        req["attemptToken"] = token
    if name is not None:
        req["requestedFilename"] = name
    # Explicitly set even when None to exercise missing/invalid.
    req["jobId"] = job
    req["attemptToken"] = token
    req["requestedFilename"] = name
    mc.handle_file_open(req)
    assert not any(m.get("type") == "file-opened" for m in sent)
    assert _errors(sent)[-1]["failureCategory"] == "local_io"


def test_relative_dir_rejected(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda m: sent.append(dict(m)))
    mc.handle_file_open({
        "jobId": "jr", "attemptToken": "a1",
        "requestedFilename": "ok.mp4", "dir": "relative-not-abs",
    })
    assert not any(m.get("type") == "file-opened" for m in sent)
    assert _errors(sent)[-1]["failureCategory"] == "local_io"


def test_blank_dir_string_rejected(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda m: sent.append(dict(m)))
    mc.handle_file_open({
        "jobId": "jb", "attemptToken": "a1",
        "requestedFilename": "ok.mp4", "dir": "   ",
    })
    assert not any(m.get("type") == "file-opened" for m in sent)
    assert _errors(sent)[-1]["failureCategory"] == "local_io"


def test_omitted_dir_uses_downloads(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda m: sent.append(dict(m)))
    monkeypatch.setattr(mc, "downloads_dir", lambda: str(tmp_path))
    mc.handle_file_open({
        "jobId": "jd", "attemptToken": "a1",
        "requestedFilename": "dl.mp4",
    })
    opened = [m for m in sent if m.get("type") == "file-opened"]
    assert opened, sent
    sink = opened[0]["sinkId"]
    data = b"via-downloads"
    mc.handle_file_chunk({
        "sinkId": sink, "jobId": "jd", "attemptToken": "a1", "seq": 0,
        "dataB64": _b64(data), "length": len(data),
    })
    mc.handle_file_commit({"sinkId": sink, "jobId": "jd", "attemptToken": "a1"})
    assert (tmp_path / "dl.mp4").read_bytes() == data


def test_null_dir_uses_downloads(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda m: sent.append(dict(m)))
    monkeypatch.setattr(mc, "downloads_dir", lambda: str(tmp_path))
    mc.handle_file_open({
        "jobId": "jn", "attemptToken": "a1",
        "requestedFilename": "n.mp4", "dir": None,
    })
    assert any(m.get("type") == "file-opened" for m in sent)


def test_filename_preserved_exactly(tmp_path, monkeypatch):
    sent = []
    name = "11238-makemebi.net.mp4"
    opened = _open(tmp_path, monkeypatch, sent, name=name)
    sink = opened["sinkId"]
    data = b"x"
    mc.handle_file_chunk({
        "sinkId": sink, "jobId": "j", "attemptToken": "a1", "seq": 0,
        "dataB64": _b64(data), "length": 1,
    })
    mc.handle_file_commit({"sinkId": sink, "jobId": "j", "attemptToken": "a1"})
    committed = [m for m in sent if m.get("type") == "file-committed"][0]
    assert committed["file"].endswith(name)
    assert (tmp_path / name).exists()


def test_second_open_same_part_rejected(tmp_path, monkeypatch):
    sent = []
    o1 = _open(tmp_path, monkeypatch, sent, job="jA", token="t1", name="same.mp4")
    assert o1
    n = len(sent)
    mc.handle_file_open({
        "jobId": "jB", "attemptToken": "t2",
        "requestedFilename": "same.mp4", "dir": str(tmp_path),
    })
    assert not any(m.get("type") == "file-opened" for m in sent[n:])
    assert _errors(sent[n:])[-1]["failureCategory"] == "local_io"
    # First sink still alive
    assert (tmp_path / "same.mp4.part").exists()


def test_second_open_same_job_attempt_rejected(tmp_path, monkeypatch):
    sent = []
    o1 = _open(tmp_path, monkeypatch, sent, job="sameJ", token="sameT", name="a.mp4")
    assert o1
    n = len(sent)
    mc.handle_file_open({
        "jobId": "sameJ", "attemptToken": "sameT",
        "requestedFilename": "b.mp4", "dir": str(tmp_path),
    })
    assert not any(m.get("type") == "file-opened" for m in sent[n:])
    assert _errors(sent[n:])[-1]["failureCategory"] == "local_io"


# ---------------------------------------------------------------------------
# Chunk validation
# ---------------------------------------------------------------------------

def test_invalid_base64_rejected_no_append(tmp_path, monkeypatch):
    sent = []
    opened = _open(tmp_path, monkeypatch, sent, job="jb64", name="b64.mp4")
    sink = opened["sinkId"]
    part = tmp_path / "b64.mp4.part"
    size0 = part.stat().st_size
    mc.handle_file_chunk({
        "sinkId": sink, "jobId": "jb64", "attemptToken": "a1", "seq": 0,
        "dataB64": "!!!not-base64!!!", "length": 3,
    })
    assert part.stat().st_size == size0
    assert _errors(sent)[-1]["failureCategory"] == "local_io"
    # Correct seq still accepted after reject (reject does not consume seq).
    mc.handle_file_chunk({
        "sinkId": sink, "jobId": "jb64", "attemptToken": "a1", "seq": 0,
        "dataB64": _b64(b"ok"), "length": 2,
    })
    assert any(m.get("type") == "file-chunk-ack" and m.get("seq") == 0 for m in sent)


def test_length_mismatch_rejected(tmp_path, monkeypatch):
    sent = []
    opened = _open(tmp_path, monkeypatch, sent, job="jl", name="len.mp4")
    sink = opened["sinkId"]
    part = tmp_path / "len.mp4.part"
    size0 = part.stat().st_size
    data = b"abcd"
    mc.handle_file_chunk({
        "sinkId": sink, "jobId": "jl", "attemptToken": "a1", "seq": 0,
        "dataB64": _b64(data), "length": 99,
    })
    assert part.stat().st_size == size0
    assert _errors(sent)[-1]["failureCategory"] == "local_io"


def test_bool_length_rejected(tmp_path, monkeypatch):
    sent = []
    opened = _open(tmp_path, monkeypatch, sent, job="jbl", name="bl.mp4")
    sink = opened["sinkId"]
    mc.handle_file_chunk({
        "sinkId": sink, "jobId": "jbl", "attemptToken": "a1", "seq": 0,
        "dataB64": _b64(b""), "length": False,
    })
    assert _errors(sent)[-1]["failureCategory"] == "local_io"
    assert (tmp_path / "bl.mp4.part").stat().st_size == 0


def test_oversized_chunk_rejected(tmp_path, monkeypatch):
    sent = []
    opened = _open(tmp_path, monkeypatch, sent, job="jo", name="big.mp4")
    sink = opened["sinkId"]
    import mchost.filesink as fs
    cap = getattr(fs, "MAX_CHUNK_BYTES", 512 * 1024)
    data = b"Z" * (cap + 1)
    mc.handle_file_chunk({
        "sinkId": sink, "jobId": "jo", "attemptToken": "a1", "seq": 0,
        "dataB64": _b64(data), "length": len(data),
    })
    assert (tmp_path / "big.mp4.part").stat().st_size == 0
    assert _errors(sent)[-1]["failureCategory"] == "local_io"


@pytest.mark.parametrize("seq", [True, False, 1.5, "0", None, -1])
def test_invalid_seq_rejected(tmp_path, monkeypatch, seq):
    sent = []
    opened = _open(tmp_path, monkeypatch, sent, job="jsq", name="sq.mp4")
    sink = opened["sinkId"]
    mc.handle_file_chunk({
        "sinkId": sink, "jobId": "jsq", "attemptToken": "a1", "seq": seq,
        "dataB64": _b64(b"a"), "length": 1,
    })
    assert (tmp_path / "sq.mp4.part").stat().st_size == 0
    assert _errors(sent)[-1]["failureCategory"] == "local_io"


def test_out_of_order_and_duplicate_seq_rejected(tmp_path, monkeypatch):
    sent = []
    opened = _open(tmp_path, monkeypatch, sent, job="joo", name="oo.mp4")
    sink = opened["sinkId"]
    mc.handle_file_chunk({
        "sinkId": sink, "jobId": "joo", "attemptToken": "a1", "seq": 0,
        "dataB64": _b64(b"A"), "length": 1,
    })
    # Out of order
    n = len(sent)
    mc.handle_file_chunk({
        "sinkId": sink, "jobId": "joo", "attemptToken": "a1", "seq": 2,
        "dataB64": _b64(b"C"), "length": 1,
    })
    assert _errors(sent[n:])[-1]["failureCategory"] == "local_io"
    # Duplicate
    n = len(sent)
    mc.handle_file_chunk({
        "sinkId": sink, "jobId": "joo", "attemptToken": "a1", "seq": 0,
        "dataB64": _b64(b"X"), "length": 1,
    })
    assert _errors(sent[n:])[-1]["failureCategory"] == "local_io"
    # Correct next still works
    mc.handle_file_chunk({
        "sinkId": sink, "jobId": "joo", "attemptToken": "a1", "seq": 1,
        "dataB64": _b64(b"B"), "length": 1,
    })
    mc.handle_file_commit({
        "sinkId": sink, "jobId": "joo", "attemptToken": "a1",
    })
    assert (tmp_path / "oo.mp4").read_bytes() == b"AB"


def test_filename_and_dir_mutation_after_open_rejected(tmp_path, monkeypatch):
    sent = []
    opened = _open(tmp_path, monkeypatch, sent, job="jm", name="mut.mp4")
    sink = opened["sinkId"]
    part = tmp_path / "mut.mp4.part"
    size0 = part.stat().st_size
    # Chunk with mutated filename
    mc.handle_file_chunk({
        "sinkId": sink, "jobId": "jm", "attemptToken": "a1", "seq": 0,
        "dataB64": _b64(b"A"), "length": 1,
        "requestedFilename": "other.mp4",
    })
    assert part.stat().st_size == size0
    assert _errors(sent)[-1]["failureCategory"] == "local_io"
    # Chunk with mutated dir
    mc.handle_file_chunk({
        "sinkId": sink, "jobId": "jm", "attemptToken": "a1", "seq": 0,
        "dataB64": _b64(b"A"), "length": 1,
        "dir": str(tmp_path / "other"),
    })
    assert part.stat().st_size == size0
    # Commit with mutated filename
    mc.handle_file_commit({
        "sinkId": sink, "jobId": "jm", "attemptToken": "a1",
        "requestedFilename": "hijack.mp4",
    })
    assert not any(m.get("type") == "file-committed" for m in sent)
    # Valid path still works
    mc.handle_file_chunk({
        "sinkId": sink, "jobId": "jm", "attemptToken": "a1", "seq": 0,
        "dataB64": _b64(b"A"), "length": 1,
    })
    mc.handle_file_commit({
        "sinkId": sink, "jobId": "jm", "attemptToken": "a1",
    })
    assert (tmp_path / "mut.mp4").read_bytes() == b"A"
    assert not (tmp_path / "hijack.mp4").exists()


# ---------------------------------------------------------------------------
# MAX_UNACKED = 4 concurrent enforcement
# ---------------------------------------------------------------------------

def test_max_four_unacked_enforced_with_blocked_ack(tmp_path, monkeypatch):
    """Fifth chunk is rejected while four acks are blocked in send.

    Chunks are admitted in seq order (monotonic contract) but each handler
    blocks inside send after write so unacked stays elevated. No bare sleeps:
    Events + deadlines only.
    """
    import mchost.filesink as fs

    sent = []
    sent_lock = threading.Lock()
    release_acks = threading.Event()
    ack_entered = []
    ack_entered_cv = threading.Condition()

    def blocking_send(m):
        m = dict(m)
        if m.get("type") == "file-chunk-ack":
            with ack_entered_cv:
                ack_entered.append(m.get("seq"))
                ack_entered_cv.notify_all()
            assert release_acks.wait(timeout=5), "ack release timed out"
        with sent_lock:
            sent.append(m)

    monkeypatch.setattr(mc, "send", blocking_send)
    mc.handle_file_open({
        "jobId": "jw", "attemptToken": "a1",
        "requestedFilename": "win.mp4", "dir": str(tmp_path),
    })
    assert wait_for(lambda: any(m.get("type") == "file-opened" for m in list(sent)), timeout=2)
    sink = [m for m in list(sent) if m.get("type") == "file-opened"][0]["sinkId"]

    errors = []
    threads = []

    def do_chunk(seq):
        try:
            mc.handle_file_chunk({
                "sinkId": sink, "jobId": "jw", "attemptToken": "a1",
                "seq": seq,
                "dataB64": _b64(bytes([seq])), "length": 1,
            })
        except Exception as e:
            errors.append(e)

    def wait_ack_count(n, timeout=5):
        deadline = time.monotonic() + timeout
        with ack_entered_cv:
            while len(ack_entered) < n:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return len(ack_entered)
                ack_entered_cv.wait(timeout=remaining)
            return len(ack_entered)

    # Launch each seq only after the previous has entered blocking send so
    # monotonic seq is preserved while all four remain unacked.
    for seq in range(4):
        t = threading.Thread(target=do_chunk, args=(seq,), daemon=True)
        threads.append(t)
        t.start()
        assert wait_ack_count(seq + 1) == seq + 1, ack_entered

    # All four blocked in send → unacked == 4. Fifth must reject promptly.
    fifth_done = threading.Event()
    fifth_err = []

    def do_fifth():
        try:
            mc.handle_file_chunk({
                "sinkId": sink, "jobId": "jw", "attemptToken": "a1",
                "seq": 4,
                "dataB64": _b64(b"X"), "length": 1,
            })
        except Exception as e:
            fifth_err.append(e)
        finally:
            fifth_done.set()

    t5 = threading.Thread(target=do_fifth, daemon=True)
    t5.start()
    assert fifth_done.wait(timeout=3), "fifth chunk did not return"
    assert not fifth_err

    with sent_lock:
        snap = list(sent)
    assert any(
        m.get("type") == "file-error" and m.get("failureCategory") == "local_io"
        for m in snap
    ), snap
    # Window reject must not advance seq or append bytes.
    assert not any(m.get("type") == "file-chunk-ack" and m.get("seq") == 4 for m in snap)

    release_acks.set()
    for t in threads:
        t.join(timeout=3)
    t5.join(timeout=1)
    assert not errors

    with sent_lock:
        sent.clear()
    monkeypatch.setattr(mc, "send", lambda m: sent.append(dict(m)))
    mc.handle_file_chunk({
        "sinkId": sink, "jobId": "jw", "attemptToken": "a1",
        "seq": 4,
        "dataB64": _b64(b"Y"), "length": 1,
    })
    assert any(m.get("type") == "file-chunk-ack" and m.get("seq") == 4 for m in sent)

    mc.handle_file_commit({
        "sinkId": sink, "jobId": "jw", "attemptToken": "a1",
    })
    body = (tmp_path / "win.mp4").read_bytes()
    assert body == bytes([0, 1, 2, 3]) + b"Y"
    assert fs.MAX_UNACKED == 4


# ---------------------------------------------------------------------------
# Terminal races / duplicate terminals
# ---------------------------------------------------------------------------

def test_duplicate_commit_single_success(tmp_path, monkeypatch):
    sent = []
    opened = _open(tmp_path, monkeypatch, sent, job="jdc", name="dc.mp4")
    sink = opened["sinkId"]
    mc.handle_file_chunk({
        "sinkId": sink, "jobId": "jdc", "attemptToken": "a1", "seq": 0,
        "dataB64": _b64(b"data"), "length": 4,
    })
    mc.handle_file_commit({"sinkId": sink, "jobId": "jdc", "attemptToken": "a1"})
    mc.handle_file_commit({"sinkId": sink, "jobId": "jdc", "attemptToken": "a1"})
    committed = [m for m in sent if m.get("type") == "file-committed"]
    assert len(committed) == 1
    assert (tmp_path / "dc.mp4").read_bytes() == b"data"
    assert not (tmp_path / "dc.mp4.part").exists()
    # Second is error, not success.
    assert any(m.get("type") == "file-error" for m in sent)


def test_duplicate_abort_single_success(tmp_path, monkeypatch):
    sent = []
    opened = _open(tmp_path, monkeypatch, sent, job="jda", name="da.mp4")
    sink = opened["sinkId"]
    mc.handle_file_chunk({
        "sinkId": sink, "jobId": "jda", "attemptToken": "a1", "seq": 0,
        "dataB64": _b64(b"x"), "length": 1,
    })
    mc.handle_file_abort({"sinkId": sink, "jobId": "jda", "attemptToken": "a1"})
    mc.handle_file_abort({"sinkId": sink, "jobId": "jda", "attemptToken": "a1"})
    aborted = [m for m in sent if m.get("type") == "file-aborted"]
    assert len(aborted) == 1
    assert not (tmp_path / "da.mp4").exists()
    assert not (tmp_path / "da.mp4.part").exists()


def test_commit_vs_abort_race_one_success_no_partial(tmp_path, monkeypatch):
    sent = []
    sent_lock = threading.Lock()

    def safe_send(m):
        with sent_lock:
            sent.append(dict(m))

    monkeypatch.setattr(mc, "send", safe_send)
    mc.handle_file_open({
        "jobId": "jrace", "attemptToken": "a1",
        "requestedFilename": "race.mp4", "dir": str(tmp_path),
    })
    sink = [m for m in sent if m.get("type") == "file-opened"][0]["sinkId"]
    mc.handle_file_chunk({
        "sinkId": sink, "jobId": "jrace", "attemptToken": "a1", "seq": 0,
        "dataB64": _b64(b"race-bytes"), "length": 10,
    })

    barrier = threading.Barrier(2, timeout=5)

    def do_commit():
        barrier.wait()
        mc.handle_file_commit({
            "sinkId": sink, "jobId": "jrace", "attemptToken": "a1",
        })

    def do_abort():
        barrier.wait()
        mc.handle_file_abort({
            "sinkId": sink, "jobId": "jrace", "attemptToken": "a1",
        })

    t1 = threading.Thread(target=do_commit, daemon=True)
    t2 = threading.Thread(target=do_abort, daemon=True)
    t1.start()
    t2.start()
    t1.join(timeout=5)
    t2.join(timeout=5)

    with sent_lock:
        snap = list(sent)
    successes = [
        m for m in snap
        if m.get("type") in ("file-committed", "file-aborted")
    ]
    assert len(successes) == 1, snap
    assert not (tmp_path / "race.mp4.part").exists()
    # Either committed final exists, or abort left nothing.
    if successes[0]["type"] == "file-committed":
        assert (tmp_path / "race.mp4").exists()
    else:
        assert not (tmp_path / "race.mp4").exists()


def test_late_chunk_after_commit_rejected(tmp_path, monkeypatch):
    sent = []
    opened = _open(tmp_path, monkeypatch, sent, job="jlate", name="late.mp4")
    sink = opened["sinkId"]
    mc.handle_file_chunk({
        "sinkId": sink, "jobId": "jlate", "attemptToken": "a1", "seq": 0,
        "dataB64": _b64(b"A"), "length": 1,
    })
    mc.handle_file_commit({
        "sinkId": sink, "jobId": "jlate", "attemptToken": "a1",
    })
    n = len(sent)
    mc.handle_file_chunk({
        "sinkId": sink, "jobId": "jlate", "attemptToken": "a1", "seq": 1,
        "dataB64": _b64(b"B"), "length": 1,
    })
    assert not any(m.get("type") == "file-chunk-ack" for m in sent[n:])
    assert _errors(sent[n:])[-1]["failureCategory"] == "local_io"
    assert (tmp_path / "late.mp4").read_bytes() == b"A"


def test_unknown_sink_rejected(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda m: sent.append(dict(m)))
    mc.handle_file_chunk({
        "sinkId": "no-such-sink", "jobId": "j", "attemptToken": "a1",
        "seq": 0, "dataB64": _b64(b"x"), "length": 1,
    })
    mc.handle_file_commit({
        "sinkId": "no-such-sink", "jobId": "j", "attemptToken": "a1",
    })
    mc.handle_file_abort({
        "sinkId": "no-such-sink", "jobId": "j", "attemptToken": "a1",
    })
    assert all(m.get("type") == "file-error" for m in sent)
    assert all(m.get("failureCategory") == "local_io" for m in sent)
    assert not any(m.get("type") in ("file-committed", "file-aborted") for m in sent)


# ---------------------------------------------------------------------------
# Write / replace failures
# ---------------------------------------------------------------------------

def test_write_failure_cleans_up_local_io_no_fallback(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda m: sent.append(dict(m)))
    import mchost.filesink as fs

    mc.handle_file_open({
        "jobId": "jwf", "attemptToken": "a1",
        "requestedFilename": "wf.mp4", "dir": str(tmp_path),
    })
    sink = [m for m in sent if m.get("type") == "file-opened"][0]["sinkId"]

    # Close the real handle and replace with one that fails on write.
    with fs._LOCK:
        s = fs._SINKS[sink]
    real = s.handle

    class Boom:
        def write(self, data):
            raise OSError(errno.EIO, "disk failed")

        def flush(self):
            pass

        def fileno(self):
            return real.fileno()

        def close(self):
            try:
                real.close()
            except Exception:
                pass

    with s.lock:
        s.handle = Boom()

    n = len(sent)
    mc.handle_file_chunk({
        "sinkId": sink, "jobId": "jwf", "attemptToken": "a1", "seq": 0,
        "dataB64": _b64(b"fail"), "length": 4,
    })
    errs = [m for m in sent[n:] if m.get("type") == "file-error"]
    assert errs and errs[-1]["failureCategory"] == "local_io"
    assert not any(m.get("type") == "pget-fallback" for m in sent)
    assert not (tmp_path / "wf.mp4").exists()
    # Partial removed when possible
    assert not (tmp_path / "wf.mp4.part").exists()
    # Further ops rejected (terminal)
    n = len(sent)
    mc.handle_file_commit({
        "sinkId": sink, "jobId": "jwf", "attemptToken": "a1",
    })
    assert not any(m.get("type") == "file-committed" for m in sent[n:])


def test_replace_failure_cleans_up_local_io_no_fallback(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda m: sent.append(dict(m)))
    import mchost.filesink as fs

    mc.handle_file_open({
        "jobId": "jrf", "attemptToken": "a1",
        "requestedFilename": "rf.mp4", "dir": str(tmp_path),
    })
    sink = [m for m in sent if m.get("type") == "file-opened"][0]["sinkId"]
    mc.handle_file_chunk({
        "sinkId": sink, "jobId": "jrf", "attemptToken": "a1", "seq": 0,
        "dataB64": _b64(b"body"), "length": 4,
    })

    def bad_replace(*_a, **_k):
        raise OSError(errno.EACCES, "replace denied")

    monkeypatch.setattr(fs.os, "replace", bad_replace)
    n = len(sent)
    mc.handle_file_commit({
        "sinkId": sink, "jobId": "jrf", "attemptToken": "a1",
    })
    errs = [m for m in sent[n:] if m.get("type") == "file-error"]
    assert errs and errs[-1]["failureCategory"] == "local_io"
    assert not any(m.get("type") == "file-committed" for m in sent)
    assert not any(m.get("type") == "pget-fallback" for m in sent)
    assert not (tmp_path / "rf.mp4").exists()
    assert not (tmp_path / "rf.mp4.part").exists()


# ---------------------------------------------------------------------------
# Dispatcher / re-export identity
# ---------------------------------------------------------------------------

def test_mc_host_dispatch_and_reexports_file_sink():
    import mchost.filesink as fs

    assert mc.handle_file_open is fs.handle_file_open
    assert mc.handle_file_chunk is fs.handle_file_chunk
    assert mc.handle_file_commit is fs.handle_file_commit
    assert mc.handle_file_abort is fs.handle_file_abort

    src = inspect.getsource(mc.main)
    for cmd, handler in (
        ("file-open", "handle_file_open"),
        ("file-chunk", "handle_file_chunk"),
        ("file-commit", "handle_file_commit"),
        ("file-abort", "handle_file_abort"),
    ):
        assert 'cmd == "%s"' % cmd in src
        assert handler in src


# ---------------------------------------------------------------------------
# Allowlist / privacy
# ---------------------------------------------------------------------------

def test_emitted_frames_allowlisted_no_input_extras(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda m: sent.append(dict(m)))
    mc.handle_file_open({
        "jobId": "jpriv",
        "attemptToken": "a1",
        "requestedFilename": "p.mp4",
        "dir": str(tmp_path),
        "cookie": SECRET_SENTINEL,
        "url": "https://evil.example/signed?token=abc",
        "headers": {"Authorization": SECRET_SENTINEL},
        "secret": SECRET_SENTINEL,
        "extra": {"nested": SECRET_SENTINEL},
    })
    sink = [m for m in sent if m.get("type") == "file-opened"][0]["sinkId"]
    mc.handle_file_chunk({
        "sinkId": sink, "jobId": "jpriv", "attemptToken": "a1", "seq": 0,
        "dataB64": _b64(b"z"), "length": 1,
        "cookie": SECRET_SENTINEL,
        "url": "https://evil.example/x",
    })
    mc.handle_file_commit({
        "sinkId": sink, "jobId": "jpriv", "attemptToken": "a1",
        "secret": SECRET_SENTINEL,
    })
    _assert_frames_safe(sent)
    # Opened frame shape
    opened = [m for m in sent if m.get("type") == "file-opened"][0]
    assert set(opened.keys()) <= {"type", "sinkId", "jobId", "attemptToken"}
    committed = [m for m in sent if m.get("type") == "file-committed"][0]
    assert set(committed.keys()) <= {"type", "sinkId", "file", "bytes"}


def test_multi_chunk_byte_count(tmp_path, monkeypatch):
    sent = []
    opened = _open(tmp_path, monkeypatch, sent, job="jmc", name="mc.mp4")
    sink = opened["sinkId"]
    parts = [b"one-", b"two-", b"three"]
    for i, p in enumerate(parts):
        mc.handle_file_chunk({
            "sinkId": sink, "jobId": "jmc", "attemptToken": "a1",
            "seq": i, "dataB64": _b64(p), "length": len(p),
        })
    mc.handle_file_commit({
        "sinkId": sink, "jobId": "jmc", "attemptToken": "a1",
    })
    body = b"".join(parts)
    committed = [m for m in sent if m.get("type") == "file-committed"][0]
    assert committed["bytes"] == len(body)
    assert (tmp_path / "mc.mp4").read_bytes() == body


def test_job_mismatch_does_not_disturb_sink(tmp_path, monkeypatch):
    sent = []
    opened = _open(tmp_path, monkeypatch, sent, job="jreal", token="tok", name="m.mp4")
    sink = opened["sinkId"]
    mc.handle_file_chunk({
        "sinkId": sink, "jobId": "jother", "attemptToken": "tok",
        "seq": 0, "dataB64": _b64(b"X"), "length": 1,
    })
    assert (tmp_path / "m.mp4.part").stat().st_size == 0
    assert _errors(sent)[-1]["failureCategory"] == "local_io"
    mc.handle_file_chunk({
        "sinkId": sink, "jobId": "jreal", "attemptToken": "tok",
        "seq": 0, "dataB64": _b64(b"Y"), "length": 1,
    })
    mc.handle_file_commit({
        "sinkId": sink, "jobId": "jreal", "attemptToken": "tok",
    })
    assert (tmp_path / "m.mp4").read_bytes() == b"Y"


def test_empty_chunk_allowed(tmp_path, monkeypatch):
    sent = []
    opened = _open(tmp_path, monkeypatch, sent, job="jemp", name="e.mp4")
    sink = opened["sinkId"]
    mc.handle_file_chunk({
        "sinkId": sink, "jobId": "jemp", "attemptToken": "a1", "seq": 0,
        "dataB64": _b64(b""), "length": 0,
    })
    assert any(m.get("type") == "file-chunk-ack" and m.get("seq") == 0 for m in sent)
    mc.handle_file_commit({
        "sinkId": sink, "jobId": "jemp", "attemptToken": "a1",
    })
    assert (tmp_path / "e.mp4").read_bytes() == b""
    committed = [m for m in sent if m.get("type") == "file-committed"][0]
    assert committed["bytes"] == 0
