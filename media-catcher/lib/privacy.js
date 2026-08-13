/*
 * privacy.js — allowlist projectors, ephemeral request context, log redaction.
 * Dual-export: CommonJS module.exports and classic-script global McPrivacy.
 * Never spreads/enumerates jobs. Never persists URLs, headers, cookies, or tokens.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.McPrivacy = api;
})(
  typeof self !== "undefined" ? self :
  (typeof globalThis !== "undefined" ? globalThis : this),
  function () {
    "use strict";

    // Null-prototype set: only exact own keys are terminal. Object.prototype
    // names (constructor, toString, …) must never count as terminal.
    var TERMINAL_STATES = Object.create(null);
    TERMINAL_STATES.completed = true;
    TERMINAL_STATES.failed = true;
    TERMINAL_STATES.cancelled = true;
    TERMINAL_STATES.handed_to_firefox = true;

    function isTerminalState(state) {
      return typeof state === "string" &&
        Object.prototype.hasOwnProperty.call(TERMINAL_STATES, state);
    }

    /** Module-private: ephemeral objects already cleared on a terminal transition. */
    var clearedEphemerals = typeof WeakSet === "function" ? new WeakSet() : null;
    // Fallback for environments without WeakSet (should not occur in modern FF/Node).
    var clearedFallback = [];

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

    function isFiniteNumber(v) {
      return typeof v === "number" && isFinite(v);
    }

    function isFiniteNonnegNumber(v) {
      return isFiniteNumber(v) && v >= 0;
    }

    function isPlainRecord(v) {
      if (v === null || typeof v !== "object") return false;
      if (Array.isArray(v)) return false;
      try {
        var proto = Object.getPrototypeOf(v);
        return proto === Object.prototype || proto === null;
      } catch (e) {
        // Hostile Proxy getPrototypeOf — fail closed without echoing trap text.
        return false;
      }
    }

    /**
     * Copy only enumerable own primitive-string name/value pairs.
     * Reject own symbols, accessors, non-enumerable props, non-string values,
     * or any reflection failure. Never rethrows hostile trap messages.
     */
    function ownDataStringProps(record) {
      try {
        var symbols = Object.getOwnPropertySymbols(record);
        if (symbols.length > 0) {
          throw new TypeError("requestHeaders must not include symbol keys");
        }
        // All own string keys (incl. non-enumerable) — any non-enumerable/accessor rejects.
        var names = Object.getOwnPropertyNames(record);
        var out = Object.create(null);
        for (var i = 0; i < names.length; i++) {
          var k = names[i];
          if (typeof k !== "string") {
            throw new TypeError("requestHeaders names must be primitive strings");
          }
          var desc = Object.getOwnPropertyDescriptor(record, k);
          if (!desc || desc.get || desc.set || !("value" in desc)) {
            throw new TypeError("requestHeaders entries must be own primitive strings");
          }
          if (!desc.enumerable) {
            throw new TypeError("requestHeaders entries must be enumerable own data");
          }
          if (typeof desc.value !== "string") {
            throw new TypeError("requestHeaders entries must be own primitive strings");
          }
          out[k] = desc.value;
        }
        return out;
      } catch (e) {
        // Module-authored only — never rethrow Proxy/trap text.
        throw new TypeError("requestHeaders must be a plain record of string pairs");
      }
    }

    function safeGet(obj, key) {
      if (obj == null || (typeof obj !== "object" && typeof obj !== "function")) {
        return undefined;
      }
      try {
        var desc = Object.getOwnPropertyDescriptor(obj, key);
        if (desc) {
          if (desc.get || desc.set) return undefined;
          return desc.value;
        }
        // Ordinary inherited data props are not used (fail closed for secrets).
        return undefined;
      } catch (e) {
        return undefined;
      }
    }

    // Secret-bearing query/fragment parameter names (case-insensitive).
    // Matched only after ?, &, or # so ordinary text like "HTTP 429? retry later"
    // and filenames with a harmless "#" stay friendly.
    var SECRET_PARAM_RE =
      /[?#&](?:token|access_token|auth|authorization|key|api_key|session|cookie|sig|signature|policy|expires|expiry|x-amz-[^=&#\s]*)=/i;

    function hasControlChars(s) {
      // CR / LF / NUL and other C0 controls + DEL — never forward in allowlists.
      return /[\u0000-\u001f\u007f]/.test(s);
    }

    /**
     * True when a popup-facing string carries network URL material, secret
     * query/fragment params, or credential/header syntax. Allowlisted field
     * names do not authorize forwarding this content. Popup projections must
     * contain no media/page URLs at all (scheme:// or scheme-relative //host).
     */
    function isSuspiciousPopupString(s) {
      if (typeof s !== "string" || s.length === 0) return false;
      // Case-insensitive Cookie / Set-Cookie / Authorization / Proxy-Authorization header syntax.
      if (/(?:^|[\r\n\t\s,;])(?:Cookie|Set-Cookie|Authorization|Proxy-Authorization)\s*:/i.test(s) ||
          /^(?:Cookie|Set-Cookie|Authorization|Proxy-Authorization)\s*:/i.test(s)) {
        return true;
      }
      // Secret-bearing params in absolute, scheme-relative, relative, or bare strings.
      if (SECRET_PARAM_RE.test(s)) return true;
      // Any absolute scheme:// network URL reference (with or without query).
      if (/[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) return true;
      // Any scheme-relative //host network reference (with or without query).
      if (/\/\//.test(s)) return true;
      return false;
    }

    function sanitizePopupError(s) {
      if (typeof s !== "string") return undefined;
      if (isSuspiciousPopupString(s)) return "Download error";
      return s;
    }

    function sanitizePopupOptionalString(s) {
      if (typeof s !== "string") return undefined;
      if (isSuspiciousPopupString(s)) return undefined;
      return s;
    }

    /**
     * Safe history requestedFilename: ordinary filename only.
     * Reject URL-like values, secret params, header syntax, controls, path seps.
     * Never echo a rejected value.
     */
    function isSafeHistoryFilename(s) {
      if (!isNonblankPrimitiveString(s)) return false;
      if (hasControlChars(s)) return false;
      if (/[/\\]/.test(s)) return false;
      if (isSuspiciousPopupString(s)) return false;
      return true;
    }

    /**
     * Safe history providerKey: hostname-like site key (no normalize).
     * alnum / dot / hyphen, optional :port. Reject URL/query/header/whitespace.
     */
    function isSafeHistoryProviderKey(s) {
      if (typeof s !== "string" || s.length === 0 || s.length > 253) return false;
      if (hasControlChars(s)) return false;
      if (isSuspiciousPopupString(s)) return false;
      // Single label or dotted host, optional numeric port. No underscore/space/path.
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::\d{1,5})?$/.test(s)) {
        return false;
      }
      // Reject consecutive dots / leading-trailing dot labels loosely via simple checks.
      if (s.indexOf("..") !== -1) return false;
      var hostPart = s;
      var colon = s.lastIndexOf(":");
      if (colon !== -1 && /^\d{1,5}$/.test(s.slice(colon + 1))) {
        hostPart = s.slice(0, colon);
      }
      if (hostPart.charAt(0) === "-" || hostPart.charAt(hostPart.length - 1) === "-") {
        return false;
      }
      if (hostPart.charAt(0) === "." || hostPart.charAt(hostPart.length - 1) === ".") {
        return false;
      }
      return true;
    }

    /**
     * Safe history status: ordinary scheduler/status text.
     * Reject URL-like, secret params, credential/header syntax, controls.
     */
    function isSafeHistoryStatus(s) {
      if (!isNonblankPrimitiveString(s)) return false;
      if (hasControlChars(s)) return false;
      if (isSuspiciousPopupString(s)) return false;
      return true;
    }

    /**
     * Safe history ts: ordinary ISO/timestamp primitive strings.
     * Reject URL-like, query/fragment/credential/header syntax, controls.
     * Never invokes the clock.
     */
    function isSafeHistoryTs(s) {
      if (!isNonblankPrimitiveString(s)) return false;
      if (hasControlChars(s)) return false;
      if (isSuspiciousPopupString(s)) return false;
      // Bare query/fragment/userinfo markers are never valid timestamps.
      if (/[?#@]/.test(s)) return false;
      return true;
    }

    /**
     * Popup id / downloadId: finite numbers, or conservative identifier strings.
     * Omit invalid / suspicious values (never echo them).
     */
    function isSafePopupIdentifier(v) {
      if (typeof v === "number") {
        return isFiniteNumber(v);
      }
      if (typeof v !== "string" || v.length === 0 || v.length > 128) return false;
      if (hasControlChars(v)) return false;
      if (isSuspiciousPopupString(v)) return false;
      // Common job ids / UUIDs: alnum plus . _ : -
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v)) return false;
      return true;
    }

    /**
     * Runtime-only transport context. Secrets live in closure; own accessors
     * are non-enumerable so JSON.stringify yields {}.
     */
    function createEphemeral(mediaUrl, requestHeaders) {
      if (!isNonblankPrimitiveString(mediaUrl)) {
        throw new TypeError("mediaUrl must be a nonblank primitive string");
      }

      var headerCopy = Object.create(null);
      if (requestHeaders !== null && requestHeaders !== undefined) {
        if (!isPlainRecord(requestHeaders)) {
          throw new TypeError("requestHeaders must be a plain record or null");
        }
        headerCopy = ownDataStringProps(requestHeaders);
      }
      Object.freeze(headerCopy);

      var urlState = mediaUrl;
      var headersState = headerCopy;

      var ctx = {};
      Object.defineProperty(ctx, "mediaUrl", {
        enumerable: false,
        configurable: false,
        get: function () { return urlState; },
      });
      Object.defineProperty(ctx, "requestHeaders", {
        enumerable: false,
        configurable: false,
        get: function () { return headersState; },
      });
      Object.defineProperty(ctx, "clear", {
        enumerable: false,
        configurable: false,
        writable: false,
        value: function clear() {
          urlState = null;
          headersState = null;
        },
      });
      return Object.freeze(ctx);
    }

    function projectSafeHistory(jobOrItem) {
      var input = jobOrItem;
      var requestedFilename = "download";
      var providerKey = "unknown";
      var status = "unknown";
      var bytes = 0;
      var ts = null;

      if (input != null && (typeof input === "object" || typeof input === "function")) {
        var topName = safeGet(input, "requestedFilename");
        if (isSafeHistoryFilename(topName)) {
          requestedFilename = topName;
        } else {
          // Rejected/missing top-level: try intent (never echo rejected values).
          var intent = safeGet(input, "intent");
          if (intent != null && typeof intent === "object") {
            var intentName = safeGet(intent, "requestedFilename");
            if (isSafeHistoryFilename(intentName)) {
              requestedFilename = intentName;
            }
          }
        }

        var pk = safeGet(input, "providerKey");
        if (isSafeHistoryProviderKey(pk)) providerKey = pk;

        var st = safeGet(input, "status");
        if (isSafeHistoryStatus(st)) {
          status = st;
        } else {
          var state = safeGet(input, "state");
          if (isSafeHistoryStatus(state)) status = state;
        }

        var b = safeGet(input, "bytes");
        if (isFiniteNonnegNumber(b)) bytes = b;

        var t = safeGet(input, "ts");
        if (isSafeHistoryTs(t)) {
          ts = t;
        } else {
          var completedAt = safeGet(input, "completedAt");
          if (isSafeHistoryTs(completedAt)) {
            ts = completedAt;
          } else {
            var createdAt = safeGet(input, "createdAt");
            if (isSafeHistoryTs(createdAt)) ts = createdAt;
          }
        }
      }

      // Exact key order required by contract.
      var out = {
        requestedFilename: requestedFilename,
        providerKey: providerKey,
        status: status,
        bytes: bytes,
        ts: ts,
      };
      return deepFreeze(out);
    }

    function readBindString(job, key) {
      var top = safeGet(job, key);
      if (isNonblankPrimitiveString(top)) return top;
      var intent = safeGet(job, "intent");
      if (intent != null && typeof intent === "object") {
        var nested = safeGet(intent, key);
        if (isNonblankPrimitiveString(nested)) return nested;
      }
      return undefined;
    }

    function readBindDestination(job) {
      var top = safeGet(job, "destinationDirectory");
      if (top === null) return null;
      if (isNonblankPrimitiveString(top)) return top;
      // Absent top-level: try intent (null is valid).
      if (top === undefined) {
        var intent = safeGet(job, "intent");
        if (intent != null && typeof intent === "object") {
          var nested = safeGet(intent, "destinationDirectory");
          if (nested === null) return null;
          if (isNonblankPrimitiveString(nested)) return nested;
        }
      }
      return undefined;
    }

    function projectPrimitiveRecord(src, spec) {
      if (src == null || typeof src !== "object") return null;
      var out = {};
      var keys = Object.keys(spec);
      var any = false;
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var kind = spec[k];
        var v = safeGet(src, k);
        if (kind === "finite" && isFiniteNumber(v)) {
          out[k] = v;
          any = true;
        } else if (kind === "nonneg" && isFiniteNonnegNumber(v)) {
          out[k] = v;
          any = true;
        } else if (kind === "string" && typeof v === "string") {
          var cleaned = sanitizePopupOptionalString(v);
          if (cleaned !== undefined) {
            out[k] = cleaned;
            any = true;
          }
        } else if (kind === "boolean" && typeof v === "boolean") {
          out[k] = v;
          any = true;
        }
      }
      if (!any) return null;
      return Object.freeze(out);
    }

    function projectPopupJob(job) {
      if (job == null || (typeof job !== "object" && typeof job !== "function")) {
        return deepFreeze({});
      }

      var out = {};

      var id = safeGet(job, "id");
      if (isSafePopupIdentifier(id)) out.id = id;

      var mediaId = safeGet(job, "mediaId");
      if (typeof mediaId === "string" && isSafePopupIdentifier(mediaId)) {
        out.mediaId = mediaId;
      }

      var state = safeGet(job, "state");
      if (typeof state === "string") {
        var stateOk = sanitizePopupOptionalString(state);
        if (stateOk !== undefined) out.state = stateOk;
      }

      var status = safeGet(job, "status");
      if (typeof status === "string") {
        var statusOk = sanitizePopupOptionalString(status);
        if (statusOk !== undefined) out.status = statusOk;
      }

      var providerKey = safeGet(job, "providerKey");
      if (typeof providerKey === "string") {
        var pkOk = sanitizePopupOptionalString(providerKey);
        if (pkOk !== undefined) out.providerKey = pkOk;
      }

      var requestedFilename = readBindString(job, "requestedFilename");
      if (requestedFilename !== undefined) {
        var rfOk = sanitizePopupOptionalString(requestedFilename);
        if (rfOk !== undefined) out.requestedFilename = rfOk;
      }

      var destinationDirectory = readBindDestination(job);
      if (destinationDirectory === null) {
        out.destinationDirectory = null;
      } else if (destinationDirectory !== undefined) {
        var ddOk = sanitizePopupOptionalString(destinationDirectory);
        if (ddOk !== undefined) out.destinationDirectory = ddOk;
      }

      var saveMode = readBindString(job, "saveMode");
      if (saveMode !== undefined) {
        var smOk = sanitizePopupOptionalString(saveMode);
        if (smOk !== undefined) out.saveMode = smOk;
      }

      var createdAt = readBindString(job, "createdAt");
      if (createdAt !== undefined) {
        var caOk = sanitizePopupOptionalString(createdAt);
        if (caOk !== undefined) out.createdAt = caOk;
      }

      var kind = safeGet(job, "kind");
      if (typeof kind === "string") {
        var kindOk = sanitizePopupOptionalString(kind);
        if (kindOk !== undefined) out.kind = kindOk;
      }

      var mode = safeGet(job, "mode");
      if (typeof mode === "string") {
        var modeOk = sanitizePopupOptionalString(mode);
        if (modeOk !== undefined) out.mode = modeOk;
      }

      var mediaKind = safeGet(job, "mediaKind");
      if (typeof mediaKind === "string") {
        var mkOk = sanitizePopupOptionalString(mediaKind);
        if (mkOk !== undefined) out.mediaKind = mkOk;
      }

      var reduced = safeGet(job, "reduced");
      if (typeof reduced === "boolean") out.reduced = reduced;

      var error = safeGet(job, "error");
      if (typeof error === "string") {
        var errOk = sanitizePopupError(error);
        if (errOk !== undefined) out.error = errOk;
      }

      var bytes = safeGet(job, "bytes");
      if (isFiniteNonnegNumber(bytes)) out.bytes = bytes;

      var name = safeGet(job, "name");
      if (typeof name === "string") {
        var nameOk = sanitizePopupOptionalString(name);
        if (nameOk !== undefined) out.name = nameOk;
      }

      var live = safeGet(job, "live");
      if (typeof live === "boolean") out.live = live;

      var native = safeGet(job, "native");
      if (typeof native === "boolean") out.native = native;

      var hasAudio = safeGet(job, "hasAudio");
      if (typeof hasAudio === "boolean") out.hasAudio = hasAudio;

      var savedPath = safeGet(job, "savedPath");
      if (typeof savedPath === "string") {
        var spOk = sanitizePopupOptionalString(savedPath);
        if (spOk !== undefined) out.savedPath = spOk;
      }

      var downloadId = safeGet(job, "downloadId");
      if (isSafePopupIdentifier(downloadId)) out.downloadId = downloadId;

      var snapshots = safeGet(job, "snapshots");
      if (isFiniteNonnegNumber(snapshots)) out.snapshots = snapshots;

      var convertCodec = safeGet(job, "convertCodec");
      if (typeof convertCodec === "string") {
        var ccOk = sanitizePopupOptionalString(convertCodec);
        if (ccOk !== undefined) out.convertCodec = ccOk;
      }

      var convertPct = safeGet(job, "convertPct");
      if (isFiniteNumber(convertPct)) out.convertPct = convertPct;

      var mergeCommand = safeGet(job, "mergeCommand");
      if (typeof mergeCommand === "string") {
        var mcOk = sanitizePopupOptionalString(mergeCommand);
        if (mcOk !== undefined) out.mergeCommand = mcOk;
      }

      var fixCommand = safeGet(job, "fixCommand");
      if (typeof fixCommand === "string") {
        var fcOk = sanitizePopupOptionalString(fixCommand);
        if (fcOk !== undefined) out.fixCommand = fcOk;
      }

      var stateVersion = safeGet(job, "stateVersion");
      if (isFiniteNumber(stateVersion)) out.stateVersion = stateVersion;

      var effectiveConcurrency = safeGet(job, "effectiveConcurrency");
      if (isFiniteNonnegNumber(effectiveConcurrency)) {
        out.effectiveConcurrency = effectiveConcurrency;
      }

      var retryRemaining = safeGet(job, "retryRemaining");
      if (isFiniteNonnegNumber(retryRemaining)) out.retryRemaining = retryRemaining;

      var retryUsed = safeGet(job, "retryUsed");
      if (isFiniteNonnegNumber(retryUsed)) out.retryUsed = retryUsed;

      var autoWakeCount = safeGet(job, "autoWakeCount");
      if (isFiniteNonnegNumber(autoWakeCount)) out.autoWakeCount = autoWakeCount;

      var inFlightPermits = safeGet(job, "inFlightPermits");
      if (isFiniteNonnegNumber(inFlightPermits)) out.inFlightPermits = inFlightPermits;

      var nativeOpenConnections = safeGet(job, "nativeOpenConnections");
      if (isFiniteNonnegNumber(nativeOpenConnections)) {
        out.nativeOpenConnections = nativeOpenConnections;
      }

      var progress = projectPrimitiveRecord(safeGet(job, "progress"), {
        done: "finite",
        total: "finite",
        bps: "finite",
        kbps: "finite",
        duration: "finite",
        unit: "string",
        stage: "string",
        note: "string",
      });
      if (progress) out.progress = progress;

      var recorded = projectPrimitiveRecord(safeGet(job, "recorded"), {
        bytes: "finite",
        duration: "finite",
      });
      if (recorded) out.recorded = recorded;

      var quality = projectPrimitiveRecord(safeGet(job, "quality"), {
        width: "finite",
        height: "finite",
        fps: "finite",
        bitrate: "finite",
        label: "string",
        codec: "string",
      });
      if (quality) out.quality = quality;

      var convert = projectPrimitiveRecord(safeGet(job, "convert"), {
        codec: "string",
        command: "string",
        note: "string",
        pct: "finite",
        keptOriginal: "boolean",
      });
      if (convert) out.convert = convert;

      return deepFreeze(out);
    }

    function manualRedactAbsoluteHttp(url) {
      // Never echo userinfo, query, or fragment when URL parsing is unavailable/fails.
      var s = String(url);
      var hashIdx = s.indexOf("#");
      if (hashIdx !== -1) s = s.slice(0, hashIdx);
      var qIdx = s.indexOf("?");
      if (qIdx !== -1) s = s.slice(0, qIdx);
      // Strip userinfo after scheme://
      s = s.replace(/^(https?:\/\/)([^/@]+@)/i, "$1");
      // If anything still looks like credentials/query/fragment, fail closed.
      if (!s || /[?#]/.test(s) || /^(https?:\/\/)[^/]*@/i.test(s)) {
        return "[redacted]";
      }
      return s;
    }

    function manualRedactSchemeRelative(url) {
      var s = String(url);
      var hashIdx = s.indexOf("#");
      if (hashIdx !== -1) s = s.slice(0, hashIdx);
      var qIdx = s.indexOf("?");
      if (qIdx !== -1) s = s.slice(0, qIdx);
      // Strip userinfo: //user:pass@host → //host
      s = s.replace(/^\/\/([^/@]+@)/, "//");
      if (!s || /[?#]/.test(s) || /^\/\/[^/]*@/.test(s)) {
        return "[redacted]";
      }
      return s;
    }

    function redactUrlForLog(url) {
      // Primitive strings only — never coerce objects/arrays via String().
      if (typeof url !== "string" || url.length === 0) return "[redacted]";

      // Absolute http(s): strip userinfo, query, fragment via URL when available.
      if (/^https?:\/\//i.test(url)) {
        try {
          if (typeof URL === "function") {
            var u = new URL(url);
            u.username = "";
            u.password = "";
            u.search = "";
            u.hash = "";
            // href after clearing userinfo/query/hash is scheme://host[:port]/path
            return u.href;
          }
        } catch (e) {
          // fall through to manual strip
        }
        return manualRedactAbsoluteHttp(url);
      }

      // Scheme-relative: //host/path?... — strip userinfo, query, fragment.
      if (/^\/\//.test(url)) {
        return manualRedactSchemeRelative(url);
      }

      // Relative or other primitive strings: strip query and fragment only.
      var pathOnly = url.split("#")[0].split("?")[0];
      if (!pathOnly) return "[redacted]";
      return pathOnly;
    }

    function assertNoSentinels(blob, sentinels) {
      if (typeof blob !== "string") {
        throw new TypeError("blob must be a primitive string");
      }
      if (!Array.isArray(sentinels)) {
        throw new TypeError("sentinels must be an array");
      }
      for (var i = 0; i < sentinels.length; i++) {
        var s = sentinels[i];
        if (typeof s !== "string" || s.length === 0) {
          throw new TypeError("sentinels entries must be nonempty primitive strings");
        }
        if (blob.indexOf(s) !== -1) {
          throw new Error("sentinel detected at index " + i);
        }
      }
      return true;
    }

    function markCleared(ephemeral) {
      if (clearedEphemerals) {
        clearedEphemerals.add(ephemeral);
        return;
      }
      for (var i = 0; i < clearedFallback.length; i++) {
        if (clearedFallback[i] === ephemeral) return;
      }
      clearedFallback.push(ephemeral);
    }

    function wasCleared(ephemeral) {
      if (clearedEphemerals) return clearedEphemerals.has(ephemeral);
      for (var i = 0; i < clearedFallback.length; i++) {
        if (clearedFallback[i] === ephemeral) return true;
      }
      return false;
    }

    function clearEphemeralOnTerminal(job, state) {
      if (!isTerminalState(state)) {
        return false;
      }
      if (job == null || (typeof job !== "object" && typeof job !== "function")) {
        return false;
      }

      // Descriptor-safe: never invoke job.ephemeral / clear accessors or inherited getters.
      var ephemeral = safeGet(job, "ephemeral");
      if (ephemeral == null || (typeof ephemeral !== "object" && typeof ephemeral !== "function")) {
        return false;
      }

      var clearFn;
      try {
        var clearDesc = Object.getOwnPropertyDescriptor(ephemeral, "clear");
        if (!clearDesc || clearDesc.get || clearDesc.set || typeof clearDesc.value !== "function") {
          return false;
        }
        clearFn = clearDesc.value;
      } catch (e) {
        // Hostile Proxy reflection: fail closed without trap text.
        return false;
      }

      if (wasCleared(ephemeral)) {
        return false;
      }

      // Mark before invoke so throwing fakes are never called twice.
      markCleared(ephemeral);
      try {
        clearFn.call(ephemeral);
      } catch (e) {
        throw new Error("ephemeral cleanup failed");
      }
      return true;
    }

    return {
      createEphemeral: createEphemeral,
      projectSafeHistory: projectSafeHistory,
      projectPopupJob: projectPopupJob,
      redactUrlForLog: redactUrlForLog,
      assertNoSentinels: assertNoSentinels,
      clearEphemeralOnTerminal: clearEphemeralOnTerminal,
    };
  }
);
