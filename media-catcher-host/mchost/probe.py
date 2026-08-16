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

# Get-MpPreference returns this literal string for the exclusion fields when the
# caller is not elevated, and the host never is.
EXCLUSIONS_UNREADABLE = "N/A: Must be an administrator to view exclusions"

_MEI_RE = re.compile(r"^_MEI\w+$")


def _verdict(id, label, status, detail, fix=None, autofix=False):
    v = {"id": id, "label": label, "status": status, "detail": detail}
    if fix:
        v["fix"] = fix
    if autofix:
        v["autofix"] = True
    return v


# ---- checks (pure) --------------------------------------------------------

def check_launch_time(seconds):
    """THE antivirus verdict.

    Settings cannot answer this. During the incident real-time protection was
    OFF and the fault persisted, because disabling real-time monitoring does not
    unload the WdFilter minifilter — only a timed launch separated "AV is
    intercepting this" from "the network is broken".
    """
    if seconds < LAUNCH_SLOW_SECONDS:
        return _verdict("launch", "yt-dlp launch", "pass",
                        "%.2fs — not being intercepted" % seconds)
    return _verdict("launch", "yt-dlp launch", "fail",
                    "%.2fs — launches are being intercepted (a clean launch is ~0.4s)"
                    % seconds,
                    fix="Exclude the host directory from your antivirus (see the AV check).")


def check_av(av, cloud_events, host_dir):
    """Report what is readable unelevated; never claim to know the exclusions."""
    bits = ["Defender real-time %s" % ("ON" if av.get("realtime") else "OFF"),
            "cloud level %s" % av.get("cloudLevel"),
            "tamper protection %s" % ("on" if av.get("tamper") else "off"),
            "%s cloud-lookup events (2010) in the last 10 min" % cloud_events]
    if av.get("exclusions") == EXCLUSIONS_UNREADABLE:
        bits.append("exclusion list needs admin to read")
    detail = " · ".join(str(b) for b in bits)
    cmd = 'Add-MpPreference -ExclusionPath "%s"' % host_dir
    # Reported, never applied: it needs admin regardless, and a diagnostics
    # button that silently punches AV holes is shaped exactly like malware.
    status = "warn" if cloud_events else "pass"
    return _verdict("av", "Antivirus", status, detail, fix=cmd, autofix=False)


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
    d = internal_dir_for(exe)
    return bool(d) and os.path.isdir(d)


def check_ytdlp_build(has_internal, exe_bytes):
    """The onefile build re-extracts ~145 files to %TEMP% on EVERY launch, which
    is precisely what AV kept rescanning. The directory build extracts nothing."""
    if has_internal:
        return _verdict("ytdlpBuild", "yt-dlp packaging", "pass",
                        "directory build (_internal present) — nothing extracted per launch")
    return _verdict("ytdlpBuild", "yt-dlp packaging", "fail",
                    "onefile build (%.1f MB, no _internal) — re-extracts ~145 files every launch"
                    % (exe_bytes / 1048576.0),
                    fix="Replace with the yt-dlp_win.zip directory build.", autofix=True)


def check_orphans(procs):
    orphans = [p for p in procs if p.get("orphan")]
    if not orphans:
        return _verdict("orphans", "Stray processes", "pass", "none")
    return _verdict("orphans", "Stray processes", "fail",
                    "%d orphaned: %s" % (len(orphans),
                                         ", ".join("%s (%s)" % (p["pid"], p["name"])
                                                   for p in orphans)),
                    fix="Kill the process trees.", autofix=True)


def check_stale_mei(dirs):
    if not dirs:
        return _verdict("staleMei", "Extraction debris", "pass", "none")
    total = sum(d.get("bytes", 0) for d in dirs)
    return _verdict("staleMei", "Extraction debris", "fail",
                    "%d stale _MEI dirs, %.0f MB" % (len(dirs), total / 1048576.0),
                    fix="Delete them.", autofix=True)


def check_binaries(present):
    missing = sorted(k for k, v in present.items() if not v)
    if not missing:
        return _verdict("binaries", "Helper binaries", "pass",
                        "all present: %s" % ", ".join(sorted(present)))
    return _verdict("binaries", "Helper binaries", "fail",
                    "missing: %s" % ", ".join(missing),
                    fix="Fetch the missing binaries.", autofix=True)


def summarize(items):
    counts = {"passed": 0, "failed": 0, "fixed": 0, "warned": 0}
    for i in items:
        s = i.get("status")
        counts["passed" if s == "pass" else
                "failed" if s == "fail" else
                "fixed" if s == "fixed" else
                "warned" if s == "warn" else "passed"] += 1
    counts["ok"] = counts["failed"] == 0
    return counts


# ---- collection (the only part that touches the OS) -----------------------

def _time_ytdlp_launch(exe):
    if not exe or not os.path.isfile(exe):
        return None
    from mchost.downloads import _no_window
    cf, si = _no_window()
    t0 = time.time()
    try:
        p = subprocess.Popen([exe, "--version"], stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, creationflags=cf, startupinfo=si)
        p.communicate(timeout=60)
    except Exception:
        try:
            p.kill()
        except Exception:
            pass
    return time.time() - t0


def _powershell_json(script):
    """Run a FIXED script and parse its JSON. Never takes caller input."""
    import json
    try:
        from mchost.downloads import _no_window
        cf, si = _no_window()
        r = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                            "-Command", script], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=45,
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
    return {
        "hostDir": here,
        "launchSeconds": _time_ytdlp_launch(exe),
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

            secs = st.get("launchSeconds")
            if secs is not None:
                log(check_launch_time(secs))
            log(check_av(st.get("av") or {}, st.get("cloudEvents", 0),
                         st.get("hostDir", "")))
            log(check_binaries(st.get("binaries") or {}))
            log(check_ytdlp_build(st.get("hasInternal"), st.get("exeBytes", 0)))
            log(check_orphans(st.get("orphans") or []))
            log(check_stale_mei(st.get("staleMei") or []))
        except Exception as e:
            # A probe that dies mid-run looks exactly like the hang it exists to
            # diagnose, so it always settles.
            _h()._hlog("error", "probe failed: %s" % e, "probe")
            items.append(_verdict("probe", "Probe", "fail", "probe failed: %s" % e))

        summary = summarize(items)
        _h()._hlog("info", "probe: %d passed, %d failed, %d fixed"
                   % (summary["passed"], summary["failed"], summary["fixed"]), "probe")
        _h().send({"type": "probe-result", "reqId": reqid,
                   "summary": summary, "items": items})

    threading.Thread(target=worker, daemon=True).start()
