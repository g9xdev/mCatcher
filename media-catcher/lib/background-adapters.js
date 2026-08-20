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

    function resolveDownloadMessageRouter() {
      if (isCommonJsActive()) return require("./download-message-router.js");
      if (root && root.McDownloadMessageRouter) return root.McDownloadMessageRouter;
      throw new Error("McDownloadMessageRouter is required for BackgroundAdapters");
    }

    function resolveDownloadScheduler() {
      if (isCommonJsActive()) return require("./download-scheduler.js");
      if (root && root.McDownloadScheduler) return root.McDownloadScheduler;
      throw new Error("McDownloadScheduler is required for BackgroundAdapters");
    }

    function resolveNativeResultAdapter() {
      if (isCommonJsActive()) return require("./native-result-adapter.js");
      if (root && root.McNativeResultAdapter) return root.McNativeResultAdapter;
      throw new Error("McNativeResultAdapter is required for BackgroundAdapters");
    }

    function resolveFileSinkProtocol() {
      if (isCommonJsActive()) return require("./file-sink-protocol.js");
      if (root && root.McFileSinkProtocol) return root.McFileSinkProtocol;
      throw new Error("McFileSinkProtocol is required for BackgroundAdapters");
    }

    function resolveFailureClassify() {
      if (isCommonJsActive()) return require("./failure-classify.js");
      if (root && root.McFailureClassify) return root.McFailureClassify;
      throw new Error("McFailureClassify is required for BackgroundAdapters");
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
    var VARIANT_REG_MSG = "invalid media variant registration";
    var MAX_HEADER_ENTRIES = 64;
    var MAX_CANDIDATE_ENTRIES = 64;
    var MAX_TRANSPORT_ENTRIES = 64;
    var MAX_TRANSPORT_FIELDS = 16;
    var MAX_VARIANT_ENTRIES = 64;
    var MAX_VARIANT_LABEL_UNITS = 128;
    var MAX_VARIANT_MIME_LEN = 127;
    var DATE_RANGE_ABS_MS = 8.64e15;
    var VARIANT_MIME_RE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
    var VARIANT_SENSITIVE_WORD_RE =
      /(?:^|[^A-Za-z0-9])(?:cookie|authorization|bearer|token|signature|sig|expires)(?![A-Za-z0-9])/i;

    function genericTypeError() {
      return new TypeError(GENERIC_INPUT_MSG);
    }

    function variantTypeError() {
      return new TypeError(VARIANT_REG_MSG);
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

    /** Variant-registration reflection helpers — always throw VARIANT_REG_MSG. */
    function safeIsArrayVariant(v) {
      try {
        return Array.isArray(v);
      } catch (e) {
        throw variantTypeError();
      }
    }

    function safeGetPrototypeOfVariant(v) {
      try {
        return Object.getPrototypeOf(v);
      } catch (e) {
        throw variantTypeError();
      }
    }

    function safeOwnPropertyNamesVariant(v) {
      try {
        return Object.getOwnPropertyNames(v);
      } catch (e) {
        throw variantTypeError();
      }
    }

    function safeOwnPropertySymbolsVariant(v) {
      try {
        return Object.getOwnPropertySymbols(v);
      } catch (e) {
        throw variantTypeError();
      }
    }

    function ownKeyStateVariant(obj, key) {
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
        throw variantTypeError();
      }
    }

    function safeGetOwnPropertyDescriptorVariant(obj, key) {
      try {
        return Object.getOwnPropertyDescriptor(obj, key);
      } catch (e) {
        throw variantTypeError();
      }
    }

    /**
     * Exact ordered own string names of a realm's intrinsic Object.prototype.
     * Used only as a guarded descriptor fingerprint — never as session state.
     */
    var FOREIGN_OBJECT_PROTOTYPE_OWN_NAMES = Object.freeze([
      "constructor",
      "__defineGetter__",
      "__defineSetter__",
      "hasOwnProperty",
      "__lookupGetter__",
      "__lookupSetter__",
      "isPrototypeOf",
      "propertyIsEnumerable",
      "toString",
      "valueOf",
      "__proto__",
      "toLocaleString",
    ]);

    function isExactObjectPrototypeDataMethodDesc(desc) {
      if (!desc) return false;
      if (
        !Object.prototype.hasOwnProperty.call(desc, "value") ||
        !Object.prototype.hasOwnProperty.call(desc, "writable") ||
        !Object.prototype.hasOwnProperty.call(desc, "enumerable") ||
        !Object.prototype.hasOwnProperty.call(desc, "configurable")
      ) {
        return false;
      }
      if (
        Object.prototype.hasOwnProperty.call(desc, "get") ||
        Object.prototype.hasOwnProperty.call(desc, "set")
      ) {
        return false;
      }
      return (
        desc.writable === true &&
        desc.enumerable === false &&
        desc.configurable === true &&
        typeof desc.value === "function"
      );
    }

    function isExactObjectPrototypeProtoAccessorDesc(desc) {
      if (!desc) return false;
      if (
        !Object.prototype.hasOwnProperty.call(desc, "get") ||
        !Object.prototype.hasOwnProperty.call(desc, "set") ||
        !Object.prototype.hasOwnProperty.call(desc, "enumerable") ||
        !Object.prototype.hasOwnProperty.call(desc, "configurable")
      ) {
        return false;
      }
      if (
        Object.prototype.hasOwnProperty.call(desc, "value") ||
        Object.prototype.hasOwnProperty.call(desc, "writable")
      ) {
        return false;
      }
      return (
        desc.enumerable === false &&
        desc.configurable === true &&
        typeof desc.get === "function" &&
        typeof desc.set === "function"
      );
    }

    /**
     * Guarded descriptor fingerprint of a foreign realm's intrinsic Object.prototype.
     * Does not invoke any descriptor value/get/set and never compares function identity.
     */
    function isForeignIntrinsicObjectPrototype(proto) {
      var names = safeOwnPropertyNamesVariant(proto);
      if (names.length !== FOREIGN_OBJECT_PROTOTYPE_OWN_NAMES.length) return false;
      for (var i = 0; i < FOREIGN_OBJECT_PROTOTYPE_OWN_NAMES.length; i++) {
        if (names[i] !== FOREIGN_OBJECT_PROTOTYPE_OWN_NAMES[i]) return false;
      }
      var symbols = safeOwnPropertySymbolsVariant(proto);
      if (symbols.length !== 0) return false;
      for (var j = 0; j < FOREIGN_OBJECT_PROTOTYPE_OWN_NAMES.length; j++) {
        var name = FOREIGN_OBJECT_PROTOTYPE_OWN_NAMES[j];
        var desc = safeGetOwnPropertyDescriptorVariant(proto, name);
        if (name === "__proto__") {
          if (!isExactObjectPrototypeProtoAccessorDesc(desc)) return false;
        } else if (!isExactObjectPrototypeDataMethodDesc(desc)) {
          return false;
        }
      }
      return true;
    }

    /**
     * Realm-neutral plain entry: direct null-prototype, local Object.prototype,
     * or a foreign ordinary entry whose immediate prototype fingerprints as that
     * realm's intrinsic Object.prototype. Rejects arrays, views, functions, host
     * objects with longer chains, and null-root custom/stealth prototypes.
     */
    function isRealmNeutralPlainVariantEntry(v) {
      if (v === null || typeof v !== "object") return false;
      if (safeIsArrayVariant(v)) return false;
      try {
        if (
          typeof ArrayBuffer === "function" &&
          typeof ArrayBuffer.isView === "function" &&
          ArrayBuffer.isView(v)
        ) {
          return false;
        }
      } catch (e) {
        throw variantTypeError();
      }
      var proto = safeGetPrototypeOfVariant(v);
      if (proto === null) return true;
      if (proto === Object.prototype) return true;
      var grand = safeGetPrototypeOfVariant(proto);
      if (grand !== null) return false;
      return isForeignIntrinsicObjectPrototype(proto);
    }

    /**
     * Dense built-in Array shell for registerVariants. Same rules as denseArrayLength
     * but every reflection failure is a variant registration TypeError.
     */
    function denseVariantArrayLength(raw) {
      if (!safeIsArrayVariant(raw)) throw variantTypeError();
      var symbols = safeOwnPropertySymbolsVariant(raw);
      if (symbols.length > 0) throw variantTypeError();
      var names = safeOwnPropertyNamesVariant(raw);
      var lenState = ownKeyStateVariant(raw, "length");
      if (
        !lenState.present ||
        !lenState.data ||
        !isNonnegSafeInt(lenState.value)
      ) {
        throw variantTypeError();
      }
      var len = lenState.value;
      if (len > MAX_VARIANT_ENTRIES) throw variantTypeError();
      var allowed = Object.create(null);
      allowed.length = true;
      for (var i = 0; i < len; i++) {
        allowed[String(i)] = true;
      }
      for (var n = 0; n < names.length; n++) {
        if (allowed[names[n]] !== true) throw variantTypeError();
      }
      for (var j = 0; j < len; j++) {
        var eState = ownKeyStateVariant(raw, String(j));
        if (!eState.present || !eState.data) throw variantTypeError();
      }
      return len;
    }

    /**
     * Required variant URL: primitive, nonblank (not all-whitespace), C0/DEL/C1-free,
     * absolute http(s). Preserves exact original spelling (leading spaces allowed).
     */
    function requireVariantHttpUrl(value) {
      if (typeof value !== "string") throw variantTypeError();
      if (value.trim().length === 0) throw variantTypeError();
      if (hasControlChars(value)) throw variantTypeError();
      var parsed;
      try {
        parsed = new URL(value);
      } catch (e) {
        throw variantTypeError();
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw variantTypeError();
      }
      return value;
    }

    function isUnsafeVariantLabel(trimmed) {
      if (hasControlChars(trimmed)) return true;
      if (trimmed.indexOf("://") !== -1) return true;
      if (trimmed.length >= 2 && trimmed.charAt(0) === "/" && trimmed.charAt(1) === "/") {
        return true;
      }
      if (/cookie\s*:/i.test(trimmed)) return true;
      if (/set-cookie\s*:/i.test(trimmed)) return true;
      if (/proxy-authorization\s*:/i.test(trimmed)) return true;
      if (/authorization\s*:/i.test(trimmed)) return true;
      if (/bearer\s/i.test(trimmed)) return true;
      if (VARIANT_SENSITIVE_WORD_RE.test(trimmed)) return true;
      return false;
    }

    /**
     * Optional own-data label → safe truncated string or undefined (omit).
     * Known-field accessors reject. Non-string/null/undefined omit without coercion.
     */
    function readOptionalVariantLabel(entry) {
      var st = ownKeyStateVariant(entry, "label");
      if (!st.present) return undefined;
      if (!st.data) throw variantTypeError();
      if (st.value === undefined || st.value === null) return undefined;
      if (typeof st.value !== "string") return undefined;
      var trimmed = st.value.trim();
      if (trimmed.length === 0) return undefined;
      if (isUnsafeVariantLabel(trimmed)) return undefined;
      if (trimmed.length > MAX_VARIANT_LABEL_UNITS) {
        return trimmed.slice(0, MAX_VARIANT_LABEL_UNITS);
      }
      return trimmed;
    }

    function readOptionalVariantPositiveInt(entry, key) {
      var st = ownKeyStateVariant(entry, key);
      if (!st.present) return undefined;
      if (!st.data) throw variantTypeError();
      if (isPositiveSafeInteger(st.value)) return st.value;
      return undefined;
    }

    function readOptionalVariantMime(entry) {
      var st = ownKeyStateVariant(entry, "mime");
      if (!st.present) return undefined;
      if (!st.data) throw variantTypeError();
      if (st.value === undefined || st.value === null) return undefined;
      if (typeof st.value !== "string") return undefined;
      var trimmed = st.value.trim();
      if (trimmed.length === 0 || trimmed.length > MAX_VARIANT_MIME_LEN) {
        return undefined;
      }
      if (!VARIANT_MIME_RE.test(trimmed)) return undefined;
      return trimmed;
    }

    /**
     * Validate complete variants input into plain snapshots before any token/Privacy.
     * Inspects only the six known entry fields; unknown names are ignored unread.
     */
    function validateVariantRegistrationInput(variants) {
      var len = denseVariantArrayLength(variants);
      var out = [];
      for (var i = 0; i < len; i++) {
        var eState = ownKeyStateVariant(variants, String(i));
        // denseVariantArrayLength already proved present own-data indices.
        var entry = eState.value;
        if (!isRealmNeutralPlainVariantEntry(entry)) throw variantTypeError();

        var urlState = ownKeyStateVariant(entry, "url");
        if (!urlState.present || !urlState.data) throw variantTypeError();
        var url = requireVariantHttpUrl(urlState.value);

        var snap = { url: url };
        var label = readOptionalVariantLabel(entry);
        if (label !== undefined) snap.label = label;
        var width = readOptionalVariantPositiveInt(entry, "width");
        if (width !== undefined) snap.width = width;
        var height = readOptionalVariantPositiveInt(entry, "height");
        if (height !== undefined) snap.height = height;
        var bandwidth = readOptionalVariantPositiveInt(entry, "bandwidth");
        if (bandwidth !== undefined) snap.bandwidth = bandwidth;
        var mime = readOptionalVariantMime(entry);
        if (mime !== undefined) snap.mime = mime;
        out.push(snap);
      }
      return out;
    }

    function buildSafeVariantProjection(id, snap) {
      var row = { id: id };
      if (Object.prototype.hasOwnProperty.call(snap, "label")) row.label = snap.label;
      if (Object.prototype.hasOwnProperty.call(snap, "width")) row.width = snap.width;
      if (Object.prototype.hasOwnProperty.call(snap, "height")) row.height = snap.height;
      if (Object.prototype.hasOwnProperty.call(snap, "bandwidth")) {
        row.bandwidth = snap.bandwidth;
      }
      if (Object.prototype.hasOwnProperty.call(snap, "mime")) row.mime = snap.mime;
      return deepFreeze(row);
    }

    function projectSafeVariantRows(orderedRecords) {
      // new Array() uses the active global Array binding (host Array under the
      // classic-script test harness) so strict deepEqual against host [] works.
      var out = new Array();
      if (!orderedRecords) return deepFreeze(out);
      for (var i = 0; i < orderedRecords.length; i++) {
        out.push(freezeClone(orderedRecords[i].safeProjection));
      }
      return deepFreeze(out);
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

      var settings = {
        maxConcurrent: maxConcurrent,
        segmentConcurrency: segmentConcurrency,
        retries: retries,
      };
      void createObjectURL;
      void revokeObjectURL;
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

      var scheduler = null;
      var MessageRouter = null;
      var NativeResultAdapter = null;
      var FileSinkProtocol = null;
      var FailureClassify = null;
      // Authoritative popup proof is bound to one direct job and consumed only
      // by the scheduler. It is never projected or returned to popup callers.
      var popupTokenStore = new Map();
      var firefoxHandoffRequests = new Set();

      function getMessageRouter() {
        if (!MessageRouter) MessageRouter = resolveDownloadMessageRouter();
        return MessageRouter;
      }

      function getNativeResultAdapter() {
        if (!NativeResultAdapter) NativeResultAdapter = resolveNativeResultAdapter();
        return NativeResultAdapter;
      }

      function getFileSinkProtocol() {
        if (!FileSinkProtocol) FileSinkProtocol = resolveFileSinkProtocol();
        return FileSinkProtocol;
      }

      function getFailureClassify() {
        if (!FailureClassify) FailureClassify = resolveFailureClassify();
        return FailureClassify;
      }

      function getScheduler() {
        if (!scheduler) {
          scheduler = resolveDownloadScheduler().createDownloadScheduler({
            maxConcurrent: settings.maxConcurrent,
            now: safeNow,
            randomToken: randomTokenFn,
            popupTokenStore: popupTokenStore,
            firefoxDownload: function (adapterInput) {
              var binding = jobBindings.get(adapterInput.jobId);
              if (!binding) throw genericTypeError();
              var tokenStore = new Set([adapterInput.intent.userActionToken]);
              var guardInput = {
                intent: adapterInput.intent,
                tokenStore: tokenStore,
              };
              if (binding.mediaKind === "direct") {
                guardInput.source = {
                  type: "url",
                  getUrl: function () {
                    return readEphemeralUrl(adapterInput.sourceHandle);
                  },
                };
              } else if (isAssembledKind(binding.mediaKind) && binding.assembled) {
                guardInput.filename = assembledFilename(
                  binding.intent.requestedFilename,
                  binding.assembled.extension
                );
                guardInput.source = {
                  type: "bytes",
                  bytes: binding.assembled.bytes,
                  mime: binding.assembled.mime,
                };
              } else {
                throw genericTypeError();
              }
              return firefoxGuard.downloadWithFirefox(guardInput);
            },
          });
        }
        return scheduler;
      }

      var finalizer = DetectionFinalizer.createDetectionFinalizer({
        now: safeNow,
        rank: FilenameRanker.rank,
        buildSourceContext: SourceContext.buildSourceContext,
      });

      var providerRegistry = ProviderRegistryApi.createProviderRegistry();
      void providerRegistry;
      // Capture-path factory alias for variant URL handles (keeps BA04 site count).
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
      var sinkTransfersById = new Map();
      var proofTokens = new Set();
      var historyEntries = [];
      void jobsById;
      void proofTokens;
      void historyEntries;

      // Lease-2 variant ownership (Batch 1). Provider observation stays dormant empty.
      /** @type {Map<string, object[]>} media ID → ordered private variant records */
      var variantsOrderedByMediaId = new Map();
      /** @type {Map<string, Map<string, object>>} media ID → variant ID → private record */
      var variantsByIdByMediaId = new Map();
      /** @type {Map<string, string>} opaque variant ID → owning media ID */
      var variantOwnerById = new Map();
      /** @type {Map<string, boolean>} media ID → registration in-flight marker */
      var variantRegInFlight = new Map();
      /** @type {Map<string, object>} media ID → provider-observation evidence (Batch 2) */
      var providerObservationByMediaId = new Map();
      /** @type {Map<string, object>} opaque job ID → private start binding */
      var jobBindings = new Map();
      /** @type {Set<string>} jobId\\0attemptToken already posted */
      var startedAttempts = new Set();
      /** @type {Set<string>} jobId\0attemptToken already switched to pget-single */
      var singleStartedAttempts = new Set();
      /** @type {Set<string>} direct running jobs with a cancel command in flight */
      var pendingDirectCancels = new Set();

      function isAssembledKind(kind) {
        return kind === "hls" || kind === "dash";
      }

      function releaseLocalOnce(transfer) {
        if (!transfer) return false;
        if (transfer.localReleased) return true;
        var released = transfer.localLease.release();
        if (released === true) transfer.localReleased = true;
        return released;
      }

      function clearAssembledBytes(binding) {
        if (binding) delete binding.assembled;
      }

      function clearSinkTransfer(transfer, clearBytes) {
        if (!transfer) return;
        transfer.settled = true;
        if (sinkSessions.get(transfer.jobId) === transfer) {
          sinkSessions.delete(transfer.jobId);
        }
        if (
          transfer.session &&
          transfer.session.sinkId &&
          sinkTransfersById.get(transfer.session.sinkId) === transfer
        ) {
          sinkTransfersById.delete(transfer.session.sinkId);
        }
        if (clearBytes) clearAssembledBytes(transfer.binding);
        transfer.bytes = null;
        transfer.session = null;
      }

      function copyAssemblyResult(result) {
        if (!result || typeof result !== "object") return null;
        var bytes = ownData(result, "bytes");
        var mime = ownData(result, "mime");
        var extension = ownData(result, "extension");
        if (!(bytes instanceof Uint8Array)) return null;
        if (typeof mime !== "string" || mime.trim().length === 0 || hasControlChars(mime)) {
          return null;
        }
        if (
          typeof extension !== "string" ||
          !/^[A-Za-z0-9]{1,8}$/.test(extension)
        ) {
          return null;
        }
        var copy = new Uint8Array(bytes.length);
        copy.set(bytes);
        return Object.freeze({ bytes: copy, mime: mime, extension: extension });
      }

      function assembledFilename(requestedFilename, extension) {
        if (/\.(?:m3u8|mpd)$/i.test(requestedFilename)) {
          return requestedFilename.replace(/\.(?:m3u8|mpd)$/i, "." + extension);
        }
        if (requestedFilename.lastIndexOf(".") <= 0) {
          return requestedFilename + "." + extension;
        }
        return requestedFilename;
      }

      function updateAssemblyProgress(transfer, progress) {
        if (!transfer || transfer.settled || !progress || typeof progress !== "object") {
          return;
        }
        var done = ownData(progress, "done");
        if (done === undefined) done = ownData(progress, "bytes");
        var total = ownData(progress, "total");
        if (!isNonnegInt(done) || !isNonnegInt(total) || done > total) return;
        var old = transfer.binding.progress;
        if (old && (done < old.done || total < old.total)) return;
        var beforeSig = jobAdmissionSig();
        transfer.binding.progress = Object.freeze({ done: done, total: total });
        publishJobsIfChanged(beforeSig);
      }

      function waitForAssemblyFetches(transfer) {
        var pending = Array.from(transfer.fetches);
        return Promise.all(
          pending.map(function (promise) {
            return Promise.resolve(promise).then(
              function () {},
              function () {}
            );
          })
        );
      }

      function guardedAssemblyFetch(transfer, args) {
        if (
          transfer.assemblySettled ||
          transfer.settled ||
          !getScheduler().isAttemptActive(transfer.jobId, transfer.attemptToken)
        ) {
          return Promise.reject(Object.freeze({ cancelled: true }));
        }
        var permit = getScheduler().acquireProviderPermit(
          transfer.jobId,
          "assembly-fetch"
        );
        if (!permit) {
          return Promise.reject(Object.freeze({ failureCategory: "permanent" }));
        }
        var effect;
        try {
          effect = fetchArrayBuffer(
            transfer.binding.tabId,
            args[0],
            args[1]
          );
        } catch (errSync) {
          effect = Promise.reject(errSync);
        }
        var tracked = Promise.resolve(effect).then(
          function (value) {
            var beforeSig = jobAdmissionSig();
            permit.release();
            var afterRelease = getScheduler().getJob(transfer.jobId);
            if (
              transfer.cancelRequested &&
              afterRelease &&
              afterRelease.state === "cancelled"
            ) {
              clearAssembledBytes(transfer.binding);
              popupTokenStore.delete(transfer.jobId);
            }
            publishJobsIfChanged(beforeSig);
            pump();
            return value;
          },
          function (err) {
            var beforeSig = jobAdmissionSig();
            permit.release();
            var afterRelease = getScheduler().getJob(transfer.jobId);
            if (
              transfer.cancelRequested &&
              afterRelease &&
              afterRelease.state === "cancelled"
            ) {
              clearAssembledBytes(transfer.binding);
              popupTokenStore.delete(transfer.jobId);
            }
            publishJobsIfChanged(beforeSig);
            pump();
            throw err;
          }
        );
        transfer.fetches.add(tracked);
        tracked.then(
          function () { transfer.fetches.delete(tracked); },
          function () { transfer.fetches.delete(tracked); }
        );
        return tracked;
      }

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
        var site = ownData(sourceContext, "topLevelSite");
        if (typeof site === "string" && site.trim().length > 0) {
          return site;
        }
        var documentId = ownData(sourceContext, "documentId");
        if (typeof documentId === "string" && documentId.length > 0) {
          var docKey = documentId;
          if (sessionDocIdentity.has(docKey)) {
            return sessionDocIdentity.get(docKey);
          }
          sessionDocCounter += 1;
          var docId = "document-session:" + sessionDocCounter;
          sessionDocIdentity.set(docKey, docId);
          return docId;
        }
        var pageUrl = ownData(sourceContext, "topLevelPageUrl");
        var tabId = ownData(sourceContext, "tabId");
        var pageKey =
          typeof pageUrl === "string" && pageUrl.length > 0
            ? pageUrl
            : "tab:" + (typeof tabId === "number" ? String(tabId) : "unknown");
        if (sessionPageIdentity.has(pageKey)) {
          return sessionPageIdentity.get(pageKey);
        }
        sessionPageCounter += 1;
        var pageId = "page-session:" + sessionPageCounter;
        sessionPageIdentity.set(pageKey, pageId);
        return pageId;
      }

      function normalizeSourceProviderKey(sourceContext) {
        var raw = deriveProviderKey(sourceContext);
        if (typeof raw !== "string" || raw.trim().length === 0) return "";
        try {
          var normalized = ProviderRegistryApi.normalizeProviderKey(raw);
          return typeof normalized === "string" && normalized.trim().length > 0
            ? normalized
            : "";
        } catch (e) {
          return "";
        }
      }

      function normalizedHttpOrigin(sourceContext) {
        var raw = ownData(sourceContext, "mediaOrigin");
        if (
          typeof raw !== "string" ||
          raw.trim().length === 0 ||
          hasControlChars(raw)
        ) {
          return "";
        }
        var parsed;
        try {
          parsed = new URL(raw);
        } catch (e) {
          return "";
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return "";
        }
        var normalized;
        try {
          normalized = ProviderRegistryApi.normalizeOrigin(raw);
        } catch (e) {
          return "";
        }
        if (typeof normalized !== "string" || normalized.length === 0) return "";
        try {
          var normalizedUrl = new URL(normalized);
          if (
            (normalizedUrl.protocol !== "http:" &&
              normalizedUrl.protocol !== "https:") ||
            normalizedUrl.origin !== normalized
          ) {
            return "";
          }
        } catch (e) {
          return "";
        }
        return normalized;
      }

      function providerEvidence(status, providerKey) {
        return Object.freeze({ status: status, providerKey: providerKey });
      }

      function copyProviderEvidence(result, sourceProviderKey) {
        var status = ownData(result, "status");
        var providerKey = ownData(result, "providerKey");
        if (
          status === "one" &&
          providerKey === sourceProviderKey &&
          typeof providerKey === "string"
        ) {
          return providerEvidence("one", providerKey);
        }
        if (status === "ambiguous" && providerKey === null) {
          return providerEvidence("ambiguous", null);
        }
        if (status === "none" && providerKey === null) {
          return providerEvidence("none", null);
        }
        return providerEvidence("none", null);
      }

      /** Claim first; then observe and take one current lookup. Never retries. */
      function observeProviderOnce(mediaId, sourceContext, sourceProviderKey) {
        if (providerObservationByMediaId.has(mediaId)) {
          return providerObservationByMediaId.get(mediaId);
        }
        var none = providerEvidence("none", null);
        providerObservationByMediaId.set(mediaId, none);
        var origin = normalizedHttpOrigin(sourceContext);
        if (!sourceProviderKey || !origin) return none;
        try {
          providerRegistry.observe(origin, sourceProviderKey);
          var evidence = copyProviderEvidence(
            providerRegistry.lookup(origin),
            sourceProviderKey
          );
          providerObservationByMediaId.set(mediaId, evidence);
          return evidence;
        } catch (e) {
          return none;
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
        return deepFreeze({
          id: record.mediaId,
          proposedFilename: record.proposedFilename,
          kind: record.mediaKind,
          variants: projectSafeVariantRows(
            variantsOrderedByMediaId.get(record.mediaId)
          ),
        });
      }

      function mediaOwnsId(mediaId) {
        return pendingByMediaId.has(mediaId) || sourcesByMediaId.has(mediaId);
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
          var providerKey = normalizeSourceProviderKey(sourceContext);
          observeProviderOnce(mediaId, sourceContext, providerKey);

          // A registry callback may have reentered reconciliation and completed
          // this exact detection while the outer association call was in flight.
          if (reconciledDetectionIds.has(detId)) continue;

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

        // Same absolute-http(s) requirement the network lane applies to
        // details.url: the page picks every DOM src, and a non-http(s) one
        // (file://, and especially a file: UNC selector) must never become a
        // capture the helper is later asked to open.
        var mediaUrl = requireAbsoluteHttpUrl(readRequiredOwnString(input, "mediaUrl"));
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
        // 1. Owned primitive media ID before any variants inspection.
        if (typeof mediaId !== "string" || !mediaOwnsId(mediaId)) {
          throw variantTypeError();
        }

        // 2. Completed nonempty set: fresh frozen safe copies, no second-arg read.
        var existingOrdered = variantsOrderedByMediaId.get(mediaId);
        if (existingOrdered && existingOrdered.length > 0) {
          return projectSafeVariantRows(existingOrdered);
        }

        // 3. Same-media in-flight reentry fails without reading variants.
        if (variantRegInFlight.get(mediaId) === true) {
          throw variantTypeError();
        }

        // 4. Full structural validation/snapshot before token, Privacy, or commit.
        var snapshot = validateVariantRegistrationInput(variants);

        // 5. Post-validation same-media recheck: a nested registration may have
        // completed or marked in-flight during caller-controlled reflection.
        // There must be no caller-controlled operation between this recheck and
        // setting the in-flight marker for a nonempty new transaction.
        var completedDuringValidation = variantsOrderedByMediaId.get(mediaId);
        if (completedDuringValidation && completedDuringValidation.length > 0) {
          return projectSafeVariantRows(completedDuringValidation);
        }
        if (variantRegInFlight.get(mediaId) === true) {
          throw variantTypeError();
        }

        if (snapshot.length === 0) {
          return projectSafeVariantRows(existingOrdered);
        }

        variantRegInFlight.set(mediaId, true);
        try {
          // Prepare every token/ID candidate first (no counter/issued commit).
          var preps = [];
          for (var i = 0; i < snapshot.length; i++) {
            preps.push(preparePublicId("variant"));
          }

          // Then every Privacy handle with exact original URL and null headers.
          var handles = [];
          for (var j = 0; j < snapshot.length; j++) {
            handles.push(createEphemeralHandle(snapshot[j].url, null));
          }

          // Callback-free critical section: commit IDs and ownership maps.
          var ordered = [];
          var byId = new Map();
          for (var k = 0; k < snapshot.length; k++) {
            var vid = commitPublicId(preps[k]);
            var safe = buildSafeVariantProjection(vid, snapshot[k]);
            var rec = Object.freeze({
              safeProjection: safe,
              sourceHandle: handles[k],
            });
            ordered.push(rec);
            byId.set(vid, rec);
            variantOwnerById.set(vid, mediaId);
          }
          Object.freeze(ordered);
          variantsOrderedByMediaId.set(mediaId, ordered);
          variantsByIdByMediaId.set(mediaId, byId);
          return projectSafeVariantRows(ordered);
        } finally {
          variantRegInFlight.delete(mediaId);
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

      function readEphemeralUrl(handle) {
        if (!handle || typeof handle !== "object") throw genericTypeError();
        var url;
        try {
          url = handle.mediaUrl;
        } catch (e) {
          throw genericTypeError();
        }
        if (typeof url !== "string" || url.length === 0) throw genericTypeError();
        return url;
      }

      function jobAdmissionSig() {
        return JSON.stringify(projectPopupJobsArray());
      }

      function projectPopupJobsArray() {
        if (!scheduler) return deepFreeze(new Array());
        var snap = scheduler.getSnapshot();
        var jobs = snap.jobs || [];
        var out = new Array();
        for (var i = 0; i < jobs.length; i++) {
          var input = deepClone(jobs[i]);
          var binding = jobBindings.get(jobs[i].id);
          if (binding && binding.progress) input.progress = binding.progress;
          if (binding && binding.mediaId) input.mediaId = binding.mediaId;
          out.push(freezeClone(Privacy.projectPopupJob(input)));
        }
        return deepFreeze(out);
      }

      function publishJobsIfChanged(beforeSig) {
        var afterSig = jobAdmissionSig();
        if (afterSig === beforeSig) return;
        try {
          publishJobs(projectPopupJobsArray());
        } catch (e) {
          reportSafeDiagnostic("publish-jobs-failed", null);
        }
      }

      function projectReturnedJob(jobId) {
        var input = deepClone(getScheduler().getJob(jobId));
        var binding = jobBindings.get(jobId);
        if (binding && binding.mediaId) input.mediaId = binding.mediaId;
        return freezeClone(Privacy.projectPopupJob(input));
      }

      function requirePopupSender(sender) {
        var ok;
        try {
          ok = isPopupSender(sender);
        } catch (e) {
          throw genericTypeError();
        }
        if (ok !== true) throw genericTypeError();
      }

      function readOwnedMediaRecord(message) {
        if (!message || typeof message !== "object") throw genericTypeError();
        var vu = ownKeyState(message, "variantUrl");
        if (vu.present) {
          if (!vu.data) throw genericTypeError();
          if (vu.value !== null && vu.value !== undefined) throw genericTypeError();
        }
        var tabState = ownKeyState(message, "tabId");
        if (!tabState.present || !tabState.data) throw genericTypeError();
        if (!isNonnegInt(tabState.value)) throw genericTypeError();
        var tabId = tabState.value;
        var itemState = ownKeyState(message, "item");
        if (!itemState.present || !itemState.data) throw genericTypeError();
        var item = itemState.value;
        if (!item || typeof item !== "object") throw genericTypeError();
        var idState = ownKeyState(item, "id");
        if (!idState.present || !idState.data) throw genericTypeError();
        if (typeof idState.value !== "string") throw genericTypeError();
        var mediaId = idState.value;
        var record = sourcesByMediaId.get(mediaId);
        if (!record) throw genericTypeError();
        if (record.tabId !== tabId) throw genericTypeError();
        if (
          record.mediaKind !== "direct" &&
          record.mediaKind !== "hls" &&
          record.mediaKind !== "dash"
        ) {
          throw genericTypeError();
        }
        return record;
      }

      function selectSourceHandle(message, record) {
        var vidState = ownKeyState(message, "variantId");
        if (!vidState.present) {
          return { handle: record.ephemeral, selection: null };
        }
        if (!vidState.data) throw genericTypeError();
        if (vidState.value === null || vidState.value === undefined) {
          return { handle: record.ephemeral, selection: null };
        }
        if (typeof vidState.value !== "string" && typeof vidState.value !== "number") {
          throw genericTypeError();
        }
        var variantId = vidState.value;
        var byId = variantsByIdByMediaId.get(record.mediaId);
        var rec = byId ? byId.get(variantId) : null;
        if (!rec) throw genericTypeError();
        return {
          handle: rec.sourceHandle,
          selection: freezeClone(rec.safeProjection),
        };
      }

      function buildSanitizedDownloadMessage(message, record) {
        var typeState = ownKeyState(message, "type");
        var type = "download";
        if (typeState.present) {
          if (!typeState.data) throw genericTypeError();
          if (typeState.value === "download" || typeState.value === "save-as-download") {
            type = typeState.value;
          } else {
            throw genericTypeError();
          }
        }
        var sanitized = {
          type: type,
          tabId: record.tabId,
          item: {
            id: record.mediaId,
            proposedFilename: record.proposedFilename,
            providerKey: record.providerKey,
            kind: record.mediaKind,
            tabId: record.tabId,
          },
        };
        var intentState = ownKeyState(message, "intent");
        if (intentState.present) {
          if (!intentState.data) throw genericTypeError();
          sanitized.intent = intentState.value;
        } else {
          var tokState = ownKeyState(message, "userActionToken");
          if (tokState.present) {
            if (!tokState.data) throw genericTypeError();
            sanitized.userActionToken = tokState.value;
          }
        }
        return sanitized;
      }

      function resolveEffectiveDestination(intent) {
        if (!intent || intent.destinationDirectory !== null) {
          return intent ? intent.destinationDirectory : null;
        }
        var looked;
        try {
          looked = getEffectiveDestinationDirectory();
        } catch (e) {
          throw genericTypeError();
        }
        if (looked === null) return null;
        if (typeof looked !== "string" || looked.trim().length === 0 || hasControlChars(looked)) {
          throw genericTypeError();
        }
        return looked;
      }

      function settleAssembledTransport(transfer, result, clearBytes) {
        if (!transfer || transfer.settled) return false;
        if (!transfer.pendingSettlement) {
          transfer.pendingSettlement = {
            kind: "transport",
            result: result,
            clearBytes: clearBytes === true,
          };
        }
        var pendingSettlement = transfer.pendingSettlement;
        var beforeSig = jobAdmissionSig();
        if (!releaseLocalOnce(transfer)) return false;
        transfer.pendingSettlement = null;
        clearSinkTransfer(transfer, pendingSettlement.clearBytes);
        getScheduler().onTransportResult(
          transfer.jobId,
          transfer.attemptToken,
          pendingSettlement.result
        );
        var settled = getScheduler().getJob(transfer.jobId);
        if (
          settled &&
          (settled.state === "completed" ||
            settled.state === "failed" ||
            settled.state === "cancelled")
        ) {
          popupTokenStore.delete(transfer.jobId);
        }
        publishJobsIfChanged(beforeSig);
        pump();
        return true;
      }

      function settleAssembledUnavailable(transfer) {
        if (!transfer || transfer.settled) return false;
        if (!transfer.pendingSettlement) {
          transfer.pendingSettlement = { kind: "unavailable" };
        }
        var beforeSig = jobAdmissionSig();
        if (!releaseLocalOnce(transfer)) return false;
        transfer.pendingSettlement = null;
        clearSinkTransfer(transfer, false);
        getScheduler().onTransportUnavailable(transfer.jobId);
        var after = getScheduler().getJob(transfer.jobId);
        if (after && after.state === "cancelled") {
          clearAssembledBytes(transfer.binding);
          popupTokenStore.delete(transfer.jobId);
        }
        publishJobsIfChanged(beforeSig);
        pump();
        return true;
      }

      function retryPendingAssembledSettlements() {
        var transfers = Array.from(sinkSessions.values());
        for (var i = 0; i < transfers.length; i++) {
          var transfer = transfers[i];
          if (!transfer || transfer.settled || !transfer.pendingSettlement) continue;
          if (transfer.pendingSettlement.kind === "unavailable") {
            settleAssembledUnavailable(transfer);
          } else {
            settleAssembledTransport(
              transfer,
              transfer.pendingSettlement.result,
              transfer.pendingSettlement.clearBytes
            );
          }
        }
      }

      function postSinkCommands(transfer, commands) {
        if (!transfer || transfer.settled || !commands || commands.length === 0) {
          return Promise.resolve(true);
        }
        var effects = [];
        try {
          for (var i = 0; i < commands.length; i++) {
            effects.push(Promise.resolve(postNative(commands[i])));
          }
        } catch (errSync) {
          settleAssembledUnavailable(transfer);
          return Promise.reject(errSync);
        }
        return Promise.all(effects).then(
          function () { return true; },
          function (errAsync) {
            settleAssembledUnavailable(transfer);
            throw errAsync;
          }
        );
      }

      function nextSinkCommands(transfer) {
        var commands = [];
        if (!transfer || transfer.settled || !transfer.session) return commands;
        if (transfer.abortPosted || transfer.cancelRequested) return commands;
        var protocol = getFileSinkProtocol();
        while (
          transfer.offset < transfer.bytes.length &&
          transfer.session.outstandingCount < protocol.MAX_UNACKED
        ) {
          var end = Math.min(
            transfer.offset + protocol.MAX_CHUNK_BYTES,
            transfer.bytes.length
          );
          var cmd = transfer.session.nextChunkCmd(
            transfer.bytes.subarray(transfer.offset, end)
          );
          if (!cmd) break;
          transfer.offset = end;
          commands.push(cmd);
        }
        if (
          transfer.offset === transfer.bytes.length &&
          transfer.session.outstandingCount === 0 &&
          !transfer.commitPosted &&
          !transfer.abortPosted
        ) {
          var commit = transfer.session.commitCmd();
          if (commit) {
            transfer.commitPosted = true;
            transfer.phase = "committing";
            commands.push(commit);
          }
        }
        return commands;
      }

      function openAssembledSink(transfer) {
        if (
          !transfer ||
          transfer.settled ||
          !getScheduler().isAttemptActive(transfer.jobId, transfer.attemptToken)
        ) {
          return false;
        }
        var retained = transfer.binding.assembled;
        if (!retained) return false;
        transfer.bytes = retained.bytes;
        transfer.session = getFileSinkProtocol().createFileSinkSession({
          jobId: transfer.jobId,
          attemptToken: transfer.attemptToken,
          requestedFilename: assembledFilename(
            transfer.binding.intent.requestedFilename,
            retained.extension
          ),
          destinationDirectory: transfer.binding.intent.destinationDirectory,
          effectiveDestinationDirectory: transfer.binding.effectiveDir,
        });
        transfer.phase = "opening";
        sinkSessions.set(transfer.jobId, transfer);
        postSinkCommands(transfer, [transfer.session.openCmd()]).catch(function () {});
        return true;
      }

      function settleAssemblyOutcome(transfer, result, rejected) {
        transfer.assemblySettled = true;
        return waitForAssemblyFetches(transfer).then(function () {
          if (transfer.settled) return;
          if (transfer.cancelRequested === true) {
            settleAssembledTransport(
              transfer,
              { status: "cancelled" },
              true
            );
            return;
          }
          if (!getScheduler().isAttemptActive(transfer.jobId, transfer.attemptToken)) {
            clearSinkTransfer(transfer, false);
            releaseLocalOnce(transfer);
            return;
          }
          if (rejected) {
            var classified = getFailureClassify().normalizeBrowserError(result);
            settleAssembledTransport(
              transfer,
              { status: "failed", failureCategory: classified.category },
              false
            );
            return;
          }
          var assembled = copyAssemblyResult(result);
          if (!assembled) {
            settleAssembledTransport(
              transfer,
              { status: "failed", failureCategory: "permanent" },
              false
            );
            return;
          }
          transfer.binding.assembled = assembled;
          openAssembledSink(transfer);
        });
      }

      function startAssembledAttempt(job, binding) {
        var localLease = getScheduler().acquireLocalActivity(
          job.id,
          "assembly-sink"
        );
        if (!localLease) return false;
        var transfer = {
          jobId: job.id,
          attemptToken: job.attemptToken,
          binding: binding,
          localLease: localLease,
          localReleased: false,
          fetches: new Set(),
          assemblySettled: false,
          settled: false,
          phase: "assembly",
          bytes: null,
          session: null,
          offset: 0,
          commitPosted: false,
          abortPosted: false,
          cancelRequested: false,
          pendingSettlement: null,
        };
        sinkSessions.set(job.id, transfer);

        var task;
        if (binding.assembled) {
          transfer.assemblySettled = true;
          task = Promise.resolve().then(function () {
            openAssembledSink(transfer);
          });
        } else {
          var assemblyEffect;
          try {
            assemblyEffect = assembleMedia({
              kind: binding.mediaKind,
              sourceUrl: binding.url,
              selection: binding.selection,
              segmentConcurrency: job.effectiveConcurrency,
              fetchArrayBuffer: function () {
                return guardedAssemblyFetch(transfer, arguments);
              },
              shouldAbort: function () {
                return !getScheduler().isAttemptActive(
                  transfer.jobId,
                  transfer.attemptToken
                );
              },
              onProgress: function (progress) {
                updateAssemblyProgress(transfer, progress);
              },
            });
          } catch (errSync) {
            assemblyEffect = Promise.reject(errSync);
          }
          task = Promise.resolve(assemblyEffect).then(
            function (result) {
              return settleAssemblyOutcome(transfer, result, false);
            },
            function (err) {
              return settleAssemblyOutcome(transfer, err, true);
            }
          );
        }
        transfer.task = Promise.resolve(task).catch(function () {});
        return true;
      }

      /**
       * Undo the startedAttempts guard for one direct attempt and hand its
       * slot back to the scheduler, the way manualRetry already does on this
       * same failure class. Shared by every point along the key-add-to-post
       * span - lease lookup, payload build, and the post itself - that can
       * fail before a live attempt is on the wire.
       */
      function releaseDirectAttempt(activeScheduler, jobId, key) {
        startedAttempts.delete(key);
        activeScheduler.onTransportUnavailable(jobId);
      }

      /**
       * Post one direct attempt. The key was added to startedAttempts BEFORE the
       * post on purpose - it is the re-entrancy guard that keeps overlapping pumps
       * to one live attempt - so a start that never reaches the helper has to undo
       * it here and hand the slot back, the way manualRetry already does.
       * Always returns a promise: a synchronous throw must not abort pump's loop
       * and strand the still-unstarted jobs behind it in the same snapshot.
       */
      function postDirectAttempt(activeScheduler, jobId, key, command) {
        function failStart(err) {
          releaseDirectAttempt(activeScheduler, jobId, key);
          throw err;
        }
        var effect;
        try {
          effect = postNative(command);
        } catch (errSync) {
          return Promise.resolve().then(function () {
            failStart(errSync);
          });
        }
        return Promise.resolve(effect).catch(failStart);
      }

      /**
       * Undo the startedAttempts guard for a direct attempt that failed
       * before it ever reached postDirectAttempt - nativeLeaseFor or
       * buildNativeStartPayload threw synchronously while building the
       * native command. Returns a rejected promise (never throws) so pump's
       * loop can push it onto `pending` and continue to the next job in the
       * same snapshot, exactly like a post-phase failure does.
       */
      function failDirectBuild(activeScheduler, jobId, key, err) {
        releaseDirectAttempt(activeScheduler, jobId, key);
        return Promise.reject(err);
      }

      /**
       * Undo the singleStartedAttempts guard for one switched attempt and hand
       * its slot back to the scheduler - releaseDirectAttempt's counterpart for
       * the range->single switch path. Without it a start that dies before the
       * wire leaves the key set forever, which blocks any re-post of that
       * attempt, and leaves the job `running`, holding its global concurrency
       * slot for the rest of the session.
       */
      function releaseSwitchedAttempt(activeScheduler, jobId, key) {
        singleStartedAttempts.delete(key);
        activeScheduler.onTransportUnavailable(jobId);
      }

      /**
       * Build and post the single-connection attempt a capability switch just
       * authorized. Covers the whole span the singleStartedAttempts key guards:
       * the lease lookup and the payload build can fail exactly as capably as
       * the post, and neither of those ever reaches the helper either. The key
       * is added BEFORE this call on purpose - it is the re-entrancy guard that
       * keeps a duplicate range_unsupported result from posting twice - so a
       * start that never reaches the wire has to undo it here and hand the slot
       * back, the way pump's direct branch already does.
       * Error identity is preserved in both directions: handlePgetResult
       * documents that a startSingleConnection throw propagates, so a
       * synchronous failure rethrows the original error rather than turning it
       * into a rejection, and a rejected effect stays a rejection of that same
       * error for the switchEffects await to surface.
       */
      function postSwitchedAttempt(activeScheduler, job, binding, key) {
        function failSwitchedStart(err) {
          releaseSwitchedAttempt(activeScheduler, job.id, key);
          throw err;
        }
        var effect;
        try {
          var lease = activeScheduler.nativeLeaseFor(job.id);
          var input = {
            kind: "pget-single",
            jobId: job.id,
            attemptToken: job.attemptToken,
            intent: binding.intent,
            url: binding.url,
            providerGeneration: lease.providerGeneration,
          };
          if (binding.mirrors !== undefined) input.mirrors = binding.mirrors;
          if (binding.referer !== undefined) input.referer = binding.referer;
          if (binding.userAgent !== undefined) input.userAgent = binding.userAgent;
          if (binding.effectiveDir !== undefined) {
            input.effectiveDestinationDirectory = binding.effectiveDir;
          }
          effect = postNative(getMessageRouter().buildNativeStartPayload(input));
        } catch (errSync) {
          failSwitchedStart(errSync);
        }
        return Promise.resolve(effect).catch(failSwitchedStart);
      }

      function enqueueDownload(message, sender) {
        return Promise.resolve().then(function () {
          requirePopupSender(sender);
          var record = readOwnedMediaRecord(message);
          var selected = selectSourceHandle(message, record);
          var sourceHandle = selected.handle;
          var primaryUrl = readEphemeralUrl(sourceHandle);
          var sanitized = buildSanitizedDownloadMessage(message, record);
          var normalized = getMessageRouter().normalizeDownloadRequest(sanitized);
          var intent = normalized.intent;
          var effectiveDir = resolveEffectiveDestination(intent);
          if (record.providerKey == null || String(record.providerKey).trim() === "") {
            throw genericTypeError();
          }
          var beforeSig = jobAdmissionSig();
          var prep = preparePublicId("job");
          var jobId = commitPublicId(prep);
          var future = record.futureTransport || {};
          var binding = {
            url: primaryUrl,
            intent: intent,
            effectiveDir: effectiveDir,
            mediaKind: record.mediaKind,
            tabId: record.tabId,
            mediaId: record.mediaId,
            selection: selected.selection,
            mirrors: future.mirrors,
            referer: future.referer,
            userAgent: future.userAgent,
          };
          getScheduler().createJob({
            id: jobId,
            providerKey: record.providerKey,
            intent: intent,
            mediaKind: record.mediaKind,
            retries: settings.retries,
            segmentConcurrency: settings.segmentConcurrency,
            ephemeral: sourceHandle,
          });
          jobBindings.set(jobId, binding);
          popupTokenStore.set(jobId, intent.userActionToken);
          getScheduler().enqueue(jobId);
          return pump().then(
            function () {
              publishJobsIfChanged(beforeSig);
              return projectReturnedJob(jobId);
            },
            function (err) {
              publishJobsIfChanged(beforeSig);
              throw err;
            }
          );
        });
      }

      function findSinkTransfer(message) {
        if (!message || typeof message !== "object") return null;
        var sinkId = ownData(message, "sinkId");
        if (typeof sinkId === "string" && sinkId.trim().length > 0) {
          var bySink = sinkTransfersById.get(sinkId);
          if (
            bySink &&
            !bySink.settled &&
            bySink.session &&
            bySink.session.sinkId === sinkId
          ) {
            return bySink;
          }
        }
        var jobId = ownData(message, "jobId");
        var attemptToken = ownData(message, "attemptToken");
        if (typeof jobId !== "string" || typeof attemptToken !== "string") {
          return null;
        }
        var transfer = sinkSessions.get(jobId);
        if (
          !transfer ||
          transfer.settled ||
          transfer.jobId !== jobId ||
          transfer.attemptToken !== attemptToken
        ) {
          return null;
        }
        return transfer;
      }

      function postSinkAbort(transfer) {
        if (!transfer || transfer.settled || transfer.abortPosted || !transfer.session) {
          return Promise.resolve(false);
        }
        var command = transfer.session.abortCmd();
        if (!command) return Promise.resolve(false);
        transfer.abortPosted = true;
        transfer.phase = "aborting";
        return postSinkCommands(transfer, [command]);
      }

      function handleFileSinkMessage(message) {
        var transfer = findSinkTransfer(message);
        if (!transfer || !transfer.session) return Promise.resolve(false);
        var type = ownData(message, "type");

        if (type === "file-opened") {
          var assignedSinkId = ownData(message, "sinkId");
          var existing = sinkTransfersById.get(assignedSinkId);
          if (existing && existing !== transfer && !existing.settled) {
            return Promise.resolve(false);
          }
          if (!transfer.session.onOpened(message)) return Promise.resolve(false);
          sinkTransfersById.set(assignedSinkId, transfer);
          transfer.phase = "streaming";
          if (transfer.cancelRequested === true) {
            return postSinkAbort(transfer).then(
              function () { return true; },
              function () { return true; }
            );
          }
          return postSinkCommands(transfer, nextSinkCommands(transfer)).then(
            function () { return true; },
            function () { return true; }
          );
        }

        if (type === "file-chunk-ack") {
          if (!transfer.session.onAck(message)) return Promise.resolve(false);
          return postSinkCommands(transfer, nextSinkCommands(transfer)).then(
            function () { return true; },
            function () { return true; }
          );
        }

        if (type === "file-committed") {
          if (transfer.abortPosted || transfer.cancelRequested === true) {
            return Promise.resolve(false);
          }
          var committed = transfer.session.onCommitted(message);
          if (!committed) return Promise.resolve(false);
          if (committed.bytes !== transfer.bytes.length) {
            settleAssembledTransport(
              transfer,
              { status: "failed", failureCategory: "local_io" },
              false
            );
            return Promise.resolve(true);
          }
          transfer.binding.savedPath = committed.file;
          settleAssembledTransport(transfer, { status: "completed" }, true);
          return Promise.resolve(true);
        }

        if (type === "file-aborted") {
          if (!transfer.session.onAborted(message)) return Promise.resolve(false);
          settleAssembledTransport(transfer, { status: "cancelled" }, true);
          return Promise.resolve(true);
        }

        if (type === "file-error") {
          var failed = transfer.session.onHostError(message);
          if (!failed) return Promise.resolve(false);
          var cancelled = transfer.cancelRequested === true;
          settleAssembledTransport(
            transfer,
            {
              status: "failed",
              failureCategory: failed.failureCategory,
            },
            cancelled
          );
          return Promise.resolve(true);
        }

        return Promise.resolve(false);
      }

      function handleNativeMessage(message) {
        return Promise.resolve().then(function () {
          if (!message || typeof message !== "object" || ownData(message, "type") === undefined) return false;
          var beforeSig = jobAdmissionSig();
          var decision = getMessageRouter().routeNativeMessage(message);
          if (!decision || typeof decision !== "object") return false;

          if (decision.action === "file-sink-message") {
            return handleFileSinkMessage(decision.message);
          }

          if (decision.action === "transport-progress") {
            var progressJob = getScheduler().getJob(decision.jobId);
            if (!progressJob || progressJob.state !== "running" || progressJob.mediaKind !== "direct" || progressJob.attemptToken !== decision.attemptToken) return false;
            var progressBinding = jobBindings.get(decision.jobId);
            if (!progressBinding) return false;
            var oldProgress = progressBinding.progress;
            if (oldProgress && (decision.bytes < oldProgress.done || decision.total < oldProgress.total)) return false;
            progressBinding.progress = Object.freeze({ done: decision.bytes, total: decision.total });
            publishJobsIfChanged(beforeSig);
            return true;
          }

          if (decision.action === "native-limit-ack") {
            var ackJob = getScheduler().getJob(decision.jobId);
            if (!ackJob || ackJob.state !== "running" || ackJob.mediaKind !== "direct" || ackJob.attemptToken !== decision.attemptToken) return false;
            var lease = getScheduler().nativeLeaseFor(decision.jobId);
            if (lease.providerGeneration !== decision.providerGeneration || lease.maxConnections !== decision.maxConnections) return false;
            var ackBinding = jobBindings.get(decision.jobId);
            if (!ackBinding) return false;
            ackBinding.limitAck = Object.freeze({ providerGeneration: decision.providerGeneration, maxConnections: decision.maxConnections });
            return true;
          }

          if (decision.action !== "transport-result" && decision.action !== "start-single-connection") return false;
          var switchEffects = [];
          var accepted = false;
          var facade = {
            getJob: function (id) { return getScheduler().getJob(id); },
            onDrainingTransportResult: function (id, token, result) {
              var changed = getScheduler().onDrainingTransportResult(id, token, result);
              accepted = changed === true;
              return changed;
            },
            onTransportResult: function (id, token, result) {
              var before = getScheduler().getJob(id);
              if (!before || before.state !== "running" || before.attemptToken !== token) return;
              getScheduler().noteNativeOpen(id, 0);
              getScheduler().onTransportResult(id, token, result);
              var after = getScheduler().getJob(id);
              accepted = !!after && (after.stateVersion !== before.stateVersion || after.state !== before.state || after.mode !== before.mode);
            },
            onCapabilitySwitch: function (id, result) {
              var before = getScheduler().getJob(id);
              if (!before || before.state !== "running") return;
              getScheduler().noteNativeOpen(id, 0);
              getScheduler().onCapabilitySwitch(id, result);
              var after = getScheduler().getJob(id);
              accepted = !!after && after.mode !== before.mode;
            }
          };
          var switchStart = function (post) {
            var job = getScheduler().getJob(post.id);
            if (!job || job.state !== "running" || job.attemptToken !== post.attemptToken || job.mode !== "single-connection") return;
            var key = job.id + "\0" + job.attemptToken;
            if (singleStartedAttempts.has(key)) return;
            var binding = jobBindings.get(job.id);
            if (!binding) return;
            singleStartedAttempts.add(key);
            var effect = postSwitchedAttempt(getScheduler(), job, binding, key);
            switchEffects.push(effect);
            return effect;
          };
          try {
            getNativeResultAdapter().handlePgetResult(facade, message, { startSingleConnection: switchStart });
          } catch (err) {
            publishJobsIfChanged(beforeSig);
            throw err;
          }
          if (!accepted) return false;
          var terminalBinding = jobBindings.get(decision.jobId);
          if (terminalBinding) {
            delete terminalBinding.progress;
            delete terminalBinding.limitAck;
          }
          var settledDirect = getScheduler().getJob(decision.jobId);
          if (
            settledDirect &&
            settledDirect.mediaKind === "direct" &&
            (settledDirect.state === "completed" ||
              settledDirect.state === "failed" ||
              settledDirect.state === "cancelled")
          ) {
            popupTokenStore.delete(decision.jobId);
            pendingDirectCancels.delete(decision.jobId);
          }
          return Promise.all(switchEffects).then(function () { return pump(); }).then(function () {
            publishJobsIfChanged(beforeSig);
            return true;
          }, function (err) {
            publishJobsIfChanged(beforeSig);
            throw err;
          });
        });
      }

      function requestFirefoxHandoff(message, sender) {
        try {
          requirePopupSender(sender);
          var decision = getMessageRouter().routeNativeMessage(message);
          if (!decision || decision.action !== "request-firefox-handoff") return Promise.resolve(false);

          var job = getScheduler().getJob(decision.jobId);
          var binding = jobBindings.get(decision.jobId);
          var hasEligibleSource =
            job &&
            binding &&
            (job.mediaKind === "direct" ||
              (isAssembledKind(job.mediaKind) && binding.assembled));
          if (
            !job ||
            !binding ||
            !hasEligibleSource ||
            job.state !== "needs_user" ||
            !popupTokenStore.has(decision.jobId) ||
            popupTokenStore.get(decision.jobId) !== decision.intent.userActionToken ||
            firefoxHandoffRequests.has(decision.jobId)
          ) {
            return Promise.resolve(false);
          }

          var beforeSig = jobAdmissionSig();
          firefoxHandoffRequests.add(decision.jobId);
          var handoff;
          try {
            handoff = getScheduler().requestFirefoxHandoff(
              decision.jobId,
              decision.intent
            );
          } catch (err) {
            firefoxHandoffRequests.delete(decision.jobId);
            publishJobsIfChanged(beforeSig);
            throw err;
          }
          // The scheduler makes its handing_off_firefox transition before its
          // first await, so publish that safe state immediately.
          publishJobsIfChanged(beforeSig);

          return Promise.resolve(handoff).then(
            function () {
              firefoxHandoffRequests.delete(decision.jobId);
              var settled = getScheduler().getJob(decision.jobId);
              if (
                settled &&
                (settled.state === "needs_user" ||
                  settled.state === "handed_to_firefox" ||
                  settled.state === "completed" ||
                  settled.state === "failed" ||
                  settled.state === "cancelled")
              ) {
                popupTokenStore.delete(decision.jobId);
              }
              if (settled && settled.state === "handed_to_firefox") {
                clearAssembledBytes(binding);
              }
              publishJobsIfChanged(beforeSig);
              return projectReturnedJob(decision.jobId);
            },
            function (err) {
              firefoxHandoffRequests.delete(decision.jobId);
              var failed = getScheduler().getJob(decision.jobId);
              if (
                failed &&
                (failed.state === "needs_user" ||
                  failed.state === "handed_to_firefox" ||
                  failed.state === "completed" ||
                  failed.state === "failed" ||
                  failed.state === "cancelled")
              ) {
                popupTokenStore.delete(decision.jobId);
              }
              publishJobsIfChanged(beforeSig);
              throw err;
            }
          );
        } catch (errOuter) {
          return Promise.reject(errOuter);
        }
      }

      function cancel(jobId) {
        return Promise.resolve().then(function () {
          if (typeof jobId !== "string" || jobId.trim().length === 0) return false;
          var binding = jobBindings.get(jobId);
          if (!binding) return false;
          var activeScheduler = getScheduler();
          var job = activeScheduler.getJob(jobId);
          if (
            job &&
            isAssembledKind(job.mediaKind) &&
            job.state !== "completed" &&
            job.state !== "failed" &&
            job.state !== "cancelled"
          ) {
            var assembledBeforeSig = jobAdmissionSig();
            activeScheduler.cancel(jobId);
            var transfer = sinkSessions.get(jobId);
            if (transfer) transfer.cancelRequested = true;
            var afterCancel = activeScheduler.getJob(jobId);
            if (afterCancel && afterCancel.state === "cancelled") {
              clearAssembledBytes(binding);
              popupTokenStore.delete(jobId);
              if (transfer) {
                releaseLocalOnce(transfer);
                clearSinkTransfer(transfer, true);
              }
            }
            if (
              transfer &&
              !transfer.settled &&
              transfer.session &&
              transfer.session.sinkId
            ) {
              return postSinkAbort(transfer).then(
                function () {
                  publishJobsIfChanged(assembledBeforeSig);
                  return projectReturnedJob(jobId);
                },
                function (errAbort) {
                  publishJobsIfChanged(assembledBeforeSig);
                  throw errAbort;
                }
              );
            }
            publishJobsIfChanged(assembledBeforeSig);
            return projectReturnedJob(jobId);
          }
          if (
            !job ||
            job.mediaKind !== "direct" ||
            job.state === "completed" ||
            job.state === "failed" ||
            job.state === "cancelled" ||
            pendingDirectCancels.has(jobId)
          ) {
            return false;
          }
          var beforeSig = jobAdmissionSig();
          var runningToken =
            job.state === "running" &&
            typeof job.attemptToken === "string" &&
            job.attemptToken.trim().length > 0
              ? job.attemptToken
              : null;
          activeScheduler.cancel(jobId);
          if (!runningToken) {
            publishJobsIfChanged(beforeSig);
            return projectReturnedJob(jobId);
          }
          pendingDirectCancels.add(jobId);
          var command = getMessageRouter().buildNativeStartPayload({
            kind: "pget-cancel",
            jobId: jobId,
            attemptToken: runningToken,
          });
          var effect;
          try {
            effect = postNative(command);
          } catch (errSync) {
            activeScheduler.onTransportUnavailable(jobId);
            publishJobsIfChanged(beforeSig);
            throw errSync;
          }
          return Promise.resolve(effect).then(
            function () {
              publishJobsIfChanged(beforeSig);
              return projectReturnedJob(jobId);
            },
            function (errAsync) {
              activeScheduler.onTransportUnavailable(jobId);
              publishJobsIfChanged(beforeSig);
              throw errAsync;
            }
          );
        });
      }

      function manualRetry(jobId) {
        return Promise.resolve().then(function () {
          if (typeof jobId !== "string" || jobId.trim().length === 0) return false;
          var binding = jobBindings.get(jobId);
          if (!binding) return false;
          var activeScheduler = getScheduler();
          var job = activeScheduler.getJob(jobId);
          if (
            !job ||
            (job.mediaKind !== "direct" && !isAssembledKind(job.mediaKind)) ||
            job.state !== "needs_user"
          ) {
            return false;
          }
          var beforeSig = jobAdmissionSig();
          var oldTransfer = sinkSessions.get(jobId);
          if (oldTransfer) {
            releaseLocalOnce(oldTransfer);
            clearSinkTransfer(oldTransfer, false);
          }
          activeScheduler.manualRetry(jobId);
          pendingDirectCancels.delete(jobId);
          return pump().then(
            function () {
              publishJobsIfChanged(beforeSig);
              return projectReturnedJob(jobId);
            },
            function (err) {
              activeScheduler.onTransportUnavailable(jobId);
              publishJobsIfChanged(beforeSig);
              throw err;
            }
          );
        });
      }

      function helperDisconnected() {
        return Promise.resolve().then(function () {
          if (!scheduler) return deepFreeze(new Array());
          var beforeSig = jobAdmissionSig();
          var processed = new Set();
          var changedIds = [];
          var found = true;
          while (found) {
            found = false;
            var jobs = scheduler.getSnapshot().jobs || [];
            for (var i = 0; i < jobs.length; i++) {
              var job = jobs[i];
              if (
                !job ||
                processed.has(job.id) ||
                !jobBindings.has(job.id) ||
                (job.mediaKind !== "direct" && !isAssembledKind(job.mediaKind)) ||
                (job.state !== "running" &&
                  job.state !== "pausing_provider" &&
                  job.state !== "waiting_provider")
              ) {
                continue;
              }
              found = true;
              processed.add(job.id);
              if (isAssembledKind(job.mediaKind)) {
                var transfer = sinkSessions.get(job.id);
                if (transfer) {
                  var beforeState = scheduler.getJob(job.id);
                  settleAssembledUnavailable(transfer);
                  var afterState = scheduler.getJob(job.id);
                  if (
                    beforeState &&
                    afterState &&
                    beforeState.state !== afterState.state
                  ) {
                    changedIds.push(job.id);
                  }
                  continue;
                }
              }
              if (scheduler.onTransportUnavailable(job.id) === true) {
                changedIds.push(job.id);
              }
              var afterUnavailable = scheduler.getJob(job.id);
              if (afterUnavailable && afterUnavailable.state === "cancelled") {
                clearAssembledBytes(jobBindings.get(job.id));
                popupTokenStore.delete(job.id);
              }
            }
          }
          publishJobsIfChanged(beforeSig);
          var changed = new Array();
          for (var j = 0; j < changedIds.length; j++) {
            changed.push(projectReturnedJob(changedIds[j]));
          }
          return deepFreeze(changed);
        });
      }

      function setMaxConcurrent(value) {
        return Promise.resolve().then(function () {
          requirePositiveInt(value, "maxConcurrent");
          var beforeSig = jobAdmissionSig();
          getScheduler().setMaxConcurrent(value);
          settings.maxConcurrent = value;
          return pump().then(
            function () {
              publishJobsIfChanged(beforeSig);
            },
            function (err) {
              publishJobsIfChanged(beforeSig);
              throw err;
            }
          );
        });
      }

      function tick(nowMs) {
        return Promise.resolve().then(function () {
          if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
            throw new TypeError("nowMs must be a finite number");
          }
          finalizer.tick(nowMs);
          reconcile();
          if (scheduler) scheduler.tick(nowMs);
          retryPendingAssembledSettlements();
          return pump();
        });
      }

      function pump() {
        return Promise.resolve().then(function () {
          if (!scheduler) return;
          retryPendingAssembledSettlements();
          var snap = scheduler.getSnapshot();
          var jobs = snap.jobs || [];
          var pending = [];
          for (var i = 0; i < jobs.length; i++) {
            var job = jobs[i];
            if (!job || job.state !== "running") continue;
            if (typeof job.attemptToken !== "string" || job.attemptToken.length === 0) {
              continue;
            }
            var key = job.id + "\0" + job.attemptToken;
            if (startedAttempts.has(key)) continue;
            var binding = jobBindings.get(job.id);
            if (!binding) continue;
            if (isAssembledKind(job.mediaKind)) {
              if (startAssembledAttempt(job, binding)) {
                startedAttempts.add(key);
              }
              continue;
            }
            if (job.mediaKind !== "direct") continue;
            startedAttempts.add(key);
            delete binding.progress;
            delete binding.limitAck;
            var command;
            try {
              var lease = scheduler.nativeLeaseFor(job.id);
              var input = {
                kind: "pget",
                jobId: job.id,
                attemptToken: job.attemptToken,
                intent: binding.intent,
                url: binding.url,
                maxConnections: lease.maxConnections,
                providerGeneration: lease.providerGeneration,
              };
              if (binding.mirrors !== undefined) input.mirrors = binding.mirrors;
              if (binding.referer !== undefined) input.referer = binding.referer;
              if (binding.userAgent !== undefined) input.userAgent = binding.userAgent;
              if (binding.effectiveDir !== undefined) {
                input.effectiveDestinationDirectory = binding.effectiveDir;
              }
              command = getMessageRouter().buildNativeStartPayload(input);
            } catch (errBuild) {
              pending.push(failDirectBuild(scheduler, job.id, key, errBuild));
              continue;
            }
            pending.push(postDirectAttempt(scheduler, job.id, key, command));
          }
          return Promise.all(pending).then(function () {});
        });
      }

      function popupJobs() {
        return projectPopupJobsArray();
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
