# Media Catcher host installer

This installer sets up the Media Catcher native helper on Windows. It installs the
host's dependencies and registers the host with Firefox, so the extension can drive
recordings.

## What it installs

- **Python 3** — the host is a Python script. The installer installs Python with
  winget if no Python is found, and falls back to the official python.org installer.
- **ffmpeg** — the host uses ffmpeg to record and mux streams. The installer
  downloads a static build and places `ffmpeg.exe` next to the host. Nothing large
  ships inside the installer itself; ffmpeg is fetched at install time.
- **The host files** — `mc_host.py`, `guardian.ps1`, and the launcher, copied to
  `%LOCALAPPDATA%\MediaCatcher\Host`.
- **The native-messaging registration** — a manifest plus a registry value under
  `HKCU\Software\Mozilla\NativeMessagingHosts\com.mediacatcher.host`, which is how
  Firefox finds and launches the host. No administrator rights are required.

## Three ways to install

1. **The packaged installer (recommended for end users).**
   Build it once, then run `dist\MediaCatcherHostSetup.exe`.
   ```
   powershell -ExecutionPolicy Bypass -File build.ps1
   ```
   `build.ps1` installs Inno Setup with winget if the compiler is missing, then
   compiles `media-catcher-host.iss` into `dist\MediaCatcherHostSetup.exe` (about
   2 MB). The setup program installs per-user and downloads Python and ffmpeg as
   needed during installation.

2. **The double-click batch file (installs from this folder).**
   Run `Install Media Catcher Host.bat`. It runs `bootstrap.ps1`, which performs the
   same dependency install and registration without building a setup.exe.

3. **The bootstrap script directly (for scripting or CI).**
   ```
   powershell -ExecutionPolicy Bypass -File bootstrap.ps1
   ```
   Useful switches: `-InstallDir <path>`, `-SkipPython`, `-SkipFfmpeg`,
   `-RegRoot <registry path>` (for testing against a sandbox key), and `-Uninstall`.

## Uninstall

Run `Uninstall Media Catcher Host.bat`, or:
```
powershell -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\MediaCatcher\Host\bootstrap.ps1" -Uninstall
```
The packaged installer also adds a normal entry under Windows "Apps & features."
Uninstalling removes the registry key and the install directory, including the
downloaded ffmpeg.

## Note for developers

Installing points Firefox at `%LOCALAPPDATA%\MediaCatcher\Host`, not at the
development folder. If you are editing the host in `C:\Code\mCatcher\media-catcher-host` and
want Firefox to run your edits, either keep the original dev-folder registration
(the repo's `install.ps1`) or re-run the installer after each change. The two
registrations use the same host name, so the most recent install wins.

## Files

- `bootstrap.ps1` — the dependency install and native-host registration logic. Runs
  standalone and as the setup program's post-install step.
- `media-catcher-host.iss` — the Inno Setup script that produces `setup.exe`.
- `build.ps1` — installs Inno Setup if needed, then compiles the setup program.
- `Install Media Catcher Host.bat` / `Uninstall Media Catcher Host.bat` — double-click entry points.
