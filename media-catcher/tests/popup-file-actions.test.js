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
    PopupUI: UI,
    helperStatus: options.helperStatus || { state: "ready" },
    castUiReady: options.castUiReady === true,
    downloadState: new Map(),
    renderQueue() {},
    openCastPicker() {},
    renderNeedsUserActions() {},
    send(message) { sent.push(message); return Promise.resolve({ ok: true }); },
    api: { downloads: { open() {}, show() {}, pause() {}, resume() {} } },
    h: node,
  };
  const pieces = [
    "sizeBytesOf", "humanSize", "pad2", "fmtDuration", "h265Note", "qualityLabel",
    "queueSpec", "statusWord", "schedulerStateOf", "formatJobStatusLabel",
    "helperOn", "openDlFile", "fileActionRow", "renderLiveProgress",
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
  return { sandbox, el, slot, sent };
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

test("a helper-saved file offers Open and Folder, enabled", () => {
  const h = harness();
  const row = h.sandbox.fileActionRow({
    id: 6, name: "clip", status: "done", savedPath: "C:\\x\\clip.mp4",
  });
  const enabled = buttons(row).filter((b) => !b.props.disabled).map((b) => b.props.text);
  assert.deepEqual(enabled, ["▶ Open", "Folder"]);
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
