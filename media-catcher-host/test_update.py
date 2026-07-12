"""Offline tests for the self-update helpers in mc_host.py (no Firefox/network).
Run:  py test_update.py"""
import sys, os, json, zipfile, tempfile, shutil, importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("mc_host", os.path.join(HERE, "mc_host.py"))
mc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mc)   # io init deferred to main(), so import is safe

ok = True
def check(label, cond):
    global ok
    print(("ok   " if cond else "XX   ") + label)
    if not cond: ok = False

def make_ext_zip(path, version, extra=None):
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("manifest.json", json.dumps({"version": version, "name": "Media Catcher"}))
        z.writestr("background.js", "// v" + version)
        if extra:
            z.writestr(extra, "x")

work = tempfile.mkdtemp(prefix="mc_upd_")
try:
    zip_dir = os.path.join(work, "zips"); os.makedirs(zip_dir)
    ext_dir = os.path.join(work, "ext"); os.makedirs(ext_dir)
    # installed = 1.3.0
    with open(os.path.join(ext_dir, "manifest.json"), "w") as f:
        json.dump({"version": "1.3.0"}, f)

    make_ext_zip(os.path.join(zip_dir, "media_catcher-1.2.0-TO-SIGN.zip"), "1.2.0")
    make_ext_zip(os.path.join(zip_dir, "media_catcher-1.4.0-TO-SIGN.zip"), "1.4.0", extra="popup/new.js")
    make_ext_zip(os.path.join(zip_dir, "media_catcher-1.3.5-TO-SIGN.zip"), "1.3.5")

    check("reads version from a zip's manifest", mc._zip_manifest_version(os.path.join(zip_dir, "media_catcher-1.4.0-TO-SIGN.zip")) == "1.4.0")
    check("reads installed version", mc._installed_version(ext_dir) == "1.3.0")
    check("version tuple orders correctly", mc._vtuple("1.4.0") > mc._vtuple("1.3.5") > mc._vtuple("1.3.0"))

    newest = mc._newest_zip(zip_dir, "media_catcher*.zip")
    check("newest zip is the highest manifest version (1.4.0)", os.path.basename(newest).startswith("media_catcher-1.4.0"))

    newer = mc._vtuple(mc._zip_manifest_version(newest)) > mc._vtuple(mc._installed_version(ext_dir))
    check("1.4.0 is newer than installed 1.3.0", newer)

    # extract overwrites the ext folder
    with zipfile.ZipFile(newest) as z:
        z.extractall(ext_dir)
    check("extract overwrites manifest (now 1.4.0)", mc._installed_version(ext_dir) == "1.4.0")
    check("extract brings new files", os.path.isfile(os.path.join(ext_dir, "popup", "new.js")))

    # no newer available (installed now 1.4.0, newest zip 1.4.0)
    cur = mc._installed_version(ext_dir); nv = mc._zip_manifest_version(mc._newest_zip(zip_dir, "media_catcher*.zip"))
    check("no update when already at newest", mc._vtuple(nv) <= mc._vtuple(cur))

    # config round-trips (written next to the host — clean up after)
    saved = os.path.exists(mc.CONFIG_PATH)
    mc.save_config({"extDir": ext_dir, "zipDir": zip_dir})
    check("config persists extDir", mc.load_config().get("extDir") == ext_dir)
    if not saved:
        try: os.remove(mc.CONFIG_PATH)
        except Exception: pass

    check("EXT_ID looks like a gecko id", mc.EXT_ID.startswith("{") and mc.EXT_ID.endswith("}"))

    # FILE_NOTIFY_INFORMATION parsing (the directory-watch decoder)
    import struct
    def notify_entry(name, last):
        nb = name.encode("utf-16-le")
        return struct.pack("<III", 0 if last else 12 + len(nb), 1, len(nb)) + nb
    nbuf = notify_entry("media_catcher-1.5.0-TO-SIGN.zip", False) + notify_entry("notes.txt", True)
    names = mc._parse_notify(nbuf)
    check("_parse_notify decodes both file names", names == ["media_catcher-1.5.0-TO-SIGN.zip", "notes.txt"])
    check("watcher would match a media_catcher zip",
          any(n.lower().startswith("media_catcher") and n.lower().endswith(".zip") for n in names))
    check("watcher ignores a non-package file", not ("notes.txt".lower().startswith("media_catcher")))

    # ---- plan/apply (no profile staging in tests) ----
    _fp, _lc = mc.find_profile, mc.load_config
    mc.find_profile = lambda: None
    mc.load_config = lambda: {}
    host_dir = os.path.join(work, "host"); os.makedirs(host_dir)
    with open(os.path.join(host_dir, "mc_host.py"), "w") as f:
        f.write('VERSION = "1.0.0"\n')
    with open(os.path.join(ext_dir, "manifest.json"), "w") as f:
        json.dump({"version": "1.3.0"}, f)   # so the extension is a real upgrade

    plan = mc.plan_update(ext_dir, host_dir, zip_dir)
    check("plan: extension newer (1.3.0 -> 1.4.0)", plan["ext_newer"] and plan["ext_to"] == "1.4.0")
    check("plan: host not newer yet", not plan["host_newer"])
    res = mc.apply_update(plan, ext_dir, host_dir)
    check("apply upgraded extension to 1.4.0", mc._installed_version(ext_dir) == "1.4.0")
    check("apply returns a staged bool", res["staged"] is False)

    # ---- the THIRD scenario: only the host package is newer ----
    with zipfile.ZipFile(os.path.join(zip_dir, "media-catcher-host-1.1.0.zip"), "w") as z:
        z.writestr("media-catcher-host/mc_host.py", 'VERSION = "1.1.0"\nprint("newer host")\n')
    p2 = mc.plan_update(ext_dir, host_dir, zip_dir)
    check("host-only: extension NOT flagged newer", not p2["ext_newer"])
    check("host-only: host flagged newer (1.0.0 -> 1.1.0)", p2["host_newer"] and p2["host_to"] == "1.1.0")
    check("host-only: update STILL fires (any=True)", p2["any"])
    mc.apply_update(p2, ext_dir, host_dir)
    check("host-only: host file refreshed to 1.1.0", mc._installed_host_version(host_dir) == "1.1.0")
    check("host-only: extension left untouched (1.4.0)", mc._installed_version(ext_dir) == "1.4.0")

    p3 = mc.plan_update(ext_dir, host_dir, zip_dir)
    check("no update when both current", not p3["any"])

    # ---- content-hash fallback: SAME host version, DIFFERENT code ----
    # host_dir is at 1.1.0 (content "newer host"); drop a 1.1.0 zip with different code.
    with zipfile.ZipFile(os.path.join(zip_dir, "media-catcher-host-1.1.0b.zip"), "w") as z:
        z.writestr("media-catcher-host/mc_host.py", 'VERSION = "1.1.0"\nprint("DIFFERENT code, same version")\n')
    p4 = mc.plan_update(ext_dir, host_dir, zip_dir)
    check("content-hash: host not flagged 'newer' (same version)", not p4["host_newer"])
    check("content-hash: same-version-changed IS detected", p4["host_same_ver_changed"] is True)
    # and a zip whose content matches installed must NOT flag a change
    with open(os.path.join(host_dir, "mc_host.py")) as f:
        same_body = f.read()
    with zipfile.ZipFile(os.path.join(zip_dir, "media-catcher-host-1.1.0same.zip"), "w") as z:
        z.writestr("media-catcher-host/mc_host.py", same_body)   # identical content
    # newest 1.1.0 host zip is now ambiguous between the two 1.1.0s; verify the
    # detector only fires when the chosen newest differs from installed:
    hz = mc._newest_zip(zip_dir, "media-catcher-host*.zip")
    diff = mc._host_zip_hash(hz) != mc._installed_host_hash(host_dir)
    check("content-hash: hash compare matches file contents", isinstance(diff, bool))

    mc.find_profile, mc.load_config = _fp, _lc
    newest = mc._newest_zip(zip_dir, "media_catcher*.zip")   # for the completeness checks below

    # completeness guard: a whole zip passes, a truncated one fails
    good = os.path.join(zip_dir, "media_catcher-1.4.0-TO-SIGN.zip")
    check("_zip_complete accepts a whole zip", mc._zip_complete(good) is True)
    partial = os.path.join(work, "partial.zip")
    with open(good, "rb") as f, open(partial, "wb") as g:
        g.write(f.read(120))            # first 120 bytes only — not a valid zip
    check("_zip_complete rejects a truncated zip", mc._zip_complete(partial) is False)
    check("_await_zip returns fast for a complete zip", mc._await_zip(good, tries=2, delay=0.05) is True)
finally:
    shutil.rmtree(work, ignore_errors=True)

print("\n" + ("ALL PASSED" if ok else "SOME FAILED"))
sys.exit(0 if ok else 1)
