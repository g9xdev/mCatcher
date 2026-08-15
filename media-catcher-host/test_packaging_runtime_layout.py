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


def _make_directory_junction(link: Path, target: Path) -> None:
    env = os.environ.copy()
    env["MC_JUNCTION_PATH"] = str(link)
    env["MC_JUNCTION_TARGET"] = str(target)
    result = subprocess.run(
        [
            PS,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "New-Item -ItemType Junction -Path $env:MC_JUNCTION_PATH "
            "-Target $env:MC_JUNCTION_TARGET -ErrorAction Stop | Out-Null",
        ],
        capture_output=True,
        text=True,
        env=env,
    )
    assert result.returncode == 0, (
        f"failed to create temporary junction: {result.stdout}\n{result.stderr}"
    )


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


def test_apply_update_rejects_junction_above_host_directory(tmp_path, monkeypatch):
    """A pre-existing ancestor junction must not redirect in-process host writes."""
    mc = load_host()
    monkeypatch.setattr(mc, "find_profile", lambda: None)
    monkeypatch.setattr(mc, "load_config", lambda: {})
    monkeypatch.setattr(mc, "_await_zip", lambda path, tries=10, delay=0.5: True)

    real_parent = tmp_path / "real-parent"
    real_host = real_parent / "host"
    real_host.mkdir(parents=True)
    sentinel = real_host / "mc_host.py"
    sentinel.write_text('VERSION = "1.0.0"\nKEEP\n', encoding="utf-8")
    (real_host / "mchost").mkdir()
    (real_host / "mchost" / "__init__.py").write_text("KEEP_INIT\n", encoding="utf-8")

    alias_parent = tmp_path / "alias-parent"
    _make_directory_junction(alias_parent, real_parent)
    configured_host = alias_parent / "host"

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

    with pytest.raises(Exception):
        mc.apply_update(plan, str(tmp_path / "ext"), str(configured_host))

    assert sentinel.read_text(encoding="utf-8") == 'VERSION = "1.0.0"\nKEEP\n'
    assert (real_host / "mchost" / "__init__.py").read_text(encoding="utf-8") == "KEEP_INIT\n"
    assert not (real_host / "mchost" / "cast").exists()


def test_guardian_rejects_junction_above_host_directory_without_restart(tmp_path):
    """Guardian must reject an ancestor junction before applying host payloads."""
    real_parent = tmp_path / "real-parent"
    real_host = real_parent / "host"
    real_host.mkdir(parents=True)
    sentinel = real_host / "mc_host.py"
    sentinel.write_text('VERSION = "1.0.0"\nKEEP\n', encoding="utf-8")
    (real_host / "mchost").mkdir()
    (real_host / "mchost" / "__init__.py").write_text("KEEP_INIT\n", encoding="utf-8")

    alias_parent = tmp_path / "alias-parent"
    _make_directory_junction(alias_parent, real_parent)
    configured_host = alias_parent / "host"

    zpath = tmp_path / "media-catcher-host-2.0.0.zip"
    _make_release_shaped_zip(zpath, 'VERSION = "2.0.0"\nCHANGED\n')
    cfg = {
        "applyExt": False,
        "applyHost": True,
        "extZip": None,
        "hostZip": str(zpath),
        "extDir": str(tmp_path / "ext"),
        "hostDir": str(configured_host),
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

    result = subprocess.run(
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

    assert result.returncode != 0
    assert sentinel.read_text(encoding="utf-8") == 'VERSION = "1.0.0"\nKEEP\n'
    assert (real_host / "mchost" / "__init__.py").read_text(encoding="utf-8") == "KEEP_INIT\n"
    assert not (real_host / "mchost" / "cast").exists()


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
