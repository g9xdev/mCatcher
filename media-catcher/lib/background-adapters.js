/*
 * background-adapters.js — pure policy adapters for detection → popup (Lease 1).
 * Dual-export: CommonJS module.exports and classic-script global McBackgroundAdapters.
 * No browser/chrome globals, storage, DOM, timers, fetch, object URLs, or downloads API.
 * All material effects are injected. Session memory only.
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

    var LEASE1_MSG = "background adapter behavior not implemented in Lease 1";
    var CONTROLLER_KEYS = [
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
    ];

    function isCommonJsActive() {
      return (
        typeof module === "object" &&
        module != null &&
        typeof module.exports !== "undefined" &&
        typeof require === "function"
      );
    }

    function resolveDetectionFinalizer() {
      if (isCommonJsActive()) return require("./detection-finalizer.js");
      if (root && root.McDetectionFinalizer) return root.McDetectionFinalizer;
      throw new Error("McDetectionFinalizer is required for BackgroundAdapters");
    }

    function resolveSourceContext() {
      if (isCommonJsActive()) return require("./source-context.js");
      if (root && root.McSourceContext) return root.McSourceContext;
      throw new Error("McSourceContext is required for BackgroundAdapters");
    }

    function resolveFilenameRanker() {
      if (isCommonJsActive()) return require("./filename-ranker.js");
      if (root && root.McFilenameRanker) return root.McFilenameRanker;
      throw new Error("McFilenameRanker is required for BackgroundAdapters");
    }

    function resolveProviderRegistry() {
      if (isCommonJsActive()) return require("./provider-registry.js");
      if (root && root.McProviderRegistry) return root.McProviderRegistry;
      throw new Error("McProviderRegistry is required for BackgroundAdapters");
    }

    function resolvePrivacy() {
      if (isCommonJsActive()) return require("./privacy.js");
      if (root && root.McPrivacy) return root.McPrivacy;
      throw new Error("McPrivacy is required for BackgroundAdapters");
    }

    function resolveFirefoxGuard() {
      if (isCommonJsActive()) return require("./firefox-guard.js");
      if (root && root.McFirefoxGuard) return root.McFirefoxGuard;
      throw new Error("McFirefoxGuard is required for BackgroundAdapters");
    }

    function deepClone(value) {
      if (value == null || typeof value !== "object") return value;
      if (Array.isArray(value)) return value.map(deepClone);
      var out = {};
      Object.keys(value).forEach(function (k) {
        out[k] = deepClone(value[k]);
      });
      return out;
    }

    function deepFreeze(o) {
      if (!o || typeof o !== "object") return o;
      Object.getOwnPropertyNames(o).forEach(function (k) {
        var v = o[k];
        if (v && typeof v === "object") deepFreeze(v);
      });
      if (!Object.isFrozen(o)) Object.freeze(o);
      return o;
    }

    function freezeClone(value) {
      if (value == null || typeof value !== "object") return value;
      return deepFreeze(deepClone(value));
    }

    /** Named own data property only — never enumerates, never invokes accessors. */
    function ownData(obj, key) {
      if (obj == null || (typeof obj !== "object" && typeof obj !== "function")) {
        return undefined;
      }
      try {
        var desc = Object.getOwnPropertyDescriptor(obj, key);
        if (!desc || desc.get || desc.set || !("value" in desc)) return undefined;
        return desc.value;
      } catch (e) {
        return undefined;
      }
    }

    function isPlainRecord(v) {
      if (v === null || typeof v !== "object") return false;
      if (Array.isArray(v)) return false;
      try {
        var proto = Object.getPrototypeOf(v);
        return proto === Object.prototype || proto === null;
      } catch (e) {
        return false;
      }
    }

    function requirePositiveInt(value, label) {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        !Number.isInteger(value) ||
        value < 1
      ) {
        throw new TypeError(label + " must be a positive finite integer");
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
      if (value === undefined || value === null) {
        return function noop() {};
      }
      if (typeof value !== "function") {
        throw new TypeError(label + " must be a function");
      }
      return value;
    }

    function isNonnegInt(value) {
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        Number.isInteger(value) &&
        value >= 0
      );
    }

    function hasControlChars(s) {
      return /[\u0000-\u001f\u007f]/.test(s);
    }

    function isSafeTokenString(v) {
      return (
        typeof v === "string" &&
        v.length > 0 &&
        v.length <= 64 &&
        v.trim().length === v.length &&
        !hasControlChars(v) &&
        /^[A-Za-z0-9._:-]+$/.test(v)
      );
    }

    function isSafeTokenNumber(v) {
      return (
        typeof v === "number" &&
        Number.isFinite(v) &&
        Number.isSafeInteger(v) &&
        v >= 0
      );
    }

    function validateMediaKind(value) {
      if (value !== "direct" && value !== "hls" && value !== "dash") {
        throw new TypeError("transport.mediaKind is invalid");
      }
      return value;
    }

    function validateTransport(transport) {
      if (!transport || typeof transport !== "object") {
        throw new TypeError("transport must be an object");
      }
      var mediaKind = validateMediaKind(ownData(transport, "mediaKind"));
      var requestHeaders = ownData(transport, "requestHeaders");
      if (requestHeaders === undefined) requestHeaders = null;
      if (requestHeaders !== null) {
        if (!isPlainRecord(requestHeaders)) {
          throw new TypeError("transport.requestHeaders must be a plain record or null");
        }
      }
      // Retain optional future fields privately; do not execute or publish them.
      return {
        mediaKind: mediaKind,
        requestHeaders: requestHeaders,
        mirrors: ownData(transport, "mirrors"),
        referer: ownData(transport, "referer"),
        userAgent: ownData(transport, "userAgent"),
        variants: ownData(transport, "variants"),
      };
    }

    function createBackgroundAdapters(options) {
      if (!options || typeof options !== "object") {
        throw new TypeError("options must be an object");
      }

      // Snapshot named own data properties before any state or dependency construction.
      var maxConcurrent = ownData(options, "maxConcurrent");
      var segmentConcurrency = ownData(options, "segmentConcurrency");
      var retries = ownData(options, "retries");
      var nowFn = ownData(options, "now");
      var randomTokenFn = ownData(options, "randomToken");
      var postNative = ownData(options, "postNative");
      var downloadsDownload = ownData(options, "downloadsDownload");
      var createObjectURL = ownData(options, "createObjectURL");
      var revokeObjectURL = ownData(options, "revokeObjectURL");
      var fetchArrayBuffer = ownData(options, "fetchArrayBuffer");
      var assembleMedia = ownData(options, "assembleMedia");
      var isPopupSender = ownData(options, "isPopupSender");
      var getEffectiveDestinationDirectory = ownData(
        options,
        "getEffectiveDestinationDirectory"
      );
      var publishDetectionOpt = ownData(options, "publishDetection");
      var publishJobsOpt = ownData(options, "publishJobs");
      var persistHistoryOpt = ownData(options, "persistHistory");
      var reportDiagnosticOpt = ownData(options, "reportDiagnostic");

      requirePositiveInt(maxConcurrent, "maxConcurrent");
      requirePositiveInt(segmentConcurrency, "segmentConcurrency");
      requireFiniteNumber(retries, "retries");
      requireFunction(nowFn, "now");
      requireFunction(randomTokenFn, "randomToken");
      requireFunction(postNative, "postNative");
      requireFunction(downloadsDownload, "downloadsDownload");
      requireFunction(createObjectURL, "createObjectURL");
      requireFunction(revokeObjectURL, "revokeObjectURL");
      requireFunction(fetchArrayBuffer, "fetchArrayBuffer");
      requireFunction(assembleMedia, "assembleMedia");
      requireFunction(isPopupSender, "isPopupSender");
      requireFunction(
        getEffectiveDestinationDirectory,
        "getEffectiveDestinationDirectory"
      );

      var publishDetection = optionalCallback(publishDetectionOpt, "publishDetection");
      var publishJobs = optionalCallback(publishJobsOpt, "publishJobs");
      var persistHistory = optionalCallback(persistHistoryOpt, "persistHistory");
      var reportDiagnostic = optionalCallback(reportDiagnosticOpt, "reportDiagnostic");

      // Retain accepted scalars for later leases (scheduler not constructed here).
      var settings = {
        maxConcurrent: maxConcurrent,
        segmentConcurrency: segmentConcurrency,
        retries: retries,
      };
      void settings;
      void postNative;
      void createObjectURL;
      void revokeObjectURL;
      void fetchArrayBuffer;
      void assembleMedia;
      void isPopupSender;
      void getEffectiveDestinationDirectory;
      void publishJobs;
      void persistHistory;

      function safeNow() {
        var t = nowFn();
        if (typeof t !== "number" || !Number.isFinite(t)) {
          throw new TypeError("now must return a finite number");
        }
        return t;
      }

      var DetectionFinalizer = resolveDetectionFinalizer();
      var SourceContext = resolveSourceContext();
      var FilenameRanker = resolveFilenameRanker();
      var ProviderRegistryApi = resolveProviderRegistry();
      var Privacy = resolvePrivacy();
      var FirefoxGuard = resolveFirefoxGuard();

      // downloadsDownload is captured only into the real FirefoxGuard — never
      // stored in another adapter closure or referenced by controller methods.
      var firefoxGuard = FirefoxGuard.createFirefoxGuard({
        downloadsDownload: downloadsDownload,
        createObjectURL: createObjectURL,
        revokeObjectURL: revokeObjectURL,
      });
      void firefoxGuard;

      var finalizer = DetectionFinalizer.createDetectionFinalizer({
        now: safeNow,
        rank: FilenameRanker.rank,
        buildSourceContext: SourceContext.buildSourceContext,
      });

      var providerRegistry = ProviderRegistryApi.createProviderRegistry();
      void providerRegistry;

      // --- Private session state (never exposed) ---
      /** @type {Map<string, object>} opaque media ID → finalized private source record */
      var sourcesByMediaId = new Map();
      /** @type {Map<number, string>} finalizer numeric detection ID → opaque media ID */
      var detectionIdToMediaId = new Map();
      /** @type {Map<string, object>} opaque media ID → pending transport/ephemeral */
      var pendingByMediaId = new Map();
      /** @type {Set<number>} reconciled finalizer IDs */
      var reconciledDetectionIds = new Set();
      /** @type {Set<string>} published media IDs */
      var publishedMediaIds = new Set();
      /** @type {Map<number, string[]>} tab ID → ordered opaque media IDs */
      var tabMediaIds = new Map();
      /** @type {Set<string>} issued public IDs */
      var issuedPublicIds = new Set();
      /** @type {Map<string, number>} namespace → monotonic counter */
      var namespaceCounters = new Map();
      /** Session fallback identities when topLevelSite is blank. */
      var sessionDocIdentity = new Map();
      var sessionPageIdentity = new Map();
      var sessionDocCounter = 0;
      var sessionPageCounter = 0;
      var nextPrivateDetectionId = 0;

      // Empty holders for later leases (no behavior yet).
      var jobsById = new Map();
      var sinkSessions = new Map();
      var proofTokens = new Set();
      var historyEntries = [];
      void jobsById;
      void sinkSessions;
      void proofTokens;
      void historyEntries;

      function mintPublicId(namespace) {
        var raw = randomTokenFn(namespace);
        var base;
        if (isSafeTokenNumber(raw)) {
          base = String(raw);
        } else if (isSafeTokenString(raw)) {
          base = raw;
        } else {
          throw new TypeError("randomToken must return a safe identifier");
        }
        var counter = namespaceCounters.has(namespace)
          ? namespaceCounters.get(namespace)
          : 0;
        var id;
        do {
          counter += 1;
          id = namespace + ":" + base + ":" + counter;
        } while (issuedPublicIds.has(id));
        namespaceCounters.set(namespace, counter);
        issuedPublicIds.add(id);
        return id;
      }

      function deriveProviderKey(sourceContext) {
        var site = sourceContext && sourceContext.topLevelSite;
        if (typeof site === "string" && site.trim().length > 0) {
          return site;
        }
        var documentId = sourceContext && sourceContext.documentId;
        if (documentId != null && String(documentId).length > 0) {
          var docKey = String(documentId);
          if (sessionDocIdentity.has(docKey)) {
            return sessionDocIdentity.get(docKey);
          }
          sessionDocCounter += 1;
          var docId = "document-session:" + sessionDocCounter;
          sessionDocIdentity.set(docKey, docId);
          return docId;
        }
        var pageKey =
          (sourceContext && sourceContext.topLevelPageUrl) ||
          ("tab:" + String(sourceContext && sourceContext.tabId));
        pageKey = String(pageKey);
        if (sessionPageIdentity.has(pageKey)) {
          return sessionPageIdentity.get(pageKey);
        }
        sessionPageCounter += 1;
        var pageId = "page-session:" + sessionPageCounter;
        sessionPageIdentity.set(pageKey, pageId);
        return pageId;
      }

      function reportSafeDiagnostic(code, mediaId) {
        try {
          var diag = { code: code, scope: "background-adapters" };
          if (mediaId != null) diag.id = mediaId;
          reportDiagnostic(deepFreeze(diag));
        } catch (e) {
          // Diagnostic callback failure is swallowed.
        }
      }

      function projectSafeDetection(mediaId, proposedFilename, kind, providerKey) {
        return deepFreeze({
          id: mediaId,
          proposedFilename: proposedFilename,
          kind: kind,
          providerKey: providerKey,
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

      function reconcile() {
        var items = finalizer.listFinalized();
        for (var i = 0; i < items.length; i++) {
          var item = items[i];
          if (!item) continue;
          var detId = item.detectionId | 0;
          if (reconciledDetectionIds.has(detId)) continue;

          var mediaId = detectionIdToMediaId.get(detId);
          if (mediaId == null) continue;

          var pending = pendingByMediaId.get(mediaId);
          var mediaKind =
            pending && pending.mediaKind ? pending.mediaKind : "direct";
          var ephemeral = pending && pending.ephemeral ? pending.ephemeral : null;
          var tabId =
            item.sourceContext && typeof item.sourceContext.tabId === "number"
              ? item.sourceContext.tabId
              : pending && typeof pending.tabId === "number"
                ? pending.tabId
                : 0;

          // Exact frozen sourceContext from finalizer; propose-once filename.
          var sourceContext = item.sourceContext;
          var proposedFilename = item.proposedFilename;
          var providerKey = deriveProviderKey(sourceContext);

          // Session registry observation for later leases (CDN origin + site key).
          try {
            if (sourceContext && sourceContext.mediaOrigin) {
              providerRegistry.observe(sourceContext.mediaOrigin, providerKey);
            }
          } catch (observeErr) {
            // Registry observe is best-effort scaffolding.
          }

          var record = {
            mediaId: mediaId,
            sourceContext: sourceContext,
            proposedFilename: proposedFilename,
            mediaKind: mediaKind,
            providerKey: providerKey,
            tabId: tabId,
          };
          // Private finalizer numeric ID — non-enumerable, never projected.
          Object.defineProperty(record, "detectionId", {
            value: detId,
            enumerable: false,
            writable: false,
            configurable: false,
          });
          // Memory-only ephemeral source handle — non-enumerable.
          Object.defineProperty(record, "ephemeral", {
            value: ephemeral,
            enumerable: false,
            writable: false,
            configurable: false,
          });
          Object.freeze(record);

          sourcesByMediaId.set(mediaId, record);
          pendingByMediaId.delete(mediaId);

          // Mark reconciled + published before callback so reentrancy cannot duplicate.
          reconciledDetectionIds.add(detId);
          publishedMediaIds.add(mediaId);

          var ordered = tabMediaIds.get(tabId);
          if (!ordered) {
            ordered = [];
            tabMediaIds.set(tabId, ordered);
          }
          ordered.push(mediaId);

          var safe = projectSafeDetection(
            mediaId,
            proposedFilename,
            mediaKind,
            providerKey
          );
          try {
            publishDetection(safe);
          } catch (pubErr) {
            reportSafeDiagnostic("publish-detection-failed", mediaId);
          }
        }
      }

      function captureNetwork(input) {
        if (!input || typeof input !== "object") {
          throw new TypeError("captureNetwork input must be an object");
        }
        var details = ownData(input, "details");
        var hints = ownData(input, "hints");
        var transport = validateTransport(ownData(input, "transport"));

        var mapped = DetectionFinalizer.mapWebRequestDetails(details || {}, hints || {});
        nextPrivateDetectionId += 1;
        var detectionId = nextPrivateDetectionId;
        mapped.detectionId = detectionId;

        var mediaId = mintPublicId("media");
        var ephemeral = Privacy.createEphemeral(
          String(mapped.mediaUrl || "about:blank"),
          transport.requestHeaders
        );

        pendingByMediaId.set(mediaId, {
          detectionId: detectionId,
          transport: transport,
          ephemeral: ephemeral,
          mediaKind: transport.mediaKind,
          tabId: mapped.tabId | 0,
        });
        detectionIdToMediaId.set(detectionId, mediaId);

        finalizer.beginNetworkDetection(mapped);
        reconcile();
        return mediaId;
      }

      function acceptPageSnapshot(snapshot) {
        finalizer.provideDocumentSnapshot(snapshot);
        reconcile();
        return undefined;
      }

      function captureDomMedia(input) {
        if (!input || typeof input !== "object") {
          throw new TypeError("captureDomMedia input must be an object");
        }
        var transport = validateTransport(ownData(input, "transport"));
        var mediaId = mintPublicId("media");
        var mediaUrl = ownData(input, "mediaUrl");
        var ephemeral = Privacy.createEphemeral(
          String(mediaUrl == null ? "about:blank" : mediaUrl),
          transport.requestHeaders
        );

        var item = finalizer.finalizeFromDom({
          snapshot: ownData(input, "snapshot"),
          mediaUrl: mediaUrl,
          mediaOrigin: ownData(input, "mediaOrigin"),
          contentDisposition: ownData(input, "contentDisposition"),
          referrerUrl: ownData(input, "referrerUrl"),
          frameOrigin: ownData(input, "frameOrigin"),
          ts: ownData(input, "ts"),
        });

        var detectionId = item.detectionId | 0;
        detectionIdToMediaId.set(detectionId, mediaId);
        pendingByMediaId.set(mediaId, {
          detectionId: detectionId,
          transport: transport,
          ephemeral: ephemeral,
          mediaKind: transport.mediaKind,
          tabId: item.sourceContext ? item.sourceContext.tabId | 0 : 0,
        });

        reconcile();
        return mediaId;
      }

      function registerVariants(/* mediaId, variants */) {
        throw new Error(LEASE1_MSG);
      }

      function popupMedia(tabId) {
        if (!isNonnegInt(tabId)) {
          throw new TypeError("tabId must be a finite nonnegative integer");
        }
        var ordered = tabMediaIds.get(tabId) || [];
        var rows = [];
        for (var i = 0; i < ordered.length; i++) {
          var rec = sourcesByMediaId.get(ordered[i]);
          if (!rec) continue;
          rows.push(projectPopupRow(rec));
        }
        return deepFreeze(rows);
      }

      function lease1Reject() {
        return Promise.reject(new Error(LEASE1_MSG));
      }

      function enqueueDownload(/* message, sender */) {
        return lease1Reject();
      }

      function handleNativeMessage(/* message */) {
        return lease1Reject();
      }

      function requestFirefoxHandoff(/* message, sender */) {
        return lease1Reject();
      }

      function cancel(/* jobId */) {
        return lease1Reject();
      }

      function manualRetry(/* jobId */) {
        return lease1Reject();
      }

      function helperDisconnected() {
        return lease1Reject();
      }

      function setMaxConcurrent(/* value */) {
        return lease1Reject();
      }

      function tick(nowMs) {
        return Promise.resolve().then(function () {
          if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
            throw new TypeError("nowMs must be a finite number");
          }
          finalizer.tick(nowMs);
          reconcile();
        });
      }

      function pump() {
        return lease1Reject();
      }

      function popupJobs() {
        return Object.freeze([]);
      }

      var controller = {};
      controller.captureNetwork = captureNetwork;
      controller.acceptPageSnapshot = acceptPageSnapshot;
      controller.captureDomMedia = captureDomMedia;
      controller.registerVariants = registerVariants;
      controller.popupMedia = popupMedia;
      controller.enqueueDownload = enqueueDownload;
      controller.handleNativeMessage = handleNativeMessage;
      controller.requestFirefoxHandoff = requestFirefoxHandoff;
      controller.cancel = cancel;
      controller.manualRetry = manualRetry;
      controller.helperDisconnected = helperDisconnected;
      controller.setMaxConcurrent = setMaxConcurrent;
      controller.tick = tick;
      controller.pump = pump;
      controller.popupJobs = popupJobs;

      // Exact 15 own enumerable keys in permanent order.
      var ordered = {};
      for (var k = 0; k < CONTROLLER_KEYS.length; k++) {
        var key = CONTROLLER_KEYS[k];
        ordered[key] = controller[key];
      }
      return Object.freeze(ordered);
    }

    return Object.freeze({
      createBackgroundAdapters: createBackgroundAdapters,
    });
  }
);
