"""Offline tests for mc_host.py: wire-protocol framing + ffmpeg command building.
Does not require a real stream. Run:  python -m pytest test_host.py -q
(or directly:  py test_host.py)"""
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
