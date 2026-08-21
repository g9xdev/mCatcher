"use strict";
//
// Three new host round trips — delete, badapple-stop, thumb — and the one
// property they all have to hold.
//
// background.js settles a host frame like this:
//
//     const dl = activeDownloads.get(msg.id);
//     if (!dl && msg.type === "error") { ...log...; return; }
//     if (!dl) return;
//     ...  else if (msg.type === "error") { dl.status = "error"; }
//
// So ANY frame that reaches that lookup carrying an id is interpreted as a
// statement about a download row. A refusal keyed on a download id therefore
// marks the download FAILED — for a delete that means a file that is still
// on disk, and a row that says it is not.
//
// The file already learned this once, for beams, and wrote it down at the
// guard: "Checked BEFORE the row lookup because a beam id is not a download
// id". These three verbs follow that same shape: a dedicated request id,
// minted with a prefix so it cannot collide with a download id (those are
// bare numbers from ++downloadCounter), settled before the row lookup.
//
// The tests below drive the real background.js in a vm and assert on the two
// things a caller can actually observe: what came back to the popup, and what
// happened to the rows.
//
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
      onActivated: noopEvent(), onRemoved: noopEvent(), onUpdated: noopEvent(),
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

// ---------------------------------------------------------------------------
// The shared property: a request id is not a download id
// ---------------------------------------------------------------------------

test("the three verbs mint prefixed request ids, which bare-numeric download ids cannot collide with", async () => {
  const h = await readyHarness();
  // Fired, not awaited: neither request is answered here, and what this test
  // reads is the frame that went out, not a reply that never comes.
  const quiet = () => {};
  h.send({ type: "delete-file", downloadId: 1, path: "C:\\v\\a.mp4" }, {}).catch(quiet);
  h.send({ type: "badapple-stop" }, {}).catch(quiet);
  await settle();

  const del = h.lastHost("delete");
  const stop = h.lastHost("badapple-stop");
  assert.ok(del, "a delete frame reached the host");
  assert.ok(stop, "a badapple-stop frame reached the host");
  for (const frame of [del, stop]) {
    assert.equal(typeof frame.reqId, "string");
    assert.equal(/^[0-9]+$/.test(frame.reqId), false,
      "a bare-numeric reqId is exactly what could name a download row: " + frame.reqId);
    assert.equal(frame.reqId.length > 0, true);
    assert.equal(Object.prototype.hasOwnProperty.call(frame, "id"), false,
      "no `id` field, so the row lookup has nothing to find");
  }
  assert.notEqual(del.reqId, stop.reqId, "two requests are two ids");
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

test("a delete carries the path and settles its caller on the host's ok", async () => {
  const h = await readyHarness();
  const pending = h.send({ type: "delete-file", downloadId: 4242, path: "C:\\v\\a.mp4" }, {});
  await settle();

  const frame = h.lastHost("delete");
  assert.deepEqual(Object.keys(frame).sort(), ["cmd", "path", "reqId"]);
  assert.equal(frame.cmd, "delete");
  assert.equal(frame.path, "C:\\v\\a.mp4");

  h.fromHost({ type: "delete-result", reqId: frame.reqId, ok: true, error: null });
  assert.deepEqual(await pending, { ok: true, error: null });
});

test("a REFUSED delete answers the caller and leaves the download row alone", async () => {
  const h = await readyHarness();
  const id = seedDownload(h);
  const before = h.updatesFor(id).length;

  const pending = h.send({ type: "delete-file", downloadId: id, path: "C:\\v\\a.mp4" }, {});
  await settle();
  const frame = h.lastHost("delete");

  h.fromHost({ type: "delete-result", reqId: frame.reqId, ok: false, error: "File is in use." });
  const answer = await pending;
  assert.equal(answer.ok, false);
  assert.equal(answer.error, "File is in use.");

  // The file is still there, so the download that produced it is still done.
  // This is the assertion the whole shape exists for.
  const after = h.updatesFor(id);
  assert.equal(after.length, before,
    "a refused delete rebroadcast the row, which means it touched it");
  for (const update of after) {
    assert.notEqual(update.download.status, "error",
      "a refused delete marked a still-present download as failed");
  }
});

test("a delete result is claimed before the row lookup, so an id-shaped reqId cannot corrupt a row", async () => {
  const h = await readyHarness();
  const id = seedDownload(h);

  const pending = h.send({ type: "delete-file", downloadId: id, path: "C:\\v\\a.mp4" }, {});
  await settle();
  const frame = h.lastHost("delete");

  // The host echoes the reqId AND, being a generic error emitter, also names
  // the row. The result frame must be claimed on its way past, before
  // `activeDownloads.get(msg.id)` gets a chance to read that `id`.
  h.fromHost({ type: "delete-result", reqId: frame.reqId, ok: false, error: "Denied.", id });
  const answer = await pending;
  assert.equal(answer.ok, false);

  for (const update of h.updatesFor(id)) {
    assert.notEqual(update.download.status, "error");
  }
});

test("a second frame on a claimed delete reqId does not answer twice", async () => {
  const h = await readyHarness();
  const pending = h.send({ type: "delete-file", downloadId: 1, path: "C:\\v\\a.mp4" }, {});
  await settle();
  const frame = h.lastHost("delete");

  h.fromHost({ type: "delete-result", reqId: frame.reqId, ok: true, error: null });
  assert.deepEqual(await pending, { ok: true, error: null });
  // Claimed once: the entry is gone, so this is a frame naming nothing.
  h.fromHost({ type: "delete-result", reqId: frame.reqId, ok: false, error: "late" });
  await settle();
});

test("a delete with no helper answers rather than hanging", async () => {
  const h = createHarness();
  await settle();                       // never made ready
  const answer = await h.send({ type: "delete-file", downloadId: 1, path: "C:\\v\\a.mp4" }, {});
  assert.equal(answer.ok, false);
  assert.equal(typeof answer.error, "string");
  assert.equal(h.lastHost("delete"), null, "nothing was posted to an absent port");
});

test("a delete without a usable path is refused here, not forwarded", async () => {
  const h = await readyHarness();
  for (const bad of [undefined, null, "", 42, {}]) {
    const answer = await h.send({ type: "delete-file", downloadId: 1, path: bad }, {});
    assert.equal(answer.ok, false, String(bad));
  }
  assert.equal(h.lastHost("delete"), null);
});

// ---------------------------------------------------------------------------
// badapple-stop
// ---------------------------------------------------------------------------

test("badapple-stop carries only its reqId and settles on the host's answer", async () => {
  const h = await readyHarness();
  const pending = h.send({ type: "badapple-stop" }, {});
  await settle();

  const frame = h.lastHost("badapple-stop");
  assert.deepEqual(Object.keys(frame).sort(), ["cmd", "reqId"],
    "the stop frame has no path and no url");

  h.fromHost({ type: "badapple-stop-result", reqId: frame.reqId, ok: true, error: null });
  assert.deepEqual(await pending, { ok: true, error: null });
});

test("a refused badapple-stop reaches its caller and no download row", async () => {
  const h = await readyHarness();
  const id = seedDownload(h);
  const before = h.updatesFor(id).length;

  const pending = h.send({ type: "badapple-stop" }, {});
  await settle();
  const frame = h.lastHost("badapple-stop");
  h.fromHost({ type: "badapple-stop-result", reqId: frame.reqId, ok: false, error: "Not running." });

  const answer = await pending;
  assert.equal(answer.ok, false);
  assert.equal(answer.error, "Not running.");
  assert.equal(h.updatesFor(id).length, before);
});

// ---------------------------------------------------------------------------
// thumb  (host-side, from a LOCAL PATH — never a url)
// ---------------------------------------------------------------------------

test("a thumb request names a local path and an offset, and never a url", async () => {
  const h = await readyHarness();
  // Fired, not awaited — this test reads the outgoing frame.
  h.send({ type: "thumb-file", path: "C:\\v\\a.mp4", atSeconds: 12 }, {}).catch(() => {});
  await settle();

  const frame = h.lastHost("thumb");
  assert.ok(frame, "a thumb frame reached the host");
  assert.deepEqual(Object.keys(frame).sort(), ["atSeconds", "cmd", "path", "reqId"]);
  assert.equal(frame.path, "C:\\v\\a.mp4");
  assert.equal(frame.atSeconds, 12);
  assert.equal(Object.prototype.hasOwnProperty.call(frame, "url"), false,
    "the host must never be handed a stream address to fetch");
});

test("a thumb-result carrying a picture settles its caller", async () => {
  const h = await readyHarness();
  const pending = h.send({ type: "thumb-file", path: "C:\\v\\a.mp4", atSeconds: 3 }, {});
  await settle();
  const frame = h.lastHost("thumb");

  const dataUrl = "data:image/jpeg;base64,AAAA";
  h.fromHost({ type: "thumb-result", reqId: frame.reqId, dataUrl, atSeconds: 3, error: null });
  const answer = await pending;
  assert.equal(answer.ok, true);
  assert.equal(answer.dataUrl, dataUrl);
});

test("a thumb-result that is not a picture answers without one and touches no row", async () => {
  const h = await readyHarness();
  const id = seedDownload(h);
  const before = h.updatesFor(id).length;

  const pending = h.send({ type: "thumb-file", path: "C:\\v\\a.mp4", atSeconds: 3 }, {});
  await settle();
  const frame = h.lastHost("thumb");
  h.fromHost({ type: "thumb-result", reqId: frame.reqId, dataUrl: null, atSeconds: 3,
    error: "ffmpeg missing" });

  const answer = await pending;
  assert.equal(answer.ok, false);
  assert.equal(answer.dataUrl, null);
  assert.equal(h.updatesFor(id).length, before);
});

test("a thumb-result whose dataUrl is not a validated jpeg data URL is dropped", async () => {
  const h = await readyHarness();
  const pending = h.send({ type: "thumb-file", path: "C:\\v\\a.mp4", atSeconds: 3 }, {});
  await settle();
  const frame = h.lastHost("thumb");

  // The host is a separate process; what it returns is still checked here
  // before it becomes a value the popup renders.
  h.fromHost({ type: "thumb-result", reqId: frame.reqId,
    dataUrl: "javascript:alert(1)", atSeconds: 3, error: null });
  const answer = await pending;
  assert.equal(answer.ok, false);
  assert.equal(answer.dataUrl, null);
});

// ---------------------------------------------------------------------------
// Nothing new leaks into the generic lanes
// ---------------------------------------------------------------------------

test("an ordinary host error naming a live row still fails that row", async () => {
  // The guard added for these verbs must be narrow enough that the existing
  // behaviour it sits in front of is unchanged.
  const h = await readyHarness();
  const id = seedDownload(h);
  h.fromHost({ type: "error", id, error: "disk full" });
  await settle();

  const updates = h.updatesFor(id);
  assert.equal(updates[updates.length - 1].download.status, "error",
    "the pre-existing error lane still marks its row");
});

test("a result frame naming an unknown reqId is ignored quietly", async () => {
  const h = await readyHarness();
  const id = seedDownload(h);
  const before = h.updatesFor(id).length;
  for (const type of ["delete-result", "badapple-stop-result", "thumb-result"]) {
    h.fromHost({ type, reqId: "no-such-request", ok: false, error: "x", dataUrl: null });
  }
  await settle();
  assert.equal(h.updatesFor(id).length, before);
});

module.exports = { createHarness, readyHarness, settle };
