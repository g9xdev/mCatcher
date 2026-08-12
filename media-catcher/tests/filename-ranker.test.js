"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadLib } = require("./harness/load-lib.js");
const Ranker = loadLib("lib/filename-ranker.js");
const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, "fixtures", "florenfile-candidates.json"), "utf8"));

test("Florenfile fixture proposes exact 11238-makemebi.net.mp4 and rejects brand title", () => {
  // Mutation: choosing document-title first, or failing to strip .html wrapper.
  const out = Ranker.rank({
    candidates: fixture.candidates,
    providerSite: fixture.providerSite,
    knownExtension: fixture.knownExtension,
    mediaType: "video",
    capturedAt: "2026-08-12T12:00:00.000Z",
  });
  assert.equal(out.proposedFilename, "11238-makemebi.net.mp4");
  assert.ok(out.rejected.some((r) =>
    /florenfile\.com - secure cloud storage/i.test(r.value) && r.reason));
});

test("wrapper extension strip only when media extension precedes page extension", () => {
  // Mutation: always stripping last extension → "11238-makemebi.net".
  assert.equal(Ranker.stripWrapperExtension("11238-makemebi.net.mp4.html"), "11238-makemebi.net.mp4");
  assert.equal(Ranker.stripWrapperExtension("report.html"), "report.html");
});

test("content-disposition outranks generic document title", () => {
  const out = Ranker.rank({
    candidates: [
      { kind: "document-title", value: "Watch now" },
      { kind: "content-disposition", value: "episode-12.mp4" },
    ],
    providerSite: "example.com",
    knownExtension: ".mp4",
  });
  assert.equal(out.proposedFilename, "episode-12.mp4");
});

test("generic basenames video.mp4 and master.m3u8 are rejected", () => {
  const out = Ranker.rank({
    candidates: [
      { kind: "media-url", value: "video.mp4" },
      { kind: "media-url", value: "master.m3u8" },
      { kind: "page-url", value: "/films/ocean-doc.mp4" },
    ],
    providerSite: "cdn.example",
    knownExtension: ".mp4",
  });
  assert.equal(out.proposedFilename, "ocean-doc.mp4");
});

test("sanitize removes reserved path characters and trailing dots/spaces", () => {
  // Mutation: leaving "con:.mp4 " intact.
  assert.equal(Ranker.sanitizeFilename('a/b:c*?.mp4 '), "a_b_c__.mp4");
});

test("user extension empty → append knownExtension; different ext not silently replaced", () => {
  assert.equal(Ranker.ensureExtension("myvideo", ".mp4"), "myvideo.mp4");
  assert.equal(Ranker.ensureExtension("myvideo.mkv", ".mp4"), "myvideo.mkv");
});

test("diagnostics never include query strings", () => {
  const out = Ranker.rank({
    candidates: [
      { kind: "media-url", value: "clip.mp4?token=SECRET_SIGNED_VALUE&e=1" },
      { kind: "visible-filename", value: "clip.mp4" },
    ],
    providerSite: "x.test",
    knownExtension: ".mp4",
  });
  const blob = JSON.stringify(out);
  assert.equal(blob.includes("SECRET_SIGNED_VALUE"), false);
});
