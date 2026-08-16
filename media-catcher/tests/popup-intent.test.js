"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const { loadLib, mediaCatcherRoot } = require("./harness/load-lib.js");

const FLOREN = "11238-makemebi.net.mp4";
const UI = loadLib("lib/popup-download-ui.js");
const Intent = loadLib("lib/download-intent.js");
const Ranker = loadLib("lib/filename-ranker.js");

const MODULE_SRC = fs.readFileSync(
  path.join(mediaCatcherRoot, "lib", "popup-download-ui.js"),
  "utf8"
);
const POPUP_JS = fs.readFileSync(
  path.join(mediaCatcherRoot, "popup", "popup.js"),
  "utf8"
);
const POPUP_HTML = fs.readFileSync(
  path.join(mediaCatcherRoot, "popup", "popup.html"),
  "utf8"
);
const POPUP_CSS = fs.readFileSync(
  path.join(mediaCatcherRoot, "popup", "popup.css"),
  "utf8"
);

// ---------------------------------------------------------------------------
// Plan samples — exact status table, cancel, confirm, default download
// ---------------------------------------------------------------------------

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

test("Save As cancel returns null and must not produce an enqueue message", () => {
  const decision = UI.decideSaveAsForm({
    action: "cancel",
    proposedFilename: FLOREN,
  });
  assert.equal(decision, null);
});

test("Save As confirm builds save-as intent with edited name", () => {
  const decision = UI.decideSaveAsForm({
    action: "confirm",
    proposedFilename: FLOREN,
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

test("Download button builds default intent from proposedFilename", () => {
  const msg = UI.buildDownloadMessage({
    item: {
      url: "https://x/a.mp4",
      kind: "direct",
      proposedFilename: FLOREN,
      tabId: 3,
    },
    tabId: 3,
    userActionToken: "tok-d",
    now: () => "t",
    selection: {},
  });
  assert.equal(msg.type, "download");
  assert.equal(msg.intent.requestedFilename, FLOREN);
  assert.equal(msg.intent.saveMode, "default");
  assert.equal(msg.intent.userSelectedFirefox, false);
});

// ---------------------------------------------------------------------------
// formatJobStatus — adversarial
// ---------------------------------------------------------------------------

test("formatJobStatus missing/blank provider never renders undefined/null/dangling phrase", () => {
  for (const providerKey of [undefined, null, "", "   "]) {
    const waiting = UI.formatJobStatus({ state: "waiting_provider", providerKey });
    assert.match(waiting, /^Waiting for \S/);
    assert.equal(waiting.includes("undefined"), false);
    assert.equal(waiting.includes("null"), false);
    assert.equal(waiting.endsWith("for "), false);
    assert.equal(waiting.endsWith("for"), false);

    const pausing = UI.formatJobStatus({ state: "pausing_provider", providerKey });
    assert.match(pausing, /^Pausing for \S/);
    assert.equal(pausing.includes("undefined"), false);
    assert.equal(pausing.includes("null"), false);
  }
});

test("formatJobStatus unknown/malformed input returns deterministic string and never throws", () => {
  const samples = [
    null,
    undefined,
    {},
    { state: "" },
    { state: "not-a-real-state" },
    { state: 12 },
    "queued",
    7,
  ];
  for (const sample of samples) {
    let label;
    assert.doesNotThrow(() => {
      label = UI.formatJobStatus(sample);
    });
    assert.equal(typeof label, "string");
    assert.ok(label.length > 0);
  }
});

test("formatJobStatus reduced===true takes precedence over plain running", () => {
  assert.equal(
    UI.formatJobStatus({ state: "running", reduced: true, mode: "multi-range" }),
    "Retrying at reduced concurrency"
  );
  assert.equal(
    UI.formatJobStatus({ state: "running", reduced: false }),
    "Downloading"
  );
  assert.equal(
    UI.formatJobStatus({ state: "running", reduced: "yes" }),
    "Downloading"
  );
});

// ---------------------------------------------------------------------------
// decideSaveAsForm cancel with hostile getters
// ---------------------------------------------------------------------------

test("cancel returns null before reading proposal/edit/token or loading intent deps", () => {
  let reads = 0;
  const hostile = {
    get action() {
      return "cancel";
    },
    get proposedFilename() {
      reads += 1;
      throw new Error("must not read proposedFilename on cancel");
    },
    get editedFilename() {
      reads += 1;
      throw new Error("must not read editedFilename on cancel");
    },
    get knownExtension() {
      reads += 1;
      throw new Error("must not read knownExtension on cancel");
    },
    get destinationDirectory() {
      reads += 1;
      throw new Error("must not read destinationDirectory on cancel");
    },
    get userActionToken() {
      reads += 1;
      throw new Error("must not read userActionToken on cancel");
    },
    get now() {
      reads += 1;
      throw new Error("must not read now on cancel");
    },
  };
  assert.equal(UI.decideSaveAsForm(hostile), null);
  assert.equal(reads, 0);
});

// ---------------------------------------------------------------------------
// buildDownloadMessage
// ---------------------------------------------------------------------------

test("default uses exact proposedFilename even when pageTitle is generic Florenfile branding", () => {
  const item = {
    url: "https://cdn/x.mp4",
    kind: "direct",
    proposedFilename: FLOREN,
    name: "fallback-name.mp4",
    pageTitle: "Florenfile.com - Secure Cloud Storage",
  };
  const selection = {
    variantUrl: "https://cdn/v.m3u8",
    variantId: "v1",
    ytHeight: 0,
    ytAudioOnly: false,
    hostileExtra: "ignore-me",
  };
  const msg = UI.buildDownloadMessage({
    item,
    tabId: 9,
    userActionToken: "tok-brand",
    now: () => "t-brand",
    selection,
  });

  assert.equal(msg.type, "download");
  assert.equal(msg.tabId, 9);
  assert.equal(msg.item, item);
  assert.equal(msg.intent.requestedFilename, FLOREN);
  assert.equal(msg.intent.saveMode, "default");
  assert.equal(msg.intent.userActionToken, "tok-brand");
  assert.equal(msg.intent.createdAt, "t-brand");
  assert.equal(msg.variantUrl, "https://cdn/v.m3u8");
  assert.equal(msg.variantId, "v1");
  assert.equal(msg.ytHeight, 0);
  assert.equal(msg.ytAudioOnly, false);
  assert.equal(Object.prototype.hasOwnProperty.call(msg, "filename"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(msg, "hostileExtra"), false);

  // Exact allowlisted keys only.
  assert.deepEqual(Object.keys(msg).sort(), [
    "intent",
    "item",
    "tabId",
    "type",
    "variantId",
    "variantUrl",
    "ytAudioOnly",
    "ytHeight",
  ].sort());

  // No mutation of item/selection.
  assert.equal(item.proposedFilename, FLOREN);
  assert.equal(item.pageTitle, "Florenfile.com - Secure Cloud Storage");
  assert.equal(selection.hostileExtra, "ignore-me");
  assert.throws(() => {
    msg.intent.requestedFilename = "hacked.mp4";
  });
});

test("buildDownloadMessage falls back to nonblank item.name when proposal absent", () => {
  const msg = UI.buildDownloadMessage({
    item: { url: "https://x/a", kind: "direct", name: "compat-name.mp4" },
    tabId: 1,
    userActionToken: "tok-name",
    now: () => "t",
    selection: null,
  });
  assert.equal(msg.intent.requestedFilename, "compat-name.mp4");
  assert.equal(msg.variantUrl, null);
  assert.equal(msg.variantId, null);
  assert.equal(msg.ytHeight, null);
  assert.equal(msg.ytAudioOnly, false);
});

test("buildDownloadMessage accepts prebuilt intent and preserves selection zeros", () => {
  const intent = Intent.createSaveAsIntent({
    proposedFilename: FLOREN,
    editedFilename: "cut.mp4",
    knownExtension: ".mp4",
    destinationDirectory: "D:\\\\Vids",
    userActionToken: "tok-pre",
    now: () => "t-pre",
  });
  const item = { url: "https://x", kind: "youtube", proposedFilename: FLOREN };
  const msg = UI.buildDownloadMessage({
    item,
    tabId: 4,
    intent,
    selection: { ytHeight: 0, ytAudioOnly: true, variantId: 0 },
  });
  assert.equal(msg.intent, intent);
  assert.equal(msg.ytHeight, 0);
  assert.equal(msg.ytAudioOnly, true);
  assert.equal(msg.variantId, 0);
  assert.equal(msg.variantUrl, null);
  assert.equal(msg.intent.requestedFilename, "cut.mp4");
  assert.equal(msg.intent.destinationDirectory, "D:\\\\Vids");
});

test("buildDownloadMessage rejects missing/blank tokens and names; never mints tokens", () => {
  const baseItem = { url: "https://x", kind: "direct", proposedFilename: FLOREN };
  assert.throws(() =>
    UI.buildDownloadMessage({ item: baseItem, tabId: 1, selection: {} })
  );
  assert.throws(() =>
    UI.buildDownloadMessage({
      item: baseItem,
      tabId: 1,
      userActionToken: "",
      selection: {},
    })
  );
  assert.throws(() =>
    UI.buildDownloadMessage({
      item: baseItem,
      tabId: 1,
      userActionToken: "   ",
      selection: {},
    })
  );
  assert.throws(() =>
    UI.buildDownloadMessage({
      item: baseItem,
      tabId: 1,
      userActionToken: { toString: () => "tok" },
      selection: {},
    })
  );
  assert.throws(() =>
    UI.buildDownloadMessage({
      item: { url: "https://x", kind: "direct", pageTitle: "Only title" },
      tabId: 1,
      userActionToken: "tok",
      selection: {},
    })
  );
  assert.throws(() =>
    UI.buildDownloadMessage({
      item: { url: "https://x", kind: "direct", proposedFilename: "   ", name: "" },
      tabId: 1,
      userActionToken: "tok",
      selection: {},
    })
  );
});

// ---------------------------------------------------------------------------
// validateSaveAsFilename + decideSaveAsForm confirm
// ---------------------------------------------------------------------------

test("validateSaveAsFilename appends known extension and warns on different valid extension", () => {
  const same = UI.validateSaveAsFilename(FLOREN, ".mp4");
  assert.equal(same.ok, true);
  assert.equal(same.filename, FLOREN);
  assert.equal(same.warning, null);

  const noExt = UI.validateSaveAsFilename("my-cut", ".mp4");
  assert.equal(noExt.ok, true);
  assert.equal(noExt.filename, "my-cut.mp4");
  assert.equal(noExt.warning, null);

  const diff = UI.validateSaveAsFilename("clip.mkv", ".mp4");
  assert.equal(diff.ok, true);
  assert.equal(diff.filename, "clip.mkv");
  assert.equal(typeof diff.warning, "string");
  assert.ok(diff.warning.length > 0);

  // Matches shared ranker sanitize/ensure policy for colon etc.
  const dirty = UI.validateSaveAsFilename("My Cut: final", ".mp4");
  assert.equal(dirty.ok, true);
  assert.equal(
    dirty.filename,
    Ranker.sanitizeFilename(Ranker.ensureExtension("My Cut: final", ".mp4"))
  );
});

test("validateSaveAsFilename rejects empty/whitespace/path-only edits", () => {
  for (const edited of ["", "   ", "/", "\\\\", "C:\\\\", "C:\\\\foo\\\\", "../", "..\\\\"]) {
    const r = UI.validateSaveAsFilename(edited, ".mp4");
    assert.equal(r.ok, false, "expected invalid for " + JSON.stringify(edited));
    assert.equal(r.filename, "");
  }
});

test("decideSaveAsForm confirm: null and selected destination, frozen decision, hostile extras ignored", () => {
  const decisionNull = UI.decideSaveAsForm({
    action: "confirm",
    proposedFilename: FLOREN,
    editedFilename: FLOREN,
    knownExtension: ".mp4",
    destinationDirectory: null,
    userActionToken: "tok-null",
    now: () => "t0",
    get extraHostile() {
      throw new Error("must not enumerate hostile getters");
    },
  });
  assert.equal(decisionNull.enqueue, true);
  assert.equal(decisionNull.intent.requestedFilename, FLOREN);
  assert.equal(decisionNull.intent.destinationDirectory, null);
  assert.equal(decisionNull.intent.saveMode, "save-as");
  assert.equal(decisionNull.intent.userActionToken, "tok-null");
  assert.throws(() => {
    decisionNull.enqueue = false;
  });
  assert.throws(() => {
    decisionNull.intent.requestedFilename = "x";
  });

  const decisionDir = UI.decideSaveAsForm({
    action: "confirm",
    proposedFilename: FLOREN,
    editedFilename: "edited-name",
    knownExtension: ".mp4",
    destinationDirectory: "E:\\\\Media\\\\Clips",
    userActionToken: "tok-dir",
    now: () => "t1",
  });
  assert.equal(decisionDir.enqueue, true);
  assert.equal(decisionDir.intent.requestedFilename, "edited-name.mp4");
  assert.equal(decisionDir.intent.destinationDirectory, "E:\\\\Media\\\\Clips");
  assert.equal(decisionDir.intent.createdAt, "t1");
});

test("decideSaveAsForm validation failure does not enqueue", () => {
  const bad = UI.decideSaveAsForm({
    action: "confirm",
    proposedFilename: FLOREN,
    editedFilename: "   ",
    knownExtension: ".mp4",
    destinationDirectory: null,
    userActionToken: "tok-bad",
    now: () => "t",
  });
  assert.ok(bad);
  assert.equal(bad.enqueue, false);
  assert.equal(Object.prototype.hasOwnProperty.call(bad, "intent") ? bad.intent : null, null);
});

test("decideSaveAsForm confirm rejects blank/wrapped tokens", () => {
  assert.throws(() =>
    UI.decideSaveAsForm({
      action: "confirm",
      proposedFilename: FLOREN,
      editedFilename: "ok.mp4",
      knownExtension: ".mp4",
      destinationDirectory: null,
      userActionToken: "",
      now: () => "t",
    })
  );
  assert.throws(() =>
    UI.decideSaveAsForm({
      action: "confirm",
      proposedFilename: FLOREN,
      editedFilename: "ok.mp4",
      knownExtension: ".mp4",
      destinationDirectory: null,
      userActionToken: { value: "tok" },
      now: () => "t",
    })
  );
});

// ---------------------------------------------------------------------------
// No token generation inside pure helpers + forbidden patterns
// ---------------------------------------------------------------------------

test("pure helpers never manufacture userActionToken; module forbids download/random/auto-fx", () => {
  assert.equal(MODULE_SRC.includes("randomUUID"), false);
  assert.equal(MODULE_SRC.includes("Math.random"), false);
  assert.equal(MODULE_SRC.includes("getRandomValues"), false);
  assert.equal(MODULE_SRC.includes("browser.downloads.download"), false);
  assert.equal(MODULE_SRC.includes("downloads.download("), false);
  assert.equal(MODULE_SRC.includes("localStorage"), false);
  assert.equal(MODULE_SRC.includes("sessionStorage"), false);
  assert.equal(MODULE_SRC.includes("document.cookie"), false);
  assert.equal(/console\./.test(MODULE_SRC), false);
  // No automatic Firefox invocation paths.
  assert.equal(MODULE_SRC.includes("downloadWithFirefox"), false);
  assert.equal(MODULE_SRC.includes("userSelectedFirefox: true"), false);
});

// ---------------------------------------------------------------------------
// UMD dual-export + load-order
// ---------------------------------------------------------------------------

test("popup-download-ui dual-export assigns locked McPopupDownloadUi with identity", () => {
  const absUi = path.join(mediaCatcherRoot, "lib", "popup-download-ui.js");
  const absIntent = path.join(mediaCatcherRoot, "lib", "download-intent.js");
  const absRanker = path.join(mediaCatcherRoot, "lib", "filename-ranker.js");
  const root = {};
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require,
    console,
    self: root,
  };
  sandbox.module.exports = sandbox.exports;

  // Load order: ranker → intent → popup-ui (browser path uses root globals).
  vm.runInNewContext(fs.readFileSync(absRanker, "utf8"), sandbox, { filename: absRanker });
  assert.equal(typeof root.McFilenameRanker.sanitizeFilename, "function");

  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(fs.readFileSync(absIntent, "utf8"), sandbox, { filename: absIntent });
  assert.equal(typeof root.McDownloadIntent.createDefaultIntent, "function");

  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  // Browser path: no require for dependency resolution when globals present.
  sandbox.require = function () {
    throw new Error("browser path must not require()");
  };
  vm.runInNewContext(fs.readFileSync(absUi, "utf8"), sandbox, { filename: absUi });
  const nodeExport = sandbox.module.exports;
  assert.equal(typeof nodeExport.formatJobStatus, "function");
  assert.equal(typeof nodeExport.validateSaveAsFilename, "function");
  assert.equal(typeof nodeExport.decideSaveAsForm, "function");
  assert.equal(typeof nodeExport.buildDownloadMessage, "function");
  assert.equal(root.McPopupDownloadUi, nodeExport);
  assert.equal(Object.isFrozen(nodeExport), true);

  const msg = root.McPopupDownloadUi.buildDownloadMessage({
    item: { url: "https://x", kind: "direct", proposedFilename: FLOREN },
    tabId: 1,
    userActionToken: "tok-umd",
    now: () => "t-umd",
    selection: {},
  });
  assert.equal(msg.intent.requestedFilename, FLOREN);
});

test("browser path fails clearly when McDownloadIntent global is missing", () => {
  const absUi = path.join(mediaCatcherRoot, "lib", "popup-download-ui.js");
  const root = {};
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: function () {
      throw new Error("no require");
    },
    console,
    self: root,
  };
  sandbox.module.exports = sandbox.exports;
  assert.throws(() => {
    vm.runInNewContext(fs.readFileSync(absUi, "utf8"), sandbox, { filename: absUi });
    // Force dependency resolution if factory is lazy:
    root.McPopupDownloadUi.buildDownloadMessage({
      item: { url: "https://x", kind: "direct", proposedFilename: FLOREN },
      tabId: 1,
      userActionToken: "t",
      now: () => "t",
      selection: {},
    });
  }, /McDownloadIntent/);
});

// ---------------------------------------------------------------------------
// Static popup source assertions
// ---------------------------------------------------------------------------

test("popup.html loads ranker, intent, popup-ui, then popup.js in safe order", () => {
  const ranker = POPUP_HTML.indexOf('src="../lib/filename-ranker.js"');
  const intent = POPUP_HTML.indexOf('src="../lib/download-intent.js"');
  const ui = POPUP_HTML.indexOf('src="../lib/popup-download-ui.js"');
  const popup = POPUP_HTML.indexOf('src="popup.js"');
  assert.ok(ranker >= 0, "filename-ranker script missing");
  assert.ok(intent > ranker, "download-intent must follow ranker");
  assert.ok(ui > intent, "popup-download-ui must follow intent");
  assert.ok(popup > ui, "popup.js must load last");
});

test("popup.js uses smart-name precedence, Download/Save As labels, formatter, needs-user actions", () => {
  assert.match(POPUP_JS, /proposedFilename/);
  assert.match(POPUP_JS, /McPopupDownloadUi/);
  assert.match(POPUP_JS, /formatJobStatus/);
  assert.match(POPUP_JS, /buildDownloadMessage/);
  assert.match(POPUP_JS, /decideSaveAsForm/);
  assert.match(POPUP_JS, /Save As…|Save As\u2026/);
  assert.match(POPUP_JS, /"Download"/);
  assert.match(POPUP_JS, /retry-download/);
  assert.match(POPUP_JS, /use-firefox/);
  assert.match(POPUP_JS, /Needs attention|needs_user/);
  assert.match(POPUP_JS, /Retry/);
  assert.match(POPUP_JS, /Use Firefox instead/);
  // Token mint only via Web Crypto paths, not Math.random.
  assert.equal(POPUP_JS.includes("Math.random"), false);
  assert.match(POPUP_JS, /randomUUID|getRandomValues/);
  // Cancel path must invoke decideSaveAsForm cancel without send of download.
  assert.match(POPUP_JS, /action:\s*["']cancel["']/);
  // No direct Firefox downloads API call.
  assert.equal(POPUP_JS.includes("downloads.download"), false);
  assert.equal(POPUP_JS.includes("browser.downloads.download"), false);
});

test("popup.css includes save-as form surface styles without overflow traps", () => {
  assert.match(POPUP_CSS, /save-as|saveAs|sa-form|\.sa-/i);
  assert.match(POPUP_CSS, /min-width:\s*0|min-width:0/);
});
