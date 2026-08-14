# Save As, Size Metadata, and Popup Geometry Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Save As survive native-folder-picker focus changes, publish exact or visibly estimated media sizes without duplicate rows, and keep Firefox's maximum-size popup rail inside the actual viewport.

**Architecture:** A persistent extension Save As window resolves an opaque media selection through the background and submits the existing immutable intent. A pure media-size module validates exact HTTP totals and bitrate estimates, while a session-only background overlay attaches those safe scalars to the already-owned opaque media row. A small popup-layout module requests 800 × 600 rail mode before first paint and chooses two-column or stacked presentation from the actual content viewport.

**Tech Stack:** Firefox WebExtensions Manifest V2, plain JavaScript/UMD modules, Node.js `node:test`, rendered Firefox headless geometry checks using Node built-ins, Python 3/pytest, and the existing ctypes Win32 native host.

## Global Constraints

- Work only in `C:\Code\mCatcher` and its contained `.worktrees`; do not read, write, or create anything under `C:\Code\GrokOrchestration`.
- Implement against `docs/superpowers/specs/2026-08-13-save-as-size-popup-repair-design.md` and preserve its approved field names: `sizeBytes` and `sizeConfidence`.
- Keep the release version at `1.10.0`; this repair does not introduce a version bump.
- Add no npm, Python, browser, or runtime dependency.
- The Save As window URL contains only `tabId`, `mediaId`, and optional `variantId`.
- Never expose or persist media URLs, signed queries, request headers, cookies, authorization values, source handles, or raw native errors.
- Exact size wins over estimated size. A `206 Content-Length` is never a total without a valid `Content-Range` total.
- Estimated size text is visibly prefixed `Est.`; unsupported size is visibly `Size unknown`.
- Rail mode requests exactly 800 × 600 CSS pixels on `<body>` before first paint. A clamped viewport stacks the panes without hiding Downloads or creating horizontal overflow.
- Non-opaque legacy media must not be serialized into the Save As window URL. Preserve its current behavior; do not promote legacy YouTube/media ownership in this repair.
- Begin every production task with an observed failing behavior test and end it with focused green plus a dedicated commit.

---

## File Structure

### New focused units

- `media-catcher/lib/media-size.js` — pure exact-size parsing, bitrate estimation, precedence, validation, and display-label policy.
- `media-catcher/tests/media-size.test.js` — pure media-size contract.
- `media-catcher/saveas/saveas.html` — persistent extension Save As document.
- `media-catcher/saveas/saveas.js` — location parsing, context loading, folder-picker lifecycle, validation, and confirm/cancel orchestration.
- `media-catcher/saveas/saveas.css` — bounded Save As window styles.
- `media-catcher/tests/save-as-window.test.js` — persistent-form state and safe-message behavior.
- `media-catcher-host/test_folder_picker.py` — native picker owner/default/result contract.
- `media-catcher/lib/popup-layout.js` — pure 800 × 600 request and actual-viewport reconciliation policy.
- `media-catcher/tests/popup-layout.test.js` — pure popup-layout contract.
- `media-catcher/tests/popup-layout-firefox.test.js` — rendered Firefox DOM/CSS containment regression.

### Existing integration points

- `media-catcher/manifest.json` — load the media-size module before `background.js`.
- `media-catcher/background.js` — direct ownership lookup, safe metadata overlay, persistent Save As authorization/window tracking, and correlated picker responses.
- `media-catcher/popup/popup.html` — load the popup-layout module before `popup.js`.
- `media-catcher/popup/popup.js` — size rendering, persistent Save As launch, and layout application.
- `media-catcher/popup/popup.css` — maximum rail and stacked fallback geometry.
- `media-catcher/lib/popup-download-ui.js` — no behavior change expected; the Save As page reuses its existing filename validation and intent construction.
- `media-catcher-host/mchost/downloads.py` — foreground-owned Win32 picker and structured result.
- `media-catcher-host/mc_host.py` — document the structured picker wire shape; dispatch remains `pickFolder`.
- `media-catcher/tests/background-live-detection.test.js` — producer-race and late-size enrichment behavior.
- `media-catcher/tests/background-live-integration.test.js` — real-controller one-row/public-privacy regression.
- `media-catcher/tests/background-live-actions.test.js` — Save As sender/window/action authorization and picker result handling.
- `media-catcher/tests/popup-intent.test.js` — rendered size text, launch message, and compatibility assertions.

---

## Preflight: Establish a Clean Baseline

- [ ] **Step 1: Verify the contained worktree and design commit**

Run from `C:\Code\mCatcher\.worktrees\background-adapter-observable-recovery`:

```powershell
git status --short
git log -2 --oneline
git merge-base --is-ancestor 4e99b2c6218aee005a019ae3d7119149ef060500 HEAD
```

Expected: empty status; the design commit is an ancestor of `HEAD`; no path outside the contained worktree is involved.

- [ ] **Step 2: Run the JavaScript baseline**

```powershell
node --test media-catcher/tests/*.test.js
```

Expected: exit 0 with every discovered JavaScript test passing.

- [ ] **Step 3: Run the native-host baseline without repository caches**

```powershell
$env:PYTHONDONTWRITEBYTECODE = "1"
python -B -m pytest -p no:cacheprovider media-catcher-host -q
```

Expected: exit 0 with every native-host test passing and no new `__pycache__` or `.pytest_cache` path.

---

### Task 1: Pure Size Validation, Estimation, and Labels

**Files:**
- Create: `media-catcher/lib/media-size.js`
- Create: `media-catcher/tests/media-size.test.js`
- Modify: `media-catcher/manifest.json`

**Interfaces:**
- Consumes: normalized HTTP evidence `{statusCode, responseHeaders}`, or safe media scalars `{durationSeconds, selectedBandwidth, bandwidth, sampledKbps}`.
- Produces:

```js
McMediaSize.exactSizeFromHttp(input) -> null | {
  sizeBytes: number,
  sizeConfidence: "exact"
}

McMediaSize.estimatedSizeFromBitrate(input) -> null | {
  sizeBytes: number,
  sizeConfidence: "estimated"
}

McMediaSize.chooseSize(current, candidate) -> null | frozen size metadata
McMediaSize.sizeLabel(metadata, humanSize) -> string
```

- [ ] **Step 1: Write the exact-size RED tests**

Add these cases to `media-size.test.js` using the existing `tests/harness/load-lib.js` loader:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");
const Size = loadLib("lib/media-size.js");

test("Content-Range total is exact and outranks partial Content-Length", () => {
  assert.deepEqual(Size.exactSizeFromHttp({
    statusCode: 206,
    responseHeaders: [
      { name: "Content-Range", value: "bytes 0-262143/1395864371" },
      { name: "Content-Length", value: "262144" },
    ],
  }), { sizeBytes: 1395864371, sizeConfidence: "exact" });
});

test("full 200 Content-Length is exact but 206 Content-Length alone is not", () => {
  assert.deepEqual(Size.exactSizeFromHttp({
    statusCode: 200,
    responseHeaders: [{ name: "Content-Length", value: "1395864371" }],
  }), { sizeBytes: 1395864371, sizeConfidence: "exact" });
  assert.equal(Size.exactSizeFromHttp({
    statusCode: 206,
    responseHeaders: [{ name: "Content-Length", value: "262144" }],
  }), null);
});
```

Also assert that malformed ranges, `*` totals, zero, negative, fractional, whitespace-padded junk, overflow above `Number.MAX_SAFE_INTEGER`, accessors, and non-record inputs return `null` without invoking caller code.

- [ ] **Step 2: Write the estimate, precedence, and visible-label RED tests**

```js
test("bitrate times duration is always visibly estimated", () => {
  const estimate = Size.estimatedSizeFromBitrate({
    durationSeconds: 7200,
    selectedBandwidth: 1_500_000,
    bandwidth: 900_000,
    sampledKbps: 500,
  });
  assert.deepEqual(estimate, {
    sizeBytes: 1_350_000_000,
    sizeConfidence: "estimated",
  });
  assert.equal(Size.sizeLabel(estimate, () => "1.3 GB"), "Est. 1.3 GB");
  assert.equal(Size.sizeLabel(null, () => "unused"), "Size unknown");
});

test("exact replaces estimate and estimate never replaces exact", () => {
  const estimated = Object.freeze({ sizeBytes: 1000, sizeConfidence: "estimated" });
  const exact = Object.freeze({ sizeBytes: 900, sizeConfidence: "exact" });
  assert.deepEqual(Size.chooseSize(estimated, exact), exact);
  assert.deepEqual(Size.chooseSize(exact, estimated), exact);
});
```

Add invalid duration/bitrate cases and assert the bitrate source order is selected variant, media bandwidth, then sampled kbps.

- [ ] **Step 3: Run the focused test and observe RED**

```powershell
node --test media-catcher/tests/media-size.test.js
```

Expected: FAIL because `lib/media-size.js` does not exist.

- [ ] **Step 4: Implement the UMD module with descriptor-safe input reads**

Use this module shape and precedence, with no coercion through caller getters:

```js
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.McMediaSize = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function positiveSafeInteger(value) {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  function ownData(record, key) {
    try {
      if (!record || (typeof record !== "object" && typeof record !== "function")) return null;
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor || descriptor.get || descriptor.set || !("value" in descriptor)) return null;
      return { value: descriptor.value };
    } catch (_error) {
      return null;
    }
  }

  function readHeader(headers, wantedName) {
    if (!Array.isArray(headers)) return { ok: false, value: "" };
    const lengthState = ownData(headers, "length");
    const length = lengthState && Number.isSafeInteger(lengthState.value) ? lengthState.value : -1;
    if (length < 0 || length > 128) return { ok: false, value: "" };
    let found = null;
    for (let index = 0; index < length; index += 1) {
      const entryState = ownData(headers, String(index));
      const nameState = entryState && ownData(entryState.value, "name");
      const valueState = entryState && ownData(entryState.value, "value");
      if (!nameState || !valueState || typeof nameState.value !== "string" ||
          typeof valueState.value !== "string") return { ok: false, value: "" };
      if (nameState.value.toLowerCase() === wantedName) {
        if (found !== null && found !== valueState.value) return { ok: false, value: "" };
        found = valueState.value;
      }
    }
    return { ok: true, value: found || "" };
  }

  function exactSizeFromHttp(input) {
    const statusState = ownData(input, "statusCode");
    const headersState = ownData(input, "responseHeaders");
    if (!statusState || !headersState || !Number.isInteger(statusState.value)) return null;
    const rangeState = readHeader(headersState.value, "content-range");
    const lengthState = readHeader(headersState.value, "content-length");
    if (!rangeState.ok || !lengthState.ok) return null;
    const rawRange = rangeState.value.trim();
    const match = /^bytes\s+(?:(\d+)-(\d+)|\*)\/(\d+)$/i.exec(rawRange);
    if (rawRange && !match) return null;
    let bytes = null;
    if (match) {
      const total = positiveSafeInteger(Number(match[3]));
      if (!total) return null;
      const start = match[1] == null ? null : Number(match[1]);
      const end = match[2] == null ? null : Number(match[2]);
      const validRange = start == null || (Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
        start >= 0 && start <= end && total && end < total);
      if (!validRange) return null;
      bytes = total;
    }
    if (!bytes && statusState.value === 200) {
      const rawLength = lengthState.value.trim();
      bytes = /^\d+$/.test(rawLength) ? positiveSafeInteger(Number(rawLength)) : null;
    }
    return bytes ? Object.freeze({ sizeBytes: bytes, sizeConfidence: "exact" }) : null;
  }

  function estimatedSizeFromBitrate(input) {
    const durationState = ownData(input, "durationSeconds");
    if (!durationState || !Number.isFinite(durationState.value) || durationState.value <= 0) return null;
    let bitrate = null;
    for (const key of ["selectedBandwidth", "bandwidth"]) {
      const state = ownData(input, key);
      if (state && Number.isFinite(state.value) && state.value > 0) { bitrate = state.value; break; }
    }
    if (bitrate == null) {
      const sampledState = ownData(input, "sampledKbps");
      if (sampledState && Number.isFinite(sampledState.value) && sampledState.value > 0) {
        bitrate = sampledState.value * 1000;
      }
    }
    const bytes = positiveSafeInteger(Math.round((bitrate * durationState.value) / 8));
    return bytes ? Object.freeze({ sizeBytes: bytes, sizeConfidence: "estimated" }) : null;
  }

  function chooseSize(current, candidate) {
    function validated(value) {
      const bytesState = ownData(value, "sizeBytes");
      const confidenceState = ownData(value, "sizeConfidence");
      const bytes = bytesState && positiveSafeInteger(bytesState.value);
      const confidence = confidenceState && confidenceState.value;
      return bytes && (confidence === "exact" || confidence === "estimated")
        ? { sizeBytes: bytes, sizeConfidence: confidence }
        : null;
    }
    const before = validated(current);
    const after = validated(candidate);
    const winner = !before ? after : !after ? before
      : before.sizeConfidence === "exact" && after.sizeConfidence !== "exact" ? before
      : after;
    return winner
      ? Object.freeze({ sizeBytes: winner.sizeBytes, sizeConfidence: winner.sizeConfidence })
      : null;
  }

  function sizeLabel(metadata, humanSize) {
    const safe = chooseSize(null, metadata);
    if (!safe || typeof humanSize !== "function") return "Size unknown";
    const value = humanSize(safe.sizeBytes);
    return safe.sizeConfidence === "estimated" ? "Est. " + value : value;
  }

  return Object.freeze({ exactSizeFromHttp, estimatedSizeFromBitrate, chooseSize, sizeLabel });
});
```

The implementation must reject accessor descriptors rather than reading them, copy only `{name,value}` data-header pairs, compare header names case-insensitively, and return fresh frozen records.

- [ ] **Step 5: Load the module before `background.js` and assert ordering**

Insert `lib/media-size.js` in `manifest.json` immediately before `lib/background-adapters.js` or later, but always before `background.js`. Add a manifest assertion to `media-size.test.js`:

```js
const manifest = require("../manifest.json");
const scripts = manifest.background.scripts;
assert.ok(scripts.indexOf("lib/media-size.js") >= 0);
assert.ok(scripts.indexOf("lib/media-size.js") < scripts.indexOf("background.js"));
```

- [ ] **Step 6: Run focused GREEN and syntax checks**

```powershell
node --test media-catcher/tests/media-size.test.js
node --check media-catcher/lib/media-size.js
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit the pure size policy**

```powershell
git add media-catcher/lib/media-size.js media-catcher/tests/media-size.test.js media-catcher/manifest.json
git commit -m "feat: define safe media size metadata"
```

---

### Task 2: Attach Size Metadata to the Existing Opaque Row

**Files:**
- Modify: `media-catcher/background.js`
- Modify: `media-catcher/popup/popup.html`
- Modify: `media-catcher/tests/background-live-detection.test.js`
- Modify: `media-catcher/tests/background-live-integration.test.js`
- Modify: `media-catcher/tests/popup-intent.test.js`

**Interfaces:**
- Consumes: `McMediaSize` from Task 1, existing direct `mediaId` ownership, direct probe/header evidence, and safe duration/bandwidth scalars.
- Produces:

```js
rememberLiveSize(mediaId, candidate, tabId) -> boolean
getLiveDirectOwner(tabId, mediaUrl) -> null | mediaId
decorateLiveRow(row, tabId) -> safe row with optional sizeBytes/sizeConfidence
```

The private stores are session-only:

```js
liveDirectMediaOwners: Map<tabId, Map<canonicalSourceKey, mediaId>>
liveSizeMetadata: Map<mediaId, frozen {sizeBytes, sizeConfidence}>
```

- [ ] **Step 1: Extend the detection harness and write the producer-race RED**

In `background-live-detection.test.js`, make the fake controller's captured media ID produce one safe `popupMedia(tabId)` row. Then add a test with this chronology:

```js
test("DOM-first direct media receives late exact network size without a second row", async () => {
  const h = createHarness();
  await settle();
  const mediaUrl = "https://cdn.example/movie.mp4?token=SIGNED_SENTINEL";
  const sender = { tab: { id: 7, url: "https://site.example/watch" }, frameId: 0 };

  await h.send({
    type: "content-media",
    item: { kind: "direct", url: mediaUrl, ts: 1 },
    snapshot: pageSnapshot(),
  }, sender);

  h.headersReceived.emit({
    tabId: 7,
    frameId: 0,
    documentId: "doc-7",
    documentUrl: "https://site.example/watch",
    originUrl: "https://site.example/watch",
    url: mediaUrl,
    statusCode: 206,
    responseHeaders: [
      { name: "Content-Type", value: "video/mp4" },
      { name: "Content-Range", value: "bytes 0-262143/1395864371" },
      { name: "Content-Length", value: "262144" },
    ],
  });
  await eventually(() => h.broadcasts.some((m) => m.type === "media-updated"), "size update");

  const response = await h.send({ type: "get-media", tabId: 7 });
  const direct = response.items.filter((row) => row.kind === "direct");
  assert.equal(direct.length, 1);
  assert.equal(direct[0].sizeBytes, 1395864371);
  assert.equal(direct[0].sizeConfidence, "exact");
  assert.equal(JSON.stringify(response).includes("SIGNED_SENTINEL"), false);
  assert.equal(h.captureNetwork.length, 0);
  assert.equal(h.captureDomMedia.length, 1);
});
```

Add the mirror chronology: network-first then DOM remains one row. Add clear/navigation followed by URL reuse and assert no stale size inheritance.

- [ ] **Step 2: Write exact parser and estimate integration RED cases**

Add focused cases proving:

- `probeDirect()` does not use a 206 chunk `Content-Length` as total;
- a valid probe `Content-Range` total is stored before initial network publication;
- a finalized HLS/DASH item with duration plus selected/media/sampled bitrate receives `estimated` size when exact size is absent;
- exact late evidence replaces an estimate and a later estimate cannot downgrade it;
- `isTooSmall()` continues using exact legacy transfer evidence only and never drops an item because of an estimate.

- [ ] **Step 3: Write the real-controller privacy RED**

In `background-live-integration.test.js`, run the real manifest-loaded controller through the DOM-first/late-network sequence. Assert one opaque ID, fresh popup projections, frozen safe rows, exact size fields, and absence of URL/header/cookie sentinels from `get-media` and `live-jobs-updated` JSON.

- [ ] **Step 4: Run the focused tests and observe RED**

```powershell
node --test media-catcher/tests/background-live-detection.test.js media-catcher/tests/background-live-integration.test.js
```

Expected: FAIL because direct ownership records no media ID and safe rows omit size metadata.

- [ ] **Step 5: Add direct owner resolution and safe metadata overlay**

Keep the existing direct grouping policy, but record the exact source owner:

```js
const liveDirectMediaOwners = new Map();
const liveSizeMetadata = new Map();

function getLiveDirectOwner(tabId, url) {
  const bySource = liveDirectMediaOwners.get(tabId);
  return bySource ? bySource.get(directSourceKey(url)) || null : null;
}

function rememberLiveSize(mediaId, candidate, tabId) {
  const next = self.McMediaSize.chooseSize(liveSizeMetadata.get(mediaId) || null, candidate);
  const current = liveSizeMetadata.get(mediaId) || null;
  if (!next || (current && current.sizeBytes === next.sizeBytes &&
      current.sizeConfidence === next.sizeConfidence)) return false;
  liveSizeMetadata.set(mediaId, next);
  broadcast({ type: "media-updated", tabId });
  return true;
}
```

Update `claimLiveMediaKey()` to map every exact direct source to `mediaId`. Replace `hasLiveDirectSource()` call sites with owner lookup where late enrichment is possible. Before `addMedia()` returns for an owned source, parse exact header evidence and call `rememberLiveSize()`; do not call `captureNetwork()`.

On initial network promotion, remember trusted probe/header metadata immediately after `captureNetwork()` returns. On initial DOM capture, remember only already-validated safe scalars. Clear both stores during tab clear, tab removal, navigation ownership cleanup, and terminal ownership cleanup.

- [ ] **Step 6: Fix `probeDirect()` and add estimates**

Return the pure metadata record rather than an unqualified numeric size:

```js
const sizeMetadata = self.McMediaSize.exactSizeFromHttp({
  statusCode: resp.status,
  responseHeaders: [
    { name: "Content-Range", value: resp.headers.get("content-range") || "" },
    { name: "Content-Length", value: resp.headers.get("content-length") || "" },
  ],
});
return { status: resp.status, ok, contentType: ct, sizeMetadata, head };
```

At HLS/DASH/direct finalization, call `estimatedSizeFromBitrate()` only when no exact metadata exists. Use the selected variant's declared bandwidth when a selection is known, then media bandwidth, then `estKbps`. Do not scrape visible page text.

- [ ] **Step 7: Merge only the safe pair into public rows**

In `decorateLiveRow()`:

```js
const size = liveSizeMetadata.get(row.id);
if (size) {
  out.sizeBytes = size.sizeBytes;
  out.sizeConfidence = size.sizeConfidence;
}
```

Do not spread the metadata record or copy any raw evidence. Update `popup.js` to call `McMediaSize.sizeLabel()` through a small `mediaSizeLabel(item)` helper and always include one of exact, `Est.`, or `Size unknown` in the media metadata line.

Load `../lib/media-size.js` in `popup.html` before `popup.js` so the popup uses the same formatter policy.

- [ ] **Step 8: Add visible exact/estimated/unknown UI assertions**

In `popup-intent.test.js`, render three opaque direct rows and assert visible text contains respectively:

```js
assert.match(exactCard.textContent, /1\.3 GB/);
assert.doesNotMatch(exactCard.textContent, /Est\./);
assert.match(estimatedCard.textContent, /Est\. 1\.3 GB/);
assert.match(unknownCard.textContent, /Size unknown/);
```

Also assert no `item.size` fallback can relabel an unvalidated opaque row as exact.

- [ ] **Step 9: Run focused GREEN and syntax checks**

```powershell
node --test media-catcher/tests/media-size.test.js media-catcher/tests/background-live-detection.test.js media-catcher/tests/background-live-integration.test.js media-catcher/tests/popup-intent.test.js
node --check media-catcher/background.js
node --check media-catcher/popup/popup.js
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 10: Commit duplicate-safe size publication**

```powershell
git add media-catcher/background.js media-catcher/popup/popup.html media-catcher/popup/popup.js media-catcher/tests/background-live-detection.test.js media-catcher/tests/background-live-integration.test.js media-catcher/tests/popup-intent.test.js
git commit -m "fix: publish media size without duplicate rows"
```

---

### Task 3: Move Managed Save As into a Persistent Extension Window

**Files:**
- Create: `media-catcher/saveas/saveas.html`
- Create: `media-catcher/saveas/saveas.js`
- Create: `media-catcher/saveas/saveas.css`
- Create: `media-catcher/tests/save-as-window.test.js`
- Modify: `media-catcher/background.js`
- Modify: `media-catcher/popup/popup.js`
- Modify: `media-catcher/tests/background-live-actions.test.js`
- Modify: `media-catcher/tests/popup-intent.test.js`

**Interfaces:**
- Consumes: safe `liveController.popupMedia(tabId)` rows, `McPopupDownloadUi` validation/intent functions, Task 2 size labels, and existing `controller.enqueueDownload()`.
- Produces:

```js
// toolbar popup -> background
{ type: "open-save-as", tabId, mediaId, variantId: null | string }

// Save As page -> background; identity is derived from sender.url
{ type: "get-save-as-context" }

// background -> page
{
  ok: true,
  context: {
    tabId, mediaId, variantId,
    proposedFilename, knownExtension, kind,
    sizeBytes?, sizeConfidence?
  },
  helper
}

// Save As page -> existing download policy
{
  type: "save-as-download",
  tabId,
  item: { id: mediaId },
  variantId,
  intent
}
```

The created window URL is exactly `saveas/saveas.html?tabId=<int>&mediaId=<encoded opaque id>[&variantId=<encoded opaque id>]`.

- [ ] **Step 1: Write popup launch RED tests**

Replace the current source-regex picker test with behavior assertions:

```js
test("managed Save As asks background to open a persistent opaque window", async () => {
  const sent = [];
  // Render an item with id/mediaId and click Save As.
  assert.deepEqual(sent.at(-1), {
    type: "open-save-as",
    tabId: 7,
    mediaId: "media:opaque:1",
    variantId: null,
  });
  assert.equal(JSON.stringify(sent).includes("SIGNED_URL_SENTINEL"), false);
});
```

Add variant-ID, malformed-ID, and non-opaque legacy cases. Managed rows send only IDs; non-opaque rows never serialize a URL into `open-save-as` and retain their existing legacy path.

- [ ] **Step 2: Write background authorization/window RED tests**

Extend the `background-live-actions.test.js` browser fake with `windows.create`, `windows.update`, and `windows.onRemoved`. Assert:

1. An exact toolbar-popup sender can open one window for a known tab/media/variant.
2. A second click focuses the existing window rather than creating another.
3. The URL query contains only the three approved keys.
4. Unknown media, wrong tab, wrong variant, hostile descriptors, a normal web page, options page, and forged extension URL create no window.
5. `get-save-as-context` derives IDs from the exact Save As sender URL; caller-supplied mismatches are ignored/rejected.
6. The safe context contains no URL, source handle, headers, cookie, or provider registry identity.
7. A matching Save As sender may enqueue `save-as-download`; a mismatched sender reaches zero controller calls.

- [ ] **Step 3: Write the persistent-form lifecycle RED**

`save-as-window.test.js` loads the real `saveas.js` with fake `send`, `close`, and view effects. Use a deferred picker promise:

```js
test("folder response survives toolbar popup destruction and retains draft", async () => {
  const picker = deferred();
  const sent = [];
  const controller = SaveAs.createController({
    send(message) {
      sent.push(structuredClone(message));
      if (message.type === "get-save-as-context") return Promise.resolve(safeContext());
      if (message.type === "pick-folder") return picker.promise;
      if (message.type === "save-as-download") return Promise.resolve({ ok: true, job: { id: "job:1" } });
      throw new Error("unexpected message");
    },
    close() {},
  });
  await controller.load();
  controller.editFilename("edited.mp4");
  const pending = controller.chooseFolder();
  picker.resolve({ ok: true, status: "selected", dir: "D:\\Videos" });
  await pending;
  assert.equal(controller.snapshot().filename, "edited.mp4");
  assert.equal(controller.snapshot().destinationDirectory, "D:\\Videos");
  await controller.confirm();
  assert.equal(sent.at(-1).intent.destinationDirectory, "D:\\Videos");
});
```

Add selected, cancelled, error, timeout, enqueue failure, double-submit, close/cancel, stale context, and invalid filename cases. Cancellation/error retains the draft; only successful enqueue calls `close()`.

- [ ] **Step 4: Run focused tests and observe RED**

```powershell
node --test media-catcher/tests/popup-intent.test.js media-catcher/tests/background-live-actions.test.js media-catcher/tests/save-as-window.test.js
```

Expected: FAIL because `open-save-as`, the persistent files, and sender authorization do not exist.

- [ ] **Step 5: Implement background window ownership and sender parsing**

Add bounded helpers:

```js
function parseSaveAsSender(sender) {
  if (!sender || sender.id !== api.runtime.id || typeof sender.url !== "string") return null;
  const parsed = new URL(sender.url);
  if (parsed.origin !== new URL(api.runtime.getURL("/")).origin ||
      parsed.pathname !== new URL(api.runtime.getURL("saveas/saveas.html")).pathname) return null;
  // Require exactly tabId, mediaId, and optional variantId; validate opaque IDs.
}

function safeSaveAsContext(tabId, mediaId, variantId) {
  const row = liveRowsForTab(tabId).find((candidate) => candidate.id === mediaId);
  // Return a fresh allowlist projection and exact owned variant only.
}
```

Track one `windows.create({type:"popup"})` result per canonical media/variant key. Focus it with `windows.update(id,{focused:true})` on repeat and remove tracking in `windows.onRemoved`.

Rename the injected controller predicate to `isExtensionActionSender()` while continuing to pass it under the controller's existing `isPopupSender` dependency key. It accepts only the exact toolbar popup and the exact validated Save As page. For a Save As download, require the sender-derived IDs to equal message IDs before invoking the controller.

Route both `msg.type === "download"` and `msg.type === "save-as-download"` through the existing managed-media action branch. `save-as-download` is accepted only from a matching Save As sender; the toolbar popup continues using its existing message builder.

- [ ] **Step 6: Implement the persistent page**

`saveas.html` loads, in order:

```html
<script src="../lib/filename-ranker.js"></script>
<script src="../lib/download-intent.js"></script>
<script src="../lib/popup-download-ui.js"></script>
<script src="../lib/media-size.js"></script>
<script src="saveas.js"></script>
```

`saveas.js` exports for Node and installs the browser page controller. Its controller state is a closed record containing only context IDs, safe display metadata, edited filename, destination, pending picker generation, and visible status. `chooseFolder()` disables repeat submission and accepts only:

```js
{ ok: true, status: "selected", dir: nonEmptyString }
{ ok: true, status: "cancelled" }
{ ok: false, error: "folder_picker_failed" | "folder_picker_timeout" }
```

`confirm()` uses `McPopupDownloadUi.decideSaveAsForm()`, sends `save-as-download`, and closes only on `{ok:true, job}`. `cancel()` closes without a download message.

- [ ] **Step 7: Replace the managed inline form launch**

For `item.id` rows, `appendSaveAs()` calls:

```js
send({
  type: "open-save-as",
  tabId: Number.isInteger(item.tabId) ? item.tabId : currentTabId,
  mediaId: item.id,
  variantId: selection && typeof selection.variantId === "string" ? selection.variantId : null,
});
```

Do not include `variantUrl`. Preserve the existing inline form only for non-opaque legacy items; this task does not create a public legacy ID or expose a URL in the new window.

- [ ] **Step 8: Run focused GREEN and syntax checks**

```powershell
node --test media-catcher/tests/popup-intent.test.js media-catcher/tests/background-live-actions.test.js media-catcher/tests/save-as-window.test.js
node --check media-catcher/saveas/saveas.js
node --check media-catcher/background.js
node --check media-catcher/popup/popup.js
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 9: Commit the persistent Save As surface**

```powershell
git add media-catcher/saveas media-catcher/background.js media-catcher/popup/popup.js media-catcher/tests/save-as-window.test.js media-catcher/tests/background-live-actions.test.js media-catcher/tests/popup-intent.test.js
git commit -m "fix: move Save As into a persistent window"
```

---

### Task 4: Foreground Native Folder Picker with Distinct Outcomes

**Files:**
- Create: `media-catcher-host/test_folder_picker.py`
- Modify: `media-catcher-host/mchost/downloads.py`
- Modify: `media-catcher-host/mc_host.py`
- Modify: `media-catcher/background.js`
- Modify: `media-catcher/tests/background-live-actions.test.js`

**Interfaces:**
- Consumes:

```js
{ cmd: "pickFolder", requestId, dir }
```

- Produces exactly one terminal frame:

```js
{ type: "folder", requestId, status: "selected", directory }
{ type: "folder", requestId, status: "cancelled" }
{ type: "folder", requestId, status: "error", code: "picker_unavailable" | "invalid_selection" }
```

- The background accepts legacy `reqId`/`dir` frames only for compatibility and converts them to the new extension response states.

- [ ] **Step 1: Write native RED tests for owner, initial directory, and result distinction**

Create `test_folder_picker.py` with a fake Win32 adapter:

```python
def test_picker_uses_foreground_owner_and_initial_directory(monkeypatch):
    calls = []

    class FakeApi:
        def foreground_window(self):
            return 444
        def browse(self, owner, initial_dir):
            calls.append((owner, initial_dir))
            return r"D:\Videos"

    result = downloads._ask_folder(r"C:\Start", api=FakeApi())
    assert calls == [(444, r"C:\Start")]
    assert result == {"status": "selected", "directory": r"D:\Videos"}
```

Add normal null-return cancellation, raised API exception, zero foreground owner, path-resolution failure, invalid/non-directory selection, and exact `requestId` echo cases. Mock `_h().send` and join the picker worker with the existing bounded `wait_for` helper; never sleep blindly.

- [ ] **Step 2: Write background RED tests for every terminal state**

In `background-live-actions.test.js`, issue one picker request, capture its `requestId`, and emit selected, cancelled, error, malformed, duplicate, unknown, and post-disconnect frames. Assert the response shapes match the design, each request settles once, and pending state is removed on every terminal path.

Add a fake timer case that advances the picker timeout and expects:

```js
{ ok: false, error: "folder_picker_timeout" }
```

A late native selection after timeout must be inert.

- [ ] **Step 3: Run focused tests and observe RED**

```powershell
$env:PYTHONDONTWRITEBYTECODE = "1"
python -B -m pytest -p no:cacheprovider media-catcher-host/test_folder_picker.py -q
node --test media-catcher/tests/background-live-actions.test.js media-catcher/tests/save-as-window.test.js
```

Expected: FAIL because the picker returns an empty string for both cancellation and failure and the background has no status/timeout state machine.

- [ ] **Step 4: Introduce a testable Win32 adapter and structured `_ask_folder()`**

Use a narrow adapter instead of letting policy depend directly on `ctypes.windll`:

```python
class _WinFolderApi:
    def foreground_window(self):
        return ctypes.windll.user32.GetForegroundWindow()

def _ask_folder(default_dir, api=None):
    api = api or _WinFolderApi()
    owner = api.foreground_window()
    if not owner:
        return {"status": "error", "code": "picker_unavailable"}
    try:
        selected = api.browse(owner, default_dir)
    except Exception:
        return {"status": "error", "code": "picker_unavailable"}
    if selected is None:
        return {"status": "cancelled"}
    if not isinstance(selected, str) or not selected or not os.path.isdir(selected):
        return {"status": "error", "code": "invalid_selection"}
    return {"status": "selected", "directory": selected}
```

Move the existing `BROWSEINFO` ctypes work into `_WinFolderApi.browse(owner, initial_dir)`. Set `BROWSEINFO.hwndOwner = owner`. Install a `BFFM_INITIALIZED` callback that sends `BFFM_SETSELECTIONW` with the exact `initial_dir` and calls `SetForegroundWindow(dialog_hwnd)`. Preserve `BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE`, and return `None` only when `SHBrowseForFolderW` returns a null PIDL. Keep the callback and path buffers alive until `SHBrowseForFolderW` returns, require `SHGetPathFromIDListW` success, call `CoTaskMemFree()` for every non-null PIDL, and pair successful `CoInitialize` with `CoUninitialize`. Do not log `default_dir` or the selected path.

- [ ] **Step 5: Emit structured host frames and correlate in background**

`handle_pick_folder()` copies the `requestId`, starts one worker, calls `_ask_folder()`, and allowlist-copies `status`, `directory`, or `code` into one frame.

Replace `pendingFolderPicks: Map<id, sendResponse>` with records containing `{respond, timer}`. Add `finishFolderPick(requestId, nativeFrame)` that deletes/clears before responding. Map native states to:

```js
selected  -> { ok: true, status: "selected", dir: directory }
cancelled -> { ok: true, status: "cancelled" }
error     -> { ok: false, error: "folder_picker_failed" }
timeout   -> { ok: false, error: "folder_picker_timeout" }
```

Native disconnect settles every pending picker as `{ok:false,error:"folder_picker_failed"}`. Legacy nonempty `dir` means selected; legacy empty `dir` means cancelled.

- [ ] **Step 6: Run focused GREEN and syntax checks**

```powershell
$env:PYTHONDONTWRITEBYTECODE = "1"
python -B -m pytest -p no:cacheprovider media-catcher-host/test_folder_picker.py media-catcher-host/test_host.py -q
node --test media-catcher/tests/background-live-actions.test.js media-catcher/tests/save-as-window.test.js
python -B -c "compile(open(r'media-catcher-host/mchost/downloads.py', encoding='utf-8').read(), r'media-catcher-host/mchost/downloads.py', 'exec')"
node --check media-catcher/background.js
git diff --check
```

Expected: all commands exit 0 and no repository cache appears.

- [ ] **Step 7: Commit the native picker repair**

```powershell
git add media-catcher-host/test_folder_picker.py media-catcher-host/mchost/downloads.py media-catcher-host/mc_host.py media-catcher/background.js media-catcher/tests/background-live-actions.test.js
git commit -m "fix: foreground and observe folder selection"
```

---

### Task 5: Request 800 × 600 and Contain the Actual Firefox Viewport

**Files:**
- Create: `media-catcher/lib/popup-layout.js`
- Create: `media-catcher/tests/popup-layout.test.js`
- Create: `media-catcher/tests/popup-layout-firefox.test.js`
- Modify: `media-catcher/popup/popup.html`
- Modify: `media-catcher/popup/popup.js`
- Modify: `media-catcher/popup/popup.css`
- Modify: `media-catcher/tests/popup-intent.test.js`

**Interfaces:**
- Consumes: `{wantRail, viewportWidth, viewportHeight}` and actual DOM geometry.
- Produces:

```js
McPopupLayout.requested(wantRail) -> {
  rail: boolean,
  width: 800 | null,
  height: 600 | null
}

McPopupLayout.reconcile({wantRail, viewportWidth, viewportHeight}) -> {
  rail: boolean,
  stacked: boolean,
  width: number | null,
  height: number | null
}

McPopupLayout.geometryContained(viewportWidth, rects, scrollWidth) -> boolean
```

`stacked:true` keeps the Downloads pane visible below the media pane; it never hides the rail.

- [ ] **Step 1: Write pure layout RED tests**

```js
test("rail requests Firefox maximum and reconciles to actual viewport", () => {
  assert.deepEqual(Layout.requested(true), { rail: true, width: 800, height: 600 });
  assert.deepEqual(Layout.reconcile({ wantRail: true, viewportWidth: 800, viewportHeight: 600 }), {
    rail: true, stacked: false, width: 800, height: 600,
  });
  assert.deepEqual(Layout.reconcile({ wantRail: true, viewportWidth: 560, viewportHeight: 600 }), {
    rail: true, stacked: true, width: 560, height: 600,
  });
});
```

Add zero, negative, NaN, over-800, over-600, and absent measurements. Invalid measurements fail closed to the requested maximum without creating a larger number.

- [ ] **Step 2: Add the rendered Firefox geometry RED**

`popup-layout-firefox.test.js` uses only Node built-ins:

1. Start a loopback HTTP server rooted at `media-catcher/`.
2. Serve the real `popup.html`, `popup.css`, and scripts.
3. Inject a bounded `browser` fake before production scripts. Return settings with rail/queue enabled, one opaque media row, and one completed download card.
4. Inject a final probe script that waits two animation frames and POSTs:

```js
{
  viewportWidth: visualViewport ? visualViewport.width : innerWidth,
  rootScrollWidth: document.documentElement.scrollWidth,
  bodyRight: document.body.getBoundingClientRect().right,
  paneRight: document.querySelector(".pane-right").getBoundingClientRect().right,
  queueClearRight: document.querySelector("#queue-clear").getBoundingClientRect().right,
  railVisible: getComputedStyle(document.querySelector(".pane-right")).display !== "none",
  stacked: document.documentElement.classList.contains("rail-stacked")
}
```

5. Launch `C:\Program Files\Firefox Developer Edition\firefox.exe` headlessly with a fresh OS-temp profile and `MOZ_HEADLESS_WIDTH`/`MOZ_HEADLESS_HEIGHT` set for 800 × 600, then 560 × 600.
6. Kill/wait the exact spawned process and delete the temp profile/server in `finally`.

At 800 assert rail visible, not stacked, and every right edge/scroll width is within the viewport. At 560 assert rail visible, stacked, and the same containment. Feed a fake outer browser window width of 2048 in both runs so the test proves actual popup viewport dominance.

- [ ] **Step 3: Run focused tests and observe RED**

```powershell
node --test media-catcher/tests/popup-layout.test.js media-catcher/tests/popup-layout-firefox.test.js media-catcher/tests/popup-intent.test.js
```

Expected: FAIL because the current code caps at 640, primes 560 on `<html>`, and has no stacked actual-viewport reconciliation.

- [ ] **Step 4: Implement the pure layout module and synchronous body prime**

`popup-layout.js` is UMD and defines `MAX_WIDTH=800`, `MAX_HEIGHT=600`, and a two-pane threshold chosen from the existing pane minimum plus gaps. It clamps valid measurements and sets `stacked` below that threshold.

Load it before `popup.js` in `popup.html`. Replace the cached 560-pixel `<html>` prime with synchronous rail priming on `<body>`:

```js
const requested = McPopupLayout.requested(cachedOrDefaultRail);
if (requested.rail) {
  document.documentElement.classList.add("rail");
  document.body.style.width = requested.width + "px";
  document.body.style.height = requested.height + "px";
}
```

Do not call `browser.windows.getCurrent()` for popup geometry.

- [ ] **Step 5: Reconcile from the actual viewport and contain fallback geometry**

After one animation frame, read the minimum positive value from `visualViewport.width` and `innerWidth`, and similarly for height. Apply the reconciled body dimensions and toggle `rail-stacked`. Observe `visualViewport.resize` and ordinary `resize` with one scheduled reconciliation per frame.

Update CSS:

```css
html.rail body {
  width: 800px;
  height: 600px;
  max-width: 100vw;
  max-height: 100vh;
  overflow-x: hidden;
}

html.rail .main,
html.rail .pane-left,
html.rail .pane-right,
html.rail .rail-scroll,
html.rail #queue,
html.rail .rail-card {
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
}

html.rail-stacked .main {
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

html.rail-stacked .pane-right {
  display: flex;
  border-left: 0;
  border-top: 1px solid var(--stroke);
}
```

Keep `#rail` as the only rail scroll target. Do not add an unqualified `.rail` rule and do not set root horizontal overflow to `auto`.

- [ ] **Step 6: Add post-layout containment fallback**

After the final frame, collect root/body/pane/queue rectangles and call `geometryContained()`. If the two-column layout still crosses the viewport, atomically add `rail-stacked`, remeasure once, and retain that contained mode. Never increase width after this point.

- [ ] **Step 7: Run focused GREEN and syntax checks**

```powershell
node --test media-catcher/tests/popup-layout.test.js media-catcher/tests/popup-layout-firefox.test.js media-catcher/tests/popup-intent.test.js
node --check media-catcher/lib/popup-layout.js
node --check media-catcher/popup/popup.js
git diff --check
```

Expected: all commands exit 0; rendered metrics fit at both viewport widths.

- [ ] **Step 8: Commit the Firefox popup geometry repair**

```powershell
git add media-catcher/lib/popup-layout.js media-catcher/tests/popup-layout.test.js media-catcher/tests/popup-layout-firefox.test.js media-catcher/popup/popup.html media-catcher/popup/popup.js media-catcher/popup/popup.css media-catcher/tests/popup-intent.test.js
git commit -m "fix: contain Firefox popup rail geometry"
```

---

### Task 6: Full Verification, Package, Install, and Acceptance

**Files:**
- No tracked source change expected.
- Generated artifacts remain under ignored `dist/` or OS temp and are not committed.

**Interfaces:**
- Consumes: the five committed task results.
- Produces: verified extension/native artifacts and an installed-Firefox acceptance record.

- [ ] **Step 1: Run all JavaScript tests and syntax checks**

```powershell
node --test media-catcher/tests/*.test.js
Get-ChildItem media-catcher -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
git diff --check
```

Expected: every command exits 0 and every JavaScript test passes.

- [ ] **Step 2: Run the complete native suite without repository caches**

```powershell
$env:PYTHONDONTWRITEBYTECODE = "1"
python -B -m pytest -p no:cacheprovider media-catcher-host -q
python -B -c "compile(open(r'media-catcher-host/mc_host.py', encoding='utf-8').read(), r'media-catcher-host/mc_host.py', 'exec')"
python -B -c "compile(open(r'media-catcher-host/mchost/downloads.py', encoding='utf-8').read(), r'media-catcher-host/mchost/downloads.py', 'exec')"
```

Expected: every test passes and `git status --short --ignored` contains no newly created repository cache.

- [ ] **Step 3: Verify scope and clean commit history**

```powershell
git status --short
git log --oneline 4e99b2c..HEAD
git diff --stat 4e99b2c..HEAD
git diff --check 4e99b2c..HEAD
```

Expected: clean worktree; one plan commit plus five implementation commits; only files named by this plan differ from the approved design base.

- [ ] **Step 4: Build the extension package and inspect required files**

Use an OS-temp staging directory so the archive has `manifest.json` at its root:

```powershell
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("mcatcher-ext-" + [guid]::NewGuid())
$zip = Join-Path (git rev-parse --show-toplevel) "dist\media_catcher-1.10.0.zip"
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item -Recurse -Force media-catcher\* $stage
if (Test-Path $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -Force
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($zip)
try {
  $entries = @($archive.Entries | ForEach-Object { $_.FullName.Replace("\\", "/") })
  foreach ($required in @("manifest.json", "saveas/saveas.html", "saveas/saveas.js", "saveas/saveas.css", "lib/media-size.js", "lib/popup-layout.js")) {
    if ($entries -notcontains $required) { throw "Missing package entry: $required" }
  }
} finally {
  $archive.Dispose()
}
Remove-Item -LiteralPath $stage -Recurse -Force
```

Expected: archive exists and contains every required extension file, and the archive handle and temporary staging directory are closed/removed.

- [ ] **Step 5: Build the native installer and inspect the staged source**

```powershell
powershell -ExecutionPolicy Bypass -File media-catcher-host\installer\build.ps1
if (-not (Test-Path media-catcher-host\installer\dist\MediaCatcherHostSetup.exe)) { throw "Host installer missing" }
```

Expected: exit 0 and installer present. Confirm its staged `mchost/downloads.py` hash matches the working-tree source through the existing packaging-layout tests.

- [ ] **Step 6: Install into Firefox Developer Edition**

1. Run the newly built native installer as the current user.
2. Stage/load the newly built extension package in the existing Firefox Developer Edition profile.
3. Restart Firefox Developer Edition so both extension and native registration are fresh.
4. Confirm extension version `1.10.0`, helper `ready`, and the running helper path points to the newly installed package rather than an old checkout.

- [ ] **Step 7: Perform Florenfile acceptance**

Open:

`https://florenfile.com/ro454kqdq36j/11474-makemebi.net.mp4.html`

Verify:

1. Exactly one `11474-makemebi.net.mp4` media row appears.
2. The row displays an exact size when valid transport total evidence exists; otherwise it displays `Est. <size>` when bitrate and duration exist; otherwise `Size unknown`.
3. **Save As…** opens a persistent extension window.
4. **Choose Folder** opens a folder dialog in front of Firefox at the prior/default directory.
5. Selecting a folder returns to the intact form with the edited filename and directory.
6. Confirm enqueues one job; cancel/error/timeout enqueues none and remains understandable.
7. The toolbar rail opens at Firefox's maximum available size. Downloads, `Clear done`, all cards, and the footer are fully visible with no horizontal scrollbar or clipped right edge.
8. At a deliberately narrower Firefox window, the panes stack and Downloads remains visible within the viewport.

- [ ] **Step 8: Capture final verification evidence**

Record command outputs, package hashes, installed extension/native versions, helper executable path, and acceptance screenshots in the task handoff. Do not commit user profile data, native paths, screenshots, logs, or build artifacts unless the user explicitly requests an artifact report.

---

## Completion Definition

Implementation is complete only after all five implementation commits are green, the full JavaScript and Python suites pass, the package inventories include the new files, and the installed Firefox acceptance proves the foreground picker, one-row size publication, and unclipped 800 × 600 rail behavior.
