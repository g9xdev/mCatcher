"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");

function makeHarness(overrides) {
  const posted = [];
  const published = [];
  const counts = { firefox: 0 };
  const tokens = { media: 0, job: 0, attempt: 0 };
  const options = {
    maxConcurrent: 1,
    segmentConcurrency: 4,
    retries: 1,
    now: () => 1_000_000,
    randomToken(namespace) {
      tokens[namespace] = (tokens[namespace] || 0) + 1;
      return namespace[0] + tokens[namespace];
    },
    postNative(command) { posted.push(command); return command; },
    downloadsDownload() { counts.firefox += 1; },
    createObjectURL: () => "blob:test",
    revokeObjectURL() {},
    fetchArrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    assembleMedia: () => Promise.resolve(null),
    isPopupSender: () => true,
    getEffectiveDestinationDirectory: () => "D:\\Effective",
    publishDetection() {},
    publishJobs(rows) { published.push(rows); },
    persistHistory() {},
    reportDiagnostic() {},
  };
  Object.assign(options, overrides || {});
  return { ctrl: loadLib("lib/background-adapters.js").createBackgroundAdapters(options), posted, published, counts };
}

function intent(filename, destinationDirectory) {
  return { requestedFilename: filename, destinationDirectory, saveMode: "save-as", userSelectedFirefox: false, userActionToken: "proof-private", createdAt: "2026-08-12T12:00:00.000Z" };
}

function capture(ctrl, suffix) {
  return ctrl.captureDomMedia({
    mediaUrl: "https://cdn-" + suffix + ".example/video.mp4?sig=private-" + suffix,
    mediaOrigin: "https://cdn-" + suffix + ".example",
    contentDisposition: null,
    referrerUrl: "https://provider-" + suffix + ".example/watch",
    frameOrigin: "https://provider-" + suffix + ".example",
    ts: 1_000_000,
    snapshot: { documentId: "doc-" + suffix, tabId: Number(suffix.replace(/\D/g, "")) || 1, frameId: 0, pageUrl: "https://provider-" + suffix + ".example/watch", topLevelPageUrl: "https://provider-" + suffix + ".example/watch", documentNonce: "nonce-" + suffix, candidates: [{ kind: "visible-filename", value: suffix + ".mp4" }], capturedAt: "2026-08-12T12:00:00.000Z" },
    transport: { mediaKind: "direct", requestHeaders: null },
  });
}

async function enqueue(h, suffix, filename, destination) {
  const mediaId = capture(h.ctrl, suffix);
  return h.ctrl.enqueueDownload({ type: "save-as-download", tabId: Number(suffix.replace(/\D/g, "")) || 1, item: { id: mediaId }, intent: intent(filename, destination) }, {});
}

function job(h, id) { return h.ctrl.popupJobs().find((row) => row.id === id); }
function assertSafe(value) {
  const json = JSON.stringify(value);
  for (const secret of ["https://", "private", "proof-private", "attemptToken", "error"]) assert.equal(json.includes(secret), false, "safe JSON omits " + secret);
  assert.ok(Object.isFrozen(value));
}

test("running cancel posts one fenced command and duplicate is inert", async () => {
  const h = makeHarness();
  const first = await enqueue(h, "a1", "requested-a.mp4", "D:\\Chosen");
  const before = h.published.length;
  const cancelled = await h.ctrl.cancel(first.id);
  assert.deepEqual(h.posted.slice(1), [{ cmd: "pget-cancel", id: first.id, attemptToken: h.posted[0].attemptToken }]);
  assert.equal(cancelled.state, "running");
  assertSafe(cancelled);
  assert.equal(await h.ctrl.cancel(first.id), false);
  assert.equal(h.posted.length, 2);
  assert.equal(h.published.length, before);
});

test("authenticated cancelled result settles a cancelled job and admits its peer", async () => {
  const h = makeHarness();
  const first = await enqueue(h, "b1", "one.mp4", "D:\\Chosen");
  const second = await enqueue(h, "b2", "two.mp4", "D:\\Chosen");
  const token = h.posted[0].attemptToken;
  await h.ctrl.cancel(first.id);
  assert.equal(await h.ctrl.handleNativeMessage({ type: "pget-result", id: first.id, attemptToken: token, status: "cancelled", mode: "multi-range", partState: "partial", failureCategory: "cancelled" }), true);
  assert.equal(job(h, first.id).state, "cancelled");
  assert.equal(job(h, second.id).state, "running");
  assert.equal(h.posted.filter((command) => command.cmd === "pget").length, 2);
});

test("cancel post rejection preserves its error and settles through unavailable without Firefox", async () => {
  const error = new Error("native unavailable private");
  let calls = 0;
  const h = makeHarness({ postNative(command) { calls += 1; if (calls === 2) throw error; return command; } });
  const first = await enqueue(h, "c1", "one.mp4", "D:\\Chosen");
  await assert.rejects(h.ctrl.cancel(first.id), (caught) => caught === error);
  assert.equal(job(h, first.id).state, "cancelled");
  assert.equal(h.counts.firefox, 0);
  assertSafe(h.published[h.published.length - 1]);
});

test("queued and needs-user cancellation is immediate while invalid ids are inert", async () => {
  const h = makeHarness();
  const first = await enqueue(h, "d1", "one.mp4", "D:\\Chosen");
  const second = await enqueue(h, "d2", "two.mp4", "D:\\Chosen");
  const baseline = { posts: h.posted.length, publications: h.published.length };
  const cancelled = await h.ctrl.cancel(second.id);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(h.posted.length, baseline.posts);
  await h.ctrl.cancel(first.id);
  const afterTerminalCancel = h.posted.length;
  for (const id of ["", " ", null, {}, "job:missing:1", first.id]) assert.equal(await h.ctrl.cancel(id), false);
  assert.equal(h.posted.length, afterTerminalCancel);
});

test("manual retry from needs_user posts a fresh pget preserving requested filename and destination", async () => {
  const h = makeHarness();
  const first = await enqueue(h, "e1", "exact requested.mp4", "D:\\Chosen");
  await h.ctrl.helperDisconnected();
  const retry = await h.ctrl.manualRetry(first.id);
  assert.equal(retry.state, "running");
  assert.equal(h.posted.length, 2);
  assert.equal(h.posted[1].cmd, "pget");
  assert.notEqual(h.posted[1].attemptToken, h.posted[0].attemptToken);
  assert.equal(h.posted[1].name, "exact requested.mp4");
  assert.equal(h.posted[1].dir, "D:\\Chosen");
  assert.equal(h.counts.firefox, 0);
});

test("manual retry rejection parks safely and a later explicit retry succeeds", async () => {
  const error = new Error("retry transport private");
  let calls = 0;
  const h = makeHarness({ postNative(command) { calls += 1; if (calls === 2) throw error; return command; } });
  const first = await enqueue(h, "f1", "retry.mp4", "D:\\Chosen");
  await h.ctrl.helperDisconnected();
  await assert.rejects(h.ctrl.manualRetry(first.id), (caught) => caught === error);
  assert.equal(job(h, first.id).state, "needs_user");
  assertSafe(h.published[h.published.length - 1]);
  const retry = await h.ctrl.manualRetry(first.id);
  assert.equal(retry.state, "running");
});

test("manual retry is inert outside needs_user", async () => {
  const h = makeHarness();
  const first = await enqueue(h, "g1", "one.mp4", "D:\\Chosen");
  const before = h.posted.length;
  for (const id of [first.id, "job:missing:1", "", null]) assert.equal(await h.ctrl.manualRetry(id), false);
  assert.equal(h.posted.length, before);
});

test("helper disconnect parks each active job including newly admitted peers with one safe publication", async () => {
  const h = makeHarness({ maxConcurrent: 1 });
  const first = await enqueue(h, "h1", "one.mp4", "D:\\Chosen");
  const second = await enqueue(h, "h2", "two.mp4", "D:\\Chosen");
  const beforePosts = h.posted.length;
  const beforePublications = h.published.length;
  const changed = await h.ctrl.helperDisconnected();
  assert.deepEqual(changed.map((row) => row.id).sort(), [first.id, second.id].sort());
  assert.equal(job(h, first.id).state, "needs_user");
  assert.equal(job(h, second.id).state, "needs_user");
  assert.equal(h.posted.length, beforePosts);
  assert.equal(h.counts.firefox, 0);
  assert.equal(h.published.length, beforePublications + 1);
  changed.forEach(assertSafe);
});
