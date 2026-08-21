"use strict";
//
// A harness that runs the real background.js in a vm and, unlike the
// live-detection one, RECORDS what it posts to the host and to content
// scripts — those frames are half of what the tests using this pin.
//
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { mediaCatcherRoot } = require("./load-lib.js");

// A short but genuinely well-formed base64 JPEG data URL: the shape privacy.js
// admits, so tests fail on routing rather than on validation.
const JPEG = "data:image/jpeg;base64," +
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB";

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

// A harness that, unlike the live-detection one, RECORDS what background.js
// posts to the host — the command frames are half of what these tests pin.
function createHarness(options) {
  const opts = options || {};
  const runtimeMessages = event();
  const broadcasts = [];
  const hostSent = [];
  const tabMessages = [];
  const noopEvent = () => event();

  const nativePort = {
    onMessage: noopEvent(),
    onDisconnect: noopEvent(),
    postMessage(frame) { hostSent.push(clone(frame)); },
  };

  const contentReplies = new Map();   // tabId -> reply | (msg) => reply

  const tabEvents = { onActivated: noopEvent(), onRemoved: noopEvent(), onUpdated: noopEvent() };
  const browser = {
    storage: { local: {
      get() { return Promise.resolve({ pd4done: true, dq1done: true }); },
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
      onActivated: tabEvents.onActivated,
      onRemoved: tabEvents.onRemoved,
      onUpdated: tabEvents.onUpdated,
      query() { return Promise.resolve([]); },
      create() { return Promise.resolve(); }, update() { return Promise.resolve(); },
      executeScript() { return Promise.resolve(); },
      captureTab() { return Promise.resolve("data:image/png;base64,AAAA"); },
      sendMessage(tabId, message, extra) {
        tabMessages.push({ tabId, message: clone(message), extra: extra || null });
        if (!contentReplies.has(tabId)) return Promise.reject(new Error("no receiver"));
        const reply = contentReplies.get(tabId);
        return Promise.resolve(typeof reply === "function" ? reply(message) : clone(reply));
      },
    },
    webRequest: { onSendHeaders: noopEvent(), onHeadersReceived: noopEvent(), onBeforeSendHeaders: noopEvent() },
    browserAction: { onClicked: noopEvent(), setBadgeText() {}, setBadgeBackgroundColor() {} },
    contextMenus: { onClicked: noopEvent(), removeAll(cb) { if (cb) cb(); }, create() {} },
    notifications: { onClicked: noopEvent(), onClosed: noopEvent(), create() {}, clear() {} },
  };

  const root = {};
  const timers = [];
  const sandbox = {
    self: root,
    browser,
    console: { log() {}, warn() {}, error() {} },
    Promise, Map, Set, WeakMap, Object, Array, ArrayBuffer, Uint8Array,
    TextDecoder, TextEncoder, URL, Blob, Date, Math, JSON, Number, String,
    Boolean, RegExp, Error, TypeError, RangeError, Symbol, Reflect, Proxy,
    AbortController,
    // Recorded, never fired: a test that wants an expiry runs it by hand.
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeout(handle) { if (timers[handle - 1]) timers[handle - 1] = null; },
    setInterval() { return 0; }, clearInterval() {},
    fetch() { throw new Error("unexpected fetch"); },
    crypto: { randomUUID() { return "00000000-0000-4000-8000-000000000001"; } },
  };
  vm.createContext(sandbox);

  const manifest = JSON.parse(fs.readFileSync(path.join(mediaCatcherRoot, "manifest.json"), "utf8"));
  for (const relative of manifest.background.scripts) {
    if (relative === "background.js") {
      root.DASH = { parse() { throw new Error("unused"); } };
      root.McLiveMediaAssembler = { createLiveMediaAssembler() { return async () => { throw new Error("unused"); }; } };
      root.McBackgroundAdapters = { createBackgroundAdapters() { return {
        captureNetwork() { return null; },
        acceptPageSnapshot() {},
        captureDomMedia() { return null; },
        registerVariants() { return []; },
        popupMedia() { return Object.freeze([]); },
        popupJobs() { return Object.freeze(opts.popupJobs || []); },
        async handleNativeMessage() { return false; },
        helperDisconnected() {},
      }; } };
    }
    vm.runInContext(fs.readFileSync(path.join(mediaCatcherRoot, relative), "utf8"), sandbox, { filename: relative });
  }

  async function send(message, sender) {
    return new Promise((resolve, reject) => {
      let responded = false;
      const timer = setTimeout(
        () => { if (!responded) reject(new Error("background did not respond")); }, 1000);
      const results = runtimeMessages.emit(message, sender || {}, (response) => {
        responded = true;
        clearTimeout(timer);
        resolve(response === undefined ? undefined : clone(response));
      });
      // A handler that answers synchronously with no sendResponse still has to
      // resolve, or an absent handler would look like a hang rather than a miss.
      if (!results.some((r) => r === true) && !responded) {
        clearTimeout(timer);
        resolve(undefined);
      }
    });
  }

  // The host talking back. Nothing in background.js distinguishes this from a
  // real port message.
  function fromHost(frame) { nativePort.onMessage.emit(frame); }

  return {
    send, fromHost, broadcasts, hostSent, tabMessages, nativePort, sandbox, timers,
    // The real listeners background.js registered, so a test closes a tab the
    // way the browser does rather than by calling a helper directly.
    closeTab(tabId) { tabEvents.onRemoved.emit(tabId, { windowId: 1, isWindowClosing: false }); },
    evalInBackground(expr) { return vm.runInContext(expr, sandbox, { filename: "test-probe" }); },
    setContentReply(tabId, reply) { contentReplies.set(tabId, reply); },
    runTimers() {
      const pending = timers.slice();
      for (let i = 0; i < pending.length; i += 1) {
        if (pending[i] && typeof pending[i].fn === "function") pending[i].fn();
      }
    },
    lastHost(cmd) {
      for (let i = hostSent.length - 1; i >= 0; i -= 1) {
        if (hostSent[i] && hostSent[i].cmd === cmd) return hostSent[i];
      }
      return null;
    },
    updatesFor(id) {
      return broadcasts.filter((b) => b && b.type === "download-update" &&
        b.download && b.download.id === id);
    },
  };
}

// Bring the native port up the way background.js expects: it marks itself
// ready on the host's hello/ready frame.
async function readyHarness(options) {
  const h = createHarness(options);
  await settle();
  // `pong` with ffmpeg present is the frame that flips nativeReady — see
  // setNativeState at the pong handler in background.js.
  h.fromHost({ type: "pong", version: "1.0.0", ffmpeg: true, ffmpegPath: "C:\ff\ffmpeg.exe" });
  await settle();
  return h;
}

// Put a row in the REAL activeDownloads map. background.js declares it with a
// top-level `const`, which lands in the context's lexical scope and so is
// reachable from a later script evaluated in that same context — this is the
// same Map the message handlers read, not a stand-in for it.
function seedDownload(h, id) {
  const rowId = id === undefined ? 4242 : id;
  h.evalInBackground(
    "activeDownloads.set(" + JSON.stringify(rowId) +
    ", { id: " + JSON.stringify(rowId) + ", name: 'a.mp4', kind: 'direct', native: true," +
    " status: 'done', savedPath: 'C:\\\\v\\\\a.mp4' })");
  assert.equal(h.evalInBackground("activeDownloads.get(" + JSON.stringify(rowId) + ").status"),
    "done", "the seeded row is in the map background.js reads");
  return rowId;
}


// Bring the native port up the way background.js expects: `pong` with ffmpeg
// present is the frame that flips nativeReady (see setNativeState).
async function readyHarness(options) {
  const h = createHarness(options);
  await settle();
  h.fromHost({ type: "pong", version: "1.0.0", ffmpeg: true, ffmpegPath: "C:\ff\ffmpeg.exe" });
  await settle();
  return h;
}

// Put a row in the REAL activeDownloads map. background.js declares it with a
// top-level `const`, which lands in the context's lexical scope and so is
// reachable from a later script evaluated in that same context — this is the
// same Map the message handlers read, not a stand-in for it.
function seedDownload(h, id) {
  const rowId = id === undefined ? 4242 : id;
  h.evalInBackground(
    "activeDownloads.set(" + JSON.stringify(rowId) +
    ", { id: " + JSON.stringify(rowId) + ", name: 'a.mp4', kind: 'direct', native: true," +
    " status: 'done', savedPath: 'C:\\v\\a.mp4' })");
  assert.equal(h.evalInBackground("activeDownloads.get(" + JSON.stringify(rowId) + ").status"),
    "done", "the seeded row is in the map background.js reads");
  return rowId;
}

module.exports = { createHarness, readyHarness, seedDownload, settle, clone, JPEG };
