"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { mediaCatcherRoot } = require("./harness/load-lib.js");

const optionsPath = path.join(mediaCatcherRoot, "options", "options.html");
const html = fs.readFileSync(optionsPath, "utf8");
const compact = html.replace(/\s+/g, " ").trim();

test("Task21 parallel downloads copy explains queue and lowering behavior", () => {
  assert.ok(compact.includes(
    '<label class="row"> <span class="label">Parallel downloads</span> ' +
    '<input id="maxConcurrentDownloads" type="number" min="1" max="6" /> </label> ' +
    '<p class="hint">Maximum mCatcher downloads running at once. Extra jobs wait in the queue until a slot frees. Already-running jobs are not cancelled if you lower this.</p>'
  ));
});

test("Task21 automatic retries copy explains finite budget and manual Retry", () => {
  assert.ok(compact.includes(
    '<label class="row"> <span class="label">Automatic retries</span> ' +
    '<input id="retries" type="number" min="0" max="10" /> </label> ' +
    '<p class="hint">Finite automatic retries for transient network failures and provider wait wake-ups (0–10). Exhausted jobs need manual Retry.</p>'
  ));
  assert.equal(compact.includes('<span class="label">Segment retries</span>'), false);
});

test("Task21 preserves settings IDs, bounds, and segment-concurrency wording", () => {
  assert.equal((html.match(/id="maxConcurrentDownloads"/g) || []).length, 1);
  assert.equal((html.match(/id="retries"/g) || []).length, 1);
  assert.equal((html.match(/id="concurrency"/g) || []).length, 1);
  assert.ok(compact.includes(
    '<span class="label">Parallel segment fetches</span> ' +
    '<input id="concurrency" type="number" min="1" max="16" />'
  ));
});
