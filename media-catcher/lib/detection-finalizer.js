(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.McDetectionFinalizer = api;
})(
  typeof self !== "undefined" ? self :
  (typeof globalThis !== "undefined" ? globalThis : this),
  function () {
  "use strict";

  var CONTEXT_WAIT_MS = 750;

  function stripQuery(s) {
    var str = String(s == null ? "" : s);
    var i = str.indexOf("?");
    return i >= 0 ? str.slice(0, i) : str;
  }

  function fileBaseName(value) {
    var s = stripQuery(String(value || "")).replace(/[/\\]+$/, "");
    var slash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return slash >= 0 ? s.slice(slash + 1) : s;
  }

  function urlPathname(url) {
    try {
      return new URL(String(url || "")).pathname;
    } catch (e) {
      var s = stripQuery(url);
      // Best-effort path without inventing hosts.
      var scheme = s.indexOf("://");
      if (scheme >= 0) {
        var rest = s.slice(scheme + 3);
        var slash = rest.indexOf("/");
        return slash >= 0 ? rest.slice(slash) : "/";
      }
      return s;
    }
  }

  function originFromUrl(url) {
    try {
      return new URL(String(url || "")).origin;
    } catch (e) {
      return "";
    }
  }

  function knownExtensionFromMediaUrl(mediaUrl) {
    var base = fileBaseName(mediaUrl);
    var m = base.match(/(\.[a-z0-9]{1,8})$/i);
    return m ? m[1] : "";
  }

  /**
   * Parse Content-Disposition header or bare filename into a candidate value.
   * Returns null when nothing usable is present.
   */
  function parseContentDisposition(cd) {
    if (cd == null) return null;
    var s = String(cd).trim();
    if (!s) return null;

    // RFC 5987 filename*=
    var star = s.match(/filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;\s]+)/i);
    if (star) {
      var rawStar = star[1].replace(/^"|"$/g, "");
      try {
        return decodeURIComponent(rawStar);
      } catch (e) {
        return rawStar;
      }
    }

    // filename="..." or filename=...
    var plain = s.match(/filename\s*=\s*("?)([^";]+)\1/i);
    if (plain) return plain[2].trim();

    // Bare filename (tests pass "a-only.mp4" directly).
    if (s.indexOf("=") === -1 && s.indexOf(";") === -1) return s;

    return null;
  }

  function headerValue(headers, name) {
    if (!headers || !headers.length) return null;
    var want = String(name).toLowerCase();
    for (var i = 0; i < headers.length; i++) {
      var h = headers[i];
      if (!h || h.name == null) continue;
      if (String(h.name).toLowerCase() === want) {
        return h.value != null ? String(h.value) : null;
      }
    }
    return null;
  }

  function urlKey(tabId, frameId, pageUrl) {
    return String(tabId | 0) + "\0" + String(frameId | 0) + "\0" + String(pageUrl || "");
  }

  function copySnapshot(snapshot) {
    if (!snapshot) return null;
    var cands = (snapshot.candidates || []).map(function (c) {
      return { kind: String(c.kind || ""), value: String(c.value == null ? "" : c.value) };
    });
    return {
      documentId: snapshot.documentId == null ? null : String(snapshot.documentId),
      tabId: snapshot.tabId | 0,
      frameId: snapshot.frameId | 0,
      pageUrl: String(snapshot.pageUrl || ""),
      topLevelPageUrl: String(snapshot.topLevelPageUrl || ""),
      documentNonce: String(snapshot.documentNonce || ""),
      candidates: cands,
      capturedAt: String(snapshot.capturedAt || ""),
    };
  }

  function copyEvent(event) {
    event = event || {};
    return {
      detectionId: event.detectionId,
      documentId: event.documentId == null || event.documentId === "" ? null : String(event.documentId),
      tabId: event.tabId | 0,
      frameId: event.frameId | 0,
      documentUrl: String(event.documentUrl || ""),
      topLevelUrlHint: String(event.topLevelUrlHint || ""),
      mediaUrl: String(event.mediaUrl || ""),
      mediaOrigin: String(event.mediaOrigin || ""),
      contentDisposition: event.contentDisposition == null ? null : String(event.contentDisposition),
      referrerUrl: String(event.referrerUrl || ""),
      frameOrigin: String(event.frameOrigin || ""),
      ts: event.ts | 0,
    };
  }

  function buildCandidates(event, snapshot) {
    var list = [];

    var cdName = parseContentDisposition(event.contentDisposition);
    if (cdName) {
      list.push({ kind: "content-disposition", value: cdName });
    }

    if (snapshot && snapshot.candidates && snapshot.candidates.length) {
      snapshot.candidates.forEach(function (c) {
        if (!c) return;
        var kind = String(c.kind || "");
        var value = String(c.value == null ? "" : c.value);
        if (!kind || !value) return;
        list.push({ kind: kind, value: value });
      });
    }

    // Page / referrer path evidence from network or correlated snapshot.
    var pageForPath = snapshot && snapshot.pageUrl
      ? snapshot.pageUrl
      : event.documentUrl;
    var pagePath = urlPathname(pageForPath);
    if (pagePath && pagePath !== "/") {
      list.push({ kind: "page-url", value: pagePath });
    }

    var refPath = urlPathname(event.referrerUrl);
    if (refPath && refPath !== "/") {
      list.push({ kind: "referrer-url", value: refPath });
    }

    // Media basename only — never retain signed query strings.
    var mediaBase = fileBaseName(event.mediaUrl);
    if (mediaBase) {
      list.push({ kind: "media-url", value: mediaBase });
    }

    return list;
  }

  function mapWebRequestDetails(details, hints) {
    details = details || {};
    hints = hints || {};
    var mediaUrl = String(details.url || "");
    var documentUrl = String(details.documentUrl || details.originUrl || "");
    var cdHeader = headerValue(details.responseHeaders, "Content-Disposition");
    var documentId =
      details.documentId == null || details.documentId === ""
        ? null
        : String(details.documentId);

    return {
      documentId: documentId,
      tabId: details.tabId | 0,
      frameId: details.frameId | 0,
      documentUrl: documentUrl,
      topLevelUrlHint: String(hints.topLevelUrlHint || ""),
      mediaUrl: mediaUrl,
      mediaOrigin: originFromUrl(mediaUrl),
      // Preserve response Content-Disposition (raw header or null).
      contentDisposition: cdHeader,
      referrerUrl: String(details.originUrl || ""),
      frameOrigin: String(hints.frameOrigin || ""),
      ts: details.timeStamp | 0,
    };
  }

  function createDetectionFinalizer(deps) {
    deps = deps || {};
    var nowFn = typeof deps.now === "function" ? deps.now : function () { return Date.now(); };
    var waitMs = deps.waitMs != null ? deps.waitMs | 0 : CONTEXT_WAIT_MS;
    var rankFn = deps.rank;
    var buildSourceContext = deps.buildSourceContext;
    // requestContext reserved for background wiring; unused in pure finalizer.

    var nextId = 0;
    /** @type {Map<number, {event: object, deadline: number}>} */
    var pending = new Map();
    /** @type {Map<number, object>} */
    var finalized = new Map();
    /** @type {Map<string, object>} documentId → snapshot */
    var snapshotsByDocId = new Map();
    /** @type {Map<string, object>} tabId+frameId+exact pageUrl → snapshot */
    var snapshotsByUrl = new Map();

    function allocateId(preferred) {
      if (preferred != null && preferred !== "") {
        var id = preferred | 0;
        if (id > nextId) nextId = id;
        return id;
      }
      nextId += 1;
      return nextId;
    }

    /**
     * Finalize exactly once: build candidates, sourceContext, rank once, freeze item.
     * mediaUrl stays on the item only — never inside sourceContext.
     */
    function finalizeOnce(detectionId, event, snapshot) {
      if (finalized.has(detectionId)) {
        return finalized.get(detectionId);
      }
      pending.delete(detectionId);

      var candidates = buildCandidates(event, snapshot);

      // documentId on sourceContext comes only from the webRequest/event path
      // (or DOM finalize which sets event.documentId from the snapshot).
      // Exact-URL reuse of a snapshot when event.documentId is null must NOT
      // import the snapshot's documentId.
      var topLevelPageUrl = snapshot && snapshot.topLevelPageUrl
        ? snapshot.topLevelPageUrl
        : event.topLevelUrlHint;
      var tabId = event.tabId;
      var frameId = event.frameId;
      var capturedAt = snapshot && snapshot.capturedAt
        ? snapshot.capturedAt
        : (event.ts ? new Date(event.ts).toISOString() : new Date(nowFn()).toISOString());

      var sourceContext = buildSourceContext({
        capturedAt: capturedAt,
        tabId: tabId,
        documentId: event.documentId,
        frameId: frameId,
        topLevelPageUrl: topLevelPageUrl,
        immediateReferrerUrl: event.referrerUrl,
        frameOrigin: event.frameOrigin,
        mediaOrigin: event.mediaOrigin,
        filenameCandidates: candidates,
        // mediaUrl intentionally omitted — never inside sourceContext.
      });

      var ranked = rankFn({
        candidates: candidates,
        providerSite: sourceContext.topLevelSite,
        knownExtension: knownExtensionFromMediaUrl(event.mediaUrl),
        mediaType: "video",
        capturedAt: capturedAt,
      });

      var item = Object.freeze({
        detectionId: detectionId,
        mediaUrl: event.mediaUrl,
        sourceContext: sourceContext,
        proposedFilename: ranked.proposedFilename,
        rankDiagnostics: ranked.diagnostics,
      });

      finalized.set(detectionId, item);
      return item;
    }

    function beginNetworkDetection(rawEvent) {
      var event = copyEvent(rawEvent);
      var detectionId = allocateId(event.detectionId);
      event.detectionId = detectionId;

      if (event.documentId != null) {
        var byDoc = snapshotsByDocId.get(event.documentId);
        if (byDoc) {
          return finalizeOnce(detectionId, event, byDoc).detectionId;
        }
        // Wait for matching documentId snapshot; pending never exposed.
        pending.set(detectionId, {
          event: event,
          deadline: nowFn() + waitMs,
        });
        return detectionId;
      }

      // Missing documentId: only an already-present snapshot with exact
      // captured page URL may contribute. Never wait for later tab/frame snaps.
      var exact = snapshotsByUrl.get(urlKey(event.tabId, event.frameId, event.documentUrl));
      finalizeOnce(detectionId, event, exact || null);
      return detectionId;
    }

    function provideDocumentSnapshot(rawSnapshot) {
      var snapshot = copySnapshot(rawSnapshot);
      if (!snapshot) return;

      if (snapshot.documentId != null && snapshot.documentId !== "") {
        snapshotsByDocId.set(snapshot.documentId, snapshot);
      }
      snapshotsByUrl.set(
        urlKey(snapshot.tabId, snapshot.frameId, snapshot.pageUrl),
        snapshot
      );

      // Apply only to still-open pending with matching documentId.
      // Ignore closed items and documentId mismatches. Never re-rank.
      if (snapshot.documentId == null || snapshot.documentId === "") return;

      var toFinalize = [];
      pending.forEach(function (p, id) {
        if (p.event.documentId != null && p.event.documentId === snapshot.documentId) {
          toFinalize.push(id);
        }
      });
      toFinalize.forEach(function (id) {
        var p = pending.get(id);
        if (!p) return;
        finalizeOnce(id, p.event, snapshot);
      });
    }

    function finalizeFromDom(input) {
      input = input || {};
      var snapshot = copySnapshot(input.snapshot);
      // DOM path uses the snapshot's documentId directly (no wait).
      var event = {
        documentId: snapshot && snapshot.documentId != null ? String(snapshot.documentId) : null,
        tabId: snapshot ? snapshot.tabId : 0,
        frameId: snapshot ? snapshot.frameId : 0,
        documentUrl: snapshot ? snapshot.pageUrl : "",
        topLevelUrlHint: snapshot ? snapshot.topLevelPageUrl : "",
        mediaUrl: String(input.mediaUrl || ""),
        mediaOrigin: String(input.mediaOrigin || ""),
        contentDisposition: input.contentDisposition == null ? null : String(input.contentDisposition),
        referrerUrl: String(input.referrerUrl || ""),
        frameOrigin: String(input.frameOrigin || ""),
        ts: input.ts | 0,
      };

      var detectionId = allocateId(null);
      event.detectionId = detectionId;

      if (snapshot) {
        if (snapshot.documentId != null && snapshot.documentId !== "") {
          snapshotsByDocId.set(snapshot.documentId, snapshot);
        }
        snapshotsByUrl.set(
          urlKey(snapshot.tabId, snapshot.frameId, snapshot.pageUrl),
          snapshot
        );
      }

      return finalizeOnce(detectionId, event, snapshot);
    }

    function tick(now) {
      var t = now != null ? now : nowFn();
      var expired = [];
      pending.forEach(function (p, id) {
        if (t >= p.deadline) expired.push(id);
      });
      expired.forEach(function (id) {
        var p = pending.get(id);
        if (!p) return;
        // Network evidence only — do not merge a later mismatched snapshot.
        finalizeOnce(id, p.event, null);
      });
    }

    function getItem(detectionId) {
      // Pending detections are never visible.
      var item = finalized.get(detectionId | 0);
      return item || null;
    }

    function listFinalized() {
      var out = [];
      finalized.forEach(function (item) {
        out.push(item);
      });
      return out;
    }

    return {
      beginNetworkDetection: beginNetworkDetection,
      provideDocumentSnapshot: provideDocumentSnapshot,
      finalizeFromDom: finalizeFromDom,
      tick: tick,
      getItem: getItem,
      listFinalized: listFinalized,
    };
  }

  return {
    CONTEXT_WAIT_MS: CONTEXT_WAIT_MS,
    createDetectionFinalizer: createDetectionFinalizer,
    mapWebRequestDetails: mapWebRequestDetails,
  };
});
