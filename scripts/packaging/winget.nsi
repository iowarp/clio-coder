Unicode true
!include "FileFunc.nsh"
RequestExecutionLevel user
Name "Clio Coder"
!ifndef OUTPUT
!define OUTPUT "clio-coder-${VERSION}-win-x64.exe"
!endif
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\clio-coder-winget"

; Build locally with makensis -DVERSION=... -DPACKAGE=... -DNODE_ZIP=... -DNODE_SUMS=... -DNODE_ZIP_NAME=node-v24.x.y-win-x64.zip winget.nsi.
; The package and Node archive must be local qualified artifacts. install.ps1 verifies Node's checksum.
Section "Install"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=install.ps1 "..\install.ps1"
  File /oname=package.tgz "${PACKAGE}"
  File "${NODE_ZIP}"
  File /oname=SHASUMS256.txt "${NODE_SUMS}"
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/NoPath" $R1
  IfErrors path_default path_optout
  path_default:
  StrCpy $R2 "-AddToPath"
  Goto path_selected
  path_optout:
  StrCpy $R2 "-NoModifyPath"
  path_selected:
  System::Call 'kernel32::SetEnvironmentVariableW(w "CLIO_CODER_INSTALL_MANAGER", w "winget")' 
  ExecWait 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\install.ps1" -Package "$PLUGINSDIR\package.tgz" -NodeZip "$PLUGINSDIR\${NODE_ZIP_NAME}" -InstallDir "$INSTDIR\install" -BinDir "$INSTDIR\bin" -NoAutoUpdate $R2 -NoPostInstall' $0
  StrCmp $0 0 +3
    SetErrorLevel $0
    Abort
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClioCoder" "DisplayName" "Clio Coder"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClioCoder" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClioCoder" "UninstallString" '"$INSTDIR\uninstall.exe"'
SectionEnd

Section "Uninstall"
  System::Call 'kernel32::SetEnvironmentVariableW(w "CLIO_CODER_MANAGER_UNINSTALL", w "1")'
  ExecWait '"$SYSDIR\cmd.exe" /d /c ""$INSTDIR\bin\clio-coder.cmd" uninstall --remove-binary --force --keep-config --keep-data"' $0
  StrCmp $0 0 +3
    SetErrorLevel $0
    Abort
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClioCoder"
  Delete "$INSTDIR\uninstall.exe"
  StrCpy $1 0
  cleanup:
  Sleep 1000
  IntOp $1 $1 + 1
  IfFileExists "$INSTDIR\install\install.json" 0 cleanup_done
  IntCmp $1 40 cleanup_done cleanup cleanup_done
  cleanup_done:
  RMDir "$INSTDIR\bin"
  RMDir "$INSTDIR"
SectionEnd
