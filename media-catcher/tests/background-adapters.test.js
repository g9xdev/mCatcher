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

  // Probe ProviderRegistry observation methods (Lease 1 must never call them).
  const registryHits = {
    observe: 0,
    lookup: 0,
    clear: 0,
    snapshot: 0,
    create: 0,
  };
  const RealPR = root.McProviderRegistry;
  const realCreatePR = RealPR.createProviderRegistry;
  root.McProviderRegistry = {
    normalizeOrigin: RealPR.normalizeOrigin,
    normalizeProviderKey: RealPR.normalizeProviderKey,
    createProviderRegistry() {
      registryHits.create += 1;
      const reg = realCreatePR.call(RealPR);
      return {
        observe(mediaOrigin, providerKey) {
          registryHits.observe += 1;
          return reg.observe(mediaOrigin, providerKey);
        },
        lookup(mediaOrigin) {
          registryHits.lookup += 1;
          return reg.lookup(mediaOrigin);
        },
        clear() {
          registryHits.clear += 1;
          return reg.clear();
        },
        snapshot() {
          registryHits.snapshot += 1;
          return reg.snapshot();
        },
      };
    },
  };

  const finalizers = [];
  const RealDF = root.McDetectionFinalizer;
  const realCreate = RealDF.createDetectionFinalizer;
  root.McDetectionFinalizer = {
    CONTEXT_WAIT_MS: RealDF.CONTEXT_WAIT_MS,
    mapWebRequestDetails: RealDF.mapWebRequestDetails,
    createDetectionFinalizer(deps) {
      const instance = realCreate.call(RealDF, deps);
      // Count real finalizer mutation entry points (pending + finalized).
      const origBegin = instance.beginNetworkDetection;
      const origDom = instance.finalizeFromDom;
      const origTick = instance.tick;
      const origProvide = instance.provideDocumentSnapshot;
      instance._beginNetworkCalls = 0;
      instance._finalizeDomCalls = 0;
      instance._tickCalls = 0;
      instance._provideSnapshotCalls = 0;
      instance.beginNetworkDetection = function (event) {
        instance._beginNetworkCalls += 1;
        return origBegin.call(instance, event);
      };
      instance.finalizeFromDom = function (input) {
        instance._finalizeDomCalls += 1;
        return origDom.call(instance, input);
      };
      instance.tick = function (now) {
        instance._tickCalls += 1;
        return origTick.call(instance, now);
      };
      instance.provideDocumentSnapshot = function (snapshot) {
        instance._provideSnapshotCalls += 1;
        return origProvide.call(instance, snapshot);
      };
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
    registryHits,
    sessionFinalizer() {
      return finalizers[0] || null;
    },
    /**
     * Finalizer-internal allocations (pending {event,deadline} + finalized
     * items). Do not use listFinalized alone — pending IDs stay hidden there.
     */
    finalizerAllocations() {
      let pending = 0;
      let finalized = 0;
      for (const m of trackedMaps) {
        for (const entry of m._sets) {
          const v = entry.value;
          if (!v || typeof v !== "object") continue;
          const keys = Object.keys(v);
          if (
            keys.includes("event") &&
            keys.includes("deadline") &&
            keys.length === 2
          ) {
            pending += 1;
          }
          if (
            keys.includes("detectionId") &&
            keys.includes("mediaUrl") &&
            keys.includes("sourceContext") &&
            keys.includes("proposedFilename")
          ) {
            finalized += 1;
          }
        }
      }
      return { pending: pending, finalized: finalized };
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

function snapshotEffectBaseline(fx) {
  return {
    now: fx.counts.now,
    randomToken: fx.counts.randomToken,
    publishDetection: fx.counts.publishDetection,
    publishJobs: fx.counts.publishJobs,
    persistHistory: fx.counts.persistHistory,
    reportDiagnostic: fx.counts.reportDiagnostic,
    isPopupSender: fx.counts.isPopupSender,
    getEffectiveDestinationDirectory: fx.counts.getEffectiveDestinationDirectory,
    postNative: fx.counts.postNative,
    downloadsDownload: fx.counts.downloadsDownload,
    fetchArrayBuffer: fx.counts.fetchArrayBuffer,
    assembleMedia: fx.counts.assembleMedia,
    createObjectURL: fx.counts.createObjectURL,
    revokeObjectURL: fx.counts.revokeObjectURL,
  };
}

function assertEffectBaseline(fx, baseline, label) {
  const prefix = label ? label + " " : "";
  assert.equal(fx.counts.now, baseline.now, prefix + "now");
  assert.equal(fx.counts.randomToken, baseline.randomToken, prefix + "randomToken");
  assert.equal(
    fx.counts.publishDetection,
    baseline.publishDetection,
    prefix + "publishDetection"
  );
  assert.equal(fx.counts.publishJobs, baseline.publishJobs, prefix + "publishJobs");
  assert.equal(
    fx.counts.persistHistory,
    baseline.persistHistory,
    prefix + "persistHistory"
  );
  assert.equal(
    fx.counts.reportDiagnostic,
    baseline.reportDiagnostic,
    prefix + "reportDiagnostic"
  );
  assert.equal(
    fx.counts.isPopupSender,
    baseline.isPopupSender,
    prefix + "isPopupSender"
  );
  assert.equal(
    fx.counts.getEffectiveDestinationDirectory,
    baseline.getEffectiveDestinationDirectory,
    prefix + "getEffectiveDestinationDirectory"
  );
  assert.equal(fx.counts.postNative, baseline.postNative, prefix + "postNative");
  assert.equal(
    fx.counts.downloadsDownload,
    baseline.downloadsDownload,
    prefix + "downloadsDownload"
  );
  assert.equal(
    fx.counts.fetchArrayBuffer,
    baseline.fetchArrayBuffer,
    prefix + "fetchArrayBuffer"
  );
  assert.equal(
    fx.counts.assembleMedia,
    baseline.assembleMedia,
    prefix + "assembleMedia"
  );
  assert.equal(
    fx.counts.createObjectURL,
    baseline.createObjectURL,
    prefix + "createObjectURL"
  );
  assert.equal(
    fx.counts.revokeObjectURL,
    baseline.revokeObjectURL,
    prefix + "revokeObjectURL"
  );
}

function assertRegistryIdle(inst, label) {
  const prefix = label ? label + " " : "";
  assert.equal(inst.registryHits.observe, 0, prefix + "ProviderRegistry.observe");
  assert.equal(inst.registryHits.lookup, 0, prefix + "ProviderRegistry.lookup");
  assert.equal(inst.registryHits.clear, 0, prefix + "ProviderRegistry.clear");
  assert.equal(inst.registryHits.snapshot, 0, prefix + "ProviderRegistry.snapshot");
}

/**
 * Fresh instrumented controller per rejected capture.
 * Proves generic TypeError, zero effects vs baseline, single unmutated session
 * finalizer (no disposable preflight; no pending/finalized allocation), zero
 * ProviderRegistry observation, orphan-proof snapshot/tick, then valid recovery
 * as first allocation (media:...:1 / detectionId 1) publishing exactly once.
 */
async function assertRejectedCaptureAtomic(opts) {
  const label = opts.label || "rejected capture";
  const method = opts.method || "network";
  const tabId = opts.tabId != null ? opts.tabId : method === "network" ? 42 : 70;
  const inst = loadInstrumentedClassic();
  const fx = makeEffects();
  const ctrl = inst.api.createBackgroundAdapters(
    fx.options(opts.optionOverrides || {})
  );
  const finalizer = inst.sessionFinalizer();
  assert.ok(finalizer, label + " session finalizer");
  assert.equal(inst.finalizers.length, 1, label + " one session finalizer at start");
  assert.equal(finalizer._beginNetworkCalls, 0);
  assert.equal(finalizer._finalizeDomCalls, 0);

  const baseline = snapshotEffectBaseline(fx);
  const registryCreateAtStart = inst.registryHits.create;

  let threw = null;
  try {
    opts.run(ctrl, fx);
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, label + " must reject");
  if (opts.expectIdentity != null) {
    assert.equal(threw, opts.expectIdentity, label + " exception identity");
  } else {
    assertGenericTypeError(threw, {
      notSameAs: opts.notSameAs,
    });
  }

  if (opts.hits) {
    for (const k of Object.keys(opts.hits)) {
      assert.equal(opts.hits[k], 0, label + " hostile " + k + " must not run");
    }
  }

  // Rejected-phase effects frozen at baseline (including now/token/diagnostic).
  assertEffectBaseline(fx, baseline, label + " rejected-phase");
  assertRegistryIdle(inst, label + " rejected-phase");
  // createProviderRegistry runs once at controller construction only.
  assert.equal(
    inst.registryHits.create,
    registryCreateAtStart,
    label + " no extra ProviderRegistry create"
  );

  // No disposable preflight finalizer and no session finalizer mutation.
  assert.equal(
    inst.finalizers.length,
    1,
    label + " no disposable preflight finalizer"
  );
  assert.equal(
    finalizer._beginNetworkCalls,
    0,
    label + " session beginNetworkDetection must not run"
  );
  assert.equal(
    finalizer._finalizeDomCalls,
    0,
    label + " session finalizeFromDom must not run"
  );
  assert.equal(finalizer.listFinalized().length, 0, label + " no finalized");
  assert.equal(finalizer.getItem(1), null, label + " getItem(1) empty");
  assert.equal(finalizer.getItem(0), null, label + " getItem(0) empty");
  const alloc = inst.finalizerAllocations();
  assert.equal(alloc.pending, 0, label + " no pending finalizer allocation");
  assert.equal(alloc.finalized, 0, label + " no finalized finalizer allocation");
  assert.equal(inst.pendingRecords().length, 0, label + " no pending record");
  assert.equal(inst.sourceRecords().length, 0, label + " no source record");
  assert.equal(ctrl.popupMedia(tabId).length, 0, label + " no popup row");

  // Matching snapshot / tick cannot surface an orphan.
  if (method === "network") {
    ctrl.acceptPageSnapshot(opts.orphanSnapshot || florenSnapshot());
    await ctrl.tick(1_000_750);
  } else {
    await ctrl.tick(1_000_750);
  }
  assert.equal(finalizer.listFinalized().length, 0, label + " orphan listFinalized");
  assert.equal(
    finalizer._beginNetworkCalls,
    0,
    label + " orphan must not begin network"
  );
  assert.equal(inst.finalizerAllocations().pending, 0, label + " orphan pending");
  assert.equal(inst.finalizerAllocations().finalized, 0, label + " orphan finalized");
  // Token / publication / material browser effects stay at rejected baseline.
  assert.equal(fx.counts.randomToken, baseline.randomToken, label + " orphan token");
  assert.equal(
    fx.counts.publishDetection,
    baseline.publishDetection,
    label + " orphan publish"
  );
  assert.equal(fx.counts.postNative, baseline.postNative, label + " orphan native");
  assert.equal(
    fx.counts.downloadsDownload,
    baseline.downloadsDownload,
    label + " orphan download"
  );
  assert.equal(
    fx.counts.reportDiagnostic,
    baseline.reportDiagnostic,
    label + " orphan diagnostic"
  );
  assert.equal(
    fx.counts.isPopupSender,
    baseline.isPopupSender,
    label + " orphan isPopupSender"
  );
  assert.equal(
    fx.counts.getEffectiveDestinationDirectory,
    baseline.getEffectiveDestinationDirectory,
    label + " orphan getEffectiveDestinationDirectory"
  );
  assert.equal(ctrl.popupMedia(tabId).length, 0, label + " orphan popup");
  assert.equal(inst.pendingRecords().length, 0, label + " orphan pending records");
  assert.equal(inst.sourceRecords().length, 0, label + " orphan source records");
  assertRegistryIdle(inst, label + " orphan-phase");

  // Recovery: restore one-shot traps only when applicable.
  if (opts.restore) opts.restore(fx);
  const recoveryBaseline = snapshotEffectBaseline(fx);

  let okId;
  if (method === "network") {
    okId = ctrl.captureNetwork(
      opts.validInput ? opts.validInput() : validNetworkCapture()
    );
  } else {
    okId = ctrl.captureDomMedia(
      opts.validInput ? opts.validInput() : validDomCapture()
    );
  }
  const pendings = inst.pendingRecords();
  assert.ok(pendings.length >= 1, label + " recovery pending");
  const lastPending = pendings[pendings.length - 1];
  assertFirstObservableIds(okId, lastPending);
  assert.equal(lastPending.detectionId, 1, label + " recovery detectionId");

  // Recovery is allowed to increment clock/token/publish after rejected baseline.
  assert.ok(
    fx.counts.randomToken > recoveryBaseline.randomToken,
    label + " recovery mints token"
  );

  if (method === "network") {
    if (finalizer.listFinalized().length === 0) {
      assert.equal(
        fx.counts.publishDetection,
        recoveryBaseline.publishDetection,
        label + " network recovery still pending"
      );
      ctrl.acceptPageSnapshot(opts.recoverySnapshot || florenSnapshot());
    }
    assert.equal(
      fx.counts.publishDetection,
      recoveryBaseline.publishDetection + 1,
      label + " recovery publishes once"
    );
    assert.equal(fx.publishDetections[fx.publishDetections.length - 1].id, okId);
    assert.equal(finalizer.listFinalized().length, 1);
    assert.equal(finalizer.listFinalized()[0].detectionId, 1);
    ctrl.acceptPageSnapshot(opts.recoverySnapshot || florenSnapshot());
    await ctrl.tick(1_000_900);
    assert.equal(
      fx.counts.publishDetection,
      recoveryBaseline.publishDetection + 1,
      label + " recovery exactly once"
    );
    assert.equal(ctrl.popupMedia(tabId).length, 1);
    assert.equal(ctrl.popupMedia(tabId)[0].id, okId);
  } else {
    assert.equal(
      fx.counts.publishDetection,
      recoveryBaseline.publishDetection + 1,
      label + " DOM recovery publishes once"
    );
    assert.equal(fx.publishDetections[fx.publishDetections.length - 1].id, okId);
    assert.equal(finalizer.listFinalized().length, 1);
    assert.equal(finalizer.listFinalized()[0].detectionId, 1);
    assert.equal(ctrl.popupMedia(tabId).length, 1);
    assert.equal(ctrl.popupMedia(tabId)[0].id, okId);
  }

  return { inst, fx, ctrl, okId, threw };
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
  // Lease 2: unknown media fails generically without reading variants.
  {
    let unknownHits = 0;
    const hostileVariants = new Proxy([], {
      getOwnPropertyDescriptor() {
        unknownHits += 1;
        throw new Error("HOSTILE_SECRET_UNKNOWN_MEDIA_READ");
      },
      ownKeys() {
        unknownHits += 1;
        throw new Error("HOSTILE_SECRET_UNKNOWN_MEDIA_KEYS");
      },
      get() {
        unknownHits += 1;
        throw new Error("HOSTILE_SECRET_UNKNOWN_MEDIA_GET");
      },
    });
    assert.throws(
      () => ctrl.registerVariants("media-x", hostileVariants),
      (err) =>
        err instanceof TypeError &&
        err.message === "invalid media variant registration"
    );
    assert.equal(unknownHits, 0, "unknown media must not inspect variants");
  }
  const jobs = ctrl.popupJobs();
  assert.ok(Array.isArray(jobs));
  assert.equal(jobs.length, 0);
  assertDeepFrozen(jobs, "popupJobs()");
  const jobs2 = ctrl.popupJobs();
  assert.notEqual(jobs, jobs2, "popupJobs must return a fresh array");

  // Async future stubs return a Promise before rejecting (never throw sync).
  const asyncStubs = [
    () => ctrl.requestFirefoxHandoff({}, {}),
    () => ctrl.cancel("j1"),
    () => ctrl.manualRetry("j1"),
    () => ctrl.helperDisconnected(),
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
  assert.equal(await ctrl.handleNativeMessage({}), false);
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
    "ProviderRegistry is constructed once and never cleared or snapshotted",
    async () => {
      const src = productionSource();
      const creates = src.match(/createProviderRegistry\s*\(/g) || [];
      assert.equal(creates.length, 1, "createProviderRegistry exactly once");
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
    "BA04 network media URL is required absolute HTTP(S) with preserved spelling",
    async () => {
      // Mutation caught: absent/empty/non-URL details.url falling through to
      // about:blank, Privacy non-generic whitespace errors, or normalizing
      // accepted URL spelling before private ephemeral retention.

      const ABSENT = Symbol("absent");
      const INHERITED = Symbol("inherited");

      function detailsWithUrl(url, extra) {
        const d = Object.assign({}, florenNetworkInput().details, extra || {});
        if (url === ABSENT) {
          delete d.url;
        } else if (url === INHERITED) {
          delete d.url;
          return Object.create(
            { url: "https://cdn.example/inherited-only.mp4" },
            Object.getOwnPropertyDescriptors(d)
          );
        } else {
          d.url = url;
        }
        return d;
      }

      // --- rejects: required URL grammar (fresh controller per row) ---
      const rejectCases = [];

      rejectCases.push({
        label: "absent details.url",
        build: () =>
          validNetworkCapture({ details: detailsWithUrl(ABSENT) }),
      });
      {
        const d = Object.assign({}, florenNetworkInput().details);
        Object.defineProperty(d, "url", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: undefined,
        });
        rejectCases.push({
          label: "own-data undefined url",
          build: () => validNetworkCapture({ details: d }),
        });
      }
      rejectCases.push({
        label: "own-data null url",
        build: () =>
          validNetworkCapture({ details: detailsWithUrl(null) }),
      });
      rejectCases.push({
        label: "empty url",
        build: () => validNetworkCapture({ details: detailsWithUrl("") }),
      });
      rejectCases.push({
        label: "whitespace-padded url",
        build: () =>
          validNetworkCapture({
            details: detailsWithUrl("  https://cdn.example/pad.mp4  "),
          }),
      });
      rejectCases.push({
        label: "blank whitespace url",
        build: () =>
          validNetworkCapture({ details: detailsWithUrl("   \t\n  ") }),
      });
      rejectCases.push({
        label: "query-only url",
        build: () =>
          validNetworkCapture({ details: detailsWithUrl("?token=x") }),
      });
      rejectCases.push({
        label: "fragment-only url",
        build: () =>
          validNetworkCapture({ details: detailsWithUrl("#clip") }),
      });
      rejectCases.push({
        label: "relative path url",
        build: () =>
          validNetworkCapture({
            details: detailsWithUrl("/relative/path.mp4"),
          }),
      });
      rejectCases.push({
        label: "arbitrary non-URL",
        build: () =>
          validNetworkCapture({
            details: detailsWithUrl("not a url at all"),
          }),
      });
      rejectCases.push({
        label: "ftp scheme",
        build: () =>
          validNetworkCapture({
            details: detailsWithUrl("ftp://cdn.example/a.mp4"),
          }),
      });
      rejectCases.push({
        label: "file scheme",
        build: () =>
          validNetworkCapture({
            details: detailsWithUrl("file:///tmp/a.mp4"),
          }),
      });
      rejectCases.push({
        label: "data scheme",
        build: () =>
          validNetworkCapture({
            details: detailsWithUrl("data:video/mp4;base64,AAA"),
          }),
      });
      rejectCases.push({
        label: "blob scheme",
        build: () =>
          validNetworkCapture({
            details: detailsWithUrl("blob:https://cdn.example/uuid"),
          }),
      });
      rejectCases.push({
        label: "C0 in url",
        build: () =>
          validNetworkCapture({
            details: detailsWithUrl("https://cdn.example/\u0001x.mp4"),
          }),
      });
      rejectCases.push({
        label: "DEL in url",
        build: () =>
          validNetworkCapture({
            details: detailsWithUrl("https://cdn.example/\u007fx.mp4"),
          }),
      });
      rejectCases.push({
        label: "C1 in url",
        build: () =>
          validNetworkCapture({
            details: detailsWithUrl("https://cdn.example/\u0085x.mp4"),
          }),
      });
      rejectCases.push({
        label: "boxed String url",
        build: () =>
          validNetworkCapture({
            details: detailsWithUrl(
              Object("https://cdn.example/boxed.mp4")
            ),
          }),
      });
      rejectCases.push({
        label: "number url",
        build: () =>
          validNetworkCapture({ details: detailsWithUrl(12345) }),
      });
      rejectCases.push({
        label: "object url",
        build: () =>
          validNetworkCapture({
            details: detailsWithUrl({ href: "https://cdn.example/o.mp4" }),
          }),
      });
      {
        const hits = { urlGet: 0 };
        const d = Object.assign({}, florenNetworkInput().details);
        Object.defineProperty(d, "url", {
          enumerable: true,
          configurable: true,
          get() {
            hits.urlGet += 1;
            throw new Error("HOSTILE_SECRET_URL_ACCESSOR");
          },
        });
        rejectCases.push({
          label: "accessor url",
          hits,
          build: () => validNetworkCapture({ details: d }),
        });
      }
      rejectCases.push({
        label: "inherited-only url",
        build: () =>
          validNetworkCapture({ details: detailsWithUrl(INHERITED) }),
      });
      {
        const hits = { toString: 0, valueOf: 0 };
        const hostile = {
          toString() {
            hits.toString += 1;
            return "https://HOSTILE_SECRET_toString.example/x.mp4";
          },
          valueOf() {
            hits.valueOf += 1;
            return "https://HOSTILE_SECRET_valueOf.example/x.mp4";
          },
        };
        rejectCases.push({
          label: "toString/valueOf trap url",
          hits,
          build: () =>
            validNetworkCapture({ details: detailsWithUrl(hostile) }),
        });
      }
      {
        const target = { url: "https://cdn.example/proxy.mp4" };
        const rev = Proxy.revocable(target, {});
        rev.revoke();
        rejectCases.push({
          label: "revoked Proxy url value",
          build: () =>
            validNetworkCapture({
              details: Object.assign({}, florenNetworkInput().details, {
                url: rev.proxy,
              }),
            }),
        });
      }
      {
        // Descriptor-safe contract may invoke getOwnPropertyDescriptor; it must
        // not invoke value getters/coercion and must not leak trap identity.
        const hits = { get: 0, toString: 0 };
        const hostileErr = new Error("HOSTILE_SECRET_URL_GOPD");
        const base = Object.assign({}, florenNetworkInput().details);
        delete base.url;
        const details = new Proxy(base, {
          getOwnPropertyDescriptor(t, prop) {
            if (prop === "url") throw hostileErr;
            return Reflect.getOwnPropertyDescriptor(t, prop);
          },
          get(t, prop, r) {
            if (prop === "url") {
              hits.get += 1;
              throw new Error("HOSTILE_SECRET_URL_GET");
            }
            return Reflect.get(t, prop, r);
          },
        });
        rejectCases.push({
          label: "getOwnPropertyDescriptor trap on details.url",
          hits,
          notSameAs: hostileErr,
          build: () => validNetworkCapture({ details }),
        });
      }
      {
        const rev = Proxy.revocable(
          Object.assign({}, florenNetworkInput().details, {
            url: "https://cdn.example/whole.mp4",
          }),
          {}
        );
        rev.revoke();
        rejectCases.push({
          label: "whole-details revoked Proxy",
          build: () => validNetworkCapture({ details: rev.proxy }),
        });
      }

      const urlRed = [];
      async function expectUrlReject(row) {
        try {
          await assertRejectedCaptureAtomic({
            label: row.label,
            method: "network",
            tabId: 42,
            hits: row.hits,
            notSameAs: row.notSameAs,
            run(ctrl) {
              ctrl.captureNetwork(row.build());
            },
          });
        } catch (err) {
          // Production gaps: still accepts, or rejects with non-generic text
          // (e.g. Privacy whitespace). Collect and continue so already-correct
          // rows still exercise the full helper + recovery.
          if (err && err.code === "ERR_ASSERTION") {
            urlRed.push(row.label + " → " + String(err.message).split("\n")[0]);
            return;
          }
          throw err;
        }
      }

      for (const row of rejectCases) {
        await expectUrlReject(row);
      }

      // Cross-realm boxed String url rejects; plain cross-realm primitives accept.
      {
        const realm = vm.createContext({
          Object,
          String,
          Number,
          Boolean,
          Array,
          undefined,
        });
        const boxed = vm.runInContext(
          'new String("https://cdn.example/cross-boxed.mp4")',
          realm
        );
        await expectUrlReject({
          label: "cross-realm boxed String url",
          build: () =>
            validNetworkCapture({
              details: Object.assign({}, florenNetworkInput().details, {
                url: boxed,
              }),
            }),
        });
      }

      // --- positive controls: exact spelling retained privately ---
      const acceptUrls = [
        "http://cdn.example/plain.mp4",
        "https://cdn.example/plain.mp4",
        "https://user:pass@cdn.example/cred.mp4",
        "https://[2001:db8::1]/media/v.mp4",
        "https://cdn.example:8443/port.mp4",
        "https://cdn.example/path/with%20space/a.mp4?q=1&x=%2F#frag-ok",
        "https://cdn.example/a.mp4?token=benign-query-value&exp=99",
      ];

      for (let i = 0; i < acceptUrls.length; i++) {
        const exact = acceptUrls[i];
        const inst = loadInstrumentedClassic();
        const fx = makeEffects();
        const ctrl = inst.api.createBackgroundAdapters(fx.options());
        const docId = "doc-url-accept-" + i;
        const mediaId = ctrl.captureNetwork(
          validNetworkCapture({
            details: Object.assign({}, florenNetworkInput().details, {
              url: exact,
              documentId: docId,
            }),
          })
        );
        assert.ok(isSafeOpaqueId(mediaId));
        assert.match(mediaId, /:1$/);
        const pendings = inst.pendingRecords();
        assert.equal(pendings.length, 1);
        assert.equal(
          pendings[0].ephemeral.mediaUrl,
          exact,
          "private ephemeral must retain exact signed spelling"
        );
        ctrl.acceptPageSnapshot(
          florenSnapshot({
            documentId: docId,
            candidates: [
              { kind: "visible-filename", value: "accept-" + i + ".mp4" },
            ],
          })
        );
        assert.equal(fx.counts.publishDetection, 1);
        const sources = inst.sourceRecords();
        assert.ok(sources.length >= 1);
        assert.equal(
          sources[sources.length - 1].ephemeral.mediaUrl,
          exact,
          "finalized private ephemeral retains exact spelling"
        );
        // Public surfaces never expose mediaUrl.
        assertNoSentinels(fx.publishDetections, "url-accept publish");
        assertNoSentinels(ctrl.popupMedia(42), "url-accept popup");
      }

      // Cross-realm plain details/hints with primitive strings still succeed.
      {
        const realm = vm.createContext({
          Object,
          String,
          Number,
          Boolean,
          Array,
          undefined,
        });
        const exact =
          "https://cross-realm.example:9443/v.mp4?q=benign#frag";
        const details = vm.runInContext(
          `({
            url: ${JSON.stringify(exact)},
            documentUrl: "https://florenfile.com/page",
            originUrl: "https://florenfile.com/page",
            tabId: 42,
            frameId: 0,
            documentId: "doc-cross-realm-plain",
            timeStamp: 1000000,
            responseHeaders: [{ name: "Content-Type", value: "video/mp4" }]
          })`,
          realm
        );
        const hints = vm.runInContext(
          `({
            topLevelUrlHint: "https://florenfile.com/page",
            frameOrigin: "https://florenfile.com"
          })`,
          realm
        );
        const inst = loadInstrumentedClassic();
        const fx = makeEffects();
        const ctrl = inst.api.createBackgroundAdapters(fx.options());
        const mediaId = ctrl.captureNetwork({
          details,
          hints,
          transport: { mediaKind: "direct", requestHeaders: null },
        });
        assert.match(mediaId, /:1$/);
        assert.equal(inst.pendingRecords()[0].ephemeral.mediaUrl, exact);
        ctrl.acceptPageSnapshot(
          florenSnapshot({ documentId: "doc-cross-realm-plain" })
        );
        assert.equal(fx.counts.publishDetection, 1);
        assert.equal(
          inst.sourceRecords()[0].ephemeral.mediaUrl,
          exact
        );
      }

      // Outer whitespace / control still reject after positive controls.
      await expectUrlReject({
        label: "leading whitespace after positives",
        build: () =>
          validNetworkCapture({
            details: detailsWithUrl(" https://cdn.example/x.mp4"),
          }),
      });
      await expectUrlReject({
        label: "trailing whitespace after positives",
        build: () =>
          validNetworkCapture({
            details: detailsWithUrl("https://cdn.example/x.mp4 "),
          }),
      });

      if (urlRed.length > 0) {
        assert.fail(
          "network media URL RED (" +
            urlRed.length +
            "): " +
            urlRed.join(" | ")
        );
      }
    }
  );

  await t.test(
    "BA04 present network hints require primitive strings",
    async () => {
      // Mutation caught: present null/undefined topLevelUrlHint or frameOrigin
      // treated as absence and still committing/publishing.

      const hintFields = ["topLevelUrlHint", "frameOrigin"];
      const hintRed = [];
      async function expectHintReject(label, run, extra) {
        try {
          await assertRejectedCaptureAtomic(
            Object.assign(
              {
                label,
                method: "network",
                run,
              },
              extra || {}
            )
          );
        } catch (err) {
          if (err && err.code === "ERR_ASSERTION") {
            hintRed.push(label + " → " + String(err.message).split("\n")[0]);
            return;
          }
          throw err;
        }
      }

      for (const field of hintFields) {
        const other =
          field === "topLevelUrlHint"
            ? { frameOrigin: "https://florenfile.com" }
            : { topLevelUrlHint: florenPageUrl() };

        await expectHintReject(field + " present undefined", (ctrl) => {
          const hints = Object.assign({}, other);
          Object.defineProperty(hints, field, {
            enumerable: true,
            configurable: true,
            writable: true,
            value: undefined,
          });
          ctrl.captureNetwork(validNetworkCapture({ hints }));
        });

        await expectHintReject(field + " present null", (ctrl) => {
          const hints = Object.assign({}, other);
          hints[field] = null;
          ctrl.captureNetwork(validNetworkCapture({ hints }));
        });

        await expectHintReject(field + " boxed String", (ctrl) => {
          const hints = Object.assign({}, other);
          hints[field] = Object("https://florenfile.com");
          ctrl.captureNetwork(validNetworkCapture({ hints }));
        });

        await expectHintReject(field + " number", (ctrl) => {
          const hints = Object.assign({}, other);
          hints[field] = 99;
          ctrl.captureNetwork(validNetworkCapture({ hints }));
        });

        await expectHintReject(field + " object", (ctrl) => {
          const hints = Object.assign({}, other);
          hints[field] = { href: "https://florenfile.com" };
          ctrl.captureNetwork(validNetworkCapture({ hints }));
        });

        {
          const hits = { get: 0 };
          await expectHintReject(
            field + " accessor",
            (ctrl) => {
              const hints = Object.assign({}, other);
              Object.defineProperty(hints, field, {
                enumerable: true,
                configurable: true,
                get() {
                  hits.get += 1;
                  throw new Error("HOSTILE_SECRET_HINT_ACCESSOR_" + field);
                },
              });
              ctrl.captureNetwork(validNetworkCapture({ hints }));
            },
            { hits }
          );
        }

        {
          const hits = { toString: 0, valueOf: 0 };
          await expectHintReject(
            field + " coercion traps",
            (ctrl) => {
              const hints = Object.assign({}, other);
              hints[field] = {
                toString() {
                  hits.toString += 1;
                  return "https://HOSTILE_SECRET_hint.example";
                },
                valueOf() {
                  hits.valueOf += 1;
                  return "https://HOSTILE_SECRET_hint.example";
                },
              };
              ctrl.captureNetwork(validNetworkCapture({ hints }));
            },
            { hits }
          );
        }

        {
          const rev = Proxy.revocable({ v: "https://florenfile.com" }, {});
          rev.revoke();
          await expectHintReject(field + " revoked Proxy value", (ctrl) => {
            const hints = Object.assign({}, other);
            hints[field] = rev.proxy;
            ctrl.captureNetwork(validNetworkCapture({ hints }));
          });
        }

        {
          // getOwnPropertyDescriptor may run under the descriptor-safe contract;
          // value getters must not.
          const hits = { get: 0 };
          const hostileErr = new Error("HOSTILE_SECRET_HINT_GOPD_" + field);
          await expectHintReject(
            field + " getOwnPropertyDescriptor trap",
            (ctrl) => {
              const base = Object.assign({}, other);
              const hints = new Proxy(base, {
                getOwnPropertyDescriptor(t, prop) {
                  if (prop === field) throw hostileErr;
                  return Reflect.getOwnPropertyDescriptor(t, prop);
                },
                get(t, prop, r) {
                  if (prop === field) {
                    hits.get += 1;
                    throw new Error("HOSTILE_SECRET_HINT_GET_" + field);
                  }
                  return Reflect.get(t, prop, r);
                },
              });
              ctrl.captureNetwork(validNetworkCapture({ hints }));
            },
            { hits, notSameAs: hostileErr }
          );
        }

        // C0 / DEL / C1 already covered elsewhere; keep field-local locks green.
        for (const [tag, ch] of [
          ["C0", "\u0001"],
          ["DEL", "\u007f"],
          ["C1", "\u0085"],
        ]) {
          await expectHintReject(field + " " + tag, (ctrl) => {
            const hints = Object.assign({}, other);
            hints[field] =
              field === "topLevelUrlHint"
                ? "https://site.example/" + ch + "path"
                : "https://site.example" + ch;
            ctrl.captureNetwork(validNetworkCapture({ hints }));
          });
        }
      }

      // Absence may default — empty hints object still commits.
      {
        const inst = loadInstrumentedClassic();
        const fx = makeEffects();
        const ctrl = inst.api.createBackgroundAdapters(fx.options());
        const id = ctrl.captureNetwork(
          validNetworkCapture({ hints: {} })
        );
        assert.match(id, /:1$/);
        ctrl.acceptPageSnapshot(florenSnapshot());
        assert.equal(fx.counts.publishDetection, 1);
        assert.equal(ctrl.popupMedia(42).length, 1);
      }

      // Ordinary valid primitive strings stay green.
      {
        const inst = loadInstrumentedClassic();
        const fx = makeEffects();
        const ctrl = inst.api.createBackgroundAdapters(fx.options());
        const id = ctrl.captureNetwork(
          validNetworkCapture({
            hints: {
              topLevelUrlHint: "https://florenfile.com/ok-hint",
              frameOrigin: "https://florenfile.com",
            },
          })
        );
        assert.match(id, /:1$/);
        ctrl.acceptPageSnapshot(florenSnapshot());
        assert.equal(fx.counts.publishDetection, 1);
      }

      if (hintRed.length > 0) {
        assert.fail(
          "present network hints RED (" +
            hintRed.length +
            "): " +
            hintRed.join(" | ")
        );
      }
    }
  );

  await t.test(
    "BA04 tabId and frameId preserve exact signed-int32 identity",
    async () => {
      // Mutation caught: accepting safe integers above signed int32 so the
      // real finalizer `| 0` truncates immutable capture identity (e.g.
      // 4294967296 → tab 0). Do not mock away `| 0`.

      const INT32_MAX = 0x7fffffff;
      const rejectIds = [
        0x80000000,
        0xffffffff,
        0x100000000,
        Number.MAX_SAFE_INTEGER,
      ];
      const nonIntegral = [
        { label: "NaN", value: Number.NaN },
        { label: "Infinity", value: Number.POSITIVE_INFINITY },
        { label: "fraction", value: 1.5 },
        { label: "negative", value: -1 },
      ];
      const idRed = [];
      async function expectIdReject(label, method, tabId, run) {
        try {
          await assertRejectedCaptureAtomic({
            label,
            method,
            tabId,
            run,
          });
        } catch (err) {
          if (err && err.code === "ERR_ASSERTION") {
            idRed.push(label + " → " + String(err.message).split("\n")[0]);
            return;
          }
          throw err;
        }
      }

      // --- network details.tabId / details.frameId ---
      for (const field of ["tabId", "frameId"]) {
        for (const bad of rejectIds) {
          await expectIdReject(
            "network details." + field + " " + String(bad),
            "network",
            42,
            (ctrl) => {
              const details = Object.assign({}, florenNetworkInput().details, {
                [field]: bad,
              });
              // Keep the other identity field valid and in-range.
              if (field === "tabId") details.frameId = 0;
              else details.tabId = 42;
              ctrl.captureNetwork(validNetworkCapture({ details }));
            }
          );
        }
        for (const row of nonIntegral) {
          await expectIdReject(
            "network details." + field + " " + row.label,
            "network",
            42,
            (ctrl) => {
              const details = Object.assign({}, florenNetworkInput().details, {
                [field]: row.value,
              });
              if (field === "tabId") details.frameId = 0;
              else details.tabId = 42;
              ctrl.captureNetwork(validNetworkCapture({ details }));
            }
          );
        }
      }

      // --- DOM snapshot.tabId / snapshot.frameId ---
      for (const field of ["tabId", "frameId"]) {
        for (const bad of rejectIds) {
          await expectIdReject(
            "DOM snapshot." + field + " " + String(bad),
            "dom",
            70,
            (ctrl) => {
              const snapshot = Object.assign({}, validDomCapture().snapshot, {
                [field]: bad,
              });
              if (field === "tabId") snapshot.frameId = 0;
              else snapshot.tabId = 70;
              ctrl.captureDomMedia(validDomCapture({ snapshot }));
            }
          );
        }
        for (const row of nonIntegral) {
          await expectIdReject(
            "DOM snapshot." + field + " " + row.label,
            "dom",
            70,
            (ctrl) => {
              const snapshot = Object.assign({}, validDomCapture().snapshot, {
                [field]: row.value,
              });
              if (field === "tabId") snapshot.frameId = 0;
              else snapshot.tabId = 70;
              ctrl.captureDomMedia(validDomCapture({ snapshot }));
            }
          );
        }
      }

      // --- accepted boundaries: 0 and 0x7fffffff, exact identity ---
      async function assertNetworkIdentity(tabId, frameId, docSuffix) {
        const inst = loadInstrumentedClassic();
        const fx = makeEffects();
        const ctrl = inst.api.createBackgroundAdapters(fx.options());
        const docId = "doc-id-net-" + docSuffix;
        const mediaId = ctrl.captureNetwork(
          validNetworkCapture({
            details: Object.assign({}, florenNetworkInput().details, {
              tabId,
              frameId,
              documentId: docId,
              url: "https://cdn.example/id-" + docSuffix + ".mp4",
            }),
          })
        );
        assert.match(mediaId, /:1$/);
        ctrl.acceptPageSnapshot(
          florenSnapshot({
            documentId: docId,
            tabId,
            frameId,
            candidates: [
              { kind: "visible-filename", value: "id-" + docSuffix + ".mp4" },
            ],
          })
        );
        assert.equal(fx.counts.publishDetection, 1);
        const sources = inst.sourceRecords();
        assert.ok(sources.length >= 1);
        const src = sources[sources.length - 1];
        assert.equal(
          src.sourceContext.tabId,
          tabId,
          "network sourceContext.tabId exact"
        );
        assert.equal(
          src.sourceContext.frameId,
          frameId,
          "network sourceContext.frameId exact"
        );
        // Popup rows do not expose frameId; lookup uses exact accepted tab ID.
        const pop = ctrl.popupMedia(tabId);
        assert.equal(pop.length, 1);
        assert.equal(pop[0].id, mediaId);
        assert.equal(
          Object.prototype.hasOwnProperty.call(pop[0], "frameId"),
          false
        );
        return { inst, fx, ctrl, mediaId, src };
      }

      async function assertDomIdentity(tabId, frameId, docSuffix) {
        const inst = loadInstrumentedClassic();
        const fx = makeEffects();
        const ctrl = inst.api.createBackgroundAdapters(fx.options());
        const mediaId = ctrl.captureDomMedia(
          validDomCapture({
            mediaUrl: "https://cdn.example/dom-id-" + docSuffix + ".mp4",
            snapshot: {
              documentId: "doc-id-dom-" + docSuffix,
              tabId,
              frameId,
              pageUrl: "https://site.example/watch",
              topLevelPageUrl: "https://site.example/watch",
              documentNonce: "n-id-" + docSuffix,
              candidates: [
                {
                  kind: "visible-filename",
                  value: "dom-id-" + docSuffix + ".mp4",
                },
              ],
              capturedAt: "2026-08-12T12:00:00.000Z",
            },
          })
        );
        assert.match(mediaId, /:1$/);
        assert.equal(fx.counts.publishDetection, 1);
        const sources = inst.sourceRecords();
        assert.ok(sources.length >= 1);
        const src = sources[sources.length - 1];
        assert.equal(src.sourceContext.tabId, tabId, "DOM tabId exact");
        assert.equal(src.sourceContext.frameId, frameId, "DOM frameId exact");
        const pop = ctrl.popupMedia(tabId);
        assert.equal(pop.length, 1);
        assert.equal(pop[0].id, mediaId);
        assert.equal(
          Object.prototype.hasOwnProperty.call(pop[0], "frameId"),
          false
        );
        return { mediaId, src };
      }

      // tabId / frameId independently at 0 and INT32_MAX.
      await assertNetworkIdentity(0, 0, "t0-f0");
      await assertNetworkIdentity(0, INT32_MAX, "t0-fmax");
      await assertNetworkIdentity(INT32_MAX, 0, "tmax-f0");
      await assertNetworkIdentity(INT32_MAX, INT32_MAX, "tmax-fmax");
      await assertDomIdentity(0, 0, "t0-f0");
      await assertDomIdentity(0, INT32_MAX, "t0-fmax");
      await assertDomIdentity(INT32_MAX, 0, "tmax-f0");
      await assertDomIdentity(INT32_MAX, INT32_MAX, "tmax-fmax");

      if (idRed.length > 0) {
        assert.fail(
          "tabId/frameId RED (" + idRed.length + "): " + idRed.join(" | ")
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

// ---------------------------------------------------------------------------
// BA05 / BA06 helpers — Lease 2 variant registration + privacy projection
// ---------------------------------------------------------------------------

const VARIANT_REG_MSG = "invalid media variant registration";

const VARIANT_SENTINELS = Object.freeze([
  "SECRET_SIGNED_QUERY_XYZ",
  "SECRET_COOKIE_ABC",
  "SECRET_AUTH_BEARER_TOKEN",
  "SECRET_REFERER_PATH",
  "SECRET_PAGE_PATH",
  "SECRET_MEDIA_ORIGIN_HOST",
  "SECRET_VARIANT_USERINFO",
  "SECRET_VARIANT_QUERY",
  "SECRET_VARIANT_FRAGMENT",
  "SECRET_CALLER_VARIANT_ID",
  "SECRET_CALLER_PROVIDER",
  "SECRET_OVERRIDE_URL",
  "SECRET_UNSAFE_LABEL",
  "SECRET_HOSTILE_TRAP_MSG",
  "SECRET_PRIVACY_FAIL",
  "hostilesecret-cause",
]);

function assertVariantRegError(err, opts) {
  assert.ok(err instanceof TypeError, "expected TypeError, got " + err);
  assert.equal(err.name, "TypeError");
  assert.equal(err.message, VARIANT_REG_MSG);
  assert.equal(
    Object.prototype.hasOwnProperty.call(err, "cause") ? err.cause : undefined,
    undefined,
    "variant registration TypeError must not retain cause"
  );
  if (opts && opts.notSameAs != null) {
    assert.notEqual(err, opts.notSameAs, "must not rethrow hostile identity");
  }
  const blob = String(err.message) + "\n" + String(err.stack || "");
  for (const s of VARIANT_SENTINELS) {
    assert.equal(blob.includes(s), false, "error must not leak " + s);
  }
  assert.equal(
    /Cannot perform|revoked proxy|Proxy\s*handler|HOSTILE_SECRET|hostilesecret/i.test(
      blob
    ),
    false,
    "adapter error must not leak engine/trap text"
  );
}

function assertNoVariantSentinels(value, label) {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  for (const s of VARIANT_SENTINELS) {
    assert.equal(raw.includes(s), false, label + " must not contain " + s);
  }
  for (const s of SECRET_SENTINELS) {
    assert.equal(raw.includes(s), false, label + " must not contain " + s);
  }
  const forbidden = [
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
    "variantUrl",
    "sourceHandle",
  ];
  for (const name of forbidden) {
    assert.equal(
      raw.includes('"' + name + '"'),
      false,
      label + " must not expose field " + name
    );
  }
}

/** True foreign realm: host Object/Array not injected into the sandbox. */
function createForeignRealm() {
  const foreign = vm.runInNewContext(
    [
      "(function () {",
      "  function assign(dst, src) {",
      "    if (!src) return dst;",
      "    var keys = Object.keys(src);",
      "    for (var i = 0; i < keys.length; i++) dst[keys[i]] = src[keys[i]];",
      "    return dst;",
      "  }",
      "  return {",
      "    Array: Array,",
      "    Object: Object,",
      "    makeArray: function (items) {",
      "      var a = new Array(items.length);",
      "      for (var i = 0; i < items.length; i++) a[i] = items[i];",
      "      return a;",
      "    },",
      "    makeOrdinary: function (props) { return assign({}, props); },",
      "    makeNullProto: function (props) { return assign(Object.create(null), props); },",
      "    makeFunction: function () { return function foreignFn() { return 1; }; },",
      "    makeDate: function () { return new Date(0); },",
      "    makeMap: function () { return new Map(); },",
      "    makeSet: function () { return new Set(); },",
      "    makeTyped: function () { return new Uint8Array([1, 2]); },",
      "    makeClassInstance: function () {",
      "      function C() { this.x = 1; }",
      "      return new C();",
      "    },",
      "    makeCustomProto: function () {",
      "      function C() {}",
      "      C.prototype = { marker: 'custom-proto', enumerableMarker: true };",
      "      return new C();",
      "    },",
      "    makeNullRootCustom: function () {",
      "      var p = Object.create(null);",
      "      p.marker = 'null-root';",
      "      function C() {}",
      "      C.prototype = p;",
      "      return new C();",
      "    }",
      "  };",
      "})()",
    ].join("\n"),
    Object.create(null)
  );
  assert.notEqual(foreign.Array, Array, "foreign Array intrinsic");
  assert.notEqual(foreign.Object, Object, "foreign Object intrinsic");
  return foreign;
}

/**
 * Classic-script load with Privacy + Map instrumentation for variant binding.
 * Privacy.createEphemeral delegates to the real factory and records exact args
 * plus distinct returned private handle objects.
 */
function loadVariantInstrumentedClassic(hooks) {
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

  const registryHits = {
    observe: 0,
    lookup: 0,
    clear: 0,
    snapshot: 0,
    create: 0,
  };
  const RealPR = root.McProviderRegistry;
  const realCreatePR = RealPR.createProviderRegistry;
  root.McProviderRegistry = {
    normalizeOrigin: RealPR.normalizeOrigin,
    normalizeProviderKey: RealPR.normalizeProviderKey,
    createProviderRegistry() {
      registryHits.create += 1;
      const reg = realCreatePR.call(RealPR);
      return {
        observe(mediaOrigin, providerKey) {
          registryHits.observe += 1;
          return reg.observe(mediaOrigin, providerKey);
        },
        lookup(mediaOrigin) {
          registryHits.lookup += 1;
          return reg.lookup(mediaOrigin);
        },
        clear() {
          registryHits.clear += 1;
          return reg.clear();
        },
        snapshot() {
          registryHits.snapshot += 1;
          return reg.snapshot();
        },
      };
    },
  };

  const privacyCalls = [];
  const ephemeralHandles = [];
  const RealPrivacy = root.McPrivacy;
  const realCreateEph = RealPrivacy.createEphemeral;
  root.McPrivacy = {
    createEphemeral(mediaUrl, requestHeaders) {
      privacyCalls.push({
        mediaUrl: mediaUrl,
        requestHeaders: requestHeaders,
      });
      if (hooks && typeof hooks.onEphemeral === "function") {
        hooks.onEphemeral(mediaUrl, requestHeaders, privacyCalls.length);
      }
      const handle = realCreateEph.call(RealPrivacy, mediaUrl, requestHeaders);
      ephemeralHandles.push(handle);
      return handle;
    },
    projectSafeHistory: RealPrivacy.projectSafeHistory,
    projectPopupJob: RealPrivacy.projectPopupJob,
    redactUrlForLog: RealPrivacy.redactUrlForLog,
    assertNoSentinels: RealPrivacy.assertNoSentinels,
    clearEphemeralOnTerminal: RealPrivacy.clearEphemeralOnTerminal,
  };

  vm.runInNewContext(code, sandbox, { filename: abs });
  assert.equal(typeof root.McBackgroundAdapters, "object");

  return {
    api: root.McBackgroundAdapters,
    trackedMaps,
    registryHits,
    privacyCalls,
    ephemeralHandles,
  };
}

function assertRegistryDormant(registryHits, label) {
  const prefix = label ? label + " " : "";
  assert.equal(
    registryHits.observe,
    registryHits.lookup,
    prefix + "registry observe/lookup balance"
  );
  assert.equal(registryHits.clear, 0, prefix + "registry clear");
  assert.equal(registryHits.snapshot, 0, prefix + "registry snapshot");
}

function assertPrivateEphemeralHandle(handle, expectedUrl, label) {
  assert.ok(handle && typeof handle === "object", label + " handle object");
  assert.ok(Object.isFrozen(handle), label + " handle frozen");
  const enumKeys = Object.keys(handle);
  assert.equal(enumKeys.includes("mediaUrl"), false, label + " mediaUrl non-enum");
  assert.equal(enumKeys.includes("requestHeaders"), false, label + " headers non-enum");
  assert.equal(
    Object.prototype.propertyIsEnumerable.call(handle, "mediaUrl"),
    false,
    label + " mediaUrl not enumerable"
  );
  assert.equal(handle.mediaUrl, expectedUrl, label + " exact private URL");
  assert.equal(
    JSON.stringify(handle),
    "{}",
    label + " handle public-serializes empty"
  );
}

/**
 * Scan test-private TrackingMap._sets for Lease-2 ownership shapes after a bind.
 * Maps alone do not prove source control flow — paired with structural source scan.
 * Mutable Maps/arrays/in-flight booleans need not be frozen. Provider evidence is
 * covered by registry dormancy elsewhere, not here.
 */
function isRealmSafeMapLike(value) {
  return (
    value != null &&
    typeof value === "object" &&
    typeof value.get === "function" &&
    typeof value.has === "function" &&
    typeof value.size === "number"
  );
}

const SAFE_VARIANT_OWN_KEYS = new Set([
  "id",
  "label",
  "width",
  "height",
  "bandwidth",
  "mime",
]);
const POPUP_MEDIA_OWN_KEYS = ["id", "proposedFilename", "kind", "variants"];

/**
 * Exact frozen public-row correspondence: ordered own keys, data descriptors only
 * (no accessor invocation), matching flags, and Object.is values. Objects may be
 * nonidentical copies.
 */
function assertFrozenPublicFieldEquivalence(actual, expected, label) {
  assert.ok(actual && typeof actual === "object", label + " actual object");
  assert.ok(expected && typeof expected === "object", label + " expected object");
  assert.ok(Object.isFrozen(actual), label + " actual frozen");
  assert.ok(Object.isFrozen(expected), label + " expected frozen");
  const aKeys = Reflect.ownKeys(actual);
  const eKeys = Reflect.ownKeys(expected);
  assert.deepEqual(aKeys, eKeys, label + " ordered ownKeys");
  for (let i = 0; i < eKeys.length; i++) {
    const k = eKeys[i];
    const ad = Object.getOwnPropertyDescriptor(actual, k);
    const ed = Object.getOwnPropertyDescriptor(expected, k);
    assert.ok(ad, label + " actual descriptor " + String(k));
    assert.ok(ed, label + " expected descriptor " + String(k));
    const aIsData = Object.prototype.hasOwnProperty.call(ad, "value");
    const eIsData = Object.prototype.hasOwnProperty.call(ed, "value");
    assert.equal(aIsData, true, label + " actual data descriptor " + String(k));
    assert.equal(eIsData, true, label + " expected data descriptor " + String(k));
    assert.equal(
      Object.prototype.hasOwnProperty.call(ad, "get"),
      false,
      label + " actual not accessor " + String(k)
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(ed, "get"),
      false,
      label + " expected not accessor " + String(k)
    );
    assert.equal(ad.enumerable, ed.enumerable, label + " enumerable " + String(k));
    assert.equal(
      ad.configurable,
      ed.configurable,
      label + " configurable " + String(k)
    );
    assert.equal(ad.writable, ed.writable, label + " writable " + String(k));
    assert.equal(ad.writable, false, label + " non-writable " + String(k));
    assert.equal(ad.configurable, false, label + " non-configurable " + String(k));
    assert.equal(
      Object.is(ad.value, ed.value),
      true,
      label + " Object.is value " + String(k)
    );
  }
}

function assertSafeVariantPublicShape(row, label) {
  assert.ok(row && typeof row === "object", label + " row object");
  assert.ok(Object.isFrozen(row), label + " row frozen");
  const keys = Reflect.ownKeys(row);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    assert.equal(typeof k, "string", label + " string key");
    assert.equal(
      SAFE_VARIANT_OWN_KEYS.has(k),
      true,
      label + " unexpected own key " + String(k)
    );
    const d = Object.getOwnPropertyDescriptor(row, k);
    assert.ok(d, label + " descriptor " + k);
    assert.equal(
      Object.prototype.hasOwnProperty.call(d, "value"),
      true,
      label + " data descriptor " + k
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(d, "get"),
      false,
      label + " not accessor " + k
    );
    assert.equal(d.writable, false, label + " non-writable " + k);
    assert.equal(d.configurable, false, label + " non-configurable " + k);
    assert.equal(
      d.value !== null && typeof d.value === "object",
      false,
      label + " no object-valued ownership field " + k
    );
  }
  assert.equal(
    Object.prototype.hasOwnProperty.call(row, "url"),
    false,
    label + " no url key"
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(row, "sourceHandle"),
    false,
    label + " no sourceHandle key"
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(row, "mediaUrl"),
    false,
    label + " no mediaUrl key"
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(row, "safeProjection"),
    false,
    label + " no safeProjection key"
  );
}

function assertVariantOwnershipMaps(
  inst,
  mediaId,
  rows,
  expectedUrls,
  popupSurface,
  label
) {
  const prefix = label ? label + " " : "";
  assert.ok(Array.isArray(rows) && rows.length > 0, prefix + "rows present");
  const n = rows.length;
  const rowIds = rows.map((r) => r.id);
  for (let i = 0; i < n; i++) {
    assert.ok(typeof rowIds[i] === "string" && rowIds[i].length > 0, prefix + "row id");
  }
  assert.ok(typeof mediaId === "string" && mediaId.length > 0, prefix + "mediaId");

  // Independently supplied original URL sequence — never derived from private output.
  assert.ok(Array.isArray(expectedUrls), prefix + "expectedUrls is Array");
  assert.equal(expectedUrls.length, n, prefix + "expectedUrls length exact N");
  for (let i = 0; i < n; i++) {
    assert.equal(
      typeof expectedUrls[i],
      "string",
      prefix + "expectedUrls[" + i + "] primitive string"
    );
    assert.equal(
      expectedUrls[i] !== null &&
        typeof expectedUrls[i] === "string" &&
        (typeof expectedUrls[i] !== "object"),
      true,
      prefix + "expectedUrls[" + i + "] not boxed"
    );
  }

  assert.ok(Array.isArray(popupSurface), prefix + "popup surface array");

  const orderedHits = [];
  const byIdHits = [];

  for (const m of inst.trackedMaps) {
    assert.ok(Array.isArray(m._sets), prefix + "TrackingMap._sets log");
    for (const entry of m._sets) {
      const k = entry.key;
      const v = entry.value;
      if (v == null) continue;

      // Primitive string values first so ownership-log branch is reachable before
      // any typeof !== "object" skip. Ownership exactness is proven separately.
      if (typeof v === "string") {
        continue;
      }
      if (typeof v === "boolean") {
        // in-flight marker values may be booleans — not required frozen
        continue;
      }
      if (typeof v !== "object") continue;

      if (Array.isArray(v)) {
        // mediaId -> ordered array of exactly N immutable private records
        if (k === mediaId && v.length === n) {
          let ok = true;
          for (let i = 0; i < n; i++) {
            const r = v[i];
            if (
              !r ||
              typeof r !== "object" ||
              !Object.prototype.hasOwnProperty.call(r, "safeProjection") ||
              !Object.prototype.hasOwnProperty.call(r, "sourceHandle") ||
              !r.safeProjection ||
              !r.sourceHandle ||
              typeof r.safeProjection !== "object" ||
              r.safeProjection.id !== rowIds[i]
            ) {
              ok = false;
              break;
            }
          }
          if (ok) orderedHits.push({ map: m, key: k, value: v });
        }
        continue;
      }

      const keys = Object.keys(v).slice().sort();
      // Finalizer/pending/source Lease-1 shapes — allowed evidence, not variant ownership.
      if (
        (keys.includes("event") && keys.includes("deadline")) ||
        (keys.includes("detectionId") && keys.includes("mediaUrl")) ||
        (keys.includes("mediaId") &&
          keys.includes("proposedFilename") &&
          keys.includes("mediaKind") &&
          !keys.includes("safeProjection"))
      ) {
        continue;
      }

      // mediaId -> realm-safe Map-like of variant id -> same private record.
      // Classify via get/has/size only — never host-realm constructor checks.
      if (isRealmSafeMapLike(v) && k === mediaId && v.size === n) {
        let ok = true;
        const mapped = [];
        for (let i = 0; i < n; i++) {
          const id = rowIds[i];
          if (!v.has(id)) {
            ok = false;
            break;
          }
          const r = v.get(id);
          if (
            !r ||
            typeof r !== "object" ||
            !Object.prototype.hasOwnProperty.call(r, "safeProjection") ||
            !Object.prototype.hasOwnProperty.call(r, "sourceHandle") ||
            !r.safeProjection ||
            !r.sourceHandle ||
            typeof r.safeProjection !== "object" ||
            r.safeProjection.id !== id
          ) {
            ok = false;
            break;
          }
          mapped.push(r);
        }
        if (ok) byIdHits.push({ map: m, key: k, inner: v, records: mapped });
      }
    }
  }

  assert.equal(orderedHits.length >= 1, true, prefix + "mediaId-keyed ordered records");
  assert.equal(byIdHits.length >= 1, true, prefix + "mediaId-keyed by-id Map-like");

  const ordered = orderedHits[0].value;
  assert.equal(ordered.length, n, prefix + "ordered length exact N");
  const byId = byIdHits[0];
  assert.equal(byId.inner.size, n, prefix + "by-id size exact N");

  // Same corresponding private record identity across ordered + by-id.
  for (let i = 0; i < n; i++) {
    assert.equal(
      ordered[i],
      byId.inner.get(rowIds[i]),
      prefix + "ordered/byId private record identity " + i
    );
  }

  // Exact ownership log on a single TrackingMap: relevance solely by rowId key
  // membership (never by value/mediaId). Exact pair count N and unique-key count N
  // must hold before any value assertion; longer duplicate logs fail.
  let ownerHit = null;
  for (const m of inst.trackedMaps) {
    const relevant = [];
    for (const entry of m._sets) {
      if (typeof entry.key === "string" && rowIds.indexOf(entry.key) !== -1) {
        relevant.push({ key: entry.key, value: entry.value });
      }
    }
    const uniqueKeys = new Set();
    for (let i = 0; i < relevant.length; i++) {
      uniqueKeys.add(relevant[i].key);
    }
    if (relevant.length !== n || uniqueKeys.size !== n) {
      continue;
    }
    let everyIdOnce = true;
    for (let i = 0; i < n; i++) {
      if (!uniqueKeys.has(rowIds[i])) {
        everyIdOnce = false;
        break;
      }
    }
    if (!everyIdOnce) continue;
    // Counts established — only now may values equal mediaId.
    let valuesOk = true;
    for (let i = 0; i < relevant.length; i++) {
      if (relevant[i].value !== mediaId) {
        valuesOk = false;
        break;
      }
    }
    if (!valuesOk) continue;
    if (typeof m.get === "function" && typeof m.has === "function") {
      for (let i = 0; i < n; i++) {
        if (!m.has(rowIds[i]) || m.get(rowIds[i]) !== mediaId) {
          valuesOk = false;
          break;
        }
      }
    }
    if (!valuesOk) continue;
    ownerHit = { map: m, pairs: relevant };
    break;
  }
  assert.ok(ownerHit, prefix + "ownership Map exact rowId->mediaId log");
  assert.equal(ownerHit.pairs.length, n, prefix + "ownership pair count exact N");
  assert.equal(
    new Set(ownerHit.pairs.map((p) => p.key)).size,
    n,
    prefix + "ownership unique keys exact N"
  );

  const handles = [];
  for (let i = 0; i < n; i++) {
    const r = ordered[i];
    assert.ok(Object.isFrozen(r), prefix + "private record frozen " + i);
    assert.ok(
      Object.isFrozen(r.safeProjection),
      prefix + "safeProjection frozen " + i
    );
    // Full safe-projection correspondence to independently returned row (not id-only).
    assertFrozenPublicFieldEquivalence(
      r.safeProjection,
      rows[i],
      prefix + "safeProjection~rows[" + i + "]"
    );
    assertSafeVariantPublicShape(
      r.safeProjection,
      prefix + "safeProjection shape " + i
    );
    assertSafeVariantPublicShape(rows[i], prefix + "returned row shape " + i);
    // Independent original URL proof — never derive expected from the handle itself.
    assertPrivateEphemeralHandle(
      r.sourceHandle,
      expectedUrls[i],
      prefix + "record sourceHandle " + i
    );
    handles.push(r.sourceHandle);
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      assert.notEqual(
        handles[i],
        handles[j],
        prefix + "distinct source handles " + i + "/" + j
      );
    }
  }

  // Causal public-surface exclusion via independently obtained popup surface.
  const popupMatches = [];
  for (let i = 0; i < popupSurface.length; i++) {
    const row = popupSurface[i];
    if (row && row.id === mediaId) popupMatches.push(row);
  }
  assert.equal(
    popupMatches.length,
    1,
    prefix + "exactly one popup media row for mediaId"
  );
  const popRow = popupMatches[0];
  assert.deepEqual(
    Reflect.ownKeys(popRow),
    POPUP_MEDIA_OWN_KEYS,
    prefix + "popup media own-key list"
  );
  assert.ok(Object.isFrozen(popRow), prefix + "popup media row frozen");
  for (let i = 0; i < POPUP_MEDIA_OWN_KEYS.length; i++) {
    const k = POPUP_MEDIA_OWN_KEYS[i];
    const d = Object.getOwnPropertyDescriptor(popRow, k);
    assert.ok(d, prefix + "popup desc " + k);
    assert.equal(
      Object.prototype.hasOwnProperty.call(d, "value"),
      true,
      prefix + "popup data descriptor " + k
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(d, "get"),
      false,
      prefix + "popup not accessor " + k
    );
    assert.equal(d.writable, false, prefix + "popup non-writable " + k);
    assert.equal(d.configurable, false, prefix + "popup non-configurable " + k);
  }
  assert.ok(Array.isArray(popRow.variants), prefix + "popup variants array");
  assert.equal(popRow.variants.length, n, prefix + "popup variants length exact N");
  assert.ok(Object.isFrozen(popRow.variants), prefix + "popup variants frozen");
  for (let i = 0; i < n; i++) {
    assertFrozenPublicFieldEquivalence(
      popRow.variants[i],
      rows[i],
      prefix + "popup variant~rows[" + i + "]"
    );
    assertSafeVariantPublicShape(
      popRow.variants[i],
      prefix + "popup variant shape " + i
    );
  }

  // Complete public JSON: no independently supplied private URLs or private keys.
  // JSON serializes a Map as {}; do not treat toString Map tags as ownership evidence.
  const rowsJson = JSON.stringify(rows);
  const popupJson = JSON.stringify(popupSurface);
  const privateKeys = [
    "sourceHandle",
    "mediaUrl",
    "safeProjection",
    "requestHeaders",
  ];
  for (let i = 0; i < privateKeys.length; i++) {
    const pk = privateKeys[i];
    assert.equal(rowsJson.includes(pk), false, prefix + "rows JSON no " + pk);
    assert.equal(popupJson.includes(pk), false, prefix + "popup JSON no " + pk);
  }
  for (let i = 0; i < n; i++) {
    assert.equal(
      rowsJson.includes(expectedUrls[i]),
      false,
      prefix + "rows omit independent url " + i
    );
    assert.equal(
      popupJson.includes(expectedUrls[i]),
      false,
      prefix + "popup omit independent url " + i
    );
    assert.equal(
      JSON.stringify(handles[i]),
      "{}",
      prefix + "handle serializes empty " + i
    );
  }
}

function variantNetworkCapture(docId, tabId, overrides) {
  const page =
    "https://site.example/SECRET_PAGE_PATH/watch?q=SECRET_SIGNED_QUERY_XYZ";
  const base = {
    details: {
      url:
        "https://SECRET_MEDIA_ORIGIN_HOST.cdn.example/base.mp4?token=SECRET_SIGNED_QUERY_XYZ",
      documentUrl: page,
      originUrl: page + "&ref=SECRET_REFERER_PATH",
      tabId: tabId,
      frameId: 0,
      documentId: docId,
      timeStamp: 1_000_000,
      responseHeaders: [{ name: "Content-Type", value: "video/mp4" }],
    },
    hints: {
      topLevelUrlHint: page,
      frameOrigin: "https://site.example",
    },
    transport: {
      mediaKind: "direct",
      requestHeaders: {
        Cookie: "session=SECRET_COOKIE_ABC",
        Authorization: "Bearer SECRET_AUTH_BEARER_TOKEN",
      },
    },
  };
  return Object.assign(base, overrides || {});
}

function variantNetworkSnapshot(docId, tabId, filename) {
  const page =
    "https://site.example/SECRET_PAGE_PATH/watch?q=SECRET_SIGNED_QUERY_XYZ";
  return {
    documentId: docId,
    tabId: tabId,
    frameId: 0,
    pageUrl: page,
    topLevelPageUrl: page,
    documentNonce: "n-" + docId,
    candidates: [{ kind: "visible-filename", value: filename || "safe-net.mp4" }],
    capturedAt: "2026-08-12T12:00:00.000Z",
  };
}

function variantDomCapture(docId, tabId, overrides) {
  const page =
    "https://dom.example/SECRET_PAGE_PATH/v?token=SECRET_SIGNED_QUERY_XYZ";
  const base = {
    mediaUrl:
      "https://SECRET_MEDIA_ORIGIN_HOST.cdn.example/dom.mp4?token=SECRET_SIGNED_QUERY_XYZ",
    mediaOrigin: "https://SECRET_MEDIA_ORIGIN_HOST.cdn.example",
    contentDisposition: null,
    referrerUrl: page + "#SECRET_REFERER_PATH",
    frameOrigin: "https://dom.example",
    ts: 1_000_100,
    snapshot: {
      documentId: docId,
      tabId: tabId,
      frameId: 0,
      pageUrl: page,
      topLevelPageUrl: page,
      documentNonce: "n-" + docId,
      candidates: [{ kind: "visible-filename", value: "safe-dom.mp4" }],
      capturedAt: "2026-08-12T12:00:01.000Z",
    },
    transport: {
      mediaKind: "direct",
      requestHeaders: {
        Cookie: "session=SECRET_COOKIE_ABC",
        Authorization: "Bearer SECRET_AUTH_BEARER_TOKEN",
      },
    },
  };
  return Object.assign(base, overrides || {});
}

function assertSafeVariantRow(row, expected) {
  const keys = Object.keys(row);
  assert.deepEqual(keys, expected.keys);
  assert.ok(isSafeOpaqueId(row.id));
  if (expected.label !== undefined) assert.equal(row.label, expected.label);
  if (expected.width !== undefined) assert.equal(row.width, expected.width);
  if (expected.height !== undefined) assert.equal(row.height, expected.height);
  if (expected.bandwidth !== undefined) {
    assert.equal(row.bandwidth, expected.bandwidth);
  }
  if (expected.mime !== undefined) assert.equal(row.mime, expected.mime);
  assert.equal(Object.prototype.hasOwnProperty.call(row, "url"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(row, "mediaId"), false);
  assertDeepFrozen(row, "variant row");
}

function assertFreshFrozenCopy(a, b, label) {
  assert.notEqual(a, b, label + " must be fresh array");
  assert.deepEqual(a, b);
  assertDeepFrozen(a, label + " a");
  assertDeepFrozen(b, label + " b");
  if (a.length > 0) {
    assert.notEqual(a[0], b[0], label + " rows must be fresh");
  }
}

function openOwnedMedia(ctrl, fx, opts) {
  const docId = opts.docId;
  const tabId = opts.tabId;
  const kind = opts.kind || "network";
  let mediaId;
  if (kind === "dom") {
    mediaId = ctrl.captureDomMedia(
      variantDomCapture(docId, tabId, opts.captureOverrides)
    );
    assert.equal(fx.counts.publishDetection >= 1, true);
  } else {
    mediaId = ctrl.captureNetwork(
      variantNetworkCapture(docId, tabId, opts.captureOverrides)
    );
    if (opts.finalize !== false) {
      ctrl.acceptPageSnapshot(
        variantNetworkSnapshot(docId, tabId, opts.filename)
      );
      assert.equal(
        fx.publishDetections.some((p) => p.id === mediaId),
        true,
        "intended media " + mediaId + " must be finalized before variants"
      );
    }
  }
  assert.ok(isSafeOpaqueId(mediaId));
  return mediaId;
}

async function enqueueNativeDirect(ctrl, fx, tag) {
  const tabId = 910;
  const mediaId = openOwnedMedia(ctrl, fx, {
    docId: "doc-native-" + tag,
    tabId,
    filename: tag + ".mp4",
  });
  const job = await ctrl.enqueueDownload(
    {
      type: "download",
      tabId,
      item: { id: mediaId, proposedFilename: tag + ".mp4" },
      userActionToken: "native-action-" + tag,
    },
    { tab: { id: tabId } }
  );
  return job;
}

test("native direct result switches an eligible attempt to one single command", async () => {
  const commands = [];
  const fx = makeEffects();
  const ctrl = loadAdapters().createBackgroundAdapters(
    fx.options({ postNative(command) { commands.push(command); } })
  );
  const job = await enqueueNativeDirect(ctrl, fx, "range-switch");
  const initial = commands[0];
  await ctrl.handleNativeMessage({
    type: "pget-result",
    id: job.id,
    attemptToken: initial.attemptToken,
    status: "failed",
    mode: "multi-range",
    failureCategory: "range_unsupported",
    partState: "empty",
  });
  assert.equal(commands.length, 2);
  assert.equal(commands[1].cmd, "pget-single");
  assert.equal(commands[1].id, job.id);
  assert.equal(commands[1].attemptToken, initial.attemptToken);
  assert.equal(fx.counts.downloadsDownload, 0);
  assert.equal(ctrl.popupJobs()[0].mode, "single-connection");
  await ctrl.handleNativeMessage({
    type: "pget-result", id: job.id, attemptToken: initial.attemptToken,
    status: "failed", mode: "multi-range", failureCategory: "range_unsupported", partState: "empty",
  });
  assert.equal(commands.length, 2);
});

test("native direct messages keep stale and wrong-mode results inert", async () => {
  const fx = makeEffects();
  const commands = [];
  const ctrl = loadAdapters().createBackgroundAdapters(fx.options({ postNative(c) { commands.push(c); } }));
  const job = await enqueueNativeDirect(ctrl, fx, "native-inert");
  const token = commands[0].attemptToken;
  const before = JSON.stringify(ctrl.popupJobs());
  const published = fx.counts.publishJobs;
  for (const message of [
    { type: "pget-result", id: job.id, attemptToken: "old-token", status: "completed", mode: "multi-range", partState: "committed" },
    { type: "pget-result", id: job.id, attemptToken: token, status: "completed", mode: "single-connection", partState: "committed" },
    { type: "pget-result", id: job.id, attemptToken: token, status: "bad", mode: "multi-range", partState: "committed" },
  ]) assert.equal(await ctrl.handleNativeMessage(message), false);
  assert.equal(JSON.stringify(ctrl.popupJobs()), before);
  assert.equal(fx.counts.publishJobs, published);
});

test("native direct progress and current limit acknowledgement have safe bounded effects", async () => {
  const commands = [];
  const fx = makeEffects();
  const ctrl = loadAdapters().createBackgroundAdapters(fx.options({ postNative(c) { commands.push(c); } }));
  const job = await enqueueNativeDirect(ctrl, fx, "native-progress");
  const start = commands[0];
  assert.equal(await ctrl.handleNativeMessage({ type: "pget-progress", id: job.id, attemptToken: start.attemptToken, bytes: 4, total: 10 }), true);
  const row = ctrl.popupJobs()[0];
  assert.deepEqual(row.progress, { done: 4, total: 10 });
  assert.equal(Object.isFrozen(row.progress), true);
  assert.equal(await ctrl.handleNativeMessage({ type: "pget-progress", id: job.id, attemptToken: start.attemptToken, bytes: 3, total: 10 }), false);
  assert.equal(await ctrl.handleNativeMessage({ type: "pget-limit-ack", id: job.id, attemptToken: start.attemptToken, providerGeneration: start.providerGeneration, maxConnections: start.maxConnections }), true);
  assert.equal(await ctrl.handleNativeMessage({ type: "pget-limit-ack", id: job.id, attemptToken: "old", providerGeneration: start.providerGeneration, maxConnections: start.maxConnections }), false);
  assert.equal(JSON.stringify(ctrl.popupJobs()).includes("https://"), false);
});

test("completed native direct result releases capacity and starts a queued peer", async () => {
  const commands = [];
  const fx = makeEffects();
  const ctrl = loadAdapters().createBackgroundAdapters(fx.options({ maxConcurrent: 1, postNative(c) { commands.push(c); } }));
  const first = await enqueueNativeDirect(ctrl, fx, "native-complete-a");
  const second = await enqueueNativeDirect(ctrl, fx, "native-complete-b");
  assert.equal(commands.length, 1);
  await ctrl.handleNativeMessage({ type: "pget-result", id: first.id, attemptToken: commands[0].attemptToken, status: "completed", mode: "multi-range", partState: "committed" });
  assert.equal(commands.length, 2);
  assert.equal(commands[1].id, second.id);
  assert.equal(fx.counts.downloadsDownload, 0);
});

test("timeout native direct result follows scheduler retry policy without Firefox", async () => {
  const commands = [];
  const fx = makeEffects();
  const ctrl = loadAdapters().createBackgroundAdapters(fx.options({ postNative(c) { commands.push(c); } }));
  const job = await enqueueNativeDirect(ctrl, fx, "native-timeout");
  await ctrl.handleNativeMessage({ type: "pget-result", id: job.id, attemptToken: commands[0].attemptToken, status: "failed", mode: "multi-range", failureCategory: "timeout", partState: "partial" });
  assert.equal(ctrl.popupJobs()[0].state, "retry_backoff");
  assert.equal(fx.counts.downloadsDownload, 0);
});

test("single native post failure preserves committed safe mode and replay fence", async () => {
  const commands = [];
  const effectError = new Error("single effect failure");
  const fx = makeEffects();
  const ctrl = loadAdapters().createBackgroundAdapters(fx.options({ postNative(c) { commands.push(c); if (c.cmd === "pget-single") return Promise.reject(effectError); } }));
  const job = await enqueueNativeDirect(ctrl, fx, "native-post-fail");
  const start = commands[0];
  await assert.rejects(ctrl.handleNativeMessage({ type: "pget-result", id: job.id, attemptToken: start.attemptToken, status: "failed", mode: "multi-range", failureCategory: "range_unsupported", partState: "empty" }), effectError);
  assert.equal(ctrl.popupJobs()[0].mode, "single-connection");
  await ctrl.handleNativeMessage({ type: "pget-result", id: job.id, attemptToken: start.attemptToken, status: "failed", mode: "multi-range", failureCategory: "range_unsupported", partState: "empty" });
  assert.equal(commands.filter((c) => c.cmd === "pget-single").length, 1);
});

// ---------------------------------------------------------------------------
// BA05 — opaque variant IDs bind original private URLs; replay cannot replace
// ---------------------------------------------------------------------------

test("BA05 — opaque variant IDs bind original private URLs and replay cannot replace the owned set", async (t) => {
  // Mutation caught: caller ID/URL authority, normalized URL, partial
  // registration, replay reads, same-media reentrant takeover, cross-media ID
  // collision, premature selection/enqueue, or secret projection.

  await t.test(
    "successful multi-variant bind, order, opaque IDs, Privacy spelling, popup",
    async () => {
      const foreign = createForeignRealm();
      const inst = loadVariantInstrumentedClassic();
      const fx = makeEffects();
      let variantTokenCalls = 0;
      const ctrl = inst.api.createBackgroundAdapters(
        fx.options({
          randomToken(ns) {
            fx.counts.randomToken += 1;
            if (ns === "variant") variantTokenCalls += 1;
            return "tok-repeat";
          },
        })
      );
      assert.equal(inst.registryHits.create, 1, "ProviderRegistry constructed once");
      assertRegistryDormant(inst.registryHits, "bind pre");

      const docId = "doc-ba05-bind";
      const tabId = 201;
      const mediaId = openOwnedMedia(ctrl, fx, {
        docId,
        tabId,
        filename: "bind-main.mp4",
      });
      assert.equal(
        ctrl.popupMedia(tabId).some((r) => r.id === mediaId),
        true
      );

      const urlA =
        "https://SECRET_VARIANT_USERINFO:pw@cdn-a.example/v.mp4?sig=SECRET_VARIANT_QUERY&exp=1#SECRET_VARIANT_FRAGMENT";
      const urlB =
        "https://cdn-b.example/other.mp4?token=SECRET_VARIANT_QUERY&x=2";
      const urlSpaced = "  https://x.example/a.mp4";
      // Independent original-URL sequence for ownership proof (not from outputs).
      const expectedBindUrls = [urlA, urlB, urlSpaced];

      // Counter-backed ignored caller authority — must never be read.
      const authorityHits = {
        id: 0,
        variantId: 0,
        variantUrl: 0,
        mediaId: 0,
        providerKey: 0,
        item: 0,
        pageUrl: 0,
        sourceContext: 0,
        headers: 0,
        Cookie: 0,
        Authorization: 0,
      };
      const entry0 = {
        url: urlA,
        label: "  1080p Safe  ",
        width: 1920,
        height: 1080,
        bandwidth: 5_000_000,
        mime: "video/mp4",
      };
      for (const name of Object.keys(authorityHits)) {
        Object.defineProperty(entry0, name, {
          enumerable: true,
          configurable: true,
          get() {
            authorityHits[name] += 1;
            throw new Error("SECRET_HOSTILE_TRAP_MSG authority-" + name);
          },
        });
      }

      const entry1 = foreign.makeOrdinary({
        url: urlB,
        label: "720p",
        width: 1280,
        height: 0, // unsafe optional — omit
        bandwidth: -1, // omit
        mime: "video/mp4; codecs=avc1", // unsafe MIME — omit
      });
      const entry2 = foreign.makeNullProto({
        url: urlSpaced,
        label: null,
        width: 640.5, // omit
        mime: "VIDEO/MP4",
      });

      const variants = foreign.makeArray([entry0, entry1, entry2]);
      assert.equal(Array.isArray(variants), true);
      assert.notEqual(variants.constructor, Array);

      const tokenBefore = fx.counts.randomToken;
      const ephBefore = inst.privacyCalls.length;
      const handlesBefore = inst.ephemeralHandles.length;
      const materialBefore = snapshotEffectBaseline(fx);
      const variantTokensBefore = variantTokenCalls;
      const popupBefore = ctrl.popupMedia(tabId).find((r) => r.id === mediaId);
      assert.equal(popupBefore.variants.length, 0);

      let err = null;
      let rows = null;
      try {
        rows = ctrl.registerVariants(mediaId, variants);
      } catch (e) {
        err = e;
      }

      // Authority getters and registry must stay dormant even when Lease-1 stubs.
      for (const name of Object.keys(authorityHits)) {
        assert.equal(authorityHits[name], 0, "ignored authority " + name);
      }
      assertRegistryDormant(inst.registryHits, "bind attempt");

      // Deliberately RED against Lease-1 stub; GREEN reaches full proofs.
      assert.equal(err, null, "registerVariants must succeed for owned media");
      assert.ok(Array.isArray(rows));
      assert.equal(rows.length, 3);
      assertDeepFrozen(rows, "registerVariants return");
      assert.equal(fx.counts.randomToken, tokenBefore + 3);
      assert.equal(variantTokenCalls, variantTokensBefore + 3);
      // Exactly 3 variant ephemerals (base capture already created one).
      const variantEph = inst.privacyCalls.slice(ephBefore);
      assert.equal(variantEph.length, 3);
      assert.equal(variantEph[0].mediaUrl, urlA);
      assert.equal(variantEph[1].mediaUrl, urlB);
      assert.equal(variantEph[2].mediaUrl, urlSpaced);
      for (const c of variantEph) {
        assert.equal(c.requestHeaders, null);
      }
      const variantHandles = inst.ephemeralHandles.slice(handlesBefore);
      assert.equal(variantHandles.length, 3);
      assert.notEqual(variantHandles[0], variantHandles[1]);
      assert.notEqual(variantHandles[1], variantHandles[2]);
      assert.notEqual(variantHandles[0], variantHandles[2]);
      assertPrivateEphemeralHandle(variantHandles[0], urlA, "bind handle0");
      assertPrivateEphemeralHandle(variantHandles[1], urlB, "bind handle1");
      assertPrivateEphemeralHandle(variantHandles[2], urlSpaced, "bind handle2");
      assertEffectBaseline(fx, {
        ...materialBefore,
        randomToken: materialBefore.randomToken + 3,
      }, "bind material");
      assert.equal(fx.counts.publishDetection, materialBefore.publishDetection);
      assert.equal(fx.counts.postNative, materialBefore.postNative);
      assert.equal(fx.counts.downloadsDownload, materialBefore.downloadsDownload);
      assert.equal(fx.counts.publishJobs, materialBefore.publishJobs);
      assert.equal(fx.counts.persistHistory, materialBefore.persistHistory);
      assert.equal(fx.counts.reportDiagnostic, materialBefore.reportDiagnostic);
      assert.equal(fx.counts.isPopupSender, materialBefore.isPopupSender);
      assert.equal(
        fx.counts.getEffectiveDestinationDirectory,
        materialBefore.getEffectiveDestinationDirectory
      );

      assertSafeVariantRow(rows[0], {
        keys: ["id", "label", "width", "height", "bandwidth", "mime"],
        label: "1080p Safe",
        width: 1920,
        height: 1080,
        bandwidth: 5_000_000,
        mime: "video/mp4",
      });
      assertSafeVariantRow(rows[1], {
        keys: ["id", "label", "width"],
        label: "720p",
        width: 1280,
      });
      assertSafeVariantRow(rows[2], {
        keys: ["id", "mime"],
        mime: "VIDEO/MP4",
      });
      assert.equal(new Set(rows.map((r) => r.id)).size, 3);
      for (const r of rows) {
        assert.notEqual(r.id, mediaId);
        assert.equal(r.id.includes("SECRET_CALLER_VARIANT_ID"), false);
        assert.match(r.id, /^variant:/);
      }
      // Contiguous suffix minting despite repeated token.
      assert.match(rows[0].id, /:1$/);
      assert.match(rows[1].id, /:2$/);
      assert.match(rows[2].id, /:3$/);

      const pop1 = ctrl.popupMedia(tabId);
      const pop2 = ctrl.popupMedia(tabId);
      assertFreshFrozenCopy(pop1, pop2, "popupMedia");
      const row = pop1.find((r) => r.id === mediaId);
      assert.ok(row);
      assert.equal(row.variants.length, 3);
      assert.deepEqual(
        row.variants.map((v) => v.id),
        rows.map((r) => r.id)
      );
      assertDeepFrozen(row.variants, "popup variants");
      assertNoVariantSentinels(rows, "registerVariants rows");
      assertNoVariantSentinels(pop1, "popup after bind");
      assertNoVariantSentinels(fx.publishDetections, "publish after bind");
      // No ignored-authority sentinels reach public/callback surfaces.
      assert.equal(
        JSON.stringify(rows).includes("SECRET_CALLER"),
        false
      );
      assertVariantOwnershipMaps(
        inst,
        mediaId,
        rows,
        expectedBindUrls,
        pop1,
        "bind maps"
      );
      assertRegistryDormant(inst.registryHits, "bind post");
    }
  );

  await t.test(
    "pending media keeps registered set invisible until finalize",
    async () => {
      const inst = loadVariantInstrumentedClassic();
      const fx = makeEffects();
      const ctrl = inst.api.createBackgroundAdapters(fx.options());
      const docId = "doc-ba05-pending";
      const tabId = 202;
      const mediaId = openOwnedMedia(ctrl, fx, {
        docId,
        tabId,
        finalize: false,
      });
      // Length only — classic-VM arrays are cross-realm vs host literals.
      assert.equal(ctrl.popupMedia(tabId).length, 0);
      const rows = ctrl.registerVariants(mediaId, [
        { url: "https://cdn.example/pend-a.mp4", label: "p" },
        { url: "https://cdn.example/pend-b.mp4", label: "q" },
      ]);
      assert.equal(rows.length, 2);
      assert.equal(ctrl.popupMedia(tabId).length, 0);
      ctrl.acceptPageSnapshot(
        variantNetworkSnapshot(docId, tabId, "pend-final.mp4")
      );
      assert.equal(
        fx.publishDetections.some((p) => p.id === mediaId),
        true
      );
      const pop = ctrl.popupMedia(tabId);
      assert.equal(pop.length, 1);
      assert.equal(pop[0].id, mediaId);
      assert.equal(pop[0].variants.length, 2);
      assert.deepEqual(
        pop[0].variants.map((v) => v.id),
        rows.map((r) => r.id)
      );
    }
  );

  await t.test(
    "completed-set replay returns fresh frozen copy and reads nothing",
    async () => {
      const fx = makeEffects();
      const api = loadAdapters();
      const ctrl = api.createBackgroundAdapters(fx.options());
      const docId = "doc-ba05-replay";
      const tabId = 203;
      const mediaId = openOwnedMedia(ctrl, fx, { docId, tabId });
      const first = ctrl.registerVariants(mediaId, [
        { url: "https://cdn.example/r1.mp4", label: "one", width: 1 },
        { url: "https://cdn.example/r2.mp4", label: "two", height: 2 },
      ]);
      assert.equal(first.length, 2);
      const ids = first.map((r) => r.id);

      let trapHits = 0;
      const hostile = new Proxy([], {
        getOwnPropertyDescriptor() {
          trapHits += 1;
          throw new Error("SECRET_HOSTILE_TRAP_MSG replay-gopd");
        },
        ownKeys() {
          trapHits += 1;
          throw new Error("SECRET_HOSTILE_TRAP_MSG replay-keys");
        },
        get() {
          trapHits += 1;
          throw new Error("SECRET_HOSTILE_TRAP_MSG replay-get");
        },
        getPrototypeOf() {
          trapHits += 1;
          throw new Error("SECRET_HOSTILE_TRAP_MSG replay-proto");
        },
      });
      const tokenBefore = fx.counts.randomToken;
      const second = ctrl.registerVariants(mediaId, hostile);
      assert.equal(trapHits, 0, "completed replay must not touch variants");
      assert.equal(fx.counts.randomToken, tokenBefore);
      assertFreshFrozenCopy(first, second, "completed replay");
      assert.deepEqual(
        second.map((r) => r.id),
        ids
      );

      const rev = Proxy.revocable(
        [{ url: "https://cdn.example/should-not-read.mp4" }],
        {
          get() {
            trapHits += 1;
            throw new Error("SECRET_HOSTILE_TRAP_MSG revoked-get");
          },
        }
      );
      rev.revoke();
      const third = ctrl.registerVariants(mediaId, rev.proxy);
      assert.equal(trapHits, 0);
      assert.deepEqual(
        third.map((r) => r.id),
        ids
      );
      assert.notEqual(third, second);
      assertDeepFrozen(third, "third replay");
    }
  );

  await t.test(
    "same-media reentrant fails without read; cross-media reentrant binds",
    async () => {
      const fx = makeEffects();
      const api = loadAdapters();
      let ctrl;
      let mediaA;
      let mediaB;
      let nestedAErr = null;
      let nestedBRows = null;
      let nestedBTrapHits = 0;
      let phase = "idle";
      ctrl = api.createBackgroundAdapters(
        fx.options({
          randomToken(ns) {
            fx.counts.randomToken += 1;
            if (phase === "outer-A" && ns === "variant") {
              phase = "reenter";
              // Same-media reentrant: must fail without reading input.
              let hits = 0;
              const nestedHostile = new Proxy(
                [{ url: "https://evil.example/nested-a.mp4" }],
                {
                  getOwnPropertyDescriptor() {
                    hits += 1;
                    throw new Error("SECRET_HOSTILE_TRAP_MSG nested-A");
                  },
                  ownKeys() {
                    hits += 1;
                    return ["0", "length"];
                  },
                  get() {
                    hits += 1;
                    throw new Error("SECRET_HOSTILE_TRAP_MSG nested-A-get");
                  },
                }
              );
              try {
                ctrl.registerVariants(mediaA, nestedHostile);
              } catch (e) {
                nestedAErr = e;
              }
              assert.equal(hits, 0, "same-media reentry must not read variants");

              // Cross-media reentrant registration while A is in-flight.
              const nestedBInput = [
                {
                  url: "https://cdn.example/cross-b1.mp4",
                  label: "b1",
                },
              ];
              const bProxy = new Proxy(nestedBInput, {
                get(t, p, r) {
                  if (p === "length" || p === "0" || typeof p === "symbol") {
                    return Reflect.get(t, p, r);
                  }
                  nestedBTrapHits += 1;
                  return Reflect.get(t, p, r);
                },
              });
              nestedBRows = ctrl.registerVariants(mediaB, bProxy);
              phase = "outer-A-resume";
              return "tok-A";
            }
            return "tok-" + ns + "-" + fx.counts.randomToken;
          },
        })
      );

      mediaA = openOwnedMedia(ctrl, fx, {
        docId: "doc-ba05-re-a",
        tabId: 210,
        filename: "re-a.mp4",
      });
      mediaB = openOwnedMedia(ctrl, fx, {
        docId: "doc-ba05-re-b",
        tabId: 211,
        filename: "re-b.mp4",
      });
      assert.notEqual(mediaA, mediaB);

      phase = "outer-A";
      const rowsA = ctrl.registerVariants(mediaA, [
        { url: "https://cdn.example/a1.mp4", label: "a1" },
        { url: "https://cdn.example/a2.mp4", label: "a2" },
      ]);
      assert.equal(rowsA.length, 2);
      assertVariantRegError(nestedAErr);
      assert.ok(nestedBRows);
      assert.equal(nestedBRows.length, 1);
      assert.ok(isSafeOpaqueId(nestedBRows[0].id));
      assert.equal(
        nestedBTrapHits,
        0,
        "cross-media reentrant input must not probe unexpected keys"
      );
      const allIds = [
        ...rowsA.map((r) => r.id),
        ...nestedBRows.map((r) => r.id),
      ];
      assert.equal(new Set(allIds).size, 3, "globally unique variant IDs");
      for (const id of rowsA.map((r) => r.id)) {
        assert.equal(nestedBRows.some((r) => r.id === id), false);
      }
    }
  );

  await t.test(
    "invalid structures and token failure are atomic; open-set retry works",
    async () => {
      const inst = loadVariantInstrumentedClassic();
      const fx = makeEffects();
      const ctrl = inst.api.createBackgroundAdapters(fx.options());
      assert.equal(inst.registryHits.create, 1);
      assertRegistryDormant(inst.registryHits, "invalid pre");

      // --- unknown media / wrong type: no read ---
      {
        let hits = 0;
        const hostile = new Proxy([], {
          get() {
            hits += 1;
            throw new Error("SECRET_HOSTILE_TRAP_MSG unknown");
          },
          getOwnPropertyDescriptor() {
            hits += 1;
            throw new Error("SECRET_HOSTILE_TRAP_MSG unknown-d");
          },
        });
        const baseline = snapshotEffectBaseline(fx);
        const ephBefore = inst.privacyCalls.length;
        let errUnknown = null;
        try {
          ctrl.registerVariants("not-owned", hostile);
        } catch (e) {
          errUnknown = e;
        }
        assert.equal(hits, 0);
        assert.equal(inst.privacyCalls.length, ephBefore);
        assert.equal(fx.counts.randomToken, baseline.randomToken);
        assert.equal(fx.counts.reportDiagnostic, baseline.reportDiagnostic);
        assert.equal(fx.counts.isPopupSender, baseline.isPopupSender);
        assert.equal(
          fx.counts.getEffectiveDestinationDirectory,
          baseline.getEffectiveDestinationDirectory
        );
        assertRegistryDormant(inst.registryHits, "unknown media");
        assertVariantRegError(errUnknown);
        let errType = null;
        try {
          ctrl.registerVariants(12, [{ url: "https://x.example/a.mp4" }]);
        } catch (e) {
          errType = e;
        }
        assert.equal(hits, 0);
        assertVariantRegError(errType);
        assertEffectBaseline(fx, baseline, "unknown media");
      }

      // Fresh open media for invalid matrix
      const docId = "doc-ba05-invalid";
      const tabId = 220;
      const mediaId = openOwnedMedia(ctrl, fx, { docId, tabId });

      function assertRejectsAtomic(variants, label, hits) {
        const baseline = snapshotEffectBaseline(fx);
        const ephBefore = inst.privacyCalls.length;
        const tokenBefore = fx.counts.randomToken;
        const popBeforeLen = ctrl.popupMedia(tabId).find((r) => r.id === mediaId)
          .variants.length;
        let err = null;
        try {
          ctrl.registerVariants(mediaId, variants);
        } catch (e) {
          err = e;
        }
        // Effect/hook evidence before error classification.
        if (hits) {
          for (const k of Object.keys(hits)) {
            assert.equal(hits[k], 0, label + " hit " + k);
          }
        }
        assert.equal(fx.counts.randomToken, tokenBefore, label + " token");
        assert.equal(inst.privacyCalls.length, ephBefore, label + " privacy");
        assert.equal(
          fx.counts.publishDetection,
          baseline.publishDetection,
          label + " publish"
        );
        assert.equal(fx.counts.postNative, baseline.postNative, label + " native");
        assert.equal(
          fx.counts.reportDiagnostic,
          baseline.reportDiagnostic,
          label + " reportDiagnostic"
        );
        assert.equal(
          fx.counts.isPopupSender,
          baseline.isPopupSender,
          label + " isPopupSender"
        );
        assert.equal(
          fx.counts.getEffectiveDestinationDirectory,
          baseline.getEffectiveDestinationDirectory,
          label + " getEffectiveDestinationDirectory"
        );
        assert.equal(
          fx.counts.publishJobs,
          baseline.publishJobs,
          label + " publishJobs"
        );
        assert.equal(
          fx.counts.persistHistory,
          baseline.persistHistory,
          label + " persistHistory"
        );
        assertRegistryDormant(inst.registryHits, label);
        assert.equal(
          ctrl.popupMedia(tabId).find((r) => r.id === mediaId).variants.length,
          popBeforeLen,
          label + " popup ownership unchanged"
        );
        assert.ok(err, label + " must throw");
        // Deliberately RED: fresh generic TypeError (Lease-1 stub fails here).
        assertVariantRegError(err);
        // Set still open — empty register returns []
        const empty = ctrl.registerVariants(mediaId, []);
        assert.deepEqual(empty, []);
        assertDeepFrozen(empty, label + " empty open set");
      }

      // Not an array
      assertRejectsAtomic({ 0: { url: "https://x.example/a.mp4" } }, "object shell");
      assertRejectsAtomic(null, "null");
      assertRejectsAtomic("https://x.example/a.mp4", "string");

      // Sparse / accessor index
      {
        const sparse = [];
        sparse.length = 1;
        assertRejectsAtomic(sparse, "sparse");
      }
      {
        const hits = { idx: 0 };
        const arr = [];
        Object.defineProperty(arr, "0", {
          enumerable: true,
          configurable: true,
          get() {
            hits.idx += 1;
            return { url: "https://x.example/a.mp4" };
          },
        });
        assertRejectsAtomic(arr, "index accessor", hits);
      }
      {
        const arr = [{ url: "https://x.example/a.mp4" }];
        arr.extra = true;
        assertRejectsAtomic(arr, "unexpected own key");
      }
      {
        const arr = [{ url: "https://x.example/a.mp4" }];
        arr[Symbol("s")] = 1;
        assertRejectsAtomic(arr, "symbol key");
      }

      // Dense own-data length greater than 64 (malformed Array length redefinition
      // is not feasible: Array length is non-configurable and must be uint32).
      {
        const dense = [];
        for (let i = 0; i < 65; i++) {
          dense.push({ url: "https://cdn.example/dense-" + i + ".mp4" });
        }
        assert.equal(dense.length, 65);
        assertRejectsAtomic(dense, "length greater than 64");
      }

      // URL rejects: blank, all-whitespace, C0/DEL/C1, non-HTTP, missing, inherited,
      // non-string kinds (null/undefined/numeric/boxed/object)
      const badUrls = [
        "",
        "   ",
        "\t\n",
        "https://x.example/\u0001a.mp4",
        "https://x.example/\u007fa.mp4",
        "https://x.example/\u0085a.mp4",
        "ftp://x.example/a.mp4",
        "file:///tmp/a.mp4",
        "data:video/mp4,aaa",
        "blob:https://x.example/u",
        "not-a-url",
        "/relative.mp4",
        null,
        undefined,
        12,
        0,
        true,
        { href: "https://x.example/obj.mp4" },
        Object("https://x.example/boxed.mp4"),
      ];
      for (let i = 0; i < badUrls.length; i++) {
        assertRejectsAtomic(
          [{ url: badUrls[i] }],
          "bad url kind #" + i
        );
      }
      {
        // missing required own-data url
        assertRejectsAtomic([{ label: "no-url" }], "missing url");
      }
      {
        const entry = Object.create({ url: "https://x.example/inherited.mp4" });
        assertRejectsAtomic([entry], "inherited url");
      }
      {
        const hits = { valueOf: 0, toString: 0 };
        const coerced = {
          valueOf() {
            hits.valueOf += 1;
            return "https://x.example/coerced.mp4";
          },
          toString() {
            hits.toString += 1;
            return "https://x.example/coerced.mp4";
          },
        };
        assertRejectsAtomic([{ url: coerced }], "url coercion", hits);
      }

      // Leading-space URL is a positive control (not in invalid table).
      {
        const spaced = "  https://x.example/a.mp4";
        const rows = ctrl.registerVariants(mediaId, [{ url: spaced }]);
        assert.equal(rows.length, 1);
        assert.equal(
          inst.privacyCalls.some((c) => c.mediaUrl === spaced),
          true,
          "leading-space exact Privacy spelling"
        );
        // After bind, replay must not re-validate.
        const again = ctrl.registerVariants(mediaId, [
          { url: "https://should-not-bind.example/x.mp4" },
        ]);
        assert.equal(again[0].id, rows[0].id);
      }

      // Token failure atomicity on a dedicated open media (assert ownership).
      {
        const tokenErr = new Error("TOKEN_INJECTED_VARIANT_BOOM");
        let mode = "throw";
        const fx2 = makeEffects();
        const inst2 = loadVariantInstrumentedClassic();
        const c2 = inst2.api.createBackgroundAdapters(
          fx2.options({
            randomToken(ns) {
              fx2.counts.randomToken += 1;
              if (mode === "throw" && ns === "variant") throw tokenErr;
              return "tok-ok";
            },
          })
        );
        const m = openOwnedMedia(c2, fx2, {
          docId: "doc-ba05-tokfail2",
          tabId: 222,
        });
        const ephBefore = inst2.privacyCalls.length;
        const popBefore = c2.popupMedia(222)[0].variants.length;
        let threw = null;
        try {
          c2.registerVariants(m, [
            { url: "https://cdn.example/t1.mp4" },
            { url: "https://cdn.example/t2.mp4" },
          ]);
        } catch (e) {
          threw = e;
        }
        assert.equal(threw, tokenErr, "token failure preserves identity");
        assert.equal(c2.popupMedia(222)[0].variants.length, popBefore);
        assert.equal(c2.popupMedia(222)[0].variants.length, 0);
        // Token failure is post-validation: Privacy must not commit ownership.
        assert.equal(
          c2.popupMedia(222)[0].variants.length,
          0,
          "no committed variants after token failure"
        );
        assertRegistryDormant(inst2.registryHits, "token fail");
        mode = "ok";
        const rows = c2.registerVariants(m, [
          { url: "https://cdn.example/t1.mp4" },
          { url: "https://cdn.example/t2.mp4" },
        ]);
        assert.equal(rows.length, 2);
        assert.match(rows[0].id, /:1$/);
        assert.match(rows[1].id, /:2$/);
        assert.ok(inst2.privacyCalls.length > ephBefore);
      }
    }
  );

  // Independent known-field accessors — each field is its own causal subtest.
  // Combined multi-accessor entries must not allow url rejection to mask others.
  for (const field of ["url", "label", "width", "height", "bandwidth", "mime"]) {
    await t.test(
      "independent known-field accessor reject: " + field,
      async () => {
        const inst = loadVariantInstrumentedClassic();
        const fx = makeEffects();
        const ctrl = inst.api.createBackgroundAdapters(fx.options());
        const tabId = 400 + ["url", "label", "width", "height", "bandwidth", "mime"].indexOf(field);
        const mediaId = openOwnedMedia(ctrl, fx, {
          docId: "doc-ba05-acc-" + field,
          tabId,
        });
        const hits = { [field]: 0 };
        const entry = {};
        if (field !== "url") {
          Object.defineProperty(entry, "url", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: "https://cdn.example/acc-" + field + ".mp4",
          });
        }
        Object.defineProperty(entry, field, {
          enumerable: true,
          configurable: true,
          get() {
            hits[field] += 1;
            throw new Error("SECRET_HOSTILE_TRAP_MSG accessor-" + field);
          },
        });
        const baseline = snapshotEffectBaseline(fx);
        const ephBefore = inst.privacyCalls.length;
        const popBefore = ctrl.popupMedia(tabId).find((r) => r.id === mediaId)
          .variants.length;
        let err = null;
        try {
          ctrl.registerVariants(mediaId, [entry]);
        } catch (e) {
          err = e;
        }
        assert.equal(hits[field], 0, field + " getter must not run");
        assert.equal(inst.privacyCalls.length, ephBefore);
        assert.equal(fx.counts.randomToken, baseline.randomToken);
        assert.equal(fx.counts.reportDiagnostic, baseline.reportDiagnostic);
        assert.equal(fx.counts.isPopupSender, baseline.isPopupSender);
        assert.equal(
          fx.counts.getEffectiveDestinationDirectory,
          baseline.getEffectiveDestinationDirectory
        );
        assertRegistryDormant(inst.registryHits, "acc " + field);
        assert.equal(
          ctrl.popupMedia(tabId).find((r) => r.id === mediaId).variants.length,
          popBefore
        );
        assert.ok(err, field + " must reject");
        // Deliberately RED fresh-generic TypeError; Lease-1 stops before recovery.
        assertVariantRegError(err);
        const recovered = ctrl.registerVariants(mediaId, [
          { url: "https://cdn.example/acc-recover-" + field + ".mp4", label: "r" },
        ]);
        assert.equal(recovered.length, 1);
        assert.match(recovered[0].id, /:1$/);
      }
    );
  }

  await t.test(
    "realm classification: accepted plain record with classification hooks binds",
    async () => {
      // Accepted genuine plain record + non-invoked classification hooks.
      // Zero-hooks-before-deliberate-RED ordering is required.
      const inst = loadVariantInstrumentedClassic();
      const fx = makeEffects();
      const ctrl = inst.api.createBackgroundAdapters(fx.options());
      const tabId = 280;
      const mediaId = openOwnedMedia(ctrl, fx, {
        docId: "doc-ba05-class-ok",
        tabId,
      });
      const hits = {
        constructor: 0,
        toString: 0,
        valueOf: 0,
        toStringTag: 0,
        iterator: 0,
      };
      const entry = {
        url: "https://cdn.example/class-plain.mp4",
        label: "plain",
      };
      Object.defineProperty(entry, "constructor", {
        enumerable: true,
        configurable: true,
        get() {
          hits.constructor += 1;
          throw new Error("SECRET_HOSTILE_TRAP_MSG constructor");
        },
      });
      Object.defineProperty(entry, "toString", {
        enumerable: true,
        configurable: true,
        get() {
          hits.toString += 1;
          throw new Error("SECRET_HOSTILE_TRAP_MSG toString");
        },
      });
      Object.defineProperty(entry, "valueOf", {
        enumerable: true,
        configurable: true,
        get() {
          hits.valueOf += 1;
          throw new Error("SECRET_HOSTILE_TRAP_MSG valueOf");
        },
      });
      Object.defineProperty(entry, Symbol.toStringTag, {
        enumerable: true,
        configurable: true,
        get() {
          hits.toStringTag += 1;
          throw new Error("SECRET_HOSTILE_TRAP_MSG toStringTag");
        },
      });
      Object.defineProperty(entry, Symbol.iterator, {
        enumerable: true,
        configurable: true,
        get() {
          hits.iterator += 1;
          throw new Error("SECRET_HOSTILE_TRAP_MSG iterator");
        },
      });
      let err = null;
      let rows = null;
      try {
        rows = ctrl.registerVariants(mediaId, [entry]);
      } catch (e) {
        err = e;
      }
      for (const k of Object.keys(hits)) {
        assert.equal(hits[k], 0, "plain " + k + " must not run");
      }
      assertRegistryDormant(inst.registryHits, "plain class");
      // Deliberately RED: no error and safe projection (Lease-1 fails here).
      assert.equal(err, null, "plain record must bind");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].label, "plain");
      assertNoVariantSentinels(rows, "plain class rows");
    }
  );

  await t.test(
    "realm classification: forbidden foreign custom-prototype record rejects",
    async () => {
      // Forbidden form: foreign custom-prototype entry with classification hooks.
      // Zero-hooks-before-deliberate-RED ordering; recovery starts :1 on GREEN.
      {
        const foreign = createForeignRealm();
        const inst = loadVariantInstrumentedClassic();
        const fx = makeEffects();
        const ctrl = inst.api.createBackgroundAdapters(fx.options());
        const tabId = 281;
        const mediaId = openOwnedMedia(ctrl, fx, {
          docId: "doc-ba05-class-bad",
          tabId,
        });
        const hits = {
          constructor: 0,
          toString: 0,
          valueOf: 0,
          toStringTag: 0,
          iterator: 0,
        };
        const entry = foreign.makeCustomProto();
        Object.defineProperty(entry, "url", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: "https://cdn.example/class-custom.mp4",
        });
        Object.defineProperty(entry, "constructor", {
          enumerable: true,
          configurable: true,
          get() {
            hits.constructor += 1;
            throw new Error("SECRET_HOSTILE_TRAP_MSG f-constructor");
          },
        });
        Object.defineProperty(entry, "toString", {
          enumerable: true,
          configurable: true,
          get() {
            hits.toString += 1;
            throw new Error("SECRET_HOSTILE_TRAP_MSG f-toString");
          },
        });
        Object.defineProperty(entry, "valueOf", {
          enumerable: true,
          configurable: true,
          get() {
            hits.valueOf += 1;
            throw new Error("SECRET_HOSTILE_TRAP_MSG f-valueOf");
          },
        });
        Object.defineProperty(entry, Symbol.toStringTag, {
          enumerable: true,
          configurable: true,
          get() {
            hits.toStringTag += 1;
            throw new Error("SECRET_HOSTILE_TRAP_MSG f-toStringTag");
          },
        });
        Object.defineProperty(entry, Symbol.iterator, {
          enumerable: true,
          configurable: true,
          get() {
            hits.iterator += 1;
            throw new Error("SECRET_HOSTILE_TRAP_MSG f-iterator");
          },
        });
        const baseline = snapshotEffectBaseline(fx);
        const ephBefore = inst.privacyCalls.length;
        let err = null;
        try {
          ctrl.registerVariants(mediaId, [entry]);
        } catch (e) {
          err = e;
        }
        for (const k of Object.keys(hits)) {
          assert.equal(hits[k], 0, "custom " + k + " must not run");
        }
        assert.equal(inst.privacyCalls.length, ephBefore);
        assert.equal(fx.counts.randomToken, baseline.randomToken);
        assertRegistryDormant(inst.registryHits, "custom class");
        assert.ok(err, "custom proto must reject");
        assertVariantRegError(err);
        const recovered = ctrl.registerVariants(mediaId, [
          { url: "https://cdn.example/class-recover.mp4" },
        ]);
        assert.equal(recovered.length, 1);
        assert.match(recovered[0].id, /:1$/);
      }

      // Local custom-proto control folded into forbidden named subtest.
      {
        const fx = makeEffects();
        const api = loadAdapters();
        const ctrl = api.createBackgroundAdapters(fx.options());
        const tabId = 282;
        const mediaId = openOwnedMedia(ctrl, fx, {
          docId: "doc-ba05-class-local",
          tabId,
        });
        function LocalCustom() {}
        LocalCustom.prototype = { marker: "local-custom" };
        const hits = { toStringTag: 0 };
        const entry = new LocalCustom();
        Object.defineProperty(entry, "url", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: "https://cdn.example/class-local.mp4",
        });
        Object.defineProperty(entry, Symbol.toStringTag, {
          enumerable: true,
          configurable: true,
          get() {
            hits.toStringTag += 1;
            return "Array";
          },
        });
        let err = null;
        try {
          ctrl.registerVariants(mediaId, [entry]);
        } catch (e) {
          err = e;
        }
        assert.equal(hits.toStringTag, 0);
        assert.ok(err);
        assertVariantRegError(err);
        const recovered = ctrl.registerVariants(mediaId, [
          { url: "https://cdn.example/class-local-recover.mp4" },
        ]);
        assert.equal(recovered.length, 1);
        assert.match(recovered[0].id, /:1$/);
      }
    }
  );

  await t.test(
    "hostile reflection traps produce fresh generic errors; message accessor never runs",
    async () => {
      const fx = makeEffects();
      const api = loadAdapters();
      const ctrl = api.createBackgroundAdapters(fx.options());
      const mediaId = openOwnedMedia(ctrl, fx, {
        docId: "doc-ba05-hostile",
        tabId: 230,
      });

      // Array-shell GOPD trap with exact-text TypeError + sentinel cause/stack.
      {
        const sentinel = { mark: "hostilesecret-cause" };
        const hostileErr = new TypeError(VARIANT_REG_MSG);
        hostileErr.cause = sentinel;
        hostileErr.stack =
          "TypeError: invalid media variant registration\n    at HOSTILE_SECRET_STACK";
        let gopdHits = 0;
        const arr = [{ url: "https://cdn.example/h.mp4" }];
        const proxied = new Proxy(arr, {
          getOwnPropertyDescriptor(t, p) {
            gopdHits += 1;
            throw hostileErr;
          },
        });
        let err = null;
        try {
          ctrl.registerVariants(mediaId, proxied);
        } catch (e) {
          err = e;
        }
        // Deliberately RED TypeError first; GREEN then proves the trap ran.
        assert.ok(err, "array shell hostile must reject");
        assertVariantRegError(err, { notSameAs: hostileErr });
        assert.ok(gopdHits >= 1, "array gopd trap must run");
        assert.equal(err.cause, undefined);
      }

      // Entry url own-descriptor path: exact-text hostile TypeError with hit counter.
      {
        const hostileErr = new TypeError(VARIANT_REG_MSG);
        hostileErr.secret = "SECRET_HOSTILE_TRAP_MSG";
        let urlGopdHits = 0;
        const entry = {};
        Object.defineProperty(entry, "url", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: "https://cdn.example/direct-gopd.mp4",
        });
        const entryProxy = new Proxy(entry, {
          getOwnPropertyDescriptor(t, p) {
            if (p === "url") {
              urlGopdHits += 1;
              throw hostileErr;
            }
            return Reflect.getOwnPropertyDescriptor(t, p);
          },
        });
        let err = null;
        try {
          ctrl.registerVariants(mediaId, [entryProxy]);
        } catch (e) {
          err = e;
        }
        // Deliberately RED TypeError first; GREEN proves url descriptor path.
        assert.ok(err, "url gopd hostile must reject");
        assertVariantRegError(err, { notSameAs: hostileErr });
        assert.equal(urlGopdHits, 1, "url getOwnPropertyDescriptor must be consulted");
        assert.equal(
          Object.prototype.hasOwnProperty.call(err, "secret"),
          false
        );
      }

      // Hostile thrown object whose message is an accessor — counter stays 0.
      {
        let messageHits = 0;
        const hostileObj = {};
        Object.defineProperty(hostileObj, "message", {
          enumerable: true,
          configurable: true,
          get() {
            messageHits += 1;
            return "SECRET_HOSTILE_TRAP_MSG message-accessor";
          },
        });
        Object.defineProperty(hostileObj, "name", {
          value: "TypeError",
          enumerable: false,
        });
        Object.setPrototypeOf(hostileObj, TypeError.prototype);
        const entry = {};
        const entryProxy = new Proxy(entry, {
          getOwnPropertyDescriptor() {
            throw hostileObj;
          },
          ownKeys() {
            throw hostileObj;
          },
          getPrototypeOf() {
            throw hostileObj;
          },
        });
        let err = null;
        try {
          ctrl.registerVariants(mediaId, [entryProxy]);
        } catch (e) {
          err = e;
        }
        assertVariantRegError(err, { notSameAs: hostileObj });
        assert.equal(messageHits, 0, "hostile message getter must never run");
      }

      // Still open after hostiles — valid bind once.
      const rows = ctrl.registerVariants(mediaId, [
        { url: "https://cdn.example/after-hostile.mp4", label: "ok" },
      ]);
      assert.equal(rows.length, 1);
    }
  );

  await t.test(
    "realm-neutral rejection matrix: local and foreign forbidden entry types",
    async () => {
      const foreign = createForeignRealm();
      const fx = makeEffects();
      const api = loadAdapters();
      const ctrl = api.createBackgroundAdapters(fx.options());
      const mediaId = openOwnedMedia(ctrl, fx, {
        docId: "doc-ba05-realm",
        tabId: 240,
      });

      class LocalClass {
        constructor() {
          this.url = "https://cdn.example/cls.mp4";
        }
      }
      function LocalCustom() {}
      LocalCustom.prototype = { marker: true, url: "https://cdn.example/p.mp4" };

      const nullRootProto = Object.create(null);
      nullRootProto.marker = "null-root-local";
      function LocalNullRoot() {}
      LocalNullRoot.prototype = nullRootProto;

      const cases = [
        { label: "local array entry", entry: [{ url: "https://cdn.example/a.mp4" }] },
        { label: "foreign array entry", entry: foreign.makeArray([{ url: "https://cdn.example/a.mp4" }]) },
        { label: "local function", entry: function fn() {} },
        { label: "foreign function", entry: foreign.makeFunction() },
        { label: "local Date", entry: new Date(0) },
        { label: "foreign Date", entry: foreign.makeDate() },
        { label: "local Map", entry: new Map() },
        { label: "foreign Map", entry: foreign.makeMap() },
        { label: "local Set", entry: new Set() },
        { label: "foreign Set", entry: foreign.makeSet() },
        { label: "local typed array", entry: new Uint8Array([1]) },
        { label: "foreign typed array", entry: foreign.makeTyped() },
        { label: "local class instance", entry: new LocalClass() },
        { label: "foreign class instance", entry: foreign.makeClassInstance() },
        { label: "local custom proto", entry: new LocalCustom() },
        { label: "foreign custom proto", entry: foreign.makeCustomProto() },
        { label: "local null-root custom", entry: new LocalNullRoot() },
        { label: "foreign null-root custom", entry: foreign.makeNullRootCustom() },
      ];

      for (const c of cases) {
        const baseline = snapshotEffectBaseline(fx);
        let err = null;
        try {
          ctrl.registerVariants(mediaId, [c.entry]);
        } catch (e) {
          err = e;
        }
        assert.ok(err, c.label + " must reject");
        assertVariantRegError(err);
        assert.equal(fx.counts.randomToken, baseline.randomToken, c.label);
      }

      // Positive: foreign ordinary + foreign null-proto accepted together.
      const urlF1 =
        "https://foreign.example/a.mp4?sig=SECRET_VARIANT_QUERY";
      const urlF2 =
        "https://foreign.example/b.mp4?sig=SECRET_VARIANT_QUERY2";
      const rows = ctrl.registerVariants(
        mediaId,
        foreign.makeArray([
          foreign.makeOrdinary({ url: urlF1, label: "f1" }),
          foreign.makeNullProto({ url: urlF2, label: "f2", width: 10 }),
        ])
      );
      assert.equal(rows.length, 2);
      assert.equal(rows[0].label, "f1");
      assert.equal(rows[1].label, "f2");
      assert.equal(rows[1].width, 10);
      assertNoVariantSentinels(rows, "foreign accept rows");
    }
  );

  await t.test(
    "Privacy handle-preparation failure is atomic; retry starts at :1 contiguous",
    async () => {
      const failErr = new Error("SECRET_PRIVACY_FAIL prep");
      // Fail only on first *variant* ephemeral: allow base capture, fail first
      // variant prep, then succeed. Use onEphemeral gate (not a dead failCount path).
      let variantPhase = false;
      let failOnce = true;
      let failedPrepCalls = 0;
      const inst = loadVariantInstrumentedClassic({
        onEphemeral(url, headers) {
          if (variantPhase && failOnce) {
            failOnce = false;
            failedPrepCalls += 1;
            throw failErr;
          }
        },
      });
      const fx = makeEffects();
      let variantTokenCalls = 0;
      const ctrl = inst.api.createBackgroundAdapters(
        fx.options({
          randomToken(ns) {
            fx.counts.randomToken += 1;
            if (ns === "variant") variantTokenCalls += 1;
            return "det-tok";
          },
        })
      );
      assert.equal(inst.registryHits.create, 1);
      assertRegistryDormant(inst.registryHits, "privfail pre");
      const docId = "doc-ba05-privfail";
      const tabId = 250;
      const mediaId = openOwnedMedia(ctrl, fx, { docId, tabId });
      const tokenBefore = fx.counts.randomToken;
      const variantTokensBefore = variantTokenCalls;
      const ephBefore = inst.privacyCalls.length;
      const handlesBefore = inst.ephemeralHandles.length;
      const materialBefore = snapshotEffectBaseline(fx);
      const popBefore = ctrl.popupMedia(tabId).find((r) => r.id === mediaId);
      assert.equal(popBefore.variants.length, 0);
      variantPhase = true;
      let threw = null;
      try {
        ctrl.registerVariants(mediaId, [
          { url: "https://cdn.example/pf1.mp4", label: "a" },
          { url: "https://cdn.example/pf2.mp4", label: "b" },
        ]);
      } catch (e) {
        threw = e;
      }
      assert.equal(threw, failErr, "preserve Privacy failure identity");
      assert.equal(failedPrepCalls, 1, "exactly one failed preparation call");
      // No committed variant set / issued public IDs after failure.
      assert.equal(
        ctrl.popupMedia(tabId).find((r) => r.id === mediaId).variants.length,
        0
      );
      assert.equal(
        fx.counts.publishDetection,
        materialBefore.publishDetection,
        "privfail publishDetection"
      );
      assert.equal(
        fx.counts.reportDiagnostic,
        materialBefore.reportDiagnostic,
        "privfail reportDiagnostic"
      );
      assert.equal(
        fx.counts.isPopupSender,
        materialBefore.isPopupSender,
        "privfail isPopupSender"
      );
      assert.equal(
        fx.counts.getEffectiveDestinationDirectory,
        materialBefore.getEffectiveDestinationDirectory,
        "privfail getEffectiveDestinationDirectory"
      );
      assert.equal(
        fx.counts.publishJobs,
        materialBefore.publishJobs,
        "privfail publishJobs"
      );
      assert.equal(
        fx.counts.persistHistory,
        materialBefore.persistHistory,
        "privfail persistHistory"
      );
      assert.equal(
        fx.counts.postNative,
        materialBefore.postNative,
        "privfail postNative"
      );
      assertRegistryDormant(inst.registryHits, "privfail after fail");
      // Failed prep recorded the attempted URL with null headers and no handle commit.
      const failedSlice = inst.privacyCalls.slice(ephBefore);
      assert.ok(failedSlice.length >= 1);
      assert.equal(failedSlice[0].mediaUrl, "https://cdn.example/pf1.mp4");
      assert.equal(failedSlice[0].requestHeaders, null);
      assert.equal(
        inst.ephemeralHandles.length,
        handlesBefore,
        "no committed ephemeral handle after Privacy failure"
      );
      // Token may have been requested during prep — but no public ID issued.
      // Capture token delta for comparison; retry must still mint :1/:2.
      const tokenAfterFail = fx.counts.randomToken;
      assert.ok(tokenAfterFail >= tokenBefore);
      assert.ok(variantTokenCalls >= variantTokensBefore);

      // Retry: contiguous :1 and :2 with exact-URL Privacy calls and null headers.
      const ephRetryBefore = inst.privacyCalls.length;
      const handlesRetryBefore = inst.ephemeralHandles.length;
      const rows = ctrl.registerVariants(mediaId, [
        { url: "https://cdn.example/pf1.mp4", label: "a" },
        { url: "https://cdn.example/pf2.mp4", label: "b" },
      ]);
      assert.equal(rows.length, 2);
      assert.match(rows[0].id, /:1$/);
      assert.match(rows[1].id, /:2$/);
      assert.equal(rows[0].id.includes(":3"), false);
      assert.equal(rows[1].id.includes(":3"), false);
      const retryCalls = inst.privacyCalls.slice(ephRetryBefore);
      assert.equal(retryCalls.length, 2);
      assert.equal(retryCalls[0].mediaUrl, "https://cdn.example/pf1.mp4");
      assert.equal(retryCalls[1].mediaUrl, "https://cdn.example/pf2.mp4");
      for (const c of retryCalls) {
        assert.equal(c.requestHeaders, null);
      }
      const retryHandles = inst.ephemeralHandles.slice(handlesRetryBefore);
      assert.equal(retryHandles.length, 2);
      assert.notEqual(retryHandles[0], retryHandles[1]);
      assertPrivateEphemeralHandle(
        retryHandles[0],
        "https://cdn.example/pf1.mp4",
        "privfail retry0"
      );
      assertPrivateEphemeralHandle(
        retryHandles[1],
        "https://cdn.example/pf2.mp4",
        "privfail retry1"
      );
      assertRegistryDormant(inst.registryHits, "privfail post");
    }
  );

  await t.test(
    "full-string label safety omits embedded credential/header sentinels",
    async () => {
      const fx = makeEffects();
      const api = loadAdapters();
      const ctrl = api.createBackgroundAdapters(fx.options());
      const mediaId = openOwnedMedia(ctrl, fx, {
        docId: "doc-ba05-label",
        tabId: 260,
      });
      const unsafeLabels = [
        "xCookie: SECRET_UNSAFE_LABEL",
        "xAuthorization: SECRET_UNSAFE_LABEL",
        "prefix Cookie: SECRET_UNSAFE_LABEL",
        "Set-Cookie: SECRET_UNSAFE_LABEL",
        "Authorization: SECRET_UNSAFE_LABEL",
        "Proxy-Authorization: SECRET_UNSAFE_LABEL",
        "Bearer SECRET_UNSAFE_LABEL",
        "see cookie in text",
        "has token value",
        "sig present here",
        "https://evil.example/SECRET_UNSAFE_LABEL",
        "//evil.example/x",
        "ok\u0001control",
        "a".repeat(200) + "Cookie: SECRET_UNSAFE_LABEL",
      ];
      const entries = unsafeLabels.map((label, i) => ({
        url: "https://cdn.example/lab" + i + ".mp4",
        label: label,
      }));
      const rows = ctrl.registerVariants(mediaId, entries);
      assert.equal(rows.length, unsafeLabels.length);
      for (const r of rows) {
        assert.equal(
          Object.prototype.hasOwnProperty.call(r, "label"),
          false,
          "unsafe label must be omitted"
        );
      }
      assertNoVariantSentinels(rows, "unsafe labels");
      assertNoVariantSentinels(ctrl.popupMedia(260), "popup unsafe labels");
      // Safe label still kept (trimmed, truncated after full-string checks).
      const media2 = openOwnedMedia(ctrl, fx, {
        docId: "doc-ba05-label-ok",
        tabId: 261,
      });
      const longSafe = "  " + "safe-label-" + "x".repeat(140) + "  ";
      const ok = ctrl.registerVariants(media2, [
        { url: "https://cdn.example/ok-lab.mp4", label: longSafe },
      ]);
      assert.equal(ok[0].label.length, 128);
      assert.equal(ok[0].label.startsWith("safe-label-"), true);
    }
  );

  await t.test(
    "futureTransport.variants snapshot is not auto-registered; enqueue stays stub",
    async () => {
      const inst = loadVariantInstrumentedClassic();
      const fx = makeEffects();
      const ctrl = inst.api.createBackgroundAdapters(fx.options());
      const docId = "doc-ba05-ft";
      const tabId = 270;
      const retainedUrl =
        "https://retained.example/v.mp4?token=SECRET_VARIANT_QUERY";
      const mediaId = openOwnedMedia(ctrl, fx, {
        docId,
        tabId,
        captureOverrides: {
          transport: {
            mediaKind: "direct",
            requestHeaders: null,
            variants: [{ url: retainedUrl, label: "retained" }],
          },
        },
      });
      // Capture alone: no variant IDs / popup variants / variant ephemerals for retained.
      const pop0 = ctrl.popupMedia(tabId);
      assert.equal(pop0.length, 1);
      assert.equal(pop0[0].variants.length, 0);
      const ephUrls = inst.privacyCalls.map((c) => c.mediaUrl);
      assert.equal(ephUrls.includes(retainedUrl), false);

      const explicit = "https://explicit.example/e.mp4?token=SECRET_VARIANT_QUERY";
      const rows = ctrl.registerVariants(mediaId, [
        { url: explicit, label: "explicit" },
      ]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].label, "explicit");
      assert.equal(
        inst.privacyCalls.some((c) => c.mediaUrl === explicit),
        true
      );
      assert.equal(
        inst.privacyCalls.some((c) => c.mediaUrl === retainedUrl),
        false
      );

      // Incomplete enqueue (no own-data item.id / tabId) stays effect-free.
      let itemHits = 0;
      const item = {};
      Object.defineProperty(item, "url", {
        get() {
          itemHits += 1;
          return "https://override.example/SECRET_OVERRIDE_URL.mp4";
        },
      });
      Object.defineProperty(item, "providerKey", {
        get() {
          itemHits += 1;
          return "SECRET_CALLER_PROVIDER";
        },
      });
      Object.defineProperty(item, "variantUrl", {
        get() {
          itemHits += 1;
          return "https://override.example/SECRET_OVERRIDE_URL.mp4";
        },
      });
      Object.defineProperty(item, "variantId", {
        get() {
          itemHits += 1;
          return rows[0].id;
        },
      });
      const baseline = snapshotEffectBaseline(fx);
      const p = ctrl.enqueueDownload(
        { item: item, mediaId: mediaId, variantId: rows[0].id },
        { tab: { id: tabId } }
      );
      assert.ok(p && typeof p.then === "function");
      let rejected = null;
      await p.then(
        () => {
          throw new Error("expected reject");
        },
        (err) => {
          rejected = err;
        }
      );
      assert.ok(rejected instanceof Error);
      assert.equal(rejected.message, "invalid background adapter input");
      assert.equal(itemHits, 0);
      assert.equal(fx.counts.postNative, baseline.postNative);
      assert.equal(fx.counts.publishJobs, baseline.publishJobs);
      assert.equal(
        fx.counts.getEffectiveDestinationDirectory,
        baseline.getEffectiveDestinationDirectory
      );
      assert.equal(fx.counts.randomToken, baseline.randomToken);
      assert.deepEqual(
        ctrl.popupMedia(tabId)[0].variants.map((v) => v.id),
        rows.map((r) => r.id)
      );
    }
  );

  await t.test(
    "structural: no selection resolver or private export/effect branch",
    async () => {
      // Narrow source structural inspection — harness-green on Lease-1.
      // Maps alone do not prove control flow; this is the source half of the proof.
      const src = productionSource();
      assert.equal(
        /\bresolveSelection\b|\bresolveDownloadSource\b|\bresolveVariantSource\b|\bresolveTransportBinding\b/.test(
          src
        ),
        false,
        "no selection/resolver branch"
      );
      assert.equal(
        /\bselectSource\b|\bgetOwnedVariants\b|\btestOnly\b/.test(src),
        false,
        "no private export/test hook"
      );
      assert.equal(
        /module\.exports\.debug|exports\.getVariant|exports\.selectSource/.test(src),
        false
      );
      assert.equal(
        /\bmodule\.exports\s*=\s*\{[^}]*resolve/.test(src),
        false
      );
      assert.equal(
        /\bgetVariantSource\b|\bselectDownloadSource\b|\benqueueVariant\b/.test(src),
        false,
        "no selection/enqueue-variant effect branch names"
      );
      assert.match(src, /registerVariants\s*[:(]/);

      // Registry dormancy + TrackingMap allocation are concrete, not dead.
      const inst = loadVariantInstrumentedClassic();
      const fx = makeEffects();
      const ctrl = inst.api.createBackgroundAdapters(fx.options());
      assert.equal(inst.registryHits.create, 1);
      assertRegistryDormant(inst.registryHits, "structural source");
      const tabId = 290;
      const mediaId = openOwnedMedia(ctrl, fx, {
        docId: "doc-ba05-struct-src",
        tabId,
        filename: "struct-src.mp4",
      });
      assert.ok(inst.trackedMaps.length >= 1, "finalizer maps allocated");
      assert.ok(isSafeOpaqueId(mediaId));
      assert.ok(Array.isArray(ctrl.popupMedia(tabId)));
      assertRegistryDormant(inst.registryHits, "structural source post");
    }
  );

  await t.test(
    "structural maps: private ownership identities after successful bind",
    async () => {
      // Concrete Map instrumentation half — RED until Lease-2 bind exists.
      const inst = loadVariantInstrumentedClassic();
      const fx = makeEffects();
      const ctrl = inst.api.createBackgroundAdapters(fx.options());
      assert.equal(inst.registryHits.create, 1);
      assertRegistryDormant(inst.registryHits, "structural maps pre");
      const tabId = 291;
      const mediaId = openOwnedMedia(ctrl, fx, {
        docId: "doc-ba05-struct-map",
        tabId,
        filename: "struct-map.mp4",
      });
      const mapsBeforeBind = inst.trackedMaps.length;
      // Independent original-URL sequence for ownership proof (not from outputs).
      const expectedStructUrls = [
        "https://cdn.example/struct-a.mp4?sig=SECRET_VARIANT_QUERY",
        "https://cdn.example/struct-b.mp4",
      ];
      let err = null;
      let rows = null;
      try {
        rows = ctrl.registerVariants(mediaId, [
          {
            url: "https://cdn.example/struct-a.mp4?sig=SECRET_VARIANT_QUERY",
            label: "s",
          },
          { url: "https://cdn.example/struct-b.mp4", width: 1 },
        ]);
      } catch (e) {
        err = e;
      }
      assertRegistryDormant(inst.registryHits, "structural maps attempt");
      assert.equal(
        JSON.stringify(ctrl.popupMedia(tabId)).includes("SECRET_VARIANT_QUERY"),
        false
      );
      // Deliberately RED missing Lease-2 bind; GREEN completes map proof.
      assert.equal(err, null, "structural map bind");
      assert.equal(rows.length, 2);
      assert.ok(inst.trackedMaps.length >= mapsBeforeBind);
      assertVariantOwnershipMaps(
        inst,
        mediaId,
        rows,
        expectedStructUrls,
        ctrl.popupMedia(tabId),
        "structural maps"
      );
      assertNoVariantSentinels(rows, "structural rows");
      assertRegistryDormant(inst.registryHits, "structural maps post");
    }
  );

  await t.test(
    "stealth null-root custom prototype rejects generically and retry starts :1",
    async () => {
      // Mutation caught: accepting a non-direct null-root custom prototype whose
      // sole own key is a non-enumerable hasOwnProperty (stealth Object.prototype
      // lookalike), or calling that hasOwnProperty during classification.
      // Capture both isolated cases fully before any assertion can throw.
      function runStealthCase(label, makeEntryAndCounter) {
        const inst = loadVariantInstrumentedClassic();
        const fx = makeEffects();
        let variantTokenCalls = 0;
        const ctrl = inst.api.createBackgroundAdapters(
          fx.options({
            randomToken(ns) {
              fx.counts.randomToken += 1;
              if (ns === "variant") variantTokenCalls += 1;
              return "tok-stealth-" + label;
            },
          })
        );
        const registryCreate = inst.registryHits.create;
        const registryPre = {
          observe: inst.registryHits.observe,
          lookup: inst.registryHits.lookup,
          clear: inst.registryHits.clear,
          snapshot: inst.registryHits.snapshot,
        };
        const tabId = label === "local" ? 293 : 294;
        const mediaId = openOwnedMedia(ctrl, fx, {
          docId: "doc-ba05-stealth-" + label,
          tabId,
          filename: "stealth-" + label + ".mp4",
        });
        const stealthUrl =
          "https://cdn.example/stealth-" +
          label +
          ".mp4?sig=SECRET_VARIANT_QUERY";
        const built = makeEntryAndCounter(stealthUrl);
        const entry = built.entry;
        const getHits = built.getHits;
        const entryProto = Object.getPrototypeOf(entry);
        const entryGrandProto =
          entryProto == null ? undefined : Object.getPrototypeOf(entryProto);
        const proto = entryProto;
        const hopDesc =
          proto == null
            ? undefined
            : Object.getOwnPropertyDescriptor(proto, "hasOwnProperty");
        const protoOwnNames =
          proto == null ? [] : Object.getOwnPropertyNames(proto).slice();
        const protoSymbolCount =
          proto == null ? -1 : Object.getOwnPropertySymbols(proto).length;
        const protoEnumKeyCount = proto == null ? -1 : Object.keys(proto).length;

        const tokenBefore = fx.counts.randomToken;
        const variantTokensBefore = variantTokenCalls;
        const ephBefore = inst.privacyCalls.length;
        const handlesBefore = inst.ephemeralHandles.length;
        const materialBefore = snapshotEffectBaseline(fx);
        const popBefore = ctrl.popupMedia(tabId).find((r) => r.id === mediaId);
        const mapsBefore = inst.trackedMaps.map((m) => m._sets.length);

        let err = null;
        try {
          ctrl.registerVariants(mediaId, [entry]);
        } catch (e) {
          err = e;
        }

        const hopHits = getHits();
        const tokenAfter = fx.counts.randomToken;
        const variantTokensAfter = variantTokenCalls;
        const ephAfter = inst.privacyCalls.length;
        const handlesAfter = inst.ephemeralHandles.length;
        const materialAfter = snapshotEffectBaseline(fx);
        const registryAfterStealth = {
          observe: inst.registryHits.observe,
          lookup: inst.registryHits.lookup,
          clear: inst.registryHits.clear,
          snapshot: inst.registryHits.snapshot,
        };
        const popAfter = ctrl.popupMedia(tabId).find((r) => r.id === mediaId);
        const mapsAfter = inst.trackedMaps.map((m) => m._sets.length);
        const trackedMapsLengthAfter = inst.trackedMaps.length;

        // Open-set retry: ordinary valid entry starts at first namespace suffix :1.
        const recoverUrl =
          "https://cdn.example/stealth-recover-" + label + ".mp4";
        const ephRetryBefore = inst.privacyCalls.length;
        const handlesRetryBefore = inst.ephemeralHandles.length;
        let retryErr = null;
        let rows = null;
        try {
          rows = ctrl.registerVariants(mediaId, [
            { url: recoverUrl, label: "recover-" + label },
          ]);
        } catch (e) {
          retryErr = e;
        }
        const retryCalls = inst.privacyCalls.slice(ephRetryBefore);
        const retryHandles = inst.ephemeralHandles.slice(handlesRetryBefore);
        const registryAfterRetry = {
          observe: inst.registryHits.observe,
          lookup: inst.registryHits.lookup,
          clear: inst.registryHits.clear,
          snapshot: inst.registryHits.snapshot,
        };

        return Object.freeze({
          label,
          registryCreate,
          registryPre: Object.freeze(registryPre),
          foreignObject: built.foreignObject,
          entryProtoIsNull: entryProto === null,
          entryGrandProtoIsNull: entryGrandProto === null,
          protoOwnNames: Object.freeze(protoOwnNames),
          protoSymbolCount,
          protoEnumKeyCount,
          hopDescPresent: hopDesc != null,
          hopEnumerable: hopDesc ? hopDesc.enumerable : undefined,
          hopWritable: hopDesc ? hopDesc.writable : undefined,
          hopConfigurable: hopDesc ? hopDesc.configurable : undefined,
          hopValueType: hopDesc ? typeof hopDesc.value : undefined,
          hopHasGet: hopDesc
            ? Object.prototype.hasOwnProperty.call(hopDesc, "get")
            : undefined,
          popBeforeVariants: popBefore ? popBefore.variants.length : -1,
          hopHits,
          tokenBefore,
          tokenAfter,
          variantTokensBefore,
          variantTokensAfter,
          ephBefore,
          ephAfter,
          handlesBefore,
          handlesAfter,
          materialBefore: Object.freeze(materialBefore),
          materialAfter: Object.freeze(materialAfter),
          registryAfterStealth: Object.freeze(registryAfterStealth),
          popAfterVariants: popAfter ? popAfter.variants.length : -1,
          mapsBefore: Object.freeze(mapsBefore.slice()),
          mapsAfter: Object.freeze(mapsAfter.slice()),
          trackedMapsLengthAfter,
          err,
          recoverUrl,
          retryErr,
          rows,
          retryCalls: Object.freeze(retryCalls.slice()),
          retryHandles: Object.freeze(retryHandles.slice()),
          registryAfterRetry: Object.freeze(registryAfterRetry),
        });
      }

      // Local stealth proto: Object.create(null) + non-enum hasOwnProperty only.
      const localObs = runStealthCase("local", (url) => {
        let hits = 0;
        const proto = Object.create(null);
        Object.defineProperty(proto, "hasOwnProperty", {
          enumerable: false,
          writable: true,
          configurable: true,
          value: function hasOwnProperty() {
            hits += 1;
            return Object.prototype.hasOwnProperty.apply(this, arguments);
          },
        });
        const entry = Object.create(proto);
        Object.defineProperty(entry, "url", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: url,
        });
        return {
          entry: entry,
          getHits() {
            return hits;
          },
        };
      });

      // Genuinely foreign-realm stealth proto with independent Object intrinsic.
      const foreignObs = runStealthCase("foreign", (url) => {
        const foreign = vm.runInNewContext(
          [
            "(function () {",
            "  var hits = 0;",
            "  var proto = Object.create(null);",
            "  Object.defineProperty(proto, 'hasOwnProperty', {",
            "    enumerable: false,",
            "    writable: true,",
            "    configurable: true,",
            "    value: function hasOwnProperty() {",
            "      hits += 1;",
            "      return false;",
            "    }",
            "  });",
            "  return {",
            "    Object: Object,",
            "    makeEntry: function (u) {",
            "      var e = Object.create(proto);",
            "      Object.defineProperty(e, 'url', {",
            "        enumerable: true,",
            "        configurable: true,",
            "        writable: true,",
            "        value: u",
            "      });",
            "      return e;",
            "    },",
            "    getHits: function () { return hits; }",
            "  };",
            "})()",
          ].join("\n"),
          Object.create(null)
        );
        return {
          entry: foreign.makeEntry(url),
          foreignObject: foreign.Object,
          getHits() {
            return foreign.getHits();
          },
        };
      });

      // Both isolated cases fully exercised — assert each observation now.
      for (const obs of [localObs, foreignObs]) {
        const label = obs.label;
        assert.equal(obs.registryCreate, 1, label + " registry create");
        assertRegistryDormant(obs.registryPre, label + " pre");
        if (label === "foreign") {
          assert.notEqual(obs.foreignObject, Object, "foreign Object intrinsic");
        }
        assert.equal(obs.entryProtoIsNull, false, label + " entry not direct null-proto");
        assert.equal(obs.entryGrandProtoIsNull, true, label + " proto is null-root");
        assert.deepEqual(
          obs.protoOwnNames,
          ["hasOwnProperty"],
          label + " sole own key hasOwnProperty"
        );
        assert.equal(obs.protoSymbolCount, 0, label + " no symbol own keys on proto");
        assert.ok(obs.hopDescPresent, label + " hop descriptor");
        assert.equal(obs.hopEnumerable, false, label + " hop non-enumerable");
        assert.equal(obs.hopWritable, true, label + " hop writable");
        assert.equal(obs.hopConfigurable, true, label + " hop configurable");
        assert.equal(obs.hopValueType, "function", label + " hop own-data function");
        assert.equal(obs.hopHasGet, false, label + " hop not accessor");
        assert.equal(obs.protoEnumKeyCount, 0, label + " no enum keys on proto");
        assert.equal(obs.popBeforeVariants, 0, label + " open set pre");

        // Zero-hit / zero-effect evidence first — causal RED if stealth binds.
        assert.equal(obs.hopHits, 0, label + " hasOwnProperty must not run");
        assert.equal(
          obs.tokenAfter,
          obs.tokenBefore,
          label + " zero token delta"
        );
        assert.equal(
          obs.variantTokensAfter,
          obs.variantTokensBefore,
          label + " zero variant token"
        );
        assert.equal(
          obs.ephAfter,
          obs.ephBefore,
          label + " zero Privacy delta"
        );
        assert.equal(
          obs.handlesAfter,
          obs.handlesBefore,
          label + " zero ephemeral handle delta"
        );
        assert.equal(
          obs.materialAfter.publishDetection,
          obs.materialBefore.publishDetection,
          label + " zero publishDetection"
        );
        assert.equal(
          obs.materialAfter.publishJobs,
          obs.materialBefore.publishJobs,
          label + " zero publishJobs"
        );
        assert.equal(
          obs.materialAfter.persistHistory,
          obs.materialBefore.persistHistory,
          label + " zero persistHistory"
        );
        assert.equal(
          obs.materialAfter.reportDiagnostic,
          obs.materialBefore.reportDiagnostic,
          label + " zero reportDiagnostic"
        );
        assert.equal(
          obs.materialAfter.postNative,
          obs.materialBefore.postNative,
          label + " zero postNative"
        );
        assert.equal(
          obs.materialAfter.isPopupSender,
          obs.materialBefore.isPopupSender,
          label + " zero isPopupSender"
        );
        assert.equal(
          obs.materialAfter.getEffectiveDestinationDirectory,
          obs.materialBefore.getEffectiveDestinationDirectory,
          label + " zero getEffectiveDestinationDirectory"
        );
        assertRegistryDormant(
          obs.registryAfterStealth,
          label + " after stealth attempt"
        );
        assert.equal(
          obs.popAfterVariants,
          0,
          label + " popup ownership unchanged"
        );
        assert.equal(
          obs.trackedMapsLengthAfter,
          obs.mapsBefore.length,
          label + " ownership map count stable"
        );
        for (let i = 0; i < obs.mapsBefore.length; i++) {
          assert.equal(
            obs.mapsAfter[i],
            obs.mapsBefore[i],
            label + " ownership map delta " + i
          );
        }

        // Deliberately RED: fresh generic TypeError (stealth must not bind).
        assert.ok(obs.err, label + " stealth must reject");
        assertVariantRegError(obs.err);

        assert.equal(obs.retryErr, null, label + " retry must not throw");
        assert.ok(obs.rows, label + " retry rows present");
        assert.equal(obs.rows.length, 1, label + " retry length");
        assert.match(obs.rows[0].id, /:1$/, label + " retry starts :1");
        assert.equal(obs.rows[0].label, "recover-" + label);
        assert.equal(obs.retryCalls.length, 1, label + " retry Privacy once");
        assert.equal(
          obs.retryCalls[0].mediaUrl,
          obs.recoverUrl,
          label + " exact private URL"
        );
        assert.equal(
          obs.retryCalls[0].requestHeaders,
          null,
          label + " null headers"
        );
        assert.equal(obs.retryHandles.length, 1, label + " retry handle once");
        assertPrivateEphemeralHandle(
          obs.retryHandles[0],
          obs.recoverUrl,
          label + " retry handle"
        );
        assertRegistryDormant(obs.registryAfterRetry, label + " post retry");
        assertNoVariantSentinels(obs.rows, label + " retry rows");
      }
    }
  );

  await t.test(
    "validation-time same-media reentry preserves first completed set",
    async () => {
      // Mutation caught: reflection-time same-media reentry during getPrototypeOf
      // (before the in-flight marker) must keep the first completed set and
      // complete-replay the outer call — never mint outer IDs, Privacy, or overwrite.
      const inst = loadVariantInstrumentedClassic();
      const fx = makeEffects();
      let variantTokenCalls = 0;
      const ctrl = inst.api.createBackgroundAdapters(
        fx.options({
          randomToken(ns) {
            fx.counts.randomToken += 1;
            if (ns === "variant") variantTokenCalls += 1;
            return "tok-val-reentry";
          },
        })
      );
      assert.equal(inst.registryHits.create, 1);
      assertRegistryDormant(inst.registryHits, "val-reentry pre");
      const tabId = 295;
      const mediaId = openOwnedMedia(ctrl, fx, {
        docId: "doc-ba05-val-reentry",
        tabId,
        filename: "val-reentry.mp4",
      });

      const outerUrl =
        "https://cdn.example/outer-reentry.mp4?sig=SECRET_VARIANT_QUERY";
      const innerUrl =
        "https://cdn.example/inner-first.mp4?sig=SECRET_VARIANT_QUERY";

      let getProtoHits = 0;
      let innerRows = null;
      let innerCallCount = 0;
      let unexpectedGetHits = 0;
      let valueOfHits = 0;
      let toStringHits = 0;
      let gopdHits = 0;
      let ownKeysHits = 0;

      const target = {};
      Object.defineProperty(target, "url", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: outerUrl,
      });
      Object.defineProperty(target, "label", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: "outer-label",
      });
      Object.defineProperty(target, "valueOf", {
        enumerable: false,
        configurable: true,
        get() {
          valueOfHits += 1;
          throw new Error("SECRET_HOSTILE_TRAP_MSG valueOf");
        },
      });
      Object.defineProperty(target, "toString", {
        enumerable: false,
        configurable: true,
        get() {
          toStringHits += 1;
          throw new Error("SECRET_HOSTILE_TRAP_MSG toString");
        },
      });

      const entryProxy = new Proxy(target, {
        getPrototypeOf() {
          getProtoHits += 1;
          // Reflection-time reentry before outer in-flight marker.
          innerCallCount += 1;
          innerRows = ctrl.registerVariants(mediaId, [
            { url: innerUrl, label: "inner-first" },
          ]);
          return Object.prototype;
        },
        get(t, p, r) {
          unexpectedGetHits += 1;
          return Reflect.get(t, p, r);
        },
        getOwnPropertyDescriptor(t, p) {
          gopdHits += 1;
          return Reflect.getOwnPropertyDescriptor(t, p);
        },
        ownKeys(t) {
          ownKeysHits += 1;
          return Reflect.ownKeys(t);
        },
      });

      const tokenBefore = fx.counts.randomToken;
      const variantTokensBefore = variantTokenCalls;
      const ephBefore = inst.privacyCalls.length;
      const handlesBefore = inst.ephemeralHandles.length;
      const materialBefore = snapshotEffectBaseline(fx);
      const popBefore = ctrl.popupMedia(tabId).find((r) => r.id === mediaId);
      assert.equal(popBefore.variants.length, 0);

      let outerErr = null;
      let outerRows = null;
      try {
        outerRows = ctrl.registerVariants(mediaId, [entryProxy]);
      } catch (e) {
        outerErr = e;
      }

      // Inner registration is the sole successful bind.
      assert.equal(innerCallCount, 1, "inner registerVariants exactly once");
      assert.equal(getProtoHits, 1, "getPrototypeOf trap exactly once");
      assert.equal(valueOfHits, 0, "valueOf must not run");
      assert.equal(toStringHits, 0, "toString must not run");
      assert.ok(innerRows, "inner rows present");
      assert.equal(innerRows.length, 1, "inner sole row");
      assert.equal(innerRows[0].label, "inner-first");
      assert.match(innerRows[0].id, /:1$/, "inner id first suffix");
      assert.ok(isSafeOpaqueId(innerRows[0].id));

      // Exactly one variant token + Privacy for the inner URL; outer absent.
      assert.equal(
        variantTokenCalls,
        variantTokensBefore + 1,
        "sole variant token is inner"
      );
      assert.equal(
        fx.counts.randomToken,
        tokenBefore + 1,
        "sole randomToken is inner"
      );
      const ephDelta = inst.privacyCalls.slice(ephBefore);
      assert.equal(ephDelta.length, 1, "sole Privacy binding");
      assert.equal(ephDelta[0].mediaUrl, innerUrl, "Privacy binds inner URL");
      assert.equal(ephDelta[0].requestHeaders, null);
      assert.equal(
        ephDelta.some((c) => c.mediaUrl === outerUrl),
        false,
        "outer URL absent from Privacy"
      );
      const handleDelta = inst.ephemeralHandles.slice(handlesBefore);
      assert.equal(handleDelta.length, 1, "sole ephemeral handle");
      assertPrivateEphemeralHandle(handleDelta[0], innerUrl, "inner handle");

      // Outer must not throw; it complete-replays the already-completed inner set.
      assert.equal(outerErr, null, "outer must not throw after inner completed");
      assert.ok(outerRows, "outer return present");
      assert.equal(outerRows.length, 1, "outer return sole row");
      assert.equal(outerRows[0].id, innerRows[0].id, "outer retains inner id");
      assert.equal(outerRows[0].label, "inner-first", "outer retains inner label");
      assertFreshFrozenCopy(innerRows, outerRows, "outer complete-replay");
      assertDeepFrozen(outerRows, "outer return frozen");

      // No duplicate publication / material effects beyond media finalize baseline.
      assert.equal(
        fx.counts.publishDetection,
        materialBefore.publishDetection,
        "no duplicate publishDetection"
      );
      assert.equal(
        fx.counts.publishJobs,
        materialBefore.publishJobs,
        "no publishJobs"
      );
      assert.equal(
        fx.counts.persistHistory,
        materialBefore.persistHistory,
        "no persistHistory"
      );
      assert.equal(
        fx.counts.reportDiagnostic,
        materialBefore.reportDiagnostic,
        "no reportDiagnostic"
      );
      assert.equal(
        fx.counts.postNative,
        materialBefore.postNative,
        "no postNative"
      );
      assertRegistryDormant(inst.registryHits, "val-reentry post");

      // Popup + completed replay retain the same inner id/label; outer URL absent.
      const pop = ctrl.popupMedia(tabId);
      const popRow = pop.find((r) => r.id === mediaId);
      assert.ok(popRow);
      assert.equal(popRow.variants.length, 1);
      assert.equal(popRow.variants[0].id, innerRows[0].id);
      assert.equal(popRow.variants[0].label, "inner-first");
      assert.equal(
        JSON.stringify(pop).includes(outerUrl),
        false,
        "popup omits outer URL"
      );
      assert.equal(
        JSON.stringify(outerRows).includes(outerUrl),
        false,
        "outer return omits outer URL"
      );
      assert.equal(
        JSON.stringify(innerRows).includes(outerUrl),
        false,
        "inner rows omit outer URL"
      );
      assertVariantOwnershipMaps(
        inst,
        mediaId,
        innerRows,
        [innerUrl],
        pop,
        "validation reentry maps"
      );

      const replay = ctrl.registerVariants(mediaId, [
        { url: "https://cdn.example/should-not-read.mp4" },
      ]);
      assert.equal(replay.length, 1);
      assert.equal(replay[0].id, innerRows[0].id);
      assert.equal(replay[0].label, "inner-first");
      assertFreshFrozenCopy(innerRows, replay, "post replay");
      assert.equal(
        fx.counts.randomToken,
        tokenBefore + 1,
        "replay mints no further token"
      );
      assert.equal(
        inst.privacyCalls.length,
        ephBefore + 1,
        "replay creates no further Privacy"
      );
      assertRegistryDormant(inst.registryHits, "val-reentry replay");
      assertNoVariantSentinels(outerRows, "outer rows");
      assertNoVariantSentinels(pop, "popup val-reentry");
      // getPrototypeOf may run once; ownKeys/caller getters/coercions execute zero times.
      assert.equal(unexpectedGetHits, 0, "no Proxy get trap during validation");
      assert.ok(gopdHits >= 1, "own descriptors consulted");
      assert.equal(ownKeysHits, 0, "ownKeys must not run");
    }
  );
});

// ---------------------------------------------------------------------------
// BA06 — public outputs and callbacks exclude every private sentinel
// ---------------------------------------------------------------------------

test("BA06 — public outputs and callbacks exclude every private URL/header/override sentinel", async (t) => {
  // Mutation caught: spreading private records, serializing sourceContext or
  // ephemerals, copying cookies into metadata, echoing validation/trap errors,
  // or leaking ignored overrides.

  await t.test(
    "network + DOM finalized media, variants, popup, callbacks stay sentinel-free",
    async () => {
      const inst = loadVariantInstrumentedClassic();
      const fx = makeEffects();
      const ctrl = inst.api.createBackgroundAdapters(fx.options());
      assert.equal(inst.registryHits.create, 1);
      assertRegistryDormant(inst.registryHits, "BA06 pre");

      const netDoc = "doc-ba06-net";
      const domDoc = "doc-ba06-dom";
      const tabId = 301;

      const netId = openOwnedMedia(ctrl, fx, {
        docId: netDoc,
        tabId,
        filename: "ba06-net.mp4",
      });
      const domId = openOwnedMedia(ctrl, fx, {
        docId: domDoc,
        tabId,
        kind: "dom",
      });
      assert.equal(
        fx.publishDetections.filter((p) => p.id === netId || p.id === domId)
          .length,
        2
      );

      const vUrlNet =
        "https://SECRET_VARIANT_USERINFO:x@cdn.example/n.mp4?token=SECRET_VARIANT_QUERY#SECRET_VARIANT_FRAGMENT";
      const vUrlDom =
        "https://cdn.example/d.mp4?sig=SECRET_VARIANT_QUERY&e=SECRET_VARIANT_FRAGMENT";
      // Independent original-URL sequence for ownership proof (not from outputs).
      const expectedNetUrls = [vUrlNet, "  https://x.example/a.mp4"];

      // Counter-backed ignored caller authority on network entry.
      const authorityHits = {
        id: 0,
        variantId: 0,
        variantUrl: 0,
        mediaId: 0,
        providerKey: 0,
        item: 0,
        pageUrl: 0,
        sourceContext: 0,
        headers: 0,
        Cookie: 0,
        Authorization: 0,
      };
      const netEntry0 = {
        url: vUrlNet,
        label: "net-safe",
        width: 1280,
        height: 720,
      };
      for (const name of Object.keys(authorityHits)) {
        Object.defineProperty(netEntry0, name, {
          enumerable: true,
          configurable: true,
          get() {
            authorityHits[name] += 1;
            throw new Error("SECRET_HOSTILE_TRAP_MSG ba06-auth-" + name);
          },
        });
      }
      const ephBefore = inst.privacyCalls.length;
      const handlesBefore = inst.ephemeralHandles.length;
      let netErr = null;
      let netRows = null;
      try {
        netRows = ctrl.registerVariants(netId, [
          netEntry0,
          {
            url: "  https://x.example/a.mp4",
            label: "xCookie: SECRET_UNSAFE_LABEL",
            mime: "video/mp4",
          },
        ]);
      } catch (e) {
        netErr = e;
      }
      for (const name of Object.keys(authorityHits)) {
        assert.equal(authorityHits[name], 0, "BA06 authority " + name);
      }
      assertRegistryDormant(inst.registryHits, "BA06 net attempt");
      assert.equal(netErr, null, "BA06 network bind");
      assert.equal(netRows.length, 2);
      assert.equal(Object.prototype.hasOwnProperty.call(netRows[1], "label"), false);
      const netHandles = inst.ephemeralHandles.slice(handlesBefore);
      assert.equal(netHandles.length, 2);
      assert.notEqual(netHandles[0], netHandles[1]);
      assertPrivateEphemeralHandle(netHandles[0], vUrlNet, "BA06 net handle0");
      assertPrivateEphemeralHandle(
        netHandles[1],
        "  https://x.example/a.mp4",
        "BA06 net handle1"
      );
      assert.equal(
        inst.privacyCalls.slice(ephBefore).every((c) => c.requestHeaders === null),
        true
      );

      let domErr = null;
      let domRows = null;
      try {
        domRows = ctrl.registerVariants(domId, [
          {
            url: vUrlDom,
            label: "dom-safe",
            bandwidth: 1000,
            mime: "video/mp4",
          },
        ]);
      } catch (e) {
        domErr = e;
      }
      assert.equal(domErr, null, "BA06 DOM bind");
      assert.equal(domRows.length, 1);

      // Replay completed sets: no inspection.
      {
        let hits = 0;
        const hostile = new Proxy([], {
          get() {
            hits += 1;
            throw new Error("SECRET_HOSTILE_TRAP_MSG ba06-replay");
          },
          getOwnPropertyDescriptor() {
            hits += 1;
            throw new Error("SECRET_HOSTILE_TRAP_MSG ba06-replay-d");
          },
        });
        const r1 = ctrl.registerVariants(netId, hostile);
        const r2 = ctrl.registerVariants(domId, hostile);
        assert.equal(hits, 0);
        assert.deepEqual(
          r1.map((x) => x.id),
          netRows.map((x) => x.id)
        );
        assert.deepEqual(
          r2.map((x) => x.id),
          domRows.map((x) => x.id)
        );
      }

      const pop = ctrl.popupMedia(tabId);
      const pop2 = ctrl.popupMedia(tabId);
      assertFreshFrozenCopy(pop, pop2, "BA06 popup");
      assert.equal(pop.length, 2);
      for (const row of pop) {
        assert.deepEqual(Object.keys(row).sort(), [
          "id",
          "kind",
          "proposedFilename",
          "variants",
        ].sort());
        assert.ok(Array.isArray(row.variants));
        for (const v of row.variants) {
          assert.equal(Object.prototype.hasOwnProperty.call(v, "url"), false);
          assert.equal(Object.prototype.hasOwnProperty.call(v, "providerKey"), false);
        }
      }
      const netPop = pop.find((r) => r.id === netId);
      const domPop = pop.find((r) => r.id === domId);
      assert.equal(netPop.variants.length, 2);
      assert.equal(domPop.variants.length, 1);

      for (const pub of fx.publishDetections) {
        assert.deepEqual(Object.keys(pub).sort(), [
          "id",
          "kind",
          "proposedFilename",
          "providerKey",
        ].sort());
      }

      const jobs = ctrl.popupJobs();
      assert.equal(jobs.length, 0);
      assertDeepFrozen(jobs, "popupJobs");

      // Invalid registration on fresh open media: generic error, no sentinel echo.
      {
        const openId = openOwnedMedia(ctrl, fx, {
          docId: "doc-ba06-inv",
          tabId: 303,
        });
        const baseline = snapshotEffectBaseline(fx);
        const ephInv = inst.privacyCalls.length;
        let err = null;
        try {
          ctrl.registerVariants(openId, [
            { url: "https://cdn.example/\u0001SECRET_HOSTILE_TRAP_MSG.mp4" },
          ]);
        } catch (e) {
          err = e;
        }
        assert.equal(inst.privacyCalls.length, ephInv);
        assert.equal(fx.counts.randomToken, baseline.randomToken);
        assert.equal(fx.counts.reportDiagnostic, baseline.reportDiagnostic);
        assert.equal(fx.counts.isPopupSender, baseline.isPopupSender);
        assert.equal(
          fx.counts.getEffectiveDestinationDirectory,
          baseline.getEffectiveDestinationDirectory
        );
        assertRegistryDormant(inst.registryHits, "BA06 inv");
        assertVariantRegError(err);
      }

      // Representative future stubs — await all rejections.
      const stubCalls = [
        () => ctrl.requestFirefoxHandoff({ url: vUrlNet }, {}),
        () => ctrl.cancel("job-SECRET_CALLER_VARIANT_ID"),
        () => ctrl.manualRetry("job-SECRET_CALLER_VARIANT_ID"),
        () => ctrl.helperDisconnected(),
      ];
      const materialBefore = snapshotEffectBaseline(fx);
      for (const call of stubCalls) {
        const p = call();
        assert.ok(p && typeof p.then === "function");
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
        assert.equal(
          String(rejected.message).includes("SECRET_"),
          false
        );
      }
      assert.equal(fx.counts.publishJobs, materialBefore.publishJobs);
      assert.equal(fx.counts.persistHistory, materialBefore.persistHistory);
      assert.equal(fx.counts.postNative, materialBefore.postNative);
      assert.equal(fx.counts.downloadsDownload, materialBefore.downloadsDownload);
      assert.equal(fx.counts.fetchArrayBuffer, materialBefore.fetchArrayBuffer);
      assert.equal(fx.counts.assembleMedia, materialBefore.assembleMedia);
      assert.equal(fx.counts.createObjectURL, materialBefore.createObjectURL);
      assert.equal(fx.counts.revokeObjectURL, materialBefore.revokeObjectURL);
      assert.equal(fx.counts.reportDiagnostic, materialBefore.reportDiagnostic);
      assert.equal(fx.counts.isPopupSender, materialBefore.isPopupSender);
      assert.equal(
        fx.counts.getEffectiveDestinationDirectory,
        materialBefore.getEffectiveDestinationDirectory
      );

      const surfaces = [
        netRows,
        domRows,
        pop,
        pop2,
        jobs,
        fx.publishDetections,
        fx.diagnostics,
      ];
      for (let i = 0; i < surfaces.length; i++) {
        assertNoVariantSentinels(surfaces[i], "BA06 surface " + i);
        assertNoSentinels(surfaces[i], "BA06 surface " + i);
      }
      // Privacy instrumentation may see raw URLs; production projections must not.
      assert.equal(
        inst.privacyCalls.some((c) => c.mediaUrl === vUrlNet),
        true
      );
      assert.equal(
        JSON.stringify(netRows).includes("SECRET_VARIANT_QUERY"),
        false
      );
      assertVariantOwnershipMaps(
        inst,
        netId,
        netRows,
        expectedNetUrls,
        pop,
        "BA06 net maps"
      );
      assertRegistryDormant(inst.registryHits, "BA06 post");
    }
  );

  // BA06 independent known-field accessors (network path) — no combined masking.
  for (const field of ["url", "label", "width", "height", "bandwidth", "mime"]) {
    await t.test(
      "BA06 independent known-field accessor (network): " + field,
      async () => {
        const inst = loadVariantInstrumentedClassic();
        const fx = makeEffects();
        const ctrl = inst.api.createBackgroundAdapters(fx.options());
        const tabId =
          320 +
          ["url", "label", "width", "height", "bandwidth", "mime"].indexOf(field);
        const mediaId = openOwnedMedia(ctrl, fx, {
          docId: "doc-ba06-acc-net-" + field,
          tabId,
          filename: "ba06-acc-" + field + ".mp4",
        });
        const hits = { [field]: 0 };
        const entry = {};
        if (field !== "url") {
          Object.defineProperty(entry, "url", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: "https://cdn.example/ba06-acc-" + field + ".mp4",
          });
        }
        Object.defineProperty(entry, field, {
          enumerable: true,
          configurable: true,
          get() {
            hits[field] += 1;
            throw new Error("SECRET_HOSTILE_TRAP_MSG ba06-" + field);
          },
        });
        const baseline = snapshotEffectBaseline(fx);
        const ephBefore = inst.privacyCalls.length;
        let err = null;
        try {
          ctrl.registerVariants(mediaId, [entry]);
        } catch (e) {
          err = e;
        }
        assert.equal(hits[field], 0, "BA06 " + field + " getter");
        assert.equal(inst.privacyCalls.length, ephBefore);
        assert.equal(fx.counts.randomToken, baseline.randomToken);
        assert.equal(fx.counts.reportDiagnostic, baseline.reportDiagnostic);
        assert.equal(fx.counts.isPopupSender, baseline.isPopupSender);
        assert.equal(
          fx.counts.getEffectiveDestinationDirectory,
          baseline.getEffectiveDestinationDirectory
        );
        assertRegistryDormant(inst.registryHits, "BA06 acc " + field);
        assert.equal(
          ctrl.popupMedia(tabId).find((r) => r.id === mediaId).variants.length,
          0
        );
        assert.ok(err);
        assertVariantRegError(err);
        const recovered = ctrl.registerVariants(mediaId, [
          { url: "https://cdn.example/ba06-recover-" + field + ".mp4" },
        ]);
        assert.equal(recovered.length, 1);
        assert.match(recovered[0].id, /:1$/);
        assertNoVariantSentinels(recovered, "BA06 recover " + field);
        assertNoVariantSentinels(ctrl.popupMedia(tabId), "BA06 popup recover " + field);
      }
    );
  }

  // BA06 independent optional-field accessor on DOM media (public-sentinel path).
  for (const field of ["label", "mime"]) {
    await t.test(
      "BA06 independent known-field accessor (DOM): " + field,
      async () => {
        const inst = loadVariantInstrumentedClassic();
        const fx = makeEffects();
        const ctrl = inst.api.createBackgroundAdapters(fx.options());
        const tabId = 340 + (field === "label" ? 0 : 1);
        const mediaId = openOwnedMedia(ctrl, fx, {
          docId: "doc-ba06-acc-dom-" + field,
          tabId,
          kind: "dom",
        });
        const hits = { [field]: 0 };
        const entry = {
          url: "https://cdn.example/ba06-dom-acc-" + field + ".mp4",
        };
        Object.defineProperty(entry, field, {
          enumerable: true,
          configurable: true,
          get() {
            hits[field] += 1;
            throw new Error("SECRET_HOSTILE_TRAP_MSG ba06-dom-" + field);
          },
        });
        const ephBefore = inst.privacyCalls.length;
        let err = null;
        try {
          ctrl.registerVariants(mediaId, [entry]);
        } catch (e) {
          err = e;
        }
        assert.equal(hits[field], 0);
        assert.equal(inst.privacyCalls.length, ephBefore);
        assertRegistryDormant(inst.registryHits, "BA06 dom acc " + field);
        assert.ok(err);
        assertVariantRegError(err);
        const recovered = ctrl.registerVariants(mediaId, [
          { url: "https://cdn.example/ba06-dom-recover-" + field + ".mp4" },
        ]);
        assert.equal(recovered.length, 1);
        assert.match(recovered[0].id, /:1$/);
      }
    );
  }

  await t.test(
    "unknown media and completed replay never inspect variants argument",
    async () => {
      const fx = makeEffects();
      const api = loadAdapters();
      const ctrl = api.createBackgroundAdapters(fx.options());
      let hits = 0;
      const trap = {
        getOwnPropertyDescriptor() {
          hits += 1;
          throw new Error("SECRET_HOSTILE_TRAP_MSG inspect");
        },
        ownKeys() {
          hits += 1;
          throw new Error("SECRET_HOSTILE_TRAP_MSG keys");
        },
        get() {
          hits += 1;
          throw new Error("SECRET_HOSTILE_TRAP_MSG get");
        },
        getPrototypeOf() {
          hits += 1;
          throw new Error("SECRET_HOSTILE_TRAP_MSG proto");
        },
      };
      const hostile = new Proxy([], trap);
      assert.throws(
        () => ctrl.registerVariants("media-unknown-ba06", hostile),
        (e) => {
          assertVariantRegError(e);
          return true;
        }
      );
      assert.equal(hits, 0);

      const mediaId = openOwnedMedia(ctrl, fx, {
        docId: "doc-ba06-noread",
        tabId: 310,
      });
      const bound = ctrl.registerVariants(mediaId, [
        { url: "https://cdn.example/bound.mp4", label: "b" },
      ]);
      hits = 0;
      const again = ctrl.registerVariants(mediaId, hostile);
      assert.equal(hits, 0);
      assert.deepEqual(
        again.map((r) => r.id),
        bound.map((r) => r.id)
      );
      assert.notEqual(again, bound);
      assertDeepFrozen(again, "ba06 replay");
    }
  );
});

// ---------------------------------------------------------------------------
// BA07–BA08 — provider association at observable dependency/public boundaries
// ---------------------------------------------------------------------------

function loadProviderObservedClassic(hooks) {
  const abs = path.join(mediaCatcherRoot, "lib", "background-adapters.js");
  const code = fs.readFileSync(abs, "utf8");
  const root = Object.create(null);
  const sandbox = classicVmBuiltins(root);
  loadClassicDependencies(sandbox, root);

  const events = [];
  const registryHits = {
    create: 0,
    observe: 0,
    lookup: 0,
    clear: 0,
    snapshot: 0,
  };
  const RealPR = root.McProviderRegistry;
  root.McProviderRegistry = {
    normalizeOrigin: RealPR.normalizeOrigin,
    normalizeProviderKey: RealPR.normalizeProviderKey,
    createProviderRegistry() {
      registryHits.create += 1;
      const registry = RealPR.createProviderRegistry();
      return {
        observe(origin, providerKey) {
          registryHits.observe += 1;
          const event = { kind: "observe", origin, providerKey };
          events.push(event);
          if (hooks && typeof hooks.onObserve === "function") {
            hooks.onObserve(event);
          }
          return registry.observe(origin, providerKey);
        },
        lookup(origin) {
          registryHits.lookup += 1;
          const event = { kind: "lookup", origin };
          events.push(event);
          if (hooks && typeof hooks.onLookup === "function") {
            hooks.onLookup(event);
          }
          const result = registry.lookup(origin);
          event.status = result.status;
          event.providerKey = result.providerKey;
          return result;
        },
        clear() {
          registryHits.clear += 1;
          return registry.clear();
        },
        snapshot() {
          registryHits.snapshot += 1;
          return registry.snapshot();
        },
      };
    },
  };

  vm.runInNewContext(code, sandbox, { filename: abs });
  return {
    api: root.McBackgroundAdapters,
    events,
    registryHits,
  };
}

function makeProviderController(hooks, effectOverrides) {
  const inst = loadProviderObservedClassic(hooks);
  const fx = makeEffects();
  const ctrl = inst.api.createBackgroundAdapters(fx.options(effectOverrides));
  return { inst, fx, ctrl };
}

function providerDomInput(opts) {
  const has = Object.prototype.hasOwnProperty;
  const documentId = has.call(opts, "documentId")
    ? opts.documentId
    : "doc-provider-" + opts.tabId;
  const pageUrl = has.call(opts, "pageUrl")
    ? opts.pageUrl
    : "https://www.FlorenFile.com/watch";
  const fileTag = String(opts.fileTag || opts.tabId).replace(/[^A-Za-z0-9._-]/g, "-");
  return {
    mediaUrl:
      opts.mediaUrl ||
      "https://payload.example/" + fileTag + ".mp4?sig=PRIVATE_MEDIA_QUERY",
    mediaOrigin: opts.mediaOrigin,
    contentDisposition: null,
    referrerUrl: pageUrl,
    frameOrigin: pageUrl ? new URL(pageUrl).origin : "",
    ts: 1_000_000 + opts.tabId,
    snapshot: {
      documentId,
      tabId: opts.tabId,
      frameId: 0,
      pageUrl,
      topLevelPageUrl: pageUrl,
      documentNonce: "nonce-" + fileTag,
      candidates: [{ kind: "visible-filename", value: fileTag + ".mp4" }],
      capturedAt: "2026-08-12T12:00:00.000Z",
    },
    transport:
      opts.transport || { mediaKind: "direct", requestHeaders: null },
  };
}

function captureProviderDom(env, opts) {
  const before = env.fx.publishDetections.length;
  const input = providerDomInput(opts);
  const mediaId = env.ctrl.captureDomMedia(input);
  assert.ok(isSafeOpaqueId(mediaId));
  assert.equal(env.fx.publishDetections.length, before + 1);
  const published = env.fx.publishDetections[env.fx.publishDetections.length - 1];
  assert.equal(published.id, mediaId);
  return { mediaId, input, published };
}

function providerEventRows(events) {
  return events.map((event) =>
    event.kind === "observe"
      ? ["observe", event.origin, event.providerKey]
      : ["lookup", event.origin, event.status, event.providerKey]
  );
}

function assertProviderPublicBoundary(env, forbiddenValues) {
  assert.equal(env.inst.registryHits.create, 1);
  assert.equal(env.inst.registryHits.clear, 0);
  assert.equal(env.inst.registryHits.snapshot, 0);
  for (const published of env.fx.publishDetections) {
    assert.deepEqual(Object.keys(published), [
      "id",
      "proposedFilename",
      "kind",
      "providerKey",
    ]);
    assertDeepFrozen(published, "provider publication");
  }
  const popupRows = [];
  for (let tabId = 500; tabId < 700; tabId++) {
    const rows = env.ctrl.popupMedia(tabId);
    for (const row of rows) popupRows.push(row);
  }
  for (const row of popupRows) {
    assert.deepEqual(Object.keys(row), [
      "id",
      "proposedFilename",
      "kind",
      "variants",
    ]);
    assertDeepFrozen(row, "provider popup row");
  }
  const publicJson = JSON.stringify({
    detections: env.fx.publishDetections,
    popupRows,
    diagnostics: env.fx.diagnostics,
  });
  assert.equal(publicJson.includes('"status"'), false);
  assert.equal(publicJson.includes('"mediaOrigin"'), false);
  for (const value of forbiddenValues || []) {
    assert.equal(publicJson.includes(value), false, "public provider boundary: " + value);
  }
}

test("BA07 — finalized media associates to its source provider exactly once", async (t) => {
  await t.test("distinct HTTP(S) CDN origins keep the same referring provider", () => {
    const env = makeProviderController();
    captureProviderDom(env, {
      tabId: 501,
      fileTag: "distinct-a",
      mediaOrigin: "https://CDN-A.Example:443/video/a.mp4?sig=PRIVATE_A#frag",
    });
    captureProviderDom(env, {
      tabId: 502,
      fileTag: "distinct-b",
      mediaOrigin: "http://CDN-B.Example:80/video/b.mp4?sig=PRIVATE_B",
    });

    assert.deepEqual(providerEventRows(env.inst.events), [
      ["observe", "https://cdn-a.example", "florenfile.com"],
      ["lookup", "https://cdn-a.example", "one", "florenfile.com"],
      ["observe", "http://cdn-b.example", "florenfile.com"],
      ["lookup", "http://cdn-b.example", "one", "florenfile.com"],
    ]);
    assert.deepEqual(
      env.fx.publishDetections.map((row) => row.providerKey),
      ["florenfile.com", "florenfile.com"]
    );
    assertProviderPublicBoundary(env, ["cdn-a.example", "cdn-b.example", "PRIVATE_A"]);
  });

  await t.test("document and page fallbacks are stable and session-separated", () => {
    const env = makeProviderController();
    const rows = [
      { tabId: 510, documentId: "doc-shared", mediaOrigin: "https://d1.example/a" },
      { tabId: 511, documentId: "doc-shared", mediaOrigin: "https://d2.example/b" },
      { tabId: 512, documentId: "doc-other", mediaOrigin: "https://d3.example/c" },
      { tabId: 513, documentId: null, mediaOrigin: "https://d4.example/d" },
      { tabId: 513, documentId: null, mediaOrigin: "https://d5.example/e" },
    ];
    rows.forEach((row, index) =>
      captureProviderDom(env, Object.assign({ pageUrl: "", fileTag: "fallback-" + index }, row))
    );

    assert.deepEqual(
      env.inst.events.filter((event) => event.kind === "observe").map((event) => event.providerKey),
      [
        "document-session:1",
        "document-session:1",
        "document-session:2",
        "page-session:1",
        "page-session:1",
      ]
    );
    assert.deepEqual(
      env.fx.publishDetections.map((row) => row.providerKey),
      [
        "document-session:1",
        "document-session:1",
        "document-session:2",
        "page-session:1",
        "page-session:1",
      ]
    );
    assert.equal(env.inst.registryHits.observe, 5);
    assert.equal(env.inst.registryHits.lookup, 5);
  });

  await t.test("unusable raw origins fail closed while HTTP(S) remains live", () => {
    const env = makeProviderController();
    captureProviderDom(env, {
      tabId: 520,
      fileTag: "origin-positive-before",
      mediaOrigin: "https://GOOD-A.Example:443/path?q=private",
    });
    const invalidOrigins = [
      "blob:https://hidden.example/id",
      "ftp://hidden.example/file",
      "file:///C:/private.mp4",
      "data:video/mp4;base64,AAAA",
      "",
      "not a URL",
    ];
    invalidOrigins.forEach((mediaOrigin, index) => {
      captureProviderDom(env, {
        tabId: 521 + index,
        fileTag: "origin-invalid-" + index,
        mediaOrigin,
      });
    });
    let coercionHits = 0;
    const hostileOrigin = {
      [Symbol.toPrimitive]() {
        coercionHits += 1;
        return "https://coerced.example";
      },
    };
    assert.throws(
      () =>
        env.ctrl.captureDomMedia(
          providerDomInput({
            tabId: 528,
            fileTag: "origin-hostile",
            mediaOrigin: hostileOrigin,
          })
        ),
      TypeError
    );
    assert.equal(coercionHits, 0);
    captureProviderDom(env, {
      tabId: 529,
      fileTag: "origin-positive-after",
      mediaOrigin: "http://GOOD-B.Example:80/after",
    });

    assert.deepEqual(providerEventRows(env.inst.events), [
      ["observe", "https://good-a.example", "florenfile.com"],
      ["lookup", "https://good-a.example", "one", "florenfile.com"],
      ["observe", "http://good-b.example", "florenfile.com"],
      ["lookup", "http://good-b.example", "one", "florenfile.com"],
    ]);
    assert.equal(env.fx.publishDetections.length, invalidOrigins.length + 2);
    assertProviderPublicBoundary(env, ["hidden.example", "coerced.example"]);
  });

  await t.test("registry callback reentrancy cannot duplicate association or publication", async () => {
    const hooks = {};
    const env = makeProviderController(hooks);
    const input = providerDomInput({
      tabId: 540,
      fileTag: "reentrant",
      mediaOrigin: "https://reentrant-cdn.example/video",
    });
    const ticks = [];
    function reenter() {
      env.ctrl.popupMedia(540);
      env.ctrl.acceptPageSnapshot(input.snapshot);
      ticks.push(env.ctrl.tick(1_001_000));
    }
    hooks.onObserve = reenter;
    hooks.onLookup = reenter;

    const mediaId = env.ctrl.captureDomMedia(input);
    await Promise.all(ticks);
    assert.ok(isSafeOpaqueId(mediaId));
    assert.deepEqual(providerEventRows(env.inst.events), [
      ["observe", "https://reentrant-cdn.example", "florenfile.com"],
      ["lookup", "https://reentrant-cdn.example", "one", "florenfile.com"],
    ]);
    assert.equal(env.fx.publishDetections.length, 1);
    assert.equal(env.ctrl.popupMedia(540).length, 1);
  });

  await t.test("observe and lookup failures are contained and never retried", async () => {
    const observations = [];
    for (const failingMethod of ["observe", "lookup"]) {
      const hooks = {};
      const env = makeProviderController(hooks);
      const sentinel = "PRIVATE_REGISTRY_FAILURE_" + failingMethod;
      hooks[failingMethod === "observe" ? "onObserve" : "onLookup"] = () => {
        throw new Error(sentinel);
      };
      const result = captureProviderDom(env, {
        tabId: failingMethod === "observe" ? 550 : 551,
        fileTag: "failure-" + failingMethod,
        mediaOrigin: "https://failure-" + failingMethod + ".example/path",
      });
      assert.equal(result.published.providerKey, "florenfile.com");
      const before = env.inst.events.length;
      env.ctrl.popupMedia(failingMethod === "observe" ? 550 : 551);
      env.ctrl.acceptPageSnapshot(result.input.snapshot);
      await env.ctrl.tick(1_001_100);
      observations.push({ failingMethod, env, sentinel, before });
    }
    for (const observation of observations) {
      const { failingMethod, env, sentinel, before } = observation;
      assert.equal(env.inst.events.length, before);
      assert.deepEqual(
        env.inst.events.map((event) => event.kind),
        failingMethod === "observe" ? ["observe"] : ["observe", "lookup"]
      );
      assert.equal(env.fx.publishDetections.length, 1);
      assert.equal(JSON.stringify(env.fx.publishDetections).includes(sentinel), false);
      assert.equal(JSON.stringify(env.fx.diagnostics).includes(sentinel), false);
      assert.ok(env.fx.diagnostics.length <= 1);
    }
  });

  await t.test("later reads, variants, and caller overrides cannot reassociate or leak", async () => {
    const retainedUrl = "https://retained.example/private-retained.mp4";
    const explicitUrl = "https://explicit.example/private-explicit.mp4";
    const transport = {
      mediaKind: "direct",
      requestHeaders: null,
      variants: [{ url: retainedUrl, label: "retained" }],
    };
    const env = makeProviderController();
    const result = captureProviderDom(env, {
      tabId: 560,
      fileTag: "later-reads",
      mediaOrigin: "https://stable-cdn.example/private-path",
      transport,
    });
    const eventRows = providerEventRows(env.inst.events);
    const publishCount = env.fx.publishDetections.length;
    env.ctrl.popupMedia(560);
    env.ctrl.acceptPageSnapshot(result.input.snapshot);
    await env.ctrl.tick(1_001_200);
    const variants = env.ctrl.registerVariants(result.mediaId, [
      {
        url: explicitUrl,
        label: "explicit",
        providerKey: "caller-override.example",
        mediaId: "caller-media-id",
      },
    ]);
    let replayHits = 0;
    const hostileReplay = new Proxy([], {
      get() {
        replayHits += 1;
        throw new Error("PRIVATE_REPLAY_READ");
      },
      getOwnPropertyDescriptor() {
        replayHits += 1;
        throw new Error("PRIVATE_REPLAY_DESCRIPTOR");
      },
    });
    const replay = env.ctrl.registerVariants(result.mediaId, hostileReplay);

    assert.deepEqual(eventRows, [
      ["observe", "https://stable-cdn.example", "florenfile.com"],
      ["lookup", "https://stable-cdn.example", "one", "florenfile.com"],
    ]);
    assert.equal(replayHits, 0);
    assert.deepEqual(replay.map((row) => row.id), variants.map((row) => row.id));
    assert.deepEqual(providerEventRows(env.inst.events), eventRows);
    assert.equal(env.fx.publishDetections.length, publishCount);
    assert.equal(Object.prototype.hasOwnProperty.call(variants[0], "url"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(variants[0], "providerKey"), false);
    assertProviderPublicBoundary(env, [
      retainedUrl,
      explicitUrl,
      "caller-override.example",
      "stable-cdn.example",
    ]);
  });
});

test("BA08 — shared CDN ambiguity stays live and session-scoped", async (t) => {
  await t.test("shared CDN A→B→A returns one, ambiguous, ambiguous without rewriting ownership", () => {
    const env = makeProviderController();
    const shared = "https://SHARED-CDN.Example:443/video/path?private=1";
    const providers = [
      "https://www.Provider-A.Example/watch",
      "https://Provider-B.Example/watch",
      "https://provider-a.example/again",
    ];
    providers.forEach((pageUrl, index) =>
      captureProviderDom(env, {
        tabId: 600 + index,
        fileTag: "shared-" + index,
        mediaOrigin: shared,
        pageUrl,
      })
    );

    assert.deepEqual(providerEventRows(env.inst.events), [
      ["observe", "https://shared-cdn.example", "provider-a.example"],
      ["lookup", "https://shared-cdn.example", "one", "provider-a.example"],
      ["observe", "https://shared-cdn.example", "provider-b.example"],
      ["lookup", "https://shared-cdn.example", "ambiguous", null],
      ["observe", "https://shared-cdn.example", "provider-a.example"],
      ["lookup", "https://shared-cdn.example", "ambiguous", null],
    ]);
    assert.deepEqual(
      env.fx.publishDetections.map((row) => row.providerKey),
      ["provider-a.example", "provider-b.example", "provider-a.example"]
    );
    assertProviderPublicBoundary(env, ["shared-cdn.example", "private=1"]);
  });

  await t.test("registry ambiguity cannot cross controller sessions", async () => {
    const shared = "https://session-cdn.example/path";
    const first = makeProviderController();
    captureProviderDom(first, {
      tabId: 610,
      fileTag: "session-a",
      mediaOrigin: shared,
      pageUrl: "https://provider-a.example/watch",
    });
    captureProviderDom(first, {
      tabId: 611,
      fileTag: "session-b",
      mediaOrigin: shared,
      pageUrl: "https://provider-b.example/watch",
    });

    const second = makeProviderController();
    const result = captureProviderDom(second, {
      tabId: 612,
      fileTag: "session-fresh",
      mediaOrigin: shared,
      pageUrl: "https://provider-a.example/watch",
    });
    assert.deepEqual(providerEventRows(first.inst.events), [
      ["observe", "https://session-cdn.example", "provider-a.example"],
      ["lookup", "https://session-cdn.example", "one", "provider-a.example"],
      ["observe", "https://session-cdn.example", "provider-b.example"],
      ["lookup", "https://session-cdn.example", "ambiguous", null],
    ]);
    assert.deepEqual(providerEventRows(second.inst.events), [
      ["observe", "https://session-cdn.example", "provider-a.example"],
      ["lookup", "https://session-cdn.example", "one", "provider-a.example"],
    ]);
    const before = second.inst.events.length;
    second.ctrl.popupMedia(612);
    second.ctrl.acceptPageSnapshot(result.input.snapshot);
    await second.ctrl.tick(1_001_300);
    assert.equal(second.inst.events.length, before);
    assert.equal(second.fx.publishDetections[0].providerKey, "provider-a.example");
  });
});
