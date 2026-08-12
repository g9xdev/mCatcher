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
