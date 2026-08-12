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
