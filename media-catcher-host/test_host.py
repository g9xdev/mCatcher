"""Offline tests for mc_host.py: wire-protocol framing + ffmpeg command building.
Does not require a real stream. Run:  python -m pytest test_host.py -q
(or directly:  py test_host.py)"""
import io
import json
import os
import struct
import subprocess
import sys
import threading
import time

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
        assert reply.get("ytdlProtocol") == 2, "pong advertises yt-dlp protocol v2"

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
    # Dispatched to a worker (the isfile stat has no bound), so wait for it.
    assert wait_for(lambda: bool(calls) or bool(sent), timeout=5), "reveal never ran"
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
    assert wait_for(lambda: bool(sent), timeout=5), "reveal never reported the miss"
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

    # Review of b9043cd (Minor 2): JOIN the worker before asserting absence.
    # The final is emitted BEFORE the worker's outer exception handler, so
    # waiting on the final alone would let a reintroduced re-raise emit its
    # cast-error after the assertion had already passed.
    import threading as _threading
    workers = []
    _RealThread = _threading.Thread

    class _CaptureThread(_RealThread):
        def __init__(self, *a, **kw):
            super().__init__(*a, **kw)
            workers.append(self)
    monkeypatch.setattr(mc_host.threading, "Thread", _CaptureThread)

    def _boom(timeout=5):
        raise RuntimeError("scan blew up")
    monkeypatch.setattr(mc_host, "_cast_merged_discover", _boom)
    mc_host.handle_cast({"sub": "discover", "reqId": "ne1", "warm": True})
    assert workers, "handle_cast spawned no worker to join"
    for w in workers:
        w.join(timeout=5)
        assert not w.is_alive(), "cast worker did not exit within 5s"
    assert any(m.get("final") for m in sent), "final update never arrived"
    assert not [m for m in sent if m.get("type") == "cast-error"], \
        "warm rescan failure leaked a generic cast-error"



def test_canonical_alias_loader_identity():
    # Review of b9043cd (Minor 1, pin b): the registered loader and the
    # canonical alias must agree — `import mc_host` anywhere resolves to the
    # instance the tests patch.
    import sys
    import mc_host as imported
    assert imported is mc_host
    assert sys.modules["mc_host"] is mc_host


def test_canonical_alias_under_script_mode_main():
    """Review of d71b84b (Important 1, pin a): production runs the shim as
    __main__, so a package submodule's `import mc_host` must resolve to THAT
    instance — two live shim objects would split patched/mutable state.

    An earlier claim that the framing round trip proves this was WRONG: both
    instances share mchost.nm's OUT, so a pong arrives either way.

    Adversary-verified: with the alias line removed, this test FAILS. (A
    first attempt compared `_config_path`, which is re-exported from
    mchost.config and is therefore the SAME object in both instances —
    blind. The sentinel below exists only on the executing __main__
    instance, so a second shim object cannot fake it.)
    """
    driver = (
        # `python -c` code runs in the real __main__ module, so exec-ing the
        # shim here reproduces production (`python mc_host.py`) exactly:
        # __name__ == '__main__' and registered in sys.modules. main() runs
        # and returns immediately on stdin EOF (stdin=DEVNULL).
        "import sys\n"
        "sys.argv = ['mc_host.py']\n"
        "src = open(%r, encoding='utf-8').read()\n"
        "exec(compile(src, %r, 'exec'))\n"
        "sys.modules['__main__'].SENTINEL_FROM_MAIN = 'unique-marker'\n"
        "import mchost.config as cfg\n"
        "shim = cfg._h()\n"
        "assert getattr(shim, 'SENTINEL_FROM_MAIN', None) == 'unique-marker', \\\n"
        "    'submodule resolved a DIFFERENT shim instance than __main__'\n"
        "print('ALIAS-MAIN-OK')\n" % (HOST, HOST)
    )
    p = subprocess.run([sys.executable, "-c", driver], cwd=HERE,
                       capture_output=True, text=True, timeout=60,
                       stdin=subprocess.DEVNULL)
    assert "ALIAS-MAIN-OK" in p.stdout, (p.stdout or "") + (p.stderr or "")


def test_safe_kill_takes_the_whole_process_tree():
    """yt-dlp's PyInstaller onefile build is a launcher that re-execs the real
    program as a CHILD, and that grandchild inherits our stdout pipe. Killing
    only the launcher orphans it: the pipe never closes, so the reader loop never
    ends, p.wait() is never reached, and the job hangs on "Preparing" forever
    with no terminal message ever sent."""
    import mchost.downloads as dl

    code = (
        "import subprocess, sys, time\n"
        "c = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])\n"
        "print(c.pid, flush=True)\n"
        "time.sleep(120)\n"
    )
    p = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, text=True)
    try:
        grandchild = int(p.stdout.readline().strip())

        def alive(pid):
            r = subprocess.run(["tasklist", "/FI", "PID eq %d" % pid, "/NH"],
                               capture_output=True, text=True)
            return str(pid) in (r.stdout or "")

        assert alive(grandchild), "grandchild is running"
        dl._safe_kill(p)
        assert wait_for(lambda: not alive(grandchild), timeout=20), \
            "_safe_kill must take descendants too, not just the direct child"
    finally:
        try:
            p.kill()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# handle_snapshot must not run on the message loop
#
# It is a full-file copy of a LIVE recording, and it was the one long-running
# command that did not dispatch to a worker (ytdl, pget, record, probe,
# pickFolder, update and checkGithub all do). The extension now disconnects the
# native port after four missed heartbeats (~150s); that EOFs read_message() and
# ends main(), so a multi-GB snapshot on slow or AV-scanned storage could take
# the in-flight recording down with it.
# ---------------------------------------------------------------------------

def _live_job(d, tmp_path, jid, payload=b"x" * 32):
    temp = tmp_path / (str(jid) + ".tmp")
    temp.write_bytes(payload)
    job = d.Job(jid, str(temp))
    job.base = "clip"
    job.seconds = 3.0
    with d.JOBS_LOCK:
        d.JOBS[jid] = job
    return job


def test_a_snapshot_copy_does_not_block_the_message_loop(tmp_path, monkeypatch):
    """The caller of handle_snapshot IS the read loop, so what this measures is
    how long that loop is held: the handler must return while the copy is still
    running, not after it."""
    import mchost.downloads as d

    _live_job(d, tmp_path, "j-snap")
    sent = []
    copying = threading.Event()
    copied = threading.Event()
    real_copy = d._copy_prefix

    def slow_copy(src, dst):
        copying.set()
        # A real one runs for minutes. A second is enough to tell the two
        # dispatch shapes apart without making the suite slow.
        assert not threading.Event().wait(1.0)
        real_copy(src, dst)
        copied.set()

    monkeypatch.setattr(mc_host, "send", sent.append)
    monkeypatch.setattr(d, "_h", lambda: mc_host)
    monkeypatch.setattr(d, "_copy_prefix", slow_copy)
    try:
        started = time.monotonic()
        d.handle_snapshot({"id": "j-snap", "dir": str(tmp_path)})
        held = time.monotonic() - started

        assert copying.wait(5), "the copy never started"
        assert held < 0.5, (
            "handle_snapshot held its caller for %.2fs while the copy ran" % held)
        assert copied.wait(5), "the copy never finished"
        assert wait_for(lambda: any(m.get("type") == "snapshot" for m in sent),
                        timeout=5), sent
        reply = [m for m in sent if m.get("type") == "snapshot"][0]
        assert reply["id"] == "j-snap" and reply["bytes"] == 32, reply
    finally:
        with d.JOBS_LOCK:
            d.JOBS.pop("j-snap", None)


def test_two_snapshots_never_copy_at_the_same_time(tmp_path, monkeypatch):
    """Both write one "<base> (partial).mp4". The message loop used to serialise
    them for free; off it, two overlapping writes to one path interleave and the
    checkpoint they leave is corrupt."""
    import mchost.downloads as d

    _live_job(d, tmp_path, "j-a")
    _live_job(d, tmp_path, "j-b")
    sent = []
    state = {"now": 0, "peak": 0}
    real_copy = d._copy_prefix

    def counting_copy(src, dst):
        state["now"] += 1
        state["peak"] = max(state["peak"], state["now"])
        assert not threading.Event().wait(0.2)
        state["now"] -= 1
        real_copy(src, dst)

    monkeypatch.setattr(mc_host, "send", sent.append)
    monkeypatch.setattr(d, "_h", lambda: mc_host)
    monkeypatch.setattr(d, "_copy_prefix", counting_copy)
    try:
        d.handle_snapshot({"id": "j-a", "dir": str(tmp_path)})
        d.handle_snapshot({"id": "j-b", "dir": str(tmp_path)})
        assert wait_for(lambda: len([m for m in sent
                                     if m.get("type") == "snapshot"]) == 2,
                        timeout=10), sent
        assert state["peak"] == 1, (
            "%d snapshot copies ran at once" % state["peak"])
    finally:
        with d.JOBS_LOCK:
            d.JOBS.pop("j-a", None)
            d.JOBS.pop("j-b", None)


def test_a_discard_during_a_snapshot_leaves_no_partial_and_sends_no_frame(
        tmp_path, monkeypatch):
    """Threading the snapshot let its copy overlap handle_discard, which still
    runs inline on the loop — an overlap that was impossible before. The user
    discarded the recording, so no checkpoint of it may survive in Downloads and
    no snapshot frame may follow the discard."""
    import mchost.downloads as d

    _live_job(d, tmp_path, "j-disc")
    dest = tmp_path / "clip (partial).mp4"
    temp = tmp_path / "j-disc.tmp"
    sent = []
    real_copy = d._copy_prefix

    def copy_then_discard(src, dst):
        real_copy(src, dst)                     # the checkpoint really is written
        d.handle_discard({"id": "j-disc"})      # ...and discarded before it commits

    monkeypatch.setattr(mc_host, "send", sent.append)
    monkeypatch.setattr(d, "_h", lambda: mc_host)
    monkeypatch.setattr(d, "_copy_prefix", copy_then_discard)
    try:
        d.handle_snapshot({"id": "j-disc", "dir": str(tmp_path)})
        assert wait_for(lambda: any(m.get("type") == "discarded" for m in sent),
                        timeout=5), sent
        assert wait_for(lambda: not dest.exists(), timeout=5), (
            "a discarded recording left its checkpoint in Downloads")
        assert not any(m.get("type") == "snapshot" for m in sent), sent
        assert not temp.exists(), "the discarded temp file leaked"
    finally:
        with d.JOBS_LOCK:
            d.JOBS.pop("j-disc", None)


def test_the_snapshot_worker_removes_the_temp_the_discard_could_not(
        tmp_path, monkeypatch):
    """handle_discard's os.remove(job.temp) fails while a snapshot copy holds
    that file open — CPython's read handle omits FILE_SHARE_DELETE — and the bare
    except swallows it, so a multi-GB temp leaked. Whoever is last out removes
    it. The sharing violation is simulated rather than provoked, so the test does
    not turn on handle timing."""
    import mchost.downloads as d

    _live_job(d, tmp_path, "j-held")
    dest = tmp_path / "clip (partial).mp4"
    temp = tmp_path / "j-held.tmp"
    sent = []
    real_copy = d._copy_prefix
    real_remove = os.remove
    denied = {"n": 0}

    def flaky_remove(path):
        if (os.path.normcase(str(path)) == os.path.normcase(str(temp))
                and denied["n"] == 0):
            denied["n"] = 1
            raise PermissionError(32, "used by another process")
        real_remove(path)

    def copy_then_discard(src, dst):
        real_copy(src, dst)
        monkeypatch.setattr(os, "remove", flaky_remove)
        d.handle_discard({"id": "j-held"})

    monkeypatch.setattr(mc_host, "send", sent.append)
    monkeypatch.setattr(d, "_h", lambda: mc_host)
    monkeypatch.setattr(d, "_copy_prefix", copy_then_discard)
    try:
        d.handle_snapshot({"id": "j-held", "dir": str(tmp_path)})
        assert wait_for(lambda: denied["n"] == 1, timeout=5), (
            "the discard never reached its os.remove")
        assert wait_for(lambda: not temp.exists(), timeout=5), (
            "the temp the discard could not remove was never cleaned up")
        assert not dest.exists(), "a discarded recording left its checkpoint behind"
        assert not any(m.get("type") == "snapshot" for m in sent), sent
    finally:
        with d.JOBS_LOCK:
            d.JOBS.pop("j-held", None)


# ---------------------------------------------------------------------------
# The read loop's shape, owned HERE
#
# The rule is: nothing dispatched from main()'s message loop may hold it for
# longer than the extension's heartbeat tolerates. Until now that rule lived
# only in a comment in background.js - on the far side of the port from the code
# that has to honour it - and it regressed twice (handle_snapshot, then
# handle_file_commit / _pget_cancel / handle_open) with a green suite both times.
#
# WHAT THIS CATCHES
#   - a new elif branch added to the loop: the parsed set stops matching the
#     table below and the test fails naming the command
#   - a handler classified "worker" that stops dispatching to a thread
#   - a handler moved between the two classes without its entry being updated
#
# WHAT IT DOES NOT CATCH
#   - an inline handler that grows new unbounded work inside it (the bound is a
#     written claim here, not a measurement)
#   - a handler that starts a thread and then joins it
#   - blocking work added to main() outside any handler branch
# Those need a reader. This stops the silent case: a whole new command landing
# on the loop with nobody having thought about it.
# ---------------------------------------------------------------------------

# cmd -> ("worker", (names that must start a thread,)) | ("inline", why bounded)
# "<dispatch>" means the loop branch itself starts the thread.
LOOP_DISPATCH = {
    "ping": ("inline",
             "one small frame, and it IS the heartbeat reply: answered anywhere "
             "but the loop, a missed beat stops meaning 'the loop is turning'"),
    "ytdl": ("worker", ("_handle_ytdl_legacy", "_handle_ytdl_structured")),
    "ytmeta": ("worker", ("handle_ytmeta",)),
    "cast": ("worker", ("handle_cast",)),
    "ytdlUpdate": ("worker", ("<dispatch>",)),
    "record": ("worker", ("handle_record",)),
    "stop": ("inline",
             "writes 'q' to ffmpeg's stdin and returns - no wait, no filesystem"),
    "snapshot": ("worker", ("handle_snapshot",)),
    "save": ("worker", ("handle_save",)),
    "saveAs": ("worker", ("handle_save_as",)),
    "pickFolder": ("worker", ("handle_pick_folder",)),
    "open": ("worker", ("handle_open",)),
    "reveal": ("worker", ("handle_reveal",)),
    "update": ("worker", ("handle_update",)),
    "watch": ("inline",
              "reads and rewrites the small config file, then arms an OS watcher"),
    "checkGithub": ("worker", ("handle_check_github",)),
    "discard": ("inline",
                "bounded 10s wait for ffmpeg to finalize, inside one beat; the "
                "unlinks are best-effort and a snapshot worker retries the one "
                "that can fail"),
    "pget": ("worker", ("handle_pget",)),
    "pget-single": ("worker", ("handle_pget_single",)),
    "pget-set-limit": ("inline", "registry and lease bookkeeping, then one send"),
    "getReport": ("inline", "reads a bounded tail of two small local files"),
    "probe": ("worker", ("handle_probe",)),
    # Decision inline (it pins WHICH op the cancel names), kills on a worker.
    "pget-cancel": ("worker", ("_pget_kill_off_loop",)),
    "file-open": ("inline",
                  "one O_EXCL create of the .part under the registry lock"),
    "file-chunk": ("inline",
                   "one write+flush of a single chunk, bounded by MAX_UNACKED"),
    "file-commit": ("worker", ("handle_file_commit",)),
    "file-abort": ("inline",
                   "closes the handle and unlinks the .part - metadata only"),
}


def _loop_branches():
    """Every `cmd == "..."` branch in main(), by AST rather than by grep, with a
    flag for whether the branch body itself starts a thread.

    Matches that one shape only. `elif cmd in ("a", "b")` and
    `elif msg.get("cmd") == "x"` would both be missed, so a command added in
    either form slips past the table. The loop has used one shape throughout;
    this is where to look first if it ever stops.
    """
    import ast

    tree = ast.parse(io.open(HOST, encoding="utf-8").read())
    main = [n for n in ast.walk(tree)
            if isinstance(n, ast.FunctionDef) and n.name == "main"]
    assert main, "main() not found in mc_host.py"
    found = {}
    for node in ast.walk(main[0]):
        if not isinstance(node, ast.If):
            continue
        t = node.test
        if not (isinstance(t, ast.Compare) and isinstance(t.left, ast.Name)
                and t.left.id == "cmd" and len(t.ops) == 1
                and isinstance(t.ops[0], ast.Eq)
                and isinstance(t.comparators[0], ast.Constant)):
            continue
        starts = any(isinstance(c, ast.Call) and isinstance(c.func, ast.Attribute)
                     and c.func.attr == "start"
                     for b in node.body for c in ast.walk(b))
        found[t.comparators[0].value] = starts
    return found


def _module_functions():
    """Module-level functions across the mchost package, by name."""
    import ast

    out = {}
    root_dir = os.path.join(HERE, "mchost")
    for root, _, files in os.walk(root_dir):
        for f in files:
            if not f.endswith(".py"):
                continue
            fp = os.path.join(root, f)
            for n in ast.parse(io.open(fp, encoding="utf-8").read()).body:
                if isinstance(n, ast.FunctionDef):
                    out[n.name] = (n, os.path.relpath(fp, HERE))
    return out


def _starts_a_thread(fnnode):
    import ast

    return any(isinstance(c, ast.Call) and isinstance(c.func, ast.Attribute)
               and c.func.attr == "start" for c in ast.walk(fnnode))


def test_every_loop_command_is_classified():
    """A new command dispatched from the read loop fails here until someone has
    decided, in writing, whether it may run on that loop."""
    branches = _loop_branches()
    assert set(branches) == set(LOOP_DISPATCH), (
        "the loop's commands and this table disagree; added=%s removed=%s"
        % (sorted(set(branches) - set(LOOP_DISPATCH)),
           sorted(set(LOOP_DISPATCH) - set(branches))))


def test_every_loop_command_has_a_schema():
    """The same enumeration, for the OTHER table that has to stay in step.

    guard.MESSAGE_SCHEMA says what each command's fields may be; this loop is
    what feeds it. A command added to one and not the other is either
    undispatchable or unvalidated, and unvalidated is the one that matters — the
    whole point of the gate is that no branch runs on a message nobody typed.
    Asserted against the AST of main() rather than against LOOP_DISPATCH so the
    two tables are pinned to the CODE, not to each other."""
    from mchost import guard

    branches = _loop_branches()
    assert set(branches) == set(guard.MESSAGE_SCHEMA), (
        "the loop's commands and guard.MESSAGE_SCHEMA disagree; "
        "unvalidated=%s stale=%s"
        % (sorted(set(branches) - set(guard.MESSAGE_SCHEMA)),
           sorted(set(guard.MESSAGE_SCHEMA) - set(branches))))


def test_the_gate_runs_before_the_dispatch_chain():
    """Validation placed after the first `cmd ==` branch would leave that branch
    unguarded, which is exactly the shape this is meant to make impossible."""
    src = io.open(HOST, encoding="utf-8").read()
    gate = src.index("guard.validate_message(msg)")
    first_branch = src.index('if cmd == "ping"')
    assert gate < first_branch, "the schema gate must precede the dispatch chain"


def test_every_long_loop_command_really_dispatches_to_a_worker():
    """The "worker" half of the table is a claim about code, so check the code.
    Names the function that does the dispatching, not just the handler, because
    several handlers delegate (ytdl to two protocol paths, pget-cancel to the
    killer it hands the slow half to)."""
    branches = _loop_branches()
    funcs = _module_functions()
    for cmd, (kind, detail) in sorted(LOOP_DISPATCH.items()):
        if kind != "worker":
            continue
        for name in detail:
            if name == "<dispatch>":
                assert branches.get(cmd), (
                    "%s claims the loop branch starts its own thread; it does not"
                    % cmd)
                continue
            assert name in funcs, "%s names %s, which does not exist" % (cmd, name)
            node, where = funcs[name]
            assert _starts_a_thread(node), (
                "%s is classified worker via %s (%s), but that function starts no "
                "thread - it now runs on the read loop" % (cmd, name, where))


# The inline half of the table is documentation, deliberately unasserted. A
# "len(reason) > 20" check passes anything and would be updated reflexively the
# first time it fired, which is worse than not having it: the reasons are there
# for a reader, and only a reader can judge them.


# ---------------------------------------------------------------------------
# The two log sinks say the same thing
#
# The extension redacts URLs on the way into storage.local, but the on-disk
# copy at %TEMP%\host.log used to keep the query string -- and that is the copy
# a user hands over when they are asked for "the helper log". Redaction moved
# to the _hlog seam so both sinks carry one projection.
# ---------------------------------------------------------------------------

def test_hlog_redacts_urls_in_both_sinks(tmp_path, monkeypatch):
    from mchost import hlog

    sent = []
    monkeypatch.setattr(mc_host, "send", lambda m: sent.append(dict(m)))
    log_path = tmp_path / "host.log"
    monkeypatch.setattr(hlog, "_HOST_LOG", str(log_path))

    hlog._hlog("info", "yt-dlp: downloading "
                       "https://user:pw@cdn.example:8443/a/b.mp4?token=SECRET#frag "
                       "(pot=on)")

    on_disk = log_path.read_text(encoding="utf-8")
    on_wire = sent[-1]["msg"]
    for blob in (on_disk, on_wire):
        assert "SECRET" not in blob, blob
        assert "user:pw" not in blob, blob
        assert "https://cdn.example:8443/a/b.mp4" in blob, blob
    # One projection, not two policies: the disk line carries the wire line.
    assert on_wire in on_disk


def test_hlog_keeps_local_paths_and_fails_closed_on_a_bad_url(tmp_path, monkeypatch):
    """A save path is not a URL and stays whole; an unparseable URL is dropped
    to a marker rather than passed through, because echoing it IS the leak."""
    from mchost import hlog

    sent = []
    monkeypatch.setattr(mc_host, "send", lambda m: sent.append(dict(m)))
    monkeypatch.setattr(hlog, "_HOST_LOG", str(tmp_path / "host.log"))

    local = r"saved to C:\Users\me\Videos\clip.mp4"
    hlog._hlog("info", local)
    assert sent[-1]["msg"] == local

    hlog._hlog("error", "bad https://[invalid?token=SECRET")
    assert sent[-1]["msg"] == "bad [redacted]"

    # Idempotent: the extension redacts again over what it receives.
    once = hlog._redact_log_text("see https://a.test/x.mp4?k=SECRET.")
    assert once == "see https://a.test/x.mp4."
    assert hlog._redact_log_text(once) == once


def test_hlog_credential_pass_catches_what_the_url_match_cannot(tmp_path, monkeypatch):
    """Mirrors media-catcher/lib/privacy.js, so the two sinks stay in step.

    The URL match ends at whitespace, so a URL yt-dlp printed with a raw space
    in it keeps its tail -- and the Signature after that space -- as loose
    text. A second pass redacts credential-shaped VALUES wherever they appear,
    so no boundary has to be decided. Being additive it can only remove more,
    which is why the format-selector line is pinned unchanged here rather than
    assumed.
    """
    from mchost import hlog

    sent = []
    monkeypatch.setattr(mc_host, "send", lambda m: sent.append(dict(m)))
    monkeypatch.setattr(hlog, "_HOST_LOG", str(tmp_path / "host.log"))

    hlog._hlog("info", "yt-dlp: https://cdn.test/a b.mp4?Signature=SECRETSIG&Expires=99")
    assert sent[-1]["msg"] == \
        "yt-dlp: https://cdn.test/a b.mp4?Signature=[redacted]&Expires=[redacted]"

    # An unencoded quote inside a query no longer ends the URL match.
    assert "SECRETTOK" not in hlog._redact_log_text(
        'get https://cdn.test/a.mp4?q="x&token=SECRETTOK now')

    # Whole-name only, and a real diagnostic the projection preserves is kept.
    for keep in ("monkey=notacredential", "passwordless=alsofine",
                 "Key-Pair-Id=keepme", "-f bv*[height<=720]+ba"):
        assert hlog._redact_log_text(keep) == keep, keep
