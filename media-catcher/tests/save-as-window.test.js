"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");

// The page reuses the popup's validation/intent policy unchanged.
loadLib("lib/filename-ranker.js");
loadLib("lib/download-intent.js");
loadLib("lib/popup-download-ui.js");
loadLib("lib/media-size.js");
const SaveAs = loadLib("saveas/saveas.js");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function safeContext(extra) {
  return {
    ok: true,
    context: Object.assign({
      tabId: 7,
      mediaId: "media:opaque:1",
      variantId: null,
      proposedFilename: "11474-makemebi.net.mp4",
      knownExtension: ".mp4",
      kind: "direct",
      sizeBytes: 1395864371,
      sizeConfidence: "exact",
    }, extra || {}),
    helper: "ready",
  };
}

// Builds a controller whose picker response is supplied per test.
function createHarness(options) {
  options = options || {};
  const sent = [];
  const closes = [];
  const picker = deferred();
  const enqueue = options.enqueue || (() => Promise.resolve({ ok: true, job: { id: "job:1" } }));
  const controller = SaveAs.createController({
    send(message) {
      sent.push(JSON.parse(JSON.stringify(message)));
      if (message.type === "get-save-as-context") {
        return Promise.resolve(
          Object.prototype.hasOwnProperty.call(options, "context") ? options.context : safeContext()
        );
      }
      if (message.type === "pick-folder") return picker.promise;
      if (message.type === "save-as-download") return enqueue(message);
      throw new Error("unexpected message " + message.type);
    },
    close() { closes.push(true); },
    now: () => "2026-08-13T12:00:00.000Z",
    mintToken: () => "00000000-0000-4000-8000-000000000001",
  });
  return { controller, sent, closes, picker };
}

test("folder response survives toolbar popup destruction and retains draft", async () => {
  const h = createHarness();
  await h.controller.load();
  h.controller.editFilename("edited.mp4");
  const pending = h.controller.chooseFolder();
  h.picker.resolve({ ok: true, status: "selected", dir: "D:\\Videos" });
  await pending;
  assert.equal(h.controller.snapshot().filename, "edited.mp4");
  assert.equal(h.controller.snapshot().destinationDirectory, "D:\\Videos");
  await h.controller.confirm();
  assert.equal(h.sent.at(-1).type, "save-as-download");
  assert.equal(h.sent.at(-1).intent.destinationDirectory, "D:\\Videos");
  assert.equal(h.sent.at(-1).intent.requestedFilename, "edited.mp4");
  assert.equal(h.sent.at(-1).intent.saveMode, "save-as");
  assert.deepEqual(h.sent.at(-1).item, { id: "media:opaque:1" });
  assert.equal(h.sent.at(-1).tabId, 7);
  assert.equal(h.sent.at(-1).variantId, null);
  assert.equal(h.closes.length, 1, "a successful enqueue closes the window");
});

test("load projects only safe context fields and never a URL", async () => {
  const h = createHarness();
  await h.controller.load();
  const snapshot = h.controller.snapshot();
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.filename, "11474-makemebi.net.mp4");
  assert.equal(snapshot.destinationDirectory, null);
  assert.equal(snapshot.sizeLabel, "1.3 GB");
  assert.equal(JSON.stringify(snapshot).includes("http"), false);
  assert.deepEqual(h.sent[0], { type: "get-save-as-context" });
});

test("estimated and unknown sizes stay visibly marked on the page", async () => {
  const estimated = createHarness({
    context: safeContext({ sizeConfidence: "estimated" }),
  });
  await estimated.controller.load();
  assert.equal(estimated.controller.snapshot().sizeLabel, "Est. 1.3 GB");

  const unknown = createHarness({
    context: safeContext({ sizeBytes: undefined, sizeConfidence: undefined }),
  });
  await unknown.controller.load();
  assert.equal(unknown.controller.snapshot().sizeLabel, "Size unknown");
});

test("cancelled folder selection retains the draft and enqueues nothing", async () => {
  const h = createHarness();
  await h.controller.load();
  h.controller.editFilename("kept.mp4");
  const pending = h.controller.chooseFolder();
  h.picker.resolve({ ok: true, status: "cancelled" });
  await pending;
  const snapshot = h.controller.snapshot();
  assert.equal(snapshot.filename, "kept.mp4");
  assert.equal(snapshot.destinationDirectory, null);
  assert.equal(snapshot.busy, false);
  assert.equal(h.closes.length, 0);
});

test("picker failure and timeout stay understandable and keep the form usable", async () => {
  for (const [error, expected] of [
    ["folder_picker_failed", /folder/i],
    ["folder_picker_timeout", /timed out|folder/i],
  ]) {
    const h = createHarness();
    await h.controller.load();
    h.controller.editFilename("kept.mp4");
    const pending = h.controller.chooseFolder();
    h.picker.resolve({ ok: false, error });
    await pending;
    const snapshot = h.controller.snapshot();
    assert.match(snapshot.error, expected);
    assert.equal(snapshot.filename, "kept.mp4");
    assert.equal(snapshot.destinationDirectory, null);
    assert.equal(snapshot.busy, false);
    assert.equal(h.closes.length, 0);
  }
});

test("a malformed picker payload is rejected rather than trusted", async () => {
  for (const payload of [
    { ok: true, status: "selected", dir: "" },
    { ok: true, status: "selected" },
    { ok: true, status: "unknown", dir: "D:\\Videos" },
    { ok: true, dir: "D:\\Videos" },
    { ok: false },
    null,
    "D:\\Videos",
    { ok: true, status: "selected", dir: 42 },
  ]) {
    const h = createHarness();
    await h.controller.load();
    const pending = h.controller.chooseFolder();
    h.picker.resolve(payload);
    await pending;
    assert.equal(h.controller.snapshot().destinationDirectory, null,
      "must not accept " + JSON.stringify(payload));
    assert.equal(h.controller.snapshot().busy, false);
  }
});

test("a second folder request is refused while one is pending", async () => {
  const h = createHarness();
  await h.controller.load();
  const first = h.controller.chooseFolder();
  const second = h.controller.chooseFolder();
  await second;
  h.picker.resolve({ ok: true, status: "selected", dir: "D:\\Videos" });
  await first;
  const pickCalls = h.sent.filter((message) => message.type === "pick-folder");
  assert.equal(pickCalls.length, 1, "repeat submission must be disabled while pending");
  assert.equal(h.controller.snapshot().destinationDirectory, "D:\\Videos");
});

test("a failed enqueue keeps the window open with the draft intact", async () => {
  const h = createHarness({
    enqueue: () => Promise.resolve({ ok: false, error: "Download action rejected." }),
  });
  await h.controller.load();
  h.controller.editFilename("retry.mp4");
  await h.controller.confirm();
  const snapshot = h.controller.snapshot();
  assert.equal(h.closes.length, 0, "a rejected enqueue must not close the window");
  assert.equal(snapshot.filename, "retry.mp4");
  // Understandable, and deliberately generic — background reasons never leak.
  assert.match(snapshot.error, /download/i);
  assert.equal(snapshot.busy, false, "the form must be usable again");

  // The user can correct and retry in the same window.
  await h.controller.confirm();
  assert.equal(h.sent.filter((m) => m.type === "save-as-download").length, 2);
});

test("a thrown enqueue is contained and never leaks the raw reason", async () => {
  const h = createHarness({
    enqueue: () => Promise.reject(new Error("SECRET_NATIVE_REASON")),
  });
  await h.controller.load();
  await h.controller.confirm();
  assert.equal(h.closes.length, 0);
  assert.equal(h.controller.snapshot().error.includes("SECRET_NATIVE_REASON"), false);
  assert.equal(h.controller.snapshot().busy, false);
});

test("double submit enqueues exactly once", async () => {
  const gate = deferred();
  const h = createHarness({ enqueue: () => gate.promise });
  await h.controller.load();
  const first = h.controller.confirm();
  const second = h.controller.confirm();
  await second;
  gate.resolve({ ok: true, job: { id: "job:1" } });
  await first;
  assert.equal(h.sent.filter((m) => m.type === "save-as-download").length, 1);
  assert.equal(h.closes.length, 1);
});

test("an invalid filename never reaches the background", async () => {
  const h = createHarness();
  await h.controller.load();
  // Only names the shared validator actually rejects; it deliberately sanitizes
  // recoverable ones ("..", backslashes, reserved stems) rather than refusing.
  for (const bad of ["", "   ", "a/b.mp4"]) {
    h.controller.editFilename(bad);
    await h.controller.confirm();
  }
  assert.equal(h.sent.filter((m) => m.type === "save-as-download").length, 0);
  assert.match(h.controller.snapshot().error, /filename/i);
  assert.equal(h.closes.length, 0);
});

test("a stale or rejected context leaves the page inert", async () => {
  for (const context of [
    { ok: false, error: "Save As context unavailable." },
    { ok: true },
    null,
    undefined,
    { ok: true, context: { tabId: 7 } },
  ]) {
    const h = createHarness({ context });
    await h.controller.load();
    assert.equal(h.controller.snapshot().ready, false);
    await h.controller.confirm();
    const pending = h.controller.chooseFolder();
    h.picker.resolve({ ok: true, status: "selected", dir: "D:\\Videos" });
    await pending;
    assert.equal(h.sent.filter((m) => m.type === "save-as-download").length, 0);
    assert.equal(h.sent.filter((m) => m.type === "pick-folder").length, 0);
    assert.equal(h.closes.length, 0);
  }
});

test("cancel closes without ever sending a download", async () => {
  const h = createHarness();
  await h.controller.load();
  h.controller.editFilename("unused.mp4");
  h.controller.cancel();
  assert.equal(h.closes.length, 1);
  assert.equal(h.sent.some((message) => message.type === "save-as-download"), false);
});

test("a variant selection is preserved through to the enqueue message", async () => {
  const h = createHarness({
    context: safeContext({ variantId: "variant:opaque:2", kind: "hls" }),
  });
  await h.controller.load();
  await h.controller.confirm();
  assert.equal(h.sent.at(-1).variantId, "variant:opaque:2");
  assert.deepEqual(h.sent.at(-1).item, { id: "media:opaque:1" });
});

test("dual-export exposes createController on the module and the global", () => {
  assert.equal(typeof SaveAs.createController, "function");
  const root = typeof self !== "undefined" ? self : globalThis;
  assert.equal(root.McSaveAsWindow, SaveAs);
});
