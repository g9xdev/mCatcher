"""Parser/semantic tests for native host package runtime layout preservation.

Never executes the release workflow, bootstrap.ps1, installer, or registry ops.
The bootstrap semantic check extracts one pure copy helper via the PowerShell AST
and runs only that extracted definition under a temporary harness.
"""
from __future__ import annotations

import ast
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import textwrap
import zipfile
from pathlib import Path

import pytest

from conftest import HERE, load_host

REPO_ROOT = Path(HERE).resolve().parent
RELEASE_YML = REPO_ROOT / ".github" / "workflows" / "release.yml"
BOOTSTRAP = Path(HERE) / "installer" / "bootstrap.ps1"
INNO_ISS = Path(HERE) / "installer" / "media-catcher-host.iss"
GUARDIAN = Path(HERE) / "guardian.ps1"
PS = "powershell"


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest().upper()


def _run_ps(script: str, *, cwd: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        [PS, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
        capture_output=True,
        text=True,
        cwd=cwd,
    )


def _ps_parse_ok(source: str) -> tuple[bool, str]:
    """Parse PowerShell source; return (ok, error_text)."""
    # Embed source as a here-string via base64 to avoid quoting hazards.
    import base64

    b64 = base64.b64encode(source.encode("utf-8")).decode("ascii")
    script = f"""
$bytes = [Convert]::FromBase64String('{b64}')
$text = [Text.Encoding]::UTF8.GetString($bytes)
$tokens = $null; $errors = $null
[void][System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors)
if ($errors -and $errors.Count -gt 0) {{
  $errors | ForEach-Object {{ $_.ToString() }} | Out-String | Write-Output
  exit 1
}}
exit 0
"""
    r = _run_ps(script)
    return r.returncode == 0, (r.stdout or "") + (r.stderr or "")


def _ps_tokens_and_ast(source: str) -> dict:
    """Return token kinds/text and function extents from PowerShell parser."""
    import base64

    b64 = base64.b64encode(source.encode("utf-8")).decode("ascii")
    script = r"""
$bytes = [Convert]::FromBase64String('""" + b64 + r"""')
$text = [Text.Encoding]::UTF8.GetString($bytes)
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors)
if ($errors -and $errors.Count -gt 0) {
  Write-Output ('PARSE_ERROR:' + (($errors | ForEach-Object { $_.ToString() }) -join ' | '))
  exit 1
}
$toks = @()
foreach ($t in $tokens) {
  if ($t.Kind.ToString() -eq 'Comment') { continue }
  $toks += [pscustomobject]@{ Kind = $t.Kind.ToString(); Text = $t.Text }
}
$funcs = @()
$asts = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)
foreach ($f in $asts) {
  $funcs += [pscustomobject]@{
    Name = $f.Name
    Start = $f.Extent.StartOffset
    End = $f.Extent.EndOffset
    Text = $f.Extent.Text
  }
}
$cmds = @()
$casts = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true)
foreach ($c in $casts) {
  $name = $c.GetCommandName()
  $elems = @($c.CommandElements | ForEach-Object { $_.Extent.Text })
  $cmds += [pscustomobject]@{
    Name = $name
    Text = $c.Extent.Text
    Elements = $elems
    Start = $c.Extent.StartOffset
  }
}
[pscustomobject]@{
  Tokens = $toks
  Functions = $funcs
  Commands = $cmds
} | ConvertTo-Json -Depth 8 -Compress
"""
    r = _run_ps(script)
    assert r.returncode == 0, f"PowerShell parse failed: {r.stdout}\n{r.stderr}"
    raw = (r.stdout or "").strip()
    assert raw and not raw.startswith("PARSE_ERROR:"), raw
    return json.loads(raw)


def _active_text_from_tokens(tokens: list) -> str:
    if isinstance(tokens, dict):
        tokens = [tokens]
    return " ".join(t.get("Text", "") for t in tokens if t.get("Kind") != "Comment")


def _extract_release_package_run_block() -> str:
    text = RELEASE_YML.read_text(encoding="utf-8")
    # Isolate the "Package extension + host zips" step run: | block.
    m = re.search(
        r"(?ms)^      - name: Package extension \+ host zips\n"
        r".*?^        run: \|\n"
        r"(.*?)(?=^      - name:|\Z)",
        text,
    )
    assert m, "release.yml Package extension + host zips run block not found"
    lines = []
    for line in m.group(1).splitlines():
        if line.startswith("          "):
            lines.append(line[10:])
        elif line.strip() == "":
            lines.append("")
        else:
            lines.append(line)
    return "\n".join(lines)


def _strip_iss_comments(text: str) -> str:
    out = []
    for line in text.splitlines():
        if line.lstrip().startswith(";"):
            continue
        out.append(line)
    return "\n".join(out)


def _make_release_shaped_zip(path: Path, host_body: str = 'VERSION = "9.9.9"\n') -> None:
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("mc_host.py", host_body)
        z.writestr("mchost/__init__.py", "# pkg\n")
        z.writestr("mchost/cast/backend.py", "# backend\n")


def test_release_host_zip_stages_mchost_recursively_without_caches():
    """Active release packaging stages host-staging then recursive mchost once."""
    block = _extract_release_package_run_block()
    ok, err = _ps_parse_ok(block)
    assert ok, f"release package PowerShell must parse: {err}"
    info = _ps_tokens_and_ast(block)
    active = _active_text_from_tokens(info["Tokens"])
    active_norm = active.replace("/", "\\").lower()

    # No nested mchost/mchost destination in active (non-comment) tokens.
    assert "mchost\\mchost" not in active_norm, "active release staging must not use mchost/mchost"
    assert "mchost/mchost" not in active.replace("\\", "/").lower()

    commands = info["Commands"]
    if isinstance(commands, dict):
        commands = [commands]

    # Causal order: every active copy *into* host-staging must be preceded by
    # an active New-Item that creates host-staging.
    create_offsets = []
    copy_to_staging_offsets = []
    for c in commands:
        name = (c.get("Name") or "").lower()
        text = c.get("Text") or ""
        text_l = text.lower()
        start = int(c.get("Start") or 0)
        elems = c.get("Elements") or []
        joined = " ".join(elems).lower()
        if name == "new-item" and "host-staging" in text_l:
            create_offsets.append(start)
        # Copy-Item / other copies whose destination involves host-staging
        if name in ("copy-item", "copy") and "host-staging" in text_l:
            copy_to_staging_offsets.append(start)
        # Also catch destination-only mentions via Join-Path host-staging ...
        if name in ("copy-item", "copy") and "host-staging" in joined:
            if start not in copy_to_staging_offsets:
                copy_to_staging_offsets.append(start)

    assert create_offsets, "release must actively create host-staging (New-Item)"
    assert copy_to_staging_offsets, "release must actively copy into host-staging"
    first_create = min(create_offsets)
    for off in copy_to_staging_offsets:
        assert first_create < off, (
            "active host-staging creation must precede every active copy into it"
        )

    # Recursive source package mapping: media-catcher-host/mchost -> host-staging/mchost
    assert re.search(r"media-catcher-host[\\/]+mchost", active, re.I), (
        "release must reference source media-catcher-host/mchost"
    )
    assert re.search(r"host-staging[\\/]+mchost", active, re.I), (
        "release must stage destination host-staging/mchost"
    )
    # Cache / bytecode exclusions present in active text
    assert "__pycache__" in active, "release staging must exclude __pycache__"
    assert ".pyc" in active, "release staging must exclude .pyc files"


def test_bootstrap_preserves_recursive_mchost_layout(tmp_path):
    """Extract pure mchost copy helper and assert nested layout without caches."""
    src_text = BOOTSTRAP.read_text(encoding="utf-8")
    ok, err = _ps_parse_ok(src_text)
    assert ok, f"bootstrap.ps1 must parse: {err}"
    info = _ps_tokens_and_ast(src_text)
    funcs = info["Functions"]
    if isinstance(funcs, dict):
        funcs = [funcs]

    # Pure function: definition mentions mchost + Source/Install dirs, and must
    # not contain registry/network/process/config/global-install behavior.
    forbidden = (
        "regroot", "hkcu", "hklm", "registry", "set-itemproperty", "new-itemproperty",
        "invoke-webrequest", "winget", "start-process", "invoke-expression",
        "native messaging", "mc_config", "ffmpeg", "yt-dlp", "deno",
    )
    pure = None
    for f in funcs:
        body = f.get("Text") or ""
        body_l = body.lower()
        if "mchost" not in body_l:
            continue
        if not re.search(r"sourcedir|installdir|\$source|\$dest|\$install", body_l):
            continue
        if any(tok in body_l for tok in forbidden):
            continue
        # Must actually copy / create destinations
        if "copy-item" not in body_l and "copy-mchost" not in body_l:
            if "copy" not in body_l:
                continue
        pure = f
        break
    assert pure is not None, (
        "bootstrap.ps1 must define one pure mchost recursive-copy function "
        "with no registry/network/process/config behavior"
    )

    # Active non-comment tokens must not stage mchost/mchost
    active = _active_text_from_tokens(info["Tokens"])
    active_norm = active.replace("/", "\\").lower()
    assert "mchost\\mchost" not in active_norm

    # Write exact function extent + tiny harness into tmp only
    harness_dir = tmp_path / "bootstrap_helper"
    harness_dir.mkdir()
    source_dir = tmp_path / "src"
    install_dir = tmp_path / "dst"
    # Nested runtime package + caches that must not be copied
    nested = source_dir / "mchost" / "cast"
    nested.mkdir(parents=True)
    (source_dir / "mchost" / "__init__.py").write_text("# init\n", encoding="utf-8")
    (nested / "backend.py").write_text("# backend\n", encoding="utf-8")
    (nested / "extra.py").write_text("# extra\n", encoding="utf-8")
    cache1 = source_dir / "mchost" / "__pycache__"
    cache1.mkdir()
    (cache1 / "ignored.pyc").write_bytes(b"\0\0")
    nest_cache = nested / "__pycache__"
    nest_cache.mkdir()
    (nest_cache / "backend.cpython-314.pyc").write_bytes(b"\0\1")
    (nested / "stale.pyc").write_bytes(b"\0\2")

    helper_ps1 = harness_dir / "copy_helper.ps1"
    # Invoke by discovered function name with -SourceDir/-InstallDir if present,
    # else positional. Prefer named parameters matching common pattern.
    fname = pure["Name"]
    helper_ps1.write_text(
        pure["Text"]
        + "\n\n"
        + f"& '{fname}' -SourceDir $env:MC_SRC -InstallDir $env:MC_DST\n",
        encoding="utf-8",
    )
    env = os.environ.copy()
    env["MC_SRC"] = str(source_dir)
    env["MC_DST"] = str(install_dir)
    r = subprocess.run(
        [PS, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(helper_ps1)],
        capture_output=True,
        text=True,
        env=env,
    )
    # Retry with positional parameters if named bind failed
    if r.returncode != 0:
        helper_ps1.write_text(
            pure["Text"]
            + "\n\n"
            + f"& '{fname}' $env:MC_SRC $env:MC_DST\n",
            encoding="utf-8",
        )
        r = subprocess.run(
            [PS, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(helper_ps1)],
            capture_output=True,
            text=True,
            env=env,
        )
    assert r.returncode == 0, f"extracted helper failed: {r.stdout}\n{r.stderr}"

    dst_pkg = install_dir / "mchost"
    assert (dst_pkg / "__init__.py").is_file(), "nested mchost/__init__.py must be installed"
    assert (dst_pkg / "cast" / "backend.py").is_file(), "nested mchost/cast/backend.py must be installed"
    assert (dst_pkg / "cast" / "extra.py").is_file(), "nested relative paths preserved"
    # Flattened names must not appear at install root
    assert not (install_dir / "__init__.py").exists()
    assert not (install_dir / "backend.py").exists()
    # Cache/bytecode absence ONLY under temporary InstallDir/mchost
    under = list(dst_pkg.rglob("*"))
    assert not any(p.name == "__pycache__" and p.is_dir() for p in under), (
        "no __pycache__ under temporary InstallDir/mchost"
    )
    assert not any(p.suffix == ".pyc" for p in under if p.is_file()), (
        "no .pyc under temporary InstallDir/mchost"
    )


def test_inno_installer_embeds_recursive_mchost_layout():
    """Inno [Files] embeds mchost recursively under {app}\\mchost, not nested twice."""
    raw = INNO_ISS.read_text(encoding="utf-8")
    active = _strip_iss_comments(raw)
    # Isolate [Files] section
    m = re.search(r"(?is)\[Files\](.*?)(\n\[|\Z)", active)
    assert m, "[Files] section required"
    files = m.group(1)
    files_l = files.lower()
    assert "mchost" in files_l, "Inno must embed the mchost package"
    # Must use recursive flags (or proven equivalents)
    assert "recursesubdirs" in files_l, "Inno mchost entry needs recursesubdirs"
    assert "createallsubdirs" in files_l, "Inno mchost entry needs createallsubdirs"
    # Destination is {app}\mchost (or {app}/mchost), not {app}\mchost\mchost
    assert re.search(r'destdir:\s*"\{app\}[\\/]+mchost"', files, re.I), (
        r'Inno must DestDir to {app}\mchost'
    )
    assert not re.search(r'destdir:\s*"\{app\}[\\/]+mchost[\\/]+mchost"', files, re.I), (
        r"Inno must not DestDir to {app}\mchost\mchost"
    )
    # Source should reference HostSrc mchost package
    assert re.search(r'source:\s*"\{#hostsrc\}mchost[\\/]*\*"', files, re.I) or re.search(
        r'source:\s*"\{#hostsrc\}mchost[\\/]+"', files, re.I
    ) or re.search(r"mchost\\\*", files, re.I) or re.search(r"mchost/\*", files, re.I), (
        "Inno Source must recurse the HostSrc mchost package"
    )
    # Exclude caches
    assert "__pycache__" in files or "excludes:" in files_l, "Inno must exclude __pycache__"
    assert ".pyc" in files or "excludes:" in files_l, "Inno must exclude .pyc"


def test_apply_update_preserves_nested_host_package(tmp_path, monkeypatch):
    """In-process apply_update keeps archive-relative mchost tree, no flattening."""
    mc = load_host()
    monkeypatch.setattr(mc, "find_profile", lambda: None)
    monkeypatch.setattr(mc, "load_config", lambda: {})
    monkeypatch.setattr(mc, "_await_zip", lambda path, tries=10, delay=0.5: True)

    host_dir = tmp_path / "host"
    host_dir.mkdir()
    (host_dir / "mc_host.py").write_text('VERSION = "1.0.0"\n', encoding="utf-8")
    (host_dir / "mchost").mkdir()
    (host_dir / "mchost" / "__init__.py").write_text("# old\n", encoding="utf-8")
    (host_dir / "mchost" / "cast").mkdir()
    (host_dir / "mchost" / "cast" / "backend.py").write_text("# old backend\n", encoding="utf-8")

    zpath = tmp_path / "media-catcher-host-9.9.9.zip"
    _make_release_shaped_zip(zpath, 'VERSION = "9.9.9"\nprint("nested")\n')

    plan = {
        "ext_newer": False,
        "host_newer": True,
        "ext_zip": None,
        "host_zip": str(zpath),
        "ext_to": None,
        "host_to": "9.9.9",
    }
    mc.apply_update(plan, str(tmp_path / "ext"), str(host_dir))

    assert (host_dir / "mc_host.py").is_file()
    assert 'VERSION = "9.9.9"' in (host_dir / "mc_host.py").read_text(encoding="utf-8")
    assert (host_dir / "mchost" / "__init__.py").is_file(), "nested mchost/__init__.py required"
    assert (host_dir / "mchost" / "cast" / "backend.py").is_file(), (
        "nested mchost/cast/backend.py required"
    )
    assert not (host_dir / "__init__.py").exists(), "must not flatten __init__.py to host root"
    assert not (host_dir / "backend.py").exists(), "must not flatten backend.py to host root"


def test_apply_update_rejects_archive_escape(tmp_path, monkeypatch):
    """apply_update validates every member before any write; escapes leave dst untouched."""
    mc = load_host()
    monkeypatch.setattr(mc, "find_profile", lambda: None)
    monkeypatch.setattr(mc, "load_config", lambda: {})
    monkeypatch.setattr(mc, "_await_zip", lambda path, tries=10, delay=0.5: True)

    host_dir = tmp_path / "host"
    host_dir.mkdir()
    sentinel_inside = host_dir / "mc_host.py"
    sentinel_inside.write_text('VERSION = "1.0.0"\nKEEP\n', encoding="utf-8")
    (host_dir / "mchost").mkdir()
    (host_dir / "mchost" / "__init__.py").write_text("KEEP_INIT\n", encoding="utf-8")

    outside = tmp_path / "outside_sentinel.txt"
    outside.write_text("OUTSIDE_UNCHANGED\n", encoding="utf-8")
    outside_dir = tmp_path / "outside_dir"
    outside_dir.mkdir()
    outside_nested = outside_dir / "payload.txt"
    outside_nested.write_text("NESTED_OUTSIDE\n", encoding="utf-8")

    escape_names = [
        "/absolute",
        "C:/windows/temp/x.py",
        "//server/share/x.py",
        "../escape.py",
        "x/../../escape.py",
        "..\\escape.py",
        "mchost\\..\\..\\escape.py",
        "mchost/../outside.py",
        "mchost//escape.py",
    ]

    for i, bad in enumerate(escape_names):
        zpath = tmp_path / f"bad-{i}.zip"
        # Build zip with a safe-looking member plus one escape member.
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("mc_host.py", 'VERSION = "2.0.0"\nEVIL\n')
            z.writestr("mchost/__init__.py", "EVIL_INIT\n")
            z.writestr(bad, "ESCAPED\n")
        zpath.write_bytes(buf.getvalue())

        before_inside = sentinel_inside.read_text(encoding="utf-8")
        before_init = (host_dir / "mchost" / "__init__.py").read_text(encoding="utf-8")
        before_out = outside.read_text(encoding="utf-8")
        before_nested = outside_nested.read_text(encoding="utf-8")
        listing_before = set(p.relative_to(tmp_path).as_posix() for p in tmp_path.rglob("*"))

        plan = {
            "ext_newer": False,
            "host_newer": True,
            "ext_zip": None,
            "host_zip": str(zpath),
            "ext_to": "2.0.0",
            "host_to": "2.0.0",
        }
        with pytest.raises(Exception):
            mc.apply_update(plan, str(tmp_path / "ext"), str(host_dir))

        assert sentinel_inside.read_text(encoding="utf-8") == before_inside
        assert (host_dir / "mchost" / "__init__.py").read_text(encoding="utf-8") == before_init
        assert outside.read_text(encoding="utf-8") == before_out
        assert outside_nested.read_text(encoding="utf-8") == before_nested
        listing_after = set(p.relative_to(tmp_path).as_posix() for p in tmp_path.rglob("*"))
        # Destination and outside paths unchanged (zip file itself may exist)
        assert before_inside == 'VERSION = "1.0.0"\nKEEP\n'
        assert "ESCAPED" not in outside.read_text(encoding="utf-8")
        assert not (tmp_path / "escape.py").exists()
        assert not (outside_dir / "escape.py").exists()
        # No new payload outside host_dir except the zip we wrote
        new_paths = listing_after - listing_before
        for p in new_paths:
            assert p.startswith(f"bad-{i}.zip") or p.startswith("host/"), (
                f"escape must not create outside paths: {p}"
            )


def test_guardian_preserves_nested_host_package_without_restart(tmp_path):
    """Guardian host apply preserves archive-relative trees; verify requires mchost."""
    work = tmp_path / "gwork"
    work.mkdir()
    host_dir = work / "host"
    host_dir.mkdir()
    (host_dir / "mc_host.py").write_text('VERSION = "1.0.0"\n', encoding="utf-8")
    (host_dir / "mchost").mkdir()
    (host_dir / "mchost" / "__init__.py").write_text("# old\n", encoding="utf-8")
    (host_dir / "mchost" / "cast").mkdir()
    (host_dir / "mchost" / "cast" / "backend.py").write_text("# old\n", encoding="utf-8")

    zdir = work / "zips"
    zdir.mkdir()
    zpath = zdir / "media-catcher-host-1.1.0.zip"
    _make_release_shaped_zip(zpath, 'VERSION = "1.1.0"\nx = 1\n')

    # Prefer pythonw like production host; guardian normalizes for compile.
    py = sys.executable
    cand = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
    if os.path.exists(cand):
        py = cand

    cfg = {
        "applyExt": False,
        "applyHost": True,
        "extZip": None,
        "hostZip": str(zpath),
        "extDir": str(work / "ext"),
        "hostDir": str(host_dir),
        "profileDir": "",
        "extId": "{id}",
        "expectExtVersion": None,
        "expectHostVersion": "1.1.0",
        "python": py,
        "firefox": "",
        "restart": False,
        "backupRoot": str(work / "backups"),
        "keep": 3,
    }
    confpath = work / "config.json"
    confpath.write_text(json.dumps(cfg), encoding="utf-8")
    r = subprocess.run(
        [
            PS,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(GUARDIAN),
            "-Config",
            str(confpath),
            "-NoUi",
            "-NoRestart",
        ],
        capture_output=True,
        text=True,
    )
    assert r.returncode == 0, f"guardian failed: {r.stdout}\n{r.stderr}"
    assert 'VERSION = "1.1.0"' in (host_dir / "mc_host.py").read_text(encoding="utf-8")
    assert (host_dir / "mchost" / "__init__.py").is_file()
    assert (host_dir / "mchost" / "cast" / "backend.py").is_file()
    assert not (host_dir / "__init__.py").exists()
    assert not (host_dir / "backend.py").exists()
    # fail-closed verification: missing mchost/__init__.py must not pass
    # (covered by production check; nested files present proves non-flatten apply)


# ---------------------------------------------------------------------------
# Destination-alias / reparse / hard-link hardening (appended tests only)
# ---------------------------------------------------------------------------

_ATTACK_BODY = b"ALIAS_ATTACK_PAYLOAD\n"
_SAFE_OUTSIDE = b"OUTSIDE_SAFE_UNCHANGED\n"
_SAFE_HOST = 'VERSION = "1.0.0"\nKEEP\n'
_SAFE_INIT = "KEEP_INIT\n"


def _snap_tree(root: Path) -> dict:
    """Capture path -> (is_dir, bytes|None, mtime_ns, ino, nlink) under root."""
    out = {}
    if not root.exists():
        return out
    for p in sorted(root.rglob("*"), key=lambda x: str(x).lower()):
        rel = p.relative_to(root).as_posix()
        try:
            st = p.lstat()
        except OSError:
            out[rel] = ("missing", None, None, None, None)
            continue
        is_dir = p.is_dir() and not p.is_symlink()
        data = None
        if p.is_file() and not p.is_symlink():
            try:
                data = p.read_bytes()
            except OSError:
                data = None
        out[rel] = (
            "dir" if is_dir else "file",
            data,
            getattr(st, "st_mtime_ns", None),
            getattr(st, "st_ino", None),
            getattr(st, "st_nlink", None),
        )
    return out


def _file_meta(path: Path) -> tuple:
    if not path.exists():
        return (False, None, None, None, None)
    st = path.stat()
    try:
        data = path.read_bytes()
    except OSError:
        data = None
    return (
        True,
        data,
        getattr(st, "st_mtime_ns", None),
        getattr(st, "st_ino", None),
        getattr(st, "st_nlink", None),
    )


def _make_attack_zip(path: Path, attack_member: str, *, host_body: str = 'VERSION = "2.0.0"\nEVIL\n') -> None:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("mc_host.py", host_body)
        z.writestr("mchost/__init__.py", "EVIL_INIT\n")
        z.writestr("mchost/cast/backend.py", "# evil backend\n")
        z.writestr(attack_member, _ATTACK_BODY)
    path.write_bytes(buf.getvalue())


def _new_junction(link_path: Path, target_path: Path) -> None:
    link_path.parent.mkdir(parents=True, exist_ok=True)
    if link_path.exists():
        raise RuntimeError(f"junction path already exists: {link_path}")
    r = subprocess.run(
        [
            PS,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            f"New-Item -ItemType Junction -Path '{link_path}' -Target '{target_path}' | Out-Null",
        ],
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        raise RuntimeError(f"junction create failed: {r.stdout}\n{r.stderr}")


def _try_symlink(link_path: Path, target_path: Path, *, directory: bool) -> str | None:
    """Return None on success, 'skip' on WinError 1314, else error string."""
    try:
        os.symlink(str(target_path), str(link_path), target_is_directory=directory)
        return None
    except OSError as e:
        if getattr(e, "winerror", None) == 1314:
            return "skip"
        return f"symlink failed: {e}"


def _seed_plain_host(host_dir: Path) -> None:
    host_dir.mkdir(parents=True, exist_ok=True)
    (host_dir / "mc_host.py").write_text(_SAFE_HOST, encoding="utf-8")
    (host_dir / "mchost").mkdir(exist_ok=True)
    (host_dir / "mchost" / "__init__.py").write_text(_SAFE_INIT, encoding="utf-8")


def _outside_has_attack(outside: Path) -> bool:
    if not outside.exists():
        return False
    if outside.is_file():
        try:
            return _ATTACK_BODY in outside.read_bytes()
        except OSError:
            return False
    for p in outside.rglob("*"):
        if p.is_file():
            try:
                if _ATTACK_BODY in p.read_bytes():
                    return True
            except OSError:
                continue
            if "ALIAS_ATTACK" in p.name:
                return True
    return False


def _run_guardian_host(host_dir: Path, zpath: Path, work: Path) -> subprocess.CompletedProcess:
    work.mkdir(parents=True, exist_ok=True)
    py = sys.executable
    cand = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
    if os.path.exists(cand):
        py = cand
    cfg = {
        "applyExt": False,
        "applyHost": True,
        "extZip": None,
        "hostZip": str(zpath),
        "extDir": str(work / "ext"),
        "hostDir": str(host_dir),
        "profileDir": "",
        "extId": "{id}",
        "expectExtVersion": None,
        "expectHostVersion": "2.0.0",
        "python": py,
        "firefox": "",
        "restart": False,
        "backupRoot": str(work / "backups"),
        "keep": 3,
    }
    confpath = work / "config.json"
    confpath.write_text(json.dumps(cfg), encoding="utf-8")
    return subprocess.run(
        [
            PS,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(GUARDIAN),
            "-Config",
            str(confpath),
            "-NoUi",
            "-NoRestart",
        ],
        capture_output=True,
        text=True,
    )


def _apply_update_or_exc(mc, host_dir: Path, zpath: Path, tmp_path: Path):
    plan = {
        "ext_newer": False,
        "host_newer": True,
        "ext_zip": None,
        "host_zip": str(zpath),
        "ext_to": None,
        "host_to": "2.0.0",
    }
    return mc.apply_update(plan, str(tmp_path / "ext"), str(host_dir))


def test_apply_update_rejects_reparse_and_hardlink_destinations(tmp_path, monkeypatch):
    """apply_update must reject reparse/hardlink/alias destinations without outside writes."""
    mc = load_host()
    monkeypatch.setattr(mc, "find_profile", lambda: None)
    monkeypatch.setattr(mc, "load_config", lambda: {})
    monkeypatch.setattr(mc, "_await_zip", lambda path, tries=10, delay=0.5: True)

    violations: list[str] = []
    base = tmp_path / "apply_alias"
    base.mkdir()

    def _expect_reject(label: str, host_dir: Path, outside: Path, zpath: Path, *, outside_is_file: bool = False):
        before_out = _file_meta(outside) if outside_is_file else None
        before_tree = None if outside_is_file else _snap_tree(outside)
        before_host = _snap_tree(host_dir) if host_dir.exists() and not host_dir.is_symlink() else None
        # For junction host_dir, snapshot the path listing via lexical walk when possible
        before_host_files = {}
        try:
            if host_dir.exists():
                for p in host_dir.rglob("*"):
                    if p.is_file():
                        try:
                            before_host_files[str(p)] = p.read_bytes()
                        except OSError:
                            pass
        except OSError:
            pass
        raised = False
        try:
            _apply_update_or_exc(mc, host_dir, zpath, base / f"ext_{label}")
        except Exception:
            raised = True
        if not raised:
            violations.append(f"{label}: apply_update did not raise")
        # Outside unchanged / no attack payload
        if outside_is_file:
            after_out = _file_meta(outside)
            if after_out[1] != before_out[1]:
                violations.append(f"{label}: outside file bytes changed")
            if after_out[1] is not None and _ATTACK_BODY in after_out[1]:
                violations.append(f"{label}: outside file contains attack payload")
            if after_out[3] != before_out[3] or after_out[4] != before_out[4]:
                violations.append(f"{label}: outside file id/nlink changed")
        else:
            if _outside_has_attack(outside):
                violations.append(f"{label}: outside tree contains attack payload")
            after_tree = _snap_tree(outside)
            if after_tree != before_tree:
                # Allow no structural change of outside content bytes
                for k, v in after_tree.items():
                    if k not in before_tree:
                        violations.append(f"{label}: new outside path {k}")
                    elif v[1] != before_tree[k][1]:
                        violations.append(f"{label}: outside bytes changed at {k}")
        # No attack payload under host path
        try:
            if host_dir.exists():
                for p in host_dir.rglob("*"):
                    if p.is_file():
                        try:
                            data = p.read_bytes()
                        except OSError:
                            continue
                        if _ATTACK_BODY in data and before_host_files.get(str(p)) != data:
                            violations.append(f"{label}: attack payload at host path {p}")
        except OSError:
            pass

    # --- hostDir itself is a directory junction to outside ---
    case = base / "junc_root"
    case.mkdir()
    outside = case / "outside_root"
    outside.mkdir()
    (outside / "marker.txt").write_bytes(_SAFE_OUTSIDE)
    (outside / "mc_host.py").write_text(_SAFE_HOST, encoding="utf-8")
    (outside / "mchost").mkdir()
    (outside / "mchost" / "__init__.py").write_text(_SAFE_INIT, encoding="utf-8")
    host_dir = case / "host"
    _new_junction(host_dir, outside)
    zpath = case / "atk.zip"
    _make_attack_zip(zpath, "alias_attack.txt")
    _expect_reject("hostdir_junction", host_dir, outside, zpath)

    # --- intermediate hostDir/linked junction to sibling outside ---
    case = base / "junc_mid"
    case.mkdir()
    host_dir = case / "host"
    _seed_plain_host(host_dir)
    outside = case / "outside_mid"
    outside.mkdir()
    (outside / "marker.txt").write_bytes(_SAFE_OUTSIDE)
    _new_junction(host_dir / "linked", outside)
    zpath = case / "atk.zip"
    _make_attack_zip(zpath, "linked/alias_attack.txt")
    _expect_reject("mid_junction", host_dir, outside, zpath)

    # --- final member destination is a hard link to sibling outside file ---
    case = base / "hardlink"
    case.mkdir()
    host_dir = case / "host"
    _seed_plain_host(host_dir)
    outside = case / "outside_file.txt"
    outside.write_bytes(_SAFE_OUTSIDE)
    dest = host_dir / "shared.txt"
    os.link(outside, dest)
    zpath = case / "atk.zip"
    _make_attack_zip(zpath, "shared.txt")
    _expect_reject("hardlink_final", host_dir, outside, zpath, outside_is_file=True)

    # --- directory symlink equivalent (skip only WinError 1314) ---
    case = base / "symlink_dir"
    case.mkdir()
    host_dir = case / "host"
    _seed_plain_host(host_dir)
    outside = case / "outside_sdir"
    outside.mkdir()
    (outside / "marker.txt").write_bytes(_SAFE_OUTSIDE)
    sk = _try_symlink(host_dir / "linked", outside, directory=True)
    if sk == "skip":
        pass
    elif sk is not None:
        violations.append(f"symlink_dir setup: {sk}")
    else:
        zpath = case / "atk.zip"
        _make_attack_zip(zpath, "linked/alias_attack.txt")
        _expect_reject("mid_dir_symlink", host_dir, outside, zpath)

    # --- file symlink equivalent (skip only WinError 1314) ---
    case = base / "symlink_file"
    case.mkdir()
    host_dir = case / "host"
    _seed_plain_host(host_dir)
    outside = case / "outside_sfile.txt"
    outside.write_bytes(_SAFE_OUTSIDE)
    sk = _try_symlink(host_dir / "shared.txt", outside, directory=False)
    if sk == "skip":
        pass
    elif sk is not None:
        violations.append(f"symlink_file setup: {sk}")
    else:
        zpath = case / "atk.zip"
        _make_attack_zip(zpath, "shared.txt")
        _expect_reject("final_file_symlink", host_dir, outside, zpath, outside_is_file=True)

    # --- member aliases / grammar (must reject; dest/outside unchanged) ---
    grammar_members = [
        "mchost/base.txt:evil",
        "mchost/foo:bar.txt",
        "mchost/CON",
        "mchost/NUL.txt",
        "mchost/COM1",
        "mchost/file.txt.",
        "mchost/file.txt ",
        "mchost/bad\x01name.txt",
        "mchost/bad\x7fname.txt",
        "mchost/bad\x9dname.txt",
    ]
    for i, mem in enumerate(grammar_members):
        case = base / f"grammar_{i}"
        case.mkdir()
        host_dir = case / "host"
        _seed_plain_host(host_dir)
        outside = case / "outside_unused"
        outside.mkdir()
        (outside / "marker.txt").write_bytes(_SAFE_OUTSIDE)
        before_host = (host_dir / "mc_host.py").read_text(encoding="utf-8")
        before_init = (host_dir / "mchost" / "__init__.py").read_text(encoding="utf-8")
        before_out = _snap_tree(outside)
        zpath = case / "atk.zip"
        _make_attack_zip(zpath, mem)
        raised = False
        try:
            _apply_update_or_exc(mc, host_dir, zpath, case / "ext")
        except Exception:
            raised = True
        if not raised:
            violations.append(f"grammar {mem!r}: apply_update did not raise")
        if (host_dir / "mc_host.py").read_text(encoding="utf-8") != before_host:
            violations.append(f"grammar {mem!r}: host mc_host.py changed")
        if (host_dir / "mchost" / "__init__.py").read_text(encoding="utf-8") != before_init:
            violations.append(f"grammar {mem!r}: mchost/__init__.py changed")
        if _snap_tree(outside) != before_out:
            violations.append(f"grammar {mem!r}: outside tree changed")
        if _outside_has_attack(host_dir) or _outside_has_attack(outside):
            violations.append(f"grammar {mem!r}: attack payload present")
        # ADS stream must not appear on base.txt for colon case
        ads = host_dir / "mchost" / "base.txt"
        if ads.exists():
            try:
                with open(str(ads) + ":evil", "rb") as f:
                    if _ATTACK_BODY in f.read():
                        violations.append(f"grammar {mem!r}: ADS stream written")
            except OSError:
                pass

    # --- case-insensitive / Win32-normalized duplicate destinations ---
    case = base / "dup_case"
    case.mkdir()
    host_dir = case / "host"
    _seed_plain_host(host_dir)
    outside = case / "outside_dup"
    outside.mkdir()
    (outside / "marker.txt").write_bytes(_SAFE_OUTSIDE)
    zpath = case / "atk.zip"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("mc_host.py", 'VERSION = "2.0.0"\nEVIL\n')
        z.writestr("mchost/__init__.py", "EVIL_INIT\n")
        z.writestr("mchost/cast/backend.py", "# evil\n")
        z.writestr("mchost/Same.txt", _ATTACK_BODY)
        z.writestr("mchost/same.txt", _ATTACK_BODY)
    zpath.write_bytes(buf.getvalue())
    before_host = (host_dir / "mc_host.py").read_text(encoding="utf-8")
    before_out = _snap_tree(outside)
    raised = False
    try:
        _apply_update_or_exc(mc, host_dir, zpath, case / "ext")
    except Exception:
        raised = True
    if not raised:
        violations.append("dup_case: apply_update did not raise")
    if (host_dir / "mc_host.py").read_text(encoding="utf-8") != before_host:
        violations.append("dup_case: host changed")
    if _snap_tree(outside) != before_out:
        violations.append("dup_case: outside changed")

    # trailing-dot / short-name style Win32 normalization pair
    case = base / "dup_norm"
    case.mkdir()
    host_dir = case / "host"
    _seed_plain_host(host_dir)
    zpath = case / "atk.zip"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("mc_host.py", 'VERSION = "2.0.0"\nEVIL\n')
        z.writestr("mchost/__init__.py", "EVIL_INIT\n")
        z.writestr("mchost/cast/backend.py", "# evil\n")
        z.writestr("mchost/foo.txt", _ATTACK_BODY)
        z.writestr("mchost/FOO.TXT", _ATTACK_BODY)
    zpath.write_bytes(buf.getvalue())
    raised = False
    try:
        _apply_update_or_exc(mc, host_dir, zpath, case / "ext")
    except Exception:
        raised = True
    if not raised:
        violations.append("dup_norm: apply_update did not raise")

    assert not violations, "apply_update alias violations:\n- " + "\n- ".join(violations)


def test_guardian_rejects_reparse_and_hardlink_destinations_without_restart(tmp_path):
    """Guardian must reject reparse/hardlink/alias destinations without outside writes."""
    violations: list[str] = []
    base = tmp_path / "guard_alias"
    base.mkdir()

    def _expect_reject(label: str, host_dir: Path, outside: Path, zpath: Path, work: Path, *, outside_is_file: bool = False):
        before_out = _file_meta(outside) if outside_is_file else _snap_tree(outside)
        before_host_py = None
        try:
            p = host_dir / "mc_host.py"
            if p.is_file():
                before_host_py = p.read_bytes()
        except OSError:
            pass
        r = _run_guardian_host(host_dir, zpath, work)
        if r.returncode == 0:
            violations.append(f"{label}: guardian returned 0 (stdout={r.stdout!r} stderr={r.stderr!r})")
        if outside_is_file:
            after = _file_meta(outside)
            if after[1] != before_out[1]:
                violations.append(f"{label}: outside file bytes changed")
            if after[1] is not None and _ATTACK_BODY in after[1]:
                violations.append(f"{label}: outside file contains attack payload")
            if after[3] != before_out[3] or after[4] != before_out[4]:
                violations.append(f"{label}: outside file id/nlink changed")
        else:
            if _outside_has_attack(outside):
                violations.append(f"{label}: outside tree contains attack payload")
            after = _snap_tree(outside)
            for k, v in after.items():
                if k not in before_out:
                    violations.append(f"{label}: new outside path {k}")
                elif v[1] != before_out[k][1]:
                    violations.append(f"{label}: outside bytes changed at {k}")
        try:
            if host_dir.exists():
                for p in host_dir.rglob("*"):
                    if p.is_file():
                        try:
                            if _ATTACK_BODY in p.read_bytes():
                                violations.append(f"{label}: attack payload under host path {p}")
                        except OSError:
                            pass
        except OSError:
            pass
        if before_host_py is not None:
            try:
                now = (host_dir / "mc_host.py").read_bytes()
                # Host may remain on pre-update content; attack body must not land.
                if _ATTACK_BODY in now:
                    violations.append(f"{label}: attack in mc_host.py")
            except OSError:
                pass

    # hostDir junction
    case = base / "junc_root"
    case.mkdir()
    outside = case / "outside_root"
    outside.mkdir()
    (outside / "marker.txt").write_bytes(_SAFE_OUTSIDE)
    (outside / "mc_host.py").write_text(_SAFE_HOST, encoding="utf-8")
    (outside / "mchost").mkdir()
    (outside / "mchost" / "__init__.py").write_text(_SAFE_INIT, encoding="utf-8")
    (outside / "mchost" / "cast").mkdir()
    (outside / "mchost" / "cast" / "backend.py").write_text("# old\n", encoding="utf-8")
    host_dir = case / "host"
    _new_junction(host_dir, outside)
    zpath = case / "atk.zip"
    _make_attack_zip(zpath, "alias_attack.txt")
    _expect_reject("hostdir_junction", host_dir, outside, zpath, case / "work")

    # intermediate junction
    case = base / "junc_mid"
    case.mkdir()
    host_dir = case / "host"
    _seed_plain_host(host_dir)
    (host_dir / "mchost" / "cast").mkdir(exist_ok=True)
    (host_dir / "mchost" / "cast" / "backend.py").write_text("# old\n", encoding="utf-8")
    outside = case / "outside_mid"
    outside.mkdir()
    (outside / "marker.txt").write_bytes(_SAFE_OUTSIDE)
    _new_junction(host_dir / "linked", outside)
    zpath = case / "atk.zip"
    _make_attack_zip(zpath, "linked/alias_attack.txt")
    _expect_reject("mid_junction", host_dir, outside, zpath, case / "work")

    # hard link final
    case = base / "hardlink"
    case.mkdir()
    host_dir = case / "host"
    _seed_plain_host(host_dir)
    (host_dir / "mchost" / "cast").mkdir(exist_ok=True)
    (host_dir / "mchost" / "cast" / "backend.py").write_text("# old\n", encoding="utf-8")
    outside = case / "outside_file.txt"
    outside.write_bytes(_SAFE_OUTSIDE)
    os.link(outside, host_dir / "shared.txt")
    zpath = case / "atk.zip"
    _make_attack_zip(zpath, "shared.txt")
    _expect_reject("hardlink_final", host_dir, outside, zpath, case / "work", outside_is_file=True)

    # dir symlink
    case = base / "symlink_dir"
    case.mkdir()
    host_dir = case / "host"
    _seed_plain_host(host_dir)
    (host_dir / "mchost" / "cast").mkdir(exist_ok=True)
    (host_dir / "mchost" / "cast" / "backend.py").write_text("# old\n", encoding="utf-8")
    outside = case / "outside_sdir"
    outside.mkdir()
    (outside / "marker.txt").write_bytes(_SAFE_OUTSIDE)
    sk = _try_symlink(host_dir / "linked", outside, directory=True)
    if sk == "skip":
        pass
    elif sk is not None:
        violations.append(f"symlink_dir setup: {sk}")
    else:
        zpath = case / "atk.zip"
        _make_attack_zip(zpath, "linked/alias_attack.txt")
        _expect_reject("mid_dir_symlink", host_dir, outside, zpath, case / "work")

    # file symlink
    case = base / "symlink_file"
    case.mkdir()
    host_dir = case / "host"
    _seed_plain_host(host_dir)
    (host_dir / "mchost" / "cast").mkdir(exist_ok=True)
    (host_dir / "mchost" / "cast" / "backend.py").write_text("# old\n", encoding="utf-8")
    outside = case / "outside_sfile.txt"
    outside.write_bytes(_SAFE_OUTSIDE)
    sk = _try_symlink(host_dir / "shared.txt", outside, directory=False)
    if sk == "skip":
        pass
    elif sk is not None:
        violations.append(f"symlink_file setup: {sk}")
    else:
        zpath = case / "atk.zip"
        _make_attack_zip(zpath, "shared.txt")
        _expect_reject("final_file_symlink", host_dir, outside, zpath, case / "work", outside_is_file=True)

    grammar_members = [
        "mchost/base.txt:evil",
        "mchost/foo:bar.txt",
        "mchost/CON",
        "mchost/NUL.txt",
        "mchost/COM1",
        "mchost/file.txt.",
        "mchost/file.txt ",
        "mchost/bad\x01name.txt",
        "mchost/bad\x7fname.txt",
        "mchost/bad\x9dname.txt",
    ]
    for i, mem in enumerate(grammar_members):
        case = base / f"grammar_{i}"
        case.mkdir()
        host_dir = case / "host"
        _seed_plain_host(host_dir)
        (host_dir / "mchost" / "cast").mkdir(exist_ok=True)
        (host_dir / "mchost" / "cast" / "backend.py").write_text("# old\n", encoding="utf-8")
        outside = case / "outside_unused"
        outside.mkdir()
        (outside / "marker.txt").write_bytes(_SAFE_OUTSIDE)
        before_host = (host_dir / "mc_host.py").read_text(encoding="utf-8")
        before_out = _snap_tree(outside)
        zpath = case / "atk.zip"
        _make_attack_zip(zpath, mem)
        r = _run_guardian_host(host_dir, zpath, case / "work")
        if r.returncode == 0:
            violations.append(f"grammar {mem!r}: guardian returned 0")
        if (host_dir / "mc_host.py").read_text(encoding="utf-8") != before_host:
            # reject may leave old or may have applied good members before fail — require no attack
            pass
        if _ATTACK_BODY in (host_dir / "mc_host.py").read_bytes():
            violations.append(f"grammar {mem!r}: attack in host")
        if _snap_tree(outside) != before_out or _outside_has_attack(outside) or _outside_has_attack(host_dir):
            if _outside_has_attack(outside) or _outside_has_attack(host_dir):
                violations.append(f"grammar {mem!r}: attack payload present")
            elif _snap_tree(outside) != before_out:
                violations.append(f"grammar {mem!r}: outside tree changed")

    # duplicate destinations
    case = base / "dup_case"
    case.mkdir()
    host_dir = case / "host"
    _seed_plain_host(host_dir)
    (host_dir / "mchost" / "cast").mkdir(exist_ok=True)
    (host_dir / "mchost" / "cast" / "backend.py").write_text("# old\n", encoding="utf-8")
    outside = case / "outside_dup"
    outside.mkdir()
    (outside / "marker.txt").write_bytes(_SAFE_OUTSIDE)
    zpath = case / "atk.zip"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("mc_host.py", 'VERSION = "2.0.0"\nEVIL\n')
        z.writestr("mchost/__init__.py", "EVIL_INIT\n")
        z.writestr("mchost/cast/backend.py", "# evil\n")
        z.writestr("mchost/Same.txt", _ATTACK_BODY)
        z.writestr("mchost/same.txt", _ATTACK_BODY)
    zpath.write_bytes(buf.getvalue())
    before_out = _snap_tree(outside)
    r = _run_guardian_host(host_dir, zpath, case / "work")
    if r.returncode == 0:
        violations.append("dup_case: guardian returned 0")
    if _snap_tree(outside) != before_out:
        violations.append("dup_case: outside changed")
    if _outside_has_attack(outside) or _outside_has_attack(host_dir):
        violations.append("dup_case: attack payload present")

    case = base / "dup_norm"
    case.mkdir()
    host_dir = case / "host"
    _seed_plain_host(host_dir)
    (host_dir / "mchost" / "cast").mkdir(exist_ok=True)
    (host_dir / "mchost" / "cast" / "backend.py").write_text("# old\n", encoding="utf-8")
    zpath = case / "atk.zip"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("mc_host.py", 'VERSION = "2.0.0"\nEVIL\n')
        z.writestr("mchost/__init__.py", "EVIL_INIT\n")
        z.writestr("mchost/cast/backend.py", "# evil\n")
        z.writestr("mchost/foo.txt", _ATTACK_BODY)
        z.writestr("mchost/FOO.TXT", _ATTACK_BODY)
    zpath.write_bytes(buf.getvalue())
    r = _run_guardian_host(host_dir, zpath, case / "work")
    if r.returncode == 0:
        violations.append("dup_norm: guardian returned 0")

    assert not violations, "guardian alias violations:\n- " + "\n- ".join(violations)


# Behavioural companions to the conformance cases above. Those assert HOW the
# handle-authority path works; these assert only the property that matters — a
# file sharing the destination's inode must survive — so they keep holding if the
# implementation is ever rewritten again.
def test_apply_update_does_not_write_through_a_hardlinked_destination(tmp_path, monkeypatch):
    """A hardlinked host file must not carry the payload outside the host directory.

    A hardlink carries no FILE_ATTRIBUTE_REPARSE_POINT, so the ancestor walk in
    _reject_reparse_components cannot see it. Writing a payload straight onto the
    existing path would follow the link and overwrite the outside target. The
    staging path already refuses multiply-linked files (NumberOfLinks != 1 in
    mchost/downloads.py); the update path must hold the same line.

    Behavioural, not conformance: it asserts only that the outside file survives,
    so either rejecting the update or replacing the link satisfies it.
    """
    mc = load_host()
    monkeypatch.setattr(mc, "find_profile", lambda: None)
    monkeypatch.setattr(mc, "load_config", lambda: {})
    monkeypatch.setattr(mc, "_await_zip", lambda path, tries=10, delay=0.5: True)

    host_dir = tmp_path / "host"
    host_dir.mkdir()
    outside = tmp_path / "outside-secret.txt"
    outside.write_text("DO-NOT-TOUCH\n", encoding="utf-8")

    # A payload member inside the host dir is a hard link to the outside file.
    os.link(outside, host_dir / "mc_host.py")
    assert os.stat(host_dir / "mc_host.py").st_nlink == 2, "hardlink not established"

    zpath = tmp_path / "media-catcher-host-2.0.0.zip"
    _make_release_shaped_zip(zpath, 'VERSION = "2.0.0"\nCHANGED\n')
    plan = {
        "ext_newer": False,
        "host_newer": True,
        "ext_zip": None,
        "host_zip": str(zpath),
        "ext_to": None,
        "host_to": "2.0.0",
    }

    try:
        mc.apply_update(plan, str(tmp_path / "ext"), str(host_dir))
    except Exception:
        pass          # refusing the update is a valid outcome; writing through is not

    assert outside.read_text(encoding="utf-8") == "DO-NOT-TOUCH\n", \
        "apply_update wrote through a hard link into a file outside the host directory"


def test_guardian_does_not_write_through_a_hardlinked_destination(tmp_path):
    """Guardian applies payloads with Copy-Item -Force, which follows a hard link.

    Same property as the in-process path: whatever else shares the destination's
    inode must survive. Guardian runs without a restart, so an unguarded copy
    here reaches outside the host directory exactly as apply_update did.
    """
    host_dir = tmp_path / "host"
    host_dir.mkdir()
    outside = tmp_path / "outside-secret.txt"
    outside.write_text("DO-NOT-TOUCH\n", encoding="utf-8")
    os.link(outside, host_dir / "mc_host.py")
    assert os.stat(host_dir / "mc_host.py").st_nlink == 2, "hardlink not established"

    zpath = tmp_path / "media-catcher-host-2.0.0.zip"
    _make_release_shaped_zip(zpath, 'VERSION = "2.0.0"\nCHANGED\n')
    cfg = {
        "applyExt": False,
        "applyHost": True,
        "extZip": None,
        "hostZip": str(zpath),
        "extDir": str(tmp_path / "ext"),
        "hostDir": str(host_dir),
        "profileDir": "",
        "extId": "{id}",
        "expectExtVersion": None,
        "expectHostVersion": "2.0.0",
        "python": sys.executable,
        "firefox": "",
        "restart": False,
        "backupRoot": str(tmp_path / "backups"),
        "keep": 3,
    }
    confpath = tmp_path / "guardian-config.json"
    confpath.write_text(json.dumps(cfg), encoding="utf-8")

    subprocess.run(
        [PS, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(GUARDIAN),
         "-Config", str(confpath), "-NoUi", "-NoRestart"],
        capture_output=True, text=True,
    )

    assert outside.read_text(encoding="utf-8") == "DO-NOT-TOUCH\n", \
        "guardian wrote through a hard link into a file outside the host directory"
