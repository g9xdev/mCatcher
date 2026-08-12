# mCatcher Save As, Smart Filenames, and Provider-Aware Queue

Date: 2026-08-12
Status: Approved architecture; written specification pending user review

## Purpose

mCatcher must own the normal download experience instead of silently handing work to Firefox. The extension will propose useful, media-specific filenames, let the user edit them before saving, enforce its existing parallel-download setting, and respond to provider saturation without repeatedly opening connections or changing download engines behind the user's back.

The supplied acceptance fixture is:

`https://florenfile.com/qnzjnabo3jec/11238-makemebi.net.mp4.html`

For that page, the proposed filename must be exactly:

`11238-makemebi.net.mp4`

## Goals

1. Add explicit **Download** and **Save As…** paths for every supported download, including native-helper direct downloads.
2. Produce deterministic, video-specific filename proposals from detection-time page and response evidence.
3. Freeze the source evidence when media is detected so later navigation cannot alter an existing item.
4. Turn `maxConcurrentDownloads` into an enforced global download-job queue.
5. Detect likely provider saturation across different CDN hosts and pause only that provider's competing work.
6. Keep independent providers running concurrently when global capacity remains.
7. Use native single-connection transfer when HTTP ranges are genuinely unsupported.
8. Make Firefox an explicit, user-selected fallback only.
9. Keep automatic retries finite and keep sensitive request material out of persistent metadata.

## Non-goals

- This change does not attempt to identify a provider from a CDN hostname alone.
- It does not persist resumable signed URLs across browser restarts.
- It does not create a new cookie jar or persist request cookies in the extension or helper.
- It does not change media-detection coverage beyond collecting the context needed for filenames and provider identity.
- It does not promise that every page exposes a human-friendly title. The ranker must still return a safe deterministic fallback.

## Current behavior being replaced

- `maxConcurrentDownloads` is stored as a setting but does not admit or queue download jobs.
- Direct helper failures emit `pget-fallback`, and the background script immediately calls `browser.downloads.download()`.
- Range-unsupported transfers are handed to Firefox instead of being attempted as a native single-connection transfer.
- HLS/DASH completion is written through Firefox's download manager.
- Filename selection favors a mutable page title, allowing generic branding to beat a useful URL-derived filename.
- The page context is looked up by tab at download time, so navigation can change an already-detected item's context.

## Chosen architecture

The persistent extension background page owns policy and scheduling. The native host is an execution worker and file sink; it reports structured results but never chooses Firefox fallback.

The implementation is divided into four policy components:

1. `SourceContext` builds one immutable detection-time snapshot.
2. `FilenameRanker` scores bounded candidates and returns a proposed filename plus an explanation suitable for diagnostics.
3. `DownloadScheduler` enforces global admission, provider gates, fairness, cancellation, and retry budgets.
4. `DownloadIntent` carries the proposed or user-edited filename and records whether Firefox was explicitly selected.

These components must be testable without a running browser. `background.js` will adapt browser events and native messages to them rather than embedding policy in message handlers.

## Immutable source context

### Shape

Each media item receives exactly one source-context snapshot:

```js
{
  version: 1,
  capturedAt: "2026-08-12T12:34:56.789Z",
  tabId: 42,
  documentId: "firefox-document-id-or-null",
  frameId: 0,
  topLevelPageUrl: "https://florenfile.com/...mp4.html",
  topLevelSite: "florenfile.com",
  immediateReferrerUrl: "https://florenfile.com/...mp4.html",
  frameOrigin: "https://florenfile.com",
  mediaOrigin: "https://s40.example-cdn.invalid",
  filenameCandidates: [
    { kind: "visible-filename", value: "11238-makemebi.net.mp4" },
    { kind: "document-title", value: "Download 11238 makemebi mp4" },
    { kind: "page-url", value: "/qnzjnabo3jec/11238-makemebi.net.mp4.html" }
  ]
}
```

`sourceContext` is constructed as a new deep-cloned value and recursively frozen before it is attached to the media item. Download and queue code must retain that same object; it must not re-read the active tab title, active URL, or mutable `tabContext`.

### Detection transaction

The content script publishes a bounded page-context snapshot for each document. It collects candidates at `document_idle` and again in response to a targeted snapshot request. Network detections are correlated with this context using Firefox's `documentId`.

Every network detection receives a unique monotonically increasing `detectionId`. A pending detection is keyed by that ID and records the event's `documentId`, `tabId`, `frameId`, `documentUrl`, top-level URL evidence, media origin, and original detection timestamp. Two network events never mutate the same pending object merely because they share a media URL. Ordinary media deduplication happens only after each item has been finalized, and the first finalized item's source context is never replaced by a later duplicate.

When a network detection arrives before its matching content snapshot, the background page requests context from that exact document and waits for at most 750 ms. It then constructs the item, computes its proposed filename once, recursively freezes both values, marks the pending detection closed, and exposes the item. A response with a different document ID or for a closed detection is ignored, including a late correct response received after timeout.

If a webRequest event does not expose `documentId`, mCatcher does not perform a navigation-racy asynchronous merge by `tabId + frameId`. It may use a page snapshot that was already present at detection time only when its captured URL exactly matches the event's captured document URL; otherwise it immediately finalizes from network, referrer, frame-origin, and URL evidence. A DOM-originated detection carries the content script's per-document nonce and its page snapshot directly, so it does not need the webRequest fallback.

The top-level page URL comes from the matching top-level content snapshot when available, then captured `frameAncestors`/request details, and finally a `tabs.get()` value read during the detection transaction—not later at download time. The immediate referrer and frame origin come from the detecting frame/request rather than the mutable active tab.

The media item is not exposed to the popup before this one-time finalization. The pending detection object is internal and is not reused as a mutable `sourceContext`. The finalized item owns an immutable `proposedFilename`; both **Download** and every later opening of **Save As…** begin with that same string.

### Candidate collection

Collection is bounded to avoid copying arbitrary page text. Candidate values are trimmed, length-limited, deduplicated case-insensitively, and tagged with their source kind. Supported evidence is:

- `Content-Disposition` filename from the detected media response
- Visible filename-like text from constrained file-name/download selectors near the media or primary download control
- `download` attributes and media `title`, `aria-label`, `data-filename`, and source basename attributes
- Structured metadata that explicitly names the media
- `og:title` and `twitter:title`
- Document title
- `h1`/`h2` headings
- Top-level page URL path segments
- Immediate referrer URL path segments
- Media URL basename, with volatile query parameters removed before scoring

No full DOM text, cookies, authorization headers, or signed query strings are placed in candidate metadata.

## Filename ranking

`FilenameRanker` is a pure deterministic function. It evaluates normalized candidates rather than choosing the first non-empty page title. The accepted signal list describes evidence to consider, not an unconditional source order: a specific filename-bearing URL must beat a generic document title, while a specific visible filename or metadata title can beat an opaque URL.

### Ranking order

The first implementation uses these base weights so results do not depend on array order:

| Candidate kind | Base weight |
| --- | ---: |
| Response `Content-Disposition` filename | 110 |
| Explicit visible filename or `download` attribute | 100 |
| Media-specific structured metadata or media filename attribute | 90 |
| Top-level page or immediate-referrer path segment | 80 |
| `og:title` or `twitter:title` | 75 |
| Primary heading | 70 |
| Document title | 65 |
| Media URL basename | 45 |

A recognized media extension adds 40 points; meaningful video-specific tokens add up to 20; and an exact normalized agreement between independent sources adds 15. Generic-brand and generic-basename penalties below are applied after positive scoring and can reject a candidate entirely. Ties are resolved by the table order, then normalized lexical order, so DOM traversal order cannot change the winner. A generic deterministic fallback based on media type and capture time is used only when every candidate is rejected.

An apparent media extension is a strong positive signal. A trailing page-wrapper extension is removed only when the preceding suffix is a recognized media extension, so `11238-makemebi.net.mp4.html` becomes `11238-makemebi.net.mp4`.

### Generic-brand rejection

A candidate is rejected or heavily penalized when it is primarily:

- The normalized provider/site name
- A known generic storage, download, player, or security slogan
- Repeated site branding around separators such as `-`, `|`, `:` or an em dash
- A generic media basename such as `video.mp4`, `master.m3u8`, `playlist.m3u8`, `index.mpd`, or `download`
- A title that has no meaningful token not already present in the provider brand

Generic detection is data-driven, not a Florenfile-only string comparison. It combines normalized site tokens with a small generic phrase/token list. The exact fixture `Florenfile.com - Secure Cloud Storage` must be rejected.

### Output rules

- The output is sanitized for Windows, macOS, and Linux path constraints.
- Directory separators, control characters, reserved filename characters, and trailing dots/spaces are removed or replaced.
- The basename is bounded in length while preserving the chosen extension.
- The user's edit is sanitized at confirmation time but is not re-ranked or silently replaced.
- If the user removes the extension, the known output extension is appended. If the user supplies a different valid extension, mCatcher warns when the container does not match but does not silently rename it.
- The ranker runs exactly once during media-item finalization and returns both `proposedFilename` and diagnostic information identifying the winning candidate and rejected generic candidates. The proposal is frozen onto the item; retries and engine changes never invoke the ranker again. Diagnostics must not include signed queries or cookies.

## Save As and download intent

### Popup interaction

Each downloadable media row exposes:

- **Download**: enqueue immediately with the smart proposed filename and current default save folder.
- **Save As…**: open an mCatcher-owned form prefilled with the same proposed filename, allow the full filename to be edited, optionally choose a destination through the native helper, and enqueue only after confirmation.

Cancelling the form creates no job and consumes no scheduler slot. Validation errors remain in the form and do not start a transfer.

The resulting intent is immutable. **Download** copies the frozen proposal directly; **Save As…** copies either the confirmed edit or the unchanged proposal:

```js
{
  requestedFilename: "11238-makemebi.net.mp4",
  destinationDirectory: "helper-selected-directory-or-null",
  saveMode: "default" | "save-as",
  userSelectedFirefox: false
}
```

The requested filename travels with the job through waiting, retries, reduced concurrency, native range transfer, native single-connection transfer, HLS/DASH assembly, and error presentation.

### Native output paths

Direct downloads pass the selected filename and optional destination directory to the native helper. The helper validates the final path, writes to a unique `.part` path in the selected directory, and atomically promotes it on success. Cancellation or terminal failure removes the partial file when safe.

Browser-fetched HLS/DASH data is saved through a native file-sink protocol rather than `browser.downloads`:

- `file-open` validates and binds `jobId`, `attemptToken`, `requestedFilename`, and destination to a sink ID. Later messages cannot change that sink's filename.
- `file-chunk` transfers numbered bounded chunks with acknowledgement/backpressure; only one configured window of unacknowledged chunks may exist.
- `file-commit` flushes and atomically promotes the `.part` file.
- `file-abort` closes the sink and removes its partial file.

The HLS/DASH job holds one global slot through manifest/segment fetching, assembly, and sink commit. Every browser-side manifest, key, and segment request obtains a provider permit from that job. The sink receives file bytes and destination metadata, not media request cookies or signed media URLs. Existing browser-side authenticated segment fetching remains browser-side.

Path/filename validation rejection, chunk/write failure, and commit failure normalize to `local_io`, abort the sink, move the job to `needs_user`, and release its global slot exactly once. They never trigger provider saturation or Firefox. A commit acknowledgement is the only event that marks the download completed. Manual retry reuses the immutable requested filename and opens a new sink/attempt token; a stale sink acknowledgement cannot complete the new generation.

If the helper is unavailable, mCatcher shows a helper-required error with an explicit **Use Firefox instead** action. It does not silently change engines.

## Provider identity and session association

### Provider key

The stable `providerKey` comes from `sourceContext.topLevelSite`, not from the media URL. It is lowercased, has a leading `www.` removed, and is serialized as an ASCII hostname. For the acceptance fixture the key is `florenfile.com`.

This deliberately keeps provider identity tied to the referring page/site. Different CDN hosts observed from that page therefore share one provider group without guessing ownership from CDN naming.

### CDN association

The session-only provider registry records:

```text
media origin -> set of observed provider keys
```

When a job or source context is available, its provider key always wins. Registry lookup is explicit:

- Zero observed providers: do not infer a provider from the CDN. A detection must finish source-context capture before it can become a job; if no page site can be recovered, use a session-scoped page identity such as `document:<documentId>` rather than the CDN hostname.
- One observed provider: an origin-only probe may inherit that provider key.
- More than one observed provider: the origin is ambiguous and cannot supply a provider key; the probe must use its owning media item/job context or wait for detection finalization.

Native callbacks always resolve provider identity through their job ID and never through the callback URL. A shared CDN observed for multiple providers is therefore not collapsed into one provider group.

The registry is cleared on background/browser session restart and is never persisted.

## Enforced download scheduler

### Global admission

`maxConcurrentDownloads` is the hard upper bound on admitted mCatcher download jobs. Only a job that is actively running, or briefly draining in-flight work while being paused, holds a global slot. Provider waits, retry delays, user-attention states, Save-As editing, and work already handed to Firefox hold no slot.

Changing the setting affects future admission immediately but never force-cancels already-running jobs. If the limit is lowered below the current running count, no additional job starts until the count falls below the new limit.

Probes and individual segment requests do not each consume a global job slot, but they must obtain permission from their job's provider gate before opening a new network request.

### State and slot contract

| State | Global slot | New provider connections | Automatic exit |
| --- | --- | --- | --- |
| `created` / Save-As editing | No | No | User confirmation creates `queued` |
| `queued` | No | No | Global round-robin admission selects it |
| `running` | Yes | Normal gate permits; when throttled, drain-owner permits only | Completion, classified failure, cancellation, or pause |
| `pausing_provider` | Yes, only until all existing requests/host lease are quiescent | No | `waiting_provider`, then release slot |
| `waiting_provider` | No | No | Provider wake consumes retry if needed, then moves to `queued` |
| `retry_backoff` | No | No | Timer consumes/has consumed retry as defined below, then moves to `queued` |
| `needs_user` | No | No | Explicit Retry creates a new attempt generation; explicit Firefox hands off externally |
| `handing_off_firefox` | No | Firefox alone, after explicit intent validation | `handed_to_firefox` or `needs_user` if the API rejects |
| `handed_to_firefox` | No; terminal to mCatcher scheduling | Outside mCatcher | None |
| `completed` / `failed` / `cancelled` | No; terminal | No | None |

A transition out of `running` releases its slot in the same scheduler transaction. `pausing_provider` is the sole exception: it retains the slot until its already-open requests have returned their permits or the native helper acknowledges a zero-connection pause. It then atomically becomes `waiting_provider` and releases the slot. This short drain state preserves the hard global count while ensuring permit-starved provider work cannot occupy capacity indefinitely.

Every job has a monotonically increasing `stateVersion` and a boolean slot token. State changes use compare-and-set semantics against the expected version. Repeated completion, cancellation, timeout, or native terminal messages therefore cannot release a slot twice. Each provider also has a wake generation; the central drain routine records the generation it processed, so completion and a late cancellation cannot enqueue the same waiter twice.

### Provider permits

Every browser-side probe, manifest request, segment request, key request, and direct fetch must acquire a logical permit from `ProviderGate` immediately before opening the request and release it in `finally`. In normal state, a running job may hold up to its effective concurrency. Work without a running download slot, except bounded detection/enrichment probes, cannot acquire a permit.

The native helper receives a revocable connection lease containing `jobId`, `providerGeneration`, and `maxConnections`. It must not open more simultaneous requests than that lease allows. A `pget-set-limit` message lowers the lease dynamically: zero for a non-owner being paused and the reduced positive limit for the drain owner. Existing requests may finish, but no replacement request may open after the helper acknowledges the new generation. If the acknowledgement times out, mCatcher cancels that native operation and moves it through the ordinary classified failure path; it does not assume the provider gate is safe.

While a provider is saturated or recovering, only its designated drain owner can receive new permits or a positive native lease. Detection/enrichment probes for that provider are parked. Other provider gates are unaffected.

### Fairness

The scheduler maintains FIFO order within a provider and round-robin selection across providers. A blocked provider is skipped so an independent provider can use available global capacity. A woken provider job always re-enters `queued` and must win global admission; it never jumps directly to `running` or exceeds `maxConcurrentDownloads`. The retry unit is consumed when that automatic wake is authorized, even when the job then waits for a global slot.

Cancellation removes the job from its provider queue and invokes the same idempotent drain routine used by completion. A designated recovering provider may reserve which same-provider waiter is next, but it does not reserve a global slot; round-robin admission may run another provider first.

## Provider saturation

### Classification

Native and browser fetch layers normalize failures to structured categories:

- `timeout`
- `connection_reset`
- `short_read`
- `http_429`
- `http_5xx_temporary`
- `range_unsupported`
- `local_io`
- `cancelled`
- `permanent`

Only timeout, reset, short-read, 429, and temporary 5xx categories are saturation candidates. A failed job, probe, or segment becomes **likely provider saturation** only when all of the following are true at classification time:

1. A distinct download job has the same captured `providerKey`.
2. That sibling is in `running` or `pausing_provider`.
3. The sibling has at least one browser provider permit in flight or a native lease reporting at least one open connection.
4. The sibling has not requested cancellation and can still make progress.

Queued, `waiting_provider`, `retry_backoff`, `needs_user`, Save-As-editing, and terminal jobs do not count as active siblings. Saturation is not inferred merely because work is non-terminal or because two URLs share a CDN hostname.

### Saturation response

When saturation is detected:

1. The provider gate increments its generation and enters `saturated`.
2. The oldest qualifying running sibling becomes the drain owner. The failed work itself cannot become owner for this saturation event.
3. The owner's effective concurrency is halved immediately, with a minimum of one, and its browser permits/native lease are reduced to that limit.
4. The failed job and every running non-owner job from that provider enter `pausing_provider`; no new permits are issued and native leases are set to zero. After their in-flight work drains or acknowledges pause, they enter `waiting_provider` and release their global slots. A failed enrichment probe is parked without a slot.
5. New same-provider jobs and probes wait without opening connections. While saturated, at most the drain owner may remain `running` for that provider after the pause handshake completes.
6. The affected popup rows show `Waiting for <providerKey>`, for example `Waiting for florenfile.com`.
7. Other providers remain eligible under the global limit as the paused jobs release slots.
8. Completion or cancellation of the drain owner atomically releases its slot, advances the provider wake generation, selects the oldest eligible same-provider waiter, and offers that waiter to global admission exactly once. A waiter that failed consumes one automatic-retry unit at this point; a sibling paused only to remove competing connections does not.

The provider remains in `recovering` while the selected waiter is queued or running. Only that recovery candidate may receive provider permits, and it runs at its already-reduced effective concurrency. A successful recovery-candidate completion returns the provider to normal and makes the remaining provider FIFO eligible. Cancellation, permanent failure, or retry exhaustion selects the next eligible waiter without treating cancellation as proof of recovery.

If the classifier cannot identify a qualifying active sibling, it never enters provider-wide saturation. The failed work uses the ordinary bounded transient-retry path instead of waiting forever for a nonexistent owner. If a recovery owner later fails transiently while no qualifying sibling is active, that failure likewise uses ordinary bounded retry; the provider stays in recovery mode and no second job is admitted alongside it.

### Reduced concurrency and retry bounds

Each job starts with the configured segment concurrency. Saturation immediately changes both the drain owner's and failed job's effective concurrency to `max(1, floor(previous / 2))`. A job paused only because it was a competing sibling receives the provider's reduced cap when selected for recovery. Effective concurrency never increases again during that job, including after a manual retry.

At creation, a job receives `retryRemaining = clamp(settings.retries, 0, 10)`. This is the single automatic retry budget shared by the scheduler, browser fetches, and native transfer outcomes:

- The first attempt does not consume the budget.
- An ordinary transient failure calls one scheduler operation, `scheduleAutomaticRetry`. If no budget remains, the job enters `needs_user`. Otherwise the operation decrements the budget once and enters `retry_backoff`.
- A provider-saturated failure enters `waiting_provider` without decrementing immediately. When the active owner finishes/cancels and the scheduler authorizes that failed job's automatic wake, it decrements once before moving the job to `queued`. Global queue delay causes no further decrement.
- Resuming a sibling that was paused but did not fail costs no retry unit.
- The verified multi-range-to-single-connection capability switch costs no retry unit.
- A manual **Retry** creates a new explicit attempt generation with a fresh configured budget, but retains the frozen source context, requested filename, and any reduced concurrency. It cannot repeat without another user action after exhaustion.

Backoff is `min(30 seconds, 1 second * 2^automaticRetriesUsed)` and can be interrupted by cancellation. Exhaustion moves the job to `needs_user`; no timer, late native message, or sibling completion can restart that generation automatically.

Browser fetch helpers and native workers perform one transport attempt per scheduler-issued operation token and report a normalized outcome. They do not maintain an additional retry loop. A retried segment, range, probe, manifest, or single-connection request must present a newly issued attempt token, so nested browser/native loops cannot multiply the configured budget or run forever.

## Direct-download fallback ladder

The direct native path is:

1. Native multi-range transfer using scheduler-supplied effective segment concurrency.
2. If and only if a range request conclusively shows that the server ignores ranges, native single-connection transfer to a freshly truncated `.part` output for the same target path and requested filename.
3. Structured retry, provider waiting, or `needs_user` based on the normalized failure category and retry budget.
4. Firefox only after the user presses **Use Firefox instead**.

`range_unsupported` is not a reason to call Firefox. A timeout, reset, short read, 429, or temporary 5xx is not treated as proof that ranges are unsupported.

The native host verifies range support inside a scheduler-issued operation/connection lease by sending `Range: bytes=0-0` after redirects. A valid `206` with a matching `Content-Range` proves support. A successful `200` response that ignores the Range header proves that this resource must use a single connection. Missing `Accept-Ranges`, `416`, malformed headers, timeouts, resets, short reads, 429s, and 5xx responses do not by themselves prove unsupported ranges; they are normalized to their own transient or permanent category.

No range worker writes output before the capability probe succeeds. If a later ranged request is answered with a conclusive full `200`, the host stops and joins range workers, closes their handles, deletes or truncates the partial output, and reports `partState: "empty"`. It cannot report `range_unsupported` while a worker can still write that file.

The native host replaces `pget-fallback` with a single structured terminal contract:

```js
{
  type: "pget-result",
  id: "job-id",
  attemptToken: "scheduler-issued-token",
  status: "completed" | "failed" | "cancelled",
  mode: "multi-range" | "single-connection",
  failureCategory: null | "range_unsupported" | "timeout" |
    "connection_reset" | "short_read" | "http_429" |
    "http_5xx_temporary" | "local_io" | "permanent",
  partState: "committed" | "empty" | "partial"
}
```

On `range_unsupported` with `partState: "empty"`, the extension keeps the same job in `running`, changes its mode to `single-connection`, fixes effective connection concurrency at one, and issues a `pget-single` operation with the same intent and target. This capability switch neither releases/reacquires the global slot nor consumes retry budget. Any transient failure of the single connection follows the same scheduler/provider classification rules as other network work. `local_io` is never provider saturation.

## Explicit Firefox last resort

All Firefox-download calls go through one guarded adapter. The adapter accepts only an immutable, user-derived Firefox intent plus `requestedFilename` and an ephemeral source handle. It requires `userSelectedFirefox === true` and proof that the intent was created by the popup action; otherwise it rejects before calling the browser API. No native result handler, retry path, range decision, assembly-complete path, or helper-unavailable path can manufacture that proof or call the browser API directly.

Selecting Firefox first stops/aborts any mCatcher network and sink work and transitions the job to `handing_off_firefox` with no global slot or provider permit. The adapter then calls Firefox with `filename: intent.requestedFilename` and `saveAs: true`. API success makes the job `handed_to_firefox`, terminal to the mCatcher scheduler; API rejection returns it to `needs_user` without a slot. Firefox work is not counted as an mCatcher parallel-download job after handoff.

For an explicit Firefox direct download, the adapter obtains the signed URL from an in-memory closure at call time. It never copies the URL into the intent, queue metadata, diagnostics, or logs, and it relies on Firefox's own cookie jar rather than supplying a copied `Cookie` header. For already-assembled bytes, it uses a short-lived object URL and revokes it after the browser API has accepted or rejected the request. Both routes use exactly the job's frozen `requestedFilename`.

The action explains that choosing Firefox transfers ownership to Firefox and that Firefox may retain its own download history according to browser settings. The mCatcher memory-only rule governs mCatcher state and logs; explicit transfer cannot control Firefox's own history.

The error UI keeps the failed/paused job and offers contextual actions:

- **Retry** when retrying can be useful
- **Use Firefox instead** as a clearly labelled engine change
- **Cancel**

## Cancellation and wake-up behavior

- Cancelling active work first revokes provider permits/native leases, sends native cancellation, and closes or aborts any file sink. After the helper acknowledges cancellation or the bounded forced-close path returns all connection leases, one compare-and-set transition marks `cancelled` and releases the scheduler slot exactly once.
- A drain-owner completion/cancellation transaction orders side effects as: quiesce connections and sinks, mark terminal, release its global slot, advance provider wake generation, enqueue one eligible same-provider waiter, then run global round-robin admission. No timer or late result handler can repeat that provider generation.
- Cancelling a waiting job removes it without disturbing the active sibling.
- Cancelling a job in backoff clears its timer.
- Completion and cancellation invoke the same idempotent scheduler drain routine.
- Tab closure or navigation does not cancel a job unless the user explicitly cancels it; the frozen context, filename, in-memory signed URL, and ephemeral request context remain attached to the job until terminal cleanup. An expired signed URL follows normal classified failure and finite retry rules; mCatcher does not refresh it from the newly active page.

## Privacy and sensitive data

- Full media URLs, including signed query strings, live only in a non-serializable `EphemeralRequestContext` attached to the in-memory media item/job. Queued jobs retain it after tab closure so they can still start; terminal cleanup clears its URL/header references.
- `sourceContext`, the provider-origin registry, queue state, and active jobs are session-memory objects and are not written to `storage.local`.
- If safe history metadata is retained, its allowlist is limited to requested filename, provider key, status, byte count, and timestamps. Page/referrer/media URLs and request headers are excluded.
- Cookies and authorization headers are never copied into source context, filename diagnostics, provider metadata, persistent settings, logs, or result history.
- Ephemeral request headers needed by an active native transfer may be supplied from `EphemeralRequestContext` to the helper for that operation only; the helper must neither persist nor log them and must release them with the operation.
- Metadata/history serialization is an allowlist projection rather than object spreading or JSON-stringifying a media item/job. The ephemeral context has no serializer and is never included in popup state snapshots.
- Native messages and debug logging must redact URL query strings and sensitive headers. Privacy tests inject recognizable signed-query and cookie sentinels and fail if they appear in storage, safe history, diagnostics, or captured logs.

## Settings and compatibility

- The existing **Parallel downloads** field remains the user control for `maxConcurrentDownloads`; its label/help text will make clear that excess jobs wait in the queue.
- The existing segment concurrency setting remains the initial per-job segment concurrency and is subject to provider reductions.
- The existing retry setting supplies the finite automatic retry budget.
- Existing saved settings require no migration.
- Existing default-download behavior remains one click; the visible change is the smarter proposed name and actual queue enforcement.

## Test strategy and acceptance criteria

Pure extension policy will be covered with deterministic JavaScript tests. Browser/background adapters will use fakes for Firefox APIs, clocks, native messaging, and network operations. Native behavior will remain under Python unit/integration tests with local HTTP fixtures.

The following tests are mandatory:

1. Two items from the same referring provider but different CDN hosts share one throttle group.
2. A transient timeout/reset/short-read/429/temporary-5xx failure with an active provider sibling enters `waiting_provider` and does not call Firefox's download API.
3. Completing or cancelling the active provider drain owner wakes the next queued job exactly once.
4. Jobs from independent providers run concurrently when the global limit permits.
5. Automatic retries and waiting wake-ups consume a finite budget and cannot loop forever.
6. Filename ranking rejects `Florenfile.com - Secure Cloud Storage` and selects `11238-makemebi.net.mp4` from the Florenfile fixture.
7. Save As starts both native and explicitly selected Firefox paths with the same proposed or edited smart filename.

Additional required regression coverage:

- `maxConcurrentDownloads` is a hard global admission limit.
- Lowering the limit pauses new admission without cancelling active work.
- `waiting_provider`, `retry_backoff`, and `needs_user` release global capacity, while `pausing_provider` releases it exactly once after in-flight work drains; unrelated providers can fill those slots.
- A pending detection ignores both a context response from a navigated document and a late matching response received after finalization.
- Missing-`documentId` events never merge a later `tabId + frameId` snapshot, and concurrent detection IDs cannot mutate each other's candidates.
- The exposed source context is recursively frozen, and both it and the propose-once filename survive later tab navigation.
- A shared CDN associated with two providers does not merge those providers.
- CDN registry lookups with zero, one, and multiple provider associations follow the specified decision table.
- A queued or `needs_user` same-provider item does not satisfy the active-sibling saturation predicate.
- Saturation denies new same-provider probe/segment/native-lease connections, reduces the drain owner immediately, and pauses non-owners without exceeding the global slot cap.
- With no viable active sibling, a transient failure follows bounded retry and cannot remain in `waiting_provider`.
- A saturation wake re-enters global admission, consumes the failed work's retry unit once even if globally queued, and does not charge merely paused siblings.
- A genuine no-range response uses native single-connection transfer.
- A transient range/probe failure does not masquerade as no-range support.
- The range-to-single switch empties the partial output, keeps the same job/slot/filename, fixes concurrency at one, and consumes no retry unit.
- Browser and native operation fakes reject reused/stale attempt tokens and demonstrate that lower-level loops cannot multiply the retry budget.
- Save As cancellation starts no download and consumes no queue slot.
- Download, Save As, provider retry, native single-connection, HLS/DASH sink, and explicit Firefox handoff all retain the same `requestedFilename` unless the user edited it before enqueue.
- Helper unavailability presents, but never invokes, **Use Firefox instead**.
- The guarded Firefox adapter rejects `userSelectedFirefox: false`; native failures, sink failures, retry exhaustion, and range decisions cannot supply user-action proof.
- Explicit Firefox handoff releases mCatcher slots/permits once, uses `saveAs: true`, and API rejection returns to `needs_user` without leaking capacity.
- HLS/DASH file-sink commit is atomic; abort removes its partial file.
- Filename/path rejection and mid-stream sink failure map to `local_io`, abort, and never invoke Firefox or provider saturation.
- Duplicate native terminal messages, cancellation acknowledgements, and late provider timers cannot double-release a slot or double-wake the next job.
- Safe-history/storage/log capture with signed-query and cookie sentinels contains neither value; ephemeral contexts are cleared at terminal cleanup.

## Observability

Debug diagnostics may record safe state transitions using job ID, provider key, failure category, retry count, and effective concurrency. They must not include signed queries, cookies, authorization headers, or full referrer URLs.

User-visible state distinguishes:

- `Queued`
- `Waiting for <provider>`
- `Downloading`
- `Retrying at reduced concurrency`
- `Needs attention`
- `Completed`
- `Cancelled`

This makes provider throttling understandable without exposing internal CDN details.

## Rollout sequence

The implementation plan will preserve a working extension at each checkpoint:

1. Add pure source-context, filename-ranker, intent, and scheduler modules with failing-then-passing tests.
2. Capture document-scoped context and attach it once at detection.
3. Add the popup Save As interaction and immutable download intents.
4. Route all jobs through global/provider scheduling.
5. Replace native `pget-fallback` with structured outcomes and native single-connection fallback.
6. Add the native file sink and remove automatic Firefox writes for assembled media.
7. Add the guarded explicit Firefox adapter and failure actions.
8. Run extension, native-host, integration, privacy, and Florenfile fixture tests.

## Completion definition

This work is complete only when all mandatory and regression tests pass, direct and assembled downloads no longer silently enter Firefox, the global/provider queues behave as specified, and the Florenfile fixture proposes `11238-makemebi.net.mp4` through both default and Save As flows.
