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
  const realNormalizeOrigin = RealPR.normalizeOrigin;
  const realNormalizeProviderKey = RealPR.normalizeProviderKey;
  root.McProviderRegistry = {
    normalizeOrigin: realNormalizeOrigin,
    normalizeProviderKey: realNormalizeProviderKey,
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
    "ProviderRegistry is constructed once and never cleared or snapshotted",
    async () => {
      const src = productionSource();
      const creates = src.match(/createProviderRegistry\s*\(/g) || [];
      assert.equal(creates.length, 1, "createProviderRegistry exactly once");
      assert.equal(
        (src.match(/providerRegistry\.clear\s*\(/g) || []).length,
        0,
        "must not call providerRegistry.clear("
      );
      assert.equal(
        (src.match(/providerRegistry\.snapshot\s*\(/g) || []).length,
        0,
        "must not call providerRegistry.snapshot("
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
  const realNormalizeOrigin = RealPR.normalizeOrigin;
  const realNormalizeProviderKey = RealPR.normalizeProviderKey;
  root.McProviderRegistry = {
    normalizeOrigin: realNormalizeOrigin,
    normalizeProviderKey: realNormalizeProviderKey,
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
  assert.equal(registryHits.observe, 0, prefix + "registry observe");
  assert.equal(registryHits.lookup, 0, prefix + "registry lookup");
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

      // enqueueDownload remains Lease-1 stub; no reads / effects.
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
      assert.equal(rejected.message, LEASE1_MSG);
      assert.equal(itemHits, 0);
      assertEffectBaseline(fx, baseline, "enqueueDownload stub");
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
        () =>
          ctrl.enqueueDownload(
            {
              url: "https://override.example/SECRET_OVERRIDE_URL.mp4",
              providerKey: "SECRET_CALLER_PROVIDER",
              variantUrl: vUrlNet,
              variantId: netRows[0].id,
            },
            {}
          ),
        () => ctrl.handleNativeMessage({ cookie: "SECRET_COOKIE_ABC" }),
        () => ctrl.requestFirefoxHandoff({ url: vUrlNet }, {}),
        () => ctrl.cancel("job-SECRET_CALLER_VARIANT_ID"),
        () => ctrl.manualRetry("job-SECRET_CALLER_VARIANT_ID"),
        () => ctrl.helperDisconnected(),
        () => ctrl.setMaxConcurrent(9),
        () => ctrl.pump(),
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
// BA07/BA08 — Lease-2 provider observation (test-only RED harness)
// ---------------------------------------------------------------------------

const { types: utilTypes } = require("node:util");

const EVIDENCE_OWN_KEYS = Object.freeze(["status", "providerKey"]);
const SAFE_DETECTION_OWN_KEYS = Object.freeze([
  "id",
  "proposedFilename",
  "kind",
  "providerKey",
]);
const POPUP_ROW_OWN_KEYS = Object.freeze([
  "id",
  "proposedFilename",
  "kind",
  "variants",
]);
const MEDIA_RECORD_OWN_KEYS = Object.freeze([
  "mediaId",
  "sourceContext",
  "proposedFilename",
  "mediaKind",
  "providerKey",
  "tabId",
  "detectionId",
  "ephemeral",
]);
const MEDIA_RECORD_OWN_KEYS_FT = Object.freeze(
  MEDIA_RECORD_OWN_KEYS.concat(["futureTransport"])
);
const SOURCE_CONTEXT_OWN_KEYS = Object.freeze([
  "version",
  "capturedAt",
  "tabId",
  "documentId",
  "frameId",
  "topLevelPageUrl",
  "topLevelSite",
  "immediateReferrerUrl",
  "frameOrigin",
  "mediaOrigin",
  "filenameCandidates",
]);
const VARIANT_RECORD_KEYS = Object.freeze(["safeProjection", "sourceHandle"]);
const FUTURE_TRANSPORT_OWN_KEYS = Object.freeze(["variants"]);
const FT_VARIANTS_OWN_KEYS = Object.freeze(["0", "length"]);
const FT_CANDIDATE_OWN_KEYS = Object.freeze(["url", "label"]);
const PRIVACY_HANDLE_OWN_KEYS = Object.freeze([
  "mediaUrl",
  "requestHeaders",
  "clear",
]);
const ADAPTER_EXPORT_OWN_KEYS = Object.freeze(["createBackgroundAdapters"]);
const DIAGNOSTIC_KEYS_2 = Object.freeze(["code", "scope"]);
const DIAGNOSTIC_KEYS_3 = Object.freeze(["code", "scope", "id"]);
const DIAGNOSTIC_CODE_RE = /^[a-z0-9-]{1,64}$/;
const CONTROLLER_CONSTRUCTION_MAPS = 19;
const CONTROLLER_CONSTRUCTION_SETS = 4;
const PREFLIGHT_MAPS_PER_CAPTURE = 4;
const FORBIDDEN_PUBLIC_KEYS = Object.freeze([
  "sourceContext",
  "requestHeaders",
  "mediaUrl",
  "sourceHandle",
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
  "futureTransport",
  "providerObservation",
  "ownership",
]);
const ZERO_CALL_EFFECTS = Object.freeze([
  "publishJobs",
  "persistHistory",
  "postNative",
  "downloadsDownload",
  "fetchArrayBuffer",
  "assembleMedia",
  "createObjectURL",
  "revokeObjectURL",
  "isPopupSender",
  "getEffectiveDestinationDirectory",
]);

function isDataDescriptor(desc) {
  return (
    !!desc &&
    Object.prototype.hasOwnProperty.call(desc, "value") &&
    !Object.prototype.hasOwnProperty.call(desc, "get") &&
    !Object.prototype.hasOwnProperty.call(desc, "set")
  );
}

function isAccessorDescriptor(desc) {
  return (
    !!desc &&
    (Object.prototype.hasOwnProperty.call(desc, "get") ||
      Object.prototype.hasOwnProperty.call(desc, "set")) &&
    !Object.prototype.hasOwnProperty.call(desc, "value")
  );
}

function descriptorFlags(desc) {
  return {
    enumerable: !!desc.enumerable,
    writable: !!desc.writable,
    configurable: !!desc.configurable,
  };
}

function ownKeysOrFail(value, label) {
  try {
    return Reflect.ownKeys(value);
  } catch (e) {
    assert.fail(label + " ownKeys failed");
  }
  return [];
}

function ownDescriptorOrFail(value, key, label) {
  let desc;
  try {
    desc = Object.getOwnPropertyDescriptor(value, key);
  } catch (e) {
    assert.fail(label + " descriptor lookup failed for " + String(key));
  }
  assert.ok(desc, label + " missing descriptor " + String(key));
  return desc;
}

function assertExactOwnKeys(value, expected, label) {
  assert.deepEqual(ownKeysOrFail(value, label), expected.slice(), label + " own-key sequence");
}

function assertFrozenDataDesc(desc, opts, label) {
  assert.equal(isDataDescriptor(desc), true, label + " data descriptor");
  assert.equal(!!desc.enumerable, opts.enumerable, label + " enumerable");
  assert.equal(!!desc.writable, false, label + " nonwritable");
  assert.equal(!!desc.configurable, false, label + " nonconfigurable");
}

function isOrdinaryObject(value) {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  if (utilTypes.isMap(value) || utilTypes.isSet(value)) return false;
  let proto;
  try {
    proto = Object.getPrototypeOf(value);
  } catch (e) {
    return false;
  }
  if (proto === Object.prototype || proto === null) return true;
  // Cross-realm ordinary objects: their Object.prototype has a null [[Prototype]].
  if (!proto) return false;
  let grand;
  try {
    grand = Object.getPrototypeOf(proto);
  } catch (e) {
    return false;
  }
  return grand === null;
}

function keysEqualExact(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) return false;
  }
  return true;
}

function makeProviderEffects() {
  const fx = makeEffects();
  const effectArgs = {
    postNative: [],
    downloadsDownload: [],
    createObjectURL: [],
    revokeObjectURL: [],
    fetchArrayBuffer: [],
    assembleMedia: [],
    isPopupSender: [],
    getEffectiveDestinationDirectory: [],
    publishDetection: [],
    publishJobs: [],
    persistHistory: [],
    reportDiagnostic: [],
    randomToken: [],
    now: [],
  };
  const origOptions = fx.options.bind(fx);
  fx.effectArgs = effectArgs;
  // Wrap the final effective callback after overrides so an override cannot
  // bypass argument capture (F7).
  fx.options = function (overrides) {
    const base = Object.assign({}, origOptions(), overrides || {});
    const wrapped = {};
    const names = Object.keys(effectArgs);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (typeof base[name] !== "function") continue;
      const orig = base[name];
      wrapped[name] = function () {
        const args = [];
        for (let a = 0; a < arguments.length; a++) args.push(arguments[a]);
        effectArgs[name].push(args);
        return orig.apply(this, arguments);
      };
    }
    return Object.assign(base, wrapped);
  };
  return fx;
}

/**
 * Transparent real ProviderRegistry instrumentation for BA07/BA08.
 * Delegates real normalizeOrigin/normalizeProviderKey/createProviderRegistry
 * methods and returns real results unchanged. registryHits semantics match
 * BA04/BA05/BA06. Attempts are recorded before hooks/delegation.
 */
function loadProviderInstrumentedClassic(options) {
  const opts = options || {};
  const abs = path.join(mediaCatcherRoot, "lib", "background-adapters.js");
  const code = fs.readFileSync(abs, "utf8");
  const root = Object.create(null);
  const sandbox = classicVmBuiltins(root);

  const trackedMaps = [];
  const trackedSets = [];
  const causalLog = [];
  let causalSeq = 0;
  function markCausal(kind, extra) {
    const rec = Object.assign({ kind: kind, seq: causalSeq }, extra || {});
    causalSeq += 1;
    causalLog.push(rec);
    return rec;
  }
  class TrackingMap extends Map {
    constructor() {
      super();
      this._sets = [];
      this._deletes = [];
      this._clears = [];
      this._history = [];
      this._allocIndex = trackedMaps.length;
      this._bornSeq = causalSeq;
      this._bornKind = causalLog.length
        ? causalLog[causalLog.length - 1].kind
        : "pre-controller";
      trackedMaps.push(this);
    }
    set(key, value) {
      const result = super.set(key, value);
      const rec = { op: "set", key: key, value: value, result: result };
      this._sets.push(rec);
      this._history.push(rec);
      return result;
    }
    delete(key) {
      const result = super.delete(key);
      const rec = { op: "delete", key: key, result: result };
      this._deletes.push(rec);
      this._history.push(rec);
      return result;
    }
    clear() {
      const result = super.clear();
      const rec = { op: "clear", result: result };
      this._clears.push(rec);
      this._history.push(rec);
      return result;
    }
  }
  class TrackingSet extends Set {
    constructor() {
      super();
      this._adds = [];
      this._deletes = [];
      this._clears = [];
      this._history = [];
      this._allocIndex = trackedSets.length;
      this._bornSeq = causalSeq;
      this._bornKind = causalLog.length
        ? causalLog[causalLog.length - 1].kind
        : "pre-controller";
      trackedSets.push(this);
    }
    add(value) {
      const result = super.add(value);
      const rec = { op: "add", value: value, result: result };
      this._adds.push(rec);
      this._history.push(rec);
      return result;
    }
    delete(value) {
      const result = super.delete(value);
      const rec = { op: "delete", value: value, result: result };
      this._deletes.push(rec);
      this._history.push(rec);
      return result;
    }
    clear() {
      const result = super.clear();
      const rec = { op: "clear", result: result };
      this._clears.push(rec);
      this._history.push(rec);
      return result;
    }
  }
  sandbox.Map = TrackingMap;
  sandbox.Set = TrackingSet;

  const consoleCaptures = [];
  function captureConsole(name) {
    return function () {
      const args = [];
      for (let i = 0; i < arguments.length; i++) args.push(arguments[i]);
      consoleCaptures.push({ name: name, args: args });
    };
  }
  sandbox.console = {
    log: captureConsole("log"),
    info: captureConsole("info"),
    warn: captureConsole("warn"),
    error: captureConsole("error"),
    debug: captureConsole("debug"),
  };

  loadClassicDependencies(sandbox, root);

  const registryHits = {
    observe: 0,
    lookup: 0,
    clear: 0,
    snapshot: 0,
    create: 0,
  };
  const registryAttempts = [];
  const registryEvents = [];
  const completedResults = [];
  /** Test-private only — never returned through production or public surfaces. */
  const originalLookupResults = [];
  const realRegistryInstances = [];
  const hooks = {
    onObserve: null,
    onLookup: null,
    throwOnObserve: null,
    throwOnLookup: null,
  };

  const RealPR = root.McProviderRegistry;
  const realCreatePR = RealPR.createProviderRegistry;
  const realNormalizeOrigin = RealPR.normalizeOrigin;
  const realNormalizeProviderKey = RealPR.normalizeProviderKey;
  assert.equal(typeof realNormalizeOrigin, "function");
  assert.equal(typeof realNormalizeProviderKey, "function");

  root.McProviderRegistry = {
    normalizeOrigin: realNormalizeOrigin,
    normalizeProviderKey: realNormalizeProviderKey,
    createProviderRegistry() {
      registryHits.create += 1;
      const reg = realCreatePR.call(RealPR);
      realRegistryInstances.push(reg);
      return {
        observe(mediaOrigin, providerKey) {
          registryAttempts.push(
            Object.freeze({
              method: "observe",
              mediaOrigin: mediaOrigin,
              providerKey: providerKey,
            })
          );
          registryHits.observe += 1;
          if (typeof hooks.onObserve === "function") {
            hooks.onObserve(mediaOrigin, providerKey, registryHits.observe);
          }
          if (hooks.throwOnObserve != null) {
            const err = hooks.throwOnObserve;
            hooks.throwOnObserve = null;
            throw err;
          }
          const ret = reg.observe(mediaOrigin, providerKey);
          registryEvents.push({
            method: "observe",
            mediaOrigin: mediaOrigin,
            providerKey: providerKey,
          });
          completedResults.push(
            Object.freeze({ method: "observe", ok: true })
          );
          return ret;
        },
        lookup(mediaOrigin) {
          registryAttempts.push(
            Object.freeze({
              method: "lookup",
              mediaOrigin: mediaOrigin,
            })
          );
          registryHits.lookup += 1;
          if (typeof hooks.onLookup === "function") {
            hooks.onLookup(mediaOrigin, registryHits.lookup);
          }
          if (hooks.throwOnLookup != null) {
            const err = hooks.throwOnLookup;
            hooks.throwOnLookup = null;
            throw err;
          }
          const ret = reg.lookup(mediaOrigin);
          originalLookupResults.push(ret);
          const copy = { status: ret.status, providerKey: ret.providerKey };
          registryEvents.push({
            method: "lookup",
            mediaOrigin: mediaOrigin,
            result: copy,
          });
          completedResults.push(
            Object.freeze({
              method: "lookup",
              status: copy.status,
              providerKey: copy.providerKey,
            })
          );
          return ret;
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
  const privacyObservations = [];
  const captureAssociations = [];
  const variantAssociations = [];
  const RealPrivacy = root.McPrivacy;
  const realCreateEph = RealPrivacy.createEphemeral;
  root.McPrivacy = {
    createEphemeral(mediaUrl, requestHeaders) {
      const handle = realCreateEph.call(RealPrivacy, mediaUrl, requestHeaders);
      const callIndex = privacyObservations.length;
      const observation = Object.freeze({
        callIndex: callIndex,
        order: callIndex + 1,
        mediaUrl: mediaUrl,
        requestHeaders: requestHeaders,
        handle: handle,
      });
      privacyObservations.push(observation);
      privacyCalls.push({
        mediaUrl: mediaUrl,
        requestHeaders: requestHeaders,
      });
      ephemeralHandles.push(handle);
      return handle;
    },
    projectSafeHistory: RealPrivacy.projectSafeHistory,
    projectPopupJob: RealPrivacy.projectPopupJob,
    redactUrlForLog: RealPrivacy.redactUrlForLog,
    assertNoSentinels: RealPrivacy.assertNoSentinels,
    clearEphemeralOnTerminal: RealPrivacy.clearEphemeralOnTerminal,
  };

  // Narrow authorized DetectionFinalizer wrapper: only listFinalized may return
  // fresh frozen copies that differ solely in sourceContext.mediaOrigin.
  const originOverrides = opts.originOverrides || null;
  const originOverrideValues = [];
  if (originOverrides) {
    for (const v of originOverrides.values()) {
      originOverrideValues.push(v);
    }
  }
  const RealDF = root.McDetectionFinalizer;
  const realCreateDF = RealDF.createDetectionFinalizer;
  const finalizerInstances = [];
  root.McDetectionFinalizer = {
    CONTEXT_WAIT_MS: RealDF.CONTEXT_WAIT_MS,
    mapWebRequestDetails: RealDF.mapWebRequestDetails,
    createDetectionFinalizer(deps) {
      const instance = realCreateDF.call(RealDF, deps);
      if (originOverrides) {
        const origList = instance.listFinalized;
        instance.listFinalized = function listFinalizedWrapped() {
          const items = origList.call(instance);
          const out = [];
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const detId = item && item.detectionId;
            if (
              !originOverrides.has(detId) ||
              !item ||
              !item.sourceContext ||
              typeof item.sourceContext !== "object"
            ) {
              out.push(item);
              continue;
            }
            const sc = item.sourceContext;
            const scKeys = ownKeysOrFail(sc, "origin-override sourceContext");
            const newSc = {};
            for (let k = 0; k < scKeys.length; k++) {
              const key = scKeys[k];
              if (typeof key !== "string") {
                assert.fail("origin-override sourceContext symbol key");
              }
              const desc = ownDescriptorOrFail(
                sc,
                key,
                "origin-override sourceContext"
              );
              assert.equal(
                isDataDescriptor(desc),
                true,
                "origin-override sourceContext data " + key
              );
              if (key === "mediaOrigin") {
                newSc.mediaOrigin = originOverrides.get(detId);
              } else {
                newSc[key] = desc.value;
              }
            }
            if (!Object.prototype.hasOwnProperty.call(newSc, "mediaOrigin")) {
              newSc.mediaOrigin = originOverrides.get(detId);
            }
            Object.freeze(newSc);
            out.push(
              Object.freeze({
                detectionId: item.detectionId,
                mediaUrl: item.mediaUrl,
                sourceContext: newSc,
                proposedFilename: item.proposedFilename,
                rankDiagnostics: item.rankDiagnostics,
              })
            );
          }
          return out;
        };
      }
      finalizerInstances.push(instance);
      return instance;
    },
  };

  const globalsBeforeLoad = snapshotRootOwnGlobals(root);
  vm.runInNewContext(code, sandbox, { filename: abs });
  assert.equal(typeof root.McBackgroundAdapters, "object");
  const globalsAfterLoad = snapshotRootOwnGlobals(root);
  assertAdapterAddedExactlyOnce(globalsBeforeLoad, globalsAfterLoad);

  const controllerWatermarks = [];
  const rawApi = root.McBackgroundAdapters;
  const trackedApi = Object.freeze({
    createBackgroundAdapters(options) {
      const mapStart = trackedMaps.length;
      const setStart = trackedSets.length;
      const finStart = finalizerInstances.length;
      markCausal("controller-construct-start", {
        mapStart: mapStart,
        setStart: setStart,
      });
      const ctrl = rawApi.createBackgroundAdapters(options);
      const watermark = {
        mapStart: mapStart,
        mapEnd: trackedMaps.length,
        setStart: setStart,
        setEnd: trackedSets.length,
        finStart: finStart,
        finEnd: finalizerInstances.length,
      };
      controllerWatermarks.push(watermark);
      markCausal("controller-construct-end", watermark);
      return ctrl;
    },
  });

  return {
    api: trackedApi,
    rawApi: rawApi,
    root: root,
    trackedMaps,
    trackedSets,
    finalizerInstances,
    controllerWatermarks,
    registryHits,
    registryAttempts,
    registryEvents,
    completedResults,
    originalLookupResults,
    realRegistryInstances,
    hooks,
    normalizeOrigin: realNormalizeOrigin,
    normalizeProviderKey: realNormalizeProviderKey,
    privacyCalls,
    ephemeralHandles,
    privacyObservations,
    captureAssociations,
    variantAssociations,
    causalLog,
    markCausal,
    consoleCaptures,
    originOverrideValues,
    originOverrides,
    globalsBeforeLoad,
    globalsAfterLoad,
  };
}

function snapshotRootOwnGlobals(root) {
  const keys = ownKeysOrFail(root, "root globals");
  const records = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const desc = ownDescriptorOrFail(root, k, "root globals");
    const data = isDataDescriptor(desc);
    records.push({
      key: k,
      enumerable: !!desc.enumerable,
      configurable: !!desc.configurable,
      writable: data ? !!desc.writable : undefined,
      isData: data,
      value: data ? desc.value : undefined,
      get: desc.get,
      set: desc.set,
    });
  }
  return { keys: keys.slice(), records: records };
}

function assertSameGlobalRecord(before, after, label) {
  assert.equal(before.key, after.key, label + " key");
  assert.equal(before.isData, after.isData, label + " descriptor kind");
  assert.equal(before.enumerable, after.enumerable, label + " enumerable");
  assert.equal(before.configurable, after.configurable, label + " configurable");
  if (before.isData) {
    assert.equal(before.writable, after.writable, label + " writable");
    assert.equal(
      Object.is(before.value, after.value),
      true,
      label + " data identity"
    );
  } else {
    assert.equal(before.get, after.get, label + " getter identity");
    assert.equal(before.set, after.set, label + " setter identity");
  }
}

function assertAdapterExportShape(adapter, label) {
  assert.ok(adapter && typeof adapter === "object", label + " adapter object");
  assert.ok(Object.isFrozen(adapter), label + " adapter frozen");
  assertExactOwnKeys(adapter, ADAPTER_EXPORT_OWN_KEYS, label + " adapter");
  const d = ownDescriptorOrFail(
    adapter,
    "createBackgroundAdapters",
    label + " adapter"
  );
  assert.equal(isDataDescriptor(d), true, label + " create data");
  assert.equal(typeof d.value, "function", label + " create function");
  assert.ok(Object.isFrozen(d.value) || typeof d.value === "function", label);
}

function assertAdapterAddedExactlyOnce(before, after) {
  const expected = before.keys.concat(["McBackgroundAdapters"]);
  assert.deepEqual(
    after.keys,
    expected,
    "load adds only McBackgroundAdapters"
  );
  for (let i = 0; i < before.records.length; i++) {
    assertSameGlobalRecord(
      before.records[i],
      after.records[i],
      "load preexisting " + String(before.keys[i])
    );
  }
  const added = after.records[after.records.length - 1];
  assert.equal(added.key, "McBackgroundAdapters");
  assert.equal(added.isData, true, "McBackgroundAdapters data");
  assertAdapterExportShape(added.value, "post-load export");
}

function isEvidenceRecordShape(value) {
  if (!value || typeof value !== "object") return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2) return false;
  if (keys[0] !== "status" || keys[1] !== "providerKey") return false;
  for (let i = 0; i < keys.length; i++) {
    if (typeof keys[i] !== "string") return false;
    const d = Object.getOwnPropertyDescriptor(value, keys[i]);
    if (!isDataDescriptor(d)) return false;
    const v = d.value;
    if (v !== null && typeof v === "object") return false;
  }
  return true;
}

function assertLiveLookupShape(liveLookup, expected, label) {
  assert.ok(liveLookup && typeof liveLookup === "object", label + " live object");
  const keys = Reflect.ownKeys(liveLookup);
  assert.deepEqual(keys, EVIDENCE_OWN_KEYS.slice(), label + " live own-key sequence");
  for (let i = 0; i < keys.length; i++) {
    assert.equal(typeof keys[i], "string", label + " live no symbol");
    const d = Object.getOwnPropertyDescriptor(liveLookup, keys[i]);
    assert.ok(d, label + " live descriptor " + keys[i]);
    assert.equal(isDataDescriptor(d), true, label + " live data " + keys[i]);
    const flags = descriptorFlags(d);
    assert.equal(flags.enumerable, true, label + " live enumerable " + keys[i]);
    assert.equal(flags.writable, true, label + " live writable " + keys[i]);
    assert.equal(flags.configurable, true, label + " live configurable " + keys[i]);
    assert.equal(d.value, expected[keys[i]], label + " live value " + keys[i]);
  }
}

function assertPrivateEvidenceShape(privateEv, expected, label) {
  assert.ok(privateEv && typeof privateEv === "object", label + " private object");
  assert.ok(Object.isFrozen(privateEv), label + " private frozen");
  assertDeepFrozenSafe(privateEv, label + " private deep");
  const keys = Reflect.ownKeys(privateEv);
  assert.deepEqual(keys, EVIDENCE_OWN_KEYS.slice(), label + " private own-key sequence");
  for (let i = 0; i < keys.length; i++) {
    assert.equal(typeof keys[i], "string", label + " private no symbol");
    const d = Object.getOwnPropertyDescriptor(privateEv, keys[i]);
    assert.ok(d, label + " private descriptor " + keys[i]);
    assert.equal(isDataDescriptor(d), true, label + " private data " + keys[i]);
    const flags = descriptorFlags(d);
    assert.equal(flags.enumerable, true, label + " private enumerable " + keys[i]);
    assert.equal(flags.writable, false, label + " private nonwritable " + keys[i]);
    assert.equal(flags.configurable, false, label + " private nonconfigurable " + keys[i]);
    assert.equal(d.value, expected[keys[i]], label + " private value " + keys[i]);
  }
}

function assertFrozenEvidenceCopy(privateEv, liveLookup, expected, allLiveLookups, label) {
  assertPrivateEvidenceShape(privateEv, expected, label + " private");
  assertLiveLookupShape(liveLookup, expected, label + " live");
  assert.notEqual(privateEv, liveLookup, label + " nonidentical to its live lookup");
  const lives = allLiveLookups || [];
  for (let i = 0; i < lives.length; i++) {
    if (lives[i]) {
      assert.notEqual(
        privateEv,
        lives[i],
        label + " nonidentical to live[" + i + "]"
      );
    }
  }
}

function findProviderObservationMap(trackedMaps, mediaIds) {
  const expectedIds = mediaIds.slice();
  const matches = [];
  for (let i = 0; i < trackedMaps.length; i++) {
    const m = trackedMaps[i];
    if (!m || typeof m.get !== "function") continue;
    if (m.size !== expectedIds.length) continue;
    if (!Array.isArray(m._sets) || m._sets.length !== expectedIds.length) continue;
    let ok = true;
    for (let j = 0; j < expectedIds.length; j++) {
      const id = expectedIds[j];
      if (!m.has(id)) {
        ok = false;
        break;
      }
      if (!isEvidenceRecordShape(m.get(id))) {
        ok = false;
        break;
      }
      if (m._sets[j].key !== id) {
        ok = false;
        break;
      }
      if (m._sets[j].value !== m.get(id)) {
        ok = false;
        break;
      }
    }
    if (ok) matches.push(m);
  }
  if (matches.length !== 1) return null;
  return matches[0];
}

function assertObservationMapExact(trackedMaps, mediaIds, liveById, expectedById, label) {
  const map = findProviderObservationMap(trackedMaps, mediaIds);
  assert.ok(map, label + " unique causal observation map");
  assert.equal(map.size, mediaIds.length, label + " current size");
  assert.equal(map._sets.length, mediaIds.length, label + " entire _sets history");
  const allLives = [];
  for (let i = 0; i < mediaIds.length; i++) {
    const live = liveById[mediaIds[i]];
    if (live) allLives.push(live);
  }
  for (let i = 0; i < mediaIds.length; i++) {
    const id = mediaIds[i];
    assert.equal(map._sets[i].key, id, label + " history key order " + i);
    assert.equal(map._sets[i].value, map.get(id), label + " history value identity " + i);
    assertFrozenEvidenceCopy(
      map.get(id),
      liveById[id],
      expectedById[id],
      allLives,
      label + " media " + id
    );
  }
  return map;
}

function assertNoneEvidenceOnly(trackedMaps, mediaId, label) {
  const map = findProviderObservationMap(trackedMaps, [mediaId]);
  assert.ok(map, label + " none evidence map");
  assert.equal(map.size, 1, label + " size");
  assert.equal(map._sets.length, 1, label + " entire _sets history");
  assert.equal(map._sets[0].key, mediaId, label + " history key");
  assert.equal(map._sets[0].value, map.get(mediaId), label + " history value");
  assertPrivateEvidenceShape(
    map.get(mediaId),
    { status: "none", providerKey: null },
    label
  );
  return map;
}

function assertPublicSurfacePrivacy(surfaces, forbiddenSubstrings, label) {
  const blob = surfaces
    .map((s) => {
      try {
        return JSON.stringify(s);
      } catch (e) {
        return String(s);
      }
    })
    .join("\n");
  for (let i = 0; i < forbiddenSubstrings.length; i++) {
    const s = forbiddenSubstrings[i];
    assert.equal(
      blob.includes(s),
      false,
      label + " must not contain " + s
    );
  }
}

function buildPrivacyScanContext(opts) {
  const forbiddenStrings = (opts.forbiddenStrings || []).slice();
  const forbiddenRefs = new Set(opts.forbiddenRefs || []);
  const forbiddenKeys = new Set(FORBIDDEN_PUBLIC_KEYS);
  const trustedErrors = new Set(opts.trustedErrors || []);
  const privacyHandles = new Set(opts.privacyHandles || []);
  return {
    forbiddenStrings: forbiddenStrings,
    forbiddenRefs: forbiddenRefs,
    forbiddenKeys: forbiddenKeys,
    trustedErrors: trustedErrors,
    privacyHandles: privacyHandles,
  };
}

function assertNoForbiddenString(text, ctx, path) {
  if (typeof text !== "string") return;
  for (let i = 0; i < ctx.forbiddenStrings.length; i++) {
    const s = ctx.forbiddenStrings[i];
    assert.equal(text.includes(s), false, path + " must not contain " + s);
  }
}

function assertTrustedErrorShape(err, ctx, path) {
  assert.equal(ctx.trustedErrors.has(err), true, path + " Error must be trusted capture");
  let proto;
  try {
    proto = Object.getPrototypeOf(err);
  } catch (e) {
    assert.fail(path + " Error prototype inspection failed");
  }
  assert.equal(proto === Error.prototype, true, path + " Error prototype");
  const keys = ownKeysOrFail(err, path);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k === Symbol.toStringTag) {
      assert.fail(path + " must not rely on toStringTag");
    }
    const desc = ownDescriptorOrFail(err, k, path);
    if (isAccessorDescriptor(desc)) {
      continue;
    }
    if (!isDataDescriptor(desc)) {
      assert.fail(path + " Error non-data descriptor " + String(k));
    }
    if (k === "message") {
      assert.equal(typeof desc.value, "string", path + " Error message data");
      assert.equal(desc.value.length > 0, true, path + " Error message nonempty");
      assertNoForbiddenString(desc.value, ctx, path + ".message");
    }
  }
}

function assertDeepFrozenSafe(value, label, opts) {
  const options = opts || {};
  const seen = new Set();
  const trustedErrors = options.trustedErrors || new Set();
  const privacyHandles = options.privacyHandles || new Set();
  function walk(cur, path) {
    if (cur === null || cur === undefined) return;
    const t = typeof cur;
    if (t !== "object" && t !== "function") return;
    if (seen.has(cur)) return;
    seen.add(cur);
    assert.ok(Object.isFrozen(cur), path + " must be frozen");
    if (privacyHandles.has(cur)) {
      assertPrivacyHandleShape(cur, path);
      return;
    }
    if (trustedErrors.has(cur)) {
      const keys = ownKeysOrFail(cur, path);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const desc = ownDescriptorOrFail(cur, k, path);
        if (isAccessorDescriptor(desc)) {
          assert.fail(path + " accessor " + String(k));
        }
        if (!isDataDescriptor(desc)) {
          assert.fail(path + " non-data descriptor " + String(k));
        }
        walk(desc.value, path + "." + String(k));
      }
      return;
    }
    if (utilTypes.isMap(cur) || utilTypes.isSet(cur)) {
      assert.fail(path + " unexpected Map/Set in frozen graph");
    }
    if (t === "function") {
      assert.fail(path + " unexpected function in frozen graph");
    }
    const keys = ownKeysOrFail(cur, path);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const desc = ownDescriptorOrFail(cur, k, path);
      if (isAccessorDescriptor(desc)) {
        assert.fail(path + " accessor before recurse " + String(k));
      }
      if (!isDataDescriptor(desc)) {
        assert.fail(path + " non-data descriptor " + String(k));
      }
      walk(desc.value, path + "." + String(k));
    }
  }
  walk(value, label);
}

function scanPublicGraph(value, ctx, label) {
  const seen = new Set();
  const stack = [{ value: value, path: label }];
  while (stack.length > 0) {
    const item = stack.pop();
    const cur = item.value;
    const path = item.path;
    if (cur === null || cur === undefined) continue;
    const t = typeof cur;
    if (t === "string") {
      assertNoForbiddenString(cur, ctx, path);
      continue;
    }
    if (t === "function") {
      assert.fail(path + " unexpected function in public graph");
    }
    if (t !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (ctx.forbiddenRefs.has(cur)) {
      assert.fail(path + " leaked forbidden identity");
    }
    if (ctx.privacyHandles && ctx.privacyHandles.has(cur)) {
      assert.fail(path + " leaked Privacy handle");
    }
    if (utilTypes.isMap(cur) || utilTypes.isSet(cur)) {
      assert.fail(path + " Map/Set in public graph");
    }
    if (ctx.trustedErrors && ctx.trustedErrors.has(cur)) {
      assertTrustedErrorShape(cur, ctx, path);
      const errKeys = ownKeysOrFail(cur, path);
      for (let i = 0; i < errKeys.length; i++) {
        const k = errKeys[i];
        const desc = ownDescriptorOrFail(cur, k, path);
        if (isAccessorDescriptor(desc)) continue;
        stack.push({ value: desc.value, path: path + "." + String(k) });
      }
      continue;
    }
    const keys = ownKeysOrFail(cur, path);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (typeof k === "symbol") {
        assert.fail(path + " unexpected symbol key");
      }
      if (typeof k === "string" && ctx.forbiddenKeys.has(k)) {
        assert.fail(path + " forbidden key " + k);
      }
      if (typeof k === "string") {
        assertNoForbiddenString(k, ctx, path + " key");
      }
      const desc = ownDescriptorOrFail(cur, k, path);
      if (isAccessorDescriptor(desc)) {
        assert.fail(path + " accessor descriptor " + String(k));
      }
      if (!isDataDescriptor(desc)) {
        assert.fail(path + " non-data descriptor " + String(k));
      }
      stack.push({ value: desc.value, path: path + "." + String(k) });
    }
  }
}

function scanAllEffectArgs(fx, ctx, label) {
  const names = [
    "postNative",
    "downloadsDownload",
    "createObjectURL",
    "revokeObjectURL",
    "fetchArrayBuffer",
    "assembleMedia",
    "isPopupSender",
    "getEffectiveDestinationDirectory",
    "publishDetection",
    "publishJobs",
    "persistHistory",
    "reportDiagnostic",
    "randomToken",
    "now",
  ];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const logs = fx.effectArgs[name];
    assert.equal(
      logs.length,
      fx.counts[name],
      label + " " + name + " args match counts"
    );
    if (ZERO_CALL_EFFECTS.indexOf(name) !== -1) {
      assert.equal(logs.length, 0, label + " " + name + " args empty");
    }
    for (let j = 0; j < logs.length; j++) {
      scanPublicGraph(logs[j], ctx, label + " " + name + "[" + j + "]");
    }
  }
}

function createRootChecker(inst, ctx) {
  function check(label) {
    assert.ok(inst.globalsBeforeLoad, label + " globalsBeforeLoad captured");
    assert.ok(inst.globalsAfterLoad, label + " globalsAfterLoad captured");
    assertRootGlobalsStable(
      inst,
      snapshotRootOwnGlobals(inst.root),
      ctx,
      label
    );
  }
  return {
    check: check,
    after: function (label, fn) {
      const result = fn();
      check(label);
      return result;
    },
  };
}

function assertRootGlobalsStable(inst, after, ctx, label) {
  assert.ok(inst.globalsBeforeLoad, label + " globalsBeforeLoad captured");
  const before = inst.globalsAfterLoad;
  assert.deepEqual(after.keys, before.keys, label + " root own-key sequence");
  assert.equal(after.records.length, before.records.length, label + " record count");
  for (let i = 0; i < before.records.length; i++) {
    const rec = after.records[i];
    assertSameGlobalRecord(
      before.records[i],
      rec,
      label + " " + String(before.records[i].key)
    );
    if (rec.isData && typeof rec.value === "string") {
      for (let s = 0; s < ctx.forbiddenStrings.length; s++) {
        assert.equal(
          rec.value.includes(ctx.forbiddenStrings[s]),
          false,
          label + " global string " + String(rec.key)
        );
      }
    }
    if (rec.isData && ctx.forbiddenRefs.has(rec.value)) {
      assert.fail(label + " global holds forbidden ref " + String(rec.key));
    }
  }
  assertAdapterExportShape(inst.root.McBackgroundAdapters, label);
}

function assertOneDependencyDiagnostic(diagnostic, expectedMediaId, thrownError, label) {
  assert.ok(diagnostic && typeof diagnostic === "object", label + " diagnostic object");
  assert.notEqual(diagnostic, thrownError, label + " diagnostic is not the thrown Error");
  assert.ok(Object.isFrozen(diagnostic), label + " diagnostic frozen");
  assertDeepFrozenSafe(diagnostic, label + " diagnostic deep");
  assert.equal(isOrdinaryObject(diagnostic), true, label + " ordinary object");
  const keys = ownKeysOrFail(diagnostic, label);
  if (keys.length === 2) {
    assert.deepEqual(keys, DIAGNOSTIC_KEYS_2.slice(), label + " keys code,scope");
  } else {
    assert.deepEqual(keys, DIAGNOSTIC_KEYS_3.slice(), label + " keys code,scope,id");
  }
  for (let i = 0; i < keys.length; i++) {
    assert.equal(typeof keys[i], "string", label + " no symbol");
    const d = ownDescriptorOrFail(diagnostic, keys[i], label);
    assertFrozenDataDesc(d, { enumerable: true }, label + " " + keys[i]);
  }
  const codeDesc = ownDescriptorOrFail(diagnostic, "code", label);
  const scopeDesc = ownDescriptorOrFail(diagnostic, "scope", label);
  assert.equal(typeof codeDesc.value, "string", label + " code primitive");
  assert.equal(DIAGNOSTIC_CODE_RE.test(codeDesc.value), true, label + " code token");
  assert.equal(codeDesc.value.length <= 64, true, label + " code bound");
  assert.equal(scopeDesc.value, "background-adapters", label + " scope");
  if (keys.length === 3) {
    const idDesc = ownDescriptorOrFail(diagnostic, "id", label);
    assert.equal(idDesc.value, expectedMediaId, label + " id is fixture mediaId");
    assert.equal(typeof idDesc.value, "string", label + " id primitive");
    assert.equal(idDesc.value.length <= 128, true, label + " id bound");
  }
  assert.equal(keys.indexOf("message") === -1, true, label + " no message");
  assert.equal(keys.indexOf("cause") === -1, true, label + " no cause");
  assert.equal(keys.indexOf("stack") === -1, true, label + " no stack");
}

function assertSafeDiagnostics(diagnostics, expectedMediaId, thrownError, label) {
  if (diagnostics.length === 0) return null;
  assert.equal(diagnostics.length, 1, label + " only one diagnostic");
  assertOneDependencyDiagnostic(
    diagnostics[0],
    expectedMediaId,
    thrownError,
    label
  );
  return diagnostics[0];
}

function assertDependencyDiagnosticAgreement(fx, inst, expectedMediaId, thrownError, label) {
  const diag = assertSafeDiagnostics(
    fx.diagnostics,
    expectedMediaId,
    thrownError,
    label
  );
  const reports = fx.effectArgs.reportDiagnostic;
  if (diag == null) {
    assert.equal(reports.length, 0, label + " no reportDiagnostic");
    return null;
  }
  assert.equal(reports.length, 1, label + " one reportDiagnostic");
  assert.equal(reports[0].length, 1, label + " one report argument");
  assert.equal(reports[0][0], diag, label + " report argument is the diagnostic");
  return diag;
}

function assertPrivacyHandleShape(handle, label) {
  assert.ok(handle && typeof handle === "object", label + " handle object");
  assert.ok(Object.isFrozen(handle), label + " handle frozen");
  assertExactOwnKeys(handle, PRIVACY_HANDLE_OWN_KEYS, label);
  const urlDesc = ownDescriptorOrFail(handle, "mediaUrl", label);
  const hdrDesc = ownDescriptorOrFail(handle, "requestHeaders", label);
  const clrDesc = ownDescriptorOrFail(handle, "clear", label);
  assert.equal(isAccessorDescriptor(urlDesc), true, label + " mediaUrl accessor");
  assert.equal(isAccessorDescriptor(hdrDesc), true, label + " requestHeaders accessor");
  assert.equal(!!urlDesc.enumerable, false, label + " mediaUrl non-enumerable");
  assert.equal(!!hdrDesc.enumerable, false, label + " requestHeaders non-enumerable");
  assert.equal(!!urlDesc.configurable, false, label + " mediaUrl nonconfigurable");
  assert.equal(!!hdrDesc.configurable, false, label + " requestHeaders nonconfigurable");
  assert.equal(typeof urlDesc.get, "function", label + " mediaUrl getter");
  assert.equal(typeof hdrDesc.get, "function", label + " requestHeaders getter");
  assert.equal(urlDesc.set, undefined, label + " mediaUrl no setter");
  assert.equal(hdrDesc.set, undefined, label + " requestHeaders no setter");
  assertFrozenDataDesc(clrDesc, { enumerable: false }, label + " clear");
  assert.equal(typeof clrDesc.value, "function", label + " clear function");
}

function sessionFinalizer(inst) {
  const wm = inst.controllerWatermarks[0];
  assert.ok(wm, "controller watermark");
  const fin = inst.finalizerInstances[wm.finStart];
  assert.ok(fin, "session finalizer");
  return fin;
}

function finalizedItemForDetection(inst, detectionId, label) {
  const items = sessionFinalizer(inst).listFinalized();
  let found = null;
  for (let i = 0; i < items.length; i++) {
    if (items[i] && items[i].detectionId === detectionId) {
      assert.equal(found, null, label + " unique finalized item");
      found = items[i];
    }
  }
  assert.ok(found, label + " finalized item for detection " + detectionId);
  return found;
}

function associatePrivacyInterval(inst, startIndex, expectedCount, assoc, label) {
  const slice = inst.privacyObservations.slice(startIndex);
  assert.equal(
    slice.length,
    expectedCount,
    label + " Privacy call interval count"
  );
  if (expectedCount === 1) {
    const obs = slice[0];
    const rec = Object.freeze({
      kind: assoc.kind,
      mediaId: assoc.mediaId,
      detectionId: assoc.detectionId,
      variantId: assoc.variantId,
      callIndex: obs.callIndex,
      handle: obs.handle,
      mediaUrl: obs.mediaUrl,
      requestHeaders: obs.requestHeaders,
    });
    if (assoc.kind === "variant") {
      inst.variantAssociations.push(rec);
    } else {
      inst.captureAssociations.push(rec);
    }
    return rec;
  }
  const out = [];
  for (let i = 0; i < slice.length; i++) {
    const obs = slice[i];
    out.push(
      Object.freeze({
        kind: assoc.kind,
        mediaId: assoc.mediaId,
        variantId: assoc.variantIds ? assoc.variantIds[i] : assoc.variantId,
        callIndex: obs.callIndex,
        handle: obs.handle,
        mediaUrl: obs.mediaUrl,
        requestHeaders: obs.requestHeaders,
      })
    );
  }
  if (assoc.kind === "variant") {
    for (let i = 0; i < out.length; i++) inst.variantAssociations.push(out[i]);
  }
  return out;
}

function captureAssociationForMedia(inst, mediaId, label) {
  const hits = [];
  for (let i = 0; i < inst.captureAssociations.length; i++) {
    if (inst.captureAssociations[i].mediaId === mediaId) {
      hits.push(inst.captureAssociations[i]);
    }
  }
  assert.equal(hits.length, 1, label + " unique capture Privacy association");
  return hits[0];
}

function variantAssociationForLiteralId(inst, variantId, label) {
  const hits = [];
  for (let i = 0; i < inst.variantAssociations.length; i++) {
    if (inst.variantAssociations[i].variantId === variantId) {
      hits.push(inst.variantAssociations[i]);
    }
  }
  assert.equal(hits.length, 1, label + " unique variant Privacy association");
  return hits[0];
}

function considerMediaRecordCandidate(value, spec, hits, seen, label) {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  let keys;
  try {
    keys = ownKeysOrFail(value, label + " candidate");
  } catch (e) {
    assert.fail(label + " candidate ownKeys failed");
  }
  let idDesc;
  try {
    idDesc = Object.getOwnPropertyDescriptor(value, "mediaId");
  } catch (e) {
    assert.fail(label + " candidate mediaId descriptor failed");
  }
  if (!idDesc || !isDataDescriptor(idDesc) || idDesc.value !== spec.mediaId) {
    return;
  }
  for (let i = 0; i < keys.length; i++) {
    ownDescriptorOrFail(value, keys[i], label + " candidate");
  }
  const want = spec.hasFutureTransport
    ? MEDIA_RECORD_OWN_KEYS_FT.slice()
    : MEDIA_RECORD_OWN_KEYS.slice();
  if (spec.hasFutureTransport) {
    if (!keysEqualExact(keys, MEDIA_RECORD_OWN_KEYS_FT.slice())) {
      assert.fail(
        label +
          " FT mediaId owner has hidden/reordered/extra/missing keys (not a skipped candidate)"
      );
    }
  } else if (keysEqualExact(keys, MEDIA_RECORD_OWN_KEYS.slice())) {
    // exact 8-key no-FT form
  } else if (keysEqualExact(keys, MEDIA_RECORD_OWN_KEYS_FT.slice())) {
    const ftDesc = ownDescriptorOrFail(value, "futureTransport", label + " no-FT ft");
    if (!isDataDescriptor(ftDesc)) {
      assert.fail(label + " no-FT futureTransport must be data");
    }
    const ft = ftDesc.value;
    if (!ft || typeof ft !== "object" || !Object.isFrozen(ft) || !isOrdinaryObject(ft)) {
      assert.fail(label + " no-FT empty futureTransport object");
    }
    const ftKeys = ownKeysOrFail(ft, label + " no-FT ft keys");
    if (ftKeys.indexOf("variants") !== -1) {
      assert.fail(label + " no-FT record must not carry variants-bearing futureTransport");
    }
  } else {
    assert.fail(
      label +
        " mediaId owner has hidden/reordered/extra/missing keys (not a skipped candidate)"
    );
  }
  seen.add(value);
  hits.push(value);
}

function locateSourcesByMediaIdOwner(inst, mediaId, label) {
  const wm = inst.controllerWatermarks[0];
  assert.ok(wm, label + " controller watermark");
  const maps = inst.trackedMaps.slice(wm.mapStart, wm.mapEnd);
  const hits = [];
  for (let i = 0; i < maps.length; i++) {
    const m = maps[i];
    if (!m.has(mediaId)) continue;
    const value = m.get(mediaId);
    if (value === null || typeof value !== "object") continue;
    if (utilTypes.isMap(value) || utilTypes.isSet(value) || Array.isArray(value)) {
      continue;
    }
    let keys;
    try {
      keys = ownKeysOrFail(value, label + " owner probe");
    } catch (e) {
      assert.fail(label + " owner probe ownKeys failed");
    }
    if (keys[0] !== "mediaId") continue;
    hits.push(m);
  }
  assert.equal(hits.length, 1, label + " unique sourcesByMediaId owner map");
  return hits[0];
}

function findPrivateMediaRecord(inst, spec, label) {
  const owner = locateSourcesByMediaIdOwner(inst, spec.mediaId, label);
  assert.equal(owner.has(spec.mediaId), true, label + " owner has mediaId");
  const current = owner.get(spec.mediaId);
  const hits = [];
  const seen = new Set();
  considerMediaRecordCandidate(current, spec, hits, seen, label);
  let histIter;
  try {
    histIter = owner._sets || [];
  } catch (e) {
    assert.fail(label + " owner history inspection failed");
  }
  for (let s = 0; s < histIter.length; s++) {
    if (histIter[s].op === "set" && histIter[s].key === spec.mediaId) {
      considerMediaRecordCandidate(histIter[s].value, spec, hits, seen, label);
    }
  }
  assert.equal(hits.length, 1, label + " exactly one private media candidate");
  assert.equal(hits[0], current, label + " candidate is owner current value");
  assert.equal(owner.get(spec.mediaId), hits[0], label + " owner key/value identity");
  return hits[0];
}

function assertSourceContextShape(ctx, label) {
  assert.ok(ctx && typeof ctx === "object", label + " sourceContext object");
  assert.ok(Object.isFrozen(ctx), label + " sourceContext frozen");
  assert.equal(isOrdinaryObject(ctx), true, label + " sourceContext ordinary");
  assertExactOwnKeys(ctx, SOURCE_CONTEXT_OWN_KEYS, label + " sourceContext");
  for (let i = 0; i < SOURCE_CONTEXT_OWN_KEYS.length; i++) {
    const k = SOURCE_CONTEXT_OWN_KEYS[i];
    const d = ownDescriptorOrFail(ctx, k, label + " sourceContext");
    assertFrozenDataDesc(d, { enumerable: true }, label + " sourceContext." + k);
  }
}

function assertPrivateMediaShape(record, expected, inst, label) {
  assert.ok(record && typeof record === "object", label + " media object");
  assert.ok(Object.isFrozen(record), label + " media frozen");
  assert.equal(isOrdinaryObject(record), true, label + " ordinary record");
  const keys = ownKeysOrFail(record, label);
  const eight = MEDIA_RECORD_OWN_KEYS.slice();
  const nine = MEDIA_RECORD_OWN_KEYS_FT.slice();
  if (expected.hasFutureTransport) {
    assertExactOwnKeys(record, nine, label);
  } else if (keysEqualExact(keys, eight)) {
    assertExactOwnKeys(record, eight, label);
  } else if (keysEqualExact(keys, nine)) {
    assertExactOwnKeys(record, nine, label);
  } else {
    assert.fail(label + " no-FT record key sequence");
  }
  const want = expected.hasFutureTransport || keysEqualExact(keys, nine) ? nine : eight;
  for (let i = 0; i < want.length; i++) {
    const k = want[i];
    const d = ownDescriptorOrFail(record, k, label);
    const enumerable = i < 6;
    assertFrozenDataDesc(d, { enumerable: enumerable }, label + " " + k);
  }
  const mediaIdDesc = ownDescriptorOrFail(record, "mediaId", label);
  const fileDesc = ownDescriptorOrFail(record, "proposedFilename", label);
  const kindDesc = ownDescriptorOrFail(record, "mediaKind", label);
  const provDesc = ownDescriptorOrFail(record, "providerKey", label);
  const tabDesc = ownDescriptorOrFail(record, "tabId", label);
  const detDesc = ownDescriptorOrFail(record, "detectionId", label);
  assert.equal(mediaIdDesc.value, expected.mediaId, label + " mediaId");
  assert.equal(fileDesc.value, expected.proposedFilename, label + " filename");
  assert.equal(kindDesc.value, expected.mediaKind, label + " mediaKind");
  assert.equal(provDesc.value, expected.providerKey, label + " providerKey");
  assert.equal(tabDesc.value, expected.tabId, label + " tabId");
  assert.equal(detDesc.value, expected.detectionId, label + " detectionId");
  const finalized = finalizedItemForDetection(inst, expected.detectionId, label);
  const scDesc = ownDescriptorOrFail(record, "sourceContext", label);
  if (inst.originOverrides && inst.originOverrides.has(expected.detectionId)) {
    assertSourceContextShape(scDesc.value, label);
    const moDesc = ownDescriptorOrFail(scDesc.value, "mediaOrigin", label);
    assert.equal(
      Object.is(moDesc.value, inst.originOverrides.get(expected.detectionId)),
      true,
      label + " override mediaOrigin identity"
    );
  } else {
    assert.equal(
      scDesc.value,
      finalized.sourceContext,
      label + " sourceContext identity"
    );
    assertSourceContextShape(scDesc.value, label);
  }
  const assoc = captureAssociationForMedia(inst, expected.mediaId, label);
  const ephDesc = ownDescriptorOrFail(record, "ephemeral", label);
  assert.equal(ephDesc.value, assoc.handle, label + " ephemeral identity");
  assertPrivacyHandleShape(ephDesc.value, label + " ephemeral");
  if (expected.hasFutureTransport) {
    const ftDesc = ownDescriptorOrFail(record, "futureTransport", label);
    assertFrozenDataDesc(ftDesc, { enumerable: false }, label + " futureTransport");
  } else if (keysEqualExact(keys, nine)) {
    const ftDesc = ownDescriptorOrFail(record, "futureTransport", label);
    assertFrozenDataDesc(ftDesc, { enumerable: false }, label + " empty futureTransport");
    const emptyFt = ftDesc.value;
    assert.ok(emptyFt && typeof emptyFt === "object", label + " empty ft object");
    assert.ok(Object.isFrozen(emptyFt), label + " empty ft frozen");
    assert.equal(isOrdinaryObject(emptyFt), true, label + " empty ft ordinary");
    assertExactOwnKeys(emptyFt, [], label + " empty ft has no variants");
  } else {
    assert.equal(keys.indexOf("futureTransport"), -1, label + " no-FT omits futureTransport");
  }
}

function snapshotFutureTransportComplete(record, label) {
  const recDesc = ownDescriptorOrFail(record, "futureTransport", label);
  assertFrozenDataDesc(recDesc, { enumerable: false }, label + " ft record desc");
  const ft = recDesc.value;
  assert.ok(ft && typeof ft === "object", label + " ft object");
  assert.ok(Object.isFrozen(ft), label + " ft frozen");
  assert.equal(isOrdinaryObject(ft), true, label + " ft ordinary");
  assertExactOwnKeys(ft, FUTURE_TRANSPORT_OWN_KEYS, label + " ft");
  const variantsDesc = ownDescriptorOrFail(ft, "variants", label + " ft");
  assertFrozenDataDesc(variantsDesc, { enumerable: true }, label + " variants desc");
  const arr = variantsDesc.value;
  assert.ok(Array.isArray(arr), label + " variants array");
  assert.ok(Object.isFrozen(arr), label + " variants frozen");
  assertExactOwnKeys(arr, FT_VARIANTS_OWN_KEYS, label + " variants ownKeys");
  const idxDesc = ownDescriptorOrFail(arr, "0", label + " variants[0]");
  const lenDesc = ownDescriptorOrFail(arr, "length", label + " variants.length");
  assertFrozenDataDesc(idxDesc, { enumerable: true }, label + " variants[0]");
  assertFrozenDataDesc(lenDesc, { enumerable: false }, label + " variants.length");
  assert.equal(lenDesc.value, 1, label + " variants length");
  const cand = idxDesc.value;
  assert.ok(cand && typeof cand === "object", label + " candidate object");
  assert.ok(Object.isFrozen(cand), label + " candidate frozen");
  assert.equal(isOrdinaryObject(cand), true, label + " candidate ordinary");
  assertExactOwnKeys(cand, FT_CANDIDATE_OWN_KEYS, label + " candidate");
  const urlDesc = ownDescriptorOrFail(cand, "url", label + " candidate");
  const labDesc = ownDescriptorOrFail(cand, "label", label + " candidate");
  assertFrozenDataDesc(urlDesc, { enumerable: true }, label + " candidate.url");
  assertFrozenDataDesc(labDesc, { enumerable: true }, label + " candidate.label");
  assertDeepFrozenSafe(ft, label + " ft deep");
  return Object.freeze({
    recDesc: recDesc,
    ft: ft,
    variantsDesc: variantsDesc,
    arr: arr,
    idxDesc: idxDesc,
    lenDesc: lenDesc,
    cand: cand,
    urlDesc: urlDesc,
    labDesc: labDesc,
    url: urlDesc.value,
    label: labDesc.value,
  });
}

function assertDescriptorIdentity(a, b, label) {
  assert.equal(!!a.enumerable, !!b.enumerable, label + " enumerable");
  assert.equal(!!a.writable, !!b.writable, label + " writable");
  assert.equal(!!a.configurable, !!b.configurable, label + " configurable");
  assert.equal(isDataDescriptor(a), isDataDescriptor(b), label + " kind");
  assert.equal(Object.is(a.value, b.value), true, label + " value identity");
}

function assertFutureTransportSnapshotsEqual(a, b, label) {
  assert.equal(a.ft, b.ft, label + " ft identity");
  assert.equal(a.arr, b.arr, label + " variants identity");
  assert.equal(a.cand, b.cand, label + " candidate identity");
  assertDescriptorIdentity(a.recDesc, b.recDesc, label + " recDesc");
  assertDescriptorIdentity(a.variantsDesc, b.variantsDesc, label + " variantsDesc");
  assertDescriptorIdentity(a.idxDesc, b.idxDesc, label + " idxDesc");
  assertDescriptorIdentity(a.lenDesc, b.lenDesc, label + " lenDesc");
  assertDescriptorIdentity(a.urlDesc, b.urlDesc, label + " urlDesc");
  assertDescriptorIdentity(a.labDesc, b.labDesc, label + " labDesc");
  assert.equal(a.url, b.url, label + " url value");
  assert.equal(a.label, b.label, label + " label value");
  assert.ok(Object.isFrozen(a.ft), label + " ft still frozen");
  assert.ok(Object.isFrozen(a.arr), label + " arr still frozen");
  assert.ok(Object.isFrozen(a.cand), label + " cand still frozen");
}

function assertFutureTransportExact(record, fixture, caller, label) {
  const snap = snapshotFutureTransportComplete(record, label);
  assert.equal(snap.url, fixture.url, label + " retained url");
  assert.equal(snap.label, fixture.label, label + " retained label");
  assert.notEqual(snap.ft, caller.transport, label + " nonidentity transport");
  assert.notEqual(snap.arr, caller.variants, label + " nonidentity variants array");
  assert.notEqual(snap.cand, caller.candidate, label + " nonidentity candidate");
  return snap;
}

function assertFutureTransportUnchanged(record, snap, label) {
  const next = snapshotFutureTransportComplete(record, label);
  assertFutureTransportSnapshotsEqual(next, snap, label);
}

function assertPrivateVariantRecord(record, expected, inst, label) {
  assert.ok(record && typeof record === "object", label + " variant object");
  assert.ok(Object.isFrozen(record), label + " variant frozen");
  assert.equal(isOrdinaryObject(record), true, label + " variant ordinary");
  assertExactOwnKeys(record, VARIANT_RECORD_KEYS, label + " variant");
  const projDesc = ownDescriptorOrFail(record, "safeProjection", label);
  const hDesc = ownDescriptorOrFail(record, "sourceHandle", label);
  assertFrozenDataDesc(projDesc, { enumerable: true }, label + " safeProjection");
  assertFrozenDataDesc(hDesc, { enumerable: true }, label + " sourceHandle");
  const proj = projDesc.value;
  assert.ok(Object.isFrozen(proj), label + " projection frozen");
  const wantKeys = ["id"].concat(expected.extraKeys || []);
  assertExactOwnKeys(proj, wantKeys, label + " projection");
  for (let i = 0; i < wantKeys.length; i++) {
    const d = ownDescriptorOrFail(proj, wantKeys[i], label + " projection");
    assertFrozenDataDesc(d, { enumerable: true }, label + " projection." + wantKeys[i]);
  }
  const idDesc = ownDescriptorOrFail(proj, "id", label + " projection");
  assert.equal(typeof idDesc.value, "string", label + " projection id");
  assert.equal(idDesc.value, expected.literalId, label + " projection id equals literal");
  assert.equal(
    Object.is(idDesc.value, expected.literalId),
    true,
    label + " projection id identity"
  );
  if (expected.label != null) {
    const lDesc = ownDescriptorOrFail(proj, "label", label + " projection");
    assert.equal(lDesc.value, expected.label, label + " projection label");
  }
  const assoc = variantAssociationForLiteralId(inst, expected.literalId, label);
  assert.equal(hDesc.value, assoc.handle, label + " sourceHandle identity");
  assertPrivacyHandleShape(hDesc.value, label + " sourceHandle");
  assertDeepFrozenSafe(proj, label + " projection deep", {
    privacyHandles: new Set(),
  });
}

function locateVariantsOrderedOwner(inst, mediaId, label) {
  const wm = inst.controllerWatermarks[0];
  assert.ok(wm, label + " controller watermark");
  const maps = inst.trackedMaps.slice(wm.mapStart, wm.mapEnd);
  const hits = [];
  for (let i = 0; i < maps.length; i++) {
    const m = maps[i];
    if (!m.has(mediaId)) continue;
    const value = m.get(mediaId);
    if (!Array.isArray(value)) continue;
    if (value.length === 0) continue;
    let recDesc;
    try {
      recDesc = Object.getOwnPropertyDescriptor(value, "0");
    } catch (e) {
      assert.fail(label + " variant[0] descriptor failed");
    }
    if (!recDesc || !isDataDescriptor(recDesc)) continue;
    const rec = recDesc.value;
    if (!rec || typeof rec !== "object") continue;
    const keys = ownKeysOrFail(rec, label + " variant probe");
    if (!keysEqualExact(keys, VARIANT_RECORD_KEYS.slice())) continue;
    hits.push(m);
  }
  assert.equal(hits.length, 1, label + " unique variantsOrderedByMediaId owner");
  return hits[0];
}

function findPrivateVariantRecords(inst, mediaId, expectedCount, label) {
  const owner = locateVariantsOrderedOwner(inst, mediaId, label);
  assert.equal(owner.has(mediaId), true, label + " owner has mediaId");
  const arr = owner.get(mediaId);
  assert.ok(Array.isArray(arr), label + " ordered variant array");
  assert.ok(Object.isFrozen(arr), label + " ordered variant array frozen");
  const recs = [];
  const arrKeys = ownKeysOrFail(arr, label + " variant array");
  const expectedArrKeys = [];
  for (let i = 0; i < expectedCount; i++) expectedArrKeys.push(String(i));
  expectedArrKeys.push("length");
  assert.deepEqual(arrKeys, expectedArrKeys, label + " variant array keys");
  for (let j = 0; j < expectedCount; j++) {
    const idxDesc = ownDescriptorOrFail(arr, String(j), label + " variant[" + j + "]");
    assertFrozenDataDesc(idxDesc, { enumerable: true }, label + " variant[" + j + "]");
    const rec = idxDesc.value;
    const keys = ownKeysOrFail(rec, label + " variant[" + j + "]");
    assert.equal(
      keysEqualExact(keys, VARIANT_RECORD_KEYS.slice()),
      true,
      label + " variant[" + j + "] keys"
    );
    recs.push(rec);
  }
  assert.equal(recs.length, expectedCount, label + " variant count");
  return recs;
}

function mapValuesAreAllSets(map) {
  let iter;
  try {
    iter = map.values();
  } catch (e) {
    return false;
  }
  let any = false;
  for (const v of iter) {
    any = true;
    if (!utilTypes.isSet(v)) return false;
  }
  return true;
}

function currentKeys(map) {
  const keys = [];
  let iter;
  try {
    iter = map.keys();
  } catch (e) {
    assert.fail("map keys iteration failed");
  }
  for (const k of iter) keys.push(k);
  return keys;
}

function currentSetValues(set) {
  const values = [];
  let iter;
  try {
    iter = set.values();
  } catch (e) {
    assert.fail("set values iteration failed");
  }
  for (const v of iter) values.push(v);
  return values;
}

function isEmptyZeroHistoryMap(map) {
  return (
    map.size === 0 &&
    map._sets.length === 0 &&
    map._deletes.length === 0 &&
    map._clears.length === 0
  );
}

function isEmptyZeroHistorySet(set) {
  return (
    set.size === 0 &&
    set._adds.length === 0 &&
    set._deletes.length === 0 &&
    set._clears.length === 0
  );
}

function classifyObservedContainers(inst, spec, label) {
  const wm = inst.controllerWatermarks[0];
  assert.ok(wm, label + " watermark");
  const constructionMaps = inst.trackedMaps.slice(wm.mapStart, wm.mapEnd);
  const constructionSets = inst.trackedSets.slice(wm.setStart, wm.setEnd);
  const laterMaps = inst.trackedMaps.slice(wm.mapEnd);
  const laterSets = inst.trackedSets.slice(wm.setEnd);
  assert.equal(
    constructionMaps.length,
    CONTROLLER_CONSTRUCTION_MAPS,
    label + " construction map count"
  );
  assert.equal(
    constructionSets.length,
    CONTROLLER_CONSTRUCTION_SETS,
    label + " construction set count"
  );
  assert.equal(
    inst.trackedMaps.length,
    constructionMaps.length + laterMaps.length,
    label + " observed Map total"
  );
  assert.equal(
    inst.trackedSets.length,
    constructionSets.length + laterSets.length,
    label + " observed Set total"
  );

  const assigned = new Map();
  function claim(role, identity) {
    assert.ok(identity, label + " " + role + " missing identity");
    if (assigned.has(identity)) {
      assert.fail(
        label + " identity already claimed as " + assigned.get(identity) + " vs " + role
      );
    }
    assigned.set(identity, role);
    return identity;
  }

  const roles = {
    sessionFinalizerPending: claim("sessionFinalizerPending", constructionMaps[0]),
    sessionFinalizerFinalized: claim("sessionFinalizerFinalized", constructionMaps[1]),
    sessionFinalizerSnapshotsByDocId: claim(
      "sessionFinalizerSnapshotsByDocId",
      constructionMaps[2]
    ),
    sessionFinalizerSnapshotsByUrl: claim(
      "sessionFinalizerSnapshotsByUrl",
      constructionMaps[3]
    ),
    registryByOrigin: claim("registryByOrigin", constructionMaps[4]),
    sourcesByMediaId: claim("sourcesByMediaId", constructionMaps[5]),
    detectionIdToMediaId: claim("detectionIdToMediaId", constructionMaps[6]),
    pendingByMediaId: claim("pendingByMediaId", constructionMaps[7]),
    tabMediaIds: claim("tabMediaIds", constructionMaps[8]),
    namespaceCounters: claim("namespaceCounters", constructionMaps[9]),
    sessionDocIdentity: claim("sessionDocIdentity", constructionMaps[10]),
    sessionPageIdentity: claim("sessionPageIdentity", constructionMaps[11]),
    jobsById: claim("jobsById", constructionMaps[12]),
    sinkSessions: claim("sinkSessions", constructionMaps[13]),
    variantsOrderedByMediaId: claim("variantsOrderedByMediaId", constructionMaps[14]),
    variantsByIdByMediaId: claim("variantsByIdByMediaId", constructionMaps[15]),
    variantOwnerById: claim("variantOwnerById", constructionMaps[16]),
    variantRegInFlight: claim("variantRegInFlight", constructionMaps[17]),
    providerObservationByMediaId: claim(
      "providerObservationByMediaId",
      constructionMaps[18]
    ),
    reconciledDetectionIds: claim("reconciledDetectionIds", constructionSets[0]),
    publishedMediaIds: claim("publishedMediaIds", constructionSets[1]),
    issuedPublicIds: claim("issuedPublicIds", constructionSets[2]),
    proofTokens: claim("proofTokens", constructionSets[3]),
    preflightFinalizers: [],
    nestedVariantMaps: [],
    registryProviderSets: [],
  };

  assert.equal(isEmptyZeroHistoryMap(roles.jobsById), true, label + " jobsById dormant");
  assert.equal(
    isEmptyZeroHistoryMap(roles.sinkSessions),
    true,
    label + " sinkSessions dormant"
  );
  assert.equal(
    isEmptyZeroHistorySet(roles.proofTokens),
    true,
    label + " proofTokens dormant"
  );

  const detKeys = currentKeys(roles.detectionIdToMediaId);
  for (let i = 0; i < detKeys.length; i++) {
    assert.equal(typeof detKeys[i], "number", label + " detectionId key numeric");
    assert.equal(
      typeof roles.detectionIdToMediaId.get(detKeys[i]),
      "string",
      label + " detectionId value mediaId"
    );
  }

  const nsKeys = currentKeys(roles.namespaceCounters);
  for (let i = 0; i < nsKeys.length; i++) {
    assert.equal(typeof nsKeys[i], "string", label + " namespace key");
    assert.equal(
      typeof roles.namespaceCounters.get(nsKeys[i]),
      "number",
      label + " namespace counter"
    );
  }

  const tabKeys = currentKeys(roles.tabMediaIds);
  for (let i = 0; i < tabKeys.length; i++) {
    assert.equal(typeof tabKeys[i], "number", label + " tabId key");
    assert.ok(
      Array.isArray(roles.tabMediaIds.get(tabKeys[i])),
      label + " tab media list"
    );
  }

  const published = currentSetValues(roles.publishedMediaIds);
  for (let i = 0; i < published.length; i++) {
    assert.equal(typeof published[i], "string", label + " published mediaId");
  }
  const reconciled = currentSetValues(roles.reconciledDetectionIds);
  for (let i = 0; i < reconciled.length; i++) {
    assert.equal(typeof reconciled[i], "number", label + " reconciled detectionId");
  }
  const issued = currentSetValues(roles.issuedPublicIds);
  for (let i = 0; i < issued.length; i++) {
    assert.equal(typeof issued[i], "string", label + " issued public id");
  }

  if (spec.mediaIds && spec.mediaIds.length) {
    for (let i = 0; i < spec.mediaIds.length; i++) {
      assert.equal(
        roles.sourcesByMediaId.has(spec.mediaIds[i]),
        true,
        label + " sources owns " + spec.mediaIds[i]
      );
    }
    assert.equal(
      roles.sourcesByMediaId.size,
      spec.mediaIds.length,
      label + " sources cardinality"
    );
  }

  const nestedFromParent = [];
  const variantMediaKeys = currentKeys(roles.variantsByIdByMediaId);
  for (let i = 0; i < variantMediaKeys.length; i++) {
    const nested = roles.variantsByIdByMediaId.get(variantMediaKeys[i]);
    assert.equal(utilTypes.isMap(nested), true, label + " nested variant map");
    nestedFromParent.push(nested);
  }

  const leftoverLater = [];
  for (let i = 0; i < laterMaps.length; i++) {
    const m = laterMaps[i];
    let isNested = false;
    for (let n = 0; n < nestedFromParent.length; n++) {
      if (nestedFromParent[n] === m) {
        isNested = true;
        break;
      }
    }
    if (isNested) {
      roles.nestedVariantMaps.push(claim("nestedVariantMap:" + roles.nestedVariantMaps.length, m));
    } else {
      leftoverLater.push(m);
    }
  }
  assert.equal(
    roles.nestedVariantMaps.length,
    spec.nestedVariantMaps,
    label + " nested variant map count"
  );
  assert.equal(
    leftoverLater.length,
    spec.captureCount * PREFLIGHT_MAPS_PER_CAPTURE,
    label + " preflight map count"
  );
  for (let c = 0; c < spec.captureCount; c++) {
    const base = c * PREFLIGHT_MAPS_PER_CAPTURE;
    roles.preflightFinalizers.push({
      pending: claim("preflightPending:" + c, leftoverLater[base]),
      finalized: claim("preflightFinalized:" + c, leftoverLater[base + 1]),
      snapshotsByDocId: claim("preflightSnapDoc:" + c, leftoverLater[base + 2]),
      snapshotsByUrl: claim("preflightSnapUrl:" + c, leftoverLater[base + 3]),
    });
  }

  const originSetIdentities = [];
  let originIter;
  try {
    originIter = roles.registryByOrigin.entries();
  } catch (e) {
    assert.fail(label + " registry origin iteration failed");
  }
  for (const entry of originIter) {
    assert.equal(typeof entry[0], "string", label + " origin key");
    assert.equal(utilTypes.isSet(entry[1]), true, label + " origin value Set");
    originSetIdentities.push({ origin: entry[0], set: entry[1] });
  }
  for (let i = 0; i < originSetIdentities.length; i++) {
    roles.registryProviderSets.push(
      claim(
        "registryProviderSet:" + originSetIdentities[i].origin,
        originSetIdentities[i].set
      )
    );
  }
  for (let i = 0; i < laterSets.length; i++) {
    let known = false;
    for (let j = 0; j < originSetIdentities.length; j++) {
      if (originSetIdentities[j].set === laterSets[i]) {
        known = true;
        break;
      }
    }
    if (!known) {
      assert.fail(label + " unexpected later Set not owned by registry origin map");
    }
  }

  for (let i = 0; i < inst.trackedMaps.length; i++) {
    if (!assigned.has(inst.trackedMaps[i])) {
      assert.fail(label + " unclassified observed Map[" + i + "]");
    }
  }
  for (let i = 0; i < inst.trackedSets.length; i++) {
    if (!assigned.has(inst.trackedSets[i])) {
      assert.fail(label + " unclassified observed Set[" + i + "]");
    }
  }

  const intended = spec.intendedProviderSets || [];
  const missingIntendedRoles = [];
  for (let i = 0; i < intended.length; i++) {
    const want = intended[i];
    let found = null;
    for (let j = 0; j < originSetIdentities.length; j++) {
      if (originSetIdentities[j].origin === want.origin) {
        found = originSetIdentities[j];
        break;
      }
    }
    if (!found) {
      missingIntendedRoles.push({
        role: "registryProviderSet:" + want.origin,
        origin: want.origin,
        members: want.members.slice(),
      });
      continue;
    }
    const members = currentSetValues(found.set);
    assert.deepEqual(members, want.members, label + " " + want.origin + " members");
    const addHist = [];
    for (let a = 0; a < found.set._adds.length; a++) {
      addHist.push(found.set._adds[a].value);
    }
    assert.deepEqual(addHist, want.addHistory, label + " " + want.origin + " add history");
  }

  roles.missingIntendedRoles = missingIntendedRoles;
  roles.originSetIdentities = originSetIdentities;
  return roles;
}

function classifyControllerMaps(inst, spec, label) {
  return classifyObservedContainers(inst, spec, label);
}

function auditAuthorizedOverrideValue(value, path) {
  if (value === null || value === undefined || typeof value !== "object") {
    return;
  }
  const seen = new Set();
  function walk(cur, p) {
    if (cur === null || cur === undefined) return;
    const t = typeof cur;
    if (t !== "object" && t !== "function") return;
    if (seen.has(cur)) return;
    seen.add(cur);
    if (utilTypes.isMap(cur) || utilTypes.isSet(cur)) {
      assert.fail(p + " override contains Map/Set");
    }
    const keys = ownKeysOrFail(cur, p);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const desc = ownDescriptorOrFail(cur, k, p);
      if (isAccessorDescriptor(desc)) {
        continue;
      }
      if (!isDataDescriptor(desc)) {
        assert.fail(p + " override non-data " + String(k));
      }
      walk(desc.value, p + "." + String(k));
    }
  }
  walk(value, path);
}

function walkPrivateGraph(root, ctx, path) {
  if (root === null || root === undefined) return;
  const t = typeof root;
  if (t !== "object" && t !== "function") return;
  if (ctx.objectOverrides.has(root)) {
    if (!ctx.inAuthorizedOverride) {
      assert.fail(path + " override object appeared outside authorized mediaOrigin");
    }
    auditAuthorizedOverrideValue(root, path);
    return;
  }
  if (ctx.seen.has(root)) return;
  ctx.seen.add(root);
  if (ctx.forbidden.has(root)) {
    assert.fail(path + " leaked forbidden production identity");
  }
  if (utilTypes.isMap(root)) {
    assert.equal(ctx.allowedMaps.has(root), true, path + " unexpected Map");
    let iter;
    try {
      iter = root.entries();
    } catch (e) {
      assert.fail(path + " Map iteration failed");
    }
    let idx = 0;
    for (const entry of iter) {
      walkPrivateGraph(entry[0], ctx, path + ".key[" + idx + "]");
      walkPrivateGraph(entry[1], ctx, path + ".value[" + idx + "]");
      idx += 1;
    }
    const hist = root._history || [];
    for (let h = 0; h < hist.length; h++) {
      if (Object.prototype.hasOwnProperty.call(hist[h], "key")) {
        walkPrivateGraph(hist[h].key, ctx, path + "._history[" + h + "].key");
      }
      if (Object.prototype.hasOwnProperty.call(hist[h], "value")) {
        walkPrivateGraph(hist[h].value, ctx, path + "._history[" + h + "].value");
      }
    }
    return;
  }
  if (utilTypes.isSet(root)) {
    assert.equal(ctx.allowedSets.has(root), true, path + " unexpected Set");
    let iter;
    try {
      iter = root.values();
    } catch (e) {
      assert.fail(path + " Set iteration failed");
    }
    let idx = 0;
    for (const v of iter) {
      walkPrivateGraph(v, ctx, path + ".member[" + idx + "]");
      idx += 1;
    }
    const hist = root._history || [];
    for (let a = 0; a < hist.length; a++) {
      if (Object.prototype.hasOwnProperty.call(hist[a], "value")) {
        walkPrivateGraph(hist[a].value, ctx, path + "._history[" + a + "].value");
      }
    }
    return;
  }
  if (ctx.privacyHandles.has(root)) {
    assertPrivacyHandleShape(root, path + " privacy");
    return;
  }
  if (t === "function") {
    assert.fail(path + " unexpected function in private graph");
  }
  const keys = ownKeysOrFail(root, path);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const desc = ownDescriptorOrFail(root, k, path);
    if (isAccessorDescriptor(desc)) {
      assert.fail(path + " accessor outside Privacy handle at " + String(k));
    }
    if (!isDataDescriptor(desc)) {
      assert.fail(path + " non-data descriptor " + String(k));
    }
    const childPath = path + "." + String(k);
    if (k === "mediaOrigin" && ctx.authorizedSourceContexts.has(root)) {
      const expected = ctx.authorizedSourceContexts.get(root);
      assert.equal(
        Object.is(desc.value, expected),
        true,
        childPath + " authorized override value"
      );
      if (expected !== null && typeof expected === "object") {
        const prev = ctx.inAuthorizedOverride;
        ctx.inAuthorizedOverride = true;
        walkPrivateGraph(desc.value, ctx, childPath);
        ctx.inAuthorizedOverride = prev;
      }
      continue;
    }
    walkPrivateGraph(desc.value, ctx, childPath);
  }
}

function auditPrivateHolders(inst, spec, extraForbidden, label) {
  const roles = classifyObservedContainers(inst, spec, label);
  const expectedMaps =
    CONTROLLER_CONSTRUCTION_MAPS +
    spec.captureCount * PREFLIGHT_MAPS_PER_CAPTURE +
    spec.nestedVariantMaps;
  assert.equal(inst.trackedMaps.length, expectedMaps, label + " exact Map allocations");
  const allowedMaps = new Set(inst.trackedMaps);
  const allowedSets = new Set(inst.trackedSets);
  const forbidden = new Set();
  const extras = extraForbidden || [];
  for (let i = 0; i < extras.length; i++) {
    const ref = extras[i];
    if (inst.ephemeralHandles.indexOf(ref) !== -1) continue;
    forbidden.add(ref);
  }
  for (let i = 0; i < inst.realRegistryInstances.length; i++) {
    forbidden.add(inst.realRegistryInstances[i]);
  }
  for (let i = 0; i < inst.originalLookupResults.length; i++) {
    forbidden.add(inst.originalLookupResults[i]);
  }
  const privacyHandles = new Set(inst.ephemeralHandles);
  const objectOverrides = new Set();
  const authorizedSourceContexts = new Map();
  if (inst.originOverrides && spec.overrideDetectionId != null) {
    const overrideVal = inst.originOverrides.get(spec.overrideDetectionId);
    const mediaIds = spec.mediaIds || [];
    for (let i = 0; i < mediaIds.length; i++) {
      const rec = roles.sourcesByMediaId.get(mediaIds[i]);
      if (!rec) continue;
      const scDesc = ownDescriptorOrFail(rec, "sourceContext", label + " override sc");
      authorizedSourceContexts.set(scDesc.value, overrideVal);
      if (overrideVal !== null && typeof overrideVal === "object") {
        objectOverrides.add(overrideVal);
      }
    }
  }
  const ctx = {
    seen: new Set(),
    allowedMaps: allowedMaps,
    allowedSets: allowedSets,
    forbidden: forbidden,
    privacyHandles: privacyHandles,
    objectOverrides: objectOverrides,
    authorizedSourceContexts: authorizedSourceContexts,
    inAuthorizedOverride: false,
  };
  for (let i = 0; i < inst.trackedMaps.length; i++) {
    walkPrivateGraph(inst.trackedMaps[i], ctx, label + ".map[" + i + "]");
  }
  for (let i = 0; i < inst.trackedSets.length; i++) {
    walkPrivateGraph(inst.trackedSets[i], ctx, label + ".set[" + i + "]");
  }
  assert.equal(roles.jobsById.size, 0, label + " jobsById dormant empty");
  assert.equal(roles.sinkSessions.size, 0, label + " sinkSessions dormant empty");
  assert.equal(roles.proofTokens.size, 0, label + " proofTokens dormant empty");
  for (let i = 0; i < roles.registryProviderSets.length; i++) {
    const s = roles.registryProviderSets[i];
    const members = currentSetValues(s);
    for (let m = 0; m < members.length; m++) {
      assert.equal(typeof members[m], "string", label + " registry set member primitive");
    }
  }
  return roles;
}

function assertAttemptsPaired(attempts, nPairs, label) {
  assert.equal(attempts.length, nPairs * 2, label + " attempt count");
  for (let i = 0; i < nPairs; i++) {
    assert.equal(attempts[i * 2].method, "observe", label + " observe " + i);
    assert.equal(attempts[i * 2 + 1].method, "lookup", label + " lookup " + i);
  }
}

function assertRawOriginGuardDominatesNormalizeOrigin(src, label) {
  const start = src.indexOf("function deriveProviderKey");
  const end = src.indexOf("function captureNetwork");
  assert.ok(start >= 0 && end > start, label + " association region present");
  const slice = src.slice(start, end);
  const normCall = /ProviderRegistryApi\.normalizeOrigin\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/;
  const m = slice.match(normCall);
  assert.ok(m, label + " real normalizeOrigin call on raw identifier");
  const rawId = m[1];
  const before = slice.slice(0, m.index);
  const typeGuard = new RegExp("typeof\\s+" + rawId + "\\s*===\\s*['\"]string['\"]");
  assert.ok(typeGuard.test(before), label + " type guard before normalizeOrigin");
  assert.equal(
    /['"]http:['"]/.test(before),
    true,
    label + " http: protocol guard before normalizeOrigin"
  );
  assert.equal(
    /['"]https:['"]/.test(before),
    true,
    label + " https: protocol guard before normalizeOrigin"
  );
  assert.equal(
    /normalizeOrigin\s*\(\s*['"]blob:/.test(slice),
    false,
    label + " no blob literal passed to normalizeOrigin"
  );
  assert.equal(
    /normalizeOrigin\s*=/.test(slice),
    false,
    label + " no alias of normalizeOrigin"
  );
}

function assertMaterialEffectsZero(fx, label) {
  assert.equal(fx.counts.publishJobs, 0, label + " publishJobs");
  assert.equal(fx.counts.persistHistory, 0, label + " persistHistory");
  assert.equal(fx.counts.postNative, 0, label + " postNative");
  assert.equal(fx.counts.downloadsDownload, 0, label + " downloadsDownload");
  assert.equal(fx.counts.fetchArrayBuffer, 0, label + " fetchArrayBuffer");
  assert.equal(fx.counts.assembleMedia, 0, label + " assembleMedia");
  assert.equal(fx.counts.createObjectURL, 0, label + " createObjectURL");
  assert.equal(fx.counts.revokeObjectURL, 0, label + " revokeObjectURL");
}

function assertRegistryClearSnapshotZero(hits, label) {
  assert.equal(hits.clear, 0, label + " clear");
  assert.equal(hits.snapshot, 0, label + " snapshot");
}

function providerNetworkCapture(docId, tabId, mediaUrl, pageUrl, overrides) {
  const page = pageUrl;
  const base = {
    details: {
      url: mediaUrl,
      documentUrl: page,
      originUrl: page + "?ref=SECRET_REFERER_PATH",
      tabId: tabId,
      frameId: 0,
      documentId: docId,
      timeStamp: 1_000_000,
      responseHeaders: [{ name: "Content-Type", value: "video/mp4" }],
    },
    hints: {
      topLevelUrlHint: page,
      frameOrigin: page ? new URL(page).origin : "",
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

function providerNetworkSnapshot(docId, tabId, pageUrl, filename, overrides) {
  const base = {
    documentId: docId,
    tabId: tabId,
    frameId: 0,
    pageUrl: pageUrl,
    topLevelPageUrl: pageUrl,
    documentNonce: "n-" + docId,
    candidates: [
      { kind: "visible-filename", value: filename || "provider-media.mp4" },
    ],
    capturedAt: "2026-08-12T12:00:00.000Z",
  };
  return Object.assign(base, overrides || {});
}

function finalizeProviderNetwork(ctrl, fx, inst, opts) {
  const docId = opts.docId;
  const tabId = opts.tabId;
  const mediaUrl = opts.mediaUrl;
  const pageUrl = opts.pageUrl;
  const filename = opts.filename || "m.mp4";
  const privStart = inst.privacyObservations.length;
  const mapStart = inst.trackedMaps.length;
  if (inst.markCausal) {
    inst.markCausal("capture-network-start", { docId: docId });
  }
  const mediaId = ctrl.captureNetwork(
    providerNetworkCapture(docId, tabId, mediaUrl, pageUrl, opts.captureOverrides)
  );
  associatePrivacyInterval(
    inst,
    privStart,
    1,
    { kind: "network", mediaId: mediaId },
    "network capture " + docId
  );
  if (inst.markCausal) {
    inst.markCausal("capture-network-end", {
      mediaId: mediaId,
      mapsAdded: inst.trackedMaps.length - mapStart,
    });
  }
  ctrl.acceptPageSnapshot(
    providerNetworkSnapshot(
      docId,
      tabId,
      pageUrl,
      filename,
      opts.snapshotOverrides
    )
  );
  assert.equal(
    fx.publishDetections.some((p) => p.id === mediaId),
    true,
    "media " + mediaId + " must finalize (docId=" + docId + ")"
  );
  return mediaId;
}

function finalizeProviderDom(ctrl, fx, inst, opts) {
  const docId = opts.docId;
  const tabId = opts.tabId;
  const pageUrl = opts.pageUrl;
  const privStart = inst.privacyObservations.length;
  if (inst.markCausal) {
    inst.markCausal("capture-dom-start", { docId: docId });
  }
  const mediaId = ctrl.captureDomMedia({
    mediaUrl: opts.mediaUrl,
    mediaOrigin: opts.mediaOrigin,
    contentDisposition: null,
    referrerUrl: pageUrl,
    frameOrigin: opts.frameOrigin || (pageUrl ? new URL(pageUrl).origin : ""),
    ts: 1_000_100,
    snapshot: {
      documentId: docId,
      tabId: tabId,
      frameId: 0,
      pageUrl: pageUrl,
      topLevelPageUrl: pageUrl,
      documentNonce: "n-" + docId,
      candidates: [
        {
          kind: "visible-filename",
          value: opts.filename || "dom-provider.mp4",
        },
      ],
      capturedAt: "2026-08-12T12:00:01.000Z",
    },
    transport: {
      mediaKind: "direct",
      requestHeaders: {
        Cookie: "session=SECRET_COOKIE_ABC",
      },
    },
  });
  associatePrivacyInterval(
    inst,
    privStart,
    1,
    { kind: "dom", mediaId: mediaId },
    "dom capture " + docId
  );
  if (inst.markCausal) {
    inst.markCausal("capture-dom-end", { mediaId: mediaId });
  }
  assert.equal(
    fx.publishDetections.some((p) => p.id === mediaId),
    true,
    "DOM media " + mediaId + " must finalize"
  );
  return mediaId;
}

async function probeFutureAsyncStubs(ctrl, extras, label, rootChecker) {
  const extra = extras || {};
  const stubThunks = [
    () =>
      ctrl.enqueueDownload(
        extra.enqueueMessage || {
          item: {
            url: "https://override.example/SECRET_SIGNED_QUERY_XYZ.mp4",
            providerKey: "SECRET_CALLER_PROVIDER",
          },
        },
        extra.enqueueSender || { id: "sender" }
      ),
    () => ctrl.handleNativeMessage(extra.nativeMessage || { type: "x" }),
    () => ctrl.requestFirefoxHandoff(extra.handoff || "media-x"),
    () => ctrl.cancel(extra.cancelId || "job-x"),
    () => ctrl.manualRetry(extra.retryId || "job-x"),
    () => ctrl.helperDisconnected(),
    () => ctrl.setMaxConcurrent(2),
    () => ctrl.pump(),
  ];
  assert.equal(stubThunks.length, 8, label + " eight stub thunks");
  const rejections = [];
  for (let i = 0; i < stubThunks.length; i++) {
    let p;
    try {
      p = stubThunks[i]();
    } catch (e) {
      assert.fail(label + " stub " + i + " must not throw synchronously");
    }
    assert.ok(p && typeof p.then === "function", label + " stub " + i + " Promise");
    assert.equal(p instanceof Promise, true, label + " stub " + i + " native Promise");
    const outcome = {
      resolved: false,
      rejected: false,
      value: undefined,
      error: undefined,
    };
    p.then(
      (v) => {
        outcome.resolved = true;
        outcome.value = v;
      },
      (e) => {
        outcome.rejected = true;
        outcome.error = e;
      }
    );
    await p.then(
      () => {
        assert.fail(label + " stub " + i + " must never resolve");
      },
      () => {}
    );
    assert.equal(outcome.rejected, true, label + " stub " + i + " rejected");
    assert.equal(outcome.resolved, false, label + " stub " + i + " never resolved");
    let errProto;
    try {
      errProto = Object.getPrototypeOf(outcome.error);
    } catch (e) {
      assert.fail(label + " stub " + i + " Error prototype");
    }
    assert.equal(errProto, Error.prototype, label + " stub " + i + " Error");
    const msgDesc = ownDescriptorOrFail(outcome.error, "message", label + " stub " + i);
    assert.equal(isDataDescriptor(msgDesc), true, label + " stub " + i + " message data");
    assert.equal(msgDesc.value, LEASE1_MSG, label + " stub " + i + " text");
    rejections.push(outcome.error);
    if (rootChecker) {
      rootChecker.check(label + " after stub " + i);
    }
  }
  return rejections;
}

async function probeTickResolvesUndefined(ctrl, nowMs, label, rootChecker) {
  let p;
  try {
    p = ctrl.tick(nowMs);
  } catch (e) {
    assert.fail(label + " tick must not throw synchronously");
  }
  assert.ok(p && typeof p.then === "function", label + " tick Promise");
  assert.equal(p instanceof Promise, true, label + " tick native Promise");
  const outcome = {
    resolved: false,
    rejected: false,
    value: undefined,
    error: undefined,
  };
  p.then(
    (v) => {
      outcome.resolved = true;
      outcome.value = v;
    },
    (e) => {
      outcome.rejected = true;
      outcome.error = e;
    }
  );
  const result = await p;
  assert.equal(outcome.rejected, false, label + " tick must not reject");
  assert.equal(outcome.resolved, true, label + " tick resolved");
  assert.equal(result, undefined, label + " tick result undefined");
  assert.equal(outcome.value, undefined, label + " tick value undefined");
  if (rootChecker) {
    rootChecker.check(label + " after tick");
  }
  return result;
}

function snapshotProjectionGraph(arr, label) {
  assert.ok(Array.isArray(arr), label + " projection array");
  assert.ok(Object.isFrozen(arr), label + " projection frozen");
  const keys = ownKeysOrFail(arr, label);
  const rows = [];
  const lenDesc = ownDescriptorOrFail(arr, "length", label);
  for (let i = 0; i < lenDesc.value; i++) {
    const idxDesc = ownDescriptorOrFail(arr, String(i), label + "[" + i + "]");
    assertFrozenDataDesc(idxDesc, { enumerable: true }, label + "[" + i + "]");
    const row = idxDesc.value;
    const rowKeys = ownKeysOrFail(row, label + "[" + i + "]");
    const fields = {};
    const descs = {};
    for (let k = 0; k < rowKeys.length; k++) {
      const key = rowKeys[k];
      const d = ownDescriptorOrFail(row, key, label + "[" + i + "]." + String(key));
      assertFrozenDataDesc(d, { enumerable: true }, label + "[" + i + "]." + String(key));
      fields[key] = d.value;
      descs[key] = d;
    }
    rows.push({
      keys: rowKeys,
      fields: fields,
      descs: descs,
      identity: row,
    });
  }
  return { arr: arr, keys: keys, length: lenDesc.value, rows: rows };
}

function assertProjectionGraphsEqual(actual, expected, label) {
  assert.notEqual(actual.arr, expected.arr, label + " fresh array");
  assert.equal(actual.length, expected.length, label + " length");
  assert.deepEqual(actual.keys, expected.keys, label + " array keys");
  assert.equal(actual.rows.length, expected.rows.length, label + " row count");
  for (let i = 0; i < expected.rows.length; i++) {
    const a = actual.rows[i];
    const e = expected.rows[i];
    assert.notEqual(a.identity, e.identity, label + " row " + i + " fresh");
    assert.deepEqual(a.keys, e.keys, label + " row " + i + " keys");
    for (let k = 0; k < e.keys.length; k++) {
      const key = e.keys[k];
      assert.equal(a.fields[key], e.fields[key], label + " row " + i + "." + key);
    }
  }
  assertDeepFrozenSafe(actual.arr, label + " actual deep");
  assertDeepFrozenSafe(expected.arr, label + " expected deep");
}

function snapshotRoleCardinalities(inst) {
  const maps = [];
  for (let i = 0; i < inst.trackedMaps.length; i++) {
    const m = inst.trackedMaps[i];
    maps.push({
      size: m.size,
      sets: m._sets.length,
      deletes: m._deletes.length,
      clears: m._clears.length,
      history: m._history.length,
    });
  }
  const sets = [];
  for (let i = 0; i < inst.trackedSets.length; i++) {
    const s = inst.trackedSets[i];
    sets.push({
      size: s.size,
      adds: s._adds.length,
      deletes: s._deletes.length,
      clears: s._clears.length,
      history: s._history.length,
    });
  }
  return { maps: maps, sets: sets };
}

function assertRoleCardinalitiesEqual(before, after, label) {
  assert.equal(after.maps.length, before.maps.length, label + " map count");
  assert.equal(after.sets.length, before.sets.length, label + " set count");
  for (let i = 0; i < before.maps.length; i++) {
    assert.deepEqual(after.maps[i], before.maps[i], label + " map[" + i + "]");
  }
  for (let i = 0; i < before.sets.length; i++) {
    assert.deepEqual(after.sets[i], before.sets[i], label + " set[" + i + "]");
  }
}

function snapshotEffectState(fx, inst) {
  const argLens = {};
  const names = [
    "postNative",
    "downloadsDownload",
    "createObjectURL",
    "revokeObjectURL",
    "fetchArrayBuffer",
    "assembleMedia",
    "isPopupSender",
    "getEffectiveDestinationDirectory",
    "publishDetection",
    "publishJobs",
    "persistHistory",
    "reportDiagnostic",
    "randomToken",
    "now",
  ];
  for (let i = 0; i < names.length; i++) {
    argLens[names[i]] = fx.effectArgs[names[i]].length;
  }
  const counts = {};
  for (let i = 0; i < names.length; i++) {
    counts[names[i]] = fx.counts[names[i]];
  }
  return {
    counts: counts,
    argLens: argLens,
    diagnostics: fx.diagnostics.length,
    console: inst.consoleCaptures.length,
    privacy: inst.privacyObservations.length,
    observe: inst.registryHits.observe,
    lookup: inst.registryHits.lookup,
    attempts: inst.registryAttempts.length,
    events: inst.registryEvents.length,
    completed: inst.completedResults.length,
    publishRows: fx.publishDetections.slice(),
  };
}

function assertEffectStateEqual(before, after, label) {
  assert.deepEqual(after.counts, before.counts, label + " effect counts");
  assert.deepEqual(after.argLens, before.argLens, label + " effect arg lengths");
  assert.equal(after.diagnostics, before.diagnostics, label + " diagnostics");
  assert.equal(after.console, before.console, label + " console");
  assert.equal(after.privacy, before.privacy, label + " privacy");
  assert.equal(after.observe, before.observe, label + " observe");
  assert.equal(after.lookup, before.lookup, label + " lookup");
  assert.equal(after.attempts, before.attempts, label + " attempts");
  assert.equal(after.events, before.events, label + " events");
  assert.equal(after.completed, before.completed, label + " completed");
  assert.equal(after.publishRows.length, before.publishRows.length, label + " publish rows");
  for (let i = 0; i < before.publishRows.length; i++) {
    assert.equal(after.publishRows[i], before.publishRows[i], label + " publish row " + i);
  }
}

function runInvalidThenBindThenReplay(ctrl, fx, inst, mediaId, explicitUrl, label, rootChecker) {
  const pubBefore = fx.counts.publishDetection;
  const obsBefore = inst.registryHits.observe;
  const lookBefore = inst.registryHits.lookup;
  const ephBefore = inst.privacyObservations.length;
  const tokBefore = fx.counts.randomToken;
  let invErr = null;
  try {
    ctrl.registerVariants(mediaId, [
      { url: "https://invalid.example/\u0001" + label + ".mp4" },
    ]);
  } catch (e) {
    invErr = e;
  }
  assertVariantRegError(invErr);
  assert.equal(fx.counts.publishDetection, pubBefore, label + " inv no publish");
  assert.equal(inst.registryHits.observe, obsBefore, label + " inv no observe");
  assert.equal(inst.registryHits.lookup, lookBefore, label + " inv no lookup");
  assert.equal(inst.privacyObservations.length, ephBefore, label + " inv no privacy");
  assert.equal(fx.counts.randomToken, tokBefore, label + " inv no token");
  if (rootChecker) rootChecker.check(label + " after invalid registration");

  const bindStart = inst.privacyObservations.length;
  const bound = ctrl.registerVariants(mediaId, [
    { url: explicitUrl, label: "ok" },
  ]);
  assert.equal(bound.length, 1, label + " explicit bind");
  const boundSnap = snapshotProjectionGraph(bound, label + " bound");
  const literalId = boundSnap.rows[0].fields.id;
  associatePrivacyInterval(
    inst,
    bindStart,
    1,
    { kind: "variant", mediaId: mediaId, variantId: literalId },
    label + " bind"
  );
  const variantRecs = findPrivateVariantRecords(inst, mediaId, 1, label);
  assertPrivateVariantRecord(
    variantRecs[0],
    {
      url: explicitUrl,
      extraKeys: ["label"],
      label: "ok",
      literalId: literalId,
    },
    inst,
    label + " bound private"
  );
  if (rootChecker) rootChecker.check(label + " after bind");

  const baseline = snapshotEffectState(fx, inst);
  const roleBase = snapshotRoleCardinalities(inst);
  const rec = Proxy.revocable([], {
    get() {
      throw new Error("SECRET_REPLAY_TRAP");
    },
    ownKeys() {
      throw new Error("SECRET_REPLAY_TRAP");
    },
    getOwnPropertyDescriptor() {
      throw new Error("SECRET_REPLAY_TRAP");
    },
  });
  rec.revoke();
  const replay = ctrl.registerVariants(mediaId, rec.proxy);
  const replaySnap = snapshotProjectionGraph(replay, label + " replay");
  assertProjectionGraphsEqual(replaySnap, boundSnap, label + " replay graph");
  assert.equal(replaySnap.rows[0].fields.id, literalId, label + " replay id");
  assertEffectStateEqual(baseline, snapshotEffectState(fx, inst), label + " replay effects");
  assertRoleCardinalitiesEqual(
    roleBase,
    snapshotRoleCardinalities(inst),
    label + " replay roles"
  );
  if (rootChecker) rootChecker.check(label + " after replay");
  return {
    bound: bound,
    replay: replay,
    literalId: literalId,
    boundSnap: boundSnap,
  };
}

function createForeignBoxedString() {
  const foreign = vm.runInNewContext(
    [
      "(function () {",
      "  var boxed = new String('https://foreign-box.example/path');",
      "  return { boxed: boxed, StringRef: String, ObjectRef: Object };",
      "})()",
    ].join("\n")
  );
  assert.notEqual(foreign.StringRef, String, "foreign String intrinsic");
  assert.notEqual(foreign.ObjectRef, Object, "foreign Object intrinsic");
  assert.notEqual(
    Object.getPrototypeOf(foreign.boxed),
    String.prototype,
    "boxed not host String"
  );
  return foreign;
}

function createForeignHostileOrigin() {
  const foreign = vm.runInNewContext(
    [
      "(function () {",
      "  var hits = { valueOf: 0, toString: 0 };",
      "  var hostile = {",
      "    valueOf: function () { hits.valueOf += 1; return 'https://coerced.example'; },",
      "    toString: function () { hits.toString += 1; return 'https://coerced.example'; }",
      "  };",
      "  return { hits: hits, hostile: hostile, ObjectRef: Object };",
      "})()",
    ].join("\n")
  );
  assert.notEqual(foreign.ObjectRef, Object, "foreign Object intrinsic");
  return foreign;
}

function publishRowFor(fx, mediaId) {
  const row = fx.publishDetections.find((p) => p.id === mediaId);
  assert.ok(row, "publish row for " + mediaId);
  return row;
}

function assertSafeDetectionRow(row, expected, label) {
  const provider =
    typeof expected === "string" ? expected : expected.providerKey;
  assert.ok(row && typeof row === "object", label + " publish object");
  assert.ok(Object.isFrozen(row), label + " publish frozen");
  assertExactOwnKeys(row, SAFE_DETECTION_OWN_KEYS, label + " publish");
  for (let i = 0; i < SAFE_DETECTION_OWN_KEYS.length; i++) {
    const k = SAFE_DETECTION_OWN_KEYS[i];
    const d = ownDescriptorOrFail(row, k, label + " publish");
    assertFrozenDataDesc(d, { enumerable: true }, label + " publish." + k);
  }
  assert.equal(row.providerKey, provider, label + " providerKey");
  if (expected && typeof expected === "object") {
    if (expected.id != null) assert.equal(row.id, expected.id, label + " id");
    if (expected.proposedFilename != null) {
      assert.equal(row.proposedFilename, expected.proposedFilename, label + " filename");
    }
    if (expected.kind != null) assert.equal(row.kind, expected.kind, label + " kind");
  }
  assertDeepFrozenSafe(row, label + " publish deep");
}

function assertPopupNoProviderFields(popup, spec, label) {
  if (typeof spec === "string") {
    label = spec;
    spec = { variantLengths: null };
  }
  assert.ok(Array.isArray(popup), label + " popup array");
  assert.ok(Object.isFrozen(popup), label + " popup frozen");
  const popupKeys = ownKeysOrFail(popup, label);
  const expectedLen = spec.length != null ? spec.length : null;
  const lenDesc = ownDescriptorOrFail(popup, "length", label);
  if (expectedLen != null) {
    assert.equal(lenDesc.value, expectedLen, label + " popup length");
  }
  const length = lenDesc.value;
  const expectedPopupKeys = [];
  for (let i = 0; i < length; i++) expectedPopupKeys.push(String(i));
  expectedPopupKeys.push("length");
  assert.deepEqual(popupKeys, expectedPopupKeys, label + " popup dense keys");
  assertDeepFrozenSafe(popup, label + " popup deep");
  for (let i = 0; i < length; i++) {
    const rowDesc = ownDescriptorOrFail(popup, String(i), label + " popup row " + i);
    assertFrozenDataDesc(rowDesc, { enumerable: true }, label + " popup row " + i);
    const row = rowDesc.value;
    assertExactOwnKeys(row, POPUP_ROW_OWN_KEYS, label + " popup row " + i);
    for (let k = 0; k < POPUP_ROW_OWN_KEYS.length; k++) {
      const key = POPUP_ROW_OWN_KEYS[k];
      const d = ownDescriptorOrFail(row, key, label + " popup row " + i);
      assertFrozenDataDesc(d, { enumerable: true }, label + " popup." + key);
    }
    const variantsDesc = ownDescriptorOrFail(row, "variants", label + " popup variants");
    const variants = variantsDesc.value;
    assert.ok(Array.isArray(variants), label + " popup variants array");
    assert.ok(Object.isFrozen(variants), label + " popup variants frozen");
    const wantVarLen =
      spec.variantLengths && spec.variantLengths[i] != null
        ? spec.variantLengths[i]
        : spec.rows && spec.rows[i] && spec.rows[i].variantsLength != null
          ? spec.rows[i].variantsLength
          : 0;
    const vKeys = ownKeysOrFail(variants, label + " popup variants keys");
    const expectedVKeys = [];
    for (let v = 0; v < wantVarLen; v++) expectedVKeys.push(String(v));
    expectedVKeys.push("length");
    assert.deepEqual(vKeys, expectedVKeys, label + " popup variants dense keys");
    const vLenDesc = ownDescriptorOrFail(variants, "length", label + " variants.length");
    assert.equal(vLenDesc.value, wantVarLen, label + " popup variants length");
    const expectedVars =
      spec.rows && spec.rows[i] && spec.rows[i].variants
        ? spec.rows[i].variants
        : null;
    for (let v = 0; v < wantVarLen; v++) {
      const vDesc = ownDescriptorOrFail(variants, String(v), label + " variant " + v);
      assertFrozenDataDesc(vDesc, { enumerable: true }, label + " variant " + v);
      const vrow = vDesc.value;
      const wantKeys = expectedVars && expectedVars[v] && expectedVars[v].keys
        ? expectedVars[v].keys
        : ["id", "label"];
      assertExactOwnKeys(vrow, wantKeys, label + " variant row " + v);
      for (let vk = 0; vk < wantKeys.length; vk++) {
        const vkName = wantKeys[vk];
        const vd = ownDescriptorOrFail(vrow, vkName, label + " variant." + vkName);
        assertFrozenDataDesc(vd, { enumerable: true }, label + " variant." + vkName);
      }
      if (expectedVars && expectedVars[v]) {
        const idDesc = ownDescriptorOrFail(vrow, "id", label + " variant.id");
        assert.equal(idDesc.value, expectedVars[v].id, label + " variant id");
        if (expectedVars[v].label != null) {
          const lDesc = ownDescriptorOrFail(vrow, "label", label + " variant.label");
          assert.equal(lDesc.value, expectedVars[v].label, label + " variant label");
        }
      }
    }
    const rowKeys = ownKeysOrFail(row, label + " popup row keys");
    assert.equal(rowKeys.indexOf("providerKey"), -1, label + " no providerKey");
    assert.equal(rowKeys.indexOf("mediaOrigin"), -1, label + " no mediaOrigin");
  }
}

// Hand-derived normalized constants (real normalizer; literal expected strings).
const BA07_RAW_ORIGIN_A =
  "https://CDN-A.EXAMPLE:443/path/video.mp4?sig=SECRET_SIGNED_QUERY_XYZ";
const BA07_RAW_ORIGIN_B = "http://cdn-b.example:80/other/file.mp4";
const BA07_NORM_ORIGIN_A = "https://cdn-a.example";
const BA07_NORM_ORIGIN_B = "http://cdn-b.example";
const BA07_PROVIDER = "florenfile.com";
const BA07_PAGE = "https://florenfile.com/watch/SECRET_PAGE_PATH";
const BA07_FALLBACK_DOC_A = "document-session:1";
const BA07_FALLBACK_DOC_B = "document-session:2";
const BA08_SHARED_RAW =
  "https://user:SECRET_BA08_USERINFO@shared-cdn.example:443/a/v1.mp4?token=SECRET_SIGNED_QUERY_XYZ&n=1";
const BA08_SHARED_NORM = "https://shared-cdn.example";
const BA08_URL_1 = BA08_SHARED_RAW;
const BA08_URL_2 =
  "https://shared-cdn.example/b/v2.mp4?token=SECRET_SIGNED_QUERY_XYZ&n=2#SECRET_BA08_FRAGMENT";
const BA08_URL_3 =
  "https://Shared-CDN.Example:443/c/v3.mp4?token=SECRET_SIGNED_QUERY_XYZ&n=3";
const BA08_PROVIDER_A = "provider-a.example";
const BA08_PROVIDER_B = "provider-b.example";
const BA08_PAGE_A1 = "https://provider-a.example/page-1";
const BA08_PAGE_B = "https://provider-b.example/page-2";
const BA08_PAGE_A2 = "https://provider-a.example/page-3";
const BA07_FT_URL =
  "https://ftuser:SECRET_FT_USERINFO@dormant-ft.example/kept.mp4?sig=SECRET_FT_QUERY&x=1#SECRET_FT_FRAG";
const BA08_FT_URL =
  "https://ftuser:SECRET_BA08_FT_USER@shared-ft.example/kept.mp4?sig=SECRET_BA08_FT_QUERY#SECRET_BA08_FT_FRAG";
const BA07_DOM_RAW_ORIGIN =
  "HTTPS://Dom-Cdn.Example:443/path/v.mp4?q=SECRET_DOM_QUERY";
const BA07_DOM_NORM_ORIGIN = "https://dom-cdn.example";
const BA07_RAW_PROVIDER = "WWW.FlorEnFile.COM";
const BA07_EXPLICIT_VARIANT =
  "https://explicit-ba07.example/v.mp4?token=SECRET_EXPLICIT_QUERY";
const BA08_EXPLICIT_VARIANT =
  "https://explicit-ba08.example/v.mp4?token=SECRET_EXPLICIT_QUERY";

function assertAccessorsZero(counters, label) {
  const names = Object.keys(counters);
  for (let i = 0; i < names.length; i++) {
    assert.equal(
      counters[names[i]],
      0,
      label + " accessor " + names[i] + " remains zero"
    );
  }
}

async function runFutureTransportDormancyFixture(opts) {
  const inst = loadProviderInstrumentedClassic();
  const fx = makeProviderEffects();
  const counters = {
    unusedOverride: 0,
    url: 0,
    providerKey: 0,
    label: 0,
  };
  const callerCandidate = {
    url: opts.ftUrl,
    label: "retained",
  };
  const callerVariants = [callerCandidate];
  const callerTransport = {
    mediaKind: "direct",
    requestHeaders: {
      Cookie: "session=SECRET_COOKIE_ABC",
      Authorization: "Bearer SECRET_AUTH_BEARER_TOKEN",
    },
    variants: callerVariants,
  };
  Object.defineProperty(callerTransport, "unusedOverride", {
    enumerable: true,
    configurable: true,
    get() {
      counters.unusedOverride += 1;
      throw new Error(opts.accessorSecret);
    },
  });
  const privacyCtx = buildPrivacyScanContext({
    forbiddenStrings: opts.forbiddenStrings,
    forbiddenRefs: [callerTransport, callerVariants, callerCandidate],
  });
  const root = createRootChecker(inst, privacyCtx);
  const ctrl = root.after(opts.label + " construct", function () {
    return inst.api.createBackgroundAdapters(fx.options());
  });
  const privStart = inst.privacyObservations.length;
  const mediaId = root.after(opts.label + " capture", function () {
    return ctrl.captureNetwork(
      providerNetworkCapture(
        opts.docId,
        opts.tabId,
        opts.mediaUrl,
        opts.pageUrl,
        { transport: callerTransport }
      )
    );
  });
  associatePrivacyInterval(
    inst,
    privStart,
    1,
    { kind: "network", mediaId: mediaId },
    opts.label + " capture"
  );
  callerCandidate.url = opts.mutatedUrl;
  Object.defineProperty(callerCandidate, "url", {
    configurable: true,
    enumerable: true,
    get() {
      counters.url += 1;
      throw new Error(opts.accessorSecret);
    },
  });
  Object.defineProperty(callerCandidate, "providerKey", {
    enumerable: true,
    configurable: true,
    get() {
      counters.providerKey += 1;
      throw new Error(opts.accessorSecret);
    },
  });
  Object.defineProperty(callerCandidate, "label", {
    enumerable: true,
    configurable: true,
    get() {
      counters.label += 1;
      throw new Error(opts.accessorSecret);
    },
  });
  function checkPhase(record, snap, phase) {
    assertAccessorsZero(counters, opts.label + " " + phase);
    assertFutureTransportUnchanged(record, snap, opts.label + " " + phase);
    root.check(opts.label + " " + phase + " globals");
  }

  root.after(opts.label + " snapshot", function () {
    ctrl.acceptPageSnapshot(
      providerNetworkSnapshot(opts.docId, opts.tabId, opts.pageUrl, opts.filename)
    );
  });
  assert.equal(
    fx.publishDetections.some((p) => p.id === mediaId),
    true,
    opts.label + " must finalize"
  );
  const rec = findPrivateMediaRecord(
    inst,
    { mediaId: mediaId, hasFutureTransport: true },
    opts.label
  );
  assertPrivateMediaShape(
    rec,
    {
      mediaId: mediaId,
      proposedFilename: opts.filename,
      mediaKind: "direct",
      providerKey: opts.providerKey,
      tabId: opts.tabId,
      detectionId: 1,
      mediaUrl: opts.mediaUrl,
      hasFutureTransport: true,
    },
    inst,
    opts.label
  );
  const snap = assertFutureTransportExact(
    rec,
    { url: opts.ftUrl, label: "retained" },
    {
      transport: callerTransport,
      variants: callerVariants,
      candidate: callerCandidate,
    },
    opts.label
  );
  checkPhase(rec, snap, "after finalize");

  root.after(opts.label + " later matching snapshot", function () {
    ctrl.acceptPageSnapshot(
      providerNetworkSnapshot(opts.docId, opts.tabId, opts.pageUrl, opts.filename)
    );
  });
  root.after(opts.label + " later navigation snapshot", function () {
    ctrl.acceptPageSnapshot(
      providerNetworkSnapshot(
        opts.docId + "-later",
        opts.tabId,
        opts.pageUrl + "/later",
        "later.mp4"
      )
    );
  });
  checkPhase(rec, snap, "after later snapshot");

  const pop0 = root.after(opts.label + " popup", function () {
    return ctrl.popupMedia(opts.tabId);
  });
  assertPopupNoProviderFields(
    pop0,
    { length: 1, variantLengths: [0] },
    opts.label + " popup empty before bind"
  );
  checkPhase(rec, snap, "after popup");

  await probeTickResolvesUndefined(ctrl, opts.tickMs, opts.label + " tick", root);
  checkPhase(rec, snap, "after tick");

  const stubRejections = await probeFutureAsyncStubs(
    ctrl,
    {},
    opts.label + " stubs",
    root
  );
  checkPhase(rec, snap, "after eight stubs");

  const jobs = root.after(opts.label + " popupJobs", function () {
    return ctrl.popupJobs();
  });
  assert.ok(Array.isArray(jobs), opts.label + " popupJobs");
  checkPhase(rec, snap, "after popupJobs");

  const ephBefore = inst.privacyObservations.length;
  assert.equal(
    inst.privacyObservations.some((c) => c.mediaUrl === opts.ftUrl),
    false,
    opts.label + " retained candidate has no Privacy handle"
  );
  const bindRec = runInvalidThenBindThenReplay(
    ctrl,
    fx,
    inst,
    mediaId,
    opts.explicitUrl,
    opts.label,
    root
  );
  checkPhase(rec, snap, "after invalid/bind/replay");
  assert.equal(bindRec.bound.length, 1);
  assert.equal(
    inst.privacyObservations.some((c) => c.mediaUrl === opts.explicitUrl),
    true,
    opts.label + " explicit URL bound"
  );
  assert.equal(
    inst.privacyObservations.some((c) => c.mediaUrl === opts.ftUrl),
    false,
    opts.label + " retained still has no Privacy handle"
  );
  assert.equal(
    inst.privacyObservations.length,
    ephBefore + 1,
    opts.label + " one new handle"
  );
  const pop1 = root.after(opts.label + " popup after bind", function () {
    return ctrl.popupMedia(opts.tabId);
  });
  assertPopupNoProviderFields(
    pop1,
    {
      length: 1,
      variantLengths: [1],
      rows: [
        {
          variantsLength: 1,
          variants: [{ id: bindRec.literalId, label: "ok", keys: ["id", "label"] }],
        },
      ],
    },
    opts.label + " popup exact after bind"
  );
  const variantRecs = findPrivateVariantRecords(inst, mediaId, 1, opts.label);
  assertPrivateVariantRecord(
    variantRecs[0],
    {
      url: opts.explicitUrl,
      extraKeys: ["label"],
      label: "ok",
      literalId: bindRec.literalId,
    },
    inst,
    opts.label + " variant"
  );
  checkPhase(rec, snap, "after explicit popup");

  privacyCtx.forbiddenRefs.add(callerTransport);
  privacyCtx.forbiddenRefs.add(callerVariants);
  privacyCtx.forbiddenRefs.add(callerCandidate);
  for (let i = 0; i < inst.ephemeralHandles.length; i++) {
    privacyCtx.forbiddenRefs.add(inst.ephemeralHandles[i]);
    privacyCtx.privacyHandles.add(inst.ephemeralHandles[i]);
  }
  for (let i = 0; i < inst.originalLookupResults.length; i++) {
    privacyCtx.forbiddenRefs.add(inst.originalLookupResults[i]);
  }
  for (let i = 0; i < inst.realRegistryInstances.length; i++) {
    privacyCtx.forbiddenRefs.add(inst.realRegistryInstances[i]);
  }
  privacyCtx.trustedErrors = new Set(stubRejections);
  const surfaces = [
    pop0,
    pop1,
    fx.publishDetections,
    fx.diagnostics,
    bindRec.bound,
    bindRec.replay,
    jobs,
    stubRejections,
    inst.consoleCaptures,
  ];
  for (let i = 0; i < surfaces.length; i++) {
    scanPublicGraph(surfaces[i], privacyCtx, opts.label + " surface " + i);
  }
  scanAllEffectArgs(fx, privacyCtx, opts.label + " effects");
  root.check(opts.label + " final globals");
  const holderAudit = auditPrivateHolders(
    inst,
    {
      captureCount: 1,
      nestedVariantMaps: 1,
      mediaIds: [mediaId],
      intendedProviderSets: [
        {
          origin: inst.normalizeOrigin(opts.mediaUrl),
          members: [opts.providerKey],
          addHistory: [opts.providerKey],
        },
      ],
    },
    privacyCtx.forbiddenRefs,
    opts.label + " holders"
  );
  assert.equal(inst.registryHits.create, 1, opts.label + " create once");
  assert.equal(
    inst.registryHits.observe,
    1,
    opts.label + " observe once around dormancy"
  );
  assert.equal(
    inst.registryHits.lookup,
    1,
    opts.label + " lookup once around dormancy"
  );
  assert.equal(
    holderAudit.missingIntendedRoles.length > 0 || inst.registryHits.observe === 1,
    true,
    opts.label + " missing intended roles recorded or observe live"
  );
  if (inst.registryHits.observe !== 1) {
    assert.ok(
      holderAudit.missingIntendedRoles.length >= 1,
      opts.label + " missing intended provider Set"
    );
  }
  return { inst: inst, fx: fx, mediaId: mediaId };
}

function ba07ForbiddenStrings(extra) {
  return [
    "SECRET_SIGNED_QUERY_XYZ",
    "SECRET_COOKIE_ABC",
    "SECRET_AUTH_BEARER_TOKEN",
    "SECRET_REFERER_PATH",
    "SECRET_PAGE_PATH",
    "SECRET_FT_USERINFO",
    "SECRET_FT_QUERY",
    "SECRET_FT_FRAG",
    "SECRET_DOM_QUERY",
    "SECRET_EXPLICIT_QUERY",
    "SECRET_REPLAY_TRAP",
    "SECRET_CALLER_PROVIDER",
    "SECRET_VARIANT_PROVIDER_OVERRIDE",
    "SECRET_VARIANT_ORIGIN_OVERRIDE",
    "SECRET_DEPENDENCY_OBSERVE_XYZ_991",
    "SECRET_DEPENDENCY_LOOKUP_ABC_772",
    "user:SECRET",
    "ftuser:",
    "dormant-ft.example",
  ].concat(extra || []);
}

test("BA07 — one referring provider through different CDN origins stays one provider group", async (t) => {
  // Mutation caught: grouping by CDN hostname, skipping association,
  // double-observing, retrying claimed failure, coercing origin, accepting
  // blob/non-HTTP schemes, retaining live lookup objects, unstable/raw
  // fallback authority, or leaking dependency/private evidence.

  await t.test(
    "distinct CDN origins share one source provider with exact-once pairs",
    async () => {
      const inst = loadProviderInstrumentedClassic();
      assert.equal(inst.normalizeOrigin, inst.root.McProviderRegistry.normalizeOrigin);
      assert.equal(
        inst.normalizeProviderKey,
        inst.root.McProviderRegistry.normalizeProviderKey
      );
      assert.equal(
        inst.normalizeOrigin(BA07_RAW_ORIGIN_A),
        BA07_NORM_ORIGIN_A,
        "hand-derived origin A"
      );
      assert.equal(
        inst.normalizeOrigin(BA07_RAW_ORIGIN_B),
        BA07_NORM_ORIGIN_B,
        "hand-derived origin B"
      );
      assert.notEqual(BA07_NORM_ORIGIN_A, BA07_NORM_ORIGIN_B);
      assert.equal(
        inst.normalizeProviderKey(BA07_RAW_PROVIDER),
        BA07_PROVIDER
      );

      const fx = makeProviderEffects();
      const callerMap = new Map([["k", "SECRET_MAP_VALUE"]]);
      const callerSet = new Set(["SECRET_SET_VALUE"]);
      const callerHeaders = {
        Cookie: "session=SECRET_COOKIE_ABC",
        Authorization: "Bearer SECRET_AUTH_BEARER_TOKEN",
      };
      const callerSourceContext = {
        mediaOrigin: "https://override.example",
        providerKey: "SECRET_CALLER_PROVIDER",
      };
      const ctxEarly = buildPrivacyScanContext({
        forbiddenStrings: ba07ForbiddenStrings([
          BA07_NORM_ORIGIN_A,
          BA07_NORM_ORIGIN_B,
          "CDN-A.EXAMPLE",
          "cdn-b.example",
          "SECRET_MAP_VALUE",
          "SECRET_SET_VALUE",
        ]),
        forbiddenRefs: [callerMap, callerSet, callerHeaders, callerSourceContext],
      });
      const root = createRootChecker(inst, ctxEarly);
      const ctrl = root.after("cdn construct", function () {
        return inst.api.createBackgroundAdapters(fx.options());
      });

      const idA = finalizeProviderNetwork(ctrl, fx, inst, {
        docId: "doc-ba07-cdn-a",
        tabId: 701,
        mediaUrl: BA07_RAW_ORIGIN_A,
        pageUrl: BA07_PAGE,
        filename: "a.mp4",
        captureOverrides: {
          transport: {
            mediaKind: "direct",
            requestHeaders: callerHeaders,
          },
          sourceContext: callerSourceContext,
          callerMap: callerMap,
          callerSet: callerSet,
          providerKey: "SECRET_CALLER_PROVIDER",
        },
      });
      const idB = finalizeProviderNetwork(ctrl, fx, inst, {
        docId: "doc-ba07-cdn-b",
        tabId: 701,
        mediaUrl: BA07_RAW_ORIGIN_B,
        pageUrl: BA07_PAGE,
        filename: "b.mp4",
      });
      assert.notEqual(idA, idB);
      root.check("cdn after captures");

      const pubA = publishRowFor(fx, idA);
      const pubB = publishRowFor(fx, idB);
      assertSafeDetectionRow(pubA, BA07_PROVIDER, "pub A");
      assertSafeDetectionRow(pubB, BA07_PROVIDER, "pub B");
      assert.equal(fx.counts.publishDetection, 2);
      assert.notEqual(pubA.providerKey, "cdn-a.example");
      assert.notEqual(pubB.providerKey, "cdn-b.example");

      const popup = root.after("cdn popup", function () {
        return ctrl.popupMedia(701);
      });
      assertPopupNoProviderFields(
        popup,
        { length: 2, variantLengths: [0, 0] },
        "cdn popup"
      );

      root.after("cdn later snapshot", function () {
        ctrl.acceptPageSnapshot(
          providerNetworkSnapshot("doc-ba07-cdn-a", 701, BA07_PAGE, "later.mp4")
        );
      });
      root.after("cdn nav snapshot", function () {
        ctrl.acceptPageSnapshot(
          providerNetworkSnapshot(
            "doc-ba07-nav",
            701,
            "https://florenfile.com/navigated",
            "nav.mp4"
          )
        );
      });
      await probeTickResolvesUndefined(ctrl, 1_000_800, "cdn tick", root);
      const popup2 = root.after("cdn popup2", function () {
        return ctrl.popupMedia(701);
      });
      assertPopupNoProviderFields(
        popup2,
        { length: 2, variantLengths: [0, 0] },
        "cdn popup2"
      );

      const rec = runInvalidThenBindThenReplay(
        ctrl,
        fx,
        inst,
        idA,
        BA07_EXPLICIT_VARIANT,
        "cdn",
        root
      );
      const bindBStart = inst.privacyObservations.length;
      const boundB = root.after("cdn bind B duplicate URL", function () {
        return ctrl.registerVariants(idB, [
          { url: BA07_EXPLICIT_VARIANT, label: "ok-b" },
        ]);
      });
      assert.equal(boundB.length, 1, "cdn B bind");
      const boundBSnap = snapshotProjectionGraph(boundB, "cdn B bound");
      const literalIdB = boundBSnap.rows[0].fields.id;
      associatePrivacyInterval(
        inst,
        bindBStart,
        1,
        { kind: "variant", mediaId: idB, variantId: literalIdB },
        "cdn B bind"
      );
      const assocA = variantAssociationForLiteralId(inst, rec.literalId, "cdn A var");
      const assocB = variantAssociationForLiteralId(inst, literalIdB, "cdn B var");
      assert.equal(assocA.mediaUrl, BA07_EXPLICIT_VARIANT, "cdn A url");
      assert.equal(assocB.mediaUrl, BA07_EXPLICIT_VARIANT, "cdn B url");
      assert.notEqual(assocA.callIndex, assocB.callIndex, "duplicate URL distinct indices");
      assert.notEqual(assocA.handle, assocB.handle, "duplicate URL distinct handles");
      let overrideHits = 0;
      const hostileReplay = [
        {
          url: "https://cdn-override.example/v.mp4",
          get providerKey() {
            overrideHits += 1;
            throw new Error("SECRET_VARIANT_PROVIDER_OVERRIDE");
          },
          get mediaOrigin() {
            overrideHits += 1;
            throw new Error("SECRET_VARIANT_ORIGIN_OVERRIDE");
          },
        },
      ];
      const replayBaseline = snapshotEffectState(fx, inst);
      const replayAgain = root.after("cdn hostile replay", function () {
        return ctrl.registerVariants(idA, hostileReplay);
      });
      assert.equal(overrideHits, 0, "unknown override getters never run");
      const replayAgainSnap = snapshotProjectionGraph(replayAgain, "cdn hostile replay");
      assertProjectionGraphsEqual(replayAgainSnap, rec.boundSnap, "cdn hostile replay");
      assertEffectStateEqual(
        replayBaseline,
        snapshotEffectState(fx, inst),
        "cdn hostile replay effects"
      );

      const stubRejections = await probeFutureAsyncStubs(
        ctrl,
        {
          enqueueMessage: {
            item: {
              url: "https://override.example/SECRET_SIGNED_QUERY_XYZ.mp4",
              providerKey: "SECRET_CALLER_PROVIDER",
              callerMap: callerMap,
              callerSet: callerSet,
            },
          },
        },
        "cdn stubs",
        root
      );

      const mediaRecA = findPrivateMediaRecord(
        inst,
        { mediaId: idA, hasFutureTransport: false },
        "cdn A"
      );
      assertPrivateMediaShape(
        mediaRecA,
        {
          mediaId: idA,
          proposedFilename: "a.mp4",
          mediaKind: "direct",
          providerKey: BA07_PROVIDER,
          tabId: 701,
          detectionId: 1,
          mediaUrl: BA07_RAW_ORIGIN_A,
          hasFutureTransport: false,
        },
        inst,
        "cdn A"
      );
      const mediaRecB = findPrivateMediaRecord(
        inst,
        { mediaId: idB, hasFutureTransport: false },
        "cdn B"
      );
      assertPrivateMediaShape(
        mediaRecB,
        {
          mediaId: idB,
          proposedFilename: "b.mp4",
          mediaKind: "direct",
          providerKey: BA07_PROVIDER,
          tabId: 701,
          detectionId: 2,
          mediaUrl: BA07_RAW_ORIGIN_B,
          hasFutureTransport: false,
        },
        inst,
        "cdn B"
      );
      const popupAfterBind = root.after("cdn popup after bind", function () {
        return ctrl.popupMedia(701);
      });
      assertPopupNoProviderFields(
        popupAfterBind,
        {
          length: 2,
          variantLengths: [1, 1],
          rows: [
            {
              variantsLength: 1,
              variants: [{ id: rec.literalId, label: "ok", keys: ["id", "label"] }],
            },
            {
              variantsLength: 1,
              variants: [{ id: literalIdB, label: "ok-b", keys: ["id", "label"] }],
            },
          ],
        },
        "cdn popup after bind"
      );
      const cdnVariants = findPrivateVariantRecords(inst, idA, 1, "cdn variants");
      assertPrivateVariantRecord(
        cdnVariants[0],
        {
          url: BA07_EXPLICIT_VARIANT,
          extraKeys: ["label"],
          label: "ok",
          literalId: rec.literalId,
        },
        inst,
        "cdn variant"
      );
      const cdnVariantsB = findPrivateVariantRecords(inst, idB, 1, "cdn variants B");
      assertPrivateVariantRecord(
        cdnVariantsB[0],
        {
          url: BA07_EXPLICIT_VARIANT,
          extraKeys: ["label"],
          label: "ok-b",
          literalId: literalIdB,
        },
        inst,
        "cdn variant B"
      );
      assert.equal(inst.registryHits.create, 1, "create remains one after consumers");
      assertRegistryClearSnapshotZero(inst.registryHits, "cdn post");
      assertMaterialEffectsZero(fx, "cdn");
      assertSafeDiagnostics(fx.diagnostics, idA, null, "cdn");

      const ctx = ctxEarly;
      for (let hi = 0; hi < inst.ephemeralHandles.length; hi++) {
        ctx.forbiddenRefs.add(inst.ephemeralHandles[hi]);
        ctx.privacyHandles.add(inst.ephemeralHandles[hi]);
      }
      for (let li = 0; li < inst.originalLookupResults.length; li++) {
        ctx.forbiddenRefs.add(inst.originalLookupResults[li]);
      }
      for (let ri = 0; ri < inst.realRegistryInstances.length; ri++) {
        ctx.forbiddenRefs.add(inst.realRegistryInstances[ri]);
      }
      ctx.trustedErrors = new Set(stubRejections);
      const surfaces = [
        popup,
        popup2,
        popupAfterBind,
        fx.publishDetections,
        fx.diagnostics,
        rec.bound,
        rec.replay,
        replayAgain,
        boundB,
        root.after("cdn popupJobs", function () {
          return ctrl.popupJobs();
        }),
        stubRejections,
        inst.consoleCaptures,
      ];
      assertPublicSurfacePrivacy(
        surfaces,
        ctx.forbiddenStrings,
        "cdn public"
      );
      assertPublicSurfacePrivacy(
        [popup, popup2],
        ['"status"', "providerObservation"],
        "cdn popup evidence"
      );
      for (let i = 0; i < surfaces.length; i++) {
        scanPublicGraph(surfaces[i], ctx, "cdn surface " + i);
      }
      scanAllEffectArgs(fx, ctx, "cdn effects");
      assertRootGlobalsStable(
        inst,
        snapshotRootOwnGlobals(inst.root),
        ctx,
        "cdn globals"
      );
      const cdnRoles = auditPrivateHolders(
        inst,
        {
          captureCount: 2,
          nestedVariantMaps: 2,
          mediaIds: [idA, idB],
          intendedProviderSets: [
            {
              origin: BA07_NORM_ORIGIN_A,
              members: [BA07_PROVIDER],
              addHistory: [BA07_PROVIDER],
            },
            {
              origin: BA07_NORM_ORIGIN_B,
              members: [BA07_PROVIDER],
              addHistory: [BA07_PROVIDER],
            },
          ],
        },
        ctx.forbiddenRefs,
        "cdn holders"
      );
      root.check("cdn final globals");

      assert.deepEqual(
        cdnRoles.missingIntendedRoles,
        [],
        "cdn intended provider Sets present"
      );
      assert.equal(inst.registryHits.observe, 2, "exactly two observe");
      assert.equal(inst.registryHits.lookup, 2, "exactly two lookup");
      assertAttemptsPaired(inst.registryAttempts, 2, "cdn attempts");
      assert.deepEqual(
        inst.registryEvents.map((e) => e.method),
        ["observe", "lookup", "observe", "lookup"],
        "ordered observe/lookup pairs"
      );
      assert.deepEqual(inst.registryEvents[0], {
        method: "observe",
        mediaOrigin: BA07_NORM_ORIGIN_A,
        providerKey: BA07_PROVIDER,
      });
      assert.equal(inst.registryEvents[1].mediaOrigin, BA07_NORM_ORIGIN_A);
      assert.deepEqual(inst.registryEvents[1].result, {
        status: "one",
        providerKey: BA07_PROVIDER,
      });
      assert.deepEqual(inst.registryEvents[2], {
        method: "observe",
        mediaOrigin: BA07_NORM_ORIGIN_B,
        providerKey: BA07_PROVIDER,
      });
      assert.deepEqual(inst.registryEvents[3].result, {
        status: "one",
        providerKey: BA07_PROVIDER,
      });
      const liveA = inst.originalLookupResults[0];
      const liveB = inst.originalLookupResults[1];
      assert.ok(liveA && liveB, "live lookup refs retained test-privately");
      assert.notEqual(liveA, liveB);
      assertObservationMapExact(
        inst.trackedMaps,
        [idA, idB],
        { [idA]: liveA, [idB]: liveB },
        {
          [idA]: { status: "one", providerKey: BA07_PROVIDER },
          [idB]: { status: "one", providerKey: BA07_PROVIDER },
        },
        "cdn map"
      );
    }
  );

  await t.test(
    "reentrancy from observe/lookup cannot duplicate pair or publication",
    async () => {
      const inst = loadProviderInstrumentedClassic();
      const fx = makeProviderEffects();
      const ctrl = inst.api.createBackgroundAdapters(fx.options());
      const hookLog = [];
      const tickOutcomes = [];
      inst.hooks.onObserve = (origin, key) => {
        const pop = ctrl.popupMedia(702);
        ctrl.acceptPageSnapshot(
          providerNetworkSnapshot(
            "doc-ba07-reenter",
            702,
            BA07_PAGE,
            "reenter.mp4"
          )
        );
        const p = ctrl.tick(1_000_900);
        p.then(
          (v) => {
            tickOutcomes.push({ ok: true, value: v });
          },
          (e) => {
            tickOutcomes.push({ ok: false, error: e });
          }
        );
        hookLog.push({
          method: "observe",
          origin: origin,
          key: key,
          popup: pop,
          tick: p,
        });
      };
      inst.hooks.onLookup = (origin) => {
        const pop = ctrl.popupMedia(702);
        ctrl.acceptPageSnapshot(
          providerNetworkSnapshot(
            "doc-ba07-reenter",
            702,
            BA07_PAGE,
            "reenter2.mp4"
          )
        );
        const p = ctrl.tick(1_000_950);
        p.then(
          (v) => {
            tickOutcomes.push({ ok: true, value: v });
          },
          (e) => {
            tickOutcomes.push({ ok: false, error: e });
          }
        );
        hookLog.push({
          method: "lookup",
          origin: origin,
          popup: pop,
          tick: p,
        });
      };

      const mediaId = finalizeProviderNetwork(ctrl, fx, inst, {
        docId: "doc-ba07-reenter",
        tabId: 702,
        mediaUrl: "https://cdn-reenter.example/v.mp4",
        pageUrl: BA07_PAGE,
        filename: "reenter.mp4",
      });
      for (let i = 0; i < hookLog.length; i++) {
        if (hookLog[i].tick) await hookLog[i].tick;
      }
      await probeTickResolvesUndefined(ctrl, 1_001_000, "reenter outer tick");
      const popup = ctrl.popupMedia(702);
      assertPopupNoProviderFields(popup, "reenter popup");
      assert.equal(fx.counts.publishDetection, 1, "exactly one publication");
      assertSafeDetectionRow(
        publishRowFor(fx, mediaId),
        BA07_PROVIDER,
        "reenter publish"
      );
      for (let i = 0; i < tickOutcomes.length; i++) {
        assert.equal(tickOutcomes[i].ok, true, "hook tick " + i + " must resolve");
        assert.equal(tickOutcomes[i].value, undefined, "hook tick " + i);
      }
      assert.equal(inst.registryHits.create, 1);
      assertRegistryClearSnapshotZero(inst.registryHits, "reenter");
      assertMaterialEffectsZero(fx, "reenter");
      const reenterRoles = auditPrivateHolders(
        inst,
        {
          captureCount: 1,
          nestedVariantMaps: 0,
          mediaIds: [mediaId],
          intendedProviderSets: [
            {
              origin: "https://cdn-reenter.example",
              members: [BA07_PROVIDER],
              addHistory: [BA07_PROVIDER],
            },
          ],
        },
        inst.ephemeralHandles.concat(inst.realRegistryInstances),
        "reenter holders"
      );

      assert.deepEqual(reenterRoles.missingIntendedRoles, [], "reenter intended Sets");
      assert.equal(hookLog.length, 2, "observe and lookup hooks ran");
      assert.equal(inst.registryHits.observe, 1, "exactly one observe");
      assert.equal(inst.registryHits.lookup, 1, "exactly one lookup");
      assertAttemptsPaired(inst.registryAttempts, 1, "reenter attempts");
      assert.deepEqual(
        inst.registryEvents.map((e) => e.method),
        ["observe", "lookup"]
      );
      assert.deepEqual(inst.registryEvents[0], {
        method: "observe",
        mediaOrigin: "https://cdn-reenter.example",
        providerKey: BA07_PROVIDER,
      });
      assert.deepEqual(inst.registryEvents[1].result, {
        status: "one",
        providerKey: BA07_PROVIDER,
      });
      assertObservationMapExact(
        inst.trackedMaps,
        [mediaId],
        { [mediaId]: inst.originalLookupResults[0] },
        { [mediaId]: { status: "one", providerKey: BA07_PROVIDER } },
        "reenter map"
      );
    }
  );

  await t.test(
    "observe dependency exception: claim once, no lookup, no retry, no leak",
    async () => {
      const SECRET = "SECRET_DEPENDENCY_OBSERVE_XYZ_991";
      const thrownObserve = new Error(SECRET);
      const inst = loadProviderInstrumentedClassic();
      const fx = makeProviderEffects();
      const ctrl = inst.api.createBackgroundAdapters(fx.options());
      inst.hooks.throwOnObserve = thrownObserve;

      const mediaId = finalizeProviderNetwork(ctrl, fx, inst, {
        docId: "doc-ba07-obs-throw",
        tabId: 703,
        mediaUrl: "https://cdn-obs-throw.example/v.mp4",
        pageUrl: BA07_PAGE,
        filename: "obs-throw.mp4",
      });
      assert.equal(fx.counts.publishDetection, 1, "publication survives");
      const pub = publishRowFor(fx, mediaId);
      assertSafeDetectionRow(pub, BA07_PROVIDER, "obs-throw publish");

      ctrl.acceptPageSnapshot(
        providerNetworkSnapshot(
          "doc-ba07-obs-throw",
          703,
          BA07_PAGE,
          "obs-throw.mp4"
        )
      );
      await probeTickResolvesUndefined(ctrl, 1_001_100, "obs-throw tick");
      const popup = ctrl.popupMedia(703);
      assertPopupNoProviderFields(popup, "obs-throw popup");
      assertDependencyDiagnosticAgreement(
        fx,
        inst,
        mediaId,
        thrownObserve,
        "obs-throw"
      );
      const ctx = buildPrivacyScanContext({
        forbiddenStrings: ba07ForbiddenStrings([SECRET, "cdn-obs-throw.example"]),
        forbiddenRefs: [thrownObserve].concat(
          inst.ephemeralHandles,
          inst.realRegistryInstances
        ),
      });
      const surfaces = [
        fx.publishDetections,
        fx.diagnostics,
        popup,
        ctrl.popupJobs(),
        inst.consoleCaptures,
      ];
      assertPublicSurfacePrivacy(surfaces, ctx.forbiddenStrings, "obs-throw public");
      for (let i = 0; i < surfaces.length; i++) {
        scanPublicGraph(surfaces[i], ctx, "obs-throw surface " + i);
      }
      scanAllEffectArgs(fx, ctx, "obs-throw effects");
      assert.equal(inst.registryHits.create, 1);
      assertRegistryClearSnapshotZero(inst.registryHits, "obs-throw");
      assertMaterialEffectsZero(fx, "obs-throw");
      auditPrivateHolders(
        inst,
        {
          captureCount: 1,
          nestedVariantMaps: 0,
          mediaIds: [mediaId],
          intendedProviderSets: [],
        },
        ctx.forbiddenRefs,
        "obs-throw holders"
      );

      assert.equal(inst.registryHits.observe, 1, "observe attempted once");
      assert.equal(inst.registryHits.lookup, 0, "lookup not called");
      assert.equal(inst.registryAttempts.length, 1, "one observe attempt");
      assert.equal(inst.registryAttempts[0].method, "observe");
      assert.equal(inst.completedResults.length, 0, "no completed result");
      assert.equal(inst.registryHits.observe, 1, "no observe retry");
      assert.equal(inst.registryHits.lookup, 0, "no lookup after observe throw");
      assert.equal(fx.counts.publishDetection, 1);
      assertNoneEvidenceOnly(inst.trackedMaps, mediaId, "obs-throw none");
    }
  );

  await t.test(
    "lookup dependency exception: ordered pair once, none evidence, no leak",
    async () => {
      const SECRET = "SECRET_DEPENDENCY_LOOKUP_ABC_772";
      const thrownLookup = new Error(SECRET);
      const inst = loadProviderInstrumentedClassic();
      const fx = makeProviderEffects();
      const ctrl = inst.api.createBackgroundAdapters(fx.options());
      inst.hooks.throwOnLookup = thrownLookup;

      const mediaId = finalizeProviderNetwork(ctrl, fx, inst, {
        docId: "doc-ba07-lookup-throw",
        tabId: 704,
        mediaUrl: "https://cdn-lookup-throw.example/v.mp4",
        pageUrl: BA07_PAGE,
        filename: "lookup-throw.mp4",
      });
      assert.equal(fx.counts.publishDetection, 1);
      const pub = publishRowFor(fx, mediaId);
      assertSafeDetectionRow(pub, BA07_PROVIDER, "lookup-throw publish");

      const popup = ctrl.popupMedia(704);
      await probeTickResolvesUndefined(ctrl, 1_001_200, "lookup-throw tick");
      ctrl.acceptPageSnapshot(
        providerNetworkSnapshot(
          "doc-ba07-lookup-throw",
          704,
          BA07_PAGE,
          "lookup-throw.mp4"
        )
      );
      assertDependencyDiagnosticAgreement(
        fx,
        inst,
        mediaId,
        thrownLookup,
        "lookup-throw"
      );
      const ctx = buildPrivacyScanContext({
        forbiddenStrings: ba07ForbiddenStrings([
          SECRET,
          "cdn-lookup-throw.example",
        ]),
        forbiddenRefs: [thrownLookup].concat(
          inst.ephemeralHandles,
          inst.realRegistryInstances
        ),
      });
      const surfaces = [fx.publishDetections, fx.diagnostics, popup];
      assertPublicSurfacePrivacy(surfaces, ctx.forbiddenStrings, "lookup-throw public");
      for (let i = 0; i < surfaces.length; i++) {
        scanPublicGraph(surfaces[i], ctx, "lookup-throw surface " + i);
      }
      scanAllEffectArgs(fx, ctx, "lookup-throw effects");
      assert.equal(inst.registryHits.create, 1);
      assertRegistryClearSnapshotZero(inst.registryHits, "lookup-throw");
      assertMaterialEffectsZero(fx, "lookup-throw");
      const lookupThrowRoles = auditPrivateHolders(
        inst,
        {
          captureCount: 1,
          nestedVariantMaps: 0,
          mediaIds: [mediaId],
          intendedProviderSets: [
            {
              origin: "https://cdn-lookup-throw.example",
              members: [BA07_PROVIDER],
              addHistory: [BA07_PROVIDER],
            },
          ],
        },
        ctx.forbiddenRefs,
        "lookup-throw holders"
      );

      assert.deepEqual(lookupThrowRoles.missingIntendedRoles, [], "lookup-throw intended Sets");
      assert.equal(inst.registryHits.observe, 1);
      assert.equal(inst.registryHits.lookup, 1);
      assert.equal(inst.registryAttempts.length, 2, "observe then lookup attempts");
      assert.equal(inst.registryAttempts[0].method, "observe");
      assert.equal(inst.registryAttempts[1].method, "lookup");
      assert.deepEqual(
        inst.completedResults.map((c) => c.method),
        ["observe"],
        "one completed observe, no completed lookup"
      );
      assert.equal(inst.registryHits.observe, 1, "no retry observe");
      assert.equal(inst.registryHits.lookup, 1, "no retry lookup");
      assert.equal(fx.counts.publishDetection, 1);
      assertNoneEvidenceOnly(inst.trackedMaps, mediaId, "lookup-throw none");
    }
  );

  await t.test(
    "stable normalized document-session fallback for empty topLevelSite",
    async () => {
      const inst = loadProviderInstrumentedClassic();
      // Literal hand-derived fallbacks from accepted session algorithm + normalizer.
      assert.equal(
        inst.normalizeProviderKey("document-session:1"),
        BA07_FALLBACK_DOC_A
      );
      assert.equal(
        inst.normalizeProviderKey("document-session:2"),
        BA07_FALLBACK_DOC_B
      );
      assert.notEqual(BA07_FALLBACK_DOC_A, BA07_FALLBACK_DOC_B);

      const fx = makeProviderEffects();
      const ctrl = inst.api.createBackgroundAdapters(fx.options());

      // Empty top-level site/URL, same document-session identity, usable HTTP(S).
      const emptyPage = "";
      const id1 = finalizeProviderNetwork(ctrl, fx, inst, {
        docId: "doc-ba07-fallback-same",
        tabId: 705,
        mediaUrl: "https://cdn-fb-1.example/a.mp4",
        pageUrl: "https://placeholder.invalid/",
        filename: "fb1.mp4",
        captureOverrides: {
          details: {
            url: "https://cdn-fb-1.example/a.mp4",
            documentUrl: "",
            originUrl: "",
            tabId: 705,
            frameId: 0,
            documentId: "doc-ba07-fallback-same",
            timeStamp: 1_000_000,
            responseHeaders: [{ name: "Content-Type", value: "video/mp4" }],
          },
          hints: { topLevelUrlHint: "", frameOrigin: "" },
        },
        snapshotOverrides: {
          pageUrl: emptyPage,
          topLevelPageUrl: emptyPage,
        },
      });
      const id2 = finalizeProviderNetwork(ctrl, fx, inst, {
        docId: "doc-ba07-fallback-same",
        tabId: 705,
        mediaUrl: "https://cdn-fb-2.example/b.mp4",
        pageUrl: "https://placeholder.invalid/",
        filename: "fb2.mp4",
        captureOverrides: {
          details: {
            url: "https://cdn-fb-2.example/b.mp4",
            documentUrl: "",
            originUrl: "",
            tabId: 705,
            frameId: 0,
            documentId: "doc-ba07-fallback-same",
            timeStamp: 1_000_010,
            responseHeaders: [{ name: "Content-Type", value: "video/mp4" }],
          },
          hints: { topLevelUrlHint: "", frameOrigin: "" },
        },
        snapshotOverrides: {
          pageUrl: emptyPage,
          topLevelPageUrl: emptyPage,
        },
      });
      // Distinct approved document-session identity.
      const id3 = finalizeProviderNetwork(ctrl, fx, inst, {
        docId: "doc-ba07-fallback-other",
        tabId: 706,
        mediaUrl: "https://cdn-fb-3.example/c.mp4",
        pageUrl: "https://placeholder.invalid/",
        filename: "fb3.mp4",
        captureOverrides: {
          details: {
            url: "https://cdn-fb-3.example/c.mp4",
            documentUrl: "",
            originUrl: "",
            tabId: 706,
            frameId: 0,
            documentId: "doc-ba07-fallback-other",
            timeStamp: 1_000_020,
            responseHeaders: [{ name: "Content-Type", value: "video/mp4" }],
          },
          hints: { topLevelUrlHint: "", frameOrigin: "" },
        },
        snapshotOverrides: {
          pageUrl: emptyPage,
          topLevelPageUrl: emptyPage,
        },
      });

      assertSafeDetectionRow(
        publishRowFor(fx, id1),
        BA07_FALLBACK_DOC_A,
        "fb1"
      );
      assertSafeDetectionRow(
        publishRowFor(fx, id2),
        BA07_FALLBACK_DOC_A,
        "fb2"
      );
      assertSafeDetectionRow(
        publishRowFor(fx, id3),
        BA07_FALLBACK_DOC_B,
        "fb3"
      );

      await probeTickResolvesUndefined(ctrl, 1_001_050, "fallback tick");
      const pop705 = ctrl.popupMedia(705);
      const pop706 = ctrl.popupMedia(706);
      assertPopupNoProviderFields(pop705, "fallback 705");
      assertPopupNoProviderFields(pop706, "fallback 706");

      // Public surfaces must not use literal unknown, page URL, or CDN as provider.
      assertPublicSurfacePrivacy(
        [
          fx.publishDetections,
          fx.diagnostics,
          ctrl.popupMedia(705),
          ctrl.popupMedia(706),
        ],
        [
          "cdn-fb-1.example",
          "cdn-fb-2.example",
          "cdn-fb-3.example",
          "placeholder.invalid",
        ],
        "fallback public"
      );
      for (const row of fx.publishDetections) {
        assert.equal(row.providerKey.includes("cdn-"), false);
        assert.notEqual(row.providerKey, "unknown");
        assert.equal(row.providerKey.indexOf("document-session:"), 0);
      }
      for (let ei = 0; ei < inst.registryEvents.length; ei++) {
        const ev = inst.registryEvents[ei];
        if (ev.method === "observe") {
          assert.notEqual(ev.providerKey, "unknown");
          assert.equal(ev.providerKey.indexOf("document-session:"), 0);
        }
      }
      assertRegistryClearSnapshotZero(inst.registryHits, "fallback");
      assertMaterialEffectsZero(fx, "fallback");
      assert.equal(inst.registryHits.create, 1, "fallback create once");
      const fallbackRoles = auditPrivateHolders(
        inst,
        {
          captureCount: 3,
          nestedVariantMaps: 0,
          mediaIds: [id1, id2, id3],
          intendedProviderSets: [
            {
              origin: "https://cdn-fb-1.example",
              members: [BA07_FALLBACK_DOC_A],
              addHistory: [BA07_FALLBACK_DOC_A],
            },
            {
              origin: "https://cdn-fb-2.example",
              members: [BA07_FALLBACK_DOC_A],
              addHistory: [BA07_FALLBACK_DOC_A],
            },
            {
              origin: "https://cdn-fb-3.example",
              members: [BA07_FALLBACK_DOC_B],
              addHistory: [BA07_FALLBACK_DOC_B],
            },
          ],
        },
        inst.ephemeralHandles.concat(inst.realRegistryInstances),
        "fallback holders"
      );

      assert.deepEqual(fallbackRoles.missingIntendedRoles, [], "fallback intended Sets");
      assert.equal(inst.registryHits.observe, 3);
      assert.equal(inst.registryHits.lookup, 3);
      assertAttemptsPaired(inst.registryAttempts, 3, "fallback attempts");
      assert.deepEqual(inst.registryEvents[0], {
        method: "observe",
        mediaOrigin: "https://cdn-fb-1.example",
        providerKey: BA07_FALLBACK_DOC_A,
      });
      assert.deepEqual(inst.registryEvents[1].result, {
        status: "one",
        providerKey: BA07_FALLBACK_DOC_A,
      });
      assert.deepEqual(inst.registryEvents[2], {
        method: "observe",
        mediaOrigin: "https://cdn-fb-2.example",
        providerKey: BA07_FALLBACK_DOC_A,
      });
      assert.deepEqual(inst.registryEvents[3].result, {
        status: "one",
        providerKey: BA07_FALLBACK_DOC_A,
      });
      assert.deepEqual(inst.registryEvents[4], {
        method: "observe",
        mediaOrigin: "https://cdn-fb-3.example",
        providerKey: BA07_FALLBACK_DOC_B,
      });
      assert.deepEqual(inst.registryEvents[5].result, {
        status: "one",
        providerKey: BA07_FALLBACK_DOC_B,
      });
      assertObservationMapExact(
        inst.trackedMaps,
        [id1, id2, id3],
        {
          [id1]: inst.originalLookupResults[0],
          [id2]: inst.originalLookupResults[1],
          [id3]: inst.originalLookupResults[2],
        },
        {
          [id1]: { status: "one", providerKey: BA07_FALLBACK_DOC_A },
          [id2]: { status: "one", providerKey: BA07_FALLBACK_DOC_A },
          [id3]: { status: "one", providerKey: BA07_FALLBACK_DOC_B },
        },
        "fallback map"
      );
    }
  );

  await t.test(
    "source-structural: no literal unknown fallback; no media-origin provider authority",
    async () => {
      const src = productionSource();
      // Extract deriveProviderKey body — session fallback authority only.
      const m = src.match(
        /function\s+deriveProviderKey\s*\(\s*sourceContext\s*\)\s*\{([\s\S]*?)\n      \}/
      );
      assert.ok(m, "deriveProviderKey present");
      const body = m[1];
      assert.equal(
        /["']unknown["']/.test(body),
        false,
        "deriveProviderKey has no literal unknown"
      );
      assert.equal(
        /mediaOrigin/.test(body),
        false,
        "deriveProviderKey does not read mediaOrigin"
      );
      assert.equal(
        /mediaUrl/.test(body),
        false,
        "deriveProviderKey does not read mediaUrl"
      );
      // Provider association must not treat CDN/media host as provider authority.
      const assocSlice = src.slice(
        src.indexOf("function reconcile"),
        src.indexOf("function captureNetwork")
      );
      assert.equal(
        /providerKey\s*=\s*.*mediaOrigin/.test(assocSlice),
        false,
        "reconcile does not assign provider from mediaOrigin"
      );
      assert.equal(
        /["']unknown["']/.test(assocSlice),
        false,
        "reconcile has no literal unknown provider fallback"
      );
    }
  );

  await t.test(
    "positive HTTP(S) control: real normalizers and observe/lookup are live",
    async () => {
      const pos = loadProviderInstrumentedClassic();
      assert.equal(
        pos.normalizeOrigin("blob:https://cdn.example/uuid-blob"),
        "https://cdn.example",
        "blob collapses only if normalizeOrigin is reached"
      );
      assert.equal(
        pos.normalizeOrigin("HTTPS://X.Example:443/z"),
        "https://x.example"
      );
      const fxPos = makeProviderEffects();
      const ctrlPos = pos.api.createBackgroundAdapters(fxPos.options());
      const posId = finalizeProviderNetwork(ctrlPos, fxPos, pos, {
        docId: "doc-ba07-pos-control",
        tabId: 710,
        mediaUrl: "https://cdn-pos-control.example/v.mp4",
        pageUrl: BA07_PAGE,
        filename: "pos.mp4",
      });
      assertSafeDetectionRow(
        publishRowFor(fxPos, posId),
        BA07_PROVIDER,
        "pos"
      );
      await probeTickResolvesUndefined(ctrlPos, 1_001_010, "pos tick");
      assertPopupNoProviderFields(ctrlPos.popupMedia(710), "pos popup");
      assert.equal(pos.registryHits.create, 1);
      assertRegistryClearSnapshotZero(pos.registryHits, "pos");
      const posRoles = auditPrivateHolders(
        pos,
        {
          captureCount: 1,
          nestedVariantMaps: 0,
          mediaIds: [posId],
          intendedProviderSets: [
            {
              origin: "https://cdn-pos-control.example",
              members: [BA07_PROVIDER],
              addHistory: [BA07_PROVIDER],
            },
          ],
        },
        pos.ephemeralHandles.concat(pos.realRegistryInstances),
        "pos holders"
      );
      assert.deepEqual(posRoles.missingIntendedRoles, [], "pos intended Sets");
      assert.equal(pos.registryHits.observe, 1, "positive control observe");
      assert.equal(pos.registryHits.lookup, 1, "positive control lookup");
      assert.deepEqual(pos.registryEvents[0], {
        method: "observe",
        mediaOrigin: "https://cdn-pos-control.example",
        providerKey: BA07_PROVIDER,
      });
    }
  );

  const schemeCases = [
    {
      name: "blob-https",
      mediaOrigin: "blob:https://cdn.example/uuid-blob",
      mediaUrl: "blob:https://cdn.example/uuid-blob",
      docId: "doc-ba07-blob",
      forbid: ["blob:https:", "cdn.example"],
    },
    {
      name: "ftp",
      mediaOrigin: "ftp://cdn.example/file.mp4",
      mediaUrl: "ftp://cdn.example/file.mp4",
      docId: "doc-ba07-ftp",
      forbid: ["ftp://cdn.example", "cdn.example"],
    },
    {
      name: "file",
      mediaOrigin: "file:///tmp/x.mp4",
      mediaUrl: "file:///tmp/x.mp4",
      docId: "doc-ba07-file",
      forbid: ["file:///"],
    },
    {
      name: "data",
      mediaOrigin: "data:video/mp4,abc",
      mediaUrl: "data:video/mp4,abc",
      docId: "doc-ba07-data",
      forbid: ["data:video/mp4"],
    },
    {
      name: "empty",
      mediaOrigin: "",
      mediaUrl: "https://ignored-empty-origin.example/v.mp4",
      docId: "doc-ba07-empty-origin",
      forbid: ["ignored-empty-origin.example"],
    },
    {
      name: "malformed",
      mediaOrigin: "not-a-url",
      mediaUrl: "https://ignored-malformed.example/v.mp4",
      docId: "doc-ba07-malformed",
      forbid: ["ignored-malformed.example"],
    },
    {
      name: "ws",
      mediaOrigin: "ws://cdn.example/stream",
      mediaUrl: "ws://cdn.example/stream",
      docId: "doc-ba07-ws",
      forbid: ["ws://cdn.example", "cdn.example"],
    },
    {
      name: "whitespace",
      mediaOrigin: "   ",
      mediaUrl: "https://ignored-whitespace.example/v.mp4",
      docId: "doc-ba07-whitespace",
      forbid: ["ignored-whitespace.example"],
    },
    {
      name: "mailto",
      mediaOrigin: "mailto:user@cdn.example",
      mediaUrl: "mailto:user@cdn.example",
      docId: "doc-ba07-mailto",
      forbid: ["mailto:user@cdn.example"],
    },
    {
      name: "about",
      mediaOrigin: "about:blank",
      mediaUrl: "about:blank",
      docId: "doc-ba07-about",
      forbid: ["about:blank"],
    },
    {
      name: "gopher",
      mediaOrigin: "gopher://cdn.example/file.mp4",
      mediaUrl: "gopher://cdn.example/file.mp4",
      docId: "doc-ba07-gopher",
      forbid: ["gopher://cdn.example"],
    },
  ];

  for (let si = 0; si < schemeCases.length; si++) {
    const c = schemeCases[si];
    await t.test(
      "origin fail-closed scheme: " + c.name,
      async () => {
        const inst = loadProviderInstrumentedClassic();
        const fx = makeProviderEffects();
        const ctrl = inst.api.createBackgroundAdapters(fx.options());
        const mediaId = finalizeProviderDom(ctrl, fx, inst, {
          docId: c.docId,
          tabId: 720 + si,
          pageUrl: BA07_PAGE,
          mediaUrl: c.mediaUrl,
          mediaOrigin: c.mediaOrigin,
          filename: c.name + ".mp4",
        });
        assert.equal(fx.counts.publishDetection, 1, c.name + " published");
        assertSafeDetectionRow(
          publishRowFor(fx, mediaId),
          BA07_PROVIDER,
          c.name + " publish"
        );
        await probeTickResolvesUndefined(ctrl, 1_001_300 + si, c.name + " tick");
        const popup = ctrl.popupMedia(720 + si);
        assertPopupNoProviderFields(
          popup,
          { length: 1, variantLengths: [0] },
          c.name + " popup"
        );
        const schemeRec = findPrivateMediaRecord(
          inst,
          { mediaId: mediaId, hasFutureTransport: false },
          c.name + " media"
        );
        assertPrivateMediaShape(
          schemeRec,
          {
            mediaId: mediaId,
            proposedFilename: c.name + ".mp4",
            mediaKind: "direct",
            providerKey: BA07_PROVIDER,
            tabId: 720 + si,
            detectionId: 1,
            mediaUrl: c.mediaUrl,
            hasFutureTransport: false,
          },
          inst,
          c.name + " media"
        );
        const schemeCtx = buildPrivacyScanContext({
          forbiddenStrings: ba07ForbiddenStrings(c.forbid),
          forbiddenRefs: inst.ephemeralHandles.concat(inst.realRegistryInstances),
          privacyHandles: inst.ephemeralHandles,
        });
        scanPublicGraph(popup, schemeCtx, c.name + " popup graph");
        scanPublicGraph(fx.publishDetections, schemeCtx, c.name + " publish graph");
        scanAllEffectArgs(fx, schemeCtx, c.name + " effects");
        assertRootGlobalsStable(
          inst,
          snapshotRootOwnGlobals(inst.root),
          schemeCtx,
          c.name + " globals"
        );
        const schemeRoles = auditPrivateHolders(
          inst,
          {
            captureCount: 1,
            nestedVariantMaps: 0,
            mediaIds: [mediaId],
            intendedProviderSets: [],
          },
          inst.ephemeralHandles.concat(inst.realRegistryInstances),
          c.name + " holders"
        );
        assert.deepEqual(schemeRoles.missingIntendedRoles, [], c.name + " no intended Sets");
        assert.equal(inst.registryHits.observe, 0, c.name + " zero observe");
        assert.equal(inst.registryHits.lookup, 0, c.name + " zero lookup");
        assert.equal(inst.registryAttempts.length, 0, c.name + " no attempts");
        assert.equal(inst.registryEvents.length, 0, c.name + " no events");
        assert.equal(inst.registryHits.create, 1, c.name + " create once");
        assertRegistryClearSnapshotZero(inst.registryHits, c.name);
        assertMaterialEffectsZero(fx, c.name);
        assertPublicSurfacePrivacy(
          [fx.publishDetections, popup, fx.diagnostics],
          c.forbid,
          c.name + " public"
        );
        assertNoneEvidenceOnly(inst.trackedMaps, mediaId, c.name + " none");
      }
    );
  }

  const wrapCases = [
    { name: "number", kind: "number" },
    { name: "boxed-string", kind: "boxed" },
    { name: "hostile-object", kind: "hostile" },
    { name: "null", kind: "null" },
    { name: "undefined", kind: "undefined" },
  ];
  for (let wi = 0; wi < wrapCases.length; wi++) {
    const spec = wrapCases[wi];
    await t.test(
      "origin fail-closed wrapper type: " + spec.name,
      async () => {
        let value;
        let hostileHits = null;
        if (spec.kind === "number") {
          value = 42;
        } else if (spec.kind === "boxed") {
          const foreignBoxed = createForeignBoxedString();
          value = foreignBoxed.boxed;
        } else if (spec.kind === "hostile") {
          const foreignHostile = createForeignHostileOrigin();
          value = foreignHostile.hostile;
          hostileHits = foreignHostile.hits;
        } else if (spec.kind === "null") {
          value = null;
        } else {
          value = undefined;
        }
        const overrides = new Map();
        overrides.set(1, value);
        const inst = loadProviderInstrumentedClassic({
          originOverrides: overrides,
        });
        const fx = makeProviderEffects();
        const ctrl = inst.api.createBackgroundAdapters(fx.options());
        const mediaId = finalizeProviderDom(ctrl, fx, inst, {
          docId: "doc-ba07-wrap-" + spec.name,
          tabId: 740 + wi,
          pageUrl: BA07_PAGE,
          mediaUrl: "https://cdn-wrap-control.example/v.mp4",
          mediaOrigin: "https://cdn-wrap-control.example",
          filename: "wrap-" + spec.name + ".mp4",
        });
        assert.equal(fx.counts.publishDetection, 1, spec.name + " wrap published");
        assertSafeDetectionRow(
          publishRowFor(fx, mediaId),
          BA07_PROVIDER,
          spec.name + " wrap publish"
        );
        await probeTickResolvesUndefined(
          ctrl,
          1_001_400 + wi,
          spec.name + " wrap tick"
        );
        const popup = ctrl.popupMedia(740 + wi);
        assertPopupNoProviderFields(
          popup,
          { length: 1, variantLengths: [0] },
          spec.name + " wrap popup"
        );
        if (hostileHits) {
          assert.equal(hostileHits.valueOf, 0, spec.name + " valueOf not invoked");
          assert.equal(hostileHits.toString, 0, spec.name + " toString not invoked");
        }
        const wrapRec = findPrivateMediaRecord(
          inst,
          { mediaId: mediaId, hasFutureTransport: false },
          spec.name + " wrap media"
        );
        assertPrivateMediaShape(
          wrapRec,
          {
            mediaId: mediaId,
            proposedFilename: "wrap-" + spec.name + ".mp4",
            mediaKind: "direct",
            providerKey: BA07_PROVIDER,
            tabId: 740 + wi,
            detectionId: 1,
            mediaUrl: "https://cdn-wrap-control.example/v.mp4",
            hasFutureTransport: false,
          },
          inst,
          spec.name + " wrap media"
        );
        const wrapCtx = buildPrivacyScanContext({
          forbiddenStrings: ba07ForbiddenStrings(["cdn-wrap-control.example"]),
          forbiddenRefs: inst.ephemeralHandles.concat(inst.realRegistryInstances),
          privacyHandles: inst.ephemeralHandles,
        });
        scanPublicGraph(popup, wrapCtx, spec.name + " wrap popup graph");
        scanAllEffectArgs(fx, wrapCtx, spec.name + " wrap effects");
        assertRootGlobalsStable(
          inst,
          snapshotRootOwnGlobals(inst.root),
          wrapCtx,
          spec.name + " wrap globals"
        );
        const wrapRoles = auditPrivateHolders(
          inst,
          {
            captureCount: 1,
            nestedVariantMaps: 0,
            mediaIds: [mediaId],
            intendedProviderSets: [],
            overrideDetectionId: 1,
          },
          inst.ephemeralHandles.concat(inst.realRegistryInstances),
          spec.name + " wrap holders"
        );
        assert.deepEqual(wrapRoles.missingIntendedRoles, [], spec.name + " wrap no intended Sets");
        assert.equal(inst.registryHits.observe, 0, spec.name + " wrap zero observe");
        assert.equal(inst.registryHits.lookup, 0, spec.name + " wrap zero lookup");
        assert.equal(inst.registryAttempts.length, 0, spec.name + " wrap no attempts");
        assert.equal(inst.registryHits.create, 1, spec.name + " create once");
        assertRegistryClearSnapshotZero(inst.registryHits, "wrap " + spec.name);
        assertMaterialEffectsZero(fx, "wrap " + spec.name);
        assertPublicSurfacePrivacy(
          [fx.publishDetections, popup, fx.diagnostics],
          ["cdn-wrap-control.example"],
          spec.name + " wrap public"
        );
        assertNoneEvidenceOnly(inst.trackedMaps, mediaId, spec.name + " wrap none");
      }
    );
  }

  await t.test(
    "positive HTTP(S) control after fail-closed keeps normalizers live",
    async () => {
      const pos2 = loadProviderInstrumentedClassic();
      const fx2 = makeProviderEffects();
      const ctrl2 = pos2.api.createBackgroundAdapters(fx2.options());
      const id = finalizeProviderNetwork(ctrl2, fx2, pos2, {
        docId: "doc-ba07-pos-after",
        tabId: 799,
        mediaUrl: "https://cdn-pos-after.example/v.mp4",
        pageUrl: BA07_PAGE,
        filename: "pos-after.mp4",
      });
      assert.equal(
        pos2.normalizeOrigin("HTTPS://X.Example:443/z"),
        "https://x.example"
      );
      assertSafeDetectionRow(publishRowFor(fx2, id), BA07_PROVIDER, "pos-after");
      await probeTickResolvesUndefined(ctrl2, 1_001_500, "pos-after tick");
      assert.equal(pos2.registryHits.create, 1);
      const posAfterRoles = auditPrivateHolders(
        pos2,
        {
          captureCount: 1,
          nestedVariantMaps: 0,
          mediaIds: [id],
          intendedProviderSets: [
            {
              origin: "https://cdn-pos-after.example",
              members: [BA07_PROVIDER],
              addHistory: [BA07_PROVIDER],
            },
          ],
        },
        pos2.ephemeralHandles.concat(pos2.realRegistryInstances),
        "pos-after holders"
      );
      assert.deepEqual(posAfterRoles.missingIntendedRoles, [], "pos-after intended Sets");
      assert.equal(pos2.registryHits.observe, 1, "post-matrix positive observe");
      assert.equal(pos2.registryHits.lookup, 1, "post-matrix positive lookup");
    }
  );

  await t.test(
    "positive DOM fixture: real normalizer identities feed observe arguments",
    async () => {
      const inst = loadProviderInstrumentedClassic();
      assert.equal(inst.normalizeOrigin, inst.root.McProviderRegistry.normalizeOrigin);
      assert.equal(
        inst.normalizeProviderKey,
        inst.root.McProviderRegistry.normalizeProviderKey
      );
      assert.equal(
        inst.normalizeOrigin(BA07_DOM_RAW_ORIGIN),
        BA07_DOM_NORM_ORIGIN,
        "hand-derived DOM origin"
      );
      assert.equal(
        inst.normalizeProviderKey(BA07_RAW_PROVIDER),
        BA07_PROVIDER,
        "hand-derived DOM provider"
      );
      const fx = makeProviderEffects();
      const ctrl = inst.api.createBackgroundAdapters(fx.options());
      const mediaId = finalizeProviderDom(ctrl, fx, inst, {
        docId: "doc-ba07-dom-norm",
        tabId: 711,
        pageUrl: "https://WWW.FlorEnFile.COM/watch/SECRET_PAGE_PATH",
        mediaUrl: "https://dom-cdn.example/path/v.mp4",
        mediaOrigin: BA07_DOM_RAW_ORIGIN,
        filename: "dom-norm.mp4",
      });
      assertSafeDetectionRow(
        publishRowFor(fx, mediaId),
        BA07_PROVIDER,
        "dom-norm"
      );
      await probeTickResolvesUndefined(ctrl, 1_001_520, "dom-norm tick");
      assertPopupNoProviderFields(ctrl.popupMedia(711), "dom-norm popup");
      assert.equal(inst.registryHits.create, 1);
      const domRoles = auditPrivateHolders(
        inst,
        {
          captureCount: 1,
          nestedVariantMaps: 0,
          mediaIds: [mediaId],
          intendedProviderSets: [
            {
              origin: BA07_DOM_NORM_ORIGIN,
              members: [BA07_PROVIDER],
              addHistory: [BA07_PROVIDER],
            },
          ],
        },
        inst.ephemeralHandles.concat(inst.realRegistryInstances),
        "dom-norm holders"
      );
      assert.deepEqual(domRoles.missingIntendedRoles, [], "dom intended Sets");
      assert.equal(inst.registryHits.observe, 1, "dom observe once");
      assert.equal(inst.registryHits.lookup, 1, "dom lookup once");
      assert.deepEqual(inst.registryEvents[0], {
        method: "observe",
        mediaOrigin: BA07_DOM_NORM_ORIGIN,
        providerKey: BA07_PROVIDER,
      });
      assert.equal(inst.registryAttempts[0].mediaOrigin, BA07_DOM_NORM_ORIGIN);
      assert.equal(inst.registryAttempts[0].providerKey, BA07_PROVIDER);
    }
  );

  await t.test(
    "future-method stubs reject immediately; tick resolves undefined",
    async () => {
      const inst = loadProviderInstrumentedClassic();
      const fx = makeProviderEffects();
      const callerMap = new Map([["k", "SECRET_MAP_VALUE"]]);
      const callerSet = new Set(["SECRET_SET_VALUE"]);
      const ctrl = inst.api.createBackgroundAdapters(fx.options());
      const mediaId = finalizeProviderNetwork(ctrl, fx, inst, {
        docId: "doc-ba07-stubs",
        tabId: 712,
        mediaUrl: "https://cdn-stubs.example/v.mp4",
        pageUrl: BA07_PAGE,
        filename: "stubs.mp4",
      });
      assert.ok(mediaId);
      const rejections = await probeFutureAsyncStubs(
        ctrl,
        {
          enqueueMessage: {
            item: {
              url: "https://override.example/SECRET_SIGNED_QUERY_XYZ.mp4",
              providerKey: "SECRET_CALLER_PROVIDER",
              callerMap: callerMap,
              callerSet: callerSet,
            },
          },
        },
        "ba07 stubs"
      );
      await probeTickResolvesUndefined(ctrl, 1_001_530, "ba07 stubs tick");
      const ctx = buildPrivacyScanContext({
        forbiddenStrings: ba07ForbiddenStrings(["SECRET_MAP_VALUE", "SECRET_SET_VALUE"]),
        forbiddenRefs: [callerMap, callerSet].concat(
          inst.ephemeralHandles,
          inst.realRegistryInstances
        ),
        trustedErrors: rejections,
        privacyHandles: inst.ephemeralHandles,
      });
      for (let i = 0; i < rejections.length; i++) {
        scanPublicGraph(rejections[i], ctx, "ba07 stub rejection " + i);
      }
      scanAllEffectArgs(fx, ctx, "ba07 stub effects");
      assert.equal(inst.registryHits.create, 1);
      assert.equal(fx.effectArgs.publishJobs.length, 0);
      assert.equal(fx.effectArgs.persistHistory.length, 0);
      auditPrivateHolders(
        inst,
        {
          captureCount: 1,
          nestedVariantMaps: 0,
          mediaIds: [mediaId],
          intendedProviderSets: [
            {
              origin: "https://cdn-stubs.example",
              members: [BA07_PROVIDER],
              addHistory: [BA07_PROVIDER],
            },
          ],
        },
        ctx.forbiddenRefs,
        "ba07 stub holders"
      );
    }
  );

  await t.test(
    "invalid registration then explicit bind then completed replay",
    async () => {
      const inst = loadProviderInstrumentedClassic();
      const fx = makeProviderEffects();
      const ctrl = inst.api.createBackgroundAdapters(fx.options());
      const mediaId = finalizeProviderNetwork(ctrl, fx, inst, {
        docId: "doc-ba07-reg",
        tabId: 713,
        mediaUrl: "https://cdn-reg.example/v.mp4",
        pageUrl: BA07_PAGE,
        filename: "reg.mp4",
      });
      const rec = runInvalidThenBindThenReplay(
        ctrl,
        fx,
        inst,
        mediaId,
        BA07_EXPLICIT_VARIANT,
        "ba07-reg"
      );
      assert.equal(rec.bound.length, 1);
      assert.equal(rec.replay.length, 1);
      assert.equal(inst.privacyCalls.some((c) => c.mediaUrl === BA07_EXPLICIT_VARIANT), true);
      assert.equal(inst.registryHits.create, 1);
      assertMaterialEffectsZero(fx, "ba07-reg");
      auditPrivateHolders(
        inst,
        {
          captureCount: 1,
          nestedVariantMaps: 1,
          mediaIds: [mediaId],
          intendedProviderSets: [
            {
              origin: "https://cdn-reg.example",
              members: [BA07_PROVIDER],
              addHistory: [BA07_PROVIDER],
            },
          ],
        },
        inst.ephemeralHandles.concat(inst.realRegistryInstances),
        "ba07-reg holders"
      );
    }
  );

  await t.test(
    "futureTransport.variants remains dormant until explicit registerVariants",
    async () => {
      await runFutureTransportDormancyFixture({
        label: "ba07-ft",
        docId: "doc-ba07-ft",
        tabId: 714,
        mediaUrl: "https://cdn-ft.example/base.mp4",
        pageUrl: BA07_PAGE,
        filename: "ft.mp4",
        ftUrl: BA07_FT_URL,
        mutatedUrl: "https://mutated.example/changed.mp4",
        explicitUrl: BA07_EXPLICIT_VARIANT,
        providerKey: BA07_PROVIDER,
        tickMs: 1_001_540,
        accessorSecret: "SECRET_FT_ACCESSOR",
        forbiddenStrings: ba07ForbiddenStrings(["SECRET_FT_ACCESSOR"]),
      });
    }
  );

  await t.test(
    "protocol-guard source-slice dominates normalizeOrigin",
    async () => {
      assertRawOriginGuardDominatesNormalizeOrigin(
        productionSource(),
        "ba07 protocol guard"
      );
    }
  );
});

test("BA08 — shared CDN ambiguity is live, stable, and never merges source provider keys", async (t) => {
  // Mutation caught: last-writer-wins, CDN-host provider authority, stale cached
  // lookup, ambiguous lookup inheritance, provider-group collapse, public registry
  // projection, or caller override authority.

  function ba08Forbidden(extra) {
    return [
      BA08_SHARED_NORM,
      "shared-cdn.example",
      "Shared-CDN.Example",
      "SECRET_BA08_USERINFO",
      "SECRET_BA08_FRAGMENT",
      "SECRET_SIGNED_QUERY_XYZ",
      "SECRET_COOKIE_ABC",
      "SECRET_AUTH_BEARER_TOKEN",
      "SECRET_BA08_PROVIDER_OVERRIDE",
      "SECRET_BA08_ORIGIN_OVERRIDE",
      "SECRET_BA08_FT_USER",
      "SECRET_BA08_FT_QUERY",
      "SECRET_BA08_FT_FRAG",
      "SECRET_EXPLICIT_QUERY",
      "SECRET_REPLAY_TRAP",
      "SECRET_CALLER_PROVIDER",
      "user:SECRET_BA08_USERINFO",
      "providerObservation",
    ].concat(extra || []);
  }

  await t.test(
    "future-method stubs reject immediately; tick resolves undefined",
    async () => {
      const inst = loadProviderInstrumentedClassic();
      const fx = makeProviderEffects();
      const callerMap = new Map([["k", "SECRET_MAP_VALUE"]]);
      const callerSet = new Set(["SECRET_SET_VALUE"]);
      const ctrl = inst.api.createBackgroundAdapters(fx.options());
      const mediaId = finalizeProviderNetwork(ctrl, fx, inst, {
        docId: "doc-ba08-stubs",
        tabId: 810,
        mediaUrl: BA08_URL_1,
        pageUrl: BA08_PAGE_A1,
        filename: "stub.mp4",
      });
      assert.ok(mediaId);
      const rejections = await probeFutureAsyncStubs(
        ctrl,
        {
          enqueueMessage: {
            item: {
              url: BA08_URL_1,
              providerKey: "SECRET_CALLER_PROVIDER",
              callerMap: callerMap,
              callerSet: callerSet,
            },
          },
        },
        "ba08 stubs"
      );
      await probeTickResolvesUndefined(ctrl, 1_002_100, "ba08 stubs tick");
      const ctx = buildPrivacyScanContext({
        forbiddenStrings: ba08Forbidden(["SECRET_MAP_VALUE", "SECRET_SET_VALUE"]),
        forbiddenRefs: [callerMap, callerSet].concat(
          inst.ephemeralHandles,
          inst.realRegistryInstances
        ),
        trustedErrors: rejections,
        privacyHandles: inst.ephemeralHandles,
      });
      for (let i = 0; i < rejections.length; i++) {
        scanPublicGraph(rejections[i], ctx, "ba08 stub rejection " + i);
      }
      scanAllEffectArgs(fx, ctx, "ba08 stub effects");
      assert.equal(inst.registryHits.create, 1);
      auditPrivateHolders(
        inst,
        {
          captureCount: 1,
          nestedVariantMaps: 0,
          mediaIds: [mediaId],
          intendedProviderSets: [
            {
              origin: BA08_SHARED_NORM,
              members: [BA08_PROVIDER_A],
              addHistory: [BA08_PROVIDER_A],
            },
          ],
        },
        ctx.forbiddenRefs,
        "ba08 stub holders"
      );
    }
  );

  await t.test(
    "futureTransport.variants dormancy on shared-CDN media",
    async () => {
      await runFutureTransportDormancyFixture({
        label: "ba08-ft",
        docId: "doc-ba08-ft",
        tabId: 811,
        mediaUrl: BA08_URL_1,
        pageUrl: BA08_PAGE_A1,
        filename: "ft.mp4",
        ftUrl: BA08_FT_URL,
        mutatedUrl: "https://mutated-ba08.example/changed.mp4",
        explicitUrl: BA08_EXPLICIT_VARIANT,
        providerKey: BA08_PROVIDER_A,
        tickMs: 1_002_110,
        accessorSecret: "SECRET_BA08_FT_ACCESSOR",
        forbiddenStrings: ba08Forbidden(["SECRET_BA08_FT_ACCESSOR"]),
      });
    }
  );

  await t.test(
    "invalid registration then explicit bind then completed replay on first media",
    async () => {
      const inst = loadProviderInstrumentedClassic();
      const fx = makeProviderEffects();
      const ctrl = inst.api.createBackgroundAdapters(fx.options());
      const mediaId = finalizeProviderNetwork(ctrl, fx, inst, {
        docId: "doc-ba08-reg",
        tabId: 812,
        mediaUrl: BA08_URL_1,
        pageUrl: BA08_PAGE_A1,
        filename: "reg.mp4",
      });
      const rec = runInvalidThenBindThenReplay(
        ctrl,
        fx,
        inst,
        mediaId,
        BA08_EXPLICIT_VARIANT,
        "ba08-reg"
      );
      assert.equal(rec.bound.length, 1);
      assert.equal(rec.replay.length, 1);
      assert.equal(inst.registryHits.create, 1);
      assertMaterialEffectsZero(fx, "ba08-reg");
      auditPrivateHolders(
        inst,
        {
          captureCount: 1,
          nestedVariantMaps: 1,
          mediaIds: [mediaId],
          intendedProviderSets: [
            {
              origin: BA08_SHARED_NORM,
              members: [BA08_PROVIDER_A],
              addHistory: [BA08_PROVIDER_A],
            },
          ],
        },
        inst.ephemeralHandles.concat(inst.realRegistryInstances),
        "ba08-reg holders"
      );
    }
  );

  await t.test(
    "three media on one CDN: one then ambiguous live lookups; source keys stable",
    async () => {
      const inst = loadProviderInstrumentedClassic();
      assert.equal(
        inst.normalizeOrigin(BA08_SHARED_RAW),
        BA08_SHARED_NORM,
        "hand-derived shared origin"
      );
      assert.equal(
        inst.normalizeProviderKey("provider-a.example"),
        BA08_PROVIDER_A
      );
      assert.equal(
        inst.normalizeProviderKey("provider-b.example"),
        BA08_PROVIDER_B
      );

      const fx = makeProviderEffects();
      const callerMap = new Map([["k", "SECRET_MAP_VALUE"]]);
      const callerSet = new Set(["SECRET_SET_VALUE"]);
      const callerHeaders = {
        Cookie: "session=SECRET_COOKIE_ABC",
        Authorization: "Bearer SECRET_AUTH_BEARER_TOKEN",
      };
      const callerSourceContext = {
        mediaOrigin: "https://override.example",
        providerKey: "SECRET_CALLER_PROVIDER",
      };
      const ctrl = inst.api.createBackgroundAdapters(fx.options());

      assert.equal(inst.normalizeOrigin(BA08_URL_1), BA08_SHARED_NORM);
      assert.equal(inst.normalizeOrigin(BA08_URL_2), BA08_SHARED_NORM);
      assert.equal(inst.normalizeOrigin(BA08_URL_3), BA08_SHARED_NORM);
      assert.notEqual(BA08_URL_1, BA08_URL_2);
      assert.notEqual(BA08_URL_2, BA08_URL_3);
      assert.notEqual(BA08_URL_1, BA08_URL_3);

      const id1 = finalizeProviderNetwork(ctrl, fx, inst, {
        docId: "doc-ba08-1",
        tabId: 801,
        mediaUrl: BA08_URL_1,
        pageUrl: BA08_PAGE_A1,
        filename: "a1.mp4",
        captureOverrides: {
          transport: {
            mediaKind: "direct",
            requestHeaders: callerHeaders,
          },
          sourceContext: callerSourceContext,
          callerMap: callerMap,
          callerSet: callerSet,
          providerKey: "SECRET_CALLER_PROVIDER",
        },
      });
      const id2 = finalizeProviderNetwork(ctrl, fx, inst, {
        docId: "doc-ba08-2",
        tabId: 802,
        mediaUrl: BA08_URL_2,
        pageUrl: BA08_PAGE_B,
        filename: "b.mp4",
      });
      const id3 = finalizeProviderNetwork(ctrl, fx, inst, {
        docId: "doc-ba08-3",
        tabId: 803,
        mediaUrl: BA08_URL_3,
        pageUrl: BA08_PAGE_A2,
        filename: "a2.mp4",
      });
      assert.notEqual(id1, id2);
      assert.notEqual(id2, id3);

      assertSafeDetectionRow(publishRowFor(fx, id1), BA08_PROVIDER_A, "ba08 p1");
      assertSafeDetectionRow(publishRowFor(fx, id2), BA08_PROVIDER_B, "ba08 p2");
      assertSafeDetectionRow(publishRowFor(fx, id3), BA08_PROVIDER_A, "ba08 p3");
      assert.equal(fx.counts.publishDetection, 3);

      ctrl.acceptPageSnapshot(
        providerNetworkSnapshot("doc-ba08-1", 801, BA08_PAGE_A1, "a1.mp4")
      );
      ctrl.acceptPageSnapshot(
        providerNetworkSnapshot(
          "doc-ba08-nav",
          801,
          "https://provider-a.example/navigated",
          "nav.mp4"
        )
      );
      await probeTickResolvesUndefined(ctrl, 1_002_000, "ba08 tick");
      const pop1 = ctrl.popupMedia(801);
      const pop2 = ctrl.popupMedia(802);
      const pop3 = ctrl.popupMedia(803);
      assert.equal(pop1.length, 1);
      assert.equal(pop2.length, 1);
      assert.equal(pop3.length, 1);
      assertPopupNoProviderFields(
        pop1,
        { length: 1, variantLengths: [0] },
        "ba08 pop1"
      );
      assertPopupNoProviderFields(
        pop2,
        { length: 1, variantLengths: [0] },
        "ba08 pop2"
      );
      assertPopupNoProviderFields(
        pop3,
        { length: 1, variantLengths: [0] },
        "ba08 pop3"
      );

      const rec = runInvalidThenBindThenReplay(
        ctrl,
        fx,
        inst,
        id1,
        BA08_EXPLICIT_VARIANT,
        "ba08-aba"
      );
      let overrideHits = 0;
      const hostileReplay = [
        {
          url: "https://shared-cdn.example/override.mp4",
          get providerKey() {
            overrideHits += 1;
            throw new Error("SECRET_BA08_PROVIDER_OVERRIDE");
          },
          get mediaOrigin() {
            overrideHits += 1;
            throw new Error("SECRET_BA08_ORIGIN_OVERRIDE");
          },
        },
      ];
      const replayBaseline = snapshotEffectState(fx, inst);
      const replayAgain = ctrl.registerVariants(id1, hostileReplay);
      assert.equal(overrideHits, 0, "unknown override getters never run");
      assertProjectionGraphsEqual(
        snapshotProjectionGraph(replayAgain, "ba08 hostile replay"),
        rec.boundSnap,
        "ba08 hostile replay"
      );
      assertEffectStateEqual(
        replayBaseline,
        snapshotEffectState(fx, inst),
        "ba08 hostile replay effects"
      );
      const pop1After = ctrl.popupMedia(801);
      assertPopupNoProviderFields(
        pop1After,
        {
          length: 1,
          variantLengths: [1],
          rows: [
            {
              variantsLength: 1,
              variants: [{ id: rec.literalId, label: "ok", keys: ["id", "label"] }],
            },
          ],
        },
        "ba08 pop1 after bind"
      );

      const stubRejections = await probeFutureAsyncStubs(
        ctrl,
        {
          enqueueMessage: {
            item: {
              url: BA08_URL_1,
              providerKey: "SECRET_CALLER_PROVIDER",
              callerMap: callerMap,
              callerSet: callerSet,
            },
          },
        },
        "ba08 aba stubs"
      );

      assert.equal(publishRowFor(fx, id1).providerKey, BA08_PROVIDER_A);
      assert.equal(publishRowFor(fx, id2).providerKey, BA08_PROVIDER_B);
      assert.equal(publishRowFor(fx, id3).providerKey, BA08_PROVIDER_A);
      for (const row of fx.publishDetections) {
        assert.notEqual(row.providerKey, "shared-cdn.example");
        const rowKeys = ownKeysOrFail(row, "ba08 publish row");
        assert.equal(rowKeys.indexOf("status"), -1, "ba08 publish no status");
      }

      const ctx = buildPrivacyScanContext({
        forbiddenStrings: ba08Forbidden([
          "SECRET_MAP_VALUE",
          "SECRET_SET_VALUE",
          '"status":"one"',
          '"status":"ambiguous"',
        ]),
        forbiddenRefs: [
          callerMap,
          callerSet,
          callerHeaders,
          callerSourceContext,
        ].concat(inst.ephemeralHandles, inst.originalLookupResults, inst.realRegistryInstances),
      });
      const rec1 = findPrivateMediaRecord(
        inst,
        { mediaId: id1, hasFutureTransport: false },
        "ba08 media1"
      );
      assertPrivateMediaShape(
        rec1,
        {
          mediaId: id1,
          proposedFilename: "a1.mp4",
          mediaKind: "direct",
          providerKey: BA08_PROVIDER_A,
          tabId: 801,
          detectionId: 1,
          mediaUrl: BA08_URL_1,
          hasFutureTransport: false,
        },
        inst,
        "ba08 media1"
      );
      const rec2 = findPrivateMediaRecord(
        inst,
        { mediaId: id2, hasFutureTransport: false },
        "ba08 media2"
      );
      assertPrivateMediaShape(
        rec2,
        {
          mediaId: id2,
          proposedFilename: "b.mp4",
          mediaKind: "direct",
          providerKey: BA08_PROVIDER_B,
          tabId: 802,
          detectionId: 2,
          mediaUrl: BA08_URL_2,
          hasFutureTransport: false,
        },
        inst,
        "ba08 media2"
      );
      const rec3 = findPrivateMediaRecord(
        inst,
        { mediaId: id3, hasFutureTransport: false },
        "ba08 media3"
      );
      assertPrivateMediaShape(
        rec3,
        {
          mediaId: id3,
          proposedFilename: "a2.mp4",
          mediaKind: "direct",
          providerKey: BA08_PROVIDER_A,
          tabId: 803,
          detectionId: 3,
          mediaUrl: BA08_URL_3,
          hasFutureTransport: false,
        },
        inst,
        "ba08 media3"
      );
      const surfaces = [
        pop1,
        pop2,
        pop3,
        pop1After,
        fx.publishDetections,
        fx.diagnostics,
        rec.bound,
        rec.replay,
        replayAgain,
        ctrl.popupJobs(),
        stubRejections,
        inst.consoleCaptures,
      ];
      assertPublicSurfacePrivacy(surfaces, ctx.forbiddenStrings, "ba08 public");
      for (let i = 0; i < surfaces.length; i++) {
        scanPublicGraph(surfaces[i], ctx, "ba08 surface " + i);
      }
      scanAllEffectArgs(fx, ctx, "ba08 effects");
      assertRootGlobalsStable(
        inst,
        snapshotRootOwnGlobals(inst.root),
        ctx,
        "ba08 globals"
      );
      const ba08Roles = auditPrivateHolders(
        inst,
        {
          captureCount: 3,
          nestedVariantMaps: 1,
          mediaIds: [id1, id2, id3],
          intendedProviderSets: [
            {
              origin: BA08_SHARED_NORM,
              members: [BA08_PROVIDER_A, BA08_PROVIDER_B],
              addHistory: [BA08_PROVIDER_A, BA08_PROVIDER_B, BA08_PROVIDER_A],
            },
          ],
        },
        ctx.forbiddenRefs,
        "ba08 holders"
      );
      assert.deepEqual(ba08Roles.missingIntendedRoles, [], "ba08 intended Sets");
      assert.equal(inst.registryHits.create, 1, "create remains one");
      assertRegistryClearSnapshotZero(inst.registryHits, "ba08");
      assertMaterialEffectsZero(fx, "ba08");

      assert.equal(inst.registryHits.observe, 3);
      assert.equal(inst.registryHits.lookup, 3);
      assertAttemptsPaired(inst.registryAttempts, 3, "ba08 attempts");
      assert.deepEqual(
        inst.registryEvents.map((e) => e.method),
        ["observe", "lookup", "observe", "lookup", "observe", "lookup"]
      );
      assert.deepEqual(inst.registryEvents[0], {
        method: "observe",
        mediaOrigin: BA08_SHARED_NORM,
        providerKey: BA08_PROVIDER_A,
      });
      assert.deepEqual(inst.registryEvents[1].result, {
        status: "one",
        providerKey: BA08_PROVIDER_A,
      });
      assert.deepEqual(inst.registryEvents[2], {
        method: "observe",
        mediaOrigin: BA08_SHARED_NORM,
        providerKey: BA08_PROVIDER_B,
      });
      assert.deepEqual(inst.registryEvents[3].result, {
        status: "ambiguous",
        providerKey: null,
      });
      assert.deepEqual(inst.registryEvents[4], {
        method: "observe",
        mediaOrigin: BA08_SHARED_NORM,
        providerKey: BA08_PROVIDER_A,
      });
      assert.deepEqual(inst.registryEvents[5].result, {
        status: "ambiguous",
        providerKey: null,
      });
      assert.notEqual(
        inst.registryEvents[5].result.status,
        "one",
        "third lookup not stale one"
      );
      const live1 = inst.originalLookupResults[0];
      const live2 = inst.originalLookupResults[1];
      const live3 = inst.originalLookupResults[2];
      assert.notEqual(live3, live1, "third live lookup object distinct");
      assertObservationMapExact(
        inst.trackedMaps,
        [id1, id2, id3],
        { [id1]: live1, [id2]: live2, [id3]: live3 },
        {
          [id1]: { status: "one", providerKey: BA08_PROVIDER_A },
          [id2]: { status: "ambiguous", providerKey: null },
          [id3]: { status: "ambiguous", providerKey: null },
        },
        "ba08 map"
      );
    }
  );
});
