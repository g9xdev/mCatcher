"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const { loadLib, mediaCatcherRoot } = require("./harness/load-lib.js");

const FLOREN = "11238-makemebi.net.mp4";
const MAX_CHUNK = 512 * 1024;

function loadProtocol() {
  return loadLib("lib/file-sink-protocol.js");
}

function openStreaming(overrides) {
  const P = loadProtocol();
  const input = Object.assign(
    {
      jobId: "j1",
      attemptToken: "a1",
      requestedFilename: FLOREN,
      destinationDirectory: "D:\\\\v",
    },
    overrides || {}
  );
  const s = P.createFileSinkSession(input);
  const opened = s.onOpened({
    type: "file-opened",
    sinkId: "s1",
    jobId: input.jobId,
    attemptToken: input.attemptToken,
  });
  assert.equal(opened, true);
  return { P, s, input };
}

function snapshotSession(s) {
  return {
    state: s.state,
    sinkId: s.sinkId,
    outstandingCount: s.outstandingCount,
    jobId: s.jobId,
    attemptToken: s.attemptToken,
    requestedFilename: s.requestedFilename,
    destinationDirectory: s.destinationDirectory,
  };
}

function assertFrozenAllowlist(obj, keys) {
  assert.equal(Object.isFrozen(obj), true);
  assert.deepEqual(Object.keys(obj).sort(), keys.slice().sort());
  for (const k of keys) {
    const v = obj[k];
    if (v && typeof v === "object") {
      assert.equal(Object.isFrozen(v), true);
    }
  }
}

// ---------------------------------------------------------------------------
// Plan samples
// ---------------------------------------------------------------------------

test("open binds filename; chunks respect unacked window", () => {
  const { createFileSinkSession, MAX_UNACKED } = loadProtocol();
  const s = createFileSinkSession({
    jobId: "j1",
    attemptToken: "a1",
    requestedFilename: FLOREN,
    destinationDirectory: "D:\\\\v",
  });
  assert.deepEqual(s.openCmd(), {
    cmd: "file-open",
    jobId: "j1",
    attemptToken: "a1",
    requestedFilename: FLOREN,
    dir: "D:\\\\v",
  });
  s.onOpened({ type: "file-opened", sinkId: "s1", jobId: "j1", attemptToken: "a1" });
  const cmds = [];
  for (let i = 0; i < MAX_UNACKED; i++) {
    cmds.push(s.nextChunkCmd(new Uint8Array([i])));
  }
  assert.equal(cmds.length, MAX_UNACKED);
  assert.equal(s.nextChunkCmd(new Uint8Array([9])), null); // backpressure
  s.onAck({ type: "file-chunk-ack", sinkId: "s1", seq: 0 });
  assert.ok(s.nextChunkCmd(new Uint8Array([9])));
});

test("commit and abort commands carry bound sink identity", () => {
  const { createFileSinkSession } = loadProtocol();
  const s = createFileSinkSession({
    jobId: "j1",
    attemptToken: "a1",
    requestedFilename: "out.mp4",
    destinationDirectory: null,
  });
  s.onOpened({ type: "file-opened", sinkId: "s9", jobId: "j1", attemptToken: "a1" });
  assert.deepEqual(s.commitCmd(), {
    cmd: "file-commit",
    sinkId: "s9",
    jobId: "j1",
    attemptToken: "a1",
  });
  assert.deepEqual(s.abortCmd(), {
    cmd: "file-abort",
    sinkId: "s9",
    jobId: "j1",
    attemptToken: "a1",
  });
});

test("host error maps to local_io and never flags saturation or firefox", () => {
  const { createFileSinkSession } = loadProtocol();
  const s = createFileSinkSession({
    jobId: "j1",
    attemptToken: "a1",
    requestedFilename: "out.mp4",
    destinationDirectory: null,
  });
  s.onOpened({ type: "file-opened", sinkId: "s1", jobId: "j1", attemptToken: "a1" });
  // Task-15 live-sink errors always carry exact sink+job+attempt identity.
  const out = s.onHostError({
    type: "file-error",
    sinkId: "s1",
    jobId: "j1",
    attemptToken: "a1",
    failureCategory: "local_io",
    reason: "disk full",
  });
  assert.equal(out.failureCategory, "local_io");
  assert.equal(out.invokeFirefox, false);
  assert.equal(out.isSaturation, false);
  assert.equal(s.state, "failed");
});

// ---------------------------------------------------------------------------
// Constants + dual export
// ---------------------------------------------------------------------------

test("exports MAX_UNACKED 4 and MAX_CHUNK_BYTES 512KiB", () => {
  const P = loadProtocol();
  assert.equal(P.MAX_UNACKED, 4);
  assert.equal(P.MAX_CHUNK_BYTES, 512 * 1024);
});

test("dual-export assigns exact McFileSinkProtocol global identity", () => {
  const abs = path.join(mediaCatcherRoot, "lib", "file-sink-protocol.js");
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
  assert.equal(root.McFileSinkProtocol, sandbox.module.exports);
  assert.equal(typeof root.McFileSinkProtocol.createFileSinkSession, "function");
  assert.equal(typeof root.McFileSinkProtocol.buildPgetCmd, "function");
  assert.equal(typeof root.McFileSinkProtocol.buildPgetSingleCmd, "function");
  assert.equal(typeof root.McFileSinkProtocol.buildPgetSetLimitCmd, "function");
  assert.equal(typeof root.McFileSinkProtocol.buildPgetCancelCmd, "function");
  assert.equal(root.McFileSinkProtocol.MAX_UNACKED, 4);
  assert.equal(root.McFileSinkProtocol.MAX_CHUNK_BYTES, MAX_CHUNK);
  assert.equal(Object.isFrozen(root.McFileSinkProtocol), true);
  assert.deepEqual(Object.keys(root.McFileSinkProtocol).sort(), [
    "MAX_CHUNK_BYTES",
    "MAX_UNACKED",
    "buildPgetCancelCmd",
    "buildPgetCmd",
    "buildPgetSetLimitCmd",
    "buildPgetSingleCmd",
    "createFileSinkSession",
  ]);
});

// ---------------------------------------------------------------------------
// Constructor validation + frozen bindings
// ---------------------------------------------------------------------------

test("constructor requires nonblank primitive strings; destination null/undefined or nonblank string", () => {
  const { createFileSinkSession } = loadProtocol();
  const base = {
    jobId: "j",
    attemptToken: "a",
    requestedFilename: "x.mp4",
    destinationDirectory: null,
  };

  for (const bad of ["", "  ", null, undefined, 1, true, {}, [], () => "x"]) {
    assert.throws(() => createFileSinkSession({ ...base, jobId: bad }));
    assert.throws(() => createFileSinkSession({ ...base, attemptToken: bad }));
    assert.throws(() => createFileSinkSession({ ...base, requestedFilename: bad }));
  }

  assert.throws(() =>
    createFileSinkSession({ ...base, destinationDirectory: "" })
  );
  assert.throws(() =>
    createFileSinkSession({ ...base, destinationDirectory: "  " })
  );
  assert.throws(() =>
    createFileSinkSession({ ...base, destinationDirectory: 12 })
  );
  assert.throws(() =>
    createFileSinkSession({ ...base, destinationDirectory: {} })
  );
  assert.throws(() =>
    createFileSinkSession({ ...base, destinationDirectory: [] })
  );
  assert.throws(() =>
    createFileSinkSession({ ...base, destinationDirectory: () => "D:\\\\x" })
  );

  const s1 = createFileSinkSession({ ...base, destinationDirectory: undefined });
  assert.equal(s1.destinationDirectory, null);
  const s2 = createFileSinkSession({ ...base, destinationDirectory: null });
  assert.equal(s2.destinationDirectory, null);
  const s3 = createFileSinkSession({
    ...base,
    destinationDirectory: "D:\\\\Vids",
  });
  assert.equal(s3.destinationDirectory, "D:\\\\Vids");
});

test("session is frozen with read-only bindings; caller input mutation cannot rebind", () => {
  const { createFileSinkSession } = loadProtocol();
  const input = {
    jobId: "j1",
    attemptToken: "a1",
    requestedFilename: FLOREN,
    destinationDirectory: "D:\\\\v",
  };
  const s = createFileSinkSession(input);
  assert.equal(Object.isFrozen(s), true);
  assert.equal(s.state, "open");
  assert.equal(s.sinkId, null);
  assert.equal(s.outstandingCount, 0);

  input.jobId = "mutated";
  input.attemptToken = "mutated";
  input.requestedFilename = "evil.mp4";
  input.destinationDirectory = "C:\\\\evil";

  assert.equal(s.jobId, "j1");
  assert.equal(s.attemptToken, "a1");
  assert.equal(s.requestedFilename, FLOREN);
  assert.equal(s.destinationDirectory, "D:\\\\v");

  const open = s.openCmd();
  assert.equal(open.jobId, "j1");
  assert.equal(open.requestedFilename, FLOREN);
  assert.equal(open.dir, "D:\\\\v");

  assert.throws(() => {
    s.requestedFilename = "nope.mp4";
  });
  assert.throws(() => {
    s.state = "failed";
  });
  assert.equal(s.requestedFilename, FLOREN);
  assert.equal(s.state, "open");
});

test("hostile extra getters on constructor input are never touched", () => {
  const { createFileSinkSession } = loadProtocol();
  let touched = 0;
  const input = {
    jobId: "j1",
    attemptToken: "a1",
    requestedFilename: "ok.mp4",
    destinationDirectory: null,
  };
  Object.defineProperty(input, "cookie", {
    enumerable: true,
    get() {
      touched++;
      return "session=secret";
    },
  });
  Object.defineProperty(input, "headers", {
    enumerable: true,
    get() {
      touched++;
      return { Authorization: "Bearer x" };
    },
  });
  Object.defineProperty(input, "pageTitle", {
    enumerable: true,
    get() {
      touched++;
      return "Rank Me";
    },
  });
  const s = createFileSinkSession(input);
  assert.equal(s.requestedFilename, "ok.mp4");
  assert.equal(touched, 0);
});

// ---------------------------------------------------------------------------
// open / onOpened
// ---------------------------------------------------------------------------

test("openCmd only in open state; returns frozen allowlisted shape", () => {
  const { s } = openStreaming({ destinationDirectory: null });
  assert.equal(s.openCmd(), null);
  assert.equal(s.state, "streaming");

  const { createFileSinkSession } = loadProtocol();
  const open = createFileSinkSession({
    jobId: "j1",
    attemptToken: "a1",
    requestedFilename: "out.mp4",
    destinationDirectory: null,
  });
  const cmd = open.openCmd();
  assertFrozenAllowlist(cmd, [
    "cmd",
    "jobId",
    "attemptToken",
    "requestedFilename",
    "dir",
  ]);
  assert.equal(cmd.cmd, "file-open");
  assert.equal(cmd.dir, null);
  const again = open.openCmd();
  assert.notEqual(again, cmd);
  assert.deepEqual(again, cmd);
});

test("onOpened rejects stale/malformed/duplicate frames with zero mutation", () => {
  const { createFileSinkSession } = loadProtocol();
  const s = createFileSinkSession({
    jobId: "j1",
    attemptToken: "a1",
    requestedFilename: "out.mp4",
    destinationDirectory: null,
  });
  const before = snapshotSession(s);

  const rejects = [
    null,
    undefined,
    "file-opened",
    { type: "file-opened" },
    { type: "wrong", sinkId: "s1", jobId: "j1", attemptToken: "a1" },
    { type: "file-opened", sinkId: "", jobId: "j1", attemptToken: "a1" },
    { type: "file-opened", sinkId: "  ", jobId: "j1", attemptToken: "a1" },
    { type: "file-opened", sinkId: 12, jobId: "j1", attemptToken: "a1" },
    { type: "file-opened", sinkId: "s1", jobId: "other", attemptToken: "a1" },
    { type: "file-opened", sinkId: "s1", jobId: "j1", attemptToken: "stale" },
    { type: "file-opened", sinkId: "s1", jobId: "j1" },
    { type: "file-opened", sinkId: "s1", attemptToken: "a1" },
  ];
  for (const msg of rejects) {
    assert.equal(s.onOpened(msg), false);
    assert.deepEqual(snapshotSession(s), before);
  }

  assert.equal(
    s.onOpened({
      type: "file-opened",
      sinkId: "s1",
      jobId: "j1",
      attemptToken: "a1",
    }),
    true
  );
  assert.equal(s.state, "streaming");
  assert.equal(s.sinkId, "s1");
  const afterOpen = snapshotSession(s);
  assert.equal(
    s.onOpened({
      type: "file-opened",
      sinkId: "s2",
      jobId: "j1",
      attemptToken: "a1",
    }),
    false
  );
  assert.deepEqual(snapshotSession(s), afterOpen);
  assert.equal(s.sinkId, "s1");
});

// ---------------------------------------------------------------------------
// Chunks / base64 / backpressure
// ---------------------------------------------------------------------------

test("nextChunkCmd copies bytes, encodes base64, sequences from 0, and freezes", () => {
  const { s } = openStreaming();
  const bytes = new Uint8Array([72, 101, 108, 108, 111]); // Hello
  const cmd = s.nextChunkCmd(bytes);
  assertFrozenAllowlist(cmd, [
    "cmd",
    "sinkId",
    "jobId",
    "attemptToken",
    "seq",
    "dataB64",
    "length",
  ]);
  assert.equal(cmd.cmd, "file-chunk");
  assert.equal(cmd.sinkId, "s1");
  assert.equal(cmd.jobId, "j1");
  assert.equal(cmd.attemptToken, "a1");
  assert.equal(cmd.seq, 0);
  assert.equal(cmd.length, 5);
  assert.equal(cmd.dataB64, "SGVsbG8=");
  assert.equal(Object.prototype.hasOwnProperty.call(cmd, "requestedFilename"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(cmd, "url"), false);

  bytes[0] = 0;
  assert.equal(cmd.dataB64, "SGVsbG8=");

  const empty = s.nextChunkCmd(new Uint8Array(0));
  assert.equal(empty.seq, 1);
  assert.equal(empty.length, 0);
  assert.equal(empty.dataB64, "");
});

test("base64 known vectors and 512KiB boundary; oversized rejects", () => {
  const { s, P } = openStreaming();
  assert.equal(s.nextChunkCmd(new Uint8Array([0])).dataB64, "AA==");
  assert.equal(s.nextChunkCmd(new Uint8Array([255])).dataB64, "/w==");
  assert.equal(s.nextChunkCmd(new Uint8Array([0, 0])).dataB64, "AAA=");
  // Drain window so boundary tests can run independently of outstanding.
  s.onAck({ type: "file-chunk-ack", sinkId: "s1", seq: 0 });
  s.onAck({ type: "file-chunk-ack", sinkId: "s1", seq: 1 });
  s.onAck({ type: "file-chunk-ack", sinkId: "s1", seq: 2 });

  const max = new Uint8Array(P.MAX_CHUNK_BYTES);
  max[0] = 1;
  max[P.MAX_CHUNK_BYTES - 1] = 2;
  const maxCmd = s.nextChunkCmd(max);
  assert.equal(maxCmd.length, P.MAX_CHUNK_BYTES);
  assert.equal(typeof maxCmd.dataB64, "string");
  assert.equal(maxCmd.dataB64.length, Math.ceil(P.MAX_CHUNK_BYTES / 3) * 4);

  assert.throws(
    () => s.nextChunkCmd(new Uint8Array(P.MAX_CHUNK_BYTES + 1)),
    (err) => err instanceof RangeError
  );
  assert.throws(() => s.nextChunkCmd(null), TypeError);
  assert.throws(() => s.nextChunkCmd(new ArrayBuffer(4)), TypeError);
  assert.throws(() => s.nextChunkCmd([1, 2, 3]), TypeError);
  assert.throws(() => s.nextChunkCmd("AA=="), TypeError);
});

test("window of four unacked; duplicate/unknown/wrong-sink acks do not free capacity", () => {
  const { s, P } = openStreaming();
  assert.equal(P.MAX_UNACKED, 4);
  const issued = [];
  for (let i = 0; i < 4; i++) {
    const cmd = s.nextChunkCmd(new Uint8Array([i]));
    assert.ok(cmd);
    assert.equal(cmd.seq, i);
    issued.push(cmd);
  }
  assert.equal(s.outstandingCount, 4);
  assert.equal(s.nextChunkCmd(new Uint8Array([9])), null);
  assert.equal(s.outstandingCount, 4);

  const before = snapshotSession(s);
  assert.equal(s.onAck({ type: "file-chunk-ack", sinkId: "s1", seq: 0 }), true);
  assert.equal(s.outstandingCount, 3);
  // Duplicate ack
  assert.equal(s.onAck({ type: "file-chunk-ack", sinkId: "s1", seq: 0 }), false);
  assert.equal(s.outstandingCount, 3);
  // Never issued
  assert.equal(s.onAck({ type: "file-chunk-ack", sinkId: "s1", seq: 99 }), false);
  assert.equal(s.outstandingCount, 3);
  // Wrong sink
  assert.equal(s.onAck({ type: "file-chunk-ack", sinkId: "other", seq: 1 }), false);
  assert.equal(s.outstandingCount, 3);
  // Malformed
  assert.equal(s.onAck({ type: "file-chunk", sinkId: "s1", seq: 1 }), false);
  assert.equal(s.onAck({ type: "file-chunk-ack", sinkId: "s1", seq: -1 }), false);
  assert.equal(s.onAck({ type: "file-chunk-ack", sinkId: "s1", seq: 1.5 }), false);
  assert.equal(s.onAck({ type: "file-chunk-ack", sinkId: "s1", seq: true }), false);
  assert.equal(s.onAck(null), false);
  assert.equal(s.outstandingCount, 3);
  assert.equal(s.state, before.state);
  assert.equal(s.sinkId, before.sinkId);

  // Free remaining; no underflow past zero
  assert.equal(s.onAck({ type: "file-chunk-ack", sinkId: "s1", seq: 1 }), true);
  assert.equal(s.onAck({ type: "file-chunk-ack", sinkId: "s1", seq: 2 }), true);
  assert.equal(s.onAck({ type: "file-chunk-ack", sinkId: "s1", seq: 3 }), true);
  assert.equal(s.outstandingCount, 0);
  assert.equal(s.onAck({ type: "file-chunk-ack", sinkId: "s1", seq: 3 }), false);
  assert.equal(s.outstandingCount, 0);

  const next = s.nextChunkCmd(new Uint8Array([7]));
  assert.equal(next.seq, 4);
  assert.equal(s.outstandingCount, 1);
  assert.ok(issued[0]);
});

test("nextChunkCmd only while streaming; seq advances only for issued commands", () => {
  const { createFileSinkSession } = loadProtocol();
  const s = createFileSinkSession({
    jobId: "j1",
    attemptToken: "a1",
    requestedFilename: "out.mp4",
    destinationDirectory: null,
  });
  assert.equal(s.nextChunkCmd(new Uint8Array([1])), null);
  s.onOpened({ type: "file-opened", sinkId: "s1", jobId: "j1", attemptToken: "a1" });
  const c0 = s.nextChunkCmd(new Uint8Array([1]));
  const c1 = s.nextChunkCmd(new Uint8Array([2]));
  const c2 = s.nextChunkCmd(new Uint8Array([3]));
  const c3 = s.nextChunkCmd(new Uint8Array([4]));
  assert.equal(s.nextChunkCmd(new Uint8Array([5])), null);
  assert.equal(c0.seq, 0);
  assert.equal(c1.seq, 1);
  assert.equal(c2.seq, 2);
  assert.equal(c3.seq, 3);
  // Backpressured call must not advance seq.
  s.onAck({ type: "file-chunk-ack", sinkId: "s1", seq: 0 });
  const c4 = s.nextChunkCmd(new Uint8Array([5]));
  assert.equal(c4.seq, 4);
});

// ---------------------------------------------------------------------------
// Commit / abort / terminal first-wins
// ---------------------------------------------------------------------------

test("commit waits for outstanding acks; abort allowed with outstanding", () => {
  const { s } = openStreaming({ requestedFilename: "out.mp4", destinationDirectory: null });
  s.nextChunkCmd(new Uint8Array([1]));
  s.nextChunkCmd(new Uint8Array([2]));
  assert.equal(s.outstandingCount, 2);
  assert.equal(s.commitCmd(), null);

  const abortWhileOut = s.abortCmd();
  assertFrozenAllowlist(abortWhileOut, ["cmd", "sinkId", "jobId", "attemptToken"]);
  assert.equal(abortWhileOut.cmd, "file-abort");
  assert.equal(s.state, "streaming"); // building abort does not terminalize

  s.onAck({ type: "file-chunk-ack", sinkId: "s1", seq: 0 });
  s.onAck({ type: "file-chunk-ack", sinkId: "s1", seq: 1 });
  assert.equal(s.outstandingCount, 0);
  const commit = s.commitCmd();
  assert.deepEqual(commit, {
    cmd: "file-commit",
    sinkId: "s1",
    jobId: "j1",
    attemptToken: "a1",
  });
  assert.equal(s.state, "streaming");
  assert.equal(Object.prototype.hasOwnProperty.call(commit, "requestedFilename"), false);
});

test("onCommitted and onAborted require host ack; first valid terminal wins", () => {
  const { s } = openStreaming({ requestedFilename: "out.mp4", destinationDirectory: null });
  // Building commit/abort alone does not terminalize.
  s.commitCmd();
  s.abortCmd();
  assert.equal(s.state, "streaming");

  assert.equal(
    s.onCommitted({
      type: "file-committed",
      sinkId: "wrong",
      file: "out.mp4",
      bytes: 10,
    }),
    null
  );
  assert.equal(s.state, "streaming");
  assert.equal(
    s.onCommitted({
      type: "file-committed",
      sinkId: "s1",
      file: "",
      bytes: 10,
    }),
    null
  );
  assert.equal(
    s.onCommitted({
      type: "file-committed",
      sinkId: "s1",
      file: "out.mp4",
      bytes: -1,
    }),
    null
  );
  assert.equal(
    s.onCommitted({
      type: "file-committed",
      sinkId: "s1",
      file: "out.mp4",
      bytes: 1.5,
    }),
    null
  );
  assert.equal(
    s.onCommitted({
      type: "file-committed",
      sinkId: "s1",
      file: "out.mp4",
      bytes: 3,
      jobId: "stale",
    }),
    null
  );

  const committed = s.onCommitted({
    type: "file-committed",
    sinkId: "s1",
    jobId: "j1",
    attemptToken: "a1",
    file: "out.mp4",
    bytes: 3,
    secret: "SHOULD-NOT-LEAK",
    path: "C:\\\\secret\\out.mp4",
  });
  assertFrozenAllowlist(committed, ["status", "bytes", "file"]);
  assert.equal(committed.status, "committed");
  assert.equal(committed.bytes, 3);
  assert.equal(committed.file, "out.mp4");
  assert.equal(s.state, "committed");

  // Later terminals ignored.
  assert.equal(
    s.onAborted({ type: "file-aborted", sinkId: "s1" }),
    null
  );
  assert.equal(
    s.onCommitted({
      type: "file-committed",
      sinkId: "s1",
      file: "other.mp4",
      bytes: 9,
    }),
    null
  );
  assert.equal(s.state, "committed");
  assert.equal(s.openCmd(), null);
  assert.equal(s.nextChunkCmd(new Uint8Array([1])), null);
  assert.equal(s.commitCmd(), null);
  assert.equal(s.abortCmd(), null);
  assert.equal(s.onAck({ type: "file-chunk-ack", sinkId: "s1", seq: 0 }), false);
  assert.equal(
    s.onHostError({
      type: "file-error",
      sinkId: "s1",
      jobId: "j1",
      attemptToken: "a1",
      failureCategory: "local_io",
    }),
    null
  );
});

test("abort acknowledgement can win when commit was only requested", () => {
  const { s } = openStreaming({ requestedFilename: "out.mp4", destinationDirectory: null });
  s.commitCmd();
  const aborted = s.onAborted({ type: "file-aborted", sinkId: "s1" });
  assert.ok(aborted);
  assert.equal(s.state, "aborted");
  assert.equal(
    s.onCommitted({
      type: "file-committed",
      sinkId: "s1",
      file: "out.mp4",
      bytes: 0,
    }),
    null
  );
  assert.equal(s.state, "aborted");
  assert.equal(s.abortCmd(), null);
  assert.equal(s.commitCmd(), null);
});

test("stale aborted frames cause zero mutation", () => {
  const { s } = openStreaming();
  const before = snapshotSession(s);
  assert.equal(s.onAborted(null), null);
  assert.equal(s.onAborted({ type: "file-aborted", sinkId: "other" }), null);
  assert.equal(s.onAborted({ type: "file-abort", sinkId: "s1" }), null);
  assert.deepEqual(snapshotSession(s), before);
});

// ---------------------------------------------------------------------------
// Host error privacy / stale identity
// ---------------------------------------------------------------------------

test("host error strips secrets, normalizes category, rejects stale identity", () => {
  const { s } = openStreaming();
  const before = snapshotSession(s);

  assert.equal(
    s.onHostError({
      type: "file-error",
      sinkId: "old-sink",
      jobId: "j1",
      attemptToken: "a1",
      failureCategory: "timeout",
      reason: "SECRET-PATH",
    }),
    null
  );
  assert.deepEqual(snapshotSession(s), before);

  assert.equal(
    s.onHostError({
      type: "file-error",
      sinkId: "s1",
      jobId: "other-job",
      attemptToken: "a1",
      failureCategory: "local_io",
    }),
    null
  );
  assert.deepEqual(snapshotSession(s), before);

  assert.equal(
    s.onHostError({
      type: "pget-fallback",
      sinkId: "s1",
      failureCategory: "local_io",
    }),
    null
  );

  const out = s.onHostError({
    type: "file-error",
    sinkId: "s1",
    jobId: "j1",
    attemptToken: "a1",
    failureCategory: "timeout",
    reason: "disk full at C:\\\\Users\\secret\\file.mp4",
    rawError: "EIO boom",
    path: "C:\\\\Users\\secret\\file.mp4",
    isSaturation: true,
    invokeFirefox: true,
    secret: "token",
  });
  assertFrozenAllowlist(out, [
    "failureCategory",
    "invokeFirefox",
    "isSaturation",
  ]);
  assert.deepEqual(out, {
    failureCategory: "local_io",
    invokeFirefox: false,
    isSaturation: false,
  });
  assert.equal(s.state, "failed");
  // Exactly once
  assert.equal(
    s.onHostError({
      type: "file-error",
      sinkId: "s1",
      jobId: "j1",
      attemptToken: "a1",
      failureCategory: "local_io",
    }),
    null
  );
  assert.equal(s.state, "failed");
  assert.equal(JSON.stringify(out).includes("SECRET"), false);
  assert.equal(JSON.stringify(out).includes("secret"), false);
  assert.equal(JSON.stringify(out).includes("disk full"), false);
});

test("open-state host error matches attempt identity without sink", () => {
  const { createFileSinkSession } = loadProtocol();
  const s = createFileSinkSession({
    jobId: "j1",
    attemptToken: "a1",
    requestedFilename: "out.mp4",
    destinationDirectory: null,
  });
  assert.equal(
    s.onHostError({
      type: "file-error",
      jobId: "j1",
      attemptToken: "stale",
      failureCategory: "local_io",
      reason: "bad-dir",
    }),
    null
  );
  assert.equal(s.state, "open");
  const out = s.onHostError({
    type: "file-error",
    jobId: "j1",
    attemptToken: "a1",
    failureCategory: "local_io",
    reason: "bad-dir",
  });
  assert.deepEqual(out, {
    failureCategory: "local_io",
    invokeFirefox: false,
    isSaturation: false,
  });
  assert.equal(s.state, "failed");
});

// ---------------------------------------------------------------------------
// Task-16 fix1: required host-error identity + commit waits for outstanding
// ---------------------------------------------------------------------------

test("open-state file-error requires exact job+attempt; missing/mismatched/nonempty-sink ignored", () => {
  const { createFileSinkSession } = loadProtocol();
  const s = createFileSinkSession({
    jobId: "j1",
    attemptToken: "a1",
    requestedFilename: "out.mp4",
    destinationDirectory: null,
  });
  const before = snapshotSession(s);

  const rejects = [
    { type: "file-error", failureCategory: "local_io" },
    { type: "file-error", jobId: "j1", failureCategory: "local_io" },
    { type: "file-error", attemptToken: "a1", failureCategory: "local_io" },
    {
      type: "file-error",
      jobId: "other",
      attemptToken: "a1",
      failureCategory: "local_io",
    },
    {
      type: "file-error",
      jobId: "j1",
      attemptToken: "stale",
      failureCategory: "local_io",
    },
    {
      type: "file-error",
      jobId: "j1",
      attemptToken: "a1",
      sinkId: "s1",
      failureCategory: "local_io",
    },
    {
      type: "file-error",
      jobId: "j1",
      attemptToken: "a1",
      sinkId: "foreign",
      failureCategory: "local_io",
    },
  ];
  for (const msg of rejects) {
    assert.equal(s.onHostError(msg), null);
    assert.deepEqual(snapshotSession(s), before);
  }

  // Exact job+attempt with absent/null/empty sinkId is accepted once.
  const acceptedShapes = [
    {
      type: "file-error",
      jobId: "j1",
      attemptToken: "a1",
      failureCategory: "local_io",
    },
    {
      type: "file-error",
      jobId: "j1",
      attemptToken: "a1",
      sinkId: null,
      failureCategory: "local_io",
    },
    {
      type: "file-error",
      jobId: "j1",
      attemptToken: "a1",
      sinkId: "",
      failureCategory: "local_io",
    },
  ];
  // First shape fails the session; remaining exact frames are ignored.
  const out = s.onHostError(acceptedShapes[0]);
  assert.deepEqual(out, {
    failureCategory: "local_io",
    invokeFirefox: false,
    isSaturation: false,
  });
  assert.equal(s.state, "failed");
  assert.equal(s.outstandingCount, 0);
  assert.equal(s.onHostError(acceptedShapes[1]), null);
  assert.equal(s.onHostError(acceptedShapes[2]), null);
  assert.equal(s.state, "failed");
});

test("open-state accepts exact file-error with null or empty sinkId only while open", () => {
  // Independent session for null sinkId acceptance path.
  const { createFileSinkSession } = loadProtocol();
  const sNull = createFileSinkSession({
    jobId: "j1",
    attemptToken: "a1",
    requestedFilename: "out.mp4",
    destinationDirectory: null,
  });
  const outNull = sNull.onHostError({
    type: "file-error",
    jobId: "j1",
    attemptToken: "a1",
    sinkId: null,
    failureCategory: "timeout",
  });
  assert.deepEqual(outNull, {
    failureCategory: "local_io",
    invokeFirefox: false,
    isSaturation: false,
  });
  assert.equal(sNull.state, "failed");

  const sEmpty = createFileSinkSession({
    jobId: "j1",
    attemptToken: "a1",
    requestedFilename: "out.mp4",
    destinationDirectory: null,
  });
  const outEmpty = sEmpty.onHostError({
    type: "file-error",
    jobId: "j1",
    attemptToken: "a1",
    sinkId: "",
    failureCategory: "local_io",
  });
  assert.deepEqual(outEmpty, {
    failureCategory: "local_io",
    invokeFirefox: false,
    isSaturation: false,
  });
  assert.equal(sEmpty.state, "failed");
});

test("streaming file-error requires exact sinkId+jobId+attemptToken; missing forms ignored", () => {
  const { s } = openStreaming({
    requestedFilename: "out.mp4",
    destinationDirectory: null,
  });
  s.nextChunkCmd(new Uint8Array([1]));
  const before = snapshotSession(s);
  assert.equal(before.state, "streaming");
  assert.equal(before.outstandingCount, 1);

  const rejects = [
    { type: "file-error", failureCategory: "local_io" },
    {
      type: "file-error",
      jobId: "j1",
      attemptToken: "a1",
      failureCategory: "local_io",
    },
    {
      type: "file-error",
      sinkId: "s1",
      jobId: "j1",
      failureCategory: "local_io",
    },
    {
      type: "file-error",
      sinkId: "s1",
      attemptToken: "a1",
      failureCategory: "local_io",
    },
    {
      type: "file-error",
      sinkId: "other",
      jobId: "j1",
      attemptToken: "a1",
      failureCategory: "local_io",
    },
    {
      type: "file-error",
      sinkId: "s1",
      jobId: "other",
      attemptToken: "a1",
      failureCategory: "local_io",
    },
    {
      type: "file-error",
      sinkId: "s1",
      jobId: "j1",
      attemptToken: "stale",
      failureCategory: "local_io",
    },
    {
      type: "file-error",
      sinkId: "",
      jobId: "j1",
      attemptToken: "a1",
      failureCategory: "local_io",
    },
  ];

  for (const msg of rejects) {
    assert.equal(s.onHostError(msg), null);
    assert.deepEqual(snapshotSession(s), before);
  }

  const out = s.onHostError({
    type: "file-error",
    sinkId: "s1",
    jobId: "j1",
    attemptToken: "a1",
    failureCategory: "timeout",
    reason: "disk full",
  });
  assert.deepEqual(out, {
    failureCategory: "local_io",
    invokeFirefox: false,
    isSaturation: false,
  });
  assert.equal(s.state, "failed");
  assert.equal(s.outstandingCount, 0);
  // Exactly once
  assert.equal(
    s.onHostError({
      type: "file-error",
      sinkId: "s1",
      jobId: "j1",
      attemptToken: "a1",
      failureCategory: "local_io",
    }),
    null
  );
  assert.equal(s.state, "failed");
  assert.equal(s.outstandingCount, 0);
});

test("onCommitted ignores matching frame while outstanding; accepts after exact ack drains", () => {
  const { s } = openStreaming({
    requestedFilename: "out.mp4",
    destinationDirectory: null,
  });
  const chunk = s.nextChunkCmd(new Uint8Array([9]));
  assert.ok(chunk);
  assert.equal(s.outstandingCount, 1);
  assert.equal(s.commitCmd(), null);

  const commitFrame = {
    type: "file-committed",
    sinkId: "s1",
    jobId: "j1",
    attemptToken: "a1",
    file: "out.mp4",
    bytes: 1,
  };
  assert.equal(s.onCommitted(commitFrame), null);
  assert.equal(s.state, "streaming");
  assert.equal(s.outstandingCount, 1);
  assert.equal(s.commitCmd(), null);

  assert.equal(
    s.onAck({ type: "file-chunk-ack", sinkId: "s1", seq: chunk.seq }),
    true
  );
  assert.equal(s.outstandingCount, 0);
  assert.ok(s.commitCmd());

  const committed = s.onCommitted(commitFrame);
  assert.deepEqual(committed, {
    status: "committed",
    bytes: 1,
    file: "out.mp4",
  });
  assert.equal(s.state, "committed");
  assert.equal(s.outstandingCount, 0);
});

test("accepted abort/error terminals clear outstanding; late acks and terminals ignored", () => {
  // Abort path with outstanding.
  const { s: sAbort } = openStreaming({
    requestedFilename: "out.mp4",
    destinationDirectory: null,
  });
  sAbort.nextChunkCmd(new Uint8Array([1]));
  sAbort.nextChunkCmd(new Uint8Array([2]));
  assert.equal(sAbort.outstandingCount, 2);
  const aborted = sAbort.onAborted({ type: "file-aborted", sinkId: "s1" });
  assert.deepEqual(aborted, { status: "aborted" });
  assert.equal(sAbort.state, "aborted");
  assert.equal(sAbort.outstandingCount, 0);
  assert.equal(
    sAbort.onAck({ type: "file-chunk-ack", sinkId: "s1", seq: 0 }),
    false
  );
  assert.equal(
    sAbort.onCommitted({
      type: "file-committed",
      sinkId: "s1",
      file: "out.mp4",
      bytes: 2,
    }),
    null
  );
  assert.equal(sAbort.onAborted({ type: "file-aborted", sinkId: "s1" }), null);
  assert.equal(sAbort.outstandingCount, 0);
  assert.equal(sAbort.state, "aborted");

  // Error path with outstanding.
  const { s: sFail } = openStreaming({
    requestedFilename: "out.mp4",
    destinationDirectory: null,
  });
  sFail.nextChunkCmd(new Uint8Array([3]));
  assert.equal(sFail.outstandingCount, 1);
  const failed = sFail.onHostError({
    type: "file-error",
    sinkId: "s1",
    jobId: "j1",
    attemptToken: "a1",
    failureCategory: "local_io",
  });
  assert.deepEqual(failed, {
    failureCategory: "local_io",
    invokeFirefox: false,
    isSaturation: false,
  });
  assert.equal(sFail.state, "failed");
  assert.equal(sFail.outstandingCount, 0);
  assert.equal(
    sFail.onAck({ type: "file-chunk-ack", sinkId: "s1", seq: 0 }),
    false
  );
  assert.equal(
    sFail.onHostError({
      type: "file-error",
      sinkId: "s1",
      jobId: "j1",
      attemptToken: "a1",
      failureCategory: "local_io",
    }),
    null
  );
  assert.equal(sFail.outstandingCount, 0);
  assert.equal(sFail.state, "failed");
});

// ---------------------------------------------------------------------------
// Pure pget builders
// ---------------------------------------------------------------------------

test("buildPgetCmd and buildPgetSingleCmd exact shapes; ignore secrets without touching getters", () => {
  const { buildPgetCmd, buildPgetSingleCmd } = loadProtocol();
  let cookieTouches = 0;
  let headerTouches = 0;
  let originTouches = 0;
  let pageTitleTouches = 0;
  let userActionTokenTouches = 0;
  const intent = {
    requestedFilename: FLOREN,
    destinationDirectory: "D:\\\\Vids",
    saveMode: "save-as",
    userSelectedFirefox: false,
    userActionToken: "t",
    createdAt: "t0",
  };
  Object.defineProperty(intent, "cookie", {
    enumerable: true,
    get() {
      cookieTouches++;
      return "a=b";
    },
  });
  Object.defineProperty(intent, "headers", {
    enumerable: true,
    get() {
      headerTouches++;
      return { Authorization: "Bearer x", Cookie: "a=b" };
    },
  });
  Object.defineProperty(intent, "origin", {
    enumerable: true,
    get() {
      originTouches++;
      return "https://evil";
    },
  });
  Object.defineProperty(intent, "pageTitle", {
    enumerable: true,
    get() {
      pageTitleTouches++;
      return "Should Not Rank";
    },
  });
  Object.defineProperty(intent, "sourceContext", {
    enumerable: true,
    get() {
      headerTouches++;
      return { url: "https://cdn/other.mp4" };
    },
  });
  const input = {
    jobId: "j1",
    attemptToken: "a1",
    intent,
    url: "https://cdn/x.mp4?sig=SECRET",
    maxConnections: 4,
    providerGeneration: 3,
    referer: "https://page.example/watch",
    userAgent: "TestUA/1.0",
  };
  Object.defineProperty(input, "cookie", {
    enumerable: true,
    get() {
      cookieTouches++;
      return "session=SECRET";
    },
  });
  Object.defineProperty(input, "headers", {
    enumerable: true,
    get() {
      headerTouches++;
      return { Authorization: "Bearer SECRET" };
    },
  });
  Object.defineProperty(input, "Authorization", {
    enumerable: true,
    get() {
      headerTouches++;
      return "Bearer SECRET";
    },
  });
  Object.defineProperty(input, "userActionToken", {
    enumerable: true,
    get() {
      userActionTokenTouches++;
      return "must-not-touch";
    },
  });

  const pget = buildPgetCmd(input);
  assertFrozenAllowlist(pget, [
    "cmd",
    "id",
    "attemptToken",
    "urls",
    "name",
    "dir",
    "maxConnections",
    "providerGeneration",
    "referer",
    "userAgent",
  ]);
  assert.deepEqual(pget, {
    cmd: "pget",
    id: "j1",
    attemptToken: "a1",
    urls: ["https://cdn/x.mp4?sig=SECRET"],
    name: FLOREN,
    dir: "D:\\\\Vids",
    maxConnections: 4,
    providerGeneration: 3,
    referer: "https://page.example/watch",
    userAgent: "TestUA/1.0",
  });
  assert.equal(Object.isFrozen(pget.urls), true);

  const single = buildPgetSingleCmd({
    jobId: "j1",
    attemptToken: "a2",
    intent,
    url: "https://cdn/x.mp4?sig=SECRET",
    providerGeneration: 0,
  });
  assertFrozenAllowlist(single, [
    "cmd",
    "id",
    "attemptToken",
    "urls",
    "name",
    "dir",
    "maxConnections",
    "providerGeneration",
    "referer",
    "userAgent",
  ]);
  assert.deepEqual(single, {
    cmd: "pget-single",
    id: "j1",
    attemptToken: "a2",
    urls: ["https://cdn/x.mp4?sig=SECRET"],
    name: FLOREN,
    dir: "D:\\\\Vids",
    maxConnections: 1,
    providerGeneration: 0,
    referer: "",
    userAgent: "",
  });

  assert.equal(cookieTouches, 0);
  assert.equal(headerTouches, 0);
  assert.equal(originTouches, 0);
  assert.equal(pageTitleTouches, 0);
  assert.equal(userActionTokenTouches, 0);

  // Fresh objects each call
  const again = buildPgetCmd({
    jobId: "j1",
    attemptToken: "a1",
    intent,
    url: "https://cdn/x.mp4?sig=SECRET",
    maxConnections: 4,
    providerGeneration: 3,
    referer: "https://page.example/watch",
    userAgent: "TestUA/1.0",
  });
  assert.notEqual(again, pget);
  assert.notEqual(again.urls, pget.urls);
});

test("builders reject malformed identities/intent/url/concurrency", () => {
  const { buildPgetCmd, buildPgetSingleCmd } = loadProtocol();
  const goodIntent = {
    requestedFilename: FLOREN,
    destinationDirectory: null,
  };
  const good = {
    jobId: "j1",
    attemptToken: "a1",
    intent: goodIntent,
    url: "https://cdn/x.mp4",
    maxConnections: 2,
    providerGeneration: 0,
  };

  assert.throws(() => buildPgetCmd({ ...good, jobId: "" }));
  assert.throws(() => buildPgetCmd({ ...good, attemptToken: "  " }));
  assert.throws(() => buildPgetCmd({ ...good, url: "" }));
  assert.throws(() => buildPgetCmd({ ...good, url: 12 }));
  assert.throws(() => buildPgetCmd({ ...good, maxConnections: 0 }));
  assert.throws(() => buildPgetCmd({ ...good, maxConnections: -1 }));
  assert.throws(() => buildPgetCmd({ ...good, maxConnections: 1.5 }));
  assert.throws(() => buildPgetCmd({ ...good, maxConnections: true }));
  assert.throws(() => buildPgetCmd({ ...good, providerGeneration: -1 }));
  assert.throws(() => buildPgetCmd({ ...good, providerGeneration: 1.5 }));
  assert.throws(() => buildPgetCmd({ ...good, providerGeneration: "0" }));
  assert.throws(() => buildPgetCmd({ ...good, providerGeneration: true }));
  assert.throws(() => buildPgetCmd({ ...good, providerGeneration: null }));
  assert.throws(() =>
    buildPgetCmd({
      ...good,
      intent: { requestedFilename: "", destinationDirectory: null },
    })
  );
  assert.throws(() =>
    buildPgetCmd({
      ...good,
      intent: { requestedFilename: FLOREN, destinationDirectory: "" },
    })
  );
  assert.throws(() => buildPgetCmd({ ...good, intent: null }));
  assert.throws(() => buildPgetSingleCmd({ ...good, url: null }));
  assert.throws(() => buildPgetCmd({ ...good, referer: "x\ny" }));
  assert.throws(() => buildPgetCmd({ ...good, userAgent: "x\u0000y" }));
  assert.throws(() => buildPgetCmd({ ...good, referer: 12 }));
  assert.throws(() => buildPgetCmd({ ...good, userAgent: { v: "x" } }));

  const defaultDir = buildPgetCmd({
    ...good,
    intent: { requestedFilename: FLOREN },
  });
  assert.equal(defaultDir.dir, null);
  assert.equal(defaultDir.providerGeneration, 0);
  assert.equal(defaultDir.referer, "");
  assert.equal(defaultDir.userAgent, "");
});

test("builders require own-data nonnegative providerGeneration (no default 0)", () => {
  const { buildPgetCmd, buildPgetSingleCmd } = loadProtocol();
  const base = {
    jobId: "j1",
    attemptToken: "a1",
    intent: { requestedFilename: FLOREN, destinationDirectory: null },
    url: "https://cdn/x.mp4",
    maxConnections: 2,
  };

  // Missing key — no silent default to 0.
  assert.throws(() => buildPgetCmd(base), TypeError);
  assert.throws(() => buildPgetSingleCmd(base), TypeError);

  // Explicit undefined own-data value.
  assert.throws(
    () => buildPgetCmd(Object.assign({}, base, { providerGeneration: undefined })),
    TypeError
  );

  // null / bool / fractional / negative / object / string.
  for (const bad of [null, true, false, 1.5, -1, -0.1, "0", {}, [], NaN, Infinity]) {
    assert.throws(
      () => buildPgetCmd(Object.assign({}, base, { providerGeneration: bad })),
      TypeError,
      `providerGeneration=${String(bad)}`
    );
  }

  // Accessor must not be invoked; still TypeError.
  let hits = 0;
  const acc = Object.assign({}, base);
  Object.defineProperty(acc, "providerGeneration", {
    enumerable: true,
    configurable: true,
    get() {
      hits += 1;
      return 0;
    },
  });
  assert.throws(() => buildPgetCmd(acc), TypeError);
  assert.equal(hits, 0);

  // Valid nonnegative integers including 0.
  const zero = buildPgetCmd(Object.assign({}, base, { providerGeneration: 0 }));
  assert.equal(zero.providerGeneration, 0);
  const pos = buildPgetSingleCmd(
    Object.assign({}, base, { providerGeneration: 9 })
  );
  assert.equal(pos.providerGeneration, 9);
});

test("HTTP context: only absent referer/userAgent normalize to empty; present controls/null/undefined reject", () => {
  const { buildPgetCmd } = loadProtocol();
  const base = {
    jobId: "j1",
    attemptToken: "a1",
    intent: { requestedFilename: FLOREN, destinationDirectory: null },
    url: "https://cdn/x.mp4",
    maxConnections: 1,
    providerGeneration: 0,
  };

  const absent = buildPgetCmd(base);
  assert.equal(absent.referer, "");
  assert.equal(absent.userAgent, "");

  const ordinary = buildPgetCmd(
    Object.assign({}, base, {
      referer: "https://page.example/watch",
      userAgent: "TestUA/1.0",
    })
  );
  assert.equal(ordinary.referer, "https://page.example/watch");
  assert.equal(ordinary.userAgent, "TestUA/1.0");

  // Present null / explicit undefined are invalid (not normalized to "").
  assert.throws(
    () => buildPgetCmd(Object.assign({}, base, { referer: null })),
    TypeError
  );
  assert.throws(
    () => buildPgetCmd(Object.assign({}, base, { userAgent: null })),
    TypeError
  );
  assert.throws(
    () => buildPgetCmd(Object.assign({}, base, { referer: undefined })),
    TypeError
  );
  assert.throws(
    () => buildPgetCmd(Object.assign({}, base, { userAgent: undefined })),
    TypeError
  );

  // C0 / DEL / C1 controls (incl. U+0085 NEL, CR, LF, NUL).
  for (const bad of [
    "x\ny",
    "x\ry",
    "x\u0000y",
    "x\u007fy",
    "x\u0085y",
    "x\u009fy",
    "\u0080",
  ]) {
    assert.throws(
      () => buildPgetCmd(Object.assign({}, base, { referer: bad })),
      TypeError,
      `referer=${JSON.stringify(bad)}`
    );
    assert.throws(
      () => buildPgetCmd(Object.assign({}, base, { userAgent: bad })),
      TypeError,
      `userAgent=${JSON.stringify(bad)}`
    );
  }

  // Present non-string / accessor.
  assert.throws(
    () => buildPgetCmd(Object.assign({}, base, { referer: 12 })),
    TypeError
  );
  assert.throws(
    () => buildPgetCmd(Object.assign({}, base, { userAgent: { v: "x" } })),
    TypeError
  );
  let hits = 0;
  const acc = Object.assign({}, base);
  Object.defineProperty(acc, "referer", {
    enumerable: true,
    get() {
      hits += 1;
      return "https://page";
    },
  });
  assert.throws(() => buildPgetCmd(acc), TypeError);
  assert.equal(hits, 0);
});

test("mirrors snapshot is descriptor-safe; hostile index/length/proxy fail generically", () => {
  const { buildPgetCmd } = loadProtocol();
  const base = {
    jobId: "j1",
    attemptToken: "a1",
    intent: { requestedFilename: FLOREN, destinationDirectory: null },
    url: "https://cdn/primary.mp4",
    maxConnections: 2,
    providerGeneration: 1,
  };
  const primary = base.url;
  const mirrorB = "https://mirror/b.mp4";

  // Happy path remains primary-first, exact-string dedupe, frozen.
  const ok = buildPgetCmd(
    Object.assign({}, base, {
      mirrors: [primary, mirrorB, mirrorB, "", null, 12],
    })
  );
  assert.deepEqual(ok.urls, [primary, mirrorB]);
  assert.equal(Object.isFrozen(ok.urls), true);

  // Hostile index getter: must not leak secret-bearing errors.
  const hostileIndex = ["https://mirror/ok.mp4"];
  Object.defineProperty(hostileIndex, "0", {
    enumerable: true,
    configurable: true,
    get() {
      throw new Error("DEPENDENCY_SECRET_INDEX");
    },
  });
  assert.throws(
    () => buildPgetCmd(Object.assign({}, base, { mirrors: hostileIndex })),
    (err) => {
      assert.equal(err instanceof TypeError, true);
      assert.equal(String(err.message).includes("SECRET"), false);
      assert.equal(String(err.stack || "").includes("DEPENDENCY_SECRET_INDEX"), false);
      return true;
    }
  );

  // Hostile length via proxy trap (Array.length cannot be redefined as accessor).
  const hostileLength = new Proxy(["https://mirror/ok.mp4"], {
    getOwnPropertyDescriptor(target, prop) {
      if (prop === "length") {
        return {
          configurable: true,
          enumerable: false,
          get() {
            throw new Error("DEPENDENCY_SECRET_LENGTH");
          },
        };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
  assert.throws(
    () => buildPgetCmd(Object.assign({}, base, { mirrors: hostileLength })),
    (err) => {
      assert.equal(err instanceof TypeError, true);
      assert.equal(String(err.message).includes("SECRET"), false);
      return true;
    }
  );

  // Sparse hole (missing own index) fails closed.
  const sparse = [];
  sparse.length = 2;
  sparse[1] = mirrorB;
  assert.throws(
    () => buildPgetCmd(Object.assign({}, base, { mirrors: sparse })),
    TypeError
  );

  // Hostile proxy trap must fail closed as generic TypeError without secret leak.
  const proxy = new Proxy(["https://mirror/ok.mp4"], {
    get() {
      throw new Error("DEPENDENCY_SECRET_PROXY_GET");
    },
    getOwnPropertyDescriptor() {
      throw new Error("DEPENDENCY_SECRET_PROXY_DESC");
    },
  });
  assert.throws(
    () => buildPgetCmd(Object.assign({}, base, { mirrors: proxy })),
    (err) => {
      assert.equal(err instanceof TypeError, true);
      assert.equal(String(err.message).includes("SECRET"), false);
      assert.equal(String(err.stack || "").includes("DEPENDENCY_SECRET"), false);
      return true;
    }
  );
});

test("builders preserve primary+mirrors byte-for-byte with exact-string dedupe and freeze", () => {
  const { buildPgetCmd, buildPgetSingleCmd } = loadProtocol();
  const intent = {
    requestedFilename: FLOREN,
    destinationDirectory: null,
  };
  const primary = "https://cdn/x.mp4?sig=A&exp=1";
  const mirrorSame = "https://cdn/x.mp4?sig=A&exp=1";
  const mirrorB = "https://mirror/x.mp4?sig=B";
  const mirrorC = "https://cdn/x.mp4?sig=C";
  const pget = buildPgetCmd({
    jobId: "j1",
    attemptToken: "a1",
    intent,
    url: primary,
    mirrors: [mirrorSame, mirrorB, "", "  ", null, 12, mirrorC, mirrorB, { u: mirrorC }],
    maxConnections: 3,
    providerGeneration: 2,
  });
  assert.deepEqual(pget.urls, [primary, mirrorB, mirrorC]);
  assert.equal(pget.urls[0], primary);
  assert.equal(Object.isFrozen(pget), true);
  assert.equal(Object.isFrozen(pget.urls), true);
  assert.throws(() => {
    pget.urls.push("https://evil");
  });

  const single = buildPgetSingleCmd({
    jobId: "j1",
    attemptToken: "a2",
    intent,
    url: primary,
    mirrors: [mirrorB, primary, mirrorB],
    providerGeneration: 1,
    referer: "https://ref",
    userAgent: "UA",
  });
  assert.equal(single.maxConnections, 1);
  assert.deepEqual(single.urls, [primary, mirrorB]);
  assert.equal(single.providerGeneration, 1);
  assert.equal(single.referer, "https://ref");
  assert.equal(single.userAgent, "UA");
});

test("builders and file-open resolve effectiveDestinationDirectory without conflicting overrides", () => {
  const {
    buildPgetCmd,
    buildPgetSingleCmd,
    createFileSinkSession,
  } = loadProtocol();
  const intentNull = {
    requestedFilename: FLOREN,
    destinationDirectory: null,
  };
  const intentSave = {
    requestedFilename: FLOREN,
    destinationDirectory: "D:\\\\Vids",
  };

  const fromEffective = buildPgetCmd({
    jobId: "j1",
    attemptToken: "a1",
    intent: intentNull,
    url: "https://cdn/x.mp4",
    maxConnections: 2,
    providerGeneration: 0,
    effectiveDestinationDirectory: "E:\\\\Default",
  });
  assert.equal(fromEffective.dir, "E:\\\\Default");

  // Non-null intent is authoritative when no effective override is supplied.
  const intentOnly = buildPgetSingleCmd({
    jobId: "j1",
    attemptToken: "a2",
    intent: intentSave,
    url: "https://cdn/x.mp4",
    providerGeneration: 0,
  });
  assert.equal(intentOnly.dir, "D:\\\\Vids");

  // Matching non-null effective is accepted (no conflict).
  const matching = buildPgetCmd({
    jobId: "j1",
    attemptToken: "a3",
    intent: intentSave,
    url: "https://cdn/x.mp4",
    maxConnections: 1,
    providerGeneration: 0,
    effectiveDestinationDirectory: "D:\\\\Vids",
  });
  assert.equal(matching.dir, "D:\\\\Vids");

  // Conflicting non-null overrides fail closed.
  assert.throws(() =>
    buildPgetCmd({
      jobId: "j1",
      attemptToken: "a4",
      intent: intentSave,
      url: "https://cdn/x.mp4",
      maxConnections: 1,
      providerGeneration: 0,
      effectiveDestinationDirectory: "E:\\\\Other",
    })
  );
  assert.throws(() =>
    buildPgetCmd({
      jobId: "j1",
      attemptToken: "a5",
      intent: intentNull,
      url: "https://cdn/x.mp4",
      maxConnections: 1,
      providerGeneration: 0,
      effectiveDestinationDirectory: "",
    })
  );
  assert.throws(() =>
    buildPgetCmd({
      jobId: "j1",
      attemptToken: "a6",
      intent: intentNull,
      url: "https://cdn/x.mp4",
      maxConnections: 1,
      providerGeneration: 0,
      effectiveDestinationDirectory: "  ",
    })
  );
  assert.throws(() =>
    buildPgetCmd({
      jobId: "j1",
      attemptToken: "a7",
      intent: intentNull,
      url: "https://cdn/x.mp4",
      maxConnections: 1,
      providerGeneration: 0,
      effectiveDestinationDirectory: { path: "E:\\\\x" },
    })
  );

  const sinkEffective = createFileSinkSession({
    jobId: "j1",
    attemptToken: "a8",
    requestedFilename: FLOREN,
    destinationDirectory: null,
    effectiveDestinationDirectory: "F:\\\\Sink",
  });
  assert.equal(sinkEffective.destinationDirectory, "F:\\\\Sink");
  assert.equal(sinkEffective.openCmd().dir, "F:\\\\Sink");

  const sinkIntentOnly = createFileSinkSession({
    jobId: "j1",
    attemptToken: "a9",
    requestedFilename: FLOREN,
    destinationDirectory: "D:\\\\Vids",
  });
  assert.equal(sinkIntentOnly.destinationDirectory, "D:\\\\Vids");
  assert.equal(sinkIntentOnly.openCmd().dir, "D:\\\\Vids");

  const sinkMatching = createFileSinkSession({
    jobId: "j1",
    attemptToken: "a9b",
    requestedFilename: FLOREN,
    destinationDirectory: "D:\\\\Vids",
    effectiveDestinationDirectory: "D:\\\\Vids",
  });
  assert.equal(sinkMatching.destinationDirectory, "D:\\\\Vids");

  assert.throws(() =>
    createFileSinkSession({
      jobId: "j1",
      attemptToken: "a10",
      requestedFilename: FLOREN,
      destinationDirectory: "D:\\\\Vids",
      effectiveDestinationDirectory: "F:\\\\Other",
    })
  );
  assert.throws(() =>
    createFileSinkSession({
      jobId: "j1",
      attemptToken: "a11",
      requestedFilename: FLOREN,
      destinationDirectory: null,
      effectiveDestinationDirectory: "",
    })
  );
});

test("control builders emit set-limit and cancel with exact attempt fencing", () => {
  const { buildPgetSetLimitCmd, buildPgetCancelCmd } = loadProtocol();
  const limit = buildPgetSetLimitCmd({
    jobId: "j1",
    attemptToken: "atk-live",
    providerGeneration: 7,
    maxConnections: 0,
  });
  assertFrozenAllowlist(limit, [
    "cmd",
    "id",
    "attemptToken",
    "providerGeneration",
    "maxConnections",
  ]);
  assert.deepEqual(limit, {
    cmd: "pget-set-limit",
    id: "j1",
    attemptToken: "atk-live",
    providerGeneration: 7,
    maxConnections: 0,
  });

  const limitPos = buildPgetSetLimitCmd({
    jobId: "j1",
    attemptToken: "atk-live",
    providerGeneration: 0,
    maxConnections: 3,
  });
  assert.equal(limitPos.maxConnections, 3);
  assert.equal(limitPos.providerGeneration, 0);

  const cancel = buildPgetCancelCmd({
    jobId: "j1",
    attemptToken: "atk-cancel",
  });
  assertFrozenAllowlist(cancel, ["cmd", "id", "attemptToken"]);
  assert.deepEqual(cancel, {
    cmd: "pget-cancel",
    id: "j1",
    attemptToken: "atk-cancel",
  });

  assert.throws(() =>
    buildPgetSetLimitCmd({
      jobId: "j1",
      attemptToken: "a",
      providerGeneration: -1,
      maxConnections: 0,
    })
  );
  assert.throws(() =>
    buildPgetSetLimitCmd({
      jobId: "j1",
      attemptToken: "a",
      providerGeneration: 1,
      maxConnections: -1,
    })
  );
  assert.throws(() =>
    buildPgetSetLimitCmd({
      jobId: "j1",
      attemptToken: "a",
      providerGeneration: 1,
      maxConnections: 1.5,
    })
  );
  assert.throws(() =>
    buildPgetSetLimitCmd({
      jobId: "",
      attemptToken: "a",
      providerGeneration: 1,
      maxConnections: 0,
    })
  );
  assert.throws(() =>
    buildPgetSetLimitCmd({
      jobId: "j1",
      attemptToken: "  ",
      providerGeneration: 1,
      maxConnections: 0,
    })
  );
  assert.throws(() => buildPgetCancelCmd({ jobId: "j1", attemptToken: "" }));
  assert.throws(() => buildPgetCancelCmd({ jobId: "  ", attemptToken: "a" }));
});

// ---------------------------------------------------------------------------
// Source hygiene greps (module must stay pure)
// ---------------------------------------------------------------------------

test("file-sink-protocol source contains no downloads/firefox/storage/privacy leaks", () => {
  const abs = path.join(mediaCatcherRoot, "lib", "file-sink-protocol.js");
  const src = fs.readFileSync(abs, "utf8");
  const forbidden = [
    /browser\.downloads/,
    /downloads\.download/,
    /firefoxDownload/,
    /chrome\.storage/,
    /browser\.storage/,
    /localStorage/,
    /sessionStorage/,
    /indexedDB/,
    /document\./,
    /window\./,
    /setTimeout/,
    /setInterval/,
    /XMLHttpRequest/,
    /fetch\s*\(/,
    /pageTitle/,
    /rankFilename|filename-ranker|McFilenameRanker/,
    /cookie/i,
    /Authorization/,
    /nativeMessaging|runtime\.connectNative|port\.postMessage/,
  ];
  for (const re of forbidden) {
    assert.equal(re.test(src), false, `forbidden pattern ${re} found in source`);
  }
  // Explicit referer/userAgent HTTP-context fields are allowlisted; generic header bags are not.
  assert.equal(/headers\s*[:=]/.test(src), false);
});
