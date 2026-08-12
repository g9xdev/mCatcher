"""Structured pget-result + multi-range transfer tests (Task 12).

Uses local ThreadingHTTPServer fixtures. Every server is shut down and
server_close()'d in a finally block. Polling uses wait_for, not bare sleeps
(except controlled server pacing via Event gates).
"""
from __future__ import annotations

import errno
import os
import socket
import threading
import time
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from conftest import load_host, wait_for

mc = load_host()

# ---------------------------------------------------------------------------
# Server helpers
# ---------------------------------------------------------------------------

DEFAULT_PAYLOAD = b"0123456789abcdef" * 64  # 1024 bytes


class ServerState:
    def __init__(self, mode="range", payload=None, **opts):
        self.mode = mode
        self.payload = payload if payload is not None else DEFAULT_PAYLOAD
        self.opts = opts
        self.lock = threading.Lock()
        self.active = 0
        self.max_active = 0
        self.segment_gets = 0  # GETs with Range that are not probe bytes=0-0
        self.probe_gets = 0
        self.total_gets = 0
        self.hold = opts.get("hold")  # threading.Event: segment body waits while not set
        self.release_after = opts.get("release_after")  # Event set by test to free holds
        self.wrote_after_terminal = []
        self.terminal_gate = opts.get("terminal_gate")  # Event set by test when result seen


def _make_handler(state: ServerState):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            # redirect target
            if state.mode == "redirect" and path == "/from":
                host, port = self.server.server_address
                self.send_response(302)
                self.send_header("Location", "http://%s:%d/to" % (host, port))
                self.end_headers()
                return

            rng = self.headers.get("Range") or ""
            with state.lock:
                state.total_gets += 1
                is_probe = rng == "bytes=0-0"
                if is_probe:
                    state.probe_gets += 1
                elif rng.startswith("bytes="):
                    state.segment_gets += 1
                    state.active += 1
                    if state.active > state.max_active:
                        state.max_active = state.active

            try:
                self._serve(rng)
            finally:
                if rng.startswith("bytes=") and rng != "bytes=0-0":
                    with state.lock:
                        state.active -= 1

        def _serve(self, rng):
            mode = state.mode
            payload = state.payload
            opts = state.opts

            if mode == "429":
                self.send_response(429)
                self.end_headers()
                return
            if mode == "503":
                self.send_response(503)
                self.end_headers()
                return
            if mode == "416":
                self.send_response(416)
                self.send_header("Content-Range", "bytes */%d" % len(payload))
                self.end_headers()
                return
            if mode == "malformed-206":
                self.send_response(206)
                self.send_header("Content-Range", "bytes garbage")
                self.send_header("Content-Length", "1")
                self.end_headers()
                self.wfile.write(b"x")
                return
            if mode == "mismatch-206":
                # 206 but Content-Range does not match the probe request
                self.send_response(206)
                self.send_header("Content-Range", "bytes 5-5/%d" % len(payload))
                self.send_header("Content-Length", "1")
                self.end_headers()
                self.wfile.write(payload[5:6] if len(payload) > 5 else b"x")
                return
            if mode == "no-range":
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            if mode == "timeout-probe":
                time.sleep(float(opts.get("sleep", 5.0)))
                self.send_response(200)
                self.end_headers()
                return
            if mode == "reset-probe":
                # hard-close without response
                try:
                    self.connection.reset()
                except Exception:
                    try:
                        self.connection.close()
                    except Exception:
                        pass
                return
            if mode == "short-read":
                # Valid probe, short segment bodies
                if rng == "bytes=0-0":
                    self._send_range(0, 0, payload)
                    return
                if rng.startswith("bytes="):
                    a, b = rng.split("=", 1)[1].split("-")
                    start, end = int(a), int(b)
                    # claim full range but send only 1 byte
                    self.send_response(206)
                    self.send_header(
                        "Content-Range",
                        "bytes %d-%d/%d" % (start, end, len(payload)),
                    )
                    self.send_header("Content-Length", "1")
                    self.end_headers()
                    self.wfile.write(payload[start:start + 1])
                    return
            if mode == "later-200":
                # Probe OK; first half of ranges OK; later ranges return full 200
                if rng == "bytes=0-0":
                    self._send_range(0, 0, payload)
                    return
                if rng.startswith("bytes="):
                    a, b = rng.split("=", 1)[1].split("-")
                    start, end = int(a), int(b)
                    # Treat later half of file as range-unsupported 200
                    if start >= len(payload) // 2:
                        self.send_response(200)
                        self.send_header("Content-Length", str(len(payload)))
                        self.end_headers()
                        # Optional: hold write so cancel/join races can be observed
                        if state.hold is not None and not state.hold.is_set():
                            state.hold.wait(timeout=2.0)
                        self.wfile.write(payload)
                        return
                    self._send_range(start, end, payload)
                    return
            if mode == "slow-range":
                if rng == "bytes=0-0":
                    self._send_range(0, 0, payload)
                    return
                if rng.startswith("bytes="):
                    a, b = rng.split("=", 1)[1].split("-")
                    start, end = int(a), int(b)
                    chunk = payload[start:end + 1]
                    self.send_response(206)
                    self.send_header(
                        "Content-Range",
                        "bytes %d-%d/%d" % (start, end, len(payload)),
                    )
                    self.send_header("Content-Length", str(len(chunk)))
                    self.end_headers()
                    # Pace body so cancel can land mid-transfer
                    mid = max(1, len(chunk) // 4)
                    self.wfile.write(chunk[:mid])
                    self.wfile.flush()
                    if state.hold is not None:
                        state.hold.wait(timeout=5.0)
                    # If a terminal gate is already set, record a late write attempt
                    if state.terminal_gate is not None and state.terminal_gate.is_set():
                        state.wrote_after_terminal.append(True)
                    try:
                        self.wfile.write(chunk[mid:])
                    except Exception:
                        pass
                    return
            if mode == "hold-probe":
                # Block only the capability probe so cancel-during-setup can race.
                if rng == "bytes=0-0":
                    if state.hold is not None and not state.hold.is_set():
                        state.hold.wait(timeout=10.0)
                    self._send_range(0, 0, payload)
                    return
                if rng.startswith("bytes="):
                    a, b = rng.split("=", 1)[1].split("-")
                    start, end = int(a), int(b)
                    self._send_range(start, end, payload)
                    return
            if mode in ("range", "redirect"):
                if not rng:
                    # full GET without Range — not used by pget, but be safe
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    return
                assert rng.startswith("bytes=")
                a, b = rng.split("=", 1)[1].split("-")
                start, end = int(a), int(b)
                # concurrency tracking hold for segment GETs
                if rng != "bytes=0-0" and state.hold is not None and not state.hold.is_set():
                    # Count concurrent while held
                    state.hold.wait(timeout=3.0)
                self._send_range(start, end, payload)
                return

            self.send_response(500)
            self.end_headers()

        def _send_range(self, start, end, payload):
            if start < 0 or end >= len(payload) or start > end:
                self.send_response(416)
                self.end_headers()
                return
            chunk = payload[start:end + 1]
            self.send_response(206)
            self.send_header(
                "Content-Range",
                "bytes %d-%d/%d" % (start, end, len(payload)),
            )
            self.send_header("Content-Length", str(len(chunk)))
            self.end_headers()
            self.wfile.write(chunk)

    return Handler


def run_server(mode="range", payload=None, **opts):
    state = ServerState(mode=mode, payload=payload, **opts)
    handler = _make_handler(state)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    # daemon so a forgotten shutdown cannot hang the suite
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd, state


def server_url(httpd, path="/file.mp4"):
    host, port = httpd.server_address
    return "http://%s:%d%s" % (host, port, path)


def shutdown_server(httpd):
    if httpd is None:
        return
    try:
        httpd.shutdown()
    finally:
        try:
            httpd.server_close()
        except Exception:
            pass


def last_result(sent):
    res = [m for m in sent if m.get("type") == "pget-result"]
    return res[-1] if res else None


def wait_result(sent, timeout=5.0):
    assert wait_for(lambda: any(m.get("type") == "pget-result" for m in sent), timeout=timeout)
    return last_result(sent)


def leftovers(tmp_path):
    names = []
    for root, _dirs, files in os.walk(tmp_path):
        for f in files:
            names.append(os.path.relpath(os.path.join(root, f), tmp_path))
    return names


def partish(names):
    return [n for n in names if ".part" in n or n.endswith(".part")]


# ---------------------------------------------------------------------------
# Happy path / core contract
# ---------------------------------------------------------------------------

def test_range_capable_completes_with_pget_result(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    httpd, _state = run_server("range")
    try:
        url = server_url(httpd)
        mc.handle_pget({
            "id": "job1",
            "attemptToken": "atk-1",
            "urls": [url],
            "name": "clip.mp4",
            "dir": str(tmp_path),
            "maxConnections": 2,
            "referer": "",
            "userAgent": "t",
        })
        res = wait_result(sent)
        assert res["type"] == "pget-result"
        assert res["id"] == "job1"
        assert res["status"] == "completed"
        assert res["mode"] == "multi-range"
        assert res["failureCategory"] is None
        assert res["partState"] == "committed"
        assert res["attemptToken"] == "atk-1"
        assert not any(m.get("type") == "pget-fallback" for m in sent)
        assert not any(m.get("type") == "pget-done" for m in sent)
        final = tmp_path / "clip.mp4"
        assert final.is_file()
        assert final.read_bytes() == DEFAULT_PAYLOAD
        assert partish(leftovers(tmp_path)) == []
    finally:
        shutdown_server(httpd)


def test_no_range_reports_range_unsupported_empty_part(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    httpd, _state = run_server("no-range")
    try:
        url = server_url(httpd)
        mc.handle_pget({
            "id": "job2",
            "attemptToken": "atk-2",
            "urls": [url],
            "name": "clip.mp4",
            "dir": str(tmp_path),
            "maxConnections": 4,
        })
        res = wait_result(sent)
        assert res["status"] == "failed"
        assert res["failureCategory"] == "range_unsupported"
        assert res["partState"] == "empty"
        assert res["mode"] == "multi-range"
        assert res["attemptToken"] == "atk-2"
        assert leftovers(tmp_path) == []
        assert not any(m.get("type") == "pget-fallback" for m in sent)
    finally:
        shutdown_server(httpd)


def test_http_429_is_not_range_unsupported(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    httpd, _state = run_server("429")
    try:
        url = server_url(httpd)
        mc.handle_pget({
            "id": "job3",
            "attemptToken": "atk-3",
            "urls": [url],
            "name": "clip.mp4",
            "dir": str(tmp_path),
            "maxConnections": 2,
        })
        res = wait_result(sent)
        assert res["failureCategory"] == "http_429"
        assert res["failureCategory"] != "range_unsupported"
        assert res["attemptToken"] == "atk-3"
        assert res["status"] == "failed"
        assert leftovers(tmp_path) == []
    finally:
        shutdown_server(httpd)


def test_http_503_is_not_range_unsupported(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    httpd, _state = run_server("503")
    try:
        url = server_url(httpd)
        mc.handle_pget({
            "id": "job503",
            "attemptToken": "atk-503",
            "urls": [url],
            "name": "clip.mp4",
            "dir": str(tmp_path),
            "maxConnections": 2,
        })
        res = wait_result(sent)
        assert res["failureCategory"] == "http_5xx_temporary"
        assert res["attemptToken"] == "atk-503"
        assert leftovers(tmp_path) == []
    finally:
        shutdown_server(httpd)


def test_malformed_206_is_not_range_unsupported(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    httpd, _state = run_server("malformed-206")
    try:
        url = server_url(httpd)
        mc.handle_pget({
            "id": "jobM",
            "attemptToken": "atk-m",
            "urls": [url],
            "name": "clip.mp4",
            "dir": str(tmp_path),
            "maxConnections": 2,
        })
        res = wait_result(sent)
        assert res["failureCategory"] == "permanent"
        assert res["failureCategory"] != "range_unsupported"
        assert leftovers(tmp_path) == []
    finally:
        shutdown_server(httpd)


def test_mismatch_206_is_not_range_unsupported(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    httpd, _state = run_server("mismatch-206")
    try:
        url = server_url(httpd)
        mc.handle_pget({
            "id": "jobMM",
            "attemptToken": "atk-mm",
            "urls": [url],
            "name": "clip.mp4",
            "dir": str(tmp_path),
            "maxConnections": 2,
        })
        res = wait_result(sent)
        assert res["failureCategory"] == "permanent"
        assert leftovers(tmp_path) == []
    finally:
        shutdown_server(httpd)


def test_http_416_is_not_range_unsupported(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    httpd, _state = run_server("416")
    try:
        url = server_url(httpd)
        mc.handle_pget({
            "id": "job416",
            "attemptToken": "atk-416",
            "urls": [url],
            "name": "clip.mp4",
            "dir": str(tmp_path),
            "maxConnections": 2,
        })
        res = wait_result(sent)
        assert res["failureCategory"] == "permanent"
        assert leftovers(tmp_path) == []
    finally:
        shutdown_server(httpd)


def test_redirect_to_valid_range_target_succeeds(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    httpd, _state = run_server("redirect")
    try:
        url = server_url(httpd, "/from")
        mc.handle_pget({
            "id": "jobR",
            "attemptToken": "atk-r",
            "urls": [url],
            "name": "clip.mp4",
            "dir": str(tmp_path),
            "maxConnections": 2,
            "userAgent": "t",
        })
        res = wait_result(sent)
        assert res["status"] == "completed"
        assert res["partState"] == "committed"
        assert res["attemptToken"] == "atk-r"
        assert (tmp_path / "clip.mp4").read_bytes() == DEFAULT_PAYLOAD
    finally:
        shutdown_server(httpd)


# ---------------------------------------------------------------------------
# Classifier unit tests (timeout / connection_reset)
# ---------------------------------------------------------------------------

def test_classify_timeout_and_connection_reset():
    # Prefer public helpers if exported; fall back to downloads module attribute.
    classify = getattr(mc, "_pget_classify_exc", None)
    if classify is None:
        from mchost import downloads as d
        classify = d._pget_classify_exc

    assert classify(socket.timeout("timed out")) == "timeout"
    assert classify(TimeoutError("timed out")) == "timeout"
    assert classify(urllib.error.URLError(socket.timeout("t"))) == "timeout"
    assert classify(ConnectionResetError("reset")) == "connection_reset"
    assert classify(BrokenPipeError("pipe")) == "connection_reset"
    assert classify(urllib.error.URLError(ConnectionResetError("r"))) == "connection_reset"
    err = OSError(errno.ECONNRESET, "Connection reset by peer")
    assert classify(err) == "connection_reset"


def test_probe_timeout_category(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    # Force probe open to raise timeout without a hanging server.
    def boom(*_a, **_k):
        raise socket.timeout("timed out")

    monkeypatch.setattr(mc, "_pget_open", boom)
    # Also patch on downloads module in case handle_pget binds there
    import mchost.downloads as d
    monkeypatch.setattr(d, "_pget_open", boom)

    mc.handle_pget({
        "id": "jobT",
        "attemptToken": "atk-t",
        "urls": ["http://127.0.0.1:1/nope"],
        "name": "clip.mp4",
        "dir": str(tmp_path),
        "maxConnections": 2,
    })
    res = wait_result(sent)
    assert res["failureCategory"] == "timeout"
    assert res["attemptToken"] == "atk-t"
    assert leftovers(tmp_path) == []


def test_probe_connection_reset_category(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))

    def boom(*_a, **_k):
        raise ConnectionResetError("Connection reset by peer")

    import mchost.downloads as d
    monkeypatch.setattr(d, "_pget_open", boom)
    monkeypatch.setattr(mc, "_pget_open", boom)

    mc.handle_pget({
        "id": "jobCR",
        "attemptToken": "atk-cr",
        "urls": ["http://127.0.0.1:1/nope"],
        "name": "clip.mp4",
        "dir": str(tmp_path),
        "maxConnections": 2,
    })
    res = wait_result(sent)
    assert res["failureCategory"] == "connection_reset"
    assert leftovers(tmp_path) == []


# ---------------------------------------------------------------------------
# Transfer failures
# ---------------------------------------------------------------------------

def test_short_read_segment_cleans_up(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    # >1 MiB so multi-range uses more than one segment with maxConnections>=2
    payload = b"S" * (2 * 1024 * 1024)
    httpd, _state = run_server("short-read", payload=payload)
    try:
        url = server_url(httpd)
        mc.handle_pget({
            "id": "jobSR",
            "attemptToken": "atk-sr",
            "urls": [url],
            "name": "clip.mp4",
            "dir": str(tmp_path),
            "maxConnections": 2,
            "userAgent": "t",
        })
        res = wait_result(sent, timeout=10)
        assert res["failureCategory"] == "short_read"
        assert res["status"] == "failed"
        assert res["attemptToken"] == "atk-sr"
        # cleanup: no final, no part leftovers
        assert "clip.mp4" not in leftovers(tmp_path) or not (tmp_path / "clip.mp4").exists()
        assert partish(leftovers(tmp_path)) == []
        assert res["partState"] == "empty"
    finally:
        shutdown_server(httpd)


def test_later_segment_200_is_range_unsupported_after_join(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    payload = b"L" * (2 * 1024 * 1024)
    hold = threading.Event()
    # Don't hold by default — just ensure join/cleanup happens before result semantics
    hold.set()
    httpd, state = run_server("later-200", payload=payload, hold=hold)
    try:
        url = server_url(httpd)
        mc.handle_pget({
            "id": "jobL200",
            "attemptToken": "atk-l200",
            "urls": [url],
            "name": "clip.mp4",
            "dir": str(tmp_path),
            "maxConnections": 2,
            "userAgent": "t",
        })
        res = wait_result(sent, timeout=10)
        assert res["failureCategory"] == "range_unsupported"
        assert res["partState"] == "empty"
        assert res["attemptToken"] == "atk-l200"
        assert partish(leftovers(tmp_path)) == []
        assert not (tmp_path / "clip.mp4").exists()
        # No workers still registered
        assert mc._PGET.get("jobL200") is None or "jobL200" not in getattr(mc, "_PGET", {})
        # Prefer downloads registry
        import mchost.downloads as d
        assert d._PGET.get("jobL200") is None
    finally:
        shutdown_server(httpd)


def test_path_failure_is_local_io(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    httpd, _state = run_server("range")
    try:
        url = server_url(httpd)
        import mchost.downloads as d

        def bad_makedirs(*_a, **_k):
            raise OSError(errno.EACCES, "denied")

        monkeypatch.setattr(d.os, "makedirs", bad_makedirs)
        mc.handle_pget({
            "id": "jobPath",
            "attemptToken": "atk-path",
            "urls": [url],
            "name": "clip.mp4",
            "dir": str(tmp_path),
            "maxConnections": 2,
            "userAgent": "t",
        })
        res = wait_result(sent)
        assert res["failureCategory"] == "local_io"
        assert res["status"] == "failed"
        assert res["partState"] != "committed"
        assert res["attemptToken"] == "atk-path"
        assert not any(m.get("type") == "pget-fallback" for m in sent)
    finally:
        shutdown_server(httpd)


def test_replace_failure_is_local_io(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    httpd, _state = run_server("range")
    try:
        url = server_url(httpd)
        import mchost.downloads as d

        def bad_replace(*_a, **_k):
            raise OSError(errno.EACCES, "replace denied")

        monkeypatch.setattr(d.os, "replace", bad_replace)
        mc.handle_pget({
            "id": "jobRep",
            "attemptToken": "atk-rep",
            "urls": [url],
            "name": "clip.mp4",
            "dir": str(tmp_path),
            "maxConnections": 2,
            "userAgent": "t",
        })
        res = wait_result(sent, timeout=10)
        assert res["failureCategory"] == "local_io"
        assert res["status"] == "failed"
        assert res["partState"] != "committed"
        assert not (tmp_path / "clip.mp4").exists()
    finally:
        shutdown_server(httpd)


def test_max_connections_caps_segment_concurrency(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    # >4 MiB so size-based segmenting wants several segments
    payload = b"M" * (5 * 1024 * 1024)
    hold = threading.Event()
    httpd, state = run_server("range", payload=payload, hold=hold)
    try:
        url = server_url(httpd)
        mc.handle_pget({
            "id": "jobMax",
            "attemptToken": "atk-max",
            "urls": [url],
            "name": "clip.mp4",
            "dir": str(tmp_path),
            "maxConnections": 2,
            "userAgent": "t",
        })
        # Wait until at least one segment GET is active, observe concurrency, then release
        assert wait_for(lambda: state.max_active >= 1 or state.segment_gets >= 1, timeout=5)
        # Give other workers a moment to pile up against the hold
        deadline = time.monotonic() + 0.3
        while time.monotonic() < deadline:
            if state.max_active >= 2:
                break
            time.sleep(0.01)
        observed = state.max_active
        hold.set()
        res = wait_result(sent, timeout=15)
        assert res["status"] == "completed"
        # Segment concurrency must never exceed the lease
        assert observed <= 2
        assert state.max_active <= 2
        # Segment GET count should reflect multi-segment transfer
        assert state.segment_gets >= 2
    finally:
        hold.set()
        shutdown_server(httpd)


def test_cancel_emits_cancelled_once(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    payload = b"C" * (3 * 1024 * 1024)
    hold = threading.Event()
    terminal_gate = threading.Event()
    httpd, state = run_server("slow-range", payload=payload, hold=hold, terminal_gate=terminal_gate)
    try:
        url = server_url(httpd)
        mc.handle_pget({
            "id": "jobCan",
            "attemptToken": "atk-can",
            "urls": [url],
            "name": "clip.mp4",
            "dir": str(tmp_path),
            "maxConnections": 2,
            "userAgent": "t",
        })
        # Wait until transfer is underway
        assert wait_for(lambda: state.segment_gets >= 1 or state.probe_gets >= 1, timeout=5)
        # Small paced wait so workers are in body
        assert wait_for(lambda: state.segment_gets >= 1, timeout=5)
        mc._pget_cancel({"id": "jobCan"})
        res = wait_result(sent, timeout=10)
        terminal_gate.set()
        hold.set()  # release any remaining body so server threads finish
        # Exactly one terminal result
        results = [m for m in sent if m.get("type") == "pget-result"]
        assert len(results) == 1
        assert res["status"] == "cancelled"
        assert res["failureCategory"] == "cancelled"
        assert res["attemptToken"] == "atk-can"
        assert res["partState"] in ("empty", "partial")
        # Late cancel is a no-op
        mc._pget_cancel({"id": "jobCan"})
        time.sleep(0.05)
        assert len([m for m in sent if m.get("type") == "pget-result"]) == 1
        # No progress after terminal (allow in-flight already-queued progress races
        # only before we mark gate; after join there should be no new writes)
        import mchost.downloads as d
        assert d._PGET.get("jobCan") is None
        assert not (tmp_path / "clip.mp4").exists()
    finally:
        hold.set()
        terminal_gate.set()
        shutdown_server(httpd)


def test_invalid_urls_permanent_with_token(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    mc.handle_pget({
        "id": "jobNone",
        "attemptToken": "atk-none",
        "urls": [],
        "name": "clip.mp4",
        "dir": str(tmp_path),
        "maxConnections": 2,
    })
    res = wait_result(sent)
    assert res["status"] == "failed"
    assert res["failureCategory"] == "permanent"
    assert res["attemptToken"] == "atk-none"
    assert res["partState"] == "empty"
    assert not any(m.get("type") == "pget-fallback" for m in sent)


def test_pget_send_result_core_shape(monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    send_result = getattr(mc, "_pget_send_result", None)
    if send_result is None:
        from mchost import downloads as d
        send_result = d._pget_send_result
    send_result("id1", "tok", "failed", "multi-range", "timeout", "empty")
    assert len(sent) == 1
    msg = sent[0]
    assert msg == {
        "type": "pget-result",
        "id": "id1",
        "attemptToken": "tok",
        "status": "failed",
        "mode": "multi-range",
        "failureCategory": "timeout",
        "partState": "empty",
    }


def test_reexport_handle_pget_identity():
    import mchost.downloads as d
    assert mc.handle_pget is d.handle_pget
    assert mc._pget_cancel is d._pget_cancel


def test_preexisting_final_not_deleted_on_failure(tmp_path, monkeypatch):
    """Failure cleanup must not delete an unrelated pre-existing final file
    whose name collides after dedup chooses a free sibling name — and must
    not wipe a file we never wrote. Create an unrelated marker file."""
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    marker = tmp_path / "unrelated.bin"
    marker.write_bytes(b"keep-me")
    httpd, _state = run_server("429")
    try:
        url = server_url(httpd)
        mc.handle_pget({
            "id": "jobPre",
            "attemptToken": "atk-pre",
            "urls": [url],
            "name": "clip.mp4",
            "dir": str(tmp_path),
            "maxConnections": 2,
        })
        res = wait_result(sent)
        assert res["failureCategory"] == "http_429"
        assert marker.read_bytes() == b"keep-me"
    finally:
        shutdown_server(httpd)


# ---------------------------------------------------------------------------
# Fix-round races: early cancel, pre-commit cancel, post-commit terminal
# ---------------------------------------------------------------------------

def test_cancel_during_blocked_probe_before_segments(tmp_path, monkeypatch):
    """Cancel immediately after handle_pget must win even while probe blocks.

    Mutation: registry inserted only after probe/path prep loses this cancel.
    """
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    import mchost.downloads as d

    hold = threading.Event()
    httpd, state = run_server("hold-probe", hold=hold)
    try:
        url = server_url(httpd)
        mc.handle_pget({
            "id": "jobEarlyCan",
            "attemptToken": "atk-early-can",
            "urls": [url],
            "name": "clip.mp4",
            "dir": str(tmp_path),
            "maxConnections": 2,
            "userAgent": "t",
        })
        # Caller can cancel as soon as handle_pget returns.
        assert wait_for(
            lambda: d._PGET.get("jobEarlyCan") is not None or state.probe_gets >= 1,
            timeout=5,
        )
        mc._pget_cancel({"id": "jobEarlyCan"})
        hold.set()
        res = wait_result(sent, timeout=10)
        results = [m for m in sent if m.get("type") == "pget-result"]
        assert len(results) == 1
        assert res["status"] == "cancelled"
        assert res["failureCategory"] == "cancelled"
        assert res["attemptToken"] == "atk-early-can"
        assert res["partState"] in ("empty", "partial")
        assert state.segment_gets == 0
        assert not (tmp_path / "clip.mp4").exists()
        assert partish(leftovers(tmp_path)) == []
        assert d._PGET.get("jobEarlyCan") is None
    finally:
        hold.set()
        shutdown_server(httpd)


def test_cancel_after_assembly_before_replace(tmp_path, monkeypatch):
    """Cancel during assembly must recheck before os.replace and not commit."""
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    import mchost.downloads as d

    entered = threading.Event()
    release = threading.Event()
    replace_calls = []
    orig_copy = d.shutil.copyfileobj
    orig_replace = d.os.replace

    def blocked_copy(fsrc, fdst, length=None):
        entered.set()
        assert release.wait(timeout=5.0)
        if length is None:
            return orig_copy(fsrc, fdst)
        return orig_copy(fsrc, fdst, length)

    def tracking_replace(src, dst, *a, **k):
        replace_calls.append((src, dst))
        return orig_replace(src, dst, *a, **k)

    monkeypatch.setattr(d.shutil, "copyfileobj", blocked_copy)
    monkeypatch.setattr(d.os, "replace", tracking_replace)

    httpd, _state = run_server("range")
    try:
        url = server_url(httpd)
        mc.handle_pget({
            "id": "jobAsmCan",
            "attemptToken": "atk-asm-can",
            "urls": [url],
            "name": "clip.mp4",
            "dir": str(tmp_path),
            "maxConnections": 2,
            "userAgent": "t",
        })
        assert wait_for(lambda: entered.is_set(), timeout=10)
        mc._pget_cancel({"id": "jobAsmCan"})
        release.set()
        res = wait_result(sent, timeout=10)
        results = [m for m in sent if m.get("type") == "pget-result"]
        assert len(results) == 1
        assert res["status"] == "cancelled"
        assert res["failureCategory"] == "cancelled"
        assert res["attemptToken"] == "atk-asm-can"
        assert replace_calls == []
        assert not (tmp_path / "clip.mp4").exists()
        assert partish(leftovers(tmp_path)) == []
        assert d._PGET.get("jobAsmCan") is None
    finally:
        release.set()
        shutdown_server(httpd)


def test_post_commit_progress_send_failure_still_completed(tmp_path, monkeypatch):
    """After os.replace, a final progress-send failure must not void the commit."""
    sent = []
    import mchost.downloads as d

    committed = {"ok": False}
    orig_replace = d.os.replace

    def arming_replace(src, dst, *a, **k):
        r = orig_replace(src, dst, *a, **k)
        committed["ok"] = True
        return r

    def flaky_send(msg):
        m = dict(msg)
        if committed["ok"] and m.get("type") == "pget-progress":
            raise RuntimeError("progress send failed after commit")
        sent.append(m)

    monkeypatch.setattr(d.os, "replace", arming_replace)
    monkeypatch.setattr(mc, "send", flaky_send)

    httpd, _state = run_server("range")
    try:
        url = server_url(httpd)
        mc.handle_pget({
            "id": "jobProgFail",
            "attemptToken": "atk-prog-fail",
            "urls": [url],
            "name": "clip.mp4",
            "dir": str(tmp_path),
            "maxConnections": 2,
            "userAgent": "t",
        })
        res = wait_result(sent, timeout=10)
        results = [m for m in sent if m.get("type") == "pget-result"]
        assert len(results) == 1
        assert res["status"] == "completed"
        assert res["failureCategory"] is None
        assert res["partState"] == "committed"
        assert res["attemptToken"] == "atk-prog-fail"
        assert (tmp_path / "clip.mp4").exists()
        assert (tmp_path / "clip.mp4").stat().st_size == len(DEFAULT_PAYLOAD)
        assert d._PGET.get("jobProgFail") is None
    finally:
        shutdown_server(httpd)


def test_post_commit_convert_failure_still_completed(tmp_path, monkeypatch):
    """Convert/notification failures after replace must still emit completed once."""
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    import mchost.downloads as d

    def boom_transcode(*_a, **_k):
        raise RuntimeError("transcode exploded after commit")

    monkeypatch.setattr(mc, "FFMPEG", "C:\\fake\\ffmpeg.exe")
    monkeypatch.setattr(d, "transcode", boom_transcode)

    httpd, _state = run_server("range")
    try:
        url = server_url(httpd)
        mc.handle_pget({
            "id": "jobConvFail",
            "attemptToken": "atk-conv-fail",
            "urls": [url],
            "name": "clip.mp4",
            "dir": str(tmp_path),
            "maxConnections": 2,
            "userAgent": "t",
            "convert": {"codec": "h265", "quality": "visually-lossless", "encoder": "auto"},
        })
        res = wait_result(sent, timeout=10)
        results = [m for m in sent if m.get("type") == "pget-result"]
        assert len(results) == 1
        assert res["status"] == "completed"
        assert res["failureCategory"] is None
        assert res["partState"] == "committed"
        assert res["attemptToken"] == "atk-conv-fail"
        assert (tmp_path / "clip.mp4").exists()
        assert d._PGET.get("jobConvFail") is None
        # No raw exception text in the terminal contract.
        blob = str(res)
        assert "transcode exploded" not in blob
        assert "RuntimeError" not in blob
    finally:
        shutdown_server(httpd)


def test_registered_precommit_exception_emits_structured_result(tmp_path, monkeypatch):
    """Unexpected post-registration pre-commit failures must still terminalize."""
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    import mchost.downloads as d

    def boom_lease(*_a, **_k):
        raise RuntimeError("lease setup boom")

    monkeypatch.setattr(d, "_pget_lease", boom_lease)

    httpd, _state = run_server("range")
    try:
        url = server_url(httpd)
        mc.handle_pget({
            "id": "jobLeaseBoom",
            "attemptToken": "atk-lease-boom",
            "urls": [url],
            "name": "clip.mp4",
            "dir": str(tmp_path),
            "maxConnections": 2,
            "userAgent": "t",
        })
        res = wait_result(sent, timeout=10)
        results = [m for m in sent if m.get("type") == "pget-result"]
        assert len(results) == 1
        assert res["status"] in ("failed", "cancelled")
        assert res["failureCategory"] in (
            "permanent", "local_io", "cancelled", "timeout", "connection_reset"
        )
        assert res["partState"] in ("empty", "partial")
        assert res["partState"] != "committed"
        assert res["attemptToken"] == "atk-lease-boom"
        assert not (tmp_path / "clip.mp4").exists()
        assert d._PGET.get("jobLeaseBoom") is None
        blob = str(res)
        assert "lease setup boom" not in blob
        assert "RuntimeError" not in blob
    finally:
        shutdown_server(httpd)


def test_thread_start_failure_clears_registry_and_emits_result(tmp_path, monkeypatch):
    """Thread.start() failure must not leave a permanent registry entry."""
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    import mchost.downloads as d

    # Start the fixture server before patching Thread: d.threading is the
    # stdlib threading module, so the patch would otherwise break run_server.
    httpd, _state = run_server("range")
    try:
        url = server_url(httpd)
        real_thread = d.threading.Thread
        starts = {"n": 0}

        class BoomStartThread(real_thread):
            def start(self):
                starts["n"] += 1
                # First Thread.start after the patch is handle_pget's worker.
                if starts["n"] == 1:
                    raise RuntimeError("thread start failed")
                return real_thread.start(self)

        monkeypatch.setattr(d.threading, "Thread", BoomStartThread)
        mc.handle_pget({
            "id": "jobStartFail",
            "attemptToken": "atk-start-fail",
            "urls": [url],
            "name": "clip.mp4",
            "dir": str(tmp_path),
            "maxConnections": 2,
            "userAgent": "t",
        })
        # Synchronous terminal if feasible under the host contract.
        assert wait_for(
            lambda: any(m.get("type") == "pget-result" for m in sent)
            or d._PGET.get("jobStartFail") is None,
            timeout=5,
        )
        res = last_result(sent)
        assert res is not None
        results = [m for m in sent if m.get("type") == "pget-result"]
        assert len(results) == 1
        assert res["status"] in ("failed", "cancelled")
        assert res["failureCategory"] in ("permanent", "local_io", "cancelled")
        assert res["attemptToken"] == "atk-start-fail"
        assert res["partState"] in ("empty", "partial")
        assert d._PGET.get("jobStartFail") is None
        assert not (tmp_path / "clip.mp4").exists()
    finally:
        shutdown_server(httpd)

# ---------------------------------------------------------------------------
# Task 13: native single-connection transfer + live connection lease
# ---------------------------------------------------------------------------

def _last_ack(sent, jid=None):
    acks = [
        m for m in sent
        if m.get("type") == "pget-limit-ack" and (jid is None or m.get("id") == jid)
    ]
    return acks[-1] if acks else None


def _wait_ack(sent, jid, timeout=5.0):
    assert wait_for(
        lambda: any(
            m.get("type") == "pget-limit-ack" and m.get("id") == jid for m in sent
        ),
        timeout=timeout,
    )
    return _last_ack(sent, jid)


def test_pget_single_writes_exact_filename_no_range(tmp_path, monkeypatch):
    """pget-single: full-body GET (no Range), exact name, completed/single-connection."""
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    ranges_seen = []
    payload = DEFAULT_PAYLOAD

    class NoRangeTrack(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def do_GET(self):
            ranges_seen.append(self.headers.get("Range"))
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), NoRangeTrack)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        url = server_url(httpd)
        mc.handle_pget_single({
            "id": "jobS",
            "attemptToken": "atk-s",
            "urls": [url],
            "name": "11238-makemebi.net.mp4",
            "dir": str(tmp_path),
            "maxConnections": 1,
            "userAgent": "t",
        })
        res = wait_result(sent, timeout=10)
        assert res["type"] == "pget-result"
        assert res["id"] == "jobS"
        assert res["status"] == "completed"
        assert res["mode"] == "single-connection"
        assert res["failureCategory"] is None
        assert res["partState"] == "committed"
        assert res["attemptToken"] == "atk-s"
        final = tmp_path / "11238-makemebi.net.mp4"
        assert final.is_file()
        assert final.read_bytes() == payload
        assert ranges_seen, "expected at least one GET"
        assert all(r is None for r in ranges_seen)
        assert not any(m.get("type") == "pget-fallback" for m in sent)
        assert not any(m.get("type") == "pget-done" for m in sent)
        assert partish(leftovers(tmp_path)) == []
        import mchost.downloads as d
        assert d._PGET.get("jobS") is None
    finally:
        shutdown_server(httpd)


def test_pget_single_stale_part_truncated_and_short_read(tmp_path, monkeypatch):
    """Pre-existing .part is truncated (wb); short Content-Length body is short_read."""
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    name = "clip.mp4"
    part = tmp_path / (name + ".part")
    part.write_bytes(b"STALE-JUNK-SHOULD-BE-GONE" * 8)
    assert part.stat().st_size > 0

    class ShortBody(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def do_GET(self):
            # Claim 1000 bytes but send only 3
            self.send_response(200)
            self.send_header("Content-Length", "1000")
            self.end_headers()
            self.wfile.write(b"abc")

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ShortBody)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        url = server_url(httpd)
        mc.handle_pget_single({
            "id": "jobShort",
            "attemptToken": "atk-short",
            "urls": [url],
            "name": name,
            "dir": str(tmp_path),
            "maxConnections": 1,
            "userAgent": "t",
        })
        res = wait_result(sent, timeout=10)
        assert res["status"] == "failed"
        assert res["mode"] == "single-connection"
        assert res["failureCategory"] == "short_read"
        assert res["attemptToken"] == "atk-short"
        assert res["partState"] == "empty"
        assert not (tmp_path / name).exists()
        assert partish(leftovers(tmp_path)) == []
        import mchost.downloads as d
        assert d._PGET.get("jobShort") is None
    finally:
        shutdown_server(httpd)


def test_pget_single_http_categories_and_no_firefox(tmp_path, monkeypatch):
    """Single 429 / 5xx / timeout / reset / local_io stay normalized; no fallback/done."""
    import mchost.downloads as d
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))

    httpd, _ = run_server("429")
    try:
        mc.handle_pget_single({
            "id": "s429", "attemptToken": "t429", "urls": [server_url(httpd)],
            "name": "a.mp4", "dir": str(tmp_path), "maxConnections": 1,
        })
        res = wait_result(sent)
        assert res["failureCategory"] == "http_429"
        assert res["mode"] == "single-connection"
        assert res["status"] == "failed"
    finally:
        shutdown_server(httpd)

    sent.clear()
    httpd, _ = run_server("503")
    try:
        mc.handle_pget_single({
            "id": "s503", "attemptToken": "t503", "urls": [server_url(httpd)],
            "name": "b.mp4", "dir": str(tmp_path), "maxConnections": 1,
        })
        res = wait_result(sent)
        assert res["failureCategory"] == "http_5xx_temporary"
    finally:
        shutdown_server(httpd)

    sent.clear()

    def boom_timeout(*_a, **_k):
        raise socket.timeout("timed out")

    monkeypatch.setattr(d, "_pget_open", boom_timeout)
    monkeypatch.setattr(mc, "_pget_open", boom_timeout)
    mc.handle_pget_single({
        "id": "sTO", "attemptToken": "tTO",
        "urls": ["http://127.0.0.1:1/x"],
        "name": "c.mp4", "dir": str(tmp_path), "maxConnections": 1,
    })
    res = wait_result(sent)
    assert res["failureCategory"] == "timeout"
    sent.clear()

    def boom_reset(*_a, **_k):
        raise ConnectionResetError("reset")

    monkeypatch.setattr(d, "_pget_open", boom_reset)
    monkeypatch.setattr(mc, "_pget_open", boom_reset)
    mc.handle_pget_single({
        "id": "sRS", "attemptToken": "tRS",
        "urls": ["http://127.0.0.1:1/x"],
        "name": "d.mp4", "dir": str(tmp_path), "maxConnections": 1,
    })
    res = wait_result(sent)
    assert res["failureCategory"] == "connection_reset"
    sent.clear()

    # Restore open for local_io path via real server + bad makedirs
    monkeypatch.undo()
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    httpd, _ = run_server("no-range")
    try:
        def bad_makedirs(*_a, **_k):
            raise OSError(errno.EACCES, "denied")

        monkeypatch.setattr(d.os, "makedirs", bad_makedirs)
        mc.handle_pget_single({
            "id": "sIO", "attemptToken": "tIO",
            "urls": [server_url(httpd)],
            "name": "e.mp4", "dir": str(tmp_path), "maxConnections": 1,
        })
        res = wait_result(sent)
        assert res["failureCategory"] == "local_io"
        assert res["partState"] != "committed"
    finally:
        shutdown_server(httpd)

    assert not any(m.get("type") == "pget-fallback" for m in sent)
    assert not any(m.get("type") == "pget-done" for m in sent)


def test_pget_single_replace_failure_local_io(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    import mchost.downloads as d
    httpd, _ = run_server("no-range")
    try:
        def bad_replace(*_a, **_k):
            raise OSError(errno.EACCES, "replace denied")

        monkeypatch.setattr(d.os, "replace", bad_replace)
        mc.handle_pget_single({
            "id": "sRep", "attemptToken": "tRep",
            "urls": [server_url(httpd)],
            "name": "clip.mp4", "dir": str(tmp_path), "maxConnections": 1,
        })
        res = wait_result(sent, timeout=10)
        assert res["failureCategory"] == "local_io"
        assert res["status"] == "failed"
        assert res["mode"] == "single-connection"
        assert res["partState"] != "committed"
        assert not (tmp_path / "clip.mp4").exists()
    finally:
        shutdown_server(httpd)


def test_pget_single_cancel_and_thread_start_failure(tmp_path, monkeypatch):
    """Early/midstream cancel and Thread.start failure each yield one terminal."""
    import mchost.downloads as d
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))

    hold = threading.Event()
    body_started = threading.Event()

    class SlowFull(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        payload = b"Z" * (512 * 1024)

        def log_message(self, *args):
            pass

        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Length", str(len(self.payload)))
            self.end_headers()
            self.wfile.write(self.payload[:4096])
            self.wfile.flush()
            body_started.set()
            hold.wait(timeout=10.0)
            try:
                self.wfile.write(self.payload[4096:])
            except Exception:
                pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), SlowFull)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        mc.handle_pget_single({
            "id": "sCan", "attemptToken": "tCan",
            "urls": [server_url(httpd)],
            "name": "clip.mp4", "dir": str(tmp_path), "maxConnections": 1,
            "userAgent": "t",
        })
        assert wait_for(
            lambda: body_started.is_set() or d._PGET.get("sCan") is not None,
            timeout=5,
        )
        wait_for(lambda: body_started.is_set(), timeout=5)
        mc._pget_cancel({"id": "sCan"})
        res = wait_result(sent, timeout=10)
        hold.set()
        results = [m for m in sent if m.get("type") == "pget-result"]
        assert len(results) == 1
        assert res["status"] == "cancelled"
        assert res["failureCategory"] == "cancelled"
        assert res["attemptToken"] == "tCan"
        assert res["mode"] == "single-connection"
        assert res["partState"] in ("empty", "partial")
        assert not (tmp_path / "clip.mp4").exists()
        assert d._PGET.get("sCan") is None
        mc._pget_cancel({"id": "sCan"})
        time.sleep(0.05)
        assert len([m for m in sent if m.get("type") == "pget-result"]) == 1
    finally:
        hold.set()
        shutdown_server(httpd)

    sent.clear()
    httpd2, _ = run_server("no-range")
    try:
        real_thread = d.threading.Thread
        starts = {"n": 0}

        class BoomStartThread(real_thread):
            def start(self):
                starts["n"] += 1
                if starts["n"] == 1:
                    raise RuntimeError("thread start failed")
                return real_thread.start(self)

        monkeypatch.setattr(d.threading, "Thread", BoomStartThread)
        mc.handle_pget_single({
            "id": "sStart", "attemptToken": "tStart",
            "urls": [server_url(httpd2)],
            "name": "clip.mp4", "dir": str(tmp_path), "maxConnections": 1,
        })
        assert wait_for(
            lambda: any(m.get("type") == "pget-result" for m in sent)
            or d._PGET.get("sStart") is None,
            timeout=5,
        )
        res = last_result(sent)
        assert res is not None
        assert len([m for m in sent if m.get("type") == "pget-result"]) == 1
        assert res["attemptToken"] == "tStart"
        assert res["mode"] == "single-connection"
        assert d._PGET.get("sStart") is None
    finally:
        shutdown_server(httpd2)


def test_set_limit_zero_quiesces_replacement_opens_then_resumes(tmp_path, monkeypatch):
    """Two mirrors: open A blocks, gen1/limit0 acks, A fails, B silent while zero,
    gen2/limit1 resumes and completes. Event-driven — no arbitrary sleeps."""
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    import mchost.downloads as d

    payload = b"Q" * (2 * 1024 * 1024)
    a_segment_held = threading.Event()
    a_release_fail = threading.Event()
    b_segment_opens = {"n": 0}
    a_segment_opens = {"n": 0}
    lock = threading.Lock()

    def make_handler(name, fail_on_release=False):
        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_GET(self):
                rng = self.headers.get("Range") or ""
                if rng == "bytes=0-0":
                    self.send_response(206)
                    self.send_header(
                        "Content-Range", "bytes 0-0/%d" % len(payload)
                    )
                    self.send_header("Content-Length", "1")
                    self.end_headers()
                    self.wfile.write(payload[:1])
                    return
                if not rng.startswith("bytes="):
                    self.send_response(500)
                    self.end_headers()
                    return
                a, b = rng.split("=", 1)[1].split("-")
                start, end = int(a), int(b)
                chunk = payload[start:end + 1]
                with lock:
                    if name == "A":
                        a_segment_opens["n"] += 1
                    else:
                        b_segment_opens["n"] += 1
                if name == "A" and fail_on_release:
                    self.send_response(206)
                    self.send_header(
                        "Content-Range",
                        "bytes %d-%d/%d" % (start, end, len(payload)),
                    )
                    self.send_header("Content-Length", str(len(chunk)))
                    self.end_headers()
                    mid = min(4096, len(chunk))
                    self.wfile.write(chunk[:mid])
                    self.wfile.flush()
                    a_segment_held.set()
                    a_release_fail.wait(timeout=15.0)
                    try:
                        self.connection.close()
                    except Exception:
                        pass
                    return
                self.send_response(206)
                self.send_header(
                    "Content-Range",
                    "bytes %d-%d/%d" % (start, end, len(payload)),
                )
                self.send_header("Content-Length", str(len(chunk)))
                self.end_headers()
                self.wfile.write(chunk)

        return H

    httpd_a = ThreadingHTTPServer(
        ("127.0.0.1", 0), make_handler("A", fail_on_release=True)
    )
    httpd_b = ThreadingHTTPServer(
        ("127.0.0.1", 0), make_handler("B", fail_on_release=False)
    )
    ta = threading.Thread(target=httpd_a.serve_forever, daemon=True)
    tb = threading.Thread(target=httpd_b.serve_forever, daemon=True)
    ta.start()
    tb.start()
    try:
        url_a = server_url(httpd_a)
        url_b = server_url(httpd_b)
        mc.handle_pget({
            "id": "jobL",
            "attemptToken": "atk-L",
            "urls": [url_a, url_b],
            "name": "big.mp4",
            "dir": str(tmp_path),
            "maxConnections": 1,
            "providerGeneration": 0,
            "userAgent": "t",
        })
        assert wait_for(lambda: a_segment_held.is_set(), timeout=10)
        b_before_zero = b_segment_opens["n"]

        mc.handle_pget_set_limit({
            "id": "jobL", "maxConnections": 0, "providerGeneration": 1,
        })
        ack1 = _wait_ack(sent, "jobL", timeout=5)
        assert ack1["maxConnections"] == 0
        assert ack1["providerGeneration"] == 1
        assert ack1["id"] == "jobL"

        a_release_fail.set()

        def a_released_and_stable():
            op = d._PGET.get("jobL")
            if op is None:
                return True
            cv = op.get("lease_cv")
            if cv is None:
                return op.get("openConnections", 0) == 0
            with cv:
                return op.get("openConnections", 0) == 0 or op.get("maxConnections") == 0

        assert wait_for(a_released_and_stable, timeout=10)
        assert b_segment_opens["n"] == b_before_zero

        deadline = time.monotonic() + 0.4
        while time.monotonic() < deadline:
            assert b_segment_opens["n"] == b_before_zero
            if last_result(sent) is not None:
                break
            time.sleep(0.02)

        assert b_segment_opens["n"] == b_before_zero
        assert last_result(sent) is None

        mc.handle_pget_set_limit({
            "id": "jobL", "maxConnections": 1, "providerGeneration": 2,
        })
        assert wait_for(
            lambda: any(
                m.get("type") == "pget-limit-ack"
                and m.get("id") == "jobL"
                and m.get("providerGeneration") == 2
                for m in sent
            ),
            timeout=5,
        )
        ack2 = [
            m for m in sent
            if m.get("type") == "pget-limit-ack"
            and m.get("id") == "jobL"
            and m.get("providerGeneration") == 2
        ][-1]
        assert ack2["maxConnections"] == 1
        assert ack2["providerGeneration"] == 2

        res = wait_result(sent, timeout=20)
        assert res["status"] == "completed"
        assert res["mode"] == "multi-range"
        assert res["partState"] == "committed"
        assert res["attemptToken"] == "atk-L"
        assert (tmp_path / "big.mp4").read_bytes() == payload
        assert b_segment_opens["n"] >= 1 or a_segment_opens["n"] >= 2
        assert d._PGET.get("jobL") is None
    finally:
        a_release_fail.set()
        shutdown_server(httpd_a)
        shutdown_server(httpd_b)


def test_set_limit_positive_lowering_caps_replacement_opens(tmp_path, monkeypatch):
    """Lowering live lease never permits replacement opens above the new limit."""
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    import mchost.downloads as d

    payload = b"P" * (5 * 1024 * 1024)
    hold = threading.Event()
    active = {"n": 0, "max": 0}
    lock = threading.Lock()
    segment_phase = {"after_ack": False}

    class HoldRange(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def do_GET(self):
            rng = self.headers.get("Range") or ""
            if rng == "bytes=0-0":
                self.send_response(206)
                self.send_header(
                    "Content-Range", "bytes 0-0/%d" % len(payload)
                )
                self.send_header("Content-Length", "1")
                self.end_headers()
                self.wfile.write(payload[:1])
                return
            if rng.startswith("bytes="):
                a, b = rng.split("=", 1)[1].split("-")
                start, end = int(a), int(b)
                chunk = payload[start:end + 1]
                with lock:
                    active["n"] += 1
                    if active["n"] > active["max"]:
                        active["max"] = active["n"]
                try:
                    self.send_response(206)
                    self.send_header(
                        "Content-Range",
                        "bytes %d-%d/%d" % (start, end, len(payload)),
                    )
                    self.send_header("Content-Length", str(len(chunk)))
                    self.end_headers()
                    hold.wait(timeout=10.0)
                    self.wfile.write(chunk)
                finally:
                    with lock:
                        active["n"] -= 1
                return
            self.send_response(500)
            self.end_headers()

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), HoldRange)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        mc.handle_pget({
            "id": "jobLow",
            "attemptToken": "atk-low",
            "urls": [server_url(httpd)],
            "name": "big.mp4",
            "dir": str(tmp_path),
            "maxConnections": 2,
            "providerGeneration": 0,
            "userAgent": "t",
        })
        assert wait_for(lambda: active["n"] >= 2 or active["max"] >= 2, timeout=10)
        observed_before = active["max"]
        assert observed_before <= 2

        mc.handle_pget_set_limit({
            "id": "jobLow", "maxConnections": 1, "providerGeneration": 1,
        })
        ack = _wait_ack(sent, "jobLow")
        assert ack["maxConnections"] == 1
        assert ack["providerGeneration"] == 1
        segment_phase["after_ack"] = True

        hold.set()
        res = wait_result(sent, timeout=30)
        assert res["status"] == "completed"
        assert active["max"] <= 2
        assert d._PGET.get("jobLow") is None
    finally:
        hold.set()
        shutdown_server(httpd)


def test_set_limit_generation_monotonic_and_idempotent(tmp_path, monkeypatch):
    """Stale/same gen cannot raise; newer positive gen can resume; ack is honest."""
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    import mchost.downloads as d

    hold = threading.Event()
    httpd, state = run_server("hold-probe", hold=hold)
    try:
        mc.handle_pget({
            "id": "jobGen",
            "attemptToken": "atk-gen",
            "urls": [server_url(httpd)],
            "name": "clip.mp4",
            "dir": str(tmp_path),
            "maxConnections": 4,
            "providerGeneration": 0,
            "userAgent": "t",
        })
        assert wait_for(lambda: d._PGET.get("jobGen") is not None, timeout=5)
        op = d._PGET["jobGen"]

        mc.handle_pget_set_limit({
            "id": "jobGen", "maxConnections": 0, "providerGeneration": 5,
        })
        ack = _wait_ack(sent, "jobGen")
        assert ack["providerGeneration"] == 5
        assert ack["maxConnections"] == 0

        mc.handle_pget_set_limit({
            "id": "jobGen", "maxConnections": 4, "providerGeneration": 3,
        })
        assert wait_for(
            lambda: len([m for m in sent if m.get("type") == "pget-limit-ack"]) >= 2,
            timeout=3,
        )
        ack_stale = [m for m in sent if m.get("type") == "pget-limit-ack"][-1]
        assert ack_stale["providerGeneration"] == 5
        assert ack_stale["maxConnections"] == 0

        mc.handle_pget_set_limit({
            "id": "jobGen", "maxConnections": 3, "providerGeneration": 5,
        })
        assert wait_for(
            lambda: len([m for m in sent if m.get("type") == "pget-limit-ack"]) >= 3,
            timeout=3,
        )
        ack_same = [m for m in sent if m.get("type") == "pget-limit-ack"][-1]
        assert ack_same["providerGeneration"] == 5
        assert ack_same["maxConnections"] == 0

        mc.handle_pget_set_limit({
            "id": "jobGen", "maxConnections": True, "providerGeneration": True,
        })
        assert wait_for(
            lambda: len([m for m in sent if m.get("type") == "pget-limit-ack"]) >= 4,
            timeout=3,
        )
        ack_bool = [m for m in sent if m.get("type") == "pget-limit-ack"][-1]
        assert ack_bool["providerGeneration"] == 5
        assert ack_bool["maxConnections"] == 0

        mc.handle_pget_set_limit({
            "id": "jobGen", "maxConnections": 2, "providerGeneration": 6,
        })
        assert wait_for(
            lambda: any(
                m.get("type") == "pget-limit-ack"
                and m.get("providerGeneration") == 6
                for m in sent
            ),
            timeout=3,
        )
        ack_new = [
            m for m in sent
            if m.get("type") == "pget-limit-ack" and m.get("providerGeneration") == 6
        ][-1]
        assert ack_new["maxConnections"] == 2
        assert ack_new["providerGeneration"] == 6

        mc.handle_pget_set_limit({
            "id": "jobGen", "maxConnections": 99, "providerGeneration": 7,
        })
        assert wait_for(
            lambda: any(
                m.get("type") == "pget-limit-ack"
                and m.get("providerGeneration") == 7
                for m in sent
            ),
            timeout=3,
        )
        ack_cap = [
            m for m in sent
            if m.get("type") == "pget-limit-ack" and m.get("providerGeneration") == 7
        ][-1]
        assert ack_cap["maxConnections"] == 4
        assert op["maxConnections"] == 4

        hold.set()
        res = wait_result(sent, timeout=15)
        assert res["status"] == "completed"
    finally:
        hold.set()
        shutdown_server(httpd)


def test_set_limit_unknown_and_ytdlp_no_ack_cancel_wakes_waiters(tmp_path, monkeypatch):
    """Unknown id / yt-dlp registry entry do not claim application; cancel wakes waiters."""
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    import mchost.downloads as d

    mc.handle_pget_set_limit({
        "id": "no-such-job", "maxConnections": 0, "providerGeneration": 1,
    })
    time.sleep(0.05)
    assert not any(m.get("type") == "pget-limit-ack" for m in sent)

    class FakeProc:
        pass

    d._PGET["yt1"] = {"proc": FakeProc()}
    try:
        mc.handle_pget_set_limit({
            "id": "yt1", "maxConnections": 0, "providerGeneration": 1,
        })
        time.sleep(0.05)
        assert not any(m.get("type") == "pget-limit-ack" for m in sent)
    finally:
        d._PGET.pop("yt1", None)

    hold_body = threading.Event()
    payload = b"W" * (256 * 1024)

    class GateFull(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload[:1024])
            self.wfile.flush()
            hold_body.wait(timeout=10.0)
            try:
                self.wfile.write(payload[1024:])
            except Exception:
                pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), GateFull)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        mc.handle_pget_single({
            "id": "jobWake",
            "attemptToken": "atk-wake",
            "urls": [server_url(httpd)],
            "name": "clip.mp4",
            "dir": str(tmp_path),
            "maxConnections": 1,
            "providerGeneration": 0,
            "userAgent": "t",
        })
        assert wait_for(lambda: d._PGET.get("jobWake") is not None, timeout=5)
        mc.handle_pget_set_limit({
            "id": "jobWake", "maxConnections": 0, "providerGeneration": 1,
        })
        _wait_ack(sent, "jobWake")
        mc._pget_cancel({"id": "jobWake"})
        res = wait_result(sent, timeout=10)
        hold_body.set()
        assert res["status"] == "cancelled"
        assert res["failureCategory"] == "cancelled"
        assert d._PGET.get("jobWake") is None
    finally:
        hold_body.set()
        shutdown_server(httpd)


def test_mc_host_dispatch_and_reexports_task13():
    """mc_host routes pget-single / pget-set-limit; reexports are canonical."""
    import mchost.downloads as d
    import inspect

    assert mc.handle_pget_single is d.handle_pget_single
    assert mc.handle_pget_set_limit is d.handle_pget_set_limit

    src = inspect.getsource(mc.main)
    assert 'cmd == "pget-single"' in src
    assert 'cmd == "pget-set-limit"' in src
    assert "handle_pget_single" in src
    assert "handle_pget_set_limit" in src


def test_pget_single_missing_content_length_completes(tmp_path, monkeypatch):
    """Missing Content-Length may complete at EOF."""
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    payload = b"no-cl-body-bytes-ok"

    class NoCL(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(payload)

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), NoCL)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        mc.handle_pget_single({
            "id": "jobNoCL", "attemptToken": "atk-nocl",
            "urls": [server_url(httpd)],
            "name": "x.mp4", "dir": str(tmp_path), "maxConnections": 1,
        })
        res = wait_result(sent, timeout=10)
        assert res["status"] == "completed"
        assert res["mode"] == "single-connection"
        assert res["partState"] == "committed"
        assert (tmp_path / "x.mp4").read_bytes() == payload
    finally:
        shutdown_server(httpd)
