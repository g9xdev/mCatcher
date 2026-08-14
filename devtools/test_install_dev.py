"""Pure-core tests for the deterministic developer install.

Every test here is hermetic: tmp_path trees, in-memory strings, and injected
adapters. Nothing touches a real Firefox profile, the registry, ISCC, or an
installer — that is the whole point of keeping this core pure.

The load-bearing case is at the bottom: an in-sync extension must never mask a
stale host. That is the exact shape of the 2026-08-14 failure, where the version
string stayed 1.10.0 across a build, two later commits, and the install.
"""
import io
import json
import os
import sys
import zipfile

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import install_dev  # noqa: E402


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def write(root, rel, text):
    """Create root/rel (POSIX-style rel) with `text`, making parents."""
    path = os.path.join(str(root), *rel.split("/"))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    return path


def make_host_tree(root):
    """A host source tree carrying runtime files, tests, and bytecode noise."""
    write(root, "mc_host.py", 'VERSION = "1.10.0"\n')
    write(root, "conftest.py", "# pytest helpers, never installed\n")
    write(root, "test_host.py", "# tests, never installed\n")
    write(root, "mchost/__init__.py", "")
    write(root, "mchost/downloads.py", "def save(): pass\n")
    write(root, "mchost/cast/backend.py", "def cast(): pass\n")
    write(root, "mchost/__pycache__/downloads.cpython-314.pyc", "bytecode")
    write(root, "mchost/downloads.pyc", "bytecode")
    return root


def make_extension_tree(root, version="1.10.0"):
    write(root, "manifest.json", json.dumps({"version": version}, indent=2))
    write(root, "background.js", "// background\n")
    write(root, "lib/commands.js", "// commands\n")
    write(root, "icons/icon-48.png", "not-really-a-png")
    return root


# ===========================================================================
# 1. Tree hashing
# ===========================================================================

def test_tree_hash_is_stable_across_runs(tmp_path):
    make_host_tree(tmp_path)
    first = install_dev.hash_host_sources(str(tmp_path))
    second = install_dev.hash_host_sources(str(tmp_path))
    assert first["sha256"] == second["sha256"]
    assert first["files"] == second["files"]
    assert len(first["sha256"]) == 64


def test_tree_hash_is_independent_of_the_absolute_root(tmp_path):
    """Two identical trees at different absolute paths must hash the same.

    This is what 'stable across machines' means: the digest covers relative
    paths and contents, never where the checkout happens to live.
    """
    a = make_host_tree(tmp_path / "checkout-one")
    b = make_host_tree(tmp_path / "somewhere" / "else")
    assert install_dev.hash_host_sources(str(a))["sha256"] == \
        install_dev.hash_host_sources(str(b))["sha256"]


def test_tree_hash_changes_when_any_file_content_changes(tmp_path):
    make_host_tree(tmp_path)
    before = install_dev.hash_host_sources(str(tmp_path))["sha256"]
    write(tmp_path, "mchost/downloads.py", "def save(): return 1\n")
    assert install_dev.hash_host_sources(str(tmp_path))["sha256"] != before


def test_tree_hash_changes_when_a_file_is_renamed(tmp_path):
    """Path is fed into the digest, so a pure rename is not invisible."""
    make_host_tree(tmp_path)
    before = install_dev.hash_host_sources(str(tmp_path))["sha256"]
    os.rename(os.path.join(str(tmp_path), "mchost", "downloads.py"),
              os.path.join(str(tmp_path), "mchost", "transfers.py"))
    assert install_dev.hash_host_sources(str(tmp_path))["sha256"] != before


def test_tree_hash_changes_when_a_file_is_added_or_removed(tmp_path):
    make_host_tree(tmp_path)
    before = install_dev.hash_host_sources(str(tmp_path))["sha256"]
    write(tmp_path, "mchost/newmodule.py", "")
    added = install_dev.hash_host_sources(str(tmp_path))["sha256"]
    assert added != before
    os.remove(os.path.join(str(tmp_path), "mchost", "newmodule.py"))
    assert install_dev.hash_host_sources(str(tmp_path))["sha256"] == before


def test_path_and_content_cannot_be_confused_for_each_other(tmp_path):
    """Length-framed feeding: shifting a byte from path to content must matter."""
    a = tmp_path / "a"
    b = tmp_path / "b"
    write(a, "ab", "cd")
    write(b, "a", "bcd")
    names_a = install_dev.expand_ship_set(str(a), ("**",))
    names_b = install_dev.expand_ship_set(str(b), ("**",))
    assert install_dev.hash_tree(str(a), names_a) != install_dev.hash_tree(str(b), names_b)


def test_host_ship_set_is_the_installed_runtime_files_only(tmp_path):
    """conftest.py, test_*.py, __pycache__ and *.pyc are never installed.

    Hashing them would make the host permanently 'stale' after any test edit,
    and would make 'source file absent from the install' unfalsifiable.
    """
    make_host_tree(tmp_path)
    files = install_dev.hash_host_sources(str(tmp_path))["files"]
    assert sorted(files) == [
        "mc_host.py",
        "mchost/__init__.py",
        "mchost/cast/backend.py",
        "mchost/downloads.py",
    ]


def test_editing_a_test_file_does_not_make_the_host_stale(tmp_path):
    make_host_tree(tmp_path)
    before = install_dev.hash_host_sources(str(tmp_path))["sha256"]
    write(tmp_path, "test_host.py", "# rewritten test\n")
    write(tmp_path, "conftest.py", "# rewritten helpers\n")
    write(tmp_path, "mchost/__pycache__/downloads.cpython-314.pyc", "fresh bytecode")
    assert install_dev.hash_host_sources(str(tmp_path))["sha256"] == before


def test_host_ship_set_is_caller_supplied(tmp_path):
    """The ship set is a parameter so it stays a single decision point."""
    make_host_tree(tmp_path)
    files = install_dev.hash_host_sources(
        str(tmp_path), ship_set=("mc_host.py",))["files"]
    assert list(files) == ["mc_host.py"]


def test_host_per_file_map_identifies_the_single_changed_module(tmp_path):
    make_host_tree(tmp_path)
    before = install_dev.hash_host_sources(str(tmp_path))["files"]
    write(tmp_path, "mchost/downloads.py", "def save(): return 1\n")
    after = install_dev.hash_host_sources(str(tmp_path))["files"]
    changed = [k for k in after if before.get(k) != after[k]]
    assert changed == ["mchost/downloads.py"]


def test_extension_hash_covers_the_whole_tree(tmp_path):
    make_extension_tree(tmp_path)
    result = install_dev.hash_extension_sources(str(tmp_path))
    assert sorted(result["files"]) == [
        "background.js", "icons/icon-48.png", "lib/commands.js", "manifest.json"]


def test_extension_hash_ignores_bytecode_noise(tmp_path):
    make_extension_tree(tmp_path)
    before = install_dev.hash_extension_sources(str(tmp_path))["sha256"]
    write(tmp_path, "tools/__pycache__/x.cpython-314.pyc", "junk")
    assert install_dev.hash_extension_sources(str(tmp_path))["sha256"] == before


def test_hashing_an_absent_tree_raises_rather_than_hashing_nothing(tmp_path):
    """An empty digest for a missing checkout would read as 'in-sync'."""
    with pytest.raises(FileNotFoundError):
        install_dev.hash_host_sources(str(tmp_path / "not-here"))


# ===========================================================================
# 2. profiles.ini parsing
# ===========================================================================

def _always(_path):
    return True


REL_INI = """\
[Profile0]
Name=default-release
IsRelative=1
Path=Profiles/aaaaaaaa.default-release

[Profile1]
Name=dev-edition-default
IsRelative=1
Path=Profiles/bbbbbbbb.dev-edition-default
"""


def test_relative_profile_path_resolves_against_the_firefox_directory(tmp_path):
    base = str(tmp_path / "Firefox")
    found = install_dev.find_dev_profile(REL_INI, base, exists=_always)
    assert found == os.path.normpath(
        os.path.join(base, "Profiles", "bbbbbbbb.dev-edition-default"))


def test_absolute_profile_path_is_used_verbatim(tmp_path):
    elsewhere = str(tmp_path / "D-drive" / "ffdev")
    ini = ("[Profile0]\nName=dev-edition-default\nIsRelative=0\nPath=%s\n" % elsewhere)
    found = install_dev.find_dev_profile(ini, str(tmp_path / "Firefox"), exists=_always)
    assert found == os.path.normpath(elsewhere)


def test_missing_dev_edition_profile_returns_none_without_raising():
    ini = """\
[Profile0]
Name=default-release
IsRelative=1
Path=Profiles/aaaaaaaa.default-release
"""
    assert install_dev.find_dev_profile(ini, r"C:\FF", exists=_always) is None


def test_empty_and_malformed_ini_return_none():
    for text in ["", "not an ini at all", "[Profile0]\n", "]]][[[\n=\n"]:
        assert install_dev.find_dev_profile(text, r"C:\FF", exists=_always) is None


def test_a_utf8_bom_does_not_silently_swallow_the_whole_file(tmp_path):
    """Firefox writes profiles.ini with a BOM; a caller reading it as plain
    utf-8 would otherwise get a quiet None for every profile."""
    base = str(tmp_path / "Firefox")
    found = install_dev.find_dev_profile("﻿" + REL_INI, base, exists=_always)
    assert found == os.path.normpath(
        os.path.join(base, "Profiles", "bbbbbbbb.dev-edition-default"))


def test_multiple_installs_and_profiles_pick_the_dev_edition_install(tmp_path):
    """Release and Dev Edition each own an [Install<hash>] section.

    Release must never be selected — picking 'the first Install section', as
    the existing variant.find_profile() does, would do exactly that here.
    """
    ini = """\
[Install1111111111111111]
Default=Profiles/aaaaaaaa.default-release
Locked=1

[Install2222222222222222]
Default=Profiles/bbbbbbbb.dev-edition-default
Locked=1

[Profile0]
Name=default-release
IsRelative=1
Path=Profiles/aaaaaaaa.default-release

[Profile1]
Name=dev-edition-default
IsRelative=1
Path=Profiles/bbbbbbbb.dev-edition-default
"""
    base = str(tmp_path / "Firefox")
    found = install_dev.find_dev_profile(ini, base, exists=_always)
    assert found == os.path.normpath(
        os.path.join(base, "Profiles", "bbbbbbbb.dev-edition-default"))


def test_install_default_wins_when_it_disagrees_with_the_named_profile(tmp_path):
    """The Install section records the profile Dev Edition actually opened.

    Name= is only a label and can point at a stale directory. When the two
    disagree the install section is authoritative — this is the case that
    looks correct on a machine where they coincide.
    """
    ini = """\
[Install2222222222222222]
Default=Profiles/current.dev-edition-default
Locked=1

[Profile0]
Name=dev-edition-default
IsRelative=1
Path=Profiles/stale-but-named
"""
    base = str(tmp_path / "Firefox")
    found = install_dev.find_dev_profile(ini, base, exists=_always)
    assert found == os.path.normpath(
        os.path.join(base, "Profiles", "current.dev-edition-default"))


def test_install_default_is_matched_through_its_profile_name(tmp_path):
    """A dev profile directory without the conventional suffix still resolves
    when its [Profile N] section names it dev-edition-default."""
    ini = """\
[Install2222222222222222]
Default=Profiles/custom-dev-dir

[Profile0]
Name=dev-edition-default
IsRelative=1
Path=Profiles/custom-dev-dir
"""
    base = str(tmp_path / "Firefox")
    found = install_dev.find_dev_profile(ini, base, exists=_always)
    assert found == os.path.normpath(os.path.join(base, "Profiles", "custom-dev-dir"))


def test_an_explicit_install_key_selects_that_section(tmp_path):
    ini = """\
[Install1111111111111111]
Default=Profiles/aaaaaaaa.dev-edition-default

[Install2222222222222222]
Default=Profiles/bbbbbbbb.dev-edition-default
"""
    base = str(tmp_path / "Firefox")
    found = install_dev.find_dev_profile(
        ini, base, install_key="2222222222222222", exists=_always)
    assert found == os.path.normpath(
        os.path.join(base, "Profiles", "bbbbbbbb.dev-edition-default"))


def test_an_install_default_that_does_not_exist_falls_back_to_the_named_profile(tmp_path):
    """variant.py already gates install sections on isdir; keep that behaviour."""
    base = tmp_path / "Firefox"
    real = base / "Profiles" / "bbbbbbbb.dev-edition-default"
    real.mkdir(parents=True)
    ini = """\
[Install2222222222222222]
Default=Profiles/deleted.dev-edition-default

[Profile1]
Name=dev-edition-default
IsRelative=1
Path=Profiles/bbbbbbbb.dev-edition-default
"""
    assert install_dev.find_dev_profile(ini, str(base)) == os.path.normpath(str(real))


def test_a_release_only_install_section_never_yields_a_profile():
    """Safety: release Firefox is never touched, not even by resolution."""
    ini = """\
[Install1111111111111111]
Default=Profiles/aaaaaaaa.default-release

[Profile0]
Name=default-release
IsRelative=1
Path=Profiles/aaaaaaaa.default-release
"""
    assert install_dev.find_dev_profile(ini, r"C:\FF", exists=_always) is None


def test_path_suffix_alone_identifies_a_dev_profile(tmp_path):
    """Some profiles.ini files carry no Name= for the dev profile."""
    ini = "[Profile3]\nIsRelative=1\nPath=Profiles/zzzz.dev-edition-default\n"
    base = str(tmp_path / "Firefox")
    assert install_dev.find_dev_profile(ini, base, exists=_always) == os.path.normpath(
        os.path.join(base, "Profiles", "zzzz.dev-edition-default"))


def test_section_and_key_casing_is_tolerated(tmp_path):
    ini = "[profile0]\nname=Dev-Edition-Default\nisrelative=1\npath=Profiles/x.dev\n"
    base = str(tmp_path / "Firefox")
    assert install_dev.find_dev_profile(ini, base, exists=_always) == os.path.normpath(
        os.path.join(base, "Profiles", "x.dev"))


# ===========================================================================
# 3. Deterministic zip
# ===========================================================================

def test_the_same_source_twice_produces_byte_identical_archives(tmp_path):
    make_extension_tree(tmp_path)
    first = install_dev.build_xpi_bytes(str(tmp_path))
    second = install_dev.build_xpi_bytes(str(tmp_path))
    assert first == second
    assert install_dev.sha256_bytes(first) == install_dev.sha256_bytes(second)


def test_identical_trees_at_different_paths_produce_identical_archives(tmp_path):
    a = make_extension_tree(tmp_path / "one")
    b = make_extension_tree(tmp_path / "two")
    # Skew one tree's mtimes: a build made at a different moment must still match.
    for name in ("manifest.json", "background.js", "lib/commands.js"):
        os.utime(os.path.join(str(b), *name.split("/")), (1_500_000_000, 1_500_000_000))
    assert install_dev.build_xpi_bytes(str(a)) == install_dev.build_xpi_bytes(str(b))


def test_manifest_json_sits_at_the_archive_root(tmp_path):
    make_extension_tree(tmp_path)
    data = install_dev.build_xpi_bytes(str(tmp_path))
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = zf.namelist()
    assert "manifest.json" in names
    assert "lib/commands.js" in names
    assert not any(n.endswith("/") for n in names), "no directory entries"


def test_entries_are_sorted_and_timestamps_are_fixed(tmp_path):
    make_extension_tree(tmp_path)
    data = install_dev.build_xpi_bytes(str(tmp_path))
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        infos = zf.infolist()
    assert [i.filename for i in infos] == sorted(i.filename for i in infos)
    assert all(i.date_time == install_dev.XPI_TIMESTAMP for i in infos)
    assert all(i.create_system == 0 for i in infos), "create_system must not vary by OS"


def test_a_changed_byte_changes_the_archive_sha(tmp_path):
    make_extension_tree(tmp_path)
    before = install_dev.sha256_bytes(install_dev.build_xpi_bytes(str(tmp_path)))
    write(tmp_path, "background.js", "// background v2\n")
    assert install_dev.sha256_bytes(install_dev.build_xpi_bytes(str(tmp_path))) != before


def test_touching_a_file_without_changing_it_does_not_change_the_archive(tmp_path):
    """Timestamps are pinned, so mtime churn cannot masquerade as a change."""
    make_extension_tree(tmp_path)
    before = install_dev.build_xpi_bytes(str(tmp_path))
    os.utime(os.path.join(str(tmp_path), "background.js"), (1_000_000, 1_000_000))
    assert install_dev.build_xpi_bytes(str(tmp_path)) == before


def test_a_source_without_a_root_manifest_is_rejected(tmp_path):
    """Guards against pointing the builder at the repo root by mistake."""
    write(tmp_path, "media-catcher/manifest.json", "{}")
    with pytest.raises(ValueError, match="manifest.json"):
        install_dev.build_xpi_bytes(str(tmp_path))


def test_write_xpi_reports_the_sha_of_the_bytes_it_wrote(tmp_path):
    source = make_extension_tree(tmp_path / "src")
    out = tmp_path / "dist" / "mcatcher.xpi"
    result = install_dev.write_xpi(str(source), str(out))
    written = out.read_bytes()
    assert result["sha256"] == install_dev.sha256_bytes(written)
    assert result["path"] == str(out)
    assert "manifest.json" in result["entries"]
    assert written == install_dev.build_xpi_bytes(str(source))


# ===========================================================================
# 4. Receipt load / save / diff
# ===========================================================================

TARGETS = {
    "extensionId": "{27383706-fb43-40dc-9e94-d2578818bd6a}",
    "devProfile": r"C:\Users\add\AppData\Roaming\Mozilla\Firefox\Profiles\2eydftv7.dev-edition-default",
    "xpiPath": r"C:\Users\add\AppData\Roaming\Mozilla\Firefox\Profiles\2eydftv7.dev-edition-default\extensions\{27383706-fb43-40dc-9e94-d2578818bd6a}.xpi",
    "hostDir": r"C:\Users\add\AppData\Local\MediaCatcher\Host",
}
HOST_FILES = {"mc_host.py": "aa" * 32, "mchost/downloads.py": "bb" * 32}


def a_receipt(**over):
    receipt = install_dev.make_receipt(
        targets=dict(TARGETS),
        extension={"version": "1.10.0", "shipSetSha256": "e" * 64, "xpiSha256": "x" * 64},
        host={"shipSetSha256": "h" * 64, "files": dict(HOST_FILES)},
        commit="069cb55", dirty=True, installed_at="2026-08-14T10:52:00Z")
    receipt.update(over)
    return receipt


def a_current(**over):
    current = {
        "targets": dict(TARGETS),
        "extension": {"shipSetSha256": "e" * 64, "installedXpiSha256": "x" * 64},
        "host": {"shipSetSha256": "h" * 64, "files": dict(HOST_FILES),
                 "installedFiles": dict(HOST_FILES)},
    }
    for key, value in over.items():
        if isinstance(value, dict) and isinstance(current.get(key), dict):
            current[key] = {**current[key], **value}
        else:
            current[key] = value
    return current


def test_receipt_round_trips_through_disk(tmp_path):
    path = tmp_path / "state" / "install-receipt.json"
    receipt = a_receipt()
    install_dev.save_receipt(str(path), receipt)
    assert install_dev.load_receipt(str(path)) == receipt
    assert receipt["schema"] == install_dev.SCHEMA_VERSION


def test_a_missing_or_corrupt_receipt_loads_as_none(tmp_path):
    assert install_dev.load_receipt(str(tmp_path / "absent.json")) is None
    broken = tmp_path / "broken.json"
    broken.write_text("{ not json", encoding="utf-8")
    assert install_dev.load_receipt(str(broken)) is None
    not_an_object = tmp_path / "list.json"
    not_an_object.write_text("[]", encoding="utf-8")
    assert install_dev.load_receipt(str(not_an_object)) is None


def test_unchanged_sources_and_install_report_in_sync_for_both():
    verdicts = install_dev.diff(a_current(), a_receipt())
    assert verdicts["extension"].status == install_dev.IN_SYNC
    assert verdicts["host"].status == install_dev.IN_SYNC
    assert verdicts["host"].changed == []


def test_no_receipt_reports_missing_for_both():
    verdicts = install_dev.diff(a_current(), None)
    assert verdicts["extension"].status == install_dev.MISSING
    assert verdicts["host"].status == install_dev.MISSING


def test_an_unknown_schema_reports_missing_rather_than_trusting_it():
    verdicts = install_dev.diff(a_current(), a_receipt(schema=99))
    assert verdicts["extension"].status == install_dev.MISSING
    assert verdicts["host"].status == install_dev.MISSING


def test_changed_sources_report_stale():
    verdicts = install_dev.diff(
        a_current(extension={"shipSetSha256": "f" * 64},
                  host={"shipSetSha256": "g" * 64}),
        a_receipt())
    assert verdicts["extension"].status == install_dev.STALE
    assert verdicts["host"].status == install_dev.STALE


def test_an_absent_artifact_reports_missing_not_stale():
    verdicts = install_dev.diff(
        a_current(extension={"installedXpiSha256": None},
                  host={"installedFiles": None}),
        a_receipt())
    assert verdicts["extension"].status == install_dev.MISSING
    assert verdicts["host"].status == install_dev.MISSING


def test_a_moved_profile_reports_target_moved_for_the_extension_only():
    moved = dict(TARGETS, devProfile=r"D:\Firefox\Profiles\9999.dev-edition-default")
    verdicts = install_dev.diff(a_current(targets=moved), a_receipt())
    assert verdicts["extension"].status == install_dev.TARGET_MOVED
    assert "devProfile" in verdicts["extension"].reason
    assert verdicts["host"].status == install_dev.IN_SYNC


def test_a_re_registered_host_reports_target_moved_for_the_host_only():
    moved = dict(TARGETS, hostDir=r"D:\Apps\MediaCatcher\Host")
    verdicts = install_dev.diff(a_current(targets=moved), a_receipt())
    assert verdicts["host"].status == install_dev.TARGET_MOVED
    assert "hostDir" in verdicts["host"].reason
    assert verdicts["extension"].status == install_dev.IN_SYNC


def test_target_comparison_normalises_redundant_separators():
    same = dict(TARGETS, hostDir=TARGETS["hostDir"] + os.sep)
    verdicts = install_dev.diff(a_current(targets=same), a_receipt())
    assert verdicts["host"].status == install_dev.IN_SYNC


@pytest.mark.skipif(os.name != "nt", reason="path casing only collapses on Windows")
def test_target_comparison_ignores_windows_path_casing():
    same = dict(TARGETS, hostDir=TARGETS["hostDir"].upper())
    verdicts = install_dev.diff(a_current(targets=same), a_receipt())
    assert verdicts["host"].status == install_dev.IN_SYNC


def test_a_changed_extension_id_is_a_moved_target():
    moved = dict(TARGETS, extensionId="{00000000-0000-0000-0000-000000000000}")
    verdicts = install_dev.diff(a_current(targets=moved), a_receipt())
    assert verdicts["extension"].status == install_dev.TARGET_MOVED


def test_an_install_changed_behind_our_back_reports_stale():
    """Sources match the receipt, but the bytes on disk no longer do."""
    tampered = dict(HOST_FILES, **{"mchost/downloads.py": "cc" * 32})
    verdicts = install_dev.diff(
        a_current(extension={"installedXpiSha256": "y" * 64},
                  host={"installedFiles": tampered}),
        a_receipt())
    assert verdicts["extension"].status == install_dev.STALE
    assert verdicts["host"].status == install_dev.STALE
    assert verdicts["host"].changed == ["mchost/downloads.py"]


def test_a_module_present_in_source_but_absent_from_the_install_is_stale():
    """A per-file map identifies which module changed, not just that one did."""
    short = {"mc_host.py": HOST_FILES["mc_host.py"]}
    verdicts = install_dev.diff(a_current(host={"installedFiles": short}), a_receipt())
    assert verdicts["host"].status == install_dev.STALE
    assert verdicts["host"].changed == ["mchost/downloads.py"]


def test_a_stale_host_names_the_changed_module():
    changed_source = dict(HOST_FILES, **{"mchost/downloads.py": "dd" * 32})
    verdicts = install_dev.diff(
        a_current(host={"shipSetSha256": "g" * 64, "files": changed_source,
                        "installedFiles": dict(HOST_FILES)}),
        a_receipt())
    assert verdicts["host"].status == install_dev.STALE
    assert verdicts["host"].changed == ["mchost/downloads.py"]


# --- the motivating case -----------------------------------------------------

def test_a_current_extension_never_masks_a_stale_host():
    """2026-08-14: the extension was current, the host was two commits behind,
    the version string stayed 1.10.0 throughout, and the install reported
    success. A single combined verdict is what made that invisible.
    """
    changed_source = dict(HOST_FILES, **{"mchost/downloads.py": "dd" * 32})
    verdicts = install_dev.diff(
        a_current(host={"shipSetSha256": "g" * 64, "files": changed_source,
                        "installedFiles": dict(HOST_FILES)}),
        a_receipt())

    assert verdicts["extension"].status == install_dev.IN_SYNC
    assert verdicts["host"].status == install_dev.STALE
    assert verdicts["host"].changed == ["mchost/downloads.py"]
    # And the roll-up must not average the two away.
    assert install_dev.needs_install(verdicts) == ["host"]
    assert install_dev.all_in_sync(verdicts) is False


def test_versions_are_never_consulted_for_freshness():
    """A bumped version with identical bytes is still in-sync; identical
    versions with different bytes are still stale."""
    receipt = a_receipt()
    receipt["extension"]["version"] = "9.9.9"
    assert install_dev.diff(a_current(), receipt)["extension"].status == install_dev.IN_SYNC

    verdicts = install_dev.diff(a_current(extension={"shipSetSha256": "f" * 64}), a_receipt())
    assert verdicts["extension"].status == install_dev.STALE


def test_needs_install_lists_both_components_when_both_are_stale():
    verdicts = install_dev.diff(
        a_current(extension={"shipSetSha256": "f" * 64}, host={"shipSetSha256": "g" * 64}),
        a_receipt())
    assert install_dev.needs_install(verdicts) == ["extension", "host"]


# ===========================================================================
# 5. ISCC discovery
# ===========================================================================

def env_with(path_dirs=(), **extra):
    env = {"PATH": os.pathsep.join(path_dirs)}
    env.update(extra)
    return env


def only(*present):
    found = {os.path.normcase(os.path.normpath(p)) for p in present}
    return lambda p: os.path.normcase(os.path.normpath(p)) in found


def test_iscc_is_found_on_path():
    on_path = os.path.join(r"C:\Tools\Inno", install_dev.ISCC_NAME)
    env = env_with([r"C:\Windows", r"C:\Tools\Inno"])
    assert install_dev.find_iscc(env=env, exists=only(on_path)) == on_path


def test_iscc_is_found_in_a_standard_inno_directory():
    standard = os.path.join(r"C:\Program Files (x86)\Inno Setup 6", install_dev.ISCC_NAME)
    env = env_with([r"C:\Windows"], **{"ProgramFiles(x86)": r"C:\Program Files (x86)"})
    assert install_dev.find_iscc(env=env, exists=only(standard)) == standard


def test_all_three_standard_directories_are_searched():
    env = env_with(
        [],
        **{"ProgramFiles(x86)": r"C:\Program Files (x86)",
           "ProgramFiles": r"C:\Program Files",
           "LOCALAPPDATA": r"C:\Users\add\AppData\Local"})
    expected = [
        os.path.join(r"C:\Program Files (x86)\Inno Setup 6", install_dev.ISCC_NAME),
        os.path.join(r"C:\Program Files\Inno Setup 6", install_dev.ISCC_NAME),
        os.path.join(r"C:\Users\add\AppData\Local\Programs\Inno Setup 6",
                     install_dev.ISCC_NAME),
    ]
    assert install_dev.iscc_candidates(env) == expected
    for candidate in expected:
        assert install_dev.find_iscc(env=env, exists=only(candidate)) == candidate


def test_path_takes_precedence_over_the_standard_directories():
    on_path = os.path.join(r"C:\Tools\Inno", install_dev.ISCC_NAME)
    standard = os.path.join(r"C:\Program Files (x86)\Inno Setup 6", install_dev.ISCC_NAME)
    env = env_with([r"C:\Tools\Inno"], **{"ProgramFiles(x86)": r"C:\Program Files (x86)"})
    assert install_dev.find_iscc(env=env, exists=only(on_path, standard)) == on_path


def test_an_absent_compiler_returns_none_rather_than_guessing():
    env = env_with([r"C:\Windows"], **{"ProgramFiles": r"C:\Program Files"})
    assert install_dev.find_iscc(env=env, exists=lambda _p: False) is None


def test_an_empty_environment_is_survivable():
    assert install_dev.find_iscc(env={}, exists=lambda _p: False) is None
    assert install_dev.iscc_candidates({}) == []


def test_empty_path_entries_never_produce_a_bare_relative_candidate():
    """An empty PATH segment must not yield a candidate that resolves against
    the current working directory."""
    env = {"PATH": os.pathsep.join(["", r"C:\Tools\Inno", ""])}
    seen = []

    def record(path):
        seen.append(path)
        return False

    install_dev.find_iscc(env=env, exists=record)
    assert seen == [os.path.join(r"C:\Tools\Inno", install_dev.ISCC_NAME)]


# ---------------------------------------------------------------------------
# Ship-set driven digests: keyed by where files LAND, from the real authority
# ---------------------------------------------------------------------------

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def test_host_ship_set_digest_covers_the_installer_declaration():
    result = install_dev.hash_host_ship_set(REPO_ROOT)
    files = result["files"]
    # guardian.ps1 and bootstrap.ps1 are shipped but were absent from the
    # earlier source-derived set; downloads.py is the file that went stale.
    for rel in ["mc_host.py", "guardian.ps1", "bootstrap.ps1", "mchost/downloads.py"]:
        assert rel in files, rel
    assert len(result["sha256"]) == 64


def test_host_digest_is_keyed_by_install_location_not_source_location():
    """bootstrap.ps1 is declared in installer/ but installs at {app}/."""
    files = install_dev.hash_host_ship_set(REPO_ROOT)["files"]
    assert "bootstrap.ps1" in files
    assert "installer/bootstrap.ps1" not in files


def test_extension_ship_set_digest_ignores_tests_and_editor_config():
    files = install_dev.hash_extension_ship_set(REPO_ROOT)["files"]
    assert "manifest.json" in files
    assert not any(r.startswith("tests/") for r in files)
    assert not any(r.startswith(".vscode/") for r in files)


def test_a_changed_shipped_file_changes_the_host_digest(tmp_path):
    mapping = {"a.py": str(tmp_path / "a.py"), "b/c.py": str(tmp_path / "c.py")}
    (tmp_path / "a.py").write_text("one", encoding="utf-8")
    (tmp_path / "c.py").write_text("two", encoding="utf-8")
    before = install_dev.hash_mapping(mapping)
    (tmp_path / "c.py").write_text("changed", encoding="utf-8")
    after = install_dev.hash_mapping(mapping)
    assert after["sha256"] != before["sha256"]
    assert after["files"]["a.py"] == before["files"]["a.py"]
    assert after["files"]["b/c.py"] != before["files"]["b/c.py"]


def test_mapping_digest_is_independent_of_where_sources_live(tmp_path):
    """Same landing paths and contents from different roots digest alike."""
    one, two = tmp_path / "one", tmp_path / "two"
    one.mkdir(); two.mkdir()
    (one / "x").write_text("same", encoding="utf-8")
    (two / "x").write_text("same", encoding="utf-8")
    assert install_dev.hash_mapping({"mc_host.py": str(one / "x")})["sha256"] == \
        install_dev.hash_mapping({"mc_host.py": str(two / "x")})["sha256"]
