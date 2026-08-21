// Evidence for lib/media-size.js, gathered from playlists already fetched.
//
// media-size.js owns the POLICY — exact beats estimated, a 206 chunk length is
// never a total, an estimate renders with an "Est." prefix — and its contract
// tests are what make that meaningful. Nothing here changes it. This module
// only produces better INPUTS.
//
// The gap it fills: estimatedSizeFromBitrate needs a durationSeconds and a
// bitrate. For an HLS MASTER background.js supplies neither — only the
// media-playlist branch of enrichment sets item.duration, and a master
// declares no bitrate of its own — so a master row reads "Size unknown".
//
// WHAT IT COSTS. Nothing beyond what is already spent. The master branch of
// enrichment already fetches and parses the top variant's playlist, for live
// and DRM detection and to register its segments, and then discards the
// segment durations. This reads that same parsed object. No request is added.
//
// WHICH RENDITION THE NUMBER DESCRIBES. A master is a ladder, and one number
// cannot describe all of it. The figure here describes the HIGHEST-bandwidth
// variant: that is the playlist enrichment already fetched, and it is what
// preferHighestRendition downloads. A user who picks a lower rendition from
// the quality menu downloads LESS than this says. That is a choice rather than
// a measurement, which is why the record is only ever fed to
// estimatedSizeFromBitrate — it can never come back "exact" — and why
// describesHeight is carried alongside, so a caller can say which rung it
// means instead of implying it measured the file.
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) root.McStreamEvidence = api;
})(
  typeof self !== "undefined" ? self :
  (typeof globalThis !== "undefined" ? globalThis : this),
  function () {
  "use strict";

  function read(obj, key) {
    try {
      if (!obj || (typeof obj !== "object" && typeof obj !== "function")) return undefined;
      return obj[key];
    } catch (e) {
      return undefined;
    }
  }

  function finitePositive(value) {
    return typeof value === "number" && isFinite(value) && value > 0 ? value : null;
  }

  // The playable length of a parsed MEDIA playlist, in seconds.
  //
  // Null for a live playlist. A live window is a sliding view of a broadcast,
  // not a length: summing it yields a number that describes the window, and
  // showing that as the file's size would state something untrue about a
  // recording whose length is not yet decided.
  function playlistDurationSeconds(playlist) {
    if (read(playlist, "type") !== "media") return null;
    if (read(playlist, "isLive") === true) return null;
    var segments = read(playlist, "segments");
    if (!Array.isArray(segments) || segments.length === 0) return null;
    var total = 0;
    for (var i = 0; i < segments.length; i++) {
      var d = finitePositive(read(segments[i], "duration"));
      if (d !== null) total += d;
    }
    return finitePositive(total);
  }

  // The highest-bandwidth variant of a parsed master.
  //
  // lib/hls.js:91 already sorts variants descending by bandwidth, so for an
  // HLS master this agrees with variants[0]. It is written out anyway for two
  // reasons: the guarantee then belongs to this module rather than to a sort in
  // another file that a caller has to know about, and that sort is
  // `y.bandwidth - x.bandwidth`, which yields NaN for a variant declaring no
  // bandwidth and leaves such entries in unspecified order. A tie keeps the
  // earlier entry, so the choice is stable either way.
  function topVariant(playlist) {
    var variants = read(playlist, "variants");
    if (!Array.isArray(variants) || variants.length === 0) return null;
    var best = null;
    var bestBandwidth = -1;
    for (var i = 0; i < variants.length; i++) {
      var v = variants[i];
      if (!v || typeof v !== "object") continue;
      var b = finitePositive(read(v, "bandwidth")) || 0;
      if (best === null || b > bestBandwidth) {
        best = v;
        bestBandwidth = b;
      }
    }
    return best;
  }

  // The record estimatedSizeFromBitrate reads, or null when either half is
  // missing. Half of it is not a smaller estimate — it is no estimate, and
  // returning a record that cannot produce a size only moves the failure.
  function masterBitrateEvidence(masterPlaylist, topVariantPlaylist) {
    var duration = playlistDurationSeconds(topVariantPlaylist);
    if (duration === null) return null;
    var top = topVariant(masterPlaylist);
    if (!top) return null;
    var bandwidth = finitePositive(read(top, "bandwidth"));
    if (bandwidth === null) return null;
    return {
      durationSeconds: duration,
      // The field name media-size.js reads first, and the one that says this
      // describes a SELECTED rung rather than the stream as a whole.
      selectedBandwidth: bandwidth,
      describesHeight: finitePositive(read(top, "height")),
    };
  }

  return Object.freeze({
    playlistDurationSeconds: playlistDurationSeconds,
    topVariant: topVariant,
    masterBitrateEvidence: masterBitrateEvidence,
  });
});
