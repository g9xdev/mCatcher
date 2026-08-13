# mCatcher Save As, Smart Filenames, and Provider-Aware Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mCatcher own the download experience: propose deterministic media filenames (Florenfile → `11238-makemebi.net.mp4`), freeze detection-time source context, enforce `maxConcurrentDownloads` with provider-aware saturation gates, replace silent Firefox handoff with structured native results / single-connection transfer / explicit user-selected Firefox, and preserve the requested filename through every engine path.

**Architecture:** Policy lives in pure dual-export JS modules under `media-catcher/lib/` that run under Node without browser globals. `background.js` adapts webRequest/content/native messages into those modules. The native host (`media-catcher-host/mchost/downloads.py`) is an execution worker + file sink only: it reports structured `pget-result` / sink acks and never chooses Firefox. Popup owns **Download** and **Save As…** UI and builds immutable `DownloadIntent` objects.

**Tech Stack:** Firefox MV2 extension (plain JS, no bundler), Node 24 built-in `node:test` for extension policy tests (no npm packages), Python 3 + `python -m pytest` for native host tests, existing native-messaging helper, PowerShell packaging via `Compress-Archive`.

## Global Constraints

- Extension version floor today is `1.9.0` in `media-catcher/manifest.json`; this work ships as **`1.10.0`** (stamp the same string into `media-catcher-host/mc_host.py` `VERSION` and `media-catcher-host/installer/media-catcher-host.iss` `#define AppVersion`).
- Do not add npm dependencies. Extension tests use Node built-ins only (`node:test`, `node:assert/strict`, `node:path`, `node:url`, `node:fs`).
- Do not add pip packages. Host tests use the existing `python -m pytest` layout with `conftest.py` `load_host()`.
- Dual-export every new pure module so background can load it as a classic script global and Node tests can `require()` / `import` it.
- Never persist full media URLs, signed query strings, cookies, or Authorization headers to `storage.local`, safe history, filename diagnostics, or logs.
- Never call `browser.downloads.download` except through the guarded Firefox adapter with `userSelectedFirefox === true` and popup-proven intent.
- `range_unsupported` must never trigger Firefox; it triggers native single-connection on the same job/slot/filename.
- `maxConcurrentDownloads` is a hard global admission cap; provider waits / retry backoff / needs_user / Save-As editing hold no global slot.
- Provider key comes from `sourceContext.topLevelSite`, never from CDN hostname alone.
- Ranker runs once at finalization; retries/engine changes reuse frozen `proposedFilename` / `requestedFilename`.
- Keep existing settings keys (`maxConcurrentDownloads`, `concurrency`, `retries`, `filenameTemplate`, `saveFolder`); no settings migration.
- PowerShell is the shell. Prefer `Set-Location` + `python -m pytest` / `node --test` forms that work from the repo root.
- Project containment is absolute: all mCatcher worktrees, prompts, briefs, reports, test artifacts, packages, and installation inputs must live under `C:\Code\mCatcher`. `C:\Code\GrokOrchestration` was never a valid mCatcher project root and must not be used as a source, destination, recovery input, or verification path.
- Quarantined BA07/BA08 and native-host harness attempts are outside this goal. They are not requirements, source material, test evidence, or completion criteria; only accepted code and behavior-focused tests in the contained mCatcher worktree count.
- Do not rewrite unrelated cast/update/recording code. Touch only the files listed per task.
- Commits are required at the end of each task. Do not amend published history.

### Shared public interfaces (locked for all tasks)

These names and property shapes are the cross-task contract. Later tasks must not invent alternate names.

```js
// Candidate kinds (FilenameRanker / SourceContext)
const CANDIDATE_KINDS = [
  "content-disposition",
  "visible-filename",
  "download-attr",
  "media-metadata",
  "page-url",
  "referrer-url",
  "og-title",
  "twitter-title",
  "heading",
  "document-title",
  "media-url",
];

// SourceContext (immutable, version: 1)
{
  version: 1,
  capturedAt: string,            // ISO-8601
  tabId: number,
  documentId: string | null,
  frameId: number,
  topLevelPageUrl: string,
  topLevelSite: string,          // e.g. "florenfile.com"
  immediateReferrerUrl: string,
  frameOrigin: string,
  mediaOrigin: string,
  filenameCandidates: Array<{ kind: string, value: string }>
}

// FilenameRanker.rank(input) ->
{
  proposedFilename: string,      // e.g. "11238-makemebi.net.mp4"
  winner: { kind: string, value: string, score: number } | null,
  rejected: Array<{ kind: string, value: string, reason: string }>,
  diagnostics: { scores: Array<{ kind: string, value: string, score: number }> }
}

// DownloadIntent (immutable)
{
  requestedFilename: string,
  destinationDirectory: string | null,
  saveMode: "default" | "save-as",
  userSelectedFirefox: boolean,
  // proof that popup created the intent; never forgeable by native handlers
  userActionToken: string,       // opaque nonce issued by popup path only
  createdAt: string
}

// EphemeralRequestContext (non-serializable; in-memory only)
{
  mediaUrl: string,
  requestHeaders: Object | null, // may include Cookie for native transfer only
  clear(): void
}

// Provider identity
providerKeyFromSite(site: string) -> string   // lowercased, strip leading www.
// Florenfile fixture => "florenfile.com"

// ProviderRegistry (session-only)
observe(mediaOrigin: string, providerKey: string): void
lookup(mediaOrigin: string): { status: "none" | "one" | "ambiguous", providerKey: string | null }
clear(): void

// Failure categories (native + browser normalize to these strings)
// "timeout" | "connection_reset" | "short_read" | "http_429" |
// "http_5xx_temporary" | "range_unsupported" | "local_io" |
// "cancelled" | "permanent"

// Job states
// "created" | "queued" | "running" | "pausing_provider" | "waiting_provider" |
// "retry_backoff" | "needs_user" | "handing_off_firefox" | "handed_to_firefox" |
// "completed" | "failed" | "cancelled"

// DownloadScheduler public API
createJob({ id, providerKey, intent, ephemeral, mediaKind, segmentConcurrency, retries }): Job
enqueue(jobId): void
setMaxConcurrent(n: number): void
cancel(jobId): void
onTransportResult(jobId, attemptToken, result): void
onCapabilitySwitch(jobId, { mode, partState }): void
onQuiesced(jobId): void
notePermitAcquired(jobId): void
releasePermit(jobId): void
// Sole ProviderGate wrapper for background/segment/probe fetches.
// Returns generation-bound Permit; Permit.release is idempotent and only
// decrements if the permit's generation still matches the gate generation.
acquireProviderPermit(jobId, purpose): Permit | null
// Permit = { release(): void, generation: number, jobId: string, purpose: string }
issueAttemptToken(jobId): string
manualRetry(jobId): void
// Only scheduler API that may hand work to Firefox. Requires intent.userSelectedFirefox
// === true AND intent.userActionToken present in the one-time popup token store for this job.
// Rejects false/missing/forged/replayed tokens without calling downloads.download.
// Releases mCatcher global slot + provider permits exactly once, then calls the guarded adapter.
// API rejection → needs_user (no slot). Success → handed_to_firefox (terminal to scheduler).
requestFirefoxHandoff(jobId, intent): Promise<void>
getJob(jobId): JobView
tick(nowMs: number): void
getSnapshot(): { jobs: JobView[], globalRunning: number, providers: Object }
// JobView includes: autoWakeCount (number; increments exactly once per authorized saturation wake)

// EphemeralRequestContext terminal cleanup (mandatory)
// Call ephemeral.clear() exactly once on each terminal transition:
//   completed | failed | cancelled | handed_to_firefox
// Storage, safe history, popup snapshots, and diagnostics MUST use allowlist projectors
// (projectSafeHistory / projectPopupJob / redactUrlForLog). Never JSON.stringify a job/item
// that still holds ephemeral, and never serialize the ephemeral object itself.

// Native pget / pget-single / file-open payload fields (filename + destination)
// pget / pget-single always carry:
//   name: intent.requestedFilename
//   dir: intent.destinationDirectory   // null when default/settings saveFolder applies
// file-open always carries:
//   requestedFilename: intent.requestedFilename
//   dir: intent.destinationDirectory   // null when default/settings saveFolder applies
// Default intents set destinationDirectory: null (host/settings resolve saveFolder).
// Save-As intents set destinationDirectory to the helper-selected directory or null.

// Dual-export browser global names (locked — every pure module must assign exactly one)
const GLOBAL_EXPORT_MAP = {
  "lib/filename-ranker.js": "McFilenameRanker",
  "lib/source-context.js": "McSourceContext",
  "lib/detection-finalizer.js": "McDetectionFinalizer",
  "lib/download-intent.js": "McDownloadIntent",
  "lib/provider-registry.js": "McProviderRegistry",
  "lib/failure-classify.js": "McFailureClassify",
  "lib/provider-gate.js": "McProviderGate",
  "lib/download-scheduler.js": "McDownloadScheduler",
  "lib/native-result-adapter.js": "McNativeResultAdapter",
  "lib/file-sink-protocol.js": "McFileSinkProtocol",
  "lib/firefox-guard.js": "McFirefoxGuard",
  "lib/privacy.js": "McPrivacy",
  "lib/popup-download-ui.js": "McPopupDownloadUi",
  "lib/download-message-router.js": "McDownloadMessageRouter",
};

// Native pget-result
{
  type: "pget-result",
  id: string,
  attemptToken: string,
  status: "completed" | "failed" | "cancelled",
  mode: "multi-range" | "single-connection",
  failureCategory: null | string,
  partState: "committed" | "empty" | "partial"
}

// Native lease / limit
// cmd: "pget" | "pget-single" | "pget-set-limit" | "pget-cancel"
// file sink cmds: "file-open" | "file-chunk" | "file-commit" | "file-abort"
```

### File inventory (create / modify / test)

| Path | Role |
| --- | --- |
| `media-catcher/lib/module-export.js` | Shared dual-export helper used by new modules (optional thin util; modules may inline the IIFE if preferred) |
| `media-catcher/lib/filename-ranker.js` | Pure ranker + sanitizer + wrapper extension strip → `McFilenameRanker` |
| `media-catcher/lib/source-context.js` | Build, deep-clone, recursive freeze, providerKey → `McSourceContext` |
| `media-catcher/lib/detection-finalizer.js` | Pending detection IDs, 750 ms wait, documentId races → `McDetectionFinalizer` |
| `media-catcher/lib/download-intent.js` | Intent factory + sanitize-on-confirm → `McDownloadIntent` |
| `media-catcher/lib/provider-registry.js` | Session CDN→provider multimap → `McProviderRegistry` |
| `media-catcher/lib/failure-classify.js` | Normalize transport errors to categories + saturation predicate → `McFailureClassify` |
| `media-catcher/lib/provider-gate.js` | Permits, generations, saturated/recovering, native lease limits → `McProviderGate` |
| `media-catcher/lib/download-scheduler.js` | Global admission, states, retries, wake, CAS, `acquireProviderPermit`, `requestFirefoxHandoff` → `McDownloadScheduler` |
| `media-catcher/lib/native-result-adapter.js` | Map structured pget-result into scheduler (no Firefox) → `McNativeResultAdapter` |
| `media-catcher/lib/firefox-guard.js` | Only path that may call downloads API → `McFirefoxGuard` |
| `media-catcher/lib/privacy.js` | Allowlist projectors + redaction helpers + sentinel checks → `McPrivacy` |
| `media-catcher/lib/file-sink-protocol.js` | Pure state machine for sink open/chunk/commit/abort + attempt tokens → `McFileSinkProtocol` |
| `media-catcher/lib/popup-download-ui.js` | Popup status labels + Download/Save As pure helpers → `McPopupDownloadUi` |
| `media-catcher/lib/download-message-router.js` | Pure native/popup message routing decisions → `McDownloadMessageRouter` |
| `media-catcher/lib/filename.js` | Keep existing template renderer; do not repurpose for ranking |
| `media-catcher/background.js` | Wire detection, scheduler, native results, remove pget-fallback Firefox |
| `media-catcher/content.js` | Document-scoped snapshot candidates + document nonce + documentId |
| `media-catcher/popup/popup.js` | Download + Save As form; intents; status labels |
| `media-catcher/popup/popup.html` | Save As form markup host (if needed) |
| `media-catcher/popup/popup.css` | Save As form styles |
| `media-catcher/options/options.html` | Help text for Parallel downloads / retries |
| `media-catcher/manifest.json` | Script order (includes every dual-export lib above) + version `1.10.0` |
| `media-catcher/tests/*.test.js` | Node policy tests |
| `media-catcher/tests/fixtures/florenfile-candidates.json` | Acceptance fixture candidates |
| `media-catcher-host/mchost/downloads.py` | Structured pget, single-connection, file sink, leases |
| `media-catcher-host/mc_host.py` | Dispatch new cmds; VERSION |
| `media-catcher-host/test_pget.py` | Native range / single-connection / result categories |
| `media-catcher-host/test_file_sink.py` | Native chunked sink atomicity / abort |
| `media-catcher-host/installer/media-catcher-host.iss` | AppVersion stamp |

### Dual-export module skeleton (copy into every new pure module)

Always assign **both** `module.exports` (when present) and the locked root global. Node tests and Firefox classic scripts then share one factory. Smoke tests load via `vm` with a fake `self`/`root` and assert the mapped global name.

```js
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  // Always set the locked browser global (see GLOBAL_EXPORT_MAP).
  if (root) root.McFilenameRanker = api;
})(
  typeof self !== "undefined" ? self :
  (typeof globalThis !== "undefined" ? globalThis : this),
  function () {
  "use strict";
  // implementation
  return { /* public API */ };
});
```

### Spec → task coverage map

| Spec requirement / mandatory test | Task |
| --- | --- |
| Florenfile fixture → `11238-makemebi.net.mp4`; reject `Florenfile.com - Secure Cloud Storage` | 2 |
| Ranker weights, media extension +15/+40, wrapper `.mp4.html` strip, sanitization, propose-once diagnostics | 2 |
| Immutable SourceContext shape + recursive freeze + providerKey from topLevelSite | 3 |
| Detection transaction, 750 ms wait, documentId races, missing documentId exact-URL reuse only, concurrent detectionIds, `finalizeFromDom` | 4 |
| Dual-export global name map smoke for every pure module | 1, 22 |
| Download / Save As intent; cancel creates no job; Save-As editing consumes no scheduler slot | 5, 11, 18 |
| Same provider / different CDN share throttle group; registry 0/1/many | 6, 10 |
| Failure categories via normalizeBrowserError/normalizeNativeFailure; saturation only with active sibling; no sibling → bounded retry | 7, 10 |
| Provider permits/leases; `acquireProviderPermit` sole wrapper; drain owner; reduce concurrency; waiting_provider | 8, 10 |
| Hard global `maxConcurrentDownloads`; lower limit no cancel; independent providers concurrent | 9, 10, 11 |
| Finite retries; wake charges failed waiter only; paused siblings free; needs_user releases slot; CAS double-release | 11 |
| `requestFirefoxHandoff` token rules, slot release, API reject → needs_user | 11, 17 |
| Structured `pget-result`; genuine no-range → single-connection; transient ≠ no-range; empty partState | 12, 13 |
| Extension never auto-Firefox on native fail; range switch keeps job/slot/filename, no retry burn | 14 |
| HLS/DASH file sink atomic commit/abort; local_io; attempt tokens | 15, 16 |
| Filename + destinationDirectory on pget / pget-single / file-open; default intent dir null | 16, 20 |
| Guarded Firefox adapter; helper unavailable shows but does not invoke Firefox | 17, 18 |
| Popup Download + Save As UI + full status label table | 18 |
| Privacy sentinels; safe history allowlist; ephemeral terminal clear | 19 |
| Wire background end-to-end; message router; documentId correlation; privacy projectors; remove silent `pget-fallback` | 20 |
| Options help text for queue | 21 |
| Full regression suite + packaging + manual Firefox DE checklist | 22, 23, 24 |

---

### Task 1: Extension test harness and dual-export smoke

**Files:**
- Create: `media-catcher/tests/harness/load-lib.js`
- Create: `media-catcher/tests/smoke.test.js`
- Create: `media-catcher/lib/mc-export-check.js` (tiny dual-export canary used only for harness proof; deleted in Task 2 if undesired — prefer keeping as pattern reference under tests instead)
- Prefer: create harness only + one real module in Task 2; this task proves `node --test` from repo root.

**Interfaces:**
- Consumes: Node 24 built-ins only
- Produces: `loadLib(relativePathFromMediaCatcher)` helper resolving dual-export modules

- [ ] **Step 1: Write the failing test**

Create `media-catcher/tests/harness/load-lib.js`:

```js
"use strict";
const path = require("node:path");
const mediaCatcherRoot = path.resolve(__dirname, "..", "..");

function loadLib(relFromMediaCatcher) {
  const abs = path.join(mediaCatcherRoot, relFromMediaCatcher);
  delete require.cache[require.resolve(abs)];
  return require(abs);
}

module.exports = { loadLib, mediaCatcherRoot };
```

Create `media-catcher/tests/smoke.test.js`:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const { mediaCatcherRoot, loadLib } = require("./harness/load-lib.js");

// Locked dual-export global names (must match plan GLOBAL_EXPORT_MAP).
const GLOBAL_EXPORT_MAP = {
  "lib/filename-ranker.js": "McFilenameRanker",
  "lib/source-context.js": "McSourceContext",
  "lib/detection-finalizer.js": "McDetectionFinalizer",
  "lib/download-intent.js": "McDownloadIntent",
  "lib/provider-registry.js": "McProviderRegistry",
  "lib/failure-classify.js": "McFailureClassify",
  "lib/provider-gate.js": "McProviderGate",
  "lib/download-scheduler.js": "McDownloadScheduler",
  "lib/native-result-adapter.js": "McNativeResultAdapter",
  "lib/file-sink-protocol.js": "McFileSinkProtocol",
  "lib/firefox-guard.js": "McFirefoxGuard",
  "lib/privacy.js": "McPrivacy",
  "lib/popup-download-ui.js": "McPopupDownloadUi",
  "lib/download-message-router.js": "McDownloadMessageRouter",
};

function loadOntoFakeRoot(relFromMediaCatcher) {
  const abs = path.join(mediaCatcherRoot, relFromMediaCatcher);
  const code = fs.readFileSync(abs, "utf8");
  const root = {};
  const sandbox = { module: { exports: {} }, exports: {}, require, console, self: root };
  sandbox.module.exports = sandbox.exports;
  // Dual-export modules must assign BOTH module.exports and root.Mc* global.
  vm.runInNewContext(code, sandbox, { filename: abs });
  return { root, nodeExport: sandbox.module.exports };
}

test("media-catcher root contains manifest.json", () => {
  const mf = path.join(mediaCatcherRoot, "manifest.json");
  assert.equal(fs.existsSync(mf), true);
});

test("filename-ranker module is loadable (will fail until Task 2 creates it)", () => {
  const p = path.join(mediaCatcherRoot, "lib", "filename-ranker.js");
  assert.equal(fs.existsSync(p), true, "lib/filename-ranker.js must exist");
});

test("filename-ranker dual-export assigns locked McFilenameRanker global", () => {
  const { root, nodeExport } = loadOntoFakeRoot("lib/filename-ranker.js");
  assert.equal(typeof nodeExport.rank, "function");
  assert.equal(typeof root.McFilenameRanker.rank, "function");
  assert.equal(root.McFilenameRanker, nodeExport);
});

// Full-map coverage for every dual-export module is Task 22 (global-export-map.test.js).
// Do not module.exports from this test file — node:test owns the module.
```

Keep harness export as:

```js
module.exports = { loadLib, mediaCatcherRoot };
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
$RepoRoot = git rev-parse --show-toplevel
Set-Location $RepoRoot
node --test media-catcher/tests/smoke.test.js
```

Expected: FAIL — `lib/filename-ranker.js must exist` (or dual-export smoke fails on missing file). First test may pass.

- [ ] **Step 3: Write minimal stub so harness is green without ranking logic**

Create `media-catcher/lib/filename-ranker.js` dual-export stub:

```js
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.McFilenameRanker = api;
})(
  typeof self !== "undefined" ? self :
  (typeof globalThis !== "undefined" ? globalThis : this),
  function () {
  "use strict";
  function rank() {
    throw new Error("FilenameRanker.rank not implemented");
  }
  return { rank, MEDIA_EXT_RE: /\.(mp4|m4v|webm|mkv|mov|mp3|m4a|aac|flac|ogg|opus|ts|m2ts|mpeg|mpg)$/i };
});
```

- [ ] **Step 4: Run test to verify harness passes**

```powershell
node --test media-catcher/tests/smoke.test.js
```

Expected: PASS (3 tests: manifest, file exists, dual-export global).

- [ ] **Step 5: Commit**

```powershell
git add media-catcher/tests/harness/load-lib.js media-catcher/tests/smoke.test.js media-catcher/lib/filename-ranker.js
git commit -m "test: add Node extension test harness and filename-ranker stub"
```

---

### Task 2: FilenameRanker with Florenfile acceptance fixture

**Files:**
- Modify: `media-catcher/lib/filename-ranker.js`
- Create: `media-catcher/tests/fixtures/florenfile-candidates.json`
- Create: `media-catcher/tests/filename-ranker.test.js`

**Interfaces:**
- Consumes: dual-export skeleton from Task 1
- Produces:
  - `rank({ candidates, providerSite, mediaType, capturedAt, knownExtension })`
  - `sanitizeFilename(name, { maxLen })`
  - `stripWrapperExtension(name)`
  - `normalizeToken(s)`
  - Base weights exactly as design table
  - Output `proposedFilename` + diagnostics without cookies/signed queries

- [ ] **Step 1: Write the failing tests**

`media-catcher/tests/fixtures/florenfile-candidates.json`:

```json
{
  "pageUrl": "https://florenfile.com/qnzjnabo3jec/11238-makemebi.net.mp4.html",
  "providerSite": "florenfile.com",
  "knownExtension": ".mp4",
  "candidates": [
    { "kind": "document-title", "value": "Florenfile.com - Secure Cloud Storage" },
    { "kind": "og-title", "value": "Florenfile.com - Secure Cloud Storage" },
    { "kind": "page-url", "value": "/qnzjnabo3jec/11238-makemebi.net.mp4.html" },
    { "kind": "media-url", "value": "video.mp4" },
    { "kind": "visible-filename", "value": "11238-makemebi.net.mp4" }
  ],
  "expectedProposedFilename": "11238-makemebi.net.mp4"
}
```

`media-catcher/tests/filename-ranker.test.js` (mutation names in comments):

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadLib } = require("./harness/load-lib.js");
const Ranker = loadLib("lib/filename-ranker.js");
const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, "fixtures", "florenfile-candidates.json"), "utf8"));

test("Florenfile fixture proposes exact 11238-makemebi.net.mp4 and rejects brand title", () => {
  // Mutation: choosing document-title first, or failing to strip .html wrapper.
  const out = Ranker.rank({
    candidates: fixture.candidates,
    providerSite: fixture.providerSite,
    knownExtension: fixture.knownExtension,
    mediaType: "video",
    capturedAt: "2026-08-12T12:00:00.000Z",
  });
  assert.equal(out.proposedFilename, "11238-makemebi.net.mp4");
  assert.ok(out.rejected.some((r) =>
    /florenfile\.com - secure cloud storage/i.test(r.value) && r.reason));
});

test("wrapper extension strip only when media extension precedes page extension", () => {
  // Mutation: always stripping last extension → "11238-makemebi.net".
  assert.equal(Ranker.stripWrapperExtension("11238-makemebi.net.mp4.html"), "11238-makemebi.net.mp4");
  assert.equal(Ranker.stripWrapperExtension("report.html"), "report.html");
});

test("content-disposition outranks generic document title", () => {
  const out = Ranker.rank({
    candidates: [
      { kind: "document-title", value: "Watch now" },
      { kind: "content-disposition", value: "episode-12.mp4" },
    ],
    providerSite: "example.com",
    knownExtension: ".mp4",
  });
  assert.equal(out.proposedFilename, "episode-12.mp4");
});

test("generic basenames video.mp4 and master.m3u8 are rejected", () => {
  const out = Ranker.rank({
    candidates: [
      { kind: "media-url", value: "video.mp4" },
      { kind: "media-url", value: "master.m3u8" },
      { kind: "page-url", value: "/films/ocean-doc.mp4" },
    ],
    providerSite: "cdn.example",
    knownExtension: ".mp4",
  });
  assert.equal(out.proposedFilename, "ocean-doc.mp4");
});

test("sanitize removes reserved path characters and trailing dots/spaces", () => {
  // Mutation: leaving "con:.mp4 " intact.
  assert.equal(Ranker.sanitizeFilename('a/b:c*?.mp4 '), "a_b_c__.mp4");
});

test("user extension empty → append knownExtension; different ext not silently replaced", () => {
  assert.equal(Ranker.ensureExtension("myvideo", ".mp4"), "myvideo.mp4");
  assert.equal(Ranker.ensureExtension("myvideo.mkv", ".mp4"), "myvideo.mkv");
});

test("diagnostics never include query strings", () => {
  const out = Ranker.rank({
    candidates: [
      { kind: "media-url", value: "clip.mp4?token=SECRET_SIGNED_VALUE&e=1" },
      { kind: "visible-filename", value: "clip.mp4" },
    ],
    providerSite: "x.test",
    knownExtension: ".mp4",
  });
  const blob = JSON.stringify(out);
  assert.equal(blob.includes("SECRET_SIGNED_VALUE"), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```powershell
node --test media-catcher/tests/filename-ranker.test.js
```

Expected: FAIL — `FilenameRanker.rank not implemented` or wrong proposal.

- [ ] **Step 3: Implement ranker**

Replace stub in `media-catcher/lib/filename-ranker.js` with full pure implementation that:

1. Defines `BASE_WEIGHTS`:
   - content-disposition 110
   - visible-filename 100
   - download-attr 100
   - media-metadata 90
   - page-url 80
   - referrer-url 80
   - og-title 75
   - twitter-title 75
   - heading 70
   - document-title 65
   - media-url 45
2. `stripWrapperExtension`: if name matches `/^(.+\.(mp4|m4v|webm|mkv|mov|mp3|m4a|…))\.(html?|php|aspx?)$/i`, return group 1.
3. Normalize candidates: trim, max length 180, case-insensitive dedupe, strip volatile query from media-url values before scoring (do not store raw query in diagnostics).
4. Score: base + 40 if recognized media extension + up to 20 for video-ish tokens (`mp4`, `makemebi`, numeric id patterns) + 15 if two independent kinds normalize-equal.
5. Penalties / reject: provider brand equality; generic slogans list including `secure cloud storage`, `download`, `watch online`; separators brand patterns; generic basenames set `{video,master,playlist,index,download}` with media ext; titles whose every token is in the provider brand token set.
6. Tie-break: higher base-weight table order, then lexical normalized value.
7. Fallback if all rejected: `video-YYYYMMDD-HHmmss.mp4` (or mediaType-based) from `capturedAt`.
8. `sanitizeFilename`: replace `[\\/:*?"<>|]` and control chars with `_`, strip trailing `. ` and spaces, cap length preserving extension (default max 150).
9. Export `{ rank, sanitizeFilename, stripWrapperExtension, ensureExtension, normalizeToken, BASE_WEIGHTS, GENERIC_BASENAMES }`.

Implementation requirements (complete algorithm — do not leave branches unhandled):

```js
function rank(input) {
  input = input || {};
  var providerSite = String(input.providerSite || "");
  var providerTokens = tokenSet(providerSite);
  var knownExt = input.knownExtension || "";
  var rejected = [];
  var seen = Object.create(null);
  var scored = [];
  var list = [];
  (input.candidates || []).forEach(function (c) {
    var kind = String(c.kind || "");
    var value = stripWrapperExtension(stripQuery(String(c.value || "").trim()));
    if (!value) return;
    var key = kind + "\0" + value.toLowerCase();
    if (seen[key]) return;
    seen[key] = true;
    list.push({ kind: kind, value: value });
  });
  // agreement bonus uses normalized values across independent kinds
  var normCounts = Object.create(null);
  list.forEach(function (c) {
    var n = normalizeToken(c.value);
    normCounts[n] = (normCounts[n] || 0) + 1;
  });
  list.forEach(function (c) {
    var reason = rejectReason(c, providerSite, providerTokens);
    if (reason) {
      rejected.push({ kind: c.kind, value: c.value, reason: reason });
      return;
    }
    var score = (BASE_WEIGHTS[c.kind] || 0);
    if (MEDIA_EXT_RE.test(c.value)) score += 40;
    score += Math.min(20, videoTokenBonus(c.value));
    if (normCounts[normalizeToken(c.value)] >= 2) score += 15;
    score -= brandPenalty(c, providerTokens);
    scored.push({ kind: c.kind, value: c.value, score: score, tableOrder: TABLE_ORDER.indexOf(c.kind) });
  });
  scored.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    if (a.tableOrder !== b.tableOrder) return a.tableOrder - b.tableOrder;
    return normalizeToken(a.value) < normalizeToken(b.value) ? -1 : 1;
  });
  var winnerObj = scored.length ? scored[0] : null;
  var winnerValue = winnerObj
    ? ensureExtension(winnerObj.value, knownExt)
    : fallbackName(input.mediaType, input.capturedAt, knownExt);
  return {
    proposedFilename: sanitizeFilename(winnerValue),
    winner: winnerObj,
    rejected: rejected,
    diagnostics: { scores: scored.map(function (s) {
      return { kind: s.kind, value: s.value, score: s.score };
    }) }
  };
}
```

Also implement helpers used above: `stripQuery`, `tokenSet`, `rejectReason` (brand / slogan / generic basename), `videoTokenBonus`, `brandPenalty`, `fallbackName`, `TABLE_ORDER` matching the weight table order.

- [ ] **Step 4: Run tests to verify they pass**

```powershell
node --test media-catcher/tests/filename-ranker.test.js media-catcher/tests/smoke.test.js
```

Expected: PASS. Confirm hand-derived expectation `11238-makemebi.net.mp4` is exact.

- [ ] **Step 5: Self-review**

Confirm generic brand rejection is data-driven (provider tokens + phrase list), not a Florenfile-only hardcode of the full winning filename as the only return path.

- [ ] **Step 6: Commit**

```powershell
git add media-catcher/lib/filename-ranker.js media-catcher/tests/filename-ranker.test.js media-catcher/tests/fixtures/florenfile-candidates.json
git commit -m "feat: add deterministic FilenameRanker with Florenfile fixture"
```

---

### Task 3: SourceContext builder, freeze, provider key

**Files:**
- Create: `media-catcher/lib/source-context.js`
- Create: `media-catcher/tests/source-context.test.js`

**Interfaces:**
- Consumes: none
- Produces:
  - `buildSourceContext(parts) -> frozen SourceContext`
  - `deepFreeze(obj)`
  - `providerKeyFromSite(site) -> string`
  - `hostnameFromUrl(url) -> string`

- [ ] **Step 1: Write the failing tests**

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");
const SC = loadLib("lib/source-context.js");

test("providerKeyFromSite lowercases and strips www", () => {
  // Mutation: using media CDN host or leaving www.
  assert.equal(SC.providerKeyFromSite("www.FlorenFile.com"), "florenfile.com");
});

test("buildSourceContext freezes recursively and deep-clones candidates", () => {
  const rawCand = { kind: "visible-filename", value: "11238-makemebi.net.mp4" };
  const ctx = SC.buildSourceContext({
    capturedAt: "2026-08-12T12:34:56.789Z",
    tabId: 42,
    documentId: "doc-1",
    frameId: 0,
    topLevelPageUrl: "https://florenfile.com/qnzjnabo3jec/11238-makemebi.net.mp4.html",
    immediateReferrerUrl: "https://florenfile.com/qnzjnabo3jec/11238-makemebi.net.mp4.html",
    frameOrigin: "https://florenfile.com",
    mediaOrigin: "https://s40.example-cdn.invalid",
    filenameCandidates: [rawCand],
  });
  assert.equal(ctx.version, 1);
  assert.equal(ctx.topLevelSite, "florenfile.com");
  assert.equal(ctx.mediaOrigin, "https://s40.example-cdn.invalid");
  assert.throws(() => { ctx.topLevelSite = "evil.com"; });
  assert.throws(() => { ctx.filenameCandidates.push({ kind: "x", value: "y" }); });
  assert.throws(() => { ctx.filenameCandidates[0].value = "mutated"; });
  rawCand.value = "mutated-source";
  assert.equal(ctx.filenameCandidates[0].value, "11238-makemebi.net.mp4");
});

test("missing topLevelPageUrl yields empty topLevelSite rather than CDN host", () => {
  const ctx = SC.buildSourceContext({
    capturedAt: "2026-08-12T12:34:56.789Z",
    tabId: 1,
    documentId: null,
    frameId: 0,
    topLevelPageUrl: "",
    immediateReferrerUrl: "",
    frameOrigin: "",
    mediaOrigin: "https://cdn.example/a.mp4",
    filenameCandidates: [],
  });
  assert.equal(ctx.topLevelSite, "");
});
```

- [ ] **Step 2: Run to verify fail**

```powershell
node --test media-catcher/tests/source-context.test.js
```

Expected: FAIL — cannot find module / missing API.

- [ ] **Step 3: Implement `source-context.js`**

```js
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.McSourceContext = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function deepFreeze(o) {
    if (!o || typeof o !== "object" || Object.isFrozen(o)) return o;
    Object.getOwnPropertyNames(o).forEach(function (k) {
      var v = o[k];
      if (v && typeof v === "object") deepFreeze(v);
    });
    return Object.freeze(o);
  }

  function hostnameFromUrl(url) {
    try { return new URL(url).hostname; } catch (e) { return ""; }
  }

  function providerKeyFromSite(site) {
    var s = String(site || "").trim().toLowerCase();
    if (s.indexOf("www.") === 0) s = s.slice(4);
    return s;
  }

  function buildSourceContext(parts) {
    parts = parts || {};
    var topUrl = String(parts.topLevelPageUrl || "");
    var site = providerKeyFromSite(parts.topLevelSite || hostnameFromUrl(topUrl));
    var cands = (parts.filenameCandidates || []).map(function (c) {
      return { kind: String(c.kind || ""), value: String(c.value || "") };
    });
    var ctx = {
      version: 1,
      capturedAt: String(parts.capturedAt || new Date().toISOString()),
      tabId: parts.tabId | 0,
      documentId: parts.documentId == null ? null : String(parts.documentId),
      frameId: parts.frameId | 0,
      topLevelPageUrl: topUrl,
      topLevelSite: site,
      immediateReferrerUrl: String(parts.immediateReferrerUrl || ""),
      frameOrigin: String(parts.frameOrigin || ""),
      mediaOrigin: String(parts.mediaOrigin || ""),
      filenameCandidates: cands,
    };
    return deepFreeze(ctx);
  }

  return { buildSourceContext: buildSourceContext, deepFreeze: deepFreeze,
           providerKeyFromSite: providerKeyFromSite, hostnameFromUrl: hostnameFromUrl };
});
```

- [ ] **Step 4: Run tests**

```powershell
node --test media-catcher/tests/source-context.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add media-catcher/lib/source-context.js media-catcher/tests/source-context.test.js
git commit -m "feat: add immutable SourceContext builder and providerKey helper"
```

---

### Task 4: Detection finalizer (navigation races, documentId rules)

**Files:**
- Create: `media-catcher/lib/detection-finalizer.js`
- Create: `media-catcher/tests/detection-finalizer.test.js`

**Interfaces:**
- Consumes: `McSourceContext`, `McFilenameRanker`
- Produces:
  - `createDetectionFinalizer({ now, requestContext, rank, buildSourceContext, waitMs })`
  - Methods: `beginNetworkDetection(event)`, `provideDocumentSnapshot(snapshot)`, `finalizeFromDom(input)`, `tick(now)`, `getItem(detectionId)`, `listFinalized()`
  - `mapWebRequestDetails(details, hints) -> event` (pure adapter helper; copies `documentId` or null)
  - Constants: `CONTEXT_WAIT_MS = 750`
  - Pending detections never exposed; finalized items have frozen `sourceContext` + `proposedFilename`
  - Dual-export global: `McDetectionFinalizer`

Event shape:

```js
{
  detectionId: number, // assigned by finalizer if omitted
  documentId: string | null,
  tabId: number,
  frameId: number,
  documentUrl: string,
  topLevelUrlHint: string,
  mediaUrl: string,
  mediaOrigin: string,
  contentDisposition: string | null,
  referrerUrl: string,
  frameOrigin: string,
  ts: number
}
```

Snapshot shape:

```js
{
  documentId: string,
  tabId: number,
  frameId: number,
  pageUrl: string,
  topLevelPageUrl: string,
  documentNonce: string,
  candidates: Array<{kind,value}>,
  capturedAt: string
}
```

- [ ] **Step 1: Write failing tests**

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");
const Ranker = loadLib("lib/filename-ranker.js");
const SC = loadLib("lib/source-context.js");
const { createDetectionFinalizer } = loadLib("lib/detection-finalizer.js");

function make(clock) {
  return createDetectionFinalizer({
    now: () => clock.t,
    waitMs: 750,
    rank: Ranker.rank,
    buildSourceContext: SC.buildSourceContext,
  });
}

test("ignores context response from a different documentId", async () => {
  // Mutation: merging any tabId match.
  const clock = { t: 1000 };
  const f = make(clock);
  const id = f.beginNetworkDetection({
    documentId: "doc-A", tabId: 1, frameId: 0,
    documentUrl: "https://florenfile.com/a", topLevelUrlHint: "https://florenfile.com/a",
    mediaUrl: "https://cdn/x.mp4", mediaOrigin: "https://cdn",
    contentDisposition: null, referrerUrl: "https://florenfile.com/a",
    frameOrigin: "https://florenfile.com", ts: 1000,
  });
  f.provideDocumentSnapshot({
    documentId: "doc-B", tabId: 1, frameId: 0,
    pageUrl: "https://other/", topLevelPageUrl: "https://other/",
    documentNonce: "n1",
    candidates: [{ kind: "document-title", value: "Wrong page" }],
    capturedAt: "2026-08-12T12:00:00.000Z",
  });
  assert.equal(f.getItem(id), null); // still pending
  clock.t = 2000;
  f.tick(clock.t);
  const item = f.getItem(id);
  assert.ok(item);
  assert.notEqual(item.proposedFilename, "Wrong page");
});

test("ignores late matching snapshot after finalization", () => {
  // Mutation: overwriting proposedFilename on late response.
  const clock = { t: 0 };
  const f = make(clock);
  const id = f.beginNetworkDetection({
    documentId: "doc-A", tabId: 2, frameId: 0,
    documentUrl: "https://florenfile.com/qnzjnabo3jec/11238-makemebi.net.mp4.html",
    topLevelUrlHint: "https://florenfile.com/qnzjnabo3jec/11238-makemebi.net.mp4.html",
    mediaUrl: "https://s40.example-cdn.invalid/file.mp4",
    mediaOrigin: "https://s40.example-cdn.invalid",
    contentDisposition: null,
    referrerUrl: "https://florenfile.com/qnzjnabo3jec/11238-makemebi.net.mp4.html",
    frameOrigin: "https://florenfile.com", ts: 0,
  });
  f.provideDocumentSnapshot({
    documentId: "doc-A", tabId: 2, frameId: 0,
    pageUrl: "https://florenfile.com/qnzjnabo3jec/11238-makemebi.net.mp4.html",
    topLevelPageUrl: "https://florenfile.com/qnzjnabo3jec/11238-makemebi.net.mp4.html",
    documentNonce: "n",
    candidates: [
      { kind: "document-title", value: "Florenfile.com - Secure Cloud Storage" },
      { kind: "page-url", value: "/qnzjnabo3jec/11238-makemebi.net.mp4.html" },
      { kind: "visible-filename", value: "11238-makemebi.net.mp4" },
    ],
    capturedAt: "2026-08-12T12:00:00.000Z",
  });
  const first = f.getItem(id).proposedFilename;
  assert.equal(first, "11238-makemebi.net.mp4");
  f.provideDocumentSnapshot({
    documentId: "doc-A", tabId: 2, frameId: 0,
    pageUrl: "https://florenfile.com/qnzjnabo3jec/11238-makemebi.net.mp4.html",
    topLevelPageUrl: "https://florenfile.com/navigated-away",
    documentNonce: "n2",
    candidates: [{ kind: "document-title", value: "Navigated Brand" }],
    capturedAt: "2026-08-12T12:01:00.000Z",
  });
  assert.equal(f.getItem(id).proposedFilename, first);
  assert.equal(f.getItem(id).sourceContext.topLevelPageUrl.endsWith("mp4.html"), true);
});

test("missing documentId never merges later tabId+frameId snapshot unless URL exact match already present", () => {
  const clock = { t: 0 };
  const f = make(clock);
  // Preload a snapshot for a different URL on same tab/frame.
  f.provideDocumentSnapshot({
    documentId: "later-doc", tabId: 9, frameId: 0,
    pageUrl: "https://site/other", topLevelPageUrl: "https://site/other",
    documentNonce: "x",
    candidates: [{ kind: "visible-filename", value: "other.mp4" }],
    capturedAt: "2026-08-12T12:00:00.000Z",
  });
  const id = f.beginNetworkDetection({
    documentId: null, tabId: 9, frameId: 0,
    documentUrl: "https://site/page-a", topLevelUrlHint: "https://site/page-a",
    mediaUrl: "https://cdn/a.mp4", mediaOrigin: "https://cdn",
    contentDisposition: null, referrerUrl: "https://site/page-a",
    frameOrigin: "https://site", ts: 0,
  });
  // Immediate finalize path — must not wait to merge foreign snapshot.
  const item = f.getItem(id);
  assert.ok(item);
  assert.notEqual(item.proposedFilename, "other.mp4");
  assert.equal(item.sourceContext.documentId, null);
});

test("missing documentId reuses only already-present snapshot with exact captured URL match", () => {
  // Mutation: merging any same tabId+frameId snapshot when documentId is null.
  const clock = { t: 0 };
  const f = make(clock);
  f.provideDocumentSnapshot({
    documentId: "doc-exact", tabId: 9, frameId: 0,
    pageUrl: "https://site/page-a", topLevelPageUrl: "https://site/page-a",
    documentNonce: "n-exact",
    candidates: [{ kind: "visible-filename", value: "exact-match.mp4" }],
    capturedAt: "2026-08-12T12:00:00.000Z",
  });
  const id = f.beginNetworkDetection({
    documentId: null, tabId: 9, frameId: 0,
    documentUrl: "https://site/page-a", topLevelUrlHint: "https://site/page-a",
    mediaUrl: "https://cdn/a.mp4", mediaOrigin: "https://cdn",
    contentDisposition: null, referrerUrl: "https://site/page-a",
    frameOrigin: "https://site", ts: 0,
  });
  const item = f.getItem(id);
  assert.ok(item);
  assert.equal(item.proposedFilename, "exact-match.mp4");
  // sourceContext.documentId stays null when webRequest omitted it; snapshot may be used for candidates only.
  assert.equal(item.sourceContext.documentId, null);
});

test("matching documentId from webRequest and content snapshot correlates", () => {
  // Mutation: ignoring documentId and keying only by tabId.
  const clock = { t: 0 };
  const f = make(clock);
  const id = f.beginNetworkDetection({
    documentId: "fx-doc-77", tabId: 4, frameId: 0,
    documentUrl: "https://florenfile.com/qnzjnabo3jec/11238-makemebi.net.mp4.html",
    topLevelUrlHint: "https://florenfile.com/qnzjnabo3jec/11238-makemebi.net.mp4.html",
    mediaUrl: "https://s40.example-cdn.invalid/file.mp4",
    mediaOrigin: "https://s40.example-cdn.invalid",
    contentDisposition: null,
    referrerUrl: "https://florenfile.com/qnzjnabo3jec/11238-makemebi.net.mp4.html",
    frameOrigin: "https://florenfile.com", ts: 0,
  });
  assert.equal(f.getItem(id), null); // waiting for matching snapshot
  f.provideDocumentSnapshot({
    documentId: "fx-doc-77", tabId: 4, frameId: 0,
    pageUrl: "https://florenfile.com/qnzjnabo3jec/11238-makemebi.net.mp4.html",
    topLevelPageUrl: "https://florenfile.com/qnzjnabo3jec/11238-makemebi.net.mp4.html",
    documentNonce: "n77",
    candidates: [
      { kind: "document-title", value: "Florenfile.com - Secure Cloud Storage" },
      { kind: "visible-filename", value: "11238-makemebi.net.mp4" },
    ],
    capturedAt: "2026-08-12T12:00:00.000Z",
  });
  const item = f.getItem(id);
  assert.ok(item);
  assert.equal(item.sourceContext.documentId, "fx-doc-77");
  assert.equal(item.proposedFilename, "11238-makemebi.net.mp4");
});

test("two detectionIds with same media URL do not mutate each other's candidates", () => {
  const clock = { t: 0 };
  const f = make(clock);
  const a = f.beginNetworkDetection({
    documentId: "d1", tabId: 3, frameId: 0,
    documentUrl: "https://p/a", topLevelUrlHint: "https://p/a",
    mediaUrl: "https://cdn/same.mp4", mediaOrigin: "https://cdn",
    contentDisposition: "a-only.mp4", referrerUrl: "https://p/a",
    frameOrigin: "https://p", ts: 0,
  });
  const b = f.beginNetworkDetection({
    documentId: "d2", tabId: 3, frameId: 0,
    documentUrl: "https://p/b", topLevelUrlHint: "https://p/b",
    mediaUrl: "https://cdn/same.mp4", mediaOrigin: "https://cdn",
    contentDisposition: "b-only.mp4", referrerUrl: "https://p/b",
    frameOrigin: "https://p", ts: 1,
  });
  f.provideDocumentSnapshot({
    documentId: "d1", tabId: 3, frameId: 0, pageUrl: "https://p/a",
    topLevelPageUrl: "https://p/a", documentNonce: "1",
    candidates: [], capturedAt: "2026-08-12T12:00:00.000Z",
  });
  f.provideDocumentSnapshot({
    documentId: "d2", tabId: 3, frameId: 0, pageUrl: "https://p/b",
    topLevelPageUrl: "https://p/b", documentNonce: "2",
    candidates: [], capturedAt: "2026-08-12T12:00:01.000Z",
  });
  assert.equal(f.getItem(a).proposedFilename, "a-only.mp4");
  assert.equal(f.getItem(b).proposedFilename, "b-only.mp4");
});

test("finalizeFromDom uses snapshot directly without waiting", () => {
  const clock = { t: 0 };
  const f = make(clock);
  const item = f.finalizeFromDom({
    snapshot: {
      documentId: "dom-1",
      tabId: 5,
      frameId: 0,
      pageUrl: "https://site/page",
      topLevelPageUrl: "https://site/page",
      documentNonce: "dom-n1",
      candidates: [{ kind: "visible-filename", value: "dom-clip.mp4" }],
      capturedAt: "2026-08-12T12:00:00.000Z",
    },
    mediaUrl: "https://cdn/dom-clip.mp4",
    mediaOrigin: "https://cdn",
    contentDisposition: null,
    referrerUrl: "https://site/page",
    frameOrigin: "https://site",
    ts: 0,
  });
  assert.ok(item);
  assert.equal(item.proposedFilename, "dom-clip.mp4");
  assert.equal(item.sourceContext.documentId, "dom-1");
});

test("mapWebRequestDetails copies documentId into beginNetworkDetection event", () => {
  // Adapter helper: background maps Firefox webRequest details → finalizer event.
  // Mutation: dropping details.documentId or inventing tab-only keys.
  const { mapWebRequestDetails } = loadLib("lib/detection-finalizer.js");
  const event = mapWebRequestDetails({
    documentId: "fx-live-9",
    tabId: 11,
    frameId: 0,
    url: "https://cdn/x.mp4",
    originUrl: "https://site/page",
    documentUrl: "https://site/page",
    type: "media",
    timeStamp: 1000,
    responseHeaders: [{ name: "Content-Disposition", value: 'attachment; filename="live.mp4"' }],
  }, { topLevelUrlHint: "https://site/page", frameOrigin: "https://site" });
  assert.equal(event.documentId, "fx-live-9");
  assert.equal(event.tabId, 11);
  assert.equal(event.mediaUrl, "https://cdn/x.mp4");
  assert.equal(event.documentUrl, "https://site/page");
});

test("mapWebRequestDetails with missing documentId sets null (exact-URL reuse only later)", () => {
  const { mapWebRequestDetails } = loadLib("lib/detection-finalizer.js");
  const event = mapWebRequestDetails({
    tabId: 11,
    frameId: 0,
    url: "https://cdn/x.mp4",
    originUrl: "https://site/page",
    documentUrl: "https://site/page",
    type: "media",
    timeStamp: 1000,
    responseHeaders: [],
  }, { topLevelUrlHint: "https://site/page", frameOrigin: "https://site" });
  assert.equal(event.documentId, null);
});
```

- [ ] **Step 2: Run — expect FAIL**

```powershell
node --test media-catcher/tests/detection-finalizer.test.js
```

Expected: FAIL — module missing or methods unimplemented.

- [ ] **Step 3: Implement finalizer**

Behavior checklist for implementation:

1. Monotonic `detectionId` counter.
2. Pending map keyed only by detectionId.
3. Snapshot map keyed by documentId; also keep last snapshot per (tabId, frameId, exact pageUrl) for missing-documentId exact URL reuse only.
4. On network detection with documentId: if snapshot present for that documentId → finalize immediately; else mark pending with `deadline = now+750` and expose nothing.
5. On snapshot: apply only to pending with matching documentId still open; ignore closed; ignore mismatches. When Firefox exposes documentId, store it on `sourceContext.documentId`.
6. On tick: finalize pending past deadline from network evidence only.
7. Finalize: build candidates list (content-disposition, snapshot candidates, page-url path, referrer path, media-url basename without query), `buildSourceContext`, `rank` once, attach frozen `proposedFilename` + `rankDiagnostics`, mark closed.
8. DOM-originated path uses the complete shape:
   ```js
   finalizeFromDom({
     snapshot: {
       documentId, tabId, frameId, pageUrl, topLevelPageUrl,
       documentNonce, candidates, capturedAt
     },
     mediaUrl, mediaOrigin, contentDisposition, referrerUrl, frameOrigin, ts
   })
   ```
   Uses the snapshot directly (no wait).
9. Export `mapWebRequestDetails(details, hints)` pure helper that copies `details.documentId` when present, else `null`. Background must call this and pass the result into `beginNetworkDetection` — never invent correlation keys.

- [ ] **Step 4: Run — expect PASS**

```powershell
node --test media-catcher/tests/detection-finalizer.test.js media-catcher/tests/filename-ranker.test.js
```

- [ ] **Step 5: Commit**

```powershell
git add media-catcher/lib/detection-finalizer.js media-catcher/tests/detection-finalizer.test.js
git commit -m "feat: detection finalizer freezes context once and ignores navigated documents"
```

---

### Task 5: DownloadIntent factory

**Files:**
- Create: `media-catcher/lib/download-intent.js`
- Create: `media-catcher/tests/download-intent.test.js`

**Interfaces:**
- Consumes: `McFilenameRanker.sanitizeFilename`, `ensureExtension`
- Produces:
  - `createDefaultIntent({ proposedFilename, destinationDirectory, userActionToken, now })`
  - `createSaveAsIntent({ proposedFilename, editedFilename, destinationDirectory, userActionToken, knownExtension, now })`
  - `createFirefoxIntent({ baseIntent })` → same filenames with `userSelectedFirefox: true` (still requires existing `userActionToken`)
  - Intents are deep-frozen

- [ ] **Step 1: Failing tests**

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");
const Intent = loadLib("lib/download-intent.js");

test("Download copies frozen proposal with saveMode default", () => {
  const i = Intent.createDefaultIntent({
    proposedFilename: "11238-makemebi.net.mp4",
    destinationDirectory: null,
    userActionToken: "tok-1",
    now: () => "2026-08-12T12:00:00.000Z",
  });
  assert.equal(i.requestedFilename, "11238-makemebi.net.mp4");
  assert.equal(i.saveMode, "default");
  assert.equal(i.userSelectedFirefox, false);
  assert.equal(i.userActionToken, "tok-1");
  assert.throws(() => { i.requestedFilename = "x"; });
});

test("Save As uses sanitized edit; cancel path is simply not calling factory", () => {
  const i = Intent.createSaveAsIntent({
    proposedFilename: "11238-makemebi.net.mp4",
    editedFilename: "My Cut: final",
    destinationDirectory: "D:\\\\Vids",
    userActionToken: "tok-2",
    knownExtension: ".mp4",
    now: () => "2026-08-12T12:00:00.000Z",
  });
  assert.equal(i.saveMode, "save-as");
  assert.equal(i.requestedFilename, "My Cut_ final.mp4");
  assert.equal(i.destinationDirectory, "D:\\\\Vids");
});

test("Firefox intent requires existing userActionToken and sets flag", () => {
  const base = Intent.createDefaultIntent({
    proposedFilename: "a.mp4", userActionToken: "tok-3", now: () => "t",
  });
  const fx = Intent.createFirefoxIntent({ baseIntent: base });
  assert.equal(fx.userSelectedFirefox, true);
  assert.equal(fx.requestedFilename, "a.mp4");
  assert.equal(fx.userActionToken, "tok-3");
});
```

- [ ] **Step 2: Run — FAIL**

```powershell
node --test media-catcher/tests/download-intent.test.js
```

- [ ] **Step 3: Implement factory** using Ranker sanitize/ensureExtension; freeze result objects.

- [ ] **Step 4: PASS + commit**

```powershell
node --test media-catcher/tests/download-intent.test.js
git add media-catcher/lib/download-intent.js media-catcher/tests/download-intent.test.js
git commit -m "feat: immutable DownloadIntent factory for Download and Save As"
```

---

### Task 6: Provider registry (CDN association decision table)

**Files:**
- Create: `media-catcher/lib/provider-registry.js`
- Create: `media-catcher/tests/provider-registry.test.js`

**Interfaces:**
- `createProviderRegistry()` → `{ observe, lookup, clear, snapshot }`
- `lookup(origin)` returns `{ status: "none"|"one"|"ambiguous", providerKey: null|string }`

- [ ] **Step 1: Failing tests**

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");
const { createProviderRegistry } = loadLib("lib/provider-registry.js");

test("zero providers → none; do not infer CDN hostname", () => {
  const r = createProviderRegistry();
  assert.deepEqual(r.lookup("https://cdn.example"), { status: "none", providerKey: null });
});

test("one provider → origin-only probe may inherit key", () => {
  const r = createProviderRegistry();
  r.observe("https://cdn.example", "florenfile.com");
  assert.deepEqual(r.lookup("https://cdn.example"), { status: "one", providerKey: "florenfile.com" });
});

test("two providers on shared CDN → ambiguous; no merge", () => {
  // Mutation: collapsing both providers into one group.
  const r = createProviderRegistry();
  r.observe("https://shared-cdn.invalid", "florenfile.com");
  r.observe("https://shared-cdn.invalid", "otherhost.com");
  assert.deepEqual(r.lookup("https://shared-cdn.invalid"), { status: "ambiguous", providerKey: null });
});

test("clear wipes session registry", () => {
  const r = createProviderRegistry();
  r.observe("https://cdn", "a.com");
  r.clear();
  assert.equal(r.lookup("https://cdn").status, "none");
});
```

- [ ] **Step 2–4: FAIL → implement Map of origin→Set(providerKey) with hostname normalization of origin → PASS → commit**

```powershell
node --test media-catcher/tests/provider-registry.test.js
git add media-catcher/lib/provider-registry.js media-catcher/tests/provider-registry.test.js
git commit -m "feat: session provider registry with CDN ambiguity rules"
```

---

### Task 7: Failure classification and saturation predicate

**Files:**
- Create: `media-catcher/lib/failure-classify.js`
- Create: `media-catcher/tests/failure-classify.test.js`

**Interfaces:**
- `normalizeBrowserError(errOrResponse) -> { category, retryable }`
- `normalizeNativeFailure(reasonStringOrObject) -> { category, retryable }`
- `isSaturationCandidate(category) -> boolean`
- `hasActiveSibling({ jobs, providerKey, excludeJobId }) -> { ok, siblingJobId }`
  - Sibling must be same providerKey, state in `running|pausing_provider`, has in-flight permit or native open connections > 0, not cancelling.
- Dual-export global: `McFailureClassify`

- [ ] **Step 1: Failing tests**

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");
const FC = loadLib("lib/failure-classify.js");

test("maps timeout reset short_read 429 temporary 5xx as saturation candidates", () => {
  for (const c of ["timeout", "connection_reset", "short_read", "http_429", "http_5xx_temporary"]) {
    assert.equal(FC.isSaturationCandidate(c), true);
  }
  for (const c of ["range_unsupported", "local_io", "cancelled", "permanent"]) {
    assert.equal(FC.isSaturationCandidate(c), false);
  }
});

test("normalizeBrowserError maps timeout/reset/short_read/429/temp 5xx/range/local_io/cancelled/permanent", () => {
  // Mutation: collapsing every network error into permanent or timeout.
  assert.equal(FC.normalizeBrowserError({ name: "TimeoutError" }).category, "timeout");
  assert.equal(FC.normalizeBrowserError({ name: "AbortError", message: "The operation was aborted" }).category, "cancelled");
  assert.equal(FC.normalizeBrowserError({ name: "TypeError", message: "NetworkError when attempting to fetch" }).category, "connection_reset");
  assert.equal(FC.normalizeBrowserError({ name: "TypeError", message: "Failed to fetch" }).category, "connection_reset");
  assert.equal(FC.normalizeBrowserError({ status: 429 }).category, "http_429");
  assert.equal(FC.normalizeBrowserError({ status: 503 }).category, "http_5xx_temporary");
  assert.equal(FC.normalizeBrowserError({ status: 502 }).category, "http_5xx_temporary");
  assert.equal(FC.normalizeBrowserError({ status: 500 }).category, "http_5xx_temporary");
  assert.equal(FC.normalizeBrowserError({ status: 416 }).category, "range_unsupported");
  assert.equal(FC.normalizeBrowserError({ status: 200, rangeIgnored: true }).category, "range_unsupported");
  assert.equal(FC.normalizeBrowserError({ code: "ENOSPC" }).category, "local_io");
  assert.equal(FC.normalizeBrowserError({ status: 404 }).category, "permanent");
  assert.equal(FC.normalizeBrowserError({ status: 403 }).category, "permanent");
  assert.equal(FC.normalizeBrowserError({ shortRead: true }).category, "short_read");
  assert.equal(FC.normalizeBrowserError({ name: "TimeoutError" }).retryable, true);
  assert.equal(FC.normalizeBrowserError({ status: 404 }).retryable, false);
  assert.equal(FC.normalizeBrowserError({ status: 416 }).retryable, false);
});

test("normalizeNativeFailure maps host reason strings and objects", () => {
  // Mutation: treating range_unsupported as temporary or local_io as saturation-capable.
  assert.equal(FC.normalizeNativeFailure("timeout").category, "timeout");
  assert.equal(FC.normalizeNativeFailure("connection_reset").category, "connection_reset");
  assert.equal(FC.normalizeNativeFailure("short_read").category, "short_read");
  assert.equal(FC.normalizeNativeFailure("http_429").category, "http_429");
  assert.equal(FC.normalizeNativeFailure("http_5xx_temporary").category, "http_5xx_temporary");
  assert.equal(FC.normalizeNativeFailure("range_unsupported").category, "range_unsupported");
  assert.equal(FC.normalizeNativeFailure("local_io").category, "local_io");
  assert.equal(FC.normalizeNativeFailure("cancelled").category, "cancelled");
  assert.equal(FC.normalizeNativeFailure("permanent").category, "permanent");
  assert.equal(FC.normalizeNativeFailure({ failureCategory: "timeout" }).category, "timeout");
  assert.equal(FC.normalizeNativeFailure({ reason: "disk full" }).category, "local_io");
  assert.equal(FC.normalizeNativeFailure({ reason: "ECONNRESET" }).category, "connection_reset");
  assert.equal(FC.normalizeNativeFailure("range_unsupported").retryable, false);
  assert.equal(FC.normalizeNativeFailure("local_io").retryable, false);
  assert.equal(FC.normalizeNativeFailure("timeout").retryable, true);
});

test("queued or needs_user sibling does not satisfy active-sibling predicate", () => {
  // Mutation: treating any non-terminal same-provider job as active.
  const jobs = [
    { id: "a", providerKey: "florenfile.com", state: "queued", inFlightPermits: 0, nativeOpenConnections: 0, cancelRequested: false },
    { id: "b", providerKey: "florenfile.com", state: "needs_user", inFlightPermits: 0, nativeOpenConnections: 0, cancelRequested: false },
  ];
  assert.equal(FC.hasActiveSibling({ jobs, providerKey: "florenfile.com", excludeJobId: "x" }).ok, false);
});

test("running sibling with permit counts", () => {
  const jobs = [
    { id: "run", providerKey: "florenfile.com", state: "running", inFlightPermits: 1, nativeOpenConnections: 0, cancelRequested: false },
  ];
  const r = FC.hasActiveSibling({ jobs, providerKey: "florenfile.com", excludeJobId: "failed" });
  assert.equal(r.ok, true);
  assert.equal(r.siblingJobId, "run");
});
```

- [ ] **Step 2: Run — expect FAIL**

```powershell
node --test media-catcher/tests/failure-classify.test.js
```

Expected: FAIL — module missing or normalize* unimplemented.

- [ ] **Step 3: Implement pure classifiers** exporting
`normalizeBrowserError`, `normalizeNativeFailure`, `isSaturationCandidate`, `hasActiveSibling`
with the exact category strings from the shared contract. Dual-export as `McFailureClassify`.

- [ ] **Step 4: PASS → commit**

```powershell
node --test media-catcher/tests/failure-classify.test.js
git add media-catcher/lib/failure-classify.js media-catcher/tests/failure-classify.test.js
git commit -m "feat: normalize failure categories and active-sibling saturation predicate"
```

---

### Task 8: ProviderGate permits, generations, leases

**Files:**
- Create: `media-catcher/lib/provider-gate.js`
- Create: `media-catcher/tests/provider-gate.test.js`

**Interfaces:**
- `createProviderGate({ providerKey })`
- State: `normal | saturated | recovering`
- `generation` number
- `wakeGeneration` number
- `acquire(jobId, { maxForJob, isDrainOwner, isRunningJob, purpose }) -> permit|null`
- `setSaturated({ drainOwnerJobId, reducedConcurrency })`
- `nativeLeaseFor(jobId) -> { jobId, providerGeneration, maxConnections }`
- `noteNativeOpen(jobId, n)`
- `parkProbe(probeId)` / `wakeGeneration++` on owner completion

- [ ] **Step 1: Failing tests**

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");
const { createProviderGate } = loadLib("lib/provider-gate.js");

test("running job acquires up to effective concurrency; non-running denied", () => {
  const g = createProviderGate({ providerKey: "florenfile.com" });
  const p = g.acquire("j1", { maxForJob: 2, isDrainOwner: false, isRunningJob: true, purpose: "segment" });
  assert.ok(p);
  assert.equal(g.acquire("j2", { maxForJob: 2, isDrainOwner: false, isRunningJob: false, purpose: "segment" }), null);
  p.release();
});

test("saturated: only drain owner gets permits; others zero native lease", () => {
  // Mutation: still issuing permits to non-owners.
  const g = createProviderGate({ providerKey: "florenfile.com" });
  g.setSaturated({ drainOwnerJobId: "owner", reducedConcurrency: 1 });
  assert.ok(g.acquire("owner", { maxForJob: 1, isDrainOwner: true, isRunningJob: true, purpose: "segment" }));
  assert.equal(g.acquire("other", { maxForJob: 4, isDrainOwner: false, isRunningJob: true, purpose: "segment" }), null);
  assert.equal(g.nativeLeaseFor("other").maxConnections, 0);
  assert.equal(g.nativeLeaseFor("owner").maxConnections, 1);
});
```

- [ ] **Step 2–4: implement → PASS → commit**

```powershell
node --test media-catcher/tests/provider-gate.test.js
git add media-catcher/lib/provider-gate.js media-catcher/tests/provider-gate.test.js
git commit -m "feat: provider gate with permits, saturation generation, native leases"
```

---

### Task 9: DownloadScheduler global admission hard cap

**Files:**
- Create: `media-catcher/lib/download-scheduler.js` (skeleton + global admission first)
- Create: `media-catcher/tests/scheduler-global.test.js`

**Interfaces (initial):**
- Constructor `createDownloadScheduler({ maxConcurrent, now, randomToken })`
- `createJob`, `enqueue`, `setMaxConcurrent`, `getSnapshot`
- Job fields: `id, providerKey, state, stateVersion, holdsGlobalSlot, retryRemaining, retryUsed, effectiveConcurrency, intent, attemptToken, mode`

- [ ] **Step 1: Failing tests**

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");
const { createDownloadScheduler } = loadLib("lib/download-scheduler.js");

function intent(name) {
  return Object.freeze({
    requestedFilename: name,
    destinationDirectory: null,
    saveMode: "default",
    userSelectedFirefox: false,
    userActionToken: "t",
    createdAt: "t0",
  });
}

test("maxConcurrentDownloads is a hard global admission limit", () => {
  // Mutation: starting all enqueued jobs immediately.
  const s = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
  s.createJob({ id: "1", providerKey: "a.com", intent: intent("1.mp4"), segmentConcurrency: 4, retries: 3 });
  s.createJob({ id: "2", providerKey: "b.com", intent: intent("2.mp4"), segmentConcurrency: 4, retries: 3 });
  s.createJob({ id: "3", providerKey: "c.com", intent: intent("3.mp4"), segmentConcurrency: 4, retries: 3 });
  s.enqueue("1"); s.enqueue("2"); s.enqueue("3");
  const snap = s.getSnapshot();
  assert.equal(snap.globalRunning, 2);
  assert.equal(snap.jobs.find((j) => j.id === "3").state, "queued");
});

test("lowering limit pauses new admission without cancelling active work", () => {
  const s = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
  s.createJob({ id: "1", providerKey: "a.com", intent: intent("1.mp4"), segmentConcurrency: 2, retries: 1 });
  s.createJob({ id: "2", providerKey: "b.com", intent: intent("2.mp4"), segmentConcurrency: 2, retries: 1 });
  s.createJob({ id: "3", providerKey: "c.com", intent: intent("3.mp4"), segmentConcurrency: 2, retries: 1 });
  s.enqueue("1"); s.enqueue("2"); s.enqueue("3");
  s.setMaxConcurrent(1);
  assert.equal(s.getSnapshot().jobs.filter((j) => j.state === "running").length, 2);
  s.onTransportResult("1", s.getJob("1").attemptToken, { status: "completed", failureCategory: null });
  assert.equal(s.getSnapshot().jobs.filter((j) => j.state === "running").length, 1);
  assert.equal(s.getSnapshot().jobs.find((j) => j.id === "3").state, "queued");
});
```

- [ ] **Step 2: FAIL**

```powershell
node --test media-catcher/tests/scheduler-global.test.js
```

- [ ] **Step 3: Implement scheduler core**

Implement FIFO-within-provider + round-robin-across-providers admission, slot CAS (`holdsGlobalSlot` boolean + `stateVersion`), states per design table for `queued`/`running`/`completed`. Export `getJob(id)`.

- [ ] **Step 4: PASS + commit**

```powershell
node --test media-catcher/tests/scheduler-global.test.js
git add media-catcher/lib/download-scheduler.js media-catcher/tests/scheduler-global.test.js
git commit -m "feat: download scheduler enforces hard global admission cap"
```

---

### Task 10: Scheduler provider grouping, saturation wait/wake, slot release

**Files:**
- Modify: `media-catcher/lib/download-scheduler.js`
- Create: `media-catcher/tests/scheduler-provider.test.js`

**Interfaces:**
- Consumes: ProviderGate, failure-classify
- Produces saturation transitions; popup label helper `userStatus(job) -> string`
- `acquireProviderPermit(jobId, purpose)` is the **sole** ProviderGate wrapper used by background/segment/probe fetches. Background must never call `ProviderGate.acquire` directly.
- Permit returned is generation-bound: after a generation bump, `permit.release()` is a no-op for the old generation's count (idempotent, no double-decrement).

- [ ] **Step 1: Failing tests**

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");
const { createDownloadScheduler } = loadLib("lib/download-scheduler.js");

function intent(n) {
  return Object.freeze({
    requestedFilename: n, destinationDirectory: null, saveMode: "default",
    userSelectedFirefox: false, userActionToken: "t", createdAt: "t0",
  });
}

test("same provider different CDN hosts share one throttle group", () => {
  // Mutation: keying provider by mediaOrigin/CDN host.
  const s = createDownloadScheduler({ maxConcurrent: 4, now: () => 0 });
  s.createJob({ id: "j1", providerKey: "florenfile.com", mediaOrigin: "https://cdn-a", intent: intent("a.mp4"), segmentConcurrency: 4, retries: 3 });
  s.createJob({ id: "j2", providerKey: "florenfile.com", mediaOrigin: "https://cdn-b", intent: intent("b.mp4"), segmentConcurrency: 4, retries: 3 });
  s.enqueue("j1"); s.enqueue("j2");
  // Simulate j1 running with a permit, j2 fails timeout → waiting_provider
  s.notePermitAcquired("j1");
  s.onTransportResult("j2", s.getJob("j2").attemptToken, { status: "failed", failureCategory: "timeout" });
  assert.equal(s.getJob("j2").state, "waiting_provider");
  assert.equal(s.getJob("j1").effectiveConcurrency, 2); // floor(4/2)
});

test("transient failure with active sibling does not call Firefox hook", () => {
  let firefoxCalls = 0;
  const s = createDownloadScheduler({
    maxConcurrent: 4, now: () => 0,
    firefoxDownload: () => { firefoxCalls++; },
  });
  s.createJob({ id: "j1", providerKey: "florenfile.com", intent: intent("a.mp4"), segmentConcurrency: 4, retries: 3 });
  s.createJob({ id: "j2", providerKey: "florenfile.com", intent: intent("b.mp4"), segmentConcurrency: 4, retries: 3 });
  s.enqueue("j1"); s.enqueue("j2");
  s.notePermitAcquired("j1");
  s.onTransportResult("j2", s.getJob("j2").attemptToken, { status: "failed", failureCategory: "http_429" });
  assert.equal(firefoxCalls, 0);
  assert.equal(s.getJob("j2").state, "waiting_provider");
});

test("completing drain owner wakes next waiter exactly once", () => {
  const s = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
  s.createJob({ id: "owner", providerKey: "p.com", intent: intent("o.mp4"), segmentConcurrency: 4, retries: 3 });
  s.createJob({ id: "wait", providerKey: "p.com", intent: intent("w.mp4"), segmentConcurrency: 4, retries: 3 });
  s.enqueue("owner"); s.enqueue("wait");
  s.notePermitAcquired("owner");
  s.onTransportResult("wait", s.getJob("wait").attemptToken, { status: "failed", failureCategory: "connection_reset" });
  assert.equal(s.getJob("wait").state, "waiting_provider");
  const token = s.getJob("owner").attemptToken;
  s.onTransportResult("owner", token, { status: "completed", failureCategory: null });
  // Late duplicate completion must not double-wake
  s.onTransportResult("owner", token, { status: "completed", failureCategory: null });
  const wait = s.getJob("wait");
  assert.ok(wait.state === "queued" || wait.state === "running");
  assert.equal(wait.autoWakeCount, 1);
});

test("independent providers run concurrently when global limit permits", () => {
  const s = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
  s.createJob({ id: "a", providerKey: "a.com", intent: intent("a.mp4"), segmentConcurrency: 2, retries: 1 });
  s.createJob({ id: "b", providerKey: "b.com", intent: intent("b.mp4"), segmentConcurrency: 2, retries: 1 });
  s.enqueue("a"); s.enqueue("b");
  assert.equal(s.getJob("a").state, "running");
  assert.equal(s.getJob("b").state, "running");
});

test("waiting_provider and retry_backoff release global capacity", () => {
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s.createJob({ id: "a", providerKey: "a.com", intent: intent("a.mp4"), segmentConcurrency: 2, retries: 2 });
  s.createJob({ id: "b", providerKey: "b.com", intent: intent("b.mp4"), segmentConcurrency: 2, retries: 2 });
  s.enqueue("a"); s.enqueue("b");
  assert.equal(s.getJob("a").state, "running");
  // Force a into retry_backoff via transient with no sibling
  s.onTransportResult("a", s.getJob("a").attemptToken, { status: "failed", failureCategory: "timeout" });
  assert.equal(s.getJob("a").state, "retry_backoff");
  assert.equal(s.getJob("a").holdsGlobalSlot, false);
  assert.equal(s.getJob("b").state, "running");
});

test("pausing_provider retains slot until drain then releases once", () => {
  // Two-job same-provider saturation: owner stays running; failed non-owner pauses.
  // maxConcurrent=2 admits both; they do not violate the hard cap.
  const s = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
  s.createJob({ id: "owner", providerKey: "p.com", intent: intent("o.mp4"), segmentConcurrency: 4, retries: 3 });
  s.createJob({ id: "sib", providerKey: "p.com", intent: intent("s.mp4"), segmentConcurrency: 4, retries: 3 });
  s.enqueue("owner"); s.enqueue("sib");
  assert.equal(s.getJob("owner").state, "running");
  assert.equal(s.getJob("sib").state, "running");
  s.notePermitAcquired("owner");
  s.notePermitAcquired("sib");
  const globalBeforeFail = s.getSnapshot().globalRunning;
  assert.equal(globalBeforeFail, 2);
  s.onTransportResult("sib", s.getJob("sib").attemptToken, { status: "failed", failureCategory: "short_read" });
  // Immediately after saturation: non-owner is pausing_provider and STILL holds its global slot.
  assert.equal(s.getJob("sib").state, "pausing_provider");
  assert.equal(s.getJob("sib").holdsGlobalSlot, true);
  assert.equal(s.getSnapshot().globalRunning, 2);
  assert.equal(s.getJob("owner").state, "running"); // drain owner
  // Drain complete → waiting_provider, slot released once, globalRunning decremented once.
  s.releasePermit("sib");
  s.onQuiesced("sib");
  assert.equal(s.getJob("sib").state, "waiting_provider");
  assert.equal(s.getJob("sib").holdsGlobalSlot, false);
  assert.equal(s.getSnapshot().globalRunning, 1);
  // Duplicate quiesce is a no-op (no second slot release).
  s.onQuiesced("sib");
  assert.equal(s.getSnapshot().globalRunning, 1);
  assert.equal(s.getJob("sib").state, "waiting_provider");
});

test("acquireProviderPermit is the sole gate wrapper and is generation-bound", () => {
  // Mutation: background calling ProviderGate.acquire directly, or release after generation bump double-counting.
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s.createJob({ id: "j", providerKey: "p.com", intent: intent("a.mp4"), segmentConcurrency: 2, retries: 2 });
  s.enqueue("j");
  const p1 = s.acquireProviderPermit("j", "segment");
  assert.ok(p1);
  assert.equal(typeof p1.release, "function");
  assert.equal(typeof p1.generation, "number");
  const gen = p1.generation;
  p1.release();
  p1.release(); // idempotent
  // After saturation generation bump, a stale permit's release must not corrupt counts.
  s.createJob({ id: "sib", providerKey: "p.com", intent: intent("b.mp4"), segmentConcurrency: 2, retries: 2 });
  // Admit sib when capacity allows — use a second scheduler for clean permit-generation assert:
  const s2 = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
  s2.createJob({ id: "owner", providerKey: "p.com", intent: intent("o.mp4"), segmentConcurrency: 4, retries: 3 });
  s2.createJob({ id: "fail", providerKey: "p.com", intent: intent("f.mp4"), segmentConcurrency: 4, retries: 3 });
  s2.enqueue("owner"); s2.enqueue("fail");
  const stale = s2.acquireProviderPermit("fail", "segment");
  assert.ok(stale);
  s2.notePermitAcquired("owner");
  s2.onTransportResult("fail", s2.getJob("fail").attemptToken, {
    status: "failed", failureCategory: "timeout",
  });
  // fail may be pausing/waiting; generation advanced for provider
  const genAfter = stale.generation;
  stale.release(); // must not throw; must not resurrect permits for saturated non-owner
  assert.equal(s2.acquireProviderPermit("fail", "segment"), null); // non-owner denied while saturated/pausing
  assert.ok(s2.acquireProviderPermit("owner", "segment")); // drain owner still allowed
  void gen; void genAfter;
});

test("no viable sibling → bounded retry, never waiting_provider forever", () => {
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s.createJob({ id: "solo", providerKey: "p.com", intent: intent("s.mp4"), segmentConcurrency: 2, retries: 1 });
  s.enqueue("solo");
  s.onTransportResult("solo", s.getJob("solo").attemptToken, { status: "failed", failureCategory: "timeout" });
  assert.equal(s.getJob("solo").state, "retry_backoff");
  assert.notEqual(s.getJob("solo").state, "waiting_provider");
});
```

- [ ] **Step 2: FAIL**

```powershell
node --test media-catcher/tests/scheduler-provider.test.js
```

Expected: FAIL — saturation/pausing/permit APIs incomplete.

- [ ] **Step 3: Extend scheduler** with saturation algorithm exactly as design §Provider saturation (drain owner oldest running sibling; failed work cannot become owner; reduce concurrency `max(1, floor(prev/2))`; waiters; user status `Waiting for <providerKey>`). Add methods used by tests: `notePermitAcquired`, `releasePermit`, `onQuiesced`, `acquireProviderPermit`, wake CAS via `wakeGeneration`. Background/segment/probe code uses **only** `scheduler.acquireProviderPermit`.

- [ ] **Step 4: PASS + commit**

```powershell
node --test media-catcher/tests/scheduler-provider.test.js media-catcher/tests/scheduler-global.test.js
git add media-catcher/lib/download-scheduler.js media-catcher/tests/scheduler-provider.test.js
git commit -m "feat: provider-aware saturation, wait, and single wake in scheduler"
```

---

### Task 11: Finite retries, cancellation, attempt tokens, double-release protection

**Files:**
- Modify: `media-catcher/lib/download-scheduler.js`
- Create: `media-catcher/tests/scheduler-retry-cancel.test.js`

- [ ] **Step 1: Failing tests**

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");
const { createDownloadScheduler } = loadLib("lib/download-scheduler.js");

function intent(n) {
  return Object.freeze({
    requestedFilename: n, destinationDirectory: null, saveMode: "default",
    userSelectedFirefox: false, userActionToken: "t", createdAt: "t0",
  });
}

test("automatic retries consume finite budget and exhaust to needs_user", () => {
  // Mutation: infinite retry loop in transport layer.
  let t = 0;
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => t });
  s.createJob({ id: "j", providerKey: "p.com", intent: intent("f.mp4"), segmentConcurrency: 2, retries: 2 });
  s.enqueue("j");
  // first failure → retry_backoff (retries 2→1)
  s.onTransportResult("j", s.getJob("j").attemptToken, { status: "failed", failureCategory: "timeout" });
  assert.equal(s.getJob("j").retryRemaining, 1);
  t += 2000; s.tick(t); // admit retry
  s.onTransportResult("j", s.getJob("j").attemptToken, { status: "failed", failureCategory: "timeout" });
  assert.equal(s.getJob("j").retryRemaining, 0);
  t += 4000; s.tick(t);
  s.onTransportResult("j", s.getJob("j").attemptToken, { status: "failed", failureCategory: "timeout" });
  assert.equal(s.getJob("j").state, "needs_user");
  // late timer cannot restart
  t += 999999; s.tick(t);
  assert.equal(s.getJob("j").state, "needs_user");
});

test("wake charges failed waiter once; paused sibling free", () => {
  // Three same-provider jobs can hold slots only when maxConcurrent >= 3.
  // Mutation: maxConcurrent:2 while treating owner+fail+paused as all permit-holding.
  const s = createDownloadScheduler({ maxConcurrent: 3, now: () => 0 });
  s.createJob({ id: "owner", providerKey: "p.com", intent: intent("o.mp4"), segmentConcurrency: 4, retries: 3 });
  s.createJob({ id: "fail", providerKey: "p.com", intent: intent("f.mp4"), segmentConcurrency: 4, retries: 3 });
  s.createJob({ id: "pausedOnly", providerKey: "p.com", intent: intent("p.mp4"), segmentConcurrency: 4, retries: 3 });
  s.enqueue("owner"); s.enqueue("fail"); s.enqueue("pausedOnly");
  assert.equal(s.getSnapshot().globalRunning, 3);
  assert.equal(s.getJob("owner").state, "running");
  assert.equal(s.getJob("fail").state, "running");
  assert.equal(s.getJob("pausedOnly").state, "running");
  s.notePermitAcquired("owner");
  s.notePermitAcquired("pausedOnly");
  const failRetriesBefore = s.getJob("fail").retryRemaining;
  const pausedRetriesBefore = s.getJob("pausedOnly").retryRemaining;
  s.onTransportResult("fail", s.getJob("fail").attemptToken, {
    status: "failed", failureCategory: "http_5xx_temporary",
  });
  // fail enters pausing_provider/waiting path; pausedOnly is competing sibling without its own failure
  assert.ok(
    s.getJob("fail").state === "pausing_provider" ||
    s.getJob("fail").state === "waiting_provider"
  );
  if (s.getJob("pausedOnly").state === "pausing_provider") {
    s.onQuiesced("pausedOnly");
  }
  assert.equal(s.getJob("pausedOnly").retryRemaining, pausedRetriesBefore);
  if (s.getJob("fail").state === "pausing_provider") {
    s.onQuiesced("fail");
  }
  assert.equal(s.getJob("fail").state, "waiting_provider");
  s.onTransportResult("owner", s.getJob("owner").attemptToken, {
    status: "completed", failureCategory: null,
  });
  // Failed waiter charged exactly once; merely-paused sibling not charged.
  assert.equal(s.getJob("fail").retryRemaining, failRetriesBefore - 1);
  assert.equal(s.getJob("pausedOnly").retryRemaining, pausedRetriesBefore);
  assert.equal(s.getJob("fail").autoWakeCount, 1);
});

test("needs_user after retry exhaustion releases global slot and admits eligible peer", () => {
  // Mutation: leaving holdsGlobalSlot true after needs_user.
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s.createJob({ id: "j", providerKey: "p.com", intent: intent("f.mp4"), segmentConcurrency: 2, retries: 0 });
  s.createJob({ id: "peer", providerKey: "q.com", intent: intent("peer.mp4"), segmentConcurrency: 2, retries: 1 });
  s.enqueue("j"); s.enqueue("peer");
  assert.equal(s.getJob("j").state, "running");
  assert.equal(s.getJob("peer").state, "queued");
  s.onTransportResult("j", s.getJob("j").attemptToken, {
    status: "failed", failureCategory: "timeout",
  });
  assert.equal(s.getJob("j").state, "needs_user");
  assert.equal(s.getJob("j").holdsGlobalSlot, false);
  assert.equal(s.getSnapshot().globalRunning, 1);
  assert.equal(s.getJob("peer").state, "running");
});

test("Save-As editing never holds a scheduler slot", () => {
  // Mutation: creating a running job when the user only opens Save As form.
  // Intent factory alone does not call createJob; assert scheduler starts empty.
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  assert.equal(s.getSnapshot().globalRunning, 0);
  assert.equal(s.getSnapshot().jobs.length, 0);
  // Only after explicit enqueue of a confirmed intent does a job exist:
  s.createJob({ id: "confirmed", providerKey: "p.com", intent: intent("a.mp4"), segmentConcurrency: 2, retries: 1 });
  // createJob without enqueue must not admit:
  assert.equal(s.getJob("confirmed").state, "created");
  assert.equal(s.getJob("confirmed").holdsGlobalSlot, false);
  assert.equal(s.getSnapshot().globalRunning, 0);
});

test("stale attempt tokens are rejected and cannot multiply budget", () => {
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s.createJob({ id: "j", providerKey: "p.com", intent: intent("f.mp4"), segmentConcurrency: 2, retries: 2 });
  s.enqueue("j");
  const stale = s.getJob("j").attemptToken;
  s.onTransportResult("j", stale, { status: "failed", failureCategory: "timeout" });
  // after failure, new token issued on retry admission
  s.tick(2000);
  const fresh = s.getJob("j").attemptToken;
  assert.notEqual(fresh, stale);
  // stale success must not complete job
  s.onTransportResult("j", stale, { status: "completed", failureCategory: null });
  assert.notEqual(s.getJob("j").state, "completed");
});

test("cancel releases slot once; duplicate cancel ack safe", () => {
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s.createJob({ id: "j", providerKey: "p.com", intent: intent("f.mp4"), segmentConcurrency: 2, retries: 1 });
  s.createJob({ id: "k", providerKey: "q.com", intent: intent("k.mp4"), segmentConcurrency: 2, retries: 1 });
  s.enqueue("j"); s.enqueue("k");
  s.cancel("j");
  s.onTransportResult("j", s.getJob("j").attemptToken, { status: "cancelled", failureCategory: "cancelled" });
  s.onTransportResult("j", s.getJob("j").attemptToken, { status: "cancelled", failureCategory: "cancelled" });
  assert.equal(s.getJob("j").state, "cancelled");
  assert.equal(s.getSnapshot().globalRunning, 1);
  assert.equal(s.getJob("k").state, "running");
});

test("range-to-single switch costs no retry unit and keeps slot/filename", () => {
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s.createJob({ id: "j", providerKey: "p.com", intent: intent("11238-makemebi.net.mp4"), segmentConcurrency: 4, retries: 3 });
  s.enqueue("j");
  const before = s.getJob("j").retryRemaining;
  s.onCapabilitySwitch("j", { mode: "single-connection", partState: "empty" });
  assert.equal(s.getJob("j").mode, "single-connection");
  assert.equal(s.getJob("j").effectiveConcurrency, 1);
  assert.equal(s.getJob("j").retryRemaining, before);
  assert.equal(s.getJob("j").state, "running");
  assert.equal(s.getJob("j").holdsGlobalSlot, true);
  assert.equal(s.getJob("j").intent.requestedFilename, "11238-makemebi.net.mp4");
});

test("requestFirefoxHandoff requires userSelectedFirefox and matching one-time token", async () => {
  let downloadCalls = 0;
  const s = createDownloadScheduler({
    maxConcurrent: 1,
    now: () => 0,
    firefoxDownload: async () => { downloadCalls++; return 1; },
    popupTokenStore: new Set(["popup-tok"]),
  });
  s.createJob({
    id: "j", providerKey: "p.com", intent: intent("a.mp4"),
    segmentConcurrency: 2, retries: 1,
  });
  s.enqueue("j");
  assert.equal(s.getJob("j").state, "running");

  // false flag
  await assert.rejects(() => s.requestFirefoxHandoff("j", Object.freeze({
    ...intent("a.mp4"), userSelectedFirefox: false, userActionToken: "popup-tok",
  })));
  assert.equal(downloadCalls, 0);
  assert.equal(s.getJob("j").state, "running");

  // missing token
  await assert.rejects(() => s.requestFirefoxHandoff("j", Object.freeze({
    ...intent("a.mp4"), userSelectedFirefox: true, userActionToken: "",
  })));
  assert.equal(downloadCalls, 0);

  // forged token
  await assert.rejects(() => s.requestFirefoxHandoff("j", Object.freeze({
    ...intent("a.mp4"), userSelectedFirefox: true, userActionToken: "forged",
  })));
  assert.equal(downloadCalls, 0);

  // valid handoff → handed_to_firefox, slot released once
  await s.requestFirefoxHandoff("j", Object.freeze({
    requestedFilename: "a.mp4", destinationDirectory: null, saveMode: "default",
    userSelectedFirefox: true, userActionToken: "popup-tok", createdAt: "t0",
  }));
  assert.equal(downloadCalls, 1);
  assert.equal(s.getJob("j").state, "handed_to_firefox");
  assert.equal(s.getJob("j").holdsGlobalSlot, false);
  assert.equal(s.getSnapshot().globalRunning, 0);

  // replayed token cannot call downloads again
  await assert.rejects(() => s.requestFirefoxHandoff("j", Object.freeze({
    requestedFilename: "a.mp4", destinationDirectory: null, saveMode: "default",
    userSelectedFirefox: true, userActionToken: "popup-tok", createdAt: "t0",
  })));
  assert.equal(downloadCalls, 1);
});

test("requestFirefoxHandoff API rejection returns needs_user without slot leak", async () => {
  let downloadCalls = 0;
  const s = createDownloadScheduler({
    maxConcurrent: 1,
    now: () => 0,
    firefoxDownload: async () => {
      downloadCalls++;
      throw new Error("user cancelled save dialog");
    },
    popupTokenStore: new Set(["tok"]),
  });
  s.createJob({
    id: "j", providerKey: "p.com",
    intent: intent("11238-makemebi.net.mp4"),
    segmentConcurrency: 2, retries: 1,
  });
  s.createJob({
    id: "peer", providerKey: "q.com",
    intent: intent("peer.mp4"),
    segmentConcurrency: 2, retries: 1,
  });
  s.enqueue("j"); s.enqueue("peer");
  assert.equal(s.getJob("peer").state, "queued");
  await s.requestFirefoxHandoff("j", Object.freeze({
    requestedFilename: "11238-makemebi.net.mp4",
    destinationDirectory: null, saveMode: "default",
    userSelectedFirefox: true, userActionToken: "tok", createdAt: "t0",
  }));
  assert.equal(downloadCalls, 1);
  assert.equal(s.getJob("j").state, "needs_user");
  assert.equal(s.getJob("j").holdsGlobalSlot, false);
  assert.equal(s.getSnapshot().globalRunning, 1);
  assert.equal(s.getJob("peer").state, "running");
});
```

- [ ] **Step 2: Run — expect FAIL**

```powershell
node --test media-catcher/tests/scheduler-retry-cancel.test.js
```

Expected: FAIL — retry/handoff APIs incomplete.

- [ ] **Step 3: Implement** retry budget `clamp(retries,0,10)`, backoff `min(30s, 1s * 2^used)`, `issueAttemptToken`, cancel drain, `onCapabilitySwitch`, and full `requestFirefoxHandoff` (token store consume-once, slot release once, transitions `handing_off_firefox` → `handed_to_firefox` | `needs_user`). Integration (Task 20) routes every Firefox handoff exclusively through this API.

- [ ] **Step 4: PASS + commit**

```powershell
node --test media-catcher/tests/scheduler-retry-cancel.test.js media-catcher/tests/scheduler-provider.test.js media-catcher/tests/scheduler-global.test.js
git add media-catcher/lib/download-scheduler.js media-catcher/tests/scheduler-retry-cancel.test.js
git commit -m "feat: finite retries, cancel drain, attempt tokens, capability switch, firefox handoff"
```

---

### Task 12: Native structured pget-result and range capability probe

**Files:**
- Modify: `media-catcher-host/mchost/downloads.py` (`_pget_probe`, `handle_pget`, helpers)
- Modify: `media-catcher-host/mc_host.py` (re-exports if needed)
- Create: `media-catcher-host/test_pget.py`

**Interfaces:**
- Replace every `pget-fallback` emission for transfer outcomes with `pget-result` as specified.
- Keep progress events `pget-progress`.
- Probe: `Range: bytes=0-0` after redirects; 206+Content-Range ⇒ ranges OK; conclusive 200 ignoring range ⇒ `range_unsupported` with `partState: "empty"` (no worker writes before probe succeeds).
- Transient probe errors map to their categories, not `range_unsupported`.
- Accept `attemptToken`, `maxConnections` lease in request; honor `pget-set-limit`.

- [ ] **Step 1: Write failing Python tests** in `test_pget.py` using a local `http.server` or `ThreadingHTTPServer` fixture serving:
  1. Range-capable file (206)
  2. No-range server (always 200 full body for Range requests)
  3. 429 / timeout simulation

```python
# media-catcher-host/test_pget.py
import os, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from conftest import load_host, wait_for

mc = load_host()

class RangeHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    mode = "range"  # or "no-range" or "429"
    payload = b"0123456789abcdef" * 64  # 1024 bytes

    def log_message(self, *args): pass

    def do_GET(self):
        if self.mode == "429":
            self.send_response(429); self.end_headers(); return
        rng = self.headers.get("Range")
        if self.mode == "no-range":
            self.send_response(200)
            self.send_header("Content-Length", str(len(self.payload)))
            self.end_headers(); self.wfile.write(self.payload); return
        if rng == "bytes=0-0":
            self.send_response(206)
            self.send_header("Content-Range", "bytes 0-0/%d" % len(self.payload))
            self.send_header("Content-Length", "1")
            self.end_headers(); self.wfile.write(self.payload[:1]); return
        # simple ranged response
        assert rng.startswith("bytes=")
        a,b = rng.split("=",1)[1].split("-")
        start, end = int(a), int(b)
        chunk = self.payload[start:end+1]
        self.send_response(206)
        self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, len(self.payload)))
        self.send_header("Content-Length", str(len(chunk)))
        self.end_headers(); self.wfile.write(chunk)

def run_server(mode):
    RangeHandler.mode = mode
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), RangeHandler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True); t.start()
    return httpd

def test_range_capable_completes_with_pget_result(tmp_path, monkeypatch):
    # Mutation: still emitting pget-fallback on success path failures only — ensure completed contract.
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(msg))
    httpd = run_server("range")
    host, port = httpd.server_address
    url = "http://%s:%d/file.mp4" % (host, port)
    mc.handle_pget({
        "id": "job1", "attemptToken": "atk-1", "urls": [url],
        "name": "clip.mp4", "dir": str(tmp_path), "maxConnections": 2,
        "referer": "", "userAgent": "t",
    })
    assert wait_for(lambda: any(m.get("type") == "pget-result" for m in sent), timeout=5)
    res = [m for m in sent if m.get("type") == "pget-result"][-1]
    assert res["status"] == "completed"
    assert res["mode"] == "multi-range"
    assert res["failureCategory"] is None
    assert res["partState"] == "committed"
    assert res["attemptToken"] == "atk-1"
    assert not any(m.get("type") == "pget-fallback" for m in sent)
    httpd.shutdown()

def test_no_range_reports_range_unsupported_empty_part(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(msg))
    httpd = run_server("no-range")
    host, port = httpd.server_address
    url = "http://%s:%d/file.mp4" % (host, port)
    mc.handle_pget({
        "id": "job2", "attemptToken": "atk-2", "urls": [url],
        "name": "clip.mp4", "dir": str(tmp_path), "maxConnections": 4,
    })
    assert wait_for(lambda: any(m.get("type") == "pget-result" for m in sent), timeout=5)
    res = [m for m in sent if m.get("type") == "pget-result"][-1]
    assert res["status"] == "failed"
    assert res["failureCategory"] == "range_unsupported"
    assert res["partState"] == "empty"
    # no partial final file left behind from multi-range workers
    leftovers = [p for p in os.listdir(tmp_path) if p.endswith(".part") or ".part" in p]
    assert leftovers == []
    httpd.shutdown()

def test_http_429_is_not_range_unsupported(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(msg))
    httpd = run_server("429")
    host, port = httpd.server_address
    url = "http://%s:%d/file.mp4" % (host, port)
    mc.handle_pget({
        "id": "job3", "attemptToken": "atk-3", "urls": [url],
        "name": "clip.mp4", "dir": str(tmp_path), "maxConnections": 2,
    })
    assert wait_for(lambda: any(m.get("type") == "pget-result" for m in sent), timeout=5)
    res = [m for m in sent if m.get("type") == "pget-result"][-1]
    assert res["failureCategory"] == "http_429"
    assert res["failureCategory"] != "range_unsupported"
    httpd.shutdown()
```

- [ ] **Step 2: Run FAIL**

```powershell
$RepoRoot = git rev-parse --show-toplevel
Set-Location (Join-Path $RepoRoot 'media-catcher-host')
python -m pytest test_pget.py -q
```

Expected: FAIL — still emits `pget-fallback` or missing fields.

- [ ] **Step 3: Implement structured results**

In `downloads.py`:

1. Add `_pget_send_result(id, attemptToken, status, mode, failureCategory, partState)`.
2. Rewrite `_pget_probe` to distinguish: ranges ok / conclusive no-range / transient category.
3. On conclusive no-range before any write: `pget-result` failed/`range_unsupported`/`empty`.
4. On multi-range success: `completed`/`multi-range`/`committed`.
5. Map exceptions: timeout → `timeout`, connection reset → `connection_reset`, short read → `short_read`, HTTP 429 → `http_429`, 5xx → `http_5xx_temporary`, path errors → `local_io`, else `permanent`.
6. Delete all `pget-fallback` sends for transfer outcomes (search and remove).
7. Accept `attemptToken` and include it on every terminal result.
8. Write to `name + ".part"` then atomic `os.replace` on success; cancel removes part when safe.

- [ ] **Step 4: PASS**

```powershell
python -m pytest test_pget.py -q
python -m pytest test_host.py -q
```

- [ ] **Step 5: Commit**

```powershell
git add media-catcher-host/mchost/downloads.py media-catcher-host/test_pget.py media-catcher-host/mc_host.py
git commit -m "feat(host): replace pget-fallback with structured pget-result categories"
```

---

### Task 13: Native single-connection transfer and pget-set-limit lease

**Files:**
- Modify: `media-catcher-host/mchost/downloads.py`
- Modify: `media-catcher-host/mc_host.py` (dispatch `pget-single`, `pget-set-limit`)
- Modify: `media-catcher-host/test_pget.py`

- [ ] **Step 1: Add failing tests**

```python
def test_pget_single_writes_same_filename(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(msg))
    httpd = run_server("no-range")
    host, port = httpd.server_address
    url = "http://%s:%d/file.mp4" % (host, port)
    mc.handle_pget_single({
        "id": "jobS", "attemptToken": "atk-s", "urls": [url],
        "name": "11238-makemebi.net.mp4", "dir": str(tmp_path), "maxConnections": 1,
    })
    assert wait_for(lambda: any(m.get("type") == "pget-result" and m.get("id") == "jobS" for m in sent), timeout=5)
    res = [m for m in sent if m.get("type") == "pget-result" and m["id"] == "jobS"][-1]
    assert res["status"] == "completed"
    assert res["mode"] == "single-connection"
    assert res["partState"] == "committed"
    assert (tmp_path / "11238-makemebi.net.mp4").is_file()
    httpd.shutdown()

def test_set_limit_zero_prevents_new_segment_connections(tmp_path, monkeypatch):
    """Slow range server: after pget-set-limit maxConnections=0, no new GETs open."""
    sent = []
    gets = {"n": 0}
    monkeypatch.setattr(mc, "send", lambda msg: sent.append(msg))

    class SlowRange(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        payload = b"x" * (2 * 1024 * 1024)  # 2 MiB so multi-range uses >1 segment

        def log_message(self, *args):
            pass

        def do_GET(self):
            gets["n"] += 1
            rng = self.headers.get("Range")
            if rng == "bytes=0-0":
                self.send_response(206)
                self.send_header("Content-Range", "bytes 0-0/%d" % len(self.payload))
                self.send_header("Content-Length", "1")
                self.end_headers()
                self.wfile.write(self.payload[:1])
                return
            # Slow body so set-limit can race in-flight work
            a, b = rng.split("=", 1)[1].split("-")
            start, end = int(a), int(b)
            chunk = self.payload[start:end + 1]
            self.send_response(206)
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, len(self.payload)))
            self.send_header("Content-Length", str(len(chunk)))
            self.end_headers()
            # write in small pieces with delay
            off = 0
            while off < len(chunk):
                time.sleep(0.05)
                piece = chunk[off:off + 8192]
                self.wfile.write(piece)
                off += len(piece)

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), SlowRange)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    host, port = httpd.server_address
    url = "http://%s:%d/file.mp4" % (host, port)
    mc.handle_pget({
        "id": "jobL", "attemptToken": "atk-L", "urls": [url],
        "name": "big.mp4", "dir": str(tmp_path), "maxConnections": 4,
    })
    # wait until at least the probe GET happened
    assert wait_for(lambda: gets["n"] >= 1, timeout=3)
    mc.handle_pget_set_limit({"id": "jobL", "maxConnections": 0, "providerGeneration": 1})
    assert wait_for(lambda: any(m.get("type") == "pget-limit-ack" and m.get("id") == "jobL" for m in sent), timeout=3)
    n_at_ack = gets["n"]
    # allow in-flight GETs to finish; no replacement connections after ack
    time.sleep(0.6)
    assert gets["n"] <= n_at_ack + 4  # only already-accepted workers may still read; no unbounded growth
    # after cancel-style limit 0, job should end cancelled or complete without new opens beyond workers alive at ack
    assert wait_for(lambda: any(m.get("type") == "pget-result" and m.get("id") == "jobL" for m in sent), timeout=15)
    httpd.shutdown()
```

Also emit `{type:"pget-limit-ack", id, maxConnections, providerGeneration}` from `handle_pget_set_limit` when the host applies the lease generation.

- [ ] **Step 2: FAIL → Step 3 implement `handle_pget_single` (one connection, truncate/create `.part`, stream full body, atomic promote), `handle_pget_set_limit`, wire cmds in `mc_host.py` → Step 4 PASS**

```powershell
python -m pytest test_pget.py -q
```

Dispatch additions in `mc_host.py`:

```python
elif cmd == "pget-single":
    handle_pget_single(msg)
elif cmd == "pget-set-limit":
    handle_pget_set_limit(msg)
```

- [ ] **Step 5: Commit**

```powershell
git add media-catcher-host/mchost/downloads.py media-catcher-host/mc_host.py media-catcher-host/test_pget.py
git commit -m "feat(host): native single-connection pget and dynamic connection leases"
```

---

### Task 14: Extension native result adapter (no auto-Firefox; range switch)

**Files:**
- Create: `media-catcher/lib/native-result-adapter.js`
- Create: `media-catcher/tests/native-result-adapter.test.js`

**Interfaces:**
- `handlePgetResult(scheduler, msg, { startSingleConnection })`
- Rules:
  - `range_unsupported` + `empty` → `scheduler.onCapabilitySwitch` + `startSingleConnection(job)`
  - other failures → `scheduler.onTransportResult`
  - never call firefox
  - stale attemptToken ignored

- [ ] **Step 1: Write failing tests**

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");
const { handlePgetResult } = loadLib("lib/native-result-adapter.js");

function fakeScheduler(job) {
  const calls = { transport: [], capability: [], firefox: 0 };
  return {
    calls,
    getJob: (id) => (id === job.id ? job : null),
    onTransportResult: (id, token, result) => { calls.transport.push({ id, token, result }); },
    onCapabilitySwitch: (id, info) => { calls.capability.push({ id, info }); job.mode = info.mode; },
  };
}

test("range_unsupported empty switches to single-connection without Firefox", () => {
  const job = {
    id: "j1",
    attemptToken: "atk-1",
    mode: "multi-range",
    intent: Object.freeze({ requestedFilename: "11238-makemebi.net.mp4" }),
    retryRemaining: 3,
  };
  const sched = fakeScheduler(job);
  const started = [];
  handlePgetResult(sched, {
    type: "pget-result", id: "j1", attemptToken: "atk-1",
    status: "failed", mode: "multi-range",
    failureCategory: "range_unsupported", partState: "empty",
  }, {
    startSingleConnection: (j) => { started.push(j.intent.requestedFilename); },
    firefoxDownload: () => { sched.calls.firefox++; },
  });
  assert.equal(sched.calls.firefox, 0);
  assert.equal(sched.calls.capability.length, 1);
  assert.equal(job.mode, "single-connection");
  assert.deepEqual(started, ["11238-makemebi.net.mp4"]);
  assert.equal(sched.calls.transport.length, 0);
});

test("timeout forwards to scheduler transport result, never Firefox", () => {
  const job = { id: "j2", attemptToken: "atk-2", mode: "multi-range", intent: Object.freeze({ requestedFilename: "a.mp4" }) };
  const sched = fakeScheduler(job);
  handlePgetResult(sched, {
    type: "pget-result", id: "j2", attemptToken: "atk-2",
    status: "failed", mode: "multi-range",
    failureCategory: "timeout", partState: "partial",
  }, { startSingleConnection: () => {}, firefoxDownload: () => { sched.calls.firefox++; } });
  assert.equal(sched.calls.firefox, 0);
  assert.equal(sched.calls.transport[0].result.failureCategory, "timeout");
});

test("stale attemptToken is ignored", () => {
  const job = { id: "j3", attemptToken: "fresh", mode: "multi-range", intent: Object.freeze({ requestedFilename: "a.mp4" }) };
  const sched = fakeScheduler(job);
  handlePgetResult(sched, {
    type: "pget-result", id: "j3", attemptToken: "stale",
    status: "completed", mode: "multi-range",
    failureCategory: null, partState: "committed",
  }, { startSingleConnection: () => {}, firefoxDownload: () => { sched.calls.firefox++; } });
  assert.equal(sched.calls.transport.length, 0);
  assert.equal(sched.calls.capability.length, 0);
});
```

- [ ] **Step 2: Run to verify FAIL**

```powershell
node --test media-catcher/tests/native-result-adapter.test.js
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `handlePgetResult` pure function matching the rules above**

- [ ] **Step 4: PASS + commit**

```powershell
node --test media-catcher/tests/native-result-adapter.test.js
git add media-catcher/lib/native-result-adapter.js media-catcher/tests/native-result-adapter.test.js
git commit -m "feat: map structured pget-result into scheduler without Firefox"
```

---

### Task 15: Native file sink (open/chunk/commit/abort)

**Files:**
- Modify: `media-catcher-host/mchost/downloads.py` (or new `mchost/filesink.py` imported by downloads/mc_host)
- Modify: `media-catcher-host/mc_host.py` dispatch
- Create: `media-catcher-host/test_file_sink.py`

**Protocol:**

```text
cmd file-open  { jobId, attemptToken, requestedFilename, dir } -> {type:file-opened, sinkId, jobId, attemptToken}
cmd file-chunk { sinkId, jobId, attemptToken, seq, dataB64, length } -> {type:file-chunk-ack, sinkId, seq}
cmd file-commit { sinkId, jobId, attemptToken } -> {type:file-committed, sinkId, file, bytes}
cmd file-abort { sinkId, jobId, attemptToken } -> {type:file-aborted, sinkId}
```

Native messaging is JSON-only in this codebase today. Use base64 for chunk payloads in messages:

```js
{ cmd: "file-chunk", sinkId, jobId, attemptToken, seq, dataB64, length }
// reply {type:"file-chunk-ack", sinkId, seq}
{ cmd: "file-commit", sinkId, jobId, attemptToken }
// reply {type:"file-committed", sinkId, file, bytes}
{ cmd: "file-abort", sinkId, jobId, attemptToken }
// reply {type:"file-aborted", sinkId}
```

Window: max 4 unacked chunks; reject writes if filename mutation attempted on existing sink; bind filename at open only.

- [ ] **Step 1: Failing tests**

```python
def test_commit_atomically_promotes_part(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda m: sent.append(m))
    mc.handle_file_open({"jobId": "j", "attemptToken": "a1", "requestedFilename": "out.mp4", "dir": str(tmp_path)})
    opened = [m for m in sent if m.get("type") == "file-opened"][0]
    sink = opened["sinkId"]
    import base64
    data = b"hello-video"
    mc.handle_file_chunk({"sinkId": sink, "jobId": "j", "attemptToken": "a1", "seq": 0,
                          "dataB64": base64.b64encode(data).decode("ascii"), "length": len(data)})
    mc.handle_file_commit({"sinkId": sink, "jobId": "j", "attemptToken": "a1"})
    assert any(m.get("type") == "file-committed" for m in sent)
    assert (tmp_path / "out.mp4").read_bytes() == data
    assert not (tmp_path / "out.mp4.part").exists()

def test_abort_removes_partial(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda m: sent.append(m))
    import base64
    mc.handle_file_open({"jobId": "j2", "attemptToken": "a1", "requestedFilename": "partial.mp4", "dir": str(tmp_path)})
    sink = [m for m in sent if m.get("type") == "file-opened"][0]["sinkId"]
    data = b"partial-bytes"
    mc.handle_file_chunk({"sinkId": sink, "jobId": "j2", "attemptToken": "a1", "seq": 0,
                          "dataB64": base64.b64encode(data).decode("ascii"), "length": len(data)})
    part = tmp_path / "partial.mp4.part"
    assert wait_for(lambda: part.exists() or (tmp_path / "partial.mp4").exists() is False, timeout=2)
    mc.handle_file_abort({"sinkId": sink, "jobId": "j2", "attemptToken": "a1"})
    assert any(m.get("type") == "file-aborted" for m in sent)
    assert not part.exists()
    assert not (tmp_path / "partial.mp4").exists()

def test_stale_attempt_token_cannot_commit(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda m: sent.append(m))
    import base64
    mc.handle_file_open({"jobId": "j3", "attemptToken": "gen-1", "requestedFilename": "x.mp4", "dir": str(tmp_path)})
    sink = [m for m in sent if m.get("type") == "file-opened"][0]["sinkId"]
    mc.handle_file_chunk({"sinkId": sink, "jobId": "j3", "attemptToken": "gen-1", "seq": 0,
                          "dataB64": base64.b64encode(b"abc").decode("ascii"), "length": 3})
    mc.handle_file_commit({"sinkId": sink, "jobId": "j3", "attemptToken": "stale-gen"})
    assert not any(m.get("type") == "file-committed" for m in sent)
    err = [m for m in sent if m.get("type") in ("file-error", "file-rejected")]
    assert err, "stale token must produce an error/reject frame"
    assert err[-1].get("failureCategory") == "local_io" or err[-1].get("reason") == "stale-attempt"
    assert not (tmp_path / "x.mp4").exists()

def test_path_rejection_is_local_io_not_fallback(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(mc, "send", lambda m: sent.append(m))
    # Directory that cannot be created / invalid root — use a file path as dir
    bad_dir = tmp_path / "not-a-dir"
    bad_dir.write_text("x", encoding="utf-8")
    mc.handle_file_open({
        "jobId": "j4", "attemptToken": "a1",
        "requestedFilename": "out.mp4", "dir": str(bad_dir),
    })
    assert any(m.get("type") in ("file-error", "file-rejected") for m in sent)
    bad = [m for m in sent if m.get("type") in ("file-error", "file-rejected")][-1]
    assert bad.get("failureCategory") == "local_io"
    assert not any(m.get("type") == "pget-fallback" for m in sent)
    assert not any(m.get("type") == "file-opened" for m in sent)
```

- [ ] **Step 2: Run FAIL**

```powershell
python -m pytest test_file_sink.py -q
```

Expected: FAIL — handlers missing.

- [ ] **Step 3: Implement sink registry** in `media-catcher-host/mchost/filesink.py` (preferred) or `downloads.py`:
  - `handle_file_open` / `handle_file_chunk` / `handle_file_commit` / `handle_file_abort`
  - Bind `jobId+attemptToken+requestedFilename+dir` at open; later messages cannot change filename
  - Write only to `requestedFilename + ".part"`; `os.replace` on commit
  - Abort deletes the `.part` file
  - Max 4 unacknowledged chunks; ack each seq with `{type:"file-chunk-ack", sinkId, seq}`
  - Stale attemptToken → `{type:"file-error", failureCategory:"local_io", reason:"stale-attempt"}`
  - Export handlers; import + dispatch in `mc_host.py` for cmds `file-open`, `file-chunk`, `file-commit`, `file-abort`

- [ ] **Step 4: PASS**

```powershell
python -m pytest test_file_sink.py -q
```

- [ ] **Step 5: Commit**

```powershell
git add media-catcher-host/mchost/filesink.py media-catcher-host/mchost/downloads.py media-catcher-host/mc_host.py media-catcher-host/test_file_sink.py
git commit -m "feat(host): atomic native file sink with chunk window and abort"
```

---

### Task 16: Pure file-sink protocol client + filename retention paths

**Files:**
- Create: `media-catcher/lib/file-sink-protocol.js`
- Create: `media-catcher/tests/file-sink-protocol.test.js`
- Create: `media-catcher/tests/filename-retention.test.js`

**Interfaces (dual-export global `McFileSinkProtocol`):**
- `createFileSinkSession({ jobId, attemptToken, requestedFilename, destinationDirectory })`
- States: `open → streaming → committed|aborted|failed`
- Methods: `openCmd()`, `onOpened(msg)`, `nextChunkCmd(uint8Array)`, `onAck(msg)`, `commitCmd()`, `abortCmd()`, `onHostError(msg)`
- Pure builders (used by background / router):
  - `buildPgetCmd({ jobId, attemptToken, intent, url, maxConnections })` → always sets `name` + `dir` from intent
  - `buildPgetSingleCmd({ jobId, attemptToken, intent, url })` → always sets `name` + `dir` from intent
- Window size constant `MAX_UNACKED = 4`
- Rejects any attempt to change `requestedFilename` after construction
- Host write/commit failures normalize to `{ failureCategory: "local_io", invokeFirefox: false, isSaturation: false }`

- [ ] **Step 1: Write failing tests**

`media-catcher/tests/file-sink-protocol.test.js`:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");
const { createFileSinkSession, MAX_UNACKED } = loadLib("lib/file-sink-protocol.js");

test("open binds filename; chunks respect unacked window", () => {
  const s = createFileSinkSession({
    jobId: "j1", attemptToken: "a1",
    requestedFilename: "11238-makemebi.net.mp4", destinationDirectory: "D:\\\\v",
  });
  assert.deepEqual(s.openCmd(), {
    cmd: "file-open", jobId: "j1", attemptToken: "a1",
    requestedFilename: "11238-makemebi.net.mp4", dir: "D:\\\\v",
  });
  s.onOpened({ type: "file-opened", sinkId: "s1", jobId: "j1", attemptToken: "a1" });
  const cmds = [];
  for (let i = 0; i < MAX_UNACKED; i++) {
    cmds.push(s.nextChunkCmd(new Uint8Array([i])));
  }
  assert.equal(cmds.length, MAX_UNACKED);
  assert.equal(s.nextChunkCmd(new Uint8Array([9])), null); // backpressure
  s.onAck({ type: "file-chunk-ack", sinkId: "s1", seq: 0 });
  assert.ok(s.nextChunkCmd(new Uint8Array([9])));
});

test("commit and abort commands carry bound sink identity", () => {
  const s = createFileSinkSession({
    jobId: "j1", attemptToken: "a1",
    requestedFilename: "out.mp4", destinationDirectory: null,
  });
  s.onOpened({ type: "file-opened", sinkId: "s9", jobId: "j1", attemptToken: "a1" });
  assert.deepEqual(s.commitCmd(), { cmd: "file-commit", sinkId: "s9", jobId: "j1", attemptToken: "a1" });
  assert.deepEqual(s.abortCmd(), { cmd: "file-abort", sinkId: "s9", jobId: "j1", attemptToken: "a1" });
});

test("host error maps to local_io and never flags saturation or firefox", () => {
  const s = createFileSinkSession({
    jobId: "j1", attemptToken: "a1",
    requestedFilename: "out.mp4", destinationDirectory: null,
  });
  s.onOpened({ type: "file-opened", sinkId: "s1", jobId: "j1", attemptToken: "a1" });
  const out = s.onHostError({ type: "file-error", failureCategory: "local_io", reason: "disk full" });
  assert.equal(out.failureCategory, "local_io");
  assert.equal(out.invokeFirefox, false);
  assert.equal(out.isSaturation, false);
  assert.equal(s.state, "failed");
});
```

`media-catcher/tests/filename-retention.test.js`:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");
const Intent = loadLib("lib/download-intent.js");

test("requestedFilename identical across default, save-as, single-connection job, sink open, firefox intent", () => {
  // Mutation: re-ranking on engine change or using pageTitle at save time.
  const proposal = "11238-makemebi.net.mp4";
  const d = Intent.createDefaultIntent({
    proposedFilename: proposal, userActionToken: "t", now: () => "t",
  });
  const s = Intent.createSaveAsIntent({
    proposedFilename: proposal, editedFilename: proposal,
    userActionToken: "t", knownExtension: ".mp4", now: () => "t",
  });
  const fx = Intent.createFirefoxIntent({ baseIntent: d });
  assert.equal(d.requestedFilename, proposal);
  assert.equal(s.requestedFilename, proposal);
  assert.equal(fx.requestedFilename, proposal);
  const job = { intent: d, mode: "multi-range" };
  job.mode = "single-connection";
  assert.equal(job.intent.requestedFilename, proposal);
  const { createFileSinkSession } = loadLib("lib/file-sink-protocol.js");
  const sink = createFileSinkSession({
    jobId: "j", attemptToken: "a",
    requestedFilename: job.intent.requestedFilename, destinationDirectory: null,
  });
  assert.equal(sink.openCmd().requestedFilename, proposal);
});

test("default intent destinationDirectory is null; save-as preserves chosen directory", () => {
  // Mutation: dropping destinationDirectory when building pget / file-open payloads.
  const d = Intent.createDefaultIntent({
    proposedFilename: "11238-makemebi.net.mp4",
    destinationDirectory: null,
    userActionToken: "t", now: () => "t",
  });
  assert.equal(d.destinationDirectory, null);
  const sa = Intent.createSaveAsIntent({
    proposedFilename: "11238-makemebi.net.mp4",
    editedFilename: "11238-makemebi.net.mp4",
    destinationDirectory: "D:\\\\Vids",
    userActionToken: "t", knownExtension: ".mp4", now: () => "t",
  });
  assert.equal(sa.destinationDirectory, "D:\\\\Vids");
});

test("pget, pget-single, and file-open carry requestedFilename and destination directory", () => {
  // Pure payload builders live on file-sink-protocol / router helpers.
  const { buildPgetCmd, buildPgetSingleCmd, createFileSinkSession } =
    loadLib("lib/file-sink-protocol.js");
  const intentDefault = Object.freeze({
    requestedFilename: "11238-makemebi.net.mp4",
    destinationDirectory: null,
    saveMode: "default",
    userSelectedFirefox: false,
    userActionToken: "t",
    createdAt: "t0",
  });
  const intentSaveAs = Object.freeze({
    requestedFilename: "11238-makemebi.net.mp4",
    destinationDirectory: "D:\\\\Vids",
    saveMode: "save-as",
    userSelectedFirefox: false,
    userActionToken: "t",
    createdAt: "t0",
  });
  const pget = buildPgetCmd({
    jobId: "j1", attemptToken: "a1", intent: intentDefault,
    url: "https://cdn/x.mp4", maxConnections: 4,
  });
  assert.equal(pget.cmd, "pget");
  assert.equal(pget.name, "11238-makemebi.net.mp4");
  assert.equal(pget.dir, null);

  const pgetSingle = buildPgetSingleCmd({
    jobId: "j1", attemptToken: "a2", intent: intentSaveAs,
    url: "https://cdn/x.mp4",
  });
  assert.equal(pgetSingle.cmd, "pget-single");
  assert.equal(pgetSingle.name, "11238-makemebi.net.mp4");
  assert.equal(pgetSingle.dir, "D:\\\\Vids");

  const sink = createFileSinkSession({
    jobId: "j1", attemptToken: "a3",
    requestedFilename: intentSaveAs.requestedFilename,
    destinationDirectory: intentSaveAs.destinationDirectory,
  });
  assert.deepEqual(sink.openCmd(), {
    cmd: "file-open", jobId: "j1", attemptToken: "a3",
    requestedFilename: "11238-makemebi.net.mp4", dir: "D:\\\\Vids",
  });

  const sinkDefault = createFileSinkSession({
    jobId: "j2", attemptToken: "a4",
    requestedFilename: intentDefault.requestedFilename,
    destinationDirectory: intentDefault.destinationDirectory,
  });
  assert.equal(sinkDefault.openCmd().dir, null);
  assert.equal(sinkDefault.openCmd().requestedFilename, "11238-makemebi.net.mp4");
});
```

- [ ] **Step 2: Run FAIL**

```powershell
node --test media-catcher/tests/file-sink-protocol.test.js media-catcher/tests/filename-retention.test.js
```

Expected: FAIL — builders missing or destinationDirectory dropped.

- [ ] **Step 3: Implement `file-sink-protocol.js` dual-export with the API above**, including pure `buildPgetCmd` and `buildPgetSingleCmd` that always pass `name` + `dir` from the intent. Default intents use `dir: null` (settings saveFolder resolved by host/background, not by re-reading a mutable page).

- [ ] **Step 4: PASS + commit**

```powershell
node --test media-catcher/tests/file-sink-protocol.test.js media-catcher/tests/filename-retention.test.js
git add media-catcher/lib/file-sink-protocol.js media-catcher/tests/file-sink-protocol.test.js media-catcher/tests/filename-retention.test.js
git commit -m "feat: file-sink client protocol and filename retention guarantees"
```

---

### Task 17: Guarded Firefox adapter + helper-unavailable UX policy

**Files:**
- Create: `media-catcher/lib/firefox-guard.js`
- Create: `media-catcher/tests/firefox-guard.test.js`

**Interfaces:**
- Dual-export global: `McFirefoxGuard`
- `createFirefoxGuard({ downloadsDownload, createObjectURL, revokeObjectURL })`
- `assertUserFirefoxIntent(intent, expectedTokenStore) -> void|throws`
- `helperUnavailableActions() -> Array<{ id, label, autoInvoke }>`
- `downloadWithFirefox({ intent, source: { type:"url", getUrl: fn } | { type:"bytes", bytes, mime }, tokenStore })`
  - requires `intent.userSelectedFirefox === true`
  - requires `intent.userActionToken` present in a one-time popup token set (consume on accept)
  - calls API with `{ filename: intent.requestedFilename, saveAs: true }`
  - never logs URL
  - for bytes: object URL revoked after accept/reject
- Scheduler `requestFirefoxHandoff` (Task 11) is the only integration entry; this guard is the only callee that may touch `downloads.download`.

- [ ] **Step 1: Write the full failing test file**

Create `media-catcher/tests/firefox-guard.test.js`:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");
const {
  createFirefoxGuard,
  assertUserFirefoxIntent,
  helperUnavailableActions,
} = loadLib("lib/firefox-guard.js");

test("rejects userSelectedFirefox false before API call", async () => {
  let calls = 0;
  const g = createFirefoxGuard({ downloadsDownload: async () => { calls++; return 1; } });
  await assert.rejects(() => g.downloadWithFirefox({
    intent: {
      userSelectedFirefox: false,
      requestedFilename: "a.mp4",
      userActionToken: "t",
      destinationDirectory: null,
      saveMode: "default",
      createdAt: "t0",
    },
    source: { type: "url", getUrl: () => "https://x/y?sig=1" },
    tokenStore: new Set(["t"]),
  }));
  assert.equal(calls, 0);
});

test("native failure path cannot mint proof token", () => {
  const store = new Set(["popup-only"]);
  assert.throws(() => assertUserFirefoxIntent({
    userSelectedFirefox: true,
    userActionToken: "forged",
    requestedFilename: "a.mp4",
  }, store));
  assert.equal(store.has("popup-only"), true);
});

test("success uses saveAs true and requestedFilename", async () => {
  let arg = null;
  const store = new Set(["tok"]);
  const g = createFirefoxGuard({
    downloadsDownload: async (opts) => { arg = opts; return 9; },
    createObjectURL: () => "blob:1",
    revokeObjectURL: () => {},
  });
  await g.downloadWithFirefox({
    intent: {
      userSelectedFirefox: true,
      requestedFilename: "11238-makemebi.net.mp4",
      userActionToken: "tok",
      destinationDirectory: null,
      saveMode: "default",
      createdAt: "t0",
    },
    source: { type: "url", getUrl: () => "https://example/x" },
    tokenStore: store,
  });
  assert.equal(arg.filename, "11238-makemebi.net.mp4");
  assert.equal(arg.saveAs, true);
  assert.equal(store.has("tok"), false); // one-time consume
});

test("helper unavailable policy offers firefox action but does not auto-invoke", () => {
  const acts = helperUnavailableActions();
  assert.deepEqual(acts.map((a) => a.id), ["retry-install", "use-firefox", "cancel"]);
  const fx = acts.find((a) => a.id === "use-firefox");
  assert.ok(fx);
  assert.equal(fx.autoInvoke, false);
  assert.equal(typeof fx.label, "string");
  // Policy object never calls downloads — pure data only.
  assert.equal(typeof helperUnavailableActions, "function");
});
```

- [ ] **Step 2: Run — expect FAIL**

```powershell
node --test media-catcher/tests/firefox-guard.test.js
```

Expected: FAIL — module missing or `helperUnavailableActions` undefined.

- [ ] **Step 3: Implement** `media-catcher/lib/firefox-guard.js` dual-export (`McFirefoxGuard`) with `createFirefoxGuard`, `assertUserFirefoxIntent`, and `helperUnavailableActions` returning
`[{ id:"retry-install", label:"Install/reconnect helper", autoInvoke:false }, { id:"use-firefox", label:"Use Firefox instead", autoInvoke:false }, { id:"cancel", label:"Cancel", autoInvoke:false }]`.

- [ ] **Step 4: PASS + commit**

```powershell
node --test media-catcher/tests/firefox-guard.test.js
git add media-catcher/lib/firefox-guard.js media-catcher/tests/firefox-guard.test.js
git commit -m "feat: guarded Firefox adapter requiring explicit popup intent"
```

---

### Task 18: Popup Download + Save As UI and status labels

**Files:**
- Modify: `media-catcher/popup/popup.js`
- Modify: `media-catcher/popup/popup.html` (only if a dialog root element is required)
- Modify: `media-catcher/popup/popup.css`
- Create: `media-catcher/tests/popup-intent.test.js` (pure helpers extracted for testability)

**Extract pure helpers** (in popup or `lib/download-intent.js` already):

Because popup uses browser globals, put testable UI policy in:

- `media-catcher/lib/popup-download-ui.js` dual-export `McPopupDownloadUi` with:
  - `formatJobStatus(job) -> string` using exact labels:
    - `queued` → `Queued`
    - `waiting_provider` → `Waiting for <providerKey>`
    - `running` (not reduced) → `Downloading`
    - `running` (reduced) / `retry_backoff` → `Retrying at reduced concurrency`
    - `pausing_provider` → `Pausing for <providerKey>`
    - `needs_user` → `Needs attention`
    - `handing_off_firefox` → `Handing off to Firefox`
    - `handed_to_firefox` → `Handed to Firefox`
    - `failed` → `Failed`
    - `completed` → `Completed`
    - `cancelled` → `Cancelled`
  - `buildDownloadMessage({ item, intent, tabId, selection })`
  - `validateSaveAsFilename(edited, knownExtension) -> { ok, filename, warning }`

- [ ] **Step 1: Write failing tests** in `media-catcher/tests/popup-intent.test.js`

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");
const UI = loadLib("lib/popup-download-ui.js");
const Intent = loadLib("lib/download-intent.js");

test("status labels match observability table including drain and firefox states", () => {
  assert.equal(UI.formatJobStatus({ state: "queued" }), "Queued");
  assert.equal(UI.formatJobStatus({ state: "waiting_provider", providerKey: "florenfile.com" }),
    "Waiting for florenfile.com");
  assert.equal(UI.formatJobStatus({ state: "running", mode: "multi-range" }), "Downloading");
  assert.equal(UI.formatJobStatus({ state: "running", reduced: true }), "Retrying at reduced concurrency");
  assert.equal(UI.formatJobStatus({ state: "retry_backoff", providerKey: "florenfile.com" }),
    "Retrying at reduced concurrency");
  assert.equal(UI.formatJobStatus({ state: "pausing_provider", providerKey: "florenfile.com" }),
    "Pausing for florenfile.com");
  assert.equal(UI.formatJobStatus({ state: "needs_user" }), "Needs attention");
  assert.equal(UI.formatJobStatus({ state: "handing_off_firefox" }), "Handing off to Firefox");
  assert.equal(UI.formatJobStatus({ state: "handed_to_firefox" }), "Handed to Firefox");
  assert.equal(UI.formatJobStatus({ state: "failed" }), "Failed");
  assert.equal(UI.formatJobStatus({ state: "completed" }), "Completed");
  assert.equal(UI.formatJobStatus({ state: "cancelled" }), "Cancelled");
});

test("Save As cancel returns null and must not produce an enqueue message", () => {
  // Mutation: enqueue on dialog open or cancel.
  const decision = UI.decideSaveAsForm({ action: "cancel", proposedFilename: "11238-makemebi.net.mp4" });
  assert.equal(decision, null);
});

test("Save As confirm builds save-as intent with edited name", () => {
  const decision = UI.decideSaveAsForm({
    action: "confirm",
    proposedFilename: "11238-makemebi.net.mp4",
    editedFilename: "my-cut",
    knownExtension: ".mp4",
    destinationDirectory: null,
    userActionToken: "tok-ui",
    now: () => "2026-08-12T12:00:00.000Z",
  });
  assert.equal(decision.intent.saveMode, "save-as");
  assert.equal(decision.intent.requestedFilename, "my-cut.mp4");
  assert.equal(decision.enqueue, true);
});

test("Download button builds default intent from proposedFilename", () => {
  const msg = UI.buildDownloadMessage({
    item: { url: "https://x/a.mp4", kind: "direct", proposedFilename: "11238-makemebi.net.mp4", tabId: 3 },
    tabId: 3,
    userActionToken: "tok-d",
    now: () => "t",
    selection: {},
  });
  assert.equal(msg.type, "download");
  assert.equal(msg.intent.requestedFilename, "11238-makemebi.net.mp4");
  assert.equal(msg.intent.saveMode, "default");
  assert.equal(msg.intent.userSelectedFirefox, false);
});
```

- [ ] **Step 2: Run FAIL**

```powershell
node --test media-catcher/tests/popup-intent.test.js
```

- [ ] **Step 3: Implement `lib/popup-download-ui.js` and wire popup**

Implement dual-export API: `formatJobStatus`, `decideSaveAsForm`, `buildDownloadMessage`, `validateSaveAsFilename`.

Popup behavior (edit `popup.js` / `popup.css`; add dialog markup in `popup.html` only if a static host element is cleaner than pure JS creation):

1. Each downloadable row keeps primary **Download**; add **Save As…** for direct/hls/dash/youtube (not DRM).
2. **Download** sends `UI.buildDownloadMessage(...)` via `send(msg)`.
3. **Save As…** opens inline form in `.slot`:
   - text input prefilled with `item.proposedFilename || item.name`
   - **Choose folder…** uses existing `pick-folder` message when helper ready
   - **Confirm** / **Cancel**
   - Cancel calls `decideSaveAsForm({action:"cancel"})` and clears the form without `send`
   - Confirm sends `{ type:"download", item, tabId, intent, variantUrl, variantId, ytHeight, ytAudioOnly }`
4. Needs-attention download rows show **Retry**, **Use Firefox instead**, **Cancel** → messages `retry-download` / `use-firefox` / `cancel` with job `id`.
5. Name line prefers `item.proposedFilename` over mutable `pageTitle`.

CSS: form row uses existing surface/stroke variables; input full width; buttons match `.btn` / `.btn ghost sm`.

- [ ] **Step 4: PASS pure tests**

```powershell
node --test media-catcher/tests/popup-intent.test.js
```

- [ ] **Step 5: Commit**

```powershell
git add media-catcher/popup/popup.js media-catcher/popup/popup.css media-catcher/popup/popup.html media-catcher/lib/popup-download-ui.js media-catcher/tests/popup-intent.test.js
git commit -m "feat(popup): Download and Save As with smart filename and queue status labels"
```

---

### Task 19: Privacy sentinels, allowlist projectors, ephemeral terminal cleanup

**Files:**
- Create: `media-catcher/lib/privacy.js`
- Create: `media-catcher/tests/privacy.test.js`

**Interfaces (dual-export global `McPrivacy`):**
- `createEphemeral(mediaUrl, requestHeaders) -> EphemeralRequestContext` with `clear()`
- `projectSafeHistory(jobOrItem) -> { requestedFilename, providerKey, status, bytes, ts }`
- `projectPopupJob(job) ->` allowlisted fields only (no ephemeral URL/headers, no sourceContext URLs)
- `redactUrlForLog(url) ->` strips query
- `assertNoSentinels(blob, sentinels[])`
- Terminal cleanup contract: `clearEphemeralOnTerminal(job, state)` must call `ephemeral.clear()` exactly once when `state` is one of `completed | failed | cancelled | handed_to_firefox`

**Ordering note:** This module is created **before** background integration (Task 20). Task 20 wires `projectSafeHistory` / `projectPopupJob` / `redactUrlForLog` at every storage/history/popup/diagnostic write site. Do not reference `lib/privacy.js` from earlier tasks.

- [ ] **Step 1: Write failing tests**

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");
const P = loadLib("lib/privacy.js");

const SIGNED = "https://cdn.example/file.mp4?token=SECRET_SIGNED_QUERY_XYZ&exp=99";
const COOKIE = "session=SECRET_COOKIE_ABC";

test("safe history allowlist excludes URLs and headers", () => {
  const hist = P.projectSafeHistory({
    intent: { requestedFilename: "11238-makemebi.net.mp4" },
    providerKey: "florenfile.com",
    state: "completed",
    bytes: 123,
    completedAt: 1,
    ephemeral: { mediaUrl: SIGNED, requestHeaders: { Cookie: COOKIE } },
    sourceContext: { topLevelPageUrl: "https://florenfile.com/x" },
  });
  const raw = JSON.stringify(hist);
  assert.equal(raw.includes("SECRET_SIGNED_QUERY_XYZ"), false);
  assert.equal(raw.includes("SECRET_COOKIE_ABC"), false);
  assert.equal(raw.includes("https://florenfile.com"), false);
  assert.equal(hist.requestedFilename, "11238-makemebi.net.mp4");
  assert.equal(hist.providerKey, "florenfile.com");
});

test("projectPopupJob never serializes ephemeral object", () => {
  const e = P.createEphemeral(SIGNED, { Cookie: COOKIE });
  const job = {
    id: "j1",
    state: "running",
    providerKey: "florenfile.com",
    intent: { requestedFilename: "a.mp4", destinationDirectory: null },
    ephemeral: e,
    sourceContext: { topLevelPageUrl: "https://florenfile.com/x", mediaOrigin: "https://cdn" },
  };
  const view = P.projectPopupJob(job);
  const raw = JSON.stringify(view);
  assert.equal(raw.includes("SECRET_SIGNED_QUERY_XYZ"), false);
  assert.equal(raw.includes("SECRET_COOKIE_ABC"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(view, "ephemeral"), false);
  assert.equal(view.requestedFilename, "a.mp4");
});

test("log redaction strips query strings", () => {
  assert.equal(P.redactUrlForLog(SIGNED).includes("SECRET_SIGNED_QUERY_XYZ"), false);
});

test("ephemeral clear nulls URL and headers", () => {
  const e = P.createEphemeral(SIGNED, { Cookie: COOKIE });
  e.clear();
  assert.equal(e.mediaUrl, null);
  assert.equal(e.requestHeaders, null);
});

test("terminal cleanup clears ephemeral on completed failed cancelled handed_to_firefox", () => {
  for (const state of ["completed", "failed", "cancelled", "handed_to_firefox"]) {
    const e = P.createEphemeral(SIGNED, { Cookie: COOKIE });
    const job = { ephemeral: e, state: "running" };
    P.clearEphemeralOnTerminal(job, state);
    assert.equal(e.mediaUrl, null, state);
    assert.equal(e.requestHeaders, null, state);
  }
  // Non-terminal states must not clear.
  const e2 = P.createEphemeral(SIGNED, { Cookie: COOKIE });
  const job2 = { ephemeral: e2, state: "running" };
  P.clearEphemeralOnTerminal(job2, "running");
  assert.equal(e2.mediaUrl, SIGNED);
  P.clearEphemeralOnTerminal(job2, "queued");
  assert.equal(e2.mediaUrl, SIGNED);
});

test("assertNoSentinels fails when signed query leaks", () => {
  assert.throws(() => P.assertNoSentinels(
    JSON.stringify({ url: SIGNED }),
    ["SECRET_SIGNED_QUERY_XYZ", "SECRET_COOKIE_ABC"]
  ));
  assert.doesNotThrow(() => P.assertNoSentinels(
    JSON.stringify({ requestedFilename: "a.mp4" }),
    ["SECRET_SIGNED_QUERY_XYZ", "SECRET_COOKIE_ABC"]
  ));
});
```

- [ ] **Step 2: Run — expect FAIL**

```powershell
node --test media-catcher/tests/privacy.test.js
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement** dual-export `McPrivacy` with allowlist projectors only (never object-spread a job). `createEphemeral` returns a non-serializable context object with `clear()`. `clearEphemeralOnTerminal` is idempotent.

- [ ] **Step 4: PASS + commit**

```powershell
node --test media-catcher/tests/privacy.test.js
git add media-catcher/lib/privacy.js media-catcher/tests/privacy.test.js
git commit -m "feat: privacy allowlist projectors and ephemeral terminal cleanup"
```

---

### Task 20: Wire background.js to policy modules (end-to-end adapter)

**Files:**
- Modify: `media-catcher/manifest.json` (script include order)
- Modify: `media-catcher/background.js`
- Modify: `media-catcher/content.js`
- Create: `media-catcher/lib/download-message-router.js`
- Create: `media-catcher/tests/download-message-router.test.js`
- Create: `media-catcher/tests/background-adapters.test.js` for pure extracted glue if useful

**Depends on:** Task 19 (`lib/privacy.js` must already exist). Wire projectors here; do not create privacy in this task.

**Manifest script order** (insert new pure libs before `background.js`; `download-message-router.js` required so its classic-script global exists at runtime):

```json
"scripts": [
  "lib/hls.js",
  "lib/dash.js",
  "lib/commands.js",
  "lib/filename.js",
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
  "lib/popup-download-ui.js",
  "lib/download-message-router.js",
  "lib/mux.js",
  "background.js"
]
```

**background.js wiring checklist (must all be done in this task):**

1. Instantiate singleton `scheduler`, `providerRegistry`, `detectionFinalizer`, `firefoxGuard`, popup token store.
2. Replace `addMedia` network path with `mapWebRequestDetails(details, hints)` → `beginNetworkDetection` → finalize → only then insert into `mediaByTab` with `sourceContext`, `proposedFilename`, `providerKey`. Pass `details.documentId` when Firefox exposes it; never invent tab-only correlation keys.
3. Content script: send document-scoped snapshots with the complete shape:
   ```js
   {
     type: "page-snapshot",
     documentId: string | null,
     documentNonce: string,
     tabId: number,
     frameId: number,
     pageUrl: string,
     topLevelPageUrl: string,
     candidates: Array<{ kind: string, value: string }>,
     capturedAt: string
   }
   ```
   When Firefox exposes a document id to the content script, include the same id; otherwise `documentId: null`. Keep `page-info` for display-only if needed but do not let it mutate finalized items.
4. `download` / `save-as-download` messages: build/accept intent, `scheduler.createJob` + `enqueue`; do not call `api.downloads.download` directly. Save-As form editing creates no job until confirm.
5. Remove `pget-fallback` browser download branch; handle `pget-result` via adapter + router.
6. `downloadDirect`: post `pget` via `buildPgetCmd` with `attemptToken`, `maxConnections` from lease, `name: intent.requestedFilename`, `dir: intent.destinationDirectory` (null for default intents → settings saveFolder).
7. On capability switch: post `pget-single` via `buildPgetSingleCmd` with same name/dir/urls/token generation.
8. HLS/DASH completion: stream bytes through file-sink protocol (`file-open` with both `requestedFilename` and `dir` from intent) instead of `saveBytes`/`browser.downloads` (except explicit Firefox).
9. `makeFetchFn`: acquire via **`scheduler.acquireProviderPermit(jobId, purpose)` only** (never `ProviderGate.acquire` directly); release in `finally`; one transport attempt per scheduler-issued token.
10. Tab navigation: do not cancel jobs; do not re-read tab title into existing items; `decorate()` must prefer `item.proposedFilename` / frozen context titles.
11. Helper disconnect on active native job → `needs_user` with `helperUnavailableActions()` (no auto Firefox).
12. Explicit **Use Firefox instead** / handoff path calls **only** `scheduler.requestFirefoxHandoff(jobId, intent)` — never `downloads.download` from background handlers.
13. Terminal transitions (`completed` / `failed` / `cancelled` / `handed_to_firefox`) call `McPrivacy.clearEphemeralOnTerminal`.
14. Every `storage.local` / safe history / popup snapshot / diagnostic write uses `projectSafeHistory` or `projectPopupJob` or `redactUrlForLog` — never `JSON.stringify(job)` with ephemeral attached.

**content.js candidate collection (bounded):**

Collect only:

- `document.title`
- `og:title` / `twitter:title`
- `h1,h2` text (first 3, max 120 chars each)
- elements matching `[download], [data-filename], .filename, .file-name, a[href$=".mp4"]` near media (limit 10)
- media `title` / `aria-label`
- path segments of `location.href` and `document.referrer`

Never include cookies or full body text.

- [ ] **Step 1: Write failing router + destination tests**

Create `media-catcher/lib/download-message-router.js` and `media-catcher/tests/download-message-router.test.js`:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");
const {
  routeNativeMessage,
  normalizeDownloadRequest,
  buildNativeStartPayload,
} = loadLib("lib/download-message-router.js");

test("pget-result range_unsupported routes to single-connection start", () => {
  const out = routeNativeMessage({
    type: "pget-result", id: "j", attemptToken: "a",
    status: "failed", mode: "multi-range",
    failureCategory: "range_unsupported", partState: "empty",
  });
  assert.equal(out.action, "start-single-connection");
  assert.equal(out.invokeFirefox, false);
});

test("pget-result timeout routes to scheduler failure not firefox", () => {
  const out = routeNativeMessage({
    type: "pget-result", id: "j", attemptToken: "a",
    status: "failed", mode: "multi-range",
    failureCategory: "timeout", partState: "partial",
  });
  assert.equal(out.action, "transport-result");
  assert.equal(out.invokeFirefox, false);
});

test("download without intent builds from proposedFilename with null destinationDirectory", () => {
  const req = normalizeDownloadRequest({
    type: "download",
    item: { proposedFilename: "11238-makemebi.net.mp4", kind: "direct", url: "https://x/a.mp4" },
    tabId: 1,
    userActionToken: "tok",
  });
  assert.equal(req.intent.requestedFilename, "11238-makemebi.net.mp4");
  assert.equal(req.intent.userSelectedFirefox, false);
  assert.equal(req.intent.destinationDirectory, null);
  assert.equal(req.intent.saveMode, "default");
});

test("save-as request preserves destinationDirectory and requestedFilename", () => {
  const req = normalizeDownloadRequest({
    type: "download",
    item: { proposedFilename: "11238-makemebi.net.mp4", kind: "direct", url: "https://x/a.mp4" },
    tabId: 1,
    userActionToken: "tok",
    intent: {
      requestedFilename: "11238-makemebi.net.mp4",
      destinationDirectory: "D:\\\\Vids",
      saveMode: "save-as",
      userSelectedFirefox: false,
      userActionToken: "tok",
      createdAt: "t0",
    },
  });
  assert.equal(req.intent.destinationDirectory, "D:\\\\Vids");
  assert.equal(req.intent.requestedFilename, "11238-makemebi.net.mp4");
});

test("native start payloads for pget pget-single file-open carry name and dir", () => {
  const intent = {
    requestedFilename: "11238-makemebi.net.mp4",
    destinationDirectory: "D:\\\\Vids",
    saveMode: "save-as",
    userSelectedFirefox: false,
    userActionToken: "tok",
    createdAt: "t0",
  };
  const pget = buildNativeStartPayload({
    kind: "pget", jobId: "j", attemptToken: "a", intent, url: "https://cdn/x.mp4", maxConnections: 2,
  });
  assert.equal(pget.cmd, "pget");
  assert.equal(pget.name, "11238-makemebi.net.mp4");
  assert.equal(pget.dir, "D:\\\\Vids");

  const single = buildNativeStartPayload({
    kind: "pget-single", jobId: "j", attemptToken: "a2", intent, url: "https://cdn/x.mp4",
  });
  assert.equal(single.cmd, "pget-single");
  assert.equal(single.name, "11238-makemebi.net.mp4");
  assert.equal(single.dir, "D:\\\\Vids");

  const open = buildNativeStartPayload({
    kind: "file-open", jobId: "j", attemptToken: "a3", intent,
  });
  assert.equal(open.cmd, "file-open");
  assert.equal(open.requestedFilename, "11238-makemebi.net.mp4");
  assert.equal(open.dir, "D:\\\\Vids");

  const def = buildNativeStartPayload({
    kind: "pget", jobId: "j2", attemptToken: "b",
    intent: { ...intent, destinationDirectory: null, saveMode: "default" },
    url: "https://cdn/y.mp4", maxConnections: 1,
  });
  assert.equal(def.dir, null);
});

test("use-firefox routes exclusively to requestFirefoxHandoff action", () => {
  const out = routeNativeMessage({ type: "use-firefox", jobId: "j", intent: {
    userSelectedFirefox: true, userActionToken: "tok", requestedFilename: "a.mp4",
  }});
  assert.equal(out.action, "request-firefox-handoff");
  assert.equal(out.invokeFirefox, false); // background must call scheduler API, not downloads directly
});

test("legacy pget-fallback must not map to firefox", () => {
  const out = routeNativeMessage({ type: "pget-fallback", id: "j", reason: "no-range" });
  assert.equal(out.invokeFirefox, false);
  assert.ok(out.action === "ignore-legacy" || out.action === "transport-result");
});
```

- [ ] **Step 2: Run FAIL then implement router**

```powershell
node --test media-catcher/tests/download-message-router.test.js
```

Expected: FAIL — module missing. Implement dual-export `McDownloadMessageRouter` with `routeNativeMessage`, `normalizeDownloadRequest`, `buildNativeStartPayload`.

- [ ] **Step 3: Wire background.js and content.js** per the checklist above (all 14 items). Delete the live `pget-fallback` → `api.downloads.download` branch. Route Firefox exclusively through `scheduler.requestFirefoxHandoff`. Use privacy projectors at every write site.

- [ ] **Step 4: Run all automated suites**

```powershell
$RepoRoot = git rev-parse --show-toplevel
Set-Location $RepoRoot
node --test media-catcher/tests
Set-Location media-catcher-host
python -m pytest test_pget.py test_file_sink.py test_host.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add media-catcher/manifest.json media-catcher/background.js media-catcher/content.js media-catcher/lib media-catcher/tests
git commit -m "feat: wire background detection, scheduler, privacy projectors, and native results end-to-end"
```

---

### Task 21: Options copy for parallel downloads queue

**Files:**
- Modify: `media-catcher/options/options.html`

- [ ] **Step 1: Change labels/help** (no automated test; verify by file content assertion script optional)

Update:

```html
<label class="row">
  <span class="label">Parallel downloads</span>
  <input id="maxConcurrentDownloads" type="number" min="1" max="6" />
</label>
<p class="hint">Maximum mCatcher downloads running at once. Extra jobs wait in the queue until a slot frees. Already-running jobs are not cancelled if you lower this.</p>

<label class="row">
  <span class="label">Automatic retries</span>
  <input id="retries" type="number" min="0" max="10" />
</label>
<p class="hint">Finite automatic retries for transient network failures and provider wait wake-ups (0–10). Exhausted jobs need manual Retry.</p>
```

Keep `id="retries"` and `id="maxConcurrentDownloads"` for settings compatibility. Segment concurrency label stays "Parallel segment fetches".

- [ ] **Step 2: Commit**

```powershell
git add media-catcher/options/options.html
git commit -m "docs(options): clarify parallel downloads queue and retry budget"
```

---

### Task 22: Full automated regression suite gate

**Files:**
- Create: `media-catcher/tests/regression-matrix.test.js` that imports behaviors already covered and adds any missing assertions from the design "Additional required regression coverage" list that are not yet present.
- Create: `media-catcher/tests/global-export-map.test.js` full dual-export smoke for every locked module.
- Optionally create `scripts/run-tests.ps1` at repo root for one-shot CI-like run (allowed; not production code).

- [ ] **Step 1: Ensure every regression bullet has a named test**

Checklist (each must already exist from prior tasks — add only if missing; do not leave unchecked):

1. Hard global admission — Task 9
2. Lower limit no cancel — Task 9
3. waiting_provider / retry_backoff / needs_user release capacity; pausing_provider once after drain — Tasks 10–11
4. Pending detection document races — Task 4
5. Missing documentId exact-URL reuse only; no tab+frame merge — Task 4
6. mapWebRequestDetails preserves/nulls documentId — Task 4
7. Frozen source context + propose-once — Tasks 3–4
8. Shared CDN two providers not merged — Task 6
9. Registry 0/1/many — Task 6
10. queued/needs_user not active sibling — Task 7
11. normalizeBrowserError + normalizeNativeFailure category matrix — Task 7
12. Saturation denies new connections / reduces owner — Tasks 8–10
13. acquireProviderPermit sole wrapper + generation-bound release — Task 10
14. No sibling → bounded retry — Task 10
15. Wake re-enters global admission; charges failed waiter only (maxConcurrent>=3 three-job case) — Task 11
16. needs_user releases slot and admits peer — Task 11
17. Save-As editing / createJob without enqueue holds no slot — Task 11 / 18
18. Genuine no-range native single-connection — Tasks 12–13
19. Transient ≠ no-range — Task 12
20. Range-to-single empty part, same job/slot/filename, no retry — Tasks 11–14
21. Stale attempt tokens — Task 11 + sink tests
22. Filename + destinationDirectory on pget / pget-single / file-open — Tasks 16, 20
23. Helper unavailable presents Firefox only (autoInvoke:false) — Task 17
24. Firefox guard rejects false / forged — Task 17
25. requestFirefoxHandoff token rules, slot release, API reject → needs_user — Task 11
26. Sink commit atomic / abort removes part — Task 15
27. local_io never saturation/Firefox — Task 16
28. Duplicate native terminals no double-release — Task 11
29. Privacy sentinels + ephemeral terminal clear on completed/failed/cancelled/handed_to_firefox — Task 19
30. Florenfile filename — Task 2
31. Same provider different CDN — Task 10
32. Independent providers concurrent — Task 10
33. Finite retries — Task 11
34. Visible labels for retry_backoff, pausing_provider, handing_off_firefox, handed_to_firefox, failed — Task 18
35. Dual-export GLOBAL_EXPORT_MAP smoke for every pure module — this task

- [ ] **Step 2: Write full global-export smoke**

Create `media-catcher/tests/global-export-map.test.js`:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const { mediaCatcherRoot } = require("./harness/load-lib.js");

const GLOBAL_EXPORT_MAP = {
  "lib/filename-ranker.js": "McFilenameRanker",
  "lib/source-context.js": "McSourceContext",
  "lib/detection-finalizer.js": "McDetectionFinalizer",
  "lib/download-intent.js": "McDownloadIntent",
  "lib/provider-registry.js": "McProviderRegistry",
  "lib/failure-classify.js": "McFailureClassify",
  "lib/provider-gate.js": "McProviderGate",
  "lib/download-scheduler.js": "McDownloadScheduler",
  "lib/native-result-adapter.js": "McNativeResultAdapter",
  "lib/file-sink-protocol.js": "McFileSinkProtocol",
  "lib/firefox-guard.js": "McFirefoxGuard",
  "lib/privacy.js": "McPrivacy",
  "lib/popup-download-ui.js": "McPopupDownloadUi",
  "lib/download-message-router.js": "McDownloadMessageRouter",
};

for (const [rel, globalName] of Object.entries(GLOBAL_EXPORT_MAP)) {
  test(`dual-export ${rel} assigns ${globalName}`, () => {
    const abs = path.join(mediaCatcherRoot, rel);
    assert.equal(fs.existsSync(abs), true, rel + " must exist");
    const code = fs.readFileSync(abs, "utf8");
    const root = {};
    const sandbox = {
      module: { exports: {} },
      exports: {},
      require,
      console,
      self: root,
    };
    sandbox.module.exports = sandbox.exports;
    vm.runInNewContext(code, sandbox, { filename: abs });
    assert.equal(typeof root[globalName], "object");
    assert.notEqual(root[globalName], null);
    assert.equal(root[globalName], sandbox.module.exports);
  });
}

test("manifest background scripts include download-message-router before background.js", () => {
  const mf = JSON.parse(fs.readFileSync(path.join(mediaCatcherRoot, "manifest.json"), "utf8"));
  const scripts = mf.background.scripts;
  const routerIdx = scripts.indexOf("lib/download-message-router.js");
  const bgIdx = scripts.indexOf("background.js");
  const privacyIdx = scripts.indexOf("lib/privacy.js");
  assert.ok(routerIdx >= 0, "download-message-router.js must be in background.scripts");
  assert.ok(privacyIdx >= 0, "privacy.js must be in background.scripts");
  assert.ok(routerIdx < bgIdx);
  assert.ok(privacyIdx < bgIdx);
});
```

- [ ] **Step 3: Run full suite**

```powershell
$RepoRoot = git rev-parse --show-toplevel
Set-Location $RepoRoot
node --test media-catcher/tests
Set-Location media-catcher-host
python -m pytest -q
```

Expected: all PASS. `requestFirefoxHandoff` tests from Task 11 must already be green — this task does not introduce handoff for the first time.

- [ ] **Step 4: Commit**

```powershell
git add media-catcher/tests media-catcher-host
git commit -m "test: complete regression matrix for save-as, ranker, and provider queue"
```

---

### Task 23: Version stamp and package build

**Files:**
- Modify: `media-catcher/manifest.json` → `"version": "1.10.0"`
- Modify: `media-catcher-host/mc_host.py` → `VERSION = "1.10.0"`
- Modify: `media-catcher-host/installer/media-catcher-host.iss` → `#define AppVersion "1.10.0"`

- [ ] **Step 1: Stamp versions**

```powershell
$RepoRoot = git rev-parse --show-toplevel
Set-Location $RepoRoot
(Get-Content media-catcher/manifest.json -Raw) -replace '"version"\s*:\s*"[0-9.]+"', '"version": "1.10.0"' | Set-Content media-catcher/manifest.json -NoNewline -Encoding utf8
(Get-Content media-catcher-host/mc_host.py -Raw) -replace 'VERSION\s*=\s*"[0-9.]+"', 'VERSION = "1.10.0"' | Set-Content media-catcher-host/mc_host.py -NoNewline -Encoding utf8
(Get-Content media-catcher-host/installer/media-catcher-host.iss -Raw) -replace '#define AppVersion "[0-9.]+"', '#define AppVersion "1.10.0"' | Set-Content media-catcher-host/installer/media-catcher-host.iss -NoNewline -Encoding utf8
```

- [ ] **Step 2: Sanity compile + tests**

```powershell
python -m py_compile media-catcher-host/mc_host.py
python -m py_compile media-catcher-host/mchost/downloads.py
Set-Location media-catcher-host; python -m pytest -q
Set-Location ..
node --test media-catcher/tests
```

- [ ] **Step 3: Package extension zip (unsigned source package)**

```powershell
New-Item -ItemType Directory -Force dist | Out-Null
if (Test-Path dist/media_catcher-1.10.0.zip) { Remove-Item dist/media_catcher-1.10.0.zip }
Compress-Archive -Path media-catcher/* -DestinationPath dist/media_catcher-1.10.0.zip -Force
```

- [ ] **Step 4: Commit**

```powershell
git add media-catcher/manifest.json media-catcher-host/mc_host.py media-catcher-host/installer/media-catcher-host.iss
git commit -m "chore: stamp Media Catcher 1.10.0 for save-as and provider queue release"
```

Do not commit `dist/` artifacts (gitignored or leave untracked).

---

### Task 24: Manual Firefox Developer Edition installation and verification checklist

**Files:** none (checklist only; paste results into PR description when executing)

This task is the human/agent manual gate. Every checkbox must be performed on a real Firefox Developer Edition profile.

- [ ] **Step 1: Install temporary add-on**

1. Open Firefox Developer Edition.
2. Navigate to `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and select `media-catcher/manifest.json`.
4. Confirm toolbar icon **Media Catcher** appears and version is `1.10.0` in `about:addons` or the popup footer if shown.

- [ ] **Step 2: Install / reconnect native helper**

1. From repo, ensure helper registered (existing `media-catcher-host/install.ps1` or installer).
2. Open extension popup → helper status green/ready.
3. If disconnected, open setup page and reinstall helper, restart Firefox, reload temporary add-on.

- [ ] **Step 3: Florenfile acceptance**

1. Open `https://florenfile.com/qnzjnabo3jec/11238-makemebi.net.mp4.html`.
2. Play media if needed so network detection fires.
3. Open popup: proposed/display name must be **`11238-makemebi.net.mp4`** (not `Florenfile.com - Secure Cloud Storage`).
4. Click **Download** → job uses that filename.
5. Detect again or use second item if present → **Save As…** → confirm unchanged proposal → same filename on disk.

- [ ] **Step 4: Queue enforcement**

1. Options → Parallel downloads = `1`.
2. Start two downloads from different pages/providers.
3. Observe first `Downloading`, second `Queued`.
4. Lower was already 1; raise to 2 and confirm second can start when capacity allows.
5. Lower to 1 while two would want to run: active job continues; new work stays queued.

- [ ] **Step 5: Provider wait behavior (if reproducible)**

1. From one provider, start two direct downloads with maxConcurrent ≥ 2.
2. If saturation occurs (429/timeouts under load), non-owner shows `Waiting for <site>` and does **not** open a Firefox download dialog automatically.

- [ ] **Step 6: No-range / single-connection**

1. Against a known no-range host or local test server, start direct download with helper ready.
2. Confirm download still completes natively (single-connection) without Firefox Save dialog unless user asked.

- [ ] **Step 7: Explicit Firefox only**

1. Force a permanent failure (disconnect helper mid-job or invalid path).
2. UI shows **Use Firefox instead** but does not auto-trigger.
3. Click it → Firefox Save As dialog opens with the smart/edited filename.
4. Cancel Firefox dialog → job returns to needs attention without leaking a scheduler slot (another job can run).

- [ ] **Step 8: HLS/DASH sink**

1. Download a short non-DRM HLS clip.
2. Confirm file lands via helper path (savedPath on job) and no unexpected Firefox download entry appears for the assembled media.
3. Cancel mid-download → no orphan `.part` left in the destination folder (or it is removed).

- [ ] **Step 9: Privacy spot-check**

1. Open Options log console / history if available.
2. Confirm no raw signed query tokens or Cookie headers appear for the Florenfile media URL.

- [ ] **Step 10: Record results**

Write a short verification note (for the PR) with date, Firefox version, helper version `1.10.0`, and pass/fail per step above. No code commit required unless fixes are needed (fixes go through TDD tasks 2–22, not silent edits).

---

## Execution notes for workers

1. Work tasks **in order**. Do not parallelize tasks that modify the same file (`download-scheduler.js`, `background.js`, `downloads.py`).
2. Every behavior change follows: failing test → seen failure → minimal implementation → pass → commit.
3. Prefer pure modules; keep `background.js` as a thin adapter.
4. When tests disagree with this plan's sketch code, **tests + approved design win**; update implementation, not the acceptance filename `11238-makemebi.net.mp4`.
5. PowerShell quoting: use single quotes for JS/python -m argument lists when possible; `Set-Location` to repo root before `node --test media-catcher/tests`.
6. After Task 22, the definition of done is: all automated tests green + Task 24 manual checklist completed + no remaining `pget-fallback` Firefox path in `background.js` (`Select-String pget-fallback` returns only historical comments if any, not live API calls).

## Final verification commands (copy/paste)

```powershell
$RepoRoot = git rev-parse --show-toplevel
Set-Location $RepoRoot
node --test media-catcher/tests
Set-Location media-catcher-host
python -m pytest -q
python -m py_compile mc_host.py
Set-Location ..
Select-String -Path media-catcher/background.js -Pattern "pget-fallback|downloads\.download"
# downloads.download may remain only inside firefox-guard usage sites; pget-fallback must not auto-call it.
Select-String -Path media-catcher-host -Pattern "pget-fallback" -Recurse
# must be zero live sends
```

---

## Plan self-review (author)

**Spec coverage:** Goals 1–9, non-goals, architecture components, source context, ranking table, Save As intent, provider identity, scheduler states, saturation, retries, fallback ladder, Firefox guard, cancellation, privacy, settings, mandatory tests 1–7, regression bullets, observability labels (including retry_backoff / pausing_provider / handing_off_firefox / handed_to_firefox / failed), rollout checkpoints, and completion definition are each mapped to Tasks 1–24.

**Ordering:** Privacy module (Task 19) is created before background integration (Task 20). `requestFirefoxHandoff` is fully tested in Task 11 before the Task 22 regression gate. File inventory and manifest script order both list `lib/download-message-router.js`. Dual-export `GLOBAL_EXPORT_MAP` is locked in the shared contract and smoke-tested in Tasks 1 and 22.

**Completeness scan:** Every test body and object shape is explicit, every helper is defined before use, and no deferred or incomplete implementation instruction remains.

**Interface consistency:** Shared contract block locks `proposedFilename`, `requestedFilename`, `destinationDirectory`, `providerKey`, `attemptToken`, `pget-result` fields, job states, sink cmds, `GLOBAL_EXPORT_MAP` names, and ephemeral terminal cleanup. Scheduler methods used across tasks: `createJob`, `enqueue`, `setMaxConcurrent`, `onTransportResult`, `onCapabilitySwitch`, `onQuiesced`, `notePermitAcquired`, `releasePermit`, `acquireProviderPermit`, `cancel`, `requestFirefoxHandoff`, `getJob`, `getSnapshot`, `tick`.

**maxConcurrent integrity:** Every multi-job scheduler scenario derives `globalRunning` expectations from `maxConcurrent`. The three-job same-provider wake test uses `maxConcurrent: 3`. The two-job pausing_provider test uses `maxConcurrent: 2` and asserts immediate slot retention then single release.

**Sequential executability:** No task imports a file created only in a later task. Privacy precedes background. Message router is created in Task 20 (first use). Firefox handoff API exists from Task 11 before integration routes through it.

**Commands:** `node --test`, `python -m pytest`, `python -m py_compile`, `Compress-Archive`, PowerShell `-replace` version stamps — verified against this repo (Node 24, `python -m pytest`, no package.json).
