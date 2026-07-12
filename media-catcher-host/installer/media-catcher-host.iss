; Inno Setup script for the Media Catcher host.
; Produces a small, per-user setup.exe that downloads and installs the host's
; dependencies (Python 3, ffmpeg) and registers the native-messaging host with
; Firefox. The heavy dependencies are downloaded at install time, so the setup.exe
; itself stays small (the host is pure Python; ffmpeg is fetched by the bootstrap).
;
; Build:  powershell -ExecutionPolicy Bypass -File build.ps1
;   (build.ps1 installs Inno Setup via winget if needed, then compiles this file
;    into dist\MediaCatcherHostSetup.exe)

#define AppName "Media Catcher Host"
#define AppVersion "1.4.2"
#define AppPublisher "Media Catcher"
#define HostSrc "..\"

[Setup]
AppId={{7C4D9A20-3E5B-4F81-A6C2-9D1E0F2A3B4C}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\MediaCatcher\Host
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=lowest
OutputDir=dist
OutputBaseFilename=MediaCatcherHostSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\mc_host.py
ArchitecturesInstallIn64BitMode=x64compatible

[Files]
Source: "{#HostSrc}mc_host.py";   DestDir: "{app}"; Flags: ignoreversion
Source: "{#HostSrc}guardian.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#HostSrc}README.md";    DestDir: "{app}"; Flags: ignoreversion
Source: "bootstrap.ps1";          DestDir: "{app}"; Flags: ignoreversion

[Run]
; After files are copied, run the bootstrap in place: ensure Python + ffmpeg,
; write the launcher + native manifest, and register the host under HKCU.
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\bootstrap.ps1"" -InstallDir ""{app}"" -SourceDir ""{app}"""; \
  StatusMsg: "Installing dependencies (Python, ffmpeg) and registering with Firefox..."; \
  Flags: runhidden waituntilterminated

[UninstallRun]
; Unregister the native host and remove everything the bootstrap created
; (ffmpeg.exe, launcher, manifest) before Inno removes its own tracked files.
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\bootstrap.ps1"" -InstallDir ""{app}"" -Uninstall"; \
  Flags: runhidden waituntilterminated; RunOnceId: "UnregisterNativeHost"

[Messages]
FinishedLabel=The Media Catcher host is installed. Restart Firefox and Media Catcher will use it automatically.
