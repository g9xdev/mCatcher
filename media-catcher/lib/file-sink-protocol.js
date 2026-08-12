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
     * Own-key presence without invoking accessors.
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

    /** Reject C0, DEL, and C1 controls in HTTP-context strings. */
    function isSafeHttpContextString(v) {
      return typeof v === "string" && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
    }

    /**
     * Only ABSENT referer/userAgent normalize to "".
     * Present values must be primitive strings without control characters.
     * Present null/undefined/object/accessor are invalid.
     */
    function normalizeHttpContextField(input, key) {
      var state = ownKeyState(input, key);
      if (!state.present) return "";
      if (!state.data) {
        throw new TypeError(key + " must be a primitive string without control characters");
      }
      if (!isSafeHttpContextString(state.value)) {
        throw new TypeError(key + " must be a primitive string without control characters");
      }
      return state.value;
    }

    function requireProviderGeneration(v) {
      if (!isNonnegInt(v)) {
        throw new TypeError("providerGeneration must be a nonnegative integer");
      }
      return v;
    }

    /**
     * Require own-data nonnegative integer providerGeneration.
     * Missing/undefined/null/accessor/bool/fractional/negative/object throw TypeError
     * without invoking accessors. No silent default to 0.
     */
    function readProviderGeneration(input) {
      var state = ownKeyState(input, "providerGeneration");
      if (!state.present || !state.data) {
        throw new TypeError("providerGeneration must be a nonnegative integer");
      }
      return requireProviderGeneration(state.value);
    }

    /**
     * Descriptor-safe mirrors snapshot.
     * Primary URL first, then exact-string-deduped valid nonblank string mirrors.
     * Own-data blank/non-string entries are omitted (closed skip contract).
     * Sparse holes, accessors, hostile length, and non-array length semantics throw TypeError.
     * Never mutates caller arrays; never invokes getters/proxy traps.
     */
    function buildUrlsList(url, mirrors) {
      requireNonblankString(url, "url");
      var out = [url];
      var seen = Object.create(null);
      seen[url] = true;
      if (mirrors == null) return Object.freeze(out);
      if (!Array.isArray(mirrors)) return Object.freeze(out);

      var lenState = ownKeyState(mirrors, "length");
      if (!lenState.present || !lenState.data || !isNonnegInt(lenState.value)) {
        throw new TypeError("mirrors must be a dense array of primitive strings");
      }
      var len = lenState.value;
      for (var i = 0; i < len; i++) {
        var entry = ownData(mirrors, String(i));
        if (!entry.ok) {
          throw new TypeError("mirrors must be a dense array of primitive strings");
        }
        var m = entry.value;
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

    function readOptionalEffectiveDir(input) {
      var effR = ownKeyState(input, "effectiveDestinationDirectory");
      if (!effR.present) return undefined;
      if (!effR.data) {
        throw new TypeError(
          "effectiveDestinationDirectory must be a nonblank primitive string when provided"
        );
      }
      return effR.value;
    }

    function readOptionalMirrors(input) {
      var mirrorsState = ownKeyState(input, "mirrors");
      if (!mirrorsState.present) return null;
      if (!mirrorsState.data) {
        throw new TypeError("mirrors must be a dense array of primitive strings");
      }
      return mirrorsState.value;
    }

    function buildPgetCmd(input) {
      input = input || {};
      var jobId = requireNonblankString(input.jobId, "jobId");
      var attemptToken = requireNonblankString(input.attemptToken, "attemptToken");
      var url = requireNonblankString(input.url, "url");
      var maxR = ownData(input, "maxConnections");
      if (!maxR.ok || !isPositiveInt(maxR.value)) {
        throw new TypeError("maxConnections must be a positive integer");
      }
      var providerGeneration = readProviderGeneration(input);
      var referer = normalizeHttpContextField(input, "referer");
      var userAgent = normalizeHttpContextField(input, "userAgent");
      var intentR = ownData(input, "intent");
      if (!intentR.ok) throw new TypeError("intent must be an object");
      var bound = readIntentNameDir(intentR.value, readOptionalEffectiveDir(input));
      var urls = buildUrlsList(url, readOptionalMirrors(input));
      return freezeCmd({
        cmd: "pget",
        id: jobId,
        attemptToken: attemptToken,
        urls: urls,
        name: bound.name,
        dir: bound.dir,
        maxConnections: maxR.value,
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
      var referer = normalizeHttpContextField(input, "referer");
      var userAgent = normalizeHttpContextField(input, "userAgent");
      var intentR = ownData(input, "intent");
      if (!intentR.ok) throw new TypeError("intent must be an object");
      var bound = readIntentNameDir(intentR.value, readOptionalEffectiveDir(input));
      var urls = buildUrlsList(url, readOptionalMirrors(input));
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
      var providerGeneration = readProviderGeneration(input);
      var limR = ownData(input, "maxConnections");
      if (!limR.ok || !isNonnegInt(limR.value)) {
        throw new TypeError("maxConnections must be a nonnegative integer");
      }
      return freezeCmd({
        cmd: "pget-set-limit",
        id: jobId,
        attemptToken: attemptToken,
        providerGeneration: providerGeneration,
        maxConnections: limR.value,
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
