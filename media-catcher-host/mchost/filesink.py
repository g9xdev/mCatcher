"""Native JSON file sink for browser-fetched HLS/DASH bytes (Task 15).

The host is an execution worker/file sink only: it never chooses or emits
Firefox fallback. All validation/write/path/commit failures are bounded
file-error frames with failureCategory "local_io" and a stable reason.

Cross-module names (send, downloads_dir) resolve through the mc_host shim at
CALL time (`_h().<name>`) so monkeypatched fakes are always honored.
"""
from __future__ import annotations

import base64
import os
import threading
import uuid

# Firefox native-messaging payload ceiling is 1 MiB framed. Base64 expands by
# 4/3 plus JSON envelope, so keep decoded chunks well under that.
MAX_CHUNK_BYTES = 512 * 1024
MAX_UNACKED = 4

_WIN_RESERVED_CHARS = set('<>:"|?*')
_WIN_DEVICE_NAMES = frozenset({
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
})

_LOCK = threading.RLock()
_SINKS = {}          # sinkId -> _Sink
_PART_OWNERS = {}    # realpath(.part) -> sinkId
_BINDINGS = {}       # (jobId, attemptToken) -> sinkId


def _h():
    """Call-time shim lookup — same convention as mchost.downloads."""
    import mc_host
    return mc_host


def cleanup_file_sinks():
    """Detach and close every live file sink without emitting native frames.

    Used on native-messaging EOF / host exit so this process's bound .part
    files cannot block retry. Atomically empties the registries under _LOCK,
    then closes handles and removes only each detached sink's exact .part
    path outside the registry lock. Never removes final paths, never emits
    frames (stdout may be unavailable), and never raises.
    """
    try:
        with _LOCK:
            sinks = list(_SINKS.values())
            _SINKS.clear()
            _PART_OWNERS.clear()
            _BINDINGS.clear()
        for s in sinks:
            try:
                with s.lock:
                    if s.state == "open":
                        s.state = "terminal"
                    _close_handle_unlocked(s)
                    # Only the exact bound .part — never the final path.
                    _remove_part_unlocked(s)
            except Exception:
                pass
    except Exception:
        pass


def _reset_for_tests():
    """Close handles, drop partials, clear registries (test isolation only)."""
    cleanup_file_sinks()


class _Sink:
    __slots__ = (
        "sink_id", "job_id", "attempt_token", "requested_filename",
        "dir_path", "final_path", "part_path", "bytes_written", "next_seq",
        "unacked", "state", "handle", "lock",
    )

    def __init__(self, sink_id, job_id, attempt_token, requested_filename,
                 dir_path, final_path, part_path, handle):
        self.sink_id = sink_id
        self.job_id = job_id
        self.attempt_token = attempt_token
        self.requested_filename = requested_filename
        self.dir_path = dir_path
        self.final_path = final_path
        self.part_path = part_path
        self.bytes_written = 0
        self.next_seq = 0
        self.unacked = 0
        self.state = "open"  # open | terminal
        self.handle = handle
        self.lock = threading.RLock()


def _send(msg):
    """Emit via shim; never raise out of handlers."""
    try:
        _h().send(msg)
    except Exception:
        pass


def _error(reason, sink_id=None, job_id=None, attempt_token=None):
    msg = {
        "type": "file-error",
        "failureCategory": "local_io",
        "reason": reason,
    }
    if sink_id is not None:
        msg["sinkId"] = sink_id
    if job_id is not None:
        msg["jobId"] = job_id
    if attempt_token is not None:
        msg["attemptToken"] = attempt_token
    _send(msg)


def _nonblank_str(val):
    return isinstance(val, str) and bool(val.strip())


def _strict_nonneg_int(val):
    """Nonnegative mathematical integer, or None. Bool is never valid."""
    if isinstance(val, bool) or val is None:
        return None
    if isinstance(val, int):
        return val if val >= 0 else None
    if isinstance(val, float):
        import math
        if not math.isfinite(val) or not val.is_integer() or val < 0:
            return None
        return int(val)
    return None


def _is_safe_basename(name):
    """True only when name is a safe, preservable single-segment basename."""
    if not isinstance(name, str) or not name or not name.strip():
        return False
    # Reject path separators and absolute forms without sanitizing.
    if "/" in name or "\\" in name:
        return False
    if name in (".", ".."):
        return False
    if os.path.isabs(name):
        return False
    if os.path.basename(name) != name:
        return False
    # Control characters
    for ch in name:
        o = ord(ch)
        if o < 32 or o == 127:
            return False
        if ch in _WIN_RESERVED_CHARS:
            return False
    # Windows trailing space/dot is unsafe and would be altered by the FS.
    if name[-1] in (" ", "."):
        return False
    # Reserved device names (with or without extension)
    stem = name.split(".")[0].upper()
    if stem in _WIN_DEVICE_NAMES:
        return False
    return True


def _resolve_dir(dir_val):
    """Return (resolved_dir, reason_or_None)."""
    if dir_val is None:
        try:
            d = _h().downloads_dir()
        except Exception:
            return None, "invalid-dir"
        if not d or not isinstance(d, str):
            return None, "invalid-dir"
        try:
            real = os.path.realpath(d)
        except Exception:
            return None, "invalid-dir"
        if not os.path.isdir(real):
            return None, "invalid-dir"
        return real, None

    if not isinstance(dir_val, str) or not dir_val.strip():
        return None, "invalid-dir"
    if not os.path.isabs(dir_val):
        return None, "invalid-dir"
    try:
        real = os.path.realpath(dir_val)
    except Exception:
        return None, "invalid-dir"
    if not os.path.isdir(real):
        return None, "invalid-dir"
    return real, None


def _contained_final(dir_real, filename):
    """Join + realpath containment check. Returns final path or None."""
    candidate = os.path.join(dir_real, filename)
    try:
        final = os.path.realpath(candidate)
        # realpath of a non-existent path still normalizes parents.
        parent = os.path.realpath(os.path.dirname(final))
    except Exception:
        return None
    # Final must live directly under the bound directory (basename preserved).
    if parent != dir_real:
        return None
    if os.path.basename(final) != filename:
        return None
    # Prefix containment (defensive for alternate realpath quirks).
    sep = os.sep
    if not (final == dir_real or final.startswith(dir_real + sep)):
        return None
    return final


def _close_handle_unlocked(sink):
    """Best-effort close for paths that already report another failure."""
    h = sink.handle
    sink.handle = None
    if h is None:
        return True
    try:
        h.close()
        return True
    except Exception:
        return False


def _remove_part_unlocked(sink):
    """Best-effort .part removal. FileNotFound counts as already removed."""
    path = sink.part_path
    if not path:
        return True
    try:
        os.remove(path)
        return True
    except FileNotFoundError:
        return True
    except OSError:
        # Race: gone between checks / concurrent delete still counts clean.
        try:
            if not os.path.isfile(path):
                return True
        except Exception:
            pass
        return False
    except Exception:
        return False


def _unregister_unlocked(sink):
    """Drop registry entries for a sink (caller holds _LOCK)."""
    _SINKS.pop(sink.sink_id, None)
    key = (sink.job_id, sink.attempt_token)
    if _BINDINGS.get(key) == sink.sink_id:
        _BINDINGS.pop(key, None)
    try:
        part_key = os.path.realpath(sink.part_path) if sink.part_path else None
    except Exception:
        part_key = sink.part_path
    if part_key and _PART_OWNERS.get(part_key) == sink.sink_id:
        _PART_OWNERS.pop(part_key, None)


def _terminalize_cleanup(sink, reason):
    """Matching-token failure path: close, remove .part, unregister once.

    Returns True if this call performed the first terminalization.
    Caller must NOT hold _LOCK. Emits nothing — caller sends the error.
    Best-effort close/remove (reason already selected by caller).
    """
    with sink.lock:
        if sink.state != "open":
            return False
        sink.state = "terminal"
        _close_handle_unlocked(sink)
        _remove_part_unlocked(sink)
    with _LOCK:
        # Only unregister if still the live registry entry.
        if _SINKS.get(sink.sink_id) is sink:
            _unregister_unlocked(sink)
    return True


def _check_identity(sink, req, for_stale=True):
    """Return reason string if req does not match the live sink binding.

    Distinguishes stale-attempt (same sink + job, wrong token) from other
    identity mismatches. Does not mutate the sink.
    """
    job = req.get("jobId")
    token = req.get("attemptToken")
    if not _nonblank_str(job) or not _nonblank_str(token):
        return "invalid-identity"
    if job != sink.job_id:
        return "identity-mismatch"
    if token != sink.attempt_token:
        return "stale-attempt" if for_stale else "identity-mismatch"
    # Later frames must not rebind filename/dir.
    if "requestedFilename" in req and req.get("requestedFilename") is not None:
        if req.get("requestedFilename") != sink.requested_filename:
            return "rebind-rejected"
    if "dir" in req and req.get("dir") is not None:
        # Compare resolved form against bound directory.
        dval = req.get("dir")
        if not isinstance(dval, str) or not dval.strip():
            return "rebind-rejected"
        try:
            if os.path.realpath(dval) != sink.dir_path:
                return "rebind-rejected"
        except Exception:
            return "rebind-rejected"
    return None


def handle_file_open(req):
    job = req.get("jobId")
    token = req.get("attemptToken")
    name = req.get("requestedFilename")

    if not _nonblank_str(job) or not _nonblank_str(token) or not _nonblank_str(name):
        _error("invalid-identity")
        return
    # Use the exact requested filename (no strip/sanitize) once nonblank.
    if not isinstance(name, str) or not _is_safe_basename(name):
        _error("invalid-filename", job_id=job, attempt_token=token)
        return

    dir_real, dir_err = _resolve_dir(req.get("dir"))
    if dir_err:
        _error(dir_err, job_id=job, attempt_token=token)
        return

    final = _contained_final(dir_real, name)
    if final is None:
        _error("path-escape", job_id=job, attempt_token=token)
        return

    part = final + ".part"
    try:
        part_key = os.path.realpath(part)
    except Exception:
        _error("local-open-failed", job_id=job, attempt_token=token)
        return

    sink_id = uuid.uuid4().hex
    handle = None

    with _LOCK:
        if (job, token) in _BINDINGS:
            # Do not replace an active job+attempt binding.
            pass_err = "binding-exists"
        elif part_key in _PART_OWNERS:
            pass_err = "part-busy"
        else:
            pass_err = None
            try:
                # Exclusive create so two sinks cannot share a .part.
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_BINARY if hasattr(os, "O_BINARY") else (
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL
                )
                fd = os.open(part, flags, 0o644)
                handle = os.fdopen(fd, "wb")
            except Exception:
                pass_err = "local-open-failed"
                handle = None
            if handle is not None:
                sink = _Sink(
                    sink_id, job, token, name, dir_real, final, part, handle,
                )
                _SINKS[sink_id] = sink
                _PART_OWNERS[part_key] = sink_id
                _BINDINGS[(job, token)] = sink_id

    if pass_err is not None:
        if handle is not None:
            try:
                handle.close()
            except Exception:
                pass
            try:
                if os.path.isfile(part):
                    os.remove(part)
            except Exception:
                pass
        _error(pass_err, job_id=job, attempt_token=token)
        return

    # Emit outside the registry lock.
    _send({
        "type": "file-opened",
        "sinkId": sink_id,
        "jobId": job,
        "attemptToken": token,
    })


def handle_file_chunk(req):
    sink_id = req.get("sinkId")
    if not _nonblank_str(sink_id):
        _error("unknown-sink")
        return

    with _LOCK:
        sink = _SINKS.get(sink_id)

    if sink is None:
        _error("unknown-sink", sink_id=sink_id,
               job_id=req.get("jobId") if _nonblank_str(req.get("jobId")) else None,
               attempt_token=req.get("attemptToken") if _nonblank_str(req.get("attemptToken")) else None)
        return

    # Identity / rebind checks before any mutation.
    id_err = _check_identity(sink, req)
    if id_err:
        _error(id_err, sink_id=sink_id,
               job_id=req.get("jobId") if isinstance(req.get("jobId"), str) else None,
               attempt_token=req.get("attemptToken") if isinstance(req.get("attemptToken"), str) else None)
        return

    # Decode + validate payload before taking the sink write lock long-term.
    seq = _strict_nonneg_int(req.get("seq"))
    if seq is None:
        _error("invalid-seq", sink_id=sink_id, job_id=sink.job_id,
               attempt_token=sink.attempt_token)
        return

    length = _strict_nonneg_int(req.get("length"))
    if length is None:
        _error("invalid-length", sink_id=sink_id, job_id=sink.job_id,
               attempt_token=sink.attempt_token)
        return

    data_b64 = req.get("dataB64")
    if not isinstance(data_b64, str):
        _error("invalid-base64", sink_id=sink_id, job_id=sink.job_id,
               attempt_token=sink.attempt_token)
        return
    try:
        data = base64.b64decode(data_b64, validate=True)
    except Exception:
        _error("invalid-base64", sink_id=sink_id, job_id=sink.job_id,
               attempt_token=sink.attempt_token)
        return

    if len(data) != length:
        _error("length-mismatch", sink_id=sink_id, job_id=sink.job_id,
               attempt_token=sink.attempt_token)
        return

    if len(data) > MAX_CHUNK_BYTES:
        _error("oversized-chunk", sink_id=sink_id, job_id=sink.job_id,
               attempt_token=sink.attempt_token)
        return

    # Ordered write under per-sink lock. Registry lock is NOT held.
    write_err = None
    do_terminal = False
    with sink.lock:
        if sink.state != "open":
            write_err = "terminal-sink"
        elif seq != sink.next_seq:
            write_err = "invalid-seq"
        elif sink.unacked >= MAX_UNACKED:
            write_err = "window-full"
        else:
            # Reserve unacked slot before write so concurrent handlers observe it.
            sink.unacked += 1
            try:
                sink.handle.write(data)
                sink.handle.flush()
                sink.bytes_written += len(data)
                sink.next_seq = seq + 1
            except Exception:
                sink.unacked -= 1
                write_err = "write-failed"
                # Terminalize matching-token write failure.
                sink.state = "terminal"
                _close_handle_unlocked(sink)
                _remove_part_unlocked(sink)
                do_terminal = True

    if write_err == "write-failed" or do_terminal:
        with _LOCK:
            if _SINKS.get(sink_id) is sink:
                _unregister_unlocked(sink)
        _error("write-failed", sink_id=sink_id, job_id=sink.job_id,
               attempt_token=sink.attempt_token)
        return

    if write_err:
        _error(write_err, sink_id=sink_id, job_id=sink.job_id,
               attempt_token=sink.attempt_token)
        return

    # Ack only after the complete chunk is written. Never hold locks over send.
    _send({
        "type": "file-chunk-ack",
        "sinkId": sink_id,
        "seq": seq,
    })

    with sink.lock:
        if sink.state == "open":
            sink.unacked = max(0, sink.unacked - 1)


def handle_file_commit(req):
    sink_id = req.get("sinkId")
    if not _nonblank_str(sink_id):
        _error("unknown-sink")
        return

    with _LOCK:
        sink = _SINKS.get(sink_id)

    if sink is None:
        _error("unknown-sink", sink_id=sink_id,
               job_id=req.get("jobId") if _nonblank_str(req.get("jobId")) else None,
               attempt_token=req.get("attemptToken") if _nonblank_str(req.get("attemptToken")) else None)
        return

    id_err = _check_identity(sink, req)
    if id_err:
        _error(id_err, sink_id=sink_id,
               job_id=req.get("jobId") if isinstance(req.get("jobId"), str) else None,
               attempt_token=req.get("attemptToken") if isinstance(req.get("attemptToken"), str) else None)
        return

    final_path = None
    byte_count = 0
    fail_reason = None

    with sink.lock:
        if sink.state != "open":
            fail_reason = "terminal-sink"
        else:
            # Claim terminal before flush/replace so a concurrent abort/commit loses.
            sink.state = "terminal"
            handle = sink.handle
            sink.handle = None
            byte_count = sink.bytes_written
            part = sink.part_path
            final_path = sink.final_path
            try:
                if handle is not None:
                    handle.flush()
                    # Skip fsync only when the platform lacks the capability.
                    # A real OSError from fsync is a durability failure — fail closed.
                    if hasattr(os, "fsync"):
                        try:
                            os.fsync(handle.fileno())
                        except NotImplementedError:
                            pass
                    handle.close()
                os.replace(part, final_path)
            except Exception:
                # Close if still open; remove partial when possible; never
                # remove a successfully replaced final; never claim committed.
                if handle is not None:
                    try:
                        handle.close()
                    except Exception:
                        pass
                if part:
                    try:
                        os.remove(part)
                    except FileNotFoundError:
                        pass
                    except Exception:
                        pass
                fail_reason = "commit-failed"
                final_path = None

    if fail_reason == "terminal-sink":
        _error("terminal-sink", sink_id=sink_id, job_id=sink.job_id,
               attempt_token=sink.attempt_token)
        return

    # Unregister after terminal claim (success or failure) exactly once.
    with _LOCK:
        if _SINKS.get(sink_id) is sink:
            _unregister_unlocked(sink)

    if fail_reason:
        _error(fail_reason, sink_id=sink_id, job_id=sink.job_id,
               attempt_token=sink.attempt_token)
        return

    _send({
        "type": "file-committed",
        "sinkId": sink_id,
        "file": final_path,
        "bytes": byte_count,
    })


def handle_file_abort(req):
    sink_id = req.get("sinkId")
    if not _nonblank_str(sink_id):
        _error("unknown-sink")
        return

    with _LOCK:
        sink = _SINKS.get(sink_id)

    if sink is None:
        _error("unknown-sink", sink_id=sink_id,
               job_id=req.get("jobId") if _nonblank_str(req.get("jobId")) else None,
               attempt_token=req.get("attemptToken") if _nonblank_str(req.get("attemptToken")) else None)
        return

    id_err = _check_identity(sink, req)
    if id_err:
        _error(id_err, sink_id=sink_id,
               job_id=req.get("jobId") if isinstance(req.get("jobId"), str) else None,
               attempt_token=req.get("attemptToken") if isinstance(req.get("attemptToken"), str) else None)
        return

    with sink.lock:
        if sink.state != "open":
            # Already terminal — cannot produce a second success.
            already = True
            cleanup_ok = False
        else:
            already = False
            # Claim terminal first, then attempt required close + .part removal.
            sink.state = "terminal"
            # Abort must never remove an already committed final file.
            close_ok = _close_handle_unlocked(sink)
            remove_ok = _remove_part_unlocked(sink)
            cleanup_ok = close_ok and remove_ok

    if already:
        _error("terminal-sink", sink_id=sink_id, job_id=sink.job_id,
               attempt_token=sink.attempt_token)
        return

    # Unregister exactly once after terminal claim (success or cleanup failure).
    with _LOCK:
        if _SINKS.get(sink_id) is sink:
            _unregister_unlocked(sink)

    if not cleanup_ok:
        # Real close/remove failure: one bounded local_io, never file-aborted.
        _error("abort-failed", sink_id=sink_id, job_id=sink.job_id,
               attempt_token=sink.attempt_token)
        return

    _send({
        "type": "file-aborted",
        "sinkId": sink_id,
    })
