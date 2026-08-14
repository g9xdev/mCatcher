"use strict";
/*
 * popup-layout.js — rail geometry policy.
 *
 * A Firefox browser-action popup cannot exceed roughly 800 x 600 CSS pixels and
 * CLIPS anything wider rather than shrinking. So the popup asks for that maximum
 * before first paint, then reconciles against the viewport it actually got.
 * Below the two-pane threshold the panes stack — the Downloads rail stays
 * visible, it never disappears.
 *
 * Dual-export: CommonJS module.exports and classic-script global McPopupLayout.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.McPopupLayout = api;
})(
  typeof self !== "undefined" ? self :
  (typeof globalThis !== "undefined" ? globalThis : this),
  function () {
    "use strict";

    var MAX_WIDTH = 800;
    var MAX_HEIGHT = 600;
    // Right pane is 240px; the left pane needs ~360px to stay usable, plus
    // window chrome and a scrollbar. Below this the two columns cannot both fit.
    var TWO_PANE_MIN = 640;

    // An unusable measurement falls back to the requested maximum. It must never
    // invent a number larger than that maximum.
    function clampMeasurement(value, max) {
      if (!Number.isFinite(value) || value <= 0) return max;
      return Math.min(Math.floor(value), max);
    }

    function requested(wantRail) {
      return wantRail
        ? { rail: true, width: MAX_WIDTH, height: MAX_HEIGHT }
        : { rail: false, width: null, height: null };
    }

    function reconcile(input) {
      var wantRail = !!(input && input.wantRail);
      if (!wantRail) return { rail: false, stacked: false, width: null, height: null };
      var width = clampMeasurement(input ? input.viewportWidth : undefined, MAX_WIDTH);
      var height = clampMeasurement(input ? input.viewportHeight : undefined, MAX_HEIGHT);
      return {
        rail: true,
        stacked: width < TWO_PANE_MIN,
        width: width,
        height: height,
      };
    }

    // True only when every measured edge and the root scroll width sit inside
    // the viewport. One sub-pixel of tolerance absorbs fractional layout.
    function geometryContained(viewportWidth, rects, scrollWidth) {
      if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return false;
      var limit = viewportWidth + 1;
      if (scrollWidth !== undefined && scrollWidth !== null) {
        if (!Number.isFinite(scrollWidth) || scrollWidth > limit) return false;
      }
      if (!Array.isArray(rects)) return false;
      for (var index = 0; index < rects.length; index += 1) {
        var rect = rects[index];
        if (!rect || !Number.isFinite(rect.right)) return false;
        if (rect.right > limit) return false;
      }
      return true;
    }

    return Object.freeze({
      MAX_WIDTH: MAX_WIDTH,
      MAX_HEIGHT: MAX_HEIGHT,
      TWO_PANE_MIN: TWO_PANE_MIN,
      requested: requested,
      reconcile: reconcile,
      geometryContained: geometryContained,
    });
  }
);
