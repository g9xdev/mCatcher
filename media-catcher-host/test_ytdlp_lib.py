"""In-process yt-dlp: the pure mapping from yt-dlp's progress/postprocessor hook
dicts to the ytdl-progress message shape the stdout parser produced.

The network calls (extract_info, download) are verified end-to-end, not here —
these tests pin the translation layer that has to match _parse_yt_progress
byte-for-byte so the extension sees no difference between the exe and the library.
"""
import threading

from conftest import load_host

mc = load_host()
import mchost.ytdlp_lib as lib   # noqa: E402


# ---- progress hook -> ytdl-progress message -------------------------------

def test_downloading_hook_maps_to_pct_total_bps():
    msg = lib.hook_to_progress({
        "status": "downloading",
        "downloaded_bytes": 52_428_800,      # 50 MiB
        "total_bytes": 104_857_600,          # 100 MiB
        "speed": 5_242_880.0,                # 5 MiB/s
    })
    assert msg["stage"] == "downloading"
    assert abs(msg["pct"] - 50.0) < 0.01
    assert msg["total"] == 104_857_600
    assert msg["bps"] == 5_242_880


def test_total_bytes_estimate_is_used_when_exact_is_missing():
    """A DASH stream reports total_bytes_estimate, not total_bytes."""
    msg = lib.hook_to_progress({
        "status": "downloading",
        "downloaded_bytes": 10,
        "total_bytes_estimate": 1000,
    })
    assert msg["total"] == 1000
    assert abs(msg["pct"] - 1.0) < 0.01


def test_missing_speed_is_omitted_not_zero():
    """yt-dlp reports speed=None between samples; a bogus 0 would jitter the ETA."""
    msg = lib.hook_to_progress({
        "status": "downloading", "downloaded_bytes": 5, "total_bytes": 10,
        "speed": None,
    })
    assert "bps" not in msg


def test_unknown_total_yields_no_pct_rather_than_a_divide_by_zero():
    msg = lib.hook_to_progress({
        "status": "downloading", "downloaded_bytes": 123,
        "total_bytes": None, "total_bytes_estimate": None,
    })
    assert msg is None or msg.get("pct") is None


def test_a_non_downloading_status_is_not_a_download_line():
    assert lib.hook_to_progress({"status": "finished", "total_bytes": 10}) is None


# ---- postprocessor hook -> merging ----------------------------------------

def test_merger_start_maps_to_the_merging_stage():
    msg = lib.pp_to_progress({"status": "started", "postprocessor": "Merger"})
    assert msg == {"stage": "merging", "pct": 99}


def test_a_non_merger_postprocessor_is_ignored():
    assert lib.pp_to_progress({"status": "started", "postprocessor": "MoveFiles"}) is None
    assert lib.pp_to_progress({"status": "finished", "postprocessor": "Merger"}) is None


# ---- availability ---------------------------------------------------------

def test_availability_is_false_without_the_pylib_dir(tmp_path):
    assert lib.available(str(tmp_path / "does-not-exist")) is False


def test_availability_is_true_when_yt_dlp_is_importable(tmp_path):
    pkg = tmp_path / "yt_dlp"
    pkg.mkdir()
    (pkg / "__init__.py").write_text("__version__ = '9.9.9'\n", encoding="utf-8")
    (pkg / "version.py").write_text("__version__ = '9.9.9'\n", encoding="utf-8")
    assert lib.available(str(tmp_path)) is True


# ---- final path extraction from a finished info dict ----------------------

def test_final_path_prefers_requested_downloads_filepath():
    info = {"requested_downloads": [{"filepath": r"C:\Downloads\video.mp4"}],
            "filepath": r"C:\Downloads\wrong.webm"}
    assert lib.final_path(info) == r"C:\Downloads\video.mp4"


def test_final_path_falls_back_to_top_level_filepath():
    assert lib.final_path({"filepath": r"C:\Downloads\v.mp4"}) == r"C:\Downloads\v.mp4"


def test_final_path_is_none_when_absent():
    assert lib.final_path({}) is None


# ---------------------------------------------------------------------------
# CRITICAL: in the host, stdout IS the native-messaging channel. yt-dlp must
# never write to it, or it corrupts the length-prefixed JSON framing. Verified
# in the spike: without this, yt-dlp printed [download] lines straight to stdout.
# ---------------------------------------------------------------------------

def test_opts_are_hardened_so_yt_dlp_cannot_write_to_stdout():
    opts = {}
    lib.harden_opts(opts)
    assert opts["quiet"] is True
    assert opts["no_warnings"] is True
    assert opts["noprogress"] is True, "progress comes from hooks, never the screen"
    assert opts.get("logger") is not None, "output must route through a logger, not stdout"


def test_hardening_overrides_whatever_the_args_asked_for():
    """--no-quiet on the exe forced the status lines back on; in-process that
    would dump them to the messaging channel, so hardening wins unconditionally."""
    opts = {"quiet": False, "no_warnings": False, "noprogress": False}
    lib.harden_opts(opts)
    assert opts["quiet"] is True and opts["no_warnings"] is True and opts["noprogress"] is True


def test_the_logger_routes_lines_to_a_sink_not_stdout():
    lines = []
    log = lib.HostLogger(lambda level, msg: lines.append((level, msg)))
    log.debug("d"); log.warning("w"); log.error("e")
    levels = [l[0] for l in lines]
    assert "error" in levels and "warn" in levels


# ---- cancellation during resolve ------------------------------------------
# yt-dlp's progress hooks do not fire until bytes flow, so the log sink is the
# only poll that can see a cancel while the job is still resolving.

def _fake_yt(on_extract, popen=None):
    """Minimal stand-in for the yt_dlp module: just enough of parse_options and
    YoutubeDL for download() to run without the vendored library present.

    `popen` becomes utils.Popen — the single class every real yt-dlp spawn site
    binds. Omitted, the module has no utils at all, which is the shape the child
    hook has to tolerate.
    """

    class YoutubeDL:
        def __init__(self, opts):
            self.opts = opts

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def extract_info(self, url, download=False):
            return on_extract(self.opts)

        def sanitize_info(self, info):
            return info

    mod = type("yt_dlp", (), {
        "parse_options": staticmethod(
            lambda argv: type("P", (), {"ydl_opts": {}, "urls": ["u"]})()),
        "YoutubeDL": YoutubeDL,
    })
    if popen is not None:
        mod.utils = type("utils", (), {"Popen": popen})
    return mod


def test_a_cancel_is_seen_from_the_log_sink_before_any_bytes_flow(monkeypatch):
    def on_extract(opts):
        opts["logger"].info("[youtube] Downloading webpage")
        raise AssertionError("the sink should have cancelled before this")

    monkeypatch.setattr(lib, "_yt", lambda pylib=None: _fake_yt(on_extract))
    try:
        lib.download(["u"], should_cancel=lambda: True)
    except lib.Cancelled:
        return
    raise AssertionError("download() did not raise Cancelled from the log sink")


def test_the_sink_cancel_poll_is_inert_when_no_poll_was_given(monkeypatch):
    """Several callers pass no should_cancel; a missing poll is not a cancel."""
    notes = []

    def on_extract(opts):
        opts["logger"].info("[youtube] Downloading webpage")
        return {"filepath": r"C:\out.mp4"}

    monkeypatch.setattr(lib, "_yt", lambda pylib=None: _fake_yt(on_extract))
    assert lib.download(["u"], on_note=notes.append) == r"C:\out.mp4"
    assert notes == ["Reading page"]


# ---- the subprocesses yt-dlp still spawns ----------------------------------
# "In-process" removes yt-dlp's own exe, not the ones it shells out to. deno
# solves the JS challenge through yt_dlp.utils.Popen and blocks the calling
# thread in communicate_or_kill with no timeout, so a hung deno is the one wedge
# no hook and no log line can reach. The caller needs a handle to what was
# spawned before it can do anything about it.

def _popen_class():
    """A FRESH stand-in per test. The hook wraps the class in place — a shared
    one would carry the wrap from the test that installed it into every test
    after, and they would pass on each other's work."""

    class _FakePopen:
        def __init__(self, args, **kw):
            self.args = args

        def poll(self):
            return None

    return _FakePopen


def _saved(path=r"C:\out.mp4"):
    return lambda opts: {"filepath": path}


def test_a_subprocess_yt_dlp_launches_is_handed_to_the_caller(monkeypatch):
    seen = []
    popen = _popen_class()

    def on_extract(opts):
        popen(["deno", "run", "-"])            # the JS challenge solver
        return {"filepath": r"C:\out.mp4"}

    monkeypatch.setattr(lib, "_yt", lambda pylib=None: _fake_yt(on_extract, popen))
    lib.download(["u"], on_child=seen.append)
    assert [p.args for p in seen] == [["deno", "run", "-"]]


def test_a_subprocess_from_another_thread_is_not_this_jobs_child(monkeypatch):
    """Downloads run concurrently, one worker thread each. A process-wide hook
    would let one job's stall kill another job's healthy deno."""
    seen = []
    popen = _popen_class()

    def on_extract(opts):
        t = threading.Thread(target=lambda: popen(["deno", "other-job"]))
        t.start()
        t.join()
        return {"filepath": r"C:\out.mp4"}

    monkeypatch.setattr(lib, "_yt", lambda pylib=None: _fake_yt(on_extract, popen))
    lib.download(["u"], on_child=seen.append)
    assert seen == [], "a child of another job was reported as this job's"


def test_the_hook_is_disarmed_once_the_download_returns(monkeypatch):
    """The worker thread outlives the call and goes on to other work; a still-armed
    hook would keep feeding a list nothing will ever drain."""
    seen = []
    popen = _popen_class()
    monkeypatch.setattr(lib, "_yt", lambda pylib=None: _fake_yt(_saved(), popen))

    lib.download(["u"], on_child=seen.append)
    popen(["ffmpeg", "-i", "x"])              # a later, unrelated spawn
    assert seen == []


def test_the_wrap_still_constructs_the_process(monkeypatch):
    """The hook observes. It must not change what yt-dlp spawns or how."""
    made = []
    popen = _popen_class()

    def on_extract(opts):
        made.append(popen(["deno", "run", "-"], stdin=-1).args)
        return {"filepath": r"C:\out.mp4"}

    monkeypatch.setattr(lib, "_yt", lambda pylib=None: _fake_yt(on_extract, popen))
    lib.download(["u"], on_child=lambda p: None)
    assert made == [["deno", "run", "-"]]


def test_a_yt_dlp_without_utils_popen_still_downloads(monkeypatch):
    """yt-dlp could rename or drop the spawn funnel. A download that works today
    must not start failing in order to gain a watchdog."""
    monkeypatch.setattr(lib, "_yt", lambda pylib=None: _fake_yt(_saved()))
    assert lib.download(["u"], on_child=lambda p: None) == r"C:\out.mp4"


def test_a_sink_that_raises_does_not_break_the_download(monkeypatch):
    """Same rule: observing is never worth failing a job that would have worked."""
    popen = _popen_class()

    def on_extract(opts):
        popen(["deno", "run", "-"])
        return {"filepath": r"C:\out.mp4"}

    monkeypatch.setattr(lib, "_yt", lambda pylib=None: _fake_yt(on_extract, popen))

    def boom(proc):
        raise RuntimeError("sink is broken")

    assert lib.download(["u"], on_child=boom) == r"C:\out.mp4"


def test_arming_the_hook_twice_does_not_announce_a_child_twice(monkeypatch):
    """Every download arms it. A wrap layered on a wrap would report each child
    once per download the process had ever run."""
    seen = []
    popen = _popen_class()

    def on_extract(opts):
        popen(["deno", "run", "-"])
        return {"filepath": r"C:\out.mp4"}

    monkeypatch.setattr(lib, "_yt", lambda pylib=None: _fake_yt(on_extract, popen))
    lib.download(["u"], on_child=lambda p: None)      # installs
    lib.download(["u"], on_child=seen.append)         # must not install again
    assert len(seen) == 1, "the child was announced %d times" % len(seen)


def test_two_threads_installing_the_hook_at_once_wrap_it_only_once(monkeypatch):
    """Every download arms the hook and maxConcurrentDownloads defaults to 4, so
    two jobs starting together is ordinary, not exotic. The check for the marker
    and the write of it are two separate statements: a second installer that
    lands between them reads an __init__ the first has ALREADY replaced, and
    wraps the wrapper. Nothing unwinds that — for the life of the helper every
    spawn is announced twice, the same proc lands in `children` twice, and
    kill_children reports "killed 2 subprocess(es)" for one deno.

    Forced rather than raced: a metaclass parks the first installer between its
    two writes, which is exactly the window, so this fails every run without the
    lock instead of once in a few hundred.
    """
    first_write = threading.Event()
    second_write = threading.Event()
    release_first = threading.Event()
    writes = []

    class _Gate(type):
        def __setattr__(cls, name, value):
            # Let the write land BEFORE parking: the damaging interleaving is
            # the one where the late installer sees the new __init__ and no mark.
            super().__setattr__(name, value)
            if name != "__init__":
                return                      # the marker write is not the window
            writes.append(name)
            if len(writes) == 1:
                first_write.set()
                release_first.wait(5)
            else:
                second_write.set()

    class _GatedPopen(metaclass=_Gate):
        def __init__(self, args=None, **kw):
            self.args = args

    monkeypatch.setattr(lib, "_yt", lambda pylib=None: _fake_yt(_saved(), _GatedPopen))

    first = threading.Thread(target=lib._install_child_hook, daemon=True)
    second = threading.Thread(target=lib._install_child_hook, daemon=True)
    try:
        first.start()
        assert first_write.wait(5), "the first installer never reached the wrap"
        second.start()
        # Unsynchronised, the second installer runs straight through to its own
        # __init__ write: a handful of bytecodes, nothing blocking. Holding the
        # lock it parks instead, and this bounded wait is what proving that
        # costs. Kept short because only the passing path ever pays it.
        raced = second_write.wait(0.5)
    finally:
        release_first.set()                 # never leave the hook lock held
        first.join(5)
        second.join(5)

    assert not raced, "the second installer wrapped an already-wrapped __init__"

    seen = []
    lib._arm_child_sink(seen.append)
    try:
        _GatedPopen(["deno", "run", "-"])
    finally:
        lib._disarm_child_sink()
    assert len(seen) == 1, "the child was announced %d times" % len(seen)


def test_a_hook_that_cannot_be_installed_says_so(monkeypatch):
    """Failing silently would leave the kill lever off for the life of the helper,
    with the only symptom being the very leak it exists to prevent. The missing-
    Popen path already says so; a failure to wrap has to say so too."""
    warnings = []
    monkeypatch.setattr(mc, "_hlog",
                        lambda level, msg, src=None: warnings.append((level, msg)))
    monkeypatch.setattr(lib, "_hook_warned", [False])
    # A built-in type refuses __init__ assignment, which is how a future yt-dlp
    # with a C-implemented Popen would fail.
    monkeypatch.setattr(lib, "_yt", lambda pylib=None: _fake_yt(_saved(), int))

    assert lib._install_child_hook() is False
    assert [l for l, _m in warnings] == ["warn"], warnings
    assert "cannot be killed" in warnings[0][1], warnings


def test_a_missing_popen_says_so_too(monkeypatch):
    """Same warning, the other way the funnel can go away."""
    warnings = []
    monkeypatch.setattr(mc, "_hlog",
                        lambda level, msg, src=None: warnings.append((level, msg)))
    monkeypatch.setattr(lib, "_hook_warned", [False])
    monkeypatch.setattr(lib, "_yt", lambda pylib=None: _fake_yt(_saved()))

    assert lib._install_child_hook() is False
    assert [l for l, _m in warnings] == ["warn"], warnings
