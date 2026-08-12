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

    function readIntentNameDir(intent) {
      if (!intent || typeof intent !== "object") {
        throw new TypeError("intent must be an object");
      }
      // Named property reads only — never enumerate or follow extras.
      var name = intent.requestedFilename;
      var dirRaw = intent.destinationDirectory;
      requireNonblankString(name, "intent.requestedFilename");
      var dir = normalizeDestination(dirRaw);
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
      var bound = readIntentNameDir(input.intent);
      return freezeCmd({
        cmd: "pget",
        id: jobId,
        attemptToken: attemptToken,
        urls: Object.freeze([url]),
        name: bound.name,
        dir: bound.dir,
        maxConnections: input.maxConnections,
      });
    }

    function buildPgetSingleCmd(input) {
      input = input || {};
      var jobId = requireNonblankString(input.jobId, "jobId");
      var attemptToken = requireNonblankString(input.attemptToken, "attemptToken");
      var url = requireNonblankString(input.url, "url");
      var bound = readIntentNameDir(input.intent);
      return freezeCmd({
        cmd: "pget-single",
        id: jobId,
        attemptToken: attemptToken,
        urls: Object.freeze([url]),
        name: bound.name,
        dir: bound.dir,
        maxConnections: 1,
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
      var destinationDirectory = normalizeDestination(input.destinationDirectory);

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

      function identityExtrasOk(msg) {
        if (hasOwn(msg, "jobId") && msg.jobId !== jobId) return false;
        if (hasOwn(msg, "attemptToken") && msg.attemptToken !== attemptToken) {
          return false;
        }
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
        if (!msg || typeof msg !== "object") return null;
        if (msg.type !== "file-committed") return null;
        if (msg.sinkId !== sinkId) return null;
        if (!identityExtrasOk(msg)) return null;
        if (!isNonblankString(msg.file)) return null;
        if (!isNonnegInt(msg.bytes)) return null;
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
        state = "aborted";
        return freezeCmd({ status: "aborted" });
      }

      function onHostError(msg) {
        if (isTerminal()) return null;
        if (!msg || typeof msg !== "object") return null;
        if (msg.type !== "file-error") return null;
        if (!identityExtrasOk(msg)) return null;

        if (state === "streaming") {
          if (hasOwn(msg, "sinkId") && msg.sinkId !== sinkId) return null;
        } else if (state === "open") {
          // Open-attempt errors may carry job/attempt; reject foreign sink ids.
          if (hasOwn(msg, "sinkId") && msg.sinkId != null && msg.sinkId !== "") {
            return null;
          }
        } else {
          return null;
        }

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

    return {
      MAX_UNACKED: MAX_UNACKED,
      MAX_CHUNK_BYTES: MAX_CHUNK_BYTES,
      createFileSinkSession: createFileSinkSession,
      buildPgetCmd: buildPgetCmd,
      buildPgetSingleCmd: buildPgetSingleCmd,
    };
  }
);
