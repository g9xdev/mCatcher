"""Offline test for guardian.ps1: backup / apply / verify / revert, headless.
Requires PowerShell + Python. Run:  python -m pytest test_guardian.py -q
(or directly:  py test_guardian.py)"""
import json
import os
import subprocess
import sys
import zipfile

import pytest

from conftest import HERE, wait_for

GUARDIAN = os.path.join(HERE, "guardian.ps1")


def run_guardian(work, cfg):
    confpath = os.path.join(work, "config.json")
    with open(confpath, "w") as f:
        json.dump(cfg, f)
    r = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                        "-File", GUARDIAN, "-Config", confpath, "-NoUi", "-NoRestart"],
                       capture_output=True, text=True)
    return r.returncode


def ext_ver(d):
    try:
        with open(os.path.join(d, "manifest.json")) as f:
            return json.load(f).get("version")
    except Exception:
        return None


def host_txt(d):
    try:
        with open(os.path.join(d, "mc_host.py")) as f:
            return f.read()
    except Exception:
        return ""


def ext_zip(path, version, valid=True):
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("manifest.json", json.dumps({"version": version}) if valid else "{ not json")
        z.writestr("background.js", "//v" + version)


def host_zip(path, body):
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("media-catcher-host/mc_host.py", body)


def pythonw():
    # The real host runs under pythonw.exe, which leaves $LASTEXITCODE unreadable — the
    # guardian's verify must normalize it back to python.exe or it reverts every host
    # update. Feed it pythonw here so that regression can't hide behind python.exe.
    cand = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
    return cand if os.path.exists(cand) else sys.executable


@pytest.fixture
def guardian_ws(tmp_path):
    """work dir + ext/ at 1.3.0 (with a user file) + zips/ + the base config."""
    work = str(tmp_path)
    extdir = os.path.join(work, "ext"); os.makedirs(extdir)
    json.dump({"version": "1.3.0"}, open(os.path.join(extdir, "manifest.json"), "w"))
    open(os.path.join(extdir, "keepme.txt"), "w").write("x")   # a user file to prove revert restores it
    zdir = os.path.join(work, "zips"); os.makedirs(zdir)
    base = dict(applyExt=True, applyHost=False, extZip=None, hostZip=None, extDir=extdir,
                hostDir="", profileDir="", extId="{id}", expectExtVersion=None,
                expectHostVersion=None, python=pythonw(), firefox="", restart=False,
                backupRoot=os.path.join(work, "backups"), keep=3)
    return work, extdir, zdir, base


def test_guardian_apply_verify_revert_prune(guardian_ws):
    work, extdir, zdir, base = guardian_ws

    # 1) good extension update
    good = os.path.join(zdir, "media_catcher-1.4.0.zip"); ext_zip(good, "1.4.0")
    c1 = dict(base); c1["extZip"] = good; c1["expectExtVersion"] = "1.4.0"
    assert run_guardian(work, c1) == 0, "good extension update exits 0"
    assert ext_ver(extdir) == "1.4.0", "extension upgraded to 1.4.0"

    # 2) bad extension update (invalid manifest) -> verify fails -> auto-revert
    bad = os.path.join(zdir, "media_catcher-1.5.0.zip"); ext_zip(bad, "1.5.0", valid=False)
    c2 = dict(base); c2["extZip"] = bad; c2["expectExtVersion"] = "1.5.0"
    assert run_guardian(work, c2) == 2, "bad extension update exits 2 (reverted)"
    assert ext_ver(extdir) == "1.4.0", "extension reverted to valid 1.4.0"
    assert os.path.isfile(os.path.join(extdir, "keepme.txt")), "user file survived the revert"

    # 3) good host update
    hostdir = os.path.join(work, "host"); os.makedirs(hostdir)
    open(os.path.join(hostdir, "mc_host.py"), "w").write('VERSION = "1.0.0"\n')
    hg = os.path.join(zdir, "media-catcher-host-good.zip"); host_zip(hg, 'VERSION = "1.1.0"\nx = 1\n')
    c3 = dict(base, applyExt=False, applyHost=True, hostZip=hg, hostDir=hostdir,
              expectHostVersion="1.1.0")
    assert run_guardian(work, c3) == 0, "good host update exits 0"
    assert 'VERSION = "1.1.0"' in host_txt(hostdir), "host upgraded to 1.1.0"

    # 4) bad host update (won't compile) -> verify fails -> auto-revert
    hb = os.path.join(zdir, "media-catcher-host-bad.zip"); host_zip(hb, 'VERSION = "1.2.0"\ndef (:\n')
    c4 = dict(c3); c4["hostZip"] = hb; c4["expectHostVersion"] = "1.2.0"
    assert run_guardian(work, c4) == 2, "bad host update exits 2 (reverted)"
    assert 'VERSION = "1.1.0"' in host_txt(hostdir), "host reverted to compiling 1.1.0"

    # 5) backups are pruned to keep=3
    n = len([d for d in os.listdir(os.path.join(work, "backups"))
             if os.path.isdir(os.path.join(work, "backups", d))])
    assert n <= 3, "backups pruned to <= keep(3)"


def test_guardian_detached_spawn(guardian_ws):
    # 6) the guardian must actually RUN when spawned the way mc_host spawns it:
    # detached with a HIDDEN CONSOLE (CREATE_NO_WINDOW). DETACHED_PROCESS gives no
    # console, and Windows PowerShell dies before its first line — the bug that made
    # every real auto-update a silent no-op while tests (synchronous, inherited stdio)
    # stayed green. A detached Popen has no synchronous exit code, so poll the log.
    work, extdir, zdir, base = guardian_ws
    hdir6 = os.path.join(work, "host6"); os.makedirs(hdir6)
    open(os.path.join(hdir6, "mc_host.py"), "w").write('VERSION = "1.0.0"\n')
    hg6 = os.path.join(zdir, "media-catcher-host-detached.zip")
    host_zip(hg6, 'VERSION = "1.1.0"\ny = 2\n')
    braw = os.path.join(work, "backups6")
    c6 = dict(base, applyExt=False, applyHost=True, hostZip=hg6, hostDir=hdir6,
              expectHostVersion="1.1.0", backupRoot=braw)
    confp = os.path.join(work, "config6.json"); json.dump(c6, open(confp, "w"))
    NO_WINDOW, NEW_GROUP = 0x08000000, 0x00000200        # NOT 0x08 DETACHED_PROCESS
    flags = (NO_WINDOW | NEW_GROUP) if os.name == "nt" else 0
    subprocess.Popen(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                      "-WindowStyle", "Hidden",
                      "-File", GUARDIAN, "-Config", confp, "-NoUi", "-NoRestart"],
                     creationflags=flags, close_fds=True)
    logf = os.path.join(braw, "guardian.log")

    def _guardian_logged_ok():
        return os.path.exists(logf) and \
            "verify OK" in open(logf, encoding="utf-8-sig", errors="ignore").read()

    ran = wait_for(_guardian_logged_ok, timeout=30, interval=0.5)
    assert ran, "detached guardian actually ran + logged (CREATE_NO_WINDOW)"
    assert 'VERSION = "1.1.0"' in host_txt(hdir6), "detached guardian upgraded host to 1.1.0"


if __name__ == "__main__":
    import pytest as _pytest
    raise SystemExit(_pytest.main([os.path.abspath(__file__), "-q"]))
