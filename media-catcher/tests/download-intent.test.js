"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const { loadLib, mediaCatcherRoot } = require("./harness/load-lib.js");
const Intent = loadLib("lib/download-intent.js");

test("Download copies frozen proposal with saveMode default", () => {
  const i = Intent.createDefaultIntent({
    proposedFilename: "11238-makemebi.net.mp4",
    destinationDirectory: null,
    userActionToken: "tok-1",
    now: () => "2026-08-12T12:00:00.000Z",
  });
  assert.equal(i.requestedFilename, "11238-makemebi.net.mp4");
  assert.equal(i.saveMode, "default");
  assert.equal(i.userSelectedFirefox, false);
  assert.equal(i.userActionToken, "tok-1");
  assert.equal(i.destinationDirectory, null);
  assert.equal(i.createdAt, "2026-08-12T12:00:00.000Z");
  assert.throws(() => { i.requestedFilename = "x"; });
});

test("Save As uses sanitized edit; cancel path is simply not calling factory", () => {
  const i = Intent.createSaveAsIntent({
    proposedFilename: "11238-makemebi.net.mp4",
    editedFilename: "My Cut: final",
    destinationDirectory: "D:\\\\Vids",
    userActionToken: "tok-2",
    knownExtension: ".mp4",
    now: () => "2026-08-12T12:00:00.000Z",
  });
  assert.equal(i.saveMode, "save-as");
  assert.equal(i.requestedFilename, "My Cut_ final.mp4");
  assert.equal(i.destinationDirectory, "D:\\\\Vids");
  assert.equal(i.userSelectedFirefox, false);
  assert.equal(i.userActionToken, "tok-2");
  assert.equal(i.createdAt, "2026-08-12T12:00:00.000Z");
  assert.throws(() => { i.requestedFilename = "x"; });
});

test("Firefox intent requires existing userActionToken and sets flag", () => {
  const base = Intent.createDefaultIntent({
    proposedFilename: "a.mp4", userActionToken: "tok-3", now: () => "t",
  });
  const fx = Intent.createFirefoxIntent({ baseIntent: base });
  assert.equal(fx.userSelectedFirefox, true);
  assert.equal(fx.requestedFilename, "a.mp4");
  assert.equal(fx.userActionToken, "tok-3");
  assert.equal(fx.saveMode, "default");
  assert.equal(fx.createdAt, "t");
});

test("default and save-as reject empty proposedFilename and empty userActionToken", () => {
  assert.throws(() => Intent.createDefaultIntent({
    proposedFilename: "",
    destinationDirectory: null,
    userActionToken: "tok",
    now: () => "t",
  }));
  assert.throws(() => Intent.createDefaultIntent({
    proposedFilename: "a.mp4",
    destinationDirectory: null,
    userActionToken: "",
    now: () => "t",
  }));
  assert.throws(() => Intent.createSaveAsIntent({
    proposedFilename: "   ",
    editedFilename: "edit.mp4",
    destinationDirectory: null,
    userActionToken: "tok",
    knownExtension: ".mp4",
    now: () => "t",
  }));
  assert.throws(() => Intent.createSaveAsIntent({
    proposedFilename: "a.mp4",
    editedFilename: "edit.mp4",
    destinationDirectory: null,
    userActionToken: "  ",
    knownExtension: ".mp4",
    now: () => "t",
  }));
});

test("Save As rejects empty requestedFilename after sanitize", () => {
  // Mutation: accepting blank edits that collapse to empty after sanitize/ensureExtension.
  assert.throws(() => Intent.createSaveAsIntent({
    proposedFilename: "a.mp4",
    editedFilename: "",
    destinationDirectory: null,
    userActionToken: "tok",
    knownExtension: ".mp4",
    now: () => "t",
  }));
  // Trailing dots/spaces alone are stripped by sanitizeFilename → empty name.
  assert.throws(() => Intent.createSaveAsIntent({
    proposedFilename: "a.mp4",
    editedFilename: "...   ",
    destinationDirectory: null,
    userActionToken: "tok",
    knownExtension: "",
    now: () => "t",
  }));
});

test("Firefox intent does not manufacture a token and requires non-empty base token", () => {
  assert.throws(() => Intent.createFirefoxIntent({
    baseIntent: {
      requestedFilename: "a.mp4",
      destinationDirectory: null,
      saveMode: "default",
      userSelectedFirefox: false,
      userActionToken: "",
      createdAt: "t",
    },
  }));
  assert.throws(() => Intent.createFirefoxIntent({
    baseIntent: {
      requestedFilename: "a.mp4",
      destinationDirectory: null,
      saveMode: "default",
      userSelectedFirefox: false,
      userActionToken: null,
      createdAt: "t",
    },
  }));
  assert.throws(() => Intent.createFirefoxIntent({
    baseIntent: {
      requestedFilename: "",
      destinationDirectory: null,
      saveMode: "default",
      userSelectedFirefox: false,
      userActionToken: "tok",
      createdAt: "t",
    },
  }));
});

test("Firefox intent returns a fresh frozen object and does not mutate baseIntent", () => {
  const base = Intent.createDefaultIntent({
    proposedFilename: "a.mp4",
    destinationDirectory: "D:\\\\Vids",
    userActionToken: "tok-4",
    now: () => "t0",
  });
  const fx = Intent.createFirefoxIntent({ baseIntent: base });
  assert.notEqual(fx, base);
  assert.equal(base.userSelectedFirefox, false);
  assert.equal(fx.destinationDirectory, "D:\\\\Vids");
  assert.throws(() => { fx.userSelectedFirefox = false; });
  assert.throws(() => { base.userSelectedFirefox = true; });
});

test("download-intent dual-export assigns locked McDownloadIntent global with identity", () => {
  const abs = path.join(mediaCatcherRoot, "lib", "download-intent.js");
  const code = fs.readFileSync(abs, "utf8");
  const root = {};
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require,
    console,
    self: root,
  };
  sandbox.module.exports = sandbox.exports;
  vm.runInNewContext(code, sandbox, { filename: abs });
  const nodeExport = sandbox.module.exports;
  assert.equal(typeof nodeExport.createDefaultIntent, "function");
  assert.equal(typeof nodeExport.createSaveAsIntent, "function");
  assert.equal(typeof nodeExport.createFirefoxIntent, "function");
  assert.equal(typeof root.McDownloadIntent.createDefaultIntent, "function");
  assert.equal(root.McDownloadIntent, nodeExport);
});
