"""Contract tests for the CastBackend socket (Task C4).

The socket only pays off if a concrete backend really implements ALL of it and
`get_backend()` can never take casting out — a typo in the config file, or a
missing engine module in phase M, must degrade to legacy rather than crash.
Beyond the interface itself this file pins the three behaviours phase R
depends on: every UNSOLICITED event goes through the backend's events sink
(never a raw send), `start()` obeys its documented ordering, and a session
that ends by itself stops reporting busy().
Run: python -m pytest test_cast_backend.py -q  (or directly: py test_cast_backend.py)
"""
import inspect
import os
import sys
import threading
import types

import pytest

from conftest import load_host, wait_for

mc_host = load_host()          # registers the canonical shim (alias rule)

from mchost import cast as cast_mod                     # noqa: E402
from mchost.cast import backend as backend_mod          # noqa: E402
from mchost.cast import legacy as legacy_mod            # noqa: E402
from mchost.cast.backend import CastBackend, CastError  # noqa: E402
from mchost.cast.legacy import LegacyBackend            # noqa: E402


# The v2 interface (plan round-1 review I3). Pinned literally so a silent
# rename/removal fails here instead of at the first live cast.
INTERFACE = ["discover", "seen_devices", "start", "control", "stop",
             "pair_begin", "pair_pin", "pair_cancel", "busy", "shutdown"]


def _abstract_methods():
    """Methods CastBackend declares by raising NotImplementedError."""
    out = []
    for name, fn in vars(CastBackend).items():
        if not inspect.isfunction(fn) or name.startswith("__"):
            continue
        if "NotImplementedError" in inspect.getsource(fn):
            out.append(name)
    return sorted(out)


def _legacy_backend(monkeypatch, sink):
    """A LegacyBackend on `sink`, with legacy.py's module-level event sink
    restored afterwards — constructing one REBINDS it process-wide (that is
    the point: the moved poller bodies have no `self`), so a test that left
    its own list attached would silently swallow later tests' events."""
    monkeypatch.setattr(legacy_mod, "_EVENTS", legacy_mod._default_events)
    return LegacyBackend(sink)


def test_interface_is_exactly_the_v2_set():
    assert _abstract_methods() == sorted(INTERFACE)


def test_legacy_implements_every_method_with_a_real_body():
    # Kills: a backend that inherits (or re-raises) an abstract method — the
    # dispatcher would then blow up mid-cast with NotImplementedError, which
    # _cast_err() would render as a nonsense user message.
    for name in INTERFACE:
        fn = vars(LegacyBackend).get(name)
        assert fn is not None, "LegacyBackend does not implement %s()" % name
        assert fn is not vars(CastBackend)[name], "%s() is the abstract one" % name
        assert "NotImplementedError" not in inspect.getsource(fn), \
            "LegacyBackend.%s() still raises NotImplementedError" % name
        # same call shape as the interface it fills
        assert (list(inspect.signature(fn).parameters) ==
                list(inspect.signature(vars(CastBackend)[name]).parameters)), \
            "LegacyBackend.%s() signature drifted from the interface" % name


def test_get_backend_defaults_to_legacy_and_caches(monkeypatch):
    monkeypatch.setattr(backend_mod, "_BACKEND", None)
    monkeypatch.setattr(mc_host, "load_config", lambda: {})
    monkeypatch.setattr(legacy_mod, "_EVENTS", legacy_mod._default_events)
    b = backend_mod.get_backend()
    assert isinstance(b, LegacyBackend) and b.name == "legacy"
    assert backend_mod.get_backend() is b, "get_backend() did not cache the instance"


def test_configured_engine_backend_is_actually_selected(monkeypatch):
    # Kills: an implementation that ALWAYS returns Legacy — the fallback
    # tests below would all still pass for it. A stub engine module proves
    # the `castBackend: "engine"` branch really constructs and returns it.
    class EngineBackend(CastBackend):
        name = "engine"
    stub = types.ModuleType("mchost.cast.engine_backend")
    stub.EngineBackend = EngineBackend
    monkeypatch.setitem(sys.modules, "mchost.cast.engine_backend", stub)
    monkeypatch.setattr(backend_mod, "_BACKEND", None)
    monkeypatch.setattr(mc_host, "load_config", lambda: {"castBackend": "engine"})
    b = backend_mod.get_backend()
    assert isinstance(b, EngineBackend) and b.name == "engine", \
        "castBackend=engine did not select the engine backend: %r" % b
    # and it is handed the same unsolicited-event sink the legacy one gets
    sent = []
    monkeypatch.setattr(mc_host, "send", sent.append)
    b.events({"type": "cast-status", "state": "loading"})
    assert sent == [{"type": "cast-status", "state": "loading"}]


def test_unknown_backend_value_falls_back_to_legacy(monkeypatch):
    monkeypatch.setattr(backend_mod, "_BACKEND", None)
    monkeypatch.setattr(legacy_mod, "_EVENTS", legacy_mod._default_events)
    monkeypatch.setattr(mc_host, "load_config", lambda: {"castBackend": "no-such-thing"})
    assert isinstance(backend_mod.get_backend(), LegacyBackend)


def test_missing_engine_backend_falls_back_to_legacy(monkeypatch):
    # phase M's module does not exist yet: asking for it must not crash.
    monkeypatch.setattr(backend_mod, "_BACKEND", None)
    monkeypatch.setattr(legacy_mod, "_EVENTS", legacy_mod._default_events)
    monkeypatch.setattr(mc_host, "load_config", lambda: {"castBackend": "engine"})
    assert isinstance(backend_mod.get_backend(), LegacyBackend)


def test_unreadable_config_falls_back_to_legacy(monkeypatch):
    monkeypatch.setattr(backend_mod, "_BACKEND", None)
    monkeypatch.setattr(legacy_mod, "_EVENTS", legacy_mod._default_events)

    def _boom():
        raise RuntimeError("config on fire")
    monkeypatch.setattr(mc_host, "load_config", _boom)
    assert isinstance(backend_mod.get_backend(), LegacyBackend)


def test_events_sink_reaches_the_patched_shim_send(monkeypatch):
    # The sink is the ONLY path for unsolicited events; it must resolve send
    # at CALL time or a monkeypatched (or, from phase R, resident-broadcast)
    # send is bypassed.
    monkeypatch.setattr(backend_mod, "_BACKEND", None)
    monkeypatch.setattr(mc_host, "load_config", lambda: {})
    monkeypatch.setattr(legacy_mod, "_EVENTS", legacy_mod._default_events)
    sent = []
    monkeypatch.setattr(mc_host, "send", sent.append)
    backend_mod.get_backend().events({"type": "cast-status", "state": "loading"})
    assert sent == [{"type": "cast-status", "state": "loading"}]


def test_cast_error_is_an_exception_carrying_its_message():
    assert issubclass(CastError, Exception)
    assert str(CastError("Couldn't set up AirPlay support.")) == \
        "Couldn't set up AirPlay support."


# ---- the unsolicited-event sink (review of 4d26f8a, Critical) -------------
def test_module_sink_follows_the_constructed_backend(monkeypatch):
    # The moved poller/callback bodies are module-level and reach their sink
    # through legacy._emit(). Constructing a backend must point that at the
    # backend's own events, or every event AFTER the initial `loading` skips
    # the dispatcher's sink (in phase R: the resident's broadcast bus).
    got = []
    _legacy_backend(monkeypatch, got.append)
    legacy_mod._emit({"type": "cast-status", "state": "playing"})
    assert got == [{"type": "cast-status", "state": "playing"}]


def test_no_unsolicited_event_bypasses_the_sink():
    # Kills: a reintroduced `_h().send(...)` anywhere in the transport layer
    # — the exact defect the sink indirection exists to close. Solicited
    # replies live in the dispatcher, so legacy.py has no business sending.
    offenders = []
    for name, fn in vars(legacy_mod).items():
        if not inspect.isfunction(fn) or fn.__module__ != legacy_mod.__name__:
            continue
        if fn is legacy_mod._default_events:
            continue            # the ONE legitimate send: the default sink
        if "_h().send(" in inspect.getsource(fn):
            offenders.append(name)
    assert not offenders, \
        "these send events around the events sink: %r" % offenders


# ---- start() ordering (backend.py contract; review of aedec78, I1) -------
@pytest.mark.parametrize("protocol", ["dlna", "airplay"])
def test_start_emits_loading_before_transport_and_poller(monkeypatch, protocol):
    """The start() CONTRACT (backend.py): dependency setup -> `loading`
    status through events -> TRANSPORT call -> poller, IN THAT ORDER. A
    backend that skips the loading emission leaves the picker silent; one
    that starts the transport first can deliver a playback event (AirPlay's
    play_url error callback) or a poller status before the popup knows a
    cast began. Pinned for EVERY protocol — and for the engine backend
    (phase M), which must satisfy the same order.
    """
    order = []
    be = _legacy_backend(monkeypatch, lambda m: order.append("loading" if
                                                             m.get("state") == "loading"
                                                             else "event"))
    # Neutralize the transport: we are testing ORDER, not DLNA/pyatv I/O.
    monkeypatch.setattr(mc_host, "_dlna_start", lambda *a, **kw: order.append("transport"))
    monkeypatch.setattr(mc_host, "_dlna_start_poller", lambda *a, **kw: order.append("poller"))
    monkeypatch.setattr(mc_host, "ensure_pyatv", lambda: order.append("setup") or True)
    monkeypatch.setattr(mc_host, "_cast_start", lambda *a, **kw: None)
    monkeypatch.setattr(mc_host, "_cast_run", lambda *a, **kw: order.append("transport"))
    monkeypatch.setattr(mc_host, "_cast_start_poller", lambda *a, **kw: order.append("poller"))
    be.start({"protocol": protocol, "id": "dlna:192.0.2.10" if protocol == "dlna" else "atv1",
              "url": "http://x/v.mp4", "device": "TV", "title": "T"})
    assert "loading" in order, "start() emitted no loading status: %r" % order
    expect = ["loading", "transport", "poller"]
    if protocol == "airplay":
        expect.insert(0, "setup")       # ensure_pyatv is the dependency gate
    assert order == expect, "start() order violates the contract: %r" % order


# ---- session lifecycle: busy() after a natural end (review I2) -----------
def _airplay_poller_states(monkeypatch, states):
    """Run the REAL AirPlay poller over a scripted status sequence, with the
    pyatv event loop stubbed out."""
    seq = iter(states)
    monkeypatch.setattr(legacy_mod, "_cast_status_once",
                        lambda: next(seq, {"state": "idle"}))
    monkeypatch.setattr(legacy_mod, "_cast_teardown", lambda: "teardown")
    monkeypatch.setattr(legacy_mod, "_cast_run", lambda payload, timeout=None: payload)


def test_busy_is_false_after_a_poller_ends_naturally(monkeypatch):
    # Kills: pollers that `break` without clearing the session fields — busy()
    # then stayed true forever after a normal end of playback, and phase R's
    # drain/update admission would never reopen.
    events = []
    be = _legacy_backend(monkeypatch, events.append)
    _airplay_poller_states(monkeypatch, [{"state": "playing", "position": 1, "duration": 9},
                                         {"state": "idle"}, {"state": "idle"}])
    sent = []
    monkeypatch.setattr(mc_host, "send", sent.append)
    mc_host._CAST["kind"] = "airplay"
    legacy_mod._cast_start_poller("atv1", "Apple TV", "T")
    assert wait_for(lambda: not be.busy(), timeout=10), \
        "busy() still true after the poller ended: %r" % {
            k: mc_host._CAST.get(k) for k in ("kind", "poll")}
    assert mc_host._CAST.get("poll") is None and mc_host._CAST.get("kind") is None
    # and its status pushes went through the SINK, not the raw shim send
    assert [m for m in events if m.get("type") == "cast-status"], \
        "poller emitted no status through the events sink: %r" % events
    assert not sent, "poller bypassed the events sink: %r" % sent


def test_session_end_does_not_clobber_a_newer_session(monkeypatch):
    # The guard: a poller that exits AFTER a re-cast replaced it must leave
    # the new session's fields alone (explicit stop nulls "poll" itself, so
    # this is also what keeps the stop/teardown paths undisturbed).
    old, new = threading.Event(), threading.Event()
    monkeypatch.setitem(mc_host._CAST, "poll", new)
    monkeypatch.setitem(mc_host._CAST, "kind", "dlna")
    legacy_mod._cast_session_ended(old)
    assert mc_host._CAST["poll"] is new and mc_host._CAST["kind"] == "dlna"
    legacy_mod._cast_session_ended(new)
    assert mc_host._CAST["poll"] is None and mc_host._CAST["kind"] is None


# ---- discovery coalescing fan-out (review of aedec78, I3) ----------------
class _FakeBackend(CastBackend):
    """Discovery-only stand-in: blocks until released so a follower is
    guaranteed to attach to the in-flight scan."""
    name = "fake"

    def __init__(self, devices=None, error=None):
        CastBackend.__init__(self, lambda m: None)
        self.entered, self.release = threading.Event(), threading.Event()
        self.devices, self.error, self.scans = devices or [], error, 0

    def discover(self, timeout=5):
        self.scans += 1
        self.entered.set()
        self.release.wait(5)
        if self.error:
            raise self.error
        return self.devices

    def seen_devices(self):
        return []


def _lead(be):
    """Start `be`'s scan as the coalescing LEADER on its own thread."""
    out = {}

    def run():
        try:
            out["result"] = cast_mod._coalesced_discover(be, 5)
        except Exception as e:
            out["error"] = e
    t = threading.Thread(target=run, daemon=True)
    t.start()
    assert be.entered.wait(5), "leader scan never started"
    return t, out


def _handed_over():
    """Has a follower attached its deferred final to the in-flight scan?"""
    return wait_for(lambda: bool((cast_mod._SCAN["current"] or {}).get("late")),
                    timeout=2)


def test_bounded_waiter_gets_the_leaders_result_after_its_wait_expired():
    # Kills: dropping the leader's devices on the floor when the bounded wait
    # expires. The waiter must be handed the result LATE, not never.
    be = _FakeBackend(devices=[{"id": "dlna:10.0.0.1"}])
    t, _out = _lead(be)
    late = []
    with pytest.raises(cast_mod.DiscoverBusy):
        cast_mod._coalesced_discover(be, 5, wait=0.05,
                                     late=lambda r, e: late.append((r, e)))
    be.release.set()
    t.join(5)
    assert wait_for(lambda: late), "the leader never fanned its result out"
    assert late == [([{"id": "dlna:10.0.0.1"}], None)]
    assert be.scans == 1, "the follower ran a second scan"


def test_bounded_waiter_gets_the_leaders_exception():
    boom = RuntimeError("scan blew up")
    be = _FakeBackend(error=boom)
    t, out = _lead(be)
    late = []
    with pytest.raises(cast_mod.DiscoverBusy):
        cast_mod._coalesced_discover(be, 5, wait=0.05,
                                     late=lambda r, e: late.append((r, e)))
    be.release.set()
    t.join(5)
    assert isinstance(out.get("error"), RuntimeError)
    assert wait_for(lambda: late), "the leader never fanned its failure out"
    assert late == [(None, boom)]


def test_warm_follower_of_a_PLAIN_leader_still_gets_its_final(monkeypatch):
    # The whole point of the fan-out: a PLAIN discover leader emits ONLY its
    # own solicited cast-devices reply (reqId-correlated, connection-scoped
    # in the resident), so a warm follower past its bound would otherwise be
    # left with a stale cached final and never see the refresh.
    devices = [{"id": "dlna:10.0.0.7", "name": "TV"}]
    be = _FakeBackend(devices=devices)
    monkeypatch.setattr(backend_mod, "_BACKEND", be)
    # Bound of ZERO: the follower deterministically runs out of wait while the
    # leader is still blocked, so this really exercises the past-the-bound
    # path (a 50ms bound raced the release and usually got served in time).
    monkeypatch.setattr(cast_mod, "_WARM_WAIT", 0)
    sent = []
    monkeypatch.setattr(mc_host, "send", sent.append)
    cast_mod.handle_cast({"sub": "discover", "reqId": "plain1"})     # leader
    assert be.entered.wait(5), "leader scan never started"
    cast_mod.handle_cast({"sub": "discover", "reqId": "warm1", "warm": True})
    assert wait_for(lambda: any(m.get("type") == "cast-devices" and m.get("warm")
                                for m in sent), timeout=5), \
        "warm reply never arrived: %r" % sent
    assert _handed_over(), "the warm follower did not hand its final to the leader"
    be.release.set()
    assert wait_for(lambda: any(m.get("final") for m in sent), timeout=5), \
        "warm follower never got a final: %r" % sent
    finals = [m for m in sent if m.get("final")]
    assert len(finals) == 1 and finals[0]["devices"] == devices, \
        "warm final did not carry the leader's devices: %r" % finals
    assert not [m for m in finals if m.get("error")]
    assert be.scans == 1, "the warm follower ran its own scan"
    assert [m for m in sent if m.get("reqId") == "plain1"], "leader lost its reply"


def test_warm_follower_of_a_failing_plain_leader_gets_the_error(monkeypatch):
    be = _FakeBackend(error=RuntimeError("scan blew up"))
    monkeypatch.setattr(backend_mod, "_BACKEND", be)
    monkeypatch.setattr(cast_mod, "_WARM_WAIT", 0)
    sent = []
    monkeypatch.setattr(mc_host, "send", sent.append)
    cast_mod.handle_cast({"sub": "discover", "reqId": "plain2"})     # leader
    assert be.entered.wait(5), "leader scan never started"
    cast_mod.handle_cast({"sub": "discover", "reqId": "warm2", "warm": True})
    assert wait_for(lambda: any(m.get("type") == "cast-devices" and m.get("warm")
                                for m in sent), timeout=5)
    assert _handed_over(), "the warm follower did not hand its final to the leader"
    be.release.set()
    assert wait_for(lambda: any(m.get("final") for m in sent), timeout=5), \
        "warm follower never got a final: %r" % sent
    finals = [m for m in sent if m.get("final")]
    assert len(finals) == 1 and finals[0].get("error"), \
        "the leader's failure was not fanned out to the warm follower: %r" % finals
    # the warm worker itself must still emit no session-level cast-error
    assert not [m for m in sent if m.get("type") == "cast-error"
                and m.get("reqId") == "warm2"]


# ---- _CAST_SEEN ownership (review of aedec78, Minor 1) -------------------
def test_the_shim_binding_is_the_only_effective_cast_seen(monkeypatch):
    # Documented in legacy.py's docstring: the shim owns the cache, legacy's
    # global is only the seed handed over at import. Pinning it stops the
    # dual binding creeping back (a rebind of the wrong one is a silent no-op
    # that would make the warm-discovery tests fake-pass).
    import time as _t
    now = _t.time()
    monkeypatch.setattr(mc_host, "_CAST_SEEN",
                        {"10.0.0.1": {"d": {"id": "shim"}, "ts": now}})
    monkeypatch.setattr(legacy_mod, "_CAST_SEEN",
                        {"10.0.0.2": {"d": {"id": "legacy"}, "ts": now}})
    assert legacy_mod._cast_seen_devices(now) == [{"id": "shim"}], \
        "_cast_seen_devices did not read the shim's binding"


if __name__ == "__main__":
    raise SystemExit(pytest.main([os.path.abspath(__file__), "-q"]))
