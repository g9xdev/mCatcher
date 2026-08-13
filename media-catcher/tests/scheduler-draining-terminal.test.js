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
  assert.equal(Object.prototype.hasOwnProperty.call(job, "drainTransportUnavailable"), false);
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

// ---------------------------------------------------------------------------
// 11. Race: already-consumed failed job must not capture a private drain token
// ---------------------------------------------------------------------------

test("11A fresh saturation: failed job C keeps no private drain auth; one wake charge", () => {
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
  // B paused-only sibling keeps a live physical attempt (control for 11C).
  s.noteNativeOpen("B", 1);
  // C non-quiescent so it parks pausing_provider after its own failure is consumed.
  s.noteNativeOpen("C", 1);
  var cToken = s.getJob("C").attemptToken;
  var bToken = s.getJob("B").attemptToken;
  assert.equal(typeof cToken, "string");
  assert.ok(cToken.trim().length > 0);
  var cRetries = s.getJob("C").retryRemaining;
  var cUsed = s.getJob("C").retryUsed;
  var cMode = s.getJob("C").mode;

  s.onTransportResult("C", cToken, {
    status: "failed",
    failureCategory: "http_429",
  });
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "A");
  assert.equal(s.getJob("C").state, "pausing_provider");
  assert.equal(s.getJob("C").attemptToken, null);
  assert.equal(s.getJob("C").holdsGlobalSlot, true);
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.equal(s.getJob("B").attemptToken, null);
  // Baselines after the consumed failure / pause transition.
  var cVer = s.getJob("C").stateVersion;
  var cSlot = s.getJob("C").holdsGlobalSlot;
  var cNative = s.getJob("C").nativeOpenConnections;

  // Old-token contradictions for the already-consumed failed job are inert.
  assert.equal(s.onDrainingTransportResult("C", cToken, completedResult()), false);
  assert.equal(s.onDrainingTransportResult("C", cToken, cancelledResult()), false);
  assert.equal(
    s.onDrainingTransportResult("C", cToken, failedResult("timeout", "partial")),
    false
  );
  assert.equal(s.getJob("C").state, "pausing_provider");
  assert.equal(s.getJob("C").attemptToken, null);
  assert.equal(s.getJob("C").retryRemaining, cRetries);
  assert.equal(s.getJob("C").retryUsed, cUsed);
  assert.equal(s.getJob("C").mode, cMode);
  assert.equal(s.getJob("C").stateVersion, cVer);
  assert.equal(s.getJob("C").holdsGlobalSlot, cSlot);
  assert.equal(s.getJob("C").nativeOpenConnections, cNative);
  assertProjectionKeys(s.getJob("C"));

  // Physical counters drain → waiting with exactly one consume-on-wake charge.
  s.noteNativeOpen("C", 0);
  assert.equal(s.getJob("C").state, "waiting_provider");
  assert.equal(s.getJob("C").holdsGlobalSlot, false);
  assert.equal(s.getJob("C").retryRemaining, cRetries);
  assert.equal(s.getJob("C").retryUsed, cUsed);
  // Still no private drain auth after waiting.
  assert.equal(s.onDrainingTransportResult("C", cToken, completedResult()), false);

  // Release paused-only B so C is the sole same-provider waiter, then complete owner.
  assert.equal(s.onDrainingTransportResult("B", bToken, cancelledResult()), true);
  assert.equal(s.getJob("B").state, "waiting_provider");
  s.onTransportResult("A", s.getJob("A").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  // B (cancelled pause-ack, no consume flag) is FIFO head; complete it if admitted
  // so C receives its failed-job wake charge.
  var b = s.getJob("B");
  if (b.state === "running") {
    s.onTransportResult("B", b.attemptToken, {
      status: "completed",
      failureCategory: null,
    });
  } else if (b.state === "queued") {
    // Drain should have admitted under recovering; if not, free capacity.
    if (s.getJob("C").state === "waiting_provider") {
      // B may be recovery owner queued behind global cap — force via unavailable of peers.
    }
  }
  var c = s.getJob("C");
  if (c.state === "waiting_provider") {
    b = s.getJob("B");
    if (b.state === "running") {
      s.onTransportResult("B", b.attemptToken, {
        status: "completed",
        failureCategory: null,
      });
    }
    c = s.getJob("C");
  }
  assert.ok(c.state === "queued" || c.state === "running");
  assert.equal(c.retryRemaining, cRetries - 1);
  assert.equal(c.retryUsed, cUsed + 1);
  assert.equal(c.autoWakeCount, 1);
  assert.equal(fx.n, 0);
  assertSlotInvariant(s);
  assertPermitAndOwnerInvariants(s);
});

test("11B joinExistingSaturationWait: already-consumed late failer has no private auth; one wake charge", () => {
  // Public enterSaturation always pauses running non-owners. To exercise the
  // joinExistingSaturationWait path a non-owner must still be running under an
  // already-saturated gate (same fixture style as hostile-gate tests in this file).
  const gatePath = path.resolve(__dirname, "..", "lib", "provider-gate.js");
  const schedPath = path.resolve(__dirname, "..", "lib", "download-scheduler.js");
  const realGate = require(gatePath);
  const prevGate = require.cache[require.resolve(gatePath)];
  const prevSched = require.cache[require.resolve(schedPath)];
  try {
    let gateRef = null;
    installHostileGate(realGate, gatePath, {
      onGate: function (g) {
        gateRef = g;
      },
    });
    const createS = loadSchedulerFresh(schedPath);
    var fx = { n: 0 };
    var s = createS({
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
    s.noteNativeOpen("C", 1);
    assert.equal(s.getJob("A").state, "running");
    assert.equal(s.getJob("C").state, "running");

    // Pre-saturate without the enterSaturation pause loop so C remains a live
    // running non-owner; C's own failure then takes joinExistingSaturationWait.
    gateRef.setSaturated({ drainOwnerJobId: "A", reducedConcurrency: 2 });
    assert.equal(gateRef.state, "saturated");
    assert.equal(gateRef.snapshot().ownerJobId, "A");
    assert.equal(s.getJob("C").state, "running");
    var cToken = s.getJob("C").attemptToken;
    var cRetries = s.getJob("C").retryRemaining;
    var cUsed = s.getJob("C").retryUsed;
    var gen = gateRef.snapshot().generation;

    s.onTransportResult("C", cToken, {
      status: "failed",
      failureCategory: "http_429",
    });
    // joinExisting: no generation bump / re-halving owner bookkeeping.
    assert.equal(s.getSnapshot().providers["p.com"].gate.state, "saturated");
    assert.equal(s.getSnapshot().providers["p.com"].gate.generation, gen);
    assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "A");
    assert.equal(s.getJob("C").state, "pausing_provider");
    assert.equal(s.getJob("C").attemptToken, null);
    // Baselines after joinExisting pause (stateVersion already advanced once).
    var cVer = s.getJob("C").stateVersion;
    var cNative = s.getJob("C").nativeOpenConnections;

    assert.equal(s.onDrainingTransportResult("C", cToken, completedResult()), false);
    assert.equal(s.onDrainingTransportResult("C", cToken, cancelledResult()), false);
    assert.equal(
      s.onDrainingTransportResult("C", cToken, failedResult("timeout", "partial")),
      false
    );
    assert.equal(s.getJob("C").state, "pausing_provider");
    assert.equal(s.getJob("C").retryRemaining, cRetries);
    assert.equal(s.getJob("C").retryUsed, cUsed);
    assert.equal(s.getJob("C").stateVersion, cVer);
    assert.equal(s.getJob("C").nativeOpenConnections, cNative);
    assert.equal(s.getJob("C").holdsGlobalSlot, true);
    assertProjectionKeys(s.getJob("C"));

    s.noteNativeOpen("C", 0);
    assert.equal(s.getJob("C").state, "waiting_provider");
    assert.equal(s.getJob("C").holdsGlobalSlot, false);
    assert.equal(s.getJob("C").retryRemaining, cRetries);

    // Owner completion → C is wake-FIFO head (B still running under forced sat).
    if (s.getJob("B").state === "running") {
      s.onTransportUnavailable("B");
    }
    s.onTransportResult("A", s.getJob("A").attemptToken, {
      status: "completed",
      failureCategory: null,
    });
    var c = s.getJob("C");
    assert.ok(c.state === "queued" || c.state === "running");
    assert.equal(c.retryRemaining, cRetries - 1);
    assert.equal(c.retryUsed, cUsed + 1);
    assert.equal(c.autoWakeCount, 1);
    assert.equal(fx.n, 0);
    assertSlotInvariant(s);
  } finally {
    restoreModuleCache(gatePath, schedPath, prevGate, prevSched);
  }
});

test("11C paused-only sibling still authenticates exactly one old-token terminal", () => {
  var topo = setupABCPausingB();
  var s = topo.s;
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.equal(s.getJob("B").attemptToken, null);
  // Single matching terminal authenticates.
  assert.equal(s.onDrainingTransportResult("B", topo.bToken, completedResult()), true);
  assert.equal(s.getJob("B").state, "completed");
  // Replay inert.
  assert.equal(s.onDrainingTransportResult("B", topo.bToken, completedResult()), false);
  assert.equal(topo.firefoxCalls.n, 0);
  assertSlotInvariant(s);
});

// ---------------------------------------------------------------------------
// 12. Race: late semantic terminal after physical counters reach zero
// ---------------------------------------------------------------------------

test("12D late terminal after early native zero: hold pausing auth until match", () => {
  var topo = setupABCPausingB();
  var s = topo.s;
  var verBefore = s.getJob("B").stateVersion;
  var retriesBefore = s.getJob("B").retryRemaining;

  // Physical native opens drain before the pget semantic terminal arrives.
  s.noteNativeOpen("B", 0);
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.equal(s.getJob("B").attemptToken, null);
  assert.equal(s.getJob("B").holdsGlobalSlot, true);
  assert.equal(s.getJob("B").nativeOpenConnections, 0);
  assert.equal(s.getJob("B").stateVersion, verBefore);
  assert.equal(s.getJob("B").retryRemaining, retriesBefore);
  assertProjectionKeys(s.getJob("B"));

  // Matching old-token completed settles once.
  assert.equal(s.onDrainingTransportResult("B", topo.bToken, completedResult()), true);
  assert.equal(s.getJob("B").state, "completed");
  assert.equal(s.getJob("B").holdsGlobalSlot, false);
  assert.equal(s.getJob("B").nativeOpenConnections, 0);
  // Replay inert.
  assert.equal(s.onDrainingTransportResult("B", topo.bToken, completedResult()), false);
  assert.equal(s.getJob("B").state, "completed");
  assert.equal(topo.firefoxCalls.n, 0);
  assert.equal(topo.clearB.n, 1);
  assertSlotInvariant(s);
  assertPermitAndOwnerInvariants(s);
});

test("12E late terminal after final wrapper/observed permit release: hold then settle", () => {
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
  // B: positive native opens at pause entry (captures drain token) plus wrapper/observed permits.
  s.noteNativeOpen("B", 1);
  s.noteNativeOpen("C", 1);
  var permit = s.acquireProviderPermit("B", "segment");
  assert.ok(permit);
  s.notePermitAcquired("B");
  assert.ok(s.getJob("B").inFlightPermits >= 2);
  assert.ok(s.getJob("B").nativeOpenConnections > 0);
  var bToken = s.getJob("B").attemptToken;

  s.onTransportResult("C", s.getJob("C").attemptToken, {
    status: "failed",
    failureCategory: "http_429",
  });
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.equal(s.getJob("B").attemptToken, null);
  assert.ok(s.getJob("B").inFlightPermits >= 2);
  assert.ok(s.getJob("B").nativeOpenConnections > 0);

  // Native zero first while permits remain — private drain auth retained.
  s.noteNativeOpen("B", 0);
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.equal(s.getJob("B").holdsGlobalSlot, true);

  // Drain observed permit, then wrapper — physical zero before semantic terminal.
  s.releasePermit("B");
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.equal(s.getJob("B").holdsGlobalSlot, true);
  permit.release();
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.equal(s.getJob("B").holdsGlobalSlot, true);
  assert.equal(s.getJob("B").inFlightPermits, 0);
  assert.equal(s.getJob("B").nativeOpenConnections, 0);
  assert.equal(s.getJob("B").attemptToken, null);

  assert.equal(s.onDrainingTransportResult("B", bToken, completedResult()), true);
  assert.equal(s.getJob("B").state, "completed");
  assert.equal(s.getJob("B").holdsGlobalSlot, false);
  assert.equal(s.onDrainingTransportResult("B", bToken, completedResult()), false);
  assert.equal(fx.n, 0);
  assertSlotInvariant(s);
  assertPermitAndOwnerInvariants(s);
});

test("12I permit-only pause does not capture drain token; native-positive still holds", () => {
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
  // B: wrapper/observed permits only — never noteNativeOpen > 0.
  s.noteNativeOpen("B", 0);
  s.noteNativeOpen("C", 1);
  var permit = s.acquireProviderPermit("B", "segment");
  assert.ok(permit);
  s.notePermitAcquired("B");
  assert.ok(s.getJob("B").inFlightPermits >= 2);
  assert.equal(s.getJob("B").nativeOpenConnections, 0);
  var bToken = s.getJob("B").attemptToken;
  assert.equal(typeof bToken, "string");
  assert.ok(bToken.trim().length > 0);

  s.onTransportResult("C", s.getJob("C").attemptToken, {
    status: "failed",
    failureCategory: "http_429",
  });
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.equal(s.getJob("B").attemptToken, null);
  assert.equal(s.getJob("B").nativeOpenConnections, 0);
  assert.ok(s.getJob("B").inFlightPermits >= 2);

  // Last physical permits release → ordinary quiesce to waiting (no native terminal wait).
  s.releasePermit("B");
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.equal(s.getJob("B").holdsGlobalSlot, true);
  permit.release();
  assert.equal(s.getJob("B").state, "waiting_provider");
  assert.equal(s.getJob("B").holdsGlobalSlot, false);
  assert.equal(s.getJob("B").inFlightPermits, 0);
  assert.equal(s.getJob("B").nativeOpenConnections, 0);
  assert.equal(s.getJob("B").attemptToken, null);
  // Old public token must not authenticate via the private draining channel.
  assert.equal(s.onDrainingTransportResult("B", bToken, completedResult()), false);
  assert.equal(s.getJob("B").state, "waiting_provider");
  assert.equal(fx.n, 0);
  assertSlotInvariant(s);
  assertPermitAndOwnerInvariants(s);

  // Native-positive control in the same suite: 12D holds pausing after native zero
  // until the matching terminal. Repeat a minimal native-positive sibling here.
  var topo = setupABCPausingB();
  var s2 = topo.s;
  s2.noteNativeOpen("B", 0);
  assert.equal(s2.getJob("B").state, "pausing_provider");
  assert.equal(s2.getJob("B").holdsGlobalSlot, true);
  assert.equal(s2.getJob("B").attemptToken, null);
  assert.equal(s2.onDrainingTransportResult("B", topo.bToken, completedResult()), true);
  assert.equal(s2.getJob("B").state, "completed");
  assert.equal(s2.getJob("B").holdsGlobalSlot, false);
  assert.equal(topo.firefoxCalls.n, 0);
  assertSlotInvariant(s2);
});

test("12F cancel after counters zero but before terminal remains pausing then cancels once", () => {
  var topo = setupABCPausingB();
  var s = topo.s;

  s.noteNativeOpen("B", 0);
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.equal(s.getJob("B").holdsGlobalSlot, true);
  assert.equal(s.getJob("B").attemptToken, null);

  s.cancel("B");
  // Must remain pausing/slot-held until the matching semantic terminal arrives.
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.equal(s.getJob("B").holdsGlobalSlot, true);
  assert.equal(s.getJob("B").attemptToken, null);
  assert.equal(topo.clearB.n, 0);

  assert.equal(s.onDrainingTransportResult("B", topo.bToken, completedResult()), true);
  assert.equal(s.getJob("B").state, "cancelled");
  assert.equal(s.getJob("B").holdsGlobalSlot, false);
  assert.equal(topo.clearB.n, 1);
  assert.equal(s.onDrainingTransportResult("B", topo.bToken, completedResult()), false);
  assert.equal(topo.firefoxCalls.n, 0);
  assertSlotInvariant(s);
});

test("12G transport unavailable in retained-token/quiescent state parks needs_user", () => {
  var topo = setupABCPausingB();
  var s = topo.s;

  s.noteNativeOpen("B", 0);
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.equal(s.getJob("B").holdsGlobalSlot, true);

  assert.equal(s.onTransportUnavailable("B"), true);
  assert.equal(s.getJob("B").state, "needs_user");
  assert.equal(s.getJob("B").holdsGlobalSlot, false);
  assert.equal(s.getJob("B").nativeOpenConnections, 0);
  assert.equal(s.getJob("B").attemptToken, null);
  // Old terminal inert after unavailable cleared auth.
  assert.equal(s.onDrainingTransportResult("B", topo.bToken, completedResult()), false);
  assert.equal(s.getJob("B").state, "needs_user");
  assert.equal(topo.firefoxCalls.n, 0);
  assert.equal(topo.clearB.n, 0); // ephemeral retained for manualRetry
  assertSlotInvariant(s);
});

test("12H failed-job with no private token still moves to waiting on counter zero", () => {
  var s = createDownloadScheduler({
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
  s.noteNativeOpen("A", 1);
  s.noteNativeOpen("B", 0);
  s.noteNativeOpen("C", 1);
  var cToken = s.getJob("C").attemptToken;
  s.onTransportResult("C", cToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  assert.equal(s.getJob("C").state, "pausing_provider");
  assert.equal(s.getJob("C").attemptToken, null);
  // No private drain identity → counter zero must not strand in pausing.
  s.noteNativeOpen("C", 0);
  assert.equal(s.getJob("C").state, "waiting_provider");
  assert.equal(s.getJob("C").holdsGlobalSlot, false);
  assert.equal(s.onDrainingTransportResult("C", cToken, completedResult()), false);
  assertSlotInvariant(s);
});

// ---------------------------------------------------------------------------
// 13. validateDrainingResult descriptor hardening (via onDrainingTransportResult)
// ---------------------------------------------------------------------------

test("13I descriptor hardening: accessors/proxy traps never mutate; cancelled category rules", () => {
  var topo = setupABCPausingB();
  var s = topo.s;
  var snap = s.getJob("B");
  var nativeBefore = snap.nativeOpenConnections;
  var verBefore = snap.stateVersion;
  var retriesBefore = snap.retryRemaining;
  var modeBefore = snap.mode;

  function assertUnchanged() {
    var j = s.getJob("B");
    assert.equal(j.state, "pausing_provider");
    assert.equal(j.nativeOpenConnections, nativeBefore);
    assert.equal(j.stateVersion, verBefore);
    assert.equal(j.holdsGlobalSlot, true);
    assert.equal(j.attemptToken, null);
    assert.equal(j.retryRemaining, retriesBefore);
    assert.equal(j.mode, modeBefore);
  }

  // Accessor getters for each of the four fields must never be invoked.
  ["status", "mode", "partState", "failureCategory"].forEach(function (key) {
    var hits = { n: 0 };
    var hostile = {
      status: "completed",
      mode: "multi-range",
      partState: "committed",
      failureCategory: null,
    };
    Object.defineProperty(hostile, key, {
      configurable: true,
      enumerable: true,
      get: function () {
        hits.n += 1;
        throw new Error("SECRET_ACCESSOR_" + key);
      },
    });
    var threw = false;
    var ok;
    try {
      ok = s.onDrainingTransportResult("B", topo.bToken, hostile);
    } catch (e) {
      threw = true;
    }
    assert.equal(threw, false, "accessor trap must not propagate for " + key);
    assert.equal(ok, false);
    assert.equal(hits.n, 0, "accessor for " + key + " must never run");
    assertUnchanged();
  });

  // Proxy getOwnPropertyDescriptor traps cannot leak thrown Error.
  var proxyHits = { n: 0 };
  var proxy = new Proxy(
    {
      status: "completed",
      mode: "multi-range",
      partState: "committed",
      failureCategory: null,
    },
    {
      getOwnPropertyDescriptor: function () {
        proxyHits.n += 1;
        throw new Error("SECRET_GOPD");
      },
      get: function () {
        throw new Error("SECRET_GET");
      },
      ownKeys: function () {
        throw new Error("SECRET_KEYS");
      },
    }
  );
  var proxyThrew = false;
  var proxyOk;
  try {
    proxyOk = s.onDrainingTransportResult("B", topo.bToken, proxy);
  } catch (e) {
    proxyThrew = true;
  }
  assert.equal(proxyThrew, false);
  assert.equal(proxyOk, false);
  assertUnchanged();

  // Missing / invalid data fails false without mutation.
  assert.equal(s.onDrainingTransportResult("B", topo.bToken, {}), false);
  assertUnchanged();
  assert.equal(
    s.onDrainingTransportResult("B", topo.bToken, {
      status: "completed",
      mode: "multi-range",
      partState: "committed",
      // failureCategory absent ok for completed; but wrong partState tested elsewhere
    }),
    true
  );
  // First valid completed consumed — rebuild topology for cancelled rules.
  assert.equal(s.getJob("B").state, "completed");

  // Cancelled category allowlist: null / absent / exact "cancelled" accepted;
  // timeout / arbitrary / object / boxed rejected.
  function setupPausedB() {
    return setupABCPausingB();
  }

  // null category
  var t1 = setupPausedB();
  assert.equal(
    t1.s.onDrainingTransportResult("B", t1.bToken, {
      status: "cancelled",
      mode: "multi-range",
      partState: "partial",
      failureCategory: null,
    }),
    true
  );
  assert.equal(t1.s.getJob("B").state, "waiting_provider");

  // absent category
  var t2 = setupPausedB();
  assert.equal(
    t2.s.onDrainingTransportResult("B", t2.bToken, {
      status: "cancelled",
      mode: "multi-range",
      partState: "partial",
    }),
    true
  );
  assert.equal(t2.s.getJob("B").state, "waiting_provider");

  // exact primitive "cancelled"
  var t3 = setupPausedB();
  assert.equal(
    t3.s.onDrainingTransportResult("B", t3.bToken, cancelledResult()),
    true
  );
  assert.equal(t3.s.getJob("B").state, "waiting_provider");

  // rejected cancelled categories
  [
    "timeout",
    "arbitrary",
    { x: 1 },
    new String("cancelled"),
    0,
    false,
    "",
  ].forEach(function (badCat) {
    var t = setupPausedB();
    var before = t.s.getJob("B");
    var n = before.nativeOpenConnections;
    var v = before.stateVersion;
    assert.equal(
      t.s.onDrainingTransportResult("B", t.bToken, {
        status: "cancelled",
        mode: "multi-range",
        partState: "partial",
        failureCategory: badCat,
      }),
      false
    );
    assert.equal(t.s.getJob("B").state, "pausing_provider");
    assert.equal(t.s.getJob("B").nativeOpenConnections, n);
    assert.equal(t.s.getJob("B").stateVersion, v);
    assert.equal(t.firefoxCalls.n, 0);
  });
});

test("13J allowlist rejects inherited Object.prototype keys as membership", () => {
  // Cancelled with partState "__proto__" must not pass via prototype chain.
  var t1 = setupABCPausingB();
  var before1 = t1.s.getJob("B");
  assert.equal(
    t1.s.onDrainingTransportResult("B", t1.bToken, {
      status: "cancelled",
      mode: "multi-range",
      partState: "__proto__",
      failureCategory: "cancelled",
    }),
    false
  );
  assert.equal(t1.s.getJob("B").state, "pausing_provider");
  assert.equal(t1.s.getJob("B").nativeOpenConnections, before1.nativeOpenConnections);
  assert.equal(t1.s.getJob("B").stateVersion, before1.stateVersion);
  assert.equal(t1.s.getJob("B").holdsGlobalSlot, true);
  assert.equal(t1.firefoxCalls.n, 0);

  // Failed with category "constructor" must not pass via Object.prototype.constructor.
  var t2 = setupABCPausingB();
  var before2 = t2.s.getJob("B");
  assert.equal(
    t2.s.onDrainingTransportResult("B", t2.bToken, {
      status: "failed",
      mode: "multi-range",
      partState: "partial",
      failureCategory: "constructor",
    }),
    false
  );
  assert.equal(t2.s.getJob("B").state, "pausing_provider");
  assert.equal(t2.s.getJob("B").nativeOpenConnections, before2.nativeOpenConnections);
  assert.equal(t2.s.getJob("B").stateVersion, before2.stateVersion);
  assert.equal(t2.s.getJob("B").holdsGlobalSlot, true);
  assert.equal(t2.firefoxCalls.n, 0);

  // toString must also be inert for status membership.
  var t3 = setupABCPausingB();
  var before3 = t3.s.getJob("B");
  assert.equal(
    t3.s.onDrainingTransportResult("B", t3.bToken, {
      status: "toString",
      mode: "multi-range",
      partState: "committed",
      failureCategory: null,
    }),
    false
  );
  assert.equal(t3.s.getJob("B").state, "pausing_provider");
  assert.equal(t3.s.getJob("B").stateVersion, before3.stateVersion);

  // Exact valid built-in primitives still accepted after hardening.
  assert.equal(
    t3.s.onDrainingTransportResult("B", t3.bToken, completedResult()),
    true
  );
  assert.equal(t3.s.getJob("B").state, "completed");
  assert.equal(t3.firefoxCalls.n, 0);
  assertSlotInvariant(t1.s);
  assertSlotInvariant(t2.s);
  assertSlotInvariant(t3.s);
});

// ---------------------------------------------------------------------------
// 14. Pending draining terminal survives helper disconnect (Task20D fix)
// ---------------------------------------------------------------------------

/**
 * Build A/B/C pausing topology where B holds a wrapper permit (non-quiescent
 * after native-open zero). Returns { s, bToken, permit, firefoxCalls, clearB }.
 */
function setupABCPausingBWithPermit(opts) {
  opts = opts || {};
  var firefoxCalls = { n: 0 };
  var clearB = { n: 0 };
  var s = createDownloadScheduler({
    maxConcurrent: opts.maxConcurrent == null ? 3 : opts.maxConcurrent,
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
  if (opts.peer) {
    s.createJob({
      id: "peer",
      providerKey: "other.com",
      intent: intent("peer.mp4"),
      segmentConcurrency: 2,
      retries: 1,
    });
  }
  s.enqueue("A");
  s.enqueue("B");
  s.enqueue("C");
  if (opts.peer) s.enqueue("peer");
  s.notePermitAcquired("A");
  s.noteNativeOpen("A", 1);
  s.noteNativeOpen("B", opts.bNativeOpens == null ? 2 : opts.bNativeOpens);
  s.noteNativeOpen("C", opts.cNativeOpens == null ? 1 : opts.cNativeOpens);
  var permit = s.acquireProviderPermit("B", "segment");
  assert.ok(permit);
  assert.ok(s.getJob("B").inFlightPermits >= 1);
  var bToken = s.getJob("B").attemptToken;
  assert.equal(typeof bToken, "string");
  s.onTransportResult("C", s.getJob("C").attemptToken, {
    status: "failed",
    failureCategory: "http_429",
  });
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "A");
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.equal(s.getJob("B").attemptToken, null);
  assert.equal(s.getJob("B").holdsGlobalSlot, true);
  assert.ok(s.getJob("B").inFlightPermits >= 1);
  return {
    s: s,
    bToken: bToken,
    permit: permit,
    firefoxCalls: firefoxCalls,
    clearB: clearB,
  };
}

test("14A pending completed + held permit: unavailable preserves outcome; release → completed once", () => {
  var topo = setupABCPausingBWithPermit({ peer: true, maxConcurrent: 3 });
  var s = topo.s;
  var clearBefore = topo.clearB.n;
  var retriesBefore = s.getJob("B").retryRemaining;
  var usedBefore = s.getJob("B").retryUsed;
  var wakeBefore = s.getJob("B").autoWakeCount;
  var globalBefore = s.getSnapshot().globalRunning;
  var waitingBefore = s.getSnapshot().providers["p.com"].waiting.slice();

  assert.equal(s.onDrainingTransportResult("B", topo.bToken, completedResult()), true);
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.equal(s.getJob("B").holdsGlobalSlot, true);
  assert.ok(s.getJob("B").inFlightPermits >= 1);
  assert.equal(s.getJob("B").nativeOpenConnections, 0);

  // First helper disconnect: record private unavailable, preserve pending.
  assert.equal(s.onTransportUnavailable("B"), true);
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.equal(s.getJob("B").holdsGlobalSlot, true);
  assert.equal(s.getJob("B").attemptToken, null);
  assert.ok(s.getJob("B").inFlightPermits >= 1);
  assert.equal(s.getJob("B").nativeOpenConnections, 0);
  assert.equal(topo.clearB.n, clearBefore);
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "A");
  assert.equal(s.getJob("peer").state, "queued");
  assertProjectionKeys(s.getJob("B"));

  // Duplicate unavailable is a false no-op.
  assert.equal(s.onTransportUnavailable("B"), false);
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.equal(s.getJob("B").holdsGlobalSlot, true);
  assert.equal(topo.clearB.n, clearBefore);

  // Last permit release settles the preserved completed outcome exactly once.
  topo.permit.release();
  assert.equal(s.getJob("B").state, "completed");
  assert.equal(s.getJob("B").holdsGlobalSlot, false);
  assert.equal(s.getJob("B").inFlightPermits, 0);
  assert.equal(s.getJob("B").nativeOpenConnections, 0);
  assert.equal(s.getJob("B").retryRemaining, retriesBefore);
  assert.equal(s.getJob("B").retryUsed, usedBefore);
  assert.equal(s.getJob("B").autoWakeCount, wakeBefore);
  assert.equal(topo.clearB.n, clearBefore + 1);
  // Independent provider admits into the released slot; same-provider waiters not woken.
  assert.equal(s.getJob("peer").state, "running");
  assert.deepEqual(s.getSnapshot().providers["p.com"].waiting, waitingBefore);
  assert.equal(s.getSnapshot().providers["p.com"].waiting.indexOf("B"), -1);
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "A");
  assert.equal(s.getJob("A").state, "running");
  // Replay of old draining terminal inert.
  assert.equal(s.onDrainingTransportResult("B", topo.bToken, completedResult()), false);
  assert.equal(s.getJob("B").state, "completed");
  assert.equal(topo.clearB.n, clearBefore + 1);
  assert.equal(topo.firefoxCalls.n, 0);
  assert.equal(s.getSnapshot().globalRunning, globalBefore);
  assertSlotInvariant(s);
  assertPermitAndOwnerInvariants(s);
});

test("14B pending non-success + unavailable: remain pausing until release then needs_user", () => {
  var cases = [
    { label: "status cancelled pause-ack", result: cancelledResult() },
    { label: "saturation timeout", result: failedResult("timeout", "partial") },
    { label: "saturation http_429", result: failedResult("http_429", "partial") },
    { label: "local_io", result: failedResult("local_io", "empty") },
    { label: "permanent", result: failedResult("permanent", "partial") },
    {
      label: "range_unsupported empty",
      result: failedResult("range_unsupported", "empty", "multi-range"),
    },
    {
      label: "failed category cancelled",
      result: failedResult("cancelled", "partial"),
    },
  ];

  cases.forEach(function (c) {
    var topo = setupABCPausingBWithPermit();
    var s = topo.s;
    var retriesBefore = s.getJob("B").retryRemaining;
    var usedBefore = s.getJob("B").retryUsed;
    var wakeBefore = s.getJob("B").autoWakeCount;
    var clearBefore = topo.clearB.n;
    var waitingBefore = s.getSnapshot().providers["p.com"].waiting.slice();

    assert.equal(
      s.onDrainingTransportResult("B", topo.bToken, c.result),
      true,
      c.label
    );
    assert.equal(s.getJob("B").state, "pausing_provider", c.label);
    assert.equal(s.getJob("B").holdsGlobalSlot, true, c.label);

    assert.equal(s.onTransportUnavailable("B"), true, c.label);
    assert.equal(s.getJob("B").state, "pausing_provider", c.label);
    assert.equal(s.getJob("B").holdsGlobalSlot, true, c.label);
    assert.equal(s.getJob("B").retryRemaining, retriesBefore, c.label);
    assert.equal(s.getJob("B").retryUsed, usedBefore, c.label);
    assert.equal(s.getJob("B").autoWakeCount, wakeBefore, c.label);
    assert.equal(topo.clearB.n, clearBefore, c.label);
    assert.equal(s.onTransportUnavailable("B"), false, c.label);

    topo.permit.release();
    assert.equal(s.getJob("B").state, "needs_user", c.label);
    assert.equal(s.getJob("B").holdsGlobalSlot, false, c.label);
    assert.equal(s.getJob("B").retryRemaining, retriesBefore, c.label);
    assert.equal(s.getJob("B").retryUsed, usedBefore, c.label);
    assert.equal(s.getJob("B").autoWakeCount, wakeBefore, c.label);
    // Ephemeral retained for needs_user; no same-provider wake of B.
    assert.equal(topo.clearB.n, clearBefore, c.label);
    assert.equal(s.getSnapshot().providers["p.com"].waiting.indexOf("B"), -1, c.label);
    assert.deepEqual(s.getSnapshot().providers["p.com"].waiting, waitingBefore, c.label);
    assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "A", c.label);
    assert.equal(s.getJob("A").state, "running", c.label);
    assert.equal(topo.firefoxCalls.n, 0, c.label);
    assert.equal(
      s.onDrainingTransportResult("B", topo.bToken, c.result),
      false,
      c.label
    );
    assertSlotInvariant(s);
    assertPermitAndOwnerInvariants(s);
  });
});

test("14C cancel after pending completed + unavailable (before permit release) → cancelled", () => {
  var topo = setupABCPausingBWithPermit();
  var s = topo.s;
  var clearBefore = topo.clearB.n;

  assert.equal(s.onDrainingTransportResult("B", topo.bToken, completedResult()), true);
  assert.equal(s.onTransportUnavailable("B"), true);
  assert.equal(s.getJob("B").state, "pausing_provider");

  s.cancel("B");
  // Still non-quiescent (permit held): remain pausing until release.
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.equal(s.getJob("B").holdsGlobalSlot, true);

  topo.permit.release();
  assert.equal(s.getJob("B").state, "cancelled");
  assert.equal(s.getJob("B").holdsGlobalSlot, false);
  assert.equal(topo.clearB.n, clearBefore + 1);
  assert.equal(s.getSnapshot().providers["p.com"].waiting.indexOf("B"), -1);
  assert.equal(topo.firefoxCalls.n, 0);
  assert.equal(s.onDrainingTransportResult("B", topo.bToken, completedResult()), false);
  assertSlotInvariant(s);
});

test("14D unavailable with no pending terminal retains needs_user and invalidates old token", () => {
  var topo = setupABCPausingBWithPermit();
  var s = topo.s;
  var clearBefore = topo.clearB.n;
  var retriesBefore = s.getJob("B").retryRemaining;

  // No authenticated pending outcome — established disconnect park.
  assert.equal(s.onTransportUnavailable("B"), true);
  assert.equal(s.getJob("B").state, "needs_user");
  assert.equal(s.getJob("B").holdsGlobalSlot, false);
  assert.equal(s.getJob("B").nativeOpenConnections, 0);
  assert.equal(s.getJob("B").attemptToken, null);
  assert.equal(s.getJob("B").retryRemaining, retriesBefore);
  assert.equal(topo.clearB.n, clearBefore); // ephemeral retained
  // Old draining token inert after unavailable cleared private auth.
  assert.equal(s.onDrainingTransportResult("B", topo.bToken, completedResult()), false);
  assert.equal(s.getJob("B").state, "needs_user");
  assert.equal(s.onTransportUnavailable("B"), false);
  assert.equal(topo.firefoxCalls.n, 0);
  assertSlotInvariant(s);
});

// ---------------------------------------------------------------------------
// 15. failed + failureCategory cancelled terminalizes failed (not needs_user)
// ---------------------------------------------------------------------------

test("15A failed category cancelled with helper available → failed once; cancel wins", () => {
  // Helper available path: authenticated draining failed/cancelled → state failed.
  var topo = setupABCPausingB();
  var s = topo.s;
  var retriesBefore = s.getJob("B").retryRemaining;
  var usedBefore = s.getJob("B").retryUsed;
  var wakeBefore = s.getJob("B").autoWakeCount;
  var clearBefore = topo.clearB.n;
  var globalBefore = s.getSnapshot().globalRunning;

  assert.equal(
    s.onDrainingTransportResult("B", topo.bToken, failedResult("cancelled", "partial")),
    true
  );
  assert.equal(s.getJob("B").state, "failed");
  assert.equal(s.getJob("B").holdsGlobalSlot, false);
  assert.equal(s.getJob("B").nativeOpenConnections, 0);
  assert.equal(s.getJob("B").attemptToken, null);
  assert.equal(s.getJob("B").retryRemaining, retriesBefore);
  assert.equal(s.getJob("B").retryUsed, usedBefore);
  assert.equal(s.getJob("B").autoWakeCount, wakeBefore);
  assert.equal(topo.clearB.n, clearBefore + 1);
  assert.equal(s.getSnapshot().providers["p.com"].waiting.indexOf("B"), -1);
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "A");
  assert.equal(s.getJob("A").state, "running");
  assert.equal(s.getSnapshot().globalRunning, globalBefore - 1);
  // Replay inert; clear-once.
  assert.equal(
    s.onDrainingTransportResult("B", topo.bToken, failedResult("cancelled", "partial")),
    false
  );
  assert.equal(s.getJob("B").state, "failed");
  assert.equal(topo.clearB.n, clearBefore + 1);
  assert.equal(topo.firefoxCalls.n, 0);
  assertSlotInvariant(s);
  assertPermitAndOwnerInvariants(s);

  // User cancelRequested wins over failed/cancelled category → cancelled.
  var topo2 = setupABCPausingB();
  var s2 = topo2.s;
  s2.cancel("B");
  assert.equal(s2.getJob("B").state, "pausing_provider");
  assert.equal(
    s2.onDrainingTransportResult("B", topo2.bToken, failedResult("cancelled", "empty")),
    true
  );
  assert.equal(s2.getJob("B").state, "cancelled");
  assert.equal(s2.getJob("B").holdsGlobalSlot, false);
  assert.equal(topo2.clearB.n, 1);
  assert.equal(topo2.firefoxCalls.n, 0);
  assert.equal(
    s2.onDrainingTransportResult("B", topo2.bToken, failedResult("cancelled", "empty")),
    false
  );
  assertSlotInvariant(s2);
});

test("15B projection never leaks drainTransportUnavailable or draining private fields", () => {
  var topo = setupABCPausingBWithPermit();
  var s = topo.s;

  assertProjectionKeys(s.getJob("B"));
  assert.equal(s.onDrainingTransportResult("B", topo.bToken, completedResult()), true);
  assert.equal(s.getJob("B").state, "pausing_provider");
  assertProjectionKeys(s.getJob("B"));
  s.getSnapshot().jobs.forEach(assertProjectionKeys);

  assert.equal(s.onTransportUnavailable("B"), true);
  assert.equal(s.getJob("B").state, "pausing_provider");
  assertProjectionKeys(s.getJob("B"));
  s.getSnapshot().jobs.forEach(assertProjectionKeys);

  var json = JSON.stringify(s.getSnapshot());
  assert.equal(json.indexOf("drainingAttemptToken"), -1);
  assert.equal(json.indexOf("pendingDrainTerminal"), -1);
  assert.equal(json.indexOf("drainTransportUnavailable"), -1);

  topo.permit.release();
  assert.equal(s.getJob("B").state, "completed");
  assertProjectionKeys(s.getJob("B"));
  assert.equal(JSON.stringify(s.getSnapshot()).indexOf("drainTransportUnavailable"), -1);
  assert.equal(topo.firefoxCalls.n, 0);
});

test("15C unavailable with pending + noteNativeOpen throw-before retryable; mutate-then once", () => {
  const gatePath = path.resolve(__dirname, "..", "lib", "provider-gate.js");
  const schedPath = path.resolve(__dirname, "..", "lib", "download-scheduler.js");
  const realGate = require(gatePath);
  const prevGate = require.cache[require.resolve(gatePath)];
  const prevSched = require.cache[require.resolve(schedPath)];

  // --- throw before mutation during unavailable with pending completed ---
  try {
    let gateRef = null;
    let throwBefore = true;
    installHostileGate(realGate, gatePath, {
      onGate: function (g) {
        gateRef = g;
      },
      noteNativeOpen: function (g, jobId, n) {
        if (throwBefore && n === 0 && jobId === "B") {
          throw new Error("simulated unavailable throw before mutation");
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
    var permit = s.acquireProviderPermit("B", "segment");
    var bToken = s.getJob("B").attemptToken;
    s.onTransportResult("C", s.getJob("C").attemptToken, {
      status: "failed",
      failureCategory: "http_429",
    });
    // Accept pending while native still open — confirmNativeOpenZero uses noteNativeOpen(0).
    // Clear throw for the draining accept path, re-arm for unavailable.
    throwBefore = false;
    assert.equal(s.onDrainingTransportResult("B", bToken, completedResult()), true);
    assert.equal(s.getJob("B").state, "pausing_provider");
    assert.ok(s.getJob("B").inFlightPermits >= 1);
    // Re-open native so unavailable must call noteNativeOpen(0) again under fault.
    // (Job already has native 0 from accept; force gate+job positive to exercise fault.)
    throwBefore = false;
    s.noteNativeOpen("B", 1);
    assert.equal(s.getJob("B").nativeOpenConnections, 1);
    var gateOpenBefore = gateRef.snapshot().nativeOpen.B;
    var nativeBefore = s.getJob("B").nativeOpenConnections;

    throwBefore = true;
    var threw = false;
    try {
      s.onTransportUnavailable("B");
    } catch (e) {
      threw = true;
    }
    assert.equal(threw, true);
    // Throw-before: coherent and retryable — still pausing with pending preserved.
    assert.equal(s.getJob("B").state, "pausing_provider");
    assert.equal(s.getJob("B").holdsGlobalSlot, true);
    assert.equal(s.getJob("B").nativeOpenConnections, nativeBefore);
    assert.equal(gateRef.snapshot().nativeOpen.B, gateOpenBefore);

    throwBefore = false;
    assert.equal(s.onTransportUnavailable("B"), true);
    assert.equal(s.getJob("B").state, "pausing_provider");
    assert.equal(s.getJob("B").holdsGlobalSlot, true);
    assert.equal(s.getJob("B").nativeOpenConnections, 0);
    assert.equal(gateRef.snapshot().nativeOpen.B, 0);
    // Duplicate false.
    assert.equal(s.onTransportUnavailable("B"), false);

    permit.release();
    assert.equal(s.getJob("B").state, "completed");
    assert.equal(s.getJob("B").holdsGlobalSlot, false);
  } finally {
    restoreModuleCache(gatePath, schedPath, prevGate, prevSched);
  }

  // --- mutate then throw: unavailable settles the flag once ---
  const prevGate2 = require.cache[require.resolve(gatePath)];
  const prevSched2 = require.cache[require.resolve(schedPath)];
  try {
    let gateRef2 = null;
    let throwAfterZero = false;
    installHostileGate(realGate, gatePath, {
      onGate: function (g) {
        gateRef2 = g;
      },
      noteNativeOpen: function (g, jobId, n) {
        if (throwAfterZero && n === 0 && jobId === "B") {
          g.noteNativeOpen(jobId, n);
          throw new Error("simulated unavailable throw after mutation");
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
    var permit2 = s2.acquireProviderPermit("B", "segment");
    var bToken2 = s2.getJob("B").attemptToken;
    s2.onTransportResult("C", s2.getJob("C").attemptToken, {
      status: "failed",
      failureCategory: "http_429",
    });
    assert.equal(s2.onDrainingTransportResult("B", bToken2, completedResult()), true);
    s2.noteNativeOpen("B", 1);
    throwAfterZero = true;
    assert.equal(s2.onTransportUnavailable("B"), true);
    assert.equal(s2.getJob("B").state, "pausing_provider");
    assert.equal(s2.getJob("B").nativeOpenConnections, 0);
    assert.equal(gateRef2.snapshot().nativeOpen.B, 0);
    assert.equal(s2.onTransportUnavailable("B"), false);
    permit2.release();
    assert.equal(s2.getJob("B").state, "completed");
  } finally {
    restoreModuleCache(gatePath, schedPath, prevGate2, prevSched2);
  }
});

// ---------------------------------------------------------------------------
// 16. Cancel wins helper disconnect (fail-closed drain-token hold)
// ---------------------------------------------------------------------------

test("16A cancel after native zero with retained private auth: unavailable → cancelled once", () => {
  // Exact reported sequence: paused B keeps private drain auth after native zero;
  // cancel waits for semantic terminal; helper disconnect proves physical work gone
  // → cancelled (not needs_user), exact-once cleanup; late signals inert.
  var topo = setupABCPausingB();
  var s = topo.s;
  var clearBefore = topo.clearB.n;
  var retriesBefore = s.getJob("B").retryRemaining;
  var usedBefore = s.getJob("B").retryUsed;
  var wakeBefore = s.getJob("B").autoWakeCount;
  var verBefore = s.getJob("B").stateVersion;
  var globalBefore = s.getSnapshot().globalRunning;

  s.noteNativeOpen("B", 0);
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.equal(s.getJob("B").holdsGlobalSlot, true);
  assert.equal(s.getJob("B").nativeOpenConnections, 0);
  assert.equal(s.getJob("B").attemptToken, null);

  s.cancel("B");
  // Fail-closed hold: private auth still awaiting semantic terminal.
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.equal(s.getJob("B").holdsGlobalSlot, true);
  assert.equal(topo.clearB.n, clearBefore);

  assert.equal(s.onTransportUnavailable("B"), true);
  assert.equal(s.getJob("B").state, "cancelled");
  assert.equal(s.getJob("B").stateVersion, verBefore + 1);
  assert.equal(s.getJob("B").holdsGlobalSlot, false);
  assert.equal(s.getJob("B").nativeOpenConnections, 0);
  assert.equal(s.getJob("B").attemptToken, null);
  assert.equal(s.getJob("B").retryRemaining, retriesBefore);
  assert.equal(s.getJob("B").retryUsed, usedBefore);
  assert.equal(s.getJob("B").autoWakeCount, wakeBefore);
  assert.equal(topo.clearB.n, clearBefore + 1);
  assert.equal(s.getSnapshot().globalRunning, globalBefore - 1);
  assert.equal(s.getSnapshot().providers["p.com"].waiting.indexOf("B"), -1);
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "A");
  assert.equal(topo.firefoxCalls.n, 0);
  assertProjectionKeys(s.getJob("B"));
  assert.equal(JSON.stringify(s.getSnapshot()).indexOf("drainingAttemptToken"), -1);
  assert.equal(JSON.stringify(s.getSnapshot()).indexOf("pendingDrainTerminal"), -1);
  assert.equal(JSON.stringify(s.getSnapshot()).indexOf("drainTransportUnavailable"), -1);

  // Late / duplicate signals are inert after cancelled.
  assert.equal(s.onTransportUnavailable("B"), false);
  assert.equal(s.onDrainingTransportResult("B", topo.bToken, completedResult()), false);
  s.cancel("B");
  s.manualRetry("B");
  assert.equal(s.getJob("B").state, "cancelled");
  assert.equal(s.getJob("B").stateVersion, verBefore + 1);
  assert.equal(topo.clearB.n, clearBefore + 1);
  assert.equal(topo.firefoxCalls.n, 0);
  assertSlotInvariant(s);
  assertPermitAndOwnerInvariants(s);
});

test("16B running cancelRequested then helper unavailable → cancelled with exact-once cleanup", () => {
  var firefoxCalls = { n: 0 };
  var clearRun = { n: 0 };
  var s = createDownloadScheduler({
    maxConcurrent: 1,
    now: function () {
      return 0;
    },
    firefoxDownload: function () {
      firefoxCalls.n += 1;
    },
  });
  s.createJob({
    id: "run",
    providerKey: "a.com",
    intent: intent("run.mp4"),
    segmentConcurrency: 4,
    retries: 3,
    ephemeral: {
      clear: function () {
        clearRun.n += 1;
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
  s.noteNativeOpen("run", 2);
  var oldToken = s.getJob("run").attemptToken;
  var verBefore = s.getJob("run").stateVersion;
  var retriesBefore = s.getJob("run").retryRemaining;
  var usedBefore = s.getJob("run").retryUsed;
  var wakeBefore = s.getJob("run").autoWakeCount;
  var clearBefore = clearRun.n;

  s.cancel("run");
  assert.equal(s.getJob("run").state, "running");
  assert.equal(s.getJob("run").holdsGlobalSlot, true);
  assert.equal(s.getJob("run").attemptToken, oldToken);
  assert.equal(clearRun.n, clearBefore);

  assert.equal(s.onTransportUnavailable("run"), true);
  assert.equal(s.getJob("run").state, "cancelled");
  assert.equal(s.getJob("run").stateVersion, verBefore + 1);
  assert.equal(s.getJob("run").holdsGlobalSlot, false);
  assert.equal(s.getJob("run").nativeOpenConnections, 0);
  assert.equal(s.getJob("run").attemptToken, null);
  assert.equal(s.getJob("run").retryRemaining, retriesBefore);
  assert.equal(s.getJob("run").retryUsed, usedBefore);
  assert.equal(s.getJob("run").autoWakeCount, wakeBefore);
  assert.equal(clearRun.n, clearBefore + 1);
  // Independent provider fills released global capacity.
  assert.equal(s.getJob("peer").state, "running");
  assert.equal(firefoxCalls.n, 0);
  assertProjectionKeys(s.getJob("run"));

  assert.equal(s.onTransportUnavailable("run"), false);
  s.onTransportResult("run", oldToken, { status: "completed", failureCategory: null });
  s.cancel("run");
  s.manualRetry("run");
  assert.equal(s.getJob("run").state, "cancelled");
  assert.equal(s.getJob("run").stateVersion, verBefore + 1);
  assert.equal(clearRun.n, clearBefore + 1);
  assert.equal(firefoxCalls.n, 0);
  assertSlotInvariant(s);
  assertPermitAndOwnerInvariants(s);
});

test("16C cancelled saturated owner on unavailable releases ownership without waking same-provider waiter", () => {
  var firefoxCalls = { n: 0 };
  var clearOwner = { n: 0 };
  var s = createDownloadScheduler({
    maxConcurrent: 2,
    now: function () {
      return 0;
    },
    firefoxDownload: function () {
      firefoxCalls.n += 1;
    },
  });
  s.createJob({
    id: "owner",
    providerKey: "p.com",
    intent: intent("o.mp4"),
    segmentConcurrency: 4,
    retries: 3,
    ephemeral: {
      clear: function () {
        clearOwner.n += 1;
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
  s.createJob({
    id: "peer",
    providerKey: "other.com",
    intent: intent("peer.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.enqueue("owner");
  s.enqueue("wait");
  s.enqueue("peer");
  s.notePermitAcquired("owner");
  s.noteNativeOpen("owner", 1);
  s.onTransportResult("wait", s.getJob("wait").attemptToken, {
    status: "failed",
    failureCategory: "http_429",
  });
  if (s.getJob("wait").state === "pausing_provider") {
    s.noteNativeOpen("wait", 0);
    if (s.getJob("wait").state === "pausing_provider") {
      s.onQuiesced("wait");
    }
  }
  assert.equal(s.getJob("wait").state, "waiting_provider");
  assert.equal(s.getSnapshot().providers["p.com"].gate.state, "saturated");
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "owner");
  assert.equal(s.getJob("owner").state, "running");
  // Peer may be running (global cap 2) or still queued if wait held capacity until park.
  var waitWakeBefore = s.getJob("wait").autoWakeCount;
  var waitRetriesBefore = s.getJob("wait").retryRemaining;
  var ownerRetriesBefore = s.getJob("owner").retryRemaining;
  var ownerUsedBefore = s.getJob("owner").retryUsed;
  var verBefore = s.getJob("owner").stateVersion;
  var clearBefore = clearOwner.n;

  s.cancel("owner");
  assert.equal(s.getJob("owner").state, "running");
  assert.equal(s.getSnapshot().providers["p.com"].gate.ownerJobId, "owner");

  assert.equal(s.onTransportUnavailable("owner"), true);
  assert.equal(s.getJob("owner").state, "cancelled");
  assert.equal(s.getJob("owner").stateVersion, verBefore + 1);
  assert.equal(s.getJob("owner").holdsGlobalSlot, false);
  assert.equal(s.getJob("owner").attemptToken, null);
  assert.equal(s.getJob("owner").retryRemaining, ownerRetriesBefore);
  assert.equal(s.getJob("owner").retryUsed, ownerUsedBefore);
  assert.equal(clearOwner.n, clearBefore + 1);
  var gate = s.getSnapshot().providers["p.com"].gate;
  assert.notEqual(gate.ownerJobId, "owner");
  assert.equal(gate.ownerJobId, null);
  // Same-provider waiter stays parked (not woken / not authorized).
  assert.equal(s.getJob("wait").state, "waiting_provider");
  assert.equal(s.getJob("wait").autoWakeCount, waitWakeBefore);
  assert.equal(s.getJob("wait").retryRemaining, waitRetriesBefore);
  assert.ok(s.getSnapshot().providers["p.com"].waiting.indexOf("wait") !== -1);
  // Independent provider may fill released global capacity.
  assert.equal(s.getJob("peer").state, "running");
  assert.equal(firefoxCalls.n, 0);
  assert.equal(s.onTransportUnavailable("owner"), false);
  s.manualRetry("owner");
  assert.equal(s.getJob("owner").state, "cancelled");
  assert.equal(clearOwner.n, clearBefore + 1);
  assertSlotInvariant(s);
  assertPermitAndOwnerInvariants(s);
});

test("16D cancel+unavailable gate faults: noteNativeOpen and completeOwner throw-before/mutate-then", () => {
  const gatePath = path.resolve(__dirname, "..", "lib", "provider-gate.js");
  const schedPath = path.resolve(__dirname, "..", "lib", "download-scheduler.js");
  const realGate = require(gatePath);

  // --- noteNativeOpen throw-before on cancelRequested pausing job ---
  const prevGate = require.cache[require.resolve(gatePath)];
  const prevSched = require.cache[require.resolve(schedPath)];
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
      ephemeral: {
        clear: function () {},
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
    s.noteNativeOpen("C", 1);
    s.onTransportResult("C", s.getJob("C").attemptToken, {
      status: "failed",
      failureCategory: "http_429",
    });
    assert.equal(s.getJob("B").state, "pausing_provider");
    s.cancel("B");
    assert.equal(s.getJob("B").state, "pausing_provider");
    var nativeBefore = s.getJob("B").nativeOpenConnections;
    var gateOpenBefore = gateRef.snapshot().nativeOpen.B;
    var verBefore = s.getJob("B").stateVersion;

    var threw = false;
    try {
      s.onTransportUnavailable("B");
    } catch (e) {
      threw = true;
    }
    assert.equal(threw, true);
    // Throw-before: prior coherent state preserved and retryable.
    assert.equal(s.getJob("B").state, "pausing_provider");
    assert.equal(s.getJob("B").holdsGlobalSlot, true);
    assert.equal(s.getJob("B").nativeOpenConnections, nativeBefore);
    assert.equal(gateRef.snapshot().nativeOpen.B, gateOpenBefore);
    assert.equal(s.getJob("B").stateVersion, verBefore);

    throwBefore = false;
    assert.equal(s.onTransportUnavailable("B"), true);
    assert.equal(s.getJob("B").state, "cancelled");
    assert.equal(s.getJob("B").stateVersion, verBefore + 1);
    assert.equal(s.getJob("B").holdsGlobalSlot, false);
    assert.equal(s.getJob("B").nativeOpenConnections, 0);
    assert.equal(gateRef.snapshot().nativeOpen.B, 0);
    assert.equal(s.onTransportUnavailable("B"), false);
  } finally {
    restoreModuleCache(gatePath, schedPath, prevGate, prevSched);
  }

  // --- noteNativeOpen mutate-then-throw continues once to cancelled ---
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
    s2.onTransportResult("C", s2.getJob("C").attemptToken, {
      status: "failed",
      failureCategory: "http_429",
    });
    s2.cancel("B");
    var verBefore2 = s2.getJob("B").stateVersion;
    assert.equal(s2.onTransportUnavailable("B"), true);
    assert.equal(s2.getJob("B").state, "cancelled");
    assert.equal(s2.getJob("B").stateVersion, verBefore2 + 1);
    assert.equal(s2.getJob("B").nativeOpenConnections, 0);
    assert.equal(gateRef2.snapshot().nativeOpen.B, 0);
    assert.equal(s2.onTransportUnavailable("B"), false);
  } finally {
    restoreModuleCache(gatePath, schedPath, prevGate2, prevSched2);
  }

  // --- completeOwner throw-before: must not terminalize while still owner ---
  const prevGate3 = require.cache[require.resolve(gatePath)];
  const prevSched3 = require.cache[require.resolve(schedPath)];
  try {
    let throwBeforeOwner = true;
    installHostileGate(realGate, gatePath, {
      completeOwner: function (g, args) {
        if (throwBeforeOwner) {
          throw new Error("simulated completeOwner throw before mutation");
        }
        return g.completeOwner(args);
      },
    });
    const createS3 = loadSchedulerFresh(schedPath);
    const s3 = createS3({
      maxConcurrent: 2,
      now: function () {
        return 0;
      },
      firefoxDownload: function () {},
    });
    s3.createJob({
      id: "owner",
      providerKey: "p.com",
      intent: intent("o.mp4"),
      segmentConcurrency: 4,
      retries: 3,
    });
    s3.createJob({
      id: "wait",
      providerKey: "p.com",
      intent: intent("w.mp4"),
      segmentConcurrency: 4,
      retries: 3,
    });
    s3.enqueue("owner");
    s3.enqueue("wait");
    s3.notePermitAcquired("owner");
    s3.noteNativeOpen("owner", 1);
    s3.onTransportResult("wait", s3.getJob("wait").attemptToken, {
      status: "failed",
      failureCategory: "http_429",
    });
    if (s3.getJob("wait").state === "pausing_provider") {
      s3.noteNativeOpen("wait", 0);
      if (s3.getJob("wait").state === "pausing_provider") {
        s3.onQuiesced("wait");
      }
    }
    assert.equal(s3.getJob("wait").state, "waiting_provider");
    assert.equal(s3.getSnapshot().providers["p.com"].gate.ownerJobId, "owner");
    s3.cancel("owner");
    var verBefore3 = s3.getJob("owner").stateVersion;
    var waitWakeBefore = s3.getJob("wait").autoWakeCount;

    var outcome = null;
    try {
      outcome = s3.onTransportUnavailable("owner");
    } catch (e) {
      outcome = e;
    }
    // Must not terminalize while gate still names this owner.
    assert.equal(s3.getJob("owner").state, "running");
    assert.equal(s3.getJob("owner").stateVersion, verBefore3);
    assert.equal(s3.getSnapshot().providers["p.com"].gate.ownerJobId, "owner");
    assert.ok(outcome === false || outcome instanceof Error);
    assert.equal(s3.getJob("wait").state, "waiting_provider");
    assert.equal(s3.getJob("wait").autoWakeCount, waitWakeBefore);

    throwBeforeOwner = false;
    assert.equal(s3.onTransportUnavailable("owner"), true);
    assert.equal(s3.getJob("owner").state, "cancelled");
    assert.equal(s3.getJob("owner").stateVersion, verBefore3 + 1);
    assert.notEqual(s3.getSnapshot().providers["p.com"].gate.ownerJobId, "owner");
    assert.equal(s3.getJob("wait").state, "waiting_provider");
    assert.equal(s3.getJob("wait").autoWakeCount, waitWakeBefore);
    assert.equal(s3.onTransportUnavailable("owner"), false);
  } finally {
    restoreModuleCache(gatePath, schedPath, prevGate3, prevSched3);
  }

  // --- completeOwner mutate-then-throw: terminalize cancelled once after advancement ---
  const prevGate4 = require.cache[require.resolve(gatePath)];
  const prevSched4 = require.cache[require.resolve(schedPath)];
  try {
    installHostileGate(realGate, gatePath, {
      completeOwner: function (g, args) {
        const result = g.completeOwner(args);
        throw new Error("simulated completeOwner throw after advance");
      },
    });
    const createS4 = loadSchedulerFresh(schedPath);
    const s4 = createS4({
      maxConcurrent: 2,
      now: function () {
        return 0;
      },
      firefoxDownload: function () {},
    });
    s4.createJob({
      id: "owner",
      providerKey: "p.com",
      intent: intent("o.mp4"),
      segmentConcurrency: 4,
      retries: 3,
    });
    s4.createJob({
      id: "wait",
      providerKey: "p.com",
      intent: intent("w.mp4"),
      segmentConcurrency: 4,
      retries: 3,
    });
    s4.enqueue("owner");
    s4.enqueue("wait");
    s4.notePermitAcquired("owner");
    s4.noteNativeOpen("owner", 1);
    s4.onTransportResult("wait", s4.getJob("wait").attemptToken, {
      status: "failed",
      failureCategory: "http_429",
    });
    if (s4.getJob("wait").state === "pausing_provider") {
      s4.noteNativeOpen("wait", 0);
      if (s4.getJob("wait").state === "pausing_provider") {
        s4.onQuiesced("wait");
      }
    }
    assert.equal(s4.getJob("wait").state, "waiting_provider");
    s4.cancel("owner");
    var verBefore4 = s4.getJob("owner").stateVersion;
    var waitWakeBefore4 = s4.getJob("wait").autoWakeCount;

    assert.equal(s4.onTransportUnavailable("owner"), true);
    assert.equal(s4.getJob("owner").state, "cancelled");
    assert.equal(s4.getJob("owner").stateVersion, verBefore4 + 1);
    assert.equal(s4.getJob("owner").holdsGlobalSlot, false);
    assert.notEqual(s4.getSnapshot().providers["p.com"].gate.ownerJobId, "owner");
    assert.equal(s4.getJob("wait").state, "waiting_provider");
    assert.equal(s4.getJob("wait").autoWakeCount, waitWakeBefore4);
    assert.equal(s4.onTransportUnavailable("owner"), false);
  } finally {
    restoreModuleCache(gatePath, schedPath, prevGate4, prevSched4);
  }
});

test("16E control: no cancel still needs_user; pending completed + unavailable still completes", () => {
  // Control: established no-cancel unavailable parks needs_user and retains ephemeral.
  var topo = setupABCPausingB();
  var s = topo.s;
  var clearBefore = topo.clearB.n;
  s.noteNativeOpen("B", 0);
  assert.equal(s.getJob("B").state, "pausing_provider");
  assert.equal(s.onTransportUnavailable("B"), true);
  assert.equal(s.getJob("B").state, "needs_user");
  assert.equal(s.getJob("B").holdsGlobalSlot, false);
  assert.equal(topo.clearB.n, clearBefore); // ephemeral retained
  assert.equal(s.onDrainingTransportResult("B", topo.bToken, completedResult()), false);
  assert.equal(s.getJob("B").state, "needs_user");
  assert.equal(topo.firefoxCalls.n, 0);
  s.manualRetry("B");
  assert.equal(s.getJob("B").state, "queued");
  assertSlotInvariant(s);

  // Pending authenticated completion + unavailable still completes after permit release.
  var topo2 = setupABCPausingBWithPermit();
  var s2 = topo2.s;
  var clearBefore2 = topo2.clearB.n;
  assert.equal(s2.onDrainingTransportResult("B", topo2.bToken, completedResult()), true);
  assert.equal(s2.onTransportUnavailable("B"), true);
  assert.equal(s2.getJob("B").state, "pausing_provider");
  topo2.permit.release();
  assert.equal(s2.getJob("B").state, "completed");
  assert.equal(topo2.clearB.n, clearBefore2 + 1);
  assert.equal(topo2.firefoxCalls.n, 0);
  assert.equal(s2.onDrainingTransportResult("B", topo2.bToken, completedResult()), false);
  assertSlotInvariant(s2);
  assertPermitAndOwnerInvariants(s2);
});
