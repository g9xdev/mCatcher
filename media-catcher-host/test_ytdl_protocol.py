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
    dest_opens = [c for c in create_calls if c and os.path.normcase(str(c)) == os.path.normcase(str(dest))]
    assert len(dest_opens) == 1, dest_opens
    key = d._ytdl_canon_path_key(str(dest))
    assert d._YTDL_DEST_LEASES.get(key) is None


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
    """Disposition targets the held handle; pathname delete APIs are unused."""
    import mchost.downloads as d

    dest = tmp_path / "crepl"
    dest.mkdir()
    outside = tmp_path / "outside-secret.mp4"
    outside.write_bytes(b"OUTSIDE-SECRET")
    sent = []
    path_deletes = []

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

    post_wait = threading.Event()
    release = threading.Event()
    payload = b"TO-DISPOSE"

    def after_wait():
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
    # destination lease acquisition — never demote a successful Nt rename.
    real_commit = d._ytdl_commit_source
    calls = {"n": 0}

    def commit_then_break(source_handle, dest_lease, safe_name, max_attempts=32):
        path = real_commit(source_handle, dest_lease, safe_name, max_attempts=max_attempts)
        calls["n"] += 1
        # Break diagnostics after the successful rename decision.
        monkeypatch.setattr(d, "_ytdl_final_path", lambda h: (_ for _ in ()).throw(OSError("diag boom")))
        api = d._ytdl_winapi()
        monkeypatch.setattr(api.k32, "GetFinalPathNameByHandleW", lambda *a, **k: 0)
        return path

    monkeypatch.setattr(d, "_ytdl_commit_source", commit_then_break)
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
    """Cancel-before-commit: 0 Nt renames, no final. Commit-first: done, cancel inert."""
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

    sent.clear()
    rename_calls.clear()

    def ok_popen(*a, **k):
        path = _materialize_stage_from_cmd(a, b"COMMITTED")
        return LiveProc(lines=["@@FILE@@ %s" % path], returncode=0)

    monkeypatch.setattr(d.subprocess, "Popen", ok_popen)
    d.handle_ytdl({
        "id": "jobLin2", "attemptToken": "atk-lin2",
        "url": "https://example.test/v2", "name": "lin2.mp4", "dir": str(dest),
    })
    term2 = _wait_terminal(sent, "jobLin2")
    assert term2["type"] == "ytdl-done"
    assert term2["bytes"] == len(b"COMMITTED")
    assert open(term2["file"], "rb").read() == b"COMMITTED"
    assert 10 in rename_calls
    before = len(sent)
    d._pget_cancel({"id": "jobLin2", "attemptToken": "atk-lin2"})
    assert len(sent) == before
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

    def run(case):
        sent = []
        jid = "jobLife-%s" % case
        hold = threading.Event()
        release = threading.Event()
        # Restore lease acquire between cases (setup_fail patches it).
        monkeypatch.setattr(d, "_ytdl_acquire_dest_lease", real_acquire)

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
        return term

    assert run("success")["type"] == "ytdl-done"
    assert run("subprocess_fail")["type"] == "ytdl-error"
    assert run("validation_fail")["type"] == "ytdl-error"
    assert run("setup_fail")["type"] == "ytdl-error"
    assert run("cancel")["reason"] == "cancelled"
    t = run("send_throw")
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
