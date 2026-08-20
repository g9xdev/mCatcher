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
  "lib/beam-target.js",
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
  // background.js measures how long a connection lasted with Date.now(), so a
  // test that needs a connection to have been up for a while has to be able to
  // say so. Proxy the real Date rather than replacing it: `new Date(...)` is
  // still the genuine constructor for every other script in this context, and
  // with no skew applied Date.now() is byte-for-byte the usual answer.
  let clockSkew = 0;
  const SkewableDate = new Proxy(Date, {
    get(target, prop, receiver) {
      if (prop === "now") return () => Date.now() + clockSkew;
      return Reflect.get(target, prop, receiver);
    },
  });
  const settingsLoad = deferred();
  const nativePosts = [];
  const runtimeMessages = [];
  const tabMessages = [];
  const controllerCreates = [];
  const handledNative = [];
  const helperDisconnects = [];
  const assemblerCreates = [];
  const ticks = [];
  const timers = [];
  let tickError = null;

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
    tick(nowMs) {
      ticks.push(nowMs);
      if (tickError) throw tickError;
    },
  };

  // Real runtime.connectNative() returns an independent Port per call — its
  // onDisconnect fires at most once, for its own lifetime, and never again
  // once superseded. Mirror that here instead of handing back one shared
  // object: each connectNative() call gets its own fresh onMessage/
  // onDisconnect event lists, so a listener registered by an earlier
  // connection is simply never reached by a later drop — no accumulation to
  // route around. nativeMessages/nativeDisconnects stay the stable handles
  // tests already drive; they proxy to whichever port is current.
  let currentPort = null;
  function makeNativePort() {
    const port = {
      onMessage: event(),
      onDisconnect: event(),
      postMessage(message) { nativePosts.push(message); },
    };
    currentPort = port;
    return port;
  }
  const nativeMessages = {
    emit(...args) { if (currentPort) currentPort.onMessage.emit(...args); },
    get size() { return currentPort ? currentPort.onMessage.size : 0; },
  };
  const nativeDisconnects = {
    emit(...args) { if (currentPort) currentPort.onDisconnect.emit(...args); },
    get size() { return currentPort ? currentPort.onDisconnect.size : 0; },
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
      connectNative() { return makeNativePort(); },
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
      // A message aimed at ONE content script, unlike runtime.sendMessage's
      // broadcast to extension pages — which is the only way an answer can get
      // back to the frame whose overlay asked for it.
      sendMessage(tabId, message, options) {
        tabMessages.push({ tabId, message, options });
        return Promise.resolve();
      },
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
    Date: SkewableDate,
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
    // `active` starts true and goes false the moment the timer is either
    // fired (setTimeout only — setInterval keeps firing) or cleared, so
    // tests can tell a still-pending re-dial from one that already ran or
    // was cancelled, instead of treating every entry ever pushed as live.
    // `name` carries the callback's declared function name (background.js
    // names the ones tests need to pick out, e.g. `nativeRedial`) so tests
    // can identify a specific timer without guessing from its duration.
    setTimeout(fn, ms) {
      const entry = { kind: "timeout", ms, name: fn.name, active: true };
      entry.fn = function timerFn() {
        entry.active = false;
        return fn.apply(null, arguments);
      };
      timers.push(entry);
      return entry;
    },
    clearTimeout(handle) {
      if (handle && typeof handle === "object") handle.active = false;
    },
    setInterval(fn, ms) {
      const entry = { kind: "interval", ms, name: fn.name, active: true };
      entry.fn = function timerFn() { return fn.apply(null, arguments); };
      timers.push(entry);
      return entry;
    },
    clearInterval(handle) {
      if (handle && typeof handle === "object") handle.active = false;
    },
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
    tabMessages,
    controllerCreates,
    handledNative,
    helperDisconnects,
    assemblerCreates,
    ticks,
    timers,
    advanceClock(ms) { clockSkew += ms; },
    setTickError(err) { tickError = err; },
    // background.js declares its entry points at top level, so they land on the
    // vm global — the only way to drive one directly, since runtime.onMessage
    // is a no-op event here.
    sandbox,
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
  // The re-dial is now scheduled rather than immediate — drive it before
  // checking listener count.
  h.timers.filter((t) => t.kind === "timeout" && t.name === "nativeRedial" && t.active).forEach((t) => t.fn());
  await settle();
  // One listener: the re-dial's reconnect gets its own fresh port (matching
  // real runtime.connectNative, which returns an independent Port per call),
  // so the dropped port's now-orphaned listener is not watching this one —
  // nothing accumulates, in the harness or in production.
  assert.equal(h.nativeDisconnects.size, 1);
  assert.equal(
    h.runtimeMessages.some((message) => message && message.type === "cast-update" &&
      message.cast && message.cast.state === "idle" && /disconnected/i.test(message.error)),
    true,
    "legacy cast cleanup must still run on helper disconnect"
  );
});

// A dropped native port is not proof the helper is gone: it exits with Firefox,
// can be killed, and is replaced by every host update. Nothing else ever
// reconnects — connectNative runs only at extension startup or on an explicit
// re-check — so before this, one drop left the helper unusable for the rest of
// the session while the UI reported "Helper not installed."
test("a dropped helper port re-dials instead of reporting it uninstalled", async () => {
  const h = createHarness();
  h.load();
  h.settingsLoad.resolve({ settings: {} });
  await settle();
  h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
  await settle();

  const pings = () => h.nativePosts.filter((p) => p && p.cmd === "ping").length;
  const before = pings();

  h.nativeDisconnects.emit();
  await settle();
  h.timers.filter((t) => t.kind === "timeout" && t.name === "nativeRedial" && t.active).forEach((t) => t.fn());
  await settle();

  assert.equal(pings(), before + 1, "the drop must trigger a re-dial");
  const statuses = h.runtimeMessages.filter((m) => m && m.type === "helper-status");
  const last = statuses[statuses.length - 1];
  assert.notEqual(last.helper.error, "Helper not installed.",
    "a dropped port must not be reported as a missing install");
});

test("a re-dial that also drops backs off instead of giving up", async () => {
  const h = createHarness();
  h.load();
  h.settingsLoad.resolve({ settings: {} });
  await settle();
  h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
  await settle();

  const pings = () => h.nativePosts.filter((p) => p && p.cmd === "ping").length;
  const waits = () => h.timers.filter((t) => t.kind === "timeout" && t.name === "nativeRedial");

  const before = pings();
  h.nativeDisconnects.emit();
  await settle();

  const first = waits();
  assert.equal(first.length, 1, "the drop must schedule one re-dial");
  assert.equal(first[0].ms, 1000);
  assert.equal(pings(), before, "the re-dial must be scheduled, not immediate");

  first[0].fn();
  await settle();
  assert.equal(pings(), before + 1, "firing the timer re-dials");

  h.nativeDisconnects.emit();
  await settle();
  const second = waits();
  assert.equal(second.length, 2, "the second drop must schedule another re-dial");
  assert.ok(second[1].ms > first[0].ms, "the second wait must be longer");
});

test("automatic re-dials are bounded rather than unbounded", async () => {
  const h = createHarness();
  h.load();
  h.settingsLoad.resolve({ settings: {} });
  await settle();
  h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
  await settle();

  const waits = () => h.timers.filter((t) => t.kind === "timeout" && t.name === "nativeRedial");
  for (let i = 0; i < 6; i += 1) {
    h.nativeDisconnects.emit();
    await settle();
    waits().filter((t) => t.active).slice(-1).forEach((t) => t.fn());
    await settle();
  }
  assert.equal(waits().length, 4, "a helper that is truly gone must stop being re-dialled");
  // Running out of re-dials has to SETTLE, not just stop scheduling: the pill
  // is the only thing telling the user why nothing works. The equivalent
  // assertion was dropped when the one-shot re-dial test became this one.
  const statuses = h.runtimeMessages.filter((m) => m && m.type === "helper-status");
  const last = statuses[statuses.length - 1];
  assert.equal(last.helper.state, "disconnected",
    "an exhausted re-dial budget settles as disconnected");
  assert.equal(last.helper.ready, false, "nothing is connected once the budget is gone");
  assert.equal(last.helper.error, "Helper disconnected.",
    "a helper that was reached is never reported as a missing install");
});

// The other arm of that same branch, which nothing covered at all: only claim
// the helper is missing when no connection ever reached a live one. A drop
// after a good handshake is a disconnect, and saying otherwise sent people to
// reinstall software that was already there.
test("a connection that never reached a helper reports the missing install", async () => {
  const h = createHarness();
  h.load();
  h.settingsLoad.resolve({ settings: {} });
  await settle();

  // No pong has ever arrived on any connection — this is what a missing host
  // looks like: connectNative hands back a port that immediately drops.
  h.nativeDisconnects.emit();
  await settle();

  const statuses = h.runtimeMessages.filter((m) => m && m.type === "helper-status");
  const last = statuses[statuses.length - 1];
  assert.equal(last.helper.state, "disconnected", "an unreachable helper settles at once");
  assert.equal(last.helper.error, "Helper not installed.",
    "a helper that was never reached is reported as a missing install");
  assert.equal(
    h.timers.filter((t) => t.kind === "timeout" && t.name === "nativeRedial").length, 0,
    "a helper that was never reached is not re-dialled automatically");
});

// The bound is only a bound if it is per-helper, not per-outage. Any pong used
// to restore the whole budget, so a helper that answers the connect ping and
// then dies produced connect → pong → disconnect → 1000ms → connect → … at
// roughly 1 Hz for the entire browser session: never terminal, and two mclog
// lines a cycle rotating the 500-entry persisted ring — the diagnostic trail
// that ring exists for — in about four minutes. The repo's own boundedness
// test missed it only because its single pong came BEFORE the loop.
test("a helper that answers each connect ping and dies stays bounded", async () => {
  const h = createHarness();
  h.load();
  h.settingsLoad.resolve({ settings: {} });
  await settle();
  h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
  await settle();

  const waits = () => h.timers.filter((t) => t.kind === "timeout" && t.name === "nativeRedial");
  for (let i = 0; i < 6; i += 1) {
    h.nativeDisconnects.emit();
    await settle();
    waits().filter((t) => t.active).slice(-1).forEach((t) => t.fn());
    await settle();
    // The flap: this connection says hello and is gone by the next loop turn.
    h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
    await settle();
  }

  assert.equal(waits().length, 4,
    "a helper that only ever says hello must still run out of re-dials");
  const statuses = h.runtimeMessages.filter((m) => m && m.type === "helper-status");
  assert.equal(statuses[statuses.length - 1].helper.state, "disconnected",
    "the exhausted budget must settle, not keep flapping");
});

// The other half of the same rule: a genuinely healthy helper that drops must
// still get a fresh budget. Pongs only come back in answer to a ping, and the
// only ping sent long after the port was assigned is a heartbeat beat — so
// "answered a beat" is the durability signal, and this is what proves the
// budget is restored rather than removed.
test("a connection that outlives a heartbeat beat earns a fresh budget", async () => {
  const h = createHarness();
  h.load();
  h.settingsLoad.resolve({ settings: {} });
  await settle();
  h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
  await settle();

  const waits = () => h.timers.filter((t) => t.kind === "timeout" && t.name === "nativeRedial");
  for (let i = 0; i < 3; i += 1) {
    h.nativeDisconnects.emit();
    await settle();
    waits().filter((t) => t.active).slice(-1).forEach((t) => t.fn());
    await settle();
    h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
    await settle();
  }
  assert.deepEqual(waits().map((t) => t.ms), [1000, 4000, 15000],
    "three flaps burn three backoff steps");

  // This connection is still answering half a minute later.
  h.advanceClock(31000);
  h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
  await settle();
  h.nativeDisconnects.emit();
  await settle();

  assert.equal(waits().length, 4, "the drop after a durable connection re-dials");
  assert.equal(waits()[3].ms, 1000,
    "a connection that lasted must back off from scratch, not from where the flapping left off");
});

// The scheduling site clears any pending re-dial timer before arming a new
// one (`if (nativeRedialTimer !== null) clearTimeout(nativeRedialTimer);`),
// so two overlapping schedule attempts cannot leave two live timers ticking
// at once. Reaching a second schedule attempt while the first is still
// pending needs a reconnect that did NOT come from that pending timer
// itself — the timer always clears its own handle before it reconnects, so
// nothing else is ever waiting to race it. background.js's own entry points
// land on the vm global (see createHarness's `sandbox`), so connectNative()
// is driven directly here to stand in for such a reconnect.
test("overlapping disconnects clear the previous re-dial instead of stacking it", async () => {
  const h = createHarness();
  h.load();
  h.settingsLoad.resolve({ settings: {} });
  await settle();
  h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
  await settle();

  const redials = () => h.timers.filter((t) => t.kind === "timeout" && t.name === "nativeRedial");
  const pending = () => redials().filter((t) => t.active);

  h.nativeDisconnects.emit();
  await settle();
  assert.equal(pending().length, 1, "the first drop schedules one pending re-dial");
  const firstTimer = pending()[0];

  h.sandbox.connectNative();
  await settle();
  h.nativeDisconnects.emit();
  await settle();

  assert.equal(firstTimer.active, false, "the earlier pending re-dial must be cleared, not left live");
  assert.equal(pending().length, 1, "the second drop must not stack a second live re-dial");
});

// Every YouTube click minted a fresh id and spawned another yt-dlp writing to
// the SAME output path. Two of them then fought over one .part file
// ("WinError 32: used by another process"), one wedged, and cancelling a row
// stopped only its own job while the others kept reporting — which is what
// "cancel doesn't work, it keeps re-adding" actually was.
test("a second click on a downloading YouTube URL does not start a second yt-dlp", async () => {
  const h = createHarness();
  h.load();
  h.settingsLoad.resolve({ settings: {} });
  await settle();
  h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
  await settle();

  const item = { url: "https://www.youtube.com/watch?v=DUP", kind: "youtube", name: "dup" };
  const ytdls = () => h.nativePosts.filter((p) => p && p.cmd === "ytdl");

  await h.sandbox.downloadYouTube(item, 7, "dup.mp4", {});
  await settle();
  assert.equal(ytdls().length, 1, "the first click starts the download");

  await h.sandbox.downloadYouTube(item, 7, "dup.mp4", {});
  await settle();
  assert.equal(ytdls().length, 1,
    "a second click on the same URL must not spawn a competing yt-dlp");
});

// Cancel travels to the helper while the helper's frames travel back, so a
// progress frame written before the cancel arrived is delivered after the row
// was already marked cancelled. ytdl-error consults the local flag; ytdl-progress
// did not, so that straggler put the row back on "downloading" — and the wedge it
// was cancelled for is precisely the case where no terminal frame follows to
// correct it. YT_IN_FLIGHT then reads the row as still owning its output path and
// refuses every retry of that URL, which is the stuck row users could not clear.
test("a straggling progress frame does not put a cancelled YouTube row back in flight", async () => {
  const h = createHarness();
  h.load();
  h.settingsLoad.resolve({ settings: {} });
  await settle();
  h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
  await settle();

  const item = { url: "https://www.youtube.com/watch?v=WEDGE", kind: "youtube", name: "wedged" };
  const ytdls = () => h.nativePosts.filter((p) => p && p.cmd === "ytdl");

  await h.sandbox.downloadYouTube(item, 7, "wedged.mp4", {});
  await settle();
  assert.equal(ytdls().length, 1, "the download starts");
  const id = ytdls()[0].id;

  // Bytes flowed and the merge began — the last thing the helper says before
  // ffmpeg wedges and lib.download stops returning.
  h.nativeMessages.emit({ type: "ytdl-progress", id, pct: 99, stage: "merging" });
  await settle();

  h.sandbox.browser.runtime.onMessage.emit({ type: "cancel", id }, {}, () => {});
  await settle();
  const updates = h.runtimeMessages.filter(
    (m) => m && m.type === "download-update" && m.download && m.download.id === id);
  assert.ok(updates.length, "the row is broadcast");
  // Broadcasts carry the live row object, so this reads its current state.
  const row = updates[updates.length - 1].download;
  assert.equal(row.status, "cancelled", "the cancel must settle the row");
  assert.equal(h.nativePosts.filter((p) => p && p.cmd === "pget-cancel").length, 1,
    "the cancel must also reach the helper");

  h.nativeMessages.emit({ type: "ytdl-progress", id, pct: 99, stage: "merging" });
  await settle();
  assert.equal(row.status, "cancelled",
    "a frame the helper sent before it saw the cancel put the row back in flight");

  await h.sandbox.downloadYouTube(item, 7, "wedged.mp4", {});
  await settle();
  assert.equal(ytdls().length, 2,
    "the same URL must be startable again once the row is cancelled");
});

// The helper reports real bytes twice: `total` on every ytdl-progress frame and
// `bytes` on ytdl-done. The row kept neither. progress.total was overwritten
// with the literal 100 the percent bar divides by, and the terminal frame's
// size went to the notification and was then dropped — so once progress
// stopped there was nothing left on the row for either pane to render, and a
// finished YouTube download showed no size at all.
test("a YouTube row keeps the helper's byte total and its finished size", async () => {
  const h = createHarness();
  h.load();
  h.settingsLoad.resolve({ settings: {} });
  await settle();
  h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
  await settle();

  const item = { url: "https://www.youtube.com/watch?v=SIZE", kind: "youtube", name: "sized" };
  await h.sandbox.downloadYouTube(item, 7, "sized.mp4", {});
  await settle();
  const id = h.nativePosts.filter((p) => p && p.cmd === "ytdl")[0].id;

  const row = () => {
    const updates = h.runtimeMessages.filter(
      (m) => m && m.type === "download-update" && m.download && m.download.id === id);
    assert.ok(updates.length, "the row is broadcast");
    return updates[updates.length - 1].download;
  };

  h.nativeMessages.emit({ type: "ytdl-progress", id, pct: 12.5, total: 1181116006, bps: 4194304 });
  await settle();
  const live = row();
  assert.equal(live.progress.unit, "pct", "the bar stays percent-scaled");
  assert.equal(live.progress.total, 100, "the percent denominator is untouched");
  assert.equal(live.progress.totalBytes, 1181116006,
    "the helper's byte total must ride alongside the percent scale");

  // The helper stops reporting a total once the merge starts; the last one it
  // gave is still the size of the file being written.
  h.nativeMessages.emit({ type: "ytdl-progress", id, pct: 99, stage: "merging" });
  await settle();
  assert.equal(row().progress.totalBytes, 1181116006,
    "a frame with no total must not erase the total already known");

  h.nativeMessages.emit({ type: "ytdl-done", id, bytes: 1181116006,
                          file: "C:\\Users\\x\\Downloads\\sized.mp4" });
  await settle();
  const done = row();
  assert.equal(done.status, "done");
  assert.equal(done.recorded && done.recorded.bytes, 1181116006,
    "a finished row must still know its size after progress stops");
});

// The extension's half of the BadApple lane. It names the FILE and nothing
// else: if a frame from here could carry a program, the host's fixed candidate
// list would be decoration — write a file anywhere, then ask the helper to run
// it. Unlisted keys are ignored rather than refused on both sides of the port,
// so the proof that they are inert is that none of them reaches the frame.
test("the BadApple frame names the file and never a program", async () => {
  const h = createHarness();
  h.load();
  h.settingsLoad.resolve({ settings: {} });
  await settle();
  h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true, badapple: true });
  await settle();

  // Whether BadApple exists is the HELPER's answer, relayed to the popup —
  // the popup never goes looking for it, which is why it cannot name it.
  const status = h.runtimeMessages.filter((m) => m && m.type === "helper-status");
  assert.ok(status.length, "the helper's status reaches the popup");
  assert.equal(status[status.length - 1].helper.badapple, true);

  let answered = null;
  h.sandbox.browser.runtime.onMessage.emit({
    type: "open-in-badapple",
    path: "C:\\Users\\x\\Downloads\\clip.mp4",
    // Every shape a caller might hope the handler forwards.
    exe: "C:\\Users\\x\\Downloads\\payload.exe",
    app: "C:\\Users\\x\\Downloads\\payload.exe",
    argv: ["C:\\Users\\x\\Downloads\\payload.exe"],
  }, {}, (r) => { answered = r; });
  await settle();

  const posts = h.nativePosts.filter((p) => p && p.cmd === "badapple");
  assert.equal(posts.length, 1, "one frame reaches the helper");
  // Key-by-key rather than deepEqual: the frame is built inside the vm realm,
  // so its prototype is not this realm's and deepStrictEqual would fail on
  // two objects that are otherwise identical.
  assert.deepEqual(Object.keys(posts[0]).sort(), ["cmd", "path"],
    "exactly two keys, and neither of them names a program to run");
  assert.equal(posts[0].path, "C:\\Users\\x\\Downloads\\clip.mp4");
  assert.equal(JSON.stringify(posts[0]).toLowerCase().includes("payload.exe"), false,
    "nothing the caller added rode along");
  assert.equal(answered && answered.ok, true);
});

// A file the user can see but the helper cannot reach is a failure the UI has
// to be able to say out loud, so the popup gets an error rather than silence.
test("BadApple with no helper answers with an error, not silence", async () => {
  const h = createHarness();
  h.load();
  h.settingsLoad.resolve({ settings: {} });
  await settle();

  let answered = null;
  h.sandbox.browser.runtime.onMessage.emit(
    { type: "open-in-badapple", path: "C:\\Users\\x\\Downloads\\clip.mp4" },
    {}, (r) => { answered = r; });
  await settle();

  assert.equal(h.nativePosts.filter((p) => p && p.cmd === "badapple").length, 0);
  assert.equal(answered && answered.ok, false, "the click is answered");
  assert.match(String(answered && answered.error), /helper/i);
});

// open / reveal / badapple are all sent without an id, so a refusal from any of
// them names no row. It used to be dropped where the row lookup fails, which
// made "BadApple is not installed" indistinguishable from a button that did
// nothing at all.
test("a host error naming no row is logged rather than dropped", async () => {
  const h = createHarness();
  h.load();
  h.settingsLoad.resolve({ settings: {} });
  await settle();
  h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
  await settle();

  h.nativeMessages.emit({ type: "error", error: "BadApple is not installed on this computer." });
  await settle();

  const lines = h.runtimeMessages.filter((m) => m && m.type === "log-line");
  const last = lines[lines.length - 1];
  assert.ok(last, "the refusal reached the log console");
  assert.equal(last.line.level, "error");
  assert.match(last.line.msg, /BadApple is not installed/);
});

// ---------------------------------------------------------------------------
// The beam lane: the overlay's click, resolved and sent.
//
// The popup's BadApple button names a file this host wrote. The overlay names
// an ADDRESS a page is playing, which is a different frame (`url`, never
// `path` — the two are mutually exclusive on the host) and a different
// failure mode: the address frequently does not exist, because an MSE-fed
// <video> has a blob: currentSrc. Resolution therefore happens HERE, where the
// tab's detected media lives; the content script never sees that list.
// ---------------------------------------------------------------------------

function beamSender(tabId, frameId) {
  return { tab: { id: tabId, url: "https://site.example/watch" }, frameId: frameId || 0 };
}

async function seedDetected(h, tabId, item) {
  h.sandbox.browser.runtime.onMessage.emit(
    { type: "content-media", item }, beamSender(tabId), () => {});
  await settle();
  await settle();
}

async function beam(h, src, sender) {
  let answered = null;
  h.sandbox.browser.runtime.onMessage.emit(
    { type: "beam-video", src }, sender, (r) => { answered = r; });
  await settle();
  await settle();
  return answered;
}

async function readyHarness() {
  const h = createHarness();
  h.load();
  h.settingsLoad.resolve({ settings: {} });
  await settle();
  h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true, badapple: true });
  await settle();
  return h;
}

test("a beam of the element's own address reaches the helper as a url frame", async () => {
  const h = await readyHarness();
  const answered = await beam(h, "https://cdn.example/progressive.mp4", beamSender(7));

  const posts = h.nativePosts.filter((p) => p && p.cmd === "badapple");
  assert.equal(posts.length, 1, "one frame reaches the helper");
  assert.deepEqual(Object.keys(posts[0]).sort(), ["cmd", "id", "url"],
    "a url beam names no path — the host refuses a frame carrying both");
  assert.equal(posts[0].url, "https://cdn.example/progressive.mp4");
  assert.ok(posts[0].id, "an id, or a refusal has nothing to come back to");
  assert.equal(answered && answered.ok, true);
});

test("a blob: element src is answered from the tab's detected media", async () => {
  const h = await readyHarness();
  await seedDetected(h, 7, {
    kind: "direct", url: "https://cdn.example/feature.mp4", ts: 5, source: "network",
  });

  const answered = await beam(h, "blob:https://site.example/9f1c", beamSender(7));
  const posts = h.nativePosts.filter((p) => p && p.cmd === "badapple");
  assert.equal(posts.length, 1, "the fallback found something to send");
  assert.equal(posts[0].url, "https://cdn.example/feature.mp4");
  assert.equal(answered && answered.ok, true);
  assert.equal(answered.source, "detected");
});

test("a blob: with nothing detected is refused with a reason, not sent", async () => {
  const h = await readyHarness();
  const answered = await beam(h, "blob:https://site.example/9f1c", beamSender(7));

  assert.equal(h.nativePosts.filter((p) => p && p.cmd === "badapple").length, 0,
    "a blob: never crosses the port — it means nothing outside the page");
  assert.equal(answered && answered.ok, false);
  assert.match(String(answered.error), /blob:/,
    "the click is answered with why, not with silence");
});

test("another tab's detected media is never beamed into this one", async () => {
  const h = await readyHarness();
  await seedDetected(h, 8, { kind: "hls", url: "https://cdn.example/other-tab.m3u8", ts: 5 });

  const answered = await beam(h, "blob:https://site.example/9f1c", beamSender(7));
  assert.equal(h.nativePosts.filter((p) => p && p.cmd === "badapple").length, 0);
  assert.equal(answered && answered.ok, false);
});

test("a beam from outside a tab is refused before anything is resolved", async () => {
  const h = await readyHarness();
  const answered = await beam(h, "https://cdn.example/a.mp4", {});
  assert.equal(h.nativePosts.filter((p) => p && p.cmd === "badapple").length, 0);
  assert.equal(answered && answered.ok, false);
});

test("a beam with no helper answers with an error, not silence", async () => {
  const h = createHarness();
  h.load();
  h.settingsLoad.resolve({ settings: {} });
  await settle();

  const answered = await beam(h, "https://cdn.example/a.mp4", beamSender(7));
  assert.equal(h.nativePosts.filter((p) => p && p.cmd === "badapple").length, 0);
  assert.equal(answered && answered.ok, false);
  assert.match(String(answered.error), /helper/i);
});

test("the beam frame carries no field a caller hoped would name a program", async () => {
  const h = await readyHarness();
  let answered = null;
  const payload = "C:\\Users\\x\\Downloads\\payload.exe";
  h.sandbox.browser.runtime.onMessage.emit({
    type: "beam-video",
    src: "https://cdn.example/a.mp4",
    path: payload, exe: payload, app: payload, argv: [payload],
  }, beamSender(7), (r) => { answered = r; });
  await settle();
  await settle();

  const posts = h.nativePosts.filter((p) => p && p.cmd === "badapple");
  assert.equal(posts.length, 1);
  assert.deepEqual(Object.keys(posts[0]).sort(), ["cmd", "id", "url"]);
  assert.equal(JSON.stringify(posts[0]).toLowerCase().includes("payload.exe"), false);
  assert.equal(answered && answered.ok, true);
});

// The defect this lane already produced once: a refusal with no id fell out of
// the router into silence. An id is only half the fix — the answer also has to
// reach the FRAME that asked, and runtime.sendMessage does not go to content
// scripts.
test("a host refusal for a beam reaches the frame that asked for it", async () => {
  const h = await readyHarness();
  await beam(h, "https://cdn.example/a.mp4", beamSender(7, 3));
  const post = h.nativePosts.filter((p) => p && p.cmd === "badapple")[0];

  h.nativeMessages.emit({
    type: "error", id: post.id,
    error: "BadApple is not installed on this computer.",
  });
  await settle();

  const delivered = h.tabMessages.filter(
    (m) => m.message && m.message.type === "beam-result");
  assert.equal(delivered.length, 1, "the refusal was routed back to the overlay");
  assert.equal(delivered[0].tabId, 7);
  assert.equal(delivered[0].options && delivered[0].options.frameId, 3,
    "to the subframe that asked, not the top frame");
  assert.equal(delivered[0].message.ok, false);
  assert.match(delivered[0].message.error, /BadApple is not installed/);

  const lines = h.runtimeMessages.filter((m) => m && m.type === "log-line");
  assert.match(String(lines[lines.length - 1].line.msg), /BadApple is not installed/,
    "and is still on the record in the log console");
});

// The beam is a NEW place a media address enters the log ring, and the ring is
// persisted and copyable. It goes through the same projection every other
// logged address does, so the signed query does not travel with it.
test("the beam's log line keeps no signed query", async () => {
  const h = await readyHarness();
  await beam(h, "https://cdn.example/live/master.m3u8?token=SIGNED_SENTINEL", beamSender(7));

  const lines = h.runtimeMessages.filter((m) => m && m.type === "log-line");
  const beamLine = lines.filter((m) => /beam/i.test(String(m.line.msg))).pop();
  assert.ok(beamLine, "a beam is worth a log line — a click that did nothing needs one");
  assert.equal(String(beamLine.line.msg).includes("SIGNED_SENTINEL"), false,
    "the token that authorises the stream is not diagnostic information");
});

test("a beam a second refusal cannot name twice is forgotten", async () => {
  const h = await readyHarness();
  await beam(h, "https://cdn.example/a.mp4", beamSender(7));
  const post = h.nativePosts.filter((p) => p && p.cmd === "badapple")[0];

  h.nativeMessages.emit({ type: "error", id: post.id, error: "first" });
  await settle();
  h.nativeMessages.emit({ type: "error", id: post.id, error: "second" });
  await settle();

  const delivered = h.tabMessages.filter(
    (m) => m.message && m.message.type === "beam-result");
  assert.equal(delivered.length, 1, "the pending beam is claimed once and dropped");

  // A beam the helper never answers must not sit in the map forever: success
  // is SILENT on this command, so every successful beam would otherwise leak
  // an entry.
  const forget = h.timers.filter((t) => t.name === "forgetBeam");
  assert.equal(forget.length, 1, "an expiry is armed when the beam is sent");
  assert.ok(forget[0].ms > 0);
});

test("the live controller is driven by a clock", async () => {
  const h = createHarness();
  h.load();
  h.settingsLoad.resolve({ settings: {} });
  await settle();

  const clock = h.timers.find((t) => t.kind === "interval" && t.ms === 1000);
  assert.ok(clock, "expected a 1s interval driving the controller");

  const before = h.ticks.length;
  clock.fn();
  assert.equal(h.ticks.length, before + 1);
  assert.equal(typeof h.ticks[h.ticks.length - 1], "number");

  // A throwing tick must not stop the clock, or every later expiry goes unobserved.
  h.setTickError(new Error("boom"));
  assert.doesNotThrow(() => clock.fn());
  h.setTickError(null);
  const afterThrow = h.ticks.length;
  clock.fn();
  assert.equal(h.ticks.length, afterThrow + 1);
});

test("a connected helper keeps being pinged, not only at connect", async () => {
  const h = createHarness();
  h.load();
  h.settingsLoad.resolve({ settings: {} });
  await settle();
  h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
  await settle();

  const pings = () => h.nativePosts.filter((p) => p && p.cmd === "ping").length;
  const before = pings();

  const beat = h.timers.find((t) => t.kind === "interval" && t.ms === 30000);
  assert.ok(beat, "expected a heartbeat interval after the handshake");
  beat.fn();
  assert.equal(pings(), before + 1, "the heartbeat must ping a connected helper");
});

// The heartbeat was send-only: no last-pong timestamp, no missed-beat counter,
// and no timer that fires when a pong does NOT arrive. Its only failure
// handling was a log line — it never touched nativeState. A host that wedges
// while keeping the pipe open (a hung ffmpeg subprocess, say) therefore left
// the pill green and nativeReady true while every job posted into it was
// swallowed forever.
//
// The answer is to stop CLAIMING the helper is usable, not to disconnect it.
// EOF makes the host's read loop run cleanup_file_sinks() — which deletes every
// live sink's .part — and orphan the children it spawned, so disconnecting a
// helper that is merely slow destroys in-flight downloads.
test("a helper that stops answering stops being reported as ready", async () => {
  const h = createHarness();
  h.load();
  h.settingsLoad.resolve({ settings: {} });
  await settle();
  h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
  await settle();

  const statuses = () => h.runtimeMessages.filter((m) => m && m.type === "helper-status");
  assert.equal(statuses().at(-1).helper.state, "ready", "the handshake leaves the pill green");

  const beat = h.timers.find((t) => t.kind === "interval" && t.ms === 30000 && t.active);
  assert.ok(beat, "expected a heartbeat interval after the handshake");
  // The pipe stays open and nothing ever comes back.
  for (let i = 0; i < 6; i += 1) {
    beat.fn();
    await settle();
  }

  const last = statuses().at(-1);
  assert.notEqual(last.helper.state, "ready", "a wedged helper must not still read ready");
  assert.equal(last.helper.ready, false,
    "nativeReady gates every new job — a silent helper must not be handed more");
  assert.ok(last.helper.error, "the pill must say why, not just go amber");

  // Nothing was destroyed: the port is still open, in-flight work still owns
  // its files, and the policy controller was never told the helper went away.
  assert.equal(h.helperDisconnects.length, 0,
    "a slow helper must not be failed like a disconnected one");
  assert.equal(
    h.timers.filter((t) => t.kind === "timeout" && t.name === "nativeRedial").length, 0,
    "leaving the port open means there is nothing to re-dial");
  const pinged = h.nativePosts.filter((post) => post && post.cmd === "ping").length;
  beat.fn();
  await settle();
  assert.equal(h.nativePosts.filter((post) => post && post.cmd === "ping").length, pinged + 1,
    "the beats must keep going out, or a recovering helper could never answer");
});

// …and the recovery that leaving the port open buys: a helper that was only
// slow answers a later beat and the pill goes back to green by itself, with
// nothing asked of the user.
test("a late pong restores a helper the heartbeat had reported unusable", async () => {
  const h = createHarness();
  h.load();
  h.settingsLoad.resolve({ settings: {} });
  await settle();
  h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
  await settle();

  const statuses = () => h.runtimeMessages.filter((m) => m && m.type === "helper-status");
  const beat = h.timers.find((t) => t.kind === "interval" && t.ms === 30000 && t.active);
  assert.ok(beat, "expected a heartbeat interval after the handshake");
  for (let i = 0; i < 6; i += 1) {
    beat.fn();
    await settle();
  }
  assert.equal(statuses().at(-1).helper.ready, false, "the silence is reported");

  // The helper catches up and answers one of the beats it has been ignoring.
  h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
  await settle();

  const last = statuses().at(-1);
  assert.equal(last.helper.state, "ready", "a late pong must restore the helper by itself");
  assert.equal(last.helper.ready, true);
  assert.equal(last.helper.error, null, "the stale explanation must be cleared with it");

  // And the counter really was cleared, not merely masked by the status. The
  // report fires on the beat that makes the count EQUAL the threshold, so a
  // counter left holding its old value simply climbs past and never reports
  // again — proving the reset means showing the next silent stretch takes a
  // fresh full four beats to be noticed, no more and no fewer.
  for (let i = 0; i < 3; i += 1) {
    beat.fn();
    await settle();
  }
  assert.equal(statuses().at(-1).helper.state, "ready",
    "three unanswered beats are not yet enough to report again");
  beat.fn();
  await settle();
  assert.equal(statuses().at(-1).helper.ready, false,
    "the fourth is — the count restarted from zero rather than carrying on");
});

// Leaving the port open costs the user their only automatic way back: a live
// port is never re-dialled, and re-pinging one the heartbeat has already given
// up on is exactly what the beats are doing. So the manual re-check reconnects
// instead. It is the ONE place allowed to drop a live port, and only because a
// person asked for it — the drop ends in-flight work, which is why no timer
// may ever reach for it.
test("an explicit re-check reconnects a helper the heartbeat gave up on", async () => {
  const h = createHarness();
  h.load();
  h.settingsLoad.resolve({ settings: {} });
  await settle();
  h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
  await settle();

  const statuses = () => h.runtimeMessages.filter((m) => m && m.type === "helper-status");
  const beat = h.timers.find((t) => t.kind === "interval" && t.ms === 30000 && t.active);
  for (let i = 0; i < 4; i += 1) {
    beat.fn();
    await settle();
  }
  assert.equal(statuses().at(-1).helper.ready, false, "the helper is reported unusable");
  assert.match(statuses().at(-1).helper.error, /re-check/i,
    "the pill must say what the user can do, and what it costs");

  const listenersBefore = h.nativeDisconnects.size;
  h.sandbox.recheckHelper();
  await settle();

  // A fresh port, not another ping into the one that stopped answering.
  assert.equal(h.nativeDisconnects.size, 1,
    "the re-check must dial a new port rather than re-ping the wedged one");
  assert.equal(listenersBefore, 1, "(the wedged port had one listener of its own)");
  assert.equal(h.helperDisconnects.length, 1,
    "the drop the user asked for runs the ordinary disconnect cleanup");
  assert.equal(
    h.timers.filter((t) => t.kind === "timeout" && t.name === "nativeRedial" && t.active).length, 0,
    "an immediate reconnect must not also leave a backoff timer ticking");

  h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
  await settle();
  assert.equal(statuses().at(-1).helper.state, "ready", "the new connection comes up ready");
});

// The same re-check on a helper that is merely between connections, or
// answering normally, must stay the cheap one it has always been: no port is
// dropped and nothing in flight is disturbed.
test("an explicit re-check on an answering helper only re-pings it", async () => {
  const h = createHarness();
  h.load();
  h.settingsLoad.resolve({ settings: {} });
  await settle();
  h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
  await settle();

  const pings = () => h.nativePosts.filter((post) => post && post.cmd === "ping").length;
  const before = pings();
  h.sandbox.recheckHelper();
  await settle();

  assert.equal(pings(), before + 1, "a healthy helper is simply pinged");
  assert.equal(h.helperDisconnects.length, 0, "nothing in flight may be disturbed");
  const last = h.runtimeMessages.filter((m) => m && m.type === "helper-status").at(-1);
  assert.equal(last.helper.state, "ready", "and the pill is left alone");
});

// Falsely reporting a working helper unusable would refuse new jobs for no
// reason, so the counter has to clear on every pong: an answered beat is never
// a missed one, however many beats have gone by.
test("a helper that keeps answering is never reported unusable", async () => {
  const h = createHarness();
  h.load();
  h.settingsLoad.resolve({ settings: {} });
  await settle();
  h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
  await settle();

  const beat = h.timers.find((t) => t.kind === "interval" && t.ms === 30000 && t.active);
  assert.ok(beat, "expected a heartbeat interval after the handshake");
  for (let i = 0; i < 12; i += 1) {
    beat.fn();
    h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
    await settle();
  }

  const statuses = h.runtimeMessages.filter((m) => m && m.type === "helper-status");
  assert.equal(statuses[statuses.length - 1].helper.state, "ready",
    "an answering helper must stay ready");
  assert.equal(h.helperDisconnects.length, 0, "an answering helper must not be dropped");
  assert.equal(
    h.timers.filter((t) => t.kind === "timeout" && t.name === "nativeRedial").length, 0,
    "an answering helper must not be re-dialled");
});

// The mirror of the same hole: the heartbeat used to be armed inside the pong
// handler, so a port that connected and never answered the FIRST ping armed no
// heartbeat at all and sat on a bare "connecting" with nothing ever said about
// it again. Arming at the one site that assigns a port covers it with the same
// counter — and, like the wedge case, the answer is to explain rather than to
// disconnect: a host can be slow to start for the same reasons it can be slow
// to answer.
test("a port that never answers its first ping says so instead of waiting silently", async () => {
  const h = createHarness();
  h.load();
  h.settingsLoad.resolve({ settings: {} });
  await settle();

  const statuses = () => h.runtimeMessages.filter((m) => m && m.type === "helper-status");
  assert.equal(statuses().at(-1).helper.state, "connecting", "the connect attempt is pending");

  const beat = h.timers.find((t) => t.kind === "interval" && t.ms === 30000 && t.active);
  assert.ok(beat, "a connection must arm the heartbeat before it is ever answered");
  for (let i = 0; i < 6; i += 1) {
    beat.fn();
    await settle();
  }

  const last = statuses().at(-1);
  assert.equal(last.helper.ready, false, "an unanswered connection is never usable");
  assert.ok(last.helper.error,
    "a connection that never answers must explain itself, not wait in silence");
  assert.equal(h.helperDisconnects.length, 0, "and must not be torn down for it");
});

// The heartbeat sends the same `{cmd:"ping"}` the connect path does, so the
// host answers every beat with a full pong. Connection-time handshake work was
// keyed off pong arrival — which stopped being a per-connection event the
// moment the heartbeat existed. With autoUpdate on, every 30s beat re-ran the
// host's `handle_watch` (leaking a thread and a CreateFileW directory handle
// each time, because `stop_watch` only sets a flag the parked
// ReadDirectoryChangesW never re-reads) and re-hit the GitHub release API
// against a designed 6-hour interval — 120 calls/hour into a 60/hour
// unauthenticated budget, exhausted in about half an hour.
test("a heartbeat pong does not re-run the connection handshake", async () => {
  const h = createHarness();
  h.load();
  h.settingsLoad.resolve({ settings: { autoUpdate: true } });
  await settle();

  const handshakePosts = () => h.nativePosts.filter(
    (p) => p && (p.cmd === "watch" || p.cmd === "checkGithub")).length;

  h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
  await settle();
  assert.equal(handshakePosts(), 2, "the first pong of a connection does the handshake work");

  const beat = h.timers.find((t) => t.kind === "interval" && t.ms === 30000);
  assert.ok(beat, "expected a heartbeat interval after the handshake");
  for (let i = 0; i < 5; i += 1) {
    beat.fn();
    h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
    await settle();
  }

  assert.equal(handshakePosts(), 2,
    "heartbeat pongs must not re-post watch/checkGithub");
});

// mclog persists into a 500-entry ring and re-arms a full rewrite of it to
// storage.local, so an unconditional per-pong line is 120 writes an hour. With
// autoUpdate on the host adds two more per beat, rotating the whole ring in
// under 1.5 hours — a user told to "open the log console for yt-dlp's output"
// would find heartbeat noise and nothing else.
test("the helper-ready log line is written once per connection, not once per beat", async () => {
  const h = createHarness();
  h.load();
  h.settingsLoad.resolve({ settings: {} });
  await settle();

  const readyLines = () => h.runtimeMessages.filter(
    (m) => m && m.type === "log-line" && m.line && /helper ready/.test(m.line.msg)).length;

  h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
  await settle();
  assert.equal(readyLines(), 1, "the first pong announces the helper");

  const beat = h.timers.find((t) => t.kind === "interval" && t.ms === 30000);
  assert.ok(beat, "expected a heartbeat interval after the handshake");
  for (let i = 0; i < 5; i += 1) {
    beat.fn();
    h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
    await settle();
  }

  assert.equal(readyLines(), 1, "heartbeat pongs must not re-announce the helper");
});

// The guard is reset where a new port is assigned, not in the disconnect
// handler, so it is the arrival of a connection that re-arms the handshake —
// which is what keeps "once per connection" from degrading into "once ever".
// Every reconnect route (the re-dial timer and an explicit recheck-helper)
// passes through that one assignment.
test("a reconnect runs the connection handshake again rather than latching it off", async () => {
  const h = createHarness();
  h.load();
  h.settingsLoad.resolve({ settings: { autoUpdate: true } });
  await settle();

  const handshakePosts = () => h.nativePosts.filter(
    (p) => p && (p.cmd === "watch" || p.cmd === "checkGithub")).length;
  const readyLines = () => h.runtimeMessages.filter(
    (m) => m && m.type === "log-line" && m.line && /helper ready/.test(m.line.msg)).length;

  h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
  await settle();
  const beat = h.timers.find((t) => t.kind === "interval" && t.ms === 30000);
  beat.fn();
  h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
  await settle();
  assert.equal(handshakePosts(), 2, "the beat must not repeat the handshake");

  h.nativeDisconnects.emit();
  await settle();
  h.timers.filter((t) => t.kind === "timeout" && t.name === "nativeRedial" && t.active)
    .forEach((t) => t.fn());
  await settle();
  h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
  await settle();

  assert.equal(handshakePosts(), 4, "a new connection must re-run the handshake exactly once");
  assert.equal(readyLines(), 2, "a new connection must announce the helper again");
});

// The re-dial branch nulls nativePort and schedules a timer but used to change
// no state at all, so no helper-status went out: the pill stayed green ("ready")
// with no live port for the whole wait — up to 60s on the last backoff step —
// while downloadYouTube refused on `!nativePort`. The user saw "Helper ready"
// and "YouTube needs the native helper" at the same time.
test("a scheduled re-dial reports connecting instead of leaving the pill green", async () => {
  const h = createHarness();
  h.load();
  h.settingsLoad.resolve({ settings: {} });
  await settle();
  h.nativeMessages.emit({ type: "pong", version: "1.10.0", ffmpeg: true });
  await settle();

  const statuses = () => h.runtimeMessages.filter((m) => m && m.type === "helper-status");
  assert.equal(statuses().at(-1).helper.state, "ready", "the handshake leaves the pill green");

  h.nativeDisconnects.emit();
  await settle();

  // Deliberately do NOT fire the re-dial timer: this is the window the user
  // actually looks at, between the drop and the reconnect.
  const pending = h.timers.filter(
    (t) => t.kind === "timeout" && t.name === "nativeRedial" && t.active);
  assert.equal(pending.length, 1, "the drop must schedule a re-dial");

  const last = statuses().at(-1);
  assert.equal(last.helper.state, "connecting",
    "the wait before a re-dial must be reported as connecting");
  assert.equal(last.helper.ready, false, "nothing is connected during the wait");
});
