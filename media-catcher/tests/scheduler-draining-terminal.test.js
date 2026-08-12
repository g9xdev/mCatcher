"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { loadLib } = require("./harness/load-lib.js");
const { createDownloadScheduler } = loadLib("lib/download-scheduler.js");

/**
 * McDownloadScheduler — Task 20D draining native terminals
 * -------------------------------------------------------
 * When a same-provider non-owner is moved to pausing_provider, its public
 * attemptToken is nulled while a private draining identity authenticates the
 * still-outstanding physical native attempt. Matching completed/cancelled/
 * failed results must reconcile without orphaning committed files, leaking
 * the old token publicly, falsely quiescing wrapper permits, double-charging
 * retries, or touching Firefox.
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
    p.waiting.forEach(function (id) {
      assert.equal(s.getJob(id).state, "waiting_provider");
    });
    p.queued.forEach(function (id) {
      assert.equal(s.getJob(id).state, "queued");
    });
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
      assert.ok(owner);
      assert.notEqual(owner.state, "needs_user");
      assert.notEqual(owner.state, "waiting_provider");
      assert.notEqual(owner.state, "cancelled");
      assert.notEqual(owner.state, "completed");
      assert.notEqual(owner.state, "failed");
    }
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
  assert.equal(Object.prototype.hasOwnProperty.call(job, "drainingAttemptToken"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(job, "pendingDrainTerminal"), false);
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

function failedResult(category, partState, mode) {
  return {
    status: "failed",
    mode: mode || "multi-range",
    failureCategory: category,
    partState: partState || "partial",
  };
}

/**
 * A/B/C same-provider topology: C's saturation failure keeps A as owner and
 * parks B in pausing_provider (native opens keep it non-quiescent). Returns
 * B's pre-pause live attempt token (public projection is then null).
 */
function setupABCPausingB(opts) {
  opts = opts || {};
  var firefoxCalls = { n: 0 };
  var clearB = { n: 0 };
  var maxConcurrent = opts.maxConcurrent == null ? 3 : opts.maxConcurrent;
  var s = createDownloadScheduler({
    maxConcurrent: maxConcurrent,
    now: function () {
      return 0;
    },
    firefoxDownload: function () {
      firefoxCalls.n += 1;
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
        clearB.n += 1;
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
  assert.equal(s.getJob("A").state, "running");
  assert.equal(s.getJob("B").state, "running");
  assert.equal(s.getJob("C").state, "running");
  s.notePermitAcquired("A");
  s.noteNativeOpen("A", 1);
  s.noteNativeOpen("B", opts.bNativeOpens == null ? 2 : opts.bNativeOpens);
  // Keep C non-quiescent so it stays pausing_provider; B is then the first
  // waiter when its draining terminal settles (FIFO head for owner wake).
  s.noteNativeOpen("C", opts.cNativeOpens == null ? 1 : opts.cNativeOpens);
  var bToken = s.getJob("B").attemptToken;
  assert.equal(typeof bToken, "string");
  assert.ok(bToken.trim().length > 0);
  s.onTransportResult("C", s.getJob("C").attemptToken, {
    status: "failed",
    failureCategory: "http_429",
  });
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "A");
  assert.equal(s.getJob("A").state, "running");
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.equal(s.getJob("B").attemptToken, null);
  assert.equal(s.getJob("B").holdsGlobalSlot, true);
  assert.ok(s.getJob("B").nativeOpenConnections >= 1);
  assert.equal(s.getJob("C").state, "pausing_provider");
  return {
    s: s,
    bToken: bToken,
    firefoxCalls: firefoxCalls,
    clearB: clearB,
  };
}

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
          completeOwner: g.completeOwner.bind(g),
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

// ---------------------------------------------------------------------------
// 1. Matching old-token completed/committed → completed; slot once; no waiter
// ---------------------------------------------------------------------------

test("1 draining completed settles B completed once; A ownership and independent admit preserved", () => {
  var fx = { n: 0 };
  var clearB = { n: 0 };
  var s = createDownloadScheduler({
    maxConcurrent: 3,
    now: function () {
      return 0;
    },
    firefoxDownload: function () {
      fx.n += 1;
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
        clearB.n += 1;
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
  // Independent provider peer queued behind global capacity once B releases.
  s.createJob({
    id: "peer",
    providerKey: "other.com",
    intent: intent("peer.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.enqueue("A");
  s.enqueue("B");
  s.enqueue("C");
  s.enqueue("peer");
  assert.equal(s.getJob("peer").state, "queued");
  s.notePermitAcquired("A");
  s.noteNativeOpen("A", 1);
  s.noteNativeOpen("B", 2);
  s.noteNativeOpen("C", 1);
  var bToken = s.getJob("B").attemptToken;
  var aToken = s.getJob("A").attemptToken;
  var retriesBefore = s.getJob("B").retryRemaining;
  var usedBefore = s.getJob("B").retryUsed;
  var wakeBefore = s.getJob("B").autoWakeCount;
  var globalBefore = s.getSnapshot().globalRunning;

  s.onTransportResult("C", s.getJob("C").attemptToken, {
    status: "failed",
    failureCategory: "http_429",
  });
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "A");
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.equal(s.getJob("C").state, "pausing_provider");
  assert.equal(s.getJob("B").attemptToken, null);
  assert.equal(s.getJob("A").attemptToken, aToken);
  var verBefore = s.getJob("B").stateVersion;

  assert.equal(typeof s.onDrainingTransportResult, "function");
  var ok = s.onDrainingTransportResult("B", bToken, completedResult());
  assert.equal(ok, true);
  assert.equal(s.getJob("B").state, "completed");
  assert.equal(s.getJob("B").holdsGlobalSlot, false);
  assert.equal(s.getJob("B").nativeOpenConnections, 0);
  assert.equal(s.getJob("B").attemptToken, null);
  assert.equal(s.getJob("B").retryRemaining, retriesBefore);
  assert.equal(s.getJob("B").retryUsed, usedBefore);
  assert.equal(s.getJob("B").autoWakeCount, wakeBefore);
  assert.equal(s.getJob("B").stateVersion, verBefore + 1);
  assert.equal(clearB.n, 1);
  assert.equal(s.getSnapshot().providers["p.com"].waiting.indexOf("B"), -1);
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "A");
  assert.equal(s.getJob("A").state, "running");
  assert.equal(s.getJob("A").attemptToken, aToken);
  // Capacity opened: independent peer admits into the released slot.
  assert.equal(s.getJob("peer").state, "running");
  // A running + C pausing + peer running still fill the cap.
  assert.equal(s.getSnapshot().globalRunning, globalBefore);
  assert.equal(s.getJob("B").holdsGlobalSlot, false);
  // Duplicate old terminal inert.
  assert.equal(s.onDrainingTransportResult("B", bToken, completedResult()), false);
  assert.equal(s.getJob("B").state, "completed");
  assert.equal(clearB.n, 1);
  assert.equal(fx.n, 0);
  assertSlotInvariant(s);
  assertPermitAndOwnerInvariants(s);
});

// ---------------------------------------------------------------------------
// 2. Matching cancelled (pause-control ack) → waiting_provider, no retry charge
// ---------------------------------------------------------------------------

test("2 draining cancelled pause-control ack parks waiting without paused-only retry charge", () => {
  var topo = setupABCPausingB();
  var s = topo.s;
  var retriesBefore = s.getJob("B").retryRemaining;
  var usedBefore = s.getJob("B").retryUsed;
  var wakeBefore = s.getJob("B").autoWakeCount;
  var clearBefore = topo.clearB.n;

  var ok = s.onDrainingTransportResult("B", topo.bToken, cancelledResult());
  assert.equal(ok, true);
  assert.equal(s.getJob("B").state, "waiting_provider");
  assert.equal(s.getJob("B").holdsGlobalSlot, false);
  assert.equal(s.getJob("B").nativeOpenConnections, 0);
  assert.equal(s.getJob("B").retryRemaining, retriesBefore);
  assert.equal(s.getJob("B").retryUsed, usedBefore);
  assert.equal(s.getJob("B").autoWakeCount, wakeBefore);
  assert.ok(s.getSnapshot().providers["p.com"].waiting.indexOf("B") !== -1);
  assert.equal(topo.clearB.n, clearBefore);
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "A");
  assert.equal(topo.firefoxCalls.n, 0);
  // Duplicate inert.
  assert.equal(s.onDrainingTransportResult("B", topo.bToken, cancelledResult()), false);
  assert.equal(s.getJob("B").retryRemaining, retriesBefore);
  assertSlotInvariant(s);
  assertPermitAndOwnerInvariants(s);
});

// ---------------------------------------------------------------------------
// 3. Matching transient/saturation failure → waiting + one consume-on-wake
// ---------------------------------------------------------------------------

test("3 draining saturation failure marks consume-on-wake once; duplicate cannot double-charge", () => {
  var topo = setupABCPausingB();
  var s = topo.s;
  var retriesBefore = s.getJob("B").retryRemaining;
  var usedBefore = s.getJob("B").retryUsed;

  var ok = s.onDrainingTransportResult(
    "B",
    topo.bToken,
    failedResult("timeout", "partial")
  );
  assert.equal(ok, true);
  assert.equal(s.getJob("B").state, "waiting_provider");
  assert.equal(s.getJob("B").holdsGlobalSlot, false);
  assert.equal(s.getJob("B").nativeOpenConnections, 0);
  // Charge is deferred to wake; budget not yet decremented.
  assert.equal(s.getJob("B").retryRemaining, retriesBefore);
  assert.equal(s.getJob("B").retryUsed, usedBefore);
  assert.ok(s.getSnapshot().providers["p.com"].waiting.indexOf("B") !== -1);

  // Duplicate must not stack a second consume flag / charge.
  assert.equal(
    s.onDrainingTransportResult("B", topo.bToken, failedResult("timeout", "partial")),
    false
  );

  // Owner completes → authorized wake charges exactly once.
  s.onTransportResult("A", s.getJob("A").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  var b = s.getJob("B");
  assert.ok(b.state === "queued" || b.state === "running");
  assert.equal(b.retryRemaining, retriesBefore - 1);
  assert.equal(b.retryUsed, usedBefore + 1);
  assert.equal(b.autoWakeCount, 1);
  assert.equal(topo.firefoxCalls.n, 0);
  assertSlotInvariant(s);
});

// ---------------------------------------------------------------------------
// 4. local_io / permanent → needs_user; A ownership unchanged; no Firefox
// ---------------------------------------------------------------------------

test("4 draining local_io and permanent park needs_user without Firefox or ownership change", () => {
  for (const category of ["local_io", "permanent"]) {
    var topo = setupABCPausingB();
    var s = topo.s;
    var aToken = s.getJob("A").attemptToken;
    var retriesBefore = s.getJob("B").retryRemaining;
    var clearBefore = topo.clearB.n;

    var ok = s.onDrainingTransportResult(
      "B",
      topo.bToken,
      failedResult(category, category === "local_io" ? "empty" : "partial")
    );
    assert.equal(ok, true);
    assert.equal(s.getJob("B").state, "needs_user");
    assert.equal(s.getJob("B").holdsGlobalSlot, false);
    assert.equal(s.getJob("B").nativeOpenConnections, 0);
    assert.equal(s.getJob("B").retryRemaining, retriesBefore);
    assert.equal(topo.clearB.n, clearBefore); // ephemeral retained
    assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "A");
    assert.equal(s.getJob("A").state, "running");
    assert.equal(s.getJob("A").attemptToken, aToken);
    assert.equal(s.getSnapshot().providers["p.com"].waiting.indexOf("B"), -1);
    assert.equal(topo.firefoxCalls.n, 0);
    assert.equal(s.onDrainingTransportResult("B", topo.bToken, failedResult(category)), false);
    assertSlotInvariant(s);
    assertPermitAndOwnerInvariants(s);
  }
});

// ---------------------------------------------------------------------------
// 5. range_unsupported empty → single-connection park; fresh token on admit
// ---------------------------------------------------------------------------

test("5 draining range_unsupported empty switches mode, parks waiting, fresh token on admit", () => {
  var topo = setupABCPausingB();
  var s = topo.s;
  var retriesBefore = s.getJob("B").retryRemaining;

  var ok = s.onDrainingTransportResult(
    "B",
    topo.bToken,
    failedResult("range_unsupported", "empty", "multi-range")
  );
  assert.equal(ok, true);
  assert.equal(s.getJob("B").state, "waiting_provider");
  assert.equal(s.getJob("B").mode, "single-connection");
  assert.equal(s.getJob("B").effectiveConcurrency, 1);
  assert.equal(s.getJob("B").holdsGlobalSlot, false);
  assert.equal(s.getJob("B").nativeOpenConnections, 0);
  assert.equal(s.getJob("B").retryRemaining, retriesBefore);
  assert.equal(s.getJob("B").attemptToken, null);
  assert.ok(s.getSnapshot().providers["p.com"].waiting.indexOf("B") !== -1);
  assert.equal(topo.firefoxCalls.n, 0);

  // Never same-token restart while parked.
  assert.equal(
    s.onDrainingTransportResult("B", topo.bToken, completedResult()),
    false
  );
  assert.equal(s.getJob("B").state, "waiting_provider");

  // Owner finishes → recovery authorization; B is wait FIFO head and admits
  // with a NEW token while remaining single-connection.
  s.onTransportResult("A", s.getJob("A").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  var b = s.getJob("B");
  assert.ok(b.state === "queued" || b.state === "running");
  if (b.state === "queued") {
    // Capacity may still be held by pausing C; free it via unavailable park.
    if (s.getJob("C").state === "pausing_provider") {
      s.onTransportUnavailable("C");
    }
    b = s.getJob("B");
  }
  assert.equal(b.state, "running");
  assert.equal(typeof b.attemptToken, "string");
  assert.notEqual(b.attemptToken, topo.bToken);
  assert.equal(b.mode, "single-connection");
  assert.equal(b.effectiveConcurrency, 1);
  assert.equal(topo.firefoxCalls.n, 0);
  assertSlotInvariant(s);
});

// ---------------------------------------------------------------------------
// 6. Wrapper permit: store privately, stay pausing until permit release
// ---------------------------------------------------------------------------

test("6 draining terminal with wrapper permit stays pausing until permit release settles", () => {
  var fx = { n: 0 };
  var s = createDownloadScheduler({
    maxConcurrent: 3,
    now: function () {
      return 0;
    },
    firefoxDownload: function () {
      fx.n += 1;
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
  s.notePermitAcquired("A");
  s.noteNativeOpen("A", 1);
  s.noteNativeOpen("B", 2);
  s.noteNativeOpen("C", 1);
  var permit = s.acquireProviderPermit("B", "segment");
  assert.ok(permit);
  assert.equal(s.getJob("B").inFlightPermits >= 1, true);
  var bToken = s.getJob("B").attemptToken;

  s.onTransportResult("C", s.getJob("C").attemptToken, {
    status: "failed",
    failureCategory: "http_429",
  });
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.ok(s.getJob("B").inFlightPermits >= 1);

  var ok = s.onDrainingTransportResult("B", bToken, completedResult());
  assert.equal(ok, true);
  // Native opens zeroed, but wrapper permit keeps job pausing with slot.
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.equal(s.getJob("B").holdsGlobalSlot, true);
  assert.equal(s.getJob("B").nativeOpenConnections, 0);
  assert.equal(s.getJob("B").attemptToken, null);
  // Terminal must not imply wrapper permits quiesced.
  assert.ok(s.getJob("B").inFlightPermits >= 1);
  // Duplicate accepted terminal inert while still pausing.
  assert.equal(s.onDrainingTransportResult("B", bToken, completedResult()), false);
  assert.equal(s.getJob("B").state, "pausing_provider");

  permit.release();
  assert.equal(s.getJob("B").state, "completed");
  assert.equal(s.getJob("B").holdsGlobalSlot, false);
  assert.equal(s.getJob("B").inFlightPermits, 0);
  assert.equal(fx.n, 0);
  assertSlotInvariant(s);
  assertPermitAndOwnerInvariants(s);
});

// ---------------------------------------------------------------------------
// 7. cancel(B) while pausing: user cancellation wins over draining terminal
// ---------------------------------------------------------------------------

test("7 cancel while pausing makes draining terminal settle cancelled after quiescence", () => {
  for (const terminal of [
    completedResult(),
    cancelledResult(),
    failedResult("timeout", "partial"),
  ]) {
    var topo = setupABCPausingB();
    var s = topo.s;
    s.cancel("B");
    assert.equal(s.getJob("B").state, "pausing_provider");

    var ok = s.onDrainingTransportResult("B", topo.bToken, terminal);
    assert.equal(ok, true);
    assert.equal(s.getJob("B").state, "cancelled");
    assert.equal(s.getJob("B").holdsGlobalSlot, false);
    assert.equal(s.getJob("B").nativeOpenConnections, 0);
    assert.equal(topo.clearB.n, 1);
    assert.equal(s.getSnapshot().providers["p.com"].waiting.indexOf("B"), -1);
    assert.equal(topo.firefoxCalls.n, 0);
    assert.equal(s.onDrainingTransportResult("B", topo.bToken, terminal), false);
    assertSlotInvariant(s);
  }
});

// ---------------------------------------------------------------------------
// 8. Wrong/stale/blank/nonprimitive tokens, duplicates, wrong state: false
// ---------------------------------------------------------------------------

test("8 wrong/stale/blank/nonprimitive tokens and out-of-state terminals are false no-ops", () => {
  var topo = setupABCPausingB();
  var s = topo.s;
  var snap = s.getJob("B");
  var nativeBefore = snap.nativeOpenConnections;
  var verBefore = snap.stateVersion;

  function assertUnchanged() {
    var j = s.getJob("B");
    assert.equal(j.state, "pausing_provider");
    assert.equal(j.nativeOpenConnections, nativeBefore);
    assert.equal(j.stateVersion, verBefore);
    assert.equal(j.holdsGlobalSlot, true);
    assert.equal(j.attemptToken, null);
  }

  assert.equal(s.onDrainingTransportResult("B", "stale-token", completedResult()), false);
  assertUnchanged();
  assert.equal(s.onDrainingTransportResult("B", "", completedResult()), false);
  assertUnchanged();
  assert.equal(s.onDrainingTransportResult("B", "   ", completedResult()), false);
  assertUnchanged();
  assert.equal(s.onDrainingTransportResult("B", null, completedResult()), false);
  assertUnchanged();
  assert.equal(s.onDrainingTransportResult("B", undefined, completedResult()), false);
  assertUnchanged();
  assert.equal(s.onDrainingTransportResult("B", 0, completedResult()), false);
  assertUnchanged();
  assert.equal(s.onDrainingTransportResult("B", new String(topo.bToken), completedResult()), false);
  assertUnchanged();
  // Wrong job id
  assert.equal(s.onDrainingTransportResult("A", topo.bToken, completedResult()), false);
  assert.equal(s.getJob("A").state, "running");
  assertUnchanged();
  // Malformed result
  assert.equal(s.onDrainingTransportResult("B", topo.bToken, { status: "completed" }), false);
  assertUnchanged();
  assert.equal(
    s.onDrainingTransportResult("B", topo.bToken, {
      status: "completed",
      mode: "multi-range",
      failureCategory: null,
      partState: "partial",
    }),
    false
  );
  assertUnchanged();
  assert.equal(
    s.onDrainingTransportResult("B", topo.bToken, {
      status: "failed",
      mode: "multi-range",
      failureCategory: "timeout",
      partState: "committed",
    }),
    false
  );
  assertUnchanged();

  // Outside pausing: running owner rejects draining API.
  assert.equal(
    s.onDrainingTransportResult("A", s.getJob("A").attemptToken, completedResult()),
    false
  );

  // Accept once, then replay false; also fresh-admission token must not revive.
  assert.equal(s.onDrainingTransportResult("B", topo.bToken, cancelledResult()), true);
  assert.equal(s.getJob("B").state, "waiting_provider");
  assert.equal(s.onDrainingTransportResult("B", topo.bToken, cancelledResult()), false);

  // After owner completes and B is re-admitted, old draining token is dead.
  s.onTransportResult("A", s.getJob("A").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  var b = s.getJob("B");
  if (b.state === "queued" || b.state === "waiting_provider") {
    if (s.getJob("C").state === "pausing_provider") {
      s.onTransportUnavailable("C");
    }
    b = s.getJob("B");
  }
  assert.equal(b.state, "running");
  assert.notEqual(b.attemptToken, topo.bToken);
  assert.equal(s.onDrainingTransportResult("B", topo.bToken, completedResult()), false);
  assert.equal(s.getJob("B").state, "running");
  assert.equal(topo.firefoxCalls.n, 0);
  assertSlotInvariant(s);
});

// ---------------------------------------------------------------------------
// 9. Injectable noteNativeOpen faults: throw-before retryable; mutate-then once
// ---------------------------------------------------------------------------

test("9 noteNativeOpen throw-before preserves auth; mutate-then-throw settles once", () => {
  const gatePath = path.resolve(__dirname, "..", "lib", "provider-gate.js");
  const schedPath = path.resolve(__dirname, "..", "lib", "download-scheduler.js");
  const realGate = require(gatePath);
  const prevGate = require.cache[require.resolve(gatePath)];
  const prevSched = require.cache[require.resolve(schedPath)];

  // --- throw before mutation ---
  try {
    let gateRef = null;
    let throwBefore = true;
    installHostileGate(realGate, gatePath, {
      onGate: function (g) {
        gateRef = g;
      },
      noteNativeOpen: function (g, jobId, n) {
        if (throwBefore && n === 0 && jobId === "B") {
          throw new Error("simulated noteNativeOpen throw before mutation");
        }
        return g.noteNativeOpen(jobId, n);
      },
    });
    const createS = loadSchedulerFresh(schedPath);
    const s = createS({
      maxConcurrent: 3,
      now: function () {
        return 0;
      },
      firefoxDownload: function () {},
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
    s.notePermitAcquired("A");
    s.noteNativeOpen("A", 1);
    s.noteNativeOpen("B", 2);
    s.noteNativeOpen("C", 1);
    var bToken = s.getJob("B").attemptToken;
    s.onTransportResult("C", s.getJob("C").attemptToken, {
      status: "failed",
      failureCategory: "http_429",
    });
    assert.equal(s.getJob("B").state, "pausing_provider");
    var nativeBefore = s.getJob("B").nativeOpenConnections;
    assert.ok(nativeBefore >= 1);
    // setSaturated clears gate nativeOpen bookkeeping; job counter remains the
    // physical source of truth until onDrainingTransportResult reconciles zero.
    var gateOpenBefore = gateRef.snapshot().nativeOpen.B;

    var threw = false;
    try {
      s.onDrainingTransportResult("B", bToken, completedResult());
    } catch (e) {
      threw = true;
    }
    assert.equal(threw, true);
    assert.equal(s.getJob("B").state, "pausing_provider");
    assert.equal(s.getJob("B").nativeOpenConnections, nativeBefore);
    // Throw-before-mutation must not project a false zero on the job, and must
    // leave the gate snapshot unchanged so the call remains retryable.
    assert.equal(gateRef.snapshot().nativeOpen.B, gateOpenBefore);
    assert.equal(s.getJob("B").holdsGlobalSlot, true);

    // Retry after clearing the fault succeeds with same private identity.
    throwBefore = false;
    assert.equal(s.onDrainingTransportResult("B", bToken, completedResult()), true);
    assert.equal(s.getJob("B").state, "completed");
    assert.equal(s.getJob("B").nativeOpenConnections, 0);
    assert.equal(gateRef.snapshot().nativeOpen.B, 0);
  } finally {
    restoreModuleCache(gatePath, schedPath, prevGate, prevSched);
  }

  // --- mutate to zero then throw ---
  const prevGate2 = require.cache[require.resolve(gatePath)];
  const prevSched2 = require.cache[require.resolve(schedPath)];
  try {
    let gateRef2 = null;
    installHostileGate(realGate, gatePath, {
      onGate: function (g) {
        gateRef2 = g;
      },
      noteNativeOpen: function (g, jobId, n) {
        if (n === 0 && jobId === "B") {
          g.noteNativeOpen(jobId, n);
          throw new Error("simulated noteNativeOpen throw after mutation");
        }
        return g.noteNativeOpen(jobId, n);
      },
    });
    const createS2 = loadSchedulerFresh(schedPath);
    const s2 = createS2({
      maxConcurrent: 3,
      now: function () {
        return 0;
      },
      firefoxDownload: function () {},
    });
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
    s2.noteNativeOpen("B", 2);
    s2.noteNativeOpen("C", 1);
    var bToken2 = s2.getJob("B").attemptToken;
    s2.onTransportResult("C", s2.getJob("C").attemptToken, {
      status: "failed",
      failureCategory: "http_429",
    });

    var ok2 = s2.onDrainingTransportResult("B", bToken2, completedResult());
    assert.equal(ok2, true);
    assert.equal(s2.getJob("B").state, "completed");
    assert.equal(s2.getJob("B").nativeOpenConnections, 0);
    assert.equal(gateRef2.snapshot().nativeOpen.B, 0);
    // Exactly once — replay inert.
    assert.equal(s2.onDrainingTransportResult("B", bToken2, completedResult()), false);
    assert.equal(s2.getJob("B").state, "completed");
  } finally {
    restoreModuleCache(gatePath, schedPath, prevGate2, prevSched2);
  }
});

// ---------------------------------------------------------------------------
// 10. getJob / getSnapshot key sets never expose draining private fields
// ---------------------------------------------------------------------------

test("10 getJob and getSnapshot never expose drainingAttemptToken or pendingDrainTerminal", () => {
  var topo = setupABCPausingB();
  var s = topo.s;
  assertProjectionKeys(s.getJob("B"));
  assertProjectionKeys(s.getJob("A"));
  var snap = s.getSnapshot();
  snap.jobs.forEach(assertProjectionKeys);

  // While privately pending with a wrapper permit.
  var s2 = createDownloadScheduler({ maxConcurrent: 3, now: () => 0 });
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
  s2.noteNativeOpen("C", 1);
  var p = s2.acquireProviderPermit("B", "seg");
  var tok = s2.getJob("B").attemptToken;
  s2.onTransportResult("C", s2.getJob("C").attemptToken, {
    status: "failed",
    failureCategory: "short_read",
  });
  assert.equal(s2.onDrainingTransportResult("B", tok, completedResult()), true);
  assert.equal(s2.getJob("B").state, "pausing_provider");
  assertProjectionKeys(s2.getJob("B"));
  s2.getSnapshot().jobs.forEach(assertProjectionKeys);
  // Stringify path must not leak private names.
  var json = JSON.stringify(s2.getSnapshot());
  assert.equal(json.indexOf("drainingAttemptToken"), -1);
  assert.equal(json.indexOf("pendingDrainTerminal"), -1);
  p.release();
  assert.equal(s2.getJob("B").state, "completed");
  assertProjectionKeys(s2.getJob("B"));
});
