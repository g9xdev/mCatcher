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

A second, related hazard exists independently: the Inno `.iss` carries its own
file manifest. A new module added under `mchost/` but not added to the `.iss`
ships broken while working perfectly in any workflow that copies from the
working tree.

## Non-goals

- Replacing the end-user installer or `bootstrap.ps1`.
- Provisioning dependencies (Python, ffmpeg, Inno Setup). Those are already
  present on the developer machine; the script fails with a clear message
  rather than installing anything.
- Removing PowerShell from the project. That is a separate project (see
  *Future work*).
- Managing Firefox release channel installs. Only Developer Edition is touched.

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
| Dev profile | `%APPDATA%\Mozilla\Firefox\profiles.ini` → profile named `dev-edition-default` |
| XPI path | `<profile>\extensions\<extension-id>.xpi` |
| Host install dir | `HKCU\Software\Mozilla\NativeMessagingHosts\com.mediacatcher.host` → manifest `path` → dirname |

Each run re-derives all four and compares them against the pinned values in the
receipt. A moved profile or a re-registered host surfaces as an explicit
`target moved` failure instead of a silent install into the wrong place.

Fallback: if the registry key is absent, the host dir defaults to
`%LOCALAPPDATA%\MediaCatcher\Host`, and the run is marked `unregistered` in its
output so the condition is visible rather than assumed.

---

## Freshness model

Freshness is content-addressed. Version strings are never consulted.

- `extension.sourceSha256` — over `media-catcher/**`, file paths and contents,
  in sorted order.
- `host.sourceSha256` — over `media-catcher-host/*.py` and
  `media-catcher-host/mchost/**`, likewise.
- `host.files` — a per-file map, so a single changed module is identifiable.

The XPI is built deterministically: entries sorted, timestamps fixed. Identical
sources therefore always produce an identical `xpiSha256`, which makes the
artifact itself comparable rather than merely dated.

A run is a no-op when the source hashes match the receipt **and** the installed
files still match those hashes. Both halves are required: the first catches
"nothing changed", the second catches "something changed the install behind our
back".

Installing from a dirty worktree is allowed — it is the common case when trying
a change in the real app — and the receipt records `dirty: true` alongside the
commit SHA, so what is installed is always knowable.

---

## Run sequence

1. **Resolve** targets; compare against the receipt; fail on drift.
2. **Hash** extension and host sources.
3. **Short-circuit** if sources match the receipt and the installed files still
   match. Exit 0, change nothing.
4. **Build**
   - Extension: deterministic XPI from `media-catcher/`, `manifest.json` at root.
   - Host: locate `ISCC.exe` (PATH, then the three standard Inno Setup 6
     install directories) and compile `media-catcher-host.iss` into
     `installer/dist/MediaCatcherHostSetup.exe`. If the compiler is absent the
     run fails with a pointer to `build.ps1`, which provisions it — the script
     never falls back to copying files from the working tree, because that is
     precisely what would mask an incomplete `.iss` manifest.
5. **Close Firefox Developer Edition.** Graceful close first so session restore
   works; force-terminate only after a timeout. Filtered strictly on the
   Developer Edition executable path — the release channel is never touched.
6. **Install**
   - Extension: back up the existing XPI, then write the new one.
   - Host: run `MediaCatcherHostSetup.exe /VERYSILENT /SUPPRESSMSGBOXES
     /NORESTART /LOG=<temp>`; retain the log; check the exit code.
7. **Verify.** Re-hash what actually landed and compare against source. This is
   the step that fails today's scenario, and it doubles as a packaging check: a
   file present in source but absent from the install means the `.iss` manifest
   is incomplete.
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
    "sourceSha256": "…",
    "xpiSha256": "…"
  },
  "host": {
    "sourceSha256": "…",
    "files": { "mchost/downloads.py": "…", "mc_host.py": "…" }
  }
}
```

`version` is recorded for display only. It is never used to decide freshness.

---

## Interface

```
python devtools/install_dev.py --check     # read-only; report drift and staleness
python devtools/install_dev.py --install   # full deterministic update
python devtools/install_dev.py --install --launch
python devtools/install_dev.py --check --json
```

Flags: `--json` machine-readable output · `--launch` relaunch Dev Edition after
installing · `--adopt` permit installing into a profile that does not already
carry the extension.

Exit codes: `0` in sync or installed · `1` blocked, drifted, or verification
failed · `2` usage error.

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

- source hashing and the sorted-tree digest
- `profiles.ini` parsing, including multiple installs and missing dev-edition
- receipt diffing: unchanged, stale, and target-moved
- deterministic zip: identical sources produce byte-identical archives

The destructive operations — process enumeration and termination, file copy,
`ISCC` and installer invocation — sit behind injectable adapters so they are
exercised against fakes, following the `_ask_folder(default_dir, api=None)`
pattern already used in `downloads.py`. No test launches a browser or runs a
real installer.

---

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
