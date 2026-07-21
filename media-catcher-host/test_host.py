"""Offline tests for mc_host.py: wire-protocol framing + ffmpeg command building.
Does not require a real stream. Run:  py test_host.py"""
import sys, os, json, struct, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
HOST = os.path.join(HERE, "mc_host.py")
ok = True


def check(label, cond):
    global ok
    print(("ok   " if cond else "XX   ") + label)
    if not cond:
        ok = False


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


def framing_test():
    p = subprocess.Popen([sys.executable, HOST], stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        msg = json.dumps({"cmd": "ping"}).encode()
        p.stdin.write(struct.pack("@I", len(msg)) + msg)
        p.stdin.flush()
        reply = read_reply(p)
        check("host replied to ping", reply is not None)
        if reply is not None:
            check("reply is a pong", reply.get("type") == "pong")
            check("pong reports ffmpeg presence (bool)", isinstance(reply.get("ffmpeg"), bool))
            check("pong carries a version", bool(reply.get("version")))
            print("     (ffmpeg found: %s)" % (reply.get("ffmpegPath") or "no"))

            # snapshot for an unknown recording -> graceful error (dispatch works)
            snap = json.dumps({"cmd": "snapshot", "id": 999}).encode()
            p.stdin.write(struct.pack("@I", len(snap)) + snap); p.stdin.flush()
            r2 = read_reply(p)
            check("snapshot of unknown id returns an error",
                  r2 is not None and r2.get("type") == "error" and r2.get("id") == 999)

            # reveal dispatch is wired (missing file -> error echoing our id).
            # Would hang/fail if the main-loop elif for "reveal" were absent.
            rev = json.dumps({"cmd": "reveal", "path": os.path.join(HERE, "no-such-file.mp4"), "id": 7}).encode()
            p.stdin.write(struct.pack("@I", len(rev)) + rev); p.stdin.flush()
            r3 = read_reply(p)
            check("reveal of missing file errors over the wire",
                  r3 is not None and r3.get("type") == "error" and r3.get("id") == 7)
    finally:
        try: p.stdin.close()
        except Exception: pass
        p.wait(timeout=5)


# ---- Test B: ffmpeg command construction ----
def cmd_test():
    import importlib.util
    spec = importlib.util.spec_from_file_location("mc_host", HOST)
    mc = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mc)          # safe: io init deferred to main()
    mc.FFMPEG = "ffmpeg"                  # pretend it's present

    check("sanitize strips path chars", mc.sanitize('a/b:c*?.mp4') == "a_b_c_.mp4" or "_" in mc.sanitize('a/b:c'))

    job = mc.Job(7, os.path.join(mc.TMPDIR, "mc_7.mp4"))
    # video + audio
    cmd = mc.ffmpeg_cmd(job, {"videoUrl": "http://v/x.m3u8", "audioUrl": "http://a/y.m3u8",
                              "referer": "http://page/", "userAgent": "UA"})
    check("uses copy codec", "-c" in cmd and cmd[cmd.index("-c") + 1] == "copy")
    check("two inputs when audio present", cmd.count("-i") == 2)
    check("maps video+audio", "-map" in cmd and "0:v:0" in cmd and "1:a:0" in cmd)
    check("passes headers", any(s == "-headers" for s in cmd) and any("Referer: http://page/" in str(s) for s in cmd))
    check("fragmented mp4 for interrupt safety", any("frag_keyframe" in str(s) for s in cmd))
    check("progress on pipe:1", "pipe:1" in cmd)
    check("output is the temp file", cmd[-1] == job.temp)

    # video only
    cmd1 = mc.ffmpeg_cmd(job, {"videoUrl": "http://v/x.m3u8"})
    check("single input when no audio", cmd1.count("-i") == 1)
    check("no -map when single input", "-map" not in cmd1)


# ---- Test C: reveal opens the CONTAINING FOLDER, not the file ----
def reveal_test():
    import importlib.util, tempfile
    spec = importlib.util.spec_from_file_location("mc_host_reveal", HOST)
    mc = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mc)

    fd, tmp = tempfile.mkstemp(suffix=".mp4")
    os.close(fd)
    orig_popen = subprocess.Popen
    try:
        calls = []
        def fake_popen(cmd, **kw):
            calls.append(cmd)
            return object()
        mc.subprocess.Popen = fake_popen        # same module object — restored below
        sent = []
        mc.send = sent.append

        mc.handle_reveal({"path": tmp})
        if os.name == "nt":
            check("reveal uses Explorer /select, on the file (exact command)",
                  calls == ['explorer /select,"%s"' % tmp])
        elif sys.platform == "darwin":
            check("reveal uses open -R on the file", calls == [["open", "-R", tmp]])
        else:
            check("reveal xdg-opens the containing dir",
                  calls == [["xdg-open", os.path.dirname(tmp)]])
        check("reveal of existing file sends no error", not sent)

        calls.clear(); sent.clear()
        mc.handle_reveal({"path": tmp + ".nope", "id": 5})
        check("reveal of missing file errors with the request id",
              len(sent) == 1 and sent[0].get("type") == "error" and sent[0].get("id") == 5)
        check("reveal of missing file spawns nothing", not calls)
    finally:
        mc.subprocess.Popen = orig_popen
        os.unlink(tmp)


framing_test()
cmd_test()
reveal_test()
print("\n" + ("ALL PASSED" if ok else "SOME FAILED"))
sys.exit(0 if ok else 1)
