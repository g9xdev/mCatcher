"""Token-bound yt-dlp Save As protocol (v2) — focused host tests.

Deterministic fakes only: no network and no real yt-dlp process.
"""
import os
import subprocess
import sys
import threading
import time

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


def _materialize_stage_from_cmd(a, payload):
    """Write payload at the host-provided -o staging path; return that path."""
    cmd = list(a[0]) if a else []
    out = cmd[cmd.index("-o") + 1] if "-o" in cmd else ""
    path = out.replace("%%", "%")
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "wb") as f:
        f.write(payload)
    return path


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
        # Simulate yt-dlp writing at the op-owned staging -o path (not the final).
        cmd = list(a[0]) if a else []
        if "-o" in cmd:
            stage_path = _materialize_stage_from_cmd(a, payload)
            lines = ["[download] 100.0% of 1.00KiB at 1.00KiB/s ETA 00:00",
                     "@@FILE@@ %s" % stage_path]
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
        stage_path = _materialize_stage_from_cmd(a, payload)
        return LiveProc(
            lines=["@@FILE@@ %s" % stage_path],
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
        # Write into the op-owned stage; host promotes onto the deduped final.
        # Host may escape % in template; unescaped basename should be clip (1).mp4
        stage_path = _materialize_stage_from_cmd(a, payload)
        return LiveProc(
            lines=["@@FILE@@ %s" % stage_path],
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
    assert open(term["file"], "rb").read() == payload
    cmd = _cmd_from_popen_calls(calls)
    outtmpl = cmd[cmd.index("-o") + 1]
    # Stage uses the requested safe leaf; collision is resolved only at commit.
    assert "clip.mp4" in outtmpl.replace("%%", "%")
    assert ".mc-ytdl-" in outtmpl.replace("%%", "%")


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
        stage_path = _materialize_stage_from_cmd(a, b"T")
        return LiveProc(lines=[
            "[youtube] abc: Downloading webpage",
            "[download] Destination: %s" % stage_path,
            "[download]  10.0% of  1.00MiB at   1.00MiB/s ETA 00:01",
            "[download]  50.0% of  1.00MiB at   1.00MiB/s ETA 00:00",
            "Merging formats into %s" % stage_path,
            "@@FILE@@ %s" % stage_path,
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
        path = _materialize_stage_from_cmd(a, b"P")
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

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

    # Case C: handle FileStandardInfo EndOfFile is the size authority — a
    # hostile os.path.getsize cannot invent success or negative wire bytes.
    sent.clear()

    def popen_neg(*a, **k):
        path = _materialize_stage_from_cmd(a, b"ABC")
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    monkeypatch.setattr(d.subprocess, "Popen", popen_neg)
    monkeypatch.setattr(d.os.path, "getsize", lambda p: -1)
    d.handle_ytdl({
        "id": "jobNeg",
        "attemptToken": "atk-neg",
        "url": "https://example.test/v",
        "name": "neg.mp4",
        "dir": str(dest),
    })
    term = _wait_terminal(sent, "jobNeg")
    # Handle-captured nonnegative EndOfFile wins; path getsize is irrelevant.
    assert term["type"] == "ytdl-done"
    assert term["attemptToken"] == "atk-neg"
    assert term["bytes"] == 3
    assert open(term["file"], "rb").read() == b"ABC"

    # Case D: reject when handle standard info reports unusable EndOfFile.
    sent.clear()
    real_open_src = d._ytdl_open_stage_source

    def open_bad_size(stage_handle, stage_display, filepath):
        owned = real_open_src(stage_handle, stage_display, filepath)
        if owned is not None:
            owned = dict(owned)
            owned["size"] = -1
        return owned

    monkeypatch.setattr(d, "_ytdl_open_stage_source", open_bad_size)
    monkeypatch.setattr(d.subprocess, "Popen", popen_neg)
    d.handle_ytdl({
        "id": "jobNeg2",
        "attemptToken": "atk-neg2",
        "url": "https://example.test/v",
        "name": "neg2.mp4",
        "dir": str(dest),
    })
    term = _wait_terminal(sent, "jobNeg2")
    # size is captured inside open; forcing negative after open is a test hook —
    # production open already rejects negative EndOfFile. Ensure commit path
    # still never emits negative bytes on wire for a synthetic bad size.
    if term["type"] == "ytdl-done":
        assert term["bytes"] >= 0
    else:
        assert term["reason"] in ("local_io", "permanent")


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
# 17. ctypes ABI for Nt FILE_RENAME_INFORMATION + rename class
# ---------------------------------------------------------------------------

def test_file_rename_information_abi_and_nt_class(monkeypatch):
    """Offsets/UTF-16 length match x64 layout; rename uses Nt class 10 only."""
    import ctypes
    import tempfile
    import mchost.downloads as d

    offs = d._ytdl_rename_info_offsets()
    assert offs["ReplaceIfExists"] == 0
    assert offs["RootDirectory"] == 8
    assert offs["FileNameLength"] == 16
    assert offs["FileName"] == 20
    assert offs["sizeof_prefix"] >= 22

    root = 0x1122334455667788
    leaf_ascii = "clip.mp4"
    buf, size, flen, enc = d._ytdl_build_rename_buffer(root, leaf_ascii)
    assert flen == len(leaf_ascii) * 2
    assert enc == leaf_ascii.encode("utf-16-le")
    assert size >= offs["FileName"] + flen
    raw = bytes(buf)[:size]
    assert raw[0] == 0
    got_root = int.from_bytes(raw[8:16], "little")
    assert got_root == (root & ((1 << (ctypes.sizeof(ctypes.c_void_p) * 8)) - 1))
    got_len = int.from_bytes(raw[16:20], "little")
    assert got_len == flen
    assert raw[20:20 + flen] == enc

    leaf_u = "clip-\U0001f600.mp4"
    buf2, size2, flen2, enc2 = d._ytdl_build_rename_buffer(0xAB, leaf_u)
    assert flen2 == len(leaf_u.encode("utf-16-le"))
    assert enc2 == leaf_u.encode("utf-16-le")
    assert bytes(buf2)[20:20 + flen2] == enc2

    api = d._ytdl_winapi()
    assert api is not None
    seen = []
    real_nt = api.ntdll.NtSetInformationFile
    real_sfih = api.k32.SetFileInformationByHandle

    def nt_hook(handle, iosb, buf, length, klass):
        seen.append(("nt", int(klass)))
        return real_nt(handle, iosb, buf, length, klass)

    def sfih_hook(handle, klass, info, length):
        seen.append(("win32", int(klass)))
        return real_sfih(handle, klass, info, length)

    monkeypatch.setattr(api.ntdll, "NtSetInformationFile", nt_hook)
    monkeypatch.setattr(api.k32, "SetFileInformationByHandle", sfih_hook)

    dest = tempfile.mkdtemp(prefix="ytdl-abi-")
    lease = d._ytdl_acquire_dest_lease(dest)
    assert lease is not None
    stage_h, leaf, stage_disp = d._ytdl_create_stage_dir(lease)
    assert stage_h
    src_path = os.path.join(stage_disp, "a.mp4")
    with open(src_path, "wb") as f:
        f.write(b"X")
    owned = d._ytdl_open_stage_source(stage_h, stage_disp, src_path)
    assert owned is not None
    path = d._ytdl_commit_source(owned["handle"], lease, "a.mp4")
    assert path is not None
    d._ytdl_dispose_handle(owned["handle"], delete=False)
    d._ytdl_cleanup_stage_tree(stage_h)
    d._ytdl_release_dest_lease(lease)
    assert any(kind == "nt" and klass == 10 for kind, klass in seen), seen
    assert not any(kind == "win32" and klass == 3 for kind, klass in seen), seen


# ---------------------------------------------------------------------------
# 18. Real Windows temp-volume integration
# ---------------------------------------------------------------------------

def test_windows_handle_commit_integration_collision_and_sentinel(tmp_path):
    """Pinned dest + handle stage/source + Nt relative rename; sentinel preserved."""
    import mchost.downloads as d

    dest = tmp_path / "integ"
    dest.mkdir()
    sentinel = dest / "clip.mp4"
    sentinel.write_bytes(b"SENTINEL-BYTES")
    lease = d._ytdl_acquire_dest_lease(str(dest))
    assert lease is not None
    stage_h, stage_leaf, stage_disp = d._ytdl_create_stage_dir(lease)
    assert stage_h and stage_leaf.startswith(".mc-ytdl-")
    payload = b"OWNED-PAYLOAD-XYZ"
    src = os.path.join(stage_disp, "clip.mp4")
    with open(src, "wb") as f:
        f.write(payload)
    owned = d._ytdl_open_stage_source(stage_h, stage_disp, src)
    assert owned is not None
    assert owned["size"] == len(payload)
    path = d._ytdl_commit_source(owned["handle"], lease, "clip.mp4")
    assert path is not None
    assert os.path.basename(path) == "clip (1).mp4"
    d._ytdl_dispose_handle(owned["handle"], delete=False)
    assert sentinel.read_bytes() == b"SENTINEL-BYTES"
    assert open(path, "rb").read() == payload
    assert not os.path.exists(src)
    d._ytdl_cleanup_stage_tree(stage_h)
    d._ytdl_release_dest_lease(lease)
    assert not any(p.name.startswith(".mc-ytdl-") for p in dest.iterdir() if p.is_dir())

# ---------------------------------------------------------------------------
# 19. Concurrent same-destination lease/refcount + same-name commits
# ---------------------------------------------------------------------------

def test_concurrent_dest_lease_refcount_and_same_name_commits(tmp_path, monkeypatch):
    """Shared dest lease refcount; two same-name jobs -> two full distinct files."""
    import mchost.downloads as d

    dest = tmp_path / "lease"
    dest.mkdir()
    sent = []
    create_calls = []
    api = d._ytdl_winapi()
    assert api is not None
    real_create = api.k32.CreateFileW

    def tracking_create(*a, **k):
        create_calls.append(a[0] if a else None)
        return real_create(*a, **k)

    monkeypatch.setattr(api.k32, "CreateFileW", tracking_create)

    barrier = threading.Barrier(2)
    idx = {"n": 0}
    lock = threading.Lock()

    def fake_popen(*a, **k):
        with lock:
            my = idx["n"]
            idx["n"] += 1
        path = _materialize_stage_from_cmd(a, b"A" * (10 + my))
        barrier.wait(timeout=5)
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)
    d.handle_ytdl({
        "id": "jobL1", "attemptToken": "atk-l1", "url": "https://example.test/a",
        "name": "same.mp4", "dir": str(dest),
    })
    d.handle_ytdl({
        "id": "jobL2", "attemptToken": "atk-l2", "url": "https://example.test/b",
        "name": "same.mp4", "dir": str(dest),
    })
    t1 = _wait_terminal(sent, "jobL1")
    t2 = _wait_terminal(sent, "jobL2")
    assert t1["type"] == "ytdl-done" and t2["type"] == "ytdl-done"
    assert t1["file"] != t2["file"]
    bodies = {open(t1["file"], "rb").read(), open(t2["file"], "rb").read()}
    assert bodies == {b"A" * 10, b"A" * 11}
    # Destination chain opens the immutable root via CreateFileW; components are
    # handle-relative. Process-local lease refcounting still shares one lease.
    key = d._ytdl_canon_path_key(str(dest))
    assert d._YTDL_DEST_LEASES.get(key) is None
    assert create_calls, "expected at least one root CreateFileW"


# ---------------------------------------------------------------------------
# 20. Final ownership held through terminal
# ---------------------------------------------------------------------------

def test_committed_handle_blocks_replace_until_terminal(tmp_path, monkeypatch):
    """Between commit claim and terminal, external replace/delete of final fails."""
    import mchost.downloads as d

    dest = tmp_path / "own"
    dest.mkdir()
    sent = []
    payload = b"OWNED-FINAL-BYTES"
    race = {"checked": False, "replace_ok": None, "delete_ok": None}

    def fake_popen(*a, **k):
        path = _materialize_stage_from_cmd(a, payload)
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    def capturing_send(msg):
        if msg.get("type") == "ytdl-done" and not race["checked"]:
            race["checked"] = True
            path = msg.get("file")
            try:
                os.replace(path, path + ".moved")
                race["replace_ok"] = True
            except OSError:
                race["replace_ok"] = False
            try:
                os.unlink(path)
                race["delete_ok"] = True
            except OSError:
                race["delete_ok"] = False
        sent.append(dict(msg))

    monkeypatch.setattr(mc, "send", capturing_send)
    monkeypatch.setattr(d, "_h", lambda: mc)
    monkeypatch.setattr(d, "ensure_ytdlp", lambda: "yt-dlp-fake")
    monkeypatch.setattr(d, "ensure_deno", lambda: None)
    monkeypatch.setattr(d, "start_pot_provider", lambda: False)
    monkeypatch.setattr(d, "_no_window", lambda: (0, None))
    monkeypatch.setattr(mc, "FFMPEG", None)
    monkeypatch.setattr(d.subprocess, "Popen", fake_popen)

    d.handle_ytdl({
        "id": "jobOwn", "attemptToken": "atk-own",
        "url": "https://example.test/v", "name": "clip.mp4", "dir": str(dest),
    })
    term = _wait_terminal(sent, "jobOwn")
    assert term["type"] == "ytdl-done"
    assert term["bytes"] == len(payload)
    assert term["file"] and open(term["file"], "rb").read() == payload
    assert race["checked"] is True
    assert race["replace_ok"] is False
    assert race["delete_ok"] is False


# ---------------------------------------------------------------------------
# 21. Cleanup disposition uses handle; no pathname deletes
# ---------------------------------------------------------------------------

def test_cleanup_disposition_preserves_replacement_zero_path_deletes(tmp_path, monkeypatch):
    """Disposition targets held handles only; pathname deletes unused; swap after open ignored."""
    import mchost.downloads as d

    dest = tmp_path / "crepl"
    dest.mkdir()
    outside = tmp_path / "outside-secret.mp4"
    outside.write_bytes(b"OUTSIDE-SECRET")
    sent = []
    path_deletes = []
    disposed_handles = []
    stage_handle_box = {"h": None}

    def track_unlink(path, *a, **k):
        path_deletes.append(("unlink", path))
        raise AssertionError("os.unlink must not be used on structured path")

    def track_remove(path, *a, **k):
        path_deletes.append(("remove", path))
        raise AssertionError("os.remove must not be used")

    def track_rmtree(path, *a, **k):
        path_deletes.append(("rmtree", path))
        raise AssertionError("shutil.rmtree must not be used")

    def track_link(src, dst, *a, **k):
        path_deletes.append(("link", src, dst))
        raise AssertionError("os.link must not be used")

    monkeypatch.setattr(d.os, "unlink", track_unlink)
    monkeypatch.setattr(d.os, "remove", track_remove)
    monkeypatch.setattr(d.shutil, "rmtree", track_rmtree)
    monkeypatch.setattr(d.os, "link", track_link)

    real_disp = d._ytdl_set_disposition_delete

    def track_disp(handle):
        disposed_handles.append(int(handle) if handle else None)
        return real_disp(handle)

    monkeypatch.setattr(d, "_ytdl_set_disposition_delete", track_disp)

    real_create_stage = d._ytdl_create_stage_dir

    def create_stage_track(lease):
        h, leaf, disp = real_create_stage(lease)
        stage_handle_box["h"] = int(h) if h else None
        return h, leaf, disp

    monkeypatch.setattr(d, "_ytdl_create_stage_dir", create_stage_track)

    post_wait = threading.Event()
    release = threading.Event()
    payload = b"TO-DISPOSE"
    swapped = {"did": False, "path": None}

    def after_wait():
        # Contest the stage directory path after handles are held: rename the
        # pathname away and drop a decoy. Cleanup must still only act on the
        # exact held stage handle, never the decoy/outside paths.
        try:
            if stage_handle_box["h"] and not swapped["did"]:
                # Locate live stage path via display under dest.
                stages = [p for p in dest.iterdir() if p.is_dir() and p.name.startswith(".mc-ytdl-")]
                if stages:
                    sp = stages[0]
                    decoy = dest / (sp.name + ".decoy")
                    decoy.mkdir()
                    (decoy / "decoy.mp4").write_bytes(b"DECOY")
                    swapped["path"] = str(sp)
                    swapped["did"] = True
        except OSError:
            pass
        post_wait.set()
        assert release.wait(timeout=5)

    def fake_popen(*a, **k):
        path = _materialize_stage_from_cmd(a, payload)
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0, after_wait=after_wait)

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)
    d.handle_ytdl({
        "id": "jobCrepl", "attemptToken": "atk-crepl",
        "url": "https://example.test/v", "name": "clip.mp4", "dir": str(dest),
    })
    assert wait_for(post_wait.is_set, timeout=5)
    d._pget_cancel({"id": "jobCrepl", "attemptToken": "atk-crepl"})
    release.set()
    term = _wait_terminal(sent, "jobCrepl")
    assert term["type"] == "ytdl-error"
    assert term["reason"] == "cancelled"
    assert path_deletes == []
    assert outside.read_bytes() == b"OUTSIDE-SECRET"
    assert not (dest / "clip.mp4").exists()
    # Held stage handle must have been dispositioned; outside never touched.
    assert stage_handle_box["h"] is not None
    assert stage_handle_box["h"] in disposed_handles
    decoys = [p for p in dest.iterdir() if p.name.endswith(".decoy")]
    for decoy in decoys:
        assert (decoy / "decoy.mp4").read_bytes() == b"DECOY"


# ---------------------------------------------------------------------------
# 22. Cleanup enumeration failure safely leaks stage debris
# ---------------------------------------------------------------------------

def test_cleanup_failure_safe_leak_one_terminal(tmp_path, monkeypatch):
    """NtQueryDirectoryFile failure leaks private stage; one safe terminal."""
    import mchost.downloads as d

    dest = tmp_path / "leak"
    dest.mkdir()
    outside = tmp_path / "outside-secret.mp4"
    outside.write_bytes(b"OUTSIDE-SECRET")
    sent = []
    path_mut = []

    def ban_unlink(path, *a, **k):
        path_mut.append(path)
        raise AssertionError("no path unlink")

    monkeypatch.setattr(d.os, "unlink", ban_unlink)
    monkeypatch.setattr(d.os, "remove", ban_unlink)
    monkeypatch.setattr(d.shutil, "rmtree", lambda *a, **k: (_ for _ in ()).throw(AssertionError("rmtree")))

    api = d._ytdl_winapi()

    def fail_query(*a, **k):
        return 0xC0000001

    def fake_popen(*a, **k):
        path = _materialize_stage_from_cmd(a, b"X")
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=1)

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)
    monkeypatch.setattr(api.ntdll, "NtQueryDirectoryFile", fail_query)

    d.handle_ytdl({
        "id": "jobLeak", "attemptToken": "atk-leak",
        "url": "https://example.test/v", "name": "clip.mp4", "dir": str(dest),
    })
    term = _wait_terminal(sent, "jobLeak")
    assert term["type"] == "ytdl-error"
    assert len([m for m in sent if m.get("type") in ("ytdl-done", "ytdl-error") and m.get("id") == "jobLeak"]) == 1
    assert path_mut == []
    assert outside.read_bytes() == b"OUTSIDE-SECRET"
    leftover = [p for p in dest.iterdir() if p.is_dir() and p.name.startswith(".mc-ytdl-")]
    assert leftover

# ---------------------------------------------------------------------------
# 23. Stage swap/junction blocked; source opens relative to stage handle
# ---------------------------------------------------------------------------

def test_stage_handle_relative_open_ignores_path_swap(tmp_path, monkeypatch):
    """After stage pin, relative source opens use stage handle; OUTSIDE-SECRET intact."""
    import mchost.downloads as d

    dest = tmp_path / "swap"
    dest.mkdir()
    outside = tmp_path / "outside-secret.mp4"
    outside.write_bytes(b"OUTSIDE-SECRET")
    sent = []
    open_roots = []
    api = d._ytdl_winapi()
    real_ntc = api.ntdll.NtCreateFile
    stage_handle_box = {"h": None}

    def ntc_hook(handle_p, access, oa, iosb, alloc, attrs, share, disp, options, ea, ealen):
        root = None
        try:
            if oa:
                root = int(oa.contents.RootDirectory)
        except Exception:
            root = None
        if int(options) & d._YTDL_FILE_NON_DIRECTORY_FILE:
            open_roots.append(root)
        return real_ntc(handle_p, access, oa, iosb, alloc, attrs, share, disp, options, ea, ealen)

    monkeypatch.setattr(api.ntdll, "NtCreateFile", ntc_hook)
    real_create_stage = d._ytdl_create_stage_dir

    def create_stage_track(lease):
        h, leaf, disp = real_create_stage(lease)
        stage_handle_box["h"] = int(h) if h else None
        return h, leaf, disp

    monkeypatch.setattr(d, "_ytdl_create_stage_dir", create_stage_track)

    def fake_popen(*a, **k):
        path = _materialize_stage_from_cmd(a, b"STAGE-BODY")
        parent = os.path.dirname(path)
        try:
            os.rename(parent, parent + ".moved")
            stage_renamed = True
        except OSError:
            stage_renamed = False
        fake_popen.stage_renamed = stage_renamed
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    fake_popen.stage_renamed = None
    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)
    d.handle_ytdl({
        "id": "jobSwap", "attemptToken": "atk-swap",
        "url": "https://example.test/v", "name": "clip.mp4", "dir": str(dest),
    })
    term = _wait_terminal(sent, "jobSwap")
    assert term["type"] in ("ytdl-done", "ytdl-error")
    assert outside.read_bytes() == b"OUTSIDE-SECRET"
    # Stage directory pin omits SHARE_DELETE, so rename should be blocked.
    assert fake_popen.stage_renamed is False
    assert stage_handle_box["h"] is not None
    assert open_roots, "expected handle-relative source open"
    assert all(r == stage_handle_box["h"] for r in open_roots if r), open_roots


# ---------------------------------------------------------------------------
# 24. Reparse / hostile marker rejection
# ---------------------------------------------------------------------------

def test_reparse_and_hostile_markers_never_touch_outside(tmp_path, monkeypatch):
    """Reparse/symlink/ADS/nested/.. /outside/hardlink markers fail closed."""
    import mchost.downloads as d

    dest = tmp_path / "rep"
    dest.mkdir()
    outside = tmp_path / "outside-secret.mp4"
    outside.write_bytes(b"OUTSIDE-SECRET")
    keep = b"OUTSIDE-SECRET"

    def _run(marker_line, extra=None):
        sent = []

        def fake_popen(*a, **k):
            path = _materialize_stage_from_cmd(a, b"STAGE")
            parent = os.path.dirname(path)
            if extra:
                extra(path, parent)
            line = marker_line(path, parent) if callable(marker_line) else marker_line
            return LiveProc(lines=["@@FILE@@ %s" % line], returncode=0)

        _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)
        jid = "jobRep-%s" % (abs(hash(str(marker_line))) % 10**8)
        d.handle_ytdl({
            "id": jid, "attemptToken": "atk-%s" % jid,
            "url": "https://example.test/secret", "name": "clip.mp4", "dir": str(dest),
        })
        term = _wait_terminal(sent, jid)
        assert term["type"] == "ytdl-error"
        assert term["reason"] == "local_io"
        assert outside.read_bytes() == keep
        assert not any(m.get("type") == "ytdl-done" and m.get("id") == jid for m in sent)
        return term

    _run(str(outside))
    _run(lambda path, parent: os.path.abspath(os.path.join(parent, "..", "outside-secret.mp4")))
    _run(lambda path, parent: os.path.join(parent, "nested", "x.mp4"))
    _run(lambda path, parent: os.path.join(parent, "evil:ads.mp4"))
    _run(lambda path, parent: parent)
    _run("")
    _run("   ")

    def setup_link(path, parent):
        link = os.path.join(parent, "escape.mp4")
        try:
            if os.path.lexists(link):
                os.unlink(link)
            os.symlink(str(outside), link)
        except (OSError, NotImplementedError):
            pass

    try:
        probe = dest / "_symlink_probe"
        if probe.exists() or probe.is_symlink():
            probe.unlink()
        os.symlink(str(outside), str(probe))
        probe.unlink()
        symlink_ok = True
    except (OSError, NotImplementedError):
        symlink_ok = False
    if symlink_ok:
        _run(lambda path, parent: os.path.join(parent, "escape.mp4"), extra=setup_link)
        assert outside.read_bytes() == keep

    def setup_hard(path, parent):
        link = os.path.join(parent, "hard.mp4")
        try:
            if os.path.lexists(link):
                os.unlink(link)
            os.link(str(outside), link)
        except OSError:
            pass

    try:
        hl = dest / "_hl"
        if hl.exists():
            hl.unlink()
        os.link(str(outside), str(hl))
        hl.unlink()
        hard_ok = True
    except OSError:
        hard_ok = False
    if hard_ok:
        _run(lambda path, parent: os.path.join(parent, "hard.mp4"), extra=setup_hard)
        assert outside.read_bytes() == keep


# ---------------------------------------------------------------------------
# 25. Finding 4: post-rename path helpers cannot demote success
# ---------------------------------------------------------------------------

def test_post_rename_path_helper_failure_still_ytdl_done(tmp_path, monkeypatch):
    """Successful Nt rename still emits ytdl-done when GetFinalPathName fails."""
    import mchost.downloads as d

    dest = tmp_path / "post"
    dest.mkdir()
    sent = []
    payload = b"COMMITTED-BYTES"

    def fake_popen(*a, **k):
        path = _materialize_stage_from_cmd(a, payload)
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    # Force every optional post-rename diagnostic path query to fail after
    # the successful rename decision — never demote a successful Nt rename.
    real_commit = d._ytdl_commit_with_candidates
    calls = {"n": 0}

    def commit_then_break(source_handle, candidates, op=None):
        path = real_commit(source_handle, candidates, op=op)
        calls["n"] += 1
        monkeypatch.setattr(d, "_ytdl_final_path", lambda h: (_ for _ in ()).throw(OSError("diag boom")))
        api = d._ytdl_winapi()
        monkeypatch.setattr(api.k32, "GetFinalPathNameByHandleW", lambda *a, **k: 0)
        return path

    monkeypatch.setattr(d, "_ytdl_commit_with_candidates", commit_then_break)
    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)
    d.handle_ytdl({
        "id": "jobPost", "attemptToken": "atk-post",
        "url": "https://example.test/v", "name": "clip.mp4", "dir": str(dest),
    })
    term = _wait_terminal(sent, "jobPost")
    assert term["type"] == "ytdl-done"
    assert term["file"] == str(dest / "clip.mp4")
    assert term["bytes"] == len(payload)
    assert (dest / "clip.mp4").read_bytes() == payload
    assert calls["n"] == 1
    assert not any(m.get("type") == "ytdl-error" and m.get("id") == "jobPost" for m in sent)


# ---------------------------------------------------------------------------
# 26. Cancel-first vs commit-first linearization
# ---------------------------------------------------------------------------

def test_cancel_first_zero_rename_commit_first_inert(tmp_path, monkeypatch):
    """Cancel-before-commit: 0 Nt renames, no final. Commit-first overlaps lock-held rename."""
    import mchost.downloads as d

    dest = tmp_path / "lin"
    dest.mkdir()
    payload = b"LINEARIZE"
    rename_calls = []
    api = d._ytdl_winapi()
    real_nt = api.ntdll.NtSetInformationFile

    def nt_hook(handle, iosb, buf, length, klass):
        rename_calls.append(int(klass))
        return real_nt(handle, iosb, buf, length, klass)

    monkeypatch.setattr(api.ntdll, "NtSetInformationFile", nt_hook)

    sent = []
    post_wait = threading.Event()
    release = threading.Event()

    def after_wait():
        post_wait.set()
        assert release.wait(timeout=5)

    def fake_popen(*a, **k):
        path = _materialize_stage_from_cmd(a, payload)
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0, after_wait=after_wait)

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)
    d.handle_ytdl({
        "id": "jobLin", "attemptToken": "atk-lin",
        "url": "https://example.test/v", "name": "lin.mp4", "dir": str(dest),
    })
    assert wait_for(post_wait.is_set, timeout=5)
    d._pget_cancel({"id": "jobLin", "attemptToken": "atk-lin"})
    release.set()
    term = _wait_terminal(sent, "jobLin")
    assert term["type"] == "ytdl-error" and term["reason"] == "cancelled"
    assert rename_calls == []
    assert not (dest / "lin.mp4").exists()

    # Commit-first: cancel must race an in-progress lock-held commit, not a
    # post-terminal unregistration. Hold Nt rename while cancel blocks on lock.
    sent.clear()
    rename_calls.clear()
    in_rename = threading.Event()
    release_rename = threading.Event()
    claimed_under_lock = {"v": None}
    cancel_result = {"done": False}

    def nt_hold(handle, iosb, buf, length, klass):
        rename_calls.append(int(klass))
        if int(klass) == 10:
            in_rename.set()
            assert release_rename.wait(timeout=5)
            status = real_nt(handle, iosb, buf, length, klass)
            # After NT success the production code must claim before lock release.
            return status
        return real_nt(handle, iosb, buf, length, klass)

    monkeypatch.setattr(api.ntdll, "NtSetInformationFile", nt_hold)

    real_commit = d._ytdl_commit_source

    def commit_probe(source_handle, dest_lease, safe_name, max_attempts=32, **kw):
        # Prefer new prebuilt API if present; fall through to real.
        if "candidates" in kw or "op" in kw:
            return real_commit(source_handle, dest_lease, safe_name, max_attempts=max_attempts, **kw)
        return real_commit(source_handle, dest_lease, safe_name, max_attempts=max_attempts)

    def ok_popen(*a, **k):
        path = _materialize_stage_from_cmd(a, b"COMMITTED")
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    monkeypatch.setattr(d.subprocess, "Popen", ok_popen)
    d.handle_ytdl({
        "id": "jobLin2", "attemptToken": "atk-lin2",
        "url": "https://example.test/v2", "name": "lin2.mp4", "dir": str(dest),
    })
    assert wait_for(in_rename.is_set, timeout=5)
    op = d._PGET.get("jobLin2")
    assert op is not None

    def cancel_racer():
        d._pget_cancel({"id": "jobLin2", "attemptToken": "atk-lin2"})
        cancel_result["done"] = True
        if op is not None:
            claimed_under_lock["v"] = bool(op.get("commit_claimed"))

    t = threading.Thread(target=cancel_racer, daemon=True)
    t.start()
    # Cancel must be blocked on ytdl_lock while rename is in progress.
    assert not cancel_result["done"]
    release_rename.set()
    t.join(timeout=5)
    term2 = _wait_terminal(sent, "jobLin2")
    assert term2["type"] == "ytdl-done"
    assert term2["bytes"] == len(b"COMMITTED")
    assert open(term2["file"], "rb").read() == b"COMMITTED"
    assert 10 in rename_calls
    assert op.get("commit_claimed") is True
    # Cancel lost the race: no cancelled terminal, final survives.
    assert not any(
        m.get("type") == "ytdl-error" and m.get("id") == "jobLin2" for m in sent
    )
    assert os.path.isfile(term2["file"])


# ---------------------------------------------------------------------------
# 27. Bounded collision exhaustion
# ---------------------------------------------------------------------------

def test_bounded_collision_exhaustion_no_overwrite(tmp_path, monkeypatch):
    """32 occupied candidates -> one local_io, no overwrite, no infinite loop."""
    import mchost.downloads as d

    dest = tmp_path / "exh"
    dest.mkdir()
    for i in range(0, 32):
        name = "clip.mp4" if i == 0 else "clip (%d).mp4" % i
        (dest / name).write_bytes(b"OCCUPIED-%d" % i)
    sent = []
    rename_n = {"n": 0}
    api = d._ytdl_winapi()
    real_nt = api.ntdll.NtSetInformationFile

    def nt_hook(handle, iosb, buf, length, klass):
        rename_n["n"] += 1
        assert rename_n["n"] <= 32
        return real_nt(handle, iosb, buf, length, klass)

    monkeypatch.setattr(api.ntdll, "NtSetInformationFile", nt_hook)

    def fake_popen(*a, **k):
        path = _materialize_stage_from_cmd(a, b"NEW")
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)
    d.handle_ytdl({
        "id": "jobExh", "attemptToken": "atk-exh",
        "url": "https://example.test/v", "name": "clip.mp4", "dir": str(dest),
    })
    term = _wait_terminal(sent, "jobExh")
    assert term["type"] == "ytdl-error"
    assert term["reason"] == "local_io"
    assert rename_n["n"] == 32
    for i in range(0, 32):
        name = "clip.mp4" if i == 0 else "clip (%d).mp4" % i
        assert (dest / name).read_bytes() == b"OCCUPIED-%d" % i

# ---------------------------------------------------------------------------
# 28. Handle lifetime close-once matrix (representative paths)
# ---------------------------------------------------------------------------

def test_handle_close_once_matrix(tmp_path, monkeypatch):
    """Source/final/stage/dest close exactly once across success and failure paths."""
    import mchost.downloads as d

    dest = tmp_path / "life"
    dest.mkdir()
    real_acquire = d._ytdl_acquire_dest_lease
    real_close = d._ytdl_close_handle
    real_query = d._ytdl_query_tag_std
    real_rename = d._ytdl_nt_rename_no_replace
    real_commit = d._ytdl_commit_with_candidates
    api = d._ytdl_winapi()
    real_k32_close = api.k32.CloseHandle

    def run(case):
        sent = []
        jid = "jobLife-%s" % case
        hold = threading.Event()
        release = threading.Event()
        close_calls = []
        k32_closes = []
        # Restore core bindings between cases so patches do not leak.
        monkeypatch.setattr(d, "_ytdl_acquire_dest_lease", real_acquire)
        monkeypatch.setattr(d, "_ytdl_query_tag_std", real_query)
        monkeypatch.setattr(d, "_ytdl_nt_rename_no_replace", real_rename)
        monkeypatch.setattr(d, "_ytdl_commit_with_candidates", real_commit)
        monkeypatch.setattr(api.k32, "CloseHandle", real_k32_close)

        def track_close(handle):
            if handle:
                close_calls.append(int(handle))
            return real_close(handle)

        def track_k32_close(handle):
            try:
                k32_closes.append(int(handle) if handle is not None else None)
            except Exception:
                k32_closes.append(handle)
            return real_k32_close(handle)

        monkeypatch.setattr(d, "_ytdl_close_handle", track_close)
        monkeypatch.setattr(api.k32, "CloseHandle", track_k32_close)

        def after_wait():
            hold.set()
            if case == "cancel":
                assert release.wait(timeout=5)

        def fake_popen(*a, **k):
            if case == "subprocess_fail":
                path = _materialize_stage_from_cmd(a, b"P")
                return LiveProc(lines=["ERROR: boom"], returncode=1)
            if case == "validation_fail":
                path = _materialize_stage_from_cmd(a, b"P")
                return LiveProc(lines=["@@FILE@@ C:\\Windows\\notepad.exe"], returncode=0)
            if case == "open_fail":
                path = _materialize_stage_from_cmd(a, b"P")
                parent = os.path.dirname(path)
                return LiveProc(
                    lines=["@@FILE@@ %s" % os.path.join(parent, "nested", "x.mp4")],
                    returncode=0,
                )
            if case == "rename_fail":
                path = _materialize_stage_from_cmd(a, b"P")
                return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)
            path = _materialize_stage_from_cmd(a, b"OK")
            return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

        if case == "cancel":
            def popen_cancel(*a, **k):
                path = _materialize_stage_from_cmd(a, b"C")
                return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0, after_wait=after_wait)
            _patch_ytdl_base(monkeypatch, d, mc, sent, popen=popen_cancel)
        else:
            _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)

        if case == "setup_fail":
            monkeypatch.setattr(d, "_ytdl_acquire_dest_lease", lambda *a, **k: None)

        if case == "query_fail":
            state = {"n": 0}

            def q(handle):
                state["n"] += 1
                if state["n"] >= 2:
                    return None
                return real_query(handle)

            monkeypatch.setattr(d, "_ytdl_query_tag_std", q)

        if case == "rename_fail":
            monkeypatch.setattr(d, "_ytdl_nt_rename_no_replace", lambda *a, **k: "error")
            monkeypatch.setattr(d, "_ytdl_commit_with_candidates", lambda *a, **k: None)

        if case == "send_throw":
            def boom_send(msg):
                sent.append(dict(msg))
                if msg.get("type") == "ytdl-done":
                    raise RuntimeError("send boom")
            monkeypatch.setattr(mc, "send", boom_send)

        d.handle_ytdl({
            "id": jid, "attemptToken": "atk-%s" % case,
            "url": "https://example.test/v", "name": "%s.mp4" % case, "dir": str(dest),
        })
        if case == "cancel":
            assert wait_for(hold.is_set, timeout=5)
            d._pget_cancel({"id": jid, "attemptToken": "atk-%s" % case})
            release.set()
        term = _wait_terminal(sent, jid, timeout=5)
        assert d._PGET.get(jid) is None
        key = d._ytdl_canon_path_key(str(dest))
        assert d._YTDL_DEST_LEASES.get(key) is None
        # Each closed handle value appears exactly once in the close tracker.
        assert len(close_calls) == len(set(close_calls)), (case, close_calls)
        return term, close_calls, k32_closes

    t, closes, _ = run("success")
    assert t["type"] == "ytdl-done"
    assert closes  # at least stage/source/dest chain closed
    assert run("subprocess_fail")[0]["type"] == "ytdl-error"
    assert run("validation_fail")[0]["type"] == "ytdl-error"
    assert run("setup_fail")[0]["type"] == "ytdl-error"
    assert run("open_fail")[0]["type"] == "ytdl-error"
    assert run("query_fail")[0]["type"] == "ytdl-error"
    assert run("rename_fail")[0]["type"] == "ytdl-error"
    assert run("cancel")[0]["reason"] == "cancelled"
    t, _, _ = run("send_throw")
    assert t["type"] == "ytdl-done"


# ---------------------------------------------------------------------------
# 29. Regression: Florenfile / percent / 150-char / merge / tokens / default dest
# ---------------------------------------------------------------------------

def test_regression_florenfile_percent_merge_default_token(tmp_path, monkeypatch):
    """Preserve exact smart names, merge child, default dest, tokens."""
    import mchost.downloads as d

    dest = tmp_path / "reg"
    dest.mkdir()
    sent = []
    name = "11238-makemebi.net.mp4"
    payload = b"FLOREN"

    def popen1(*a, **k):
        path = _materialize_stage_from_cmd(a, payload)
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=popen1)
    d.handle_ytdl({
        "id": "jobF", "attemptToken": "atk-f",
        "url": "https://example.test/v", "name": name, "dir": str(dest),
    })
    term = _wait_terminal(sent, "jobF")
    assert term["type"] == "ytdl-done"
    assert os.path.basename(term["file"]) == name
    assert term["attemptToken"] == "atk-f"
    assert term["bytes"] == len(payload)

    sent.clear()
    long_name = ("a" * 146) + ".mp4"
    assert len(long_name) == 150

    def popen2(*a, **k):
        path = _materialize_stage_from_cmd(a, b"L")
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    monkeypatch.setattr(d.subprocess, "Popen", popen2)
    d.handle_ytdl({
        "id": "job150", "attemptToken": "atk-150",
        "url": "https://example.test/v", "name": long_name, "dir": str(dest),
    })
    term = _wait_terminal(sent, "job150")
    assert term["type"] == "ytdl-done"
    assert os.path.basename(term["file"]) == long_name

    sent.clear()
    merge_payload = b"MERGED"

    def popen3(*a, **k):
        cmd = list(a[0])
        out = cmd[cmd.index("-o") + 1].replace("%%", "%")
        parent = os.path.dirname(out)
        os.makedirs(parent, exist_ok=True)
        merged = os.path.join(parent, "wanted.merged.mp4")
        with open(merged, "wb") as f:
            f.write(merge_payload)
        return LiveProc(lines=["@@FILE@@ %s" % merged], returncode=0)

    monkeypatch.setattr(d.subprocess, "Popen", popen3)
    d.handle_ytdl({
        "id": "jobM", "attemptToken": "atk-m",
        "url": "https://example.test/v", "name": "merged-out.mp4", "dir": str(dest),
    })
    term = _wait_terminal(sent, "jobM")
    assert term["type"] == "ytdl-done"
    assert os.path.basename(term["file"]) == "merged-out.mp4"
    assert open(term["file"], "rb").read() == merge_payload

    sent.clear()
    default_dir = dest / "Downloads"
    default_dir.mkdir()
    monkeypatch.setattr(mc, "downloads_dir", lambda: str(default_dir))
    monkeypatch.setattr(mc, "load_config", lambda: {})
    monkeypatch.setattr(d.subprocess, "Popen", popen1)
    d.handle_ytdl({
        "id": "jobDef", "attemptToken": "atk-def",
        "url": "https://example.test/v", "name": "def.mp4",
    })
    term = _wait_terminal(sent, "jobDef")
    assert term["type"] == "ytdl-done"
    assert os.path.normcase(os.path.dirname(term["file"])) == os.path.normcase(str(default_dir))


# ---------------------------------------------------------------------------
# 30. Static source guard
# ---------------------------------------------------------------------------

def test_static_source_guard_structured_handle_path():
    """Structured handle path must not reintroduce rejected pathname schemes."""
    import inspect
    import mchost.downloads as d

    src = inspect.getsource(d)
    for name in (
        "_ytdl_try_exclusive_place",
        "_ytdl_promote_to_target",
        "_ytdl_owned_stage_source",
        "_ytdl_snapshot_path_identity",
        "_ytdl_unlink_if_identity",
        "_ytdl_cleanup_exclusive_fd",
        "_ytdl_cleanup_stage_dir",
    ):
        assert ("def %s" % name) not in src, name
    assert "_YTDL_FileRenameInformation = 10" in src
    assert "NtSetInformationFile" in src
    assert "_ytdl_acquire_dest_lease" in src
    assert "_ytdl_commit_source" in src
    assert "_ytdl_cleanup_stage_tree" in src
    # No pathname hardlink/copy/replace/unlink/rmtree fallback on structured worker.
    worker = inspect.getsource(d._handle_ytdl_structured)
    for banned in ("os.link(", "os.replace(", "shutil.copy", "shutil.rmtree", "os.unlink(", "os.remove("):
        assert banned not in worker, banned
    # Success authority is prevalidated size + prebuilt display; no post-rename
    # path verdict helpers inside commit.
    commit_src = inspect.getsource(d._ytdl_commit_source)
    assert "os.path.isfile" not in commit_src
    assert "os.path.getsize" not in commit_src
    assert "os.stat" not in commit_src
    assert "os.lstat" not in commit_src


# ---------------------------------------------------------------------------
# 31. Occupied preferred name after stage write still no-clobber
# ---------------------------------------------------------------------------

def test_target_occupied_before_commit_preserves_sentinel(tmp_path, monkeypatch):
    """Existing/race-created final name is never overwritten; dedup sibling used."""
    import mchost.downloads as d

    sent = []
    dest = tmp_path / "race"
    dest.mkdir()
    final = dest / "clip.mp4"
    sentinel = b"SENTINEL-PREEXISTING-CONTENTS"
    payload = b"DOWNLOAD-PAYLOAD-XXX"

    def fake_popen(*a, **k):
        final.write_bytes(sentinel)
        path = _materialize_stage_from_cmd(a, payload)
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)
    d.handle_ytdl({
        "id": "jobOcc", "attemptToken": "atk-occ",
        "url": "https://example.test/v", "name": "clip.mp4", "dir": str(dest),
    })
    term = _wait_terminal(sent, "jobOcc")
    assert final.read_bytes() == sentinel
    assert term["type"] == "ytdl-done"
    assert term["file"] != str(final)
    assert os.path.basename(term["file"]) == "clip (1).mp4"
    assert open(term["file"], "rb").read() == payload


# ---------------------------------------------------------------------------
# 32. Staging cleanup only owned; success/fail/cancel/prep
# ---------------------------------------------------------------------------

def test_staging_cleanup_only_owned_on_all_terminals(tmp_path, monkeypatch):
    """Structured staging cleanup must never touch unrelated or final files."""
    import mchost.downloads as d

    dest = tmp_path / "clean"
    dest.mkdir()
    unrelated = dest / "keep-me.mp4"
    unrelated.write_bytes(b"UNRELATED")
    keep = b"UNRELATED"

    def _run(case, ensure=None):
        sent = []
        hold = threading.Event()

        def fake_popen(*a, **k):
            if case == "success":
                path = _materialize_stage_from_cmd(a, b"OK")
                return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)
            if case == "fail":
                path = _materialize_stage_from_cmd(a, b"PARTIAL")
                return LiveProc(lines=["ERROR: boom"], returncode=1)
            return LiveProc(
                lines=["[download]   1.0% of  1.00MiB at   1.00MiB/s ETA 00:99"],
                returncode=0,
                hold=hold,
            )

        _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)
        if ensure is not None:
            monkeypatch.setattr(d, "ensure_ytdlp", ensure)
        jid = "jobClean-%s" % case
        token = "atk-clean-%s" % case
        d.handle_ytdl({
            "id": jid, "attemptToken": token,
            "url": "https://example.test/v", "name": "out.mp4", "dir": str(dest),
        })
        if case == "cancel":
            assert wait_for(lambda: d._PGET.get(jid) is not None, timeout=5)
            d._pget_cancel({"id": jid, "attemptToken": token})
            hold.set()
        term = _wait_terminal(sent, jid)
        assert unrelated.read_bytes() == keep
        leftover = [p for p in dest.iterdir() if p.is_dir() and p.name.startswith(".mc-ytdl")]
        if case in ("success", "fail", "cancel"):
            assert leftover == [], leftover
        assert d._PGET.get(jid) is None
        return term

    assert _run("success")["type"] == "ytdl-done"
    assert (dest / "out.mp4").is_file()
    assert _run("fail")["type"] == "ytdl-error"
    assert _run("cancel")["reason"] == "cancelled"

    def boom_ensure():
        raise RuntimeError("ensure exploded with secret C:\\Users\\x\\cookies.txt")

    term = _run("prep", ensure=boom_ensure)
    assert term["type"] == "ytdl-error"
    err = term.get("error") or ""
    assert "cookies" not in err.lower()
    assert "Traceback" not in err


# ---------------------------------------------------------------------------
# 33. Prep exceptions remain one safe error
# ---------------------------------------------------------------------------

def test_prep_exceptions_emit_one_safe_error_and_unregister(tmp_path, monkeypatch):
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
        if attr != "ensure_ytdlp":
            monkeypatch.setattr(d, "ensure_ytdlp", lambda: "yt-dlp-fake")
        if attr != "ensure_deno":
            monkeypatch.setattr(d, "ensure_deno", lambda: None)
        if attr != "start_pot_provider":
            monkeypatch.setattr(d, "start_pot_provider", lambda: False)
        jid = "jobPrepX-%s" % label
        token = "atk-prepx-%s" % label
        d.handle_ytdl({
            "id": jid, "attemptToken": token,
            "url": "https://example.test/secret-video", "name": "p.mp4", "dir": str(dest),
        })
        term = _wait_terminal(sent, jid)
        assert term["type"] == "ytdl-error", label
        assert term["attemptToken"] == token, label
        err = term.get("error") or ""
        assert "secret" not in err.lower(), label
        assert not spawned, label
        assert d._PGET.get(jid) is None, label


# ---------------------------------------------------------------------------
# 34. Format C1 controls + legacy builder unchanged
# ---------------------------------------------------------------------------

def test_format_c1_controls_rejected_ordinary_accepted(tmp_path, monkeypatch):
    import mchost.downloads as d

    sent = []
    dest = tmp_path / "c1"
    dest.mkdir()
    spawned = []

    def fake_popen(*a, **k):
        spawned.append(1)
        path = _materialize_stage_from_cmd(a, b"F")
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)
    base = {
        "id": "jobC1", "attemptToken": "atk-c1",
        "url": "https://example.test/v", "name": "c.mp4", "dir": str(dest),
    }
    for i, bad in enumerate(("bv*\x7f+ba", "bv*\x85+ba", "bv*\x9f+ba", "x\x85y")):
        spawned.clear()
        sent.clear()
        d._PGET.pop("jobC1", None)
        d.handle_ytdl({**base, "format": bad})
        wait_for(lambda: bool(spawned) or any(m.get("type") == "ytdl-error" for m in sent), timeout=0.5)
        assert not spawned, i
        assert d._PGET.get("jobC1") is None
        errs = [m for m in sent if m.get("type") == "ytdl-error"]
        assert len(errs) == 1
        assert errs[0]["reason"] == "permanent"

    spawned.clear()
    sent.clear()
    d.handle_ytdl({
        **base, "id": "jobC1ok", "attemptToken": "atk-c1-ok",
        "format": "bv*[height<=1080]+ba/b[height<=1080]",
    })
    term = _wait_terminal(sent, "jobC1ok")
    assert term["type"] == "ytdl-done"
    assert spawned


def test_legacy_builder_outtmpl_force_overwrite_unchanged(tmp_path, monkeypatch):
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
    cmd = d._ytdl_build_cmd(
        "yt-dlp", "bv*+ba/b",
        os.path.join(str(dest), "%(title).150B [%(id)s].%(ext)s"),
        "https://example.test/v", None, False,
    )
    assert "--force-overwrites" in cmd
    assert "%(title)" in cmd[cmd.index("-o") + 1]
    d.handle_ytdl({"id": "jobLeg2", "url": "https://example.test/v", "dir": str(dest)})
    term = _wait_terminal(sent, "jobLeg2")
    assert term["type"] == "ytdl-done"
    assert "attemptToken" not in term


# ---------------------------------------------------------------------------
# 35. Marker must stay inside owned stage
# ---------------------------------------------------------------------------

def test_file_marker_path_must_stay_inside_owned_stage(tmp_path, monkeypatch):
    import mchost.downloads as d

    dest = tmp_path / "esc"
    dest.mkdir()
    outside = tmp_path / "outside-secret.mp4"
    outside.write_bytes(b"DO-NOT-TOUCH")
    keep = b"DO-NOT-TOUCH"

    def _run(file_line, extra_setup=None):
        sent = []

        def fake_popen(*a, **k):
            path = _materialize_stage_from_cmd(a, b"STAGE-BODY")
            parent = os.path.dirname(path)
            if extra_setup is not None:
                extra_setup(path, parent)
            line = file_line(path, parent) if callable(file_line) else file_line
            return LiveProc(
                lines=["@@FILE@@ %s" % line] if line is not None else ["@@FILE@@"],
                returncode=0,
            )

        _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)
        jid = "jobEsc-%s" % (abs(hash(str(file_line))) % 10**8)
        d.handle_ytdl({
            "id": jid, "attemptToken": "atk-%s" % jid,
            "url": "https://example.test/secret-video", "name": "clip.mp4", "dir": str(dest),
        })
        term = _wait_terminal(sent, jid)
        assert term["type"] == "ytdl-error"
        assert outside.read_bytes() == keep
        assert not any(m.get("type") == "ytdl-done" and m.get("id") == jid for m in sent)
        return term

    _run(str(outside))
    _run(lambda path, parent: os.path.abspath(os.path.join(parent, "..", "..", "outside-secret.mp4")))
    peer = dest.parent / (dest.name + "-evil")
    peer.mkdir(exist_ok=True)
    peer_file = peer / "clip.mp4"
    peer_file.write_bytes(b"PEER-SECRET")
    _run(str(peer_file))
    assert peer_file.read_bytes() == b"PEER-SECRET"
    _run("")
    _run("   ")
    _run(lambda path, parent: parent)


def test_legitimate_stage_and_merge_descendant_accepted(tmp_path, monkeypatch):
    import mchost.downloads as d

    dest = tmp_path / "legit"
    dest.mkdir()
    sent = []
    payload = b"INTENDED-STAGE"

    def popen_intended(*a, **k):
        path = _materialize_stage_from_cmd(a, payload)
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=popen_intended)
    d.handle_ytdl({
        "id": "jobLegit1", "attemptToken": "atk-legit1",
        "url": "https://example.test/v", "name": "wanted.mp4", "dir": str(dest),
    })
    term = _wait_terminal(sent, "jobLegit1")
    assert term["type"] == "ytdl-done"
    assert os.path.basename(term["file"]) == "wanted.mp4"
    assert open(term["file"], "rb").read() == payload

    sent.clear()
    merge_payload = b"MERGED-OUTPUT-BYTES"

    def popen_merge(*a, **k):
        cmd = list(a[0])
        out = cmd[cmd.index("-o") + 1].replace("%%", "%")
        parent = os.path.dirname(out)
        os.makedirs(parent, exist_ok=True)
        merged = os.path.join(parent, "wanted.merged.mp4")
        with open(merged, "wb") as f:
            f.write(merge_payload)
        return LiveProc(lines=["@@FILE@@ %s" % merged], returncode=0)

    monkeypatch.setattr(d.subprocess, "Popen", popen_merge)
    d.handle_ytdl({
        "id": "jobLegit2", "attemptToken": "atk-legit2",
        "url": "https://example.test/v2", "name": "merged-out.mp4", "dir": str(dest),
    })
    term2 = _wait_terminal(sent, "jobLegit2")
    assert term2["type"] == "ytdl-done"
    assert os.path.basename(term2["file"]) == "merged-out.mp4"
    assert open(term2["file"], "rb").read() == merge_payload

    sent.clear()
    existing = dest / "dedupe-me.mp4"
    existing.write_bytes(b"ALREADY-HERE")
    dedup_payload = b"NEW-DEDUP-BODY"

    def popen_dedup(*a, **k):
        path = _materialize_stage_from_cmd(a, dedup_payload)
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    monkeypatch.setattr(d.subprocess, "Popen", popen_dedup)
    d.handle_ytdl({
        "id": "jobLegit3", "attemptToken": "atk-legit3",
        "url": "https://example.test/v3", "name": "dedupe-me.mp4", "dir": str(dest),
    })
    term3 = _wait_terminal(sent, "jobLegit3")
    assert term3["type"] == "ytdl-done"
    assert term3["file"] != str(existing)
    assert existing.read_bytes() == b"ALREADY-HERE"
    assert os.path.basename(term3["file"]) == "dedupe-me (1).mp4"


# ---------------------------------------------------------------------------
# 36. Immediate claim: post-rename path construction cannot demote/delete
# ---------------------------------------------------------------------------

def test_post_rename_join_failure_claims_done_final_survives(tmp_path, monkeypatch):
    """After Nt rename success, path-join failure must not delete the final or emit error."""
    import mchost.downloads as d

    dest = tmp_path / "claim"
    dest.mkdir()
    sent = []
    payload = b"CLAIM-SURVIVES"
    rename_ok = {"n": 0}
    join_after = {"n": 0}
    real_join = os.path.join
    api = d._ytdl_winapi()
    real_nt = api.ntdll.NtSetInformationFile
    real_disp = d._ytdl_set_disposition_delete
    armed = {"v": False}

    def nt_hook(handle, iosb, buf, length, klass):
        st = real_nt(handle, iosb, buf, length, klass)
        if int(klass) == 10 and (st & 0xFFFFFFFF) == 0:
            rename_ok["n"] += 1
            armed["v"] = True
        return st

    def join_hook(*a, **k):
        # Count only downloads-module post-rename joins of the final candidate.
        if armed["v"]:
            join_after["n"] += 1
            raise RuntimeError("post-rename join boom")
        return real_join(*a, **k)

    def disp_hook(handle):
        return real_disp(handle)

    monkeypatch.setattr(api.ntdll, "NtSetInformationFile", nt_hook)
    # Patch only the downloads module binding used by production helpers that
    # still go through os.path.join (prebuild must not run after rename).
    monkeypatch.setattr(d.os.path, "join", join_hook)
    monkeypatch.setattr(d, "_ytdl_set_disposition_delete", disp_hook)

    def fake_popen(*a, **k):
        path = _materialize_stage_from_cmd(a, payload)
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)
    d.handle_ytdl({
        "id": "jobClaim", "attemptToken": "atk-claim",
        "url": "https://example.test/v", "name": "clip.mp4", "dir": str(dest),
    })
    term = _wait_terminal(sent, "jobClaim")
    # Disarm before pytest/pathlib teardown touches os.path.join.
    armed["v"] = False
    assert rename_ok["n"] == 1
    assert term["type"] == "ytdl-done"
    assert term["file"] == str(dest / "clip.mp4")
    assert term["bytes"] == len(payload)
    assert (dest / "clip.mp4").read_bytes() == payload
    assert not any(m.get("type") == "ytdl-error" and m.get("id") == "jobClaim" for m in sent)
    # Production must not call os.path.join after NT rename success.
    assert join_after["n"] == 0
    assert (dest / "clip.mp4").is_file()


def test_post_claim_injected_failures_keep_done_and_final(tmp_path, monkeypatch):
    """Diagnostic/send/log/cleanup/close failures after claim cannot demote or delete final."""
    import mchost.downloads as d

    dest = tmp_path / "postclaim"
    dest.mkdir()
    payload = b"POST-CLAIM-BYTES"
    real_final_path = d._ytdl_final_path
    real_cleanup = d._ytdl_cleanup_stage_tree
    real_close = d._ytdl_close_handle
    real_hlog = mc._hlog

    cases = (
        "diag",
        "send",
        "log",
        "stage_cleanup",
        "close_accounting",
    )
    for case in cases:
        sent = []
        # Restore between cases.
        monkeypatch.setattr(d, "_ytdl_final_path", real_final_path)
        monkeypatch.setattr(d, "_ytdl_cleanup_stage_tree", real_cleanup)
        monkeypatch.setattr(d, "_ytdl_close_handle", real_close)
        monkeypatch.setattr(mc, "_hlog", real_hlog)

        def fake_popen(*a, **k):
            path = _materialize_stage_from_cmd(a, payload)
            return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

        _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)

        if case == "diag":
            # Arm only after rename success so prep logging is unaffected.
            api = d._ytdl_winapi()
            real_nt = api.ntdll.NtSetInformationFile

            def nt_then_diag(handle, iosb, buf, length, klass):
                st = real_nt(handle, iosb, buf, length, klass)
                if int(klass) == 10 and (st & 0xFFFFFFFF) == 0:
                    monkeypatch.setattr(
                        d, "_ytdl_final_path",
                        lambda h: (_ for _ in ()).throw(RuntimeError("diag boom")),
                    )
                return st

            monkeypatch.setattr(api.ntdll, "NtSetInformationFile", nt_then_diag)
        if case == "send":
            def boom_send(msg):
                sent.append(dict(msg))
                if msg.get("type") == "ytdl-done":
                    raise RuntimeError("send boom")
            monkeypatch.setattr(mc, "send", boom_send)
        if case == "log":
            # Boom only the post-claim "saved" log path: wrap commit so the next
            # _hlog after a successful claim raises without breaking prep logs.
            # Default-arg freeze: later cases rebind the name real_commit.
            _commit_log = d._ytdl_commit_with_candidates

            def commit_then_log_boom(source_handle, candidates, op=None, _commit=_commit_log):
                path = _commit(source_handle, candidates, op=op)
                if path:
                    def boom_log(*a, **k):
                        raise RuntimeError("log boom")
                    monkeypatch.setattr(mc, "_hlog", boom_log)
                return path

            monkeypatch.setattr(d, "_ytdl_commit_with_candidates", commit_then_log_boom)
        if case == "stage_cleanup":
            monkeypatch.setattr(
                d, "_ytdl_cleanup_stage_tree",
                lambda h: (_ for _ in ()).throw(RuntimeError("cleanup boom")),
            )
        if case == "close_accounting":
            # Raise on the first close of the committed final after claim, not on
            # incidental closes during prep. Arm via commit wrapper.
            state = {"n": 0, "armed": False}
            # Default-arg freeze so nested log wrapper cannot rebind into recursion.
            _commit_close = d._ytdl_commit_with_candidates

            def commit_arm(source_handle, candidates, op=None, _commit=_commit_close):
                path = _commit(source_handle, candidates, op=op)
                if path:
                    state["armed"] = True
                return path

            def close_boom(handle):
                if state["armed"]:
                    state["n"] += 1
                    if state["n"] == 1:
                        raise RuntimeError("close boom")
                return real_close(handle)

            monkeypatch.setattr(d, "_ytdl_commit_with_candidates", commit_arm)
            monkeypatch.setattr(d, "_ytdl_close_handle", close_boom)

        jid = "jobPC-%s" % case
        d.handle_ytdl({
            "id": jid, "attemptToken": "atk-%s" % case,
            "url": "https://example.test/v", "name": "%s.mp4" % case, "dir": str(dest),
        })
        term = _wait_terminal(sent, jid)
        assert term["type"] == "ytdl-done", case
        assert term["bytes"] == len(payload), case
        assert open(term["file"], "rb").read() == payload, case
        assert not any(
            m.get("type") == "ytdl-error" and m.get("id") == jid for m in sent
        ), case


def test_commit_claimed_true_under_lock_before_cancel_wins(tmp_path, monkeypatch):
    """commit_claimed is set under ytdl_lock immediately after NT success, before cancel."""
    import mchost.downloads as d

    dest = tmp_path / "claimlock"
    dest.mkdir()
    sent = []
    api = d._ytdl_winapi()
    real_nt = api.ntdll.NtSetInformationFile
    in_rename = threading.Event()
    release_rename = threading.Event()
    saw = {"claimed_while_cancel_blocked": None}

    def nt_hold(handle, iosb, buf, length, klass):
        if int(klass) == 10:
            in_rename.set()
            assert release_rename.wait(timeout=5)
        return real_nt(handle, iosb, buf, length, klass)

    monkeypatch.setattr(api.ntdll, "NtSetInformationFile", nt_hold)

    def fake_popen(*a, **k):
        path = _materialize_stage_from_cmd(a, b"L")
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)
    d.handle_ytdl({
        "id": "jobCL", "attemptToken": "atk-cl",
        "url": "https://example.test/v", "name": "c.mp4", "dir": str(dest),
    })
    assert wait_for(in_rename.is_set, timeout=5)
    op = d._PGET["jobCL"]

    def cancel_blocked():
        # This blocks on ytdl_lock until claim finishes.
        d._pget_cancel({"id": "jobCL", "attemptToken": "atk-cl"})
        saw["claimed_while_cancel_blocked"] = bool(op.get("commit_claimed"))

    t = threading.Thread(target=cancel_blocked, daemon=True)
    t.start()
    release_rename.set()
    t.join(timeout=5)
    term = _wait_terminal(sent, "jobCL")
    assert term["type"] == "ytdl-done"
    assert saw["claimed_while_cancel_blocked"] is True
    assert (dest / "c.mp4").is_file()


# ---------------------------------------------------------------------------
# 37. Non-BMP Unicode: real relative open + rename
# ---------------------------------------------------------------------------

def test_non_bmp_leaf_relative_open_and_commit(tmp_path, monkeypatch):
    """clip-😀.mp4 opens relative to stage and renames with exact UTF-16 length/path."""
    import mchost.downloads as d

    dest = tmp_path / "emoji"
    dest.mkdir()
    leaf = "clip-\U0001f600.mp4"
    payload = b"EMOJI-PAYLOAD"
    # Unit: UNICODE_STRING length uses UTF-16LE bytes, not code points.
    keep = []
    us = d._ytdl_make_unicode_string(leaf, keep)
    enc = leaf.encode("utf-16-le")
    assert us.Length == len(enc)
    assert us.MaximumLength == len(enc) + 2
    assert len(enc) == (len(leaf) + 1) * 2  # surrogate pair adds one extra unit
    assert keep, "backing storage must stay alive"

    lease = d._ytdl_acquire_dest_lease(str(dest))
    assert lease is not None
    stage_h, stage_leaf, stage_disp = d._ytdl_create_stage_dir(lease)
    assert stage_h
    src = os.path.join(stage_disp, leaf)
    with open(src, "wb") as f:
        f.write(payload)
    owned = d._ytdl_open_stage_source(stage_h, stage_disp, src)
    assert owned is not None
    assert owned["leaf"] == leaf
    assert owned["size"] == len(payload)
    path = d._ytdl_commit_source(owned["handle"], lease, leaf)
    assert path is not None
    assert os.path.basename(path) == leaf
    assert path == str(dest / leaf)
    d._ytdl_dispose_handle(owned["handle"], delete=False)
    assert open(path, "rb").read() == payload
    d._ytdl_cleanup_stage_tree(stage_h)
    d._ytdl_release_dest_lease(lease)

    # End-to-end structured job with non-BMP name.
    sent = []

    def fake_popen(*a, **k):
        path = _materialize_stage_from_cmd(a, payload)
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)
    d.handle_ytdl({
        "id": "jobEmoji", "attemptToken": "atk-emoji",
        "url": "https://example.test/v", "name": leaf, "dir": str(dest),
    })
    term = _wait_terminal(sent, "jobEmoji")
    # Preferred name already taken by the unit commit above -> dedup sibling.
    assert term["type"] == "ytdl-done"
    assert term["bytes"] == len(payload)
    assert "\U0001f600" in os.path.basename(term["file"])
    assert open(term["file"], "rb").read() == payload

    # Non-BMP destination component when the volume accepts it.
    try:
        nested = dest / "dir-\U0001f600"
        nested.mkdir()
        lease2 = d._ytdl_acquire_dest_lease(str(nested))
        if lease2 is not None:
            d._ytdl_release_dest_lease(lease2)
            sent.clear()
            d.handle_ytdl({
                "id": "jobEmojiDir", "attemptToken": "atk-emojidir",
                "url": "https://example.test/v2", "name": "x.mp4", "dir": str(nested),
            })
            term2 = _wait_terminal(sent, "jobEmojiDir")
            assert term2["type"] == "ytdl-done"
            assert os.path.normcase(os.path.dirname(term2["file"])) == os.path.normcase(str(nested))
    except OSError:
        pass


# ---------------------------------------------------------------------------
# 38. Raw marker shapes: reject traversal before relative open
# ---------------------------------------------------------------------------

def test_raw_marker_shapes_rejected_before_relative_open(tmp_path, monkeypatch):
    """Raw dot/dotdot/nested/ADS/device/trailing forms rejected; exact child ok."""
    import mchost.downloads as d

    dest = tmp_path / "rawmark"
    dest.mkdir()
    outside = tmp_path / "outside-secret.mp4"
    outside.write_bytes(b"OUTSIDE-SECRET")
    open_calls = []
    api = d._ytdl_winapi()
    real_ntc = api.ntdll.NtCreateFile

    def ntc_hook(handle_p, access, oa, iosb, alloc, attrs, share, disp, options, ea, ealen):
        # Count non-directory relative opens (source opens).
        try:
            if int(options) & d._YTDL_FILE_NON_DIRECTORY_FILE:
                open_calls.append(1)
        except Exception:
            pass
        return real_ntc(handle_p, access, oa, iosb, alloc, attrs, share, disp, options, ea, ealen)

    monkeypatch.setattr(api.ntdll, "NtCreateFile", ntc_hook)

    def _run(marker_fn, expect_open=False):
        sent = []
        open_calls.clear()

        def fake_popen(*a, **k):
            path = _materialize_stage_from_cmd(a, b"BODY")
            parent = os.path.dirname(path)
            line = marker_fn(path, parent)
            return LiveProc(lines=["@@FILE@@ %s" % line], returncode=0)

        _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)
        jid = "jobRaw-%s" % (abs(hash(str(marker_fn))) % 10**8)
        d.handle_ytdl({
            "id": jid, "attemptToken": "atk-%s" % jid,
            "url": "https://example.test/v", "name": "clip.mp4", "dir": str(dest),
        })
        term = _wait_terminal(sent, jid)
        assert outside.read_bytes() == b"OUTSIDE-SECRET"
        if expect_open:
            assert term["type"] == "ytdl-done"
            assert open_calls, "exact child must relative-open"
        else:
            assert term["type"] == "ytdl-error"
            assert term["reason"] == "local_io"
            assert open_calls == [], (marker_fn, open_calls)
        return term

    # Hostile raw forms — must not invoke relative source open.
    cases = [
        ("dot", lambda path, parent: parent + "\\.\\clip.mp4"),
        ("nested_dotdot", lambda path, parent: parent + "\\nested\\..\\clip.mp4"),
        ("up_and_back", lambda path, parent: parent + "\\..\\%s\\clip.mp4" % os.path.basename(parent)),
        ("nested_child", lambda path, parent: os.path.join(parent, "nested", "clip.mp4")),
        ("ads", lambda path, parent: parent + "\\evil:ads.mp4"),
        ("outside", lambda path, parent: str(outside)),
        ("relative", lambda path, parent: "clip.mp4"),
        ("trailing_dot", lambda path, parent: parent + "\\clip.mp4."),
        ("trailing_space", lambda path, parent: parent + "\\clip.mp4 "),
    ]
    for label, fn in cases:
        term = _run(fn, expect_open=False)
        assert term["type"] == "ytdl-error", label
    # Exact raw direct child succeeds.
    _run(lambda path, parent: path, expect_open=True)


# ---------------------------------------------------------------------------
# 39. Destination chain: handle-relative open/create, reparse, failures
# ---------------------------------------------------------------------------

def test_dest_chain_relative_open_create_and_live_until_terminal(tmp_path, monkeypatch):
    """Every dest component opened/created relative to retained parent; live until send."""
    import mchost.downloads as d

    base = tmp_path / "chain"
    base.mkdir()
    nested = base / "a" / "b" / "c"
    # a/b missing — acquire must create atomically relative to parents.
    sent = []
    payload = b"CHAIN"
    api = d._ytdl_winapi()
    real_ntc = api.ntdll.NtCreateFile
    rel_creates = []
    live_at_send = {"chain": None}

    def ntc_hook(handle_p, access, oa, iosb, alloc, attrs, share, disp, options, ea, ealen):
        import ctypes
        root = None
        try:
            if oa is not None:
                p = ctypes.cast(oa, ctypes.POINTER(d._YTDL_OBJECT_ATTRIBUTES))
                rd = int(p.contents.RootDirectory)
                root = rd if rd else None
        except Exception:
            root = None
        rel_creates.append((root, int(disp), int(options)))
        return real_ntc(handle_p, access, oa, iosb, alloc, attrs, share, disp, options, ea, ealen)

    monkeypatch.setattr(api.ntdll, "NtCreateFile", ntc_hook)

    def fake_popen(*a, **k):
        path = _materialize_stage_from_cmd(a, payload)
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    def capturing_send(msg):
        if msg.get("type") == "ytdl-done":
            op = d._PGET.get("jobChain")
            # Lease still held through terminal send.
            key = d._ytdl_canon_path_key(str(nested))
            lease = d._YTDL_DEST_LEASES.get(key)
            live_at_send["chain"] = None if lease is None else list(lease.get("chain") or [])
            live_at_send["handle"] = None if lease is None else lease.get("handle")
        sent.append(dict(msg))

    monkeypatch.setattr(mc, "send", capturing_send)
    monkeypatch.setattr(d, "_h", lambda: mc)
    monkeypatch.setattr(d, "ensure_ytdlp", lambda: "yt-dlp-fake")
    monkeypatch.setattr(d, "ensure_deno", lambda: None)
    monkeypatch.setattr(d, "start_pot_provider", lambda: False)
    monkeypatch.setattr(d, "_no_window", lambda: (0, None))
    monkeypatch.setattr(mc, "FFMPEG", None)
    monkeypatch.setattr(d.subprocess, "Popen", fake_popen)

    d.handle_ytdl({
        "id": "jobChain", "attemptToken": "atk-chain",
        "url": "https://example.test/v", "name": "f.mp4", "dir": str(nested),
    })
    term = _wait_terminal(sent, "jobChain")
    assert term["type"] == "ytdl-done"
    assert nested.is_dir()
    assert open(term["file"], "rb").read() == payload
    # Relative creates/opens happened (chain components under a parent handle).
    assert rel_creates, "expected handle-relative component ops"
    assert any(r for r, _disp, _opt in rel_creates if r), rel_creates
    # Chain handles were live at terminal send.
    assert live_at_send["handle"]
    assert live_at_send["chain"] is not None
    assert len(live_at_send["chain"]) >= 2  # root + at least final
    assert all(h for h in live_at_send["chain"])
    # After terminal, lease released.
    key = d._ytdl_canon_path_key(str(nested))
    assert d._YTDL_DEST_LEASES.get(key) is None


def test_dest_reparse_component_rejected(tmp_path, monkeypatch):
    """Existing reparse/junction component rejected without touching target."""
    import mchost.downloads as d

    dest = tmp_path / "reparse-dest"
    dest.mkdir()
    outside = tmp_path / "outside-target"
    outside.mkdir()
    secret = outside / "secret.txt"
    secret.write_bytes(b"OUTSIDE-TARGET")
    link = dest / "junc"
    try:
        # Prefer junction (directory reparse) when available.
        import _winapi
        try:
            _winapi.CreateJunction(str(outside), str(link))  # type: ignore[attr-defined]
            made = True
        except Exception:
            try:
                os.symlink(str(outside), str(link), target_is_directory=True)
                made = True
            except (OSError, NotImplementedError, AttributeError):
                made = False
    except Exception:
        made = False
    if not made:
        return  # environment cannot create reparse; skip only this case

    # Final component is reparse.
    lease = d._ytdl_acquire_dest_lease(str(link))
    assert lease is None
    assert secret.read_bytes() == b"OUTSIDE-TARGET"

    # Intermediate component is reparse: dest/junc/sub
    deeper = link / "sub"
    lease2 = d._ytdl_acquire_dest_lease(str(deeper))
    assert lease2 is None
    assert secret.read_bytes() == b"OUTSIDE-TARGET"


def test_dest_parent_rename_denied_while_job_runs(tmp_path, monkeypatch):
    """Pinned destination chain denies rename while job holds handles; allowed after."""
    import mchost.downloads as d

    dest = tmp_path / "pinme"
    dest.mkdir()
    sent = []
    race = {"rename_ok": None}

    def fake_popen(*a, **k):
        path = _materialize_stage_from_cmd(a, b"PIN")
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    def capturing_send(msg):
        if msg.get("type") == "ytdl-done" and race["rename_ok"] is None:
            try:
                os.rename(str(dest), str(dest) + ".moved")
                race["rename_ok"] = True
            except OSError:
                race["rename_ok"] = False
        sent.append(dict(msg))

    monkeypatch.setattr(mc, "send", capturing_send)
    monkeypatch.setattr(d, "_h", lambda: mc)
    monkeypatch.setattr(d, "ensure_ytdlp", lambda: "yt-dlp-fake")
    monkeypatch.setattr(d, "ensure_deno", lambda: None)
    monkeypatch.setattr(d, "start_pot_provider", lambda: False)
    monkeypatch.setattr(d, "_no_window", lambda: (0, None))
    monkeypatch.setattr(mc, "FFMPEG", None)
    monkeypatch.setattr(d.subprocess, "Popen", fake_popen)

    d.handle_ytdl({
        "id": "jobPin", "attemptToken": "atk-pin",
        "url": "https://example.test/v", "name": "p.mp4", "dir": str(dest),
    })
    term = _wait_terminal(sent, "jobPin")
    assert term["type"] == "ytdl-done"
    assert race["rename_ok"] is False
    # After terminal + lease release, rename may succeed.
    try:
        os.rename(str(dest), str(dest) + ".after")
        after_ok = True
    except OSError:
        after_ok = False
    assert after_ok is True


def test_dest_metadata_and_open_failures_fail_closed(tmp_path, monkeypatch):
    """Root/relative-open/create-collision/reopen/query failures => one local_io, no fallback."""
    import mchost.downloads as d

    dest = tmp_path / "failclosed"
    dest.mkdir()
    sent = []
    path_mut = []

    monkeypatch.setattr(d.os, "unlink", lambda *a, **k: path_mut.append(a) or (_ for _ in ()).throw(AssertionError("unlink")))
    monkeypatch.setattr(d.shutil, "rmtree", lambda *a, **k: (_ for _ in ()).throw(AssertionError("rmtree")))

    # Force GetFinalPathNameByHandleW failure — must not fail-open validation.
    api = d._ytdl_winapi()
    monkeypatch.setattr(api.k32, "GetFinalPathNameByHandleW", lambda *a, **k: 0)

    def fake_popen(*a, **k):
        path = _materialize_stage_from_cmd(a, b"X")
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)
    d.handle_ytdl({
        "id": "jobGFP", "attemptToken": "atk-gfp",
        "url": "https://example.test/v", "name": "g.mp4", "dir": str(dest),
    })
    term = _wait_terminal(sent, "jobGFP")
    # Secure chain validation still governs; GetFinalPath is diagnostic only.
    assert term["type"] == "ytdl-done"
    assert path_mut == []

    # Force metadata query failure at acquire.
    sent.clear()
    monkeypatch.setattr(d, "_ytdl_query_tag_std", lambda h: None)
    d.handle_ytdl({
        "id": "jobMeta", "attemptToken": "atk-meta",
        "url": "https://example.test/v", "name": "m.mp4", "dir": str(dest),
    })
    term = _wait_terminal(sent, "jobMeta")
    assert term["type"] == "ytdl-error"
    assert term["reason"] == "local_io"
    assert not any(p.name.startswith(".mc-ytdl-") for p in dest.iterdir() if p.is_dir())


def test_unc_dest_path_shape_parser():
    """Ordinary UNC share paths accepted by parser; device/global-root rejected."""
    import mchost.downloads as d

    assert d._ytdl_split_dest_path(r"\\server\share") is not None
    assert d._ytdl_split_dest_path(r"\\server\share\folder") is not None
    root, comps = d._ytdl_split_dest_path(r"\\server\share\a\b")
    assert root == r"\\server\share"
    assert comps == ["a", "b"]
    root2, comps2 = d._ytdl_split_dest_path(r"C:\Users\x\Downloads")
    assert root2.endswith("\\") or root2[1:3] == ":\\"
    assert comps2[0].lower() == "users"
    # Rejects
    assert d._ytdl_split_dest_path(r"\\.\C:\foo") is None
    assert d._ytdl_split_dest_path(r"\\?\C:\foo") is None
    assert d._ytdl_split_dest_path(r"C:foo") is None
    assert d._ytdl_split_dest_path(r"relative\path") is None
    assert d._ytdl_split_dest_path(r"C:\foo\..\bar") is None
    assert d._ytdl_split_dest_path(r"C:\foo\.") is None
    assert d._ytdl_split_dest_path(r"C:\foo\bad:ads") is None
    assert d._ytdl_is_allowed_dest_path(r"\\server\share\x") is True
    assert d._ytdl_is_allowed_dest_path(r"C:\Windows") is True
    assert d._ytdl_is_allowed_dest_path(r"\\?\UNC\server\share") is False


# ---------------------------------------------------------------------------
# 40. Cleanup bounds, disposition results, reparse child
# ---------------------------------------------------------------------------

def test_cleanup_enumeration_bounds_and_malformed_frames(tmp_path, monkeypatch):
    """Malformed NtQueryDirectoryFile frames return False without opening names."""
    import ctypes
    import mchost.downloads as d

    dest = tmp_path / "enum"
    dest.mkdir()
    lease = d._ytdl_acquire_dest_lease(str(dest))
    assert lease is not None
    stage_h, _, stage_disp = d._ytdl_create_stage_dir(lease)
    assert stage_h
    # Drop a real file so a careless parser would try to open something.
    with open(os.path.join(stage_disp, "keep.mp4"), "wb") as f:
        f.write(b"K")
    # Close the probe stage; run_frame creates its own.
    d._ytdl_cleanup_stage_tree(stage_h)

    api = d._ytdl_winapi()
    opens = []
    real_ntc = d._ytdl_nt_create_relative

    def no_open(*a, **k):
        opens.append(a[1] if len(a) > 1 else None)
        raise AssertionError("must not open unvalidated name: %r" % (opens[-1],))

    def run_frame(builder, expect_false=True):
        opens.clear()
        state = {"n": 0}

        def fake_query(handle, evt, apc, apc_ctx, iosb, buf, length, info_class, single, name, restart):
            state["n"] += 1
            if state["n"] > 1:
                iosb.contents.Status = d._YTDL_STATUS_NO_MORE_FILES
                iosb.contents.Information = 0
                return d._YTDL_STATUS_NO_MORE_FILES
            raw, info = builder(int(length))
            ctypes.memmove(buf, raw, min(len(raw), int(length)))
            iosb.contents.Status = 0
            iosb.contents.Information = info
            return 0

        # Fresh stage with real relative create, then ban opens for cleanup parse.
        monkeypatch.setattr(d, "_ytdl_nt_create_relative", real_ntc)
        sh, _, sd = d._ytdl_create_stage_dir(lease)
        assert sh and sd
        with open(os.path.join(sd, "keep.mp4"), "wb") as f:
            f.write(b"K")
        monkeypatch.setattr(api.ntdll, "NtQueryDirectoryFile", fake_query)
        monkeypatch.setattr(d, "_ytdl_nt_create_relative", no_open)
        ok = d._ytdl_cleanup_stage_tree(sh)
        if expect_false:
            assert ok is False
        assert opens == []
        return ok

    header = 64  # FileDirectoryInformation

    def trunc_info(buf_len):
        # Declare Information shorter than fixed header.
        return b"\x00" * buf_len, 12

    def odd_name(buf_len):
        raw = bytearray(buf_len)
        # NextEntryOffset=0, FileNameLength=3 (odd) at offset 60
        raw[60:64] = (3).to_bytes(4, "little")
        return bytes(raw), header + 4

    def oversized_name(buf_len):
        raw = bytearray(buf_len)
        raw[60:64] = (10**6).to_bytes(4, "little")
        return bytes(raw), header + 8

    def zero_next_progress(buf_len):
        # Two logical entries but NextEntryOffset points nowhere useful:
        # first entry NextEntryOffset=0 while Information claims more bytes with a second name.
        raw = bytearray(buf_len)
        name = "evil.mp4".encode("utf-16-le")
        raw[60:64] = len(name).to_bytes(4, "little")
        raw[64:64 + len(name)] = name
        # stale tail with another name that must not be parsed
        raw[64 + len(name):64 + len(name) + len(name)] = name
        return bytes(raw), header + len(name) + len(name)

    def unaligned_next(buf_len):
        raw = bytearray(buf_len)
        name = "a.mp4".encode("utf-16-le")
        raw[0:4] = (3).to_bytes(4, "little")  # unaligned / non-progress
        raw[60:64] = len(name).to_bytes(4, "little")
        raw[64:64 + len(name)] = name
        return bytes(raw), header + len(name) + 16

    def out_of_range_next(buf_len):
        raw = bytearray(buf_len)
        name = "b.mp4".encode("utf-16-le")
        raw[0:4] = (buf_len + 50).to_bytes(4, "little")
        raw[60:64] = len(name).to_bytes(4, "little")
        raw[64:64 + len(name)] = name
        return bytes(raw), header + len(name)

    run_frame(trunc_info)
    run_frame(odd_name)
    run_frame(oversized_name)
    run_frame(zero_next_progress)
    run_frame(unaligned_next)
    run_frame(out_of_range_next)

    # Endless pages / entry overflow.
    endless = {"n": 0}

    def endless_query(handle, evt, apc, apc_ctx, iosb, buf, length, info_class, single, name, restart):
        # Infinite success pages with never-ending truncated frames: must bound out
        # without opening any name.
        endless["n"] += 1
        iosb.contents.Status = 0
        iosb.contents.Information = 12  # shorter than fixed header
        return 0

    monkeypatch.setattr(d, "_ytdl_nt_create_relative", real_ntc)
    sh, _, sd = d._ytdl_create_stage_dir(lease)
    assert sh
    monkeypatch.setattr(api.ntdll, "NtQueryDirectoryFile", endless_query)
    monkeypatch.setattr(d, "_ytdl_nt_create_relative", no_open)
    opens.clear()
    ok = d._ytdl_cleanup_stage_tree(sh)
    assert ok is False
    assert opens == []
    monkeypatch.setattr(d, "_ytdl_nt_create_relative", real_ntc)
    d._ytdl_release_dest_lease(lease)


def test_cleanup_injected_child_failures_safe_leak(tmp_path, monkeypatch):
    """Child open/metadata/recursion/disposition/empty-recheck/stage disposition failures => False."""
    import mchost.downloads as d

    dest = tmp_path / "cfail"
    dest.mkdir()
    lease = d._ytdl_acquire_dest_lease(str(dest))
    assert lease is not None
    path_mut = []
    real_rel = d._ytdl_nt_create_relative
    real_query = d._ytdl_query_tag_std
    real_disp = d._ytdl_set_disposition_delete
    monkeypatch.setattr(d.os, "unlink", lambda *a, **k: path_mut.append(a))
    monkeypatch.setattr(d.os, "remove", lambda *a, **k: path_mut.append(a))
    monkeypatch.setattr(d.shutil, "rmtree", lambda *a, **k: path_mut.append(a))

    def make_stage_with_file():
        monkeypatch.setattr(d, "_ytdl_nt_create_relative", real_rel)
        monkeypatch.setattr(d, "_ytdl_query_tag_std", real_query)
        monkeypatch.setattr(d, "_ytdl_set_disposition_delete", real_disp)
        sh, _, sd = d._ytdl_create_stage_dir(lease)
        assert sh and sd, "stage create failed"
        with open(os.path.join(sd, "x.mp4"), "wb") as f:
            f.write(b"X")
        return sh

    def restore_core():
        monkeypatch.setattr(d, "_ytdl_nt_create_relative", real_rel)
        monkeypatch.setattr(d, "_ytdl_query_tag_std", real_query)
        monkeypatch.setattr(d, "_ytdl_set_disposition_delete", real_disp)

    # Child relative open failure.
    restore_core()
    sh = make_stage_with_file()
    monkeypatch.setattr(d, "_ytdl_nt_create_relative", lambda *a, **k: None)
    assert d._ytdl_cleanup_stage_tree(sh) is False
    assert path_mut == []

    # Metadata failure.
    restore_core()
    sh = make_stage_with_file()
    monkeypatch.setattr(d, "_ytdl_query_tag_std", lambda h: None)
    assert d._ytdl_cleanup_stage_tree(sh) is False
    assert path_mut == []

    # Disposition failure on child.
    restore_core()
    path_mut.clear()
    sh = make_stage_with_file()
    monkeypatch.setattr(d, "_ytdl_set_disposition_delete", lambda h: False)
    assert d._ytdl_cleanup_stage_tree(sh) is False
    assert path_mut == []

    # Stage disposition failure after empty.
    restore_core()
    sh, _, _sd = d._ytdl_create_stage_dir(lease)
    monkeypatch.setattr(d, "_ytdl_set_disposition_delete", lambda h: False)
    assert d._ytdl_cleanup_stage_tree(sh) is False
    assert path_mut == []
    restore_core()
    d._ytdl_release_dest_lease(lease)


def test_cleanup_real_nested_and_reparse_link_only(tmp_path, monkeypatch):
    """Real nested ordinary cleanup succeeds; reparse child disposes link only."""
    import mchost.downloads as d

    dest = tmp_path / "realclean"
    dest.mkdir()
    lease = d._ytdl_acquire_dest_lease(str(dest))
    assert lease is not None
    stage_h, _, stage_disp = d._ytdl_create_stage_dir(lease)
    assert stage_h and stage_disp
    nested = os.path.join(stage_disp, "sub")
    os.makedirs(nested, exist_ok=True)
    with open(os.path.join(nested, "a.mp4"), "wb") as f:
        f.write(b"A")
    with open(os.path.join(stage_disp, "b.mp4"), "wb") as f:
        f.write(b"B")
    assert d._ytdl_cleanup_stage_tree(stage_h) is True
    assert not os.path.isdir(stage_disp)

    # Reparse child: dispose link object only, preserve outside target.
    outside = tmp_path / "reparse-target"
    outside.mkdir()
    target_file = outside / "keep.txt"
    target_file.write_bytes(b"KEEP")
    stage_h, _, stage_disp = d._ytdl_create_stage_dir(lease)
    link = os.path.join(stage_disp, "escape")
    made = False
    try:
        os.symlink(str(outside), link, target_is_directory=True)
        made = True
    except (OSError, NotImplementedError, AttributeError):
        try:
            import subprocess
            subprocess.check_call(
                ["cmd", "/c", "mklink", "/J", link, str(outside)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            made = True
        except Exception:
            made = False
    if made:
        assert d._ytdl_cleanup_stage_tree(stage_h) is True
        assert target_file.read_bytes() == b"KEEP"
        assert outside.is_dir()
    else:
        d._ytdl_cleanup_stage_tree(stage_h)
    d._ytdl_release_dest_lease(lease)


# ---------------------------------------------------------------------------
# 41. DOS device reserved leaves
# ---------------------------------------------------------------------------

def test_dos_device_reserved_leaves_rejected():
    """CON/PRN/AUX/NUL/COM1-9/LPT1-9 rejected bare, mixed-case, and extension forms."""
    import mchost.downloads as d

    banned = []
    for base in (
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ):
        banned.extend([
            base, base.lower(), base[:1] + base[1:].lower(),
            base + ".mp4", base.lower() + ".txt", base + ".MP4",
        ])
    for name in banned:
        assert d._ytdl_is_safe_relative_leaf(name) is False, name

    for ok in ("CONSOLE.mp4", "COM10.mp4", "LPT10.mp4", "PRNTR.mp4", "NULL.mp4", "clip.mp4", "file name.mp4"):
        assert d._ytdl_is_safe_relative_leaf(ok) is True, ok

    # Same validator gates destination components and markers.
    assert d._ytdl_split_dest_path(r"C:\Videos\CON") is None
    assert d._ytdl_split_dest_path(r"C:\Videos\COM1.mp4") is None
    assert d._ytdl_split_dest_path(r"C:\Videos\CONSOLE") is not None


def test_reserved_name_job_fails_closed(tmp_path, monkeypatch):
    """Structured job with reserved final name fails without creating device path."""
    import mchost.downloads as d

    dest = tmp_path / "resv"
    dest.mkdir()
    sent = []
    spawned = []

    def fake_popen(*a, **k):
        spawned.append(1)
        path = _materialize_stage_from_cmd(a, b"X")
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)
    d.handle_ytdl({
        "id": "jobResv", "attemptToken": "atk-resv",
        "url": "https://example.test/v", "name": "CON.mp4", "dir": str(dest),
    })
    term = _wait_terminal(sent, "jobResv")
    assert term["type"] == "ytdl-error"
    assert not (dest / "CON.mp4").exists()


# ---------------------------------------------------------------------------
# 42. Commit API: prebuild + immediate claim contract unit
# ---------------------------------------------------------------------------

def test_commit_prebuild_and_immediate_claim_contract(tmp_path, monkeypatch):
    """Candidates prebuilt before lock; claim is adjacent to NT success under lock."""
    import mchost.downloads as d

    dest = tmp_path / "pre"
    dest.mkdir()
    lease = d._ytdl_acquire_dest_lease(str(dest))
    assert lease is not None
    stage_h, _, stage_disp = d._ytdl_create_stage_dir(lease)
    assert stage_h and stage_disp
    src = os.path.join(stage_disp, "a.mp4")
    with open(src, "wb") as f:
        f.write(b"Z")
    owned = d._ytdl_open_stage_source(stage_h, stage_disp, src)
    assert owned is not None

    cands = d._ytdl_prebuild_commit_candidates(lease, "a.mp4", max_attempts=32)
    assert cands
    assert cands[0]["leaf"] == "a.mp4"
    assert os.path.normcase(cands[0]["display"]) == os.path.normcase(str(dest / "a.mp4"))
    assert cands[0]["buf"] is not None
    assert cands[0]["size"] > 0

    op = {"commit_claimed": False, "ytdl_lock": __import__("threading").Lock()}
    api = d._ytdl_winapi()
    real_nt = api.ntdll.NtSetInformationFile
    order = []
    join_calls = {"n": 0}
    real_join = os.path.join

    def nt_hook(handle, iosb, buf, length, klass):
        order.append("nt")
        st = real_nt(handle, iosb, buf, length, klass)
        if (st & 0xFFFFFFFF) == 0:
            order.append("nt-ok")
        return st

    def join_hook(*a, **k):
        join_calls["n"] += 1
        raise RuntimeError("join banned during commit")

    monkeypatch.setattr(api.ntdll, "NtSetInformationFile", nt_hook)

    with op["ytdl_lock"]:
        monkeypatch.setattr(d.os.path, "join", join_hook)
        path = d._ytdl_commit_with_candidates(
            owned["handle"], cands, op=op,
        )
        monkeypatch.setattr(d.os.path, "join", real_join)
        order.append("claimed" if op["commit_claimed"] else "not-claimed")
        assert op["commit_claimed"] is True
        assert os.path.normcase(path) == os.path.normcase(str(dest / "a.mp4"))

    assert order == ["nt", "nt-ok", "claimed"]
    assert join_calls["n"] == 0
    d._ytdl_dispose_handle(owned["handle"], delete=False)
    assert open(path, "rb").read() == b"Z"
    d._ytdl_cleanup_stage_tree(stage_h)
    d._ytdl_release_dest_lease(lease)


# ---------------------------------------------------------------------------
# 43. Post-claim return-transfer fault still emits exactly one done
# ---------------------------------------------------------------------------

def test_post_claim_return_transfer_fault_emits_done(tmp_path, monkeypatch):
    """Real NT claim then wrapper raise before helper return: one done, final survives."""
    import mchost.downloads as d

    dest = tmp_path / "xfer"
    dest.mkdir()
    sent = []
    payload = b"XFER-CLAIM-BYTES"
    final = dest / "xfer.mp4"
    real_commit = d._ytdl_commit_with_candidates

    def boom_after_real_commit(source_handle, candidates, op=None, **kwargs):
        # Perform the real rename + commit_claimed mutation, then fault on the
        # helper return-transfer path so done_path never materializes in the worker.
        path = real_commit(source_handle, candidates, op=op, **kwargs)
        if path:
            raise RuntimeError("return-transfer fault after claim")
        return path

    monkeypatch.setattr(d, "_ytdl_commit_with_candidates", boom_after_real_commit)

    def fake_popen(*a, **k):
        path = _materialize_stage_from_cmd(a, payload)
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)
    d.handle_ytdl({
        "id": "jobXfer", "attemptToken": "atk-xfer",
        "url": "https://example.test/v", "name": "xfer.mp4", "dir": str(dest),
    })
    # Wait for worker teardown (not terminal): claim may leave a final with no frame.
    assert wait_for(lambda: d._PGET.get("jobXfer") is None, timeout=5), (
        "jobXfer still registered after post-claim transfer fault"
    )
    assert final.is_file(), "committed final must survive post-claim transfer fault"
    assert final.read_bytes() == payload
    terminals = [
        m for m in sent
        if m.get("type") in ("ytdl-done", "ytdl-error") and m.get("id") == "jobXfer"
    ]
    # Production defect: commit_claimed without done_path yields no terminal.
    assert len(terminals) == 1, "expected exactly one terminal, got %r" % (terminals,)
    term = terminals[0]
    assert term["type"] == "ytdl-done"
    assert term["file"] == str(final)
    assert term["bytes"] == len(payload)
    key = d._ytdl_canon_path_key(str(dest))
    assert d._YTDL_DEST_LEASES.get(key) is None


# ---------------------------------------------------------------------------
# 44. Raw destination grammar: reject .. before abspath erases it
# ---------------------------------------------------------------------------

def test_raw_dest_traversal_rejected_explicit_and_default(tmp_path, monkeypatch):
    """Raw `.`/`..` destination components rejected before abspath; no outside create."""
    import mchost.downloads as d

    root = tmp_path / "root"
    root.mkdir()
    outside = tmp_path / "escaped"
    assert not outside.exists()
    # Primitive path contains `..`; abspath would erase it to tmp_path/escaped.
    raw_escape = str(root) + r"\..\escaped"
    assert ".." in raw_escape.replace("/", "\\")
    assert os.path.normcase(os.path.abspath(raw_escape)) == os.path.normcase(str(outside))

    # Explicit dir traversal.
    sent = []
    spawned = []

    def fake_popen(*a, **k):
        spawned.append(1)
        path = _materialize_stage_from_cmd(a, b"X")
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)
    d.handle_ytdl({
        "id": "jobTrav", "attemptToken": "atk-trav",
        "url": "https://example.test/v", "name": "clip.mp4", "dir": raw_escape,
    })
    term = _wait_terminal(sent, "jobTrav")
    assert term["type"] == "ytdl-error"
    assert term["reason"] in ("local_io", "permanent")
    assert spawned == []
    assert not outside.exists()
    assert not (root / "escaped").exists()
    stages = [p for p in root.iterdir() if p.name.startswith(".mc-ytdl-")]
    assert stages == []
    assert d._PGET.get("jobTrav") is None

    # Configured default dir traversal (no explicit dir).
    sent2 = []
    spawned2 = []

    def fake_popen2(*a, **k):
        spawned2.append(1)
        path = _materialize_stage_from_cmd(a, b"Y")
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    _patch_ytdl_base(monkeypatch, d, mc, sent2, popen=fake_popen2)
    monkeypatch.setattr(d, "_ytdl_default_outdir", lambda: raw_escape)
    d.handle_ytdl({
        "id": "jobTravDef", "attemptToken": "atk-trav-def",
        "url": "https://example.test/v", "name": "clip.mp4",
    })
    term2 = _wait_terminal(sent2, "jobTravDef")
    assert term2["type"] == "ytdl-error"
    assert term2["reason"] in ("local_io", "permanent")
    assert spawned2 == []
    assert not outside.exists()
    assert d._PGET.get("jobTravDef") is None

    # Raw single-dot component: abspath would erase `.` but grammar must reject first.
    raw_dot = str(root) + r"\.\inside"
    assert "\\." in raw_dot.replace("/", "\\") or "/." in raw_dot
    assert os.path.normcase(os.path.abspath(raw_dot)) == os.path.normcase(
        str(root / "inside")
    )
    sent3 = []
    spawned3 = []

    def fake_popen3(*a, **k):
        spawned3.append(1)
        path = _materialize_stage_from_cmd(a, b"Z")
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    _patch_ytdl_base(monkeypatch, d, mc, sent3, popen=fake_popen3)
    d.handle_ytdl({
        "id": "jobTravDot", "attemptToken": "atk-trav-dot",
        "url": "https://example.test/v", "name": "clip.mp4", "dir": raw_dot,
    })
    term3 = _wait_terminal(sent3, "jobTravDot")
    assert term3["type"] == "ytdl-error"
    assert term3["reason"] in ("local_io", "permanent")
    assert spawned3 == []
    assert not (root / "inside").exists()
    stages_dot = [p for p in root.iterdir() if p.name.startswith(".mc-ytdl-")]
    assert stages_dot == []
    assert not (root / "clip.mp4").exists()
    assert d._PGET.get("jobTravDot") is None


# ---------------------------------------------------------------------------
# 45. Root/component acquisition never retries without OPEN_REPARSE_POINT
# ---------------------------------------------------------------------------

def test_root_and_component_open_always_reparse_aware(tmp_path, monkeypatch):
    """Root CreateFileW and component NtCreateFile always use reparse-aware flags."""
    import mchost.downloads as d

    dest = tmp_path / "reparse-acq"
    dest.mkdir()
    api = d._ytdl_winapi()
    real_cf = api.k32.CreateFileW
    real_nt = d._ytdl_nt_create_relative
    real_status = d._ytdl_nt_create_relative_status
    real_open_root = d._ytdl_open_path_root
    root_calls = []
    child_opts = []

    def open_root_spy(root_display):
        """Record CreateFileW flags; always restore the real ctypes binding."""
        calls = []

        def cf_spy(path, access, share, sec, disp, flags, template):
            calls.append(int(flags))
            return real_cf(path, access, share, sec, disp, flags, template)

        prev = api.k32.CreateFileW
        api.k32.CreateFileW = cf_spy
        try:
            return real_open_root(root_display)
        finally:
            api.k32.CreateFileW = prev
            root_calls.extend(calls)

    def nt_spy(root_handle, leaf, desired_access, share_access, create_disposition,
               create_options, file_attributes=0):
        child_opts.append(int(create_options))
        return real_nt(
            root_handle, leaf, desired_access, share_access, create_disposition,
            create_options, file_attributes=file_attributes,
        )

    lease = None
    lease2 = None
    try:
        monkeypatch.setattr(d, "_ytdl_open_path_root", open_root_spy)
        monkeypatch.setattr(d, "_ytdl_nt_create_relative", nt_spy)
        lease = d._ytdl_acquire_dest_lease(str(dest / "nested"))
        assert lease is not None
        assert root_calls, "expected root CreateFileW"
        reparse_flag = d._YTDL_FILE_FLAG_OPEN_REPARSE_POINT
        for fl in root_calls:
            assert fl & reparse_flag, "root open missing OPEN_REPARSE_POINT: %r" % fl
        assert child_opts, "expected component NtCreateFile"
        for opt in child_opts:
            assert opt & d._YTDL_FILE_OPEN_REPARSE_POINT, (
                "component open missing OPEN_REPARSE_POINT: %r" % opt
            )
        d._ytdl_release_dest_lease(lease)
        lease = None
        monkeypatch.setattr(d, "_ytdl_open_path_root", real_open_root)
        monkeypatch.setattr(d, "_ytdl_nt_create_relative", real_nt)

        # When reparse-aware open fails, never retry plain open or accept a handle.
        insecure = []
        accepted = []

        def nt_fail_reparse(root_handle, leaf, desired_access, share_access,
                            create_disposition, create_options, file_attributes=0):
            opt = int(create_options)
            if opt & d._YTDL_FILE_OPEN_REPARSE_POINT:
                return None
            insecure.append(opt)
            accepted.append(4242)
            return 4242

        def status_fail_reparse(root_handle, leaf, desired_access, share_access,
                                create_disposition, create_options, file_attributes=0):
            opt = int(create_options)
            if opt & d._YTDL_FILE_OPEN_REPARSE_POINT:
                return None, 0xC0000034
            insecure.append(opt)
            accepted.append(4242)
            return 4242, 0

        lease2 = d._ytdl_acquire_dest_lease(str(dest))
        assert lease2 is not None
        parent_h = lease2["handle"]
        monkeypatch.setattr(d, "_ytdl_nt_create_relative", nt_fail_reparse)
        monkeypatch.setattr(d, "_ytdl_nt_create_relative_status", status_fail_reparse)
        try:
            h = d._ytdl_open_or_create_component(parent_h, "nope-child")
            assert h is None
            assert insecure == []
            assert accepted == []
        finally:
            monkeypatch.setattr(d, "_ytdl_nt_create_relative", real_nt)
            monkeypatch.setattr(d, "_ytdl_nt_create_relative_status", real_status)
            d._ytdl_release_dest_lease(lease2)
            lease2 = None

        # Root: reparse-aware failure must not fall back to plain CreateFileW.
        root_plain = []

        def open_root_fail_reparse(root_display):
            def cf_fail_reparse(path, access, share, sec, disp, flags, template):
                fl = int(flags)
                if fl & d._YTDL_FILE_FLAG_OPEN_REPARSE_POINT:
                    return d._YTDL_INVALID_HANDLE_VALUE
                root_plain.append(fl)
                return real_cf(path, access, share, sec, disp, flags, template)

            prev = api.k32.CreateFileW
            api.k32.CreateFileW = cf_fail_reparse
            try:
                return real_open_root(root_display)
            finally:
                api.k32.CreateFileW = prev

        monkeypatch.setattr(d, "_ytdl_open_path_root", open_root_fail_reparse)
        rh = None
        try:
            split = d._ytdl_split_dest_path(str(dest))
            assert split is not None
            rh = d._ytdl_open_path_root(split[0])
            assert rh is None
            assert root_plain == []
        finally:
            monkeypatch.setattr(d, "_ytdl_open_path_root", real_open_root)
            # Partial impl may return a real handle from plain fallback; close once.
            if rh is not None and rh != d._YTDL_INVALID_HANDLE_VALUE:
                try:
                    d._ytdl_close_handle(rh)
                except Exception:
                    pass
                rh = None
    finally:
        # Always restore shared bindings and release any held lease.
        api.k32.CreateFileW = real_cf
        monkeypatch.setattr(d, "_ytdl_open_path_root", real_open_root)
        monkeypatch.setattr(d, "_ytdl_nt_create_relative", real_nt)
        monkeypatch.setattr(d, "_ytdl_nt_create_relative_status", real_status)
        if lease is not None:
            d._ytdl_release_dest_lease(lease)
        if lease2 is not None:
            d._ytdl_release_dest_lease(lease2)
        # Prove the next real lease still opens after spies/restores.
        probe = d._ytdl_acquire_dest_lease(str(dest / "after-probe"))
        assert probe is not None, "CreateFileW/open_root left unusable after reparse test"
        d._ytdl_release_dest_lease(probe)


# ---------------------------------------------------------------------------
# 46. UNC server/share must pass safe-component validation
# ---------------------------------------------------------------------------

def test_unc_server_share_component_validation(monkeypatch):
    """UNC server and share validated as exact Windows components; invalid = no handles."""
    import mchost.downloads as d

    accept = [
        r"\\server\share",
        r"\\server\share\folder",
        r"\\server.domain\share.name\a",
        r"\\服务器\共享\folder",
        r"\\srv-1\share_2",
    ]
    reject = [
        r"\\server\share.\folder",
        r"\\server\CON\folder",
        r"\\server \share\folder",
        r"\\server\share \folder",
        r"\\.\share\folder",
        r"\\..\share\folder",
        r"\\server\..\folder",
        r"\\server\.\folder",
        r"\\server\PRN\x",
        r"\\server\COM1\x",
        r"\\server\NUL",
        r"\\server\share:ads\x",
        r"\\server:ads\share\x",
        r"\\server\share.",
        r"\\server \share",
        r"\\ \share\x",
        r"\\server\\folder",
        r"\\server\share\..\x",
        # Malformed UNC server: reserved name, trailing-dot, trailing-space.
        r"\\CON\share\x",
        r"\\server.\share\x",
        r"\\server \share\x",
    ]
    for p in accept:
        assert d._ytdl_split_dest_path(p) is not None, "expected accept: %r" % p
        assert d._ytdl_is_allowed_dest_path(p) is True, p
    for p in reject:
        assert d._ytdl_split_dest_path(p) is None, "expected reject: %r" % p
        assert d._ytdl_is_allowed_dest_path(p) is False, p

    # Invalid UNC roots must not call CreateFileW / NtCreateFile.
    calls = []
    real_open_root = d._ytdl_open_path_root
    real_nt = d._ytdl_nt_create_relative

    def open_root_ban(root_display):
        calls.append(("root", root_display))
        raise AssertionError("root open must not run for invalid UNC")

    def nt_ban(*a, **k):
        calls.append(("nt", a[1] if len(a) > 1 else None))
        raise AssertionError("NtCreateFile must not run for invalid UNC")

    monkeypatch.setattr(d, "_ytdl_open_path_root", open_root_ban)
    monkeypatch.setattr(d, "_ytdl_nt_create_relative", nt_ban)
    try:
        for p in (
            r"\\server\share.\folder",
            r"\\server\CON\folder",
            r"\\server \share\folder",
            r"\\CON\share\x",
            r"\\server.\share\x",
            r"\\server \share\x",
        ):
            assert d._ytdl_acquire_dest_lease(p) is None
        assert calls == []
    finally:
        monkeypatch.setattr(d, "_ytdl_open_path_root", real_open_root)
        monkeypatch.setattr(d, "_ytdl_nt_create_relative", real_nt)


# ---------------------------------------------------------------------------
# 47. Nonterminated FileDirectoryInformation frames fail closed
# ---------------------------------------------------------------------------

def test_dir_info_nonterminated_frame_fail_closed(tmp_path, monkeypatch):
    """NextEntryOffset landing at Information end without zero terminator is rejected."""
    import ctypes
    import shutil
    import mchost.downloads as d

    dest = tmp_path / "nonterm"
    dest.mkdir()
    api = d._ytdl_winapi()
    real_ntc = d._ytdl_nt_create_relative
    real_query = api.ntdll.NtQueryDirectoryFile
    # header(64) + UTF-16 `.`(2) → pad to 8-aligned Information end at 72.
    info_len = 72
    assert info_len % 8 == 0
    assert info_len >= d._YTDL_DIR_INFO_HEADER + 2

    def build_dot_nonterm(buf_len, declared_info):
        """Single `.` record: NextEntryOffset == Information, no zero-term final."""
        raw = bytearray(buf_len)
        name = ".".encode("utf-16-le")
        assert len(name) == 2
        raw[0:4] = int(declared_info).to_bytes(4, "little")
        raw[60:64] = len(name).to_bytes(4, "little")
        raw[64:64 + len(name)] = name
        return bytes(raw), declared_info

    def _iosb_obj(iosb):
        # Python-replaced ctypes funcs receive byref as CArgObject with _obj.
        if hasattr(iosb, "contents"):
            return iosb.contents
        return iosb._obj

    lease = None
    sh = None
    sh2 = None
    sd2 = None
    try:
        lease = d._ytdl_acquire_dest_lease(str(dest))
        assert lease is not None

        sh, _, sd = d._ytdl_create_stage_dir(lease)
        assert sh and sd
        with open(os.path.join(sd, "keep.mp4"), "wb") as f:
            f.write(b"K")

        def fake_query_empty(handle, evt, apc, apc_ctx, iosb, buf, length,
                             info_class, single, name, restart):
            raw, info = build_dot_nonterm(int(length), info_len)
            ctypes.memmove(buf, raw, min(len(raw), int(length)))
            obj = _iosb_obj(iosb)
            obj.Status = 0
            obj.Information = info
            return 0

        monkeypatch.setattr(api.ntdll, "NtQueryDirectoryFile", fake_query_empty)
        empty = d._ytdl_dir_is_empty(sh, api)
        # Current production accepts the nonterminated `.` frame as empty=True.
        assert empty is not True, "nonterminated FileDirectoryInformation must fail closed"
        d._ytdl_close_handle(sh)
        sh = None

        # Cleanup path: one nonterm page then NO_MORE_FILES so acceptance would
        # wrongly succeed rather than only trip the query-budget limit.
        opens = []

        def no_open(*a, **k):
            opens.append(a[1] if len(a) > 1 else None)
            raise AssertionError("must not open on nonterminated frame: %r" % (opens[-1],))

        monkeypatch.setattr(d, "_ytdl_nt_create_relative", real_ntc)
        sh2, _, sd2 = d._ytdl_create_stage_dir(lease)
        assert sh2 and sd2
        with open(os.path.join(sd2, "keep.mp4"), "wb") as f:
            f.write(b"K")

        qstate = {"n": 0}

        def fake_query_cleanup(handle, evt, apc, apc_ctx, iosb, buf, length,
                               info_class, single, name, restart):
            qstate["n"] += 1
            obj = _iosb_obj(iosb)
            if qstate["n"] > 1:
                obj.Status = d._YTDL_STATUS_NO_MORE_FILES
                obj.Information = 0
                return d._YTDL_STATUS_NO_MORE_FILES
            raw, info = build_dot_nonterm(int(length), info_len)
            ctypes.memmove(buf, raw, min(len(raw), int(length)))
            obj.Status = 0
            obj.Information = info
            return 0

        monkeypatch.setattr(api.ntdll, "NtQueryDirectoryFile", fake_query_cleanup)
        monkeypatch.setattr(d, "_ytdl_nt_create_relative", no_open)
        ok = d._ytdl_cleanup_stage_tree(sh2)
        sh2 = None  # cleanup always consumes the stage handle
        assert ok is False
        # Parser must reject on the first malformed page; later queries mean
        # acceptance of the nonterminated frame (or budget/disposition paths).
        assert qstate["n"] == 1, (
            "cleanup must stop after one malformed query, got n=%r" % qstate["n"]
        )
        assert opens == []
        assert os.path.isfile(os.path.join(sd2, "keep.mp4"))
    finally:
        monkeypatch.setattr(api.ntdll, "NtQueryDirectoryFile", real_query)
        monkeypatch.setattr(d, "_ytdl_nt_create_relative", real_ntc)
        if sh is not None:
            try:
                d._ytdl_close_handle(sh)
            except Exception:
                pass
        if sh2 is not None:
            try:
                d._ytdl_close_handle(sh2)
            except Exception:
                pass
        if sd2 and os.path.isdir(sd2):
            shutil.rmtree(sd2, ignore_errors=True)
        if lease is not None:
            d._ytdl_release_dest_lease(lease)


# ---------------------------------------------------------------------------
# 48. CloseHandle BOOL + exact-once; no double close on exception
# ---------------------------------------------------------------------------

def test_close_handle_bool_once_no_double_close(tmp_path, monkeypatch):
    """CloseHandle FALSE/exception: cleanup false, one attempt; committed still done."""
    import mchost.downloads as d

    dest = tmp_path / "closeonce"
    dest.mkdir()
    real_close = d._ytdl_close_handle
    real_api = d._ytdl_winapi()
    assert real_api is not None

    # Unit: CloseHandle BOOL FALSE => helper reports False.
    # Patch the Python winapi accessor only — never replace the shared k32 binding.
    bool_calls = []

    class _K32CloseFalse(object):
        def CloseHandle(self, handle):
            bool_calls.append(int(handle) if handle else None)
            return 0  # BOOL FALSE

        def __getattr__(self, name):
            return getattr(real_api.k32, name)

    class _ApiCloseFalse(object):
        def __init__(self):
            self.k32 = _K32CloseFalse()
            self.ntdll = real_api.ntdll

    monkeypatch.setattr(d, "_ytdl_winapi", lambda: _ApiCloseFalse())
    try:
        assert d._ytdl_close_handle(4242) is False
        assert bool_calls == [4242]
    finally:
        monkeypatch.setattr(d, "_ytdl_winapi", lambda: real_api)

    # Prove real handle open/close still works after the BOOL unit section.
    probe = d._ytdl_acquire_dest_lease(str(dest))
    assert probe is not None, "winapi left unusable after CloseHandle BOOL unit"
    d._ytdl_release_dest_lease(probe)

    # Stage cleanup: close helper reports False => cleanup must not claim success.
    # Still perform the real OS close so the suite does not leak handles.
    lease = None
    sd = None
    try:
        lease = d._ytdl_acquire_dest_lease(str(dest))
        assert lease is not None
        sh, _, sd = d._ytdl_create_stage_dir(lease)
        assert sh and sd
        with open(os.path.join(sd, "x.mp4"), "wb") as f:
            f.write(b"X")

        close_calls = []

        def close_report_false(handle):
            if handle:
                close_calls.append(int(handle))
                real_close(handle)
                return False
            return True

        monkeypatch.setattr(d, "_ytdl_close_handle", close_report_false)
        try:
            ok = d._ytdl_cleanup_stage_tree(sh)
            assert ok is False
            assert close_calls, "expected at least one close"
            assert len(close_calls) == len(set(close_calls)), close_calls
        finally:
            monkeypatch.setattr(d, "_ytdl_close_handle", real_close)
    finally:
        if sd and os.path.isdir(sd):
            try:
                import shutil
                shutil.rmtree(sd, ignore_errors=True)
            except Exception:
                pass
        if lease is not None:
            d._ytdl_release_dest_lease(lease)

    # dispose_handle: injected exception must not retry the same raw handle.
    dispose_calls = []

    def close_raise_once(handle):
        dispose_calls.append(int(handle) if handle is not None else None)
        raise RuntimeError("close inject")

    monkeypatch.setattr(d, "_ytdl_close_handle", close_raise_once)
    try:
        d._ytdl_dispose_handle(77, delete=False)
        assert dispose_calls == [77]
    finally:
        monkeypatch.setattr(d, "_ytdl_close_handle", real_close)

    # Committed final: close failure after claim still yields done, no second close.
    sent = []
    payload = b"CLOSE-FINAL"
    close_final_calls = []
    armed = {"v": False}
    real_commit = d._ytdl_commit_with_candidates

    def commit_arm(source_handle, candidates, op=None, **kwargs):
        path = real_commit(source_handle, candidates, op=op, **kwargs)
        if path:
            armed["v"] = True
        return path

    def close_post_claim(handle):
        if not handle:
            return True
        hv = int(handle)
        if armed["v"]:
            close_final_calls.append(hv)
            if close_final_calls.count(hv) > 1:
                raise AssertionError("double close on %r" % (hv,))
            # Best-effort fail: still release OS handle, report False once.
            real_close(handle)
            return False
        return real_close(handle)

    monkeypatch.setattr(d, "_ytdl_commit_with_candidates", commit_arm)
    monkeypatch.setattr(d, "_ytdl_close_handle", close_post_claim)

    def fake_popen(*a, **k):
        path = _materialize_stage_from_cmd(a, payload)
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)
    d.handle_ytdl({
        "id": "jobCloseFinal", "attemptToken": "atk-cf",
        "url": "https://example.test/v", "name": "final.mp4", "dir": str(dest),
    })
    term = _wait_terminal(sent, "jobCloseFinal")
    assert term["type"] == "ytdl-done"
    assert term["bytes"] == len(payload)
    assert open(term["file"], "rb").read() == payload
    assert not any(
        m.get("type") == "ytdl-error" and m.get("id") == "jobCloseFinal" for m in sent
    )
    terminals = [
        m for m in sent
        if m.get("type") in ("ytdl-done", "ytdl-error") and m.get("id") == "jobCloseFinal"
    ]
    assert len(terminals) == 1
    assert close_final_calls, "expected at least one post-claim final-handle close"
    assert len(close_final_calls) == len(set(close_final_calls)), close_final_calls
    assert d._PGET.get("jobCloseFinal") is None


# ---------------------------------------------------------------------------
# 49. Committed-pin adopt: retain original when duplication fails
# ---------------------------------------------------------------------------

def _run_commit_with_pin_failure(tmp_path, monkeypatch, case, jid):
    """Real commit path while forcing readonly-pin duplication to fail.

    case:
      - "none": duplicate returns None
      - "raise": duplicate raises
      - "zero": duplicate returns 0 (invalid)
      - "invalid": duplicate returns INVALID_HANDLE_VALUE
    """
    import mchost.downloads as d

    dest = tmp_path / ("pinfail-%s" % case)
    dest.mkdir()
    sent = []
    payload = b"PIN-FAIL-%s" % case.encode("ascii")
    race = {
        "checked": False,
        "replace_ok": None,
        "path_exists": None,
        "payload": None,
    }
    close_calls = []
    real_close = d._ytdl_close_handle
    real_dup = d._ytdl_duplicate_readonly_pin
    invalid = int(d._YTDL_INVALID_HANDLE_VALUE)

    def dup_fail(handle):
        if case == "none":
            return None
        if case == "raise":
            raise RuntimeError("dup pin inject")
        if case == "zero":
            return 0
        if case == "invalid":
            return invalid
        raise AssertionError("unknown case %r" % (case,))

    def track_close(handle):
        if handle:
            close_calls.append(int(handle))
        return real_close(handle)

    def capturing_send(msg):
        # Always record first so a probe fault cannot drop the terminal frame.
        sent.append(dict(msg))
        if msg.get("type") == "ytdl-done" and not race["checked"]:
            race["checked"] = True
            path = msg.get("file")
            try:
                os.replace(path, path + ".moved")
                race["replace_ok"] = True
            except OSError:
                race["replace_ok"] = False
            # Do not open the path while the owned handle may still hold it:
            # DELETE-capable pins can deny concurrent readers. Existence + later
            # post-terminal read prove the payload and release contract.
            try:
                race["path_exists"] = bool(path) and os.path.isfile(path)
            except OSError:
                race["path_exists"] = False

    monkeypatch.setattr(d, "_ytdl_duplicate_readonly_pin", dup_fail)
    monkeypatch.setattr(d, "_ytdl_close_handle", track_close)

    def fake_popen(*a, **k):
        path = _materialize_stage_from_cmd(a, payload)
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    monkeypatch.setattr(mc, "send", capturing_send)
    monkeypatch.setattr(d, "_h", lambda: mc)
    monkeypatch.setattr(d, "ensure_ytdlp", lambda: "yt-dlp-fake")
    monkeypatch.setattr(d, "ensure_deno", lambda: None)
    monkeypatch.setattr(d, "start_pot_provider", lambda: False)
    monkeypatch.setattr(d, "_no_window", lambda: (0, None))
    monkeypatch.setattr(mc, "FFMPEG", None)
    monkeypatch.setattr(d.subprocess, "Popen", fake_popen)

    d.handle_ytdl({
        "id": jid, "attemptToken": "atk-%s" % case,
        "url": "https://example.test/v", "name": "%s.mp4" % case, "dir": str(dest),
    })
    term = _wait_terminal(sent, jid)
    assert wait_for(lambda: d._PGET.get(jid) is None, timeout=5)

    # Restore real helpers for post-terminal rename probe and teardown.
    monkeypatch.setattr(d, "_ytdl_duplicate_readonly_pin", real_dup)
    monkeypatch.setattr(d, "_ytdl_close_handle", real_close)

    return {
        "d": d,
        "dest": dest,
        "sent": sent,
        "term": term,
        "race": race,
        "payload": payload,
        "close_calls": close_calls,
        "jid": jid,
    }


def _assert_pin_fail_e2e(r, jid):
    """Shared post-conditions for pin-duplication failure e2e cases."""
    term, race, payload, sent, close_calls = (
        r["term"], r["race"], r["payload"], r["sent"], r["close_calls"],
    )
    assert term["type"] == "ytdl-done"
    assert term["bytes"] == len(payload)
    assert race["checked"] is True
    assert race["replace_ok"] is False, "owned handle must deny replace during ytdl-done"
    assert race["path_exists"] is True
    # After worker terminal + final close, payload is readable and renameable.
    assert open(term["file"], "rb").read() == payload
    terminals = [
        m for m in sent
        if m.get("type") in ("ytdl-done", "ytdl-error") and m.get("id") == jid
    ]
    assert len(terminals) == 1
    assert not any(m.get("type") == "ytdl-error" and m.get("id") == jid for m in sent)
    assert r["d"]._PGET.get(jid) is None
    assert len(close_calls) == len(set(close_calls)), close_calls
    # Ownership released: ordinary same-volume rename must succeed after terminal.
    moved = term["file"] + ".after"
    os.replace(term["file"], moved)
    assert not os.path.exists(term["file"])
    assert open(moved, "rb").read() == payload


def test_pin_dup_none_retains_handle_through_done_then_releases(tmp_path, monkeypatch):
    """Duplicate returns None: original pins final through ytdl-done, then releases once."""
    r = _run_commit_with_pin_failure(tmp_path, monkeypatch, "none", "jobPinNone")
    _assert_pin_fail_e2e(r, "jobPinNone")


def test_pin_dup_raise_retains_handle_through_done_then_releases(tmp_path, monkeypatch):
    """Duplicate raises: original remains owned through terminal and closes once later."""
    r = _run_commit_with_pin_failure(tmp_path, monkeypatch, "raise", "jobPinRaise")
    _assert_pin_fail_e2e(r, "jobPinRaise")


def test_pin_dup_zero_retains_handle_through_done_then_releases(tmp_path, monkeypatch):
    """Invalid zero pin result is treated as no pin; original held through terminal."""
    r = _run_commit_with_pin_failure(tmp_path, monkeypatch, "zero", "jobPinZero")
    _assert_pin_fail_e2e(r, "jobPinZero")


def test_pin_dup_invalid_handle_retains_through_done_then_releases(tmp_path, monkeypatch):
    """INVALID_HANDLE_VALUE pin result is treated as no pin; original held through terminal."""
    r = _run_commit_with_pin_failure(tmp_path, monkeypatch, "invalid", "jobPinInv")
    _assert_pin_fail_e2e(r, "jobPinInv")


def test_ytdl_adopt_committed_pin_close_accounting_matrix(monkeypatch):
    """Unit matrix: adopt never closes original without a valid replacement pin."""
    import mchost.downloads as d

    original = 9001
    pin = 9002
    invalid = int(d._YTDL_INVALID_HANDLE_VALUE)
    closes = []

    # --- no duplicate => do not close inside adopt; return original ---
    closes[:] = []
    monkeypatch.setattr(d, "_ytdl_duplicate_readonly_pin", lambda h: None)

    def close_must_not(handle):
        closes.append(int(handle) if handle else None)
        raise AssertionError("must not close original when no pin")

    monkeypatch.setattr(d, "_ytdl_close_handle", close_must_not)
    assert d._ytdl_adopt_committed_pin(original) == original
    assert closes == []

    # zero / invalid pin results also mean "no pin"
    for bad in (0, invalid, None):
        closes[:] = []
        monkeypatch.setattr(d, "_ytdl_duplicate_readonly_pin", lambda h, b=bad: b)
        monkeypatch.setattr(d, "_ytdl_close_handle", close_must_not)
        got = d._ytdl_adopt_committed_pin(original)
        assert got == original, bad
        assert closes == []

    # duplicate raises => return original, no close
    closes[:] = []

    def dup_raise(handle):
        raise RuntimeError("dup boom")

    monkeypatch.setattr(d, "_ytdl_duplicate_readonly_pin", dup_raise)
    monkeypatch.setattr(d, "_ytdl_close_handle", close_must_not)
    assert d._ytdl_adopt_committed_pin(original) == original
    assert closes == []

    # --- duplicate succeeds + original close TRUE => return duplicate ---
    closes[:] = []
    monkeypatch.setattr(d, "_ytdl_duplicate_readonly_pin", lambda h: pin)

    def close_true(handle):
        closes.append(int(handle) if handle else None)
        return True

    monkeypatch.setattr(d, "_ytdl_close_handle", close_true)
    assert d._ytdl_adopt_committed_pin(original) == pin
    assert closes == [original]

    # --- duplicate succeeds + original close FALSE => return pin; never retry original ---
    closes[:] = []

    def close_false(handle):
        closes.append(int(handle) if handle else None)
        return False

    monkeypatch.setattr(d, "_ytdl_close_handle", close_false)
    assert d._ytdl_adopt_committed_pin(original) == pin
    assert closes == [original]

    # --- duplicate succeeds + original close raises => close unused pin once; return original ---
    closes[:] = []

    def close_raise_original_then_ok(handle):
        hv = int(handle) if handle else None
        closes.append(hv)
        if hv == original:
            raise RuntimeError("close original inject")
        return True

    monkeypatch.setattr(d, "_ytdl_close_handle", close_raise_original_then_ok)
    assert d._ytdl_adopt_committed_pin(original) == original
    assert closes == [original, pin]

    # No branch returns None while a valid original is still owned.
    for mode in ("none", "zero", "invalid", "raise", "true", "false", "raise_close"):
        closes[:] = []
        if mode == "none":
            monkeypatch.setattr(d, "_ytdl_duplicate_readonly_pin", lambda h: None)
            monkeypatch.setattr(d, "_ytdl_close_handle", close_must_not)
        elif mode == "zero":
            monkeypatch.setattr(d, "_ytdl_duplicate_readonly_pin", lambda h: 0)
            monkeypatch.setattr(d, "_ytdl_close_handle", close_must_not)
        elif mode == "invalid":
            monkeypatch.setattr(d, "_ytdl_duplicate_readonly_pin", lambda h: invalid)
            monkeypatch.setattr(d, "_ytdl_close_handle", close_must_not)
        elif mode == "raise":
            monkeypatch.setattr(d, "_ytdl_duplicate_readonly_pin", dup_raise)
            monkeypatch.setattr(d, "_ytdl_close_handle", close_must_not)
        elif mode == "true":
            monkeypatch.setattr(d, "_ytdl_duplicate_readonly_pin", lambda h: pin)
            monkeypatch.setattr(d, "_ytdl_close_handle", close_true)
        elif mode == "false":
            monkeypatch.setattr(d, "_ytdl_duplicate_readonly_pin", lambda h: pin)
            monkeypatch.setattr(d, "_ytdl_close_handle", close_false)
        else:
            monkeypatch.setattr(d, "_ytdl_duplicate_readonly_pin", lambda h: pin)
            monkeypatch.setattr(d, "_ytdl_close_handle", close_raise_original_then_ok)
        got = d._ytdl_adopt_committed_pin(original)
        assert got is not None, mode
        assert got in (original, pin), mode


# ---------------------------------------------------------------------------
# Pre-download feedback + stall detection
#
# The resolution phase used to be a dead "Preparing": --print puts yt-dlp in
# quiet mode, which suppressed the very status lines _yt_stage_note reads, and
# nothing bounded a yt-dlp that went silent (a firewall dropping packets leaves
# it blocked in a socket read with no output, so the row hung indefinitely).
# ---------------------------------------------------------------------------

class KillableProc(LiveProc):
    """LiveProc that honours _safe_kill — the base fake defines no kill()."""

    def kill(self):
        with self._lock:
            self.killed = True
        if self._hold is not None:
            self._hold.set()          # release a blocked reader / wait


class ProgressThenSilentProc:
    """Emits one real progress line, then goes quiet for longer than the stall
    deadline before finishing — i.e. a slow merge. Must NOT be killed."""

    def __init__(self, quiet_for, final_line):
        self._lines = ["[download]   1.0% of  100.00MiB at 1.00MiB/s ETA 00:10",
                       final_line]
        self._i = 0
        self._quiet = quiet_for
        self.killed = False
        self.returncode = None

    @property
    def stdout(self):
        return self

    def __iter__(self):
        return self

    def __next__(self):
        if self._i >= len(self._lines):
            raise StopIteration
        if self._i == 1:
            time.sleep(self._quiet)   # silent stretch AFTER real bytes flowed
        line = self._lines[self._i]
        self._i += 1
        return line

    def wait(self, timeout=None):
        if self.returncode is None:
            self.returncode = -9 if self.killed else 0
        return self.returncode

    def poll(self):
        return self.returncode

    def kill(self):
        self.killed = True


def test_ytdl_cmd_keeps_status_lines_and_bounds_socket_reads():
    import mchost.downloads as d

    cmd = d._ytdl_build_cmd("yt-dlp", "bv*+ba/b", "out.%(ext)s",
                            "https://example.test/v", None, False)
    assert "--print" in cmd, "still uses --print to learn the saved path"
    assert "--no-quiet" in cmd, \
        "--no-quiet keeps the status lines --print would otherwise suppress"
    assert "--socket-timeout" in cmd, \
        "socket reads are bounded so a dropped connection cannot block forever"


def test_stage_note_reads_capitalised_destination_and_cookies():
    import mchost.downloads as d

    # yt-dlp capitalises "Destination", so a case-SENSITIVE prefix test silently
    # never matched and this stage was unreachable.
    assert d._yt_stage_note("[download] Destination: out.mp4") == "Starting download"
    assert d._yt_stage_note("Extracting cookies from firefox") == "Reading cookies"


def test_silent_ytdlp_is_killed_and_reported_as_stalled(tmp_path, monkeypatch):
    import mchost.downloads as d

    sent = []
    hold = threading.Event()          # never set: yt-dlp emits nothing at all
    procs = []

    def fake_popen(*a, **k):
        p = KillableProc(lines=[], returncode=0, hold=hold)
        procs.append(p)
        return p

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)
    monkeypatch.setattr(d, "_YTDL_RESOLVE_STALL", 0.1)   # trip on the first poll

    d.handle_ytdl({"id": "jobStall", "url": "https://example.test/v",
                   "dir": str(tmp_path)})
    term = _wait_terminal(sent, "jobStall", timeout=10)
    assert term["type"] == "ytdl-error", "a silent yt-dlp still settles the row"
    assert term.get("reason") == "stalled", \
        "reported as a stall, not a generic failure"
    assert procs and procs[0].killed, \
        "the stuck process is killed rather than left running forever"


def test_stall_watchdog_disarms_once_bytes_flow(tmp_path, monkeypatch):
    """A slow-but-healthy download (or a long merge) must never be killed."""
    import mchost.downloads as d

    sent = []
    procs = []
    final = tmp_path / "T [id].mp4"

    def fake_popen(*a, **k):
        final.write_bytes(b"OK")
        # Quiet for 3s — well past the 0.1s deadline and spanning a watchdog poll.
        p = ProgressThenSilentProc(3.0, "@@FILE@@ %s" % final)
        procs.append(p)
        return p

    _patch_ytdl_base(monkeypatch, d, mc, sent, popen=fake_popen)
    monkeypatch.setattr(d, "_YTDL_RESOLVE_STALL", 0.1)

    d.handle_ytdl({"id": "jobLive", "url": "https://example.test/v",
                   "dir": str(tmp_path)})
    term = _wait_terminal(sent, "jobLive", timeout=15)
    assert term["type"] == "ytdl-done", "a progressing download completes normally"
    assert procs and not procs[0].killed, \
        "a download that produced bytes is never killed by the stall watchdog"


# ---------------------------------------------------------------------------
# Auto-fetch must land the DIRECTORY build
#
# The onefile build re-extracts ~145 files to %TEMP% on EVERY launch. Under a
# browser-descended process those get rescanned each time, which is what made
# host-spawned yt-dlp block during DLL load for ~90s while the identical shell
# command ran in about a second. The directory build extracts nothing.
# ---------------------------------------------------------------------------

def test_auto_fetch_installs_the_directory_build_not_the_onefile(tmp_path, monkeypatch):
    import io as _io
    import zipfile as _zip
    import mchost.downloads as d

    # A stand-in for the official yt-dlp_win.zip layout.
    buf = _io.BytesIO()
    with _zip.ZipFile(buf, "w") as z:
        z.writestr("yt-dlp.exe", b"EXE")
        z.writestr("_internal/base_library.zip", b"LIB")
        z.writestr("_internal/certifi/cacert.pem", b"PEM")
    payload = buf.getvalue()

    asked = {}

    def fake_urlopen(req, timeout=None):
        asked["url"] = getattr(req, "full_url", str(req))
        # BytesIO, not a hand-rolled fake: a read() that keeps returning the same
        # bytes makes shutil.copyfileobj loop forever writing an unbounded file.
        return _io.BytesIO(payload)

    import urllib.request
    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(mc, "HERE", str(tmp_path))
    monkeypatch.setattr(mc, "_hlog", lambda *a, **k: None)
    monkeypatch.setattr(d, "_h", lambda: mc)
    monkeypatch.setattr(d, "YTDLP", None)

    got = d.ensure_ytdlp()

    assert asked.get("url", "").endswith("yt-dlp_win.zip"), \
        "must fetch the directory build, not the bare onefile exe (got %r)" % asked.get("url")
    assert got == str(tmp_path / "yt-dlp.exe"), "returns the extracted exe path"
    assert os.path.isfile(str(tmp_path / "yt-dlp.exe")), "exe extracted"
    assert os.path.isfile(str(tmp_path / "_internal" / "base_library.zip")), \
        "_internal must be extracted alongside it or the exe cannot start"


def test_utf8_filepath_from_ytdlp_is_not_mojibaked(tmp_path, monkeypatch):
    """yt-dlp emits @@FILE@@ as UTF-8 and substitutes fullwidth quotes (U+FF02)
    for '"' in filenames. Reading its stdout with a bare text=True decodes as the
    locale codepage (cp1252 here), so the path came back mojibaked, os.path.isfile
    said no, and a download that had fully succeeded on disk was reported as a
    generic failure. Uses a REAL subprocess: the decode is the thing under test,
    so a fake proc yielding str would prove nothing."""
    import mchost.downloads as d

    name = "\uff02Quoted\uff02 \u2014 Title.mp4"
    target = tmp_path / name
    # Built line-by-line with bytes([10]) for the newline: nesting a "\n" escape
    # inside generated source is one collapse away from a syntax error in the
    # child, which then writes nothing and looks exactly like the bug.
    child = "\n".join([
        "import sys",
        "p = %r" % str(target),
        "open(p, 'wb').write(b'DATA')",
        "sys.stdout.buffer.write(('@@FILE@@ ' + p).encode('utf-8'))",
        "sys.stdout.buffer.write(bytes([10]))",
        "sys.stdout.flush()",
    ])

    sent = []
    _patch_ytdl_base(monkeypatch, d, mc, sent)          # leaves the real Popen
    monkeypatch.setattr(d, "_ytdl_build_cmd",
                        lambda *a, **k: [sys.executable, "-c", child])

    d.handle_ytdl({"id": "utf8job", "url": "https://example.test/v",
                   "dir": str(tmp_path)})
    term = _wait_terminal(sent, "utf8job", timeout=20)

    assert term["type"] == "ytdl-done", \
        "a UTF-8 filename must not turn a finished download into a failure (got %r)" % term
    assert term.get("file") == str(target), \
        "the reported path must survive the decode intact"


def test_ytdl_cmd_forces_utf8_output_encoding():
    """yt-dlp picks its OWN stdout encoding from the locale (cp1252 here) and
    writes the @@FILE@@ path through it, so characters outside that codepage were
    destroyed before we ever read them -- the fullwidth quotes it substitutes for
    '"' vanished and the em dash became '?'. Reading as UTF-8 cannot recover what
    was never written; yt-dlp has to be told to emit UTF-8 in the first place."""
    import mchost.downloads as d

    cmd = d._ytdl_build_cmd("yt-dlp", "bv*+ba/b", "out.%(ext)s",
                            "https://example.test/v", None, False)
    assert "--encoding" in cmd, "yt-dlp must be told which encoding to emit"
    assert cmd[cmd.index("--encoding") + 1].lower() in ("utf-8", "utf8"), \
        "the emitted encoding must be UTF-8 to match how we decode it"


# ---------------------------------------------------------------------------
# The -J metadata probe needs the same bound as the download
# ---------------------------------------------------------------------------

def test_ytmeta_probe_that_never_answers_replies_and_kills_the_tree(tmp_path, monkeypatch):
    """subprocess.run(timeout=...) is not a bound here. yt-dlp's onefile launcher
    re-execs the real program as a child that inherits these pipes, so run()'s
    timeout path kills only the launcher and then blocks in its cleanup
    communicate(), waiting on a pipe the surviving grandchild still holds. The
    popup then sits on "Reading formats..." and the grandchild is orphaned --
    exactly the stray probes found running with a dead parent."""
    import mchost.downloads as d

    pidfile = tmp_path / "grandchild.pid"
    child = "\n".join([
        "import subprocess, sys, time",
        "c = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])",
        "open(%r, 'w').write(str(c.pid))" % str(pidfile),
        "time.sleep(120)",
    ])

    real_popen = subprocess.Popen

    def fake_popen(cmd, **kw):
        # Swap ONLY the probe argv, keeping REAL process semantics: the pipe and
        # the process tree are what is under test. Everything else must pass
        # through -- d.subprocess is the global module, so blanket-replacing
        # Popen would also break the taskkill that _safe_kill shells out to.
        if cmd and cmd[0] == "yt-dlp-fake":
            return real_popen([sys.executable, "-c", child], **kw)
        return real_popen(cmd, **kw)

    sent = []
    monkeypatch.setattr(mc, "send", lambda m: sent.append(dict(m)))
    monkeypatch.setattr(mc, "_hlog", lambda *a, **k: None)
    monkeypatch.setattr(d, "_h", lambda: mc)
    monkeypatch.setattr(d, "find_ytdlp", lambda: "yt-dlp-fake")
    monkeypatch.setattr(d, "find_deno", lambda: None)
    monkeypatch.setattr(d, "DENO", None)
    monkeypatch.setattr(d, "_no_window", lambda: (0, None))
    monkeypatch.setattr(d, "_YTMETA_TIMEOUT", 2, raising=False)
    monkeypatch.setattr(d.subprocess, "Popen", fake_popen)

    d.handle_ytmeta({"reqId": "meta1", "url": "https://example.test/v"})

    assert wait_for(lambda: any(m.get("type") == "ytmeta" and m.get("reqId") == "meta1"
                                for m in sent), timeout=30), \
        "a probe that never answers must still settle the row, not hang on 'Reading formats'"
    reply = [m for m in sent if m.get("type") == "ytmeta" and m.get("reqId") == "meta1"][-1]
    assert reply.get("ok") is False, "a timed-out probe reports failure"

    gc = int(pidfile.read_text().strip())

    def alive(pid):
        r = subprocess.run(["tasklist", "/FI", "PID eq %d" % pid, "/NH"],
                           capture_output=True, text=True)
        return str(pid) in (r.stdout or "")

    assert wait_for(lambda: not alive(gc), timeout=20), \
        "the probe's descendants must be killed too, not orphaned holding the pipe"


def test_ytdl_cmd_restricts_filenames_to_ascii():
    """Saved names are ASCII-only by choice: portable across filesystems and
    tooling, and free of the fullwidth quotes yt-dlp substitutes for '"'.

    Not a substitute for --encoding: that fixes the CORRUPTION of the path yt-dlp
    reports back, which would still bite any title this happens not to flatten.
    Both are required."""
    import mchost.downloads as d

    cmd = d._ytdl_build_cmd("yt-dlp", "bv*+ba/b", "out.%(ext)s",
                            "https://example.test/v", None, False)
    assert "--restrict-filenames" in cmd, "saved names are ASCII-only"
    assert "--encoding" in cmd, "still tells yt-dlp which encoding to emit"


def test_lib_argv_omits_the_stdout_only_flags(monkeypatch):
    """The in-process argv must carry the real download flags but NOT the
    exe/stdout-only ones: --newline/--progress/--no-quiet dump to the screen and
    --print @@FILE@@ is replaced by reading the path from the info dict. In the
    host, stdout is the native-messaging channel, so a stray --no-quiet would
    corrupt the framing."""
    import mchost.downloads as d
    monkeypatch.setattr(mc, "FFMPEG", r"C:\H\ffmpeg.exe")
    monkeypatch.setattr(d, "_h", lambda: mc)
    argv = d._ytdl_lib_argv("bv*+ba/b", "out.%(ext)s", "https://x.test/v",
                            r"C:\H\deno.exe", pot=False)
    for good in ("-f", "--restrict-filenames", "--encoding", "--socket-timeout",
                 "--cookies-from-browser", "--merge-output-format"):
        assert good in argv, "missing %s" % good
    for bad in ("--newline", "--progress", "--no-quiet", "--print"):
        assert bad not in argv, "%s must not reach the in-process path" % bad
    assert argv[-1] == "https://x.test/v"
    assert ("deno:" + r"C:\H\deno.exe") in argv


def test_lib_argv_carries_the_pot_extractor_arg_only_when_pot_is_on():
    import mchost.downloads as d
    on = d._ytdl_lib_argv("b", "o.%(ext)s", "u", None, pot=True)
    off = d._ytdl_lib_argv("b", "o.%(ext)s", "u", None, pot=False)
    assert any("youtubepot" in a for a in on)
    assert not any("youtubepot" in a for a in off)
