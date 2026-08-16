"""In-process yt-dlp: the pure mapping from yt-dlp's progress/postprocessor hook
dicts to the ytdl-progress message shape the stdout parser produced.

The network calls (extract_info, download) are verified end-to-end, not here —
these tests pin the translation layer that has to match _parse_yt_progress
byte-for-byte so the extension sees no difference between the exe and the library.
"""
from conftest import load_host

load_host()
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
