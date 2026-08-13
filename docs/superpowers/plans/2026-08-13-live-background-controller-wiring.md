# Live Background Controller Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the verified policy controller the live owner of direct and static HLS/DASH downloads, while preserving legacy YouTube, live HLS recording, and casting and keeping explicit Firefox fallback user-gated.

**Architecture:** The persistent background page loads every locked classic-script dependency before `background.js` and creates one `BackgroundAdapters` controller after settings restoration. Verified static media is promoted from the legacy enrichment path into opaque controller media/variant IDs; live HLS, YouTube, recording, and cast objects remain legacy. Controller jobs are routed through the native helper and published to the popup only through safe projections. HLS/DASH Firefox fallback materializes the already-retained assembled bytes as a short-lived object URL; it never downloads the manifest URL.

**Tech Stack:** Firefox WebExtension Manifest V2 classic background scripts, plain JavaScript dual-export modules, Node `node:test`, VM browser fakes, native messaging.

## Global Constraints

- `C:\Code\mCatcher` is the sole project boundary. Every active worktree, plan, brief, report, test artifact, package, recovery input, verification input, and installation input stays below it.
- Quarantined BA07/BA08 and native-host harness attempts are outside the goal and must not be read, copied, repaired, or used as requirements or evidence.
- Add public/effect behavior tests only. Do not assert private map allocation order, closure layout, descriptor fingerprints, or source-text token patterns.
- There is exactly one live `BackgroundAdapters` controller and one scheduler per background page.
- Direct and static HLS/DASH use controller/native transport only. They never automatically invoke Firefox and never fall back from a native failure to `browser.downloads`.
- Only an explicit popup click carrying a valid one-time Firefox intent may invoke `browser.downloads.download`.
- HLS/DASH Firefox fallback uses retained assembled bytes and MIME through `FirefoxGuard`; the manifest URL is never handed to Firefox.
- Authenticated browser fetches remain browser-side and use the immutable source tab ID captured at detection/admission. The assembler itself owns no retry loop.
- Public media/job projections contain no media URL, headers, destination secrets, assembled bytes, sink IDs, attempt tokens, or native handles.
- YouTube, live HLS recording, saved-recording controls, open/reveal, update flows, and casting remain legacy in this plan.
- Use strict RED → GREEN TDD. A failing test must name the production behavior whose absence caused the failure before production changes begin.
- Stop loss per task: one implementation pass, one task review, and at most one repair pass for confirmed Critical/Important findings.

---

### Task 1: Classic-script bootstrap and native-frame demultiplexing

**Files:**

- Modify: `media-catcher/manifest.json`
- Modify: `media-catcher/background.js`
- Create: `media-catcher/tests/background-live-bootstrap.test.js`

**Interfaces:**

- Consumes: `McBackgroundAdapters.createBackgroundAdapters(options)` and `McLiveMediaAssembler.createLiveMediaAssembler({ HLS, DASH, Mux })`.
- Produces: one settings-initialized `liveController`, dynamic native-post effect forwarding, controller-first native-frame handling, and disconnect notification.

- [ ] **Step 1: Write the failing manifest/bootstrap test**

Create a VM browser harness that executes the real manifest script list and `background.js` with a fake storage result, runtime/native port, downloads API, tabs, webRequest events, and other registered legacy APIs. The test must fail because the policy globals are absent and no controller is created. Assert these independent literals:

```js
assert.equal(controllerCreates.length, 1);
assert.equal(controllerCreates[0].maxConcurrent, 7);
assert.equal(controllerCreates[0].segmentConcurrency, 3);
assert.equal(controllerCreates[0].retries, 2);
```

The storage fixture supplies those three restored values. Assert construction happens after the storage promise resolves, not against defaults.

- [ ] **Step 2: Write the failing native-demux test**

The controller fake returns `true` for one `file-opened` fixture and invokes its injected `postNative({cmd:"file-chunk", sinkId:"sink-live"})`. Assert the exact command reaches the real fake native port once and the legacy handler produces no effect. For a literal legacy `{type:"pong",version:"1.10.0",ffmpeg:true}` fixture, return `false` and assert the existing helper state path still runs. Disconnect the port and assert `helperDisconnected()` is called once while cast cleanup remains registered.

- [ ] **Step 3: Run RED**

```powershell
node --test media-catcher/tests/background-live-bootstrap.test.js
```

Expected: FAIL because `manifest.json` does not load the policy modules and `background.js` never creates or consults a controller.

- [ ] **Step 4: Add the dependency-safe manifest order**

Keep the five legacy dependencies first, then load these scripts in this exact order before `background.js`:

```json
"lib/filename-ranker.js",
"lib/source-context.js",
"lib/detection-finalizer.js",
"lib/download-intent.js",
"lib/provider-registry.js",
"lib/failure-classify.js",
"lib/provider-gate.js",
"lib/download-scheduler.js",
"lib/native-result-adapter.js",
"lib/file-sink-protocol.js",
"lib/firefox-guard.js",
"lib/privacy.js",
"lib/download-message-router.js",
"lib/live-media-assembler.js",
"lib/background-adapters.js"
```

Do not load popup-only UI modules into the background page.

- [ ] **Step 5: Create one controller after settings restoration**

Retain the settings restoration promise as `settingsReady`. After both success and storage failure, initialize exactly once. Build the live assembler once from `self.HLS`, `self.DASH`, and `self.Mux`. Inject:

```js
{
  maxConcurrent: settings.maxConcurrentDownloads,
  segmentConcurrency: settings.concurrency,
  retries: settings.retries,
  now: () => Date.now(),
  randomToken: mint with crypto.randomUUID() or crypto.getRandomValues(), never Math.random(),
  postNative: command => require current nativePort and post command,
  downloadsDownload: options => api.downloads.download(options),
  createObjectURL: blob => URL.createObjectURL(blob),
  revokeObjectURL: url => URL.revokeObjectURL(url),
  fetchArrayBuffer: (tabId, url, options) => makeOneShotFetchFn(tabId)(url, options),
  assembleMedia: liveAssembler,
  isPopupSender: exact extension popup-page sender predicate,
  getEffectiveDestinationDirectory: () => settings.saveFolder || null,
  publishDetection: safe row => broadcast a refresh signal,
  publishJobs: safe jobs => broadcast one safe jobs update,
  persistHistory: safe entry => addHistory(safe entry),
  reportDiagnostic: safe diagnostic => bounded extension log
}
```

Add `makeOneShotFetchFn(tabId)` as the authenticated, cookie-aware equivalent of one existing `makeFetchFn(tabId)` attempt, but without its retry loop. The scheduler/assembler lifecycle owns retries; nesting the legacy fetch retry loop would multiply attempts. The tab-aware one-shot callback is installed now; Task 2 makes the adapter call it with the captured tab ID before any live job is admitted.

- [ ] **Step 6: Demultiplex native frames**

Rename the current native body to a legacy handler. The registered native listener first offers the message to `liveController.handleNativeMessage`. A `true` result stops. A `false` result or pre-controller legacy startup message continues through the unchanged legacy handler. Controller errors are reported safely; they do not reinterpret a recognized controller frame as a legacy command. The disconnect listener calls `liveController.helperDisconnected()` asynchronously in addition to its current cast/helper cleanup.

- [ ] **Step 7: Run GREEN and regression checks**

```powershell
node --test media-catcher/tests/background-live-bootstrap.test.js
node --test media-catcher/tests/download-message-router.test.js media-catcher/tests/background-adapters-hls-sink.test.js
node --check media-catcher/background.js
git diff --check
```

- [ ] **Step 8: Commit**

```powershell
git add media-catcher/manifest.json media-catcher/background.js media-catcher/tests/background-live-bootstrap.test.js
git commit -m "feat: bootstrap live background controller"
```

---

### Task 2: Tab-bound assembly fetch and assembled-byte Firefox handoff

**Files:**

- Modify: `media-catcher/lib/background-adapters.js`
- Modify: `media-catcher/lib/download-scheduler.js`
- Modify: `media-catcher/lib/firefox-guard.js`
- Modify: `media-catcher/tests/background-adapters-hls-sink.test.js`
- Modify: `media-catcher/tests/background-firefox-handoff.test.js`
- Modify: `media-catcher/tests/firefox-guard.test.js`
- Modify scheduler test only for the new private callback input field

**Interfaces:**

- Consumes: Task 1's live `fetchArrayBuffer(tabId, url, options)` effect.
- Produces: immutable source-tab fetch routing and explicit Firefox download from retained HLS/DASH bytes with the assembled filename.

- [ ] **Step 1: Write RED for immutable tab-bound fetch**

Capture media on tab `41`, enqueue it, then invoke the assembler's guarded fetch with literal URL/options. Assert the injected effect receives exactly `(41, url, options)`. Mutating popup/current-tab fixtures afterward must not change `41`. The test fails before production changes because the adapter currently forwards only URL/options.

- [ ] **Step 2: Write RED for assembled-byte Firefox fallback**

Drive an HLS job through successful assembly and a matching native `file-error` into `needs_user`. Submit a valid explicit Firefox intent. Assert:

```js
assert.equal(downloadCalls.length, 1);
assert.equal(downloadCalls[0].url, "blob:assembled-1");
assert.equal(downloadCalls[0].filename, "movie.mp4");
assert.equal(downloadCalls[0].saveAs, true);
assert.deepEqual(revokedUrls, ["blob:assembled-1"]);
assert.equal(JSON.stringify(downloadCalls).includes("m3u8"), false);
```

Also retain the direct-job control: its explicit Firefox handoff resolves the private URL handle and does not create an object URL.

- [ ] **Step 3: Run RED**

```powershell
node --test media-catcher/tests/background-adapters-hls-sink.test.js media-catcher/tests/background-firefox-handoff.test.js media-catcher/tests/firefox-guard.test.js
```

Expected: FAIL because the binding has no immutable tab fetch argument, `requestFirefoxHandoff` permits only direct jobs, and the scheduler callback always constructs a URL source.

- [ ] **Step 4: Bind safe job/source identity privately**

Store `record.tabId` and `record.mediaId` on the private job binding at admission. Pass the binding's captured tab ID as the first argument to the injected fetch effect; the assembler-facing wrapper remains `(url, options)`. Add `jobId` to the scheduler's frozen internal `firefoxDownload(adapterInput)` record so the adapter can locate its private binding. This field is never added to public projections beyond the already-public job `id`.

- [ ] **Step 5: Select URL or bytes at the Firefox boundary**

Allow `requestFirefoxHandoff` for:

- `direct` jobs with their private URL handle; and
- `hls|dash` jobs only when `binding.assembled` contains retained bytes, MIME, and extension.

For assembled jobs pass:

```js
source: { type: "bytes", bytes: binding.assembled.bytes, mime: binding.assembled.mime }
```

and an assembled filename derived with the existing extension-replacement rule. Extend `FirefoxGuard.downloadWithFirefox` with an optional validated `filename` override used only for the downloads API call; the proof intent remains the exact scheduler-validated intent. Consume the proof before materializing the Blob and revoke the object URL in `finally` on resolve or reject.

- [ ] **Step 6: Run GREEN and full relevant suites**

```powershell
node --test media-catcher/tests/background-adapters-hls-sink.test.js media-catcher/tests/background-firefox-handoff.test.js media-catcher/tests/firefox-guard.test.js media-catcher/tests/scheduler-retry-cancel.test.js
node --check media-catcher/lib/background-adapters.js
node --check media-catcher/lib/download-scheduler.js
node --check media-catcher/lib/firefox-guard.js
git diff --check
```

- [ ] **Step 7: Commit**

```powershell
git add media-catcher/lib/background-adapters.js media-catcher/lib/download-scheduler.js media-catcher/lib/firefox-guard.js media-catcher/tests/background-adapters-hls-sink.test.js media-catcher/tests/background-firefox-handoff.test.js media-catcher/tests/firefox-guard.test.js media-catcher/tests/scheduler-retry-cancel.test.js
git commit -m "feat: hand assembled media to Firefox explicitly"
```

---

### Task 3: Promote verified static media into opaque controller rows

**Files:**

- Modify: `media-catcher/background.js`
- Create: `media-catcher/tests/background-live-detection.test.js`

**Interfaces:**

- Consumes: controller `captureNetwork`, `acceptPageSnapshot`, `captureDomMedia`, `registerVariants`, `popupMedia`, and `popupJobs`.
- Produces: verified static direct/HLS/DASH controller rows plus legacy live/YouTube/cast rows in `get-media`.

- [ ] **Step 1: Write RED for snapshot/context routing**

Use a real `content.js` message fixture. Assert `page-snapshot-context` returns literal sender-bound `{tabId,frameId,documentId,topLevelPageUrl}`; `page-snapshot` reaches `acceptPageSnapshot` once; snapshot-bound direct `content-media` reaches `captureDomMedia` with its exact media URL, frame/referrer context, snapshot, `mediaKind:"direct"`, and no headers. YouTube content remains in the legacy map and does not call the controller.

- [ ] **Step 2: Write RED for verified network promotion**

Provide one direct response that passes the existing media probe, one static HLS master, one static DASH MPD, one live HLS playlist, and one DRM/unsupported stream. Assert only the verified direct/static HLS/static DASH items are promoted to controller capture. Assert live HLS stays a legacy recordable row and unsupported/DRM stays visibly legacy with no controller job authority.

For HLS master variants, assert `registerVariants` receives literal private variant URLs plus safe metadata. For DASH representations, assert each registration uses the original MPD URL plus safe width/height/bandwidth/MIME metadata, so selecting a quality keeps the MPD as assembler source while the opaque variant ID carries selection metadata.

- [ ] **Step 3: Write RED for safe merged popup surfaces**

Assert `get-media` returns controller `popupMedia(tabId)` rows without URLs and legacy live/YouTube rows with their existing shapes. Assert `downloads` combines `controller.popupJobs()` with legacy recording/YouTube/cast queue records. `allTabs` includes tabs known only to the controller using a private set of controller-owned tab IDs.

- [ ] **Step 4: Run RED**

```powershell
node --test media-catcher/tests/background-live-detection.test.js
```

Expected: FAIL because live background ignores snapshot messages and uses only legacy `addMedia`/`visibleFor` surfaces.

- [ ] **Step 5: Preserve raw detection evidence privately until enrichment**

Store each candidate network capture envelope in a `WeakMap` keyed by its legacy item object; never add it as an enumerable item field. Direct items promote only after the current probe proves real media. HLS promotes only after parsing proves non-live and non-DRM. DASH promotes only after parsing proves non-dynamic and non-DRM. Promotion calls `captureNetwork`, registers variants when available, records the controller tab ID, removes the legacy VOD row, updates the badge, and broadcasts one refresh.

An enrichment failure or unsupported/live result remains legacy and is never silently treated as a static controller download.

- [ ] **Step 6: Route content snapshots and safe DOM media**

Handle `page-snapshot-context`, `page-snapshot`, and snapshot-bound direct `content-media` as specified. HLS DOM media without a verified VOD classification remains legacy so live recording is not stolen. Continue legacy `page-info` and thumbnail behavior unchanged.

- [ ] **Step 7: Merge safe controller surfaces**

In `get-media`, merge controller rows with legacy rows, decorate only with safe `tabId`/thumbnail/page title where appropriate, sort without assuming a raw URL or timestamp, and avoid duplicate promoted VOD rows. Merge controller jobs with legacy active downloads. Never mutate controller-frozen rows; create fresh safe view records.

- [ ] **Step 8: Run GREEN and content regressions**

```powershell
node --test media-catcher/tests/background-live-detection.test.js media-catcher/tests/content-snapshot.test.js media-catcher/tests/background-adapters.test.js
node --check media-catcher/background.js
git diff --check
```

- [ ] **Step 9: Commit**

```powershell
git add media-catcher/background.js media-catcher/tests/background-live-detection.test.js
git commit -m "feat: publish opaque live media rows"
```

---

### Task 4: Route popup actions and render opaque controller identities

**Files:**

- Modify: `media-catcher/lib/background-adapters.js`
- Modify: `media-catcher/lib/privacy.js`
- Modify: `media-catcher/background.js`
- Modify: `media-catcher/popup/popup.js`
- Modify: `media-catcher/tests/popup-intent.test.js`
- Create: `media-catcher/tests/background-live-actions.test.js`
- Modify focused adapter privacy tests for the safe media-to-job binding

**Interfaces:**

- Consumes: opaque media/variant IDs and controller action methods.
- Produces: live default/Save As enqueue, cancel, retry, explicit Firefox handoff, and stable popup media/job correlation without raw URLs.

- [ ] **Step 1: Write RED for opaque item/job identity**

Add safe `mediaId` correlation to controller job projections. It must equal the originating opaque media ID and contain no URL. The returned enqueue job and later `popupJobs()` projection both include the same `mediaId`. Assert `Privacy.projectPopupJob` accepts only a safe primitive identifier and omits malformed/accessor values.

- [ ] **Step 2: Write RED for live action dispatch**

For a popup sender and opaque IDs, assert:

```js
download       -> controller.enqueueDownload(message, sender)
retry-download -> controller.manualRetry(id)
cancel         -> controller.cancel(id)
use-firefox    -> controller.requestFirefoxHandoff(message, sender)
```

Each method is called exactly once and its safe result is returned. Numeric legacy recording/YouTube cancellation continues through `activeDownloads`. Non-popup/forged opaque messages fail closed. Static HLS/DASH never call `downloadHls`, `downloadDash`, `saveBytes`, or `api.downloads.download`.

- [ ] **Step 3: Write RED for URL-free popup rendering**

Introduce one identity helper:

```js
function itemIdentity(item) {
  return item && typeof item.id === "string" ? "id:" + item.id : "url:" + item.url;
}
```

Assert controller rows key `itemElements` and `itemDownloadId` by opaque `id/mediaId`, render proposed filename/kind/variants, and never render/call Copy URL, command, or cast controls when `item.url` is absent. Legacy URL rows retain those controls. Safe variant buttons send `variantId`, never `variantUrl`.

- [ ] **Step 4: Run RED**

```powershell
node --test media-catcher/tests/background-live-actions.test.js media-catcher/tests/popup-intent.test.js
```

Expected: FAIL because background dispatch remains legacy, popup keys by `item.url`, and controller job projections lack `mediaId`.

- [ ] **Step 5: Add safe media/job correlation**

Store `mediaId` on the existing private binding. When projecting a job, copy only this opaque ID into the input passed to `Privacy.projectPopupJob`; update both the immediate returned job and `popupJobs()`. Do not modify the scheduler's public job schema or store raw source data there.

- [ ] **Step 6: Route controller-owned actions before legacy branches**

After `settingsReady`, recognize controller ownership by a primitive opaque string ID and route the four methods above. Keep `record-live`, recording controls, YouTube, cast, open/reveal, update, folder picking, and numeric legacy cancellation unchanged. For legacy static VOD rows that have not been safely promoted, return a visible not-ready/unsupported error instead of invoking the old browser-save VOD functions.

When `set-settings` changes `maxConcurrentDownloads`, call `liveController.setMaxConcurrent` after the setting is accepted. `concurrency` and `retries` remain construction-time policy for this slice and take effect after the next background-page restart; do not silently mutate an in-flight scheduler through a second controller.

- [ ] **Step 7: Make popup rendering identity-safe**

Use `itemIdentity` and `job.mediaId || job.url` throughout item/progress correlation. Safe controller HLS/DASH rows download directly through their existing opaque variants; an empty variant list lets the assembler select deterministic best quality. Hide URL/command/cast actions for URL-free rows. Do not reintroduce URLs into background responses solely for presentation.

- [ ] **Step 8: Run GREEN and full JavaScript verification**

```powershell
node --test media-catcher/tests/background-live-actions.test.js media-catcher/tests/popup-intent.test.js media-catcher/tests/background-live-bootstrap.test.js media-catcher/tests/background-live-detection.test.js
node --test media-catcher/tests/*.test.js
node --check media-catcher/background.js
node --check media-catcher/popup/popup.js
node --check media-catcher/lib/background-adapters.js
node --check media-catcher/lib/privacy.js
git diff --check
```

- [ ] **Step 9: Commit**

```powershell
git add media-catcher/lib/background-adapters.js media-catcher/lib/privacy.js media-catcher/background.js media-catcher/popup/popup.js media-catcher/tests/popup-intent.test.js media-catcher/tests/background-live-actions.test.js
git commit -m "feat: route live popup downloads through policy"
```

---

### Task 5: Whole-slice runtime and privacy verification

**Files:**

- Modify only tests if a genuine missing public regression is discovered; production fixes require a RED first.

**Interfaces:**

- Consumes: Tasks 1–4.
- Produces: a reviewable live background slice ready for native packaging/install work.

- [ ] **Step 1: Run the bounded live integration scenario**

In the VM harness, complete one static HLS job from detection → snapshot → opaque popup row → explicit download → assembly → file-open/chunk/ack/commit. Assert completed safe job publication, no browser download, no raw URL in any popup/job/publication JSON, and queued independent-provider admission.

- [ ] **Step 2: Run the explicit fallback scenario**

Drive a second assembled HLS job to `needs_user`, click Use Firefox with a valid intent, and assert exactly one object URL download/revoke. Assert no automatic Firefox call occurred before the explicit message.

- [ ] **Step 3: Run complete JavaScript and syntax gates**

```powershell
node --test media-catcher/tests/*.test.js
Get-ChildItem media-catcher -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
git diff --check
git status --short
```

- [ ] **Step 4: Request whole-slice code review**

Review from the parent commit before Task 1 through Task 4 HEAD. Only confirmed Critical/Important runtime, privacy, or spec findings enter one consolidated repair pass. Quarantined harness material and every path outside the project boundary remain forbidden review inputs.
