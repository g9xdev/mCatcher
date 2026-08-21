"use strict";
//
// capture-preview: a per-item frame, asked for on demand.
//
// What this adds over the `thumb` that already exists is NOT the kind of
// picture — that was worth checking rather than assuming. tabThumbs is already
// a video frame: content.js's captureThumb() finds the largest decoded
// <video>, draws it to a canvas and encodes JPEG at quality 0.65.
//
// What `thumb` is not is per-item or on-demand. It is ONE picture per TAB, set
// on the content script's own schedule, and decorate() attaches that same
// picture to every row of the tab. `preview` is keyed by itemIdentity and
// captured when the popup asks. On a tab with a single video the two come from
// the same element and will look alike; the case where they genuinely differ
// is a row whose frame comes from the helper reading a file already on disk,
// where no page video exists at all.
//
// The two fields therefore stay separate. Writing a per-item frame into
// `thumb` would put one row's picture on every row of its tab.
//
const test = require("node:test");
const assert = require("node:assert/strict");
const { readyHarness, settle, JPEG } = require("./harness/background-harness.js");

// One tab, one direct item, and a tab-scoped picture to fall back to.
function seedTab(h, tabId, tabPicture) {
  h.evalInBackground(
    "mediaByTab.set(" + tabId + ", new Map([['k', " +
    "{ url: 'https://x/a.mp4', kind: 'direct', ts: 1 }]]))");
  if (tabPicture) {
    h.evalInBackground("tabThumbs.set(" + tabId + ", " + JSON.stringify(tabPicture) + ")");
  }
}

async function rowFor(h, tabId) {
  const res = await h.send({ type: "get-media", tabId }, {});
  return res.items.find((i) => i.url === "https://x/a.mp4");
}

const TAB_PICTURE = "data:image/jpeg;base64,dGFiLXNjb3BlZHBpY3R1cmU=";

// ---------------------------------------------------------------------------

test("capture-preview asks the tab's content script for a frame", async () => {
  const h = await readyHarness();
  h.setContentReply(7, { ok: true, dataUrl: JPEG, why: null });
  const answer = await h.send(
    { type: "capture-preview", identity: "url:https://x/a.mp4", tabId: 7 }, {});
  assert.equal(answer.ok, true);

  const asked = h.tabMessages.filter((m) => m.message && m.message.type === "capture-frame");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].tabId, 7);
  assert.deepEqual(Object.keys(asked[0].message), ["type"],
    "the content script is asked for a frame and told nothing else");
});

test("a captured frame reaches the popup as `preview`, beside and not instead of `thumb`", async () => {
  const h = await readyHarness();
  h.setContentReply(7, { ok: true, dataUrl: JPEG, why: null });
  seedTab(h, 7, TAB_PICTURE);

  await h.send({ type: "capture-preview", identity: "url:https://x/a.mp4", tabId: 7 }, {});
  const row = await rowFor(h, 7);
  assert.ok(row, "the row is listed");
  assert.equal(row.preview, JPEG, "the per-item frame");
  assert.equal(row.thumb, TAB_PICTURE,
    "the per-tab picture is a separate field and is not overwritten");
});

test("an item with no capture yet carries preview: null rather than no field", async () => {
  const h = await readyHarness();
  seedTab(h, 7, TAB_PICTURE);
  const row = await rowFor(h, 7);
  assert.equal(Object.prototype.hasOwnProperty.call(row, "preview"), true);
  assert.equal(row.preview, null);
});

test("a tainted canvas falls back to the tab's picture rather than failing", async () => {
  const h = await readyHarness();
  h.setContentReply(7, { ok: false, dataUrl: null, why: "tainted" });
  seedTab(h, 7, TAB_PICTURE);

  const answer = await h.send(
    { type: "capture-preview", identity: "url:https://x/a.mp4", tabId: 7 }, {});
  assert.equal(answer.ok, true,
    "a cross-origin video is the ordinary case for this extension, not a failure");
  assert.equal((await rowFor(h, 7)).preview, TAB_PICTURE);
});

test("tainted with no tab picture to fall back to answers plainly", async () => {
  const h = await readyHarness();
  h.setContentReply(7, { ok: false, dataUrl: null, why: "tainted" });
  seedTab(h, 7, null);
  const answer = await h.send(
    { type: "capture-preview", identity: "url:https://x/a.mp4", tabId: 7 }, {});
  assert.equal(answer.ok, false);
  assert.equal(typeof answer.error, "string");
  assert.equal((await rowFor(h, 7)).preview, null);
});

test("a dataUrl the content script invented is refused before it is stored", async () => {
  // The content script runs in the page's world. What it hands back is data.
  const h = await readyHarness();
  seedTab(h, 7, null);
  const hostile = [
    "javascript:alert(1)",
    "https://evil.example/x.jpg",
    "data:text/html,<script>alert(1)</script>",
    "data:image/svg+xml,<svg onload=alert(1)/>",
    "data:image/jpeg;base64," + "A".repeat(400000),
    "data:image/jpeg;base64,not base64 at all",
  ];
  for (const bad of hostile) {
    h.setContentReply(7, { ok: true, dataUrl: bad, why: null });
    const answer = await h.send(
      { type: "capture-preview", identity: "url:https://x/a.mp4", tabId: 7 }, {});
    assert.equal(answer.ok, false, bad.slice(0, 40));
    assert.equal((await rowFor(h, 7)).preview, null, bad.slice(0, 40));
  }
});

test("a hostile dataUrl does not fall back to the tab picture either", async () => {
  // Refusing the string and then quietly showing something else would make a
  // rejected capture indistinguishable from a taint.
  const h = await readyHarness();
  seedTab(h, 7, TAB_PICTURE);
  h.setContentReply(7, { ok: true, dataUrl: "javascript:alert(1)", why: null });
  const answer = await h.send(
    { type: "capture-preview", identity: "url:https://x/a.mp4", tabId: 7 }, {});
  assert.equal(answer.ok, false);
  assert.equal((await rowFor(h, 7)).preview, null);
});

test("a second request for the same identity is answered from the cache", async () => {
  const h = await readyHarness();
  h.setContentReply(7, { ok: true, dataUrl: JPEG, why: null });
  seedTab(h, 7, null);
  await h.send({ type: "capture-preview", identity: "url:https://x/a.mp4", tabId: 7 }, {});
  await h.send({ type: "capture-preview", identity: "url:https://x/a.mp4", tabId: 7 }, {});
  const asked = h.tabMessages.filter((m) => m.message && m.message.type === "capture-frame");
  assert.equal(asked.length, 1, "the page was disturbed once, not twice");
});

test("a different identity on the same tab is captured separately", async () => {
  const h = await readyHarness();
  h.setContentReply(7, { ok: true, dataUrl: JPEG, why: null });
  await h.send({ type: "capture-preview", identity: "url:https://x/a.mp4", tabId: 7 }, {});
  await h.send({ type: "capture-preview", identity: "id:media-2", tabId: 7 }, {});
  assert.equal(h.tabMessages.filter((m) => m.message.type === "capture-frame").length, 2);
});

test("a tab with no content script answers rather than throwing", async () => {
  const h = await readyHarness();     // no reply registered: sendMessage rejects
  const answer = await h.send(
    { type: "capture-preview", identity: "url:https://x/a.mp4", tabId: 7 }, {});
  assert.equal(answer.ok, false);
  assert.equal(typeof answer.error, "string");
});

test("capture-preview refuses a malformed identity or tabId without asking the page", async () => {
  const h = await readyHarness();
  h.setContentReply(7, { ok: true, dataUrl: JPEG, why: null });
  const bad = [
    [null, 7], ["", 7], [42, 7], [{}, 7],
    ["url:https://x/a.mp4", "7"], ["url:https://x/a.mp4", null],
    ["url:https://x/a.mp4", 1.5], ["x".repeat(5000), 7],
  ];
  for (const pair of bad) {
    const answer = await h.send(
      { type: "capture-preview", identity: pair[0], tabId: pair[1] }, {});
    assert.equal(answer.ok, false, String(pair[0]).slice(0, 20) + " / " + String(pair[1]));
  }
  assert.equal(h.tabMessages.filter((m) => m.message.type === "capture-frame").length, 0,
    "nothing malformed reached a page");
});

test("the number of pages being captured at once is bounded", async () => {
  const h = await readyHarness();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = [];
  const tabs = [1, 2, 3, 4, 5, 6, 7, 8];
  for (const tid of tabs) {
    h.setContentReply(tid, () => {
      started.push(tid);
      return gate.then(() => ({ ok: true, dataUrl: JPEG, why: null }));
    });
  }
  const all = tabs.map((tid) => h.send(
    { type: "capture-preview", identity: "url:https://x/" + tid + ".mp4", tabId: tid }, {}));
  await settle();
  assert.equal(started.length > 0, true, "some capture did start");
  assert.equal(started.length < tabs.length, true,
    "eight pages were all told to encode a JPEG at once: " + started.length);
  release();
  const answers = await Promise.all(all);
  assert.equal(answers.every((a) => a && a.ok === true), true,
    "every queued request still got its answer");
  assert.equal(started.length, tabs.length, "and every one eventually ran");
});

test("previews are dropped when their tab goes away", async () => {
  const h = await readyHarness();
  h.setContentReply(7, { ok: true, dataUrl: JPEG, why: null });
  seedTab(h, 7, null);
  await h.send({ type: "capture-preview", identity: "url:https://x/a.mp4", tabId: 7 }, {});
  assert.equal(h.evalInBackground("previewByIdentity.size"), 1);
  h.closeTab(7);   // the real tabs.onRemoved listener background.js registered
  assert.equal(h.evalInBackground("previewByIdentity.size"), 0,
    "a closed tab's pictures do not sit in memory for the life of the session");
});

test("the preview store is bounded, so a long session cannot grow it without limit", async () => {
  const h = await readyHarness();
  h.setContentReply(7, { ok: true, dataUrl: JPEG, why: null });
  for (let i = 0; i < 300; i += 1) {
    await h.send({ type: "capture-preview", identity: "id:media-" + i, tabId: 7 }, {});
  }
  const size = h.evalInBackground("previewByIdentity.size");
  assert.equal(size < 300, true, "every capture was retained: " + size);
  assert.equal(size > 0, true);
});
