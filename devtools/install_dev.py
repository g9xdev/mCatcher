"""Pure core of the deterministic developer install.

Design: docs/superpowers/specs/2026-08-14-deterministic-dev-install-design.md

What lives here is only the side-effect-free logic — content hashing, target
resolution from text, deterministic packaging, and receipt diffing. The
destructive half (enumerating and closing Firefox, running ISCC and the
installer, copying files, the CLI) is deliberately absent while its design is
under review; the seams it will attach to are marked below.

Freshness is content-addressed. Version strings are never consulted: on
2026-08-14 the host's VERSION stayed "1.10.0" across a build, two further
commits, and the install, and every version-based check reported "current".

Python 3 standard library only, and no PowerShell anywhere. Everything in this
module is OS-independent so it is testable off Windows; the Windows-specific
lookups (registry, process table) belong to the orchestration layer, behind
injectable adapters in the style of `_ask_folder(default_dir, api=None)` in
media-catcher-host/mchost/downloads.py.
"""
import configparser
import hashlib
import io
import json
import os
import re
import zipfile


def _ship_set():
    """Import lazily and by module name so the pure functions above stay
    importable on their own, and so the sibling resolves whether this package
    is imported as `devtools.install_dev` or run from inside `devtools/`."""
    try:
        import ship_set as module
    except ImportError:  # imported as part of a package
        import os as _os
        import sys as _sys
        _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
        import ship_set as module
    return module


__all__ = [
    "sha256_bytes", "hash_file", "expand_ship_set", "hash_tree", "hash_files",
    "hash_mapping", "hash_host_ship_set", "hash_extension_ship_set",
    "hash_extension_sources", "hash_host_sources",
    "find_dev_profile",
    "build_xpi_bytes", "write_xpi",
    "load_receipt", "save_receipt", "make_receipt", "diff",
    "needs_install", "all_in_sync", "Verdict",
    "iscc_candidates", "find_iscc",
]


# ---------------------------------------------------------------------------
# Ship sets
#
# What gets hashed is what gets INSTALLED — not what happens to sit in the
# directory. The host's runtime set is narrower than `media-catcher-host/*.py`:
# conftest.py, every test_*.py, and __pycache__ are never installed, so hashing
# them would report a permanent "stale" after any test edit and would make the
# packaging check ("a source file absent from the install means the .iss is
# incomplete") unfalsifiable. Compare the shipping definitions:
#   .github/workflows/release.yml  "Host: only the runtime files (no ffmpeg,
#                                   tests, installer, or machine files)"
#   installer/media-catcher-host.iss  Excludes: "__pycache__\*,*.pyc"
#
# The sets are parameters on every entry point so the ship-set question stays a
# single decision point rather than being baked into the hasher.
# ---------------------------------------------------------------------------

# Generic defaults for the tree hasher below. These are NOT the ship set --
# `ship_set.py` is, deriving the host set from the installer's own [Files]
# declaration and the extension set from an explicit exclusion list.
_DEFAULT_HOST_PATTERNS = ("mc_host.py", "mchost/**")
_DEFAULT_EXTENSION_PATTERNS = ("**",)
DEFAULT_EXCLUDES = ("**/__pycache__/**", "**/*.pyc", "**/.DS_Store", "**/Thumbs.db")

# Domain separator: a digest of this tree is never mistakable for a digest of
# anything else, and the version suffix lets the framing change deliberately.
_TREE_DOMAIN = b"mcatcher-install-tree-v1\n"


# ---------------------------------------------------------------------------
# 1. Content hashing
# ---------------------------------------------------------------------------

def sha256_bytes(data):
    """Hex SHA-256 of a bytes object."""
    return hashlib.sha256(data).hexdigest()


def hash_file(path):
    """Hex SHA-256 of a file's bytes, read in chunks."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _glob_to_regex(pattern):
    """Translate a ship-set glob to a regex over '/'-joined relative paths.

    `**` crosses directory separators, `*` and `?` do not. `**/x` also matches a
    top-level `x`, which is what makes "**/*.pyc" mean "any .pyc anywhere".
    """
    out = []
    i = 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("(?s:%s)\\Z" % "".join(out))


_REGEX_CACHE = {}


def _matches_any(relpath, patterns):
    for pattern in patterns:
        cached = _REGEX_CACHE.get(pattern)
        if cached is None:
            cached = _REGEX_CACHE[pattern] = _glob_to_regex(pattern)
        if cached.match(relpath):
            return True
    return False


def expand_ship_set(root, patterns, excludes=None):
    """Relative '/'-joined paths under `root` matching `patterns`, sorted.

    Sorting is by code point, so the result — and therefore every digest and
    archive built from it — does not depend on the order the filesystem happens
    to hand back. Raises FileNotFoundError when `root` is absent, because an
    empty file list would hash to a stable digest and read as "in-sync".
    """
    if not os.path.isdir(root):
        raise FileNotFoundError(root)
    excludes = DEFAULT_EXCLUDES if excludes is None else tuple(excludes)
    patterns = tuple(patterns)
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        rel_dir = os.path.relpath(dirpath, root)
        prefix = "" if rel_dir == "." else rel_dir.replace(os.sep, "/") + "/"
        for name in filenames:
            relpath = prefix + name
            if not _matches_any(relpath, patterns):
                continue
            if _matches_any(relpath, excludes):
                continue
            found.append(relpath)
    return sorted(found)


def hash_tree(root, relpaths):
    """Digest of `relpaths` under `root`: each path, then its contents.

    Path and content are each length-framed before being fed in, so no shuffle
    of bytes between a name and a body can produce the same digest. Only
    relative paths participate, which is what makes the digest identical for
    the same sources on a different machine or checkout directory.
    """
    digest = hashlib.sha256()
    digest.update(_TREE_DOMAIN)
    for relpath in relpaths:
        encoded = relpath.encode("utf-8")
        digest.update(len(encoded).to_bytes(8, "big"))
        digest.update(encoded)
        with open(os.path.join(root, *relpath.split("/")), "rb") as handle:
            data = handle.read()
        digest.update(len(data).to_bytes(8, "big"))
        digest.update(data)
    return digest.hexdigest()


def hash_files(root, relpaths):
    """Per-file digest map, so a single changed module is identifiable."""
    return {rel: hash_file(os.path.join(root, *rel.split("/"))) for rel in relpaths}


def _hash_sources(root, ship_set, excludes):
    relpaths = expand_ship_set(root, ship_set, excludes)
    return {"sha256": hash_tree(root, relpaths), "files": hash_files(root, relpaths)}


def hash_extension_sources(extension_dir, ship_set=None, excludes=None):
    """Digest `media-catcher/`. Returns {"sha256": ..., "files": {rel: sha}}."""
    return _hash_sources(extension_dir,
                         _DEFAULT_EXTENSION_PATTERNS if ship_set is None else ship_set,
                         excludes)


def hash_host_sources(host_dir, ship_set=None, excludes=None):
    """Digest the host's SHIPPED files under `media-catcher-host/`.

    Generic over an explicit pattern set. For the real shipped set use
    `hash_host_ship_set()`, which reads the installer's declaration.
    """
    return _hash_sources(host_dir,
                         _DEFAULT_HOST_PATTERNS if ship_set is None else ship_set,
                         excludes)


def hash_mapping(mapping):
    """Digest a {installed relative path: source path} ship set.

    Keyed by where each file LANDS, not where it comes from, so an entry like
    bootstrap.ps1 -- declared in installer/ but installed at {app}/ -- compares
    correctly against the install directory.
    """
    digest = hashlib.sha256()
    digest.update(_TREE_DOMAIN)
    for rel in sorted(mapping):
        encoded = rel.encode("utf-8")
        digest.update(len(encoded).to_bytes(8, "big"))
        digest.update(encoded)
        with open(mapping[rel], "rb") as handle:
            data = handle.read()
        digest.update(len(data).to_bytes(8, "big"))
        digest.update(data)
    return {"sha256": digest.hexdigest(),
            "files": {rel: hash_file(mapping[rel]) for rel in sorted(mapping)}}


def hash_host_ship_set(repo_root="."):
    """Digest exactly what the installer declares it ships."""
    return hash_mapping(_ship_set().host_ship_set(repo_root))


def hash_extension_ship_set(repo_root="."):
    """Digest the extension package contents, tests and editor config excluded."""
    return hash_mapping(_ship_set().extension_ship_set(repo_root))


# ---------------------------------------------------------------------------
# 2. profiles.ini
#
# Which directory Developer Edition actually opened is recorded by the
# [Install<hash>] section that belongs to that install — not by the profile
# whose Name happens to read "dev-edition-default". mchost/variant.py already
# encodes the first half of this rule ("Prefer an [InstallXXChecksum] Default
# (the profile the last-used install opened)"), but it takes the FIRST install
# section, which on a machine with both channels installed can be the release
# one. Release Firefox is never touched, so an install section is only accepted
# when it resolves to a dev-edition profile.
# ---------------------------------------------------------------------------

DEV_PROFILE_MARKER = "dev-edition-default"


def _read_ini(text):
    # Firefox writes profiles.ini with a UTF-8 BOM. A caller that read it as
    # plain utf-8 would hand us "﻿[Profile0]", which configparser rejects
    # as a missing section header — and this function's contract is to return
    # None quietly, so the failure would be silent and total.
    text = text.lstrip("﻿")
    parser = configparser.ConfigParser(strict=False, interpolation=None)
    parser.optionxform = str.lower
    try:
        parser.read_string(text)
    except (configparser.Error, ValueError):
        return None
    return parser


def _resolve_profile_path(raw, firefox_dir, is_relative):
    """Join against `firefox_dir` when relative. profiles.ini writes relative
    paths with forward slashes even on Windows."""
    if is_relative:
        return os.path.normpath(os.path.join(firefox_dir, *raw.split("/")))
    return os.path.normpath(raw)


def _profile_sections(parser):
    """[(name_lowercased_or_None, resolved_raw_path, is_relative), ...]."""
    out = []
    for section in parser.sections():
        if not section.lower().startswith("profile"):
            continue
        raw = parser.get(section, "path", fallback=None)
        if not raw:
            continue
        # IsRelative is what Firefox writes; only guess when it is absent, so a
        # test on POSIX can still describe a Windows-absolute path.
        flag = parser.get(section, "isrelative", fallback=None)
        if flag is None:
            is_relative = not os.path.isabs(raw) and not re.match(r"^[A-Za-z]:", raw)
        else:
            is_relative = flag.strip() == "1"
        name = parser.get(section, "name", fallback=None)
        out.append(((name or "").strip().lower(), raw, is_relative))
    return out


def _is_dev_profile(raw_path, name, marker):
    """A profile is Developer Edition's when it is named for it, or when its
    directory carries the conventional `.dev-edition-default` suffix."""
    if name == marker:
        return True
    leaf = raw_path.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]
    return leaf.lower().endswith(marker)


def find_dev_profile(ini_text, firefox_dir, install_key=None,
                     marker=DEV_PROFILE_MARKER, exists=None):
    """Absolute path of the Developer Edition profile, or None.

    Precedence:
      1. `[Install<install_key>]`'s Default, when a key is given explicitly.
      2. Any `[Install<hash>]` Default that resolves to a dev-edition profile —
         the directory the last-used Dev Edition install actually opened.
      3. A `[Profile N]` whose Name is `dev-edition-default`.
      4. A `[Profile N]` whose directory ends in `.dev-edition-default`.

    Returns None rather than raising for a missing dev profile, an empty file,
    or unparsable text. `exists` defaults to os.path.isdir and gates the
    install-section candidates, matching mchost/variant.find_profile().
    """
    exists = os.path.isdir if exists is None else exists
    parser = _read_ini(ini_text)
    if parser is None:
        return None
    marker = marker.lower()
    profiles = _profile_sections(parser)

    def resolve_install_default(raw):
        # Install Default values are always relative to the Firefox directory.
        path = _resolve_profile_path(raw, firefox_dir, True)
        return path if exists(path) else None

    # 1. An explicitly supplied install section wins outright.
    if install_key is not None:
        wanted = ("install" + str(install_key)).lower()
        for section in parser.sections():
            if section.lower() != wanted:
                continue
            raw = parser.get(section, "default", fallback=None)
            if raw:
                return resolve_install_default(raw)
        return None

    # 2. The install section that opened a dev-edition profile.
    for section in parser.sections():
        if not section.lower().startswith("install"):
            continue
        raw = parser.get(section, "default", fallback=None)
        if not raw:
            continue
        name = next((n for n, p, _ in profiles
                     if p.replace("\\", "/").rstrip("/") == raw.replace("\\", "/").rstrip("/")),
                    "")
        if not _is_dev_profile(raw, name, marker):
            continue                       # release channel — never touched
        resolved = resolve_install_default(raw)
        if resolved:
            return resolved

    # 3./4. Fall back to the profile list: Name first, then directory suffix.
    for by_name in (True, False):
        for name, raw, is_relative in profiles:
            if by_name and name != marker:
                continue
            if not by_name and not _is_dev_profile(raw, name, marker):
                continue
            return _resolve_profile_path(raw, firefox_dir, is_relative)
    return None


# ---------------------------------------------------------------------------
# 3. Deterministic XPI
# ---------------------------------------------------------------------------

XPI_TIMESTAMP = (1980, 1, 1, 0, 0, 0)   # the zip epoch: earliest representable
_ZIP_MODE = 0o644 << 16                 # fixed permissions; no umask leakage


def build_xpi_bytes(source_dir, ship_set=None, excludes=None,
                    timestamp=XPI_TIMESTAMP, require_root_manifest=True):
    """Build an XPI in memory. Identical sources give identical bytes.

    Every field that would otherwise vary is pinned: entry order (sorted),
    date_time, create_system (0 on Windows but 3 on Unix by default), external
    attributes, and the version fields. No directory entries are emitted, so
    the archive does not depend on how the tree was walked.

    `manifest.json` must sit at the root of `source_dir` — the guard catches
    pointing the builder at the repo root instead of `media-catcher/`.

    The deflate stream itself is produced by the running zlib; byte-identity is
    guaranteed for a given interpreter, which is all the receipt (machine-local,
    under %LOCALAPPDATA%) ever compares.
    """
    relpaths = expand_ship_set(
        source_dir, _DEFAULT_EXTENSION_PATTERNS if ship_set is None else ship_set, excludes)
    if require_root_manifest and "manifest.json" not in relpaths:
        raise ValueError(
            "manifest.json must sit at the root of %r; got %d entries"
            % (source_dir, len(relpaths)))

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for relpath in relpaths:
            info = zipfile.ZipInfo(relpath, date_time=timestamp)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 0
            info.create_version = 20
            info.extract_version = 20
            info.external_attr = _ZIP_MODE
            info.internal_attr = 0
            info.flag_bits = 0
            with open(os.path.join(source_dir, *relpath.split("/")), "rb") as handle:
                archive.writestr(info, handle.read())
    return buffer.getvalue()


# Signing adds these; they are produced by AMO, not by any ship set.
SIGNATURE_PREFIX = "META-INF/"


def hash_zip_members(archive_path):
    """{member path: sha256} for an installed archive.

    Compares CONTENT rather than container bytes. Two archives holding
    identical files still differ byte-for-byte when built by different
    packagers — compression level, entry order and timestamps all vary — and
    the installed XPI is not always this builder's output: the host rewrites it
    during in-app self-update, and AMO rewrites it during signing. Byte
    equality would report those as permanently stale.
    """
    members = {}
    with zipfile.ZipFile(archive_path) as archive:
        for name in archive.namelist():
            if name.endswith("/"):
                continue
            members[name] = sha256_bytes(archive.read(name))
    return members


def compare_extension_install(archive_path, mapping):
    """Verdict for an installed XPI against the extension ship set.

    Returns {"verdict", "differing", "missing", "unexpected"}. Signature
    members are ignored: a signed archive legitimately carries META-INF/.
    """
    try:
        installed = hash_zip_members(archive_path)
    except FileNotFoundError:
        return {"verdict": "missing", "differing": [], "missing": sorted(mapping),
                "unexpected": []}
    except zipfile.BadZipFile:
        return {"verdict": "unreadable", "differing": [], "missing": [],
                "unexpected": []}

    expected = {rel: hash_file(src) for rel, src in mapping.items()}
    differing = sorted(r for r in expected
                       if r in installed and installed[r] != expected[r])
    missing = sorted(r for r in expected if r not in installed)
    unexpected = sorted(r for r in installed
                        if r not in expected and not r.startswith(SIGNATURE_PREFIX))
    verdict = "in-sync" if not (differing or missing or unexpected) else "stale"
    return {"verdict": verdict, "differing": differing, "missing": missing,
            "unexpected": unexpected}


def build_zip_from_mapping(mapping, timestamp=XPI_TIMESTAMP,
                           require_root_manifest=True):
    """Build an archive from {archive relative path: source path}.

    Same pinned fields as build_xpi_bytes, but sourced from an explicit ship
    set rather than a pattern walk, so the packaged artifact and the verified
    artifact are built from the identical mapping.
    """
    if require_root_manifest and "manifest.json" not in mapping:
        raise ValueError("manifest.json must sit at the archive root; got %d entries"
                         % len(mapping))
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for relpath in sorted(mapping):
            info = zipfile.ZipInfo(relpath, date_time=timestamp)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 0
            info.create_version = 20
            info.extract_version = 20
            info.external_attr = _ZIP_MODE
            info.internal_attr = 0
            info.flag_bits = 0
            with open(mapping[relpath], "rb") as handle:
                archive.writestr(info, handle.read())
    return buffer.getvalue()


def build_extension_package(repo_root="."):
    """The extension artifact: shipped files only, tests and editor config out."""
    return build_zip_from_mapping(_ship_set().extension_ship_set(repo_root))


def write_xpi(source_dir, out_path, ship_set=None, excludes=None,
              timestamp=XPI_TIMESTAMP):
    """Build the XPI and write it. Returns {"path", "sha256", "entries"}."""
    data = build_xpi_bytes(source_dir, ship_set, excludes, timestamp)
    parent = os.path.dirname(out_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(out_path, "wb") as handle:
        handle.write(data)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.namelist()
    return {"path": out_path, "sha256": sha256_bytes(data), "entries": entries}


# ---------------------------------------------------------------------------
# 4. Receipt: load / save / diff
# ---------------------------------------------------------------------------

SCHEMA_VERSION = 1

IN_SYNC = "in-sync"
STALE = "stale"
MISSING = "missing"
TARGET_MOVED = "target-moved"

COMPONENTS = ("extension", "host")
EXTENSION_TARGET_KEYS = ("extensionId", "devProfile", "xpiPath")
HOST_TARGET_KEYS = ("hostDir",)
_PATH_TARGET_KEYS = frozenset({"devProfile", "xpiPath", "hostDir"})


class Verdict:
    """One component's state. Never combined with the other component's."""

    __slots__ = ("status", "reason", "changed")

    def __init__(self, status, reason="", changed=()):
        self.status = status
        self.reason = reason
        self.changed = list(changed)

    def __eq__(self, other):
        return (isinstance(other, Verdict) and self.status == other.status
                and self.reason == other.reason and self.changed == other.changed)

    def __hash__(self):
        return hash((self.status, self.reason, tuple(self.changed)))

    def __repr__(self):
        return "Verdict(%r, %r, %r)" % (self.status, self.reason, self.changed)

    def as_dict(self):
        return {"status": self.status, "reason": self.reason, "changed": list(self.changed)}


def make_receipt(targets, extension, host, commit, dirty, installed_at):
    """Build a receipt. `version` is carried for display only, never compared."""
    return {
        "schema": SCHEMA_VERSION,
        "installedAt": installed_at,
        "commit": commit,
        "dirty": bool(dirty),
        "targets": dict(targets),
        "extension": dict(extension),
        "host": dict(host),
    }


def load_receipt(path):
    """Read the receipt, or None when it is absent, unreadable, or not an object.

    A corrupt receipt reads as "no receipt", which makes both components
    `missing` — the conservative direction, since the alternative is trusting a
    half-written record of what is installed.
    """
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def save_receipt(path, receipt):
    """Write the receipt atomically, so a crash cannot leave a partial record."""
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    temp = path + ".tmp"
    with open(temp, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(receipt, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(temp, path)


def _same_target(key, current, pinned):
    if current is None or pinned is None:
        return current == pinned
    if key in _PATH_TARGET_KEYS:
        return (os.path.normcase(os.path.normpath(current))
                == os.path.normcase(os.path.normpath(pinned)))
    return current == pinned


def _moved_targets(keys, current_targets, pinned_targets):
    return [key for key in keys
            if not _same_target(key, current_targets.get(key), pinned_targets.get(key))]


def _diff_files(source_files, installed_files):
    """Relative paths whose digests differ, including ones absent from a side."""
    keys = set(source_files) | set(installed_files)
    return sorted(k for k in keys if source_files.get(k) != installed_files.get(k))


def _verdict(component, current, receipt):
    """One component's verdict, computed from that component's inputs ONLY.

    Independence is load-bearing: a combined verdict would let a current
    extension mask a stale host, which is exactly the 2026-08-14 failure.

    Precedence: target-moved, then missing, then stale. A moved target outranks
    everything because installing into it would be an install into the wrong
    place; "missing" outranks "stale" because there is nothing to compare.
    """
    if receipt is None:
        return Verdict(MISSING, "no receipt")
    if receipt.get("schema") != SCHEMA_VERSION:
        return Verdict(MISSING, "unsupported receipt schema %r" % (receipt.get("schema"),))

    keys = EXTENSION_TARGET_KEYS if component == "extension" else HOST_TARGET_KEYS
    moved = _moved_targets(keys, current.get("targets") or {}, receipt.get("targets") or {})
    if moved:
        return Verdict(TARGET_MOVED, "target moved: %s" % ", ".join(moved))

    now = current.get(component) or {}
    then = receipt.get(component) or {}

    if component == "extension":
        installed = now.get("installedXpiSha256")
        if not installed:
            return Verdict(MISSING, "no installed xpi")
        if now.get("shipSetSha256") != then.get("shipSetSha256"):
            return Verdict(STALE, "extension sources changed since the last install")
        if installed != then.get("xpiSha256"):
            return Verdict(STALE, "the installed xpi no longer matches the receipt")
        return Verdict(IN_SYNC, "")

    installed_files = now.get("installedFiles")
    if installed_files is None:
        return Verdict(MISSING, "host is not installed")
    source_files = now.get("files") or {}
    if now.get("shipSetSha256") != then.get("shipSetSha256"):
        return Verdict(STALE, "host sources changed since the last install",
                       _diff_files(source_files, then.get("files") or {}))
    changed = _diff_files(source_files, installed_files)
    if changed:
        return Verdict(STALE, "installed host files no longer match source", changed)
    return Verdict(IN_SYNC, "")


def diff(current, receipt):
    """Per-component verdicts: {"extension": Verdict, "host": Verdict}.

    `current` is the freshly resolved state:

        {"targets":   {extensionId, devProfile, xpiPath, hostDir},
         "extension": {"shipSetSha256": ..., "installedXpiSha256": ... | None},
         "host":      {"shipSetSha256": ..., "files": {rel: sha},
                       "installedFiles": {rel: sha} | None}}

    A None `installedXpiSha256` / `installedFiles` means "nothing is installed".
    Never returns a single combined verdict — see _verdict().
    """
    return {name: _verdict(name, current, receipt) for name in COMPONENTS}


def needs_install(verdicts):
    """Components that are not in-sync, in stable COMPONENTS order."""
    return [name for name in COMPONENTS
            if verdicts[name].status != IN_SYNC]


def all_in_sync(verdicts):
    return not needs_install(verdicts)


# ---------------------------------------------------------------------------
# 5. ISCC discovery
#
# Pure path search. The environment and the existence probe are parameters, so
# this is exercised on a machine with no Inno Setup installed.
# ---------------------------------------------------------------------------

ISCC_NAME = "ISCC.exe"
INNO_DIR_NAME = "Inno Setup 6"

# (environment variable, *subdirectories) for the three standard install roots.
INNO_STANDARD_DIRS = (
    ("ProgramFiles(x86)", INNO_DIR_NAME),
    ("ProgramFiles", INNO_DIR_NAME),
    ("LOCALAPPDATA", "Programs", INNO_DIR_NAME),
)


def iscc_candidates(env):
    """Standard-directory ISCC.exe candidates derived from `env`, in order.

    Variables that are unset yield no candidate, so an empty environment gives
    an empty list rather than paths rooted at the current directory.
    """
    candidates = []
    for variable, *parts in INNO_STANDARD_DIRS:
        root = (env.get(variable) or "").strip()
        if not root:
            continue
        candidates.append(os.path.join(root, *parts, ISCC_NAME))
    return candidates


def find_iscc(env=None, exists=None):
    """Locate ISCC.exe on PATH, then in the standard Inno Setup 6 directories.

    Returns None when it is absent — the caller reports that and stops. It must
    never fall back to copying files out of the working tree, because that is
    precisely what would mask an incomplete .iss file manifest.
    """
    env = os.environ if env is None else env
    exists = os.path.isfile if exists is None else exists
    seen = set()
    ordered = []
    for directory in (env.get("PATH") or "").split(os.pathsep):
        directory = directory.strip().strip('"')
        if directory:
            ordered.append(os.path.join(directory, ISCC_NAME))
    ordered.extend(iscc_candidates(env))
    for candidate in ordered:
        key = os.path.normcase(os.path.normpath(candidate))
        if key in seen:
            continue
        seen.add(key)
        if exists(candidate):
            return candidate
    return None


# ---------------------------------------------------------------------------
# Seams for the deferred orchestration half (design review in flight):
#
#   * Firefox Developer Edition process enumeration and shutdown — a ctypes
#     adapter (CreateToolhelp32Snapshot + QueryFullProcessImageName) filtered on
#     the Dev Edition executable PATH, never the image name `firefox.exe`.
#   * Host install-directory resolution — winreg over
#     HKCU\Software\Mozilla\NativeMessagingHosts\com.mediacatcher.host.
#   * Running ISCC.exe (see find_iscc) and MediaCatcherHostSetup.exe.
#   * Installing the built artifacts, with the previous xpi backed up first.
#   * The CLI: --check / --install / --launch / --json / --adopt and exit codes.
#
# Each attaches to the pure functions above and takes its own injectable
# adapter, defaulting to the real thing, as `_ask_folder(default_dir, api=None)`
# does in media-catcher-host/mchost/downloads.py.
# ---------------------------------------------------------------------------
