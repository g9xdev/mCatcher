"use strict";
//
// The beam overlay: an icon in the top-right corner of a video that is
// PLAYING, in every frame the content script already runs in.
//
// Two things make this harder than "append a div".
//
// The page's CSS is hostile by default. A container that inherits anything, or
// that the page can select, is a container the page can move, hide or restyle;
// a container that participates in layout is a page this extension broke. So
// the overlay is a fixed-position element with its own stacking context and a
// CLOSED shadow root, and these tests pin those properties rather than trusting
// the stylesheet to have kept them.
//
// And an icon on every <video> would be worse than no icon at all: ad slots and
// tracking pixels are videos too. Eligibility is therefore a predicate over
// measurements — playing, big enough, on screen, not hidden — and it is pure so
// it can be pinned without a browser.
//
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadLib, mediaCatcherRoot } = require("./harness/load-lib.js");

const contentSrc = fs.readFileSync(path.join(mediaCatcherRoot, "content.js"), "utf8");

function load() {
  return loadLib("content.js");
}

// content.js with its commentary removed, so a test about what the CODE does
// is not answered by prose about it. Only whole-line comments are dropped:
// a trailing comment naming something this file forbids will fail the test
// rather than slip past it, which is the safe direction to be wrong in.
function codeLines(src) {
  return src.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// A DOM small enough to read, real enough to break the overlay if it is wrong.
// ---------------------------------------------------------------------------

function makeStyle() {
  const props = Object.create(null);
  return {
    _props: props,
    setProperty(name, value, priority) {
      props[name] = { value: String(value), priority: priority || "" };
    },
    removeProperty(name) { delete props[name]; },
    getPropertyValue(name) { return props[name] ? props[name].value : ""; },
    getPropertyPriority(name) { return props[name] ? props[name].priority : ""; },
  };
}

function makeNode(doc, tag, opts) {
  opts = opts || {};
  const node = {
    doc,
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    attrs: Object.create(null),
    listeners: Object.create(null),
    style: makeStyle(),
    textContent: "",
    shadowRoot: null,      // stays null for a CLOSED root, as in a real browser
    _closedShadow: null,
    _rect: opts.rect || { left: 0, top: 0, width: 0, height: 0 },
    get isConnected() {
      let cur = node;
      while (cur) {
        if (cur === doc.documentElement) return true;
        cur = cur.parentNode;
      }
      return false;
    },
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = node;
      node.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = node.children.indexOf(child);
      if (i >= 0) { node.children.splice(i, 1); child.parentNode = null; }
      return child;
    },
    remove() { if (node.parentNode) node.parentNode.removeChild(node); },
    setAttribute(name, value) { node.attrs[name] = String(value); },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(node.attrs, name) ? node.attrs[name] : null;
    },
    removeAttribute(name) { delete node.attrs[name]; },
    addEventListener(type, fn, capture) {
      (node.listeners[type] = node.listeners[type] || []).push({ fn, capture: !!capture });
    },
    removeEventListener(type, fn) {
      const list = node.listeners[type] || [];
      const i = list.findIndex((entry) => entry.fn === fn);
      if (i >= 0) list.splice(i, 1);
    },
    attachShadow(init) {
      const shadow = makeNode(doc, "#shadow-root");
      shadow.host = node;
      shadow.parentNode = node;      // so isConnected walks out of the shadow
      if (init && init.mode === "open") node.shadowRoot = shadow;
      else node._closedShadow = shadow;
      return shadow;
    },
    contains(other) {
      let cur = other;
      while (cur) { if (cur === node) return true; cur = cur.parentNode; }
      return false;
    },
    // Element.checkVisibility. In a browser this is the browser's own answer
    // to "are you painting this right now"; here it is a flag a test sets.
    // The options it was asked with are recorded, because every one of them
    // is OFF by default and asking without them asks a different question.
    _visible: true,
    _visibilityOpts: null,
    checkVisibility(opts) {
      node._visibilityOpts = opts || null;
      return node._visible !== false;
    },
    getBoundingClientRect() {
      const r = node._rect;
      return {
        left: r.left, top: r.top, width: r.width, height: r.height,
        right: r.left + r.width, bottom: r.top + r.height,
      };
    },
    querySelector(selector) {
      const all = node.querySelectorAll(selector);
      return all.length ? all[0] : null;
    },
    querySelectorAll(selector) {
      const out = [];
      const want = String(selector).toUpperCase();
      (function walk(n) {
        for (const child of n.children) {
          if (want === "*" || child.tagName === want) out.push(child);
          walk(child);
        }
      })(node);
      return out;
    },
    // Test helper: run this node's listeners for `type`, ignoring phase.
    _fire(type, event) {
      for (const entry of (node.listeners[type] || []).slice()) entry.fn(event || { type });
    },
    // Test helper: dispatch to this node the way a browser does when the node
    // IS the (retargeted) target. The path is walked twice — a capturing
    // traversal, then a bubbling one — and each traversal runs only its own
    // listeners, in registration order. So every capture listener on the node
    // precedes every bubble one however early the bubble one was bound.
    // stopImmediatePropagation ends the traversal in progress; either stop
    // call keeps the second traversal from starting.
    //
    // Checked against Firefox 154: a bubble listener bound first still runs
    // after a capture listener bound second, on the same node, at the target.
    _dispatchAtTarget(type, event) {
      const ev = event || makeEvent(type);
      const bound = (node.listeners[type] || []).slice();
      const stoppedAll = () => ev._seen && (ev._seen.stop > 0 || ev._seen.stopImmediate > 0);
      for (const capturing of [true, false]) {
        if (stoppedAll()) break;
        for (const entry of bound.filter((e) => e.capture === capturing)) {
          if (ev._seen && ev._seen.stopImmediate > 0) break;
          entry.fn(ev);
        }
      }
      return ev;
    },
    _text() {
      let out = node.textContent || "";
      for (const child of node.children) out += child._text();
      return out;
    },
  };
  return node;
}

// A browser stamps every Event with isTrusted, and it is TRUE only for one the
// browser itself generated from an input device. The default here is therefore
// true — that is what the tests above are describing when they say "clicked" —
// and a test that wants the other kind has to ask for it. Leaving it unset
// would make every one of them a test of a synthetic click by accident.
function makeEvent(type, opts) {
  opts = opts || {};
  const seen = { stop: 0, stopImmediate: 0, prevent: 0 };
  return {
    type,
    isTrusted: "isTrusted" in opts ? opts.isTrusted : true,
    _seen: seen,
    stopPropagation() { seen.stop += 1; },
    stopImmediatePropagation() { seen.stopImmediate += 1; },
    preventDefault() { seen.prevent += 1; },
  };
}

function makeRoot(opts) {
  opts = opts || {};
  const messages = [];
  const responders = [];
  const rafs = [];
  const timers = [];
  const doc = {};

  doc.documentElement = makeNode(doc, "html");
  doc.body = makeNode(doc, "body");
  doc.documentElement.appendChild(doc.body);
  doc.title = "A page";
  doc.referrer = "";
  doc.fullscreenElement = null;
  doc.createElement = (tag) => makeNode(doc, tag);
  doc.querySelector = (sel) => doc.documentElement.querySelector(sel);
  doc.querySelectorAll = (sel) => doc.documentElement.querySelectorAll(sel);
  doc.addEventListener = (type, fn, capture) =>
    doc.documentElement.addEventListener(type, fn, capture);
  doc.contains = (n) => doc.documentElement.contains(n);
  doc._fire = (type, event) => doc.documentElement._fire(type, event);

  const root = {
    document: doc,
    location: { href: "https://site.example/watch", hostname: "site.example",
                pathname: "/watch", search: "", origin: "https://site.example" },
    innerWidth: opts.viewportWidth || 1280,
    innerHeight: opts.viewportHeight || 720,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-00000000beef" },
    MutationObserver: class {
      constructor(cb) { this.cb = cb; root._observers.push(this); }
      observe() {}
      disconnect() {}
    },
    getComputedStyle(el) {
      root._styleReads += 1;
      return (el && el._computed) ||
        { display: "block", visibility: "visible", opacity: "1", contentVisibility: "visible" };
    },
    requestAnimationFrame(fn) { rafs.push(fn); return rafs.length; },
    cancelAnimationFrame() {},
    setInterval(fn, ms) { timers.push({ fn, ms, kind: "interval" }); return timers.length; },
    setTimeout(fn, ms) { timers.push({ fn, ms, kind: "timeout" }); return timers.length; },
    clearInterval() {},
    clearTimeout() {},
    // The window's own listeners, recorded rather than dropped: scroll and
    // resize are bound here, not on the document.
    _windowListeners: Object.create(null),
    addEventListener(type, fn, capture) {
      (root._windowListeners[type] = root._windowListeners[type] || [])
        .push({ fn, capture: !!capture });
    },
    _fireWindow(type, event) {
      for (const entry of (root._windowListeners[type] || []).slice()) {
        entry.fn(event || { type });
      }
    },
    browser: {
      runtime: {
        sendMessage(message) {
          messages.push(message);
          if (message && message.type === "page-snapshot-context") {
            return Promise.resolve({ ok: true, tabId: 7, frameId: 0, documentId: null,
                                     topLevelPageUrl: "https://site.example/watch" });
          }
          if (message && message.type === "beam-video") {
            const responder = opts.onBeam || (() => ({ ok: true, url: "https://x/y.mp4" }));
            return Promise.resolve(responder(message));
          }
          return Promise.resolve(undefined);
        },
        onMessage: { addListener(fn) { responders.push(fn); } },
      },
    },
    _styleReads: 0,
    _messages: messages,
    _responders: responders,
    _rafs: rafs,
    _timers: timers,
    _observers: [],
    // Run every animation frame that is currently queued (the loop re-queues).
    _pumpFrames(times) {
      for (let i = 0; i < (times || 1); i += 1) {
        const queued = rafs.splice(0, rafs.length);
        for (const fn of queued) fn(Date.now());
      }
    },
  };
  root.window = root;
  root.self = root;
  root.top = root;
  return root;
}

function makeVideo(root, opts) {
  opts = opts || {};
  const v = makeNode(root.document, "video", {
    rect: opts.rect || { left: 100, top: 80, width: 640, height: 360 },
  });
  v.paused = "paused" in opts ? opts.paused : false;
  v.ended = "ended" in opts ? opts.ended : false;
  v.readyState = "readyState" in opts ? opts.readyState : 4;
  v.videoWidth = "videoWidth" in opts ? opts.videoWidth : 1920;
  v.videoHeight = "videoHeight" in opts ? opts.videoHeight : 1080;
  v.currentSrc = "currentSrc" in opts ? opts.currentSrc : "blob:https://site.example/9f1c";
  v.src = opts.src || "";
  if (opts.computed) v._computed = opts.computed;
  return v;
}

// Bring an installed content script to the point where the overlay has run at
// least one full pass over the document.
async function installed(root) {
  const api = load();
  api.install(root);
  await settle();
  await settle();
  await settle();
  return api;
}

function containers(root) {
  // The overlay's own containers are the only DIVs the content script appends.
  return root.document.documentElement.querySelectorAll("div")
    .filter((n) => n._closedShadow);
}

// ---------------------------------------------------------------------------
// Eligibility — a pure predicate over measurements
// ---------------------------------------------------------------------------

const VIEWPORT = { width: 1280, height: 720 };
const VISIBLE = { display: "block", visibility: "visible", opacity: "1",
                  contentVisibility: "visible" };

function env(over) {
  return Object.assign({
    rect: { left: 100, top: 80, width: 640, height: 360, right: 740, bottom: 440 },
    style: VISIBLE,
    viewport: VIEWPORT,
  }, over || {});
}

function playing(over) {
  return Object.assign({
    paused: false, ended: false, readyState: 4, videoWidth: 1920, videoHeight: 1080,
  }, over || {});
}

test("a playing, on-screen, real-sized video is eligible", () => {
  const { isBeamableVideo } = load();
  assert.equal(isBeamableVideo(playing(), env()), true);
});

test("play state alone decides whether the icon is there at all", () => {
  const { isBeamableVideo } = load();
  assert.equal(isBeamableVideo(playing({ paused: true }), env()), false);
  assert.equal(isBeamableVideo(playing({ ended: true }), env()), false);
  assert.equal(isBeamableVideo(playing({ readyState: 1 }), env()), false,
    "metadata without frames is not playing yet");
});

test("an element with no picture is not a video worth beaming", () => {
  const { isBeamableVideo } = load();
  assert.equal(isBeamableVideo(playing({ videoWidth: 0 }), env()), false,
    "an audio-only <video> has no picture to put a corner icon on");
  assert.equal(isBeamableVideo(playing({ videoHeight: 0 }), env()), false);
});

test("pixels and thumbnails are too small to matter", () => {
  const { isBeamableVideo } = load();
  const tiny = (w, h) => env({ rect: { left: 0, top: 0, width: w, height: h, right: w, bottom: h } });
  assert.equal(isBeamableVideo(playing(), tiny(1, 1)), false, "tracking pixel");
  assert.equal(isBeamableVideo(playing(), tiny(0, 0)), false, "zero-size");
  assert.equal(isBeamableVideo(playing(), tiny(160, 90)), false, "hover-preview thumbnail");
  assert.equal(isBeamableVideo(playing(), tiny(640, 8)), false, "one dimension is enough to fail");
});

test("each of the four style fields can take the icon away on its own", () => {
  // Four fields, not "however it was hidden" — this is a predicate over the
  // measurements it is handed, and a way of hiding a box that does not reach
  // one of these fields is not one it can see. Getting the ANCESTORS into
  // these four is beamStyle's job and is tested against the DOM below.
  const { isBeamableVideo } = load();
  for (const style of [
    { display: "none", visibility: "visible", opacity: "1", contentVisibility: "visible" },
    { display: "block", visibility: "hidden", opacity: "1", contentVisibility: "visible" },
    { display: "block", visibility: "collapse", opacity: "1", contentVisibility: "visible" },
    { display: "block", visibility: "visible", opacity: "0", contentVisibility: "visible" },
    { display: "block", visibility: "visible", opacity: "0.02", contentVisibility: "visible" },
    { display: "block", visibility: "visible", opacity: "1", contentVisibility: "hidden" },
  ]) {
    assert.equal(isBeamableVideo(playing(), env({ style })), false, JSON.stringify(style));
  }
});

test("a video scrolled out of the viewport gets no icon", () => {
  const { isBeamableVideo } = load();
  const off = { left: 100, top: -900, width: 640, height: 360, right: 740, bottom: -540 };
  assert.equal(isBeamableVideo(playing(), env({ rect: off })), false);
  const below = { left: 100, top: 900, width: 640, height: 360, right: 740, bottom: 1260 };
  assert.equal(isBeamableVideo(playing(), env({ rect: below })), false);
});

test("junk never throws and is never eligible", () => {
  const { isBeamableVideo } = load();
  for (const v of [null, undefined, 3, "video", {}]) {
    assert.equal(isBeamableVideo(v, env()), false);
  }
  assert.equal(isBeamableVideo(playing(), null), false);
  assert.equal(isBeamableVideo(playing(), env({ rect: null })), false);
});

// ---------------------------------------------------------------------------
// Where the icon goes
// ---------------------------------------------------------------------------

test("the icon sits inside the video's top-right corner", () => {
  const { beamIconRect } = load();
  const rect = { left: 100, top: 80, width: 640, height: 360, right: 740, bottom: 440 };
  const at = beamIconRect(rect, VIEWPORT);
  assert.ok(at, "a fully visible video has room");
  assert.ok(at.size >= 20 && at.size <= 64);
  assert.ok(at.left + at.size <= rect.right, "inside the right edge");
  assert.ok(at.left > rect.left + rect.width / 2, "on the RIGHT half, not the left");
  assert.ok(at.top >= rect.top, "inside the top edge");
  assert.ok(at.top < rect.top + rect.height / 2, "at the TOP, not the bottom");
});

test("a half-scrolled video keeps its icon inside the part you can see", () => {
  const { beamIconRect } = load();
  // Top edge above the viewport: the corner is off screen, the icon must not be.
  const rect = { left: 100, top: -200, width: 640, height: 360, right: 740, bottom: 160 };
  const at = beamIconRect(rect, VIEWPORT);
  assert.ok(at, "there is still a visible strip to draw in");
  assert.ok(at.top >= 0, "not above the viewport");
  assert.ok(at.top + at.size <= rect.bottom, "and not below the video");
});

test("no icon when the visible sliver is smaller than the icon", () => {
  const { beamIconRect } = load();
  const sliver = { left: 100, top: 716, width: 640, height: 360, right: 740, bottom: 1076 };
  assert.equal(beamIconRect(sliver, VIEWPORT), null);
  const gone = { left: 100, top: 900, width: 640, height: 360, right: 740, bottom: 1260 };
  assert.equal(beamIconRect(gone, VIEWPORT), null);
});

// ---------------------------------------------------------------------------
// Attaching, and not attaching
// ---------------------------------------------------------------------------

test("a playing video gets exactly one overlay, however often the page churns", async () => {
  const root = makeRoot();
  root.document.body.appendChild(makeVideo(root));
  await installed(root);

  assert.equal(containers(root).length, 1, "the icon is attached");
  for (let i = 0; i < 5; i += 1) {
    root.document._fire("playing", { target: root.document.querySelector("video") });
    root._pumpFrames(2);
  }
  await settle();
  assert.equal(containers(root).length, 1, "and never attached twice");
});

test("the icon comes and goes with the play state", async () => {
  const root = makeRoot();
  const video = makeVideo(root);
  root.document.body.appendChild(video);
  await installed(root);
  assert.equal(containers(root).length, 1);

  video.paused = true;
  root.document._fire("pause", { target: video });
  root._pumpFrames(2);
  assert.equal(containers(root).length, 0, "a paused video keeps no icon");

  video.paused = false;
  root.document._fire("playing", { target: video });
  root._pumpFrames(2);
  assert.equal(containers(root).length, 1, "and gets it back on resume");
});

test("a video removed from the page takes its overlay with it", async () => {
  const root = makeRoot();
  const video = makeVideo(root);
  root.document.body.appendChild(video);
  await installed(root);
  const container = containers(root)[0];
  assert.ok(container);

  video.remove();
  root._pumpFrames(3);
  assert.equal(containers(root).length, 0, "no orphan left floating over the page");
  assert.equal(container.isConnected, false);
});

test("an ad-sized and a hidden video are passed over while a real one is not", async () => {
  const root = makeRoot();
  root.document.body.appendChild(makeVideo(root, { rect: { left: 0, top: 0, width: 1, height: 1 } }));
  root.document.body.appendChild(makeVideo(root, {
    rect: { left: 0, top: 400, width: 640, height: 360 },
    computed: { display: "none", visibility: "visible", opacity: "1" },
  }));
  root.document.body.appendChild(makeVideo(root, { rect: { left: 0, top: 0, width: 800, height: 450 } }));
  await installed(root);
  assert.equal(containers(root).length, 1, "one icon, on the one video worth one");
});

test("a page full of ad slots is not measured with getComputedStyle", async () => {
  // getComputedStyle forces style resolution and is the one expensive read in
  // the discovery loop. Only a video that already passed play state and size
  // is worth paying it for.
  //
  // beamStyle composes over the ancestor chain, so the bill is that ONE
  // candidate's chain however many ad slots share the page with it. Measuring
  // the same page twice — with the ad slots and without — pins that property
  // directly, rather than pinning a total that every change in nesting depth
  // would have to renegotiate.
  async function readsFor(adSlots) {
    const root = makeRoot();
    for (let i = 0; i < adSlots; i += 1) {
      root.document.body.appendChild(makeVideo(root, {
        rect: { left: 0, top: 0, width: 300, height: 100 },   // under the floor
      }));
    }
    root.document.body.appendChild(makeVideo(root, {
      rect: { left: 0, top: 0, width: 800, height: 450 },
    }));
    await installed(root);
    assert.equal(containers(root).length, 1, "one icon, on the one candidate");
    return root._styleReads;
  }

  const alone = await readsFor(0);
  const crowded = await readsFor(20);
  assert.equal(crowded, alone,
    "twenty ad slots must not cost one style resolution between them (saw " +
      crowded + " with them, " + alone + " without)");
  assert.equal(alone, 3,
    "the whole bill is the candidate's own chain: <video>, <body>, <html> (saw " +
      alone + ")");
});

test("a frame with no video costs no animation frames and no elements", async () => {
  const root = makeRoot();
  await installed(root);
  // The overlay IS installed here — it is watching, it has simply found
  // nothing to draw. Without this the assertion below would be satisfied by
  // an extension that had no overlay at all.
  assert.ok(root.document.documentElement.listeners.pause,
    "the overlay is watching play state in this frame");
  assert.equal(containers(root).length, 0);
  assert.equal(root._rafs.length, 0,
    "nothing to position means no per-frame loop to run");
});

// An ancestor that hides the video hides the video. Measured in the installed
// Firefox 154: with `opacity:0!important` on a parent, the <video>'s OWN
// computed opacity is still "1"; with `display:none!important` on a parent its
// own computed display is still "inline"; with
// `content-visibility:hidden!important` on a parent its own computed
// content-visibility is still "visible". Reading getComputedStyle on the
// element alone therefore says "visible" for a video nobody can see — and the
// icon would be the only thing on that part of the page that IS painted.
for (const [name, computed] of [
  ["opacity:0", { display: "block", visibility: "visible", opacity: "0", contentVisibility: "visible" }],
  ["display:none", { display: "none", visibility: "visible", opacity: "1", contentVisibility: "visible" }],
  ["content-visibility:hidden",
   { display: "block", visibility: "visible", opacity: "1", contentVisibility: "hidden" }],
]) {
  test("a video whose ANCESTOR carries " + name + " gets no icon", async () => {
    const root = makeRoot();
    const wrapper = root.document.createElement("div");
    wrapper._computed = computed;
    const video = makeVideo(root);
    wrapper.appendChild(video);
    root.document.body.appendChild(wrapper);
    await installed(root);
    assert.equal(containers(root).length, 0,
      "an icon standing over an invisible video is the whole attack");
  });
}

test("an ancestor's opacity multiplies down rather than being taken alone", async () => {
  // Two ancestors at 0.3 each: neither is under the floor, the product is.
  // Opacity is not inherited, so this is the composition the browser does and
  // a single read of one node cannot see.
  const root = makeRoot();
  const outer = root.document.createElement("div");
  outer._computed = { display: "block", visibility: "visible", opacity: "0.3",
                      contentVisibility: "visible" };
  const inner = root.document.createElement("div");
  inner._computed = { display: "block", visibility: "visible", opacity: "0.3",
                      contentVisibility: "visible" };
  outer.appendChild(inner);
  inner.appendChild(makeVideo(root));
  root.document.body.appendChild(outer);
  await installed(root);
  assert.equal(containers(root).length, 0, "0.3 * 0.3 is under the floor");
});

test("an ordinary wrapper does not cost the video its icon", async () => {
  // The positive control for the three above: nesting alone is not hiding.
  const root = makeRoot();
  const outer = root.document.createElement("div");
  const inner = root.document.createElement("div");
  outer.appendChild(inner);
  inner.appendChild(makeVideo(root));
  root.document.body.appendChild(outer);
  await installed(root);
  assert.equal(containers(root).length, 1);
});

test("a video inside an open shadow root is reached", async () => {
  const root = makeRoot();
  const host = root.document.createElement("media-player");
  root.document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  shadow.appendChild(makeVideo(root));
  await installed(root);
  assert.equal(containers(root).length, 1, "shadow DOM is where real players live");
});

test("a video inside a CLOSED shadow root gets no icon", async () => {
  const sealed = makeRoot();
  const sealedHost = sealed.document.createElement("media-player");
  sealed.document.body.appendChild(sealedHost);
  sealedHost.attachShadow({ mode: "closed" }).appendChild(makeVideo(sealed));
  await installed(sealed);
  assert.equal(sealedHost.shadowRoot, null, "closed really is closed");
  assert.equal(containers(sealed).length, 0,
    "a closed player is invisible to a content script, and no pretence is made");
});

test("no branch reaches for an accessor a content script does not have", () => {
  // Element.openOrClosedShadowRoot does answer for a closed root, and the
  // sweep used to reach for it as a method. It is ChromeOnly. Established
  // against the shipped Firefox 154 rather than assumed:
  //   - every use of it in Firefox's own code is a PROPERTY read, and
  //     Firefox's own comments call it "the ChromeOnly property" and "the
  //     chrome-only openOrClosedShadowRoot API";
  //   - a content script runs in a sandbox built on an expanded principal
  //     ([contentPrincipal, extensionPrincipal]), which is not the system
  //     principal that ChromeOnly members are installed for;
  //   - Firefox 154 registers no `dom` WebExtension namespace, so there is no
  //     extension-facing wrapper for it either.
  // A branch calling it could not run, and a branch reading it would read
  // undefined. This is here so that re-adding one costs re-establishing the
  // fact first.
  assert.match(contentSrc, /beamSearchRoots/, "anchored: the sweep is in this file");
  assert.equal(/openOrClosedShadowRoot/.test(codeLines(contentSrc)), false,
    "the name may be explained in a comment; it may not be reached for in code");
});

test("a video scrolled into view gets its icon from the scroll handler", async () => {
  // The scroll handler is NOT a no-op in a frame with no overlay up. A video
  // below the fold is ineligible because it is off screen, and scrolling is
  // the only thing that changes that answer — no media event fires, and the
  // page need not mutate. If the handler returned early when nothing was
  // drawn, the icon would wait for the next mutation or the 12-second tick.
  const root = makeRoot();
  const video = makeVideo(root, { rect: { left: 100, top: 900, width: 640, height: 360 } });
  root.document.body.appendChild(video);
  await installed(root);
  assert.equal(containers(root).length, 0, "below the fold there is nothing to draw");

  video._rect = { left: 100, top: 80, width: 640, height: 360 };

  // Past the discovery throttle — a scroll gesture takes longer than that
  // anyway, and without the step this would be measuring the throttle.
  const realNow = Date.now;
  Date.now = () => realNow() + 1000;
  try {
    root._fireWindow("scroll");
  } finally {
    Date.now = realNow;
  }

  assert.equal(containers(root).length, 1,
    "the scroll IS the moment it became eligible, so the scroll is what notices");
});

// ---------------------------------------------------------------------------
// Not breaking the page
// ---------------------------------------------------------------------------

test("the container is out of flow, on top, and its shadow root is closed", async () => {
  const root = makeRoot();
  root.document.body.appendChild(makeVideo(root));
  await installed(root);
  const container = containers(root)[0];

  assert.equal(container.style.getPropertyValue("position"), "fixed",
    "out of flow: a fixed box contributes nothing to layout");
  assert.equal(container.style.getPropertyPriority("position"), "important",
    "!important, or one page rule takes the box back");
  assert.equal(container.style.getPropertyValue("z-index"), "2147483647");
  assert.notEqual(container.style.getPropertyValue("isolation"), "",
    "its own stacking context, so it cannot be re-ordered from outside");
  assert.equal(container.shadowRoot, null,
    "a CLOSED root: the page cannot read or restyle what is inside");
  assert.ok(container._closedShadow, "there is a shadow root, it is just not reachable");
  // No id and no class for a page stylesheet to select.
  assert.equal(container.getAttribute("id"), null);
  assert.equal(container.getAttribute("class"), null);
});

// The container is a plain <div> in the page's DOM, so `div{...!important}`
// selects it. Inline !important is what outranks that, and only for the
// properties actually written: an unwritten property is one the page keeps.
//
// Measured in the installed Firefox 154, against a container carrying exactly
// this set inline !important while the page ran
//   div{content-visibility:hidden!important; mask:...!important;
//       mix-blend-mode:multiply!important; scale:0!important;
//       rotate:90deg!important; translate:9999px 9999px!important;
//       overflow:hidden!important; clip:rect(0,0,0,0)!important;
//       zoom:0.0001!important; filter:opacity(0)!important}
// every one of the pinned values won the cascade, and the button inside the
// closed root reported checkVisibility() === true. Without content-visibility
// in the set the same page rule left the container hit-testable at its own
// coordinates with nothing rendered in it.
//
// This is an EXACT set: dropping a property from content.js fails this test,
// and so does adding one without naming it here. It pins MEMBERSHIP, not
// sufficiency — nobody has enumerated the properties that can suppress paint
// without suppressing hit-testing, which is why beamClick asks the browser
// whether the icon is rendered instead of relying on this list being complete.
const BEAM_PINNED_VALUES = {
  margin: "0",
  padding: "0",
  border: "0",
  "z-index": "2147483647",
  isolation: "isolate",
  contain: "layout style size",
  display: "block",
  float: "none",
  "clip-path": "none",
  clip: "auto",
  filter: "none",
  mask: "none",
  "mix-blend-mode": "normal",
  transform: "none",
  scale: "none",
  rotate: "none",
  translate: "none",
  zoom: "1",
  opacity: "1",
  visibility: "visible",
  "content-visibility": "visible",
  overflow: "visible",
  "pointer-events": "auto",
  "max-width": "none",
  "max-height": "none",
};

// Written per paint from the corner that was computed, so their values are
// not constants and are checked separately below.
const BEAM_GEOMETRY = ["position", "left", "top", "width", "height"];

test("the container pins this exact set of properties, by name, inline and !important", async () => {
  const root = makeRoot();
  root.document.body.appendChild(makeVideo(root));
  await installed(root);
  const container = containers(root)[0];

  const written = Object.keys(container.style._props).sort();
  const expected = BEAM_GEOMETRY.concat(Object.keys(BEAM_PINNED_VALUES)).sort();
  assert.deepEqual(written, expected,
    "the set the container defends is the set named here, neither more nor less");

  for (const name of expected) {
    assert.equal(container.style.getPropertyPriority(name), "important",
      name + " without !important is a property one page rule takes back");
  }
  for (const name of Object.keys(BEAM_PINNED_VALUES)) {
    assert.equal(container.style.getPropertyValue(name), BEAM_PINNED_VALUES[name], name);
  }
  assert.equal(container.style.getPropertyValue("position"), "fixed");
  assert.match(container.style.getPropertyValue("left"), /^-?\d+(\.\d+)?px$/);
  assert.match(container.style.getPropertyValue("top"), /^-?\d+(\.\d+)?px$/);
  assert.equal(container.style.getPropertyValue("width"), "28px");
  assert.equal(container.style.getPropertyValue("height"), "28px");
});

test("clicking the icon never reaches the page's own handlers", async () => {
  const root = makeRoot();
  root.document.body.appendChild(makeVideo(root));
  await installed(root);
  const container = containers(root)[0];

  const event = makeEvent("click");
  container._fire("click", event);
  await settle();
  assert.ok(event._seen.stop >= 1, "propagation stopped");
  assert.ok(event._seen.stopImmediate >= 1, "and stopped for good");
  assert.ok(event._seen.prevent >= 1, "the page's default for that spot is not run");
});

test("a page handler on the container itself never sees the click", async () => {
  // The container is a node in the page's DOM, so page script can bind on it
  // directly — including in the CAPTURE phase, which at the target runs
  // before every bubble listener no matter who was bound first. The overlay's
  // own handlers are capture and are bound before the container is reachable,
  // so they are first in that traversal and end the event there.
  const root = makeRoot();
  root.document.body.appendChild(makeVideo(root));
  await installed(root);
  const container = containers(root)[0];

  let sawCapturing = 0;
  let sawBubbling = 0;
  container.addEventListener("click", function () { sawCapturing += 1; }, true);
  container.addEventListener("click", function () { sawBubbling += 1; }, false);

  container._dispatchAtTarget("click", makeEvent("click"));
  await settle();

  assert.equal(sawCapturing, 0, "a page capture listener on this node is not first");
  assert.equal(sawBubbling, 0, "and a bubble one never gets a turn");
  assert.equal(root._messages.filter((m) => m && m.type === "beam-video").length, 1,
    "the click still worked — the page is excluded, not the button");
});

test("everything a click is made of is taken off the page's hands", async () => {
  // Stopping only `click` would still let a player that acts on mousedown —
  // many do — pause the video underneath while its icon is being pressed.
  const root = makeRoot();
  root.document.body.appendChild(makeVideo(root));
  await installed(root);
  const container = containers(root)[0];

  for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup",
                      "touchstart", "touchend", "dblclick", "contextmenu"]) {
    const event = makeEvent(type);
    container._fire(type, event);
    assert.ok(event._seen.stop >= 1, type + " reached the page");
    assert.ok(event._seen.stopImmediate >= 1,
      type + " reached a page listener bound before ours");
    assert.ok(event._seen.prevent >= 1, type + " ran the page's default for that spot");
  }
});

test("a page that wipes the style attribute gets the whole set back", async () => {
  // Inline !important outranks a page stylesheet. It does not survive a
  // script assigning style="" or replacing the attribute, and nothing has
  // moved, so the cheap pass has no reason to look. The deep pass re-asserts
  // every property rather than only the corner it just computed.
  const root = makeRoot();
  root.document.body.appendChild(makeVideo(root));
  await installed(root);
  const container = containers(root)[0];
  assert.equal(container.style.getPropertyValue("position"), "fixed");

  container.style = makeStyle();          // the page cleared it

  const realNow = Date.now;
  Date.now = () => realNow() + 1000;      // past the discovery throttle
  try {
    root._pumpFrames(2);
  } finally {
    Date.now = realNow;
  }

  assert.equal(container.style.getPropertyValue("position"), "fixed",
    "not just the corner — the properties that keep it out of the page's way");
  assert.equal(container.style.getPropertyPriority("position"), "important");
  assert.equal(container.style.getPropertyValue("z-index"), "2147483647");
  assert.equal(container.style.getPropertyValue("contain"), "layout style size");
});

test("the button all:unset stripped still shows keyboard focus", () => {
  // `all:unset` takes the browser's focus ring with it, and the button stays
  // reachable by keyboard. This is a conditional, not a copy of the rule: a
  // sheet that stops resetting the button does not need to put a ring back,
  // and one that keeps resetting it does.
  const sheet = contentSrc.match(/var BEAM_CSS = \[([\s\S]*?)\]\.join\(""\);/);
  assert.ok(sheet, "anchored: the overlay's stylesheet is still built here");
  if (/all\s*:\s*(unset|initial|revert)/.test(sheet[1])) {
    assert.match(sheet[1], /:focus-visible\{[^}]*outline\s*:/,
      "the reset removed the ring, so the sheet has to draw one");
  }
});

// ---------------------------------------------------------------------------
// The click, and only the click
// ---------------------------------------------------------------------------

test("nothing about the video leaves the page until a person clicks the icon", async () => {
  const root = makeRoot();
  root.document.body.appendChild(makeVideo(root, { currentSrc: "blob:https://site.example/9f1c" }));
  await installed(root);
  root._pumpFrames(5);
  await settle();

  assert.equal(root._messages.some((m) => m && m.type === "beam-video"), false,
    "attaching an icon is not an event worth telling anyone about");

  const container = containers(root)[0];
  container._fire("click", makeEvent("click"));
  await settle();

  const beams = root._messages.filter((m) => m && m.type === "beam-video");
  assert.equal(beams.length, 1);
  assert.deepEqual(Object.keys(beams[0]).sort(), ["src", "type"],
    "the frame names the element's src and nothing else");
  assert.equal(beams[0].src, "blob:https://site.example/9f1c",
    "sent as-is: whether a blob: can be beamed is not this frame's decision");
});

test("a click the page dispatched itself beams nothing", async () => {
  // The container is a node in the PAGE's DOM. Page script can find it —
  // elementFromPoint over the icon's rect is deterministic — and call
  // .click() on it. Everything downstream of this listener (resolve the
  // address, cross the native port, spawn BadApple) then runs with no user in
  // it, and this listener is the last place the difference between a user and
  // a script is still visible.
  const root = makeRoot();
  root.document.body.appendChild(makeVideo(root, { currentSrc: "https://cdn.example/a.mp4" }));
  await installed(root);
  const container = containers(root)[0];

  container._fire("click", makeEvent("click", { isTrusted: false }));
  await settle();
  await settle();
  assert.equal(root._messages.filter((m) => m && m.type === "beam-video").length, 0,
    "a click dispatched from script launches no process");

  // An event carrying no flag at all is not a user either.
  container._fire("click", makeEvent("click", { isTrusted: undefined }));
  await settle();
  await settle();
  assert.equal(root._messages.filter((m) => m && m.type === "beam-video").length, 0,
    "and neither is an event that never carried the flag");

  // A gate, not a switch: the real click still goes through.
  container._fire("click", makeEvent("click"));
  await settle();
  assert.equal(root._messages.filter((m) => m && m.type === "beam-video").length, 1);
});

test("a listener call carrying no event at all is refused, not thrown out of", async () => {
  // The other half of the same guard. A browser always hands a listener an
  // event, so this is defensive — but "defensive" is the claim, and without a
  // test the code can stop making it. With `!e ||` gone, `e.isTrusted` throws
  // a TypeError out of a listener bound to a node in the PAGE's DOM, and a
  // listener that throws is not a listener that refused: the page sees the
  // exception, and nothing in the overlay records that a beam was declined.
  const root = makeRoot();
  root.document.body.appendChild(makeVideo(root, { currentSrc: "https://cdn.example/a.mp4" }));
  await installed(root);
  const container = containers(root)[0];

  assert.doesNotThrow(() => {
    for (const entry of container.listeners.click) entry.fn(null);
  }, "the guard returns; it does not fall through to a property read on null");
  await settle();
  await settle();
  assert.equal(root._messages.filter((m) => m && m.type === "beam-video").length, 0,
    "no event means no user, and no user means no beam");
});

// The button inside the container's closed shadow root — the thing a person
// actually sees and presses.
function overlayButton(container) {
  return container._closedShadow.querySelectorAll("button")[0];
}

test("a click on an icon the browser is not painting beams nothing", async () => {
  // isTrusted answers "a human clicked". It cannot answer "the human could
  // see what they clicked", and the two come apart: an element with nothing
  // painted in it is still hit-tested at its own coordinates. Measured in the
  // installed Firefox 154, against a container carrying the whole pinned set
  // inline !important, with the page running
  // `div{content-visibility:hidden!important}`:
  //   container.checkVisibility(...) -> true   (the box is there)
  //   button.checkVisibility(...)    -> false  (nothing is drawn in it)
  //   document.elementFromPoint(centre of the icon) -> the container
  // So the container's own answer is not enough, and the button is asked too.
  const root = makeRoot();
  root.document.body.appendChild(makeVideo(root, { currentSrc: "https://cdn.example/a.mp4" }));
  await installed(root);
  const container = containers(root)[0];
  const button = overlayButton(container);
  assert.ok(button, "there is a button to ask about");

  button._visible = false;
  container._fire("click", makeEvent("click"));
  await settle();
  await settle();
  assert.equal(root._messages.filter((m) => m && m.type === "beam-video").length, 0,
    "an icon with nothing drawn in it cannot have been what a person aimed at");

  // The other half of the same measurement: an ancestor carrying opacity:0
  // makes the CONTAINER report false while the page keeps it hit-testable.
  button._visible = true;
  container._visible = false;
  container._fire("click", makeEvent("click"));
  await settle();
  await settle();
  assert.equal(root._messages.filter((m) => m && m.type === "beam-video").length, 0,
    "and neither can one the browser says it is not rendering");

  // A gate, not a switch.
  container._visible = true;
  container._fire("click", makeEvent("click"));
  await settle();
  assert.equal(root._messages.filter((m) => m && m.type === "beam-video").length, 1,
    "a visible icon still beams");
});

test("the render check asks for the four options that are off by default", async () => {
  // checkVisibility() with no argument answers a narrower question than this
  // needs: contentVisibilityAuto, opacityProperty, visibilityProperty and
  // checkVisibilityCSS all default to false, so each of the four ways a page
  // can suppress paint has to be asked for by name.
  const root = makeRoot();
  root.document.body.appendChild(makeVideo(root, { currentSrc: "https://cdn.example/a.mp4" }));
  await installed(root);
  const container = containers(root)[0];

  container._fire("click", makeEvent("click"));
  await settle();

  for (const el of [container, overlayButton(container)]) {
    assert.ok(el._visibilityOpts, "asked at all");
    assert.equal(el._visibilityOpts.checkVisibilityCSS, true);
    assert.equal(el._visibilityOpts.contentVisibilityAuto, true);
    assert.equal(el._visibilityOpts.opacityProperty, true);
    assert.equal(el._visibilityOpts.visibilityProperty, true);
  }
});

test("an icon whose browser will not say whether it is painted is not clickable", async () => {
  // Feature detection with the answer stated: absent REFUSES. This check is
  // the only thing that can answer "the person could see what they clicked",
  // and an answer that could not be obtained is not a yes. The manifest's
  // strict_min_version is what keeps this from being the ordinary case.
  const root = makeRoot();
  root.document.body.appendChild(makeVideo(root, { currentSrc: "https://cdn.example/a.mp4" }));
  await installed(root);
  const container = containers(root)[0];
  delete container.checkVisibility;
  delete overlayButton(container).checkVisibility;

  container._fire("click", makeEvent("click"));
  await settle();
  await settle();
  assert.equal(root._messages.filter((m) => m && m.type === "beam-video").length, 0,
    "no answer is not a yes");
});

// The overlay's message panel, on its own — _text() below would also drag in
// the whole stylesheet.
function overlayMessage(container) {
  const panel = container._closedShadow.querySelectorAll("div")
    .filter((n) => n.getAttribute("data-p") === "m")[0];
  return panel ? panel.textContent : "";
}

test("a beam answered from the tab's detected media says so", async () => {
  // The background falls back to a stream detected on this TAB when the
  // element's own src is unusable, and that list does not record which
  // <video> consumed which row. On a page with a feature and an ad break it
  // can be the wrong one. Only the person watching can tell, so the message
  // has to give them the chance.
  const root = makeRoot({
    onBeam: () => ({ ok: true, url: "https://cdn.example/master.m3u8", source: "detected" }),
  });
  root.document.body.appendChild(makeVideo(root));
  await installed(root);
  const container = containers(root)[0];

  container._fire("click", makeEvent("click"));
  await settle();
  await settle();

  assert.match(overlayMessage(container), /detected on this tab/,
    "a guess is reported as a guess");
});

test("a beam of the video's own address does not hedge", async () => {
  const root = makeRoot({
    onBeam: () => ({ ok: true, url: "https://cdn.example/a.mp4", source: "element" }),
  });
  root.document.body.appendChild(makeVideo(root, { currentSrc: "https://cdn.example/a.mp4" }));
  await installed(root);
  const container = containers(root)[0];

  container._fire("click", makeEvent("click"));
  await settle();
  await settle();

  const text = overlayMessage(container);
  assert.match(text, /Sent to BadApple/);
  assert.equal(/detected on this tab/.test(text), false,
    "this element named the address; there is nothing to warn about");
});

test("a beam that never left the page is not reported as sent", async () => {
  // The rejection arm of the send. sendMessage REJECTS when the extension
  // context has gone away — met on every extension reload, with the old
  // content script still bound to the page — and the click then reaches
  // nothing at all: no background, no native port, no BadApple.
  //
  // Without this test the arm can be made to resolve ok:true and stay green,
  // which would put "Sent to BadApple." in front of someone whose click did
  // not leave the page. A false success is worse than the failure it hides,
  // because the only correction available is to go and look at the TV.
  const root = makeRoot({
    onBeam: () => Promise.reject(new Error("Extension context invalidated.")),
  });
  root.document.body.appendChild(makeVideo(root, { currentSrc: "https://cdn.example/a.mp4" }));
  await installed(root);
  const container = containers(root)[0];

  container._fire("click", makeEvent("click"));
  await settle();
  await settle();

  const text = overlayMessage(container);
  assert.equal(/Sent to BadApple/.test(text), false,
    "nothing was sent, so nothing may say it was");
  assert.match(text, /did not answer/, "the person is told the click went nowhere");

  const panel = container._closedShadow.querySelectorAll("div")
    .filter((n) => n.getAttribute("data-p") === "m")[0];
  assert.equal(panel.getAttribute("data-tone"), "bad",
    "and it is toned as the failure it is, not as a success");
});

test("a refusal is put in front of the person who clicked", async () => {
  const root = makeRoot({
    onBeam: () => ({ ok: false, error: "This player builds the video in the page (a blob: source)." }),
  });
  root.document.body.appendChild(makeVideo(root));
  await installed(root);
  const container = containers(root)[0];

  container._fire("click", makeEvent("click"));
  await settle();
  await settle();

  assert.match(container._closedShadow._text(), /blob: source/,
    "the reason is shown on the video, not left in a background log");
});

test("a refusal that arrives later, off the port, still reaches the overlay", async () => {
  const root = makeRoot();
  root.document.body.appendChild(makeVideo(root));
  await installed(root);
  const container = containers(root)[0];
  container._fire("click", makeEvent("click"));
  await settle();

  assert.ok(root._responders.length, "the content script listens for a late answer");
  for (const fn of root._responders) {
    fn({ type: "beam-result", ok: false, error: "BadApple is not installed on this computer." },
       {}, () => {});
  }
  await settle();
  assert.match(container._closedShadow._text(), /BadApple is not installed/);
});

// ---------------------------------------------------------------------------
// Fullscreen
// ---------------------------------------------------------------------------

test("the overlay follows the video into a fullscreened player", async () => {
  const root = makeRoot();
  const player = root.document.createElement("div");
  const video = makeVideo(root);
  player.appendChild(video);
  root.document.body.appendChild(player);
  await installed(root);
  const container = containers(root)[0];
  assert.equal(container.parentNode, root.document.body,
    "normally parked at the top of the document");

  root.document.fullscreenElement = player;
  root.document._fire("fullscreenchange", { target: player });
  root._pumpFrames(2);
  assert.equal(container.parentNode, player,
    "a fixed box outside the fullscreen element is painted under it");
});

test("an overlay for a video outside the fullscreen element is taken down", async () => {
  const root = makeRoot();
  const other = root.document.createElement("div");
  const video = makeVideo(root);
  root.document.body.appendChild(other);
  root.document.body.appendChild(video);
  await installed(root);
  assert.equal(containers(root).length, 1);

  // Someone else's element went fullscreen. The top layer is above every
  // z-index, so a container left parked on <body> is painted UNDER it: an
  // icon nobody can see or click, floating over someone else's content.
  root.document.fullscreenElement = other;
  root.document._fire("fullscreenchange", { target: other });
  root._pumpFrames(2);
  assert.equal(containers(root).length, 0,
    "nowhere honest to put it, so it is taken down");
});

test("a <video> that is itself the fullscreen element hides the icon rather than lying", async () => {
  const root = makeRoot();
  const video = makeVideo(root);
  root.document.body.appendChild(video);
  await installed(root);
  assert.equal(containers(root).length, 1);

  // Nothing can be rendered inside a <video>, so there is no honest place for
  // the icon to go — it must not float over the fullscreen content instead.
  root.document.fullscreenElement = video;
  root.document._fire("fullscreenchange", { target: video });
  root._pumpFrames(2);
  assert.equal(containers(root).length, 0);
});

// ---------------------------------------------------------------------------
// Zero network
// ---------------------------------------------------------------------------

test("the content script has no way to make a network request", () => {
  // Anchored, or this passes on a content.js with no overlay in it at all.
  assert.match(contentSrc, /beam-video/,
    "the file under inspection is the one carrying the beam lane");
  for (const forbidden of [
    /\bfetch\s*\(/, /XMLHttpRequest/, /\bnew\s+Image\b/, /navigator\.sendBeacon/,
    /new\s+WebSocket/, /new\s+EventSource/, /\.src\s*=\s*["']https?:/,
  ]) {
    assert.equal(forbidden.test(contentSrc), false,
      "content.js must not contain " + forbidden);
  }
});
