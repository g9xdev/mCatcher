"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const { loadLib, mediaCatcherRoot } = require("./harness/load-lib.js");
const P = loadLib("lib/privacy.js");

const SIGNED = "https://cdn.example/file.mp4?token=SECRET_SIGNED_QUERY_XYZ&exp=99";
const COOKIE = "session=SECRET_COOKIE_ABC";
const PUBLIC_KEYS = [
  "createEphemeral",
  "projectSafeHistory",
  "projectPopupJob",
  "redactUrlForLog",
  "assertNoSentinels",
  "clearEphemeralOnTerminal",
];

// --- Plan tests (Task 19 brief) ---

test("safe history allowlist excludes URLs and headers", () => {
  const hist = P.projectSafeHistory({
    intent: { requestedFilename: "11238-makemebi.net.mp4" },
    providerKey: "florenfile.com",
    state: "completed",
    bytes: 123,
    completedAt: 1,
    ephemeral: { mediaUrl: SIGNED, requestHeaders: { Cookie: COOKIE } },
    sourceContext: { topLevelPageUrl: "https://florenfile.com/x" },
  });
  const raw = JSON.stringify(hist);
  assert.equal(raw.includes("SECRET_SIGNED_QUERY_XYZ"), false);
  assert.equal(raw.includes("SECRET_COOKIE_ABC"), false);
  assert.equal(raw.includes("https://florenfile.com"), false);
  assert.equal(hist.requestedFilename, "11238-makemebi.net.mp4");
  assert.equal(hist.providerKey, "florenfile.com");
});

test("projectPopupJob never serializes ephemeral object", () => {
  const e = P.createEphemeral(SIGNED, { Cookie: COOKIE });
  const job = {
    id: "j1",
    state: "running",
    providerKey: "florenfile.com",
    intent: { requestedFilename: "a.mp4", destinationDirectory: null },
    ephemeral: e,
    sourceContext: { topLevelPageUrl: "https://florenfile.com/x", mediaOrigin: "https://cdn" },
  };
  const view = P.projectPopupJob(job);
  const raw = JSON.stringify(view);
  assert.equal(raw.includes("SECRET_SIGNED_QUERY_XYZ"), false);
  assert.equal(raw.includes("SECRET_COOKIE_ABC"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(view, "ephemeral"), false);
  assert.equal(view.requestedFilename, "a.mp4");
});

test("log redaction strips query strings", () => {
  assert.equal(P.redactUrlForLog(SIGNED).includes("SECRET_SIGNED_QUERY_XYZ"), false);
});

test("ephemeral clear nulls URL and headers", () => {
  const e = P.createEphemeral(SIGNED, { Cookie: COOKIE });
  e.clear();
  assert.equal(e.mediaUrl, null);
  assert.equal(e.requestHeaders, null);
});

test("terminal cleanup clears ephemeral on completed failed cancelled handed_to_firefox", () => {
  for (const state of ["completed", "failed", "cancelled", "handed_to_firefox"]) {
    const e = P.createEphemeral(SIGNED, { Cookie: COOKIE });
    const job = { ephemeral: e, state: "running" };
    P.clearEphemeralOnTerminal(job, state);
    assert.equal(e.mediaUrl, null, state);
    assert.equal(e.requestHeaders, null, state);
  }
  // Non-terminal states must not clear.
  const e2 = P.createEphemeral(SIGNED, { Cookie: COOKIE });
  const job2 = { ephemeral: e2, state: "running" };
  P.clearEphemeralOnTerminal(job2, "running");
  assert.equal(e2.mediaUrl, SIGNED);
  P.clearEphemeralOnTerminal(job2, "queued");
  assert.equal(e2.mediaUrl, SIGNED);
});

test("assertNoSentinels fails when signed query leaks", () => {
  assert.throws(() => P.assertNoSentinels(
    JSON.stringify({ url: SIGNED }),
    ["SECRET_SIGNED_QUERY_XYZ", "SECRET_COOKIE_ABC"]
  ));
  assert.doesNotThrow(() => P.assertNoSentinels(
    JSON.stringify({ requestedFilename: "a.mp4" }),
    ["SECRET_SIGNED_QUERY_XYZ", "SECRET_COOKIE_ABC"]
  ));
});

// --- Exact public surface + dual export ---

test("exports exactly the six public keys", () => {
  assert.deepEqual(Object.keys(P).sort(), PUBLIC_KEYS.slice().sort());
  for (const k of PUBLIC_KEYS) {
    assert.equal(typeof P[k], "function", k);
  }
});

test("dual-export assigns same api to module.exports and root.McPrivacy", () => {
  const abs = path.join(mediaCatcherRoot, "lib", "privacy.js");
  const code = fs.readFileSync(abs, "utf8");
  const root = {};
  const sandbox = { module: { exports: {} }, exports: {}, require, console, self: root };
  sandbox.module.exports = sandbox.exports;
  vm.runInNewContext(code, sandbox, { filename: abs });
  assert.equal(typeof sandbox.module.exports.createEphemeral, "function");
  assert.equal(typeof root.McPrivacy.createEphemeral, "function");
  assert.equal(root.McPrivacy, sandbox.module.exports);
  assert.deepEqual(Object.keys(root.McPrivacy).sort(), PUBLIC_KEYS.slice().sort());
});

// --- createEphemeral ---

test("createEphemeral freezes headers, hides own keys, JSON is {}", () => {
  const headers = { Cookie: COOKIE, "X-Auth": "tok" };
  const e = P.createEphemeral(SIGNED, headers);
  assert.equal(e.mediaUrl, SIGNED);
  assert.equal(e.requestHeaders.Cookie, COOKIE);
  assert.equal(Object.keys(e).length, 0);
  assert.equal(JSON.stringify(e), "{}");
  assert.equal(Object.getOwnPropertyDescriptor(e, "mediaUrl").enumerable, false);
  assert.equal(Object.getOwnPropertyDescriptor(e, "requestHeaders").enumerable, false);
  assert.equal(Object.getOwnPropertyDescriptor(e, "clear").enumerable, false);
  assert.ok(Object.isFrozen(e));
  assert.ok(Object.isFrozen(e.requestHeaders));
  headers.Cookie = "mutated";
  assert.equal(e.requestHeaders.Cookie, COOKIE);
  assert.throws(() => { e.requestHeaders.Cookie = "x"; });
});

test("createEphemeral rejects malformed url/headers without echoing secrets", () => {
  assert.throws(() => P.createEphemeral("", null), TypeError);
  assert.throws(() => P.createEphemeral("   ", null), TypeError);
  assert.throws(() => P.createEphemeral(null, null), TypeError);
  assert.throws(() => P.createEphemeral(new String(SIGNED), null), TypeError);
  assert.throws(() => P.createEphemeral(SIGNED, []), TypeError);
  assert.throws(() => P.createEphemeral(SIGNED, "Cookie: x"), TypeError);
  const polluted = Object.create({ Cookie: COOKIE });
  polluted.X = "y";
  // Prototype-only secret must not be accepted via inherited keys; own "X" is fine
  // but polluted prototype chain is non-plain when Object.prototype is not direct.
  assert.throws(() => P.createEphemeral(SIGNED, Object.create({ Cookie: COOKIE })), TypeError);
  const withAccessor = {};
  Object.defineProperty(withAccessor, "Cookie", {
    enumerable: true,
    get() { return COOKIE; },
  });
  assert.throws(() => P.createEphemeral(SIGNED, withAccessor), TypeError);
  try {
    P.createEphemeral(SIGNED, { Cookie: COOKIE, bad: 1 });
    assert.fail("expected throw");
  } catch (err) {
    assert.equal(String(err.message).includes("SECRET"), false);
    assert.equal(String(err.message).includes(COOKIE), false);
  }
  const ok = P.createEphemeral(SIGNED, null);
  assert.equal(ok.mediaUrl, SIGNED);
  assert.deepEqual(Object.keys(ok.requestHeaders), []);
  const ok2 = P.createEphemeral(SIGNED, undefined);
  assert.deepEqual(Object.keys(ok2.requestHeaders), []);
});

test("clear is idempotent and non-throwing", () => {
  const e = P.createEphemeral(SIGNED, { Cookie: COOKIE });
  e.clear();
  e.clear();
  assert.equal(e.mediaUrl, null);
  assert.equal(e.requestHeaders, null);
  assert.equal(JSON.stringify(e), "{}");
});

// --- clearEphemeralOnTerminal ---

test("terminal cleanup is idempotent across states and shared wrappers", () => {
  const e = P.createEphemeral(SIGNED, { Cookie: COOKIE });
  const jobA = { ephemeral: e };
  const jobB = { ephemeral: e };
  assert.equal(P.clearEphemeralOnTerminal(jobA, "completed"), true);
  assert.equal(e.mediaUrl, null);
  assert.equal(P.clearEphemeralOnTerminal(jobA, "failed"), false);
  assert.equal(P.clearEphemeralOnTerminal(jobB, "cancelled"), false);
  assert.equal(P.clearEphemeralOnTerminal(jobA, "handed_to_firefox"), false);
  // Fake that throws after first mark must not be re-invoked.
  let calls = 0;
  const fake = {
    clear() {
      calls += 1;
      throw new Error("SECRET_IN_THROW " + COOKIE);
    },
  };
  const jobF = { ephemeral: fake };
  assert.throws(() => P.clearEphemeralOnTerminal(jobF, "completed"), (err) => {
    assert.equal(String(err.message).includes("SECRET"), false);
    assert.equal(String(err.message).includes(COOKIE), false);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(P.clearEphemeralOnTerminal(jobF, "failed"), false);
  assert.equal(calls, 1);
  assert.equal(P.clearEphemeralOnTerminal({}, "completed"), false);
  assert.equal(P.clearEphemeralOnTerminal({ ephemeral: null }, "completed"), false);
  assert.equal(P.clearEphemeralOnTerminal(null, "completed"), false);
});

// --- projectSafeHistory ---

test("projectSafeHistory exact keys defaults and freeze; no secret sentinels", () => {
  const hist = P.projectSafeHistory({
    intent: { requestedFilename: "clip.mp4", destinationDirectory: "/secret/path" },
    providerKey: "florenfile.com",
    state: "completed",
    bytes: 42,
    completedAt: "2026-08-12T00:00:00.000Z",
    ephemeral: { mediaUrl: SIGNED, requestHeaders: { Cookie: COOKIE } },
    sourceContext: { topLevelPageUrl: "https://florenfile.com/x", mediaOrigin: "https://cdn" },
    url: SIGNED,
    mediaUrl: SIGNED,
    userActionToken: "SECRET_TOKEN",
    error: { message: "SECRET_ERR" },
  });
  assert.deepEqual(Object.keys(hist), [
    "requestedFilename",
    "providerKey",
    "status",
    "bytes",
    "ts",
  ]);
  assert.equal(hist.requestedFilename, "clip.mp4");
  assert.equal(hist.providerKey, "florenfile.com");
  assert.equal(hist.status, "completed");
  assert.equal(hist.bytes, 42);
  assert.equal(hist.ts, "2026-08-12T00:00:00.000Z");
  assert.ok(Object.isFrozen(hist));
  const raw = JSON.stringify(hist);
  assert.equal(raw.includes("SECRET"), false);
  assert.equal(raw.includes("Cookie"), false);
  assert.equal(raw.includes("florenfile.com/x"), false);
  assert.equal(raw.includes("/secret/path"), false);

  const defaults = P.projectSafeHistory({});
  assert.deepEqual(Object.keys(defaults), [
    "requestedFilename",
    "providerKey",
    "status",
    "bytes",
    "ts",
  ]);
  assert.equal(defaults.requestedFilename, "download");
  assert.equal(defaults.providerKey, "unknown");
  assert.equal(defaults.status, "unknown");
  assert.equal(defaults.bytes, 0);
  assert.equal(defaults.ts, null);

  const topName = P.projectSafeHistory({
    requestedFilename: "top.mp4",
    intent: { requestedFilename: "intent.mp4" },
    status: "failed",
    state: "completed",
    ts: "t1",
    completedAt: "t2",
  });
  assert.equal(topName.requestedFilename, "top.mp4");
  assert.equal(topName.status, "failed");
  assert.equal(topName.ts, "t1");

  // Hostile input must fail closed without reflecting secrets.
  const poison = {
    get requestedFilename() { return SIGNED; },
    get providerKey() { throw new Error(COOKIE); },
  };
  const closed = P.projectSafeHistory(poison);
  assert.equal(closed.requestedFilename, "download");
  assert.equal(closed.providerKey, "unknown");
  assert.equal(JSON.stringify(closed).includes("SECRET"), false);
});

// --- projectPopupJob ---

test("projectPopupJob allowlist Task-18 fields nested freeze and secret omission", () => {
  const e = P.createEphemeral(SIGNED, { Cookie: COOKIE, Authorization: "Bearer SECRET_TOK" });
  const progressSrc = { done: 1, total: 10, bps: 100, kbps: 0.1, duration: 2, unit: "B", stage: "dl", note: "n", evil: SIGNED };
  const recordedSrc = { bytes: 9, duration: 1.5, leak: COOKIE };
  const qualitySrc = { width: 1920, height: 1080, fps: 30, bitrate: 4e6, label: "1080p", codec: "avc1", url: SIGNED };
  const convertSrc = { codec: "h264", command: "ffmpeg", note: "ok", pct: 50, keptOriginal: true, secret: COOKIE };
  const job = {
    id: "j9",
    state: "running",
    status: "active",
    providerKey: "florenfile.com",
    intent: {
      requestedFilename: "from-intent.mp4",
      destinationDirectory: null,
      saveMode: "smart",
      createdAt: "2026-08-12T12:00:00.000Z",
      userActionToken: "SECRET_UAT",
      mediaUrl: SIGNED,
    },
    kind: "media",
    mode: "save",
    mediaKind: "mp4",
    reduced: false,
    error: "friendly",
    bytes: 1234,
    name: "n",
    live: false,
    native: true,
    hasAudio: true,
    savedPath: "C:\\Videos\\a.mp4",
    downloadId: 7,
    snapshots: 2,
    convertCodec: "h264",
    convertPct: 12.5,
    mergeCommand: "m",
    fixCommand: "f",
    stateVersion: 3,
    effectiveConcurrency: 2,
    retryRemaining: 1,
    retryUsed: 0,
    autoWakeCount: 0,
    inFlightPermits: 1,
    nativeOpenConnections: 0,
    progress: progressSrc,
    recorded: recordedSrc,
    quality: qualitySrc,
    convert: convertSrc,
    ephemeral: e,
    sourceContext: { topLevelPageUrl: "https://florenfile.com/x", mediaOrigin: "https://cdn" },
    url: SIGNED,
    mediaUrl: SIGNED,
    variantUrl: SIGNED + "#frag",
    userActionToken: "SECRET_UAT",
    attemptToken: "SECRET_ATTEMPT",
    headers: { Cookie: COOKIE },
    cookies: COOKIE,
    // Forbidden even if nested alias
    requestHeaders: { Cookie: COOKIE },
  };
  const view = P.projectPopupJob(job);
  assert.equal(view.id, "j9");
  assert.equal(view.state, "running");
  assert.equal(view.status, "active");
  assert.equal(view.providerKey, "florenfile.com");
  assert.equal(view.requestedFilename, "from-intent.mp4");
  assert.equal(view.destinationDirectory, null);
  assert.equal(view.saveMode, "smart");
  assert.equal(view.createdAt, "2026-08-12T12:00:00.000Z");
  assert.equal(view.kind, "media");
  assert.equal(view.bytes, 1234);
  assert.equal(view.downloadId, 7);
  assert.ok(Object.isFrozen(view));
  assert.ok(Object.isFrozen(view.progress));
  assert.ok(Object.isFrozen(view.recorded));
  assert.ok(Object.isFrozen(view.quality));
  assert.ok(Object.isFrozen(view.convert));
  assert.deepEqual(view.progress, {
    done: 1, total: 10, bps: 100, kbps: 0.1, duration: 2, unit: "B", stage: "dl", note: "n",
  });
  assert.deepEqual(view.recorded, { bytes: 9, duration: 1.5 });
  assert.deepEqual(view.quality, {
    width: 1920, height: 1080, fps: 30, bitrate: 4e6, label: "1080p", codec: "avc1",
  });
  assert.deepEqual(view.convert, {
    codec: "h264", command: "ffmpeg", note: "ok", pct: 50, keptOriginal: true,
  });
  // Nested copies must not alias mutable sources.
  progressSrc.done = 999;
  assert.equal(view.progress.done, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(view, "ephemeral"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(view, "sourceContext"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(view, "intent"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(view, "url"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(view, "mediaUrl"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(view, "userActionToken"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(view, "attemptToken"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(view, "headers"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(view, "cookies"), false);
  const raw = JSON.stringify(view);
  assert.equal(raw.includes("SECRET"), false);
  assert.equal(raw.includes("Cookie"), false);
  assert.equal(raw.includes("cdn.example"), false);
  assert.equal(raw.includes("florenfile.com/x"), false);

  // Top-level overrides intent for bind fields.
  const top = P.projectPopupJob({
    requestedFilename: "top.mp4",
    destinationDirectory: "D:\\out",
    saveMode: "as",
    createdAt: "t-top",
    intent: {
      requestedFilename: "i.mp4",
      destinationDirectory: "I:\\out",
      saveMode: "smart",
      createdAt: "t-intent",
    },
  });
  assert.equal(top.requestedFilename, "top.mp4");
  assert.equal(top.destinationDirectory, "D:\\out");
  assert.equal(top.saveMode, "as");
  assert.equal(top.createdAt, "t-top");

  // Empty nested projections omitted.
  const emptyNested = P.projectPopupJob({
    id: 1,
    progress: { evil: 1 },
    recorded: {},
    quality: { label: 123 },
    convert: { keptOriginal: "no" },
  });
  assert.equal(Object.prototype.hasOwnProperty.call(emptyNested, "progress"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(emptyNested, "recorded"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(emptyNested, "quality"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(emptyNested, "convert"), false);

  // Accessor trap on optional field must not leak.
  const trap = {
    id: "t",
    get error() { return "SECRET_VIA_GETTER " + COOKIE; },
    get state() { throw new Error(SIGNED); },
  };
  const trapped = P.projectPopupJob(trap);
  assert.equal(trapped.id, "t");
  // Either omit or generic fail — never include secret.
  if (Object.prototype.hasOwnProperty.call(trapped, "error")) {
    assert.equal(String(trapped.error).includes("SECRET"), false);
    assert.equal(String(trapped.error).includes(COOKIE), false);
  }
  assert.equal(JSON.stringify(trapped).includes("SECRET"), false);
  assert.equal(JSON.stringify(trapped).includes("SECRET_SIGNED"), false);
});

// --- redactUrlForLog ---

test("redactUrlForLog strips query fragment credentials and never coerces objects", () => {
  assert.equal(
    P.redactUrlForLog("https://user:pass@cdn.example:8443/a/b.mp4?token=SECRET_SIGNED_QUERY_XYZ#frag"),
    "https://cdn.example:8443/a/b.mp4"
  );
  assert.equal(
    P.redactUrlForLog("/rel/path?token=SECRET_SIGNED_QUERY_XYZ#x"),
    "/rel/path"
  );
  assert.equal(P.redactUrlForLog(SIGNED).includes("SECRET"), false);
  assert.equal(P.redactUrlForLog({ href: SIGNED }), "[redacted]");
  assert.equal(P.redactUrlForLog(null), "[redacted]");
  assert.equal(P.redactUrlForLog(undefined), "[redacted]");
  assert.equal(P.redactUrlForLog(123), "[redacted]");
  assert.equal(P.redactUrlForLog(""), "[redacted]");
});

// --- assertNoSentinels ---

test("assertNoSentinels never echoes secrets and rejects malformed input", () => {
  assert.equal(
    P.assertNoSentinels("clean payload", ["SECRET_SIGNED_QUERY_XYZ", "SECRET_COOKIE_ABC"]),
    true
  );
  try {
    P.assertNoSentinels("leak SECRET_SIGNED_QUERY_XYZ here", ["SECRET_SIGNED_QUERY_XYZ", "SECRET_COOKIE_ABC"]);
    assert.fail("expected throw");
  } catch (err) {
    const msg = String(err && err.message);
    assert.equal(msg.includes("SECRET"), false);
    assert.equal(msg.includes("SIGNED"), false);
    assert.match(msg, /0|index/i);
  }
  try {
    P.assertNoSentinels("x SECRET_COOKIE_ABC y", ["SECRET_SIGNED_QUERY_XYZ", "SECRET_COOKIE_ABC"]);
    assert.fail("expected throw");
  } catch (err) {
    const msg = String(err && err.message);
    assert.equal(msg.includes("SECRET_COOKIE"), false);
    assert.match(msg, /1|index/i);
  }
  assert.throws(() => P.assertNoSentinels({ x: 1 }, ["a"]), TypeError);
  assert.throws(() => P.assertNoSentinels("blob", null), TypeError);
  assert.throws(() => P.assertNoSentinels("blob", "SECRET"), TypeError);
  assert.throws(() => P.assertNoSentinels("blob", [""]), TypeError);
  assert.throws(() => P.assertNoSentinels("blob", [1]), TypeError);
});

// --- Task-19 fix: hostile privacy projection escapes ---

test("createEphemeral rejects own symbols accessors non-enumerable and non-string header shapes", () => {
  const sym = Symbol("SECRET_SYMBOL");
  const withSym = { A: "b" };
  withSym[sym] = "SECRET_COOKIE";
  assert.throws(() => P.createEphemeral(SIGNED, withSym), TypeError);

  const nonEnum = {};
  Object.defineProperty(nonEnum, "Cookie", {
    enumerable: false,
    value: "SECRET_COOKIE",
    writable: true,
    configurable: true,
  });
  assert.throws(() => P.createEphemeral(SIGNED, nonEnum), TypeError);

  const withAccessor = {};
  Object.defineProperty(withAccessor, "Cookie", {
    enumerable: true,
    configurable: true,
    get() { return "SECRET_COOKIE"; },
  });
  assert.throws(() => P.createEphemeral(SIGNED, withAccessor), TypeError);

  const nonStringVal = { Cookie: 123 };
  assert.throws(() => P.createEphemeral(SIGNED, nonStringVal), TypeError);

  // Only enumerable own primitive-string name/value pairs are copied.
  const ok = P.createEphemeral(SIGNED, { Cookie: COOKIE, "X-Auth": "tok" });
  assert.equal(ok.requestHeaders.Cookie, COOKIE);
  assert.equal(ok.requestHeaders["X-Auth"], "tok");
  assert.equal(Object.getPrototypeOf(ok.requestHeaders), null);
});

test("createEphemeral wraps hostile reflection traps with generic TypeError", () => {
  const stages = [
    {
      name: "getPrototypeOf",
      headers: new Proxy({}, {
        getPrototypeOf() { throw new Error("SECRET_PROXY"); },
      }),
    },
    {
      name: "ownKeys",
      headers: new Proxy({ A: "b" }, {
        getPrototypeOf() { return Object.prototype; },
        ownKeys() { throw new Error("SECRET_OWNKEYS"); },
        getOwnPropertyDescriptor() {
          return { configurable: true, enumerable: true, value: "b", writable: true };
        },
      }),
    },
    {
      name: "getOwnPropertyDescriptor",
      headers: new Proxy({ A: "b" }, {
        getPrototypeOf() { return Object.prototype; },
        ownKeys() { return ["A"]; },
        getOwnPropertyDescriptor() { throw new Error("SECRET_GOPD"); },
      }),
    },
  ];
  for (const stage of stages) {
    try {
      P.createEphemeral(SIGNED, stage.headers);
      assert.fail("expected TypeError for " + stage.name);
    } catch (err) {
      assert.ok(err instanceof TypeError, stage.name + " must be TypeError");
      const msg = String(err && err.message);
      assert.equal(msg.includes("SECRET"), false, stage.name + " leaked SECRET: " + msg);
      assert.equal(msg.includes("PROXY"), false, stage.name);
      assert.equal(msg.includes("OWNKEYS"), false, stage.name);
      assert.equal(msg.includes("GOPD"), false, stage.name);
    }
  }
});

test("clearEphemeralOnTerminal never invokes clear getters and never leaks trap text", () => {
  let gets = 0;
  const eph = {
    get clear() {
      gets++;
      throw new Error("SECRET_CLEAR_GETTER");
    },
  };
  assert.equal(P.clearEphemeralOnTerminal({ ephemeral: eph }, "failed"), false);
  assert.equal(gets, 0);

  // Inherited clear getter must not be invoked.
  let inheritedGets = 0;
  const proto = {
    get clear() {
      inheritedGets++;
      throw new Error("SECRET_INHERITED_CLEAR");
    },
  };
  const inherited = Object.create(proto);
  assert.equal(P.clearEphemeralOnTerminal({ ephemeral: inherited }, "completed"), false);
  assert.equal(inheritedGets, 0);

  // Malformed clear shapes return false without invoking accessors.
  assert.equal(P.clearEphemeralOnTerminal({
    ephemeral: Object.defineProperty({}, "clear", {
      enumerable: true,
      get() { throw new Error("SECRET_CLEAR_ACCESSOR"); },
    }),
  }, "cancelled"), false);

  // Proxy traps: either false or generic cleanup error without hostile text.
  try {
    const r = P.clearEphemeralOnTerminal({
      ephemeral: new Proxy({}, {
        getOwnPropertyDescriptor() { throw new Error("SECRET_CLEAR_PROXY"); },
        get() { throw new Error("SECRET_CLEAR_PROXY"); },
      }),
    }, "failed");
    assert.equal(r, false);
  } catch (err) {
    const msg = String(err && err.message);
    assert.equal(msg.includes("SECRET"), false);
    assert.equal(msg.includes("PROXY"), false);
    assert.match(msg, /cleanup failed|ephemeral/i);
  }

  // Throwing data-function clear is called at most once and rethrown generically.
  let calls = 0;
  const thrower = {
    clear() {
      calls += 1;
      throw new Error("SECRET_CLEAR_THROW " + COOKIE);
    },
  };
  assert.throws(() => P.clearEphemeralOnTerminal({ ephemeral: thrower }, "completed"), (err) => {
    assert.equal(String(err.message).includes("SECRET"), false);
    assert.equal(String(err.message).includes(COOKIE), false);
    assert.match(String(err.message), /ephemeral cleanup failed/);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(P.clearEphemeralOnTerminal({ ephemeral: thrower }, "failed"), false);
  assert.equal(calls, 1);
});

test("projectPopupJob redacts secret-bearing error and optional string fields", () => {
  const view = P.projectPopupJob({
    id: "j",
    state: "failed",
    error: "GET https://cdn.example/f.mp4?token=SECRET_SIGNED_QUERY_XYZ Cookie: SECRET_COOKIE",
  });
  const raw = JSON.stringify(view);
  assert.equal(raw.includes("SECRET_SIGNED_QUERY_XYZ"), false);
  assert.equal(raw.includes("SECRET_COOKIE"), false);
  assert.equal(raw.includes("cdn.example"), false);
  if (Object.prototype.hasOwnProperty.call(view, "error")) {
    assert.equal(view.error, "Download error");
  }

  // Friendly errors preserved.
  const friendly = P.projectPopupJob({ id: "f", state: "failed", error: "HTTP 429; retry later" });
  assert.equal(friendly.error, "HTTP 429; retry later");
  const helper = P.projectPopupJob({ id: "h", state: "failed", error: "Helper unavailable" });
  assert.equal(helper.error, "Helper unavailable");

  // Authorization / Set-Cookie / credentials in error.
  for (const bad of [
    "Authorization: Bearer SECRET_TOKEN_XYZ",
    "Set-Cookie: session=SECRET_COOKIE",
    "Proxy-Authorization: Basic SECRET_BASIC",
    "https://user:SECRET_PASS@cdn.example/f.mp4",
    "https://cdn.example/f.mp4#SECRET_FRAG",
  ]) {
    const v = P.projectPopupJob({ id: "b", state: "failed", error: bad });
    const s = JSON.stringify(v);
    assert.equal(s.includes("SECRET"), false, bad);
    if (Object.prototype.hasOwnProperty.call(v, "error")) {
      assert.equal(v.error, "Download error");
    }
  }

  // Optional popup strings that are not network URLs: redact/omit secret URL material.
  const poisonedStrings = P.projectPopupJob({
    id: "p",
    state: "running",
    name: "clip https://cdn.example/f.mp4?token=SECRET_SIGNED_QUERY_XYZ",
    savedPath: "C:\\Videos\\ok.mp4",
    mergeCommand: "ffmpeg -i https://cdn.example/a.mp4?token=SECRET_SIGNED_QUERY_XYZ -c copy out.mp4",
    fixCommand: "Cookie: SECRET_COOKIE",
    convertCodec: "h264",
    providerKey: "florenfile.com",
    requestedFilename: "my video.mp4",
  });
  const raw2 = JSON.stringify(poisonedStrings);
  assert.equal(raw2.includes("SECRET_SIGNED_QUERY_XYZ"), false);
  assert.equal(raw2.includes("SECRET_COOKIE"), false);
  // Legitimate values survive.
  assert.equal(poisonedStrings.savedPath, "C:\\Videos\\ok.mp4");
  assert.equal(poisonedStrings.providerKey, "florenfile.com");
  assert.equal(poisonedStrings.requestedFilename, "my video.mp4");
  assert.equal(poisonedStrings.convertCodec, "h264");
});

test("redactUrlForLog manual fallback never echoes secrets when URL is absent", () => {
  const abs = path.join(mediaCatcherRoot, "lib", "privacy.js");
  const code = fs.readFileSync(abs, "utf8");
  const root = {};
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require,
    console,
    self: root,
    // URL intentionally absent so manual fallback runs.
  };
  sandbox.module.exports = sandbox.exports;
  vm.runInNewContext(code, sandbox, { filename: abs });
  const R = sandbox.module.exports.redactUrlForLog;

  const malformed = "https://user:SECRET_PASS@cdn.example/a.mp4?token=SECRET_SIGNED_QUERY_XYZ#frag";
  const out = R(malformed);
  assert.equal(String(out).includes("SECRET"), false);
  assert.equal(String(out).includes("token="), false);
  assert.equal(String(out).includes("#frag"), false);
  assert.equal(String(out).includes("user:"), false);
  // Either fully redacted or credential/query/fragment-free.
  if (out !== "[redacted]") {
    assert.equal(out.includes("?"), false);
    assert.equal(out.includes("#"), false);
    assert.equal(out.includes("@"), false);
  }

  // Also when URL exists but parse fails (malformed absolute).
  const badAbs = P.redactUrlForLog("https://[invalid?token=SECRET_SIGNED_QUERY_XYZ#x");
  assert.equal(String(badAbs).includes("SECRET"), false);
  assert.equal(String(badAbs).includes("token="), false);
});

// --- Task-19 fix2: exact terminal states + signed-string redaction ---

function assertPopupNoLeak(view, sentinels) {
  const raw = JSON.stringify(view);
  for (const s of sentinels) {
    assert.equal(raw.includes(s), false, "leak in serialized popup: " + s);
  }
  // Walk all top-level and nested string fields.
  function walk(obj, pathLabel) {
    if (obj == null || typeof obj !== "object") return;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      const p = pathLabel + "." + k;
      if (typeof v === "string") {
        for (const s of sentinels) {
          assert.equal(v.includes(s), false, "leak in " + p + ": " + s);
        }
      } else if (v && typeof v === "object") {
        walk(v, p);
      }
    }
  }
  walk(view, "view");
}

test("clearEphemeralOnTerminal recognizes only the four exact terminal states", () => {
  const TERMINALS = ["completed", "failed", "cancelled", "handed_to_firefox"];
  for (const state of TERMINALS) {
    const e = P.createEphemeral("https://cdn/f?token=x", { Cookie: COOKIE });
    const cleared = P.clearEphemeralOnTerminal({ ephemeral: e }, state);
    assert.equal(cleared, true, "terminal " + state + " must clear");
    assert.equal(e.mediaUrl, null, state);
    assert.equal(e.requestHeaders, null, state);
  }
});

test("clearEphemeralOnTerminal rejects inherited Object names and near-miss states", () => {
  const NON_TERMINALS = [
    // Inherited truthy Object.prototype names (the confirmed defect).
    "constructor",
    "toString",
    "valueOf",
    "__proto__",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    // Near-miss / case / whitespace.
    "Completed",
    "FAILED",
    "Cancelled",
    "HANDED_TO_FIREFOX",
    " completed",
    "completed ",
    " completed ",
    "complete",
    "fail",
    "cancel",
    "handed-to-firefox",
    "handed_to_firefox ",
    "running",
    "queued",
    "paused",
    "",
    "true",
    "prototype",
  ];
  for (const state of NON_TERMINALS) {
    const e = P.createEphemeral("https://cdn/f?token=x", { Cookie: COOKIE });
    const cleared = P.clearEphemeralOnTerminal({ ephemeral: e }, state);
    assert.equal(cleared, false, "non-terminal must return false: " + JSON.stringify(state));
    assert.equal(e.mediaUrl, "https://cdn/f?token=x", "must preserve URL for " + JSON.stringify(state));
    assert.equal(e.requestHeaders.Cookie, COOKIE, "must preserve headers for " + JSON.stringify(state));
  }

  // Non-string states also non-terminal.
  for (const state of [null, undefined, 1, true, false, {}, ["completed"]]) {
    const e = P.createEphemeral("https://cdn/f?token=x", null);
    assert.equal(P.clearEphemeralOnTerminal({ ephemeral: e }, state), false);
    assert.equal(e.mediaUrl, "https://cdn/f?token=x");
  }

  // Controller probe: constructor must not clear.
  const e = P.createEphemeral("https://cdn/f?token=x", null);
  assert.equal(P.clearEphemeralOnTerminal({ ephemeral: e }, "constructor"), false);
  assert.equal(e.mediaUrl, "https://cdn/f?token=x");
});

test("projectPopupJob redacts scheme-relative and relative signed material", () => {
  // Controller probe.
  const view = P.projectPopupJob({
    id: "j",
    state: "failed",
    error: "GET //cdn.example/f.mp4?token=SECRET_SCHEME_REL",
    progress: { note: "/f?X-Amz-Signature=SECRET_REL" },
  });
  assertPopupNoLeak(view, ["SECRET_SCHEME_REL", "SECRET_REL", "token=", "X-Amz-Signature"]);
  assert.equal(view.error, "Download error");
  assert.equal(Object.prototype.hasOwnProperty.call(view, "progress") &&
    Object.prototype.hasOwnProperty.call(view.progress, "note"), false);

  // Scheme-relative with userinfo.
  const uinfo = P.projectPopupJob({
    id: "u",
    state: "failed",
    error: "GET //user:SECRET_PASS@cdn.example/f.mp4",
  });
  assertPopupNoLeak(uinfo, ["SECRET_PASS", "user:"]);
  assert.equal(uinfo.error, "Download error");

  // Relative / bare secret-bearing query params (case-insensitive), after ?, &, or #.
  const secretParams = [
    "token", "access_token", "auth", "authorization", "key", "api_key",
    "session", "cookie", "sig", "signature", "policy", "expires", "expiry",
    "X-Amz-Signature", "X-Amz-Credential", "x-amz-security-token",
  ];
  for (const param of secretParams) {
    const sentinel = "SECRET_PARAM_" + param.replace(/[^A-Za-z0-9]/g, "_");
    const forms = [
      "/path?" + param + "=" + sentinel,
      "/path?other=1&" + param + "=" + sentinel,
      "/path#" + param + "=" + sentinel,
      "f.mp4?" + param.toUpperCase() + "=" + sentinel,
      "note: rel?" + param.toLowerCase() + "=" + sentinel,
    ];
    for (const bad of forms) {
      const errView = P.projectPopupJob({ id: "e", state: "failed", error: bad });
      assertPopupNoLeak(errView, [sentinel]);
      assert.equal(errView.error, "Download error", bad);

      const optView = P.projectPopupJob({
        id: "o",
        state: "running",
        name: bad,
        progress: { note: bad, stage: "dl" },
        convert: { note: bad, codec: "h264" },
      });
      assertPopupNoLeak(optView, [sentinel]);
      if (Object.prototype.hasOwnProperty.call(optView, "name")) {
        assert.equal(String(optView.name).includes(sentinel), false);
      }
      if (optView.progress && Object.prototype.hasOwnProperty.call(optView.progress, "note")) {
        assert.equal(String(optView.progress.note).includes(sentinel), false);
      }
    }
  }

  // Absolute non-http schemes with query/userinfo/fragment are suspicious.
  for (const bad of [
    "ftp://cdn.example/f?token=SECRET_FTP",
    "blob:https://x?sig=SECRET_BLOB",
    "custom://host/path#SECRET_FRAG_SCHEME",
    "s3://bucket/key?X-Amz-Signature=SECRET_S3",
  ]) {
    const v = P.projectPopupJob({ id: "s", state: "failed", error: bad });
    assertPopupNoLeak(v, ["SECRET_"]);
    assert.equal(v.error, "Download error", bad);
  }
});

test("projectPopupJob preserves ordinary friendly text without signed material", () => {
  const cases = [
    { error: "HTTP 429? retry later" },
    { error: "Helper unavailable" },
    { name: "clip#1 final.mp4" },
    { savedPath: "C:\\Users\\me\\Videos\\file.mp4" },
    { savedPath: "D:\\Downloads\\out#draft.mp4" },
    { providerKey: "florenfile.com" },
    { mergeCommand: "ffmpeg -i in.mp4 -c copy out.mp4" },
    { fixCommand: "ffmpeg -err_detect ignore_err -i broken.mp4 fixed.mp4" },
    { progress: { note: "retry later", stage: "wait" } },
    { convert: { note: "kept original", codec: "h264" } },
  ];
  for (const partial of cases) {
    const job = Object.assign({ id: "ok", state: "running" }, partial);
    const view = P.projectPopupJob(job);
    const raw = JSON.stringify(view);
    assert.equal(raw.includes("Download error"), false, JSON.stringify(partial));
    if (partial.error) assert.equal(view.error, partial.error);
    if (partial.name) assert.equal(view.name, partial.name);
    if (partial.savedPath) assert.equal(view.savedPath, partial.savedPath);
    if (partial.providerKey) assert.equal(view.providerKey, partial.providerKey);
    if (partial.mergeCommand) assert.equal(view.mergeCommand, partial.mergeCommand);
    if (partial.fixCommand) assert.equal(view.fixCommand, partial.fixCommand);
    if (partial.progress) {
      assert.equal(view.progress.note, partial.progress.note);
      assert.equal(view.progress.stage, partial.progress.stage);
    }
    if (partial.convert) {
      assert.equal(view.convert.note, partial.convert.note);
      assert.equal(view.convert.codec, partial.convert.codec);
    }
  }
});

test("redactUrlForLog hardens scheme-relative URLs without leaking or coercing", () => {
  const schemeRel = P.redactUrlForLog("//cdn.example/f.mp4?token=SECRET_SCHEME_REL#frag");
  assert.equal(String(schemeRel).includes("SECRET"), false);
  assert.equal(String(schemeRel).includes("token="), false);
  assert.equal(String(schemeRel).includes("#frag"), false);
  if (schemeRel !== "[redacted]") {
    assert.equal(schemeRel.includes("?"), false);
    assert.equal(schemeRel.includes("#"), false);
    // Acceptable safe form: //cdn.example/f.mp4 or similar path-only.
    assert.match(schemeRel, /^\/\/cdn\.example\/f\.mp4$/);
  }

  const withUser = P.redactUrlForLog("//user:SECRET_PASS@cdn.example/a?token=SECRET_Q");
  assert.equal(String(withUser).includes("SECRET"), false);
  assert.equal(String(withUser).includes("user:"), false);
  assert.equal(String(withUser).includes("token="), false);
  if (withUser !== "[redacted]") {
    assert.equal(withUser.includes("@"), false);
    assert.equal(withUser.includes("?"), false);
  }

  // No object coercion.
  assert.equal(P.redactUrlForLog({ href: "//cdn.example/f?token=SECRET_OBJ" }), "[redacted]");
  assert.equal(P.redactUrlForLog(["//x?token=SECRET_ARR"]), "[redacted]");
});
