# HLS/DASH Assembly to Native File Sink

> Bounded implementation slice for the approved Save As / provider-aware queue design.

**Goal:** Run authenticated browser-side HLS/DASH assembly under scheduler ownership and save the assembled bytes through the native file-sink protocol. Do not use `browser.downloads`, do not auto-invoke Firefox, and do not expose media URLs, headers, destination paths, or sink identities through public projections.

**Containment:** All worktrees, reports, plans, and artifacts for this slice stay under `C:\Code\mCatcher`. Quarantined BA07/BA08 and native-host harness attempts are not inputs, requirements, or evidence.

**Stop loss:** One implementation pass and one bounded review/repair pass per task. Tests assert public behavior and effect calls only—never private map allocation order, closure layout, descriptor fingerprints, or source-text token patterns.

## Task 1: Live-attempt predicate

**Files:**

- Modify `media-catcher/lib/download-scheduler.js`
- Modify or add one focused scheduler test file

Add `isAttemptActive(jobId, attemptToken): boolean`. It is non-mutating and returns true only when the exact job is `running`, its live attempt token matches, and neither cancellation nor Firefox handoff is pending. Unknown, malformed, stale, paused, waiting, retry, needs-user, handed-off, and terminal inputs return false.

TDD evidence:

1. RED test for an exact running token and all fail-closed states.
2. RED test showing `cancel(jobId)` makes the predicate false before transport settlement.
3. Focused scheduler suite and full JavaScript suite green.

## Task 2: HLS/DASH producer and native sink lifecycle

**Files:**

- Modify `media-catcher/lib/background-adapters.js`
- Create `media-catcher/tests/background-adapters-hls-sink.test.js`
- Reuse the public capture/enqueue test helpers only; do not extend the compact BA01–BA08 regression file
- Modify router tests only if canonical sink-frame routing needs correction

### Production effect contract

The existing injected effect becomes active:

```js
assembleMedia({
  kind,                 // "hls" | "dash"
  sourceUrl,            // private, never projected
  selection,            // frozen safe selection metadata or null
  segmentConcurrency,
  fetchArrayBuffer,     // guarded scheduler-permit wrapper
  shouldAbort,          // exact scheduler attempt predicate
  onProgress,           // safe numeric progress only
}) -> Promise<{
  bytes: Uint8Array,
  mime: string,
  extension: string,
}>
```

The adapter must copy the returned bytes before retaining them. It must map thrown browser/assembly errors through the real failure classifier and send only its safe category to the scheduler. A malformed success result is a `permanent` assembly failure. Neither path may leak dependency text.

### Lifecycle

1. Admit only owned `direct | hls | dash` records. Preserve opaque media/variant ownership, frozen intent, requested filename, and effective destination.
2. `pump()` starts each exact HLS/DASH attempt once without awaiting the whole transfer. It records a handled private task so re-pumps cannot duplicate work or create unhandled rejections.
3. Acquire one scheduler local activity for the complete assembly → sink-commit lifecycle. Every assembler fetch separately acquires `acquireProviderPermit(jobId, "assembly-fetch")` and releases it in `finally`.
4. After assembly, recheck `isAttemptActive`. Create a real `FileSinkProtocol` session, post `file-open`, then accept only router-normalized `file-sink-message` frames correlated by job, attempt, and sink.
5. On `file-opened`, post at most `MAX_UNACKED` chunks. Valid acknowledgements refill the window. Post `file-commit` only when every byte was sent and every chunk acknowledged.
6. A matching `file-committed` is the only success boundary. It settles the scheduler, releases local activity/capacity exactly once, clears private bytes/session state, and pumps the next queued job.
7. Browser fetch/assembly rejection uses the real normalized browser failure category, preserving bounded retry policy without raw error text. Sink protocol failure, sink-command post failure, or matching `file-error` settles as `local_io`/`needs_user`, releases capacity, and never invokes Firefox or saturation recovery. When a streaming sink exists, send at most one `file-abort` before cleanup.
8. Cancellation makes `shouldAbort()` true immediately. During assembly it prevents open/commit. During streaming it sends one `file-abort` and waits for a matching abort/error acknowledgement or helper-unavailable settlement; stale frames remain inert.
9. Helper disconnect parks active HLS/DASH work through the same scheduler unavailable path, clears local transfer state, and never auto-invokes Firefox.

### Causal tests

1. Owned HLS and DASH jobs share the global cap; each invokes assembly once and never calls browser download or Firefox.
2. The assembler receives the exact kind, private source URL, frozen intent-derived inputs, and safe progress callback; `enqueueDownload` returns the running projection before assembly settles.
3. Every manifest/segment fetch holds exactly one provider permit and releases it on resolve and reject.
4. Local activity/global capacity remain held from assembly through `file-open`, four-chunk window, ack-driven refill, and commit.
5. Matching commit completes and admits a queued independent-provider peer; public projections contain no URL, headers, destination, raw bytes, or sink ID.
6. Wrong/stale/duplicate attempt, sink, ack, commit, abort, and error frames are inert.
7. Transient assembly rejection follows bounded scheduler retry; malformed/permanent assembly failure terminates without Firefox; native post rejection and matching `file-error` become `needs_user`, release capacity, and never call Firefox/saturation recovery.
8. Cancel during assembly prevents `file-open`; cancel during streaming posts one abort and cannot later commit.
9. Helper disconnect cleans active HLS/DASH state and leaves a user-actionable job without Firefox.

Verification:

```powershell
node --check media-catcher/lib/download-scheduler.js
node --check media-catcher/lib/background-adapters.js
node --test media-catcher/tests/download-scheduler*.test.js media-catcher/tests/background-adapters-hls-sink.test.js media-catcher/tests/download-message-router.test.js media-catcher/tests/file-sink-protocol.test.js
node --test media-catcher/tests/*.test.js
git diff --check
```

## Task 3: Live background assembly wiring

Only after Task 2 is green, adapt the existing `background.js` HLS/DASH fetch/assembly functions to the injected `assembleMedia` contract. Keep authenticated browser fetches browser-side. Remove the assembled-media `browser.downloads` save path. Add one narrow live-wiring test proving the controller receives the real effect and native sink commands.

Task 3 does not redesign HLS/DASH parsers. Any parser defect discovered is reported separately instead of expanding this slice.
