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

// Firefox webRequest.timeStamp is epoch ms; values exceed signed int32 (2^31).
// Mutation: coercing timestamps with bitwise | 0 truncates them.
const FIREFOX_EPOCH_MS = 1786536000123;

test("mapWebRequestDetails preserves Firefox epoch ms timestamps above 2^31", () => {
  const { mapWebRequestDetails } = loadLib("lib/detection-finalizer.js");
  const event = mapWebRequestDetails({
    documentId: "fx-ts",
    tabId: 1,
    frameId: 0,
    url: "https://cdn/x.mp4",
    originUrl: "https://site/page",
    documentUrl: "https://site/page",
    type: "media",
    timeStamp: FIREFOX_EPOCH_MS,
    responseHeaders: [],
  }, { topLevelUrlHint: "https://site/page", frameOrigin: "https://site" });
  assert.equal(event.ts, FIREFOX_EPOCH_MS);
});

test("no-snapshot timeout finalizes with exact capturedAt from large epoch ts", () => {
  const clock = { t: FIREFOX_EPOCH_MS };
  const f = make(clock);
  const id = f.beginNetworkDetection({
    documentId: "doc-ts", tabId: 1, frameId: 0,
    documentUrl: "https://site/page", topLevelUrlHint: "https://site/page",
    mediaUrl: "https://cdn/x.mp4", mediaOrigin: "https://cdn",
    contentDisposition: null, referrerUrl: "https://site/page",
    frameOrigin: "https://site", ts: FIREFOX_EPOCH_MS,
  });
  assert.equal(f.getItem(id), null); // waiting for snapshot / timeout
  clock.t = FIREFOX_EPOCH_MS + 750;
  f.tick(clock.t);
  const item = f.getItem(id);
  assert.ok(item);
  assert.equal(item.sourceContext.capturedAt, new Date(FIREFOX_EPOCH_MS).toISOString());
});

test("finalized sourceContext and rankDiagnostics are deeply immutable", () => {
  // Mutation: shallow Object.freeze leaves nested rankDiagnostics mutable;
  // storing the rank return by reference lets callers mutate after storage.
  const clock = { t: 0 };
  const rankReturn = {
    proposedFilename: "clip.mp4",
    diagnostics: {
      scores: [{ kind: "visible-filename", value: "clip.mp4", score: 10 }],
      nested: { arr: [1, 2] },
    },
  };
  const f = createDetectionFinalizer({
    now: () => clock.t,
    waitMs: 750,
    rank: () => rankReturn,
    buildSourceContext: SC.buildSourceContext,
  });
  const id = f.beginNetworkDetection({
    documentId: null, tabId: 1, frameId: 0,
    documentUrl: "https://site/page", topLevelUrlHint: "https://site/page",
    mediaUrl: "https://cdn/clip.mp4", mediaOrigin: "https://cdn",
    contentDisposition: "clip.mp4", referrerUrl: "https://site/page",
    frameOrigin: "https://site", ts: 0,
  });
  const item = f.getItem(id);
  assert.ok(item);

  assert.throws(() => { item.proposedFilename = "hacked.mp4"; }, TypeError);
  assert.throws(() => { item.sourceContext.filenameCandidates.push({ kind: "x", value: "y" }); }, TypeError);
  assert.throws(() => { item.sourceContext.filenameCandidates[0].value = "mutated"; }, TypeError);
  assert.throws(() => { item.rankDiagnostics.scores.push({ kind: "x", value: "y", score: 0 }); }, TypeError);
  assert.throws(() => { item.rankDiagnostics.scores[0].score = 999; }, TypeError);
  assert.throws(() => { item.rankDiagnostics.nested.arr.push(3); }, TypeError);
  assert.throws(() => { item.rankDiagnostics.nested.arr[0] = 99; }, TypeError);

  // Mutating the original rank return must not affect the stored diagnostics.
  rankReturn.diagnostics.scores[0].score = 999;
  rankReturn.diagnostics.scores.push({ kind: "injected", value: "bad", score: 0 });
  rankReturn.diagnostics.nested.arr.push(3);
  assert.equal(item.rankDiagnostics.scores[0].score, 10);
  assert.equal(item.rankDiagnostics.scores.length, 1);
  assert.deepEqual(item.rankDiagnostics.nested.arr, [1, 2]);
});
