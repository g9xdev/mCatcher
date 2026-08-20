(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.McBeamHeaders = api;
})(
  typeof self !== "undefined" ? self :
  (typeof globalThis !== "undefined" ? globalThis : this),
  function () {
  "use strict";

  // ------------------------------------------------------------------------
  // The SIGN-IN a beam carries.
  //
  // A beam is fetched outside the browser: the host hands an address to
  // BadApple, which opens it from its own process, where none of the browser's
  // request context applies. A stream behind a login, or behind ordinary
  // hotlink protection, therefore answers 403 to a beam that carries nothing —
  // and a 403 on a stream that plays fine in the tab reads to the user as a
  // broken feature rather than a missing credential.
  //
  // So the beam carries what this extension already knows about the request the
  // browser made. It is composed HERE rather than at the send site so that the
  // allowlist is one list, in one file, with tests on it.
  // ------------------------------------------------------------------------

  // Exactly BadApple's set, in exactly BadApple's casing — their engine keys
  // its map on these spellings (serving.normalize_beam_headers) and their shell
  // refuses everything else by name (BeamHeaders.Allowed).
  //
  // COOKIE IS IN THE LIST AND IS NEVER COMPOSED BY build(). That is not an
  // oversight, and it is worth writing down so nobody "fixes" it:
  //
  //   - Reading real session cookies needs the `cookies` permission. This
  //     extension's manifest does not request it, and asking a user to grant a
  //     new permission is not something a feature should do on their behalf.
  //   - `document.cookie` from the content script would NOT be a substitute.
  //     It cannot see HttpOnly cookies, and a session cookie for a gated stream
  //     is HttpOnly essentially always. So it would yield a partial credential
  //     that looks like a credential — the beam would be sent, reported as
  //     sent, and still answer 403. BadApple's own contract names that failure
  //     mode: "a beam that silently loses its sign-in reports the origin's 403
  //     as if the stream itself were broken."
  //
  // The name stays in ALLOWED because ALLOWED is a statement about what the far
  // end accepts, which is what a future change would need to be checked
  // against. What this module SENDS is decided by build() alone.
  var ALLOWED = ["Cookie", "Referer", "User-Agent"];

  // C0, DEL and C1. CR and LF are the ones that matter — they are how one
  // header becomes two of the caller's choosing — but this is the same class
  // the router's isSafeHttpContextString already refuses on the download lane,
  // and one character class across both lanes is one thing to reason about.
  // The host refuses C0 and DEL again, and BadApple refuses CR/LF/NUL a third
  // time; each layer is deliberately no LOOSER than the one behind it.
  var CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

  function sendableValue(value) {
    if (typeof value !== "string" || !value) return "";
    if (CONTROL_RE.test(value)) return "";
    return value;
  }

  // A Referer is only worth sending when it is the kind of address an origin
  // could act on. A frame's location can genuinely be about:blank, a
  // moz-extension: page (which names this installation), a file: path or a
  // blob:, and none of those is a credential — moz-extension: is a small
  // privacy leak besides.
  function sendableReferer(value) {
    var clean = sendableValue(value);
    if (!clean || clean !== clean.trim()) return "";
    if (!/^https?:\/\//i.test(clean)) return "";
    try {
      var parsed = new URL(clean);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    } catch (e) {
      return "";
    }
    return clean;
  }

  // ------------------------------------------------------------------------
  // build — the sign-in for one beam, or null.
  //
  // NULL, NOT {}. BadApple branches on whether the field is PRESENT, and every
  // beam predating this feature sends no field at all: "it must not be spelled
  // as an empty object". So the caller writes the field only when this returns
  // something, and nothing here can produce an empty object to write.
  //
  // Named fields are READ off the input; the input is never copied. That is
  // what makes a fourth name unsmugglable — an object carrying Authorization
  // contributes no Authorization, because nothing reads that key.
  // ------------------------------------------------------------------------
  function build(context) {
    if (!context || typeof context !== "object") return null;

    var out = {};
    var referer = "";
    var userAgent = "";
    try {
      referer = sendableReferer(context.referer);
      userAgent = sendableValue(context.userAgent);
    } catch (e) {
      // A getter that throws is a context that offers nothing, not a crash on
      // the click path.
      return null;
    }

    if (referer) out.Referer = referer;
    if (userAgent) out["User-Agent"] = userAgent;

    // Object.keys, not a truthiness check on `out`: {} is truthy, and shipping
    // it would be exactly the empty object the contract refuses.
    return Object.keys(out).length ? out : null;
  }

  return Object.freeze({
    ALLOWED: Object.freeze(ALLOWED.slice()),
    build: build,
  });
});
