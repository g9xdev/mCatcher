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
    providerGeneration: 1,
  });
  assert.equal(pget.cmd, "pget");
  assert.equal(pget.name, FLOREN);
  assert.equal(pget.dir, "D:\\\\Vids");
  assert.equal(pget.id, "j");
  assert.equal(pget.attemptToken, "a");
  assert.equal(pget.maxConnections, 2);
  assert.equal(pget.providerGeneration, 1);
  assertDeeplyFrozen(pget);

  const single = buildNativeStartPayload({
    kind: "pget-single",
    jobId: "j",
    attemptToken: "a2",
    intent,
    url: "https://cdn/x.mp4",
    providerGeneration: 0,
  });
  assert.equal(single.cmd, "pget-single");
  assert.equal(single.name, FLOREN);
  assert.equal(single.dir, "D:\\\\Vids");
  assert.equal(single.id, "j");
  assert.equal(single.attemptToken, "a2");
  assert.equal(single.maxConnections, 1);
  assert.equal(single.providerGeneration, 0);

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
    providerGeneration: 0,
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
    providerGeneration: 0,
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
        providerGeneration: 0,
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
  // file-error carries only type, optional sinkId, jobId, attemptToken, local_io, stable reason
  assert.equal(Object.prototype.hasOwnProperty.call(err.message, "path"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(err.message, "status"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(err.message, "bytes"), false);
  assert.deepEqual(Object.keys(err.message).sort(), [
    "attemptToken",
    "failureCategory",
    "jobId",
    "reason",
    "sinkId",
    "type",
  ]);

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
    providerGeneration: 0,
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
    providerGeneration: 0,
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
        providerGeneration: 0,
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
        providerGeneration: 0,
      }),
    TypeError
  );
  assert.throws(
    () =>
      buildNativeStartPayload({
        kind: "pget",
        jobId: "j",
        attemptToken: "a",
        intent,
        url: "https://x",
        maxConnections: 1,
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
    providerGeneration: 0,
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

// ---------------------------------------------------------------------------
// Task 20a hardenings — enum poison, category normalize, secrets, detectionId
// ---------------------------------------------------------------------------

function makeCoercionPoison(returnValue) {
  let hits = 0;
  const poison = {
    [Symbol.toPrimitive]() {
      hits += 1;
      return returnValue;
    },
    toString() {
      hits += 1;
      return String(returnValue);
    },
    valueOf() {
      hits += 1;
      return returnValue;
    },
  };
  return {
    poison,
    hits() {
      return hits;
    },
  };
}

test("pget-result enum fields reject hostile objects without coercion or indexing", () => {
  const { routeNativeMessage } = loadRouter();
  const fields = [
    { key: "status", good: "completed" },
    { key: "mode", good: "multi-range" },
    { key: "partState", good: "committed" },
    { key: "failureCategory", good: "timeout" },
  ];
  for (const field of fields) {
    const { poison, hits } = makeCoercionPoison(field.good);
    const msg = {
      type: "pget-result",
      id: "j",
      attemptToken: "a",
      status: "completed",
      mode: "multi-range",
      failureCategory: null,
      partState: "committed",
    };
    msg[field.key] = poison;
    const out = routeNativeMessage(msg);
    assert.deepEqual(
      out,
      { action: "ignore", invokeFirefox: false },
      `field=${field.key} must ignore hostile object`
    );
    assert.equal(hits(), 0, `field=${field.key} must not coerce`);
    assert.equal(out.status, undefined);
  }

  // Accessors on enum fields must not be invoked.
  for (const field of fields) {
    let accessorHits = 0;
    const msg = {
      type: "pget-result",
      id: "j",
      attemptToken: "a",
      status: "completed",
      mode: "multi-range",
      failureCategory: null,
      partState: "committed",
    };
    Object.defineProperty(msg, field.key, {
      enumerable: true,
      configurable: true,
      get() {
        accessorHits += 1;
        return field.good;
      },
    });
    const out = routeNativeMessage(msg);
    assert.deepEqual(out, { action: "ignore", invokeFirefox: false });
    assert.equal(accessorHits, 0, `field=${field.key} accessor must not run`);
  }
});

test("pget-result normalizes failureCategory by status and known set only", () => {
  const { routeNativeMessage } = loadRouter();
  const base = {
    type: "pget-result",
    id: "j",
    attemptToken: "a",
    mode: "multi-range",
    partState: "partial",
  };

  const completed = routeNativeMessage(
    Object.assign({}, base, {
      status: "completed",
      failureCategory: "timeout",
      partState: "committed",
    })
  );
  assert.equal(completed.action, "transport-result");
  assert.equal(completed.failureCategory, null);

  const cancelled = routeNativeMessage(
    Object.assign({}, base, {
      status: "cancelled",
      failureCategory: "timeout",
    })
  );
  assert.equal(cancelled.action, "transport-result");
  assert.equal(cancelled.failureCategory, "cancelled");

  const known = [
    "timeout",
    "connection_reset",
    "short_read",
    "http_429",
    "http_5xx_temporary",
    "range_unsupported",
    "local_io",
    "cancelled",
    "permanent",
  ];
  for (const cat of known) {
    if (cat === "range_unsupported") continue; // empty multi-range switch covered elsewhere
    const out = routeNativeMessage(
      Object.assign({}, base, {
        status: "failed",
        failureCategory: cat,
        partState: "partial",
      })
    );
    assert.equal(out.action, "transport-result", cat);
    assert.equal(out.failureCategory, cat, cat);
  }

  // empty multi-range range_unsupported switch remains exact
  const switchOut = routeNativeMessage(
    Object.assign({}, base, {
      status: "failed",
      failureCategory: "range_unsupported",
      partState: "empty",
    })
  );
  assert.equal(switchOut.action, "start-single-connection");
  assert.equal(switchOut.failureCategory, "range_unsupported");

  const unknownPrimitive = routeNativeMessage(
    Object.assign({}, base, {
      status: "failed",
      failureCategory: "not_a_real_category",
      partState: "partial",
    })
  );
  assert.equal(unknownPrimitive.action, "transport-result");
  assert.equal(unknownPrimitive.failureCategory, "permanent");

  const nullFailed = routeNativeMessage(
    Object.assign({}, base, {
      status: "failed",
      failureCategory: null,
      partState: "partial",
    })
  );
  assert.equal(nullFailed.action, "transport-result");
  assert.equal(nullFailed.failureCategory, "permanent");

  // malformed status/mode/part types ignore
  for (const patch of [
    { status: 1 },
    { status: true },
    { mode: 2 },
    { partState: false },
    { status: Object("completed") },
  ]) {
    const out = routeNativeMessage(
      Object.assign(
        {},
        base,
        {
          status: "completed",
          failureCategory: null,
          partState: "committed",
        },
        patch
      )
    );
    assert.deepEqual(out, { action: "ignore", invokeFirefox: false });
  }
});

test("pget-result and file-error never raw-forward signed URL or header sentinels", () => {
  const { routeNativeMessage } = loadRouter();
  const secret =
    "GET https://cdn/f?token=SECRET_SIGNED Cookie: SECRET_COOKIE";

  const pget = routeNativeMessage({
    type: "pget-result",
    id: "j",
    attemptToken: "a",
    status: "failed",
    mode: "multi-range",
    failureCategory: secret,
    partState: "partial",
  });
  assert.equal(pget.action, "transport-result");
  assert.equal(pget.failureCategory, "permanent");
  assertNoSecrets(pget);
  assert.equal(JSON.stringify(pget).includes(secret), false);
  assert.equal(JSON.stringify(pget).includes("SECRET_SIGNED"), false);
  assert.equal(JSON.stringify(pget).includes("SECRET_COOKIE"), false);

  const err = routeNativeMessage({
    type: "file-error",
    jobId: "j",
    attemptToken: "a",
    failureCategory: "local_io",
    reason: secret,
  });
  assert.equal(err.action, "file-sink-message");
  assert.equal(err.message.failureCategory, "local_io");
  assert.equal(Object.prototype.hasOwnProperty.call(err.message, "reason"), false);
  assertNoSecrets(err);
  assert.equal(JSON.stringify(err).includes("SECRET_SIGNED"), false);
  assert.equal(JSON.stringify(err).includes("SECRET_COOKIE"), false);

  const badCat = routeNativeMessage({
    type: "file-error",
    jobId: "j",
    attemptToken: "a",
    failureCategory: secret,
    reason: "write-failed",
  });
  assert.equal(badCat.action, "file-sink-message");
  assert.equal(
    Object.prototype.hasOwnProperty.call(badCat.message, "failureCategory"),
    false
  );
  assert.equal(badCat.message.reason, "write-failed");
  assertNoSecrets(badCat);

  const injected = routeNativeMessage({
    type: "file-error",
    jobId: "j",
    attemptToken: "a",
    failureCategory: "local_io",
    reason: "disk-full",
    status: secret,
    path: secret,
    bytes: 9,
    cookie: "SECRET_COOKIE",
    headers: { Authorization: "Bearer SECRET" },
  });
  assert.equal(injected.action, "file-sink-message");
  assert.deepEqual(Object.keys(injected.message).sort(), [
    "attemptToken",
    "failureCategory",
    "jobId",
    "reason",
    "type",
  ]);
  assertNoSecrets(injected);
});

test("file-committed rejects unsafe file paths; file-aborted reason uses stable tokens", () => {
  const { routeNativeMessage } = loadRouter();

  const okWin = routeNativeMessage({
    type: "file-committed",
    sinkId: "s1",
    file: "D:\\\\Vids\\\\out.mp4",
    bytes: 10,
  });
  assert.equal(okWin.action, "file-sink-message");
  assert.equal(okWin.message.file, "D:\\\\Vids\\\\out.mp4");

  const okUnix = routeNativeMessage({
    type: "file-committed",
    sinkId: "s1",
    file: "/home/user/media/out.mp4",
    bytes: 10,
  });
  assert.equal(okUnix.action, "file-sink-message");
  assert.equal(okUnix.message.file, "/home/user/media/out.mp4");

  const rejects = [
    "https://cdn/f?token=SECRET_SIGNED",
    "//cdn/f?token=SECRET",
    "file://host/path",
    "out.mp4\nCookie: SECRET_COOKIE",
    "path with Authorization: Bearer SECRET",
    "bad\u0000null",
    "line\r\nCookie: x",
  ];
  for (const file of rejects) {
    const out = routeNativeMessage({
      type: "file-committed",
      sinkId: "s1",
      file,
      bytes: 1,
    });
    assert.deepEqual(
      out,
      { action: "ignore", invokeFirefox: false },
      `file=${JSON.stringify(file)}`
    );
    assertNoSecrets(out);
  }

  const abortedOk = routeNativeMessage({
    type: "file-aborted",
    sinkId: "s1",
    reason: "user-cancel",
  });
  assert.equal(abortedOk.action, "file-sink-message");
  assert.equal(abortedOk.message.reason, "user-cancel");

  const abortedBad = routeNativeMessage({
    type: "file-aborted",
    sinkId: "s1",
    reason: "GET https://cdn/f?token=SECRET_SIGNED Cookie: SECRET_COOKIE",
  });
  assert.equal(abortedBad.action, "file-sink-message");
  assert.equal(Object.prototype.hasOwnProperty.call(abortedBad.message, "reason"), false);
  assertNoSecrets(abortedBad);

  const abortedLong = routeNativeMessage({
    type: "file-aborted",
    sinkId: "s1",
    reason: "a".repeat(65),
  });
  assert.equal(Object.prototype.hasOwnProperty.call(abortedLong.message, "reason"), false);
});

test("normalizeDownloadRequest preserves immutable detectionId and tightens item field types", () => {
  const { normalizeDownloadRequest } = loadRouter();
  const item = defaultItem({ detectionId: 123, tabId: 7, live: false });
  const req = normalizeDownloadRequest({
    type: "download",
    tabId: 1,
    item,
    userActionToken: "tok",
  });
  assert.equal(req.item.detectionId, 123);
  assert.equal(req.item.tabId, 7);
  assert.equal(req.item.live, false);
  assert.equal(Object.prototype.hasOwnProperty.call(req.item, "detectionId"), true);
  assertDeeplyFrozen(req.item);
  item.detectionId = 999;
  assert.equal(req.item.detectionId, 123);
  assert.throws(() => {
    req.item.detectionId = 456;
  });

  const generic = (fn) => {
    assert.throws(fn, (err) => {
      assert.equal(err instanceof TypeError, true);
      assert.equal(err.message, "invalid download message");
      assert.equal(String(err.message).includes("SECRET"), false);
      return true;
    });
  };

  generic(() =>
    normalizeDownloadRequest({
      type: "download",
      tabId: 1,
      userActionToken: "tok",
      item: defaultItem({ detectionId: -1 }),
    })
  );
  generic(() =>
    normalizeDownloadRequest({
      type: "download",
      tabId: 1,
      userActionToken: "tok",
      item: defaultItem({ detectionId: 1.5 }),
    })
  );
  generic(() =>
    normalizeDownloadRequest({
      type: "download",
      tabId: 1,
      userActionToken: "tok",
      item: defaultItem({ detectionId: "123" }),
    })
  );
  generic(() =>
    normalizeDownloadRequest({
      type: "download",
      tabId: 1,
      userActionToken: "tok",
      item: defaultItem({ detectionId: Object(123) }),
    })
  );
  generic(() =>
    normalizeDownloadRequest({
      type: "download",
      tabId: 1,
      userActionToken: "tok",
      item: defaultItem({ detectionId: true }),
    })
  );
  generic(() =>
    normalizeDownloadRequest({
      type: "download",
      tabId: 1,
      userActionToken: "tok",
      item: defaultItem({ kind: true }),
    })
  );
  generic(() =>
    normalizeDownloadRequest({
      type: "download",
      tabId: 1,
      userActionToken: "tok",
      item: defaultItem({ url: false }),
    })
  );
  generic(() =>
    normalizeDownloadRequest({
      type: "download",
      tabId: 1,
      userActionToken: "tok",
      item: defaultItem({ proposedFilename: true }),
    })
  );
  generic(() =>
    normalizeDownloadRequest({
      type: "download",
      tabId: 1,
      userActionToken: "tok",
      item: defaultItem({ providerKey: {} }),
    })
  );
  generic(() =>
    normalizeDownloadRequest({
      type: "download",
      tabId: 1,
      userActionToken: "tok",
      item: defaultItem({ tabId: -3 }),
    })
  );

  let detHits = 0;
  const accessorItem = defaultItem();
  Object.defineProperty(accessorItem, "detectionId", {
    enumerable: true,
    configurable: true,
    get() {
      detHits += 1;
      return 123;
    },
  });
  generic(() =>
    normalizeDownloadRequest({
      type: "download",
      tabId: 1,
      userActionToken: "tok",
      item: accessorItem,
    })
  );
  assert.equal(detHits, 0);

  // Runtime URL strings remain memory-only when provided as primitive strings.
  const withUrl = normalizeDownloadRequest({
    type: "download",
    tabId: 1,
    userActionToken: "tok",
    item: defaultItem({ url: "https://cdn/x.mp4?token=SECRET_RUNTIME" }),
  });
  assert.equal(withUrl.item.url, "https://cdn/x.mp4?token=SECRET_RUNTIME");
});

test("dependency exceptions propagate by identity after sanitized inputs", () => {
  const abs = path.join(mediaCatcherRoot, "lib", "download-message-router.js");
  const code = fs.readFileSync(abs, "utf8");
  const depErr = new Error("exact dependency boom SECRET_SHOULD_PROPAGATE");
  const protocolErr = new TypeError("protocol exact TypeError with SECRET");
  const root = {
    McDownloadIntent: {
      createDefaultIntent() {
        throw depErr;
      },
    },
    McFileSinkProtocol: {
      buildPgetCmd() {
        throw protocolErr;
      },
      buildPgetSingleCmd() {
        throw protocolErr;
      },
      createFileSinkSession() {
        throw protocolErr;
      },
    },
  };
  function selectiveRequire(id) {
    if (String(id).indexOf("download-intent") !== -1) {
      return root.McDownloadIntent;
    }
    if (String(id).indexOf("file-sink-protocol") !== -1) {
      return root.McFileSinkProtocol;
    }
    return require(id);
  }
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: selectiveRequire,
    console,
    self: root,
  };
  sandbox.module.exports = sandbox.exports;
  vm.runInNewContext(code, sandbox, { filename: abs });
  const api = sandbox.module.exports;

  let thrown = null;
  try {
    api.normalizeDownloadRequest({
      type: "download",
      tabId: 1,
      userActionToken: "tok",
      item: { proposedFilename: FLOREN, kind: "direct", url: "https://x/a.mp4" },
    });
  } catch (e) {
    thrown = e;
  }
  assert.equal(thrown, depErr);

  let thrown2 = null;
  try {
    api.buildNativeStartPayload({
      kind: "pget",
      jobId: "j",
      attemptToken: "a",
      intent: saveAsIntent(),
      url: "https://cdn/x.mp4",
      maxConnections: 1,
      providerGeneration: 0,
    });
  } catch (e) {
    thrown2 = e;
  }
  assert.equal(thrown2, protocolErr);
});

// ---------------------------------------------------------------------------
// Task 20c — provider-aware start contract, saved path, progress, limit-ack
// ---------------------------------------------------------------------------

test("buildNativeStartPayload forwards mirrors generation context and exact destination", () => {
  const { buildNativeStartPayload } = loadRouter();
  const intentSave = saveAsIntent({
    requestedFilename: FLOREN,
    destinationDirectory: "D:\\\\Vids",
  });
  const intentDefault = saveAsIntent({
    requestedFilename: FLOREN,
    destinationDirectory: null,
    saveMode: "default",
  });
  const primary = "https://cdn/x.mp4?sig=PRIMARY";
  const mirror = "https://mirror/x.mp4?sig=MIRROR";

  const pget = buildNativeStartPayload({
    kind: "pget",
    jobId: "j1",
    attemptToken: "atk-1",
    intent: intentSave,
    url: primary,
    mirrors: [primary, mirror, mirror, "", null],
    maxConnections: 4,
    providerGeneration: 5,
    referer: "https://florenfile.com/watch",
    userAgent: "mCatcher-Test/1",
  });
  assert.equal(pget.cmd, "pget");
  assert.deepEqual(pget.urls, [primary, mirror]);
  assert.equal(pget.name, FLOREN);
  assert.equal(pget.dir, "D:\\\\Vids");
  assert.equal(pget.providerGeneration, 5);
  assert.equal(pget.referer, "https://florenfile.com/watch");
  assert.equal(pget.userAgent, "mCatcher-Test/1");
  assert.equal(pget.maxConnections, 4);
  assertDeeplyFrozen(pget);

  const single = buildNativeStartPayload({
    kind: "pget-single",
    jobId: "j1",
    attemptToken: "atk-2",
    intent: intentDefault,
    url: primary,
    mirrors: [mirror],
    providerGeneration: 0,
    referer: "",
    userAgent: "",
    effectiveDestinationDirectory: "E:\\\\DefaultFolder",
  });
  assert.equal(single.cmd, "pget-single");
  assert.equal(single.maxConnections, 1);
  assert.equal(single.dir, "E:\\\\DefaultFolder");
  assert.equal(single.providerGeneration, 0);
  assert.deepEqual(single.urls, [primary, mirror]);

  const open = buildNativeStartPayload({
    kind: "file-open",
    jobId: "j1",
    attemptToken: "atk-3",
    intent: intentDefault,
    effectiveDestinationDirectory: "E:\\\\DefaultFolder",
  });
  assert.equal(open.cmd, "file-open");
  assert.equal(open.requestedFilename, FLOREN);
  assert.equal(open.dir, "E:\\\\DefaultFolder");
  assert.equal(Object.prototype.hasOwnProperty.call(open, "url"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(open, "userActionToken"), false);

  // Exact filename and resolved dir identical across native save paths.
  assert.equal(pget.name, single.name);
  assert.equal(single.name, open.requestedFilename);
  assert.equal(single.dir, open.dir);

  // Missing generation fails the new start contract (no silent default).
  assert.throws(
    () =>
      buildNativeStartPayload({
        kind: "pget",
        jobId: "j1",
        attemptToken: "atk",
        intent: intentSave,
        url: primary,
        maxConnections: 2,
      }),
    TypeError
  );
  assert.throws(
    () =>
      buildNativeStartPayload({
        kind: "pget-single",
        jobId: "j1",
        attemptToken: "atk",
        intent: intentSave,
        url: primary,
      }),
    TypeError
  );

  // Empty destination rejection.
  assert.throws(
    () =>
      buildNativeStartPayload({
        kind: "pget",
        jobId: "j1",
        attemptToken: "atk",
        intent: intentDefault,
        url: primary,
        maxConnections: 1,
        providerGeneration: 0,
        effectiveDestinationDirectory: "",
      }),
    TypeError
  );
  assert.throws(
    () =>
      buildNativeStartPayload({
        kind: "file-open",
        jobId: "j1",
        attemptToken: "atk",
        intent: intentDefault,
        effectiveDestinationDirectory: "  ",
      }),
    TypeError
  );
  // Conflicting non-null destination override.
  assert.throws(
    () =>
      buildNativeStartPayload({
        kind: "pget",
        jobId: "j1",
        attemptToken: "atk",
        intent: intentSave,
        url: primary,
        maxConnections: 1,
        providerGeneration: 0,
        effectiveDestinationDirectory: "E:\\\\Other",
      }),
    TypeError
  );

  // Control builders via start payload (no intent/url required).
  const limit = buildNativeStartPayload({
    kind: "pget-set-limit",
    jobId: "j1",
    attemptToken: "atk-limit",
    providerGeneration: 9,
    maxConnections: 0,
  });
  assert.deepEqual(limit, {
    cmd: "pget-set-limit",
    id: "j1",
    attemptToken: "atk-limit",
    providerGeneration: 9,
    maxConnections: 0,
  });
  assertDeeplyFrozen(limit);

  const cancel = buildNativeStartPayload({
    kind: "pget-cancel",
    jobId: "j1",
    attemptToken: "atk-cancel",
  });
  assert.deepEqual(cancel, {
    cmd: "pget-cancel",
    id: "j1",
    attemptToken: "atk-cancel",
  });
  assertDeeplyFrozen(cancel);

  assert.throws(
    () =>
      buildNativeStartPayload({
        kind: "pget-set-limit",
        jobId: "j1",
        attemptToken: "atk",
        maxConnections: 0,
      }),
    TypeError
  );
  assert.throws(
    () =>
      buildNativeStartPayload({
        kind: "pget-cancel",
        jobId: "j1",
      }),
    TypeError
  );
});

test("buildNativeStartPayload never touches cookie Authorization headers origin or token getters", () => {
  const { buildNativeStartPayload } = loadRouter();
  let hits = 0;
  const input = {
    kind: "pget",
    jobId: "j1",
    attemptToken: "atk",
    intent: saveAsIntent(),
    url: "https://cdn/x.mp4?sig=1",
    maxConnections: 2,
    providerGeneration: 1,
    referer: "https://page",
    userAgent: "UA",
  };
  for (const key of [
    "cookie",
    "Cookie",
    "headers",
    "Authorization",
    "origin",
    "userActionToken",
  ]) {
    Object.defineProperty(input, key, {
      enumerable: true,
      configurable: true,
      get() {
        hits += 1;
        return "SECRET";
      },
    });
  }
  const out = buildNativeStartPayload(input);
  assert.equal(out.cmd, "pget");
  assert.equal(hits, 0);
  assertNoSecrets(out);
  assert.equal(Object.prototype.hasOwnProperty.call(out, "cookie"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out, "headers"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out, "userActionToken"), false);
});

test("completed pget-result projects paired file+bytes; one-sided unsafe and non-completed fail closed", () => {
  const { routeNativeMessage } = loadRouter();
  const baseCompleted = {
    type: "pget-result",
    id: "j1",
    attemptToken: "atk-1",
    status: "completed",
    mode: "multi-range",
    failureCategory: null,
    partState: "committed",
  };

  // Backward compatible: omit both.
  const omitted = routeNativeMessage(Object.assign({}, baseCompleted));
  assert.equal(omitted.action, "transport-result");
  assert.equal(Object.prototype.hasOwnProperty.call(omitted, "file"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(omitted, "bytes"), false);
  assertDeeplyFrozen(omitted);

  const withBoth = routeNativeMessage(
    Object.assign({}, baseCompleted, {
      file: "D:\\\\Vids\\\\out.mp4",
      bytes: 4096,
    })
  );
  assert.equal(withBoth.action, "transport-result");
  assert.equal(withBoth.file, "D:\\\\Vids\\\\out.mp4");
  assert.equal(withBoth.bytes, 4096);
  assert.equal(withBoth.jobId, "j1");
  assert.equal(withBoth.attemptToken, "atk-1");
  assert.equal(withBoth.invokeFirefox, false);
  assertDeeplyFrozen(withBoth);

  // One-sided → ignore.
  for (const patch of [{ file: "D:\\\\Vids\\\\out.mp4" }, { bytes: 10 }]) {
    const out = routeNativeMessage(Object.assign({}, baseCompleted, patch));
    assert.deepEqual(out, { action: "ignore", invokeFirefox: false });
  }

  // Unsafe / URL-shaped / control chars → ignore.
  for (const file of [
    "https://cdn/f?token=SECRET",
    "//cdn/f",
    "file://host/x",
    "bad\u0000null",
    "line\r\nCookie: x",
    "path Authorization: Bearer SECRET",
  ]) {
    const out = routeNativeMessage(
      Object.assign({}, baseCompleted, { file, bytes: 1 })
    );
    assert.deepEqual(out, { action: "ignore", invokeFirefox: false });
    assertNoSecrets(out);
  }

  // Negative / fractional bytes → ignore.
  for (const bytes of [-1, 1.5, true, "10", null]) {
    const out = routeNativeMessage(
      Object.assign({}, baseCompleted, {
        file: "D:\\\\Vids\\\\out.mp4",
        bytes,
      })
    );
    assert.deepEqual(out, { action: "ignore", invokeFirefox: false });
  }

  // Accessor forms → ignore without invoking.
  let fileHits = 0;
  let bytesHits = 0;
  const accessorMsg = Object.assign({}, baseCompleted);
  Object.defineProperty(accessorMsg, "file", {
    enumerable: true,
    configurable: true,
    get() {
      fileHits += 1;
      return "D:\\\\Vids\\\\out.mp4";
    },
  });
  Object.defineProperty(accessorMsg, "bytes", {
    enumerable: true,
    configurable: true,
    get() {
      bytesHits += 1;
      return 9;
    },
  });
  assert.deepEqual(routeNativeMessage(accessorMsg), {
    action: "ignore",
    invokeFirefox: false,
  });
  assert.equal(fileHits, 0);
  assert.equal(bytesHits, 0);

  // Failed/cancelled metadata ignored (still transport-result, no file/bytes).
  const failed = routeNativeMessage({
    type: "pget-result",
    id: "j1",
    attemptToken: "atk",
    status: "failed",
    mode: "multi-range",
    failureCategory: "timeout",
    partState: "partial",
    file: "D:\\\\Vids\\\\out.mp4",
    bytes: 10,
  });
  assert.equal(failed.action, "transport-result");
  assert.equal(Object.prototype.hasOwnProperty.call(failed, "file"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(failed, "bytes"), false);

  const cancelled = routeNativeMessage({
    type: "pget-result",
    id: "j1",
    attemptToken: "atk",
    status: "cancelled",
    mode: "single-connection",
    failureCategory: "cancelled",
    partState: "partial",
    file: "D:\\\\Vids\\\\out.mp4",
    bytes: 10,
  });
  assert.equal(cancelled.action, "transport-result");
  assert.equal(Object.prototype.hasOwnProperty.call(cancelled, "file"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(cancelled, "bytes"), false);
});

test("pget-progress routes to frozen transport-progress with identity and bounds", () => {
  const { routeNativeMessage } = loadRouter();
  const ok = routeNativeMessage({
    type: "pget-progress",
    id: "j1",
    attemptToken: "atk-1",
    bytes: 50,
    total: 100,
  });
  assert.deepEqual(ok, {
    action: "transport-progress",
    invokeFirefox: false,
    jobId: "j1",
    attemptToken: "atk-1",
    bytes: 50,
    total: 100,
  });
  assertDeeplyFrozen(ok);

  const equal = routeNativeMessage({
    type: "pget-progress",
    id: "j1",
    attemptToken: "atk-1",
    bytes: 0,
    total: 0,
  });
  assert.equal(equal.action, "transport-progress");
  assert.equal(equal.bytes, 0);
  assert.equal(equal.total, 0);

  const rejects = [
    { type: "pget-progress", id: "j1", attemptToken: "atk", bytes: 2, total: 1 },
    { type: "pget-progress", id: "", attemptToken: "atk", bytes: 1, total: 2 },
    { type: "pget-progress", id: "j1", attemptToken: "  ", bytes: 1, total: 2 },
    { type: "pget-progress", id: "j1", attemptToken: "atk", bytes: -1, total: 2 },
    { type: "pget-progress", id: "j1", attemptToken: "atk", bytes: 1, total: 1.5 },
    { type: "pget-progress", id: "j1", attemptToken: "atk", bytes: 1 },
    { type: "pget-progress", attemptToken: "atk", bytes: 1, total: 2 },
    { type: "pget-progress", id: "j1", bytes: 1, total: 2 },
  ];
  for (const msg of rejects) {
    assert.deepEqual(routeNativeMessage(msg), {
      action: "ignore",
      invokeFirefox: false,
    });
  }

  let hits = 0;
  const acc = {
    type: "pget-progress",
    id: "j1",
    attemptToken: "atk",
  };
  Object.defineProperty(acc, "bytes", {
    enumerable: true,
    get() {
      hits += 1;
      return 1;
    },
  });
  Object.defineProperty(acc, "total", {
    enumerable: true,
    get() {
      hits += 1;
      return 2;
    },
  });
  assert.deepEqual(routeNativeMessage(acc), {
    action: "ignore",
    invokeFirefox: false,
  });
  assert.equal(hits, 0);
});

test("pget-limit-ack routes to frozen native-limit-ack with generation and zero limit", () => {
  const { routeNativeMessage } = loadRouter();
  const ok = routeNativeMessage({
    type: "pget-limit-ack",
    id: "j1",
    attemptToken: "atk-1",
    providerGeneration: 3,
    maxConnections: 0,
  });
  assert.deepEqual(ok, {
    action: "native-limit-ack",
    invokeFirefox: false,
    jobId: "j1",
    attemptToken: "atk-1",
    providerGeneration: 3,
    maxConnections: 0,
  });
  assertDeeplyFrozen(ok);

  const pos = routeNativeMessage({
    type: "pget-limit-ack",
    id: "j1",
    attemptToken: "atk-1",
    providerGeneration: 0,
    maxConnections: 4,
  });
  assert.equal(pos.action, "native-limit-ack");
  assert.equal(pos.providerGeneration, 0);
  assert.equal(pos.maxConnections, 4);

  const rejects = [
    {
      type: "pget-limit-ack",
      id: "j1",
      attemptToken: "atk",
      providerGeneration: -1,
      maxConnections: 0,
    },
    {
      type: "pget-limit-ack",
      id: "j1",
      attemptToken: "atk",
      providerGeneration: 1,
      maxConnections: -1,
    },
    {
      type: "pget-limit-ack",
      id: "j1",
      attemptToken: "atk",
      providerGeneration: 1.5,
      maxConnections: 0,
    },
    {
      type: "pget-limit-ack",
      id: "",
      attemptToken: "atk",
      providerGeneration: 1,
      maxConnections: 0,
    },
    {
      type: "pget-limit-ack",
      id: "j1",
      providerGeneration: 1,
      maxConnections: 0,
    },
    {
      type: "pget-limit-ack",
      id: "j1",
      attemptToken: "atk",
      maxConnections: 0,
    },
    {
      type: "pget-limit-ack",
      id: "j1",
      attemptToken: "atk",
      providerGeneration: 1,
    },
  ];
  for (const msg of rejects) {
    assert.deepEqual(routeNativeMessage(msg), {
      action: "ignore",
      invokeFirefox: false,
    });
  }

  let hits = 0;
  const acc = {
    type: "pget-limit-ack",
    id: "j1",
    attemptToken: "atk",
  };
  Object.defineProperty(acc, "providerGeneration", {
    enumerable: true,
    get() {
      hits += 1;
      return 1;
    },
  });
  Object.defineProperty(acc, "maxConnections", {
    enumerable: true,
    get() {
      hits += 1;
      return 0;
    },
  });
  assert.deepEqual(routeNativeMessage(acc), {
    action: "ignore",
    invokeFirefox: false,
  });
  assert.equal(hits, 0);
});

test("range_unsupported single-switch and legacy pget-fallback remain unchanged", () => {
  const { routeNativeMessage } = loadRouter();
  const switchOut = routeNativeMessage({
    type: "pget-result",
    id: "j",
    attemptToken: "a",
    status: "failed",
    mode: "multi-range",
    failureCategory: "range_unsupported",
    partState: "empty",
    file: "D:\\\\Vids\\\\out.mp4",
    bytes: 0,
  });
  assert.equal(switchOut.action, "start-single-connection");
  assert.equal(switchOut.invokeFirefox, false);
  assert.equal(Object.prototype.hasOwnProperty.call(switchOut, "file"), false);

  const legacy = routeNativeMessage({
    type: "pget-fallback",
    id: "j",
    reason: "no-range",
  });
  assert.equal(legacy.action, "ignore-legacy");
  assert.equal(legacy.invokeFirefox, false);
});

// ---------------------------------------------------------------------------
// Task 20c audit gaps — generation fencing, validation order, exact id, mirrors
// ---------------------------------------------------------------------------

test("pget-progress and pget-limit-ack require exact own-data id; never fall back to jobId", () => {
  const { routeNativeMessage } = loadRouter();

  // jobId alone (even valid) must not route progress/limit-ack.
  assert.deepEqual(
    routeNativeMessage({
      type: "pget-progress",
      jobId: "job-only",
      attemptToken: "atk",
      bytes: 1,
      total: 2,
    }),
    { action: "ignore", invokeFirefox: false }
  );
  assert.deepEqual(
    routeNativeMessage({
      type: "pget-limit-ack",
      jobId: "job-only",
      attemptToken: "atk",
      providerGeneration: 1,
      maxConnections: 0,
    }),
    { action: "ignore", invokeFirefox: false }
  );

  // Blank / missing / invalid id ignored even with valid jobId.
  for (const id of ["", "  ", null, 12, true]) {
    assert.deepEqual(
      routeNativeMessage({
        type: "pget-progress",
        id,
        jobId: "job-valid",
        attemptToken: "atk",
        bytes: 1,
        total: 2,
      }),
      { action: "ignore", invokeFirefox: false },
      `progress id=${String(id)}`
    );
    assert.deepEqual(
      routeNativeMessage({
        type: "pget-limit-ack",
        id,
        jobId: "job-valid",
        attemptToken: "atk",
        providerGeneration: 1,
        maxConnections: 0,
      }),
      { action: "ignore", invokeFirefox: false },
      `limit-ack id=${String(id)}`
    );
  }

  // Accessor id must not be invoked or accepted even with valid jobId.
  let hits = 0;
  const accProgress = {
    type: "pget-progress",
    jobId: "job-valid",
    attemptToken: "atk",
    bytes: 1,
    total: 2,
  };
  Object.defineProperty(accProgress, "id", {
    enumerable: true,
    get() {
      hits += 1;
      return "from-accessor";
    },
  });
  assert.deepEqual(routeNativeMessage(accProgress), {
    action: "ignore",
    invokeFirefox: false,
  });
  assert.equal(hits, 0);

  let hits2 = 0;
  const accLimit = {
    type: "pget-limit-ack",
    jobId: "job-valid",
    attemptToken: "atk",
    providerGeneration: 1,
    maxConnections: 0,
  };
  Object.defineProperty(accLimit, "id", {
    enumerable: true,
    get() {
      hits2 += 1;
      return "from-accessor";
    },
  });
  assert.deepEqual(routeNativeMessage(accLimit), {
    action: "ignore",
    invokeFirefox: false,
  });
  assert.equal(hits2, 0);

  // Exact nonblank id still works (jobId ignored for identity).
  const ok = routeNativeMessage({
    type: "pget-progress",
    id: "wire-id",
    jobId: "other-job",
    attemptToken: "atk",
    bytes: 3,
    total: 9,
  });
  assert.equal(ok.action, "transport-progress");
  assert.equal(ok.jobId, "wire-id");
});

test("buildNativeStartPayload validates fully before dependency resolve; malformed never leaks dependency errors", () => {
  const abs = path.join(mediaCatcherRoot, "lib", "download-message-router.js");
  const code = fs.readFileSync(abs, "utf8");
  const depErr = new Error("DEPENDENCY_SECRET");
  let resolveHits = 0;
  const root = {
    McDownloadIntent: {
      createDefaultIntent() {
        throw depErr;
      },
    },
    McFileSinkProtocol: {
      buildPgetCmd() {
        resolveHits += 1;
        throw depErr;
      },
      buildPgetSingleCmd() {
        resolveHits += 1;
        throw depErr;
      },
      buildPgetSetLimitCmd() {
        resolveHits += 1;
        throw depErr;
      },
      buildPgetCancelCmd() {
        resolveHits += 1;
        throw depErr;
      },
      createFileSinkSession() {
        resolveHits += 1;
        throw depErr;
      },
    },
  };
  function selectiveRequire(id) {
    if (String(id).indexOf("download-intent") !== -1) {
      resolveHits += 1;
      throw depErr;
    }
    if (String(id).indexOf("file-sink-protocol") !== -1) {
      resolveHits += 1;
      throw depErr;
    }
    return require(id);
  }
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: selectiveRequire,
    console,
    self: root,
  };
  sandbox.module.exports = sandbox.exports;
  vm.runInNewContext(code, sandbox, { filename: abs });
  const api = sandbox.module.exports;

  // VM-realm TypeError is not outer-realm instanceof; match by name+message.
  const generic = (fn) => {
    assert.throws(fn, (err) => {
      assert.equal(err && err.name, "TypeError");
      assert.equal(err.message, "invalid download message");
      assert.equal(String(err.message).includes("SECRET"), false);
      assert.notEqual(err, depErr);
      return true;
    });
  };

  // Malformed pget (bad maxConnections) must not resolve/call dependency.
  resolveHits = 0;
  generic(() =>
    api.buildNativeStartPayload({
      kind: "pget",
      jobId: "j",
      attemptToken: "a",
      intent: saveAsIntent(),
      url: "https://cdn/x.mp4",
      maxConnections: 0,
      providerGeneration: 1,
    })
  );
  assert.equal(resolveHits, 0);

  // Missing generation.
  resolveHits = 0;
  generic(() =>
    api.buildNativeStartPayload({
      kind: "pget",
      jobId: "j",
      attemptToken: "a",
      intent: saveAsIntent(),
      url: "https://cdn/x.mp4",
      maxConnections: 2,
    })
  );
  assert.equal(resolveHits, 0);

  // Hostile mirrors index getter with secret — generic TypeError, no dependency.
  resolveHits = 0;
  const hostileMirrors = ["https://mirror/x.mp4"];
  Object.defineProperty(hostileMirrors, "0", {
    enumerable: true,
    configurable: true,
    get() {
      throw new Error("DEPENDENCY_SECRET_MIRROR");
    },
  });
  generic(() =>
    api.buildNativeStartPayload({
      kind: "pget",
      jobId: "j",
      attemptToken: "a",
      intent: saveAsIntent(),
      url: "https://cdn/x.mp4",
      mirrors: hostileMirrors,
      maxConnections: 2,
      providerGeneration: 1,
    })
  );
  assert.equal(resolveHits, 0);

  // Present null referer rejects before dependency.
  resolveHits = 0;
  generic(() =>
    api.buildNativeStartPayload({
      kind: "pget",
      jobId: "j",
      attemptToken: "a",
      intent: saveAsIntent(),
      url: "https://cdn/x.mp4",
      maxConnections: 2,
      providerGeneration: 1,
      referer: null,
    })
  );
  assert.equal(resolveHits, 0);

  // Control command malformed generation before dependency.
  resolveHits = 0;
  generic(() =>
    api.buildNativeStartPayload({
      kind: "pget-set-limit",
      jobId: "j",
      attemptToken: "a",
      maxConnections: 0,
    })
  );
  assert.equal(resolveHits, 0);

  // After full sanitization, dependency exceptions still propagate by identity.
  let thrown = null;
  try {
    api.buildNativeStartPayload({
      kind: "pget",
      jobId: "j",
      attemptToken: "a",
      intent: saveAsIntent(),
      url: "https://cdn/x.mp4",
      maxConnections: 2,
      providerGeneration: 1,
    });
  } catch (e) {
    thrown = e;
  }
  assert.equal(thrown, depErr);
});

test("buildNativeStartPayload HTTP context rejects present null/undefined/controls including C1", () => {
  const { buildNativeStartPayload } = loadRouter();
  const base = {
    kind: "pget",
    jobId: "j1",
    attemptToken: "atk",
    intent: saveAsIntent(),
    url: "https://cdn/x.mp4",
    maxConnections: 2,
    providerGeneration: 1,
  };

  // Absent → empty strings on wire.
  const absent = buildNativeStartPayload(base);
  assert.equal(absent.referer, "");
  assert.equal(absent.userAgent, "");

  // Ordinary present strings accepted.
  const ok = buildNativeStartPayload(
    Object.assign({}, base, {
      referer: "https://page.example/",
      userAgent: "UA/1",
    })
  );
  assert.equal(ok.referer, "https://page.example/");
  assert.equal(ok.userAgent, "UA/1");

  const generic = (fn) => {
    assert.throws(fn, (err) => {
      assert.equal(err instanceof TypeError, true);
      assert.equal(err.message, "invalid download message");
      return true;
    });
  };

  generic(() =>
    buildNativeStartPayload(Object.assign({}, base, { referer: null }))
  );
  generic(() =>
    buildNativeStartPayload(Object.assign({}, base, { userAgent: null }))
  );
  generic(() =>
    buildNativeStartPayload(Object.assign({}, base, { referer: undefined }))
  );
  generic(() =>
    buildNativeStartPayload(Object.assign({}, base, { userAgent: undefined }))
  );
  for (const bad of ["a\nb", "a\rb", "a\u0000b", "a\u0085b", "a\u007fb"]) {
    generic(() =>
      buildNativeStartPayload(Object.assign({}, base, { referer: bad }))
    );
    generic(() =>
      buildNativeStartPayload(Object.assign({}, base, { userAgent: bad }))
    );
  }

  let hits = 0;
  const acc = Object.assign({}, base);
  Object.defineProperty(acc, "userAgent", {
    enumerable: true,
    get() {
      hits += 1;
      return "UA";
    },
  });
  generic(() => buildNativeStartPayload(acc));
  assert.equal(hits, 0);
});

test("buildNativeStartPayload snapshots mirrors descriptor-safely before dependency", () => {
  const { buildNativeStartPayload } = loadRouter();
  const primary = "https://cdn/x.mp4?sig=P";
  const mirror = "https://mirror/x.mp4?sig=M";
  const out = buildNativeStartPayload({
    kind: "pget",
    jobId: "j1",
    attemptToken: "atk",
    intent: saveAsIntent(),
    url: primary,
    mirrors: [mirror, primary, mirror, "", null],
    maxConnections: 2,
    providerGeneration: 1,
  });
  assert.deepEqual(out.urls, [primary, mirror]);
  assert.equal(Object.isFrozen(out.urls), true);

  // Sparse mirrors fail generically.
  const sparse = [];
  sparse.length = 1;
  assert.throws(
    () =>
      buildNativeStartPayload({
        kind: "pget",
        jobId: "j1",
        attemptToken: "atk",
        intent: saveAsIntent(),
        url: primary,
        mirrors: sparse,
        maxConnections: 2,
        providerGeneration: 1,
      }),
    (err) => {
      assert.equal(err instanceof TypeError, true);
      assert.equal(err.message, "invalid download message");
      return true;
    }
  );

  // Hostile length via proxy trap — no secret leak (Array.length cannot be redefined).
  const hostileLen = new Proxy([mirror], {
    getOwnPropertyDescriptor(target, prop) {
      if (prop === "length") {
        return {
          configurable: true,
          enumerable: false,
          get() {
            throw new Error("DEPENDENCY_SECRET_LEN");
          },
        };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
  assert.throws(
    () =>
      buildNativeStartPayload({
        kind: "pget",
        jobId: "j1",
        attemptToken: "atk",
        intent: saveAsIntent(),
        url: primary,
        mirrors: hostileLen,
        maxConnections: 2,
        providerGeneration: 1,
      }),
    (err) => {
      assert.equal(err instanceof TypeError, true);
      assert.equal(err.message, "invalid download message");
      assert.equal(String(err.message).includes("SECRET"), false);
      return true;
    }
  );
});
