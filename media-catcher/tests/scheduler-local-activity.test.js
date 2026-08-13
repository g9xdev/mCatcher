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
  let clearCalls = 0;
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s.createJob({
    id: "j",
    providerKey: "p.com",
    intent: intent("a.mp4"),
    segmentConcurrency: 2,
    retries: 1,
    ephemeral: {
      clear: function () {
        clearCalls += 1;
      },
    },
  });
  s.enqueue("j");
  const oldLease = s.acquireLocalActivity("j", "assembly");
  assert.equal(s.getJob("j").localActivities, 1);
  const verBefore = s.getJob("j").stateVersion;

  // Helper disconnect fences local work immediately: local-only → needs_user.
  // Old lease must become a false no-op without requiring the dead adapter closure.
  assert.equal(s.onTransportUnavailable("j"), true);
  assert.equal(s.getJob("j").state, "needs_user");
  assert.equal(s.getJob("j").holdsGlobalSlot, false);
  assert.equal(s.getJob("j").localActivities, 0);
  assert.equal(s.getJob("j").stateVersion, verBefore + 1);
  assert.equal(clearCalls, 0); // needs_user retains ephemeral for manualRetry
  assert.equal(oldLease.release(), false);
  assert.equal(s.getJob("j").localActivities, 0);
  assert.equal(s.getJob("j").state, "needs_user");
  assert.equal(s.getJob("j").stateVersion, verBefore + 1);

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

// ---------------------------------------------------------------------------
// 11. Defect 1: helper disconnect fences local activities (local-only paths)
// ---------------------------------------------------------------------------

test("11a running local-only unavailable settles needs_user immediately; old release false", () => {
  let clearCalls = 0;
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s.createJob({
    id: "j",
    providerKey: "p.com",
    intent: intent("a.mp4"),
    segmentConcurrency: 2,
    retries: 1,
    ephemeral: {
      clear: function () {
        clearCalls += 1;
      },
    },
  });
  s.enqueue("j");
  const lease = s.acquireLocalActivity("j", "assembly");
  assert.equal(s.getJob("j").localActivities, 1);
  const ver = s.getJob("j").stateVersion;
  const globalBefore = s.getSnapshot().globalRunning;

  assert.equal(s.onTransportUnavailable("j"), true);
  assert.equal(s.getJob("j").state, "needs_user");
  assert.equal(s.getJob("j").localActivities, 0);
  assert.equal(s.getJob("j").holdsGlobalSlot, false);
  assert.equal(s.getSnapshot().globalRunning, globalBefore - 1);
  assert.equal(s.getJob("j").stateVersion, ver + 1);
  assert.equal(clearCalls, 0);
  assert.equal(lease.release(), false);
  assert.equal(s.getJob("j").localActivities, 0);
  assert.equal(s.getJob("j").stateVersion, ver + 1);
  assertSlotInvariant(s);
});

test("11b cancel+unavailable local-only settles cancelled once; old release false", () => {
  let clearCalls = 0;
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s.createJob({
    id: "j",
    providerKey: "p.com",
    intent: intent("a.mp4"),
    segmentConcurrency: 2,
    retries: 1,
    ephemeral: {
      clear: function () {
        clearCalls += 1;
      },
    },
  });
  s.enqueue("j");
  const lease = s.acquireLocalActivity("j", "assembly");
  s.cancel("j");
  assert.equal(s.getJob("j").state, "running");
  const ver = s.getJob("j").stateVersion;

  assert.equal(s.onTransportUnavailable("j"), true);
  assert.equal(s.getJob("j").state, "cancelled");
  assert.equal(s.getJob("j").localActivities, 0);
  assert.equal(s.getJob("j").holdsGlobalSlot, false);
  assert.equal(s.getJob("j").stateVersion, ver + 1);
  assert.equal(clearCalls, 1);
  assert.equal(lease.release(), false);
  assert.equal(clearCalls, 1);
  assert.equal(s.getJob("j").stateVersion, ver + 1);
  assertSlotInvariant(s);
});

test("11c pausing local-only unavailable settles needs_user; ordinary pause retains local", () => {
  const s = createDownloadScheduler({ maxConcurrent: 3, now: () => 0 });
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
  s.notePermitAcquired("A");
  s.noteNativeOpen("A", 1);
  const leaseB = s.acquireLocalActivity("B", "assembly");
  s.noteNativeOpen("C", 1);

  // Ordinary saturation pause must NOT clear local activities.
  s.onTransportResult("C", s.getJob("C").attemptToken, {
    status: "failed",
    failureCategory: "http_429",
  });
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.equal(s.getJob("B").localActivities, 1);
  assert.equal(s.getJob("B").holdsGlobalSlot, true);

  // Helper disconnect on the local-only pausing peer settles needs_user.
  const ver = s.getJob("B").stateVersion;
  assert.equal(s.onTransportUnavailable("B"), true);
  assert.equal(s.getJob("B").state, "needs_user");
  assert.equal(s.getJob("B").localActivities, 0);
  assert.equal(s.getJob("B").holdsGlobalSlot, false);
  assert.equal(s.getJob("B").stateVersion, ver + 1);
  assert.equal(leaseB.release(), false);
  assert.equal(s.getJob("B").localActivities, 0);
  assertSlotInvariant(s);
});

test("11d pending completed + local + unavailable preserves completed; old release inert", () => {
  let clearB = 0;
  const s = createDownloadScheduler({ maxConcurrent: 3, now: () => 0 });
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
  s.noteNativeOpen("C", 1);
  const bToken = s.getJob("B").attemptToken;

  s.onTransportResult("C", s.getJob("C").attemptToken, {
    status: "failed",
    failureCategory: "http_429",
  });
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.equal(s.onDrainingTransportResult("B", bToken, completedResult()), true);
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.equal(s.getJob("B").localActivities, 1);
  assert.equal(clearB, 0);

  const ver = s.getJob("B").stateVersion;
  assert.equal(s.onTransportUnavailable("B"), true);
  // Completed pending terminal wins; local activity is fenced, not waited on.
  assert.equal(s.getJob("B").state, "completed");
  assert.equal(s.getJob("B").localActivities, 0);
  assert.equal(s.getJob("B").holdsGlobalSlot, false);
  assert.equal(s.getJob("B").stateVersion, ver + 1);
  assert.equal(clearB, 1);
  assert.equal(leaseB.release(), false);
  assert.equal(clearB, 1);
  assert.equal(s.getJob("B").stateVersion, ver + 1);
  assertSlotInvariant(s);
});

test("11e wrapper-permit + local unavailable clears only local; slot held until wrapper release", () => {
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s.createJob({
    id: "j",
    providerKey: "p.com",
    intent: intent("a.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.enqueue("j");
  const permit = s.acquireProviderPermit("j", "chunk");
  assert.ok(permit);
  const lease = s.acquireLocalActivity("j", "assembly");
  assert.equal(s.getJob("j").localActivities, 1);
  assert.equal(s.getJob("j").inFlightPermits, 1);
  const ver = s.getJob("j").stateVersion;
  const globalBefore = s.getSnapshot().globalRunning;

  assert.equal(s.onTransportUnavailable("j"), true);
  // Provider permit remains: hold pausing/slot; local activity fenced only.
  assert.equal(s.getJob("j").state, "pausing_provider");
  assert.equal(s.getJob("j").holdsGlobalSlot, true);
  assert.equal(s.getJob("j").localActivities, 0);
  assert.equal(s.getJob("j").inFlightPermits, 1);
  assert.equal(s.getSnapshot().globalRunning, globalBefore);
  assert.ok(s.getJob("j").stateVersion >= ver);
  assert.equal(lease.release(), false);
  assert.equal(s.getJob("j").localActivities, 0);
  assert.equal(s.getJob("j").state, "pausing_provider");
  assert.equal(s.getJob("j").holdsGlobalSlot, true);

  // Final provider release settles needs_user once.
  permit.release();
  assert.equal(s.getJob("j").state, "needs_user");
  assert.equal(s.getJob("j").holdsGlobalSlot, false);
  assert.equal(s.getJob("j").inFlightPermits, 0);
  assert.equal(s.getJob("j").localActivities, 0);
  assertSlotInvariant(s);
});

// ---------------------------------------------------------------------------
// Hostile gate helpers for local-release failure atomicity
// ---------------------------------------------------------------------------

const path = require("node:path");

function installHostileGate(realGate, gatePath, hooks) {
  hooks = hooks || {};
  require.cache[require.resolve(gatePath)] = {
    id: gatePath,
    filename: gatePath,
    loaded: true,
    exports: {
      createProviderGate: function (opts) {
        const g = realGate.createProviderGate(opts);
        if (typeof hooks.onGate === "function") hooks.onGate(g);
        return {
          get providerKey() {
            return g.providerKey;
          },
          get state() {
            return g.state;
          },
          get generation() {
            return g.generation;
          },
          get wakeGeneration() {
            return g.wakeGeneration;
          },
          acquire: g.acquire.bind(g),
          setSaturated: g.setSaturated.bind(g),
          registerJobLimit: g.registerJobLimit.bind(g),
          nativeLeaseFor: g.nativeLeaseFor.bind(g),
          noteNativeOpen: g.noteNativeOpen.bind(g),
          parkProbe: g.parkProbe.bind(g),
          completeOwner: g.completeOwner.bind(g),
          designateRecoveryOwner: g.designateRecoveryOwner.bind(g),
          recoverToNormal: hooks.recoverToNormal
            ? function (args) {
                return hooks.recoverToNormal(g, args);
              }
            : g.recoverToNormal.bind(g),
          snapshot: hooks.snapshot
            ? function () {
                return hooks.snapshot(g);
              }
            : g.snapshot.bind(g),
        };
      },
    },
  };
}

function loadSchedulerFresh(schedPath) {
  delete require.cache[require.resolve(schedPath)];
  return require(schedPath).createDownloadScheduler;
}

function restoreModuleCache(gatePath, schedPath, prevGate, prevSched) {
  if (prevGate) require.cache[require.resolve(gatePath)] = prevGate;
  else delete require.cache[require.resolve(gatePath)];
  if (prevSched) require.cache[require.resolve(schedPath)] = prevSched;
  else delete require.cache[require.resolve(schedPath)];
  delete require.cache[require.resolve(schedPath)];
  loadLib("lib/download-scheduler.js");
}

// ---------------------------------------------------------------------------
// 12. Defect 2: release is failure-atomic/boolean and never strands waiters
// ---------------------------------------------------------------------------

test("12a A/B/C local-only B: snapshot throw-after-waiting-transition does not strand; release boolean", () => {
  // Independent reproduction: A/B/C same provider; B local-only pauses; A completes,
  // C recovers; gate normal while B still pausing on local. snapshot() throws during
  // authorize after mutate → must not permanently strand B or mark lease released
  // without coherent completion (mutate-then finalizes true without duplicate wake).
  const gatePath = path.resolve(__dirname, "..", "lib", "provider-gate.js");
  const schedPath = path.resolve(__dirname, "..", "lib", "download-scheduler.js");
  const realGate = require(gatePath);
  const prevGate = require.cache[require.resolve(gatePath)];
  const prevSched = require.cache[require.resolve(schedPath)];
  let mode = "pass";
  let snapshotCalls = 0;
  let authorizeSnapshots = 0;
  try {
    installHostileGate(realGate, gatePath, {
      snapshot: function (g) {
        snapshotCalls += 1;
        const snap = g.snapshot();
        // After B has been moved toward waiting, throw on the authorize snapshot.
        if (mode === "throw-on-authorize" && snap.state === "normal") {
          authorizeSnapshots += 1;
          // First normal-gate authorize attempt during B release throws.
          if (authorizeSnapshots === 1) {
            throw new Error("simulated ProviderGate.snapshot throw during authorize");
          }
        }
        return snap;
      },
    });
    const create = loadSchedulerFresh(schedPath);
    const s = create({ maxConcurrent: 3, now: () => 0 });
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
    s.notePermitAcquired("A");
    s.noteNativeOpen("A", 1);
    const leaseB = s.acquireLocalActivity("B", "assembly");
    s.noteNativeOpen("C", 1);
    s.onTransportResult("C", s.getJob("C").attemptToken, {
      status: "failed",
      failureCategory: "http_429",
    });
    assert.equal(s.getJob("B").state, "pausing_provider");
    assert.equal(s.getJob("B").localActivities, 1);
    assert.equal(s.getJob("B").holdsGlobalSlot, true);

    // A completes ownership → recovery; C recovers to normal while B still pausing.
    s.noteNativeOpen("A", 0);
    s.releasePermit("A");
    s.onTransportResult("A", s.getJob("A").attemptToken, {
      status: "completed",
      failureCategory: null,
    });
    // Drive C through recovery if still waiting/running under reduced ownership.
    if (s.getJob("C").state === "waiting_provider" || s.getJob("C").state === "running") {
      // Ensure gate returns to normal so B would authorize on quiesce.
      const gateState = s.getSnapshot().providers["p.com"].gate.state;
      if (gateState === "recovering" || gateState === "saturated") {
        // Complete C if it became recovery owner, else leave as-is.
        if (s.getJob("C").state === "running") {
          s.noteNativeOpen("C", 0);
          s.onTransportResult("C", s.getJob("C").attemptToken, {
            status: "completed",
            failureCategory: null,
          });
        }
      }
    }
    // B still pausing on local activity with gate eventually normal/recovering-blocked.
    assert.equal(s.getJob("B").state, "pausing_provider");
    assert.equal(s.getJob("B").localActivities, 1);

    mode = "throw-on-authorize";
    authorizeSnapshots = 0;
    let threw = false;
    let releaseResult = undefined;
    try {
      releaseResult = leaseB.release();
    } catch (e) {
      threw = true;
    }
    assert.equal(threw, false, "public release must never throw");
    assert.equal(typeof releaseResult, "boolean");

    // After coherent mutate-then path: B must not be permanently stranded.
    // Either release returned true with natural progress, or false and retryable.
    // Do not manually onQuiesced — release itself must complete authorize/drain.
    if (releaseResult === true) {
      assert.equal(s.getJob("B").localActivities, 0);
      assert.notEqual(s.getJob("B").state, "pausing_provider");
      // Coherent progress: authorized wake, queued, or re-admitted running.
      // Still-waiting is only coherent when correctly parked under an active owner.
      assert.ok(
        s.getJob("B").state === "waiting_provider" ||
          s.getJob("B").state === "queued" ||
          s.getJob("B").state === "running",
        "B progressed from pausing, state=" + s.getJob("B").state
      );
      // Stale second release inert; no negative counts / no double cleanup.
      assert.equal(leaseB.release(), false);
      assert.ok(s.getJob("B").localActivities >= 0);
    } else {
      // Incomplete progress: same closure remains retryable. First false may
      // already have applied the decrement (count zero) under transaction semantics.
      mode = "pass";
      assert.ok(s.getJob("B").localActivities >= 0);
      assert.ok(s.getJob("B").localActivities <= 1);
      assert.equal(leaseB.release(), true);
      assert.equal(s.getJob("B").localActivities, 0);
      assert.notEqual(s.getJob("B").state, "pausing_provider");
      assert.equal(leaseB.release(), false);
    }

    // Pausing slot is released once; running re-admission may hold a fresh slot.
    if (s.getJob("B").state === "pausing_provider") {
      assert.equal(s.getJob("B").holdsGlobalSlot, true);
    } else if (
      s.getJob("B").state === "waiting_provider" ||
      s.getJob("B").state === "queued" ||
      s.getJob("B").state === "needs_user"
    ) {
      assert.equal(s.getJob("B").holdsGlobalSlot, false);
    }
    mode = "pass";
    assertSlotInvariant(s);
  } finally {
    restoreModuleCache(gatePath, schedPath, prevGate, prevSched);
  }
});

test("12b snapshot throw-before mutation keeps lease retryable; mutate-then finalizes true", () => {
  const gatePath = path.resolve(__dirname, "..", "lib", "provider-gate.js");
  const schedPath = path.resolve(__dirname, "..", "lib", "download-scheduler.js");
  const realGate = require(gatePath);
  const prevGate = require.cache[require.resolve(gatePath)];
  const prevSched = require.cache[require.resolve(schedPath)];
  let mode = "pass";
  let snapThrows = 0;
  try {
    installHostileGate(realGate, gatePath, {
      snapshot: function (g) {
        if (mode === "throw-before") {
          snapThrows += 1;
          throw new Error("simulated snapshot throw before any release mutation");
        }
        if (mode === "throw-after-once") {
          const snap = g.snapshot();
          // Throw only after gate is normal and job path will authorize post-mutate.
          if (snap.state === "normal") {
            mode = "pass";
            throw new Error("simulated snapshot throw after waiting transition");
          }
          return snap;
        }
        return g.snapshot();
      },
    });
    const create = loadSchedulerFresh(schedPath);
    const s = create({ maxConcurrent: 3, now: () => 0 });
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
    s.notePermitAcquired("A");
    s.noteNativeOpen("A", 1);
    const leaseB = s.acquireLocalActivity("B", "assembly");
    s.noteNativeOpen("C", 1);
    s.onTransportResult("C", s.getJob("C").attemptToken, {
      status: "failed",
      failureCategory: "http_429",
    });
    assert.equal(s.getJob("B").state, "pausing_provider");

    // Complete A and C so gate returns to normal while B holds local activity.
    s.noteNativeOpen("A", 0);
    s.releasePermit("A");
    s.onTransportResult("A", s.getJob("A").attemptToken, {
      status: "completed",
      failureCategory: null,
    });
    if (s.getJob("C").state === "running") {
      s.noteNativeOpen("C", 0);
      s.onTransportResult("C", s.getJob("C").attemptToken, {
        status: "completed",
        failureCategory: null,
      });
    }
    assert.equal(s.getJob("B").state, "pausing_provider");
    assert.equal(s.getJob("B").localActivities, 1);
    const verPause = s.getJob("B").stateVersion;
    const globalBefore = s.getSnapshot().globalRunning;

    // --- throw-before: if release path hits snapshot before counting mutation ---
    // Ordinary pause→wait does not snapshot before decrement; force a pre-check by
    // throwing on any snapshot. Public release must not throw; if it returns false
    // the lease stays retryable with localActivities still 1.
    mode = "throw-before";
    snapThrows = 0;
    let r1;
    let threw1 = false;
    try {
      r1 = leaseB.release();
    } catch (e) {
      threw1 = true;
    }
    assert.equal(threw1, false);
    assert.equal(typeof r1, "boolean");
    mode = "pass"; // projection reads must not keep seeing injected faults
    if (r1 === false) {
      // Transaction semantics: first false may leave decrementApplied and count 0,
      // or throw-before may leave count 1. Same closure stays retryable either way.
      assert.ok(s.getJob("B").localActivities >= 0);
      assert.ok(s.getJob("B").localActivities <= 1);
      if (s.getJob("B").localActivities === 1) {
        assert.equal(s.getJob("B").state, "pausing_provider");
        assert.equal(s.getJob("B").holdsGlobalSlot, true);
        assert.equal(s.getSnapshot().globalRunning, globalBefore);
        assert.equal(s.getJob("B").stateVersion, verPause);
      }
    } else {
      // Implementation may avoid pre-mutation snapshot entirely — then true is fine.
      assert.equal(s.getJob("B").localActivities, 0);
      assert.notEqual(s.getJob("B").state, "pausing_provider");
    }

    // --- mutate-then-throw on authorize: finalize true, no strand, stale inert ---
    if (s.getJob("B").state === "pausing_provider" || r1 === false) {
      if (s.getJob("B").state === "pausing_provider") {
        mode = "throw-after-once";
        let r2;
        let threw2 = false;
        try {
          r2 = leaseB.release();
        } catch (e) {
          threw2 = true;
        }
        assert.equal(threw2, false);
        // Mutate-then with a single authorize fault must not seal success while stranded.
        assert.equal(typeof r2, "boolean");
        mode = "pass";
        if (r2 === false) {
          assert.equal(leaseB.release(), true);
        }
      } else {
        // Already left pausing under throw-before path that still progressed;
        // same closure must seal true exactly once when progress clears.
        mode = "pass";
        assert.equal(leaseB.release(), true);
      }
      assert.equal(s.getJob("B").localActivities, 0);
      assert.notEqual(s.getJob("B").state, "pausing_provider");
      // Natural non-stranding: no manual onQuiesced rescue.
      assert.ok(
        s.getJob("B").state === "waiting_provider" ||
          s.getJob("B").state === "queued" ||
          s.getJob("B").state === "running"
      );
      if (
        s.getJob("B").state === "waiting_provider" ||
        s.getJob("B").state === "queued"
      ) {
        assert.equal(s.getJob("B").holdsGlobalSlot, false);
      }
      assert.equal(leaseB.release(), false);
      assert.ok(s.getJob("B").localActivities >= 0);
    }
    mode = "pass";
    assertSlotInvariant(s);
  } finally {
    restoreModuleCache(gatePath, schedPath, prevGate, prevSched);
  }
});

test("12c pending-drain settlement: snapshot fault before/after mutation is boolean-safe", () => {
  const gatePath = path.resolve(__dirname, "..", "lib", "provider-gate.js");
  const schedPath = path.resolve(__dirname, "..", "lib", "download-scheduler.js");
  const realGate = require(gatePath);
  const prevGate = require.cache[require.resolve(gatePath)];
  const prevSched = require.cache[require.resolve(schedPath)];
  let mode = "pass";
  try {
    installHostileGate(realGate, gatePath, {
      snapshot: function (g) {
        if (mode === "throw") {
          throw new Error("simulated snapshot fault during drain settlement");
        }
        return g.snapshot();
      },
    });
    const create = loadSchedulerFresh(schedPath);
    let clearB = 0;
    const s = create({ maxConcurrent: 3, now: () => 0 });
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
    s.noteNativeOpen("B", 1);
    const leaseB = s.acquireLocalActivity("B", "assembly");
    s.noteNativeOpen("C", 1);
    const bToken = s.getJob("B").attemptToken;
    s.onTransportResult("C", s.getJob("C").attemptToken, {
      status: "failed",
      failureCategory: "http_429",
    });
    assert.equal(s.onDrainingTransportResult("B", bToken, completedResult()), true);
    assert.equal(s.getJob("B").state, "pausing_provider");
    assert.equal(s.getJob("B").localActivities, 1);

    // Completed settlement does not require gate.snapshot for authorize; inject
    // throw anyway — public release must not throw, and must not double-clear.
    mode = "throw";
    let r;
    let threw = false;
    try {
      r = leaseB.release();
    } catch (e) {
      threw = true;
    }
    assert.equal(threw, false);
    assert.equal(typeof r, "boolean");
    if (r === true) {
      assert.equal(s.getJob("B").state, "completed");
      assert.equal(s.getJob("B").localActivities, 0);
      assert.equal(clearB, 1);
      assert.equal(leaseB.release(), false);
      assert.equal(clearB, 1);
    } else {
      // Retryable path: decrement may already be applied (count 0 or 1).
      assert.ok(s.getJob("B").localActivities >= 0);
      assert.ok(s.getJob("B").localActivities <= 1);
      mode = "pass";
      assert.equal(leaseB.release(), true);
      assert.equal(s.getJob("B").state, "completed");
      assert.equal(clearB, 1);
      assert.equal(leaseB.release(), false);
    }
    mode = "pass";
    assertSlotInvariant(s);
  } finally {
    restoreModuleCache(gatePath, schedPath, prevGate, prevSched);
  }
});

test("12d hostile jobId __proto__ local release + snapshot maps; no strand / no throw", () => {
  const gatePath = path.resolve(__dirname, "..", "lib", "provider-gate.js");
  const schedPath = path.resolve(__dirname, "..", "lib", "download-scheduler.js");
  const realGate = require(gatePath);
  const prevGate = require.cache[require.resolve(gatePath)];
  const prevSched = require.cache[require.resolve(schedPath)];
  const hostileId = "__proto__";
  let mode = "pass";
  try {
    installHostileGate(realGate, gatePath, {
      snapshot: function (g) {
        const snap = g.snapshot();
        if (mode === "throw-once" && snap.state === "normal") {
          mode = "pass";
          throw new Error("simulated snapshot throw for __proto__ job");
        }
        return snap;
      },
    });
    const create = loadSchedulerFresh(schedPath);
    const s = create({ maxConcurrent: 3, now: () => 0 });
    s.createJob({
      id: "A",
      providerKey: "p.com",
      intent: intent("a.mp4"),
      segmentConcurrency: 4,
      retries: 3,
    });
    s.createJob({
      id: hostileId,
      providerKey: "p.com",
      intent: intent("h.mp4"),
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
    s.enqueue(hostileId);
    s.enqueue("C");
    s.notePermitAcquired("A");
    s.noteNativeOpen("A", 1);
    const lease = s.acquireLocalActivity(hostileId, "assembly");
    assert.ok(lease);
    assert.equal(lease.jobId, hostileId);
    s.noteNativeOpen("C", 1);
    s.onTransportResult("C", s.getJob("C").attemptToken, {
      status: "failed",
      failureCategory: "http_429",
    });
    assert.equal(s.getJob(hostileId).state, "pausing_provider");
    assert.equal(s.getJob(hostileId).localActivities, 1);

    s.noteNativeOpen("A", 0);
    s.releasePermit("A");
    s.onTransportResult("A", s.getJob("A").attemptToken, {
      status: "completed",
      failureCategory: null,
    });
    if (s.getJob("C").state === "running") {
      s.noteNativeOpen("C", 0);
      s.onTransportResult("C", s.getJob("C").attemptToken, {
        status: "completed",
        failureCategory: null,
      });
    }

    mode = "throw-once";
    let r;
    let threw = false;
    try {
      r = lease.release();
    } catch (e) {
      threw = true;
    }
    assert.equal(threw, false);
    assert.equal(typeof r, "boolean");
    mode = "pass";
    if (r === false) {
      // Same closure stays retryable; count may already be zero.
      assert.ok(s.getJob(hostileId).localActivities >= 0);
      assert.ok(s.getJob(hostileId).localActivities <= 1);
      assert.equal(lease.release(), true);
    }
    assert.equal(s.getJob(hostileId).localActivities, 0);
    assert.notEqual(s.getJob(hostileId).state, "pausing_provider");
    if (
      s.getJob(hostileId).state === "waiting_provider" ||
      s.getJob(hostileId).state === "queued" ||
      s.getJob(hostileId).state === "needs_user"
    ) {
      assert.equal(s.getJob(hostileId).holdsGlobalSlot, false);
    }
    assert.equal(lease.release(), false);
    assertSlotInvariant(s);
  } finally {
    restoreModuleCache(gatePath, schedPath, prevGate, prevSched);
  }
});

// ---------------------------------------------------------------------------
// 13. Defect A: waiting-authorization strand — multi-fault release must stay
//     retryable; never seal true while authorize/drain progress is unconfirmed.
// ---------------------------------------------------------------------------

/**
 * A/B/C same provider; B local-only pauses; drive gate back toward normal while
 * B still holds the local lease. Returns { s, leaseB, ... }.
 */
function setupLocalOnlyBWaitingAuthorize(create) {
  const s = create({ maxConcurrent: 3, now: () => 0 });
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
  s.notePermitAcquired("A");
  s.noteNativeOpen("A", 1);
  const leaseB = s.acquireLocalActivity("B", "assembly");
  s.noteNativeOpen("C", 1);
  s.onTransportResult("C", s.getJob("C").attemptToken, {
    status: "failed",
    failureCategory: "http_429",
  });
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.equal(s.getJob("B").localActivities, 1);
  assert.equal(s.getJob("B").holdsGlobalSlot, true);

  s.noteNativeOpen("A", 0);
  s.releasePermit("A");
  s.onTransportResult("A", s.getJob("A").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  if (s.getJob("C").state === "running") {
    s.noteNativeOpen("C", 0);
    s.onTransportResult("C", s.getJob("C").attemptToken, {
      status: "completed",
      failureCategory: null,
    });
  }
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.equal(s.getJob("B").localActivities, 1);
  return { s: s, leaseB: leaseB };
}

function assertReleaseNoThrow(lease) {
  let threw = false;
  let result = undefined;
  try {
    result = lease.release();
  } catch (e) {
    threw = true;
  }
  assert.equal(threw, false, "public release must never throw");
  assert.equal(typeof result, "boolean");
  return result;
}

test("13a two transient authorize snapshot throws: first release false, retry true, third false", () => {
  const gatePath = path.resolve(__dirname, "..", "lib", "provider-gate.js");
  const schedPath = path.resolve(__dirname, "..", "lib", "download-scheduler.js");
  const realGate = require(gatePath);
  const prevGate = require.cache[require.resolve(gatePath)];
  const prevSched = require.cache[require.resolve(schedPath)];
  let throwsLeft = 0;
  try {
    installHostileGate(realGate, gatePath, {
      snapshot: function (g) {
        if (throwsLeft > 0) {
          throwsLeft -= 1;
          throw new Error("simulated transient ProviderGate.snapshot throw");
        }
        return g.snapshot();
      },
    });
    const create = loadSchedulerFresh(schedPath);
    const { s, leaseB } = setupLocalOnlyBWaitingAuthorize(create);
    const globalBefore = s.getSnapshot().globalRunning;
    const verBefore = s.getJob("B").stateVersion;

    // Exactly two transient faults across the release progress edge.
    throwsLeft = 2;
    const r1 = assertReleaseNoThrow(leaseB);
    assert.equal(r1, false, "unconfirmed authorize/drain must not seal release=true");
    // No manual onQuiesced / tick rescue — lease stays retryable.
    assert.ok(s.getJob("B").localActivities >= 0);
    assert.ok(s.getJob("B").localActivities <= 1);
    // Must not double-release slot or go negative on retries.
    assert.ok(s.getSnapshot().globalRunning <= globalBefore);
    assertSlotInvariant(s);

    throwsLeft = 0;
    const r2 = assertReleaseNoThrow(leaseB);
    assert.equal(r2, true);
    assert.equal(s.getJob("B").localActivities, 0);
    assert.notEqual(s.getJob("B").state, "pausing_provider");
    // Natural authorize/admit/wake — no stranded wait FIFO head without edge.
    assert.ok(
      s.getJob("B").state === "queued" ||
        s.getJob("B").state === "running" ||
        s.getJob("B").state === "waiting_provider",
      "B state=" + s.getJob("B").state
    );
    if (s.getJob("B").state === "waiting_provider") {
      // Only coherent if parked under an active owner (not normal/blocked).
      const gate = s.getSnapshot().providers["p.com"].gate;
      assert.ok(
        (gate.state === "saturated" || gate.state === "recovering") &&
          gate.ownerJobId != null,
        "waiting under normal/blocked gate is stranded"
      );
    } else {
      assert.ok(s.getJob("B").stateVersion >= verBefore);
    }

    const r3 = assertReleaseNoThrow(leaseB);
    assert.equal(r3, false);
    assert.equal(s.getJob("B").localActivities, 0);
    assertSlotInvariant(s);
  } finally {
    restoreModuleCache(gatePath, schedPath, prevGate, prevSched);
  }
});

test("13b persistent authorize snapshot throw for three attempts then recover once", () => {
  const gatePath = path.resolve(__dirname, "..", "lib", "provider-gate.js");
  const schedPath = path.resolve(__dirname, "..", "lib", "download-scheduler.js");
  const realGate = require(gatePath);
  const prevGate = require.cache[require.resolve(gatePath)];
  const prevSched = require.cache[require.resolve(schedPath)];
  let fault = false;
  try {
    installHostileGate(realGate, gatePath, {
      snapshot: function (g) {
        if (fault) throw new Error("simulated persistent snapshot fault");
        return g.snapshot();
      },
    });
    const create = loadSchedulerFresh(schedPath);
    // Setup must complete without the persistent fault armed.
    const { s, leaseB } = setupLocalOnlyBWaitingAuthorize(create);
    const slotBefore = s.getJob("B").holdsGlobalSlot;
    // Capture baseline with fault disarmed (snapshot-based invariants).
    const globalBefore = s.getSnapshot().globalRunning;

    // Arm only around the intended release/progress edge.
    fault = true;
    for (let i = 0; i < 3; i++) {
      const r = assertReleaseNoThrow(leaseB);
      assert.equal(r, false, "attempt " + i + " must stay retryable under persistent fault");
      assert.ok(s.getJob("B").localActivities >= 0);
      // Temporarily disarm so projection helpers can read exact counters.
      fault = false;
      assertSlotInvariant(s);
      fault = true;
    }
    fault = false;
    // No double slot release across failed attempts.
    assert.ok(s.getSnapshot().globalRunning <= globalBefore);
    if (s.getJob("B").state === "pausing_provider") {
      assert.equal(s.getJob("B").holdsGlobalSlot, true);
    } else if (s.getJob("B").state === "waiting_provider") {
      assert.equal(s.getJob("B").holdsGlobalSlot, false);
      // Slot released at most once.
      assert.equal(s.getSnapshot().globalRunning, globalBefore - (slotBefore ? 1 : 0));
    }

    assert.equal(assertReleaseNoThrow(leaseB), true);
    assert.equal(s.getJob("B").localActivities, 0);
    assert.notEqual(s.getJob("B").state, "pausing_provider");
    assert.equal(assertReleaseNoThrow(leaseB), false);
    assertSlotInvariant(s);
  } finally {
    restoreModuleCache(gatePath, schedPath, prevGate, prevSched);
  }
});

test("13c hostile ids __proto__ and constructor: two-throw authorize stays retryable", () => {
  const gatePath = path.resolve(__dirname, "..", "lib", "provider-gate.js");
  const schedPath = path.resolve(__dirname, "..", "lib", "download-scheduler.js");
  const realGate = require(gatePath);
  const prevGate = require.cache[require.resolve(gatePath)];
  const prevSched = require.cache[require.resolve(schedPath)];
  const cases = [
    { jobId: "__proto__", providerKey: "constructor" },
    { jobId: "constructor", providerKey: "__proto__" },
  ];
  for (const c of cases) {
    let throwsLeft = 0;
    try {
      installHostileGate(realGate, gatePath, {
        snapshot: function (g) {
          if (throwsLeft > 0) {
            throwsLeft -= 1;
            throw new Error("hostile-id snapshot throw");
          }
          return g.snapshot();
        },
      });
      const create = loadSchedulerFresh(schedPath);
      const s = create({ maxConcurrent: 3, now: () => 0 });
      s.createJob({
        id: "A",
        providerKey: c.providerKey,
        intent: intent("a.mp4"),
        segmentConcurrency: 4,
        retries: 3,
      });
      s.createJob({
        id: c.jobId,
        providerKey: c.providerKey,
        intent: intent("h.mp4"),
        segmentConcurrency: 4,
        retries: 3,
      });
      s.createJob({
        id: "C",
        providerKey: c.providerKey,
        intent: intent("c.mp4"),
        segmentConcurrency: 4,
        retries: 3,
      });
      s.enqueue("A");
      s.enqueue(c.jobId);
      s.enqueue("C");
      s.notePermitAcquired("A");
      s.noteNativeOpen("A", 1);
      const lease = s.acquireLocalActivity(c.jobId, "assembly");
      assert.ok(lease);
      assert.equal(lease.jobId, c.jobId);
      s.noteNativeOpen("C", 1);
      s.onTransportResult("C", s.getJob("C").attemptToken, {
        status: "failed",
        failureCategory: "http_429",
      });
      s.noteNativeOpen("A", 0);
      s.releasePermit("A");
      s.onTransportResult("A", s.getJob("A").attemptToken, {
        status: "completed",
        failureCategory: null,
      });
      if (s.getJob("C").state === "running") {
        s.noteNativeOpen("C", 0);
        s.onTransportResult("C", s.getJob("C").attemptToken, {
          status: "completed",
          failureCategory: null,
        });
      }
      assert.equal(s.getJob(c.jobId).state, "pausing_provider");

      throwsLeft = 2;
      assert.equal(assertReleaseNoThrow(lease), false);
      throwsLeft = 0;
      assert.equal(assertReleaseNoThrow(lease), true);
      assert.equal(s.getJob(c.jobId).localActivities, 0);
      assert.notEqual(s.getJob(c.jobId).state, "pausing_provider");
      assert.equal(assertReleaseNoThrow(lease), false);
      assertSlotInvariant(s);
    } finally {
      restoreModuleCache(gatePath, schedPath, prevGate, prevSched);
    }
  }
});

// ---------------------------------------------------------------------------
// 14. Core quiesce mutations + stale fencing + controls
// ---------------------------------------------------------------------------

test("14a mutate-then-throw around slot release never seals pausing+quiescent+slot-held", () => {
  const gatePath = path.resolve(__dirname, "..", "lib", "provider-gate.js");
  const schedPath = path.resolve(__dirname, "..", "lib", "download-scheduler.js");
  const realGate = require(gatePath);
  const prevGate = require.cache[require.resolve(gatePath)];
  const prevSched = require.cache[require.resolve(schedPath)];
  let throwsLeft = 0;
  try {
    installHostileGate(realGate, gatePath, {
      snapshot: function (g) {
        if (throwsLeft > 0) {
          throwsLeft -= 1;
          throw new Error("quiesce-path snapshot throw");
        }
        return g.snapshot();
      },
    });
    const create = loadSchedulerFresh(schedPath);
    // Setup completes with throwsLeft=0 (fault not armed).
    const { s, leaseB } = setupLocalOnlyBWaitingAuthorize(create);

    throwsLeft = 5;
    for (let i = 0; i < 5; i++) {
      const r = assertReleaseNoThrow(leaseB);
      // Read job projection without gate.snapshot (getJob does not snapshot gates).
      const j = s.getJob("B");
      // Never claim success while still pausing, quiescent, and slot-held.
      if (r === true) {
        assert.ok(
          !(
            j.state === "pausing_provider" &&
            j.localActivities === 0 &&
            j.inFlightPermits === 0 &&
            j.nativeOpenConnections === 0 &&
            j.holdsGlobalSlot === true
          ),
          "release=true must not leave pausing+quiescent+slot-held"
        );
        break;
      }
      assert.equal(r, false);
      // Snapshot-based invariant helpers must not run under the armed fault.
      const saved = throwsLeft;
      throwsLeft = 0;
      assertSlotInvariant(s);
      throwsLeft = saved;
    }
    // Persistent multi-fault must not spin forever: bounded attempts, still finite.
    throwsLeft = 0;
    if (s.getJob("B").state === "pausing_provider" || s.getJob("B").localActivities >= 0) {
      const finalR = assertReleaseNoThrow(leaseB);
      if (s.getJob("B").state === "pausing_provider" && s.getJob("B").localActivities === 1) {
        // Still holding unreleased count — one more clean release should finish.
        assert.equal(typeof finalR, "boolean");
      }
      if (finalR === false && s.getJob("B").state !== "running") {
        assert.equal(assertReleaseNoThrow(leaseB), true);
      }
    }
    assert.equal(assertReleaseNoThrow(leaseB), false);
    assertSlotInvariant(s);
  } finally {
    restoreModuleCache(gatePath, schedPath, prevGate, prevSched);
  }
});

test("14b after false release, unavailable/epoch fence seals old closure inert", () => {
  const gatePath = path.resolve(__dirname, "..", "lib", "provider-gate.js");
  const schedPath = path.resolve(__dirname, "..", "lib", "download-scheduler.js");
  const realGate = require(gatePath);
  const prevGate = require.cache[require.resolve(gatePath)];
  const prevSched = require.cache[require.resolve(schedPath)];
  let fault = false;
  try {
    installHostileGate(realGate, gatePath, {
      snapshot: function (g) {
        if (fault) throw new Error("fence-setup snapshot fault");
        return g.snapshot();
      },
    });
    const create = loadSchedulerFresh(schedPath);
    const { s, leaseB } = setupLocalOnlyBWaitingAuthorize(create);

    // Force a false release first (progress unconfirmed).
    fault = true;
    assert.equal(assertReleaseNoThrow(leaseB), false);

    fault = false;
    // External epoch invalidation while retry still outstanding.
    assert.equal(s.onTransportUnavailable("B"), true);
    const stateAfter = s.getJob("B").state;
    assert.ok(
      stateAfter === "needs_user" ||
        stateAfter === "cancelled" ||
        stateAfter === "completed" ||
        stateAfter === "waiting_provider" ||
        stateAfter === "pausing_provider",
      "state=" + stateAfter
    );
    const localAfter = s.getJob("B").localActivities;
    const verAfter = s.getJob("B").stateVersion;
    const globalAfter = s.getSnapshot().globalRunning;

    // Old closure seals inert — no further mutation of the new attempt.
    assert.equal(assertReleaseNoThrow(leaseB), false);
    assert.equal(s.getJob("B").localActivities, localAfter);
    assert.equal(s.getJob("B").stateVersion, verAfter);
    assert.equal(s.getSnapshot().globalRunning, globalAfter);

    if (stateAfter === "needs_user") {
      s.manualRetry("B");
      assert.equal(s.getJob("B").state, "running");
      const live = s.acquireLocalActivity("B", "assembly");
      assert.ok(live);
      assert.equal(s.getJob("B").localActivities, 1);
      assert.equal(assertReleaseNoThrow(leaseB), false);
      assert.equal(s.getJob("B").localActivities, 1);
      assert.equal(assertReleaseNoThrow(live), true);
      assert.equal(s.getJob("B").localActivities, 0);
    }
    assertSlotInvariant(s);
  } finally {
    restoreModuleCache(gatePath, schedPath, prevGate, prevSched);
  }
});

test("14c controls: running decrement, saturation retain, disconnect, wrapper permit, no Firefox", () => {
  let firefoxCalls = 0;
  const sRun = createDownloadScheduler({
    maxConcurrent: 1,
    now: () => 0,
    firefoxDownload: () => {
      firefoxCalls += 1;
    },
  });

  // Ordinary running local decrement true then false.
  sRun.createJob({
    id: "run",
    providerKey: "p.com",
    intent: intent("r.mp4"),
    segmentConcurrency: 2,
    retries: 2,
  });
  sRun.enqueue("run");
  const leaseRun = sRun.acquireLocalActivity("run", "assembly");
  assert.equal(leaseRun.release(), true);
  assert.equal(sRun.getJob("run").localActivities, 0);
  assert.equal(sRun.getJob("run").state, "running");
  assert.equal(leaseRun.release(), false);

  // Ordinary saturation pause retains local activity until release.
  const s = createDownloadScheduler({
    maxConcurrent: 3,
    now: () => 0,
    firefoxDownload: () => {
      firefoxCalls += 1;
    },
  });
  s.createJob({
    id: "A",
    providerKey: "sat.com",
    intent: intent("a.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.createJob({
    id: "B",
    providerKey: "sat.com",
    intent: intent("b.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.createJob({
    id: "C",
    providerKey: "sat.com",
    intent: intent("c.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.enqueue("A");
  s.enqueue("B");
  s.enqueue("C");
  s.notePermitAcquired("A");
  s.noteNativeOpen("A", 1);
  const leaseB = s.acquireLocalActivity("B", "assembly");
  s.noteNativeOpen("C", 1);
  s.onTransportResult("C", s.getJob("C").attemptToken, {
    status: "failed",
    failureCategory: "http_429",
  });
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.equal(s.getJob("B").localActivities, 1);
  assert.equal(s.getJob("B").holdsGlobalSlot, true);

  // Helper disconnect local-only → needs_user; old lease false.
  const s2 = createDownloadScheduler({
    maxConcurrent: 1,
    now: () => 0,
    firefoxDownload: () => {
      firefoxCalls += 1;
    },
  });
  s2.createJob({
    id: "u",
    providerKey: "u.com",
    intent: intent("u.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s2.enqueue("u");
  const leaseU = s2.acquireLocalActivity("u", "sink");
  assert.equal(s2.onTransportUnavailable("u"), true);
  assert.equal(s2.getJob("u").state, "needs_user");
  assert.equal(s2.getJob("u").localActivities, 0);
  assert.equal(leaseU.release(), false);

  // Cancel + unavailable local-only → cancelled.
  const s3 = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s3.createJob({
    id: "k",
    providerKey: "k.com",
    intent: intent("k.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s3.enqueue("k");
  const leaseK = s3.acquireLocalActivity("k", "sink");
  s3.cancel("k");
  assert.equal(s3.onTransportUnavailable("k"), true);
  assert.equal(s3.getJob("k").state, "cancelled");
  assert.equal(leaseK.release(), false);

  // Wrapper/observed permit disconnect still holds slot until physical release.
  const s4 = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
  s4.createJob({
    id: "w",
    providerKey: "w.com",
    intent: intent("w.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s4.enqueue("w");
  const permit = s4.acquireProviderPermit("w", "segment");
  assert.ok(permit);
  const leaseW = s4.acquireLocalActivity("w", "assembly");
  assert.equal(s4.onTransportUnavailable("w"), true);
  assert.equal(s4.getJob("w").state, "pausing_provider");
  assert.equal(s4.getJob("w").holdsGlobalSlot, true);
  assert.equal(s4.getJob("w").localActivities, 0);
  assert.equal(leaseW.release(), false);
  assert.equal(s4.getJob("w").holdsGlobalSlot, true);
  permit.release();
  assert.equal(s4.getJob("w").state, "needs_user");
  assert.equal(s4.getJob("w").holdsGlobalSlot, false);

  // Saturation peer still retained local until explicit release.
  assert.equal(s.getJob("B").localActivities, 1);
  assert.equal(leaseB.release(), true);
  assert.equal(s.getJob("B").localActivities, 0);

  assert.equal(firefoxCalls, 0);
  assertSlotInvariant(sRun);
  assertSlotInvariant(s);
  assertSlotInvariant(s2);
  assertSlotInvariant(s3);
  assertSlotInvariant(s4);
});

// ---------------------------------------------------------------------------
// 15. Normal-gate durable retry preserves same-provider FIFO (head, not pending id)
// ---------------------------------------------------------------------------

test("15a normal-gate durable retry authorizes oldest waiter; later obligation stays durable", () => {
  const gatePath = path.resolve(__dirname, "..", "lib", "provider-gate.js");
  const schedPath = path.resolve(__dirname, "..", "lib", "download-scheduler.js");
  const realGate = require(gatePath);
  const prevGate = require.cache[require.resolve(gatePath)];
  const prevSched = require.cache[require.resolve(schedPath)];
  let recoverThrow = false;
  let armPostConfirmFault = false;
  let normalSnapDuringArm = 0;
  try {
    installHostileGate(realGate, gatePath, {
      recoverToNormal: function (g, args) {
        const result = g.recoverToNormal(args);
        if (recoverThrow) throw new Error("recoverToNormal mutate-then-throw");
        return result;
      },
      snapshot: function (g) {
        const snap = g.snapshot();
        if (armPostConfirmFault && snap.state === "normal") {
          normalSnapDuringArm += 1;
          if (normalSnapDuringArm >= 2) {
            throw new Error("post-confirm authorize fault");
          }
        }
        return snap;
      },
    });
    const create = loadSchedulerFresh(schedPath);
    // maxConcurrent=1 so after head is authorized it runs alone; later waiter stays waiting
    // until the next legitimate edge — proves the later obligation remains durable.
    const s = create({
      maxConcurrent: 1,
      now: () => 0,
      firefoxDownload: () => assert.fail("no Firefox"),
    });
    ["O", "R", "A", "B"].forEach((id) => {
      s.createJob({
        id,
        providerKey: "p.com",
        intent: intent(id + ".mp4"),
        segmentConcurrency: 4,
        retries: 3,
      });
    });
    // Admit all four first, then shrink capacity so only one re-admits after recovery.
    s.setMaxConcurrent(4);
    s.enqueue("O");
    s.enqueue("R");
    s.enqueue("A");
    s.enqueue("B");
    s.noteNativeOpen("O", 1);
    s.noteNativeOpen("B", 1);
    const bToken = s.getJob("B").attemptToken;
    s.onTransportResult("R", s.getJob("R").attemptToken, {
      status: "failed",
      failureCategory: "http_429",
    });
    assert.deepEqual(s.getSnapshot().providers["p.com"].waiting, ["R", "A"]);
    assert.equal(s.getJob("B").state, "pausing_provider");
    s.noteNativeOpen("O", 0);
    s.onTransportResult("O", s.getJob("O").attemptToken, {
      status: "completed",
      failureCategory: null,
    });
    assert.equal(s.getJob("R").state, "running");
    recoverThrow = true;
    try {
      s.onTransportResult("R", s.getJob("R").attemptToken, {
        status: "completed",
        failureCategory: null,
      });
    } catch (e) {
      /* gate mutated to normal; authorize loop skipped */
    }
    recoverThrow = false;
    assert.equal(s.getSnapshot().providers["p.com"].gate.state, "normal");
    assert.equal(s.getJob("A").state, "waiting_provider");
    assert.equal(s.getJob("B").state, "pausing_provider");

    // Cap to 1 before B's pending settle so only oldest can run.
    s.setMaxConcurrent(1);
    armPostConfirmFault = true;
    normalSnapDuringArm = 0;
    const drainOk = s.onDrainingTransportResult("B", bToken, cancelledResult());
    armPostConfirmFault = false;
    assert.equal(drainOk, false);
    assert.deepEqual(s.getSnapshot().providers["p.com"].waiting, ["A", "B"]);
    assert.equal(s.getJob("A").autoWakeCount, 0);
    assert.equal(s.getJob("B").autoWakeCount, 0);
    // Public surface must not expose the private pending obligation.
    assert.equal(
      Object.prototype.hasOwnProperty.call(s.getJob("B"), "pendingSchedulerProgress"),
      false
    );

    // First retry/tick selects oldest eligible waiter A — not the pending-id job B.
    s.tick(0);
    assert.equal(s.getJob("A").autoWakeCount, 1);
    assert.equal(s.getJob("A").state, "running");
    assert.equal(s.getJob("B").state, "waiting_provider");
    assert.equal(s.getJob("B").autoWakeCount, 0, "later obligation must not erase B or wake B early");
    assert.deepEqual(s.getSnapshot().providers["p.com"].waiting, ["B"]);
    assertSlotInvariant(s);

    // Complete A; next legitimate edge advances B exactly once.
    s.onTransportResult("A", s.getJob("A").attemptToken, {
      status: "completed",
      failureCategory: null,
    });
    // B may wake on the completion drain or need an extra tick if still pending.
    if (s.getJob("B").state === "waiting_provider") {
      s.tick(1);
    }
    assert.equal(s.getJob("B").autoWakeCount, 1);
    assert.ok(
      s.getJob("B").state === "running" || s.getJob("B").state === "queued",
      "B state=" + s.getJob("B").state
    );
    const bWake = s.getJob("B").autoWakeCount;
    const bUsed = s.getJob("B").retryUsed;
    s.tick(2);
    s.tick(3);
    assert.equal(s.getJob("B").autoWakeCount, bWake, "no double-wake");
    assert.equal(s.getJob("B").retryUsed, bUsed, "no double retry charge");
    assertSlotInvariant(s);
  } finally {
    restoreModuleCache(gatePath, schedPath, prevGate, prevSched);
  }
});

test("15b throw-before and mutate-then-throw around FIFO authorize stay nonthrowing; no double wake", () => {
  const gatePath = path.resolve(__dirname, "..", "lib", "provider-gate.js");
  const schedPath = path.resolve(__dirname, "..", "lib", "download-scheduler.js");
  const realGate = require(gatePath);
  const prevGate = require.cache[require.resolve(gatePath)];
  const prevSched = require.cache[require.resolve(schedPath)];
  let recoverThrow = false;
  // throw-before-authorize: pass confirmNativeOpenZero (first normal snap), throw on authorize.
  // mutate-then-throw-once: same first-pass, throw once on authorize after B is waiting.
  let faultMode = "pass";
  let normalSnapN = 0;
  try {
    installHostileGate(realGate, gatePath, {
      recoverToNormal: function (g, args) {
        const result = g.recoverToNormal(args);
        if (recoverThrow) throw new Error("recoverToNormal mutate-then-throw");
        return result;
      },
      snapshot: function (g) {
        const snap = g.snapshot();
        if (
          (faultMode === "throw-before-authorize" ||
            faultMode === "mutate-then-throw-once") &&
          snap.state === "normal"
        ) {
          normalSnapN += 1;
          // SNAP#1 is confirmNativeOpenZero (pre-waiting). Authorize is SNAP#2+.
          if (normalSnapN >= 2) {
            if (faultMode === "mutate-then-throw-once") {
              faultMode = "pass";
            }
            throw new Error("FIFO authorize-edge snapshot fault");
          }
        }
        return snap;
      },
    });
    const create = loadSchedulerFresh(schedPath);
    const s = create({
      maxConcurrent: 4,
      now: () => 0,
      firefoxDownload: () => assert.fail("no Firefox"),
    });
    ["O", "R", "A", "B"].forEach((id) => {
      s.createJob({
        id,
        providerKey: "p.com",
        intent: intent(id + ".mp4"),
        segmentConcurrency: 4,
        retries: 3,
      });
    });
    s.enqueue("O");
    s.enqueue("R");
    s.enqueue("A");
    s.enqueue("B");
    s.noteNativeOpen("O", 1);
    s.noteNativeOpen("B", 1);
    const bToken = s.getJob("B").attemptToken;
    s.onTransportResult("R", s.getJob("R").attemptToken, {
      status: "failed",
      failureCategory: "http_429",
    });
    s.noteNativeOpen("O", 0);
    s.onTransportResult("O", s.getJob("O").attemptToken, {
      status: "completed",
      failureCategory: null,
    });
    recoverThrow = true;
    try {
      s.onTransportResult("R", s.getJob("R").attemptToken, {
        status: "completed",
        failureCategory: null,
      });
    } catch (e) {
      /* expected */
    }
    recoverThrow = false;
    assert.equal(s.getSnapshot().providers["p.com"].gate.state, "normal");

    // throw-before authorize (after confirm): public call nonthrowing, B waiting, no wakes.
    faultMode = "throw-before-authorize";
    normalSnapN = 0;
    let threw1 = false;
    let r1;
    try {
      r1 = s.onDrainingTransportResult("B", bToken, cancelledResult());
    } catch (e) {
      threw1 = true;
    }
    faultMode = "pass";
    assert.equal(threw1, false);
    assert.equal(r1, false);
    assert.equal(s.getJob("B").state, "waiting_provider");
    assert.deepEqual(s.getSnapshot().providers["p.com"].waiting, ["A", "B"]);
    assert.equal(s.getJob("A").autoWakeCount, 0);
    assert.equal(s.getJob("B").autoWakeCount, 0);

    // mutate-then-throw once more on a tick/retry authorize edge must stay nonthrowing.
    faultMode = "mutate-then-throw-once";
    normalSnapN = 1; // next normal snap is authorize (no confirm in tick path)
    let threwTick = false;
    try {
      s.tick(0);
    } catch (e) {
      threwTick = true;
    }
    faultMode = "pass";
    assert.equal(threwTick, false);

    // Cap to 1 so only FIFO head can admit; later waiter may queue but must not run ahead.
    s.setMaxConcurrent(1);

    // Cleared faults: repeated tick must authorize head A first, never double-wake/skip.
    const aWake0 = s.getJob("A").autoWakeCount;
    const bWake0 = s.getJob("B").autoWakeCount;
    s.tick(1);
    s.tick(1);
    s.tick(2);
    assert.equal(s.getJob("A").autoWakeCount, 1, "head A must wake once");
    assert.ok(s.getJob("A").autoWakeCount >= aWake0);
    assert.ok(
      s.getJob("B").autoWakeCount <= s.getJob("A").autoWakeCount,
      "B must not overtake A"
    );
    assert.notEqual(s.getJob("B").state, "running");
    const aWake = s.getJob("A").autoWakeCount;
    const bWake = s.getJob("B").autoWakeCount;
    const aUsed = s.getJob("A").retryUsed;
    const bUsed = s.getJob("B").retryUsed;
    s.tick(3);
    s.tick(4);
    assert.equal(s.getJob("A").autoWakeCount, aWake, "no double-wake A");
    assert.ok(s.getJob("B").autoWakeCount - bWake <= 1);
    assert.equal(s.getJob("A").retryUsed, aUsed);
    assert.equal(s.getJob("B").retryUsed, bUsed);
    assert.equal(s.onDrainingTransportResult("B", bToken, cancelledResult()), false);
    assertSlotInvariant(s);
  } finally {
    restoreModuleCache(gatePath, schedPath, prevGate, prevSched);
  }
});

test("15c hostile ids __proto__/constructor: normal-gate FIFO authorize without prototype leakage", () => {
  const gatePath = path.resolve(__dirname, "..", "lib", "provider-gate.js");
  const schedPath = path.resolve(__dirname, "..", "lib", "download-scheduler.js");
  const realGate = require(gatePath);
  const prevGate = require.cache[require.resolve(gatePath)];
  const prevSched = require.cache[require.resolve(schedPath)];
  const cases = [
    { O: "O", R: "R", A: "__proto__", B: "constructor", providerKey: "p.com" },
    { O: "O2", R: "R2", A: "constructor", B: "__proto__", providerKey: "__proto__" },
  ];
  for (const c of cases) {
    let recoverThrow = false;
    let armPostConfirmFault = false;
    let normalSnapDuringArm = 0;
    try {
      installHostileGate(realGate, gatePath, {
        recoverToNormal: function (g, args) {
          const result = g.recoverToNormal(args);
          if (recoverThrow) throw new Error("recoverToNormal mutate-then-throw");
          return result;
        },
        snapshot: function (g) {
          const snap = g.snapshot();
          if (armPostConfirmFault && snap.state === "normal") {
            normalSnapDuringArm += 1;
            if (normalSnapDuringArm >= 2) {
              throw new Error("post-confirm authorize fault");
            }
          }
          return snap;
        },
      });
      const create = loadSchedulerFresh(schedPath);
      const protoNamesBefore = Object.getOwnPropertyNames(Object.prototype).slice().sort();
      const s = create({
        maxConcurrent: 4,
        now: () => 0,
        firefoxDownload: () => assert.fail("no Firefox"),
      });
      [c.O, c.R, c.A, c.B].forEach((id) => {
        s.createJob({
          id,
          providerKey: c.providerKey,
          intent: intent(String(id) + ".mp4"),
          segmentConcurrency: 4,
          retries: 3,
        });
      });
      s.enqueue(c.O);
      s.enqueue(c.R);
      s.enqueue(c.A);
      s.enqueue(c.B);
      s.noteNativeOpen(c.O, 1);
      s.noteNativeOpen(c.B, 1);
      const bToken = s.getJob(c.B).attemptToken;
      s.onTransportResult(c.R, s.getJob(c.R).attemptToken, {
        status: "failed",
        failureCategory: "http_429",
      });
      assert.deepEqual(s.getSnapshot().providers[c.providerKey].waiting, [c.R, c.A]);
      s.noteNativeOpen(c.O, 0);
      s.onTransportResult(c.O, s.getJob(c.O).attemptToken, {
        status: "completed",
        failureCategory: null,
      });
      recoverThrow = true;
      try {
        s.onTransportResult(c.R, s.getJob(c.R).attemptToken, {
          status: "completed",
          failureCategory: null,
        });
      } catch (e) {
        /* expected */
      }
      recoverThrow = false;
      armPostConfirmFault = true;
      normalSnapDuringArm = 0;
      assert.equal(
        s.onDrainingTransportResult(c.B, bToken, cancelledResult()),
        false
      );
      armPostConfirmFault = false;
      assert.deepEqual(s.getSnapshot().providers[c.providerKey].waiting, [c.A, c.B]);
      // Hostile ids must not install new own properties on Object.prototype.
      assert.deepEqual(
        Object.getOwnPropertyNames(Object.prototype).slice().sort(),
        protoNamesBefore
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(Object.prototype, "pendingSchedulerProgress"),
        false
      );

      s.tick(0);
      assert.equal(s.getJob(c.A).autoWakeCount, 1);
      assert.ok(
        s.getJob(c.A).state === "running" || s.getJob(c.A).state === "queued"
      );
      assert.notEqual(s.getJob(c.B).state, "running");
      assert.ok(s.getJob(c.B).autoWakeCount <= 1);
      assert.equal(Object.prototype.hasOwnProperty.call(s.getJob(c.A), "pendingSchedulerProgress"), false);
      assertSlotInvariant(s);
    } finally {
      restoreModuleCache(gatePath, schedPath, prevGate, prevSched);
    }
  }
});
