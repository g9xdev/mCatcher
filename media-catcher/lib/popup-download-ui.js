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

  function resolveRanker() {
    if (typeof require === "function") {
      try {
        return require("./filename-ranker.js");
      } catch (e) {
        // Browser dual-export load path uses the global.
      }
    }
    if (root && root.McFilenameRanker) return root.McFilenameRanker;
    throw new Error("McFilenameRanker is required for PopupDownloadUi");
  }

  function resolveIntent() {
    if (typeof require === "function") {
      try {
        return require("./download-intent.js");
      } catch (e) {
        // Browser dual-export load path uses the global.
      }
    }
    if (root && root.McDownloadIntent) return root.McDownloadIntent;
    throw new Error("McDownloadIntent is required for PopupDownloadUi");
  }

  function providerLabel(job) {
    if (!job || typeof job !== "object") return "provider";
    var key = job.providerKey;
    if (typeof key === "string" && key.trim()) return key.trim();
    return "provider";
  }

  function formatJobStatus(job) {
    if (!job || typeof job !== "object") return "Unknown";
    var state = job.state;
    if (typeof state !== "string") return "Unknown";
    var provider = providerLabel(job);
    switch (state) {
      case "queued":
        return "Queued";
      case "waiting_provider":
        return "Waiting for " + provider;
      case "running":
        if (job.reduced) return "Retrying at reduced concurrency";
        return "Downloading";
      case "retry_backoff":
        return "Retrying at reduced concurrency";
      case "pausing_provider":
        return "Pausing for " + provider;
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
        return "Unknown";
    }
  }

  function positiveNumber(value) {
    return typeof value === "number" && isFinite(value) && value > 0 ? value : 0;
  }

  function isFinishedRow(dl) {
    return dl.status === "done" || dl.status === "completed" || dl.state === "completed";
  }

  // How big is this file, in bytes: {done, total}, with 0 meaning "not known".
  //
  // ONE answer for both panes. The queue card already sized a finished row from
  // dl.recorded.bytes and an in-flight one from progress.total; percent-scaled
  // rows (yt-dlp reports a percentage) fitted neither, because on those
  // progress.total is the denominator 100 that drives the bar and the real byte
  // total travels beside it as progress.totalBytes. Rather than teaching each
  // of the four render sites that distinction, they all ask here.
  //
  // `done` for a percent row is derived from the percentage, not reported: the
  // helper's two progress sources (the yt-dlp library hook and the exe's stdout
  // lines) agree on a percentage and a total and nothing else, so a
  // bytes-so-far field would exist on one path only.
  function downloadSizeBytes(dl) {
    var none = { done: 0, total: 0 };
    if (!dl || typeof dl !== "object") return none;
    var progress = (dl.progress && typeof dl.progress === "object") ? dl.progress : {};
    var recorded = (dl.recorded && typeof dl.recorded === "object") ? dl.recorded : {};

    var total = positiveNumber(recorded.bytes) ||
      positiveNumber(progress.totalBytes) ||
      (progress.unit === "bytes" ? positiveNumber(progress.total) : 0);
    if (!total) return none;
    if (isFinishedRow(dl)) return { done: total, total: total };
    if (progress.unit === "bytes") return { done: positiveNumber(progress.done), total: total };
    if (progress.unit === "pct") {
      var pct = Math.min(100, positiveNumber(progress.done));
      return { done: Math.round((total * pct) / 100), total: total };
    }
    return { done: 0, total: total };
  }

  function pathLeaf(value) {
    var s = String(value == null ? "" : value).trim();
    if (!s) return "";
    s = s.replace(/[/\\]+$/, "");
    if (!s) return "";
    var slash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return slash >= 0 ? s.slice(slash + 1) : s;
  }

  function validateSaveAsFilename(edited, knownExtension) {
    var raw = String(edited == null ? "" : edited);
    var trimmed = raw.trim();
    if (!trimmed) {
      return { ok: false, filename: "", warning: null };
    }
    // Reject path-only / path-bearing values: Save As edits a bare filename only.
    if (/[/\\]/.test(trimmed)) {
      return { ok: false, filename: "", warning: null };
    }
    var leaf = pathLeaf(trimmed);
    if (!leaf || !String(leaf).trim()) {
      return { ok: false, filename: "", warning: null };
    }

    var Ranker = resolveRanker();
    var withExt = Ranker.ensureExtension(trimmed, knownExtension);
    var filename = Ranker.sanitizeFilename(withExt);
    if (!filename || !String(filename).trim()) {
      return { ok: false, filename: "", warning: null };
    }

    var warning = null;
    var known = knownExtension ? String(knownExtension) : "";
    if (known) {
      if (known.charAt(0) !== ".") known = "." + known;
      var m = filename.match(Ranker.MEDIA_EXT_RE);
      if (m && m[0].toLowerCase() !== known.toLowerCase()) {
        warning = "Keeping " + m[0] + " (differs from source " + known + ")";
      }
    }
    return { ok: true, filename: filename, warning: warning };
  }

  function decideSaveAsForm(input) {
    // Cancel must return immediately without reading any other property/getter.
    if (input && input.action === "cancel") return null;
    if (!input || typeof input !== "object") return null;
    if (input.action !== "confirm") return null;

    var validation = validateSaveAsFilename(input.editedFilename, input.knownExtension);
    if (!validation.ok) return null;

    var Intent = resolveIntent();
    var intent;
    try {
      intent = Intent.createSaveAsIntent({
        proposedFilename: input.proposedFilename,
        editedFilename: input.editedFilename,
        destinationDirectory: input.destinationDirectory,
        userActionToken: input.userActionToken,
        knownExtension: input.knownExtension,
        now: input.now,
      });
    } catch (e) {
      return null;
    }
    return Object.freeze({ enqueue: true, intent: intent });
  }

  function nonBlankString(value) {
    return typeof value === "string" && value.trim().length > 0;
  }

  function proposedFromItem(item) {
    if (!item || typeof item !== "object") return "";
    if (nonBlankString(item.proposedFilename)) return item.proposedFilename;
    if (nonBlankString(item.name)) return item.name;
    return "";
  }

  function selectionValue(selection, key, defaultValue) {
    if (!selection || typeof selection !== "object") return defaultValue;
    if (!Object.prototype.hasOwnProperty.call(selection, key)) return defaultValue;
    var v = selection[key];
    if (v === undefined) return defaultValue;
    return v;
  }

  function buildDownloadMessage(input) {
    input = input || {};
    var item = input.item;
    var selection = input.selection;
    var Intent = resolveIntent();
    var intent = input.intent;

    if (!intent) {
      if (!nonBlankString(input.userActionToken)) {
        throw new Error("userActionToken must be a non-empty string");
      }
      var proposed = proposedFromItem(item);
      if (!nonBlankString(proposed)) {
        throw new Error("proposedFilename must be a non-empty string");
      }
      intent = Intent.createDefaultIntent({
        proposedFilename: proposed,
        destinationDirectory:
          input.destinationDirectory === undefined ? null : input.destinationDirectory,
        userActionToken: input.userActionToken,
        now: input.now,
      });
    }

    return {
      type: "download",
      item: item,
      tabId: input.tabId,
      intent: intent,
      variantUrl: selectionValue(selection, "variantUrl", null),
      variantId: selectionValue(selection, "variantId", null),
      ytHeight: selectionValue(selection, "ytHeight", null),
      ytAudioOnly: selectionValue(selection, "ytAudioOnly", false) === true,
    };
  }

  return Object.freeze({
    formatJobStatus: formatJobStatus,
    downloadSizeBytes: downloadSizeBytes,
    validateSaveAsFilename: validateSaveAsFilename,
    decideSaveAsForm: decideSaveAsForm,
    buildDownloadMessage: buildDownloadMessage,
  });
});
