# mCatcher Save As, Size Metadata, and Popup Geometry Repair

Date: 2026-08-13
Status: Approved design; written specification pending user review

## Purpose

Repair three user-visible regressions in the installed Firefox extension:

1. **Save As… → Choose Folder** must open a visible folder picker, preserve the Save As form while that picker owns focus, and use the selected directory.
2. Detected media must show the best trustworthy size information available: an exact byte size when transport evidence proves it, otherwise a clearly labelled bitrate-based estimate when possible, otherwise `Size unknown`.
3. The popup rail must use Firefox's maximum popup area without rendering beyond the actual viewport or clipping the Downloads pane.

The acceptance page is:

`https://florenfile.com/ro454kqdq36j/11474-makemebi.net.mp4.html`

This repair builds on the existing opaque-media controller and the already-landed direct-media ownership/deduplication fix. It must not reintroduce duplicate rows or expose source URLs, signed queries, request headers, cookies, or native paths in public media projections.

## Chosen approach

Use three bounded changes that meet at the safe popup projection:

1. Move Save As editing into a persistent extension-owned window rather than keeping it in the transient browser-action popup.
2. Maintain a safe, ID-keyed media metadata overlay for exact or estimated size information, allowing later network evidence to enrich an existing opaque row instead of creating a second row.
3. Make rail mode request the Firefox popup maximum of 800 × 600 CSS pixels on `<body>` before first paint, then fall back to a single-column layout when Firefox supplies a smaller actual viewport.

The persistent background remains the authority for media identity, download intent, native request correlation, and safe publication. The toolbar popup and Save As window remain presentation layers.

## Scope

### In scope

- A persistent Save As extension page/window opened from the toolbar popup.
- Folder-picker request/result correlation and visible selected/cancelled/error states.
- A foreground-owned native folder picker that honors the requested initial directory.
- Exact and estimated size metadata for opaque media rows.
- Late metadata enrichment of an already-owned direct-media row.
- Popup sizing and responsive rail geometry at Firefox's 800 × 600 maximum and at clamped viewports.
- Behavior, native-host, privacy, geometry, packaging, and installed-Firefox verification for these changes.

### Out of scope

- Replacing mCatcher's existing download scheduler or native transfer protocols.
- Scraping arbitrary page text for a claimed file size.
- Treating a partial-response `Content-Length` as the total resource size.
- Persisting media URLs, signed queries, cookies, authorization headers, or folder paths in media history.
- Filename ranking changes unrelated to the Save As lifecycle.
- General popup redesign beyond eliminating clipping and defining the rail's maximum-size behavior.

## Current failures and causes

### Save As lifecycle

The toolbar popup currently owns the filename and destination only in local DOM state. Choosing a folder awaits a native response. When the native dialog takes focus, Firefox may dismiss the browser-action popup; the response then targets a destroyed form, and reopening the popup resets the destination.

The native picker is also ownerless, does not use its `default_dir` argument, and converts both failures and cancellation into an empty successful-looking folder response. In a windowless native-host process, that dialog can appear behind Firefox, while the extension presents no error or cancellation feedback.

### Missing size

Direct-media probing already discovers useful byte counts from `Content-Range` or `Content-Length`, and the legacy popup renderer can display `item.size`. Promotion into the opaque controller currently drops that field. If DOM evidence owns a media row first, later network evidence is suppressed as a duplicate rather than enriching the owned row.

### Clipped rail

The popup primes a narrow root width, later chooses rail mode from the outer Firefox window width, and then grows the root asynchronously. The outer window width is not the popup content viewport. Firefox can retain a narrower popup while the fixed two-column grid renders at the larger requested width, cutting off the right pane and introducing horizontal overflow.

## Architecture

### 1. Persistent Save As surface

Add an extension-owned Save As page, opened as a small Firefox extension window. Its launch address contains only bounded opaque correlation values:

```text
tabId + mediaId + optional variantId
```

It never receives a media URL, request headers, source handle, filename, or directory in the URL. After loading, it requests the current safe media projection from the background and renders:

- the proposed filename in an editable field;
- the currently selected or default destination, if any;
- **Choose Folder**, **Save**, and **Cancel** actions;
- visible pending, cancellation, validation, timeout, and failure feedback.

Opening the native picker does not destroy this window, so the form and edited filename survive focus changes. **Save** creates the existing immutable download intent only after filename and destination validation succeeds. The window closes only after enqueue succeeds or the user explicitly cancels/closes it. Closing it before confirmation creates no job and consumes no scheduler capacity.

Only one Save As window is needed for a given opaque media selection. Repeated clicks focus the existing window when it is still alive; stale window bookkeeping is discarded when the window closes.

### 2. Folder-picker contract

Each picker request carries a fresh bounded request ID and the current/default directory. The native response is one of:

```js
{ type: "folder", requestId, status: "selected", directory }
{ type: "folder", requestId, status: "cancelled" }
{ type: "folder", requestId, status: "error", code }
```

The background correlates the exact pending request and returns a safe extension response:

```js
{ ok: true, status: "selected", dir }
{ ok: true, status: "cancelled" }
{ ok: false, error: "folder_picker_failed" }
```

Unknown, duplicate, malformed, late, and mismatched native responses are inert. Raw exception text is logged only through existing redaction rules and is not sent to the page.

The native host must:

- show a foreground-owned folder dialog rather than an ownerless dialog;
- start at the supplied existing default/current directory;
- return `selected` only for a valid selected directory;
- return `cancelled` for an explicit user cancellation;
- return a bounded safe error code for API/setup failure;
- never swallow an exception into a successful empty directory.

The Save As page disables repeated picker submission while one request is pending. A bounded timeout restores the button, retains the draft, and shows a retryable error. Cancellation retains the filename and previous destination and displays neutral cancellation feedback.

### 3. Safe size model

Size metadata uses this safe internal/public shape:

```js
{
  sizeBytes: 1395864371,
  sizeConfidence: "exact" | "estimated"
}
```

Both values are optional as a pair. `sizeBytes` must be a positive safe integer. `sizeConfidence` is an exact enum. No raw response header, URL, or derivation object is included in popup media JSON.

#### Exact size

An exact size is accepted only from trustworthy transport evidence:

1. A valid total in `Content-Range` (`bytes start-end/total` or `bytes */total`).
2. A valid `Content-Length` from a response known to represent the complete resource, such as a successful full response or an equivalent bounded probe result.

`Content-Length` on a `206 Partial Content` response is the chunk length and is not a total. Malformed, conflicting, non-positive, non-integer, or unsafe values are ignored. A valid `Content-Range` total takes precedence over a full-response `Content-Length` when both are available.

#### Bitrate-based estimate

When no exact size exists, mCatcher may calculate:

```text
estimated bytes = bitrate bits/second × duration seconds ÷ 8
```

Both operands must be finite and positive. The bitrate is selected in this order:

1. the explicitly selected variant's declared bandwidth;
2. the media row's declared bandwidth;
3. mCatcher's existing measured/sample bitrate estimate.

The duration comes from the finalized media/manifest metadata for the same item. The result is rounded to a positive safe integer and is always marked `estimated`. An estimate never overrides an exact size, and an exact size arriving later replaces an estimate.

#### Display

The popup and Save As window render exactly one of:

- `1.3 GB` for exact size;
- `Est. 1.3 GB` for a bitrate-derived estimate;
- `Size unknown` when neither can be supported.

The estimate label is not hidden in a tooltip or implied by colour; `Est.` appears in the visible text.

### 4. Late metadata enrichment without duplication

The background maintains a session-only safe metadata index keyed by opaque `mediaId`. It contains only the validated size fields and a bounded revision needed to trigger publication.

Direct ownership records must resolve an independently arriving network or DOM producer to the already-owned opaque media ID. The ownership index distinguishes:

- an exact canonical direct source URL identity; and
- the broader direct mirror/group identity already used for network mirrors.

It does not deduplicate by filename, label, or displayed size. Distinct source identities remain distinct media items.

When network evidence arrives for a DOM-owned media item:

1. resolve the existing `mediaId` through direct ownership;
2. parse and validate size metadata without exposing the URL;
3. update the safe metadata index only if the new evidence is stronger or newly available;
4. publish one updated safe row with the same `mediaId` and variants;
5. do not call `captureNetwork` and do not allocate a second media row.

When network evidence owns the row first, the initial safe projection is merged with any already-known size metadata. Later DOM evidence cannot replace the source authority or create a duplicate.

Clearing a tab, navigation cleanup, and terminal ownership cleanup remove the corresponding size metadata. The index is memory-only and is not written to extension storage.

### 5. Maximum Firefox rail layout

Rail mode requests Firefox's documented maximum popup content size: 800 × 600 CSS pixels. Width and height are established synchronously on `<body>` before first paint. The implementation removes the cached 560-pixel prime and does not decide layout from `browser.windows.getCurrent().width`.

After layout, mCatcher reads the actual popup content viewport (`visualViewport` when available, otherwise `innerWidth`/`innerHeight`) and observes subsequent viewport-size changes:

- At a full 800 × 600 viewport, render the two-pane media/download rail using the full available width.
- If Firefox clamps the content viewport below the minimum safe two-pane width, switch to a single-column layout inside that actual width.
- Never asynchronously grow the document beyond the supplied viewport.
- Never make the document root a horizontal scroll container.

At every supported width:

- `documentElement.scrollWidth <= visual viewport width`;
- the right edge of the Downloads pane, queue header, clear action, and every download card is within the viewport;
- media cards remain usable and buttons retain visible labels;
- vertical overflow remains in the intended pane/page, not an accidental root-width expansion.

Compact/non-rail states may remain smaller, but any state that enables the rail requests the full 800 × 600 area immediately rather than growing from a narrow cached layout.

## Data flow

### Save As

```text
Toolbar row
  -> open persistent Save As window with opaque IDs
  -> window requests safe media projection
  -> user edits filename
  -> Choose Folder sends correlated native request
  -> selected/cancelled/error response updates persistent form
  -> Save sends immutable intent
  -> background validates ownership and enqueues
  -> window closes after successful enqueue
```

### Size enrichment

```text
DOM or network detection
  -> shared direct ownership resolves one opaque mediaId
  -> trusted exact-size parser OR bounded bitrate estimate
  -> safe mediaId-keyed metadata index
  -> merge into popup projection
  -> publish update for the same row
```

### Rail layout

```text
Synchronous rail prime on body at 800x600
  -> Firefox supplies actual viewport
  -> full two-pane layout when it fits
  -> single-column fallback when clamped
  -> viewport observer keeps geometry contained
```

## Error handling and lifecycle

- Picker setup/API failure is visible and retryable; it is not reported as cancellation or an empty successful path.
- Picker cancellation retains the Save As draft and starts no download.
- Picker timeout invalidates that request ID. A late native result cannot modify the form or enqueue work.
- Save validation errors remain visible in the persistent form.
- If the media ID becomes stale while the Save As window is open, confirmation fails generically and starts no job.
- If enqueue fails, the form remains open with its filename and destination intact.
- Invalid size evidence is ignored; it cannot suppress a previously valid exact size.
- Metadata update failure does not create a replacement media row.
- A clamped or resized popup falls back to one column rather than permitting horizontal overflow.

## Privacy and authority boundaries

- The Save As window URL carries only `tabId`, `mediaId`, and optional `variantId`.
- The window reads only the safe media projection and never receives source handles, signed URLs, cookies, authorization headers, or raw response headers.
- The size metadata index contains only bounded numeric/enumerated values keyed by opaque ID.
- Native picker errors use an allowlisted code; raw OS exception text is not exposed to extension pages.
- Directory paths travel only in the explicit picker response and immutable download intent. They are not added to media rows or general media history.
- Every enqueue revalidates popup sender authority, opaque media ownership, variant ownership, filename, and destination through the existing policy boundary.

## Testing strategy

Implementation is test-driven. Each production behavior begins with a focused failing regression and reaches focused green before broader gates.

### Persistent Save As tests

1. Open Save As for an opaque media row, edit the filename, issue a picker request, close/destroy the toolbar popup, deliver a selected directory, and prove the persistent form retains both values and enqueues exactly once.
2. Selected, cancelled, native-error, timeout, malformed, mismatched, duplicate, and late picker results follow the specified state machine.
3. Cancel/close creates no job and consumes no scheduler slot.
4. Stale media/variant IDs, forged callers, invalid filenames, and invalid destinations fail closed without leaking private fields.

### Native picker tests

1. The requested default directory is supplied to the picker.
2. The dialog is attached to a foreground-capable owner rather than `hwndOwner = 0`.
3. Selection, explicit cancellation, setup/API failure, and invalid selected path produce distinct bounded results.
4. Host exceptions cannot become `{status: "selected", directory: ""}` or any other successful empty response.

### Size tests

1. Valid `Content-Range` totals are exact.
2. Full-response `Content-Length` is exact.
3. `206 Content-Length` alone is not treated as a total.
4. Malformed, conflicting, negative, zero, fractional, and unsafe values are ignored without coercion surprises.
5. Variant bandwidth × duration and sampled bitrate × duration produce bounded `estimated` values only when exact size is absent.
6. Exact evidence replaces an estimate; estimates never replace exact evidence.
7. UI text is exactly distinguishable as exact, `Est.`, or `Size unknown`.

### Ownership and publication tests

1. DOM-first then network metadata yields one row, one opaque media ID, and a late size update.
2. Network-first then DOM yields one row and retains the original source authority.
3. Duplicate URLs across independent producers do not mint another controller media ID.
4. Distinct direct source identities remain separate even when filenames and displayed sizes match.
5. Popup/media JSON contains only allowlisted size fields and contains no injected URL/header/cookie/path sentinels.

### Popup geometry tests

Use Firefox-compatible rendered DOM/CSS rather than source-regex assertions:

1. At an 800 × 600 content viewport, rail mode uses the two-pane layout and all right edges fit.
2. At a representative clamped viewport such as 560 pixels, rail mode switches to one column and all right edges fit.
3. Simulate a large outer Firefox window with a clamped popup viewport and prove the actual viewport wins.
4. Assert `scrollWidth <= viewport width`, including the Downloads heading, clear action, queue cards, and footer.
5. Repeated rail/compact transitions and viewport resize events cannot reintroduce asynchronous width growth.

### Verification gates

- Focused popup, background-live, controller, metadata, and native-picker tests.
- Full extension JavaScript test suite and syntax checks.
- Full native-host Python test suite and packaging-layout tests.
- Diff/style checks and scope review.
- Rebuild and reinstall the extension/native package.
- Installed Firefox Developer Edition verification on the acceptance page: visible foreground folder picker, retained Save As draft, one media row, exact/estimated/unknown size label, and unclipped rail.

## Acceptance criteria

The repair is complete only when all of the following are true in the installed extension:

1. **Choose Folder** visibly opens in front of Firefox and starts in the current/default directory.
2. Selecting a directory returns to the still-open Save As form; cancelling or failing displays the correct state and preserves the draft.
3. Confirming Save As enqueues exactly one job with the edited filename and selected directory.
4. The Florenfile media row shows an exact size when trustworthy transport evidence exists, otherwise a visibly labelled bitrate estimate when duration and bitrate exist, otherwise `Size unknown`.
5. DOM and network evidence for that media produce one row and one opaque media ID.
6. Rail mode requests 800 × 600 and the Downloads pane, clear action, cards, and footer remain fully visible.
7. A Firefox-clamped viewport uses a contained single-column fallback with no horizontal clipping.
8. No new public projection, log, or stored value exposes signed URLs, headers, cookies, source handles, or unrelated native paths.

## Implementation boundaries

The implementation plan should keep the work in three reviewable slices:

1. Persistent Save As surface plus picker protocol/native behavior.
2. Safe size metadata parsing, estimation, ownership correlation, and publication.
3. Popup maximum-size rail geometry and rendered-browser regression coverage.

Each slice must preserve a green integrated branch before the next slice begins. Final package/install verification occurs only after all three slices and the full suites are green.
