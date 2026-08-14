# Packaging Ship-Set Reconciliation Design

**Goal:** Give each shipped artifact exactly one definition of what it contains,
enforced by test, so a verifier can compare installed bytes against something
authoritative.

**Why now:** the deterministic developer install design
(`2026-08-14-deterministic-dev-install-design.md`) is blocked on this. Two
review rounds each failed for the same underlying reason — there was no single
answer to "what ships", so every verification compared against one of several
disagreeing definitions.

---

## Problem

### Host: three definitions, all different

| Source | Ship set |
|---|---|
| `media-catcher-host/installer/media-catcher-host.iss` | `mc_host.py`, `guardian.ps1`, `README.md`, `bootstrap.ps1`, `mchost/**` (minus `__pycache__`, `*.pyc`) |
| `.github/workflows/release.yml` staging | the same **minus `bootstrap.ps1`** |
| `devtools/install_dev.py` `HOST_SHIP_SET` | `mc_host.py`, `mchost/**` — missing `guardian.ps1` and `README.md` |

The third is simply wrong: editing `guardian.ps1`, which `mc_host.py` spawns for
self-update, would leave the host reported `in-sync`.

The first two differ **legitimately**. They are different artifacts:
`setup.exe` installs `bootstrap.ps1` because uninstall runs it
(`Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\bootstrap.ps1"" -InstallDir ""{app}"" -Uninstall"`),
whereas `release.yml`'s zip feeds in-app self-update, which only replaces
runtime files. Forcing them identical would be a mistake.

The install verifier compares the **installed directory**, so its authority is
the `.iss` and nothing else.

### Extension: the ship set is "everything"

`release.yml` packages the extension with
`Compress-Archive -Path 'media-catcher/*'`, and `media-catcher/` contains a
38-file `tests/` directory and a 3-file `.vscode/` directory. Both ship to
users today — 41 files with no runtime purpose, confirmed against the built
package (83 entries).

This also breaks freshness: under an "everything" ship set, editing a test
marks the extension stale, which under the install design would close Firefox.

---

## Non-goals

- Changing `release.yml`'s **host** zip. Its narrower set is correct for
  self-update. (See *Known gaps* for one consequence.)
- Restructuring the `.iss` to build from a staging tree. Considered and
  rejected: `#define HostSrc "..\"` means a build that forgot to stage would
  ship `conftest.py` and every host test. Enforcing by construction makes the
  unstaged build worse than it is today.
- Building the developer install script. That is the other spec.

---

## Design

### Host — the `.iss` is authoritative, agreement is tested

The `.iss` keeps its explicit list and its safe default. Nothing about the
installer changes.

`devtools/ship_set.py` exposes one function returning the host ship set as
relative paths, and `devtools/install_dev.py` consumes it instead of its own
`HOST_SHIP_SET`.

A new test parses the `.iss` `[Files]` section and asserts the two agree:

```python
def test_ship_set_matches_iss_declaration():
    declared = parse_iss_files("media-catcher-host/installer/media-catcher-host.iss")
    derived  = host_ship_set("media-catcher-host")
    assert derived == declared
```

The parser resolves `{#HostSrc}`, treats a `Source:` without it as relative to
the installer directory, expands a trailing `\*` with `recursesubdirs` as a
recursive glob, and honours `Excludes:`. It is deliberately narrow — it
understands only the five `Source:` forms this `.iss` actually uses, and raises
on anything else rather than guessing. A new `Source:` line the parser does not
recognise is a test failure, which is the intended behaviour.

Adding a runtime file to the installer without adding it to the ship set — or
the reverse — now fails a test instead of silently producing an install the
verifier cannot check.

### Extension — an explicit ship set, excluding tests and editor config

`devtools/ship_set.py` also exposes the extension ship set: everything under
`media-catcher/` except `tests/` and `.vscode/`.

Two consumers change:

- `devtools/install_dev.py` builds the XPI from it (replacing
  `EXTENSION_SHIP_SET = ("**",)`).
- `.github/workflows/release.yml` packages from it rather than
  `media-catcher/*`.

This is a real change to what users receive and lands as its own reviewable
commit, separate from the tooling.

A test asserts the built XPI contains `manifest.json` at its root and contains
no `tests/` or `.vscode/` entry.

---

## Testing

New tests, in the existing pytest layout, no new dependencies:

- `.iss` parsing: each `Source:` form this file uses; an unrecognised form
  raises rather than being skipped
- host ship set equals the `.iss` declaration
- host ship set contains `guardian.ps1` — the regression that motivated this
- extension ship set excludes `tests/` and `.vscode/` and includes
  `manifest.json`
- the built XPI contains no test file and no editor config

Existing `media-catcher-host/test_packaging_runtime_layout.py` continues to
guard `release.yml`'s host staging and the recursive `mchost` layout. Nothing
it asserts changes.

---

## Known gaps, recorded not fixed

- **`bootstrap.ps1` is never refreshed by self-update.** It is installed by
  `setup.exe` and invoked at uninstall, but `release.yml`'s update zip omits
  it, so a changed `bootstrap.ps1` reaches users only via a fresh install.
  Real, pre-existing, and out of scope here.
- **`variant.find_profile()` takes the first `[Install…]` section
  unconditionally**, which on a machine with both Firefox channels can resolve
  to the release profile.
- Both dissolve or change shape if the PowerShell-removal project proceeds.

---

## Effect on the install design

Once this lands, `install_dev.py` verifies the installed host directory against
the `.iss`-derived ship set — a set that is authoritative by declaration and
kept honest by test — and builds the XPI from a ship set that excludes tests,
so ordinary test edits no longer mark the extension stale.

The install spec's "staging tree is the host artifact" claim is withdrawn: Inno
reads the live tree (`#define HostSrc "..\"`), so no staging copy is what
`setup.exe` installs. Verification compares the install against the declared
ship set instead.
