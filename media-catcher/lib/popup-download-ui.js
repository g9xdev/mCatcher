(function (root, factory) {
  "use strict";
  var api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.McPopupDownloadUi = api;
})(
  typeof self !== "undefined" ? self :
  (typeof globalThis !== "undefined" ? globalThis : this),
  function (root) {
  "use strict";

  var MEDIA_EXT_RE = /\.(mp4|m4v|webm|mkv|mov|mp3|m4a|aac|flac|ogg|opus|ts|m2ts|mpeg|mpg)$/i;
  var PROVIDER_FALLBACK = "provider";
  var UNKNOWN_STATUS = "Unknown";

  function resolveIntent() {
    if (typeof require === "function") {
      try {
        return require("./download-intent.js");
      } catch (e) {
        // Browser dual-export load path uses the global.
      }
    }
    if (root && root.McDownloadIntent) return root.McDownloadIntent;
    throw new Error("McDownloadIntent is required for McPopupDownloadUi");
  }

  function resolveRanker() {
    if (typeof require === "function") {
      try {
        return require("./filename-ranker.js");
      } catch (e) {
        // Browser dual-export load path uses the global.
      }
    }
    if (root && root.McFilenameRanker) return root.McFilenameRanker;
    throw new Error("McFilenameRanker is required for McPopupDownloadUi");
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

  function requireUserActionToken(token) {
    if (!nonEmptyString(token)) {
      throw new Error("userActionToken must be a non-empty string");
    }
    return token;
  }

  function providerLabel(key) {
    if (typeof key === "string" && key.trim().length > 0) return key.trim();
    return PROVIDER_FALLBACK;
  }

  function formatJobStatus(job) {
    try {
      if (!job || typeof job !== "object") return UNKNOWN_STATUS;
      var state = job.state;
      if (typeof state !== "string" || !state) return UNKNOWN_STATUS;
      switch (state) {
        case "queued":
          return "Queued";
        case "waiting_provider":
          return "Waiting for " + providerLabel(job.providerKey);
        case "running":
          if (job.reduced === true) return "Retrying at reduced concurrency";
          return "Downloading";
        case "retry_backoff":
          return "Retrying at reduced concurrency";
        case "pausing_provider":
          return "Pausing for " + providerLabel(job.providerKey);
        case "needs_user":
          return "Needs attention";
        case "handing_off_firefox":
          return "Handing off to Firefox";
        case "handed_to_firefox":
          return "Handed to Firefox";
        case "failed":
          return "Failed";
        case "completed":
          return "Completed";
        case "cancelled":
          return "Cancelled";
        default:
          return UNKNOWN_STATUS;
      }
    } catch (e) {
      return UNKNOWN_STATUS;
    }
  }

  function fileBaseName(value) {
    var s = String(value || "").replace(/[/\\]+$/, "");
    var slash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return slash >= 0 ? s.slice(slash + 1) : s;
  }

  function normalizeExt(ext) {
    if (ext == null || ext === "") return "";
    var s = String(ext);
    if (!s) return "";
    if (s.charAt(0) !== ".") s = "." + s;
    return s.toLowerCase();
  }

  function mediaExtOf(name) {
    var m = String(name || "").match(MEDIA_EXT_RE);
    return m ? m[0].toLowerCase() : "";
  }

  function anyExtOf(name) {
    var m = String(name || "").match(/(\.[a-z0-9]{1,8})$/i);
    return m ? m[1].toLowerCase() : "";
  }

  function validateSaveAsFilename(edited, knownExtension) {
    var Ranker = resolveRanker();
    var raw = edited == null ? "" : String(edited);
    if (!raw.trim()) {
      return deepFreeze({ ok: false, filename: "", warning: null });
    }
    // Path separators / path-only edits are invalid in the filename field.
    if (/[/\\]/.test(raw)) {
      return deepFreeze({ ok: false, filename: "", warning: null });
    }
    var base = fileBaseName(raw).trim();
    if (!base || /^\.+$/.test(base)) {
      return deepFreeze({ ok: false, filename: "", warning: null });
    }
    var withExt = Ranker.ensureExtension(base, knownExtension);
    var filename = Ranker.sanitizeFilename(withExt);
    if (!nonEmptyString(filename)) {
      return deepFreeze({ ok: false, filename: "", warning: null });
    }
    var known = normalizeExt(knownExtension);
    var finalExt = mediaExtOf(filename) || anyExtOf(filename);
    var warning = null;
    if (known && finalExt && finalExt !== known) {
      warning = "Extension changed from " + known + " to " + finalExt;
    }
    return deepFreeze({ ok: true, filename: filename, warning: warning });
  }

  function proposedFromItem(item) {
    item = item || {};
    if (nonEmptyString(item.proposedFilename)) return String(item.proposedFilename).trim();
    if (nonEmptyString(item.name)) return String(item.name).trim();
    return "";
  }

  function selectionField(selection, key, defaultValue) {
    if (!selection || typeof selection !== "object") return defaultValue;
    if (!Object.prototype.hasOwnProperty.call(selection, key)) return defaultValue;
    var v = selection[key];
    if (v === undefined || v === null) return defaultValue;
    return v;
  }

  function buildDownloadMessage(input) {
    input = input || {};
    var item = input.item;
    if (!item || typeof item !== "object") {
      throw new Error("item is required");
    }
    var selection = input.selection;
    var intent = input.intent;
    if (!intent) {
      var Intent = resolveIntent();
      var token = requireUserActionToken(input.userActionToken);
      var proposed = proposedFromItem(item);
      if (!nonEmptyString(proposed)) {
        throw new Error("proposedFilename must be a non-empty string");
      }
      intent = Intent.createDefaultIntent({
        proposedFilename: proposed,
        destinationDirectory: input.destinationDirectory === undefined ? null : input.destinationDirectory,
        userActionToken: token,
        now: input.now,
      });
    }

    // Fresh allowlisted shell. Do not deep-freeze `item` (caller-owned reference).
    return Object.freeze({
      type: "download",
      item: item,
      tabId: input.tabId,
      intent: intent,
      variantUrl: selectionField(selection, "variantUrl", null),
      variantId: selectionField(selection, "variantId", null),
      ytHeight: selectionField(selection, "ytHeight", null),
      ytAudioOnly: selectionField(selection, "ytAudioOnly", false) === true,
    });
  }

  function decideSaveAsForm(input) {
    input = input || {};
    // Cancel must short-circuit before reading any other fields.
    if (input.action === "cancel") return null;

    var Intent = resolveIntent();
    var token = requireUserActionToken(input.userActionToken);
    var edited = input.editedFilename;
    var known = input.knownExtension;
    var validation = validateSaveAsFilename(edited, known);
    if (!validation.ok) {
      return Object.freeze({
        enqueue: false,
        intent: null,
        error: "Invalid filename",
        warning: null,
      });
    }

    // Use the validated/sanitized basename so path segments cannot diverge from validation.
    var intent = Intent.createSaveAsIntent({
      proposedFilename: input.proposedFilename,
      editedFilename: validation.filename,
      knownExtension: known,
      destinationDirectory: input.destinationDirectory === undefined ? null : input.destinationDirectory,
      userActionToken: token,
      now: input.now,
    });

    return Object.freeze({
      enqueue: true,
      intent: intent,
      warning: validation.warning,
    });
  }

  return Object.freeze({
    formatJobStatus: formatJobStatus,
    validateSaveAsFilename: validateSaveAsFilename,
    decideSaveAsForm: decideSaveAsForm,
    buildDownloadMessage: buildDownloadMessage,
  });
});
