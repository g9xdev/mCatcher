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

# ---------------------------------------------------------------------------
# Root-identity-chain fail-closed coverage (appended tests only)
# ---------------------------------------------------------------------------
import ctypes
import shutil
import stat as _stat
import struct
import tempfile
import time
from ctypes import wintypes

_FILE_ATTRIBUTE_DIRECTORY = 0x00000010
_FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400
_FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
_FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
_GENERIC_READ = 0x80000000
_GENERIC_WRITE = 0x40000000
_FILE_SHARE_READ = 0x00000001
_FILE_SHARE_WRITE = 0x00000002
_OPEN_EXISTING = 3
_FileStandardInfo = 1
_FileAttributeTagInfo = 9
_FileIdInfo = 18
_INVALID_HANDLE_VALUE = wintypes.HANDLE(-1).value
_SYNCHRONIZE = 0x00100000
_FILE_READ_ATTRIBUTES = 0x80
_FILE_WRITE_DATA = 0x2
_FILE_READ_DATA = 0x1
_FILE_APPEND_DATA = 0x4
_FILE_OPEN = 0x00000001
_FILE_CREATE = 0x00000002
_FILE_DIRECTORY_FILE = 0x00000001
_FILE_NON_DIRECTORY_FILE = 0x00000040
_FILE_OPEN_REPARSE_POINT_NT = 0x00200000
_FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020
_FILE_OPEN_FOR_BACKUP_INTENT = 0x00004000
_OBJ_CASE_INSENSITIVE = 0x00000040
_IO_REPARSE_TAG_MOUNT_POINT = 0xA0000003
_FSCTL_GET_REPARSE_POINT = 0x000900A8
_FIND_STREAM_INFO_STANDARD = 0
_STATUS_OBJECT_PATH_NOT_FOUND = 0xC000003A
_DEBUG_ONLY_THIS_PROCESS = 0x00000002
_CREATE_UNICODE_ENVIRONMENT = 0x00000400
_CREATE_NO_WINDOW = 0x08000000
_DBG_CONTINUE = 0x00010002
_DBG_EXCEPTION_NOT_HANDLED = 0x80010001
_EXCEPTION_DEBUG_EVENT = 1
_CREATE_THREAD_DEBUG_EVENT = 2
_CREATE_PROCESS_DEBUG_EVENT = 3
_EXIT_PROCESS_DEBUG_EVENT = 5
_LOAD_DLL_DEBUG_EVENT = 6
_EXCEPTION_BREAKPOINT = 0x80000003
_CONTEXT_AMD64 = 0x00100000
_CONTEXT_CONTROL = 0x00000001
_CONTEXT_INTEGER = 0x00000002
_CONTEXT_FLAGS = _CONTEXT_AMD64 | _CONTEXT_CONTROL | _CONTEXT_INTEGER
_CTX_SIZE = 0x5D0
_OFF_RAX = 0x78
_OFF_RCX = 0x80
_OFF_RDX = 0x88
_OFF_RSP = 0x98
_OFF_R8 = 0xB8
_OFF_R9 = 0xC0
_OFF_RIP = 0xF8
_OFF_CTXFLAGS = 0x30
_THREAD_ALL = 0x1F03FF
_CREATE_SUSPENDED = 0x00000004
_NONBMP_LEAF = "leaf-\U0001F642.txt"
_NONBMP_UTF16 = _NONBMP_LEAF.encode("utf-16le")
_PROBE_MEMBER = "mchost/cast/probe.txt"
_PROBE_BODY = b"identity-probe-body\n"
_HOST_BODY_OLD = 'VERSION = "1.0.0"\nOLD\n'
_HOST_BODY_NEW = 'VERSION = "9.9.9"\nNEW\n'
_INIT_OLD = "# old-init\n"
_INIT_NEW = "# pkg\n"
_BACKEND_OLD = "# old-backend\n"
_BACKEND_NEW = "# backend\n"
_SMILE_BODY = b"smile-leaf\n"
_HOLD_PREFIX = "mc_hold_"


class _HarnessError(Exception):
    """Setup/observer/snapshot/teardown failure; must not become a product violation."""


class _UNICODE_STRING_OBS(ctypes.Structure):
    _fields_ = [
        ("Length", wintypes.USHORT),
        ("MaximumLength", wintypes.USHORT),
        ("Buffer", ctypes.c_void_p),
    ]


class _OA_OBS(ctypes.Structure):
    _fields_ = [
        ("Length", wintypes.ULONG),
        ("RootDirectory", wintypes.HANDLE),
        ("ObjectName", ctypes.POINTER(_UNICODE_STRING_OBS)),
        ("Attributes", wintypes.ULONG),
        ("SecurityDescriptor", ctypes.c_void_p),
        ("SecurityQualityOfService", ctypes.c_void_p),
    ]


class _WIN32_FIND_STREAM_DATA(ctypes.Structure):
    _fields_ = [("StreamSize", ctypes.c_longlong), ("cStreamName", ctypes.c_wchar * 296)]


class _STARTUPINFOW(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD),
        ("lpReserved", wintypes.LPWSTR),
        ("lpDesktop", wintypes.LPWSTR),
        ("lpTitle", wintypes.LPWSTR),
        ("dwX", wintypes.DWORD),
        ("dwY", wintypes.DWORD),
        ("dwXSize", wintypes.DWORD),
        ("dwYSize", wintypes.DWORD),
        ("dwXCountChars", wintypes.DWORD),
        ("dwYCountChars", wintypes.DWORD),
        ("dwFillAttribute", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("wShowWindow", wintypes.WORD),
        ("cbReserved2", wintypes.WORD),
        ("lpReserved2", ctypes.c_void_p),
        ("hStdInput", wintypes.HANDLE),
        ("hStdOutput", wintypes.HANDLE),
        ("hStdError", wintypes.HANDLE),
    ]


class _PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("hProcess", wintypes.HANDLE),
        ("hThread", wintypes.HANDLE),
        ("dwProcessId", wintypes.DWORD),
        ("dwThreadId", wintypes.DWORD),
    ]


class _EXCEPTION_RECORD(ctypes.Structure):
    _fields_ = [
        ("ExceptionCode", wintypes.DWORD),
        ("ExceptionFlags", wintypes.DWORD),
        ("ExceptionRecord", ctypes.c_void_p),
        ("ExceptionAddress", ctypes.c_void_p),
        ("NumberParameters", wintypes.DWORD),
        ("ExceptionInformation", ctypes.c_uint64 * 15),
    ]


class _EXCEPTION_DEBUG_INFO(ctypes.Structure):
    _fields_ = [("ExceptionRecord", _EXCEPTION_RECORD), ("dwFirstChance", wintypes.DWORD)]


class _CREATE_THREAD_DEBUG_INFO(ctypes.Structure):
    _fields_ = [
        ("hThread", wintypes.HANDLE),
        ("lpThreadLocalBase", ctypes.c_void_p),
        ("lpStartAddress", ctypes.c_void_p),
    ]


class _CREATE_PROCESS_DEBUG_INFO(ctypes.Structure):
    _fields_ = [
        ("hFile", wintypes.HANDLE),
        ("hProcess", wintypes.HANDLE),
        ("hThread", wintypes.HANDLE),
        ("lpBaseOfImage", ctypes.c_void_p),
        ("dwDebugInfoFileOffset", wintypes.DWORD),
        ("nDebugInfoSize", wintypes.DWORD),
        ("lpThreadLocalBase", ctypes.c_void_p),
        ("lpStartAddress", ctypes.c_void_p),
        ("lpImageName", ctypes.c_void_p),
        ("fUnicode", wintypes.WORD),
    ]


class _EXIT_PROCESS_DEBUG_INFO(ctypes.Structure):
    _fields_ = [("dwExitCode", wintypes.DWORD)]


class _LOAD_DLL_DEBUG_INFO(ctypes.Structure):
    _fields_ = [
        ("hFile", wintypes.HANDLE),
        ("lpBaseOfDll", ctypes.c_void_p),
        ("dwDebugInfoFileOffset", wintypes.DWORD),
        ("nDebugInfoSize", wintypes.DWORD),
        ("lpImageName", ctypes.c_void_p),
        ("fUnicode", wintypes.WORD),
    ]


class _DEBUG_EVENT_U(ctypes.Union):
    _fields_ = [
        ("Exception", _EXCEPTION_DEBUG_INFO),
        ("CreateThread", _CREATE_THREAD_DEBUG_INFO),
        ("CreateProcessInfo", _CREATE_PROCESS_DEBUG_INFO),
        ("ExitProcess", _EXIT_PROCESS_DEBUG_INFO),
        ("LoadDll", _LOAD_DLL_DEBUG_INFO),
        ("pad", ctypes.c_byte * 160),
    ]


class _DEBUG_EVENT(ctypes.Structure):
    _fields_ = [
        ("dwDebugEventCode", wintypes.DWORD),
        ("dwProcessId", wintypes.DWORD),
        ("dwThreadId", wintypes.DWORD),
        ("u", _DEBUG_EVENT_U),
    ]


def _bind_k32():
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateFileW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
        wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
    ]
    k32.CreateFileW.restype = wintypes.HANDLE
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    k32.CloseHandle.restype = wintypes.BOOL
    k32.GetFileInformationByHandleEx.argtypes = [
        wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
    ]
    k32.GetFileInformationByHandleEx.restype = wintypes.BOOL
    k32.WriteFile.argtypes = [
        wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p,
    ]
    k32.WriteFile.restype = wintypes.BOOL
    k32.SetEndOfFile.argtypes = [wintypes.HANDLE]
    k32.SetEndOfFile.restype = wintypes.BOOL
    k32.SetFilePointerEx.argtypes = [
        wintypes.HANDLE, ctypes.c_longlong, ctypes.POINTER(ctypes.c_longlong), wintypes.DWORD,
    ]
    k32.SetFilePointerEx.restype = wintypes.BOOL
    k32.DeviceIoControl.argtypes = [
        wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD,
        ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p,
    ]
    k32.DeviceIoControl.restype = wintypes.BOOL
    k32.FindFirstStreamW.argtypes = [wintypes.LPCWSTR, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    k32.FindFirstStreamW.restype = wintypes.HANDLE
    k32.FindNextStreamW.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
    k32.FindNextStreamW.restype = wintypes.BOOL
    k32.FindClose.argtypes = [wintypes.HANDLE]
    k32.FindClose.restype = wintypes.BOOL
    return k32


def _bind_ntdll():
    ntdll = ctypes.WinDLL("ntdll", use_last_error=True)

    class _US(ctypes.Structure):
        _fields_ = [
            ("Length", wintypes.USHORT),
            ("MaximumLength", wintypes.USHORT),
            ("Buffer", wintypes.LPWSTR),
        ]

    class _OA(ctypes.Structure):
        _fields_ = [
            ("Length", wintypes.ULONG),
            ("RootDirectory", wintypes.HANDLE),
            ("ObjectName", ctypes.POINTER(_US)),
            ("Attributes", wintypes.ULONG),
            ("SecurityDescriptor", ctypes.c_void_p),
            ("SecurityQualityOfService", ctypes.c_void_p),
        ]

    class _IOSB(ctypes.Structure):
        _fields_ = [("Status", ctypes.c_long), ("Information", ctypes.c_void_p)]

    ntdll.NtCreateFile.argtypes = [
        ctypes.POINTER(wintypes.HANDLE), wintypes.ULONG, ctypes.POINTER(_OA),
        ctypes.POINTER(_IOSB), ctypes.c_void_p, wintypes.ULONG, wintypes.ULONG,
        wintypes.ULONG, wintypes.ULONG, ctypes.c_void_p, wintypes.ULONG,
    ]
    ntdll.NtCreateFile.restype = ctypes.c_long
    ntdll._US = _US
    ntdll._OA = _OA
    ntdll._IOSB = _IOSB
    return ntdll


_SNAP_K32 = _bind_k32()


def _parse_c9(data: bytes) -> dict:
    if len(data) < 8:
        raise _HarnessError("class-9 buffer shorter than 8")
    attrs, tag = struct.unpack_from("<II", data, 0)
    return {"attrs": int(attrs), "tag": int(tag), "raw": data[:8]}


def _parse_c1(data: bytes) -> dict:
    if len(data) < 24:
        raise _HarnessError("class-1 buffer shorter than 24")
    alloc, eof, nlink, delp, isdir = struct.unpack_from("<qqIBB", data, 0)
    return {
        "allocation_size": int(alloc),
        "end_of_file": int(eof),
        "number_of_links": int(nlink),
        "delete_pending": int(delp),
        "directory": int(isdir),
        "raw": data[:24],
    }


def _parse_c18(data: bytes) -> dict:
    if len(data) < 24:
        raise _HarnessError("class-18 buffer shorter than 24")
    vol = struct.unpack_from("<Q", data, 0)[0]
    fid = data[8:24]
    return {"volume_serial": int(vol), "file_id": bytes(fid), "raw": data[:24]}


def _native_query_handle(h) -> dict:
    out = {}
    for cls, size, parser in (
        (_FileAttributeTagInfo, 8, _parse_c9),
        (_FileStandardInfo, 24, _parse_c1),
        (_FileIdInfo, 24, _parse_c18),
    ):
        buf = ctypes.create_string_buffer(size)
        ok = bool(_SNAP_K32.GetFileInformationByHandleEx(h, cls, buf, size))
        if not ok:
            raise _HarnessError("snapshot query class %s failed err=%s" % (cls, ctypes.get_last_error()))
        raw = bytes(buf)
        if len(raw) != size:
            raise _HarnessError("snapshot class %s size %s" % (cls, len(raw)))
        parsed = parser(raw)
        parsed["ok"] = True
        parsed["size"] = size
        out[cls] = parsed
    if out[18]["volume_serial"] == 0 or out[18]["file_id"] == b"\x00" * 16:
        raise _HarnessError("snapshot zero/ambiguous FileIdInfo")
    return out


def _open_nofollow(path: str):
    h = _SNAP_K32.CreateFileW(
        path,
        _GENERIC_READ | _FILE_READ_ATTRIBUTES | _SYNCHRONIZE,
        _FILE_SHARE_READ | _FILE_SHARE_WRITE,
        None,
        _OPEN_EXISTING,
        _FILE_FLAG_OPEN_REPARSE_POINT | _FILE_FLAG_BACKUP_SEMANTICS,
        None,
    )
    if int(h) == _INVALID_HANDLE_VALUE or h is None:
        raise _HarnessError("snapshot open failed for %r err=%s" % (path, ctypes.get_last_error()))
    return h


def _reparse_target(h) -> bytes | None:
    buf = ctypes.create_string_buffer(16 * 1024)
    ret = wintypes.DWORD(0)
    if not _SNAP_K32.DeviceIoControl(
        h, _FSCTL_GET_REPARSE_POINT, None, 0, buf, len(buf), ctypes.byref(ret), None
    ):
        return None
    return bytes(buf[: ret.value])


def _stream_facts(path: str) -> list[dict]:
    data = _WIN32_FIND_STREAM_DATA()
    h = _SNAP_K32.FindFirstStreamW(path, _FIND_STREAM_INFO_STANDARD, ctypes.byref(data), 0)
    if int(h) == _INVALID_HANDLE_VALUE:
        err = ctypes.get_last_error()
        if err in (38, 2, 87):
            return []
        raise _HarnessError("FindFirstStreamW failed for %r err=%s" % (path, err))
    out = []
    try:
        while True:
            name = data.cStreamName
            out.append({"name": name, "size": int(data.StreamSize)})
            if not _SNAP_K32.FindNextStreamW(h, ctypes.byref(data)):
                break
    finally:
        _SNAP_K32.FindClose(h)
    return out


def _entry_kind(st) -> str:
    mode = st.st_mode
    attrs = int(getattr(st, "st_file_attributes", 0) or 0)
    if attrs & _FILE_ATTRIBUTE_REPARSE_POINT:
        return "reparse"
    if _stat.S_ISDIR(mode):
        return "dir"
    if _stat.S_ISREG(mode):
        return "file"
    return "other"


def _record_path(path: Path, rel: str) -> dict:
    try:
        st = os.lstat(path)
    except OSError as e:
        raise _HarnessError("lstat failed for %r: %s" % (path, e))
    kind = _entry_kind(st)
    children = []
    if kind == "dir":
        try:
            children = sorted(os.listdir(path), key=lambda s: s.lower())
        except OSError as e:
            raise _HarnessError("listdir failed for %r: %s" % (path, e))
    data = None
    if kind == "file":
        data = path.read_bytes()
    h = _open_nofollow(str(path))
    try:
        native = _native_query_handle(h)
        tag = native[9]["tag"]
        attrs = native[9]["attrs"]
        is_reparse = bool(attrs & _FILE_ATTRIBUTE_REPARSE_POINT) or tag != 0
        target = _reparse_target(h) if is_reparse else None
    finally:
        if not _SNAP_K32.CloseHandle(h):
            raise _HarnessError("snapshot CloseHandle failed for %r" % path)
    streams = _stream_facts(str(path))
    probe_present = any(":mc_probe" in (s.get("name") or "") for s in streams)
    return {
        "rel": rel,
        "kind": kind,
        "children": children,
        "bytes": data,
        "reparse": bool(attrs & _FILE_ATTRIBUTE_REPARSE_POINT),
        "reparse_tag": int(tag),
        "reparse_target": target,
        "streams": streams,
        "probe_stream": probe_present,
        "st_mode": int(st.st_mode),
        "mtime_ns": int(getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9))),
        "st_dev": int(st.st_dev),
        "st_ino": int(st.st_ino),
        "st_nlink": int(st.st_nlink),
        "class9": native[9],
        "class1": native[1],
        "class18": native[18],
    }


def _tree_identity_snapshot(root) -> dict:
    root = Path(root)
    if not root.exists():
        raise _HarnessError("snapshot root missing: %s" % root)
    out = {}
    out["."] = _record_path(root, ".")
    if out["."]["kind"] == "reparse":
        return out
    pending = [(root, ".")]
    while pending:
        cur, crel = pending.pop()
        if out[crel]["kind"] != "dir":
            continue
        try:
            names = os.listdir(cur)
        except OSError as e:
            raise _HarnessError("enum failed for %r: %s" % (cur, e))
        for name in names:
            child = cur / name
            rel = name if crel == "." else crel + "/" + name
            rec = _record_path(child, rel)
            if rel in out:
                raise _HarnessError("unstable enumeration duplicate %r" % rel)
            out[rel] = rec
            if rec["kind"] == "dir":
                pending.append((child, rel))
    if "." not in out:
        raise _HarnessError("snapshot omitted root .")
    return out


def _snap_eq(a: dict, b: dict) -> list[str]:
    diffs = []
    if set(a) != set(b):
        diffs.append("keys a-b=%s b-a=%s" % (sorted(set(a) - set(b))[:8], sorted(set(b) - set(a))[:8]))
        return diffs
    for k in a:
        if a[k] != b[k]:
            diffs.append("mismatch at %s" % k)
    return diffs


def _content_diffs(a: dict, b: dict) -> list[str]:
    diffs = []
    if set(a) != set(b):
        diffs.append("keys a-b=%s b-a=%s" % (sorted(set(a) - set(b))[:8], sorted(set(b) - set(a))[:8]))
    fields = ("kind", "bytes", "reparse", "reparse_tag", "st_nlink", "probe_stream", "children")
    for k in set(a) | set(b):
        if k not in a or k not in b:
            continue
        for field in fields:
            if a[k].get(field) != b[k].get(field):
                diffs.append("%s.%s" % (k, field))
        aid = a[k].get("class18") or {}
        bid = b[k].get("class18") or {}
        if aid.get("file_id") != bid.get("file_id") or aid.get("volume_serial") != bid.get("volume_serial"):
            diffs.append("%s.file_id" % k)
    return diffs


def _classify_hostdir(value: str) -> str:
    if value is None:
        return "malformed"
    s = str(value)
    if s == "":
        return "malformed"
    if s.startswith("\\\\?\\GLOBALROOT") or s.upper().startswith("\\\\?\\GLOBALROOT"):
        return "global_root"
    if s.startswith("\\\\?\\") or s.startswith("//?/"):
        return "extended"
    if s.startswith("\\\\.\\") or s.startswith("//./"):
        return "device"
    if s.startswith("\\??\\") or s.startswith("/??/"):
        return "nt_namespace"
    if s.startswith("\\Device\\") or s.startswith("\\GLOBAL??\\"):
        return "nt_namespace"
    if s.startswith("\\\\") or s.startswith("//"):
        body = s[2:]
        sep = "\\" if s.startswith("\\\\") else "/"
        parts = [p for p in body.split(sep)]
        if len(parts) < 2 or parts[0] == "" or parts[1] == "":
            return "incomplete_unc"
        if any(p == "" for p in parts):
            return "incomplete_unc"
        if any(p in (".", "..") for p in parts):
            return "dot" if "." in parts else "dotdot"
        return "abs_unc"
    if len(s) >= 3 and s[1] == ":" and s[2] in "\\/":
        rest = s[3:]
        parts = [] if rest == "" else rest.replace("/", "\\").split("\\")
        if any(p == "" for p in parts):
            return "empty_component"
        if any(p == "." for p in parts):
            return "dot"
        if any(p == ".." for p in parts):
            return "dotdot"
        up = [p.upper() for p in parts]
        devices = {f"COM{i}" for i in range(1, 10)} | {f"LPT{i}" for i in range(1, 10)} | {"CON", "PRN", "AUX", "NUL"}
        if any(p.split(".")[0] in devices for p in up):
            return "device"
        return "abs_drive"
    if len(s) >= 2 and s[1] == ":" and (len(s) == 2 or s[2] not in "\\/"):
        return "drive_relative"
    if s.startswith("\\") or s.startswith("/"):
        return "root_relative"
    if ":" in s[:4] and s[1] != ":":
        return "malformed"
    parts = s.replace("/", "\\").split("\\")
    if any(p == "" for p in parts):
        return "empty_component"
    if any(p == "." for p in parts):
        return "dot"
    if any(p == ".." for p in parts):
        return "dotdot"
    return "relative"


def _drive_chain(abs_path: str) -> list[str]:
    p = abs_path.replace("/", "\\")
    if len(p) < 3 or p[1] != ":" or p[2] != "\\":
        raise _HarnessError("drive_chain requires abs drive path: %r" % abs_path)
    drive = p[:3]
    rest = p[3:]
    names = [x for x in rest.split("\\") if x]
    out = [drive]
    cur = drive
    for n in names:
        cur = cur + n if cur.endswith("\\") else cur + "\\" + n
        out.append(cur)
    return out


def _split_unc(abs_unc: str) -> tuple[str, str, list[str]]:
    s = abs_unc.replace("/", "\\")
    if not s.startswith("\\\\"):
        raise _HarnessError("not unc: %r" % abs_unc)
    parts = [p for p in s[2:].split("\\") if p]
    if len(parts) < 2:
        raise _HarnessError("incomplete unc: %r" % abs_unc)
    return parts[0], parts[1], parts[2:]


def _make_identity_zip(path: Path) -> None:
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("mc_host.py", _HOST_BODY_NEW)
        z.writestr("mchost/__init__.py", _INIT_NEW)
        z.writestr("mchost/cast/backend.py", _BACKEND_NEW)
        z.writestr("mchost/cast/" + _NONBMP_LEAF, _SMILE_BODY)
        z.writestr(_PROBE_MEMBER, _PROBE_BODY)


def _seed_host_tree(host: Path) -> None:
    host.mkdir(parents=True, exist_ok=True)
    (host / "mc_host.py").write_text(_HOST_BODY_OLD, encoding="utf-8")
    (host / "mchost").mkdir(exist_ok=True)
    (host / "mchost" / "__init__.py").write_text(_INIT_OLD, encoding="utf-8")
    (host / "mchost" / "cast").mkdir(exist_ok=True)
    (host / "mchost" / "cast" / "backend.py").write_text(_BACKEND_OLD, encoding="utf-8")
    try:
        (host / "mchost" / "cast" / _NONBMP_LEAF).write_bytes(b"pre-smile\n")
        (host / "mchost" / "cast" / _NONBMP_LEAF).unlink()
    except OSError as e:
        raise _HarnessError("cannot create/round-trip non-BMP leaf locally: %s" % e)


def _ps_new_junction(link: Path, target: Path) -> None:
    env = os.environ.copy()
    env["MC_JUNC_PATH"] = str(link)
    env["MC_JUNC_TARGET"] = str(target)
    r = subprocess.run(
        [
            PS, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
            "New-Item -ItemType Junction -Path $env:MC_JUNC_PATH -Target $env:MC_JUNC_TARGET | Out-Null",
        ],
        capture_output=True, text=True, env=env,
    )
    if r.returncode != 0:
        raise _HarnessError("junction create failed: %s%s" % (r.stdout, r.stderr))


def _rmtree(path: Path) -> None:
    if path is None or not path.exists():
        return

    def _onerr(fn, p, info):
        try:
            os.chmod(p, 0o700)
            fn(p)
        except OSError:
            try:
                if os.path.isdir(p) and not os.path.islink(p):
                    os.rmdir(p)
                else:
                    os.unlink(p)
            except OSError:
                pass

    shutil.rmtree(path, onexc=_onerr)
    if path.exists():
        raise _HarnessError("temp tree still present: %s" % path)


class _HandleGen:
    def __init__(self):
        self._next = 1
        self.live = {}
        self.recs = {}
        self.order = 0

    def note_open(self, handle, **meta):
        h = int(handle) & 0xFFFFFFFFFFFFFFFF
        if h == 0 or h == (_INVALID_HANDLE_VALUE & 0xFFFFFFFFFFFFFFFF):
            raise _HarnessError("refusing handle-zero/invalid as evidence")
        oid = self._next
        self._next += 1
        self.order += 1
        rec = {
            "open_id": oid, "handle": h, "parent_open_id": meta.get("parent_open_id"),
            "object_name_utf16": meta.get("object_name_utf16"),
            "object_name_len": meta.get("object_name_len"), "name": meta.get("name"),
            "api": meta.get("api"), "path": meta.get("path"), "access": meta.get("access"),
            "share": meta.get("share"), "disposition": meta.get("disposition"),
            "options": meta.get("options"), "status": meta.get("status"),
            "component": meta.get("component"), "role": meta.get("role"),
            "open_order": self.order, "queries": [], "muts": [], "closes": 0,
            "close_order": None, "nested": bool(meta.get("nested")),
            "entry_stack": meta.get("entry_stack"), "return_stack": meta.get("return_stack"),
        }
        self.live[h] = oid
        self.recs[oid] = rec
        return oid

    def note_close(self, handle):
        h = int(handle) & 0xFFFFFFFFFFFFFFFF
        oid = self.live.pop(h, None)
        if oid is not None:
            self.order += 1
            self.recs[oid]["closes"] += 1
            self.recs[oid]["close_order"] = self.order
        return oid

    def oid_of(self, handle):
        if handle is None:
            return None
        return self.live.get(int(handle) & 0xFFFFFFFFFFFFFFFF)

    def add_query(self, oid, cls, size, ok, data, fault):
        self.order += 1
        q = {"class": int(cls), "req_size": int(size), "ok": bool(ok),
             "data": bytes(data) if data else b"", "order": self.order, "fault": fault}
        if oid in self.recs:
            self.recs[oid]["queries"].append(q)
        return q

    def add_mut(self, oid, kind, ok, count=None):
        self.order += 1
        m = {"kind": kind, "ok": bool(ok), "count": count, "order": self.order}
        if oid in self.recs:
            self.recs[oid]["muts"].append(m)
        return m

    def lineage_leaf(self, oid):
        rec = self.recs.get(oid)
        if not rec:
            return None
        if rec["name"]:
            return rec["name"]
        if rec["path"]:
            return rec["path"].rstrip("\\/").split("\\")[-1]
        return None

    def lineage_parts(self, oid):
        parts = []
        cur = oid
        guard = 0
        while cur and guard < 64:
            rec = self.recs.get(cur)
            if not rec:
                break
            if rec["api"] == "CreateFileW" and rec.get("path"):
                parts.append(rec["path"])
                break
            if rec.get("name") is not None:
                parts.append(rec["name"])
            cur = rec.get("parent_open_id")
            guard += 1
        parts.reverse()
        return parts


class _PyNativeObserver:
    def __init__(self):
        self.gen = _HandleGen()
        self.events = []
        self.blocked = []
        self.rename_probe = None
        self.rename_events = []
        self.injected = []
        self.installed = False
        self._orig = {}
        self._ns = None
        self._block_pred = None
        self._fault_sel = []
        self.harness_errors = []

    def arm_fault(self, sel: dict):
        self._fault_sel.append(dict(sel))

    def arm_block(self, pred):
        self._block_pred = pred

    def arm_rename(self, parent_dir: Path, leaf: str, hold: Path):
        self.rename_probe = {
            "parent_dir": Path(parent_dir), "leaf": leaf, "hold": Path(hold),
            "armed_oid": None, "fired": False,
        }

    def install(self, k32, ntdll):
        if self.installed:
            raise _HarnessError("observer already installed")
        self._ns = (k32, ntdll)
        self._orig = {
            "CreateFileW": k32.CreateFileW,
            "NtCreateFile": ntdll.NtCreateFile,
            "GetFileInformationByHandleEx": k32.GetFileInformationByHandleEx,
            "CloseHandle": k32.CloseHandle,
            "SetFilePointerEx": k32.SetFilePointerEx,
            "SetEndOfFile": k32.SetEndOfFile,
            "WriteFile": k32.WriteFile,
        }
        k32.CreateFileW = self._wrap_cf
        ntdll.NtCreateFile = self._wrap_nt
        k32.GetFileInformationByHandleEx = self._wrap_q
        k32.CloseHandle = self._wrap_ch
        k32.SetFilePointerEx = self._wrap_sp
        k32.SetEndOfFile = self._wrap_se
        k32.WriteFile = self._wrap_wf
        self.installed = True

    def uninstall(self):
        if not self.installed:
            return
        k32, ntdll = self._ns
        k32.CreateFileW = self._orig["CreateFileW"]
        ntdll.NtCreateFile = self._orig["NtCreateFile"]
        k32.GetFileInformationByHandleEx = self._orig["GetFileInformationByHandleEx"]
        k32.CloseHandle = self._orig["CloseHandle"]
        k32.SetFilePointerEx = self._orig["SetFilePointerEx"]
        k32.SetEndOfFile = self._orig["SetEndOfFile"]
        k32.WriteFile = self._orig["WriteFile"]
        self.installed = False

    def _match_fault(self, oid, cls):
        rec = self.gen.recs.get(oid)
        for sel in self._fault_sel:
            if sel.get("hit"):
                continue
            if int(sel.get("cls", -1)) != int(cls):
                continue
            leaf = sel.get("leaf")
            if leaf and rec and self.gen.lineage_leaf(oid) != leaf:
                continue
            role = sel.get("role")
            if role == "drive_root":
                path = (rec or {}).get("path") or ""
                if not (len(path) == 3 and path[1] == ":" and path[2] == "\\"):
                    continue
            sel["hit"] = True
            sel["open_id"] = oid
            return sel
        return None

    def _wrap_cf(self, *a):
        path = a[0]
        access = int(a[1]) if len(a) > 1 else 0
        share = int(a[2]) if len(a) > 2 else 0
        disp = int(a[4]) if len(a) > 4 else 0
        flags = int(a[5]) if len(a) > 5 else 0
        if self._block_pred:
            decision = self._block_pred("CreateFileW", path, None)
            if decision:
                self.blocked.append(decision)
                ctypes.set_last_error(2)
                return wintypes.HANDLE(_INVALID_HANDLE_VALUE)
        h = self._orig["CreateFileW"](*a)
        hv = int(h) & 0xFFFFFFFFFFFFFFFF
        if hv and hv != (_INVALID_HANDLE_VALUE & 0xFFFFFFFFFFFFFFFF):
            oid = self.gen.note_open(
                hv, api="CreateFileW", path=str(path), access=access, share=share,
                disposition=disp, options=flags, status=0,
            )
            self.events.append({"kind": "open", "api": "CreateFileW", "open_id": oid, "handle": hv, "path": str(path)})
        return h

    def _wrap_nt(self, pH, access, pOA, pIOSB, alloc, attr, share, disp, options, ea, ealen):
        oa = ctypes.cast(pOA, ctypes.POINTER(_OA_OBS)).contents
        name = nlen = raw = None
        if oa.ObjectName:
            us = oa.ObjectName.contents
            nlen = int(us.Length)
            if us.Buffer and nlen:
                raw = ctypes.string_at(us.Buffer, nlen)
                name = raw.decode("utf-16le", "surrogatepass")
        parent = self.gen.oid_of(oa.RootDirectory) if oa.RootDirectory else None
        if self._block_pred:
            decision = self._block_pred("NtCreateFile", name, parent)
            if decision:
                self.blocked.append(decision)
                hp = ctypes.cast(pH, ctypes.POINTER(wintypes.HANDLE))
                hp.contents.value = 0
                return ctypes.c_long(_STATUS_OBJECT_PATH_NOT_FOUND).value
        if self.rename_probe and not self.rename_probe["fired"] and name == self.rename_probe["leaf"]:
            writeish = bool(int(access) & (_GENERIC_WRITE | _FILE_WRITE_DATA))
            if writeish and parent is not None and self.rename_probe.get("armed_oid") is not None:
                try:
                    src = self.rename_probe["parent_dir"] / self.rename_probe["leaf"]
                    hold = self.rename_probe["hold"]
                    os.rename(src, hold)
                    self.rename_events.append({"op": "rename_away", "src": str(src), "hold": str(hold), "ok": True})
                    os.rename(hold, src)
                    self.rename_events.append({"op": "rename_back", "ok": True, "hold_exists": hold.exists()})
                    self.rename_probe["fired"] = True
                except OSError as e:
                    self.harness_errors.append("rename probe failed: %s" % e)
                    raise _HarnessError("rename probe failed: %s" % e)
        st = self._orig["NtCreateFile"](pH, access, pOA, pIOSB, alloc, attr, share, disp, options, ea, ealen)
        if st >= 0:
            hv = int(ctypes.cast(pH, ctypes.POINTER(wintypes.HANDLE)).contents.value) & 0xFFFFFFFFFFFFFFFF
            self.gen.note_open(
                hv, api="NtCreateFile", name=name, object_name_utf16=raw, object_name_len=nlen,
                parent_open_id=parent, access=int(access), share=int(share), disposition=int(disp),
                options=int(options), status=int(st),
            )
            self.events.append({"kind": "open", "api": "NtCreateFile", "handle": hv, "name": name, "nlen": nlen})
        return st

    def _wrap_q(self, h, cls, buf, size):
        oid = self.gen.oid_of(h)
        if oid is None:
            raise _HarnessError("query on unknown handle %s class %s" % (int(h), cls))
        pre = bytes(ctypes.string_at(buf, size)) if buf else b""
        sel = self._match_fault(oid, cls)
        if sel and sel.get("mode") == "status":
            self.gen.add_query(oid, cls, size, False, pre, "status")
            self.injected.append({"open_id": oid, "cls": int(cls), "mode": "status", "pre": pre})
            ctypes.set_last_error(1)
            return 0
        ok = self._orig["GetFileInformationByHandleEx"](h, cls, buf, size)
        post = bytes(ctypes.string_at(buf, size)) if buf and ok else pre
        if sel and sel.get("mode") == "data":
            payload = sel.get("data") or b""
            slen = int(sel.get("supplied_length", len(payload)))
            mixed = bytearray(pre)
            mixed[: min(slen, len(mixed))] = payload[: min(slen, len(payload), len(mixed))]
            if buf:
                ctypes.memmove(buf, bytes(mixed), min(len(mixed), size))
            post = bytes(ctypes.string_at(buf, size)) if buf else bytes(mixed)
            self.gen.add_query(oid, cls, size, True, post, "data")
            self.injected.append({
                "open_id": oid, "cls": int(cls), "mode": "data", "supplied_length": slen,
                "post": post, "data": bytes(payload),
            })
            return 1
        self.gen.add_query(oid, cls, size, bool(ok), post, None)
        return ok

    def _wrap_ch(self, h):
        oid = self.gen.oid_of(h)
        rec = self.gen.recs.get(oid) if oid else None
        if rec and rec.get("name") == "mc_host.py" and not (int(rec.get("access") or 0) & (_GENERIC_WRITE | _FILE_WRITE_DATA)):
            if rec["queries"] and self.rename_probe is not None:
                self.rename_probe["armed_oid"] = oid
        gone = self.gen.note_close(h)
        if gone is not None:
            self.events.append({"kind": "close", "open_id": gone})
        return self._orig["CloseHandle"](h)

    def _wrap_sp(self, h, dist, out, method):
        oid = self.gen.oid_of(h)
        if oid is None:
            raise _HarnessError("SetFilePointerEx on unknown/closed handle")
        ok = self._orig["SetFilePointerEx"](h, dist, out, method)
        self.gen.add_mut(oid, "SetFilePointerEx", ok)
        return ok

    def _wrap_se(self, h):
        oid = self.gen.oid_of(h)
        if oid is None:
            raise _HarnessError("SetEndOfFile on unknown/closed handle")
        ok = self._orig["SetEndOfFile"](h)
        self.gen.add_mut(oid, "SetEndOfFile", ok)
        return ok

    def _wrap_wf(self, h, buf, n, written, ov):
        oid = self.gen.oid_of(h)
        if oid is None:
            raise _HarnessError("WriteFile on unknown/closed handle")
        ok = self._orig["WriteFile"](h, buf, n, written, ov)
        wc = 0
        if written:
            wc = int(ctypes.cast(written, ctypes.POINTER(wintypes.DWORD)).contents.value)
        self.gen.add_mut(oid, "WriteFile", ok, wc)
        return ok


def _selftest_py_observer(work: Path) -> dict:
    work.mkdir(parents=True, exist_ok=True)
    d = work / "d"
    d.mkdir()
    (d / "f.txt").write_bytes(b"hello")
    k32 = _bind_k32()
    ntdll = _bind_ntdll()
    obs = _PyNativeObserver()
    obs.arm_fault({"leaf": "d", "cls": 9, "mode": "data", "data": b"\x00" * 8, "supplied_length": 8})
    obs.arm_fault({"leaf": "d", "cls": 18, "mode": "status"})
    obs.install(k32, ntdll)
    try:
        dh = k32.CreateFileW(
            str(d), _GENERIC_READ | _FILE_READ_ATTRIBUTES | _SYNCHRONIZE,
            _FILE_SHARE_READ | _FILE_SHARE_WRITE, None, _OPEN_EXISTING,
            _FILE_FLAG_BACKUP_SEMANTICS | _FILE_FLAG_OPEN_REPARSE_POINT, None,
        )
        if int(dh) == _INVALID_HANDLE_VALUE:
            raise _HarnessError("selftest CreateFileW dir failed")
        oid_d = obs.gen.oid_of(dh)
        if oid_d is None:
            raise _HarnessError("selftest missing dir open_id")
        b9 = ctypes.create_string_buffer(8)
        if not k32.GetFileInformationByHandleEx(dh, 9, b9, 8):
            raise _HarnessError("selftest class9 should succeed as data fault")
        data_hit = any(i.get("mode") == "data" and i.get("cls") == 9 for i in obs.injected)
        b1 = ctypes.create_string_buffer(24)
        if not k32.GetFileInformationByHandleEx(dh, 1, b1, 24):
            raise _HarnessError("selftest class1 failed")
        b18 = ctypes.create_string_buffer(24)
        if k32.GetFileInformationByHandleEx(dh, 18, b18, 24):
            raise _HarnessError("selftest class18 status fault should fail")
        status_hit = any(i.get("mode") == "status" and i.get("cls") == 18 for i in obs.injected)
        us = ntdll._US()
        raw = "f.txt".encode("utf-16le")
        buf = ctypes.create_unicode_buffer("f.txt")
        us.Length = len(raw)
        us.MaximumLength = len(raw) + 2
        us.Buffer = ctypes.cast(buf, wintypes.LPWSTR)
        oa = ntdll._OA()
        oa.Length = ctypes.sizeof(ntdll._OA)
        oa.RootDirectory = dh
        oa.ObjectName = ctypes.pointer(us)
        oa.Attributes = _OBJ_CASE_INSENSITIVE
        iosb = ntdll._IOSB()
        handle = wintypes.HANDLE()
        access = _FILE_READ_ATTRIBUTES | _SYNCHRONIZE | _GENERIC_WRITE | _FILE_WRITE_DATA | _FILE_READ_DATA | _FILE_APPEND_DATA
        options = (
            _FILE_OPEN_REPARSE_POINT_NT | _FILE_SYNCHRONOUS_IO_NONALERT
            | _FILE_OPEN_FOR_BACKUP_INTENT | _FILE_NON_DIRECTORY_FILE
        )
        st = ntdll.NtCreateFile(
            ctypes.byref(handle), access, ctypes.byref(oa), ctypes.byref(iosb),
            None, 0, _FILE_SHARE_READ | _FILE_SHARE_WRITE, _FILE_OPEN, options, None, 0,
        )
        if st < 0:
            raise _HarnessError("selftest NtCreateFile failed 0x%08X" % (st & 0xFFFFFFFF))
        fh = handle.value
        oid_f = obs.gen.oid_of(fh)
        recf = obs.gen.recs[oid_f]
        if recf.get("parent_open_id") != oid_d:
            raise _HarnessError("selftest parent lineage")
        if recf.get("object_name_utf16") != raw or recf.get("object_name_len") != 10:
            raise _HarnessError("selftest ObjectName bytes")
        for cls, sz in ((9, 8), (1, 24), (18, 24)):
            bb = ctypes.create_string_buffer(sz)
            if not k32.GetFileInformationByHandleEx(fh, cls, bb, sz):
                raise _HarnessError("selftest file class %s failed" % cls)
            if cls == 18:
                parsed = _parse_c18(bytes(bb))
                if parsed["volume_serial"] == 0 or parsed["file_id"] == b"\x00" * 16:
                    raise _HarnessError("selftest class18 invalid")
        if not k32.SetFilePointerEx(fh, 0, None, 0):
            raise _HarnessError("selftest seek")
        if not k32.SetEndOfFile(fh):
            raise _HarnessError("selftest trunc")
        wr = wintypes.DWORD(0)
        payload = ctypes.create_string_buffer(b"ABC")
        if not k32.WriteFile(fh, payload, 3, ctypes.byref(wr), None) or wr.value != 3:
            raise _HarnessError("selftest write")
        kinds = [m["kind"] for m in recf["muts"]]
        if kinds != ["SetFilePointerEx", "SetEndOfFile", "WriteFile"]:
            raise _HarnessError("selftest mut order %s" % kinds)
        hnum = int(fh) & 0xFFFFFFFFFFFFFFFF
        if not k32.CloseHandle(fh):
            raise _HarnessError("selftest close file")
        oid2 = obs.gen.note_open(hnum, api="synthetic")
        if oid2 == oid_f:
            raise _HarnessError("selftest generation reuse")
        obs.gen.note_close(hnum)
        if not k32.CloseHandle(dh):
            raise _HarnessError("selftest close dir")
        if obs.gen.recs[oid_d]["closes"] != 1 or obs.gen.recs[oid_f]["closes"] != 1:
            raise _HarnessError("selftest close counts")
        if not status_hit or not data_hit:
            raise _HarnessError("selftest faults not hit")
    finally:
        obs.uninstall()
    return {
        "ok": True, "oids": [oid_d, oid_f, oid2], "status_hit": status_hit,
        "data_hit": data_hit, "returned_handle": True, "relative": True,
    }


def _u64(buf, off):
    return struct.unpack_from("<Q", buf, off)[0]


def _p64(buf, off, val):
    struct.pack_into("<Q", buf, off, val & 0xFFFFFFFFFFFFFFFF)


def _p32(buf, off, val):
    struct.pack_into("<I", buf, off, val & 0xFFFFFFFF)


class _DbgNativeObserver:
    HOOKS = (
        ("CreateFileW", "kernel32.dll", b"CreateFileW"),
        ("NtCreateFile", "ntdll.dll", b"NtCreateFile"),
        ("GetFileInformationByHandleEx", "kernel32.dll", b"GetFileInformationByHandleEx"),
        ("CloseHandle", "kernel32.dll", b"CloseHandle"),
        ("SetFilePointerEx", "kernel32.dll", b"SetFilePointerEx"),
        ("SetEndOfFile", "kernel32.dll", b"SetEndOfFile"),
        ("WriteFile", "kernel32.dll", b"WriteFile"),
        ("CreateProcessW", "kernel32.dll", b"CreateProcessW"),
    )

    def __init__(self):
        self.k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self._prep_dbg_api()
        self.gen = _HandleGen()
        self.events = []
        self.blocked = []
        self.injected = []
        self.rename_probe = None
        self.rename_events = []
        self.firefox_calls = []
        self.layer_proof = []
        self.exit_code = None
        self.pids = []
        self._block_pred = None
        self._fault_sel = []
        self.harness_errors = []

    def _prep_dbg_api(self):
        k = self.k32
        k.WaitForDebugEvent.argtypes = [ctypes.POINTER(_DEBUG_EVENT), wintypes.DWORD]
        k.WaitForDebugEvent.restype = wintypes.BOOL
        k.ContinueDebugEvent.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.DWORD]
        k.ContinueDebugEvent.restype = wintypes.BOOL
        k.CreateProcessW.argtypes = [
            wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, wintypes.BOOL,
            wintypes.DWORD, ctypes.c_void_p, wintypes.LPCWSTR, ctypes.POINTER(_STARTUPINFOW),
            ctypes.POINTER(_PROCESS_INFORMATION),
        ]
        k.CreateProcessW.restype = wintypes.BOOL
        k.GetThreadContext.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
        k.GetThreadContext.restype = wintypes.BOOL
        k.SetThreadContext.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
        k.SetThreadContext.restype = wintypes.BOOL
        k.ReadProcessMemory.argtypes = [
            wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t,
            ctypes.POINTER(ctypes.c_size_t),
        ]
        k.ReadProcessMemory.restype = wintypes.BOOL
        k.WriteProcessMemory.argtypes = [
            wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t,
            ctypes.POINTER(ctypes.c_size_t),
        ]
        k.WriteProcessMemory.restype = wintypes.BOOL
        k.FlushInstructionCache.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_size_t]
        k.FlushInstructionCache.restype = wintypes.BOOL
        k.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        k.OpenThread.restype = wintypes.HANDLE
        k.VirtualProtectEx.argtypes = [
            wintypes.HANDLE, ctypes.c_void_p, ctypes.c_size_t, wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD),
        ]
        k.VirtualProtectEx.restype = wintypes.BOOL
        k.GetProcAddress.argtypes = [wintypes.HMODULE, ctypes.c_char_p]
        k.GetProcAddress.restype = ctypes.c_void_p
        k.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
        k.GetModuleHandleW.restype = wintypes.HMODULE
        k.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
        k.TerminateProcess.restype = wintypes.BOOL
        k.CloseHandle.argtypes = [wintypes.HANDLE]
        k.CloseHandle.restype = wintypes.BOOL
        k.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        k.CreateJobObjectW.restype = wintypes.HANDLE
        k.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        k.AssignProcessToJobObject.restype = wintypes.BOOL
        k.ResumeThread.argtypes = [wintypes.HANDLE]
        k.ResumeThread.restype = wintypes.DWORD

    def arm_fault(self, sel):
        self._fault_sel.append(dict(sel))

    def arm_block(self, pred):
        self._block_pred = pred

    def arm_rename(self, parent_dir, leaf, hold):
        self.rename_probe = {
            "parent_dir": Path(parent_dir), "leaf": leaf, "hold": Path(hold),
            "armed_oid": None, "fired": False,
        }

    def _rpm(self, hp, addr, n):
        buf = ctypes.create_string_buffer(n)
        got = ctypes.c_size_t(0)
        if not self.k32.ReadProcessMemory(hp, ctypes.c_void_p(addr), buf, n, ctypes.byref(got)):
            return None
        return buf.raw[: got.value]

    def _wpm(self, hp, addr, data):
        buf = ctypes.create_string_buffer(data, len(data))
        got = ctypes.c_size_t(0)
        old = wintypes.DWORD(0)
        self.k32.VirtualProtectEx(hp, ctypes.c_void_p(addr), len(data), 0x40, ctypes.byref(old))
        ok = self.k32.WriteProcessMemory(hp, ctypes.c_void_p(addr), buf, len(data), ctypes.byref(got))
        self.k32.FlushInstructionCache(hp, ctypes.c_void_p(addr), len(data))
        return bool(ok)

    def _read_wstr(self, hp, addr, limit=32768):
        if not addr:
            return None
        raw = self._rpm(hp, addr, min(limit, 4096))
        if not raw:
            return None
        if b"\x00\x00" in raw:
            raw = raw[: raw.find(b"\x00\x00") + 2]
            if len(raw) % 2:
                raw = raw[:-1]
        return raw.decode("utf-16le", "surrogatepass").rstrip("\x00")

    def _read_nt_name(self, hp, oa_addr):
        if not oa_addr:
            return None, None, None, None
        blob = self._rpm(hp, oa_addr, 48)
        if not blob or len(blob) < 24:
            return None, None, None, None
        root = struct.unpack_from("<Q", blob, 8)[0]
        name_ptr = struct.unpack_from("<Q", blob, 16)[0]
        if not name_ptr:
            return root, None, None, None
        us = self._rpm(hp, name_ptr, 16)
        if not us:
            return root, None, None, None
        nlen = struct.unpack_from("<H", us, 0)[0]
        bufptr = struct.unpack_from("<Q", us, 8)[0]
        raw = self._rpm(hp, bufptr, nlen) if bufptr and nlen else b""
        name = raw.decode("utf-16le", "surrogatepass") if raw else ""
        return root, name, nlen, raw

    def _match_fault(self, oid, cls):
        rec = self.gen.recs.get(oid)
        for sel in self._fault_sel:
            if sel.get("hit"):
                continue
            if int(sel.get("cls", -1)) != int(cls):
                continue
            leaf = sel.get("leaf")
            if leaf and rec and self.gen.lineage_leaf(oid) != leaf:
                continue
            role = sel.get("role")
            if role == "drive_root":
                path = (rec or {}).get("path") or ""
                if not (len(path) == 3 and path[1] == ":" and path[2] == "\\"):
                    continue
            sel["hit"] = True
            sel["open_id"] = oid
            return sel
        return None

    def run(self, argv, *, env, cwd, timeout=90):
        env = dict(env)
        block = ("\0".join("%s=%s" % (k, env[k]) for k in env) + "\0\0").encode("utf-16le")
        env_buf = ctypes.create_string_buffer(block)
        si = _STARTUPINFOW()
        si.cb = ctypes.sizeof(_STARTUPINFOW)
        pi = _PROCESS_INFORMATION()
        cl = subprocess.list2cmdline(argv)
        cl_buf = ctypes.create_unicode_buffer(cl)
        ok = self.k32.CreateProcessW(
            argv[0], cl_buf, None, None, False,
            _DEBUG_ONLY_THIS_PROCESS | _CREATE_UNICODE_ENVIRONMENT | _CREATE_NO_WINDOW | _CREATE_SUSPENDED,
            ctypes.cast(env_buf, ctypes.c_void_p), str(cwd), ctypes.byref(si), ctypes.byref(pi),
        )
        if not ok:
            raise _HarnessError("CreateProcessW failed %s" % ctypes.get_last_error())
        job = self.k32.CreateJobObjectW(None, None)
        if job:
            self.k32.AssignProcessToJobObject(job, pi.hProcess)
        self.k32.ResumeThread(pi.hThread)
        self.pids.append(int(pi.dwProcessId))
        hp = pi.hProcess
        threads = {pi.dwThreadId: pi.hThread}
        addrs = {}
        orig = {}
        by_addr = {}
        for nm, dll, exp in self.HOOKS:
            addrs[nm] = self.k32.GetProcAddress(self.k32.GetModuleHandleW(dll), exp)
        planted = False
        ret_stack = {}
        cf_inflight = {}
        deadline = time.monotonic() + timeout
        n = 0
        try:
            while time.monotonic() < deadline and n < 200000:
                ev = _DEBUG_EVENT()
                if not self.k32.WaitForDebugEvent(ctypes.byref(ev), 2000):
                    continue
                n += 1
                code = ev.dwDebugEventCode
                cont = _DBG_CONTINUE
                if code == _CREATE_PROCESS_DEBUG_EVENT:
                    threads[ev.dwThreadId] = ev.u.CreateProcessInfo.hThread
                    if ev.u.CreateProcessInfo.hFile:
                        self.k32.CloseHandle(ev.u.CreateProcessInfo.hFile)
                elif code == _CREATE_THREAD_DEBUG_EVENT:
                    threads[ev.dwThreadId] = ev.u.CreateThread.hThread
                elif code == _LOAD_DLL_DEBUG_EVENT:
                    if ev.u.LoadDll.hFile:
                        self.k32.CloseHandle(ev.u.LoadDll.hFile)
                elif code == _EXIT_PROCESS_DEBUG_EVENT:
                    self.exit_code = ev.u.ExitProcess.dwExitCode
                    self.k32.ContinueDebugEvent(ev.dwProcessId, ev.dwThreadId, cont)
                    break
                elif code == _EXCEPTION_DEBUG_EVENT:
                    rec = ev.u.Exception.ExceptionRecord
                    ecode = rec.ExceptionCode & 0xFFFFFFFF
                    addr = int(rec.ExceptionAddress or 0)
                    th = threads.get(ev.dwThreadId)
                    if th is None:
                        th = self.k32.OpenThread(_THREAD_ALL, False, ev.dwThreadId)
                        threads[ev.dwThreadId] = th
                    if ecode == _EXCEPTION_BREAKPOINT:
                        if not planted:
                            for nm, a in addrs.items():
                                if not a:
                                    continue
                                b = self._rpm(hp, a, 1)
                                if not b:
                                    continue
                                orig[nm] = b
                                by_addr[a] = nm
                                self._wpm(hp, a, b"\xCC")
                            planted = True
                            self.events.append({"kind": "planted", "names": list(orig)})
                        elif addr in by_addr:
                            self._on_entry(hp, th, ev, addr, by_addr, addrs, orig, ret_stack, cf_inflight)
                        elif not self._on_return(hp, th, ev, addr, addrs, orig, ret_stack, cf_inflight):
                            cont = _DBG_EXCEPTION_NOT_HANDLED
                    elif ev.u.Exception.dwFirstChance:
                        cont = _DBG_EXCEPTION_NOT_HANDLED
                self.k32.ContinueDebugEvent(ev.dwProcessId, ev.dwThreadId, cont)
            else:
                self.k32.TerminateProcess(hp, 9)
                if self.exit_code is None:
                    raise _HarnessError("debuggee timeout/no exit")
        finally:
            self.k32.CloseHandle(pi.hThread)
            self.k32.CloseHandle(pi.hProcess)
            if job:
                self.k32.CloseHandle(job)
        return self.exit_code

    def _on_entry(self, hp, th, ev, addr, by_addr, addrs, orig, ret_stack, cf_inflight):
        nm = by_addr[addr]
        ctx = ctypes.create_string_buffer(_CTX_SIZE)
        _p32(ctx, _OFF_CTXFLAGS, _CONTEXT_FLAGS)
        if not self.k32.GetThreadContext(th, ctx):
            return
        ctxb = bytearray(ctx)
        self._wpm(hp, addrs[nm], orig[nm])
        _p64(ctxb, _OFF_RIP, addr)
        rcx = _u64(ctxb, _OFF_RCX)
        rdx = _u64(ctxb, _OFF_RDX)
        r8 = _u64(ctxb, _OFF_R8)
        r9 = _u64(ctxb, _OFF_R9)
        rsp = _u64(ctxb, _OFF_RSP)
        rb = self._rpm(hp, rsp, 8)
        retaddr = struct.unpack("<Q", rb)[0] if rb else 0
        retb = self._rpm(hp, retaddr, 1) if retaddr else None
        nested = bool(cf_inflight.get(ev.dwThreadId)) and nm == "NtCreateFile"
        path = None
        nt_root = nt_name = nt_len = nt_raw = None
        if nm == "CreateFileW":
            path = self._read_wstr(hp, rcx)
            if self._block_pred:
                dec = self._block_pred("CreateFileW", path, None)
                if dec:
                    self.blocked.append(dec)
                    _p64(ctxb, _OFF_RAX, _INVALID_HANDLE_VALUE & 0xFFFFFFFFFFFFFFFF)
                    _p64(ctxb, _OFF_RIP, retaddr)
                    _p64(ctxb, _OFF_RSP, rsp + 8)
                    self._wpm(hp, addrs[nm], b"\xCC")
                    buf = ctypes.create_string_buffer(bytes(ctxb), len(ctxb))
                    _p32(buf, _OFF_CTXFLAGS, _CONTEXT_FLAGS)
                    self.k32.SetThreadContext(th, buf)
                    return
        if nm == "NtCreateFile":
            nt_root, nt_name, nt_len, nt_raw = self._read_nt_name(hp, r8)
            parent = self.gen.oid_of(nt_root)
            if self._block_pred:
                dec = self._block_pred("NtCreateFile", nt_name, parent)
                if dec:
                    self.blocked.append(dec)
                    self._wpm(hp, rcx, b"\x00" * 8)
                    _p64(ctxb, _OFF_RAX, _STATUS_OBJECT_PATH_NOT_FOUND)
                    _p64(ctxb, _OFF_RIP, retaddr)
                    _p64(ctxb, _OFF_RSP, rsp + 8)
                    self._wpm(hp, addrs[nm], b"\xCC")
                    buf = ctypes.create_string_buffer(bytes(ctxb), len(ctxb))
                    _p32(buf, _OFF_CTXFLAGS, _CONTEXT_FLAGS)
                    self.k32.SetThreadContext(th, buf)
                    return
            if (self.rename_probe and not self.rename_probe["fired"] and nt_name == self.rename_probe["leaf"]
                    and parent is not None and self.rename_probe.get("armed_oid") is not None
                    and (int(rdx) & (_GENERIC_WRITE | _FILE_WRITE_DATA))):
                src = self.rename_probe["parent_dir"] / self.rename_probe["leaf"]
                hold = self.rename_probe["hold"]
                try:
                    os.rename(src, hold)
                    self.rename_events.append({"op": "rename_away", "ok": True})
                    os.rename(hold, src)
                    self.rename_events.append({"op": "rename_back", "ok": True, "hold_exists": hold.exists()})
                    self.rename_probe["fired"] = True
                except OSError as e:
                    raise _HarnessError("rename probe failed: %s" % e)
        if nm == "CreateFileW":
            cf_inflight[ev.dwThreadId] = cf_inflight.get(ev.dwThreadId, 0) + 1
        if retb:
            self._wpm(hp, retaddr, b"\xCC")
        ret_stack.setdefault(ev.dwThreadId, []).append({
            "name": nm, "ret": retaddr, "retb": retb, "rcx": rcx, "rdx": rdx,
            "r8": r8, "r9": r9, "nested": nested, "path": path,
            "nt_root": nt_root, "nt_name": nt_name, "nt_len": nt_len, "nt_raw": nt_raw,
            "pre_q": (self._rpm(hp, r8, int(r9) & 0xFFFFFFFF) if nm == "GetFileInformationByHandleEx" and r8 else None),
        })
        self.events.append({"kind": "entry", "api": nm, "nested": nested, "path": path, "name": nt_name})
        buf = ctypes.create_string_buffer(bytes(ctxb), len(ctxb))
        _p32(buf, _OFF_CTXFLAGS, _CONTEXT_FLAGS)
        self.k32.SetThreadContext(th, buf)

    def _on_return(self, hp, th, ev, addr, addrs, orig, ret_stack, cf_inflight):
        stack = ret_stack.get(ev.dwThreadId) or []
        hit = None
        for i in range(len(stack) - 1, -1, -1):
            if stack[i]["ret"] == addr:
                hit = stack.pop(i)
                break
        if not (hit and hit["retb"]):
            return False
        self._wpm(hp, hit["ret"], hit["retb"])
        if hit["name"] in orig:
            self._wpm(hp, addrs[hit["name"]], b"\xCC")
        ctx = ctypes.create_string_buffer(_CTX_SIZE)
        _p32(ctx, _OFF_CTXFLAGS, _CONTEXT_FLAGS)
        if not self.k32.GetThreadContext(th, ctx):
            return False
        ctxb = bytearray(ctx)
        _p64(ctxb, _OFF_RIP, addr)
        rax = _u64(ctxb, _OFF_RAX)
        nm = hit["name"]
        if nm == "CreateFileW":
            cf_inflight[ev.dwThreadId] = max(0, cf_inflight.get(ev.dwThreadId, 1) - 1)
            if (not hit["nested"] and rax and rax != (_INVALID_HANDLE_VALUE & 0xFFFFFFFFFFFFFFFF)):
                oid = self.gen.note_open(
                    rax, api="CreateFileW", path=hit["path"], access=int(hit["rdx"]),
                    status=0, entry_stack=("CreateFileW",),
                )
                self.layer_proof.append({"api": "CreateFileW", "open_id": oid, "handle": rax, "nested_suppressed": True})
        elif nm == "NtCreateFile":
            st = rax & 0xFFFFFFFF
            if st < 0x80000000 and not hit["nested"]:
                hb = self._rpm(hp, hit["rcx"], 8)
                if not hb:
                    raise _HarnessError("NtCreateFile success without handle bytes")
                hv = struct.unpack("<Q", hb)[0]
                parent = self.gen.oid_of(hit["nt_root"])
                self.gen.note_open(
                    hv, api="NtCreateFile", name=hit["nt_name"], object_name_utf16=hit["nt_raw"],
                    object_name_len=hit["nt_len"], parent_open_id=parent, access=int(hit["rdx"]),
                    status=st, entry_stack=("NtCreateFile",),
                )
                self.layer_proof.append({"api": "NtCreateFile", "handle": hv, "nested": False})
            elif hit["nested"]:
                self.layer_proof.append({"api": "NtCreateFile", "nested": True, "status": st})
        elif nm == "GetFileInformationByHandleEx":
            oid = self.gen.oid_of(hit["rcx"])
            if oid is not None:
                cls = int(hit["rdx"] & 0xFFFFFFFF)
                size = int(hit["r9"] & 0xFFFFFFFF)
                sel = self._match_fault(oid, cls)
                if sel and sel.get("mode") == "status":
                    _p64(ctxb, _OFF_RAX, 0)
                    self.gen.add_query(oid, cls, size, False, hit.get("pre_q") or b"", "status")
                    self.injected.append({"open_id": oid, "cls": cls, "mode": "status"})
                elif sel and sel.get("mode") == "data":
                    payload = sel.get("data") or b""
                    slen = int(sel.get("supplied_length", len(payload)))
                    pre = hit.get("pre_q") or (b"\x00" * size)
                    mixed = bytearray(pre[:size] + b"\x00" * max(0, size - len(pre)))
                    mixed[: min(slen, len(mixed))] = payload[: min(slen, len(payload), len(mixed))]
                    self._wpm(hp, hit["r8"], bytes(mixed))
                    _p64(ctxb, _OFF_RAX, 1)
                    self.gen.add_query(oid, cls, size, True, bytes(mixed), "data")
                    self.injected.append({"open_id": oid, "cls": cls, "mode": "data",
                                         "supplied_length": slen, "post": bytes(mixed)})
                else:
                    post = self._rpm(hp, hit["r8"], size) if hit["r8"] else b""
                    self.gen.add_query(oid, cls, size, bool(rax), post or b"", None)
        elif nm == "CloseHandle":
            oid = self.gen.oid_of(hit["rcx"])
            rec = self.gen.recs.get(oid) if oid else None
            if rec and rec.get("name") == "mc_host.py" and not (
                int(rec.get("access") or 0) & (_GENERIC_WRITE | _FILE_WRITE_DATA)
            ):
                if rec["queries"] and self.rename_probe is not None:
                    self.rename_probe["armed_oid"] = oid
            if oid is not None:
                self.gen.note_close(hit["rcx"])
        elif nm in ("SetFilePointerEx", "SetEndOfFile", "WriteFile"):
            oid = self.gen.oid_of(hit["rcx"])
            if oid is not None:
                cnt = int(hit["r9"] & 0xFFFFFFFF) if nm == "WriteFile" and rax else None
                self.gen.add_mut(oid, nm, bool(rax), cnt)
        elif nm == "CreateProcessW":
            img = self._read_wstr(hp, hit["rcx"]) if hit["rcx"] else ""
            if img and "firefox" in img.lower():
                self.firefox_calls.append(img)
        self.events.append({"kind": "ret", "api": nm, "rax": rax})
        buf = ctypes.create_string_buffer(bytes(ctxb), len(ctxb))
        _p32(buf, _OFF_CTXFLAGS, _CONTEXT_FLAGS)
        self.k32.SetThreadContext(th, buf)
        return True


def _selftest_dbg_observer(work: Path) -> dict:
    work.mkdir(parents=True, exist_ok=True)
    (work / "f.txt").write_bytes(b"xx")
    child = (
        "import ctypes,os,sys;from ctypes import wintypes;"
        "k=ctypes.WinDLL('kernel32',use_last_error=True);"
        "d=os.environ['MC_OBS_DIR'];"
        "h=k.CreateFileW(d,0x80000000|0x80|0x100000,3,None,3,0x02200000,None);"
        "assert h!=wintypes.HANDLE(-1).value;"
        "b=ctypes.create_string_buffer(8);assert k.GetFileInformationByHandleEx(h,9,b,8);"
        "b=ctypes.create_string_buffer(24);assert k.GetFileInformationByHandleEx(h,1,b,24);"
        "b=ctypes.create_string_buffer(24);assert k.GetFileInformationByHandleEx(h,18,b,24);"
        "k.CloseHandle(h);sys.exit(0)"
    )
    env = os.environ.copy()
    env["MC_OBS_DIR"] = str(work)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    obs = _DbgNativeObserver()
    code = obs.run([sys.executable, "-B", "-c", child], env=env, cwd=work, timeout=30)
    if code != 0:
        raise _HarnessError("dbg selftest exit %s" % code)
    opens = [r for r in obs.gen.recs.values() if r["api"] == "CreateFileW"]
    if not opens:
        raise _HarnessError("dbg selftest no CreateFileW open_id")
    rec = opens[-1]
    found = False
    for r in obs.gen.recs.values():
        cs = {(q["class"], q["req_size"]) for q in r["queries"] if q["ok"]}
        if (9, 8) in cs and (1, 24) in cs and (18, 24) in cs:
            found = True
            break
    if not found:
        raise _HarnessError("dbg selftest missing 9/1/18 on one open_id")
    nested = [p for p in obs.layer_proof if p.get("nested")]
    direct_cf = [p for p in obs.layer_proof if p.get("api") == "CreateFileW"]
    if not direct_cf or not nested:
        raise _HarnessError("dbg selftest layer filter unproven")
    hnum = rec["handle"]
    if obs.gen.oid_of(hnum):
        obs.gen.note_close(hnum)
    oid2 = obs.gen.note_open(hnum, api="synthetic")
    if oid2 == rec["open_id"]:
        raise _HarnessError("dbg generation")
    return {"ok": True, "exit": code, "layer": True, "oids": [rec["open_id"], oid2]}


def _successful_classes(rec) -> dict:
    out = {}
    for q in rec.get("queries") or []:
        if q.get("ok") and q.get("fault") is None:
            out[int(q["class"])] = q
    return out


def _coverage_violations(obs, expected_paths, *, label: str) -> list[str]:
    v = []
    recs = obs.gen.recs
    for exp in expected_paths:
        kind = exp["kind"]
        found = None
        if kind == "drive_root":
            for rec in recs.values():
                p = rec.get("path") or ""
                if rec.get("api") == "CreateFileW" and len(p) == 3 and p[1] == ":" and p.endswith("\\"):
                    found = rec
                    break
            if found is None:
                v.append("%s: missing retained handle for drive root" % label)
                continue
        elif kind == "abs":
            want = os.path.normcase(exp["path"])
            for rec in recs.values():
                if rec.get("api") == "CreateFileW" and os.path.normcase(rec.get("path") or "") == want:
                    found = rec
                    break
            if found is None:
                v.append("%s: missing retained handle for %s" % (label, exp["path"]))
                continue
        else:
            leaf = exp["leaf"]
            cands = [rec for rec in recs.values() if rec.get("name") == leaf]
            if not cands:
                v.append("%s: missing handle for component %s" % (label, leaf))
                continue
            found = cands[-1]
        oid = found["open_id"]
        qs = _successful_classes(found)
        for cls, size in ((9, 8), (1, 24), (18, 24)):
            q = qs.get(cls)
            if q is None:
                if cls == 18:
                    v.append("FileIdInfo not queried on open_id %s (%s)" % (oid, label))
                else:
                    v.append("%s: class %s not queried on open_id %s" % (label, cls, oid))
            elif q.get("req_size") != size or len(q.get("data") or b"") < size:
                v.append("%s: class %s size/data incomplete on open_id %s" % (label, cls, oid))
            elif cls == 18:
                p = _parse_c18(q["data"])
                if p["volume_serial"] == 0 or p["file_id"] == b"\x00" * 16:
                    v.append("%s: invalid FileIdInfo on open_id %s" % (label, oid))
    return v


def _mutation_happened(obs) -> bool:
    return any(rec.get("muts") for rec in obs.gen.recs.values())


def _nonbmp_violations(obs, host: Path, label: str) -> list[str]:
    v = []
    saw = False
    for rec in obs.gen.recs.values():
        raw = rec.get("object_name_utf16")
        nlen = rec.get("object_name_len")
        name = rec.get("name")
        if raw == _NONBMP_UTF16 and nlen == len(_NONBMP_UTF16):
            saw = True
        elif name and "leaf-" in name and rec.get("api") == "NtCreateFile":
            v.append("%s: non-BMP ObjectName was %r len=%s want %s" % (label, name, nlen, len(_NONBMP_UTF16)))
    dest = host / "mchost" / "cast" / _NONBMP_LEAF
    trunc = host / "mchost" / "cast" / "leaf-\U0001F642.tx"
    if dest.exists():
        if dest.read_bytes() != _SMILE_BODY:
            v.append("%s: non-BMP leaf bytes wrong" % label)
    else:
        v.append("%s: non-BMP leaf not installed" % label)
    if trunc.exists():
        v.append("%s: truncated sibling %s present" % (label, trunc.name))
    if not saw:
        v.append("%s: exact non-BMP UTF-16 ObjectName not observed" % label)
    return v


def _same_handle_violations(obs, host: Path, pre18: dict | None, label: str) -> list[str]:
    v = []
    val_oid = None
    write_oid = None
    for rec in obs.gen.recs.values():
        if rec.get("name") != "mc_host.py":
            continue
        acc = int(rec.get("access") or 0)
        if rec.get("muts"):
            write_oid = rec["open_id"]
        elif not (acc & (_GENERIC_WRITE | _FILE_WRITE_DATA)):
            qs = _successful_classes(rec)
            if 9 in qs and 1 in qs:
                val_oid = rec["open_id"]
    if write_oid is None:
        v.append("%s: no writing open_id for mc_host.py" % label)
        return v
    wrec = obs.gen.recs[write_oid]
    wq = _successful_classes(wrec)
    written_identity = None
    if 18 not in wq:
        v.append("FileIdInfo not queried on open_id %s (writing handle %s)" % (write_oid, label))
    else:
        written_identity = _parse_c18(wq[18]["data"])
    if val_oid is None:
        v.append("%s: no read-only validation open_id for mc_host.py" % label)
    elif val_oid != write_oid:
        v.append("%s: validate-close-reopen handle mismatch validation_open_id=%s writing_open_id=%s" % (
            label, val_oid, write_oid))
    if obs.rename_probe is not None and not obs.rename_probe.get("fired"):
        v.append("%s: reversible rename boundary not observed (closed validation handle expected)" % label)
    if any(e.get("hold_exists") for e in obs.rename_events):
        v.append("%s: holding name remained" % label)
    if (host / "mc_host.py").read_text(encoding="utf-8") != _HOST_BODY_NEW:
        v.append("%s: mc_host.py bytes not updated" % label)
    if written_identity and pre18:
        if written_identity["volume_serial"] != pre18["volume_serial"] or written_identity["file_id"] != pre18["file_id"]:
            v.append("%s: written_identity != snapshot identity" % label)
    return v


def _forbidden_extras(host: Path, cmp_root: Path, hold: Path | None) -> list[str]:
    v = []
    for root in (host, cmp_root):
        if not root.exists():
            continue
        for dirpath, _dirnames, filenames in os.walk(root, followlinks=False):
            for fn in filenames:
                if fn.startswith(_HOLD_PREFIX):
                    v.append("unexpected holding name %s" % (Path(dirpath) / fn))
    if hold is not None and hold.exists():
        v.append("holding name remains %s" % hold)
    return v


def _expected_success_tree(host: Path) -> list[str]:
    v = []
    checks = [
        (host / "mc_host.py", _HOST_BODY_NEW.encode("utf-8")),
        (host / "mchost" / "__init__.py", _INIT_NEW.encode("utf-8")),
        (host / "mchost" / "cast" / "backend.py", _BACKEND_NEW.encode("utf-8")),
        (host / "mchost" / "cast" / "probe.txt", _PROBE_BODY),
        (host / "mchost" / "cast" / _NONBMP_LEAF, _SMILE_BODY),
    ]
    for p, body in checks:
        if not p.is_file():
            v.append("missing expected %s" % p.name)
        elif p.read_bytes() != body:
            v.append("bytes mismatch %s" % p.name)
    return v


class _CaseDir:
    def __init__(self, owner: Path, name: str):
        self.root = Path(tempfile.mkdtemp(prefix="case_%s_" % name, dir=str(owner)))
        self.name = name
        self.zips = self.root / "zips"
        self.cfg = self.root / "cfg"
        self.work = self.root / "work"
        self.backups = self.root / "backups"
        self.cmp = self.root / "cmp"
        self.lex = self.root / "lex"
        self.host = None
        self.zpath = self.zips / "media-catcher-host-9.9.9.zip"
        self.junction = None
        self.hold = None
        for p in (self.zips, self.cfg, self.work, self.backups, self.cmp, self.lex):
            p.mkdir()
        _make_identity_zip(self.zpath)

    def close(self):
        if self.junction and self.junction.exists():
            try:
                os.rmdir(self.junction)
            except OSError:
                pass
        _rmtree(self.root)


def _block_pred_for(form: str, host_arg: str, case: _CaseDir):
    repaired = None
    try:
        repaired = os.path.abspath(host_arg)
    except OSError:
        repaired = None
    if form == "abs_unc":
        server, share, rest = _split_unc(host_arg.replace("/", "\\"))
        share_root = "\\\\%s\\%s" % (server, share)

        def pred(api, path, parent):
            if path is None:
                return None
            p = str(path).replace("/", "\\")
            if p.startswith("\\\\") or p.startswith("\\??\\") or p.startswith("\\\\?\\"):
                if os.path.normcase(p.rstrip("\\")) == os.path.normcase(share_root.rstrip("\\")):
                    return {"reason": "unc_share_root", "server": server, "share": share,
                            "rest": rest, "path": p, "api": api, "delegated": False}
                if os.path.normcase(p).startswith(os.path.normcase(share_root)):
                    return {"reason": "unc_below_or_above_share_root", "path": p, "api": api,
                            "server": server, "share": share, "rest": rest, "delegated": False}
                return {"reason": "unc_other", "path": p, "api": api, "delegated": False}
            return None
        return pred

    def pred(api, path, parent):
        if path is None:
            return None
        p = str(path)
        candidates = [host_arg]
        if repaired:
            candidates.append(repaired)
        for c in candidates:
            if os.path.normcase(p.rstrip("\\")) == os.path.normcase(str(c).rstrip("\\")):
                return {"reason": "host_authority_invalid_form", "form": form, "path": p,
                        "api": api, "delegated": False}
        if api == "CreateFileW" and (p.startswith("\\\\.\\") or p.startswith("\\\\?\\") or p.startswith("\\??\\")):
            return {"reason": "host_authority_device_or_nt", "form": form, "path": p, "api": api, "delegated": False}
        return None
    return pred


def _run_apply(mc, host_dir: str, zpath: Path, ext: Path):
    plan = {
        "ext_newer": False, "host_newer": True, "ext_zip": None,
        "host_zip": str(zpath), "ext_to": None, "host_to": "9.9.9",
    }
    rejected = False
    err = None
    try:
        mc.apply_update(plan, str(ext), host_dir)
    except Exception as e:
        rejected = True
        err = e
    return rejected, err


def _guardian_exe() -> str:
    found = shutil.which(PS)
    if not found:
        raise _HarnessError("powershell executable used by existing tests is missing")
    return found


def _guardian_argv(confpath: Path) -> list[str]:
    return [
        _guardian_exe(), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
        str(GUARDIAN), "-Config", str(confpath), "-NoUi", "-NoRestart",
    ]


def _write_guardian_cfg(case: _CaseDir, host_dir: str) -> Path:
    cfg = {
        "applyExt": False, "applyHost": True, "extZip": None, "hostZip": str(case.zpath),
        "extDir": str(case.work / "ext"), "hostDir": host_dir, "profileDir": "",
        "extId": "{id}", "expectExtVersion": None, "expectHostVersion": "9.9.9",
        "python": sys.executable, "firefox": "", "restart": False,
        "backupRoot": str(case.backups), "keep": 3,
    }
    confpath = case.cfg / "config.json"
    confpath.write_text(json.dumps(cfg), encoding="utf-8")
    return confpath


def _backup_happened(case: _CaseDir) -> bool:
    if not case.backups.exists():
        return False
    return any(p.is_dir() and (p / "state.json").exists() for p in case.backups.iterdir())


def _double_snap(root: Path):
    a = _tree_identity_snapshot(root)
    b = _tree_identity_snapshot(root)
    d = _snap_eq(a, b)
    if d:
        raise _HarnessError("unstable snapshot %s: %s" % (root, d[:4]))
    return a


_REQUIRED_CASES = (
    "ordinary", "ancestor_junction", "fault_c9_dest", "fault_c1_final", "fault_c18_root",
    "fault_c18_short", "id_zero_vol", "id_zero_fid", "id_dup", "id_vol_mismatch",
    "reparse_bit_tag0", "reparse_bit0_tag", "lex_abs", "lex_rel", "lex_drvrel", "lex_rootrel",
    "lex_dot", "lex_dotdot", "lex_empty", "lex_device", "lex_ext", "lex_nt", "lex_global",
    "lex_mal", "lex_unc_inc", "lex_unc", "same_handle",
)


def _run_identity_matrix(consumer: str) -> tuple[list[str], dict]:
    owner = Path(tempfile.mkdtemp(prefix="idc_%s_" % consumer))
    old_temp = os.environ.get("TEMP")
    old_tmp = os.environ.get("TMP")
    old_cwd = os.getcwd()
    matrix = []
    violations = []
    selftests = {}
    mc = None
    try:
        os.environ["TEMP"] = str(owner)
        os.environ["TMP"] = str(owner)
        selftests["py"] = _selftest_py_observer(owner / "st_py")
        selftests["dbg"] = _selftest_dbg_observer(owner / "st_dbg")
        if consumer == "apply":
            mc = load_host()
            if not hasattr(mc, "apply_update") or not hasattr(mc, "_k32"):
                raise _HarnessError("checked-out mc_host.py missing apply_update/_k32")

        def run_case(name, fn):
            case = _CaseDir(owner, name)
            try:
                info = fn(case) or {}
                info["case"] = name
                matrix.append(info)
                for item in info.get("violations") or []:
                    violations.append(str(item) if str(item).startswith(name) else "%s: %s" % (name, item))
            finally:
                case.close()

        def consume(obs, use_host, case):
            rejected = False
            err = None
            exit_code = None
            argv = None
            if consumer == "apply":
                obs.install(mc._k32, mc._ntdll)
                try:
                    rejected, err = _run_apply(mc, use_host, case.zpath, case.work / "ext")
                finally:
                    obs.uninstall()
                    if obs.harness_errors:
                        raise _HarnessError(obs.harness_errors[0])
            else:
                conf = _write_guardian_cfg(case, use_host)
                argv = _guardian_argv(conf)
                if "-NoUi" not in argv or "-NoRestart" not in argv:
                    raise _HarnessError("guardian argv missing -NoUi/-NoRestart")
                if argv[argv.index("-File") + 1] != str(GUARDIAN):
                    raise _HarnessError("guardian script path mismatch")
                env = os.environ.copy()
                env["TEMP"] = str(case.root)
                env["TMP"] = str(case.root)
                env["PYTHONDONTWRITEBYTECODE"] = "1"
                exit_code = obs.run(argv, env=env, cwd=str(case.work), timeout=180)
                rejected = exit_code not in (0, None)
                if obs.firefox_calls:
                    raise _HarnessError("firefox launched: %s" % obs.firefox_calls)
            return rejected, err, exit_code, argv

        def case_ordinary(case: _CaseDir, *, rename=False):
            host = case.root / "r1" / "r2" / "host"
            cmp_host = case.cmp / "r1" / "r2" / "host"
            _seed_host_tree(host)
            _seed_host_tree(cmp_host)
            case.host = host
            hold = case.root / "hold" / (_HOLD_PREFIX + case.name)
            hold.parent.mkdir(exist_ok=True)
            case.hold = hold
            before_host = _double_snap(host)
            before_cmp = _double_snap(case.cmp)
            pre18 = before_host["mc_host.py"]["class18"]
            obs = _PyNativeObserver() if consumer == "apply" else _DbgNativeObserver()
            if rename:
                obs.arm_rename(host, "mc_host.py", hold)
            rejected, err, exit_code, argv = consume(obs, str(host), case)
            after_host = _tree_identity_snapshot(host)
            after_cmp = _tree_identity_snapshot(case.cmp)
            v = []
            chain = _drive_chain(str(host))
            expected = [{"kind": "drive_root"}]
            for p in chain[1:-1]:
                expected.append({"kind": "abs", "path": p})
            expected.append({"kind": "abs", "path": str(host)})
            expected.append({"kind": "leaf", "leaf": "mchost"})
            expected.append({"kind": "leaf", "leaf": "cast"})
            expected.append({"kind": "leaf", "leaf": "mc_host.py"})
            expected.append({"kind": "leaf", "leaf": "probe.txt"})
            if not rename:
                v.extend(_coverage_violations(obs, expected, label="ordinary"))
                v.extend(_nonbmp_violations(obs, host, "ordinary"))
            if rejected:
                v.append("%s control rejected" % ("same-handle" if rename else "ordinary"))
            v.extend(_expected_success_tree(host))
            cd = _content_diffs(before_cmp, after_cmp)
            if cd:
                v.append("comparison root changed (%s)" % cd[0])
            if rename:
                v.extend(_same_handle_violations(obs, host, pre18, "same-handle"))
                v.extend(_forbidden_extras(host, case.cmp, hold))
            if any(rec.get("probe_stream") for rec in after_host.values()):
                v.append("probe stream present after update")
            if not obs.gen.lineage_parts(next(iter(obs.gen.recs), None)) and obs.gen.recs:
                v.append("lineage_parts empty with opens present")
            return {
                "violations": v, "rejected": rejected, "ran": True, "exit_code": exit_code,
                "err": None if err is None else type(err).__name__,
                "rename": list(obs.rename_events), "injected": list(obs.injected),
                "open_count": len(obs.gen.recs),
                "argv_noui": bool(argv and "-NoUi" in argv and "-NoRestart" in argv) if consumer == "guardian" else True,
                "script": str(GUARDIAN) if consumer == "guardian" else "apply_update",
                "backup": _backup_happened(case) if consumer == "guardian" else False,
            }

        def case_junction(case: _CaseDir):
            real = case.cmp / "ordinary-host"
            _seed_host_tree(real)
            jump = case.lex / "jump"
            _ps_new_junction(jump, case.cmp)
            case.junction = jump
            host = jump / "ordinary-host"
            jrec = _record_path(jump, "jump")
            if not jrec["reparse"] or jrec["reparse_tag"] == 0 or not jrec["reparse_target"]:
                raise _HarnessError("junction not proven")
            href = _record_path(host, "host")
            if href["reparse"]:
                raise _HarnessError("final hostDir is reparse")
            before_host = _double_snap(host)
            before_cmp = _double_snap(case.cmp)
            obs = _PyNativeObserver() if consumer == "apply" else _DbgNativeObserver()
            rejected, err, exit_code, argv = consume(obs, str(host), case)
            after_host = _tree_identity_snapshot(host)
            after_cmp = _tree_identity_snapshot(case.cmp)
            v = []
            if not rejected:
                v.append("ancestor junction: consumer did not reject")
            hd = _content_diffs(before_host, after_host)
            cd = _content_diffs(before_cmp, after_cmp)
            if hd:
                v.append("ancestor junction: host-root mutated (%s)" % hd[0])
            if cd:
                v.append("ancestor junction: comparison-root mutated (%s)" % cd[0])
            if consumer == "guardian" and _backup_happened(case) and not rejected:
                v.append("ancestor junction: backup/apply followed invalid host path")
            if _mutation_happened(obs) and not rejected:
                v.append("ancestor junction: mutation calls observed")
            return {"violations": v, "rejected": rejected, "ran": True, "exit_code": exit_code,
                    "junction_tag": jrec["reparse_tag"], "argv_noui": True}

        def case_fault(case: _CaseDir, sel, label):
            host = case.root / "r1" / "r2" / "host"
            cmp_host = case.cmp / "r1" / "r2" / "host"
            _seed_host_tree(host)
            _seed_host_tree(cmp_host)
            reach = _PyNativeObserver() if consumer == "apply" else _DbgNativeObserver()
            consume(reach, str(host), case)
            reachable = False
            for rec in reach.gen.recs.values():
                if sel.get("leaf") and rec.get("name") == sel["leaf"]:
                    qs = _successful_classes(rec)
                    if 9 in qs and 1 in qs:
                        reachable = True
                if sel.get("role") == "drive_root":
                    p = rec.get("path") or ""
                    if rec.get("api") == "CreateFileW" and len(p) == 3 and p.endswith("\\"):
                        reachable = True
            _rmtree(host)
            _rmtree(cmp_host)
            _seed_host_tree(host)
            _seed_host_tree(cmp_host)
            before_host = _double_snap(host)
            before_cmp = _double_snap(case.cmp)
            obs = _PyNativeObserver() if consumer == "apply" else _DbgNativeObserver()
            obs.arm_fault(sel)
            rejected, err, exit_code, argv = consume(obs, str(host), case)
            after_host = _tree_identity_snapshot(host)
            after_cmp = _tree_identity_snapshot(case.cmp)
            v = []
            hit = bool(obs.injected)
            if sel.get("cls") == 18 or sel.get("role") == "drive_root":
                if not hit:
                    v.append("FileIdInfo not queried on open_id (missing drive-root/ancestor/class-18) [%s]" % label)
            elif not hit:
                if reachable:
                    v.append("%s: fault selector not hit despite reachability" % label)
                else:
                    v.append("%s: required handle/query missing" % label)
            else:
                if not rejected:
                    v.append("%s: injected fault not rejected" % label)
                hd = _content_diffs(before_host, after_host)
                cd = _content_diffs(before_cmp, after_cmp)
                if hd:
                    v.append("%s: mutated after injected fault (%s)" % (label, hd[0]))
                if cd:
                    v.append("%s: comparison mutated (%s)" % (label, cd[0]))
            return {"violations": v, "ran": True, "injected": obs.injected, "reachable": reachable,
                    "rejected": rejected, "label": label, "argv_noui": True}

        def case_lex(case: _CaseDir, form, host_arg):
            host = case.root / "r1" / "r2" / "host"
            _seed_host_tree(host)
            cmp_host = case.cmp / "r1" / "r2" / "host"
            _seed_host_tree(cmp_host)
            os.chdir(str(case.root))
            before_host = _double_snap(host)
            before_cmp = _double_snap(case.cmp)
            obs = _PyNativeObserver() if consumer == "apply" else _DbgNativeObserver()
            if form != "abs_drive":
                obs.arm_block(_block_pred_for(form, host_arg, case))
            rejected, err, exit_code, argv = consume(obs, host_arg, case)
            os.chdir(old_cwd)
            after_host = _tree_identity_snapshot(host)
            after_cmp = _tree_identity_snapshot(case.cmp)
            v = []
            classified = _classify_hostdir(host_arg)
            if form == "abs_drive":
                if classified != "abs_drive":
                    raise _HarnessError("control form misclassified")
                if rejected:
                    v.append("lex abs_drive rejected")
            elif form == "abs_unc":
                if classified != "abs_unc":
                    v.append("complete UNC classified as %s" % classified)
                share_ok = any(b.get("reason") == "unc_share_root" for b in obs.blocked)
                below = any(b.get("reason") == "unc_below_or_above_share_root" for b in obs.blocked)
                if below and not share_ok:
                    v.append("UNC authority open below/above complete share root")
                if not obs.blocked:
                    v.append("UNC host-authority open not intercepted")
                if any(b.get("delegated") for b in obs.blocked):
                    v.append("UNC delegated to network")
            else:
                if classified in ("abs_drive", "abs_unc"):
                    v.append("invalid form %s classified accepted as %s" % (form, classified))
                if obs.blocked:
                    v.append("host-authority native open attempted for invalid form %s (%s)" % (
                        form, obs.blocked[0].get("path")))
                elif not rejected:
                    v.append("invalid form %s neither blocked nor rejected" % form)
            if form != "abs_drive":
                hd = _content_diffs(before_host, after_host)
                cd = _content_diffs(before_cmp, after_cmp)
                if hd:
                    v.append("lex %s mutated host (%s)" % (form, hd[0]))
                if cd:
                    v.append("lex %s mutated comparison (%s)" % (form, cd[0]))
            return {"violations": v, "ran": True, "form": form, "classified": classified,
                    "blocked": obs.blocked, "rejected": rejected, "argv_noui": True}

        run_case("ordinary", case_ordinary)
        run_case("ancestor_junction", case_junction)
        run_case("fault_c9_dest", lambda c: case_fault(c, {"leaf": "mchost", "cls": 9, "mode": "status"}, "class9 dest"))
        run_case("fault_c1_final", lambda c: case_fault(c, {"leaf": "mc_host.py", "cls": 1, "mode": "status"}, "class1 final"))
        run_case("fault_c18_root", lambda c: case_fault(c, {"role": "drive_root", "cls": 18, "mode": "status"}, "class18 root"))
        run_case("fault_c18_short", lambda c: case_fault(c, {
            "leaf": "mchost", "cls": 18, "mode": "data", "data": b"\x00" * 8, "supplied_length": 8,
        }, "class18 short"))
        zvol = struct.pack("<Q", 0) + bytes(range(1, 17))
        zfid = struct.pack("<Q", 0x1122334455667788) + (b"\x00" * 16)
        run_case("id_zero_vol", lambda c: case_fault(c, {
            "leaf": "mchost", "cls": 18, "mode": "data", "data": zvol, "supplied_length": 24,
        }, "zero volume"))
        run_case("id_zero_fid", lambda c: case_fault(c, {
            "leaf": "mchost", "cls": 18, "mode": "data", "data": zfid, "supplied_length": 24,
        }, "zero fileid"))
        dup = struct.pack("<Q", 0xAABBCCDDEEFF0011) + bytes(range(16, 32))
        run_case("id_dup", lambda c: case_fault(c, {
            "leaf": "mchost", "cls": 18, "mode": "data", "data": dup, "supplied_length": 24,
        }, "duplicate identity"))
        run_case("id_vol_mismatch", lambda c: case_fault(c, {
            "leaf": "cast", "cls": 18, "mode": "data",
            "data": struct.pack("<Q", 0x99) + bytes(range(32, 48)), "supplied_length": 24,
        }, "volume mismatch"))
        run_case("reparse_bit_tag0", lambda c: case_fault(c, {
            "leaf": "mchost", "cls": 9, "mode": "data",
            "data": struct.pack("<II", _FILE_ATTRIBUTE_DIRECTORY | _FILE_ATTRIBUTE_REPARSE_POINT, 0),
            "supplied_length": 8,
        }, "reparse bit tag0"))
        run_case("reparse_bit0_tag", lambda c: case_fault(c, {
            "leaf": "mchost", "cls": 9, "mode": "data",
            "data": struct.pack("<II", _FILE_ATTRIBUTE_DIRECTORY, _IO_REPARSE_TAG_MOUNT_POINT),
            "supplied_length": 8,
        }, "reparse bit0 tag"))
        run_case("lex_abs", lambda c: case_lex(c, "abs_drive", str(c.root / "r1" / "r2" / "host")))
        run_case("lex_rel", lambda c: case_lex(c, "relative", "r1\\r2\\host"))
        run_case("lex_drvrel", lambda c: case_lex(c, "drive_relative", os.path.splitdrive(str(c.root))[0] + "r1\\r2\\host"))
        run_case("lex_rootrel", lambda c: case_lex(c, "root_relative", os.path.splitdrive(str(c.root / "r1" / "r2" / "host"))[1]))
        run_case("lex_dot", lambda c: case_lex(c, "dot", str(c.root / "r1") + "\\.\\r2\\host"))
        run_case("lex_dotdot", lambda c: case_lex(c, "dotdot", str(c.root / "r1" / "r2") + "\\x\\..\\host"))
        run_case("lex_empty", lambda c: case_lex(c, "empty_component", str(c.root / "r1") + "\\\\r2\\host"))
        run_case("lex_device", lambda c: case_lex(c, "device", "\\\\.\\C:\\" + str(c.root / "r1" / "r2" / "host").split(":\\", 1)[-1]))
        run_case("lex_ext", lambda c: case_lex(c, "extended", "\\\\?\\" + str(c.root / "r1" / "r2" / "host")))
        run_case("lex_nt", lambda c: case_lex(c, "nt_namespace", "\\??\\" + str(c.root / "r1" / "r2" / "host")))
        run_case("lex_global", lambda c: case_lex(c, "global_root", "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\nope"))
        run_case("lex_mal", lambda c: case_lex(c, "malformed", "C::\\not-a-path"))
        run_case("lex_unc_inc", lambda c: case_lex(c, "incomplete_unc", "\\\\127.0.0.1"))
        run_case("lex_unc", lambda c: case_lex(c, "abs_unc", "\\\\127.0.0.1\\mcatcher-nonexistent-share\\host"))
        run_case("same_handle", lambda c: case_ordinary(c, rename=True))
        return violations, {"matrix": matrix, "selftests": selftests, "owner": str(owner)}
    finally:
        os.chdir(old_cwd)
        if old_temp is not None:
            os.environ["TEMP"] = old_temp
        if old_tmp is not None:
            os.environ["TMP"] = old_tmp
        _rmtree(owner)


def test_apply_update_rejects_unsafe_host_root_identity_chain():
    violations, meta = _run_identity_matrix("apply")
    if not meta["selftests"]["py"]["ok"] or not meta["selftests"]["dbg"]["ok"]:
        raise _HarnessError("observer self-test failed")
    ran = [m.get("case") for m in meta["matrix"]]
    for req in _REQUIRED_CASES:
        if req not in ran:
            violations.append("matrix case did not run: %s" % req)
    assert not violations, "apply_update identity-chain violations:\n- " + "\n- ".join(violations)


def test_guardian_rejects_unsafe_host_root_identity_chain_without_restart():
    violations, meta = _run_identity_matrix("guardian")
    if not meta["selftests"]["py"]["ok"] or not meta["selftests"]["dbg"]["ok"]:
        raise _HarnessError("observer self-test failed")
    ran = [m.get("case") for m in meta["matrix"]]
    for req in _REQUIRED_CASES:
        if req not in ran:
            violations.append("matrix case did not run: %s" % req)
    if not all(m.get("argv_noui", True) for m in meta["matrix"]):
        violations.append("guardian argv missing -NoUi/-NoRestart")
    if not meta["selftests"]["dbg"].get("layer"):
        violations.append("dbg layer filter unproven")
    assert not violations, "guardian identity-chain violations:\n- " + "\n- ".join(violations)








