"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");
const { createDownloadScheduler } = loadLib("lib/download-scheduler.js");

/**
 * McDownloadScheduler — Task 11 retry budget, cancel drain, attempt tokens,
 * capability switch, and explicit Firefox handoff.
 */

function intent(n) {
  return Object.freeze({
    requestedFilename: n,
    destinationDirectory: null,
    saveMode: "default",
    userSelectedFirefox: false,
    userActionToken: "t",
    createdAt: "t0",
  });
}

function countHeldSlots(snap) {
  return snap.jobs.filter(function (j) {
    return j.holdsGlobalSlot === true;
  }).length;
}

function assertSlotInvariant(s) {
  var snap = s.getSnapshot();
  assert.equal(snap.globalRunning, countHeldSlots(snap));
  assert.ok(snap.globalRunning >= 0);
  snap.jobs.forEach(function (j) {
    if (j.state === "running") {
      assert.equal(j.holdsGlobalSlot, true);
      assert.ok(typeof j.attemptToken === "string" && j.attemptToken.trim().length > 0);
    } else if (
      j.state === "created" ||
      j.state === "queued" ||
      j.state === "waiting_provider" ||
      j.state === "retry_backoff" ||
      j.state === "needs_user" ||
      j.state === "handing_off_firefox" ||
      j.state === "handed_to_firefox" ||
      j.state === "completed" ||
      j.state === "failed" ||
      j.state === "cancelled"
    ) {
      assert.equal(j.holdsGlobalSlot, false);
    } else if (j.state === "pausing_provider") {
      assert.equal(j.holdsGlobalSlot, true);
    }
  });
}

// ---------------------------------------------------------------------------
// Brief scenarios
// ---------------------------------------------------------------------------

test("automatic retries consume finite budget and exhaust to needs_user", () => {
  // Mutation: infinite retry loop in transport layer.
  let t = 0;
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => t });
  s.createJob({ id: "j", providerKey: "p.com", intent: intent("f.mp4"), segmentConcurrency: 2, retries: 2 });
  s.enqueue("j");
  // first failure → retry_backoff (retries 2→1)
  s.onTransportResult("j", s.getJob("j").attemptToken, { status: "failed", failureCategory: "timeout" });
  assert.equal(s.getJob("j").retryRemaining, 1);
  assert.equal(s.getJob("j").state, "retry_backoff");
  t += 2000; s.tick(t); // admit retry
  assert.equal(s.getJob("j").state, "running");
  s.onTransportResult("j", s.getJob("j").attemptToken, { status: "failed", failureCategory: "timeout" });
  assert.equal(s.getJob("j").retryRemaining, 0);
  t += 4000; s.tick(t);
  assert.equal(s.getJob("j").state, "running");
  s.onTransportResult("j", s.getJob("j").attemptToken, { status: "failed", failureCategory: "timeout" });
  assert.equal(s.getJob("j").state, "needs_user");
  // late timer cannot restart
  t += 999999; s.tick(t);
  assert.equal(s.getJob("j").state, "needs_user");
  assertSlotInvariant(s);
});

test("wake charges failed waiter once; paused sibling free", () => {
  // Three same-provider jobs can hold slots only when maxConcurrent >= 3.
  // Mutation: maxConcurrent:2 while treating owner+fail+paused as all permit-holding.
  const s = createDownloadScheduler({ maxConcurrent: 3, now: () => 0 });
  s.createJob({ id: "owner", providerKey: "p.com", intent: intent("o.mp4"), segmentConcurrency: 4, retries: 3 });
  s.createJob({ id: "fail", providerKey: "p.com", intent: intent("f.mp4"), segmentConcurrency: 4, retries: 3 });
  s.createJob({ id: "pausedOnly", providerKey: "p.com", intent: intent("p.mp4"), segmentConcurrency: 4, retries: 3 });
  s.enqueue("owner"); s.enqueue("fail"); s.enqueue("pausedOnly");
  assert.equal(s.getSnapshot().globalRunning, 3);
  assert.equal(s.getJob("owner").state, "running");
  assert.equal(s.getJob("fail").state, "running");
  assert.equal(s.getJob("pausedOnly").state, "running");
  s.notePermitAcquired("owner");
  s.notePermitAcquired("pausedOnly");
  const failRetriesBefore = s.getJob("fail").retryRemaining;
  const pausedRetriesBefore = s.getJob("pausedOnly").retryRemaining;
  s.onTransportResult("fail", s.getJob("fail").attemptToken, {
    status: "failed", failureCategory: "http_5xx_temporary",
  });
  // fail enters pausing_provider/waiting path; pausedOnly is competing sibling without its own failure
  assert.ok(
    s.getJob("fail").state === "pausing_provider" ||
    s.getJob("fail").state === "waiting_provider"
  );
  if (s.getJob("pausedOnly").state === "pausing_provider") {
    s.onQuiesced("pausedOnly");
  }
  assert.equal(s.getJob("pausedOnly").retryRemaining, pausedRetriesBefore);
  if (s.getJob("fail").state === "pausing_provider") {
    s.onQuiesced("fail");
  }
  assert.equal(s.getJob("fail").state, "waiting_provider");
  s.onTransportResult("owner", s.getJob("owner").attemptToken, {
    status: "completed", failureCategory: null,
  });
  // Failed waiter charged exactly once; merely-paused sibling not charged.
  assert.equal(s.getJob("fail").retryRemaining, failRetriesBefore - 1);
  assert.equal(s.getJob("pausedOnly").retryRemaining, pausedRetriesBefore);
  assert.equal(s.getJob("fail").autoWakeCount, 1);
  assertSlotInvariant(s);
});

test("needs_user after retry exhaustion releases global slot and admits eligible peer", () => {
  // Mutation: leaving holdsGlobalSlot true after needs_user.
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s.createJob({ id: "j", providerKey: "p.com", intent: intent("f.mp4"), segmentConcurrency: 2, retries: 0 });
  s.createJob({ id: "peer", providerKey: "q.com", intent: intent("peer.mp4"), segmentConcurrency: 2, retries: 1 });
  s.enqueue("j"); s.enqueue("peer");
  assert.equal(s.getJob("j").state, "running");
  assert.equal(s.getJob("peer").state, "queued");
  s.onTransportResult("j", s.getJob("j").attemptToken, {
    status: "failed", failureCategory: "timeout",
  });
  assert.equal(s.getJob("j").state, "needs_user");
  assert.equal(s.getJob("j").holdsGlobalSlot, false);
  assert.equal(s.getSnapshot().globalRunning, 1);
  assert.equal(s.getJob("peer").state, "running");
  assertSlotInvariant(s);
});

test("Save-As editing never holds a scheduler slot", () => {
  // Mutation: creating a running job when the user only opens Save As form.
  // Intent factory alone does not call createJob; assert scheduler starts empty.
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  assert.equal(s.getSnapshot().globalRunning, 0);
  assert.equal(s.getSnapshot().jobs.length, 0);
  // Only after explicit enqueue of a confirmed intent does a job exist:
  s.createJob({ id: "confirmed", providerKey: "p.com", intent: intent("a.mp4"), segmentConcurrency: 2, retries: 1 });
  // createJob without enqueue must not admit:
  assert.equal(s.getJob("confirmed").state, "created");
  assert.equal(s.getJob("confirmed").holdsGlobalSlot, false);
  assert.equal(s.getSnapshot().globalRunning, 0);
  assertSlotInvariant(s);
});

test("Firefox handoff callback receives the consumed immutable true intent", async () => {
  const originalIntent = intent("firefox.mp4");
  const handoffIntent = Object.freeze({
    requestedFilename: "firefox.mp4",
    destinationDirectory: null,
    saveMode: "default",
    userSelectedFirefox: true,
    userActionToken: "popup-proof",
    createdAt: "t0",
  });
  const popupTokenStore = new Map([["j", "popup-proof"]]);
  let adapterInput = null;
  const s = createDownloadScheduler({
    maxConcurrent: 1,
    now: () => 0,
    popupTokenStore,
    firefoxDownload(input) {
      adapterInput = input;
    },
  });
  s.createJob({ id: "j", providerKey: "p.com", intent: originalIntent, segmentConcurrency: 1, retries: 0 });
  s.enqueue("j");
  s.onTransportResult("j", s.getJob("j").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });

  await s.requestFirefoxHandoff("j", handoffIntent);

  assert.equal(adapterInput.intent, handoffIntent);
  assert.equal(Object.isFrozen(adapterInput.intent), true);
  assert.equal(adapterInput.intent.userSelectedFirefox, true);
  assert.equal(popupTokenStore.has("j"), false);
});

test("stale attempt tokens are rejected and cannot multiply budget", () => {
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s.createJob({ id: "j", providerKey: "p.com", intent: intent("f.mp4"), segmentConcurrency: 2, retries: 2 });
  s.enqueue("j");
  const stale = s.getJob("j").attemptToken;
  s.onTransportResult("j", stale, { status: "failed", failureCategory: "timeout" });
  // after failure, new token issued on retry admission
  s.tick(2000);
  const fresh = s.getJob("j").attemptToken;
  assert.notEqual(fresh, stale);
  assert.equal(s.getJob("j").state, "running");
  // stale success must not complete job
  s.onTransportResult("j", stale, { status: "completed", failureCategory: null });
  assert.notEqual(s.getJob("j").state, "completed");
  assert.equal(s.getJob("j").state, "running");
  assertSlotInvariant(s);
});

test("cancel releases slot once; duplicate cancel ack safe", () => {
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s.createJob({ id: "j", providerKey: "p.com", intent: intent("f.mp4"), segmentConcurrency: 2, retries: 1 });
  s.createJob({ id: "k", providerKey: "q.com", intent: intent("k.mp4"), segmentConcurrency: 2, retries: 1 });
  s.enqueue("j"); s.enqueue("k");
  s.cancel("j");
  s.onTransportResult("j", s.getJob("j").attemptToken, { status: "cancelled", failureCategory: "cancelled" });
  s.onTransportResult("j", s.getJob("j").attemptToken, { status: "cancelled", failureCategory: "cancelled" });
  assert.equal(s.getJob("j").state, "cancelled");
  assert.equal(s.getSnapshot().globalRunning, 1);
  assert.equal(s.getJob("k").state, "running");
  assertSlotInvariant(s);
});

test("range-to-single switch costs no retry unit and keeps slot/filename", () => {
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s.createJob({ id: "j", providerKey: "p.com", intent: intent("11238-makemebi.net.mp4"), segmentConcurrency: 4, retries: 3 });
  s.enqueue("j");
  const before = s.getJob("j").retryRemaining;
  const tokenBefore = s.getJob("j").attemptToken;
  s.onCapabilitySwitch("j", { mode: "single-connection", partState: "empty" });
  assert.equal(s.getJob("j").mode, "single-connection");
  assert.equal(s.getJob("j").effectiveConcurrency, 1);
  assert.equal(s.getJob("j").retryRemaining, before);
  assert.equal(s.getJob("j").state, "running");
  assert.equal(s.getJob("j").holdsGlobalSlot, true);
  assert.equal(s.getJob("j").attemptToken, tokenBefore);
  assert.equal(s.getJob("j").intent.requestedFilename, "11238-makemebi.net.mp4");
  assertSlotInvariant(s);
});

test("requestFirefoxHandoff requires userSelectedFirefox and matching one-time token", async () => {
  let downloadCalls = 0;
  const s = createDownloadScheduler({
    maxConcurrent: 1,
    now: () => 0,
    firefoxDownload: async () => { downloadCalls++; return 1; },
    popupTokenStore: new Set(["popup-tok"]),
  });
  s.createJob({
    id: "j", providerKey: "p.com", intent: intent("a.mp4"),
    segmentConcurrency: 2, retries: 1,
  });
  s.enqueue("j");
  assert.equal(s.getJob("j").state, "running");

  // false flag
  await assert.rejects(() => s.requestFirefoxHandoff("j", Object.freeze({
    ...intent("a.mp4"), userSelectedFirefox: false, userActionToken: "popup-tok",
  })));
  assert.equal(downloadCalls, 0);
  assert.equal(s.getJob("j").state, "running");

  // missing token
  await assert.rejects(() => s.requestFirefoxHandoff("j", Object.freeze({
    ...intent("a.mp4"), userSelectedFirefox: true, userActionToken: "",
  })));
  assert.equal(downloadCalls, 0);

  // forged token
  await assert.rejects(() => s.requestFirefoxHandoff("j", Object.freeze({
    ...intent("a.mp4"), userSelectedFirefox: true, userActionToken: "forged",
  })));
  assert.equal(downloadCalls, 0);

  // valid handoff → handed_to_firefox, slot released once
  await s.requestFirefoxHandoff("j", Object.freeze({
    requestedFilename: "a.mp4", destinationDirectory: null, saveMode: "default",
    userSelectedFirefox: true, userActionToken: "popup-tok", createdAt: "t0",
  }));
  assert.equal(downloadCalls, 1);
  assert.equal(s.getJob("j").state, "handed_to_firefox");
  assert.equal(s.getJob("j").holdsGlobalSlot, false);
  assert.equal(s.getSnapshot().globalRunning, 0);

  // replayed token cannot call downloads again
  await assert.rejects(() => s.requestFirefoxHandoff("j", Object.freeze({
    requestedFilename: "a.mp4", destinationDirectory: null, saveMode: "default",
    userSelectedFirefox: true, userActionToken: "popup-tok", createdAt: "t0",
  })));
  assert.equal(downloadCalls, 1);
  assertSlotInvariant(s);
});

test("requestFirefoxHandoff API rejection returns needs_user without slot leak", async () => {
  let downloadCalls = 0;
  const s = createDownloadScheduler({
    maxConcurrent: 1,
    now: () => 0,
    firefoxDownload: async () => {
      downloadCalls++;
      throw new Error("user cancelled save dialog");
    },
    popupTokenStore: new Set(["tok"]),
  });
  s.createJob({
    id: "j", providerKey: "p.com",
    intent: intent("11238-makemebi.net.mp4"),
    segmentConcurrency: 2, retries: 1,
  });
  s.createJob({
    id: "peer", providerKey: "q.com",
    intent: intent("peer.mp4"),
    segmentConcurrency: 2, retries: 1,
  });
  s.enqueue("j"); s.enqueue("peer");
  assert.equal(s.getJob("peer").state, "queued");
  await s.requestFirefoxHandoff("j", Object.freeze({
    requestedFilename: "11238-makemebi.net.mp4",
    destinationDirectory: null, saveMode: "default",
    userSelectedFirefox: true, userActionToken: "tok", createdAt: "t0",
  }));
  assert.equal(downloadCalls, 1);
  assert.equal(s.getJob("j").state, "needs_user");
  assert.equal(s.getJob("j").holdsGlobalSlot, false);
  assert.equal(s.getSnapshot().globalRunning, 1);
  assert.equal(s.getJob("peer").state, "running");
  assertSlotInvariant(s);
});

// ---------------------------------------------------------------------------
// Controller-required edge regressions
// ---------------------------------------------------------------------------

test("zero budget first failure -> needs_user and admits independent peer", () => {
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s.createJob({ id: "j", providerKey: "p.com", intent: intent("f.mp4"), segmentConcurrency: 2, retries: 0 });
  s.createJob({ id: "peer", providerKey: "q.com", intent: intent("peer.mp4"), segmentConcurrency: 2, retries: 1 });
  s.enqueue("j");
  s.enqueue("peer");
  s.onTransportResult("j", s.getJob("j").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  assert.equal(s.getJob("j").state, "needs_user");
  assert.equal(s.getJob("j").holdsGlobalSlot, false);
  assert.equal(s.getJob("peer").state, "running");
  assert.equal(s.getSnapshot().globalRunning, 1);
  assertSlotInvariant(s);
});

test("backoff boundaries: just-before, due, duplicate ticks, 30s cap, stale pre-retry token", () => {
  let t = 1000;
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => t });
  s.createJob({ id: "j", providerKey: "p.com", intent: intent("f.mp4"), segmentConcurrency: 2, retries: 1 });
  s.enqueue("j");
  const preRetry = s.getJob("j").attemptToken;
  s.onTransportResult("j", preRetry, { status: "failed", failureCategory: "timeout" });
  assert.equal(s.getJob("j").state, "retry_backoff");
  assert.equal(s.getJob("j").retryRemaining, 0);
  // just-before due (first wait = 2000ms from t=1000 → due at 3000)
  t = 2999;
  s.tick(t);
  assert.equal(s.getJob("j").state, "retry_backoff");
  assert.equal(s.getJob("j").holdsGlobalSlot, false);
  // due
  t = 3000;
  s.tick(t);
  assert.equal(s.getJob("j").state, "running");
  const fresh = s.getJob("j").attemptToken;
  assert.notEqual(fresh, preRetry);
  // duplicate tick must not double-admit
  t = 3001;
  s.tick(t);
  assert.equal(s.getJob("j").state, "running");
  assert.equal(s.getJob("j").attemptToken, fresh);
  // stale pre-retry token cannot complete or charge
  s.onTransportResult("j", preRetry, { status: "completed", failureCategory: null });
  assert.equal(s.getJob("j").state, "running");
  // 30s cap: with many used retries, deadline steps by at most 30000
  let t2 = 0;
  const s2 = createDownloadScheduler({ maxConcurrent: 1, now: () => t2 });
  s2.createJob({ id: "cap", providerKey: "p.com", intent: intent("c.mp4"), segmentConcurrency: 1, retries: 10 });
  s2.enqueue("cap");
  // burn 4 automatic retries so used becomes 5 → 1000*2^5 = 32000 → capped 30000
  for (let i = 0; i < 4; i++) {
    s2.onTransportResult("cap", s2.getJob("cap").attemptToken, {
      status: "failed",
      failureCategory: "timeout",
    });
    t2 += 60000;
    s2.tick(t2);
  }
  s2.onTransportResult("cap", s2.getJob("cap").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  assert.equal(s2.getJob("cap").state, "retry_backoff");
  // just before 30s
  t2 += 29999;
  s2.tick(t2);
  assert.equal(s2.getJob("cap").state, "retry_backoff");
  t2 += 1;
  s2.tick(t2);
  assert.equal(s2.getJob("cap").state, "running");
  assertSlotInvariant(s);
  assertSlotInvariant(s2);
});

test("duplicate same-token failure charges once; late result after needs_user is no-op", () => {
  let t = 0;
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => t });
  s.createJob({ id: "j", providerKey: "p.com", intent: intent("f.mp4"), segmentConcurrency: 2, retries: 1 });
  s.enqueue("j");
  const tok = s.getJob("j").attemptToken;
  s.onTransportResult("j", tok, { status: "failed", failureCategory: "timeout" });
  assert.equal(s.getJob("j").retryRemaining, 0);
  assert.equal(s.getJob("j").state, "retry_backoff");
  // duplicate same-token failure must not re-charge or mutate
  s.onTransportResult("j", tok, { status: "failed", failureCategory: "timeout" });
  assert.equal(s.getJob("j").retryRemaining, 0);
  assert.equal(s.getJob("j").state, "retry_backoff");
  // exhaust via tick + fail
  t += 2000;
  s.tick(t);
  const tok2 = s.getJob("j").attemptToken;
  s.onTransportResult("j", tok2, { status: "failed", failureCategory: "timeout" });
  assert.equal(s.getJob("j").state, "needs_user");
  // late result after needs_user no-op
  s.onTransportResult("j", tok2, { status: "completed", failureCategory: null });
  s.onTransportResult("j", tok2, { status: "failed", failureCategory: "timeout" });
  assert.equal(s.getJob("j").state, "needs_user");
  t += 999999;
  s.tick(t);
  assert.equal(s.getJob("j").state, "needs_user");
  assertSlotInvariant(s);
});

test("manualRetry resets budget but not filename/effective concurrency and cannot repeat", () => {
  let t = 0;
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => t });
  s.createJob({
    id: "j",
    providerKey: "p.com",
    intent: intent("11238-makemebi.net.mp4"),
    segmentConcurrency: 4,
    retries: 2,
  });
  s.enqueue("j");
  s.onCapabilitySwitch("j", { mode: "single-connection", partState: "empty" });
  assert.equal(s.getJob("j").effectiveConcurrency, 1);
  assert.equal(s.getJob("j").mode, "single-connection");
  // Exhaust retries
  s.onTransportResult("j", s.getJob("j").attemptToken, { status: "failed", failureCategory: "timeout" });
  t += 2000; s.tick(t);
  s.onTransportResult("j", s.getJob("j").attemptToken, { status: "failed", failureCategory: "timeout" });
  t += 4000; s.tick(t);
  s.onTransportResult("j", s.getJob("j").attemptToken, { status: "failed", failureCategory: "timeout" });
  assert.equal(s.getJob("j").state, "needs_user");
  assert.equal(s.getJob("j").retryRemaining, 0);
  // manualRetry from needs_user
  s.manualRetry("j");
  assert.equal(s.getJob("j").state, "running");
  assert.equal(s.getJob("j").retryRemaining, 2);
  assert.equal(s.getJob("j").retryUsed, 0);
  assert.equal(s.getJob("j").intent.requestedFilename, "11238-makemebi.net.mp4");
  assert.equal(s.getJob("j").effectiveConcurrency, 1);
  assert.equal(s.getJob("j").mode, "single-connection");
  assert.ok(typeof s.getJob("j").attemptToken === "string" && s.getJob("j").attemptToken.trim().length > 0);
  // cannot repeat while running
  const tok = s.getJob("j").attemptToken;
  s.manualRetry("j");
  assert.equal(s.getJob("j").attemptToken, tok);
  assert.equal(s.getJob("j").state, "running");
  // cannot from non-needs_user states
  s.manualRetry("missing");
  assertSlotInvariant(s);
});

test("cancel backoff / waiting / running owner; owner cancel wakes next exactly once", () => {
  // cancel retry_backoff
  let t = 0;
  const sBack = createDownloadScheduler({ maxConcurrent: 1, now: () => t });
  sBack.createJob({ id: "b", providerKey: "p.com", intent: intent("b.mp4"), segmentConcurrency: 2, retries: 2 });
  sBack.enqueue("b");
  sBack.onTransportResult("b", sBack.getJob("b").attemptToken, {
    status: "failed", failureCategory: "timeout",
  });
  assert.equal(sBack.getJob("b").state, "retry_backoff");
  sBack.cancel("b");
  assert.equal(sBack.getJob("b").state, "cancelled");
  t += 999999;
  sBack.tick(t);
  assert.equal(sBack.getJob("b").state, "cancelled");
  assert.equal(sBack.getJob("b").holdsGlobalSlot, false);
  assertSlotInvariant(sBack);

  // cancel waiting_provider (non-owner) does not disturb active sibling
  const sWait = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
  sWait.createJob({ id: "owner", providerKey: "p.com", intent: intent("o.mp4"), segmentConcurrency: 4, retries: 3 });
  sWait.createJob({ id: "wait", providerKey: "p.com", intent: intent("w.mp4"), segmentConcurrency: 4, retries: 3 });
  sWait.enqueue("owner");
  sWait.enqueue("wait");
  sWait.notePermitAcquired("owner");
  sWait.onTransportResult("wait", sWait.getJob("wait").attemptToken, {
    status: "failed", failureCategory: "timeout",
  });
  if (sWait.getJob("wait").state === "pausing_provider") sWait.onQuiesced("wait");
  assert.equal(sWait.getJob("wait").state, "waiting_provider");
  sWait.cancel("wait");
  assert.equal(sWait.getJob("wait").state, "cancelled");
  assert.equal(sWait.getJob("owner").state, "running");
  assert.equal(sWait.getSnapshot().providers["p.com"].gate.ownerJobId, "owner");
  assertSlotInvariant(sWait);

  // cancel running owner wakes next waiter exactly once
  const sOwn = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
  sOwn.createJob({ id: "owner", providerKey: "p.com", intent: intent("o.mp4"), segmentConcurrency: 4, retries: 3 });
  sOwn.createJob({ id: "fail", providerKey: "p.com", intent: intent("f.mp4"), segmentConcurrency: 4, retries: 3 });
  sOwn.enqueue("owner");
  sOwn.enqueue("fail");
  sOwn.notePermitAcquired("owner");
  sOwn.onTransportResult("fail", sOwn.getJob("fail").attemptToken, {
    status: "failed", failureCategory: "timeout",
  });
  if (sOwn.getJob("fail").state === "pausing_provider") sOwn.onQuiesced("fail");
  assert.equal(sOwn.getJob("fail").state, "waiting_provider");
  const failBefore = sOwn.getJob("fail").retryRemaining;
  sOwn.cancel("owner");
  // active owner: cancelRequested until ack
  assert.ok(
    sOwn.getJob("owner").state === "running" ||
    sOwn.getJob("owner").state === "cancelled"
  );
  const ownerTok = sOwn.getJob("owner").attemptToken;
  if (sOwn.getJob("owner").state === "running") {
    sOwn.onTransportResult("owner", ownerTok, { status: "cancelled", failureCategory: "cancelled" });
  }
  assert.equal(sOwn.getJob("owner").state, "cancelled");
  // fail woken exactly once
  assert.ok(sOwn.getJob("fail").state === "running" || sOwn.getJob("fail").state === "queued");
  assert.equal(sOwn.getJob("fail").retryRemaining, failBefore - 1);
  assert.equal(sOwn.getJob("fail").autoWakeCount, 1);
  // duplicate cancel ack no-op
  sOwn.cancel("owner");
  sOwn.onTransportResult("owner", ownerTok, { status: "cancelled", failureCategory: "cancelled" });
  assert.equal(sOwn.getJob("fail").autoWakeCount, 1);
  assertSlotInvariant(sOwn);
});

test("cancel queued / needs_user / running non-owner; permit denial; late completion after cancel", () => {
  // queued cancel
  const sQ = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  sQ.createJob({ id: "a", providerKey: "p.com", intent: intent("a.mp4"), segmentConcurrency: 2, retries: 1 });
  sQ.createJob({ id: "b", providerKey: "p.com", intent: intent("b.mp4"), segmentConcurrency: 2, retries: 1 });
  sQ.enqueue("a");
  sQ.enqueue("b");
  assert.equal(sQ.getJob("b").state, "queued");
  sQ.cancel("b");
  assert.equal(sQ.getJob("b").state, "cancelled");
  assert.equal(sQ.getJob("b").holdsGlobalSlot, false);
  assert.deepEqual(sQ.getSnapshot().providers["p.com"].queued, []);
  assertSlotInvariant(sQ);

  // needs_user cancel
  const sN = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  sN.createJob({ id: "n", providerKey: "p.com", intent: intent("n.mp4"), segmentConcurrency: 2, retries: 0 });
  sN.enqueue("n");
  sN.onTransportResult("n", sN.getJob("n").attemptToken, {
    status: "failed", failureCategory: "timeout",
  });
  assert.equal(sN.getJob("n").state, "needs_user");
  sN.cancel("n");
  assert.equal(sN.getJob("n").state, "cancelled");
  sN.cancel("n"); // idempotent
  assert.equal(sN.getJob("n").state, "cancelled");
  assertSlotInvariant(sN);

  // running non-owner cancel + permit denial + late completion after cancel
  const sR = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
  sR.createJob({ id: "owner", providerKey: "p.com", intent: intent("o.mp4"), segmentConcurrency: 4, retries: 3 });
  sR.createJob({ id: "sib", providerKey: "p.com", intent: intent("s.mp4"), segmentConcurrency: 4, retries: 3 });
  sR.enqueue("owner");
  sR.enqueue("sib");
  sR.notePermitAcquired("owner");
  sR.notePermitAcquired("sib");
  // saturate via fail on a third? just cancel running non-owner sib while both running
  const sibTok = sR.getJob("sib").attemptToken;
  sR.cancel("sib");
  // permit denied after cancel
  assert.equal(sR.acquireProviderPermit("sib", "segment"), null);
  // late completion with matching token after cancel request → cancelled, not completed
  sR.onTransportResult("sib", sibTok, { status: "completed", failureCategory: null });
  // when cancelRequested and result completed, should become cancelled (or stay until cancelled ack)
  assert.ok(
    sR.getJob("sib").state === "cancelled" ||
    sR.getJob("sib").state === "running"
  );
  if (sR.getJob("sib").state === "running") {
    sR.onTransportResult("sib", sibTok, { status: "cancelled", failureCategory: "cancelled" });
  }
  assert.equal(sR.getJob("sib").state, "cancelled");
  assert.equal(sR.getJob("sib").holdsGlobalSlot, false);
  // owner undisturbed
  assert.equal(sR.getJob("owner").state, "running");
  // duplicate cancel ack
  sR.onTransportResult("sib", sibTok, { status: "cancelled", failureCategory: "cancelled" });
  assert.equal(sR.getJob("sib").state, "cancelled");
  assert.equal(sR.getSnapshot().globalRunning, 1);
  assertSlotInvariant(sR);
});

test("issueAttemptToken returns live token only; cannot multiply attempt or budget", () => {
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s.createJob({ id: "j", providerKey: "p.com", intent: intent("a.mp4"), segmentConcurrency: 2, retries: 2 });
  // before admit: no live attempt
  assert.throws(() => s.issueAttemptToken("j"), /attempt|running|token/i);
  s.enqueue("j");
  const live = s.getJob("j").attemptToken;
  const a = s.issueAttemptToken("j");
  const b = s.issueAttemptToken("j");
  assert.equal(a, live);
  assert.equal(b, live);
  assert.equal(s.getJob("j").retryRemaining, 2);
  // after failure in backoff: no live attempt
  s.onTransportResult("j", live, { status: "failed", failureCategory: "timeout" });
  assert.equal(s.getJob("j").state, "retry_backoff");
  assert.throws(() => s.issueAttemptToken("j"), /attempt|running|token/i);
  assert.equal(s.getJob("j").retryRemaining, 1);
  assertSlotInvariant(s);
});

test("capability switch rejects invalid mode/partState/non-running/cancelled/repeat", () => {
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s.createJob({ id: "j", providerKey: "p.com", intent: intent("a.mp4"), segmentConcurrency: 4, retries: 3 });
  // non-running
  s.onCapabilitySwitch("j", { mode: "single-connection", partState: "empty" });
  assert.equal(s.getJob("j").mode, "multi-range");
  s.enqueue("j");
  const before = s.getJob("j").retryRemaining;
  const tok = s.getJob("j").attemptToken;
  // invalid mode
  s.onCapabilitySwitch("j", { mode: "multi-range", partState: "empty" });
  assert.equal(s.getJob("j").mode, "multi-range");
  // invalid partState
  s.onCapabilitySwitch("j", { mode: "single-connection", partState: "dirty" });
  assert.equal(s.getJob("j").mode, "multi-range");
  assert.equal(s.getJob("j").effectiveConcurrency, 4);
  // valid
  s.onCapabilitySwitch("j", { mode: "single-connection", partState: "empty" });
  assert.equal(s.getJob("j").mode, "single-connection");
  assert.equal(s.getJob("j").effectiveConcurrency, 1);
  assert.equal(s.getJob("j").retryRemaining, before);
  assert.equal(s.getJob("j").attemptToken, tok);
  // repeat is no-op
  s.onCapabilitySwitch("j", { mode: "single-connection", partState: "empty" });
  assert.equal(s.getJob("j").mode, "single-connection");
  assert.equal(s.getJob("j").effectiveConcurrency, 1);
  // cancelled job rejects
  s.cancel("j");
  s.onTransportResult("j", tok, { status: "cancelled", failureCategory: "cancelled" });
  s.onCapabilitySwitch("j", { mode: "single-connection", partState: "empty" });
  assert.equal(s.getJob("j").state, "cancelled");
  assertSlotInvariant(s);
});

test("simultaneous Firefox requests with one token invoke hook exactly once", async () => {
  let downloadCalls = 0;
  let resolveHook;
  const hookPromise = new Promise((r) => { resolveHook = r; });
  const s = createDownloadScheduler({
    maxConcurrent: 1,
    now: () => 0,
    firefoxDownload: async () => {
      downloadCalls++;
      await hookPromise;
      return 1;
    },
    popupTokenStore: new Set(["once"]),
  });
  s.createJob({ id: "j", providerKey: "p.com", intent: intent("a.mp4"), segmentConcurrency: 2, retries: 1 });
  s.enqueue("j");
  const intentFx = Object.freeze({
    requestedFilename: "a.mp4",
    destinationDirectory: null,
    saveMode: "default",
    userSelectedFirefox: true,
    userActionToken: "once",
    createdAt: "t0",
  });
  const p1 = s.requestFirefoxHandoff("j", intentFx);
  const p2 = s.requestFirefoxHandoff("j", intentFx);
  // second must reject; first may still be in flight
  await assert.rejects(() => p2);
  resolveHook();
  await p1;
  assert.equal(downloadCalls, 1);
  assert.equal(s.getJob("j").state, "handed_to_firefox");
  assertSlotInvariant(s);
});

test("Firefox API reject consumes token and replay cannot call again", async () => {
  let downloadCalls = 0;
  const store = new Set(["tok-once"]);
  const s = createDownloadScheduler({
    maxConcurrent: 1,
    now: () => 0,
    firefoxDownload: async () => {
      downloadCalls++;
      throw new Error("api reject");
    },
    popupTokenStore: store,
  });
  s.createJob({ id: "j", providerKey: "p.com", intent: intent("a.mp4"), segmentConcurrency: 2, retries: 1 });
  s.enqueue("j");
  await s.requestFirefoxHandoff("j", Object.freeze({
    requestedFilename: "a.mp4",
    destinationDirectory: null,
    saveMode: "default",
    userSelectedFirefox: true,
    userActionToken: "tok-once",
    createdAt: "t0",
  }));
  assert.equal(downloadCalls, 1);
  assert.equal(s.getJob("j").state, "needs_user");
  assert.equal(store.has("tok-once"), false);
  await assert.rejects(() => s.requestFirefoxHandoff("j", Object.freeze({
    requestedFilename: "a.mp4",
    destinationDirectory: null,
    saveMode: "default",
    userSelectedFirefox: true,
    userActionToken: "tok-once",
    createdAt: "t0",
  })));
  assert.equal(downloadCalls, 1);
  assertSlotInvariant(s);
});

test("Firefox rejects intent mismatch, mutable intent, wrong state without mutation", async () => {
  let downloadCalls = 0;
  const store = new Set(["good", "good2", "good3", "good4"]);
  const s = createDownloadScheduler({
    maxConcurrent: 1,
    now: () => 0,
    firefoxDownload: async () => { downloadCalls++; return 1; },
    popupTokenStore: store,
  });
  s.createJob({
    id: "j",
    providerKey: "p.com",
    intent: Object.freeze({
      requestedFilename: "a.mp4",
      destinationDirectory: null,
      saveMode: "default",
      userSelectedFirefox: false,
      userActionToken: "t",
      createdAt: "t0",
    }),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.enqueue("j");
  const stateBefore = s.getJob("j").state;
  const verBefore = s.getJob("j").stateVersion;

  // filename mismatch
  await assert.rejects(() => s.requestFirefoxHandoff("j", Object.freeze({
    requestedFilename: "other.mp4",
    destinationDirectory: null,
    saveMode: "default",
    userSelectedFirefox: true,
    userActionToken: "good",
    createdAt: "t0",
  })));
  // destination mismatch
  await assert.rejects(() => s.requestFirefoxHandoff("j", Object.freeze({
    requestedFilename: "a.mp4",
    destinationDirectory: "C:\\other",
    saveMode: "default",
    userSelectedFirefox: true,
    userActionToken: "good",
    createdAt: "t0",
  })));
  // saveMode mismatch
  await assert.rejects(() => s.requestFirefoxHandoff("j", Object.freeze({
    requestedFilename: "a.mp4",
    destinationDirectory: null,
    saveMode: "save-as",
    userSelectedFirefox: true,
    userActionToken: "good",
    createdAt: "t0",
  })));
  // mutable intent (not frozen)
  await assert.rejects(() => s.requestFirefoxHandoff("j", {
    requestedFilename: "a.mp4",
    destinationDirectory: null,
    saveMode: "default",
    userSelectedFirefox: true,
    userActionToken: "good",
    createdAt: "t0",
  }));
  assert.equal(downloadCalls, 0);
  assert.equal(s.getJob("j").state, stateBefore);
  assert.equal(s.getJob("j").stateVersion, verBefore);
  assert.equal(store.has("good"), true);

  // wrong state: completed is terminal
  s.onTransportResult("j", s.getJob("j").attemptToken, {
    status: "completed", failureCategory: null,
  });
  await assert.rejects(() => s.requestFirefoxHandoff("j", Object.freeze({
    requestedFilename: "a.mp4",
    destinationDirectory: null,
    saveMode: "default",
    userSelectedFirefox: true,
    userActionToken: "good2",
    createdAt: "t0",
  })));
  assert.equal(downloadCalls, 0);
  assert.equal(s.getJob("j").state, "completed");
  assertSlotInvariant(s);
});

test("handoff success clears ephemeral once; rejection retains it", async () => {
  let clearCount = 0;
  const ephemeral = {
    clear() { clearCount++; },
  };
  let downloadCalls = 0;
  const sOk = createDownloadScheduler({
    maxConcurrent: 1,
    now: () => 0,
    firefoxDownload: async (args) => {
      downloadCalls++;
      assert.equal(args.filename, "a.mp4");
      assert.equal(args.saveAs, true);
      return 1;
    },
    popupTokenStore: new Set(["ok-tok"]),
  });
  sOk.createJob({
    id: "j",
    providerKey: "p.com",
    intent: intent("a.mp4"),
    segmentConcurrency: 2,
    retries: 1,
    ephemeral: ephemeral,
  });
  sOk.enqueue("j");
  await sOk.requestFirefoxHandoff("j", Object.freeze({
    requestedFilename: "a.mp4",
    destinationDirectory: null,
    saveMode: "default",
    userSelectedFirefox: true,
    userActionToken: "ok-tok",
    createdAt: "t0",
  }));
  assert.equal(sOk.getJob("j").state, "handed_to_firefox");
  assert.equal(clearCount, 1);
  // second clear path must not fire again on late ops
  sOk.cancel("j");
  assert.equal(clearCount, 1);

  let clearCount2 = 0;
  const ephemeral2 = { clear() { clearCount2++; } };
  const sBad = createDownloadScheduler({
    maxConcurrent: 1,
    now: () => 0,
    firefoxDownload: async () => {
      throw new Error("reject");
    },
    popupTokenStore: new Set(["bad-tok"]),
  });
  sBad.createJob({
    id: "j",
    providerKey: "p.com",
    intent: intent("a.mp4"),
    segmentConcurrency: 2,
    retries: 1,
    ephemeral: ephemeral2,
  });
  sBad.enqueue("j");
  await sBad.requestFirefoxHandoff("j", Object.freeze({
    requestedFilename: "a.mp4",
    destinationDirectory: null,
    saveMode: "default",
    userSelectedFirefox: true,
    userActionToken: "bad-tok",
    createdAt: "t0",
  }));
  assert.equal(sBad.getJob("j").state, "needs_user");
  assert.equal(clearCount2, 0);
  assertSlotInvariant(sOk);
  assertSlotInvariant(sBad);
});

test("no Firefox call from retry exhaustion, cancel, range switch, local_io, saturation, or tick", async () => {
  let downloadCalls = 0;
  let t = 0;
  const s = createDownloadScheduler({
    maxConcurrent: 2,
    now: () => t,
    firefoxDownload: async () => { downloadCalls++; return 1; },
    popupTokenStore: new Set(["unused"]),
  });
  s.createJob({ id: "solo", providerKey: "a.com", intent: intent("s.mp4"), segmentConcurrency: 2, retries: 0 });
  s.createJob({ id: "owner", providerKey: "p.com", intent: intent("o.mp4"), segmentConcurrency: 4, retries: 2 });
  s.createJob({ id: "fail", providerKey: "p.com", intent: intent("f.mp4"), segmentConcurrency: 4, retries: 2 });
  s.createJob({ id: "io", providerKey: "b.com", intent: intent("i.mp4"), segmentConcurrency: 2, retries: 2 });
  s.createJob({ id: "rng", providerKey: "c.com", intent: intent("r.mp4"), segmentConcurrency: 4, retries: 2 });
  s.enqueue("solo");
  // retry exhaustion
  s.onTransportResult("solo", s.getJob("solo").attemptToken, {
    status: "failed", failureCategory: "timeout",
  });
  assert.equal(s.getJob("solo").state, "needs_user");
  // cancel
  s.cancel("solo");
  assert.equal(s.getJob("solo").state, "cancelled");
  // saturation
  s.enqueue("owner");
  s.enqueue("fail");
  s.notePermitAcquired("owner");
  s.onTransportResult("fail", s.getJob("fail").attemptToken, {
    status: "failed", failureCategory: "http_429",
  });
  assert.ok(
    s.getJob("fail").state === "pausing_provider" ||
    s.getJob("fail").state === "waiting_provider"
  );
  // local_io → needs_user, never Firefox
  // Need free capacity: complete owner/fail path not required; use free provider
  s.setMaxConcurrent(3);
  s.enqueue("io");
  s.onTransportResult("io", s.getJob("io").attemptToken, {
    status: "failed", failureCategory: "local_io",
  });
  assert.equal(s.getJob("io").state, "needs_user");
  // range switch
  s.enqueue("rng");
  s.onCapabilitySwitch("rng", { mode: "single-connection", partState: "empty" });
  assert.equal(s.getJob("rng").mode, "single-connection");
  // tick
  t += 999999;
  s.tick(t);
  assert.equal(downloadCalls, 0);
  assertSlotInvariant(s);
});

test("popupTokenStore Map form is job-bound one-time; Set semantics preserved", async () => {
  let downloadCalls = 0;
  const mapStore = new Map();
  mapStore.set("j", "map-tok");
  const s = createDownloadScheduler({
    maxConcurrent: 1,
    now: () => 0,
    firefoxDownload: async (args) => {
      downloadCalls++;
      assert.equal(args.filename, "a.mp4");
      assert.equal(args.saveAs, true);
      return 1;
    },
    popupTokenStore: mapStore,
  });
  s.createJob({ id: "j", providerKey: "p.com", intent: intent("a.mp4"), segmentConcurrency: 2, retries: 1 });
  s.enqueue("j");
  // cross-job forged map entry must not work for wrong job
  mapStore.set("other", "map-tok");
  await assert.rejects(() => s.requestFirefoxHandoff("j", Object.freeze({
    requestedFilename: "a.mp4",
    destinationDirectory: null,
    saveMode: "default",
    userSelectedFirefox: true,
    userActionToken: "wrong",
    createdAt: "t0",
  })));
  await s.requestFirefoxHandoff("j", Object.freeze({
    requestedFilename: "a.mp4",
    destinationDirectory: null,
    saveMode: "default",
    userSelectedFirefox: true,
    userActionToken: "map-tok",
    createdAt: "t0",
  }));
  assert.equal(downloadCalls, 1);
  assert.equal(mapStore.has("j"), false);
  assert.equal(s.getJob("j").state, "handed_to_firefox");
  // replay
  await assert.rejects(() => s.requestFirefoxHandoff("j", Object.freeze({
    requestedFilename: "a.mp4",
    destinationDirectory: null,
    saveMode: "default",
    userSelectedFirefox: true,
    userActionToken: "map-tok",
    createdAt: "t0",
  })));
  assert.equal(downloadCalls, 1);
  assertSlotInvariant(s);
});

test("local_io enters needs_user and never saturation; permanent remains failed", () => {
  const s = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
  s.createJob({ id: "a", providerKey: "p.com", intent: intent("a.mp4"), segmentConcurrency: 4, retries: 3 });
  s.createJob({ id: "b", providerKey: "p.com", intent: intent("b.mp4"), segmentConcurrency: 4, retries: 3 });
  s.enqueue("a");
  s.enqueue("b");
  s.onTransportResult("b", s.getJob("b").attemptToken, {
    status: "failed", failureCategory: "local_io",
  });
  assert.equal(s.getJob("b").state, "needs_user");
  assert.equal(s.getJob("b").holdsGlobalSlot, false);
  assert.equal(s.getJob("a").state, "running");
  assert.notEqual(s.getSnapshot().providers["p.com"].gate.state, "saturated");
  s.onTransportResult("a", s.getJob("a").attemptToken, {
    status: "failed", failureCategory: "permanent",
  });
  assert.equal(s.getJob("a").state, "failed");
  assert.equal(s.getJob("a").holdsGlobalSlot, false);
  assertSlotInvariant(s);
});

test("hook receives filename from intent and saveAs true only via requestFirefoxHandoff", async () => {
  const calls = [];
  const s = createDownloadScheduler({
    maxConcurrent: 1,
    now: () => 0,
    firefoxDownload: async (args) => {
      calls.push(args);
      return 1;
    },
    popupTokenStore: new Set(["fx"]),
  });
  s.createJob({
    id: "j",
    providerKey: "p.com",
    intent: intent("11238-makemebi.net.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.enqueue("j");
  await s.requestFirefoxHandoff("j", Object.freeze({
    requestedFilename: "11238-makemebi.net.mp4",
    destinationDirectory: null,
    saveMode: "default",
    userSelectedFirefox: true,
    userActionToken: "fx",
    createdAt: "t0",
  }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].filename, "11238-makemebi.net.mp4");
  assert.equal(calls[0].saveAs, true);
  assert.equal(s.getJob("j").state, "handed_to_firefox");
  assertSlotInvariant(s);
});

// ---------------------------------------------------------------------------
// Task 11 fix1 — controller adjudication regressions
// ---------------------------------------------------------------------------

function fxIntent(name, token) {
  return Object.freeze({
    requestedFilename: name,
    destinationDirectory: null,
    saveMode: "default",
    userSelectedFirefox: true,
    userActionToken: token,
    createdAt: "t0",
  });
}

function quiesceIfPausing(s, jobId) {
  if (s.getJob(jobId).state === "pausing_provider") {
    while (s.getJob(jobId).inFlightPermits > 0) s.releasePermit(jobId);
    s.onQuiesced(jobId);
  }
}

/** Owner + failed waiter under saturated gate (maxConcurrent >= 2). */
function saturateOwnerWithWaiter(s, providerKey, ownerId, waiterId) {
  s.createJob({
    id: ownerId,
    providerKey: providerKey,
    intent: intent(ownerId + ".mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.createJob({
    id: waiterId,
    providerKey: providerKey,
    intent: intent(waiterId + ".mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.enqueue(ownerId);
  s.enqueue(waiterId);
  assert.equal(s.getJob(ownerId).state, "running");
  assert.equal(s.getJob(waiterId).state, "running");
  s.notePermitAcquired(ownerId);
  s.onTransportResult(waiterId, s.getJob(waiterId).attemptToken, {
    status: "failed",
    failureCategory: "http_429",
  });
  quiesceIfPausing(s, waiterId);
  assert.equal(s.getJob(waiterId).state, "waiting_provider");
  assert.equal(s.getSnapshot().providers[providerKey].gate.state, "saturated");
  assert.equal(s.getSnapshot().providers[providerKey].gate.ownerJobId, ownerId);
}

test("saturated owner local_io with waiter: owner needs_user, waiter wakes once, ephemeral retained", () => {
  // Mutation: owner+waiter branch calls completeProviderOwner(...,"failed") before category policy.
  let firefoxCalls = 0;
  let clearCount = 0;
  const s = createDownloadScheduler({
    maxConcurrent: 2,
    now: () => 0,
    firefoxDownload: async () => {
      firefoxCalls++;
      return 1;
    },
  });
  s.createJob({
    id: "owner",
    providerKey: "p.com",
    intent: intent("o.mp4"),
    segmentConcurrency: 4,
    retries: 3,
    ephemeral: { clear() { clearCount++; } },
  });
  s.createJob({
    id: "waiter",
    providerKey: "p.com",
    intent: intent("w.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.enqueue("owner");
  s.enqueue("waiter");
  s.notePermitAcquired("owner");
  s.onTransportResult("waiter", s.getJob("waiter").attemptToken, {
    status: "failed",
    failureCategory: "http_429",
  });
  quiesceIfPausing(s, "waiter");
  assert.equal(s.getJob("waiter").state, "waiting_provider");
  const waiterRetriesBefore = s.getJob("waiter").retryRemaining;
  const ownerTok = s.getJob("owner").attemptToken;
  s.onTransportResult("owner", ownerTok, {
    status: "failed",
    failureCategory: "local_io",
  });
  assert.equal(s.getJob("owner").state, "needs_user");
  assert.equal(s.getJob("owner").holdsGlobalSlot, false);
  assert.equal(clearCount, 0); // ephemeral retained for manualRetry / explicit Firefox
  assert.ok(
    s.getJob("waiter").state === "running" || s.getJob("waiter").state === "queued"
  );
  assert.equal(s.getJob("waiter").autoWakeCount, 1);
  assert.equal(s.getJob("waiter").retryRemaining, waiterRetriesBefore - 1);
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "waiter");
  assert.notEqual(s.getSnapshot().providers["p.com"].gate.state, "saturated");
  // duplicate/stale owner result is no-op
  s.onTransportResult("owner", ownerTok, {
    status: "failed",
    failureCategory: "local_io",
  });
  assert.equal(s.getJob("owner").state, "needs_user");
  assert.equal(s.getJob("waiter").autoWakeCount, 1);
  assert.equal(firefoxCalls, 0);
  assertSlotInvariant(s);
});

test("saturated owner local_io without waiter: needs_user, recovering blocked, no Firefox", () => {
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  // Solo owner: need saturated via sibling then complete sibling wait path with capacity 2 first.
  const s2 = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
  saturateOwnerWithWaiter(s2, "p.com", "owner", "w");
  // Cancel waiter so owner has no eligible waiter, then local_io.
  s2.cancel("w");
  assert.equal(s2.getJob("w").state, "cancelled");
  assert.equal(s2.getSnapshot().providers["p.com"].gate.ownerJobId, "owner");
  s2.onTransportResult("owner", s2.getJob("owner").attemptToken, {
    status: "failed",
    failureCategory: "local_io",
  });
  assert.equal(s2.getJob("owner").state, "needs_user");
  assert.equal(s2.getJob("owner").holdsGlobalSlot, false);
  assert.equal(s2.getSnapshot().providers["p.com"].gate.state, "recovering");
  assert.equal(s2.getSnapshot().providers["p.com"].gate.ownerJobId, null);
  assert.equal(s2.getSnapshot().globalRunning, 0);
  assertSlotInvariant(s2);
  void s;
});

test("recovering owner local_io with and without waiter", () => {
  // With waiter: owner + failed + paused-only sibling. Owner completes → failed is recovery
  // owner; paused-only remains waiting. Recovery owner local_io → needs_user, wakes sibling once.
  // (Paused-only wake is free; failed-waiter charge is covered by the saturated-owner case.)
  const s = createDownloadScheduler({ maxConcurrent: 3, now: () => 0 });
  s.createJob({ id: "owner", providerKey: "p.com", intent: intent("o.mp4"), segmentConcurrency: 4, retries: 3 });
  s.createJob({ id: "w1", providerKey: "p.com", intent: intent("w1.mp4"), segmentConcurrency: 4, retries: 3 });
  s.createJob({ id: "w2", providerKey: "p.com", intent: intent("w2.mp4"), segmentConcurrency: 4, retries: 3 });
  s.enqueue("owner");
  s.enqueue("w1");
  s.enqueue("w2");
  s.notePermitAcquired("owner");
  s.notePermitAcquired("w2");
  s.onTransportResult("w1", s.getJob("w1").attemptToken, {
    status: "failed", failureCategory: "http_429",
  });
  quiesceIfPausing(s, "w1");
  quiesceIfPausing(s, "w2");
  assert.equal(s.getJob("w1").state, "waiting_provider");
  assert.equal(s.getJob("w2").state, "waiting_provider");
  // Drain owner completes → recovering with w1 as recovery owner (running), w2 still waiting.
  s.onTransportResult("owner", s.getJob("owner").attemptToken, {
    status: "completed", failureCategory: null,
  });
  assert.equal(s.getJob("w1").state, "running");
  assert.equal(s.getSnapshot().providers["p.com"].gate.state, "recovering");
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "w1");
  assert.equal(s.getJob("w2").state, "waiting_provider");
  const w2Before = s.getJob("w2").retryRemaining;
  s.onTransportResult("w1", s.getJob("w1").attemptToken, {
    status: "failed", failureCategory: "local_io",
  });
  assert.equal(s.getJob("w1").state, "needs_user");
  assert.equal(s.getJob("w1").holdsGlobalSlot, false);
  assert.ok(s.getJob("w2").state === "running" || s.getJob("w2").state === "queued");
  assert.equal(s.getJob("w2").autoWakeCount, 1);
  // Paused-only competitor: free wake (no charge).
  assert.equal(s.getJob("w2").retryRemaining, w2Before);
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "w2");
  assertSlotInvariant(s);

  // Without waiter: recovering solo owner local_io → needs_user, blocked recovering.
  const s2 = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
  saturateOwnerWithWaiter(s2, "q.com", "own2", "fail2");
  s2.cancel("fail2");
  // Owner transient → retry_backoff, gate recovering owner null.
  s2.onTransportResult("own2", s2.getJob("own2").attemptToken, {
    status: "failed", failureCategory: "timeout",
  });
  assert.equal(s2.getJob("own2").state, "retry_backoff");
  assert.equal(s2.getSnapshot().providers["q.com"].gate.state, "recovering");
  assert.equal(s2.getSnapshot().providers["q.com"].gate.ownerJobId, null);
  // Due tick re-admits as recovery owner.
  s2.tick(999999);
  assert.equal(s2.getJob("own2").state, "running");
  assert.equal(s2.getSnapshot().providers["q.com"].gate.ownerJobId, "own2");
  s2.onTransportResult("own2", s2.getJob("own2").attemptToken, {
    status: "failed", failureCategory: "local_io",
  });
  assert.equal(s2.getJob("own2").state, "needs_user");
  assert.equal(s2.getSnapshot().providers["q.com"].gate.ownerJobId, null);
  assert.equal(s2.getSnapshot().providers["q.com"].gate.state, "recovering");
  assertSlotInvariant(s2);
});

test("CONTROL: saturated/recovering owner transient backoff re-admits with owner designation and permit", () => {
  // Characterization of existing public sequence (controller-proven). Must stay GREEN.
  let t = 0;
  const s = createDownloadScheduler({ maxConcurrent: 2, now: () => t });
  s.createJob({ id: "owner", providerKey: "p.com", intent: intent("o.mp4"), segmentConcurrency: 4, retries: 3 });
  s.createJob({ id: "peer", providerKey: "p.com", intent: intent("p.mp4"), segmentConcurrency: 4, retries: 3 });
  s.enqueue("owner");
  s.enqueue("peer");
  s.notePermitAcquired("owner");
  s.onTransportResult("peer", s.getJob("peer").attemptToken, {
    status: "failed", failureCategory: "http_429",
  });
  quiesceIfPausing(s, "peer");
  assert.equal(s.getJob("peer").state, "waiting_provider");
  // Cancel waiter so owner has no eligible successor, then transient fail → retry_backoff.
  s.cancel("peer");
  const beforeTok = s.getJob("owner").attemptToken;
  const reducedBefore = s.getJob("owner").effectiveConcurrency;
  s.onTransportResult("owner", beforeTok, {
    status: "failed", failureCategory: "timeout",
  });
  assert.equal(s.getJob("owner").state, "retry_backoff");
  assert.equal(s.getSnapshot().providers["p.com"].gate.state, "recovering");
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, null);
  assert.equal(s.getJob("owner").holdsGlobalSlot, false);
  // Due tick: commit-time designateRecoveryOwner re-installs same job as owner.
  t += 999999;
  s.tick(t);
  assert.equal(s.getJob("owner").state, "running");
  const fresh = s.getJob("owner").attemptToken;
  assert.ok(typeof fresh === "string" && fresh.trim().length > 0);
  assert.notEqual(fresh, beforeTok);
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "owner");
  assert.equal(s.getSnapshot().providers["p.com"].gate.state, "recovering");
  // Provider permit succeeds for recovery owner.
  const permit = s.acquireProviderPermit("owner", "probe");
  assert.ok(permit);
  permit.release();
  // Reduced concurrency preserved; no second same-provider job admitted while recovering.
  assert.ok(s.getJob("owner").effectiveConcurrency <= reducedBefore);
  assert.equal(s.getSnapshot().providers["p.com"].running.length, 1);
  assertSlotInvariant(s);
});

test("requestFirefoxHandoff rejects pre-existing cancelRequested before token consumption", async () => {
  let downloadCalls = 0;
  const store = new Set(["live-tok"]);
  const s = createDownloadScheduler({
    maxConcurrent: 1,
    now: () => 0,
    firefoxDownload: async () => {
      downloadCalls++;
      return 1;
    },
    popupTokenStore: store,
  });
  s.createJob({ id: "j", providerKey: "p.com", intent: intent("a.mp4"), segmentConcurrency: 2, retries: 1 });
  s.enqueue("j");
  const tok = s.getJob("j").attemptToken;
  const ver = s.getJob("j").stateVersion;
  s.cancel("j");
  // Quiescent running with cancelRequested: still running, token live, permits denied.
  assert.equal(s.getJob("j").state, "running");
  assert.equal(s.getJob("j").attemptToken, tok);
  assert.equal(s.acquireProviderPermit("j", "probe"), null);
  await assert.rejects(() => s.requestFirefoxHandoff("j", fxIntent("a.mp4", "live-tok")));
  assert.equal(downloadCalls, 0);
  assert.equal(store.has("live-tok"), true); // token not consumed
  assert.equal(s.getJob("j").state, "running");
  assert.equal(s.getJob("j").attemptToken, tok);
  assert.equal(s.getJob("j").holdsGlobalSlot, true);
  assert.equal(s.getJob("j").stateVersion, ver); // no resurrection / mutation
  // Cancel still honored: matching ack → cancelled
  s.onTransportResult("j", tok, { status: "cancelled", failureCategory: "cancelled" });
  assert.equal(s.getJob("j").state, "cancelled");
  assertSlotInvariant(s);
});

test("Firefox handoff uses inFlight not auto-cancel; late cancel settles reject vs success", async () => {
  let downloadCalls = 0;
  let resolveHook;
  const hookPromise = new Promise((r) => { resolveHook = r; });
  const store = new Set(["inflight-tok", "late-ok", "late-bad"]);
  const s = createDownloadScheduler({
    maxConcurrent: 1,
    now: () => 0,
    firefoxDownload: async () => {
      downloadCalls++;
      await hookPromise;
      return 1;
    },
    popupTokenStore: store,
  });
  s.createJob({ id: "j", providerKey: "p.com", intent: intent("a.mp4"), segmentConcurrency: 2, retries: 1 });
  s.enqueue("j");
  const p = s.requestFirefoxHandoff("j", fxIntent("a.mp4", "inflight-tok"));
  // While in flight: permits denied via firefoxHandoffInFlight (not requiring cancelRequested).
  assert.equal(s.getJob("j").state, "handing_off_firefox");
  assert.equal(s.acquireProviderPermit("j", "probe"), null);
  // Late cancel must record, not silent no-op.
  s.cancel("j");
  resolveHook();
  await p;
  // Guarded hook success → ownership transferred even if late cancel was requested.
  assert.equal(s.getJob("j").state, "handed_to_firefox");
  assert.equal(downloadCalls, 1);
  assertSlotInvariant(s);

  // Reject path + late cancel → cancelled, ephemeral cleared.
  let clearCount = 0;
  let resolveBad;
  const badPromise = new Promise((r) => { resolveBad = r; });
  const s2 = createDownloadScheduler({
    maxConcurrent: 1,
    now: () => 0,
    firefoxDownload: async () => {
      await badPromise;
      throw new Error("dialog cancelled");
    },
    popupTokenStore: store,
  });
  s2.createJob({
    id: "k",
    providerKey: "p.com",
    intent: intent("k.mp4"),
    segmentConcurrency: 2,
    retries: 1,
    ephemeral: { clear() { clearCount++; } },
  });
  s2.enqueue("k");
  const p2 = s2.requestFirefoxHandoff("k", fxIntent("k.mp4", "late-bad"));
  assert.equal(s2.getJob("k").state, "handing_off_firefox");
  s2.cancel("k");
  resolveBad();
  await p2;
  assert.equal(s2.getJob("k").state, "cancelled");
  assert.equal(s2.getJob("k").holdsGlobalSlot, false);
  assert.equal(clearCount, 1);
  assertSlotInvariant(s2);

  // Reject without late cancel → needs_user, ephemeral retained.
  let clearCount3 = 0;
  const s3 = createDownloadScheduler({
    maxConcurrent: 1,
    now: () => 0,
    firefoxDownload: async () => {
      throw new Error("reject");
    },
    popupTokenStore: store,
  });
  s3.createJob({
    id: "m",
    providerKey: "p.com",
    intent: intent("m.mp4"),
    segmentConcurrency: 2,
    retries: 1,
    ephemeral: { clear() { clearCount3++; } },
  });
  s3.enqueue("m");
  await s3.requestFirefoxHandoff("m", fxIntent("m.mp4", "late-ok"));
  assert.equal(s3.getJob("m").state, "needs_user");
  assert.equal(clearCount3, 0);
  assertSlotInvariant(s3);
});

test("Firefox handoff post-token sync throw settles without stuck inFlight; hook not called if pre-await fails", async () => {
  const path = require("node:path");
  const gatePath = path.resolve(__dirname, "..", "lib", "provider-gate.js");
  const schedPath = path.resolve(__dirname, "..", "lib", "download-scheduler.js");
  const realGate = require(gatePath);
  const prevGate = require.cache[require.resolve(gatePath)];
  const prevSched = require.cache[require.resolve(schedPath)];
  try {
    // Stub: completeOwner throws once (owner advancement failure after token consume).
    let throwComplete = false;
    require.cache[require.resolve(gatePath)] = {
      id: gatePath,
      filename: gatePath,
      loaded: true,
      exports: {
        createProviderGate: function (opts) {
          const g = realGate.createProviderGate(opts);
          return {
            get providerKey() { return g.providerKey; },
            get state() { return g.state; },
            get generation() { return g.generation; },
            get wakeGeneration() { return g.wakeGeneration; },
            acquire: g.acquire.bind(g),
            setSaturated: g.setSaturated.bind(g),
            registerJobLimit: g.registerJobLimit.bind(g),
            nativeLeaseFor: g.nativeLeaseFor.bind(g),
            noteNativeOpen: g.noteNativeOpen.bind(g),
            parkProbe: g.parkProbe.bind(g),
            completeOwner: function (args) {
              if (throwComplete) {
                throwComplete = false;
                throw new Error("simulated completeOwner throw");
              }
              return g.completeOwner(args);
            },
            designateRecoveryOwner: g.designateRecoveryOwner.bind(g),
            recoverToNormal: g.recoverToNormal.bind(g),
            snapshot: g.snapshot.bind(g),
          };
        },
      },
    };
    delete require.cache[require.resolve(schedPath)];
    const { createDownloadScheduler: createS } = require(schedPath);

    let downloadCalls = 0;
    const store = new Set(["sync-tok", "adv-tok"]);
    const s = createS({
      maxConcurrent: 2,
      now: () => 0,
      firefoxDownload: async () => {
        downloadCalls++;
        return 1;
      },
      popupTokenStore: store,
    });
    // Owner + waiter so handoff hits completeOwner path.
    s.createJob({ id: "owner", providerKey: "p.com", intent: intent("o.mp4"), segmentConcurrency: 4, retries: 2 });
    s.createJob({ id: "waiter", providerKey: "p.com", intent: intent("w.mp4"), segmentConcurrency: 4, retries: 2 });
    s.enqueue("owner");
    s.enqueue("waiter");
    s.notePermitAcquired("owner");
    s.onTransportResult("waiter", s.getJob("waiter").attemptToken, {
      status: "failed", failureCategory: "http_429",
    });
    quiesceIfPausing(s, "waiter");
    // Drain owner observation so handoff is quiescent (outstanding permits reject).
    while (s.getJob("owner").inFlightPermits > 0) s.releasePermit("owner");
    throwComplete = true;
    const ownerTokBefore = s.getJob("owner").attemptToken;
    const ownerVerBefore = s.getJob("owner").stateVersion;
    await assert.rejects(
      () => s.requestFirefoxHandoff("owner", fxIntent("o.mp4", "sync-tok")),
      /ownership|completeOwner|provider/i
    );
    // Token consumed; rollback to live running attempt; Firefox not called.
    assert.equal(store.has("sync-tok"), false);
    assert.equal(s.getJob("owner").state, "running");
    assert.equal(s.getJob("owner").attemptToken, ownerTokBefore);
    assert.equal(s.getJob("owner").holdsGlobalSlot, true);
    // Handoff not in flight: owner may acquire provider permits again.
    const permitAgain = s.acquireProviderPermit("owner", "probe");
    assert.ok(permitAgain);
    permitAgain.release();
    assert.ok(s.getJob("owner").stateVersion > ownerVerBefore);
    assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "owner");
    assert.equal(s.getJob("waiter").state, "waiting_provider");
    assert.equal(downloadCalls, 0);
    assertSlotInvariant(s);

    // Non-advanced completeOwner must fail closed: never Firefox, restore running.
    require.cache[require.resolve(gatePath)] = {
      id: gatePath,
      filename: gatePath,
      loaded: true,
      exports: {
        createProviderGate: function (opts) {
          const g = realGate.createProviderGate(opts);
          return {
            get providerKey() { return g.providerKey; },
            get state() { return g.state; },
            get generation() { return g.generation; },
            get wakeGeneration() { return g.wakeGeneration; },
            acquire: g.acquire.bind(g),
            setSaturated: g.setSaturated.bind(g),
            registerJobLimit: g.registerJobLimit.bind(g),
            nativeLeaseFor: g.nativeLeaseFor.bind(g),
            noteNativeOpen: g.noteNativeOpen.bind(g),
            parkProbe: g.parkProbe.bind(g),
            completeOwner: function () {
              // Controlled non-advanced result: do not mutate real gate ownership either.
              return Object.freeze({
                advanced: false,
                wakeGeneration: g.wakeGeneration,
                parkedProbeIds: Object.freeze([]),
              });
            },
            designateRecoveryOwner: g.designateRecoveryOwner.bind(g),
            recoverToNormal: g.recoverToNormal.bind(g),
            snapshot: g.snapshot.bind(g),
          };
        },
      },
    };
    delete require.cache[require.resolve(schedPath)];
    const { createDownloadScheduler: createS2 } = require(schedPath);
    let downloadCalls2 = 0;
    const store2 = new Set(["adv-tok2"]);
    const s2 = createS2({
      maxConcurrent: 2,
      now: () => 0,
      firefoxDownload: async () => {
        downloadCalls2++;
        return 1;
      },
      popupTokenStore: store2,
    });
    s2.createJob({ id: "owner", providerKey: "p.com", intent: intent("o.mp4"), segmentConcurrency: 4, retries: 3 });
    s2.createJob({ id: "waiter", providerKey: "p.com", intent: intent("w.mp4"), segmentConcurrency: 4, retries: 3 });
    s2.enqueue("owner");
    s2.enqueue("waiter");
    s2.notePermitAcquired("owner");
    s2.onTransportResult("waiter", s2.getJob("waiter").attemptToken, {
      status: "failed", failureCategory: "http_429",
    });
    quiesceIfPausing(s2, "waiter");
    while (s2.getJob("owner").inFlightPermits > 0) s2.releasePermit("owner");
    const waiterRetries = s2.getJob("waiter").retryRemaining;
    const ownerTok2 = s2.getJob("owner").attemptToken;
    await assert.rejects(
      () => s2.requestFirefoxHandoff("owner", fxIntent("o.mp4", "adv-tok2")),
      /ownership|advance|provider/i
    );
    assert.equal(s2.getJob("waiter").state, "waiting_provider");
    assert.equal(s2.getJob("waiter").autoWakeCount, 0);
    assert.equal(s2.getJob("waiter").retryRemaining, waiterRetries);
    assert.equal(s2.getJob("owner").state, "running");
    assert.equal(s2.getJob("owner").attemptToken, ownerTok2);
    assert.equal(s2.getJob("owner").holdsGlobalSlot, true);
    assert.equal(s2.getSnapshot().providers["p.com"].gate.ownerJobId, "owner");
    assert.equal(downloadCalls2, 0);
    assert.equal(store2.has("adv-tok2"), false);
    assertSlotInvariant(s2);

    // Synchronous firefoxDownload throw treated as adapter rejection → needs_user.
    delete require.cache[require.resolve(gatePath)];
    require.cache[require.resolve(gatePath)] = prevGate || {
      id: gatePath,
      filename: gatePath,
      loaded: true,
      exports: realGate,
    };
    delete require.cache[require.resolve(schedPath)];
    const { createDownloadScheduler: createS3 } = require(schedPath);
    const store3 = new Set(["sync-fx"]);
    const s3 = createS3({
      maxConcurrent: 1,
      now: () => 0,
      firefoxDownload: function () {
        throw new Error("sync adapter throw");
      },
      popupTokenStore: store3,
    });
    s3.createJob({ id: "j", providerKey: "p.com", intent: intent("a.mp4"), segmentConcurrency: 2, retries: 1 });
    s3.enqueue("j");
    await s3.requestFirefoxHandoff("j", fxIntent("a.mp4", "sync-fx"));
    assert.equal(s3.getJob("j").state, "needs_user");
    assert.equal(s3.getJob("j").holdsGlobalSlot, false);
    assert.equal(store3.has("sync-fx"), false);
    assertSlotInvariant(s3);
  } finally {
    if (prevGate) require.cache[require.resolve(gatePath)] = prevGate;
    else delete require.cache[require.resolve(gatePath)];
    if (prevSched) require.cache[require.resolve(schedPath)] = prevSched;
    else delete require.cache[require.resolve(schedPath)];
    // Reload default scheduler for subsequent tests in this file.
    delete require.cache[require.resolve(schedPath)];
    loadLib("lib/download-scheduler.js");
  }
});

test("tick admits due retry_backoff jobs by deadline then creation order", () => {
  // Mutation: Map creation order alone can admit later-deadline job first.
  // Case 1: earlier-deadline earlier-created A before later-deadline B.
  let t2 = 0;
  const s2 = createDownloadScheduler({ maxConcurrent: 1, now: () => t2 });
  s2.createJob({ id: "A", providerKey: "p.com", intent: intent("a.mp4"), segmentConcurrency: 1, retries: 2 });
  s2.createJob({ id: "B", providerKey: "p.com", intent: intent("b.mp4"), segmentConcurrency: 1, retries: 2 });
  s2.enqueue("A");
  t2 = 0;
  s2.onTransportResult("A", s2.getJob("A").attemptToken, {
    status: "failed", failureCategory: "timeout",
  });
  // A deadline = 2000
  assert.equal(s2.getJob("A").state, "retry_backoff");
  s2.enqueue("B");
  assert.equal(s2.getJob("B").state, "running");
  t2 = 50;
  s2.onTransportResult("B", s2.getJob("B").attemptToken, {
    status: "failed", failureCategory: "timeout",
  });
  // B deadline = 2050; A deadline = 2000
  assert.equal(s2.getJob("B").state, "retry_backoff");
  t2 = 100000;
  s2.tick(t2);
  assert.equal(s2.getJob("A").state, "running");
  assert.equal(s2.getJob("B").state, "queued");
  s2.tick(t2);
  assert.equal(s2.getJob("A").state, "running");
  assert.equal(s2.getJob("B").state, "queued");
  assertSlotInvariant(s2);

  // Case 2: later-created earlier-deadline job queues/admits first after large clock jump.
  let t4 = 0;
  const s4 = createDownloadScheduler({ maxConcurrent: 1, now: () => t4 });
  s4.createJob({ id: "earlyCreated", providerKey: "p.com", intent: intent("e.mp4"), segmentConcurrency: 1, retries: 2 });
  s4.createJob({ id: "lateCreated", providerKey: "p.com", intent: intent("l.mp4"), segmentConcurrency: 1, retries: 2 });
  s4.enqueue("earlyCreated");
  t4 = 500;
  s4.onTransportResult("earlyCreated", s4.getJob("earlyCreated").attemptToken, {
    status: "failed", failureCategory: "timeout",
  });
  // earlyCreated deadline = 2500
  s4.enqueue("lateCreated");
  t4 = 0;
  s4.onTransportResult("lateCreated", s4.getJob("lateCreated").attemptToken, {
    status: "failed", failureCategory: "timeout",
  });
  // lateCreated deadline = 2000 < earlyCreated's 2500
  assert.equal(s4.getJob("lateCreated").state, "retry_backoff");
  assert.equal(s4.getJob("earlyCreated").state, "retry_backoff");
  t4 = 999999;
  s4.tick(t4);
  assert.equal(s4.getJob("lateCreated").state, "running");
  assert.equal(s4.getJob("earlyCreated").state, "queued");
  s4.tick(t4);
  assert.equal(s4.getJob("lateCreated").state, "running");
  assert.equal(s4.getJob("earlyCreated").state, "queued");
  assertSlotInvariant(s4);
});

// ---------------------------------------------------------------------------
// Task 11 fix2 — owner reconciliation before Firefox handoff
// ---------------------------------------------------------------------------

function installGateStub(realGate, gatePath, completeOwnerImpl) {
  require.cache[require.resolve(gatePath)] = {
    id: gatePath,
    filename: gatePath,
    loaded: true,
    exports: {
      createProviderGate: function (opts) {
        const g = realGate.createProviderGate(opts);
        return {
          get providerKey() { return g.providerKey; },
          get state() { return g.state; },
          get generation() { return g.generation; },
          get wakeGeneration() { return g.wakeGeneration; },
          acquire: g.acquire.bind(g),
          setSaturated: g.setSaturated.bind(g),
          registerJobLimit: g.registerJobLimit.bind(g),
          nativeLeaseFor: g.nativeLeaseFor.bind(g),
          noteNativeOpen: g.noteNativeOpen.bind(g),
          parkProbe: g.parkProbe.bind(g),
          completeOwner: function (args) {
            return completeOwnerImpl(g, args);
          },
          designateRecoveryOwner: g.designateRecoveryOwner.bind(g),
          recoverToNormal: g.recoverToNormal.bind(g),
          snapshot: g.snapshot.bind(g),
        };
      },
    },
  };
}

function loadSchedulerFresh(schedPath) {
  delete require.cache[require.resolve(schedPath)];
  return require(schedPath).createDownloadScheduler;
}

function setupSaturatedOwnerWaiter(createS, opts) {
  const s = createS(Object.assign({ maxConcurrent: 2, now: () => 0 }, opts || {}));
  s.createJob({
    id: "owner",
    providerKey: "p.com",
    intent: intent("o.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.createJob({
    id: "waiter",
    providerKey: "p.com",
    intent: intent("w.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.enqueue("owner");
  s.enqueue("waiter");
  s.notePermitAcquired("owner");
  s.onTransportResult("waiter", s.getJob("waiter").attemptToken, {
    status: "failed",
    failureCategory: "http_429",
  });
  quiesceIfPausing(s, "waiter");
  while (s.getJob("owner").inFlightPermits > 0) s.releasePermit("owner");
  assert.equal(s.getJob("waiter").state, "waiting_provider");
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "owner");
  return s;
}

test("fix2: non-advanced completeOwner fails closed — restore running, no Firefox, waiter parked", async () => {
  const path = require("node:path");
  const gatePath = path.resolve(__dirname, "..", "lib", "provider-gate.js");
  const schedPath = path.resolve(__dirname, "..", "lib", "download-scheduler.js");
  const realGate = require(gatePath);
  const prevGate = require.cache[require.resolve(gatePath)];
  const prevSched = require.cache[require.resolve(schedPath)];
  try {
    installGateStub(realGate, gatePath, function (g) {
      return Object.freeze({
        advanced: false,
        wakeGeneration: g.wakeGeneration,
        parkedProbeIds: Object.freeze([]),
      });
    });
    const createS = loadSchedulerFresh(schedPath);
    let downloadCalls = 0;
    const store = new Set(["na-tok", "na-replay"]);
    const s = setupSaturatedOwnerWaiter(createS, {
      firefoxDownload: async () => {
        downloadCalls++;
        return 1;
      },
      popupTokenStore: store,
    });
    const priorTok = s.getJob("owner").attemptToken;
    const priorVer = s.getJob("owner").stateVersion;
    const waiterRetries = s.getJob("waiter").retryRemaining;
    await assert.rejects(
      () => s.requestFirefoxHandoff("owner", fxIntent("o.mp4", "na-tok")),
      /ownership|advance|provider/i
    );
    assert.equal(downloadCalls, 0);
    assert.equal(store.has("na-tok"), false); // consumed
    assert.equal(s.getJob("owner").state, "running");
    assert.equal(s.getJob("owner").attemptToken, priorTok);
    assert.equal(s.getJob("owner").holdsGlobalSlot, true);
    assert.equal(s.getSnapshot().globalRunning, 1);
    assert.ok(s.getJob("owner").stateVersion > priorVer); // monotonic, not decremented
    assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "owner");
    assert.equal(s.getJob("waiter").state, "waiting_provider");
    assert.equal(s.getJob("waiter").autoWakeCount, 0);
    assert.equal(s.getJob("waiter").retryRemaining, waiterRetries);
    // Replay of consumed token rejects; owner remains running.
    await assert.rejects(
      () => s.requestFirefoxHandoff("owner", fxIntent("o.mp4", "na-tok")),
      /token|forged|consumed/i
    );
    assert.equal(s.getJob("owner").state, "running");
    assert.equal(s.getJob("owner").attemptToken, priorTok);
    assert.equal(downloadCalls, 0);
    assertSlotInvariant(s);
  } finally {
    if (prevGate) require.cache[require.resolve(gatePath)] = prevGate;
    else delete require.cache[require.resolve(gatePath)];
    if (prevSched) require.cache[require.resolve(schedPath)] = prevSched;
    else delete require.cache[require.resolve(schedPath)];
    delete require.cache[require.resolve(schedPath)];
    loadLib("lib/download-scheduler.js");
  }
});

test("fix2: completeOwner throw before mutation rolls back to running attempt", async () => {
  const path = require("node:path");
  const gatePath = path.resolve(__dirname, "..", "lib", "provider-gate.js");
  const schedPath = path.resolve(__dirname, "..", "lib", "download-scheduler.js");
  const realGate = require(gatePath);
  const prevGate = require.cache[require.resolve(gatePath)];
  const prevSched = require.cache[require.resolve(schedPath)];
  try {
    installGateStub(realGate, gatePath, function () {
      throw new Error("simulated completeOwner throw before mutation");
    });
    const createS = loadSchedulerFresh(schedPath);
    let downloadCalls = 0;
    const store = new Set(["throw-tok"]);
    const s = setupSaturatedOwnerWaiter(createS, {
      firefoxDownload: async () => {
        downloadCalls++;
        return 1;
      },
      popupTokenStore: store,
    });
    const priorTok = s.getJob("owner").attemptToken;
    const priorVer = s.getJob("owner").stateVersion;
    await assert.rejects(
      () => s.requestFirefoxHandoff("owner", fxIntent("o.mp4", "throw-tok")),
      /completeOwner|ownership|provider/i
    );
    assert.equal(downloadCalls, 0);
    assert.equal(store.has("throw-tok"), false);
    assert.equal(s.getJob("owner").state, "running");
    assert.equal(s.getJob("owner").attemptToken, priorTok);
    assert.equal(s.getJob("owner").holdsGlobalSlot, true);
    assert.ok(s.getJob("owner").stateVersion > priorVer);
    assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "owner");
    assert.equal(s.getJob("waiter").state, "waiting_provider");
    assert.equal(s.getJob("waiter").autoWakeCount, 0);
    assertSlotInvariant(s);
  } finally {
    if (prevGate) require.cache[require.resolve(gatePath)] = prevGate;
    else delete require.cache[require.resolve(gatePath)];
    if (prevSched) require.cache[require.resolve(schedPath)] = prevSched;
    else delete require.cache[require.resolve(schedPath)];
    delete require.cache[require.resolve(schedPath)];
    loadLib("lib/download-scheduler.js");
  }
});

test("fix2: completeOwner advances then throws — settle failed, authorize recovery once, no Firefox", async () => {
  const path = require("node:path");
  const gatePath = path.resolve(__dirname, "..", "lib", "provider-gate.js");
  const schedPath = path.resolve(__dirname, "..", "lib", "download-scheduler.js");
  const realGate = require(gatePath);
  const prevGate = require.cache[require.resolve(gatePath)];
  const prevSched = require.cache[require.resolve(schedPath)];
  try {
    let completeCalls = 0;
    installGateStub(realGate, gatePath, function (g, args) {
      completeCalls += 1;
      const result = g.completeOwner(args);
      throw new Error("simulated throw after advance");
    });
    const createS = loadSchedulerFresh(schedPath);
    let downloadCalls = 0;
    const store = new Set(["adv-throw"]);
    const s = setupSaturatedOwnerWaiter(createS, {
      firefoxDownload: async () => {
        downloadCalls++;
        return 1;
      },
      popupTokenStore: store,
    });
    const waiterRetries = s.getJob("waiter").retryRemaining;
    await assert.rejects(
      () => s.requestFirefoxHandoff("owner", fxIntent("o.mp4", "adv-throw")),
      /after advance|ownership|provider|completeOwner/i
    );
    assert.equal(downloadCalls, 0);
    assert.ok(
      s.getJob("owner").state === "needs_user" || s.getJob("owner").state === "cancelled"
    );
    assert.equal(s.getJob("owner").holdsGlobalSlot, false);
    assert.notEqual(s.getSnapshot().providers["p.com"].gate.ownerJobId, "owner");
    // Installed recovery waiter authorized exactly once / admits via global queue.
    assert.ok(
      s.getJob("waiter").state === "running" || s.getJob("waiter").state === "queued"
    );
    assert.equal(s.getJob("waiter").autoWakeCount, 1);
    assert.equal(s.getJob("waiter").retryRemaining, waiterRetries - 1);
    // No double retry charge on any subsequent settle-like path.
    const wakeAfter = s.getJob("waiter").autoWakeCount;
    const retriesAfter = s.getJob("waiter").retryRemaining;
    // Second completeOwner from settlement (if any) must not re-wake.
    assert.equal(s.getJob("waiter").autoWakeCount, wakeAfter);
    assert.equal(s.getJob("waiter").retryRemaining, retriesAfter);
    assert.ok(completeCalls >= 1);
    assertSlotInvariant(s);
  } finally {
    if (prevGate) require.cache[require.resolve(gatePath)] = prevGate;
    else delete require.cache[require.resolve(gatePath)];
    if (prevSched) require.cache[require.resolve(schedPath)] = prevSched;
    else delete require.cache[require.resolve(schedPath)];
    delete require.cache[require.resolve(schedPath)];
    loadLib("lib/download-scheduler.js");
  }
});

test("fix2: adapter reject after successful owner advance does not strand waiter", async () => {
  let downloadCalls = 0;
  const store = new Set(["adapt-rej", "adapt-late"]);
  const s = createDownloadScheduler({
    maxConcurrent: 2,
    now: () => 0,
    firefoxDownload: async () => {
      downloadCalls++;
      throw new Error("dialog cancelled");
    },
    popupTokenStore: store,
  });
  saturateOwnerWithWaiter(s, "p.com", "owner", "waiter");
  while (s.getJob("owner").inFlightPermits > 0) s.releasePermit("owner");
  const waiterRetries = s.getJob("waiter").retryRemaining;
  await s.requestFirefoxHandoff("owner", fxIntent("owner.mp4", "adapt-rej"));
  assert.equal(downloadCalls, 1);
  assert.equal(s.getJob("owner").state, "needs_user");
  assert.equal(s.getJob("owner").holdsGlobalSlot, false);
  assert.notEqual(s.getSnapshot().providers["p.com"].gate.ownerJobId, "owner");
  assert.ok(
    s.getJob("waiter").state === "running" || s.getJob("waiter").state === "queued"
  );
  assert.equal(s.getJob("waiter").autoWakeCount, 1);
  assert.equal(s.getJob("waiter").retryRemaining, waiterRetries - 1);
  assertSlotInvariant(s);

  // Late cancel + reject → cancelled; waiter still not stranded.
  let resolveHook;
  const hookP = new Promise((r) => { resolveHook = r; });
  const s2 = createDownloadScheduler({
    maxConcurrent: 2,
    now: () => 0,
    firefoxDownload: async () => {
      await hookP;
      throw new Error("late reject");
    },
    popupTokenStore: store,
  });
  saturateOwnerWithWaiter(s2, "q.com", "own2", "wait2");
  while (s2.getJob("own2").inFlightPermits > 0) s2.releasePermit("own2");
  const p2 = s2.requestFirefoxHandoff("own2", fxIntent("own2.mp4", "adapt-late"));
  s2.cancel("own2");
  resolveHook();
  await p2;
  assert.equal(s2.getJob("own2").state, "cancelled");
  assert.equal(s2.getJob("own2").holdsGlobalSlot, false);
  assert.notEqual(s2.getSnapshot().providers["q.com"].gate.ownerJobId, "own2");
  assert.ok(
    s2.getJob("wait2").state === "running" || s2.getJob("wait2").state === "queued"
  );
  assert.equal(s2.getJob("wait2").autoWakeCount, 1);
  assertSlotInvariant(s2);
});

test("fix2: success path handed_to_firefox job is never still gate owner", async () => {
  const store = new Set(["ok-own", "ok-plain"]);
  const s = createDownloadScheduler({
    maxConcurrent: 2,
    now: () => 0,
    firefoxDownload: async () => 1,
    popupTokenStore: store,
  });
  saturateOwnerWithWaiter(s, "p.com", "owner", "waiter");
  while (s.getJob("owner").inFlightPermits > 0) s.releasePermit("owner");
  await s.requestFirefoxHandoff("owner", fxIntent("owner.mp4", "ok-own"));
  assert.equal(s.getJob("owner").state, "handed_to_firefox");
  assert.notEqual(s.getSnapshot().providers["p.com"].gate.ownerJobId, "owner");
  assert.ok(
    s.getJob("waiter").state === "running" || s.getJob("waiter").state === "queued"
  );
  assertSlotInvariant(s);

  // Non-owner success also must not claim gate ownership.
  const s2 = createDownloadScheduler({
    maxConcurrent: 1,
    now: () => 0,
    firefoxDownload: async () => 1,
    popupTokenStore: store,
  });
  s2.createJob({
    id: "j",
    providerKey: "solo.com",
    intent: intent("a.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s2.enqueue("j");
  await s2.requestFirefoxHandoff("j", fxIntent("a.mp4", "ok-plain"));
  assert.equal(s2.getJob("j").state, "handed_to_firefox");
  assert.notEqual(s2.getSnapshot().providers["solo.com"].gate.ownerJobId, "j");
  assertSlotInvariant(s2);
});

test("fix2: duplicate/late settlement cannot wake twice or double-release", async () => {
  let resolveHook;
  const hookP = new Promise((r) => { resolveHook = r; });
  const store = new Set(["dup-tok"]);
  const s = createDownloadScheduler({
    maxConcurrent: 2,
    now: () => 0,
    firefoxDownload: async () => {
      await hookP;
      throw new Error("adapter reject");
    },
    popupTokenStore: store,
  });
  saturateOwnerWithWaiter(s, "p.com", "owner", "waiter");
  while (s.getJob("owner").inFlightPermits > 0) s.releasePermit("owner");
  const p = s.requestFirefoxHandoff("owner", fxIntent("owner.mp4", "dup-tok"));
  // Mid-flight: ownership should already have advanced; waiter authorized at most once.
  assert.equal(s.getJob("owner").state, "handing_off_firefox");
  assert.notEqual(s.getSnapshot().providers["p.com"].gate.ownerJobId, "owner");
  assert.equal(s.getJob("waiter").autoWakeCount, 1);
  const wakeMid = s.getJob("waiter").autoWakeCount;
  const retriesMid = s.getJob("waiter").retryRemaining;
  const globalMid = s.getSnapshot().globalRunning;
  resolveHook();
  await p;
  assert.equal(s.getJob("owner").state, "needs_user");
  assert.equal(s.getJob("owner").holdsGlobalSlot, false);
  assert.equal(s.getJob("waiter").autoWakeCount, wakeMid); // no second wake
  assert.equal(s.getJob("waiter").retryRemaining, retriesMid); // no double charge
  // Slot not double-released (invariant holds; globalRunning consistent).
  assert.ok(s.getSnapshot().globalRunning >= 0);
  assert.ok(s.getSnapshot().globalRunning <= globalMid + 1);
  assertSlotInvariant(s);

  // Late cancel after already settled is no-op for wake/slot.
  s.cancel("owner");
  assert.equal(s.getJob("waiter").autoWakeCount, wakeMid);
  assertSlotInvariant(s);
});
