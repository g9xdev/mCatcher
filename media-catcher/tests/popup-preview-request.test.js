"use strict";
/*
 * Who asks for a left-pane preview frame.
 *
 * A row's picture arrives as `item.preview`, and popup-intent.test.js already
 * pins how that field is rendered. What was missing is the ask: nothing sent
 * {type:"capture-preview", identity, tabId}, so the field was never populated
 * for a real user and the picture never appeared.
 *
 * The handler for that message lives in background.js on the other lane, so
 * this suite stubs the port the way the other popup suites do (popup-badapple-
 * stop.test.js, popup-file-actions.test.js) and pins the popup's half only:
 * which rows are asked about, how many asks are outstanding at once, which
 * answers are remembered, and what the arrival of a frame does to the row.
 *
 * The asks are bounded on purpose. A capture can come back "cannot" forever —
 * a cross-origin <video> taints the canvas and no later attempt can untaint it
 * — so an answer that carries no frame has to be remembered, or every render
 * re-asks and the popup spins.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { mediaCatcherRoot } = require("./harness/load-lib.js");

function popupSource() {
  return fs.readFileSync(path.join(mediaCatcherRoot, "popup", "popup.js"), "utf8");
}

// Same extraction the popup-intent and popup-file-actions suites use.
function extractNamedFunction(source, name) {
  const re = new RegExp("(?:async\\s+)?function\\s+" + name + "\\s*\\(");
  const m = re.exec(source);
  if (!m) throw new Error("function not found: " + name);
  let i = source.indexOf("{", m.index);
  if (i < 0) throw new Error("no body for " + name);
  let depth = 0;
  for (; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(m.index, i + 1);
    }
  }
  throw new Error("unbalanced braces for " + name);
}

// The preview bookkeeping is `const` state, not functions, and the guards are
// only worth testing against the real containers and the real cap — a cap the
// harness invented would keep a production change to it green.
function extractDeclaration(source, name) {
  const re = new RegExp("^const\\s+" + name + "\\s*=.*$", "m");
  const m = re.exec(source);
  if (!m) throw new Error("declaration not found: " + name);
  return m[0];
}

function node(tag, props, children) {
  const el = {
    tag,
    props: props || {},
    children: [],
    style: {},
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren() {
      this.children = Array.from(arguments).filter((child) => child != null);
    },
    querySelector() { return null; },
  };
  // A classList that really edits the class string, so a test can see the
  // placeholder tint leave the thumbnail when a frame lands on it.
  const classes = new Set(String(el.props.class || "").trim().split(/\s+/).filter(Boolean));
  const sync = () => { el.props.class = Array.from(classes).join(" "); };
  el.classList = {
    add() { for (const n of arguments) classes.add(n); sync(); },
    remove() { for (const n of arguments) classes.delete(n); sync(); },
    toggle(n, on) { if (on) classes.add(n); else classes.delete(n); sync(); },
    contains(n) { return classes.has(n); },
  };
  const list = children == null ? [] : (Array.isArray(children) ? children : [children]);
  for (const child of list) if (child != null) el.appendChild(child);
  return el;
}

function nodes(root, predicate, out) {
  out = out || [];
  if (root && typeof root === "object") {
    if (predicate(root)) out.push(root);
    for (const child of root.children || []) nodes(child, predicate, out);
  }
  return out;
}

function thumbOf(row) {
  return nodes(row, (n) => /(^|\s)thumb(\s|$)/.test(String(n.props.class || "")))[0];
}

function imageIn(n) {
  return nodes(n, (x) => x.tag === "img")[0];
}

const PIXEL = "data:image/png;base64,iVBORw0KGgo=";
const FRAME = "data:image/jpeg;base64,ZnJhbWU=";

const PIECES = [
  "isSafeOpaqueId", "itemIdentity", "hostOf", "proposedFilenameOf", "displayNameOf",
  "fmtDuration", "bitrateLabel", "mediaSizeLabel", "previewSrc", "renderQualities",
  "previewTabIdOf", "wantsPreview", "requestPreviews", "settlePreview", "paintPreview",
  "renderItem", "render",
];

const DECLARATIONS = [
  "PREVIEW_IN_FLIGHT_CAP", "previewPending", "previewCannot", "previewFrames", "previewSlots",
];

function harness(options) {
  options = options || {};
  const source = popupSource();
  const sent = [];
  let repaints = 0;
  const listEl = {
    children: [],
    replaceChildren() {
      repaints += 1;
      this.children = Array.from(arguments).filter((child) => child != null);
    },
    appendChild(child) { this.children.push(child); return child; },
  };
  const sandbox = {
    console,
    URL,
    // Unanswered by default: the request is out and the reply has not come
    // back, which is the state the in-flight bookkeeping exists for.
    send(message) {
      sent.push(JSON.parse(JSON.stringify(message)));
      if (!options.reply) return new Promise(() => {});
      return Promise.resolve(options.reply(message));
    },
    currentTabId: options.currentTabId === undefined ? 7 : options.currentTabId,
    pageTitle: "",
    castUiReady: false,
    h: node,
    humanSize: () => "",
    showLabel: () => {},
    appendNote: () => {},
    handleDownload: () => {},
    startRecording: () => {},
    startDownload: () => {},
    openSaveAsForm: () => {},
    toggleCommandMenu: () => {},
    openCastPicker: () => {},
    renderProgress: () => {},
    renderHelperBadge: () => {},
    itemDownloadId: new Map(),
    itemElements: new Map(),
    downloadState: new Map(),
    listEl,
    footCount: { textContent: "" },
    leftCountEl: { textContent: "" },
    statusEl: { textContent: "" },
  };
  const code = DECLARATIONS.map((name) => extractDeclaration(source, name))
    .concat(PIECES.map((name) => extractNamedFunction(source, name)))
    .join("\n") +
    "\nthis.render = render;" +
    "\nthis.wantsPreview = wantsPreview;" +
    "\nthis.previewPending = previewPending;" +
    "\nthis.previewCannot = previewCannot;" +
    "\nthis.previewFrames = previewFrames;" +
    "\nthis.PREVIEW_IN_FLIGHT_CAP = PREVIEW_IN_FLIGHT_CAP;";
  vm.runInNewContext(code, sandbox);
  return {
    sandbox,
    listEl,
    sent,
    repaints: () => repaints,
    captures: () => sent.filter((m) => m && m.type === "capture-preview"),
  };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function row(extra) {
  return Object.assign({ id: "media:m1:1", kind: "direct", proposedFilename: "clip.mp4" }, extra);
}

// ---------------------------------------------------------------------------
// The ask itself
// ---------------------------------------------------------------------------

test("a rendered row with no frame asks for one, and asks exactly once", () => {
  const h = harness();
  const item = row({ tabId: 12 });

  h.sandbox.render([item]);
  h.sandbox.render([item]);      // what the media-updated debounce does, repeatedly

  const asks = h.captures();
  assert.equal(asks.length, 1, "one row lacking a frame is one request, not one per render");
  assert.deepEqual(asks[0], { type: "capture-preview", identity: "id:media:m1:1", tabId: 12 });
});

test("a row that already carries a frame asks for nothing", () => {
  const h = harness();
  h.sandbox.render([row({ tabId: 12, preview: PIXEL })]);
  assert.equal(h.captures().length, 0, "the frame is already on the record");
  // And the row still shows it, so nothing was traded away for the silence.
  assert.equal(imageIn(thumbOf(h.listEl.children[0])).props.src, PIXEL);
});

test("a row without its own tabId is asked about on the tab the popup is watching", () => {
  const h = harness({ currentTabId: 7 });
  h.sandbox.render([row()]);
  assert.equal(h.captures()[0].tabId, 7);
});

// ---------------------------------------------------------------------------
// The negative answer
//
// A cross-origin <video> taints the canvas: the content script cannot read a
// frame from it and no later attempt will change that. The refusal is cached so
// the popup asks once and then stops, instead of re-asking on every render.
// ---------------------------------------------------------------------------

test("a 'cannot' answer is remembered and never asked again", async () => {
  const h = harness({ reply: () => ({ ok: false, reason: "tainted" }) });
  const item = row({ tabId: 12 });

  h.sandbox.render([item]);
  await flush();
  assert.equal(h.sandbox.previewCannot.has("id:media:m1:1"), true, "the refusal is written down");

  h.sandbox.render([item]);
  await flush();
  h.sandbox.render([item]);
  await flush();

  assert.equal(h.captures().length, 1, "a refusal that is re-asked every render is a spin");
});

test("an answer that carries no frame at all counts as 'cannot'", async () => {
  // What an unmerged background gives back: no handler for the type, so the
  // reply is undefined. One ask per row is bounded; one ask per render is not.
  const h = harness({ reply: () => undefined });
  const item = row({ tabId: 12 });

  h.sandbox.render([item]);
  await flush();
  h.sandbox.render([item]);
  await flush();

  assert.equal(h.captures().length, 1);
});

test("a frame that is not an image data URL is refused and not asked for again", async () => {
  const h = harness({ reply: () => ({ ok: true, preview: "https://cdn.example/frame.png" }) });
  const item = row({ tabId: 12 });

  h.sandbox.render([item]);
  await flush();
  assert.equal(imageIn(thumbOf(h.listEl.children[0])), undefined,
    "a reply must not turn the thumbnail into a network fetch");

  h.sandbox.render([item]);
  await flush();
  assert.equal(h.captures().length, 1);
});

// ---------------------------------------------------------------------------
// The frame's arrival
// ---------------------------------------------------------------------------

test("an arriving frame lands on the row without rebuilding the list", async () => {
  const h = harness({ reply: () => ({ ok: true, preview: FRAME }) });
  h.sandbox.render([row({ tabId: 12 })]);

  const rendered = h.listEl.children[0];
  const paintsAfterRender = h.repaints();
  const thumb = thumbOf(rendered);
  assert.equal(imageIn(thumb), undefined, "no picture yet");

  await flush();

  assert.equal(h.listEl.children[0], rendered, "the same row element, not a replacement");
  assert.equal(h.repaints(), paintsAfterRender, "the list was not rebuilt under the user");
  assert.equal(imageIn(thumb).props.src, FRAME, "the frame is on the row");
  assert.equal(thumb.classList.contains("ph"), false, "and the placeholder tint is gone");
  assert.equal(thumb.props.class, "thumb");
  // The frame number stays: it is the row's label, not part of the placeholder.
  assert.equal(nodes(thumb, (n) => n.props.class === "fno").length, 1);
});

test("a frame that has arrived survives the next render and is not asked for twice", async () => {
  const h = harness({ reply: () => ({ ok: true, preview: FRAME }) });
  const item = row({ tabId: 12 });

  h.sandbox.render([item]);
  await flush();
  // The next snapshot has not caught up: background has not yet put the frame
  // on the record, so the item still arrives without one.
  h.sandbox.render([item]);
  await flush();

  assert.equal(h.captures().length, 1);
  assert.equal(imageIn(thumbOf(h.listEl.children[0])).props.src, FRAME,
    "the row the popup already has a frame for shows it again");
});

// ---------------------------------------------------------------------------
// Bounds and the rows worth asking about
// ---------------------------------------------------------------------------

test("no more requests are in flight at once than the cap allows", () => {
  const h = harness();
  const cap = h.sandbox.PREVIEW_IN_FLIGHT_CAP;
  assert.equal(Number.isInteger(cap) && cap > 0 && cap <= 4, true,
    "the cap is a small positive integer, or it is not a cap: " + String(cap));

  const many = [];
  for (let i = 0; i < cap + 3; i += 1) {
    many.push({ id: "media:many:" + i, kind: "direct", proposedFilename: "c.mp4", tabId: 12 });
  }
  h.sandbox.render(many);

  assert.equal(h.captures().length, cap, "a snapshot of many rows is not a burst of captures");
});

test("the rows the cap held back are asked about once the answers come in", async () => {
  let answered = 0;
  const h = harness({ reply: () => { answered += 1; return { ok: false }; } });
  const cap = h.sandbox.PREVIEW_IN_FLIGHT_CAP;
  const many = [];
  for (let i = 0; i < cap + 2; i += 1) {
    many.push({ id: "media:drain:" + i, kind: "direct", proposedFilename: "c.mp4", tabId: 12 });
  }

  h.sandbox.render(many);
  await flush();
  h.sandbox.render(many);
  await flush();

  assert.equal(answered, cap + 2, "every row is eventually asked about, just not all at once");
});

test("a DRM row is never asked for a frame", () => {
  const h = harness();
  h.sandbox.render([row({ tabId: 12, drm: true })]);
  assert.equal(h.captures().length, 0,
    "an encrypted <video> cannot be drawn to a canvas, so the ask has no answer to give");
});

test("a row with no tab to reach is not asked about", () => {
  const h = harness({ currentTabId: null });
  h.sandbox.render([row()]);
  assert.equal(h.captures().length, 0, "the message needs a tab for background to reach");
});

test("a row with neither an opaque id nor a URL is not asked about", () => {
  const h = harness();
  h.sandbox.render([{ kind: "direct", proposedFilename: "clip.mp4", tabId: 12 }]);
  assert.equal(h.captures().length, 0,
    "there is no name in the request for background to match a record by");
});

test("a legacy URL row is asked about under its URL identity", () => {
  const h = harness();
  const url = "https://cdn.example/legacy.mp4";
  h.sandbox.render([{ url, kind: "direct", name: "legacy.mp4", tabId: 12 }]);
  assert.deepEqual(h.captures(), [{ type: "capture-preview", identity: "url:" + url, tabId: 12 }]);
});
