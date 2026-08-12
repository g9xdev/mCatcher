(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.McFileSinkProtocol = api;
})(
  typeof self !== "undefined" ? self :
  (typeof globalThis !== "undefined" ? globalThis : this),
  function () {
    "use strict";

    // Match native host filesink.py: decoded chunk cap under Firefox 1 MiB framed limit.
    var MAX_UNACKED = 4;
    var MAX_CHUNK_BYTES = 512 * 1024;

    var B64_ALPHABET =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    function deepFreeze(o) {
      if (!o || typeof o !== "object" || Object.isFrozen(o)) return o;
      Object.getOwnPropertyNames(o).forEach(function (k) {
        var v = o[k];
        if (v && typeof v === "object") deepFreeze(v);
      });
      return Object.freeze(o);
    }

    function isNonblankString(v) {
      return typeof v === "string" && v.trim().length > 0;
    }

    function requireNonblankString(v, label) {
      if (!isNonblankString(v)) {
        throw new TypeError(label + " must be a nonblank primitive string");
      }
      return v;
    }

    function normalizeDestination(v) {
      if (v === undefined || v === null) return null;
      if (!isNonblankString(v)) {
        throw new TypeError(
          "destinationDirectory must be null, undefined, or a nonblank primitive string"
        );
      }
      return v;
    }

    /**
     * Transport-only destination resolution.
     * Non-null intent directory is authoritative. When intent is null, use
     * effectiveDestinationDirectory or null. Reject empty/whitespace/objects
     * and conflicting non-null overrides.
     */
    function resolveTransportDestination(intentDir, effective) {
      var intentNorm = normalizeDestination(intentDir);
      var hasEffective = effective !== undefined && effective !== null;
      if (intentNorm !== null) {
        if (hasEffective) {
          if (typeof effective !== "string" || !isNonblankString(effective)) {
            throw new TypeError(
              "effectiveDestinationDirectory must be a nonblank primitive string when provided"
            );
          }
          if (effective !== intentNorm) {
            throw new TypeError(
              "effectiveDestinationDirectory conflicts with intent.destinationDirectory"
            );
          }
        }
        return intentNorm;
      }
      if (!hasEffective) return null;
      if (typeof effective !== "string" || !isNonblankString(effective)) {
        throw new TypeError(
          "effectiveDestinationDirectory must be a nonblank primitive string when provided"
        );
      }
      return effective;
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

    function hasOwn(obj, key) {
      return Object.prototype.hasOwnProperty.call(obj, key);
    }

    /** Reject CR/LF/NUL and other control characters in HTTP-context strings. */
    function isSafeHttpContextString(v) {
      return typeof v === "string" && !/[\u0000-\u001f\u007f]/.test(v);
    }

    function normalizeHttpContextField(v, label) {
      if (v === undefined || v === null) return "";
      if (!isSafeHttpContextString(v)) {
        throw new TypeError(label + " must be a primitive string without control characters");
      }
      return v;
    }

    function requireProviderGeneration(v) {
      if (!isNonnegInt(v)) {
        throw new TypeError("providerGeneration must be a nonnegative integer");
      }
      return v;
    }

    function readProviderGeneration(input) {
      // Pre-generation callers omit the field; default 0. Explicit null/invalid throws.
      if (!hasOwn(input, "providerGeneration") || input.providerGeneration === undefined) {
        return 0;
      }
      return requireProviderGeneration(input.providerGeneration);
    }

    /**
     * Primary URL first, then exact-string-deduped valid mirrors.
     * Invalid mirror entries are skipped; never mutate caller arrays.
     */
    function buildUrlsList(url, mirrors) {
      requireNonblankString(url, "url");
      var out = [url];
      var seen = Object.create(null);
      seen[url] = true;
      if (mirrors == null) return Object.freeze(out);
      if (!Array.isArray(mirrors)) return Object.freeze(out);
      for (var i = 0; i < mirrors.length; i++) {
        var m = mirrors[i];
        if (typeof m !== "string" || !isNonblankString(m)) continue;
        if (seen[m]) continue;
        seen[m] = true;
        out.push(m);
      }
      return Object.freeze(out);
    }

    /**
     * Pure base64 encoder for Uint8Array views.
     * Avoids Buffer-only paths and apply/spread argument limits at 512 KiB.
     */
    function encodeBase64(u8) {
      var len = u8.length;
      var out = "";
      var i = 0;
      while (i + 2 < len) {
        var n = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
        out += B64_ALPHABET[(n >> 18) & 63];
        out += B64_ALPHABET[(n >> 12) & 63];
        out += B64_ALPHABET[(n >> 6) & 63];
        out += B64_ALPHABET[n & 63];
        i += 3;
      }
      if (i < len) {
        var rem = u8[i] << 16;
        if (i + 1 < len) rem |= u8[i + 1] << 8;
        out += B64_ALPHABET[(rem >> 18) & 63];
        out += B64_ALPHABET[(rem >> 12) & 63];
        if (i + 1 < len) {
          out += B64_ALPHABET[(rem >> 6) & 63];
          out += "=";
        } else {
          out += "==";
        }
      }
      return out;
    }

    function freezeCmd(obj) {
      return deepFreeze(obj);
    }

    function readIntentNameDir(intent, effectiveDestinationDirectory) {
      if (!intent || typeof intent !== "object") {
        throw new TypeError("intent must be an object");
      }
      // Named property reads only — never enumerate or follow extras.
      var name = intent.requestedFilename;
      var dirRaw = intent.destinationDirectory;
      requireNonblankString(name, "intent.requestedFilename");
      var dir = resolveTransportDestination(dirRaw, effectiveDestinationDirectory);
      return { name: name, dir: dir };
    }

    function buildPgetCmd(input) {
      input = input || {};
      var jobId = requireNonblankString(input.jobId, "jobId");
      var attemptToken = requireNonblankString(input.attemptToken, "attemptToken");
      var url = requireNonblankString(input.url, "url");
      if (!isPositiveInt(input.maxConnections)) {
        throw new TypeError("maxConnections must be a positive integer");
      }
      var providerGeneration = readProviderGeneration(input);
      var referer = normalizeHttpContextField(input.referer, "referer");
      var userAgent = normalizeHttpContextField(input.userAgent, "userAgent");
      var bound = readIntentNameDir(input.intent, input.effectiveDestinationDirectory);
      var urls = buildUrlsList(url, input.mirrors);
      return freezeCmd({
        cmd: "pget",
        id: jobId,
        attemptToken: attemptToken,
        urls: urls,
        name: bound.name,
        dir: bound.dir,
        maxConnections: input.maxConnections,
        providerGeneration: providerGeneration,
        referer: referer,
        userAgent: userAgent,
      });
    }

    function buildPgetSingleCmd(input) {
      input = input || {};
      var jobId = requireNonblankString(input.jobId, "jobId");
      var attemptToken = requireNonblankString(input.attemptToken, "attemptToken");
      var url = requireNonblankString(input.url, "url");
      var providerGeneration = readProviderGeneration(input);
      var referer = normalizeHttpContextField(input.referer, "referer");
      var userAgent = normalizeHttpContextField(input.userAgent, "userAgent");
      var bound = readIntentNameDir(input.intent, input.effectiveDestinationDirectory);
      var urls = buildUrlsList(url, input.mirrors);
      return freezeCmd({
        cmd: "pget-single",
        id: jobId,
        attemptToken: attemptToken,
        urls: urls,
        name: bound.name,
        dir: bound.dir,
        maxConnections: 1,
        providerGeneration: providerGeneration,
        referer: referer,
        userAgent: userAgent,
      });
    }

    function buildPgetSetLimitCmd(input) {
      input = input || {};
      var jobId = requireNonblankString(input.jobId, "jobId");
      var attemptToken = requireNonblankString(input.attemptToken, "attemptToken");
      var providerGeneration = requireProviderGeneration(input.providerGeneration);
      if (!isNonnegInt(input.maxConnections)) {
        throw new TypeError("maxConnections must be a nonnegative integer");
      }
      return freezeCmd({
        cmd: "pget-set-limit",
        id: jobId,
        attemptToken: attemptToken,
        providerGeneration: providerGeneration,
        maxConnections: input.maxConnections,
      });
    }

    function buildPgetCancelCmd(input) {
      input = input || {};
      var jobId = requireNonblankString(input.jobId, "jobId");
      var attemptToken = requireNonblankString(input.attemptToken, "attemptToken");
      return freezeCmd({
        cmd: "pget-cancel",
        id: jobId,
        attemptToken: attemptToken,
      });
    }

    function createFileSinkSession(input) {
      input = input || {};
      // Named reads only — never enumerate caller object.
      var jobId = requireNonblankString(input.jobId, "jobId");
      var attemptToken = requireNonblankString(input.attemptToken, "attemptToken");
      var requestedFilename = requireNonblankString(
        input.requestedFilename,
        "requestedFilename"
      );
      var destinationDirectory = resolveTransportDestination(
        input.destinationDirectory,
        input.effectiveDestinationDirectory
      );

      var state = "open"; // open | streaming | committed | aborted | failed
      var sinkId = null;
      var nextSeq = 0;
      var outstanding = Object.create(null);
      var outstandingCount = 0;

      function isTerminal() {
        return (
          state === "committed" ||
          state === "aborted" ||
          state === "failed"
        );
      }

      function clearOutstanding() {
        outstanding = Object.create(null);
        outstandingCount = 0;
      }

      function identityExtrasOk(msg) {
        if (hasOwn(msg, "jobId") && msg.jobId !== jobId) return false;
        if (hasOwn(msg, "attemptToken") && msg.attemptToken !== attemptToken) {
          return false;
        }
        return true;
      }

      // Host errors require full identity (Task-15 always emits it). Missing
      // fields are uncorrelated and must not fail the live session.
      function openHostErrorIdentityOk(msg) {
        if (msg.jobId !== jobId) return false;
        if (msg.attemptToken !== attemptToken) return false;
        if (hasOwn(msg, "sinkId") && msg.sinkId != null && msg.sinkId !== "") {
          return false;
        }
        return true;
      }

      function streamingHostErrorIdentityOk(msg) {
        if (msg.sinkId !== sinkId) return false;
        if (msg.jobId !== jobId) return false;
        if (msg.attemptToken !== attemptToken) return false;
        return true;
      }

      function openCmd() {
        if (state !== "open") return null;
        return freezeCmd({
          cmd: "file-open",
          jobId: jobId,
          attemptToken: attemptToken,
          requestedFilename: requestedFilename,
          dir: destinationDirectory,
        });
      }

      function onOpened(msg) {
        if (state !== "open") return false;
        if (!msg || typeof msg !== "object") return false;
        if (msg.type !== "file-opened") return false;
        if (!isNonblankString(msg.sinkId)) return false;
        if (msg.jobId !== jobId) return false;
        if (msg.attemptToken !== attemptToken) return false;
        sinkId = msg.sinkId;
        state = "streaming";
        return true;
      }

      function nextChunkCmd(bytes) {
        if (state !== "streaming" || sinkId === null) return null;
        if (!(bytes instanceof Uint8Array)) {
          throw new TypeError("chunk must be a Uint8Array");
        }
        if (bytes.length > MAX_CHUNK_BYTES) {
          throw new RangeError("chunk exceeds MAX_CHUNK_BYTES");
        }
        if (outstandingCount >= MAX_UNACKED) return null;

        // Copy before encode so later mutation cannot change the command.
        var copy = new Uint8Array(bytes.length);
        copy.set(bytes);
        var seq = nextSeq;
        var dataB64 = encodeBase64(copy);
        var cmd = freezeCmd({
          cmd: "file-chunk",
          sinkId: sinkId,
          jobId: jobId,
          attemptToken: attemptToken,
          seq: seq,
          dataB64: dataB64,
          length: copy.length,
        });
        outstanding[seq] = true;
        outstandingCount += 1;
        nextSeq += 1;
        return cmd;
      }

      function onAck(msg) {
        if (state !== "streaming" || sinkId === null) return false;
        if (!msg || typeof msg !== "object") return false;
        if (msg.type !== "file-chunk-ack") return false;
        if (msg.sinkId !== sinkId) return false;
        if (!identityExtrasOk(msg)) return false;
        if (!isNonnegInt(msg.seq)) return false;
        if (!outstanding[msg.seq]) return false;
        delete outstanding[msg.seq];
        outstandingCount -= 1;
        if (outstandingCount < 0) outstandingCount = 0;
        return true;
      }

      function commitCmd() {
        if (state !== "streaming" || sinkId === null) return null;
        if (outstandingCount !== 0) return null;
        return freezeCmd({
          cmd: "file-commit",
          sinkId: sinkId,
          jobId: jobId,
          attemptToken: attemptToken,
        });
      }

      function abortCmd() {
        if (state !== "streaming" || sinkId === null) return null;
        return freezeCmd({
          cmd: "file-abort",
          sinkId: sinkId,
          jobId: jobId,
          attemptToken: attemptToken,
        });
      }

      function onCommitted(msg) {
        if (state !== "streaming" || sinkId === null) return null;
        if (outstandingCount !== 0) return null;
        if (!msg || typeof msg !== "object") return null;
        if (msg.type !== "file-committed") return null;
        if (msg.sinkId !== sinkId) return null;
        if (!identityExtrasOk(msg)) return null;
        if (!isNonblankString(msg.file)) return null;
        if (!isNonnegInt(msg.bytes)) return null;
        clearOutstanding();
        state = "committed";
        return freezeCmd({
          status: "committed",
          bytes: msg.bytes,
          file: msg.file,
        });
      }

      function onAborted(msg) {
        if (state !== "streaming" || sinkId === null) return null;
        if (!msg || typeof msg !== "object") return null;
        if (msg.type !== "file-aborted") return null;
        if (msg.sinkId !== sinkId) return null;
        if (!identityExtrasOk(msg)) return null;
        clearOutstanding();
        state = "aborted";
        return freezeCmd({ status: "aborted" });
      }

      function onHostError(msg) {
        if (isTerminal()) return null;
        if (!msg || typeof msg !== "object") return null;
        if (msg.type !== "file-error") return null;

        if (state === "streaming") {
          if (!streamingHostErrorIdentityOk(msg)) return null;
        } else if (state === "open") {
          if (!openHostErrorIdentityOk(msg)) return null;
        } else {
          return null;
        }

        clearOutstanding();
        state = "failed";
        // Always normalize: never copy reason/path/raw/host category extras.
        return freezeCmd({
          failureCategory: "local_io",
          invokeFirefox: false,
          isSaturation: false,
        });
      }

      var session = {
        get state() {
          return state;
        },
        get jobId() {
          return jobId;
        },
        get attemptToken() {
          return attemptToken;
        },
        get requestedFilename() {
          return requestedFilename;
        },
        get destinationDirectory() {
          return destinationDirectory;
        },
        get sinkId() {
          return sinkId;
        },
        get outstandingCount() {
          return outstandingCount;
        },
        openCmd: openCmd,
        onOpened: onOpened,
        nextChunkCmd: nextChunkCmd,
        onAck: onAck,
        commitCmd: commitCmd,
        abortCmd: abortCmd,
        onCommitted: onCommitted,
        onAborted: onAborted,
        onHostError: onHostError,
      };

      return Object.freeze(session);
    }

    return Object.freeze({
      MAX_UNACKED: MAX_UNACKED,
      MAX_CHUNK_BYTES: MAX_CHUNK_BYTES,
      createFileSinkSession: createFileSinkSession,
      buildPgetCmd: buildPgetCmd,
      buildPgetSingleCmd: buildPgetSingleCmd,
      buildPgetSetLimitCmd: buildPgetSetLimitCmd,
      buildPgetCancelCmd: buildPgetCancelCmd,
    });
  }
);
