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

  // Probe ProviderRegistry observation methods. Transparent classic-script wrapper
  // delegates to the real registry and retains normalizeOrigin/normalizeProviderKey.
  const registryHits = {
    observe: 0,
    lookup: 0,
    clear: 0,
    snapshot: 0,
    create: 0,
  };
  const registryEvents = [];
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
          const result = reg.observe(mediaOrigin, providerKey);
          registryEvents.push({
            op: "observe",
            mediaOrigin:
              typeof mediaOrigin === "string" ? mediaOrigin : String(mediaOrigin),
            providerKey:
              typeof providerKey === "string" ? providerKey : String(providerKey),
          });
          return result;
        },
        lookup(mediaOrigin) {
          registryHits.lookup += 1;
          const result = reg.lookup(mediaOrigin);
          registryEvents.push({
            op: "lookup",
            mediaOrigin:
              typeof mediaOrigin === "string" ? mediaOrigin : String(mediaOrigin),
            result: {
              status: result && result.status,
              providerKey:
                result && Object.prototype.hasOwnProperty.call(result, "providerKey")
                  ? result.providerKey
                  : null,
            },
            resultIdentity: result,
          });
          return result;
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

  // Transparent Privacy wrapper — records createEphemeral URL bindings only.
  const privacyHits = {
    createEphemeral: 0,
    urls: [],
    headersArgs: [],
    handles: [],
  };
  const RealPrivacy = root.McPrivacy;
  const realCreateEphemeral = RealPrivacy.createEphemeral;
  const privacyApi = {};
  for (const k of Object.keys(RealPrivacy)) {
    privacyApi[k] = RealPrivacy[k];
  }
  privacyApi.createEphemeral = function createEphemeral(mediaUrl, requestHeaders) {
    privacyHits.createEphemeral += 1;
    privacyHits.urls.push(mediaUrl);
    privacyHits.headersArgs.push(requestHeaders);
    const handle = realCreateEphemeral.call(RealPrivacy, mediaUrl, requestHeaders);
    privacyHits.handles.push(handle);
    return handle;
  };
  root.McPrivacy = privacyApi;

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
    registryEvents,
    privacyHits,
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
  assert.throws(
    () => ctrl.registerVariants("media-x", []),
    (err) =>
      err instanceof TypeError &&
      err.message === "invalid media variant registration"
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
// BA05 — opaque variant IDs bind original private URLs; replay cannot replace
// ---------------------------------------------------------------------------

const VARIANT_REG_MSG = "invalid media variant registration";

function assertVariantRegError(err, opts) {
  assert.ok(err instanceof TypeError, "expected TypeError, got " + err);
  assert.equal(err.name, "TypeError");
  assert.equal(err.message, VARIANT_REG_MSG);
  assert.equal(
    Object.prototype.hasOwnProperty.call(err, "cause") ? err.cause : undefined,
    undefined,
    "variant registration TypeError must not retain a cause"
  );
  if (opts && opts.notSameAs != null) {
    assert.notEqual(err, opts.notSameAs);
  }
  const blob = String(err.message) + "\n" + String(err.stack || "");
  const leak =
    /Cannot perform|revoked proxy|Proxy\s*handler|getOwnPropertyDescriptor|hostilesecret|HOSTILE_SECRET|which is no longer usable|is not iterable|Illegal invocation/i.test(
      blob
    );
  assert.equal(leak, false, "variant error must not leak engine/trap text");
}

function assertSafeVariantRow(row, label) {
  assert.equal(typeof row, "object");
  assert.ok(row && !Array.isArray(row), label + " row object");
  assertDeepFrozen(row, label);
  const keys = Object.keys(row);
  assert.equal(keys[0], "id", label + " id first");
  assert.ok(isSafeOpaqueId(row.id), label + " opaque id");
  const allowed = new Set(["id", "label", "width", "height", "bandwidth", "mime"]);
  for (const k of keys) {
    assert.ok(allowed.has(k), label + " unexpected key " + k);
  }
  // Exact optional key order among present keys.
  const optionalOrder = ["label", "width", "height", "bandwidth", "mime"];
  const presentOptional = keys.slice(1);
  const expectedOptional = optionalOrder.filter((k) =>
    Object.prototype.hasOwnProperty.call(row, k)
  );
  assert.deepEqual(presentOptional, expectedOptional, label + " optional key order");
  for (const forbidden of [
    "url",
    "variantUrl",
    "mediaId",
    "providerKey",
    "sourceHandle",
    "headers",
    "Cookie",
    "Authorization",
    "pageUrl",
    "sourceContext",
    "variantId",
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(row, forbidden),
      false,
      label + " must not expose " + forbidden
    );
  }
}

test("BA05 — opaque variant IDs bind original private URLs and replay cannot replace the owned set", async (t) => {
  // Mutation caught: caller ID/URL authority, normalized instead of original URL,
  // partial registration, replay reads, same-media reentrant takeover, cross-media
  // ID collision, premature selection/enqueue behavior, or secret projection.

  const URL_A =
    "https://user:PASS_A@cdn-a.example/v1.mp4?sig=SIGNED_A&token=TA#fragA";
  const URL_B =
    "https://user:PASS_B@cdn-b.example/v2.mp4?sig=SIGNED_B&token=TB#fragB";
  const OVERRIDE_URL = "https://attacker.example/override.mp4?steal=1";

  await t.test(
    "registers ordered safe rows, binds original private URLs, ignores overrides",
    async () => {
      const inst = loadInstrumentedClassic();
      const fx = makeEffects();
      const ctrl = inst.api.createBackgroundAdapters(fx.options());

      // Pending media first — variants attach while invisible to popup.
      const mediaId = ctrl.captureNetwork(
        validNetworkCapture({
          details: Object.assign({}, florenNetworkInput().details, {
            url: "https://s40.example-cdn.invalid/base.mp4?token=BASE_SECRET_Q",
            documentId: "doc-ba05-1",
          }),
        })
      );
      assert.equal(ctrl.popupMedia(42).length, 0);

      const privacyBefore = inst.privacyHits.createEphemeral;
      const tokenBefore = fx.counts.randomToken;
      const publishBefore = fx.counts.publishDetection;
      const materialBaseline = snapshotEffectBaseline(fx);

      let unknownGetterHits = 0;
      const entry0 = {
        url: URL_A,
        label: "  1080p Clean  ",
        width: 1920,
        height: 1080,
        bandwidth: 5_000_000,
        mime: "video/mp4",
        id: "caller-id-0",
        variantId: "caller-variant-0",
        variantUrl: OVERRIDE_URL,
        mediaId: "caller-media",
        providerKey: "attacker.example",
      };
      Object.defineProperty(entry0, "hostileSecret", {
        enumerable: true,
        configurable: true,
        get() {
          unknownGetterHits += 1;
          throw new Error("HOSTILE_SECRET_unknown_field");
        },
      });
      // Non-string label coercion hook must not run (label is primitive string here).
      // Unsafe optional values omitted.
      const entry1 = {
        url: URL_B,
        label: 12, // non-string → omit
        width: 0, // not positive → omit
        height: 720.5, // fractional → omit
        bandwidth: -1, // negative → omit
        mime: "video/mp4; codecs=avc1", // parameters → omit
        id: "caller-id-1",
        variantUrl: OVERRIDE_URL,
      };
      Object.defineProperty(entry1, "toString", {
        enumerable: false,
        value() {
          unknownGetterHits += 1;
          return OVERRIDE_URL;
        },
      });

      const registered = ctrl.registerVariants(mediaId, [entry0, entry1]);
      assert.equal(registered.length, 2);
      assertDeepFrozen(registered, "registerVariants result");
      assertSafeVariantRow(registered[0], "reg[0]");
      assertSafeVariantRow(registered[1], "reg[1]");
      // Key order / metadata for first (safe optional present).
      assert.deepEqual(Object.keys(registered[0]), [
        "id",
        "label",
        "width",
        "height",
        "bandwidth",
        "mime",
      ]);
      assert.equal(registered[0].label, "1080p Clean");
      assert.equal(registered[0].width, 1920);
      assert.equal(registered[0].height, 1080);
      assert.equal(registered[0].bandwidth, 5_000_000);
      assert.equal(registered[0].mime, "video/mp4");
      // Second omits unsafe optionals.
      assert.deepEqual(Object.keys(registered[1]), ["id"]);
      assert.notEqual(registered[0].id, registered[1].id);
      assert.notEqual(registered[0].id, mediaId);
      assert.notEqual(registered[0].id, "caller-id-0");
      assert.notEqual(registered[0].id, "caller-variant-0");
      assert.equal(unknownGetterHits, 0, "unknown getters must not run");

      // Exactly 2 variant tokens + 2 Privacy ephemeral URL bindings (base already created).
      assert.equal(fx.counts.randomToken, tokenBefore + 2);
      assert.equal(
        inst.privacyHits.createEphemeral,
        privacyBefore + 2,
        "exactly N variant ephemerals"
      );
      // Last two privacy URLs are exact original spellings.
      const urls = inst.privacyHits.urls.slice(-2);
      assert.equal(urls[0], URL_A);
      assert.equal(urls[1], URL_B);
      assert.equal(urls.includes(OVERRIDE_URL), false);
      // Variant registration never carries headers.
      assert.equal(inst.privacyHits.headersArgs.slice(-2)[0], null);
      assert.equal(inst.privacyHits.headersArgs.slice(-2)[1], null);
      const handles = inst.privacyHits.handles.slice(-2);
      for (const h of handles) {
        assert.ok(Object.isFrozen(h));
        assert.deepEqual(Object.keys(h), []);
        assert.equal(
          Object.getOwnPropertyDescriptor(h, "mediaUrl").enumerable,
          false
        );
      }
      assert.equal(handles[0].mediaUrl, URL_A);
      assert.equal(handles[1].mediaUrl, URL_B);
      assert.notEqual(handles[0], handles[1]);

      // No publication / material effects from registration alone.
      assert.equal(fx.counts.publishDetection, publishBefore);
      assert.equal(fx.counts.publishJobs, materialBaseline.publishJobs);
      assert.equal(fx.counts.persistHistory, materialBaseline.persistHistory);
      assert.equal(fx.counts.postNative, materialBaseline.postNative);
      assert.equal(fx.counts.downloadsDownload, materialBaseline.downloadsDownload);
      assert.equal(fx.counts.fetchArrayBuffer, materialBaseline.fetchArrayBuffer);
      assert.equal(fx.counts.assembleMedia, materialBaseline.assembleMedia);
      assert.equal(fx.counts.createObjectURL, materialBaseline.createObjectURL);

      // Pending still invisible.
      assert.equal(ctrl.popupMedia(42).length, 0);

      // Finalize — registered set appears on popup in order.
      ctrl.acceptPageSnapshot(
        florenSnapshot({ documentId: "doc-ba05-1" })
      );
      assert.equal(fx.counts.publishDetection, publishBefore + 1);
      const pop = ctrl.popupMedia(42);
      assert.equal(pop.length, 1);
      assert.equal(pop[0].id, mediaId);
      assert.equal(pop[0].variants.length, 2);
      assert.deepEqual(
        pop[0].variants.map((v) => v.id),
        registered.map((v) => v.id)
      );
      assert.equal(pop[0].variants[0].label, "1080p Clean");
      assertDeepFrozen(pop, "popup after variants");
      // Fresh copies.
      const pop2 = ctrl.popupMedia(42);
      assert.notEqual(pop, pop2);
      assert.notEqual(pop[0], pop2[0]);
      assert.notEqual(pop[0].variants, pop2[0].variants);
      assert.notEqual(pop[0].variants[0], pop2[0].variants[0]);
      assert.deepEqual(pop[0].variants[0], pop2[0].variants[0]);
    }
  );

  await t.test(
    "replay after bind ignores revoked proxy traps and returns original set",
    async () => {
      const inst = loadInstrumentedClassic();
      const fx = makeEffects();
      const ctrl = inst.api.createBackgroundAdapters(fx.options());
      const mediaId = ctrl.captureDomMedia(
        validDomCapture({
          mediaUrl: "https://cdn.example/dom-ba05.mp4",
          snapshot: Object.assign({}, validDomCapture().snapshot, {
            documentId: "doc-ba05-replay",
            tabId: 71,
          }),
        })
      );
      const first = ctrl.registerVariants(mediaId, [
        { url: URL_A, label: "A" },
        { url: URL_B, label: "B" },
      ]);
      const tokenAtBind = fx.counts.randomToken;
      const privacyAtBind = inst.privacyHits.createEphemeral;

      let trapHits = 0;
      const target = [{ url: OVERRIDE_URL }];
      const { proxy, revoke } = Proxy.revocable(target, {
        get(t, p, r) {
          trapHits += 1;
          return Reflect.get(t, p, r);
        },
        getOwnPropertyDescriptor(t, p) {
          trapHits += 1;
          return Reflect.getOwnPropertyDescriptor(t, p);
        },
        ownKeys(t) {
          trapHits += 1;
          return Reflect.ownKeys(t);
        },
      });
      revoke();
      let replay;
      assert.doesNotThrow(() => {
        replay = ctrl.registerVariants(mediaId, proxy);
      });
      assert.equal(trapHits, 0, "replay must not read variants argument");
      assert.deepEqual(
        replay.map((v) => v.id),
        first.map((v) => v.id)
      );
      assert.equal(fx.counts.randomToken, tokenAtBind);
      assert.equal(inst.privacyHits.createEphemeral, privacyAtBind);
      assert.notEqual(replay, first, "fresh copy on replay");
    }
  );

  await t.test(
    "same-media reentrancy fails generically; cross-media reentrancy owns disjoint IDs",
    async () => {
      const inst = loadInstrumentedClassic();
      const fx = makeEffects();
      let outerTokenPhase = 0;
      let nestedSameErr = null;
      let nestedOther = null;
      let mediaA = null;
      let mediaB = null;
      let ctrl;

      ctrl = inst.api.createBackgroundAdapters(
        fx.options({
          randomToken(ns) {
            fx.counts.randomToken += 1;
            if (ns === "variant" && outerTokenPhase === 1) {
              // Clear reentry gate before nested calls so nested token hooks
              // do not recurse into this same reentry block.
              outerTokenPhase = 2;
              // Reenter same media mid-token.
              try {
                ctrl.registerVariants(mediaA, [{ url: OVERRIDE_URL, label: "steal" }]);
              } catch (e) {
                nestedSameErr = e;
              }
              // Reenter different owned media.
              nestedOther = ctrl.registerVariants(mediaB, [
                {
                  url: "https://other.example/x.mp4?sig=OTHER1",
                  label: "other",
                },
              ]);
            }
            return "tok-repeat";
          },
        })
      );

      mediaA = ctrl.captureDomMedia(
        validDomCapture({
          mediaUrl: "https://cdn.example/a.mp4",
          snapshot: Object.assign({}, validDomCapture().snapshot, {
            documentId: "doc-ba05-re-a",
            tabId: 80,
            candidates: [{ kind: "visible-filename", value: "a.mp4" }],
          }),
        })
      );
      mediaB = ctrl.captureDomMedia(
        validDomCapture({
          mediaUrl: "https://cdn.example/b.mp4",
          snapshot: Object.assign({}, validDomCapture().snapshot, {
            documentId: "doc-ba05-re-b",
            tabId: 81,
            candidates: [{ kind: "visible-filename", value: "b.mp4" }],
          }),
        })
      );

      outerTokenPhase = 1;
      const outer = ctrl.registerVariants(mediaA, [
        { url: URL_A, label: "outer0" },
        { url: URL_B, label: "outer1" },
      ]);
      assertVariantRegError(nestedSameErr);
      assert.equal(outer.length, 2);
      assert.ok(nestedOther && nestedOther.length === 1);
      const ids = new Set([
        outer[0].id,
        outer[1].id,
        nestedOther[0].id,
        mediaA,
        mediaB,
      ]);
      assert.equal(ids.size, 5, "all media/variant IDs globally unique");
      // Outer set stuck; nested same-media failed.
      const replayA = ctrl.registerVariants(mediaA, [{ url: OVERRIDE_URL }]);
      assert.deepEqual(
        replayA.map((v) => v.id),
        outer.map((v) => v.id)
      );
    }
  );

  await t.test(
    "invalid structures and one-shot token failure leave set open for retry",
    async () => {
      const inst = loadInstrumentedClassic();
      const fx = makeEffects();
      let tokenFailOnce = false;
      const ctrl = inst.api.createBackgroundAdapters(
        fx.options({
          randomToken(ns) {
            fx.counts.randomToken += 1;
            if (tokenFailOnce && ns === "variant") {
              tokenFailOnce = false;
              throw new Error("TOKEN_VARIANT_FAIL_ONCE");
            }
            return "tok-repeat";
          },
        })
      );
      const mediaId = ctrl.captureDomMedia(
        validDomCapture({
          mediaUrl: "https://cdn.example/retry.mp4",
          snapshot: Object.assign({}, validDomCapture().snapshot, {
            documentId: "doc-ba05-retry",
            tabId: 82,
          }),
        })
      );

      const badCases = [
        null,
        undefined,
        "not-array",
        { 0: { url: URL_A }, length: 1 },
        [{ url: "ftp://bad.example/x" }],
        [{ url: "not a url" }],
        [{ label: "no-url" }],
        [null],
        [[URL_A]],
        [Object.create({ url: URL_A })], // inherited url only
      ];
      // Sparse array
      const sparse = [];
      sparse.length = 1;
      sparse[0] = undefined;
      // Actually sparse without index 0:
      const sparse2 = [];
      sparse2.length = 1;
      badCases.push(sparse2);

      for (const bad of badCases) {
        const tokenBefore = fx.counts.randomToken;
        const privacyBefore = inst.privacyHits.createEphemeral;
        let err = null;
        try {
          ctrl.registerVariants(mediaId, bad);
        } catch (e) {
          err = e;
        }
        assertVariantRegError(err);
        assert.equal(fx.counts.randomToken, tokenBefore, "no token on invalid");
        assert.equal(
          inst.privacyHits.createEphemeral,
          privacyBefore,
          "no privacy on invalid"
        );
      }

      // Accessor on known field rejects.
      const accessorEntry = {};
      Object.defineProperty(accessorEntry, "url", {
        enumerable: true,
        get() {
          throw new Error("HOSTILE_SECRET_url_accessor");
        },
      });
      let accErr = null;
      try {
        ctrl.registerVariants(mediaId, [accessorEntry]);
      } catch (e) {
        accErr = e;
      }
      assertVariantRegError(accErr);

      // One-shot token failure: no partial set; retry succeeds once.
      tokenFailOnce = true;
      const tokenBeforeFail = fx.counts.randomToken;
      const privacyBeforeFail = inst.privacyHits.createEphemeral;
      let tokenErr = null;
      try {
        ctrl.registerVariants(mediaId, [{ url: URL_A, label: "retry-me" }]);
      } catch (e) {
        tokenErr = e;
      }
      assert.equal(tokenErr && tokenErr.message, "TOKEN_VARIANT_FAIL_ONCE");
      assert.equal(inst.privacyHits.createEphemeral, privacyBeforeFail);
      // Popup still empty variants (length only — classic-VM arrays are cross-realm).
      const popAfterFail = ctrl.popupMedia(82);
      assert.equal(popAfterFail.length, 1);
      assert.equal(popAfterFail[0].variants.length, 0);

      const ok = ctrl.registerVariants(mediaId, [
        { url: URL_A, label: "retry-me" },
        { url: URL_B, label: "second" },
      ]);
      assert.equal(ok.length, 2);
      assert.equal(ok[0].label, "retry-me");
      assert.ok(fx.counts.randomToken > tokenBeforeFail);
    }
  );

  await t.test(
    "futureTransport.variants snapshot is not auto-registered; explicit set wins",
    async () => {
      const inst = loadInstrumentedClassic();
      const fx = makeEffects();
      const ctrl = inst.api.createBackgroundAdapters(fx.options());
      const privacyAtStart = inst.privacyHits.createEphemeral;
      const tokenAtStart = fx.counts.randomToken;

      const mediaId = ctrl.captureNetwork(
        validNetworkCapture({
          details: Object.assign({}, florenNetworkInput().details, {
            documentId: "doc-ba05-ft",
            url: "https://s40.example-cdn.invalid/ft-base.mp4",
          }),
          transport: {
            mediaKind: "direct",
            requestHeaders: null,
            variants: [
              {
                url: "https://retained.example/candidate.mp4?sig=RETAINED_CANDIDATE",
                label: "from-transport",
              },
            ],
          },
        })
      );
      // Capture minted media token + base privacy only — not variant IDs/ephemerals.
      assert.equal(fx.counts.randomToken, tokenAtStart + 1);
      assert.equal(inst.privacyHits.createEphemeral, privacyAtStart + 1);
      ctrl.acceptPageSnapshot(florenSnapshot({ documentId: "doc-ba05-ft" }));
      const popBefore = ctrl.popupMedia(42);
      assert.equal(popBefore.length, 1);
      assert.equal(popBefore[0].variants.length, 0);
      // Pending retained futureTransport.variants privately.
      const sources = inst.sourceRecords();
      const src = sources.find((s) => s.mediaId === mediaId) || sources[sources.length - 1];
      const ft = Object.getOwnPropertyDescriptor(src, "futureTransport");
      assert.ok(ft && ft.value && ft.value.variants);
      assert.equal(ft.value.variants.length, 1);
      assert.equal(
        ft.value.variants[0].url,
        "https://retained.example/candidate.mp4?sig=RETAINED_CANDIDATE"
      );

      const explicit = ctrl.registerVariants(mediaId, [
        { url: URL_A, label: "explicit" },
      ]);
      assert.equal(explicit.length, 1);
      assert.equal(explicit[0].label, "explicit");
      assert.notEqual(explicit[0].id, "from-transport");
      const popAfter = ctrl.popupMedia(42);
      assert.equal(popAfter[0].variants[0].label, "explicit");
      // Retained snapshot still present and unread as registration input.
      assert.equal(
        Object.getOwnPropertyDescriptor(src, "futureTransport").value.variants[0]
          .url,
        "https://retained.example/candidate.mp4?sig=RETAINED_CANDIDATE"
      );
    }
  );

  await t.test(
    "enqueueDownload remains Lease-1 stub without reading hostile arguments",
    async () => {
      const inst = loadInstrumentedClassic();
      const fx = makeEffects();
      const ctrl = inst.api.createBackgroundAdapters(fx.options());
      const mediaId = ctrl.captureDomMedia(
        validDomCapture({
          snapshot: Object.assign({}, validDomCapture().snapshot, {
            documentId: "doc-ba05-enq",
            tabId: 83,
          }),
        })
      );
      const variants = ctrl.registerVariants(mediaId, [
        { url: URL_A, label: "keep" },
      ]);
      const popBefore = ctrl.popupMedia(83);
      const baseline = snapshotEffectBaseline(fx);

      let hits = 0;
      const message = {};
      Object.defineProperty(message, "item", {
        enumerable: true,
        get() {
          hits += 1;
          return {
            url: OVERRIDE_URL,
            providerKey: "attacker.example",
            variantUrl: OVERRIDE_URL,
            variantId: variants[0].id,
          };
        },
      });
      Object.defineProperty(message, "url", {
        enumerable: true,
        get() {
          hits += 1;
          return OVERRIDE_URL;
        },
      });
      const sender = {};
      Object.defineProperty(sender, "tab", {
        enumerable: true,
        get() {
          hits += 1;
          return { id: 83 };
        },
      });

      let p;
      assert.doesNotThrow(() => {
        p = ctrl.enqueueDownload(message, sender);
      });
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
      assert.equal(hits, 0, "enqueueDownload must not read arguments");
      assertEffectBaseline(fx, baseline, "enqueueDownload stub");
      const popAfter = ctrl.popupMedia(83);
      assert.deepEqual(
        popAfter[0].variants.map((v) => v.id),
        popBefore[0].variants.map((v) => v.id)
      );
    }
  );

  await t.test(
    "unknown media fails before reading variants; empty keeps set open",
    async () => {
      const api = loadAdapters();
      const fx = makeEffects();
      const ctrl = api.createBackgroundAdapters(fx.options());
      let trapHits = 0;
      const { proxy, revoke } = Proxy.revocable(
        [{ url: URL_A }],
        {
          get(t, p, r) {
            trapHits += 1;
            return Reflect.get(t, p, r);
          },
          ownKeys(t) {
            trapHits += 1;
            return Reflect.ownKeys(t);
          },
          getOwnPropertyDescriptor(t, p) {
            trapHits += 1;
            return Reflect.getOwnPropertyDescriptor(t, p);
          },
        }
      );
      let err = null;
      try {
        ctrl.registerVariants("media-not-owned", proxy);
      } catch (e) {
        err = e;
      }
      assertVariantRegError(err);
      assert.equal(trapHits, 0);
      revoke();

      // Empty registration on owned media returns [] and leaves open.
      const mediaId = ctrl.captureDomMedia(validDomCapture());
      const empty1 = ctrl.registerVariants(mediaId, []);
      assert.deepEqual(empty1, []);
      assertDeepFrozen(empty1, "empty1");
      const later = ctrl.registerVariants(mediaId, [{ url: URL_A, label: "late" }]);
      assert.equal(later.length, 1);
      assert.equal(later[0].label, "late");
    }
  );

  await t.test(
    "structural inspection: ownership maps only; no selection resolver",
    async () => {
      const src = productionSource();
      // Must implement registerVariants body (not Lease-1 throw-only stub).
      assert.match(src, /invalid media variant registration/);
      assert.match(
        src,
        /preparePublicId\s*\(\s*["']variant["']\s*\)/
      );
      // No selection resolver / enqueue routing / download intent.
      assert.equal(
        (src.match(
          /function\s+resolve(Variant|Selection|Download|Transport)\b/g
        ) || []).length,
        0
      );
      assert.equal(
        (src.match(/function\s+select(Source|Variant|Download|Transport)\b/g) ||
          []).length,
        0
      );
      assert.equal((src.match(/DownloadScheduler/g) || []).length, 0);
      assert.equal((src.match(/normalizeDownloadIntent/g) || []).length, 0);
      // No direct createObjectURL invocation (option capture / guard wiring only).
      assert.equal((src.match(/createObjectURL\s*\(/g) || []).length, 0);
      // enqueueDownload still lease-1 reject path.
      assert.match(src, /function enqueueDownload/);
      assert.match(src, /background adapter behavior not implemented in Lease 1/);
      // Exactly two capture-path Privacy.createEphemeral( sites remain.
      assert.equal(
        (src.match(/Privacy\.createEphemeral\s*\(/g) || []).length,
        2
      );
    }
  );
});

// ---------------------------------------------------------------------------
// BA06 — public outputs exclude private URL/header/override sentinels
// ---------------------------------------------------------------------------

test("BA06 — public outputs and callbacks exclude every private URL/header/override sentinel", async () => {
  // Mutation caught: spreading private records, serializing sourceContext or
  // ephemerals, copying cookies into metadata, echoing validation/trap errors,
  // or leaking ignored overrides.

  const SENTINELS = [
    "SECRET_SIGNED_QUERY_XYZ",
    "SECRET_COOKIE_ABC",
    "SECRET_AUTH_BEARER_TOKEN",
    "SECRET_REFERER_PATH",
    "SECRET_PAGE_PATH",
    "SECRET_MEDIA_ORIGIN_HOST",
    "SECRET_VARIANT_USERINFO",
    "SECRET_VARIANT_QUERY",
    "SECRET_VARIANT_FRAG",
    "SECRET_CALLER_VARIANT_ID",
    "SECRET_CALLER_PROVIDER",
    "SECRET_UNSAFE_LABEL_Cookie:",
    "HOSTILE_SECRET_VARIANT_GETTER",
    "Bearer SECRET_VARIANT_AUTH",
  ];

  const inst = loadInstrumentedClassic();
  const fx = makeEffects();
  const ctrl = inst.api.createBackgroundAdapters(fx.options());

  const variantUrl =
    "https://user:SECRET_VARIANT_USERINFO@cdn-v.example/v.mp4?sig=SECRET_VARIANT_QUERY#SECRET_VARIANT_FRAG";

  // Network detection with base secrets.
  const netId = ctrl.captureNetwork(
    validNetworkCapture({
      details: Object.assign({}, florenNetworkInput().details, {
        url:
          "https://s40.example-cdn.invalid/file.mp4?token=SECRET_SIGNED_QUERY_XYZ&exp=99",
        documentId: "doc-ba06-net",
        originUrl: florenPageUrl() + "?ref=SECRET_REFERER_PATH",
      }),
      transport: {
        mediaKind: "direct",
        requestHeaders: {
          Cookie: "session=SECRET_COOKIE_ABC",
          Authorization: "Bearer SECRET_AUTH_BEARER_TOKEN",
          Referer: florenPageUrl() + "?ref=SECRET_REFERER_PATH",
        },
      },
    })
  );

  // Pending variant registration with secrets in private URL + unsafe optionals.
  let getterHits = 0;
  const vEntry = {
    url: variantUrl,
    label: "  SECRET_UNSAFE_LABEL_Cookie: session=x  ",
    mime: "video/mp4; SECRET=1",
    width: "1920",
    id: "SECRET_CALLER_VARIANT_ID",
    variantId: "SECRET_CALLER_VARIANT_ID",
    variantUrl: "https://evil.example/?steal=SECRET_VARIANT_QUERY",
    providerKey: "SECRET_CALLER_PROVIDER",
  };
  Object.defineProperty(vEntry, "ignoredSecret", {
    enumerable: true,
    get() {
      getterHits += 1;
      throw new Error("HOSTILE_SECRET_VARIANT_GETTER");
    },
  });

  const pendingVariants = ctrl.registerVariants(netId, [vEntry]);
  assert.equal(getterHits, 0);
  assert.equal(pendingVariants.length, 1);
  assert.deepEqual(Object.keys(pendingVariants[0]), ["id"]); // unsafe optionals omitted

  // Invalid registration — must not echo hostile text.
  const badEntry = {};
  Object.defineProperty(badEntry, "url", {
    enumerable: true,
    get() {
      getterHits += 1;
      throw new Error("HOSTILE_SECRET_VARIANT_GETTER");
    },
  });
  // Already bound after nonempty set — replay with bad entry must not read it.
  const replay = ctrl.registerVariants(netId, [badEntry]);
  assert.equal(getterHits, 0);
  assert.equal(replay[0].id, pendingVariants[0].id);

  // Fresh media for invalid path error text check.
  const netId2 = ctrl.captureNetwork(
    validNetworkCapture({
      details: Object.assign({}, florenNetworkInput().details, {
        documentId: "doc-ba06-net2",
        url: "https://s40.example-cdn.invalid/other.mp4",
      }),
    })
  );
  let invalidErr = null;
  try {
    ctrl.registerVariants(netId2, [badEntry]);
  } catch (e) {
    invalidErr = e;
  }
  assertVariantRegError(invalidErr);
  // Descriptor inspection rejects known-field accessors without invoking getters.
  assert.equal(getterHits, 0, "known-field accessor must not run");

  ctrl.acceptPageSnapshot(florenSnapshot({ documentId: "doc-ba06-net" }));
  ctrl.acceptPageSnapshot(
    florenSnapshot({ documentId: "doc-ba06-net2", documentNonce: "n2" })
  );

  // DOM path with secrets.
  const domId = ctrl.captureDomMedia(
    validDomCapture({
      mediaUrl: "https://cdn.example/dom.mp4?token=SECRET_SIGNED_QUERY_XYZ",
      mediaOrigin: "https://SECRET_MEDIA_ORIGIN_HOST.example",
      referrerUrl: "https://site.example/watch?ref=SECRET_REFERER_PATH",
      snapshot: Object.assign({}, validDomCapture().snapshot, {
        documentId: "doc-ba06-dom",
        tabId: 90,
        pageUrl: "https://site.example/SECRET_PAGE_PATH",
        topLevelPageUrl: "https://site.example/SECRET_PAGE_PATH",
        candidates: [
          { kind: "visible-filename", value: "dom-safe.mp4" },
        ],
      }),
      transport: {
        mediaKind: "direct",
        requestHeaders: {
          Cookie: "session=SECRET_COOKIE_ABC",
          Authorization: "Bearer SECRET_AUTH_BEARER_TOKEN",
        },
      },
    })
  );
  ctrl.registerVariants(domId, [
    {
      url: variantUrl,
      label: "ok-label",
      id: "SECRET_CALLER_VARIANT_ID",
      providerKey: "SECRET_CALLER_PROVIDER",
    },
  ]);

  const popNet = ctrl.popupMedia(42);
  const popDom = ctrl.popupMedia(90);
  const jobs = ctrl.popupJobs();

  // Future stubs rejections.
  const stubErrors = [];
  for (const call of [
    () => ctrl.enqueueDownload(
      {
        item: {
          url: variantUrl,
          providerKey: "SECRET_CALLER_PROVIDER",
          variantUrl: variantUrl,
        },
      },
      { tab: { id: 42 } }
    ),
    () => ctrl.handleNativeMessage({ url: variantUrl }),
    () => ctrl.pump(),
  ]) {
    try {
      await call();
    } catch (e) {
      stubErrors.push(e);
    }
  }

  function scan(value, label) {
    const raw =
      typeof value === "string"
        ? value
        : value instanceof Error
          ? String(value.message) + "\n" + String(value.stack || "")
          : JSON.stringify(value);
    for (const s of SENTINELS) {
      assert.equal(raw.includes(s), false, label + " must not contain " + s);
    }
  }

  scan(popNet, "popup net");
  scan(popDom, "popup dom");
  scan(jobs, "popupJobs");
  scan(fx.publishDetections, "publishDetections");
  scan(fx.diagnostics, "diagnostics");
  scan(pendingVariants, "pendingVariants");
  scan(invalidErr, "invalidErr");
  for (let i = 0; i < stubErrors.length; i++) {
    scan(stubErrors[i], "stubErr" + i);
    assert.equal(stubErrors[i].message, LEASE1_MSG);
  }

  // Safe detection projection shape.
  for (const d of fx.publishDetections) {
    assert.deepEqual(Object.keys(d), [
      "id",
      "proposedFilename",
      "kind",
      "providerKey",
    ]);
    assertDeepFrozen(d, "detection");
  }

  // Popup allowlists.
  for (const row of [...popNet, ...popDom]) {
    assert.deepEqual(Object.keys(row), [
      "id",
      "proposedFilename",
      "kind",
      "variants",
    ]);
    for (const v of row.variants) {
      assertSafeVariantRow(v, "popup variant");
    }
  }

  assert.equal(fx.counts.publishJobs, 0);
  assert.equal(fx.counts.persistHistory, 0);
  assert.equal(fx.counts.postNative, 0);
  assert.equal(fx.counts.downloadsDownload, 0);
  assert.equal(fx.counts.fetchArrayBuffer, 0);
  assert.equal(fx.counts.assembleMedia, 0);
  assert.equal(fx.counts.createObjectURL, 0);
  assert.equal(fx.counts.revokeObjectURL, 0);

  // Private instrumentation saw ephemerals, but that is not a production exposure.
  assert.ok(inst.privacyHits.createEphemeral >= 3);
  assert.ok(
    inst.privacyHits.urls.some((u) => u.includes("SECRET_VARIANT_QUERY"))
  );
});

// ---------------------------------------------------------------------------
// BA07 / BA08 helpers — provider observation evidence via TrackingMap shape
// ---------------------------------------------------------------------------

/**
 * Locate private media-observation evidence records retained by production.
 * Shape: own-data frozen {status, providerKey} only. Not registry-owned objects.
 */
function findProviderObservationRecords(inst) {
  const out = [];
  for (const m of inst.trackedMaps) {
    for (const entry of m._sets) {
      const v = entry.value;
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      const keys = Object.keys(v).slice().sort();
      if (
        keys.length === 2 &&
        keys[0] === "providerKey" &&
        keys[1] === "status" &&
        (v.status === "none" ||
          v.status === "one" ||
          v.status === "ambiguous")
      ) {
        out.push({ key: entry.key, value: v, map: m });
      }
    }
  }
  return out;
}

function captureNetworkOnCdn(ctrl, opts) {
  const tabId = opts.tabId != null ? opts.tabId : 42;
  const mediaUrl =
    opts.mediaUrl ||
    "https://" + opts.cdnHost + "/file.mp4?token=cdn-sig-" + opts.docId;
  const pageUrl = opts.pageUrl || "https://" + opts.provider + "/watch";
  const mediaId = ctrl.captureNetwork({
    details: {
      url: mediaUrl,
      documentUrl: pageUrl,
      originUrl: pageUrl,
      tabId: tabId,
      frameId: 0,
      documentId: opts.docId,
      timeStamp: 1_000_000,
      responseHeaders: [{ name: "Content-Type", value: "video/mp4" }],
    },
    hints: {
      topLevelUrlHint: pageUrl,
      frameOrigin: "https://" + opts.provider,
    },
    transport: {
      mediaKind: "direct",
      requestHeaders: null,
    },
  });
  ctrl.acceptPageSnapshot({
    documentId: opts.docId,
    tabId: tabId,
    frameId: 0,
    pageUrl: pageUrl,
    topLevelPageUrl: pageUrl,
    documentNonce: "n-" + opts.docId,
    candidates: [
      { kind: "visible-filename", value: opts.filename || "file.mp4" },
    ],
    capturedAt: "2026-08-12T12:00:00.000Z",
  });
  return mediaId;
}

// ---------------------------------------------------------------------------
// BA07 — one referring provider through different CDN origins
// ---------------------------------------------------------------------------

test("BA07 — one referring provider through different CDN origins stays one provider group", async () => {
  // Mutation caught: grouping by CDN hostname, skipping a CDN association,
  // double-observing one media, accepting unusable origins, retaining live
  // lookup objects, or allowing later navigation/variants to rewrite provider.

  const inst = loadInstrumentedClassic();
  const fx = makeEffects();
  const ctrl = inst.api.createBackgroundAdapters(fx.options());

  assert.equal(inst.registryHits.create, 1);
  assert.equal(inst.registryHits.observe, 0);
  assert.equal(inst.registryHits.lookup, 0);

  const idA = captureNetworkOnCdn(ctrl, {
    provider: "florenfile.com",
    cdnHost: "cdn-a.example-cdn.invalid",
    docId: "doc-ba07-a",
    tabId: 42,
    filename: "a.mp4",
  });
  const idB = captureNetworkOnCdn(ctrl, {
    provider: "florenfile.com",
    cdnHost: "cdn-b.other-cdn.invalid",
    docId: "doc-ba07-b",
    tabId: 42,
    filename: "b.mp4",
  });

  assert.notEqual(idA, idB);
  assert.equal(inst.registryHits.observe, 2);
  assert.equal(inst.registryHits.lookup, 2);
  assert.equal(inst.registryHits.clear, 0);
  assert.equal(inst.registryHits.snapshot, 0);

  // Ordered observe-then-lookup pairs with distinct origins, same provider.
  const events = inst.registryEvents.slice();
  assert.equal(events.length, 4);
  assert.equal(events[0].op, "observe");
  assert.equal(events[1].op, "lookup");
  assert.equal(events[2].op, "observe");
  assert.equal(events[3].op, "lookup");
  assert.equal(events[0].providerKey, "florenfile.com");
  assert.equal(events[2].providerKey, "florenfile.com");
  assert.equal(events[0].mediaOrigin, "https://cdn-a.example-cdn.invalid");
  assert.equal(events[2].mediaOrigin, "https://cdn-b.other-cdn.invalid");
  assert.notEqual(events[0].mediaOrigin, events[2].mediaOrigin);
  assert.equal(events[1].mediaOrigin, events[0].mediaOrigin);
  assert.equal(events[3].mediaOrigin, events[2].mediaOrigin);

  // Immediate copied lookup results are one/florenfile.com — and deeply frozen.
  for (const idx of [1, 3]) {
    assert.equal(events[idx].result.status, "one");
    assert.equal(events[idx].result.providerKey, "florenfile.com");
  }

  // Retained observation evidence: frozen own-data copies, not live registry results.
  const obs = findProviderObservationRecords(inst);
  assert.ok(obs.length >= 2, "observation evidence retained");
  const liveIdentities = new Set(
    events.filter((e) => e.op === "lookup").map((e) => e.resultIdentity)
  );
  for (const row of obs) {
    assert.ok(Object.isFrozen(row.value), "evidence frozen");
    assertDeepFrozen(row.value, "evidence");
    assert.equal(liveIdentities.has(row.value), false, "not live registry result");
    if (row.value.status === "one") {
      assert.equal(row.value.providerKey, "florenfile.com");
    }
  }

  // Detection projections use source-derived florenfile.com.
  assert.equal(fx.counts.publishDetection, 2);
  assert.equal(fx.publishDetections[0].providerKey, "florenfile.com");
  assert.equal(fx.publishDetections[1].providerKey, "florenfile.com");
  assert.deepEqual(Object.keys(fx.publishDetections[0]), [
    "id",
    "proposedFilename",
    "kind",
    "providerKey",
  ]);

  // CDN hostnames / registry evidence absent from public/callback output.
  const publicBlob = [
    JSON.stringify(fx.publishDetections),
    JSON.stringify(ctrl.popupMedia(42)),
    JSON.stringify(fx.diagnostics),
  ].join("\n");
  assert.equal(publicBlob.includes("cdn-a.example-cdn.invalid"), false);
  assert.equal(publicBlob.includes("cdn-b.other-cdn.invalid"), false);
  assert.equal(publicBlob.includes('"status"'), false);
  assert.equal(publicBlob.includes("ambiguous"), false);

  // Repeated snapshots/ticks/popup/variants/navigation: no extra registry calls.
  const hitsAfter = {
    observe: inst.registryHits.observe,
    lookup: inst.registryHits.lookup,
  };
  ctrl.acceptPageSnapshot(
    florenSnapshot({ documentId: "doc-ba07-a", tabId: 42 })
  );
  await ctrl.tick(1_001_000);
  ctrl.popupMedia(42);
  ctrl.registerVariants(idA, [
    { url: "https://cdn-a.example-cdn.invalid/v.mp4?sig=1", label: "v" },
  ]);
  // Replay variants
  ctrl.registerVariants(idA, [{ url: "https://evil.example/x" }]);
  // Invalid registration
  try {
    ctrl.registerVariants(idB, null);
  } catch (_) {
    /* expected */
  }
  // Later navigation snapshot
  ctrl.acceptPageSnapshot({
    documentId: "doc-other-nav",
    tabId: 42,
    frameId: 0,
    pageUrl: "https://other-site.example/page",
    topLevelPageUrl: "https://other-site.example/page",
    documentNonce: "n-nav",
    candidates: [{ kind: "visible-filename", value: "nav.mp4" }],
    capturedAt: "2026-08-12T12:05:00.000Z",
  });
  assert.equal(inst.registryHits.observe, hitsAfter.observe);
  assert.equal(inst.registryHits.lookup, hitsAfter.lookup);

  // Variant/provider/caller overrides cannot change association.
  assert.equal(fx.publishDetections[0].providerKey, "florenfile.com");
  assert.equal(ctrl.popupMedia(42)[0].id, idA);

  // Unusable origins make zero observe/lookup and never become provider keys.
  const unusableCases = [
    {
      label: "blob",
      mediaUrl: "https://cdn-blob.example/file.mp4",
      // Force mediaOrigin via DOM path with unusable origin strings.
      mode: "dom",
      mediaOrigin: "blob:https://cdn.example/uuid",
      provider: "blob-provider.example",
      tabId: 201,
      docId: "doc-ba07-blob",
    },
    {
      label: "ftp",
      mode: "dom",
      mediaUrl: "https://cdn-ftp.example/file.mp4",
      mediaOrigin: "ftp://files.example/path",
      provider: "ftp-provider.example",
      tabId: 202,
      docId: "doc-ba07-ftp",
    },
    {
      label: "file",
      mode: "dom",
      mediaUrl: "https://cdn-file.example/file.mp4",
      mediaOrigin: "file:///tmp/x",
      provider: "file-provider.example",
      tabId: 203,
      docId: "doc-ba07-file",
    },
    {
      label: "data",
      mode: "dom",
      mediaUrl: "https://cdn-data.example/file.mp4",
      mediaOrigin: "data:text/plain,hi",
      provider: "data-provider.example",
      tabId: 204,
      docId: "doc-ba07-data",
    },
    {
      label: "empty",
      mode: "dom",
      mediaUrl: "https://cdn-empty.example/file.mp4",
      mediaOrigin: "",
      provider: "empty-provider.example",
      tabId: 205,
      docId: "doc-ba07-empty",
    },
    {
      label: "invalid",
      mode: "dom",
      mediaUrl: "https://cdn-inv.example/file.mp4",
      mediaOrigin: "not a valid origin",
      provider: "invalid-provider.example",
      tabId: 206,
      docId: "doc-ba07-inv",
    },
  ];

  for (const u of unusableCases) {
    const beforeObs = inst.registryHits.observe;
    const beforeLook = inst.registryHits.lookup;
    const mid = ctrl.captureDomMedia({
      mediaUrl: u.mediaUrl,
      mediaOrigin: u.mediaOrigin,
      contentDisposition: null,
      referrerUrl: "https://" + u.provider + "/r",
      frameOrigin: "https://" + u.provider,
      ts: 1_000_000,
      snapshot: {
        documentId: u.docId,
        tabId: u.tabId,
        frameId: 0,
        pageUrl: "https://" + u.provider + "/page",
        topLevelPageUrl: "https://" + u.provider + "/page",
        documentNonce: "n-" + u.docId,
        candidates: [{ kind: "visible-filename", value: u.label + ".mp4" }],
        capturedAt: "2026-08-12T12:00:00.000Z",
      },
      transport: { mediaKind: "direct", requestHeaders: null },
    });
    assert.ok(isSafeOpaqueId(mid), u.label + " media id");
    assert.equal(
      inst.registryHits.observe,
      beforeObs,
      u.label + " zero observe"
    );
    assert.equal(
      inst.registryHits.lookup,
      beforeLook,
      u.label + " zero lookup"
    );
    const pub = fx.publishDetections[fx.publishDetections.length - 1];
    assert.equal(pub.id, mid);
    // Provider key is source-derived site, never the unusable origin string.
    assert.equal(typeof pub.providerKey, "string");
    assert.equal(pub.providerKey.includes("blob:"), false);
    assert.equal(pub.providerKey.includes("ftp:"), false);
    assert.equal(pub.providerKey.includes("file:"), false);
    assert.equal(pub.providerKey.includes("data:"), false);
    assert.notEqual(pub.providerKey, u.mediaOrigin);
  }

  // Reentrancy through observe/lookup wrappers cannot duplicate pairs/publication.
  const reInst = loadInstrumentedClassic();
  const reFx = makeEffects();
  let reenterCount = 0;
  const realCreate = reInst.api.createBackgroundAdapters;
  // Wrap after construction by monkey-patching registry via a custom load.
  // Use the instrumented registryEvents with reentry callbacks.
  const reRootHits = reInst.registryHits;
  const reEvents = reInst.registryEvents;
  // Rebuild with reentrant observe/lookup by wrapping the already-instrumented registry.
  // Instead: create controller, then hook registry methods on the live wrapper by
  // replacing McProviderRegistry before create — re-load:
  const abs = path.join(mediaCatcherRoot, "lib", "background-adapters.js");
  const code = fs.readFileSync(abs, "utf8");
  const root = Object.create(null);
  const sandbox = classicVmBuiltins(root);
  const trackedMaps = [];
  class TrackingMap2 extends Map {
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
  sandbox.Map = TrackingMap2;
  loadClassicDependencies(sandbox, root);
  const RealPR = root.McProviderRegistry;
  const realCreatePR = RealPR.createProviderRegistry;
  const reHits = { observe: 0, lookup: 0, create: 0, clear: 0, snapshot: 0 };
  const reEv = [];
  let reCtrl = null;
  let reentered = false;
  root.McProviderRegistry = {
    normalizeOrigin: RealPR.normalizeOrigin,
    normalizeProviderKey: RealPR.normalizeProviderKey,
    createProviderRegistry() {
      reHits.create += 1;
      const reg = realCreatePR.call(RealPR);
      return {
        observe(mediaOrigin, providerKey) {
          reHits.observe += 1;
          reEv.push({ op: "observe", mediaOrigin, providerKey });
          if (!reentered && reCtrl) {
            reentered = true;
            reenterCount += 1;
            // Reentrant popup/snapshot/tick must not double-observe.
            reCtrl.popupMedia(42);
            reCtrl.acceptPageSnapshot(
              florenSnapshot({ documentId: "doc-ba07-re", tabId: 42 })
            );
            // tick is async — fire-and-forget inside observe is ok for reentry probe
            reCtrl.tick(1_000_500);
          }
          return reg.observe(mediaOrigin, providerKey);
        },
        lookup(mediaOrigin) {
          reHits.lookup += 1;
          const result = reg.lookup(mediaOrigin);
          reEv.push({
            op: "lookup",
            mediaOrigin,
            result: { status: result.status, providerKey: result.providerKey },
            resultIdentity: result,
          });
          if (reCtrl) {
            reCtrl.popupMedia(42);
          }
          return result;
        },
        clear() {
          reHits.clear += 1;
          return reg.clear();
        },
        snapshot() {
          reHits.snapshot += 1;
          return reg.snapshot();
        },
      };
    },
  };
  vm.runInNewContext(code, sandbox, { filename: abs });
  reCtrl = root.McBackgroundAdapters.createBackgroundAdapters(reFx.options());
  const reId = captureNetworkOnCdn(reCtrl, {
    provider: "florenfile.com",
    cdnHost: "cdn-re.example-cdn.invalid",
    docId: "doc-ba07-re",
    tabId: 42,
    filename: "re.mp4",
  });
  assert.equal(reHits.observe, 1, "exactly one observe despite reentry");
  assert.equal(reHits.lookup, 1, "exactly one lookup despite reentry");
  assert.equal(reFx.counts.publishDetection, 1);
  assert.equal(reFx.publishDetections[0].id, reId);
  assert.equal(reFx.publishDetections[0].providerKey, "florenfile.com");
  assert.ok(reenterCount >= 1);

  // Unexpected registry exception cannot roll back publication, retry, or leak text.
  const exInst = loadInstrumentedClassic();
  const exFx = makeEffects();
  // Custom load with throwing lookup after observe.
  const root2 = Object.create(null);
  const sandbox2 = classicVmBuiltins(root2);
  sandbox2.Map = TrackingMap2;
  loadClassicDependencies(sandbox2, root2);
  const RealPR2 = root2.McProviderRegistry;
  const realCreatePR2 = RealPR2.createProviderRegistry;
  let throwOnce = true;
  const exHits = { observe: 0, lookup: 0 };
  root2.McProviderRegistry = {
    normalizeOrigin: RealPR2.normalizeOrigin,
    normalizeProviderKey: RealPR2.normalizeProviderKey,
    createProviderRegistry() {
      const reg = realCreatePR2.call(RealPR2);
      return {
        observe(o, k) {
          exHits.observe += 1;
          return reg.observe(o, k);
        },
        lookup(o) {
          exHits.lookup += 1;
          if (throwOnce) {
            throwOnce = false;
            throw new Error("HOSTILE_REGISTRY_LOOKUP_SECRET_XYZ");
          }
          return reg.lookup(o);
        },
        clear() {
          return reg.clear();
        },
        snapshot() {
          return reg.snapshot();
        },
      };
    },
  };
  vm.runInNewContext(
    fs.readFileSync(abs, "utf8"),
    sandbox2,
    { filename: abs }
  );
  const exCtrl = root2.McBackgroundAdapters.createBackgroundAdapters(
    exFx.options()
  );
  const exId = captureNetworkOnCdn(exCtrl, {
    provider: "florenfile.com",
    cdnHost: "cdn-ex.example-cdn.invalid",
    docId: "doc-ba07-ex",
    tabId: 42,
    filename: "ex.mp4",
  });
  assert.equal(exFx.counts.publishDetection, 1, "publication retained");
  assert.equal(exFx.publishDetections[0].id, exId);
  assert.equal(exFx.publishDetections[0].providerKey, "florenfile.com");
  assert.equal(exHits.observe, 1);
  assert.equal(exHits.lookup, 1);
  // No retry on later popup/tick.
  exCtrl.popupMedia(42);
  await exCtrl.tick(1_002_000);
  assert.equal(exHits.observe, 1);
  assert.equal(exHits.lookup, 1);
  // Exception text not leaked.
  const exBlob = [
    JSON.stringify(exFx.publishDetections),
    JSON.stringify(exFx.diagnostics),
    JSON.stringify(exCtrl.popupMedia(42)),
  ].join("\n");
  assert.equal(exBlob.includes("HOSTILE_REGISTRY_LOOKUP_SECRET_XYZ"), false);
  // silence unused
  void reRootHits;
  void reEvents;
  void realCreate;
  void exInst;
});

// ---------------------------------------------------------------------------
// BA08 — shared CDN ambiguity is live, stable, never merges source keys
// ---------------------------------------------------------------------------

test("BA08 — shared CDN ambiguity is live, stable, and never merges source provider keys", async () => {
  // Mutation caught: last-writer-wins ownership, CDN-host grouping, stale cached
  // lookup authority, ambiguous lookup inheritance, provider-group collapse, or
  // public registry leakage.

  const inst = loadInstrumentedClassic();
  const fx = makeEffects();
  const ctrl = inst.api.createBackgroundAdapters(fx.options());

  const SHARED_CDN = "shared-cdn.example-cdn.invalid";
  const ORIGIN = "https://" + SHARED_CDN;

  // 1) provider A
  const idA1 = captureNetworkOnCdn(ctrl, {
    provider: "provider-a.example",
    cdnHost: SHARED_CDN,
    docId: "doc-ba08-a1",
    tabId: 50,
    filename: "a1.mp4",
  });
  // 2) provider B on same CDN
  const idB = captureNetworkOnCdn(ctrl, {
    provider: "provider-b.example",
    cdnHost: SHARED_CDN,
    docId: "doc-ba08-b",
    tabId: 50,
    filename: "b.mp4",
  });
  // 3) provider A again
  const idA2 = captureNetworkOnCdn(ctrl, {
    provider: "provider-a.example",
    cdnHost: SHARED_CDN,
    docId: "doc-ba08-a2",
    tabId: 50,
    filename: "a2.mp4",
  });

  assert.equal(inst.registryHits.observe, 3);
  assert.equal(inst.registryHits.lookup, 3);
  assert.equal(inst.registryHits.clear, 0);
  assert.equal(inst.registryHits.snapshot, 0);

  const events = inst.registryEvents.slice();
  assert.equal(events.length, 6);
  // Paired observe+lookup ordered
  for (let i = 0; i < 3; i++) {
    assert.equal(events[i * 2].op, "observe");
    assert.equal(events[i * 2 + 1].op, "lookup");
    assert.equal(events[i * 2].mediaOrigin, ORIGIN);
    assert.equal(events[i * 2 + 1].mediaOrigin, ORIGIN);
  }
  assert.equal(events[0].providerKey, "provider-a.example");
  assert.equal(events[2].providerKey, "provider-b.example");
  assert.equal(events[4].providerKey, "provider-a.example");

  // Live lookup results sequence
  assert.deepEqual(events[1].result, {
    status: "one",
    providerKey: "provider-a.example",
  });
  assert.deepEqual(events[3].result, {
    status: "ambiguous",
    providerKey: null,
  });
  assert.deepEqual(events[5].result, {
    status: "ambiguous",
    providerKey: null,
  });

  // Retained capture evidence: fresh deeply frozen own-data copies, not live objects.
  const liveResults = events
    .filter((e) => e.op === "lookup")
    .map((e) => e.resultIdentity);
  const obs = findProviderObservationRecords(inst);
  assert.ok(obs.length >= 3, "three observation records");
  // Collect last evidence values set for our three media ids if keyed by media id.
  const byMedia = new Map();
  for (const row of obs) {
    if (typeof row.key === "string" && row.key.indexOf("media:") === 0) {
      byMedia.set(row.key, row.value);
    }
  }
  // Prefer media-id-keyed entries; else use all unique frozen values.
  const evidenceList =
    byMedia.size >= 3
      ? [idA1, idB, idA2].map((id) => byMedia.get(id)).filter(Boolean)
      : obs.map((r) => r.value);

  assert.ok(evidenceList.length >= 3);
  for (const ev of evidenceList) {
    assert.ok(Object.isFrozen(ev));
    assertDeepFrozen(ev, "ba08 evidence");
    assert.equal(liveResults.includes(ev), false, "not registry-owned identity");
    assert.deepEqual(Object.keys(ev).slice().sort(), ["providerKey", "status"]);
  }

  // If media-keyed, check exact current-live capture results per media.
  // Property compares only — classic-VM frozen records are cross-realm.
  if (byMedia.has(idA1) && byMedia.has(idB) && byMedia.has(idA2)) {
    const eA1 = byMedia.get(idA1);
    const eB = byMedia.get(idB);
    const eA2 = byMedia.get(idA2);
    assert.equal(eA1.status, "one");
    assert.equal(eA1.providerKey, "provider-a.example");
    assert.equal(eB.status, "ambiguous");
    assert.equal(eB.providerKey, null);
    assert.equal(eA2.status, "ambiguous");
    assert.equal(eA2.providerKey, null);
    // Third is ambiguous — not inheriting first media's stale "one".
    assert.notEqual(eA2.status, eA1.status);
  }

  // Safe detection projections remain source-derived A, B, A.
  assert.equal(fx.counts.publishDetection, 3);
  assert.equal(fx.publishDetections[0].id, idA1);
  assert.equal(fx.publishDetections[0].providerKey, "provider-a.example");
  assert.equal(fx.publishDetections[1].id, idB);
  assert.equal(fx.publishDetections[1].providerKey, "provider-b.example");
  assert.equal(fx.publishDetections[2].id, idA2);
  assert.equal(fx.publishDetections[2].providerKey, "provider-a.example");

  // Second/third observations never rewrite earlier media provider keys.
  assert.equal(fx.publishDetections[0].providerKey, "provider-a.example");

  // Shared CDN / registry / capture evidence absent from public output.
  const publicBlob = [
    JSON.stringify(fx.publishDetections),
    JSON.stringify(ctrl.popupMedia(50)),
    JSON.stringify(fx.diagnostics),
    JSON.stringify(ctrl.popupJobs()),
  ].join("\n");
  assert.equal(publicBlob.includes(SHARED_CDN), false);
  assert.equal(publicBlob.includes(ORIGIN), false);
  assert.equal(publicBlob.includes('"status"'), false);
  assert.equal(publicBlob.includes("ambiguous"), false);
  assert.equal(publicBlob.includes("providerKeys"), false);

  // Caller provider/URL/variant overrides cannot collapse or redirect groups.
  ctrl.registerVariants(idA1, [
    {
      url: "https://" + SHARED_CDN + "/v.mp4?sig=1",
      label: "override-try",
      providerKey: "provider-b.example",
      id: "force-b",
    },
  ]);
  assert.equal(fx.publishDetections[0].providerKey, "provider-a.example");
  assert.equal(fx.publishDetections[1].providerKey, "provider-b.example");
  // No extra registry calls from variants.
  assert.equal(inst.registryHits.observe, 3);
  assert.equal(inst.registryHits.lookup, 3);

  // Transparent wrapper returned real result identity unchanged (recorded).
  for (const e of events) {
    if (e.op === "lookup") {
      assert.ok(e.resultIdentity && typeof e.resultIdentity === "object");
      assert.equal(e.resultIdentity.status, e.result.status);
    }
  }
});

