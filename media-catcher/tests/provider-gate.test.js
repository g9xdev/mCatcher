"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const { loadLib, mediaCatcherRoot } = require("./harness/load-lib.js");
const { createProviderGate } = loadLib("lib/provider-gate.js");

/**
 * McProviderGate API surface for Task 10 scheduler integration
 * ------------------------------------------------------------
 * createProviderGate({ providerKey }) -> gate
 *
 * Read-only observables (getters):
 *   gate.providerKey, gate.state ("normal"|"saturated"|"recovering"),
 *   gate.generation, gate.wakeGeneration
 *
 * Methods:
 *   acquire(jobId, { maxForJob, isProviderOwner|isDrainOwner, isRunningJob, purpose })
 *     -> permit | null
 *     permit: frozen { jobId, purpose, generation, release() }  // release is idempotent
 *     isProviderOwner === true is the neutral owner flag; isDrainOwner is a compatibility alias.
 *     Owner id match + isRunningJob remain mandatory in saturated/recovering.
 *   setSaturated({ drainOwnerJobId, reducedConcurrency })
 *     -> bumps generation once, state=saturated, invalidates current-generation issuance counters
 *        but keeps physical outstanding permits until each release()
 *   registerJobLimit(jobId, maxConnections)
 *     -> normal-state native lease registration (positive finite integer; never Infinity/NaN)
 *   nativeLeaseFor(jobId)
 *     -> { jobId, providerGeneration, maxConnections }; jobId must be nonblank string
 *   noteNativeOpen(jobId, n)
 *     -> tracks nonnegative finite open count; does NOT invent a permit
 *     cleared on provider generation transitions
 *   parkProbe(probeId)
 *     -> idempotent parking while saturated/recovering; probes stay parked until
 *        authenticated recoverToNormal
 *   completeOwner({ jobId, recoveryOwnerJobId })
 *     -> ownership-event idempotent terminal of the *current* owner epoch.
 *        Advances wakeGeneration only when state is saturated|recovering, jobId exactly
 *        equals the current owner, and that ownership epoch has not already terminalized.
 *        Does NOT drain parked probes. Distinct nonblank recoveryOwnerJobId (≠ jobId)
 *        installs a fresh owner epoch; same id or blank leaves recovering blocked.
 *        Returns frozen { advanced, wakeGeneration, parkedProbeIds: [] }
 *   designateRecoveryOwner({ recoveryOwnerJobId })
 *     -> when recovering with no owner (blocked), install a fresh recovery owner epoch.
 *        Returns frozen { applied, ownerJobId }
 *   recoverToNormal({ jobId })
 *     -> successful recovery: authenticates current recovery owner, bumps generation,
 *        state=normal, drains parked probes once in sorted order.
 *        Stale/wrong completions are frozen no-ops that do not drain probes.
 *        Returns frozen { advanced, generation, parkedProbeIds }
 *   snapshot()
 *     -> deep-frozen deterministic projection
 *
 * Denied acquire (not running, at cap, non-owner, etc.) returns null — does not throw.
 * Invalid ids / concurrency values throw.
 *
 * Physical outstanding permits are tracked separately from current-generation issuance.
 * acquire enforces its effective cap against physical outstanding (including stale-generation
 * permits still held). Stale release decrements only physical outstanding; current release
 * decrements both. No persistence; session memory only.
 */

function gate(key) {
  return createProviderGate({ providerKey: key || "florenfile.com" });
}

function running(opts) {
  return Object.assign(
    { maxForJob: 2, isDrainOwner: false, isRunningJob: true, purpose: "segment" },
    opts || {}
  );
}

function ownerOpts(opts) {
  return running(Object.assign({ isProviderOwner: true, isDrainOwner: true }, opts || {}));
}

// ---------------------------------------------------------------------------
// Core brief scenarios
// ---------------------------------------------------------------------------

test("running job acquires up to effective concurrency; non-running denied", () => {
  const g = gate();
  const p = g.acquire("j1", running({ maxForJob: 2 }));
  assert.ok(p);
  assert.equal(p.jobId, "j1");
  assert.equal(p.purpose, "segment");
  assert.equal(typeof p.generation, "number");
  assert.equal(typeof p.release, "function");
  assert.equal(
    g.acquire("j2", running({ isRunningJob: false, maxForJob: 2 })),
    null
  );
  p.release();
});

test("saturated: only drain owner gets permits; others zero native lease", () => {
  // Mutation: still issuing permits to non-owners.
  const g = gate();
  g.setSaturated({ drainOwnerJobId: "owner", reducedConcurrency: 1 });
  assert.ok(g.acquire("owner", ownerOpts({ maxForJob: 1 })));
  assert.equal(
    g.acquire("other", running({ maxForJob: 4, isDrainOwner: false })),
    null
  );
  assert.equal(g.nativeLeaseFor("other").maxConnections, 0);
  assert.equal(g.nativeLeaseFor("owner").maxConnections, 1);
});

// ---------------------------------------------------------------------------
// Initial state / observables
// ---------------------------------------------------------------------------

test("starts normal with stable numeric generations and providerKey", () => {
  const g = gate("florenfile.com");
  assert.equal(g.providerKey, "florenfile.com");
  assert.equal(g.state, "normal");
  assert.equal(typeof g.generation, "number");
  assert.equal(typeof g.wakeGeneration, "number");
  assert.ok(Number.isFinite(g.generation));
  assert.ok(Number.isFinite(g.wakeGeneration));
  const gen0 = g.generation;
  const wake0 = g.wakeGeneration;
  // Observables are stable until mutation.
  assert.equal(g.generation, gen0);
  assert.equal(g.wakeGeneration, wake0);
  assert.equal(g.state, "normal");
});

// ---------------------------------------------------------------------------
// Concurrency cap / double release
// ---------------------------------------------------------------------------

test("enforces per-job maxForJob across simultaneous permits", () => {
  // Mutation: ignore maxForJob and issue unlimited permits.
  const g = gate();
  const p1 = g.acquire("j1", running({ maxForJob: 2 }));
  const p2 = g.acquire("j1", running({ maxForJob: 2 }));
  const p3 = g.acquire("j1", running({ maxForJob: 2 }));
  assert.ok(p1);
  assert.ok(p2);
  assert.equal(p3, null);
  p1.release();
  const p4 = g.acquire("j1", running({ maxForJob: 2 }));
  assert.ok(p4);
  p2.release();
  p4.release();
});

test("double release is idempotent and does not free extra slots", () => {
  // Mutation: each release() decrements again, overshooting the counter.
  const g = gate();
  const p1 = g.acquire("j1", running({ maxForJob: 1 }));
  assert.ok(p1);
  p1.release();
  p1.release();
  p1.release();
  const p2 = g.acquire("j1", running({ maxForJob: 1 }));
  assert.ok(p2);
  assert.equal(g.acquire("j1", running({ maxForJob: 1 })), null);
  p2.release();
});

// ---------------------------------------------------------------------------
// setSaturated / generation / stale permits / physical outstanding
// ---------------------------------------------------------------------------

test("setSaturated increments generation once, switches state, validates inputs", () => {
  const g = gate();
  const gen0 = g.generation;
  g.setSaturated({ drainOwnerJobId: "owner", reducedConcurrency: 2 });
  assert.equal(g.state, "saturated");
  assert.equal(g.generation, gen0 + 1);
  const gen1 = g.generation;
  g.setSaturated({ drainOwnerJobId: "owner2", reducedConcurrency: 1 });
  assert.equal(g.state, "saturated");
  assert.equal(g.generation, gen1 + 1);

  assert.throws(() => g.setSaturated({ drainOwnerJobId: "", reducedConcurrency: 1 }));
  assert.throws(() => g.setSaturated({ drainOwnerJobId: "  ", reducedConcurrency: 1 }));
  assert.throws(() => g.setSaturated({ drainOwnerJobId: "x", reducedConcurrency: 0 }));
  assert.throws(() => g.setSaturated({ drainOwnerJobId: "x", reducedConcurrency: -1 }));
  assert.throws(() => g.setSaturated({ drainOwnerJobId: "x", reducedConcurrency: 1.5 }));
  assert.throws(() => g.setSaturated({ drainOwnerJobId: "x", reducedConcurrency: Infinity }));
  assert.throws(() => g.setSaturated({ drainOwnerJobId: "x", reducedConcurrency: NaN }));
});

test("stale permit release after generation bump does not corrupt current counters", () => {
  // Mutation: old permit.release() decrements the new generation's counter.
  // Owner starts with no physical outstanding; reduced cap applies cleanly.
  const g = gate();
  const old = g.acquire("j1", running({ maxForJob: 2 }));
  assert.ok(old);
  const genBefore = old.generation;
  g.setSaturated({ drainOwnerJobId: "owner", reducedConcurrency: 1 });
  assert.notEqual(g.generation, genBefore);
  old.release();
  old.release();

  // Owner can still acquire up to reduced cap in the new generation.
  const p1 = g.acquire("owner", ownerOpts({ maxForJob: 2 }));
  assert.ok(p1);
  assert.equal(p1.generation, g.generation);
  const p2 = g.acquire("owner", ownerOpts({ maxForJob: 2 }));
  // reducedConcurrency=1 so second permit denied
  assert.equal(p2, null);
  p1.release();
  const p3 = g.acquire("owner", ownerOpts({ maxForJob: 2 }));
  assert.ok(p3);
  p3.release();
});

test("owner physical outstanding from old generation blocks new issuance after setSaturated", () => {
  // Mutation: clearing current-generation counters hides still-live old browser connections.
  const g = gate();
  const old1 = g.acquire("owner", running({ maxForJob: 2 }));
  const old2 = g.acquire("owner", running({ maxForJob: 2 }));
  assert.ok(old1);
  assert.ok(old2);

  g.setSaturated({ drainOwnerJobId: "owner", reducedConcurrency: 1 });

  // Two physical permits still live; reduced cap is 1 → no replacement until enough releases.
  assert.equal(g.acquire("owner", ownerOpts({ maxForJob: 2 })), null);

  // Non-owner remains denied even if owner is blocked by physical outstanding.
  assert.equal(
    g.acquire("other", running({ maxForJob: 4, isDrainOwner: true, isProviderOwner: true })),
    null
  );

  // One stale release: physical drops to 1, still at reduced cap → still blocked.
  old1.release();
  assert.equal(g.acquire("owner", ownerOpts({ maxForJob: 2 })), null);

  // Second stale release: physical 0 → owner may take one current-generation permit.
  old2.release();
  const fresh = g.acquire("owner", ownerOpts({ maxForJob: 2 }));
  assert.ok(fresh);
  assert.equal(fresh.generation, g.generation);
  assert.equal(g.acquire("owner", ownerOpts({ maxForJob: 2 })), null);
  fresh.release();
});

test("stale release decrements only physical outstanding; never corrupts current issuance", () => {
  // Mutation: stale release also decrements current-generation counter → extra free slots.
  const g = gate();
  const old1 = g.acquire("owner", running({ maxForJob: 3 }));
  const old2 = g.acquire("owner", running({ maxForJob: 3 }));
  assert.ok(old1 && old2);

  g.setSaturated({ drainOwnerJobId: "owner", reducedConcurrency: 2 });
  // physical=2, cap=2 → at cap
  assert.equal(g.acquire("owner", ownerOpts({ maxForJob: 3 })), null);

  // Free one physical slot via stale release, then take one current-gen permit.
  old1.release();
  const current = g.acquire("owner", ownerOpts({ maxForJob: 3 }));
  assert.ok(current);
  assert.equal(current.generation, g.generation);
  // physical=2 (1 stale + 1 current), at cap
  assert.equal(g.acquire("owner", ownerOpts({ maxForJob: 3 })), null);

  // Remaining stale release must NOT free an extra current-generation slot.
  old2.release();
  // physical should now be 1 (current only); cap=2 → exactly one more allowed
  const extra = g.acquire("owner", ownerOpts({ maxForJob: 3 }));
  assert.ok(extra);
  assert.equal(g.acquire("owner", ownerOpts({ maxForJob: 3 })), null);

  // Double-release of already-released stale is still idempotent.
  old1.release();
  old2.release();
  assert.equal(g.acquire("owner", ownerOpts({ maxForJob: 3 })), null);

  current.release();
  extra.release();
});

test("saturated/recovering cap owner at min(maxForJob, reducedConcurrency); non-owner and non-running denied", () => {
  const g = gate();
  g.setSaturated({ drainOwnerJobId: "owner", reducedConcurrency: 2 });

  // Owner must be provider/drain owner AND running.
  assert.equal(
    g.acquire("owner", running({ maxForJob: 4, isDrainOwner: false, isProviderOwner: false })),
    null
  );
  assert.equal(
    g.acquire("owner", ownerOpts({ maxForJob: 4, isRunningJob: false })),
    null
  );

  // Cap = min(4, 2) = 2
  const a = g.acquire("owner", ownerOpts({ maxForJob: 4 }));
  const b = g.acquire("owner", ownerOpts({ maxForJob: 4 }));
  const c = g.acquire("owner", ownerOpts({ maxForJob: 4 }));
  assert.ok(a);
  assert.ok(b);
  assert.equal(c, null);

  // Cap = min(1, 2) = 1 when maxForJob is tighter
  a.release();
  b.release();
  const d = g.acquire("owner", ownerOpts({ maxForJob: 1 }));
  assert.ok(d);
  assert.equal(g.acquire("owner", ownerOpts({ maxForJob: 1 })), null);
  d.release();
});

test("isProviderOwner is accepted; isDrainOwner remains compatibility alias", () => {
  const g = gate();
  g.setSaturated({ drainOwnerJobId: "owner", reducedConcurrency: 1 });

  // Neutral flag alone is enough.
  const p1 = g.acquire(
    "owner",
    running({ maxForJob: 1, isProviderOwner: true, isDrainOwner: false })
  );
  assert.ok(p1);
  p1.release();

  // Compatibility alias alone is enough.
  const p2 = g.acquire(
    "owner",
    running({ maxForJob: 1, isProviderOwner: false, isDrainOwner: true })
  );
  assert.ok(p2);
  p2.release();

  // Neither flag → denied even with matching owner id and running.
  assert.equal(
    g.acquire(
      "owner",
      running({ maxForJob: 1, isProviderOwner: false, isDrainOwner: false })
    ),
    null
  );
});

// ---------------------------------------------------------------------------
// Native leases / registerJobLimit / noteNativeOpen
// ---------------------------------------------------------------------------

test("registerJobLimit gives normal-state native jobs a finite lease; never Infinity/NaN", () => {
  // Documented path for Task 10: native direct jobs call registerJobLimit before lease reads.
  const g = gate();
  assert.deepEqual(g.nativeLeaseFor("job-a"), {
    jobId: "job-a",
    providerGeneration: g.generation,
    maxConnections: 0,
  });

  g.registerJobLimit("job-a", 4);
  const lease = g.nativeLeaseFor("job-a");
  assert.deepEqual(lease, {
    jobId: "job-a",
    providerGeneration: g.generation,
    maxConnections: 4,
  });
  assert.ok(Number.isFinite(lease.maxConnections));
  assert.notEqual(lease.maxConnections, Infinity);
  assert.ok(!Number.isNaN(lease.maxConnections));

  assert.throws(() => g.registerJobLimit("job-a", 0));
  assert.throws(() => g.registerJobLimit("job-a", -1));
  assert.throws(() => g.registerJobLimit("job-a", 1.5));
  assert.throws(() => g.registerJobLimit("job-a", Infinity));
  assert.throws(() => g.registerJobLimit("job-a", NaN));
  assert.throws(() => g.registerJobLimit("", 2));
  assert.throws(() => g.registerJobLimit("  ", 2));
});

test("nativeLeaseFor shape is exact; owner/non-owner leases in saturated and recovering", () => {
  const g = gate();
  g.registerJobLimit("owner", 8);
  g.registerJobLimit("other", 8);

  g.setSaturated({ drainOwnerJobId: "owner", reducedConcurrency: 2 });
  assert.deepEqual(g.nativeLeaseFor("owner"), {
    jobId: "owner",
    providerGeneration: g.generation,
    maxConnections: 2,
  });
  assert.deepEqual(g.nativeLeaseFor("other"), {
    jobId: "other",
    providerGeneration: g.generation,
    maxConnections: 0,
  });

  const wake = g.completeOwner({ jobId: "owner", recoveryOwnerJobId: "recover" });
  assert.equal(wake.advanced, true);
  assert.equal(g.state, "recovering");
  assert.deepEqual(g.nativeLeaseFor("recover"), {
    jobId: "recover",
    providerGeneration: g.generation,
    maxConnections: 2,
  });
  assert.deepEqual(g.nativeLeaseFor("owner"), {
    jobId: "owner",
    providerGeneration: g.generation,
    maxConnections: 0,
  });
  assert.deepEqual(g.nativeLeaseFor("other"), {
    jobId: "other",
    providerGeneration: g.generation,
    maxConnections: 0,
  });
});

test("nativeLeaseFor rejects malformed job ids instead of stringifying them", () => {
  const g = gate();
  assert.throws(() => g.nativeLeaseFor(""));
  assert.throws(() => g.nativeLeaseFor("  "));
  assert.throws(() => g.nativeLeaseFor(null));
  assert.throws(() => g.nativeLeaseFor(undefined));
  assert.throws(() => g.nativeLeaseFor(42));
});

test("noteNativeOpen tracks nonnegative finite count without inventing a permit", () => {
  const g = gate();
  g.noteNativeOpen("j1", 0);
  g.noteNativeOpen("j1", 3);
  assert.equal(g.snapshot().nativeOpen.j1, 3);
  // Does not create browser permits / does not allow acquire without running.
  assert.equal(g.acquire("j1", running({ isRunningJob: false })), null);
  assert.throws(() => g.noteNativeOpen("j1", -1));
  assert.throws(() => g.noteNativeOpen("j1", 1.5));
  assert.throws(() => g.noteNativeOpen("j1", Infinity));
  assert.throws(() => g.noteNativeOpen("j1", NaN));
  assert.throws(() => g.noteNativeOpen("", 1));
});

test("nativeOpen diagnostic observations clear on provider generation transitions", () => {
  // Mutation: snapshot still reports pre-saturation opens as current after generation bump.
  const g = gate();
  g.noteNativeOpen("j1", 3);
  assert.equal(g.snapshot().nativeOpen.j1, 3);

  g.setSaturated({ drainOwnerJobId: "owner", reducedConcurrency: 1 });
  assert.equal(g.snapshot().nativeOpen.j1, undefined);
  assert.deepEqual(g.snapshot().nativeOpen, {});

  g.noteNativeOpen("owner", 1);
  assert.equal(g.snapshot().nativeOpen.owner, 1);

  g.completeOwner({ jobId: "owner", recoveryOwnerJobId: "recover" });
  // completeOwner does not bump provider generation → observation may remain for same gen.
  assert.equal(g.snapshot().nativeOpen.owner, 1);

  g.recoverToNormal({ jobId: "recover" });
  assert.deepEqual(g.snapshot().nativeOpen, {});
});

// ---------------------------------------------------------------------------
// parkProbe / completeOwner ownership epochs / recovery chain
// ---------------------------------------------------------------------------

test("parkProbe is idempotent; probes stay parked across completeOwner until recoverToNormal", () => {
  const g = gate();
  g.setSaturated({ drainOwnerJobId: "owner", reducedConcurrency: 1 });
  g.parkProbe("probe-a");
  g.parkProbe("probe-a");
  g.parkProbe("probe-b");
  assert.deepEqual(g.snapshot().parkedProbeIds, ["probe-a", "probe-b"]);

  // Parked probes cannot acquire permits.
  assert.equal(g.acquire("probe-a", running({ purpose: "probe" })), null);

  const wake0 = g.wakeGeneration;
  const first = g.completeOwner({ jobId: "owner", recoveryOwnerJobId: "next" });
  assert.equal(first.advanced, true);
  assert.equal(first.wakeGeneration, wake0 + 1);
  // completeOwner must not drain/expose parked probes.
  assert.deepEqual(first.parkedProbeIds, []);
  assert.equal(g.wakeGeneration, wake0 + 1);
  assert.equal(g.state, "recovering");
  assert.deepEqual(g.snapshot().parkedProbeIds, ["probe-a", "probe-b"]);

  // Probes parked during recovering are not silently lost.
  g.parkProbe("probe-c");
  assert.deepEqual(g.snapshot().parkedProbeIds, ["probe-a", "probe-b", "probe-c"]);

  // Recovery owner can acquire; others cannot.
  assert.ok(g.acquire("next", ownerOpts({ maxForJob: 1 })));
  assert.equal(g.acquire("owner", ownerOpts({ maxForJob: 1 })), null);

  // Authenticated recovery drains probes once in deterministic order.
  const reset = g.recoverToNormal({ jobId: "next" });
  assert.equal(reset.advanced, true);
  assert.deepEqual(reset.parkedProbeIds, ["probe-a", "probe-b", "probe-c"]);
  assert.deepEqual(g.snapshot().parkedProbeIds, []);
  assert.equal(g.state, "normal");
});

test("completeOwner authenticates current owner; wrong/stale/duplicate are frozen no-ops", () => {
  // Mutation: any completeOwner advances wake, or wrong jobId can steal the handoff.
  const g = gate();
  g.setSaturated({ drainOwnerJobId: "owner", reducedConcurrency: 1 });
  g.parkProbe("p1");

  const wrong = g.completeOwner({ jobId: "not-owner", recoveryOwnerJobId: "hijack" });
  assert.equal(wrong.advanced, false);
  assert.deepEqual(wrong.parkedProbeIds, []);
  assert.equal(g.state, "saturated");
  assert.equal(g.snapshot().ownerJobId, "owner");
  assert.deepEqual(g.snapshot().parkedProbeIds, ["p1"]);

  const first = g.completeOwner({ jobId: "owner", recoveryOwnerJobId: "next" });
  assert.equal(first.advanced, true);
  const wakeAfter = g.wakeGeneration;
  assert.equal(g.state, "recovering");
  assert.equal(g.snapshot().ownerJobId, "next");
  assert.deepEqual(g.snapshot().parkedProbeIds, ["p1"]);

  // Late owner-A completion must not wake or change successor.
  const lateA = g.completeOwner({ jobId: "owner", recoveryOwnerJobId: "other" });
  assert.equal(lateA.advanced, false);
  assert.equal(g.wakeGeneration, wakeAfter);
  assert.deepEqual(lateA.parkedProbeIds, []);
  assert.equal(g.snapshot().ownerJobId, "next");

  // Duplicate completion of the same already-terminalized epoch (via current owner once more
  // is tested in chain; here duplicate of previous owner already covered).
  const dupNextWrong = g.completeOwner({ jobId: "owner", recoveryOwnerJobId: "zzz" });
  assert.equal(dupNextWrong.advanced, false);
  assert.equal(g.snapshot().ownerJobId, "next");
});

test("recovery chain A→B→C in same provider generation; late A never wakes", () => {
  // Mutation: once-per-provider-generation wake blocks B→C handoff.
  const g = gate();
  g.setSaturated({ drainOwnerJobId: "A", reducedConcurrency: 1 });
  const gen = g.generation;

  const ab = g.completeOwner({ jobId: "A", recoveryOwnerJobId: "B" });
  assert.equal(ab.advanced, true);
  assert.equal(g.state, "recovering");
  assert.equal(g.snapshot().ownerJobId, "B");
  assert.equal(g.generation, gen);

  const lateA = g.completeOwner({ jobId: "A", recoveryOwnerJobId: "X" });
  assert.equal(lateA.advanced, false);

  // B cancels/fails/retry-exhausts and hands off to C — new ownership epoch, same provider gen.
  const bc = g.completeOwner({ jobId: "B", recoveryOwnerJobId: "C" });
  assert.equal(bc.advanced, true);
  assert.equal(bc.wakeGeneration, ab.wakeGeneration + 1);
  assert.equal(g.wakeGeneration, ab.wakeGeneration + 1);
  assert.equal(g.generation, gen);
  assert.equal(g.snapshot().ownerJobId, "C");

  // Duplicate B completion after handoff is a no-op.
  const dupB = g.completeOwner({ jobId: "B", recoveryOwnerJobId: "D" });
  assert.equal(dupB.advanced, false);
  assert.equal(g.snapshot().ownerJobId, "C");
  assert.equal(g.wakeGeneration, ab.wakeGeneration + 1);

  // C can still complete further if needed.
  const blocked = g.completeOwner({ jobId: "C", recoveryOwnerJobId: null });
  assert.equal(blocked.advanced, true);
  assert.equal(g.snapshot().ownerJobId, null);
  assert.equal(g.state, "recovering");
});

test("completeOwner rejects same completed id as successor; no successor remains blocked", () => {
  const g = gate();
  g.setSaturated({ drainOwnerJobId: "owner", reducedConcurrency: 1 });

  const same = g.completeOwner({ jobId: "owner", recoveryOwnerJobId: "owner" });
  assert.equal(same.advanced, true);
  assert.equal(g.state, "recovering");
  assert.equal(g.snapshot().ownerJobId, null);
  assert.equal(g.acquire("owner", ownerOpts({ maxForJob: 1 })), null);
  assert.equal(g.nativeLeaseFor("owner").maxConnections, 0);

  // Fresh gate for blank successor path.
  const g2 = gate();
  g2.setSaturated({ drainOwnerJobId: "owner", reducedConcurrency: 1 });
  const none = g2.completeOwner({ jobId: "owner", recoveryOwnerJobId: null });
  assert.equal(none.advanced, true);
  assert.equal(g2.state, "recovering");
  assert.equal(g2.snapshot().ownerJobId, null);
  assert.equal(
    g2.acquire("anyone", ownerOpts({ maxForJob: 2 })),
    null
  );
  assert.equal(g2.nativeLeaseFor("anyone").maxConnections, 0);
});

test("designateRecoveryOwner installs a later owner when recovering blocked", () => {
  const g = gate();
  g.setSaturated({ drainOwnerJobId: "owner", reducedConcurrency: 1 });
  g.completeOwner({ jobId: "owner", recoveryOwnerJobId: null });
  assert.equal(g.snapshot().ownerJobId, null);

  // Not blocked (has owner) → no-op.
  const gBusy = gate();
  gBusy.setSaturated({ drainOwnerJobId: "owner", reducedConcurrency: 1 });
  const busy = gBusy.designateRecoveryOwner({ recoveryOwnerJobId: "later" });
  assert.equal(busy.applied, false);
  assert.equal(gBusy.snapshot().ownerJobId, "owner");

  // Blocked recovering → install fresh owner epoch.
  const applied = g.designateRecoveryOwner({ recoveryOwnerJobId: "later" });
  assert.equal(applied.applied, true);
  assert.equal(applied.ownerJobId, "later");
  assert.equal(g.snapshot().ownerJobId, "later");
  assert.ok(g.acquire("later", ownerOpts({ maxForJob: 1 })));

  // That designated owner can terminalize and hand off again.
  const handoff = g.completeOwner({ jobId: "later", recoveryOwnerJobId: "final" });
  assert.equal(handoff.advanced, true);
  assert.equal(g.snapshot().ownerJobId, "final");

  assert.throws(() => g.designateRecoveryOwner({ recoveryOwnerJobId: "" }));
  assert.throws(() => g.designateRecoveryOwner({ recoveryOwnerJobId: "  " }));
});

test("recoverToNormal authenticates recovery owner; wrong/stale do not drain probes or reset", () => {
  const g = gate();
  g.setSaturated({ drainOwnerJobId: "owner", reducedConcurrency: 1 });
  g.parkProbe("z");
  g.parkProbe("a");
  g.completeOwner({ jobId: "owner", recoveryOwnerJobId: "recover" });
  g.parkProbe("m");
  const genBefore = g.generation;
  const wakeBefore = g.wakeGeneration;

  const wrong = g.recoverToNormal({ jobId: "not-recover" });
  assert.equal(wrong.advanced, false);
  assert.deepEqual(wrong.parkedProbeIds, []);
  assert.equal(g.state, "recovering");
  assert.equal(g.generation, genBefore);
  assert.equal(g.wakeGeneration, wakeBefore);
  assert.deepEqual(g.snapshot().parkedProbeIds, ["a", "m", "z"]);

  const ok = g.recoverToNormal({ jobId: "recover" });
  assert.equal(ok.advanced, true);
  assert.equal(g.state, "normal");
  assert.equal(g.generation, genBefore + 1);
  assert.deepEqual(ok.parkedProbeIds, ["a", "m", "z"]);
  assert.deepEqual(g.snapshot().parkedProbeIds, []);
  assert.equal(g.snapshot().ownerJobId, null);
  assert.equal(g.snapshot().reducedConcurrency, null);

  // Duplicate / after-normal is a frozen no-op and does not invent probes.
  const dup = g.recoverToNormal({ jobId: "recover" });
  assert.equal(dup.advanced, false);
  assert.deepEqual(dup.parkedProbeIds, []);
  assert.equal(g.state, "normal");
});

test("recoverToNormal returns to normal without reusing stale generation permits", () => {
  const g = gate();
  g.registerJobLimit("job-a", 3);
  g.setSaturated({ drainOwnerJobId: "owner", reducedConcurrency: 1 });
  const satGen = g.generation;
  const ownerPermit = g.acquire("owner", ownerOpts({ maxForJob: 1 }));
  assert.ok(ownerPermit);
  g.completeOwner({ jobId: "owner", recoveryOwnerJobId: "recover" });
  assert.equal(g.state, "recovering");
  const recoveringPermit = g.acquire("recover", ownerOpts({ maxForJob: 1 }));
  assert.ok(recoveringPermit);

  const genBefore = g.generation;
  const reset = g.recoverToNormal({ jobId: "recover" });
  assert.equal(reset.advanced, true);
  assert.equal(g.state, "normal");
  assert.equal(g.generation, genBefore + 1);
  assert.notEqual(g.generation, satGen);

  // Stale permits are inert for current-generation counters (physical still tracked).
  ownerPermit.release();
  recoveringPermit.release();

  // Normal jobs work again under registered / maxForJob rules.
  const p = g.acquire("job-a", running({ maxForJob: 2 }));
  assert.ok(p);
  assert.equal(p.generation, g.generation);
  p.release();

  // Native lease returns to registered finite limit in normal state.
  assert.deepEqual(g.nativeLeaseFor("job-a"), {
    jobId: "job-a",
    providerGeneration: g.generation,
    maxConnections: 3,
  });
});

// ---------------------------------------------------------------------------
// Permit freeze / invalid inputs / snapshot / dual export
// ---------------------------------------------------------------------------

test("returned permit objects are frozen; release remains closure-safe and idempotent", () => {
  const g = gate();
  const p = g.acquire("j1", running({ maxForJob: 1 }));
  assert.ok(p);
  assert.ok(Object.isFrozen(p));
  assert.throws(() => {
    p.jobId = "mutated";
  });
  assert.throws(() => {
    p.purpose = "mutated";
  });
  assert.throws(() => {
    p.generation = -1;
  });
  assert.equal(p.jobId, "j1");
  p.release();
  p.release();
  const p2 = g.acquire("j1", running({ maxForJob: 1 }));
  assert.ok(p2);
  p2.release();
});

test("rejects invalid providerKey/jobId/purpose/maxForJob without throwing on ordinary deny", () => {
  assert.throws(() => createProviderGate({ providerKey: "" }));
  assert.throws(() => createProviderGate({ providerKey: "  " }));
  assert.throws(() => createProviderGate({}));
  assert.throws(() => createProviderGate({ providerKey: null }));

  const g = gate();
  // Ordinary deny → null, no throw.
  assert.equal(g.acquire("j1", running({ isRunningJob: false })), null);
  // Fill and prove deny-at-cap returns null without throw.
  const only = g.acquire("j1", running({ maxForJob: 1 }));
  assert.ok(only);
  assert.equal(g.acquire("j1", running({ maxForJob: 1 })), null);
  only.release();

  // Invalid identifiers / concurrency → throw.
  assert.throws(() => g.acquire("", running()));
  assert.throws(() => g.acquire("  ", running()));
  assert.throws(() => g.acquire("j1", running({ maxForJob: 0 })));
  assert.throws(() => g.acquire("j1", running({ maxForJob: -1 })));
  assert.throws(() => g.acquire("j1", running({ maxForJob: 1.5 })));
  assert.throws(() => g.acquire("j1", running({ maxForJob: Infinity })));
  assert.throws(() => g.acquire("j1", running({ maxForJob: NaN })));
  assert.throws(() => g.acquire("j1", running({ purpose: "" })));
  assert.throws(() => g.acquire("j1", running({ purpose: "  " })));
  assert.throws(() => g.parkProbe(""));
  assert.throws(() => g.parkProbe("  "));
  assert.throws(() => g.completeOwner({ jobId: "", recoveryOwnerJobId: "x" }));
  assert.throws(() => g.completeOwner({ jobId: "  ", recoveryOwnerJobId: "x" }));
});

test("snapshot is deep-frozen deterministic and reflects state transitions", () => {
  const g = gate("florenfile.com");
  const snap0 = g.snapshot();
  assert.equal(snap0.providerKey, "florenfile.com");
  assert.equal(snap0.state, "normal");
  assert.equal(snap0.generation, g.generation);
  assert.equal(snap0.wakeGeneration, g.wakeGeneration);
  assert.equal(snap0.ownerJobId, null);
  assert.equal(snap0.reducedConcurrency, null);
  assert.deepEqual(snap0.parkedProbeIds, []);
  assert.throws(() => {
    snap0.state = "saturated";
  });
  assert.throws(() => {
    snap0.parkedProbeIds.push("x");
  });

  g.setSaturated({ drainOwnerJobId: "owner", reducedConcurrency: 2 });
  g.parkProbe("z-probe");
  g.parkProbe("a-probe");
  const snap1 = g.snapshot();
  assert.equal(snap1.state, "saturated");
  assert.equal(snap1.ownerJobId, "owner");
  assert.equal(snap1.reducedConcurrency, 2);
  // Deterministic sort of parked probes.
  assert.deepEqual(snap1.parkedProbeIds, ["a-probe", "z-probe"]);
  assert.throws(() => {
    snap1.parkedProbeIds[0] = "mutated";
  });
  // Snapshot is a safe value: later mutation does not rewrite prior snap.
  g.parkProbe("m-probe");
  assert.deepEqual(snap1.parkedProbeIds, ["a-probe", "z-probe"]);
});

test("snapshot represents hostile jobIds as own enumerable data keys without prototype mutation", () => {
  // Mutation: ordinary open[id]=n / limits[id]=n loses __proto__ and can pollute Object.prototype.
  const hostileIds = ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "valueOf"];
  const g = gate("hostile.com");
  const protoBefore = Object.getPrototypeOf({});
  const polluteKey = "__hostile_gate_pollute__";
  assert.equal(Object.prototype[polluteKey], undefined);

  hostileIds.forEach(function (id, idx) {
    g.registerJobLimit(id, idx + 1);
    g.noteNativeOpen(id, idx + 10);
  });

  const snap = g.snapshot();
  assert.ok(Object.isFrozen(snap.nativeOpen));
  assert.ok(Object.isFrozen(snap.jobLimits));
  // Must not have rewritten Object.prototype via __proto__ assignment.
  assert.equal(Object.getPrototypeOf({}), protoBefore);
  assert.equal(Object.prototype[polluteKey], undefined);
  assert.notEqual(Object.getPrototypeOf(snap.nativeOpen), null);
  // Null-prototype is also acceptable, but ordinary frozen records must stay clean.
  assert.equal(Object.prototype.isPrototypeOf(snap.nativeOpen) || Object.getPrototypeOf(snap.nativeOpen) === null, true);

  hostileIds.forEach(function (id, idx) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(snap.nativeOpen, id),
      true,
      "nativeOpen must own " + id
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(snap.jobLimits, id),
      true,
      "jobLimits must own " + id
    );
    assert.equal(snap.nativeOpen[id], idx + 10);
    assert.equal(snap.jobLimits[id], idx + 1);
    assert.equal(
      Object.getOwnPropertyDescriptor(snap.nativeOpen, id).enumerable,
      true
    );
    assert.equal(
      Object.getOwnPropertyDescriptor(snap.jobLimits, id).enumerable,
      true
    );
  });

  // Freeze: cannot rewrite hostile own keys after snapshot.
  assert.throws(function () {
    snap.nativeOpen["__proto__"] = 999;
  });
  assert.throws(function () {
    snap.jobLimits["constructor"] = 999;
  });
  assert.equal(snap.nativeOpen["__proto__"], 10);
  assert.equal(snap.jobLimits["constructor"], 2);
  // Object.prototype must remain unpolluted after attempted writes.
  assert.equal(Object.prototype[polluteKey], undefined);
  assert.equal(Object.getOwnPropertyNames(Object.prototype).indexOf("__proto__") === -1 ||
    typeof Object.getOwnPropertyDescriptor(Object.prototype, "__proto__") === "object", true);
});

test("provider-gate dual-export assigns locked McProviderGate global with identity", () => {
  // Mutation: else-branch only assigns one side, or creates two distinct objects.
  const abs = path.join(mediaCatcherRoot, "lib", "provider-gate.js");
  const code = fs.readFileSync(abs, "utf8");
  const root = {};
  const sandbox = { module: { exports: {} }, exports: {}, require, console, self: root };
  sandbox.module.exports = sandbox.exports;
  vm.runInNewContext(code, sandbox, { filename: abs });
  assert.equal(typeof sandbox.module.exports.createProviderGate, "function");
  assert.equal(typeof root.McProviderGate.createProviderGate, "function");
  assert.equal(root.McProviderGate, sandbox.module.exports);
});
