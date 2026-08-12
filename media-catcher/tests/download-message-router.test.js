"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const { loadLib, mediaCatcherRoot } = require("./harness/load-lib.js");

const FLOREN = "11238-makemebi.net.mp4";
const PUBLIC_KEYS = [
  "buildNativeStartPayload",
  "normalizeDownloadRequest",
  "routeNativeMessage",
];

function loadRouter() {
  return loadLib("lib/download-message-router.js");
}

function firefoxIntent(overrides) {
  return Object.assign(
    {
      requestedFilename: "a.mp4",
      destinationDirectory: null,
      saveMode: "default",
      userSelectedFirefox: true,
      userActionToken: "tok",
      createdAt: "t0",
    },
    overrides || {}
  );
}

function saveAsIntent(overrides) {
  return Object.assign(
    {
      requestedFilename: FLOREN,
      destinationDirectory: "D:\\\\Vids",
      saveMode: "save-as",
      userSelectedFirefox: false,
      userActionToken: "tok",
      createdAt: "t0",
    },
    overrides || {}
  );
}

function defaultItem(overrides) {
  return Object.assign(
    {
      id: "item-1",
      kind: "direct",
      url: "https://x/a.mp4",
      proposedFilename: FLOREN,
      name: "fallback.mp4",
      providerKey: "florenfile.com",
    },
    overrides || {}
  );
}

function assertDeeplyFrozen(obj) {
  assert.equal(Object.isFrozen(obj), true);
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === "object") {
      assertDeeplyFrozen(v);
    }
  }
}

function assertNoSecrets(obj) {
  const raw = JSON.stringify(obj);
  assert.equal(raw.includes("SECRET"), false);
  assert.equal(raw.includes("cookie"), false);
  assert.equal(raw.includes("Cookie"), false);
  assert.equal(raw.includes("signed-url"), false);
}

// ---------------------------------------------------------------------------
// Plan tests (Task 20 brief) — strict shapes
// ---------------------------------------------------------------------------

test("pget-result range_unsupported routes to single-connection start", () => {
  const { routeNativeMessage } = loadRouter();
  const out = routeNativeMessage({
    type: "pget-result",
    id: "j",
    attemptToken: "a",
    status: "failed",
    mode: "multi-range",
    failureCategory: "range_unsupported",
    partState: "empty",
  });
  assert.equal(out.action, "start-single-connection");
  assert.equal(out.invokeFirefox, false);
  assert.equal(out.jobId, "j");
  assert.equal(out.attemptToken, "a");
  assert.equal(out.status, "failed");
  assert.equal(out.mode, "multi-range");
  assert.equal(out.failureCategory, "range_unsupported");
  assert.equal(out.partState, "empty");
  assertDeeplyFrozen(out);
});

test("pget-result timeout routes to scheduler failure not firefox", () => {
  const { routeNativeMessage } = loadRouter();
  const out = routeNativeMessage({
    type: "pget-result",
    id: "j",
    attemptToken: "a",
    status: "failed",
    mode: "multi-range",
    failureCategory: "timeout",
    partState: "partial",
  });
  assert.equal(out.action, "transport-result");
  assert.equal(out.invokeFirefox, false);
  assert.equal(out.jobId, "j");
  assert.equal(out.attemptToken, "a");
  assert.equal(out.status, "failed");
  assert.equal(out.mode, "multi-range");
  assert.equal(out.failureCategory, "timeout");
  assert.equal(out.partState, "partial");
});

test("download without intent builds from proposedFilename with null destinationDirectory", () => {
  const { normalizeDownloadRequest } = loadRouter();
  const req = normalizeDownloadRequest({
    type: "download",
    item: {
      proposedFilename: FLOREN,
      kind: "direct",
      url: "https://x/a.mp4",
    },
    tabId: 1,
    userActionToken: "tok",
  });
  assert.equal(req.type, "download");
  assert.equal(req.intent.requestedFilename, FLOREN);
  assert.equal(req.intent.userSelectedFirefox, false);
  assert.equal(req.intent.destinationDirectory, null);
  assert.equal(req.intent.saveMode, "default");
  assert.equal(req.intent.userActionToken, "tok");
  assertDeeplyFrozen(req);
});

test("save-as request preserves destinationDirectory and requestedFilename", () => {
  const { normalizeDownloadRequest } = loadRouter();
  const req = normalizeDownloadRequest({
    type: "download",
    item: {
      proposedFilename: FLOREN,
      kind: "direct",
      url: "https://x/a.mp4",
    },
    tabId: 1,
    userActionToken: "tok",
    intent: {
      requestedFilename: FLOREN,
      destinationDirectory: "D:\\\\Vids",
      saveMode: "save-as",
      userSelectedFirefox: false,
      userActionToken: "tok",
      createdAt: "t0",
    },
  });
  assert.equal(req.intent.destinationDirectory, "D:\\\\Vids");
  assert.equal(req.intent.requestedFilename, FLOREN);
});

test("native start payloads for pget pget-single file-open carry name and dir", () => {
  const { buildNativeStartPayload } = loadRouter();
  const intent = {
    requestedFilename: FLOREN,
    destinationDirectory: "D:\\\\Vids",
    saveMode: "save-as",
    userSelectedFirefox: false,
    userActionToken: "tok",
    createdAt: "t0",
  };
  const pget = buildNativeStartPayload({
    kind: "pget",
    jobId: "j",
    attemptToken: "a",
    intent,
    url: "https://cdn/x.mp4",
    maxConnections: 2,
  });
  assert.equal(pget.cmd, "pget");
  assert.equal(pget.name, FLOREN);
  assert.equal(pget.dir, "D:\\\\Vids");
  assert.equal(pget.id, "j");
  assert.equal(pget.attemptToken, "a");
  assert.equal(pget.maxConnections, 2);
  assertDeeplyFrozen(pget);

  const single = buildNativeStartPayload({
    kind: "pget-single",
    jobId: "j",
    attemptToken: "a2",
    intent,
    url: "https://cdn/x.mp4",
  });
  assert.equal(single.cmd, "pget-single");
  assert.equal(single.name, FLOREN);
  assert.equal(single.dir, "D:\\\\Vids");
  assert.equal(single.id, "j");
  assert.equal(single.attemptToken, "a2");
  assert.equal(single.maxConnections, 1);

  const open = buildNativeStartPayload({
    kind: "file-open",
    jobId: "j",
    attemptToken: "a3",
    intent,
  });
  assert.equal(open.cmd, "file-open");
  assert.equal(open.requestedFilename, FLOREN);
  assert.equal(open.dir, "D:\\\\Vids");
  assert.equal(open.jobId, "j");
  assert.equal(open.attemptToken, "a3");
  assert.equal(Object.prototype.hasOwnProperty.call(open, "url"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(open, "userActionToken"), false);

  const def = buildNativeStartPayload({
    kind: "pget",
    jobId: "j2",
    attemptToken: "b",
    intent: Object.assign({}, intent, {
      destinationDirectory: null,
      saveMode: "default",
    }),
    url: "https://cdn/y.mp4",
    maxConnections: 1,
  });
  assert.equal(def.dir, null);
  assert.equal(def.name, FLOREN);
});

test("use-firefox routes exclusively to requestFirefoxHandoff action", () => {
  const { routeNativeMessage } = loadRouter();
  const out = routeNativeMessage({
    type: "use-firefox",
    jobId: "j",
    intent: firefoxIntent({ requestedFilename: "a.mp4" }),
  });
  assert.equal(out.action, "request-firefox-handoff");
  assert.equal(out.invokeFirefox, false);
  assert.equal(out.jobId, "j");
  assert.equal(out.intent.userSelectedFirefox, true);
  assert.equal(out.intent.requestedFilename, "a.mp4");
  assert.equal(out.intent.userActionToken, "tok");
  assertDeeplyFrozen(out);
});

test("legacy pget-fallback must not map to firefox", () => {
  const { routeNativeMessage } = loadRouter();
  const out = routeNativeMessage({
    type: "pget-fallback",
    id: "j",
    reason: "no-range",
  });
  assert.equal(out.invokeFirefox, false);
  assert.equal(out.action, "ignore-legacy");
  assert.equal(Object.prototype.hasOwnProperty.call(out, "reason"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out, "url"), false);
});

// ---------------------------------------------------------------------------
// Public API / dual-export identity
// ---------------------------------------------------------------------------

test("exports exactly the three public keys and freezes the API surface", () => {
  const api = loadRouter();
  assert.deepEqual(Object.keys(api).sort(), PUBLIC_KEYS.slice().sort());
  assert.equal(Object.isFrozen(api), true);
  for (const k of PUBLIC_KEYS) {
    assert.equal(typeof api[k], "function");
  }
});

test("CommonJS export and browser global name are exact McDownloadMessageRouter", () => {
  const nodeExport = loadRouter();
  const abs = path.join(mediaCatcherRoot, "lib", "download-message-router.js");
  const code = fs.readFileSync(abs, "utf8");
  const root = {
    McDownloadIntent: require(path.join(mediaCatcherRoot, "lib", "download-intent.js")),
    McFileSinkProtocol: require(path.join(mediaCatcherRoot, "lib", "file-sink-protocol.js")),
  };
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require,
    console,
    self: root,
  };
  sandbox.module.exports = sandbox.exports;
  vm.runInNewContext(code, sandbox, { filename: abs });
  assert.equal(typeof root.McDownloadMessageRouter.routeNativeMessage, "function");
  assert.equal(typeof root.McDownloadMessageRouter.normalizeDownloadRequest, "function");
  assert.equal(typeof root.McDownloadMessageRouter.buildNativeStartPayload, "function");
  assert.equal(root.McDownloadMessageRouter, sandbox.module.exports);
  assert.deepEqual(
    Object.keys(root.McDownloadMessageRouter).sort(),
    PUBLIC_KEYS.slice().sort()
  );
  assert.equal(Object.isFrozen(root.McDownloadMessageRouter), true);
});

test("browser classic-script resolves globals when CommonJS is inactive", () => {
  const abs = path.join(mediaCatcherRoot, "lib", "download-message-router.js");
  const code = fs.readFileSync(abs, "utf8");
  const intentCalls = [];
  const root = {
    McDownloadIntent: {
      createDefaultIntent(input) {
        intentCalls.push(input);
        return Object.freeze({
          requestedFilename: input.proposedFilename,
          destinationDirectory: null,
          saveMode: "default",
          userSelectedFirefox: false,
          userActionToken: input.userActionToken,
          createdAt: "browser-t0",
        });
      },
    },
    McFileSinkProtocol: {
      buildPgetCmd(input) {
        return Object.freeze({
          cmd: "pget",
          id: input.jobId,
          attemptToken: input.attemptToken,
          name: input.intent.requestedFilename,
          dir: input.intent.destinationDirectory,
          urls: Object.freeze([input.url]),
          maxConnections: input.maxConnections,
        });
      },
      buildPgetSingleCmd() {
        throw new Error("unused");
      },
      createFileSinkSession() {
        throw new Error("unused");
      },
    },
  };
  // No module/require → classic-script path.
  const sandbox = { self: root, console };
  vm.runInNewContext(code, sandbox, { filename: abs });
  const api = root.McDownloadMessageRouter;
  assert.equal(typeof api.routeNativeMessage, "function");
  const req = api.normalizeDownloadRequest({
    type: "download",
    tabId: 0,
    userActionToken: "browser-tok",
    item: { proposedFilename: FLOREN, kind: "direct", url: "https://x/a.mp4" },
  });
  assert.equal(req.intent.requestedFilename, FLOREN);
  assert.equal(intentCalls.length, 1);
  const pget = api.buildNativeStartPayload({
    kind: "pget",
    jobId: "jb",
    attemptToken: "ab",
    intent: req.intent,
    url: "https://cdn/x.mp4",
    maxConnections: 3,
  });
  assert.equal(pget.cmd, "pget");
  assert.equal(pget.name, FLOREN);
});

test("CommonJS dependency load failures propagate and do not fall back to globals", () => {
  const abs = path.join(mediaCatcherRoot, "lib", "download-message-router.js");
  const code = fs.readFileSync(abs, "utf8");
  const root = {
    McDownloadIntent: {
      createDefaultIntent() {
        return Object.freeze({
          requestedFilename: "from-global.mp4",
          destinationDirectory: null,
          saveMode: "default",
          userSelectedFirefox: false,
          userActionToken: "g",
          createdAt: "t",
        });
      },
    },
    McFileSinkProtocol: {
      buildPgetCmd() {
        return Object.freeze({ cmd: "pget-from-global" });
      },
      buildPgetSingleCmd() {
        return Object.freeze({ cmd: "pget-single-from-global" });
      },
      createFileSinkSession() {
        return {
          openCmd() {
            return Object.freeze({ cmd: "file-open-from-global" });
          },
        };
      },
    },
  };
  function throwingRequire(id) {
    if (String(id).indexOf("download-intent") !== -1) {
      throw new Error("simulated DownloadIntent load failure");
    }
    if (String(id).indexOf("file-sink-protocol") !== -1) {
      throw new Error("simulated FileSinkProtocol load failure");
    }
    return require(id);
  }
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: throwingRequire,
    console,
    self: root,
  };
  sandbox.module.exports = sandbox.exports;
  vm.runInNewContext(code, sandbox, { filename: abs });
  const api = sandbox.module.exports;
  assert.throws(
    () =>
      api.normalizeDownloadRequest({
        type: "download",
        tabId: 1,
        userActionToken: "tok",
        item: { proposedFilename: FLOREN, kind: "direct", url: "https://x/a.mp4" },
      }),
    /simulated DownloadIntent load failure/
  );
  assert.throws(
    () =>
      api.buildNativeStartPayload({
        kind: "pget",
        jobId: "j",
        attemptToken: "a",
        intent: saveAsIntent(),
        url: "https://cdn/x.mp4",
        maxConnections: 1,
      }),
    /simulated FileSinkProtocol load failure/
  );
});

// ---------------------------------------------------------------------------
// routeNativeMessage — boundaries, freeze, hostility
// ---------------------------------------------------------------------------

test("pget-result range switch exact boundary; partial/committed/other mode do not switch", () => {
  const { routeNativeMessage } = loadRouter();
  const base = {
    type: "pget-result",
    id: "j",
    attemptToken: "a",
    status: "failed",
    mode: "multi-range",
    failureCategory: "range_unsupported",
    partState: "empty",
  };
  assert.equal(routeNativeMessage(base).action, "start-single-connection");

  const nonSwitch = [
    { partState: "partial" },
    { partState: "committed" },
    { mode: "single-connection" },
    { status: "cancelled" },
    { status: "completed", failureCategory: null, partState: "committed" },
    { failureCategory: "timeout" },
    { failureCategory: "local_io" },
    { failureCategory: "RANGE_UNSUPPORTED" },
  ];
  for (const patch of nonSwitch) {
    const out = routeNativeMessage(Object.assign({}, base, patch));
    assert.notEqual(
      out.action,
      "start-single-connection",
      `patch=${JSON.stringify(patch)}`
    );
    assert.equal(out.invokeFirefox, false);
    if (out.action !== "ignore") {
      assert.equal(out.action, "transport-result");
    }
  }
});

test("pget-result malformed identities and types ignore without throwing", () => {
  const { routeNativeMessage } = loadRouter();
  const cases = [
    null,
    undefined,
    12,
    "pget-result",
    [],
    { type: "pget-result" },
    {
      type: "pget-result",
      id: "",
      attemptToken: "a",
      status: "failed",
      mode: "multi-range",
      failureCategory: "timeout",
      partState: "empty",
    },
    {
      type: "pget-result",
      id: "  ",
      attemptToken: "a",
      status: "failed",
      mode: "multi-range",
      failureCategory: "timeout",
      partState: "empty",
    },
    {
      type: "pget-result",
      id: "j",
      attemptToken: "",
      status: "failed",
      mode: "multi-range",
      failureCategory: "timeout",
      partState: "empty",
    },
    {
      type: "pget-result",
      id: 9,
      attemptToken: "a",
      status: "failed",
      mode: "multi-range",
      failureCategory: "timeout",
      partState: "empty",
    },
    {
      type: "pget-result",
      id: "j",
      attemptToken: "a",
      status: "weird",
      mode: "multi-range",
      failureCategory: "timeout",
      partState: "empty",
    },
    {
      type: "pget-result",
      id: "j",
      attemptToken: "a",
      status: "failed",
      mode: "other",
      failureCategory: "timeout",
      partState: "empty",
    },
    {
      type: "pget-result",
      id: "j",
      attemptToken: "a",
      status: "failed",
      mode: "multi-range",
      failureCategory: "timeout",
      partState: "unknown",
    },
  ];
  for (const msg of cases) {
    const out = routeNativeMessage(msg);
    assert.deepEqual(out, { action: "ignore", invokeFirefox: false });
    assertDeeplyFrozen(out);
  }
});

test("pget-result does not copy secret extras; decisions are deeply frozen", () => {
  const { routeNativeMessage } = loadRouter();
  const msg = {
    type: "pget-result",
    id: "j1",
    attemptToken: "atk",
    status: "failed",
    mode: "multi-range",
    failureCategory: "timeout",
    partState: "partial",
    secret: "SECRET-TOKEN",
    cookie: "session=1",
    rawUrl: "https://cdn/signed-url?token=SECRET",
    headers: { Authorization: "Bearer SECRET" },
  };
  const out = routeNativeMessage(msg);
  assert.equal(out.action, "transport-result");
  assert.deepEqual(Object.keys(out).sort(), [
    "action",
    "attemptToken",
    "failureCategory",
    "invokeFirefox",
    "jobId",
    "mode",
    "partState",
    "status",
  ]);
  assertNoSecrets(out);
  assertDeeplyFrozen(out);
  assert.throws(() => {
    out.action = "request-firefox-handoff";
  });
});

test("pget-fallback cannot become Firefox under any reason/extras", () => {
  const { routeNativeMessage } = loadRouter();
  const cases = [
    { type: "pget-fallback" },
    { type: "pget-fallback", id: "j", reason: "no-range", url: "https://x" },
    {
      type: "pget-fallback",
      id: "j",
      reason: "use-firefox",
      action: "request-firefox-handoff",
      invokeFirefox: true,
      userSelectedFirefox: true,
    },
    {
      type: "pget-fallback",
      reason: "range_unsupported",
      failureCategory: "range_unsupported",
      status: "failed",
      mode: "multi-range",
      partState: "empty",
    },
  ];
  for (const msg of cases) {
    const out = routeNativeMessage(msg);
    assert.equal(out.action, "ignore-legacy");
    assert.equal(out.invokeFirefox, false);
    assert.equal(Object.prototype.hasOwnProperty.call(out, "reason"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(out, "url"), false);
    assert.equal(Object.keys(out).sort().join(","), "action,invokeFirefox");
  }
});

test("use-firefox accepts only explicit true exact intent and never mints/consumes", () => {
  const { routeNativeMessage } = loadRouter();
  const ok = routeNativeMessage({
    type: "use-firefox",
    id: "from-id",
    intent: firefoxIntent({
      requestedFilename: FLOREN,
      destinationDirectory: "D:\\\\Vids",
      saveMode: "save-as",
    }),
  });
  assert.equal(ok.action, "request-firefox-handoff");
  assert.equal(ok.jobId, "from-id");
  assert.deepEqual(Object.keys(ok.intent).sort(), [
    "createdAt",
    "destinationDirectory",
    "requestedFilename",
    "saveMode",
    "userActionToken",
    "userSelectedFirefox",
  ]);
  assert.equal(ok.intent.requestedFilename, FLOREN);
  assert.equal(ok.intent.destinationDirectory, "D:\\\\Vids");
  assert.equal(ok.intent.userSelectedFirefox, true);

  // jobId preferred over id
  const prefer = routeNativeMessage({
    type: "use-firefox",
    jobId: "job-preferred",
    id: "id-fallback",
    intent: firefoxIntent(),
  });
  assert.equal(prefer.jobId, "job-preferred");

  const rejects = [
    { type: "use-firefox", jobId: "j" },
    { type: "use-firefox", jobId: "j", intent: null },
    {
      type: "use-firefox",
      jobId: "j",
      intent: firefoxIntent({ userSelectedFirefox: false }),
    },
    {
      type: "use-firefox",
      jobId: "j",
      intent: firefoxIntent({ userSelectedFirefox: "true" }),
    },
    {
      type: "use-firefox",
      jobId: "j",
      intent: firefoxIntent({ userSelectedFirefox: 1 }),
    },
    {
      type: "use-firefox",
      jobId: "",
      intent: firefoxIntent(),
    },
    {
      type: "use-firefox",
      intent: firefoxIntent(),
    },
    {
      type: "use-firefox",
      jobId: "j",
      intent: firefoxIntent({ requestedFilename: "" }),
    },
    {
      type: "use-firefox",
      jobId: "j",
      intent: firefoxIntent({ destinationDirectory: "" }),
    },
    {
      type: "use-firefox",
      jobId: "j",
      intent: firefoxIntent({ destinationDirectory: 12 }),
    },
    {
      type: "use-firefox",
      jobId: "j",
      intent: firefoxIntent({ saveMode: "auto" }),
    },
    {
      type: "use-firefox",
      jobId: "j",
      intent: firefoxIntent({ userActionToken: "  " }),
    },
    {
      type: "use-firefox",
      jobId: "j",
      intent: firefoxIntent({ createdAt: 123 }),
    },
  ];
  for (const msg of rejects) {
    const out = routeNativeMessage(msg);
    assert.deepEqual(out, { action: "ignore", invokeFirefox: false });
  }

  // Accessors on intent keys must not be invoked or accepted.
  let accessorHits = 0;
  const hostileIntent = {};
  for (const key of [
    "requestedFilename",
    "destinationDirectory",
    "saveMode",
    "userSelectedFirefox",
    "userActionToken",
    "createdAt",
  ]) {
    Object.defineProperty(hostileIntent, key, {
      enumerable: true,
      configurable: true,
      get() {
        accessorHits += 1;
        return firefoxIntent()[key];
      },
    });
  }
  const hostileOut = routeNativeMessage({
    type: "use-firefox",
    jobId: "j",
    intent: hostileIntent,
  });
  assert.deepEqual(hostileOut, { action: "ignore", invokeFirefox: false });
  assert.equal(accessorHits, 0);

  // Extras on intent must not be copied.
  const withExtra = routeNativeMessage({
    type: "use-firefox",
    jobId: "j",
    intent: Object.assign(firefoxIntent(), {
      signedUrl: "https://cdn/signed-url?token=SECRET",
      cookie: "SECRET",
    }),
  });
  assert.equal(withExtra.action, "request-firefox-handoff");
  assert.equal(Object.prototype.hasOwnProperty.call(withExtra.intent, "signedUrl"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(withExtra.intent, "cookie"), false);
  assertNoSecrets(withExtra);
});

test("file-sink host messages route allowlisted fields without secret extras", () => {
  const { routeNativeMessage } = loadRouter();

  const opened = routeNativeMessage({
    type: "file-opened",
    sinkId: "s1",
    jobId: "j1",
    attemptToken: "a1",
    secret: "SECRET",
    cookie: "session=1",
    url: "https://cdn/signed-url",
    headers: { Authorization: "Bearer x" },
  });
  assert.equal(opened.action, "file-sink-message");
  assert.equal(opened.invokeFirefox, false);
  assert.deepEqual(opened.message, {
    type: "file-opened",
    sinkId: "s1",
    jobId: "j1",
    attemptToken: "a1",
  });
  assertDeeplyFrozen(opened);
  assertNoSecrets(opened);

  const ack = routeNativeMessage({
    type: "file-ack",
    sinkId: "s1",
    jobId: "j1",
    attemptToken: "a1",
    seq: 3,
    cookie: "SECRET",
  });
  assert.equal(ack.action, "file-sink-message");
  assert.equal(ack.message.type, "file-ack");
  assert.equal(ack.message.sinkId, "s1");
  assert.equal(ack.message.seq, 3);
  assert.equal(Object.prototype.hasOwnProperty.call(ack.message, "cookie"), false);

  const chunkAck = routeNativeMessage({
    type: "file-chunk-ack",
    sinkId: "s1",
    seq: 0,
  });
  assert.equal(chunkAck.action, "file-sink-message");
  assert.equal(chunkAck.message.type, "file-chunk-ack");
  assert.equal(chunkAck.message.seq, 0);

  const committed = routeNativeMessage({
    type: "file-committed",
    sinkId: "s1",
    jobId: "j1",
    attemptToken: "a1",
    file: "D:\\\\Vids\\\\out.mp4",
    bytes: 42,
    secret: "SECRET",
  });
  assert.equal(committed.action, "file-sink-message");
  assert.equal(committed.message.file, "D:\\\\Vids\\\\out.mp4");
  assert.equal(committed.message.bytes, 42);
  assert.equal(Object.prototype.hasOwnProperty.call(committed.message, "secret"), false);

  const aborted = routeNativeMessage({
    type: "file-aborted",
    sinkId: "s9",
    jobId: "j1",
    attemptToken: "a1",
    reason: "user",
  });
  assert.equal(aborted.action, "file-sink-message");
  assert.equal(aborted.message.type, "file-aborted");
  assert.equal(aborted.message.sinkId, "s9");

  const err = routeNativeMessage({
    type: "file-error",
    sinkId: "s1",
    jobId: "j1",
    attemptToken: "a1",
    failureCategory: "local_io",
    reason: "write-failed",
    cookie: "SECRET",
    path: "C:\\\\secret\\\\path",
  });
  assert.equal(err.action, "file-sink-message");
  assert.equal(err.message.failureCategory, "local_io");
  assert.equal(err.message.reason, "write-failed");
  assert.equal(Object.prototype.hasOwnProperty.call(err.message, "cookie"), false);
  // path is allowlisted when primitive; cookie is not
  assert.equal(err.message.path, "C:\\\\secret\\\\path");

  // Malformed identity → ignore
  for (const msg of [
    { type: "file-opened", sinkId: "", jobId: "j", attemptToken: "a" },
    { type: "file-opened", sinkId: "s", jobId: "j" },
    { type: "file-ack", sinkId: "s", seq: -1 },
    { type: "file-ack", sinkId: "s", seq: 1.5 },
    { type: "file-committed", sinkId: "s", file: "", bytes: 1 },
    { type: "file-committed", sinkId: "s", file: "p", bytes: -1 },
    { type: "file-aborted" },
    { type: "file-error", jobId: "", attemptToken: "a" },
  ]) {
    const out = routeNativeMessage(msg);
    assert.deepEqual(out, { action: "ignore", invokeFirefox: false });
  }
});

test("unknown types and hostile accessors fail closed to ignore", () => {
  const { routeNativeMessage } = loadRouter();
  assert.deepEqual(routeNativeMessage({ type: "unknown" }), {
    action: "ignore",
    invokeFirefox: false,
  });
  assert.deepEqual(routeNativeMessage({ type: "download" }), {
    action: "ignore",
    invokeFirefox: false,
  });

  let hits = 0;
  const proxy = new Proxy(
    {},
    {
      get() {
        hits += 1;
        return "pget-result";
      },
      getOwnPropertyDescriptor() {
        hits += 1;
        return undefined;
      },
      ownKeys() {
        hits += 1;
        return ["type"];
      },
    }
  );
  const out = routeNativeMessage(proxy);
  assert.deepEqual(out, { action: "ignore", invokeFirefox: false });
  // Descriptor-safe path may call getOwnPropertyDescriptor; must not throw or echo.
  assert.equal(out.invokeFirefox, false);

  let typeHits = 0;
  const accessorMsg = {};
  Object.defineProperty(accessorMsg, "type", {
    enumerable: true,
    get() {
      typeHits += 1;
      return "pget-result";
    },
  });
  const accOut = routeNativeMessage(accessorMsg);
  assert.deepEqual(accOut, { action: "ignore", invokeFirefox: false });
  assert.equal(typeHits, 0);
});

test("route decisions never set invokeFirefox true", () => {
  const { routeNativeMessage } = loadRouter();
  const samples = [
    {
      type: "pget-result",
      id: "j",
      attemptToken: "a",
      status: "failed",
      mode: "multi-range",
      failureCategory: "range_unsupported",
      partState: "empty",
    },
    {
      type: "pget-result",
      id: "j",
      attemptToken: "a",
      status: "completed",
      mode: "single-connection",
      failureCategory: null,
      partState: "committed",
    },
    { type: "pget-fallback", id: "j", reason: "x" },
    { type: "use-firefox", jobId: "j", intent: firefoxIntent() },
    {
      type: "file-opened",
      sinkId: "s",
      jobId: "j",
      attemptToken: "a",
    },
    { type: "nope" },
  ];
  for (const msg of samples) {
    const out = routeNativeMessage(msg);
    assert.equal(out.invokeFirefox, false);
  }
});

// ---------------------------------------------------------------------------
// normalizeDownloadRequest
// ---------------------------------------------------------------------------

test("normalizeDownloadRequest returns exact allowlist request with frozen item", () => {
  const { normalizeDownloadRequest } = loadRouter();
  const item = defaultItem({
    tabId: 7,
    mode: "direct",
    pageUrl: "https://page.example/x",
    ext: "mp4",
    mime: "video/mp4",
    knownExtension: "mp4",
    sourceContextId: "ctx-1",
    live: true,
    cookie: "SECRET",
    headers: { Authorization: "Bearer SECRET" },
    sourceContext: { topLevelPageUrl: "https://evil" },
    userActionToken: "must-not-copy",
  });
  const req = normalizeDownloadRequest({
    type: "save-as-download",
    tabId: 3,
    userActionToken: "tok",
    item,
    variantUrl: "https://cdn/v.mp4",
    variantId: "v1",
    ytHeight: 720,
    ytAudioOnly: true,
    extra: "nope",
  });
  assert.deepEqual(Object.keys(req).sort(), [
    "intent",
    "item",
    "tabId",
    "type",
    "variantId",
    "variantUrl",
    "ytAudioOnly",
    "ytHeight",
  ]);
  assert.equal(req.type, "download");
  assert.equal(req.tabId, 3);
  assert.equal(req.variantUrl, "https://cdn/v.mp4");
  assert.equal(req.variantId, "v1");
  assert.equal(req.ytHeight, 720);
  assert.equal(req.ytAudioOnly, true);
  assert.deepEqual(Object.keys(req.item).sort(), [
    "ext",
    "id",
    "kind",
    "knownExtension",
    "live",
    "mime",
    "mode",
    "name",
    "pageUrl",
    "proposedFilename",
    "providerKey",
    "sourceContextId",
    "tabId",
    "url",
  ]);
  assert.equal(req.item.proposedFilename, FLOREN);
  assert.equal(req.item.live, true);
  assert.equal(Object.prototype.hasOwnProperty.call(req.item, "cookie"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(req.item, "headers"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(req.item, "sourceContext"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(req.item, "userActionToken"), false);
  assert.notEqual(req.item, item);
  item.proposedFilename = "mutated.mp4";
  assert.equal(req.item.proposedFilename, FLOREN);
  assertDeeplyFrozen(req);
});

test("normalizeDownloadRequest defaults selection fields and builds default intent from name fallback", () => {
  const { normalizeDownloadRequest } = loadRouter();
  const req = normalizeDownloadRequest({
    type: "download",
    tabId: 0,
    userActionToken: "tok-name",
    item: {
      kind: "direct",
      url: "https://x/a.mp4",
      name: "from-name.mp4",
    },
  });
  assert.equal(req.intent.requestedFilename, "from-name.mp4");
  assert.equal(req.intent.destinationDirectory, null);
  assert.equal(req.intent.userActionToken, "tok-name");
  assert.equal(req.variantUrl, null);
  assert.equal(req.variantId, null);
  assert.equal(req.ytHeight, null);
  assert.equal(req.ytAudioOnly, false);
});

test("normalizeDownloadRequest preserves Save-As filename and directory byte-for-byte", () => {
  const { normalizeDownloadRequest } = loadRouter();
  const intent = saveAsIntent({
    requestedFilename: FLOREN,
    destinationDirectory: "D:\\\\Vids",
    signedUrl: "https://cdn/signed-url?token=SECRET",
  });
  const req = normalizeDownloadRequest({
    type: "download",
    tabId: 2,
    item: defaultItem(),
    intent,
  });
  assert.equal(req.intent.requestedFilename, FLOREN);
  assert.equal(req.intent.destinationDirectory, "D:\\\\Vids");
  assert.equal(req.intent.saveMode, "save-as");
  assert.equal(req.intent.userSelectedFirefox, false);
  assert.equal(Object.prototype.hasOwnProperty.call(req.intent, "signedUrl"), false);
  intent.requestedFilename = "mutated.mp4";
  assert.equal(req.intent.requestedFilename, FLOREN);
  assertDeeplyFrozen(req.intent);
});

test("normalizeDownloadRequest rejects malformed inputs with generic TypeError", () => {
  const { normalizeDownloadRequest } = loadRouter();
  const bad = [
    null,
    undefined,
    1,
    "download",
    [],
    { type: "other", tabId: 1, item: defaultItem(), userActionToken: "t" },
    { type: "download", tabId: -1, item: defaultItem(), userActionToken: "t" },
    { type: "download", tabId: 1.5, item: defaultItem(), userActionToken: "t" },
    { type: "download", tabId: "1", item: defaultItem(), userActionToken: "t" },
    { type: "download", tabId: 1, item: null, userActionToken: "t" },
    { type: "download", tabId: 1, item: defaultItem() },
    {
      type: "download",
      tabId: 1,
      item: defaultItem(),
      userActionToken: "",
    },
    {
      type: "download",
      tabId: 1,
      item: defaultItem(),
      intent: saveAsIntent({ userSelectedFirefox: true }),
    },
    {
      type: "download",
      tabId: 1,
      item: defaultItem(),
      intent: saveAsIntent({ destinationDirectory: "" }),
    },
    {
      type: "download",
      tabId: 1,
      item: defaultItem(),
      intent: saveAsIntent({ saveMode: "auto" }),
    },
    {
      type: "download",
      tabId: 1,
      item: defaultItem(),
      userActionToken: "t",
      variantUrl: "",
    },
    {
      type: "download",
      tabId: 1,
      item: defaultItem(),
      userActionToken: "t",
      variantUrl: Object("https://x"),
    },
    {
      type: "download",
      tabId: 1,
      item: defaultItem(),
      userActionToken: "t",
      ytHeight: "720",
    },
    {
      type: "download",
      tabId: 1,
      item: defaultItem(),
      userActionToken: "t",
      ytAudioOnly: 1,
    },
    {
      type: "download",
      tabId: 1,
      item: defaultItem(),
      userActionToken: "t",
      ytAudioOnly: Object(false),
    },
  ];
  for (const msg of bad) {
    assert.throws(() => normalizeDownloadRequest(msg), TypeError);
  }

  let hits = 0;
  const accessorMsg = {
    type: "download",
    tabId: 1,
    userActionToken: "tok",
  };
  Object.defineProperty(accessorMsg, "item", {
    enumerable: true,
    get() {
      hits += 1;
      return defaultItem();
    },
  });
  assert.throws(() => normalizeDownloadRequest(accessorMsg), (err) => {
    assert.equal(err instanceof TypeError, true);
    assert.equal(String(err.message).includes("SECRET"), false);
    return true;
  });
  assert.equal(hits, 0);
});

// ---------------------------------------------------------------------------
// buildNativeStartPayload
// ---------------------------------------------------------------------------

test("buildNativeStartPayload preserves Florenfile name and null default destination", () => {
  const { buildNativeStartPayload, normalizeDownloadRequest } = loadRouter();
  const req = normalizeDownloadRequest({
    type: "download",
    tabId: 1,
    userActionToken: "tok",
    item: defaultItem({ proposedFilename: FLOREN }),
  });
  assert.equal(req.intent.destinationDirectory, null);

  const pget = buildNativeStartPayload({
    kind: "pget",
    jobId: "j",
    attemptToken: "a",
    intent: req.intent,
    url: "https://cdn/x.mp4?token=SECRET",
    maxConnections: 4,
  });
  assert.equal(pget.name, FLOREN);
  assert.equal(pget.dir, null);
  assert.equal(pget.urls[0], "https://cdn/x.mp4?token=SECRET");
  assert.equal(Object.prototype.hasOwnProperty.call(pget, "userActionToken"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(pget, "userSelectedFirefox"), false);

  const single = buildNativeStartPayload({
    kind: "pget-single",
    jobId: "j",
    attemptToken: "a2",
    intent: req.intent,
    url: "https://cdn/x.mp4",
  });
  assert.equal(single.name, FLOREN);
  assert.equal(single.dir, null);

  const open = buildNativeStartPayload({
    kind: "file-open",
    jobId: "j",
    attemptToken: "a3",
    intent: req.intent,
  });
  assert.equal(open.requestedFilename, FLOREN);
  assert.equal(open.dir, null);
  assert.equal(Object.prototype.hasOwnProperty.call(open, "url"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(open, "urls"), false);
  assertDeeplyFrozen(open);
});

test("buildNativeStartPayload rejects unknown kinds and malformed inputs", () => {
  const { buildNativeStartPayload } = loadRouter();
  const intent = saveAsIntent();
  assert.throws(
    () =>
      buildNativeStartPayload({
        kind: "other",
        jobId: "j",
        attemptToken: "a",
        intent,
        url: "https://x",
        maxConnections: 1,
      }),
    TypeError
  );
  assert.throws(() => buildNativeStartPayload(null), TypeError);
  assert.throws(
    () =>
      buildNativeStartPayload({
        kind: "pget",
        jobId: "j",
        attemptToken: "a",
        intent,
        url: "https://x",
        maxConnections: 0,
      }),
    TypeError
  );
  assert.throws(
    () =>
      buildNativeStartPayload({
        kind: "file-open",
        jobId: "j",
        attemptToken: "a",
        intent: Object.assign({}, intent, { requestedFilename: "" }),
      }),
    TypeError
  );

  let hits = 0;
  const hostile = {};
  Object.defineProperty(hostile, "kind", {
    enumerable: true,
    get() {
      hits += 1;
      return "pget";
    },
  });
  assert.throws(() => buildNativeStartPayload(hostile), TypeError);
  assert.equal(hits, 0);
});

test("buildNativeStartPayload file-open never carries media URL or tokens", () => {
  const { buildNativeStartPayload } = loadRouter();
  const intent = saveAsIntent({
    requestedFilename: FLOREN,
    destinationDirectory: "D:\\\\Vids",
    userActionToken: "tok-SECRET",
  });
  const open = buildNativeStartPayload({
    kind: "file-open",
    jobId: "j",
    attemptToken: "a",
    intent,
    url: "https://cdn/should-not-appear",
    maxConnections: 9,
    cookie: "SECRET",
    headers: { Cookie: "SECRET" },
  });
  assert.deepEqual(Object.keys(open).sort(), [
    "attemptToken",
    "cmd",
    "dir",
    "jobId",
    "requestedFilename",
  ]);
  const raw = JSON.stringify(open);
  assert.equal(raw.includes("should-not-appear"), false);
  assert.equal(raw.includes("tok-SECRET"), false);
  assert.equal(raw.includes("SECRET"), false);
  assert.equal(open.requestedFilename, FLOREN);
  assert.equal(open.dir, "D:\\\\Vids");
});

// ---------------------------------------------------------------------------
// Caller mutation isolation
// ---------------------------------------------------------------------------

test("caller mutation cannot alter frozen decisions payloads or requests", () => {
  const {
    routeNativeMessage,
    normalizeDownloadRequest,
    buildNativeStartPayload,
  } = loadRouter();

  const intent = saveAsIntent();
  const decision = routeNativeMessage({
    type: "use-firefox",
    jobId: "j",
    intent: firefoxIntent({ requestedFilename: FLOREN }),
  });
  assert.throws(() => {
    decision.intent.requestedFilename = "x";
  });
  assert.throws(() => {
    decision.action = "ignore";
  });

  const item = defaultItem();
  const req = normalizeDownloadRequest({
    type: "download",
    tabId: 1,
    item,
    intent,
  });
  item.url = "https://mutated";
  intent.destinationDirectory = "mutated";
  assert.equal(req.item.url, "https://x/a.mp4");
  assert.equal(req.intent.destinationDirectory, "D:\\\\Vids");
  assert.throws(() => {
    req.item.url = "nope";
  });
  assert.throws(() => {
    req.intent.saveMode = "default";
  });

  const payload = buildNativeStartPayload({
    kind: "pget",
    jobId: "j",
    attemptToken: "a",
    intent: req.intent,
    url: "https://cdn/x.mp4",
    maxConnections: 2,
  });
  assert.throws(() => {
    payload.name = "nope";
  });
  assert.throws(() => {
    payload.urls[0] = "nope";
  });
});

// ---------------------------------------------------------------------------
// Source hygiene
// ---------------------------------------------------------------------------

test("module source has no downloads, storage, logging, random, spread, or input enumeration", () => {
  const abs = path.join(mediaCatcherRoot, "lib", "download-message-router.js");
  const src = fs.readFileSync(abs, "utf8");
  assert.equal(/downloads\.download/.test(src), false);
  assert.equal(/browser\.downloads/.test(src), false);
  // pget-fallback must only map to ignore-legacy; never Firefox handoff/true.
  assert.equal(/invokeFirefox\s*:\s*true/.test(src), false);
  assert.equal(
    /pget-fallback[\s\S]{0,120}request-firefox-handoff|pget-fallback[\s\S]{0,120}invokeFirefox\s*:\s*true/.test(
      src
    ),
    false
  );
  assert.equal(/localStorage|sessionStorage|indexedDB|storage\.local/.test(src), false);
  assert.equal(/console\./.test(src), false);
  assert.equal(/Math\.random/.test(src), false);
  assert.equal(/\.\.\./.test(src), false);
  // Must not enumerate caller message with for-in on the input parameter.
  assert.equal(/for\s*\(\s*var\s+\w+\s+in\s+message\s*\)/.test(src), false);
  assert.equal(/for\s*\(\s*const\s+\w+\s+in\s+message\s*\)/.test(src), false);
  assert.equal(/Object\.keys\(\s*message\s*\)/.test(src), false);
  assert.equal(/Object\.assign\(\s*\{\s*\}\s*,\s*message\s*\)/.test(src), false);
});
