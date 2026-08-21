"use strict";
//
// Folding duplicate rows, and the duplicate that is NOT one.
//
// Two rows can name the same file and still both belong in the list. The
// codebase already decided this and pinned it twice in
// tests/background-live-detection.test.js:
//
//   :757  "a frame proposing its own name for the page's file keeps its own row"
//   :918  "a subframe DOM claim never suppresses another frame's report of the
//          same file"
//
// content_scripts runs in all_frames, so a third-party ad iframe can report the
// honest page's media URL and propose "Free-iPhone.mp4" for it. Folding on URL
// alone would let whichever frame reported FIRST decide the name of the row the
// user sees. So the rule here is: same source AND same proposed name folds;
// same source with different proposed names does not.
//
// What does fold:
//   - query churn: one source reported twice with different volatile query
//     parameters (cache-busters, session tokens, expiry stamps)
//   - an HLS master and the variants of its own stream, under the existing
//     preferHighestRendition setting
//
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");

function load() {
  return loadLib("lib/item-fold.js");
}

function item(over) {
  return Object.assign({ kind: "direct", url: "https://cdn.example/a.mp4", ts: 1 }, over || {});
}

function fold(items, options) {
  return load().foldItems(items, options);
}

function urls(list) {
  return list.map((i) => i.url);
}

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

test("item-fold dual-exports a frozen api", () => {
  const api = load();
  assert.ok(Object.isFrozen(api));
  assert.deepEqual(Object.keys(api).sort(), ["canonicalSource", "foldItems"]);
});

test("foldItems answers a new array and mutates neither it nor its members", () => {
  const input = [item(), item({ url: "https://cdn.example/b.mp4" })];
  const frozen = input.map((i) => Object.freeze(i));
  const out = fold(frozen, {});
  assert.notEqual(out, frozen);
  assert.equal(input.length, 2);
  assert.equal(out.length, 2);
});

test("a non-array, or entries that are not items, are survived", () => {
  for (const bad of [null, undefined, 0, "x", {}]) {
    assert.deepEqual(fold(bad, {}), []);
  }
  const out = fold([null, 0, "x", item()], {});
  assert.deepEqual(urls(out), ["https://cdn.example/a.mp4"]);
});

// ---------------------------------------------------------------------------
// THE NON-DUPLICATE. This is the behaviour the fold must not become.
// ---------------------------------------------------------------------------

test("two frames proposing DIFFERENT names for the same URL both keep their row", () => {
  const out = fold([
    item({ url: "https://cdn.example/movie.mp4", proposedFilename: "Movie Night.mp4" }),
    item({ url: "https://cdn.example/movie.mp4", proposedFilename: "Free-iPhone.mp4" }),
  ], {});
  assert.equal(out.length, 2,
    "folding on URL alone lets whichever frame reported first name the row");
  assert.deepEqual(out.map((i) => i.proposedFilename), ["Movie Night.mp4", "Free-iPhone.mp4"]);
});

test("differing names block the fold even when the query churn would otherwise match", () => {
  const out = fold([
    item({ url: "https://cdn.example/movie.mp4?t=1", proposedFilename: "Movie Night.mp4" }),
    item({ url: "https://cdn.example/movie.mp4?t=2", proposedFilename: "Free-iPhone.mp4" }),
  ], {});
  assert.equal(out.length, 2);
});

test("the `name` field is read too, since not every lane fills proposedFilename", () => {
  const out = fold([
    item({ url: "https://cdn.example/movie.mp4?t=1", name: "Movie Night.mp4" }),
    item({ url: "https://cdn.example/movie.mp4?t=2", name: "Free-iPhone.mp4" }),
  ], {});
  assert.equal(out.length, 2);
});

test("one named row and one unnamed row of the same source are not folded", () => {
  // An absent name is not agreement with whatever the other row proposed.
  const out = fold([
    item({ url: "https://cdn.example/movie.mp4?t=1", proposedFilename: "Movie Night.mp4" }),
    item({ url: "https://cdn.example/movie.mp4?t=2" }),
  ], {});
  assert.equal(out.length, 2);
});

// ---------------------------------------------------------------------------
// Query churn
// ---------------------------------------------------------------------------

test("one source reported twice with only volatile query params folds to one row", () => {
  const out = fold([
    item({ url: "https://cdn.example/movie.mp4?_=1712000000", proposedFilename: "Movie.mp4" }),
    item({ url: "https://cdn.example/movie.mp4?_=1712000099", proposedFilename: "Movie.mp4" }),
  ], {});
  assert.equal(out.length, 1);
});

test("the row kept is the FIRST seen, so a later report cannot displace it", () => {
  const out = fold([
    item({ url: "https://cdn.example/movie.mp4?t=1", proposedFilename: "Movie.mp4", ts: 5 }),
    item({ url: "https://cdn.example/movie.mp4?t=2", proposedFilename: "Movie.mp4", ts: 9 }),
  ], {});
  assert.equal(out.length, 1);
  assert.equal(out[0].ts, 5);
});

test("a fold records how many rows it absorbed", () => {
  const out = fold([
    item({ url: "https://cdn.example/m.mp4?t=1", proposedFilename: "M.mp4" }),
    item({ url: "https://cdn.example/m.mp4?t=2", proposedFilename: "M.mp4" }),
    item({ url: "https://cdn.example/m.mp4?t=3", proposedFilename: "M.mp4" }),
  ], {});
  assert.equal(out.length, 1);
  assert.equal(out[0].duplicatesFolded, 2);
});

test("a MEANINGFUL query difference is not churn and keeps both rows", () => {
  // Two different files that happen to share a path. Folding these loses one.
  const out = fold([
    item({ url: "https://cdn.example/get?id=111", proposedFilename: "A.mp4" }),
    item({ url: "https://cdn.example/get?id=222", proposedFilename: "A.mp4" }),
  ], {});
  assert.equal(out.length, 2, "id= selects the resource; it is not churn");
});

test("different paths never fold, whatever the query says", () => {
  const out = fold([
    item({ url: "https://cdn.example/a.mp4?t=1", proposedFilename: "X.mp4" }),
    item({ url: "https://cdn.example/b.mp4?t=1", proposedFilename: "X.mp4" }),
  ], {});
  assert.equal(out.length, 2);
});

test("different origins never fold", () => {
  const out = fold([
    item({ url: "https://a.example/movie.mp4", proposedFilename: "X.mp4" }),
    item({ url: "https://b.example/movie.mp4", proposedFilename: "X.mp4" }),
  ], {});
  assert.equal(out.length, 2);
});

test("different kinds of the same path never fold", () => {
  const out = fold([
    item({ url: "https://cdn.example/s.m3u8", kind: "hls", proposedFilename: "X" }),
    item({ url: "https://cdn.example/s.m3u8", kind: "direct", proposedFilename: "X" }),
  ], {});
  assert.equal(out.length, 2);
});

test("a URL that will not parse is passed through rather than grouped", () => {
  const out = fold([
    item({ url: "not a url", proposedFilename: "X" }),
    item({ url: "not a url", proposedFilename: "X" }),
    item({ url: "", proposedFilename: "X" }),
  ], {});
  assert.equal(out.length, 3, "an unparseable string is not evidence two rows are one");
});

test("canonicalSource strips churn and keeps selectors", () => {
  const { canonicalSource } = load();
  const base = canonicalSource("https://cdn.example/v.mp4");
  assert.equal(canonicalSource("https://cdn.example/v.mp4?_=99"), base);
  assert.equal(canonicalSource("https://cdn.example/v.mp4?cb=99&t=12"), base);
  assert.equal(canonicalSource("https://cdn.example/v.mp4#frag"), base);
  assert.notEqual(canonicalSource("https://cdn.example/v.mp4?id=7"), base);
  assert.equal(canonicalSource("nope"), null);
});

// ---------------------------------------------------------------------------
// Master vs its own variants
// ---------------------------------------------------------------------------

function hls(url, over) {
  return Object.assign({ kind: "hls", url, ts: 1, proposedFilename: "Stream" }, over || {});
}

test("a master and the variants of its own stream fold to the master", () => {
  const out = fold([
    hls("https://cdn.example/s/master.m3u8", { isMaster: true }),
    hls("https://cdn.example/s/720/index.m3u8", { bandwidth: 2000000 }),
    hls("https://cdn.example/s/1080/index.m3u8", { bandwidth: 5000000 }),
  ], { preferHighestRendition: true });
  assert.equal(out.length, 1, "three rows for one stream");
  assert.equal(out[0].isMaster, true, "the master is what a download should use");
  assert.equal(out[0].duplicatesFolded, 2);
});

test("without preferHighestRendition the master and its variants all stay", () => {
  const out = fold([
    hls("https://cdn.example/s/master.m3u8", { isMaster: true }),
    hls("https://cdn.example/s/720/index.m3u8", { bandwidth: 2000000 }),
  ], { preferHighestRendition: false });
  assert.equal(out.length, 2, "the fold is under the setting the owner already has");
});

test("a variant of a DIFFERENT stream is not folded into this master", () => {
  const out = fold([
    hls("https://cdn.example/s/master.m3u8", { isMaster: true }),
    hls("https://cdn.example/OTHER/720/index.m3u8", { bandwidth: 2000000 }),
  ], { preferHighestRendition: true });
  assert.equal(out.length, 2);
});

test("variants with no master present are left to keepHighestRendition", () => {
  // background.js already collapses same-directory renditions. This module
  // only removes the row a master makes redundant, so with no master there is
  // nothing here to do and both rows pass through untouched.
  const out = fold([
    hls("https://cdn.example/s/720/index.m3u8", { bandwidth: 2000000 }),
    hls("https://cdn.example/s/1080/index.m3u8", { bandwidth: 5000000 }),
  ], { preferHighestRendition: true });
  assert.equal(out.length, 2);
});

test("a DRM master folds nothing, matching keepHighestRendition's own exclusion", () => {
  const out = fold([
    hls("https://cdn.example/s/master.m3u8", { isMaster: true, drm: true }),
    hls("https://cdn.example/s/720/index.m3u8", { bandwidth: 2000000, drm: true }),
  ], { preferHighestRendition: true });
  assert.equal(out.length, 2);
});

test("a master does not swallow a direct file that happens to sit beside it", () => {
  const out = fold([
    hls("https://cdn.example/s/master.m3u8", { isMaster: true }),
    item({ url: "https://cdn.example/s/clip.mp4", proposedFilename: "Clip.mp4" }),
  ], { preferHighestRendition: true });
  assert.equal(out.length, 2);
});

test("two masters of different streams both survive", () => {
  const out = fold([
    hls("https://cdn.example/a/master.m3u8", { isMaster: true }),
    hls("https://cdn.example/b/master.m3u8", { isMaster: true }),
  ], { preferHighestRendition: true });
  assert.equal(out.length, 2);
});

test("order is preserved for everything that survives", () => {
  const out = fold([
    item({ url: "https://cdn.example/1.mp4", proposedFilename: "1" }),
    item({ url: "https://cdn.example/2.mp4?t=1", proposedFilename: "2" }),
    item({ url: "https://cdn.example/2.mp4?t=2", proposedFilename: "2" }),
    item({ url: "https://cdn.example/3.mp4", proposedFilename: "3" }),
  ], {});
  assert.deepEqual(urls(out), [
    "https://cdn.example/1.mp4",
    "https://cdn.example/2.mp4?t=1",
    "https://cdn.example/3.mp4",
  ]);
});

test("a hostile item cannot throw the fold", () => {
  const hostile = {};
  Object.defineProperty(hostile, "url", { get() { throw new Error("SECRET"); } });
  const good = item();
  const out = fold([hostile, good], {});
  assert.equal(out.length >= 1, true);
  // Compared by identity: reading .url off the hostile row is what throws, and
  // that is the test's problem to avoid, not the fold's.
  assert.equal(out.indexOf(good) >= 0, true, "the ordinary row survived beside it");
});

test("two rows that each propose NOTHING are not folded either", () => {
  // "" === "" compares equal, so an equality test alone would fold these.
  // Neither row proposed a name, so neither has endorsed the other.
  const out = fold([
    item({ url: "https://cdn.example/movie.mp4?t=1" }),
    item({ url: "https://cdn.example/movie.mp4?t=2" }),
  ], {});
  assert.equal(out.length, 2);
});
