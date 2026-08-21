"""Shared pytest helpers for the host test suite.

load_host() is the ONE way tests load mc_host.py: importlib module_from_spec
with the module registered in sys.modules BEFORE exec_module. The old test
scripts skipped the registration, which meant a later `import mc_host` (or the
shim's canonical-module alias, once the package decomposition lands) would
create a SECOND module instance and split all patched/mutable state.

It also owns the ONE piece of durable state a test can otherwise write into
the source tree -- see _ledger_in_tmp_path below.
"""
import importlib.util
import os
import sys
import time

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
HOST = os.path.join(HERE, "mc_host.py")

# pytest inserts this directory for us under the default import mode; doing it
# here as well means the imports below do not depend on that.
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from mchost import written                                   # noqa: E402


# ---------------------------------------------------------------------------
# The written-files ledger never points into the source tree during a test run
#
# mchost/written.py defaults to tools.HERE/written-files.jsonl -- this
# directory, and on an installed copy the real record of the user's real
# downloads. Every lane that finishes a download calls written.record(), so a
# test that drives one WITHOUT redirecting the ledger appends a line to that
# file and never removes it. Before this fixture existed the file in this
# worktree held 882 lines of pytest tmp paths and grew by ~43KB per run.
#
# The redirect is autouse rather than opt-in on purpose: the tests that were
# writing there are the ones that never mention the ledger at all (ytdl, pget,
# filesink), so an opt-in fixture is exactly the thing they would not opt into.
# A test that wants a ledger it can read still overrides _PATH_OVERRIDE itself;
# monkeypatch layers on top of this one and unwinds in order.
# ---------------------------------------------------------------------------

PRODUCTION_LEDGER = written._DEFAULT_PATH


def production_ledger_state():
    """(mtime_ns, size) of the real ledger, or None when there is not one."""
    try:
        st = os.stat(PRODUCTION_LEDGER)
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return None


# Read at collection, before any test has had the chance to append.
PRODUCTION_LEDGER_AT_START = production_ledger_state()


@pytest.fixture(autouse=True)
def _ledger_in_tmp_path(tmp_path_factory, monkeypatch):
    """Every test gets a ledger of its own under pytest's basetemp.

    In a directory of its OWN, not inside the test's tmp_path: several tests
    assert on the exact contents of tmp_path after a download (there is one
    that reads `sorted(os.listdir(tmp_path)) == ["clip (1).mp4", "clip.mp4"]`),
    and a ledger dropped in beside the files under test is a file they can see.
    A test that wants to read the ledger points _PATH_OVERRIDE where it likes
    and layers over this.

    The teardown assertion is what makes this a check rather than a habit: any
    write that reaches PRODUCTION_LEDGER fails the test that made it, naming
    that test, instead of showing up as a file nobody notices growing.
    """
    monkeypatch.setattr(
        written, "_PATH_OVERRIDE",
        str(tmp_path_factory.mktemp("ledger") / "written-files.jsonl"))
    written.forget_cache()
    try:
        yield
    finally:
        written.forget_cache()
    assert production_ledger_state() == PRODUCTION_LEDGER_AT_START, (
        "this test wrote to the production written-files ledger at %s"
        % PRODUCTION_LEDGER)


def load_host(name="mc_host"):
    """Load mc_host.py under `name`, registered in sys.modules BEFORE exec —
    and IDEMPOTENT per name: every test file gets the SAME instance. Two
    loads under one name would leave sys.modules pointing at the second
    while earlier files patch the first — the exact split-instance hazard
    the canonical-alias rule exists to prevent (plan v4, round-2 C1). Tests
    mutate state only via monkeypatch, so sharing is safe.
    Safe at collection time: the host defers io init to main()."""
    if name in sys.modules:
        return sys.modules[name]
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
