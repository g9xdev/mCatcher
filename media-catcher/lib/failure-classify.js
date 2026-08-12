(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.McFailureClassify = api;
})(
  typeof self !== "undefined" ? self :
  (typeof globalThis !== "undefined" ? globalThis : this),
  function () {
  "use strict";

  var SATURATION_CANDIDATES = {
    timeout: true,
    connection_reset: true,
    short_read: true,
    http_429: true,
    http_5xx_temporary: true
  };

  var KNOWN_CATEGORIES = {
    timeout: true,
    connection_reset: true,
    short_read: true,
    http_429: true,
    http_5xx_temporary: true,
    range_unsupported: true,
    local_io: true,
    cancelled: true,
    permanent: true
  };

  function result(category) {
    var c = KNOWN_CATEGORIES[category] ? category : "permanent";
    return {
      category: c,
      retryable: !!SATURATION_CANDIDATES[c]
    };
  }

  function isSaturationCandidate(category) {
    return typeof category === "string" && !!SATURATION_CANDIDATES[category];
  }

  function asString(value) {
    if (value == null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return "";
  }

  function lower(value) {
    return asString(value).toLowerCase();
  }

  function parseStatus(value) {
    if (typeof value === "number" && isFinite(value)) return value | 0;
    if (typeof value === "string" && value.trim() !== "") {
      var n = Number(value);
      if (isFinite(n)) return n | 0;
    }
    return null;
  }

  function truthyFlag(obj, key) {
    return !!(obj && obj[key] === true);
  }

  /**
   * Priority-ordered classification from free-form text + optional structured hints.
   * Cancellation beats generic abort/network wording.
   */
  function classifyText(text, opts) {
    opts = opts || {};
    var s = lower(text);

    // 1) Cancellation always wins over network/abort phrasing.
    if (
      opts.cancelled === true ||
      opts.cancelRequested === true ||
      opts.name === "aborterror" ||
      /\bcancel(?:led|ed|lation)?\b/.test(s) ||
      /\baborted\b/.test(s) ||
      /\babort\b/.test(s)
    ) {
      // AbortError / cancelled flags are cancelled. Free-form "abort" without
      // TimeoutError context is also cancelled (user/host stop).
      if (opts.name !== "timeouterror") {
        return "cancelled";
      }
    }

    // 2) Explicit range unsupported signals (non-retryable).
    if (
      opts.rangeUnsupported === true ||
      opts.rangeIgnored === true ||
      opts.status === 416 ||
      s === "range_unsupported" ||
      s.indexOf("range_unsupported") !== -1 ||
      s.indexOf("range unsupported") !== -1 ||
      s.indexOf("rangeignored") !== -1 ||
      s.indexOf("range ignored") !== -1
    ) {
      return "range_unsupported";
    }

    // 3) Local I/O (non-retryable, never saturation).
    if (
      opts.code === "enospc" ||
      s === "local_io" ||
      s.indexOf("enospc") !== -1 ||
      s.indexOf("disk full") !== -1 ||
      s.indexOf("no space") !== -1 ||
      s.indexOf("edquota") !== -1 ||
      s.indexOf("eio") !== -1 ||
      s.indexOf("local_io") !== -1 ||
      s.indexOf("write failed") !== -1 ||
      s.indexOf("path rejected") !== -1
    ) {
      return "local_io";
    }

    // 4) Short read.
    if (
      opts.shortRead === true ||
      s === "short_read" ||
      s.indexOf("short_read") !== -1 ||
      s.indexOf("short read") !== -1
    ) {
      return "short_read";
    }

    // 5) Timeout.
    if (
      opts.name === "timeouterror" ||
      s === "timeout" ||
      s.indexOf("etimedout") !== -1 ||
      s.indexOf("timed out") !== -1 ||
      s.indexOf("timeout") !== -1
    ) {
      return "timeout";
    }

    // 6) Connection reset / fetch network failures.
    if (
      s === "connection_reset" ||
      s.indexOf("econnreset") !== -1 ||
      s.indexOf("connection reset") !== -1 ||
      s.indexOf("connection_reset") !== -1 ||
      s.indexOf("networkerror") !== -1 ||
      s.indexOf("network error") !== -1 ||
      s.indexOf("failed to fetch") !== -1 ||
      s.indexOf("err_network") !== -1 ||
      s.indexOf("econnrefused") !== -1 ||
      s.indexOf("enotfound") !== -1
    ) {
      return "connection_reset";
    }

    // 7) HTTP 429.
    if (
      opts.status === 429 ||
      s === "http_429" ||
      s.indexOf("http_429") !== -1 ||
      s.indexOf("too many requests") !== -1 ||
      /\b429\b/.test(s)
    ) {
      return "http_429";
    }

    // 8) Temporary 5xx (500/502/503/504).
    if (
      opts.status === 500 ||
      opts.status === 502 ||
      opts.status === 503 ||
      opts.status === 504 ||
      s === "http_5xx_temporary" ||
      s.indexOf("http_5xx_temporary") !== -1 ||
      s.indexOf("service unavailable") !== -1 ||
      s.indexOf("bad gateway") !== -1 ||
      s.indexOf("gateway timeout") !== -1 ||
      /\b50[0234]\b/.test(s)
    ) {
      return "http_5xx_temporary";
    }

    // 9) Exact known category strings (case-insensitive).
    if (KNOWN_CATEGORIES[s]) return s;

    // 10) Other HTTP statuses that are structured as permanent.
    if (opts.status != null && opts.status >= 400 && opts.status < 600) {
      return "permanent";
    }

    return null;
  }

  function collectBrowserBlob(errOrResponse) {
    if (errOrResponse == null) return { text: "", opts: {} };
    if (typeof errOrResponse === "string" || typeof errOrResponse === "number" || typeof errOrResponse === "boolean") {
      return { text: asString(errOrResponse), opts: {} };
    }
    if (typeof errOrResponse !== "object") {
      return { text: "", opts: {} };
    }

    var name = lower(errOrResponse.name);
    var code = lower(errOrResponse.code);
    var status = parseStatus(errOrResponse.status);
    var message = asString(errOrResponse.message);
    var reason = asString(errOrResponse.reason);
    var failureCategory = asString(errOrResponse.failureCategory);
    var parts = [failureCategory, name, code, message, reason, status != null ? String(status) : ""];

    return {
      text: parts.filter(Boolean).join(" "),
      opts: {
        name: name,
        code: code,
        status: status,
        shortRead: truthyFlag(errOrResponse, "shortRead"),
        rangeUnsupported: truthyFlag(errOrResponse, "rangeUnsupported"),
        rangeIgnored: truthyFlag(errOrResponse, "rangeIgnored"),
        cancelled: truthyFlag(errOrResponse, "cancelled"),
        cancelRequested: truthyFlag(errOrResponse, "cancelRequested")
      }
    };
  }

  function normalizeBrowserError(errOrResponse) {
    try {
      var blob = collectBrowserBlob(errOrResponse);
      // Prefer explicit failureCategory if it is a known contract category.
      if (errOrResponse && typeof errOrResponse === "object") {
        var explicit = lower(errOrResponse.failureCategory);
        if (KNOWN_CATEGORIES[explicit]) {
          // Still let cancellation flags override when present.
          if (blob.opts.cancelled || blob.opts.cancelRequested) {
            return result("cancelled");
          }
          return result(explicit);
        }
      }
      var category = classifyText(blob.text, blob.opts);
      if (category) return result(category);
      return result("permanent");
    } catch (e) {
      return result("permanent");
    }
  }

  function normalizeNativeFailure(reasonStringOrObject) {
    try {
      if (reasonStringOrObject == null) return result("permanent");

      if (typeof reasonStringOrObject === "string" || typeof reasonStringOrObject === "number" || typeof reasonStringOrObject === "boolean") {
        var asCat = lower(reasonStringOrObject);
        if (KNOWN_CATEGORIES[asCat]) return result(asCat);
        var fromText = classifyText(asString(reasonStringOrObject), {});
        return result(fromText || "permanent");
      }

      if (typeof reasonStringOrObject !== "object") return result("permanent");

      var failureCategory = lower(reasonStringOrObject.failureCategory);
      if (KNOWN_CATEGORIES[failureCategory]) {
        return result(failureCategory);
      }

      var reason = asString(reasonStringOrObject.reason);
      var message = asString(reasonStringOrObject.message);
      var code = lower(reasonStringOrObject.code);
      var status = parseStatus(reasonStringOrObject.status);
      var text = [failureCategory, reason, message, code, status != null ? String(status) : ""].filter(Boolean).join(" ");
      var opts = {
        name: lower(reasonStringOrObject.name),
        code: code,
        status: status,
        shortRead: truthyFlag(reasonStringOrObject, "shortRead"),
        rangeUnsupported: truthyFlag(reasonStringOrObject, "rangeUnsupported"),
        rangeIgnored: truthyFlag(reasonStringOrObject, "rangeIgnored"),
        cancelled: truthyFlag(reasonStringOrObject, "cancelled"),
        cancelRequested: truthyFlag(reasonStringOrObject, "cancelRequested")
      };
      var category = classifyText(text, opts);
      return result(category || "permanent");
    } catch (e) {
      return result("permanent");
    }
  }

  function positiveNumber(value) {
    var n = typeof value === "number" ? value : Number(value);
    return isFinite(n) && n > 0;
  }

  function hasActiveSibling(input) {
    try {
      if (!input || typeof input !== "object") {
        return { ok: false, siblingJobId: null };
      }
      var providerKey = input.providerKey;
      if (typeof providerKey !== "string" || providerKey.length === 0) {
        return { ok: false, siblingJobId: null };
      }
      var jobs = input.jobs;
      if (!Array.isArray(jobs)) {
        return { ok: false, siblingJobId: null };
      }
      var excludeJobId = input.excludeJobId;

      for (var i = 0; i < jobs.length; i++) {
        var job = jobs[i];
        if (!job || typeof job !== "object") continue;
        if (job.providerKey !== providerKey) continue;
        if (excludeJobId != null && job.id === excludeJobId) continue;
        if (job.state !== "running" && job.state !== "pausing_provider") continue;
        if (job.cancelRequested === true) continue;
        if (!positiveNumber(job.inFlightPermits) && !positiveNumber(job.nativeOpenConnections)) continue;
        return { ok: true, siblingJobId: job.id == null ? null : job.id };
      }
      return { ok: false, siblingJobId: null };
    } catch (e) {
      return { ok: false, siblingJobId: null };
    }
  }

  return {
    normalizeBrowserError: normalizeBrowserError,
    normalizeNativeFailure: normalizeNativeFailure,
    isSaturationCandidate: isSaturationCandidate,
    hasActiveSibling: hasActiveSibling
  };
});
