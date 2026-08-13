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
  const calls = { transport: [], capability: [], draining: [], firefox: 0, starts: [] };
  const sched = {
    calls,
    getJob(id) {
      if (typeof options.getJob === "function") return options.getJob(id, job);
      return id === job.id ? job : null;
    },
    onTransportResult(id, token, result) {
      calls.transport.push({ id, token, result });
    },
    onDrainingTransportResult(id, token, result) {
      calls.draining.push({ id, token, result });
      if (typeof options.onDrainingTransportResult === "function") {
        return options.onDrainingTransportResult(id, token, result);
      }
      return true;
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
  assert.equal(sched.calls.draining.length, 0);
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
        failureCategory: "cancelled",
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

// ---------------------------------------------------------------------------
// 11. invalid startSingleConnection on exact empty multi-range switch path
//     must not call onCapabilitySwitch (job must stay multi-range)
// ---------------------------------------------------------------------------

function rangeUnsupportedEmptyMsg(overrides) {
  return Object.assign(
    {
      type: "pget-result",
      id: "j1",
      attemptToken: "atk-1",
      status: "failed",
      mode: "multi-range",
      failureCategory: "range_unsupported",
      partState: "empty",
    },
    overrides || {}
  );
}

function assertSwitchPathNoEffects(sched, job, firefoxHits, started) {
  assert.equal(sched.calls.capability.length, 0, "no capability switch");
  assert.equal(sched.calls.transport.length, 0, "no transport");
  assert.equal(started.length, 0, "no start");
  assert.equal(firefoxHits.count, 0, "no firefox calls/accesses");
  assert.equal(job.mode, "multi-range", "job stays multi-range");
  assert.equal(job.state, "running");
}

test("switch path with missing options/callback: no capability mutation", () => {
  const { handlePgetResult } = loadAdapter();

  for (const opts of [undefined, null, {}, { firefoxDownload() {} }]) {
    const job = baseJob();
    const sched = fakeScheduler(job); // onCapabilitySwitch would mutate mode
    const started = [];
    const firefoxHits = { count: 0 };
    assert.doesNotThrow(() => {
      handlePgetResult(sched, rangeUnsupportedEmptyMsg(), opts);
    });
    assertSwitchPathNoEffects(sched, job, firefoxHits, started);
  }
});

test("switch path with non-function startSingleConnection: no capability mutation", () => {
  const { handlePgetResult } = loadAdapter();

  for (const bad of ["not-a-fn", 0, 1, true, false, { call() {} }, []]) {
    const job = baseJob();
    const sched = fakeScheduler(job); // onCapabilitySwitch would mutate mode
    const started = [];
    const firefoxHits = { count: 0 };
    assert.doesNotThrow(() => {
      handlePgetResult(sched, rangeUnsupportedEmptyMsg(), {
        startSingleConnection: bad,
        firefoxDownload() {
          firefoxHits.count++;
        },
      });
    });
    assertSwitchPathNoEffects(sched, job, firefoxHits, started);
  }
});

test("switch path with throwing startSingleConnection getter: no capability mutation", () => {
  const { handlePgetResult } = loadAdapter();
  const job = baseJob();
  const sched = fakeScheduler(job); // onCapabilitySwitch would mutate mode
  const started = [];
  let firefoxAccesses = 0;
  const opts = {};
  Object.defineProperty(opts, "startSingleConnection", {
    enumerable: true,
    get() {
      throw new Error("start-getter-boom");
    },
  });
  Object.defineProperty(opts, "firefoxDownload", {
    enumerable: true,
    get() {
      firefoxAccesses++;
      return () => {
        firefoxAccesses++;
      };
    },
  });

  assert.doesNotThrow(() => {
    handlePgetResult(sched, rangeUnsupportedEmptyMsg(), opts);
  });
  assert.equal(sched.calls.capability.length, 0, "no capability switch");
  assert.equal(sched.calls.transport.length, 0, "no transport");
  assert.equal(started.length, 0, "no start");
  assert.equal(firefoxAccesses, 0, "no firefox access");
  assert.equal(job.mode, "multi-range", "job stays multi-range");
  assert.equal(job.state, "running");
});

// ---------------------------------------------------------------------------
// 11. Task 20D: pausing_provider terminals delegate to onDrainingTransportResult
// ---------------------------------------------------------------------------

test("pausing_provider completed delegates only allowlisted fields to onDrainingTransportResult", () => {
  const { handlePgetResult } = loadAdapter();
  const job = baseJob({
    state: "pausing_provider",
    attemptToken: null, // public identity is null while draining
  });
  const sched = fakeScheduler(job);
  const started = [];
  const firefoxHits = { count: 0 };

  handlePgetResult(
    sched,
    {
      type: "pget-result",
      id: "j1",
      attemptToken: "atk-drain-1",
      status: "completed",
      mode: "multi-range",
      failureCategory: null,
      partState: "committed",
      secret: "SHOULD-NOT-LEAK",
      rawUrl: "https://evil.example/x",
      cookie: "session=1",
    },
    optionsBag(started, firefoxHits)
  );

  assert.equal(firefoxHits.count, 0);
  assert.equal(started.length, 0);
  assert.equal(sched.calls.capability.length, 0);
  assert.equal(sched.calls.transport.length, 0);
  assert.equal(sched.calls.draining.length, 1);
  assert.equal(sched.calls.draining[0].id, "j1");
  assert.equal(sched.calls.draining[0].token, "atk-drain-1");
  assert.deepEqual(sched.calls.draining[0].result, {
    status: "completed",
    mode: "multi-range",
    failureCategory: null,
    partState: "committed",
  });
  assertAllowlistedResult(sched.calls.draining[0].result);
  assert.equal(
    Object.prototype.hasOwnProperty.call(sched.calls.draining[0].result, "secret"),
    false
  );
});

test("pausing_provider failed/cancelled allowlist to draining API; never startSingleConnection", () => {
  const { handlePgetResult } = loadAdapter();

  for (const [status, category, partState, outCategory] of [
    ["failed", "timeout", "partial", "timeout"],
    ["failed", "local_io", "empty", "local_io"],
    ["failed", "range_unsupported", "empty", "range_unsupported"],
    ["cancelled", null, "partial", "cancelled"],
  ]) {
    const job = baseJob({
      id: "jp",
      state: "pausing_provider",
      attemptToken: null,
    });
    const sched = fakeScheduler(job);
    const started = [];
    const firefoxHits = { count: 0 };
    handlePgetResult(
      sched,
      {
        type: "pget-result",
        id: "jp",
        attemptToken: "old-atk",
        status,
        mode: "multi-range",
        failureCategory: category,
        partState,
      },
      optionsBag(started, firefoxHits)
    );
    assert.equal(started.length, 0, status);
    assert.equal(firefoxHits.count, 0, status);
    assert.equal(sched.calls.capability.length, 0, status);
    assert.equal(sched.calls.transport.length, 0, status);
    assert.equal(sched.calls.draining.length, 1, status);
    assert.deepEqual(sched.calls.draining[0].result, {
      status,
      mode: "multi-range",
      failureCategory: outCategory,
      partState,
    });
    assertAllowlistedResult(sched.calls.draining[0].result);
  }
});

test("pausing_provider failed+cancelled category only hits draining API; never start/Firefox", () => {
  const { handlePgetResult } = loadAdapter();
  const job = baseJob({
    id: "jfc",
    state: "pausing_provider",
    attemptToken: null,
  });
  const sched = fakeScheduler(job);
  const started = [];
  const firefoxHits = { count: 0 };

  handlePgetResult(
    sched,
    {
      type: "pget-result",
      id: "jfc",
      attemptToken: "old-atk-fc",
      status: "failed",
      mode: "multi-range",
      failureCategory: "cancelled",
      partState: "partial",
      cookie: "session=should-not-leak",
      url: "https://evil.example/x",
    },
    optionsBag(started, firefoxHits)
  );

  assert.equal(started.length, 0);
  assert.equal(firefoxHits.count, 0);
  assert.equal(sched.calls.capability.length, 0);
  assert.equal(sched.calls.transport.length, 0);
  assert.equal(sched.calls.draining.length, 1);
  assert.equal(sched.calls.draining[0].id, "jfc");
  assert.equal(sched.calls.draining[0].token, "old-atk-fc");
  assert.deepEqual(sched.calls.draining[0].result, {
    status: "failed",
    mode: "multi-range",
    failureCategory: "cancelled",
    partState: "partial",
  });
  assertAllowlistedResult(sched.calls.draining[0].result);
  assert.equal(
    Object.prototype.hasOwnProperty.call(sched.calls.draining[0].result, "cookie"),
    false
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(sched.calls.draining[0].result, "url"),
    false
  );
});

test("pausing_provider never accepts public null as identity; never Firefox; malformed inert", () => {
  const { handlePgetResult } = loadAdapter();
  const job = baseJob({
    state: "pausing_provider",
    attemptToken: null,
  });

  // Missing attemptToken in msg — inert (cannot authenticate).
  {
    const sched = fakeScheduler(job);
    const started = [];
    const firefoxHits = { count: 0 };
    handlePgetResult(
      sched,
      {
        type: "pget-result",
        id: "j1",
        attemptToken: null,
        status: "completed",
        mode: "multi-range",
        failureCategory: null,
        partState: "committed",
      },
      optionsBag(started, firefoxHits)
    );
    assertNoEffects(sched, firefoxHits, started);
  }

  // Blank token
  {
    const sched = fakeScheduler(job);
    const started = [];
    const firefoxHits = { count: 0 };
    handlePgetResult(
      sched,
      {
        type: "pget-result",
        id: "j1",
        attemptToken: "  ",
        status: "completed",
        mode: "multi-range",
        failureCategory: null,
        partState: "committed",
      },
      optionsBag(started, firefoxHits)
    );
    assertNoEffects(sched, firefoxHits, started);
  }

  // completed without committed
  {
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
        partState: "partial",
      },
      optionsBag(started, firefoxHits)
    );
    assertNoEffects(sched, firefoxHits, started);
  }

  // failed + committed
  {
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
        partState: "committed",
      },
      optionsBag(started, firefoxHits)
    );
    assertNoEffects(sched, firefoxHits, started);
  }

  // mode mismatch while pausing
  {
    const job2 = baseJob({
      state: "pausing_provider",
      attemptToken: null,
      mode: "single-connection",
    });
    const sched = fakeScheduler(job2);
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

  // range_unsupported empty while pausing must NOT capability-switch/start
  {
    const job3 = baseJob({
      state: "pausing_provider",
      attemptToken: null,
      mode: "multi-range",
    });
    const sched = fakeScheduler(job3);
    const started = [];
    const firefoxHits = { count: 0 };
    handlePgetResult(
      sched,
      {
        type: "pget-result",
        id: "j1",
        attemptToken: "atk-old",
        status: "failed",
        mode: "multi-range",
        failureCategory: "range_unsupported",
        partState: "empty",
      },
      optionsBag(started, firefoxHits)
    );
    assert.equal(sched.calls.capability.length, 0);
    assert.equal(started.length, 0);
    assert.equal(sched.calls.transport.length, 0);
    assert.equal(sched.calls.draining.length, 1);
    assert.equal(sched.calls.draining[0].result.failureCategory, "range_unsupported");
    assert.equal(job3.mode, "multi-range");
    assert.equal(firefoxHits.count, 0);
  }

  // Missing onDrainingTransportResult: fail closed
  {
    const sched = {
      calls: { transport: [], capability: [], draining: [] },
      getJob() {
        return job;
      },
      onTransportResult() {
        sched.calls.transport.push(1);
      },
    };
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
    assert.equal(sched.calls.transport.length, 0);
    assert.equal(started.length, 0);
    assert.equal(firefoxHits.count, 0);
  }
});

test("running range_unsupported empty still switches and starts; draining path untouched", () => {
  const { handlePgetResult } = loadAdapter();
  const job = baseJob({ state: "running", attemptToken: "atk-1", mode: "multi-range" });
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
  assert.equal(sched.calls.draining.length, 0);
  assert.equal(sched.calls.transport.length, 0);
  assert.equal(job.mode, "single-connection");
  assert.equal(firefoxHits.count, 0);
});

test("replayed/wrong-state draining messages remain inert for non-pausing jobs", () => {
  const { handlePgetResult } = loadAdapter();
  for (const state of ["waiting_provider", "queued", "completed", "needs_user"]) {
    const job = baseJob({ state, attemptToken: null });
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
});

// ---------------------------------------------------------------------------
// 12. Task20 hardening: null-proto allowlists, own DATA descriptors, category rules
// ---------------------------------------------------------------------------

function baseWireMsg(overrides) {
  return Object.assign(
    {
      type: "pget-result",
      id: "j1",
      attemptToken: "atk-1",
      status: "completed",
      mode: "multi-range",
      failureCategory: null,
      partState: "committed",
    },
    overrides || {}
  );
}

test("inherited Object.prototype keys are rejected in every enum position (running + pausing)", () => {
  const { handlePgetResult } = loadAdapter();
  const inheritedKeys = ["__proto__", "constructor", "toString", "valueOf"];

  // status / mode / partState: inherited membership must never pass either path.
  const enumPositions = [
    { field: "status", rest: { mode: "multi-range", partState: "committed", failureCategory: null } },
    { field: "mode", rest: { status: "completed", partState: "committed", failureCategory: null } },
    {
      field: "partState",
      rest: { status: "cancelled", mode: "multi-range", failureCategory: "cancelled" },
    },
  ];

  for (const state of ["running", "pausing_provider"]) {
    for (const pos of enumPositions) {
      for (const key of inheritedKeys) {
        const job = baseJob({
          state,
          attemptToken: state === "pausing_provider" ? null : "atk-1",
        });
        const sched = fakeScheduler(job);
        const started = [];
        const firefoxHits = { count: 0 };
        const msg = baseWireMsg(
          Object.assign({}, pos.rest, {
            [pos.field]: key,
            attemptToken: state === "pausing_provider" ? "atk-drain" : "atk-1",
          })
        );
        handlePgetResult(sched, msg, optionsBag(started, firefoxHits));
        assertNoEffects(sched, firefoxHits, started);
      }
    }
  }

  // failureCategory inherited keys: pausing rejects (no permanent launder).
  // Running intentionally normalizes unknown to permanent after own-membership check.
  for (const key of inheritedKeys) {
    {
      const job = baseJob({ state: "pausing_provider", attemptToken: null });
      const sched = fakeScheduler(job);
      const started = [];
      const firefoxHits = { count: 0 };
      handlePgetResult(
        sched,
        baseWireMsg({
          attemptToken: "atk-drain",
          status: "failed",
          mode: "multi-range",
          partState: "partial",
          failureCategory: key,
        }),
        optionsBag(started, firefoxHits)
      );
      assertNoEffects(sched, firefoxHits, started);
    }
    {
      const job = baseJob({ state: "running", attemptToken: "atk-1" });
      const sched = fakeScheduler(job);
      const started = [];
      const firefoxHits = { count: 0 };
      handlePgetResult(
        sched,
        baseWireMsg({
          attemptToken: "atk-1",
          status: "failed",
          mode: "multi-range",
          partState: "partial",
          failureCategory: key,
        }),
        optionsBag(started, firefoxHits)
      );
      assert.equal(started.length, 0);
      assert.equal(firefoxHits.count, 0);
      assert.equal(sched.calls.capability.length, 0);
      assert.equal(sched.calls.draining.length, 0);
      assert.equal(sched.calls.transport.length, 1, `running unknown ${key}`);
      assert.equal(sched.calls.transport[0].result.failureCategory, "permanent");
      // Must not echo the inherited key name as a "known" category.
      assert.notEqual(sched.calls.transport[0].result.failureCategory, key);
    }
  }
});

test("own accessor fields fail closed without invoking getters or leaking secrets", () => {
  const { handlePgetResult } = loadAdapter();
  const SECRET = "SECRET_ACCESSOR_LEAK_NEVER";
  const fields = [
    "type",
    "id",
    "attemptToken",
    "status",
    "mode",
    "partState",
    "failureCategory",
  ];

  for (const state of ["running", "pausing_provider"]) {
    for (const field of fields) {
      const hits = { n: 0 };
      const job = baseJob({
        state,
        attemptToken: state === "pausing_provider" ? null : "atk-1",
      });
      const sched = fakeScheduler(job);
      const started = [];
      const firefoxHits = { count: 0 };
      const msg = baseWireMsg({
        attemptToken: state === "pausing_provider" ? "atk-drain" : "atk-1",
      });
      Object.defineProperty(msg, field, {
        configurable: true,
        enumerable: true,
        get() {
          hits.n += 1;
          throw new Error(SECRET + ":" + field);
        },
      });

      assert.doesNotThrow(() => {
        handlePgetResult(sched, msg, optionsBag(started, firefoxHits));
      });
      assert.equal(hits.n, 0, `accessor for ${field} must never run (state=${state})`);
      assertNoEffects(sched, firefoxHits, started);

      // Ensure secret text never appeared in any captured call payload.
      const all = JSON.stringify(sched.calls);
      assert.equal(all.includes(SECRET), false);
    }
  }
});

test("proxy getOwnPropertyDescriptor traps fail closed without leaking secrets", () => {
  const { handlePgetResult } = loadAdapter();
  const SECRET = "SECRET_GOPD_TRAP_LEAK";
  for (const state of ["running", "pausing_provider"]) {
    const job = baseJob({
      state,
      attemptToken: state === "pausing_provider" ? null : "atk-1",
    });
    const sched = fakeScheduler(job);
    const started = [];
    const firefoxHits = { count: 0 };
    const proxyHits = { n: 0 };
    const target = baseWireMsg({
      attemptToken: state === "pausing_provider" ? "atk-drain" : "atk-1",
    });
    const proxy = new Proxy(target, {
      getOwnPropertyDescriptor() {
        proxyHits.n += 1;
        throw new Error(SECRET);
      },
      get() {
        throw new Error(SECRET + "_GET");
      },
      ownKeys() {
        throw new Error(SECRET + "_KEYS");
      },
    });

    assert.doesNotThrow(() => {
      handlePgetResult(sched, proxy, optionsBag(started, firefoxHits));
    });
    assertNoEffects(sched, firefoxHits, started);
    assert.equal(JSON.stringify(sched.calls).includes(SECRET), false);
  }
});

test("boxed strings and non-primitive hostile enum values are rejected", () => {
  const { handlePgetResult } = loadAdapter();
  const hostiles = [
    { status: new String("completed") },
    { mode: new String("multi-range") },
    { partState: new String("committed") },
    { status: "completed", partState: "committed", failureCategory: new String("") },
    { status: 0 },
    { status: false },
    { status: ["completed"] },
    { status: { toString: () => "completed" } },
    { mode: 1 },
    { partState: true },
  ];

  for (const state of ["running", "pausing_provider"]) {
    for (const h of hostiles) {
      const job = baseJob({
        state,
        attemptToken: state === "pausing_provider" ? null : "atk-1",
      });
      const sched = fakeScheduler(job);
      const started = [];
      const firefoxHits = { count: 0 };
      const msg = baseWireMsg(
        Object.assign(
          {
            attemptToken: state === "pausing_provider" ? "atk-drain" : "atk-1",
          },
          h
        )
      );
      handlePgetResult(sched, msg, optionsBag(started, firefoxHits));
      assertNoEffects(sched, firefoxHits, started);
    }
  }
});

test("completed/committed accepts omitted, own undefined, and own null failureCategory (running + pausing)", () => {
  const { handlePgetResult } = loadAdapter();

  function makeMsg(variant, attemptToken) {
    const msg = {
      type: "pget-result",
      id: "j1",
      attemptToken,
      status: "completed",
      mode: "multi-range",
      partState: "committed",
    };
    if (variant === "null") msg.failureCategory = null;
    else if (variant === "undefined") msg.failureCategory = undefined;
    // omitted: do not set
    return msg;
  }

  for (const state of ["running", "pausing_provider"]) {
    for (const variant of ["omitted", "undefined", "null"]) {
      const job = baseJob({
        state,
        attemptToken: state === "pausing_provider" ? null : "atk-1",
      });
      const sched = fakeScheduler(job);
      const started = [];
      const firefoxHits = { count: 0 };
      const token = state === "pausing_provider" ? "atk-drain" : "atk-1";
      handlePgetResult(
        sched,
        makeMsg(variant, token),
        optionsBag(started, firefoxHits)
      );
      assert.equal(started.length, 0, `${state}/${variant}`);
      assert.equal(firefoxHits.count, 0, `${state}/${variant}`);
      assert.equal(sched.calls.capability.length, 0, `${state}/${variant}`);
      if (state === "running") {
        assert.equal(sched.calls.transport.length, 1, `running ${variant}`);
        assert.equal(sched.calls.draining.length, 0);
        assert.deepEqual(sched.calls.transport[0].result, {
          status: "completed",
          mode: "multi-range",
          failureCategory: null,
          partState: "committed",
        });
      } else {
        assert.equal(sched.calls.draining.length, 1, `pausing ${variant}`);
        assert.equal(sched.calls.transport.length, 0);
        assert.deepEqual(sched.calls.draining[0].result, {
          status: "completed",
          mode: "multi-range",
          failureCategory: null,
          partState: "committed",
        });
      }
    }
  }
});

test("completed rejects any non-null failureCategory value", () => {
  const { handlePgetResult } = loadAdapter();
  for (const bad of ["", "permanent", "cancelled", 0, false, {}, [], "timeout"]) {
    for (const state of ["running", "pausing_provider"]) {
      const job = baseJob({
        state,
        attemptToken: state === "pausing_provider" ? null : "atk-1",
      });
      const sched = fakeScheduler(job);
      const started = [];
      const firefoxHits = { count: 0 };
      handlePgetResult(
        sched,
        baseWireMsg({
          attemptToken: state === "pausing_provider" ? "atk-drain" : "atk-1",
          status: "completed",
          partState: "committed",
          failureCategory: bad,
        }),
        optionsBag(started, firefoxHits)
      );
      assertNoEffects(sched, firefoxHits, started);
    }
  }
});

test("cancelled accepts absent/undefined/null/exact cancelled and rejects other categories", () => {
  const { handlePgetResult } = loadAdapter();

  function cancelledMsg(token, categoryVariant) {
    const msg = {
      type: "pget-result",
      id: "j1",
      attemptToken: token,
      status: "cancelled",
      mode: "multi-range",
      partState: "partial",
    };
    if (categoryVariant === "null") msg.failureCategory = null;
    else if (categoryVariant === "undefined") msg.failureCategory = undefined;
    else if (categoryVariant === "cancelled") msg.failureCategory = "cancelled";
    // absent: omit
    return msg;
  }

  for (const state of ["running", "pausing_provider"]) {
    for (const variant of ["absent", "undefined", "null", "cancelled"]) {
      const job = baseJob({
        state,
        attemptToken: state === "pausing_provider" ? null : "atk-1",
      });
      const sched = fakeScheduler(job);
      const started = [];
      const firefoxHits = { count: 0 };
      const token = state === "pausing_provider" ? "atk-drain" : "atk-1";
      handlePgetResult(
        sched,
        cancelledMsg(token, variant),
        optionsBag(started, firefoxHits)
      );
      assert.equal(started.length, 0);
      assert.equal(firefoxHits.count, 0);
      assert.equal(sched.calls.capability.length, 0);
      const bucket =
        state === "running" ? sched.calls.transport : sched.calls.draining;
      assert.equal(bucket.length, 1, `${state}/${variant}`);
      assert.deepEqual(bucket[0].result, {
        status: "cancelled",
        mode: "multi-range",
        failureCategory: "cancelled",
        partState: "partial",
      });
    }

    for (const bad of [
      "timeout",
      "permanent",
      "arbitrary",
      "",
      0,
      false,
      {},
      new String("cancelled"),
    ]) {
      const job = baseJob({
        state,
        attemptToken: state === "pausing_provider" ? null : "atk-1",
      });
      const sched = fakeScheduler(job);
      const started = [];
      const firefoxHits = { count: 0 };
      handlePgetResult(
        sched,
        {
          type: "pget-result",
          id: "j1",
          attemptToken: state === "pausing_provider" ? "atk-drain" : "atk-1",
          status: "cancelled",
          mode: "multi-range",
          failureCategory: bad,
          partState: "partial",
        },
        optionsBag(started, firefoxHits)
      );
      assertNoEffects(sched, firefoxHits, started);
    }
  }
});

test("pausing valid terminal delegates exactly once; invalid fields cause zero call; never start/Firefox", () => {
  const { handlePgetResult } = loadAdapter();
  const job = baseJob({ state: "pausing_provider", attemptToken: null });
  let drainCalls = 0;
  const sched = fakeScheduler(job, {
    onDrainingTransportResult() {
      drainCalls += 1;
      return true;
    },
  });
  const started = [];
  const firefoxHits = { count: 0 };

  // Valid completed with omitted failureCategory — exactly one drain.
  handlePgetResult(
    sched,
    {
      type: "pget-result",
      id: "j1",
      attemptToken: "atk-drain-once",
      status: "completed",
      mode: "multi-range",
      partState: "committed",
    },
    optionsBag(started, firefoxHits)
  );
  assert.equal(drainCalls, 1);
  assert.equal(sched.calls.draining.length, 1);
  assert.equal(started.length, 0);
  assert.equal(firefoxHits.count, 0);
  assert.equal(sched.calls.capability.length, 0);
  assert.equal(sched.calls.transport.length, 0);

  // Invalid inherited status — zero additional drain / start / Firefox.
  handlePgetResult(
    sched,
    {
      type: "pget-result",
      id: "j1",
      attemptToken: "atk-drain-once",
      status: "toString",
      mode: "multi-range",
      failureCategory: null,
      partState: "committed",
    },
    optionsBag(started, firefoxHits)
  );
  assert.equal(drainCalls, 1, "invalid must not call drain again");
  assert.equal(started.length, 0);
  assert.equal(firefoxHits.count, 0);
  assert.equal(sched.calls.capability.length, 0);
});

test("pausing failed requires known exact category; does not launder unknown via permanent", () => {
  const { handlePgetResult } = loadAdapter();
  for (const bad of [undefined, null, "weird", "RANGE_UNSUPPORTED", "", "constructor"]) {
    const job = baseJob({ state: "pausing_provider", attemptToken: null });
    const sched = fakeScheduler(job);
    const started = [];
    const firefoxHits = { count: 0 };
    const msg = {
      type: "pget-result",
      id: "j1",
      attemptToken: "atk-drain",
      status: "failed",
      mode: "multi-range",
      partState: "partial",
    };
    if (bad !== undefined) msg.failureCategory = bad;
    handlePgetResult(sched, msg, optionsBag(started, firefoxHits));
    assertNoEffects(sched, firefoxHits, started);
  }

  // Known exact category still drains once.
  {
    const job = baseJob({ state: "pausing_provider", attemptToken: null });
    const sched = fakeScheduler(job);
    const started = [];
    const firefoxHits = { count: 0 };
    handlePgetResult(
      sched,
      {
        type: "pget-result",
        id: "j1",
        attemptToken: "atk-drain",
        status: "failed",
        mode: "multi-range",
        failureCategory: "timeout",
        partState: "partial",
      },
      optionsBag(started, firefoxHits)
    );
    assert.equal(sched.calls.draining.length, 1);
    assert.equal(sched.calls.draining[0].result.failureCategory, "timeout");
    assert.equal(started.length, 0);
    assert.equal(firefoxHits.count, 0);
  }
});

test("integration: omitted completed reaches real scheduler draining API; hostile keys do not", () => {
  const { createDownloadScheduler } = loadLib("lib/download-scheduler.js");
  const { handlePgetResult } = loadAdapter();

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

  function setupPausingB() {
    const firefoxCalls = { n: 0 };
    const s = createDownloadScheduler({
      maxConcurrent: 3,
      now() {
        return 0;
      },
      firefoxDownload() {
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
      ephemeral: { clear() {} },
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
    const bToken = s.getJob("B").attemptToken;
    s.onTransportResult("C", s.getJob("C").attemptToken, {
      status: "failed",
      failureCategory: "http_429",
    });
    assert.equal(s.getJob("B").state, "pausing_provider");
    assert.equal(s.getJob("B").attemptToken, null);
    return { s, bToken, firefoxCalls };
  }

  // Omitted failureCategory completed must reach draining and settle.
  {
    const { s, bToken, firefoxCalls } = setupPausingB();
    const started = [];
    handlePgetResult(
      s,
      {
        type: "pget-result",
        id: "B",
        attemptToken: bToken,
        status: "completed",
        mode: "multi-range",
        partState: "committed",
        // failureCategory intentionally omitted
        secret: "SHOULD-NOT-LEAK",
      },
      {
        startSingleConnection(j) {
          started.push(j);
        },
        firefoxDownload() {
          firefoxCalls.n += 1;
        },
      }
    );
    assert.equal(s.getJob("B").state, "completed");
    assert.equal(started.length, 0);
    assert.equal(firefoxCalls.n, 0);
  }

  // Hostile inherited enum key must not settle or start/Firefox.
  {
    const { s, bToken, firefoxCalls } = setupPausingB();
    const started = [];
    const before = s.getJob("B").stateVersion;
    handlePgetResult(
      s,
      {
        type: "pget-result",
        id: "B",
        attemptToken: bToken,
        status: "toString",
        mode: "multi-range",
        failureCategory: null,
        partState: "committed",
      },
      {
        startSingleConnection(j) {
          started.push(j);
        },
        firefoxDownload() {
          firefoxCalls.n += 1;
        },
      }
    );
    assert.equal(s.getJob("B").state, "pausing_provider");
    assert.equal(s.getJob("B").stateVersion, before);
    assert.equal(started.length, 0);
    assert.equal(firefoxCalls.n, 0);
  }

  // Hostile failureCategory constructor must not drain-settle.
  {
    const { s, bToken, firefoxCalls } = setupPausingB();
    const started = [];
    handlePgetResult(
      s,
      {
        type: "pget-result",
        id: "B",
        attemptToken: bToken,
        status: "failed",
        mode: "multi-range",
        failureCategory: "constructor",
        partState: "partial",
      },
      {
        startSingleConnection(j) {
          started.push(j);
        },
        firefoxDownload() {
          firefoxCalls.n += 1;
        },
      }
    );
    assert.equal(s.getJob("B").state, "pausing_provider");
    assert.equal(started.length, 0);
    assert.equal(firefoxCalls.n, 0);
  }
});

// ---------------------------------------------------------------------------
// 13. Task20: failed failureCategory exact primitive validation (no non-string launder)
// ---------------------------------------------------------------------------

function failedWireMsg(token, categoryVariant, partState) {
  const msg = {
    type: "pget-result",
    id: "j1",
    attemptToken: token,
    status: "failed",
    mode: "multi-range",
    partState: partState || "partial",
  };
  if (categoryVariant === "absent") {
    // omit failureCategory
  } else if (categoryVariant === "own-undefined") {
    msg.failureCategory = undefined;
  } else if (categoryVariant === "own-null") {
    msg.failureCategory = null;
  } else if (
    categoryVariant &&
    typeof categoryVariant === "object" &&
    Object.prototype.hasOwnProperty.call(categoryVariant, "value")
  ) {
    msg.failureCategory = categoryVariant.value;
  } else {
    msg.failureCategory = categoryVariant;
  }
  return msg;
}

test("running failed: non-string failureCategory types are ignored (no permanent launder)", () => {
  const { handlePgetResult } = loadAdapter();
  // Every non-string type that current normalizeFailureCategory would coerce to
  // permanent must instead fail closed with zero scheduler/start/Firefox effect.
  const hostiles = [
    { label: "boxed-known", value: new String("timeout") },
    { label: "boxed-permanent", value: new String("permanent") },
    { label: "boxed-empty", value: new String("") },
    { label: "object", value: {} },
    { label: "array", value: [] },
    { label: "number-0", value: 0 },
    { label: "number-1", value: 1 },
    { label: "bool-true", value: true },
    { label: "bool-false", value: false },
    { label: "bigint", value: 1n },
    { label: "symbol", value: Symbol("timeout") },
    {
      label: "function",
      value: function timeout() {
        return "timeout";
      },
    },
    {
      label: "toString-object",
      value: {
        toString() {
          return "timeout";
        },
      },
    },
    {
      label: "valueOf-object",
      value: {
        valueOf() {
          return "timeout";
        },
      },
    },
  ];

  for (const h of hostiles) {
    const job = baseJob({ state: "running", attemptToken: "atk-1" });
    const sched = fakeScheduler(job);
    const started = [];
    const firefoxHits = { count: 0 };
    const msg = failedWireMsg("atk-1", { value: h.value }, "partial");
    // Trap any accidental String()/coercion of the hostile value.
    if (h.value && typeof h.value === "object") {
      Object.defineProperty(h.value, Symbol.toPrimitive, {
        configurable: true,
        value() {
          throw new Error("must-not-coerce-" + h.label);
        },
      });
    }
    assert.doesNotThrow(() => {
      handlePgetResult(sched, msg, optionsBag(started, firefoxHits));
    }, h.label);
    assertNoEffects(sched, firefoxHits, started);
    // Must not launder into permanent via onTransportResult.
    assert.equal(
      sched.calls.transport.some((c) => c.result && c.result.failureCategory === "permanent"),
      false,
      `must not launder ${h.label} to permanent`
    );
    assert.equal(JSON.stringify(sched.calls).includes("must-not-coerce"), false);
  }
});

test("pausing failed: non-string failureCategory types are ignored (no permanent launder)", () => {
  const { handlePgetResult } = loadAdapter();
  const hostiles = [
    { label: "boxed-known", value: new String("timeout") },
    { label: "boxed-permanent", value: new String("permanent") },
    { label: "boxed-empty", value: new String("") },
    { label: "object", value: {} },
    { label: "array", value: [] },
    { label: "number-0", value: 0 },
    { label: "number-1", value: 1 },
    { label: "bool-true", value: true },
    { label: "bool-false", value: false },
    { label: "bigint", value: 1n },
    { label: "symbol", value: Symbol("timeout") },
    {
      label: "function",
      value: function timeout() {
        return "timeout";
      },
    },
  ];

  for (const h of hostiles) {
    const job = baseJob({ state: "pausing_provider", attemptToken: null });
    const sched = fakeScheduler(job);
    const started = [];
    const firefoxHits = { count: 0 };
    const msg = failedWireMsg("atk-drain", { value: h.value }, "partial");
    assert.doesNotThrow(() => {
      handlePgetResult(sched, msg, optionsBag(started, firefoxHits));
    }, h.label);
    assertNoEffects(sched, firefoxHits, started);
    assert.equal(
      sched.calls.draining.some((c) => c.result && c.result.failureCategory === "permanent"),
      false,
      `pausing must not launder ${h.label} to permanent`
    );
  }
});

test("running failed: absent/undefined/null/unknown primitive string normalize to permanent; known preserved", () => {
  const { handlePgetResult } = loadAdapter();

  // Controls: intentional permanent fallback for absent / own undefined / own null /
  // unknown exact primitive strings.
  for (const variant of [
    "absent",
    "own-undefined",
    "own-null",
    { value: "weird" },
    { value: "RANGE_UNSUPPORTED" },
    { value: "" },
    { value: "constructor" },
  ]) {
    const job = baseJob({ state: "running", attemptToken: "atk-1" });
    const sched = fakeScheduler(job);
    const started = [];
    const firefoxHits = { count: 0 };
    handlePgetResult(
      sched,
      failedWireMsg("atk-1", variant, "empty"),
      optionsBag(started, firefoxHits)
    );
    assert.equal(started.length, 0);
    assert.equal(firefoxHits.count, 0);
    assert.equal(sched.calls.capability.length, 0);
    assert.equal(sched.calls.draining.length, 0);
    assert.equal(sched.calls.transport.length, 1, `running control ${JSON.stringify(variant)}`);
    assert.equal(sched.calls.transport[0].result.failureCategory, "permanent");
    assert.equal(sched.calls.transport[0].result.status, "failed");
  }

  // Known exact primitive strings must be preserved (not rewritten).
  for (const cat of [
    "timeout",
    "local_io",
    "connection_reset",
    "short_read",
    "http_429",
    "http_5xx_temporary",
    "cancelled",
    "permanent",
    "range_unsupported",
  ]) {
    const job = baseJob({ state: "running", attemptToken: "atk-1" });
    const sched = fakeScheduler(job);
    const started = [];
    const firefoxHits = { count: 0 };
    // range_unsupported + empty is the capability-switch path; use partial so
    // ordinary transport preserves the category without switching.
    const partState = cat === "range_unsupported" ? "partial" : "empty";
    handlePgetResult(
      sched,
      failedWireMsg("atk-1", { value: cat }, partState),
      optionsBag(started, firefoxHits)
    );
    assert.equal(started.length, 0, cat);
    assert.equal(firefoxHits.count, 0, cat);
    assert.equal(sched.calls.capability.length, 0, cat);
    assert.equal(sched.calls.transport.length, 1, cat);
    assert.equal(sched.calls.transport[0].result.failureCategory, cat);
  }
});

test("pausing failed: missing/unknown primitive string remain inert; known exact preserved", () => {
  const { handlePgetResult } = loadAdapter();

  // Stricter than running: no permanent launder for missing/unknown.
  for (const variant of [
    "absent",
    "own-undefined",
    "own-null",
    { value: "weird" },
    { value: "RANGE_UNSUPPORTED" },
    { value: "" },
    { value: "constructor" },
  ]) {
    const job = baseJob({ state: "pausing_provider", attemptToken: null });
    const sched = fakeScheduler(job);
    const started = [];
    const firefoxHits = { count: 0 };
    handlePgetResult(
      sched,
      failedWireMsg("atk-drain", variant, "partial"),
      optionsBag(started, firefoxHits)
    );
    assertNoEffects(sched, firefoxHits, started);
  }

  // Known exact primitive still drains once.
  for (const cat of ["timeout", "local_io", "permanent", "range_unsupported", "cancelled"]) {
    const job = baseJob({ state: "pausing_provider", attemptToken: null });
    const sched = fakeScheduler(job);
    const started = [];
    const firefoxHits = { count: 0 };
    handlePgetResult(
      sched,
      failedWireMsg("atk-drain", { value: cat }, "partial"),
      optionsBag(started, firefoxHits)
    );
    assert.equal(started.length, 0, cat);
    assert.equal(firefoxHits.count, 0, cat);
    assert.equal(sched.calls.capability.length, 0, cat);
    assert.equal(sched.calls.transport.length, 0, cat);
    assert.equal(sched.calls.draining.length, 1, cat);
    assert.equal(sched.calls.draining[0].result.failureCategory, cat);
  }
});
