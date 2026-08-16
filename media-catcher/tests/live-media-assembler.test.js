"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { mediaCatcherRoot } = require("./harness/load-lib.js");

const assemblerPath = path.join(mediaCatcherRoot, "lib", "live-media-assembler.js");
const HLS = require(path.join(mediaCatcherRoot, "lib", "hls.js")).HLS;

const unusedDash = Object.freeze({
  parse() {
    throw new Error("unexpected DASH parse");
  },
});

const unusedMux = Object.freeze({
  combineFmp4() {
    throw new Error("unexpected mux");
  },
});

function bytes(value) {
  const view = typeof value === "string"
    ? new TextEncoder().encode(value)
    : Uint8Array.from(value);
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function makeFetch(fixtures, calls) {
  return async function fetchArrayBuffer(url, options) {
    calls.push(options === undefined ? [url] : [url, options]);
    assert.equal(fixtures.has(url), true, "unexpected fetch URL: " + url);
    const value = fixtures.get(url);
    if (value instanceof Error) throw value;
    return bytes(value);
  };
}

function loadApi() {
  delete require.cache[require.resolve(assemblerPath)];
  return require(assemblerPath);
}

function createAssembler(overrides) {
  overrides = overrides || {};
  return loadApi().createLiveMediaAssembler({
    HLS: overrides.HLS || HLS,
    DASH: overrides.DASH || unusedDash,
    Mux: overrides.Mux || unusedMux,
  });
}

test("exports one frozen CommonJS/classic-global factory", () => {
  const api = loadApi();
  assert.deepEqual(Object.keys(api), ["createLiveMediaAssembler"]);
  assert.equal(typeof api.createLiveMediaAssembler, "function");
  assert.equal(Object.isFrozen(api), true);

  const code = fs.readFileSync(assemblerPath, "utf8");
  const root = {};
  vm.runInNewContext(code, { self: root, TextDecoder, URL, Uint8Array, ArrayBuffer });
  assert.equal(typeof root.McLiveMediaAssembler.createLiveMediaAssembler, "function");
  assert.equal(Object.isFrozen(root.McLiveMediaAssembler), true);
});

test("assembles an HLS media VOD with exact manifest, range, progress, and output effects", async () => {
  const sourceUrl = "https://media.example/path/selected.m3u8";
  const initUrl = "https://media.example/path/init.mp4";
  const segmentUrl = "https://media.example/path/segment.m4s";
  const manifest = [
    "#EXTM3U",
    "#EXT-X-MAP:URI=\"init.mp4\"",
    "#EXT-X-BYTERANGE:2@1",
    "#EXTINF:4,",
    "segment.m4s",
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");
  const calls = [];
  const progress = [];
  const fetchArrayBuffer = makeFetch(new Map([
    [sourceUrl, manifest],
    [initUrl, [1, 2]],
    [segmentUrl, [3, 4]],
  ]), calls);

  const result = await createAssembler()({
    kind: "hls",
    sourceUrl,
    selection: null,
    segmentConcurrency: 2,
    fetchArrayBuffer,
    shouldAbort: () => false,
    onProgress: (event) => progress.push(event),
  });

  assert.deepEqual(calls, [
    [sourceUrl],
    [initUrl],
    [segmentUrl, { range: "bytes=1-2" }],
  ]);
  assert.deepEqual(progress, [
    { done: 1, total: 2, bytes: 2 },
    { done: 2, total: 2, bytes: 4 },
  ]);
  assert.deepEqual(Array.from(result.bytes), [1, 2, 3, 4]);
  assert.equal(result.mime, "video/mp4");
  assert.equal(result.extension, "mp4");
});

test("chooses the deterministic best HLS master variant and muxes its default fMP4 audio", async () => {
  const masterUrl = "https://hls.example/master.m3u8";
  const highUrl = "https://hls.example/high/video.m3u8";
  const highInit = "https://hls.example/high/init.mp4";
  const highSegment = "https://hls.example/high/one.m4s";
  const audioUrl = "https://hls.example/audio.m3u8";
  const audioInit = "https://hls.example/audio-init.mp4";
  const audioSegment = "https://hls.example/audio-one.m4s";
  const master = [
    "#EXTM3U",
    "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"low-audio\",NAME=\"Low\",DEFAULT=YES,URI=\"low-audio.m3u8\"",
    "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"high-audio\",NAME=\"English\",DEFAULT=YES,URI=\"audio.m3u8\"",
    "#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360,AUDIO=\"low-audio\"",
    "low/video.m3u8",
    "#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1920x1080,AUDIO=\"high-audio\"",
    "high/video.m3u8",
    "",
  ].join("\n");
  const videoMedia = [
    "#EXTM3U",
    "#EXT-X-MAP:URI=\"init.mp4\"",
    "#EXTINF:4,",
    "one.m4s",
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");
  const audioMedia = [
    "#EXTM3U",
    "#EXT-X-MAP:URI=\"audio-init.mp4\"",
    "#EXTINF:4,",
    "audio-one.m4s",
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");
  const calls = [];
  const muxCalls = [];
  const fetchArrayBuffer = makeFetch(new Map([
    [masterUrl, master],
    [highUrl, videoMedia],
    [highInit, [10]],
    [highSegment, [11]],
    [audioUrl, audioMedia],
    [audioInit, [20]],
    [audioSegment, [21]],
  ]), calls);
  const Mux = {
    combineFmp4(video, audio) {
      muxCalls.push([Array.from(video), Array.from(audio)]);
      return Uint8Array.from([90, 91, 92]);
    },
  };

  const result = await createAssembler({ Mux })({
    kind: "hls",
    sourceUrl: masterUrl,
    selection: null,
    segmentConcurrency: 1,
    fetchArrayBuffer,
    shouldAbort: () => false,
    onProgress: () => {},
  });

  assert.deepEqual(calls, [
    [masterUrl],
    [highUrl],
    [highInit],
    [highSegment],
    [audioUrl],
    [audioInit],
    [audioSegment],
  ]);
  assert.deepEqual(muxCalls, [[ [10, 11], [20, 21] ]]);
  assert.deepEqual(Array.from(result.bytes), [90, 91, 92]);
  assert.equal(result.mime, "video/mp4");
  assert.equal(result.extension, "mp4");
});

test("rejects split HLS tracks that cannot be muxed instead of dropping audio", async () => {
  const masterUrl = "https://split.example/master.m3u8";
  const videoUrl = "https://split.example/video.m3u8";
  const audioUrl = "https://split.example/audio.m3u8";
  const calls = [];
  let muxCount = 0;
  const fetchArrayBuffer = makeFetch(new Map([
    [masterUrl, [
      "#EXTM3U",
      "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"Audio\",DEFAULT=YES,URI=\"audio.m3u8\"",
      "#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO=\"a\"",
      "video.m3u8",
      "",
    ].join("\n")],
    [videoUrl, "#EXTM3U\n#EXTINF:4,\nvideo.ts\n#EXT-X-ENDLIST\n"],
    ["https://split.example/video.ts", [1, 2]],
    [audioUrl, "#EXTM3U\n#EXT-X-MAP:URI=\"audio-init.mp4\"\n#EXTINF:4,\naudio.m4s\n#EXT-X-ENDLIST\n"],
    ["https://split.example/audio-init.mp4", [3]],
    ["https://split.example/audio.m4s", [4]],
  ]), calls);

  await assert.rejects(
    createAssembler({
      Mux: { combineFmp4() { muxCount += 1; return new Uint8Array(); } },
    })({
      kind: "hls",
      sourceUrl: masterUrl,
      selection: null,
      segmentConcurrency: 1,
      fetchArrayBuffer,
      shouldAbort: () => false,
      onProgress: () => {},
    }),
    /unsupported split hls tracks/i
  );

  assert.equal(muxCount, 0);
  assert.equal(calls.some((call) => call[0] === "https://split.example/audio.m4s"), true);
});

test("selects the requested DASH representation and muxes the deterministic audio representation", async () => {
  const mpdUrl = "https://dash.example/manifest.mpd";
  const parseCalls = [];
  const muxCalls = [];
  const calls = [];
  const DASH = {
    parse(text, url) {
      parseCalls.push([text, url]);
      return {
        type: "dash",
        isDynamic: false,
        drm: false,
        video: [
          { id: "best", bandwidth: 5000, width: 1920, height: 1080, mimeType: "video/mp4", init: { uri: "https://dash.example/best-init.mp4" }, segments: [{ uri: "https://dash.example/best.m4s" }] },
          { id: "chosen", bandwidth: 1000, width: 640, height: 360, mimeType: "video/mp4", init: { uri: "https://dash.example/chosen-init.mp4" }, segments: [{ uri: "https://dash.example/chosen.m4s", byteRange: { offset: 5, length: 2 } }] },
        ],
        audio: [
          { id: "quiet", bandwidth: 64, mimeType: "audio/mp4", init: { uri: "https://dash.example/quiet-init.mp4" }, segments: [{ uri: "https://dash.example/quiet.m4s" }] },
          { id: "clear", bandwidth: 192, mimeType: "audio/mp4", init: { uri: "https://dash.example/audio-init.mp4" }, segments: [{ uri: "https://dash.example/audio.m4s" }] },
        ],
      };
    },
  };
  const fetchArrayBuffer = makeFetch(new Map([
    [mpdUrl, "<MPD id=\"fixture\"/>"],
    ["https://dash.example/chosen-init.mp4", [10]],
    ["https://dash.example/chosen.m4s", [11, 12]],
    ["https://dash.example/audio-init.mp4", [20]],
    ["https://dash.example/audio.m4s", [21]],
  ]), calls);
  const Mux = {
    combineFmp4(video, audio) {
      muxCalls.push([Array.from(video), Array.from(audio)]);
      return Uint8Array.from([30, 31]);
    },
  };

  const result = await createAssembler({ DASH, Mux })({
    kind: "dash",
    sourceUrl: mpdUrl,
    selection: Object.freeze({
      id: "variant:opaque-public-id",
      width: 640,
      height: 360,
      bandwidth: 1000,
      mime: "video/mp4",
    }),
    segmentConcurrency: 2,
    fetchArrayBuffer,
    shouldAbort: () => false,
    onProgress: () => {},
  });

  assert.deepEqual(parseCalls, [["<MPD id=\"fixture\"/>", mpdUrl]]);
  assert.deepEqual(calls, [
    [mpdUrl],
    ["https://dash.example/chosen-init.mp4"],
    ["https://dash.example/chosen.m4s", { range: "bytes=5-6" }],
    ["https://dash.example/audio-init.mp4"],
    ["https://dash.example/audio.m4s"],
  ]);
  assert.deepEqual(muxCalls, [[ [10, 11, 12], [20, 21] ]]);
  assert.deepEqual(Array.from(result.bytes), [30, 31]);
  assert.equal(result.mime, "video/mp4");
  assert.equal(result.extension, "mp4");
});

test("uses the deterministic best DASH video when no selection exists", async () => {
  const mpdUrl = "https://dash-single.example/manifest.mpd";
  const calls = [];
  const DASH = {
    parse() {
      return {
        type: "dash",
        isDynamic: false,
        drm: false,
        video: [
          { id: "low", bandwidth: 100, mimeType: "video/mp4", init: { uri: "https://dash-single.example/low-init.mp4" }, segments: [{ uri: "https://dash-single.example/low.m4s" }] },
          { id: "high", bandwidth: 900, mimeType: "video/mp4", init: { uri: "https://dash-single.example/high-init.mp4" }, segments: [{ uri: "https://dash-single.example/high.m4s" }] },
        ],
        audio: [],
      };
    },
  };
  const fetchArrayBuffer = makeFetch(new Map([
    [mpdUrl, "<MPD/>"],
    ["https://dash-single.example/high-init.mp4", [5]],
    ["https://dash-single.example/high.m4s", [6]],
  ]), calls);

  const result = await createAssembler({ DASH })({
    kind: "dash",
    sourceUrl: mpdUrl,
    selection: null,
    segmentConcurrency: 1,
    fetchArrayBuffer,
    shouldAbort: () => false,
    onProgress: () => {},
  });

  assert.deepEqual(calls, [
    [mpdUrl],
    ["https://dash-single.example/high-init.mp4"],
    ["https://dash-single.example/high.m4s"],
  ]);
  assert.deepEqual(Array.from(result.bytes), [5, 6]);
  assert.equal(result.mime, "video/mp4");
  assert.equal(result.extension, "mp4");
});

test("fails closed for live, dynamic, DRM, malformed, and invalid UTF-8 manifests", async () => {
  const hlsCases = [
    "#EXTM3U\n#EXTINF:4,\nlive.ts\n",
    "#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"key.bin\"\n#EXTINF:4,\nprotected.ts\n#EXT-X-ENDLIST\n",
    "#EXTM3U\n#EXT-X-ENDLIST\n",
  ];
  for (let i = 0; i < hlsCases.length; i += 1) {
    const sourceUrl = "https://invalid-hls.example/" + i + ".m3u8";
    const calls = [];
    await assert.rejects(createAssembler()({
      kind: "hls",
      sourceUrl,
      selection: null,
      segmentConcurrency: 1,
      fetchArrayBuffer: makeFetch(new Map([[sourceUrl, hlsCases[i]]]), calls),
      shouldAbort: () => false,
      onProgress: () => {},
    }));
    assert.deepEqual(calls, [[sourceUrl]]);
  }

  for (const parsed of [
    { type: "dash", isDynamic: true, drm: false, video: [], audio: [] },
    { type: "dash", isDynamic: false, drm: true, video: [], audio: [] },
    { type: "dash", isDynamic: false, drm: false, video: [], audio: [] },
  ]) {
    const sourceUrl = "https://invalid-dash.example/manifest.mpd";
    await assert.rejects(createAssembler({ DASH: { parse: () => parsed } })({
      kind: "dash",
      sourceUrl,
      selection: null,
      segmentConcurrency: 1,
      fetchArrayBuffer: async () => bytes("<MPD/>") ,
      shouldAbort: () => false,
      onProgress: () => {},
    }));
  }

  await assert.rejects(createAssembler()({
    kind: "hls",
    sourceUrl: "https://invalid-utf8.example/manifest.m3u8",
    selection: null,
    segmentConcurrency: 1,
    fetchArrayBuffer: async () => bytes([0xc3, 0x28]),
    shouldAbort: () => false,
    onProgress: () => {},
  }));
});

test("cancellation prevents new fetches and a failed segment is never retried", async () => {
  let fetchCount = 0;
  await assert.rejects(createAssembler()({
    kind: "hls",
    sourceUrl: "https://cancel.example/media.m3u8",
    selection: null,
    segmentConcurrency: 2,
    fetchArrayBuffer: async () => {
      fetchCount += 1;
      return bytes("#EXTM3U\n#EXT-X-ENDLIST\n");
    },
    shouldAbort: () => true,
    onProgress: () => {},
  }), (error) => error && error.name === "AbortError");
  assert.equal(fetchCount, 0);

  const sourceUrl = "https://no-retry.example/media.m3u8";
  const segmentUrl = "https://no-retry.example/one.ts";
  const calls = [];
  const fetchArrayBuffer = makeFetch(new Map([
    [sourceUrl, "#EXTM3U\n#EXTINF:4,\none.ts\n#EXT-X-ENDLIST\n"],
    [segmentUrl, new Error("failed to fetch")],
  ]), calls);
  await assert.rejects(createAssembler()({
    kind: "hls",
    sourceUrl,
    selection: null,
    segmentConcurrency: 2,
    fetchArrayBuffer,
    shouldAbort: () => false,
    onProgress: () => {},
  }));
  assert.deepEqual(calls, [[sourceUrl], [segmentUrl]]);
});
