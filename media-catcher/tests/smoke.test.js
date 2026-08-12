"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const { mediaCatcherRoot, loadLib } = require("./harness/load-lib.js");

// Locked dual-export global names (must match plan GLOBAL_EXPORT_MAP).
const GLOBAL_EXPORT_MAP = {
  "lib/filename-ranker.js": "McFilenameRanker",
  "lib/source-context.js": "McSourceContext",
  "lib/detection-finalizer.js": "McDetectionFinalizer",
  "lib/download-intent.js": "McDownloadIntent",
  "lib/provider-registry.js": "McProviderRegistry",
  "lib/failure-classify.js": "McFailureClassify",
  "lib/provider-gate.js": "McProviderGate",
  "lib/download-scheduler.js": "McDownloadScheduler",
  "lib/native-result-adapter.js": "McNativeResultAdapter",
  "lib/file-sink-protocol.js": "McFileSinkProtocol",
  "lib/firefox-guard.js": "McFirefoxGuard",
  "lib/privacy.js": "McPrivacy",
  "lib/popup-download-ui.js": "McPopupDownloadUi",
  "lib/download-message-router.js": "McDownloadMessageRouter",
};

function loadOntoFakeRoot(relFromMediaCatcher) {
  const abs = path.join(mediaCatcherRoot, relFromMediaCatcher);
  const code = fs.readFileSync(abs, "utf8");
  const root = {};
  const sandbox = { module: { exports: {} }, exports: {}, require, console, self: root };
  sandbox.module.exports = sandbox.exports;
  // Dual-export modules must assign BOTH module.exports and root.Mc* global.
  vm.runInNewContext(code, sandbox, { filename: abs });
  return { root, nodeExport: sandbox.module.exports };
}

test("media-catcher root contains manifest.json", () => {
  const mf = path.join(mediaCatcherRoot, "manifest.json");
  assert.equal(fs.existsSync(mf), true);
});

test("filename-ranker module is loadable (will fail until Task 2 creates it)", () => {
  const p = path.join(mediaCatcherRoot, "lib", "filename-ranker.js");
  assert.equal(fs.existsSync(p), true, "lib/filename-ranker.js must exist");
});

test("filename-ranker dual-export assigns locked McFilenameRanker global", () => {
  const { root, nodeExport } = loadOntoFakeRoot("lib/filename-ranker.js");
  assert.equal(typeof nodeExport.rank, "function");
  assert.equal(typeof root.McFilenameRanker.rank, "function");
  assert.equal(root.McFilenameRanker, nodeExport);
});

// Full-map coverage for every dual-export module is Task 22 (global-export-map.test.js).
// Do not module.exports from this test file — node:test owns the module.
