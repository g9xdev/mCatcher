"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { mediaCatcherRoot } = require("./harness/load-lib.js");

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

function createHarness() {
  const runtimeMessages = event();
  const headersReceived = event();
  const captureNetwork = [];
  const acceptPageSnapshot = [];
  const captureDomMedia = [];
  const registerVariants = [];
  const broadcasts = [];
  const popupRows = new Map();
  const textBodies = new Map();
  const dashParsed = new Map();
  const controllerJobs = Object.freeze([{ id: "job:opaque:1", state: "queued" }]);
  let mediaSeq = 0;

  const controller = {
    captureNetwork(input) {
      captureNetwork.push(clone(input));
      return "media:opaque:" + (++mediaSeq);
    },
    acceptPageSnapshot(snapshot) { acceptPageSnapshot.push(clone(snapshot)); },
    captureDomMedia(input) {
      captureDomMedia.push(clone(input));
      return "media:opaque:" + (++mediaSeq);
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
    storage: { local: { get() { return Promise.resolve({ pd4done: true, dq1done: true }); }, set() { return Promise.resolve(); } } },
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
      onRemoved: noopEvent(), onUpdated: noopEvent(), query() { return Promise.resolve([]); },
      create() { return Promise.resolve(); }, update() { return Promise.resolve(); }, executeScript() { return Promise.resolve(); },
    },
    webRequest: { onSendHeaders: noopEvent(), onHeadersReceived: headersReceived, onBeforeSendHeaders: noopEvent() },
    browserAction: { setBadgeText() {}, setBadgeBackgroundColor() {} },
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
        const head = new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70]);
        let sent = false;
        return Promise.resolve({
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
        });
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
    send, headersReceived, captureNetwork, acceptPageSnapshot, captureDomMedia,
    registerVariants, broadcasts, popupRows, controllerJobs, textBodies, dashParsed,
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
      url: "https://cdn.example/other/movie.mp4",
      kind: "direct",
      name: "movie.mp4",
      source: "dom",
    },
  }), sender);
  assert.equal(domFirst.captureDomMedia.length, 2, "different media URL remains a distinct row");
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
