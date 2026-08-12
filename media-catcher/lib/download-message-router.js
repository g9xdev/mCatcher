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
          // Another realm's Object.prototype ends the chain at null.
          return true;
        }
        return false;
      } catch (e) {
        return false;
      }
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

    function readNonblankOwnString(obj, key) {
      var r = ownData(obj, key);
      if (!r.ok || !isNonblankPrimitiveString(r.value)) return null;
      return r.value;
    }

    function readPrimitiveOrNull(obj, key, predicate) {
      var r = ownData(obj, key);
      if (!r.ok) return { ok: false };
      if (r.value === null) return { ok: true, value: null };
      if (!predicate(r.value)) return { ok: false };
      return { ok: true, value: r.value };
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

    function routePgetResult(message) {
      var id = readNonblankOwnString(message, "id");
      var attemptToken = readNonblankOwnString(message, "attemptToken");
      if (!id || !attemptToken) return ignoreDecision();

      var statusR = ownData(message, "status");
      var modeR = ownData(message, "mode");
      var partR = ownData(message, "partState");
      if (!statusR.ok || !modeR.ok || !partR.ok) return ignoreDecision();
      if (!ALLOWED_PGET_STATUSES[statusR.value]) return ignoreDecision();
      if (!ALLOWED_PGET_MODES[modeR.value]) return ignoreDecision();
      if (!ALLOWED_PART_STATES[partR.value]) return ignoreDecision();

      var catR = ownData(message, "failureCategory");
      // failureCategory may be absent only as null for completed-like terminals;
      // require own data null or primitive string when present for allowlist copy.
      var failureCategory;
      if (!catR.ok) {
        // Missing own data property — treat as absent/null only for structural copy.
        failureCategory = null;
      } else if (catR.value === null) {
        failureCategory = null;
      } else if (isPrimitiveString(catR.value)) {
        failureCategory = catR.value;
      } else {
        return ignoreDecision();
      }

      if (
        statusR.value === "failed" &&
        modeR.value === "multi-range" &&
        failureCategory === "range_unsupported" &&
        partR.value === "empty"
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

      return deepFreeze({
        action: "transport-result",
        invokeFirefox: false,
        jobId: id,
        attemptToken: attemptToken,
        status: statusR.value,
        mode: modeR.value,
        failureCategory: failureCategory,
        partState: partR.value,
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
        if (!fileR.ok || !isNonblankPrimitiveString(fileR.value)) return ignoreDecision();
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
        if (reasonA.ok && isPrimitiveString(reasonA.value)) out.reason = reasonA.value;
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
        var catE = ownData(message, "failureCategory");
        if (catE.ok && isPrimitiveString(catE.value)) out.failureCategory = catE.value;
        var reasonE = ownData(message, "reason");
        if (reasonE.ok && isPrimitiveString(reasonE.value)) out.reason = reasonE.value;
        var statusE = ownData(message, "status");
        if (statusE.ok && isPrimitiveString(statusE.value)) out.status = statusE.value;
        var pathE = ownData(message, "path");
        if (pathE.ok && isPrimitiveString(pathE.value)) out.path = pathE.value;
        var bytesE = ownData(message, "bytes");
        if (bytesE.ok && isNonnegInt(bytesE.value)) out.bytes = bytesE.value;
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

    function normalizeItem(item) {
      if (!isPlainRecord(item)) throw genericTypeError();

      var out = {};
      var keys = [
        "id",
        "tabId",
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
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var r = ownData(item, k);
        if (!r.ok) continue;
        var v = r.value;
        if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          // Reject non-finite numbers; keep primitive/null only.
          if (typeof v === "number" && !isFinite(v)) throw genericTypeError();
          out[k] = v;
        } else {
          throw genericTypeError();
        }
      }

      var liveR = ownData(item, "live");
      if (liveR.ok) {
        if (typeof liveR.value !== "boolean") throw genericTypeError();
        out.live = liveR.value;
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
      try {
        if (!message || typeof message !== "object") throw genericTypeError();

        var type = requireOwnData(message, "type");
        if (type !== "download" && type !== "save-as-download") {
          throw genericTypeError();
        }

        var tabId = requireOwnData(message, "tabId");
        if (!isNonnegInt(tabId)) throw genericTypeError();

        var itemRaw = requireOwnData(message, "item");
        var item = normalizeItem(itemRaw);

        var intent;
        var intentR = ownData(message, "intent");
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
          var IntentApi = resolveDownloadIntent();
          intent = IntentApi.createDefaultIntent({
            proposedFilename: proposed,
            userActionToken: topToken.value,
            destinationDirectory: null,
          });
          // Fresh exact six-key clone so caller mutation of dependency output cannot alias.
          intent = deepFreeze({
            requestedFilename: intent.requestedFilename,
            destinationDirectory:
              intent.destinationDirectory === undefined
                ? null
                : intent.destinationDirectory,
            saveMode: intent.saveMode,
            userSelectedFirefox: intent.userSelectedFirefox,
            userActionToken: intent.userActionToken,
            createdAt: intent.createdAt,
          });
        } else {
          intent = cloneSixKeyIntent(intentR.value, false);
          if (!intent) throw genericTypeError();
        }

        var sel = normalizeSelectionFields(message);

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
      } catch (e) {
        if (e && e.name === "TypeError") {
          // Propagate dependency TypeErrors that are already generic enough, but
          // never rethrow hostile Proxy/trap text from accessors.
          if (
            e.message === "invalid download message" ||
            (typeof e.message === "string" &&
              e.message.indexOf("must be") !== -1 &&
              e.message.indexOf("SECRET") === -1)
          ) {
            // Re-wrap dependency validation as generic unless it is our own.
            if (e.message === "invalid download message") throw e;
          }
        }
        // Dependency load failures (Error from require) must propagate unchanged.
        if (
          e &&
          typeof e.message === "string" &&
          (e.message.indexOf("simulated ") === 0 ||
            e.message.indexOf("Cannot find module") !== -1 ||
            e.message.indexOf("is required for DownloadMessageRouter") !== -1 ||
            e.message.indexOf("McDownloadIntent") !== -1 ||
            e.message.indexOf("McFilenameRanker") !== -1)
        ) {
          throw e;
        }
        if (e && e.name === "Error" && typeof e.message === "string") {
          // Propagate plain dependency failures (createDefaultIntent validation, require).
          if (
            e.message.indexOf("proposedFilename") !== -1 ||
            e.message.indexOf("userActionToken") !== -1 ||
            e.message.indexOf("load failure") !== -1
          ) {
            throw e;
          }
        }
        throw genericTypeError();
      }
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

    function buildNativeStartPayload(input) {
      try {
        if (!input || typeof input !== "object") throw genericTypeError();

        var kind = requireOwnData(input, "kind");
        if (kind !== "pget" && kind !== "pget-single" && kind !== "file-open") {
          throw genericTypeError();
        }

        var jobId = requireOwnData(input, "jobId");
        if (!isNonblankPrimitiveString(jobId)) throw genericTypeError();

        var attemptToken = requireOwnData(input, "attemptToken");
        if (!isNonblankPrimitiveString(attemptToken)) throw genericTypeError();

        var intentRaw = requireOwnData(input, "intent");
        var intent = readExactSixKeyIntent(intentRaw);

        var Protocol = resolveFileSinkProtocol();

        if (kind === "pget") {
          var url = requireOwnData(input, "url");
          if (!isNonblankPrimitiveString(url)) throw genericTypeError();
          var maxConnections = requireOwnData(input, "maxConnections");
          if (!isPositiveInt(maxConnections)) throw genericTypeError();
          return Protocol.buildPgetCmd({
            jobId: jobId,
            attemptToken: attemptToken,
            intent: intent,
            url: url,
            maxConnections: maxConnections,
          });
        }

        if (kind === "pget-single") {
          var urlSingle = requireOwnData(input, "url");
          if (!isNonblankPrimitiveString(urlSingle)) throw genericTypeError();
          return Protocol.buildPgetSingleCmd({
            jobId: jobId,
            attemptToken: attemptToken,
            intent: intent,
            url: urlSingle,
          });
        }

        // file-open — never include media URL or userActionToken in host command.
        var session = Protocol.createFileSinkSession({
          jobId: jobId,
          attemptToken: attemptToken,
          requestedFilename: intent.requestedFilename,
          destinationDirectory: intent.destinationDirectory,
        });
        var openCmd = session.openCmd();
        if (!openCmd) throw genericTypeError();
        return openCmd;
      } catch (e) {
        // Propagate dependency load failures unchanged.
        if (
          e &&
          typeof e.message === "string" &&
          (e.message.indexOf("simulated ") === 0 ||
            e.message.indexOf("Cannot find module") !== -1 ||
            e.message.indexOf("is required for DownloadMessageRouter") !== -1 ||
            e.message.indexOf("McFileSinkProtocol") !== -1 ||
            e.message.indexOf("load failure") !== -1)
        ) {
          throw e;
        }
        // Propagate protocol TypeErrors (missing filename, bad maxConnections, etc.).
        if (e && e.name === "TypeError") {
          throw e;
        }
        throw genericTypeError();
      }
    }

    return Object.freeze({
      routeNativeMessage: routeNativeMessage,
      normalizeDownloadRequest: normalizeDownloadRequest,
      buildNativeStartPayload: buildNativeStartPayload,
    });
  }
);
