"use strict";
//
// Capturing a preview frame IN THE PAGE.
//
// The capture happens here rather than in the helper because the helper would
// otherwise have to fetch the stream URL itself — a second, unauthenticated
// fetch of an address the browser already has decoded pixels for. The <video>
// element is already showing the frame; drawing it costs no request at all.
//
// Two properties are the reason this file exists.
//
// SEEKING. `video.currentTime = n` on an element a person is watching moves
// THEIR playback. The frame that is wanted is the one already on screen, so
// the capture reads and never writes. The tests below hand in a video whose
// currentTime setter throws, so an implementation that seeks cannot pass.
//
// TAINT. A <video> whose media came from another origin without CORS marks the
// canvas it is drawn into as tainted, and toDataURL then throws SecurityError
// rather than returning anything. For a media-catching extension that is the
// COMMON case, not an error: the whole point is cross-origin streams. So it is
// caught, reported as why:"tainted", and the caller falls back to the per-tab
// page screenshot it already has.
//
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");

function load() {
  return loadLib("content.js");
}

// A <video> that is playing and decoded. `currentTime` is a getter-only
// accessor on purpose: assigning to it throws, which is what makes "does not
// seek" a property a test can enforce rather than a comment.
function video(over) {
  const v = Object.assign({
    paused: false, ended: false, readyState: 4,
    videoWidth: 1280, videoHeight: 720,
  }, over || {});
  let now = 12.5;
  Object.defineProperty(v, "currentTime", {
    get() { return now; },
    set() { throw new Error("SEEKED: the capture moved the viewer's playback"); },
    enumerable: true, configurable: true,
  });
  return v;
}

// A canvas that records what was drawn and answers a plausible data URL.
function canvasFactory(options) {
  const opts = options || {};
  const made = [];
  const factory = () => {
    const calls = [];
    const c = {
      width: 0, height: 0, drawCalls: calls,
      getContext(kind) {
        if (opts.noContext) return null;
        assert.equal(kind, "2d");
        return { drawImage() { calls.push(Array.prototype.slice.call(arguments)); } };
      },
      toDataURL(type, quality) {
        c.lastType = type;
        c.lastQuality = quality;
        if (opts.taint) {
          const e = new Error("The operation is insecure.");
          e.name = "SecurityError";
          throw e;
        }
        if (opts.throwPlain) throw new Error("boom");
        if (opts.dataUrl !== undefined) return opts.dataUrl;
        // Length tracks the pixel count, so the size cap is exercised by a
        // canvas that behaves like a real one rather than by a magic string.
        const body = "A".repeat(Math.max(4, Math.floor(c.width * c.height / 40) * 4));
        return "data:image/jpeg;base64," + body;
      },
    };
    made.push(c);
    return c;
  };
  factory.made = made;
  return factory;
}

function capture(v, opts) {
  const { captureVideoFrame } = load();
  const o = Object.assign({ makeCanvas: canvasFactory() }, opts || {});
  return captureVideoFrame(v, o);
}

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

test("content.js exports captureVideoFrame", () => {
  const api = load();
  assert.equal(typeof api.captureVideoFrame, "function");
});

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

test("a playing video yields a jpeg data URL drawn from the element", () => {
  const makeCanvas = canvasFactory();
  const out = capture(video(), { makeCanvas });
  assert.equal(out.ok, true);
  assert.equal(out.why, null);
  assert.equal(out.dataUrl.slice(0, 23), "data:image/jpeg;base64,");

  const c = makeCanvas.made[0];
  assert.equal(c.lastType, "image/jpeg", "jpeg, not png: a png frame is far larger");
  assert.equal(c.lastQuality > 0.4 && c.lastQuality < 0.8, true,
    "a middling quality, measured: " + c.lastQuality);
  assert.equal(c.drawCalls.length, 1);
  assert.equal(c.drawCalls[0][0], out.source || c.drawCalls[0][0]);
});

test("the frame keeps the video's aspect ratio", () => {
  const makeCanvas = canvasFactory();
  capture(video({ videoWidth: 1280, videoHeight: 720 }), { makeCanvas });
  const c = makeCanvas.made[0];
  assert.equal(Math.abs((c.width / c.height) - (1280 / 720)) < 0.02, true,
    c.width + "x" + c.height);
});

test("a large video is scaled down, a small one is not scaled up", () => {
  const big = canvasFactory();
  capture(video({ videoWidth: 3840, videoHeight: 2160 }), { makeCanvas: big });
  assert.equal(big.made[0].width <= 640, true, "4k was capped: " + big.made[0].width);

  const small = canvasFactory();
  capture(video({ videoWidth: 160, videoHeight: 90 }), { makeCanvas: small });
  assert.equal(small.made[0].width, 160, "a small frame is captured at its own size");
});

// ---------------------------------------------------------------------------
// The two properties this file exists for
// ---------------------------------------------------------------------------

test("the capture never assigns currentTime", () => {
  // video()'s setter throws. Reaching ok:true is the proof.
  const out = capture(video());
  assert.equal(out.ok, true, "an implementation that seeks throws here instead");
});

test("a tainted canvas is reported as tainted, not as a crash", () => {
  const out = capture(video(), { makeCanvas: canvasFactory({ taint: true }) });
  assert.equal(out.ok, false);
  assert.equal(out.why, "tainted");
  assert.equal(out.dataUrl, null);
});

test("any other toDataURL failure is reported without a picture", () => {
  const out = capture(video(), { makeCanvas: canvasFactory({ throwPlain: true }) });
  assert.equal(out.ok, false);
  assert.equal(out.dataUrl, null);
  assert.equal(typeof out.why, "string");
  assert.notEqual(out.why, "tainted", "only a SecurityError is the taint case");
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test("a video that is not playing and decoded yields no frame", () => {
  const cases = [
    ["paused", { paused: true }],
    ["ended", { ended: true }],
    ["undecoded", { readyState: 1 }],
    ["audio-only", { videoWidth: 0 }],
    ["zero height", { videoHeight: 0 }],
  ];
  for (const [label, over] of cases) {
    const out = capture(video(over));
    assert.equal(out.ok, false, label);
    assert.equal(out.dataUrl, null, label);
    assert.equal(out.why, "no-frame", label);
  }
});

test("a missing element or 2d context yields no frame rather than throwing", () => {
  for (const v of [null, undefined, {}, 0, "x"]) {
    const out = capture(v);
    assert.equal(out.ok, false, String(v));
    assert.equal(out.dataUrl, null);
  }
  const out = capture(video(), { makeCanvas: canvasFactory({ noContext: true }) });
  assert.equal(out.ok, false);
  assert.equal(out.dataUrl, null);
});

test("a video whose properties throw yields no frame rather than throwing", () => {
  const hostile = {};
  Object.defineProperty(hostile, "paused", { get() { throw new Error("SECRET"); } });
  const out = capture(hostile);
  assert.equal(out.ok, false);
  assert.equal(out.dataUrl, null);
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

test("a data URL over the cap is dropped rather than returned", () => {
  const huge = "data:image/jpeg;base64," + "A".repeat(400000);
  const out = capture(video(), { makeCanvas: canvasFactory({ dataUrl: huge }) });
  assert.equal(out.ok, false, "an oversized picture is refused here, not passed on");
  assert.equal(out.dataUrl, null);
  assert.equal(out.why, "too-large");
});

test("a toDataURL answer that is not a jpeg data URL is refused", () => {
  for (const bad of ["", "not a url", "data:image/png;base64,AAAA",
                     "javascript:alert(1)", null, 42]) {
    const out = capture(video(), { makeCanvas: canvasFactory({ dataUrl: bad }) });
    assert.equal(out.ok, false, String(bad));
    assert.equal(out.dataUrl, null, String(bad));
  }
});

test("the returned data URL is one privacy.js will let through to the popup", () => {
  // The capture and the projection have to agree, or the picture is produced
  // and then silently dropped downstream. This is that agreement, measured.
  const { isSafePreviewDataUrl } = loadLib("lib/privacy.js");
  const out = capture(video());
  assert.equal(out.ok, true);
  assert.equal(isSafePreviewDataUrl(out.dataUrl), true);
});
