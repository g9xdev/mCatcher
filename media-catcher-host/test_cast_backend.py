"""Contract tests for the CastBackend socket (Task C4).

The socket only pays off if a concrete backend really implements ALL of it and
`get_backend()` can never take casting out — a typo in the config file, or a
missing engine module in phase M, must degrade to legacy rather than crash.
Run: python -m pytest test_cast_backend.py -q  (or directly: py test_cast_backend.py)
"""
import inspect
import os

from conftest import load_host

mc_host = load_host()          # registers the canonical shim (alias rule)

from mchost.cast import backend as backend_mod          # noqa: E402
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
    b = backend_mod.get_backend()
    assert isinstance(b, LegacyBackend) and b.name == "legacy"
    assert backend_mod.get_backend() is b, "get_backend() did not cache the instance"


def test_unknown_backend_value_falls_back_to_legacy(monkeypatch):
    monkeypatch.setattr(backend_mod, "_BACKEND", None)
    monkeypatch.setattr(mc_host, "load_config", lambda: {"castBackend": "no-such-thing"})
    assert isinstance(backend_mod.get_backend(), LegacyBackend)


def test_missing_engine_backend_falls_back_to_legacy(monkeypatch):
    # phase M's module does not exist yet: asking for it must not crash.
    monkeypatch.setattr(backend_mod, "_BACKEND", None)
    monkeypatch.setattr(mc_host, "load_config", lambda: {"castBackend": "engine"})
    assert isinstance(backend_mod.get_backend(), LegacyBackend)


def test_unreadable_config_falls_back_to_legacy(monkeypatch):
    monkeypatch.setattr(backend_mod, "_BACKEND", None)

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
    sent = []
    monkeypatch.setattr(mc_host, "send", sent.append)
    backend_mod.get_backend().events({"type": "cast-status", "state": "loading"})
    assert sent == [{"type": "cast-status", "state": "loading"}]


def test_cast_error_is_an_exception_carrying_its_message():
    assert issubclass(CastError, Exception)
    assert str(CastError("Couldn't set up AirPlay support.")) == \
        "Couldn't set up AirPlay support."


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([os.path.abspath(__file__), "-q"]))
