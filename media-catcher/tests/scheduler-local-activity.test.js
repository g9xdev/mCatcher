"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");
const { createDownloadScheduler } = loadLib("lib/download-scheduler.js");

/**
 * McDownloadScheduler — local activity lease (Task 20D prerequisite)
 * -----------------------------------------------------------------
 * Neutral scheduler-owned lease for asynchronous local assembly /
 * native-file-sink cleanup. Keeps a job non-quiescent (and therefore
 * holding its global slot while pausing_provider) without counting as
 * a provider permit, native open, or FailureClassify active sibling.
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
    } else if (j.state === "pausing_provider") {
      assert.equal(j.holdsGlobalSlot, true);
    } else {
      assert.equal(j.holdsGlobalSlot, false);
    }
    assert.ok(j.inFlightPermits >= 0);
    assert.ok(j.nativeOpenConnections >= 0);
    assert.ok(typeof j.localActivities === "number");
    assert.ok(Number.isInteger(j.localActivities));
    assert.ok(j.localActivities >= 0);
  });
}

const JOB_PROJECTION_KEYS = [
  "attemptToken",
  "autoWakeCount",
  "effectiveConcurrency",
  "holdsGlobalSlot",
  "id",
  "inFlightPermits",
  "intent",
  "localActivities",
  "mediaKind",
  "mode",
  "nativeOpenConnections",
  "providerKey",
  "retryRemaining",
  "retryUsed",
  "state",
  "stateVersion",
].sort();

function assertProjectionKeys(job) {
  assert.deepEqual(Object.keys(job).sort(), JOB_PROJECTION_KEYS);
  assert.equal(Object.prototype.hasOwnProperty.call(job, "localActivityEpoch"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(job, "drainingAttemptToken"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(job, "pendingDrainTerminal"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(job, "drainTransportUnavailable"), false);
  assert.equal(typeof job.localActivities, "number");
  assert.ok(Number.isInteger(job.localActivities));
  assert.ok(job.localActivities >= 0);
}

function completedResult(mode) {
  return {
    status: "completed",
    mode: mode || "multi-range",
    failureCategory: null,
    partState: "committed",
  };
}

function cancelledResult(mode, partState) {
  return {
    status: "cancelled",
    mode: mode || "multi-range",
    failureCategory: "cancelled",
    partState: partState || "partial",
  };
}

function assertLeaseShape(lease, jobId, purpose) {
  assert.ok(lease && typeof lease === "object");
  assert.ok(Object.isFrozen(lease));
  assert.deepEqual(Object.keys(lease).sort(), ["jobId", "purpose", "release"].sort());
  assert.equal(lease.jobId, jobId);
  assert.equal(lease.purpose, purpose);
  assert.equal(typeof lease.release, "function");
}

// ---------------------------------------------------------------------------
// 1. API rejects non-running; accepts running; lease + projection frozen/exact
// ---------------------------------------------------------------------------

test("1 acquireLocalActivity rejects unknown/non-running; accepts running; freeze/exact keys", () => {
  const s = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
  assert.equal(typeof s.acquireLocalActivity, "function");

  // Unknown job
  assert.equal(s.acquireLocalActivity("nope", "assembly"), null);

  s.createJob({
    id: "j",
    providerKey: "p.com",
    intent: intent("a.mp4"),
    segmentConcurrency: 2,
    retries: 2,
  });
  assert.equal(s.getJob("j").state, "created");
  assert.equal(s.acquireLocalActivity("j", "assembly"), null);
  assertProjectionKeys(s.getJob("j"));
  assert.equal(s.getJob("j").localActivities, 0);
  assert.ok(Object.isFrozen(s.getJob("j")));
  assert.ok(Object.isFrozen(s.getSnapshot()));

  s.enqueue("j");
  assert.equal(s.getJob("j").state, "running");
  const ver = s.getJob("j").stateVersion;
  const slot = s.getJob("j").holdsGlobalSlot;
  const lease = s.acquireLocalActivity("j", "assembly");
  assertLeaseShape(lease, "j", "assembly");
  assert.equal(s.getJob("j").localActivities, 1);
  assert.equal(s.getJob("j").state, "running");
  assert.equal(s.getJob("j").stateVersion, ver);
  assert.equal(s.getJob("j").holdsGlobalSlot, slot);
  assert.equal(s.getJob("j").inFlightPermits, 0);
  assert.equal(s.getJob("j").nativeOpenConnections, 0);
  assertProjectionKeys(s.getJob("j"));
  assertSlotInvariant(s);

  // Complete → terminal rejects
  s.onTransportResult("j", s.getJob("j").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  assert.equal(s.getJob("j").state, "completed");
  assert.equal(s.acquireLocalActivity("j", "assembly"), null);
  assert.equal(s.getJob("j").localActivities, 0);

  // Queued peer
  s.createJob({
    id: "q",
    providerKey: "p.com",
    intent: intent("q.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  // Force queued: fill capacity with another runner first
  s.createJob({
    id: "r",
    providerKey: "other.com",
    intent: intent("r.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.setMaxConcurrent(1);
  s.enqueue("r");
  s.enqueue("q");
  assert.equal(s.getJob("q").state, "queued");
  assert.equal(s.acquireLocalActivity("q", "assembly"), null);

  // waiting_provider / needs_user
  const s2 = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
  s2.createJob({
    id: "a",
    providerKey: "p.com",
    intent: intent("a.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s2.createJob({
    id: "b",
    providerKey: "p.com",
    intent: intent("b.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s2.enqueue("a");
  s2.enqueue("b");
  s2.notePermitAcquired("a");
  s2.onTransportResult("b", s2.getJob("b").attemptToken, {
    status: "failed",
    failureCategory: "http_429",
  });
  assert.equal(s2.getJob("b").state, "waiting_provider");
  assert.equal(s2.acquireLocalActivity("b", "assembly"), null);

  const s3 = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s3.createJob({
    id: "n",
    providerKey: "p.com",
    intent: intent("n.mp4"),
    segmentConcurrency: 2,
    retries: 0,
  });
  s3.enqueue("n");
  s3.onTransportResult("n", s3.getJob("n").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  assert.equal(s3.getJob("n").state, "needs_user");
  assert.equal(s3.acquireLocalActivity("n", "assembly"), null);
  assertSlotInvariant(s3);
});

// ---------------------------------------------------------------------------
// 2. Counting, idempotent release, never negative, no slot/stateVersion change
// ---------------------------------------------------------------------------

test("2 two leases count 0→2→1→0; double release inert; stateVersion/slot stable while running", () => {
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s.createJob({
    id: "j",
    providerKey: "p.com",
    intent: intent("a.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.enqueue("j");
  const ver0 = s.getJob("j").stateVersion;
  const global0 = s.getSnapshot().globalRunning;

  const l1 = s.acquireLocalActivity("j", "assembly");
  const l2 = s.acquireLocalActivity("j", "sink-cleanup");
  assert.equal(s.getJob("j").localActivities, 2);
  assert.equal(s.getJob("j").stateVersion, ver0);
  assert.equal(s.getJob("j").holdsGlobalSlot, true);
  assert.equal(s.getSnapshot().globalRunning, global0);
  assert.equal(s.getJob("j").inFlightPermits, 0);
  assert.equal(s.getJob("j").nativeOpenConnections, 0);

  assert.equal(l1.release(), true);
  assert.equal(s.getJob("j").localActivities, 1);
  assert.equal(l1.release(), false); // double release inert
  assert.equal(s.getJob("j").localActivities, 1);
  assert.equal(s.getJob("j").stateVersion, ver0);
  assert.equal(s.getSnapshot().globalRunning, global0);

  assert.equal(l2.release(), true);
  assert.equal(s.getJob("j").localActivities, 0);
  assert.equal(l2.release(), false);
  assert.equal(s.getJob("j").localActivities, 0);
  assert.equal(s.getJob("j").state, "running");
  assert.equal(s.getJob("j").stateVersion, ver0);
  assert.equal(s.getJob("j").holdsGlobalSlot, true);
  assertSlotInvariant(s);
});

// ---------------------------------------------------------------------------
// 3. Local-only non-owner retains slot in pausing; release waits once
// ---------------------------------------------------------------------------

test("3 local-only sibling pauses under saturation, retains slot, release waits once", () => {
  let firefoxCalls = 0;
  const s = createDownloadScheduler({
    maxConcurrent: 3,
    now: () => 0,
    firefoxDownload: () => {
      firefoxCalls += 1;
    },
  });
  s.createJob({
    id: "A",
    providerKey: "p.com",
    intent: intent("a.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.createJob({
    id: "B",
    providerKey: "p.com",
    intent: intent("b.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.createJob({
    id: "C",
    providerKey: "p.com",
    intent: intent("c.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.enqueue("A");
  s.enqueue("B");
  s.enqueue("C");
  // A is the active provider/native owner; B has only a local activity.
  s.notePermitAcquired("A");
  s.noteNativeOpen("A", 1);
  const leaseB = s.acquireLocalActivity("B", "assembly");
  assert.equal(s.getJob("B").localActivities, 1);
  assert.equal(s.getJob("B").inFlightPermits, 0);
  assert.equal(s.getJob("B").nativeOpenConnections, 0);

  // Keep C non-quiescent so B is not the only pausing peer.
  s.noteNativeOpen("C", 1);

  const globalBefore = s.getSnapshot().globalRunning;
  s.onTransportResult("C", s.getJob("C").attemptToken, {
    status: "failed",
    failureCategory: "http_429",
  });
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "A");
  assert.equal(s.getJob("A").state, "running");
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.equal(s.getJob("B").holdsGlobalSlot, true);
  assert.equal(s.getJob("B").localActivities, 1);
  assert.equal(s.getJob("B").inFlightPermits, 0);
  assert.equal(s.getJob("B").nativeOpenConnections, 0);
  assert.equal(s.getSnapshot().globalRunning, globalBefore);

  const verPause = s.getJob("B").stateVersion;
  assert.equal(leaseB.release(), true);
  assert.equal(s.getJob("B").localActivities, 0);
  assert.equal(s.getJob("B").state, "waiting_provider");
  assert.equal(s.getJob("B").holdsGlobalSlot, false);
  assert.ok(s.getJob("B").stateVersion > verPause);
  assert.ok(s.getSnapshot().providers["p.com"].waiting.indexOf("B") !== -1);

  // Duplicate release cannot double-release the slot.
  assert.equal(leaseB.release(), false);
  assert.equal(s.getJob("B").state, "waiting_provider");
  assert.equal(s.getJob("B").holdsGlobalSlot, false);
  assert.equal(s.getJob("B").localActivities, 0);
  assert.equal(firefoxCalls, 0);
  assertSlotInvariant(s);
});

// ---------------------------------------------------------------------------
// 4. Local activity alone is not an active sibling for saturation
// ---------------------------------------------------------------------------

test("4 local activity alone does not qualify as active sibling; ordinary retry", () => {
  let firefoxCalls = 0;
  const s = createDownloadScheduler({
    maxConcurrent: 2,
    now: () => 0,
    firefoxDownload: () => {
      firefoxCalls += 1;
    },
  });
  s.createJob({
    id: "sib",
    providerKey: "p.com",
    intent: intent("s.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.createJob({
    id: "fail",
    providerKey: "p.com",
    intent: intent("f.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.enqueue("sib");
  s.enqueue("fail");
  // Sibling has only local activity — not provider/native activity.
  const lease = s.acquireLocalActivity("sib", "assembly");
  assert.equal(s.getJob("sib").localActivities, 1);
  assert.equal(s.getJob("sib").inFlightPermits, 0);
  assert.equal(s.getJob("sib").nativeOpenConnections, 0);

  const retriesBefore = s.getJob("fail").retryRemaining;
  s.onTransportResult("fail", s.getJob("fail").attemptToken, {
    status: "failed",
    failureCategory: "http_429",
  });
  // Ordinary bounded retry/backoff — not provider wait / saturation.
  assert.equal(s.getJob("fail").state, "retry_backoff");
  assert.equal(s.getJob("fail").holdsGlobalSlot, false);
  assert.equal(s.getJob("fail").retryRemaining, retriesBefore - 1);
  assert.equal(s.getSnapshot().providers["p.com"].gate.state, "normal");
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, null);
  assert.equal(s.getJob("sib").state, "running");
  assert.equal(s.getJob("sib").localActivities, 1);
  assert.equal(firefoxCalls, 0);
  assert.equal(lease.release(), true);
  assertSlotInvariant(s);
});

// ---------------------------------------------------------------------------
// 5. Local activity + pending draining native terminal
// ---------------------------------------------------------------------------

test("5 pending draining terminal waits on local activity; last release settles once", () => {
  let firefoxCalls = 0;
  let clearB = 0;
  const s = createDownloadScheduler({
    maxConcurrent: 3,
    now: () => 0,
    firefoxDownload: () => {
      firefoxCalls += 1;
    },
  });
  s.createJob({
    id: "A",
    providerKey: "p.com",
    intent: intent("a.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.createJob({
    id: "B",
    providerKey: "p.com",
    intent: intent("b.mp4"),
    segmentConcurrency: 4,
    retries: 3,
    ephemeral: {
      clear: function () {
        clearB += 1;
      },
    },
  });
  s.createJob({
    id: "C",
    providerKey: "p.com",
    intent: intent("c.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.enqueue("A");
  s.enqueue("B");
  s.enqueue("C");
  s.notePermitAcquired("A");
  s.noteNativeOpen("A", 1);
  s.noteNativeOpen("B", 2);
  const leaseB = s.acquireLocalActivity("B", "assembly");
  assert.equal(s.getJob("B").localActivities, 1);
  s.noteNativeOpen("C", 1);
  const bToken = s.getJob("B").attemptToken;
  assert.equal(typeof bToken, "string");

  s.onTransportResult("C", s.getJob("C").attemptToken, {
    status: "failed",
    failureCategory: "http_429",
  });
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.equal(s.getJob("B").holdsGlobalSlot, true);
  assert.equal(s.getJob("B").attemptToken, null);
  assert.ok(s.getJob("B").nativeOpenConnections >= 1);
  assert.equal(s.getJob("B").localActivities, 1);

  // Terminal accepted; native opens zero; still pausing on local activity.
  assert.equal(s.onDrainingTransportResult("B", bToken, completedResult()), true);
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.equal(s.getJob("B").holdsGlobalSlot, true);
  assert.equal(s.getJob("B").nativeOpenConnections, 0);
  assert.equal(s.getJob("B").localActivities, 1);
  assert.equal(clearB, 0);

  const verBefore = s.getJob("B").stateVersion;
  assert.equal(leaseB.release(), true);
  assert.equal(s.getJob("B").state, "completed");
  assert.equal(s.getJob("B").holdsGlobalSlot, false);
  assert.equal(s.getJob("B").localActivities, 0);
  assert.equal(s.getJob("B").stateVersion, verBefore + 1);
  assert.equal(clearB, 1);

  // Duplicate release cannot re-settle.
  assert.equal(leaseB.release(), false);
  assert.equal(s.getJob("B").state, "completed");
  assert.equal(clearB, 1);
  assert.equal(s.onDrainingTransportResult("B", bToken, completedResult()), false);
  assert.equal(firefoxCalls, 0);
  assertSlotInvariant(s);

  // Cancelled draining path also waits on local activity.
  const s2 = createDownloadScheduler({ maxConcurrent: 3, now: () => 0 });
  s2.createJob({
    id: "A",
    providerKey: "p.com",
    intent: intent("a.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s2.createJob({
    id: "B",
    providerKey: "p.com",
    intent: intent("b.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s2.createJob({
    id: "C",
    providerKey: "p.com",
    intent: intent("c.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s2.enqueue("A");
  s2.enqueue("B");
  s2.enqueue("C");
  s2.notePermitAcquired("A");
  s2.noteNativeOpen("A", 1);
  s2.noteNativeOpen("B", 1);
  const lease2 = s2.acquireLocalActivity("B", "sink");
  s2.noteNativeOpen("C", 1);
  const tok2 = s2.getJob("B").attemptToken;
  s2.onTransportResult("C", s2.getJob("C").attemptToken, {
    status: "failed",
    failureCategory: "http_429",
  });
  assert.equal(s2.onDrainingTransportResult("B", tok2, cancelledResult()), true);
  assert.equal(s2.getJob("B").state, "pausing_provider");
  assert.equal(s2.getJob("B").holdsGlobalSlot, true);
  assert.equal(lease2.release(), true);
  assert.equal(s2.getJob("B").state, "waiting_provider");
  assert.equal(s2.getJob("B").holdsGlobalSlot, false);
  assert.equal(lease2.release(), false);
  assertSlotInvariant(s2);
});

// ---------------------------------------------------------------------------
// 6. Stale lease fencing across unavailable / needs_user / retry / admission
// ---------------------------------------------------------------------------

test("6 stale lease after unavailable/needs_user/manualRetry/admission is inert", () => {
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s.createJob({
    id: "j",
    providerKey: "p.com",
    intent: intent("a.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.enqueue("j");
  const oldLease = s.acquireLocalActivity("j", "assembly");
  assert.equal(s.getJob("j").localActivities, 1);

  // Local activity keeps job non-quiescent → hold in pausing, then settle needs_user.
  assert.equal(s.onTransportUnavailable("j"), true);
  assert.equal(s.getJob("j").state, "pausing_provider");
  assert.equal(s.getJob("j").holdsGlobalSlot, true);
  assert.equal(s.getJob("j").localActivities, 1);

  // Force needs_user by releasing current activity (settles unavailable path).
  assert.equal(oldLease.release(), true);
  assert.equal(s.getJob("j").state, "needs_user");
  assert.equal(s.getJob("j").localActivities, 0);

  // Re-acquire is denied in needs_user; manual retry + admit, then new lease.
  assert.equal(s.acquireLocalActivity("j", "assembly"), null);
  s.manualRetry("j");
  assert.equal(s.getJob("j").state, "running");
  assert.equal(s.getJob("j").localActivities, 0);

  const newLease = s.acquireLocalActivity("j", "assembly");
  assert.equal(s.getJob("j").localActivities, 1);

  // Stale old lease must not decrement the new count.
  assert.equal(oldLease.release(), false);
  assert.equal(s.getJob("j").localActivities, 1);
  assert.equal(newLease.release(), true);
  assert.equal(s.getJob("j").localActivities, 0);
  assertSlotInvariant(s);

  // Terminal/retry boundary fence: complete, then a parallel job path.
  const s2 = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s2.createJob({
    id: "t",
    providerKey: "p.com",
    intent: intent("t.mp4"),
    segmentConcurrency: 2,
    retries: 2,
  });
  s2.enqueue("t");
  const stale = s2.acquireLocalActivity("t", "assembly");
  // Force terminal via cancel after making quiescent first would clear; instead
  // complete while activity held should invalidate epoch (forced boundary).
  s2.onTransportResult("t", s2.getJob("t").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  assert.equal(s2.getJob("t").state, "completed");
  assert.equal(s2.getJob("t").localActivities, 0);
  assert.equal(stale.release(), false);

  // Fresh job after terminal of a different id is isolated.
  s2.createJob({
    id: "u",
    providerKey: "p.com",
    intent: intent("u.mp4"),
    segmentConcurrency: 2,
    retries: 2,
  });
  s2.enqueue("u");
  const live = s2.acquireLocalActivity("u", "assembly");
  assert.equal(s2.getJob("u").localActivities, 1);
  assert.equal(stale.release(), false);
  assert.equal(s2.getJob("u").localActivities, 1);
  assert.equal(live.release(), true);
  assert.equal(s2.getJob("u").localActivities, 0);
  assertSlotInvariant(s2);
});

// ---------------------------------------------------------------------------
// 7. Cancel denies new acquires; existing activity holds cancellation settle
// ---------------------------------------------------------------------------

test("7 cancel denies new acquires; last release settles cancelled once", () => {
  // Running + cancelRequested: deny new leases; transport cancel settles and
  // invalidates any outstanding lease epoch.
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s.createJob({
    id: "j",
    providerKey: "p.com",
    intent: intent("a.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.enqueue("j");
  const leaseRun = s.acquireLocalActivity("j", "assembly");
  s.cancel("j");
  assert.equal(s.getJob("j").state, "running");
  assert.equal(s.acquireLocalActivity("j", "other"), null);
  s.onTransportResult("j", s.getJob("j").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  assert.equal(s.getJob("j").state, "cancelled");
  assert.equal(s.getJob("j").localActivities, 0);
  assert.equal(leaseRun.release(), false);
  assertSlotInvariant(s);

  // Pausing cancellation held by local activity until last release.
  const s2 = createDownloadScheduler({ maxConcurrent: 3, now: () => 0 });
  s2.createJob({
    id: "A",
    providerKey: "p.com",
    intent: intent("a.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s2.createJob({
    id: "B",
    providerKey: "p.com",
    intent: intent("b.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s2.createJob({
    id: "C",
    providerKey: "p.com",
    intent: intent("c.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s2.enqueue("A");
  s2.enqueue("B");
  s2.enqueue("C");
  s2.notePermitAcquired("A");
  s2.noteNativeOpen("A", 1);
  const leaseB = s2.acquireLocalActivity("B", "assembly");
  s2.noteNativeOpen("C", 1);
  s2.onTransportResult("C", s2.getJob("C").attemptToken, {
    status: "failed",
    failureCategory: "http_429",
  });
  assert.equal(s2.getJob("B").state, "pausing_provider");
  assert.equal(s2.getJob("B").localActivities, 1);
  assert.equal(s2.getJob("B").holdsGlobalSlot, true);

  s2.cancel("B");
  assert.equal(s2.getJob("B").state, "pausing_provider");
  assert.equal(s2.getJob("B").holdsGlobalSlot, true);
  assert.equal(s2.acquireLocalActivity("B", "more"), null);

  assert.equal(leaseB.release(), true);
  assert.equal(s2.getJob("B").state, "cancelled");
  assert.equal(s2.getJob("B").holdsGlobalSlot, false);
  assert.equal(s2.getJob("B").localActivities, 0);
  assert.equal(leaseB.release(), false);
  assert.equal(s2.getJob("B").state, "cancelled");
  assertSlotInvariant(s2);
});
// ---------------------------------------------------------------------------
// 8. Firefox handoff rejects while local activity outstanding
// ---------------------------------------------------------------------------

test("8 Firefox handoff rejects while local activity outstanding; proceeds after release", async () => {
  let downloadCalls = 0;
  const store = new Set(["tok-a", "tok-b"]);
  const s = createDownloadScheduler({
    maxConcurrent: 1,
    now: () => 0,
    firefoxDownload: async () => {
      downloadCalls += 1;
      return 1;
    },
    popupTokenStore: store,
  });
  s.createJob({
    id: "j",
    providerKey: "p.com",
    intent: intent("a.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.enqueue("j");
  const lease = s.acquireLocalActivity("j", "assembly");
  assert.equal(s.getJob("j").localActivities, 1);

  const handoffIntent = Object.freeze({
    requestedFilename: "a.mp4",
    destinationDirectory: null,
    saveMode: "default",
    userSelectedFirefox: true,
    userActionToken: "tok-a",
    createdAt: "t0",
  });
  await assert.rejects(() => s.requestFirefoxHandoff("j", handoffIntent));
  assert.equal(downloadCalls, 0);
  assert.equal(s.getJob("j").state, "running");
  assert.equal(s.getJob("j").localActivities, 1);
  // Token must not be consumed on rejection before safety checks complete.
  // (Existing scheduler consumes only after quiescent check.)
  assert.equal(store.has("tok-a"), true);

  assert.equal(lease.release(), true);
  assert.equal(s.getJob("j").localActivities, 0);

  await s.requestFirefoxHandoff(
    "j",
    Object.freeze({
      requestedFilename: "a.mp4",
      destinationDirectory: null,
      saveMode: "default",
      userSelectedFirefox: true,
      userActionToken: "tok-a",
      createdAt: "t0",
    })
  );
  assert.equal(downloadCalls, 1);
  assert.equal(s.getJob("j").state, "handed_to_firefox");
  assert.equal(s.getJob("j").holdsGlobalSlot, false);
  assertSlotInvariant(s);
});

// ---------------------------------------------------------------------------
// 9. Hostile purpose values and cross-job stale release isolation
// ---------------------------------------------------------------------------

test("9 hostile purpose rejected without coercion; stale release isolated across jobs", () => {
  const s = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
  s.createJob({
    id: "a",
    providerKey: "p.com",
    intent: intent("a.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.createJob({
    id: "b",
    providerKey: "p.com",
    intent: intent("b.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.enqueue("a");
  s.enqueue("b");

  const badPurposes = [
    "",
    "   ",
    null,
    undefined,
    1,
    true,
    { toString: () => "assembly" },
    ["assembly"],
    Object("assembly"), // boxed string
  ];
  for (const p of badPurposes) {
    assert.throws(
      () => s.acquireLocalActivity("a", p),
      (err) => err instanceof TypeError
    );
  }

  // Getter/proxy: must not coerce via valueOf/toString or leak secrets in errors.
  let getterHits = 0;
  const getterObj = {};
  Object.defineProperty(getterObj, "toString", {
    get() {
      getterHits += 1;
      throw new Error("SECRET_PURPOSE_GETTER");
    },
  });
  Object.defineProperty(getterObj, "valueOf", {
    get() {
      getterHits += 1;
      throw new Error("SECRET_PURPOSE_VALUEOF");
    },
  });
  assert.throws(
    () => s.acquireLocalActivity("a", getterObj),
    (err) => {
      assert.ok(err instanceof TypeError);
      assert.equal(String(err.message).includes("SECRET_PURPOSE"), false);
      return true;
    }
  );
  assert.equal(getterHits, 0);

  const leaseA = s.acquireLocalActivity("a", "assembly");
  const leaseB = s.acquireLocalActivity("b", "sink");
  assert.equal(s.getJob("a").localActivities, 1);
  assert.equal(s.getJob("b").localActivities, 1);

  // Complete A (invalidates A's epoch); B untouched.
  s.onTransportResult("a", s.getJob("a").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  assert.equal(s.getJob("a").state, "completed");
  assert.equal(s.getJob("a").localActivities, 0);
  assert.equal(leaseA.release(), false);
  assert.equal(s.getJob("b").localActivities, 1);
  assert.equal(s.getJob("b").state, "running");
  assert.equal(leaseB.release(), true);
  assert.equal(s.getJob("b").localActivities, 0);
  assertSlotInvariant(s);
});

// ---------------------------------------------------------------------------
// 10. Full projection key assertion includes only numeric localActivities
// ---------------------------------------------------------------------------

test("10 projection keys include only numeric localActivities; no private fields", () => {
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s.createJob({
    id: "j",
    providerKey: "p.com",
    intent: intent("a.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  assertProjectionKeys(s.getJob("j"));
  assert.equal(s.getJob("j").localActivities, 0);
  s.enqueue("j");
  const lease = s.acquireLocalActivity("j", "assembly");
  assertProjectionKeys(s.getJob("j"));
  assert.equal(s.getJob("j").localActivities, 1);
  const snap = s.getSnapshot();
  assert.ok(Object.isFrozen(snap));
  assert.ok(Object.isFrozen(snap.jobs));
  snap.jobs.forEach(assertProjectionKeys);
  assert.equal(lease.release(), true);
  assertProjectionKeys(s.getJob("j"));
  assert.equal(s.getJob("j").localActivities, 0);
  assertSlotInvariant(s);
});
