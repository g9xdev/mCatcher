"""Token-bound yt-dlp Save As protocol (v2) — focused host tests.

Deterministic fakes only: no network and no real yt-dlp process.
"""
import os
import threading

from conftest import load_host, wait_for

mc = load_host()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class AlwaysEq(str):
    """Hostile str subclass: equality always True."""

    def __eq__(self, other):
        return True

    def __hash__(self):
        return str.__hash__(self)


class BoxedStr:
    """Non-str wrapper that stringifies and equals like a token."""

    def __init__(self, value):
        self.value = value

    def __eq__(self, other):
        return other == self.value or getattr(other, "value", None) == self.value

    def __str__(self):
        return self.value


class LiveProc:
    """yt-dlp-like fake: yields stdout lines then exits with returncode."""

    def __init__(self, lines=None, returncode=0, hold=None, after_wait=None):
        self._lines = list(lines or [])
        self._i = 0
        self.returncode = None
        self._final_rc = returncode
        self.killed = False
        self._hold = hold
        self._after_wait = after_wait
        self._lock = threading.Lock()

    @property
    def stdout(self):
        return self

    def __iter__(self):
        return self

    def __next__(self):
        if self._hold is not None:
            self._hold.wait(timeout=5)
        with self._lock:
            if self.killed:
                raise StopIteration
            if self._i >= len(self._lines):
                raise StopIteration
            line = self._lines[self._i]
            self._i += 1
            return line

    def wait(self, timeout=None):
        if self._hold is not None:
            self._hold.wait(timeout=5)
        if self._after_wait is not None:
            self._after_wait()
        with self._lock:
            if self.returncode is None:
                self.returncode = -9 if self.killed else self._final_rc
            return self.returncode

    def poll(self):
        return self.returncode


def _patch_ytdl_base(monkeypatch, d, mc_mod, sent, popen=None):
    monkeypatch.setattr(mc_mod, "send", lambda msg: sent.append(dict(msg)))
    monkeypatch.setattr(d, "_h", lambda: mc_mod)
    monkeypatch.setattr(d, "ensure_ytdlp", lambda: "yt-dlp-fake")
    monkeypatch.setattr(d, "ensure_deno", lambda: None)
    monkeypatch.setattr(d, "start_pot_provider", lambda: False)
    monkeypatch.setattr(d, "_no_window", lambda: (0, None))
    monkeypatch.setattr(mc_mod, "FFMPEG", None)
    if popen is not None:
        monkeypatch.setattr(d.subprocess, "Popen", popen)


def _wait_terminal(sent, jid, timeout=5):
    def done():
        return any(
            m.get("type") in ("ytdl-done", "ytdl-error") and m.get("id") == jid
            for m in sent
        )
    assert wait_for(done, timeout=timeout), "no ytdl terminal for %s" % jid
    terms = [
        m for m in sent
        if m.get("type") in ("ytdl-done", "ytdl-error") and m.get("id") == jid
    ]
    return terms[-1]


def _cmd_from_popen_calls(calls):
    assert calls, "expected Popen"
    args = calls[0][0]
    if args and isinstance(args[0], (list, tuple)):
        return list(args[0])
    return list(args)


# ---------------------------------------------------------------------------
# 1. Exact edited filename, explicit dir, selected format, token, file, bytes
# ---------------------------------------------------------------------------

def test_structured_exact_name_dir_format_token_file_bytes(tmp_path, monkeypatch):
    import mchost.downloads as d

    sent = []
    dest = tmp_path / "Videos"
    dest.mkdir()
    final = dest / "user-edited-name.mp4"
    payload = b"YTDL-BYTES-42"
    calls = []

    def fake_popen(*a, **k):
        calls.append((a, k))
        # Simulate yt-dlp writing the file at the -o path after template resolve.
        # Host should precompute the target; we write there after reading -o.
        cmd = list(a[0]) if a else []
        out = None
        if "-o" in cmd:
            out = cmd[cmd.index("-o") + 1]
        if out:
            # yt-dlp receives %% for literal %; filesystem path is unescaped by host.
            # For this test name has no %.
            final.write_bytes(payload)
            lines = ["[download] 100.0% of 1.00KiB at 1.00KiB/s ETA 00:00",
                     "@@FILE@@ %s" % str(final)]
        else:
            lines = []
        return LiveProc(lines=lines, returncode=0)

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)

    d.handle_ytdl({
        "id": "jobExact",
        "attemptToken": "atk-exact",
        "url": "https://www.youtube.com/watch?v=abc123",
        "name": "user-edited-name.mp4",
        "dir": str(dest),
        "format": "bv*[height<=1080]+ba/b[height<=1080]",
    })
    term = _wait_terminal(sent, "jobExact")
    assert term["type"] == "ytdl-done"
    assert term["attemptToken"] == "atk-exact"
    assert term["file"] == str(final)
    assert term["bytes"] == len(payload)
    assert final.is_file()
    assert final.read_bytes() == payload

    cmd = _cmd_from_popen_calls(calls)
    assert "-f" in cmd
    assert cmd[cmd.index("-f") + 1] == "bv*[height<=1080]+ba/b[height<=1080]"
    assert "-o" in cmd
    outtmpl = cmd[cmd.index("-o") + 1]
    assert outtmpl == str(final) or os.path.basename(outtmpl) == "user-edited-name.mp4"
    assert "%(title)" not in outtmpl
    assert wait_for(lambda: d._PGET.get("jobExact") is None, timeout=5)


# ---------------------------------------------------------------------------
# 2. % output-template escaping; reported path keeps single %
# ---------------------------------------------------------------------------

def test_percent_escaped_in_output_template_not_reported_path(tmp_path, monkeypatch):
    import mchost.downloads as d

    sent = []
    dest = tmp_path / "pct"
    dest.mkdir()
    actual_name = "100% real.mp4"
    actual_path = dest / actual_name
    payload = b"PERCENT"
    calls = []

    def fake_popen(*a, **k):
        calls.append((a, k))
        cmd = list(a[0]) if a else []
        out = cmd[cmd.index("-o") + 1] if "-o" in cmd else ""
        # Host must pass %% to yt-dlp; the real FS name uses a single %.
        assert "%%" in out or out.replace("%%", "%").endswith(actual_name)
        actual_path.write_bytes(payload)
        return LiveProc(
            lines=["@@FILE@@ %s" % str(actual_path)],
            returncode=0,
        )

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)

    d.handle_ytdl({
        "id": "jobPct",
        "attemptToken": "atk-pct",
        "url": "https://example.test/v",
        "name": actual_name,
        "dir": str(dest),
    })
    term = _wait_terminal(sent, "jobPct")
    assert term["type"] == "ytdl-done"
    assert term["file"] == str(actual_path)
    assert term["bytes"] == len(payload)
    assert "%" in os.path.basename(term["file"])
    assert "%%" not in os.path.basename(term["file"])

    cmd = _cmd_from_popen_calls(calls)
    outtmpl = cmd[cmd.index("-o") + 1]
    assert "100%% real.mp4" in outtmpl
    assert "100% real.mp4" not in outtmpl or "100%% real.mp4" in outtmpl


# ---------------------------------------------------------------------------
# 3. Existing-file deduplication + actual path reporting
# ---------------------------------------------------------------------------

def test_dedup_existing_file_reports_actual_path(tmp_path, monkeypatch):
    import mchost.downloads as d

    sent = []
    dest = tmp_path / "dedup"
    dest.mkdir()
    existing = dest / "clip.mp4"
    existing.write_bytes(b"OLD")
    expected = dest / "clip (1).mp4"
    payload = b"NEW-CLIP"
    calls = []

    def fake_popen(*a, **k):
        calls.append((a, k))
        cmd = list(a[0]) if a else []
        out = cmd[cmd.index("-o") + 1] if "-o" in cmd else ""
        # Write to the deduped target the host selected.
        # Host may escape % in template; unescaped basename should be clip (1).mp4
        expected.write_bytes(payload)
        return LiveProc(
            lines=["@@FILE@@ %s" % str(expected)],
            returncode=0,
        )

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)

    d.handle_ytdl({
        "id": "jobDedup",
        "attemptToken": "atk-dedup",
        "url": "https://example.test/v",
        "name": "clip.mp4",
        "dir": str(dest),
    })
    term = _wait_terminal(sent, "jobDedup")
    assert term["type"] == "ytdl-done"
    assert term["file"] == str(expected)
    assert term["bytes"] == len(payload)
    assert existing.read_bytes() == b"OLD"
    cmd = _cmd_from_popen_calls(calls)
    outtmpl = cmd[cmd.index("-o") + 1]
    assert "clip (1).mp4" in outtmpl
    assert outtmpl.rstrip("/\\").endswith("clip (1).mp4") or "clip (1).mp4" in outtmpl


# ---------------------------------------------------------------------------
# 4. Default and selected quality command regression
# ---------------------------------------------------------------------------

def test_default_and_selected_format_command(tmp_path, monkeypatch):
    import mchost.downloads as d

    sent = []
    dest = tmp_path / "fmt"
    dest.mkdir()
    calls = []

    def fake_popen(*a, **k):
        calls.append((a, k))
        cmd = list(a[0]) if a else []
        out = cmd[cmd.index("-o") + 1] if "-o" in cmd else str(dest / "x.mp4")
        # Materialize a file so completion can succeed when structured.
        path = out.replace("%%", "%")
        try:
            with open(path, "wb") as f:
                f.write(b"x")
        except Exception:
            p = dest / "x.mp4"
            p.write_bytes(b"x")
            path = str(p)
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)

    d.handle_ytdl({
        "id": "jobFmtDef",
        "attemptToken": "atk-fmt-def",
        "url": "https://example.test/v",
        "name": "a.mp4",
        "dir": str(dest),
    })
    _wait_terminal(sent, "jobFmtDef")
    cmd = _cmd_from_popen_calls(calls)
    assert cmd[cmd.index("-f") + 1] == "bv*+ba/b"
    assert "--merge-output-format" in cmd
    assert cmd[cmd.index("--merge-output-format") + 1] == "mp4"
    assert "--cookies-from-browser" in cmd
    assert "firefox" in cmd

    calls.clear()
    sent.clear()
    d.handle_ytdl({
        "id": "jobFmtSel",
        "attemptToken": "atk-fmt-sel",
        "url": "https://example.test/v",
        "name": "b.mp4",
        "dir": str(dest),
        "format": "bv*[height<=720]+ba/b[height<=720]",
    })
    _wait_terminal(sent, "jobFmtSel")
    cmd = _cmd_from_popen_calls(calls)
    assert cmd[cmd.index("-f") + 1] == "bv*[height<=720]+ba/b[height<=720]"


# ---------------------------------------------------------------------------
# 5. Stored token on every structured progress + terminal
# ---------------------------------------------------------------------------

def test_token_on_every_structured_progress_and_terminal(tmp_path, monkeypatch):
    import mchost.downloads as d

    sent = []
    dest = tmp_path / "tok"
    dest.mkdir()
    final = dest / "t.mp4"

    def fake_popen(*a, **k):
        final.write_bytes(b"T")
        return LiveProc(lines=[
            "[youtube] abc: Downloading webpage",
            "[download] Destination: %s" % final,
            "[download]  10.0% of  1.00MiB at   1.00MiB/s ETA 00:01",
            "[download]  50.0% of  1.00MiB at   1.00MiB/s ETA 00:00",
            "Merging formats into %s" % final,
            "@@FILE@@ %s" % final,
        ], returncode=0)

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)

    token = "atk-progress"
    d.handle_ytdl({
        "id": "jobProg",
        "attemptToken": token,
        "url": "https://example.test/v",
        "name": "t.mp4",
        "dir": str(dest),
    })
    term = _wait_terminal(sent, "jobProg")
    assert term["type"] == "ytdl-done"
    assert term["attemptToken"] == token
    frames = [m for m in sent if m.get("id") == "jobProg"
              and m.get("type") in ("ytdl-progress", "ytdl-done", "ytdl-error")]
    assert frames, "expected progress/terminal frames"
    assert all(m.get("attemptToken") == token for m in frames)
    assert any(m.get("type") == "ytdl-progress" for m in frames)


# ---------------------------------------------------------------------------
# 6. Cancel: stale/null/boxed/hostile inert; matching cancels once; legacy ok
# ---------------------------------------------------------------------------

def test_cancel_token_fencing_structured_and_legacy(tmp_path, monkeypatch):
    import mchost.downloads as d

    sent = []
    dest = tmp_path / "can"
    dest.mkdir()
    hold = threading.Event()
    procs = []

    def fake_popen(*a, **k):
        p = LiveProc(lines=["[download]   1.0% of  1.00MiB at   1.00MiB/s ETA 00:99"],
                     returncode=0, hold=hold)
        procs.append(p)
        return p

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)

    jid = "jobCanFence"
    token = "atk-can-fence"
    d.handle_ytdl({
        "id": jid,
        "attemptToken": token,
        "url": "https://example.test/v",
        "name": "c.mp4",
        "dir": str(dest),
    })
    assert wait_for(lambda: d._PGET.get(jid) is not None, timeout=5)
    op = d._PGET[jid]
    assert op.get("attemptToken") == token

    # Stale / null / boxed / hostile — no-ops
    for bad in ("stale-token", None, BoxedStr(token), AlwaysEq(token), 123, True, {"t": token}):
        d._pget_cancel({"id": jid, "attemptToken": bad})
        assert op.get("cancel_requested") is not True
        assert not procs or not procs[0].killed

    # Matching exact token cancels once
    d._pget_cancel({"id": jid, "attemptToken": token})
    assert op.get("cancel_requested") is True
    hold.set()
    term = _wait_terminal(sent, jid)
    assert term["type"] == "ytdl-error"
    assert term["reason"] == "cancelled"
    assert term["attemptToken"] == token
    assert term.get("error")
    # Exactly one terminal
    terms = [m for m in sent if m.get("type") in ("ytdl-done", "ytdl-error") and m.get("id") == jid]
    assert len(terms) == 1
    assert d._PGET.get(jid) is None

    # Second cancel is inert after unregister
    before = len(sent)
    d._pget_cancel({"id": jid, "attemptToken": token})
    assert len(sent) == before

    # Legacy omitted-token cancel still works for a legacy op
    sent.clear()
    hold2 = threading.Event()
    procs.clear()

    def fake_popen_legacy(*a, **k):
        p = LiveProc(lines=["[download]   1.0% of  1.00MiB at   1.00MiB/s ETA 00:99"],
                     returncode=0, hold=hold2)
        procs.append(p)
        return p

    monkeypatch.setattr(d.subprocess, "Popen", fake_popen_legacy)
    d.handle_ytdl({"id": "jobLegCan", "url": "https://example.test/v", "dir": str(dest)})
    assert wait_for(lambda: d._PGET.get("jobLegCan") is not None, timeout=5)
    d._pget_cancel({"id": "jobLegCan"})  # omitted token
    hold2.set()
    assert wait_for(
        lambda: any(m.get("type") == "ytdl-error" and m.get("id") == "jobLegCan" for m in sent)
        or d._PGET.get("jobLegCan") is None,
        timeout=5,
    )


# ---------------------------------------------------------------------------
# 7. Structured op registered throughout async preparation
# ---------------------------------------------------------------------------

def test_structured_registered_during_async_preparation(tmp_path, monkeypatch):
    import mchost.downloads as d

    sent = []
    dest = tmp_path / "prep"
    dest.mkdir()
    entered = threading.Event()
    release = threading.Event()
    saw_registered = []

    def slow_ensure():
        op = d._PGET.get("jobPrep")
        saw_registered.append(op is not None and isinstance(op, dict)
                              and op.get("attemptToken") == "atk-prep"
                              and op.get("kind") == "ytdl")
        entered.set()
        release.wait(timeout=5)
        return "yt-dlp-fake"

    def fake_popen(*a, **k):
        pth = dest / "p.mp4"
        pth.write_bytes(b"P")
        return LiveProc(lines=["@@FILE@@ %s" % pth], returncode=0)

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)
    monkeypatch.setattr(d, "ensure_ytdlp", slow_ensure)

    d.handle_ytdl({
        "id": "jobPrep",
        "attemptToken": "atk-prep",
        "url": "https://example.test/v",
        "name": "p.mp4",
        "dir": str(dest),
    })
    assert wait_for(entered.is_set, timeout=5)
    # Still registered while blocked in ensure_ytdlp (before Popen).
    assert d._PGET.get("jobPrep") is not None
    assert d._PGET["jobPrep"].get("attemptToken") == "atk-prep"
    release.set()
    _wait_terminal(sent, "jobPrep")
    assert saw_registered and all(saw_registered)


# ---------------------------------------------------------------------------
# 8. Identity-safe unregister-before-terminal; reentrant same-id retry
# ---------------------------------------------------------------------------

def test_unregister_before_terminal_allows_reentrant_same_id(tmp_path, monkeypatch):
    import mchost.downloads as d

    sent = []
    dest = tmp_path / "re"
    dest.mkdir()
    state = {"retried": False, "new_op": None, "old_op": None}
    lock = threading.Lock()

    def fake_popen(*a, **k):
        # Distinguish first vs second by name in -o
        cmd = list(a[0]) if a else []
        out = cmd[cmd.index("-o") + 1] if "-o" in cmd else "x.mp4"
        path = out.replace("%%", "%")
        try:
            with open(path, "wb") as f:
                f.write(b"R1" if not state["retried"] else b"R2")
        except Exception:
            path = str(dest / ("r1.mp4" if not state["retried"] else "r2.mp4"))
            with open(path, "wb") as f:
                f.write(b"R")
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    def capturing_send(msg):
        with lock:
            sent.append(dict(msg))
            if (msg.get("type") == "ytdl-done"
                    and msg.get("id") == "jobRe"
                    and msg.get("attemptToken") == "atk-old"
                    and not state["retried"]):
                state["retried"] = True
                # Same-id retry must be able to register during terminal send.
                d.handle_ytdl({
                    "id": "jobRe",
                    "attemptToken": "atk-new",
                    "url": "https://example.test/v2",
                    "name": "r2.mp4",
                    "dir": str(dest),
                })
                state["new_op"] = d._PGET.get("jobRe")

    monkeypatch.setattr(mc, "send", capturing_send)
    monkeypatch.setattr(d, "_h", lambda: mc)
    monkeypatch.setattr(d, "ensure_ytdlp", lambda: "yt-dlp-fake")
    monkeypatch.setattr(d, "ensure_deno", lambda: None)
    monkeypatch.setattr(d, "start_pot_provider", lambda: False)
    monkeypatch.setattr(d, "_no_window", lambda: (0, None))
    monkeypatch.setattr(mc, "FFMPEG", None)
    monkeypatch.setattr(d.subprocess, "Popen", fake_popen)

    d.handle_ytdl({
        "id": "jobRe",
        "attemptToken": "atk-old",
        "url": "https://example.test/v",
        "name": "r1.mp4",
        "dir": str(dest),
    })
    assert wait_for(lambda: d._PGET.get("jobRe") is not None, timeout=5)
    state["old_op"] = d._PGET.get("jobRe")

    assert wait_for(
        lambda: any(m.get("type") == "ytdl-done" and m.get("attemptToken") == "atk-old"
                    for m in sent),
        timeout=5,
    )
    # New op registered during old terminal; old finally must not clear it.
    assert wait_for(lambda: state["new_op"] is not None, timeout=5)
    assert state["new_op"] is not None
    assert state["new_op"] is not state["old_op"]
    # Either still live or completed — but never cleared by old cleanup while new owns it
    # Wait for new completion.
    assert wait_for(
        lambda: any(m.get("type") == "ytdl-done" and m.get("attemptToken") == "atk-new"
                    for m in sent),
        timeout=5,
    )
    assert wait_for(lambda: d._PGET.get("jobRe") is None, timeout=5)
    tokens_done = [
        m.get("attemptToken") for m in sent
        if m.get("type") == "ytdl-done" and m.get("id") == "jobRe"
    ]
    assert "atk-old" in tokens_done and "atk-new" in tokens_done


# ---------------------------------------------------------------------------
# 9. Invalid present token/name/directory/format: no spawn, no downgrade
# ---------------------------------------------------------------------------

def test_invalid_structured_inputs_no_spawn_no_downgrade(tmp_path, monkeypatch):
    import mchost.downloads as d

    sent = []
    spawned = []
    dest = tmp_path / "inv"
    dest.mkdir()

    def fake_popen(*a, **k):
        spawned.append(1)
        return LiveProc(lines=[], returncode=1)

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)

    base = {
        "id": "jobInv",
        "attemptToken": "atk-inv",
        "url": "https://example.test/v",
        "name": "ok.mp4",
        "dir": str(dest),
        "format": "bv*+ba/b",
    }

    cases = [
        {**base, "attemptToken": None},
        {**base, "attemptToken": ""},
        {**base, "attemptToken": "   "},
        {**base, "attemptToken": 12},
        {**base, "attemptToken": True},
        {**base, "attemptToken": ["atk"]},
        {**base, "attemptToken": AlwaysEq("atk-inv")},
        {**base, "attemptToken": BoxedStr("atk-inv")},
        {**base, "name": None},
        {**base, "name": ""},
        {**base, "name": 1},
        {**base, "name": AlwaysEq("ok.mp4")},
        {**base, "url": None},
        {**base, "url": ""},
        {**base, "url": 9},
        {**base, "id": None},
        {**base, "id": ""},
        {**base, "id": 3},
        {**base, "dir": 5},
        {**base, "dir": True},
        {**base, "dir": ["C:\\x"]},
        {**base, "format": 1},
        {**base, "format": True},
        {**base, "format": "bv*\x00+ba"},
        {**base, "format": "x\n y"},
    ]

    for i, req in enumerate(cases):
        spawned.clear()
        sent.clear()
        # Ensure no lasting registry entry from a prior case.
        d._PGET.pop(req.get("id") or "jobInv", None)
        d.handle_ytdl(req)
        # Give a brief moment for any accidental async spawn.
        wait_for(lambda: bool(spawned) or any(
            m.get("type") == "ytdl-error" for m in sent
        ), timeout=0.5)
        assert not spawned, "case %d spawned: %r" % (i, req.get("attemptToken", req.get("name")))
        assert d._PGET.get("jobInv") is None
        # Must not produce legacy title-template success path.
        assert not any(m.get("type") == "ytdl-done" for m in sent)
        # When token+id are valid nonblank built-in strs, expect one safe error.
        tok = req.get("attemptToken")
        jid = req.get("id")
        if type(tok) is str and tok.strip() and type(jid) is str and jid.strip():
            errs = [m for m in sent if m.get("type") == "ytdl-error"]
            assert len(errs) == 1
            assert errs[0].get("attemptToken") == tok
            assert errs[0].get("id") == jid
            err_text = (errs[0].get("error") or "")
            assert "Traceback" not in err_text
            assert "https://" not in err_text


# ---------------------------------------------------------------------------
# 10. Explicit destination creation failure never falls back
# ---------------------------------------------------------------------------

def test_explicit_dest_create_failure_no_fallback(tmp_path, monkeypatch):
    import mchost.downloads as d

    sent = []
    spawned = []
    # A path under a file (not a directory) cannot be created as a directory.
    blocker = tmp_path / "not-a-dir"
    blocker.write_bytes(b"x")
    bad_dir = str(blocker / "child")

    def fake_popen(*a, **k):
        spawned.append(1)
        return LiveProc(lines=[], returncode=1)

    downloads_hits = []

    def fake_downloads():
        downloads_hits.append(1)
        return str(tmp_path / "Downloads")

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)
    monkeypatch.setattr(mc, "downloads_dir", fake_downloads)
    monkeypatch.setattr(mc, "load_config", lambda: {})

    d.handle_ytdl({
        "id": "jobDest",
        "attemptToken": "atk-dest",
        "url": "https://example.test/v",
        "name": "d.mp4",
        "dir": bad_dir,
    })
    term = _wait_terminal(sent, "jobDest")
    assert term["type"] == "ytdl-error"
    assert term["attemptToken"] == "atk-dest"
    assert term["reason"] == "local_io"
    assert not spawned
    assert not downloads_hits
    assert d._PGET.get("jobDest") is None


# ---------------------------------------------------------------------------
# 11. Duplicate id neither spawns nor replaces existing owner
# ---------------------------------------------------------------------------

def test_duplicate_id_neither_spawns_nor_replaces(tmp_path, monkeypatch):
    import mchost.downloads as d

    sent = []
    dest = tmp_path / "dup"
    dest.mkdir()
    spawned = []

    def fake_popen(*a, **k):
        spawned.append(1)
        return LiveProc(lines=[], returncode=1)

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)

    jid = "jobDupY"
    owner = {
        "proc": None,
        "kind": "pget",
        "attemptToken": "owner-tok",
        "cancel_requested": False,
        "stop": threading.Event(),
        "lease_cv": threading.Condition(),
    }
    assert d._pget_register(jid, owner)

    d.handle_ytdl({
        "id": jid,
        "attemptToken": "atk-dup",
        "url": "https://example.test/v",
        "name": "x.mp4",
        "dir": str(dest),
    })
    term = _wait_terminal(sent, jid)
    assert term["type"] == "ytdl-error"
    assert term["attemptToken"] == "atk-dup"
    assert not spawned
    assert d._PGET.get(jid) is owner
    assert owner.get("cancel_requested") is not True
    d._pget_unregister(jid, owner)


# ---------------------------------------------------------------------------
# 12. Legacy token-omitted retains title/ID template and tokenless wire shapes
# ---------------------------------------------------------------------------

def test_legacy_token_omitted_template_and_wire_shapes(tmp_path, monkeypatch):
    import mchost.downloads as d

    sent = []
    dest = tmp_path / "leg"
    dest.mkdir()
    calls = []
    final = dest / "Some Title [id1].mp4"

    def fake_popen(*a, **k):
        calls.append((a, k))
        final.write_bytes(b"LEG")
        return LiveProc(lines=[
            "[download]  25.0% of  1.00MiB at   1.00MiB/s ETA 00:01",
            "@@FILE@@ %s" % final,
        ], returncode=0)

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)

    d.handle_ytdl({
        "id": "jobLegacy",
        "url": "https://example.test/v",
        "dir": str(dest),
    })
    term = _wait_terminal(sent, "jobLegacy")
    assert term["type"] == "ytdl-done"
    assert "attemptToken" not in term
    assert term["file"] == str(final)
    assert term["bytes"] == 3

    progress = [m for m in sent if m.get("type") == "ytdl-progress" and m.get("id") == "jobLegacy"]
    assert progress
    assert all("attemptToken" not in m for m in progress)

    cmd = _cmd_from_popen_calls(calls)
    outtmpl = cmd[cmd.index("-o") + 1]
    assert "%(title)" in outtmpl
    assert "%(id)s" in outtmpl
    assert cmd[cmd.index("-f") + 1] == "bv*+ba/b"


# ---------------------------------------------------------------------------
# 13. Matching cancel wins over late zero exit; exactly one terminal
# ---------------------------------------------------------------------------

def test_matching_cancel_wins_over_late_zero_exit(tmp_path, monkeypatch):
    import mchost.downloads as d

    sent = []
    dest = tmp_path / "race"
    dest.mkdir()
    final = dest / "race.mp4"
    hold_stdout = threading.Event()
    cancel_done = threading.Event()

    def after_wait():
        # Simulate late successful exit after cancel was observed.
        final.write_bytes(b"LATE")

    def fake_popen(*a, **k):
        return LiveProc(
            lines=[
                "[download]  99.0% of  1.00MiB at   1.00MiB/s ETA 00:00",
                "@@FILE@@ %s" % final,
            ],
            returncode=0,
            hold=hold_stdout,
            after_wait=after_wait,
        )

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)

    jid = "jobRace"
    token = "atk-race"
    d.handle_ytdl({
        "id": jid,
        "attemptToken": token,
        "url": "https://example.test/v",
        "name": "race.mp4",
        "dir": str(dest),
    })
    assert wait_for(lambda: d._PGET.get(jid) is not None, timeout=5)
    d._pget_cancel({"id": jid, "attemptToken": token})
    assert d._PGET.get(jid) is None or d._PGET[jid].get("cancel_requested") is True
    hold_stdout.set()
    term = _wait_terminal(sent, jid)
    assert term["type"] == "ytdl-error"
    assert term["reason"] == "cancelled"
    assert term["attemptToken"] == token
    terms = [m for m in sent if m.get("type") in ("ytdl-done", "ytdl-error") and m.get("id") == jid]
    assert len(terms) == 1
    assert not any(m.get("type") == "ytdl-done" for m in sent if m.get("id") == jid)


# ---------------------------------------------------------------------------
# 14. Missing / nonfile / negative-size completion cannot emit ytdl-done
# ---------------------------------------------------------------------------

def test_missing_nonfile_negative_size_no_ytdl_done(tmp_path, monkeypatch):
    import mchost.downloads as d

    sent = []
    dest = tmp_path / "meta"
    dest.mkdir()

    # Case A: missing file after rc=0
    def popen_missing(*a, **k):
        return LiveProc(lines=["@@FILE@@ %s" % (dest / "nope.mp4")], returncode=0)

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=popen_missing)
    d.handle_ytdl({
        "id": "jobMiss",
        "attemptToken": "atk-miss",
        "url": "https://example.test/v",
        "name": "nope.mp4",
        "dir": str(dest),
    })
    term = _wait_terminal(sent, "jobMiss")
    assert term["type"] == "ytdl-error"
    assert term["attemptToken"] == "atk-miss"
    assert term["reason"] in ("local_io", "permanent", "generic")
    assert not any(m.get("type") == "ytdl-done" for m in sent if m.get("id") == "jobMiss")

    # Case B: path is a directory (nonfile)
    sent.clear()
    ndir = dest / "isdir.mp4"
    ndir.mkdir()

    def popen_dir(*a, **k):
        return LiveProc(lines=["@@FILE@@ %s" % ndir], returncode=0)

    monkeypatch.setattr(d.subprocess, "Popen", popen_dir)
    d.handle_ytdl({
        "id": "jobDir",
        "attemptToken": "atk-dir",
        "url": "https://example.test/v",
        "name": "other.mp4",
        "dir": str(dest),
    })
    term = _wait_terminal(sent, "jobDir")
    assert term["type"] == "ytdl-error"
    assert term["attemptToken"] == "atk-dir"
    assert not any(m.get("type") == "ytdl-done" for m in sent if m.get("id") == "jobDir")

    # Case C: negative / hostile size
    sent.clear()

    def popen_neg(*a, **k):
        cmd = list(a[0]) if a else []
        out = cmd[cmd.index("-o") + 1] if "-o" in cmd else str(dest / "neg.mp4")
        path = out.replace("%%", "%")
        with open(path, "wb") as f:
            f.write(b"ABC")
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    monkeypatch.setattr(d.subprocess, "Popen", popen_neg)

    real_getsize = d.os.path.getsize

    def hostile_getsize(p):
        if os.path.basename(str(p)) == "neg.mp4":
            return -1
        return real_getsize(p)

    monkeypatch.setattr(d.os.path, "getsize", hostile_getsize)
    d.handle_ytdl({
        "id": "jobNeg",
        "attemptToken": "atk-neg",
        "url": "https://example.test/v",
        "name": "neg.mp4",
        "dir": str(dest),
    })
    term = _wait_terminal(sent, "jobNeg")
    assert term["type"] == "ytdl-error"
    assert term["attemptToken"] == "atk-neg"
    assert term["reason"] in ("local_io", "permanent")
    assert not any(m.get("type") == "ytdl-done" for m in sent if m.get("id") == "jobNeg")
    if "bytes" in term:
        assert term["bytes"] >= 0


# ---------------------------------------------------------------------------
# 15. Structured -o is operation-owned staging, never the final target
# ---------------------------------------------------------------------------

def test_structured_o_is_unique_staging_not_final_target(tmp_path, monkeypatch):
    """Structured yt-dlp must write only under an op-owned staging path.

    Mutation: passing the preselected final as -o reintroduces force-overwrite
    of the committed user-visible path.
    """
    import mchost.downloads as d

    sent = []
    dest = tmp_path / "stage"
    dest.mkdir()
    final = dest / "clip.mp4"
    payload = b"STAGED-BYTES"
    calls = []

    def fake_popen(*a, **k):
        calls.append((a, k))
        cmd = list(a[0]) if a else []
        out = cmd[cmd.index("-o") + 1] if "-o" in cmd else ""
        # Materialize exactly where yt-dlp was told to write (unescape %).
        path = out.replace("%%", "%")
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(path, "wb") as f:
            f.write(payload)
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)

    d.handle_ytdl({
        "id": "jobStage",
        "attemptToken": "atk-stage",
        "url": "https://example.test/v",
        "name": "clip.mp4",
        "dir": str(dest),
    })
    term = _wait_terminal(sent, "jobStage")
    assert term["type"] == "ytdl-done"
    assert term["attemptToken"] == "atk-stage"
    assert term["file"] == str(final)
    assert term["bytes"] == len(payload)
    assert final.is_file()
    assert final.read_bytes() == payload

    cmd = _cmd_from_popen_calls(calls)
    outtmpl = cmd[cmd.index("-o") + 1]
    # -o must not be the committed final (nor equal after % unescape).
    assert outtmpl != str(final)
    assert outtmpl.replace("%%", "%") != str(final)
    assert os.path.basename(outtmpl.replace("%%", "%")) == "clip.mp4"
    # Staging lives under the selected destination directory.
    assert os.path.normcase(str(dest)) in os.path.normcase(
        os.path.abspath(outtmpl.replace("%%", "%"))
    )
    assert os.path.dirname(os.path.abspath(outtmpl.replace("%%", "%"))) != os.path.abspath(str(dest))


# ---------------------------------------------------------------------------
# 16. Concurrent same-name jobs: distinct staging, safe deduped finals
# ---------------------------------------------------------------------------

def test_concurrent_same_name_distinct_staging_safe_dedup(tmp_path, monkeypatch):
    """Two structured jobs with the same requested name cannot share staging.

    Mutation: shared -o / non-exclusive promote lets one job clobber the other.
    """
    import mchost.downloads as d

    sent = []
    dest = tmp_path / "conc"
    dest.mkdir()
    calls_lock = threading.Lock()
    outtmpls = []
    payloads = {0: b"JOB-A-PAYLOAD", 1: b"JOB-B-PAYLOAD"}
    start_gate = threading.Barrier(2)
    idx = {"n": 0}

    def fake_popen(*a, **k):
        with calls_lock:
            my = idx["n"]
            idx["n"] += 1
        cmd = list(a[0]) if a else []
        out = cmd[cmd.index("-o") + 1] if "-o" in cmd else ""
        with calls_lock:
            outtmpls.append(out)
        path = out.replace("%%", "%")
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        start_gate.wait(timeout=5)
        with open(path, "wb") as f:
            f.write(payloads[my])
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)

    d.handle_ytdl({
        "id": "jobConcA",
        "attemptToken": "atk-conc-a",
        "url": "https://example.test/a",
        "name": "same.mp4",
        "dir": str(dest),
    })
    d.handle_ytdl({
        "id": "jobConcB",
        "attemptToken": "atk-conc-b",
        "url": "https://example.test/b",
        "name": "same.mp4",
        "dir": str(dest),
    })
    term_a = _wait_terminal(sent, "jobConcA")
    term_b = _wait_terminal(sent, "jobConcB")
    assert term_a["type"] == "ytdl-done"
    assert term_b["type"] == "ytdl-done"
    assert term_a["file"] != term_b["file"]
    assert os.path.basename(term_a["file"]) in ("same.mp4", "same (1).mp4")
    assert os.path.basename(term_b["file"]) in ("same.mp4", "same (1).mp4")
    assert {os.path.basename(term_a["file"]), os.path.basename(term_b["file"])} == {
        "same.mp4", "same (1).mp4",
    }

    # Staging templates must be distinct and never the bare final path.
    assert len(outtmpls) == 2
    assert outtmpls[0] != outtmpls[1]
    bare = str(dest / "same.mp4")
    for o in outtmpls:
        assert o.replace("%%", "%") != bare

    # Both finals exist with their full payloads (no partial clobber).
    bodies = {
        open(term_a["file"], "rb").read(),
        open(term_b["file"], "rb").read(),
    }
    assert bodies == {b"JOB-A-PAYLOAD", b"JOB-B-PAYLOAD"}


# ---------------------------------------------------------------------------
# 17. Target created after dedup, before promotion: sentinel preserved
# ---------------------------------------------------------------------------

def test_target_occupied_after_dedup_before_promote_preserves_sentinel(
        tmp_path, monkeypatch):
    """A file created after pre-dedup must not be overwritten by promotion.

    Job may pick another actual path or emit one local_io; never done->sentinel.
    """
    import mchost.downloads as d

    sent = []
    dest = tmp_path / "race-dedup"
    dest.mkdir()
    final = dest / "clip.mp4"
    sentinel = b"SENTINEL-PREEXISTING-CONTENTS"
    payload = b"DOWNLOAD-PAYLOAD-XXX"
    calls = []

    def fake_popen(*a, **k):
        calls.append((a, k))
        cmd = list(a[0]) if a else []
        out = cmd[cmd.index("-o") + 1] if "-o" in cmd else ""
        path = out.replace("%%", "%")
        # After host pre-deduped a free target, occupy that committed name.
        final.write_bytes(sentinel)
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(path, "wb") as f:
            f.write(payload)
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)

    d.handle_ytdl({
        "id": "jobOcc",
        "attemptToken": "atk-occ",
        "url": "https://example.test/v",
        "name": "clip.mp4",
        "dir": str(dest),
    })
    term = _wait_terminal(sent, "jobOcc")
    # Sentinel must remain byte-for-byte unchanged.
    assert final.is_file()
    assert final.read_bytes() == sentinel
    if term["type"] == "ytdl-done":
        assert term["file"] != str(final)
        assert term["bytes"] == len(payload)
        assert os.path.isfile(term["file"])
        assert open(term["file"], "rb").read() == payload
        assert os.path.basename(term["file"]) != "clip.mp4" or term["file"] != str(final)
    else:
        assert term["type"] == "ytdl-error"
        assert term["reason"] == "local_io"
        assert term["attemptToken"] == "atk-occ"
    assert not any(
        m.get("type") == "ytdl-done" and m.get("file") == str(final)
        for m in sent if m.get("id") == "jobOcc"
    )


# ---------------------------------------------------------------------------
# 18. Adversarial race between existence observation and commit: no clobber
# ---------------------------------------------------------------------------

def test_adversarial_promote_race_no_clobber(tmp_path, monkeypatch):
    """Insert target between observe-free and commit; exclusive promote must not clobber.

    Mutation: exists-then-os.replace overwrites the inserted sentinel.
    """
    import mchost.downloads as d

    dest = tmp_path / "adv"
    dest.mkdir()
    final = dest / "clip.mp4"
    sentinel = b"ADVERSARIAL-SENTINEL-BYTES"
    payload = b"PROMOTED-PAYLOAD"
    src = dest / "_src_clip.mp4"
    src.write_bytes(payload)

    final_abs = os.path.normcase(os.path.abspath(str(final)))
    inserted = {"done": False}
    replace_calls = []

    real_replace = d.os.replace
    real_link = d.os.link
    real_open = d.os.open

    def _insert_sentinel(dst_p):
        try:
            dst_abs = os.path.normcase(os.path.abspath(dst_p))
        except Exception:
            return
        if dst_abs != final_abs or inserted["done"]:
            return
        if os.path.exists(dst_p) or os.path.lexists(dst_p):
            return
        with open(dst_p, "wb") as f:
            f.write(sentinel)
        inserted["done"] = True

    def replace_hook(src_p, dst_p, *a, **k):
        replace_calls.append((src_p, dst_p))
        _insert_sentinel(dst_p)
        return real_replace(src_p, dst_p, *a, **k)

    def link_hook(src_p, dst_p):
        _insert_sentinel(dst_p)
        return real_link(src_p, dst_p)

    def open_hook(path, flags, mode=0o777, *a, **k):
        if flags & getattr(os, "O_EXCL", 0):
            _insert_sentinel(path)
        return real_open(path, flags, mode, *a, **k)

    monkeypatch.setattr(d.os, "replace", replace_hook)
    monkeypatch.setattr(d.os, "link", link_hook)
    monkeypatch.setattr(d.os, "open", open_hook)

    result = d._ytdl_promote_to_target(str(src), str(final))

    # If the adversary successfully inserted on the preferred target, those
    # bytes must remain untouched — never replaced/clobbered.
    if inserted["done"]:
        assert final.is_file()
        assert final.read_bytes() == sentinel, (
            "promote clobbered an adversarially inserted target"
        )
        assert result is None or os.path.normcase(os.path.abspath(result)) != final_abs
        if result is not None:
            assert os.path.isfile(result)
            assert open(result, "rb").read() == payload
    else:
        # No insert window: exclusive place may own final with our payload.
        if result is not None and os.path.normcase(os.path.abspath(result)) == final_abs:
            assert final.read_bytes() == payload
    # exists-then-replace must not be the commit strategy.
    if replace_calls:
        for _src, dst in replace_calls:
            if os.path.normcase(os.path.abspath(dst)) == final_abs and inserted["done"]:
                assert final.read_bytes() == sentinel


# ---------------------------------------------------------------------------
# 19. Staging cleanup removes only owned tree (success / fail / cancel / prep)
# ---------------------------------------------------------------------------

def test_staging_cleanup_only_owned_on_all_terminals(tmp_path, monkeypatch):
    """Structured staging cleanup must never touch unrelated or final files."""
    import mchost.downloads as d

    dest = tmp_path / "clean"
    dest.mkdir()
    unrelated = dest / "keep-me.mp4"
    unrelated.write_bytes(b"UNRELATED")
    keep = b"UNRELATED"

    def _run(case, popen=None, ensure=None, cancel=False):
        sent = []
        calls = []

        def fake_popen(*a, **k):
            calls.append((a, k))
            cmd = list(a[0]) if a else []
            out = cmd[cmd.index("-o") + 1] if "-o" in cmd else ""
            path = out.replace("%%", "%")
            parent = os.path.dirname(path)
            if parent:
                os.makedirs(parent, exist_ok=True)
            if case == "success":
                with open(path, "wb") as f:
                    f.write(b"OK")
                return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)
            if case == "fail":
                with open(path, "wb") as f:
                    f.write(b"PARTIAL")
                return LiveProc(lines=["ERROR: boom"], returncode=1)
            # cancel: hold until cancelled
            return LiveProc(
                lines=["[download]   1.0% of  1.00MiB at   1.00MiB/s ETA 00:99"],
                returncode=0,
                hold=hold,
            )

        hold = threading.Event()
        _patch_ytdl_base(monkeypatch, d, mc, sent, popen=popen or fake_popen)
        if ensure is not None:
            monkeypatch.setattr(d, "ensure_ytdlp", ensure)

        jid = "jobClean-%s" % case
        token = "atk-clean-%s" % case
        d.handle_ytdl({
            "id": jid,
            "attemptToken": token,
            "url": "https://example.test/v",
            "name": "out.mp4",
            "dir": str(dest),
        })
        staging_paths = []
        if case == "cancel":
            assert wait_for(lambda: d._PGET.get(jid) is not None, timeout=5)
            # Capture staging from Popen if it already ran.
            if calls:
                cmd = list(calls[0][0][0]) if calls[0][0] else []
                if "-o" in cmd:
                    staging_paths.append(cmd[cmd.index("-o") + 1].replace("%%", "%"))
            d._pget_cancel({"id": jid, "attemptToken": token})
            hold.set()
        term = _wait_terminal(sent, jid)
        assert len([m for m in sent if m.get("type") in ("ytdl-done", "ytdl-error")
                    and m.get("id") == jid]) == 1
        # Unrelated file always survives.
        assert unrelated.read_bytes() == keep
        # No leftover staging dirs under dest.
        leftover_dirs = [
            p for p in dest.iterdir()
            if p.is_dir() and p.name.startswith(".mc-ytdl")
        ]
        assert leftover_dirs == [], leftover_dirs
        # Registry cleared.
        assert d._PGET.get(jid) is None
        return term, calls

    # Success
    term, calls = _run("success")
    assert term["type"] == "ytdl-done"
    assert (dest / "out.mp4").is_file()
    assert unrelated.read_bytes() == keep

    # Failure
    term, _ = _run("fail")
    assert term["type"] == "ytdl-error"
    assert unrelated.read_bytes() == keep

    # Cancel
    term, _ = _run("cancel")
    assert term["type"] == "ytdl-error"
    assert term["reason"] == "cancelled"
    assert unrelated.read_bytes() == keep

    # Preparation exception (ensure_ytdlp)
    def boom_ensure():
        raise RuntimeError("ensure exploded with secret C:\\Users\\x\\cookies.txt")

    term, _ = _run("prep", ensure=boom_ensure)
    assert term["type"] == "ytdl-error"
    assert term["reason"] in ("local_io", "permanent")
    err = term.get("error") or ""
    assert "Traceback" not in err
    assert "cookies" not in err.lower()
    assert "RuntimeError" not in err
    assert unrelated.read_bytes() == keep


# ---------------------------------------------------------------------------
# 20. Cancel vs commit linearization: cancel-before-commit wins; post-commit inert
# ---------------------------------------------------------------------------

def test_cancel_before_commit_linearization_and_post_commit_inert(
        tmp_path, monkeypatch):
    """Cancel after subprocess exit but before commit must beat done; post-commit cancel is inert."""
    import mchost.downloads as d

    sent = []
    dest = tmp_path / "lin"
    dest.mkdir()
    payload = b"LINEARIZE"
    entered_promote = threading.Event()
    release_promote = threading.Event()
    jid = "jobLin"
    token = "atk-lin"

    def fake_popen(*a, **k):
        cmd = list(a[0]) if a else []
        out = cmd[cmd.index("-o") + 1] if "-o" in cmd else ""
        path = out.replace("%%", "%")
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(path, "wb") as f:
            f.write(payload)
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    # Gate the promote helper so cancel can win the pre-commit window.
    real_promote = d._ytdl_promote_to_target

    def gated_promote(src, target):
        entered_promote.set()
        assert release_promote.wait(timeout=5)
        return real_promote(src, target)

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)
    monkeypatch.setattr(d, "_ytdl_promote_to_target", gated_promote)

    d.handle_ytdl({
        "id": jid,
        "attemptToken": token,
        "url": "https://example.test/v",
        "name": "lin.mp4",
        "dir": str(dest),
    })
    assert wait_for(entered_promote.is_set, timeout=5)
    # Cancel in the post-wait / pre-commit window.
    d._pget_cancel({"id": jid, "attemptToken": token})
    release_promote.set()
    term = _wait_terminal(sent, jid)
    assert term["type"] == "ytdl-error"
    assert term["reason"] == "cancelled"
    assert term["attemptToken"] == token
    terms = [m for m in sent if m.get("type") in ("ytdl-done", "ytdl-error") and m.get("id") == jid]
    assert len(terms) == 1
    assert not any(m.get("type") == "ytdl-done" for m in sent if m.get("id") == jid)
    # No falsely reported final as done (file may or may not exist on disk).
    assert d._PGET.get(jid) is None

    # --- Success wins commit; a later cancel is inert (no second terminal) ---
    sent.clear()
    jid2 = "jobLin2"
    token2 = "atk-lin2"
    monkeypatch.setattr(d, "_ytdl_promote_to_target", real_promote)

    d.handle_ytdl({
        "id": jid2,
        "attemptToken": token2,
        "url": "https://example.test/v2",
        "name": "lin2.mp4",
        "dir": str(dest),
    })
    term2 = _wait_terminal(sent, jid2)
    assert term2["type"] == "ytdl-done"
    assert term2["attemptToken"] == token2
    before = len(sent)
    d._pget_cancel({"id": jid2, "attemptToken": token2})
    assert len(sent) == before
    assert d._PGET.get(jid2) is None
    terms2 = [m for m in sent if m.get("type") in ("ytdl-done", "ytdl-error") and m.get("id") == jid2]
    assert len(terms2) == 1


# ---------------------------------------------------------------------------
# 21. Prep exceptions: ensure_ytdlp / ensure_deno / start_pot_provider
# ---------------------------------------------------------------------------

def test_prep_exceptions_emit_one_safe_error_and_unregister(tmp_path, monkeypatch):
    """Unexpected prep failures must emit exactly one safe structured error."""
    import mchost.downloads as d

    dest = tmp_path / "prep-exc"
    dest.mkdir()
    spawned = []

    def fake_popen(*a, **k):
        spawned.append(1)
        return LiveProc(lines=[], returncode=1)

    cases = [
        ("ensure_ytdlp", "ensure_ytdlp", RuntimeError("ytdlp secret /home/u/.mozilla")),
        ("ensure_deno", "ensure_deno", ValueError("deno fail C:\\secret\\path")),
        ("start_pot_provider", "start_pot_provider", OSError("pot bind 127.0.0.1:1")),
    ]

    for label, attr, exc in cases:
        sent = []
        spawned.clear()
        _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)

        def boom(_e=exc):
            raise _e

        monkeypatch.setattr(d, attr, boom)
        # Other prep steps succeed when not the one under test.
        if attr != "ensure_ytdlp":
            monkeypatch.setattr(d, "ensure_ytdlp", lambda: "yt-dlp-fake")
        if attr != "ensure_deno":
            monkeypatch.setattr(d, "ensure_deno", lambda: None)
        if attr != "start_pot_provider":
            monkeypatch.setattr(d, "start_pot_provider", lambda: False)

        jid = "jobPrepX-%s" % label
        token = "atk-prepx-%s" % label
        d.handle_ytdl({
            "id": jid,
            "attemptToken": token,
            "url": "https://example.test/secret-video",
            "name": "p.mp4",
            "dir": str(dest),
        })
        term = _wait_terminal(sent, jid)
        assert term["type"] == "ytdl-error", label
        assert term["attemptToken"] == token, label
        assert term["reason"] in ("local_io", "permanent"), label
        err = term.get("error") or ""
        assert "Traceback" not in err, label
        assert "secret" not in err.lower(), label
        assert "https://" not in err, label
        assert ".mozilla" not in err, label
        assert str(exc) not in err, label
        assert not spawned, label
        assert d._PGET.get(jid) is None, label
        terms = [m for m in sent if m.get("type") in ("ytdl-done", "ytdl-error") and m.get("id") == jid]
        assert len(terms) == 1, label

        # Reentrant same-id retry remains possible after unregister.
        sent.clear()
        _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)

        def ok_popen(*a, **k):
            cmd = list(a[0]) if a else []
            out = cmd[cmd.index("-o") + 1] if "-o" in cmd else str(dest / "p.mp4")
            path = out.replace("%%", "%")
            parent = os.path.dirname(path)
            if parent:
                os.makedirs(parent, exist_ok=True)
            with open(path, "wb") as f:
                f.write(b"R")
            return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

        monkeypatch.setattr(d.subprocess, "Popen", ok_popen)
        monkeypatch.setattr(d, "ensure_ytdlp", lambda: "yt-dlp-fake")
        monkeypatch.setattr(d, "ensure_deno", lambda: None)
        monkeypatch.setattr(d, "start_pot_provider", lambda: False)
        d.handle_ytdl({
            "id": jid,
            "attemptToken": token + "-retry",
            "url": "https://example.test/v",
            "name": "retry-%s.mp4" % label,
            "dir": str(dest),
        })
        term2 = _wait_terminal(sent, jid)
        assert term2["type"] == "ytdl-done", label
        assert term2["attemptToken"] == token + "-retry", label


# ---------------------------------------------------------------------------
# 22. C1 controls in format rejected; ordinary selectors accepted
# ---------------------------------------------------------------------------

def test_format_c1_controls_rejected_ordinary_accepted(tmp_path, monkeypatch):
    """U+007F/U+0085/U+009F in format fail closed; normal selectors still work."""
    import mchost.downloads as d

    sent = []
    dest = tmp_path / "c1"
    dest.mkdir()
    spawned = []

    def fake_popen(*a, **k):
        spawned.append(1)
        cmd = list(a[0]) if a else []
        out = cmd[cmd.index("-o") + 1] if "-o" in cmd else str(dest / "x.mp4")
        path = out.replace("%%", "%")
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(path, "wb") as f:
            f.write(b"F")
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)

    base = {
        "id": "jobC1",
        "attemptToken": "atk-c1",
        "url": "https://example.test/v",
        "name": "c.mp4",
        "dir": str(dest),
    }

    for i, bad in enumerate(("bv*\x7f+ba", "bv*\x85+ba", "bv*\x9f+ba", "x\x85y")):
        spawned.clear()
        sent.clear()
        d._PGET.pop("jobC1", None)
        d.handle_ytdl({**base, "format": bad})
        wait_for(lambda: bool(spawned) or any(m.get("type") == "ytdl-error" for m in sent),
                 timeout=0.5)
        assert not spawned, "C1 case %d spawned" % i
        assert d._PGET.get("jobC1") is None
        errs = [m for m in sent if m.get("type") == "ytdl-error"]
        assert len(errs) == 1
        assert errs[0]["attemptToken"] == "atk-c1"
        assert errs[0]["reason"] == "permanent"
        assert not any(m.get("type") == "ytdl-done" for m in sent)
        # No legacy downgrade (title template path).
        assert not any("%(title)" in str(m) for m in sent)

    # Ordinary selected format still accepted and spawned.
    spawned.clear()
    sent.clear()
    d.handle_ytdl({
        **base,
        "id": "jobC1ok",
        "attemptToken": "atk-c1-ok",
        "format": "bv*[height<=1080]+ba/b[height<=1080]",
    })
    term = _wait_terminal(sent, "jobC1ok")
    assert term["type"] == "ytdl-done"
    assert spawned


# ---------------------------------------------------------------------------
# 23. Legacy builder/output-template/force-overwrite unchanged
# ---------------------------------------------------------------------------

def test_legacy_builder_outtmpl_force_overwrite_unchanged(tmp_path, monkeypatch):
    """Legacy token-omitted path keeps title/ID template and --force-overwrites."""
    import mchost.downloads as d

    sent = []
    dest = tmp_path / "leg2"
    dest.mkdir()
    calls = []
    final = dest / "T [id].mp4"

    def fake_popen(*a, **k):
        calls.append((a, k))
        final.write_bytes(b"L")
        return LiveProc(lines=["@@FILE@@ %s" % final], returncode=0)

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)

    # Direct builder shape.
    cmd = d._ytdl_build_cmd("yt-dlp", "bv*+ba/b",
                            os.path.join(str(dest), "%(title).150B [%(id)s].%(ext)s"),
                            "https://example.test/v", None, False)
    assert "--force-overwrites" in cmd
    assert cmd[cmd.index("-o") + 1].endswith("%(title).150B [%(id)s].%(ext)s") or \
        "%(title)" in cmd[cmd.index("-o") + 1]
    assert "%(id)s" in cmd[cmd.index("-o") + 1]
    assert cmd[cmd.index("-f") + 1] == "bv*+ba/b"

    d.handle_ytdl({
        "id": "jobLeg2",
        "url": "https://example.test/v",
        "dir": str(dest),
    })
    term = _wait_terminal(sent, "jobLeg2")
    assert term["type"] == "ytdl-done"
    assert "attemptToken" not in term
    lcmd = _cmd_from_popen_calls(calls)
    assert "--force-overwrites" in lcmd
    assert "%(title)" in lcmd[lcmd.index("-o") + 1]
    assert "%(id)s" in lcmd[lcmd.index("-o") + 1]
