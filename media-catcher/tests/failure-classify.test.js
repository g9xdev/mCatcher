"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const { loadLib, mediaCatcherRoot } = require("./harness/load-lib.js");
const FC = loadLib("lib/failure-classify.js");

const RETRYABLE = ["timeout", "connection_reset", "short_read", "http_429", "http_5xx_temporary"];
const NON_RETRYABLE = ["range_unsupported", "local_io", "cancelled", "permanent"];

test("maps timeout reset short_read 429 temporary 5xx as saturation candidates", () => {
  for (const c of ["timeout", "connection_reset", "short_read", "http_429", "http_5xx_temporary"]) {
    assert.equal(FC.isSaturationCandidate(c), true);
  }
  for (const c of ["range_unsupported", "local_io", "cancelled", "permanent"]) {
    assert.equal(FC.isSaturationCandidate(c), false);
  }
});

test("isSaturationCandidate rejects unknown, empty, and non-string categories", () => {
  assert.equal(FC.isSaturationCandidate("TIMEOUT"), false);
  assert.equal(FC.isSaturationCandidate(""), false);
  assert.equal(FC.isSaturationCandidate(null), false);
  assert.equal(FC.isSaturationCandidate(undefined), false);
  assert.equal(FC.isSaturationCandidate(429), false);
  assert.equal(FC.isSaturationCandidate({ category: "timeout" }), false);
});

test("normalizeBrowserError maps timeout/reset/short_read/429/temp 5xx/range/local_io/cancelled/permanent", () => {
  // Mutation: collapsing every network error into permanent or timeout.
  assert.equal(FC.normalizeBrowserError({ name: "TimeoutError" }).category, "timeout");
  assert.equal(FC.normalizeBrowserError({ name: "AbortError", message: "The operation was aborted" }).category, "cancelled");
  assert.equal(FC.normalizeBrowserError({ name: "TypeError", message: "NetworkError when attempting to fetch" }).category, "connection_reset");
  assert.equal(FC.normalizeBrowserError({ name: "TypeError", message: "Failed to fetch" }).category, "connection_reset");
  assert.equal(FC.normalizeBrowserError({ status: 429 }).category, "http_429");
  assert.equal(FC.normalizeBrowserError({ status: 503 }).category, "http_5xx_temporary");
  assert.equal(FC.normalizeBrowserError({ status: 502 }).category, "http_5xx_temporary");
  assert.equal(FC.normalizeBrowserError({ status: 500 }).category, "http_5xx_temporary");
  assert.equal(FC.normalizeBrowserError({ status: 416 }).category, "range_unsupported");
  assert.equal(FC.normalizeBrowserError({ status: 200, rangeIgnored: true }).category, "range_unsupported");
  assert.equal(FC.normalizeBrowserError({ code: "ENOSPC" }).category, "local_io");
  assert.equal(FC.normalizeBrowserError({ status: 404 }).category, "permanent");
  assert.equal(FC.normalizeBrowserError({ status: 403 }).category, "permanent");
  assert.equal(FC.normalizeBrowserError({ shortRead: true }).category, "short_read");
  assert.equal(FC.normalizeBrowserError({ name: "TimeoutError" }).retryable, true);
  assert.equal(FC.normalizeBrowserError({ status: 404 }).retryable, false);
  assert.equal(FC.normalizeBrowserError({ status: 416 }).retryable, false);
});

test("normalizeBrowserError cancellation beats generic abort/network wording", () => {
  // Mutation: treating AbortError network wording as connection_reset.
  const abortedNetwork = FC.normalizeBrowserError({
    name: "AbortError",
    message: "NetworkError: The operation was aborted due to connection reset",
  });
  assert.equal(abortedNetwork.category, "cancelled");
  assert.equal(abortedNetwork.retryable, false);

  const cancelledFlag = FC.normalizeBrowserError({
    name: "TypeError",
    message: "Failed to fetch",
    cancelled: true,
  });
  assert.equal(cancelledFlag.category, "cancelled");

  const cancelRequested = FC.normalizeBrowserError({
    status: 503,
    cancelRequested: true,
  });
  assert.equal(cancelRequested.category, "cancelled");
});

test("normalizeBrowserError handles null, strings, status coercion, and range flags without throwing", () => {
  assert.deepEqual(FC.normalizeBrowserError(null), { category: "permanent", retryable: false });
  assert.deepEqual(FC.normalizeBrowserError(undefined), { category: "permanent", retryable: false });
  assert.equal(FC.normalizeBrowserError("timeout").category, "timeout");
  assert.equal(FC.normalizeBrowserError("TIMEOUT").category, "timeout");
  assert.equal(FC.normalizeBrowserError("ECONNRESET").category, "connection_reset");
  assert.equal(FC.normalizeBrowserError({ status: "429" }).category, "http_429");
  assert.equal(FC.normalizeBrowserError({ status: "503" }).category, "http_5xx_temporary");
  assert.equal(FC.normalizeBrowserError({ status: "416" }).category, "range_unsupported");
  assert.equal(FC.normalizeBrowserError({ rangeUnsupported: true }).category, "range_unsupported");
  assert.equal(FC.normalizeBrowserError({ rangeIgnored: true }).category, "range_unsupported");
  assert.equal(FC.normalizeBrowserError({ message: "disk full" }).category, "local_io");
  assert.equal(FC.normalizeBrowserError({ code: "enospc" }).category, "local_io");
  assert.equal(FC.normalizeBrowserError({ name: "Error", message: "ETIMEDOUT" }).category, "timeout");
  assert.equal(FC.normalizeBrowserError({ status: 504 }).category, "http_5xx_temporary");
  assert.equal(FC.normalizeBrowserError({ status: 501 }).category, "permanent");
  assert.equal(FC.normalizeBrowserError({ status: 418 }).category, "permanent");
  assert.equal(FC.normalizeBrowserError({ unknown: true }).category, "permanent");
  assert.equal(FC.normalizeBrowserError(42).category, "permanent");
});

test("normalizeBrowserError retryable matches only saturation candidates", () => {
  for (const c of RETRYABLE) {
    // Drive category via native-like string form through browser path when possible.
    const r = FC.normalizeBrowserError(c);
    assert.equal(r.category, c);
    assert.equal(r.retryable, true, c + " should be retryable");
  }
  for (const c of NON_RETRYABLE) {
    const r = FC.normalizeBrowserError(c);
    assert.equal(r.category, c);
    assert.equal(r.retryable, false, c + " should not be retryable");
  }
});

test("normalizeNativeFailure maps host reason strings and objects", () => {
  // Mutation: treating range_unsupported as temporary or local_io as saturation-capable.
  assert.equal(FC.normalizeNativeFailure("timeout").category, "timeout");
  assert.equal(FC.normalizeNativeFailure("connection_reset").category, "connection_reset");
  assert.equal(FC.normalizeNativeFailure("short_read").category, "short_read");
  assert.equal(FC.normalizeNativeFailure("http_429").category, "http_429");
  assert.equal(FC.normalizeNativeFailure("http_5xx_temporary").category, "http_5xx_temporary");
  assert.equal(FC.normalizeNativeFailure("range_unsupported").category, "range_unsupported");
  assert.equal(FC.normalizeNativeFailure("local_io").category, "local_io");
  assert.equal(FC.normalizeNativeFailure("cancelled").category, "cancelled");
  assert.equal(FC.normalizeNativeFailure("permanent").category, "permanent");
  assert.equal(FC.normalizeNativeFailure({ failureCategory: "timeout" }).category, "timeout");
  assert.equal(FC.normalizeNativeFailure({ reason: "disk full" }).category, "local_io");
  assert.equal(FC.normalizeNativeFailure({ reason: "ECONNRESET" }).category, "connection_reset");
  assert.equal(FC.normalizeNativeFailure("range_unsupported").retryable, false);
  assert.equal(FC.normalizeNativeFailure("local_io").retryable, false);
  assert.equal(FC.normalizeNativeFailure("timeout").retryable, true);
});

test("normalizeNativeFailure handles case, nested fields, and safe permanent fallback", () => {
  assert.equal(FC.normalizeNativeFailure("TIMEOUT").category, "timeout");
  assert.equal(FC.normalizeNativeFailure("Range_Unsupported").category, "range_unsupported");
  assert.equal(FC.normalizeNativeFailure({ failureCategory: "HTTP_429" }).category, "http_429");
  assert.equal(FC.normalizeNativeFailure({ failureCategory: "local_io" }).retryable, false);
  assert.equal(FC.normalizeNativeFailure({ reason: "ENOSPC" }).category, "local_io");
  assert.equal(FC.normalizeNativeFailure({ reason: "short read" }).category, "short_read");
  assert.equal(FC.normalizeNativeFailure({ reason: "operation aborted by user" }).category, "cancelled");
  assert.equal(FC.normalizeNativeFailure({ reason: "too many requests" }).category, "http_429");
  assert.equal(FC.normalizeNativeFailure({ reason: "service unavailable 503" }).category, "http_5xx_temporary");
  assert.equal(FC.normalizeNativeFailure(null).category, "permanent");
  assert.equal(FC.normalizeNativeFailure(undefined).category, "permanent");
  assert.equal(FC.normalizeNativeFailure({}).category, "permanent");
  assert.equal(FC.normalizeNativeFailure("mystery-host-error").category, "permanent");
  assert.equal(FC.normalizeNativeFailure({ failureCategory: "not_a_real_category" }).category, "permanent");
  assert.equal(FC.normalizeNativeFailure({ reason: "ECONNRESET" }).retryable, true);
  assert.equal(FC.normalizeNativeFailure({ reason: "disk full" }).retryable, false);
});

test("queued or needs_user sibling does not satisfy active-sibling predicate", () => {
  // Mutation: treating any non-terminal same-provider job as active.
  const jobs = [
    { id: "a", providerKey: "florenfile.com", state: "queued", inFlightPermits: 0, nativeOpenConnections: 0, cancelRequested: false },
    { id: "b", providerKey: "florenfile.com", state: "needs_user", inFlightPermits: 0, nativeOpenConnections: 0, cancelRequested: false },
  ];
  assert.equal(FC.hasActiveSibling({ jobs, providerKey: "florenfile.com", excludeJobId: "x" }).ok, false);
});

test("running sibling with permit counts", () => {
  const jobs = [
    { id: "run", providerKey: "florenfile.com", state: "running", inFlightPermits: 1, nativeOpenConnections: 0, cancelRequested: false },
  ];
  const r = FC.hasActiveSibling({ jobs, providerKey: "florenfile.com", excludeJobId: "failed" });
  assert.equal(r.ok, true);
  assert.equal(r.siblingJobId, "run");
});

test("pausing_provider sibling with native open connections counts", () => {
  // Mutation: requiring only running or only inFlightPermits.
  const jobs = [
    {
      id: "owner",
      providerKey: "florenfile.com",
      state: "pausing_provider",
      inFlightPermits: 0,
      nativeOpenConnections: 2,
      cancelRequested: false,
    },
  ];
  const r = FC.hasActiveSibling({ jobs, providerKey: "florenfile.com", excludeJobId: "failed" });
  assert.equal(r.ok, true);
  assert.equal(r.siblingJobId, "owner");
});

test("hasActiveSibling rejects excluded, cancelling, wrong provider, and zero connections", () => {
  const base = {
    id: "sib",
    providerKey: "florenfile.com",
    state: "running",
    inFlightPermits: 1,
    nativeOpenConnections: 0,
    cancelRequested: false,
  };

  // Exclude own id.
  assert.deepEqual(
    FC.hasActiveSibling({ jobs: [base], providerKey: "florenfile.com", excludeJobId: "sib" }),
    { ok: false, siblingJobId: null }
  );

  // Cancelling sibling.
  assert.deepEqual(
    FC.hasActiveSibling({
      jobs: [{ ...base, cancelRequested: true }],
      providerKey: "florenfile.com",
      excludeJobId: "x",
    }),
    { ok: false, siblingJobId: null }
  );

  // Wrong provider.
  assert.deepEqual(
    FC.hasActiveSibling({
      jobs: [{ ...base, providerKey: "other.com" }],
      providerKey: "florenfile.com",
      excludeJobId: "x",
    }),
    { ok: false, siblingJobId: null }
  );

  // Zero permits and zero native connections.
  assert.deepEqual(
    FC.hasActiveSibling({
      jobs: [{ ...base, inFlightPermits: 0, nativeOpenConnections: 0 }],
      providerKey: "florenfile.com",
      excludeJobId: "x",
    }),
    { ok: false, siblingJobId: null }
  );

  // waiting_provider / retry_backoff are not active.
  assert.deepEqual(
    FC.hasActiveSibling({
      jobs: [{ ...base, state: "waiting_provider" }],
      providerKey: "florenfile.com",
      excludeJobId: "x",
    }),
    { ok: false, siblingJobId: null }
  );
  assert.deepEqual(
    FC.hasActiveSibling({
      jobs: [{ ...base, state: "retry_backoff" }],
      providerKey: "florenfile.com",
      excludeJobId: "x",
    }),
    { ok: false, siblingJobId: null }
  );
});

test("hasActiveSibling tolerates malformed input, empty providerKey, and does not mutate jobs", () => {
  assert.deepEqual(FC.hasActiveSibling(null), { ok: false, siblingJobId: null });
  assert.deepEqual(FC.hasActiveSibling(undefined), { ok: false, siblingJobId: null });
  assert.deepEqual(FC.hasActiveSibling({}), { ok: false, siblingJobId: null });
  assert.deepEqual(
    FC.hasActiveSibling({ jobs: null, providerKey: "florenfile.com", excludeJobId: "x" }),
    { ok: false, siblingJobId: null }
  );
  assert.deepEqual(
    FC.hasActiveSibling({ jobs: "not-array", providerKey: "florenfile.com", excludeJobId: "x" }),
    { ok: false, siblingJobId: null }
  );
  assert.deepEqual(
    FC.hasActiveSibling({
      jobs: [null, 42, "job", { id: "a" }],
      providerKey: "florenfile.com",
      excludeJobId: "x",
    }),
    { ok: false, siblingJobId: null }
  );
  assert.deepEqual(
    FC.hasActiveSibling({
      jobs: [{
        id: "run",
        providerKey: "florenfile.com",
        state: "running",
        inFlightPermits: 1,
        nativeOpenConnections: 0,
        cancelRequested: false,
      }],
      providerKey: "",
      excludeJobId: "x",
    }),
    { ok: false, siblingJobId: null }
  );
  assert.deepEqual(
    FC.hasActiveSibling({
      jobs: [{
        id: "run",
        providerKey: "florenfile.com",
        state: "running",
        inFlightPermits: 1,
        nativeOpenConnections: 0,
        cancelRequested: false,
      }],
      providerKey: null,
      excludeJobId: "x",
    }),
    { ok: false, siblingJobId: null }
  );

  const jobs = [
    {
      id: "run",
      providerKey: "florenfile.com",
      state: "running",
      inFlightPermits: 1,
      nativeOpenConnections: 0,
      cancelRequested: false,
      marker: "keep",
    },
  ];
  const before = JSON.stringify(jobs);
  const r = FC.hasActiveSibling({ jobs, providerKey: "florenfile.com", excludeJobId: "failed" });
  assert.equal(r.ok, true);
  assert.equal(r.siblingJobId, "run");
  assert.equal(JSON.stringify(jobs), before);
  assert.equal(jobs[0].marker, "keep");
});

test("hasActiveSibling returns first qualifying sibling among mixed jobs", () => {
  const jobs = [
    { id: "queued", providerKey: "florenfile.com", state: "queued", inFlightPermits: 0, nativeOpenConnections: 0, cancelRequested: false },
    { id: "wrong", providerKey: "other.com", state: "running", inFlightPermits: 2, nativeOpenConnections: 0, cancelRequested: false },
    { id: "cancel", providerKey: "florenfile.com", state: "running", inFlightPermits: 1, nativeOpenConnections: 0, cancelRequested: true },
    { id: "idle", providerKey: "florenfile.com", state: "running", inFlightPermits: 0, nativeOpenConnections: 0, cancelRequested: false },
    { id: "hit", providerKey: "florenfile.com", state: "running", inFlightPermits: 0, nativeOpenConnections: 1, cancelRequested: false },
    { id: "later", providerKey: "florenfile.com", state: "pausing_provider", inFlightPermits: 3, nativeOpenConnections: 0, cancelRequested: false },
  ];
  const r = FC.hasActiveSibling({ jobs, providerKey: "florenfile.com", excludeJobId: "failed" });
  assert.equal(r.ok, true);
  assert.equal(r.siblingJobId, "hit");
});

test("failure-classify dual-export assigns locked McFailureClassify global with identity", () => {
  // Mutation: else-branch only assigns one side, or creates two distinct objects.
  const abs = path.join(mediaCatcherRoot, "lib", "failure-classify.js");
  const code = fs.readFileSync(abs, "utf8");
  const root = {};
  const sandbox = { module: { exports: {} }, exports: {}, require, console, self: root };
  sandbox.module.exports = sandbox.exports;
  vm.runInNewContext(code, sandbox, { filename: abs });
  assert.equal(typeof sandbox.module.exports.normalizeBrowserError, "function");
  assert.equal(typeof sandbox.module.exports.normalizeNativeFailure, "function");
  assert.equal(typeof sandbox.module.exports.isSaturationCandidate, "function");
  assert.equal(typeof sandbox.module.exports.hasActiveSibling, "function");
  assert.equal(typeof root.McFailureClassify.normalizeBrowserError, "function");
  assert.equal(root.McFailureClassify, sandbox.module.exports);
});
