"""Ship-set derivation: the installer declares the host set, this module
declares the extension set, and both are pinned against explicit expectations.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ship_set  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ISS = os.path.join(REPO, "media-catcher-host", "installer", "media-catcher-host.iss")


# --------------------------------------------------------------------------
# Host: parsed from the installer's own declaration
# --------------------------------------------------------------------------

def test_host_ship_set_matches_the_installer_declaration():
    shipped = ship_set.host_ship_set(REPO)
    # Pinned explicitly: a parser regression that silently drops entries would
    # otherwise shrink the verified set without failing anything.
    assert "mc_host.py" in shipped
    assert "guardian.ps1" in shipped
    assert "README.md" in shipped
    assert "bootstrap.ps1" in shipped
    assert "mchost/downloads.py" in shipped
    assert "mchost/cast/legacy.py" in shipped, "recursion must reach nested packages"


def test_host_ship_set_includes_guardian_which_a_source_derived_set_missed():
    """guardian.ps1 is runtime: mc_host.py spawns it for self-update."""
    assert "guardian.ps1" in ship_set.host_ship_set(REPO)


def test_host_ship_set_excludes_caches_tests_and_installer_internals():
    shipped = ship_set.host_ship_set(REPO)
    for rel in shipped:
        assert "__pycache__" not in rel
        assert not rel.endswith(".pyc")
        assert not os.path.basename(rel).startswith("test_")
        assert rel != "conftest.py"


def test_host_ship_set_never_nests_mchost_under_itself():
    assert not any(r.startswith("mchost/mchost/") for r in ship_set.host_ship_set(REPO))


def test_every_declared_source_file_exists():
    for rel, src in ship_set.host_ship_set(REPO).items():
        assert os.path.isfile(src), "%s -> %s" % (rel, src)


# --------------------------------------------------------------------------
# Parser: understands the forms in use, refuses the rest
# --------------------------------------------------------------------------

def _write_iss(tmp_path, files_body, define='#define HostSrc "..\\"\n'):
    installer = tmp_path / "installer"
    installer.mkdir(parents=True, exist_ok=True)
    iss = installer / "x.iss"
    iss.write_text(define + "\n[Files]\n" + files_body + "\n[Run]\n", encoding="utf-8")
    return str(iss)


def test_plain_source_resolves_against_the_define(tmp_path):
    (tmp_path / "mc_host.py").write_text("x", encoding="utf-8")
    iss = _write_iss(tmp_path,
                     'Source: "{#HostSrc}mc_host.py"; DestDir: "{app}"; Flags: ignoreversion')
    assert list(ship_set.parse_iss_files(iss)) == ["mc_host.py"]


def test_source_without_a_define_is_relative_to_the_installer_dir(tmp_path):
    iss = _write_iss(tmp_path,
                     'Source: "bootstrap.ps1"; DestDir: "{app}"; Flags: ignoreversion')
    (tmp_path / "installer" / "bootstrap.ps1").write_text("x", encoding="utf-8")
    shipped = ship_set.parse_iss_files(iss)
    assert list(shipped) == ["bootstrap.ps1"]
    assert shipped["bootstrap.ps1"].endswith(os.path.join("installer", "bootstrap.ps1"))


def test_wildcard_recurses_into_a_subdirectory_and_honours_excludes(tmp_path):
    pkg = tmp_path / "mchost"
    (pkg / "cast").mkdir(parents=True)
    (pkg / "__pycache__").mkdir()
    (pkg / "a.py").write_text("x", encoding="utf-8")
    (pkg / "cast" / "b.py").write_text("x", encoding="utf-8")
    (pkg / "stale.pyc").write_text("x", encoding="utf-8")
    (pkg / "__pycache__" / "c.pyc").write_text("x", encoding="utf-8")
    iss = _write_iss(tmp_path,
                     'Source: "{#HostSrc}mchost\\*"; DestDir: "{app}\\mchost"; '
                     'Flags: ignoreversion recursesubdirs createallsubdirs; '
                     'Excludes: "__pycache__\\*,*.pyc"')
    assert sorted(ship_set.parse_iss_files(iss)) == ["mchost/a.py", "mchost/cast/b.py"]


def test_unrecognised_entries_raise_rather_than_being_skipped(tmp_path):
    for body in [
        'Source: "a.py"; DestDir: "{userappdata}"; Flags: ignoreversion',   # DestDir
        'Source: "{#Missing}a.py"; DestDir: "{app}"; Flags: ignoreversion',  # define
        'Source: "mchost\\*"; DestDir: "{app}"; Flags: ignoreversion',       # no recurse
        'Source "a.py"; DestDir: "{app}"; Flags: ignoreversion',             # malformed
    ]:
        with pytest.raises(ship_set.ShipSetError):
            ship_set.parse_iss_files(_write_iss(tmp_path, body))


def test_comments_and_blank_lines_are_ignored(tmp_path):
    (tmp_path / "a.py").write_text("x", encoding="utf-8")
    iss = _write_iss(tmp_path,
                     '; a comment\n\nSource: "{#HostSrc}a.py"; DestDir: "{app}"; Flags: ignoreversion')
    assert list(ship_set.parse_iss_files(iss)) == ["a.py"]


# --------------------------------------------------------------------------
# Extension
# --------------------------------------------------------------------------

def test_extension_ship_set_excludes_tests_and_editor_config():
    shipped = ship_set.extension_ship_set(REPO)
    assert "manifest.json" in shipped
    assert not any(r.startswith("tests/") for r in shipped)
    assert not any(r.startswith(".vscode/") for r in shipped)


def test_extension_ship_set_keeps_runtime_directories():
    shipped = ship_set.extension_ship_set(REPO)
    for rel in ["background.js", "lib/media-size.js", "popup/popup.js", "saveas/saveas.js"]:
        assert rel in shipped, rel


def test_excluding_tests_is_what_stops_a_test_edit_marking_the_extension_stale():
    """Under an 'everything' set these differ; under the ship set they must not."""
    everything = ship_set.extension_ship_set(REPO, exclude_dirs=())
    shipped = ship_set.extension_ship_set(REPO)
    assert any(r.startswith("tests/") for r in everything)
    assert len(everything) > len(shipped)


def test_extension_root_must_carry_the_manifest(tmp_path):
    (tmp_path / "media-catcher").mkdir()
    with pytest.raises(ship_set.ShipSetError):
        ship_set.extension_ship_set(str(tmp_path))
