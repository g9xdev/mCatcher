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
  const nativePosts = [];
  const browserDownloads = [];
  const fetches = [];
  const storedSettings = [];
  const knownMedia = new Set(["media:opaque:hls", "media:opaque:dash"]);
  const knownJobs = new Set(["job:opaque:1", "job:opaque:2"]);
  const createdWindows = [];
  const focusedWindows = [];
  const windowsRemoved = event();
  let pendingVariants = [];
  let mediaSeq = 0;
  let windowSeq = 0;

  // The real controller receives this predicate from background.js; the fake
  // mirrors it so both extension action surfaces are exercised.
  function requirePopup(sender) {
    const isPopup = sender && sender.id === "media-catcher@test" &&
      sender.url === "moz-extension://media-catcher/popup/popup.html";
    const isSaveAs = sender && sender.id === "media-catcher@test" &&
      typeof sender.url === "string" &&
      sender.url.startsWith("moz-extension://media-catcher/saveas/saveas.html?");
    if (!isPopup && !isSaveAs) throw new Error("SECRET_NON_POPUP_REJECTION");
  }

  const liveRows = new Map();

  const controller = {
    popupMedia(tabId) { return liveRows.get(tabId) || Object.freeze([]); },
    popupJobs() { return Object.freeze([]); },
    acceptPageSnapshot() {},
    captureDomMedia(input) {
      const tabId = input && input.snapshot && input.snapshot.tabId;
      const mediaId = "media:opaque:dom" + (++mediaSeq);
      const rows = (liveRows.get(tabId) || []).slice();
      rows.push(Object.freeze({
        id: mediaId,
        proposedFilename: "11474-makemebi.net.mp4",
        kind: "direct",
        variants: Object.freeze(pendingVariants.slice()),
      }));
      liveRows.set(tabId, Object.freeze(rows));
      knownMedia.add(mediaId);
      return mediaId;
    },
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
  const nativeMessages = event();
  const nativeDisconnect = event();
  const nativePort = {
    onMessage: nativeMessages, onDisconnect: nativeDisconnect,
    postMessage(message) { nativePosts.push(clone(message)); },
  };

  // Controllable timers so picker timeouts are provable without waiting.
  const timers = new Map();
  let timerSeq = 0;
  function fakeSetTimeout(fn, delay) {
    const id = ++timerSeq;
    timers.set(id, { fn, at: Number.isFinite(delay) ? delay : 0 });
    return id;
  }
  function fakeClearTimeout(id) { timers.delete(id); }
  function advanceTimers(ms) {
    for (const [id, entry] of Array.from(timers)) {
      if (entry.at <= ms) {
        timers.delete(id);
        entry.fn();
      }
    }
  }
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
    windows: {
      onRemoved: windowsRemoved,
      create(options) {
        const id = ++windowSeq;
        createdWindows.push({ id, options: clone(options) });
        return Promise.resolve({ id });
      },
      update(id, options) {
        if (!createdWindows.some((entry) => entry.id === id)) {
          return Promise.reject(new Error("no such window"));
        }
        focusedWindows.push({ id, options: clone(options) });
        return Promise.resolve({ id });
      },
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
    AbortController, setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout,
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

  // Claims real background ownership for a tab so the row is publicly visible,
  // exactly as a DOM detection would.
  async function captureMedia(tabId, variants) {
    pendingVariants = variants || [];
    const pageUrl = "https://site.example/watch-" + tabId;
    await send({
      type: "content-media",
      item: { kind: "direct", url: "https://cdn.example/" + tabId + "/movie.mp4", ts: 1 },
      referrerUrl: pageUrl,
      frameOrigin: "https://site.example",
      snapshot: {
        type: "page-snapshot", documentId: "doc-" + tabId, documentNonce: "nonce-" + tabId,
        tabId, frameId: 0, pageUrl, topLevelPageUrl: pageUrl,
        candidates: [{ kind: "visible-filename", value: "11474-makemebi.net.mp4" }],
        capturedAt: "2026-08-13T12:00:00.000Z",
      },
    }, { tab: { id: tabId, url: pageUrl }, frameId: 0, documentId: "doc-" + tabId });
    pendingVariants = [];
    const rows = liveRows.get(tabId) || [];
    return rows[rows.length - 1].id;
  }

  function saveAsSender(query) {
    return {
      id: browser.runtime.id,
      url: browser.runtime.getURL("saveas/saveas.html") + query,
    };
  }

  return {
    send, calls, nativePosts, browserDownloads, fetches, storedSettings,
    captureMedia, saveAsSender, createdWindows, focusedWindows, windowsRemoved,
    nativeMessages, nativeDisconnect, advanceTimers,
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

test("unpromoted direct HLS and DASH fail visibly without any legacy save effect", async () => {
  const h = createHarness();
  await settle();
  const nativeBefore = clone(h.nativePosts);

  const direct = await h.send({
    type: "download", tabId: 6,
    item: { url: "https://cdn.example/private.mp4?token=SECRET", kind: "direct" },
    filename: "private-direct",
  }, h.popupSender);
  const liveHls = await h.send({
    type: "download", tabId: 6,
    item: { url: "https://stream.example/live.m3u8", kind: "hls", isLive: true },
    filename: "live-hls",
  }, h.popupSender);
  const dynamicDash = await h.send({
    type: "download", tabId: 6,
    item: { url: "https://stream.example/live.mpd", kind: "dash", isDynamic: true },
    filename: "dynamic-dash",
  }, h.popupSender);
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
  assert.equal(direct.ok, false);
  assert.equal(liveHls.ok, false);
  assert.equal(dynamicDash.ok, false);
  assert.equal(hls.ok, false);
  assert.equal(dash.ok, false);
  assert.match(direct.error, /not ready|unsupported/i);
  assert.match(liveHls.error, /not ready|unsupported/i);
  assert.match(dynamicDash.error, /not ready|unsupported/i);
  assert.match(hls.error, /not ready/i);
  assert.match(dash.error, /not ready/i);
  assert.deepEqual(h.calls.enqueueAttempts, [], "unpromoted rows must not reach the controller action");
  assert.deepEqual(h.nativePosts, nativeBefore, "unpromoted rows must not post any legacy native save command");
  assert.deepEqual(h.fetches, []);
  assert.deepEqual(h.browserDownloads, []);

  const publicState = await h.send({ type: "get-media", tabId: 6 }, h.popupSender);
  assert.deepEqual(publicState.downloads, [], "unpromoted rows must not create a legacy save job");

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

// ---------------------------------------------------------------------------
// Persistent Save As window authorization (Task 3)
// ---------------------------------------------------------------------------

test("the toolbar popup opens exactly one Save As window per media and refocuses it", async () => {
  const h = createHarness();
  await settle();
  const mediaId = await h.captureMedia(7);

  const first = await h.send({ type: "open-save-as", tabId: 7, mediaId, variantId: null }, h.popupSender);
  assert.deepEqual(first, { ok: true, focused: false });
  assert.equal(h.createdWindows.length, 1);
  assert.equal(h.createdWindows[0].options.type, "popup");

  const url = new URL(h.createdWindows[0].options.url);
  assert.equal(url.pathname.endsWith("/saveas/saveas.html"), true);
  assert.deepEqual(Array.from(url.searchParams.keys()).sort(), ["mediaId", "tabId"]);
  assert.equal(url.searchParams.get("tabId"), "7");
  assert.equal(url.searchParams.get("mediaId"), mediaId);

  const second = await h.send({ type: "open-save-as", tabId: 7, mediaId, variantId: null }, h.popupSender);
  assert.deepEqual(second, { ok: true, focused: true });
  assert.equal(h.createdWindows.length, 1, "a second click must focus, not duplicate");
  assert.deepEqual(h.focusedWindows.at(-1).options, { focused: true });

  // Once closed, a later click may open a fresh window.
  h.windowsRemoved.emit(h.createdWindows[0].id);
  await h.send({ type: "open-save-as", tabId: 7, mediaId, variantId: null }, h.popupSender);
  assert.equal(h.createdWindows.length, 2);
});

test("an owned variant travels in the URL and an unowned one is refused", async () => {
  const h = createHarness();
  await settle();
  const mediaId = await h.captureMedia(8, [{ id: "variant:opaque:1", label: "1080p", height: 1080 }]);

  await h.send({ type: "open-save-as", tabId: 8, mediaId, variantId: "variant:opaque:1" }, h.popupSender);
  const url = new URL(h.createdWindows[0].options.url);
  assert.deepEqual(Array.from(url.searchParams.keys()).sort(), ["mediaId", "tabId", "variantId"]);
  assert.equal(url.searchParams.get("variantId"), "variant:opaque:1");

  const forged = await h.send(
    { type: "open-save-as", tabId: 8, mediaId, variantId: "variant:forged" }, h.popupSender);
  assert.equal(forged.ok, false);
  assert.equal(h.createdWindows.length, 1);
});

test("only the exact toolbar popup may open a Save As window", async () => {
  const h = createHarness();
  await settle();
  const mediaId = await h.captureMedia(9);

  const rejected = [
    [{ type: "open-save-as", tabId: 9, mediaId: "media:forged", variantId: null }, h.popupSender],
    [{ type: "open-save-as", tabId: 4242, mediaId, variantId: null }, h.popupSender],
    [{ type: "open-save-as", tabId: "9", mediaId, variantId: null }, h.popupSender],
    [{ type: "open-save-as", tabId: 9, mediaId: { toString() { return mediaId; } }, variantId: null }, h.popupSender],
    [{ type: "open-save-as", tabId: 9, mediaId, variantId: null }, { id: "media-catcher@test", url: "https://evil.example/page" }],
    [{ type: "open-save-as", tabId: 9, mediaId, variantId: null }, { id: "media-catcher@test", url: "moz-extension://media-catcher/options/options.html" }],
    [{ type: "open-save-as", tabId: 9, mediaId, variantId: null }, { id: "other@addon", url: "moz-extension://media-catcher/popup/popup.html" }],
    [{ type: "open-save-as", tabId: 9, mediaId, variantId: null }, h.saveAsSender("?tabId=9&mediaId=" + mediaId)],
  ];
  for (const [message, sender] of rejected) {
    const response = await h.send(message, sender);
    assert.equal(response.ok, false, "must refuse " + JSON.stringify(message.mediaId));
  }
  assert.equal(h.createdWindows.length, 0);
});

test("get-save-as-context derives identity from the sender URL alone", async () => {
  const h = createHarness();
  await settle();
  const mediaId = await h.captureMedia(11);

  const good = await h.send({ type: "get-save-as-context" },
    h.saveAsSender("?tabId=11&mediaId=" + mediaId));
  assert.equal(good.ok, true);
  assert.deepEqual(Object.keys(good.context).sort(),
    ["kind", "knownExtension", "mediaId", "proposedFilename", "tabId", "variantId"]);
  assert.equal(good.context.mediaId, mediaId);
  assert.equal(good.context.tabId, 11);
  assert.equal(good.context.proposedFilename, "11474-makemebi.net.mp4");
  assert.equal(good.context.variantId, null);

  // Caller-supplied identity is ignored; only the URL counts.
  const spoofed = await h.send(
    { type: "get-save-as-context", tabId: 4242, mediaId: "media:forged" },
    h.saveAsSender("?tabId=11&mediaId=" + mediaId));
  assert.deepEqual(spoofed.context, good.context);

  for (const query of [
    "?tabId=11&mediaId=media:forged",
    "?tabId=4242&mediaId=" + mediaId,
    "?mediaId=" + mediaId,
    "?tabId=11",
    "?tabId=11&mediaId=" + mediaId + "&extra=1",
    "?tabId=11&mediaId=" + mediaId + "&tabId=12",
    "?tabId=-1&mediaId=" + mediaId,
    "?tabId=11&mediaId=" + encodeURIComponent("https://cdn.example/movie.mp4"),
  ]) {
    const response = await h.send({ type: "get-save-as-context" }, h.saveAsSender(query));
    assert.equal(response.ok, false, "must refuse query " + query);
  }
  const wrongPage = await h.send({ type: "get-save-as-context" }, h.popupSender);
  assert.equal(wrongPage.ok, false);
});

test("the Save As context carries no URL, header, cookie, or provider identity", async () => {
  const h = createHarness();
  await settle();
  const mediaId = await h.captureMedia(12);
  const response = await h.send({ type: "get-save-as-context" },
    h.saveAsSender("?tabId=12&mediaId=" + mediaId));
  const json = JSON.stringify(response);
  for (const sentinel of ["http", "cdn.example", "Cookie", "Authorization", "providerKey", "site.example"]) {
    assert.equal(json.includes(sentinel), false, "leaked " + sentinel);
  }
});

test("save-as-download is accepted only from the matching Save As window", async () => {
  const h = createHarness();
  await settle();
  const mediaId = await h.captureMedia(13);
  const sender = h.saveAsSender("?tabId=13&mediaId=" + mediaId);
  const intent = {
    requestedFilename: "edited.mp4", destinationDirectory: "D:\\Videos",
    saveMode: "save-as", userSelectedFirefox: false,
    userActionToken: "tok", createdAt: "2026-08-13T12:00:00.000Z",
  };
  const message = { type: "save-as-download", tabId: 13, item: { id: mediaId }, variantId: null, intent };

  const ok = await h.send(message, sender);
  assert.equal(ok.ok, true);
  assert.equal(h.calls.enqueue.length, 1);
  assert.equal(h.calls.enqueue[0].message.intent.requestedFilename, "edited.mp4");

  const mismatches = [
    [Object.assign({}, message, { item: { id: "media:opaque:hls" } }), sender],
    [Object.assign({}, message, { tabId: 4242 }), sender],
    [Object.assign({}, message, { variantId: "variant:opaque:1" }), sender],
    [message, h.popupSender],
    [message, h.saveAsSender("?tabId=4242&mediaId=" + mediaId)],
    [message, { id: "media-catcher@test", url: "https://evil.example/page" }],
    [message, {}],
  ];
  for (const [bad, badSender] of mismatches) {
    const response = await h.send(bad, badSender);
    assert.equal(response.ok, false);
  }
  assert.equal(h.calls.enqueue.length, 1, "a mismatched sender reaches zero controller calls");
});

// ---------------------------------------------------------------------------
// Folder picker correlation and terminal states (Task 4)
// ---------------------------------------------------------------------------

function lastPickRequestId(h) {
  const posts = h.nativePosts.filter((post) => post.cmd === "pickFolder");
  assert.ok(posts.length, "expected a pickFolder command");
  return posts[posts.length - 1].requestId;
}

test("each native picker outcome maps to its own extension response", async () => {
  const cases = [
    [{ status: "selected", directory: "D:\\Videos" }, { ok: true, status: "selected", dir: "D:\\Videos" }],
    [{ status: "cancelled" }, { ok: true, status: "cancelled" }],
    [{ status: "error", code: "picker_unavailable" }, { ok: false, error: "folder_picker_failed" }],
    [{ status: "error", code: "invalid_selection" }, { ok: false, error: "folder_picker_failed" }],
    // Malformed / unknown frames must not be mistaken for a selection.
    [{ status: "selected" }, { ok: false, error: "folder_picker_failed" }],
    [{ status: "selected", directory: "" }, { ok: false, error: "folder_picker_failed" }],
    [{ status: "weird" }, { ok: false, error: "folder_picker_failed" }],
    [{}, { ok: false, error: "folder_picker_failed" }],
  ];
  for (const [frame, expected] of cases) {
    const h = createHarness();
    await settle();
    const pending = h.send({ type: "pick-folder", dir: "" });
    await settle();
    const requestId = lastPickRequestId(h);
    h.nativeMessages.emit(Object.assign({ type: "folder", requestId }, frame));
    assert.deepEqual(await pending, expected, JSON.stringify(frame));
  }
});

test("legacy folder frames still resolve as selected or cancelled", async () => {
  for (const [frame, expected] of [
    [{ dir: "D:\\Legacy" }, { ok: true, status: "selected", dir: "D:\\Legacy" }],
    [{ dir: "" }, { ok: true, status: "cancelled" }],
  ]) {
    const h = createHarness();
    await settle();
    const pending = h.send({ type: "pick-folder", dir: "" });
    await settle();
    const requestId = lastPickRequestId(h);
    // Legacy hosts echo reqId, not requestId.
    h.nativeMessages.emit(Object.assign({ type: "folder", reqId: requestId }, frame));
    assert.deepEqual(await pending, expected);
  }
});

test("a picker request settles exactly once and later frames are inert", async () => {
  const h = createHarness();
  await settle();
  const pending = h.send({ type: "pick-folder", dir: "" });
  await settle();
  const requestId = lastPickRequestId(h);

  h.nativeMessages.emit({ type: "folder", requestId, status: "cancelled" });
  assert.deepEqual(await pending, { ok: true, status: "cancelled" });

  // Duplicate and unknown frames must not throw or re-respond.
  h.nativeMessages.emit({ type: "folder", requestId, status: "selected", directory: "D:\\Late" });
  h.nativeMessages.emit({ type: "folder", requestId: "fp-unknown", status: "selected", directory: "D:\\X" });
  await settle();
});

test("a picker that never answers times out and a late selection is inert", async () => {
  const h = createHarness();
  await settle();
  const pending = h.send({ type: "pick-folder", dir: "" });
  await settle();
  const requestId = lastPickRequestId(h);

  h.advanceTimers(180000);
  assert.deepEqual(await pending, { ok: false, error: "folder_picker_timeout" });

  h.nativeMessages.emit({ type: "folder", requestId, status: "selected", directory: "D:\\TooLate" });
  await settle();
});

test("a helper disconnect settles every pending picker as failed", async () => {
  const h = createHarness();
  await settle();
  const first = h.send({ type: "pick-folder", dir: "" });
  await settle();
  const second = h.send({ type: "pick-folder", dir: "" });
  await settle();

  h.nativeDisconnect.emit();
  assert.deepEqual(await first, { ok: false, error: "folder_picker_failed" });
  assert.deepEqual(await second, { ok: false, error: "folder_picker_failed" });
});

test("the picker request carries a correlating id and the requested directory", async () => {
  const h = createHarness();
  await settle();
  const pending = h.send({ type: "pick-folder", dir: "C:\\Prior" });
  await settle();
  const post = h.nativePosts.filter((entry) => entry.cmd === "pickFolder").at(-1);
  assert.equal(post.dir, "C:\\Prior");
  assert.equal(typeof post.requestId, "string");
  assert.equal(post.reqId, post.requestId, "legacy hosts still receive reqId");

  h.nativeMessages.emit({ type: "folder", requestId: post.requestId, status: "cancelled" });
  await pending;
});
