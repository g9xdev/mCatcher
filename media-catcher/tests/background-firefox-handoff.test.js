"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");
const { createBackgroundAdapters } = loadLib("lib/background-adapters.js");

function makeEnv(overrides) {
  const starts = [];
  const downloads = [];
  const publications = [];
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
    createObjectURL() { return "blob:unused"; },
    revokeObjectURL() {},
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
    resolveFirefoxDownload(value) { resolveFirefoxDownload(value); },
  };
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
