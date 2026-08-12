"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const { loadLib, mediaCatcherRoot } = require("./harness/load-lib.js");

// Ensure ranker is resolvable for intent + UI dual-export paths.
loadLib("lib/filename-ranker.js");
const Intent = loadLib("lib/download-intent.js");
const UI = loadLib("lib/popup-download-ui.js");

test("status labels match observability table including drain and firefox states", () => {
  assert.equal(UI.formatJobStatus({ state: "queued" }), "Queued");
  assert.equal(
    UI.formatJobStatus({ state: "waiting_provider", providerKey: "florenfile.com" }),
    "Waiting for florenfile.com"
  );
  assert.equal(UI.formatJobStatus({ state: "running", mode: "multi-range" }), "Downloading");
  assert.equal(
    UI.formatJobStatus({ state: "running", reduced: true }),
    "Retrying at reduced concurrency"
  );
  assert.equal(
    UI.formatJobStatus({ state: "retry_backoff", providerKey: "florenfile.com" }),
    "Retrying at reduced concurrency"
  );
  assert.equal(
    UI.formatJobStatus({ state: "pausing_provider", providerKey: "florenfile.com" }),
    "Pausing for florenfile.com"
  );
  assert.equal(UI.formatJobStatus({ state: "needs_user" }), "Needs attention");
  assert.equal(UI.formatJobStatus({ state: "handing_off_firefox" }), "Handing off to Firefox");
  assert.equal(UI.formatJobStatus({ state: "handed_to_firefox" }), "Handed to Firefox");
  assert.equal(UI.formatJobStatus({ state: "failed" }), "Failed");
  assert.equal(UI.formatJobStatus({ state: "completed" }), "Completed");
  assert.equal(UI.formatJobStatus({ state: "cancelled" }), "Cancelled");
});

test("provider labels fall back to provider never undefined or null", () => {
  assert.equal(UI.formatJobStatus({ state: "waiting_provider" }), "Waiting for provider");
  assert.equal(
    UI.formatJobStatus({ state: "waiting_provider", providerKey: "" }),
    "Waiting for provider"
  );
  assert.equal(
    UI.formatJobStatus({ state: "waiting_provider", providerKey: null }),
    "Waiting for provider"
  );
  assert.equal(
    UI.formatJobStatus({ state: "pausing_provider", providerKey: "   " }),
    "Pausing for provider"
  );
  const label = UI.formatJobStatus({ state: "waiting_provider", providerKey: undefined });
  assert.equal(label.includes("undefined"), false);
  assert.equal(label.includes("null"), false);
});

test("unknown or malformed job status never throws and returns deterministic harmless label", () => {
  assert.equal(UI.formatJobStatus(null), "Unknown");
  assert.equal(UI.formatJobStatus(undefined), "Unknown");
  assert.equal(UI.formatJobStatus({}), "Unknown");
  assert.equal(UI.formatJobStatus({ state: "not-a-real-state" }), "Unknown");
  assert.equal(UI.formatJobStatus({ state: 42 }), "Unknown");
  assert.equal(UI.formatJobStatus("queued"), "Unknown");
  assert.doesNotThrow(() => UI.formatJobStatus({ state: "running", reduced: "yes" }));
});

test("Save As cancel returns null and must not produce an enqueue message", () => {
  const decision = UI.decideSaveAsForm({
    action: "cancel",
    proposedFilename: "11238-makemebi.net.mp4",
  });
  assert.equal(decision, null);
});

test("hostile cancel getters are never read beyond action", () => {
  let touches = 0;
  const hostile = {
    get action() {
      return "cancel";
    },
    get proposedFilename() {
      touches += 1;
      throw new Error("must not read proposedFilename on cancel");
    },
    get editedFilename() {
      touches += 1;
      throw new Error("must not read editedFilename on cancel");
    },
    get userActionToken() {
      touches += 1;
      throw new Error("must not read token on cancel");
    },
    get destinationDirectory() {
      touches += 1;
      throw new Error("must not read destination on cancel");
    },
    get knownExtension() {
      touches += 1;
      throw new Error("must not read knownExtension on cancel");
    },
    get now() {
      touches += 1;
      throw new Error("must not read now on cancel");
    },
  };
  assert.equal(UI.decideSaveAsForm(hostile), null);
  assert.equal(touches, 0);
});

test("Save As confirm builds save-as intent with edited name", () => {
  const decision = UI.decideSaveAsForm({
    action: "confirm",
    proposedFilename: "11238-makemebi.net.mp4",
    editedFilename: "my-cut",
    knownExtension: ".mp4",
    destinationDirectory: null,
    userActionToken: "tok-ui",
    now: () => "2026-08-12T12:00:00.000Z",
  });
  assert.equal(decision.intent.saveMode, "save-as");
  assert.equal(decision.intent.requestedFilename, "my-cut.mp4");
  assert.equal(decision.enqueue, true);
});

test("unchanged Florenfile Save As keeps proposal and freezes decision/intent", () => {
  const decision = UI.decideSaveAsForm({
    action: "confirm",
    proposedFilename: "11238-makemebi.net.mp4",
    editedFilename: "11238-makemebi.net.mp4",
    knownExtension: ".mp4",
    destinationDirectory: "D:\\\\Vids",
    userActionToken: "tok-floren",
    now: () => "2026-08-12T12:00:00.000Z",
  });
  assert.equal(decision.enqueue, true);
  assert.equal(decision.intent.requestedFilename, "11238-makemebi.net.mp4");
  assert.equal(decision.intent.saveMode, "save-as");
  assert.equal(decision.intent.destinationDirectory, "D:\\\\Vids");
  assert.ok(Object.isFrozen(decision));
  assert.ok(Object.isFrozen(decision.intent));
  assert.throws(() => {
    decision.enqueue = false;
  });
  assert.throws(() => {
    decision.intent.requestedFilename = "x";
  });
});

test("destinationDirectory is preserved on confirm including null", () => {
  const withDir = UI.decideSaveAsForm({
    action: "confirm",
    proposedFilename: "a.mp4",
    editedFilename: "a.mp4",
    knownExtension: ".mp4",
    destinationDirectory: "E:\\\\Media",
    userActionToken: "tok-d1",
    now: () => "t",
  });
  assert.equal(withDir.intent.destinationDirectory, "E:\\\\Media");
  const noDir = UI.decideSaveAsForm({
    action: "confirm",
    proposedFilename: "a.mp4",
    editedFilename: "a.mp4",
    knownExtension: ".mp4",
    destinationDirectory: null,
    userActionToken: "tok-d2",
    now: () => "t",
  });
  assert.equal(noDir.intent.destinationDirectory, null);
});

test("invalid confirmation does not enqueue", () => {
  assert.equal(
    UI.decideSaveAsForm({
      action: "confirm",
      proposedFilename: "a.mp4",
      editedFilename: "",
      knownExtension: ".mp4",
      destinationDirectory: null,
      userActionToken: "tok",
      now: () => "t",
    }),
    null
  );
  assert.equal(
    UI.decideSaveAsForm({
      action: "confirm",
      proposedFilename: "a.mp4",
      editedFilename: "   ",
      knownExtension: ".mp4",
      destinationDirectory: null,
      userActionToken: "tok",
      now: () => "t",
    }),
    null
  );
  assert.equal(
    UI.decideSaveAsForm({
      action: "confirm",
      proposedFilename: "a.mp4",
      editedFilename: "good.mp4",
      knownExtension: ".mp4",
      destinationDirectory: null,
      userActionToken: "",
      now: () => "t",
    }),
    null
  );
});

test("validateSaveAsFilename appends known extension when missing", () => {
  const r = UI.validateSaveAsFilename("myvideo", ".mp4");
  assert.equal(r.ok, true);
  assert.equal(r.filename, "myvideo.mp4");
  assert.equal(r.warning, null);
});

test("validateSaveAsFilename warns when different valid extension is kept", () => {
  const r = UI.validateSaveAsFilename("myvideo.mkv", ".mp4");
  assert.equal(r.ok, true);
  assert.equal(r.filename, "myvideo.mkv");
  assert.ok(r.warning);
  assert.match(String(r.warning), /mkv/i);
});

test("validateSaveAsFilename rejects blank and path-only values", () => {
  assert.equal(UI.validateSaveAsFilename("", ".mp4").ok, false);
  assert.equal(UI.validateSaveAsFilename("   ", ".mp4").ok, false);
  assert.equal(UI.validateSaveAsFilename("/", ".mp4").ok, false);
  assert.equal(UI.validateSaveAsFilename("\\\\", ".mp4").ok, false);
  assert.equal(UI.validateSaveAsFilename("C:\\\\folder\\\\", ".mp4").ok, false);
  assert.equal(UI.validateSaveAsFilename("foo/bar/", ".mp4").ok, false);
});

test("Download button builds default intent from proposedFilename", () => {
  const msg = UI.buildDownloadMessage({
    item: {
      url: "https://x/a.mp4",
      kind: "direct",
      proposedFilename: "11238-makemebi.net.mp4",
      tabId: 3,
    },
    tabId: 3,
    userActionToken: "tok-d",
    now: () => "t",
    selection: {},
  });
  assert.equal(msg.type, "download");
  assert.equal(msg.intent.requestedFilename, "11238-makemebi.net.mp4");
  assert.equal(msg.intent.saveMode, "default");
  assert.equal(msg.intent.userSelectedFirefox, false);
  assert.equal(Object.prototype.hasOwnProperty.call(msg, "filename"), false);
});

test("Florenfile proposal beats generic pageTitle and blank name fallback", () => {
  const msg = UI.buildDownloadMessage({
    item: {
      url: "https://florenfile.com/x",
      kind: "direct",
      proposedFilename: "11238-makemebi.net.mp4",
      pageTitle: "Florenfile.com - Secure Cloud Storage",
      name: "video.mp4",
    },
    tabId: 1,
    userActionToken: "tok-prop",
    now: () => "t",
    selection: {},
  });
  assert.equal(msg.intent.requestedFilename, "11238-makemebi.net.mp4");

  const fallback = UI.buildDownloadMessage({
    item: {
      url: "https://x/a",
      kind: "direct",
      name: "clip-from-name.mp4",
      pageTitle: "Generic Title",
    },
    tabId: 1,
    userActionToken: "tok-name",
    now: () => "t",
    selection: {},
  });
  assert.equal(fallback.intent.requestedFilename, "clip-from-name.mp4");
});

test("selection allowlist preserves values without truthiness bugs and defaults", () => {
  const msg = UI.buildDownloadMessage({
    item: { url: "https://x/a", kind: "youtube", proposedFilename: "yt.mp4" },
    tabId: 9,
    userActionToken: "tok-sel",
    now: () => "t",
    selection: {
      variantUrl: "https://cdn/v0",
      variantId: "0",
      ytHeight: 0,
      ytAudioOnly: false,
      hostileExtra: "drop-me",
      filename: "should-not-leak",
    },
  });
  assert.equal(msg.variantUrl, "https://cdn/v0");
  assert.equal(msg.variantId, "0");
  assert.equal(msg.ytHeight, 0);
  assert.equal(msg.ytAudioOnly, false);
  assert.equal(Object.prototype.hasOwnProperty.call(msg, "hostileExtra"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(msg, "filename"), false);

  const defaults = UI.buildDownloadMessage({
    item: { url: "https://x/b", kind: "direct", proposedFilename: "b.mp4" },
    tabId: 2,
    userActionToken: "tok-def",
    now: () => "t",
    selection: {},
  });
  assert.equal(defaults.variantUrl, null);
  assert.equal(defaults.variantId, null);
  assert.equal(defaults.ytHeight, null);
  assert.equal(defaults.ytAudioOnly, false);
});

test("buildDownloadMessage never mutates or freezes caller item/selection", () => {
  const item = {
    url: "https://x/a.mp4",
    kind: "direct",
    proposedFilename: "keep.mp4",
    pageTitle: "Page",
  };
  const selection = { variantUrl: "https://v", ytAudioOnly: true };
  const itemSnap = JSON.stringify(item);
  const selSnap = JSON.stringify(selection);
  const msg = UI.buildDownloadMessage({
    item,
    tabId: 4,
    userActionToken: "tok-mut",
    now: () => "t",
    selection,
  });
  assert.equal(JSON.stringify(item), itemSnap);
  assert.equal(JSON.stringify(selection), selSnap);
  assert.equal(Object.isFrozen(item), false);
  assert.equal(Object.isFrozen(selection), false);
  assert.equal(msg.item, item);
  assert.equal(msg.ytAudioOnly, true);
  item.proposedFilename = "mutated.mp4";
  assert.equal(item.proposedFilename, "mutated.mp4");
});

test("buildDownloadMessage accepts provided intent without reminting token", () => {
  const intent = Intent.createSaveAsIntent({
    proposedFilename: "11238-makemebi.net.mp4",
    editedFilename: "edit.mp4",
    destinationDirectory: null,
    userActionToken: "tok-provided",
    knownExtension: ".mp4",
    now: () => "t",
  });
  const msg = UI.buildDownloadMessage({
    item: { url: "https://x/a", kind: "direct", proposedFilename: "11238-makemebi.net.mp4" },
    tabId: 5,
    intent,
    selection: { ytHeight: 720 },
  });
  assert.equal(msg.intent, intent);
  assert.equal(msg.intent.userActionToken, "tok-provided");
  assert.equal(msg.ytHeight, 720);
});

test("missing blank and wrapped tokens are rejected when building default intent", () => {
  const item = { url: "https://x/a", kind: "direct", proposedFilename: "a.mp4" };
  assert.throws(() =>
    UI.buildDownloadMessage({ item, tabId: 1, selection: {}, now: () => "t" })
  );
  assert.throws(() =>
    UI.buildDownloadMessage({
      item,
      tabId: 1,
      userActionToken: "",
      selection: {},
      now: () => "t",
    })
  );
  assert.throws(() =>
    UI.buildDownloadMessage({
      item,
      tabId: 1,
      userActionToken: "   ",
      selection: {},
      now: () => "t",
    })
  );
  assert.throws(() =>
    UI.buildDownloadMessage({
      item,
      tabId: 1,
      userActionToken: Object("tok-wrapped"),
      selection: {},
      now: () => "t",
    })
  );
});

test("popup-download-ui dual-export assigns locked McPopupDownloadUi global with identity", () => {
  const abs = path.join(mediaCatcherRoot, "lib", "popup-download-ui.js");
  const code = fs.readFileSync(abs, "utf8");
  const root = {
    McFilenameRanker: loadLib("lib/filename-ranker.js"),
    McDownloadIntent: loadLib("lib/download-intent.js"),
  };
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require,
    console,
    self: root,
  };
  sandbox.module.exports = sandbox.exports;
  vm.runInNewContext(code, sandbox, { filename: abs });
  const nodeExport = sandbox.module.exports;
  assert.equal(typeof nodeExport.formatJobStatus, "function");
  assert.equal(typeof nodeExport.validateSaveAsFilename, "function");
  assert.equal(typeof nodeExport.decideSaveAsForm, "function");
  assert.equal(typeof nodeExport.buildDownloadMessage, "function");
  assert.equal(root.McPopupDownloadUi, nodeExport);
  assert.ok(Object.isFrozen(nodeExport));
});

test("static source assertions: script order, token mint, no downloads.download, no Math.random", () => {
  const html = fs.readFileSync(path.join(mediaCatcherRoot, "popup", "popup.html"), "utf8");
  const popupJs = fs.readFileSync(path.join(mediaCatcherRoot, "popup", "popup.js"), "utf8");
  const uiJs = fs.readFileSync(path.join(mediaCatcherRoot, "lib", "popup-download-ui.js"), "utf8");

  const rankerIdx = html.indexOf("../lib/filename-ranker.js");
  const intentIdx = html.indexOf("../lib/download-intent.js");
  const uiIdx = html.indexOf("../lib/popup-download-ui.js");
  const popupIdx = html.indexOf("popup.js");
  assert.ok(rankerIdx > 0);
  assert.ok(intentIdx > rankerIdx);
  assert.ok(uiIdx > intentIdx);
  assert.ok(popupIdx > uiIdx);

  assert.match(popupJs, /randomUUID|getRandomValues/);
  assert.equal(popupJs.includes("Math.random"), false);
  assert.equal(popupJs.includes("api.downloads.download"), false);
  assert.equal(popupJs.includes("browser.downloads.download"), false);
  assert.equal(popupJs.includes("downloads.download("), false);
  assert.equal(uiJs.includes("Math.random"), false);
  assert.equal(uiJs.includes("downloads.download"), false);

  assert.match(popupJs, /Save As/);
  assert.match(popupJs, /formatJobStatus/);
  assert.match(popupJs, /buildDownloadMessage|McPopupDownloadUi/);
  assert.match(popupJs, /needs_user|Needs attention/);
  assert.match(popupJs, /use-firefox/);
  assert.match(popupJs, /retry-download/);
  assert.equal(/requestFirefoxHandoff|downloads\.download\s*\(/.test(popupJs), false);
});

test("API surface is frozen and complete", () => {
  assert.ok(Object.isFrozen(UI));
  assert.deepEqual(Object.keys(UI).sort(), [
    "buildDownloadMessage",
    "decideSaveAsForm",
    "formatJobStatus",
    "validateSaveAsFilename",
  ]);
});
