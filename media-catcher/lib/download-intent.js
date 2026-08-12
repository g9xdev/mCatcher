(function (root, factory) {
  "use strict";
  var api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.McDownloadIntent = api;
})(
  typeof self !== "undefined" ? self :
  (typeof globalThis !== "undefined" ? globalThis : this),
  function (root) {
  "use strict";

  function resolveRanker() {
    if (typeof require === "function") {
      try {
        return require("./filename-ranker.js");
      } catch (e) {
        // Browser dual-export load path uses the global.
      }
    }
    if (root && root.McFilenameRanker) return root.McFilenameRanker;
    throw new Error("McFilenameRanker is required for DownloadIntent");
  }

  function deepFreeze(o) {
    if (!o || typeof o !== "object" || Object.isFrozen(o)) return o;
    Object.getOwnPropertyNames(o).forEach(function (k) {
      var v = o[k];
      if (v && typeof v === "object") deepFreeze(v);
    });
    return Object.freeze(o);
  }

  function nonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
  }

  function requireNonEmptyFilename(value, label) {
    if (!nonEmptyString(value)) {
      throw new Error(label + " must be a non-empty string");
    }
    return value;
  }

  function requireUserActionToken(token) {
    if (!nonEmptyString(token)) {
      throw new Error("userActionToken must be a non-empty string");
    }
    return token;
  }

  function destinationOf(value) {
    // Preserve exactly: null stays null; any other value is kept as provided.
    return value === undefined ? null : value;
  }

  function createdAtOf(now) {
    if (typeof now === "function") return String(now());
    return String(new Date().toISOString());
  }

  function freezeIntent(intent) {
    return deepFreeze(intent);
  }

  function createDefaultIntent(input) {
    input = input || {};
    var proposed = requireNonEmptyFilename(input.proposedFilename, "proposedFilename");
    var token = requireUserActionToken(input.userActionToken);
    return freezeIntent({
      requestedFilename: proposed,
      destinationDirectory: destinationOf(input.destinationDirectory),
      saveMode: "default",
      userSelectedFirefox: false,
      userActionToken: token,
      createdAt: createdAtOf(input.now),
    });
  }

  function createSaveAsIntent(input) {
    input = input || {};
    requireNonEmptyFilename(input.proposedFilename, "proposedFilename");
    var token = requireUserActionToken(input.userActionToken);
    var Ranker = resolveRanker();
    var edited = String(input.editedFilename == null ? "" : input.editedFilename);
    var withExt = Ranker.ensureExtension(edited, input.knownExtension);
    var requested = Ranker.sanitizeFilename(withExt);
    requireNonEmptyFilename(requested, "requestedFilename");
    return freezeIntent({
      requestedFilename: requested,
      destinationDirectory: destinationOf(input.destinationDirectory),
      saveMode: "save-as",
      userSelectedFirefox: false,
      userActionToken: token,
      createdAt: createdAtOf(input.now),
    });
  }

  function createFirefoxIntent(input) {
    input = input || {};
    var base = input.baseIntent || {};
    var requested = requireNonEmptyFilename(base.requestedFilename, "requestedFilename");
    var token = requireUserActionToken(base.userActionToken);
    // Fresh object — never mutate baseIntent; never invent a token.
    return freezeIntent({
      requestedFilename: requested,
      destinationDirectory: destinationOf(base.destinationDirectory),
      saveMode: base.saveMode === "save-as" ? "save-as" : "default",
      userSelectedFirefox: true,
      userActionToken: token,
      createdAt: String(base.createdAt == null ? "" : base.createdAt),
    });
  }

  return {
    createDefaultIntent: createDefaultIntent,
    createSaveAsIntent: createSaveAsIntent,
    createFirefoxIntent: createFirefoxIntent,
  };
});
