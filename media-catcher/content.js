/*
 * content.js — reports <video>/<source> srcs, the page/stream title, a
 * thumbnail frame, and a bounded document-scoped page-snapshot for filename
 * ranking. Only absolute http(s) srcs are reported: blob:/MediaSource srcs
 * can't be downloaded from the DOM (they're assembled in memory) and are
 * caught separately via the network listener, and every other scheme is a
 * page-chosen string with no business reaching the background as media.
 *
 * Thumbnails: drawn from the playing <video> onto a canvas, top frame only —
 * the background keeps one per tab and shows it on every row of that tab.
 * MSE-fed players (blob: src — most streaming sites) don't taint the canvas;
 * a cross-origin file src does, in which case toDataURL throws and we skip
 * quietly.
 *
 * Pure snapshot helpers are CommonJS-exportable for Node tests. In the browser
 * content-script path the factory self-installs; it does not publish a
 * persistent global API map entry.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else if (root) {
    api.install(root);
  }
})(
  typeof self !== "undefined" ? self :
  (typeof globalThis !== "undefined" ? globalThis : this),
  function () {
  "use strict";

  var MAX_TITLE = 120;
  var MAX_FILENAME = 180;
  var MAX_HEADINGS = 3;
  var MAX_NEARBY = 10;
  var MAX_CANDIDATES = 40;
  var MAX_MEDIA_META = 8;
  var MAX_MEDIA_CONTAINERS = 5;
  var THUMB_MAX = 150000;
  var FILENAME_SEL = '[download], [data-filename], .filename, .file-name, a[href$=".mp4"]';
  var CONTAINER_SEL = "article,main,section,div";

  function deepFreeze(o) {
    if (!o || typeof o !== "object" || Object.isFrozen(o)) return o;
    Object.getOwnPropertyNames(o).forEach(function (k) {
      var v = o[k];
      if (v && typeof v === "object") deepFreeze(v);
    });
    return Object.freeze(o);
  }

  function isNonNegInt(n) {
    return typeof n === "number" && isFinite(n) && n >= 0 && Math.floor(n) === n;
  }

  function isPrimitiveString(v) {
    return typeof v === "string";
  }

  // Nonces: primitive string, nonblank, no whitespace or controls.
  function isSafeNonce(v) {
    return typeof v === "string" && v.length > 0 && !/[\s\u0000-\u001f\u007f]/.test(v);
  }

  function invalidSnapshotContext() {
    return new TypeError("invalid snapshot context");
  }

  // Own data property only — never invoke accessors/proxies/get traps for value.
  function ownDataProp(obj, key) {
    var desc;
    try {
      if (obj === null || (typeof obj !== "object" && typeof obj !== "function")) {
        return { state: "missing" };
      }
      desc = Object.getOwnPropertyDescriptor(obj, key);
    } catch (e) {
      return { state: "bad" };
    }
    if (!desc) return { state: "missing" };
    if (desc.get !== undefined || desc.set !== undefined) return { state: "bad" };
    if (!Object.prototype.hasOwnProperty.call(desc, "value")) return { state: "bad" };
    return { state: "ok", value: desc.value };
  }

  function sanitizeString(value, maxLen, keepEnd) {
    if (typeof value !== "string") return "";
    var s = value.replace(/^\s+|\s+$/g, "");
    if (!s) return "";
    if (/[\u0000-\u001f\u007f]/.test(s)) return "";
    if (s.length > maxLen) {
      // Filename-like values keep the tail so extensions survive the cap.
      s = keepEnd ? s.slice(s.length - maxLen) : s.slice(0, maxLen);
    }
    if (!s) return "";
    return s;
  }

  // Safe primitive-string property read; omit on throw/non-string (no coercion).
  function readStringProp(el, name) {
    if (!el) return "";
    try {
      var v = el[name];
      return typeof v === "string" ? v : "";
    } catch (e) {
      return "";
    }
  }

  function qsa(root, sel) {
    if (!root || typeof root.querySelectorAll !== "function") return [];
    try {
      var list = root.querySelectorAll(sel);
      if (!list) return [];
      var out = [];
      var len;
      try {
        len = list.length;
      } catch (eLen) {
        return [];
      }
      if (typeof len !== "number" || !isFinite(len) || len < 0) return [];
      var n = Math.floor(len);
      for (var i = 0; i < n; i++) {
        try {
          out.push(list[i]);
        } catch (eItem) {
          // omit hostile index accessors
        }
      }
      return out;
    } catch (e) {
      return [];
    }
  }

  function qs(root, sel) {
    if (!root || typeof root.querySelector !== "function") return null;
    try {
      return root.querySelector(sel);
    } catch (e) {
      return null;
    }
  }

  // Only accept primitive strings. Never coerce objects via String/toString/valueOf.
  function readAttr(el, name) {
    if (!el) return null;
    try {
      if (typeof el.getAttribute === "function") {
        var a = el.getAttribute(name);
        if (typeof a === "string") return a;
        // Non-string attribute values fail closed (no object coercion).
        if (a != null) return null;
      }
    } catch (e) {}
    try {
      if (name === "download") {
        var dl = el.download;
        return typeof dl === "string" ? dl : null;
      }
      if (name === "href") {
        var href = el.href;
        return typeof href === "string" ? href : null;
      }
      if (name === "content") {
        var content = el.content;
        return typeof content === "string" ? content : null;
      }
      if (name === "title") {
        var title = el.title;
        return typeof title === "string" ? title : null;
      }
      if (name === "aria-label") {
        if (el.attributes && typeof el.attributes["aria-label"] === "string") {
          return el.attributes["aria-label"];
        }
        return null;
      }
      if (name === "data-filename") {
        if (el.dataset && typeof el.dataset.filename === "string") {
          return el.dataset.filename;
        }
        if (el.attributes && typeof el.attributes["data-filename"] === "string") {
          return el.attributes["data-filename"];
        }
        return null;
      }
    } catch (e2) {}
    return null;
  }

  function urlPathname(url) {
    if (typeof url !== "string" || !url) return "";
    try {
      var u = new URL(url);
      return u.pathname || "";
    } catch (e) {
      var s = url;
      var q = s.indexOf("?");
      if (q >= 0) s = s.slice(0, q);
      var h = s.indexOf("#");
      if (h >= 0) s = s.slice(0, h);
      var m = s.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+(\/.*)?$/);
      if (m) return m[1] || "/";
      if (s.charAt(0) === "/") return s;
      return "";
    }
  }

  function hrefBasename(href) {
    if (typeof href !== "string" || !href) return "";
    var path = urlPathname(href);
    if (!path || path === "/") {
      // last path segment fallback without query
      var clean = href;
      var qi = clean.indexOf("?");
      if (qi >= 0) clean = clean.slice(0, qi);
      var hi = clean.indexOf("#");
      if (hi >= 0) clean = clean.slice(0, hi);
      path = clean;
    }
    var slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    var base = slash >= 0 ? path.slice(slash + 1) : path;
    try {
      base = decodeURIComponent(base);
    } catch (e) {}
    return base;
  }

  function pushCand(list, seen, kind, value, maxLen) {
    if (list.length >= MAX_CANDIDATES) return;
    var keepEnd = kind === "visible-filename" || kind === "download-attr" ||
      kind === "page-url" || kind === "referrer-url";
    var v = sanitizeString(value, maxLen, keepEnd);
    if (!v) return;
    var key = kind + "\0" + v;
    if (seen[key]) return;
    seen[key] = true;
    list.push(Object.freeze({ kind: kind, value: v }));
  }

  function metaBySelector(documentLike, selector) {
    var el = qs(documentLike, selector);
    if (!el) return "";
    var c = readAttr(el, "content");
    if (c == null) c = readStringProp(el, "content");
    return typeof c === "string" ? c : "";
  }

  function valueFromFilenameEl(el) {
    if (!el) return null;
    try {
      var dl = readAttr(el, "download");
      if (typeof dl === "string" && dl.replace(/^\s+|\s+$/g, "")) {
        return { kind: "download-attr", value: dl };
      }
      // Presence of empty download attr: fall through to other signals.
      var dataFn = readAttr(el, "data-filename");
      if (typeof dataFn === "string" && dataFn.replace(/^\s+|\s+$/g, "")) {
        return { kind: "visible-filename", value: dataFn };
      }
      var text = readStringProp(el, "textContent");
      if (text && text.length <= MAX_FILENAME * 2) {
        var t = text.replace(/^\s+|\s+$/g, "");
        if (t && t.length <= MAX_FILENAME) {
          return { kind: "visible-filename", value: t };
        }
      }
      var href = readAttr(el, "href");
      if (href == null) {
        var hrefProp = readStringProp(el, "href");
        if (hrefProp) href = hrefProp;
      }
      var base = hrefBasename(typeof href === "string" ? href : "");
      if (base) return { kind: "visible-filename", value: base };
    } catch (e) {
      return null;
    }
    return null;
  }

  function collectNearbyFilenameEls(documentLike) {
    var out = [];
    var seenEl = [];
    function addEl(el) {
      if (!el) return;
      for (var i = 0; i < seenEl.length; i++) {
        if (seenEl[i] === el) return;
      }
      if (out.length >= MAX_NEARBY) return;
      seenEl.push(el);
      out.push(el);
    }

    var media = qsa(documentLike, "video, audio").slice(0, MAX_MEDIA_CONTAINERS);
    for (var m = 0; m < media.length; m++) {
      var node = media[m];
      var container = null;
      try {
        if (node && typeof node.closest === "function") {
          container = node.closest(CONTAINER_SEL);
        }
      } catch (e) {
        container = null;
      }
      if (!container) {
        try {
          container = node && node.parent ? node.parent : null;
        } catch (eParent) {
          container = null;
        }
      }
      if (!container) continue;
      var near = qsa(container, FILENAME_SEL);
      for (var j = 0; j < near.length && out.length < MAX_NEARBY; j++) addEl(near[j]);
    }

    var all = qsa(documentLike, FILENAME_SEL);
    for (var k = 0; k < all.length && out.length < MAX_NEARBY; k++) addEl(all[k]);
    return out;
  }

  function collectFilenameCandidates(documentLike, locationLike, referrer) {
    var list = [];
    var seen = Object.create(null);
    documentLike = documentLike || {};

    var title = readStringProp(documentLike, "title");
    pushCand(list, seen, "document-title", title, MAX_TITLE);

    pushCand(
      list,
      seen,
      "og-title",
      metaBySelector(documentLike, 'meta[property="og:title"]') ||
        metaBySelector(documentLike, 'meta[name="og:title"]'),
      MAX_TITLE
    );
    pushCand(
      list,
      seen,
      "twitter-title",
      metaBySelector(documentLike, 'meta[name="twitter:title"]'),
      MAX_TITLE
    );

    var headings = qsa(documentLike, "h1, h2");
    var hCount = 0;
    for (var hi = 0; hi < headings.length && hCount < MAX_HEADINGS; hi++) {
      var hv = readStringProp(headings[hi], "textContent");
      var before = list.length;
      pushCand(list, seen, "heading", hv, MAX_TITLE);
      if (list.length > before) hCount += 1;
    }

    var nearEls = collectNearbyFilenameEls(documentLike);
    for (var ni = 0; ni < nearEls.length; ni++) {
      var fv = valueFromFilenameEl(nearEls[ni]);
      if (!fv) continue;
      pushCand(list, seen, fv.kind, fv.value, MAX_FILENAME);
    }

    var mediaEls = qsa(documentLike, "video, audio, source").slice(0, MAX_MEDIA_META);
    for (var mi = 0; mi < mediaEls.length; mi++) {
      var mel = mediaEls[mi];
      var mt = readAttr(mel, "title");
      if (mt == null) {
        var titleProp = readStringProp(mel, "title");
        if (titleProp) mt = titleProp;
      }
      pushCand(list, seen, "media-metadata", mt, MAX_TITLE);
      pushCand(list, seen, "media-metadata", readAttr(mel, "aria-label"), MAX_TITLE);
    }

    var href = "";
    try {
      if (locationLike && typeof locationLike.href === "string") href = locationLike.href;
    } catch (e2) {
      href = "";
    }
    pushCand(list, seen, "page-url", urlPathname(href), MAX_FILENAME);

    var ref = "";
    if (typeof referrer === "string") ref = referrer;
    pushCand(list, seen, "referrer-url", urlPathname(ref), MAX_FILENAME);

    if (list.length > MAX_CANDIDATES) list = list.slice(0, MAX_CANDIDATES);
    return deepFreeze(list);
  }

  // -------------------------------------------------------------------------
  // The beam overlay — geometry and eligibility
  //
  // Both of these are pure functions over MEASUREMENTS, not over the DOM, so
  // the rules can be pinned without a browser and the DOM half below stays a
  // thin layer that only measures and paints.
  //
  // BEAM_MIN_W/H is the honest part of this file's ad story. It removes
  // zero-size elements, tracking pixels and hover-preview thumbnails, which is
  // real: those are everywhere and an icon on each would make the feature
  // worse than absent. It does NOT identify ads — a 640x360 pre-roll and a
  // 640x360 feature are the same measurements, and nothing here can tell them
  // apart. 240x135 is the smallest 16:9 rendition anyone actually streams.
  // -------------------------------------------------------------------------

  var BEAM_ICON = 28;              // px — the icon box, and the tap target
  var BEAM_MARGIN = 10;            // px — inset from the corner it sits in
  var BEAM_MIN_W = 240;
  var BEAM_MIN_H = 135;
  var BEAM_MIN_OPACITY = 0.1;

  function finiteNum(record, key) {
    try {
      var v = record[key];
      return typeof v === "number" && isFinite(v) ? v : NaN;
    } catch (e) {
      return NaN;
    }
  }

  function beamViewportSize(viewport, key) {
    var v = viewport ? finiteNum(viewport, key) : NaN;
    // An unreadable viewport must not be read as "everything is off screen":
    // treated as unbounded, the size and hidden rules still apply.
    return isNaN(v) || v <= 0 ? Infinity : v;
  }

  // True when this element is worth putting an icon on RIGHT NOW.
  //
  // `env` is {rect, style, viewport}: rect from getBoundingClientRect, style
  // the three computed properties that can hide a laid-out box, viewport the
  // window's inner size. A null style means "could not measure", which is read
  // as visible — refusing to draw because a measurement failed would silently
  // disable the feature rather than report anything.
  function isBeamableVideo(video, env) {
    if (!video || typeof video !== "object") return false;
    if (!env || typeof env !== "object") return false;

    try {
      if (video.paused !== false) return false;
      if (video.ended) return false;
      // HAVE_CURRENT_DATA: metadata alone is not playing yet.
      if (!(finiteNum(video, "readyState") >= 2)) return false;
      // No picture, no corner to put an icon in — this is how an audio-only
      // <video> and a not-yet-decoded element are excluded.
      if (!(finiteNum(video, "videoWidth") > 0)) return false;
      if (!(finiteNum(video, "videoHeight") > 0)) return false;
    } catch (e) {
      return false;
    }

    var rect = env.rect;
    if (!rect || typeof rect !== "object") return false;
    var left = finiteNum(rect, "left");
    var top = finiteNum(rect, "top");
    var width = finiteNum(rect, "width");
    var height = finiteNum(rect, "height");
    if (isNaN(left) || isNaN(top) || isNaN(width) || isNaN(height)) return false;
    if (width < BEAM_MIN_W || height < BEAM_MIN_H) return false;

    var vw = beamViewportSize(env.viewport, "width");
    var vh = beamViewportSize(env.viewport, "height");
    if (left + width <= 0 || top + height <= 0 || left >= vw || top >= vh) return false;

    var style = env.style;
    if (style && typeof style === "object") {
      try {
        if (style.display === "none") return false;
        if (style.visibility === "hidden" || style.visibility === "collapse") return false;
        var opacity = parseFloat(style.opacity);
        if (!isNaN(opacity) && opacity < BEAM_MIN_OPACITY) return false;
      } catch (e2) {
        return false;
      }
    }
    return true;
  }

  // Where the icon goes: the top-right corner of the part of the video that is
  // actually on screen, so a half-scrolled player still shows a reachable icon
  // instead of one parked above the viewport. Null when the visible sliver has
  // no room for it — an icon floating next to a video is worse than none.
  function beamIconRect(rect, viewport) {
    if (!rect || typeof rect !== "object") return null;
    var left = finiteNum(rect, "left");
    var top = finiteNum(rect, "top");
    var width = finiteNum(rect, "width");
    var height = finiteNum(rect, "height");
    if (isNaN(left) || isNaN(top) || !(width > 0) || !(height > 0)) return null;

    var vw = beamViewportSize(viewport, "width");
    var vh = beamViewportSize(viewport, "height");
    var visLeft = Math.max(left, 0);
    var visTop = Math.max(top, 0);
    var visRight = Math.min(left + width, vw);
    var visBottom = Math.min(top + height, vh);
    var need = BEAM_ICON + BEAM_MARGIN;
    if (visRight - visLeft < need || visBottom - visTop < need) return null;

    return {
      left: visRight - BEAM_ICON - BEAM_MARGIN,
      top: visTop + BEAM_MARGIN,
      size: BEAM_ICON,
    };
  }

  // Monotonic counter so pure time fallbacks differ across immediate calls.
  var nonceSeq = 0;

  function createDocumentNonce(cryptoLike, nowLike) {
    try {
      if (cryptoLike && typeof cryptoLike.randomUUID === "function") {
        var u = cryptoLike.randomUUID();
        if (isSafeNonce(u)) return u;
      }
    } catch (e) {}

    var timePart = 0;
    try {
      if (typeof nowLike === "function") timePart = nowLike();
      else if (typeof nowLike === "number") timePart = nowLike;
      else timePart = Date.now();
    } catch (e2) {
      timePart = 0;
    }
    if (typeof timePart !== "number" || !isFinite(timePart)) timePart = 0;

    try {
      if (cryptoLike && typeof cryptoLike.getRandomValues === "function") {
        var buf = new Uint8Array(16);
        cryptoLike.getRandomValues(buf);
        var hex = "";
        for (var i = 0; i < buf.length; i++) {
          var b = buf[i] & 0xff;
          hex += (b < 16 ? "0" : "") + b.toString(16);
        }
        nonceSeq = (nonceSeq + 1) >>> 0;
        return hex + "-" + String(timePart) + "-" + nonceSeq.toString(16);
      }
    } catch (e3) {}

    // Collision-resistant-enough fallback without PRNG APIs or page identity.
    nonceSeq = (nonceSeq + 1) >>> 0;
    var t = String(timePart);
    var acc = 0;
    for (var j = 0; j < t.length; j++) acc = (acc * 33 + t.charCodeAt(j)) >>> 0;
    acc = (acc ^ nonceSeq) >>> 0;
    return "n-" + t + "-" + acc.toString(16) + "-" + nonceSeq.toString(16);
  }

  function buildPageSnapshot(context, env) {
    env = env || {};

    if (context === null || (typeof context !== "object" && typeof context !== "function")) {
      throw invalidSnapshotContext();
    }

    var nonceP = ownDataProp(context, "documentNonce");
    if (nonceP.state !== "ok" || !isSafeNonce(nonceP.value)) {
      throw invalidSnapshotContext();
    }
    var tabP = ownDataProp(context, "tabId");
    if (tabP.state !== "ok" || !isNonNegInt(tabP.value)) {
      throw invalidSnapshotContext();
    }
    var frameP = ownDataProp(context, "frameId");
    if (frameP.state !== "ok" || !isNonNegInt(frameP.value)) {
      throw invalidSnapshotContext();
    }
    var pageP = ownDataProp(context, "pageUrl");
    if (pageP.state !== "ok" || !isPrimitiveString(pageP.value)) {
      throw invalidSnapshotContext();
    }
    var topP = ownDataProp(context, "topLevelPageUrl");
    if (topP.state !== "ok" || !isPrimitiveString(topP.value)) {
      throw invalidSnapshotContext();
    }

    var documentId = null;
    var docP = ownDataProp(context, "documentId");
    if (docP.state === "bad") {
      throw invalidSnapshotContext();
    }
    if (docP.state === "ok" && docP.value != null) {
      if (!isPrimitiveString(docP.value)) {
        throw invalidSnapshotContext();
      }
      documentId = docP.value;
    }

    var nowMs;
    try {
      if (typeof env.now === "function") nowMs = env.now();
      else if (typeof env.now === "number") nowMs = env.now;
      else nowMs = Date.now();
    } catch (e) {
      nowMs = Date.now();
    }
    if (!isFinite(nowMs)) nowMs = Date.now();
    var capturedAt = new Date(nowMs).toISOString();

    var referrer = "";
    if (typeof env.referrer === "string") referrer = env.referrer;

    var candidates = collectFilenameCandidates(env.document, env.location, referrer);

    return deepFreeze({
      type: "page-snapshot",
      documentId: documentId,
      documentNonce: nonceP.value,
      tabId: tabP.value,
      frameId: frameP.value,
      pageUrl: pageP.value,
      topLevelPageUrl: topP.value,
      candidates: candidates,
      capturedAt: capturedAt,
    });
  }

  function copySnapshot(snapshot) {
    if (!snapshot) return null;
    var cands = [];
    var src = snapshot.candidates || [];
    for (var i = 0; i < src.length; i++) {
      var c = src[i];
      if (!c) continue;
      cands.push({
        kind: typeof c.kind === "string" ? c.kind : "",
        value: typeof c.value === "string" ? c.value : "",
      });
    }
    return {
      type: "page-snapshot",
      documentId:
        snapshot.documentId == null
          ? null
          : typeof snapshot.documentId === "string"
            ? snapshot.documentId
            : null,
      documentNonce:
        typeof snapshot.documentNonce === "string" ? snapshot.documentNonce : "",
      tabId: snapshot.tabId,
      frameId: snapshot.frameId,
      pageUrl: typeof snapshot.pageUrl === "string" ? snapshot.pageUrl : "",
      topLevelPageUrl:
        typeof snapshot.topLevelPageUrl === "string" ? snapshot.topLevelPageUrl : "",
      candidates: cands,
      capturedAt: typeof snapshot.capturedAt === "string" ? snapshot.capturedAt : "",
    };
  }

  function snapshotFingerprint(snapshot) {
    if (!snapshot) return "";
    var docId =
      snapshot.documentId == null
        ? ""
        : typeof snapshot.documentId === "string"
          ? snapshot.documentId
          : "";
    var parts = [
      typeof snapshot.documentNonce === "string" ? snapshot.documentNonce : "",
      docId,
      isNonNegInt(snapshot.tabId) ? String(snapshot.tabId) : "",
      isNonNegInt(snapshot.frameId) ? String(snapshot.frameId) : "",
      typeof snapshot.pageUrl === "string" ? snapshot.pageUrl : "",
      typeof snapshot.topLevelPageUrl === "string" ? snapshot.topLevelPageUrl : "",
    ];
    var c = snapshot.candidates || [];
    for (var i = 0; i < c.length; i++) {
      var kind = c[i] && typeof c[i].kind === "string" ? c[i].kind : "";
      var value = c[i] && typeof c[i].value === "string" ? c[i].value : "";
      parts.push(kind + ":" + value);
    }
    return parts.join("\0");
  }

  function install(root) {
    root = root || (typeof self !== "undefined" ? self : globalThis);
    var api = (root && (root.browser || root.chrome)) ||
      (typeof browser !== "undefined" ? browser : typeof chrome !== "undefined" ? chrome : null);
    if (!api || !api.runtime || typeof api.runtime.sendMessage !== "function") {
      return;
    }

    var documentRef = root.document || (typeof document !== "undefined" ? document : null);
    var locationRef = root.location || (typeof location !== "undefined" ? location : { href: "" });
    var windowRef = root.window || root;
    var cryptoRef = root.crypto || (typeof crypto !== "undefined" ? crypto : null);

    var documentNonce = createDocumentNonce(cryptoRef, function () {
      return Date.now();
    });

    var boundUrls = new Set();
    var unboundItems = Object.create(null);
    var reportInflight = Object.create(null);
    var lastTitleSent = "";
    var lastThumbSent = "";
    var lastYtId = "";
    var lastPageUrl = "";
    try {
      lastPageUrl = String(locationRef.href || "");
    } catch (e) {
      lastPageUrl = "";
    }

    var currentSnapshot = null;
    var lastSnapshotFp = "";
    var contextRetryAt = 0;

    function isTopFrame() {
      try {
        return windowRef === windowRef.top;
      } catch (e) {
        return false;
      }
    }

    function frameOrigin() {
      try {
        if (typeof locationRef.origin === "string") return locationRef.origin;
      } catch (e) {}
      try {
        return new URL(String(locationRef.href || "")).origin;
      } catch (e2) {
        return "";
      }
    }

    function referrerUrl() {
      try {
        if (documentRef && typeof documentRef.referrer === "string") return documentRef.referrer;
      } catch (e) {}
      return "";
    }

    function safeSend(msg) {
      try {
        var p = api.runtime.sendMessage(msg);
        if (p && typeof p.then === "function") {
          p.then(function () {}, function () {});
        }
      } catch (e) {}
    }

    function requestSenderContext() {
      var pageUrl = "";
      try {
        pageUrl = String(locationRef.href || "");
      } catch (e) {
        pageUrl = "";
      }
      var req;
      try {
        req = api.runtime.sendMessage({
          type: "page-snapshot-context",
          documentNonce: documentNonce,
          pageUrl: pageUrl,
        });
      } catch (e2) {
        return Promise.resolve(null);
      }
      return Promise.resolve(req)
        .then(function (resp) {
          if (!resp || resp.ok !== true) return null;
          if (!isNonNegInt(resp.tabId) || !isNonNegInt(resp.frameId)) return null;
          if (resp.documentId != null && !isPrimitiveString(resp.documentId)) return null;
          if (!isPrimitiveString(resp.topLevelPageUrl)) return null;
          var topUrl = isTopFrame() ? pageUrl : resp.topLevelPageUrl;
          if (!isPrimitiveString(topUrl)) return null;
          return {
            documentId: resp.documentId == null ? null : resp.documentId,
            documentNonce: documentNonce,
            tabId: resp.tabId,
            frameId: resp.frameId,
            pageUrl: pageUrl,
            topLevelPageUrl: topUrl,
          };
        })
        .then(function (v) { return v; }, function () { return null; });
    }

    function markBoundItem(url, item) {
      boundUrls.add(url);
      delete unboundItems[url];
      // lastYtId is set only once the current YouTube item is bound so a
      // prior unbound emit cannot suppress the required snapshot retry.
      if (item && item.kind === "youtube" && typeof item.videoId === "string") {
        lastYtId = item.videoId;
      }
    }

    function flushUnboundRetries(snap) {
      if (!snap) return;
      var urls = Object.keys(unboundItems);
      for (var i = 0; i < urls.length; i++) {
        var url = urls[i];
        if (boundUrls.has(url)) {
          delete unboundItems[url];
          continue;
        }
        var item = unboundItems[url];
        delete unboundItems[url];
        markBoundItem(url, item);
        var msg = attachMediaEvidence({ type: "content-media", item: item });
        msg.snapshot = copySnapshot(snap);
        safeSend(msg);
      }
    }

    function refreshSnapshot(forceSend) {
      return requestSenderContext().then(function (ctx) {
        if (!ctx) {
          currentSnapshot = null;
          return null;
        }
        var snap;
        try {
          snap = buildPageSnapshot(ctx, {
            document: documentRef,
            location: locationRef,
            referrer: referrerUrl(),
            now: function () { return Date.now(); },
          });
        } catch (e) {
          currentSnapshot = null;
          return null;
        }
        var fp = snapshotFingerprint(snap);
        currentSnapshot = snap;
        if (forceSend || fp !== lastSnapshotFp) {
          lastSnapshotFp = fp;
          safeSend(copySnapshot(snap));
        }
        flushUnboundRetries(snap);
        return snap;
      });
    }

    function ensureSnapshot() {
      if (currentSnapshot) return Promise.resolve(currentSnapshot);
      var now = Date.now();
      if (now < contextRetryAt) return Promise.resolve(null);
      return refreshSnapshot(true).then(function (snap) {
        if (!snap) contextRetryAt = Date.now() + 2000;
        return snap;
      });
    }

    function metaTitle() {
      if (!documentRef) return "";
      var og =
        metaBySelector(documentRef, 'meta[property="og:title"]') ||
        metaBySelector(documentRef, 'meta[name="og:title"]');
      if (og) return sanitizeString(og, MAX_TITLE) || og.replace(/^\s+|\s+$/g, "");
      var tw = metaBySelector(documentRef, 'meta[name="twitter:title"]');
      if (tw) return sanitizeString(tw, MAX_TITLE) || tw.replace(/^\s+|\s+$/g, "");
      return "";
    }

    function pageTitleHint() {
      var og = metaTitle();
      if (og) return og;
      try {
        return documentRef && documentRef.title ? String(documentRef.title) : "";
      } catch (e) {
        return "";
      }
    }

    function sendPageInfo() {
      if (!isTopFrame()) return;
      var title = "";
      try {
        title = documentRef && documentRef.title ? String(documentRef.title) : "";
      } catch (e) {
        title = "";
      }
      var og = metaTitle();
      var key = og + "\0" + title;
      if (key === lastTitleSent || (!title && !og)) return;
      lastTitleSent = key;
      safeSend({ type: "page-info", title: title, ogTitle: og });
    }

    function attachMediaEvidence(msg) {
      msg.referrerUrl = referrerUrl();
      msg.frameOrigin = frameOrigin();
      return msg;
    }

    // Shared bounded reporter: at most one unbound emit per URL, then one
    // snapshot-bound retry via unboundItems/flushUnboundRetries, then dedupe
    // through boundUrls + reportInflight (no extra maps).
    function reportContentItem(url, item) {
      if (!url || !item || boundUrls.has(url)) return Promise.resolve();
      if (reportInflight[url]) return reportInflight[url];

      var p = ensureSnapshot()
        .then(function (snap) {
          if (boundUrls.has(url)) return;
          if (snap) {
            markBoundItem(url, item);
            var boundMsg = attachMediaEvidence({ type: "content-media", item: item });
            boundMsg.snapshot = copySnapshot(snap);
            safeSend(boundMsg);
            return;
          }
          if (Object.prototype.hasOwnProperty.call(unboundItems, url)) return;
          unboundItems[url] = item;
          safeSend(attachMediaEvidence({ type: "content-media", item: item }));
        })
        .then(function () {}, function () {
          if (boundUrls.has(url)) return;
          if (Object.prototype.hasOwnProperty.call(unboundItems, url)) return;
          unboundItems[url] = item;
          safeSend(attachMediaEvidence({ type: "content-media", item: item }));
        });

      reportInflight[url] = p.then(
        function () { delete reportInflight[url]; },
        function () { delete reportInflight[url]; }
      );
      return reportInflight[url];
    }

    // Only absolute http(s) srcs are reportable media. An allowlist, not a
    // blocklist: blob:/mediasource:/data: are unfetchable here, and file: /
    // ftp: / javascript: srcs are page-chosen strings that must never travel
    // to the background as a media URL.
    function isReportableUrl(url) {
      return typeof url === "string" && /^https?:\/\//i.test(url);
    }

    function report(url) {
      if (!url || boundUrls.has(url)) return Promise.resolve();
      if (!isReportableUrl(url)) return Promise.resolve();
      var item = {
        url: url,
        kind: /\.m3u8(\?|#|$)/i.test(url) ? "hls" : "direct",
        source: "video-element",
        pageTitle: pageTitleHint(),
        ts: Date.now(),
      };
      return reportContentItem(url, item);
    }

    function youtubeItem() {
      var host = "";
      try {
        host = String(locationRef.hostname || "");
      } catch (e) {
        return null;
      }
      if (!/(^|\.)youtube\.com$/i.test(host) && host !== "youtu.be") return null;
      var id = "";
      try {
        if (locationRef.pathname === "/watch") {
          id = new URLSearchParams(locationRef.search || "").get("v") || "";
        } else {
          var m = String(locationRef.pathname || "").match(
            /^\/(?:shorts|embed|live|v)\/([\w-]{6,})/
          );
          if (m) id = m[1];
          else if (host === "youtu.be") id = String(locationRef.pathname || "").slice(1);
        }
      } catch (e2) {
        return null;
      }
      if (!/^[\w-]{6,20}$/.test(id)) return null;
      var v = qs(documentRef, "video");
      var name = (metaTitle() || pageTitleHint() || "YouTube video")
        .replace(/\s*-\s*YouTube\s*$/i, "")
        .replace(/^\s+|\s+$/g, "");
      return {
        url: "https://www.youtube.com/watch?v=" + id,
        kind: "youtube",
        videoId: id,
        source: "youtube-page",
        name: name,
        pageTitle: metaTitle() || pageTitleHint(),
        thumb: "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg",
        playing: !!(v && !v.paused && !v.ended && v.readyState > 2),
        ts: Date.now(),
      };
    }

    function reportYouTube() {
      if (!isTopFrame()) return Promise.resolve();
      var it = youtubeItem();
      if (!it) return Promise.resolve();
      // lastYtId is only set after bind; until then unboundItems/reportInflight
      // suppress duplicate unbound emits while still allowing the retry.
      if (it.videoId === lastYtId || boundUrls.has(it.url)) return Promise.resolve();
      return reportContentItem(it.url, it);
    }

    function scan() {
      var tasks = [];
      tasks.push(reportYouTube());
      var vids = qsa(documentRef, "video");
      for (var i = 0; i < vids.length; i++) {
        var v = vids[i];
        if (v.currentSrc) tasks.push(report(v.currentSrc));
        if (v.src) tasks.push(report(v.src));
        var sources = [];
        try {
          if (typeof v.querySelectorAll === "function") {
            sources = Array.prototype.slice.call(v.querySelectorAll("source"), 0);
          }
        } catch (e) {
          sources = [];
        }
        for (var s = 0; s < sources.length; s++) {
          if (sources[s] && sources[s].src) tasks.push(report(sources[s].src));
        }
      }
      return Promise.all(tasks).then(function () {}, function () {});
    }

    function captureThumb() {
      var vids = qsa(documentRef, "video")
        .filter(function (v) {
          return v.readyState >= 2 && v.videoWidth > 0 && !v.ended;
        })
        .sort(function (a, b) {
          return b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight;
        });
      var v = vids[0];
      if (!v) return null;
      if (!documentRef || typeof documentRef.createElement !== "function") return null;
      var scale = Math.min(1, 320 / v.videoWidth);
      var c;
      try {
        c = documentRef.createElement("canvas");
      } catch (e) {
        return null;
      }
      if (!c) return null;
      c.width = Math.max(1, Math.round(v.videoWidth * scale));
      c.height = Math.max(1, Math.round(v.videoHeight * scale));
      try {
        var ctx = c.getContext && c.getContext("2d");
        if (!ctx) return null;
        ctx.drawImage(v, 0, 0, c.width, c.height);
        return c.toDataURL("image/jpeg", 0.65);
      } catch (e2) {
        return null;
      }
    }

    function sendThumb() {
      // One thumbnail is stored per tab and attached to every row of that tab,
      // so only the top frame may set it — the same gate sendPageInfo uses.
      if (!isTopFrame()) return;
      var dataUrl = captureThumb();
      if (!dataUrl || dataUrl.length > THUMB_MAX || dataUrl === lastThumbSent) return;
      lastThumbSent = dataUrl;
      safeSend({ type: "content-thumb", dataUrl: dataUrl });
    }

    function handleSpaNavigation() {
      var href = "";
      try {
        href = String(locationRef.href || "");
      } catch (e) {
        href = "";
      }
      if (href === lastPageUrl) return Promise.resolve(false);
      lastPageUrl = href;
      boundUrls.clear();
      unboundItems = Object.create(null);
      reportInflight = Object.create(null);
      lastYtId = "";
      lastTitleSent = "";
      lastThumbSent = "";
      lastSnapshotFp = "";
      currentSnapshot = null;
      contextRetryAt = 0;
      return refreshSnapshot(true)
        .then(function () { return scan(); })
        .then(function () { return true; }, function () { return true; });
    }

    function tick() {
      return handleSpaNavigation()
        .then(function (navigated) {
          sendPageInfo();
          sendThumb();
          if (!navigated) {
            // Keep the 12s page/title/thumb/YouTube refresh, and also scan so a
            // quiet currentSrc change (no mutation/loadstart) is eventually seen.
            // boundUrls / reportInflight suppress duplicates.
            return refreshSnapshot(false).then(function () {
              return scan();
            });
          }
          return null;
        })
        .then(function () {}, function () {});
    }

    // Initial handshake then scan — snapshot precedes snapshot-bound media.
    refreshSnapshot(true)
      .then(function () {
        return scan();
      })
      .then(function () {
        sendPageInfo();
      })
      .then(function () {}, function () {
        return scan().then(function () { sendPageInfo(); }, function () { sendPageInfo(); });
      });

    function refreshThenScan() {
      return refreshSnapshot(false)
        .then(function () { return scan(); })
        .then(function () {}, function () {});
    }

    // =====================================================================
    // The beam overlay
    //
    // An icon in the top-right corner of a video that is PLAYING; clicking it
    // asks the background to beam that video to BadApple. This runs in every
    // frame content.js already runs in, so a player in a subframe is covered
    // by that frame's own copy — nothing here reaches across a frame boundary.
    //
    // WHAT THE PAGE CAN DO TO IT, and what stops that:
    //   - restyle it. The container's own properties are inline !important,
    //     and everything visible lives in a CLOSED shadow root, which page
    //     CSS cannot select into and which is not reachable from
    //     element.shadowRoot. No id, no class, no `part` for a page
    //     stylesheet to hook.
    //   - be broken by it. The container is position:fixed with an explicit
    //     size and `contain: layout style size`, so it contributes nothing to
    //     the page's layout wherever it is parked.
    //   - swallow the click, or see it. Pointer events are stopped on the
    //     container in the CAPTURE phase, so the page's bubble-phase handlers
    //     never run. (A page listener capturing on document still sees the
    //     event first; it sees a click on an anonymous div, not on the
    //     player.)
    //   - CLICK IT ITSELF. The container is a node in the page's DOM, so page
    //     script can find it and dispatch on it. beamClick drops any event
    //     the browser did not mark isTrusted, which is every event a script
    //     dispatched.
    //
    // WHAT IT COSTS A FRAME WITH NO VIDEO: no timers of its own, no observer
    // of its own, no per-frame loop. It rides content.js's existing
    // MutationObserver and document listeners. Mutations arrive in storms and
    // are throttled to one re-check per BEAM_DEEP_MS; a media event is NOT
    // throttled, because it is the moment the answer changed and a storm of
    // them is a page choosing to burn its own CPU. The sweep for shadow roots
    // runs at most once per BEAM_SHADOW_MS with a hard cap on elements
    // examined, whichever path asked for it.
    //
    // WHAT IT CANNOT SEE: a video inside a CLOSED shadow root. `.shadowRoot`
    // is null for one and nothing else in a content script's reach answers.
    // Element.openOrClosedShadowRoot, which does answer, is ChromeOnly: in
    // Firefox 154 every use of it in the browser's own code is a privileged
    // PROPERTY read, and a content script runs on an expanded principal that
    // is not the system principal. Firefox 154 also registers no `dom`
    // WebExtension namespace, so there is no extension-facing wrapper for it
    // either. A player in a closed root therefore gets no icon, and this
    // claims nothing more.
    // =====================================================================

    var beamOverlays = new Map();     // video element -> record
    var beamRootsCache = null;
    var beamShadowAt = 0;
    var beamDeepAt = 0;
    var beamFrameQueued = false;
    var beamLastRecord = null;

    var BEAM_DEEP_MS = 250;           // discovery + computed-style re-check
    var BEAM_SHADOW_MS = 2000;        // open-shadow-root sweep
    var BEAM_SHADOW_CAP = 2000;       // elements examined per sweep, total
    var BEAM_MESSAGE_MS = 7000;
    var BEAM_MESSAGE_MAX = 300;

    var BEAM_CSS = [
      ":host{all:initial}",
      "button{all:unset;box-sizing:border-box;display:block;position:relative;",
      "width:100%;height:100%;cursor:pointer;border-radius:7px;",
      "background:rgba(16,16,20,.66);border:1px solid rgba(255,255,255,.34);",
      "backdrop-filter:blur(2px)}",
      "button:hover{background:rgba(16,16,20,.9)}",
      // `all:unset` above takes the focus ring with it, and the button is
      // still reachable by keyboard.
      "button:focus-visible{outline:2px solid #7dd3fc;outline-offset:2px}",
      // The AirPlay mark: a screen with a triangle pointing up into it.
      "span[data-p=s]{position:absolute;left:21%;top:23%;width:58%;height:36%;",
      "border:2px solid #fff;border-radius:2px}",
      "span[data-p=t]{position:absolute;left:50%;top:60%;margin-left:-7px;",
      "width:0;height:0;border-left:7px solid transparent;",
      "border-right:7px solid transparent;border-bottom:9px solid #fff}",
      "div[data-p=m]{display:none;position:absolute;right:0;top:calc(100% + 6px);",
      "width:264px;max-width:60vw;padding:8px 10px;border-radius:8px;",
      "background:rgba(16,16,20,.95);color:#f1f1f4;text-align:left;",
      "font:400 12px/1.35 system-ui,-apple-system,'Segoe UI',sans-serif;",
      "box-shadow:0 4px 18px rgba(0,0,0,.5);pointer-events:none}",
      "div[data-p=m][data-on='1']{display:block}",
      "div[data-p=m][data-tone=bad]{border:1px solid rgba(255,122,122,.5)}",
    ].join("");

    function beamViewport() {
      var w = NaN, h = NaN;
      try { w = finiteNum(root, "innerWidth"); h = finiteNum(root, "innerHeight"); } catch (e) {}
      if (isNaN(w) || w <= 0) {
        try { w = finiteNum(documentRef.documentElement, "clientWidth"); } catch (e2) { w = NaN; }
      }
      if (isNaN(h) || h <= 0) {
        try { h = finiteNum(documentRef.documentElement, "clientHeight"); } catch (e3) { h = NaN; }
      }
      return { width: w, height: h };
    }

    function beamFullscreenElement() {
      try {
        return documentRef.fullscreenElement || documentRef.mozFullScreenElement ||
          documentRef.webkitFullscreenElement || null;
      } catch (e) {
        return null;
      }
    }

    // Where a container may live so that it is actually painted.
    //
    // Nothing outside the fullscreen element is visible while one is set — the
    // top layer is above every z-index — so an overlay for a video that is not
    // inside it has nowhere honest to go and is taken down instead of left
    // floating over someone else's fullscreen content. A <video> that is
    // ITSELF the fullscreen element is the same answer for a different reason:
    // no element can be rendered inside a <video>.
    function beamParentFor(video, fullscreenEl) {
      var fallback = null;
      try { fallback = documentRef.body || documentRef.documentElement || null; } catch (e) {}
      if (!fullscreenEl) return fallback;
      if (fullscreenEl === video) return null;
      try {
        if (typeof fullscreenEl.contains === "function" && fullscreenEl.contains(video)) {
          return fullscreenEl;
        }
      } catch (e2) {}
      return null;
    }

    // Every root a <video> could be queried from: the document, plus the OPEN
    // shadow roots reachable from it. `.shadowRoot` is the whole of what a
    // content script gets: it answers for an open root and null for a closed
    // one, and a closed one stays unreachable. That includes this overlay's
    // own containers, which is why the sweep never finds them. Capped and
    // cached: an uncapped walk of a large page on every mutation is exactly
    // the cost this lane is not allowed to have.
    function beamSearchRoots(now) {
      if (beamRootsCache && (now - beamShadowAt) < BEAM_SHADOW_MS) return beamRootsCache;
      beamShadowAt = now;
      var roots = [documentRef];
      var queue = [documentRef];
      var budget = BEAM_SHADOW_CAP;
      while (queue.length && budget > 0) {
        var current = queue.shift();
        var all = qsa(current, "*");
        for (var i = 0; i < all.length && budget > 0; i++) {
          budget -= 1;
          var shadow = null;
          try { shadow = all[i].shadowRoot; } catch (e) { shadow = null; }
          if (shadow) { roots.push(shadow); queue.push(shadow); }
        }
      }
      beamRootsCache = roots;
      return roots;
    }

    function beamVideos(now) {
      var roots = beamSearchRoots(now);
      var out = [];
      for (var i = 0; i < roots.length; i++) {
        var found = qsa(roots[i], "video");
        for (var j = 0; j < found.length; j++) out.push(found[j]);
      }
      return out;
    }

    // Node.isConnected, read defensively: an engine without it answers
    // undefined, which is read as "still there" and left to the deep pass.
    function beamDisconnected(video) {
      try {
        return video.isConnected === false;
      } catch (e) {
        return false;
      }
    }

    function beamRect(video) {
      try {
        if (typeof video.getBoundingClientRect !== "function") return null;
        var r = video.getBoundingClientRect();
        if (!r) return null;
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      } catch (e) {
        return null;
      }
    }

    function beamStyle(video) {
      try {
        var gcs = root.getComputedStyle ||
          (typeof getComputedStyle === "function" ? getComputedStyle : null);
        if (typeof gcs !== "function") return null;
        var cs = gcs.call(root, video);
        if (!cs) return null;
        return { display: cs.display, visibility: cs.visibility, opacity: cs.opacity };
      } catch (e) {
        return null;
      }
    }

    // Everything a click is made of, taken off the page's hands. Stopping only
    // `click` would still leave a player that acts on mousedown (many do) to
    // pause the video under the icon.
    var BEAM_SWALLOWED = ["mousedown", "mouseup", "pointerdown", "pointerup",
                          "touchstart", "touchend", "dblclick", "contextmenu"];

    function beamSwallow(e) {
      try { if (e && typeof e.stopPropagation === "function") e.stopPropagation(); } catch (e1) {}
      try {
        if (e && typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
      } catch (e2) {}
      try { if (e && typeof e.preventDefault === "function") e.preventDefault(); } catch (e3) {}
    }

    function beamMessage(rec, text, bad) {
      if (!rec || !rec.msg) return;
      try {
        // textContent, never innerHTML: the string can be a host refusal, and
        // a refusal is not markup.
        rec.msg.textContent = String(text == null ? "" : text).slice(0, BEAM_MESSAGE_MAX);
        rec.msg.setAttribute("data-on", "1");
        rec.msg.setAttribute("data-tone", bad ? "bad" : "ok");
      } catch (e) {
        return;
      }
      rec.messageSeq = (rec.messageSeq || 0) + 1;
      var seq = rec.messageSeq;
      var st = root.setTimeout || setTimeout;
      try {
        st(function () {
          if (rec.messageSeq !== seq || !rec.msg) return;
          try {
            rec.msg.removeAttribute("data-on");
            rec.msg.textContent = "";
          } catch (e2) {}
        }, BEAM_MESSAGE_MS);
      } catch (e3) {}
    }

    // A USER clicked, not a script.
    //
    // The container is a node in the page's DOM: page script can locate it —
    // the icon's rect is deterministic, so elementFromPoint finds it — and
    // call .click() on it. Everything downstream of this function runs with
    // nobody in it: the background resolves an address, the native port
    // carries it, and the helper spawns BadApple. This is the last frame in
    // which "a user did this" is still a question that can be answered, so it
    // is answered here. isTrusted is the browser's own flag and is false on
    // every event dispatched from script; anything that is not exactly true
    // — including an object carrying no flag at all — is not a user.
    //
    // The overlay says nothing about a refused click. There is no one to tell:
    // a page that dispatched the event is not a person, and a person who did
    // click gets past this line.
    function beamClick(rec, e) {
      beamSwallow(e);
      if (!e || e.isTrusted !== true) return;
      if (rec.busy) return;
      rec.busy = true;
      beamLastRecord = rec;

      // The element's own src, reported as-is. Whether a blob: can be beamed
      // is not this frame's decision — the background owns the precedence and
      // the fallback, because the tab's detected media never comes here.
      var src = "";
      try {
        var current = rec.video.currentSrc;
        if (typeof current === "string" && current) src = current;
        else {
          var plain = rec.video.src;
          if (typeof plain === "string") src = plain;
        }
      } catch (eSrc) {
        src = "";
      }

      var sent;
      try {
        sent = api.runtime.sendMessage({ type: "beam-video", src: src });
      } catch (eSend) {
        sent = null;
      }
      Promise.resolve(sent).then(function (resp) {
        rec.busy = false;
        if (resp && resp.ok === true) {
          // WHICH address went is not always this element's. When its own src
          // was unusable the background answers from a stream detected on the
          // TAB, and nothing in that list records which <video> consumed which
          // row — a page with a feature and an ad break contributes several,
          // and lib/beam-target.js says so rather than pretending otherwise.
          // The only person who can tell a wrong pick from a right one is the
          // one watching, so a fallback is named as one.
          beamMessage(rec, resp.source === "detected"
            ? "Sent to BadApple — a stream detected on this tab, not this " +
              "video's own source. If the wrong thing plays, that is why."
            : "Sent to BadApple.", false);
          return;
        }
        var why = resp && typeof resp.error === "string" && resp.error
          ? resp.error : "Media Catcher could not beam this video.";
        beamMessage(rec, why, true);
      }, function () {
        rec.busy = false;
        beamMessage(rec, "Media Catcher's background page did not answer.", true);
      });
    }

    // Build one overlay. Returns null when the browser will not give us a
    // closed shadow root — an unshadowed div in someone's page is a style leak
    // in both directions, so the feature declines rather than degrades.
    function beamAttach(video) {
      var container, shadow;
      try {
        container = documentRef.createElement("div");
        if (!container || typeof container.attachShadow !== "function") return null;
        shadow = container.attachShadow({ mode: "closed" });
        if (!shadow) return null;
      } catch (e) {
        return null;
      }
      try {
        var sheet = documentRef.createElement("style");
        sheet.textContent = BEAM_CSS;
        shadow.appendChild(sheet);

        var button = documentRef.createElement("button");
        button.setAttribute("type", "button");
        button.setAttribute("aria-label", "Beam this video to BadApple");
        button.setAttribute("title", "Beam this video to BadApple");
        var screenPart = documentRef.createElement("span");
        screenPart.setAttribute("data-p", "s");
        var trianglePart = documentRef.createElement("span");
        trianglePart.setAttribute("data-p", "t");
        button.appendChild(screenPart);
        button.appendChild(trianglePart);
        shadow.appendChild(button);

        var msg = documentRef.createElement("div");
        msg.setAttribute("data-p", "m");
        shadow.appendChild(msg);

        var rec = {
          video: video, container: container, shadow: shadow,
          button: button, msg: msg, parent: null, busy: false, messageSeq: 0,
          left: NaN, top: NaN,
        };
        if (typeof container.addEventListener === "function") {
          container.addEventListener("click", function (e) { beamClick(rec, e); }, true);
          for (var i = 0; i < BEAM_SWALLOWED.length; i++) {
            container.addEventListener(BEAM_SWALLOWED[i], beamSwallow, true);
          }
        }
        beamOverlays.set(video, rec);
        return rec;
      } catch (e2) {
        try { if (typeof container.remove === "function") container.remove(); } catch (e3) {}
        return null;
      }
    }

    function beamDetach(video) {
      var rec = beamOverlays.get(video);
      if (!rec) return;
      beamOverlays["delete"](video);
      if (beamLastRecord === rec) beamLastRecord = null;
      try {
        if (rec.container && typeof rec.container.remove === "function") rec.container.remove();
      } catch (e) {}
    }

    function beamSetStyle(el, name, value) {
      try {
        if (el && el.style && typeof el.style.setProperty === "function") {
          el.style.setProperty(name, value, "important");
        }
      } catch (e) {}
    }

    // Every property here is one a page rule could otherwise take back, which
    // is why they are all set inline and all !important rather than left to a
    // stylesheet that page CSS outranks somewhere. `deep` re-asserts the whole
    // set rather than only the position: inline !important beats a stylesheet,
    // but it does not survive a script that clears the style attribute, and
    // re-writing twenty properties a few times a second costs nothing.
    function beamPaint(rec, at, parent, deep) {
      var container = rec.container;
      if (parent && container.parentNode !== parent) {
        try { parent.appendChild(container); rec.parent = parent; } catch (e) { return false; }
      }
      if (!deep && rec.left === at.left && rec.top === at.top && rec.painted) return true;
      rec.left = at.left;
      rec.top = at.top;
      rec.painted = true;
      beamSetStyle(container, "position", "fixed");
      beamSetStyle(container, "left", at.left + "px");
      beamSetStyle(container, "top", at.top + "px");
      beamSetStyle(container, "width", at.size + "px");
      beamSetStyle(container, "height", at.size + "px");
      beamSetStyle(container, "margin", "0");
      beamSetStyle(container, "padding", "0");
      beamSetStyle(container, "border", "0");
      beamSetStyle(container, "z-index", "2147483647");
      beamSetStyle(container, "isolation", "isolate");
      beamSetStyle(container, "contain", "layout style size");
      beamSetStyle(container, "display", "block");
      beamSetStyle(container, "float", "none");
      beamSetStyle(container, "clip-path", "none");
      beamSetStyle(container, "filter", "none");
      beamSetStyle(container, "transform", "none");
      beamSetStyle(container, "opacity", "1");
      beamSetStyle(container, "visibility", "visible");
      beamSetStyle(container, "pointer-events", "auto");
      beamSetStyle(container, "max-width", "none");
      beamSetStyle(container, "max-height", "none");
      return true;
    }

    function syncBeamOverlays() {
      if (!documentRef) return;
      var now = Date.now();
      var deep = (now - beamDeepAt) >= BEAM_DEEP_MS;
      if (!deep && beamOverlays.size === 0) return;
      var viewport = beamViewport();
      var fullscreenEl = beamFullscreenElement();

      if (deep) {
        beamDeepAt = now;
        var videos = beamVideos(now);
        var seen = new Set(videos);
        var stale = [];
        beamOverlays.forEach(function (rec, video) {
          if (!seen.has(video)) stale.push(video);
        });
        for (var s = 0; s < stale.length; s++) beamDetach(stale[s]);

        for (var i = 0; i < videos.length; i++) {
          var video = videos[i];
          var rect = beamRect(video);
          // The free half of the predicate first. getComputedStyle is the one
          // expensive read in this loop, and on a page full of ad slots most
          // videos are already excluded by play state or size without it.
          // The free half of the predicate first. getComputedStyle is the one
          // expensive read in this loop, and on a page full of ad slots most
          // videos are already excluded by play state or size without it.
          if (!isBeamableVideo(video, { rect: rect, style: null, viewport: viewport })) {
            beamDetach(video);
            continue;
          }
          var style = beamStyle(video);
          var at = isBeamableVideo(video, { rect: rect, style: style, viewport: viewport })
            ? beamIconRect(rect, viewport) : null;
          var parent = at ? beamParentFor(video, fullscreenEl) : null;
          if (!at || !parent) { beamDetach(video); continue; }
          var rec = beamOverlays.get(video) || beamAttach(video);
          if (!rec) continue;
          rec.style = style;
          if (!beamPaint(rec, at, parent, true)) beamDetach(video);
        }
      } else {
        var drop = [];
        beamOverlays.forEach(function (rec, video) {
          // A removed <video> still answers getBoundingClientRect, so the
          // cheap pass has to ask the one question that is both cheap and
          // decisive — otherwise an icon outlives its video for up to
          // BEAM_DEEP_MS, floating over whatever took its place.
          if (beamDisconnected(video)) { drop.push(video); return; }
          var rect = beamRect(video);
          var at = isBeamableVideo(video, { rect: rect, style: rec.style, viewport: viewport })
            ? beamIconRect(rect, viewport) : null;
          var parent = at ? beamParentFor(video, fullscreenEl) : null;
          if (!at || !parent || !beamPaint(rec, at, parent)) drop.push(video);
        });
        for (var d = 0; d < drop.length; d++) beamDetach(drop[d]);
      }

      if (beamOverlays.size) requestBeamFrame();
    }

    // A per-frame loop exists only while there is something to keep in place.
    // The moment the last overlay goes, so does the loop.
    function requestBeamFrame() {
      if (beamFrameQueued) return;
      beamFrameQueued = true;
      function run() {
        beamFrameQueued = false;
        syncBeamOverlays();
      }
      try {
        if (typeof root.requestAnimationFrame === "function") {
          root.requestAnimationFrame(run);
          return;
        }
      } catch (e) {}
      var st = root.setTimeout || setTimeout;
      try { st(run, BEAM_DEEP_MS); } catch (e2) { beamFrameQueued = false; }
    }

    // Media events and fullscreen changes are the moments the answer actually
    // changed, so they re-check immediately rather than waiting out the
    // throttle. Mutations do not: those arrive in storms.
    function beamSyncNow() {
      beamDeepAt = 0;
      syncBeamOverlays();
    }

    var MO = root.MutationObserver ||
      (typeof MutationObserver !== "undefined" ? MutationObserver : null);
    if (MO && documentRef && documentRef.documentElement) {
      try {
        var obs = new MO(function () {
          refreshThenScan();
          syncBeamOverlays();
        });
        obs.observe(documentRef.documentElement, { childList: true, subtree: true });
      } catch (eObs) {}
    }

    function onDoc(eventName, fn) {
      try {
        if (documentRef && typeof documentRef.addEventListener === "function") {
          documentRef.addEventListener(eventName, fn, true);
          return;
        }
      } catch (e) {}
      try {
        if (typeof root.addEventListener === "function") {
          root.addEventListener(eventName, fn, true);
        }
      } catch (e2) {}
    }

    onDoc("loadstart", function (e) {
      if (e && e.target && e.target.tagName === "VIDEO") {
        refreshThenScan();
      }
    });
    onDoc("playing", function (e) {
      if (e && e.target && e.target.tagName === "VIDEO") {
        var st = root.setTimeout || setTimeout;
        st(function () { sendThumb(); }, 800);
      }
    });

    // Media events do not bubble, so these are capture-phase on the document —
    // the same reason the two above are. They do not reach into a shadow root
    // (a media event is not composed); a player in one is picked up by the
    // sweep instead.
    var BEAM_EVENTS = ["play", "playing", "pause", "ended", "emptied", "loadeddata",
                       "seeked", "abort", "fullscreenchange", "mozfullscreenchange",
                       "webkitfullscreenchange"];
    for (var bi = 0; bi < BEAM_EVENTS.length; bi++) onDoc(BEAM_EVENTS[bi], beamSyncNow);

    // Scrolling and resizing move the corner without changing anything else.
    // Throttled by syncBeamOverlays itself, and a no-op in a frame with no
    // overlay up.
    try {
      if (typeof root.addEventListener === "function") {
        root.addEventListener("scroll", function () { syncBeamOverlays(); }, true);
        root.addEventListener("resize", function () { syncBeamOverlays(); }, true);
      }
    } catch (eScroll) {}

    var si = root.setInterval || setInterval;
    si(function () {
      syncBeamOverlays();
      return tick();
    }, 12000);

    // One pass now, so a video already playing when this frame loaded gets its
    // icon without waiting for the page to do something.
    beamSyncNow();

    try {
      if (api.runtime.onMessage && typeof api.runtime.onMessage.addListener === "function") {
        api.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
          if (msg && msg.type === "get-page-title") {
            try {
              sendResponse({ title: metaTitle() || pageTitleHint() });
            } catch (e) {
              try { sendResponse({ title: "" }); } catch (e2) {}
            }
            return;
          }
          // The helper refused a beam. `badapple` answers nothing on success,
          // so this only ever arrives for a failure, and it arrives late —
          // after the click has already been answered ok. Shown on the overlay
          // that asked, which is the only one that could have.
          if (msg && msg.type === "beam-result" && msg.ok === false) {
            beamMessage(beamLastRecord,
              typeof msg.error === "string" && msg.error
                ? msg.error : "BadApple could not play that.", true);
          }
        });
      }
    } catch (eMsg) {}
  }

  return Object.freeze({
    collectFilenameCandidates: collectFilenameCandidates,
    buildPageSnapshot: buildPageSnapshot,
    createDocumentNonce: createDocumentNonce,
    isBeamableVideo: isBeamableVideo,
    beamIconRect: beamIconRect,
    install: install,
  });
});
