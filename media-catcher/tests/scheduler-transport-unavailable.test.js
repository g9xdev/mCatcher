"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");
const { createDownloadScheduler } = loadLib("lib/download-scheduler.js");

/**
 * McDownloadScheduler — Task 20 onTransportUnavailable
 * ----------------------------------------------------
 * Native-helper disconnect parks affected live work in needs_user without
 * consuming retries, without Firefox, and without waking same-provider waiters.
 * Frees global capacity so independent providers may admit.
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
  });
}

function assertPermitAndOwnerInvariants(s) {
  var snap = s.getSnapshot();
  assert.equal(snap.globalRunning, countHeldSlots(snap));
  Object.keys(snap.providers).forEach(function (pk) {
    var p = snap.providers[pk];
    assert.ok(Array.isArray(p.waiting));
    assert.ok(Array.isArray(p.queued));
    assert.ok(Array.isArray(p.running));
    // Wait queue members must actually be waiting_provider.
    p.waiting.forEach(function (id) {
      assert.equal(s.getJob(id).state, "waiting_provider");
    });
    // Queued members must be queued.
    p.queued.forEach(function (id) {
      assert.equal(s.getJob(id).state, "queued");
    });
    // Running members must be running and hold a slot.
    p.running.forEach(function (id) {
      assert.equal(s.getJob(id).state, "running");
      assert.equal(s.getJob(id).holdsGlobalSlot, true);
    });
    var gate = p.gate;
    if (gate.state === "normal") {
      assert.equal(gate.ownerJobId, null);
    }
    if (gate.ownerJobId != null) {
      assert.ok(gate.state === "saturated" || gate.state === "recovering");
      var owner = s.getJob(gate.ownerJobId);
      // Owner projection exists; unavailable owner must never remain named.
      assert.ok(owner);
      assert.notEqual(owner.state, "needs_user");
      assert.notEqual(owner.state, "waiting_provider");
      assert.notEqual(owner.state, "cancelled");
      assert.notEqual(owner.state, "completed");
      assert.notEqual(owner.state, "failed");
    }
  });
}

function quiesceIfPausing(s, id) {
  if (s.getJob(id).state === "pausing_provider") {
    s.releasePermit(id);
    s.onQuiesced(id);
  }
}

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

// ---------------------------------------------------------------------------
// 1. Running job -> needs_user, slot released, ephemeral retained, peer admits
// ---------------------------------------------------------------------------

test("1 running job parks needs_user, releases slot once, retains ephemeral, admits independent peer", () => {
  let firefoxCalls = 0;
  let clearCount = 0;
  const s = createDownloadScheduler({
    maxConcurrent: 1,
    now: () => 0,
    firefoxDownload: () => {
      firefoxCalls++;
    },
  });
  s.createJob({
    id: "run",
    providerKey: "a.com",
    intent: intent("run.mp4"),
    segmentConcurrency: 4,
    retries: 3,
    ephemeral: {
      clear() {
        clearCount++;
      },
    },
  });
  s.createJob({
    id: "peer",
    providerKey: "b.com",
    intent: intent("peer.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.enqueue("run");
  s.enqueue("peer");
  assert.equal(s.getJob("run").state, "running");
  assert.equal(s.getJob("peer").state, "queued");
  const verBefore = s.getJob("run").stateVersion;
  const retriesBefore = s.getJob("run").retryRemaining;
  const usedBefore = s.getJob("run").retryUsed;
  const modeBefore = s.getJob("run").mode;
  const concBefore = s.getJob("run").effectiveConcurrency;
  const filenameBefore = s.getJob("run").intent.requestedFilename;
  const oldToken = s.getJob("run").attemptToken;

  assert.equal(typeof s.onTransportUnavailable, "function");
  const ok = s.onTransportUnavailable("run");
  assert.equal(ok, true);
  assert.equal(s.getJob("run").state, "needs_user");
  assert.equal(s.getJob("run").stateVersion, verBefore + 1);
  assert.equal(s.getJob("run").holdsGlobalSlot, false);
  assert.equal(s.getJob("run").attemptToken, null);
  assert.equal(s.getJob("run").retryRemaining, retriesBefore);
  assert.equal(s.getJob("run").retryUsed, usedBefore);
  assert.equal(s.getJob("run").mode, modeBefore);
  assert.equal(s.getJob("run").effectiveConcurrency, concBefore);
  assert.equal(s.getJob("run").intent.requestedFilename, filenameBefore);
  assert.equal(clearCount, 0);
  assert.equal(s.getJob("peer").state, "running");
  assert.equal(s.getSnapshot().globalRunning, 1);
  assert.equal(firefoxCalls, 0);
  // late old token inert
  s.onTransportResult("run", oldToken, { status: "completed", failureCategory: null });
  assert.equal(s.getJob("run").state, "needs_user");
  assertSlotInvariant(s);
  assertPermitAndOwnerInvariants(s);
});

// ---------------------------------------------------------------------------
// 2. Pausing job with native opens -> needs_user, zeros opens, releases slot
// ---------------------------------------------------------------------------

test("2 pausing_provider with native opens parks needs_user and zeros native opens", () => {
  let firefoxCalls = 0;
  const s = createDownloadScheduler({
    maxConcurrent: 2,
    now: () => 0,
    firefoxDownload: () => {
      firefoxCalls++;
    },
  });
  s.createJob({
    id: "owner",
    providerKey: "p.com",
    intent: intent("o.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.createJob({
    id: "sib",
    providerKey: "p.com",
    intent: intent("s.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.enqueue("owner");
  s.enqueue("sib");
  s.notePermitAcquired("owner");
  s.notePermitAcquired("sib");
  s.noteNativeOpen("sib", 3);
  assert.equal(s.getJob("sib").nativeOpenConnections, 3);
  s.onTransportResult("sib", s.getJob("sib").attemptToken, {
    status: "failed",
    failureCategory: "short_read",
  });
  assert.equal(s.getJob("sib").state, "pausing_provider");
  assert.equal(s.getJob("sib").holdsGlobalSlot, true);
  assert.ok(s.getJob("sib").nativeOpenConnections >= 1);
  const verBefore = s.getJob("sib").stateVersion;
  const globalBefore = s.getSnapshot().globalRunning;

  const ok = s.onTransportUnavailable("sib");
  assert.equal(ok, true);
  assert.equal(s.getJob("sib").state, "needs_user");
  assert.equal(s.getJob("sib").stateVersion, verBefore + 1);
  assert.equal(s.getJob("sib").holdsGlobalSlot, false);
  assert.equal(s.getJob("sib").nativeOpenConnections, 0);
  // Real gate nativeOpen must match projected zero (not merely nonnegative).
  assert.equal(s.getSnapshot().providers["p.com"].gate.nativeOpen.sib, 0);
  assert.equal(s.getJob("sib").attemptToken, null);
  assert.equal(s.getSnapshot().globalRunning, globalBefore - 1);
  // still waiting_provider members must not include sib
  assert.equal(s.getSnapshot().providers["p.com"].waiting.indexOf("sib"), -1);
  assert.equal(firefoxCalls, 0);
  assertSlotInvariant(s);
  assertPermitAndOwnerInvariants(s);
});

// ---------------------------------------------------------------------------
// 3. Waiting job removed from wait FIFO; not woken when owner later completes
// ---------------------------------------------------------------------------

test("3 waiting job removed from wait FIFO and not woken when owner completes", () => {
  let firefoxCalls = 0;
  const s = createDownloadScheduler({
    maxConcurrent: 2,
    now: () => 0,
    firefoxDownload: () => {
      firefoxCalls++;
    },
  });
  saturateOwnerWithWaiter(s, "p.com", "owner", "wait");
  const verBefore = s.getJob("wait").stateVersion;
  const wakeBefore = s.getJob("wait").autoWakeCount;
  const retriesBefore = s.getJob("wait").retryRemaining;

  const ok = s.onTransportUnavailable("wait");
  assert.equal(ok, true);
  assert.equal(s.getJob("wait").state, "needs_user");
  assert.equal(s.getJob("wait").stateVersion, verBefore + 1);
  assert.equal(s.getSnapshot().providers["p.com"].waiting.indexOf("wait"), -1);
  assert.equal(s.getJob("wait").autoWakeCount, wakeBefore);
  assert.equal(s.getJob("wait").retryRemaining, retriesBefore);

  // Owner completes: removed waiter must not be re-admitted / woken.
  s.onTransportResult("owner", s.getJob("owner").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  assert.equal(s.getJob("wait").state, "needs_user");
  assert.equal(s.getJob("wait").autoWakeCount, wakeBefore);
  assert.equal(s.getJob("wait").retryRemaining, retriesBefore);
  assert.equal(firefoxCalls, 0);
  assertSlotInvariant(s);
  assertPermitAndOwnerInvariants(s);
});

// ---------------------------------------------------------------------------
// 4. Unavailable saturated/recovery owner clears ownership; waiter stays parked
// ---------------------------------------------------------------------------

test("4 unavailable saturated owner is no longer gate owner; same-provider waiter stays parked", () => {
  let firefoxCalls = 0;
  const s = createDownloadScheduler({
    maxConcurrent: 2,
    now: () => 0,
    firefoxDownload: () => {
      firefoxCalls++;
    },
  });
  saturateOwnerWithWaiter(s, "p.com", "owner", "wait");
  const waitWakeBefore = s.getJob("wait").autoWakeCount;
  const waitRetriesBefore = s.getJob("wait").retryRemaining;
  const ownerRetriesBefore = s.getJob("owner").retryRemaining;
  const ownerUsedBefore = s.getJob("owner").retryUsed;
  const verBefore = s.getJob("owner").stateVersion;

  const ok = s.onTransportUnavailable("owner");
  assert.equal(ok, true);
  assert.equal(s.getJob("owner").state, "needs_user");
  assert.equal(s.getJob("owner").stateVersion, verBefore + 1);
  assert.equal(s.getJob("owner").holdsGlobalSlot, false);
  assert.equal(s.getJob("owner").retryRemaining, ownerRetriesBefore);
  assert.equal(s.getJob("owner").retryUsed, ownerUsedBefore);
  // Must not remain gate owner — recoveryOwnerJobId null / ownerJobId null.
  const gate = s.getSnapshot().providers["p.com"].gate;
  assert.notEqual(gate.ownerJobId, "owner");
  assert.equal(gate.ownerJobId, null);
  assert.ok(gate.state === "recovering" || gate.state === "normal");
  // Waiter stays parked (not woken during helper disconnect).
  assert.equal(s.getJob("wait").state, "waiting_provider");
  assert.equal(s.getJob("wait").autoWakeCount, waitWakeBefore);
  assert.equal(s.getJob("wait").retryRemaining, waitRetriesBefore);
  assert.ok(s.getSnapshot().providers["p.com"].waiting.indexOf("wait") !== -1);
  assert.equal(firefoxCalls, 0);
  assertSlotInvariant(s);
  assertPermitAndOwnerInvariants(s);
});

// ---------------------------------------------------------------------------
// 5. Manual retry after reconnection can designate a fresh recovery owner
// ---------------------------------------------------------------------------

test("5 manualRetry after reconnection designates fresh recovery owner with retained context", () => {
  let firefoxCalls = 0;
  let clearCount = 0;
  const s = createDownloadScheduler({
    maxConcurrent: 2,
    now: () => 0,
    firefoxDownload: () => {
      firefoxCalls++;
    },
  });
  s.createJob({
    id: "owner",
    providerKey: "p.com",
    intent: intent("11238-makemebi.net.mp4"),
    segmentConcurrency: 4,
    retries: 3,
    ephemeral: {
      clear() {
        clearCount++;
      },
    },
  });
  s.createJob({
    id: "wait",
    providerKey: "p.com",
    intent: intent("w.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.enqueue("owner");
  s.enqueue("wait");
  s.notePermitAcquired("owner");
  s.onCapabilitySwitch("owner", { mode: "single-connection", partState: "empty" });
  s.onTransportResult("wait", s.getJob("wait").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  quiesceIfPausing(s, "wait");
  assert.equal(s.getJob("wait").state, "waiting_provider");
  // Saturation may have reduced concurrency; capture post-sat values.
  const modeBefore = s.getJob("owner").mode;
  const concBefore = s.getJob("owner").effectiveConcurrency;
  const filenameBefore = s.getJob("owner").intent.requestedFilename;
  assert.equal(modeBefore, "single-connection");
  assert.equal(concBefore, 1);

  assert.equal(s.onTransportUnavailable("owner"), true);
  assert.equal(s.getJob("owner").state, "needs_user");
  assert.equal(clearCount, 0);
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, null);
  assert.equal(s.getJob("wait").state, "waiting_provider");

  // Reconnection: user manualRetry parks-to-run as recovery owner with retained context.
  s.manualRetry("owner");
  assert.equal(s.getJob("owner").state, "running");
  assert.equal(s.getJob("owner").mode, modeBefore);
  assert.equal(s.getJob("owner").effectiveConcurrency, concBefore);
  assert.equal(s.getJob("owner").intent.requestedFilename, filenameBefore);
  assert.equal(s.getJob("owner").retryRemaining, 3);
  assert.equal(s.getJob("owner").retryUsed, 0);
  assert.equal(clearCount, 0);
  // Fresh recovery designation under recovering-blocked gate.
  const gate = s.getSnapshot().providers["p.com"].gate;
  assert.equal(gate.ownerJobId, "owner");
  assert.equal(gate.state, "recovering");
  // Same-provider waiter still not auto-woken by the disconnect path itself;
  // may remain waiting while recovery owner runs.
  assert.ok(
    s.getJob("wait").state === "waiting_provider" ||
      s.getJob("wait").state === "queued" ||
      s.getJob("wait").state === "running"
  );
  // Disconnect must not have charged waiter's retry or Firefox.
  assert.equal(firefoxCalls, 0);
  assertSlotInvariant(s);
  assertPermitAndOwnerInvariants(s);
});

// ---------------------------------------------------------------------------
// 6. Immutable false no-ops for unknown / duplicate / non-eligible states
// ---------------------------------------------------------------------------

test("6 unknown, duplicate, created/queued/backoff/needs_user/terminal are immutable false no-ops", () => {
  let firefoxCalls = 0;
  let t = 0;
  const s = createDownloadScheduler({
    maxConcurrent: 1,
    now: () => t,
    firefoxDownload: () => {
      firefoxCalls++;
    },
  });

  assert.equal(s.onTransportUnavailable("missing"), false);

  s.createJob({
    id: "c",
    providerKey: "p.com",
    intent: intent("c.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  const createdSnap = s.getJob("c");
  assert.equal(s.onTransportUnavailable("c"), false);
  assert.deepEqual(s.getJob("c"), createdSnap);

  s.enqueue("c");
  // With maxConcurrent 1 and no other jobs it admits immediately — force queued peer.
  s.createJob({
    id: "holder",
    providerKey: "q.com",
    intent: intent("h.mp4"),
    segmentConcurrency: 1,
    retries: 0,
  });
  // Reset with clean scheduler for queued state.
  const s2 = createDownloadScheduler({
    maxConcurrent: 1,
    now: () => t,
    firefoxDownload: () => {
      firefoxCalls++;
    },
  });
  s2.createJob({
    id: "hold",
    providerKey: "a.com",
    intent: intent("h.mp4"),
    segmentConcurrency: 1,
    retries: 1,
  });
  s2.createJob({
    id: "q",
    providerKey: "b.com",
    intent: intent("q.mp4"),
    segmentConcurrency: 1,
    retries: 1,
  });
  s2.enqueue("hold");
  s2.enqueue("q");
  assert.equal(s2.getJob("q").state, "queued");
  const qSnap = s2.getJob("q");
  assert.equal(s2.onTransportUnavailable("q"), false);
  assert.deepEqual(s2.getJob("q"), qSnap);

  // backoff
  s2.onTransportResult("hold", s2.getJob("hold").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  assert.equal(s2.getJob("hold").state, "retry_backoff");
  // hold went backoff; q may have been admitted
  const backoffJob = s2.getJob("hold");
  assert.equal(s2.onTransportUnavailable("hold"), false);
  assert.deepEqual(s2.getJob("hold"), backoffJob);

  // running -> needs_user then duplicate
  const s3 = createDownloadScheduler({
    maxConcurrent: 1,
    now: () => 0,
    firefoxDownload: () => {
      firefoxCalls++;
    },
  });
  s3.createJob({
    id: "r",
    providerKey: "p.com",
    intent: intent("r.mp4"),
    segmentConcurrency: 2,
    retries: 2,
  });
  s3.enqueue("r");
  assert.equal(s3.onTransportUnavailable("r"), true);
  const needsSnap = s3.getJob("r");
  assert.equal(s3.getJob("r").state, "needs_user");
  assert.equal(s3.onTransportUnavailable("r"), false);
  assert.deepEqual(s3.getJob("r"), needsSnap);

  // terminal completed
  const s4 = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s4.createJob({
    id: "done",
    providerKey: "p.com",
    intent: intent("d.mp4"),
    segmentConcurrency: 1,
    retries: 0,
  });
  s4.enqueue("done");
  s4.onTransportResult("done", s4.getJob("done").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  assert.equal(s4.getJob("done").state, "completed");
  const doneSnap = s4.getJob("done");
  assert.equal(s4.onTransportUnavailable("done"), false);
  assert.deepEqual(s4.getJob("done"), doneSnap);

  // failed terminal
  const s5 = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s5.createJob({
    id: "fail",
    providerKey: "p.com",
    intent: intent("f.mp4"),
    segmentConcurrency: 1,
    retries: 0,
  });
  s5.enqueue("fail");
  // permanent failure without sibling
  s5.onTransportResult("fail", s5.getJob("fail").attemptToken, {
    status: "failed",
    failureCategory: "permanent",
  });
  assert.equal(s5.getJob("fail").state, "failed");
  const failSnap = s5.getJob("fail");
  assert.equal(s5.onTransportUnavailable("fail"), false);
  assert.deepEqual(s5.getJob("fail"), failSnap);

  // cancelled
  const s6 = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s6.createJob({
    id: "x",
    providerKey: "p.com",
    intent: intent("x.mp4"),
    segmentConcurrency: 1,
    retries: 1,
  });
  s6.enqueue("x");
  s6.cancel("x");
  s6.onTransportResult("x", s6.getJob("x").attemptToken, {
    status: "cancelled",
    failureCategory: "cancelled",
  });
  assert.equal(s6.getJob("x").state, "cancelled");
  const xSnap = s6.getJob("x");
  assert.equal(s6.onTransportUnavailable("x"), false);
  assert.deepEqual(s6.getJob("x"), xSnap);

  assert.equal(firefoxCalls, 0);
  assertSlotInvariant(s2);
  assertSlotInvariant(s3);
  assertSlotInvariant(s4);
  assertSlotInvariant(s5);
  assertSlotInvariant(s6);
});

// ---------------------------------------------------------------------------
// 7. Retry counters, filename intent, mode, reduced concurrency unchanged
// ---------------------------------------------------------------------------

test("7 retry counters, filename intent, mode, reduced concurrency unchanged", () => {
  let firefoxCalls = 0;
  const s = createDownloadScheduler({
    maxConcurrent: 2,
    now: () => 0,
    firefoxDownload: () => {
      firefoxCalls++;
    },
  });
  s.createJob({
    id: "owner",
    providerKey: "p.com",
    intent: intent("11238-makemebi.net.mp4"),
    segmentConcurrency: 4,
    retries: 5,
  });
  s.createJob({
    id: "sib",
    providerKey: "p.com",
    intent: intent("s.mp4"),
    segmentConcurrency: 4,
    retries: 5,
  });
  s.enqueue("owner");
  s.enqueue("sib");
  s.notePermitAcquired("owner");
  s.onCapabilitySwitch("owner", { mode: "single-connection", partState: "empty" });
  s.onTransportResult("sib", s.getJob("sib").attemptToken, {
    status: "failed",
    failureCategory: "http_5xx_temporary",
  });
  quiesceIfPausing(s, "sib");
  // owner still running under reduced/single-connection constraints
  assert.equal(s.getJob("owner").state, "running");
  const before = s.getJob("owner");
  assert.equal(before.mode, "single-connection");
  assert.equal(before.effectiveConcurrency, 1);
  assert.equal(before.intent.requestedFilename, "11238-makemebi.net.mp4");

  assert.equal(s.onTransportUnavailable("owner"), true);
  const after = s.getJob("owner");
  assert.equal(after.state, "needs_user");
  assert.equal(after.retryRemaining, before.retryRemaining);
  assert.equal(after.retryUsed, before.retryUsed);
  assert.equal(after.mode, before.mode);
  assert.equal(after.effectiveConcurrency, before.effectiveConcurrency);
  assert.equal(after.intent.requestedFilename, before.intent.requestedFilename);
  assert.equal(firefoxCalls, 0);
  assertSlotInvariant(s);
  assertPermitAndOwnerInvariants(s);
});

// ---------------------------------------------------------------------------
// 8. Old-token terminal cannot complete/restart the needs_user job
// ---------------------------------------------------------------------------

test("8 old-token terminal cannot complete or restart needs_user job", () => {
  let firefoxCalls = 0;
  let t = 0;
  const s = createDownloadScheduler({
    maxConcurrent: 1,
    now: () => t,
    firefoxDownload: () => {
      firefoxCalls++;
    },
  });
  s.createJob({
    id: "j",
    providerKey: "p.com",
    intent: intent("j.mp4"),
    segmentConcurrency: 2,
    retries: 3,
  });
  s.enqueue("j");
  const oldToken = s.getJob("j").attemptToken;
  assert.equal(s.onTransportUnavailable("j"), true);
  assert.equal(s.getJob("j").state, "needs_user");
  const ver = s.getJob("j").stateVersion;
  const retries = s.getJob("j").retryRemaining;

  s.onTransportResult("j", oldToken, { status: "completed", failureCategory: null });
  s.onTransportResult("j", oldToken, { status: "failed", failureCategory: "timeout" });
  s.onTransportResult("j", oldToken, { status: "cancelled", failureCategory: "cancelled" });
  t += 999999;
  s.tick(t);

  assert.equal(s.getJob("j").state, "needs_user");
  assert.equal(s.getJob("j").stateVersion, ver);
  assert.equal(s.getJob("j").retryRemaining, retries);
  assert.equal(s.getJob("j").attemptToken, null);
  assert.equal(firefoxCalls, 0);
  assertSlotInvariant(s);
});

// ---------------------------------------------------------------------------
// 9. Firefox hook count remains zero in all cases
// ---------------------------------------------------------------------------

test("9 Firefox hook count remains zero across transport-unavailable scenarios", () => {
  let firefoxCalls = 0;
  const s = createDownloadScheduler({
    maxConcurrent: 3,
    now: () => 0,
    firefoxDownload: async () => {
      firefoxCalls++;
      return 1;
    },
    popupTokenStore: new Set(["tok"]),
  });
  s.createJob({
    id: "a",
    providerKey: "a.com",
    intent: intent("a.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.createJob({
    id: "b",
    providerKey: "b.com",
    intent: intent("b.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.createJob({
    id: "c",
    providerKey: "c.com",
    intent: intent("c.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.enqueue("a");
  s.enqueue("b");
  s.enqueue("c");
  assert.equal(s.onTransportUnavailable("a"), true);
  assert.equal(s.onTransportUnavailable("b"), true);
  assert.equal(s.onTransportUnavailable("missing"), false);
  assert.equal(s.onTransportUnavailable("a"), false);
  assert.equal(firefoxCalls, 0);
  assertSlotInvariant(s);
});

// ---------------------------------------------------------------------------
// 10. Global slot / permit / wait-queue / provider-owner invariants
// ---------------------------------------------------------------------------

test("10 global slot, permit, wait-queue, and provider-owner invariants hold", () => {
  let firefoxCalls = 0;
  const s = createDownloadScheduler({
    maxConcurrent: 2,
    now: () => 0,
    firefoxDownload: () => {
      firefoxCalls++;
    },
  });
  // Same-provider saturation + independent queued peer behind global cap.
  s.createJob({
    id: "owner",
    providerKey: "p.com",
    intent: intent("o.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.createJob({
    id: "wait",
    providerKey: "p.com",
    intent: intent("w.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.createJob({
    id: "peer",
    providerKey: "q.com",
    intent: intent("peer.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.enqueue("owner");
  s.enqueue("wait");
  s.enqueue("peer");
  // maxConcurrent 2: owner+wait running, peer queued (or wait may already be waiting after sat)
  s.notePermitAcquired("owner");
  if (s.getJob("wait").state === "running") {
    s.onTransportResult("wait", s.getJob("wait").attemptToken, {
      status: "failed",
      failureCategory: "connection_reset",
    });
    quiesceIfPausing(s, "wait");
  }
  assert.equal(s.getJob("wait").state, "waiting_provider");
  assert.equal(s.getJob("owner").state, "running");
  // peer may already be running if wait released capacity
  const peerStateBefore = s.getJob("peer").state;
  assert.ok(peerStateBefore === "queued" || peerStateBefore === "running");

  assert.equal(s.onTransportUnavailable("owner"), true);
  assert.equal(s.getJob("owner").state, "needs_user");
  assert.equal(s.getJob("owner").holdsGlobalSlot, false);
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, null);
  assert.equal(s.getJob("wait").state, "waiting_provider");
  // Independent peer must be running after capacity free (if not already).
  assert.equal(s.getJob("peer").state, "running");
  assert.equal(s.getSnapshot().globalRunning, 1);
  assert.equal(firefoxCalls, 0);
  assertSlotInvariant(s);
  assertPermitAndOwnerInvariants(s);

  // Also park the waiter and re-check invariants.
  assert.equal(s.onTransportUnavailable("wait"), true);
  assert.equal(s.getJob("wait").state, "needs_user");
  assert.equal(s.getSnapshot().providers["p.com"].waiting.indexOf("wait"), -1);
  assert.equal(s.getJob("peer").state, "running");
  assert.equal(firefoxCalls, 0);
  assertSlotInvariant(s);
  assertPermitAndOwnerInvariants(s);
});

// ---------------------------------------------------------------------------
// 11. Recovering-owner unavailable clears ownership without waking waiters
// ---------------------------------------------------------------------------

test("11 recovering owner parks needs_user and clears ownership without waking waiter", () => {
  let firefoxCalls = 0;
  const s = createDownloadScheduler({
    maxConcurrent: 2,
    now: () => 0,
    firefoxDownload: () => {
      firefoxCalls++;
    },
  });
  saturateOwnerWithWaiter(s, "p.com", "owner", "wait");
  assert.equal(s.onTransportUnavailable("owner"), true);
  assert.equal(s.getJob("owner").state, "needs_user");
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, null);
  assert.equal(s.getJob("wait").state, "waiting_provider");

  // Re-admit as recovering owner under blocked-recovery gate.
  s.manualRetry("owner");
  assert.equal(s.getJob("owner").state, "running");
  assert.equal(s.getSnapshot().providers["p.com"].gate.state, "recovering");
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "owner");
  const waitWake = s.getJob("wait").autoWakeCount;
  const waitRetries = s.getJob("wait").retryRemaining;
  const ownerRetries = s.getJob("owner").retryRemaining;
  const ownerTok = s.getJob("owner").attemptToken;

  assert.equal(s.onTransportUnavailable("owner"), true);
  assert.equal(s.getJob("owner").state, "needs_user");
  assert.equal(s.getJob("owner").holdsGlobalSlot, false);
  assert.equal(s.getJob("owner").attemptToken, null);
  assert.equal(s.getJob("owner").retryRemaining, ownerRetries);
  assert.notEqual(s.getSnapshot().providers["p.com"].gate.ownerJobId, "owner");
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, null);
  assert.equal(s.getJob("wait").state, "waiting_provider");
  assert.equal(s.getJob("wait").autoWakeCount, waitWake);
  assert.equal(s.getJob("wait").retryRemaining, waitRetries);
  // Stale recovering-owner attempt token is inert.
  s.onTransportResult("owner", ownerTok, { status: "completed", failureCategory: null });
  assert.equal(s.getJob("owner").state, "needs_user");
  assert.equal(firefoxCalls, 0);
  assertSlotInvariant(s);
  assertPermitAndOwnerInvariants(s);
});

// ---------------------------------------------------------------------------
// 12. handing_off_firefox / handed_to_firefox are immutable false no-ops
// ---------------------------------------------------------------------------

test("12 handing_off_firefox and handed_to_firefox are immutable false no-ops", async () => {
  let firefoxCalls = 0;
  let resolveDl;
  const store = new Set(["fx-tok"]);
  const s = createDownloadScheduler({
    maxConcurrent: 1,
    now: () => 0,
    firefoxDownload: () => {
      firefoxCalls++;
      return new Promise(function (resolve) {
        resolveDl = resolve;
      });
    },
    popupTokenStore: store,
  });
  s.createJob({
    id: "j",
    providerKey: "p.com",
    intent: intent("j.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.enqueue("j");
  assert.equal(s.getJob("j").state, "running");

  const handoffP = s.requestFirefoxHandoff(
    "j",
    Object.freeze({
      requestedFilename: "j.mp4",
      destinationDirectory: null,
      saveMode: "default",
      userSelectedFirefox: true,
      userActionToken: "fx-tok",
      createdAt: "t0",
    })
  );
  // Yield microtask so sync pre-await path reaches handing_off_firefox.
  await Promise.resolve();
  assert.equal(s.getJob("j").state, "handing_off_firefox");
  const midSnap = s.getJob("j");
  assert.equal(s.onTransportUnavailable("j"), false);
  assert.deepEqual(s.getJob("j"), midSnap);
  assert.equal(s.getJob("j").state, "handing_off_firefox");

  resolveDl(1);
  await handoffP;
  assert.equal(s.getJob("j").state, "handed_to_firefox");
  const doneSnap = s.getJob("j");
  assert.equal(s.onTransportUnavailable("j"), false);
  assert.deepEqual(s.getJob("j"), doneSnap);
  assert.equal(firefoxCalls, 1);
  assertSlotInvariant(s);
});

// ---------------------------------------------------------------------------
// Hostile injected-gate helpers (failure-atomicity)
// ---------------------------------------------------------------------------

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
          noteNativeOpen: hooks.noteNativeOpen
            ? function (jobId, n) {
                return hooks.noteNativeOpen(g, jobId, n);
              }
            : g.noteNativeOpen.bind(g),
          parkProbe: g.parkProbe.bind(g),
          completeOwner: hooks.completeOwner
            ? function (args) {
                return hooks.completeOwner(g, args);
              }
            : g.completeOwner.bind(g),
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

function restoreModuleCache(gatePath, schedPath, prevGate, prevSched) {
  if (prevGate) require.cache[require.resolve(gatePath)] = prevGate;
  else delete require.cache[require.resolve(gatePath)];
  if (prevSched) require.cache[require.resolve(schedPath)] = prevSched;
  else delete require.cache[require.resolve(schedPath)];
  delete require.cache[require.resolve(schedPath)];
  loadLib("lib/download-scheduler.js");
}

function callUnavailableNoSuccess(s, jobId) {
  var result = undefined;
  var threw = false;
  var err = null;
  try {
    result = s.onTransportUnavailable(jobId);
  } catch (e) {
    threw = true;
    err = e;
  }
  assert.ok(
    threw || result === false,
    "failed-before-mutation must not return true (threw=" +
      threw +
      " result=" +
      result +
      ")"
  );
  return { result: result, threw: threw, err: err };
}

// ---------------------------------------------------------------------------
// 13. noteNativeOpen throw before mutation: no park, no zero projection split-brain
// ---------------------------------------------------------------------------

test("13 noteNativeOpen throw before mutation does not park or project zero while gate retains opens", () => {
  const path = require("node:path");
  const gatePath = path.resolve(__dirname, "..", "lib", "provider-gate.js");
  const schedPath = path.resolve(__dirname, "..", "lib", "download-scheduler.js");
  const realGate = require(gatePath);
  const prevGate = require.cache[require.resolve(gatePath)];
  const prevSched = require.cache[require.resolve(schedPath)];
  let gateRef = null;
  let mode = "pass";
  let firefoxCalls = 0;
  try {
    installHostileGate(realGate, gatePath, {
      onGate: function (g) {
        gateRef = g;
      },
      noteNativeOpen: function (g, jobId, n) {
        if (mode === "throw-before") {
          throw new Error("simulated noteNativeOpen throw before mutation");
        }
        return g.noteNativeOpen(jobId, n);
      },
    });
    const createS = loadSchedulerFresh(schedPath);
    const s = createS({
      maxConcurrent: 1,
      now: () => 0,
      firefoxDownload: () => {
        firefoxCalls++;
      },
    });
    // Running job (no setSaturated gen-bump) so gate still records live opens.
    s.createJob({
      id: "run",
      providerKey: "p.com",
      intent: intent("r.mp4"),
      segmentConcurrency: 4,
      retries: 3,
    });
    s.enqueue("run");
    assert.equal(s.getJob("run").state, "running");
    s.noteNativeOpen("run", 3);
    assert.equal(s.getJob("run").nativeOpenConnections, 3);
    assert.equal(gateRef.snapshot().nativeOpen.run, 3);
    assert.equal(s.getSnapshot().providers["p.com"].gate.nativeOpen.run, 3);
    const opensBefore = s.getJob("run").nativeOpenConnections;
    const gateOpensBefore = gateRef.snapshot().nativeOpen.run;
    const stateBefore = s.getJob("run").state;
    const tokBefore = s.getJob("run").attemptToken;
    const verBefore = s.getJob("run").stateVersion;
    const slotBefore = s.getJob("run").holdsGlobalSlot;
    const retriesBefore = s.getJob("run").retryRemaining;
    const usedBefore = s.getJob("run").retryUsed;

    mode = "throw-before";
    callUnavailableNoSuccess(s, "run");

    // Live job remains coherent and retryable; no zero projection while gate holds opens.
    assert.equal(s.getJob("run").state, stateBefore);
    assert.equal(s.getJob("run").nativeOpenConnections, opensBefore);
    assert.equal(gateRef.snapshot().nativeOpen.run, gateOpensBefore);
    assert.ok(gateRef.snapshot().nativeOpen.run > 0);
    assert.equal(s.getSnapshot().providers["p.com"].gate.nativeOpen.run, gateOpensBefore);
    assert.equal(s.getJob("run").holdsGlobalSlot, slotBefore);
    assert.equal(s.getJob("run").attemptToken, tokBefore);
    assert.equal(s.getJob("run").stateVersion, verBefore);
    assert.equal(s.getJob("run").retryRemaining, retriesBefore);
    assert.equal(s.getJob("run").retryUsed, usedBefore);
    assert.equal(firefoxCalls, 0);
    assertSlotInvariant(s);
    assertPermitAndOwnerInvariants(s);
  } finally {
    restoreModuleCache(gatePath, schedPath, prevGate, prevSched);
  }
});

// ---------------------------------------------------------------------------
// 14. noteNativeOpen mutates to zero then throws: confirm zero, complete park
// ---------------------------------------------------------------------------

test("14 noteNativeOpen mutates to zero then throws — park completes with coherent zeros", () => {
  const path = require("node:path");
  const gatePath = path.resolve(__dirname, "..", "lib", "provider-gate.js");
  const schedPath = path.resolve(__dirname, "..", "lib", "download-scheduler.js");
  const realGate = require(gatePath);
  const prevGate = require.cache[require.resolve(gatePath)];
  const prevSched = require.cache[require.resolve(schedPath)];
  let gateRef = null;
  let mode = "pass";
  let firefoxCalls = 0;
  try {
    installHostileGate(realGate, gatePath, {
      onGate: function (g) {
        gateRef = g;
      },
      noteNativeOpen: function (g, jobId, n) {
        if (mode === "throw-after") {
          g.noteNativeOpen(jobId, n);
          throw new Error("simulated noteNativeOpen throw after mutation");
        }
        return g.noteNativeOpen(jobId, n);
      },
    });
    const createS = loadSchedulerFresh(schedPath);
    const s = createS({
      maxConcurrent: 2,
      now: () => 0,
      firefoxDownload: () => {
        firefoxCalls++;
      },
    });
    s.createJob({
      id: "owner",
      providerKey: "p.com",
      intent: intent("o.mp4"),
      segmentConcurrency: 4,
      retries: 3,
    });
    s.createJob({
      id: "sib",
      providerKey: "p.com",
      intent: intent("s.mp4"),
      segmentConcurrency: 4,
      retries: 3,
    });
    s.enqueue("owner");
    s.enqueue("sib");
    s.notePermitAcquired("owner");
    s.notePermitAcquired("sib");
    s.noteNativeOpen("sib", 3);
    s.onTransportResult("sib", s.getJob("sib").attemptToken, {
      status: "failed",
      failureCategory: "short_read",
    });
    assert.equal(s.getJob("sib").state, "pausing_provider");
    const verBefore = s.getJob("sib").stateVersion;
    const retriesBefore = s.getJob("sib").retryRemaining;

    mode = "throw-after";
    const ok = s.onTransportUnavailable("sib");
    assert.equal(ok, true);
    // Post-error snapshot confirms zero on both sides; park completed.
    assert.equal(gateRef.snapshot().nativeOpen.sib, 0);
    assert.equal(s.getJob("sib").nativeOpenConnections, 0);
    assert.equal(s.getJob("sib").state, "needs_user");
    assert.equal(s.getJob("sib").stateVersion, verBefore + 1);
    assert.equal(s.getJob("sib").holdsGlobalSlot, false);
    assert.equal(s.getJob("sib").attemptToken, null);
    assert.equal(s.getJob("sib").retryRemaining, retriesBefore);
    assert.equal(firefoxCalls, 0);
    assertSlotInvariant(s);
    assertPermitAndOwnerInvariants(s);
  } finally {
    restoreModuleCache(gatePath, schedPath, prevGate, prevSched);
  }
});

// ---------------------------------------------------------------------------
// 15. completeOwner throw before mutation: no park while still named owner
// ---------------------------------------------------------------------------

test("15 completeOwner throw before mutation does not park while gate still names owner", () => {
  const path = require("node:path");
  const gatePath = path.resolve(__dirname, "..", "lib", "provider-gate.js");
  const schedPath = path.resolve(__dirname, "..", "lib", "download-scheduler.js");
  const realGate = require(gatePath);
  const prevGate = require.cache[require.resolve(gatePath)];
  const prevSched = require.cache[require.resolve(schedPath)];
  let mode = "pass";
  let firefoxCalls = 0;
  try {
    installHostileGate(realGate, gatePath, {
      completeOwner: function (g, args) {
        if (mode === "throw-before") {
          throw new Error("simulated completeOwner throw before mutation");
        }
        return g.completeOwner(args);
      },
    });
    const createS = loadSchedulerFresh(schedPath);
    const s = createS({
      maxConcurrent: 2,
      now: () => 0,
      firefoxDownload: () => {
        firefoxCalls++;
      },
    });
    saturateOwnerWithWaiter(s, "p.com", "owner", "wait");
    const ownerTok = s.getJob("owner").attemptToken;
    const ownerVer = s.getJob("owner").stateVersion;
    const ownerRetries = s.getJob("owner").retryRemaining;
    const waitWake = s.getJob("wait").autoWakeCount;
    const waitRetries = s.getJob("wait").retryRemaining;

    mode = "throw-before";
    callUnavailableNoSuccess(s, "owner");

    // Must not park / return true while gate still names owner.
    assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "owner");
    assert.ok(
      s.getSnapshot().providers["p.com"].gate.state === "saturated" ||
        s.getSnapshot().providers["p.com"].gate.state === "recovering"
    );
    assert.notEqual(s.getJob("owner").state, "needs_user");
    assert.equal(s.getJob("owner").state, "running");
    assert.equal(s.getJob("owner").holdsGlobalSlot, true);
    assert.equal(s.getJob("owner").attemptToken, ownerTok);
    assert.equal(s.getJob("owner").stateVersion, ownerVer);
    assert.equal(s.getJob("owner").retryRemaining, ownerRetries);
    // Waiter stays parked — not stranded by a needs_user owner.
    assert.equal(s.getJob("wait").state, "waiting_provider");
    assert.equal(s.getJob("wait").autoWakeCount, waitWake);
    assert.equal(s.getJob("wait").retryRemaining, waitRetries);
    assert.equal(firefoxCalls, 0);
    assertSlotInvariant(s);
    assertPermitAndOwnerInvariants(s);
  } finally {
    restoreModuleCache(gatePath, schedPath, prevGate, prevSched);
  }
});

// ---------------------------------------------------------------------------
// 16. completeOwner advances then throws: park coherently, no waiter wake
// ---------------------------------------------------------------------------

test("16 completeOwner advances then throws — park needs_user, no same-provider wake", () => {
  const path = require("node:path");
  const gatePath = path.resolve(__dirname, "..", "lib", "provider-gate.js");
  const schedPath = path.resolve(__dirname, "..", "lib", "download-scheduler.js");
  const realGate = require(gatePath);
  const prevGate = require.cache[require.resolve(gatePath)];
  const prevSched = require.cache[require.resolve(schedPath)];
  let mode = "pass";
  let firefoxCalls = 0;
  try {
    installHostileGate(realGate, gatePath, {
      completeOwner: function (g, args) {
        if (mode === "throw-after") {
          const result = g.completeOwner(args);
          throw new Error("simulated completeOwner throw after advance");
        }
        return g.completeOwner(args);
      },
    });
    const createS = loadSchedulerFresh(schedPath);
    const s = createS({
      maxConcurrent: 2,
      now: () => 0,
      firefoxDownload: () => {
        firefoxCalls++;
      },
    });
    saturateOwnerWithWaiter(s, "p.com", "owner", "wait");
    const waitWake = s.getJob("wait").autoWakeCount;
    const waitRetries = s.getJob("wait").retryRemaining;
    const ownerRetries = s.getJob("owner").retryRemaining;
    const verBefore = s.getJob("owner").stateVersion;

    mode = "throw-after";
    const ok = s.onTransportUnavailable("owner");
    assert.equal(ok, true);
    // Confirmed advanced: owner cleared; park completed.
    assert.notEqual(s.getSnapshot().providers["p.com"].gate.ownerJobId, "owner");
    assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, null);
    assert.equal(s.getJob("owner").state, "needs_user");
    assert.equal(s.getJob("owner").stateVersion, verBefore + 1);
    assert.equal(s.getJob("owner").holdsGlobalSlot, false);
    assert.equal(s.getJob("owner").attemptToken, null);
    assert.equal(s.getJob("owner").retryRemaining, ownerRetries);
    // Disconnect must NOT authorize/wake same-provider waiters (unlike Firefox handoff).
    assert.equal(s.getJob("wait").state, "waiting_provider");
    assert.equal(s.getJob("wait").autoWakeCount, waitWake);
    assert.equal(s.getJob("wait").retryRemaining, waitRetries);
    assert.ok(s.getSnapshot().providers["p.com"].waiting.indexOf("wait") !== -1);
    assert.equal(firefoxCalls, 0);
    assertSlotInvariant(s);
    assertPermitAndOwnerInvariants(s);
  } finally {
    restoreModuleCache(gatePath, schedPath, prevGate, prevSched);
  }
});
