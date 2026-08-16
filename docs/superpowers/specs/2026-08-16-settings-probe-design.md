# Settings probe — design

Status: approved 2026-08-16.

## Why

A night of debugging produced one download failure whose real cause was Windows
Defender scanning every `yt-dlp.exe` launch made by a browser-descended process.
The symptoms were indistinguishable from a network fault: zero CPU, zero
connections, a process blocked in a kernel wait, and a UI stuck on "Preparing".
Defender logged only `Information`-level events, in a channel nothing surfaces.

Every check that finally isolated it was run by hand. The probe encodes them so
the next occurrence is one click, not an evening.

## Entry point

One button in the Settings *Log console* card: **Run probe**. It replaces
*Run diagnostics*, whose environment report the probe subsumes — two buttons with
overlapping checks would only raise "which do I press?".

Output goes to the log console that already exists, as `src="probe"` lines. The
pipeline is already generic (`_hlog(level, msg, src)` → `{type:"log"}` →
`pushLog` → console), and the renderer already styles `src` and colours by level,
so this needs no rendering work.

A compact summary card renders above the console: counts of passed / failed /
warned / skipped, and the items needing attention with their remedies. Same shape
`handle_get_report` already uses — glance for the verdict, scroll the console for
the why.

## Checks

The probe **reports**; it does not change anything. Each finding names the remedy
so it can be applied deliberately.

This is narrower than the first draft of this spec, which promised auto-fix. That
was written before the code and never implemented: the `autofix` flag was set on
four checks and read by nothing, while the UI said "fixes what it safely can".
An external review caught it (grok, nonce 9ef8a3adf27a, 2026-08-16, finding 3).
Rather than ship the claim, the claim was withdrawn — the diagnosis is the value,
and applying fixes is a separate change that deserves its own consent model.

| Check | On failure |
| --- | --- |
| Host reachable (ping → pong) | report |
| Registration: HKCU key, manifest, `mc_host.bat` | report — re-run `bootstrap.ps1` |
| `ffmpeg` / `yt-dlp` / `deno` present | report — fetch them |
| yt-dlp is the directory build, not onefile | report — replace with the zip build |
| yt-dlp launch time | report — the AV verdict |
| AV state, cloud events, exclusion command | report — never auto-applies |
| Orphaned yt-dlp / deno processes | report — kill the trees |
| Stale `_MEI*` dirs in `%TEMP%` | report — delete them |
| Installed files match the shipped set | report |
| Cookies readable · YouTube reachable · disk space | report |

## The antivirus section

The host runs unelevated, and that is decisive. Verified on 2026-08-16:

Readable unelevated: `RealTimeProtectionEnabled`, `AntivirusEnabled`,
`AMServiceEnabled`, `MAPSReporting`, `CloudBlockLevel`, `CloudExtendedTimeout`,
`IsTamperProtected`, and the Defender operational event log.

NOT readable unelevated: `ExclusionPath`, `ExclusionProcess`,
`ExclusionExtension` — the cmdlet returns the literal string
`"N/A: Must be an administrator to view exclusions"`. `fltmc` is likewise denied.

So the probe cannot read the exclusion list, and must not pretend to. It leads
with behaviour instead:

**A timed `yt-dlp --version` launch is the verdict.** Settings and event counts
are corroboration. This ordering is not a preference — during the incident
real-time protection was *off* and the fault persisted, because disabling
real-time monitoring does not unload the `WdFilter` minifilter. Only the launch
timing distinguished "AV is intercepting this" from "the network is broken".

Healthy:

    [probe] AV: Defender real-time ON · cloud level 2 · tamper protection off
    [probe] AV: 0 cloud-lookup events (2010) in the last 10 min
    [probe] yt-dlp launch: 0.37s  → not being intercepted

Faulty:

    [probe] yt-dlp launch: 21.4s  → launches are being intercepted
    [probe] AV: real-time ON · cloud level 2 · 5 cloud-lookup events during that launch
    [probe] → almost certainly AV scanning. Exclusion needed (admin):
    [probe]     Add-MpPreference -ExclusionPath "<host dir>"

The probe never adds an exclusion. It needs admin regardless, and a diagnostics
button that silently punches holes in AV is shaped exactly like malware.

## Host down

Host-run only; no standalone script. The incident had a *live* host whose
subprocesses hung, which this covers. A genuinely dead host already surfaces as
"helper not connected" with an installer link. A second entry point would be a
second thing to keep in sync for a case the existing UI handles. Adding
`probe.ps1` later is cheap if it proves necessary.

## Architecture

New module `mchost/probe.py`. `downloads.py` is already past 4000 lines and this
is not downloads.

- Each check is a **pure function over injected state** — process list, file
  existence, measured durations, AV readings — returning a verdict record. No
  check reads the world directly.
- A thin collection layer gathers that state; only it touches the OS.
- `handle_probe(req)` orchestrates: run checks in order, `_hlog(..., src="probe")`
  per step, then emit one
  `{type: "probe-result", reqId, summary{passed,failed,warned,skipped,ok}, items[]}`.
- A verdict's `fixable` flag means *a remedy exists and is named in `fix`* — never
  that the probe applied one.

Failure must never read as success. Every check distinguishes "could not
determine" from "determined to be fine": an unreadable AV state warns rather than
reporting Defender OFF, a launch that never returned a version fails rather than
timing as fast, an absent yt-dlp skips the packaging check rather than being
classified as a onefile build, and a warning keeps `ok` false. The whole point of
the probe is to surface silent failures, so its own silent failures are the one
defect it cannot afford.

The UI wait must exceed `collection_budget_seconds()`, or a slow-but-working
probe reports "no result" — the same shape it exists to expose.

Cross-module names resolve through the `mc_host` shim at call time (`_h().<name>`),
matching the convention the other `mchost` modules follow.

## Testing

- Per-check unit tests over injected state: no real AV, binaries, or processes.
- One integration test drives `handle_probe` with fakes and asserts the emitted
  log sequence and the summary shape.
- A test pinning that the AV check **never** emits an `Add-MpPreference` call,
  only the command as text.
