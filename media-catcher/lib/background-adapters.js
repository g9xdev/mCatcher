/*
 * background-adapters.js — pure policy adapter for background detection /
 * download orchestration. Dual-export: CommonJS module.exports and classic-
 * script global McBackgroundAdapters.
 *
 * Lease 1: permanent controller surface + detection-to-safe-popup slice only.
 * No browser/chrome globals, storage, DOM, timers, fetch, object-URL, or
 * downloads API calls. All material effects are injected.
 */
(function (root, factory) {
  "use strict";
  var api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.McBackgroundAdapters = api;
})(
  typeof self !== "undefined" ? self :
  (typeof globalThis !== "undefined" ? globalThis : this),
  function (root) {
    "use strict";

    var LEASE1_FUTURE_MSG = "background adapter behavior not implemented in Lease 1";
    var SAFE_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
    var MEDIA_KINDS = Object.create(null);
    MEDIA_KINDS.direct = true;
    MEDIA_KINDS.hls = true;
    MEDIA_KINDS.dash = true;

    function deepFreeze(o) {
      if (!o || typeof o !== "object") return o;
      Object.getOwnPropertyNames(o).forEach(function (k) {
        var v = o[k];
        if (v && typeof v === "object") deepFreeze(v);
      });
      if (!Object.isFrozen(o)) Object.freeze(o);
      return o;
    }

    function isCommonJsActive() {
      return (
        typeof module === "object" &&
        module != null &&
        typeof module.exports !== "undefined" &&
        typeof require === "function"
      );
    }

    function resolveApi(commonJsPath, globalName) {
      if (isCommonJsActive()) {
        return require(commonJsPath);
      }
      if (root && root[globalName]) return root[globalName];
      throw new Error(globalName + " is required for BackgroundAdapters");
    }

    /** Read a named own data property without invoking accessors or enumerating. */
    function ownDataValue(obj, key) {
      if (obj == null || (typeof obj !== "object" && typeof obj !== "function")) {
        return undefined;
      }
      try {
        var desc = Object.getOwnPropertyDescriptor(obj, key);
        if (!desc) return undefined;
        if (desc.get || desc.set || !Object.prototype.hasOwnProperty.call(desc, "value")) {
          return undefined;
        }
        return desc.value;
      } catch (e) {
        return undefined;
      }
    }

    function requirePositiveInt(value, label) {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        !Number.isInteger(value) ||
        value < 1
      ) {
        throw new TypeError(label + " must be a positive integer");
      }
      return value;
    }

    function requireFiniteNumber(value, label) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError(label + " must be a finite number");
      }
      return value;
    }

    function requireFunction(value, label) {
      if (typeof value !== "function") {
        throw new TypeError(label + " must be a function");
      }
      return value;
    }

    function optionalCallback(value, label) {
      if (value == null) {
        return function () {};
      }
      if (typeof value !== "function") {
        throw new TypeError(label + " must be a function");
      }
      return value;
    }

    function isSafeIdentifier(value) {
      if (typeof value === "string") {
        if (value.length === 0 || value.length > 64) return false;
        if (value.trim().length === 0) return false;
        return SAFE_ID_RE.test(value);
      }
      if (typeof value === "number") {
        return (
          Number.isFinite(value) &&
          value >= 0 &&
          Number.isSafeInteger(value)
        );
      }
      return false;
    }

    function futureReject() {
      return Promise.reject(new Error(LEASE1_FUTURE_MSG));
    }

    function futureThrow() {
      throw new Error(LEASE1_FUTURE_MSG);
    }

    function isPlainOwnDataObject(v) {
      if (v === null || typeof v !== "object") return false;
      if (Array.isArray(v)) return false;
      try {
        var proto = Object.getPrototypeOf(v);
        return proto === Object.prototype || proto === null;
      } catch (e) {
        return false;
      }
    }

    function copyOwnDataStringRecord(record) {
      if (record === null) return null;
      if (record === undefined) return null;
      if (!isPlainOwnDataObject(record)) {
        throw new TypeError("requestHeaders must be a plain record or null");
      }
      var names = Object.getOwnPropertyNames(record);
      var out = Object.create(null);
      for (var i = 0; i < names.length; i++) {
        var k = names[i];
        var desc = Object.getOwnPropertyDescriptor(record, k);
        if (!desc || desc.get || desc.set || !Object.prototype.hasOwnProperty.call(desc, "value")) {
          throw new TypeError("requestHeaders entries must be own data values");
        }
        if (!desc.enumerable) {
          throw new TypeError("requestHeaders entries must be enumerable");
        }
        if (typeof desc.value !== "string") {
          throw new TypeError("requestHeaders values must be strings");
        }
        out[k] = desc.value;
      }
      return out;
    }

    function validateTransport(transport) {
      if (!transport || typeof transport !== "object") {
        throw new TypeError("transport must be an object");
      }
      var mediaKind = ownDataValue(transport, "mediaKind");
      if (typeof mediaKind !== "string" || !MEDIA_KINDS[mediaKind]) {
        throw new TypeError('transport.mediaKind must be "direct", "hls", or "dash"');
      }
      var requestHeaders = ownDataValue(transport, "requestHeaders");
      if (requestHeaders !== null && requestHeaders !== undefined) {
        copyOwnDataStringRecord(requestHeaders);
      }
      // Retain mirrors/variants privately later; validate shape lightly without executing.
      var mirrors = ownDataValue(transport, "mirrors");
      if (mirrors !== undefined && mirrors !== null && !Array.isArray(mirrors)) {
        throw new TypeError("transport.mirrors must be an array when present");
      }
      var variants = ownDataValue(transport, "variants");
      if (variants !== undefined && variants !== null && !Array.isArray(variants)) {
        throw new TypeError("transport.variants must be an array when present");
      }
      return {
        mediaKind: mediaKind,
        requestHeaders: requestHeaders === undefined ? null : requestHeaders,
        mirrors: mirrors === undefined ? null : mirrors,
        referer: ownDataValue(transport, "referer"),
        userAgent: ownDataValue(transport, "userAgent"),
        variants: variants === undefined ? null : variants,
      };
    }

    function createBackgroundAdapters(options) {
      if (options == null || typeof options !== "object") {
        throw new TypeError("createBackgroundAdapters requires an options object");
      }

      // Snapshot named own data properties before any state/callback construction.
      var maxConcurrent = ownDataValue(options, "maxConcurrent");
      var segmentConcurrency = ownDataValue(options, "segmentConcurrency");
      var retries = ownDataValue(options, "retries");
      var nowFn = ownDataValue(options, "now");
      var randomTokenFn = ownDataValue(options, "randomToken");
      var postNativeFn = ownDataValue(options, "postNative");
      var downloadsDownloadFn = ownDataValue(options, "downloadsDownload");
      var createObjectURLFn = ownDataValue(options, "createObjectURL");
      var revokeObjectURLFn = ownDataValue(options, "revokeObjectURL");
      var fetchArrayBufferFn = ownDataValue(options, "fetchArrayBuffer");
      var assembleMediaFn = ownDataValue(options, "assembleMedia");
      var isPopupSenderFn = ownDataValue(options, "isPopupSender");
      var getEffectiveDestinationDirectoryFn = ownDataValue(
        options,
        "getEffectiveDestinationDirectory"
      );
      var publishDetectionOpt = ownDataValue(options, "publishDetection");
      var publishJobsOpt = ownDataValue(options, "publishJobs");
      var persistHistoryOpt = ownDataValue(options, "persistHistory");
      var reportDiagnosticOpt = ownDataValue(options, "reportDiagnostic");

      requirePositiveInt(maxConcurrent, "maxConcurrent");
      requirePositiveInt(segmentConcurrency, "segmentConcurrency");
      requireFiniteNumber(retries, "retries");
      requireFunction(nowFn, "now");
      requireFunction(randomTokenFn, "randomToken");
      requireFunction(postNativeFn, "postNative");
      requireFunction(downloadsDownloadFn, "downloadsDownload");
      requireFunction(createObjectURLFn, "createObjectURL");
      requireFunction(revokeObjectURLFn, "revokeObjectURL");
      requireFunction(fetchArrayBufferFn, "fetchArrayBuffer");
      requireFunction(assembleMediaFn, "assembleMedia");
      requireFunction(isPopupSenderFn, "isPopupSender");
      requireFunction(getEffectiveDestinationDirectoryFn, "getEffectiveDestinationDirectory");

      var publishDetection = optionalCallback(publishDetectionOpt, "publishDetection");
      var publishJobs = optionalCallback(publishJobsOpt, "publishJobs");
      var persistHistory = optionalCallback(persistHistoryOpt, "persistHistory");
      var reportDiagnostic = optionalCallback(reportDiagnosticOpt, "reportDiagnostic");

      // Material effects retained for later leases (unused in Lease 1 methods).
      var postNative = postNativeFn;
      var createObjectURL = createObjectURLFn;
      var revokeObjectURL = revokeObjectURLFn;
      var fetchArrayBuffer = fetchArrayBufferFn;
      var assembleMedia = assembleMediaFn;
      var isPopupSender = isPopupSenderFn;
      var getEffectiveDestinationDirectory = getEffectiveDestinationDirectoryFn;
      // Silence unused-binding warnings for Lease-1 scaffolding only.
      void postNative;
      void createObjectURL;
      void revokeObjectURL;
      void fetchArrayBuffer;
      void assembleMedia;
      void isPopupSender;
      void getEffectiveDestinationDirectory;
      void publishJobs;
      void persistHistory;
      void maxConcurrent;
      void segmentConcurrency;
      void retries;

      // Resolve pure APIs after option validation.
      var DetectionFinalizerApi = resolveApi("./detection-finalizer.js", "McDetectionFinalizer");
      var FilenameRankerApi = resolveApi("./filename-ranker.js", "McFilenameRanker");
      var SourceContextApi = resolveApi("./source-context.js", "McSourceContext");
      var ProviderRegistryApi = resolveApi("./provider-registry.js", "McProviderRegistry");
      var PrivacyApi = resolveApi("./privacy.js", "McPrivacy");
      var FirefoxGuardApi = resolveApi("./firefox-guard.js", "McFirefoxGuard");

      // downloadsDownload may be captured ONLY into FirefoxGuard — never stored
      // in another closure or referenced by any controller method.
      FirefoxGuardApi.createFirefoxGuard({
        downloadsDownload: downloadsDownloadFn,
        createObjectURL: createObjectURLFn,
        revokeObjectURL: revokeObjectURLFn,
      });

      var finalizer = DetectionFinalizerApi.createDetectionFinalizer({
        now: function () {
          var t = nowFn();
          if (typeof t !== "number" || !Number.isFinite(t)) {
            throw new TypeError("now() must return a finite millisecond number");
          }
          return t;
        },
        rank: FilenameRankerApi.rank,
        buildSourceContext: SourceContextApi.buildSourceContext,
      });

      // ---- Private session state (never exported) ----
      /** @type {Map<string, object>} opaque media ID -> finalized private source */
      var sourcesByMediaId = new Map();
      /** @type {Map<number, string>} finalizer numeric detection ID -> opaque media ID */
      var mediaIdByDetectionId = new Map();
      /** @type {Map<string, object>} opaque media ID -> pending transport/ephemeral */
      var pendingByMediaId = new Map();
      /** @type {Set<number>} reconciled finalizer detection IDs */
      var reconciledDetectionIds = new Set();
      /** @type {Set<string>} published media IDs */
      var publishedMediaIds = new Set();
      /** @type {Map<number, string[]>} tabId -> ordered opaque media IDs */
      var mediaIdsByTab = new Map();
      /** @type {Set<string>} issued public IDs */
      var issuedPublicIds = new Set();
      /** @type {Map<string, number>} namespace -> counter */
      var namespaceCounters = new Map();
      /** @type {Map<string, string>} session fallback document/page identity */
      var sessionIdentities = new Map();
      var sessionIdentityCounter = 0;

      // Ready for Lease 2+ (no behavior using them yet).
      var providerRegistry = ProviderRegistryApi.createProviderRegistry();
      var jobsById = new Map();
      var jobOrder = [];
      var sinkSessions = new Map();
      var proofTokens = new Set();
      var historyEntries = [];
      void providerRegistry;
      void jobsById;
      void jobOrder;
      void sinkSessions;
      void proofTokens;
      void historyEntries;

      function mintPublicId(namespace) {
        if (typeof namespace !== "string" || !SAFE_ID_RE.test(namespace)) {
          throw new TypeError("namespace must be a safe identifier string");
        }
        var counter = namespaceCounters.has(namespace)
          ? namespaceCounters.get(namespace)
          : 0;
        for (var attempt = 0; attempt < 64; attempt++) {
          counter += 1;
          namespaceCounters.set(namespace, counter);
          var raw = randomTokenFn(namespace);
          if (!isSafeIdentifier(raw)) {
            throw new TypeError("randomToken must return a safe identifier");
          }
          var tokenPart = typeof raw === "number" ? String(raw) : raw;
          var candidate = namespace + "-" + tokenPart + "-" + counter;
          // Bound public IDs; fall back to namespace-counter only form if needed.
          if (candidate.length > 64) {
            candidate = namespace + "-" + counter;
          }
          if (!SAFE_ID_RE.test(candidate)) {
            candidate = namespace + "-" + counter;
          }
          if (!issuedPublicIds.has(candidate)) {
            issuedPublicIds.add(candidate);
            return candidate;
          }
        }
        // Exhaustion fallback: purely monotonic.
        counter += 1;
        namespaceCounters.set(namespace, counter);
        var forced = namespace + "-" + counter;
        issuedPublicIds.add(forced);
        return forced;
      }

      function safeDiagnostic(code, scope, id) {
        var d = { code: code, scope: scope };
        if (id !== undefined) d.id = id;
        return deepFreeze(d);
      }

      function reportSafeDiagnostic(code, scope, id) {
        try {
          reportDiagnostic(safeDiagnostic(code, scope, id));
        } catch (e) {
          // Diagnostic callback failure is swallowed.
        }
      }

      function deriveProviderKey(sourceContext) {
        var site =
          sourceContext && typeof sourceContext.topLevelSite === "string"
            ? sourceContext.topLevelSite.trim()
            : "";
        if (site) {
          return SourceContextApi.providerKeyFromSite
            ? SourceContextApi.providerKeyFromSite(site)
            : site.toLowerCase();
        }
        // Session-scoped fallback — never media/CDN origin.
        var docId =
          sourceContext && sourceContext.documentId != null
            ? String(sourceContext.documentId)
            : "";
        var pageUrl =
          sourceContext && sourceContext.topLevelPageUrl != null
            ? String(sourceContext.topLevelPageUrl)
            : "";
        var key;
        if (docId) {
          key = "doc:" + docId;
          if (!sessionIdentities.has(key)) {
            sessionIdentityCounter += 1;
            sessionIdentities.set(key, "document-session:" + sessionIdentityCounter);
          }
          return sessionIdentities.get(key);
        }
        if (pageUrl) {
          key = "page:" + pageUrl;
          if (!sessionIdentities.has(key)) {
            sessionIdentityCounter += 1;
            sessionIdentities.set(key, "page-session:" + sessionIdentityCounter);
          }
          return sessionIdentities.get(key);
        }
        sessionIdentityCounter += 1;
        return "page-session:" + sessionIdentityCounter;
      }

      function projectSafeDetection(record) {
        return deepFreeze({
          id: record.mediaId,
          proposedFilename: record.proposedFilename,
          kind: record.mediaKind,
          providerKey: record.providerKey,
        });
      }

      function projectPopupRow(record) {
        return deepFreeze({
          id: record.mediaId,
          proposedFilename: record.proposedFilename,
          kind: record.mediaKind,
          variants: Object.freeze([]),
        });
      }

      function reconcileFinalized() {
        var items = finalizer.listFinalized();
        for (var i = 0; i < items.length; i++) {
          var item = items[i];
          var detectionId = item.detectionId;
          if (reconciledDetectionIds.has(detectionId)) continue;

          var mediaId = mediaIdByDetectionId.get(detectionId);
          if (mediaId == null) {
            // No pre-minted binding (should not occur for adapter-owned detections).
            reconciledDetectionIds.add(detectionId);
            continue;
          }

          var pending = pendingByMediaId.get(mediaId);
          if (!pending) {
            reconciledDetectionIds.add(detectionId);
            continue;
          }

          var sourceContext = item.sourceContext;
          var proposedFilename = item.proposedFilename;
          var providerKey = deriveProviderKey(sourceContext);
          var tabId = sourceContext && typeof sourceContext.tabId === "number"
            ? sourceContext.tabId
            : pending.tabId | 0;

          // Private source record — never enumerable secrets; mediaUrl stays in
          // ephemeral handle or finalizer-private storage only.
          var record = {
            mediaId: mediaId,
            detectionId: detectionId,
            sourceContext: sourceContext,
            proposedFilename: proposedFilename,
            mediaKind: pending.mediaKind,
            providerKey: providerKey,
            tabId: tabId,
            ephemeral: pending.ephemeral,
          };
          // Freeze record without enumerating ephemeral internals into projections.
          Object.freeze(record);
          sourcesByMediaId.set(mediaId, record);
          pendingByMediaId.delete(mediaId);
          reconciledDetectionIds.add(detectionId);

          // Mark published before callback so reentrancy/throw cannot duplicate.
          publishedMediaIds.add(mediaId);
          var tabList = mediaIdsByTab.get(tabId);
          if (!tabList) {
            tabList = [];
            mediaIdsByTab.set(tabId, tabList);
          }
          tabList.push(mediaId);

          try {
            publishDetection(projectSafeDetection(record));
          } catch (pubErr) {
            reportSafeDiagnostic("publish-detection-failed", "detection", mediaId);
          }
        }
      }

      function captureNetwork(input) {
        if (!input || typeof input !== "object") {
          throw new TypeError("captureNetwork input must be an object");
        }
        var details = ownDataValue(input, "details");
        var hints = ownDataValue(input, "hints");
        var transportRaw = ownDataValue(input, "transport");
        var transport = validateTransport(transportRaw);

        var event = DetectionFinalizerApi.mapWebRequestDetails(details, hints || {});
        var mediaId = mintPublicId("media");
        var mediaUrl = event.mediaUrl;
        var headerCopy = copyOwnDataStringRecord(transport.requestHeaders);
        var ephemeral = PrivacyApi.createEphemeral(mediaUrl, headerCopy);

        // Bind pending before begin so immediate finalization can reconcile.
        pendingByMediaId.set(mediaId, {
          mediaKind: transport.mediaKind,
          ephemeral: ephemeral,
          tabId: event.tabId | 0,
          mirrors: transport.mirrors,
          variants: transport.variants,
          referer: transport.referer,
          userAgent: transport.userAgent,
        });

        var detectionId = finalizer.beginNetworkDetection(event);
        mediaIdByDetectionId.set(detectionId, mediaId);
        reconcileFinalized();
        return mediaId;
      }

      function acceptPageSnapshot(snapshot) {
        finalizer.provideDocumentSnapshot(snapshot);
        reconcileFinalized();
        return undefined;
      }

      function captureDomMedia(input) {
        if (!input || typeof input !== "object") {
          throw new TypeError("captureDomMedia input must be an object");
        }
        var transportRaw = ownDataValue(input, "transport");
        var transport = validateTransport(transportRaw);

        var mediaId = mintPublicId("media");
        var mediaUrl = ownDataValue(input, "mediaUrl");
        if (typeof mediaUrl !== "string" || mediaUrl.trim().length === 0) {
          throw new TypeError("mediaUrl must be a nonblank primitive string");
        }
        var headerCopy = copyOwnDataStringRecord(transport.requestHeaders);
        var ephemeral = PrivacyApi.createEphemeral(mediaUrl, headerCopy);

        var snapshot = ownDataValue(input, "snapshot");
        var snapTab = snapshot ? ownDataValue(snapshot, "tabId") : undefined;
        var tabId = typeof snapTab === "number" ? snapTab | 0 : 0;

        pendingByMediaId.set(mediaId, {
          mediaKind: transport.mediaKind,
          ephemeral: ephemeral,
          tabId: tabId,
          mirrors: transport.mirrors,
          variants: transport.variants,
          referer: transport.referer,
          userAgent: transport.userAgent,
        });

        var item = finalizer.finalizeFromDom({
          snapshot: snapshot,
          mediaUrl: mediaUrl,
          mediaOrigin: ownDataValue(input, "mediaOrigin"),
          contentDisposition: ownDataValue(input, "contentDisposition"),
          referrerUrl: ownDataValue(input, "referrerUrl"),
          frameOrigin: ownDataValue(input, "frameOrigin"),
          ts: ownDataValue(input, "ts"),
        });
        mediaIdByDetectionId.set(item.detectionId, mediaId);
        reconcileFinalized();
        return mediaId;
      }

      function popupMedia(tabId) {
        if (
          typeof tabId !== "number" ||
          !Number.isFinite(tabId) ||
          !Number.isInteger(tabId) ||
          tabId < 0
        ) {
          throw new TypeError("tabId must be a finite nonnegative integer");
        }
        var list = mediaIdsByTab.get(tabId) || [];
        var out = [];
        for (var i = 0; i < list.length; i++) {
          var rec = sourcesByMediaId.get(list[i]);
          if (rec) out.push(projectPopupRow(rec));
        }
        return deepFreeze(out);
      }

      function tick(nowMs) {
        return Promise.resolve().then(function () {
          if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
            throw new TypeError("tick nowMs must be a finite number");
          }
          finalizer.tick(nowMs);
          reconcileFinalized();
        });
      }

      function popupJobs() {
        return deepFreeze([]);
      }

      return Object.freeze({
        captureNetwork: captureNetwork,
        acceptPageSnapshot: acceptPageSnapshot,
        captureDomMedia: captureDomMedia,
        registerVariants: function registerVariants() {
          futureThrow();
        },
        popupMedia: popupMedia,
        enqueueDownload: function enqueueDownload() {
          return futureReject();
        },
        handleNativeMessage: function handleNativeMessage() {
          return futureReject();
        },
        requestFirefoxHandoff: function requestFirefoxHandoff() {
          return futureReject();
        },
        cancel: function cancel() {
          return futureReject();
        },
        manualRetry: function manualRetry() {
          return futureReject();
        },
        helperDisconnected: function helperDisconnected() {
          return futureReject();
        },
        setMaxConcurrent: function setMaxConcurrent() {
          return futureReject();
        },
        tick: tick,
        pump: function pump() {
          return futureReject();
        },
        popupJobs: popupJobs,
      });
    }

    return Object.freeze({
      createBackgroundAdapters: createBackgroundAdapters,
    });
  }
);
