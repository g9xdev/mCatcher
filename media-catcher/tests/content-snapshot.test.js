"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadLib, mediaCatcherRoot } = require("./harness/load-lib.js");

const contentPath = path.join(mediaCatcherRoot, "content.js");
const contentSrc = fs.readFileSync(contentPath, "utf8");

function loadContent() {
  return loadLib("content.js");
}

function el(tag, props) {
  props = props || {};
  const node = {
    tagName: String(tag).toUpperCase(),
    className: props.className || "",
    id: props.id || "",
    textContent: props.textContent == null ? "" : String(props.textContent),
    content: props.content,
    href: props.href,
    download: props.download,
    title: props.title,
    children: props.children || [],
    parent: props.parent || null,
    attributes: Object.assign({}, props.attributes || {}),
    dataset: Object.assign({}, props.dataset || {}),
  };
  if (props["data-filename"] != null) {
    node.attributes["data-filename"] = props["data-filename"];
    node.dataset.filename = props["data-filename"];
  }
  if (props.download != null) node.attributes.download = props.download;
  if (props["aria-label"] != null) {
    node.attributes["aria-label"] = props["aria-label"];
    node.getAttribute = function (name) {
      if (name === "aria-label") return props["aria-label"];
      if (Object.prototype.hasOwnProperty.call(node.attributes, name)) {
        return node.attributes[name];
      }
      return null;
    };
  } else {
    node.getAttribute = function (name) {
      if (Object.prototype.hasOwnProperty.call(node.attributes, name)) {
        return node.attributes[name];
      }
      if (name === "download" && node.download != null) return String(node.download);
      if (name === "href" && node.href != null) return String(node.href);
      if (name === "content" && node.content != null) return String(node.content);
      if (name === "title" && node.title != null) return String(node.title);
      return null;
    };
  }
  node.matches = function (selector) {
    return matchesSelector(node, selector);
  };
  node.closest = function (selector) {
    let cur = node;
    while (cur) {
      if (matchesSelector(cur, selector)) return cur;
      cur = cur.parent;
    }
    return null;
  };
  node.querySelectorAll = function (selector) {
    return collectMatching(node, selector);
  };
  node.querySelector = function (selector) {
    const all = node.querySelectorAll(selector);
    return all.length ? all[0] : null;
  };
  return node;
}

function matchesOne(node, simple) {
  simple = String(simple || "").trim();
  if (!simple) return false;
  if (simple === "*") return true;

  // compound: tag#id.class[attr]...
  let s = simple;
  let tag = null;
  const mTag = s.match(/^([a-zA-Z][\w-]*)/);
  if (mTag) {
    tag = mTag[1].toLowerCase();
    s = s.slice(mTag[1].length);
  }
  if (tag && String(node.tagName || "").toLowerCase() !== tag) return false;

  while (s.length) {
    if (s[0] === "#") {
      const m = s.match(/^#([\w-]+)/);
      if (!m || node.id !== m[1]) return false;
      s = s.slice(m[0].length);
      continue;
    }
    if (s[0] === ".") {
      const m = s.match(/^\.([\w-]+)/);
      if (!m) return false;
      const classes = String(node.className || "").split(/\s+/);
      if (classes.indexOf(m[1]) < 0) return false;
      s = s.slice(m[0].length);
      continue;
    }
    if (s[0] === "[") {
      const m = s.match(/^\[([^\]]+)\]/);
      if (!m) return false;
      const body = m[1];
      s = s.slice(m[0].length);
      let attrMatch = body.match(/^([\w:-]+)\$="([^"]*)"$/);
      if (attrMatch) {
        const val = node.getAttribute(attrMatch[1]);
        if (val == null || !String(val).endsWith(attrMatch[2])) return false;
        continue;
      }
      attrMatch = body.match(/^([\w:-]+)="([^"]*)"$/);
      if (attrMatch) {
        const val = node.getAttribute(attrMatch[1]);
        if (val !== attrMatch[2]) return false;
        continue;
      }
      attrMatch = body.match(/^([\w:-]+)$/);
      if (attrMatch) {
        const val = node.getAttribute(attrMatch[1]);
        if (val == null || val === false) return false;
        continue;
      }
      return false;
    }
    return false;
  }
  return true;
}

function matchesSelector(node, selector) {
  const parts = String(selector).split(",").map((p) => p.trim()).filter(Boolean);
  return parts.some((p) => matchesOne(node, p));
}

function walk(node, out) {
  out.push(node);
  (node.children || []).forEach((c) => walk(c, out));
}

function collectMatching(root, selector) {
  const all = [];
  walk(root, all);
  // root itself may be document-like with .documentElement
  if (root.documentElement) walk(root.documentElement, all);
  const seen = new Set();
  const out = [];
  for (const n of all) {
    if (seen.has(n)) continue;
    seen.add(n);
    if (matchesSelector(n, selector)) out.push(n);
  }
  return out;
}

function linkParents(node, parent) {
  node.parent = parent || null;
  (node.children || []).forEach((c) => linkParents(c, node));
  return node;
}

function makeDocument(opts) {
  opts = opts || {};
  const headChildren = opts.headChildren || [];
  const bodyChildren = opts.bodyChildren || [];
  const head = el("head", { children: headChildren });
  const body = el("body", { children: bodyChildren });
  const html = el("html", { children: [head, body] });
  linkParents(html, null);

  const title = opts.title != null ? String(opts.title) : "";
  const access = {
    cookie: 0,
    body: 0,
    localStorage: 0,
    sessionStorage: 0,
    scripts: 0,
  };

  const doc = {
    title,
    documentElement: html,
    head,
    referrer: opts.referrer != null ? String(opts.referrer) : "",
    get body() {
      access.body += 1;
      return body;
    },
    get cookie() {
      access.cookie += 1;
      return "secret=1";
    },
    get localStorage() {
      access.localStorage += 1;
      return { getItem() { return "nope"; } };
    },
    get sessionStorage() {
      access.sessionStorage += 1;
      return { getItem() { return "nope"; } };
    },
    querySelector(sel) {
      return collectMatching(html, sel)[0] || null;
    },
    querySelectorAll(sel) {
      return collectMatching(html, sel);
    },
    createElement(tag) {
      return el(tag, {});
    },
    addEventListener() {
      access.domListeners = (access.domListeners || 0) + 1;
    },
    _access: access,
  };

  Object.defineProperty(doc, "scripts", {
    get() {
      access.scripts += 1;
      return [];
    },
  });

  return doc;
}

function assertDeepFrozen(value, path) {
  path = path || "root";
  if (value && typeof value === "object") {
    assert.ok(Object.isFrozen(value), path + " must be frozen");
    for (const k of Object.keys(value)) {
      assertDeepFrozen(value[k], path + "." + k);
    }
  }
}

// ---------------------------------------------------------------------------
// Module surface
// ---------------------------------------------------------------------------

test("CommonJS export surface is frozen with exact public keys", () => {
  const api = loadContent();
  assert.ok(Object.isFrozen(api));
  assert.deepEqual(Object.keys(api).sort(), [
    "buildPageSnapshot",
    "collectFilenameCandidates",
    "createDocumentNonce",
    "install",
  ].sort());
  for (const k of Object.keys(api)) {
    assert.equal(typeof api[k], "function");
  }
});

test("require does not install browser listeners or send messages", () => {
  // Mutation: top-level install on require.
  let installCalls = 0;
  const prev = globalThis.browser;
  try {
    globalThis.browser = {
      runtime: {
        sendMessage() {
          installCalls += 1;
          return Promise.resolve(null);
        },
        onMessage: { addListener() { installCalls += 1; } },
      },
    };
    delete require.cache[require.resolve(contentPath)];
    require(contentPath);
    assert.equal(installCalls, 0);
  } finally {
    if (prev === undefined) delete globalThis.browser;
    else globalThis.browser = prev;
    delete require.cache[require.resolve(contentPath)];
  }
});

// ---------------------------------------------------------------------------
// collectFilenameCandidates
// ---------------------------------------------------------------------------

test("collects document-title og-title twitter-title headings media and page path in order", () => {
  const api = loadContent();
  const video = el("video", {
    title: "clip-title.mp4",
    children: [],
  });
  const a = el("a", {
    href: "https://cdn.example/files/11238-makemebi.net.mp4?token=SIGNED",
    className: "filename",
    textContent: "11238-makemebi.net.mp4",
  });
  const section = el("section", { children: [video, a] });
  video.parent = section;
  a.parent = section;

  const doc = makeDocument({
    title: "  Florenfile.com - Secure Cloud Storage  ",
    headChildren: [
      el("meta", {
        attributes: { property: "og:title", content: "OG Stream Name" },
        content: "OG Stream Name",
      }),
      el("meta", {
        attributes: { name: "twitter:title", content: "Twitter Stream Name" },
        content: "Twitter Stream Name",
      }),
    ],
    bodyChildren: [
      el("h1", { textContent: "Heading One" }),
      el("h2", { textContent: "Heading Two" }),
      el("h2", { textContent: "Heading Three" }),
      el("h2", { textContent: "Heading Four ignored" }),
      section,
    ],
  });

  const loc = {
    href: "https://florenfile.com/qnzjnabo3jec/11238-makemebi.net.mp4.html?auth=SIGNED_Q&x=1#frag",
  };
  const cands = api.collectFilenameCandidates(
    doc,
    loc,
    "https://referrer.example/path/to/ref.mp4.html?sig=SIGNED_REF#x"
  );

  assertDeepFrozen(cands);
  assert.ok(Array.isArray(cands));
  assert.ok(cands.length <= 40);

  const kinds = cands.map((c) => c.kind);
  assert.ok(kinds.includes("document-title"));
  assert.ok(kinds.includes("og-title"));
  assert.ok(kinds.includes("twitter-title"));
  assert.ok(kinds.includes("heading"));
  assert.ok(kinds.includes("visible-filename"));
  assert.ok(kinds.includes("media-metadata"));
  assert.ok(kinds.includes("page-url"));
  assert.ok(kinds.includes("referrer-url"));

  const title = cands.find((c) => c.kind === "document-title");
  assert.equal(title.value, "Florenfile.com - Secure Cloud Storage");
  assert.ok(Object.isFrozen(title));

  const headings = cands.filter((c) => c.kind === "heading");
  assert.equal(headings.length, 3);
  assert.deepEqual(headings.map((h) => h.value), [
    "Heading One",
    "Heading Two",
    "Heading Three",
  ]);

  const page = cands.find((c) => c.kind === "page-url");
  assert.equal(page.value, "/qnzjnabo3jec/11238-makemebi.net.mp4.html");

  const ref = cands.find((c) => c.kind === "referrer-url");
  assert.equal(ref.value, "/path/to/ref.mp4.html");

  const blob = JSON.stringify(cands);
  assert.equal(blob.includes("SIGNED_Q"), false);
  assert.equal(blob.includes("SIGNED_REF"), false);
  assert.equal(blob.includes("SIGNED"), false);
  assert.equal(blob.includes("?"), false);
  assert.equal(blob.includes("#"), false);

  // poison getters never touched
  assert.equal(doc._access.cookie, 0);
  assert.equal(doc._access.body, 0);
  assert.equal(doc._access.localStorage, 0);
  assert.equal(doc._access.sessionStorage, 0);
  assert.equal(doc._access.scripts, 0);
});

test("Florenfile path candidate is query-free and title remains document-title only", () => {
  const api = loadContent();
  const doc = makeDocument({
    title: "Florenfile.com - Secure Cloud Storage",
    bodyChildren: [],
  });
  const cands = api.collectFilenameCandidates(
    doc,
    { href: "https://florenfile.com/qnzjnabo3jec/11238-makemebi.net.mp4.html?token=abc" },
    ""
  );
  const page = cands.find((c) => c.kind === "page-url");
  assert.equal(page.value, "/qnzjnabo3jec/11238-makemebi.net.mp4.html");
  const titles = cands.filter((c) => c.kind === "document-title");
  assert.equal(titles.length, 1);
  assert.equal(titles[0].value, "Florenfile.com - Secure Cloud Storage");
  // Must not invent a visible-filename from the title.
  assert.equal(
    cands.some((c) => c.kind === "visible-filename" && /Florenfile/i.test(c.value)),
    false
  );
});

test("download attr data-filename and href basename emit correct kinds with caps", () => {
  const api = loadContent();
  const longName = "x".repeat(200) + ".mp4";
  const dl = el("a", {
    download: "from-download-attr.mp4",
    href: "https://cdn.example/other.mp4",
    textContent: "ignored-text-when-download",
  });
  const dataFn = el("span", {
    className: "file-name",
    "data-filename": "from-data-filename.mp4",
    textContent: "visible label",
  });
  // Class match (href may carry a signed query; only pathname basename is kept).
  const hrefOnly = el("a", {
    className: "filename",
    href: "https://cdn.example/path/" + longName + "?sig=SIGNED",
    textContent: "",
  });
  const media = el("video", {
    attributes: { "aria-label": "aria media name" },
    "aria-label": "aria media name",
    children: [el("source", { title: "source-title.mp4" })],
  });
  const article = el("article", { children: [media, dl, dataFn, hrefOnly] });
  media.parent = article;
  dl.parent = article;
  dataFn.parent = article;
  hrefOnly.parent = article;

  const doc = makeDocument({ title: "T", bodyChildren: [article] });
  const cands = api.collectFilenameCandidates(doc, { href: "https://x.test/p" }, "");

  const dlCand = cands.find((c) => c.kind === "download-attr");
  assert.ok(dlCand);
  assert.equal(dlCand.value, "from-download-attr.mp4");

  const dataCand = cands.find(
    (c) => c.kind === "visible-filename" && c.value === "from-data-filename.mp4"
  );
  assert.ok(dataCand);

  const hrefCand = cands.find(
    (c) => c.kind === "visible-filename" && c.value.endsWith(".mp4") && c.value.startsWith("x")
  );
  assert.ok(hrefCand);
  assert.ok(hrefCand.value.length <= 180);

  const mediaMeta = cands.filter((c) => c.kind === "media-metadata");
  assert.ok(mediaMeta.some((c) => c.value === "aria media name"));
  assert.ok(mediaMeta.some((c) => c.value === "source-title.mp4"));
});

test("caps headings at three and nearby filename elements at ten with dedupe", () => {
  const api = loadContent();
  const headings = [];
  for (let i = 1; i <= 6; i++) headings.push(el("h1", { textContent: "H" + i }));

  const files = [];
  for (let i = 1; i <= 15; i++) {
    files.push(el("a", {
      className: "filename",
      textContent: "file-" + i + ".mp4",
    }));
  }
  // duplicate value should not double-count uniquely toward useful set
  files.push(el("a", { className: "filename", textContent: "file-1.mp4" }));

  const video = el("video", { children: [] });
  const main = el("main", { children: [video].concat(files) });
  video.parent = main;
  files.forEach((f) => { f.parent = main; });

  const doc = makeDocument({
    title: "T",
    bodyChildren: headings.concat([main]),
  });
  const cands = api.collectFilenameCandidates(doc, { href: "https://x.test/" }, "");
  assert.equal(cands.filter((c) => c.kind === "heading").length, 3);
  const visibles = cands.filter(
    (c) => c.kind === "visible-filename" || c.kind === "download-attr"
  );
  assert.ok(visibles.length <= 10);
  const values = visibles.map((c) => c.value);
  assert.equal(new Set(values).size, values.length);
});

test("rejects blank control-bearing object-like and does not read body/cookies", () => {
  const api = loadContent();
  const badHeading = el("h1", { textContent: "ok\u0001bad" });
  const blank = el("h2", { textContent: "   " });
  const good = el("h2", { textContent: "Good Heading" });
  const doc = makeDocument({
    title: "",
    bodyChildren: [badHeading, blank, good],
  });
  const cands = api.collectFilenameCandidates(doc, { href: "https://x.test/a" }, null);
  assert.equal(cands.some((c) => c.kind === "document-title"), false);
  assert.equal(cands.some((c) => /[\u0000-\u001f]/.test(c.value)), false);
  assert.ok(cands.some((c) => c.kind === "heading" && c.value === "Good Heading"));
  assert.equal(doc._access.cookie, 0);
  assert.equal(doc._access.body, 0);
  assert.equal(doc._access.localStorage, 0);
  assert.equal(doc._access.sessionStorage, 0);
});

test("hostile object attribute values fail closed without String/toString/valueOf leaks", () => {
  const api = loadContent();
  const sentinel = "HOSTILE_LEAK_SENTINEL";
  function hostile(label) {
    return {
      toString() {
        return sentinel + "-" + label;
      },
      valueOf() {
        return sentinel + "-" + label;
      },
    };
  }

  // Property path: getAttribute returns null so implementation must not coerce props.
  const dl = {
    tagName: "A",
    className: "filename",
    download: hostile("download"),
    href: hostile("href"),
    textContent: hostile("text"),
    getAttribute() {
      return null;
    },
    matches() {
      return true;
    },
    closest() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const media = {
    tagName: "VIDEO",
    title: hostile("title"),
    attributes: { "aria-label": hostile("aria") },
    getAttribute() {
      return null;
    },
    matches() {
      return true;
    },
    closest() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  // getAttribute returns a non-string object (must omit, not coerce).
  const dataFn = {
    tagName: "SPAN",
    className: "file-name",
    getAttribute(name) {
      if (name === "data-filename") return hostile("data-filename");
      return null;
    },
    textContent: "",
    matches() {
      return true;
    },
    closest() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const meta = {
    content: hostile("og"),
    getAttribute(name) {
      if (name === "content") return hostile("og-attr");
      return null;
    },
  };

  const doc = {
    title: hostile("doc-title"),
    querySelector(sel) {
      if (String(sel).includes("og:title")) return meta;
      return null;
    },
    querySelectorAll(sel) {
      const s = String(sel);
      if (s.includes("download") || s.includes("filename") || s.includes("href$")) {
        return [dl, dataFn];
      }
      if (s.includes("video, audio, source") || s === "video,audio,source") return [media];
      if (s.includes("video, audio") || s === "video,audio") return [media];
      if (s.includes("h1") || s.includes("h2")) return [];
      return [];
    },
  };

  const cands = api.collectFilenameCandidates(
    doc,
    { href: "https://safe.example/path/ok.mp4.html?sig=SIGNED" },
    "https://ref.example/r?token=SIGNED_REF"
  );
  const blob = JSON.stringify(cands);
  assert.equal(blob.includes(sentinel), false);
  assert.equal(blob.includes("HOSTILE"), false);
  assert.equal(blob.includes("SIGNED"), false);
  // Safe primitive page path still collected.
  assert.ok(cands.some((c) => c.kind === "page-url" && c.value === "/path/ok.mp4.html"));
  // Hostile object title/meta/filename/media must be omitted entirely.
  assert.equal(cands.some((c) => c.kind === "document-title"), false);
  assert.equal(cands.some((c) => c.kind === "og-title"), false);
  assert.equal(cands.some((c) => c.kind === "download-attr"), false);
  assert.equal(cands.some((c) => c.kind === "visible-filename"), false);
  assert.equal(cands.some((c) => c.kind === "media-metadata"), false);

  // Boxed primitive wrappers are objects — also fail closed.
  const boxedDoc = makeDocument({ title: "", bodyChildren: [] });
  Object.defineProperty(boxedDoc, "title", {
    get() {
      return Object("BOXED_TITLE_LEAK");
    },
  });
  const boxed = api.collectFilenameCandidates(boxedDoc, { href: "https://x.test/p" }, "");
  assert.equal(JSON.stringify(boxed).includes("BOXED_TITLE_LEAK"), false);
  assert.equal(boxed.some((c) => c.kind === "document-title"), false);
});

test("filename truncation retains a real extension", () => {
  const api = loadContent();
  const longBase = "clip-" + "n".repeat(220);
  const longName = longBase + ".mp4";
  const a = el("a", {
    className: "filename",
    href: "https://cdn.example/files/" + longName + "?sig=SIGNED",
    textContent: "",
  });
  const doc = makeDocument({ title: "T", bodyChildren: [a] });
  const cands = api.collectFilenameCandidates(doc, { href: "https://x.test/p" }, "");
  const hrefCand = cands.find(
    (c) => c.kind === "visible-filename" && c.value.includes("n")
  );
  assert.ok(hrefCand, "long href basename should still produce a candidate");
  assert.ok(hrefCand.value.length <= 180);
  assert.ok(hrefCand.value.endsWith(".mp4"), "truncation must keep extension");
  assert.equal(JSON.stringify(cands).includes("SIGNED"), false);
});

test("collectFilenameCandidates returns a fresh array each call", () => {
  const api = loadContent();
  const doc = makeDocument({ title: "A", bodyChildren: [] });
  const a = api.collectFilenameCandidates(doc, { href: "https://x.test/p" }, "");
  const b = api.collectFilenameCandidates(doc, { href: "https://x.test/p" }, "");
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------
// createDocumentNonce
// ---------------------------------------------------------------------------

test("createDocumentNonce prefers randomUUID and never uses Math.random", () => {
  const api = loadContent();
  assert.equal(contentSrc.includes("Math.random"), false);

  const nonce = api.createDocumentNonce(
    { randomUUID: () => "uuid-abc-123" },
    () => 12345
  );
  assert.equal(nonce, "uuid-abc-123");
  assert.equal(typeof nonce, "string");
  assert.ok(nonce.length > 0);
});

test("createDocumentNonce falls back to getRandomValues plus time", () => {
  const api = loadContent();
  const nonce = api.createDocumentNonce(
    {
      getRandomValues(arr) {
        for (let i = 0; i < arr.length; i++) arr[i] = (i * 17 + 3) & 0xff;
        return arr;
      },
    },
    () => 999001
  );
  assert.equal(typeof nonce, "string");
  assert.ok(nonce.length > 8);
  assert.ok(nonce.includes("999001") || /[0-9a-f]{8,}/i.test(nonce));
});

test("createDocumentNonce does not throw without crypto", () => {
  const api = loadContent();
  const nonce = api.createDocumentNonce(null, () => 42);
  assert.equal(typeof nonce, "string");
  assert.ok(nonce.length > 0);
});

test("createDocumentNonce fallback avoids identical values across immediate calls", () => {
  const api = loadContent();
  const a = api.createDocumentNonce(null, () => 777001);
  const b = api.createDocumentNonce(null, () => 777001);
  assert.equal(typeof a, "string");
  assert.equal(typeof b, "string");
  assert.ok(a.length > 0 && b.length > 0);
  assert.notEqual(a, b);
  // Still no Math.random / page identity sources in the module source.
  assert.equal(contentSrc.includes("Math.random"), false);
  assert.equal(/document\.cookie|location\.href.*nonce|nonce.*location\.href/.test(contentSrc), false);
});

// ---------------------------------------------------------------------------
// buildPageSnapshot
// ---------------------------------------------------------------------------

test("buildPageSnapshot returns exact frozen shape with null documentId", () => {
  const api = loadContent();
  const doc = makeDocument({
    title: "Page T",
    bodyChildren: [el("h1", { textContent: "H" })],
  });
  const snap = api.buildPageSnapshot(
    {
      documentId: null,
      documentNonce: "nonce-1",
      tabId: 7,
      frameId: 0,
      pageUrl: "https://example.com/a",
      topLevelPageUrl: "https://example.com/a",
    },
    {
      document: doc,
      location: { href: "https://example.com/a" },
      referrer: "",
      now: () => Date.parse("2026-08-12T12:00:00.000Z"),
    }
  );

  assertDeepFrozen(snap);
  assert.deepEqual(Object.keys(snap).sort(), [
    "capturedAt",
    "candidates",
    "documentId",
    "documentNonce",
    "frameId",
    "pageUrl",
    "tabId",
    "topLevelPageUrl",
    "type",
  ].sort());
  assert.equal(snap.type, "page-snapshot");
  assert.equal(snap.documentId, null);
  assert.equal(snap.documentNonce, "nonce-1");
  assert.equal(snap.tabId, 7);
  assert.equal(snap.frameId, 0);
  assert.equal(snap.pageUrl, "https://example.com/a");
  assert.equal(snap.topLevelPageUrl, "https://example.com/a");
  assert.equal(snap.capturedAt, "2026-08-12T12:00:00.000Z");
  assert.ok(Array.isArray(snap.candidates));
  assert.ok(snap.candidates.some((c) => c.kind === "document-title"));
});

test("buildPageSnapshot accepts string documentId and rejects hostile context", () => {
  const api = loadContent();
  const env = {
    document: makeDocument({ title: "T", bodyChildren: [] }),
    location: { href: "https://x.test/" },
    referrer: "",
    now: () => 0,
  };
  const ok = api.buildPageSnapshot(
    {
      documentId: "doc-xyz",
      documentNonce: "n",
      tabId: 1,
      frameId: 2,
      pageUrl: "https://x.test/",
      topLevelPageUrl: "https://top.test/",
    },
    env
  );
  assert.equal(ok.documentId, "doc-xyz");
  assert.equal(ok.topLevelPageUrl, "https://top.test/");

  const leak = "HOSTILE_CONTEXT_LEAK";
  const badCases = [
    { documentNonce: "n", tabId: -1, frameId: 0, pageUrl: "p", topLevelPageUrl: "t" },
    { documentNonce: "n", tabId: 1.5, frameId: 0, pageUrl: "p", topLevelPageUrl: "t" },
    { documentNonce: "n", tabId: 0, frameId: -2, pageUrl: "p", topLevelPageUrl: "t" },
    { documentNonce: "", tabId: 0, frameId: 0, pageUrl: "p", topLevelPageUrl: "t" },
    { documentNonce: "n", tabId: { valueOf: () => 3 }, frameId: 0, pageUrl: "p", topLevelPageUrl: "t" },
    {
      documentNonce: "n",
      tabId: 0,
      frameId: 0,
      pageUrl: { toString: () => leak + "-page" },
      topLevelPageUrl: "t",
    },
    {
      documentNonce: "n",
      tabId: 0,
      frameId: 0,
      pageUrl: "p",
      topLevelPageUrl: { toString: () => leak + "-top" },
    },
    {
      documentId: { toString: () => leak + "-doc" },
      documentNonce: "n",
      tabId: 0,
      frameId: 0,
      pageUrl: "p",
      topLevelPageUrl: "t",
    },
    {
      documentNonce: { toString: () => leak + "-nonce" },
      tabId: 0,
      frameId: 0,
      pageUrl: "p",
      topLevelPageUrl: "t",
    },
  ];
  for (const ctx of badCases) {
    assert.throws(
      () => api.buildPageSnapshot(ctx, env),
      (err) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, "invalid snapshot context");
        assert.equal(String(err.message).includes(leak), false);
        assert.equal(String(err.stack || "").includes(leak), false);
        return true;
      }
    );
  }
});

// ---------------------------------------------------------------------------
// install / handshake
// ---------------------------------------------------------------------------

function makeInstallRoot(opts) {
  opts = opts || {};
  const messages = [];
  const listeners = [];
  let contextHandler = opts.contextHandler || (() => ({
    ok: true,
    tabId: 11,
    frameId: 0,
    documentId: null,
    topLevelPageUrl: opts.topLevelPageUrl || "https://florenfile.com/qnzjnabo3jec/11238-makemebi.net.mp4.html",
  }));

  const video = el("video", {
    // currentSrc/src via properties used by scan
  });
  video.currentSrc = opts.mediaUrl || "https://cdn.example/video.mp4";
  video.src = video.currentSrc;
  video.readyState = 0;
  video.videoWidth = 0;
  video.videoHeight = 0;
  video.paused = true;
  video.ended = false;
  video.querySelectorAll = function (sel) {
    return collectMatching(video, sel);
  };

  const doc = makeDocument({
    title: opts.title || "Florenfile.com - Secure Cloud Storage",
    headChildren: opts.headChildren || [],
    bodyChildren: (opts.bodyChildren || []).concat([video]),
    referrer: opts.referrer || "https://florenfile.com/qnzjnabo3jec/11238-makemebi.net.mp4.html",
  });

  const location = {
    href: opts.href || "https://florenfile.com/qnzjnabo3jec/11238-makemebi.net.mp4.html",
    hostname: "florenfile.com",
    pathname: "/qnzjnabo3jec/11238-makemebi.net.mp4.html",
    search: "",
    origin: "https://florenfile.com",
  };

  const timers = [];
  const root = {
    document: doc,
    location,
    window: null,
    self: null,
    MutationObserver: class {
      constructor(cb) { this.cb = cb; root._observers.push(this); }
      observe() { root._observerCount += 1; }
      disconnect() {}
    },
    setInterval(fn, ms) {
      timers.push({ fn, ms, type: "interval" });
      return timers.length;
    },
    setTimeout(fn, ms) {
      timers.push({ fn, ms, type: "timeout" });
      return timers.length;
    },
    clearInterval() {},
    clearTimeout() {},
    addEventListener() { root._domListeners += 1; },
    browser: {
      runtime: {
        sendMessage(msg) {
          messages.push(JSON.parse(JSON.stringify(msg)));
          if (msg && msg.type === "page-snapshot-context") {
            return Promise.resolve(contextHandler(msg));
          }
          return Promise.resolve(undefined);
        },
        onMessage: {
          addListener(fn) { listeners.push(fn); },
        },
      },
    },
    _messages: messages,
    _listeners: listeners,
    _timers: timers,
    _observers: [],
    _observerCount: 0,
    _domListeners: 0,
    _setContextHandler(fn) { contextHandler = fn; },
  };
  root.window = root;
  root.self = root;
  root.top = root;
  // content script uses window !== window.top checks via root when install binds them
  Object.defineProperty(root, "window", {
    configurable: true,
    get() { return root; },
  });
  return root;
}

test("install requests context then sends exact page-snapshot before content-media with snapshot", async () => {
  const api = loadContent();
  const root = makeInstallRoot();
  api.install(root);

  // allow promise microtasks from install handshake + scan
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const types = root._messages.map((m) => m.type);
  const ctxIdx = types.indexOf("page-snapshot-context");
  const snapIdx = types.indexOf("page-snapshot");
  const mediaIdx = types.indexOf("content-media");
  assert.ok(ctxIdx >= 0, "must request page-snapshot-context");
  assert.ok(snapIdx > ctxIdx, "snapshot after context request");
  assert.ok(mediaIdx > snapIdx, "content-media after snapshot");

  const ctx = root._messages[ctxIdx];
  assert.equal(typeof ctx.documentNonce, "string");
  assert.ok(ctx.documentNonce.length > 0);
  assert.equal(ctx.pageUrl, root.location.href);

  const snap = root._messages[snapIdx];
  assert.equal(snap.type, "page-snapshot");
  assert.equal(snap.tabId, 11);
  assert.equal(snap.frameId, 0);
  assert.equal(snap.documentId, null);
  assert.equal(snap.documentNonce, ctx.documentNonce);
  assert.equal(snap.pageUrl, root.location.href);
  assert.equal(
    snap.topLevelPageUrl,
    "https://florenfile.com/qnzjnabo3jec/11238-makemebi.net.mp4.html"
  );
  assert.ok(Array.isArray(snap.candidates));
  const pageCand = snap.candidates.find((c) => c.kind === "page-url");
  assert.equal(pageCand.value, "/qnzjnabo3jec/11238-makemebi.net.mp4.html");
  assert.equal(typeof snap.capturedAt, "string");
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(snap.capturedAt));

  const media = root._messages[mediaIdx];
  assert.equal(media.type, "content-media");
  assert.ok(media.item);
  assert.equal(media.item.url, "https://cdn.example/video.mp4");
  assert.ok(media.snapshot);
  assert.equal(media.snapshot.documentNonce, snap.documentNonce);
  assert.equal(media.snapshot.tabId, 11);
  assert.equal(typeof media.referrerUrl, "string");
  assert.equal(typeof media.frameOrigin, "string");
  assert.equal(media.frameOrigin, "https://florenfile.com");

  // page-info is display-only and does not invent snapshot identity
  const pageInfo = root._messages.find((m) => m.type === "page-info");
  assert.ok(pageInfo);
  assert.equal(pageInfo.snapshot, undefined);
  assert.equal(pageInfo.tabId, undefined);
});

test("sender context failure never fabricates tab/document ids on media report", async () => {
  const api = loadContent();
  const root = makeInstallRoot({
    contextHandler: () => Promise.reject(new Error("no receiver")),
  });
  // Also handle thrown / falsy responses
  root.browser.runtime.sendMessage = function (msg) {
    root._messages.push(JSON.parse(JSON.stringify(msg)));
    if (msg && msg.type === "page-snapshot-context") {
      return Promise.resolve({ ok: false });
    }
    return Promise.resolve(undefined);
  };
  api.install(root);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(root._messages.some((m) => m.type === "page-snapshot"), false);
  const media = root._messages.filter((m) => m.type === "content-media");
  assert.ok(media.length >= 1);
  for (const m of media) {
    assert.equal(m.snapshot, undefined);
    assert.equal(m.item.tabId, undefined);
    assert.equal(m.documentId, undefined);
  }
  const blob = JSON.stringify(root._messages);
  // no invented correlation fields on failure path
  assert.equal(/"tabId"\s*:\s*\d+/.test(blob) && root._messages.some((m) => m.type === "page-snapshot"), false);
});

test("SPA url change resets media dedupe and re-requests context; identical snapshot not resent", async () => {
  const api = loadContent();
  let topUrl = "https://site.example/page-a";
  const root = makeInstallRoot({
    href: topUrl,
    mediaUrl: "https://cdn.example/a.mp4",
    topLevelPageUrl: topUrl,
    contextHandler: (msg) => ({
      ok: true,
      tabId: 3,
      frameId: 0,
      documentId: null,
      topLevelPageUrl: topUrl,
    }),
  });
  root.location.hostname = "site.example";
  root.location.pathname = "/page-a";
  root.location.origin = "https://site.example";

  api.install(root);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const snaps1 = root._messages.filter((m) => m.type === "page-snapshot");
  assert.equal(snaps1.length, 1);
  const media1 = root._messages.filter((m) => m.type === "content-media");
  assert.ok(media1.some((m) => m.item && m.item.url === "https://cdn.example/a.mp4"));

  // Force periodic refresh path: identical candidates should not spam snapshots
  const before = root._messages.length;
  const interval = root._timers.find((t) => t.type === "interval");
  assert.ok(interval, "periodic refresh timer required");
  await interval.fn();
  await new Promise((r) => setImmediate(r));
  const snapsAfterRefresh = root._messages.filter((m) => m.type === "page-snapshot");
  assert.equal(snapsAfterRefresh.length, 1, "identical snapshot must not be resent");

  // SPA navigation: change URL + media
  topUrl = "https://site.example/page-b";
  root.location.href = topUrl;
  root.location.pathname = "/page-b";
  // same media URL should be reportable again after reset
  const video = root.document.querySelectorAll("video")[0];
  video.currentSrc = "https://cdn.example/a.mp4";
  video.src = video.currentSrc;

  await interval.fn();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const ctxMsgs = root._messages.filter((m) => m.type === "page-snapshot-context");
  assert.ok(ctxMsgs.length >= 2, "SPA refresh re-requests sender context");
  const snaps2 = root._messages.filter((m) => m.type === "page-snapshot");
  assert.ok(snaps2.length >= 2, "new page snapshot after URL change");
  const mediaUrls = root._messages
    .filter((m) => m.type === "content-media")
    .map((m) => m.item.url);
  const countA = mediaUrls.filter((u) => u === "https://cdn.example/a.mp4").length;
  assert.ok(countA >= 2, "SPA reset allows re-reporting media URL");
  assert.ok(before >= 0);
});

test("thumbnail bound and observers remain; source has no cookie/storage/downloads paths", async () => {
  const api = loadContent();
  const root = makeInstallRoot();
  api.install(root);
  await new Promise((r) => setImmediate(r));

  assert.ok(root._observerCount >= 1);
  assert.ok(root._timers.some((t) => t.type === "interval"));
  assert.ok(
    root._domListeners >= 1 || (root.document._access.domListeners || 0) >= 1
  );

  // Source hygiene greps
  assert.equal(/\bcookie\b/i.test(contentSrc), false);
  assert.equal(/localStorage|sessionStorage/.test(contentSrc), false);
  assert.equal(/document\.body/.test(contentSrc), false);
  assert.equal(/innerText|outerHTML/.test(contentSrc), false);
  assert.equal(/downloads\.download|browser\.downloads|chrome\.downloads/.test(contentSrc), false);
  assert.equal(/pget-fallback|requestFirefoxHandoff|use-firefox/.test(contentSrc), false);
  // No arbitrary broad body text sweeps
  assert.equal(/querySelectorAll\(\s*["']\*/.test(contentSrc), false);
  assert.equal(/querySelectorAll\(\s*["']body/.test(contentSrc), false);
  // Candidate selector must stay exact
  assert.match(
    contentSrc,
    /\[download\],\s*\[data-filename\],\s*\.filename,\s*\.file-name,\s*a\[href\$="\.mp4"\]/
  );
});

test("browser path self-installs without CommonJS and does not set a persistent global API map entry", () => {
  const messages = [];
  const sandbox = {
    console,
    setImmediate,
    clearImmediate,
    setTimeout,
    clearTimeout,
    setInterval() { return 1; },
    clearInterval() {},
    Uint8Array,
    Date,
    JSON,
    Error,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Math,
    Promise,
    URL,
    URLSearchParams,
    RegExp,
  };
  const root = makeInstallRoot();
  // Re-bind sendMessage into sandbox browser
  sandbox.self = root;
  sandbox.window = root;
  sandbox.document = root.document;
  sandbox.location = root.location;
  sandbox.browser = root.browser;
  sandbox.MutationObserver = root.MutationObserver;
  sandbox.chrome = undefined;
  sandbox.module = undefined;
  sandbox.exports = undefined;
  sandbox.require = undefined;

  // track that install sends context
  vm.runInNewContext(contentSrc, sandbox, { filename: contentPath });
  // install is async; just ensure no Mc* global leaked for content helpers
  assert.equal(root.McContentSnapshot, undefined);
  assert.equal(sandbox.McContentSnapshot, undefined);
  assert.equal(typeof sandbox.module, "undefined");
});

// ---------------------------------------------------------------------------
// Fix1 regressions: hostile getters, plain context, fingerprint, unbound retry
// ---------------------------------------------------------------------------

function flushMicrotasks(times) {
  times = times == null ? 4 : times;
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) {
    p = p.then(() => new Promise((r) => setImmediate(r)));
  }
  return p;
}

test("hostile DOM getters and proxies fail closed without secret reflection", () => {
  const api = loadContent();
  const secrets = [
    "SECRET_META",
    "SECRET_HEADING",
    "SECRET_FILENAME",
    "SECRET_MEDIA",
  ];
  let coercionHits = 0;

  function trap(label) {
    return {
      get content() {
        throw new Error(label);
      },
      get textContent() {
        throw new Error(label);
      },
      get title() {
        throw new Error(label);
      },
      get parent() {
        throw new Error(label);
      },
      getAttribute(name) {
        if (name === "content" || name === "title" || name === "download" ||
            name === "data-filename" || name === "href" || name === "aria-label") {
          throw new Error(label);
        }
        return null;
      },
      closest() {
        throw new Error(label);
      },
    };
  }

  function proxyReflect(label) {
    return new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "toString" || prop === "valueOf" || prop === Symbol.toPrimitive) {
            coercionHits += 1;
            return () => {
              coercionHits += 1;
              return label + "-coerced";
            };
          }
          throw new Error(label);
        },
        getOwnPropertyDescriptor() {
          throw new Error(label);
        },
        ownKeys() {
          throw new Error(label);
        },
      }
    );
  }

  const metaTrap = trap("SECRET_META");
  const headingTrap = trap("SECRET_HEADING");
  const filenameTrap = trap("SECRET_FILENAME");
  filenameTrap.tagName = "A";
  filenameTrap.className = "filename";
  const mediaTrap = trap("SECRET_MEDIA");
  mediaTrap.tagName = "VIDEO";

  const doc = {
    title: "Safe Title",
    querySelector(sel) {
      if (String(sel).includes("og:title")) return metaTrap;
      if (String(sel).includes("twitter:title")) return proxyReflect("SECRET_META");
      return null;
    },
    querySelectorAll(sel) {
      const s = String(sel);
      if (s.includes("h1") || s.includes("h2")) return [headingTrap, proxyReflect("SECRET_HEADING")];
      if (s.includes("download") || s.includes("filename") || s.includes("href$")) {
        return [filenameTrap, proxyReflect("SECRET_FILENAME")];
      }
      if (s.includes("video, audio, source") || s === "video,audio,source") {
        return [mediaTrap, proxyReflect("SECRET_MEDIA")];
      }
      if (s.includes("video, audio") || s === "video,audio") {
        return [mediaTrap];
      }
      return [];
    },
  };

  let cands;
  assert.doesNotThrow(() => {
    cands = api.collectFilenameCandidates(
      doc,
      { href: "https://safe.example/path/ok.mp4.html?sig=SIGNED" },
      "https://ref.example/r"
    );
  });

  const blob = JSON.stringify(cands);
  for (const s of secrets) {
    assert.equal(blob.includes(s), false, "must not serialize " + s);
  }
  assert.equal(blob.includes("coerced"), false);
  assert.equal(blob.includes("SIGNED"), false);
  assert.equal(coercionHits, 0, "must not invoke toString/valueOf/toPrimitive");

  assert.ok(cands.some((c) => c.kind === "document-title" && c.value === "Safe Title"));
  assert.ok(cands.some((c) => c.kind === "page-url" && c.value === "/path/ok.mp4.html"));
  assert.equal(cands.some((c) => c.kind === "og-title"), false);
  assert.equal(cands.some((c) => c.kind === "twitter-title"), false);
  assert.equal(cands.some((c) => c.kind === "heading"), false);
  assert.equal(cands.some((c) => c.kind === "download-attr"), false);
  assert.equal(cands.some((c) => c.kind === "visible-filename"), false);
  assert.equal(cands.some((c) => c.kind === "media-metadata"), false);

  // Ordinary DOM still works.
  const normal = makeDocument({
    title: "Normal",
    headChildren: [
      el("meta", {
        attributes: { property: "og:title", content: "OG Normal" },
        content: "OG Normal",
      }),
    ],
    bodyChildren: [
      el("h1", { textContent: "H1 Normal" }),
      el("a", { className: "filename", textContent: "clip.mp4" }),
    ],
  });
  const normalCands = api.collectFilenameCandidates(
    normal,
    { href: "https://x.test/p" },
    ""
  );
  assert.ok(normalCands.some((c) => c.kind === "og-title" && c.value === "OG Normal"));
  assert.ok(normalCands.some((c) => c.kind === "heading" && c.value === "H1 Normal"));
  assert.ok(normalCands.some((c) => c.kind === "visible-filename" && c.value === "clip.mp4"));
});

test("buildPageSnapshot rejects accessor/proxy/blank/control context with stable TypeError", () => {
  const api = loadContent();
  const env = {
    document: makeDocument({ title: "T", bodyChildren: [] }),
    location: { href: "https://x.test/" },
    referrer: "",
    now: () => 0,
  };

  const keys = [
    "documentNonce",
    "tabId",
    "frameId",
    "pageUrl",
    "topLevelPageUrl",
    "documentId",
  ];

  for (const key of keys) {
    const base = {
      documentNonce: "nonce-ok",
      tabId: 1,
      frameId: 0,
      pageUrl: "https://x.test/",
      topLevelPageUrl: "https://top.test/",
      documentId: null,
    };
    Object.defineProperty(base, key, {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error("SECRET_" + key);
      },
    });
    assert.throws(
      () => api.buildPageSnapshot(base, env),
      (err) => {
        assert.ok(err instanceof TypeError, key + " must throw TypeError");
        assert.equal(err.message, "invalid snapshot context");
        assert.equal(String(err.message).includes("SECRET_"), false);
        assert.equal(String(err.stack || "").includes("SECRET_"), false);
        return true;
      }
    );
  }

  const proxy = new Proxy(
    {
      documentNonce: "nonce-ok",
      tabId: 1,
      frameId: 0,
      pageUrl: "https://x.test/",
      topLevelPageUrl: "https://top.test/",
    },
    {
      getOwnPropertyDescriptor() {
        throw new Error("SECRET_proxy_desc");
      },
      get(_t, prop) {
        throw new Error("SECRET_proxy_" + String(prop));
      },
    }
  );
  assert.throws(
    () => api.buildPageSnapshot(proxy, env),
    (err) => {
      assert.ok(err instanceof TypeError);
      assert.equal(err.message, "invalid snapshot context");
      assert.equal(String(err.message).includes("SECRET_"), false);
      assert.equal(String(err.stack || "").includes("SECRET_"), false);
      return true;
    }
  );

  const blankControlNonces = ["", "   ", "\t", "\n", "a\u0001b", "\u0000uuid", "  uuid-ok  "];
  for (const nonce of blankControlNonces) {
    assert.throws(
      () =>
        api.buildPageSnapshot(
          {
            documentNonce: nonce,
            tabId: 0,
            frameId: 0,
            pageUrl: "p",
            topLevelPageUrl: "t",
          },
          env
        ),
      (err) => {
        assert.ok(err instanceof TypeError);
        assert.equal(err.message, "invalid snapshot context");
        return true;
      }
    );
  }

  // createDocumentNonce must not accept whitespace/control randomUUID output.
  const badUuid = api.createDocumentNonce(
    { randomUUID: () => "  not-a-safe-nonce  " },
    () => 1
  );
  assert.notEqual(badUuid, "  not-a-safe-nonce  ");
  assert.equal(typeof badUuid, "string");
  assert.ok(badUuid.length > 0);
  assert.equal(/[\u0000-\u001f\u007f]/.test(badUuid), false);
  assert.equal(/^\s|\s$/.test(badUuid), false);

  const ctrlUuid = api.createDocumentNonce(
    { randomUUID: () => "uuid\u0001bad" },
    () => 2
  );
  assert.notEqual(ctrlUuid, "uuid\u0001bad");
  assert.equal(/[\u0000-\u001f\u007f]/.test(ctrlUuid), false);

  // Valid plain data-property context still works.
  const ok = api.buildPageSnapshot(
    {
      documentNonce: "nonce-ok",
      tabId: 2,
      frameId: 3,
      pageUrl: "https://x.test/a",
      topLevelPageUrl: "https://top.test/a",
      documentId: "doc-1",
    },
    env
  );
  assert.equal(ok.documentNonce, "nonce-ok");
  assert.equal(ok.documentId, "doc-1");
  assert.equal(ok.tabId, 2);
  assert.equal(ok.frameId, 3);
});

test("topLevelPageUrl identity change resends one snapshot then suppresses identical", async () => {
  const api = loadContent();
  let topUrl = "https://top.example/outer-a";
  const frameHref = "https://frame.example/embed/player";
  const root = makeInstallRoot({
    href: frameHref,
    mediaUrl: "https://cdn.example/embed.mp4",
    topLevelPageUrl: topUrl,
    title: "Embed Title",
    contextHandler: () => ({
      ok: true,
      tabId: 9,
      frameId: 2,
      documentId: "frame-doc",
      topLevelPageUrl: topUrl,
    }),
  });
  root.location.hostname = "frame.example";
  root.location.pathname = "/embed/player";
  root.location.origin = "https://frame.example";
  // Cross-origin iframe: window !== top so topLevelPageUrl is sender-authoritative.
  const otherTop = { name: "top-window" };
  Object.defineProperty(root, "top", {
    configurable: true,
    get() {
      return otherTop;
    },
  });

  api.install(root);
  await flushMicrotasks();

  let snaps = root._messages.filter((m) => m.type === "page-snapshot");
  assert.equal(snaps.length, 1, "initial snapshot once");
  assert.equal(snaps[0].pageUrl, frameHref);
  assert.equal(snaps[0].topLevelPageUrl, "https://top.example/outer-a");
  assert.equal(snaps[0].documentId, "frame-doc");
  assert.equal(snaps[0].frameId, 2);

  topUrl = "https://top.example/outer-b";
  const interval = root._timers.find((t) => t.type === "interval");
  assert.ok(interval);
  await interval.fn();
  await flushMicrotasks();

  snaps = root._messages.filter((m) => m.type === "page-snapshot");
  assert.equal(
    snaps.length,
    2,
    "topLevelPageUrl change must refresh snapshot exactly once"
  );
  assert.equal(snaps[1].pageUrl, frameHref);
  assert.equal(snaps[1].topLevelPageUrl, "https://top.example/outer-b");
  assert.equal(snaps[1].documentId, "frame-doc");

  await interval.fn();
  await flushMicrotasks();
  snaps = root._messages.filter((m) => m.type === "page-snapshot");
  assert.equal(snaps.length, 2, "identical subsequent context must stay suppressed");
});

test("unbound content-media is retried once after context success then deduped", async () => {
  const api = loadContent();
  let allowContext = false;
  const mediaUrl = "https://cdn.example/retry-me.mp4";
  const top = "https://site.example/watch";
  const root = makeInstallRoot({
    href: top,
    mediaUrl,
    topLevelPageUrl: top,
    contextHandler: () => {
      if (!allowContext) return { ok: false };
      return {
        ok: true,
        tabId: 4,
        frameId: 0,
        documentId: null,
        topLevelPageUrl: top,
      };
    },
  });
  root.location.hostname = "site.example";
  root.location.pathname = "/watch";
  root.location.origin = "https://site.example";

  api.install(root);
  await flushMicrotasks();

  let media = root._messages.filter((m) => m.type === "content-media");
  assert.equal(media.length, 1, "exactly one unbound media on context failure");
  assert.equal(media[0].item.url, mediaUrl);
  assert.equal(media[0].snapshot, undefined);
  assert.equal(root._messages.some((m) => m.type === "page-snapshot"), false);

  allowContext = true;
  const interval = root._timers.find((t) => t.type === "interval");
  assert.ok(interval);
  await interval.fn();
  await flushMicrotasks();

  media = root._messages.filter((m) => m.type === "content-media");
  assert.equal(media.length, 2, "exactly one snapshot-bound retry");
  assert.equal(media[1].item.url, mediaUrl);
  assert.ok(media[1].snapshot, "retry must include snapshot");
  assert.equal(media[1].snapshot.tabId, 4);
  assert.equal(media[1].snapshot.pageUrl, top);
  assert.ok(root._messages.some((m) => m.type === "page-snapshot"));

  await interval.fn();
  await flushMicrotasks();
  // MutationObserver scan path must also not triple-report.
  const obs = root._observers[0];
  if (obs && obs.cb) {
    obs.cb([]);
    await flushMicrotasks();
  }
  media = root._messages.filter((m) => m.type === "content-media");
  assert.equal(media.length, 2, "no third duplicate after bound");

  // Concurrent-ish double scan after bind still one bound total.
  if (obs && obs.cb) {
    obs.cb([]);
    obs.cb([]);
    await flushMicrotasks();
  }
  media = root._messages.filter((m) => m.type === "content-media");
  assert.equal(media.length, 2);

  // SPA URL change resets retry state so media can be reported again.
  root.location.href = "https://site.example/watch-2";
  root.location.pathname = "/watch-2";
  await interval.fn();
  await flushMicrotasks();
  media = root._messages.filter((m) => m.type === "content-media");
  assert.ok(
    media.filter((m) => m.item.url === mediaUrl).length >= 3,
    "SPA reset allows re-report"
  );
});

// ---------------------------------------------------------------------------
// Fix2 regressions: YouTube context retry, thumb SPA reset, tick scan, no-doc
// ---------------------------------------------------------------------------

function makeYouTubeInstallRoot(opts) {
  opts = opts || {};
  const videoId = opts.videoId || "dQw4w9WgXcQ";
  const ytUrl = "https://www.youtube.com/watch?v=" + videoId;
  const root = makeInstallRoot({
    href: ytUrl,
    // blob media is skipped so YouTube is the only content-media signal
    mediaUrl: opts.mediaUrl || "blob:https://www.youtube.com/ms-xyz",
    topLevelPageUrl: ytUrl,
    title: opts.title || "Sample Clip - YouTube",
    contextHandler: opts.contextHandler,
  });
  root.location.hostname = "www.youtube.com";
  root.location.pathname = "/watch";
  root.location.search = "?v=" + videoId;
  root.location.origin = "https://www.youtube.com";
  root._ytVideoId = videoId;
  root._ytUrl = ytUrl;
  return root;
}

function youtubeMediaMessages(root) {
  return root._messages.filter(
    (m) => m.type === "content-media" && m.item && m.item.kind === "youtube"
  );
}

test("YouTube context failure then success: one unbound, one bound retry; ticks/scans do not duplicate", async () => {
  const api = loadContent();
  let allowContext = false;
  const videoId = "dQw4w9WgXcQ";
  const ytUrl = "https://www.youtube.com/watch?v=" + videoId;
  const root = makeYouTubeInstallRoot({
    videoId,
    contextHandler: () => {
      if (!allowContext) return { ok: false };
      return {
        ok: true,
        tabId: 5,
        frameId: 0,
        documentId: null,
        topLevelPageUrl: ytUrl,
      };
    },
  });

  api.install(root);
  await flushMicrotasks();

  let yt = youtubeMediaMessages(root);
  assert.equal(yt.length, 1, "exactly one unbound YouTube on context failure");
  assert.equal(yt[0].item.videoId, videoId);
  assert.equal(yt[0].item.url, ytUrl);
  assert.equal(yt[0].snapshot, undefined);
  assert.equal(root._messages.some((m) => m.type === "page-snapshot"), false);

  const interval = root._timers.find((t) => t.type === "interval");
  assert.ok(interval, "12s refresh timer required");

  // Repeat tick while still unbound: must not re-emit.
  await interval.fn();
  await flushMicrotasks();
  yt = youtubeMediaMessages(root);
  assert.equal(yt.length, 1, "repeat tick must not duplicate unbound YouTube");

  // Concurrent mutation-driven scan while still unbound.
  const obs = root._observers[0];
  if (obs && obs.cb) {
    obs.cb([]);
    obs.cb([]);
    await flushMicrotasks();
  }
  yt = youtubeMediaMessages(root);
  assert.equal(yt.length, 1, "repeat scan must not duplicate unbound YouTube");

  // Context becomes available: exactly one bound retry with a fresh snapshot copy.
  allowContext = true;
  await interval.fn();
  await flushMicrotasks();

  yt = youtubeMediaMessages(root);
  assert.equal(yt.length, 2, "exactly one snapshot-bound YouTube retry");
  assert.equal(yt[1].item.videoId, videoId);
  assert.equal(yt[1].item.url, ytUrl);
  assert.ok(yt[1].snapshot, "bound retry must include snapshot");
  assert.equal(yt[1].snapshot.tabId, 5);
  assert.equal(yt[1].snapshot.pageUrl, ytUrl);
  assert.ok(root._messages.some((m) => m.type === "page-snapshot"));

  // Bound dedupe across further ticks and scans.
  await interval.fn();
  await flushMicrotasks();
  if (obs && obs.cb) {
    obs.cb([]);
    obs.cb([]);
    await flushMicrotasks();
  }
  yt = youtubeMediaMessages(root);
  assert.equal(yt.length, 2, "no third YouTube after bound");
});

test("YouTube SPA navigation to a new video id re-reports after prior bind", async () => {
  const api = loadContent();
  let topUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  const root = makeYouTubeInstallRoot({
    videoId: "dQw4w9WgXcQ",
    contextHandler: () => ({
      ok: true,
      tabId: 6,
      frameId: 0,
      documentId: null,
      topLevelPageUrl: topUrl,
    }),
  });

  api.install(root);
  await flushMicrotasks();

  let yt = youtubeMediaMessages(root);
  assert.equal(yt.length, 1, "initial YouTube bound once");
  assert.equal(yt[0].item.videoId, "dQw4w9WgXcQ");
  assert.ok(yt[0].snapshot);

  // Same video on subsequent ticks stays deduped.
  const interval = root._timers.find((t) => t.type === "interval");
  assert.ok(interval);
  await interval.fn();
  await flushMicrotasks();
  yt = youtubeMediaMessages(root);
  assert.equal(yt.length, 1, "same YouTube id remains one item");

  // SPA to a new video id must re-arm reporting (one item per video id).
  const videoId2 = "oHg5SJYRHA0";
  topUrl = "https://www.youtube.com/watch?v=" + videoId2;
  root.location.href = topUrl;
  root.location.pathname = "/watch";
  root.location.search = "?v=" + videoId2;

  await interval.fn();
  await flushMicrotasks();

  yt = youtubeMediaMessages(root);
  const ids = yt.map((m) => m.item.videoId);
  assert.ok(ids.includes("dQw4w9WgXcQ"));
  assert.ok(ids.includes(videoId2), "new SPA video id must emit");
  assert.equal(
    yt.filter((m) => m.item.videoId === videoId2).length,
    1,
    "exactly one message for the new YouTube id"
  );
  const second = yt.find((m) => m.item.videoId === videoId2);
  assert.ok(second.snapshot, "new YouTube id should be snapshot-bound");

  await interval.fn();
  await flushMicrotasks();
  yt = youtubeMediaMessages(root);
  assert.equal(
    yt.filter((m) => m.item.videoId === videoId2).length,
    1,
    "new YouTube id stays deduped after bind"
  );
});

test("install without document does not throw on thumb/tick/scan paths", async () => {
  const api = loadContent();
  const messages = [];
  const timers = [];
  const root = {
    // intentionally no document — documentRef is null in Node
    location: {
      href: "https://x.test/page",
      hostname: "x.test",
      pathname: "/page",
      search: "",
      origin: "https://x.test",
    },
    MutationObserver: class {
      constructor() {}
      observe() {}
      disconnect() {}
    },
    setInterval(fn, ms) {
      timers.push({ fn, ms, type: "interval" });
      return timers.length;
    },
    setTimeout(fn, ms) {
      timers.push({ fn, ms, type: "timeout" });
      return timers.length;
    },
    clearInterval() {},
    clearTimeout() {},
    addEventListener() {},
    browser: {
      runtime: {
        sendMessage(msg) {
          messages.push(JSON.parse(JSON.stringify(msg)));
          if (msg && msg.type === "page-snapshot-context") {
            return Promise.resolve({
              ok: true,
              tabId: 1,
              frameId: 0,
              documentId: null,
              topLevelPageUrl: "https://x.test/page",
            });
          }
          return Promise.resolve(undefined);
        },
        onMessage: { addListener() {} },
      },
    },
    _messages: messages,
    _timers: timers,
  };
  root.window = root;
  root.self = root;
  root.top = root;

  assert.doesNotThrow(() => {
    api.install(root);
  });
  await flushMicrotasks();

  const interval = timers.find((t) => t.type === "interval");
  assert.ok(interval, "timer still registered without document");
  await assert.doesNotReject(async () => {
    await interval.fn();
    await flushMicrotasks();
  });
  // No uncaught path; thumb/scan simply no-op without a document.
  assert.equal(
    messages.some((m) => m.type === "content-thumb"),
    false
  );
});

test("SPA navigation clears thumbnail dedupe so identical-looking thumb may re-emit", async () => {
  const api = loadContent();
  const fakeDataUrl = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAg";
  const root = makeInstallRoot({
    href: "https://site.example/page-a",
    mediaUrl: "https://cdn.example/a.mp4",
    topLevelPageUrl: "https://site.example/page-a",
  });
  root.location.hostname = "site.example";
  root.location.pathname = "/page-a";
  root.location.origin = "https://site.example";

  const video = root.document.querySelectorAll("video")[0];
  video.readyState = 2;
  video.videoWidth = 320;
  video.videoHeight = 180;
  video.ended = false;

  root.document.createElement = function (tag) {
    if (String(tag).toLowerCase() === "canvas") {
      return {
        width: 0,
        height: 0,
        getContext() {
          return { drawImage() {} };
        },
        toDataURL() {
          return fakeDataUrl;
        },
      };
    }
    return el(tag, {});
  };

  api.install(root);
  await flushMicrotasks();

  const interval = root._timers.find((t) => t.type === "interval");
  assert.ok(interval);
  await interval.fn();
  await flushMicrotasks();

  let thumbs = root._messages.filter((m) => m.type === "content-thumb");
  assert.equal(thumbs.length, 1, "first thumb emit");
  assert.equal(thumbs[0].dataUrl, fakeDataUrl);

  // Same page + same bytes: dedupe holds.
  await interval.fn();
  await flushMicrotasks();
  thumbs = root._messages.filter((m) => m.type === "content-thumb");
  assert.equal(thumbs.length, 1, "identical thumb suppressed on same page");

  // SPA to a new page: lastThumbSent must clear so the same-looking frame can emit.
  root.location.href = "https://site.example/page-b";
  root.location.pathname = "/page-b";
  await interval.fn();
  await flushMicrotasks();

  thumbs = root._messages.filter((m) => m.type === "content-thumb");
  assert.equal(
    thumbs.length,
    2,
    "SPA must allow re-emitting an identical-looking thumbnail"
  );
  assert.equal(thumbs[1].dataUrl, fakeDataUrl);
});

test("periodic tick scan detects currentSrc change without mutation or loadstart", async () => {
  const api = loadContent();
  const root = makeInstallRoot({
    href: "https://site.example/player",
    mediaUrl: "https://cdn.example/first.mp4",
    topLevelPageUrl: "https://site.example/player",
  });
  root.location.hostname = "site.example";
  root.location.pathname = "/player";
  root.location.origin = "https://site.example";

  api.install(root);
  await flushMicrotasks();

  let media = root._messages.filter((m) => m.type === "content-media");
  assert.ok(
    media.some((m) => m.item && m.item.url === "https://cdn.example/first.mp4"),
    "initial media reported"
  );

  // Quietly swap currentSrc — no MutationObserver callback, no loadstart.
  const video = root.document.querySelectorAll("video")[0];
  video.currentSrc = "https://cdn.example/second.mp4";
  video.src = "https://cdn.example/second.mp4";

  const interval = root._timers.find((t) => t.type === "interval");
  assert.ok(interval);
  await interval.fn();
  await flushMicrotasks();

  media = root._messages.filter((m) => m.type === "content-media");
  assert.ok(
    media.some((m) => m.item && m.item.url === "https://cdn.example/second.mp4"),
    "tick must scan and report changed currentSrc without mutation/loadstart"
  );
  assert.equal(
    media.filter((m) => m.item && m.item.url === "https://cdn.example/second.mp4").length,
    1,
    "exactly one report for the new source"
  );

  // Existing bound/inflight sets suppress duplicates on the next tick.
  await interval.fn();
  await flushMicrotasks();
  media = root._messages.filter((m) => m.type === "content-media");
  assert.equal(
    media.filter((m) => m.item && m.item.url === "https://cdn.example/second.mp4").length,
    1
  );
  assert.equal(
    media.filter((m) => m.item && m.item.url === "https://cdn.example/first.mp4").length,
    1,
    "original source stays single"
  );
});

test("non-http(s) video srcs are never reported as media", async () => {
  const api = loadContent();
  // A page (or an ad iframe) chooses every src the content script reads. The
  // reporter must forward only absolute http(s) URLs, so a file:// UNC
  // selector never becomes a "direct" row the helper would later open.
  const hostile = [
    "file://////attacker.example/s/x.mp4",
    "file:///C:/Users/x/secret.mp4",
    "ftp://attacker.example/x.mp4",
    "javascript:alert(1)",
    "//attacker.example/s/x.mp4",
  ];
  for (const src of hostile) {
    const root = makeInstallRoot({ mediaUrl: src });
    api.install(root);
    await flushMicrotasks();
    const media = root._messages.filter((m) => m.type === "content-media");
    assert.deepEqual(
      media.map((m) => m.item && m.item.url),
      [],
      src + " must not be reported"
    );
  }

  // The same page shape with an http(s) src still reports, so the filter is
  // not simply suppressing everything.
  const ok = makeInstallRoot({ mediaUrl: "https://cdn.example/video.mp4" });
  api.install(ok);
  await flushMicrotasks();
  assert.deepEqual(
    ok._messages
      .filter((m) => m.type === "content-media")
      .map((m) => m.item.url),
    ["https://cdn.example/video.mp4"]
  );
});

test("only the top frame captures a thumbnail", async () => {
  const api = loadContent();
  const fakeDataUrl = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAg";
  const makeFrame = (topFrame) => {
    const root = makeInstallRoot({
      href: "https://ads.example/unit",
      mediaUrl: "https://cdn.example/ad.mp4",
      topLevelPageUrl: "https://site.example/watch",
    });
    if (!topFrame) root.top = {};
    const video = root.document.querySelectorAll("video")[0];
    video.readyState = 2;
    video.videoWidth = 320;
    video.videoHeight = 180;
    video.ended = false;
    root.document.createElement = function (tag) {
      if (String(tag).toLowerCase() === "canvas") {
        return {
          width: 0,
          height: 0,
          getContext() { return { drawImage() {} }; },
          toDataURL() { return fakeDataUrl; },
        };
      }
      return el(tag, {});
    };
    return root;
  };

  // The background attaches one thumbnail to every media row of the tab, so a
  // subframe that emits one picks the picture shown for the top page's media.
  const sub = makeFrame(false);
  api.install(sub);
  await flushMicrotasks();
  const subInterval = sub._timers.find((t) => t.type === "interval");
  await subInterval.fn();
  await flushMicrotasks();
  assert.deepEqual(
    sub._messages.filter((m) => m.type === "content-thumb"),
    [],
    "a subframe must not emit content-thumb"
  );

  const top = makeFrame(true);
  api.install(top);
  await flushMicrotasks();
  const topInterval = top._timers.find((t) => t.type === "interval");
  await topInterval.fn();
  await flushMicrotasks();
  assert.equal(
    top._messages.filter((m) => m.type === "content-thumb").length,
    1,
    "the top frame still emits its thumbnail"
  );
});
