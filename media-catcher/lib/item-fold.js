// Folding duplicate media rows.
//
// The hard part of this is not what to fold but what NOT to. content_scripts
// runs in all_frames, so a third-party ad iframe can report the honest page's
// media URL and propose its own filename for it. Folding two rows because they
// name the same source would let whichever frame reported FIRST decide the name
// the user sees. That is pinned in tests/background-live-detection.test.js at
// "a frame proposing its own name for the page's file keeps its own row" and
// "a subframe DOM claim never suppresses another frame's report of the same
// file", and this module is written to leave it alone: a fold requires the
// proposed names to AGREE, not merely the sources.
//
// Two kinds of duplicate are folded.
//
//   Query churn — one source reported more than once with different volatile
//   query parameters. Only parameters on a known-volatile list are dropped,
//   because the alternative (dropping the whole query) folds together two
//   genuinely different resources served from one path, which is how a great
//   many CDNs address files. A parameter that SELECTS the resource stays.
//
//   A master playlist and the variants of its own stream. background.js's
//   keepHighestRendition already collapses same-directory variants down to the
//   highest bitrate, but it passes masters through untouched, so a stream whose
//   master was also detected still shows two rows. Under the same
//   preferHighestRendition setting, the variants of a master's own stream fold
//   into it — the master is the row a download should use, since it is what
//   carries the full ladder.
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) root.McItemFold = api;
})(
  typeof self !== "undefined" ? self :
  (typeof globalThis !== "undefined" ? globalThis : this),
  function () {
  "use strict";

  // Parameters observed to change between two reports of ONE resource. Kept as
  // an explicit list rather than a heuristic: a parameter this module has not
  // been told about is treated as selecting the resource, so an unknown
  // parameter costs a duplicate row rather than a lost one.
  var VOLATILE_PARAMS = [
    "_",            // jQuery-style cache buster
    "cb", "cachebust", "cache_bust", "nocache", "rand", "r",
    "t", "ts", "time", "timestamp",
    "e", "exp", "expires", "expiry",
    "st", "sig", "signature", "token", "hash", "hmac",
    "session", "sid", "sessid",
    "_hls_ctx", "_hls_msn", "_hls_part",
  ];

  function readString(obj, key) {
    try {
      var v = obj[key];
      return typeof v === "string" ? v : "";
    } catch (e) {
      return "";
    }
  }

  function readBool(obj, key) {
    try { return obj[key] === true; } catch (e) { return false; }
  }

  // The address with churn removed: origin, path, and whatever query survives,
  // sorted so parameter order is not itself a difference. Null when the string
  // is not a URL — an unparseable string is not evidence that two rows are one.
  function canonicalSource(url) {
    if (typeof url !== "string" || !url) return null;
    var u;
    try {
      u = new URL(url);
    } catch (e) {
      return null;
    }
    var kept = [];
    try {
      u.searchParams.forEach(function (value, key) {
        if (VOLATILE_PARAMS.indexOf(String(key).toLowerCase()) === -1) {
          kept.push([String(key), String(value)]);
        }
      });
    } catch (e2) {
      return null;
    }
    kept.sort(function (a, b) {
      if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
      return a[1] < b[1] ? -1 : (a[1] > b[1] ? 1 : 0);
    });
    var query = kept.map(function (p) { return p[0] + "=" + p[1]; }).join("&");
    // The fragment is dropped: it never reaches the server.
    return u.origin + u.pathname + (query ? "?" + query : "");
  }

  // What this row proposes to call the file. Empty when it proposes nothing,
  // and empty is NOT agreement with a row that did propose something — see
  // sameName below.
  function proposedName(item) {
    var proposed = readString(item, "proposedFilename");
    if (proposed) return proposed;
    return readString(item, "name");
  }

  // Two rows may fold only if they agree about the name. An absent name on
  // either side is not agreement: a row that proposed nothing has not endorsed
  // the other row's proposal, and folding it in would hand the surviving row
  // an authority it was never given.
  function sameName(a, b) {
    var an = proposedName(a);
    var bn = proposedName(b);
    // Both empty would compare equal, which is why this is not just an
    // equality test: two rows that each proposed nothing have not agreed.
    if (!an || !bn) return false;
    return an === bn;
  }

  // The stream a master owns: its own directory. Mirrors the reasoning in
  // background.js's renditionGroup — every rendition of one stream lives below
  // the master's directory — but WITHOUT that function's digit normalisation,
  // which is deliberately loose so that sibling directories collapse together.
  // Here a looser rule would let one master claim another stream's variants, so
  // the directory is compared literally.
  function streamDirectory(url) {
    if (typeof url !== "string" || !url) return null;
    try {
      var u = new URL(url);
      return u.origin + u.pathname.replace(/[^/]*$/, "");
    } catch (e) {
      return null;
    }
  }

  function isFoldableHls(item) {
    return readString(item, "kind") === "hls" && !readBool(item, "drm");
  }

  // Answers a new array. Members are copied only when a count is added to them,
  // so a row that folded nothing is passed through as-is.
  function foldItems(items, options) {
    if (!Array.isArray(items)) return [];
    var opts = options && typeof options === "object" ? options : {};

    var out = [];
    var absorbed = [];        // out index -> how many rows folded into it
    var byKey = Object.create(null);   // canonical key -> out index

    // Masters present in this list, so a variant can be tested against the
    // stream it belongs to. Collected first: a variant may be listed before
    // its own master.
    var masterDirs = [];
    if (opts.preferHighestRendition) {
      for (var m = 0; m < items.length; m++) {
        var maybe = items[m];
        if (!maybe || typeof maybe !== "object") continue;
        if (!isFoldableHls(maybe) || !readBool(maybe, "isMaster")) continue;
        var dir = streamDirectory(readString(maybe, "url"));
        if (dir) masterDirs.push(dir);
      }
    }

    // The directory of the master that owns this variant, or null. A variant
    // belongs to a master when it sits at or below that master's own directory
    // — not merely the same origin, since two streams on one CDN share that.
    //
    // This is the ONE place ownership is decided. Both fold passes below ask
    // it rather than re-deriving the rule, so there is no second copy to widen
    // independently of this one.
    function owningMasterDir(item) {
      if (!isFoldableHls(item) || readBool(item, "isMaster")) return null;
      var dir = streamDirectory(readString(item, "url"));
      if (!dir) return null;
      for (var i = 0; i < masterDirs.length; i++) {
        if (dir === masterDirs[i] || dir.indexOf(masterDirs[i]) === 0) return masterDirs[i];
      }
      return null;
    }

    // The index in `list` of the master that owns this variant, or -1.
    function ownerIndexIn(list, item) {
      var ownerDir = owningMasterDir(item);
      if (ownerDir === null) return -1;
      for (var i = 0; i < list.length; i++) {
        if (list[i] === item) continue;
        if (!readBool(list[i], "isMaster")) continue;
        if (streamDirectory(readString(list[i], "url")) === ownerDir) return i;
      }
      return -1;
    }

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item || typeof item !== "object") continue;

      // A variant whose master has already been kept is a second row for a
      // stream that already has one. A variant whose master comes LATER in the
      // input is kept here and folded by the second pass below.
      var ownerNow = ownerIndexIn(out, item);
      if (ownerNow >= 0) {
        absorbed[ownerNow] += 1;
        continue;
      }

      var canonical = canonicalSource(readString(item, "url"));
      var key = canonical === null ? null : readString(item, "kind") + " " + canonical;

      if (key !== null && byKey[key] !== undefined) {
        var atIndex = byKey[key];
        // The name check is the whole reason this is not a URL fold. Two frames
        // that disagree about the name are two rows.
        if (sameName(out[atIndex], item)) {
          absorbed[atIndex] += 1;
          continue;
        }
        // Kept, and deliberately NOT registered under the key: a third report
        // agreeing with the FIRST row should still fold into that first row.
        out.push(item);
        absorbed.push(0);
        continue;
      }

      if (key !== null) byKey[key] = out.length;
      out.push(item);
      absorbed.push(0);
    }

    // Second pass for a variant that preceded its own master in the input.
    if (masterDirs.length > 0) {
      var kept = [];
      var keptAbsorbed = [];
      for (var k = 0; k < out.length; k++) {
        var owner = ownerIndexIn(out, out[k]);
        if (owner >= 0) {
          // Whatever this variant had already absorbed goes with it.
          absorbed[owner] += 1 + absorbed[k];
          continue;
        }
        kept.push(out[k]);
        keptAbsorbed.push(absorbed[k]);
      }
      out = kept;
      absorbed = keptAbsorbed;
    }

    // Only a row that actually absorbed something is copied, so an untouched
    // list comes back with its own objects.
    var result = [];
    for (var r = 0; r < out.length; r++) {
      if (absorbed[r] > 0) {
        var copy = {};
        for (var prop in out[r]) {
          if (Object.prototype.hasOwnProperty.call(out[r], prop)) copy[prop] = out[r][prop];
        }
        copy.duplicatesFolded = absorbed[r];
        result.push(copy);
      } else {
        result.push(out[r]);
      }
    }
    return result;
  }

  return Object.freeze({
    canonicalSource: canonicalSource,
    foldItems: foldItems,
  });
});
