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

        acks_before_bool = len([m for m in sent if m.get("type") == "pget-limit-ack"])
        mc.handle_pget_set_limit({
            "id": "jobGen", "maxConnections": True, "providerGeneration": True,
        })
        time.sleep(0.05)
        assert len([m for m in sent if m.get("type") == "pget-limit-ack"]) == acks_before_bool
        assert op["providerGeneration"] == 5
        assert op["maxConnections"] == 0

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


# ---------------------------------------------------------------------------
# Task 13 fix1 — registry identity fence, terminal quiescence, ack order
# ---------------------------------------------------------------------------

def _make_lease_op(gen=0, limit=1, cap=1):
    return {
        "stop": threading.Event(),
        "cancel_requested": False,
        "lease_cv": threading.Condition(),
        "ack_lock": threading.RLock(),
        "ack_sending": False,
        "ack_pending": False,
        "last_sent_gen": None,
        "last_sent_lim": None,
        "initial_cap": cap,
        "maxConnections": limit,
        "providerGeneration": gen,
        "openConnections": 0,
        "lease": cap,
        "n": 0,
        "final_path": None,
        "kind": "pget",
    }


def test_set_limit_identity_fence_after_same_id_replace(monkeypatch):
    """After lookup captures old op, same-id replace must not mutate either op or ack."""
    import mchost.downloads as d

    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    monkeypatch.setattr(d, "_h", lambda: mc)

    jid = "jobFence"
    old = _make_lease_op(gen=1, limit=2, cap=4)
    new = _make_lease_op(gen=0, limit=3, cap=4)
    old_gen, old_lim = old["providerGeneration"], old["maxConnections"]
    new_gen, new_lim = new["providerGeneration"], new["maxConnections"]

    entered = threading.Event()
    resume = threading.Event()
    first = {"done": False}

    class PausingMap(dict):
        def get(self, key, default=None):
            if key == jid and not first["done"] and key in self:
                val = dict.get(self, key, default)
                first["done"] = True
                entered.set()
                assert resume.wait(timeout=5.0)
                return val
            return dict.get(self, key, default)

    reg = PausingMap()
    reg[jid] = old
    monkeypatch.setattr(d, "_PGET", reg)

    err = []

    def runner():
        try:
            d.handle_pget_set_limit({
                "id": jid, "maxConnections": 0, "providerGeneration": 9,
            })
        except Exception as e:
            err.append(e)

    t = threading.Thread(target=runner)
    t.start()
    assert entered.wait(timeout=5.0)

    # Same-id replacement while set-limit still holds the old op reference.
    reg[jid] = new
    resume.set()
    t.join(timeout=5.0)
    assert not t.is_alive()
    assert err == []

    assert old["providerGeneration"] == old_gen
    assert old["maxConnections"] == old_lim
    assert new["providerGeneration"] == new_gen
    assert new["maxConnections"] == new_lim
    assert reg.get(jid) is new
    assert not any(m.get("type") == "pget-limit-ack" for m in sent)

    # Old unregister must not remove the new op.
    d._pget_unregister(jid, old)
    assert reg.get(jid) is new
    d._pget_unregister(jid, new)
    assert reg.get(jid) is None


def test_duplicate_same_id_active_start_rejects_without_stranding(tmp_path, monkeypatch):
    """Second active start with same id is rejected; first worker is not stranded."""
    import mchost.downloads as d

    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))

    hold = threading.Event()
    body_started = threading.Event()
    payload = b"D" * (256 * 1024)

    class SlowFull(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload[:2048])
            self.wfile.flush()
            body_started.set()
            hold.wait(timeout=15.0)
            try:
                self.wfile.write(payload[2048:])
            except Exception:
                pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), SlowFull)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        url = server_url(httpd)
        mc.handle_pget_single({
            "id": "jobDup",
            "attemptToken": "atk-first",
            "urls": [url],
            "name": "first.mp4",
            "dir": str(tmp_path),
            "maxConnections": 1,
            "providerGeneration": 0,
            "userAgent": "t",
        })
        assert wait_for(lambda: body_started.is_set(), timeout=5)
        first_op = d._PGET.get("jobDup")
        assert first_op is not None

        mc.handle_pget_single({
            "id": "jobDup",
            "attemptToken": "atk-second",
            "urls": [url],
            "name": "second.mp4",
            "dir": str(tmp_path),
            "maxConnections": 1,
            "providerGeneration": 0,
            "userAgent": "t",
        })
        assert wait_for(
            lambda: any(
                m.get("type") == "pget-result" and m.get("attemptToken") == "atk-second"
                for m in sent
            ),
            timeout=5,
        )
        second_res = [
            m for m in sent
            if m.get("type") == "pget-result" and m.get("attemptToken") == "atk-second"
        ][-1]
        assert second_res["status"] == "failed"
        assert second_res["failureCategory"] == "permanent"
        assert second_res["mode"] == "single-connection"
        assert d._PGET.get("jobDup") is first_op

        mc.handle_pget_set_limit({
            "id": "jobDup", "maxConnections": 0, "providerGeneration": 1,
        })
        ack = _wait_ack(sent, "jobDup", timeout=5)
        assert ack["providerGeneration"] == 1
        assert ack["maxConnections"] == 0
        assert first_op["providerGeneration"] == 1
        assert first_op["maxConnections"] == 0

        mc._pget_cancel({"id": "jobDup"})
        hold.set()
        assert wait_for(
            lambda: any(
                m.get("type") == "pget-result" and m.get("attemptToken") == "atk-first"
                for m in sent
            ),
            timeout=10,
        )
        first_res = [
            m for m in sent
            if m.get("type") == "pget-result" and m.get("attemptToken") == "atk-first"
        ][-1]
        assert first_res["status"] == "cancelled"
        assert first_res["failureCategory"] == "cancelled"
        assert d._PGET.get("jobDup") is None

        results = [m for m in sent if m.get("type") == "pget-result"]
        assert len(results) == 2
        tokens = {m["attemptToken"] for m in results}
        assert tokens == {"atk-first", "atk-second"}
    finally:
        hold.set()
        shutdown_server(httpd)


def test_single_terminal_quiesces_response_and_lease_before_result(tmp_path, monkeypatch):
    """At pget-result, response is closed and openConnections == 0 (one terminal)."""
    import mchost.downloads as d

    original_close = d._pget_close_resp
    original_open = d._pget_open

    def run_case(label, setup_open, expect_category, cancel=False):
        sent = []
        closed = {"n": 0}
        open_at_result = []

        def tracking_close(resp):
            if resp is not None:
                closed["n"] += 1
            return original_close(resp)

        def tracking_send(msg):
            m = dict(msg)
            if m.get("type") == "pget-result":
                op = d._PGET.get(m.get("id"))
                if op is not None:
                    cv = op.get("lease_cv")
                    if cv is not None:
                        with cv:
                            open_at_result.append(int(op.get("openConnections") or 0))
                    else:
                        open_at_result.append(int(op.get("openConnections") or 0))
                else:
                    open_at_result.append(0)
                open_at_result.append(closed["n"])
            sent.append(m)

        monkeypatch.setattr(mc, "send", tracking_send)
        monkeypatch.setattr(d, "_pget_close_resp", tracking_close)
        monkeypatch.setattr(d, "_pget_open", original_open)
        if hasattr(mc, "_pget_open"):
            monkeypatch.setattr(mc, "_pget_open", original_open)

        jid = "jobQ-%s" % label
        hold = threading.Event()
        body_started = threading.Event()
        httpd = None

        if setup_open == "429":
            httpd, _ = run_server("429")
        elif setup_open == "short":
            class ShortBody(BaseHTTPRequestHandler):
                protocol_version = "HTTP/1.1"

                def log_message(self, *a):
                    pass

                def do_GET(self):
                    self.send_response(200)
                    self.send_header("Content-Length", "1000")
                    self.end_headers()
                    self.wfile.write(b"abc")

            httpd = ThreadingHTTPServer(("127.0.0.1", 0), ShortBody)
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
        elif setup_open == "reset":
            def boom_reset(*_a, **_k):
                raise ConnectionResetError("reset")

            monkeypatch.setattr(d, "_pget_open", boom_reset)
            if hasattr(mc, "_pget_open"):
                monkeypatch.setattr(mc, "_pget_open", boom_reset)
        elif setup_open == "cancel":
            class SlowFull(BaseHTTPRequestHandler):
                protocol_version = "HTTP/1.1"
                payload = b"Z" * (512 * 1024)

                def log_message(self, *a):
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
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
        else:
            raise AssertionError(setup_open)

        try:
            urls = [server_url(httpd)] if httpd is not None else ["http://127.0.0.1:1/x"]
            mc.handle_pget_single({
                "id": jid,
                "attemptToken": "atk-%s" % label,
                "urls": urls,
                "name": "%s.mp4" % label,
                "dir": str(tmp_path),
                "maxConnections": 1,
                "userAgent": "t",
            })
            if cancel:
                assert wait_for(lambda: body_started.is_set(), timeout=5)
                mc._pget_cancel({"id": jid})
            res = wait_result(sent, timeout=10)
            hold.set()
            assert res["mode"] == "single-connection"
            assert res["failureCategory"] == expect_category
            results = [m for m in sent if m.get("type") == "pget-result" and m.get("id") == jid]
            assert len(results) == 1
            assert open_at_result[0] == 0, "%s openConnections at result: %r" % (label, open_at_result)
            # reset fails before a response object exists; other paths must close first.
            if setup_open != "reset":
                assert open_at_result[1] >= 1, (
                    "%s expected response closed before terminal: %r" % (label, open_at_result)
                )
                assert closed["n"] >= 1
            assert d._PGET.get(jid) is None
        finally:
            hold.set()
            if httpd is not None:
                shutdown_server(httpd)

    run_case("429", "429", "http_429")
    run_case("short", "short", "short_read")
    run_case("reset", "reset", "connection_reset")
    run_case("cancel", "cancel", "cancelled", cancel=True)


def test_set_limit_ack_generations_never_regress(tmp_path, monkeypatch):
    """Gen N+1 cannot apply while N's serialized ack send is blocked; order never regresses."""
    import mchost.downloads as d

    sent = []
    ack_gens = []
    lock = threading.Lock()
    t1_in_send = threading.Event()
    allow_t1_send = threading.Event()
    t2_entered = threading.Event()
    t2_applied = threading.Event()

    def tracking_send(msg):
        m = dict(msg)
        if m.get("type") == "pget-limit-ack":
            gen = m.get("providerGeneration")
            if gen == 1:
                t1_in_send.set()
                assert allow_t1_send.wait(timeout=5.0)
            with lock:
                sent.append(m)
                ack_gens.append(gen)
        else:
            with lock:
                sent.append(m)

    monkeypatch.setattr(mc, "send", tracking_send)
    monkeypatch.setattr(d, "_h", lambda: mc)

    jid = "jobAckOrder"
    hold = threading.Event()
    httpd, _state = run_server("hold-probe", hold=hold)
    try:
        mc.handle_pget({
            "id": jid,
            "attemptToken": "atk-ack",
            "urls": [server_url(httpd)],
            "name": "clip.mp4",
            "dir": str(tmp_path),
            "maxConnections": 2,
            "providerGeneration": 0,
            "userAgent": "t",
        })
        assert wait_for(lambda: d._PGET.get(jid) is not None, timeout=5)
        op = d._PGET[jid]
        err = []

        def call_limit(gen, lim, entered=None, applied=None):
            try:
                if entered is not None:
                    entered.set()
                d.handle_pget_set_limit({
                    "id": jid, "maxConnections": lim, "providerGeneration": gen,
                })
                if applied is not None and int(op.get("providerGeneration") or 0) >= gen:
                    applied.set()
            except Exception as e:
                err.append(e)

        t1 = threading.Thread(target=call_limit, args=(1, 1))
        t1.start()
        assert t1_in_send.wait(timeout=5.0), "gen1 must reach serialized ack send"
        assert int(op.get("providerGeneration") or 0) == 1
        assert int(op.get("maxConnections") or 0) == 1

        t2 = threading.Thread(
            target=call_limit, args=(2, 0), kwargs={"entered": t2_entered, "applied": t2_applied},
        )
        t2.start()
        assert t2_entered.wait(timeout=5.0)

        # While gen1 holds the ack serializer across send, gen2 must not apply.
        assert not wait_for(
            lambda: int(op.get("providerGeneration") or 0) >= 2, timeout=0.4,
        ), "gen2 applied while gen1 ack send still blocked"
        assert int(op.get("providerGeneration") or 0) == 1
        assert int(op.get("maxConnections") or 0) == 1
        with lock:
            assert 2 not in ack_gens

        allow_t1_send.set()
        assert wait_for(lambda: int(op.get("providerGeneration") or 0) >= 2, timeout=5)
        assert t2_applied.wait(timeout=5.0) or wait_for(
            lambda: any(g == 2 for g in list(ack_gens)), timeout=5,
        )

        t1.join(timeout=5)
        t2.join(timeout=5)
        assert not t1.is_alive() and not t2.is_alive()
        assert err == []

        with lock:
            gens = list(ack_gens)
        assert gens, "expected at least one limit ack"
        assert max(gens) == 2
        peak = -1
        for g in gens:
            assert g >= peak, "ack generation regressed: %r" % gens
            peak = max(peak, g)
        if 2 in gens:
            idx2 = gens.index(2)
            assert 1 not in gens[idx2 + 1 :], "obsolete gen1 after gen2: %r" % gens
        assert gens == sorted(gens)

        mc._pget_cancel({"id": jid})
        hold.set()
        res = wait_result(sent, timeout=15)
        assert res["status"] == "cancelled"
    finally:
        allow_t1_send.set()
        hold.set()
        try:
            mc._pget_cancel({"id": jid})
        except Exception:
            pass
        shutdown_server(httpd)


def test_set_limit_invalid_inputs_do_not_mutate_or_ack(tmp_path, monkeypatch):
    """Fractional/string/negative/bool/NaN/inf inputs must not apply or claim success."""
    import math
    import mchost.downloads as d

    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))

    hold = threading.Event()
    httpd, _state = run_server("hold-probe", hold=hold)
    try:
        mc.handle_pget({
            "id": "jobInv",
            "attemptToken": "atk-inv",
            "urls": [server_url(httpd)],
            "name": "clip.mp4",
            "dir": str(tmp_path),
            "maxConnections": 3,
            "providerGeneration": 2,
            "userAgent": "t",
        })
        assert wait_for(lambda: d._PGET.get("jobInv") is not None, timeout=5)
        op = d._PGET["jobInv"]
        assert op["providerGeneration"] == 2
        assert op["maxConnections"] == 3

        invalids = [
            {"maxConnections": 1, "providerGeneration": 1.5},
            {"maxConnections": 1.5, "providerGeneration": 3},
            {"maxConnections": 1, "providerGeneration": "1.5"},
            {"maxConnections": "2.0", "providerGeneration": 3},
            {"maxConnections": 1, "providerGeneration": -1},
            {"maxConnections": -1, "providerGeneration": 3},
            {"maxConnections": -5, "providerGeneration": 9},
            {"maxConnections": True, "providerGeneration": 3},
            {"maxConnections": 1, "providerGeneration": True},
            {"maxConnections": 1, "providerGeneration": float("nan")},
            {"maxConnections": 1, "providerGeneration": float("inf")},
            {"maxConnections": float("nan"), "providerGeneration": 3},
            {"maxConnections": float("-inf"), "providerGeneration": 3},
            {"maxConnections": object(), "providerGeneration": 3},
            {"maxConnections": 1, "providerGeneration": object()},
            {"maxConnections": None, "providerGeneration": 3},
            {"maxConnections": 1, "providerGeneration": None},
        ]
        for payload in invalids:
            before_acks = len([m for m in sent if m.get("type") == "pget-limit-ack"])
            before_gen = op["providerGeneration"]
            before_lim = op["maxConnections"]
            mc.handle_pget_set_limit({"id": "jobInv", **payload})
            # Invalid commands are synchronous: no mutation and no ack.
            after_acks = len([m for m in sent if m.get("type") == "pget-limit-ack"])
            assert after_acks == before_acks, "invalid claimed apply: %r" % payload
            assert op["providerGeneration"] == before_gen, payload
            assert op["maxConnections"] == before_lim, payload

        # Valid zero limit on a newer generation still applies (distinct from negative).
        mc.handle_pget_set_limit({
            "id": "jobInv", "maxConnections": 0, "providerGeneration": 3,
        })
        ack0 = _wait_ack(sent, "jobInv", timeout=5)
        assert ack0["providerGeneration"] == 3
        assert ack0["maxConnections"] == 0
        assert op["providerGeneration"] == 3
        assert op["maxConnections"] == 0

        # Valid newer generation still applies; valid integer-valued float is accepted.
        mc.handle_pget_set_limit({
            "id": "jobInv", "maxConnections": 1, "providerGeneration": 4.0,
        })
        ack = _wait_ack(sent, "jobInv", timeout=5)
        assert ack["providerGeneration"] == 4
        assert ack["maxConnections"] == 1
        assert op["providerGeneration"] == 4
        assert op["maxConnections"] == 1

        # Valid stale generation may ack current live state without raising it.
        mc.handle_pget_set_limit({
            "id": "jobInv", "maxConnections": 3, "providerGeneration": 1,
        })
        assert wait_for(
            lambda: any(
                m.get("type") == "pget-limit-ack"
                and m.get("id") == "jobInv"
                and m.get("providerGeneration") == 4
                for m in sent
            ),
            timeout=5,
        )
        assert op["providerGeneration"] == 4
        assert op["maxConnections"] == 1

        hold.set()
        res = wait_result(sent, timeout=15)
        assert res["status"] == "completed"
    finally:
        hold.set()
        shutdown_server(httpd)


def test_set_limit_reentrant_send_applies_newer_without_deadlock(tmp_path, monkeypatch):
    """Re-entrant set-limit from within gen N send applies N+1; acks are N then N+1."""
    import mchost.downloads as d

    sent = []
    ack_gens = []
    lock = threading.Lock()
    reentered = {"done": False}

    def tracking_send(msg):
        m = dict(msg)
        if m.get("type") == "pget-limit-ack":
            gen = m.get("providerGeneration")
            with lock:
                sent.append(m)
                ack_gens.append(gen)
            if gen == 1 and not reentered["done"]:
                reentered["done"] = True
                # Nested set-limit while outer gen1 send is still on the stack.
                d.handle_pget_set_limit({
                    "id": jid, "maxConnections": 0, "providerGeneration": 2,
                })
        else:
            with lock:
                sent.append(m)

    monkeypatch.setattr(mc, "send", tracking_send)
    monkeypatch.setattr(d, "_h", lambda: mc)

    jid = "jobReenter"
    hold = threading.Event()
    httpd, _state = run_server("hold-probe", hold=hold)
    try:
        mc.handle_pget({
            "id": jid,
            "attemptToken": "atk-re",
            "urls": [server_url(httpd)],
            "name": "clip.mp4",
            "dir": str(tmp_path),
            "maxConnections": 2,
            "providerGeneration": 0,
            "userAgent": "t",
        })
        assert wait_for(lambda: d._PGET.get(jid) is not None, timeout=5)
        op = d._PGET[jid]

        d.handle_pget_set_limit({
            "id": jid, "maxConnections": 1, "providerGeneration": 1,
        })
        assert wait_for(lambda: int(op.get("providerGeneration") or 0) >= 2, timeout=5)
        assert wait_for(lambda: 2 in list(ack_gens), timeout=5)

        with lock:
            gens = list(ack_gens)
        assert gens[:2] == [1, 2], "expected ack order N then N+1, got %r" % gens
        peak = -1
        for g in gens:
            assert g >= peak, "ack generation regressed: %r" % gens
            peak = max(peak, g)
        assert op["providerGeneration"] == 2
        assert op["maxConnections"] == 0
        assert reentered["done"] is True

        mc._pget_cancel({"id": jid})
        hold.set()
        res = wait_result(sent, timeout=15)
        assert res["status"] == "cancelled"
    finally:
        hold.set()
        try:
            mc._pget_cancel({"id": jid})
        except Exception:
            pass
        shutdown_server(httpd)


def test_set_limit_replacement_waits_for_old_ack_serializer(monkeypatch):
    """Unregister/replacement cannot claim jid while old op holds ack_lock across send."""
    import mchost.downloads as d

    sent = []
    lock = threading.Lock()
    old_in_send = threading.Event()
    allow_old_send = threading.Event()
    unreg_done = threading.Event()
    reg_done = threading.Event()
    acked_ops = []

    def tracking_send_ops(msg):
        m = dict(msg)
        if m.get("type") == "pget-limit-ack":
            # Snapshot the registry owner at the moment the ack hits the wire.
            live = d._PGET.get(jid)
            with lock:
                sent.append(m)
                acked_ops.append(live)
            old_in_send.set()
            assert allow_old_send.wait(timeout=5.0)
        else:
            with lock:
                sent.append(m)

    monkeypatch.setattr(mc, "send", tracking_send_ops)
    monkeypatch.setattr(d, "_h", lambda: mc)

    jid = "jobReplaceAck"
    old = _make_lease_op(gen=0, limit=2, cap=4)
    new = _make_lease_op(gen=0, limit=3, cap=4)
    assert d._pget_register(jid, old)

    err = []

    def apply_old():
        try:
            d.handle_pget_set_limit({
                "id": jid, "maxConnections": 1, "providerGeneration": 1,
            })
        except Exception as e:
            err.append(e)

    def replace_while_ack():
        try:
            # Must wait for old ack_lock; must not pop under a concurrent owner.
            d._pget_unregister(jid, old)
            unreg_done.set()
            assert d._pget_register(jid, new)
            reg_done.set()
        except Exception as e:
            err.append(e)

    t_ack = threading.Thread(target=apply_old)
    t_ack.start()
    assert old_in_send.wait(timeout=5.0)

    t_rep = threading.Thread(target=replace_while_ack)
    t_rep.start()

    # Replacement must not complete while old ack send holds the serializer.
    assert not unreg_done.wait(timeout=0.4), "unregister completed during old ack send"
    assert d._PGET.get(jid) is old
    assert new["providerGeneration"] == 0
    assert old["providerGeneration"] == 1

    allow_old_send.set()
    t_ack.join(timeout=5)
    t_rep.join(timeout=5)
    assert not t_ack.is_alive() and not t_rep.is_alive()
    assert err == []
    assert unreg_done.is_set() and reg_done.is_set()
    assert d._PGET.get(jid) is new

    with lock:
        wire = list(sent)
        owners = list(acked_ops)
    assert len(wire) == 1
    assert wire[0]["providerGeneration"] == 1
    assert wire[0]["maxConnections"] == 1
    # The sole ack belongs to the old op era (registry still pointed at old).
    assert owners == [old]

    # New op has never been acknowledged under the old apply.
    assert new["providerGeneration"] == 0
    assert new["maxConnections"] == 3
    d._pget_unregister(jid, new)
    assert d._PGET.get(jid) is None


def test_ytdl_registry_cas_and_identity_unregister(monkeypatch):
    """yt-dlp must use registry CAS; duplicate id kills the new proc without overwrite."""
    import mchost.downloads as d

    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(dict(msg)))
    monkeypatch.setattr(d, "_h", lambda: mc)
    monkeypatch.setattr(d, "ensure_ytdlp", lambda: "yt-dlp-fake")
    monkeypatch.setattr(d, "ensure_deno", lambda: None)
    monkeypatch.setattr(d, "start_pot_provider", lambda: False)
    monkeypatch.setattr(d, "_no_window", lambda: (0, None))

    class FakeProc:
        def __init__(self):
            self.stdout = iter(())
            self.returncode = 1
            self.killed = False

        def wait(self, timeout=None):
            return self.returncode

        def poll(self):
            return self.returncode

    spawned = []
    killed = []

    def fake_popen(*_a, **_k):
        p = FakeProc()
        spawned.append(p)
        return p

    def fake_kill(p):
        p.killed = True
        killed.append(p)

    monkeypatch.setattr(d.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(d, "_safe_kill", fake_kill)

    jid = "jobYtdlCas"
    # Active pget already owns the id.
    owner = _make_lease_op(gen=0, limit=1, cap=1)
    assert d._pget_register(jid, owner)

    d.handle_ytdl({"id": jid, "url": "https://example.test/v", "dir": "."})
    assert wait_for(lambda: any(m.get("type") == "ytdl-error" for m in sent), timeout=5)
    err = [m for m in sent if m.get("type") == "ytdl-error" and m.get("id") == jid][-1]
    assert err["reason"]
    assert d._PGET.get(jid) is owner
    assert owner.get("proc") is None
    assert len(spawned) == 1
    assert spawned[0].killed is True or spawned[0] in killed

    d._pget_unregister(jid, owner)
    assert d._PGET.get(jid) is None

    # Successful ytdl path registers with CAS and unregisters by identity.
    class LiveProc:
        def __init__(self):
            self._lines = ["[download] 100.0% of 1.00KiB at 1.00KiB/s ETA 00:00",
                           "@@FILE@@ C:\\tmp\\done.mp4"]
            self._i = 0
            self.returncode = None
            self.killed = False

        @property
        def stdout(self):
            return self

        def __iter__(self):
            return self

        def __next__(self):
            if self._i >= len(self._lines):
                raise StopIteration
            line = self._lines[self._i]
            self._i += 1
            return line

        def wait(self, timeout=None):
            self.returncode = 0
            return 0

        def poll(self):
            return self.returncode

    live = []

    def popen_live(*_a, **_k):
        p = LiveProc()
        live.append(p)
        return p

    monkeypatch.setattr(d.subprocess, "Popen", popen_live)
    monkeypatch.setattr(d.os.path, "isfile", lambda p: True)
    monkeypatch.setattr(d.os.path, "getsize", lambda p: 42)

    sent.clear()
    d.handle_ytdl({"id": jid, "url": "https://example.test/v2", "dir": "."})
    assert wait_for(
        lambda: any(m.get("type") == "ytdl-done" for m in sent)
        or any(m.get("type") == "ytdl-error" for m in sent),
        timeout=5,
    )
    # After completion the identity-safe unregister must clear the slot.
    assert wait_for(lambda: d._PGET.get(jid) is None, timeout=5)
    assert not any(m.get("type") == "pget-limit-ack" for m in sent)
    # Cancel against a ytdl entry still kills the captured proc when present mid-flight.
    mid = {"proc": FakeProc(), "kind": "ytdl"}
    assert d._pget_register(jid, mid)
    mc._pget_cancel({"id": jid})
    assert mid["proc"].killed is True or mid["proc"] in killed
    d._pget_unregister(jid, mid)
