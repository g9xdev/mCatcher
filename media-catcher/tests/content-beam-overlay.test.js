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
    // Test helper: fire an event through this node's capture listeners.
    _fire(type, event) {
      for (const entry of (node.listeners[type] || []).slice()) entry.fn(event || { type });
    },
    _text() {
      let out = node.textContent || "";
      for (const child of node.children) out += child._text();
      return out;
    },
  };
  return node;
}

function makeEvent(type) {
  const seen = { stop: 0, stopImmediate: 0, prevent: 0 };
  return {
    type,
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
      return (el && el._computed) || { display: "block", visibility: "visible", opacity: "1" };
    },
    requestAnimationFrame(fn) { rafs.push(fn); return rafs.length; },
    cancelAnimationFrame() {},
    setInterval(fn, ms) { timers.push({ fn, ms, kind: "interval" }); return timers.length; },
    setTimeout(fn, ms) { timers.push({ fn, ms, kind: "timeout" }); return timers.length; },
    clearInterval() {},
    clearTimeout() {},
    addEventListener() {},
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
const VISIBLE = { display: "block", visibility: "visible", opacity: "1" };

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

test("a hidden video gets no icon however it was hidden", () => {
  const { isBeamableVideo } = load();
  for (const style of [
    { display: "none", visibility: "visible", opacity: "1" },
    { display: "block", visibility: "hidden", opacity: "1" },
    { display: "block", visibility: "collapse", opacity: "1" },
    { display: "block", visibility: "visible", opacity: "0" },
    { display: "block", visibility: "visible", opacity: "0.02" },
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

test("a video inside an open shadow root is reached", async () => {
  const root = makeRoot();
  const host = root.document.createElement("media-player");
  root.document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  shadow.appendChild(makeVideo(root));
  await installed(root);
  assert.equal(containers(root).length, 1, "shadow DOM is where real players live");
});

test("a CLOSED shadow root is reached only through the accessor the browser offers", async () => {
  // element.shadowRoot is null for a closed root. Firefox hands content
  // scripts openOrClosedShadowRoot(), which is the only way in; without it a
  // closed player is genuinely invisible and gets no icon.
  const sealed = makeRoot();
  const sealedHost = sealed.document.createElement("media-player");
  sealed.document.body.appendChild(sealedHost);
  sealedHost.attachShadow({ mode: "closed" }).appendChild(makeVideo(sealed));
  await installed(sealed);
  assert.equal(sealedHost.shadowRoot, null, "closed really is closed");
  assert.equal(containers(sealed).length, 0,
    "no accessor, no icon — and no pretence of one");

  const open = makeRoot();
  const host = open.document.createElement("media-player");
  open.document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.appendChild(makeVideo(open));
  host.openOrClosedShadowRoot = () => shadow;
  await installed(open);
  assert.equal(containers(open).length, 1, "with the accessor, the player is found");
});

test("the sweep never descends into the overlay's own closed root", async () => {
  const root = makeRoot();
  const decoy = root.document.createElement("some-widget");
  root.document.body.appendChild(decoy);
  root.document.body.appendChild(makeVideo(root));
  await installed(root);
  const container = containers(root)[0];

  // With openOrClosedShadowRoot present, our OWN container's closed root is
  // reachable too. Descending into it would be a walk that finds nothing and
  // spends the sweep's budget on it.
  let peekedOverlay = 0;
  let peekedDecoy = 0;
  container.openOrClosedShadowRoot = () => { peekedOverlay += 1; return container._closedShadow; };
  decoy.openOrClosedShadowRoot = () => { peekedDecoy += 1; return null; };

  // The root list is cached; step past that window so a real sweep runs,
  // otherwise this test would be satisfied by the cache rather than the skip.
  const realNow = Date.now;
  Date.now = () => realNow() + 60000;
  try {
    root.document._fire("playing", { target: root.document.querySelector("video") });
    root._pumpFrames(2);
  } finally {
    Date.now = realNow;
  }

  assert.ok(peekedDecoy >= 1, "a sweep really did run");
  assert.equal(peekedOverlay, 0, "the overlay is skipped by identity, not by luck");
  assert.equal(containers(root).length, 1);
});

// ---------------------------------------------------------------------------
// Not breaking the page
// ---------------------------------------------------------------------------

test("the container is out of flow, on top, and sealed against the page", async () => {
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

// ---------------------------------------------------------------------------
// The click, and only the click
// ---------------------------------------------------------------------------

test("nothing about the video leaves the page until the icon is clicked", async () => {
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
