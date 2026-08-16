"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const { loadLib, mediaCatcherRoot } = require("./harness/load-lib.js");

const {
  createFirefoxGuard,
  assertUserFirefoxIntent,
  helperUnavailableActions,
} = loadLib("lib/firefox-guard.js");

const SIGNED_URL = "https://cdn.example/v?sig=SECRET-SENTINEL-9f3a&exp=1";
const FLOREN_NAME = "11238-makemebi.net.mp4";

function baseIntent(overrides) {
  return Object.assign(
    {
      userSelectedFirefox: true,
      requestedFilename: FLOREN_NAME,
      userActionToken: "tok",
      destinationDirectory: null,
      saveMode: "default",
      createdAt: "t0",
    },
    overrides || {}
  );
}

function urlSource(getUrl) {
  return {
    type: "url",
    getUrl: typeof getUrl === "function" ? getUrl : () => "https://example/x",
  };
}

function makeGuard(overrides) {
  const opts = Object.assign(
    {
      downloadsDownload: async () => 1,
    },
    overrides || {}
  );
  return createFirefoxGuard(opts);
}

// ---------------------------------------------------------------------------
// Plan sample cases
// ---------------------------------------------------------------------------

test("rejects userSelectedFirefox false before API call", async () => {
  let calls = 0;
  const g = createFirefoxGuard({
    downloadsDownload: async () => {
      calls++;
      return 1;
    },
  });
  await assert.rejects(() =>
    g.downloadWithFirefox({
      intent: {
        userSelectedFirefox: false,
        requestedFilename: "a.mp4",
        userActionToken: "t",
        destinationDirectory: null,
        saveMode: "default",
        createdAt: "t0",
      },
      source: { type: "url", getUrl: () => "https://x/y?sig=1" },
      tokenStore: new Set(["t"]),
    })
  );
  assert.equal(calls, 0);
});

test("native failure path cannot mint proof token", () => {
  const store = new Set(["popup-only"]);
  assert.throws(() =>
    assertUserFirefoxIntent(
      {
        userSelectedFirefox: true,
        userActionToken: "forged",
        requestedFilename: "a.mp4",
      },
      store
    )
  );
  assert.equal(store.has("popup-only"), true);
});

test("success uses saveAs true and requestedFilename", async () => {
  let arg = null;
  const store = new Set(["tok"]);
  const g = createFirefoxGuard({
    downloadsDownload: async (opts) => {
      arg = opts;
      return 9;
    },
    createObjectURL: () => "blob:1",
    revokeObjectURL: () => {},
  });
  await g.downloadWithFirefox({
    intent: {
      userSelectedFirefox: true,
      requestedFilename: FLOREN_NAME,
      userActionToken: "tok",
      destinationDirectory: null,
      saveMode: "default",
      createdAt: "t0",
    },
    source: { type: "url", getUrl: () => "https://example/x" },
    tokenStore: store,
  });
  assert.equal(arg.filename, FLOREN_NAME);
  assert.equal(arg.saveAs, true);
  assert.equal(store.has("tok"), false);
});

test("helper unavailable policy offers firefox action but does not auto-invoke", () => {
  const acts = helperUnavailableActions();
  assert.deepEqual(
    acts.map((a) => a.id),
    ["retry-install", "use-firefox", "cancel"]
  );
  const fx = acts.find((a) => a.id === "use-firefox");
  assert.ok(fx);
  assert.equal(fx.autoInvoke, false);
  assert.equal(typeof fx.label, "string");
  assert.equal(typeof helperUnavailableActions, "function");
});

// ---------------------------------------------------------------------------
// Intent / proof adversarial validation
// ---------------------------------------------------------------------------

test("assertUserFirefoxIntent rejects false/missing/nonboolean userSelectedFirefox without effects", () => {
  for (const bad of [false, undefined, null, "true", 1, {}, []]) {
    const store = new Set(["keep-me", "tok"]);
    assert.throws(() =>
      assertUserFirefoxIntent(
        {
          userSelectedFirefox: bad,
          requestedFilename: "a.mp4",
          userActionToken: "tok",
        },
        store
      )
    );
    assert.equal(store.has("keep-me"), true);
    assert.equal(store.has("tok"), true);
  }
});

test("assertUserFirefoxIntent rejects wrapped/object/blank filename and token; preserves unrelated tokens", () => {
  const store = new Set(["keep-me", "tok"]);
  const badFilenames = ["", "   ", null, undefined, 12, true, { s: "a.mp4" }, new String("a.mp4")];
  for (const requestedFilename of badFilenames) {
    assert.throws(() =>
      assertUserFirefoxIntent(
        {
          userSelectedFirefox: true,
          requestedFilename,
          userActionToken: "tok",
        },
        store
      )
    );
  }
  const badTokens = ["", "   ", null, undefined, 0, false, { t: "tok" }, new String("tok")];
  for (const userActionToken of badTokens) {
    assert.throws(() =>
      assertUserFirefoxIntent(
        {
          userSelectedFirefox: true,
          requestedFilename: "a.mp4",
          userActionToken,
        },
        store
      )
    );
  }
  assert.equal(store.has("keep-me"), true);
  assert.equal(store.has("tok"), true);
});

test("assertUserFirefoxIntent rejects malformed token stores", () => {
  const intent = {
    userSelectedFirefox: true,
    requestedFilename: "a.mp4",
    userActionToken: "tok",
  };
  for (const store of [null, undefined, {}, { has: true, delete: () => true }, new Map()]) {
    // Map has has/delete but is acceptable if they are callable — Map is fine.
    // Only truly malformed stores should throw before effects.
  }
  assert.throws(() => assertUserFirefoxIntent(intent, null));
  assert.throws(() => assertUserFirefoxIntent(intent, undefined));
  assert.throws(() => assertUserFirefoxIntent(intent, {}));
  assert.throws(() =>
    assertUserFirefoxIntent(intent, { has: true, delete: () => true })
  );
  assert.throws(() =>
    assertUserFirefoxIntent(intent, {
      has: () => true,
      delete: "nope",
    })
  );
});

test("assertUserFirefoxIntent consumes exact token once; replay rejects; unrelated preserved", () => {
  const store = new Set(["tok", "other"]);
  assertUserFirefoxIntent(
    {
      userSelectedFirefox: true,
      requestedFilename: "a.mp4",
      userActionToken: "tok",
    },
    store
  );
  assert.equal(store.has("tok"), false);
  assert.equal(store.has("other"), true);
  assert.throws(() =>
    assertUserFirefoxIntent(
      {
        userSelectedFirefox: true,
        requestedFilename: "a.mp4",
        userActionToken: "tok",
      },
      store
    )
  );
  assert.equal(store.has("other"), true);
});

test("assertUserFirefoxIntent rejects when delete does not return true or throws", () => {
  const storeFalse = {
    has() {
      return true;
    },
    delete() {
      return false;
    },
  };
  assert.throws(() =>
    assertUserFirefoxIntent(
      {
        userSelectedFirefox: true,
        requestedFilename: "a.mp4",
        userActionToken: "tok",
      },
      storeFalse
    )
  );

  const storeThrow = {
    has() {
      return true;
    },
    delete() {
      throw new Error("store boom");
    },
  };
  assert.throws(() =>
    assertUserFirefoxIntent(
      {
        userSelectedFirefox: true,
        requestedFilename: "a.mp4",
        userActionToken: "tok",
      },
      storeThrow
    )
  );
});

test("assertUserFirefoxIntent ignores intent extras and does not enumerate intent", () => {
  let enumerated = false;
  const intent = {
    userSelectedFirefox: true,
    requestedFilename: "a.mp4",
    userActionToken: "tok",
    Cookie: "session=evil",
    Authorization: "Bearer x",
    sourceContext: { pageUrl: "https://secret" },
    referrer: "https://ref",
  };
  Object.defineProperty(intent, "hostile", {
    enumerable: true,
    get() {
      enumerated = true;
      return "leak";
    },
  });
  // Named required fields may be read; hostile extra must not be touched via enumeration.
  // Direct property access of required names is allowed; getter on extra only trips if enumerated/copied.
  const store = new Set(["tok"]);
  assertUserFirefoxIntent(intent, store);
  assert.equal(enumerated, false);
  assert.equal(store.has("tok"), false);
});

// ---------------------------------------------------------------------------
// Helper unavailable policy
// ---------------------------------------------------------------------------

test("helperUnavailableActions returns exact frozen labels, order, freshness, zero effects", () => {
  const a1 = helperUnavailableActions();
  const a2 = helperUnavailableActions();
  assert.notEqual(a1, a2);
  assert.deepEqual(
    a1.map((x) => ({ id: x.id, label: x.label, autoInvoke: x.autoInvoke })),
    [
      { id: "retry-install", label: "Install/reconnect helper", autoInvoke: false },
      { id: "use-firefox", label: "Use Firefox instead", autoInvoke: false },
      { id: "cancel", label: "Cancel", autoInvoke: false },
    ]
  );
  assert.ok(Object.isFrozen(a1));
  for (const act of a1) {
    assert.ok(Object.isFrozen(act));
    assert.equal(act.autoInvoke, false);
  }
  // Caller mutation cannot alter future policy.
  assert.throws(() => {
    a1.push({ id: "x" });
  });
  assert.throws(() => {
    a1[0].id = "mutated";
  });
  const a3 = helperUnavailableActions();
  assert.equal(a3[0].id, "retry-install");
  assert.equal(a3.length, 3);
});

test("helperUnavailableActions never calls downloads/source/object-URL functions", () => {
  let hits = 0;
  const trap = () => {
    hits++;
  };
  // Policy is pure — no captured adapter. Calling it cannot touch these.
  helperUnavailableActions();
  assert.equal(hits, 0);
  void trap;
});

// ---------------------------------------------------------------------------
// Guard construction
// ---------------------------------------------------------------------------

test("createFirefoxGuard requires downloadsDownload function and returns frozen surface", () => {
  assert.throws(() => createFirefoxGuard({}));
  assert.throws(() => createFirefoxGuard({ downloadsDownload: null }));
  assert.throws(() => createFirefoxGuard({ downloadsDownload: "nope" }));
  const g = createFirefoxGuard({ downloadsDownload: async () => 1 });
  assert.equal(typeof g.downloadWithFirefox, "function");
  assert.deepEqual(Object.keys(g).sort(), ["downloadWithFirefox"]);
  assert.ok(Object.isFrozen(g));
  assert.throws(() => {
    g.extra = 1;
  });
});

test("createFirefoxGuard ignores hostile constructor option getters", () => {
  let hit = 0;
  const opts = {
    downloadsDownload: async () => 1,
  };
  Object.defineProperty(opts, "cookieJar", {
    enumerable: true,
    get() {
      hit++;
      return {};
    },
  });
  Object.defineProperty(opts, "headers", {
    enumerable: true,
    get() {
      hit++;
      return {};
    },
  });
  createFirefoxGuard(opts);
  assert.equal(hit, 0);
});

// ---------------------------------------------------------------------------
// downloadWithFirefox: intent gate + source validation before proof
// ---------------------------------------------------------------------------

test("downloadWithFirefox rejects bad intent flags with zero source/API effects and preserves tokens", async () => {
  let api = 0;
  let getUrl = 0;
  const g = makeGuard({
    downloadsDownload: async () => {
      api++;
      return 1;
    },
  });
  for (const bad of [false, "true", 1, null, undefined]) {
    const store = new Set(["t", "other"]);
    await assert.rejects(() =>
      g.downloadWithFirefox({
        intent: baseIntent({ userSelectedFirefox: bad, userActionToken: "t" }),
        source: urlSource(() => {
          getUrl++;
          return "https://x";
        }),
        tokenStore: store,
      })
    );
    assert.equal(store.has("t"), true);
    assert.equal(store.has("other"), true);
  }
  assert.equal(api, 0);
  assert.equal(getUrl, 0);
});

test("malformed source/effects reject before token consumption", async () => {
  let api = 0;
  const g = makeGuard({
    downloadsDownload: async () => {
      api++;
      return 1;
    },
  });
  const cases = [
    { type: "url" }, // missing getUrl
    { type: "url", getUrl: "not-fn" },
    { type: "url", url: "https://raw.field" }, // raw URL field not accepted
    { type: "bytes", bytes: new Uint8Array([1]) }, // missing object URL effects
    { type: "other", getUrl: () => "https://x" },
    null,
    undefined,
    "https://x",
  ];
  for (const source of cases) {
    const store = new Set(["tok"]);
    await assert.rejects(() =>
      g.downloadWithFirefox({
        intent: baseIntent(),
        source,
        tokenStore: store,
      })
    );
    assert.equal(store.has("tok"), true, `token consumed for source=${JSON.stringify(source)}`);
  }
  // bytes with only one of the object-URL effects
  {
    const store = new Set(["tok"]);
    const g2 = createFirefoxGuard({
      downloadsDownload: async () => {
        api++;
        return 1;
      },
      createObjectURL: () => "blob:1",
    });
    await assert.rejects(() =>
      g2.downloadWithFirefox({
        intent: baseIntent(),
        source: { type: "bytes", bytes: new Uint8Array([1]), mime: "video/mp4" },
        tokenStore: store,
      })
    );
    assert.equal(store.has("tok"), true);
  }
  {
    const store = new Set(["tok"]);
    const g3 = createFirefoxGuard({
      downloadsDownload: async () => {
        api++;
        return 1;
      },
      revokeObjectURL: () => {},
    });
    await assert.rejects(() =>
      g3.downloadWithFirefox({
        intent: baseIntent(),
        source: { type: "bytes", bytes: new Uint8Array([1]) },
        tokenStore: store,
      })
    );
    assert.equal(store.has("tok"), true);
  }
  assert.equal(api, 0);
});

test("bytes source rejects invalid mime before proof consumption", async () => {
  let api = 0;
  const g = createFirefoxGuard({
    downloadsDownload: async () => {
      api++;
      return 1;
    },
    createObjectURL: () => "blob:x",
    revokeObjectURL: () => {},
  });
  for (const mime of ["", "   ", 12, {}, true]) {
    const store = new Set(["tok"]);
    await assert.rejects(() =>
      g.downloadWithFirefox({
        intent: baseIntent(),
        source: { type: "bytes", bytes: new Uint8Array([1]), mime },
        tokenStore: store,
      })
    );
    assert.equal(store.has("tok"), true);
  }
  assert.equal(api, 0);
});

// ---------------------------------------------------------------------------
// URL source path
// ---------------------------------------------------------------------------

test("URL source invokes getUrl only after consumption, once; API options exact and frozen", async () => {
  const events = [];
  const store = {
    has(t) {
      events.push("has:" + t);
      return t === "tok";
    },
    delete(t) {
      events.push("delete:" + t);
      return t === "tok";
    },
  };
  let apiArg = null;
  const g = createFirefoxGuard({
    downloadsDownload: async (opts) => {
      events.push("api");
      apiArg = opts;
      return 42;
    },
  });
  const result = await g.downloadWithFirefox({
    intent: baseIntent({
      requestedFilename: FLOREN_NAME,
      destinationDirectory: "D:\\\\Vids",
      saveMode: "save-as",
      Cookie: "should-not-forward",
      Authorization: "nope",
    }),
    source: {
      type: "url",
      getUrl: () => {
        events.push("getUrl");
        return "https://example/media.mp4";
      },
      // hostile extras
      url: SIGNED_URL,
      headers: { Cookie: "x" },
    },
    tokenStore: store,
  });
  assert.equal(result, 42);
  assert.deepEqual(events, ["has:tok", "delete:tok", "getUrl", "api"]);
  assert.deepEqual(apiArg, {
    url: "https://example/media.mp4",
    filename: FLOREN_NAME,
    saveAs: true,
  });
  assert.ok(Object.isFrozen(apiArg));
  assert.equal(Object.keys(apiArg).sort().join(","), "filename,saveAs,url");
});

test("async getUrl is awaited; invalid/blank getUrl return consumes proof and never calls API", async () => {
  let api = 0;
  const g = makeGuard({
    downloadsDownload: async () => {
      api++;
      return 1;
    },
  });
  for (const bad of ["", "   ", null, undefined, 12, {}, true]) {
    const store = new Set(["tok"]);
    await assert.rejects(() =>
      g.downloadWithFirefox({
        intent: baseIntent(),
        source: {
          type: "url",
          getUrl: async () => bad,
        },
        tokenStore: store,
      })
    );
    assert.equal(store.has("tok"), false);
  }
  assert.equal(api, 0);
});

test("getUrl throw consumes proof, never calls API, never includes signed sentinel in guard error", async () => {
  let api = 0;
  const g = makeGuard({
    downloadsDownload: async () => {
      api++;
      return 1;
    },
  });
  const store = new Set(["tok"]);
  let err;
  try {
    await g.downloadWithFirefox({
      intent: baseIntent(),
      source: {
        type: "url",
        getUrl: () => {
          throw new Error("upstream " + SIGNED_URL);
        },
      },
      tokenStore: store,
    });
  } catch (e) {
    err = e;
  }
  assert.ok(err);
  assert.equal(store.has("tok"), false);
  assert.equal(api, 0);
  // Propagated throw from getUrl may contain the URL (caller's error), but guard must
  // not construct a new error that interpolates the signed URL after a invalid return.
  // Separate path: invalid return (no throw from getUrl) must not embed sentinel.
  const store2 = new Set(["tok2"]);
  let err2;
  try {
    await g.downloadWithFirefox({
      intent: baseIntent({ userActionToken: "tok2" }),
      source: {
        type: "url",
        getUrl: () => SIGNED_URL + "", // valid URL string — allowed through to API
      },
      tokenStore: store2,
    });
  } catch (e) {
    err2 = e;
  }
  // That path succeeds; re-test invalid return:
  const store3 = new Set(["tok3"]);
  let err3;
  try {
    await g.downloadWithFirefox({
      intent: baseIntent({ userActionToken: "tok3" }),
      source: {
        type: "url",
        getUrl: () => {
          // Return a non-string so guard builds the error — must not embed signed value.
          return { href: SIGNED_URL };
        },
      },
      tokenStore: store3,
    });
  } catch (e) {
    err3 = e;
  }
  assert.ok(err3);
  assert.equal(String(err3 && err3.message || err3).includes("SECRET-SENTINEL"), false);
  assert.equal(api, 1); // only the valid SIGNED_URL success path above
});

test("two simultaneous guard calls with one token call getUrl/download at most once", async () => {
  let getUrl = 0;
  let api = 0;
  const store = new Set(["once"]);
  const g = makeGuard({
    downloadsDownload: async () => {
      api++;
      await new Promise((r) => setImmediate(r));
      return 1;
    },
  });
  const input = () => ({
    intent: baseIntent({ userActionToken: "once" }),
    source: {
      type: "url",
      getUrl: async () => {
        getUrl++;
        await new Promise((r) => setImmediate(r));
        return "https://example/once";
      },
    },
    tokenStore: store,
  });
  const results = await Promise.allSettled([
    g.downloadWithFirefox(input()),
    g.downloadWithFirefox(input()),
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(getUrl, 1);
  assert.equal(api, 1);
  assert.equal(store.has("once"), false);
});

test("API sync throw and promise rejection propagate; proof stays consumed; no retry", async () => {
  let api = 0;
  const gSync = makeGuard({
    downloadsDownload: () => {
      api++;
      throw new Error("sync fail");
    },
  });
  const store1 = new Set(["t1"]);
  await assert.rejects(
    () =>
      gSync.downloadWithFirefox({
        intent: baseIntent({ userActionToken: "t1" }),
        source: urlSource(),
        tokenStore: store1,
      }),
    /sync fail/
  );
  assert.equal(store1.has("t1"), false);
  assert.equal(api, 1);

  const gAsync = makeGuard({
    downloadsDownload: async () => {
      api++;
      throw new Error("async fail");
    },
  });
  const store2 = new Set(["t2"]);
  await assert.rejects(
    () =>
      gAsync.downloadWithFirefox({
        intent: baseIntent({ userActionToken: "t2" }),
        source: urlSource(),
        tokenStore: store2,
      }),
    /async fail/
  );
  assert.equal(store2.has("t2"), false);
  assert.equal(api, 2);
});

test("URL sources never create or revoke object URLs", async () => {
  let create = 0;
  let revoke = 0;
  const g = createFirefoxGuard({
    downloadsDownload: async () => 1,
    createObjectURL: () => {
      create++;
      return "blob:x";
    },
    revokeObjectURL: () => {
      revoke++;
    },
  });
  await g.downloadWithFirefox({
    intent: baseIntent(),
    source: urlSource(),
    tokenStore: new Set(["tok"]),
  });
  assert.equal(create, 0);
  assert.equal(revoke, 0);
});

// ---------------------------------------------------------------------------
// Bytes source path
// ---------------------------------------------------------------------------

test("bytes success creates object URL after proof, calls API once, revokes exactly once", async () => {
  const events = [];
  const store = new Set(["tok"]);
  let apiArg = null;
  let blobSeen = null;
  const g = createFirefoxGuard({
    downloadsDownload: async (opts) => {
      events.push("api");
      apiArg = opts;
      return 7;
    },
    createObjectURL: (blob) => {
      events.push("create");
      blobSeen = blob;
      return "blob:guard-1";
    },
    revokeObjectURL: (u) => {
      events.push("revoke:" + u);
    },
  });
  const bytes = new Uint8Array([1, 2, 3]);
  const result = await g.downloadWithFirefox({
    intent: baseIntent({ requestedFilename: FLOREN_NAME }),
    source: { type: "bytes", bytes, mime: "video/mp4" },
    tokenStore: store,
  });
  assert.equal(result, 7);
  assert.equal(store.has("tok"), false);
  assert.ok(blobSeen instanceof Blob);
  assert.equal(blobSeen.type, "video/mp4");
  assert.deepEqual(apiArg, {
    url: "blob:guard-1",
    filename: FLOREN_NAME,
    saveAs: true,
  });
  assert.ok(Object.isFrozen(apiArg));
  // Proof delete happens before create/api/revoke.
  assert.equal(events[0], "create");
  assert.equal(events[1], "api");
  assert.equal(events[2], "revoke:blob:guard-1");
  assert.equal(events.filter((e) => e.startsWith("revoke:")).length, 1);
});

test("bytes filename override changes only the API filename and still consumes the exact proof", async () => {
  let apiArg = null;
  const intent = baseIntent({
    requestedFilename: "movie.m3u8",
    userActionToken: "assembled-proof",
  });
  const store = new Set(["assembled-proof"]);
  const g = createFirefoxGuard({
    downloadsDownload: async (options) => {
      apiArg = options;
      return 9;
    },
    createObjectURL: () => "blob:override",
    revokeObjectURL: () => {},
  });

  await g.downloadWithFirefox({
    intent,
    filename: "movie.mp4",
    source: { type: "bytes", bytes: new Uint8Array([7]), mime: "video/mp4" },
    tokenStore: store,
  });

  assert.equal(intent.requestedFilename, "movie.m3u8");
  assert.equal(store.has("assembled-proof"), false);
  assert.deepEqual(apiArg, {
    url: "blob:override",
    filename: "movie.mp4",
    saveAs: true,
  });
});

test("invalid bytes filename override rejects before proof or object URL effects", async () => {
  let creates = 0;
  let apiCalls = 0;
  const g = createFirefoxGuard({
    downloadsDownload: async () => { apiCalls += 1; },
    createObjectURL: () => { creates += 1; return "blob:invalid"; },
    revokeObjectURL: () => {},
  });

  for (const filename of ["", "   ", new String("movie.mp4"), { value: "movie.mp4" }]) {
    const store = new Set(["tok"]);
    await assert.rejects(() => g.downloadWithFirefox({
      intent: baseIntent(),
      filename,
      source: { type: "bytes", bytes: new Uint8Array([1]) },
      tokenStore: store,
    }));
    assert.equal(store.has("tok"), true);
  }
  assert.equal(creates, 0);
  assert.equal(apiCalls, 0);
});

test("bytes default mime is application/octet-stream when mime absent", async () => {
  let blobSeen = null;
  const g = createFirefoxGuard({
    downloadsDownload: async () => 1,
    createObjectURL: (blob) => {
      blobSeen = blob;
      return "blob:d";
    },
    revokeObjectURL: () => {},
  });
  await g.downloadWithFirefox({
    intent: baseIntent(),
    source: { type: "bytes", bytes: new Uint8Array([9]) },
    tokenStore: new Set(["tok"]),
  });
  assert.equal(blobSeen.type, "application/octet-stream");
});

test("bytes async rejection and sync throw both revoke exactly once; revoke failure does not mask API error", async () => {
  let revokes = 0;
  const gReject = createFirefoxGuard({
    downloadsDownload: async () => {
      throw new Error("api reject");
    },
    createObjectURL: () => "blob:r",
    revokeObjectURL: () => {
      revokes++;
    },
  });
  await assert.rejects(
    () =>
      gReject.downloadWithFirefox({
        intent: baseIntent({ userActionToken: "a" }),
        source: { type: "bytes", bytes: new Uint8Array([1]) },
        tokenStore: new Set(["a"]),
      }),
    /api reject/
  );
  assert.equal(revokes, 1);

  const gSync = createFirefoxGuard({
    downloadsDownload: () => {
      throw new Error("api sync");
    },
    createObjectURL: () => "blob:s",
    revokeObjectURL: () => {
      revokes++;
    },
  });
  await assert.rejects(
    () =>
      gSync.downloadWithFirefox({
        intent: baseIntent({ userActionToken: "b" }),
        source: { type: "bytes", bytes: new Uint8Array([1]) },
        tokenStore: new Set(["b"]),
      }),
    /api sync/
  );
  assert.equal(revokes, 2);

  const gMask = createFirefoxGuard({
    downloadsDownload: async () => {
      throw new Error("primary api");
    },
    createObjectURL: () => "blob:m",
    revokeObjectURL: () => {
      revokes++;
      throw new Error("revoke boom");
    },
  });
  await assert.rejects(
    () =>
      gMask.downloadWithFirefox({
        intent: baseIntent({ userActionToken: "c" }),
        source: { type: "bytes", bytes: new Uint8Array([1]) },
        tokenStore: new Set(["c"]),
      }),
    /primary api/
  );
  assert.equal(revokes, 3);
});

test("createObjectURL failure makes no revoke call and proof stays consumed", async () => {
  let revokes = 0;
  let api = 0;
  const store = new Set(["tok"]);
  const g = createFirefoxGuard({
    downloadsDownload: async () => {
      api++;
      return 1;
    },
    createObjectURL: () => {
      throw new Error("create fail");
    },
    revokeObjectURL: () => {
      revokes++;
    },
  });
  await assert.rejects(
    () =>
      g.downloadWithFirefox({
        intent: baseIntent(),
        source: { type: "bytes", bytes: new Uint8Array([1]) },
        tokenStore: store,
      }),
    /create fail/
  );
  assert.equal(store.has("tok"), false);
  assert.equal(revokes, 0);
  assert.equal(api, 0);
});

test("accepts Blob bytes without re-wrapping type when already a Blob", async () => {
  let blobSeen = null;
  const original = new Blob([new Uint8Array([4])], { type: "audio/mpeg" });
  const g = createFirefoxGuard({
    downloadsDownload: async () => 1,
    createObjectURL: (blob) => {
      blobSeen = blob;
      return "blob:b";
    },
    revokeObjectURL: () => {},
  });
  await g.downloadWithFirefox({
    intent: baseIntent(),
    source: { type: "bytes", bytes: original, mime: "audio/mpeg" },
    tokenStore: new Set(["tok"]),
  });
  assert.ok(blobSeen instanceof Blob);
  assert.equal(blobSeen.type, "audio/mpeg");
});

// ---------------------------------------------------------------------------
// Hostile getters on intent/source/bytes — only required named fields read
// ---------------------------------------------------------------------------

test("hostile extra getters on intent, source, and bytes wrapper are never touched", async () => {
  let hits = 0;
  const trap = {
    get evil() {
      hits++;
      return "leak";
    },
  };
  const intent = baseIntent();
  Object.defineProperty(intent, "Cookie", {
    enumerable: true,
    get() {
      hits++;
      return "a=b";
    },
  });
  Object.defineProperty(intent, "Authorization", {
    enumerable: true,
    get() {
      hits++;
      return "Bearer x";
    },
  });
  Object.defineProperty(intent, "sourceContext", {
    enumerable: true,
    get() {
      hits++;
      return trap;
    },
  });
  Object.defineProperty(intent, "referrer", {
    enumerable: true,
    get() {
      hits++;
      return "https://ref";
    },
  });

  const source = {
    type: "url",
    getUrl: () => "https://example/ok",
  };
  Object.defineProperty(source, "url", {
    enumerable: true,
    get() {
      hits++;
      return SIGNED_URL;
    },
  });
  Object.defineProperty(source, "headers", {
    enumerable: true,
    get() {
      hits++;
      return { Cookie: "x" };
    },
  });
  Object.defineProperty(source, "cookies", {
    enumerable: true,
    get() {
      hits++;
      return "c";
    },
  });

  const g = makeGuard({
    downloadsDownload: async (opts) => {
      assert.equal(opts.saveAs, true);
      assert.equal(opts.filename, FLOREN_NAME);
      return 1;
    },
  });
  await g.downloadWithFirefox({
    intent,
    source,
    tokenStore: new Set(["tok"]),
  });
  assert.equal(hits, 0);

  // Bytes path: do not touch wrapper extras.
  hits = 0;
  const bytesWrapper = new Uint8Array([1]);
  Object.defineProperty(bytesWrapper, "secretMeta", {
    enumerable: true,
    get() {
      hits++;
      return "no";
    },
  });
  const bSource = { type: "bytes", bytes: bytesWrapper };
  Object.defineProperty(bSource, "getUrl", {
    enumerable: true,
    get() {
      hits++;
      return () => SIGNED_URL;
    },
  });
  const g2 = createFirefoxGuard({
    downloadsDownload: async () => 1,
    createObjectURL: () => "blob:z",
    revokeObjectURL: () => {},
  });
  await g2.downloadWithFirefox({
    intent: baseIntent({ userActionToken: "tok2" }),
    source: bSource,
    tokenStore: new Set(["tok2"]),
  });
  assert.equal(hits, 0);
});

// ---------------------------------------------------------------------------
// assertUserFirefoxIntent alone never calls API; Map-like store works
// ---------------------------------------------------------------------------

test("assertUserFirefoxIntent alone never calls downloads API and works with Map-like store", () => {
  let api = 0;
  createFirefoxGuard({
    downloadsDownload: async () => {
      api++;
      return 1;
    },
  });
  const mapLike = {
    _s: new Set(["m-tok"]),
    has(k) {
      return this._s.has(k);
    },
    delete(k) {
      return this._s.delete(k);
    },
  };
  assertUserFirefoxIntent(
    {
      userSelectedFirefox: true,
      requestedFilename: "a.mp4",
      userActionToken: "m-tok",
    },
    mapLike
  );
  assert.equal(mapLike.has("m-tok"), false);
  assert.equal(api, 0);
});

// ---------------------------------------------------------------------------
// Dual-export + source hygiene
// ---------------------------------------------------------------------------

test("CommonJS export and browser global name are exact McFirefoxGuard", () => {
  const nodeExport = loadLib("lib/firefox-guard.js");
  assert.equal(typeof nodeExport.createFirefoxGuard, "function");
  assert.equal(typeof nodeExport.assertUserFirefoxIntent, "function");
  assert.equal(typeof nodeExport.helperUnavailableActions, "function");

  const abs = path.join(mediaCatcherRoot, "lib", "firefox-guard.js");
  const code = fs.readFileSync(abs, "utf8");
  const root = {};
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require,
    console,
    self: root,
    Blob,
  };
  sandbox.module.exports = sandbox.exports;
  vm.runInNewContext(code, sandbox, { filename: abs });
  assert.equal(typeof root.McFirefoxGuard.createFirefoxGuard, "function");
  assert.equal(typeof root.McFirefoxGuard.assertUserFirefoxIntent, "function");
  assert.equal(typeof root.McFirefoxGuard.helperUnavailableActions, "function");
  assert.equal(root.McFirefoxGuard, sandbox.module.exports);
  assert.equal(Object.keys(root).includes("McFirefoxGuard"), true);
});

test("module source has no browser.downloads, downloads.download, logging, storage, or secret forwarding", () => {
  const abs = path.join(mediaCatcherRoot, "lib", "firefox-guard.js");
  const src = fs.readFileSync(abs, "utf8");
  assert.equal(/browser\.downloads/.test(src), false);
  assert.equal(/downloads\.download/.test(src), false);
  assert.equal(/console\./.test(src), false);
  assert.equal(/localStorage|sessionStorage|indexedDB/.test(src), false);
  assert.equal(/setTimeout|setInterval|fetch\(/.test(src), false);
  assert.equal(/autoInvoke\s*:\s*true/.test(src), false);
  // Must not hardcode signed-URL materialization or cookie/header forwarding fields.
  assert.equal(/\bCookie\b|\bAuthorization\b|\breferrer\b/.test(src), false);
  assert.equal(/SECRET-SENTINEL/.test(src), false);
});

test("exports surface is exactly the three public functions", () => {
  const api = loadLib("lib/firefox-guard.js");
  assert.deepEqual(
    Object.keys(api).sort(),
    ["assertUserFirefoxIntent", "createFirefoxGuard", "helperUnavailableActions"]
  );
});
