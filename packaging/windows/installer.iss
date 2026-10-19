; Per-user install. Data stays in %LOCALAPPDATA%\ArtNet Lightshow across updates and uninstall.
; CI passes /DAppVersion, /DSourceDir and /DOutputDir to ISCC.exe.

#define AppName "Tyclab Lightshow"
#define AppExe "Tyclab Lightshow.exe"
#ifndef AppVersion
  #error Pass /DAppVersion=<version>
#endif
#ifndef SourceDir
  #error Pass /DSourceDir=<the package folder scripts/package.js made>
#endif
#ifndef OutputDir
  #define OutputDir "."
#endif

[Setup]
; Never change: it is how Windows knows an update from another program.
AppId={{814CF9FC-1830-4C6D-90C1-35FB9F07305F}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Tyclab
AppPublisherURL=https://github.com/tyclab/artnet-lightshow
AppSupportURL=https://github.com/tyclab/artnet-lightshow/issues
DefaultDirName={autopf}\{#AppName}
UsePreviousAppDir=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog commandline
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
LicenseFile={#SourceDir}\app\LICENSE
SetupIconFile={#SourceDir}\app\public\favicon.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
OutputDir={#OutputDir}
OutputBaseFilename=Tyclab-Lightshow-{#AppVersion}-win32-x64-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; A running copy holds its files: ask to close it (it blacks the rig out as it goes).
CloseApplications=yes

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[InstallDelete]
; An update replaces the app outright, so nothing of the old version's
; node_modules lingers. The data is elsewhere and untouched.
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\tools"
; Remove old branding when upgrading an existing install with the same AppId.
Type: files; Name: "{app}\ArtNet Lightshow.exe"
Type: files; Name: "{autoprograms}\ArtNet Lightshow.lnk"
Type: files; Name: "{autodesktop}\ArtNet Lightshow.lnk"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Excludes: "\portable,\data"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent
