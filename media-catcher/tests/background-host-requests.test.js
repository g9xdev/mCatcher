"use strict";
//
// Three new host round trips — delete, badapple-stop, thumb — and the one
// property they all have to hold.
//
// background.js settles a host frame like this:
//
//     const dl = activeDownloads.get(msg.id);
//     if (!dl && msg.type === "error") { ...log...; return; }
//     if (!dl) return;
//     ...  else if (msg.type === "error") { dl.status = "error"; }
//
// So ANY frame that reaches that lookup carrying an id is interpreted as a
// statement about a download row. A refusal keyed on a download id therefore
// marks the download FAILED — for a delete that means a file that is still
// on disk, and a row that says it is not.
//
// The file already learned this once, for beams, and wrote it down at the
// guard: "Checked BEFORE the row lookup because a beam id is not a download
// id". These three verbs follow that same shape: a dedicated request id,
// minted with a prefix so it cannot collide with a download id (those are
// bare numbers from ++downloadCounter), settled before the row lookup.
//
// The tests below drive the real background.js in a vm and assert on the two
// things a caller can actually observe: what came back to the popup, and what
// happened to the rows.
//
const test = require("node:test");
const assert = require("node:assert/strict");
const { readyHarness, createHarness, seedDownload, settle } =
  require("./harness/background-harness.js");

// ---------------------------------------------------------------------------
// The shared property: a request id is not a download id
// ---------------------------------------------------------------------------

test("the three verbs mint prefixed request ids, which bare-numeric download ids cannot collide with", async () => {
  const h = await readyHarness();
  // Fired, not awaited: neither request is answered here, and what this test
  // reads is the frame that went out, not a reply that never comes.
  const quiet = () => {};
  h.send({ type: "delete-file", downloadId: 1, path: "C:\\v\\a.mp4" }, {}).catch(quiet);
  h.send({ type: "badapple-stop" }, {}).catch(quiet);
  await settle();

  const del = h.lastHost("delete");
  const stop = h.lastHost("badapple-stop");
  assert.ok(del, "a delete frame reached the host");
  assert.ok(stop, "a badapple-stop frame reached the host");
  for (const frame of [del, stop]) {
    assert.equal(typeof frame.reqId, "string");
    assert.equal(/^[0-9]+$/.test(frame.reqId), false,
      "a bare-numeric reqId is exactly what could name a download row: " + frame.reqId);
    assert.equal(frame.reqId.length > 0, true);
    assert.equal(Object.prototype.hasOwnProperty.call(frame, "id"), false,
      "no `id` field, so the row lookup has nothing to find");
  }
  assert.notEqual(del.reqId, stop.reqId, "two requests are two ids");
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

test("a delete carries the path and settles its caller on the host's ok", async () => {
  const h = await readyHarness();
  const pending = h.send({ type: "delete-file", downloadId: 4242, path: "C:\\v\\a.mp4" }, {});
  await settle();

  const frame = h.lastHost("delete");
  assert.deepEqual(Object.keys(frame).sort(), ["cmd", "path", "reqId"]);
  assert.equal(frame.cmd, "delete");
  assert.equal(frame.path, "C:\\v\\a.mp4");

  h.fromHost({ type: "delete-result", reqId: frame.reqId, ok: true, error: null });
  assert.deepEqual(await pending, { ok: true, error: null });
});

test("a REFUSED delete answers the caller and leaves the download row alone", async () => {
  const h = await readyHarness();
  const id = seedDownload(h);
  const before = h.updatesFor(id).length;

  const pending = h.send({ type: "delete-file", downloadId: id, path: "C:\\v\\a.mp4" }, {});
  await settle();
  const frame = h.lastHost("delete");

  h.fromHost({ type: "delete-result", reqId: frame.reqId, ok: false, error: "File is in use." });
  const answer = await pending;
  assert.equal(answer.ok, false);
  assert.equal(answer.error, "File is in use.");

  // The file is still there, so the download that produced it is still done.
  // This is the assertion the whole shape exists for.
  const after = h.updatesFor(id);
  assert.equal(after.length, before,
    "a refused delete rebroadcast the row, which means it touched it");
  for (const update of after) {
    assert.notEqual(update.download.status, "error",
      "a refused delete marked a still-present download as failed");
  }
});

test("a delete result is claimed before the row lookup, so an id-shaped reqId cannot corrupt a row", async () => {
  const h = await readyHarness();
  const id = seedDownload(h);

  const pending = h.send({ type: "delete-file", downloadId: id, path: "C:\\v\\a.mp4" }, {});
  await settle();
  const frame = h.lastHost("delete");

  // The host echoes the reqId AND, being a generic error emitter, also names
  // the row. The result frame must be claimed on its way past, before
  // `activeDownloads.get(msg.id)` gets a chance to read that `id`.
  h.fromHost({ type: "delete-result", reqId: frame.reqId, ok: false, error: "Denied.", id });
  const answer = await pending;
  assert.equal(answer.ok, false);

  for (const update of h.updatesFor(id)) {
    assert.notEqual(update.download.status, "error");
  }
});

test("a second frame on a claimed delete reqId does not answer twice", async () => {
  const h = await readyHarness();
  const pending = h.send({ type: "delete-file", downloadId: 1, path: "C:\\v\\a.mp4" }, {});
  await settle();
  const frame = h.lastHost("delete");

  h.fromHost({ type: "delete-result", reqId: frame.reqId, ok: true, error: null });
  assert.deepEqual(await pending, { ok: true, error: null });
  // Claimed once: the entry is gone, so this is a frame naming nothing.
  h.fromHost({ type: "delete-result", reqId: frame.reqId, ok: false, error: "late" });
  await settle();
});

test("a delete with no helper answers rather than hanging", async () => {
  const h = createHarness();
  await settle();                       // never made ready
  const answer = await h.send({ type: "delete-file", downloadId: 1, path: "C:\\v\\a.mp4" }, {});
  assert.equal(answer.ok, false);
  assert.equal(typeof answer.error, "string");
  assert.equal(h.lastHost("delete"), null, "nothing was posted to an absent port");
});

test("a delete without a usable path is refused here, not forwarded", async () => {
  const h = await readyHarness();
  for (const bad of [undefined, null, "", 42, {}]) {
    const answer = await h.send({ type: "delete-file", downloadId: 1, path: bad }, {});
    assert.equal(answer.ok, false, String(bad));
  }
  assert.equal(h.lastHost("delete"), null);
});

// ---------------------------------------------------------------------------
// badapple-stop
// ---------------------------------------------------------------------------

test("badapple-stop carries only its reqId and settles on the host's answer", async () => {
  const h = await readyHarness();
  const pending = h.send({ type: "badapple-stop" }, {});
  await settle();

  const frame = h.lastHost("badapple-stop");
  assert.deepEqual(Object.keys(frame).sort(), ["cmd", "reqId"],
    "the stop frame has no path and no url");

  h.fromHost({ type: "badapple-stop-result", reqId: frame.reqId, ok: true, error: null });
  assert.deepEqual(await pending, { ok: true, error: null });
});

test("a refused badapple-stop reaches its caller and no download row", async () => {
  const h = await readyHarness();
  const id = seedDownload(h);
  const before = h.updatesFor(id).length;

  const pending = h.send({ type: "badapple-stop" }, {});
  await settle();
  const frame = h.lastHost("badapple-stop");
  h.fromHost({ type: "badapple-stop-result", reqId: frame.reqId, ok: false, error: "Not running." });

  const answer = await pending;
  assert.equal(answer.ok, false);
  assert.equal(answer.error, "Not running.");
  assert.equal(h.updatesFor(id).length, before);
});

// ---------------------------------------------------------------------------
// thumb  (host-side, from a LOCAL PATH — never a url)
// ---------------------------------------------------------------------------

test("a thumb request names a local path and an offset, and never a url", async () => {
  const h = await readyHarness();
  // Fired, not awaited — this test reads the outgoing frame.
  h.send({ type: "thumb-file", path: "C:\\v\\a.mp4", atSeconds: 12 }, {}).catch(() => {});
  await settle();

  const frame = h.lastHost("thumb");
  assert.ok(frame, "a thumb frame reached the host");
  assert.deepEqual(Object.keys(frame).sort(), ["atSeconds", "cmd", "path", "reqId"]);
  assert.equal(frame.path, "C:\\v\\a.mp4");
  assert.equal(frame.atSeconds, 12);
  assert.equal(Object.prototype.hasOwnProperty.call(frame, "url"), false,
    "the host must never be handed a stream address to fetch");
});

test("a thumb-result carrying a picture settles its caller", async () => {
  const h = await readyHarness();
  const pending = h.send({ type: "thumb-file", path: "C:\\v\\a.mp4", atSeconds: 3 }, {});
  await settle();
  const frame = h.lastHost("thumb");

  const dataUrl = "data:image/jpeg;base64,AAAA";
  h.fromHost({ type: "thumb-result", reqId: frame.reqId, dataUrl, atSeconds: 3, error: null });
  const answer = await pending;
  assert.equal(answer.ok, true);
  assert.equal(answer.dataUrl, dataUrl);
});

test("a thumb-result that is not a picture answers without one and touches no row", async () => {
  const h = await readyHarness();
  const id = seedDownload(h);
  const before = h.updatesFor(id).length;

  const pending = h.send({ type: "thumb-file", path: "C:\\v\\a.mp4", atSeconds: 3 }, {});
  await settle();
  const frame = h.lastHost("thumb");
  h.fromHost({ type: "thumb-result", reqId: frame.reqId, dataUrl: null, atSeconds: 3,
    error: "ffmpeg missing" });

  const answer = await pending;
  assert.equal(answer.ok, false);
  assert.equal(answer.dataUrl, null);
  assert.equal(h.updatesFor(id).length, before);
});

test("a thumb-result whose dataUrl is not a validated jpeg data URL is dropped", async () => {
  const h = await readyHarness();
  const pending = h.send({ type: "thumb-file", path: "C:\\v\\a.mp4", atSeconds: 3 }, {});
  await settle();
  const frame = h.lastHost("thumb");

  // The host is a separate process; what it returns is still checked here
  // before it becomes a value the popup renders.
  h.fromHost({ type: "thumb-result", reqId: frame.reqId,
    dataUrl: "javascript:alert(1)", atSeconds: 3, error: null });
  const answer = await pending;
  assert.equal(answer.ok, false);
  assert.equal(answer.dataUrl, null);
});

// ---------------------------------------------------------------------------
// Nothing new leaks into the generic lanes
// ---------------------------------------------------------------------------

test("an ordinary host error naming a live row still fails that row", async () => {
  // The guard added for these verbs must be narrow enough that the existing
  // behaviour it sits in front of is unchanged.
  const h = await readyHarness();
  const id = seedDownload(h);
  h.fromHost({ type: "error", id, error: "disk full" });
  await settle();

  const updates = h.updatesFor(id);
  assert.equal(updates[updates.length - 1].download.status, "error",
    "the pre-existing error lane still marks its row");
});

test("a result frame naming an unknown reqId is ignored quietly", async () => {
  const h = await readyHarness();
  const id = seedDownload(h);
  const before = h.updatesFor(id).length;
  for (const type of ["delete-result", "badapple-stop-result", "thumb-result"]) {
    h.fromHost({ type, reqId: "no-such-request", ok: false, error: "x", dataUrl: null });
  }
  await settle();
  assert.equal(h.updatesFor(id).length, before);
});

// ---------------------------------------------------------------------------
// What settles a request the helper never answers
// ---------------------------------------------------------------------------

test("a request the helper never answers is settled by its own 30s expiry", async () => {
  // This is not a hypothetical on this branch. media-catcher-host's dispatch
  // is an if/elif chain over `cmd` with no else, and it has no `delete`,
  // `thumb` or `badapple-stop` case — so these frames are read, matched by
  // nothing, and dropped without a reply. The expiry is therefore the ONLY
  // thing that answers the popup today, which is why it is measured rather
  // than assumed.
  const h = await readyHarness();
  const pending = h.send({ type: "delete-file", downloadId: 1, path: "C:\v\a.mp4" }, {});
  await settle();
  assert.ok(h.lastHost("delete"), "the frame went out");

  const expiry = h.timers.filter((t) => t && t.ms === 30000);
  assert.equal(expiry.length, 1, "one expiry was armed, at the documented interval");

  h.runTimers();
  const answer = await pending;
  assert.equal(answer.ok, false);
  assert.equal(answer.error, "The helper did not answer.",
    "the popup is told the helper was silent, not left waiting on it");
});

test("an expired request is forgotten, so a late answer cannot resolve it twice", async () => {
  const h = await readyHarness();
  const pending = h.send({ type: "badapple-stop" }, {});
  await settle();
  const frame = h.lastHost("badapple-stop");

  h.runTimers();
  assert.equal((await pending).ok, false);
  assert.equal(h.evalInBackground("pendingHostRequests.size"), 0,
    "the expired entry stayed in the map and would answer a second time");

  // A late frame on that reqId now names nothing.
  h.fromHost({ type: "badapple-stop-result", reqId: frame.reqId, ok: true, error: null });
  await settle();
});

test("an answered request leaves nothing behind for its expiry to find", async () => {
  const h = await readyHarness();
  const pending = h.send({ type: "delete-file", downloadId: 1, path: "C:\v\a.mp4" }, {});
  await settle();
  const frame = h.lastHost("delete");
  h.fromHost({ type: "delete-result", reqId: frame.reqId, ok: true, error: null });
  assert.deepEqual(await pending, { ok: true, error: null });

  // Measured BEFORE the timers run: an entry the answer failed to claim would
  // still be there for the expiry to pick up and answer a second time, and
  // running the expiry first would tidy the evidence away.
  assert.equal(h.evalInBackground("pendingHostRequests.size"), 0,
    "the answered request was still registered");
  h.runTimers();
  await settle();
  assert.equal(h.evalInBackground("pendingHostRequests.size"), 0);
});

test("a thumb request without a string path is refused here, not forwarded", async () => {
  // The same guard `delete-file` has. Without the type half of it, a numeric
  // or object `path` is truthy and reaches the helper as a path.
  const h = await readyHarness();
  for (const bad of [undefined, null, "", 42, {}, [], true]) {
    const answer = await h.send({ type: "thumb-file", path: bad, atSeconds: 3 }, {});
    assert.equal(answer.ok, false, String(bad));
    assert.equal(answer.dataUrl, null, String(bad));
  }
  assert.equal(h.lastHost("thumb"), null, "a non-string path was put on the wire");
});
