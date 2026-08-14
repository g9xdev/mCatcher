# Deterministic Developer Install Design

**Goal:** Make refreshing the developer machine's installed mCatcher a single
deterministic command that can never silently install stale or incomplete
artifacts, and that always records exactly what was installed and where.

**Audience:** the developer's own machine. End-user installation is unchanged
and remains the job of `media-catcher-host/installer/`.

---

## Problem

On 2026-08-14 the packaged host installer was built at 02:30, two further
commits then changed `mchost/downloads.py`, and the *stale* installer was run
hours later. The install reported success. Nothing detected the gap.

Two properties made it invisible:

- **The version string is not a freshness signal.** `VERSION` stayed `1.10.0`
  across the build, both later commits, and the install. Comparing versions —
  the obvious check — would have reported "already current".
- **Nothing compared installed bytes to source bytes.** The only evidence was a
  file timestamp, which is easy to misread and easy to ignore.

What is **not** a cause, despite an early draft of this spec claiming it was:
the `.iss` does not carry a hand-maintained file list. It recurses
(`Source: "{#HostSrc}mchost\*" … recursesubdirs createallsubdirs`), so a new
module ships automatically. The failure was a stale `setup.exe`, and forbidding
a working-tree copy would not have prevented it.

## Non-goals

- Replacing the end-user installer or `bootstrap.ps1`.
- Removing PowerShell from the project. That is a separate project (see
  *Future work*).
- Managing Firefox release channel installs. Only Developer Edition's profile
  is written.

### Accepted consequences, not non-goals

An earlier draft claimed this script provisions nothing and touches nothing
shared. Both were false, because the only supported host path runs the real
installer:

- `setup.exe` runs `bootstrap.ps1`, which may `winget install` Python and fetch
  ffmpeg, and which rewrites the single shared
  `HKCU\…\NativeMessagingHosts\com.mediacatcher.host` key used by every Firefox
  channel on the machine.
- Inno may prompt about, or close, applications holding target files.

These are accepted because using the real installer is the point. They are
recorded here so the spec does not claim a containment it does not have. The
script does not itself install dependencies, and fails with a clear message
when Inno Setup is missing.

---

## Components

| Piece | Location | Role |
|---|---|---|
| `install_dev.py` | `devtools/` (repo root) | Does the work. Python 3 stdlib only. |
| `mcatcher-build-install` | `.claude/skills/` | Thin skill: when to run it, how to read its JSON, what to do when it blocks. |
| `install-receipt.json` | `%LOCALAPPDATA%\MediaCatcher\` | Machine state. Deliberately outside the repo so it never dirties the worktree. |

`devtools/` sits at the repo root because the script spans both halves of the
product — the extension and the native host.

**No PowerShell in this tooling.** `ISCC.exe` is located and invoked directly
via `subprocess`; the registry is read with `winreg`; processes are enumerated
with `ctypes` (`CreateToolhelp32Snapshot` + `QueryFullProcessImageName`), behind
an injectable adapter in the same style as `_WinFolderApi` in `downloads.py`.

The packaged installer still runs `bootstrap.ps1` internally as its post-install
step. That is the shipping product's own behaviour and is out of scope here.

---

## Target resolution

Every target is derived from a source that is already authoritative, then
pinned into the receipt.

| Target | Derived from |
|---|---|
| Extension ID | `media-catcher/manifest.json` → `browser_specific_settings.gecko.id` |
| Dev profile | `%APPDATA%\Mozilla\Firefox\profiles.ini` — see precedence below |
| XPI path | `<profile>\extensions\<extension-id>.xpi` |
| Host install dir | `HKCU\Software\Mozilla\NativeMessagingHosts\com.mediacatcher.host` → manifest `path` → dirname |

### Dev profile precedence

`Name=dev-edition-default` is **not** reliably the profile Developer Edition
actually opened. `media-catcher-host/mchost/variant.py` already documents the
correct rule: *"Prefer an `[InstallXXChecksum]` Default (the profile the
last-used install opened)."* Precedence:

1. an explicitly supplied install key
2. an `[Install<hash>]` section's `Default=`, **accepted only when it resolves
   to a dev-edition profile**
3. a `[Profile N]` with `Name=dev-edition-default`
4. a `[Profile N]` whose directory ends `.dev-edition-default`

The qualifier on (2) matters: a machine with both channels installed has two
install sections, and taking the first can yield the *release* profile. Note
that `variant.find_profile()` takes the first unconditionally — a latent bug in
existing code, out of scope here but worth fixing separately.

`profiles.ini` is written with a UTF-8 BOM; the parser must strip it, or
`configparser` rejects the first section and the failure is silent.

### The install-directory mismatch guard

`setup.exe` sets `DefaultDirName={localappdata}\MediaCatcher\Host` with
`DisableDirPage=yes`, so it **always** writes there. But
`media-catcher-host/install.ps1` registers `$HostDir = $PSScriptRoot` — the
repository folder — so a dev-registered machine has Firefox launching the host
from the repo while `setup.exe` updates LocalAppData.

Running the installer would then leave the bytes Firefox actually loads
untouched, while verification passed against whichever directory it checked.
The script therefore compares the registry-derived host
directory against the installer's fixed target and **refuses to install** when
they differ, naming both paths, rather than performing an install that cannot
affect what Firefox runs.

Each run re-derives all four and compares them against the pinned values in the
receipt. A moved profile or a re-registered host surfaces as an explicit
`target moved` failure instead of a silent install into the wrong place.

Fallback: if the registry key is absent, the host dir defaults to
`%LOCALAPPDATA%\MediaCatcher\Host`, and the run is marked `unregistered` in its
output so the condition is visible rather than assumed.

---

## Freshness model

Freshness is content-addressed, and the unit of comparison is **the built
artifact, never the source tree**. Version strings are never consulted.

Comparing installed files against the source tree cannot work, for two reasons
found in review:

- The source tree is not the ship set. `media-catcher-host/` contains
  `conftest.py`, every `test_*.py`, and `__pycache__`, none of which are ever
  installed. A rule requiring each source file to be present in the install can
  never pass.
- Any allowlist added to make that rule pass would be a second ship manifest —
  the exact duplication content hashing was supposed to remove.

Each component therefore builds an artifact, and the artifact is what both
freshness and verification are measured against.

### The two artifacts

**Extension — the XPI.** Built deterministically from the extension ship set —
`media-catcher/` excluding `tests/` and `.vscode/` — with entries sorted and
timestamps fixed, so identical sources always produce a byte-identical archive.
The installed file *is* an XPI, so verification is a single hash equality.

Excluding `tests/` matters for more than package hygiene: under an
"everything" ship set an ordinary test edit marks the extension stale, and an
`--install` would then close Firefox for a change that cannot affect it.

**Host — the declared ship set.** Inno reads the live tree
(`#define HostSrc "..\\"`), so no staging copy is what `setup.exe` installs. The
authority is therefore the `.iss` `[Files]` declaration itself:

```
mc_host.py, guardian.ps1, README.md, bootstrap.ps1
mchost/**  (excluding __pycache__ directories and *.pyc)
```

`devtools/ship_set.py` derives that set, and a test asserts it matches the
`.iss` declaration — see
`2026-08-14-packaging-ship-set-reconciliation-design.md`, which is a
prerequisite for this design. Verification hashes each declared file in the
install directory against the same file in the working tree.

Note that `release.yml`'s host zip deliberately omits `bootstrap.ps1`; it is a
different artifact serving self-update, and is not what this script verifies.

Verification compares the **install directory** against the working tree, file
by file, over the declared set only. Files in the install directory that are not
declared — `ffmpeg.exe`, `yt-dlp.exe`, `mc_host.bat`, the native-messaging
`.json` — are ignored; they are provisioned, not shipped.

A run is a no-op when the freshly built artifact hashes match the receipt
**and** the installed files still match those artifact hashes. Both halves are
required: the first catches "nothing changed", the second catches "something
changed the install behind our back".

Building the artifact is therefore part of `--check`, not only `--install`.
That is what makes the check honest — it compares what current sources *would*
produce against what is installed, rather than trusting a recorded hash. The
staging step is a file copy and the XPI a zip, so the cost is small; the Inno
compile is deferred to `--install`, since the installer is not what
verification compares against.

### Per-component independence

The extension and the native host are tracked, reported, and updated
**independently**. Each resolves to one of `in-sync`, `stale`, `missing`, or
`target-moved`, and `--check` always reports both — never a single combined
verdict, which would let a fresh extension mask a stale host (the 2026-08-14
failure had exactly that shape: the extension was current, the host was not).

`--install` rebuilds and reinstalls only the components that are not `in-sync`,
and reports the state of both when it finishes. Firefox Developer Edition is
closed only when at least one component actually needs installing, so a no-op
run never disturbs a running browser.

Installing from a dirty worktree is allowed — it is the common case when trying
a change in the real app — and the receipt records `dirty: true` alongside the
commit SHA, so what is installed is always knowable.

---

## Run sequence

1. **Resolve** targets; compare against the receipt; fail on drift.
2. **Hash** the declared ship sets: the extension XPI built from its ship set, and each declared host file.
3. **Short-circuit** if sources match the receipt and the installed files still
   match. Exit 0, change nothing.
4. **Build**
   - Extension: deterministic XPI from `media-catcher/`, `manifest.json` at root.
   - Host: locate `ISCC.exe` (PATH, then the three standard Inno Setup 6
     install directories) and compile `media-catcher-host.iss` into
     `installer/dist/MediaCatcherHostSetup.exe`. If the compiler is absent the
     run fails with a pointer to `build.ps1`, which provisions it. The script
     never falls back to copying files from the working tree: the installer
     also performs registration and the bootstrap step, which a copy would
     skip.
5. **Close Firefox Developer Edition.** Graceful close first so session restore
   works; force-terminate only after a timeout. Filtered strictly on the
   Developer Edition executable path — the release channel is never touched.
6. **Install**
   - Extension: back up the existing XPI, then write the new one.
   - Host: run `MediaCatcherHostSetup.exe /VERYSILENT /SUPPRESSMSGBOXES
     /NORESTART /LOG=<temp>`; retain the log; check the exit code.
7. **Verify against the artifact.**
   - Extension: `sha256(installed .xpi) == sha256(built .xpi)`.
   - Host: for every file in the declared ship set, the installed file at the
     same relative path must exist and hash equal to the working-tree file.
     Files present in the install directory but not declared — `ffmpeg.exe`,
     `yt-dlp.exe`, `mc_host.bat`, the native-messaging `.json` — are
     **ignored**; they are provisioned, not shipped.

   This is the step that fails the 2026-08-14 scenario. It is also the only
   real file-level check available: Inno's `[Run]` step does not fail Setup
   when `bootstrap.ps1` exits non-zero, so `setup.exe`'s exit code confirms the
   installer ran, not that the right bytes landed.
8. **Write the receipt.** Relaunch Developer Edition when `--launch` is given.

On verification failure the extension backup is restored and the run exits
non-zero. The host install is not rolled back — the installer owns that
directory — but the failure is reported with the offending file list.

---

## Receipt schema

```json
{
  "schema": 1,
  "installedAt": "2026-08-14T10:52:00Z",
  "commit": "069cb55",
  "dirty": true,
  "targets": {
    "extensionId": "{27383706-fb43-40dc-9e94-d2578818bd6a}",
    "devProfile": "C:\\Users\\add\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\2eydftv7.dev-edition-default",
    "xpiPath": "...\\extensions\\{27383706-fb43-40dc-9e94-d2578818bd6a}.xpi",
    "hostDir": "C:\\Users\\add\\AppData\\Local\\MediaCatcher\\Host"
  },
  "extension": {
    "version": "1.10.0",
    "xpiSha256": "…"
  },
  "host": {
    "shipSetSha256": "…",
    "files": { "mchost/downloads.py": "…", "guardian.ps1": "…" }
  }
}
```

`version` is recorded for display only. It is never used to decide freshness.
Every recorded hash is an **artifact** hash, not a source-tree hash.

---

## Interface

```
python devtools/install_dev.py --check     # no installs; per-component verdicts
python devtools/install_dev.py --install   # update whichever components are stale
python devtools/install_dev.py --install --launch
python devtools/install_dev.py --check --json
```

`--check` example output:

```
extension  in-sync   1.10.0  source c4f1…  installed c4f1…
host       STALE             source 9ab7…  installed 2d10…
                             mchost/downloads.py differs
=> 1 component needs installing; run with --install
```

Flags: `--json` machine-readable output · `--launch` relaunch Dev Edition after
installing · `--adopt` permit installing into a profile that does not already
carry the extension.

Exit codes: `0` every component in sync (or successfully installed) · `1` at
least one component stale, drifted, or failed verification · `2` usage error.

`--check` returning `1` is the scriptable signal that an install is needed; it
is not an error condition.

`--check` does not modify the machine, but it is not free of writes: it builds
the XPI in order to compare what current sources *would* produce against what is
installed. That build goes to a temporary directory, never to the profile or the
install directory. The Inno compile is not run by `--check`.

---

## Safety

- **Release Firefox is never touched.** Process selection matches on the
  Developer Edition executable path, not on the image name `firefox.exe`.
- **Prefs are never modified.** `xpinstall.signatures.required` is already
  `false` in the dev profile. If it is ever `true`, the script reports and stops
  rather than changing a security setting.
- **Wrong-profile guard.** The script refuses a profile that does not already
  contain the extension unless `--adopt` is passed, so a fresh or unrelated
  profile is never populated by accident.
- **The previous XPI is backed up** before being replaced, and restored if
  verification fails.

---

## Testing

Pure logic is unit-tested under the existing pytest layout with no new
dependencies:

- artifact hashing and the sorted-tree digest
- `profiles.ini` parsing, including multiple installs and missing dev-edition
- receipt diffing: unchanged, stale, and target-moved
- deterministic zip: identical sources produce byte-identical archives
- per-component verdicts, including the case that motivated them: extension
  `in-sync` while host is `stale` must report stale and exit non-zero, and must
  install the host without reinstalling the extension

The destructive operations — process enumeration and termination, file copy,
`ISCC` and installer invocation — sit behind injectable adapters so they are
exercised against fakes, following the `_ask_folder(default_dir, api=None)`
pattern already used in `downloads.py`. No test launches a browser or runs a
real installer.

---

## Prerequisite

`2026-08-14-packaging-ship-set-reconciliation-design.md` must land first. It
gives the host a single declared ship set kept honest by test, and gives the
extension one that excludes tests and editor config. Without it there is no
authoritative answer for verification to compare against.

## Future work

Removing PowerShell from the project is a separate effort spanning roughly 696
lines across six files, and it reaches beyond tooling into runtime:
`guardian.ps1` (spawned by `mc_host.py` for self-update), `bootstrap.ps1` (run
by the `.iss`), the generated `mc_restart.ps1`, plus `updates.py` health checks
and the `options.js` diagnostics UI that report PowerShell and `guardian.ps1`
presence to the user. It warrants its own spec and decomposition.

This design is unaffected by that work. `install_dev.py` invokes `ISCC.exe` and
the built `setup.exe`; if `bootstrap.ps1` is later reimplemented in Python, only
the `.iss` changes.
