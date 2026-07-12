# Media Catcher

A Firefox extension plus a native helper that detect, download, and record live
web video and HLS streams to real files on disk.

## Layout

- **`media-catcher/`** — the Firefox (MV2) extension: stream detection, the popup
  and options UI, and the recording controls.
- **`media-catcher-host/`** — the native messaging helper (Python) that drives
  ffmpeg to record and mux streams, plus the reliability guardian that applies,
  verifies, and reverts updates. See `media-catcher-host/installer/` for the
  packaged installer.

## Installing the helper

From `media-catcher-host/installer/`, either run the packaged installer
(`build.ps1` produces `dist/MediaCatcherHostSetup.exe`) or double-click
`Install Media Catcher Host.bat`. The installer installs Python and ffmpeg if they
are missing and registers the helper with Firefox. See
`media-catcher-host/installer/README.md` for details.

## Not committed here

`ffmpeg.exe` (the installer downloads it), build artifacts under `installer/dist/`,
and machine-specific generated files (`mc_config.json`, the native-messaging
manifest, and the launcher). See `.gitignore`.
