"""Structured logging + durable update history (moved verbatim from mc_host.py — Task C1).

Patched/cross-module names (send, _hlog) resolve through the mc_host shim at
CALL time (`_h().send`, `_h()._hlog`) so monkeypatched fakes are always honored —
the splitting-modules-under-monkeypatch rule. _log_lock and the two path
constants are owned here; nothing outside this module uses them.
"""
import json
import os
import re
import threading
import time
import urllib.parse

def _h():
    """Call-time shim lookup (review of b9043cd, Important): a module-level
    `import mc_host` broke package-first import order (import mchost.hlog
    before mc_host -> ImportError from the partially-initialised shim).
    sys.modules caches the shim, so this is a dict hit per call."""
    import mc_host
    return mc_host
from mchost.tools import HERE, TMPDIR

# ---- diagnostics: structured logging + durable update history ------------
# Everything the Settings "Log console" and "Update history" panels show comes
# from here. _hlog streams a line to the extension (live console) and appends to
# a rolling file; _log_event records a durable history entry (what changed, when,
# from where, and how it turned out) so a FAILED update explains itself instead of
# vanishing silently — the gap that let the guardian bug hide for so long.
_HOST_LOG = os.path.join(TMPDIR, "host.log")
_HISTORY_PATH = os.path.join(HERE, "update-history.jsonl")
_log_lock = threading.Lock()

# ---- log redaction ------------------------------------------------------
# Applied at the _hlog SEAM, so both sinks say the same thing. The extension
# already redacts what it puts in storage.local (media-catcher/lib/privacy.js
# redactLogText), but the disk copy kept the full URL, query and all, and that
# is the copy a user hands over when they are asked for "the helper log".
# Nothing in this host SERVES that file -- getReport does not include it and
# the Settings console is fed by the {"type":"log"} relay -- so redacting it
# is not closing a remote read; it is making the one file that leaves the
# machine safe to hand over without a warning label attached.
#
# The projection is the extension's redactUrlForLog: scheme://host[:port]/path,
# with userinfo and fragment dropped and, of the query, only the identity
# parameters named below. Query strings on a media URL are where the signed
# token lives; what survives (which CDN, which file, which video) is what the
# line was worth reading for. Local save paths and everything else are kept.
# "Matches" is about the RULES -- same names, same cap, same charset, same
# credential pattern -- not about byte-identical spelling. The extension
# parses with URL and this parses with urlsplit, so a bare origin gains a
# trailing slash there and not here; and where the extension falls back to a
# manual strip on a URL its parser rejects, this fails closed to [redacted].
# Both differences are the host redacting MORE or the same, never less, which
# is the direction that matters for the copy a user hands over.
# Running before the send too means the host never puts a raw URL on the wire,
# and the extension's pass over an already-redacted line is a no-op.
#
# Update history (_log_event / _HISTORY_PATH) is deliberately NOT projected:
# its `source` is a release location, not a credentialed media URL, and the
# panel exists to say where an update came from. Only the line it mirrors
# through _hlog is redacted.
# The match runs to WHITESPACE, not to the first quote or angle bracket: host
# lines carry yt-dlp's own spelling rather than a browser-canonicalised URL, so
# an unencoded quote inside a query would otherwise end the match and leave the
# credential after it standing in the line. Trailing wrappers and sentence
# punctuation are put back afterwards so a quoted or sentence-final URL still
# reads as one.
_URL_IN_TEXT = re.compile(r"https?://\S+", re.I)
_URL_TAIL_PUNCT = re.compile(r"['\">.,;:!?)\]}]+$")

# The query parameters that say WHICH media a line is about. A closed
# allowlist, mirroring media-catcher/lib/privacy.js LOG_IDENTITY_PARAMS:
# Signature, token, sig, key and expire are not in it and cannot be added by a
# site, and a name nobody has vetted is dropped rather than kept.
#
# Keeping them has to happen HERE as well as there. Redaction runs before the
# send, so the extension's redactLogText only ever sees an already-projected
# host line and cannot restore what this dropped: without the allowlist on
# this side, two googlevideo 403s for two different files both arrive as one
# .../videoplayback line and the allowlist works only for the lines the
# extension writes itself.
_LOG_IDENTITY_PARAMS = ("v", "id")
# A media id is a short plain identifier: YouTube's v is 11 characters,
# googlevideo's id is 16. The cap is headroom over those, and it bounds the
# risk rather than removing it -- [A-Za-z0-9_.~-] is also the alphabet of a
# base64url or hex token, so a provider that spells a signed link
# id=<signature> has that value kept. At 64 a whole hex HMAC or a 256-bit
# base64url token fitted; at 24 neither does. A separator that could nest a
# second query fails closed at the pattern below.
_LOG_IDENTITY_VALUE_MAX = 24
_LOG_IDENTITY_VALUE_RE = re.compile(r"[A-Za-z0-9_.~-]+")

# Second, independent pass: the VALUE of a credential-shaped parameter name,
# wherever it appears, in a URL or not. Whitespace being the URL boundary, a
# URL yt-dlp printed with a raw space in it is projected only up to that space
# and the tail carrying the Signature stays in the line as loose text; this
# redacts that tail without any boundary having to be decided.
#
# A blocklist, and deliberately never the only defence -- _redact_url's
# allowlist still decides what survives of anything that parses as a URL.
#
# It is additive, so it can only remove MORE than the projection does --
# including, sometimes, a diagnostic the projection deliberately kept. A
# name=value inside a path is claimed like any other: /token=1/clip.mp4 and
# /token=2/clip.mp4 both end as /token=[redacted], because the value runs to
# the next &, whitespace, quote or angle bracket and a path separator is none
# of those. That is a price, not an accident: a token in a path segment is a
# real spelling, so most of what looks like a false positive is what this pass
# is for. What it costs is pinned in the tests rather than argued away here.
#
# The name must match WHOLE: a preceding name character means no match, so
# monkey=, passwordless= and Key-Pair-Id= are untouched. Alternation order is
# longest-first among overlapping names (signature before sig, expires before
# expire) because first match wins. A quoted value counts as a value --
# token="S" and 'token': 'S' are both credentials -- and a ':' separator is
# claimed only when the value is quoted, so an "Expires: Thu, 01 Dec" header
# keeps its shape. The CLOSING quote is optional because THIS host manufactures
# the line that needs it: downloads.py logs str(e)[:500] and a joined stderr
# tail cut at 2000, and the cut lands before _hlog redacts, so a yt-dlp header
# dump arrives as {"token": "SECRET with the closing quote gone. Requiring it
# sent that line to host.log untouched. The unclosed alternative is reached
# only when no closing quote follows at all, so it takes the rest of the line
# -- over-redacting a truncated diagnostic, the direction this pass accepts.
#
# Mirrors media-catcher/lib/privacy.js redactCredentialValues, down to the
# pattern. The two are kept in step deliberately: the point of redacting here
# is that the disk copy and the extension's copy say the same thing.
_LOG_CREDENTIAL_VALUE = re.compile(
    r"(^|[^A-Za-z0-9_-])"
    r"(x-amz-security-token|x-amz-credential|x-amz-signature|signature|"
    r"password|expires|policy|expire|token|auth|pwd|sig|key)"
    r"([\"']?\s*(?:=|:(?=\s*[\"']))\s*)"
    r"(\"[^\"]*\"?|'[^']*'?|[^&\s\"'<>]+)", re.I)


def _redact_one_credential(m):
    """Replace a matched credential value, keeping the quotes it was written
    with so the line still reads as that name's value."""
    lead, name, sep, value = m.group(1), m.group(2), m.group(3), m.group(4)
    quote = value[0] if value[:1] in ('"', "'") else ""
    return "%s%s%s%s[redacted]%s" % (lead, name, sep, quote, quote)


def _identity_query(query):
    """The allowlisted part of `query`, as "?v=…[&id=…]" or "".

    Emitted in _LOG_IDENTITY_PARAMS order, not the site's, so one URL always
    projects to one line whatever order its query was written in. First value
    per name, matching URLSearchParams.get. fullmatch, not a $-anchored match:
    Python's $ also matches before a trailing newline and JavaScript's does
    not, so "?v=abc%0A" would otherwise survive here and be dropped there.
    """
    try:
        pairs = urllib.parse.parse_qsl(query, keep_blank_values=True)
    except Exception:
        return ""
    first = {}
    for name, value in pairs:
        first.setdefault(name, value)
    kept = ""
    for name in _LOG_IDENTITY_PARAMS:
        value = first.get(name)
        if not value or len(value) > _LOG_IDENTITY_VALUE_MAX:
            continue
        if not _LOG_IDENTITY_VALUE_RE.fullmatch(value):
            continue
        kept += ("&" if kept else "?") + name + "=" + value
    return kept


def _redact_url(url):
    """scheme://host[:port]/path[?v=…[&id=…]] — userinfo and fragment dropped,
    and of the query only the identity parameters."""
    try:
        parts = urllib.parse.urlsplit(url)
        host = parts.hostname or ""
        if not host:
            return "[redacted]"
        if ":" in host:                       # IPv6 literal
            host = "[%s]" % host
        port = parts.port                     # raises on a malformed port
        if port is not None:
            host = "%s:%d" % (host, port)
        return "%s://%s%s%s" % (parts.scheme.lower(), host, parts.path,
                                _identity_query(parts.query))
    except Exception:
        # Never echo the input on a parse failure — that is the leak itself.
        return "[redacted]"


def _redact_log_text(msg):
    """Every absolute http(s) URL in a log line, replaced by its projection.

    Trailing sentence punctuation is put back so a URL ending a sentence still
    reads as one. Never raises: a line that cannot be projected is dropped to
    a fixed marker rather than passed through.
    """
    try:
        text = msg if isinstance(msg, str) else str(msg)
    except Exception:
        return "[unprintable]"

    def one(m):
        hit = m.group(0)
        tail = _URL_TAIL_PUNCT.search(hit)
        trailing = ""
        if tail:
            trailing = tail.group(0)
            hit = hit[:len(hit) - len(trailing)]
        return _redact_url(hit) + trailing

    try:
        projected = _URL_IN_TEXT.sub(one, text)
        return _LOG_CREDENTIAL_VALUE.sub(_redact_one_credential, projected)
    except Exception:
        return "[redacted]"


def _now_ms():
    return int(time.time() * 1000)


def _hlog(level, msg, src="host"):
    """Emit one structured log line: to the extension for the live console, and to
    a rolling on-disk file for after-the-fact inspection. Never raises.

    URLs are projected once, HERE, so the wire copy and the disk copy carry the
    same text — see the redaction note above."""
    msg = _redact_log_text(msg)
    try:
        _h().send({"type": "log", "ts": _now_ms(), "level": level, "src": src, "msg": msg})
    except Exception:
        pass
    try:
        with _log_lock:
            if os.path.exists(_HOST_LOG) and os.path.getsize(_HOST_LOG) > 512 * 1024:
                # keep the last ~half when it grows past 512 KB
                try:
                    with open(_HOST_LOG, "r", encoding="utf-8", errors="replace") as f:
                        tail = f.readlines()[-1500:]
                    with open(_HOST_LOG, "w", encoding="utf-8") as f:
                        f.writelines(tail)
                except Exception:
                    pass
            with open(_HOST_LOG, "a", encoding="utf-8") as f:
                f.write("%s  [%s/%s] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), src, level, msg))
    except Exception:
        pass


def _log_event(component, outcome, frm=None, to=None, source=None, detail=None):
    """Record a durable update-history entry and mirror it to the live console."""
    rec = {"ts": _now_ms(), "component": component, "outcome": outcome,
           "from": frm, "to": to, "source": source, "detail": detail}
    try:
        with _log_lock:
            # Cap growth (repeated 'update-available' checks would otherwise append forever).
            if os.path.exists(_HISTORY_PATH) and os.path.getsize(_HISTORY_PATH) > 256 * 1024:
                try:
                    with open(_HISTORY_PATH, "r", encoding="utf-8", errors="replace") as f:
                        tail = f.readlines()[-1500:]
                    with open(_HISTORY_PATH, "w", encoding="utf-8") as f:
                        f.writelines(tail)
                except Exception:
                    pass
            with open(_HISTORY_PATH, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec) + "\n")
    except Exception:
        pass
    try:
        _h().send({"type": "update-event", "event": rec})
    except Exception:
        pass
    bad = outcome in ("verify-failed", "reverted", "error", "guardian-did-not-run")
    arrow = (" %s→%s" % (frm or "?", to or "?")) if (frm or to) else ""
    _h()._hlog("error" if bad else "info",
             "update: %s %s%s%s%s" % (component, outcome, arrow,
                                      (" via %s" % source) if source else "",
                                      (" — %s" % detail) if detail else ""))


def _read_history(limit=200):
    out = []
    try:
        with open(_HISTORY_PATH, "r", encoding="utf-8") as f:
            for ln in f:
                ln = ln.strip()
                if ln:
                    try:
                        out.append(json.loads(ln))
                    except Exception:
                        pass
    except Exception:
        pass
    return out[-limit:]
