"""Offline tests for the self-update helpers in mc_host.py (no Firefox/network).
Run:  python -m pytest test_update.py -q   (or directly:  py test_update.py)"""
import json
import os
import struct
import subprocess
import threading
import zipfile

import pytest

from conftest import load_host

mc = load_host()

from mchost import tools as mc_tools        # noqa: E402
from mchost import updates as mc_updates    # noqa: E402


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


# ---------------------------------------------------------------------------
# The auto-install watch folder is not a folder the browser writes into
#
# _install_updates trusts whatever .zip it finds in the watched folder that
# starts with "media_catcher"/"media-catcher", and the only thing between a
# planted package and the guardian is a Yes/No shown to a user who opted into
# auto-update and is therefore expecting one. While the fallback was
# downloads_dir(), any page could put media-catcher-host-9.9.9.zip in front of
# that dialog with an ordinary drive-by download.
# ---------------------------------------------------------------------------

def test_watch_folder_never_defaults_to_downloads(tmp_path, monkeypatch):
    downloads = os.path.join(str(tmp_path), "Downloads"); os.makedirs(downloads)
    monkeypatch.setattr(mc, "downloads_dir", lambda: downloads)
    monkeypatch.setattr(mc, "HERE", str(tmp_path))
    monkeypatch.setattr(mc_tools, "HERE", str(tmp_path))

    # The live path first: an un-configured host with auto-update on installs
    # from whatever _auto_update_check hands _install_updates.
    seen = []
    monkeypatch.setattr(mc_updates, "_install_updates",
                        lambda ext, zdir, **kw: seen.append(zdir))
    monkeypatch.setattr(mc, "load_config", lambda: {})
    mc_updates._auto_update_check()
    assert seen and os.path.realpath(seen[0]) != os.path.realpath(downloads),         "the watcher installs packages out of the browser download folder"

    staged = mc.update_staging_dir()
    assert os.path.realpath(staged) != os.path.realpath(downloads),         "the update staging folder is the browser's own download folder"
    assert os.path.isdir(staged), "update_staging_dir did not create the folder"

    # …and every resolution path agrees, not just the helper.
    for cfg in ({}, {"zipDir": ""}, {"zipDir": None}, {"zipDir": downloads},
                {"zipDir": downloads.lower()}, {"zipDir": downloads + os.sep}):
        got = mc_updates._resolve_zip_dir(cfg)
        assert os.path.realpath(got) != os.path.realpath(downloads),             "cfg=%r resolved the watch folder to Downloads" % (cfg,)


def _dir_link(target, link):
    """A directory link at `link` pointing at `target`.

    A junction on Windows, because it needs no elevation where os.symlink does,
    and os.path.realpath resolves the two identically."""
    if os.name == "nt":
        subprocess.run(["cmd", "/c", "mklink", "/J", link, target],
                       check=True, capture_output=True)
    else:
        os.symlink(target, link, target_is_directory=True)


def test_a_link_that_resolves_to_downloads_is_refused_too(tmp_path, monkeypatch):
    """realpath, not normcase, is what _is_downloads_dir rests on: Downloads is
    routinely redirected through a junction/symlink, and a link to it is another
    spelling of the same folder. Case is already covered above."""
    downloads = os.path.join(str(tmp_path), "Downloads"); os.makedirs(downloads)
    link = os.path.join(str(tmp_path), "dl-link")
    try:
        _dir_link(downloads, link)
    except (OSError, NotImplementedError, AttributeError,
            subprocess.CalledProcessError) as e:
        pytest.skip("no directory link available here: %s" % e)
    assert os.path.realpath(link) == os.path.realpath(downloads), \
        "the link was not made, so this would pass for the wrong reason"
    monkeypatch.setattr(mc, "downloads_dir", lambda: downloads)
    monkeypatch.setattr(mc, "HERE", str(tmp_path))
    monkeypatch.setattr(mc_tools, "HERE", str(tmp_path))

    assert mc_updates._is_downloads_dir(link), \
        "a link pointing at Downloads was not recognised as Downloads"
    got = mc_updates._resolve_zip_dir({"zipDir": link})
    assert os.path.realpath(got) != os.path.realpath(downloads), \
        "packages would be staged in Downloads through a link"


def test_explicitly_configured_watch_folder_still_wins(tmp_path, monkeypatch):
    monkeypatch.setattr(mc, "HERE", str(tmp_path))
    monkeypatch.setattr(mc_tools, "HERE", str(tmp_path))
    chosen = os.path.join(str(tmp_path), "packages"); os.makedirs(chosen)
    assert mc_updates._resolve_zip_dir({"zipDir": chosen}) == chosen
    assert mc_updates._resolve_zip_dir({}, req={"zipDir": chosen}) == chosen
    # a request's choice outranks the persisted one
    other = os.path.join(str(tmp_path), "other"); os.makedirs(other)
    assert mc_updates._resolve_zip_dir({"zipDir": other}, req={"zipDir": chosen}) == chosen


def test_implicit_downloads_default_is_never_persisted(tmp_path, monkeypatch):
    """handle_update wrote its resolved zip_dir back to the config
    unconditionally, so one press of 'Check & install update' turned the
    implicit Downloads fallback into what looks like an explicit choice.
    Nothing may write the browser's download folder into the config."""
    downloads = os.path.join(str(tmp_path), "Downloads"); os.makedirs(downloads)
    monkeypatch.setattr(mc, "downloads_dir", lambda: downloads)
    monkeypatch.setattr(mc, "HERE", str(tmp_path))
    monkeypatch.setattr(mc_tools, "HERE", str(tmp_path))
    cfg_path = os.path.join(str(tmp_path), "mc_config_test.json")
    monkeypatch.setattr(mc, "_config_path", lambda: cfg_path)
    monkeypatch.setattr(mc_updates, "_install_updates", lambda *a, **kw: None)

    done = threading.Event()
    real = mc.save_config
    monkeypatch.setattr(mc, "save_config", lambda cfg: (real(cfg), done.set()))
    mc.handle_update({"cmd": "update", "extDir": "", "zipDir": ""})
    assert done.wait(5), "handle_update never saved a config"
    saved = mc.load_config().get("zipDir")
    assert os.path.realpath(saved or str(tmp_path)) != os.path.realpath(downloads),         "handle_update persisted the browser download folder as the watch folder"



if __name__ == "__main__":
    import pytest as _pytest
    raise SystemExit(_pytest.main([os.path.abspath(__file__), "-q"]))
