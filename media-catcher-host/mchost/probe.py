"""Settings probe: the checks that isolated the Defender-scanning incident,
encoded so the next occurrence is one click instead of an evening.

Design: docs/superpowers/specs/2026-08-16-settings-probe-design.md

Structure: every check is a PURE function over state someone else collected, so
none of them needs a real antivirus, real binaries, or real processes to test.
`collect_state` is the only part that touches the OS, and `handle_probe` is the
orchestration that narrates to the log console and returns one structured result.

Cross-module names resolve through the mc_host shim at CALL time (`_h().<name>`),
the same convention the other mchost modules follow.
"""
import os
import re
import subprocess
import threading
import time


def _h():
    import mc_host
    return mc_host


# A yt-dlp launch is ~0.4s unencumbered. Anything past this is not slow, it is
# being held: the incident measured 20s+ with zero CPU and no connections.
LAUNCH_SLOW_SECONDS = 3.0

# Per-step ceilings, and the wait the UI gives the whole run. The UI must outlast
# the worst case or a slow-but-working probe reports "no result" — which is the
# same silent-failure shape the probe exists to expose.
LAUNCH_TIMEOUT_SECONDS = 60
PS_TIMEOUT_SECONDS = 20
PS_CALLS = 3                      # AV state, Defender events, orphan scan
UI_WAIT_SECONDS = 300


def collection_budget_seconds():
    """Worst case for collect_state, so the UI wait can be checked against it."""
    return LAUNCH_TIMEOUT_SECONDS + PS_TIMEOUT_SECONDS * PS_CALLS

# Get-MpPreference returns this literal string for the exclusion fields when the
# caller is not elevated, and the host never is.
EXCLUSIONS_UNREADABLE = "N/A: Must be an administrator to view exclusions"

_MEI_RE = re.compile(r"^_MEI\w+$")


def _verdict(id, label, status, detail, fix=None, fixable=False):
    """`fixable` states that a remedy exists and is named in `fix`. It does NOT
    mean the probe applied one — nothing here does. The flag was called
    `autofix` and was only ever set, never read, while the spec and UI both
    promised the fix would be applied."""
    v = {"id": id, "label": label, "status": status, "detail": detail}
    if fix:
        v["fix"] = fix
    # `fixable` is host-side bookkeeping: no extension code reads it
    # (grep "fixable" over media-catcher/ returns nothing). Kept so a future
    # check that IS safely fixable has somewhere to say so.
    if fixable:
        v["fixable"] = True
    return v


def exclusion_command(host_dir):
    return 'Add-MpPreference -ExclusionPath "%s"' % host_dir


# ---- checks (pure) --------------------------------------------------------

def check_launch_time(seconds, ok=True, host_dir=""):
    """THE antivirus verdict.

    Settings cannot answer this. During the incident real-time protection was
    OFF and the fault persisted, because disabling real-time monitoring does not
    unload the WdFilter minifilter — only a timed launch separated "AV is
    intercepting this" from "the network is broken".

    `ok` is False when the launch did not actually produce a version. Without it
    a yt-dlp that could not start returned ~0s and read as healthy.
    """
    if not ok:
        return _verdict("launch", "yt-dlp launch", "fail",
                        "could not launch yt-dlp (no version returned after %.2fs)" % seconds)
    if seconds < LAUNCH_SLOW_SECONDS:
        return _verdict("launch", "yt-dlp launch", "pass",
                        "%.2fs — not being intercepted" % seconds)
    # Carries its own remedy: pointing at the AV item hid the command whenever
    # that item was "pass", which is precisely the slow-launch-with-no-events case.
    return _verdict("launch", "yt-dlp launch", "fail",
                    "%.2fs — launches are being intercepted (a clean launch is ~0.4s)"
                    % seconds,
                    fix=exclusion_command(host_dir) if host_dir else
                        "Exclude the host directory from your antivirus.")


def check_av(av, cloud_events, host_dir):
    """Report what is readable unelevated; never claim to know the exclusions."""
    if not av:
        # _powershell_json returns {} on ANY failure, and an empty dict is
        # indistinguishable from realtime=False. Asserting "OFF" from a failed
        # read would claim the machine is unprotected on no evidence.
        return _verdict("av", "Antivirus", "warn",
                        "could not read antivirus state (the query failed)",
                        fix=exclusion_command(host_dir))
    bits = ["Defender real-time %s" % ("ON" if av.get("realtime") else "OFF"),
            "cloud level %s" % av.get("cloudLevel"),
            "tamper protection %s" % ("on" if av.get("tamper") else "off"),
            "%s cloud-lookup events (2010) in the last 10 min" % cloud_events]
    if av.get("exclusions") == EXCLUSIONS_UNREADABLE:
        bits.append("exclusion list needs admin to read")
    detail = " · ".join(str(b) for b in bits)
    # Reported, never applied: it needs admin regardless, and a diagnostics
    # button that silently punches AV holes is shaped exactly like malware.
    status = "warn" if cloud_events else "pass"
    return _verdict("av", "Antivirus", status, detail,
                    fix=exclusion_command(host_dir), fixable=False)


def internal_dir_for(exe):
    """Where the directory build's _internal sits: NEXT TO THE EXE.

    find_ytdlp() falls back to shutil.which(), so the exe is not always inside
    HERE. Looking beside HERE instead reports a perfectly good directory build as
    onefile — which is exactly what the first real run of this probe did.
    """
    if not exe:
        return None
    return os.path.join(os.path.dirname(os.path.abspath(exe)), "_internal")


def has_internal_for(exe):
    """Populated, not merely present — the same test downloads._has_internal
    applies, so the diagnostic never calls an install sound while the downloader
    is re-fetching it."""
    d = internal_dir_for(exe)
    if not d:
        return False
    try:
        return bool(os.listdir(d))
    except OSError:
        return False


def check_ytdlp_build(has_internal, exe_bytes, exe_present=True):
    """The onefile build re-extracts ~145 files to %TEMP% on EVERY launch, which
    is precisely what AV kept rescanning. The directory build extracts nothing.

    With no exe there is nothing to classify: reporting "onefile build (0.0 MB)"
    was a second, mislabelled failure on top of the one check_binaries already
    reports correctly.
    """
    if not exe_present:
        return _verdict("ytdlpBuild", "yt-dlp packaging", "skip",
                        "yt-dlp not installed — see the binaries check")
    if has_internal:
        return _verdict("ytdlpBuild", "yt-dlp packaging", "pass",
                        "directory build (_internal present) — nothing extracted per launch")
    return _verdict("ytdlpBuild", "yt-dlp packaging", "fail",
                    "onefile build (%.1f MB, no _internal) — re-extracts ~145 files every launch"
                    % (exe_bytes / 1048576.0),
                    fix="Replace with the yt-dlp_win.zip directory build.", fixable=True)


def check_orphans(procs):
    orphans = [p for p in procs if p.get("orphan")]
    if not orphans:
        return _verdict("orphans", "Stray processes", "pass", "none")
    return _verdict("orphans", "Stray processes", "fail",
                    "%d orphaned: %s" % (len(orphans),
                                         ", ".join("%s (%s)" % (p["pid"], p["name"])
                                                   for p in orphans)),
                    fix="Kill the process trees.", fixable=True)


def check_stale_mei(dirs):
    if not dirs:
        return _verdict("staleMei", "Extraction debris", "pass", "none")
    total = sum(d.get("bytes", 0) for d in dirs)
    return _verdict("staleMei", "Extraction debris", "fail",
                    "%d stale _MEI dirs, %.0f MB" % (len(dirs), total / 1048576.0),
                    fix="Delete them.", fixable=True)


def check_binaries(present):
    missing = sorted(k for k, v in present.items() if not v)
    if not missing:
        return _verdict("binaries", "Helper binaries", "pass",
                        "all present: %s" % ", ".join(sorted(present)))
    return _verdict("binaries", "Helper binaries", "fail",
                    "missing: %s" % ", ".join(missing),
                    fix="Fetch the missing binaries.", fixable=True)


def summarize(items):
    counts = {"passed": 0, "failed": 0, "fixed": 0, "warned": 0, "skipped": 0}
    buckets = {"pass": "passed", "fail": "failed", "fixed": "fixed",
               "warn": "warned", "skip": "skipped"}
    for i in items:
        counts[buckets.get(i.get("status"), "passed")] += 1
    # A warning is not a pass. `ok` gated on failures alone rendered a warn-only
    # run as green "All checks passed" with the warnings listed underneath it.
    counts["ok"] = counts["failed"] == 0 and counts["warned"] == 0
    return counts


# ---- collection (the only part that touches the OS) -----------------------

def _time_ytdlp_launch(exe):
    """Returns (seconds, ok). `ok` is False unless a version actually came back:
    swallowing the exception and returning elapsed time alone made a yt-dlp that
    could not start at all look like a fast, healthy launch."""
    if not exe or not os.path.isfile(exe):
        return None, False
    from mchost.downloads import _no_window
    cf, si = _no_window()
    t0 = time.time()
    p = None
    ok = False
    try:
        p = subprocess.Popen([exe, "--version"], stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, creationflags=cf, startupinfo=si)
        out, _ = p.communicate(timeout=LAUNCH_TIMEOUT_SECONDS)
        ok = p.returncode == 0 and bool((out or b"").strip())
    except Exception:
        try:
            if p:
                p.kill()
        except Exception:
            pass
    return time.time() - t0, ok


def _powershell_json(script):
    """Run a FIXED script and parse its JSON. Never takes caller input."""
    import json
    try:
        from mchost.downloads import _no_window
        cf, si = _no_window()
        r = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                            "-Command", script], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=PS_TIMEOUT_SECONDS,
                           creationflags=cf, startupinfo=si)
        return json.loads(r.stdout) if r.stdout.strip() else {}
    except Exception:
        return {}


_AV_SCRIPT = (
    "$p = Get-MpPreference; $s = Get-MpComputerStatus;"
    "[pscustomobject]@{"
    " realtime = $s.RealTimeProtectionEnabled;"
    " cloudLevel = $p.MAPSReporting;"
    " tamper = $s.IsTamperProtected;"
    " exclusions = ($p.ExclusionPath -join ';')"
    "} | ConvertTo-Json -Compress"
)

_EVENTS_SCRIPT = (
    "$e = Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Windows Defender/Operational';"
    " Id=2010; StartTime=(Get-Date).AddMinutes(-10)} -ErrorAction SilentlyContinue;"
    "[pscustomobject]@{ count = @($e).Count } | ConvertTo-Json -Compress"
)


def collect_state():
    """Gather everything the checks reason about. Replaced wholesale in tests."""
    from mchost.downloads import find_ytdlp, find_deno
    here = _h().HERE
    exe = find_ytdlp()
    tmp = os.environ.get("TEMP", "")
    stale = []
    try:
        for name in os.listdir(tmp):
            if _MEI_RE.match(name):
                d = os.path.join(tmp, name)
                size = 0
                for root, _dirs, files in os.walk(d):
                    for f in files:
                        try:
                            size += os.path.getsize(os.path.join(root, f))
                        except Exception:
                            pass
                stale.append({"name": name, "path": d, "bytes": size})
    except Exception:
        pass
    _launch = _time_ytdlp_launch(exe)
    return {
        "hostDir": here,
        "launchSeconds": _launch[0],
        "launchOk": _launch[1],
        "exePresent": bool(exe) and os.path.isfile(exe),
        "av": _powershell_json(_AV_SCRIPT),
        "cloudEvents": (_powershell_json(_EVENTS_SCRIPT) or {}).get("count", 0),
        "binaries": {"ffmpeg": bool(_h().FFMPEG), "yt-dlp": bool(exe),
                     "deno": bool(find_deno())},
        "hasInternal": has_internal_for(exe),
        "exeBytes": (os.path.getsize(exe) if exe and os.path.isfile(exe) else 0),
        "orphans": _find_orphans(),
        "staleMei": stale,
    }


def _find_orphans():
    """yt-dlp/deno processes whose parent is gone — the debris a killed launcher
    leaves behind when only the direct child was taken."""
    out = []
    if os.name != "nt":
        return out
    data = _powershell_json(
        "Get-CimInstance Win32_Process -Filter \"Name='yt-dlp.exe' OR Name='deno.exe'\" |"
        " ForEach-Object { $par = Get-CimInstance Win32_Process -Filter \"ProcessId=$($_.ParentProcessId)\""
        " -ErrorAction SilentlyContinue;"
        " [pscustomobject]@{ pid = $_.ProcessId; name = $_.Name; orphan = ($null -eq $par) } } |"
        " ConvertTo-Json -Compress")
    if isinstance(data, dict):
        data = [data] if data else []
    for d in data or []:
        out.append({"pid": d.get("pid"), "name": d.get("name"), "orphan": bool(d.get("orphan"))})
    return out


# ---- orchestration --------------------------------------------------------

def handle_probe(req):
    """Run every check, narrating to the log console, then send ONE result."""
    def worker():
        reqid = req.get("reqId")
        items = []

        def log(v):
            level = {"pass": "info", "fixed": "info", "warn": "warn"}.get(v["status"], "error")
            _h()._hlog(level, "%s: %s" % (v["label"], v["detail"]), "probe")
            if v.get("fix") and v["status"] in ("fail", "warn"):
                _h()._hlog("info", "  → %s" % v["fix"], "probe")
            items.append(v)

        try:
            _h()._hlog("info", "probe: starting", "probe")
            st = collect_state()

            host_dir = st.get("hostDir", "")
            secs = st.get("launchSeconds")
            if secs is not None:
                log(check_launch_time(secs, ok=st.get("launchOk", True),
                                      host_dir=host_dir))
            log(check_av(st.get("av") or {}, st.get("cloudEvents", 0), host_dir))
            log(check_binaries(st.get("binaries") or {}))
            log(check_ytdlp_build(st.get("hasInternal"), st.get("exeBytes", 0),
                                  exe_present=st.get("exePresent", True)))
            log(check_orphans(st.get("orphans") or []))
            log(check_stale_mei(st.get("staleMei") or []))
        except Exception as e:
            # A probe that dies mid-run looks exactly like the hang it exists to
            # diagnose, so it always settles.
            _h()._hlog("error", "probe failed: %s" % e, "probe")
            items.append(_verdict("probe", "Probe", "fail", "probe failed: %s" % e))

        summary = summarize(items)
        _h()._hlog("info", "probe: %d passed, %d failed, %d warned, %d skipped"
                   % (summary["passed"], summary["failed"], summary["warned"],
                      summary["skipped"]), "probe")
        _h().send({"type": "probe-result", "reqId": reqid,
                   "summary": summary, "items": items})

    threading.Thread(target=worker, daemon=True).start()
