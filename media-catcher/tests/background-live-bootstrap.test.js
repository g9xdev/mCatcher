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
// handling was a log line — it never touched nativeState, never nulled
// nativePort and never scheduled a re-dial. A host that wedges while keeping
// the pipe open (a hung ffmpeg subprocess, say) therefore left the pill green
// and nativeReady true while every job posted into it was swallowed forever.
// The host answers ping from its message loop and runs every long command on a
// worker thread, so an unanswered beat means that loop itself is blocked.
test("a helper that stops answering the heartbeat is torn down and re-dialled", async () => {
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
  assert.equal(last.helper.ready, false, "nothing usable is connected");
  assert.equal(h.helperDisconnects.length, 1,
    "the teardown must run the same cleanup a real disconnect does");
  assert.equal(
    h.timers.filter((t) => t.kind === "timeout" && t.name === "nativeRedial").length, 1,
    "the teardown must hand over to the ordinary bounded re-dial");
});

// A false teardown of a working helper is worse than slow detection, so the
// counter has to clear on every pong: an answered beat is never a missed one,
// however many beats have gone by.
test("a helper that keeps answering is never torn down by the heartbeat", async () => {
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
// heartbeat at all and parked on "connecting" with no deadline — for the rest
// of the session. Arming at the one site that assigns a port closes it with
// the same mechanism rather than a second one.
test("a port that never answers its first ping does not park on connecting", async () => {
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
  assert.equal(last.helper.state, "disconnected",
    "a connection that never answers must settle instead of hanging on connecting");
  assert.equal(last.helper.ready, false);
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
