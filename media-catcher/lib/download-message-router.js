/*
 * download-message-router.js — pure native-message routing and start payloads.
 * Dual-export: CommonJS module.exports and classic-script global McDownloadMessageRouter.
 * Never spreads/enumerates inputs. Never invokes Firefox, storage, downloads, or logging.
 */
(function (root, factory) {
  "use strict";
  var api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.McDownloadMessageRouter = api;
})(
  typeof self !== "undefined" ? self :
  (typeof globalThis !== "undefined" ? globalThis : this),
  function (root) {
    "use strict";

    /**
     * CommonJS is the active path when module.exports is live and require exists.
     * In that mode, require deps directly and propagate load/init failures.
     * Browser dual-export uses globals only when CommonJS is not the active path.
     */
    function isCommonJsActive() {
      return (
        typeof module === "object" &&
        module != null &&
        typeof module.exports !== "undefined" &&
        typeof require === "function"
      );
    }

    function resolveDownloadIntent() {
      if (isCommonJsActive()) {
        return require("./download-intent.js");
      }
      if (root && root.McDownloadIntent) return root.McDownloadIntent;
      throw new Error("McDownloadIntent is required for DownloadMessageRouter");
    }

    function resolveFileSinkProtocol() {
      if (isCommonJsActive()) {
        return require("./file-sink-protocol.js");
      }
      if (root && root.McFileSinkProtocol) return root.McFileSinkProtocol;
      throw new Error("McFileSinkProtocol is required for DownloadMessageRouter");
    }

    function deepFreeze(o) {
      if (!o || typeof o !== "object" || Object.isFrozen(o)) return o;
      Object.getOwnPropertyNames(o).forEach(function (k) {
        var v = o[k];
        if (v && typeof v === "object") deepFreeze(v);
      });
      return Object.freeze(o);
    }

    function isNonblankPrimitiveString(v) {
      return typeof v === "string" && v.trim().length > 0;
    }

    function isPrimitiveString(v) {
      return typeof v === "string";
    }

    function isFiniteNumber(v) {
      return typeof v === "number" && isFinite(v);
    }

    function isNonnegInt(v) {
      return (
        typeof v === "number" &&
        isFinite(v) &&
        Math.floor(v) === v &&
        v >= 0
      );
    }

    function isPositiveInt(v) {
      return (
        typeof v === "number" &&
        isFinite(v) &&
        Math.floor(v) === v &&
        v > 0
      );
    }

    function isPlainRecord(v) {
      if (v === null || typeof v !== "object") return false;
      if (Array.isArray(v)) return false;
      try {
        var proto = Object.getPrototypeOf(v);
        if (proto === null || proto === Object.prototype) return true;
        // Realm-agnostic: accept plain objects from another VM/window Object.
        if (proto && Object.getPrototypeOf(proto) === null) {
          return true;
        }
        return false;
      } catch (e) {
        return false;
      }
    }

    /** Stable host reason token: lowercase alnum plus _/- , max 64. */
    function isStableHostReason(v) {
      return typeof v === "string" && /^[a-z0-9_-]{1,64}$/.test(v);
    }

    /**
     * Local filesystem path for file-committed. Rejects control chars,
     * network scheme:// / scheme-relative URLs, and Cookie/Authorization syntax.
     */
    function isSafeLocalFilePath(v) {
      if (!isNonblankPrimitiveString(v)) return false;
      if (/[\u0000-\u001f\u007f]/.test(v)) return false;
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(v)) return false;
      if (/^\/\//.test(v)) return false;
      if (/Cookie\s*:/i.test(v)) return false;
      if (/Authorization\s*:/i.test(v)) return false;
      return true;
    }

    /**
     * Descriptor-safe own data read. Never invokes accessors.
     * Returns {ok:false} on missing/accessor/proxy failure without throwing.
     */
    function ownData(obj, key) {
      try {
        if (obj == null || (typeof obj !== "object" && typeof obj !== "function")) {
          return { ok: false };
        }
        var desc = Object.getOwnPropertyDescriptor(obj, key);
        if (!desc || desc.get || desc.set || !("value" in desc)) {
          return { ok: false };
        }
        return { ok: true, value: desc.value };
      } catch (e) {
        return { ok: false };
      }
    }

    /**
     * Own-key presence without invoking accessors. { present, data?, value? }
     * present+!data means accessor or non-data descriptor.
     */
    function ownKeyState(obj, key) {
      try {
        if (obj == null || (typeof obj !== "object" && typeof obj !== "function")) {
          return { present: false };
        }
        var desc = Object.getOwnPropertyDescriptor(obj, key);
        if (!desc) return { present: false };
        if (desc.get || desc.set || !("value" in desc)) {
          return { present: true, data: false };
        }
        return { present: true, data: true, value: desc.value };
      } catch (e) {
        return { present: false };
      }
    }

    function ignoreDecision() {
      return deepFreeze({ action: "ignore", invokeFirefox: false });
    }

    function ignoreLegacyDecision() {
      return deepFreeze({ action: "ignore-legacy", invokeFirefox: false });
    }

    var ALLOWED_PGET_STATUSES = Object.create(null);
    ALLOWED_PGET_STATUSES.completed = true;
    ALLOWED_PGET_STATUSES.failed = true;
    ALLOWED_PGET_STATUSES.cancelled = true;

    var ALLOWED_PGET_MODES = Object.create(null);
    ALLOWED_PGET_MODES["multi-range"] = true;
    ALLOWED_PGET_MODES["single-connection"] = true;

    var ALLOWED_PART_STATES = Object.create(null);
    ALLOWED_PART_STATES.empty = true;
    ALLOWED_PART_STATES.partial = true;
    ALLOWED_PART_STATES.committed = true;

    var KNOWN_FAILURE_CATEGORIES = Object.create(null);
    KNOWN_FAILURE_CATEGORIES.timeout = true;
    KNOWN_FAILURE_CATEGORIES.connection_reset = true;
    KNOWN_FAILURE_CATEGORIES.short_read = true;
    KNOWN_FAILURE_CATEGORIES.http_429 = true;
    KNOWN_FAILURE_CATEGORIES.http_5xx_temporary = true;
    KNOWN_FAILURE_CATEGORIES.range_unsupported = true;
    KNOWN_FAILURE_CATEGORIES.local_io = true;
    KNOWN_FAILURE_CATEGORIES.cancelled = true;
    KNOWN_FAILURE_CATEGORIES.permanent = true;

    function readNonblankOwnString(obj, key) {
      var r = ownData(obj, key);
      if (!r.ok || !isNonblankPrimitiveString(r.value)) return null;
      return r.value;
    }

    function cloneSixKeyIntent(intent, requireFirefoxTrue) {
      if (!intent || typeof intent !== "object") return null;

      var requested = ownData(intent, "requestedFilename");
      if (!requested.ok || !isNonblankPrimitiveString(requested.value)) return null;

      var dest = ownData(intent, "destinationDirectory");
      if (!dest.ok) return null;
      if (dest.value !== null && !isNonblankPrimitiveString(dest.value)) return null;

      var saveMode = ownData(intent, "saveMode");
      if (!saveMode.ok) return null;
      if (saveMode.value !== "default" && saveMode.value !== "save-as") return null;

      var firefox = ownData(intent, "userSelectedFirefox");
      if (!firefox.ok) return null;
      if (requireFirefoxTrue) {
        if (firefox.value !== true) return null;
      } else {
        if (firefox.value !== false) return null;
      }

      var token = ownData(intent, "userActionToken");
      if (!token.ok || !isNonblankPrimitiveString(token.value)) return null;

      var createdAt = ownData(intent, "createdAt");
      if (!createdAt.ok || !isPrimitiveString(createdAt.value)) return null;

      return deepFreeze({
        requestedFilename: requested.value,
        destinationDirectory: dest.value,
        saveMode: saveMode.value,
        userSelectedFirefox: firefox.value,
        userActionToken: token.value,
        createdAt: createdAt.value,
      });
    }

    /**
     * Normalize pget failureCategory after status/mode/part are validated.
     * rawCat is null or a primitive string (objects already rejected).
     */
    function normalizePgetFailureCategory(status, rawCat) {
      if (status === "completed") return null;
      if (status === "cancelled") return "cancelled";
      // failed
      if (isPrimitiveString(rawCat) && KNOWN_FAILURE_CATEGORIES[rawCat]) {
        return rawCat;
      }
      return "permanent";
    }

    function routePgetResult(message) {
      var id = readNonblankOwnString(message, "id");
      var attemptToken = readNonblankOwnString(message, "attemptToken");
      if (!id || !attemptToken) return ignoreDecision();

      var statusR = ownData(message, "status");
      var modeR = ownData(message, "mode");
      var partR = ownData(message, "partState");
      if (!statusR.ok || !modeR.ok || !partR.ok) return ignoreDecision();

      // Primitive string only — never property-index with objects (no coercion).
      var status = statusR.value;
      var mode = modeR.value;
      var partState = partR.value;
      if (!isPrimitiveString(status) || !ALLOWED_PGET_STATUSES[status]) {
        return ignoreDecision();
      }
      if (!isPrimitiveString(mode) || !ALLOWED_PGET_MODES[mode]) {
        return ignoreDecision();
      }
      if (!isPrimitiveString(partState) || !ALLOWED_PART_STATES[partState]) {
        return ignoreDecision();
      }

      // failureCategory: absent → null; present accessor/non-data → ignore;
      // null or primitive string only — never coerce objects.
      var catState = ownKeyState(message, "failureCategory");
      var rawCategory;
      if (!catState.present) {
        rawCategory = null;
      } else if (!catState.data) {
        return ignoreDecision();
      } else if (catState.value === null) {
        rawCategory = null;
      } else if (isPrimitiveString(catState.value)) {
        rawCategory = catState.value;
      } else {
        return ignoreDecision();
      }

      var failureCategory = normalizePgetFailureCategory(status, rawCategory);

      // Optional saved-path metadata: completed may omit both (compat).
      // If either is present both are required and validated; failed/cancelled
      // metadata is ignored. Accessors and one-sided forms fail closed.
      var fileState = ownKeyState(message, "file");
      var bytesState = ownKeyState(message, "bytes");
      var savedFile = null;
      var savedBytes = null;
      var hasFile = false;
      var hasBytes = false;
      if (fileState.present) {
        if (!fileState.data) return ignoreDecision();
        hasFile = true;
      }
      if (bytesState.present) {
        if (!bytesState.data) return ignoreDecision();
        hasBytes = true;
      }
      if (status === "completed" && (hasFile || hasBytes)) {
        if (!hasFile || !hasBytes) return ignoreDecision();
        if (!isSafeLocalFilePath(fileState.value)) return ignoreDecision();
        if (!isNonnegInt(bytesState.value)) return ignoreDecision();
        savedFile = fileState.value;
        savedBytes = bytesState.value;
      }
      // failed/cancelled: ignore file/bytes metadata (do not project).

      if (
        status === "failed" &&
        mode === "multi-range" &&
        failureCategory === "range_unsupported" &&
        partState === "empty"
      ) {
        return deepFreeze({
          action: "start-single-connection",
          invokeFirefox: false,
          jobId: id,
          attemptToken: attemptToken,
          status: "failed",
          mode: "multi-range",
          failureCategory: "range_unsupported",
          partState: "empty",
        });
      }

      var result = {
        action: "transport-result",
        invokeFirefox: false,
        jobId: id,
        attemptToken: attemptToken,
        status: status,
        mode: mode,
        failureCategory: failureCategory,
        partState: partState,
      };
      if (savedFile !== null) {
        result.file = savedFile;
        result.bytes = savedBytes;
      }
      return deepFreeze(result);
    }

    function routePgetProgress(message) {
      // Exact own-data nonblank `id` only — never fall back to jobId.
      var id = readNonblankOwnString(message, "id");
      var attemptToken = readNonblankOwnString(message, "attemptToken");
      if (!id || !attemptToken) return ignoreDecision();

      var bytesR = ownData(message, "bytes");
      var totalR = ownData(message, "total");
      if (!bytesR.ok || !totalR.ok) return ignoreDecision();
      if (!isNonnegInt(bytesR.value) || !isNonnegInt(totalR.value)) {
        return ignoreDecision();
      }
      if (bytesR.value > totalR.value) return ignoreDecision();

      return deepFreeze({
        action: "transport-progress",
        invokeFirefox: false,
        jobId: id,
        attemptToken: attemptToken,
        bytes: bytesR.value,
        total: totalR.value,
      });
    }

    function routePgetLimitAck(message) {
      // Exact own-data nonblank `id` only — never fall back to jobId.
      var id = readNonblankOwnString(message, "id");
      var attemptToken = readNonblankOwnString(message, "attemptToken");
      if (!id || !attemptToken) return ignoreDecision();

      var genR = ownData(message, "providerGeneration");
      var limR = ownData(message, "maxConnections");
      if (!genR.ok || !limR.ok) return ignoreDecision();
      if (!isNonnegInt(genR.value) || !isNonnegInt(limR.value)) {
        return ignoreDecision();
      }

      return deepFreeze({
        action: "native-limit-ack",
        invokeFirefox: false,
        jobId: id,
        attemptToken: attemptToken,
        providerGeneration: genR.value,
        maxConnections: limR.value,
      });
    }

    function routeUseFirefox(message) {
      var jobId = readNonblankOwnString(message, "jobId");
      if (!jobId) jobId = readNonblankOwnString(message, "id");
      if (!jobId) return ignoreDecision();

      var intentR = ownData(message, "intent");
      if (!intentR.ok || !intentR.value || typeof intentR.value !== "object") {
        return ignoreDecision();
      }
      var intent = cloneSixKeyIntent(intentR.value, true);
      if (!intent) return ignoreDecision();

      return deepFreeze({
        action: "request-firefox-handoff",
        invokeFirefox: false,
        jobId: jobId,
        intent: intent,
      });
    }

    function routeFileSinkMessage(message, type) {
      var out = { type: type };

      if (type === "file-opened") {
        var sinkOpen = readNonblankOwnString(message, "sinkId");
        var jobOpen = readNonblankOwnString(message, "jobId");
        var tokOpen = readNonblankOwnString(message, "attemptToken");
        if (!sinkOpen || !jobOpen || !tokOpen) return ignoreDecision();
        out.sinkId = sinkOpen;
        out.jobId = jobOpen;
        out.attemptToken = tokOpen;
      } else if (type === "file-ack" || type === "file-chunk-ack") {
        var sinkAck = readNonblankOwnString(message, "sinkId");
        var seqR = ownData(message, "seq");
        if (!sinkAck || !seqR.ok || !isNonnegInt(seqR.value)) return ignoreDecision();
        out.sinkId = sinkAck;
        out.seq = seqR.value;
        var jobAck = ownData(message, "jobId");
        if (jobAck.ok && isNonblankPrimitiveString(jobAck.value)) out.jobId = jobAck.value;
        var tokAck = ownData(message, "attemptToken");
        if (tokAck.ok && isNonblankPrimitiveString(tokAck.value)) {
          out.attemptToken = tokAck.value;
        }
      } else if (type === "file-committed") {
        var sinkC = readNonblankOwnString(message, "sinkId");
        var fileR = ownData(message, "file");
        var bytesR = ownData(message, "bytes");
        if (!sinkC) return ignoreDecision();
        if (!fileR.ok || !isSafeLocalFilePath(fileR.value)) return ignoreDecision();
        if (!bytesR.ok || !isNonnegInt(bytesR.value)) return ignoreDecision();
        out.sinkId = sinkC;
        out.file = fileR.value;
        out.bytes = bytesR.value;
        var jobC = ownData(message, "jobId");
        if (jobC.ok && isNonblankPrimitiveString(jobC.value)) out.jobId = jobC.value;
        var tokC = ownData(message, "attemptToken");
        if (tokC.ok && isNonblankPrimitiveString(tokC.value)) out.attemptToken = tokC.value;
      } else if (type === "file-aborted") {
        var sinkA = readNonblankOwnString(message, "sinkId");
        if (!sinkA) return ignoreDecision();
        out.sinkId = sinkA;
        var jobA = ownData(message, "jobId");
        if (jobA.ok && isNonblankPrimitiveString(jobA.value)) out.jobId = jobA.value;
        var tokA = ownData(message, "attemptToken");
        if (tokA.ok && isNonblankPrimitiveString(tokA.value)) out.attemptToken = tokA.value;
        var reasonA = ownData(message, "reason");
        if (reasonA.ok && isStableHostReason(reasonA.value)) out.reason = reasonA.value;
      } else if (type === "file-error") {
        var jobE = readNonblankOwnString(message, "jobId");
        var tokE = readNonblankOwnString(message, "attemptToken");
        // Open-phase errors carry job+token; streaming may also carry sinkId.
        // Require at least one identity path: (jobId+attemptToken) or sinkId.
        var sinkE = ownData(message, "sinkId");
        var sinkVal =
          sinkE.ok && isNonblankPrimitiveString(sinkE.value) ? sinkE.value : null;
        if ((!jobE || !tokE) && !sinkVal) return ignoreDecision();
        if (jobE) out.jobId = jobE;
        if (tokE) out.attemptToken = tokE;
        if (sinkVal) out.sinkId = sinkVal;
        // Only exact local_io category; omit invalid. No status/path/bytes.
        var catE = ownData(message, "failureCategory");
        if (catE.ok && catE.value === "local_io") {
          out.failureCategory = "local_io";
        }
        var reasonE = ownData(message, "reason");
        if (reasonE.ok && isStableHostReason(reasonE.value)) {
          out.reason = reasonE.value;
        }
      } else {
        return ignoreDecision();
      }

      return deepFreeze({
        action: "file-sink-message",
        invokeFirefox: false,
        message: deepFreeze(out),
      });
    }

    function routeNativeMessage(message) {
      try {
        if (!message || typeof message !== "object") return ignoreDecision();
        var typeR = ownData(message, "type");
        if (!typeR.ok || !isPrimitiveString(typeR.value)) return ignoreDecision();
        var type = typeR.value;

        if (type === "pget-result") return routePgetResult(message);
        if (type === "pget-progress") return routePgetProgress(message);
        if (type === "pget-limit-ack") return routePgetLimitAck(message);
        if (type === "pget-fallback") return ignoreLegacyDecision();
        if (type === "use-firefox") return routeUseFirefox(message);
        if (
          type === "file-opened" ||
          type === "file-ack" ||
          type === "file-chunk-ack" ||
          type === "file-committed" ||
          type === "file-aborted" ||
          type === "file-error"
        ) {
          return routeFileSinkMessage(message, type);
        }
        return ignoreDecision();
      } catch (e) {
        return ignoreDecision();
      }
    }

    function genericTypeError() {
      return new TypeError("invalid download message");
    }

    function requireOwnData(obj, key) {
      var r = ownData(obj, key);
      if (!r.ok) throw genericTypeError();
      return r.value;
    }

    /**
     * Item field allowlist with per-field types.
     * detectionId/tabId: finite nonnegative integers.
     * live: boolean only.
     * other allowlisted fields: null | primitive string | finite number.
     * No booleans/objects for filename/URL/kind/provider fields.
     */
    function normalizeItem(item) {
      if (!isPlainRecord(item)) throw genericTypeError();

      var out = {};
      var stringOrNumberKeys = [
        "id",
        "kind",
        "mode",
        "url",
        "pageUrl",
        "proposedFilename",
        "name",
        "ext",
        "mime",
        "providerKey",
        "knownExtension",
        "sourceContextId",
      ];
      for (var i = 0; i < stringOrNumberKeys.length; i++) {
        var k = stringOrNumberKeys[i];
        var r = ownData(item, k);
        if (!r.ok) continue;
        var v = r.value;
        if (v === null || isPrimitiveString(v)) {
          out[k] = v;
        } else if (isFiniteNumber(v)) {
          out[k] = v;
        } else {
          throw genericTypeError();
        }
      }

      // tabId: finite nonnegative integer only when present as own data.
      var tabState = ownKeyState(item, "tabId");
      if (tabState.present) {
        if (!tabState.data || !isNonnegInt(tabState.value)) throw genericTypeError();
        out.tabId = tabState.value;
      }

      // detectionId: finite nonnegative integer; present invalid/accessor fails.
      var detState = ownKeyState(item, "detectionId");
      if (detState.present) {
        if (!detState.data || !isNonnegInt(detState.value)) throw genericTypeError();
        out.detectionId = detState.value;
      }

      var liveState = ownKeyState(item, "live");
      if (liveState.present) {
        if (!liveState.data || typeof liveState.value !== "boolean") {
          throw genericTypeError();
        }
        out.live = liveState.value;
      }

      return deepFreeze(out);
    }

    function normalizeSelectionFields(message) {
      var variantUrl = null;
      var variantId = null;
      var ytHeight = null;
      var ytAudioOnly = false;

      var vu = ownData(message, "variantUrl");
      if (vu.ok) {
        if (vu.value === null) {
          variantUrl = null;
        } else if (isNonblankPrimitiveString(vu.value)) {
          variantUrl = vu.value;
        } else {
          throw genericTypeError();
        }
      }

      var vi = ownData(message, "variantId");
      if (vi.ok) {
        if (vi.value === null) {
          variantId = null;
        } else if (isPrimitiveString(vi.value) || isFiniteNumber(vi.value)) {
          variantId = vi.value;
        } else {
          throw genericTypeError();
        }
      }

      var yh = ownData(message, "ytHeight");
      if (yh.ok) {
        if (yh.value === null) {
          ytHeight = null;
        } else if (isFiniteNumber(yh.value)) {
          ytHeight = yh.value;
        } else {
          throw genericTypeError();
        }
      }

      var ya = ownData(message, "ytAudioOnly");
      if (ya.ok) {
        if (typeof ya.value !== "boolean") throw genericTypeError();
        ytAudioOnly = ya.value;
      }

      return {
        variantUrl: variantUrl,
        variantId: variantId,
        ytHeight: ytHeight,
        ytAudioOnly: ytAudioOnly,
      };
    }

    function normalizeDownloadRequest(message) {
      // Input/reflection validation — always generic TypeError, no hostile text.
      if (!message || typeof message !== "object") throw genericTypeError();

      var type = requireOwnData(message, "type");
      if (type !== "download" && type !== "save-as-download") {
        throw genericTypeError();
      }

      var tabId = requireOwnData(message, "tabId");
      if (!isNonnegInt(tabId)) throw genericTypeError();

      var itemRaw = requireOwnData(message, "item");
      var item = normalizeItem(itemRaw);

      var sel = normalizeSelectionFields(message);

      var intentR = ownData(message, "intent");
      var intent;
      if (!intentR.ok || intentR.value === null || intentR.value === undefined) {
        var topToken = ownData(message, "userActionToken");
        if (!topToken.ok || !isNonblankPrimitiveString(topToken.value)) {
          throw genericTypeError();
        }
        var proposed = null;
        if (isNonblankPrimitiveString(item.proposedFilename)) {
          proposed = item.proposedFilename;
        } else if (isNonblankPrimitiveString(item.name)) {
          proposed = item.name;
        } else {
          throw genericTypeError();
        }
        // Sanitized inputs only — dependency load/runtime exceptions propagate by identity.
        var IntentApi = resolveDownloadIntent();
        var created = IntentApi.createDefaultIntent({
          proposedFilename: proposed,
          userActionToken: topToken.value,
          destinationDirectory: null,
        });
        // Fresh exact six-key clone so caller mutation of dependency output cannot alias.
        intent = deepFreeze({
          requestedFilename: created.requestedFilename,
          destinationDirectory:
            created.destinationDirectory === undefined
              ? null
              : created.destinationDirectory,
          saveMode: created.saveMode,
          userSelectedFirefox: created.userSelectedFirefox,
          userActionToken: created.userActionToken,
          createdAt: created.createdAt,
        });
      } else {
        intent = cloneSixKeyIntent(intentR.value, false);
        if (!intent) throw genericTypeError();
      }

      return deepFreeze({
        type: "download",
        tabId: tabId,
        item: item,
        intent: intent,
        variantUrl: sel.variantUrl,
        variantId: sel.variantId,
        ytHeight: sel.ytHeight,
        ytAudioOnly: sel.ytAudioOnly,
      });
    }

    function readExactSixKeyIntent(intent) {
      var cloned = cloneSixKeyIntent(intent, false);
      if (cloned) return cloned;
      // buildNativeStartPayload accepts Firefox intents too for filename/dir only.
      cloned = cloneSixKeyIntent(intent, true);
      if (cloned) return cloned;
      // Also accept any boolean userSelectedFirefox via looser read for payload build:
      // filename/dir are the only fields file-sink needs.
      if (!intent || typeof intent !== "object") throw genericTypeError();
      var requested = ownData(intent, "requestedFilename");
      if (!requested.ok || !isNonblankPrimitiveString(requested.value)) {
        throw genericTypeError();
      }
      var dest = ownData(intent, "destinationDirectory");
      if (!dest.ok) throw genericTypeError();
      if (dest.value !== null && !isNonblankPrimitiveString(dest.value)) {
        throw genericTypeError();
      }
      var saveMode = ownData(intent, "saveMode");
      if (!saveMode.ok) throw genericTypeError();
      if (saveMode.value !== "default" && saveMode.value !== "save-as") {
        throw genericTypeError();
      }
      var firefox = ownData(intent, "userSelectedFirefox");
      if (!firefox.ok || typeof firefox.value !== "boolean") throw genericTypeError();
      var token = ownData(intent, "userActionToken");
      if (!token.ok || !isNonblankPrimitiveString(token.value)) throw genericTypeError();
      var createdAt = ownData(intent, "createdAt");
      if (!createdAt.ok || !isPrimitiveString(createdAt.value)) throw genericTypeError();
      return deepFreeze({
        requestedFilename: requested.value,
        destinationDirectory: dest.value,
        saveMode: saveMode.value,
        userSelectedFirefox: firefox.value,
        userActionToken: token.value,
        createdAt: createdAt.value,
      });
    }

    function readOptionalOwnValue(input, key) {
      var state = ownKeyState(input, key);
      if (!state.present) return { present: false };
      if (!state.data) throw genericTypeError();
      return { present: true, value: state.value };
    }

    /** Reject C0, DEL, and C1 controls in HTTP-context strings. */
    function isSafeHttpContextString(v) {
      return typeof v === "string" && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
    }

    /**
     * A pget/pget-single url the helper will spawn a downloader on: nonblank,
     * trim-stable, control-free, and an absolute http(s) URL. Decides
     * accept/reject only — callers keep the exact accepted spelling.
     */
    function isAbsoluteHttpUrl(v) {
      if (!isNonblankPrimitiveString(v)) return false;
      if (v.trim() !== v || !isSafeHttpContextString(v)) return false;
      if (!/^https?:\/\//i.test(v)) return false;
      // URL is absent from some classic-script/test realms; the scheme test
      // above already decided the lane, so treat a missing URL as "accepted".
      if (typeof URL !== "function") return true;
      var parsed;
      try {
        parsed = new URL(v);
      } catch (e) {
        return false;
      }
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    }

    /**
     * Descriptor-safe mirrors snapshot for start payloads.
     * Absent → undefined. null → undefined (omit). Non-array present → generic TypeError.
     * Dense own-data entries only; sparse/accessor/hostile length → generic TypeError.
     * Own-data blank/non-string entries are omitted (closed skip contract).
     * Returns a fresh dense array of unique nonblank strings (no primary).
     */
    function snapshotOptionalMirrors(input) {
      var m = readOptionalOwnValue(input, "mirrors");
      if (!m.present) return undefined;
      var mirrors = m.value;
      if (mirrors == null) return undefined;
      if (!Array.isArray(mirrors)) throw genericTypeError();

      var lenState = ownKeyState(mirrors, "length");
      if (!lenState.present || !lenState.data || !isNonnegInt(lenState.value)) {
        throw genericTypeError();
      }
      var len = lenState.value;
      var out = [];
      var seen = Object.create(null);
      for (var i = 0; i < len; i++) {
        var entry = ownData(mirrors, String(i));
        if (!entry.ok) throw genericTypeError();
        var v = entry.value;
        if (typeof v !== "string" || !isNonblankPrimitiveString(v)) continue;
        if (seen[v]) continue;
        seen[v] = true;
        out.push(v);
      }
      return out;
    }

    /**
     * Only ABSENT referer/userAgent may normalize later to "".
     * Present values must be primitive strings without C0/C1/DEL controls.
     * Present null/undefined/object/accessor → generic TypeError.
     * Returns { present:false } or { present:true, value:string }.
     */
    function readOptionalHttpContext(input, key) {
      var r = readOptionalOwnValue(input, key);
      if (!r.present) return { present: false };
      if (!isSafeHttpContextString(r.value)) throw genericTypeError();
      return { present: true, value: r.value };
    }

    /**
     * Snapshot and validate effectiveDestinationDirectory before dependency resolve.
     * Absent → undefined. Present must be null or a nonblank primitive string
     * (explicit undefined / blank / object / accessor invalid).
     * When intent destination is non-null, a present non-null effective must equal it.
     * When intent destination is null, present non-null effective may supply fallback.
     */
    function readOptionalEffectiveDir(input, intentDestinationDirectory) {
      var r = readOptionalOwnValue(input, "effectiveDestinationDirectory");
      if (!r.present) return undefined;
      var effective = r.value;
      if (effective === null) return null;
      if (!isNonblankPrimitiveString(effective)) throw genericTypeError();
      if (
        intentDestinationDirectory !== null &&
        effective !== intentDestinationDirectory
      ) {
        throw genericTypeError();
      }
      return effective;
    }

    function requireProviderGeneration(input) {
      var gen = requireOwnData(input, "providerGeneration");
      if (!isNonnegInt(gen)) throw genericTypeError();
      return gen;
    }

    function assignOptionalHttpFields(target, referer, userAgent) {
      if (referer.present) target.referer = referer.value;
      if (userAgent.present) target.userAgent = userAgent.value;
    }

    function buildNativeStartPayload(input) {
      // Input/reflection validation — always generic TypeError.
      // Fully snapshot/sanitize selected kind fields BEFORE resolving dependencies
      // so malformed caller input never leaks dependency load/runtime errors.
      if (!input || typeof input !== "object") throw genericTypeError();

      var kind = requireOwnData(input, "kind");
      if (
        kind !== "pget" &&
        kind !== "pget-single" &&
        kind !== "file-open" &&
        kind !== "pget-set-limit" &&
        kind !== "pget-cancel"
      ) {
        throw genericTypeError();
      }

      var jobId = requireOwnData(input, "jobId");
      if (!isNonblankPrimitiveString(jobId)) throw genericTypeError();

      var attemptToken = requireOwnData(input, "attemptToken");
      if (!isNonblankPrimitiveString(attemptToken)) throw genericTypeError();

      // Control commands: no intent/URL required; always fence with attemptToken.
      if (kind === "pget-set-limit") {
        var setGen = requireProviderGeneration(input);
        var setLim = requireOwnData(input, "maxConnections");
        if (!isNonnegInt(setLim)) throw genericTypeError();
        // Sanitized only — dependency exceptions propagate by identity.
        return resolveFileSinkProtocol().buildPgetSetLimitCmd({
          jobId: jobId,
          attemptToken: attemptToken,
          providerGeneration: setGen,
          maxConnections: setLim,
        });
      }

      if (kind === "pget-cancel") {
        return resolveFileSinkProtocol().buildPgetCancelCmd({
          jobId: jobId,
          attemptToken: attemptToken,
        });
      }

      var intentRaw = requireOwnData(input, "intent");
      var intent = readExactSixKeyIntent(intentRaw);
      // Validate destination override before any file-sink dependency resolve.
      var effectiveDir = readOptionalEffectiveDir(
        input,
        intent.destinationDirectory
      );

      if (kind === "pget") {
        var url = requireOwnData(input, "url");
        if (!isAbsoluteHttpUrl(url)) throw genericTypeError();
        var maxConnections = requireOwnData(input, "maxConnections");
        if (!isPositiveInt(maxConnections)) throw genericTypeError();
        var pgetGen = requireProviderGeneration(input);
        var pgetMirrors = snapshotOptionalMirrors(input);
        var pgetReferer = readOptionalHttpContext(input, "referer");
        var pgetUa = readOptionalHttpContext(input, "userAgent");
        var pgetInput = {
          jobId: jobId,
          attemptToken: attemptToken,
          intent: intent,
          url: url,
          maxConnections: maxConnections,
          providerGeneration: pgetGen,
        };
        if (pgetMirrors !== undefined) pgetInput.mirrors = pgetMirrors;
        if (effectiveDir !== undefined) {
          pgetInput.effectiveDestinationDirectory = effectiveDir;
        }
        assignOptionalHttpFields(pgetInput, pgetReferer, pgetUa);
        return resolveFileSinkProtocol().buildPgetCmd(pgetInput);
      }

      if (kind === "pget-single") {
        var singleUrl = requireOwnData(input, "url");
        if (!isAbsoluteHttpUrl(singleUrl)) throw genericTypeError();
        var singleGen = requireProviderGeneration(input);
        var singleMirrors = snapshotOptionalMirrors(input);
        var singleReferer = readOptionalHttpContext(input, "referer");
        var singleUa = readOptionalHttpContext(input, "userAgent");
        var singleInput = {
          jobId: jobId,
          attemptToken: attemptToken,
          intent: intent,
          url: singleUrl,
          providerGeneration: singleGen,
        };
        if (singleMirrors !== undefined) singleInput.mirrors = singleMirrors;
        if (effectiveDir !== undefined) {
          singleInput.effectiveDestinationDirectory = effectiveDir;
        }
        assignOptionalHttpFields(singleInput, singleReferer, singleUa);
        return resolveFileSinkProtocol().buildPgetSingleCmd(singleInput);
      }

      // file-open — never include media URL or userActionToken in host command.
      var openInput = {
        jobId: jobId,
        attemptToken: attemptToken,
        requestedFilename: intent.requestedFilename,
        destinationDirectory: intent.destinationDirectory,
      };
      if (effectiveDir !== undefined) {
        openInput.effectiveDestinationDirectory = effectiveDir;
      }
      var session = resolveFileSinkProtocol().createFileSinkSession(openInput);
      var openCmd = session.openCmd();
      if (!openCmd) throw genericTypeError();
      return openCmd;
    }

    return Object.freeze({
      routeNativeMessage: routeNativeMessage,
      normalizeDownloadRequest: normalizeDownloadRequest,
      buildNativeStartPayload: buildNativeStartPayload,
    });
  }
);
