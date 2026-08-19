# Download Liveness & Host Scan-Surface Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two defects that produce the reported stalls (a wedged download queue and a "Preparing" row that never advances), then close the four latent liveness gaps behind them and settle the two packaging questions.

**Architecture:** Two independent halves. The **extension** half restores the scheduler's liveness contract: a failed start must release its concurrency slot, and the controller must be driven by a real clock so time-based states (`retry_backoff`, pause drains, helper re-dial, heartbeat) can actually expire. The **host** half removes the last onefile yt-dlp from the install and runtime paths and gives the in-process resolve a bounded, cancellable lifetime. Every change is additive to existing idioms — no new modules, no new dependencies.

**Tech Stack:** Firefox MV2 extension (ES5-style JS, `node:test` + `node:assert/strict`, no build step, no package.json); Python 3 native-messaging helper (`pytest`); Inno Setup + PowerShell installer.

## Global Constraints

- **No new runtime dependencies.** Both suites run offline against the tree as-is.
- **Two JS dialects in one extension — match the file you are in.** `media-catcher/lib/**` is ES5-style: `var`, `function`, no arrow functions, no `let`/`const`. `media-catcher/background.js`, `content.js` and the test files use modern JS (`const`, `let`, arrow functions). Copying an idiom across that line is the most likely review rejection.
- **JS suite command (from `media-catcher/`):** `node --test "tests/*.test.js"` — **baseline at HEAD 2caf92c: 746 pass, 0 fail.**
- **Single JS test:** `node --test --test-name-pattern="<name>" "tests/<file>.test.js"` from `media-catcher/`.
- **Python suite command (from `media-catcher-host/`):** `python -m pytest -q` — **baseline at HEAD: 326 pass.** Must be run with `media-catcher-host/` as the working directory; `conftest.py` resolves imports relative to it.
- **Single Python test:** `python -m pytest test_<file>.py::test_<name> -q` from `media-catcher-host/`.
- **CI does not gate on either suite.** `.github/workflows/release.yml:24-26` runs only `python -m py_compile media-catcher-host/mc_host.py` and `python media-catcher-host/test_guardian.py`. Both suites are the developer's responsibility — run them.
- **Commit style:** lowercase declarative, `type: what changed and why`, e.g. `fix: release the slot when a direct start never reaches the helper`. Types in use: `feat`, `fix`, `docs`, `devtools`, `release`. End every commit message with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Never auto-apply an antivirus exclusion.** See Task 9 — this is a settled, deliberate design constraint, not an unimplemented feature.

---

## Where this plan came from

A two-lane adversarial review (`.orchestration/reviews/2026-08-19-mcatcher-hardening.ledger.md`) attacked eight author claims; four survived as stated, four were partly refuted, and two reviewer-originated findings were confirmed. A second 16-agent verification pass re-checked every citation character-for-character against HEAD. Corrections that changed this plan:

- **The two reported symptoms are on *different* code paths.** `grep -n 'ytdl' lib/download-message-router.js lib/background-adapters.js lib/download-scheduler.js` returns **zero hits**. YouTube items reach `onLegacyNativeMessage` via `background.js:463` (`if (handled !== true) onLegacyNativeMessage(msg);`). So the scheduler findings govern **symptom 1 only** (direct/HLS/DASH), and the "Preparing" row is produced by the legacy path at `background.js:386`, cleared only at `background.js:676`. A scheduler fix cannot touch symptom 2, and vice versa.
- **The L-A5 wedge is not permanent.** `helperDisconnected` (`background.js:416-422` → `background-adapters.js:3153`) releases every running job on the next port disconnect. The wedge persists until the helper drops — bad, but bounded. Severity is "queue stuck with no in-UI way out", not "stuck forever".
- **`startedAttempts.add` must stay *before* the post.** It is the re-entrancy guard proven by `tests/background-download-admission.test.js:617-647` (`overlapping pumps post one live attempt while the first effect is unsettled`, asserting `commands.length === 1`). Any fix that moves the add after the post breaks that test. Task 1 keeps the add and adds a compensating delete.
- **The unguarded window is lines 3227→3247, not 3247 alone.** `scheduler.nativeLeaseFor` (3230) and `getMessageRouter().buildNativeStartPayload` (3246) sit between the key add and the post, and a throw from either leaks the key too.
- **B3 is not a defect.** Auto-applying the AV exclusion is prohibited by spec, by test, and by the code's own comment (`probe.py:112-113`: "Reported, never applied: it needs admin regardless, and a diagnostics / button that silently punches AV holes is shaped exactly like malware."). The command *is* surfaced as text end-to-end. Task 9 locks that contract rather than changing behaviour.
- **Track 2 (cut helper exe spawns) was dropped.** The remaining ordinary-path spawns are `deno` ×1 and `ffmpeg` ×1, both functionally required. The in-process yt-dlp change already captured the available win.

---

## Task 1: Release the slot when a direct start never reaches the helper

**Symptom this fixes:** downloads sit queued and never start (symptom 1).

**Mechanism:** `pump()` adds the attempt key at `background-adapters.js:3227` and posts at `:3247`. If anything between those lines throws — `postNative` itself (`background.js:131` throws synchronously whenever the port is absent), `scheduler.nativeLeaseFor` (`:3230`), or `buildNativeStartPayload` (`:3246`) — the key stays in `startedAttempts` forever, so no later `pump()` retries the post, while the job stays `running` and holds the global slot (`download-scheduler.js:1292` `job.holdsGlobalSlot = true;`). With `maxConcurrent: 1` every subsequent download queues behind a job the helper never heard about. `enqueueDownload` rethrows without telling the scheduler (`:2656-2659`), whereas `manualRetry` on the identical failure calls `activeScheduler.onTransportUnavailable(jobId);` (`:3104`). The direct branch is the lone outlier among four sibling paths.

> **DECISION REQUIRED BEFORE PATCHING.** Two existing tests do not merely tolerate the wedged state — they *assert* it, with names that read as intent. The counter-reading is failure-atomicity: `enqueueDownload` committed a job and a slot, and a transport error arguably should not mutate scheduler state behind the caller's rethrow (`download-scheduler.js:369` carries a comment naming this concern). Against that reading: `manualRetry` (`:3104`), `cancel` (`:3058`, `:3068`) and the assembled branch of `pump` (which self-heals via `settleAssemblyOutcome` and swallows at `:2605`) all *do* mutate state on this same failure class. This plan treats the direct branch as an unintended outlier and flips the two assertions. **Confirm that call before Step 1.**

**Files:**
- Modify: `media-catcher/lib/background-adapters.js` — add `postDirectAttempt` after `startAssembledAttempt` (which ends at `:2607`); change the single line `:3247`.
- Test: `media-catcher/tests/background-download-admission.test.js` — one new test; two existing assertions updated.

**Interfaces:**
- Consumes: `postNative` (adapter dependency, invoked at `:3247` today), `startedAttempts` (`Set`, declared `:1414`), `scheduler.onTransportUnavailable(jobId)` (`download-scheduler.js:2612`).
- Produces: `postDirectAttempt(activeScheduler, jobId, key, command) -> Promise` — always returns a promise; rejects with the original error, identity preserved.

- [ ] **Step 1: Write the failing test**

Append to `media-catcher/tests/background-download-admission.test.js`:

```js
test("a direct start that never reaches the helper releases its slot", async () => {
  const effectError = new Error("native post rejected");
  let calls = 0;
  const commands = [];
  const h = makeHarness({
    maxConcurrent: 1,
    postNative(command) {
      calls += 1;
      if (calls === 1) throw effectError;
      commands.push(command);
      return command;
    },
  });
  const firstId = captureDirect(h.ctrl, {
    url: YT_SIGNED,
    pageUrl: YT_PAGE,
    tabId: 60,
    docId: "doc-slot-a",
    filename: "a.mp4",
  });
  const secondId = captureDirect(h.ctrl, {
    url: VM_SIGNED,
    pageUrl: VM_PAGE,
    tabId: 61,
    docId: "doc-slot-b",
    filename: "b.mp4",
  });

  await assert.rejects(
    h.ctrl.enqueueDownload(
      { type: "download", tabId: 60, item: { id: firstId }, intent: defaultIntent("a.mp4") },
      {}
    ),
    (err) => err === effectError
  );

  // The wedged job must not still hold the only slot: the next enqueue must start.
  await h.ctrl.enqueueDownload(
    { type: "download", tabId: 61, item: { id: secondId }, intent: defaultIntent("b.mp4") },
    {}
  );

  assert.equal(commands.length, 1);
  const rows = h.published[h.published.length - 1];
  assert.deepEqual(rows.map((row) => row.state).sort(), ["needs_user", "running"]);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run from `media-catcher/`:

```bash
node --test --test-name-pattern="releases its slot" "tests/background-download-admission.test.js"
```

Expected: FAIL — `commands.length` is `0`, because the first job still holds the only slot so the second never starts.

- [ ] **Step 3: Add the helper**

In `media-catcher/lib/background-adapters.js`, insert immediately after the closing brace of `startAssembledAttempt` (line `2607`), just before `function enqueueDownload(`:

```js
      /**
       * Post one direct attempt. The key was added to startedAttempts BEFORE the
       * post on purpose - it is the re-entrancy guard that keeps overlapping pumps
       * to one live attempt - so a start that never reaches the helper has to undo
       * it here and hand the slot back, the way manualRetry already does.
       * Always returns a promise: a synchronous throw must not abort pump's loop
       * and strand the still-unstarted jobs behind it in the same snapshot.
       */
      function postDirectAttempt(activeScheduler, jobId, key, command) {
        function failStart(err) {
          startedAttempts.delete(key);
          activeScheduler.onTransportUnavailable(jobId);
          throw err;
        }
        var effect;
        try {
          effect = postNative(command);
        } catch (errSync) {
          return Promise.resolve().then(function () {
            failStart(errSync);
          });
        }
        return Promise.resolve(effect).catch(failStart);
      }
```

- [ ] **Step 4: Route the post through it**

In the same file, replace line `3247`:

```js
            pending.push(Promise.resolve(postNative(command)));
```

with:

```js
            pending.push(postDirectAttempt(scheduler, job.id, key, command));
```

Do **not** move `startedAttempts.add(key)` from line `3227`, and do **not** inline the closure in the loop body — `var job` (`:3211`) and `var key` (`:3216`) are function-scoped, so an inline closure would capture the last iteration's values and park the wrong job.

- [ ] **Step 5: Update the two tests that assert the old wedged state**

In `tests/background-download-admission.test.js`, inside `"enqueue publishes its committed safe running job when native post rejects"` (line 545), change:

```js
  assert.equal(h.published[0][0].state, "running");
```

to:

```js
  assert.equal(h.published[0][0].state, "needs_user");
```

Inside `"raising capacity publishes committed running jobs when native post rejects"` (line 580), change:

```js
  assert.deepEqual(rows.map((row) => row.state), ["running", "running"]);
```

to:

```js
  assert.deepEqual(rows.map((row) => row.state), ["running", "needs_user"]);
```

Rename that second test to `"raising capacity parks the job whose native post rejects"` so the name matches what it asserts. Leave both `assertSafeProjection` calls untouched.

- [ ] **Step 6: Run the new test, then the whole suite**

```bash
node --test --test-name-pattern="releases its slot" "tests/background-download-admission.test.js"
```

Expected: PASS.

```bash
node --test "tests/*.test.js"
```

Expected: 747 pass, 0 fail (746 baseline + 1 new). `overlapping pumps post one live attempt while the first effect is unsettled` must still pass — if it fails, the `add` was moved and Step 4 was done wrong.

- [ ] **Step 7: Commit**

```bash
git add media-catcher/lib/background-adapters.js media-catcher/tests/background-download-admission.test.js
```

Then commit with this message (subject line, blank line, body):

`fix: release the slot when a direct start never reaches the helper`

Body: pump() marks an attempt started before posting it, so a post that throws — which is every enqueue issued while the native port is down — left the key in startedAttempts and the job in running, holding the only slot with no retry and no in-UI way out. manualRetry already parked the job on this same failure; the direct branch was the lone outlier. It now undoes the key and calls onTransportUnavailable, and routes a synchronous throw through a rejected promise so the loop still starts the jobs behind it. Close with the `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` trailer.

---

## Task 2: Make `ensure_ytdlp` treat a onefile as missing

**Symptom this fixes:** "Preparing" forever (symptom 2), on installs that already have the onefile.

**Mechanism:** commit `a1016a6` measured the onefile launcher re-extracting ~145 files to `%TEMP%` per launch and blocking ~90s in DLL load under a browser-descended process, versus ~1.2s for the same command from a shell. It fixed `ensure_ytdlp` to fetch the **directory build** (`yt-dlp_win.zip`: `yt-dlp.exe` + `_internal/`). But `ensure_ytdlp` short-circuits at `downloads.py:930-931`:

```python
    global YTDLP
    if YTDLP:
        return YTDLP
```

`find_ytdlp` (`:809-812`) returns `HERE/yt-dlp.exe` whenever that file exists, regardless of which build it is. Since the installer already placed a onefile there (Task 3), the corrected fetch **never runs and never repairs the install**. `grep -n "^\s*YTDLP\s*=\|global YTDLP" mchost/downloads.py` returns only lines 929, 957 and 5170 — nothing else rebinds it, so there is no other path that could heal this.

**Files:**
- Modify: `media-catcher-host/mchost/downloads.py` — add `_has_internal` and a re-fetch guard; change the short-circuit in `ensure_ytdlp`.
- Test: `media-catcher-host/test_ytdl_protocol.py`.

**Interfaces:**
- Produces: `_has_internal(exe) -> bool` — True when `exe` sits beside an `_internal/` directory, i.e. is the directory build. `probe.py` already has an equivalent pair (`internal_dir_for` at `:119`, `has_internal_for` at `:131`); this is the downloads-side twin. Do not import across — `probe.py` imports from `downloads` at call time, not the reverse.

- [ ] **Step 1: Write the failing test**

Append to `media-catcher-host/test_ytdl_protocol.py`:

```python
def test_ensure_ytdlp_refetches_when_the_local_exe_is_a_onefile(tmp_path, monkeypatch):
    """A onefile left by an older installer must not be accepted as good: it is the
    build that stalled ~90s in DLL load under a browser-descended process."""
    import mchost.downloads as d

    onefile = tmp_path / "yt-dlp.exe"
    onefile.write_bytes(b"MZ onefile")
    monkeypatch.setattr(d, "YTDLP", str(onefile), raising=False)
    monkeypatch.setattr(d, "_YTDLP_REFETCHED", False, raising=False)
    monkeypatch.setattr(d, "_h", lambda: mc)
    monkeypatch.setattr(os, "name", "nt")

    fetched = {"n": 0}

    def fake_urlopen(*a, **k):
        fetched["n"] += 1
        raise RuntimeError("network down")

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)

    # A onefile is not acceptable, so a fetch must be attempted; and when that fetch
    # fails the existing exe is still returned rather than None, so a working-but-slow
    # install does not become a broken one.
    assert d.ensure_ytdlp() == str(onefile)
    assert fetched["n"] == 1

    # The re-fetch must be once per process, not once per download.
    d.ensure_ytdlp()
    assert fetched["n"] == 1


def test_ensure_ytdlp_accepts_a_directory_build_without_refetching(tmp_path, monkeypatch):
    import mchost.downloads as d

    exe = tmp_path / "yt-dlp.exe"
    exe.write_bytes(b"MZ dirbuild")
    (tmp_path / "_internal").mkdir()
    monkeypatch.setattr(d, "YTDLP", str(exe), raising=False)
    monkeypatch.setattr(d, "_YTDLP_REFETCHED", False, raising=False)

    def boom(*a, **k):
        raise AssertionError("must not fetch when the directory build is present")

    monkeypatch.setattr("urllib.request.urlopen", boom)
    assert d.ensure_ytdlp() == str(exe)
```

- [ ] **Step 2: Run it to make sure it fails**

From `media-catcher-host/`:

```bash
python -m pytest test_ytdl_protocol.py -k ensure_ytdlp_refetches -q
```

Expected: FAIL — `fetched["n"] == 0`, because the `if YTDLP: return YTDLP` short-circuit returns the onefile before any fetch.

- [ ] **Step 3: Add the build check and the once-per-process guard**

In `media-catcher-host/mchost/downloads.py`, immediately above `def ensure_ytdlp():` (line 917):

```python
# Set once a session has already tried to replace a onefile: a failing network
# must not re-download on every job.
_YTDLP_REFETCHED = False


def _has_internal(exe):
    """True when exe is the directory build - yt-dlp.exe beside _internal/.

    The onefile launcher re-extracts ~145 files to %TEMP% on every launch and,
    under a browser-descended process, each extraction is rescanned; that is the
    ~90s DLL-load stall the UI showed as "Preparing" forever."""
    if not exe:
        return False
    return os.path.isdir(os.path.join(os.path.dirname(exe), "_internal"))
```

- [ ] **Step 4: Replace the short-circuit**

In `ensure_ytdlp`, replace lines 929-933:

```python
    global YTDLP
    if YTDLP:
        return YTDLP
    if os.name != "nt":
        return None
```

with:

```python
    global YTDLP, _YTDLP_REFETCHED
    if YTDLP and _has_internal(YTDLP):
        return YTDLP
    if os.name != "nt":
        # Nothing to upgrade off-Windows: keep whatever was resolved.
        return YTDLP
    if _YTDLP_REFETCHED:
        return YTDLP
    _YTDLP_REFETCHED = True
```

And in the same function's `except` handler (lines 960-962), replace:

```python
    except Exception as e:
        _h()._hlog("error", "yt-dlp download failed: %s" % e)
        return None
```

with:

```python
    except Exception as e:
        _h()._hlog("error", "yt-dlp download failed: %s" % e)
        # Keep a working-but-slow onefile rather than turning it into no yt-dlp
        # at all. A sharing violation here just means a download is in flight.
        return YTDLP
```

Update the docstring's first line to say it fetches when yt-dlp is missing **or is a onefile**.

- [ ] **Step 5: Run the tests**

```bash
python -m pytest test_ytdl_protocol.py -k ensure_ytdlp -q
```

Expected: 2 passed.

```bash
python -m pytest -q
```

Expected: 328 passed (326 baseline + 2 new).

- [ ] **Step 6: Commit**

Subject: `fix: treat a onefile yt-dlp as missing so the directory build replaces it`

Body: ensure_ytdlp was corrected to fetch the directory build, but it returned early whenever any yt-dlp.exe existed — and the installer had already put a onefile there, so the correction never ran. It now accepts only an exe beside _internal/, retries once per process, and keeps the existing exe when the fetch fails rather than reporting no yt-dlp at all. Close with the `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` trailer.

---

## Task 3: Install the yt-dlp directory build instead of the onefile

**Symptom this fixes:** "Preparing" forever (symptom 2), at the source — every fresh install.

**Mechanism:** `installer/bootstrap.ps1:174` still fetches the onefile:

```powershell
    Invoke-WebRequest -Uri "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" -OutFile $localYtdlp
```

and the guard above it (`:167` `if (Test-Path $localYtdlp)`) reports an existing onefile as `"yt-dlp: present (self-updates)"`, so re-running the installer never upgrades it. The in-process library is the intended escape, but `:192-193` only installs it when `python.exe` sits beside `pythonw.exe`; otherwise it warns and takes the exe fallback. On this developer machine there is no `pylib/` at all, so the fallback is the live path today.

**Files:**
- Modify: `media-catcher-host/installer/bootstrap.ps1` lines 162-177.
- Test: `media-catcher-host/test_packaging_runtime_layout.py`.

- [ ] **Step 1: Write the failing test**

Append to `media-catcher-host/test_packaging_runtime_layout.py`:

```python
def test_bootstrap_fetches_the_ytdlp_directory_build_not_the_onefile():
    """The onefile re-extracts ~145 files per launch and stalled ~90s under AV.
    The installer must not put one on disk (see commit a1016a6)."""
    src = (Path(__file__).parent / "installer" / "bootstrap.ps1").read_text(encoding="utf-8")

    assert "releases/latest/download/yt-dlp_win.zip" in src
    assert "releases/latest/download/yt-dlp.exe" not in src
    # The presence check must require _internal/, so re-running upgrades a onefile.
    assert "_internal" in src
```

- [ ] **Step 2: Run it to make sure it fails**

From `media-catcher-host/`:

```bash
python -m pytest test_packaging_runtime_layout.py -k directory_build -q
```

Expected: FAIL on `assert "releases/latest/download/yt-dlp.exe" not in src`.

- [ ] **Step 3: Rewrite the yt-dlp section**

Replace `installer/bootstrap.ps1` lines 162-177 in full with the block below. It mirrors the deno section (`:218-229`) exactly: stage into `$env:TEMP`, expand, verify **both** the exe and `_internal/` before copying into place, then clean up. A partial expansion must never replace a working install.

```powershell
# ---------- 3b. yt-dlp (YouTube + many other sites) ----------
# The DIRECTORY build (yt-dlp.exe + _internal\), never the onefile. The onefile
# launcher re-extracts ~145 files to %TEMP% on every launch; under a browser-
# descended process each extraction is rescanned and the launch blocked ~90s in
# DLL load, which the UI showed as "Preparing" forever. It self-updates
# (yt-dlp -U, triggered by the host) because YouTube breaks it often.
$localYtdlp = Join-Path $InstallDir "yt-dlp.exe"
$localInternal = Join-Path $InstallDir "_internal"
if ((Test-Path $localYtdlp) -and (Test-Path $localInternal)) {
  Step "yt-dlp: present (directory build, self-updates)"
} elseif ($SkipYtdlp) {
  Warn "yt-dlp: skipped - YouTube downloads will be unavailable"
} else {
  if (Test-Path $localYtdlp) { Warn "yt-dlp: replacing the onefile with the directory build..." }
  else { Warn "yt-dlp: downloading the latest release..." }
  try {
    $yz = Join-Path $env:TEMP "ytdlp-mc.zip"
    Invoke-WebRequest -Uri "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_win.zip" -OutFile $yz
    $yex = Join-Path $env:TEMP "ytdlp-mc"
    if (Test-Path $yex) { Remove-Item $yex -Recurse -Force }
    Expand-Archive -Path $yz -DestinationPath $yex -Force
    $hit = Get-ChildItem -Path $yex -Recurse -Filter "yt-dlp.exe" | Select-Object -First 1
    if (-not $hit) { throw "yt-dlp.exe missing from archive" }
    $staged = Split-Path -Parent $hit.FullName
    if (-not (Test-Path (Join-Path $staged "_internal"))) { throw "_internal missing from archive" }
    Copy-Item $hit.FullName $localYtdlp -Force
    if (Test-Path $localInternal) { Remove-Item $localInternal -Recurse -Force }
    Copy-Item (Join-Path $staged "_internal") $InstallDir -Recurse -Force
    Remove-Item $yz -Force; Remove-Item $yex -Recurse -Force
    if ((Test-Path $localYtdlp) -and (Test-Path $localInternal)) { Step "yt-dlp: installed (directory build)" }
    else { throw "yt-dlp not complete after copy" }
  } catch { Warn ("yt-dlp: download failed (" + $_ + "). Put the yt-dlp directory build in " + $InstallDir + " to enable YouTube.") }
}
```

- [ ] **Step 4: Check the script still parses**

PowerShell parse check, run from `media-catcher-host/installer/`:

```bash
powershell -NoProfile -Command "[void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path ./bootstrap.ps1), [ref]$null, [ref]$null); 'parsed ok'"
```

Expected: `parsed ok`.

- [ ] **Step 5: Run the tests**

```bash
python -m pytest test_packaging_runtime_layout.py -q
```

Expected: PASS, including the new test.

```bash
python -m pytest -q
```

Expected: 329 passed (328 after Task 2, + 1 new).

- [ ] **Step 6: Commit**

Subject: `fix: install yt-dlp's directory build, and upgrade an existing onefile`

Body: bootstrap still fetched the onefile and reported an existing one as present, so a1016a6's directory-build fix never reached a real install and re-running the installer could not repair it. It now stages yt-dlp_win.zip into TEMP, verifies both the exe and _internal before copying, and treats a onefile as something to replace. Close with the `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` trailer.

---

## Task 4: Acknowledge a YouTube job before the slow preflight, and bound the resolve

**Symptom this fixes:** the remaining half of "Preparing" forever — the part that survives Tasks 2 and 3.

**Mechanism:** in `_handle_ytdl_legacy`'s `worker()` (`downloads.py:3505-3520`), the first `ytdl-progress` frame is only sent *after* `ensure_deno()` and `start_pot_provider()`:

```python
        deno = ensure_deno()   # yt-dlp needs a JS runtime to solve YouTube's 'n' challenge
        ...
        pot = start_pot_provider()            # best-effort; without it, quality caps ~1080p
```

`ensure_deno()` can spend up to its urlopen timeout downloading a JS runtime, and `start_pot_provider()` waits on a socket bind. Throughout, the row shows the extension-side `"Preparing"` set at `background.js:386` with no host acknowledgement — indistinguishable from a dead helper. This affects the library path and the exe path equally.

Separately, `_ytdl_download_via_lib` has no resolve deadline — **but the exe path does**. The exe branch runs a `_StallWatch` against the existing `_YTDL_RESOLVE_STALL = 90` (`downloads.py:2776`) and reports `reason: "stalled"` with yt-dlp's last output. So this is a **parity gap**, not a new feature: moving yt-dlp in-process silently dropped a watchdog the exe path still has. The library docstring argues one is unnecessary because the work is in-process, but `--js-runtimes deno:%s` (`:3436`) still launches a subprocess on the resolve path, so the premise is false. Cancellation is also polled only from yt-dlp's progress hooks, which do not fire until bytes flow, so a cancel during resolve is not seen.

> **Deliberate-behaviour note:** the absent watchdog is intentional (`downloads.py:3450-3452` argues it, and commit `4262824` "report a stall as what was observed, not a guessed cause" removed guessed causes). Re-adding one must not reintroduce false-positive kills: arm it on **resolve-phase silence only**, never on a slow download, and keep the timeout generous.

**Files:**
- Modify: `media-catcher-host/mchost/downloads.py` — `_handle_ytdl_legacy` worker preamble; `_ytdl_download_via_lib` watchdog.
- Test: `media-catcher-host/test_ytdl_protocol.py`.

- [ ] **Step 1: Write the failing test**

Append to `media-catcher-host/test_ytdl_protocol.py`:

```python
def test_youtube_job_is_acknowledged_before_the_slow_preflight(tmp_path, monkeypatch):
    """ensure_deno() and start_pot_provider() can take minutes. The row must be
    host-acknowledged first, or it is indistinguishable from a dead helper."""
    import mchost.downloads as d

    order = []
    monkeypatch.setattr(mc, "send",
                        lambda m: order.append(("send", m.get("type"), m.get("stage"))))
    monkeypatch.setattr(d, "_h", lambda: mc)
    monkeypatch.setattr(d, "ensure_deno",
                        lambda: order.append(("ensure_deno", None, None)))
    monkeypatch.setattr(d, "start_pot_provider",
                        lambda: order.append(("start_pot", None, None)))
    monkeypatch.setattr(d, "_ytdl_download_via_lib",
                        lambda *a, **k: order.append(("download", None, None)))
    monkeypatch.setattr(d, "_ytdlp_lib",
                        lambda: type("L", (), {"available": staticmethod(lambda: True)})())

    d._handle_ytdl_legacy({"id": "j1", "url": "https://youtu.be/x", "dir": str(tmp_path)})
    d._join_ytdl_workers_for_test()

    assert order[0] == ("send", "ytdl-progress", "resolving"), order
    assert ("ensure_deno", None, None) in order
    assert order.index(("send", "ytdl-progress", "resolving")) < order.index(("ensure_deno", None, None))
```

`_handle_ytdl_legacy` launches its worker with `threading.Thread(target=worker, daemon=True).start()` at `downloads.py:3637` and keeps no reference, so the test needs a join seam. Add one rather than sleeping in the test — a `time.sleep` here would be flaky under load. Beside the other module-level state:

```python
# Test seam: _handle_ytdl_legacy's worker is a daemon thread with no handle, so
# a test has no way to await it without sleeping.
_YTDL_WORKERS = []


def _join_ytdl_workers_for_test(timeout=5.0):
    for t in list(_YTDL_WORKERS):
        t.join(timeout)
    _YTDL_WORKERS.clear()
```

and change `:3637` to keep the handle:

```python
    t = threading.Thread(target=worker, daemon=True)
    _YTDL_WORKERS.append(t)
    t.start()
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
python -m pytest test_ytdl_protocol.py -k acknowledged_before -q
```

Expected: FAIL — `order[0]` is `("ensure_deno", None, None)`, not the progress frame.

- [ ] **Step 3: Send the frame first**

In `_handle_ytdl_legacy`'s `worker()`, move the acknowledgement to the top. The first three lines become:

```python
    def worker():
        jid = req.get("id")
        url = req.get("url") or ""
        # Acknowledge before the preflight: ensure_deno() can download a JS runtime
        # and start_pot_provider() waits on a socket bind, and until one of these
        # frames lands the row is indistinguishable from a dead helper.
        _h().send({"type": "ytdl-progress", "id": jid, "pct": 0, "stage": "resolving",
                   "note": "Preparing"})
        deno = ensure_deno()   # yt-dlp needs a JS runtime to solve YouTube's 'n' challenge
```

Then delete the now-duplicate frame further down the exe branch (the `_h().send({... "note": "Preparing"})` line that follows `_h()._hlog("info", "yt-dlp: downloading %s (pot=%s)" ...)`), and the identical one at the top of `_ytdl_download_via_lib`. Keep exactly one acknowledgement per job.

- [ ] **Step 4: Add the resolve-phase watchdog**

In `_ytdl_download_via_lib`, above `try:`, add:

```python
    # Resolve-phase liveness only. Bytes flowing means yt-dlp's hooks are firing,
    # and a slow download must never be killed - the watchdog disarms on the first
    # progress callback. It exists because --js-runtimes still launches deno on the
    # resolve path, so "in-process" does not make this phase unstallable.
    resolved = threading.Event()
    def _resolve_watchdog():
        if resolved.wait(_YTDL_RESOLVE_STALL):
            return
        op["cancel_requested"] = True
        _h()._hlog("error", "yt-dlp: no resolve progress in %ss; cancelling"
                   % _YTDL_RESOLVE_STALL, "ytdlp")
        _h().send({"type": "ytdl-error", "id": jid, "reason": "stalled",
                   "error": "yt-dlp made no progress while resolving. "
                            "Open the log console for its output."})
    threading.Thread(target=_resolve_watchdog, daemon=True).start()
```

Set `resolved.set()` as the first statement of both `on_progress` and `on_note`, and again in the `finally:` block so the thread always exits.

**Reuse the existing constant — do not define a new one.** `_YTDL_RESOLVE_STALL = 90` already exists at `downloads.py:2776` and is what the exe path's `_StallWatch` uses. Using the same value keeps the two paths reporting the same `reason: "stalled"` after the same silence, which is the point of the task.

- [ ] **Step 5: Make cancel visible during resolve**

In `media-catcher-host/mchost/ytdlp_lib.py`, `download()`'s `_sink` (lines 200-206) is called for every yt-dlp log line, including `[youtube] Downloading webpage` during resolve. Add the cancel poll there so a cancel is seen before bytes flow:

```python
        if should_cancel is not None and should_cancel():
            raise Cancelled()
```

as the first statement of `_sink`.

- [ ] **Step 6: Run the tests**

```bash
python -m pytest test_ytdl_protocol.py test_ytdlp_lib.py -q
```

Expected: PASS.

```bash
python -m pytest -q
```

Expected: 330 passed (329 after Task 3, + 1 new).

- [ ] **Step 7: Commit**

Subject: `fix: acknowledge a YouTube job before the preflight, and bound a silent resolve`

Body: the first progress frame was sent after ensure_deno() and start_pot_provider(), so a row could sit on the extension's "Preparing" for the whole preflight with nothing from the helper. The frame now goes first. The in-process resolve also had no deadline and polled cancel only from progress hooks that do not fire until bytes flow; a watchdog now bounds resolve-phase silence only, disarming on the first callback, and the log sink polls cancel. Close with the `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` trailer.

---

## Task 5: Drive the controller clock

**What this fixes:** a latent defect, not either reported symptom — but it is what makes Tasks 6 and 8 possible.

**Mechanism:** `controller.tick(nowMs)` is built (`background-adapters.js:3190`, frozen on at `:3270`) and drives both `finalizer.tick(nowMs)` (`:3195`) and `scheduler.tick(nowMs)` (`:3197`). `grep -rn "\.tick(" media-catcher --include=*.js` returns 60 hits: exactly two in production, and both are *inside* `function tick(nowMs)` itself. The other 58 are all under `media-catcher/tests/`. Nothing in production ever calls it. So `job.retryDeadlineMs`, read only inside `scheduler.tick` (`download-scheduler.js:2374-2380`), never expires, and neither do the detection finalizer's deadlines.

**Correction to the original claim:** `retry_backoff` is not an absolute dead end — `cancel()` terminalizes such a job (`download-scheduler.js:2460-2467`) and `requestFirefoxHandoff` accepts it as eligible (`:3086`). What is genuinely absent is *automatic* expiry.

**Placement:** `manifest.json:44-49` declares a `background.scripts` block with `"persistent": true` — an MV2 persistent background page, so a plain interval survives and no `alarms` permission is needed (`alarms` is **not** in the permission list at `manifest.json:14-22`; adding it would widen the store listing for no gain). `initializeLiveController()` (`background.js:116-152`) runs from a promise chain (`background.js:58`), not at script evaluation.

**Files:**
- Modify: `media-catcher/background.js` — two declarations beside `liveController` (`:41-42`); one block before `return liveController;` (`:151`).
- Modify: `media-catcher/tests/background-live-bootstrap.test.js` — harness only (Step 1).
- Test: `media-catcher/tests/background-live-bootstrap.test.js`.

**Note on style:** `background.js` uses modern JS (`const`, `let`, arrow functions). Only `media-catcher/lib/**` is ES5-style.

**Note on the harness:** the stub controller (`tests/background-live-bootstrap.test.js:69-79`) defines only `handleNativeMessage` and `helperDisconnected`. A clock calling `liveController.tick(...)` hits `undefined` there, so Step 1 adds it. This is also why the production `try/catch` in Step 4 is load-bearing.

- [ ] **Step 1: Extend the test harness**

Three edits inside `createHarness()` in `media-catcher/tests/background-live-bootstrap.test.js`.

(a) Beside `const assemblerCreates = [];` (`:67`):

```js
  const ticks = [];
  const timers = [];
  let tickError = null;
```

(b) Add `tick` to the stub controller object (`:69-79`), after `helperDisconnected`:

```js
    tick(nowMs) {
      ticks.push(nowMs);
      if (tickError) throw tickError;
    },
```

(c) Replace the sandbox's timer stubs at `:176-177`:

```js
    setTimeout() { return 1; },
    clearTimeout() {},
```

with recording versions — they still never fire on their own, so no existing test changes behaviour:

```js
    setTimeout(fn, ms) { timers.push({ kind: "timeout", fn, ms }); return timers.length; },
    clearTimeout() {},
    setInterval(fn, ms) { timers.push({ kind: "interval", fn, ms }); return timers.length; },
    clearInterval() {},
```

(d) Add to the returned object (`:208-222`), beside `sandbox,`:

```js
    ticks,
    timers,
    setTickError(err) { tickError = err; },
```

- [ ] **Step 2: Write the failing test**

Append to the same file:

```js
test("the live controller is driven by a clock", async () => {
  const h = createHarness();
  h.load();
  h.settingsLoad.resolve({ settings: {} });
  await settle();

  const clock = h.timers.find((t) => t.kind === "interval" && t.ms === 1000);
  assert.ok(clock, "expected a 1s interval driving the controller");

  const before = h.ticks.length;
  clock.fn();
  assert.equal(h.ticks.length, before + 1);
  assert.equal(typeof h.ticks[h.ticks.length - 1], "number");

  // A throwing tick must not stop the clock, or every later expiry goes unobserved.
  h.setTickError(new Error("boom"));
  assert.doesNotThrow(() => clock.fn());
  h.setTickError(null);
  const afterThrow = h.ticks.length;
  clock.fn();
  assert.equal(h.ticks.length, afterThrow + 1);
});
```

- [ ] **Step 3: Run it to make sure it fails**

From `media-catcher/`:

```bash
node --test --test-name-pattern="driven by a clock" "tests/background-live-bootstrap.test.js"
```

Expected: FAIL on the `assert.ok(clock, ...)` — no interval is ever registered.

- [ ] **Step 4: Install the clock**

In `media-catcher/background.js`, beside `let liveControllerInitialized = false;` (`:42`):

```js
// The controller's tick drives retry_backoff expiry and the detection finalizer's
// deadlines. Nothing else calls it, so without this clock those states never expire.
// MV2 persistent background page (manifest "persistent": true), so a plain interval
// survives; guarded because not every test sandbox defines one.
const LIVE_TICK_MS = 1000;
let liveTickTimer = null;
```

Immediately before `return liveController;` at the end of `initializeLiveController()`:

```js
  if (liveTickTimer === null && typeof setInterval === "function") {
    liveTickTimer = setInterval(() => {
      try {
        liveController.tick(Date.now());
      } catch (err) {
        mclog("warn", "tick: " + String((err && err.message) || err));
      }
    }, LIVE_TICK_MS);
  }
```

- [ ] **Step 5: Run the tests**

```bash
node --test --test-name-pattern="driven by a clock" "tests/background-live-bootstrap.test.js"
```

Expected: PASS.

```bash
node --test "tests/*.test.js"
```

Expected: 748 pass, 0 fail.

- [ ] **Step 6: Commit**

Subject: `feat: drive the controller clock so timed states can expire`

Body: controller.tick() was built and frozen onto the controller but never called outside tests, so retry_backoff never expired automatically and the detection finalizer's deadlines never fired. A 1s interval on the persistent background page now drives it, guarded so a throwing tick cannot stop the clock. No new manifest permission: the page is persistent, so alarms is unnecessary. Close with the `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` trailer.

---

## Task 6: Heartbeat the native helper

**Mechanism:** the only automatic ping is the one-shot at connect — `nativePort.postMessage({ cmd: "ping" });` (`background.js:448`). A grep for ping sites across `media-catcher/**/*.js` returns exactly `background.js:448` and `background.js:2838` (the user-triggered `recheck-helper`), plus three test hits. There is no interval, no `alarms`, and no pong bookkeeping (`grep -rnE 'pendingPing|lastPong|pongAt' --include=*.js media-catcher/` exits 1). A helper that is alive but silent is therefore indistinguishable from a healthy slow one, indefinitely.

**Design note:** ping on a fixed interval rather than on measured pong staleness. Staleness needs a controllable clock, and `background.js` state is declared with `let`, which does not land on the vm global — so a staleness design would not be drivable from the existing harness without a new seam. A fixed interval is equally sufficient for the goal and is directly testable.

**Files:**
- Modify: `media-catcher/background.js` — arm an interval from the pong handler (`:547-552`); clear it on disconnect.
- Test: `media-catcher/tests/background-live-bootstrap.test.js`.

**Interfaces:**
- Consumes: the recording `setInterval` added to the harness in Task 5, Step 1.

- [ ] **Step 1: Write the failing test**

```js
test("a connected helper keeps being pinged, not only at connect", async () => {
  const h = createHarness();
  h.load();
  h.settingsLoad.resolve({ settings: {} });
  await settle();
  h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
  await settle();

  const pings = () => h.nativePosts.filter((p) => p && p.cmd === "ping").length;
  const before = pings();

  const beat = h.timers.find((t) => t.kind === "interval" && t.ms === 30000);
  assert.ok(beat, "expected a heartbeat interval after the handshake");
  beat.fn();
  assert.equal(pings(), before + 1, "the heartbeat must ping a connected helper");
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
node --test --test-name-pattern="keeps being pinged" "tests/background-live-bootstrap.test.js"
```

Expected: FAIL on `assert.ok(beat, ...)` — no heartbeat interval exists.

- [ ] **Step 3: Arm the heartbeat**

Beside the Task 5 declarations in `background.js`:

```js
// A helper that is alive but silent looks exactly like a healthy slow one:
// ping/pong happened once at connect and never again. Keep asking.
const HELPER_PING_MS = 30000;
let helperPingTimer = null;
```

In the `pong` handler (`background.js:547-552`), after the existing body:

```js
    if (helperPingTimer === null && typeof setInterval === "function") {
      helperPingTimer = setInterval(() => {
        if (!nativePort) return;
        try {
          nativePort.postMessage({ cmd: "ping" });
        } catch (err) {
          mclog("warn", "heartbeat: " + String((err && err.message) || err));
        }
      }, HELPER_PING_MS);
    }
```

In the `onDisconnect` handler, beside the existing teardown:

```js
  if (helperPingTimer !== null) {
    clearInterval(helperPingTimer);
    helperPingTimer = null;
  }
```

Clearing on disconnect matters: without it the heartbeat keeps firing against a dead port and every beat logs a warning.

- [ ] **Step 4: Run the tests**

```bash
node --test "tests/*.test.js"
```

Expected: 749 pass, 0 fail. Two existing tests count pings — `a dropped helper port re-dials once…` (`:304`) and `a re-dial that also drops settles…` (`:324`). Neither drives a timer, so neither should see a heartbeat ping. If either count moves, the heartbeat is being armed somewhere other than the pong handler.

- [ ] **Step 5: Commit**

Subject: `feat: heartbeat the helper so a silent one is distinguishable from a slow one`

Body: ping/pong happened once at connect and never again, so a helper that was alive but silent was indistinguishable from a healthy slow one indefinitely. A 30s heartbeat is armed on handshake and cleared on disconnect. Close with the `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` trailer.

---

## Task 7: Bound the helper re-dial with backoff

> **DECISION REQUIRED BEFORE PATCHING.** This task reverses an explicitly asserted, explicitly commented invariant. `tests/background-live-bootstrap.test.js:324` is named `"a re-dial that also drops settles instead of looping"` and asserts `"only one automatic re-dial per connected session"`; the comment above `background.js:330-335` says `redialled` exists so that "a helper that is truly gone" cannot spin. The author chose settle-over-spin deliberately. Backoff is the standard answer to that trade-off — bounded attempts with growing waits, not an unbounded loop — but it *is* a reversal, and it should be an explicit call rather than a silent patch. **If in doubt, skip this task:** `recheck-helper` already gives the user a working manual recovery (`background.js:2839`), so this is convenience, not correctness.

**Mechanism:** `background.js:429-430` permits exactly one automatic re-dial per successful handshake:

```js
  if (nativeHandshook && !nativeRedialled) {
    nativeRedialled = true;
```

If that re-dial also fails, nothing retries and nothing backs off. `grep 'nativeRedialled'` returns exactly four hits (`:335`, `:429`, `:430`, `:552`).

**Correction to the original claim:** "until Firefox restarts" is **false**. `recheck-helper` reconnects a null port (`:2839` `else connectNative();`) and a later pong re-arms the budget (`:552`). Recovery exists; it is user-triggered. This task adds *automatic* recovery.

**Files:**
- Modify: `media-catcher/background.js`.
- Test: `media-catcher/tests/background-live-bootstrap.test.js` — one new test, two existing tests rewritten.

- [ ] **Step 1: Write the failing test**

```js
test("a re-dial that also drops backs off instead of giving up", async () => {
  const h = createHarness();
  h.load();
  h.settingsLoad.resolve({ settings: {} });
  await settle();
  h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
  await settle();

  const pings = () => h.nativePosts.filter((p) => p && p.cmd === "ping").length;
  const waits = () => h.timers.filter((t) => t.kind === "timeout" && t.ms >= 1000);

  const before = pings();
  h.nativeDisconnects.emit();
  await settle();

  const first = waits();
  assert.equal(first.length, 1, "the drop must schedule one re-dial");
  assert.equal(first[0].ms, 1000);
  assert.equal(pings(), before, "the re-dial must be scheduled, not immediate");

  first[0].fn();
  await settle();
  assert.equal(pings(), before + 1, "firing the timer re-dials");

  h.nativeDisconnects.emit();
  await settle();
  const second = waits();
  assert.equal(second.length, 2, "the second drop must schedule another re-dial");
  assert.ok(second[1].ms > first[0].ms, "the second wait must be longer");
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
node --test --test-name-pattern="backs off instead of giving up" "tests/background-live-bootstrap.test.js"
```

Expected: FAIL — the re-dial is immediate, so `pings()` is already `before + 1` and no timeout is scheduled.

- [ ] **Step 3: Replace the one-shot budget**

Beside the other native declarations in `background.js` (`:334-335`):

```js
// A single immediate re-dial covered a helper replaced by an update, but not one
// that is slow to come back. A bounded backoff replaces it: four growing waits,
// then stop. A pong or an explicit recheck-helper resets the budget.
const HELPER_REDIAL_MS = [1000, 4000, 15000, 60000];
let nativeRedialAttempt = 0;
let nativeRedialTimer = null;
```

Replace the `:429-432` block:

```js
  if (nativeHandshook && !nativeRedialled) {
    nativeRedialled = true;
    connectNative();
```

with:

```js
  if (nativeHandshook && nativeRedialAttempt < HELPER_REDIAL_MS.length) {
    const wait = HELPER_REDIAL_MS[nativeRedialAttempt];
    nativeRedialAttempt += 1;
    if (nativeRedialTimer !== null) clearTimeout(nativeRedialTimer);
    nativeRedialTimer = setTimeout(() => {
      nativeRedialTimer = null;
      connectNative();
    }, wait);
```

In the `pong` handler, replace `nativeRedialled = false;` (`:552`) with `nativeRedialAttempt = 0;`. In the `recheck-helper` handler (`:2838-2839`), add `nativeRedialAttempt = 0;` before reconnecting, so a user recheck always gets a fresh budget.

Delete the now-unused `nativeRedialled` declaration at `:335`. Verify: `grep -n nativeRedialled media-catcher/background.js` must return nothing.

- [ ] **Step 4: Rewrite the two tests that lock the old behaviour**

`"a dropped helper port re-dials once instead of reporting it uninstalled"` (`:304`): the re-dial is now scheduled rather than immediate. Rename it to `"a dropped helper port re-dials instead of reporting it uninstalled"` and drive the timer before asserting:

```js
  h.nativeDisconnects.emit();
  await settle();
  h.timers.filter((t) => t.kind === "timeout" && t.ms >= 1000).forEach((t) => t.fn());
  await settle();

  assert.equal(pings(), before + 1, "the drop must trigger a re-dial");
```

Leave its `helper-status` assertion unchanged.

`"a re-dial that also drops settles instead of looping"` (`:324`): this test's premise is what the task reverses. Replace it with a bound test:

```js
test("automatic re-dials are bounded rather than unbounded", async () => {
  const h = createHarness();
  h.load();
  h.settingsLoad.resolve({ settings: {} });
  await settle();
  h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
  await settle();

  const waits = () => h.timers.filter((t) => t.kind === "timeout" && t.ms >= 1000);
  for (let i = 0; i < 6; i += 1) {
    h.nativeDisconnects.emit();
    await settle();
    waits().slice(-1).forEach((t) => t.fn());
    await settle();
  }
  assert.equal(waits().length, 4, "a helper that is truly gone must stop being re-dialled");
});
```

- [ ] **Step 5: Run the tests**

```bash
node --test "tests/*.test.js"
```

Expected: 750 pass, 0 fail. `background-live-bootstrap.test.js:290` asserts an accumulated `onDisconnect` listener count; a delayed re-dial changes *when* listeners accumulate. If that assertion fails, drive the scheduled timer in that test rather than loosening the number.

- [ ] **Step 6: Commit**

Subject: `feat: retry a failed helper re-dial with backoff instead of once`

Body: one automatic re-dial per handshake covered a helper replaced by an update but not one slow to come back; after that, recovery was entirely user-triggered through recheck-helper. Four growing waits replace the one-shot budget, reset by a pong or an explicit recheck, and still bounded so a helper that is truly gone does not spin. Close with the `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` trailer.

---

## Task 8: Bound the `pausing_provider` drain

> **HIGHEST-RISK TASK. Land it alone, after everything else is green.** Every other task is additive or reverses a narrow assertion; this one can terminate a job that is legitimately draining. It is also the only task addressing a purely latent defect — no user has reported it.

**Mechanism:** `download-scheduler.js:173` states the invariant in the tree's own words — `pausing_provider is the only non-running state that may hold a slot.` Nothing bounds how long a job stays there; the only exit is `isQuiescent`. A lost or never-delivered owner terminal wedges that job and, at low `maxConcurrent`, starves its siblings.

**Correction to the original claim:** the "woken only when `completeOwner` advances `wakeGeneration`" half is **false** — `download-scheduler.js:677-681` authorizes a wake whenever provider state is `normal`. Only the unbounded slot-holding half stands.

**Verified anchors.** The first survey's line numbers for this area were wrong in fourteen places; these are the corrected ones: `reducedCapFrom` module scope `:154`; `createDownloadScheduler` closure opens `:191`; `projectJob` `:323-345`; `clearDrainingState` `:348-353`; `invalidateLocalActivities` `:360`; `confirmNativeOpenZero` `:373`; `settleDrainingTerminal` `:814` (guard `:815`); `notePermitAcquired` `:1849` (`if (job.observedPermits > 0)` at `:1863`); `tick` `:2368-2402`; `onTransportUnavailable` `:2612`.

**The design constraint that makes this hard.** A wedged job still holds provider permits — `notePermitAcquired` was called and `releasePermit` never arrived. `onTransportUnavailable` checks `!isQuiescent(job)` and takes the `holdUnavailableUntilPermitsDrain(job)` branch, which **keeps** the slot. So calling `onTransportUnavailable` from the deadline would not release anything. The deadline handler must first force quiescence — the entire premise is that the ack will never arrive — and only then settle. Reuse the existing pieces in this order: `invalidateLocalActivities(job)` (`:360`), zero the observed permits, `clearDrainingState(job)` (`:348`), `enterNeedsUser(job)`, `drain()`. That is exactly the tail `onTransportUnavailable` runs for a quiescent job.

**Blast radius to read before writing code:** the scheduler tests drive very large clock values — `scheduler-retry-cancel.test.js:79`, `:947`, `:1249` (`s2.tick(999999)`) — and `background-adapters.test.js` drives the real scheduler through `controller.tick` at fourteen sites (`:810`, `:812`, `:899`, `:1298`, `:1400`, `:1537`, `:1597`, `:2454`, `:2522`, `:2547`, `:8682`, `:8716`, `:8752`, `:8862`). Any deadline shorter than those jumps trips inside existing tests.

**Files:**
- Modify: `media-catcher/lib/download-scheduler.js` (ES5 style: `var`, `function`).
- Test: `media-catcher/tests/scheduler-provider.test.js`.

- [ ] **Step 1: Write the failing test**

Append to `media-catcher/tests/scheduler-provider.test.js` — the setup mirrors the existing `"pausing_provider retains slot until drain then releases once"` (`:212`) up to the point where that test delivers the terminal, and then simply never delivers it:

```js
test("a pausing_provider drain that never quiesces gives up its slot", () => {
  let now = 0;
  const s = createDownloadScheduler({ maxConcurrent: 2, now: () => now });
  s.createJob({
    id: "owner",
    providerKey: "p.com",
    intent: intent("o.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.createJob({
    id: "sib",
    providerKey: "p.com",
    intent: intent("s.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.enqueue("owner");
  s.enqueue("sib");
  s.notePermitAcquired("owner");
  s.notePermitAcquired("sib");
  s.onTransportResult("sib", s.getJob("sib").attemptToken, {
    status: "failed",
    failureCategory: "short_read",
  });
  assert.equal(s.getJob("sib").state, "pausing_provider");
  assert.equal(s.getJob("sib").holdsGlobalSlot, true);

  // The owner terminal never arrives: no releasePermit, no onQuiesced, ever.
  now = 120001;
  s.tick(now);

  assert.notEqual(s.getJob("sib").state, "pausing_provider");
  assert.equal(s.getJob("sib").holdsGlobalSlot, false);
  assert.equal(s.getSnapshot().globalRunning, 1);
  assertSlotInvariant(s);
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
node --test --test-name-pattern="never quiesces" "tests/scheduler-provider.test.js"
```

Expected: FAIL — `sib` is still `pausing_provider` and still holds its slot.

- [ ] **Step 3: Add the deadline field**

At module scope beside `reducedCapFrom` (`:154`), in ES5 style:

```js
  // A drain that never quiesces holds the only non-running slot forever. Generous:
  // this bounds a lost owner terminal, not an ordinary slow pause.
  var PAUSE_DRAIN_DEADLINE_MS = 120000;
```

Set `job.pauseDeadlineMs = now() + PAUSE_DRAIN_DEADLINE_MS;` wherever a job enters `pausing_provider`, and clear it (`job.pauseDeadlineMs = null;`) in `clearDrainingState` (`:348-353`). Do **not** add it to `projectJob` (`:323-345`) — that is the extension-facing projection and adding a field changes the published wire shape.

- [ ] **Step 4: Expire it from `tick`**

Inside `tick` (`:2368-2402`), alongside the existing `retryDeadlineMs` handling, add a branch for a job in `pausing_provider` whose `pauseDeadlineMs` has passed. It must force quiescence before settling, in the order given under "The design constraint that makes this hard" above — `invalidateLocalActivities`, zero observed permits, `clearDrainingState`, `enterNeedsUser`, `drain`. Do not call `onTransportUnavailable`: it will take the hold branch and keep the slot.

- [ ] **Step 5: Run the tests and reconcile**

```bash
node --test "tests/*.test.js"
```

Expected: 751 pass, 0 fail. If a test with a large `tick` value now trips the deadline, set `pauseDeadlineMs` from the injected `now()` the test drives rather than raising the constant until failures stop. **If reconciliation gets ugly, stop and report.** A bound that fights the suite is a signal the design needs another look, and this defect is latent — shipping the other eight tasks without this one is a good outcome.

- [ ] **Step 6: Commit**

Subject: `fix: bound a pausing_provider drain so a lost owner terminal cannot hold the slot`

Body: pausing_provider is the only non-running state that may hold a concurrency slot, and nothing bounded how long a job could stay there, so a lost owner terminal wedged that job and starved its siblings. A deadline now forces quiescence and settles the job, because the premise of the deadline is that the ack will never arrive. Close with the `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` trailer.

---

## Task 9: Lock the "never auto-apply an antivirus exclusion" contract

**This task changes no behaviour.** The review asked whether the Settings probe should apply the exclusion it names. The answer, verified three independent ways, is no — and the reason deserves a test rather than only a comment.

**What is already true at HEAD:**
- `probe.py:112-113` states the intent: `# Reported, never applied: it needs admin regardless, and a diagnostics` / `# button that silently punches AV holes is shaped exactly like malware.`
- `grep -rnE "Add-MpPreference|ExclusionPath|apply_fix|applyFix" --include=*.py --include=*.js --include=*.ps1 .` returns exactly four hits (`probe.py:64`, `probe.py:245`, `test_probe.py:70`, `test_probe.py:231`) — all string composition, **no execution site**.
- `grep -rniE "runas|ShellExecute|Start-Process -Verb" media-catcher-host/` returns nothing — there is no elevation primitive to build an apply path on.
- The command **is** surfaced to the user as copyable text; it is not silently dropped.

**One real loose end:** `grep -rn "fixable" media-catcher/` returns **zero hits**. The extension never reads the field.

**Files:**
- Test: `media-catcher-host/test_probe.py`.
- Modify: `media-catcher-host/mchost/probe.py` — comment only.

- [ ] **Step 1: Write the contract test**

Append to `media-catcher-host/test_probe.py`:

```python
def test_no_probe_check_ever_offers_to_apply_an_av_exclusion():
    """Deliberate, not unimplemented: applying an exclusion needs admin the host
    never has, and a diagnostics button that silently punches AV holes is shaped
    exactly like malware. The command is reported for the user to run themselves."""
    import inspect

    # `probe` is already imported at module scope in this file.
    src = inspect.getsource(probe)
    assert "Add-MpPreference" in src, "the command should still be composed and shown"
    for forbidden in ("Start-Process -Verb runAs", "ShellExecute", "runas"):
        assert forbidden not in src, "the exclusion must never be executed by the host"
    av = probe._verdict("av", "Antivirus", "warn", "detail",
                        fix=probe.exclusion_command("C:\\\\x"), fixable=False)
    assert av["fixable"] is False
    assert "Add-MpPreference" in av["fix"], "the user still gets the command to run"
```

- [ ] **Step 2: Run it**

From `media-catcher-host/`:

```bash
python -m pytest test_probe.py -k never_offers -q
```

Expected: PASS immediately. This is a ratchet, not a red-green cycle — it exists so that a future change adding an apply path fails loudly.

- [ ] **Step 3: Note the dead field**

Above the `fixable` parameter in `_verdict` (`probe.py:51-54`):

```python
    # `fixable` is host-side bookkeeping: no extension code reads it
    # (grep "fixable" over media-catcher/ returns nothing). Kept so a future
    # check that IS safely fixable has somewhere to say so.
```

- [ ] **Step 4: Run the suite and commit**

```bash
python -m pytest -q
```

Subject: `test: lock the contract that the probe never applies an AV exclusion`

Body: the review asked whether the probe should apply the exclusion it names. It should not — it needs admin the host never has, and a diagnostics button that silently punches AV holes is shaped like malware — so the reason is now a test rather than only a comment. Close with the `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` trailer.

---

## Task 10: Make installer signing possible without changing the default build

**What is true at HEAD:** `installer/media-catcher-host.iss:24` sets `PrivilegesRequired=lowest` and neither the `.iss` nor `build.ps1` contains any `SignTool` directive, so the shipped setup.exe is unsigned.

**Keep `PrivilegesRequired=lowest`.** It is correct: the installer writes to `{localappdata}\MediaCatcher\Host` and registers the native host under HKCU. Requiring admin would be a regression — and it is also why Task 9's answer is the right one. Record the reasoning so it is not "fixed" later.

**Signing needs a certificate this repository does not and should not contain.** Add the hook; leave it inert by default.

**Files:**
- Modify: `media-catcher-host/installer/build.ps1`, `media-catcher-host/installer/media-catcher-host.iss`, `media-catcher-host/installer/README.md`.

- [ ] **Step 1: Add an opt-in signing step to `build.ps1`**

After the successful-compile block at the end of `build.ps1`:

```powershell
# Optional code signing. Unsigned by default: no certificate belongs in this repo.
# Set MC_SIGN_PFX (path) and MC_SIGN_PASS to produce a signed setup.exe.
if ($env:MC_SIGN_PFX) {
  if (-not (Test-Path $env:MC_SIGN_PFX)) { throw "MC_SIGN_PFX is set but $($env:MC_SIGN_PFX) does not exist." }
  $signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if (-not $signtool) { throw "MC_SIGN_PFX is set but signtool.exe is not on PATH (install the Windows SDK)." }
  & $signtool.Source sign /fd SHA256 /f $env:MC_SIGN_PFX /p $env:MC_SIGN_PASS `
      /tr http://timestamp.digicert.com /td SHA256 $out
  if ($LASTEXITCODE -ne 0) { throw "signtool failed (exit $LASTEXITCODE)." }
  Write-Host "Signed: $out" -ForegroundColor Green
} else {
  Write-Host "Unsigned build (set MC_SIGN_PFX to sign)." -ForegroundColor Yellow
}
```

Failing loudly when `MC_SIGN_PFX` is set but unusable is deliberate — a silently-unsigned release is the failure mode worth preventing.

- [ ] **Step 2: Record why privileges stay lowest**

Above `PrivilegesRequired=lowest` in `media-catcher-host.iss`:

```
; Per-user by design: everything lands in {localappdata} and the native host is
; registered under HKCU, so no admin is needed. This is also why the Settings
; probe reports an antivirus exclusion for the user to apply rather than applying
; it itself - the installer never has the rights to, and should not ask for them.
```

- [ ] **Step 3: Document the signing switch**

Add to `installer/README.md`, under the build instructions:

```markdown
### Signing (optional)

Builds are unsigned by default; no certificate belongs in this repository. To sign:

    $env:MC_SIGN_PFX = "C:\path\to\cert.pfx"
    $env:MC_SIGN_PASS = "..."
    powershell -ExecutionPolicy Bypass -File build.ps1

Requires `signtool.exe` on PATH (Windows SDK). The build fails rather than
producing a silently-unsigned installer if the certificate cannot be used.
```

- [ ] **Step 4: Verify the script still parses**

From `media-catcher-host/installer/`:

```bash
powershell -NoProfile -Command "[void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path ./build.ps1), [ref]$null, [ref]$null); 'parsed ok'"
```

Expected: `parsed ok`. Do not run a full `build.ps1` unless Inno Setup is already installed — it installs it via winget otherwise.

- [ ] **Step 5: Commit**

Subject: `feat: allow an opt-in signed installer build, unsigned by default`

Body: the setup.exe had no signing path at all. build.ps1 now signs when MC_SIGN_PFX is set and fails loudly if it is set but unusable, so a release cannot go out silently unsigned. PrivilegesRequired stays lowest, with the reasoning recorded next to it. Close with the `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` trailer.

---

## Task 11: Ignore the yt-dlp library directory

**Mechanism:** `.gitignore` ignores `media-catcher-host/pylibs/` — that is **pyatv's** directory (`mchost/cast/legacy.py:579` `_PYLIBS = os.path.join(HERE, "pylibs")`). The yt-dlp library lives at `HERE/pylib`, singular (`mchost/ytdlp_lib.py:36`, `installer/bootstrap.ps1:189`), and is not ignored. A developer who bootstraps in place gets roughly a thousand untracked files.

**Do not rename the existing entry** — both directories are real and both need ignoring.

**Files:**
- Modify: `.gitignore`.

- [ ] **Step 1: Add the entry**

Beside `media-catcher-host/pylibs/` in `.gitignore`:

```
media-catcher-host/pylib/
```

- [ ] **Step 2: Verify both are covered**

```bash
git check-ignore -v media-catcher-host/pylib/yt_dlp/__init__.py media-catcher-host/pylibs/pyatv/__init__.py
```

Expected: two lines, one per path, each naming its `.gitignore` rule.

- [ ] **Step 3: Commit**

Subject: `fix: ignore the yt-dlp library directory alongside pyatv's`

Body: pylibs/ (pyatv) was ignored but pylib/ (yt-dlp, installed by bootstrap) was not, so bootstrapping in place left roughly a thousand untracked files. Close with the `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` trailer.

---

## Verification before calling this done

Run both suites from a clean tree and report what you ran:

```bash
node --test "tests/*.test.js"
```

from `media-catcher/` — expect **751 pass, 0 fail** (746 baseline, +1 Task 1, +1 Task 5, +1 Task 6, +1 Task 8; Task 7 adds one and replaces one, net +1).

```bash
python -m pytest -q
```

from `media-catcher-host/` — expect **331 passed** (326 baseline, +2 Task 2, +1 Task 3, +1 Task 4, +1 Task 9).

Neither suite runs in CI — `.github/workflows/release.yml:24-26` runs only `python -m py_compile media-catcher-host/mc_host.py` and `python media-catcher-host/test_guardian.py` — so these commands are the only gate.

**Not covered by tests, deliberately:** Tasks 3 and 10 change installer PowerShell that only runs on a user's machine. Their tests assert the *script text*, not its effect. Before shipping either, run the real installer once on a clean profile and confirm `%LOCALAPPDATA%\MediaCatcher\Host` contains `yt-dlp.exe` **beside `_internal\`**, and that `%TEMP%` gains no `_MEI*` directory after a YouTube download.

## Known-latent, explicitly out of scope

- `_handle_ytdl_structured` (`downloads.py:3072`) never consults `_ytdlp_lib().available()` the way the legacy path does at `:3528`, so the token-fenced path is exe-only even with the library installed. It is currently unreachable — `background.js:401` is the only `ytdl` sender and omits `attemptToken`. Teaching it the library path means teaching it the Windows handle/staging protocol at `downloads.py:3040-3110`, a far larger change than anything here.
- `singleStartedAttempts` (`background-adapters.js:1416`) has the same never-pruned shape as `startedAttempts` — `has`/`add`, no `delete`. Task 1 does not touch it: unbounded growth there is hygiene, not a wedge, because it does not gate a slot.
- Track 2 of the original plan (cut helper exe spawns) was dropped on evidence. The remaining ordinary-path spawns are `deno` ×1 and `ffmpeg` ×1, both functionally required; the in-process yt-dlp change already captured the available win.
