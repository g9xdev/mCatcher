"use strict";
//
// Better EVIDENCE for lib/media-size.js, without touching lib/media-size.js.
//
// media-size.js already decides the policy: an exact total beats an estimate,
// a 206 chunk length is never a total, and an estimate renders with an "Est."
// prefix. What it cannot do is invent inputs. estimatedSizeFromBitrate needs a
// durationSeconds AND a bitrate, and for an HLS MASTER background.js supplies
// neither — only the media-playlist branch of enrichment sets item.duration,
// and a master declares no bitrate of its own. So a master row shows
// "Size unknown" even though the numbers exist.
//
// They exist because the master branch ALREADY fetches and parses the top
// variant's playlist, for live/DRM detection and segment registration, and
// then discards the segment durations. This module reads what was already
// fetched. It costs no additional request.
//
// WHICH RENDITION THE ESTIMATE DESCRIBES. A master is a ladder. The number
// produced here describes the HIGHEST-bandwidth variant, because that is the
// playlist the enrichment already fetched and because it is what
// preferHighestRendition would download. A user who picks a lower rendition
// from the quality menu will download LESS than this figure says. That is a
// choice, not a measurement, which is why the result is only ever "estimated"
// and never "exact".
//
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");

function load() {
  return loadLib("lib/stream-evidence.js");
}

function master(over) {
  return Object.assign({
    type: "master",
    variants: [
      { uri: "https://cdn/s/720.m3u8", bandwidth: 2000000, height: 720 },
      { uri: "https://cdn/s/1080.m3u8", bandwidth: 5000000, height: 1080 },
    ],
  }, over || {});
}

function media(over) {
  return Object.assign({
    type: "media",
    isLive: false,
    segments: [{ duration: 6 }, { duration: 6 }, { duration: 4 }],
  }, over || {});
}

test("stream-evidence dual-exports a frozen api", () => {
  const api = load();
  assert.ok(Object.isFrozen(api));
  assert.deepEqual(Object.keys(api).sort(),
    ["playlistDurationSeconds", "topVariant", "masterBitrateEvidence"].sort());
});

// ---------------------------------------------------------------------------
// Duration from a playlist already parsed
// ---------------------------------------------------------------------------

test("a media playlist's duration is the sum of its segment durations", () => {
  const { playlistDurationSeconds } = load();
  assert.equal(playlistDurationSeconds(media()), 16);
});

test("a LIVE playlist has no total duration to report", () => {
  // A live window is a sliding view, not a length. Summing it produces a
  // number that describes the window and would be shown as the file's size.
  const { playlistDurationSeconds } = load();
  assert.equal(playlistDurationSeconds(media({ isLive: true })), null);
});

test("segments with missing or hostile durations do not corrupt the sum", () => {
  const { playlistDurationSeconds } = load();
  assert.equal(playlistDurationSeconds(media({ segments: [{ duration: 6 }, {}, { duration: 4 }] })), 10);
  assert.equal(playlistDurationSeconds(media({ segments: [{ duration: -5 }, { duration: 4 }] })), 4);
  assert.equal(playlistDurationSeconds(media({ segments: [{ duration: NaN }, { duration: 4 }] })), 4);
  assert.equal(playlistDurationSeconds(media({ segments: [{ duration: Infinity }] })), null);
  assert.equal(playlistDurationSeconds(media({ segments: [] })), null);
  assert.equal(playlistDurationSeconds(media({ segments: "nope" })), null);
});

test("a non-playlist yields no duration rather than throwing", () => {
  const { playlistDurationSeconds } = load();
  for (const bad of [null, undefined, 0, "x", {}, { type: "master" }]) {
    assert.equal(playlistDurationSeconds(bad), null, String(bad));
  }
  const hostile = { type: "media", isLive: false };
  Object.defineProperty(hostile, "segments", { get() { throw new Error("SECRET"); } });
  assert.equal(playlistDurationSeconds(hostile), null);
});

// ---------------------------------------------------------------------------
// Which rendition
// ---------------------------------------------------------------------------

test("the top variant is the highest bandwidth, not merely the first listed", () => {
  // Playlist order is not guaranteed to be descending, and background.js's
  // existing `parsed.variants[0]` assumes it is. Choosing explicitly means the
  // figure and the comment about it agree.
  const { topVariant } = load();
  assert.equal(topVariant(master()).bandwidth, 5000000);
  assert.equal(topVariant(master({ variants: [
    { uri: "a", bandwidth: 9000000 }, { uri: "b", bandwidth: 1000000 },
  ] })).bandwidth, 9000000);
});

test("ties and missing bandwidths resolve without throwing", () => {
  const { topVariant } = load();
  assert.equal(topVariant(master({ variants: [{ uri: "a" }, { uri: "b" }] })).uri, "a");
  assert.equal(topVariant(master({ variants: [] })), null);
  assert.equal(topVariant({ type: "master" }), null);
  assert.equal(topVariant(null), null);
});

// ---------------------------------------------------------------------------
// The evidence record handed to media-size.js
// ---------------------------------------------------------------------------

test("a master plus its top variant's playlist yields a bitrate and a duration", () => {
  const { masterBitrateEvidence } = load();
  const out = masterBitrateEvidence(master(), media());
  assert.deepEqual(out, {
    durationSeconds: 16,
    selectedBandwidth: 5000000,
    describesHeight: 1080,
  });
});

test("that evidence produces an ESTIMATED size through media-size.js unchanged", () => {
  // The point of the shape: it is exactly what estimatedSizeFromBitrate reads.
  const { masterBitrateEvidence } = load();
  const { estimatedSizeFromBitrate } = loadLib("lib/media-size.js");
  const size = estimatedSizeFromBitrate(masterBitrateEvidence(master(), media()));
  assert.equal(size.sizeConfidence, "estimated", "never exact: the ladder is a choice");
  assert.equal(size.sizeBytes, Math.round((5000000 * 16) / 8));
});

test("an exact total still beats this estimate", () => {
  const { masterBitrateEvidence } = load();
  const { estimatedSizeFromBitrate, chooseSize } = loadLib("lib/media-size.js");
  const estimate = estimatedSizeFromBitrate(masterBitrateEvidence(master(), media()));
  const exact = { sizeBytes: 12345, sizeConfidence: "exact" };
  assert.equal(chooseSize(estimate, exact).sizeConfidence, "exact");
  assert.equal(chooseSize(exact, estimate).sizeConfidence, "exact");
});

test("no duration, or no bandwidth, yields no evidence rather than half of it", () => {
  const { masterBitrateEvidence } = load();
  assert.equal(masterBitrateEvidence(master(), media({ isLive: true })), null,
    "a live master has no length");
  assert.equal(masterBitrateEvidence(master(), null), null);
  assert.equal(masterBitrateEvidence(master({ variants: [{ uri: "a" }] }), media()), null,
    "a variant that declares no bandwidth gives nothing to multiply");
  assert.equal(masterBitrateEvidence(null, media()), null);
  assert.equal(masterBitrateEvidence(null, null), null);
});

test("describesHeight is carried so the popup can say which rendition it means", () => {
  const { masterBitrateEvidence } = load();
  const out = masterBitrateEvidence(master({ variants: [
    { uri: "a", bandwidth: 800000, height: 480 },
  ] }), media());
  assert.equal(out.describesHeight, 480);

  const noHeight = masterBitrateEvidence(master({ variants: [
    { uri: "a", bandwidth: 800000 },
  ] }), media());
  assert.equal(noHeight.describesHeight, null);
});
