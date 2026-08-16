"use strict";

/**
 * Direct-download admission through the real adapter, router, scheduler,
 * privacy, and file-sink modules. Injected effects are faked.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");

const GENERIC_MSG = "invalid background adapter input";

const SIGNED_URL =
  "https://cdn.files.example/v.mp4?token=SIGNED_TOKEN_XYZ";
const VARIANT_URL =
  "https://cdn.files.example/variant.mp4?token=VARIANT_TOKEN_XYZ";
const BASE_CANDIDATE_URL =
  "https://cdn.files.example/base-candidate.mp4?token=BASE_TOKEN_XYZ";
const FUTURE_CANDIDATE_URL =
  "https://cdn.files.example/future-candidate.mp4?token=FUTURE_TOKEN_XYZ";
const ALPHA_URL =
  "https://cdn.alpha.example/a.mp4?token=ALPHA_TOKEN_XYZ";
const BETA_URL =
  "https://cdn.beta.example/b.mp4?token=BETA_TOKEN_XYZ";
const CONFIGURED_DIR = "E:\\Library";
const SAVE_AS_DIR = "D:\\Vids";
const SAVE_AS_NAME = "edited-name.mp4";
const SEGMENT_CONCURRENCY = 4;
const PAGE_FLOREN = "https://florenfile.com/watch";
const REFERER_FLOREN = "https://florenfile.com/watch";
const USER_AGENT = "mCatcher-Test/1";

function loadAdapters() {
  return loadLib("lib/background-adapters.js");
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

function assertPopupSafe(row, sentinels, label) {
  assertDeepFrozen(row, label);
  const raw = JSON.stringify(row);
  for (const s of sentinels) {
    assert.equal(raw.includes(s), false, label + " must not contain " + s);
  }
  const forbidden = [
    "mediaUrl",
    "requestHeaders",
    "sourceContext",
    "attemptToken",
    "ephemeral",
    "url",
    "pageUrl",
    "referer",
    "referrer",
    "Cookie",
    "Authorization",
  ];
  for (const name of forbidden) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(row, name),
      false,
      label + " must not expose " + name
    );
  }
}

function makeHarness(overrides) {
  const posted = [];
  const published = [];
  let destCalls = 0;
  let tokenCalls = 0;
  let clock = 1_000_000;
  const counts = {
    postNative: 0,
    publishJobs: 0,
    getEffectiveDestinationDirectory: 0,
    randomToken: 0,
    isPopupSender: 0,
  };
  const effects = {
    posted,
    published,
    counts,
    options(extra) {
      const base = {
        maxConcurrent: 2,
        segmentConcurrency: SEGMENT_CONCURRENCY,
        retries: 2,
        now() {
          return clock;
        },
        randomToken() {
          tokenCalls += 1;
          counts.randomToken += 1;
          return "tok-" + tokenCalls;
        },
        postNative(command) {
          counts.postNative += 1;
          posted.push(command);
          return command;
        },
        downloadsDownload() {
          return null;
        },
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
        isPopupSender(sender) {
          counts.isPopupSender += 1;
          return !!(sender && sender.popup === true);
        },
        getEffectiveDestinationDirectory() {
          destCalls += 1;
          counts.getEffectiveDestinationDirectory += 1;
          return CONFIGURED_DIR;
        },
        publishDetection() {},
        publishJobs(jobs) {
          counts.publishJobs += 1;
          published.push(jobs);
        },
        persistHistory() {},
        reportDiagnostic() {},
      };
      return Object.assign(base, overrides || {}, extra || {});
    },
  };
  return effects;
}

function popupSender() {
  return { popup: true };
}

function saveAsIntent(overrides) {
  return Object.assign(
    {
      requestedFilename: SAVE_AS_NAME,
      destinationDirectory: SAVE_AS_DIR,
      saveMode: "save-as",
      userSelectedFirefox: false,
      userActionToken: "act-save-as",
      createdAt: "t0",
    },
    overrides || {}
  );
}

function captureDirectDom(ctrl, opts) {
  const tabId = opts.tabId;
  const pageUrl = opts.pageUrl;
  return ctrl.captureDomMedia({
    mediaUrl: opts.mediaUrl,
    mediaOrigin: opts.mediaOrigin || "https://cdn.files.example",
    contentDisposition: null,
    referrerUrl: pageUrl,
    frameOrigin: new URL(pageUrl).origin,
    ts: 1_000_000,
    snapshot: {
      documentId: opts.docId,
      tabId: tabId,
      frameId: 0,
      pageUrl: pageUrl,
      topLevelPageUrl: pageUrl,
      documentNonce: "n-" + opts.docId,
      candidates: [
        { kind: "visible-filename", value: opts.filename || "source-name.mp4" },
      ],
      capturedAt: "2026-08-12T12:00:00.000Z",
    },
    transport: Object.assign(
      {
        mediaKind: "direct",
        requestHeaders: { Cookie: "session=SECRET_COOKIE_ABC" },
      },
      opts.transport || {}
    ),
  });
}

function hostileItem(mediaId) {
  let hits = 0;
  const item = { id: mediaId };
  function trap(name) {
    Object.defineProperty(item, name, {
      enumerable: true,
      configurable: true,
      get() {
        hits += 1;
        throw new Error("caller " + name + " getter must not run");
      },
    });
  }
  trap("url");
  trap("providerKey");
  trap("pageUrl");
  trap("variantUrl");
  trap("variantId");
  trap("sourceContext");
  return {
    item,
    hits() {
      return hits;
    },
  };
}

test("Save-As direct admission posts one structured pget", async () => {
  const api = loadAdapters();
  const fx = makeHarness();
  const ctrl = api.createBackgroundAdapters(fx.options());
  const tabId = 11;
  const mediaId = captureDirectDom(ctrl, {
    docId: "doc-admit-save-as",
    tabId,
    pageUrl: PAGE_FLOREN,
    mediaUrl: SIGNED_URL,
    filename: "source-name.mp4",
    transport: {
      referer: REFERER_FLOREN,
      userAgent: USER_AGENT,
    },
  });
  assert.equal(typeof mediaId, "string");

  const hostile = hostileItem(mediaId);
  const job = await ctrl.enqueueDownload(
    {
      type: "save-as-download",
      tabId,
      item: hostile.item,
      intent: saveAsIntent(),
    },
    popupSender()
  );

  assert.equal(hostile.hits(), 0, "caller item URL/provider getters stay idle");
  assert.equal(fx.posted.length, 1, "exactly one native command");
  const cmd = fx.posted[0];
  assertDeepFrozen(cmd, "pget payload");
  assert.deepEqual(cmd, {
    cmd: "pget",
    id: job.id,
    attemptToken: cmd.attemptToken,
    urls: [SIGNED_URL],
    name: SAVE_AS_NAME,
    dir: SAVE_AS_DIR,
    maxConnections: SEGMENT_CONCURRENCY,
    providerGeneration: 0,
    referer: REFERER_FLOREN,
    userAgent: USER_AGENT,
  });
  assert.equal(typeof cmd.attemptToken, "string");
  assert.ok(cmd.attemptToken.length > 0);

  const sentinels = [
    SIGNED_URL,
    "SIGNED_TOKEN_XYZ",
    "SECRET_COOKIE_ABC",
    cmd.attemptToken,
  ];
  assertPopupSafe(job, sentinels, "enqueue return");
  assert.equal(job.id, cmd.id);
  assert.equal(job.state, "running");
  assert.equal(job.providerKey, "florenfile.com");
  assert.equal(job.requestedFilename, SAVE_AS_NAME);
  assert.equal(job.destinationDirectory, SAVE_AS_DIR);

  const rows = ctrl.popupJobs();
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, 1);
  assert.notEqual(rows, ctrl.popupJobs(), "popupJobs returns a fresh array");
  assertPopupSafe(rows[0], sentinels, "popupJobs[0]");
  assert.equal(rows[0].id, job.id);
  assert.equal(rows[0].requestedFilename, SAVE_AS_NAME);
  assert.equal(rows[0].destinationDirectory, SAVE_AS_DIR);
  assert.equal(fx.counts.getEffectiveDestinationDirectory, 0);
});

test("hard cap and dynamic raise", async () => {
  const api = loadAdapters();
  const fx = makeHarness();
  const ctrl = api.createBackgroundAdapters(
    fx.options({ maxConcurrent: 1 })
  );
  const mediaA = captureDirectDom(ctrl, {
    docId: "doc-admit-alpha",
    tabId: 21,
    pageUrl: "https://alpha.example/watch",
    mediaUrl: ALPHA_URL,
    mediaOrigin: "https://cdn.alpha.example",
    filename: "alpha.mp4",
  });
  const mediaB = captureDirectDom(ctrl, {
    docId: "doc-admit-beta",
    tabId: 22,
    pageUrl: "https://beta.example/watch",
    mediaUrl: BETA_URL,
    mediaOrigin: "https://cdn.beta.example",
    filename: "beta.mp4",
  });

  const jobA = await ctrl.enqueueDownload(
    {
      type: "download",
      tabId: 21,
      item: { id: mediaA },
      userActionToken: "act-a",
    },
    popupSender()
  );
  assert.equal(fx.posted.length, 1);
  assert.equal(jobA.state, "running");
  assert.deepEqual(fx.posted[0].urls, [ALPHA_URL]);
  assert.equal(fx.posted[0].dir, CONFIGURED_DIR);
  assert.equal(fx.counts.getEffectiveDestinationDirectory, 1);

  const jobB = await ctrl.enqueueDownload(
    {
      type: "download",
      tabId: 22,
      item: { id: mediaB },
      userActionToken: "act-b",
    },
    popupSender()
  );
  assert.equal(fx.posted.length, 1, "queued job posts nothing");
  assert.equal(jobB.state, "queued");
  assert.equal(fx.counts.getEffectiveDestinationDirectory, 2);

  await ctrl.setMaxConcurrent(2);
  assert.equal(fx.posted.length, 2, "raise admits the second job once");
  assert.deepEqual(fx.posted[1].urls, [BETA_URL]);
  assert.equal(fx.posted[1].dir, CONFIGURED_DIR);
  assert.equal(fx.posted[1].id, jobB.id);
  const afterRaise = ctrl.popupJobs();
  assert.equal(afterRaise.find((r) => r.id === jobA.id).state, "running");
  assert.equal(afterRaise.find((r) => r.id === jobB.id).state, "running");

  await ctrl.pump();
  await ctrl.pump();
  await ctrl.setMaxConcurrent(1);
  await ctrl.pump();
  assert.equal(fx.posted.length, 2, "lower and extra pump do not repost");
  const afterLower = ctrl.popupJobs();
  assert.equal(afterLower.find((r) => r.id === jobA.id).state, "running");
  assert.equal(afterLower.find((r) => r.id === jobB.id).state, "running");
  assert.equal(fx.posted[0].id, jobA.id);
  assert.equal(fx.posted[1].id, jobB.id);
});

test("opaque registered variant authority", async () => {
  const api = loadAdapters();
  const fx = makeHarness();
  const ctrl = api.createBackgroundAdapters(fx.options());
  const tabId = 31;
  const mediaId = captureDirectDom(ctrl, {
    docId: "doc-admit-variant",
    tabId,
    pageUrl: PAGE_FLOREN,
    mediaUrl: BASE_CANDIDATE_URL,
    filename: "base.mp4",
    transport: {
      referer: REFERER_FLOREN,
      userAgent: USER_AGENT,
      variants: [{ url: FUTURE_CANDIDATE_URL, label: "future" }],
    },
  });
  const rows = ctrl.registerVariants(mediaId, [
    { url: VARIANT_URL, label: "explicit" },
  ]);
  assert.equal(rows.length, 1);
  const variantId = rows[0].id;

  const hostile = hostileItem(mediaId);
  await ctrl.enqueueDownload(
    {
      type: "download",
      tabId,
      item: hostile.item,
      variantId,
      userActionToken: "act-variant",
    },
    popupSender()
  );

  assert.equal(hostile.hits(), 0);
  assert.equal(fx.posted.length, 1);
  assert.deepEqual(fx.posted[0].urls, [VARIANT_URL]);
  assert.equal(fx.posted[0].urls.includes(BASE_CANDIDATE_URL), false);
  assert.equal(fx.posted[0].urls.includes(FUTURE_CANDIDATE_URL), false);
  assert.equal(fx.posted[0].name, "base.mp4");
});

test("unauthorized or unowned requests are effect-free", async () => {
  const api = loadAdapters();
  const fx = makeHarness();
  const ctrl = api.createBackgroundAdapters(fx.options());
  const tabA = 41;
  const tabB = 42;
  const mediaA = captureDirectDom(ctrl, {
    docId: "doc-admit-auth-a",
    tabId: tabA,
    pageUrl: "https://alpha.example/watch",
    mediaUrl: ALPHA_URL,
    mediaOrigin: "https://cdn.alpha.example",
    filename: "owned-a.mp4",
  });
  const mediaB = captureDirectDom(ctrl, {
    docId: "doc-admit-auth-b",
    tabId: tabB,
    pageUrl: "https://beta.example/watch",
    mediaUrl: BETA_URL,
    mediaOrigin: "https://cdn.beta.example",
    filename: "owned-b.mp4",
  });
  const foreignRows = ctrl.registerVariants(mediaB, [
    { url: VARIANT_URL, label: "foreign" },
  ]);
  const foreignVariantId = foreignRows[0].id;

  async function assertUnauthorized(message, sender, label) {
    const baseline = {
      postNative: fx.counts.postNative,
      publishJobs: fx.counts.publishJobs,
      dest: fx.counts.getEffectiveDestinationDirectory,
      tokens: fx.counts.randomToken,
    };
    await assert.rejects(
      ctrl.enqueueDownload(message, sender),
      (err) =>
        err instanceof TypeError &&
        err.message === GENERIC_MSG &&
        err.name === "TypeError",
      label
    );
    assert.equal(fx.counts.postNative, baseline.postNative, label + " native");
    assert.equal(
      fx.counts.publishJobs,
      baseline.publishJobs,
      label + " publish"
    );
    assert.equal(
      fx.counts.getEffectiveDestinationDirectory,
      baseline.dest,
      label + " dest"
    );
    assert.equal(
      fx.counts.randomToken,
      baseline.tokens,
      label + " token"
    );
  }

  await assertUnauthorized(
    {
      type: "download",
      tabId: tabA,
      item: { id: mediaA },
      userActionToken: "act-non-popup",
    },
    { popup: false },
    "non-popup sender"
  );

  await assertUnauthorized(
    {
      type: "download",
      tabId: tabA,
      item: { id: "media:unknown:1" },
      userActionToken: "act-unknown",
    },
    popupSender(),
    "unknown media ID"
  );

  await assertUnauthorized(
    {
      type: "download",
      tabId: tabB,
      item: { id: mediaA },
      userActionToken: "act-cross-tab",
    },
    popupSender(),
    "cross-tab media ID"
  );

  await assertUnauthorized(
    {
      type: "download",
      tabId: tabA,
      item: { id: mediaA },
      variantId: foreignVariantId,
      userActionToken: "act-foreign-variant",
    },
    popupSender(),
    "foreign-media variant ID"
  );

  await assertUnauthorized(
    {
      type: "download",
      tabId: tabA,
      item: { id: mediaA },
      variantUrl: "https://evil.example/raw.mp4?token=RAW_URL_XYZ",
      userActionToken: "act-raw-url",
    },
    popupSender(),
    "present non-null raw variantUrl"
  );

  assert.equal(ctrl.popupJobs().length, 0);
});
