# In-process yt-dlp: killing the children a wedge leaves behind — design

Status: approved 2026-08-19.

## Why

`_ytdl_download_via_lib` runs yt-dlp as a library on a worker thread. Its
resolve-phase watchdog bounds silence and emits `{"type":"ytdl-error",
"reason":"stalled"}`, so the row stops lying to the user. But its only lever is
the cooperative `op["cancel_requested"]` flag, polled from yt-dlp's progress
hooks and from the log sink in `ytdlp_lib.download`.

When yt-dlp is genuinely wedged, neither ever fires again. The concrete case is
`--js-runtimes deno:<path>`: `yt_dlp/extractor/youtube/jsc/_builtin/deno.py`
runs the challenge solver through `proc.communicate_or_kill(stdin)` with **no
timeout**, so a hung deno parks the calling thread indefinitely, emitting
nothing. The flag is set and never read. The worker thread and its `_pget`
registration then survive for the life of the helper, and repeated occurrences
accumulate.

The exe path does not have this problem: `_StallWatch` calls `_safe_kill`, which
takes the whole process tree with `taskkill /T /F`, and that unblocks the reader
loop. This design gives the library path the same lever.

## Mechanism

### yt-dlp funnels every spawn through one class object

`yt_dlp.utils.Popen` is a `subprocess.Popen` subclass, and every yt-dlp
subprocess goes through it — deno and the other JS runtimes, ffmpeg, the cookie
helpers, the external downloaders. Every importer writes `from yt_dlp.utils
import Popen`, which binds *the class object itself*. Verified against the
vendored 2026.07.04 build: the `Popen` reachable from `deno.py`,
`postprocessor/ffmpeg.py` and `yt_dlp.utils` is one and the same object.

So wrapping `Popen.__init__` **in place** reaches every launch site regardless of
import order. Rebinding `yt_dlp.utils.Popen` would not: modules that already
imported the name would keep the original.

### `ytdlp_lib` observes; it does not kill

`ytdlp_lib` gains a private hook and one optional `download()` kwarg,
`on_child=None`. When a caller passes it, `download()` arms the hook for the
duration of the call and disarms it in a `finally`.

The registry is keyed by the **launching thread's** ident. yt-dlp does the
resolve work, including the JS challenge, on the thread that called
`extract_info`, and each job's `download()` runs on its own worker thread. Two
concurrent jobs therefore see only their own children, and one job's stall can
never take another job's healthy deno. A thread with no entry is a thread nobody
asked about, and the wrapper does nothing.

Every failure path is soft, because a download that works today must not start
failing to gain a watchdog:

- no `utils` attribute, or no `Popen` on it → hook not installed, logged once
- `super().__init__` raised → nothing spawned, so nothing is announced
- the sink raised → swallowed; a sink must never break a download

Installation is idempotent via a sentinel attribute on the class.

`ytdlp_lib` deliberately stops at observation. `_safe_kill` and the
process-tree policy live in `downloads.py`, and that boundary is worth keeping:
the library module knows how to watch yt-dlp, the download module decides what
to do about it.

### `downloads.py` owns the kill policy

`_ytdl_download_via_lib` collects announced children into a lock-guarded list,
pruning exited entries as it appends so a long job does not accumulate handles,
and closes over them in a `_kill_children()`.

On stall the watchdog acts in this order:

1. claim the terminal frame with `unless_progressing=True` — **unchanged**
2. set `op["cancel_requested"]`
3. `_safe_kill` each live child
4. log, then send `stalled`

The flag must be set **before** the kill. Killing deno unblocks
`communicate_or_kill`; yt-dlp then raises or logs the resulting error, the log
sink polls the flag on every level, and `Cancelled` propagates. That unwind is
what actually ends the worker — the kill only makes the poll reachable again.

The kill goes before the send because `_h().send` writes the native-messaging
pipe and can block; the worker should start moving first.

### The false-positive guarantee is inherited, not re-argued

Every kill sits inside the branch guarded by `_claim_terminal(unless_progressing=
True)`. `on_progress` remains a permanent disarm. A download that has started
transferring bytes cannot reach the kill, and neither can the ffmpeg it later
launches to merge.

### User cancel

`_pget_cancel` reaches the exe path's child through `j["proc"]`. A lib op has no
`proc`, so today a cancel of a wedged job sets a flag nothing will poll and
leaks identically. The op therefore carries the `kill_children` closure, and
`_pget_cancel` calls it in both branches, beside the existing `_safe_kill`.

## What remains open

If yt-dlp wedges with **no live child** — blocked inside Python itself — the
flag is still the only lever and the worker stays parked. `--socket-timeout 30`
bounds the ordinary socket reads, so this is a narrower residual than the deno
case, not an absent one.

The `_pget` registration is held until the thread really ends, rather than
released when the watchdog reports. The registry means "this job still holds
resources", and that stays true while the thread is parked: a retry of that id
is refused rather than silently racing a live writer for the same output path.
The `_ytdl_download_via_lib` docstring states this, replacing its current claim
that the remedy is weaker than `_StallWatch`'s.

## Tests

`test_ytdlp_lib.py` — the hook:

- a subprocess launched on the arming thread is handed to the sink
- one launched on another thread is not
- the hook is disarmed once `download()` returns
- the wrapped `__init__` still constructs the process
- a yt-dlp module with no `utils.Popen` still downloads
- installing twice does not double-wrap

`test_ytdl_protocol.py` — the policy:

- a wedged resolve kills the children yt-dlp spawned, after setting the flag
- a progressing download's children are never killed
- a user cancel kills them too
- the `_pget` registration is released once the killed worker unwinds

The existing `fake_download` stand-ins take explicit keyword arguments, so each
gains `on_child=None`. Without that the new call site raises `TypeError` and the
failure reads as a protocol bug rather than a stale fake.
