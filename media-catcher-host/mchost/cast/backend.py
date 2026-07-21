"""CastBackend — the socket every casting implementation plugs into.

The engine merge (phase M) drops in as a second implementation; nothing
outside mchost/cast/ may import a concrete backend. Backends implement
TRANSPORT ONLY: the dispatcher (mchost/cast/__init__.py) keeps ownership of
protocol selection, discovery coalescing, teardown ordering, reply
correlation (reqId) and error normalization.

Interface v2 (plan round-1 review I3): a backend is constructed with an
`events` callback — the sink for every UNSOLICITED message (status pushes,
device updates, playback errors). Solicited replies are the dispatcher's job.
A backend signals a user-visible failure by raising CastError(msg); the
dispatcher maps that onto the existing cast-error wire shape (with reqId)
VERBATIM — CastError messages are already user-facing, so they are NOT run
through the _cast_err() rewriter that generic exceptions get.
"""


class CastError(Exception):
    """A user-visible casting failure. str(e) is the message sent verbatim."""


class CastBackend:
    name = "abstract"

    def __init__(self, events):
        # events(msg_dict) — the unsolicited-event sink (resident broadcast in
        # phase R; the shim's send() today).
        self.events = events

    def discover(self, timeout=5):            # -> list[device dict]
        raise NotImplementedError

    def seen_devices(self):                   # cache-only, no network
        raise NotImplementedError

    def start(self, req):                     # full cast-start request dict
        raise NotImplementedError

    def control(self, action, value=None):
        raise NotImplementedError

    def stop(self):
        raise NotImplementedError

    def pair_begin(self, device_id):          # -> bool needsPin
        raise NotImplementedError

    def pair_pin(self, pin):                  # -> bool ok
        raise NotImplementedError

    def pair_cancel(self):
        raise NotImplementedError

    def busy(self):                           # -> bool, a session is live
        raise NotImplementedError

    def shutdown(self):                       # process exit / backend swap
        raise NotImplementedError


def _h():
    """Call-time shim lookup (the convention every mchost module uses since
    the b9043cd review closure): a module-level `import mc_host` breaks
    package-first import order. sys.modules caches the shim, so this is a
    dict hit per call."""
    import mc_host
    return mc_host


def default_events(msg):
    """The dispatcher's event sink: unsolicited events go out through the
    shim's send() — looked up at CALL time so a monkeypatched send is always
    honored (and, from phase R on, so the resident can rebind it to a
    broadcast)."""
    _h().send(msg)


_BACKEND = None


def get_backend(events=None):
    """The process-wide backend, selected once from config `castBackend`
    ('legacy' default, 'engine' from phase M) and cached. The concrete module
    is imported HERE so mchost.cast never hard-imports an implementation.
    An unknown value falls back to legacy rather than crashing — a typo in
    the config file must never take casting out."""
    global _BACKEND
    if _BACKEND is None:
        choice = "legacy"
        try:
            choice = (_h().load_config().get("castBackend") or "legacy").lower()
        except Exception:
            pass
        if events is None:
            events = default_events
        if choice == "engine":
            try:
                from mchost.cast.engine_backend import EngineBackend   # phase M
                _BACKEND = EngineBackend(events)
            except Exception:
                _BACKEND = None
        if _BACKEND is None:
            from mchost.cast.legacy import LegacyBackend
            _BACKEND = LegacyBackend(events)
    return _BACKEND
