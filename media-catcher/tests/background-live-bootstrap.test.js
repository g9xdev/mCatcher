"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { mediaCatcherRoot } = require("./harness/load-lib.js");

const policyScripts = [
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
  "lib/download-message-router.js",
  "lib/live-media-assembler.js",
  "lib/media-size.js",
  "lib/background-adapters.js",
];

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function event() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit() {
      const args = arguments;
      for (const listener of listeners.slice()) listener.apply(null, args);
    },
    get size() { return listeners.length; },
  };
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

function backgroundScripts() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(mediaCatcherRoot, "manifest.json"), "utf8")
  );
  return manifest.background.scripts;
}

function createHarness() {
  const settingsLoad = deferred();
  const nativeMessages = event();
  const nativeDisconnects = event();
  const nativePosts = [];
  const runtimeMessages = [];
  const controllerCreates = [];
  const handledNative = [];
  const helperDisconnects = [];
  const assemblerCreates = [];

  const controller = {
    async handleNativeMessage(message) {
      handledNative.push(message);
      if (message && message.type === "file-opened") {
        controllerCreates[0].postNative({ cmd: "file-chunk", sinkId: "sink-live" });
        return true;
      }
      return false;
    },
    helperDisconnected() { helperDisconnects.push(true); },
  };

  const nativePort = {
    onMessage: nativeMessages,
    onDisconnect: nativeDisconnects,
    postMessage(message) { nativePosts.push(message); },
  };

  const noOpEvent = () => event();
  let storageGetCount = 0;
  const browser = {
    storage: {
      local: {
        get() {
          storageGetCount += 1;
          return storageGetCount === 1 ? settingsLoad.promise : Promise.resolve({});
        },
        set() { return Promise.resolve(); },
      },
    },
    runtime: {
      id: "media-catcher@test",
      lastError: null,
      onMessage: noOpEvent(),
      onInstalled: noOpEvent(),
      connectNative() { return nativePort; },
      sendMessage(message) {
        runtimeMessages.push(message);
        return Promise.resolve();
      },
      getManifest() { return { version: "1.10.0" }; },
      getURL(relative) { return "moz-extension://media-catcher/" + relative; },
    },
    downloads: {
      download() { return Promise.resolve(1); },
      search() { return Promise.resolve([]); },
      open() {},
      show() {},
    },
    tabs: {
      onActivated: noOpEvent(), onRemoved: noOpEvent(),
      onUpdated: noOpEvent(),
      query() { return Promise.resolve([]); },
      create() { return Promise.resolve(); },
      update() { return Promise.resolve(); },
      executeScript() { return Promise.resolve(); },
    },
    webRequest: {
      onSendHeaders: noOpEvent(),
      onHeadersReceived: noOpEvent(),
      onBeforeSendHeaders: noOpEvent(),
    },
    browserAction: { onClicked: noOpEvent(), setBadgeText() {}, setBadgeBackgroundColor() {} },
    contextMenus: {
      onClicked: noOpEvent(),
      removeAll(callback) { if (callback) callback(); },
      create() {},
    },
    notifications: {
      onClicked: noOpEvent(),
      onClosed: noOpEvent(),
      create() {},
      clear() {},
    },
  };

  const root = {};
  const sandbox = {
    self: root,
    browser,
    console: { log() {}, warn() {}, error() {} },
    Promise,
    Map,
    Set,
    WeakMap,
    Object,
    Array,
    ArrayBuffer,
    Uint8Array,
    TextDecoder,
    TextEncoder,
    URL,
    Blob,
    Date,
    Math,
    JSON,
    Number,
    String,
    Boolean,
    RegExp,
    Error,
    TypeError,
    RangeError,
    Symbol,
    Reflect,
    Proxy,
    AbortController,
    setTimeout() { return 1; },
    clearTimeout() {},
    fetch() { throw new Error("unexpected fetch"); },
    crypto: {
      randomUUID() { return "00000000-0000-4000-8000-000000000001"; },
    },
  };
  vm.createContext(sandbox);

  function load() {
    for (const relative of backgroundScripts()) {
      if (relative === "background.js") {
        root.McLiveMediaAssembler = {
          createLiveMediaAssembler(dependencies) {
            assemblerCreates.push(dependencies);
            return async function assembleMedia() {
              throw new Error("unused in bootstrap test");
            };
          },
        };
        root.McBackgroundAdapters = {
          createBackgroundAdapters(options) {
            controllerCreates.push(options);
            return controller;
          },
        };
      }
      const absolute = path.join(mediaCatcherRoot, relative);
      vm.runInContext(fs.readFileSync(absolute, "utf8"), sandbox, { filename: absolute });
    }
  }

  return {
    load,
    settingsLoad,
    nativeMessages,
    nativeDisconnects,
    nativePosts,
    runtimeMessages,
    controllerCreates,
    handledNative,
    helperDisconnects,
    assemblerCreates,
  };
}

test("manifest loads every live policy dependency before background.js", () => {
  assert.deepEqual(backgroundScripts().slice(5, -1), policyScripts);
});

test("restored settings create exactly one live controller before native frames are owned", async () => {
  const h = createHarness();
  h.load();

  assert.equal(h.controllerCreates.length, 0, "defaults must not construct the controller");

  h.settingsLoad.resolve({
    settings: { maxConcurrentDownloads: 7, concurrency: 3, retries: 2 },
    pd4done: true,
    dq1done: true,
  });
  await settle();

  assert.equal(h.controllerCreates.length, 1);
  assert.equal(h.controllerCreates[0].maxConcurrent, 7);
  assert.equal(h.controllerCreates[0].segmentConcurrency, 3);
  assert.equal(h.controllerCreates[0].retries, 2);
  assert.equal(h.assemblerCreates.length, 1);
});

test("controller owns recognized native frames while legacy pong and disconnect behavior remain", async () => {
  const h = createHarness();
  h.load();
  h.settingsLoad.resolve({
    settings: { maxConcurrentDownloads: 7, concurrency: 3, retries: 2 },
    pd4done: true,
    dq1done: true,
  });
  await settle();

  h.nativeMessages.emit({ type: "file-opened", sinkId: "sink-live" });
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(h.nativePosts)), [
    { cmd: "ping" },
    { cmd: "file-chunk", sinkId: "sink-live" },
  ]);
  assert.equal(
    h.runtimeMessages.some((message) => message && message.type === "helper-status" && message.helper && message.helper.state === "ready"),
    false,
    "recognized policy frames must not run the legacy helper path"
  );

  h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
  await settle();
  assert.equal(h.handledNative.length, 2);
  assert.equal(
    h.runtimeMessages.some((message) => message && message.type === "helper-status" && message.helper && message.helper.state === "ready"),
    true,
    "unrecognized frames must retain legacy handling"
  );

  h.nativeMessages.emit({ type: "cast-status", state: "playing", id: "tv-1" });
  await settle();
  h.nativeDisconnects.emit();
  await settle();
  assert.equal(h.helperDisconnects.length, 1);
  assert.equal(h.nativeDisconnects.size, 1);
  assert.equal(
    h.runtimeMessages.some((message) => message && message.type === "cast-update" &&
      message.cast && message.cast.state === "idle" && /disconnected/i.test(message.error)),
    true,
    "legacy cast cleanup must still run on helper disconnect"
  );
});
