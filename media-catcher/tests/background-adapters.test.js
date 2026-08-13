"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const { loadLib, mediaCatcherRoot } = require("./harness/load-lib.js");

const CONTROLLER_KEYS = [
  "captureNetwork",
  "acceptPageSnapshot",
  "captureDomMedia",
  "registerVariants",
  "popupMedia",
  "enqueueDownload",
  "handleNativeMessage",
  "requestFirefoxHandoff",
  "cancel",
  "manualRetry",
  "helperDisconnected",
  "setMaxConcurrent",
  "tick",
  "pump",
  "popupJobs",
];

const LEASE1_FUTURE_MSG = "background adapter behavior not implemented in Lease 1";

function effectCounters() {
  return {
    postNative: 0,
    downloadsDownload: 0,
    createObjectURL: 0,
    revokeObjectURL: 0,
    fetchArrayBuffer: 0,
    assembleMedia: 0,
    isPopupSender: 0,
    getEffectiveDestinationDirectory: 0,
    publishDetection: 0,
    publishJobs: 0,
    persistHistory: 0,
    reportDiagnostic: 0,
    now: 0,
    randomToken: 0,
  };
}

function baseOptions(overrides) {
  const counts = effectCounters();
  const published = [];
  const diagnostics = [];
  let clock = 1000;
  let tokenSeq = 0;
  const opts = {
    maxConcurrent: 2,
    segmentConcurrency: 3,
    retries: 2,
    now() {
      counts.now += 1;
      return clock;
    },
    randomToken(namespace) {
      counts.randomToken += 1;
      tokenSeq += 1;
      return "tok-" + String(namespace || "x") + "-" + tokenSeq;
    },
    postNative() {
      counts.postNative += 1;
    },
    downloadsDownload() {
      counts.downloadsDownload += 1;
      return Promise.resolve(1);
    },
    createObjectURL() {
      counts.createObjectURL += 1;
      return "blob:test";
    },
    revokeObjectURL() {
      counts.revokeObjectURL += 1;
    },
    fetchArrayBuffer() {
      counts.fetchArrayBuffer += 1;
      return Promise.resolve(new ArrayBuffer(0));
    },
    assembleMedia() {
      counts.assembleMedia += 1;
      return Promise.resolve(new Uint8Array(0));
    },
    isPopupSender() {
      counts.isPopupSender += 1;
      return true;
    },
    getEffectiveDestinationDirectory() {
      counts.getEffectiveDestinationDirectory += 1;
      return null;
    },
    publishDetection(d) {
      counts.publishDetection += 1;
      published.push(d);
    },
    publishJobs() {
      counts.publishJobs += 1;
    },
    persistHistory() {
      counts.persistHistory += 1;
    },
    reportDiagnostic(d) {
      counts.reportDiagnostic += 1;
      diagnostics.push(d);
    },
  };
  if (overrides) {
    for (const k of Object.keys(overrides)) {
      opts[k] = overrides[k];
    }
  }
  return { opts, counts, published, diagnostics, setClock(t) { clock = t; }, getClock() { return clock; } };
}

// ---------------------------------------------------------------------------
// BA01 — dual export assigns McBackgroundAdapters and exports only
// createBackgroundAdapters
// Mutation caught: export/API drift, unfrozen controller, eager material
// effects, or a later writer changing Promise conventions.
// ---------------------------------------------------------------------------

test("BA01 — dual export assigns McBackgroundAdapters and exports only createBackgroundAdapters", async () => {
  const { createBackgroundAdapters: cjsFactory, ...rest } = loadLib("lib/background-adapters.js");
  const cjsApi = loadLib("lib/background-adapters.js");
  assert.ok(Object.isFrozen(cjsApi));
  assert.deepEqual(Object.keys(cjsApi), ["createBackgroundAdapters"]);
  assert.equal(typeof cjsFactory, "function");
  assert.deepEqual(Object.keys(rest), []);

  // Classic-script VM load
  const abs = path.join(mediaCatcherRoot, "lib", "background-adapters.js");
  const code = fs.readFileSync(abs, "utf8");
  const root = Object.create(null);
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require,
    console,
    self: root,
    Object,
    Array,
    Map,
    Set,
    WeakSet,
    Promise,
    TypeError,
    Error,
    RangeError,
    Number,
    String,
    Boolean,
    Math,
    JSON,
    Date,
    URL,
    isFinite,
  };
  sandbox.module.exports = sandbox.exports;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox, { filename: abs });
  assert.ok(Object.isFrozen(sandbox.module.exports));
  assert.deepEqual(Object.keys(sandbox.module.exports), ["createBackgroundAdapters"]);
  assert.ok(Object.isFrozen(root.McBackgroundAdapters));
  assert.deepEqual(Object.keys(root.McBackgroundAdapters), ["createBackgroundAdapters"]);
  assert.equal(root.McBackgroundAdapters, sandbox.module.exports);
  // Only McBackgroundAdapters global created
  const rootKeys = Object.keys(root);
  assert.deepEqual(rootKeys, ["McBackgroundAdapters"]);

  // Invalid material options fail before any callback/effect/state hook
  let effectHits = 0;
  const hostile = {
    maxConcurrent: 0,
    segmentConcurrency: 1,
    retries: 1,
    now() { effectHits += 1; return 1; },
    randomToken() { effectHits += 1; return "a"; },
    postNative() { effectHits += 1; },
    downloadsDownload() { effectHits += 1; },
    createObjectURL() { effectHits += 1; return "x"; },
    revokeObjectURL() { effectHits += 1; },
    fetchArrayBuffer() { effectHits += 1; },
    assembleMedia() { effectHits += 1; },
    isPopupSender() { effectHits += 1; return true; },
    getEffectiveDestinationDirectory() { effectHits += 1; return null; },
    publishDetection() { effectHits += 1; },
  };
  assert.throws(() => cjsApi.createBackgroundAdapters(hostile), TypeError);
  assert.equal(effectHits, 0);

  assert.throws(
    () => cjsApi.createBackgroundAdapters({
      maxConcurrent: 1,
      segmentConcurrency: 1,
      retries: 1,
      now: null,
      randomToken() { return "a"; },
      postNative() {},
      downloadsDownload() {},
      createObjectURL() { return "x"; },
      revokeObjectURL() {},
      fetchArrayBuffer() {},
      assembleMedia() {},
      isPopupSender() { return true; },
      getEffectiveDestinationDirectory() { return null; },
    }),
    TypeError
  );

  // Invalid optional callback rejects without invoking it
  assert.throws(
    () => cjsApi.createBackgroundAdapters({
      maxConcurrent: 1,
      segmentConcurrency: 1,
      retries: 1,
      now() { return 1; },
      randomToken() { return "a"; },
      postNative() {},
      downloadsDownload() {},
      createObjectURL() { return "x"; },
      revokeObjectURL() {},
      fetchArrayBuffer() {},
      assembleMedia() {},
      isPopupSender() { return true; },
      getEffectiveDestinationDirectory() { return null; },
      publishDetection: "not-a-function",
    }),
    TypeError
  );

  const env = baseOptions();
  const controller = cjsApi.createBackgroundAdapters(env.opts);
  assert.ok(Object.isFrozen(controller));
  assert.deepEqual(Object.keys(controller), CONTROLLER_KEYS);
  for (const k of CONTROLLER_KEYS) {
    assert.equal(typeof controller[k], "function", k);
  }

  // popupJobs is deeply frozen empty array
  const jobs = controller.popupJobs();
  assert.ok(Array.isArray(jobs));
  assert.equal(jobs.length, 0);
  assert.ok(Object.isFrozen(jobs));

  // registerVariants throws stable synchronous future-slice error
  assert.throws(
    () => controller.registerVariants("media-1", []),
    (err) => err instanceof Error && err.message === LEASE1_FUTURE_MSG
  );

  // Representative async future stub returns a Promise before rejecting;
  // does not throw synchronously or invoke effects.
  const before = { ...env.counts };
  let settled = false;
  let syncThrow = false;
  let p;
  try {
    p = controller.enqueueDownload({}, {});
  } catch (e) {
    syncThrow = true;
  }
  assert.equal(syncThrow, false);
  assert.ok(p && typeof p.then === "function");
  assert.equal(p instanceof Promise, true);
  await assert.rejects(p, (err) => err instanceof Error && err.message === LEASE1_FUTURE_MSG);
  settled = true;
  assert.equal(settled, true);
  assert.equal(env.counts.postNative, before.postNative);
  assert.equal(env.counts.downloadsDownload, before.downloadsDownload);
  assert.equal(env.counts.fetchArrayBuffer, before.fetchArrayBuffer);
  assert.equal(env.counts.assembleMedia, before.assembleMedia);
  assert.equal(env.counts.publishDetection, before.publishDetection);
  assert.equal(env.counts.publishJobs, before.publishJobs);
  assert.equal(env.counts.persistHistory, before.persistHistory);

  // Other async stubs also reject without mutation
  await assert.rejects(controller.handleNativeMessage({}), (err) => err.message === LEASE1_FUTURE_MSG);
  await assert.rejects(controller.requestFirefoxHandoff({}, {}), (err) => err.message === LEASE1_FUTURE_MSG);
  await assert.rejects(controller.cancel("j"), (err) => err.message === LEASE1_FUTURE_MSG);
  await assert.rejects(controller.manualRetry("j"), (err) => err.message === LEASE1_FUTURE_MSG);
  await assert.rejects(controller.helperDisconnected(), (err) => err.message === LEASE1_FUTURE_MSG);
  await assert.rejects(controller.setMaxConcurrent(1), (err) => err.message === LEASE1_FUTURE_MSG);
  await assert.rejects(controller.pump(), (err) => err.message === LEASE1_FUTURE_MSG);

  // tick is implemented (Promise) — not a future stub for missing-behavior of API surface
  const tickP = controller.tick(1000);
  assert.equal(tickP instanceof Promise, true);
  await tickP;

  // Factory construction must not invoke material effects (downloadsDownload only
  // captured into FirefoxGuard; no method may call it in Lease 1).
  assert.equal(env.counts.downloadsDownload, 0);
  assert.equal(env.counts.postNative, 0);
  assert.equal(env.counts.fetchArrayBuffer, 0);
  assert.equal(env.counts.assembleMedia, 0);
  assert.equal(env.counts.createObjectURL, 0);
  assert.equal(env.counts.revokeObjectURL, 0);
  assert.equal(env.counts.publishJobs, 0);
  assert.equal(env.counts.persistHistory, 0);

  // No browser/chrome globals required
  assert.equal(typeof globalThis.browser, "undefined");
  assert.equal(typeof globalThis.chrome, "undefined");

  // Sync methods are present (behavior tested in BA02+)
  assert.equal(typeof controller.captureNetwork, "function");
  assert.equal(typeof controller.acceptPageSnapshot, "function");
  assert.equal(typeof controller.captureDomMedia, "function");
  assert.equal(typeof controller.popupMedia, "function");
});

// ---------------------------------------------------------------------------
// BA02 — pending detection is invisible until finalization
// Mutation caught: exposing pending records, correlating by mutable tab alone,
// or reconciling the same finalizer ID twice.
// ---------------------------------------------------------------------------

test("BA02 — pending detection is invisible until finalization", async () => {
  const { createBackgroundAdapters } = loadLib("lib/background-adapters.js");
  const env = baseOptions();
  const adapters = createBackgroundAdapters(env.opts);

  const pageUrl = "https://florenfile.com/qnzjnabo3jec/11238-makemebi.net.mp4.html";
  const mediaId = adapters.captureNetwork({
    details: {
      documentId: "doc-pending-A",
      tabId: 7,
      frameId: 0,
      url: "https://s40.example-cdn.invalid/file.mp4",
      originUrl: pageUrl,
      documentUrl: pageUrl,
      type: "media",
      timeStamp: 1000,
      responseHeaders: [],
    },
    hints: {
      topLevelUrlHint: pageUrl,
      frameOrigin: "https://florenfile.com",
    },
    transport: {
      mediaKind: "direct",
      requestHeaders: null,
    },
  });

  // Opaque media ID immediately; must not be a numeric finalizer ID.
  assert.equal(typeof mediaId, "string");
  assert.ok(mediaId.length > 0);
  assert.equal(Number.isFinite(Number(mediaId)) && String(Number(mediaId)) === mediaId, false);
  assert.equal(env.counts.publishDetection, 0);
  assert.deepEqual(adapters.popupMedia(7), []);
  assert.ok(Object.isFrozen(adapters.popupMedia(7)));

  // Wrong-document snapshot must not expose pending media.
  assert.equal(
    adapters.acceptPageSnapshot({
      documentId: "doc-OTHER",
      tabId: 7,
      frameId: 0,
      pageUrl: "https://other.example/",
      topLevelPageUrl: "https://other.example/",
      documentNonce: "n-wrong",
      candidates: [{ kind: "visible-filename", value: "wrong.mp4" }],
      capturedAt: "2026-08-12T12:00:00.000Z",
    }),
    undefined
  );
  assert.equal(env.counts.publishDetection, 0);
  assert.equal(adapters.popupMedia(7).length, 0);

  // Matching snapshot finalizes once.
  adapters.acceptPageSnapshot({
    documentId: "doc-pending-A",
    tabId: 7,
    frameId: 0,
    pageUrl: pageUrl,
    topLevelPageUrl: pageUrl,
    documentNonce: "n-match",
    candidates: [
      { kind: "document-title", value: "Florenfile.com - Secure Cloud Storage" },
      { kind: "visible-filename", value: "11238-makemebi.net.mp4" },
    ],
    capturedAt: "2026-08-12T12:00:00.000Z",
  });

  assert.equal(env.counts.publishDetection, 1);
  assert.equal(env.published[0].id, mediaId);
  assert.equal(env.published[0].kind, "direct");
  assert.equal(env.published[0].proposedFilename, "11238-makemebi.net.mp4");

  const rows = adapters.popupMedia(7);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, mediaId);
  assert.equal(rows[0].proposedFilename, "11238-makemebi.net.mp4");
  assert.equal(rows[0].kind, "direct");

  // Repeated matching snapshot does not duplicate publication/row.
  adapters.acceptPageSnapshot({
    documentId: "doc-pending-A",
    tabId: 7,
    frameId: 0,
    pageUrl: pageUrl,
    topLevelPageUrl: pageUrl,
    documentNonce: "n-match-2",
    candidates: [
      { kind: "visible-filename", value: "11238-makemebi.net.mp4" },
    ],
    capturedAt: "2026-08-12T12:00:01.000Z",
  });
  assert.equal(env.counts.publishDetection, 1);
  assert.equal(adapters.popupMedia(7).length, 1);

  // Later tick does not duplicate.
  await adapters.tick(5000);
  assert.equal(env.counts.publishDetection, 1);
  assert.equal(adapters.popupMedia(7).length, 1);
  assert.equal(adapters.popupMedia(7)[0].id, mediaId);
});

// ---------------------------------------------------------------------------
// BA03 — finalized source context and proposed filename survive later
// snapshots/navigation
// Mutation caught: rereading mutable tab context, replacing source context, or
// rerunning the ranker after finalization.
// ---------------------------------------------------------------------------

test("BA03 — finalized source context and proposed filename survive later snapshots/navigation", async () => {
  const { createBackgroundAdapters } = loadLib("lib/background-adapters.js");
  const env = baseOptions();
  const adapters = createBackgroundAdapters(env.opts);

  const pageUrl = "https://florenfile.com/qnzjnabo3jec/11238-makemebi.net.mp4.html";
  const mediaId = adapters.captureNetwork({
    details: {
      documentId: "doc-floren-1",
      tabId: 42,
      frameId: 0,
      url: "https://s40.example-cdn.invalid/file.mp4?token=SIGNED",
      originUrl: pageUrl,
      documentUrl: pageUrl,
      type: "media",
      timeStamp: 2000,
      responseHeaders: [],
    },
    hints: {
      topLevelUrlHint: pageUrl,
      frameOrigin: "https://florenfile.com",
    },
    transport: {
      mediaKind: "direct",
      requestHeaders: null,
    },
  });

  adapters.acceptPageSnapshot({
    documentId: "doc-floren-1",
    tabId: 42,
    frameId: 0,
    pageUrl: pageUrl,
    topLevelPageUrl: pageUrl,
    documentNonce: "n-floren",
    candidates: [
      { kind: "document-title", value: "Florenfile.com - Secure Cloud Storage" },
      { kind: "page-url", value: "/qnzjnabo3jec/11238-makemebi.net.mp4.html" },
      { kind: "visible-filename", value: "11238-makemebi.net.mp4" },
    ],
    capturedAt: "2026-08-12T12:00:00.000Z",
  });

  assert.equal(env.counts.publishDetection, 1);
  const firstPub = env.published[0];
  assert.ok(Object.isFrozen(firstPub));
  assert.equal(firstPub.id, mediaId);
  assert.equal(firstPub.proposedFilename, "11238-makemebi.net.mp4");
  assert.equal(firstPub.kind, "direct");
  assert.equal(firstPub.providerKey, "florenfile.com");

  // Freeze snapshot of the safe projection.
  const frozenFilename = firstPub.proposedFilename;
  const frozenProvider = firstPub.providerKey;
  const frozenKind = firstPub.kind;

  // Later same-tab navigation/snapshot with different site, title, headings, URL, branding.
  adapters.acceptPageSnapshot({
    documentId: "doc-navigated-99",
    tabId: 42,
    frameId: 0,
    pageUrl: "https://brand-site.example/generic-player",
    topLevelPageUrl: "https://brand-site.example/generic-player",
    documentNonce: "n-nav",
    candidates: [
      { kind: "document-title", value: "BrandSite - Secure Cloud Storage" },
      { kind: "heading", value: "Watch Now" },
      { kind: "visible-filename", value: "video.mp4" },
    ],
    capturedAt: "2026-08-12T12:05:00.000Z",
  });

  // Initial projection remains frozen and unchanged.
  assert.equal(firstPub.proposedFilename, frozenFilename);
  assert.equal(firstPub.providerKey, frozenProvider);
  assert.equal(firstPub.kind, frozenKind);
  assert.equal(firstPub.proposedFilename, "11238-makemebi.net.mp4");
  assert.equal(firstPub.providerKey, "florenfile.com");

  // No second publication/ranking.
  assert.equal(env.counts.publishDetection, 1);
  assert.equal(env.published.length, 1);

  const rows = adapters.popupMedia(42);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, mediaId);
  assert.equal(rows[0].proposedFilename, "11238-makemebi.net.mp4");
  assert.equal(rows[0].kind, "direct");

  // Tick after navigation still does not re-rank.
  await adapters.tick(9000);
  assert.equal(env.counts.publishDetection, 1);
  assert.equal(adapters.popupMedia(42)[0].proposedFilename, "11238-makemebi.net.mp4");
});

// ---------------------------------------------------------------------------
// BA04 — popup media exposes opaque IDs and no raw URL/context/header fields
// Mutation caught: spreading the finalizer/private source record, leaking
// numeric detection authority, or serializing ephemeral request material.
// ---------------------------------------------------------------------------

const SENTINEL_TOKEN = "SECRET_SIGNED_QUERY_XYZ_BA04";
const SENTINEL_COOKIE = "SECRET_COOKIE_ABC_BA04";
const SENTINEL_AUTH = "Bearer SECRET_AUTH_BA04";
const FORBIDDEN_FIELD_NAMES = [
  "mediaUrl",
  "requestHeaders",
  "sourceContext",
  "topLevelPageUrl",
  "immediateReferrerUrl",
  "mediaOrigin",
  "documentId",
  "Cookie",
  "Authorization",
  "detectionId",
  "ephemeral",
  "headers",
  "referrer",
  "pageUrl",
];

function assertNoSentinelLeak(value, label) {
  const raw = JSON.stringify(value);
  assert.equal(raw.includes(SENTINEL_TOKEN), false, label + " token");
  assert.equal(raw.includes(SENTINEL_COOKIE), false, label + " cookie");
  assert.equal(raw.includes(SENTINEL_AUTH), false, label + " auth");
  for (const name of FORBIDDEN_FIELD_NAMES) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        typeof value === "object" && value !== null ? value : {},
        name
      ) && !Array.isArray(value),
      false,
      label + " own field " + name
    );
    // Nested field names via string inspection of JSON keys
    assert.equal(
      raw.includes('"' + name + '"'),
      false,
      label + " json key " + name
    );
  }
}

test("BA04 — popup media exposes opaque IDs and no raw URL/context/header fields", async () => {
  const { createBackgroundAdapters } = loadLib("lib/background-adapters.js");
  // Force randomToken to repeat so collision-resistance of minting is proven.
  const counts = effectCounters();
  const published = [];
  const diagnostics = [];
  let clock = 3000;
  const opts = {
    maxConcurrent: 2,
    segmentConcurrency: 2,
    retries: 1,
    now() {
      counts.now += 1;
      return clock;
    },
    randomToken(_ns) {
      counts.randomToken += 1;
      return "same-token";
    },
    postNative() {
      counts.postNative += 1;
    },
    downloadsDownload() {
      counts.downloadsDownload += 1;
      return Promise.resolve(1);
    },
    createObjectURL() {
      counts.createObjectURL += 1;
      return "blob:test";
    },
    revokeObjectURL() {
      counts.revokeObjectURL += 1;
    },
    fetchArrayBuffer() {
      counts.fetchArrayBuffer += 1;
      return Promise.resolve(new ArrayBuffer(0));
    },
    assembleMedia() {
      counts.assembleMedia += 1;
      return Promise.resolve(new Uint8Array(0));
    },
    isPopupSender() {
      counts.isPopupSender += 1;
      return true;
    },
    getEffectiveDestinationDirectory() {
      counts.getEffectiveDestinationDirectory += 1;
      return null;
    },
    publishDetection(d) {
      counts.publishDetection += 1;
      published.push(d);
    },
    publishJobs() {
      counts.publishJobs += 1;
    },
    persistHistory() {
      counts.persistHistory += 1;
    },
    reportDiagnostic(d) {
      counts.reportDiagnostic += 1;
      diagnostics.push(d);
    },
  };
  const adapters = createBackgroundAdapters(opts);

  const pageUrl =
    "https://florenfile.com/qnzjnabo3jec/11238-makemebi.net.mp4.html?session=" +
    SENTINEL_TOKEN;
  const signedUrl =
    "https://s40.example-cdn.invalid/file.mp4?token=" + SENTINEL_TOKEN + "&exp=99";
  const referrer = pageUrl;

  const netId = adapters.captureNetwork({
    details: {
      documentId: "doc-ba04-net",
      tabId: 11,
      frameId: 0,
      url: signedUrl,
      originUrl: referrer,
      documentUrl: pageUrl,
      type: "media",
      timeStamp: 3000,
      responseHeaders: [],
    },
    hints: {
      topLevelUrlHint: pageUrl,
      frameOrigin: "https://florenfile.com",
    },
    transport: {
      mediaKind: "direct",
      requestHeaders: {
        Cookie: SENTINEL_COOKIE,
        Authorization: SENTINEL_AUTH,
        Referer: referrer,
      },
    },
  });

  adapters.acceptPageSnapshot({
    documentId: "doc-ba04-net",
    tabId: 11,
    frameId: 0,
    pageUrl: pageUrl,
    topLevelPageUrl: pageUrl,
    documentNonce: "n-ba04",
    candidates: [
      { kind: "visible-filename", value: "11238-makemebi.net.mp4" },
      { kind: "document-title", value: "Florenfile.com - Secure Cloud Storage" },
    ],
    capturedAt: "2026-08-12T12:00:00.000Z",
  });

  const domId = adapters.captureDomMedia({
    snapshot: {
      documentId: "doc-ba04-dom",
      tabId: 11,
      frameId: 0,
      pageUrl: pageUrl,
      topLevelPageUrl: pageUrl,
      documentNonce: "n-ba04-dom",
      candidates: [{ kind: "visible-filename", value: "dom-clip.mp4" }],
      capturedAt: "2026-08-12T12:00:02.000Z",
    },
    mediaUrl: "https://cdn.example/dom-clip.mp4?auth=" + SENTINEL_TOKEN,
    mediaOrigin: "https://cdn.example",
    contentDisposition: null,
    referrerUrl: referrer,
    frameOrigin: "https://florenfile.com",
    ts: 3002,
    transport: {
      mediaKind: "direct",
      requestHeaders: {
        Cookie: SENTINEL_COOKIE,
        Authorization: SENTINEL_AUTH,
      },
    },
  });

  // Opaque IDs: safe strings, unique even when randomToken repeats, not numeric.
  assert.equal(typeof netId, "string");
  assert.equal(typeof domId, "string");
  assert.notEqual(netId, domId);
  assert.ok(/^[A-Za-z0-9._:-]+$/.test(netId));
  assert.ok(/^[A-Za-z0-9._:-]+$/.test(domId));
  assert.equal(Number.isFinite(Number(netId)) && String(Number(netId)) === netId, false);
  assert.equal(Number.isFinite(Number(domId)) && String(Number(domId)) === domId, false);

  // publishDetection: exactly four safe keys, no secrets.
  assert.equal(counts.publishDetection, 2);
  for (const pub of published) {
    assert.ok(Object.isFrozen(pub));
    assert.deepEqual(Object.keys(pub).sort(), [
      "id",
      "kind",
      "proposedFilename",
      "providerKey",
    ]);
    assertNoSentinelLeak(pub, "publishDetection");
  }

  // Reset effect counters around popup read (publication already happened).
  const beforePopup = { ...counts };
  const rows = adapters.popupMedia(11);
  assert.equal(rows.length, 2);
  assert.ok(Object.isFrozen(rows));
  // Fresh copies each call
  const rows2 = adapters.popupMedia(11);
  assert.notEqual(rows, rows2);
  assert.notEqual(rows[0], rows2[0]);

  for (const row of rows) {
    assert.ok(Object.isFrozen(row));
    assert.deepEqual(Object.keys(row).sort(), [
      "id",
      "kind",
      "proposedFilename",
      "variants",
    ]);
    assert.ok(Array.isArray(row.variants));
    assert.equal(row.variants.length, 0);
    assert.ok(Object.isFrozen(row.variants));
    assert.equal(typeof row.id, "string");
    assert.ok(/^[A-Za-z0-9._:-]+$/.test(row.id));
    assertNoSentinelLeak(row, "popup row");
  }
  assertNoSentinelLeak(rows, "popup array");

  // IDs match opaque mint and are unique.
  const ids = rows.map((r) => r.id).sort();
  assert.deepEqual(ids, [domId, netId].sort());

  // Popup calls do not invoke transport / Firefox / fetch / assembly / publication effects.
  assert.equal(counts.postNative, beforePopup.postNative);
  assert.equal(counts.downloadsDownload, beforePopup.downloadsDownload);
  assert.equal(counts.createObjectURL, beforePopup.createObjectURL);
  assert.equal(counts.revokeObjectURL, beforePopup.revokeObjectURL);
  assert.equal(counts.fetchArrayBuffer, beforePopup.fetchArrayBuffer);
  assert.equal(counts.assembleMedia, beforePopup.assembleMedia);
  assert.equal(counts.publishDetection, beforePopup.publishDetection);
  assert.equal(counts.publishJobs, beforePopup.publishJobs);
  assert.equal(counts.persistHistory, beforePopup.persistHistory);
  assert.equal(counts.isPopupSender, beforePopup.isPopupSender);
  assert.equal(
    counts.getEffectiveDestinationDirectory,
    beforePopup.getEffectiveDestinationDirectory
  );
});
