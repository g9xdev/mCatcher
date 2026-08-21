"""The written-files ledger: what this host may later be asked to delete.

Why the ledger exists
---------------------
`delete` and `thumb` both take a caller-supplied path and do something
irreversible or file-reading with it. guard.refuse_open answers "is this the
SHAPE of a file this helper deals in"; it cannot answer "is this a file this
helper WROTE" -- a .mp4 the user recorded with another program has exactly the
same shape as one this host saved. The ledger is the second answer, and the
two together are what `delete` requires.

So the completeness of the ledger IS the security property on the permissive
side, and its completeness in the other direction is a usability one: a file
announced to the popup and missing from the ledger is a row the user can see
and cannot delete. test_every_frame_that_names_a_produced_file_records_it
below is the guard against both, and it is written against the AST rather than
against a list of line numbers because a list of line numbers is exactly what
undercounted these sites before.
"""
import ast
import io
import json
import os

import pytest

from conftest import load_host, wait_for

mc = load_host()

from mchost import written                       # noqa: E402
from mchost import downloads as d                # noqa: E402


HOSTDIR = os.path.dirname(os.path.abspath(__file__))
ANNOUNCERS = [os.path.join(HOSTDIR, "mchost", "downloads.py"),
              os.path.join(HOSTDIR, "mchost", "filesink.py")]


@pytest.fixture
def ledger(tmp_path, monkeypatch):
    """A ledger of this test's own, and no cached read carried into it."""
    path = tmp_path / "written-files.jsonl"
    monkeypatch.setattr(written, "_PATH_OVERRIDE", str(path))
    written.forget_cache()
    return path


# ---------------------------------------------------------------------------
# 1. The ledger itself
# ---------------------------------------------------------------------------

def test_a_recorded_file_is_known_and_an_unrecorded_one_is_not(ledger, tmp_path):
    mine = tmp_path / "clip.mp4"
    mine.write_bytes(b"x")
    theirs = tmp_path / "holiday.mp4"
    theirs.write_bytes(b"x")

    assert written.was_written(str(mine)) is False, "nothing is known yet"
    assert written.record(str(mine)) is True
    assert written.was_written(str(mine)) is True
    assert written.was_written(str(theirs)) is False, (
        "a file with the same shape that this host did not write stays unknown")


def test_a_record_outlives_the_process_that_wrote_it(ledger, tmp_path):
    """Durable: the answer comes off disk, not out of a live dict.

    forget_cache() stands in for a new host process -- it drops everything this
    module holds in memory, so the second answer can only have come from the
    file.
    """
    mine = tmp_path / "clip.mp4"
    mine.write_bytes(b"x")
    written.record(str(mine))

    lines = [l for l in ledger.read_text(encoding="utf-8").splitlines() if l.strip()]
    assert len(lines) == 1, lines
    assert json.loads(lines[0])["path"], "each line is one JSON object with a path"

    written.forget_cache()
    assert written.was_written(str(mine)) is True


def test_the_ledger_is_append_only(ledger, tmp_path):
    first = tmp_path / "a.mp4"
    second = tmp_path / "b.mp4"
    for p in (first, second):
        p.write_bytes(b"x")
        written.record(str(p))
    written.record(str(first))          # again: a re-save of the same name

    lines = [l for l in ledger.read_text(encoding="utf-8").splitlines() if l.strip()]
    assert len(lines) == 3, "every append is kept; nothing rewrites the file"
    written.forget_cache()
    assert written.was_written(str(first)) and written.was_written(str(second))


def test_one_file_spelled_two_ways_is_one_answer(ledger, tmp_path):
    """Windows compares paths case-insensitively and accepts either separator,
    so the popup's copy of a path and the host's own must not disagree."""
    mine = tmp_path / "Clip.MP4"
    mine.write_bytes(b"x")
    written.record(str(mine))

    assert written.was_written(str(mine).upper()) is True
    assert written.was_written(str(mine).replace("\\", "/")) is True


def test_a_corrupt_line_does_not_hide_the_records_around_it(ledger, tmp_path):
    """A truncated write (power loss mid-append) must cost one file, not all
    of them."""
    good = tmp_path / "good.mp4"
    good.write_bytes(b"x")
    with io.open(str(ledger), "a", encoding="utf-8") as fh:
        fh.write('{"path": "C:\\\\half-written\n')
        fh.write("not json at all\n")
    written.record(str(good))
    written.forget_cache()

    assert written.was_written(str(good)) is True


def test_nothing_shaped_wrong_is_ever_known(ledger):
    for bad in (None, "", "   ", 7, {"a": 1}, ["a"], b"a.mp4"):
        assert written.was_written(bad) is False, bad
        assert written.record(bad) is False, bad


def test_a_ledger_that_cannot_be_written_is_not_a_crash(tmp_path, monkeypatch):
    """The install directory can be read-only. record() answers False and the
    caller's download still completes -- the cost is that the file cannot
    later be deleted from the popup, which is the safe direction."""
    monkeypatch.setattr(written, "_PATH_OVERRIDE", str(tmp_path))   # a DIRECTORY
    written.forget_cache()
    mine = tmp_path / "clip.mp4"
    mine.write_bytes(b"x")

    assert written.record(str(mine)) is False
    assert written.was_written(str(mine)) is False


# ---------------------------------------------------------------------------
# 2. Every site that announces a produced file appends to it
#
# By AST, over the two modules that announce one. The shapes are the two the
# host actually uses: a frame literal carrying "type" and "file", and
# _pget_send_result's `msg["file"] = file`. A new announcer in either shape
# arrives here as a failure naming its line, which is the whole point -- the
# previous pass over this question was a list of line numbers, and it
# undercounted.
# ---------------------------------------------------------------------------

def _enclosing_functions(tree):
    out = {}

    def walk(node, chain):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                out[child] = chain + [child.name]
                walk(child, chain + [child.name])
            else:
                out[child] = chain
                walk(child, chain)
    walk(tree, [])
    return out


def _announce_sites(path):
    """(lineno, enclosing-function-node) for every frame naming a produced file."""
    tree = ast.parse(io.open(path, encoding="utf-8").read())
    enclosing = _enclosing_functions(tree)
    parents = {}

    def note_parents(node):
        for child in ast.iter_child_nodes(node):
            parents[child] = node
            note_parents(child)
    note_parents(tree)

    sites = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict):
            keys = [k.value for k in node.keys
                    if isinstance(k, ast.Constant) and isinstance(k.value, str)]
            if not ("file" in keys and "type" in keys):
                continue
        elif (isinstance(node, ast.Assign) and len(node.targets) == 1
              and isinstance(node.targets[0], ast.Subscript)
              and isinstance(node.targets[0].slice, ast.Constant)
              and node.targets[0].slice.value == "file"):
            pass
        else:
            continue
        # the nearest FunctionDef above this node
        owner = node
        while owner is not None and not isinstance(
                owner, (ast.FunctionDef, ast.AsyncFunctionDef)):
            owner = parents.get(owner)
        sites.append((node.lineno, owner, enclosing.get(owner, [])))
    return sites


def _records_to_the_ledger(func):
    for node in ast.walk(func):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "record"
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == "written"):
            return True
    return False


def test_every_frame_that_names_a_produced_file_records_it():
    missing = []
    counted = 0
    for path in ANNOUNCERS:
        for lineno, owner, chain in _announce_sites(path):
            counted += 1
            if owner is None or not _records_to_the_ledger(owner):
                missing.append("%s:%d (%s)" % (os.path.basename(path), lineno,
                                               " > ".join(chain) or "<module>"))
    assert counted >= 11, (
        "the walk found only %d announcing frames; it used to find 11, so "
        "either a lane was deleted or this walk stopped matching" % counted)
    assert missing == [], (
        "these frames tell the popup about a file the ledger never heard of, "
        "so the user cannot delete what they can see: %s" % missing)


# ---------------------------------------------------------------------------
# 3. Three of those sites, driven for real
#
# The AST test above pins that a record CALL is there; these pin that the call
# records the path the frame actually carried.
# ---------------------------------------------------------------------------

def _sent_files(sent):
    return [m.get("file") for m in sent if m.get("file")]


def test_a_saved_recording_is_in_the_ledger(ledger, tmp_path, monkeypatch):
    temp = tmp_path / "j.tmp"
    temp.write_bytes(b"x" * 32)
    job = d.Job("j-save", str(temp))
    with d.JOBS_LOCK:
        d.JOBS["j-save"] = job
    dest = tmp_path / "clip.mp4"
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)
    monkeypatch.setattr(d, "_h", lambda: mc)
    try:
        d._finalize_move(job, "j-save", str(dest))
    finally:
        with d.JOBS_LOCK:
            d.JOBS.pop("j-save", None)

    assert _sent_files(sent) == [str(dest)], sent
    assert written.was_written(str(dest)) is True


def test_a_snapshot_checkpoint_is_in_the_ledger(ledger, tmp_path, monkeypatch):
    temp = tmp_path / "j2.tmp"
    temp.write_bytes(b"x" * 32)
    job = d.Job("j-snap-l", str(temp))
    job.base = "clip"
    job.seconds = 3.0
    with d.JOBS_LOCK:
        d.JOBS["j-snap-l"] = job
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)
    monkeypatch.setattr(d, "_h", lambda: mc)
    try:
        d.handle_snapshot({"id": "j-snap-l", "dir": str(tmp_path)})
        assert wait_for(lambda: any(m.get("type") == "snapshot" for m in sent),
                        timeout=5), sent
    finally:
        with d.JOBS_LOCK:
            d.JOBS.pop("j-snap-l", None)

    files = _sent_files(sent)
    assert files, sent
    assert written.was_written(files[0]) is True


def test_a_completed_pget_is_in_the_ledger(ledger, tmp_path, monkeypatch):
    got = tmp_path / "got.mp4"
    got.write_bytes(b"y" * 10)
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)
    monkeypatch.setattr(d, "_h", lambda: mc)

    d._pget_send_result("p1", "tok", "completed", "range", None, "committed",
                        file=str(got), bytes=10)
    assert _sent_files(sent) == [str(got)], sent
    assert written.was_written(str(got)) is True


def test_a_failed_pget_records_nothing(ledger, tmp_path, monkeypatch):
    """The pair is only on a committed terminal, and so is the record: a
    failed download leaves no file to delete."""
    sent = []
    monkeypatch.setattr(mc, "send", sent.append)
    monkeypatch.setattr(d, "_h", lambda: mc)

    d._pget_send_result("p2", "tok", "failed", "range", "timeout", "empty",
                        file=str(tmp_path / "never.mp4"), bytes=10)
    assert _sent_files(sent) == [], sent
    assert written.was_written(str(tmp_path / "never.mp4")) is False
