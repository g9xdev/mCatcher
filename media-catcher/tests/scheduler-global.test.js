"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const { loadLib, mediaCatcherRoot } = require("./harness/load-lib.js");
const { createDownloadScheduler } = loadLib("lib/download-scheduler.js");

/**
 * McDownloadScheduler — Task 9 global admission surface
 * ----------------------------------------------------
 * createDownloadScheduler({ maxConcurrent, now, randomToken })
 *   createJob / enqueue / setMaxConcurrent / onTransportResult / getJob / getSnapshot
 *
 * Admission: hard global slot cap, FIFO within providerKey, round-robin across providers.
 * Slot token: holdsGlobalSlot boolean + stateVersion CAS; attemptToken issued only on admit.
 * Projections: deep-frozen, no ephemeral / cookies / signed URLs / headers.
 */

function intent(name) {
  return Object.freeze({
    requestedFilename: name,
    destinationDirectory: null,
    saveMode: "default",
    userSelectedFirefox: false,
    userActionToken: "t",
    createdAt: "t0",
  });
}

function makeScheduler(opts) {
  var tokenSeq = 0;
  return createDownloadScheduler(
    Object.assign(
      {
        maxConcurrent: 2,
        now: function () {
          return 0;
        },
        randomToken: function () {
          tokenSeq += 1;
          return "tok-" + tokenSeq;
        },
      },
      opts || {}
    )
  );
}

function countRunning(snap) {
  return snap.jobs.filter(function (j) {
    return j.state === "running";
  }).length;
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
      j.state === "completed" ||
      j.state === "failed"
    ) {
      assert.equal(j.holdsGlobalSlot, false);
    }
  });
}

// ---------------------------------------------------------------------------
// Brief scenarios
// ---------------------------------------------------------------------------

test("maxConcurrentDownloads is a hard global admission limit", () => {
  // Mutation: starting all enqueued jobs immediately.
  const s = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
  s.createJob({ id: "1", providerKey: "a.com", intent: intent("1.mp4"), segmentConcurrency: 4, retries: 3 });
  s.createJob({ id: "2", providerKey: "b.com", intent: intent("2.mp4"), segmentConcurrency: 4, retries: 3 });
  s.createJob({ id: "3", providerKey: "c.com", intent: intent("3.mp4"), segmentConcurrency: 4, retries: 3 });
  s.enqueue("1");
  s.enqueue("2");
  s.enqueue("3");
  const snap = s.getSnapshot();
  assert.equal(snap.globalRunning, 2);
  assert.equal(snap.jobs.find((j) => j.id === "3").state, "queued");
  assertSlotInvariant(s);
});

test("lowering limit pauses new admission without cancelling active work", () => {
  const s = createDownloadScheduler({ maxConcurrent: 2, now: () => 0 });
  s.createJob({ id: "1", providerKey: "a.com", intent: intent("1.mp4"), segmentConcurrency: 2, retries: 1 });
  s.createJob({ id: "2", providerKey: "b.com", intent: intent("2.mp4"), segmentConcurrency: 2, retries: 1 });
  s.createJob({ id: "3", providerKey: "c.com", intent: intent("3.mp4"), segmentConcurrency: 2, retries: 1 });
  s.enqueue("1");
  s.enqueue("2");
  s.enqueue("3");
  s.setMaxConcurrent(1);
  assert.equal(s.getSnapshot().jobs.filter((j) => j.state === "running").length, 2);
  s.onTransportResult("1", s.getJob("1").attemptToken, { status: "completed", failureCategory: null });
  assert.equal(s.getSnapshot().jobs.filter((j) => j.state === "running").length, 1);
  assert.equal(s.getSnapshot().jobs.find((j) => j.id === "3").state, "queued");
  assertSlotInvariant(s);
});

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

test("rejects non-positive / non-integer maxConcurrent and bad hooks", () => {
  assert.throws(() => createDownloadScheduler({ maxConcurrent: 0, now: () => 0 }), RangeError);
  assert.throws(() => createDownloadScheduler({ maxConcurrent: -1, now: () => 0 }), RangeError);
  assert.throws(() => createDownloadScheduler({ maxConcurrent: 1.5, now: () => 0 }), RangeError);
  assert.throws(() => createDownloadScheduler({ maxConcurrent: Infinity, now: () => 0 }), RangeError);
  assert.throws(() => createDownloadScheduler({ maxConcurrent: NaN, now: () => 0 }), RangeError);
  assert.throws(() => createDownloadScheduler({ maxConcurrent: "2", now: () => 0 }), RangeError);
  assert.throws(
    () => createDownloadScheduler({ maxConcurrent: 1, now: "not-fn" }),
    TypeError
  );
  assert.throws(
    () => createDownloadScheduler({ maxConcurrent: 1, now: () => 0, randomToken: 42 }),
    TypeError
  );
});

// ---------------------------------------------------------------------------
// createJob shape + clamps
// ---------------------------------------------------------------------------

test("createJob builds created job with clamped retries, no slot, no attempt token", () => {
  const s = makeScheduler({ maxConcurrent: 1 });
  const i = intent("a.mp4");
  const view = s.createJob({
    id: "j1",
    providerKey: "florenfile.com",
    intent: i,
    segmentConcurrency: 4,
    retries: 99,
    mediaOrigin: "https://cdn-should-not-become-provider",
    ephemeral: { clear() {} },
  });
  assert.equal(view.state, "created");
  assert.equal(view.holdsGlobalSlot, false);
  assert.equal(view.retryRemaining, 10);
  assert.equal(view.retryUsed, 0);
  assert.equal(view.effectiveConcurrency, 4);
  assert.equal(view.providerKey, "florenfile.com");
  assert.equal(view.attemptToken, null);
  assert.ok(view.stateVersion >= 1);
  assert.equal(view.mode, "multi-range");
  // Brand-new allowlist intent (never caller identity / frozen passthrough).
  assert.notEqual(view.intent, i);
  assert.deepEqual(view.intent, {
    requestedFilename: "a.mp4",
    destinationDirectory: null,
    saveMode: "default",
    userSelectedFirefox: false,
    userActionToken: "t",
    createdAt: "t0",
  });
  assert.equal(view.intent.requestedFilename, "a.mp4");
  // Never derive providerKey from mediaOrigin / CDN.
  assert.notEqual(view.providerKey, "cdn-should-not-become-provider");
  assert.equal("ephemeral" in view, false);
  assert.equal(s.getSnapshot().globalRunning, 0);
  assertSlotInvariant(s);
});

test("createJob clamps retries to 0..10 and rejects blank / duplicate ids", () => {
  const s = makeScheduler({ maxConcurrent: 1 });
  const low = s.createJob({
    id: "low",
    providerKey: "p.com",
    intent: intent("l.mp4"),
    segmentConcurrency: 1,
    retries: -5,
  });
  assert.equal(low.retryRemaining, 0);

  const mid = s.createJob({
    id: "mid",
    providerKey: "p.com",
    intent: intent("m.mp4"),
    segmentConcurrency: 2,
    retries: 3,
  });
  assert.equal(mid.retryRemaining, 3);

  assert.throws(
    () =>
      s.createJob({
        id: "low",
        providerKey: "p.com",
        intent: intent("x.mp4"),
        segmentConcurrency: 1,
        retries: 1,
      }),
    /duplicate|already/i
  );
  assert.throws(
    () =>
      s.createJob({
        id: "",
        providerKey: "p.com",
        intent: intent("x.mp4"),
        segmentConcurrency: 1,
        retries: 1,
      }),
    TypeError
  );
  assert.throws(
    () =>
      s.createJob({
        id: "  ",
        providerKey: "p.com",
        intent: intent("x.mp4"),
        segmentConcurrency: 1,
        retries: 1,
      }),
    TypeError
  );
  assert.throws(
    () =>
      s.createJob({
        id: "blank-pk",
        providerKey: "",
        intent: intent("x.mp4"),
        segmentConcurrency: 1,
        retries: 1,
      }),
    TypeError
  );
  assert.throws(
    () =>
      s.createJob({
        id: "bad-seg",
        providerKey: "p.com",
        intent: intent("x.mp4"),
        segmentConcurrency: 0,
        retries: 1,
      }),
    RangeError
  );
});

// ---------------------------------------------------------------------------
// Enqueue + admission fairness
// ---------------------------------------------------------------------------

test("enqueue is idempotent and only transitions created → queued once", () => {
  const s = makeScheduler({ maxConcurrent: 1 });
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
  const v1 = s.getJob("a").stateVersion;
  s.enqueue("a");
  s.enqueue("a");
  assert.equal(s.getJob("a").state, "running");
  assert.equal(s.getJob("a").stateVersion, v1);
  assert.equal(s.getJob("b").state, "created");
  s.enqueue("b");
  assert.equal(s.getJob("b").state, "queued");
  // Duplicate enqueue while queued is a no-op.
  const vq = s.getJob("b").stateVersion;
  s.enqueue("b");
  assert.equal(s.getJob("b").state, "queued");
  assert.equal(s.getJob("b").stateVersion, vq);
  assertSlotInvariant(s);
});

test("max=1 enforces FIFO within a single provider", () => {
  const s = makeScheduler({ maxConcurrent: 1 });
  s.createJob({
    id: "a1",
    providerKey: "a.com",
    intent: intent("a1.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.createJob({
    id: "a2",
    providerKey: "a.com",
    intent: intent("a2.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.createJob({
    id: "a3",
    providerKey: "a.com",
    intent: intent("a3.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.enqueue("a1");
  s.enqueue("a2");
  s.enqueue("a3");
  assert.equal(s.getJob("a1").state, "running");
  assert.equal(s.getJob("a2").state, "queued");
  assert.equal(s.getJob("a3").state, "queued");
  s.onTransportResult("a1", s.getJob("a1").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  assert.equal(s.getJob("a2").state, "running");
  assert.equal(s.getJob("a3").state, "queued");
  s.onTransportResult("a2", s.getJob("a2").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  assert.equal(s.getJob("a3").state, "running");
  assertSlotInvariant(s);
});

test("cross-provider round-robin prefers next provider over same-provider FIFO head", () => {
  // Mutation: pure global FIFO ignores provider fairness (would admit a2 before b1).
  const s = makeScheduler({ maxConcurrent: 1 });
  s.createJob({
    id: "a1",
    providerKey: "a.com",
    intent: intent("a1.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.createJob({
    id: "a2",
    providerKey: "a.com",
    intent: intent("a2.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.createJob({
    id: "b1",
    providerKey: "b.com",
    intent: intent("b1.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.enqueue("a1");
  s.enqueue("a2");
  s.enqueue("b1");
  assert.equal(s.getJob("a1").state, "running");
  assert.equal(s.getJob("a2").state, "queued");
  assert.equal(s.getJob("b1").state, "queued");
  s.onTransportResult("a1", s.getJob("a1").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  // Round-robin should admit b1 next, not a2.
  assert.equal(s.getJob("b1").state, "running");
  assert.equal(s.getJob("a2").state, "queued");
  s.onTransportResult("b1", s.getJob("b1").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  assert.equal(s.getJob("a2").state, "running");
  assertSlotInvariant(s);
});

test("admission issues unique nonblank attempt tokens and sets holdsGlobalSlot", () => {
  const s = makeScheduler({ maxConcurrent: 2 });
  s.createJob({
    id: "1",
    providerKey: "a.com",
    intent: intent("1.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.createJob({
    id: "2",
    providerKey: "b.com",
    intent: intent("2.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  assert.equal(s.getJob("1").attemptToken, null);
  s.enqueue("1");
  s.enqueue("2");
  const t1 = s.getJob("1").attemptToken;
  const t2 = s.getJob("2").attemptToken;
  assert.ok(typeof t1 === "string" && t1.trim().length > 0);
  assert.ok(typeof t2 === "string" && t2.trim().length > 0);
  assert.notEqual(t1, t2);
  assert.equal(s.getJob("1").holdsGlobalSlot, true);
  assert.equal(s.getJob("2").holdsGlobalSlot, true);
  assert.equal(s.getJob("1").state, "running");
  assert.equal(s.getSnapshot().globalRunning, 2);
  assertSlotInvariant(s);
});

// ---------------------------------------------------------------------------
// setMaxConcurrent
// ---------------------------------------------------------------------------

test("raising maxConcurrent immediately drains queued work", () => {
  const s = makeScheduler({ maxConcurrent: 1 });
  s.createJob({
    id: "1",
    providerKey: "a.com",
    intent: intent("1.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.createJob({
    id: "2",
    providerKey: "b.com",
    intent: intent("2.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.createJob({
    id: "3",
    providerKey: "c.com",
    intent: intent("3.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.enqueue("1");
  s.enqueue("2");
  s.enqueue("3");
  assert.equal(s.getSnapshot().globalRunning, 1);
  assert.equal(s.getJob("2").state, "queued");
  assert.equal(s.getJob("3").state, "queued");
  s.setMaxConcurrent(3);
  assert.equal(s.getSnapshot().globalRunning, 3);
  assert.equal(s.getJob("1").state, "running");
  assert.equal(s.getJob("2").state, "running");
  assert.equal(s.getJob("3").state, "running");
  assert.equal(s.getSnapshot().maxConcurrent, 3);
  assertSlotInvariant(s);
});

test("lowering then completing never demotes running and waits for room", () => {
  const s = makeScheduler({ maxConcurrent: 3 });
  ["1", "2", "3"].forEach(function (id) {
    s.createJob({
      id: id,
      providerKey: id + ".com",
      intent: intent(id + ".mp4"),
      segmentConcurrency: 2,
      retries: 1,
    });
    s.enqueue(id);
  });
  s.createJob({
    id: "4",
    providerKey: "d.com",
    intent: intent("4.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.enqueue("4");
  assert.equal(s.getSnapshot().globalRunning, 3);
  assert.equal(s.getJob("4").state, "queued");
  s.setMaxConcurrent(1);
  // Still three running — never cancel/demote.
  assert.equal(countRunning(s.getSnapshot()), 3);
  assert.equal(s.getJob("4").state, "queued");
  s.onTransportResult("1", s.getJob("1").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  // globalRunning still 2 > new limit 1 → job 4 stays queued.
  assert.equal(s.getSnapshot().globalRunning, 2);
  assert.equal(s.getJob("4").state, "queued");
  s.onTransportResult("2", s.getJob("2").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  assert.equal(s.getSnapshot().globalRunning, 1);
  assert.equal(s.getJob("4").state, "queued");
  s.onTransportResult("3", s.getJob("3").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  // Now room under the new limit.
  assert.equal(s.getJob("4").state, "running");
  assert.equal(s.getSnapshot().globalRunning, 1);
  assertSlotInvariant(s);
});

// ---------------------------------------------------------------------------
// onTransportResult CAS / idempotency
// ---------------------------------------------------------------------------

test("completed releases slot once, clears ephemeral once, drains next job", () => {
  let clearCount = 0;
  const ephemeral = {
    cookie: "secret",
    clear() {
      clearCount += 1;
    },
  };
  const s = makeScheduler({ maxConcurrent: 1 });
  s.createJob({
    id: "1",
    providerKey: "a.com",
    intent: intent("1.mp4"),
    segmentConcurrency: 2,
    retries: 1,
    ephemeral: ephemeral,
  });
  s.createJob({
    id: "2",
    providerKey: "b.com",
    intent: intent("2.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.enqueue("1");
  s.enqueue("2");
  const token = s.getJob("1").attemptToken;
  const vBefore = s.getJob("1").stateVersion;
  s.onTransportResult("1", token, { status: "completed", failureCategory: null });
  assert.equal(s.getJob("1").state, "completed");
  assert.equal(s.getJob("1").holdsGlobalSlot, false);
  assert.equal(s.getJob("1").stateVersion, vBefore + 1);
  assert.equal(clearCount, 1);
  assert.equal(s.getJob("2").state, "running");
  assert.equal(s.getSnapshot().globalRunning, 1);
  // Duplicate completed is a no-op: no double clear / double release / double admit.
  s.onTransportResult("1", token, { status: "completed", failureCategory: null });
  assert.equal(clearCount, 1);
  assert.equal(s.getSnapshot().globalRunning, 1);
  assert.equal(countHeldSlots(s.getSnapshot()), 1);
  assert.equal("ephemeral" in s.getJob("1"), false);
  assert.equal("cookie" in s.getJob("1"), false);
  const snapJson = JSON.stringify(s.getSnapshot());
  assert.equal(snapJson.includes("secret"), false);
  assert.equal(snapJson.includes("ephemeral"), false);
  assertSlotInvariant(s);
});

test("wrong or stale attempt tokens are no-ops", () => {
  const s = makeScheduler({ maxConcurrent: 1 });
  s.createJob({
    id: "1",
    providerKey: "a.com",
    intent: intent("1.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.createJob({
    id: "2",
    providerKey: "b.com",
    intent: intent("2.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.enqueue("1");
  s.enqueue("2");
  const real = s.getJob("1").attemptToken;
  const v = s.getJob("1").stateVersion;
  s.onTransportResult("1", "wrong-token", { status: "completed", failureCategory: null });
  assert.equal(s.getJob("1").state, "running");
  assert.equal(s.getJob("1").holdsGlobalSlot, true);
  assert.equal(s.getJob("1").stateVersion, v);
  assert.equal(s.getJob("2").state, "queued");
  s.onTransportResult("1", null, { status: "completed", failureCategory: null });
  s.onTransportResult("1", "", { status: "completed", failureCategory: null });
  assert.equal(s.getJob("1").state, "running");
  s.onTransportResult("1", real, { status: "completed", failureCategory: null });
  assert.equal(s.getJob("1").state, "completed");
  assert.equal(s.getJob("2").state, "running");
  // Stale success after completion cannot revive or double-admit.
  s.onTransportResult("1", real, { status: "completed", failureCategory: null });
  assert.equal(s.getSnapshot().globalRunning, 1);
  assertSlotInvariant(s);
});

test("no-sibling saturation candidate enters retry_backoff, charges budget once, and releases slot", () => {
  const s = makeScheduler({ maxConcurrent: 1 });
  s.createJob({
    id: "1",
    providerKey: "a.com",
    intent: intent("1.mp4"),
    segmentConcurrency: 2,
    retries: 3,
  });
  s.createJob({
    id: "2",
    providerKey: "b.com",
    intent: intent("2.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.enqueue("1");
  s.enqueue("2");
  const before = s.getJob("1").retryRemaining;
  s.onTransportResult("1", s.getJob("1").attemptToken, {
    status: "failed",
    failureCategory: "timeout",
  });
  // Task 11: saturation-candidate with no viable same-provider sibling → retry_backoff.
  // Slot released; not waiting_provider; automatic retry budget charged atomically on entry.
  assert.equal(s.getJob("1").state, "retry_backoff");
  assert.notEqual(s.getJob("1").state, "waiting_provider");
  assert.equal(s.getJob("1").holdsGlobalSlot, false);
  assert.equal(s.getJob("1").retryRemaining, before - 1);
  assert.equal(s.getJob("2").state, "running");
  assertSlotInvariant(s);
});

// ---------------------------------------------------------------------------
// stateVersion monotonicity + slot invariant under duplicates
// ---------------------------------------------------------------------------

test("stateVersion increases on transitions and slot invariant holds under duplicate calls", () => {
  const s = makeScheduler({ maxConcurrent: 1 });
  const c = s.createJob({
    id: "j",
    providerKey: "p.com",
    intent: intent("j.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  const v0 = c.stateVersion;
  s.enqueue("j");
  const v1 = s.getJob("j").stateVersion;
  assert.ok(v1 > v0);
  s.enqueue("j");
  assert.equal(s.getJob("j").stateVersion, v1);
  const token = s.getJob("j").attemptToken;
  s.onTransportResult("j", token, { status: "completed", failureCategory: null });
  const v2 = s.getJob("j").stateVersion;
  assert.ok(v2 > v1);
  s.onTransportResult("j", token, { status: "completed", failureCategory: null });
  s.onTransportResult("j", token, { status: "completed", failureCategory: null });
  assert.equal(s.getJob("j").stateVersion, v2);
  assert.equal(s.getSnapshot().globalRunning, 0);
  assert.equal(countHeldSlots(s.getSnapshot()), 0);
  assertSlotInvariant(s);
});

// ---------------------------------------------------------------------------
// Snapshot / projection safety
// ---------------------------------------------------------------------------

test("getJob and getSnapshot return deep-frozen safe projections", () => {
  const s = makeScheduler({ maxConcurrent: 2 });
  s.createJob({
    id: "z",
    providerKey: "z.com",
    intent: intent("z.mp4"),
    segmentConcurrency: 2,
    retries: 1,
    ephemeral: {
      Authorization: "Bearer secret",
      clear() {},
    },
  });
  s.createJob({
    id: "a",
    providerKey: "a.com",
    intent: intent("a.mp4"),
    segmentConcurrency: 2,
    retries: 1,
  });
  s.enqueue("z");
  s.enqueue("a");

  const job = s.getJob("z");
  const snap = s.getSnapshot();
  assert.ok(Object.isFrozen(job));
  assert.ok(Object.isFrozen(snap));
  assert.ok(Object.isFrozen(snap.jobs));
  assert.ok(Object.isFrozen(job.intent));
  assert.equal("ephemeral" in job, false);
  assert.equal("Authorization" in job, false);

  // Deterministic job ordering (creation order).
  assert.deepEqual(
    snap.jobs.map(function (j) {
      return j.id;
    }),
    ["z", "a"]
  );
  assert.equal(typeof snap.maxConcurrent, "number");
  assert.equal(typeof snap.globalRunning, "number");
  assert.equal(typeof snap.providers, "object");
  assert.ok(Object.isFrozen(snap.providers));

  // Provider diagnostics are deterministic (sorted keys).
  const keys = Object.keys(snap.providers);
  assert.deepEqual(keys, keys.slice().sort());
  keys.forEach(function (k) {
    assert.ok(Object.isFrozen(snap.providers[k]));
    assert.ok(Array.isArray(snap.providers[k].queued));
    assert.ok(Array.isArray(snap.providers[k].running));
  });

  // Mutating projections must not affect live scheduler.
  assert.throws(() => {
    job.state = "failed";
  }, TypeError);
  assert.throws(() => {
    snap.jobs.push({});
  }, TypeError);
  assert.equal(s.getJob("z").state, "running");

  const json = JSON.stringify(snap);
  assert.equal(json.includes("Bearer"), false);
  assert.equal(json.includes("secret"), false);
  assert.equal(json.includes("ephemeral"), false);
  assertSlotInvariant(s);
});

// ---------------------------------------------------------------------------
// Dual export
// ---------------------------------------------------------------------------

test("download-scheduler dual-export assigns locked McDownloadScheduler global with identity", () => {
  // Mutation: else-branch only assigns one side, or creates two distinct objects.
  const abs = path.join(mediaCatcherRoot, "lib", "download-scheduler.js");
  const code = fs.readFileSync(abs, "utf8");
  const root = {};
  const sandbox = { module: { exports: {} }, exports: {}, require, console, self: root };
  sandbox.module.exports = sandbox.exports;
  vm.runInNewContext(code, sandbox, { filename: abs });
  assert.equal(typeof sandbox.module.exports.createDownloadScheduler, "function");
  assert.equal(typeof root.McDownloadScheduler.createDownloadScheduler, "function");
  assert.equal(root.McDownloadScheduler, sandbox.module.exports);
});

// ---------------------------------------------------------------------------
// Fix round 1: privacy allowlist, atomic admission, shape contracts
// ---------------------------------------------------------------------------

test("pre-frozen intent with secrets never projects extras; caller mutation is ignored", () => {
  // Mutation: Object.isFrozen passthrough stores signed URL / Cookie / nested secrets.
  const s = makeScheduler({ maxConcurrent: 1 });
  const nestedSecret = { Cookie: "session=evil-nested", token: "nested-sig" };
  const dirty = Object.freeze({
    requestedFilename: "safe.mp4",
    destinationDirectory: null,
    saveMode: "default",
    userSelectedFirefox: false,
    userActionToken: "t-action",
    createdAt: "t0",
    Cookie: "session=evil",
    Authorization: "Bearer secret-token",
    signedUrl: "https://cdn.example/x?sig=deadbeef",
    query: { sig: "deadbeef" },
    headers: Object.freeze({ Cookie: "x=1" }),
    sourceContext: Object.freeze({ mediaOrigin: "https://secret-origin" }),
    mediaOrigin: "https://cdn-secret",
    nested: nestedSecret,
  });
  const view = s.createJob({
    id: "priv",
    providerKey: "p.com",
    intent: dirty,
    segmentConcurrency: 1,
    retries: 1,
  });

  // Brand-new exact allowlist — not the frozen caller graph.
  assert.notEqual(view.intent, dirty);
  assert.ok(Object.isFrozen(view.intent));
  assert.deepEqual(Object.keys(view.intent).sort(), [
    "createdAt",
    "destinationDirectory",
    "requestedFilename",
    "saveMode",
    "userActionToken",
    "userSelectedFirefox",
  ]);
  assert.equal(view.intent.requestedFilename, "safe.mp4");
  assert.equal(view.intent.userActionToken, "t-action");
  assert.equal("Cookie" in view.intent, false);
  assert.equal("Authorization" in view.intent, false);
  assert.equal("signedUrl" in view.intent, false);
  assert.equal("query" in view.intent, false);
  assert.equal("headers" in view.intent, false);
  assert.equal("sourceContext" in view.intent, false);
  assert.equal("mediaOrigin" in view.intent, false);
  assert.equal("nested" in view.intent, false);

  // Mutating the caller graph after createJob must not alter scheduler view.
  nestedSecret.Cookie = "session=mutated-after-create";
  assert.equal(s.getJob("priv").intent.requestedFilename, "safe.mp4");
  assert.equal("Cookie" in s.getJob("priv").intent, false);
  assert.equal("nested" in s.getJob("priv").intent, false);

  const json = JSON.stringify(s.getSnapshot());
  assert.equal(json.includes("session=evil"), false);
  assert.equal(json.includes("secret-token"), false);
  assert.equal(json.includes("deadbeef"), false);
  assert.equal(json.includes("cdn-secret"), false);
  assert.equal(json.includes("secret-origin"), false);
  assert.equal(json.includes("mutated-after-create"), false);
  assertSlotInvariant(s);
});

test("object-shaped allowlisted intent fields and mediaKind are rejected before create", () => {
  // Mutation: freeze/publish object requestedFilename or object mediaKind aliases.
  const s = makeScheduler({ maxConcurrent: 1 });
  const badFilename = Object.freeze({
    requestedFilename: Object.freeze({ name: "evil.mp4", Cookie: "x" }),
    destinationDirectory: null,
    saveMode: "default",
    userSelectedFirefox: false,
    userActionToken: "t",
    createdAt: "t0",
  });
  assert.throws(
    () =>
      s.createJob({
        id: "bad-fn",
        providerKey: "p.com",
        intent: badFilename,
        segmentConcurrency: 1,
        retries: 1,
      }),
    TypeError
  );
  assert.equal(s.getJob("bad-fn"), null);

  assert.throws(
    () =>
      s.createJob({
        id: "bad-mk",
        providerKey: "p.com",
        intent: intent("a.mp4"),
        segmentConcurrency: 1,
        retries: 1,
        mediaKind: Object.freeze({ kind: "video", secret: "nested-alias" }),
      }),
    TypeError
  );
  assert.equal(s.getJob("bad-mk"), null);

  assert.throws(
    () =>
      s.createJob({
        id: "blank-mk",
        providerKey: "p.com",
        intent: intent("a.mp4"),
        segmentConcurrency: 1,
        retries: 1,
        mediaKind: "  ",
      }),
    TypeError
  );
  assert.equal(s.getJob("blank-mk"), null);

  const ok = s.createJob({
    id: "ok-mk",
    providerKey: "p.com",
    intent: intent("a.mp4"),
    segmentConcurrency: 1,
    retries: 1,
    mediaKind: "video",
  });
  assert.equal(ok.mediaKind, "video");
  assert.equal(s.getJob("ok-mk").mediaKind, "video");
  assert.equal(s.createJob({
    id: "null-mk",
    providerKey: "p.com",
    intent: intent("b.mp4"),
    segmentConcurrency: 1,
    retries: 1,
    mediaKind: null,
  }).mediaKind, null);
});

test("intent primitive contract rejects invalid types and blank required strings", () => {
  const s = makeScheduler({ maxConcurrent: 1 });
  function tryIntent(partial) {
    const base = {
      requestedFilename: "a.mp4",
      destinationDirectory: null,
      saveMode: "default",
      userSelectedFirefox: false,
      userActionToken: "t",
      createdAt: "t0",
    };
    return s.createJob({
      id: "x-" + Math.random().toString(36).slice(2, 10),
      providerKey: "p.com",
      intent: Object.assign(base, partial),
      segmentConcurrency: 1,
      retries: 1,
    });
  }
  assert.throws(() => tryIntent({ requestedFilename: "" }), TypeError);
  assert.throws(() => tryIntent({ requestedFilename: "  " }), TypeError);
  assert.throws(() => tryIntent({ requestedFilename: ["a.mp4"] }), TypeError);
  assert.throws(() => tryIntent({ userActionToken: "" }), TypeError);
  assert.throws(() => tryIntent({ userActionToken: function () {} }), TypeError);
  assert.throws(() => tryIntent({ destinationDirectory: "" }), TypeError);
  assert.throws(
    () => tryIntent({ destinationDirectory: Object.freeze({ path: "/tmp" }) }),
    TypeError
  );
  assert.throws(() => tryIntent({ saveMode: "download" }), TypeError);
  assert.throws(() => tryIntent({ saveMode: Object.freeze(["default"]) }), TypeError);
  assert.throws(() => tryIntent({ userSelectedFirefox: "yes" }), TypeError);
  assert.throws(() => tryIntent({ userSelectedFirefox: 1 }), TypeError);
  assert.throws(() => tryIntent({ createdAt: 123 }), TypeError);
  assert.throws(() => tryIntent({ createdAt: null }), TypeError);
  assert.throws(() => tryIntent({ createdAt: Object.freeze({ iso: "t0" }) }), TypeError);
  // No partial job creation on validation failure.
  assert.equal(s.getSnapshot().jobs.length, 0);
});

test("throwing randomToken hook still admits with slot invariant and no lost queue", () => {
  // Mutation: mint after state/queue mutation leaves running owner outside counter
  // or drops FIFO entry when entropy hook throws.
  let calls = 0;
  const s = createDownloadScheduler({
    maxConcurrent: 1,
    now: () => 0,
    randomToken: function () {
      calls += 1;
      throw new Error("entropy unavailable");
    },
  });
  s.createJob({
    id: "a",
    providerKey: "a.com",
    intent: intent("a.mp4"),
    segmentConcurrency: 1,
    retries: 1,
  });
  s.createJob({
    id: "b",
    providerKey: "b.com",
    intent: intent("b.mp4"),
    segmentConcurrency: 1,
    retries: 1,
  });

  // Enqueue must not throw; admit a, keep b queued.
  s.enqueue("a");
  s.enqueue("b");
  assert.ok(calls >= 1);
  assert.equal(s.getJob("a").state, "running");
  assert.equal(s.getJob("a").holdsGlobalSlot, true);
  assert.ok(typeof s.getJob("a").attemptToken === "string");
  assert.ok(s.getJob("a").attemptToken.trim().length > 0);
  assert.equal(s.getJob("b").state, "queued");
  assert.equal(s.getSnapshot().globalRunning, 1);
  assert.deepEqual(s.getSnapshot().providers["b.com"].queued.slice(), ["b"]);
  assertSlotInvariant(s);

  // Complete and drain next — second admit also survives the throwing hook.
  s.onTransportResult("a", s.getJob("a").attemptToken, {
    status: "completed",
    failureCategory: null,
  });
  assert.equal(s.getJob("b").state, "running");
  assert.equal(s.getJob("b").holdsGlobalSlot, true);
  assert.equal(s.getSnapshot().globalRunning, 1);
  assert.ok(s.getJob("b").attemptToken.trim().length > 0);
  assert.notEqual(s.getJob("b").attemptToken, s.getJob("a").attemptToken);
  assertSlotInvariant(s);
});

test("constant blank and non-string randomToken still yield unique nonblank tokens", () => {
  const blank = createDownloadScheduler({
    maxConcurrent: 2,
    now: () => 0,
    randomToken: () => "",
  });
  blank.createJob({
    id: "1",
    providerKey: "a.com",
    intent: intent("1.mp4"),
    segmentConcurrency: 1,
    retries: 1,
  });
  blank.createJob({
    id: "2",
    providerKey: "b.com",
    intent: intent("2.mp4"),
    segmentConcurrency: 1,
    retries: 1,
  });
  blank.enqueue("1");
  blank.enqueue("2");
  const t1 = blank.getJob("1").attemptToken;
  const t2 = blank.getJob("2").attemptToken;
  assert.ok(typeof t1 === "string" && t1.trim().length > 0);
  assert.ok(typeof t2 === "string" && t2.trim().length > 0);
  assert.notEqual(t1, t2);
  assertSlotInvariant(blank);

  const constant = createDownloadScheduler({
    maxConcurrent: 2,
    now: () => 0,
    randomToken: () => "same",
  });
  constant.createJob({
    id: "c1",
    providerKey: "a.com",
    intent: intent("c1.mp4"),
    segmentConcurrency: 1,
    retries: 1,
  });
  constant.createJob({
    id: "c2",
    providerKey: "b.com",
    intent: intent("c2.mp4"),
    segmentConcurrency: 1,
    retries: 1,
  });
  constant.enqueue("c1");
  constant.enqueue("c2");
  assert.notEqual(constant.getJob("c1").attemptToken, constant.getJob("c2").attemptToken);
  assertSlotInvariant(constant);

  const nonString = createDownloadScheduler({
    maxConcurrent: 1,
    now: () => 0,
    randomToken: () => 42,
  });
  nonString.createJob({
    id: "n1",
    providerKey: "a.com",
    intent: intent("n1.mp4"),
    segmentConcurrency: 1,
    retries: 1,
  });
  nonString.enqueue("n1");
  assert.ok(nonString.getJob("n1").attemptToken.trim().length > 0);
  assertSlotInvariant(nonString);
});
