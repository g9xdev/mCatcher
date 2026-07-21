"""LegacyBackend — today's DLNA/UPnP + AirPlay(pyatv) casting behind the
CastBackend socket (Task C4).

Step 1 (this commit) is the BINDING layer only: the transport functions still
live in the mc_host shim and are reached at CALL time through `_h()`, so the
monkeypatched fakes the warm-discovery tests install on the shim are honored
exactly as before. Step 2 moves the DLNA stack, the local media server and
the AirPlay stack into this module verbatim; the bindings below do not change
shape when that happens.

The backend implements TRANSPORT ONLY — the dispatcher (mchost/cast/
__init__.py) owns protocol selection, discovery coalescing, teardown
ordering, reply correlation and error normalization. Unsolicited events
(status pushes) go out through the `events` sink handed to the constructor;
user-visible failures are raised as CastError and normalized by the
dispatcher.
"""
from mchost.cast.backend import CastBackend, CastError


def _h():
    """Call-time shim lookup — see mchost/updates.py for the full rationale."""
    import mc_host
    return mc_host


class LegacyBackend(CastBackend):
    name = "legacy"

    def discover(self, timeout=5):
        # The union-of-recent-scans merge of the DLNA and AirPlay scans.
        return _h()._cast_merged_discover(timeout)

    def seen_devices(self):
        # Cache-only (no network) — the warm reply's source.
        return _h()._cast_seen_devices()

    def start(self, req):
        """The old handle_cast start arm, verbatim apart from the protocol
        being TOLD to us (dispatcher-selected) instead of re-derived."""
        h = _h()
        did = req.get("id") or ""
        dname = req.get("device", "")
        title = req.get("title", "")
        if req.get("protocol") == "dlna":
            h._dlna_start(did, req.get("url") or "", title)
            h._CAST["kind"] = "dlna"
            self.events({"type": "cast-status", "state": "loading", "id": did,
                         "device": dname, "title": title, "protocol": "dlna"})
            h._dlna_start_poller(did, dname, title)
        else:
            if not h.ensure_pyatv():
                raise CastError("Couldn't set up AirPlay support.")
            h._cast_run(h._cast_start(did, req.get("url") or ""), timeout=40)   # sets kind=airplay
            self.events({"type": "cast-status", "state": "loading", "id": did,
                         "device": dname, "title": title, "protocol": "airplay"})
            h._cast_start_poller(did, dname, title)

    def control(self, action, value=None):
        h = _h()
        if h._CAST.get("kind") == "airplay":
            h._cast_run(h._cast_control(action, value), timeout=15)
        else:
            h._dlna_control(action, value)

    def stop(self):
        # Tears down whichever protocol is live, plus the status poller.
        _h()._cast_stop_active()

    def pair_begin(self, device_id):
        h = _h()
        if not h.ensure_pyatv():
            raise CastError("Pairing needs AirPlay support — install failed.")
        return h._cast_run(h._cast_pair_begin(device_id), timeout=30)

    def pair_pin(self, pin):
        h = _h()
        return h._cast_run(h._cast_pair_pin(pin), timeout=30)

    def pair_cancel(self):
        h = _h()
        try:
            h._cast_run(h._cast_pair_cancel(), timeout=10)
        except Exception:
            pass

    def busy(self):
        """Is a cast session live? (Phase R feeds this to the resident-wide
        ActivityRegistry so a self-update can't swap code mid-playback.)"""
        cast = _h()._CAST
        return bool(cast.get("kind")) or bool(cast.get("poll"))

    def shutdown(self):
        """Process exit / backend swap: drop any pairing, then the session."""
        self.pair_cancel()
        try:
            self.stop()
        except Exception:
            pass
