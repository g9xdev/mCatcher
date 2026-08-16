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
    var VARIANT_REG_MSG = "invalid media variant registration";
    var MAX_VARIANT_ENTRIES = 64;
    var MAX_VARIANT_LABEL_UNITS = 128;
    var MAX_VARIANT_MIME_LEN = 127;
    var VARIANT_MIME_RE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
    var VARIANT_SENSITIVE_WORD_RE =
      /(?:^|[^A-Za-z0-9])(?:cookie|authorization|bearer|token|signature|sig|expires)(?=$|[^A-Za-z0-9])/i;
    var VARIANT_HEADER_SYNTAX_RE =
      /(?:^|[\r\n\t\s,;])(?:Cookie|Set-Cookie|Authorization|Proxy-Authorization)\s*:|^(?:Cookie|Set-Cookie|Authorization|Proxy-Authorization)\s*:|Bearer\s/i;
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
      if (safeIsArray(value)) return value.map(deepClone);
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

    var GENERIC_INPUT_MSG = "invalid background adapter input";
    var MAX_HEADER_ENTRIES = 64;
    var MAX_CANDIDATE_ENTRIES = 64;
    var MAX_TRANSPORT_ENTRIES = 64;
    var MAX_TRANSPORT_FIELDS = 16;
    var DATE_RANGE_ABS_MS = 8.64e15;

    function genericTypeError() {
      return new TypeError(GENERIC_INPUT_MSG);
    }

    function variantRegError() {
      return new TypeError(VARIANT_REG_MSG);
    }

    /**
     * Dense real-Array shell for variant registration input.
     * Nonneg safe-integer length at most maxLen; no symbols / unexpected keys /
     * sparse or accessor indices. Reflection faults → variant TypeError.
     */
    function denseVariantArrayLength(raw, maxLen) {
      var isArr;
      try {
        isArr = Array.isArray(raw);
      } catch (e) {
        throw variantRegError();
      }
      if (!isArr) throw variantRegError();
      var symbols;
      try {
        symbols = Object.getOwnPropertySymbols(raw);
      } catch (e) {
        throw variantRegError();
      }
      if (symbols.length > 0) throw variantRegError();
      var names;
      try {
        names = Object.getOwnPropertyNames(raw);
      } catch (e) {
        throw variantRegError();
      }
      var lenState;
      try {
        var lenDesc = Object.getOwnPropertyDescriptor(raw, "length");
        if (!lenDesc || lenDesc.get || lenDesc.set || !("value" in lenDesc)) {
          throw variantRegError();
        }
        lenState = lenDesc.value;
      } catch (e) {
        if (e && e.message === VARIANT_REG_MSG) throw e;
        throw variantRegError();
      }
      if (
        typeof lenState !== "number" ||
        !Number.isFinite(lenState) ||
        !Number.isSafeInteger(lenState) ||
        lenState < 0 ||
        lenState > maxLen
      ) {
        throw variantRegError();
      }
      var len = lenState;
      var allowed = Object.create(null);
      allowed.length = true;
      for (var i = 0; i < len; i++) {
        allowed[String(i)] = true;
      }
      for (var n = 0; n < names.length; n++) {
        if (allowed[names[n]] !== true) throw variantRegError();
      }
      for (var j = 0; j < len; j++) {
        var eDesc;
        try {
          eDesc = Object.getOwnPropertyDescriptor(raw, String(j));
        } catch (e) {
          throw variantRegError();
        }
        if (!eDesc || eDesc.get || eDesc.set || !("value" in eDesc)) {
          throw variantRegError();
        }
      }
      return len;
    }

    /** Own-key state that genericizes reflection faults as variant TypeError. */
    function variantOwnKeyState(obj, key) {
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
        throw variantRegError();
      }
    }

    function isVariantPlainRecord(v) {
      if (v === null || typeof v !== "object") return false;
      var isArr;
      try {
        isArr = Array.isArray(v);
      } catch (e) {
        throw variantRegError();
      }
      if (isArr) return false;
      try {
        var proto = Object.getPrototypeOf(v);
        return proto === Object.prototype || proto === null;
      } catch (e) {
        throw variantRegError();
      }
    }

    function requireVariantAbsoluteHttpUrl(value) {
      if (typeof value !== "string") throw variantRegError();
      if (value.length === 0 || value.trim().length === 0) throw variantRegError();
      // Exact spelling retained — do not require trim-stable; blank after trim rejects.
      // Spec: nonblank, C0/DEL/C1-free, absolute http(s). Nonblank means trim not empty.
      // Also: "nonblank" for media URLs in capture required trim-stable. For variants:
      // "url must be an own data primitive string, nonblank, C0/DEL/C1-free"
      if (hasControlChars(value)) throw variantRegError();
      if (value.trim().length === 0) throw variantRegError();
      var parsed;
      try {
        parsed = new URL(value);
      } catch (e) {
        throw variantRegError();
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw variantRegError();
      }
      return value;
    }

    function sanitizeVariantLabel(value) {
      if (value === undefined || value === null) return undefined;
      if (typeof value !== "string") return undefined;
      var trimmed = value.replace(/^\s+|\s+$/g, "");
      if (trimmed.length === 0) return undefined;
      if (hasControlChars(trimmed)) return undefined;
      if (trimmed.indexOf("://") !== -1) return undefined;
      if (trimmed.indexOf("//") === 0) return undefined;
      if (VARIANT_HEADER_SYNTAX_RE.test(trimmed)) return undefined;
      if (VARIANT_SENSITIVE_WORD_RE.test(trimmed)) return undefined;
      if (trimmed.length > MAX_VARIANT_LABEL_UNITS) {
        trimmed = trimmed.slice(0, MAX_VARIANT_LABEL_UNITS);
      }
      return trimmed;
    }

    function sanitizeVariantMime(value) {
      if (value === undefined || value === null) return undefined;
      if (typeof value !== "string") return undefined;
      var trimmed = value.replace(/^\s+|\s+$/g, "");
      if (trimmed.length === 0 || trimmed.length > MAX_VARIANT_MIME_LEN) {
        return undefined;
      }
      // ASCII only for MIME token.
      for (var i = 0; i < trimmed.length; i++) {
        if (trimmed.charCodeAt(i) > 0x7f) return undefined;
      }
      if (!VARIANT_MIME_RE.test(trimmed)) return undefined;
      return trimmed;
    }

    function sanitizeVariantPositiveInt(value) {
      if (
        typeof value === "number" &&
        Number.isFinite(value) &&
        Number.isSafeInteger(value) &&
        value >= 1
      ) {
        return value;
      }
      return undefined;
    }

    /**
     * Validate and snapshot the complete variants array into plain own-data rows.
     * Never invokes unknown-field getters. Known-field accessors reject.
     */
    function snapshotVariantRegistrationInput(variants) {
      var len = denseVariantArrayLength(variants, MAX_VARIANT_ENTRIES);
      var out = [];
      for (var i = 0; i < len; i++) {
        var eState = variantOwnKeyState(variants, String(i));
        // denseVariantArrayLength already proved present own-data indices.
        var entry = eState.value;
        if (!isVariantPlainRecord(entry)) throw variantRegError();

        // Required url — own data only; accessors reject.
        var urlState = variantOwnKeyState(entry, "url");
        if (!urlState.present || !urlState.data) throw variantRegError();
        var url = requireVariantAbsoluteHttpUrl(urlState.value);

        var row = { url: url };

        // Optional known fields: present accessors reject; unsafe values omit.
        var labelState = variantOwnKeyState(entry, "label");
        if (labelState.present) {
          if (!labelState.data) throw variantRegError();
          var label = sanitizeVariantLabel(labelState.value);
          if (label !== undefined) row.label = label;
        }

        var widthState = variantOwnKeyState(entry, "width");
        if (widthState.present) {
          if (!widthState.data) throw variantRegError();
          var width = sanitizeVariantPositiveInt(widthState.value);
          if (width !== undefined) row.width = width;
        }

        var heightState = variantOwnKeyState(entry, "height");
        if (heightState.present) {
          if (!heightState.data) throw variantRegError();
          var height = sanitizeVariantPositiveInt(heightState.value);
          if (height !== undefined) row.height = height;
        }

        var bandwidthState = variantOwnKeyState(entry, "bandwidth");
        if (bandwidthState.present) {
          if (!bandwidthState.data) throw variantRegError();
          var bandwidth = sanitizeVariantPositiveInt(bandwidthState.value);
          if (bandwidth !== undefined) row.bandwidth = bandwidth;
        }

        var mimeState = variantOwnKeyState(entry, "mime");
        if (mimeState.present) {
          if (!mimeState.data) throw variantRegError();
          var mime = sanitizeVariantMime(mimeState.value);
          if (mime !== undefined) row.mime = mime;
        }

        // Unknown fields (id, variantId, variantUrl, providerKey, …) ignored by
        // name without reading descriptors/values or invoking getters.
        out.push(row);
      }
      return out;
    }

    function projectSafeVariantRow(id, meta) {
      var row = { id: id };
      if (meta.label !== undefined) row.label = meta.label;
      if (meta.width !== undefined) row.width = meta.width;
      if (meta.height !== undefined) row.height = meta.height;
      if (meta.bandwidth !== undefined) row.bandwidth = meta.bandwidth;
      if (meta.mime !== undefined) row.mime = meta.mime;
      return deepFreeze(row);
    }

    function copySafeVariantProjections(privateList) {
      var out = [];
      if (!privateList) return deepFreeze(out);
      for (var i = 0; i < privateList.length; i++) {
        var sp = privateList[i].safeProjection;
        // Fresh own-data copy of the frozen projection.
        var copy = { id: sp.id };
        if (Object.prototype.hasOwnProperty.call(sp, "label")) copy.label = sp.label;
        if (Object.prototype.hasOwnProperty.call(sp, "width")) copy.width = sp.width;
        if (Object.prototype.hasOwnProperty.call(sp, "height")) copy.height = sp.height;
        if (Object.prototype.hasOwnProperty.call(sp, "bandwidth")) {
          copy.bandwidth = sp.bandwidth;
        }
        if (Object.prototype.hasOwnProperty.call(sp, "mime")) copy.mime = sp.mime;
        out.push(deepFreeze(copy));
      }
      return deepFreeze(out);
    }

    /** Array.isArray behind a genericizing boundary (revoked Proxy safe). */
    function safeIsArray(v) {
      try {
        return Array.isArray(v);
      } catch (e) {
        throw genericTypeError();
      }
    }

    function safeGetPrototypeOf(v) {
      try {
        return Object.getPrototypeOf(v);
      } catch (e) {
        throw genericTypeError();
      }
    }

    function safeOwnPropertyNames(v) {
      try {
        return Object.getOwnPropertyNames(v);
      } catch (e) {
        throw genericTypeError();
      }
    }

    function safeOwnPropertySymbols(v) {
      try {
        return Object.getOwnPropertySymbols(v);
      } catch (e) {
        throw genericTypeError();
      }
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

    /**
     * Own-key presence without invoking accessors.
     * Reflection faults → generic TypeError (never leak trap identity/text).
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
        throw genericTypeError();
      }
    }

    function isPlainRecord(v) {
      if (v === null || typeof v !== "object") return false;
      if (safeIsArray(v)) return false;
      try {
        var proto = safeGetPrototypeOf(v);
        return proto === Object.prototype || proto === null;
      } catch (e) {
        throw genericTypeError();
      }
    }

    function isPositiveSafeInteger(value) {
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        Number.isSafeInteger(value) &&
        value >= 1
      );
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
      // C0, DEL, and C1 (U+0080–U+009F).
      return /[\u0000-\u001f\u007f-\u009f]/.test(s);
    }

    function isValidDateMs(value) {
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        Number.isSafeInteger(value) &&
        Math.abs(value) <= DATE_RANGE_ABS_MS
      );
    }

    function isNonnegSafeInt(value) {
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        Number.isSafeInteger(value) &&
        value >= 0
      );
    }

    /**
     * tabId/frameId identity preserved by downstream `| 0`: primitive integers
     * in inclusive range [0, 0x7fffffff]. Rejects values that would truncate.
     */
    function isSignedInt32Identity(value) {
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        Number.isInteger(value) &&
        value >= 0 &&
        value <= 0x7fffffff
      );
    }

    function requireControlFreeString(s) {
      if (typeof s !== "string" || hasControlChars(s)) throw genericTypeError();
      return s;
    }

    function requireNonblankControlFreeString(s) {
      if (typeof s !== "string" || s.trim().length === 0 || hasControlChars(s)) {
        throw genericTypeError();
      }
      return s;
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

    /**
     * Snapshot requestHeaders into a fresh frozen null-prototype own-data string
     * record. Rejects symbols, accessors, non-enumerable/non-string entries,
     * controls (C0/DEL/C1), excessive entries, and revoked proxies.
     */
    function snapshotRequestHeaders(raw) {
      if (raw === undefined || raw === null) return null;
      if (!isPlainRecord(raw)) throw genericTypeError();
      var symbols = safeOwnPropertySymbols(raw);
      if (symbols.length > 0) throw genericTypeError();
      var names = safeOwnPropertyNames(raw);
      if (names.length > MAX_HEADER_ENTRIES) throw genericTypeError();
      var out = Object.create(null);
      for (var i = 0; i < names.length; i++) {
        var k = names[i];
        if (typeof k !== "string" || hasControlChars(k)) throw genericTypeError();
        var st = ownKeyState(raw, k);
        if (!st.present || !st.data) throw genericTypeError();
        // Must be enumerable own data (Privacy contract).
        var desc;
        try {
          desc = Object.getOwnPropertyDescriptor(raw, k);
        } catch (e) {
          throw genericTypeError();
        }
        if (!desc || !desc.enumerable || desc.get || desc.set || !("value" in desc)) {
          throw genericTypeError();
        }
        if (typeof st.value !== "string" || hasControlChars(st.value)) {
          throw genericTypeError();
        }
        out[k] = st.value;
      }
      return Object.freeze(out);
    }

    /**
     * Own-data primitive string that is nonblank, trim-stable, C0/DEL/C1-free,
     * and an absolute HTTP(S) URL. Preserves exact accepted spelling (no
     * toString/valueOf coercion, no normalization of the retained value).
     */
    function requireAbsoluteHttpUrl(value) {
      if (typeof value !== "string") throw genericTypeError();
      if (value.length === 0 || value.trim() !== value) throw genericTypeError();
      if (hasControlChars(value)) throw genericTypeError();
      var parsed;
      try {
        parsed = new URL(value);
      } catch (e) {
        throw genericTypeError();
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw genericTypeError();
      }
      return value;
    }

    /**
     * Dense real-Array shell: same/cross-realm Arrays only; no Symbols,
     * no unexpected own keys, no accessor/non-data/sparse indices.
     * Inspects only via guarded own-key/descriptor ops. Returns length.
     * Accepts ordinary and frozen dense arrays (writable/configurable not required).
     */
    function denseArrayLength(raw, maxLen) {
      if (!safeIsArray(raw)) throw genericTypeError();
      var symbols = safeOwnPropertySymbols(raw);
      if (symbols.length > 0) throw genericTypeError();
      var names = safeOwnPropertyNames(raw);
      var lenState = ownKeyState(raw, "length");
      if (!lenState.present || !lenState.data || !isNonnegInt(lenState.value)) {
        throw genericTypeError();
      }
      var len = lenState.value;
      if (len > maxLen) throw genericTypeError();
      var allowed = Object.create(null);
      allowed.length = true;
      for (var i = 0; i < len; i++) {
        allowed[String(i)] = true;
      }
      for (var n = 0; n < names.length; n++) {
        if (allowed[names[n]] !== true) throw genericTypeError();
      }
      for (var j = 0; j < len; j++) {
        var eState = ownKeyState(raw, String(j));
        if (!eState.present || !eState.data) throw genericTypeError();
      }
      return len;
    }

    /**
     * Descriptor-safe snapshot of optional future-transport evidence.
     * Bounded plain own-data only; primitive leaves; recursively frozen.
     * Never retains requestHeaders or raw caller graph identity.
     */
    function snapshotFutureTransport(transport) {
      var handle = {};

      var mirrorsState = ownKeyState(transport, "mirrors");
      if (mirrorsState.present) {
        if (!mirrorsState.data) throw genericTypeError();
        handle.mirrors = snapshotMirrorArray(mirrorsState.value);
      }

      var refererState = ownKeyState(transport, "referer");
      if (refererState.present) {
        if (!refererState.data) throw genericTypeError();
        if (refererState.value !== undefined && refererState.value !== null) {
          handle.referer = requireControlFreeString(refererState.value);
        }
      }

      var uaState = ownKeyState(transport, "userAgent");
      if (uaState.present) {
        if (!uaState.data) throw genericTypeError();
        if (uaState.value !== undefined && uaState.value !== null) {
          handle.userAgent = requireControlFreeString(uaState.value);
        }
      }

      var variantsState = ownKeyState(transport, "variants");
      if (variantsState.present) {
        if (!variantsState.data) throw genericTypeError();
        handle.variants = snapshotVariantArray(variantsState.value);
      }

      return deepFreeze(handle);
    }

    /** Fresh dense copy of mirror URL strings (absolute HTTP(S), exact spelling). */
    function snapshotMirrorArray(raw) {
      var len = denseArrayLength(raw, MAX_TRANSPORT_ENTRIES);
      var out = [];
      for (var i = 0; i < len; i++) {
        var eState = ownKeyState(raw, String(i));
        // denseArrayLength already proved present own-data indices.
        out.push(requireAbsoluteHttpUrl(eState.value));
      }
      return out;
    }

    /**
     * Fresh dense copy of variant plain records. Each entry requires an own-data
     * primitive absolute HTTP(S) `url` (exact spelling retained privately).
     * Other own fields are bounded primitive leaves only.
     */
    function snapshotVariantArray(raw) {
      var len = denseArrayLength(raw, MAX_TRANSPORT_ENTRIES);
      var out = [];
      for (var i = 0; i < len; i++) {
        var eState = ownKeyState(raw, String(i));
        var entry = eState.value;
        if (entry == null || typeof entry !== "object" || safeIsArray(entry)) {
          throw genericTypeError();
        }
        if (!isPlainRecord(entry)) throw genericTypeError();
        var symbols = safeOwnPropertySymbols(entry);
        if (symbols.length > 0) throw genericTypeError();
        var names = safeOwnPropertyNames(entry);
        if (names.length > MAX_TRANSPORT_FIELDS) throw genericTypeError();
        var urlState = ownKeyState(entry, "url");
        if (!urlState.present || !urlState.data) throw genericTypeError();
        var rec = {};
        var sawUrl = false;
        for (var n = 0; n < names.length; n++) {
          var key = names[n];
          if (typeof key !== "string" || hasControlChars(key)) throw genericTypeError();
          var fState = ownKeyState(entry, key);
          if (!fState.present || !fState.data) throw genericTypeError();
          var fDesc;
          try {
            fDesc = Object.getOwnPropertyDescriptor(entry, key);
          } catch (e) {
            throw genericTypeError();
          }
          if (!fDesc || !fDesc.enumerable || fDesc.get || fDesc.set || !("value" in fDesc)) {
            throw genericTypeError();
          }
          var val = fState.value;
          if (key === "url") {
            rec.url = requireAbsoluteHttpUrl(val);
            sawUrl = true;
          } else if (val === null) {
            rec[key] = null;
          } else if (typeof val === "string") {
            if (hasControlChars(val)) throw genericTypeError();
            rec[key] = val;
          } else if (typeof val === "number") {
            if (!Number.isFinite(val)) throw genericTypeError();
            rec[key] = val;
          } else if (typeof val === "boolean") {
            rec[key] = val;
          } else {
            throw genericTypeError();
          }
        }
        if (!sawUrl) throw genericTypeError();
        out.push(rec);
      }
      return out;
    }

    function installFutureTransport(record, futureTransport) {
      Object.defineProperty(record, "futureTransport", {
        value: futureTransport,
        enumerable: false,
        writable: false,
        configurable: false,
      });
    }

    /**
     * Descriptor-safe transport validation for ephemeral + future evidence.
     * Returns frozen header copy + future handle; never retains raw caller graphs.
     */
    function validateTransport(transport) {
      if (!transport || typeof transport !== "object") {
        throw new TypeError("transport must be an object");
      }
      var mediaKindState = ownKeyState(transport, "mediaKind");
      if (!mediaKindState.present || !mediaKindState.data) {
        throw new TypeError("transport.mediaKind is invalid");
      }
      var mediaKind = validateMediaKind(mediaKindState.value);

      var headersState = ownKeyState(transport, "requestHeaders");
      var requestHeaders = null;
      if (headersState.present) {
        if (!headersState.data) throw genericTypeError();
        if (headersState.value !== undefined) {
          requestHeaders = snapshotRequestHeaders(headersState.value);
        }
      }

      var futureTransport = snapshotFutureTransport(transport);

      return {
        mediaKind: mediaKind,
        requestHeaders: requestHeaders,
        futureTransport: futureTransport,
      };
    }

    /** Optional own-data primitive string (absent → undefined; accessor/non-string → TypeError). */
    function readOptionalOwnString(obj, key) {
      var st = ownKeyState(obj, key);
      if (!st.present) return undefined;
      if (!st.data) throw genericTypeError();
      if (st.value === undefined) return undefined;
      if (st.value === null) return null;
      if (typeof st.value !== "string") throw genericTypeError();
      return st.value;
    }

    /** Optional own-data finite number. */
    function readOptionalOwnNumber(obj, key) {
      var st = ownKeyState(obj, key);
      if (!st.present) return undefined;
      if (!st.data) throw genericTypeError();
      if (st.value === undefined) return undefined;
      if (typeof st.value !== "number" || !Number.isFinite(st.value)) {
        throw genericTypeError();
      }
      return st.value;
    }

    /**
     * Snapshot responseHeaders as a bounded ordinary array of fresh {name,value}
     * own-data records. Never invokes index/length accessors or entry getters.
     */
    function snapshotResponseHeaders(raw) {
      if (raw === undefined || raw === null) return [];
      if (!safeIsArray(raw)) throw genericTypeError();
      var lenState = ownKeyState(raw, "length");
      if (!lenState.present || !lenState.data || !isNonnegInt(lenState.value)) {
        throw genericTypeError();
      }
      var len = lenState.value;
      if (len > MAX_HEADER_ENTRIES) throw genericTypeError();
      var out = [];
      for (var i = 0; i < len; i++) {
        var entryState = ownKeyState(raw, String(i));
        if (!entryState.present || !entryState.data) throw genericTypeError();
        var entry = entryState.value;
        if (entry == null || typeof entry !== "object") throw genericTypeError();
        var name = readOptionalOwnString(entry, "name");
        var value = readOptionalOwnString(entry, "value");
        if (typeof name !== "string" || typeof value !== "string") {
          throw genericTypeError();
        }
        if (hasControlChars(name) || hasControlChars(value)) throw genericTypeError();
        out.push({ name: name, value: value });
      }
      return out;
    }

    /**
     * Fresh plain details/hints records for mapWebRequestDetails.
     * Only validated primitive own-data values; never pass caller graphs.
     */
    function snapshotNetworkDetails(details) {
      if (details == null || typeof details !== "object") throw genericTypeError();
      var out = {};
      // Required absolute HTTP(S) media URL — exact spelling retained; no coercion.
      out.url = requireAbsoluteHttpUrl(readRequiredOwnString(details, "url"));
      var documentUrl = readOptionalOwnString(details, "documentUrl");
      if (documentUrl !== undefined && documentUrl !== null) {
        if (hasControlChars(documentUrl)) throw genericTypeError();
        out.documentUrl = documentUrl;
      }
      var originUrl = readOptionalOwnString(details, "originUrl");
      if (originUrl !== undefined && originUrl !== null) {
        if (hasControlChars(originUrl)) throw genericTypeError();
        out.originUrl = originUrl;
      }
      var documentId = readOptionalOwnString(details, "documentId");
      if (documentId !== undefined) {
        if (documentId !== null && hasControlChars(documentId)) throw genericTypeError();
        out.documentId = documentId;
      }
      var tabId = readOptionalOwnNumber(details, "tabId");
      if (tabId !== undefined) {
        if (!isSignedInt32Identity(tabId)) throw genericTypeError();
        out.tabId = tabId;
      }
      var frameId = readOptionalOwnNumber(details, "frameId");
      if (frameId !== undefined) {
        if (!isSignedInt32Identity(frameId)) throw genericTypeError();
        out.frameId = frameId;
      }
      var timeStamp = readOptionalOwnNumber(details, "timeStamp");
      if (timeStamp !== undefined) {
        if (!isValidDateMs(timeStamp)) throw genericTypeError();
        out.timeStamp = timeStamp;
      }
      var rhState = ownKeyState(details, "responseHeaders");
      if (rhState.present) {
        if (!rhState.data) throw genericTypeError();
        out.responseHeaders = snapshotResponseHeaders(rhState.value);
      } else {
        out.responseHeaders = [];
      }
      return out;
    }

    function snapshotNetworkHints(hints) {
      if (hints == null || typeof hints !== "object") throw genericTypeError();
      var out = {};
      // Absent keys may default; present keys require own-data primitive strings
      // (present undefined/null are invalid — not treated as absence).
      var topState = ownKeyState(hints, "topLevelUrlHint");
      if (topState.present) {
        if (!topState.data || typeof topState.value !== "string") {
          throw genericTypeError();
        }
        if (hasControlChars(topState.value)) throw genericTypeError();
        out.topLevelUrlHint = topState.value;
      }
      var frameOriginState = ownKeyState(hints, "frameOrigin");
      if (frameOriginState.present) {
        if (!frameOriginState.data || typeof frameOriginState.value !== "string") {
          throw genericTypeError();
        }
        if (hasControlChars(frameOriginState.value)) throw genericTypeError();
        out.frameOrigin = frameOriginState.value;
      }
      return out;
    }

    /**
     * Fresh document snapshot for provideDocumentSnapshot / finalizeFromDom.
     * Never passes the caller's snapshot/candidate graph to the finalizer.
     */
    function snapshotDocumentSnapshot(snapshot) {
      if (snapshot == null || typeof snapshot !== "object") throw genericTypeError();
      var out = {};
      var documentId = readOptionalOwnString(snapshot, "documentId");
      if (documentId !== undefined) {
        if (documentId !== null && hasControlChars(documentId)) throw genericTypeError();
        out.documentId = documentId;
      }
      var tabId = readOptionalOwnNumber(snapshot, "tabId");
      if (tabId !== undefined) {
        if (!isSignedInt32Identity(tabId)) throw genericTypeError();
        out.tabId = tabId;
      }
      var frameId = readOptionalOwnNumber(snapshot, "frameId");
      if (frameId !== undefined) {
        if (!isSignedInt32Identity(frameId)) throw genericTypeError();
        out.frameId = frameId;
      }
      var pageUrl = readOptionalOwnString(snapshot, "pageUrl");
      if (pageUrl !== undefined && pageUrl !== null) {
        if (hasControlChars(pageUrl)) throw genericTypeError();
        out.pageUrl = pageUrl;
      }
      var topLevelPageUrl = readOptionalOwnString(snapshot, "topLevelPageUrl");
      if (topLevelPageUrl !== undefined && topLevelPageUrl !== null) {
        if (hasControlChars(topLevelPageUrl)) throw genericTypeError();
        out.topLevelPageUrl = topLevelPageUrl;
      }
      var documentNonce = readOptionalOwnString(snapshot, "documentNonce");
      if (documentNonce !== undefined && documentNonce !== null) {
        if (hasControlChars(documentNonce)) throw genericTypeError();
        out.documentNonce = documentNonce;
      }
      var capturedAt = readOptionalOwnString(snapshot, "capturedAt");
      if (capturedAt !== undefined && capturedAt !== null) {
        // Primitive string only — reject controls; do not coerce.
        if (hasControlChars(capturedAt)) throw genericTypeError();
        out.capturedAt = capturedAt;
      }

      var candState = ownKeyState(snapshot, "candidates");
      if (!candState.present) {
        out.candidates = [];
      } else {
        if (!candState.data) throw genericTypeError();
        var rawCands = candState.value;
        if (rawCands == null) {
          out.candidates = [];
        } else {
          if (!safeIsArray(rawCands)) throw genericTypeError();
          var lenState = ownKeyState(rawCands, "length");
          if (!lenState.present || !lenState.data || !isNonnegInt(lenState.value)) {
            throw genericTypeError();
          }
          var len = lenState.value;
          if (len > MAX_CANDIDATE_ENTRIES) throw genericTypeError();
          var cands = [];
          for (var i = 0; i < len; i++) {
            var eState = ownKeyState(rawCands, String(i));
            if (!eState.present || !eState.data) throw genericTypeError();
            var entry = eState.value;
            if (entry == null || typeof entry !== "object") throw genericTypeError();
            var kind = readOptionalOwnString(entry, "kind");
            var value = readOptionalOwnString(entry, "value");
            if (typeof kind !== "string" || typeof value !== "string") {
              throw genericTypeError();
            }
            if (hasControlChars(kind) || hasControlChars(value)) throw genericTypeError();
            cands.push({ kind: kind, value: value });
          }
          out.candidates = cands;
        }
      }
      return out;
    }

    /** Required primitive string own-data field (no coercion / toString). */
    function readRequiredOwnString(obj, key) {
      var st = ownKeyState(obj, key);
      if (!st.present || !st.data || typeof st.value !== "string") {
        throw genericTypeError();
      }
      return st.value;
    }

    /** Optional primitive string or null for DOM fields. */
    function readOwnStringOrNull(obj, key) {
      var st = ownKeyState(obj, key);
      if (!st.present) return undefined;
      if (!st.data) throw genericTypeError();
      if (st.value === null) return null;
      if (typeof st.value !== "string") throw genericTypeError();
      return st.value;
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

      /** Transactional now sample used during a capture finalizer call. */
      var transactionalNowSample = null;

      function sampleAndValidateNow() {
        var t = nowFn();
        if (!isValidDateMs(t)) {
          throw genericTypeError();
        }
        return t;
      }

      function safeNow() {
        if (transactionalNowSample !== null) {
          return transactionalNowSample;
        }
        var t = nowFn();
        if (typeof t !== "number" || !Number.isFinite(t)) {
          throw new TypeError("now must return a finite number");
        }
        // Outside a capture transaction, still reject out-of-range samples that
        // would make Date#toISOString throw inside the real finalizer.
        if (!Number.isSafeInteger(t) || Math.abs(t) > DATE_RANGE_ABS_MS) {
          throw genericTypeError();
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
      // Alias for Lease-2 variant URL bindings so capture paths remain the only
      // direct Privacy.createEphemeral call sites in source text.
      var createEphemeralHandle = Privacy.createEphemeral;

      function createDisposableFinalizer() {
        return DetectionFinalizer.createDetectionFinalizer({
          now: safeNow,
          rank: FilenameRanker.rank,
          buildSourceContext: SourceContext.buildSourceContext,
        });
      }

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

      // Empty holders for later leases (no behavior yet).
      var jobsById = new Map();
      var sinkSessions = new Map();
      var proofTokens = new Set();
      var historyEntries = [];
      void jobsById;
      void sinkSessions;
      void proofTokens;
      void historyEntries;

      // --- Lease 2 private ownership maps (no selection resolver) ---
      /** media ID → ordered immutable private variant records */
      var variantsByMediaId = new Map();
      /** media ID → Map of opaque variant ID → private record */
      var variantsByIdByMediaId = new Map();
      /** opaque variant ID → owning media ID */
      var variantOwnerById = new Map();
      /** media ID → in-flight registration marker */
      var variantRegistrationInFlight = new Map();
      /**
       * media ID → frozen provider-observation evidence {status, providerKey}.
       * Capture-time copy only; never authority for later origin-only work.
       */
      var providerObservationByMediaId = new Map();

      /**
       * Prepare public ID: invoke randomToken and validate base only.
       * Does not commit namespace counter or issued set (failure-atomic).
       * Reentrant captures may commit other IDs before this prepare commits.
       */
      function preparePublicId(namespace) {
        var raw = randomTokenFn(namespace);
        var base;
        if (isSafeTokenNumber(raw)) {
          base = String(raw);
        } else if (isSafeTokenString(raw)) {
          base = raw;
        } else {
          throw new TypeError("randomToken must return a safe identifier");
        }
        return { namespace: namespace, base: base };
      }

      /**
       * Commit a prepared public ID using the next still-free monotonic suffix.
       * Does not re-invoke randomToken (reentrancy-safe).
       */
      function commitPublicId(prep) {
        var namespace = prep.namespace;
        var base = prep.base;
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

      function discardPublicReservation(/* prep */) {
        // Prepare holds no committed counter/issued entry — nothing to roll back.
      }

      function deriveProviderKey(sourceContext) {
        var raw = null;
        var site = sourceContext && sourceContext.topLevelSite;
        if (typeof site === "string" && site.trim().length > 0) {
          raw = site;
        } else {
          var documentId = sourceContext && sourceContext.documentId;
          if (documentId != null && String(documentId).length > 0) {
            var docKey = String(documentId);
            if (sessionDocIdentity.has(docKey)) {
              raw = sessionDocIdentity.get(docKey);
            } else {
              sessionDocCounter += 1;
              var docId = "document-session:" + sessionDocCounter;
              sessionDocIdentity.set(docKey, docId);
              raw = docId;
            }
          } else {
            var pageKey =
              (sourceContext && sourceContext.topLevelPageUrl) ||
              ("tab:" + String(sourceContext && sourceContext.tabId));
            pageKey = String(pageKey);
            if (sessionPageIdentity.has(pageKey)) {
              raw = sessionPageIdentity.get(pageKey);
            } else {
              sessionPageCounter += 1;
              var pageId = "page-session:" + sessionPageCounter;
              sessionPageIdentity.set(pageKey, pageId);
              raw = pageId;
            }
          }
        }
        var normalized = ProviderRegistryApi.normalizeProviderKey(raw);
        if (typeof normalized === "string" && normalized.length > 0) {
          return normalized;
        }
        return typeof raw === "string" && raw.length > 0 ? raw : "unknown";
      }

      /**
       * One observe+lookup per finalized media ID for usable HTTP(S) origins.
       * Claim before the first registry call. Copies/freeses evidence; never
       * throws to the caller; never retries after claim.
       */
      function observeProviderAssociation(mediaId, sourceContext, providerKey) {
        if (providerObservationByMediaId.has(mediaId)) return;

        var normalizedKey =
          typeof providerKey === "string"
            ? ProviderRegistryApi.normalizeProviderKey(providerKey)
            : "";
        if (typeof normalizedKey !== "string" || normalizedKey.length === 0) {
          providerObservationByMediaId.set(
            mediaId,
            deepFreeze({ status: "none", providerKey: null })
          );
          return;
        }

        var rawOrigin = ownData(sourceContext, "mediaOrigin");
        if (typeof rawOrigin !== "string" || rawOrigin.trim().length === 0) {
          providerObservationByMediaId.set(
            mediaId,
            deepFreeze({ status: "none", providerKey: null })
          );
          return;
        }

        var parsedRaw;
        try {
          parsedRaw = new URL(rawOrigin);
        } catch (e) {
          providerObservationByMediaId.set(
            mediaId,
            deepFreeze({ status: "none", providerKey: null })
          );
          return;
        }
        if (
          parsedRaw.protocol !== "http:" &&
          parsedRaw.protocol !== "https:"
        ) {
          providerObservationByMediaId.set(
            mediaId,
            deepFreeze({ status: "none", providerKey: null })
          );
          return;
        }

        var normalizedOrigin = ProviderRegistryApi.normalizeOrigin(rawOrigin);
        if (
          typeof normalizedOrigin !== "string" ||
          normalizedOrigin.length === 0
        ) {
          providerObservationByMediaId.set(
            mediaId,
            deepFreeze({ status: "none", providerKey: null })
          );
          return;
        }

        var parsedNorm;
        try {
          parsedNorm = new URL(normalizedOrigin);
        } catch (e2) {
          providerObservationByMediaId.set(
            mediaId,
            deepFreeze({ status: "none", providerKey: null })
          );
          return;
        }
        if (
          parsedNorm.protocol !== "http:" &&
          parsedNorm.protocol !== "https:"
        ) {
          providerObservationByMediaId.set(
            mediaId,
            deepFreeze({ status: "none", providerKey: null })
          );
          return;
        }

        // Claim before the first registry call (reentrancy-safe).
        providerObservationByMediaId.set(
          mediaId,
          deepFreeze({ status: "none", providerKey: null })
        );

        try {
          providerRegistry.observe(normalizedOrigin, normalizedKey);
          var live = providerRegistry.lookup(normalizedOrigin);
          var status =
            live && typeof live.status === "string" ? live.status : "none";
          var pk =
            live && Object.prototype.hasOwnProperty.call(live, "providerKey")
              ? live.providerKey
              : null;
          if (status !== "none" && status !== "one" && status !== "ambiguous") {
            status = "none";
            pk = null;
          }
          if (status === "one") {
            if (typeof pk !== "string" || pk.length === 0) {
              status = "none";
              pk = null;
            }
          } else {
            pk = null;
          }
          providerObservationByMediaId.set(
            mediaId,
            deepFreeze({ status: status, providerKey: pk })
          );
        } catch (regErr) {
          providerObservationByMediaId.set(
            mediaId,
            deepFreeze({ status: "none", providerKey: null })
          );
          reportSafeDiagnostic("provider-observe-failed", mediaId);
        }
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
        var safeVariants = copySafeVariantProjections(
          variantsByMediaId.get(record.mediaId)
        );
        return deepFreeze({
          id: record.mediaId,
          proposedFilename: record.proposedFilename,
          kind: record.mediaKind,
          variants: safeVariants,
        });
      }

      function bindDetectionId(detectionId, mediaId) {
        if (!isPositiveSafeInteger(detectionId)) {
          throw new TypeError("detection id must be a positive safe integer");
        }
        if (detectionIdToMediaId.has(detectionId)) {
          throw new TypeError("detection id collision");
        }
        detectionIdToMediaId.set(detectionId, mediaId);
      }

      function reconcile() {
        var items = finalizer.listFinalized();
        for (var i = 0; i < items.length; i++) {
          var item = items[i];
          if (!item) continue;
          // Exact finalizer numeric ID — never bitwise-coerce.
          var detId = item.detectionId;
          if (!isPositiveSafeInteger(detId)) continue;
          if (reconciledDetectionIds.has(detId)) continue;

          var mediaId = detectionIdToMediaId.get(detId);
          if (mediaId == null) continue;

          var pending = pendingByMediaId.get(mediaId);
          var mediaKind =
            pending && pending.mediaKind ? pending.mediaKind : "direct";
          var ephemeral = pending && pending.ephemeral ? pending.ephemeral : null;
          var futureTransport =
            pending && pending.futureTransport ? pending.futureTransport : null;
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
          // Private future-transport evidence — non-enumerable.
          if (futureTransport) {
            installFutureTransport(record, futureTransport);
          }
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

          // One session ProviderRegistry observation after safe publication so a
          // registry fault cannot roll back an already-finalized item.
          observeProviderAssociation(mediaId, sourceContext, providerKey);
        }
      }

      function captureNetwork(input) {
        if (!input || typeof input !== "object") {
          throw new TypeError("captureNetwork input must be an object");
        }
        // Snapshot/validate named own-data fields before any dependency boundary.
        var detailsState = ownKeyState(input, "details");
        if (!detailsState.present || !detailsState.data) throw genericTypeError();
        var hintsState = ownKeyState(input, "hints");
        if (!hintsState.present || !hintsState.data) throw genericTypeError();
        var transportState = ownKeyState(input, "transport");
        if (!transportState.present || !transportState.data) {
          throw new TypeError("transport must be an object");
        }

        var safeDetails = snapshotNetworkDetails(detailsState.value);
        var safeHints = snapshotNetworkHints(hintsState.value);
        var transport = validateTransport(transportState.value);

        var mapped = DetectionFinalizer.mapWebRequestDetails(safeDetails, safeHints);
        var mediaKind = transport.mediaKind;
        var requestHeaders = transport.requestHeaders;
        var futureTransport = transport.futureTransport;

        var mediaUrlForEph =
          typeof mapped.mediaUrl === "string" && mapped.mediaUrl
            ? mapped.mediaUrl
            : "about:blank";
        // Privacy on the prevalidated header copy before any shared allocator work.
        var ephemeral = Privacy.createEphemeral(mediaUrlForEph, requestHeaders);

        // Sample/validate now before token or shared finalizer mutation.
        var nowSample = sampleAndValidateNow();
        var prevNowSample = transactionalNowSample;
        transactionalNowSample = nowSample;
        var prep;
        var detectionId;
        try {
          // Disposable preflight for deterministic finalizer failures.
          try {
            var preflight = createDisposableFinalizer();
            preflight.beginNetworkDetection(mapped);
          } catch (preErr) {
            throw genericTypeError();
          }

          // Prepare opaque reservation only after Privacy/time/preflight succeed.
          prep = preparePublicId("media");

          try {
            detectionId = finalizer.beginNetworkDetection(mapped);
          } catch (finErr) {
            discardPublicReservation(prep);
            throw genericTypeError();
          }
        } finally {
          transactionalNowSample = prevNowSample;
        }

        if (!isPositiveSafeInteger(detectionId)) {
          discardPublicReservation(prep);
          throw new TypeError("detection id must be a positive safe integer");
        }
        if (detectionIdToMediaId.has(detectionId)) {
          discardPublicReservation(prep);
          throw new TypeError("detection id collision");
        }

        // Commit public ID only after real finalizer returns a positive safe integer.
        var mediaId = commitPublicId(prep);
        var pendingTabId = typeof mapped.tabId === "number" ? mapped.tabId : 0;

        // Enumerable pending metadata is exactly these four fields.
        var pending = {
          detectionId: detectionId,
          ephemeral: ephemeral,
          mediaKind: mediaKind,
          tabId: pendingTabId,
        };
        installFutureTransport(pending, futureTransport);
        // Install mapping/pending before reconcile (finalizer may already be finalized).
        pendingByMediaId.set(mediaId, pending);
        detectionIdToMediaId.set(detectionId, mediaId);

        reconcile();
        return mediaId;
      }

      function acceptPageSnapshot(snapshot) {
        if (snapshot == null) {
          finalizer.provideDocumentSnapshot(snapshot);
          reconcile();
          return undefined;
        }
        var safe = snapshotDocumentSnapshot(snapshot);
        finalizer.provideDocumentSnapshot(safe);
        reconcile();
        return undefined;
      }

      function captureDomMedia(input) {
        if (!input || typeof input !== "object") {
          throw new TypeError("captureDomMedia input must be an object");
        }
        // Validate/snapshot all inputs before minting opaque IDs or binding state.
        var transportState = ownKeyState(input, "transport");
        if (!transportState.present || !transportState.data) {
          throw new TypeError("transport must be an object");
        }
        var transport = validateTransport(transportState.value);
        var mediaKind = transport.mediaKind;
        var requestHeaders = transport.requestHeaders;
        var futureTransport = transport.futureTransport;

        var mediaUrl = requireNonblankControlFreeString(
          readRequiredOwnString(input, "mediaUrl")
        );
        var mediaOrigin = readOwnStringOrNull(input, "mediaOrigin");
        if (mediaOrigin === undefined) mediaOrigin = "";
        if (mediaOrigin != null && hasControlChars(mediaOrigin)) throw genericTypeError();
        var contentDisposition = readOwnStringOrNull(input, "contentDisposition");
        if (contentDisposition === undefined) contentDisposition = null;
        if (contentDisposition != null && hasControlChars(contentDisposition)) {
          throw genericTypeError();
        }
        var referrerUrl = readOwnStringOrNull(input, "referrerUrl");
        if (referrerUrl === undefined) referrerUrl = "";
        if (referrerUrl != null && hasControlChars(referrerUrl)) throw genericTypeError();
        var frameOrigin = readOwnStringOrNull(input, "frameOrigin");
        if (frameOrigin === undefined) frameOrigin = "";
        if (frameOrigin != null && hasControlChars(frameOrigin)) throw genericTypeError();
        var ts = readOptionalOwnNumber(input, "ts");
        if (ts === undefined) ts = 0;
        if (!isValidDateMs(ts)) throw genericTypeError();

        var snapState = ownKeyState(input, "snapshot");
        if (!snapState.present || !snapState.data) throw genericTypeError();
        var safeSnapshot = snapshotDocumentSnapshot(snapState.value);

        // Privacy before any shared ID / finalizer mutation.
        var ephemeral = Privacy.createEphemeral(mediaUrl, requestHeaders);

        // Sample/validate now before token/finalizer (needed when capturedAt absent).
        var nowSample = sampleAndValidateNow();

        var domInput = {
          snapshot: safeSnapshot,
          mediaUrl: mediaUrl,
          mediaOrigin: mediaOrigin == null ? "" : mediaOrigin,
          contentDisposition: contentDisposition,
          referrerUrl: referrerUrl == null ? "" : referrerUrl,
          frameOrigin: frameOrigin == null ? "" : frameOrigin,
          ts: ts,
        };

        var prevNowSample = transactionalNowSample;
        transactionalNowSample = nowSample;
        var prep;
        var item;
        try {
          // Disposable preflight so deterministic date/rank/source failures run first.
          try {
            var preflight = createDisposableFinalizer();
            preflight.finalizeFromDom(domInput);
          } catch (preErr) {
            throw genericTypeError();
          }

          prep = preparePublicId("media");

          try {
            item = finalizer.finalizeFromDom(domInput);
          } catch (finErr) {
            discardPublicReservation(prep);
            throw genericTypeError();
          }
        } finally {
          transactionalNowSample = prevNowSample;
        }

        var detectionId = item && item.detectionId;
        if (!isPositiveSafeInteger(detectionId)) {
          discardPublicReservation(prep);
          throw new TypeError("detection id must be a positive safe integer");
        }
        if (detectionIdToMediaId.has(detectionId)) {
          discardPublicReservation(prep);
          throw new TypeError("detection id collision");
        }

        var mediaId = commitPublicId(prep);
        bindDetectionId(detectionId, mediaId);
        var pendingTabId =
          item.sourceContext && typeof item.sourceContext.tabId === "number"
            ? item.sourceContext.tabId
            : 0;
        var pending = {
          detectionId: detectionId,
          ephemeral: ephemeral,
          mediaKind: mediaKind,
          tabId: pendingTabId,
        };
        installFutureTransport(pending, futureTransport);
        pendingByMediaId.set(mediaId, pending);

        reconcile();
        return mediaId;
      }

      function registerVariants(mediaId, variants) {
        // 1. Owned media ID only — fail before touching variants.
        if (typeof mediaId !== "string") throw variantRegError();
        var owned =
          pendingByMediaId.has(mediaId) || sourcesByMediaId.has(mediaId);
        if (!owned) throw variantRegError();

        // 2. Completed nonempty set → fresh frozen copy; never inspect variants.
        var existing = variantsByMediaId.get(mediaId);
        if (existing && existing.length > 0) {
          return copySafeVariantProjections(existing);
        }

        // 3. In-flight transaction for this media.
        if (variantRegistrationInFlight.get(mediaId) === true) {
          throw variantRegError();
        }

        // 4. Validate and snapshot the complete input before token/Privacy/mutation.
        var validated;
        try {
          validated = snapshotVariantRegistrationInput(variants);
        } catch (e) {
          if (e && e.message === VARIANT_REG_MSG && e instanceof TypeError) {
            throw e;
          }
          throw variantRegError();
        }

        // Empty valid input: return current safe set (possibly []); leave open.
        if (validated.length === 0) {
          return copySafeVariantProjections(existing);
        }

        // Mark in-flight only after complete structural validation, before
        // the first token/Privacy callback.
        variantRegistrationInFlight.set(mediaId, true);
        try {
          // Prepare all variant IDs (token only; no commit) then all Privacy handles.
          var preps = [];
          var i;
          for (i = 0; i < validated.length; i++) {
            preps.push(preparePublicId("variant"));
          }
          var handles = [];
          for (i = 0; i < validated.length; i++) {
            handles.push(createEphemeralHandle(validated[i].url, null));
          }

          // Commit IDs + ownership maps in one callback-free critical section.
          var privateList = [];
          var byId = new Map();
          for (i = 0; i < validated.length; i++) {
            var vid = commitPublicId(preps[i]);
            var safe = projectSafeVariantRow(vid, validated[i]);
            var privateRec = {
              safeProjection: safe,
              sourceHandle: handles[i],
            };
            Object.freeze(privateRec);
            privateList.push(privateRec);
            byId.set(vid, privateRec);
            variantOwnerById.set(vid, mediaId);
          }
          Object.freeze(privateList);
          variantsByMediaId.set(mediaId, privateList);
          variantsByIdByMediaId.set(mediaId, byId);
          return copySafeVariantProjections(privateList);
        } catch (err) {
          // Preserve dependency-callback error identity (randomToken/Privacy).
          // No partial ownership: maps untouched; uncommitted preps hold no IDs.
          throw err;
        } finally {
          variantRegistrationInFlight.delete(mediaId);
        }
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
