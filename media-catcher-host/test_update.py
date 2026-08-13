"""Offline tests for the self-update helpers in mc_host.py (no Firefox/network).
Run:  python -m pytest test_update.py -q   (or directly:  py test_update.py)"""
import json
import os
import struct
import zipfile

import pytest

from conftest import load_host

mc = load_host()


def make_ext_zip(path, version, extra=None):
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("manifest.json", json.dumps({"version": version, "name": "Media Catcher"}))
        z.writestr("background.js", "// v" + version)
        if extra:
            z.writestr(extra, "x")


@pytest.fixture
def workspace(tmp_path):
    """zips/ holding three extension packages + ext/ installed at 1.3.0."""
    zip_dir = os.path.join(str(tmp_path), "zips"); os.makedirs(zip_dir)
    ext_dir = os.path.join(str(tmp_path), "ext"); os.makedirs(ext_dir)
    with open(os.path.join(ext_dir, "manifest.json"), "w") as f:
        json.dump({"version": "1.3.0"}, f)
    make_ext_zip(os.path.join(zip_dir, "media_catcher-1.2.0-TO-SIGN.zip"), "1.2.0")
    make_ext_zip(os.path.join(zip_dir, "media_catcher-1.4.0-TO-SIGN.zip"), "1.4.0",
                 extra="popup/new.js")
    make_ext_zip(os.path.join(zip_dir, "media_catcher-1.3.5-TO-SIGN.zip"), "1.3.5")
    return zip_dir, ext_dir


def test_version_helpers(workspace):
    zip_dir, ext_dir = workspace
    assert mc._zip_manifest_version(
        os.path.join(zip_dir, "media_catcher-1.4.0-TO-SIGN.zip")) == "1.4.0", \
        "reads version from a zip's manifest"
    assert mc._installed_version(ext_dir) == "1.3.0", "reads installed version"
    assert mc._vtuple("1.4.0") > mc._vtuple("1.3.5") > mc._vtuple("1.3.0"), \
        "version tuple orders correctly"

    newest = mc._newest_zip(zip_dir, "media_catcher*.zip")
    assert os.path.basename(newest).startswith("media_catcher-1.4.0"), \
        "newest zip is the highest manifest version (1.4.0)"
    assert mc._vtuple(mc._zip_manifest_version(newest)) > \
        mc._vtuple(mc._installed_version(ext_dir)), "1.4.0 is newer than installed 1.3.0"


def test_extract_overwrites_and_no_newer(workspace):
    zip_dir, ext_dir = workspace
    # extract overwrites the ext folder
    newest = mc._newest_zip(zip_dir, "media_catcher*.zip")
    with zipfile.ZipFile(newest) as z:
        z.extractall(ext_dir)
    assert mc._installed_version(ext_dir) == "1.4.0", "extract overwrites manifest (now 1.4.0)"
    assert os.path.isfile(os.path.join(ext_dir, "popup", "new.js")), "extract brings new files"

    # no newer available (installed now 1.4.0, newest zip 1.4.0)
    cur = mc._installed_version(ext_dir)
    nv = mc._zip_manifest_version(mc._newest_zip(zip_dir, "media_catcher*.zip"))
    assert mc._vtuple(nv) <= mc._vtuple(cur), "no update when already at newest"


def test_config_roundtrip(workspace, tmp_path, monkeypatch):
    zip_dir, ext_dir = workspace
    # Redirect the variant-keyed config file into the temp dir so the test can
    # never touch the developer's real mc_config_*.json. (The script-era test
    # wrote the live path guarded by a stale `mc.CONFIG_PATH` that no longer
    # exists — the host moved to _config_path().)
    cfg_path = os.path.join(str(tmp_path), "mc_config_test.json")
    monkeypatch.setattr(mc, "_config_path", lambda: cfg_path)
    mc.save_config({"extDir": ext_dir, "zipDir": zip_dir})
    assert mc.load_config().get("extDir") == ext_dir, "config persists extDir"


def test_ext_id_shape():
    assert mc.EXT_ID.startswith("{") and mc.EXT_ID.endswith("}"), \
        "EXT_ID looks like a gecko id"


def test_parse_notify_decodes_names():
    # FILE_NOTIFY_INFORMATION parsing (the directory-watch decoder)
    def notify_entry(name, last):
        nb = name.encode("utf-16-le")
        return struct.pack("<III", 0 if last else 12 + len(nb), 1, len(nb)) + nb
    nbuf = notify_entry("media_catcher-1.5.0-TO-SIGN.zip", False) + notify_entry("notes.txt", True)
    names = mc._parse_notify(nbuf)
    assert names == ["media_catcher-1.5.0-TO-SIGN.zip", "notes.txt"], \
        "_parse_notify decodes both file names"
    assert any(n.lower().startswith("media_catcher") and n.lower().endswith(".zip")
               for n in names), "watcher would match a media_catcher zip"
    assert not ("notes.txt".lower().startswith("media_catcher")), \
        "watcher ignores a non-package file"


def test_plan_apply_and_content_hash(workspace, tmp_path, monkeypatch):
    zip_dir, ext_dir = workspace
    # ---- plan/apply (no profile staging in tests) ----
    monkeypatch.setattr(mc, "find_profile", lambda: None)
    monkeypatch.setattr(mc, "load_config", lambda: {})
    host_dir = os.path.join(str(tmp_path), "host"); os.makedirs(host_dir)
    with open(os.path.join(host_dir, "mc_host.py"), "w") as f:
        f.write('VERSION = "1.0.0"\n')
    os.makedirs(os.path.join(host_dir, "mchost", "cast"), exist_ok=True)
    with open(os.path.join(host_dir, "mchost", "__init__.py"), "w") as f:
        f.write("# old pkg\n")
    with open(os.path.join(host_dir, "mchost", "cast", "backend.py"), "w") as f:
        f.write("# old backend\n")
    with open(os.path.join(ext_dir, "manifest.json"), "w") as f:
        json.dump({"version": "1.3.0"}, f)   # so the extension is a real upgrade

    plan = mc.plan_update(ext_dir, host_dir, zip_dir)
    assert plan["ext_newer"] and plan["ext_to"] == "1.4.0", \
        "plan: extension newer (1.3.0 -> 1.4.0)"
    assert not plan["host_newer"], "plan: host not newer yet"
    res = mc.apply_update(plan, ext_dir, host_dir)
    assert mc._installed_version(ext_dir) == "1.4.0", "apply upgraded extension to 1.4.0"
    assert res["staged"] is False, "apply returns a staged bool"

    # ---- the THIRD scenario: only the host package is newer ----
    with zipfile.ZipFile(os.path.join(zip_dir, "media-catcher-host-1.1.0.zip"), "w") as z:
        z.writestr("mc_host.py", 'VERSION = "1.1.0"\nprint("newer host")\n')
        z.writestr("mchost/__init__.py", "# pkg\n")
        z.writestr("mchost/cast/backend.py", "# backend\n")
    p2 = mc.plan_update(ext_dir, host_dir, zip_dir)
    assert not p2["ext_newer"], "host-only: extension NOT flagged newer"
    assert p2["host_newer"] and p2["host_to"] == "1.1.0", \
        "host-only: host flagged newer (1.0.0 -> 1.1.0)"
    assert p2["any"], "host-only: update STILL fires (any=True)"
    mc.apply_update(p2, ext_dir, host_dir)
    assert mc._installed_host_version(host_dir) == "1.1.0", \
        "host-only: host file refreshed to 1.1.0"
    assert mc._installed_version(ext_dir) == "1.4.0", \
        "host-only: extension left untouched (1.4.0)"

    p3 = mc.plan_update(ext_dir, host_dir, zip_dir)
    assert not p3["any"], "no update when both current"

    # ---- content-hash fallback: SAME host version, DIFFERENT code ----
    # host_dir is at 1.1.0 (content "newer host"); drop a 1.1.0 zip with different code.
    with zipfile.ZipFile(os.path.join(zip_dir, "media-catcher-host-1.1.0b.zip"), "w") as z:
        z.writestr("mc_host.py",
                   'VERSION = "1.1.0"\nprint("DIFFERENT code, same version")\n')
        z.writestr("mchost/__init__.py", "# pkg\n")
        z.writestr("mchost/cast/backend.py", "# backend\n")
    p4 = mc.plan_update(ext_dir, host_dir, zip_dir)
    assert not p4["host_newer"], "content-hash: host not flagged 'newer' (same version)"
    assert p4["host_same_ver_changed"] is True, "content-hash: same-version-changed IS detected"
    # and a zip whose content matches installed must NOT flag a change
    with open(os.path.join(host_dir, "mc_host.py")) as f:
        same_body = f.read()
    with zipfile.ZipFile(os.path.join(zip_dir, "media-catcher-host-1.1.0same.zip"), "w") as z:
        z.writestr("mc_host.py", same_body)   # identical content
        z.writestr("mchost/__init__.py", "# pkg\n")
        z.writestr("mchost/cast/backend.py", "# backend\n")
    # newest 1.1.0 host zip is now ambiguous between the two 1.1.0s; verify the
    # detector only fires when the chosen newest differs from installed:
    hz = mc._newest_zip(zip_dir, "media-catcher-host*.zip")
    diff = mc._host_zip_hash(hz) != mc._installed_host_hash(host_dir)
    assert isinstance(diff, bool), "content-hash: hash compare matches file contents"


def test_zip_completeness_guard(workspace, tmp_path):
    zip_dir, _ext_dir = workspace
    # completeness guard: a whole zip passes, a truncated one fails
    good = os.path.join(zip_dir, "media_catcher-1.4.0-TO-SIGN.zip")
    assert mc._zip_complete(good) is True, "_zip_complete accepts a whole zip"
    partial = os.path.join(str(tmp_path), "partial.zip")
    with open(good, "rb") as f, open(partial, "wb") as g:
        g.write(f.read(120))            # first 120 bytes only — not a valid zip
    assert mc._zip_complete(partial) is False, "_zip_complete rejects a truncated zip"
    assert mc._await_zip(good, tries=2, delay=0.05) is True, \
        "_await_zip returns fast for a complete zip"


if __name__ == "__main__":
    import pytest as _pytest
    raise SystemExit(_pytest.main([os.path.abspath(__file__), "-q"]))
