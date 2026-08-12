(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.McFirefoxGuard = api;
})(
  typeof self !== "undefined" ? self :
  (typeof globalThis !== "undefined" ? globalThis : this),
  function () {
    "use strict";

    function isNonblankPrimitiveString(v) {
      return typeof v === "string" && v.trim().length > 0;
    }

    function deepFreeze(o) {
      if (!o || typeof o !== "object" || Object.isFrozen(o)) return o;
      Object.getOwnPropertyNames(o).forEach(function (k) {
        var v = o[k];
        if (v && typeof v === "object") deepFreeze(v);
      });
      return Object.freeze(o);
    }

    /**
     * Validate explicit Firefox user intent and consume a one-time proof token.
     * Reads only named required intent fields. Never mints or restores tokens.
     */
    function assertUserFirefoxIntent(intent, expectedTokenStore) {
      if (!intent || typeof intent !== "object") {
        throw new TypeError("Firefox intent must be an object");
      }
      if (intent.userSelectedFirefox !== true) {
        throw new Error("userSelectedFirefox must be true");
      }
      if (!isNonblankPrimitiveString(intent.requestedFilename)) {
        throw new TypeError("requestedFilename must be a nonblank primitive string");
      }
      if (!isNonblankPrimitiveString(intent.userActionToken)) {
        throw new TypeError("userActionToken must be a nonblank primitive string");
      }
      if (
        !expectedTokenStore ||
        typeof expectedTokenStore !== "object" ||
        typeof expectedTokenStore.has !== "function" ||
        typeof expectedTokenStore.delete !== "function"
      ) {
        throw new TypeError("expectedTokenStore must provide callable has and delete");
      }

      var token = intent.userActionToken;
      if (expectedTokenStore.has(token) !== true) {
        throw new Error("Firefox proof token missing, forged, or already consumed");
      }

      var deleted = expectedTokenStore.delete(token);
      if (deleted !== true) {
        throw new Error("Firefox proof token delete did not confirm consumption");
      }
    }

    /**
     * Pure helper-unavailable UX policy. Fresh deeply frozen actions every call.
     * Never captures or invokes download/source/object-URL effects.
     */
    function helperUnavailableActions() {
      return deepFreeze([
        {
          id: "retry-install",
          label: "Install/reconnect helper",
          autoInvoke: false,
        },
        {
          id: "use-firefox",
          label: "Use Firefox instead",
          autoInvoke: false,
        },
        {
          id: "cancel",
          label: "Cancel",
          autoInvoke: false,
        },
      ]);
    }

    function validateSourceBeforeProof(source, createObjectURL, revokeObjectURL) {
      if (!source || typeof source !== "object") {
        throw new TypeError("source must be an object");
      }
      var type = source.type;
      if (type === "url") {
        if (typeof source.getUrl !== "function") {
          throw new TypeError("url source requires a getUrl function");
        }
        return { kind: "url" };
      }
      if (type === "bytes") {
        if (typeof createObjectURL !== "function" || typeof revokeObjectURL !== "function") {
          throw new TypeError(
            "bytes source requires createObjectURL and revokeObjectURL functions"
          );
        }
        if (source.bytes == null) {
          throw new TypeError("bytes source requires bytes");
        }
        var mime = source.mime;
        if (mime !== undefined && mime !== null && !isNonblankPrimitiveString(mime)) {
          throw new TypeError("mime must be absent or a nonblank primitive string");
        }
        return { kind: "bytes", mime: mime };
      }
      throw new TypeError("source type must be \"url\" or \"bytes\"");
    }

    function buildBlob(bytes, mime) {
      var type =
        mime === undefined || mime === null ? "application/octet-stream" : mime;
      if (typeof Blob !== "undefined" && bytes instanceof Blob) {
        return bytes;
      }
      return new Blob([bytes], { type: type });
    }

    function createFirefoxGuard(options) {
      if (!options || typeof options !== "object") {
        throw new TypeError("createFirefoxGuard requires an options object");
      }
      // Capture only named required/optional effects — never enumerate options.
      var downloadsDownload = options.downloadsDownload;
      var createObjectURL = options.createObjectURL;
      var revokeObjectURL = options.revokeObjectURL;
      if (typeof downloadsDownload !== "function") {
        throw new TypeError("downloadsDownload must be a function");
      }

      async function downloadWithFirefox(input) {
        if (!input || typeof input !== "object") {
          throw new TypeError("downloadWithFirefox requires an input object");
        }
        var intent = input.intent;
        var source = input.source;
        var tokenStore = input.tokenStore;

        // Structural source/effect checks before any proof consumption.
        var validated = validateSourceBeforeProof(
          source,
          createObjectURL,
          revokeObjectURL
        );

        // Consume one-time proof synchronously before any await or materialization.
        assertUserFirefoxIntent(intent, tokenStore);

        var filename = intent.requestedFilename;
        var url;
        var objectUrl = null;
        var shouldRevoke = false;

        if (validated.kind === "url") {
          var resolved = source.getUrl();
          if (resolved != null && typeof resolved.then === "function") {
            resolved = await resolved;
          }
          if (!isNonblankPrimitiveString(resolved)) {
            // Do not interpolate the resolved value into the error message.
            throw new TypeError("getUrl must resolve to a nonblank primitive URL string");
          }
          url = resolved;
        } else {
          var blob = buildBlob(source.bytes, validated.mime);
          objectUrl = createObjectURL(blob);
          if (!isNonblankPrimitiveString(objectUrl)) {
            throw new TypeError("createObjectURL must return a nonblank URL string");
          }
          shouldRevoke = true;
          url = objectUrl;
        }

        var apiOpts = Object.freeze({
          url: url,
          filename: filename,
          saveAs: true,
        });

        try {
          return await downloadsDownload(apiOpts);
        } finally {
          if (shouldRevoke) {
            try {
              revokeObjectURL(objectUrl);
            } catch (revokeErr) {
              // Cleanup failure must not mask the primary API result/error.
            }
          }
        }
      }

      return Object.freeze({
        downloadWithFirefox: downloadWithFirefox,
      });
    }

    return {
      createFirefoxGuard: createFirefoxGuard,
      assertUserFirefoxIntent: assertUserFirefoxIntent,
      helperUnavailableActions: helperUnavailableActions,
    };
  }
);
