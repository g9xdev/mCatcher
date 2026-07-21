"""Shared pytest helpers for the host test suite.

load_host() is the ONE way tests load mc_host.py: importlib module_from_spec
with the module registered in sys.modules BEFORE exec_module. The old test
scripts skipped the registration, which meant a later `import mc_host` (or the
shim's canonical-module alias, once the package decomposition lands) would
create a SECOND module instance and split all patched/mutable state.
"""
import importlib.util
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
HOST = os.path.join(HERE, "mc_host.py")


def load_host(name="mc_host"):
    """Load mc_host.py fresh under `name`, registered in sys.modules first.
    Safe at collection time: the host defers io init to main()."""
    spec = importlib.util.spec_from_file_location(name, HOST)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod          # register BEFORE exec_module (alias rule)
    spec.loader.exec_module(mod)
    return mod


def wait_for(cond, timeout=2.0, interval=0.01):
    """Poll cond() until truthy or the deadline passes — never a bare sleep.
    Returns the final cond() result so callers can assert on it."""
    deadline = time.monotonic() + timeout
    while True:
        if cond():
            return True
        if time.monotonic() >= deadline:
            return bool(cond())
        time.sleep(interval)
