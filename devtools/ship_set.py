"""What each artifact ships, derived from one authority per artifact.

HOST. The authority is the installer's own `[Files]` section. This module reads
it rather than restating it, so there is no second list to drift: adding a
`Source:` line to the .iss changes what this returns. The parser understands
only the forms that file actually uses and raises on anything else, so a new
form is a loud failure rather than a file that silently escapes verification.

Note this is narrower than the approved spec, which called for an independent
rule plus a test asserting it agreed with the .iss. Reading the .iss reaches the
same goal — one authority — without the duplication the agreement test existed
to police. `test_ship_set.py` pins the parsed result against an explicit
expected set, so a parser regression is still caught.

EXTENSION. There is no equivalent declaration: release packaging archives
`media-catcher/*` wholesale, which ships the test suite and editor config. The
authority here is therefore this module, and the exclusions are explicit.

Standard library only. No PowerShell.
"""
import os
import re

# Directories under media-catcher/ that exist for development, not for users.
EXTENSION_EXCLUDE_DIRS = ("tests", ".vscode")

_DEFINE = re.compile(r'^\s*#define\s+(\w+)\s+"([^"]*)"', re.MULTILINE)
_FILES_SECTION = re.compile(r'^\[Files\](.*?)(?=^\[)', re.MULTILINE | re.DOTALL)
_SOURCE_LINE = re.compile(
    r'^\s*Source:\s*"(?P<src>[^"]+)"\s*;\s*'
    r'DestDir:\s*"(?P<dest>[^"]+)"\s*;\s*'
    r'Flags:\s*(?P<flags>[^;\r\n]+)'
    r'(?:;\s*Excludes:\s*"(?P<excludes>[^"]*)")?\s*$'
)


class ShipSetError(Exception):
    """The installer declares something this parser will not guess at."""


def _normalise(rel):
    return rel.replace("\\", "/").strip("/")


def _excluded(rel, patterns):
    """Inno Excludes as used here: '__pycache__\\*' and '*.pyc'."""
    parts = _normalise(rel).split("/")
    for raw in patterns:
        pat = _normalise(raw)
        if pat.endswith("/*"):
            if pat[:-2] in parts[:-1]:
                return True
        elif pat.startswith("*."):
            if parts[-1].endswith(pat[1:]):
                return True
        elif pat == parts[-1]:
            return True
    return False


def parse_iss_files(iss_path):
    """Map each installed relative path to the source file it comes from.

    Keys are relative to the install directory ({app}); values are absolute
    source paths. Raises ShipSetError on any construct not understood.
    """
    iss_dir = os.path.dirname(os.path.abspath(iss_path))
    with open(iss_path, encoding="utf-8-sig") as f:
        text = f.read()

    defines = {m.group(1): m.group(2) for m in _DEFINE.finditer(text)}
    section = _FILES_SECTION.search(text)
    if not section:
        raise ShipSetError("no [Files] section in %s" % iss_path)

    shipped = {}
    for line in section.group(1).splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith(";"):
            continue
        match = _SOURCE_LINE.match(line)
        if not match:
            raise ShipSetError("unrecognised [Files] entry: %r" % stripped)

        src = match.group("src")
        for name, value in defines.items():
            src = src.replace("{#%s}" % name, value)
        if "{#" in src:
            raise ShipSetError("unresolved define in Source: %r" % match.group("src"))

        dest = match.group("dest")
        if dest == "{app}":
            dest_rel = ""
        elif dest.startswith("{app}\\") or dest.startswith("{app}/"):
            dest_rel = _normalise(dest[len("{app}"):])
        else:
            raise ShipSetError("unsupported DestDir: %r" % dest)

        flags = match.group("flags").split()
        excludes = [p for p in (match.group("excludes") or "").split(",") if p]

        if src.endswith("\\*") or src.endswith("/*"):
            if "recursesubdirs" not in flags:
                raise ShipSetError("wildcard Source without recursesubdirs: %r" % stripped)
            root = os.path.normpath(os.path.join(iss_dir, src[:-2]))
            if not os.path.isdir(root):
                raise ShipSetError("wildcard Source root missing: %s" % root)
            for base, dirs, names in os.walk(root):
                dirs.sort()
                for name in sorted(names):
                    abs_path = os.path.join(base, name)
                    rel = _normalise(os.path.relpath(abs_path, root))
                    if _excluded(rel, excludes):
                        continue
                    shipped[_normalise("%s/%s" % (dest_rel, rel))] = abs_path
        else:
            abs_path = os.path.normpath(os.path.join(iss_dir, src))
            rel = _normalise("%s/%s" % (dest_rel, os.path.basename(src)))
            shipped[rel] = abs_path
    return shipped


def host_ship_set(repo_root="."):
    """Installed-relative path -> source path, per the installer's declaration."""
    return parse_iss_files(os.path.join(
        repo_root, "media-catcher-host", "installer", "media-catcher-host.iss"))


def extension_ship_set(repo_root=".", exclude_dirs=EXTENSION_EXCLUDE_DIRS):
    """Archive-relative path -> source path for the extension package.

    Excludes development-only directories, which release packaging currently
    ships: a test edit would otherwise change the artifact, marking the
    extension stale for a change that cannot affect it.
    """
    root = os.path.abspath(os.path.join(repo_root, "media-catcher"))
    if not os.path.isdir(root):
        raise ShipSetError("extension root missing: %s" % root)
    shipped = {}
    for base, dirs, names in os.walk(root):
        dirs[:] = sorted(d for d in dirs
                         if _normalise(os.path.relpath(os.path.join(base, d), root))
                         .split("/")[0] not in exclude_dirs)
        for name in sorted(names):
            abs_path = os.path.join(base, name)
            shipped[_normalise(os.path.relpath(abs_path, root))] = abs_path
    if "manifest.json" not in shipped:
        raise ShipSetError("manifest.json must be at the extension root")
    return shipped
