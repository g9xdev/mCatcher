"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function makeHarness(overrides) {
  const effects = { assembled: [], fetches: [], native: [], firefox: 0 };
  const tokens = { media: 0, job: 0, attempt: 0 };
  const options = {
    maxConcurrent: 1,
    segmentConcurrency: 3,
    retries: 1,
    now: () => 1_000_000,
    randomToken(namespace) {
      tokens[namespace] = (tokens[namespace] || 0) + 1;
      return namespace[0] + tokens[namespace];
    },
    postNative(command) { effects.native.push(command); return command; },
    downloadsDownload() { effects.firefox += 1; },
    createObjectURL: () => "blob:test",
    revokeObjectURL() {},
    fetchArrayBuffer(...args) { effects.fetches.push(args); return Promise.resolve(new ArrayBuffer(0)); },
    assembleMedia(input) { effects.assembled.push(input); return Promise.resolve(null); },
    isPopupSender: () => true,
    getEffectiveDestinationDirectory: () => "D:\\Effective",
    publishDetection() {},
    publishJobs() {},
    persistHistory() {},
    reportDiagnostic() {},
  };
  Object.assign(options, overrides || {});
  return {
    ctrl: loadLib("lib/background-adapters.js").createBackgroundAdapters(options),
    effects,
  };
}

function capture(ctrl, kind, suffix) {
  return ctrl.captureDomMedia({
    mediaUrl: "https://cdn-" + suffix + ".example/private/manifest." + (kind === "hls" ? "m3u8" : "mpd"),
    mediaOrigin: "https://cdn-" + suffix + ".example",
    contentDisposition: null,
    referrerUrl: "https://provider-" + suffix + ".example/watch",
    frameOrigin: "https://provider-" + suffix + ".example",
    ts: 1_000_000,
    snapshot: {
      documentId: "doc-" + suffix,
      tabId: Number(suffix.replace(/\D/g, "")) || 1,
      frameId: 0,
      pageUrl: "https://provider-" + suffix + ".example/watch",
      topLevelPageUrl: "https://provider-" + suffix + ".example/watch",
      documentNonce: "nonce-" + suffix,
      candidates: [{ kind: "visible-filename", value: suffix + ".mp4" }],
      capturedAt: "2026-08-12T12:00:00.000Z",
    },
    transport: { mediaKind: kind, requestHeaders: null },
  });
}

function intent(filename) {
  return {
    requestedFilename: filename,
    destinationDirectory: "D:\\Chosen",
    saveMode: "save-as",
    userSelectedFirefox: false,
    userActionToken: "proof-private",
    createdAt: "2026-08-12T12:00:00.000Z",
  };
}

async function eventually(predicate, label) {
  for (let i = 0; i < 40; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(label || "condition did not become true");
}

test("owned HLS starts one private assembly attempt without blocking enqueue or using Firefox", async () => {
  const assembly = deferred();
  const h = makeHarness({ assembleMedia(input) { h.effects.assembled.push(input); return assembly.promise; } });
  const mediaId = capture(h.ctrl, "hls", "11");
  const sourceUrl = "https://cdn-11.example/private/manifest.m3u8";

  const returned = await h.ctrl.enqueueDownload({
    type: "save-as-download",
    tabId: 11,
    item: { id: mediaId },
    intent: intent("chosen.m4v"),
  }, {});

  assert.equal(returned.state, "running");
  assert.equal(h.effects.assembled.length, 1);
  assert.equal(h.effects.assembled[0].kind, "hls");
  assert.equal(h.effects.assembled[0].sourceUrl, sourceUrl);
  assert.equal(h.effects.assembled[0].segmentConcurrency, 3);
  assert.equal(h.effects.assembled[0].selection, null);
  assert.equal(typeof h.effects.assembled[0].fetchArrayBuffer, "function");
  assert.equal(typeof h.effects.assembled[0].shouldAbort, "function");
  assert.equal(typeof h.effects.assembled[0].onProgress, "function");
  assert.equal(h.effects.assembled[0].shouldAbort(), false);
  assert.deepEqual(h.effects.native, []);
  assert.equal(h.effects.firefox, 0);

  await h.ctrl.pump();
  assert.equal(h.effects.assembled.length, 1);
  assembly.reject(new Error("end pending attempt"));
});

test("assembly fetches stay bound to the immutable captured source tab", async () => {
  const assembly = deferred();
  let assemblyInput;
  const h = makeHarness({
    assembleMedia(input) {
      h.effects.assembled.push(input);
      assemblyInput = input;
      return assembly.promise;
    },
  });
  const mediaId = capture(h.ctrl, "hls", "41");
  const popupMessage = {
    type: "save-as-download",
    tabId: 41,
    item: { id: mediaId },
    intent: intent("captured.m3u8"),
  };

  await h.ctrl.enqueueDownload(popupMessage, {});
  popupMessage.tabId = 99;
  popupMessage.item = { id: "different-media" };
  const requestOptions = { headers: { Range: "bytes=0-9" } };
  await assemblyInput.fetchArrayBuffer(
    "https://segments.example/private-41.ts",
    requestOptions
  );

  assert.deepEqual(h.effects.fetches, [[
    41,
    "https://segments.example/private-41.ts",
    requestOptions,
  ]]);
  assembly.reject(new Error("end pending attempt"));
});

test("assembled HLS streams through a four-chunk window and completes only on commit", async () => {
  const assembly = deferred();
  const h = makeHarness({ assembleMedia(input) { h.effects.assembled.push(input); return assembly.promise; } });
  const mediaId = capture(h.ctrl, "hls", "12");
  const running = await h.ctrl.enqueueDownload({
    type: "save-as-download",
    tabId: 12,
    item: { id: mediaId },
    intent: intent("movie.m3u8"),
  }, {});
  const bytes = new Uint8Array((4 * 512 * 1024) + 1);
  bytes[bytes.length - 1] = 7;

  assembly.resolve({ bytes, mime: "video/mp4", extension: "m4v" });
  await eventually(() => h.effects.native.some((c) => c.cmd === "file-open"), "file-open");
  const open = h.effects.native.find((c) => c.cmd === "file-open");
  const token = open.attemptToken;
  assert.equal(open.jobId, running.id);
  assert.equal(open.attemptToken, token);
  assert.equal(open.requestedFilename, "movie.m4v");
  assert.equal(open.dir, "D:\\Chosen");

  assert.equal(await h.ctrl.handleNativeMessage({
    type: "file-opened", sinkId: "sink-12", jobId: running.id, attemptToken: token,
  }), true);
  assert.equal(h.effects.native.filter((c) => c.cmd === "file-chunk").length, 4);
  assert.equal(h.effects.native.some((c) => c.cmd === "file-commit"), false);

  assert.equal(await h.ctrl.handleNativeMessage({
    type: "file-chunk-ack", sinkId: "sink-12", seq: 0,
  }), true);
  assert.equal(h.effects.native.filter((c) => c.cmd === "file-chunk").length, 5);
  for (const seq of [1, 2, 3, 4]) {
    assert.equal(await h.ctrl.handleNativeMessage({
      type: "file-chunk-ack", sinkId: "sink-12", seq,
    }), true);
  }
  assert.equal(h.effects.native.filter((c) => c.cmd === "file-commit").length, 1);
  assert.equal(h.ctrl.popupJobs()[0].state, "running");

  assert.equal(await h.ctrl.handleNativeMessage({
    type: "file-committed", sinkId: "sink-12",
    file: "D:\\Chosen\\movie.m4v", bytes: bytes.length,
  }), true);
  assert.equal(h.ctrl.popupJobs()[0].state, "completed");
  assert.equal(h.effects.firefox, 0);
  const publicJson = JSON.stringify(h.ctrl.popupJobs());
  assert.equal(publicJson.includes("cdn-12"), false);
  assert.equal(publicJson.includes("D:\\Chosen"), false);
  assert.equal(publicJson.includes("sink-12"), false);
});

test("assembly failure waits for every provider-permitted fetch before admitting a peer", async () => {
  const fetchA = deferred();
  const fetchB = deferred();
  const peerAssembly = deferred();
  let calls = 0;
  const h = makeHarness({
    fetchArrayBuffer(tabId, url) {
      h.effects.fetches.push([tabId, url]);
      return url.endsWith("a") ? fetchA.promise : fetchB.promise;
    },
    assembleMedia(input) {
      h.effects.assembled.push(input);
      calls += 1;
      if (calls === 1) {
        input.fetchArrayBuffer("https://segments.example/a").catch(() => {});
        input.fetchArrayBuffer("https://segments.example/b").catch(() => {});
        return Promise.reject({ name: "TimeoutError", message: "private timeout detail" });
      }
      return peerAssembly.promise;
    },
  });
  const firstId = capture(h.ctrl, "hls", "13");
  const first = await h.ctrl.enqueueDownload({
    type: "save-as-download", tabId: 13, item: { id: firstId }, intent: intent("first.mp4"),
  }, {});
  const secondId = capture(h.ctrl, "dash", "14");
  const second = await h.ctrl.enqueueDownload({
    type: "save-as-download", tabId: 14, item: { id: secondId }, intent: intent("second.mp4"),
  }, {});

  await eventually(() => h.effects.fetches.length === 2, "two guarded fetches");
  assert.equal(h.ctrl.popupJobs().find((j) => j.id === first.id).inFlightPermits, 2);
  assert.equal(h.ctrl.popupJobs().find((j) => j.id === second.id).state, "queued");
  assert.equal(h.effects.assembled.length, 1);

  fetchA.resolve(new ArrayBuffer(1));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.ctrl.popupJobs().find((j) => j.id === first.id).inFlightPermits, 1);
  assert.equal(h.effects.assembled.length, 1);
  fetchB.reject(new Error("private segment failure"));
  await eventually(() => h.effects.assembled.length === 2, "peer admitted after quiescence");
  assert.equal(h.ctrl.popupJobs().find((j) => j.id === first.id).state, "retry_backoff");
  assert.equal(h.ctrl.popupJobs().find((j) => j.id === second.id).state, "running");
  assert.equal(h.effects.firefox, 0);
  assert.equal(JSON.stringify(h.ctrl.popupJobs()).includes("private"), false);
  peerAssembly.reject(new Error("end peer"));
});

test("cancel during assembly flips abort, quiesces fetches, and never opens a sink", async () => {
  const fetch = deferred();
  const assembly = deferred();
  let assemblyInput;
  const h = makeHarness({
    fetchArrayBuffer() { return fetch.promise; },
    assembleMedia(input) {
      h.effects.assembled.push(input);
      assemblyInput = input;
      input.fetchArrayBuffer("https://segments.example/private").catch(() => {});
      return assembly.promise;
    },
  });
  const mediaId = capture(h.ctrl, "dash", "15");
  const running = await h.ctrl.enqueueDownload({
    type: "save-as-download", tabId: 15, item: { id: mediaId }, intent: intent("cancel.mp4"),
  }, {});
  await eventually(() => assemblyInput != null, "assembly input");
  assert.equal(assemblyInput.shouldAbort(), false);
  const cancelling = await h.ctrl.cancel(running.id);
  assert.equal(cancelling.state, "running");
  assert.equal(assemblyInput.shouldAbort(), true);
  assembly.resolve({ bytes: new Uint8Array([1]), mime: "video/mp4", extension: "mp4" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.ctrl.popupJobs()[0].state, "running");
  fetch.resolve(new ArrayBuffer(1));
  await eventually(() => h.ctrl.popupJobs()[0].state === "cancelled", "cancelled after quiescence");
  assert.equal(h.effects.native.some((c) => c.cmd === "file-open"), false);
  assert.equal(h.effects.firefox, 0);
});

test("cancel while file-open is pending aborts once after open and never streams or commits", async () => {
  const h = makeHarness({
    assembleMedia(input) {
      h.effects.assembled.push(input);
      return Promise.resolve({ bytes: new Uint8Array([1, 2, 3]), mime: "video/mp4", extension: "mp4" });
    },
  });
  const mediaId = capture(h.ctrl, "hls", "16");
  const running = await h.ctrl.enqueueDownload({
    type: "save-as-download", tabId: 16, item: { id: mediaId }, intent: intent("pending.m3u8"),
  }, {});
  await eventually(() => h.effects.native.some((c) => c.cmd === "file-open"), "file-open pending");
  const open = h.effects.native.find((c) => c.cmd === "file-open");
  await h.ctrl.cancel(running.id);
  assert.equal(h.effects.native.some((c) => c.cmd === "file-abort"), false);

  assert.equal(await h.ctrl.handleNativeMessage({
    type: "file-opened", sinkId: "sink-16", jobId: running.id, attemptToken: open.attemptToken,
  }), true);
  assert.equal(h.effects.native.filter((c) => c.cmd === "file-abort").length, 1);
  assert.equal(h.effects.native.some((c) => c.cmd === "file-chunk"), false);
  assert.equal(await h.ctrl.handleNativeMessage({
    type: "file-committed", sinkId: "sink-16", file: "D:\\Chosen\\pending.mp4", bytes: 3,
  }), false);
  assert.equal(await h.ctrl.handleNativeMessage({ type: "file-aborted", sinkId: "sink-16" }), true);
  assert.equal(h.ctrl.popupJobs()[0].state, "cancelled");
  assert.equal(h.effects.native.filter((c) => c.cmd === "file-abort").length, 1);
  assert.equal(h.effects.firefox, 0);
});

test("file-error parks assembled bytes and manual retry opens a fresh sink without reassembly", async () => {
  const h = makeHarness({
    assembleMedia(input) {
      h.effects.assembled.push(input);
      return Promise.resolve({ bytes: new Uint8Array([9]), mime: "video/mp4", extension: "mp4" });
    },
  });
  const mediaId = capture(h.ctrl, "dash", "17");
  const running = await h.ctrl.enqueueDownload({
    type: "save-as-download", tabId: 17, item: { id: mediaId }, intent: intent("retry.mpd"),
  }, {});
  await eventually(() => h.effects.native.some((c) => c.cmd === "file-open"), "first open");
  const firstOpen = h.effects.native.find((c) => c.cmd === "file-open");
  assert.equal(await h.ctrl.handleNativeMessage({
    type: "file-error", jobId: running.id, attemptToken: firstOpen.attemptToken,
    failureCategory: "local_io", reason: "write_failed",
  }), true);
  assert.equal(h.ctrl.popupJobs()[0].state, "needs_user");
  assert.equal(h.effects.assembled.length, 1);

  const retried = await h.ctrl.manualRetry(running.id);
  assert.equal(retried.state, "running");
  await eventually(() => h.effects.native.filter((c) => c.cmd === "file-open").length === 2, "retry open");
  const opens = h.effects.native.filter((c) => c.cmd === "file-open");
  assert.notEqual(opens[1].attemptToken, firstOpen.attemptToken);
  assert.equal(h.effects.assembled.length, 1);
  assert.equal(await h.ctrl.handleNativeMessage({
    type: "file-opened", sinkId: "stale-17", jobId: running.id, attemptToken: firstOpen.attemptToken,
  }), false);
  assert.equal(h.effects.firefox, 0);

  assert.equal(await h.ctrl.handleNativeMessage({
    type: "file-error", jobId: running.id, attemptToken: opens[1].attemptToken,
    failureCategory: "local_io", reason: "write_failed",
  }), true);
});

test("helper disconnect parks an open HLS sink and retry reuses assembled bytes", async () => {
  const h = makeHarness({
    assembleMedia(input) {
      h.effects.assembled.push(input);
      return Promise.resolve({ bytes: new Uint8Array([4]), mime: "video/mp4", extension: "mp4" });
    },
  });
  const mediaId = capture(h.ctrl, "hls", "18");
  const running = await h.ctrl.enqueueDownload({
    type: "save-as-download", tabId: 18, item: { id: mediaId }, intent: intent("disconnect.m3u8"),
  }, {});
  await eventually(() => h.effects.native.some((c) => c.cmd === "file-open"), "open before disconnect");
  const changed = await h.ctrl.helperDisconnected();
  assert.equal(changed.length, 1);
  assert.equal(changed[0].id, running.id);
  assert.equal(h.ctrl.popupJobs()[0].state, "needs_user");
  assert.equal(h.effects.firefox, 0);

  await h.ctrl.manualRetry(running.id);
  await eventually(() => h.effects.native.filter((c) => c.cmd === "file-open").length === 2, "open after disconnect");
  assert.equal(h.effects.assembled.length, 1);
  const secondOpen = h.effects.native.filter((c) => c.cmd === "file-open")[1];
  await h.ctrl.handleNativeMessage({
    type: "file-error", jobId: running.id, attemptToken: secondOpen.attemptToken,
    failureCategory: "local_io", reason: "write_failed",
  });
});

test("malformed assembly output is a permanent failure with no native or Firefox effect", async () => {
  const h = makeHarness({
    assembleMedia(input) {
      h.effects.assembled.push(input);
      return Promise.resolve({ bytes: new Uint8Array([1]), mime: "video/mp4", extension: "../mp4" });
    },
  });
  const mediaId = capture(h.ctrl, "dash", "19");
  await h.ctrl.enqueueDownload({
    type: "save-as-download", tabId: 19, item: { id: mediaId }, intent: intent("malformed.mpd"),
  }, {});
  await eventually(() => h.ctrl.popupJobs()[0].state === "failed", "permanent malformed failure");
  assert.deepEqual(h.effects.native, []);
  assert.equal(h.effects.firefox, 0);
});

test("file-open post rejection parks retained bytes and retry does not reassemble", async () => {
  let rejectOpen = true;
  const h = makeHarness({
    postNative(command) {
      h.effects.native.push(command);
      if (command.cmd === "file-open" && rejectOpen) {
        rejectOpen = false;
        return Promise.reject(new Error("private helper disconnect"));
      }
      return command;
    },
    assembleMedia(input) {
      h.effects.assembled.push(input);
      return Promise.resolve({ bytes: new Uint8Array([8]), mime: "video/mp4", extension: "mp4" });
    },
  });
  const mediaId = capture(h.ctrl, "hls", "20");
  const running = await h.ctrl.enqueueDownload({
    type: "save-as-download", tabId: 20, item: { id: mediaId }, intent: intent("transport.m3u8"),
  }, {});
  await eventually(() => h.ctrl.popupJobs()[0].state === "needs_user", "post rejection needs user");
  assert.equal(h.effects.firefox, 0);
  assert.equal(JSON.stringify(h.ctrl.popupJobs()).includes("private helper"), false);

  await h.ctrl.manualRetry(running.id);
  await eventually(() => h.effects.native.filter((c) => c.cmd === "file-open").length === 2, "retry open");
  assert.equal(h.effects.assembled.length, 1);
  const secondOpen = h.effects.native.filter((c) => c.cmd === "file-open")[1];
  await h.ctrl.handleNativeMessage({
    type: "file-error", jobId: running.id, attemptToken: secondOpen.attemptToken,
    failureCategory: "local_io", reason: "write_failed",
  });
});
