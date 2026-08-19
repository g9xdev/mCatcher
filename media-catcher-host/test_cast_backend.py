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


def test_control_without_a_live_session_touches_no_transport(monkeypatch):
    """A control arriving after a session ended must reach NEITHER protocol.
    Before this fix `control` used an else-fallback to DLNA, so once `kind`
    was cleared (natural end or explicit stop) a pause replayed against the
    endpoint a PREVIOUS DLNA session left in _DLNA['ctrl'] — pausing the
    wrong TV."""
    calls = []
    monkeypatch.setattr(mc_host, "_CAST", {"kind": None, "poll": None})
    monkeypatch.setattr(mc_host, "_dlna_control", lambda *a, **kw: calls.append("dlna"))
    monkeypatch.setattr(mc_host, "_cast_control", lambda *a, **kw: calls.append("airplay"))
    monkeypatch.setattr(mc_host, "_cast_run", lambda *a, **kw: calls.append("airplay-run"))
    LegacyBackend(lambda m: None).control("pause")
    assert calls == [], "a control with no live session reached a transport: %r" % calls

    # ...and it still routes correctly WHILE a session is live (both kinds).
    mc_host._CAST["kind"] = "dlna"
    LegacyBackend(lambda m: None).control("pause")
    assert calls == ["dlna"], calls
    mc_host._CAST["kind"] = "airplay"
    LegacyBackend(lambda m: None).control("pause")
    assert calls == ["dlna", "airplay", "airplay-run"], calls


# ===========================================================================
# The DLNA control endpoint belongs to the device that answered
#
# _dlna_describe pins the description FETCH to the SSDP responder, then resolved
# <controlURL> with urljoin -- and urljoin against an ABSOLUTE url discards the
# base. A hostile MediaRenderer (or an SSDP spoofer) that answered with
# <controlURL>http://127.0.0.1:8080/…</controlURL> therefore got attacker-chosen
# SOAP XML POSTed to a loopback service by a user-privileged process.
# ===========================================================================

def _description(av_ctrl, rc_ctrl):
    return ('<?xml version="1.0"?>'
            '<root xmlns="urn:schemas-upnp-org:device-1-0"><device>'
            "<friendlyName>Living Room</friendlyName><modelName>X9</modelName>"
            "<serviceList>"
            "<service><serviceType>urn:schemas-upnp-org:service:AVTransport:1"
            "</serviceType><controlURL>%s</controlURL></service>"
            "<service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1"
            "</serviceType><controlURL>%s</controlURL></service>"
            "</serviceList></device></root>" % (av_ctrl, rc_ctrl))


class _FakeResponse:
    status = 200

    def __init__(self, body):
        self._body = body.encode("utf-8")

    def read(self, *a):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _describe_serving(monkeypatch, xml):
    """Point the description fetch at `xml` and record every SOAP POST."""
    import urllib.request
    posted = []

    class _Opener:
        def open(self, url, timeout=None):
            return _FakeResponse(xml)

    monkeypatch.setattr(legacy_mod, "_desc_opener", lambda: _Opener())
    monkeypatch.setattr(urllib.request, "urlopen",
                        lambda req, *a, **kw: posted.append(
                            req if isinstance(req, str) else req.full_url) or _FakeResponse(""))
    return posted


DEV = "192.168.7.50"
LOC = "http://192.168.7.50:1900/desc.xml"


@pytest.mark.parametrize("hostile", [
    "http://127.0.0.1:8080/evil",          # loopback service that trusts local callers
    "http://169.254.169.254/latest/meta",  # cloud metadata
    "https://attacker.example/collect",    # off-LAN entirely
    "file:///C:/Windows/win.ini",          # not even http
])
def test_control_url_on_another_host_is_never_posted_to(monkeypatch, hostile):
    posted = _describe_serving(monkeypatch, _description(hostile, hostile))
    d = legacy_mod._dlna_describe(LOC, expect_host=DEV)
    # Whatever the describe decides, no endpoint it hands back may be POSTed to
    # anywhere but the device that served the description.
    for key in ("avCtrl", "rcCtrl"):
        url = (d or {}).get(key)
        if url:
            legacy_mod._dlna_soap(url, "AVTransport", "Stop", "<InstanceID>0</InstanceID>")
    assert all(u.startswith("http://%s:" % DEV) for u in posted),         "SOAP was POSTed off the device that served the description: %r" % (posted,)


def test_relative_and_same_host_control_urls_still_work(monkeypatch):
    # The pin must not cost the normal case: relative paths (what nearly every
    # renderer emits) and an absolute URL back at the same device.
    _describe_serving(monkeypatch, _description(
        "/upnp/control/AVTransport1", "http://192.168.7.50:1900/upnp/control/RC1"))
    d = legacy_mod._dlna_describe(LOC, expect_host=DEV)
    assert d, "a well-formed description was rejected"
    assert d["avCtrl"] == "http://192.168.7.50:1900/upnp/control/AVTransport1"
    assert d["rcCtrl"] == "http://192.168.7.50:1900/upnp/control/RC1"


def test_a_control_url_on_another_port_of_the_same_device_is_kept(monkeypatch):
    # Deliberate: renderers do split description and control across ports, and
    # once the HOST is pinned a different port is still the attacker's own box.
    _describe_serving(monkeypatch, _description(
        "http://192.168.7.50:49152/ctrl", "http://192.168.7.50:49152/rc"))
    d = legacy_mod._dlna_describe(LOC, expect_host=DEV)
    assert d and d["avCtrl"] == "http://192.168.7.50:49152/ctrl"


def test_a_hostile_rendering_control_url_does_not_take_the_device_out(monkeypatch):
    # Only the offending endpoint is dropped: AVTransport is what casting needs.
    _describe_serving(monkeypatch, _description(
        "/upnp/control/AVTransport1", "http://127.0.0.1:8080/evil"))
    d = legacy_mod._dlna_describe(LOC, expect_host=DEV)
    assert d, "a good AVTransport was thrown away with the bad RenderingControl"
    assert d["rcCtrl"] is None, "the off-host RenderingControl survived"


def _one_shot_server(handler_body):
    """A real ThreadingHTTPServer on 127.0.0.1, stopped by the caller."""
    import http.server

    class H(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def do_GET(self):
            handler_body(self)

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def test_a_redirect_cannot_move_the_description_fetch_off_the_device():
    """The host pin is checked on the URL we ASK for. urlopen follows a 302 to
    anywhere, so without a no-redirect opener a device could answer its own
    LOCATION with `302 -> http://<internal>/` and the fetch itself is the SSRF —
    the GET has already happened by the time anything re-checks."""
    hits = []

    def victim(h):
        hits.append(h.path)
        body = b"<root/>"
        h.send_response(200)
        h.send_header("Content-Type", "text/xml")
        h.send_header("Content-Length", str(len(body)))
        h.end_headers()
        h.wfile.write(body)

    vic = _one_shot_server(victim)
    target = "http://localhost:%d/internal" % vic.server_address[1]

    def redirector(h):
        h.send_response(302)
        h.send_header("Location", target)
        h.send_header("Content-Length", "0")
        h.end_headers()

    red = _one_shot_server(redirector)
    try:
        loc = "http://127.0.0.1:%d/desc.xml" % red.server_address[1]
        out = legacy_mod._dlna_describe(loc, expect_host="127.0.0.1")
        assert out is None, "a redirected description was accepted"
        assert hits == [], "the description fetch followed a redirect to %r" % (hits,)
    finally:
        for s in (red, vic):
            s.shutdown()
            s.server_close()



# ===========================================================================
# Stop means the file stops being fetchable
#
# The cast media server binds 0.0.0.0 and hands out /m/<token>. stop() and
# shutdown() tore down the SESSION but never the server and never _DLNA["media"],
# so after the user pressed Stop the last cast file stayed downloadable from
# every host on the LAN until the next cast or process exit.
# ===========================================================================

def _live_cast(monkeypatch, tmp_path, payload=b"cast me"):
    """A running media server with one registered token. Returns (url, srv)."""
    import urllib.request
    monkeypatch.setattr(legacy_mod, "_DLNA",
                        dict(legacy_mod._DLNA, server=None, port=0, media={},
                             ctrl=None, rctrl=None))
    monkeypatch.setattr(mc_host, "_DLNA", legacy_mod._DLNA)
    monkeypatch.setattr(legacy_mod, "_lan_ip", lambda *a, **kw: "127.0.0.1")
    monkeypatch.setattr(legacy_mod, "_CAST", {"kind": None, "poll": None})
    monkeypatch.setattr(mc_host, "_CAST", legacy_mod._CAST)
    # shutdown() opens with pair_cancel(); there is no pyatv loop here and no
    # pairing to cancel, so the coroutine is closed rather than submitted.
    def _no_cast_loop(coro, timeout=None):
        try:
            coro.close()
        except Exception:
            pass
    monkeypatch.setattr(mc_host, "_cast_run", _no_cast_loop)
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(payload)
    url, _ct = legacy_mod._dlna_media_url(str(clip))
    assert urllib.request.urlopen(url, timeout=5).read() == payload,         "the media server did not serve the file it was handed"
    return url, legacy_mod._DLNA["server"]


def _unreachable(url):
    import urllib.error
    import urllib.request
    try:
        urllib.request.urlopen(url, timeout=3).read()
    except (urllib.error.URLError, ConnectionError, OSError):
        return True
    return False


@pytest.mark.parametrize("teardown", ["stop", "shutdown"])
def test_the_cast_file_is_not_fetchable_after_stop(monkeypatch, tmp_path, teardown):
    url, srv = _live_cast(monkeypatch, tmp_path)
    backend = _legacy_backend(monkeypatch, lambda m: None)
    getattr(backend, teardown)()
    assert legacy_mod._DLNA["media"] == {},         "the token map still resolves the last cast: %r" % (legacy_mod._DLNA["media"],)
    assert legacy_mod._DLNA["server"] is None, "the media server was left registered"
    assert _unreachable(url), "the cast file is still fetchable from the LAN after %s()" % teardown
    srv.server_close()      # no-op if the teardown already closed it


def test_stop_does_not_block_on_a_request_in_flight(monkeypatch, tmp_path):
    """server.shutdown() waits for serve_forever to return. ThreadingMixIn hands
    each request to its own thread so the accept loop is never the one blocked,
    and daemon_threads keeps server_close from joining them — this pins both, so
    a partially-read response cannot wedge Stop."""
    import socket
    url, srv = _live_cast(monkeypatch, tmp_path, payload=b"x" * (4 << 20))
    host, port = "127.0.0.1", legacy_mod._DLNA["port"]
    sock = socket.create_connection((host, port), timeout=5)
    try:
        path = url.split("/m/")[-1]
        crlf = chr(13) + chr(10)
        sock.sendall(("GET /m/%s HTTP/1.1%sHost: x%s%s"
                      % (path, crlf, crlf, crlf)).encode())
        assert sock.recv(64), "the server never started answering"   # headers only
        done = threading.Event()
        threading.Thread(
            target=lambda: (_legacy_backend(monkeypatch, lambda m: None).stop(),
                            done.set()), daemon=True).start()
        assert done.wait(20), "stop() did not return with a request in flight"
    finally:
        # Let the handler finish writing before the socket goes, so the test
        # does not manufacture the broken pipe it is not about.
        try:
            sock.settimeout(5)
            while sock.recv(65536):
                pass
        except Exception:
            pass
        sock.close()
        srv.server_close()


def test_a_second_cast_gets_a_working_server_again(monkeypatch, tmp_path):
    # The teardown must not be one-way: casting again has to rebuild the server.
    _live_cast(monkeypatch, tmp_path)
    _legacy_backend(monkeypatch, lambda m: None).stop()
    import urllib.request
    clip = tmp_path / "next.mp4"
    clip.write_bytes(b"second")
    url, _ct = legacy_mod._dlna_media_url(str(clip))
    try:
        assert urllib.request.urlopen(url, timeout=5).read() == b"second",             "the media server did not come back for the next cast"
    finally:
        legacy_mod._stop_media_server()


def test_cast_run_timeout_cancels_the_coroutine(monkeypatch):
    """_cast_run returned the TimeoutError and left the coroutine running, so a
    slow connect/pair_begin reported failure to the popup and then completed
    anyway — pairing a device the user had been told was unreachable."""
    import asyncio
    import concurrent.futures
    monkeypatch.setattr(legacy_mod, "_CAST", {"loop": None, "thread": None})
    state = {}

    async def slow():
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            state["cancelled"] = True
            raise
        state["completed"] = True

    try:
        with pytest.raises(concurrent.futures.TimeoutError):
            legacy_mod._cast_run(slow(), timeout=0.2)
        assert wait_for(lambda: state.get("cancelled"), timeout=5),             "the timed-out coroutine was never cancelled: %r" % (state,)
        assert not state.get("completed")
    finally:
        loop = legacy_mod._CAST.get("loop")
        if loop:
            loop.call_soon_threadsafe(loop.stop)



if __name__ == "__main__":
    raise SystemExit(pytest.main([os.path.abspath(__file__), "-q"]))
