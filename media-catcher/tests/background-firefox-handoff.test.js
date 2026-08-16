"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");
const { createBackgroundAdapters } = loadLib("lib/background-adapters.js");

function makeEnv(overrides) {
  const starts = [];
  const downloads = [];
  const publications = [];
  const createdObjectUrls = [];
  const revokedObjectUrls = [];
  let resolveFirefoxDownload = null;
  const options = Object.assign({
    maxConcurrent: 1,
    segmentConcurrency: 1,
    retries: 0,
    now: () => 1_000_000,
    randomToken: () => "opaque",
    postNative(command) { starts.push(command); },
    downloadsDownload(input) {
      downloads.push(input);
      if (overrides && overrides.deferFirefox === true) {
        return new Promise((resolve) => { resolveFirefoxDownload = resolve; });
      }
      return Promise.resolve(7);
    },
    createObjectURL(blob) { createdObjectUrls.push(blob); return "blob:assembled-1"; },
    revokeObjectURL(url) { revokedObjectUrls.push(url); },
    fetchArrayBuffer() { return Promise.resolve(new ArrayBuffer(0)); },
    assembleMedia() { return Promise.resolve(null); },
    isPopupSender(sender) { return sender === "popup"; },
    getEffectiveDestinationDirectory() { return null; },
    publishDetection() {},
    publishJobs(rows) { publications.push(rows); },
    persistHistory() {},
    reportDiagnostic() {},
  }, overrides || {});
  return {
    ctrl: createBackgroundAdapters(options), starts, downloads, publications,
    createdObjectUrls, revokedObjectUrls,
    resolveFirefoxDownload(value) { resolveFirefoxDownload(value); },
  };
}

async function eventually(predicate, label) {
  for (let i = 0; i < 40; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(label || "condition did not become true");
}

async function needsUser(env, suffix) {
  const secretUrl = "https://cdn.example/" + suffix + ".mp4?sig=PRIVATE_" + suffix;
  const mediaId = env.ctrl.captureDomMedia({
    mediaUrl: secretUrl,
    mediaOrigin: "https://cdn.example",
    contentDisposition: null,
    referrerUrl: "https://site.example/watch",
    frameOrigin: "https://site.example",
    ts: 1_000_000,
    snapshot: {
      documentId: "doc-" + suffix,
      tabId: 70,
      frameId: 0,
      pageUrl: "https://site.example/watch",
      topLevelPageUrl: "https://site.example/watch",
      documentNonce: "nonce-" + suffix,
      candidates: [{ kind: "visible-filename", value: suffix + ".mp4" }],
      capturedAt: "2026-08-12T12:00:00.000Z",
    },
    transport: { mediaKind: "direct", requestHeaders: { Cookie: "SECRET_COOKIE" } },
  });
  const job = await env.ctrl.enqueueDownload({
    type: "download", tabId: 70, item: { id: mediaId, proposedFilename: suffix + ".mp4" },
    userActionToken: "proof-" + suffix,
  }, "popup");
  const start = env.starts[env.starts.length - 1];
  await env.ctrl.handleNativeMessage({
    type: "pget-result", id: start.id, attemptToken: start.attemptToken,
    status: "failed", mode: "multi-range", partState: "partial", failureCategory: "timeout",
  });
  const pending = env.ctrl.popupJobs().find((row) => row.id === job.id);
  assert.equal(pending.state, "needs_user");
  return { job: pending, secretUrl };
}

function handoffMessage(job, token) {
  return {
    type: "use-firefox", jobId: job.id,
    intent: {
      requestedFilename: job.requestedFilename,
      destinationDirectory: job.destinationDirectory,
      saveMode: job.saveMode,
      userSelectedFirefox: true,
      userActionToken: token,
      createdAt: job.createdAt,
    },
  };
}

test("explicit popup Firefox handoff consumes a direct needs_user proof exactly once", async () => {
  const env = makeEnv();
  const { job, secretUrl } = await needsUser(env, "private-direct");
  const message = handoffMessage(job, "proof-private-direct");

  const result = await env.ctrl.requestFirefoxHandoff(message, "popup");

  assert.equal(result.state, "handed_to_firefox");
  assert.equal(env.downloads.length, 1);
  assert.deepEqual(env.downloads[0], { url: secretUrl, filename: "private-direct.mp4", saveAs: true });
  assert.deepEqual(env.createdObjectUrls, []);
  assert.deepEqual(env.revokedObjectUrls, []);
  assert.equal(await env.ctrl.requestFirefoxHandoff(message, "popup"), false);
  assert.equal(env.downloads.length, 1);
  const publicJson = JSON.stringify({ result, publications: env.publications, jobs: env.ctrl.popupJobs() });
  assert.equal(publicJson.includes(secretUrl), false);
  assert.equal(publicJson.includes("proof-private-direct"), false);
  assert.equal(publicJson.includes("SECRET_COOKIE"), false);
});

test("forged, malformed, non-popup, and concurrent handoffs are inert", async () => {
  const env = makeEnv({ deferFirefox: true });
  const { job } = await needsUser(env, "once");
  const valid = handoffMessage(job, "proof-once");
  assert.equal(await env.ctrl.requestFirefoxHandoff({ type: "use-firefox", jobId: job.id, intent: {} }, "popup"), false);
  await assert.rejects(env.ctrl.requestFirefoxHandoff(valid, "not-popup"));
  assert.equal(await env.ctrl.requestFirefoxHandoff(handoffMessage(job, "forged"), "popup"), false);
  assert.equal(env.downloads.length, 0);
  const pairPromise = Promise.allSettled([
    env.ctrl.requestFirefoxHandoff(valid, "popup"),
    env.ctrl.requestFirefoxHandoff(valid, "popup"),
  ]);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(env.downloads.length, 1);
  env.resolveFirefoxDownload(7);
  const pair = await pairPromise;
  assert.equal(pair.filter((row) => row.status === "fulfilled" && row.value !== false).length, 1);
  assert.equal(pair.filter((row) => row.status === "fulfilled" && row.value === false).length, 1);
});

test("false flag and cross-job proof leave the target and publications unchanged", async () => {
  const env = makeEnv();
  const first = await needsUser(env, "first");
  const second = await needsUser(env, "second");
  const beforeJobs = JSON.stringify(env.ctrl.popupJobs());
  const beforePublications = JSON.stringify(env.publications);

  const falseFlag = handoffMessage(first.job, "proof-first");
  falseFlag.intent.userSelectedFirefox = false;
  assert.equal(await env.ctrl.requestFirefoxHandoff(falseFlag, "popup"), false);
  assert.equal(
    await env.ctrl.requestFirefoxHandoff(handoffMessage(second.job, "proof-first"), "popup"),
    false
  );

  assert.equal(env.downloads.length, 0);
  assert.equal(JSON.stringify(env.ctrl.popupJobs()), beforeJobs);
  assert.equal(JSON.stringify(env.publications), beforePublications);
});

test("Firefox API rejection consumes proof and returns the safe needs_user job", async () => {
  const rejection = new Error("browser rejected PRIVATE_BROWSER_ERROR");
  const env = makeEnv({ downloadsDownload(input) { env.downloads.push(input); return Promise.reject(rejection); } });
  const { job, secretUrl } = await needsUser(env, "reject");
  const message = handoffMessage(job, "proof-reject");

  const result = await env.ctrl.requestFirefoxHandoff(message, "popup");

  assert.equal(result.state, "needs_user");
  assert.equal(env.ctrl.popupJobs().find((row) => row.id === job.id).holdsGlobalSlot, undefined);
  assert.equal(env.downloads.length, 1);
  assert.equal(await env.ctrl.requestFirefoxHandoff(message, "popup"), false);
  const safeJson = JSON.stringify({ result, jobs: env.ctrl.popupJobs(), publications: env.publications });
  assert.equal(safeJson.includes(secretUrl), false);
  assert.equal(safeJson.includes("proof-reject"), false);
  assert.equal(safeJson.includes("SECRET_COOKIE"), false);
});

test("running direct job preserves its proof until a real result reaches needs_user", async () => {
  const env = makeEnv();
  const secretUrl = "https://cdn.example/running.mp4?sig=PRIVATE_RUNNING";
  const mediaId = env.ctrl.captureDomMedia({ mediaUrl: secretUrl, mediaOrigin: "https://cdn.example", contentDisposition: null, referrerUrl: "https://site.example", frameOrigin: "https://site.example", ts: 1_000_000, snapshot: { documentId: "doc-running", tabId: 70, frameId: 0, pageUrl: "https://site.example", topLevelPageUrl: "https://site.example", documentNonce: "n", candidates: [{ kind: "visible-filename", value: "running.mp4" }], capturedAt: "2026-08-12T12:00:00.000Z" }, transport: { mediaKind: "direct", requestHeaders: null } });
  const job = await env.ctrl.enqueueDownload({ type: "download", tabId: 70, item: { id: mediaId, proposedFilename: "running.mp4" }, userActionToken: "proof-running" }, "popup");
  const running = env.ctrl.popupJobs().find((row) => row.id === job.id);
  assert.equal(await env.ctrl.requestFirefoxHandoff(handoffMessage(running, "proof-running"), "popup"), false);
  assert.equal(env.downloads.length, 0);
  const start = env.starts[0];
  await env.ctrl.handleNativeMessage({ type: "pget-result", id: start.id, attemptToken: start.attemptToken, status: "failed", mode: "multi-range", partState: "partial", failureCategory: "timeout" });
  const pending = env.ctrl.popupJobs().find((row) => row.id === job.id);
  await env.ctrl.requestFirefoxHandoff(handoffMessage(pending, "proof-running"), "popup");
  assert.equal(env.downloads.length, 1);
});

test("explicit HLS Firefox handoff downloads retained assembled bytes and revokes its object URL", async () => {
  const assembledBytes = new Uint8Array([1, 2, 3, 4]);
  const env = makeEnv({
    assembleMedia() {
      return Promise.resolve({
        bytes: assembledBytes,
        mime: "video/mp4",
        extension: "mp4",
      });
    },
  });
  const manifestUrl = "https://cdn.example/private/movie.m3u8?sig=PRIVATE_MANIFEST";
  const mediaId = env.ctrl.captureDomMedia({
    mediaUrl: manifestUrl,
    mediaOrigin: "https://cdn.example",
    contentDisposition: null,
    referrerUrl: "https://site.example/watch",
    frameOrigin: "https://site.example",
    ts: 1_000_000,
    snapshot: {
      documentId: "doc-assembled",
      tabId: 41,
      frameId: 0,
      pageUrl: "https://site.example/watch",
      topLevelPageUrl: "https://site.example/watch",
      documentNonce: "nonce-assembled",
      candidates: [{ kind: "visible-filename", value: "movie.m3u8" }],
      capturedAt: "2026-08-12T12:00:00.000Z",
    },
    transport: { mediaKind: "hls", requestHeaders: null },
  });
  const initialIntent = {
    requestedFilename: "movie.m3u8",
    destinationDirectory: null,
    saveMode: "save-as",
    userSelectedFirefox: false,
    userActionToken: "proof-assembled",
    createdAt: "2026-08-12T12:00:00.000Z",
  };
  const running = await env.ctrl.enqueueDownload({
    type: "save-as-download",
    tabId: 41,
    item: { id: mediaId },
    intent: initialIntent,
  }, "popup");
  await eventually(
    () => env.starts.some((command) => command.cmd === "file-open"),
    "assembled file-open"
  );
  const open = env.starts.find((command) => command.cmd === "file-open");
  assert.equal(await env.ctrl.handleNativeMessage({
    type: "file-error",
    jobId: running.id,
    attemptToken: open.attemptToken,
    failureCategory: "local_io",
    reason: "write_failed",
  }), true);
  const pending = env.ctrl.popupJobs().find((row) => row.id === running.id);
  assert.equal(pending.state, "needs_user");

  const result = await env.ctrl.requestFirefoxHandoff(
    handoffMessage(pending, "proof-assembled"),
    "popup"
  );

  assert.equal(result.state, "handed_to_firefox");
  assert.equal(env.downloads.length, 1);
  assert.deepEqual(env.downloads[0], {
    url: "blob:assembled-1",
    filename: "movie.mp4",
    saveAs: true,
  });
  assert.deepEqual(env.revokedObjectUrls, ["blob:assembled-1"]);
  assert.equal(env.createdObjectUrls.length, 1);
  assert.equal(env.createdObjectUrls[0] instanceof Blob, true);
  assert.equal(env.createdObjectUrls[0].type, "video/mp4");
  assert.equal(JSON.stringify(env.downloads).includes("m3u8"), false);
  assert.equal(JSON.stringify(env.downloads).includes("PRIVATE_MANIFEST"), false);
});
