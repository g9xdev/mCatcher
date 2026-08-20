"use strict";
//
// WHAT SIGN-IN a beam carries, and what it must never carry.
//
// A login-gated stream answers 403 to anyone who fetches it without the
// credential the browser had. The beam happens OUTSIDE the browser — the host
// hands the address to BadApple, which fetches it from its own process — so
// nothing the browser would have attached comes along by itself.
//
// BadApple accepts exactly three names (Cookie, Referer, User-Agent) and
// refuses every other BY NAME on both of its own sides. This module is the
// extension's copy of that rule, and these tests pin two things about it:
//
//   1. It never composes a name BadApple would refuse. The host refuses one
//      too, and so does BadApple's engine, and so does BadApple's shell — but
//      a refusal three layers down is a click that failed, so the answer is
//      not to send it in the first place.
//
//   2. ABSENT STAYS ABSENT. BadApple's contract is explicit that "it must not
//      be spelled as an empty object — the engine branches on the field's
//      presence, and absence is what every beam predating this feature sends."
//      So a page with nothing to offer must produce no field at all, which is
//      why build() answers null rather than {}.
//
// COOKIE IS DELIBERATELY NOT HERE, and the reason is a permission this
// extension does not hold — see the comment on ALLOWED in lib/beam-headers.js.
//
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");

function load() {
  return loadLib("lib/beam-headers.js");
}

const PAGE = "https://page.example/watch?v=1";
const UA = "Mozilla/5.0 (Windows NT 10.0; rv:142.0) Gecko/20100101 Firefox/142.0";

test("the allowlist is BadApple's three names in BadApple's casing", () => {
  const { ALLOWED } = load();
  assert.deepEqual(ALLOWED.slice().sort(), ["Cookie", "Referer", "User-Agent"]);
});

test("a page with a referer and a user agent produces both, canonically named", () => {
  const { build } = load();
  assert.deepEqual(build({ referer: PAGE, userAgent: UA }), {
    Referer: PAGE,
    "User-Agent": UA,
  });
});

test("nothing usable produces null, never an empty object", () => {
  const { build } = load();
  for (const input of [undefined, null, {}, { referer: "", userAgent: "" },
                       { referer: null, userAgent: undefined }]) {
    assert.equal(build(input), null,
      "absent must stay absent: " + JSON.stringify(input));
  }
});

test("one field present is enough, and the other is simply not written", () => {
  const { build } = load();
  assert.deepEqual(build({ referer: PAGE }), { Referer: PAGE });
  assert.deepEqual(build({ userAgent: UA }), { "User-Agent": UA });
});

test("a referer that is not an http(s) address is dropped, not sent", () => {
  const { build } = load();
  // These are all things a frame's location can really be. None of them is a
  // credential a CDN could use, and moz-extension: names this installation.
  for (const bad of ["about:blank", "moz-extension://abc/page.html",
                     "file:///C:/x.html", "data:text/html,x", "blob:https://a/b",
                     "javascript:1", "/relative/path", "page.example/watch"]) {
    assert.deepEqual(build({ referer: bad, userAgent: UA }), { "User-Agent": UA },
      "a non-http(s) referer must not travel: " + bad);
  }
});

test("a control character anywhere in a value drops that value", () => {
  const { build } = load();
  // CR and LF are how one header becomes two of the caller's choosing. The
  // host refuses these again and so does BadApple; this is the layer that
  // stops them being composed at all.
  for (const bad of ["a\rb", "a\nb", "a\u0000b", "a\u001bb", "a\u007fb"]) {
    assert.equal(build({ userAgent: bad }), null, "control char: " + JSON.stringify(bad));
    assert.deepEqual(build({ referer: PAGE, userAgent: bad }), { Referer: PAGE });
  }
});

test("a value that is not a string is dropped rather than coerced", () => {
  const { build } = load();
  // BadApple deserializes to Dictionary<string,string>; a number there is a
  // refused beam, so it must never be composed.
  assert.equal(build({ referer: 7, userAgent: { toString: () => UA } }), null);
});

test("a caller cannot smuggle a fourth name through the input object", () => {
  const { build } = load();
  // build() reads named fields; it does not copy the object. So an input
  // carrying Authorization produces no Authorization, whatever else it does.
  const out = build({
    referer: PAGE,
    Authorization: "Bearer SECRET",
    Cookie: "sid=SECRET",
    Host: "evil.example",
  });
  assert.deepEqual(out, { Referer: PAGE });
  assert.equal(JSON.stringify(out).includes("SECRET"), false);
});

test("the result is a plain own-property object BadApple can serialize", () => {
  const { build } = load();
  const out = build({ referer: PAGE, userAgent: UA });
  assert.deepEqual(Object.keys(out).sort(), ["Referer", "User-Agent"]);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
});

test("a __proto__ key in the input cannot pollute the result", () => {
  const { build } = load();
  const hostile = JSON.parse('{"referer":"' + PAGE + '","__proto__":{"Cookie":"x"}}');
  const out = build(hostile);
  assert.deepEqual(out, { Referer: PAGE });
  assert.equal({}.Cookie, undefined, "Object.prototype was not touched");
});
