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


# ---- Test D: warm cast discovery (cache-first reply + final rescan push) ----
def test_warm_discover_replies_from_cache_and_pushes_update(monkeypatch):
    sent = []
    monkeypatch.setattr(mc_host, "send", lambda m: sent.append(m))
    # seed the union cache with one device; the "rescan" will find two
    cached = [{"id": "dlna:192.0.2.10", "name": "TV-A", "protocol": "dlna",
               "address": "192.0.2.10"}]
    fresh = cached + [{"id": "AA:BB:CC:DD", "name": "ATV", "protocol": "airplay",
                       "address": "192.0.2.11"}]
    monkeypatch.setattr(mc_host, "_cast_seen_devices", lambda: list(cached))
    rescans = []
    monkeypatch.setattr(mc_host, "_cast_merged_discover",
                        lambda timeout=5: rescans.append(1) or list(fresh))
    mc_host.handle_cast({"sub": "discover", "reqId": "w1", "warm": True})
    _join_cast_worker(lambda: any(m.get("type") == "cast-devices-update" for m in sent))
    warm = [m for m in sent if m.get("type") == "cast-devices" and m.get("reqId") == "w1"]
    assert warm and warm[0]["devices"] == cached and warm[0].get("warm") is True
    push = [m for m in sent if m.get("type") == "cast-devices-update"]
    assert rescans and push and push[0]["devices"] == fresh
    assert push[0].get("final") is True


def test_warm_discover_final_update_arrives_even_when_unchanged(monkeypatch):
    # round-2 I1: final:true is the scan-complete signal — it ALWAYS follows the
    # rescan, changed or not, so the picker can clear its "Scanning…" row.
    sent = []
    monkeypatch.setattr(mc_host, "send", lambda m: sent.append(m))
    same = [{"id": "dlna:192.0.2.10", "name": "TV-A", "protocol": "dlna",
             "address": "192.0.2.10"}]
    monkeypatch.setattr(mc_host, "_cast_seen_devices", lambda: list(same))
    monkeypatch.setattr(mc_host, "_cast_merged_discover", lambda timeout=5: list(same))
    mc_host.handle_cast({"sub": "discover", "reqId": "w2", "warm": True})
    _join_cast_worker(lambda: any(m.get("type") == "cast-devices-update" for m in sent))
    push = [m for m in sent if m.get("type") == "cast-devices-update"]
    assert push and push[0]["devices"] == same and push[0].get("final") is True


def test_warm_discover_final_update_arrives_even_when_both_empty(monkeypatch):
    sent = []
    monkeypatch.setattr(mc_host, "send", lambda m: sent.append(m))
    monkeypatch.setattr(mc_host, "_cast_seen_devices", lambda: [])
    monkeypatch.setattr(mc_host, "_cast_merged_discover", lambda timeout=5: [])
    mc_host.handle_cast({"sub": "discover", "reqId": "w3", "warm": True})
    _join_cast_worker(lambda: any(m.get("type") == "cast-devices-update" for m in sent))
    warm = [m for m in sent if m.get("type") == "cast-devices" and m.get("reqId") == "w3"]
    assert warm and warm[0]["devices"] == [] and warm[0].get("warm") is True
    push = [m for m in sent if m.get("type") == "cast-devices-update"]
    assert push and push[0]["devices"] == [] and push[0].get("final") is True


def test_plain_discover_unchanged(monkeypatch):
    sent = []
    monkeypatch.setattr(mc_host, "send", lambda m: sent.append(m))
    monkeypatch.setattr(mc_host, "_cast_merged_discover", lambda timeout=5: [])
    mc_host.handle_cast({"sub": "discover", "reqId": "p1"})
    _join_cast_worker(lambda: any(m.get("type") == "cast-devices" for m in sent))
    assert [m for m in sent if m.get("type") == "cast-devices" and m.get("reqId") == "p1"
            and "warm" not in m]
    assert not [m for m in sent if m.get("type") == "cast-devices-update"]


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([os.path.abspath(__file__), "-q"]))


def test_warm_discover_final_arrives_even_when_rescan_raises(monkeypatch):
    # plan v4 (round-3 I1): the warm reply already consumed the picker's
    # pending resolver, so a rescan exception must STILL produce the
    # final:true update (cached devices + error string) or an empty picker
    # spins on "Scanning..." forever.
    sent = []
    monkeypatch.setattr(mc_host, "send", lambda m: sent.append(m))
    monkeypatch.setattr(mc_host, "_cast_seen_devices", lambda: [])

    def _boom(timeout=5):
        raise RuntimeError("scan blew up")
    monkeypatch.setattr(mc_host, "_cast_merged_discover", _boom)
    mc_host.handle_cast({"sub": "discover", "reqId": "we1", "warm": True})
    assert wait_for(lambda: [m for m in sent if m.get("type") == "cast-devices-update"]), \
        "final update never arrived after rescan exception"
    upd = [m for m in sent if m.get("type") == "cast-devices-update"][0]
    assert upd.get("final") is True and upd["devices"] == [] and upd.get("error")


# ---- blind-check closures (review of cf5403d, Important 2) -----------------
# Each test names the broken implementation it exists to kill.


def test_warm_reply_is_sent_BEFORE_the_rescan_runs(monkeypatch):
    # Kills: an implementation that scans first and answers "warm" from the
    # scan result (the cached reply must not wait behind the network).
    import threading
    sent = []
    order = []
    monkeypatch.setattr(mc_host, "send", lambda m: (sent.append(m), order.append(m["type"]))[0])
    monkeypatch.setattr(mc_host, "_cast_seen_devices", lambda now=None: [{"id": "x"}])
    gate = threading.Event()

    def _blocking_scan(timeout=5):
        # the warm reply MUST already be out before the scan is allowed to run
        assert "cast-devices" in order, "rescan started before the warm reply was sent"
        gate.set()
        return [{"id": "x"}]
    monkeypatch.setattr(mc_host, "_cast_merged_discover", _blocking_scan)
    mc_host.handle_cast({"sub": "discover", "reqId": "o1", "warm": True})
    assert wait_for(gate.is_set), "scan never ran"
    assert wait_for(lambda: any(m.get("final") for m in sent))


def test_warm_emits_exactly_one_reply_and_one_final(monkeypatch):
    # Kills: duplicate warm/final emissions.
    sent = []
    monkeypatch.setattr(mc_host, "send", lambda m: sent.append(m))
    monkeypatch.setattr(mc_host, "_cast_seen_devices", lambda now=None: [])
    monkeypatch.setattr(mc_host, "_cast_merged_discover", lambda timeout=5: [])
    mc_host.handle_cast({"sub": "discover", "reqId": "d1", "warm": True})
    assert wait_for(lambda: any(m.get("type") == "cast-devices-update" for m in sent))
    assert len([m for m in sent if m.get("type") == "cast-devices"]) == 1
    assert len([m for m in sent if m.get("type") == "cast-devices-update"]) == 1


def test_real_cast_seen_devices_prunes_ttl_and_formats(monkeypatch):
    # Kills: broken TTL pruning/formatting in the REAL helper (earlier tests
    # always faked it).
    import time as _t
    now = _t.time()
    monkeypatch.setattr(mc_host, "_CAST_SEEN", {
        "10.0.0.1": {"d": {"id": "fresh", "name": "A"}, "ts": now - 5},
        "10.0.0.2": {"d": {"id": "stale", "name": "B"}, "ts": now - mc_host._CAST_SEEN_TTL - 1},
    })
    out = mc_host._cast_seen_devices()
    assert out == [{"id": "fresh", "name": "A"}]
    assert list(mc_host._CAST_SEEN) == ["10.0.0.1"], "expired entry not pruned"


def test_concurrent_warm_discovers_never_scan_concurrently(monkeypatch):
    # Kills: removing _DISCOVER_LOCK. Two warm requests with a slow scan:
    # both must complete with finals, and the scans must never overlap.
    import threading
    sent, active, peak = [], [0], [0]
    lk = threading.Lock()
    monkeypatch.setattr(mc_host, "send", lambda m: sent.append(m))
    monkeypatch.setattr(mc_host, "_cast_seen_devices", lambda now=None: [])

    def _slow_scan(timeout=5):
        with lk:
            active[0] += 1
            peak[0] = max(peak[0], active[0])
        import time as _t
        _t.sleep(0.15)
        with lk:
            active[0] -= 1
        return []
    monkeypatch.setattr(mc_host, "_cast_merged_discover", _slow_scan)
    mc_host.handle_cast({"sub": "discover", "reqId": "c1", "warm": True})
    mc_host.handle_cast({"sub": "discover", "reqId": "c2", "warm": True})
    assert wait_for(lambda: len([m for m in sent if m.get("final")]) == 2, timeout=5)
    assert peak[0] == 1, "scans overlapped — _DISCOVER_LOCK not honored"


def test_warm_rescan_failure_emits_no_generic_cast_error(monkeypatch):
    # Review of 3eacdae (Important): the redundant worker-level cast-error made
    # the extension clear castState (and an active pairing dialog). The
    # final+error update is the ONLY failure signal a warm discover may emit.
    sent = []
    monkeypatch.setattr(mc_host, "send", lambda m: sent.append(m))
    monkeypatch.setattr(mc_host, "_cast_seen_devices", lambda now=None: [])

    def _boom(timeout=5):
        raise RuntimeError("scan blew up")
    monkeypatch.setattr(mc_host, "_cast_merged_discover", _boom)
    mc_host.handle_cast({"sub": "discover", "reqId": "ne1", "warm": True})
    assert wait_for(lambda: any(m.get("final") for m in sent))
    assert not [m for m in sent if m.get("type") == "cast-error"], \
        "warm rescan failure leaked a generic cast-error"



def test_canonical_alias_loader_identity():
    # Review of b9043cd (Minor 1, pin b): the registered loader and the
    # canonical alias must agree — `import mc_host` anywhere resolves to the
    # instance the tests patch. (Pin a: production __main__ identity is
    # proven end-to-end by test_framing_ping_snapshot_reveal's round trip —
    # the pong can only arrive through nm.py's OUT bound by the __main__
    # instance's init_io.)
    import sys
    import mc_host as imported
    assert imported is mc_host
    assert sys.modules["mc_host"] is mc_host
