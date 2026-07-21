"""Per-variant config persistence (moved verbatim from mc_host.py — Task C1).

Every cross-function reference goes through the mc_host shim at CALL time:
tests monkeypatch mc_host._config_path (test_update.py:75) and rely on
load_config/save_config honoring the fake — a local call would silently write
the developer's real mc_config_*.json. HERE lives in mchost.tools and
_variant_key in mchost.variant; both are read off the shim for the same
call-time-resolution reason.
"""
import json
import os

import mc_host as _h


# Config is keyed per Firefox variant (Developer / Nightly / release) so several
# Firefoxes sharing one native-host registration don't clobber each other's
# settings. _variant_key() lives with the process-tree helpers (mchost.variant).
def _config_path():
    return os.path.join(_h.HERE, "mc_config_%s.json" % _h._variant_key())


def load_config():
    try:
        with open(_h._config_path(), "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_config(cfg):
    try:
        with open(_h._config_path(), "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
    except Exception:
        pass
