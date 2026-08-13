"use strict";

/**
 * Direct intent admission through the real adapter, router, scheduler,
 * privacy, and file-sink modules. Injected effects only.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");

const GENERIC = "invalid background adapter input";

const YT_PAGE = "https://www.youtube.com/watch?v=abc";
const YT_SIGNED =
  "https://cdn.youtube.com/v.mp4?X-Amz-Signature=sigyt1&expires=99";
const YT_REFERER = "https://www.youtube.com/watch?v=abc";
const YT_UA = "McCatcherTest/1.0";
const VM_PAGE = "https://vimeo.com/12345";
const VM_SIGNED =
  "https://player.vimeo.com/play/v.mp4?token=sigvm1&exp=88";
const VARIANT_URL = "https://cdn.youtube.com/alt/v-1080.mp4?sig=alt1";
const BASE_URL = "https://cdn.youtube.com/base/v.mp4?sig=base1";
const FUTURE_URL = "https://cdn.youtube.com/future/v.mp4?sig=fut1";

function loadAdapters() {
  return loadLib("lib/background-adapters.js");
}

function makeHarness(overrides) {
  const posted = [];
  const published = [];
  const seq = { media: 0, variant: 0, job: 0, attempt: 0 };
  const counts = {
    postNative: 0,
    isPopupSender: 0,
    getEffectiveDestinationDirectory: 0,
    publishJobs: 0,
    randomToken: 0,
  };
  let popupOk = true;
  let destResult = "E:\\Library";
  const Adapters = loadAdapters();
  const options = {
    maxConcurrent: 2,
    segmentConcurrency: 4,
    retries: 2,
    now() {
      return 1_000_000;
    },
    randomToken(namespace) {
      counts.randomToken += 1;
      if (namespace === "media") {
        seq.media += 1;
        return "m" + seq.media;
      }
      if (namespace === "variant") {
        seq.variant += 1;
        return "v" + seq.variant;
      }
      if (namespace === "job") {
        seq.job += 1;
        return "j" + seq.job;
      }
      seq.attempt += 1;
      return "a" + seq.attempt;
    },
    postNative(command) {
      counts.postNative += 1;
      posted.push(command);
      return command;
    },
    downloadsDownload() {},
    createObjectURL() {
      return "blob:fake";
    },
    revokeObjectURL() {},
    fetchArrayBuffer() {
      return Promise.resolve(new ArrayBuffer(0));
    },
    assembleMedia() {
      return Promise.resolve(null);
    },
    isPopupSender() {
      counts.isPopupSender += 1;
      return popupOk;
    },
    getEffectiveDestinationDirectory() {
      counts.getEffectiveDestinationDirectory += 1;
      return destResult;
    },
    publishDetection() {},
    publishJobs(rows) {
      counts.publishJobs += 1;
      published.push(rows);
    },
    persistHistory() {},
    reportDiagnostic() {},
  };
  Object.assign(options, overrides || {});
  const ctrl = Adapters.createBackgroundAdapters(options);
  return {
    ctrl,
    posted,
    published,
    counts,
    setPopupOk(v) {
      popupOk = v;
    },
    setDest(v) {
      destResult = v;
    },
  };
}

function captureDirect(ctrl, spec) {
  const transport = {
    mediaKind: spec.mediaKind || "direct",
    requestHeaders: null,
  };
  if (spec.referer !== undefined) transport.referer = spec.referer;
  if (spec.userAgent !== undefined) transport.userAgent = spec.userAgent;
  if (spec.mirrors !== undefined) transport.mirrors = spec.mirrors;
  if (spec.futureVariants !== undefined) transport.variants = spec.futureVariants;
  return ctrl.captureDomMedia({
    mediaUrl: spec.url,
    mediaOrigin: spec.origin || new URL(spec.url).origin,
    contentDisposition: null,
    referrerUrl: spec.pageUrl,
    frameOrigin: new URL(spec.pageUrl).origin,
    ts: 1_000_000,
    snapshot: {
      documentId: spec.docId,
      tabId: spec.tabId,
      frameId: 0,
      pageUrl: spec.pageUrl,
      topLevelPageUrl: spec.pageUrl,
      documentNonce: spec.docId + "-n",
      candidates: [{ kind: "visible-filename", value: spec.filename }],
      capturedAt: "2026-08-12T12:00:00.000Z",
    },
    transport,
  });
}

function saveAsIntent(name, dest) {
  return {
    requestedFilename: name,
    destinationDirectory: dest,
    saveMode: "save-as",
    userSelectedFirefox: false,
    userActionToken: "uat-save",
    createdAt: "2026-08-12T12:00:00.000Z",
  };
}

function defaultIntent(name) {
  return {
    requestedFilename: name,
    destinationDirectory: null,
    saveMode: "default",
    userSelectedFirefox: false,
    userActionToken: "uat-def",
    createdAt: "2026-08-12T12:00:00.000Z",
  };
}

function guardedItem(id) {
  const item = {};
  Object.defineProperty(item, "id", { value: id, enumerable: true });
  Object.defineProperty(item, "url", {
    enumerable: true,
    get() {
      throw new Error("caller item url must not run");
    },
  });
  Object.defineProperty(item, "providerKey", {
    enumerable: true,
    get() {
      throw new Error("caller item providerKey must not run");
    },
  });
  return item;
}

function assertDeepFrozen(value, label) {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value), label + " must be frozen");
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertDeepFrozen(value[i], label + "[" + i + "]");
    }
    return;
  }
  for (const k of Object.keys(value)) {
    assertDeepFrozen(value[k], label + "." + k);
  }
}

function assertSafeProjection(row, label) {
  assertDeepFrozen(row, label);
  const raw = JSON.stringify(row);
  assert.equal(raw.includes("X-Amz-Signature"), false, label + " no signed query");
  assert.equal(raw.includes("sigyt1"), false, label + " no yt sig");
  assert.equal(raw.includes("sigvm1"), false, label + " no vm sig");
  assert.equal(raw.includes("sig=alt1"), false, label + " no variant sig");
  assert.equal(raw.includes("cdn.youtube.com"), false, label + " no media host");
  assert.equal(raw.includes("attemptToken"), false, label + " no attemptToken field");
  assert.equal(raw.includes('"url"'), false, label + " no url field");
  assert.equal(raw.includes("referer"), false, label + " no referer field");
  assert.equal(raw.includes("userAgent"), false, label + " no userAgent field");
  assert.equal(raw.includes("Cookie"), false, label + " no Cookie");
  assert.equal(raw.includes("Authorization"), false, label + " no Authorization");
}

async function expectGenericReject(promise) {
  let rejected = null;
  await promise.then(
    () => {
      throw new Error("expected rejection");
    },
    (err) => {
      rejected = err;
    }
  );
  assert.ok(rejected instanceof Error);
  assert.equal(rejected.message, GENERIC);
}

test("Save-As direct admission posts one structured pget", async () => {
  const h = makeHarness();
  const mediaId = captureDirect(h.ctrl, {
    url: YT_SIGNED,
    pageUrl: YT_PAGE,
    tabId: 11,
    docId: "doc-yt",
    filename: "watch.mp4",
    referer: YT_REFERER,
    userAgent: YT_UA,
  });
  assert.equal(mediaId, "media:m1:1");

  const item = guardedItem(mediaId);
  const row = await h.ctrl.enqueueDownload(
    {
      type: "save-as-download",
      tabId: 11,
      item,
      intent: saveAsIntent("edited-name.mp4", "D:\\Vids"),
    },
    { popup: true }
  );

  assert.equal(h.posted.length, 1);
  const cmd = h.posted[0];
  assert.ok(Object.isFrozen(cmd));
  assert.deepEqual(cmd, {
    cmd: "pget",
    id: "job:j1:1",
    attemptToken: "a1#1",
    urls: [YT_SIGNED],
    name: "edited-name.mp4",
    dir: "D:\\Vids",
    maxConnections: 4,
    providerGeneration: 0,
    referer: YT_REFERER,
    userAgent: YT_UA,
  });

  assert.equal(row.id, "job:j1:1");
  assertSafeProjection(row, "enqueue row");
  const jobs = h.ctrl.popupJobs();
  assert.equal(jobs.length, 1);
  assert.notEqual(jobs, h.ctrl.popupJobs());
  assertSafeProjection(jobs, "popupJobs");
  assert.equal(jobs[0].id, "job:j1:1");
  assert.equal(jobs[0].requestedFilename, "edited-name.mp4");
  assert.equal(jobs[0].destinationDirectory, "D:\\Vids");
  assert.equal(jobs[0].providerKey, "youtube.com");
  assert.equal(h.counts.publishJobs, 1);
});

test("hard cap and dynamic raise", async () => {
  const h = makeHarness({ maxConcurrent: 1 });
  const firstId = captureDirect(h.ctrl, {
    url: YT_SIGNED,
    pageUrl: YT_PAGE,
    tabId: 21,
    docId: "doc-yt-cap",
    filename: "one.mp4",
    referer: YT_REFERER,
    userAgent: YT_UA,
  });
  const secondId = captureDirect(h.ctrl, {
    url: VM_SIGNED,
    pageUrl: VM_PAGE,
    tabId: 22,
    docId: "doc-vm-cap",
    filename: "two.mp4",
    referer: VM_PAGE,
    userAgent: YT_UA,
  });

  await h.ctrl.enqueueDownload(
    {
      type: "download",
      tabId: 21,
      item: { id: firstId },
      intent: defaultIntent("one.mp4"),
    },
    {}
  );
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].id, "job:j1:1");
  assert.equal(h.posted[0].dir, "E:\\Library");
  assert.equal(h.counts.getEffectiveDestinationDirectory, 1);

  await h.ctrl.enqueueDownload(
    {
      type: "download",
      tabId: 22,
      item: { id: secondId },
      intent: defaultIntent("two.mp4"),
    },
    {}
  );
  assert.equal(h.posted.length, 1);
  const statesAfterSecond = h.ctrl.popupJobs().map((j) => j.state);
  assert.deepEqual(statesAfterSecond.sort(), ["queued", "running"].sort());

  await h.ctrl.setMaxConcurrent(2);
  assert.equal(h.posted.length, 2);
  assert.notEqual(h.posted[1].id, h.posted[0].id);
  assert.equal(h.posted[1].urls[0], VM_SIGNED);
  assert.equal(h.posted[1].dir, "E:\\Library");
  assert.equal(h.counts.getEffectiveDestinationDirectory, 2);

  await h.ctrl.pump();
  await h.ctrl.pump();
  await h.ctrl.setMaxConcurrent(1);
  assert.equal(h.posted.length, 2);
  const afterLower = h.ctrl.popupJobs();
  assert.equal(afterLower.length, 2);
  assert.equal(
    afterLower.every((j) => j.state === "running"),
    true
  );
});

test("opaque registered variant authority", async () => {
  const h = makeHarness();
  const mediaId = captureDirect(h.ctrl, {
    url: BASE_URL,
    pageUrl: YT_PAGE,
    tabId: 31,
    docId: "doc-var",
    filename: "base.mp4",
    referer: YT_REFERER,
    userAgent: YT_UA,
    futureVariants: [{ url: FUTURE_URL, label: "future" }],
  });
  const variants = h.ctrl.registerVariants(mediaId, [
    { url: VARIANT_URL, label: "alt" },
  ]);
  assert.equal(variants[0].id, "variant:v1:1");

  let itemHits = 0;
  const item = { id: mediaId };
  Object.defineProperty(item, "url", {
    get() {
      itemHits += 1;
      return BASE_URL;
    },
  });
  Object.defineProperty(item, "providerKey", {
    get() {
      itemHits += 1;
      return "hostile.example";
    },
  });
  Object.defineProperty(item, "variantUrl", {
    get() {
      itemHits += 1;
      return FUTURE_URL;
    },
  });

  await h.ctrl.enqueueDownload(
    {
      type: "download",
      tabId: 31,
      item,
      variantId: variants[0].id,
      intent: saveAsIntent("picked.mp4", "D:\\Vids"),
    },
    {}
  );
  assert.equal(itemHits, 0);
  assert.equal(h.posted.length, 1);
  assert.deepEqual(h.posted[0].urls, [VARIANT_URL]);
  assert.equal(h.posted[0].urls.includes(BASE_URL), false);
  assert.equal(h.posted[0].urls.includes(FUTURE_URL), false);
});

test("unauthorized or unowned requests are effect-free", async () => {
  async function isolate(run) {
    const h = makeHarness();
    const owned = captureDirect(h.ctrl, {
      url: YT_SIGNED,
      pageUrl: YT_PAGE,
      tabId: 41,
      docId: "doc-auth-a",
      filename: "a.mp4",
    });
    const other = captureDirect(h.ctrl, {
      url: VM_SIGNED,
      pageUrl: VM_PAGE,
      tabId: 42,
      docId: "doc-auth-b",
      filename: "b.mp4",
    });
    const otherVars = h.ctrl.registerVariants(other, [
      { url: "https://player.vimeo.com/alt.mp4?sig=x" },
    ]);
    const baseline = {
      postNative: h.counts.postNative,
      publishJobs: h.counts.publishJobs,
      dest: h.counts.getEffectiveDestinationDirectory,
      token: h.counts.randomToken,
    };
    await run(h, owned, otherVars[0].id, baseline);
    assert.equal(h.counts.postNative, baseline.postNative);
    assert.equal(h.counts.publishJobs, baseline.publishJobs);
    assert.equal(h.counts.getEffectiveDestinationDirectory, baseline.dest);
    assert.equal(h.counts.randomToken, baseline.token);
    assert.equal(h.posted.length, 0);
    assert.equal(h.ctrl.popupJobs().length, 0);
  }

  await isolate(async (h, owned, _vid, _b) => {
    h.setPopupOk(false);
    await expectGenericReject(
      h.ctrl.enqueueDownload(
        {
          type: "download",
          tabId: 41,
          item: { id: owned },
          intent: defaultIntent("a.mp4"),
        },
        {}
      )
    );
  });

  await isolate(async (h) => {
    await expectGenericReject(
      h.ctrl.enqueueDownload(
        {
          type: "download",
          tabId: 41,
          item: { id: "media:unknown:1" },
          intent: defaultIntent("a.mp4"),
        },
        {}
      )
    );
  });

  await isolate(async (h, owned) => {
    await expectGenericReject(
      h.ctrl.enqueueDownload(
        {
          type: "download",
          tabId: 99,
          item: { id: owned },
          intent: defaultIntent("a.mp4"),
        },
        {}
      )
    );
  });

  await isolate(async (h, owned, foreignVid) => {
    await expectGenericReject(
      h.ctrl.enqueueDownload(
        {
          type: "download",
          tabId: 41,
          item: { id: owned },
          variantId: foreignVid,
          intent: defaultIntent("a.mp4"),
        },
        {}
      )
    );
  });

  await isolate(async (h, owned) => {
    await expectGenericReject(
      h.ctrl.enqueueDownload(
        {
          type: "download",
          tabId: 41,
          item: { id: owned },
          variantUrl: VARIANT_URL,
          intent: defaultIntent("a.mp4"),
        },
        {}
      )
    );
  });
});
