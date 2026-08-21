"use strict";
//
// The preview on a DOWNLOAD row, and which frame carries it.
//
// This needed establishing rather than assuming, because the two popup-facing
// frames do not travel the same way:
//
//   live-jobs-updated  IS projected — background-adapters.js builds it through
//                      McPrivacy.projectPopupJob.
//   download-update    is NOT. background.js broadcasts the raw `dl` object.
//   get-media items[]  is NOT either. decorate() spreads the raw item.
//
// So `preview` on a download row never passes projectPopupJob, and an
// allowlist entry there would do nothing for it. The check that matters is at
// INGRESS instead — McPrivacy.isSafePreviewDataUrl, applied where a picture
// arrives from the content script or the helper, both of which are outside
// this file's trust. These tests pin that the raw broadcast carries the field
// and that only a validated string can have reached it.
//
const test = require("node:test");
const assert = require("node:assert/strict");
const { readyHarness, settle, JPEG } = require("./harness/background-harness.js");

// A download row that names the same media as the item the popup captured.
// popup.js's downloadItemIdentity() reads `mediaId` first, then `url`.
function seedRow(h, over) {
  const row = Object.assign({
    id: 77, name: "a.mp4", kind: "direct", native: true, status: "downloading",
    url: "https://x/a.mp4",
  }, over || {});
  h.evalInBackground("activeDownloads.set(" + row.id + ", " + JSON.stringify(row) + ")");
  return row.id;
}

function lastUpdate(h, id) {
  const all = h.updatesFor(id);
  return all.length ? all[all.length - 1].download : null;
}

test("download-update is the RAW download object, not a privacy projection", async () => {
  // Stated as a test because the answer decides where validation belongs. A
  // field only projectPopupJob would strip is not protected on this path.
  const h = await readyHarness();
  const id = seedRow(h, { secretish: "https://cdn.example/x?token=SECRET_ABC" });
  h.fromHost({ type: "started", id });
  await settle();
  const sent = lastUpdate(h, id);
  assert.ok(sent, "the row was broadcast");
  assert.equal(sent.secretish, "https://cdn.example/x?token=SECRET_ABC",
    "an arbitrary field survives, so this frame is unprojected");
});

test("a captured preview lands on the matching download row and is rebroadcast", async () => {
  const h = await readyHarness();
  const id = seedRow(h);
  h.setContentReply(7, { ok: true, dataUrl: JPEG, why: null });

  await h.send({ type: "capture-preview", identity: "url:https://x/a.mp4", tabId: 7 }, {});
  await settle();

  const sent = lastUpdate(h, id);
  assert.ok(sent, "the row was rebroadcast when its picture arrived");
  assert.equal(sent.preview, JPEG);
});

test("a row is matched by mediaId when it has one", async () => {
  const h = await readyHarness();
  const id = seedRow(h, { id: 78, mediaId: "media-abc", url: "https://x/other.mp4" });
  h.setContentReply(7, { ok: true, dataUrl: JPEG, why: null });

  await h.send({ type: "capture-preview", identity: "id:media-abc", tabId: 7 }, {});
  await settle();
  assert.equal(lastUpdate(h, id).preview, JPEG);
});

test("a preview for a different item does not land on this row", async () => {
  const h = await readyHarness();
  const id = seedRow(h);
  h.setContentReply(7, { ok: true, dataUrl: JPEG, why: null });

  await h.send({ type: "capture-preview", identity: "url:https://x/UNRELATED.mp4", tabId: 7 }, {});
  await settle();
  const sent = lastUpdate(h, id);
  assert.equal(sent === null || !sent.preview, true,
    "one row's picture reached another row");
});

test("a refused dataUrl never reaches a download row", async () => {
  const h = await readyHarness();
  const id = seedRow(h);
  h.setContentReply(7, { ok: true, dataUrl: "javascript:alert(1)", why: null });

  await h.send({ type: "capture-preview", identity: "url:https://x/a.mp4", tabId: 7 }, {});
  await settle();
  const sent = lastUpdate(h, id);
  assert.equal(sent === null || !sent.preview, true);
});

test("a row created after the capture carries the picture on its FIRST broadcast", async () => {
  // The ordering that actually happens: the popup renders a row, captures its
  // preview, and only then does the user click download.
  const h = await readyHarness();
  h.setContentReply(7, { ok: true, dataUrl: JPEG, why: null });
  await h.send({ type: "capture-preview", identity: "url:https://x/pget.mp4", tabId: 7 }, {});

  // Drive a real row-creation path rather than calling the helper: pget's
  // first progress frame builds a row from its fallback entry.
  h.evalInBackground(
    "pgetFallback.set(91, { finalName: 'pget.mp4', item: { url: 'https://x/pget.mp4' } })");
  h.fromHost({ type: "pget-progress", id: 91, bytes: 10, total: 100 });
  await settle();

  const updates = h.updatesFor(91);
  assert.equal(updates.length > 0, true, "the row was broadcast");
  assert.equal(updates[0].download.preview, JPEG,
    "the picture was there from the first frame, not only after a later one");
});

test("every row-creation site offers the new row the stored picture", () => {
  // pushPreviewToDownloads covers a picture arriving while a row is live. The
  // other direction — a picture captured BEFORE the download started — is a
  // one-line call at each place a row is created, and the pget path below is
  // the only one these tests drive end to end. This reads the source so that
  // dropping the call from any of the others is caught rather than silent.
  const fs = require("node:fs");
  const path = require("node:path");
  const { mediaCatcherRoot } = require("./harness/load-lib.js");
  const src = fs.readFileSync(path.join(mediaCatcherRoot, "background.js"), "utf8");
  const lines = src.split(/\r?\n/);

  const sites = [];
  lines.forEach((line, i) => {
    if (/^\s*activeDownloads\.set\(/.test(line)) sites.push(i);
  });
  assert.equal(sites.length >= 5, true, "found the creation sites: " + sites.length);
  for (const i of sites) {
    assert.match(lines[i + 1], /attachPreviewToDownload\(/,
      "no attach after activeDownloads.set at background.js:" + (i + 1) +
      " — a preview captured before this row existed would not reach it");
  }
});
