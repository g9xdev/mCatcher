"use strict";

/**
 * BA01–BA04 — Lease 1 background adapters (detection → safe popup slice).
 * Production module: media-catcher/lib/background-adapters.js
 * Real pure deps only; injected effects/clock/token are faked.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const { loadLib, mediaCatcherRoot } = require("./harness/load-lib.js");

const CONTROLLER_KEYS = Object.freeze([
  "captureNetwork",
  "acceptPageSnapshot",
  "captureDomMedia",
  "registerVariants",
  "popupMedia",
  "enqueueDownload",
  "handleNativeMessage",
  "requestFirefoxHandoff",
  "cancel",
  "manualRetry",
  "helperDisconnected",
  "setMaxConcurrent",
  "tick",
  "pump",
  "popupJobs",
]);

const LEASE1_MSG = "background adapter behavior not implemented in Lease 1";

const FLOREN_FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(mediaCatcherRoot, "tests", "fixtures", "florenfile-candidates.json"),
    "utf8"
  )
);

const SECRET_SENTINELS = Object.freeze([
  "SECRET_SIGNED_QUERY_XYZ",
  "SECRET_COOKIE_ABC",
  "SECRET_AUTH_BEARER_TOKEN",
  "SECRET_REFERER_PATH",
  "SECRET_PAGE_PATH",
  "SECRET_MEDIA_ORIGIN_HOST",
]);

function loadAdapters() {
  return loadLib("lib/background-adapters.js");
}

function makeEffects() {
  const counts = {
    postNative: 0,
    downloadsDownload: 0,
    createObjectURL: 0,
    revokeObjectURL: 0,
    fetchArrayBuffer: 0,
    assembleMedia: 0,
    isPopupSender: 0,
    getEffectiveDestinationDirectory: 0,
    publishDetection: 0,
    publishJobs: 0,
    persistHistory: 0,
    reportDiagnostic: 0,
    randomToken: 0,
    now: 0,
  };
  const publishDetections = [];
  const diagnostics = [];
  let clock = 1_000_000;
  let tokenSeq = 0;

  const effects = {
    counts,
    publishDetections,
    diagnostics,
    setClock(ms) {
      clock = ms;
    },
    advance(ms) {
      clock += ms;
    },
    options(overrides) {
      const base = {
        maxConcurrent: 2,
        segmentConcurrency: 3,
        retries: 2,
        now() {
          counts.now += 1;
          return clock;
        },
        randomToken(namespace) {
          counts.randomToken += 1;
          // Deliberately collides when tokenSeq not advanced externally —
          // adapter must still mint unique public IDs.
          return "tok-repeat";
        },
        postNative(command) {
          counts.postNative += 1;
          return command;
        },
        downloadsDownload(options) {
          counts.downloadsDownload += 1;
          return options;
        },
        createObjectURL(blob) {
          counts.createObjectURL += 1;
          return "blob:fake";
        },
        revokeObjectURL(url) {
          counts.revokeObjectURL += 1;
        },
        fetchArrayBuffer(url, init) {
          counts.fetchArrayBuffer += 1;
          return Promise.resolve(new ArrayBuffer(0));
        },
        assembleMedia(input) {
          counts.assembleMedia += 1;
          return Promise.resolve(null);
        },
        isPopupSender(sender) {
          counts.isPopupSender += 1;
          return true;
        },
        getEffectiveDestinationDirectory() {
          counts.getEffectiveDestinationDirectory += 1;
          return null;
        },
        publishDetection(safeDetection) {
          counts.publishDetection += 1;
          publishDetections.push(safeDetection);
        },
        publishJobs(safeJobs) {
          counts.publishJobs += 1;
        },
        persistHistory(safeHistory) {
          counts.persistHistory += 1;
        },
        reportDiagnostic(safeDiagnostic) {
          counts.reportDiagnostic += 1;
          diagnostics.push(safeDiagnostic);
        },
      };
      return Object.assign(base, overrides || {});
    },
  };
  return effects;
}

function assertDeepFrozen(value, label) {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value), label + " must be frozen");
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertDeepFrozen(value[i], label + "[" + i + "]");
    }
    return;
  }
  for (const k of Object.keys(value)) {
    assertDeepFrozen(value[k], label + "." + k);
  }
}

function assertNoSentinels(value, label) {
  const raw = JSON.stringify(value);
  for (const s of SECRET_SENTINELS) {
    assert.equal(raw.includes(s), false, label + " must not contain " + s);
  }
  const forbiddenFieldNames = [
    "mediaUrl",
    "requestHeaders",
    "sourceContext",
    "Cookie",
    "Authorization",
    "referrer",
    "referer",
    "topLevelPageUrl",
    "immediateReferrerUrl",
    "mediaOrigin",
    "documentUrl",
    "pageUrl",
  ];
  for (const name of forbiddenFieldNames) {
    // Field names only as JSON keys
    assert.equal(
      raw.includes('"' + name + '"'),
      false,
      label + " must not expose field " + name
    );
  }
}

function isSafeOpaqueId(id) {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 80 &&
    /^[A-Za-z0-9._:-]+$/.test(id) &&
    !/^\d+$/.test(id)
  );
}

function florenPageUrl() {
  return FLOREN_FIXTURE.pageUrl;
}

function florenSnapshot(overrides) {
  const base = {
    documentId: "doc-floren-1",
    tabId: 42,
    frameId: 0,
    pageUrl: florenPageUrl(),
    topLevelPageUrl: florenPageUrl(),
    documentNonce: "nonce-floren-1",
    candidates: FLOREN_FIXTURE.candidates.slice(),
    capturedAt: "2026-08-12T12:00:00.000Z",
  };
  return Object.assign(base, overrides || {});
}

function florenNetworkInput(overrides) {
  const base = {
    details: {
      url:
        "https://s40.example-cdn.invalid/file.mp4?token=SECRET_SIGNED_QUERY_XYZ&exp=99",
      documentUrl: florenPageUrl(),
      originUrl: florenPageUrl() + "?ref=SECRET_REFERER_PATH",
      tabId: 42,
      frameId: 0,
      documentId: "doc-floren-1",
      timeStamp: 1_000_000,
      responseHeaders: [
        { name: "Content-Type", value: "video/mp4" },
      ],
    },
    hints: {
      topLevelUrlHint: florenPageUrl(),
      frameOrigin: "https://florenfile.com",
    },
    transport: {
      mediaKind: "direct",
      requestHeaders: {
        Cookie: "session=SECRET_COOKIE_ABC",
        Authorization: "Bearer SECRET_AUTH_BEARER_TOKEN",
        Referer: florenPageUrl() + "?ref=SECRET_REFERER_PATH",
      },
    },
  };
  return Object.assign(base, overrides || {});
}

function productionSource() {
  return fs.readFileSync(
    path.join(mediaCatcherRoot, "lib", "background-adapters.js"),
    "utf8"
  );
}

/**
 * Extract enumerable pending object literals that production installs via:
 *   var pending = { detectionId, ephemeral, mediaKind, tabId };
 *   installFutureTransport(pending, futureTransport);
 *   pendingByMediaId.set(mediaId, pending);
 * (not the old inline `.set(mediaId, { ... })` shape).
 */
function extractPendingSetBlocks(src) {
  const blocks = [];
  const re = /var\s+pending\s*=\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index + m[0].length - 1; // at '{'
    let depth = 0;
    let end = -1;
    for (let i = start; i < src.length; i++) {
      const ch = src[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    assert.ok(end > start, "pending object literal must be balanced");
    const block = src.slice(start, end + 1);
    // Require the non-enumerable future-transport install + set(mediaId, pending)
    // immediately after this literal (network + DOM capture sites).
    const after = src.slice(end + 1, end + 1 + 500);
    if (
      !/installFutureTransport\s*\(\s*pending\s*,\s*futureTransport\s*\)/.test(
        after
      )
    ) {
      continue;
    }
    if (!/pendingByMediaId\.set\s*\(\s*mediaId\s*,\s*pending\s*\)/.test(after)) {
      continue;
    }
    blocks.push(block);
  }
  return blocks;
}

function classicVmBuiltins(root) {
  return {
    console,
    self: root,
    Object,
    Map,
    Set,
    Array,
    Promise,
    Error,
    TypeError,
    RangeError,
    Number,
    String,
    Math,
    JSON,
    Date,
    URL,
    isFinite,
    parseInt,
    parseFloat,
    Boolean,
    RegExp,
    Function,
    Symbol,
    Reflect,
    Proxy,
    undefined,
  };
}

function loadClassicDependencies(sandbox, root) {
  const depFiles = [
    "detection-finalizer.js",
    "source-context.js",
    "filename-ranker.js",
    "provider-registry.js",
    "privacy.js",
    "firefox-guard.js",
  ];
  for (const name of depFiles) {
    const abs = path.join(mediaCatcherRoot, "lib", name);
    const code = fs.readFileSync(abs, "utf8");
    vm.runInNewContext(code, sandbox, { filename: abs });
  }
  assert.equal(typeof root.McDetectionFinalizer, "object");
  assert.equal(typeof root.McSourceContext, "object");
  assert.equal(typeof root.McFilenameRanker, "object");
  assert.equal(typeof root.McProviderRegistry, "object");
  assert.equal(typeof root.McPrivacy, "object");
  assert.equal(typeof root.McFirefoxGuard, "object");
}

const GENERIC_ADAPTER_MSG = "invalid background adapter input";
const DATE_RANGE_MS = 8.64e15;

/**
 * Classic-script load with test-private Map + finalizer instrumentation.
 * Delegates all real dependency methods/results unchanged; retains instances
 * only for listFinalized / pending-record inspection. No production hooks.
 */
function loadInstrumentedClassic() {
  const abs = path.join(mediaCatcherRoot, "lib", "background-adapters.js");
  const code = fs.readFileSync(abs, "utf8");
  const root = Object.create(null);
  const sandbox = classicVmBuiltins(root);

  const trackedMaps = [];
  class TrackingMap extends Map {
    constructor() {
      super();
      this._sets = [];
      trackedMaps.push(this);
    }
    set(key, value) {
      this._sets.push({ key: key, value: value });
      return super.set(key, value);
    }
  }
  sandbox.Map = TrackingMap;

  loadClassicDependencies(sandbox, root);

  const finalizers = [];
  const RealDF = root.McDetectionFinalizer;
  const realCreate = RealDF.createDetectionFinalizer;
  root.McDetectionFinalizer = {
    CONTEXT_WAIT_MS: RealDF.CONTEXT_WAIT_MS,
    mapWebRequestDetails: RealDF.mapWebRequestDetails,
    createDetectionFinalizer(deps) {
      const instance = realCreate.call(RealDF, deps);
      finalizers.push(instance);
      return instance;
    },
  };

  vm.runInNewContext(code, sandbox, { filename: abs });
  assert.equal(typeof root.McBackgroundAdapters, "object");

  return {
    api: root.McBackgroundAdapters,
    trackedMaps,
    finalizers,
    sessionFinalizer() {
      return finalizers[0] || null;
    },
    pendingRecords() {
      const out = [];
      for (const m of trackedMaps) {
        for (const entry of m._sets) {
          const v = entry.value;
          if (!v || typeof v !== "object") continue;
          const keys = Object.keys(v).slice().sort();
          if (
            keys.length === 4 &&
            keys[0] === "detectionId" &&
            keys[1] === "ephemeral" &&
            keys[2] === "mediaKind" &&
            keys[3] === "tabId"
          ) {
            out.push(v);
          }
        }
      }
      return out;
    },
    sourceRecords() {
      const out = [];
      for (const m of trackedMaps) {
        for (const entry of m._sets) {
          const v = entry.value;
          if (!v || typeof v !== "object") continue;
          const keys = Object.keys(v);
          if (
            keys.includes("mediaId") &&
            keys.includes("proposedFilename") &&
            keys.includes("mediaKind")
          ) {
            out.push(v);
          }
        }
      }
      return out;
    },
  };
}

/**
 * Prove a fresh adapter-authored TypeError: exact generic message, no wrapped
 * cause/identity, and no concrete engine/trap/hostile phrases.
 * Do not ban bare "IsArray" — adapter stack frames legitimately name safeIsArray.
 */
function assertGenericTypeError(err, opts) {
  assert.ok(err instanceof TypeError, "expected TypeError, got " + err);
  assert.equal(err.name, "TypeError");
  assert.equal(err.message, GENERIC_ADAPTER_MSG);
  // Fresh adapter-authored — must not retain a native/hostile cause chain.
  assert.equal(
    Object.prototype.hasOwnProperty.call(err, "cause") ? err.cause : undefined,
    undefined,
    "generic TypeError must not retain a cause"
  );
  if (opts && opts.notSameAs != null) {
    assert.notEqual(
      err,
      opts.notSameAs,
      "must not rethrow hostile/native exception identity"
    );
  }
  // Message is already exact; scan message+stack only for concrete engine/trap
  // phrases and hostile sentinels (not helper names like safeIsArray).
  const blob = String(err.message) + "\n" + String(err.stack || "");
  const leak =
    /Cannot perform|revoked proxy|Proxy\s*handler|getOwnPropertyDescriptor|hostilesecret|HOSTILE_SECRET|which is no longer usable|is not iterable|Illegal invocation/i.test(
      blob
    );
  assert.equal(
    leak,
    false,
    "adapter error must not leak engine/trap text: " + err.message
  );
}

function assertNoMaterialEffects(fx, baseline) {
  const b = baseline || {};
  assert.equal(fx.counts.postNative, b.postNative || 0);
  assert.equal(fx.counts.downloadsDownload, b.downloadsDownload || 0);
  assert.equal(fx.counts.fetchArrayBuffer, b.fetchArrayBuffer || 0);
  assert.equal(fx.counts.assembleMedia, b.assembleMedia || 0);
  assert.equal(fx.counts.createObjectURL, b.createObjectURL || 0);
  assert.equal(fx.counts.revokeObjectURL, b.revokeObjectURL || 0);
  assert.equal(fx.counts.publishDetection, b.publishDetection || 0);
  assert.equal(fx.counts.publishJobs, b.publishJobs || 0);
  assert.equal(fx.counts.persistHistory, b.persistHistory || 0);
}

function assertNoFinalizerResidue(finalizer, mediaCtrl, tabId) {
  assert.ok(finalizer, "session finalizer must be captured");
  assert.equal(finalizer.listFinalized().length, 0);
  // Length check only — classic-VM arrays are cross-realm vs assert helpers.
  assert.equal(mediaCtrl.popupMedia(tabId).length, 0);
}

function validNetworkCapture(overrides) {
  return florenNetworkInput(overrides);
}

function validDomCapture(overrides) {
  const base = {
    mediaUrl: "https://cdn.example/dom-valid.mp4",
    mediaOrigin: "https://cdn.example",
    contentDisposition: null,
    referrerUrl: "https://site.example/watch",
    frameOrigin: "https://site.example",
    ts: 1_000_000,
    snapshot: {
      documentId: "doc-dom-valid",
      tabId: 70,
      frameId: 0,
      pageUrl: "https://site.example/watch",
      topLevelPageUrl: "https://site.example/watch",
      documentNonce: "n-dom-valid",
      candidates: [{ kind: "visible-filename", value: "dom-valid.mp4" }],
      capturedAt: "2026-08-12T12:00:00.000Z",
    },
    transport: { mediaKind: "direct", requestHeaders: null },
  };
  return Object.assign(base, overrides || {});
}

function assertFirstObservableIds(mediaId, pendingRec) {
  assert.ok(isSafeOpaqueId(mediaId));
  assert.match(mediaId, /:1$/);
  assert.equal(pendingRec.detectionId, 1);
}

// ---------------------------------------------------------------------------
// BA01 — dual export and permanent controller surface
// ---------------------------------------------------------------------------

test("BA01 — dual export assigns McBackgroundAdapters and exports only createBackgroundAdapters", async (t) => {
  // Mutation caught: export/API drift, unfrozen controller, eager material
  // effects, or a later writer changing Promise conventions.

  const abs = path.join(mediaCatcherRoot, "lib", "background-adapters.js");
  assert.ok(fs.existsSync(abs), "production module must exist for dual-export load");

  // --- CommonJS load ---
  const api = loadAdapters();
  assert.ok(Object.isFrozen(api), "CommonJS export must be frozen");
  assert.deepEqual(Object.keys(api), ["createBackgroundAdapters"]);
  assert.equal(typeof api.createBackgroundAdapters, "function");

  // --- classic-script VM load (genuine classic: no CommonJS globals) ---
  await t.test(
    "BA01 classic-script load has no CommonJS globals and adds only McBackgroundAdapters",
    async () => {
      const code = fs.readFileSync(abs, "utf8");
      const root = Object.create(null);
      const sandbox = classicVmBuiltins(root);
      // Explicitly prove no CommonJS resolution surface.
      assert.equal(Object.prototype.hasOwnProperty.call(sandbox, "module"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(sandbox, "exports"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(sandbox, "require"), false);

      let browserHits = 0;
      let chromeHits = 0;
      Object.defineProperty(sandbox, "browser", {
        configurable: true,
        enumerable: false,
        get() {
          browserHits += 1;
          throw new Error("browser global must not be touched");
        },
      });
      Object.defineProperty(sandbox, "chrome", {
        configurable: true,
        enumerable: false,
        get() {
          chromeHits += 1;
          throw new Error("chrome global must not be touched");
        },
      });

      // Real Mc* dependencies supplied only on the classic-script root.
      loadClassicDependencies(sandbox, root);
      const beforeKeys = Object.keys(root).slice().sort();

      vm.runInNewContext(code, sandbox, { filename: abs });
      assert.equal(typeof root.McBackgroundAdapters, "object");
      assert.ok(Object.isFrozen(root.McBackgroundAdapters));
      assert.deepEqual(Object.keys(root.McBackgroundAdapters), [
        "createBackgroundAdapters",
      ]);
      const afterKeys = Object.keys(root).slice().sort();
      assert.deepEqual(
        afterKeys.filter((k) => k !== "McBackgroundAdapters"),
        beforeKeys,
        "loading must create only McBackgroundAdapters global"
      );
      assert.equal(browserHits, 0, "browser getter must not run");
      assert.equal(chromeHits, 0, "chrome getter must not run");

      const fx = makeEffects();
      let effectHits = 0;
      const classicCtrl = root.McBackgroundAdapters.createBackgroundAdapters(
        fx.options({
          postNative() {
            effectHits += 1;
          },
          downloadsDownload() {
            effectHits += 1;
          },
          createObjectURL() {
            effectHits += 1;
            return "blob:x";
          },
          revokeObjectURL() {
            effectHits += 1;
          },
          fetchArrayBuffer() {
            effectHits += 1;
            return Promise.resolve(new ArrayBuffer(0));
          },
          assembleMedia() {
            effectHits += 1;
            return Promise.resolve(null);
          },
          publishDetection() {
            effectHits += 1;
          },
          publishJobs() {
            effectHits += 1;
          },
          persistHistory() {
            effectHits += 1;
          },
          reportDiagnostic() {
            effectHits += 1;
          },
        })
      );
      assert.ok(Object.isFrozen(classicCtrl));
      assert.deepEqual(Object.keys(classicCtrl), CONTROLLER_KEYS.slice());
      for (const k of CONTROLLER_KEYS) {
        assert.equal(typeof classicCtrl[k], "function", k + " must be a function");
      }
      assert.equal(effectHits, 0);
      assert.equal(browserHits, 0);
      assert.equal(chromeHits, 0);
    }
  );

  // --- factory controller surface (CommonJS) ---
  const fx = makeEffects();
  let effectHits = 0;
  const opts = fx.options({
    postNative() {
      effectHits += 1;
      fx.counts.postNative += 1;
    },
    downloadsDownload() {
      effectHits += 1;
      fx.counts.downloadsDownload += 1;
    },
    createObjectURL() {
      effectHits += 1;
      fx.counts.createObjectURL += 1;
      return "blob:x";
    },
    revokeObjectURL() {
      effectHits += 1;
      fx.counts.revokeObjectURL += 1;
    },
    fetchArrayBuffer() {
      effectHits += 1;
      fx.counts.fetchArrayBuffer += 1;
      return Promise.resolve(new ArrayBuffer(0));
    },
    assembleMedia() {
      effectHits += 1;
      fx.counts.assembleMedia += 1;
      return Promise.resolve(null);
    },
    publishDetection() {
      effectHits += 1;
      fx.counts.publishDetection += 1;
    },
    publishJobs() {
      effectHits += 1;
      fx.counts.publishJobs += 1;
    },
    persistHistory() {
      effectHits += 1;
      fx.counts.persistHistory += 1;
    },
    reportDiagnostic() {
      effectHits += 1;
      fx.counts.reportDiagnostic += 1;
    },
  });
  const ctrl = api.createBackgroundAdapters(opts);
  assert.ok(Object.isFrozen(ctrl), "controller must be frozen");
  assert.deepEqual(Object.keys(ctrl), CONTROLLER_KEYS.slice());
  for (const k of CONTROLLER_KEYS) {
    assert.equal(typeof ctrl[k], "function", k + " must be a function");
  }
  // Construction must not invoke material effects.
  assert.equal(effectHits, 0);
  assert.equal(fx.counts.downloadsDownload, 0);
  assert.equal(fx.counts.postNative, 0);
  assert.equal(fx.counts.publishDetection, 0);

  // Synchronous contracts
  assert.equal(ctrl.acceptPageSnapshot(null), undefined);
  assert.throws(
    () => ctrl.registerVariants("media-x", []),
    (err) => err instanceof Error && err.message === LEASE1_MSG
  );
  const jobs = ctrl.popupJobs();
  assert.ok(Array.isArray(jobs));
  assert.equal(jobs.length, 0);
  assertDeepFrozen(jobs, "popupJobs()");
  const jobs2 = ctrl.popupJobs();
  assert.notEqual(jobs, jobs2, "popupJobs must return a fresh array");

  // Async future stubs return a Promise before rejecting (never throw sync).
  const asyncStubs = [
    () => ctrl.enqueueDownload({}, {}),
    () => ctrl.handleNativeMessage({}),
    () => ctrl.requestFirefoxHandoff({}, {}),
    () => ctrl.cancel("j1"),
    () => ctrl.manualRetry("j1"),
    () => ctrl.helperDisconnected(),
    () => ctrl.setMaxConcurrent(3),
    () => ctrl.pump(),
  ];
  for (const call of asyncStubs) {
    let p;
    assert.doesNotThrow(() => {
      p = call();
    });
    assert.ok(p && typeof p.then === "function", "must return a thenable");
    let rejected = null;
    await p.then(
      () => {
        throw new Error("expected rejection");
      },
      (err) => {
        rejected = err;
      }
    );
    assert.ok(rejected instanceof Error);
    assert.equal(rejected.message, LEASE1_MSG);
  }
  // Stubs must not invoke effects or mutate by publishing.
  assert.equal(effectHits, 0);
  assert.equal(fx.counts.publishDetection, 0);
  assert.equal(fx.counts.postNative, 0);
  assert.equal(fx.counts.downloadsDownload, 0);

  // Invalid material options fail before any callback/effect/state hook.
  const boom = () => {
    effectHits += 1;
    throw new Error("must not be invoked during validation");
  };
  const badCases = [
    { maxConcurrent: 0 },
    { maxConcurrent: 1.5 },
    { maxConcurrent: -1 },
    { segmentConcurrency: 0 },
    { retries: Number.POSITIVE_INFINITY },
    { retries: Number.NaN },
    { now: null },
    { now: "not-fn" },
    { randomToken: null },
    { postNative: null },
    { downloadsDownload: null },
    { createObjectURL: 1 },
    { revokeObjectURL: {} },
    { fetchArrayBuffer: [] },
    { assembleMedia: false },
    { isPopupSender: 0 },
    { getEffectiveDestinationDirectory: "x" },
    { publishDetection: "not-a-function" },
    { publishJobs: 12 },
    { persistHistory: {} },
    { reportDiagnostic: [] },
  ];
  for (const partial of badCases) {
    const bad = fx.options(
      Object.assign(
        {
          postNative: boom,
          downloadsDownload: boom,
          createObjectURL: boom,
          revokeObjectURL: boom,
          fetchArrayBuffer: boom,
          assembleMedia: boom,
          publishDetection: boom,
          publishJobs: boom,
          persistHistory: boom,
          reportDiagnostic: boom,
        },
        partial
      )
    );
    assert.throws(
      () => api.createBackgroundAdapters(bad),
      TypeError
    );
  }
  assert.equal(effectHits, 0, "validation must not invoke effects");
});

// ---------------------------------------------------------------------------
// BA02 — pending detection invisible until finalization
// ---------------------------------------------------------------------------

test("BA02 — pending detection is invisible until finalization", async (t) => {
  // Mutation caught: exposing pending records, correlating by mutable tab alone,
  // or reconciling the same finalizer ID twice.

  const api = loadAdapters();
  const fx = makeEffects();
  const ctrl = api.createBackgroundAdapters(fx.options());

  const mediaId = ctrl.captureNetwork({
    details: {
      url: "https://cdn.example/a.mp4",
      documentUrl: "https://florenfile.com/page-a",
      originUrl: "https://florenfile.com/page-a",
      tabId: 7,
      frameId: 0,
      documentId: "doc-pending-A",
      timeStamp: 1_000_000,
      responseHeaders: [],
    },
    hints: {
      topLevelUrlHint: "https://florenfile.com/page-a",
      frameOrigin: "https://florenfile.com",
    },
    transport: {
      mediaKind: "direct",
      requestHeaders: null,
    },
  });

  assert.equal(typeof mediaId, "string");
  assert.ok(isSafeOpaqueId(mediaId), "opaque media ID must be nonnumeric safe string");
  assert.equal(Number.isFinite(Number(mediaId)) && String(Number(mediaId)) === mediaId, false);

  // Pending: invisible to popup and publication.
  assert.deepEqual(ctrl.popupMedia(7), []);
  assert.equal(fx.counts.publishDetection, 0);

  // Wrong-document snapshot must not expose it.
  assert.equal(
    ctrl.acceptPageSnapshot({
      documentId: "doc-OTHER",
      tabId: 7,
      frameId: 0,
      pageUrl: "https://florenfile.com/page-a",
      topLevelPageUrl: "https://florenfile.com/page-a",
      documentNonce: "n-wrong",
      candidates: [{ kind: "visible-filename", value: "wrong.mp4" }],
      capturedAt: "2026-08-12T12:00:00.000Z",
    }),
    undefined
  );
  assert.deepEqual(ctrl.popupMedia(7), []);
  assert.equal(fx.counts.publishDetection, 0);

  // Matching snapshot finalizes once.
  ctrl.acceptPageSnapshot({
    documentId: "doc-pending-A",
    tabId: 7,
    frameId: 0,
    pageUrl: "https://florenfile.com/page-a",
    topLevelPageUrl: "https://florenfile.com/page-a",
    documentNonce: "n-match",
    candidates: [{ kind: "visible-filename", value: "pending-once.mp4" }],
    capturedAt: "2026-08-12T12:00:00.000Z",
  });

  assert.equal(fx.counts.publishDetection, 1);
  assert.equal(fx.publishDetections[0].id, mediaId);
  assert.equal(fx.publishDetections[0].proposedFilename, "pending-once.mp4");
  assert.equal(fx.publishDetections[0].kind, "direct");
  assert.equal(typeof fx.publishDetections[0].providerKey, "string");

  const rows = ctrl.popupMedia(7);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, mediaId);
  assert.equal(rows[0].proposedFilename, "pending-once.mp4");
  assert.equal(rows[0].kind, "direct");
  assert.deepEqual(rows[0].variants, []);

  // Repeated matching snapshot + tick must not duplicate.
  ctrl.acceptPageSnapshot({
    documentId: "doc-pending-A",
    tabId: 7,
    frameId: 0,
    pageUrl: "https://florenfile.com/page-a",
    topLevelPageUrl: "https://florenfile.com/page-a",
    documentNonce: "n-match-2",
    candidates: [{ kind: "visible-filename", value: "pending-once.mp4" }],
    capturedAt: "2026-08-12T12:00:01.000Z",
  });
  await ctrl.tick(1_000_750);
  assert.equal(fx.counts.publishDetection, 1);
  assert.equal(ctrl.popupMedia(7).length, 1);
  assert.equal(ctrl.popupMedia(7)[0].id, mediaId);

  await t.test(
    "DOM then network never reuses a finalizer ID and both publish",
    async () => {
      const api2 = loadAdapters();
      const fx2 = makeEffects();
      const c = api2.createBackgroundAdapters(fx2.options());

      const domId = c.captureDomMedia({
        mediaUrl: "https://cdn.example/dom-a.mp4",
        mediaOrigin: "https://cdn.example",
        contentDisposition: null,
        referrerUrl: "https://site-a.example/watch",
        frameOrigin: "https://site-a.example",
        ts: 1_000_000,
        snapshot: {
          documentId: "doc-dom-tabA",
          tabId: 11,
          frameId: 0,
          pageUrl: "https://site-a.example/watch",
          topLevelPageUrl: "https://site-a.example/watch",
          documentNonce: "n-dom-a",
          candidates: [{ kind: "visible-filename", value: "dom-item.mp4" }],
          capturedAt: "2026-08-12T12:00:00.000Z",
        },
        transport: { mediaKind: "direct", requestHeaders: null },
      });
      assert.ok(isSafeOpaqueId(domId));
      assert.equal(fx2.counts.publishDetection, 1);
      assert.equal(fx2.publishDetections[0].id, domId);
      assert.equal(fx2.publishDetections[0].proposedFilename, "dom-item.mp4");
      const rowsA = c.popupMedia(11);
      assert.equal(rowsA.length, 1);
      assert.equal(rowsA[0].id, domId);
      assert.equal(rowsA[0].proposedFilename, "dom-item.mp4");
      assert.equal(rowsA[0].kind, "direct");
      assert.deepEqual(c.popupMedia(22), []);

      const netId = c.captureNetwork({
        details: {
          url: "https://cdn.example/net-b.mp4",
          documentUrl: "https://site-b.example/page",
          originUrl: "https://site-b.example/page",
          tabId: 22,
          frameId: 0,
          documentId: "doc-net-tabB",
          timeStamp: 1_000_100,
          responseHeaders: [],
        },
        hints: {
          topLevelUrlHint: "https://site-b.example/page",
          frameOrigin: "https://site-b.example",
        },
        transport: { mediaKind: "hls", requestHeaders: null },
      });
      assert.ok(isSafeOpaqueId(netId));
      assert.notEqual(netId, domId);
      assert.deepEqual(c.popupMedia(22), []);
      assert.equal(fx2.counts.publishDetection, 1);

      c.acceptPageSnapshot({
        documentId: "doc-net-tabB",
        tabId: 22,
        frameId: 0,
        pageUrl: "https://site-b.example/page",
        topLevelPageUrl: "https://site-b.example/page",
        documentNonce: "n-net-b",
        candidates: [{ kind: "visible-filename", value: "net-item.mp4" }],
        capturedAt: "2026-08-12T12:00:01.000Z",
      });

      assert.equal(fx2.counts.publishDetection, 2);
      assert.equal(fx2.publishDetections[0].id, domId);
      assert.equal(fx2.publishDetections[1].id, netId);
      assert.equal(fx2.publishDetections[1].proposedFilename, "net-item.mp4");
      assert.equal(fx2.publishDetections[1].kind, "hls");

      const popA = c.popupMedia(11);
      const popB = c.popupMedia(22);
      assert.equal(popA.length, 1);
      assert.equal(popA[0].id, domId);
      assert.equal(popA[0].proposedFilename, "dom-item.mp4");
      assert.equal(popA[0].kind, "direct");
      assert.equal(popB.length, 1);
      assert.equal(popB[0].id, netId);
      assert.equal(popB[0].proposedFilename, "net-item.mp4");
      assert.equal(popB[0].kind, "hls");

      c.acceptPageSnapshot({
        documentId: "doc-net-tabB",
        tabId: 22,
        frameId: 0,
        pageUrl: "https://site-b.example/page",
        topLevelPageUrl: "https://site-b.example/page",
        documentNonce: "n-net-b-2",
        candidates: [{ kind: "visible-filename", value: "net-item.mp4" }],
        capturedAt: "2026-08-12T12:00:02.000Z",
      });
      await c.tick(1_000_900);
      assert.equal(fx2.counts.publishDetection, 2);
      assert.equal(c.popupMedia(11).length, 1);
      assert.equal(c.popupMedia(22).length, 1);
      assert.equal(c.popupMedia(11)[0].id, domId);
      assert.equal(c.popupMedia(22)[0].id, netId);
    }
  );

  await t.test(
    "network then DOM then network remains one-to-one with three publications",
    async () => {
      const api3 = loadAdapters();
      const fx3 = makeEffects();
      const c = api3.createBackgroundAdapters(fx3.options());

      const netA = c.captureNetwork({
        details: {
          url: "https://cdn.example/a.mp4",
          documentUrl: "https://a.example/p",
          originUrl: "https://a.example/p",
          tabId: 31,
          frameId: 0,
          documentId: "doc-seq-A",
          timeStamp: 1_000_000,
          responseHeaders: [],
        },
        hints: {
          topLevelUrlHint: "https://a.example/p",
          frameOrigin: "https://a.example",
        },
        transport: { mediaKind: "direct", requestHeaders: null },
      });
      assert.deepEqual(c.popupMedia(31), []);
      c.acceptPageSnapshot({
        documentId: "doc-seq-A",
        tabId: 31,
        frameId: 0,
        pageUrl: "https://a.example/p",
        topLevelPageUrl: "https://a.example/p",
        documentNonce: "n-a",
        candidates: [{ kind: "visible-filename", value: "seq-a.mp4" }],
        capturedAt: "2026-08-12T12:00:00.000Z",
      });
      assert.equal(fx3.counts.publishDetection, 1);
      assert.equal(fx3.publishDetections[0].id, netA);
      assert.equal(fx3.publishDetections[0].proposedFilename, "seq-a.mp4");

      const domB = c.captureDomMedia({
        mediaUrl: "https://cdn.example/b.mp4",
        mediaOrigin: "https://cdn.example",
        contentDisposition: null,
        referrerUrl: "https://b.example/p",
        frameOrigin: "https://b.example",
        ts: 1_000_050,
        snapshot: {
          documentId: "doc-seq-B",
          tabId: 32,
          frameId: 0,
          pageUrl: "https://b.example/p",
          topLevelPageUrl: "https://b.example/p",
          documentNonce: "n-b",
          candidates: [{ kind: "visible-filename", value: "seq-b.mp4" }],
          capturedAt: "2026-08-12T12:00:01.000Z",
        },
        transport: { mediaKind: "dash", requestHeaders: null },
      });
      assert.equal(fx3.counts.publishDetection, 2);
      assert.equal(fx3.publishDetections[1].id, domB);
      assert.equal(fx3.publishDetections[1].proposedFilename, "seq-b.mp4");
      assert.equal(fx3.publishDetections[1].kind, "dash");

      const netC = c.captureNetwork({
        details: {
          url: "https://cdn.example/c.mp4",
          documentUrl: "https://c.example/p",
          originUrl: "https://c.example/p",
          tabId: 33,
          frameId: 0,
          documentId: "doc-seq-C",
          timeStamp: 1_000_100,
          responseHeaders: [],
        },
        hints: {
          topLevelUrlHint: "https://c.example/p",
          frameOrigin: "https://c.example",
        },
        transport: { mediaKind: "hls", requestHeaders: null },
      });
      assert.ok(isSafeOpaqueId(netA));
      assert.ok(isSafeOpaqueId(domB));
      assert.ok(isSafeOpaqueId(netC));
      assert.equal(new Set([netA, domB, netC]).size, 3);
      assert.deepEqual(c.popupMedia(33), []);
      assert.equal(fx3.counts.publishDetection, 2);

      c.acceptPageSnapshot({
        documentId: "doc-seq-C",
        tabId: 33,
        frameId: 0,
        pageUrl: "https://c.example/p",
        topLevelPageUrl: "https://c.example/p",
        documentNonce: "n-c",
        candidates: [{ kind: "visible-filename", value: "seq-c.mp4" }],
        capturedAt: "2026-08-12T12:00:02.000Z",
      });

      assert.equal(fx3.counts.publishDetection, 3);
      assert.deepEqual(
        fx3.publishDetections.map((p) => p.id),
        [netA, domB, netC]
      );
      assert.deepEqual(
        fx3.publishDetections.map((p) => p.proposedFilename),
        ["seq-a.mp4", "seq-b.mp4", "seq-c.mp4"]
      );
      assert.equal(c.popupMedia(31).length, 1);
      assert.equal(c.popupMedia(31)[0].id, netA);
      assert.equal(c.popupMedia(31)[0].proposedFilename, "seq-a.mp4");
      assert.equal(c.popupMedia(32).length, 1);
      assert.equal(c.popupMedia(32)[0].id, domB);
      assert.equal(c.popupMedia(32)[0].proposedFilename, "seq-b.mp4");
      assert.equal(c.popupMedia(33).length, 1);
      assert.equal(c.popupMedia(33)[0].id, netC);
      assert.equal(c.popupMedia(33)[0].proposedFilename, "seq-c.mp4");
      assert.equal(c.popupMedia(33)[0].kind, "hls");

      c.acceptPageSnapshot({
        documentId: "doc-seq-C",
        tabId: 33,
        frameId: 0,
        pageUrl: "https://c.example/p",
        topLevelPageUrl: "https://c.example/p",
        documentNonce: "n-c-2",
        candidates: [{ kind: "visible-filename", value: "seq-c.mp4" }],
        capturedAt: "2026-08-12T12:00:03.000Z",
      });
      await c.tick(1_001_000);
      assert.equal(fx3.counts.publishDetection, 3);
      assert.equal(c.popupMedia(31).length, 1);
      assert.equal(c.popupMedia(32).length, 1);
      assert.equal(c.popupMedia(33).length, 1);
    }
  );
});

// ---------------------------------------------------------------------------
// BA03 — finalized source context and proposed filename survive navigation
// ---------------------------------------------------------------------------

test("BA03 — finalized source context and proposed filename survive later snapshots/navigation", async () => {
  // Mutation caught: rereading mutable tab context, replacing source context,
  // or rerunning the ranker after finalization.

  const api = loadAdapters();
  const fx = makeEffects();
  const ctrl = api.createBackgroundAdapters(fx.options());

  const mediaId = ctrl.captureNetwork(florenNetworkInput());
  assert.ok(isSafeOpaqueId(mediaId));

  // Finalize with Florenfile fixture evidence.
  ctrl.acceptPageSnapshot(florenSnapshot());

  assert.equal(fx.counts.publishDetection, 1);
  const published = fx.publishDetections[0];
  assert.equal(published.id, mediaId);
  assert.equal(
    published.proposedFilename,
    FLOREN_FIXTURE.expectedProposedFilename
  );
  assert.equal(published.proposedFilename, "11238-makemebi.net.mp4");
  assert.equal(published.kind, "direct");
  assert.equal(published.providerKey, "florenfile.com");
  assertDeepFrozen(published, "publishDetection[0]");

  // Freeze reference of first projection fields.
  const firstFilename = published.proposedFilename;
  const firstProvider = published.providerKey;
  const firstKind = published.kind;

  // Later same-tab navigation / snapshot with different site, title, headings, URL, branding.
  ctrl.acceptPageSnapshot({
    documentId: "doc-navigated-later",
    tabId: 42,
    frameId: 0,
    pageUrl: "https://branding-example.invalid/home?utm=GENERIC_BRANDING",
    topLevelPageUrl: "https://branding-example.invalid/home?utm=GENERIC_BRANDING",
    documentNonce: "nonce-nav-2",
    candidates: [
      { kind: "document-title", value: "Generic Branding Cloud Storage" },
      { kind: "og-title", value: "Generic Branding Cloud Storage" },
      { kind: "heading", value: "Welcome to Branding" },
      { kind: "visible-filename", value: "welcome-branding.mp4" },
    ],
    capturedAt: "2026-08-12T12:05:00.000Z",
  });
  await ctrl.tick(1_001_000);

  // No second publication / ranking.
  assert.equal(fx.counts.publishDetection, 1);
  assert.equal(fx.publishDetections[0], published);
  assert.equal(published.proposedFilename, firstFilename);
  assert.equal(published.providerKey, firstProvider);
  assert.equal(published.kind, firstKind);
  assert.equal(published.proposedFilename, "11238-makemebi.net.mp4");
  assert.equal(published.providerKey, "florenfile.com");

  const rows = ctrl.popupMedia(42);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, mediaId);
  assert.equal(rows[0].proposedFilename, "11238-makemebi.net.mp4");
  assert.equal(rows[0].kind, "direct");
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    "id",
    "kind",
    "proposedFilename",
    "variants",
  ].sort());
});

// ---------------------------------------------------------------------------
// BA04 — popup media exposes opaque IDs and no raw secrets
// ---------------------------------------------------------------------------

test("BA04 — popup media exposes opaque IDs and no raw URL/context/header fields", async (t) => {
  // Mutation caught: spreading the finalizer/private source record, leaking
  // numeric detection authority, or serializing ephemeral request material.

  const api = loadAdapters();
  const fx = makeEffects();
  // Force randomToken to always return the same value so uniqueness must
  // come from adapter-owned suffix minting.
  const ctrl = api.createBackgroundAdapters(
    fx.options({
      randomToken() {
        fx.counts.randomToken += 1;
        return "same-token-every-time";
      },
    })
  );

  const signedUrl =
    "https://SECRET_MEDIA_ORIGIN_HOST.example-cdn.invalid/v.mp4?token=SECRET_SIGNED_QUERY_XYZ&exp=1";
  const pageUrl =
    "https://site.example/SECRET_PAGE_PATH/watch?token=SECRET_SIGNED_QUERY_XYZ";
  const referrer =
    "https://site.example/SECRET_REFERER_PATH/ref?auth=SECRET_AUTH_BEARER_TOKEN";

  // Direct/network media with secrets.
  const netId = ctrl.captureNetwork({
    details: {
      url: signedUrl,
      documentUrl: pageUrl,
      originUrl: referrer,
      tabId: 99,
      frameId: 0,
      documentId: "doc-secret-net",
      timeStamp: 1_000_000,
      responseHeaders: [
        { name: "Content-Disposition", value: 'attachment; filename="safe-net.mp4"' },
      ],
    },
    hints: {
      topLevelUrlHint: pageUrl,
      frameOrigin: "https://site.example",
    },
    transport: {
      mediaKind: "direct",
      requestHeaders: {
        Cookie: "session=SECRET_COOKIE_ABC",
        Authorization: "Bearer SECRET_AUTH_BEARER_TOKEN",
        "X-Custom": "SECRET_SIGNED_QUERY_XYZ",
      },
      referer: referrer,
      userAgent: "TestAgent/1.0",
    },
  });

  ctrl.acceptPageSnapshot({
    documentId: "doc-secret-net",
    tabId: 99,
    frameId: 0,
    pageUrl: pageUrl,
    topLevelPageUrl: pageUrl,
    documentNonce: "n-secret-net",
    candidates: [
      { kind: "document-title", value: "Watch Page" },
      { kind: "visible-filename", value: "safe-net.mp4" },
    ],
    capturedAt: "2026-08-12T12:00:00.000Z",
  });

  // DOM media with secrets.
  const domId = ctrl.captureDomMedia({
    mediaUrl: signedUrl + "&dom=1",
    mediaOrigin: "https://SECRET_MEDIA_ORIGIN_HOST.example-cdn.invalid",
    contentDisposition: null,
    referrerUrl: referrer,
    frameOrigin: "https://site.example",
    ts: 1_000_100,
    snapshot: {
      documentId: "doc-secret-dom",
      tabId: 99,
      frameId: 0,
      pageUrl: pageUrl,
      topLevelPageUrl: pageUrl,
      documentNonce: "n-secret-dom",
      candidates: [
        { kind: "visible-filename", value: "safe-dom.mp4" },
      ],
      capturedAt: "2026-08-12T12:00:01.000Z",
    },
    transport: {
      mediaKind: "direct",
      requestHeaders: {
        Cookie: "session=SECRET_COOKIE_ABC",
        Authorization: "Bearer SECRET_AUTH_BEARER_TOKEN",
      },
    },
  });

  assert.ok(isSafeOpaqueId(netId));
  assert.ok(isSafeOpaqueId(domId));
  assert.notEqual(netId, domId, "IDs must be unique even when randomToken repeats");
  assert.equal(/^\d+$/.test(netId), false);
  assert.equal(/^\d+$/.test(domId), false);

  // Reset effect counters after detection path so popup-only effects are measured.
  const postNativeBefore = fx.counts.postNative;
  const downloadsBefore = fx.counts.downloadsDownload;
  const fetchBefore = fx.counts.fetchArrayBuffer;
  const assembleBefore = fx.counts.assembleMedia;
  const createUrlBefore = fx.counts.createObjectURL;
  const revokeBefore = fx.counts.revokeObjectURL;
  const publishDetBefore = fx.counts.publishDetection;
  const publishJobsBefore = fx.counts.publishJobs;
  const persistBefore = fx.counts.persistHistory;

  const rows1 = ctrl.popupMedia(99);
  const rows2 = ctrl.popupMedia(99);

  assert.equal(rows1.length, 2);
  assert.notEqual(rows1, rows2, "popupMedia must return a fresh array");
  assert.notEqual(rows1[0], rows2[0], "popupMedia rows must be fresh copies");
  assertDeepFrozen(rows1, "popupMedia rows");
  assertDeepFrozen(rows2, "popupMedia rows copy");

  for (const row of rows1) {
    assert.deepEqual(Object.keys(row).sort(), [
      "id",
      "kind",
      "proposedFilename",
      "variants",
    ].sort());
    assert.ok(isSafeOpaqueId(row.id));
    assert.equal(typeof row.proposedFilename, "string");
    assert.equal(row.kind, "direct");
    assert.ok(Array.isArray(row.variants));
    assert.equal(row.variants.length, 0);
    assert.ok(Object.isFrozen(row.variants));
  }

  const ids = rows1.map((r) => r.id).sort();
  assert.deepEqual(ids, [domId, netId].sort());

  // Popup must not invoke transport/Firefox/fetch/assembly/storage/publication effects.
  assert.equal(fx.counts.postNative, postNativeBefore);
  assert.equal(fx.counts.downloadsDownload, downloadsBefore);
  assert.equal(fx.counts.fetchArrayBuffer, fetchBefore);
  assert.equal(fx.counts.assembleMedia, assembleBefore);
  assert.equal(fx.counts.createObjectURL, createUrlBefore);
  assert.equal(fx.counts.revokeObjectURL, revokeBefore);
  assert.equal(fx.counts.publishDetection, publishDetBefore);
  assert.equal(fx.counts.publishJobs, publishJobsBefore);
  assert.equal(fx.counts.persistHistory, persistBefore);

  // Two publications (net + dom), each with exact four safe keys and no secrets.
  assert.equal(fx.counts.publishDetection, 2);
  for (const pub of fx.publishDetections) {
    assert.deepEqual(Object.keys(pub).sort(), [
      "id",
      "kind",
      "proposedFilename",
      "providerKey",
    ].sort());
    assertDeepFrozen(pub, "publishDetection");
    assertNoSentinels(pub, "publishDetection");
  }

  assertNoSentinels(rows1, "popupMedia");
  assertNoSentinels(rows2, "popupMedia copy");
  assertNoSentinels(fx.publishDetections, "all publishDetection captures");
  assertNoSentinels(fx.diagnostics, "diagnostics");

  // String inspection of return values + callback captures.
  const inspection = [
    JSON.stringify(rows1),
    JSON.stringify(rows2),
    JSON.stringify(fx.publishDetections),
    JSON.stringify(fx.diagnostics),
    String(netId),
    String(domId),
  ].join("\n");
  for (const s of SECRET_SENTINELS) {
    assert.equal(inspection.includes(s), false, "inspection must not contain " + s);
  }

  await t.test(
    "pending records do not retain raw transport or header objects",
    async () => {
      const src = productionSource();
      const setSites = src.match(/pendingByMediaId\.set\s*\(/g) || [];
      assert.equal(
        setSites.length,
        2,
        "exactly two pendingByMediaId.set sites (network + DOM)"
      );
      const blocks = extractPendingSetBlocks(src);
      assert.equal(blocks.length, 2);
      const forbiddenPending = [
        /\btransport\b/,
        /\brequestHeaders\b/,
        /\burl\b/i,
        /\breferrer\b/i,
        /\breferer\b/i,
        /\buserAgent\b/,
        /\bmirrors\b/,
        /\bvariants\b/,
      ];
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        // Enumerable pending metadata is only detectionId/ephemeral/mediaKind/tabId.
        assert.match(block, /\bdetectionId\b/);
        assert.match(block, /\bephemeral\b/);
        assert.match(block, /\bmediaKind\b/);
        assert.match(block, /\btabId\b/);
        for (const re of forbiddenPending) {
          assert.equal(
            re.test(block),
            false,
            "pending block " + i + " must not contain " + re
          );
        }
      }
      // Fail closed on the known old-production retention shape.
      assert.equal(
        /transport\s*:\s*transport/.test(src),
        false,
        "must not assign transport: transport into pending"
      );

      // Primary media URL / request headers have no second long-lived adapter owner
      // outside createEphemeral (no adapter-level header/url maps or pending URL fields).
      assert.equal(
        /new Map\(\)\s*;\s*\/\/.*headers|headersByMediaId|urlByMediaId|pendingUrls/.test(
          src
        ),
        false
      );
      const createEph = (src.match(/Privacy\.createEphemeral\s*\(/g) || []).length;
      assert.equal(createEph, 2, "ephemeral created once per capture path");

      const apiP = loadAdapters();
      const fxP = makeEffects();
      const c = apiP.createBackgroundAdapters(fxP.options());
      const secretHeaders = {
        Cookie: "session=SECRET_COOKIE_ABC",
        Authorization: "Bearer SECRET_AUTH_BEARER_TOKEN",
        "X-Custom": "SECRET_SIGNED_QUERY_XYZ",
      };
      const transportObj = {
        mediaKind: "direct",
        requestHeaders: secretHeaders,
        referer: "https://site.example/SECRET_REFERER_PATH",
        userAgent: "Agent SECRET_AUTH_BEARER_TOKEN",
        mirrors: ["https://mirror/SECRET_SIGNED_QUERY_XYZ"],
        variants: [{ id: "v1", url: "https://v/SECRET_PAGE_PATH" }],
      };
      const mediaId = c.captureNetwork({
        details: {
          url:
            "https://SECRET_MEDIA_ORIGIN_HOST.example/v.mp4?token=SECRET_SIGNED_QUERY_XYZ",
          documentUrl:
            "https://site.example/SECRET_PAGE_PATH/watch",
          originUrl: "https://site.example/SECRET_REFERER_PATH",
          tabId: 77,
          frameId: 0,
          documentId: "doc-pending-privacy",
          timeStamp: 1_000_000,
          responseHeaders: [
            { name: "Content-Type", value: "video/mp4" },
          ],
        },
        hints: {
          topLevelUrlHint: "https://site.example/SECRET_PAGE_PATH/watch",
          frameOrigin: "https://site.example",
        },
        transport: transportObj,
      });
      // Mutate/revoke caller-owned raw objects after capture.
      secretHeaders.Cookie = "MUTATED_AFTER_CAPTURE";
      secretHeaders.Authorization = "MUTATED_AUTH";
      transportObj.requestHeaders = null;
      transportObj.referer = "mutated";
      transportObj.mirrors = [];
      transportObj.variants = [];

      assert.deepEqual(c.popupMedia(77), []);
      assert.equal(fxP.counts.publishDetection, 0);

      c.acceptPageSnapshot({
        documentId: "doc-pending-privacy",
        tabId: 77,
        frameId: 0,
        pageUrl: "https://site.example/SECRET_PAGE_PATH/watch",
        topLevelPageUrl: "https://site.example/SECRET_PAGE_PATH/watch",
        documentNonce: "n-priv",
        candidates: [{ kind: "visible-filename", value: "priv-safe.mp4" }],
        capturedAt: "2026-08-12T12:00:00.000Z",
      });
      assert.equal(fxP.counts.publishDetection, 1);
      assert.equal(fxP.publishDetections[0].id, mediaId);
      assert.equal(fxP.publishDetections[0].proposedFilename, "priv-safe.mp4");
      const pop = c.popupMedia(77);
      assert.equal(pop.length, 1);
      assert.equal(pop[0].id, mediaId);
      assertDeepFrozen(pop, "privacy popup");
      assertDeepFrozen(fxP.publishDetections[0], "privacy publish");
      assertNoSentinels(pop, "privacy popup");
      assertNoSentinels(fxP.publishDetections, "privacy publish");
      assertNoSentinels(fxP.diagnostics, "privacy diagnostics");
      const blob = [
        JSON.stringify(pop),
        JSON.stringify(fxP.publishDetections),
        JSON.stringify(fxP.diagnostics),
        String(mediaId),
      ].join("\n");
      for (const s of SECRET_SENTINELS) {
        assert.equal(blob.includes(s), false, "projection must not contain " + s);
      }
    }
  );

  await t.test(
    "ProviderRegistry is constructed once but never observed in Lease 1",
    async () => {
      const src = productionSource();
      const creates = src.match(/createProviderRegistry\s*\(/g) || [];
      assert.equal(creates.length, 1, "createProviderRegistry exactly once");
      assert.equal(
        (src.match(/\.observe\s*\(/g) || []).length,
        0,
        "Lease 1 must not call .observe("
      );
      assert.equal(
        (src.match(/\.lookup\s*\(/g) || []).length,
        0,
        "Lease 1 must not call .lookup("
      );
      assert.equal(
        (src.match(/providerRegistry\.clear\s*\(/g) || []).length,
        0,
        "Lease 1 must not call providerRegistry.clear("
      );
      assert.equal(
        (src.match(/providerRegistry\.snapshot\s*\(/g) || []).length,
        0,
        "Lease 1 must not call providerRegistry.snapshot("
      );
    }
  );

  await t.test(
    "hostile input accessors never execute or leak across dependency boundaries",
    async () => {
      const apiH = loadAdapters();
      const fxH = makeEffects();
      const c = apiH.createBackgroundAdapters(fxH.options());

      const hits = Object.create(null);
      function track(name) {
        hits[name] = 0;
        return function hostileGetter() {
          hits[name] += 1;
          throw new Error("HOSTILE_SECRET_" + name + "_TOKEN_XYZ");
        };
      }

      // --- captureNetwork: hostile details/hints/headers ---
      const details = {};
      Object.defineProperty(details, "url", {
        enumerable: true,
        configurable: true,
        get: track("details.url"),
      });
      Object.defineProperty(details, "documentUrl", {
        enumerable: true,
        configurable: true,
        value: "https://ok.example/page",
        writable: true,
      });
      Object.defineProperty(details, "originUrl", {
        enumerable: true,
        configurable: true,
        value: "https://ok.example/page",
        writable: true,
      });
      Object.defineProperty(details, "tabId", {
        enumerable: true,
        configurable: true,
        value: 50,
        writable: true,
      });
      Object.defineProperty(details, "frameId", {
        enumerable: true,
        configurable: true,
        value: 0,
        writable: true,
      });
      Object.defineProperty(details, "documentId", {
        enumerable: true,
        configurable: true,
        value: "doc-hostile-net",
        writable: true,
      });
      Object.defineProperty(details, "timeStamp", {
        enumerable: true,
        configurable: true,
        value: 1_000_000,
        writable: true,
      });
      const respHeaders = [{}];
      Object.defineProperty(respHeaders[0], "name", {
        enumerable: true,
        configurable: true,
        get: track("responseHeaders.name"),
      });
      Object.defineProperty(respHeaders[0], "value", {
        enumerable: true,
        configurable: true,
        get: track("responseHeaders.value"),
      });
      Object.defineProperty(details, "responseHeaders", {
        enumerable: true,
        configurable: true,
        value: respHeaders,
        writable: true,
      });

      const hints = {};
      Object.defineProperty(hints, "topLevelUrlHint", {
        enumerable: true,
        configurable: true,
        get: track("hints.topLevelUrlHint"),
      });
      Object.defineProperty(hints, "frameOrigin", {
        enumerable: true,
        configurable: true,
        value: "https://ok.example",
        writable: true,
      });

      const hostileToString = {
        toString() {
          hits["toString"] = (hits["toString"] || 0) + 1;
          return "https://HOSTILE_SECRET_toString.example/x";
        },
      };
      hits["toString"] = 0;

      let netThrew = null;
      try {
        c.captureNetwork({
          details: details,
          hints: hints,
          transport: { mediaKind: "direct", requestHeaders: null },
        });
      } catch (err) {
        netThrew = err;
      }
      assert.ok(netThrew instanceof TypeError, "hostile network must TypeError");
      assert.equal(
        String(netThrew.message).includes("HOSTILE_SECRET"),
        false,
        "network error must not leak hostile text: " + netThrew.message
      );
      assert.equal(
        String(netThrew.stack || "").includes("HOSTILE_SECRET"),
        false
      );
      for (const k of Object.keys(hits)) {
        assert.equal(hits[k], 0, "getter " + k + " must not execute on network path");
      }
      assert.equal(fxH.counts.publishDetection, 0);
      assert.equal(fxH.counts.randomToken, 0, "must not mint opaque ID on hostile network");
      assert.deepEqual(c.popupMedia(50), []);

      // Proxy reflection trap: may consult classification, but exception text is generic.
      const proxyDetails = new Proxy(
        {
          url: "https://ok.example/v.mp4",
          documentUrl: "https://ok.example/p",
          originUrl: "https://ok.example/p",
          tabId: 50,
          frameId: 0,
          documentId: "doc-proxy",
          timeStamp: 1_000_000,
          responseHeaders: [],
        },
        {
          getOwnPropertyDescriptor() {
            throw new Error("HOSTILE_SECRET_PROXY_GOPD_DETAILS");
          },
          get() {
            throw new Error("HOSTILE_SECRET_PROXY_GET_DETAILS");
          },
        }
      );
      assert.throws(
        () =>
          c.captureNetwork({
            details: proxyDetails,
            hints: { topLevelUrlHint: "https://ok.example/p", frameOrigin: "https://ok.example" },
            transport: { mediaKind: "direct", requestHeaders: null },
          }),
        (err) => {
          assert.ok(err instanceof TypeError);
          assert.equal(String(err.message).includes("HOSTILE_SECRET"), false);
          assert.equal(String(err.stack || "").includes("HOSTILE_SECRET"), false);
          return true;
        }
      );
      assert.equal(fxH.counts.randomToken, 0);
      assert.equal(fxH.counts.publishDetection, 0);

      // --- acceptPageSnapshot: hostile snapshot fields ---
      const snapHits = Object.create(null);
      function trackSnap(name) {
        snapHits[name] = 0;
        return function () {
          snapHits[name] += 1;
          throw new Error("HOSTILE_SECRET_SNAP_" + name);
        };
      }
      const hostileSnap = {};
      Object.defineProperty(hostileSnap, "documentId", {
        enumerable: true,
        configurable: true,
        get: trackSnap("documentId"),
      });
      Object.defineProperty(hostileSnap, "tabId", {
        enumerable: true,
        configurable: true,
        value: 50,
        writable: true,
      });
      Object.defineProperty(hostileSnap, "frameId", {
        enumerable: true,
        configurable: true,
        value: 0,
        writable: true,
      });
      Object.defineProperty(hostileSnap, "pageUrl", {
        enumerable: true,
        configurable: true,
        value: "https://ok.example/p",
        writable: true,
      });
      Object.defineProperty(hostileSnap, "topLevelPageUrl", {
        enumerable: true,
        configurable: true,
        value: "https://ok.example/p",
        writable: true,
      });
      Object.defineProperty(hostileSnap, "documentNonce", {
        enumerable: true,
        configurable: true,
        value: "n",
        writable: true,
      });
      Object.defineProperty(hostileSnap, "capturedAt", {
        enumerable: true,
        configurable: true,
        value: "2026-08-12T12:00:00.000Z",
        writable: true,
      });
      const hostileCand = {};
      Object.defineProperty(hostileCand, "kind", {
        enumerable: true,
        configurable: true,
        get: trackSnap("candidates.kind"),
      });
      Object.defineProperty(hostileCand, "value", {
        enumerable: true,
        configurable: true,
        get: trackSnap("candidates.value"),
      });
      Object.defineProperty(hostileSnap, "candidates", {
        enumerable: true,
        configurable: true,
        value: [hostileCand],
        writable: true,
      });

      let snapThrew = null;
      try {
        c.acceptPageSnapshot(hostileSnap);
      } catch (err) {
        snapThrew = err;
      }
      // Must either accept descriptor-safe own-data snapshot or reject generically.
      if (snapThrew) {
        assert.ok(snapThrew instanceof TypeError);
        assert.equal(String(snapThrew.message).includes("HOSTILE_SECRET"), false);
        assert.equal(String(snapThrew.stack || "").includes("HOSTILE_SECRET"), false);
      }
      for (const k of Object.keys(snapHits)) {
        assert.equal(snapHits[k], 0, "snapshot getter " + k + " must not run");
      }
      assert.equal(fxH.counts.publishDetection, 0);

      // --- captureDomMedia: hostile snapshot + DOM scalars ---
      const domHits = Object.create(null);
      function trackDom(name) {
        domHits[name] = 0;
        return function () {
          domHits[name] += 1;
          throw new Error("HOSTILE_SECRET_DOM_" + name);
        };
      }
      const domSnap = {};
      Object.defineProperty(domSnap, "documentId", {
        enumerable: true,
        configurable: true,
        get: trackDom("snapshot.documentId"),
      });
      Object.defineProperty(domSnap, "tabId", {
        enumerable: true,
        configurable: true,
        value: 51,
        writable: true,
      });
      Object.defineProperty(domSnap, "frameId", {
        enumerable: true,
        configurable: true,
        value: 0,
        writable: true,
      });
      Object.defineProperty(domSnap, "pageUrl", {
        enumerable: true,
        configurable: true,
        value: "https://ok.example/dom",
        writable: true,
      });
      Object.defineProperty(domSnap, "topLevelPageUrl", {
        enumerable: true,
        configurable: true,
        value: "https://ok.example/dom",
        writable: true,
      });
      Object.defineProperty(domSnap, "documentNonce", {
        enumerable: true,
        configurable: true,
        value: "nd",
        writable: true,
      });
      Object.defineProperty(domSnap, "capturedAt", {
        enumerable: true,
        configurable: true,
        value: "2026-08-12T12:00:00.000Z",
        writable: true,
      });
      Object.defineProperty(domSnap, "candidates", {
        enumerable: true,
        configurable: true,
        value: [{ kind: "visible-filename", value: "x.mp4" }],
        writable: true,
      });

      let domThrew = null;
      try {
        c.captureDomMedia({
          mediaUrl: "https://cdn.example/dom.mp4",
          mediaOrigin: "https://cdn.example",
          contentDisposition: null,
          referrerUrl: "https://ok.example/dom",
          frameOrigin: "https://ok.example",
          ts: 1_000_000,
          snapshot: domSnap,
          transport: { mediaKind: "direct", requestHeaders: null },
        });
      } catch (err) {
        domThrew = err;
      }
      assert.ok(domThrew instanceof TypeError);
      assert.equal(String(domThrew.message).includes("HOSTILE_SECRET"), false);
      for (const k of Object.keys(domHits)) {
        assert.equal(domHits[k], 0, "dom getter " + k + " must not run");
      }
      assert.equal(fxH.counts.publishDetection, 0);
      assert.equal(
        fxH.counts.randomToken,
        0,
        "hostile DOM must fail before minting opaque ID"
      );
      assert.deepEqual(c.popupMedia(51), []);

      // Hostile toString on a scalar field must not be coerced.
      assert.throws(
        () =>
          c.captureDomMedia({
            mediaUrl: hostileToString,
            mediaOrigin: "https://cdn.example",
            contentDisposition: null,
            referrerUrl: "https://ok.example/dom",
            frameOrigin: "https://ok.example",
            ts: 1_000_000,
            snapshot: {
              documentId: "doc-tostring",
              tabId: 52,
              frameId: 0,
              pageUrl: "https://ok.example/dom",
              topLevelPageUrl: "https://ok.example/dom",
              documentNonce: "nt",
              candidates: [{ kind: "visible-filename", value: "t.mp4" }],
              capturedAt: "2026-08-12T12:00:00.000Z",
            },
            transport: { mediaKind: "direct", requestHeaders: null },
          }),
        TypeError
      );
      assert.equal(hits["toString"], 0, "hostile toString must not run");
      assert.equal(fxH.counts.randomToken, 0);
      assert.equal(fxH.counts.publishDetection, 0);

      // Ordinary own-data control: same fields still flow; Floren proposal correct.
      const florenId = c.captureNetwork(florenNetworkInput());
      c.acceptPageSnapshot(florenSnapshot());
      assert.equal(fxH.counts.publishDetection, 1);
      assert.equal(fxH.publishDetections[0].id, florenId);
      assert.equal(
        fxH.publishDetections[0].proposedFilename,
        "11238-makemebi.net.mp4"
      );
      assert.equal(fxH.publishDetections[0].providerKey, "florenfile.com");
      assert.equal(c.popupMedia(42).length, 1);
      assert.equal(c.popupMedia(42)[0].id, florenId);

      // Next valid capture after hostile failures behaves as first capture for order.
      // (Floren above is the first successful capture; second succeeds with distinct ID.)
      const secondId = c.captureDomMedia({
        mediaUrl: "https://cdn.example/after-hostile.mp4",
        mediaOrigin: "https://cdn.example",
        contentDisposition: null,
        referrerUrl: "https://ok.example/after",
        frameOrigin: "https://ok.example",
        ts: 1_000_200,
        snapshot: {
          documentId: "doc-after-hostile",
          tabId: 60,
          frameId: 0,
          pageUrl: "https://ok.example/after",
          topLevelPageUrl: "https://ok.example/after",
          documentNonce: "na",
          candidates: [{ kind: "visible-filename", value: "after.mp4" }],
          capturedAt: "2026-08-12T12:00:02.000Z",
        },
        transport: { mediaKind: "direct", requestHeaders: null },
      });
      assert.ok(isSafeOpaqueId(secondId));
      assert.notEqual(secondId, florenId);
      assert.equal(fxH.counts.publishDetection, 2);
      assert.equal(fxH.publishDetections[1].id, secondId);
      assert.equal(fxH.publishDetections[1].proposedFilename, "after.mp4");
      assert.equal(c.popupMedia(60).length, 1);
      assertNoSentinels(fxH.publishDetections, "hostile-path publications");
      assertNoSentinels(fxH.diagnostics, "hostile-path diagnostics");
    }
  );

  await t.test(
    "publication reentrancy and throw remains exactly once with safe diagnostics",
    async () => {
      const apiR = loadAdapters();
      const fxR = makeEffects();
      let publishCalls = 0;
      let diagCalls = 0;
      const SECRET_PUB = "SECRET_PUBLISH_THROW_TOKEN";
      const SECRET_DIAG = "SECRET_DIAG_THROW_TOKEN";
      let ctrlR;
      ctrlR = apiR.createBackgroundAdapters(
        fxR.options({
          publishDetection(safe) {
            publishCalls += 1;
            fxR.counts.publishDetection += 1;
            fxR.publishDetections.push(safe);
            // Re-enter popup projection mid-publish, then throw secret-bearing error.
            const rows = ctrlR.popupMedia(88);
            assert.equal(rows.length, 1);
            assert.equal(rows[0].id, safe.id);
            throw new Error(SECRET_PUB + " boom");
          },
          reportDiagnostic(safeDiagnostic) {
            diagCalls += 1;
            fxR.counts.reportDiagnostic += 1;
            fxR.diagnostics.push(safeDiagnostic);
            throw new Error(SECRET_DIAG + " diag");
          },
        })
      );

      const mediaId = ctrlR.captureNetwork({
        details: {
          url: "https://cdn.example/reenter.mp4",
          documentUrl: "https://site.example/re",
          originUrl: "https://site.example/re",
          tabId: 88,
          frameId: 0,
          documentId: "doc-reenter",
          timeStamp: 1_000_000,
          responseHeaders: [],
        },
        hints: {
          topLevelUrlHint: "https://site.example/re",
          frameOrigin: "https://site.example",
        },
        transport: { mediaKind: "direct", requestHeaders: null },
      });
      // Must not escape publish/diagnostic exceptions to the caller.
      assert.doesNotThrow(() => {
        ctrlR.acceptPageSnapshot({
          documentId: "doc-reenter",
          tabId: 88,
          frameId: 0,
          pageUrl: "https://site.example/re",
          topLevelPageUrl: "https://site.example/re",
          documentNonce: "nr",
          candidates: [{ kind: "visible-filename", value: "reenter.mp4" }],
          capturedAt: "2026-08-12T12:00:00.000Z",
        });
      });

      assert.equal(publishCalls, 1, "exactly one publication attempt");
      assert.equal(fxR.publishDetections.length, 1);
      assert.equal(fxR.publishDetections[0].id, mediaId);
      assert.equal(fxR.publishDetections[0].proposedFilename, "reenter.mp4");

      const committed = ctrlR.popupMedia(88);
      assert.equal(committed.length, 1);
      assert.equal(committed[0].id, mediaId);
      assert.equal(committed[0].proposedFilename, "reenter.mp4");

      // Later snapshot/tick must not duplicate.
      ctrlR.acceptPageSnapshot({
        documentId: "doc-reenter",
        tabId: 88,
        frameId: 0,
        pageUrl: "https://site.example/re",
        topLevelPageUrl: "https://site.example/re",
        documentNonce: "nr-2",
        candidates: [{ kind: "visible-filename", value: "reenter.mp4" }],
        capturedAt: "2026-08-12T12:00:01.000Z",
      });
      await ctrlR.tick(1_000_900);
      assert.equal(publishCalls, 1);
      assert.equal(ctrlR.popupMedia(88).length, 1);

      // reportDiagnostic receives exact deeply frozen safe own-data projection.
      assert.equal(diagCalls, 1);
      assert.equal(fxR.diagnostics.length, 1);
      const diag = fxR.diagnostics[0];
      assert.deepEqual(Object.keys(diag).sort(), ["code", "id", "scope"].sort());
      assert.equal(diag.code, "publish-detection-failed");
      assert.equal(diag.scope, "background-adapters");
      assert.equal(diag.id, mediaId);
      assertDeepFrozen(diag, "reportDiagnostic payload");
      assert.equal(JSON.stringify(diag).includes(SECRET_PUB), false);
      assert.equal(JSON.stringify(diag).includes(SECRET_DIAG), false);
      assertNoSentinels(diag, "diagnostic");
      assertNoSentinels(committed, "reenter popup");
      assertNoSentinels(fxR.publishDetections, "reenter publish");
    }
  );

  // -------------------------------------------------------------------------
  // Repair subtests A–E — failure atomicity, private transport, generic errors
  // -------------------------------------------------------------------------

  await t.test(
    "BA04 network invalid/throwing capture is failure-atomic",
    async () => {
      function freshNetHarness(optionOverrides) {
        const inst = loadInstrumentedClassic();
        const fx = makeEffects();
        const ctrl = inst.api.createBackgroundAdapters(
          fx.options(optionOverrides || {})
        );
        return { inst, fx, ctrl };
      }

      async function assertNetworkRejectedAtomic(runCapture, opts) {
        const { inst, fx, ctrl } = freshNetHarness(opts && opts.optionOverrides);
        const finalizer = inst.sessionFinalizer();
        let threw = null;
        try {
          runCapture(ctrl, fx);
        } catch (err) {
          threw = err;
        }
        assert.ok(threw, "capture must reject");
        if (opts && opts.expectTokenIdentity) {
          assert.equal(threw, opts.expectTokenIdentity);
        } else {
          assertGenericTypeError(threw);
        }
        if (opts && opts.hits) {
          for (const k of Object.keys(opts.hits)) {
            assert.equal(opts.hits[k], 0, "hostile " + k + " must not run");
          }
        }
        assertNoMaterialEffects(fx);
        if (!(opts && opts.skipTokenCount)) {
          assert.equal(
            fx.counts.randomToken,
            opts && opts.tokenCalls != null ? opts.tokenCalls : 0
          );
        }
        assertNoFinalizerResidue(finalizer, ctrl, 42);

        // Matching snapshot / tick must not surface orphan finalizer work.
        ctrl.acceptPageSnapshot(florenSnapshot());
        await ctrl.tick(1_000_750);
        assert.equal(finalizer.listFinalized().length, 0);
        assert.equal(fx.counts.publishDetection, 0);
        assert.equal(ctrl.popupMedia(42).length, 0);

        // Restore one-shot failure (if any), then first valid capture is :1 / det 1.
        // Note: the orphan-proof snapshot above is a matching floren snapshot, so a
        // later valid floren capture may finalize/publish immediately on reconcile.
        if (opts && opts.restore) opts.restore(fx);
        const okId = ctrl.captureNetwork(validNetworkCapture());
        const pendings = inst.pendingRecords();
        assert.ok(pendings.length >= 1);
        const lastPending = pendings[pendings.length - 1];
        assertFirstObservableIds(okId, lastPending);
        assert.equal(lastPending.detectionId, 1);
        if (finalizer.listFinalized().length === 0) {
          assert.equal(fx.counts.publishDetection, 0);
          ctrl.acceptPageSnapshot(florenSnapshot());
        }
        // Exactly-once publication/finalizer result after valid recovery.
        assert.equal(fx.counts.publishDetection, 1);
        assert.equal(fx.publishDetections[0].id, okId);
        assert.equal(finalizer.listFinalized().length, 1);
        assert.equal(finalizer.listFinalized()[0].detectionId, 1);
        ctrl.acceptPageSnapshot(florenSnapshot());
        await ctrl.tick(1_000_900);
        assert.equal(fx.counts.publishDetection, 1);
        assert.equal(ctrl.popupMedia(42).length, 1);
        assert.equal(ctrl.popupMedia(42)[0].id, okId);
      }

      // randomToken throws once
      {
        const tokenErr = new Error("TOKEN_INJECTED_BOOM");
        let thrown = false;
        let tokenInvocations = 0;
        await assertNetworkRejectedAtomic(
          (ctrl) => {
            ctrl.captureNetwork(validNetworkCapture());
          },
          {
            optionOverrides: {
              randomToken() {
                tokenInvocations += 1;
                if (!thrown) {
                  thrown = true;
                  throw tokenErr;
                }
                return "tok-ok";
              },
            },
            expectTokenIdentity: tokenErr,
            skipTokenCount: true,
            restore() {
              /* one-shot already consumed */
            },
          }
        );
        // One failing invocation + one successful recovery capture.
        assert.equal(tokenInvocations, 2);
      }

      // requestHeaders own accessor
      {
        const hits = { headerGetter: 0 };
        const headers = {};
        Object.defineProperty(headers, "Cookie", {
          enumerable: true,
          configurable: true,
          get() {
            hits.headerGetter += 1;
            throw new Error("HOSTILE_SECRET_HEADER_GETTER");
          },
        });
        await assertNetworkRejectedAtomic(
          (ctrl) => {
            ctrl.captureNetwork(
              validNetworkCapture({
                transport: {
                  mediaKind: "direct",
                  requestHeaders: headers,
                },
              })
            );
          },
          { hits }
        );
      }

      // requestHeaders symbol key
      {
        const headers = { Cookie: "session=ok" };
        headers[Symbol("secret")] = "HOSTILE_SYMBOL";
        await assertNetworkRejectedAtomic((ctrl) => {
          ctrl.captureNetwork(
            validNetworkCapture({
              transport: { mediaKind: "direct", requestHeaders: headers },
            })
          );
        });
      }

      // requestHeaders non-string value
      {
        await assertNetworkRejectedAtomic((ctrl) => {
          ctrl.captureNetwork(
            validNetworkCapture({
              transport: {
                mediaKind: "direct",
                requestHeaders: { Cookie: 123 },
              },
            })
          );
        });
      }

      // requestHeaders revoked Proxy
      {
        const rev = Proxy.revocable(
          { Cookie: "session=ok" },
          {}
        );
        rev.revoke();
        await assertNetworkRejectedAtomic((ctrl) => {
          ctrl.captureNetwork(
            validNetworkCapture({
              transport: {
                mediaKind: "direct",
                requestHeaders: rev.proxy,
              },
            })
          );
        });
      }

      // invalid / C1 response-header name
      {
        await assertNetworkRejectedAtomic((ctrl) => {
          ctrl.captureNetwork(
            validNetworkCapture({
              details: Object.assign({}, florenNetworkInput().details, {
                responseHeaders: [
                  { name: "Content-Type\u0085", value: "video/mp4" },
                ],
              }),
            })
          );
        });
      }

      // invalid / C1 response-header value
      {
        await assertNetworkRejectedAtomic((ctrl) => {
          ctrl.captureNetwork(
            validNetworkCapture({
              details: Object.assign({}, florenNetworkInput().details, {
                responseHeaders: [
                  { name: "Content-Type", value: "video/\u0081mp4" },
                ],
              }),
            })
          );
        });
      }

      // invalid now() NaN on pending network capture
      {
        let nowMode = "nan";
        await assertNetworkRejectedAtomic(
          (ctrl) => {
            ctrl.captureNetwork(validNetworkCapture());
          },
          {
            optionOverrides: {
              now() {
                if (nowMode === "nan") return Number.NaN;
                if (nowMode === "range") return DATE_RANGE_MS + 1;
                return 1_000_000;
              },
            },
            restore() {
              nowMode = "ok";
            },
          }
        );
      }

      // invalid now() out-of-Date-range on pending network capture
      {
        let bad = true;
        await assertNetworkRejectedAtomic(
          (ctrl) => {
            ctrl.captureNetwork(validNetworkCapture());
          },
          {
            optionOverrides: {
              now() {
                return bad ? DATE_RANGE_MS + 100 : 1_000_000;
              },
            },
            restore() {
              bad = false;
            },
          }
        );
      }
    }
  );

  await t.test(
    "BA04 DOM invalid/throwing capture is failure-atomic",
    async () => {
      function freshDomHarness(optionOverrides) {
        const inst = loadInstrumentedClassic();
        const fx = makeEffects();
        const ctrl = inst.api.createBackgroundAdapters(
          fx.options(optionOverrides || {})
        );
        return { inst, fx, ctrl };
      }

      async function assertDomRejectedAtomic(runCapture, opts) {
        const { inst, fx, ctrl } = freshDomHarness(opts && opts.optionOverrides);
        const finalizer = inst.sessionFinalizer();
        let threw = null;
        try {
          runCapture(ctrl, fx);
        } catch (err) {
          threw = err;
        }
        assert.ok(threw, "DOM capture must reject");
        if (opts && opts.expectTokenIdentity) {
          assert.equal(threw, opts.expectTokenIdentity);
        } else {
          assertGenericTypeError(threw);
        }
        if (opts && opts.hits) {
          for (const k of Object.keys(opts.hits)) {
            assert.equal(opts.hits[k], 0, "hostile " + k + " must not run");
          }
        }
        assertNoMaterialEffects(fx);
        assert.equal(
          fx.counts.randomToken,
          opts && opts.tokenCalls != null ? opts.tokenCalls : 0
        );
        assertNoFinalizerResidue(finalizer, ctrl, 70);
        assert.equal(inst.pendingRecords().length, 0);
        assert.equal(inst.sourceRecords().length, 0);

        if (opts && opts.restore) opts.restore();
        const okId = ctrl.captureDomMedia(validDomCapture());
        const pendings = inst.pendingRecords();
        assert.ok(pendings.length >= 1);
        assertFirstObservableIds(okId, pendings[pendings.length - 1]);
        assert.equal(fx.counts.publishDetection, 1);
        assert.equal(fx.publishDetections[0].id, okId);
        assert.equal(finalizer.listFinalized().length, 1);
        assert.equal(finalizer.listFinalized()[0].detectionId, 1);
      }

      // empty mediaUrl
      await assertDomRejectedAtomic((ctrl) => {
        ctrl.captureDomMedia(validDomCapture({ mediaUrl: "" }));
      });

      // blank mediaUrl
      await assertDomRejectedAtomic((ctrl) => {
        ctrl.captureDomMedia(validDomCapture({ mediaUrl: "   " }));
      });

      // control mediaUrl (C0)
      await assertDomRejectedAtomic((ctrl) => {
        ctrl.captureDomMedia(
          validDomCapture({ mediaUrl: "https://cdn.example/\u0001x.mp4" })
        );
      });

      // C1 mediaUrl
      await assertDomRejectedAtomic((ctrl) => {
        ctrl.captureDomMedia(
          validDomCapture({ mediaUrl: "https://cdn.example/\u0085x.mp4" })
        );
      });

      // requestHeaders invalid forms
      {
        const hits = { h: 0 };
        const headers = {};
        Object.defineProperty(headers, "Authorization", {
          enumerable: true,
          configurable: true,
          get() {
            hits.h += 1;
            return "Bearer x";
          },
        });
        await assertDomRejectedAtomic(
          (ctrl) => {
            ctrl.captureDomMedia(
              validDomCapture({
                transport: { mediaKind: "direct", requestHeaders: headers },
              })
            );
          },
          { hits }
        );
      }
      await assertDomRejectedAtomic((ctrl) => {
        const h = { a: "1" };
        h[Symbol("s")] = "x";
        ctrl.captureDomMedia(
          validDomCapture({
            transport: { mediaKind: "direct", requestHeaders: h },
          })
        );
      });
      await assertDomRejectedAtomic((ctrl) => {
        ctrl.captureDomMedia(
          validDomCapture({
            transport: {
              mediaKind: "direct",
              requestHeaders: { Cookie: false },
            },
          })
        );
      });
      {
        const rev = Proxy.revocable({ Cookie: "x" }, {});
        rev.revoke();
        await assertDomRejectedAtomic((ctrl) => {
          ctrl.captureDomMedia(
            validDomCapture({
              transport: {
                mediaKind: "direct",
                requestHeaders: rev.proxy,
              },
            })
          );
        });
      }

      // ts outside Date range / non-safe / non-finite
      await assertDomRejectedAtomic((ctrl) => {
        ctrl.captureDomMedia(validDomCapture({ ts: DATE_RANGE_MS + 1 }));
      });
      await assertDomRejectedAtomic((ctrl) => {
        ctrl.captureDomMedia(validDomCapture({ ts: Number.NaN }));
      });
      await assertDomRejectedAtomic((ctrl) => {
        ctrl.captureDomMedia(validDomCapture({ ts: Number.POSITIVE_INFINITY }));
      });
      await assertDomRejectedAtomic((ctrl) => {
        ctrl.captureDomMedia(
          validDomCapture({ ts: Number.MAX_SAFE_INTEGER + 1 })
        );
      });

      // invalid now() when DOM snapshot has no usable captured time
      {
        let bad = true;
        await assertDomRejectedAtomic(
          (ctrl) => {
            ctrl.captureDomMedia(
              validDomCapture({
                snapshot: {
                  documentId: "doc-dom-nocap",
                  tabId: 70,
                  frameId: 0,
                  pageUrl: "https://site.example/watch",
                  topLevelPageUrl: "https://site.example/watch",
                  documentNonce: "n-nocap",
                  candidates: [
                    { kind: "visible-filename", value: "dom-valid.mp4" },
                  ],
                  // capturedAt absent → finalizer may sample now()
                },
              })
            );
          },
          {
            optionOverrides: {
              now() {
                return bad ? Number.NaN : 1_000_000;
              },
            },
            restore() {
              bad = false;
            },
          }
        );
      }

      // revoked snapshot Proxy
      {
        const rev = Proxy.revocable(
          {
            documentId: "doc-dom-valid",
            tabId: 70,
            frameId: 0,
            pageUrl: "https://site.example/watch",
            topLevelPageUrl: "https://site.example/watch",
            documentNonce: "n",
            candidates: [{ kind: "visible-filename", value: "x.mp4" }],
            capturedAt: "2026-08-12T12:00:00.000Z",
          },
          {}
        );
        rev.revoke();
        await assertDomRejectedAtomic((ctrl) => {
          ctrl.captureDomMedia(validDomCapture({ snapshot: rev.proxy }));
        });
      }

      // revoked candidates Proxy
      {
        const rev = Proxy.revocable(
          [{ kind: "visible-filename", value: "x.mp4" }],
          {}
        );
        rev.revoke();
        await assertDomRejectedAtomic((ctrl) => {
          ctrl.captureDomMedia(
            validDomCapture({
              snapshot: {
                documentId: "doc-dom-valid",
                tabId: 70,
                frameId: 0,
                pageUrl: "https://site.example/watch",
                topLevelPageUrl: "https://site.example/watch",
                documentNonce: "n",
                candidates: rev.proxy,
                capturedAt: "2026-08-12T12:00:00.000Z",
              },
            })
          );
        });
      }

      // Ordinary Floren/DOM still succeed after the above patterns on a fresh ctrl
      {
        const { fx, ctrl } = freshDomHarness();
        const florenId = ctrl.captureNetwork(florenNetworkInput());
        ctrl.acceptPageSnapshot(florenSnapshot());
        assert.equal(fx.publishDetections[0].proposedFilename, "11238-makemebi.net.mp4");
        const domId = ctrl.captureDomMedia(validDomCapture());
        assert.ok(isSafeOpaqueId(florenId));
        assert.ok(isSafeOpaqueId(domId));
        assert.notEqual(florenId, domId);
        assert.equal(fx.counts.publishDetection, 2);
      }
    }
  );

  await t.test(
    "BA04 future transport is privately retained, copied, and frozen",
    async () => {
      const inst = loadInstrumentedClassic();
      const fx = makeEffects();
      const ctrl = inst.api.createBackgroundAdapters(fx.options());

      const mirrorA =
        "https://m1.example-cdn.invalid/a.mp4?token=SECRET_SIGNED_QUERY_XYZ&exp=1";
      const mirrorB =
        "https://m2.example-cdn.invalid/b.mp4?token=SECRET_SIGNED_QUERY_XYZ&exp=2";
      const refererExact =
        "https://site.example/SECRET_REFERER_PATH/ref?auth=SECRET_AUTH_BEARER_TOKEN";
      const uaExact = "Lease1TestAgent/2.5 SECRET_AUTH_BEARER_TOKEN";
      const variantUrl =
        "https://v.example-cdn.invalid/v.mp4?token=SECRET_SIGNED_QUERY_XYZ";
      const mirrorsArr = [mirrorA, mirrorB];
      const variantsArr = [
        {
          url: variantUrl,
          label: "1080p",
          bandwidth: 5000000,
        },
      ];
      const transportObj = {
        mediaKind: "direct",
        requestHeaders: {
          Cookie: "session=SECRET_COOKIE_ABC",
          Authorization: "Bearer SECRET_AUTH_BEARER_TOKEN",
        },
        mirrors: mirrorsArr,
        referer: refererExact,
        userAgent: uaExact,
        variants: variantsArr,
      };

      const mediaId = ctrl.captureNetwork(
        validNetworkCapture({ transport: transportObj })
      );
      const pendings = inst.pendingRecords();
      assert.equal(pendings.length, 1);
      const pending = pendings[0];
      assert.deepEqual(Object.keys(pending).sort(), [
        "detectionId",
        "ephemeral",
        "mediaKind",
        "tabId",
      ]);

      const ftDesc = Object.getOwnPropertyDescriptor(pending, "futureTransport");
      assert.ok(ftDesc, "futureTransport must exist on pending");
      assert.equal(ftDesc.enumerable, false);
      assert.equal(ftDesc.writable, false);
      assert.equal(ftDesc.configurable, false);
      const ft = ftDesc.value;
      assert.ok(ft && typeof ft === "object");
      assert.ok(Object.isFrozen(ft), "futureTransport handle frozen");
      assert.notEqual(ft.mirrors, mirrorsArr, "mirrors must be a fresh copy");
      assert.notEqual(ft.variants, variantsArr, "variants must be a fresh copy");
      assert.ok(Object.isFrozen(ft.mirrors));
      assert.ok(Object.isFrozen(ft.variants));
      assert.ok(Object.isFrozen(ft.variants[0]));
      assert.equal(ft.mirrors[0], mirrorA);
      assert.equal(ft.mirrors[1], mirrorB);
      assert.equal(ft.referer, refererExact);
      assert.equal(ft.userAgent, uaExact);
      assert.equal(ft.variants[0].url, variantUrl);
      assert.equal(ft.variants[0].label, "1080p");
      assert.equal(ft.variants[0].bandwidth, 5000000);
      // requestHeaders owned only by Privacy.createEphemeral — absent here.
      assert.equal(
        Object.prototype.hasOwnProperty.call(ft, "requestHeaders"),
        false
      );
      assert.equal("requestHeaders" in ft, false);

      // Mutate caller after capture — retained values unchanged.
      mirrorsArr[0] = "mutated-mirror";
      variantsArr[0].url = "mutated-variant";
      transportObj.referer = "mutated-referer";
      transportObj.userAgent = "mutated-ua";
      transportObj.mirrors = [];
      transportObj.variants = [];
      assert.equal(ft.mirrors[0], mirrorA);
      assert.equal(ft.variants[0].url, variantUrl);
      assert.equal(ft.referer, refererExact);
      assert.equal(ft.userAgent, uaExact);

      // Public surfaces must not project secrets.
      assert.equal(ctrl.popupMedia(42).length, 0);
      assert.equal(fx.counts.publishDetection, 0);
      assert.equal(JSON.stringify(pending), JSON.stringify({
        detectionId: pending.detectionId,
        ephemeral: pending.ephemeral,
        mediaKind: pending.mediaKind,
        tabId: pending.tabId,
      }));
      assertNoSentinels(
        {
          keys: Object.keys(pending),
          json: JSON.stringify(pending),
        },
        "enumerable pending"
      );

      ctrl.acceptPageSnapshot(florenSnapshot());
      assert.equal(fx.counts.publishDetection, 1);
      const sources = inst.sourceRecords();
      assert.ok(sources.length >= 1);
      const source = sources[sources.length - 1];
      const srcFtDesc = Object.getOwnPropertyDescriptor(source, "futureTransport");
      assert.ok(srcFtDesc, "futureTransport on finalized source");
      assert.equal(srcFtDesc.enumerable, false);
      assert.equal(srcFtDesc.writable, false);
      assert.equal(srcFtDesc.configurable, false);
      const srcFt = srcFtDesc.value;
      assert.ok(Object.isFrozen(srcFt));
      assert.equal(srcFt.mirrors[0], mirrorA);
      assert.equal(srcFt.referer, refererExact);
      assert.equal(srcFt.userAgent, uaExact);
      assert.equal(srcFt.variants[0].url, variantUrl);
      assert.equal(
        Object.prototype.hasOwnProperty.call(srcFt, "requestHeaders"),
        false
      );

      const pop = ctrl.popupMedia(42);
      assert.equal(pop[0].id, mediaId);
      assertNoSentinels(pop, "transport popup");
      assertNoSentinels(fx.publishDetections, "transport publish");
      assertNoSentinels(fx.diagnostics, "transport diagnostics");
      const publicBlob = [
        JSON.stringify(pop),
        JSON.stringify(fx.publishDetections),
        JSON.stringify(Object.keys(source)),
        JSON.stringify(Object.keys(pending)),
      ].join("\n");
      for (const s of SECRET_SENTINELS) {
        assert.equal(publicBlob.includes(s), false, "public must not contain " + s);
      }
      // Direct private reads still retain secrets for later leases.
      assert.equal(srcFt.mirrors[0].includes("SECRET_SIGNED_QUERY_XYZ"), true);

      // Reject invalid transport graphs before IDs / finalizer / effects.
      function assertTransportReject(transportPatch, label, hits) {
        const h = loadInstrumentedClassic();
        const fx2 = makeEffects();
        const c2 = h.api.createBackgroundAdapters(fx2.options());
        let err = null;
        try {
          c2.captureNetwork(
            validNetworkCapture({
              transport: Object.assign(
                { mediaKind: "direct", requestHeaders: null },
                transportPatch
              ),
            })
          );
        } catch (e) {
          err = e;
        }
        assert.ok(err, label + " must reject");
        assertGenericTypeError(err);
        assert.equal(fx2.counts.randomToken, 0, label + " no token");
        assert.equal(fx2.counts.publishDetection, 0, label + " no publish");
        assertNoMaterialEffects(fx2);
        assert.equal(h.sessionFinalizer().listFinalized().length, 0, label);
        assert.equal(h.pendingRecords().length, 0, label + " no pending");
        assert.equal(h.sourceRecords().length, 0, label + " no source");
        if (hits) {
          for (const k of Object.keys(hits)) {
            assert.equal(hits[k], 0, label + " hostile " + k + " must not run");
          }
        }
      }

      // accessor on mirrors index via non-data descriptor entry.
      // Build a real Array (length is non-configurable — never redefine it).
      // Defining index "0" on [] advances length to 1 automatically.
      {
        const hits = { mirrorGet: 0 };
        const hostileMirrors = [];
        Object.defineProperty(hostileMirrors, "0", {
          configurable: true,
          enumerable: true,
          get() {
            hits.mirrorGet += 1;
            throw new Error("HOSTILE_MIRROR_GET");
          },
        });
        assert.equal(hostileMirrors.length, 1);
        assertTransportReject(
          { mirrors: hostileMirrors },
          "accessor mirrors",
          hits
        );
      }
      // accessor on variants index
      {
        const hits = { variantGet: 0 };
        const hostileVariants = [];
        Object.defineProperty(hostileVariants, "0", {
          configurable: true,
          enumerable: true,
          get() {
            hits.variantGet += 1;
            throw new Error("HOSTILE_VARIANT_GET");
          },
        });
        assert.equal(hostileVariants.length, 1);
        assertTransportReject(
          { variants: hostileVariants },
          "accessor variants",
          hits
        );
      }
      assertTransportReject(
        {
          mirrors: (() => {
            const a = ["https://ok.example/a.mp4"];
            a[2] = "https://ok.example/sparse.mp4";
            return a;
          })(),
        },
        "sparse mirrors"
      );
      assertTransportReject(
        {
          variants: (() => {
            const a = [{ url: "https://ok.example/v.mp4" }];
            a[2] = { url: "https://ok.example/sparse.mp4" };
            return a;
          })(),
        },
        "sparse variants"
      );
      // Symbol own keys on mirrors / variants arrays must reject descriptor-safely.
      {
        const mirrors = ["https://ok.example/a.mp4"];
        mirrors[Symbol("mirror-secret")] = "HOSTILE_SYMBOL_MIRROR";
        assertTransportReject({ mirrors: mirrors }, "symbol on mirrors array");
      }
      {
        const variants = [{ url: "https://ok.example/v.mp4" }];
        variants[Symbol("variant-secret")] = "HOSTILE_SYMBOL_VARIANT";
        assertTransportReject(
          { variants: variants },
          "symbol on variants array"
        );
      }
      // Unexpected non-index own data properties on array shells.
      {
        const mirrors = ["https://ok.example/a.mp4"];
        mirrors.extra = "unexpected";
        assertTransportReject(
          { mirrors: mirrors },
          "unexpected own property on mirrors"
        );
      }
      {
        const variants = [{ url: "https://ok.example/v.mp4" }];
        variants.extra = "unexpected";
        assertTransportReject(
          { variants: variants },
          "unexpected own property on variants"
        );
      }
      {
        const rev = Proxy.revocable(["https://ok.example/a.mp4"], {});
        rev.revoke();
        assertTransportReject({ mirrors: rev.proxy }, "revoked mirrors");
      }
      {
        const rev = Proxy.revocable(
          [{ url: "https://ok.example/v.mp4", label: "x" }],
          {}
        );
        rev.revoke();
        assertTransportReject({ variants: rev.proxy }, "revoked variants");
      }
      assertTransportReject(
        { mirrors: new Array(65).fill("https://ok.example/x.mp4") },
        "excessive mirrors"
      );
      assertTransportReject(
        { variants: new Array(65).fill({ url: "https://ok.example/x.mp4" }) },
        "excessive variants"
      );
      assertTransportReject(
        { variants: [{ url: "https://ok.example/x.mp4", nested: { a: 1 } }] },
        "nested non-primitive variant field"
      );
      assertTransportReject(
        { referer: "https://x.example/\u0001" },
        "control referer"
      );
      assertTransportReject(
        { userAgent: "agent\u0085" },
        "C1 userAgent"
      );
      assertTransportReject(
        { mirrors: ["https://ok.example/\u009F.mp4"] },
        "C1 mirror"
      );
      assertTransportReject({ mirrors: [12] }, "non-string mirror");

      // Every variant entry requires an own-data primitive, nonblank,
      // C0/DEL/C1-free absolute HTTP(S) url — reject before any allocation.
      assertTransportReject(
        { variants: [{ label: "no-url" }] },
        "variant missing url"
      );
      assertTransportReject(
        { variants: [{ url: 99 }] },
        "numeric variant url"
      );
      assertTransportReject(
        { variants: [{ url: { href: "https://ok.example/x.mp4" } }] },
        "object variant url"
      );
      assertTransportReject(
        { variants: [{ url: Object("https://ok.example/x.mp4") }] },
        "boxed String variant url"
      );
      {
        const hits = { variantUrlGet: 0, toString: 0 };
        const entry = {};
        Object.defineProperty(entry, "url", {
          enumerable: true,
          configurable: true,
          get() {
            hits.variantUrlGet += 1;
            throw new Error("HOSTILE_VARIANT_URL_GET");
          },
        });
        assertTransportReject(
          { variants: [entry] },
          "accessor variant url",
          hits
        );
      }
      {
        const hits = { toString: 0 };
        const hostileUrl = {
          toString() {
            hits.toString += 1;
            return "https://HOSTILE_SECRET_toString.example/x.mp4";
          },
        };
        assertTransportReject(
          { variants: [{ url: hostileUrl }] },
          "toString-trap variant url",
          hits
        );
      }
      assertTransportReject(
        { variants: [{ url: "   " }] },
        "whitespace variant url"
      );
      assertTransportReject(
        { variants: [{ url: "" }] },
        "blank variant url"
      );
      assertTransportReject(
        { variants: [{ url: "ftp://ok.example/x.mp4" }] },
        "non-HTTP variant url (ftp)"
      );
      assertTransportReject(
        { variants: [{ url: "/relative/path.mp4" }] },
        "non-HTTP variant url (relative)"
      );
      assertTransportReject(
        { variants: [{ url: "javascript:alert(1)" }] },
        "non-HTTP variant url (javascript)"
      );
      assertTransportReject(
        { variants: [{ url: "https://ok.example/\u0085x.mp4" }] },
        "C1 variant url"
      );
      assertTransportReject(
        { variants: [{ url: "https://ok.example/\u0001x.mp4" }] },
        "C0 variant url"
      );
      assertTransportReject(
        { variants: [{ url: "https://ok.example/\u007fx.mp4" }] },
        "DEL variant url"
      );
      {
        const v = [{ url: "https://ok.example/x.mp4" }];
        v[Symbol("s")] = 1;
        // symbol on array may be ignored by length walk — use symbol on record
        assertTransportReject(
          {
            variants: [
              Object.defineProperty(
                { url: "https://ok.example/x.mp4" },
                Symbol("s"),
                { enumerable: true, value: "x" }
              ),
            ],
          },
          "symbol on variant record"
        );
      }
    }
  );

  await t.test(
    "BA04 revoked proxies, generic errors, and C1 controls",
    async () => {
      const api = loadAdapters();

      function assertRevokedReject(buildInput, method) {
        const fx = makeEffects();
        const c = api.createBackgroundAdapters(fx.options());
        let err = null;
        try {
          if (method === "network") c.captureNetwork(buildInput());
          else c.captureDomMedia(buildInput());
        } catch (e) {
          err = e;
        }
        assertGenericTypeError(err);
        assert.equal(fx.counts.randomToken, 0);
        assert.equal(fx.counts.publishDetection, 0);
        assert.deepEqual(c.popupMedia(42), []);
        assert.deepEqual(c.popupMedia(70), []);
      }

      // requestHeaders revoked
      {
        const rev = Proxy.revocable({ Cookie: "x" }, {});
        rev.revoke();
        assertRevokedReject(
          () =>
            validNetworkCapture({
              transport: { mediaKind: "direct", requestHeaders: rev.proxy },
            }),
          "network"
        );
      }
      // responseHeaders revoked
      {
        const rev = Proxy.revocable(
          [{ name: "Content-Type", value: "video/mp4" }],
          {}
        );
        rev.revoke();
        assertRevokedReject(
          () =>
            validNetworkCapture({
              details: Object.assign({}, florenNetworkInput().details, {
                responseHeaders: rev.proxy,
              }),
            }),
          "network"
        );
      }
      // candidates revoked
      {
        const rev = Proxy.revocable(
          [{ kind: "visible-filename", value: "x.mp4" }],
          {}
        );
        rev.revoke();
        assertRevokedReject(
          () =>
            validDomCapture({
              snapshot: {
                documentId: "doc-dom-valid",
                tabId: 70,
                frameId: 0,
                pageUrl: "https://site.example/watch",
                topLevelPageUrl: "https://site.example/watch",
                documentNonce: "n",
                candidates: rev.proxy,
                capturedAt: "2026-08-12T12:00:00.000Z",
              },
            }),
          "dom"
        );
      }
      // mirrors revoked
      {
        const rev = Proxy.revocable(["https://ok.example/a.mp4"], {});
        rev.revoke();
        assertRevokedReject(
          () =>
            validNetworkCapture({
              transport: {
                mediaKind: "direct",
                requestHeaders: null,
                mirrors: rev.proxy,
              },
            }),
          "network"
        );
      }
      // variants revoked
      {
        const rev = Proxy.revocable(
          [{ url: "https://ok.example/v.mp4" }],
          {}
        );
        rev.revoke();
        assertRevokedReject(
          () =>
            validNetworkCapture({
              transport: {
                mediaKind: "direct",
                requestHeaders: null,
                variants: rev.proxy,
              },
            }),
          "network"
        );
      }

      // C1 / C0 / DEL never reach proposed filename or publish
      {
        const fx = makeEffects();
        const c = api.createBackgroundAdapters(fx.options());
        const c1Name = "evil\u0085name.mp4";
        let err = null;
        try {
          c.captureDomMedia(
            validDomCapture({
              snapshot: {
                documentId: "doc-c1",
                tabId: 70,
                frameId: 0,
                pageUrl: "https://site.example/watch",
                topLevelPageUrl: "https://site.example/watch",
                documentNonce: "n-c1",
                candidates: [{ kind: "visible-filename", value: c1Name }],
                capturedAt: "2026-08-12T12:00:00.000Z",
              },
            })
          );
        } catch (e) {
          err = e;
        }
        assertGenericTypeError(err);
        assert.equal(fx.counts.publishDetection, 0);
        assert.equal(fx.counts.randomToken, 0);
        assert.deepEqual(c.popupMedia(70), []);

        // C0 in header name
        err = null;
        try {
          c.captureNetwork(
            validNetworkCapture({
              details: Object.assign({}, florenNetworkInput().details, {
                responseHeaders: [{ name: "X\u0001Header", value: "v" }],
              }),
            })
          );
        } catch (e) {
          err = e;
        }
        assertGenericTypeError(err);
        assert.equal(fx.counts.randomToken, 0);
        assert.equal(fx.counts.publishDetection, 0);

        // DEL in header value
        err = null;
        try {
          c.captureNetwork(
            validNetworkCapture({
              transport: {
                mediaKind: "direct",
                requestHeaders: { Cookie: "x\u007f" },
              },
            })
          );
        } catch (e) {
          err = e;
        }
        assertGenericTypeError(err);
        assert.equal(fx.counts.randomToken, 0);

        // C1 in referer / userAgent
        err = null;
        try {
          c.captureNetwork(
            validNetworkCapture({
              transport: {
                mediaKind: "direct",
                requestHeaders: null,
                referer: "https://x.example/\u0080",
              },
            })
          );
        } catch (e) {
          err = e;
        }
        assertGenericTypeError(err);
        assert.equal(fx.counts.randomToken, 0);

        // C0 / DEL / C1 in hints.topLevelUrlHint and hints.frameOrigin reject
        // before token allocation, finalizer work, or publication.
        const hintControlCases = [
          {
            label: "C0 topLevelUrlHint",
            hints: {
              topLevelUrlHint: "https://site.example/\u0001path",
              frameOrigin: "https://site.example",
            },
          },
          {
            label: "DEL topLevelUrlHint",
            hints: {
              topLevelUrlHint: "https://site.example/\u007fpath",
              frameOrigin: "https://site.example",
            },
          },
          {
            label: "C1 topLevelUrlHint",
            hints: {
              topLevelUrlHint: "https://site.example/\u0085path",
              frameOrigin: "https://site.example",
            },
          },
          {
            label: "C0 frameOrigin",
            hints: {
              topLevelUrlHint: "https://site.example/watch",
              frameOrigin: "https://site.example\u0001",
            },
          },
          {
            label: "DEL frameOrigin",
            hints: {
              topLevelUrlHint: "https://site.example/watch",
              frameOrigin: "https://site.example\u007f",
            },
          },
          {
            label: "C1 frameOrigin",
            hints: {
              topLevelUrlHint: "https://site.example/watch",
              frameOrigin: "https://site.example\u009f",
            },
          },
        ];
        for (const hc of hintControlCases) {
          const tokenBefore = fx.counts.randomToken;
          const pubBefore = fx.counts.publishDetection;
          err = null;
          try {
            c.captureNetwork(
              validNetworkCapture({ hints: hc.hints })
            );
          } catch (e) {
            err = e;
          }
          assert.ok(err, hc.label + " must reject");
          assertGenericTypeError(err);
          assert.equal(
            fx.counts.randomToken,
            tokenBefore,
            hc.label + " no token"
          );
          assert.equal(
            fx.counts.publishDetection,
            pubBefore,
            hc.label + " no publish"
          );
          assert.deepEqual(c.popupMedia(42), []);
        }

        // Object toString traps on hints/scalars must never execute or leak.
        {
          const hits = { toString: 0 };
          const hostileHint = {
            toString() {
              hits.toString += 1;
              throw new Error("HOSTILE_SECRET_HINT_toString");
            },
          };
          err = null;
          try {
            c.captureNetwork(
              validNetworkCapture({
                hints: {
                  topLevelUrlHint: hostileHint,
                  frameOrigin: "https://site.example",
                },
              })
            );
          } catch (e) {
            err = e;
          }
          assertGenericTypeError(err);
          assert.equal(hits.toString, 0, "hint toString must not run");
          assert.equal(fx.counts.randomToken, 0);
          assert.equal(fx.counts.publishDetection, 0);
        }
        {
          const hits = { toString: 0 };
          const hostileOrigin = {
            toString() {
              hits.toString += 1;
              return "https://HOSTILE_SECRET_frameOrigin.example";
            },
          };
          err = null;
          try {
            c.captureNetwork(
              validNetworkCapture({
                hints: {
                  topLevelUrlHint: "https://site.example/watch",
                  frameOrigin: hostileOrigin,
                },
              })
            );
          } catch (e) {
            err = e;
          }
          assertGenericTypeError(err);
          assert.equal(hits.toString, 0, "frameOrigin toString must not run");
          assert.equal(fx.counts.randomToken, 0);
        }

        // Revoked proxy as entire transport / details / hints — generic only.
        {
          const rev = Proxy.revocable(
            { mediaKind: "direct", requestHeaders: null },
            {}
          );
          rev.revoke();
          err = null;
          try {
            c.captureNetwork(
              validNetworkCapture({ transport: rev.proxy })
            );
          } catch (e) {
            err = e;
          }
          assertGenericTypeError(err);
          assert.equal(
            String(err.message + (err.stack || "")).includes("HOSTILE_SECRET"),
            false
          );
          assert.equal(fx.counts.randomToken, 0);
          assert.equal(fx.counts.publishDetection, 0);
        }
        {
          const rev = Proxy.revocable(
            { topLevelUrlHint: "https://site.example/watch", frameOrigin: "https://site.example" },
            {}
          );
          rev.revoke();
          err = null;
          try {
            c.captureNetwork(validNetworkCapture({ hints: rev.proxy }));
          } catch (e) {
            err = e;
          }
          assertGenericTypeError(err);
          assert.equal(fx.counts.randomToken, 0);
          assert.equal(fx.counts.publishDetection, 0);
        }

        // Valid Unicode including non-BMP still accepted as filename candidate
        const nonBmp = "clip-\u{1F3AC}end.mp4";
        const id = c.captureDomMedia(
          validDomCapture({
            snapshot: {
              documentId: "doc-unicode",
              tabId: 71,
              frameId: 0,
              pageUrl: "https://site.example/watch",
              topLevelPageUrl: "https://site.example/watch",
              documentNonce: "n-u",
              candidates: [{ kind: "visible-filename", value: nonBmp }],
              capturedAt: "2026-08-12T12:00:00.000Z",
            },
          })
        );
        assert.ok(isSafeOpaqueId(id));
        assert.equal(fx.counts.publishDetection, 1);
        assert.equal(fx.publishDetections[0].proposedFilename, nonBmp);
        assert.equal(c.popupMedia(71)[0].proposedFilename, nonBmp);
        assert.equal(
          JSON.stringify(fx.publishDetections[0]).includes("\u0085"),
          false
        );
      }
    }
  );

  await t.test(
    "BA04 randomToken reentrancy and reservation control",
    async () => {
      const inst = loadInstrumentedClassic();
      const fx = makeEffects();
      let ctrl;
      let reentered = false;
      let reenterId = null;
      ctrl = inst.api.createBackgroundAdapters(
        fx.options({
          randomToken(namespace) {
            fx.counts.randomToken += 1;
            if (!reentered) {
              reentered = true;
              // Reenter one valid capture before returning the outer token.
              reenterId = ctrl.captureNetwork(
                validNetworkCapture({
                  details: Object.assign({}, florenNetworkInput().details, {
                    documentId: "doc-reenter-token",
                    url: "https://cdn.example/reenter-token.mp4",
                  }),
                })
              );
            }
            return "tok-reenter";
          },
        })
      );

      const outerId = ctrl.captureNetwork(
        validNetworkCapture({
          details: Object.assign({}, florenNetworkInput().details, {
            documentId: "doc-outer-token",
            url: "https://cdn.example/outer-token.mp4",
          }),
        })
      );

      assert.ok(isSafeOpaqueId(outerId));
      assert.ok(isSafeOpaqueId(reenterId));
      assert.notEqual(outerId, reenterId);
      assert.match(reenterId, /:1$/);
      assert.match(outerId, /:2$/);

      const pendings = inst.pendingRecords();
      assert.equal(pendings.length, 2);
      const detIds = pendings.map((p) => p.detectionId).sort((a, b) => a - b);
      assert.deepEqual(detIds, [1, 2]);
      assert.equal(new Set(detIds).size, 2);

      // Finalize both — each publishes exactly once.
      ctrl.acceptPageSnapshot({
        documentId: "doc-reenter-token",
        tabId: 42,
        frameId: 0,
        pageUrl: florenPageUrl(),
        topLevelPageUrl: florenPageUrl(),
        documentNonce: "n-rt",
        candidates: [{ kind: "visible-filename", value: "reenter-token.mp4" }],
        capturedAt: "2026-08-12T12:00:00.000Z",
      });
      ctrl.acceptPageSnapshot({
        documentId: "doc-outer-token",
        tabId: 42,
        frameId: 0,
        pageUrl: florenPageUrl(),
        topLevelPageUrl: florenPageUrl(),
        documentNonce: "n-ot",
        candidates: [{ kind: "visible-filename", value: "outer-token.mp4" }],
        capturedAt: "2026-08-12T12:00:01.000Z",
      });
      assert.equal(fx.counts.publishDetection, 2);
      const pubIds = fx.publishDetections.map((p) => p.id).sort();
      assert.deepEqual(pubIds, [outerId, reenterId].sort());
      assert.equal(ctrl.popupMedia(42).length, 2);

      // Token throw after prevalidation commits no suffix.
      {
        const inst2 = loadInstrumentedClassic();
        const fx2 = makeEffects();
        const tokenErr = new Error("TOKEN_THROW_AFTER_PREVALIDATION");
        let shouldThrow = true;
        const c2 = inst2.api.createBackgroundAdapters(
          fx2.options({
            randomToken() {
              fx2.counts.randomToken += 1;
              if (shouldThrow) throw tokenErr;
              return "tok-after";
            },
          })
        );
        let threw = null;
        try {
          c2.captureNetwork(validNetworkCapture());
        } catch (e) {
          threw = e;
        }
        assert.equal(threw, tokenErr);
        assert.equal(inst2.sessionFinalizer().listFinalized().length, 0);
        assert.equal(inst2.pendingRecords().length, 0);
        assert.equal(fx2.counts.publishDetection, 0);
        shouldThrow = false;
        const okId = c2.captureNetwork(validNetworkCapture());
        assert.match(okId, /:1$/);
        const p = inst2.pendingRecords();
        assert.equal(p[p.length - 1].detectionId, 1);
      }
    }
  );
});
