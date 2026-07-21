"""Offline tests for mc_host.py: wire-protocol framing + ffmpeg command building.
Does not require a real stream. Run:  python -m pytest test_host.py -q
(or directly:  py test_host.py)"""
import json
import os
import struct
import subprocess
import sys

from conftest import HERE, HOST, load_host, wait_for

mc_host = load_host()


def _join_cast_worker(done, timeout=2.0):
    """Join a handle_cast worker thread by polling `done()` against a deadline
    (the worker replies through a monkeypatched send) — never a bare sleep."""
    assert wait_for(done, timeout=timeout), \
        "cast worker did not finish within %ss" % timeout


# ---- Test A: native-messaging framing (spawn the host, ping -> pong) ----
def read_reply(p, max_frames=10):
    """Read the next NON-LOG frame. The host legitimately interleaves
    {"type":"log"} frames (startup banner, async yt-dlp probe) with replies."""
    for _ in range(max_frames):
        raw = p.stdout.read(4)
        if len(raw) < 4:
            return None
        (n,) = struct.unpack("@I", raw)
        frame = json.loads(p.stdout.read(n).decode())
        if frame.get("type") != "log":
            return frame
    return None


def test_framing_ping_snapshot_reveal():
    p = subprocess.Popen([sys.executable, HOST], stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        msg = json.dumps({"cmd": "ping"}).encode()
        p.stdin.write(struct.pack("@I", len(msg)) + msg)
        p.stdin.flush()
        reply = read_reply(p)
        assert reply is not None, "host replied to ping"
        assert reply.get("type") == "pong", "reply is a pong"
        assert isinstance(reply.get("ffmpeg"), bool), "pong reports ffmpeg presence (bool)"
        assert reply.get("version"), "pong carries a version"

        # snapshot for an unknown recording -> graceful error (dispatch works)
        snap = json.dumps({"cmd": "snapshot", "id": 999}).encode()
        p.stdin.write(struct.pack("@I", len(snap)) + snap); p.stdin.flush()
        r2 = read_reply(p)
        assert r2 is not None and r2.get("type") == "error" and r2.get("id") == 999, \
            "snapshot of unknown id returns an error"

        # reveal dispatch is wired (missing file -> error echoing our id).
        # Would hang/fail if the main-loop elif for "reveal" were absent.
        rev = json.dumps({"cmd": "reveal", "path": os.path.join(HERE, "no-such-file.mp4"),
                          "id": 7}).encode()
        p.stdin.write(struct.pack("@I", len(rev)) + rev); p.stdin.flush()
        r3 = read_reply(p)
        assert r3 is not None and r3.get("type") == "error" and r3.get("id") == 7, \
            "reveal of missing file errors over the wire"
    finally:
        try:
            p.stdin.close()
        except Exception:
            pass
        p.wait(timeout=5)


# ---- Test B: ffmpeg command construction ----
def test_ffmpeg_cmd_construction(monkeypatch):
    monkeypatch.setattr(mc_host, "FFMPEG", "ffmpeg")     # pretend it's present

    assert mc_host.sanitize('a/b:c*?.mp4') == "a_b_c_.mp4" or "_" in mc_host.sanitize('a/b:c'), \
        "sanitize strips path chars"

    job = mc_host.Job(7, os.path.join(mc_host.TMPDIR, "mc_7.mp4"))
    # video + audio
    cmd = mc_host.ffmpeg_cmd(job, {"videoUrl": "http://v/x.m3u8", "audioUrl": "http://a/y.m3u8",
                                   "referer": "http://page/", "userAgent": "UA"})
    assert "-c" in cmd and cmd[cmd.index("-c") + 1] == "copy", "uses copy codec"
    assert cmd.count("-i") == 2, "two inputs when audio present"
    assert "-map" in cmd and "0:v:0" in cmd and "1:a:0" in cmd, "maps video+audio"
    assert any(s == "-headers" for s in cmd) and \
        any("Referer: http://page/" in str(s) for s in cmd), "passes headers"
    assert any("frag_keyframe" in str(s) for s in cmd), "fragmented mp4 for interrupt safety"
    assert "pipe:1" in cmd, "progress on pipe:1"
    assert cmd[-1] == job.temp, "output is the temp file"

    # video only
    cmd1 = mc_host.ffmpeg_cmd(job, {"videoUrl": "http://v/x.m3u8"})
    assert cmd1.count("-i") == 1, "single input when no audio"
    assert "-map" not in cmd1, "no -map when single input"


# ---- Test C: reveal opens the CONTAINING FOLDER, not the file ----
def test_reveal_opens_containing_folder(monkeypatch, tmp_path):
    tmp = str(tmp_path / "clip.mp4")
    open(tmp, "w").close()

    calls = []

    def fake_popen(cmd, **kw):
        calls.append(cmd)
        return object()

    # mc_host.subprocess IS the global subprocess module — monkeypatch restores it.
    monkeypatch.setattr(mc_host.subprocess, "Popen", fake_popen)
    sent = []
    monkeypatch.setattr(mc_host, "send", sent.append)

    mc_host.handle_reveal({"path": tmp})
    if os.name == "nt":
        assert calls == ['explorer /select,"%s"' % tmp], \
            "reveal uses Explorer /select, on the file (exact command)"
    elif sys.platform == "darwin":
        assert calls == [["open", "-R", tmp]], "reveal uses open -R on the file"
    else:
        assert calls == [["xdg-open", os.path.dirname(tmp)]], \
            "reveal xdg-opens the containing dir"
    assert not sent, "reveal of existing file sends no error"

    calls.clear(); sent.clear()
    mc_host.handle_reveal({"path": tmp + ".nope", "id": 5})
    assert len(sent) == 1 and sent[0].get("type") == "error" and sent[0].get("id") == 5, \
        "reveal of missing file errors with the request id"
    assert not calls, "reveal of missing file spawns nothing"


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([os.path.abspath(__file__), "-q"]))
