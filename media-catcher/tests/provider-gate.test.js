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
 *   acquire(jobId, { maxForJob, isDrainOwner, isRunningJob, purpose })
 *     -> permit | null
 *     permit: { jobId, purpose, generation, release() }  // release is idempotent
 *   setSaturated({ drainOwnerJobId, reducedConcurrency })
 *     -> bumps generation once, state=saturated, invalidates old permits
 *   registerJobLimit(jobId, maxConnections)
 *     -> normal-state native lease registration (positive finite integer; never Infinity/NaN)
 *   nativeLeaseFor(jobId)
 *     -> { jobId, providerGeneration, maxConnections }
 *   noteNativeOpen(jobId, n)
 *     -> tracks nonnegative finite open count; does NOT invent a permit
 *   parkProbe(probeId)
 *     -> idempotent parking while saturated/recovering
 *   completeOwner({ recoveryOwnerJobId })
 *     -> idempotent owner completion/wake; returns
 *        { advanced, wakeGeneration, parkedProbeIds }
 *   recoverToNormal()
 *     -> successful recovery path: state=normal, generation++, stale permits inert
 *   snapshot()
 *     -> deep-frozen deterministic projection
 *
 * Denied acquire (not running, at cap, non-owner, etc.) returns null — does not throw.
 * Invalid ids / concurrency values throw.
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
  assert.ok(
    g.acquire("owner", running({ maxForJob: 1, isDrainOwner: true }))
  );
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
// setSaturated / generation / stale permits
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
  const g = gate();
  const old = g.acquire("j1", running({ maxForJob: 2 }));
  assert.ok(old);
  const genBefore = old.generation;
  g.setSaturated({ drainOwnerJobId: "owner", reducedConcurrency: 1 });
  assert.notEqual(g.generation, genBefore);
  old.release();
  old.release();

  // Owner can still acquire up to reduced cap in the new generation.
  const p1 = g.acquire("owner", running({ maxForJob: 2, isDrainOwner: true }));
  assert.ok(p1);
  assert.equal(p1.generation, g.generation);
  const p2 = g.acquire("owner", running({ maxForJob: 2, isDrainOwner: true }));
  // reducedConcurrency=1 so second permit denied
  assert.equal(p2, null);
  p1.release();
  const p3 = g.acquire("owner", running({ maxForJob: 2, isDrainOwner: true }));
  assert.ok(p3);
  p3.release();
});

test("saturated/recovering cap owner at min(maxForJob, reducedConcurrency); non-owner and non-running denied", () => {
  const g = gate();
  g.setSaturated({ drainOwnerJobId: "owner", reducedConcurrency: 2 });

  // Owner must be drain owner AND running.
  assert.equal(
    g.acquire("owner", running({ maxForJob: 4, isDrainOwner: false })),
    null
  );
  assert.equal(
    g.acquire("owner", running({ maxForJob: 4, isDrainOwner: true, isRunningJob: false })),
    null
  );

  // Cap = min(4, 2) = 2
  const a = g.acquire("owner", running({ maxForJob: 4, isDrainOwner: true }));
  const b = g.acquire("owner", running({ maxForJob: 4, isDrainOwner: true }));
  const c = g.acquire("owner", running({ maxForJob: 4, isDrainOwner: true }));
  assert.ok(a);
  assert.ok(b);
  assert.equal(c, null);

  // Cap = min(1, 2) = 1 when maxForJob is tighter
  a.release();
  b.release();
  const d = g.acquire("owner", running({ maxForJob: 1, isDrainOwner: true }));
  assert.ok(d);
  assert.equal(
    g.acquire("owner", running({ maxForJob: 1, isDrainOwner: true })),
    null
  );
  d.release();
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

  const wake = g.completeOwner({ recoveryOwnerJobId: "recover" });
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

// ---------------------------------------------------------------------------
// parkProbe / completeOwner / duplicate wake / recovery
// ---------------------------------------------------------------------------

test("parkProbe is idempotent; completeOwner drains probes and advances wake once", () => {
  const g = gate();
  g.setSaturated({ drainOwnerJobId: "owner", reducedConcurrency: 1 });
  g.parkProbe("probe-a");
  g.parkProbe("probe-a");
  g.parkProbe("probe-b");
  assert.deepEqual(g.snapshot().parkedProbeIds, ["probe-a", "probe-b"]);

  // Parked probes cannot acquire permits.
  assert.equal(
    g.acquire("probe-a", running({ purpose: "probe" })),
    null
  );

  const wake0 = g.wakeGeneration;
  const first = g.completeOwner({ recoveryOwnerJobId: "next" });
  assert.equal(first.advanced, true);
  assert.equal(first.wakeGeneration, wake0 + 1);
  assert.deepEqual(first.parkedProbeIds, ["probe-a", "probe-b"]);
  assert.equal(g.wakeGeneration, wake0 + 1);
  assert.equal(g.state, "recovering");
  assert.deepEqual(g.snapshot().parkedProbeIds, []);

  // Recovery owner can acquire; others cannot.
  assert.ok(
    g.acquire("next", running({ maxForJob: 1, isDrainOwner: true }))
  );
  assert.equal(
    g.acquire("owner", running({ maxForJob: 1, isDrainOwner: true })),
    null
  );
});

test("duplicate/stale owner completion does not double-wake", () => {
  // Mutation: each completeOwner call increments wakeGeneration.
  const g = gate();
  g.setSaturated({ drainOwnerJobId: "owner", reducedConcurrency: 1 });
  g.parkProbe("p1");
  const first = g.completeOwner({ recoveryOwnerJobId: "next" });
  assert.equal(first.advanced, true);
  const wakeAfter = g.wakeGeneration;

  const dup = g.completeOwner({ recoveryOwnerJobId: "other" });
  assert.equal(dup.advanced, false);
  assert.equal(g.wakeGeneration, wakeAfter);
  assert.deepEqual(dup.parkedProbeIds, []);
  // Owner remains the recovery owner from the first successful wake.
  assert.equal(g.snapshot().ownerJobId, "next");
});

test("completeOwner with no recovery owner remains blocked; no permits issued", () => {
  const g = gate();
  g.setSaturated({ drainOwnerJobId: "owner", reducedConcurrency: 1 });
  const r = g.completeOwner({ recoveryOwnerJobId: null });
  assert.equal(r.advanced, true);
  assert.equal(g.state, "recovering");
  assert.equal(g.snapshot().ownerJobId, null);
  assert.equal(
    g.acquire("anyone", running({ maxForJob: 2, isDrainOwner: true })),
    null
  );
  assert.equal(g.nativeLeaseFor("anyone").maxConnections, 0);
});

test("recoverToNormal returns to normal without reusing stale generation permits", () => {
  const g = gate();
  g.registerJobLimit("job-a", 3);
  g.setSaturated({ drainOwnerJobId: "owner", reducedConcurrency: 1 });
  const satGen = g.generation;
  const ownerPermit = g.acquire("owner", running({ maxForJob: 1, isDrainOwner: true }));
  assert.ok(ownerPermit);
  g.completeOwner({ recoveryOwnerJobId: "recover" });
  assert.equal(g.state, "recovering");
  const recoveringPermit = g.acquire(
    "recover",
    running({ maxForJob: 1, isDrainOwner: true })
  );
  assert.ok(recoveringPermit);

  const genBefore = g.generation;
  g.recoverToNormal();
  assert.equal(g.state, "normal");
  assert.equal(g.generation, genBefore + 1);
  assert.notEqual(g.generation, satGen);

  // Stale permits are inert.
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
// Invalid inputs / snapshot / dual export
// ---------------------------------------------------------------------------

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
