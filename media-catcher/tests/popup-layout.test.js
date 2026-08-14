"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");
const Layout = loadLib("lib/popup-layout.js");

test("rail requests Firefox maximum and reconciles to actual viewport", () => {
  assert.deepEqual(Layout.requested(true), { rail: true, width: 800, height: 600 });
  assert.deepEqual(Layout.reconcile({ wantRail: true, viewportWidth: 800, viewportHeight: 600 }), {
    rail: true, stacked: false, width: 800, height: 600,
  });
  assert.deepEqual(Layout.reconcile({ wantRail: true, viewportWidth: 560, viewportHeight: 600 }), {
    rail: true, stacked: true, width: 560, height: 600,
  });
});

test("no rail requests and reconciles to no imposed geometry", () => {
  assert.deepEqual(Layout.requested(false), { rail: false, width: null, height: null });
  assert.deepEqual(Layout.reconcile({ wantRail: false, viewportWidth: 800, viewportHeight: 600 }), {
    rail: false, stacked: false, width: null, height: null,
  });
  assert.deepEqual(Layout.reconcile(undefined), {
    rail: false, stacked: false, width: null, height: null,
  });
});

test("measurements above the maximum clamp down rather than grow the popup", () => {
  assert.deepEqual(Layout.reconcile({ wantRail: true, viewportWidth: 2048, viewportHeight: 1440 }), {
    rail: true, stacked: false, width: 800, height: 600,
  });
  assert.deepEqual(Layout.reconcile({ wantRail: true, viewportWidth: 801, viewportHeight: 601 }), {
    rail: true, stacked: false, width: 800, height: 600,
  });
});

test("invalid measurements fail closed to the requested maximum and never larger", () => {
  for (const bad of [0, -1, -800, NaN, Infinity, -Infinity, "800", null, undefined, {}, []]) {
    const result = Layout.reconcile({ wantRail: true, viewportWidth: bad, viewportHeight: bad });
    assert.equal(result.rail, true);
    assert.equal(result.width, 800, "width for " + String(bad));
    assert.equal(result.height, 600, "height for " + String(bad));
    assert.equal(result.stacked, false);
    assert.ok(result.width <= Layout.MAX_WIDTH);
    assert.ok(result.height <= Layout.MAX_HEIGHT);
  }
  const absent = Layout.reconcile({ wantRail: true });
  assert.deepEqual(absent, { rail: true, stacked: false, width: 800, height: 600 });
});

test("fractional viewports floor rather than round up past the viewport", () => {
  const result = Layout.reconcile({ wantRail: true, viewportWidth: 799.6, viewportHeight: 599.6 });
  assert.equal(result.width, 799);
  assert.equal(result.height, 599);
});

test("the two-pane threshold decides stacking and the rail never hides", () => {
  const above = Layout.reconcile({ wantRail: true, viewportWidth: Layout.TWO_PANE_MIN, viewportHeight: 600 });
  assert.equal(above.stacked, false);
  const below = Layout.reconcile({ wantRail: true, viewportWidth: Layout.TWO_PANE_MIN - 1, viewportHeight: 600 });
  assert.equal(below.stacked, true);
  // Stacking is a presentation change only — rail stays on in both modes.
  assert.equal(above.rail, true);
  assert.equal(below.rail, true);
});

test("geometryContained accepts edges inside the viewport and rejects overflow", () => {
  assert.equal(Layout.geometryContained(800, [{ right: 800 }, { right: 560 }], 800), true);
  assert.equal(Layout.geometryContained(800, [{ right: 800.4 }], 800), true, "sub-pixel tolerance");
  assert.equal(Layout.geometryContained(800, [{ right: 812 }], 800), false);
  assert.equal(Layout.geometryContained(800, [{ right: 700 }], 1024), false, "scroll overflow");
  assert.equal(Layout.geometryContained(560, [{ right: 800 }], 560), false);
});

test("geometryContained fails closed on unusable inputs", () => {
  assert.equal(Layout.geometryContained(0, [{ right: 10 }], 10), false);
  assert.equal(Layout.geometryContained(NaN, [{ right: 10 }], 10), false);
  assert.equal(Layout.geometryContained(800, null, 800), false);
  assert.equal(Layout.geometryContained(800, [null], 800), false);
  assert.equal(Layout.geometryContained(800, [{ right: "700" }], 800), false);
  assert.equal(Layout.geometryContained(800, [{}], 800), false);
  assert.equal(Layout.geometryContained(800, [{ right: 700 }], NaN), false);
  // An absent scroll width is simply not measured.
  assert.equal(Layout.geometryContained(800, [{ right: 700 }]), true);
});

test("dual-export exposes a frozen McPopupLayout on the module and the global", () => {
  const root = typeof self !== "undefined" ? self : globalThis;
  assert.equal(root.McPopupLayout, Layout);
  assert.ok(Object.isFrozen(Layout));
  assert.equal(Layout.MAX_WIDTH, 800);
  assert.equal(Layout.MAX_HEIGHT, 600);
});
