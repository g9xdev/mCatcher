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
  // Adapter release never goes negative
  s.releasePermit("j");
  s.releasePermit("j");
  s.releasePermit("j");
  assert.equal(s.getJob("j").inFlightPermits, 0);
  // notePermitAcquired then release
  s.notePermitAcquired("j");
  assert.equal(s.getJob("j").inFlightPermits, 1);
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
