"""Folder-picker contract: foreground owner, initial directory, and three
distinct terminal outcomes.

The old picker returned "" for both cancellation and failure, and never set an
owner window, so the dialog could open behind Firefox. These tests pin the
repaired behaviour through a narrow injectable Win32 adapter.
"""
import os

from conftest import load_host, wait_for

mc_host = load_host()
from mchost import downloads  # noqa: E402  (must follow load_host)


class FakeApi:
    """Narrow stand-in for the Win32 shell adapter."""

    def __init__(self, owner=444, selected=None, raises=None):
        self._owner = owner
        self._selected = selected
        self._raises = raises
        self.calls = []

    def foreground_window(self):
        return self._owner

    def browse(self, owner, initial_dir):
        self.calls.append((owner, initial_dir))
        if self._raises is not None:
            raise self._raises
        return self._selected


# ---------------------------------------------------------------------------
# _ask_folder outcomes
# ---------------------------------------------------------------------------

def test_picker_uses_foreground_owner_and_initial_directory(tmp_path):
    chosen = str(tmp_path)
    api = FakeApi(owner=444, selected=chosen)
    result = downloads._ask_folder(r"C:\Start", api=api)
    assert api.calls == [(444, r"C:\Start")]
    assert result == {"status": "selected", "directory": chosen}


def test_normal_cancellation_is_distinct_from_failure():
    api = FakeApi(selected=None)
    assert downloads._ask_folder(r"C:\Start", api=api) == {"status": "cancelled"}


def test_raised_api_exception_reports_picker_unavailable():
    api = FakeApi(raises=OSError("shell exploded"))
    assert downloads._ask_folder(r"C:\Start", api=api) == {
        "status": "error", "code": "picker_unavailable"}


def test_zero_foreground_owner_never_opens_an_unowned_dialog():
    api = FakeApi(owner=0)
    assert downloads._ask_folder(r"C:\Start", api=api) == {
        "status": "error", "code": "picker_unavailable"}
    assert api.calls == [], "no dialog may open without an owner window"


def test_path_resolution_failure_and_non_directory_are_invalid_selections(tmp_path):
    a_file = tmp_path / "not-a-directory.txt"
    a_file.write_text("x", encoding="utf-8")
    for selected in ["", str(a_file), str(tmp_path / "missing"), 42, b"bytes"]:
        assert downloads._ask_folder(r"C:\Start", api=FakeApi(selected=selected)) == {
            "status": "error", "code": "invalid_selection"}, selected


def test_foreground_owner_failure_is_contained():
    class Exploding:
        def foreground_window(self):
            raise OSError("no user32")

        def browse(self, owner, initial_dir):  # pragma: no cover - never reached
            raise AssertionError("browse must not run")

    assert downloads._ask_folder(r"C:\Start", api=Exploding()) == {
        "status": "error", "code": "picker_unavailable"}


# ---------------------------------------------------------------------------
# handle_pick_folder frames
# ---------------------------------------------------------------------------

def _capture_frames(monkeypatch):
    frames = []
    monkeypatch.setattr(downloads._h(), "send", lambda frame: frames.append(frame))
    return frames


def test_handle_pick_folder_echoes_request_id_and_selected_directory(monkeypatch, tmp_path):
    frames = _capture_frames(monkeypatch)
    chosen = str(tmp_path)
    monkeypatch.setattr(downloads, "_ask_folder",
                        lambda d, api=None: {"status": "selected", "directory": chosen})

    downloads.handle_pick_folder({"cmd": "pickFolder", "requestId": "fp-7", "dir": r"C:\Start"})
    assert wait_for(lambda: len(frames) == 1), "picker worker did not reply"
    assert frames[0] == {
        "type": "folder", "requestId": "fp-7", "status": "selected", "directory": chosen}


def test_handle_pick_folder_reports_cancellation_and_error_without_a_directory(monkeypatch):
    for outcome, expected in [
        ({"status": "cancelled"},
         {"type": "folder", "requestId": "fp-8", "status": "cancelled"}),
        ({"status": "error", "code": "picker_unavailable"},
         {"type": "folder", "requestId": "fp-8", "status": "error", "code": "picker_unavailable"}),
        ({"status": "error", "code": "invalid_selection"},
         {"type": "folder", "requestId": "fp-8", "status": "error", "code": "invalid_selection"}),
    ]:
        frames = []
        monkeypatch.setattr(downloads._h(), "send", lambda frame: frames.append(frame))
        monkeypatch.setattr(downloads, "_ask_folder", lambda d, api=None, o=outcome: o)
        downloads.handle_pick_folder({"requestId": "fp-8"})
        assert wait_for(lambda: len(frames) == 1), "picker worker did not reply"
        assert frames[0] == expected


def test_handle_pick_folder_falls_back_to_the_downloads_directory(monkeypatch):
    frames = _capture_frames(monkeypatch)
    seen = []
    monkeypatch.setattr(downloads, "_ask_folder",
                        lambda d, api=None: (seen.append(d), {"status": "cancelled"})[1])

    downloads.handle_pick_folder({"requestId": "fp-9"})
    assert wait_for(lambda: len(frames) == 1)
    assert seen == [downloads._h().downloads_dir()]


def test_handle_pick_folder_copies_only_allowlisted_fields(monkeypatch):
    frames = _capture_frames(monkeypatch)
    monkeypatch.setattr(downloads, "_ask_folder", lambda d, api=None: {
        "status": "selected",
        "directory": r"D:\Videos",
        "secret": "SECRET_SENTINEL",
        "code": "should_not_appear_on_success",
    })

    downloads.handle_pick_folder({"requestId": "fp-10", "dir": r"C:\Start", "extra": "ignored"})
    assert wait_for(lambda: len(frames) == 1)
    assert frames[0] == {
        "type": "folder", "requestId": "fp-10", "status": "selected", "directory": r"D:\Videos"}


def test_handle_pick_folder_survives_a_failing_ask(monkeypatch):
    frames = _capture_frames(monkeypatch)

    def boom(_d, api=None):
        raise RuntimeError("SECRET_INTERNAL_REASON")

    monkeypatch.setattr(downloads, "_ask_folder", boom)
    downloads.handle_pick_folder({"requestId": "fp-11"})
    assert wait_for(lambda: len(frames) == 1), "a failing picker must still settle"
    assert frames[0]["status"] == "error"
    assert frames[0]["requestId"] == "fp-11"
    assert "SECRET_INTERNAL_REASON" not in repr(frames[0])


def test_handle_pick_folder_accepts_the_legacy_request_id_key(monkeypatch):
    frames = _capture_frames(monkeypatch)
    monkeypatch.setattr(downloads, "_ask_folder", lambda d, api=None: {"status": "cancelled"})
    downloads.handle_pick_folder({"reqId": "legacy-1"})
    assert wait_for(lambda: len(frames) == 1)
    assert frames[0]["requestId"] == "legacy-1"


def test_picker_never_logs_the_default_or_selected_path(monkeypatch, tmp_path):
    logged = []
    frames = _capture_frames(monkeypatch)
    if hasattr(downloads, "log"):
        monkeypatch.setattr(downloads, "log", lambda *a, **k: logged.append((a, k)))
    chosen = str(tmp_path)
    monkeypatch.setattr(downloads, "_ask_folder",
                        lambda d, api=None: {"status": "selected", "directory": chosen})
    downloads.handle_pick_folder({"requestId": "fp-12", "dir": r"C:\Secret\Path"})
    assert wait_for(lambda: len(frames) == 1)
    blob = repr(logged)
    assert "Secret" not in blob
    assert os.path.basename(chosen) not in blob
