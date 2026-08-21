"use strict";
/*
 * What a finished download shows, and what you can do with it.
 *
 * Both panes render the same row from the same record: "Media on this tab"
 * (.pane-left) draws it through renderProgress / renderLiveProgress, and
 * "Downloads" (.pane-right) through renderQueueItem. Three questions are
 * pinned here because all three were answered differently on the two sides:
 *
 *   1. how big is it — percent-scaled rows (yt-dlp) had no size at all,
 *      because the byte total the helper sends was thrown away upstream and
 *      the renderers had nothing left to read
 *   2. can I reach the file — Open / Folder were REMOVED, not disabled, when
 *      the helper was not connected, and one completed branch never asked for
 *      them at all
 *   3. can I hand it to BadApple — a third action, on the same row, gated on
 *      the helper reporting that BadApple is actually installed
 *
 * The renderers are lifted out of popup.js by name and run against a recording
 * `h`, the same way popup-intent.test.js already exercises renderProgress —
 * these are the real functions, not a restatement of them.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadLib, mediaCatcherRoot } = require("./harness/load-lib.js");

loadLib("lib/filename-ranker.js");
loadLib("lib/download-intent.js");
const UI = loadLib("lib/popup-download-ui.js");
const MediaSize = loadLib("lib/media-size.js");

const SCHEDULER_STATES = new Set([
  "queued", "waiting_provider", "running", "retry_backoff", "pausing_provider",
  "needs_user", "handing_off_firefox", "handed_to_firefox", "failed",
  "completed", "cancelled",
]);

function popupSource() {
  return fs.readFileSync(path.join(mediaCatcherRoot, "popup", "popup.js"), "utf8");
}

// Same extraction the popup-intent suite uses: find `function <name>(` and take
// the balanced body after it.
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

function node(tag, props, children) {
  const el = {
    tag,
    props: props || {},
    children: [],
    childElementCount: 0,
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(child) {
      this.children.push(child);
      this.childElementCount = this.children.length;
      return child;
    },
    remove() {},
    replaceChildren() {
      this.children = Array.from(arguments).filter((child) => child != null);
      this.childElementCount = this.children.length;
    },
    querySelector() { return null; },
  };
  const list = children == null ? [] : (Array.isArray(children) ? children : [children]);
  for (const child of list) if (child != null) el.appendChild(child);
  return el;
}

function walk(root, out) {
  out = out || [];
  if (root && typeof root === "object") {
    out.push(root);
    for (const child of root.children || []) walk(child, out);
  }
  return out;
}

function buttons(root) {
  return walk(root).filter((n) => n && n.tag === "button");
}

// Every string the row would put on screen, joined — text props and text
// children alike, so an assertion does not have to know which one carries it.
function textOf(root) {
  const parts = [];
  (function visit(n) {
    if (typeof n === "string") { parts.push(n); return; }
    if (!n || typeof n !== "object") return;
    if (typeof n.props.text === "string") parts.push(n.props.text);
    for (const child of n.children || []) visit(child);
  })(root);
  return parts.join(" ");
}

function harness(options) {
  options = options || {};
  const source = popupSource();
  const sent = [];
  const timers = [];
  const queueRenders = [];
  const slot = {
    kids: [],
    replaceChildren() {
      this.kids = Array.from(arguments).filter((k) => k != null);
    },
    appendChild(child) { this.kids.push(child); return child; },
  };
  const el = {
    classList: { toggle() {}, add() {}, remove() {} },
    firstChild: null,
    insertBefore() {},
    querySelector(sel) { return sel === ".slot" ? slot : null; },
  };
  const sandbox = {
    console,
    SCHEDULER_STATES,
    DELETE_ARM_MS: 4000,
    PopupUI: UI,
    McMediaSize: options.noSizeLib ? undefined : MediaSize,
    helperStatus: options.helperStatus || { state: "ready" },
    castUiReady: options.castUiReady === true,
    downloadState: options.downloadState || new Map(),
    deletedRows: options.deletedRows || new Set(),
    renderQueue() { queueRenders.push(true); },
    openCastPicker() {},
    renderNeedsUserActions() {},
    send(message) {
      sent.push(message);
      const reply = options.reply ? options.reply(message) : { ok: true };
      return Promise.resolve(reply);
    },
    // Captured rather than run: the confirm window is a real timer in the popup,
    // and a test that has to wait four seconds for it is a test nobody runs.
    setTimeout(fn) { timers.push(fn); return timers.length; },
    clearTimeout(handle) { if (handle) timers[handle - 1] = null; },
    api: { downloads: { open() {}, show() {}, pause() {}, resume() {} } },
    h: node,
  };
  const pieces = [
    "sizeBytesOf", "humanSize", "downloadSizeLabel", "pad2", "fmtDuration", "h265Note", "qualityLabel",
    "queueSpec", "statusWord", "schedulerStateOf", "formatJobStatusLabel",
    "helperOn", "openDlFile", "previewSrc", "rowIsDeleted", "fileActionRow", "renderLiveProgress",
    "renderProgress", "renderQueueItem",
  ].map((name) => extractNamedFunction(source, name));
  vm.runInNewContext(
    pieces.join("\n") +
      "\nthis.fileActionRow = fileActionRow;" +
      "\nthis.renderLiveProgress = renderLiveProgress;" +
      "\nthis.renderProgress = renderProgress;" +
      "\nthis.renderQueueItem = renderQueueItem;",
    sandbox
  );
  return { sandbox, el, slot, sent, timers, queueRenders };
}

// A button's visible label: created from props.text, rewritten through
// textContent once the control changes state.
function label(button) {
  return button.textContent != null ? button.textContent : button.props.text;
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

const GIG = 1181116006;          // what humanSize calls "1.1 GB"

// ---------------------------------------------------------------------------
// 1. The size of a percent-scaled download
// ---------------------------------------------------------------------------

test("a finished YouTube row shows its size in the left pane", () => {
  const h = harness();
  // How a finished yt-dlp row actually looks: live, done, percent-scaled, with
  // the helper's final byte count on it.
  h.sandbox.renderLiveProgress(h.el, {
    id: 1, name: "clip", live: true, status: "done",
    savedPath: "C:\\Users\\x\\Downloads\\clip.mp4",
    recorded: { bytes: GIG },
    progress: { done: 100, total: 100, unit: "pct" },
  });
  const text = h.slot.kids.map(textOf).join(" ");
  assert.match(text, /Saved/, "the saved chip still renders");
  assert.match(text, /1\.1 GB/, "a finished row must state how big the file is");
});

test("a downloading YouTube row shows bytes so far against the total", () => {
  const h = harness();
  h.sandbox.renderProgress(h.el, {
    id: 2, name: "clip", live: true, status: "downloading",
    progress: { done: 12, total: 100, unit: "pct", totalBytes: GIG, bps: 0,
                stage: "downloading", live: true },
  });
  const text = h.slot.kids.map(textOf).join(" ");
  assert.match(text, /135 MB \/ 1\.1 GB/,
    "a percent-scaled row must read as bytes-so-far of the real total");
});

test("the queue card sizes a percent-scaled row from the same byte total", () => {
  const h = harness();
  const card = h.sandbox.renderQueueItem({
    id: 3, name: "clip", live: true, status: "downloading",
    progress: { done: 12, total: 100, unit: "pct", totalBytes: GIG, bps: 0 },
  });
  assert.match(textOf(card), /12% of 1\.1 GB/,
    "the right pane phrases a percent row the way it already phrases a byte row");
});

test("a percent row with no byte total keeps its plain percent label", () => {
  const h = harness();
  const card = h.sandbox.renderQueueItem({
    id: 4, name: "clip", live: true, status: "downloading",
    progress: { done: 12, total: 100, unit: "pct", bps: 0 },
  });
  assert.match(textOf(card), /12%/);
  assert.equal(/of/.test(textOf(card)), false,
    "an unknown total must not be rendered as a size");
});

test("merging still says so rather than a size", () => {
  const h = harness();
  h.sandbox.renderProgress(h.el, {
    id: 5, name: "clip", live: false, status: "downloading",
    progress: { done: 99, total: 100, unit: "pct", totalBytes: GIG, stage: "merging" },
  });
  assert.match(h.slot.kids.map(textOf).join(" "), /merging/);
});

// ---------------------------------------------------------------------------
// 2. Reaching the file
// ---------------------------------------------------------------------------

test("a helper-saved file offers Open, Folder and Delete, enabled", () => {
  const h = harness();
  const row = h.sandbox.fileActionRow({
    id: 6, name: "clip", status: "done", savedPath: "C:\\x\\clip.mp4",
  });
  const enabled = buttons(row).filter((b) => !b.props.disabled).map((b) => b.props.text);
  assert.deepEqual(enabled, ["▶ Open", "Folder", "Delete"]);
});

test("with the helper down the actions are disabled with a reason, not removed", () => {
  const h = harness({ helperStatus: { state: "disconnected" } });
  const row = h.sandbox.fileActionRow({
    id: 7, name: "clip", status: "done", savedPath: "C:\\x\\clip.mp4",
  });
  assert.ok(row, "a saved file must not lose its controls when the helper drops");
  const open = buttons(row).find((b) => b.props.text === "▶ Open");
  assert.ok(open, "Open is still on the row");
  assert.ok(open.props.disabled, "but it is disabled rather than silently absent");
  assert.match(String(open.props.title), /helper/i,
    "and it says why it cannot be used");
});

test("a row with no file at all still renders no file actions", () => {
  const h = harness({ helperStatus: { state: "disconnected" } });
  assert.equal(h.sandbox.fileActionRow({ id: 8, name: "clip", status: "downloading" }), null);
});

// A scheduler job that completes without ever publishing a progress total takes
// the label-only branch of renderProgress, which returned before any file
// action was offered — the completed row dead-ended at "Completed".
test("a completed job with no progress still gets its file actions", () => {
  const h = harness();
  h.sandbox.renderProgress(h.el, {
    id: 9, name: "clip", state: "completed", savedPath: "C:\\x\\clip.mp4",
  });
  const labels = h.slot.kids.flatMap((k) => buttons(k)).map((b) => b.props.text);
  assert.ok(labels.includes("▶ Open"),
    "a completed row must be actionable, not just labelled");
});

// ---------------------------------------------------------------------------
// 3. Open in BadApple
// ---------------------------------------------------------------------------

test("BadApple appears on the row when the helper reports it installed", () => {
  const h = harness({ helperStatus: { state: "ready", badapple: true } });
  const row = h.sandbox.fileActionRow({
    id: 10, name: "clip", status: "done", savedPath: "C:\\x\\clip.mp4",
  });
  const badapple = buttons(row).find((b) => /BadApple/.test(b.props.text || ""));
  assert.ok(badapple, "the third action is offered next to Open and Folder");

  badapple.props.onClick({ currentTarget: badapple });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].type, "open-in-badapple");
  assert.equal(h.sent[0].path, "C:\\x\\clip.mp4");
  assert.deepEqual(Object.keys(h.sent[0]).sort(), ["path", "type"],
    "the popup names the FILE only — the helper owns where BadApple lives");
});

test("BadApple is absent when the helper does not report it", () => {
  const h = harness({ helperStatus: { state: "ready" } });
  const row = h.sandbox.fileActionRow({
    id: 11, name: "clip", status: "done", savedPath: "C:\\x\\clip.mp4",
  });
  assert.equal(buttons(row).some((b) => /BadApple/.test(b.props.text || "")), false,
    "a button that could only ever fail is not shown");
});

test("the queue card carries the same three actions the item card does", () => {
  const h = harness({ helperStatus: { state: "ready", badapple: true } });
  const card = h.sandbox.renderQueueItem({
    id: 12, name: "clip", status: "done", savedPath: "C:\\x\\clip.mp4",
    recorded: { bytes: GIG },
  });
  const labels = buttons(card).map((b) => b.props.text || "");
  for (const want of ["▶ Open", "Folder", "Open in BadApple"]) {
    assert.ok(labels.includes(want), want + " is missing from the right pane");
  }
  assert.match(textOf(card), /1\.1 GB/, "and the right pane states the size");
});

// ---------------------------------------------------------------------------
// 4. Deleting the file
//
// Deletion is permanent — nothing here moves the file to a recycle bin — so the
// confirm click is the only thing standing between the user and a file that is
// not coming back. These pin that the control arms first, that it says why when
// it cannot act, and what the row becomes once the file is gone.
// ---------------------------------------------------------------------------

function deleteButton(row) {
  return buttons(row).find((b) => /Delete/.test(label(b) || ""));
}

test("a saved file offers Delete, on the right of the row", () => {
  const h = harness();
  const row = h.sandbox.fileActionRow({
    id: 20, name: "clip", status: "done", savedPath: "C:\\x\\clip.mp4",
  });
  const labels = buttons(row).map(label);
  assert.equal(labels.at(-1), "Delete", "Delete sits last, on the right");
  const del = deleteButton(row);
  assert.equal(del.props.disabled, null, "with a file and a helper it is usable");
});

test("the first Delete click asks for confirmation and sends nothing", () => {
  const h = harness();
  const row = h.sandbox.fileActionRow({
    id: 21, name: "clip", status: "done", savedPath: "C:\\x\\clip.mp4",
  });
  const del = deleteButton(row);
  del.props.onClick();
  assert.deepEqual(h.sent, [], "one click must not delete anything");
  assert.match(label(del), /confirm/i, "and the button now asks");
});

test("the confirming click sends delete-file with the path and the download id", async () => {
  const h = harness();
  const row = h.sandbox.fileActionRow({
    id: 22, name: "clip", status: "done", savedPath: "C:\\x\\clip.mp4", downloadId: 91,
  });
  const del = deleteButton(row);
  del.props.onClick();
  del.props.onClick();
  await flush();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].type, "delete-file");
  assert.equal(h.sent[0].downloadId, 91);
  assert.equal(h.sent[0].path, "C:\\x\\clip.mp4");
  assert.deepEqual(Object.keys(h.sent[0]).sort(), ["downloadId", "path", "type"],
    "the popup names the file and the browser download, nothing else");
});

test("a helper-saved file with no browser download carries a null id", async () => {
  const h = harness();
  const row = h.sandbox.fileActionRow({
    id: 23, name: "clip", status: "done", savedPath: "C:\\x\\clip.mp4",
  });
  const del = deleteButton(row);
  del.props.onClick();
  del.props.onClick();
  await flush();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].type, "delete-file");
  assert.equal(h.sent[0].downloadId, null,
    "a file the helper saved has no browser download id to name");
  assert.equal(h.sent[0].path, "C:\\x\\clip.mp4");
});

test("an unanswered confirmation lapses, so a stale click cannot delete", () => {
  const h = harness();
  const row = h.sandbox.fileActionRow({
    id: 24, name: "clip", status: "done", savedPath: "C:\\x\\clip.mp4",
  });
  const del = deleteButton(row);
  del.props.onClick();
  assert.equal(h.timers.length, 1, "arming starts the lapse timer");
  h.timers[0]();                       // the confirm window closes
  assert.match(label(del), /^Delete$/, "the button goes back to asking again");
  del.props.onClick();
  assert.deepEqual(h.sent, [], "the next click arms rather than deletes");
});

test("with the helper down Delete is disabled with a reason, not removed", () => {
  const h = harness({ helperStatus: { state: "disconnected" } });
  const row = h.sandbox.fileActionRow({
    id: 25, name: "clip", status: "done", savedPath: "C:\\x\\clip.mp4",
  });
  const del = deleteButton(row);
  assert.ok(del, "the control stays on the row");
  assert.ok(del.props.disabled, "disabled");
  assert.equal(del.props.onClick, null, "and wired to nothing");
  assert.match(String(del.props.title), /helper/i, "and it says why");
});

test("a row with no file on disk shows Delete disabled with its own reason", () => {
  const h = harness();
  const row = h.sandbox.fileActionRow({
    id: 26, name: "clip", status: "done", downloadId: 92,
  });
  const del = deleteButton(row);
  assert.ok(del, "the control is present even though there is no path yet");
  assert.ok(del.props.disabled);
  assert.match(String(del.props.title), /no saved file/i);
});

test("a row with no file actions at all gains no Delete either", () => {
  const h = harness();
  assert.equal(h.sandbox.fileActionRow({ id: 27, name: "clip", status: "downloading" }), null);
});

// What happens to the row: the file it was a handle to is gone, so every other
// action on it (Open, Folder, Cast, BadApple) would point at nothing. The row
// stays — it is the record of what the user did — and says the file is gone.
test("after a successful delete the row says so and offers no way to open the file", async () => {
  const h = harness();
  const dl = { id: 28, name: "clip", status: "done", savedPath: "C:\\x\\clip.mp4" };
  h.sandbox.downloadState.set(dl.id, dl);
  const row = h.sandbox.fileActionRow(dl);
  const del = deleteButton(row);
  del.props.onClick();
  del.props.onClick();
  await flush();
  assert.match(textOf(row), /deleted/i, "the row states the outcome");
  assert.equal(buttons(row).some((b) => /Open|Folder|Cast/.test(label(b) || "")), false,
    "and no control still claims to reach the file");
  assert.ok(h.queueRenders.length > 0, "the pane is repainted");
});

test("the next paint of a just-deleted row still says the file is gone", async () => {
  const h = harness();
  const dl = { id: 32, name: "clip", status: "done", savedPath: "C:\\x\\clip.mp4" };
  h.sandbox.downloadState.set(dl.id, dl);
  const del = deleteButton(h.sandbox.fileActionRow(dl));
  del.props.onClick();
  del.props.onClick();
  await flush();
  // The same record, rendered fresh — what a controller snapshot causes.
  const again = h.sandbox.fileActionRow(dl);
  assert.match(textOf(again), /deleted/i,
    "the outcome has to be remembered somewhere other than this element");
  assert.equal(buttons(again).some((b) => /Open|Folder/.test(label(b) || "")), false);
});

test("a deleted row still says so when the pane is painted again", () => {
  const deletedRows = new Set([29]);
  const h = harness({ deletedRows });
  const row = h.sandbox.fileActionRow({
    id: 29, name: "clip", status: "done", savedPath: "C:\\x\\clip.mp4",
  });
  assert.match(textOf(row), /deleted/i,
    "a controller snapshot re-rendering the row must not resurrect Open");
  assert.equal(buttons(row).some((b) => /Open|Folder/.test(label(b) || "")), false);
});

test("a delete that fails says why and leaves the file reachable", async () => {
  const h = harness({ reply: () => ({ ok: false, error: "file is in use" }) });
  const dl = { id: 30, name: "clip", status: "done", savedPath: "C:\\x\\clip.mp4" };
  h.sandbox.downloadState.set(dl.id, dl);
  const row = h.sandbox.fileActionRow(dl);
  const del = deleteButton(row);
  del.props.onClick();
  del.props.onClick();
  await flush();
  assert.match(String(del.title), /in use/, "the reason the host gave is on the control");
  assert.ok(buttons(row).some((b) => label(b) === "▶ Open"),
    "the file is still there, so Open still is");
  assert.equal(del.disabled, false, "and the user can try again");
});

test("the queue card carries Delete too", () => {
  const h = harness();
  const card = h.sandbox.renderQueueItem({
    id: 31, name: "clip", status: "done", savedPath: "C:\\x\\clip.mp4",
    recorded: { bytes: GIG },
  });
  assert.ok(buttons(card).some((b) => label(b) === "Delete"),
    "the right pane deletes the same file the left pane does");
});

// ---------------------------------------------------------------------------
// 5. The picture on a queue card
// ---------------------------------------------------------------------------

const PIXEL = "data:image/png;base64,iVBORw0KGgo=";

function images(root) {
  return walk(root).filter((n) => n && n.tag === "img");
}

test("a queue card shows the download's own preview frame", () => {
  const h = harness();
  const card = h.sandbox.renderQueueItem({
    id: 40, name: "clip", status: "done", savedPath: "C:\\x\\clip.mp4", preview: PIXEL,
  });
  const img = images(card)[0];
  assert.ok(img, "the right pane renders the frame too");
  assert.equal(img.props.src, PIXEL);
});

test("a running queue card shows it as well", () => {
  const h = harness();
  const card = h.sandbox.renderQueueItem({
    id: 41, name: "clip", status: "downloading", preview: PIXEL,
    progress: { done: 12, total: 100, unit: "pct" },
  });
  assert.equal(images(card).length, 1);
});

test("a queue card without a preview renders no image", () => {
  const h = harness();
  const card = h.sandbox.renderQueueItem({
    id: 42, name: "clip", status: "done", savedPath: "C:\\x\\clip.mp4",
  });
  assert.equal(images(card).length, 0);
});

test("the page screenshot is not rendered as the file's own frame", () => {
  const h = harness();
  const card = h.sandbox.renderQueueItem({
    id: 43, name: "clip", status: "done", savedPath: "C:\\x\\clip.mp4",
    thumb: "data:image/png;base64,PAGESHOT",
  });
  assert.equal(images(card).length, 0,
    "thumb is the page screenshot; only preview is a picture of the file");
});

test("a queue preview that is not an image data URL is refused", () => {
  for (const hostile of ["https://cdn.example/f.png", "javascript:alert(1)", "data:text/html,x", 7]) {
    const h = harness();
    const card = h.sandbox.renderQueueItem({
      id: 44, name: "clip", status: "done", savedPath: "C:\\x\\clip.mp4", preview: hostile,
    });
    assert.equal(images(card).length, 0, "refused: " + String(hostile));
  }
});

// The scheme test is ANCHORED at the start of the value, not a substring
// search. A remote URL is free to CONTAIN "data:image/" anywhere in its path,
// query or fragment, and the attacker picks that text; an unanchored test would
// put that URL in an <img src>, which is a network fetch to the attacker's host
// — the one thing a data: URL can never do.
test("a remote URL that merely contains data:image/ is refused", () => {
  for (const hostile of [
    "https://evil.example/x#data:image/png",
    "https://evil.example/data:image/png/f.jpg",
    "https://evil.example/f?x=data:image/png",
    "  data:image/png;base64,iVBORw0KGgo=",
  ]) {
    const h = harness();
    assert.equal(h.sandbox.previewSrc(hostile), null, "refused: " + hostile);
    const card = h.sandbox.renderQueueItem({
      id: 45, name: "clip", status: "done", savedPath: "C:\\x\\clip.mp4", preview: hostile,
    });
    assert.equal(images(card).length, 0, "no <img src> for: " + hostile);
  }
});

// The value has to BE a string, not merely stringify into one. `preview` rides
// on a page-derived record, so an object carrying its own toString is a shape
// that can arrive here; coercing before the scheme test would let that object
// name the src.
test("an object that stringifies to a data: URL is refused", () => {
  const h = harness();
  const hostile = { toString: function () { return PIXEL; } };
  assert.equal(h.sandbox.previewSrc(hostile), null,
    "only a string is a picture; anything else is refused before the scheme test");
  const card = h.sandbox.renderQueueItem({
    id: 46, name: "clip", status: "done", savedPath: "C:\\x\\clip.mp4", preview: hostile,
  });
  assert.equal(images(card).length, 0);
});

// ---------------------------------------------------------------------------
// 6. How big is it, on the right-hand pane
//
// One story across all three surfaces — this pane, the left pane's rows, and
// the Save As window: an exact transferred total is stated plainly, a figure
// derived from bitrate and duration is prefixed "Est.", and a size that is not
// known yet says "Size unknown" rather than leaving a blank where a size
// belongs. lib/media-size.js is the single place that decides which of the
// three it is.
// ---------------------------------------------------------------------------

test("a finished card with no byte total says the size is unknown", () => {
  const h = harness();
  const card = h.sandbox.renderQueueItem({
    id: 50, name: "clip", status: "done", savedPath: "C:\\x\\clip.mp4",
  });
  assert.match(textOf(card), /Size unknown/,
    "a blank where a size belongs reads as a rendering bug, not as 'not known yet'");
});

test("an estimated size on a finished card stays marked as an estimate", () => {
  const h = harness();
  const card = h.sandbox.renderQueueItem({
    id: 51, name: "clip", status: "done", savedPath: "C:\\x\\clip.mp4",
    sizeBytes: GIG, sizeConfidence: "estimated",
  });
  assert.match(textOf(card), /Est\. 1\.1 GB/);
});

test("an exact transferred total beats a metadata estimate", () => {
  const h = harness();
  const card = h.sandbox.renderQueueItem({
    id: 52, name: "clip", status: "done", savedPath: "C:\\x\\clip.mp4",
    recorded: { bytes: GIG }, sizeBytes: 12345, sizeConfidence: "estimated",
  });
  assert.match(textOf(card), /1\.1 GB/);
  assert.equal(/Est\./.test(textOf(card)), false,
    "the bytes actually written are not an estimate");
});

// Both figures can carry the same "exact" word, and they are not the same
// claim: the record's total is what the server announced about the resource,
// the transferred count is what this machine actually moved. The tie goes to
// the transferred count — that is the whole reason downloadSizeLabel offers it
// at all.
test("a transferred total wins the tie against a record that also says exact", () => {
  const h = harness();
  const card = h.sandbox.renderQueueItem({
    id: 56, name: "clip", status: "done", savedPath: "C:\\x\\clip.mp4",
    recorded: { bytes: GIG }, sizeBytes: 1024, sizeConfidence: "exact",
  });
  assert.match(textOf(card), /1\.1 GB/, "the bytes that landed are the size of the file");
  assert.equal(/1\.0 KB/.test(textOf(card)), false,
    "the announced total must not overwrite the count measured here");
});

// The other direction, so "transferred always wins" cannot be read as
// "transferred is the only thing consulted".
test("a record's exact total is what a card with nothing transferred shows", () => {
  const h = harness();
  const card = h.sandbox.renderQueueItem({
    id: 57, name: "clip", kind: "direct", status: "downloading",
    sizeBytes: GIG, sizeConfidence: "exact",
    progress: { done: 12, total: 100, unit: "pct" },
  });
  assert.match(textOf(card), /1\.1 GB/);
  assert.equal(/Est\./.test(textOf(card)), false);
});

test("a running card states the size it is heading for", () => {
  const h = harness();
  const card = h.sandbox.renderQueueItem({
    id: 53, name: "clip", kind: "direct", status: "downloading",
    sizeBytes: GIG, sizeConfidence: "estimated",
    progress: { done: 12, total: 100, unit: "pct" },
  });
  assert.match(textOf(card), /Est\. 1\.1 GB/);
});

test("a running card with nothing known says so too", () => {
  const h = harness();
  const card = h.sandbox.renderQueueItem({
    id: 54, name: "clip", kind: "direct", status: "downloading",
    progress: { done: 12, total: 100, unit: "pct" },
  });
  assert.match(textOf(card), /Size unknown/);
});

// A live recording already reports the bytes captured so far, and its final
// size is not knowable while it runs. "Size unknown" beside a growing byte
// count would contradict the line under it.
test("a live recording is not labelled Size unknown while it counts bytes", () => {
  const h = harness();
  const card = h.sandbox.renderQueueItem({
    id: 55, name: "clip", live: true, status: "recording",
    progress: { duration: 12, bytes: 1024 },
  });
  assert.equal(/Size unknown/.test(textOf(card)), false);
  assert.match(textOf(card), /1\.0 KB/, "the bytes so far are still there");
});

test("without the size lib a known total still shows and an unknown one still says so", () => {
  const h = harness({ noSizeLib: true });
  assert.equal(h.sandbox.downloadSizeLabel({ recorded: { bytes: GIG } }), "1.1 GB");
  assert.equal(h.sandbox.downloadSizeLabel({}), "Size unknown");
});

// The whole point of the host-side locator: nothing the popup sends can name
// an executable, so no popup bug can turn this into "run this program".
test("no popup path to BadApple ever mentions an executable", () => {
  const source = popupSource();
  const row = extractNamedFunction(source, "fileActionRow");
  assert.equal(/\.exe/i.test(row), false,
    "fileActionRow must not name a program to run");
  assert.equal(/BadApple\.App/i.test(source), false,
    "popup.js must not know where BadApple is installed");
});
