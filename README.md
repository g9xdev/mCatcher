# Media Catcher

[![Latest release](https://img.shields.io/github/v/release/g9xdev/mCatcher?label=latest%20release&color=e69a3a)](https://github.com/g9xdev/mCatcher/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/g9xdev/mCatcher/total?color=3fd68f)](https://github.com/g9xdev/mCatcher/releases)
[![Build](https://img.shields.io/github/actions/workflow/status/g9xdev/mCatcher/release.yml?label=build)](https://github.com/g9xdev/mCatcher/actions)

A Firefox extension plus a native helper that detect, download, and record live
web video and HLS streams to real files on disk.

### ⬇ [Download the latest release](https://github.com/g9xdev/mCatcher/releases/latest)

Grab the signed **`media_catcher-*.xpi`** (drag into Firefox) and the one-click
**[`MediaCatcherHostSetup.exe`](https://github.com/g9xdev/mCatcher/releases/latest/download/MediaCatcherHostSetup.exe)**
helper installer. Installed builds then [update themselves](#releases--auto-update).

## Layout

- **`media-catcher/`** — the Firefox (MV2) extension: stream detection, the popup
  and options UI, and the recording controls.
- **`media-catcher-host/`** — the native messaging helper (Python) that drives
  ffmpeg to record and mux streams, plus the reliability guardian that applies,
  verifies, and reverts updates. See `media-catcher-host/installer/` for the
  packaged installer.

## Install (regular Firefox)

No Developer/Nightly build required — the extension is AMO-signed. Two parts:

1. **Extension** — from the [latest release](https://github.com/g9xdev/mCatcher/releases/latest),
   download the signed `media_catcher-<version>.xpi`. In Firefox, drag the `.xpi`
   onto a window (or open `about:addons` → the gear → **Install Add-on From File…**)
   and confirm.
2. **Helper** — from the same release, run `MediaCatcherHostSetup.exe`. It installs
   Python + ffmpeg if they are missing and registers the recorder with Firefox.

Restart Firefox and Media Catcher is ready.

> Developers who load the extension from source instead should use the
> `media_catcher-<version>.zip` source package with a Developer/Nightly build; see
> `media-catcher-host/installer/`.

## Installing the helper

From `media-catcher-host/installer/`, either run the packaged installer
(`build.ps1` produces `dist/MediaCatcherHostSetup.exe`) or double-click
`Install Media Catcher Host.bat`. The installer installs Python and ffmpeg if they
are missing and registers the helper with Firefox. See
`media-catcher-host/installer/README.md` for details.

## Releases & auto-update

Tag a version to publish a release:

```
git tag v1.4.0
git push origin v1.4.0
```

The **Release** GitHub Action (`.github/workflows/release.yml`) then builds and
attaches three assets to the release:

- `media_catcher-<version>.zip` — the extension package
- `media-catcher-host-<version>.zip` — the native host package
- `MediaCatcherHostSetup.exe` — the one-click host installer (downloads Python +
  ffmpeg, registers the helper with Firefox)

New users install with the `.exe`. Existing installs update themselves: the host
checks GitHub Releases (on Firefox startup, and every few hours while auto-update is
on), downloads the new packages into the watched folder, and the reliability guardian
applies, verifies, and reverts on failure — restarting Firefox with your tabs intact.

You can also build manually from the **Actions** tab (**Release → Run workflow**) by
entering a version.

## Not committed here

`ffmpeg.exe` (the installer downloads it), build artifacts under `installer/dist/`,
and machine-specific generated files (`mc_config.json`, the native-messaging
manifest, and the launcher). See `.gitignore`.
