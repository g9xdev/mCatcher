"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");
const Size = loadLib("lib/media-size.js");

// ---------------------------------------------------------------------------
// Exact size from HTTP evidence
// ---------------------------------------------------------------------------

test("Content-Range total is exact and outranks partial Content-Length", () => {
  assert.deepEqual(Size.exactSizeFromHttp({
    statusCode: 206,
    responseHeaders: [
      { name: "Content-Range", value: "bytes 0-262143/1395864371" },
      { name: "Content-Length", value: "262144" },
    ],
  }), { sizeBytes: 1395864371, sizeConfidence: "exact" });
});

test("full 200 Content-Length is exact but 206 Content-Length alone is not", () => {
  assert.deepEqual(Size.exactSizeFromHttp({
    statusCode: 200,
    responseHeaders: [{ name: "Content-Length", value: "1395864371" }],
  }), { sizeBytes: 1395864371, sizeConfidence: "exact" });
  assert.equal(Size.exactSizeFromHttp({
    statusCode: 206,
    responseHeaders: [{ name: "Content-Length", value: "262144" }],
  }), null);
});

test("header names compare case-insensitively", () => {
  assert.deepEqual(Size.exactSizeFromHttp({
    statusCode: 206,
    responseHeaders: [{ name: "CoNtEnT-RaNgE", value: "bytes 0-9/100" }],
  }), { sizeBytes: 100, sizeConfidence: "exact" });
});

test("exact result is frozen and fresh on every call", () => {
  const input = {
    statusCode: 200,
    responseHeaders: [{ name: "Content-Length", value: "1024" }],
  };
  const first = Size.exactSizeFromHttp(input);
  const second = Size.exactSizeFromHttp(input);
  assert.ok(Object.isFrozen(first));
  assert.notEqual(first, second);
  assert.deepEqual(first, second);
});

test("unknown '*' total and malformed ranges are rejected", () => {
  const malformed = [
    "bytes 0-262143/*",
    "bytes */*",
    "items 0-9/100",
    "bytes 0-9",
    "bytes 0-9/100 extra",
    "0-9/100",
    "bytes 9-0/100",      // start after end
    "bytes 0-100/100",    // end must be below total
    "bytes 0-9/1.5",      // fractional total
    "bytes 0-9/-100",     // negative total
    "bytes 0-9/0",        // zero total
    "garbage",
  ];
  for (const value of malformed) {
    assert.equal(Size.exactSizeFromHttp({
      statusCode: 206,
      responseHeaders: [{ name: "Content-Range", value }],
    }), null, "expected null for Content-Range: " + value);
  }
});

test("'bytes */total' unsatisfied form still yields the exact total", () => {
  assert.deepEqual(Size.exactSizeFromHttp({
    statusCode: 416,
    responseHeaders: [{ name: "Content-Range", value: "bytes */1395864371" }],
  }), { sizeBytes: 1395864371, sizeConfidence: "exact" });
});

test("zero, negative, fractional, and junk Content-Length are rejected on 200", () => {
  for (const value of ["0", "-1", "1.5", " 12 3 ", "abc", "", "1e3", "0x10", "+5"]) {
    assert.equal(Size.exactSizeFromHttp({
      statusCode: 200,
      responseHeaders: [{ name: "Content-Length", value }],
    }), null, "expected null for Content-Length: " + value);
  }
});

test("whitespace-padded Content-Range and Content-Length are tolerated when otherwise valid", () => {
  assert.deepEqual(Size.exactSizeFromHttp({
    statusCode: 206,
    responseHeaders: [{ name: "Content-Range", value: "  bytes 0-9/100  " }],
  }), { sizeBytes: 100, sizeConfidence: "exact" });
  assert.deepEqual(Size.exactSizeFromHttp({
    statusCode: 200,
    responseHeaders: [{ name: "Content-Length", value: "  2048  " }],
  }), { sizeBytes: 2048, sizeConfidence: "exact" });
});

test("totals above Number.MAX_SAFE_INTEGER are rejected", () => {
  assert.equal(Size.exactSizeFromHttp({
    statusCode: 200,
    responseHeaders: [{ name: "Content-Length", value: "9007199254740993" }],
  }), null);
  assert.equal(Size.exactSizeFromHttp({
    statusCode: 206,
    responseHeaders: [{ name: "Content-Range", value: "bytes 0-9/9007199254740993" }],
  }), null);
  assert.deepEqual(Size.exactSizeFromHttp({
    statusCode: 200,
    responseHeaders: [{ name: "Content-Length", value: "9007199254740991" }],
  }), { sizeBytes: 9007199254740991, sizeConfidence: "exact" });
});

test("accessor descriptors are rejected rather than invoked", () => {
  let invoked = 0;
  const hostileInput = {
    responseHeaders: [{ name: "Content-Length", value: "1024" }],
  };
  Object.defineProperty(hostileInput, "statusCode", {
    enumerable: true,
    get() { invoked += 1; return 200; },
  });
  assert.equal(Size.exactSizeFromHttp(hostileInput), null);

  const hostileHeader = { name: "Content-Length" };
  Object.defineProperty(hostileHeader, "value", {
    enumerable: true,
    get() { invoked += 1; return "1024"; },
  });
  assert.equal(Size.exactSizeFromHttp({
    statusCode: 200,
    responseHeaders: [hostileHeader],
  }), null);

  const hostileList = [];
  Object.defineProperty(hostileList, "0", {
    enumerable: true,
    configurable: true,
    get() { invoked += 1; return { name: "Content-Length", value: "1024" }; },
  });
  assert.equal(hostileList.length, 1);
  assert.equal(Size.exactSizeFromHttp({
    statusCode: 200,
    responseHeaders: hostileList,
  }), null);

  assert.equal(invoked, 0, "no caller accessor may run");
});

test("non-record inputs and non-array headers return null", () => {
  for (const input of [null, undefined, 42, "200", true, Symbol("x"), [], () => {}]) {
    assert.equal(Size.exactSizeFromHttp(input), null);
  }
  for (const headers of [null, undefined, "Content-Length: 5", 5, {}]) {
    assert.equal(Size.exactSizeFromHttp({ statusCode: 200, responseHeaders: headers }), null);
  }
});

test("non-string header name/value entries and oversized lists are rejected", () => {
  assert.equal(Size.exactSizeFromHttp({
    statusCode: 200,
    responseHeaders: [{ name: "Content-Length", value: 1024 }],
  }), null);
  assert.equal(Size.exactSizeFromHttp({
    statusCode: 200,
    responseHeaders: [{ name: 7, value: "1024" }],
  }), null);
  const huge = [];
  for (let index = 0; index < 129; index += 1) huge.push({ name: "X", value: "1" });
  huge.push({ name: "Content-Length", value: "1024" });
  assert.equal(Size.exactSizeFromHttp({ statusCode: 200, responseHeaders: huge }), null);
});

test("conflicting duplicate headers are rejected, identical duplicates are accepted", () => {
  assert.equal(Size.exactSizeFromHttp({
    statusCode: 200,
    responseHeaders: [
      { name: "Content-Length", value: "1024" },
      { name: "content-length", value: "2048" },
    ],
  }), null);
  assert.deepEqual(Size.exactSizeFromHttp({
    statusCode: 200,
    responseHeaders: [
      { name: "Content-Length", value: "1024" },
      { name: "content-length", value: "1024" },
    ],
  }), { sizeBytes: 1024, sizeConfidence: "exact" });
});

test("non-integer status codes are rejected", () => {
  for (const statusCode of [null, "200", 200.5, NaN, undefined]) {
    assert.equal(Size.exactSizeFromHttp({
      statusCode,
      responseHeaders: [{ name: "Content-Length", value: "1024" }],
    }), null);
  }
});

// ---------------------------------------------------------------------------
// Estimated size from bitrate
// ---------------------------------------------------------------------------

test("bitrate times duration is always visibly estimated", () => {
  const estimate = Size.estimatedSizeFromBitrate({
    durationSeconds: 7200,
    selectedBandwidth: 1_500_000,
    bandwidth: 900_000,
    sampledKbps: 500,
  });
  assert.deepEqual(estimate, {
    sizeBytes: 1_350_000_000,
    sizeConfidence: "estimated",
  });
  assert.equal(Size.sizeLabel(estimate, () => "1.3 GB"), "Est. 1.3 GB");
  assert.equal(Size.sizeLabel(null, () => "unused"), "Size unknown");
});

test("bitrate source order is selected variant, then media bandwidth, then sampled kbps", () => {
  assert.equal(Size.estimatedSizeFromBitrate({
    durationSeconds: 8,
    selectedBandwidth: 1_000_000,
    bandwidth: 2_000_000,
    sampledKbps: 4000,
  }).sizeBytes, 1_000_000);
  assert.equal(Size.estimatedSizeFromBitrate({
    durationSeconds: 8,
    bandwidth: 2_000_000,
    sampledKbps: 4000,
  }).sizeBytes, 2_000_000);
  assert.equal(Size.estimatedSizeFromBitrate({
    durationSeconds: 8,
    sampledKbps: 4000,
  }).sizeBytes, 4_000_000);
});

test("invalid selected bandwidth falls through to the next bitrate source", () => {
  assert.equal(Size.estimatedSizeFromBitrate({
    durationSeconds: 8,
    selectedBandwidth: 0,
    bandwidth: 2_000_000,
  }).sizeBytes, 2_000_000);
  assert.equal(Size.estimatedSizeFromBitrate({
    durationSeconds: 8,
    selectedBandwidth: "1000000",
    bandwidth: 2_000_000,
  }).sizeBytes, 2_000_000);
});

test("invalid duration or absent bitrate yields no estimate", () => {
  for (const durationSeconds of [0, -1, NaN, Infinity, "7200", null, undefined]) {
    assert.equal(Size.estimatedSizeFromBitrate({ durationSeconds, bandwidth: 1_000_000 }), null);
  }
  assert.equal(Size.estimatedSizeFromBitrate({ durationSeconds: 7200 }), null);
  assert.equal(Size.estimatedSizeFromBitrate({
    durationSeconds: 7200,
    selectedBandwidth: -5,
    bandwidth: NaN,
    sampledKbps: 0,
  }), null);
  for (const input of [null, undefined, 42, "x", []]) {
    assert.equal(Size.estimatedSizeFromBitrate(input), null);
  }
});

test("estimate rejects accessor descriptors without invoking them", () => {
  let invoked = 0;
  const hostile = { selectedBandwidth: 1_000_000 };
  Object.defineProperty(hostile, "durationSeconds", {
    enumerable: true,
    get() { invoked += 1; return 8; },
  });
  assert.equal(Size.estimatedSizeFromBitrate(hostile), null);
  assert.equal(invoked, 0);
});

test("estimated result is frozen", () => {
  const estimate = Size.estimatedSizeFromBitrate({ durationSeconds: 8, bandwidth: 1_000_000 });
  assert.ok(Object.isFrozen(estimate));
  assert.equal(estimate.sizeConfidence, "estimated");
});

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

test("exact replaces estimate and estimate never replaces exact", () => {
  const estimated = Object.freeze({ sizeBytes: 1000, sizeConfidence: "estimated" });
  const exact = Object.freeze({ sizeBytes: 900, sizeConfidence: "exact" });
  assert.deepEqual(Size.chooseSize(estimated, exact), exact);
  assert.deepEqual(Size.chooseSize(exact, estimated), exact);
});

test("chooseSize accepts a first value, refreshes same-confidence candidates, and rejects junk", () => {
  const estimated = Object.freeze({ sizeBytes: 1000, sizeConfidence: "estimated" });
  assert.deepEqual(Size.chooseSize(null, estimated), estimated);
  assert.deepEqual(Size.chooseSize(estimated, null), estimated);
  assert.equal(Size.chooseSize(null, null), null);

  const newerEstimate = Object.freeze({ sizeBytes: 2000, sizeConfidence: "estimated" });
  assert.deepEqual(Size.chooseSize(estimated, newerEstimate), newerEstimate);

  const newerExact = Object.freeze({ sizeBytes: 4096, sizeConfidence: "exact" });
  const olderExact = Object.freeze({ sizeBytes: 2048, sizeConfidence: "exact" });
  assert.deepEqual(Size.chooseSize(olderExact, newerExact), newerExact);

  for (const junk of [
    { sizeBytes: 0, sizeConfidence: "exact" },
    { sizeBytes: -1, sizeConfidence: "exact" },
    { sizeBytes: 1.5, sizeConfidence: "exact" },
    { sizeBytes: "1024", sizeConfidence: "exact" },
    { sizeBytes: 1024, sizeConfidence: "guessed" },
    { sizeBytes: 1024 },
    { sizeConfidence: "exact" },
    42,
    "1024",
  ]) {
    assert.equal(Size.chooseSize(null, junk), null, "expected null for " + JSON.stringify(junk));
    assert.deepEqual(Size.chooseSize(estimated, junk), estimated);
  }
});

test("chooseSize returns a fresh frozen record carrying only the safe pair", () => {
  const tainted = Object.freeze({
    sizeBytes: 1024,
    sizeConfidence: "exact",
    mediaUrl: "https://cdn.example/movie.mp4?token=SIGNED_SENTINEL",
  });
  const chosen = Size.chooseSize(null, tainted);
  assert.deepEqual(Object.keys(chosen).sort(), ["sizeBytes", "sizeConfidence"]);
  assert.ok(Object.isFrozen(chosen));
  assert.notEqual(chosen, tainted);
  assert.equal(JSON.stringify(chosen).includes("SIGNED_SENTINEL"), false);
});

// ---------------------------------------------------------------------------
// Visible labels
// ---------------------------------------------------------------------------

test("sizeLabel prefixes estimates, passes exact through, and fails closed", () => {
  const exact = Object.freeze({ sizeBytes: 1024, sizeConfidence: "exact" });
  assert.equal(Size.sizeLabel(exact, () => "1.0 KB"), "1.0 KB");
  assert.equal(Size.sizeLabel({ sizeBytes: 1024, sizeConfidence: "estimated" }, () => "1.0 KB"), "Est. 1.0 KB");
  assert.equal(Size.sizeLabel(exact, null), "Size unknown");
  assert.equal(Size.sizeLabel(exact, "not a function"), "Size unknown");
  assert.equal(Size.sizeLabel(undefined, () => "x"), "Size unknown");
  assert.equal(Size.sizeLabel({ sizeBytes: 0, sizeConfidence: "exact" }, () => "x"), "Size unknown");
});

test("sizeLabel formats the validated byte count", () => {
  const seen = [];
  Size.sizeLabel({ sizeBytes: 4096, sizeConfidence: "exact" }, (bytes) => {
    seen.push(bytes);
    return "4.0 KB";
  });
  assert.deepEqual(seen, [4096]);
});

// ---------------------------------------------------------------------------
// Module shape and manifest wiring
// ---------------------------------------------------------------------------

test("dual-export assigns the same frozen api to module.exports and the global", () => {
  assert.equal(globalThis.McMediaSize, Size);
  assert.ok(Object.isFrozen(Size));
  assert.deepEqual(Object.keys(Size).sort(), [
    "chooseSize",
    "estimatedSizeFromBitrate",
    "exactSizeFromHttp",
    "sizeLabel",
  ]);
});

test("manifest loads lib/media-size.js before background.js", () => {
  const manifest = require("../manifest.json");
  const scripts = manifest.background.scripts;
  assert.ok(scripts.indexOf("lib/media-size.js") >= 0);
  assert.ok(scripts.indexOf("lib/media-size.js") < scripts.indexOf("background.js"));
});
