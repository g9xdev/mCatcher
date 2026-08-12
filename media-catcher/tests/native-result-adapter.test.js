"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const { loadLib, mediaCatcherRoot } = require("./harness/load-lib.js");

const FLOREN_NAME = "11238-makemebi.net.mp4";

function loadAdapter() {
  return loadLib("lib/native-result-adapter.js");
}

function baseJob(overrides) {
  return Object.assign(
    {
      id: "j1",
      state: "running",
      attemptToken: "atk-1",
      mode: "multi-range",
      holdsGlobalSlot: true,
      retryRemaining: 3,
      retryUsed: 0,
      intent: Object.freeze({ requestedFilename: FLOREN_NAME }),
    },
    overrides || {}
  );
}

function fakeScheduler(job, opts) {
  const options = opts || {};
  const calls = { transport: [], capability: [], firefox: 0, starts: [] };
  const sched = {
    calls,
    getJob(id) {
      if (typeof options.getJob === "function") return options.getJob(id, job);
      return id === job.id ? job : null;
    },
    onTransportResult(id, token, result) {
      calls.transport.push({ id, token, result });
    },
    onCapabilitySwitch(id, info) {
      calls.capability.push({ id, info });
      if (options.refuseSwitch) return;
      if (options.onCapabilitySwitch) {
        options.onCapabilitySwitch(job, info);
        return;
      }
      job.mode = info.mode;
    },
  };
  return sched;
}

function optionsBag(started, firefoxHits) {
  return {
    startSingleConnection(j) {
      started.push(j);
    },
    firefoxDownload() {
      firefoxHits.count++;
    },
  };
}

function assertNoEffects(sched, firefoxHits, started) {
  assert.equal(sched.calls.transport.length, 0);
  assert.equal(sched.calls.capability.length, 0);
  assert.equal(firefoxHits.count, 0);
  assert.equal(started.length, 0);
}

function assertAllowlistedResult(result) {
  assert.deepEqual(Object.keys(result).sort(), [
    "failureCategory",
    "mode",
    "partState",
    "status",
  ]);
  assert.equal(
    Object.prototype.hasOwnProperty.call(result, "rawUrl") ||
      Object.prototype.hasOwnProperty.call(result, "cookie") ||
      Object.prototype.hasOwnProperty.call(result, "secret") ||
      Object.prototype.hasOwnProperty.call(result, "headers") ||
      Object.prototype.hasOwnProperty.call(result, "extra"),
    false
  );
}

// ---------------------------------------------------------------------------
// 1. Exact Florenfile capability switch
// ---------------------------------------------------------------------------

test("range_unsupported empty switches to single-connection without Firefox (Florenfile)", () => {
  const { handlePgetResult } = loadAdapter();
  const job = baseJob();
  const tokenBefore = job.attemptToken;
  const retriesBefore = job.retryRemaining;
  const slotBefore = job.holdsGlobalSlot;
  const sched = fakeScheduler(job);
  const started = [];
  const firefoxHits = { count: 0 };

  handlePgetResult(
    sched,
    {
      type: "pget-result",
      id: "j1",
      attemptToken: "atk-1",
      status: "failed",
      mode: "multi-range",
      failureCategory: "range_unsupported",
      partState: "empty",
      secret: "SHOULD-NOT-LEAK",
      rawUrl: "https://evil.example/x",
      cookie: "session=1",
    },
    optionsBag(started, firefoxHits)
  );

  assert.equal(firefoxHits.count, 0);
  assert.equal(sched.calls.capability.length, 1);
  assert.deepEqual(sched.calls.capability[0], {
    id: "j1",
    info: { mode: "single-connection", partState: "empty" },
  });
  assert.equal(job.mode, "single-connection");
  assert.equal(started.length, 1);
  assert.equal(started[0].intent.requestedFilename, FLOREN_NAME);
  assert.equal(started[0].attemptToken, tokenBefore);
  assert.equal(started[0].retryRemaining, retriesBefore);
  assert.equal(started[0].holdsGlobalSlot, slotBefore);
  assert.equal(job.attemptToken, tokenBefore);
  assert.equal(job.retryRemaining, retriesBefore);
  assert.equal(job.holdsGlobalSlot, slotBefore);
  assert.equal(sched.calls.transport.length, 0);
});

// ---------------------------------------------------------------------------
// 2. timeout / local_io forward once with allowlisted object; secrets stripped
// ---------------------------------------------------------------------------

test("timeout and local_io forward exactly once with allowlisted object; secrets stripped", () => {
  const { handlePgetResult } = loadAdapter();

  for (const [category, partState] of [
    ["timeout", "partial"],
    ["local_io", "empty"],
  ]) {
    const job = baseJob({ id: "j2", attemptToken: "atk-2" });
    const sched = fakeScheduler(job);
    const started = [];
    const firefoxHits = { count: 0 };
    handlePgetResult(
      sched,
      {
        type: "pget-result",
        id: "j2",
        attemptToken: "atk-2",
        status: "failed",
        mode: "multi-range",
        failureCategory: category,
        partState,
        secret: "nope",
        rawUrl: "https://x",
        cookie: "c=1",
        extra: { nested: true },
      },
      optionsBag(started, firefoxHits)
    );
    assert.equal(firefoxHits.count, 0);
    assert.equal(started.length, 0);
    assert.equal(sched.calls.capability.length, 0);
    assert.equal(sched.calls.transport.length, 1);
    const t = sched.calls.transport[0];
    assert.equal(t.id, "j2");
    assert.equal(t.token, "atk-2");
    assert.equal(t.result.status, "failed");
    assert.equal(t.result.mode, "multi-range");
    assert.equal(t.result.failureCategory, category);
    assert.equal(t.result.partState, partState);
    assertAllowlistedResult(t.result);
    // Fresh object: not the raw msg reference.
    assert.notEqual(t.result.secret, "nope");
  }
});

// ---------------------------------------------------------------------------
// 3. completed and cancelled
// ---------------------------------------------------------------------------

test("completed and cancelled forward with correct status/category/partState", () => {
  const { handlePgetResult } = loadAdapter();

  {
    const job = baseJob({ id: "jc", attemptToken: "atk-c" });
    const sched = fakeScheduler(job);
    const started = [];
    const firefoxHits = { count: 0 };
    handlePgetResult(
      sched,
      {
        type: "pget-result",
        id: "jc",
        attemptToken: "atk-c",
        status: "completed",
        mode: "multi-range",
        failureCategory: null,
        partState: "committed",
      },
      optionsBag(started, firefoxHits)
    );
    assert.equal(sched.calls.transport.length, 1);
    assert.deepEqual(sched.calls.transport[0].result, {
      status: "completed",
      mode: "multi-range",
      failureCategory: null,
      partState: "committed",
    });
    assert.equal(started.length, 0);
    assert.equal(firefoxHits.count, 0);
  }

  {
    const job = baseJob({ id: "jx", attemptToken: "atk-x" });
    const sched = fakeScheduler(job);
    const started = [];
    const firefoxHits = { count: 0 };
    handlePgetResult(
      sched,
      {
        type: "pget-result",
        id: "jx",
        attemptToken: "atk-x",
        status: "cancelled",
        mode: "multi-range",
        failureCategory: null, // normalized to cancelled
        partState: "partial",
      },
      optionsBag(started, firefoxHits)
    );
    assert.equal(sched.calls.transport.length, 1);
    assert.deepEqual(sched.calls.transport[0].result, {
      status: "cancelled",
      mode: "multi-range",
      failureCategory: "cancelled",
      partState: "partial",
    });
    assert.equal(started.length, 0);
    assert.equal(firefoxHits.count, 0);
  }
});

// ---------------------------------------------------------------------------
// 4. stale / unknown / non-running / missing fields / malformed combos
// ---------------------------------------------------------------------------

test("stale token, unknown job, non-running, missing fields, malformed combos: zero effects", () => {
  const { handlePgetResult } = loadAdapter();
  const cases = [];

  // stale token
  cases.push({
    job: baseJob({ attemptToken: "fresh" }),
    msg: {
      type: "pget-result",
      id: "j1",
      attemptToken: "stale",
      status: "completed",
      mode: "multi-range",
      failureCategory: null,
      partState: "committed",
    },
  });

  // unknown job
  cases.push({
    job: baseJob({ id: "other" }),
    msg: {
      type: "pget-result",
      id: "j1",
      attemptToken: "atk-1",
      status: "failed",
      mode: "multi-range",
      failureCategory: "timeout",
      partState: "partial",
    },
  });

  // non-running
  cases.push({
    job: baseJob({ state: "queued" }),
    msg: {
      type: "pget-result",
      id: "j1",
      attemptToken: "atk-1",
      status: "failed",
      mode: "multi-range",
      failureCategory: "timeout",
      partState: "partial",
    },
  });

  // missing type
  cases.push({
    job: baseJob(),
    msg: {
      id: "j1",
      attemptToken: "atk-1",
      status: "failed",
      mode: "multi-range",
      failureCategory: "timeout",
      partState: "partial",
    },
  });

  // wrong type
  cases.push({
    job: baseJob(),
    msg: {
      type: "pget-fallback",
      id: "j1",
      attemptToken: "atk-1",
      status: "failed",
      mode: "multi-range",
      failureCategory: "timeout",
      partState: "partial",
    },
  });

  // blank id
  cases.push({
    job: baseJob(),
    msg: {
      type: "pget-result",
      id: "  ",
      attemptToken: "atk-1",
      status: "failed",
      mode: "multi-range",
      failureCategory: "timeout",
      partState: "partial",
    },
  });

  // blank token
  cases.push({
    job: baseJob(),
    msg: {
      type: "pget-result",
      id: "j1",
      attemptToken: "",
      status: "failed",
      mode: "multi-range",
      failureCategory: "timeout",
      partState: "partial",
    },
  });

  // missing status
  cases.push({
    job: baseJob(),
    msg: {
      type: "pget-result",
      id: "j1",
      attemptToken: "atk-1",
      mode: "multi-range",
      failureCategory: "timeout",
      partState: "partial",
    },
  });

  // missing attemptToken
  cases.push({
    job: baseJob(),
    msg: {
      type: "pget-result",
      id: "j1",
      status: "failed",
      mode: "multi-range",
      failureCategory: "timeout",
      partState: "partial",
    },
  });

  // completed without committed
  cases.push({
    job: baseJob(),
    msg: {
      type: "pget-result",
      id: "j1",
      attemptToken: "atk-1",
      status: "completed",
      mode: "multi-range",
      failureCategory: null,
      partState: "partial",
    },
  });

  // completed with non-null category
  cases.push({
    job: baseJob(),
    msg: {
      type: "pget-result",
      id: "j1",
      attemptToken: "atk-1",
      status: "completed",
      mode: "multi-range",
      failureCategory: "permanent",
      partState: "committed",
    },
  });

  // failed + committed (invalid Task-13 terminal)
  cases.push({
    job: baseJob(),
    msg: {
      type: "pget-result",
      id: "j1",
      attemptToken: "atk-1",
      status: "failed",
      mode: "multi-range",
      failureCategory: "local_io",
      partState: "committed",
    },
  });

  // unknown status
  cases.push({
    job: baseJob(),
    msg: {
      type: "pget-result",
      id: "j1",
      attemptToken: "atk-1",
      status: "running",
      mode: "multi-range",
      failureCategory: null,
      partState: "empty",
    },
  });

  // unknown mode
  cases.push({
    job: baseJob(),
    msg: {
      type: "pget-result",
      id: "j1",
      attemptToken: "atk-1",
      status: "failed",
      mode: "parallel",
      failureCategory: "timeout",
      partState: "partial",
    },
  });

  // unknown partState
  cases.push({
    job: baseJob(),
    msg: {
      type: "pget-result",
      id: "j1",
      attemptToken: "atk-1",
      status: "failed",
      mode: "multi-range",
      failureCategory: "timeout",
      partState: "dirty",
    },
  });

  // job missing live token
  cases.push({
    job: baseJob({ attemptToken: null }),
    msg: {
      type: "pget-result",
      id: "j1",
      attemptToken: "atk-1",
      status: "failed",
      mode: "multi-range",
      failureCategory: "timeout",
      partState: "partial",
    },
  });

  // null msg
  cases.push({ job: baseJob(), msg: null });

  // non-object msg
  cases.push({ job: baseJob(), msg: "pget-result" });

  for (const c of cases) {
    const sched = fakeScheduler(c.job);
    const started = [];
    const firefoxHits = { count: 0 };
    handlePgetResult(sched, c.msg, optionsBag(started, firefoxHits));
    assertNoEffects(sched, firefoxHits, started);
  }
});

// ---------------------------------------------------------------------------
// 5. mode mismatch + duplicate range-switch after switch
// ---------------------------------------------------------------------------

test("mode mismatch and duplicate range-switch after switch are ignored", () => {
  const { handlePgetResult } = loadAdapter();

  // Late multi-range completed after job already single-connection.
  {
    const job = baseJob({ mode: "single-connection", attemptToken: "atk-1" });
    const sched = fakeScheduler(job);
    const started = [];
    const firefoxHits = { count: 0 };
    handlePgetResult(
      sched,
      {
        type: "pget-result",
        id: "j1",
        attemptToken: "atk-1",
        status: "completed",
        mode: "multi-range",
        failureCategory: null,
        partState: "committed",
      },
      optionsBag(started, firefoxHits)
    );
    assertNoEffects(sched, firefoxHits, started);
  }

  // Late multi-range failed after single mode.
  {
    const job = baseJob({ mode: "single-connection", attemptToken: "atk-1" });
    const sched = fakeScheduler(job);
    const started = [];
    const firefoxHits = { count: 0 };
    handlePgetResult(
      sched,
      {
        type: "pget-result",
        id: "j1",
        attemptToken: "atk-1",
        status: "failed",
        mode: "multi-range",
        failureCategory: "timeout",
        partState: "partial",
      },
      optionsBag(started, firefoxHits)
    );
    assertNoEffects(sched, firefoxHits, started);
  }

  // First switch succeeds; duplicate multi-range range_unsupported does not start twice
  // or terminalize the single attempt.
  {
    const job = baseJob();
    const sched = fakeScheduler(job);
    const started = [];
    const firefoxHits = { count: 0 };
    const msg = {
      type: "pget-result",
      id: "j1",
      attemptToken: "atk-1",
      status: "failed",
      mode: "multi-range",
      failureCategory: "range_unsupported",
      partState: "empty",
    };
    handlePgetResult(sched, msg, optionsBag(started, firefoxHits));
    assert.equal(sched.calls.capability.length, 1);
    assert.equal(started.length, 1);
    assert.equal(job.mode, "single-connection");

    handlePgetResult(sched, msg, optionsBag(started, firefoxHits));
    assert.equal(sched.calls.capability.length, 1); // no second switch
    assert.equal(started.length, 1); // no second start
    assert.equal(sched.calls.transport.length, 0); // not terminalized
    assert.equal(firefoxHits.count, 0);
    assert.equal(job.attemptToken, "atk-1");
    assert.equal(job.state, "running");
  }
});

// ---------------------------------------------------------------------------
// 6. range_unsupported partial is ordinary failure; empty switch no retry/transport
// ---------------------------------------------------------------------------

test("range_unsupported partial routes ordinary failure; empty switch does not transport or retry", () => {
  const { handlePgetResult } = loadAdapter();

  {
    const job = baseJob({ retryRemaining: 5 });
    const sched = fakeScheduler(job);
    const started = [];
    const firefoxHits = { count: 0 };
    handlePgetResult(
      sched,
      {
        type: "pget-result",
        id: "j1",
        attemptToken: "atk-1",
        status: "failed",
        mode: "multi-range",
        failureCategory: "range_unsupported",
        partState: "partial",
      },
      optionsBag(started, firefoxHits)
    );
    assert.equal(started.length, 0);
    assert.equal(sched.calls.capability.length, 0);
    assert.equal(sched.calls.transport.length, 1);
    assert.deepEqual(sched.calls.transport[0].result, {
      status: "failed",
      mode: "multi-range",
      failureCategory: "range_unsupported",
      partState: "partial",
    });
    assert.equal(job.retryRemaining, 5); // adapter itself does not consume
    assert.equal(firefoxHits.count, 0);
  }

  {
    const job = baseJob({ retryRemaining: 4 });
    const sched = fakeScheduler(job);
    const started = [];
    const firefoxHits = { count: 0 };
    handlePgetResult(
      sched,
      {
        type: "pget-result",
        id: "j1",
        attemptToken: "atk-1",
        status: "failed",
        mode: "multi-range",
        failureCategory: "range_unsupported",
        partState: "empty",
      },
      optionsBag(started, firefoxHits)
    );
    assert.equal(sched.calls.capability.length, 1);
    assert.equal(started.length, 1);
    assert.equal(sched.calls.transport.length, 0);
    assert.equal(job.retryRemaining, 4);
    assert.equal(firefoxHits.count, 0);
  }
});

// ---------------------------------------------------------------------------
// 7. scheduler refuses switch → start not called
// ---------------------------------------------------------------------------

test("scheduler refuses switch: start callback not called", () => {
  const { handlePgetResult } = loadAdapter();

  // refuseSwitch leaves mode multi-range
  {
    const job = baseJob();
    const sched = fakeScheduler(job, { refuseSwitch: true });
    const started = [];
    const firefoxHits = { count: 0 };
    handlePgetResult(
      sched,
      {
        type: "pget-result",
        id: "j1",
        attemptToken: "atk-1",
        status: "failed",
        mode: "multi-range",
        failureCategory: "range_unsupported",
        partState: "empty",
      },
      optionsBag(started, firefoxHits)
    );
    assert.equal(sched.calls.capability.length, 1);
    assert.equal(job.mode, "multi-range");
    assert.equal(started.length, 0);
    assert.equal(sched.calls.transport.length, 0);
    assert.equal(firefoxHits.count, 0);
  }

  // cancel changes state after switch
  {
    const job = baseJob();
    const sched = fakeScheduler(job, {
      onCapabilitySwitch(j) {
        j.mode = "single-connection";
        j.state = "cancelled";
      },
    });
    const started = [];
    const firefoxHits = { count: 0 };
    handlePgetResult(
      sched,
      {
        type: "pget-result",
        id: "j1",
        attemptToken: "atk-1",
        status: "failed",
        mode: "multi-range",
        failureCategory: "range_unsupported",
        partState: "empty",
      },
      optionsBag(started, firefoxHits)
    );
    assert.equal(sched.calls.capability.length, 1);
    assert.equal(started.length, 0);
    assert.equal(firefoxHits.count, 0);
  }
});

// ---------------------------------------------------------------------------
// 8. start callback throw propagates; no Firefox/transport/second start
// ---------------------------------------------------------------------------

test("startSingleConnection throw propagates after switch; no Firefox or transport", () => {
  const { handlePgetResult } = loadAdapter();
  const job = baseJob();
  const sched = fakeScheduler(job);
  let starts = 0;
  const firefoxHits = { count: 0 };
  assert.throws(() => {
    handlePgetResult(
      sched,
      {
        type: "pget-result",
        id: "j1",
        attemptToken: "atk-1",
        status: "failed",
        mode: "multi-range",
        failureCategory: "range_unsupported",
        partState: "empty",
      },
      {
        startSingleConnection() {
          starts++;
          throw new Error("helper-unavailable");
        },
        firefoxDownload() {
          firefoxHits.count++;
        },
      }
    );
  }, /helper-unavailable/);
  assert.equal(starts, 1);
  assert.equal(sched.calls.capability.length, 1);
  assert.equal(job.mode, "single-connection");
  assert.equal(sched.calls.transport.length, 0);
  assert.equal(firefoxHits.count, 0);
});

// ---------------------------------------------------------------------------
// 9. frozen/hostile input; getter extras do not forward raw or touch Firefox
// ---------------------------------------------------------------------------

test("frozen/hostile input and getter extras do not raw-forward or access Firefox", () => {
  const { handlePgetResult } = loadAdapter();
  const job = baseJob({ id: "jh", attemptToken: "atk-h" });
  const sched = fakeScheduler(job);
  const started = [];
  let firefoxAccesses = 0;

  const msg = Object.freeze({
    type: "pget-result",
    id: "jh",
    attemptToken: "atk-h",
    status: "failed",
    mode: "multi-range",
    failureCategory: "connection_reset",
    partState: "partial",
    secret: "hidden",
  });

  const opts = {};
  Object.defineProperty(opts, "firefoxDownload", {
    enumerable: true,
    get() {
      firefoxAccesses++;
      return () => {
        firefoxAccesses++;
      };
    },
  });
  opts.startSingleConnection = (j) => {
    started.push(j);
  };

  handlePgetResult(sched, msg, opts);
  assert.equal(firefoxAccesses, 0);
  assert.equal(started.length, 0);
  assert.equal(sched.calls.transport.length, 1);
  assertAllowlistedResult(sched.calls.transport[0].result);
  assert.equal(sched.calls.transport[0].result.failureCategory, "connection_reset");

  // Hostile scheduler methods: fail closed.
  const hostile = {
    getJob() {
      throw new Error("boom");
    },
    onTransportResult() {
      throw new Error("should-not-run");
    },
    onCapabilitySwitch() {
      throw new Error("should-not-run");
    },
  };
  assert.doesNotThrow(() => {
    handlePgetResult(
      hostile,
      {
        type: "pget-result",
        id: "j1",
        attemptToken: "atk-1",
        status: "failed",
        mode: "multi-range",
        failureCategory: "timeout",
        partState: "partial",
      },
      {
        startSingleConnection() {
          throw new Error("should-not-start");
        },
        get firefoxDownload() {
          firefoxAccesses++;
          return () => {};
        },
      }
    );
  });
  assert.equal(firefoxAccesses, 0);

  // Null / non-object options: fail closed for ordinary result (no throw required).
  const job2 = baseJob({ id: "j2", attemptToken: "atk-2" });
  const sched2 = fakeScheduler(job2);
  assert.doesNotThrow(() => {
    handlePgetResult(
      sched2,
      {
        type: "pget-result",
        id: "j2",
        attemptToken: "atk-2",
        status: "failed",
        mode: "multi-range",
        failureCategory: "timeout",
        partState: "partial",
      },
      null
    );
  });
  // Transport may still forward if options only gate start; either fail-closed zero
  // effects or transport-only is acceptable as long as no Firefox/start. Lock:
  // no start callback available, no throw.
  assert.equal(sched2.calls.capability.length, 0);
});

// ---------------------------------------------------------------------------
// 10. Export names + source hygiene
// ---------------------------------------------------------------------------

test("CommonJS export and browser global name are exact McNativeResultAdapter", () => {
  const nodeExport = loadAdapter();
  assert.equal(typeof nodeExport.handlePgetResult, "function");

  const abs = path.join(mediaCatcherRoot, "lib", "native-result-adapter.js");
  const code = fs.readFileSync(abs, "utf8");
  const root = {};
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require,
    console,
    self: root,
  };
  sandbox.module.exports = sandbox.exports;
  vm.runInNewContext(code, sandbox, { filename: abs });
  assert.equal(typeof root.McNativeResultAdapter.handlePgetResult, "function");
  assert.equal(root.McNativeResultAdapter, sandbox.module.exports);
  assert.equal(
    Object.keys(root).includes("McNativeResultAdapter"),
    true
  );
});

test("module source has no downloads.download, browser.downloads, or pget-fallback path", () => {
  const abs = path.join(mediaCatcherRoot, "lib", "native-result-adapter.js");
  const src = fs.readFileSync(abs, "utf8");
  assert.equal(/downloads\.download/.test(src), false);
  assert.equal(/browser\.downloads/.test(src), false);
  assert.equal(/pget-fallback/.test(src), false);
  assert.equal(/firefoxDownload/.test(src), false);
});

// ---------------------------------------------------------------------------
// Extra locked behaviors
// ---------------------------------------------------------------------------

test("failed missing/unknown category normalizes to permanent when structurally valid", () => {
  const { handlePgetResult } = loadAdapter();
  for (const cat of [undefined, null, "weird", "RANGE_UNSUPPORTED", ""]) {
    const job = baseJob({ id: "jp", attemptToken: "atk-p" });
    const sched = fakeScheduler(job);
    const started = [];
    const firefoxHits = { count: 0 };
    const msg = {
      type: "pget-result",
      id: "jp",
      attemptToken: "atk-p",
      status: "failed",
      mode: "multi-range",
      partState: "empty",
    };
    if (cat !== undefined) msg.failureCategory = cat;
    handlePgetResult(sched, msg, optionsBag(started, firefoxHits));
    assert.equal(sched.calls.transport.length, 1, `cat=${cat}`);
    assert.equal(sched.calls.transport[0].result.failureCategory, "permanent");
    assert.equal(started.length, 0);
    assert.equal(firefoxHits.count, 0);
  }
});

test("cancelled with empty/partial/committed part states normalizes category", () => {
  const { handlePgetResult } = loadAdapter();
  for (const partState of ["empty", "partial", "committed"]) {
    const job = baseJob({ id: "jz", attemptToken: "atk-z", mode: "single-connection" });
    const sched = fakeScheduler(job);
    const started = [];
    const firefoxHits = { count: 0 };
    handlePgetResult(
      sched,
      {
        type: "pget-result",
        id: "jz",
        attemptToken: "atk-z",
        status: "cancelled",
        mode: "single-connection",
        failureCategory: "timeout",
        partState,
      },
      optionsBag(started, firefoxHits)
    );
    assert.equal(sched.calls.transport.length, 1);
    assert.deepEqual(sched.calls.transport[0].result, {
      status: "cancelled",
      mode: "single-connection",
      failureCategory: "cancelled",
      partState,
    });
    assert.equal(started.length, 0);
  }
});

test("matching-mode single-connection ordinary results forward", () => {
  const { handlePgetResult } = loadAdapter();
  const job = baseJob({ mode: "single-connection", attemptToken: "atk-s" });
  const sched = fakeScheduler(job);
  const started = [];
  const firefoxHits = { count: 0 };
  handlePgetResult(
    sched,
    {
      type: "pget-result",
      id: "j1",
      attemptToken: "atk-s",
      status: "completed",
      mode: "single-connection",
      failureCategory: null,
      partState: "committed",
    },
    optionsBag(started, firefoxHits)
  );
  assert.equal(sched.calls.transport.length, 1);
  assert.equal(sched.calls.transport[0].result.mode, "single-connection");
  assert.equal(started.length, 0);
  assert.equal(firefoxHits.count, 0);
});
