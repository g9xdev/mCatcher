"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const { loadLib, mediaCatcherRoot } = require("./harness/load-lib.js");
const SC = loadLib("lib/source-context.js");

test("providerKeyFromSite lowercases and strips www", () => {
  // Mutation: using media CDN host or leaving www.
  assert.equal(SC.providerKeyFromSite("www.FlorenFile.com"), "florenfile.com");
});

test("buildSourceContext freezes recursively and deep-clones candidates", () => {
  const rawCand = { kind: "visible-filename", value: "11238-makemebi.net.mp4" };
  const ctx = SC.buildSourceContext({
    capturedAt: "2026-08-12T12:34:56.789Z",
    tabId: 42,
    documentId: "doc-1",
    frameId: 0,
    topLevelPageUrl: "https://florenfile.com/qnzjnabo3jec/11238-makemebi.net.mp4.html",
    immediateReferrerUrl: "https://florenfile.com/qnzjnabo3jec/11238-makemebi.net.mp4.html",
    frameOrigin: "https://florenfile.com",
    mediaOrigin: "https://s40.example-cdn.invalid",
    filenameCandidates: [rawCand],
  });
  assert.equal(ctx.version, 1);
  assert.equal(ctx.topLevelSite, "florenfile.com");
  assert.equal(ctx.mediaOrigin, "https://s40.example-cdn.invalid");
  assert.throws(() => { ctx.topLevelSite = "evil.com"; });
  assert.throws(() => { ctx.filenameCandidates.push({ kind: "x", value: "y" }); });
  assert.throws(() => { ctx.filenameCandidates[0].value = "mutated"; });
  rawCand.value = "mutated-source";
  assert.equal(ctx.filenameCandidates[0].value, "11238-makemebi.net.mp4");
});

test("missing topLevelPageUrl yields empty topLevelSite rather than CDN host", () => {
  const ctx = SC.buildSourceContext({
    capturedAt: "2026-08-12T12:34:56.789Z",
    tabId: 1,
    documentId: null,
    frameId: 0,
    topLevelPageUrl: "",
    immediateReferrerUrl: "",
    frameOrigin: "",
    mediaOrigin: "https://cdn.example/a.mp4",
    filenameCandidates: [],
  });
  assert.equal(ctx.topLevelSite, "");
});

test("dual-export assigns same api to module.exports and root.McSourceContext", () => {
  // Mutation: else-branch only assigns one side, or creates two distinct objects.
  const abs = path.join(mediaCatcherRoot, "lib", "source-context.js");
  const code = fs.readFileSync(abs, "utf8");
  const root = {};
  const sandbox = { module: { exports: {} }, exports: {}, require, console, self: root };
  sandbox.module.exports = sandbox.exports;
  vm.runInNewContext(code, sandbox, { filename: abs });
  assert.equal(typeof sandbox.module.exports.buildSourceContext, "function");
  assert.equal(typeof root.McSourceContext.buildSourceContext, "function");
  assert.equal(root.McSourceContext, sandbox.module.exports);
});
