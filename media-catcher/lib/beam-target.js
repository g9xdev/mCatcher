(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.McBeamTarget = api;
})(
  typeof self !== "undefined" ? self :
  (typeof globalThis !== "undefined" ? globalThis : this),
  function () {
  "use strict";

  // ------------------------------------------------------------------------
  // WHICH url the beam overlay sends, and why in that order.
  //
  // Two sources can answer "what is this <video> playing", and they answer
  // different questions:
  //
  //   1. THE ELEMENT'S OWN src. Precise by construction — it is this element,
  //      not some other video on the page. It is also frequently useless:
  //      HLS and DASH players feed the element through MediaSource, and an
  //      MSE-fed element's currentSrc is a `blob:` minted by, and scoped to,
  //      the page that created it. It resolves to nothing anywhere else.
  //
  //   2. THE TAB'S DETECTED MEDIA. The real manifest/media addresses the
  //      extension saw on the network. Always usable when present, and
  //      imprecise: the list is per TAB, and nothing in it records which
  //      <video> element consumed which row. A page with a feature, an ad
  //      break and a preview clip contributes three rows.
  //
  // So: the element's src FIRST whenever it is a beamable http(s) address,
  // because when the element names an address no inference is needed and no
  // other row can be a better answer to "beam THIS video". (In Firefox an
  // http(s) currentSrc means a progressive file, not a segment — Gecko has no
  // native HLS, so anything adaptive has already become a blob:.)
  //
  // The detected list SECOND, and only then. An unusable currentSrc is
  // overwhelmingly a blob:, blob: means MSE, and MSE means a manifest is what
  // is feeding this element — which is why manifests are ranked above direct
  // files here even when a direct file was seen more recently. Recency breaks
  // ties within a kind: the most recently detected stream is the one the page
  // most recently started playing.
  //
  // NEVER chosen, at either step:
  //   - a `youtube` row. Its url is a watch PAGE; beaming it hands the player
  //     an HTML document. (The page's own <video> is MSE-fed, so step 1 has
  //     nothing to offer on YouTube either — the icon refuses there and says
  //     so, which is the honest answer until something resolves the stream.)
  //   - a row marked `drm`. Its segments cannot be decrypted outside the
  //     browser holding the licence, so the TV would show an error. Only rows
  //     KNOWN to be DRM are excluded: `drm` is set during enrichment, so a
  //     not-yet-enriched row is not assumed either way.
  //   - anything that is not an http(s) address (beamableUrl below).
  //
  // Nothing usable is a REFUSAL carrying a sentence, never a url. The whole
  // point of the ordering is that the user is told why rather than handed a
  // blob: the host will bounce.
  // ------------------------------------------------------------------------

  // Manifests before progressive files. Index in this list IS the rank, so a
  // kind absent from it is not beamable at all.
  var KIND_RANK = ["hls", "dash", "direct"];

  var CONTROL_RE = /[\u0000-\u001f\u007f]/;

  // ------------------------------------------------------------------------
  // beamableUrl — the extension's copy of the host's guard.refuse_url.
  //
  // The host is the authority and re-checks everything; this exists so a click
  // on a blob:-fed video is answered by the overlay, in a sentence about this
  // video, instead of by an error frame off the native port. Divergence
  // between the two is safe in both directions: anything this accepts and the
  // host refuses is still refused, and anything this refuses never leaves the
  // extension.
  //
  // Returns the ORIGINAL string, never URL().href — normalising would ship an
  // address different from the one that was checked. Control characters are
  // refused rather than trimmed for the same reason: URL() deletes tabs and
  // newlines before it reports a scheme, so a string that parses clean is not
  // the string that would travel.
  // ------------------------------------------------------------------------
  function beamableUrl(value) {
    if (typeof value !== "string" || !value) return "";
    if (value !== value.trim()) return "";
    if (CONTROL_RE.test(value)) return "";
    var parsed;
    try {
      parsed = new URL(value);
    } catch (e) {
      return "";
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    if (!parsed.host) return "";
    return value;
  }

  function readString(record, key) {
    try {
      var v = record[key];
      return typeof v === "string" ? v : "";
    } catch (e) {
      return "";
    }
  }

  function readTs(record) {
    try {
      var v = record.ts;
      return typeof v === "number" && isFinite(v) ? v : 0;
    } catch (e) {
      return 0;
    }
  }

  function isDrm(record) {
    try {
      return record.drm === true;
    } catch (e) {
      return false;
    }
  }

  // The detected rows this lane may beam, best first. Stable across equal
  // (rank, ts) pairs so a tab whose rows all share a timestamp still resolves
  // to the same address on every click.
  function beamableItems(items) {
    var out = [];
    if (!Array.isArray(items)) return out;
    try {
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (!it || typeof it !== "object") continue;
        var kind = readString(it, "kind");
        var rank = KIND_RANK.indexOf(kind);
        if (rank < 0) continue;
        if (isDrm(it)) continue;
        var url = beamableUrl(readString(it, "url"));
        if (!url) continue;
        out.push({ url: url, kind: kind, rank: rank, ts: readTs(it), at: i });
      }
    } catch (e) {
      // A row that cannot be read is a row that is not beamed; the ones
      // already collected are still good answers.
    }
    out.sort(function (a, b) {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.ts !== b.ts) return b.ts - a.ts;
      return a.at - b.at;
    });
    return out;
  }

  function refusal(reason, error) {
    return Object.freeze({ ok: false, reason: reason, error: error });
  }

  function resolveBeamTarget(args) {
    var elementSrc = "";
    var items = null;
    if (args && typeof args === "object") {
      elementSrc = readString(args, "elementSrc");
      try {
        items = args.items;
      } catch (e) {
        items = null;
      }
    }

    var direct = beamableUrl(elementSrc);
    if (direct) {
      return Object.freeze({ ok: true, url: direct, source: "element", kind: "element" });
    }

    var candidates = beamableItems(items);
    if (candidates.length) {
      return Object.freeze({
        ok: true,
        url: candidates[0].url,
        source: "detected",
        kind: candidates[0].kind,
      });
    }

    // Nothing usable. The shapes of "nothing" are different problems — one is
    // worth waiting out, the others are not — so each gets its own sentence
    // rather than one that would be a guess about two of the three.
    if (elementSrc.slice(0, 5).toLowerCase() === "blob:") {
      return refusal(
        "mse-no-detection",
        "This player builds the video in the page (a blob: source), so there is " +
          "no address to beam. Media Catcher has not detected a stream for this " +
          "tab yet — try again once it has been playing for a moment."
      );
    }
    if (elementSrc) {
      return refusal(
        "unusable-source",
        "This video's source is not a web address Media Catcher can beam, and " +
          "no stream has been detected on this tab."
      );
    }
    return refusal(
      "no-source",
      "No beamable address for this video yet. Media Catcher has not detected " +
        "a stream on this tab."
    );
  }

  return Object.freeze({
    beamableUrl: beamableUrl,
    resolveBeamTarget: resolveBeamTarget,
  });
});
