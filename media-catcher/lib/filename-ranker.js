(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.McFilenameRanker = api;
})(
  typeof self !== "undefined" ? self :
  (typeof globalThis !== "undefined" ? globalThis : this),
  function () {
  "use strict";

  var MEDIA_EXT_RE = /\.(mp4|m4v|webm|mkv|mov|mp3|m4a|aac|flac|ogg|opus|ts|m2ts|mpeg|mpg)$/i;
  var WRAPPER_EXT_RE = /^(.+\.(mp4|m4v|webm|mkv|mov|mp3|m4a|aac|flac|ogg|opus|ts|m2ts|mpeg|mpg))\.(html?|php|aspx?)$/i;
  var RESERVED_RE = /[\\/:*?"<>|\x00-\x1f\x7f]/g;
  var MAX_CANDIDATE_LEN = 180;
  var DEFAULT_MAX_FILENAME = 150;

  var BASE_WEIGHTS = Object.freeze({
    "content-disposition": 110,
    "visible-filename": 100,
    "download-attr": 100,
    "media-metadata": 90,
    "page-url": 80,
    "referrer-url": 80,
    "og-title": 75,
    "twitter-title": 75,
    heading: 70,
    "document-title": 65,
    "media-url": 45,
  });

  var TABLE_ORDER = Object.keys(BASE_WEIGHTS);

  var GENERIC_BASENAMES = Object.freeze({
    video: true,
    master: true,
    playlist: true,
    index: true,
    download: true,
  });

  var GENERIC_SLOGANS = Object.freeze([
    "secure cloud storage",
    "download",
    "watch online",
    "watch now",
    "free download",
    "cloud storage",
  ]);

  function stripQuery(s) {
    var i = s.indexOf("?");
    return i >= 0 ? s.slice(0, i) : s;
  }

  function fileBaseName(value) {
    var s = String(value || "").replace(/[/\\]+$/, "");
    var slash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return slash >= 0 ? s.slice(slash + 1) : s;
  }

  function stripWrapperExtension(name) {
    var s = String(name || "");
    var m = s.match(WRAPPER_EXT_RE);
    return m ? m[1] : s;
  }

  function normalizeToken(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function tokenize(s) {
    return String(s || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  }

  function tokenSet(providerSite) {
    var set = Object.create(null);
    tokenize(providerSite).forEach(function (t) {
      set[t] = true;
    });
    // Drop ultra-common public suffixes so "com" alone is not a brand signal.
    delete set.com;
    delete set.net;
    delete set.org;
    delete set.io;
    delete set.co;
    return set;
  }

  function ensureExtension(name, knownExt) {
    var s = String(name || "");
    if (!s) return s;
    if (MEDIA_EXT_RE.test(s)) return s;
    if (/\.[a-z0-9]{1,8}$/i.test(s)) return s;
    var ext = knownExt ? String(knownExt) : "";
    if (!ext) return s;
    if (ext.charAt(0) !== ".") ext = "." + ext;
    return s + ext;
  }

  function sanitizeFilename(name, opts) {
    opts = opts || {};
    var maxLen = opts.maxLen != null ? opts.maxLen : DEFAULT_MAX_FILENAME;
    var s = String(name == null ? "" : name);
    s = s.replace(RESERVED_RE, "_");
    s = s.replace(/[.\s]+$/g, "");
    if (s.length > maxLen) {
      var ext = "";
      var base = s;
      var m = s.match(MEDIA_EXT_RE);
      if (m) {
        ext = m[0];
        base = s.slice(0, s.length - ext.length);
      } else {
        var dot = s.lastIndexOf(".");
        if (dot > 0) {
          ext = s.slice(dot);
          base = s.slice(0, dot);
        }
      }
      var room = maxLen - ext.length;
      if (room < 1) room = 1;
      s = base.slice(0, room) + ext;
    }
    return s;
  }

  function bareBasename(value) {
    var base = fileBaseName(value);
    return base.replace(/\.[^.]+$/, "").toLowerCase();
  }

  function rejectReason(c, providerSite, providerTokens) {
    var value = c.value;
    var lower = value.toLowerCase().trim();
    var providerLower = String(providerSite || "").toLowerCase();

    if (providerLower && (lower === providerLower || normalizeToken(value) === normalizeToken(providerSite))) {
      return "provider-brand";
    }

    var sloganHit = null;
    GENERIC_SLOGANS.forEach(function (slogan) {
      if (!sloganHit && lower.indexOf(slogan) !== -1) sloganHit = slogan;
    });
    if (sloganHit) return "generic-slogan:" + sloganHit;

    // Brand + separator + rest (e.g. "Florenfile.com - …") still caught via slogans;
    // pure brand-prefix titles with only brand tokens also rejected below.
    var tokens = tokenize(value);
    if (tokens.length && tokens.every(function (t) {
      return providerTokens[t] || t === "com" || t === "net" || t === "org" || t === "io" || t === "co";
    }) && tokens.some(function (t) { return providerTokens[t]; })) {
      return "provider-brand-tokens";
    }

    // Separators brand pattern: starts with provider token then separator-only junk.
    if (tokens.length >= 1 && providerTokens[tokens[0]]) {
      var rest = tokens.slice(1);
      var brandish = rest.every(function (t) {
        return providerTokens[t] || t === "com" || t === "net" || t === "org" || t === "io" || t === "co" ||
          GENERIC_SLOGANS.some(function (sl) { return sl.split(/\s+/).indexOf(t) !== -1; });
      });
      if (brandish && rest.length) return "provider-brand-pattern";
    }

    var bare = bareBasename(value);
    if (GENERIC_BASENAMES[bare]) return "generic-basename";

    return null;
  }

  function videoTokenBonus(value) {
    var bonus = 0;
    var lower = String(value).toLowerCase();
    if (MEDIA_EXT_RE.test(lower)) bonus += 5;
    var nums = lower.match(/\d{3,}/g);
    if (nums) bonus += Math.min(10, nums.length * 5);
    var stem = lower.replace(MEDIA_EXT_RE, "");
    var tokens = stem.split(/[^a-z0-9]+/).filter(function (t) {
      return t.length >= 4 && !GENERIC_BASENAMES[t];
    });
    bonus += Math.min(10, tokens.length * 4);
    return Math.min(20, bonus);
  }

  function brandPenalty(c, providerTokens) {
    var tokens = tokenize(c.value);
    var hits = 0;
    tokens.forEach(function (t) {
      if (providerTokens[t]) hits += 1;
    });
    if (!hits) return 0;
    return Math.min(30, hits * 10);
  }

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function fallbackName(mediaType, capturedAt, knownExt) {
    var d = capturedAt ? new Date(capturedAt) : new Date(0);
    if (isNaN(d.getTime())) d = new Date(0);
    var stamp =
      d.getUTCFullYear() +
      pad2(d.getUTCMonth() + 1) +
      pad2(d.getUTCDate()) +
      "-" +
      pad2(d.getUTCHours()) +
      pad2(d.getUTCMinutes()) +
      pad2(d.getUTCSeconds());
    var prefix = mediaType === "audio" ? "audio" : "video";
    var ext = knownExt ? String(knownExt) : ".mp4";
    if (ext.charAt(0) !== ".") ext = "." + ext;
    return prefix + "-" + stamp + ext;
  }

  function rank(input) {
    input = input || {};
    var providerSite = String(input.providerSite || "");
    var providerTokens = tokenSet(providerSite);
    var knownExt = input.knownExtension || "";
    var rejected = [];
    var seen = Object.create(null);
    var scored = [];
    var list = [];

    (input.candidates || []).forEach(function (c) {
      var kind = String(c.kind || "");
      var raw = String(c.value == null ? "" : c.value).trim();
      if (!raw) return;
      // Always strip volatile query before any storage/scoring (signed URLs).
      var value = stripWrapperExtension(fileBaseName(stripQuery(raw)));
      if (!value) return;
      if (value.length > MAX_CANDIDATE_LEN) value = value.slice(0, MAX_CANDIDATE_LEN);
      var key = kind + "\0" + value.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      list.push({ kind: kind, value: value });
    });

    var normCounts = Object.create(null);
    list.forEach(function (c) {
      var n = normalizeToken(c.value);
      if (!n) return;
      normCounts[n] = (normCounts[n] || 0) + 1;
    });

    list.forEach(function (c) {
      var reason = rejectReason(c, providerSite, providerTokens);
      if (reason) {
        rejected.push({ kind: c.kind, value: c.value, reason: reason });
        return;
      }
      var score = BASE_WEIGHTS[c.kind] || 0;
      if (MEDIA_EXT_RE.test(c.value)) score += 40;
      score += Math.min(20, videoTokenBonus(c.value));
      if (normCounts[normalizeToken(c.value)] >= 2) score += 15;
      score -= brandPenalty(c, providerTokens);
      scored.push({
        kind: c.kind,
        value: c.value,
        score: score,
        tableOrder: TABLE_ORDER.indexOf(c.kind),
      });
    });

    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      var ao = a.tableOrder < 0 ? 999 : a.tableOrder;
      var bo = b.tableOrder < 0 ? 999 : b.tableOrder;
      if (ao !== bo) return ao - bo;
      var na = normalizeToken(a.value);
      var nb = normalizeToken(b.value);
      if (na < nb) return -1;
      if (na > nb) return 1;
      return 0;
    });

    var winnerObj = scored.length ? scored[0] : null;
    var winnerValue = winnerObj
      ? ensureExtension(winnerObj.value, knownExt)
      : fallbackName(input.mediaType, input.capturedAt, knownExt);

    return {
      proposedFilename: sanitizeFilename(winnerValue),
      winner: winnerObj,
      rejected: rejected,
      diagnostics: {
        scores: scored.map(function (s) {
          return { kind: s.kind, value: s.value, score: s.score };
        }),
      },
    };
  }

  return {
    rank: rank,
    sanitizeFilename: sanitizeFilename,
    stripWrapperExtension: stripWrapperExtension,
    ensureExtension: ensureExtension,
    normalizeToken: normalizeToken,
    BASE_WEIGHTS: BASE_WEIGHTS,
    GENERIC_BASENAMES: GENERIC_BASENAMES,
    MEDIA_EXT_RE: MEDIA_EXT_RE,
  };
});
