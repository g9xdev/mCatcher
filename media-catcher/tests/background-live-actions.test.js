"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadLib, mediaCatcherRoot } = require("./harness/load-lib.js");

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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createHarness() {
  const runtimeMessages = event();
  const calls = { enqueue: [], enqueueAttempts: [], retry: [], cancel: [], firefox: [], setMax: [] };
  const browserDownloads = [];
  const fetches = [];
  const storedSettings = [];
  const knownMedia = new Set(["media:opaque:hls", "media:opaque:dash"]);
  const knownJobs = new Set(["job:opaque:1", "job:opaque:2"]);

  function requirePopup(sender) {
    if (!sender || sender.id !== "media-catcher@test" ||
        sender.url !== "moz-extension://media-catcher/popup/popup.html") {
      throw new Error("SECRET_NON_POPUP_REJECTION");
    }
  }

  const controller = {
    popupMedia() { return Object.freeze([]); },
    popupJobs() { return Object.freeze([]); },
    acceptPageSnapshot() {},
    captureDomMedia() { return "media:unused"; },
    async handleNativeMessage() { return false; },
    helperDisconnected() {},
    enqueueDownload(message, sender) {
      requirePopup(sender);
      const id = message && message.item && message.item.id;
      calls.enqueueAttempts.push(id);
      if (!knownMedia.has(id)) throw new Error("SECRET_FORGED_MEDIA");
      calls.enqueue.push({ message: clone(message), sender: clone(sender) });
      const job = Object.freeze({ id: id.endsWith("hls") ? "job:opaque:1" : "job:opaque:2", state: "queued", mediaId: id });
      return Promise.resolve(job);
    },
    manualRetry(id) {
      calls.retry.push(id);
      return Promise.resolve(knownJobs.has(id) ? Object.freeze({ id, state: "queued", mediaId: "media:opaque:hls" }) : false);
    },
    cancel(id) {
      calls.cancel.push(id);
      return Promise.resolve(knownJobs.has(id) ? Object.freeze({ id, state: "cancelled", mediaId: "media:opaque:hls" }) : false);
    },
    requestFirefoxHandoff(message, sender) {
      requirePopup(sender);
      calls.firefox.push({ message: clone(message), sender: clone(sender) });
      return Promise.resolve(knownJobs.has(message.id) ? Object.freeze({ id: message.id, state: "handed_to_firefox", mediaId: "media:opaque:hls" }) : false);
    },
    setMaxConcurrent(value) {
      calls.setMax.push(value);
      return Promise.resolve();
    },
  };

  const noopEvent = () => event();
  const nativePort = { onMessage: noopEvent(), onDisconnect: noopEvent(), postMessage() {} };
  const browser = {
    storage: { local: {
      get() { return Promise.resolve({ pd4done: true, dq1done: true }); },
      set(value) { if (value && value.settings) storedSettings.push(clone(value.settings)); return Promise.resolve(); },
    } },
    runtime: {
      id: "media-catcher@test", lastError: null, onMessage: runtimeMessages,
      onInstalled: noopEvent(), connectNative() { return nativePort; },
      sendMessage() { return Promise.resolve(); }, getManifest() { return { version: "1.10.0" }; },
      getURL(relative) { return "moz-extension://media-catcher/" + relative; },
    },
    downloads: {
      download(options) { browserDownloads.push(clone(options)); return Promise.resolve(1); },
      search() { return Promise.resolve([]); }, open() {}, show() {},
    },
    tabs: {
      onRemoved: noopEvent(), onUpdated: noopEvent(), query() { return Promise.resolve([]); },
      create() { return Promise.resolve(); }, update() { return Promise.resolve(); }, executeScript() { return Promise.resolve(); },
    },
    webRequest: { onSendHeaders: noopEvent(), onHeadersReceived: noopEvent(), onBeforeSendHeaders: noopEvent() },
    browserAction: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    contextMenus: { onClicked: noopEvent(), removeAll(callback) { if (callback) callback(); }, create() {} },
    notifications: { onClicked: noopEvent(), onClosed: noopEvent(), create() {}, clear() {} },
  };

  const root = {};
  const sandbox = {
    self: root, browser, console: { log() {}, warn() {}, error() {} },
    Promise, Map, Set, WeakMap, Object, Array, ArrayBuffer, Uint8Array,
    TextDecoder, TextEncoder, URL, Blob, Date, Math, JSON, Number, String,
    Boolean, RegExp, Error, TypeError, RangeError, Symbol, Reflect, Proxy,
    AbortController, setTimeout() { return 1; }, clearTimeout() {},
    fetch(url) { fetches.push(String(url)); return Promise.reject(new Error("unexpected legacy fetch")); },
    crypto: { randomUUID() { return "00000000-0000-4000-8000-000000000001"; } },
  };
  vm.createContext(sandbox);

  const manifest = JSON.parse(fs.readFileSync(path.join(mediaCatcherRoot, "manifest.json"), "utf8"));
  for (const relative of manifest.background.scripts) {
    if (relative === "background.js") {
      root.McLiveMediaAssembler = { createLiveMediaAssembler() { return async () => { throw new Error("unused"); }; } };
      root.McBackgroundAdapters = { createBackgroundAdapters() { return controller; } };
    }
    vm.runInContext(fs.readFileSync(path.join(mediaCatcherRoot, relative), "utf8"), sandbox, { filename: relative });
  }

  async function send(message, sender) {
    return new Promise((resolve, reject) => {
      let responded = false;
      const timer = global.setTimeout(() => { if (!responded) reject(new Error("background did not respond")); }, 1000);
      runtimeMessages.emit(message, sender || {}, (response) => {
        responded = true;
        global.clearTimeout(timer);
        resolve(clone(response));
      });
    });
  }

  return {
    send, calls, browserDownloads, fetches, storedSettings,
    popupSender: { id: browser.runtime.id, url: browser.runtime.getURL("popup/popup.html") },
  };
}

test("opaque popup actions route once through the live controller and never use legacy VOD", async () => {
  const h = createHarness();
  await settle();

  const hlsMessage = {
    type: "download", tabId: 7,
    item: { id: "media:opaque:hls", kind: "hls", proposedFilename: "movie.mp4" },
    userActionToken: "action-1",
  };
  assert.deepEqual(await h.send(hlsMessage, h.popupSender), {
    ok: true,
    job: { id: "job:opaque:1", state: "queued", mediaId: "media:opaque:hls" },
  });
  assert.equal(h.calls.enqueue.length, 1);

  assert.deepEqual(await h.send({
    type: "download", tabId: 8,
    item: { id: "media:opaque:dash", kind: "dash", proposedFilename: "show.mp4" },
    userActionToken: "action-2",
  }, h.popupSender), {
    ok: true,
    job: { id: "job:opaque:2", state: "queued", mediaId: "media:opaque:dash" },
  });
  assert.equal(h.calls.enqueue.length, 2);

  assert.deepEqual(await h.send({ type: "retry-download", id: "job:opaque:1" }, h.popupSender), {
    ok: true,
    job: { id: "job:opaque:1", state: "queued", mediaId: "media:opaque:hls" },
  });
  assert.deepEqual(await h.send({ type: "cancel", id: "job:opaque:1" }, h.popupSender), {
    ok: true,
    job: { id: "job:opaque:1", state: "cancelled", mediaId: "media:opaque:hls" },
  });
  const firefox = { type: "use-firefox", id: "job:opaque:1", intent: { userSelectedFirefox: true } };
  assert.deepEqual(await h.send(firefox, h.popupSender), {
    ok: true,
    job: { id: "job:opaque:1", state: "handed_to_firefox", mediaId: "media:opaque:hls" },
  });

  assert.deepEqual(h.calls.retry, ["job:opaque:1"]);
  assert.deepEqual(h.calls.cancel, ["job:opaque:1"]);
  assert.equal(h.calls.firefox.length, 1);
  assert.deepEqual(h.fetches, []);
  assert.deepEqual(h.browserDownloads, []);
});

test("forged and non-popup opaque actions fail closed while numeric legacy cancel stays legacy", async () => {
  const h = createHarness();
  await settle();

  const forged = await h.send({
    type: "download", tabId: 7,
    item: { id: "media:forged", kind: "hls", proposedFilename: "forged.mp4" },
    userActionToken: "action-forged",
  }, h.popupSender);
  assert.equal(forged.ok, false);
  assert.equal(JSON.stringify(forged).includes("SECRET"), false);

  const unprefixedForged = await h.send({
    type: "download", tabId: 7,
    item: { id: "opaque-forged", kind: "direct", proposedFilename: "forged.mp4" },
    userActionToken: "action-forged-2",
  }, h.popupSender);
  assert.equal(unprefixedForged.ok, false);
  assert.equal(JSON.stringify(unprefixedForged).includes("SECRET"), false);
  assert.deepEqual(h.calls.enqueueAttempts, ["media:forged", "opaque-forged"]);

  const hostileItem = { kind: "hls", proposedFilename: "hostile.mp4" };
  Object.defineProperty(hostileItem, "id", {
    enumerable: true,
    get() { throw new Error("SECRET_ITEM_ACCESSOR"); },
  });
  const hostileItemResponse = await h.send({
    type: "download", tabId: 7, item: hostileItem, userActionToken: "hostile-action",
  }, h.popupSender);
  assert.equal(hostileItemResponse.ok, false);
  assert.equal(JSON.stringify(hostileItemResponse).includes("SECRET"), false);
  assert.deepEqual(h.calls.enqueueAttempts, ["media:forged", "opaque-forged"]);

  const nonPopup = await h.send({
    type: "download", tabId: 7,
    item: { id: "media:opaque:hls", kind: "hls", proposedFilename: "movie.mp4" },
    userActionToken: "action-foreign",
  }, { id: "foreign@test", url: "https://attacker.example/" });
  assert.equal(nonPopup.ok, false);
  assert.equal(JSON.stringify(nonPopup).includes("SECRET"), false);

  const cancelCalls = h.calls.cancel.length;
  const nonPopupCancel = await h.send({ type: "cancel", id: "job:opaque:1" }, {
    id: "foreign@test", url: "https://attacker.example/",
  });
  assert.equal(nonPopupCancel.ok, false);
  assert.equal(h.calls.cancel.length, cancelCalls, "non-popup cancel must not reach the controller");

  const hostileSender = { url: h.popupSender.url };
  Object.defineProperty(hostileSender, "id", {
    enumerable: true,
    get() { throw new Error("SECRET_SENDER_ACCESSOR"); },
  });
  const hostile = await h.send({ type: "cancel", id: "job:opaque:1" }, hostileSender);
  assert.equal(hostile.ok, false);
  assert.equal(JSON.stringify(hostile).includes("SECRET"), false);
  assert.equal(h.calls.cancel.length, cancelCalls, "hostile sender must not reach the controller");

  const unknownRetry = await h.send({ type: "retry-download", id: "job:forged" }, h.popupSender);
  assert.equal(unknownRetry.ok, false);

  assert.deepEqual(await h.send({ type: "cancel", id: 42 }, h.popupSender), { ok: true });
  assert.deepEqual(h.calls.cancel, []);
  assert.deepEqual(h.fetches, []);
  assert.deepEqual(h.browserDownloads, []);
});

test("unpromoted static VOD fails visibly without legacy HLS DASH or browser downloads", async () => {
  const h = createHarness();
  await settle();

  const hls = await h.send({
    type: "download", tabId: 7,
    item: { url: "https://stream.example/static.m3u8", kind: "hls", isLive: false, drm: false },
    filename: "static-hls",
  }, h.popupSender);
  const dash = await h.send({
    type: "download", tabId: 8,
    item: { url: "https://stream.example/static.mpd", kind: "dash", isDynamic: false, drm: false },
    filename: "static-dash",
  }, h.popupSender);
  assert.equal(hls.ok, false);
  assert.equal(dash.ok, false);
  assert.match(hls.error, /not ready/i);
  assert.match(dash.error, /not ready/i);
  assert.deepEqual(h.fetches, []);
  assert.deepEqual(h.browserDownloads, []);

  const drmStatic = await h.send({
    type: "download", tabId: 9,
    item: { url: "https://stream.example/drm.m3u8", kind: "hls", isLive: false, drm: true },
    filename: "drm-static",
  }, h.popupSender);
  assert.equal(drmStatic.ok, false);
  assert.deepEqual(h.fetches, []);
});

test("accepted maxConcurrentDownloads changes update the one live controller", async () => {
  const h = createHarness();
  await settle();

  const next = {
    maxConcurrentDownloads: 7,
    concurrency: 9,
    retries: 8,
  };
  const response = await h.send({ type: "set-settings", settings: next }, h.popupSender);
  assert.equal(response.ok, true);
  assert.deepEqual(h.calls.setMax, [7]);
  assert.equal(h.storedSettings.at(-1).maxConcurrentDownloads, 7);

  await h.send({
    type: "set-settings",
    settings: { maxConcurrentDownloads: 7, concurrency: 2, retries: 1 },
  }, h.popupSender);
  assert.deepEqual(h.calls.setMax, [7], "restart-bound settings must not reconfigure the live controller");
});

function makeRealController() {
  let token = 0;
  return loadLib("lib/background-adapters.js").createBackgroundAdapters({
    maxConcurrent: 2,
    segmentConcurrency: 3,
    retries: 2,
    now() { return 1_000_000; },
    randomToken(namespace) { token += 1; return namespace + "-opaque-" + token; },
    postNative() {},
    downloadsDownload() { throw new Error("unexpected Firefox download"); },
    createObjectURL() { throw new Error("unexpected object URL"); },
    revokeObjectURL() {},
    fetchArrayBuffer() { return Promise.resolve(new ArrayBuffer(0)); },
    assembleMedia() { return Promise.resolve(null); },
    isPopupSender() { return true; },
    getEffectiveDestinationDirectory() { return null; },
  });
}

function directDomCapture() {
  return {
    mediaUrl: "https://cdn.example/private.mp4?token=SECRET",
    mediaOrigin: "https://cdn.example",
    contentDisposition: null,
    referrerUrl: "https://site.example/watch",
    frameOrigin: "https://site.example",
    ts: 1_000_000,
    snapshot: {
      documentId: "doc-actions",
      tabId: 7,
      frameId: 0,
      pageUrl: "https://site.example/watch",
      topLevelPageUrl: "https://site.example/watch",
      documentNonce: "nonce-actions",
      candidates: [{ kind: "visible-filename", value: "Movie.mp4" }],
      capturedAt: "1970-01-01T00:16:40.000Z",
    },
    transport: { mediaKind: "direct", requestHeaders: null },
  };
}

test("adapter correlates immediate and popup jobs with only the safe originating mediaId", async () => {
  const controller = makeRealController();
  const mediaId = controller.captureDomMedia(directDomCapture());
  const immediate = await controller.enqueueDownload({
    type: "download", tabId: 7,
    item: { id: mediaId, proposedFilename: "Movie.mp4" },
    userActionToken: "action-correlate",
  }, { id: "popup" });

  assert.equal(immediate.mediaId, mediaId);
  assert.equal(controller.popupJobs()[0].mediaId, mediaId);
  assert.equal(JSON.stringify([immediate, controller.popupJobs()]).includes("https://"), false);
});

test("privacy projects only a safe primitive mediaId", () => {
  const Privacy = loadLib("lib/privacy.js");
  assert.deepEqual(Privacy.projectPopupJob({ id: "job:1", mediaId: "media:opaque:1" }), {
    id: "job:1",
    mediaId: "media:opaque:1",
  });
  const accessor = {};
  Object.defineProperty(accessor, "mediaId", { enumerable: true, get() { throw new Error("SECRET_ACCESSOR"); } });
  assert.deepEqual(Privacy.projectPopupJob({ id: "job:2", mediaId: "https://secret.example/x" }), { id: "job:2" });
  assert.deepEqual(Privacy.projectPopupJob({ id: "job:3", mediaId: 7 }), { id: "job:3" });
  assert.deepEqual(Privacy.projectPopupJob(accessor), {});
});
