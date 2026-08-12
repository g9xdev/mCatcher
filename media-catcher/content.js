/*
 * content.js — reports <video>/<source> srcs, the page/stream title, a
 * thumbnail frame, and a bounded document-scoped page-snapshot for filename
 * ranking. Blob/MediaSource srcs can't be downloaded from the DOM (they're
 * assembled in memory), but those streams are caught separately via the
 * network listener, so we simply skip them here.
 *
 * Thumbnails: drawn from the playing <video> onto a canvas. MSE-fed players
 * (blob: src — most streaming sites) don't taint the canvas; a cross-origin
 * file src does, in which case toDataURL throws and we skip quietly.
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
        boundUrls.add(url);
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

    function report(url) {
      if (!url || boundUrls.has(url)) return Promise.resolve();
      if (
        url.indexOf("blob:") === 0 ||
        url.indexOf("mediasource:") === 0 ||
        url.indexOf("data:") === 0
      ) {
        return Promise.resolve();
      }
      if (reportInflight[url]) return reportInflight[url];

      var item = {
        url: url,
        kind: /\.m3u8(\?|#|$)/i.test(url) ? "hls" : "direct",
        source: "video-element",
        pageTitle: pageTitleHint(),
        ts: Date.now(),
      };

      var p = ensureSnapshot()
        .then(function (snap) {
          if (boundUrls.has(url)) return;
          if (snap) {
            boundUrls.add(url);
            delete unboundItems[url];
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
      if (!it || it.videoId === lastYtId) return Promise.resolve();
      lastYtId = it.videoId;
      return ensureSnapshot()
        .then(function (snap) {
          var msg = attachMediaEvidence({ type: "content-media", item: it });
          if (snap) msg.snapshot = copySnapshot(snap);
          safeSend(msg);
        })
        .then(function () {}, function () {
          safeSend(attachMediaEvidence({ type: "content-media", item: it }));
        });
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
      if (typeof root.document === "undefined" && !documentRef.createElement) return null;
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
            return refreshSnapshot(false).then(function () {
              return reportYouTube();
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

    var MO = root.MutationObserver ||
      (typeof MutationObserver !== "undefined" ? MutationObserver : null);
    if (MO && documentRef && documentRef.documentElement) {
      try {
        var obs = new MO(function () {
          refreshThenScan();
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

    var si = root.setInterval || setInterval;
    si(function () {
      return tick();
    }, 12000);

    try {
      if (api.runtime.onMessage && typeof api.runtime.onMessage.addListener === "function") {
        api.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
          if (msg && msg.type === "get-page-title") {
            try {
              sendResponse({ title: metaTitle() || pageTitleHint() });
            } catch (e) {
              try { sendResponse({ title: "" }); } catch (e2) {}
            }
          }
        });
      }
    } catch (eMsg) {}
  }

  return Object.freeze({
    collectFilenameCandidates: collectFilenameCandidates,
    buildPageSnapshot: buildPageSnapshot,
    createDocumentNonce: createDocumentNonce,
    install: install,
  });
});
