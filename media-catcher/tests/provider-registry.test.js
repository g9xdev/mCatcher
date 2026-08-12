"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const { loadLib, mediaCatcherRoot } = require("./harness/load-lib.js");
const { createProviderRegistry } = loadLib("lib/provider-registry.js");

test("zero providers → none; do not infer CDN hostname", () => {
  const r = createProviderRegistry();
  assert.deepEqual(r.lookup("https://cdn.example"), { status: "none", providerKey: null });
});

test("one provider → origin-only probe may inherit key", () => {
  const r = createProviderRegistry();
  r.observe("https://cdn.example", "florenfile.com");
  assert.deepEqual(r.lookup("https://cdn.example"), { status: "one", providerKey: "florenfile.com" });
});

test("two providers on shared CDN → ambiguous; no merge", () => {
  // Mutation: collapsing both providers into one group.
  const r = createProviderRegistry();
  r.observe("https://shared-cdn.invalid", "florenfile.com");
  r.observe("https://shared-cdn.invalid", "otherhost.com");
  assert.deepEqual(r.lookup("https://shared-cdn.invalid"), { status: "ambiguous", providerKey: null });
});

test("clear wipes session registry", () => {
  const r = createProviderRegistry();
  r.observe("https://cdn", "a.com");
  r.clear();
  assert.equal(r.lookup("https://cdn").status, "none");
});

test("normalize media origin via URL.origin (lowercase host, port, discard path/query)", () => {
  const r = createProviderRegistry();
  r.observe("https://CDN.Example:8443/video/chunk.m3u8?sig=abc", "florenfile.com");
  assert.deepEqual(
    r.lookup("https://cdn.example:8443/other/path?token=x"),
    { status: "one", providerKey: "florenfile.com" }
  );
  // Default HTTPS port is discarded by URL.origin.
  r.observe("https://media.cdn.invalid:443/x", "site-a.com");
  assert.deepEqual(
    r.lookup("https://media.cdn.invalid/y"),
    { status: "one", providerKey: "site-a.com" }
  );
});

test("reject invalid or empty origin and providerKey rather than associating", () => {
  const r = createProviderRegistry();
  r.observe("", "florenfile.com");
  r.observe("not-a-url", "florenfile.com");
  r.observe("https://cdn.example", "");
  r.observe("https://cdn.example", "   ");
  r.observe("https://cdn.example", null);
  r.observe(null, "florenfile.com");
  assert.deepEqual(r.lookup("https://cdn.example"), { status: "none", providerKey: null });
  assert.deepEqual(r.lookup(""), { status: "none", providerKey: null });
  assert.deepEqual(r.lookup("not-a-url"), { status: "none", providerKey: null });
});

test("normalize providerKey lowercase and strip leading www; duplicates are idempotent", () => {
  const r = createProviderRegistry();
  r.observe("https://cdn.example", "www.FlorenFile.com");
  r.observe("https://cdn.example", "florenfile.com");
  r.observe("https://cdn.example/path", "WWW.florenfile.com");
  assert.deepEqual(r.lookup("https://cdn.example"), { status: "one", providerKey: "florenfile.com" });
  const snap = r.snapshot();
  assert.equal(snap.length, 1);
  assert.deepEqual(snap[0].providerKeys, ["florenfile.com"]);
});

test("snapshot returns immutable deterministically sorted safe value", () => {
  const r = createProviderRegistry();
  r.observe("https://z.cdn.invalid", "beta.com");
  r.observe("https://a.cdn.invalid", "zeta.com");
  r.observe("https://a.cdn.invalid", "alpha.com");
  r.observe("https://m.cdn.invalid", "mid.com");

  const snap = r.snapshot();
  assert.deepEqual(snap, [
    { origin: "https://a.cdn.invalid", providerKeys: ["alpha.com", "zeta.com"] },
    { origin: "https://m.cdn.invalid", providerKeys: ["mid.com"] },
    { origin: "https://z.cdn.invalid", providerKeys: ["beta.com"] },
  ]);
  assert.throws(() => { snap.push({ origin: "x", providerKeys: [] }); });
  assert.throws(() => { snap[0].origin = "mutated"; });
  assert.throws(() => { snap[0].providerKeys.push("evil.com"); });
  assert.throws(() => { snap[0].providerKeys[0] = "mutated"; });

  // Safe value: mutating after snapshot does not leak registry internals.
  r.observe("https://a.cdn.invalid", "new.com");
  assert.deepEqual(snap[0].providerKeys, ["alpha.com", "zeta.com"]);
  assert.equal(r.lookup("https://a.cdn.invalid").status, "ambiguous");
});

test("clear removes all session associations and never persists", () => {
  const r1 = createProviderRegistry();
  r1.observe("https://cdn.example", "a.com");
  r1.observe("https://other.example", "b.com");
  r1.clear();
  assert.equal(r1.lookup("https://cdn.example").status, "none");
  assert.equal(r1.lookup("https://other.example").status, "none");
  assert.deepEqual(r1.snapshot(), []);

  // Independent instances do not share state (session-only, not process-global).
  const r2 = createProviderRegistry();
  assert.equal(r2.lookup("https://cdn.example").status, "none");
});

test("provider-registry dual-export assigns locked McProviderRegistry global with identity", () => {
  // Mutation: else-branch only assigns one side, or creates two distinct objects.
  const abs = path.join(mediaCatcherRoot, "lib", "provider-registry.js");
  const code = fs.readFileSync(abs, "utf8");
  const root = {};
  const sandbox = { module: { exports: {} }, exports: {}, require, console, self: root };
  sandbox.module.exports = sandbox.exports;
  vm.runInNewContext(code, sandbox, { filename: abs });
  assert.equal(typeof sandbox.module.exports.createProviderRegistry, "function");
  assert.equal(typeof root.McProviderRegistry.createProviderRegistry, "function");
  assert.equal(root.McProviderRegistry, sandbox.module.exports);
});
