"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { mediaCatcherRoot } = require("./harness/load-lib.js");
const McPrivacy = require(path.join(mediaCatcherRoot, "lib", "privacy.js"));

function event() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit() {
      const args = arguments;
      return listeners.map((listener) => listener.apply(null, args));
    },
  };
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function eventually(predicate, label) {
  for (let i = 0; i < 40; i += 1) {
    if (predicate()) return;
    await settle();
  }
  assert.fail(label);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createHarness(storageSeed) {
  const runtimeMessages = event();
  const requestHeaders = event();
  const headersReceived = event();
  const captureNetwork = [];
  const acceptPageSnapshot = [];
  const captureDomMedia = [];
  const registerVariants = [];
  const broadcasts = [];
  const popupRows = new Map();
  const textBodies = new Map();
  const dashParsed = new Map();
  const directProbeGates = new Map();
  const controllerJobs = Object.freeze([{ id: "job:opaque:1", state: "queued" }]);
  let mediaSeq = 0;

  // Every captured media ID must be observable as exactly one safe popup row so
  // duplicate-row regressions are visible through the public projection. Rows a
  // test installed by hand win, so existing explicit fixtures keep their shape.
  function publishRow(tabId, mediaId, kind) {
    if (!Number.isInteger(tabId)) return;
    const existing = popupRows.get(tabId) || [];
    if (existing.some((row) => row && row.id === mediaId)) return;
    popupRows.set(tabId, Object.freeze(existing.concat([Object.freeze({
      id: mediaId,
      proposedFilename: "movie.mp4",
      kind: typeof kind === "string" ? kind : "direct",
      variants: Object.freeze([]),
    })])));
  }

  const controller = {
    captureNetwork(input) {
      captureNetwork.push(clone(input));
      const mediaId = "media:opaque:" + (++mediaSeq);
      publishRow(input && input.details && input.details.tabId, mediaId,
        input && input.transport && input.transport.mediaKind);
      return mediaId;
    },
    acceptPageSnapshot(snapshot) { acceptPageSnapshot.push(clone(snapshot)); },
    captureDomMedia(input) {
      captureDomMedia.push(clone(input));
      const mediaId = "media:opaque:" + (++mediaSeq);
      publishRow(input && input.snapshot && input.snapshot.tabId, mediaId, "direct");
      return mediaId;
    },
    registerVariants(mediaId, variants) {
      registerVariants.push({ mediaId, variants: clone(variants) });
      return [];
    },
    popupMedia(tabId) { return popupRows.get(tabId) || Object.freeze([]); },
    popupJobs() { return controllerJobs; },
    async handleNativeMessage() { return false; },
    helperDisconnected() {},
  };

  const noopEvent = () => event();
  const nativePort = { onMessage: noopEvent(), onDisconnect: noopEvent(), postMessage() {} };
  const browser = {
    storage: { local: {
      get() {
        return Promise.resolve(Object.assign(
          { pd4done: true, dq1done: true },
          storageSeed ? clone(storageSeed) : null
        ));
      },
      set() { return Promise.resolve(); },
    } },
    runtime: {
      id: "media-catcher@test",
      lastError: null,
      onMessage: runtimeMessages,
      onInstalled: noopEvent(),
      connectNative() { return nativePort; },
      sendMessage(message) { broadcasts.push(clone(message)); return Promise.resolve(); },
      getManifest() { return { version: "1.10.0" }; },
      getURL(relative) { return "moz-extension://media-catcher/" + relative; },
    },
    downloads: { download() { return Promise.resolve(1); }, search() { return Promise.resolve([]); }, open() {}, show() {} },
    tabs: {
      onActivated: noopEvent(), onRemoved: noopEvent(), onUpdated: noopEvent(), query() { return Promise.resolve([]); },
      create() { return Promise.resolve(); }, update() { return Promise.resolve(); }, executeScript() { return Promise.resolve(); },
    },
    webRequest: { onSendHeaders: requestHeaders, onHeadersReceived: headersReceived, onBeforeSendHeaders: noopEvent() },
    browserAction: { onClicked: noopEvent(), setBadgeText() {}, setBadgeBackgroundColor() {} },
    contextMenus: { onClicked: noopEvent(), removeAll(cb) { if (cb) cb(); }, create() {} },
    notifications: { onClicked: noopEvent(), onClosed: noopEvent(), create() {}, clear() {} },
  };

  const root = {};
  const sandbox = {
    self: root,
    browser,
    console: { log() {}, warn() {}, error() {} },
    Promise, Map, Set, WeakMap, Object, Array, ArrayBuffer, Uint8Array,
    TextDecoder, TextEncoder, URL, Blob, Date, Math, JSON, Number, String,
    Boolean, RegExp, Error, TypeError, RangeError, Symbol, Reflect, Proxy,
    AbortController,
    setTimeout() { return 1; }, clearTimeout() {},
    fetch(url) {
      if (url === "https://cdn.example/movie.mp4") {
        const makeResponse = () => {
          const head = new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70]);
          let sent = false;
          return {
            ok: true,
            status: 206,
            headers: { get(name) {
              if (String(name).toLowerCase() === "content-type") return "video/mp4";
              if (String(name).toLowerCase() === "content-range") return "bytes 0-7/10485760";
              return null;
            } },
            body: { getReader() { return { read() {
              if (sent) return Promise.resolve({ done: true });
              sent = true;
              return Promise.resolve({ done: false, value: head });
            } }; } },
          };
        };
        const gate = directProbeGates.get(url);
        if (gate) {
          gate.markStarted();
          return gate.releasePromise.then(makeResponse);
        }
        return Promise.resolve(makeResponse());
      }
      if (textBodies.has(url)) {
        const bytes = new TextEncoder().encode(textBodies.get(url));
        return Promise.resolve({
          ok: true,
          status: 200,
          arrayBuffer() { return Promise.resolve(bytes.buffer.slice(0)); },
        });
      }
      throw new Error("unexpected fetch " + url);
    },
    crypto: { randomUUID() { return "00000000-0000-4000-8000-000000000001"; } },
  };
  vm.createContext(sandbox);

  const manifest = JSON.parse(fs.readFileSync(path.join(mediaCatcherRoot, "manifest.json"), "utf8"));
  for (const relative of manifest.background.scripts) {
    if (relative === "background.js") {
      root.DASH = {
        parse(_text, url) {
          if (!dashParsed.has(url)) throw new Error("unexpected DASH parse " + url);
          return dashParsed.get(url);
        },
      };
      root.McLiveMediaAssembler = { createLiveMediaAssembler() { return async () => { throw new Error("unused"); }; } };
      root.McBackgroundAdapters = { createBackgroundAdapters() { return controller; } };
    }
    vm.runInContext(fs.readFileSync(path.join(mediaCatcherRoot, relative), "utf8"), sandbox, { filename: relative });
  }

  async function send(message, sender) {
    return new Promise((resolve, reject) => {
      let responded = false;
      const timer = setTimeout(() => { if (!responded) reject(new Error("background did not respond")); }, 1000);
      runtimeMessages.emit(message, sender || {}, (response) => {
        responded = true;
        clearTimeout(timer);
        resolve(clone(response));
      });
    });
  }

  return {
    send, requestHeaders, headersReceived, captureNetwork, acceptPageSnapshot, captureDomMedia,
    registerVariants, broadcasts, popupRows, controllerJobs, textBodies, dashParsed,
    nativePort,
    holdDirectProbe(url) {
      let release;
      let markStarted;
      const started = new Promise((resolve) => { markStarted = resolve; });
      const releasePromise = new Promise((resolve) => { release = resolve; });
      directProbeGates.set(url, { markStarted, releasePromise });
      return { started, release };
    },
  };
}

function pageSnapshot() {
  return {
    type: "page-snapshot",
    documentId: "doc-7",
    documentNonce: "nonce-7",
    tabId: 7,
    frameId: 2,
    pageUrl: "https://frame.example/player",
    topLevelPageUrl: "https://site.example/watch",
    candidates: [{ kind: "visible-filename", value: "Movie Night.mp4" }],
    capturedAt: "2026-08-13T12:00:00.000Z",
  };
}

function emitNetwork(h, tabId, url, contentType, documentId) {
  h.headersReceived.emit({
    tabId,
    frameId: 0,
    documentId,
    documentUrl: "https://site.example/watch-" + tabId,
    originUrl: "https://site.example/watch-" + tabId,
    url,
    timeStamp: Date.parse("2026-08-13T12:00:00.000Z"),
    responseHeaders: [{ name: "Content-Type", value: contentType }],
  });
}

test("routes sender-bound page evidence and snapshot-bound direct DOM media", async () => {
  const h = createHarness();
  await settle();
  const sender = {
    tab: { id: 7, url: "https://site.example/watch", title: "Movie Night" },
    frameId: 2,
    documentId: "doc-7",
    url: "https://frame.example/player",
  };

  assert.deepEqual(await h.send({ type: "page-snapshot-context", documentNonce: "nonce-7", pageUrl: sender.url }, sender), {
    ok: true,
    tabId: 7,
    frameId: 2,
    documentId: "doc-7",
    topLevelPageUrl: "https://site.example/watch",
  });

  const snapshot = pageSnapshot();
  assert.deepEqual(await h.send(snapshot, sender), { ok: true });
  assert.deepEqual(h.acceptPageSnapshot, [snapshot]);

  await h.send({
    type: "content-media",
    item: { url: "https://cdn.example/dom.mp4", kind: "direct", name: "dom.mp4", source: "dom" },
    referrerUrl: "https://frame.example/player",
    frameOrigin: "https://frame.example",
    snapshot,
  }, sender);
  assert.deepEqual(h.captureDomMedia, [{
    mediaUrl: "https://cdn.example/dom.mp4",
    mediaOrigin: "https://cdn.example",
    contentDisposition: null,
    referrerUrl: "https://frame.example/player",
    frameOrigin: "https://frame.example",
    ts: 0,
    snapshot,
    transport: { mediaKind: "direct", requestHeaders: null },
  }]);

  await h.send({
    type: "content-media",
    item: {
      url: "https://www.youtube.com/watch?v=legacy123",
      kind: "youtube",
      videoId: "legacy123",
      name: "Legacy YouTube",
    },
    snapshot,
  }, sender);
  assert.equal(h.captureDomMedia.length, 1, "YouTube remains legacy");
  const youtube = await h.send({ type: "get-media", tabId: 7 });
  assert.equal(youtube.items.some((item) => item.kind === "youtube" && item.videoId === "legacy123"), true);
});

test("promotes a probed network direct item and merges opaque frozen controller surfaces", async () => {
  const h = createHarness();
  await settle();
  await h.send(
    { type: "page-info", title: "Movie Night", ogTitle: "" },
    { tab: { id: 7, url: "https://site.example/watch" }, frameId: 0 }
  );
  h.popupRows.set(7, Object.freeze([Object.freeze({
    id: "media:opaque:1", proposedFilename: "Movie Night.mp4", kind: "direct", variants: Object.freeze([]),
  })]));

  h.headersReceived.emit({
    tabId: 7,
    frameId: 2,
    documentId: "doc-7",
    documentUrl: "https://frame.example/player",
    originUrl: "https://site.example/watch",
    url: "https://cdn.example/movie.mp4",
    timeStamp: Date.parse("2026-08-13T12:00:00.000Z"),
    responseHeaders: [
      { name: "Content-Type", value: "video/mp4" },
      { name: "Content-Length", value: "10485760" },
      { name: "Content-Disposition", value: "attachment; filename=movie.mp4" },
    ],
  });
  await settle();
  await settle();

  assert.equal(h.captureNetwork.length, 1);
  assert.equal(h.captureNetwork[0].details.url, "https://cdn.example/movie.mp4");
  assert.equal(h.captureNetwork[0].transport.mediaKind, "direct");
  assert.equal(JSON.stringify(h.captureNetwork[0]).includes("Authorization"), false);

  h.headersReceived.emit({
    tabId: 7, frameId: 2, documentId: "doc-7",
    documentUrl: "https://frame.example/player", originUrl: "https://site.example/watch",
    url: "https://cdn.example/movie.mp4?repeat=1", timeStamp: Date.now(),
    responseHeaders: [{ name: "Content-Type", value: "video/mp4" }],
  });
  await settle();
  assert.equal(h.captureNetwork.length, 1, "promoted direct key stays deduplicated");

  const result = await h.send({ type: "get-media", tabId: 7 });
  assert.deepEqual(result.items, [{
    id: "media:opaque:1",
    proposedFilename: "Movie Night.mp4",
    kind: "direct",
    variants: [],
    tabId: 7,
    // The probe's Content-Range total is the only exact size evidence here.
    sizeBytes: 10485760,
    sizeConfidence: "exact",
    thumb: null,
    pageTitle: "Movie Night",
  }]);
  assert.deepEqual(result.downloads, [{ id: "job:opaque:1", state: "queued" }]);
  assert.equal(JSON.stringify(result).includes("https://cdn.example/movie.mp4"), false);
  assert.equal(Object.isFrozen(h.popupRows.get(7)[0]), true, "background must copy, not mutate controller rows");
});

test("matching network and DOM direct detections reach the controller once in either order", async () => {
  const mediaUrl = "https://cdn.example/movie.mp4";
  const sender = {
    tab: { id: 7, url: "https://site.example/watch", title: "Movie Night" },
    frameId: 2,
    documentId: "doc-7",
    url: "https://frame.example/player",
  };
  const domMessage = {
    type: "content-media",
    item: { url: mediaUrl, kind: "direct", name: "movie.mp4", source: "dom" },
    referrerUrl: sender.url,
    frameOrigin: "https://frame.example",
    snapshot: pageSnapshot(),
  };

  const networkFirst = createHarness();
  await settle();
  emitNetwork(networkFirst, 7, mediaUrl, "video/mp4", "doc-7");
  await eventually(() => networkFirst.captureNetwork.length === 1, "network direct promotion");
  await networkFirst.send(domMessage, sender);
  assert.equal(networkFirst.captureNetwork.length, 1);
  assert.equal(networkFirst.captureDomMedia.length, 0, "matching DOM report must reuse network ownership");

  const domFirst = createHarness();
  await settle();
  await domFirst.send(domMessage, sender);
  assert.equal(domFirst.captureDomMedia.length, 1);
  emitNetwork(domFirst, 7, mediaUrl, "video/mp4", "doc-7");
  await settle();
  await settle();
  assert.equal(domFirst.captureNetwork.length, 0, "matching network report must reuse DOM ownership");

  await domFirst.send(Object.assign({}, domMessage, {
    item: {
      url: mediaUrl + "?edition=other",
      kind: "direct",
      name: "movie.mp4",
      source: "dom",
    },
  }), sender);
  assert.equal(domFirst.captureDomMedia.length, 2, "different media URL remains a distinct row");
});

test("DOM ownership or clear during an in-flight direct probe cannot resurrect a network row", async () => {
  const mediaUrl = "https://cdn.example/movie.mp4";
  const sender = {
    tab: { id: 7, url: "https://site.example/watch", title: "Movie Night" },
    frameId: 2,
    documentId: "doc-7",
    url: "https://frame.example/player",
  };
  const domMessage = {
    type: "content-media",
    item: { url: mediaUrl, kind: "direct", name: "movie.mp4", source: "dom" },
    referrerUrl: sender.url,
    frameOrigin: "https://frame.example",
    snapshot: pageSnapshot(),
  };

  const domWins = createHarness();
  await settle();
  const domRace = domWins.holdDirectProbe(mediaUrl);
  emitNetwork(domWins, 7, mediaUrl, "video/mp4", "doc-7");
  await domRace.started;
  await domWins.send(domMessage, sender);
  assert.equal(domWins.captureDomMedia.length, 1);
  domRace.release();
  await settle();
  await settle();
  assert.equal(domWins.captureNetwork.length, 0, "late probe cannot overwrite the DOM winner");

  const cleared = createHarness();
  await settle();
  const clearRace = cleared.holdDirectProbe(mediaUrl);
  emitNetwork(cleared, 7, mediaUrl, "video/mp4", "doc-7");
  await clearRace.started;
  await cleared.send({ type: "clear", tabId: 7 });
  clearRace.release();
  await settle();
  await settle();
  assert.equal(cleared.captureNetwork.length, 0, "cleared in-flight evidence stays cleared");
});

test("promotes only static non-DRM HLS and DASH and binds private quality sources", async () => {
  const h = createHarness();
  await settle();

  const hlsMaster = "https://stream.example/master.m3u8";
  const hlsTop = "https://stream.example/1080.m3u8";
  const hlsLow = "https://stream.example/720.m3u8";
  const liveHls = "https://stream.example/live.m3u8";
  const drmHls = "https://stream.example/drm.m3u8";
  const dashStatic = "https://dash.example/static.mpd";
  const dashDynamic = "https://dash.example/live.mpd";
  const dashDrm = "https://dash.example/drm.mpd";

  h.textBodies.set(hlsMaster, [
    "#EXTM3U",
    "#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS=\"avc1.640028\"",
    "1080.m3u8",
    "#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS=\"avc1.4d401f\"",
    "720.m3u8",
  ].join("\n"));
  h.textBodies.set(hlsTop, "#EXTM3U\n#EXTINF:4,\nseg1.ts\n#EXT-X-ENDLIST");
  h.textBodies.set(liveHls, "#EXTM3U\n#EXTINF:4,\nlive1.ts");
  h.textBodies.set(drmHls, "#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"key.bin\"\n#EXTINF:4,\ndrm1.ts\n#EXT-X-ENDLIST");
  h.textBodies.set(dashStatic, "static");
  h.textBodies.set(dashDynamic, "dynamic");
  h.textBodies.set(dashDrm, "drm");

  h.dashParsed.set(dashStatic, {
    variants: [{ id: "v1080", label: "1920x1080", height: 1080, bandwidth: 5000000 }],
    video: [{ id: "v1080", width: 1920, height: 1080, bandwidth: 5000000, mimeType: "video/mp4" }],
    audio: [{ id: "a1" }], isDynamic: false, drm: false, duration: 60,
  });
  h.dashParsed.set(dashDynamic, {
    variants: [{ id: "v-live", label: "720p", height: 720, bandwidth: 1000000 }],
    video: [{ id: "v-live", width: 1280, height: 720, bandwidth: 1000000, mimeType: "video/mp4" }],
    audio: [], isDynamic: true, drm: false, duration: 0,
  });
  h.dashParsed.set(dashDrm, {
    variants: [{ id: "v-drm", label: "720p", height: 720, bandwidth: 1000000 }],
    video: [{ id: "v-drm", width: 1280, height: 720, bandwidth: 1000000, mimeType: "video/mp4" }],
    audio: [], isDynamic: false, drm: true, duration: 60,
  });

  emitNetwork(h, 20, hlsMaster, "application/vnd.apple.mpegurl", null);
  emitNetwork(h, 21, liveHls, "application/vnd.apple.mpegurl", null);
  emitNetwork(h, 22, drmHls, "application/vnd.apple.mpegurl", null);
  emitNetwork(h, 23, dashStatic, "application/dash+xml", null);
  emitNetwork(h, 24, dashDynamic, "application/dash+xml", null);
  emitNetwork(h, 25, dashDrm, "application/dash+xml", null);

  await eventually(() => h.captureNetwork.length === 2, "static HLS and DASH promotions");
  assert.deepEqual(h.captureNetwork.map((input) => input.details.url).sort(), [dashStatic, hlsMaster].sort());
  assert.equal(h.captureNetwork.some((input) => [liveHls, drmHls, dashDynamic, dashDrm].includes(input.details.url)), false);

  assert.equal(h.registerVariants.length, 2);
  const hlsRegistration = h.registerVariants.find((call) => call.variants.some((variant) => variant.url === hlsTop));
  assert.deepEqual(hlsRegistration.variants, [
    { url: hlsTop, width: 1920, height: 1080, bandwidth: 5000000, label: "1920x1080 · 5000 kbps" },
    { url: hlsLow, width: 1280, height: 720, bandwidth: 2500000, label: "1280x720 · 2500 kbps" },
  ]);
  const dashRegistration = h.registerVariants.find((call) => call.variants.some((variant) => variant.url === dashStatic));
  assert.deepEqual(dashRegistration.variants, [{
    url: dashStatic, label: "1920x1080 · 5000 kbps", width: 1920, height: 1080,
    bandwidth: 5000000, mime: "video/mp4",
  }]);

  const liveRows = await h.send({ type: "get-media", tabId: 21 });
  assert.equal(liveRows.items.some((item) => item.url === liveHls && item.isLive === true), true);
  const drmRows = await h.send({ type: "get-media", tabId: 22 });
  assert.equal(drmRows.items.some((item) => item.url === drmHls && item.drm === true), true);
  const dynamicRows = await h.send({ type: "get-media", tabId: 24 });
  assert.equal(dynamicRows.items.some((item) => item.url === dashDynamic && item.isDynamic === true), true);
  const dashDrmRows = await h.send({ type: "get-media", tabId: 25 });
  assert.equal(dashDrmRows.items.some((item) => item.url === dashDrm && item.drm === true), true);

  h.popupRows.set(99, Object.freeze([Object.freeze({
    id: "media:opaque:3", proposedFilename: "Controller.mp4", kind: "direct", variants: Object.freeze([]),
  })]));
  // A snapshot-bound DOM capture marks a tab even when no legacy item exists.
  await h.send({
    type: "content-media",
    item: { url: "https://cdn.example/controller-only.mp4", kind: "direct" },
    snapshot: Object.assign({}, pageSnapshot(), { tabId: 99, frameId: 0, documentId: "doc-99" }),
    referrerUrl: "https://site.example/watch-99",
    frameOrigin: "https://site.example",
  }, { tab: { id: 99, url: "https://site.example/watch-99" }, frameId: 0, documentId: "doc-99" });
  const allTabs = await h.send({ type: "get-media", tabId: 20, allTabs: true });
  assert.equal(allTabs.items.some((item) => item.id === "media:opaque:3" && item.tabId === 99), true);
});

test("clear then tab reuse publishes only newly captured controller rows", async () => {
  const h = createHarness();
  await settle();
  const tabId = 61;
  const sender = {
    tab: { id: tabId, url: "https://site.example/first" },
    frameId: 0,
    documentId: "doc-first",
  };
  const firstSnapshot = Object.assign({}, pageSnapshot(), {
    tabId,
    frameId: 0,
    documentId: "doc-first",
    pageUrl: "https://site.example/first",
    topLevelPageUrl: "https://site.example/first",
  });

  await h.send({
    type: "content-media",
    item: { url: "https://cdn.example/first.mp4", kind: "direct" },
    snapshot: firstSnapshot,
    referrerUrl: firstSnapshot.pageUrl,
    frameOrigin: "https://site.example",
  }, sender);
  const oldRow = Object.freeze({
    id: "media:opaque:1",
    proposedFilename: "First.mp4",
    kind: "direct",
    variants: Object.freeze([]),
  });
  h.popupRows.set(tabId, Object.freeze([oldRow]));
  let result = await h.send({ type: "get-media", tabId });
  assert.deepEqual(result.items.map((item) => item.id), ["media:opaque:1"]);

  await h.send({ type: "clear", tabId });
  result = await h.send({ type: "get-media", tabId });
  assert.deepEqual(result.items, [], "cleared controller rows stay hidden");

  sender.tab.url = "https://site.example/second";
  sender.documentId = "doc-second";
  const secondSnapshot = Object.assign({}, firstSnapshot, {
    documentId: "doc-second",
    pageUrl: "https://site.example/second",
    topLevelPageUrl: "https://site.example/second",
  });
  await h.send({
    type: "content-media",
    item: { url: "https://cdn.example/second.mp4", kind: "direct" },
    snapshot: secondSnapshot,
    referrerUrl: secondSnapshot.pageUrl,
    frameOrigin: "https://site.example",
  }, sender);
  const newRow = Object.freeze({
    id: "media:opaque:2",
    proposedFilename: "Second.mp4",
    kind: "direct",
    variants: Object.freeze([]),
  });
  // The controller intentionally retains its session rows. Background ownership
  // must prevent the old one from resurfacing when this tab ID is reused.
  h.popupRows.set(tabId, Object.freeze([oldRow, newRow]));
  result = await h.send({ type: "get-media", tabId });
  assert.deepEqual(result.items.map((item) => item.id), ["media:opaque:2"]);
});

// ---------------------------------------------------------------------------
// Size metadata rides the already-owned opaque row (Task 2)
// ---------------------------------------------------------------------------

function sizedSender(tabId) {
  return {
    tab: { id: tabId, url: "https://site.example/watch", title: "Movie Night" },
    frameId: 2,
    documentId: "doc-7",
    url: "https://frame.example/player",
  };
}

test("DOM-first direct media receives late exact network size without a second row", async () => {
  const h = createHarness();
  await settle();
  const mediaUrl = "https://cdn.example/movie.mp4?token=SIGNED_SENTINEL";
  const sender = sizedSender(7);

  await h.send({
    type: "content-media",
    item: { kind: "direct", url: mediaUrl, ts: 1 },
    referrerUrl: sender.url,
    frameOrigin: "https://frame.example",
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

test("a later frame's DOM claim never repoints the owner of an already-owned source", async () => {
  const h = createHarness();
  await settle();
  const mediaUrl = "https://cdn.example/movie.mp4?token=SIGNED_SENTINEL";
  const tabId = 7;
  const frameSender = (frameId, documentId, frameUrl) => ({
    tab: { id: tabId, url: "https://site.example/watch", title: "Movie Night" },
    frameId,
    documentId,
    url: frameUrl,
  });
  const report = (sender, origin) => ({
    type: "content-media",
    item: { kind: "direct", url: mediaUrl, ts: 1 },
    referrerUrl: sender.url,
    frameOrigin: origin,
    snapshot: Object.assign({}, pageSnapshot(), {
      frameId: sender.frameId,
      documentId: sender.documentId,
      pageUrl: sender.url,
    }),
  });

  // The honest top frame reports and claims the file first.
  const topFrame = frameSender(0, "doc-top", "https://site.example/watch");
  await h.send(report(topFrame, "https://site.example"), topFrame);
  // A second later an ad iframe sets the same src. Its frameId has no claim on
  // the source, so it still mints its own detection — that part is by design.
  const adFrame = frameSender(9, "doc-ad", "https://ads.example/unit");
  await h.send(report(adFrame, "https://ads.example"), adFrame);
  assert.equal(h.captureDomMedia.length, 2, "the ad frame still gets its own detection");

  h.headersReceived.emit({
    tabId,
    frameId: 0,
    documentId: "doc-top",
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

  // Enrichment follows ownership, so the exact Content-Range total must land on
  // the first claimant. Before this was pinned the ad's later claim repointed
  // the owner map and took the exact total, leaving the honest row estimating.
  const response = await h.send({ type: "get-media", tabId });
  const sized = response.items.filter((row) => row.sizeBytes !== undefined);
  assert.deepEqual(sized.map((row) => row.id), ["media:opaque:1"]);
  assert.equal(sized[0].sizeConfidence, "exact");
  assert.equal(JSON.stringify(response).includes("SIGNED_SENTINEL"), false);
});

function remountHarness() {
  const tabId = 7;
  const mediaUrl = "https://cdn.example/movie.mp4?token=SIGNED_SENTINEL";
  const frameSender = (frameId, documentId, frameUrl) => ({
    tab: { id: tabId, url: "https://site.example/watch", title: "Movie Night" },
    frameId,
    documentId,
    url: frameUrl,
  });
  const report = (sender, origin) => ({
    type: "content-media",
    item: { kind: "direct", url: mediaUrl, ts: 1 },
    referrerUrl: sender.url,
    frameOrigin: origin,
    snapshot: Object.assign({}, pageSnapshot(), {
      frameId: sender.frameId,
      documentId: sender.documentId,
      pageUrl: sender.url,
    }),
  });
  return { tabId, mediaUrl, frameSender, report };
}

test("an SPA remounting its player iframe lists the clip once, not twice", async () => {
  const h = createHarness();
  await settle();
  const { tabId, frameSender, report } = remountHarness();

  // A remount is a new BrowsingContext: new frameId, empty boundUrls, so the
  // player reports the file it already reported and mints a second detection.
  const firstMount = frameSender(2, "doc-mount-1", "https://site.example/player");
  await h.send(report(firstMount, "https://site.example"), firstMount);
  const secondMount = frameSender(5, "doc-mount-2", "https://site.example/player");
  await h.send(report(secondMount, "https://site.example"), secondMount);
  assert.equal(h.captureDomMedia.length, 2, "each mount still mints its own detection");

  const response = await h.send({ type: "get-media", tabId });
  const direct = response.items.filter((row) => row.kind === "direct");
  assert.deepEqual(
    direct.map((row) => row.id),
    ["media:opaque:1"],
    "two rows with nothing to tell them apart are one clip"
  );
});

test("a frame proposing its own name for the page's file keeps its own row", async () => {
  const h = createHarness();
  await settle();
  const { tabId, frameSender, report } = remountHarness();
  // The fold must not become the suppression per-frame claim scoping prevents:
  // an ad iframe naming the honest page's file differently stays visible.
  h.popupRows.set(tabId, [
    { id: "media:opaque:1", proposedFilename: "Movie Night.mp4", kind: "direct", variants: [] },
    { id: "media:opaque:2", proposedFilename: "Free-iPhone.mp4", kind: "direct", variants: [] },
  ]);

  const topFrame = frameSender(0, "doc-top", "https://site.example/watch");
  await h.send(report(topFrame, "https://site.example"), topFrame);
  const adFrame = frameSender(9, "doc-ad", "https://ads.example/unit");
  await h.send(report(adFrame, "https://ads.example"), adFrame);

  const response = await h.send({ type: "get-media", tabId });
  const direct = response.items.filter((row) => row.kind === "direct");
  assert.deepEqual(direct.map((row) => row.id), ["media:opaque:1", "media:opaque:2"]);
  assert.deepEqual(
    direct.map((row) => row.proposedFilename),
    ["Movie Night.mp4", "Free-iPhone.mp4"]
  );
});

test("network-first direct media keeps one row and publishes the probe Content-Range total", async () => {
  const h = createHarness();
  await settle();
  const mediaUrl = "https://cdn.example/movie.mp4";
  const sender = sizedSender(7);

  emitNetwork(h, 7, mediaUrl, "video/mp4", "doc-7");
  await eventually(() => h.captureNetwork.length === 1, "network direct promotion");

  await h.send({
    type: "content-media",
    item: { kind: "direct", url: mediaUrl, ts: 1 },
    referrerUrl: sender.url,
    frameOrigin: "https://frame.example",
    snapshot: pageSnapshot(),
  }, sender);

  const response = await h.send({ type: "get-media", tabId: 7 });
  const direct = response.items.filter((row) => row.kind === "direct");
  assert.equal(direct.length, 1, "matching DOM report must not add a second row");
  assert.equal(h.captureDomMedia.length, 0);
  // The harness probe answers "bytes 0-7/10485760" — the total, never the chunk.
  assert.equal(direct[0].sizeBytes, 10485760);
  assert.equal(direct[0].sizeConfidence, "exact");
});

test("a 206 chunk Content-Length is never published as the resource total", async () => {
  const h = createHarness();
  await settle();
  const mediaUrl = "https://cdn.example/chunked.mp4";
  await h.send({
    type: "content-media",
    item: { kind: "direct", url: mediaUrl, ts: 1 },
    referrerUrl: "https://site.example/watch",
    frameOrigin: "https://frame.example",
    snapshot: pageSnapshot(),
  }, sizedSender(7));

  h.headersReceived.emit({
    tabId: 7, frameId: 0, documentId: "doc-7",
    documentUrl: "https://site.example/watch", originUrl: "https://site.example/watch",
    url: mediaUrl,
    statusCode: 206,
    responseHeaders: [
      { name: "Content-Type", value: "video/mp4" },
      { name: "Content-Length", value: "262144" },
    ],
  });
  await settle();
  await settle();

  const response = await h.send({ type: "get-media", tabId: 7 });
  const direct = response.items.filter((row) => row.kind === "direct");
  assert.equal(direct.length, 1);
  assert.equal(direct[0].sizeBytes, undefined, "chunk length must not become a total");
  assert.equal(direct[0].sizeConfidence, undefined);
});

test("exact evidence replaces an estimate and a later estimate cannot downgrade it", async () => {
  const h = createHarness();
  await settle();
  const mediaUrl = "https://cdn.example/movie.mp4?token=A";
  await h.send({
    type: "content-media",
    item: { kind: "direct", url: mediaUrl, ts: 1 },
    referrerUrl: "https://site.example/watch",
    frameOrigin: "https://frame.example",
    snapshot: pageSnapshot(),
  }, sizedSender(7));

  const emitTotal = (total) => h.headersReceived.emit({
    tabId: 7, frameId: 0, documentId: "doc-7",
    documentUrl: "https://site.example/watch", originUrl: "https://site.example/watch",
    url: mediaUrl,
    statusCode: 206,
    responseHeaders: [
      { name: "Content-Type", value: "video/mp4" },
      { name: "Content-Range", value: "bytes 0-9/" + total },
    ],
  });

  emitTotal(1395864371);
  await settle();
  await settle();
  let response = await h.send({ type: "get-media", tabId: 7 });
  let direct = response.items.filter((row) => row.kind === "direct");
  assert.equal(direct[0].sizeBytes, 1395864371);
  assert.equal(direct[0].sizeConfidence, "exact");

  // Fresh exact transport evidence for the same source may correct the total.
  emitTotal(1400000000);
  await settle();
  await settle();
  response = await h.send({ type: "get-media", tabId: 7 });
  direct = response.items.filter((row) => row.kind === "direct");
  assert.equal(direct[0].sizeBytes, 1400000000);
  assert.equal(direct[0].sizeConfidence, "exact", "exact never degrades to estimated");
});

test("clear then URL reuse never inherits the previous row's size", async () => {
  const h = createHarness();
  await settle();
  const tabId = 7;
  const mediaUrl = "https://cdn.example/reused.mp4";
  const send = () => h.send({
    type: "content-media",
    item: { kind: "direct", url: mediaUrl, ts: 1 },
    referrerUrl: "https://site.example/watch",
    frameOrigin: "https://frame.example",
    snapshot: pageSnapshot(),
  }, sizedSender(tabId));

  await send();
  h.headersReceived.emit({
    tabId, frameId: 0, documentId: "doc-7",
    documentUrl: "https://site.example/watch", originUrl: "https://site.example/watch",
    url: mediaUrl,
    statusCode: 206,
    responseHeaders: [
      { name: "Content-Type", value: "video/mp4" },
      { name: "Content-Range", value: "bytes 0-9/999999" },
    ],
  });
  await settle();
  await settle();
  let response = await h.send({ type: "get-media", tabId });
  assert.equal(response.items.filter((row) => row.kind === "direct")[0].sizeBytes, 999999);

  await h.send({ type: "clear", tabId });
  await send();
  response = await h.send({ type: "get-media", tabId });
  const direct = response.items.filter((row) => row.kind === "direct");
  assert.equal(direct.length, 1);
  assert.equal(direct[0].sizeBytes, undefined, "a reused URL must not inherit a stale size");
});

test("a subframe DOM claim never suppresses another frame's report of the same file", async () => {
  const mediaUrl = "https://cdn.example/movie.mp4";
  const tabId = 7;
  const frameSender = (frameId, documentId, frameUrl) => ({
    tab: { id: tabId, url: "https://site.example/watch", title: "Movie Night" },
    frameId,
    documentId,
    url: frameUrl,
  });
  const domReport = (sender, name, origin) => ({
    type: "content-media",
    item: { url: mediaUrl, kind: "direct", name, source: "dom" },
    referrerUrl: sender.url,
    frameOrigin: origin,
    snapshot: Object.assign({}, pageSnapshot(), {
      frameId: sender.frameId,
      documentId: sender.documentId,
      pageUrl: sender.url,
      candidates: [{ kind: "visible-filename", value: name }],
    }),
  });

  const h = createHarness();
  await settle();

  // content_scripts runs in all_frames, so a third-party ad iframe can report
  // the honest page's media URL first and claim the row's name.
  const adFrame = frameSender(9, "doc-ad", "https://ads.example/unit");
  await h.send(domReport(adFrame, "Free-iPhone.mp4", "https://ads.example"), adFrame);
  assert.equal(h.captureDomMedia.length, 1);

  const topFrame = frameSender(0, "doc-top", "https://site.example/watch");
  await h.send(domReport(topFrame, "Movie Night.mp4", "https://site.example"), topFrame);
  assert.equal(
    h.captureDomMedia.length,
    2,
    "the honest frame must get its own detection, named from its own snapshot"
  );
  assert.equal(h.captureDomMedia[1].frameOrigin, "https://site.example");
  assert.equal(h.captureDomMedia[1].snapshot.frameId, 0);

  // A frame that repeats its own report still gets exactly one detection.
  await h.send(domReport(topFrame, "Movie Night.mp4", "https://site.example"), topFrame);
  await h.send(domReport(adFrame, "Free-iPhone.mp4", "https://ads.example"), adFrame);
  assert.equal(h.captureDomMedia.length, 2, "same-frame repeats stay deduplicated");
});

test("a network claim is reused by a DOM report from any frame", async () => {
  const mediaUrl = "https://cdn.example/movie.mp4";
  const h = createHarness();
  await settle();
  emitNetwork(h, 7, mediaUrl, "video/mp4", "doc-7");
  await eventually(() => h.captureNetwork.length === 1, "network direct promotion");

  for (const frameId of [0, 2, 9]) {
    const sender = {
      tab: { id: 7, url: "https://site.example/watch" },
      frameId,
      documentId: "doc-" + frameId,
      url: "https://frame.example/player",
    };
    await h.send({
      type: "content-media",
      item: { url: mediaUrl, kind: "direct", name: "movie.mp4", source: "dom" },
      referrerUrl: sender.url,
      frameOrigin: "https://frame.example",
      snapshot: Object.assign({}, pageSnapshot(), { frameId }),
    }, sender);
  }
  assert.equal(h.captureDomMedia.length, 0, "the network lane owns the file for every frame");
  assert.equal(h.captureNetwork.length, 1);
});

test("content-thumb is accepted only from the top frame", async () => {
  const h = createHarness();
  await settle();
  const tabId = 7;
  const frameSender = (frameId, documentId, frameUrl) => ({
    tab: { id: tabId, url: "https://site.example/watch" },
    frameId,
    documentId,
    url: frameUrl,
  });
  const topFrame = frameSender(0, "doc-top", "https://site.example/watch");
  const adFrame = frameSender(9, "doc-ad", "https://ads.example/unit");

  await h.send({
    type: "content-media",
    item: { url: "https://cdn.example/movie.mp4", kind: "direct" },
    referrerUrl: topFrame.url,
    frameOrigin: "https://site.example",
    snapshot: Object.assign({}, pageSnapshot(), { frameId: 0, documentId: "doc-top" }),
  }, topFrame);

  // One thumbnail is attached to every row of the tab, so a subframe that can
  // set it picks the picture the user sees for the top page's media.
  const adThumb = "data:image/jpeg;base64,QUQ=";
  await h.send({ type: "content-thumb", dataUrl: adThumb }, adFrame);
  let result = await h.send({ type: "get-media", tabId });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].thumb, null, "a subframe must not set the tab thumbnail");

  const topThumb = "data:image/jpeg;base64,VE9Q";
  await h.send({ type: "content-thumb", dataUrl: topThumb }, topFrame);
  result = await h.send({ type: "get-media", tabId });
  assert.equal(result.items[0].thumb, topThumb);

  // A later subframe thumb must not overwrite the top frame's.
  await h.send({ type: "content-thumb", dataUrl: adThumb }, adFrame);
  result = await h.send({ type: "get-media", tabId });
  assert.equal(result.items[0].thumb, topThumb);
});

test("the diagnostics ring never keeps a URL's userinfo, query or fragment", async () => {
  const h = createHarness();
  await settle();
  // Every producer — mclog for extension lines, the host/guardian "log" relay
  // for helper output — funnels through pushLog, which is what persists the
  // ring to storage.local and streams it to the Settings console.
  //
  // First, the line shape the shipped host actually emits: it redacts at its
  // own seam, so what arrives here has already lost its signed query and
  // keeps only the identity parameter. This is the case the extension's
  // allowlist decides — without it the second pass would take ?v=abc back off
  // every real host line, and a test that feeds the ring a raw signed query
  // exercises a shape no host produces.
  const asHostEmits =
    "yt-dlp: ERROR https://site.example/watch?v=abc -> https://cdn.example/a/b.mp4";
  h.nativePort.onMessage.emit({ type: "log", level: "warn", src: "host", msg: asHostEmits });
  await settle();
  let lines = h.broadcasts.filter((m) => m.type === "log-line");
  assert.equal(lines.length >= 1, true);
  assert.equal(lines[lines.length - 1].line.msg, asHostEmits);

  // Second, a line no host redacted. The helper updates independently of the
  // extension, so an older installed host still emits its query whole, and
  // extension-side mclog lines are never redacted at their source.
  h.nativePort.onMessage.emit({
    type: "log",
    level: "warn",
    src: "host",
    msg: "yt-dlp: ERROR https://site.example/watch?v=abc&token=SECRET_TOKEN " +
      "-> https://cdn.example/a/b.mp4?Signature=SECRET_SIG#t=10",
  });
  await settle();

  lines = h.broadcasts.filter((m) => m.type === "log-line");
  assert.equal(lines.length >= 2, true);
  const line = lines[lines.length - 1];
  assert.equal(line.line.src, "host");
  assert.equal(line.line.level, "warn");
  // ?v=abc survives: it says which video the line is about, and it is short
  // enough and plain enough for the identity allowlist to keep. The signed
  // query around it does not.
  assert.equal(line.line.msg, asHostEmits);
  assert.equal(JSON.stringify(h.broadcasts).includes("SECRET_TOKEN"), false);
  assert.equal(JSON.stringify(h.broadcasts).includes("SECRET_SIG"), false);
});

test("an update event's detail is redacted before it is persisted or copied", async () => {
  const h = createHarness();
  await settle();
  // get-update-report asks the helper for a fresh report; answer it inline so
  // the handler resolves and the copied payload can be inspected whole.
  h.nativePort.postMessage = (message) => {
    if (message && message.cmd === "getReport") {
      h.nativePort.onMessage.emit({ type: "report", reqId: message.reqId, ok: true });
    }
  };

  // Every updates.py detail is a literal English string today. Nothing catches
  // the first one that is not, because recordEvent skipped the projection
  // pushLog applies while _persistDiag writes mcEvents beside mcLogs.
  h.nativePort.onMessage.emit({
    type: "update-event",
    event: {
      ts: 1,
      kind: "update-failed",
      detail: "download failed: https://cdn.example/mc.zip?Signature=SECRET_EVENT_SIG#f",
    },
  });
  await settle();

  const report = await h.send({ type: "get-update-report" });
  assert.equal(
    report.events[report.events.length - 1].detail,
    "download failed: https://cdn.example/mc.zip"
  );
  McPrivacy.assertNoSentinels(JSON.stringify(report), ["SECRET_EVENT_SIG"]);
  McPrivacy.assertNoSentinels(JSON.stringify(h.broadcasts), ["SECRET_EVENT_SIG"]);
});

test("events restored from storage are redacted before they can be read back", async () => {
  const h = createHarness({
    mcEvents: [{
      ts: 1,
      kind: "update-failed",
      detail: "download failed: https://cdn.example/mc.zip?Signature=SECRET_EVENT_SIG",
    }],
  });
  await settle();
  h.nativePort.postMessage = (message) => {
    if (message && message.cmd === "getReport") {
      h.nativePort.onMessage.emit({ type: "report", reqId: message.reqId, ok: true });
    }
  };
  const report = await h.send({ type: "get-update-report" });
  assert.equal(report.events[0].detail, "download failed: https://cdn.example/mc.zip");
  McPrivacy.assertNoSentinels(JSON.stringify(report), ["SECRET_EVENT_SIG"]);
});

test("a ring restored from storage is redacted before it can be read back", async () => {
  const h = createHarness({
    mcLogs: [{
      ts: 1,
      level: "info",
      src: "ext",
      msg: "yt-dlp: requested https://site.example/watch?v=abc&token=SECRET_TOKEN",
    }],
  });
  await settle();
  const logs = await h.send({ type: "get-logs" });
  // Restored lines precede the lines this session pushed during startup.
  assert.equal(
    logs.logs[0].msg,
    "yt-dlp: requested https://site.example/watch?v=abc"
  );
  assert.equal(JSON.stringify(logs).includes("SECRET_TOKEN"), false);
});

// A ready helper is what routes a recording to ffmpeg instead of the in-browser
// recorder, and a captured record command is what the host would act on.
async function readyHelper(h) {
  h.nativePort.onMessage.emit({ type: "pong", ffmpeg: true });
  const posts = [];
  h.nativePort.postMessage = (message) => { posts.push(clone(message)); };
  await settle();
  return posts;
}

function liveMaster(variantUri) {
  return [
    "#EXTM3U",
    "#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720",
    variantUri,
    "",
  ].join("\n");
}

test("the record lane refuses a stream URL the helper must not open", async () => {
  const h = createHarness();
  await settle();
  const posts = await readyHelper(h);

  // This lane's URL comes from the body of a fetched manifest, not from
  // webRequest or a gated content script, and an absolute URI in a playlist
  // resolves to itself. ffmpeg opens file://host/share as a UNC path, so the
  // recording would be an outbound SMB handshake carrying the user's
  // credentials to whoever served the playlist.
  const master = "https://site.example/live/master.m3u8";
  h.textBodies.set(master, liveMaster("file://attacker.test/s/x"));

  assert.deepEqual(await h.send({
    type: "record-live",
    item: { kind: "hls", url: master, name: "master.m3u8" },
    tabId: 7,
    filename: "Live",
  }), { ok: true });

  // Refusing silently would leave a row that never records and never says why,
  // so the refusal has to be the visible failure of that row.
  await eventually(
    () => h.broadcasts.some((m) => m.type === "download-update" && m.download.status === "error"),
    "the refused recording never surfaced as a failed row"
  );
  const updates = h.broadcasts.filter((m) => m.type === "download-update");
  const failed = updates[updates.length - 1];
  assert.equal(failed.download.status, "error");
  assert.equal(typeof failed.download.error, "string");
  assert.equal(failed.download.error.length > 0, true);
  assert.equal(posts.some((m) => m && m.cmd === "record"), false, "nothing reached the helper");
  assert.equal(JSON.stringify(posts).includes("attacker.test"), false);
});

test("the record lane sends no page header the host would have to sanitise", async () => {
  const h = createHarness();
  await settle();
  const posts = await readyHelper(h);

  // Page context is captured from the tab's own requests and handed to ffmpeg
  // as -headers, where a control character is a header-injection primitive.
  // The host gates it too; a value that would fail there should never be sent.
  h.requestHeaders.emit({
    tabId: 7,
    requestHeaders: [
      { name: "Referer", value: "https://site.example/watch\r\nX-Injected: SECRET_HEADER" },
      { name: "User-Agent", value: "Detection Browser" },
    ],
  });

  const master = "https://site.example/live/master.m3u8";
  h.textBodies.set(master, liveMaster("https://site.example/live/hi.m3u8"));
  assert.deepEqual(await h.send({
    type: "record-live",
    item: { kind: "hls", url: master, name: "master.m3u8" },
    tabId: 7,
    filename: "Live",
  }), { ok: true });

  await eventually(
    () => posts.some((m) => m && m.cmd === "record"),
    "the http(s) recording never reached the helper"
  );
  const record = posts.find((m) => m.cmd === "record");
  assert.equal(record.videoUrl, "https://site.example/live/hi.m3u8");
  assert.equal(record.audioUrl, null);
  assert.equal(record.referer, "", "an unsendable Referer is dropped, not passed on");
  assert.equal(record.userAgent, "Detection Browser");
  assert.equal(JSON.stringify(posts).includes("SECRET_HEADER"), false);
});
