"""Structured logging + durable update history (moved verbatim from mc_host.py — Task C1).

Patched/cross-module names (send, _hlog) resolve through the mc_host shim at
CALL time (`_h.send`, `_h._hlog`) so monkeypatched fakes are always honored —
the splitting-modules-under-monkeypatch rule. _log_lock and the two path
constants are owned here; nothing outside this module uses them.
"""
import json
import os
import threading
import time

import mc_host as _h
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


def _now_ms():
    return int(time.time() * 1000)


def _hlog(level, msg, src="host"):
    """Emit one structured log line: to the extension for the live console, and to
    a rolling on-disk file for after-the-fact inspection. Never raises."""
    try:
        _h.send({"type": "log", "ts": _now_ms(), "level": level, "src": src, "msg": str(msg)})
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
        _h.send({"type": "update-event", "event": rec})
    except Exception:
        pass
    bad = outcome in ("verify-failed", "reverted", "error", "guardian-did-not-run")
    arrow = (" %s→%s" % (frm or "?", to or "?")) if (frm or to) else ""
    _h._hlog("error" if bad else "info",
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
