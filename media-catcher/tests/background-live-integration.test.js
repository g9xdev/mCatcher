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
  for (let i = 0; i < 80; i += 1) {
    const value = await predicate();
    if (value) return value;
    await settle();
  }
  assert.fail(label);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function toBuffer(value) {
  const view = typeof value === "string"
    ? new TextEncoder().encode(value)
    : Uint8Array.from(value);
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function createHarness(fixtures) {
  const runtimeMessages = event();
  const requestHeaders = event();
  const headersReceived = event();
  const nativeMessages = event();
  const nativeDisconnect = event();
  const nativePosts = [];
  const browserDownloads = [];
  const broadcasts = [];
  const publicResponses = [];
  const fetches = [];
  const storageState = {
    settings: { maxConcurrentDownloads: 2, concurrency: 2, retries: 1, saveFolder: "D:\\DESTINATION_SECRET" },
    pd4done: true,
    dq1done: true,
    history: [],
  };
  let controller = null;
  let token = 0;

  function storageGet(keys) {
    if (keys == null) return Promise.resolve(clone(storageState));
    const result = {};
    if (typeof keys === "string") {
      if (Object.prototype.hasOwnProperty.call(storageState, keys)) result[keys] = clone(storageState[keys]);
    } else if (Array.isArray(keys)) {
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(storageState, key)) result[key] = clone(storageState[key]);
      }
    } else if (typeof keys === "object") {
      for (const [key, fallback] of Object.entries(keys)) {
        result[key] = Object.prototype.hasOwnProperty.call(storageState, key)
          ? clone(storageState[key])
          : fallback;
      }
    }
    return Promise.resolve(result);
  }

  const noopEvent = () => event();
  const nativePort = {
    onMessage: nativeMessages,
    onDisconnect: nativeDisconnect,
    postMessage(message) { nativePosts.push(message); },
  };
  const browser = {
    storage: { local: {
      get: storageGet,
      set(values) {
        for (const [key, value] of Object.entries(values || {})) storageState[key] = clone(value);
        return Promise.resolve();
      },
    } },
    runtime: {
      id: "media-catcher@test", lastError: null, onMessage: runtimeMessages,
      onInstalled: noopEvent(), connectNative() { return nativePort; },
      sendMessage(message) { broadcasts.push(clone(message)); return Promise.resolve(); },
      getManifest() { return { version: "1.10.0" }; },
      getURL(relative) { return "moz-extension://media-catcher/" + relative; },
    },
    downloads: {
      download(options) { browserDownloads.push(clone(options)); return Promise.resolve(1); },
      search() { return Promise.resolve([]); }, open() {}, show() {},
    },
    tabs: {
      onRemoved: noopEvent(), onUpdated: noopEvent(), query() { return Promise.resolve([]); },
      create() { return Promise.resolve(); }, update() { return Promise.resolve(); },
      executeScript() { return Promise.resolve(); },
    },
    webRequest: {
      onSendHeaders: requestHeaders,
      onHeadersReceived: headersReceived,
      onBeforeSendHeaders: noopEvent(),
    },
    browserAction: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    contextMenus: { onClicked: noopEvent(), removeAll(callback) { if (callback) callback(); }, create() {} },
    notifications: { onClicked: noopEvent(), onClosed: noopEvent(), create() {}, clear() {} },
  };

  const root = {};
  const sandbox = {
    self: root, browser, console: { log() {}, warn() {}, error() {} },
    Promise, Map, Set, WeakMap, WeakSet, Object, Array, ArrayBuffer, Uint8Array,
    TextDecoder, TextEncoder, URL, Blob, Date, Math, JSON, Number, String,
    Boolean, RegExp, Error, TypeError, RangeError, Symbol, Reflect, Proxy,
    AbortController, setTimeout() { return 1; }, clearTimeout() {},
    fetch(url, options) {
      const key = String(url);
      fetches.push({ url: key, options: clone(options || {}) });
      assert.equal(fixtures.has(key), true, "unexpected fetch URL: " + key);
      const body = toBuffer(fixtures.get(key));
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get() { return null; } },
        arrayBuffer() { return Promise.resolve(body); },
      });
    },
    crypto: {
      randomUUID() {
        token += 1;
        return "00000000-0000-4000-8000-" + String(token).padStart(12, "0");
      },
    },
  };
  vm.createContext(sandbox);

  const manifest = JSON.parse(fs.readFileSync(path.join(mediaCatcherRoot, "manifest.json"), "utf8"));
  for (const relative of manifest.background.scripts) {
    if (relative === "background.js") {
      const realFactory = root.McBackgroundAdapters.createBackgroundAdapters;
      root.McBackgroundAdapters = Object.freeze({
        createBackgroundAdapters(options) {
          controller = realFactory(options);
          return controller;
        },
      });
    }
    vm.runInContext(fs.readFileSync(path.join(mediaCatcherRoot, relative), "utf8"), sandbox, { filename: relative });
  }

  async function send(message, sender) {
    const response = await new Promise((resolve, reject) => {
      let responded = false;
      const timer = global.setTimeout(() => {
        if (!responded) reject(new Error("background did not respond"));
      }, 1000);
      runtimeMessages.emit(message, sender || {}, (value) => {
        responded = true;
        global.clearTimeout(timer);
        resolve(clone(value));
      });
    });
    publicResponses.push(response);
    return response;
  }

  return {
    send, requestHeaders, headersReceived, nativeMessages, nativePosts,
    browserDownloads, broadcasts, publicResponses, fetches, storageState,
    get controller() { return controller; },
    popupSender: {
      id: browser.runtime.id,
      url: browser.runtime.getURL("popup/popup.html"),
    },
  };
}

function snapshot(tabId, provider, filename) {
  const pageUrl = "https://" + provider + ".example/watch";
  return {
    type: "page-snapshot",
    documentId: "doc-" + tabId,
    documentNonce: "nonce-" + tabId,
    tabId,
    frameId: 0,
    pageUrl,
    topLevelPageUrl: pageUrl,
    candidates: [{ kind: "visible-filename", value: filename }],
    capturedAt: new Date().toISOString(),
  };
}

async function detectStaticHls(h, input) {
  const page = snapshot(input.tabId, input.provider, input.filename);
  const sender = {
    tab: { id: input.tabId, url: page.pageUrl, title: input.filename },
    frameId: 0,
    documentId: page.documentId,
    url: page.pageUrl,
  };
  assert.deepEqual(await h.send(page, sender), { ok: true });

  h.requestHeaders.emit({
    tabId: input.tabId,
    requestHeaders: [
      { name: "Referer", value: page.pageUrl },
      { name: "Origin", value: "https://" + input.provider + ".example" },
      { name: "User-Agent", value: "Integration Browser" },
      { name: "Authorization", value: "Bearer AUTHORIZATION_SENTINEL" },
      { name: "Cookie", value: "session=COOKIE_SENTINEL" },
    ],
  });
  h.headersReceived.emit({
    tabId: input.tabId,
    frameId: 0,
    documentId: page.documentId,
    documentUrl: page.pageUrl,
    originUrl: page.pageUrl,
    url: input.masterUrl,
    timeStamp: Date.now(),
    responseHeaders: [{ name: "Content-Type", value: "application/vnd.apple.mpegurl" }],
  });

  await eventually(
    () => h.controller.popupMedia(input.tabId).some((item) => item.kind === "hls"),
    "verified HLS row did not reach the controller popup surface"
  );
  const state = await h.send({ type: "get-media", tabId: input.tabId }, h.popupSender);
  return state.items.find((item) => item.kind === "hls" && typeof item.id === "string");
}

test("public background flow keeps static HLS assembly opaque and admits an independent provider", async () => {
  const signed = "SIGNED_QUERY_SENTINEL";
  const firstMaster = "https://alpha.example/master.m3u8?token=" + signed;
  const firstVariant = "https://alpha.example/video.m3u8?token=" + signed;
  const firstSegment = "https://alpha.example/one.ts?token=" + signed;
  const secondMaster = "https://beta.example/master.m3u8?token=" + signed;
  const secondVariant = "https://beta.example/video.m3u8?token=" + signed;
  const secondSegment = "https://beta.example/two.ts?token=" + signed;
  const fixtures = new Map([
    [firstMaster, [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080",
      "video.m3u8?token=" + signed,
      "#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720",
      "low.m3u8?token=" + signed,
      "",
    ].join("\n")],
    [firstVariant, "#EXTM3U\n#EXTINF:4,\none.ts?token=" + signed + "\n#EXT-X-ENDLIST\n"],
    [firstSegment, new TextEncoder().encode("ASSEMBLED_BYTES_SENTINEL")],
    [secondMaster, [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720",
      "video.m3u8?token=" + signed,
      "",
    ].join("\n")],
    [secondVariant, "#EXTM3U\n#EXTINF:4,\ntwo.ts?token=" + signed + "\n#EXT-X-ENDLIST\n"],
    [secondSegment, [7, 8, 9]],
  ]);
  const h = createHarness(fixtures);
  await eventually(() => h.controller, "real live controller was not initialized");

  const firstRow = await detectStaticHls(h, {
    tabId: 7,
    provider: "alpha",
    filename: "Episode One.mp4",
    masterUrl: firstMaster,
  });
  assert.equal(firstRow.proposedFilename, "Episode One.mp4");
  assert.equal(firstRow.id.startsWith("media:"), true);
  assert.equal(firstRow.variants.length, 2);
  assert.equal(firstRow.variants[0].id.startsWith("variant:"), true);
  assert.equal(firstRow.variants[0].label, "1920x1080 · 3000 kbps");
  assert.equal(JSON.stringify(firstRow).includes("https://"), false);

  const firstAction = await h.send({
    type: "download",
    tabId: 7,
    item: firstRow,
    variantId: firstRow.variants[0].id,
    userActionToken: "ACTION_PROOF_SENTINEL_ONE",
  }, h.popupSender);
  assert.equal(firstAction.ok, true);
  assert.equal(firstAction.job.mediaId, firstRow.id, "the popup-owned media row must bind the created job");
  assert.equal(firstAction.job.state, "running");

  const firstOpen = await eventually(
    () => h.nativePosts.find((message) => message.cmd === "file-open" && message.jobId === firstAction.job.id),
    "first real assembler did not open the native sink"
  );
  assert.equal(h.browserDownloads.length, 0);
  assert.equal(h.broadcasts.some((message) => message.type === "download-update"), false);
  assert.deepEqual(
    h.nativePosts.filter((message) => ["pget", "download-hls", "download-dash"].includes(message.cmd)),
    []
  );

  const secondRow = await detectStaticHls(h, {
    tabId: 8,
    provider: "beta",
    filename: "Episode Two.mp4",
    masterUrl: secondMaster,
  });
  const secondAction = await h.send({
    type: "download",
    tabId: 8,
    item: secondRow,
    variantId: secondRow.variants[0].id,
    userActionToken: "ACTION_PROOF_SENTINEL_TWO",
  }, h.popupSender);
  assert.equal(secondAction.ok, true);
  assert.equal(secondAction.job.mediaId, secondRow.id);
  assert.equal(secondAction.job.state, "running", "capacity two must admit a distinct provider while the first is active");
  await eventually(
    () => h.nativePosts.some((message) => message.cmd === "file-open" && message.jobId === secondAction.job.id),
    "independent provider was not admitted to its own assembler/sink lifecycle"
  );

  const sinkId = "SINK_ID_SENTINEL";
  h.nativeMessages.emit({
    type: "file-opened",
    sinkId,
    jobId: firstAction.job.id,
    attemptToken: firstOpen.attemptToken,
  });
  const firstChunks = await eventually(() => {
    const chunks = h.nativePosts.filter((message) => message.cmd === "file-chunk" && message.jobId === firstAction.job.id);
    return chunks.length > 0 ? chunks : null;
  }, "opened sink did not receive assembled chunks");
  for (const chunk of firstChunks) {
    h.nativeMessages.emit({ type: "file-chunk-ack", sinkId, seq: chunk.seq });
    await settle();
  }
  await eventually(
    () => h.nativePosts.some((message) => message.cmd === "file-commit" && message.jobId === firstAction.job.id),
    "acknowledged chunks did not commit"
  );
  const assembledLength = firstChunks.reduce((total, chunk) => total + chunk.length, 0);
  h.nativeMessages.emit({
    type: "file-committed",
    sinkId,
    file: "D:\\DESTINATION_SECRET\\NATIVE_HANDLE_SENTINEL.ts",
    bytes: assembledLength,
  });

  await eventually(
    () => h.controller.popupJobs().some((job) => job.id === firstAction.job.id && job.state === "completed"),
    "committed native sink did not publish a completed safe job"
  );
  const completedState = await h.send({ type: "get-media", tabId: 7, allTabs: true }, h.popupSender);
  assert.equal(h.broadcasts.some((message) =>
    message.type === "live-jobs-updated" &&
    Array.isArray(message.jobs) &&
    message.jobs.some((job) => job.id === firstAction.job.id && job.state === "completed")
  ), true);

  const history = await h.send({ type: "get-history" }, h.popupSender);
  const publicCapture = {
    media: completedState.items,
    jobs: completedState.downloads,
    messages: h.broadcasts,
    responses: h.publicResponses,
    history: history.history,
  };
  const publicJson = JSON.stringify(publicCapture);
  for (const forbidden of [
    firstMaster, firstVariant, firstSegment, secondMaster, secondVariant, secondSegment,
    signed, "COOKIE_SENTINEL", "AUTHORIZATION_SENTINEL", "ASSEMBLED_BYTES_SENTINEL",
    sinkId, firstOpen.attemptToken, "NATIVE_HANDLE_SENTINEL", "DESTINATION_SECRET",
    "ACTION_PROOF_SENTINEL_ONE", "ACTION_PROOF_SENTINEL_TWO",
  ]) {
    assert.equal(publicJson.includes(forbidden), false, "public JSON leaked: " + forbidden);
  }
  assert.equal(/https?:\/\//.test(publicJson), false, "public surfaces must remain URL-free");
  assert.equal(h.browserDownloads.length, 0, "managed HLS must never invoke Firefox implicitly");
});
