(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.McProviderRegistry = api;
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

  /**
   * Normalize a media origin through URL.origin:
   * - lowercase hostname (URL.origin does this)
   * - preserve scheme and non-default port
   * - discard path and query
   * Returns "" for invalid/empty input.
   */
  function normalizeOrigin(origin) {
    if (origin == null) return "";
    var s = String(origin).trim();
    if (!s) return "";
    try {
      return new URL(s).origin;
    } catch (e) {
      return "";
    }
  }

  /** Lowercase and strip leading www. Empty after trim → "". */
  function normalizeProviderKey(key) {
    if (key == null) return "";
    var s = String(key).trim().toLowerCase();
    if (s.indexOf("www.") === 0) s = s.slice(4);
    return s;
  }

  function createProviderRegistry() {
    // Session-only Map: normalizedOrigin → Set(normalizedProviderKey)
    // Never persisted.
    var byOrigin = new Map();

    function observe(mediaOrigin, providerKey) {
      var origin = normalizeOrigin(mediaOrigin);
      var key = normalizeProviderKey(providerKey);
      if (!origin || !key) return;
      var set = byOrigin.get(origin);
      if (!set) {
        set = new Set();
        byOrigin.set(origin, set);
      }
      set.add(key); // Set makes duplicates idempotent
    }

    function lookup(mediaOrigin) {
      var origin = normalizeOrigin(mediaOrigin);
      if (!origin) {
        return { status: "none", providerKey: null };
      }
      var set = byOrigin.get(origin);
      if (!set || set.size === 0) {
        return { status: "none", providerKey: null };
      }
      if (set.size === 1) {
        var only = null;
        set.forEach(function (k) { only = k; });
        return { status: "one", providerKey: only };
      }
      return { status: "ambiguous", providerKey: null };
    }

    function clear() {
      byOrigin.clear();
    }

    /**
     * Immutable, deterministically sorted safe projection.
     * Sorted by origin ascending; each providerKeys sorted ascending.
     * Deep-frozen; no live references into internal Map/Set.
     */
    function snapshot() {
      var origins = Array.from(byOrigin.keys()).sort();
      var rows = origins.map(function (origin) {
        var keys = Array.from(byOrigin.get(origin)).sort();
        return {
          origin: origin,
          providerKeys: keys.slice(),
        };
      });
      return deepFreeze(rows);
    }

    return {
      observe: observe,
      lookup: lookup,
      clear: clear,
      snapshot: snapshot,
    };
  }

  return {
    createProviderRegistry: createProviderRegistry,
    normalizeOrigin: normalizeOrigin,
    normalizeProviderKey: normalizeProviderKey,
  };
});
