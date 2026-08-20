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
# The projection matches the extension's: scheme://host[:port]/path, with
# userinfo, query and fragment dropped. Query strings on a media URL are where
# the signed token lives; what survives (which CDN, which file) is what the
# line was worth reading for. Local save paths and everything else are kept.
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

# Second, independent pass: the VALUE of a credential-shaped parameter name,
# wherever it appears, in a URL or not. Whitespace being the URL boundary, a
# URL yt-dlp printed with a raw space in it is projected only up to that space
# and the tail carrying the Signature stays in the line as loose text; this
# redacts that tail without any boundary having to be decided.
#
# A blocklist, and deliberately never the only defence -- _redact_url's
# allowlist still decides what survives of anything that parses as a URL.
# Being additive it can only remove more, never less, so it cannot take a
# diagnostic the projection preserves. The name must match WHOLE: a preceding
# name character means no match, so monkey=, passwordless= and Key-Pair-Id=
# are untouched. Alternation order is longest-first among overlapping names
# (signature before sig, expires before expire) because first match wins.
#
# Mirrors media-catcher/lib/privacy.js redactCredentialValues. The two are
# kept in step deliberately: the point of redacting here is that the disk copy
# and the extension's copy say the same thing.
_LOG_CREDENTIAL_VALUE = re.compile(
    r"(^|[^A-Za-z0-9_-])"
    r"(x-amz-security-token|x-amz-credential|x-amz-signature|signature|"
    r"password|expires|policy|expire|token|auth|pwd|sig|key)"
    r"=([^&\s\"'<>]+)", re.I)


def _redact_url(url):
    """scheme://host[:port]/path — userinfo, query and fragment dropped."""
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
        return "%s://%s%s" % (parts.scheme.lower(), host, parts.path)
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
        return _LOG_CREDENTIAL_VALUE.sub(r"\1\2=[redacted]", projected)
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
