"use strict";
//
// The beam overlay's one hard question: WHICH url does clicking the icon send?
//
// `video.currentSrc` is the obvious answer and is frequently unusable. HLS and
// DASH players feed the element through MediaSource, and an MSE-fed element's
// currentSrc is a `blob:` minted by and scoped to the page that created it —
// meaningless to a player on another machine, which is why the host refuses it
// and why the extension must never send it.
//
// So there are two sources and they need an order. These tests pin that order
// and, just as importantly, pin what is NEVER chosen: a YouTube watch page, a
// stream known to be DRM-encrypted, and anything that is not an http(s)
// address. Beaming any of those is beaming garbage, and the brief for this
// lane is that a failure has to say why instead.
//
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");

function load() {
  return loadLib("lib/beam-target.js");
}

function item(over) {
  return Object.assign({ kind: "direct", url: "https://cdn.example/a.mp4", ts: 1 }, over);
}

// ---------------------------------------------------------------------------
// Module surface
// ---------------------------------------------------------------------------

test("beam-target dual-exports a frozen api under McBeamTarget", () => {
  const api = load();
  assert.ok(Object.isFrozen(api));
  assert.deepEqual(Object.keys(api).sort(), ["beamableUrl", "resolveBeamTarget"]);
  assert.equal(typeof api.resolveBeamTarget, "function");
  const root = {};
  delete require.cache[require.resolve("../lib/beam-target.js")];
  const fresh = require("../lib/beam-target.js");
  assert.equal(typeof fresh.resolveBeamTarget, "function");
  assert.equal(typeof root.McBeamTarget, "undefined", "requiring does not touch a foreign root");
});

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

test("an http(s) element src wins over anything the tab detected", () => {
  const { resolveBeamTarget } = load();
  const out = resolveBeamTarget({
    elementSrc: "https://cdn.example/this-element.mp4",
    items: [item({ kind: "hls", url: "https://cdn.example/master.m3u8", ts: 99 })],
  });
  assert.equal(out.ok, true);
  assert.equal(out.url, "https://cdn.example/this-element.mp4");
  assert.equal(out.source, "element");
});

test("a blob: element src falls back to the tab's detected manifest", () => {
  const { resolveBeamTarget } = load();
  const out = resolveBeamTarget({
    elementSrc: "blob:https://site.example/2f1c-4a55-9b21",
    items: [item({ kind: "hls", url: "https://cdn.example/master.m3u8", ts: 5 })],
  });
  assert.equal(out.ok, true);
  assert.equal(out.url, "https://cdn.example/master.m3u8");
  assert.equal(out.source, "detected");
});

test("a manifest beats a direct file in the fallback, whichever is newer", () => {
  const { resolveBeamTarget } = load();
  const out = resolveBeamTarget({
    elementSrc: "blob:https://site.example/x",
    items: [
      item({ kind: "direct", url: "https://cdn.example/ad-break.mp4", ts: 900 }),
      item({ kind: "dash", url: "https://cdn.example/manifest.mpd", ts: 1 }),
    ],
  });
  assert.equal(out.url, "https://cdn.example/manifest.mpd",
    "a blob: means MSE, and MSE means a manifest is what feeds this element");
});

test("within a kind the most recently detected stream wins", () => {
  const { resolveBeamTarget } = load();
  const manifests = resolveBeamTarget({
    elementSrc: "",
    items: [
      item({ kind: "hls", url: "https://cdn.example/old.m3u8", ts: 10 }),
      item({ kind: "hls", url: "https://cdn.example/new.m3u8", ts: 20 }),
    ],
  });
  assert.equal(manifests.url, "https://cdn.example/new.m3u8");

  const directs = resolveBeamTarget({
    elementSrc: "",
    items: [
      item({ kind: "direct", url: "https://cdn.example/new.mp4", ts: 20 }),
      item({ kind: "direct", url: "https://cdn.example/old.mp4", ts: 10 }),
    ],
  });
  assert.equal(directs.url, "https://cdn.example/new.mp4");
});

// ---------------------------------------------------------------------------
// What is never chosen
// ---------------------------------------------------------------------------

test("a youtube row is never beamed — its url is a watch page, not media", () => {
  const { resolveBeamTarget } = load();
  const out = resolveBeamTarget({
    elementSrc: "blob:https://www.youtube.com/9c0",
    items: [item({ kind: "youtube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", ts: 50 })],
  });
  assert.equal(out.ok, false, "handing BadApple an HTML page is beaming garbage");
  assert.equal(out.url, undefined);
});

test("a stream known to be DRM-encrypted is never beamed", () => {
  const { resolveBeamTarget } = load();
  const out = resolveBeamTarget({
    elementSrc: "blob:https://site.example/x",
    items: [item({ kind: "hls", url: "https://cdn.example/wv.m3u8", ts: 50, drm: true })],
  });
  assert.equal(out.ok, false,
    "its segments cannot be decrypted outside the browser that holds the licence");
});

test("a detected row whose url is not http(s) is never chosen", () => {
  const { resolveBeamTarget } = load();
  for (const url of ["blob:https://site.example/x", "data:video/mp4;base64,AAAA",
                     "file:///C:/clip.mp4", "mediasource:1"]) {
    const out = resolveBeamTarget({ elementSrc: "", items: [item({ kind: "hls", url, ts: 5 })] });
    assert.equal(out.ok, false, url);
  }
});

// ---------------------------------------------------------------------------
// The element gate — the extension says no before the host has to
// ---------------------------------------------------------------------------

test("beamableUrl mirrors the host's refuse_url so a click is never answered by the port", () => {
  const { beamableUrl } = load();
  assert.equal(beamableUrl("https://cdn.example/a.mp4"), "https://cdn.example/a.mp4");
  assert.equal(beamableUrl("http://cdn.example/a.mp4"), "http://cdn.example/a.mp4");
  for (const bad of [
    "blob:https://site.example/x",
    "file:///C:/Windows/System32/calc.exe",
    "ftp://host/x.mp4",
    "javascript:alert(1)",
    "data:video/mp4;base64,AAAA",
    "\\\\attacker\\share\\clip.mp4",
    "https://",
    " https://cdn.example/a.mp4",
    "--exec=calc.exe",
    "",
    null,
    undefined,
    42,
    {},
  ]) {
    assert.equal(beamableUrl(bad), "", JSON.stringify(String(bad)));
  }
});

test("a tab or newline inside an address is refused, not silently deleted", () => {
  const { beamableUrl } = load();
  // new URL() strips these before it reports a scheme and a host, so the string
  // that PARSED clean is not the string that would ship. Refusing is what keeps
  // the two readings from ever differing — the same reason guard.refuse_url
  // refuses rather than trims.
  assert.equal(new URL("http://h/a\tb").host, "h", "the parser really does swallow it");
  assert.equal(beamableUrl("http://h/a\tb"), "");
  assert.equal(beamableUrl("http://h/a\nb"), "");
});

test("the address that ships is the one that was checked, byte for byte", () => {
  const { resolveBeamTarget } = load();
  // Not parsed.href: URL() normalises (default ports, percent-encoding, a bare
  // authority growing a "/"), and a normalised address is a different string
  // from the one the gate approved.
  const src = "https://cdn.example:443/a%2Db.mp4?t=1";
  assert.notEqual(new URL(src).href, src, "normalisation would have changed it");
  assert.equal(resolveBeamTarget({ elementSrc: src, items: [] }).url, src);
});

// ---------------------------------------------------------------------------
// Nothing usable: say why
// ---------------------------------------------------------------------------

test("an MSE element with nothing detected is told it is an MSE element", () => {
  const { resolveBeamTarget } = load();
  const out = resolveBeamTarget({ elementSrc: "blob:https://site.example/x", items: [] });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "mse-no-detection");
  assert.match(out.error, /blob:/,
    "the sentence names the actual cause, not a generic failure");
  assert.ok(out.error.length > 20 && out.error.length < 200);
});

test("an element with no src at all reads differently from an MSE one", () => {
  const { resolveBeamTarget } = load();
  const out = resolveBeamTarget({ elementSrc: "", items: [] });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "no-source");
  assert.notEqual(out.error, resolveBeamTarget({ elementSrc: "blob:x", items: [] }).error);
});

test("a refusal never carries a url for a caller to use anyway", () => {
  const { resolveBeamTarget } = load();
  for (const args of [
    { elementSrc: "blob:x", items: [] },
    { elementSrc: "", items: [] },
    { elementSrc: "file:///C:/a.mp4", items: [item({ kind: "youtube" })] },
  ]) {
    const out = resolveBeamTarget(args);
    assert.equal(out.ok, false);
    assert.equal("url" in out, false);
    assert.ok(Object.isFrozen(out));
  }
});

// ---------------------------------------------------------------------------
// Hostile / absent input
// ---------------------------------------------------------------------------

test("junk in never throws and never selects", () => {
  const { resolveBeamTarget } = load();
  const junk = [
    undefined, null, {}, { items: null }, { items: "nope" },
    { elementSrc: 7, items: [null, 3, "x", { url: 5 }, { kind: "hls" }] },
    { elementSrc: {}, items: [{ kind: "hls", url: "https://ok.example/a.m3u8", ts: "soon" }] },
  ];
  for (const args of junk) {
    const out = resolveBeamTarget(args);
    assert.equal(typeof out.ok, "boolean", JSON.stringify(args));
    if (out.ok) assert.equal(typeof out.url, "string");
  }
  // A row with a usable url but an unreadable ts is still usable — recency is a
  // tie-break, not a requirement.
  const out = resolveBeamTarget({
    elementSrc: {},
    items: [{ kind: "hls", url: "https://ok.example/a.m3u8", ts: "soon" }],
  });
  assert.equal(out.ok, true);
  assert.equal(out.url, "https://ok.example/a.m3u8");
});

// ---------------------------------------------------------------------------
// Where a beam may point
//
// The host spawns a player that FETCHES the address, outside the browser,
// where no origin policy applies. A page choosing that address can therefore
// reach things the page itself cannot: a router admin page, a service bound to
// loopback, a cloud metadata endpoint.
//
// Scoped to the BEAM arm on purpose. The yt-dlp download lane already accepts
// these addresses and is deliberately left alone -- it is reached from the
// popup by a person who typed or picked it, not from a page's own <video>.
//
// HONEST LIMIT: this refuses ADDRESSES, not destinations. A hostname that
// resolves into one of these ranges (localtest.me, a DNS record an attacker
// controls) is not caught, because a content script cannot resolve names and
// resolving them host-side would be a different check at a different time from
// the one that connects. What it removes is the whole class that needs no DNS
// at all, which is the class a page can use directly.
// ---------------------------------------------------------------------------

const INSIDE_THIS_MACHINE = [
  "http://127.0.0.1:8080/admin",
  "http://127.9.9.9/x.mp4",
  "http://localhost:8080/x.mp4",
  "http://LocalHost/x.mp4",
  "http://sub.localhost/x.mp4",
  "http://0.0.0.0/x.mp4",
  "http://10.0.0.5/x.mp4",
  "http://172.16.4.4/x.mp4",
  "http://172.31.255.255/x.mp4",
  "http://192.168.1.1/setup.mp4",
  "http://169.254.169.254/latest/meta-data/",
  "https://169.254.169.254/latest/meta-data/",
  "http://[::1]:8080/x.mp4",
  "http://[fe80::1]/x.mp4",
  "http://[fc00::1]/x.mp4",
  "http://[::ffff:127.0.0.1]/x.mp4",
];

for (const url of INSIDE_THIS_MACHINE) {
  test("a beam may not point at " + url, () => {
    const { beamableUrl } = load();
    assert.equal(beamableUrl(url), "", url);
  });
}

test("an ordinary public address is still beamable", () => {
  // The positive control. A refusal list that refused everything would pass
  // every assertion above and ship a feature that does nothing.
  const { beamableUrl } = load();
  for (const url of [
    "https://cdn.example/a.mp4",
    "http://cdn.example:8080/a.mp4",
    "https://172.32.0.1/a.mp4",        // just outside 172.16/12
    "https://11.0.0.1/a.mp4",          // just outside 10/8
    "https://192.169.0.1/a.mp4",       // just outside 192.168/16
    "https://169.253.0.1/a.mp4",       // just outside 169.254/16
  ]) {
    assert.equal(beamableUrl(url), url, url);
  }
});

test("a refused address never reaches the caller as a target", () => {
  // beamableUrl is the predicate; this is the behaviour that depends on it.
  const { resolveBeamTarget } = load();
  const out = resolveBeamTarget({
    elementSrc: "http://169.254.169.254/latest/meta-data/",
    items: [],
  });
  assert.equal(out.ok, false);
  assert.equal(typeof out.error, "string");
  assert.ok(out.error.length > 0, "a refusal names itself");
});

