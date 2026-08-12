(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.McSourceContext = api;
})(
  typeof self !== "undefined" ? self :
  (typeof globalThis !== "undefined" ? globalThis : this),
  function () {
  "use strict";

  function deepFreeze(o) {
    if (!o || typeof o !== "object" || Object.isFrozen(o)) return o;
    Object.getOwnPropertyNames(o).forEach(function (k) {
      var v = o[k];
      if (v && typeof v === "object") deepFreeze(v);
    });
    return Object.freeze(o);
  }

  function hostnameFromUrl(url) {
    try { return new URL(url).hostname; } catch (e) { return ""; }
  }

  function providerKeyFromSite(site) {
    var s = String(site || "").trim().toLowerCase();
    if (s.indexOf("www.") === 0) s = s.slice(4);
    return s;
  }

  function buildSourceContext(parts) {
    parts = parts || {};
    var topUrl = String(parts.topLevelPageUrl || "");
    // providerKey only from top-level page/site — never media/CDN origin.
    var site = providerKeyFromSite(parts.topLevelSite || hostnameFromUrl(topUrl));
    var cands = (parts.filenameCandidates || []).map(function (c) {
      return { kind: String(c.kind || ""), value: String(c.value || "") };
    });
    var ctx = {
      version: 1,
      capturedAt: String(parts.capturedAt || new Date().toISOString()),
      tabId: parts.tabId | 0,
      documentId: parts.documentId == null ? null : String(parts.documentId),
      frameId: parts.frameId | 0,
      topLevelPageUrl: topUrl,
      topLevelSite: site,
      immediateReferrerUrl: String(parts.immediateReferrerUrl || ""),
      frameOrigin: String(parts.frameOrigin || ""),
      mediaOrigin: String(parts.mediaOrigin || ""),
      filenameCandidates: cands,
    };
    return deepFreeze(ctx);
  }

  return {
    buildSourceContext: buildSourceContext,
    deepFreeze: deepFreeze,
    providerKeyFromSite: providerKeyFromSite,
    hostnameFromUrl: hostnameFromUrl,
  };
});
