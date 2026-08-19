"""Settings probe: per-check verdicts over injected state, and the orchestration.

Design: docs/superpowers/specs/2026-08-16-settings-probe-design.md

Every check is a pure function over state someone else collected, so none of this
needs a real antivirus, real binaries, or real processes.
"""
from conftest import load_host, wait_for

mc = load_host()
import mchost.probe as probe   # noqa: E402


# ---------------------------------------------------------------------------
# The launch-time check IS the antivirus verdict
#
# During the incident real-time protection was OFF and the fault persisted:
# disabling real-time monitoring does not unload the WdFilter minifilter. Only a
# timed launch separated "AV is intercepting this" from "the network is broken",
# so this check leads and the settings only corroborate.
# ---------------------------------------------------------------------------

def test_fast_launch_passes():
    v = probe.check_launch_time(0.37)
    assert v["status"] == "pass", v
    assert "0.37" in v["detail"]


def test_slow_launch_fails_and_names_interception():
    v = probe.check_launch_time(21.4)
    assert v["status"] == "fail", v
    assert "intercept" in v["detail"].lower(), \
        "a slow launch must name interception, not blame the network"


def test_launch_verdict_does_not_flip_on_a_borderline_value():
    """One threshold, no dead zone: everything is pass or fail."""
    lo = probe.check_launch_time(probe.LAUNCH_SLOW_SECONDS - 0.01)
    hi = probe.check_launch_time(probe.LAUNCH_SLOW_SECONDS + 0.01)
    assert lo["status"] == "pass" and hi["status"] == "fail"


# ---------------------------------------------------------------------------
# Antivirus reporting
# ---------------------------------------------------------------------------

def test_av_check_reports_what_is_readable_unelevated():
    v = probe.check_av({"realtime": True, "cloudLevel": 2, "tamper": False},
                       cloud_events=6, host_dir=r"C:\X\Host")
    assert "real-time" in v["detail"].lower()
    assert "2" in v["detail"], "cloud level is corroborating evidence"
    assert "6" in v["detail"], "recent cloud-lookup count belongs in the detail"


def test_av_check_states_exclusions_are_unreadable_rather_than_guessing():
    """Get-MpPreference returns 'N/A: Must be an administrator to view
    exclusions' when unelevated. Saying 'no exclusions found' would be a lie."""
    v = probe.check_av({"realtime": True, "cloudLevel": 2, "tamper": False,
                        "exclusions": probe.EXCLUSIONS_UNREADABLE},
                       cloud_events=0, host_dir=r"C:\X\Host")
    assert "admin" in v["detail"].lower()
    assert "no exclusions" not in v["detail"].lower()


def test_av_check_offers_the_command_as_text_and_never_runs_it():
    """A diagnostics button that silently punches AV holes is shaped exactly like
    malware, and it needs admin anyway. The probe hands over the command."""
    v = probe.check_av({"realtime": True, "cloudLevel": 2, "tamper": False},
                       cloud_events=9, host_dir=r"C:\X\Host")
    assert "Add-MpPreference" in (v.get("fix") or ""), "command is offered as text"
    assert v.get("fixable") is not True, "the AV check must never be marked self-applying"


def test_no_probe_check_ever_offers_to_apply_an_av_exclusion(monkeypatch):
    """Deliberate, not unimplemented: applying an exclusion needs admin the host
    never has, and a diagnostics button that silently punches AV holes is shaped
    exactly like malware. The command is reported for the user to run themselves.

    Two ratchets, not one. A source scan catches a naive reintroduction of an
    elevation call. Monkeypatching the actual execution primitives proves that
    composing the command never runs it -- via subprocess or os.system/startfile
    -- regardless of which API a future change reaches for, which a string scan
    alone would not catch (a call through a variable, or a different API)."""
    import inspect

    # `probe` is already imported at module scope in this file.
    src = inspect.getsource(probe)
    assert "Add-MpPreference" in src, "the command should still be composed and shown"
    for forbidden in ("Start-Process -Verb runAs", "ShellExecute", "runas"):
        assert forbidden not in src, "the exclusion must never be executed by the host"

    def _boom(*a, **k):
        raise AssertionError("a probe check tried to execute a command")

    monkeypatch.setattr(probe.subprocess, "run", _boom)
    monkeypatch.setattr(probe.subprocess, "Popen", _boom)
    monkeypatch.setattr(probe.os, "system", _boom)
    if hasattr(probe.os, "startfile"):
        monkeypatch.setattr(probe.os, "startfile", _boom)

    # Every verdict path that can carry the exclusion command as its `fix`.
    verdicts = [
        probe.check_av({}, cloud_events=0, host_dir=r"C:\X\Host"),
        probe.check_av({"realtime": True, "cloudLevel": 2, "tamper": False},
                       cloud_events=6, host_dir=r"C:\X\Host"),
        probe.check_launch_time(21.4, ok=True, host_dir=r"C:\X\Host"),
    ]
    for v in verdicts:
        assert v.get("fixable") is not True, \
            "an AV-exclusion remedy must never be marked self-applying"
        assert "Add-MpPreference" in (v.get("fix") or ""), \
            "the user still gets the command to run"


# ---------------------------------------------------------------------------
# yt-dlp packaging: the onefile build re-extracts ~145 files per launch, which is
# what AV kept rescanning.
# ---------------------------------------------------------------------------

def test_directory_build_passes_and_onefile_is_fixable():
    ok = probe.check_ytdlp_build(has_internal=True, exe_bytes=7_700_000)
    assert ok["status"] == "pass"
    bad = probe.check_ytdlp_build(has_internal=False, exe_bytes=18_000_000)
    assert bad["status"] == "fail" and bad["fixable"] is True
    assert "onefile" in bad["detail"].lower()


# ---------------------------------------------------------------------------
# Debris the incident produced
# ---------------------------------------------------------------------------

def test_orphans_are_reported_with_their_pids_and_are_fixable():
    v = probe.check_orphans([{"pid": 40052, "name": "yt-dlp.exe", "orphan": True},
                             {"pid": 111, "name": "yt-dlp.exe", "orphan": False}])
    assert v["status"] == "fail" and v["fixable"] is True
    assert "40052" in v["detail"]
    assert "111" not in v["detail"], "a live, parented process is not an orphan"


def test_no_orphans_passes():
    assert probe.check_orphans([])["status"] == "pass"


def test_stale_extraction_dirs_are_fixable_and_sized():
    v = probe.check_stale_mei([{"name": "_MEI1", "bytes": 30_000_000},
                               {"name": "_MEI2", "bytes": 30_000_000}])
    assert v["status"] == "fail" and v["fixable"] is True
    assert "2" in v["detail"]


def test_missing_binaries_are_named_individually():
    v = probe.check_binaries({"ffmpeg": True, "yt-dlp": True, "deno": False})
    assert v["status"] == "fail"
    assert "deno" in v["detail"] and "ffmpeg" not in v["detail"]


# ---------------------------------------------------------------------------
# Summary shape driving the card above the console
# ---------------------------------------------------------------------------

def test_summary_counts_pass_fail_and_fixed():
    items = [{"status": "pass"}, {"status": "fail"}, {"status": "fixed"},
             {"status": "fail"}, {"status": "warn"}]
    s = probe.summarize(items)
    assert s["passed"] == 1 and s["failed"] == 2 and s["fixed"] == 1 and s["warned"] == 1


def test_summary_is_ok_only_when_nothing_failed():
    assert probe.summarize([{"status": "pass"}, {"status": "fixed"}])["ok"] is True
    assert probe.summarize([{"status": "pass"}, {"status": "fail"}])["ok"] is False


# ---------------------------------------------------------------------------
# Orchestration: narrate to the console, then one structured result
# ---------------------------------------------------------------------------

def test_handle_probe_narrates_each_check_then_sends_one_result(monkeypatch):
    sent, logs = [], []
    monkeypatch.setattr(mc, "send", lambda m: sent.append(dict(m)))
    monkeypatch.setattr(mc, "_hlog", lambda level, msg, src="host": logs.append((level, msg, src)))
    monkeypatch.setattr(probe, "_h", lambda: mc)
    monkeypatch.setattr(probe, "collect_state", lambda: {
        "launchSeconds": 0.37,
        "av": {"realtime": True, "cloudLevel": 2, "tamper": False},
        "cloudEvents": 0,
        "hostDir": r"C:\X\Host",
        "binaries": {"ffmpeg": True, "yt-dlp": True, "deno": True},
        "hasInternal": True,
        "exeBytes": 7_700_000,
        "orphans": [],
        "staleMei": [],
    })

    probe.handle_probe({"reqId": "p1"})

    assert wait_for(lambda: any(m.get("type") == "probe-result" for m in sent)), \
        "the probe must always settle with one structured result"
    results = [m for m in sent if m.get("type") == "probe-result"]
    assert len(results) == 1, "exactly one result frame, not one per check"
    r = results[0]
    assert r["reqId"] == "p1"
    assert r["summary"]["ok"] is True
    assert len(r["items"]) >= 5, "every check reports an item"
    assert all(l[2] == "probe" for l in logs), \
        "console lines are tagged src=probe so they read as one run"


def test_handle_probe_still_reports_when_a_check_raises(monkeypatch):
    """A probe that dies mid-run is worse than useless: it looks like the hang it
    was meant to diagnose."""
    sent = []
    monkeypatch.setattr(mc, "send", lambda m: sent.append(dict(m)))
    monkeypatch.setattr(mc, "_hlog", lambda *a, **k: None)
    monkeypatch.setattr(probe, "_h", lambda: mc)

    def boom():
        raise RuntimeError("collection failed")
    monkeypatch.setattr(probe, "collect_state", boom)

    probe.handle_probe({"reqId": "p2"})
    assert wait_for(lambda: any(m.get("type") == "probe-result" for m in sent)), \
        "a failed collection still settles the row"
    r = [m for m in sent if m.get("type") == "probe-result"][-1]
    assert r["summary"]["ok"] is False


def test_internal_dir_is_derived_from_the_exe_not_the_host_dir(tmp_path):
    """find_ytdlp() falls back to shutil.which(), so the exe is not always inside
    HERE. Looking for _internal next to HERE then reports a directory build as
    onefile — caught by running the probe for real against a checkout."""
    elsewhere = tmp_path / "somewhere"
    (elsewhere / "_internal").mkdir(parents=True)
    # Populated: an empty _internal is not a directory build (see below).
    (elsewhere / "_internal" / "base_library.zip").write_bytes(b"LIB")
    exe = elsewhere / "yt-dlp.exe"
    exe.write_bytes(b"x")
    assert probe.internal_dir_for(str(exe)) == str(elsewhere / "_internal")
    assert probe.has_internal_for(str(exe)) is True
    assert probe.has_internal_for(str(tmp_path / "nope" / "yt-dlp.exe")) is False
    assert probe.has_internal_for(None) is False


def test_probe_calls_an_empty_internal_what_the_downloader_calls_it(tmp_path):
    """The probe is the page a user reads to decide whether their install is
    sound. If it reported "directory build" for a state ensure_ytdlp re-fetches,
    the diagnostic would contradict the behaviour it is describing."""
    hollow = tmp_path / "hollow"
    (hollow / "_internal").mkdir(parents=True)
    exe = hollow / "yt-dlp.exe"
    exe.write_bytes(b"x")
    assert probe.has_internal_for(str(exe)) is False


# ---------------------------------------------------------------------------
# Review findings (grok, nonce 9ef8a3adf27a, 2026-08-16). Every one of these is
# the same shape: a FAILURE that read as a PASS. A probe whose failure modes are
# silent passes is worse than no probe.
# ---------------------------------------------------------------------------

def test_absent_ytdlp_is_not_diagnosed_as_a_onefile_build():
    """Finding 1. exe missing -> hasInternal False, exeBytes 0 -> "onefile build
    (0.0 MB)". check_binaries already reports the absence; this was a second,
    mislabelled failure."""
    v = probe.check_ytdlp_build(has_internal=False, exe_bytes=0, exe_present=False)
    assert v["status"] == "skip", v
    assert "onefile" not in v["detail"].lower()


def test_a_launch_that_failed_is_not_reported_as_fast():
    """Finding 2. _time_ytdlp_launch swallowed every exception and still returned
    elapsed time, so a yt-dlp that could not start at all came back as ~0s and
    read as 'not being intercepted'."""
    v = probe.check_launch_time(0.02, ok=False)
    assert v["status"] == "fail", v
    assert "could not" in v["detail"].lower() or "failed" in v["detail"].lower()
    assert "not being intercepted" not in v["detail"]


def test_a_slow_launch_carries_the_exclusion_command_itself():
    """Finding 4. The command lived only on the AV item, which is 'pass' when
    cloud_events is 0 — and the UI only renders fail/warn items. A slow launch
    with 0 events therefore hid the one command that fixes it, which is exactly
    the case observed on 2026-08-16."""
    v = probe.check_launch_time(21.4, ok=True, host_dir=r"C:\X\Host")
    assert "Add-MpPreference" in (v.get("fix") or ""), \
        "the finding must carry its own remedy, not point at another item"
    assert r"C:\X\Host" in v["fix"]


def test_unreadable_av_state_is_not_reported_as_defender_off():
    """Finding 7. _powershell_json returns {} on ANY error, and an empty dict is
    indistinguishable from realtime=False — so a failed query asserted the
    machine was unprotected AND passed."""
    v = probe.check_av({}, cloud_events=0, host_dir=r"C:\X\Host")
    assert v["status"] == "warn", v
    assert "could not" in v["detail"].lower()
    assert "OFF" not in v["detail"], "absence of a reading is not a reading of OFF"


def test_warnings_do_not_render_as_all_checks_passed():
    """Finding 8. ok = failed == 0, so a warn-only run showed green 'All checks
    passed' while listing warnings underneath it."""
    assert probe.summarize([{"status": "pass"}, {"status": "warn"}])["ok"] is False
    assert probe.summarize([{"status": "pass"}, {"status": "pass"}])["ok"] is True


def test_skipped_checks_count_separately_and_do_not_fail_the_run():
    s = probe.summarize([{"status": "pass"}, {"status": "skip"}])
    assert s["skipped"] == 1 and s["ok"] is True and s["passed"] == 1


def test_collection_budget_fits_inside_the_ui_wait():
    """Finding 6. The UI dropped the result at 120s while collection could run
    60 + 45 + 45 + 45 = 195s, so a slow-but-working probe reported 'no result'."""
    assert probe.collection_budget_seconds() < probe.UI_WAIT_SECONDS, \
        "worst-case collection must finish before the UI stops waiting"


def test_fixable_items_are_labelled_as_fixable_not_as_fixed():
    """Finding 3. autofix was only ever SET, never read: nothing applied a fix,
    while the spec and UI both promised one. The flag now states that a remedy
    exists, which is what the probe actually delivers."""
    v = probe.check_stale_mei([{"name": "_MEI1", "bytes": 1}])
    assert v.get("fixable") is True
    assert "autofix" not in v, "a flag named autofix must not survive without an auto-fixer"
