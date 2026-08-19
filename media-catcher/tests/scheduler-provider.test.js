"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const { loadLib, mediaCatcherRoot } = require("./harness/load-lib.js");
const { createDownloadScheduler } = loadLib("lib/download-scheduler.js");

/**
 * McDownloadScheduler — Task 10 provider saturation / permits surface
 * ------------------------------------------------------------------
 * Extends Task 9 admission with ProviderGate + FailureClassify integration:
 *   acquireProviderPermit / notePermitAcquired / releasePermit / onQuiesced /
 *   noteNativeOpen / nativeLeaseFor / userStatus
 * Saturation: oldest active sibling owns drain; failed work never owns;
 *   non-owners pause → wait; owner wake CAS exactly once; never Firefox.
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

// ---------------------------------------------------------------------------
// Brief scenarios
// ---------------------------------------------------------------------------

test("same provider different CDN hosts share one throttle group", () => {
  // Mutation: keying provider by mediaOrigin/CDN host.
  const s = createDownloadScheduler({ maxConcurrent: 4, now: () => 0 });
  s.createJob({
    id: "j1",
    providerKey: "florenfile.com",
    mediaOrigin: "https://cdn-a",
    intent: intent("a.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.createJob({
    id: "j2",
    providerKey: "florenfile.com",
    mediaOrigin: "https://cdn-b",
    intent: intent("b.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.enqueue("j1");
  s.enqueue("j2");
  // Simulate j1 running with a permit, j2 fails timeout → waiting_provider
  s.notePermitAcquired("j1");
  s.onTransportResult("j2", s.getJob("j2").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  assert.equal(s.getJob("j2").state, "waiting_provider");
  assert.equal(s.getJob("j1").effectiveConcurrency, 2); // floor(4/2)
  assert.equal(s.getJob("j1").state, "running");
  assertSlotInvariant(s);
});

test("transient failure with active sibling does not call Firefox hook", () => {
  let firefoxCalls = 0;
  const s = createDownloadScheduler({
    maxConcurrent: 4,
    now: () => 0,
    firefoxDownload: () => {
      firefoxCalls++;
    },
  });
  s.createJob({
    id: "j1",
    providerKey: "florenfile.com",
    intent: intent("a.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.createJob({
    id: "j2",
    providerKey: "florenfile.com",
    intent: intent("b.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.enqueue("j1");
  s.enqueue("j2");
  s.notePermitAcquired("j1");
  s.onTransportResult("j2", s.getJob("j2").attemptToken, {
    status: "failed",
    failureCategory: "http_429",
  });
  assert.equal(firefoxCalls, 0);
  assert.equal(s.getJob("j2").state, "waiting_provider");
  assertSlotInvariant(s);
});

test("completing drain owner wakes next waiter exactly once", () => {
  const s = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
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
  s.enqueue("owner");
  s.enqueue("wait");
  s.notePermitAcquired("owner");
  s.onTransportResult("wait", s.getJob("wait").attemptToken, {
    status: "failed",
    failureCategory: "connection_reset",
  });
  assert.equal(s.getJob("wait").state, "waiting_provider");
  const token = s.getJob("owner").attemptToken;
  s.onTransportResult("owner", token, { status: "completed", failureCategory: null });
  // Late duplicate completion must not double-wake
  s.onTransportResult("owner", token, { status: "completed", failureCategory: null });
  const wait = s.getJob("wait");
  assert.ok(wait.state === "queued" || wait.state === "running");
  assert.equal(wait.autoWakeCount, 1);
  assertSlotInvariant(s);
});

test("independent providers run concurrently when global limit permits", () => {
  const s = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
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
  s.enqueue("a");
  s.enqueue("b");
  assert.equal(s.getJob("a").state, "running");
  assert.equal(s.getJob("b").state, "running");
  assertSlotInvariant(s);
});

test("waiting_provider and retry_backoff release global capacity", () => {
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s.createJob({
    id: "a",
    providerKey: "a.com",
    intent: intent("a.mp4"),
    segmentConcurrency: 2,
    retries: 2,
  });
  s.createJob({
    id: "b",
    providerKey: "b.com",
    intent: intent("b.mp4"),
    segmentConcurrency: 2,
    retries: 2,
  });
  s.enqueue("a");
  s.enqueue("b");
  assert.equal(s.getJob("a").state, "running");
  // Force a into retry_backoff via transient with no sibling
  s.onTransportResult("a", s.getJob("a").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  assert.equal(s.getJob("a").state, "retry_backoff");
  assert.equal(s.getJob("a").holdsGlobalSlot, false);
  assert.equal(s.getJob("b").state, "running");
  assertSlotInvariant(s);
});

test("pausing_provider retains slot until drain then releases once", () => {
  // Two-job same-provider saturation: owner stays running; failed non-owner pauses.
  // maxConcurrent=2 admits both; they do not violate the hard cap.
  const s = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
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
  assert.equal(s.getJob("owner").state, "running");
  assert.equal(s.getJob("sib").state, "running");
  s.notePermitAcquired("owner");
  s.notePermitAcquired("sib");
  const globalBeforeFail = s.getSnapshot().globalRunning;
  assert.equal(globalBeforeFail, 2);
  s.onTransportResult("sib", s.getJob("sib").attemptToken, {
    status: "failed",
    failureCategory: "short_read",
  });
  // Immediately after saturation: non-owner is pausing_provider and STILL holds its global slot.
  assert.equal(s.getJob("sib").state, "pausing_provider");
  assert.equal(s.getJob("sib").holdsGlobalSlot, true);
  assert.equal(s.getSnapshot().globalRunning, 2);
  assert.equal(s.getJob("owner").state, "running"); // drain owner
  // Drain complete → waiting_provider, slot released once, globalRunning decremented once.
  s.releasePermit("sib");
  s.onQuiesced("sib");
  assert.equal(s.getJob("sib").state, "waiting_provider");
  assert.equal(s.getJob("sib").holdsGlobalSlot, false);
  assert.equal(s.getSnapshot().globalRunning, 1);
  // Duplicate quiesce is a no-op (no second slot release).
  s.onQuiesced("sib");
  assert.equal(s.getSnapshot().globalRunning, 1);
  assert.equal(s.getJob("sib").state, "waiting_provider");
  assertSlotInvariant(s);
});

test("acquireProviderPermit is the sole gate wrapper and is generation-bound", () => {
  // Mutation: background calling ProviderGate.acquire directly, or release after generation bump double-counting.
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s.createJob({
    id: "j",
    providerKey: "p.com",
    intent: intent("a.mp4"),
    segmentConcurrency: 2,
    retries: 2,
  });
  s.enqueue("j");
  const p1 = s.acquireProviderPermit("j", "segment");
  assert.ok(p1);
  assert.equal(typeof p1.release, "function");
  assert.equal(typeof p1.generation, "number");
  const gen = p1.generation;
  p1.release();
  p1.release(); // idempotent
  // After saturation generation bump, a stale permit's release must not corrupt counts.
  s.createJob({
    id: "sib",
    providerKey: "p.com",
    intent: intent("b.mp4"),
    segmentConcurrency: 2,
    retries: 2,
  });
  // Admit sib when capacity allows — use a second scheduler for clean permit-generation assert:
  const s2 = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
  s2.createJob({
    id: "owner",
    providerKey: "p.com",
    intent: intent("o.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s2.createJob({
    id: "fail",
    providerKey: "p.com",
    intent: intent("f.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s2.enqueue("owner");
  s2.enqueue("fail");
  const stale = s2.acquireProviderPermit("fail", "segment");
  assert.ok(stale);
  s2.notePermitAcquired("owner");
  s2.onTransportResult("fail", s2.getJob("fail").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  // fail may be pausing/waiting; generation advanced for provider
  const genAfter = stale.generation;
  stale.release(); // must not throw; must not resurrect permits for saturated non-owner
  assert.equal(s2.acquireProviderPermit("fail", "segment"), null); // non-owner denied while saturated/pausing
  assert.ok(s2.acquireProviderPermit("owner", "segment")); // drain owner still allowed
  void gen;
  void genAfter;
  assertSlotInvariant(s2);
});

test("no viable sibling → bounded retry, never waiting_provider forever", () => {
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s.createJob({
    id: "solo",
    providerKey: "p.com",
    intent: intent("s.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.enqueue("solo");
  s.onTransportResult("solo", s.getJob("solo").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  assert.equal(s.getJob("solo").state, "retry_backoff");
  assert.notEqual(s.getJob("solo").state, "waiting_provider");
  assert.equal(s.getJob("solo").holdsGlobalSlot, false);
  assertSlotInvariant(s);
});

// ---------------------------------------------------------------------------
// Extended coverage (Task 10 contract)
// ---------------------------------------------------------------------------

test("three same-provider running jobs selects oldest active owner; failed cannot own", () => {
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
  s.notePermitAcquired("B");
  s.notePermitAcquired("C");
  s.onTransportResult("C", s.getJob("C").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  assert.equal(s.getJob("A").state, "running"); // oldest active owner
  assert.equal(s.getJob("A").effectiveConcurrency, 2);
  assert.notEqual(s.getJob("C").state, "running");
  assert.ok(
    s.getJob("C").state === "pausing_provider" || s.getJob("C").state === "waiting_provider"
  );
  assert.ok(
    s.getJob("B").state === "pausing_provider" || s.getJob("B").state === "waiting_provider"
  );
  // Failed work is never owner.
  const prov = s.getSnapshot().providers["p.com"];
  assert.equal(prov.gate.ownerJobId, "A");
  assert.notEqual(prov.gate.ownerJobId, "C");
  assertSlotInvariant(s);
});

test("zero-connection non-owner immediately waits and releases slot", () => {
  const s = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
  s.createJob({
    id: "owner",
    providerKey: "p.com",
    intent: intent("o.mp4"),
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
  s.enqueue("owner");
  s.enqueue("fail");
  s.notePermitAcquired("owner");
  // fail has zero permits / native opens → immediate waiting_provider
  assert.equal(s.getJob("fail").inFlightPermits, 0);
  assert.equal(s.getJob("fail").nativeOpenConnections, 0);
  s.onTransportResult("fail", s.getJob("fail").attemptToken, {
    status: "failed",
    failureCategory: "http_5xx_temporary",
  });
  assert.equal(s.getJob("fail").state, "waiting_provider");
  assert.equal(s.getJob("fail").holdsGlobalSlot, false);
  assert.equal(s.getSnapshot().globalRunning, 1);
  assert.equal(s.getJob("owner").state, "running");
  assertSlotInvariant(s);
});

test("different providers continue while one is saturated", () => {
  const s = createDownloadScheduler({ maxConcurrent: 3, now: () => 0 });
  s.createJob({
    id: "p1a",
    providerKey: "a.com",
    intent: intent("a1.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.createJob({
    id: "p1b",
    providerKey: "a.com",
    intent: intent("a2.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.createJob({
    id: "p2",
    providerKey: "b.com",
    intent: intent("b.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.enqueue("p1a");
  s.enqueue("p1b");
  s.enqueue("p2");
  s.notePermitAcquired("p1a");
  s.onTransportResult("p1b", s.getJob("p1b").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  assert.equal(s.getJob("p1a").state, "running");
  assert.equal(s.getJob("p1b").state, "waiting_provider");
  assert.equal(s.getJob("p2").state, "running");
  // Free capacity from p1b can admit unrelated work (already running) and stay independent.
  assert.equal(s.getSnapshot().providers["b.com"].gate.state, "normal");
  assert.equal(s.getSnapshot().providers["a.com"].gate.state, "saturated");
  assertSlotInvariant(s);
});

test("noncandidate permanent failure is terminal failed, not waiting_provider", () => {
  const s = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
  s.createJob({
    id: "j1",
    providerKey: "p.com",
    intent: intent("a.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.createJob({
    id: "j2",
    providerKey: "p.com",
    intent: intent("b.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.enqueue("j1");
  s.enqueue("j2");
  s.notePermitAcquired("j1");
  s.onTransportResult("j2", s.getJob("j2").attemptToken, {
    status: "failed",
    failureCategory: "permanent",
  });
  assert.equal(s.getJob("j2").state, "failed");
  assert.equal(s.getJob("j2").holdsGlobalSlot, false);
  assert.equal(s.getJob("j1").state, "running");
  assert.equal(s.getJob("j1").effectiveConcurrency, 4); // not reduced
  assert.equal(s.getSnapshot().providers["p.com"].gate.state, "normal");
  assertSlotInvariant(s);
});

test("permit cap, idempotent release, and stale release never go negative", () => {
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s.createJob({
    id: "j",
    providerKey: "p.com",
    intent: intent("a.mp4"),
    segmentConcurrency: 2,
    retries: 2,
  });
  s.enqueue("j");
  const p1 = s.acquireProviderPermit("j", "segment");
  const p2 = s.acquireProviderPermit("j", "segment");
  const p3 = s.acquireProviderPermit("j", "probe");
  assert.ok(p1);
  assert.ok(p2);
  assert.equal(p3, null); // at cap
  assert.equal(s.getJob("j").inFlightPermits, 2);
  p1.release();
  p1.release(); // idempotent — no double decrement
  assert.equal(s.getJob("j").inFlightPermits, 1);
  // Adapter release must not consume wrapper-owned permits (no under-count).
  s.releasePermit("j");
  s.releasePermit("j");
  assert.equal(s.getJob("j").inFlightPermits, 1);
  p2.release();
  assert.equal(s.getJob("j").inFlightPermits, 0);
  // notePermitAcquired then release (observation adapter only)
  s.notePermitAcquired("j");
  assert.equal(s.getJob("j").inFlightPermits, 1);
  s.releasePermit("j");
  assert.equal(s.getJob("j").inFlightPermits, 0);
  // Adapter never goes negative
  s.releasePermit("j");
  assert.equal(s.getJob("j").inFlightPermits, 0);
  assertSlotInvariant(s);
});

test("native owner/non-owner lease and noteNativeOpen stay coherent", () => {
  const s = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
  s.createJob({
    id: "owner",
    providerKey: "p.com",
    intent: intent("o.mp4"),
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
  s.enqueue("owner");
  s.enqueue("fail");
  // Normal lease reflects registered effective concurrency.
  assert.equal(s.nativeLeaseFor("owner").maxConnections, 4);
  assert.equal(s.nativeLeaseFor("fail").maxConnections, 4);
  s.noteNativeOpen("owner", 2);
  assert.equal(s.getJob("owner").nativeOpenConnections, 2);
  s.notePermitAcquired("owner"); // still need permit for sibling predicate in some paths
  // Use native open as active-sibling signal (without permit on fail).
  s.onTransportResult("fail", s.getJob("fail").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  assert.equal(s.getJob("owner").state, "running");
  assert.equal(s.nativeLeaseFor("owner").maxConnections, 2); // reduced
  assert.equal(s.nativeLeaseFor("fail").maxConnections, 0); // non-owner
  assert.ok(
    s.getJob("fail").state === "waiting_provider" || s.getJob("fail").state === "pausing_provider"
  );
  assertSlotInvariant(s);
});

test("recovery A→B→C and duplicate A cannot re-wake; successful recovery to normal", () => {
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
  s.notePermitAcquired("B");
  s.notePermitAcquired("C");
  // Fail B and C into wait (A owns drain).
  s.onTransportResult("B", s.getJob("B").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  // C is non-owner competitor — may already be pausing from B's saturation.
  if (s.getJob("C").state === "running") {
    s.onTransportResult("C", s.getJob("C").attemptToken, {
      status: "failed",
      failureCategory: "timeout",
    });
  }
  // Drain B/C to waiting if still pausing.
  if (s.getJob("B").state === "pausing_provider") {
    while (s.getJob("B").inFlightPermits > 0) s.releasePermit("B");
    s.onQuiesced("B");
  }
  if (s.getJob("C").state === "pausing_provider") {
    while (s.getJob("C").inFlightPermits > 0) s.releasePermit("C");
    s.onQuiesced("C");
  }
  assert.equal(s.getJob("B").state, "waiting_provider");
  assert.equal(s.getJob("C").state, "waiting_provider");
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "A");

  const aToken = s.getJob("A").attemptToken;
  s.onTransportResult("A", aToken, { status: "completed", failureCategory: null });
  // Late A cannot re-wake.
  s.onTransportResult("A", aToken, { status: "completed", failureCategory: null });
  assert.equal(s.getJob("B").autoWakeCount, 1);
  assert.ok(s.getJob("B").state === "queued" || s.getJob("B").state === "running");
  assert.equal(s.getJob("C").state, "waiting_provider");
  assert.equal(s.getJob("C").autoWakeCount, 0);

  // Ensure B is running as recovery owner.
  if (s.getJob("B").state === "queued") {
    // free slots should admit B
  }
  assert.equal(s.getJob("B").state, "running");
  assert.equal(s.getSnapshot().providers["p.com"].gate.state, "recovering");
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "B");

  // B cancels → wakes C (A→B→C chain); late B cannot wake again.
  const bToken = s.getJob("B").attemptToken;
  s.onTransportResult("B", bToken, { status: "cancelled", failureCategory: null });
  s.onTransportResult("B", bToken, { status: "cancelled", failureCategory: null });
  assert.equal(s.getJob("C").autoWakeCount, 1);
  assert.equal(s.getJob("C").state, "running");
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "C");

  // Successful recovery completion returns to normal.
  s.onTransportResult("C", s.getJob("C").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  assert.equal(s.getSnapshot().providers["p.com"].gate.state, "normal");
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, null);
  assertSlotInvariant(s);
});

test("late blocked-provider job may be designated recovery owner before admission", () => {
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s.createJob({
    id: "owner",
    providerKey: "p.com",
    intent: intent("o.mp4"),
    segmentConcurrency: 2,
    retries: 2,
  });
  s.enqueue("owner");
  s.notePermitAcquired("owner");
  // Solo owner with a permit — create a second job that will fail with sibling active.
  s.createJob({
    id: "fail",
    providerKey: "p.com",
    intent: intent("f.mp4"),
    segmentConcurrency: 2,
    retries: 2,
  });
  // Raise cap so fail can run, then saturate.
  s.setMaxConcurrent(2);
  s.enqueue("fail");
  assert.equal(s.getJob("fail").state, "running");
  s.onTransportResult("fail", s.getJob("fail").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  assert.equal(s.getJob("fail").state, "waiting_provider");

  // Cancel owner with no other waiters after fail is woken? First: complete owner wakes fail.
  // Instead force blocked: complete owner after manually... actually fail is the waiter.
  // For blocked path: cancel fail from wait, then complete owner with no waiters.
  // Simpler blocked path: owner completes when wait list empty.
  // Move fail out by... we need a path with no waiters. Cancel waiting fail first.
  // Use cancel via transport not available for waiting. Create separate scenario:

  const s2 = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s2.createJob({
    id: "solo",
    providerKey: "q.com",
    intent: intent("s.mp4"),
    segmentConcurrency: 2,
    retries: 2,
  });
  s2.enqueue("solo");
  // Manufacture saturation by admitting a second running sibling then failing one.
  s2.setMaxConcurrent(2);
  s2.createJob({
    id: "sib",
    providerKey: "q.com",
    intent: intent("t.mp4"),
    segmentConcurrency: 2,
    retries: 2,
  });
  s2.enqueue("sib");
  s2.notePermitAcquired("solo");
  s2.notePermitAcquired("sib");
  s2.onTransportResult("sib", s2.getJob("sib").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  // Drain sib to waiting
  if (s2.getJob("sib").state === "pausing_provider") {
    while (s2.getJob("sib").inFlightPermits > 0) s2.releasePermit("sib");
    s2.onQuiesced("sib");
  }
  assert.equal(s2.getJob("sib").state, "waiting_provider");
  // Complete owner — wakes sib as recovery. To get blocked: complete owner with empty wait.
  // Cancel wait by completing a path... Instead: use three-step where waiter is removed.
  // Complete solo → wakes sib. Then cancel sib before it runs? It's admitted.
  // Force blocked: owner completes when only waiter is non-eligible (cancelled).
  // We'll complete solo after moving sib... if we complete solo:
  s2.onTransportResult("solo", s2.getJob("solo").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  assert.ok(s2.getJob("sib").state === "queued" || s2.getJob("sib").state === "running");
  // Cancel recovery owner with no further waiters → recovering blocked.
  if (s2.getJob("sib").state === "queued") {
    // admit by free capacity
  }
  if (s2.getJob("sib").state === "running") {
    s2.onTransportResult("sib", s2.getJob("sib").attemptToken, {
      status: "cancelled",
      failureCategory: null,
    });
  }
  assert.equal(s2.getSnapshot().providers["q.com"].gate.state, "recovering");
  assert.equal(s2.getSnapshot().providers["q.com"].gate.ownerJobId, null);

  // Late same-provider job is designated recovery owner before admission.
  s2.createJob({
    id: "late",
    providerKey: "q.com",
    intent: intent("late.mp4"),
    segmentConcurrency: 2,
    retries: 2,
  });
  s2.enqueue("late");
  assert.equal(s2.getJob("late").state, "running");
  assert.equal(s2.getSnapshot().providers["q.com"].gate.ownerJobId, "late");
  assert.equal(s2.getSnapshot().providers["q.com"].gate.state, "recovering");
  assert.ok(s2.acquireProviderPermit("late", "segment"));
  assertSlotInvariant(s2);
});

test("userStatus returns Waiting for providerKey for pause/wait states", () => {
  const s = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
  s.createJob({
    id: "owner",
    providerKey: "florenfile.com",
    intent: intent("o.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.createJob({
    id: "sib",
    providerKey: "florenfile.com",
    intent: intent("s.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.enqueue("owner");
  s.enqueue("sib");
  s.notePermitAcquired("owner");
  s.notePermitAcquired("sib");
  s.onTransportResult("sib", s.getJob("sib").attemptToken, {
    status: "failed",
    failureCategory: "short_read",
  });
  assert.equal(s.getJob("sib").state, "pausing_provider");
  assert.equal(s.userStatus("sib"), "Waiting for florenfile.com");
  assert.equal(s.userStatus(s.getJob("sib")), "Waiting for florenfile.com");
  s.releasePermit("sib");
  s.onQuiesced("sib");
  assert.equal(s.getJob("sib").state, "waiting_provider");
  assert.equal(s.userStatus("sib"), "Waiting for florenfile.com");
  // Other states have stable non-empty strings (not the waiting label).
  assert.notEqual(s.userStatus("owner"), "Waiting for florenfile.com");
  assert.ok(typeof s.userStatus("owner") === "string" && s.userStatus("owner").length > 0);
  assert.equal(s.userStatus("missing"), "");
  assertSlotInvariant(s);
});

test("failed saturation waiter marked for single retry consumption; paused-only is not", () => {
  const s = createDownloadScheduler({ maxConcurrent: 3, now: () => 0 });
  s.createJob({
    id: "owner",
    providerKey: "p.com",
    intent: intent("o.mp4"),
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
  s.createJob({
    id: "pausedOnly",
    providerKey: "p.com",
    intent: intent("p.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.enqueue("owner");
  s.enqueue("fail");
  s.enqueue("pausedOnly");
  s.notePermitAcquired("owner");
  s.notePermitAcquired("pausedOnly");
  const failRetriesBefore = s.getJob("fail").retryRemaining;
  const pausedRetriesBefore = s.getJob("pausedOnly").retryRemaining;
  s.onTransportResult("fail", s.getJob("fail").attemptToken, {
    status: "failed",
    failureCategory: "http_5xx_temporary",
  });
  assert.ok(
    s.getJob("fail").state === "pausing_provider" || s.getJob("fail").state === "waiting_provider"
  );
  if (s.getJob("pausedOnly").state === "pausing_provider") {
    while (s.getJob("pausedOnly").inFlightPermits > 0) s.releasePermit("pausedOnly");
    s.onQuiesced("pausedOnly");
  }
  if (s.getJob("fail").state === "pausing_provider") {
    while (s.getJob("fail").inFlightPermits > 0) s.releasePermit("fail");
    s.onQuiesced("fail");
  }
  assert.equal(s.getJob("fail").state, "waiting_provider");
  assert.equal(s.getJob("pausedOnly").state, "waiting_provider");
  // Wake fail first (oldest waiter after owner completes).
  s.onTransportResult("owner", s.getJob("owner").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  // Failed waiter charged exactly once at authorized wake; paused-only not charged.
  assert.equal(s.getJob("fail").retryRemaining, failRetriesBefore - 1);
  assert.equal(s.getJob("pausedOnly").retryRemaining, pausedRetriesBefore);
  assert.equal(s.getJob("fail").autoWakeCount, 1);
  assert.equal(s.getJob("pausedOnly").autoWakeCount, 0);
  // Duplicate owner terminal cannot double-charge.
  assert.ok(s.getJob("fail").state === "queued" || s.getJob("fail").state === "running");
  assertSlotInvariant(s);
});

test("snapshot/provider projections are deep-frozen safe and never leak gate/ephemeral", () => {
  let firefoxCalls = 0;
  const s = createDownloadScheduler({
    maxConcurrent: 2,
    now: () => 0,
    firefoxDownload: () => {
      firefoxCalls++;
    },
  });
  s.createJob({
    id: "j1",
    providerKey: "p.com",
    mediaOrigin: "https://cdn-secret/path?sig=deadbeef",
    intent: intent("a.mp4"),
    segmentConcurrency: 4,
    retries: 3,
    ephemeral: {
      Cookie: "session=evil",
      clear() {},
    },
  });
  s.createJob({
    id: "j2",
    providerKey: "p.com",
    mediaOrigin: "https://cdn-other",
    intent: intent("b.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.enqueue("j1");
  s.enqueue("j2");
  s.notePermitAcquired("j1");
  s.onTransportResult("j2", s.getJob("j2").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  assert.equal(firefoxCalls, 0);

  const snap = s.getSnapshot();
  assert.ok(Object.isFrozen(snap));
  assert.ok(Object.isFrozen(snap.providers));
  assert.ok(Object.isFrozen(snap.providers["p.com"]));
  assert.ok(Object.isFrozen(snap.providers["p.com"].gate));
  assert.equal(typeof snap.providers["p.com"].gate.state, "string");
  assert.equal(typeof snap.providers["p.com"].gate.generation, "number");
  assert.equal(typeof snap.providers["p.com"].gate.wakeGeneration, "number");
  assert.ok(Array.isArray(snap.providers["p.com"].waiting));
  assert.ok(Object.isFrozen(snap.providers["p.com"].waiting));
  // No raw gate methods / Maps.
  assert.equal(typeof snap.providers["p.com"].gate.acquire, "undefined");
  assert.equal(typeof snap.providers["p.com"].gate.setSaturated, "undefined");
  assert.equal("ephemeral" in s.getJob("j1"), false);
  assert.equal("mediaOrigin" in s.getJob("j1"), false);
  const json = JSON.stringify(snap);
  assert.equal(json.includes("deadbeef"), false);
  assert.equal(json.includes("session=evil"), false);
  assert.equal(json.includes("Cookie"), false);
  assert.equal(json.includes("cdn-secret"), false);
  // Safe job facts include permit counters.
  assert.equal(typeof s.getJob("j1").inFlightPermits, "number");
  assert.equal(typeof s.getJob("j1").nativeOpenConnections, "number");
  assert.equal(typeof s.getJob("j1").autoWakeCount, "number");
  assert.equal(typeof s.getJob("j1").effectiveConcurrency, "number");
  assert.throws(() => {
    snap.providers["p.com"].waiting.push("x");
  }, TypeError);
  assertSlotInvariant(s);
});

test("constructor validates optional firefoxDownload; never calls it on saturation", () => {
  assert.throws(
    () =>
      createDownloadScheduler({
        maxConcurrent: 1,
        now: () => 0,
        firefoxDownload: "not-a-function",
      }),
    TypeError
  );
  let calls = 0;
  const s = createDownloadScheduler({
    maxConcurrent: 2,
    now: () => 0,
    firefoxDownload: () => {
      calls++;
    },
  });
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
  s.notePermitAcquired("a");
  s.onTransportResult("b", s.getJob("b").attemptToken, {
    status: "failed",
    failureCategory: "connection_reset",
  });
  s.onTransportResult("a", s.getJob("a").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  assert.equal(calls, 0);
});

test("download-scheduler dual-export still same-object McDownloadScheduler", () => {
  const abs = path.join(mediaCatcherRoot, "lib", "download-scheduler.js");
  const code = fs.readFileSync(abs, "utf8");
  // Load dependencies into root first (browser path).
  const root = {};
  const gateCode = fs.readFileSync(path.join(mediaCatcherRoot, "lib", "provider-gate.js"), "utf8");
  const failCode = fs.readFileSync(path.join(mediaCatcherRoot, "lib", "failure-classify.js"), "utf8");
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require,
    console,
    self: root,
  };
  sandbox.module.exports = sandbox.exports;
  vm.runInNewContext(gateCode, Object.assign({}, sandbox, { module: { exports: {} }, exports: {} }), {
    filename: "provider-gate.js",
  });
  // Re-run gate into root
  const gateSandbox = { module: { exports: {} }, exports: {}, require, console, self: root };
  gateSandbox.module.exports = gateSandbox.exports;
  vm.runInNewContext(gateCode, gateSandbox, { filename: "provider-gate.js" });
  assert.equal(root.McProviderGate, gateSandbox.module.exports);

  const failSandbox = { module: { exports: {} }, exports: {}, require, console, self: root };
  failSandbox.module.exports = failSandbox.exports;
  vm.runInNewContext(failCode, failSandbox, { filename: "failure-classify.js" });
  assert.equal(root.McFailureClassify, failSandbox.module.exports);

  const schedSandbox = { module: { exports: {} }, exports: {}, require, console, self: root };
  schedSandbox.module.exports = schedSandbox.exports;
  vm.runInNewContext(code, schedSandbox, { filename: abs });
  assert.equal(typeof schedSandbox.module.exports.createDownloadScheduler, "function");
  assert.equal(typeof root.McDownloadScheduler.createDownloadScheduler, "function");
  assert.equal(root.McDownloadScheduler, schedSandbox.module.exports);
});


// ---------------------------------------------------------------------------
// Fix-round 2 regressions (admission / recovery epochs / permits / quiesce)
// ---------------------------------------------------------------------------

function loadSchedulerFresh() {
  return loadLib("lib/download-scheduler.js");
}

function quiesceIfPausing(s, jobId) {
  if (s.getJob(jobId).state === "pausing_provider") {
    while (s.getJob(jobId).inFlightPermits > 0) s.releasePermit(jobId);
    s.onQuiesced(jobId);
  }
}

/** Drive provider to recovering-blocked (ownerJobId null). Requires maxConcurrent >= 2. */
function forceRecoveringBlocked(s, providerKey, ownerId, failId) {
  s.createJob({
    id: ownerId,
    providerKey: providerKey,
    intent: intent("o.mp4"),
    segmentConcurrency: 2,
    retries: 2,
  });
  s.createJob({
    id: failId,
    providerKey: providerKey,
    intent: intent("f.mp4"),
    segmentConcurrency: 2,
    retries: 2,
  });
  s.enqueue(ownerId);
  s.enqueue(failId);
  assert.equal(s.getJob(failId).state, "running");
  s.notePermitAcquired(ownerId);
  s.onTransportResult(failId, s.getJob(failId).attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  quiesceIfPausing(s, failId);
  assert.equal(s.getJob(failId).state, "waiting_provider");
  s.onTransportResult(ownerId, s.getJob(ownerId).attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  assert.equal(s.getJob(failId).state, "running");
  s.onTransportResult(failId, s.getJob(failId).attemptToken, {
    status: "cancelled",
    failureCategory: null,
  });
  assert.equal(s.getSnapshot().providers[providerKey].gate.state, "recovering");
  assert.equal(s.getSnapshot().providers[providerKey].gate.ownerJobId, null);
}

test("pure peek does not designate recovery owner when no global capacity", () => {
  const s = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
  forceRecoveringBlocked(s, "p.com", "owner", "fail");
  s.setMaxConcurrent(1);
  s.createJob({
    id: "hold",
    providerKey: "other.com",
    intent: intent("h.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.enqueue("hold");
  assert.equal(s.getJob("hold").state, "running");
  s.createJob({
    id: "late",
    providerKey: "p.com",
    intent: intent("late.mp4"),
    segmentConcurrency: 2,
    retries: 2,
  });
  s.enqueue("late");
  assert.equal(s.getJob("late").state, "queued");
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, null);
  assert.equal(s.getSnapshot().providers["p.com"].gate.state, "recovering");
  assert.equal(s.getJob("late").effectiveConcurrency, 2);
  assertSlotInvariant(s);
});

test("commit-time designation happens exactly once on successful admit", () => {
  const s = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
  forceRecoveringBlocked(s, "p.com", "owner", "fail");
  s.createJob({
    id: "late",
    providerKey: "p.com",
    intent: intent("late.mp4"),
    segmentConcurrency: 4,
    retries: 2,
  });
  s.enqueue("late");
  assert.equal(s.getJob("late").state, "running");
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "late");
  assert.equal(s.getSnapshot().providers["p.com"].gate.state, "recovering");
  assert.equal(s.getJob("late").effectiveConcurrency, 1);
  s.setMaxConcurrent(2);
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "late");
  assert.ok(s.acquireProviderPermit("late", "segment"));
  assertSlotInvariant(s);
});

test("blocked provider admit failure cannot starve independent provider", () => {
  const s = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
  s.createJob({
    id: "own",
    providerKey: "sat.com",
    intent: intent("o.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.createJob({
    id: "sib",
    providerKey: "sat.com",
    intent: intent("s.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.createJob({
    id: "queuedSat",
    providerKey: "sat.com",
    intent: intent("q.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s.createJob({
    id: "freeJob",
    providerKey: "free.com",
    intent: intent("f.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.enqueue("own");
  s.enqueue("sib");
  s.notePermitAcquired("own");
  s.onTransportResult("sib", s.getJob("sib").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  s.enqueue("queuedSat");
  assert.equal(s.getJob("queuedSat").state, "queued");
  assert.equal(s.getSnapshot().providers["sat.com"].gate.state, "saturated");
  s.enqueue("freeJob");
  assert.equal(s.getJob("freeJob").state, "running");
  assert.equal(s.getJob("queuedSat").state, "queued");
  assert.equal(s.getJob("own").state, "running");
  assertSlotInvariant(s);
});

test("successful recovery requeues every remaining same-provider waiter in wait-FIFO", () => {
  const s = createDownloadScheduler({ maxConcurrent: 4, now: () => 0 });
  ["A", "B", "C", "D"].forEach(function (id) {
    s.createJob({
      id: id,
      providerKey: "p.com",
      intent: intent(id.toLowerCase() + ".mp4"),
      segmentConcurrency: 4,
      retries: 3,
    });
  });
  s.enqueue("A");
  s.enqueue("B");
  s.enqueue("C");
  s.enqueue("D");
  s.notePermitAcquired("A");
  s.notePermitAcquired("B");
  s.notePermitAcquired("C");
  s.notePermitAcquired("D");
  s.onTransportResult("B", s.getJob("B").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  ["B", "C", "D"].forEach(function (id) {
    quiesceIfPausing(s, id);
  });
  assert.equal(s.getJob("B").state, "waiting_provider");
  assert.equal(s.getJob("C").state, "waiting_provider");
  assert.equal(s.getJob("D").state, "waiting_provider");

  s.onTransportResult("A", s.getJob("A").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  assert.equal(s.getJob("B").state, "running");
  assert.equal(s.getJob("C").state, "waiting_provider");
  assert.equal(s.getJob("D").state, "waiting_provider");

  s.onTransportResult("B", s.getJob("B").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  assert.equal(s.getSnapshot().providers["p.com"].gate.state, "normal");
  assert.ok(s.getJob("C").state === "queued" || s.getJob("C").state === "running");
  assert.ok(s.getJob("D").state === "queued" || s.getJob("D").state === "running");
  assert.equal(s.getJob("C").autoWakeCount, 1);
  assert.equal(s.getJob("D").autoWakeCount, 1);
  if (s.getJob("C").state === "queued" && s.getJob("D").state === "queued") {
    const q = s.getSnapshot().providers["p.com"].queued;
    assert.ok(q.indexOf("C") < q.indexOf("D"));
  }
  assertSlotInvariant(s);
});

test("same job wakes across two saturation cycles; failed retry decrements once per epoch", () => {
  // O owns; W failed waiter + P paused-only. O wakes W; W recovers → requeues P.
  // Cycle 2: O2 + P; P fails (new epoch) → O2 wakes P once with one retry charge.
  const s = createDownloadScheduler({ maxConcurrent: 3, now: () => 0 });
  s.createJob({
    id: "O",
    providerKey: "p.com",
    intent: intent("o.mp4"),
    segmentConcurrency: 4,
    retries: 5,
  });
  s.createJob({
    id: "W",
    providerKey: "p.com",
    intent: intent("w.mp4"),
    segmentConcurrency: 4,
    retries: 5,
  });
  s.createJob({
    id: "P",
    providerKey: "p.com",
    intent: intent("p.mp4"),
    segmentConcurrency: 4,
    retries: 5,
  });
  s.enqueue("O");
  s.enqueue("W");
  s.enqueue("P");
  s.notePermitAcquired("O");
  s.notePermitAcquired("P");
  const wRetry0 = s.getJob("W").retryRemaining;
  const pRetry0 = s.getJob("P").retryRemaining;
  s.onTransportResult("W", s.getJob("W").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  quiesceIfPausing(s, "W");
  quiesceIfPausing(s, "P");
  assert.equal(s.getJob("W").state, "waiting_provider");
  assert.equal(s.getJob("P").state, "waiting_provider");

  s.onTransportResult("O", s.getJob("O").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  assert.equal(s.getJob("W").autoWakeCount, 1);
  assert.equal(s.getJob("W").retryRemaining, wRetry0 - 1);
  assert.equal(s.getJob("P").autoWakeCount, 0);
  assert.equal(s.getJob("P").retryRemaining, pRetry0);
  assert.equal(s.getJob("W").state, "running");

  s.onTransportResult("W", s.getJob("W").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  assert.equal(s.getSnapshot().providers["p.com"].gate.state, "normal");
  assert.ok(s.getJob("P").state === "queued" || s.getJob("P").state === "running");
  assert.equal(s.getJob("P").autoWakeCount, 1);
  assert.equal(s.getJob("P").retryRemaining, pRetry0);
  assert.equal(s.getJob("P").state, "running");

  s.createJob({
    id: "O2",
    providerKey: "p.com",
    intent: intent("o2.mp4"),
    segmentConcurrency: 4,
    retries: 5,
  });
  s.enqueue("O2");
  assert.equal(s.getJob("O2").state, "running");
  s.notePermitAcquired("O2");
  const pRetry1 = s.getJob("P").retryRemaining;
  s.onTransportResult("P", s.getJob("P").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  quiesceIfPausing(s, "P");
  assert.equal(s.getJob("P").state, "waiting_provider");
  s.onTransportResult("O2", s.getJob("O2").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  assert.equal(s.getJob("P").autoWakeCount, 2);
  assert.equal(s.getJob("P").retryRemaining, pRetry1 - 1);
  assert.ok(s.getJob("P").state === "queued" || s.getJob("P").state === "running");
  s.onTransportResult("O2", s.getJob("O2").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  assert.equal(s.getJob("P").autoWakeCount, 2);
  assert.equal(s.getJob("P").retryRemaining, pRetry1 - 1);
  assertSlotInvariant(s);
});

test("paused-only waiter consumes no retry on authorize or recovery requeue", () => {
  const s = createDownloadScheduler({ maxConcurrent: 3, now: () => 0 });
  s.createJob({
    id: "owner",
    providerKey: "p.com",
    intent: intent("o.mp4"),
    segmentConcurrency: 4,
    retries: 4,
  });
  s.createJob({
    id: "fail",
    providerKey: "p.com",
    intent: intent("f.mp4"),
    segmentConcurrency: 4,
    retries: 4,
  });
  s.createJob({
    id: "pausedOnly",
    providerKey: "p.com",
    intent: intent("p.mp4"),
    segmentConcurrency: 4,
    retries: 4,
  });
  s.enqueue("owner");
  s.enqueue("fail");
  s.enqueue("pausedOnly");
  s.notePermitAcquired("owner");
  s.notePermitAcquired("pausedOnly");
  const pausedBefore = s.getJob("pausedOnly").retryRemaining;
  s.onTransportResult("fail", s.getJob("fail").attemptToken, {
    status: "failed",
    failureCategory: "short_read",
  });
  quiesceIfPausing(s, "fail");
  quiesceIfPausing(s, "pausedOnly");
  s.onTransportResult("owner", s.getJob("owner").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  assert.equal(s.getJob("pausedOnly").retryRemaining, pausedBefore);
  s.onTransportResult("fail", s.getJob("fail").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  assert.equal(s.getJob("pausedOnly").retryRemaining, pausedBefore);
  assert.equal(s.getJob("pausedOnly").autoWakeCount, 1);
  assertSlotInvariant(s);
});

test("zero-budget solo and owner saturation candidates fail terminally", () => {
  // Task 11 migration: exhausted ordinary/saturated retry budget enters needs_user
  // (not interim terminal failed). Permanent non-candidates remain failed.
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s.createJob({
    id: "solo",
    providerKey: "p.com",
    intent: intent("s.mp4"),
    segmentConcurrency: 2,
    retries: 0,
  });
  s.enqueue("solo");
  s.onTransportResult("solo", s.getJob("solo").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  assert.equal(s.getJob("solo").state, "needs_user");
  assert.equal(s.getJob("solo").holdsGlobalSlot, false);
  assertSlotInvariant(s);

  // Exhausted failed waiter (retries:0 + consumeRetryOnWake) terminalizes on wake
  // selection — never requeues forever and never becomes recovery owner.
  const s2 = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
  s2.createJob({
    id: "A",
    providerKey: "r.com",
    intent: intent("a.mp4"),
    segmentConcurrency: 4,
    retries: 0,
  });
  s2.createJob({
    id: "B",
    providerKey: "r.com",
    intent: intent("b.mp4"),
    segmentConcurrency: 4,
    retries: 0,
  });
  s2.enqueue("A");
  s2.enqueue("B");
  s2.notePermitAcquired("A");
  s2.onTransportResult("B", s2.getJob("B").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  quiesceIfPausing(s2, "B");
  s2.onTransportResult("A", s2.getJob("A").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  // Task 11 migration: exhausted failed waiter → needs_user (not failed).
  assert.equal(s2.getJob("B").state, "needs_user");
  assert.equal(s2.getJob("B").holdsGlobalSlot, false);
  assert.equal(s2.getSnapshot().providers["r.com"].gate.state, "recovering");
  assert.equal(s2.getSnapshot().providers["r.com"].gate.ownerJobId, null);
  assertSlotInvariant(s2);

  // Recovery owner that reaches zero budget with no further waiters → needs_user.
  const s3 = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
  s3.createJob({
    id: "O",
    providerKey: "s.com",
    intent: intent("o.mp4"),
    segmentConcurrency: 4,
    retries: 2,
  });
  s3.createJob({
    id: "R",
    providerKey: "s.com",
    intent: intent("r.mp4"),
    segmentConcurrency: 4,
    retries: 1, // one wake charge → zero remaining while recovery owner
  });
  s3.enqueue("O");
  s3.enqueue("R");
  s3.notePermitAcquired("O");
  s3.onTransportResult("R", s3.getJob("R").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  quiesceIfPausing(s3, "R");
  s3.onTransportResult("O", s3.getJob("O").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  assert.equal(s3.getJob("R").state, "running");
  assert.equal(s3.getJob("R").retryRemaining, 0);
  assert.equal(s3.getSnapshot().providers["s.com"].gate.state, "recovering");
  s3.onTransportResult("R", s3.getJob("R").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  // Task 11 migration: exhausted recovery owner → needs_user (not failed).
  assert.equal(s3.getJob("R").state, "needs_user");
  assert.equal(s3.getJob("R").holdsGlobalSlot, false);
  assert.equal(s3.getSnapshot().providers["s.com"].gate.state, "recovering");
  assert.equal(s3.getSnapshot().providers["s.com"].gate.ownerJobId, null);
  assertSlotInvariant(s3);
});

test("raw release throw keeps wrapper counts and can be retried", () => {
  const gatePath = path.join(mediaCatcherRoot, "lib", "provider-gate.js");
  const schedPath = path.join(mediaCatcherRoot, "lib", "download-scheduler.js");
  const realGate = loadLib("lib/provider-gate.js");
  let throwNext = true;
  const prevGate = require.cache[require.resolve(gatePath)];
  const prevSched = require.cache[require.resolve(schedPath)];
  try {
    require.cache[require.resolve(gatePath)] = {
      id: require.resolve(gatePath),
      filename: require.resolve(gatePath),
      loaded: true,
      exports: {
        createProviderGate: function (opts) {
          const g = realGate.createProviderGate(opts);
          const origAcquire = g.acquire.bind(g);
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
            acquire: function (jobId, options) {
              const raw = origAcquire(jobId, options);
              if (!raw) return null;
              return Object.freeze({
                jobId: raw.jobId,
                purpose: raw.purpose,
                generation: raw.generation,
                release: function () {
                  if (throwNext) {
                    throwNext = false;
                    throw new Error("simulated raw release failure");
                  }
                  return raw.release();
                },
              });
            },
            setSaturated: g.setSaturated.bind(g),
            registerJobLimit: g.registerJobLimit.bind(g),
            nativeLeaseFor: g.nativeLeaseFor.bind(g),
            noteNativeOpen: g.noteNativeOpen.bind(g),
            parkProbe: g.parkProbe.bind(g),
            completeOwner: g.completeOwner.bind(g),
            designateRecoveryOwner: g.designateRecoveryOwner.bind(g),
            recoverToNormal: g.recoverToNormal.bind(g),
            snapshot: g.snapshot.bind(g),
          };
        },
      },
    };
    delete require.cache[require.resolve(schedPath)];
    const { createDownloadScheduler: createS } = require(schedPath);
    const s = createS({ maxConcurrent: 1, now: () => 0 });
    s.createJob({
      id: "j",
      providerKey: "p.com",
      intent: intent("a.mp4"),
      segmentConcurrency: 2,
      retries: 1,
    });
    s.enqueue("j");
    const p = s.acquireProviderPermit("j", "segment");
    assert.ok(p);
    assert.equal(s.getJob("j").inFlightPermits, 1);
    assert.throws(() => p.release(), /simulated raw release failure/);
    assert.equal(s.getJob("j").inFlightPermits, 1);
    p.release();
    assert.equal(s.getJob("j").inFlightPermits, 0);
    p.release();
    assert.equal(s.getJob("j").inFlightPermits, 0);
    assertSlotInvariant(s);
  } finally {
    if (prevGate) require.cache[require.resolve(gatePath)] = prevGate;
    else delete require.cache[require.resolve(gatePath)];
    if (prevSched) require.cache[require.resolve(schedPath)] = prevSched;
    else delete require.cache[require.resolve(schedPath)];
    loadSchedulerFresh();
  }
});

test("mixed observed adapter and wrapper permit counts sum without crosstalk", () => {
  const s = createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
  s.createJob({
    id: "j",
    providerKey: "p.com",
    intent: intent("a.mp4"),
    segmentConcurrency: 3,
    retries: 1,
  });
  s.enqueue("j");
  const p = s.acquireProviderPermit("j", "segment");
  assert.ok(p);
  assert.equal(s.getJob("j").inFlightPermits, 1);
  s.notePermitAcquired("j");
  assert.equal(s.getJob("j").inFlightPermits, 2);
  s.releasePermit("j");
  assert.equal(s.getJob("j").inFlightPermits, 1);
  s.releasePermit("j");
  assert.equal(s.getJob("j").inFlightPermits, 1);
  p.release();
  assert.equal(s.getJob("j").inFlightPermits, 0);
  s.notePermitAcquired("j");
  s.notePermitAcquired("j");
  assert.equal(s.getJob("j").inFlightPermits, 2);
  s.releasePermit("j");
  assert.equal(s.getJob("j").inFlightPermits, 1);
  assertSlotInvariant(s);
});

test("automatic quiesce from permit and native edges without explicit onQuiesced", () => {
  const s = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
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
  const p = s.acquireProviderPermit("sib", "segment");
  assert.ok(p);
  s.onTransportResult("sib", s.getJob("sib").attemptToken, {
    status: "failed",
    failureCategory: "short_read",
  });
  assert.equal(s.getJob("sib").state, "pausing_provider");
  assert.equal(s.getJob("sib").holdsGlobalSlot, true);
  p.release();
  assert.equal(s.getJob("sib").state, "waiting_provider");
  assert.equal(s.getJob("sib").holdsGlobalSlot, false);
  s.onQuiesced("sib");
  assert.equal(s.getJob("sib").state, "waiting_provider");
  assert.equal(s.getSnapshot().globalRunning, 1);
  assertSlotInvariant(s);

  const s2 = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
  s2.createJob({
    id: "owner",
    providerKey: "q.com",
    intent: intent("o.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s2.createJob({
    id: "sib",
    providerKey: "q.com",
    intent: intent("s.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s2.enqueue("owner");
  s2.enqueue("sib");
  s2.notePermitAcquired("owner");
  s2.noteNativeOpen("sib", 2);
  s2.onTransportResult("sib", s2.getJob("sib").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  assert.equal(s2.getJob("sib").state, "pausing_provider");
  s2.noteNativeOpen("sib", 0);
  assert.equal(s2.getJob("sib").state, "waiting_provider");
  assert.equal(s2.getJob("sib").holdsGlobalSlot, false);
  s2.onQuiesced("sib");
  assert.equal(s2.getSnapshot().globalRunning, 1);
  assertSlotInvariant(s2);

  const s3 = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
  s3.createJob({
    id: "owner",
    providerKey: "r.com",
    intent: intent("o.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s3.createJob({
    id: "sib",
    providerKey: "r.com",
    intent: intent("s.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  s3.enqueue("owner");
  s3.enqueue("sib");
  s3.notePermitAcquired("owner");
  s3.notePermitAcquired("sib");
  s3.onTransportResult("sib", s3.getJob("sib").attemptToken, {
    status: "failed",
    failureCategory: "connection_reset",
  });
  assert.equal(s3.getJob("sib").state, "pausing_provider");
  s3.releasePermit("sib");
  assert.equal(s3.getJob("sib").state, "waiting_provider");
  assert.equal(s3.getJob("sib").holdsGlobalSlot, false);
  assertSlotInvariant(s3);
});

test("repeated saturation while already saturated keeps generation and reduced cap stable", () => {
  const s = createDownloadScheduler({ maxConcurrent: 3, now: () => 0 });
  s.createJob({
    id: "A",
    providerKey: "p.com",
    intent: intent("a.mp4"),
    segmentConcurrency: 8,
    retries: 3,
  });
  s.createJob({
    id: "B",
    providerKey: "p.com",
    intent: intent("b.mp4"),
    segmentConcurrency: 8,
    retries: 3,
  });
  s.createJob({
    id: "C",
    providerKey: "p.com",
    intent: intent("c.mp4"),
    segmentConcurrency: 8,
    retries: 3,
  });
  s.enqueue("A");
  s.enqueue("B");
  s.enqueue("C");
  s.notePermitAcquired("A");
  s.notePermitAcquired("B");
  s.notePermitAcquired("C");
  s.onTransportResult("B", s.getJob("B").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  const gate1 = s.getSnapshot().providers["p.com"].gate;
  assert.equal(gate1.state, "saturated");
  assert.equal(gate1.ownerJobId, "A");
  const gen1 = gate1.generation;
  const reduced1 = gate1.reducedConcurrency;
  assert.equal(s.getJob("A").effectiveConcurrency, 4);
  assert.equal(reduced1, 4);
  const gate2 = s.getSnapshot().providers["p.com"].gate;
  assert.equal(gate2.state, "saturated");
  assert.equal(gate2.ownerJobId, "A");
  assert.equal(gate2.generation, gen1);
  assert.equal(gate2.reducedConcurrency, reduced1);
  assert.equal(s.getJob("A").effectiveConcurrency, 4);
  assert.notEqual(gate2.ownerJobId, "B");
  assert.notEqual(gate2.ownerJobId, "C");
  assertSlotInvariant(s);
});

test("CommonJS dependency load failures propagate and do not fall back to globals", () => {
  const schedPath = path.join(mediaCatcherRoot, "lib", "download-scheduler.js");
  const code = fs.readFileSync(schedPath, "utf8");
  const root = {
    McProviderGate: {
      createProviderGate: function () {
        return {};
      },
    },
    McFailureClassify: {
      isSaturationCandidate: function () {
        return false;
      },
      hasActiveSibling: function () {
        return { ok: false, siblingJobId: null };
      },
    },
  };
  function throwingRequire(id) {
    if (String(id).indexOf("provider-gate") !== -1) {
      throw new Error("simulated ProviderGate load failure");
    }
    if (String(id).indexOf("failure-classify") !== -1) {
      return root.McFailureClassify;
    }
    return require(id);
  }
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: throwingRequire,
    console,
    self: root,
  };
  sandbox.module.exports = sandbox.exports;
  assert.throws(() => {
    vm.runInNewContext(code, sandbox, { filename: schedPath });
    if (sandbox.module.exports && sandbox.module.exports.createDownloadScheduler) {
      sandbox.module.exports.createDownloadScheduler({ maxConcurrent: 1, now: () => 0 });
    }
  }, /simulated ProviderGate load failure/);
});

// ---------------------------------------------------------------------------
// Fix-round 3 regressions (late quiesce wake / exhausted waiters / late obs)
// ---------------------------------------------------------------------------

test("late quiesce after owner completion auto-wakes waiter that held an observed permit", () => {
  // Mutation: completeProviderOwner ignores pausing siblings; maybeQuiesce parks forever.
  const s = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
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
  s.onTransportResult("sib", s.getJob("sib").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  assert.equal(s.getJob("sib").state, "pausing_provider");
  assert.equal(s.getJob("sib").inFlightPermits, 1);
  // Owner completes while sibling is still draining — no waiting_provider yet.
  s.onTransportResult("owner", s.getJob("owner").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  assert.equal(s.getJob("owner").state, "completed");
  assert.equal(s.getJob("sib").state, "pausing_provider");
  assert.equal(s.getSnapshot().providers["p.com"].gate.state, "recovering");
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, null);
  // Completing the drain edge must auto-wake without manual onQuiesced.
  s.releasePermit("sib");
  assert.ok(
    s.getJob("sib").state === "queued" || s.getJob("sib").state === "running",
    "late-quiesced sibling must not remain stranded in waiting_provider"
  );
  assert.equal(s.getJob("sib").autoWakeCount, 1);
  assert.equal(s.getJob("sib").state, "running");
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "sib");
  assert.equal(s.getSnapshot().providers["p.com"].gate.state, "recovering");
  assertSlotInvariant(s);
});

test("late quiesce after owner completion auto-wakes waiter that held a native connection", () => {
  const s = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
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
  s.noteNativeOpen("sib", 2);
  s.onTransportResult("sib", s.getJob("sib").attemptToken, {
    status: "failed",
    failureCategory: "connection_reset",
  });
  assert.equal(s.getJob("sib").state, "pausing_provider");
  assert.equal(s.getJob("sib").nativeOpenConnections, 2);
  s.onTransportResult("owner", s.getJob("owner").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  assert.equal(s.getSnapshot().providers["p.com"].gate.state, "recovering");
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, null);
  // Native drain to zero must authorize wake (no onQuiesced).
  s.noteNativeOpen("sib", 0);
  assert.equal(s.getJob("sib").state, "running");
  assert.equal(s.getJob("sib").autoWakeCount, 1);
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "sib");
  assertSlotInvariant(s);
});

test("still-pausing waiter auto-wakes after recovery succeeds and gate is normal", () => {
  // B waits immediately; C keeps a permit while A drains and B recovers to normal.
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
  s.notePermitAcquired("C");
  // B fails with zero permits → immediate waiting_provider; C pauses with permit.
  s.onTransportResult("B", s.getJob("B").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  assert.equal(s.getJob("B").state, "waiting_provider");
  assert.equal(s.getJob("C").state, "pausing_provider");
  assert.equal(s.getJob("C").inFlightPermits, 1);

  s.onTransportResult("A", s.getJob("A").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  assert.equal(s.getJob("B").state, "running");
  assert.equal(s.getSnapshot().providers["p.com"].gate.state, "recovering");
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "B");
  // C still pausing under active recovery owner — must remain parked.
  assert.equal(s.getJob("C").state, "pausing_provider");
  assert.equal(s.getJob("C").autoWakeCount, 0);

  s.onTransportResult("B", s.getJob("B").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  assert.equal(s.getSnapshot().providers["p.com"].gate.state, "normal");
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, null);
  // C still draining — not yet woken.
  assert.equal(s.getJob("C").state, "pausing_provider");

  s.releasePermit("C");
  assert.ok(
    s.getJob("C").state === "queued" || s.getJob("C").state === "running",
    "late quiesce under normal gate must not strand waiter"
  );
  assert.equal(s.getJob("C").autoWakeCount, 1);
  assert.equal(s.getJob("C").state, "running");
  assert.equal(s.getSnapshot().providers["p.com"].gate.state, "normal");
  assertSlotInvariant(s);
});

test("active recovery owner keeps a still-pausing sibling parked until owner ends", () => {
  const s = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
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
  s.onTransportResult("sib", s.getJob("sib").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  assert.equal(s.getJob("sib").state, "pausing_provider");
  // Owner still running as drain owner — quiesce must park, not wake.
  s.releasePermit("sib");
  assert.equal(s.getJob("sib").state, "waiting_provider");
  assert.equal(s.getJob("sib").autoWakeCount, 0);
  assert.equal(s.getSnapshot().providers["p.com"].gate.state, "saturated");
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "owner");
  assertSlotInvariant(s);
});

test("exhausted failed waiter terminalizes; next eligible waiter becomes recovery owner", () => {
  // Exhausted failed waiter first in wait FIFO, then a paused-only eligible waiter.
  const s = createDownloadScheduler({ maxConcurrent: 3, now: () => 0 });
  s.createJob({
    id: "owner",
    providerKey: "p.com",
    intent: intent("o.mp4"),
    segmentConcurrency: 4,
    retries: 2,
  });
  s.createJob({
    id: "exhausted",
    providerKey: "p.com",
    intent: intent("e.mp4"),
    segmentConcurrency: 4,
    retries: 0, // failed waiter with no budget
  });
  s.createJob({
    id: "eligible",
    providerKey: "p.com",
    intent: intent("g.mp4"),
    segmentConcurrency: 4,
    retries: 0, // paused-only: zero budget still allowed to wake
  });
  s.enqueue("owner");
  s.enqueue("exhausted");
  s.enqueue("eligible");
  s.notePermitAcquired("owner");
  s.notePermitAcquired("eligible");
  s.onTransportResult("exhausted", s.getJob("exhausted").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  quiesceIfPausing(s, "exhausted");
  quiesceIfPausing(s, "eligible");
  assert.equal(s.getJob("exhausted").state, "waiting_provider");
  assert.equal(s.getJob("eligible").state, "waiting_provider");
  assert.equal(s.getJob("exhausted").retryRemaining, 0);
  assert.equal(s.getJob("eligible").retryRemaining, 0);

  s.onTransportResult("owner", s.getJob("owner").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  // Task 11 migration: exhausted failed waiter → needs_user (not requeue, not failed).
  assert.equal(s.getJob("exhausted").state, "needs_user");
  assert.equal(s.getJob("exhausted").holdsGlobalSlot, false);
  assert.equal(s.getJob("exhausted").autoWakeCount, 0);
  // Eligible paused-only zero-budget waiter progresses as recovery owner.
  assert.equal(s.getJob("eligible").state, "running");
  assert.equal(s.getJob("eligible").autoWakeCount, 1);
  assert.equal(s.getJob("eligible").retryRemaining, 0); // paused-only: no charge
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "eligible");
  assert.equal(s.getSnapshot().providers["p.com"].gate.state, "recovering");
  assert.notEqual(s.getSnapshot().providers["p.com"].gate.ownerJobId, "exhausted");
  assert.deepEqual(s.getSnapshot().providers["p.com"].waiting, []);
  assertSlotInvariant(s);
});

test("exhausted failed waiter as sole waiter terminalizes; gate recovers blocked", () => {
  const s = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
  s.createJob({
    id: "owner",
    providerKey: "p.com",
    intent: intent("o.mp4"),
    segmentConcurrency: 4,
    retries: 2,
  });
  s.createJob({
    id: "exhausted",
    providerKey: "p.com",
    intent: intent("e.mp4"),
    segmentConcurrency: 4,
    retries: 0,
  });
  s.enqueue("owner");
  s.enqueue("exhausted");
  s.notePermitAcquired("owner");
  s.onTransportResult("exhausted", s.getJob("exhausted").attemptToken, {
    status: "failed",
    failureCategory: "http_429",
  });
  quiesceIfPausing(s, "exhausted");
  assert.equal(s.getJob("exhausted").state, "waiting_provider");
  s.onTransportResult("owner", s.getJob("owner").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  // Task 11 migration: exhausted sole failed waiter → needs_user (not failed).
  assert.equal(s.getJob("exhausted").state, "needs_user");
  assert.equal(s.getJob("exhausted").holdsGlobalSlot, false);
  assert.equal(s.getJob("exhausted").autoWakeCount, 0);
  assert.equal(s.getSnapshot().providers["p.com"].gate.state, "recovering");
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, null);
  assert.deepEqual(s.getSnapshot().providers["p.com"].waiting, []);
  assert.deepEqual(s.getSnapshot().providers["p.com"].queued, []);
  assertSlotInvariant(s);
});

test("paused-only zero-budget waiter may wake without consuming retry", () => {
  const s = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
  s.createJob({
    id: "owner",
    providerKey: "p.com",
    intent: intent("o.mp4"),
    segmentConcurrency: 4,
    retries: 0,
  });
  s.createJob({
    id: "pausedOnly",
    providerKey: "p.com",
    intent: intent("p.mp4"),
    segmentConcurrency: 4,
    retries: 0,
  });
  s.createJob({
    id: "fail",
    providerKey: "p.com",
    intent: intent("f.mp4"),
    segmentConcurrency: 4,
    retries: 3,
  });
  // maxConcurrent=2: run owner + pausedOnly first, then raise and admit fail.
  s.enqueue("owner");
  s.enqueue("pausedOnly");
  s.notePermitAcquired("owner");
  s.notePermitAcquired("pausedOnly");
  s.setMaxConcurrent(3);
  s.enqueue("fail");
  assert.equal(s.getJob("fail").state, "running");
  const pausedBefore = s.getJob("pausedOnly").retryRemaining;
  assert.equal(pausedBefore, 0);
  s.onTransportResult("fail", s.getJob("fail").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  quiesceIfPausing(s, "fail");
  quiesceIfPausing(s, "pausedOnly");
  assert.equal(s.getJob("pausedOnly").state, "waiting_provider");
  // Fail is oldest failed waiter; after owner completes fail wakes first.
  s.onTransportResult("owner", s.getJob("owner").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  assert.equal(s.getJob("fail").state, "running");
  // Recovery success requeues paused-only at zero budget without charging.
  s.onTransportResult("fail", s.getJob("fail").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  assert.ok(
    s.getJob("pausedOnly").state === "queued" || s.getJob("pausedOnly").state === "running"
  );
  assert.equal(s.getJob("pausedOnly").retryRemaining, 0);
  assert.equal(s.getJob("pausedOnly").autoWakeCount, 1);
  assert.equal(s.getJob("pausedOnly").state, "running");
  assertSlotInvariant(s);
});

test("notePermitAcquired ignores late observations in waiting and terminal states", () => {
  const s = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
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
  s.onTransportResult("sib", s.getJob("sib").attemptToken, {
    status: "failed",
    failureCategory: "short_read",
  });
  assert.equal(s.getJob("sib").state, "pausing_provider");
  // Valid pausing observation still accepted.
  s.notePermitAcquired("sib");
  assert.equal(s.getJob("sib").inFlightPermits, 2);
  s.releasePermit("sib");
  s.releasePermit("sib");
  assert.equal(s.getJob("sib").state, "waiting_provider");
  assert.equal(s.getJob("sib").inFlightPermits, 0);
  // Late observation after wait must not re-inflate or re-block.
  s.notePermitAcquired("sib");
  s.notePermitAcquired("sib");
  assert.equal(s.getJob("sib").inFlightPermits, 0);
  assert.equal(s.getJob("sib").state, "waiting_provider");

  s.onTransportResult("owner", s.getJob("owner").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  assert.equal(s.getJob("sib").state, "running");
  s.onTransportResult("sib", s.getJob("sib").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  assert.equal(s.getJob("sib").state, "completed");
  s.notePermitAcquired("sib");
  assert.equal(s.getJob("sib").inFlightPermits, 0);
  assertSlotInvariant(s);
});
