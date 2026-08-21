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
    "downloadSizeBytes",
    "formatJobStatus",
    "validateSaveAsFilename",
  ]);
});

// ---------------------------------------------------------------------------
// Task-18 fix regressions: extract popup.js slices and exercise with fakes.
// ---------------------------------------------------------------------------

function readPopupSource() {
  return fs.readFileSync(path.join(mediaCatcherRoot, "popup", "popup.js"), "utf8");
}

function extractNamedFunction(source, name) {
  const re = new RegExp("(?:async\\s+)?function\\s+" + name + "\\s*\\(");
  const m = re.exec(source);
  if (!m) throw new Error("function not found: " + name);
  const start = m.index;
  let i = source.indexOf("{", start);
  if (i < 0) throw new Error("no body for " + name);
  let depth = 0;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced braces for " + name);
}

function fakeClassList() {
  const values = new Set();
  return {
    toggle(name, on) {
      if (on) values.add(name);
      else values.delete(name);
    },
    add(name) { values.add(name); },
    contains(name) { return values.has(name); },
    values() { return Array.from(values); },
  };
}

test("popup layout mode never shares a class with the inner scroll container", () => {
  const root = { classList: fakeClassList(), style: { width: "" } };
  const sandbox = {
    document: { documentElement: root },
    localStorage: {
      getItem(key) {
        assert.equal(key, "mc-layout");
        return JSON.stringify({ rail: true, w: 640, cast: false });
      },
    },
    JSON,
  };
  const source = readPopupSource();
  vm.runInNewContext(
    extractNamedFunction(source, "primeLayout") + "\nthis.primeLayout = primeLayout;",
    sandbox
  );

  sandbox.primeLayout();

  const popupHtml = fs.readFileSync(path.join(mediaCatcherRoot, "popup", "popup.html"), "utf8");
  const scrollTag = popupHtml.match(/<[^>]*\bid=["']rail["'][^>]*>/i);
  assert.ok(scrollTag, "inner rail element exists");
  const classAttr = scrollTag[0].match(/\bclass=["']([^"']*)["']/i);
  assert.ok(classAttr, "inner rail element has a class");
  const scrollClasses = new Set(classAttr[1].trim().split(/\s+/).filter(Boolean));
  for (const modeClass of root.classList.values()) {
    assert.equal(
      scrollClasses.has(modeClass),
      false,
      "root layout mode must not turn the document into the inner scroll container"
    );
  }
});

function loadPopupRenderHarness() {
  const source = readPopupSource();
  const starts = [];
  const progress = [];
  function h(tag, props, children) {
    const node = {
      tag,
      props: props || {},
      children: [],
      classList: { add() {} },
      appendChild(child) { this.children.push(child); return child; },
    };
    const list = children == null ? [] : (Array.isArray(children) ? children : [children]);
    for (const child of list) if (child != null) node.appendChild(child);
    return node;
  }
  const listEl = {
    children: [],
    replaceChildren() { this.children = Array.from(arguments); },
    appendChild(child) { this.children.push(child); return child; },
  };
  const sentMessages = [];
  const sandbox = {
    URL,
    console,
    send: (message) => { sentMessages.push(JSON.parse(JSON.stringify(message))); return Promise.resolve({ ok: true }); },
    pageTitle: "",
    currentTabId: 7,
    castUiReady: true,
    h,
    humanSize: () => "",
    showLabel: () => {},
    appendNote: () => {},
    handleDownload: () => {},
    startRecording: () => {},
    openSaveAsForm: () => {},
    toggleCommandMenu: () => {},
    openCastPicker: () => {},
    startDownload: (item, el, selection) => starts.push({ item, el, selection }),
    renderProgress: (el, download) => progress.push({ el, download }),
    itemDownloadId: new Map(),
    itemElements: new Map(),
    downloadState: new Map(),
    listEl,
    footCount: { textContent: "" },
    leftCountEl: { textContent: "" },
    statusEl: { textContent: "" },
    renderHelperBadge: () => {},
  };
  const pieces = [
    "isSafeOpaqueId", "itemIdentity", "hostOf", "proposedFilenameOf", "displayNameOf", "fmtDuration",
    "bitrateLabel", "mediaSizeLabel", "previewSrc", "renderQualities", "renderItem", "render",
  ].map((name) => extractNamedFunction(source, name));
  vm.runInNewContext(pieces.join("\n") + "\nthis.render = render;", sandbox);
  return { sandbox, starts, progress, listEl, sentMessages };
}

function popupNodes(root, predicate, out) {
  out = out || [];
  if (root && typeof root === "object") {
    if (predicate(root)) out.push(root);
    for (const child of root.children || []) popupNodes(child, predicate, out);
  }
  return out;
}

test("URL-free controller media renders by opaque identity without URL-only actions", () => {
  const h = loadPopupRenderHarness();
  const item = {
    id: "media:m1:1",
    kind: "hls",
    proposedFilename: "episode.mp4",
    variants: [{
      id: "variant:v1:1",
      label: "720p",
      height: 720,
      uri: "https://must-not-cross.example/playlist.m3u8",
    }],
  };

  h.sandbox.render([item]);

  const row = h.listEl.children[0];
  assert.equal(h.sandbox.itemElements.get("id:media:m1:1"), row);
  assert.equal(popupNodes(row, (node) => node.props.class === "name" && node.props.text === "episode.mp4").length, 1);
  assert.equal(popupNodes(row, (node) => node.props.class === "chip type" && node.props.text === "HLS").length, 1);
  const buttons = popupNodes(row, (node) => node.tag === "button");
  const labels = buttons.map((button) => button.props.text || "");
  assert.ok(labels.includes("Download"));
  assert.ok(labels.includes("Save As…"));
  assert.ok(labels.includes("720p"));
  assert.equal(labels.includes("Copy URL"), false);
  assert.equal(popupNodes(h.listEl.children[0], (node) => node.props.class === "cmd").length, 0);
  assert.equal(popupNodes(h.listEl.children[0], (node) => /(?:^|\s)cast-btn(?:\s|$)/.test(node.props.class || "")).length, 0);

  buttons.find((button) => button.props.text === "720p").props.onClick();
  assert.equal(h.starts.length, 1);
  assert.deepEqual(Object.keys(h.starts[0].selection), ["variantId"]);
  assert.equal(h.starts[0].selection.variantId, "variant:v1:1");
});

test("download correlation prefers mediaId and preserves legacy URL fallback", () => {
  const source = readPopupSource();
  const sandbox = {};
  vm.runInNewContext(
    ["isSafeOpaqueId", "downloadItemIdentity"]
      .map((name) => extractNamedFunction(source, name)).join("\n") +
      "\nthis.downloadItemIdentity = downloadItemIdentity;",
    sandbox
  );
  assert.equal(
    sandbox.downloadItemIdentity({ mediaId: "media:m4:1", url: "https://secret.example/a" }),
    "id:media:m4:1"
  );
  assert.equal(
    sandbox.downloadItemIdentity({ url: "https://cdn.example/legacy.mp4" }),
    "url:https://cdn.example/legacy.mp4"
  );
  assert.equal(sandbox.downloadItemIdentity({}), null);
});

test("URL-free direct controller media never offers cast or URL-derived actions", () => {
  const h = loadPopupRenderHarness();
  h.sandbox.render([{
    id: "media:m2:1",
    kind: "direct",
    proposedFilename: "clip.mp4",
  }]);

  const row = h.listEl.children[0];
  const buttonText = popupNodes(row, (node) => node.tag === "button")
    .map((button) => button.props.text || "");
  assert.ok(buttonText.includes("Download"));
  assert.ok(buttonText.includes("Save As…"));
  assert.equal(buttonText.includes("Copy URL"), false);
  assert.equal(popupNodes(row, (node) => node.props.class === "cmd").length, 0);
  assert.equal(popupNodes(row, (node) => /(?:^|\s)cast-btn(?:\s|$)/.test(node.props.class || "")).length, 0);
});

test("legacy URL media keeps URL identity and URL-derived controls", () => {
  const h = loadPopupRenderHarness();
  const url = "https://cdn.example/legacy.mp4";
  h.sandbox.render([{
    id: "https://not-an-opaque-id.example/",
    url,
    kind: "direct",
    proposedFilename: "legacy.mp4",
  }]);

  const row = h.listEl.children[0];
  assert.equal(h.sandbox.itemElements.get("url:" + url), row);
  const buttonText = popupNodes(row, (node) => node.tag === "button")
    .map((button) => button.props.text || "");
  assert.ok(buttonText.includes("Download"));
  assert.ok(buttonText.includes("Save As…"));
  assert.ok(buttonText.includes("Copy URL"));
  assert.equal(popupNodes(row, (node) => node.props.class === "cmd").length, 1);
  assert.equal(popupNodes(row, (node) => /(?:^|\s)cast-btn(?:\s|$)/.test(node.props.class || "")).length, 1);
});

test("controller media progress binds by mediaId identity", () => {
  const h = loadPopupRenderHarness();
  const download = { id: "job:j1:1", mediaId: "media:m3:1", state: "running" };
  h.sandbox.itemDownloadId.set("id:" + download.mediaId, download.id);
  h.sandbox.downloadState.set(download.id, download);

  h.sandbox.render([{
    id: download.mediaId,
    kind: "direct",
    proposedFilename: "bound.mp4",
  }]);

  assert.equal(h.progress.length, 1);
  assert.equal(h.progress[0].download, download);
  assert.equal(h.progress[0].el, h.listEl.children[0]);
});

test("live-jobs-updated refreshes opaque queue and row progress while ignoring malformed jobs", () => {
  const source = readPopupSource();
  const row = { id: "url-free-row" };
  const progress = [];
  let queueRenders = 0;
  const sandbox = {
    downloadState: new Map([
      ["job:old:1", { id: "job:old:1", mediaId: "media:old:1", state: "running" }],
      [77, { id: 77, url: "https://cdn.example/legacy.mp4", status: "downloading" }],
    ]),
    itemDownloadId: new Map([["id:media:old:1", "job:old:1"]]),
    itemElements: new Map([["id:media:m5:1", row]]),
    renderProgress: (el, download) => progress.push({ el, download }),
    renderQueue: () => { queueRenders += 1; },
  };
  const pieces = ["isSafeOpaqueId", "applyLiveJobsUpdate"]
    .map((name) => extractNamedFunction(source, name));
  vm.runInNewContext(
    pieces.join("\n") + "\nthis.applyLiveJobsUpdate = applyLiveJobsUpdate;",
    sandbox
  );
  const hostile = {};
  Object.defineProperty(hostile, "id", { get() { throw new Error("hostile getter"); } });
  const liveJob = {
    id: "job:j5:1",
    mediaId: "media:m5:1",
    state: "running",
    requestedFilename: "episode.mp4",
  };

  assert.doesNotThrow(() => sandbox.applyLiveJobsUpdate({
    type: "live-jobs-updated",
    jobs: [
      null,
      42,
      {},
      { id: "https://unsafe.example/job", mediaId: "media:m5:1" },
      { id: "job:missing-media:1" },
      hostile,
      liveJob,
    ],
  }));

  assert.equal(sandbox.downloadState.has("job:old:1"), false);
  assert.equal(sandbox.downloadState.get(77).status, "downloading", "legacy queue entry stays intact");
  assert.equal(sandbox.downloadState.get(liveJob.id), liveJob);
  assert.equal(sandbox.itemDownloadId.has("id:media:old:1"), false);
  assert.equal(sandbox.itemDownloadId.get("id:media:m5:1"), liveJob.id);
  assert.deepEqual(progress, [{ el: row, download: liveJob }]);
  assert.equal(queueRenders, 1);
});

function loadStartDownload(deps) {
  const src = extractNamedFunction(readPopupSource(), "startDownload");
  const sandbox = Object.assign(
    {
      PopupUI: null,
      currentTabId: 1,
      mintUserActionToken: () => "tok-test",
      showLabel: () => {},
      send: async () => ({ ok: true }),
      Date,
      console,
    },
    deps
  );
  vm.runInNewContext(src + "\nthis.__fn = startDownload;", sandbox);
  return sandbox.__fn;
}

test("Save-As mode does not call showLabel before send; {ok:false} returns failure", async () => {
  const showLabelCalls = [];
  let resolveSend;
  const sendPromise = new Promise((r) => {
    resolveSend = r;
  });
  const sendCalls = [];
  const startDownload = loadStartDownload({
    PopupUI: {
      buildDownloadMessage: () => ({ type: "download", intent: { saveMode: "save-as" } }),
    },
    showLabel: (_el, text, cls) => {
      showLabelCalls.push({ text, cls });
    },
    send: async (msg) => {
      sendCalls.push(msg);
      return sendPromise;
    },
  });

  const pending = startDownload(
    { kind: "direct", url: "https://x/a.mp4", proposedFilename: "a.mp4" },
    { id: "el" },
    {},
    { saveMode: "save-as", requestedFilename: "a.mp4" },
    { preserveFormOnFailure: true }
  );

  assert.equal(sendCalls.length, 1, "send should fire while form is still visible");
  assert.equal(showLabelCalls.length, 0, "Save-As must not replace the form before send resolves");

  resolveSend({ ok: false, error: "provider queue full" });
  const result = await pending;
  assert.equal(result && result.ok, false);
  assert.equal(result.error, "provider queue full");
  assert.equal(
    showLabelCalls.length,
    0,
    "on {ok:false} with preserveForm, caller restores controls — no status wipe"
  );
});

test("Save-As accepted response calls success status exactly once", async () => {
  const showLabelCalls = [];
  const startDownload = loadStartDownload({
    PopupUI: {
      buildDownloadMessage: () => ({ type: "download", intent: { saveMode: "save-as" } }),
    },
    showLabel: (_el, text, cls) => {
      showLabelCalls.push({ text, cls });
    },
    send: async () => ({ ok: true, id: 7 }),
  });

  const result = await startDownload(
    { kind: "hls", url: "https://x/a.m3u8", proposedFilename: "a.mp4" },
    { id: "el" },
    {},
    { saveMode: "save-as", requestedFilename: "a.mp4" },
    { preserveFormOnFailure: true }
  );

  assert.equal(result && result.ok, true);
  assert.equal(showLabelCalls.length, 1);
  assert.equal(showLabelCalls[0].text, "Starting…");
});

test("default mode still reports status/error without unhandled rejection", async () => {
  const showLabelCalls = [];
  const startDownload = loadStartDownload({
    PopupUI: {
      buildDownloadMessage: () => ({ type: "download", intent: { saveMode: "default" } }),
    },
    mintUserActionToken: () => "tok-def",
    showLabel: (_el, text, cls) => {
      showLabelCalls.push({ text, cls });
    },
    send: async () => ({ ok: false, error: "disk full" }),
  });

  const result = await startDownload(
    { kind: "direct", url: "https://x/a.mp4", proposedFilename: "a.mp4" },
    { id: "el" },
    {},
    null
  );

  assert.equal(result && result.ok, false);
  assert.equal(result.error, "disk full");
  assert.equal(showLabelCalls.length, 2);
  assert.equal(showLabelCalls[0].text, "Saving…");
  assert.equal(showLabelCalls[1].text, "disk full");
  assert.equal(showLabelCalls[1].cls, "error");

  // Transport throw must not become an unhandled rejection for Download click.
  const throws = loadStartDownload({
    PopupUI: {
      buildDownloadMessage: () => ({ type: "download" }),
    },
    showLabel: (_el, text, cls) => {
      showLabelCalls.push({ text, cls });
    },
    send: async () => {
      throw new Error("runtime gone");
    },
  });
  const thrownResult = await throws(
    { kind: "direct", url: "https://x/b.mp4", proposedFilename: "b.mp4" },
    { id: "el2" },
    {}
  );
  assert.equal(thrownResult && thrownResult.ok, false);
  assert.match(String(thrownResult.error), /runtime gone/);
});

test("pick-folder message includes empty then selected dir", () => {
  const popupJs = readPopupSource();
  // Exact contract: first click uses "", subsequent clicks use destinationDirectory.
  assert.match(
    popupJs,
    /send\(\s*\{\s*type:\s*["']pick-folder["']\s*,\s*dir:\s*destinationDirectory\s*\|\|\s*["']{2}\s*\}\s*\)/
  );
  // Executable check of the message expression used by the folder handler.
  let destinationDirectory = null;
  const msg1 = { type: "pick-folder", dir: destinationDirectory || "" };
  assert.deepEqual(msg1, { type: "pick-folder", dir: "" });
  destinationDirectory = "D:\\Vids";
  const msg2 = { type: "pick-folder", dir: destinationDirectory || "" };
  assert.deepEqual(msg2, { type: "pick-folder", dir: "D:\\Vids" });
});

function loadRenderProgressHarness() {
  const popupJs = readPopupSource();
  const needsUserCalls = [];
  const slotKids = [];
  const sandbox = {
    SCHEDULER_STATES: new Set([
      "queued",
      "waiting_provider",
      "running",
      "retry_backoff",
      "pausing_provider",
      "needs_user",
      "handing_off_firefox",
      "handed_to_firefox",
      "failed",
      "completed",
      "cancelled",
    ]),
    PopupUI: {
      formatJobStatus: (j) => UI.formatJobStatus(j),
    },
    humanSize: () => "",
    fileActionRow: () => null,
    renderLiveProgress: () => {},
    renderNeedsUserActions: (dl, wrap) => {
      needsUserCalls.push({ dl, wrap });
    },
    h: (tag, props, children) => ({ tag, props, children }),
    console,
  };
  const pieces = [
    extractNamedFunction(popupJs, "schedulerStateOf"),
    extractNamedFunction(popupJs, "formatJobStatusLabel"),
    extractNamedFunction(popupJs, "renderProgress"),
  ].join("\n");
  vm.runInNewContext(pieces + "\nthis.renderProgress = renderProgress;", sandbox);
  const el = {
    querySelector(sel) {
      if (sel !== ".slot") return null;
      return {
        replaceChildren() {
          slotKids.length = 0;
          for (let i = 0; i < arguments.length; i++) slotKids.push(arguments[i]);
        },
        appendChild(c) {
          slotKids.push(c);
          return c;
        },
      };
    },
  };
  return {
    renderProgress: sandbox.renderProgress,
    needsUserCalls,
    slotKids,
    el,
  };
}

test("needs_user with progress.total > 0 enters the action branch", () => {
  const harness = loadRenderProgressHarness();
  harness.renderProgress(harness.el, {
    state: "needs_user",
    error: "captcha required",
    progress: { total: 5000, done: 1200, unit: "bytes" },
    requestedFilename: "clip.mp4",
  });
  assert.equal(
    harness.needsUserCalls.length,
    1,
    "needs_user must render Retry / Use Firefox / Cancel even with retained progress.total"
  );
  // Label path: progress-label should mention Needs attention (via formatJobStatus).
  const blob = JSON.stringify(harness.slotKids);
  assert.match(blob, /Needs attention/);
});

function loadRenderNeedsUserActions(deps) {
  const src = extractNamedFunction(readPopupSource(), "renderNeedsUserActions");
  const buttons = [];
  function h(tag, props, children) {
    const el = {
      tagName: String(tag).toUpperCase(),
      className: (props && props.class) || "",
      textContent: (props && props.text) || "",
      disabled: false,
      title: (props && props.title) || "",
      children: [],
      listeners: Object.create(null),
      childElementCount: 0,
      appendChild(c) {
        this.children.push(c);
        this.childElementCount = this.children.length;
        return c;
      },
      addEventListener(type, fn) {
        if (!this.listeners[type]) this.listeners[type] = [];
        this.listeners[type].push(fn);
      },
      click() {
        const list = this.listeners.click || [];
        return Promise.all(list.map((fn) => fn({ currentTarget: this })));
      },
    };
    if (props) {
      for (const k of Object.keys(props)) {
        if (k.slice(0, 2) === "on" && typeof props[k] === "function") {
          el.addEventListener(k.slice(2).toLowerCase(), props[k]);
        }
      }
    }
    if (tag === "button") buttons.push(el);
    if (children != null) {
      const arr = Array.isArray(children) ? children : [children];
      for (const c of arr) {
        if (c != null) el.appendChild(c);
      }
    }
    return el;
  }
  const sandbox = Object.assign(
    {
      h,
      DownloadIntent: {
        createFirefoxIntent: (opts) => {
          const base = opts.baseIntent || {};
          return Object.assign({}, base, {
            userSelectedFirefox: true,
            userActionToken: base.userActionToken,
          });
        },
      },
      mintUserActionToken: () => "fx-tok-1",
      send: async () => ({ ok: true }),
      console,
    },
    deps
  );
  // Keep buttons list shared so tests can find the Firefox button.
  sandbox.__buttons = buttons;
  vm.runInNewContext(src + "\nthis.renderNeedsUserActions = renderNeedsUserActions;", sandbox);
  return {
    renderNeedsUserActions: sandbox.renderNeedsUserActions,
    buttons,
    h,
  };
}

test("Use Firefox disables before send; two sync clicks produce one send/token; failure re-enables", async () => {
  let tokenN = 0;
  const sendCalls = [];
  let resolveSend;
  const sendPromise = new Promise((r) => {
    resolveSend = r;
  });
  const { renderNeedsUserActions, buttons } = loadRenderNeedsUserActions({
    mintUserActionToken: () => {
      tokenN += 1;
      return "fx-tok-" + tokenN;
    },
    send: async (msg) => {
      sendCalls.push(msg);
      return sendPromise;
    },
  });

  const card = {
    children: [],
    appendChild(c) {
      this.children.push(c);
      return c;
    },
  };
  renderNeedsUserActions(
    {
      id: 42,
      requestedFilename: "clip.mp4",
      destinationDirectory: null,
      saveMode: "default",
      createdAt: "2026-08-12T12:00:00.000Z",
    },
    card
  );

  const fxBtn = buttons.find((b) => b.textContent === "Use Firefox instead");
  assert.ok(fxBtn, "Use Firefox instead button must exist");

  // Fire two synchronous clicks before the first send resolves.
  const p1 = fxBtn.click();
  const p2 = fxBtn.click();
  assert.equal(fxBtn.disabled, true, "button must be disabled before/during send");
  assert.equal(sendCalls.length, 1, "only one use-firefox message");
  assert.equal(tokenN, 1, "only one proof token minted");
  assert.equal(sendCalls[0].type, "use-firefox");
  assert.equal(sendCalls[0].id, 42);
  assert.equal(sendCalls[0].intent.userActionToken, "fx-tok-1");

  resolveSend({ ok: true });
  await Promise.all([p1, p2]);
  assert.equal(fxBtn.disabled, true, "accepted handoff keeps button disabled");

  // Failure path: re-enable so the user can retry.
  tokenN = 0;
  sendCalls.length = 0;
  const { renderNeedsUserActions: render2, buttons: buttons2 } = loadRenderNeedsUserActions({
    mintUserActionToken: () => {
      tokenN += 1;
      return "fx-tok-" + tokenN;
    },
    send: async (msg) => {
      sendCalls.push(msg);
      return { ok: false, error: "handoff refused" };
    },
  });
  const card2 = {
    children: [],
    appendChild(c) {
      this.children.push(c);
      return c;
    },
  };
  render2(
    {
      id: 99,
      requestedFilename: "clip.mp4",
      destinationDirectory: "E:\\Media",
      saveMode: "save-as",
      createdAt: "2026-08-12T12:00:00.000Z",
    },
    card2
  );
  const fxBtn2 = buttons2.find((b) => b.textContent === "Use Firefox instead");
  await fxBtn2.click();
  assert.equal(sendCalls.length, 1);
  assert.equal(fxBtn2.disabled, false, "failure must re-enable for retry");
  // Second child is the status/error line (first is the action row).
  const errEl = card2.children[1];
  assert.ok(errEl);
  assert.match(String(errEl.textContent), /handoff refused/);
});

// ---------------------------------------------------------------------------
// Visible size text on opaque rows (Task 2)
// ---------------------------------------------------------------------------

function sizeRenderHarness() {
  const h = loadPopupRenderHarness();
  h.sandbox.McMediaSize = loadLib("lib/media-size.js");
  h.sandbox.humanSize = function humanSize(bytes) {
    if (!bytes) return "";
    const u = ["B", "KB", "MB", "GB"];
    let i = 0, n = bytes;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(n < 10 && i > 0 ? 1 : 0) + " " + u[i];
  };
  const source = readPopupSource();
  vm.runInContext(
    extractNamedFunction(source, "mediaSizeLabel") + "\nthis.mediaSizeLabel = mediaSizeLabel;",
    h.sandbox
  );
  return h;
}

function cardText(node) {
  return popupNodes(node, () => true)
    .map((child) => (child.props && typeof child.props.text === "string" ? child.props.text : ""))
    .join(" ");
}

test("opaque rows visibly state exact, estimated, or unknown size", () => {
  const h = sizeRenderHarness();
  h.sandbox.render([
    { id: "media:s1:1", kind: "direct", proposedFilename: "exact.mp4",
      sizeBytes: 1395864371, sizeConfidence: "exact" },
    { id: "media:s2:1", kind: "direct", proposedFilename: "estimated.mp4",
      sizeBytes: 1395864371, sizeConfidence: "estimated" },
    { id: "media:s3:1", kind: "direct", proposedFilename: "unknown.mp4" },
  ]);

  const [exactCard, estimatedCard, unknownCard] = h.listEl.children.map(cardText);
  assert.match(exactCard, /1\.3 GB/);
  assert.doesNotMatch(exactCard, /Est\./);
  assert.match(estimatedCard, /Est\. 1\.3 GB/);
  assert.match(unknownCard, /Size unknown/);
});

test("an unvalidated item.size can never relabel an opaque row as exact", () => {
  const h = sizeRenderHarness();
  // Hostile/legacy scalars on a managed row must not become a visible total.
  h.sandbox.render([
    { id: "media:s4:1", kind: "direct", proposedFilename: "spoof.mp4", size: 1395864371 },
    { id: "media:s5:1", kind: "direct", proposedFilename: "junk.mp4",
      size: 999, sizeBytes: "1395864371", sizeConfidence: "exact" },
    { id: "media:s6:1", kind: "direct", proposedFilename: "bogus.mp4",
      sizeBytes: 1024, sizeConfidence: "guessed" },
  ]);

  for (const text of h.listEl.children.map(cardText)) {
    assert.match(text, /Size unknown/);
    assert.doesNotMatch(text, /1\.3 GB/);
  }
});

// One story for "not known yet" across every surface that states a size: the
// left pane's rows, the Downloads pane's cards, and the Save As window all say
// "Size unknown". A legacy row used to render an empty string here, which left
// a blank where a size belongs — indistinguishable from a row that forgot to
// render one. lib/media-size.js already said "Size unknown" for the opaque rows
// and for the Save As window, so that is the wording the other surface adopts
// rather than a third phrasing.
test("legacy non-opaque rows keep their existing exact transfer size text", () => {
  const h = sizeRenderHarness();
  assert.equal(h.sandbox.mediaSizeLabel({ url: "https://cdn.example/a.mp4", size: 1024 }), "1.0 KB");
  assert.equal(h.sandbox.mediaSizeLabel({ url: "https://cdn.example/a.mp4" }), "Size unknown");
  assert.equal(h.sandbox.mediaSizeLabel({ id: "media:s7:1" }), "Size unknown");
  assert.equal(
    h.sandbox.mediaSizeLabel({ id: "media:s8:1", sizeBytes: 1024, sizeConfidence: "estimated" }),
    "Est. 1.0 KB"
  );
});

test("a legacy row with no size states that on the card, not by omission", () => {
  const h = sizeRenderHarness();
  h.sandbox.render([{ url: "https://cdn.example/legacy.mp4", kind: "direct", name: "legacy.mp4" }]);
  assert.match(cardText(h.listEl.children[0]), /Size unknown/);
});

// ---------------------------------------------------------------------------
// Managed Save As launches a persistent window (Task 3)
// ---------------------------------------------------------------------------

function clickSaveAs(h, row) {
  const button = popupNodes(row, (node) => node.tag === "button" && node.props.text === "Save As…")[0];
  assert.ok(button, "row must offer Save As…");
  button.props.onClick();
  return button;
}

test("managed Save As asks background to open a persistent opaque window", () => {
  const h = loadPopupRenderHarness();
  h.sandbox.render([{
    id: "media:opaque:1",
    tabId: 7,
    kind: "direct",
    proposedFilename: "11474-makemebi.net.mp4",
  }]);
  clickSaveAs(h, h.listEl.children[0]);

  assert.deepEqual(h.sentMessages.at(-1), {
    type: "open-save-as",
    tabId: 7,
    mediaId: "media:opaque:1",
    variantId: null,
  });
  assert.equal(h.sentMessages.length, 1);
});

test("a managed variant selection travels as an opaque variant ID only", () => {
  const h = loadPopupRenderHarness();
  h.sandbox.render([{
    id: "media:opaque:2",
    tabId: 9,
    kind: "hls",
    proposedFilename: "episode.mp4",
    variants: [{
      id: "variant:opaque:1",
      label: "1080p",
      height: 1080,
      uri: "https://must-not-cross.example/SIGNED_URL_SENTINEL.m3u8",
    }],
  }]);
  clickSaveAs(h, h.listEl.children[0]);

  const sent = h.sentMessages.at(-1);
  assert.equal(sent.type, "open-save-as");
  assert.equal(sent.mediaId, "media:opaque:2");
  assert.equal(sent.tabId, 9);
  assert.equal(Object.prototype.hasOwnProperty.call(sent, "variantUrl"), false);
  assert.equal(JSON.stringify(h.sentMessages).includes("SIGNED_URL_SENTINEL"), false);
});

test("a managed row without its own tabId falls back to the current tab", () => {
  const h = loadPopupRenderHarness();
  h.sandbox.currentTabId = 7;
  h.sandbox.render([{ id: "media:opaque:3", kind: "direct", proposedFilename: "clip.mp4" }]);
  clickSaveAs(h, h.listEl.children[0]);
  assert.equal(h.sentMessages.at(-1).tabId, 7);
});

// ---------------------------------------------------------------------------
// The picture on a left-pane row
//
// `preview` is the frame captured from the media itself. `thumb` already
// existed and holds a screenshot of the PAGE the media was found on, set on
// every YouTube download by background.js — so the two are not interchangeable,
// and a preview must not be rendered from the page screenshot's field or the
// row shows a picture of a web page as if it were the file.
// ---------------------------------------------------------------------------

function thumbOf(row) {
  return popupNodes(row, (node) => /(^|\s)thumb(\s|$)/.test(String(node.props.class || "")))[0];
}

function imageIn(node) {
  return popupNodes(node, (n) => n.tag === "img")[0];
}

const PIXEL = "data:image/png;base64,iVBORw0KGgo=";

test("a row's own preview frame is what the thumbnail shows", () => {
  const h = loadPopupRenderHarness();
  h.sandbox.render([{ id: "media:p1:1", kind: "direct", proposedFilename: "clip.mp4", preview: PIXEL }]);
  const thumb = thumbOf(h.listEl.children[0]);
  assert.ok(thumb, "the row still has a thumbnail slot");
  assert.equal(imageIn(thumb).props.src, PIXEL);
  assert.equal(/(^|\s)ph(\s|$)/.test(String(thumb.props.class)), false,
    "and it is no longer the placeholder");
});

test("the preview frame wins over the page screenshot", () => {
  const h = loadPopupRenderHarness();
  h.sandbox.render([{
    id: "media:p2:1", kind: "direct", proposedFilename: "clip.mp4",
    preview: PIXEL, thumb: "data:image/png;base64,PAGESHOT",
  }]);
  assert.equal(imageIn(thumbOf(h.listEl.children[0])).props.src, PIXEL,
    "a picture of the page is not a picture of the file");
});

test("with no preview the existing page screenshot still shows", () => {
  const h = loadPopupRenderHarness();
  h.sandbox.render([{
    id: "media:p3:1", kind: "direct", proposedFilename: "clip.mp4",
    thumb: "data:image/png;base64,PAGESHOT",
  }]);
  assert.equal(imageIn(thumbOf(h.listEl.children[0])).props.src, "data:image/png;base64,PAGESHOT");
});

test("with neither, the placeholder is untouched", () => {
  const h = loadPopupRenderHarness();
  h.sandbox.render([{ id: "media:p4:1", kind: "hls", proposedFilename: "clip.mp4" }]);
  const thumb = thumbOf(h.listEl.children[0]);
  assert.match(String(thumb.props.class), /ph/);
  assert.match(String(thumb.props.class), /cam/, "an HLS row keeps its camera tint");
  assert.equal(imageIn(thumb), undefined, "and renders no image element");
});

test("a preview that is not an image data URL is refused", () => {
  const h = loadPopupRenderHarness();
  for (const hostile of ["https://cdn.example/frame.png", "javascript:alert(1)",
                         "data:text/html,<script>", 42, {}]) {
    const harnessed = loadPopupRenderHarness();
    harnessed.sandbox.render([{ id: "media:p5:1", kind: "direct", proposedFilename: "c.mp4", preview: hostile }]);
    const thumb = thumbOf(harnessed.listEl.children[0]);
    assert.equal(imageIn(thumb), undefined,
      "a field on an untrusted record must not become a fetch: " + String(hostile));
    assert.match(String(thumb.props.class), /ph/);
  }
  assert.ok(h);
});

test("non-opaque legacy rows keep the inline form and never serialize a URL", () => {
  const h = loadPopupRenderHarness();
  const openings = [];
  h.sandbox.openSaveAsForm = (item) => openings.push(item);
  h.sandbox.render([{
    url: "https://cdn.example/legacy.mp4?token=SIGNED_URL_SENTINEL",
    kind: "direct",
    name: "legacy.mp4",
  }]);
  clickSaveAs(h, h.listEl.children[0]);

  assert.equal(openings.length, 1, "legacy rows keep their existing inline path");
  assert.equal(h.sentMessages.length, 0, "no open-save-as message for a legacy row");
});
