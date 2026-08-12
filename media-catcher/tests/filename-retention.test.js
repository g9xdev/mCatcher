"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");
const Intent = loadLib("lib/download-intent.js");

const PROPOSAL = "11238-makemebi.net.mp4";

test("requestedFilename identical across default, save-as, single-connection job, sink open, firefox intent", () => {
  // Mutation: re-ranking on engine change or using pageTitle at save time.
  const proposal = PROPOSAL;
  const d = Intent.createDefaultIntent({
    proposedFilename: proposal,
    userActionToken: "t",
    now: () => "t",
  });
  const s = Intent.createSaveAsIntent({
    proposedFilename: proposal,
    editedFilename: proposal,
    userActionToken: "t",
    knownExtension: ".mp4",
    now: () => "t",
  });
  const fx = Intent.createFirefoxIntent({ baseIntent: d });
  assert.equal(d.requestedFilename, proposal);
  assert.equal(s.requestedFilename, proposal);
  assert.equal(fx.requestedFilename, proposal);
  const job = { intent: d, mode: "multi-range" };
  job.mode = "single-connection";
  assert.equal(job.intent.requestedFilename, proposal);
  const { createFileSinkSession } = loadLib("lib/file-sink-protocol.js");
  const sink = createFileSinkSession({
    jobId: "j",
    attemptToken: "a",
    requestedFilename: job.intent.requestedFilename,
    destinationDirectory: null,
  });
  assert.equal(sink.openCmd().requestedFilename, proposal);
  assert.equal(sink.requestedFilename, proposal);
});

test("default intent destinationDirectory is null; save-as preserves chosen directory", () => {
  // Mutation: dropping destinationDirectory when building pget / file-open payloads.
  const d = Intent.createDefaultIntent({
    proposedFilename: PROPOSAL,
    destinationDirectory: null,
    userActionToken: "t",
    now: () => "t",
  });
  assert.equal(d.destinationDirectory, null);
  const sa = Intent.createSaveAsIntent({
    proposedFilename: PROPOSAL,
    editedFilename: PROPOSAL,
    destinationDirectory: "D:\\\\Vids",
    userActionToken: "t",
    knownExtension: ".mp4",
    now: () => "t",
  });
  assert.equal(sa.destinationDirectory, "D:\\\\Vids");
});

test("pget, pget-single, and file-open carry requestedFilename and destination directory", () => {
  // Pure payload builders live on file-sink-protocol / router helpers.
  const { buildPgetCmd, buildPgetSingleCmd, createFileSinkSession } = loadLib(
    "lib/file-sink-protocol.js"
  );
  const intentDefault = Object.freeze({
    requestedFilename: PROPOSAL,
    destinationDirectory: null,
    saveMode: "default",
    userSelectedFirefox: false,
    userActionToken: "t",
    createdAt: "t0",
  });
  const intentSaveAs = Object.freeze({
    requestedFilename: PROPOSAL,
    destinationDirectory: "D:\\\\Vids",
    saveMode: "save-as",
    userSelectedFirefox: false,
    userActionToken: "t",
    createdAt: "t0",
  });
  const pget = buildPgetCmd({
    jobId: "j1",
    attemptToken: "a1",
    intent: intentDefault,
    url: "https://cdn/x.mp4",
    maxConnections: 4,
    providerGeneration: 0,
  });
  assert.equal(pget.cmd, "pget");
  assert.equal(pget.name, PROPOSAL);
  assert.equal(pget.dir, null);
  assert.equal(pget.providerGeneration, 0);

  const pgetSingle = buildPgetSingleCmd({
    jobId: "j1",
    attemptToken: "a2",
    intent: intentSaveAs,
    url: "https://cdn/x.mp4",
    providerGeneration: 0,
  });
  assert.equal(pgetSingle.cmd, "pget-single");
  assert.equal(pgetSingle.name, PROPOSAL);
  assert.equal(pgetSingle.dir, "D:\\\\Vids");
  assert.equal(pgetSingle.providerGeneration, 0);

  const sink = createFileSinkSession({
    jobId: "j1",
    attemptToken: "a3",
    requestedFilename: intentSaveAs.requestedFilename,
    destinationDirectory: intentSaveAs.destinationDirectory,
  });
  assert.deepEqual(sink.openCmd(), {
    cmd: "file-open",
    jobId: "j1",
    attemptToken: "a3",
    requestedFilename: PROPOSAL,
    dir: "D:\\\\Vids",
  });

  const sinkDefault = createFileSinkSession({
    jobId: "j2",
    attemptToken: "a4",
    requestedFilename: intentDefault.requestedFilename,
    destinationDirectory: intentDefault.destinationDirectory,
  });
  assert.equal(sinkDefault.openCmd().dir, null);
  assert.equal(sinkDefault.openCmd().requestedFilename, PROPOSAL);
});

test("filename and destination survive scheduler mode change and both builders", () => {
  const { buildPgetCmd, buildPgetSingleCmd, createFileSinkSession } = loadLib(
    "lib/file-sink-protocol.js"
  );
  const intent = Intent.createSaveAsIntent({
    proposedFilename: PROPOSAL,
    editedFilename: PROPOSAL,
    destinationDirectory: "D:\\\\Vids",
    userActionToken: "tok",
    knownExtension: ".mp4",
    now: () => "t0",
  });
  // Scheduler-style job projection: mode changes must not re-rank or drop bindings.
  const job = {
    id: "job-1",
    mode: "multi-range",
    attemptToken: "atk-1",
    intent,
  };
  job.mode = "single-connection";
  assert.equal(job.intent.requestedFilename, PROPOSAL);
  assert.equal(job.intent.destinationDirectory, "D:\\\\Vids");

  const multi = buildPgetCmd({
    jobId: job.id,
    attemptToken: job.attemptToken,
    intent: job.intent,
    url: "https://cdn/video.mp4?token=SIGNED",
    maxConnections: 4,
    providerGeneration: 0,
  });
  assert.equal(multi.name, PROPOSAL);
  assert.equal(multi.dir, "D:\\\\Vids");
  assert.equal(multi.providerGeneration, 0);

  const single = buildPgetSingleCmd({
    jobId: job.id,
    attemptToken: "atk-2",
    intent: job.intent,
    url: "https://cdn/video.mp4?token=SIGNED",
    providerGeneration: 0,
  });
  assert.equal(single.name, PROPOSAL);
  assert.equal(single.dir, "D:\\\\Vids");
  assert.equal(single.maxConnections, 1);
  assert.equal(single.providerGeneration, 0);

  const fx = Intent.createFirefoxIntent({ baseIntent: job.intent });
  assert.equal(fx.requestedFilename, PROPOSAL);
  assert.equal(fx.destinationDirectory, "D:\\\\Vids");

  const sink = createFileSinkSession({
    jobId: job.id,
    attemptToken: "atk-3",
    requestedFilename: fx.requestedFilename,
    destinationDirectory: fx.destinationDirectory,
  });
  assert.equal(sink.openCmd().requestedFilename, PROPOSAL);
  assert.equal(sink.openCmd().dir, "D:\\\\Vids");
  // Later commands never rebind filename/destination.
  sink.onOpened({
    type: "file-opened",
    sinkId: "sink-1",
    jobId: job.id,
    attemptToken: "atk-3",
  });
  const chunk = sink.nextChunkCmd(new Uint8Array([1, 2, 3]));
  assert.equal(Object.prototype.hasOwnProperty.call(chunk, "requestedFilename"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(chunk, "dir"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(chunk, "name"), false);
  assert.equal(
    sink.onAck({ type: "file-chunk-ack", sinkId: "sink-1", seq: chunk.seq }),
    true
  );
  const commit = sink.commitCmd();
  assert.ok(commit);
  assert.equal(Object.prototype.hasOwnProperty.call(commit, "requestedFilename"), false);
  assert.equal(sink.requestedFilename, PROPOSAL);
  assert.equal(sink.destinationDirectory, "D:\\\\Vids");
});

test("default null destination survives pget and pget-single without URL basename substitution", () => {
  const { buildPgetCmd, buildPgetSingleCmd } = loadLib("lib/file-sink-protocol.js");
  const intent = Intent.createDefaultIntent({
    proposedFilename: PROPOSAL,
    destinationDirectory: null,
    userActionToken: "t",
    now: () => "t",
  });
  const url = "https://cdn.example/path/totally-different-name.bin?sig=1";
  const pget = buildPgetCmd({
    jobId: "j",
    attemptToken: "a",
    intent,
    url,
    maxConnections: 3,
    providerGeneration: 0,
  });
  const single = buildPgetSingleCmd({
    jobId: "j",
    attemptToken: "a2",
    intent,
    url,
    providerGeneration: 0,
  });
  assert.equal(pget.name, PROPOSAL);
  assert.equal(pget.dir, null);
  assert.equal(pget.providerGeneration, 0);
  assert.equal(single.name, PROPOSAL);
  assert.equal(single.dir, null);
  assert.equal(single.providerGeneration, 0);
  assert.equal(pget.name.includes("totally-different"), false);
  assert.equal(single.name.includes("totally-different"), false);
});
