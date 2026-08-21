"use strict";
/*
 * How much room the right pane gets.
 *
 * tests/popup-window-geometry.test.js measures the real rendered layout, but it
 * SKIPS silently when Firefox Developer Edition is not installed, so its silence
 * is not evidence that the track is the width it should be. This reads the rule
 * out of the stylesheet directly, which needs no browser.
 *
 * The window width itself lives in background.js and is not this pane's to set.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { mediaCatcherRoot } = require("./harness/load-lib.js");

function popupCss() {
  return fs.readFileSync(path.join(mediaCatcherRoot, "popup", "popup.css"), "utf8");
}

test("the rail's grid track is 320px wide", () => {
  const css = popupCss();
  const rule = /html\.rail \.main\s*\{[^}]*\}/.exec(css);
  assert.ok(rule, "the rail grid rule exists");
  const columns = /grid-template-columns:\s*([^;]+);/.exec(rule[0]);
  assert.ok(columns, "and it sets the columns");
  assert.match(columns[1], /320px/,
    "the right pane carries a preview frame and a row of file actions now");
  assert.equal(/240px/.test(columns[1]), false, "the old track is gone");
});
