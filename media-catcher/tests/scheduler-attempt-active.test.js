"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");
const { createDownloadScheduler } = loadLib("lib/download-scheduler.js");

function intent(filename) {
  return Object.freeze({
    requestedFilename: filename,
    destinationDirectory: null,
    saveMode: "default",
    userSelectedFirefox: false,
    userActionToken: "action-token",
    createdAt: "t0",
  });
}

function createJob(scheduler, id, providerKey, retries) {
  scheduler.createJob({
    id: id,
    providerKey: providerKey,
    intent: intent(id + ".mp4"),
    segmentConcurrency: 2,
    retries: retries == null ? 1 : retries,
  });
}

test("isAttemptActive accepts only the exact live running identity without mutation", () => {
  // Mutation caught: accepting a missing job, coercing identities, matching the
  // wrong token, or changing scheduler state while answering the query.
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  createJob(s, "job", "p.example", 1);
  s.enqueue("job");
  const token = s.getJob("job").attemptToken;
  const before = s.getSnapshot();

  assert.equal(s.isAttemptActive("job", token), true);
  assert.equal(s.isAttemptActive("missing", token), false);
  assert.equal(s.isAttemptActive("job", "wrong-token"), false);
  assert.equal(s.isAttemptActive(" job ", token), false);
  assert.equal(s.isAttemptActive("job", " " + token + " "), false);

  [undefined, null, "", "   ", 0, {}, []].forEach(function (badId) {
    assert.equal(s.isAttemptActive(badId, token), false);
  });
  [undefined, null, "", "   ", 0, {}, []].forEach(function (badToken) {
    assert.equal(s.isAttemptActive("job", badToken), false);
  });

  assert.deepEqual(s.getSnapshot(), before);
});

test("isAttemptActive rejects cancellation before the transport terminal arrives", () => {
  // Mutation caught: treating state=running plus a matching retained token as
  // active after cancelRequested has fenced new work.
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  createJob(s, "job", "p.example", 1);
  s.enqueue("job");
  const token = s.getJob("job").attemptToken;

  assert.equal(s.isAttemptActive("job", token), true);
  s.cancel("job");
  assert.equal(s.getJob("job").state, "running");
  assert.equal(s.getJob("job").attemptToken, token);
  assert.equal(s.isAttemptActive("job", token), false);

  s.onTransportResult("job", token, {
    status: "cancelled",
    failureCategory: "cancelled",
  });
  assert.equal(s.getJob("job").state, "cancelled");
  assert.equal(s.isAttemptActive("job", token), false);
});

test("isAttemptActive rejects stale retry identities, needs_user, and completed jobs", () => {
  // Mutation caught: token-only matching that ignores the current attempt state
  // or allows an earlier physical attempt to authorize later work.
  let now = 0;
  let sequence = 0;
  const s = createDownloadScheduler({
    maxConcurrent: 1,
    now: () => now,
    randomToken: () => "attempt-" + (++sequence),
  });
  createJob(s, "retry", "p.example", 1);
  s.enqueue("retry");
  const firstToken = s.getJob("retry").attemptToken;

  s.onTransportResult("retry", firstToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  assert.equal(s.getJob("retry").state, "retry_backoff");
  assert.equal(s.isAttemptActive("retry", firstToken), false);

  now = 2000;
  s.tick(now);
  const secondToken = s.getJob("retry").attemptToken;
  assert.equal(s.getJob("retry").state, "running");
  assert.notEqual(secondToken, firstToken);
  assert.equal(s.isAttemptActive("retry", firstToken), false);
  assert.equal(s.isAttemptActive("retry", secondToken), true);

  s.onTransportResult("retry", secondToken, {
    status: "failed",
    failureCategory: "local_io",
  });
  assert.equal(s.getJob("retry").state, "needs_user");
  assert.equal(s.isAttemptActive("retry", secondToken), false);

  createJob(s, "done", "q.example", 0);
  s.enqueue("done");
  const completedToken = s.getJob("done").attemptToken;
  assert.equal(s.isAttemptActive("done", completedToken), true);
  s.onTransportResult("done", completedToken, {
    status: "completed",
    failureCategory: null,
  });
  assert.equal(s.getJob("done").state, "completed");
  assert.equal(s.isAttemptActive("done", completedToken), false);
});

test("isAttemptActive rejects a paused sibling with retained physical attempt identity", () => {
  // Mutation caught: authenticating against private drainingAttemptToken while
  // provider saturation has paused the sibling's logical attempt.
  const s = createDownloadScheduler({ maxConcurrent: 3, now: () => 0 });
  createJob(s, "owner", "p.example", 3);
  createJob(s, "paused", "p.example", 3);
  createJob(s, "failed", "p.example", 3);
  s.enqueue("owner");
  s.enqueue("paused");
  s.enqueue("failed");
  s.notePermitAcquired("owner");
  const pausedPermit = s.acquireProviderPermit("paused", "segment");
  assert.ok(pausedPermit);
  const pausedToken = s.getJob("paused").attemptToken;
  const failedToken = s.getJob("failed").attemptToken;

  s.onTransportResult("failed", failedToken, {
    status: "failed",
    failureCategory: "short_read",
  });
  assert.equal(s.getJob("paused").state, "pausing_provider");
  assert.equal(s.getJob("paused").holdsGlobalSlot, true);
  assert.equal(s.isAttemptActive("paused", pausedToken), false);

  pausedPermit.release();
});
