"use strict";
// Ordering rule for the Downloads pane: keep the caller's rank grouping
// (active, held, done, failed) and put the NEWEST row first inside each group.
//
// The popup has no timestamp it can order every row by. background.js builds
// its legacy download records without a createdAt, and lib/privacy.js copies
// createdAt onto a projected controller job only when that job already carries
// one — so a sort on createdAt would order some rows and leave the rest tied.
// This module therefore keeps its own arrival sequence: the position at which
// an id was first seen.
//
// The sequence is held in a side map keyed by id, not on the row objects,
// because popup.js drops and re-inserts the projected job objects on every
// controller snapshot; a stamp written onto an object would not survive the
// next snapshot. Ids absent from a call are pruned, so the map tracks the live
// rows rather than every row the popup has ever shown.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.McQueueOrder = api;
})(
  typeof self !== "undefined" ? self :
  (typeof globalThis !== "undefined" ? globalThis : this),
  function () {
  "use strict";

  // Ids arrive as numbers (legacy downloads) or strings (controller jobs). The
  // type is part of the key so 7 and "7" are two rows, not one.
  function keyOf(id) {
    if (typeof id === "number" && Number.isFinite(id)) return "n:" + id;
    if (typeof id === "string" && id) return "s:" + id;
    return null;
  }

  function callOr(fn, entry, fallback) {
    if (typeof fn !== "function") return fallback;
    try {
      return fn(entry);
    } catch (_error) {
      return fallback;
    }
  }

  function createQueueOrder() {
    const arrivals = new Map();   // key -> arrival sequence
    let next = 1;

    // Rows whose id is unusable share sequence 0, which is older than every
    // stamped row; the original index breaks that tie so their order is stable.
    function order(list, options) {
      if (!Array.isArray(list)) return [];
      const idOf = options && options.idOf;
      const rankOf = options && options.rankOf;
      const live = new Set();
      const decorated = [];
      for (let index = 0; index < list.length; index += 1) {
        const entry = list[index];
        const key = keyOf(callOr(idOf, entry, null));
        let sequence = 0;
        if (key !== null) {
          live.add(key);
          if (!arrivals.has(key)) arrivals.set(key, next++);
          sequence = arrivals.get(key);
        }
        const rawRank = callOr(rankOf, entry, Number.MAX_SAFE_INTEGER);
        const rank = Number.isFinite(rawRank) ? rawRank : Number.MAX_SAFE_INTEGER;
        decorated.push({ entry, index, rank, sequence });
      }
      for (const key of Array.from(arrivals.keys())) {
        if (!live.has(key)) arrivals.delete(key);
      }
      decorated.sort(function (a, b) {
        if (a.rank !== b.rank) return a.rank - b.rank;
        if (a.sequence !== b.sequence) return b.sequence - a.sequence;
        return a.index - b.index;
      });
      return decorated.map(function (d) { return d.entry; });
    }

    function size() { return arrivals.size; }

    return Object.freeze({ order, size });
  }

  return Object.freeze({ createQueueOrder });
  }
);
