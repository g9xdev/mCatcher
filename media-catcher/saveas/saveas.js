"use strict";
/*
 * saveas.js — the persistent Save As window.
 *
 * A toolbar popup is destroyed the moment the native folder dialog takes focus,
 * which is why Save As lives in its own extension window instead. This module
 * owns only opaque IDs and safe display scalars: identity comes from the page
 * URL the background created, never from anything the page could forge.
 *
 * Dual-export: CommonJS module.exports and classic-script global McSaveAsWindow.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.McSaveAsWindow = api;
})(
  typeof self !== "undefined" ? self :
  (typeof globalThis !== "undefined" ? globalThis : this),
  function () {
    "use strict";

    var GENERIC_ENQUEUE_ERROR = "Couldn't start the download.";

    function resolveUi() {
      if (typeof McPopupDownloadUi !== "undefined") return McPopupDownloadUi;
      if (typeof require === "function") return require("../lib/popup-download-ui.js");
      return null;
    }

    function resolveSize() {
      if (typeof McMediaSize !== "undefined") return McMediaSize;
      if (typeof require === "function") return require("../lib/media-size.js");
      return null;
    }

    function humanSize(bytes) {
      if (!bytes) return "";
      var units = ["B", "KB", "MB", "GB"];
      var index = 0;
      var value = bytes;
      while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
      return value.toFixed(value < 10 && index > 0 ? 1 : 0) + " " + units[index];
    }

    function isNonEmptyString(value) {
      return typeof value === "string" && value.length > 0;
    }

    // The background is the only source of identity; a context missing any
    // required field leaves the page inert rather than guessing.
    function validateContext(response) {
      if (!response || typeof response !== "object" || response.ok !== true) return null;
      var context = response.context;
      if (!context || typeof context !== "object") return null;
      if (!Number.isInteger(context.tabId)) return null;
      if (!isNonEmptyString(context.mediaId)) return null;
      if (!isNonEmptyString(context.proposedFilename)) return null;
      var variantId = context.variantId == null ? null : context.variantId;
      if (variantId !== null && !isNonEmptyString(variantId)) return null;
      var safe = {
        tabId: context.tabId,
        mediaId: context.mediaId,
        variantId: variantId,
        proposedFilename: context.proposedFilename,
        knownExtension: isNonEmptyString(context.knownExtension) ? context.knownExtension : "",
        kind: isNonEmptyString(context.kind) ? context.kind : "direct",
      };
      var size = resolveSize();
      var chosen = size
        ? size.chooseSize(null, { sizeBytes: context.sizeBytes, sizeConfidence: context.sizeConfidence })
        : null;
      safe.sizeLabel = size ? size.sizeLabel(chosen, humanSize) : "Size unknown";
      return safe;
    }

    // Exactly the three shapes the background promises; anything else is junk.
    function readPickerResult(result) {
      if (!result || typeof result !== "object") return { kind: "invalid" };
      if (result.ok === true) {
        if (result.status === "selected") {
          return isNonEmptyString(result.dir)
            ? { kind: "selected", dir: result.dir }
            : { kind: "invalid" };
        }
        if (result.status === "cancelled") return { kind: "cancelled" };
        return { kind: "invalid" };
      }
      if (result.ok === false) {
        if (result.error === "folder_picker_timeout") return { kind: "timeout" };
        if (result.error === "folder_picker_failed") return { kind: "failed" };
        return { kind: "invalid" };
      }
      return { kind: "invalid" };
    }

    function createController(deps) {
      if (!deps || typeof deps.send !== "function") {
        throw new TypeError("createController requires a send function");
      }
      var send = deps.send;
      var close = typeof deps.close === "function" ? deps.close : function () {};
      var now = typeof deps.now === "function" ? deps.now
        : function () { return new Date().toISOString(); };
      var mintToken = typeof deps.mintToken === "function" ? deps.mintToken : defaultToken;
      var onChange = typeof deps.onChange === "function" ? deps.onChange : function () {};

      // Closed record: opaque IDs plus safe display scalars only.
      var context = null;
      var filename = "";
      var destinationDirectory = null;
      var status = "";
      var error = "";
      var pickerPending = false;
      var submitting = false;
      var finished = false;

      function defaultToken() {
        if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
          return crypto.randomUUID();
        }
        throw new Error("Secure user-action token mint unavailable");
      }

      function snapshot() {
        return {
          ready: context !== null,
          kind: context ? context.kind : "",
          proposedFilename: context ? context.proposedFilename : "",
          sizeLabel: context ? context.sizeLabel : "Size unknown",
          filename: filename,
          destinationDirectory: destinationDirectory,
          busy: pickerPending || submitting,
          status: status,
          error: error,
        };
      }

      function changed() {
        try { onChange(snapshot()); } catch (e) {}
      }

      function setError(message) {
        error = message;
        status = "";
        changed();
      }

      function setStatus(message) {
        status = message;
        error = "";
        changed();
      }

      async function load() {
        var response;
        try {
          response = await send({ type: "get-save-as-context" });
        } catch (e) {
          response = null;
        }
        context = validateContext(response);
        if (!context) {
          setError("This Save As window is no longer valid. Close it and try again.");
          return snapshot();
        }
        filename = context.proposedFilename;
        setStatus("");
        return snapshot();
      }

      function editFilename(value) {
        if (!context || finished) return;
        filename = typeof value === "string" ? value : "";
        changed();
      }

      async function chooseFolder() {
        if (!context || finished || pickerPending || submitting) return snapshot();
        pickerPending = true;
        setStatus("Waiting for the folder dialog…");
        var result;
        try {
          result = await send({ type: "pick-folder", dir: destinationDirectory || "" });
        } catch (e) {
          result = null;
        }
        pickerPending = false;
        var outcome = readPickerResult(result);
        if (outcome.kind === "selected") {
          destinationDirectory = outcome.dir;
          setStatus("");
        } else if (outcome.kind === "cancelled") {
          // The draft and any prior destination survive a cancelled dialog.
          setStatus("");
        } else if (outcome.kind === "timeout") {
          setError("The folder dialog timed out. You can try again or keep the default folder.");
        } else {
          setError("Couldn't open the folder dialog. You can still edit the filename.");
        }
        return snapshot();
      }

      async function confirm() {
        if (!context || finished || submitting) return snapshot();
        var ui = resolveUi();
        if (!ui) {
          setError(GENERIC_ENQUEUE_ERROR);
          return snapshot();
        }
        var decision;
        try {
          decision = ui.decideSaveAsForm({
            action: "confirm",
            proposedFilename: context.proposedFilename,
            editedFilename: filename,
            knownExtension: context.knownExtension,
            destinationDirectory: destinationDirectory,
            userActionToken: mintToken(),
            now: now,
          });
        } catch (e) {
          decision = null;
        }
        if (!decision || !decision.enqueue || !decision.intent) {
          setError("Enter a valid filename.");
          return snapshot();
        }

        submitting = true;
        setStatus("Starting…");
        var response;
        try {
          response = await send({
            type: "save-as-download",
            tabId: context.tabId,
            item: { id: context.mediaId },
            variantId: context.variantId,
            intent: decision.intent,
          });
        } catch (e) {
          response = null;
        }
        submitting = false;
        if (response && response.ok === true && response.job) {
          finished = true;
          setStatus("Started.");
          close();
          return snapshot();
        }
        // Keep the window and the draft so the user can correct and retry.
        setError(GENERIC_ENQUEUE_ERROR);
        return snapshot();
      }

      function cancel() {
        if (finished) return;
        finished = true;
        close();
      }

      return {
        load: load,
        snapshot: snapshot,
        editFilename: editFilename,
        chooseFolder: chooseFolder,
        confirm: confirm,
        cancel: cancel,
      };
    }

    return Object.freeze({ createController: createController });
  }
);

// ---------------------------------------------------------------------------
// Browser page bootstrap. Never runs under Node, where this file is only a
// module. Identity is already encoded in the URL the background created, so the
// page asks for its context and never asserts one.
// ---------------------------------------------------------------------------
(function () {
  "use strict";
  if (typeof document === "undefined" || typeof window === "undefined") return;
  var runtime = typeof browser !== "undefined" ? browser
    : (typeof chrome !== "undefined" ? chrome : null);
  if (!runtime || !runtime.runtime) return;

  function ready(start) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
  }

  ready(function () {
    var elements = {
      media: document.getElementById("media-line"),
      filename: document.getElementById("filename"),
      folder: document.getElementById("folder"),
      feedback: document.getElementById("feedback"),
      chooseFolder: document.getElementById("choose-folder"),
      confirm: document.getElementById("confirm"),
      cancel: document.getElementById("cancel"),
    };

    var controller = McSaveAsWindow.createController({
      send: function (message) { return runtime.runtime.sendMessage(message); },
      close: function () { window.close(); },
      onChange: paint,
    });

    function paint(state) {
      if (elements.media) {
        elements.media.textContent = [state.kind ? state.kind.toUpperCase() : "", state.sizeLabel]
          .filter(Boolean).join("  ·  ");
      }
      if (elements.filename && elements.filename.value !== state.filename) {
        elements.filename.value = state.filename;
      }
      if (elements.folder) {
        elements.folder.textContent = "Folder: " +
          (state.destinationDirectory || "default download location");
      }
      if (elements.feedback) {
        elements.feedback.textContent = state.error || state.status || "";
        elements.feedback.className = "feedback" + (state.error ? " error" : "");
      }
      var locked = state.busy || !state.ready;
      if (elements.confirm) elements.confirm.disabled = locked;
      if (elements.chooseFolder) elements.chooseFolder.disabled = locked;
      if (elements.filename) elements.filename.disabled = !state.ready;
    }

    if (elements.filename) {
      elements.filename.addEventListener("input", function () {
        controller.editFilename(elements.filename.value);
      });
    }
    if (elements.chooseFolder) {
      elements.chooseFolder.addEventListener("click", function () { controller.chooseFolder(); });
    }
    if (elements.confirm) {
      elements.confirm.addEventListener("click", function () { controller.confirm(); });
    }
    if (elements.cancel) {
      elements.cancel.addEventListener("click", function () { controller.cancel(); });
    }

    controller.load().then(paint, function () {});
  });
})();
