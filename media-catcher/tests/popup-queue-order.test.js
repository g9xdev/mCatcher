"use strict";
/*
 * The Downloads pane, in the order it actually paints.
 *
 * popup-file-actions.test.js runs with renderQueue() stubbed out, so nothing
 * there can see the pane's ordering. This harness lifts renderQueue itself —
 * with the real queueRank and the real applyLiveJobsUpdate — so the sort is
 * exercised through the same path the popup uses.
 *
 * What is pinned: rank still groups the pane (active, held, done, failed) and
 * the newest row is first inside each group, including across the controller
 * snapshots that replace every job object.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadLib, mediaCatcherRoot } = require("./harness/load-lib.js");

const SCHEDULER_STATES = new Set([
  "queued", "waiting_provider", "running", "retry_backoff", "pausing_provider",
  "needs_user", "handing_off_firefox", "handed_to_firefox", "failed",
  "completed", "cancelled",
]);

function popupSource() {
  return fs.readFileSync(path.join(mediaCatcherRoot, "popup", "popup.js"), "utf8");
}

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

function harness(options) {
  options = options || {};
  const queueEl = {
    children: [],
    replaceChildren() { this.children = Array.from(arguments); },
    appendChild(child) { this.children.push(child); return child; },
  };
  const sandbox = {
    console,
    SCHEDULER_STATES,
    McQueueOrder: options.withLib === false ? undefined : loadLib("lib/queue-order.js"),
    queueOrder: null,
    uiSettings: { showRail: true, showQueue: true, enableCasting: false },
    downloadState: new Map(),
    deletedRows: new Set(),
    itemDownloadId: new Map(),
    itemElements: new Map(),
    queueEl,
    queueCountEl: { textContent: "" },
    renderProgress() {},
    // A marker node: the assertions are about which row, in what order.
    renderQueueItem(dl) { return { id: dl.id, rank: dl.__rank }; },
    h(tag, props) { return { tag, props: props || {} }; },
  };
  const pieces = [
    "isSafeOpaqueId", "schedulerStateOf", "queueRank", "queueOrderer",
    "renderQueue", "applyLiveJobsUpdate",
  ].map((name) => extractNamedFunction(popupSource(), name));
  vm.runInNewContext(
    pieces.join("\n") +
      "\nthis.renderQueue = renderQueue;" +
      "\nthis.applyLiveJobsUpdate = applyLiveJobsUpdate;" +
      "\nthis.queueRank = queueRank;",
    sandbox
  );
  return { sandbox, queueEl };
}

function painted(h) {
  return h.queueEl.children.map((child) => child.id);
}

function add(h, dl) {
  h.sandbox.downloadState.set(dl.id, dl);
  h.sandbox.renderQueue();
}

test("the newest download is painted at the top of its group", () => {
  const h = harness();
  add(h, { id: 1, status: "downloading", progress: {} });
  add(h, { id: 2, status: "downloading", progress: {} });
  add(h, { id: 3, status: "downloading", progress: {} });
  assert.deepEqual(painted(h), [3, 2, 1],
    "a download that just started must not land under the older ones");
});

test("rank still decides the block: active above held above done above failed", () => {
  const h = harness();
  add(h, { id: 1, status: "done" });
  add(h, { id: 2, status: "error" });
  add(h, { id: 3, status: "downloading", progress: {} });
  add(h, { id: 4, status: "stopped", live: true });
  add(h, { id: 5, status: "done" });
  add(h, { id: 6, status: "downloading", progress: {} });
  assert.deepEqual(painted(h), [6, 3, 4, 5, 1, 2]);
});

test("a controller snapshot replaces every job object and the order survives", () => {
  const h = harness();
  h.sandbox.applyLiveJobsUpdate({ jobs: [
    { id: "job:a", mediaId: "media:a", state: "running" },
  ] });
  h.sandbox.applyLiveJobsUpdate({ jobs: [
    { id: "job:a", mediaId: "media:a", state: "running" },
    { id: "job:b", mediaId: "media:b", state: "running" },
  ] });
  // Third snapshot: same two jobs, brand new objects, delivered oldest-first.
  h.sandbox.applyLiveJobsUpdate({ jobs: [
    { id: "job:a", mediaId: "media:a", state: "running" },
    { id: "job:b", mediaId: "media:b", state: "running" },
  ] });
  assert.deepEqual(painted(h), ["job:b", "job:a"],
    "arrival order must outlive the objects it was measured on");
});

test("a finished job stays newest among the finished ones", () => {
  const h = harness();
  h.sandbox.applyLiveJobsUpdate({ jobs: [
    { id: "job:a", mediaId: "media:a", state: "completed" },
  ] });
  h.sandbox.applyLiveJobsUpdate({ jobs: [
    { id: "job:a", mediaId: "media:a", state: "completed" },
    { id: "job:b", mediaId: "media:b", state: "running" },
  ] });
  h.sandbox.applyLiveJobsUpdate({ jobs: [
    { id: "job:a", mediaId: "media:a", state: "completed" },
    { id: "job:b", mediaId: "media:b", state: "completed" },
  ] });
  assert.deepEqual(painted(h), ["job:b", "job:a"]);
});

test("the arrival map tracks the live rows rather than growing forever", () => {
  const h = harness();
  for (let i = 1; i <= 50; i += 1) {
    h.sandbox.applyLiveJobsUpdate({ jobs: [
      { id: "job:" + i, mediaId: "media:" + i, state: "running" },
    ] });
  }
  assert.deepEqual(painted(h), ["job:50"]);
  // queueOrderer() memoises the orderer on the sandbox global; its map is the
  // one thing here that could accumulate a row per snapshot.
  assert.equal(h.sandbox.queueOrder.size(), 1);
});

test("a deleted-file mark is forgotten once its row leaves the pane", () => {
  const h = harness();
  add(h, { id: 1, status: "done", savedPath: "C:/x/a.mp4" });
  h.sandbox.deletedRows.add(1);
  h.sandbox.renderQueue();
  assert.equal(h.sandbox.deletedRows.has(1), true, "while the row is still there");
  h.sandbox.downloadState.delete(1);
  h.sandbox.renderQueue();
  assert.equal(h.sandbox.deletedRows.size, 0,
    "a mark per file ever deleted would grow for as long as the popup is open");
});

test("an empty queue still paints its empty card", () => {
  const h = harness();
  h.sandbox.renderQueue();
  assert.equal(h.queueEl.children.length, 1);
  assert.match(String(h.queueEl.children[0].props.class), /queue-empty/);
});

test("the active count is still what the header shows", () => {
  const h = harness();
  add(h, { id: 1, status: "downloading", progress: {} });
  add(h, { id: 2, status: "done" });
  add(h, { id: 3, status: "downloading", progress: {} });
  assert.equal(h.sandbox.queueCountEl.textContent, "2");
});

test("popup.html loads the ordering lib, and loads it before popup.js", () => {
  const html = fs.readFileSync(path.join(mediaCatcherRoot, "popup", "popup.html"), "utf8");
  const lib = html.indexOf("lib/queue-order.js");
  const popup = html.indexOf("popup.js");
  assert.ok(lib > 0, "the popup must actually load lib/queue-order.js");
  assert.ok(lib < popup, "a module read at popup.js load time has to come first");
});

test("without the ordering lib the pane still paints, grouped by rank", () => {
  const h = harness({ withLib: false });
  add(h, { id: 1, status: "done" });
  add(h, { id: 2, status: "downloading", progress: {} });
  assert.deepEqual(painted(h), [2, 1]);
});
