; FyAgent custom NSIS template.
; Upstream: tauri-apps/tauri tauri-cli-v2.8.1
; Commit: 662b39adb33d1d26f0de213e5a04fc4116fd0683
; Upstream SHA-256: fe22026f68bdb3292fab376756035496ce0a35e3d580e06ebaa6a28295916eb3
; The reviewed delta is limited to unified FyAgent installer branding, one
; frozen v0.3.0 MSI migration, removal of user-data deletion, and bounded
; known-only cleanup.

Unicode true
; An unknown shell-variable token is ignored after warning 6000, which can
; redirect fixed installer or cleanup paths. Treat it as a packaging failure.
!pragma warning error 6000
ManifestDPIAware true
; Add in `dpiAwareness` `PerMonitorV2` to manifest for Windows 10 1607+ (note this should not affect lower versions since they should be able to ignore this and pick up `dpiAware` `true` set by `ManifestDPIAware true`)
; Currently undocumented on NSIS's website but is in the Docs folder of source tree, see
; https://github.com/kichik/nsis/blob/5fc0b87b819a9eec006df4967d08e522ddd651c9/Docs/src/attributes.but#L286-L300
; https://github.com/tauri-apps/tauri/pull/10106
ManifestDPIAwareness PerMonitorV2

!if "{{compression}}" == "none"
  SetCompress off
!else
  ; Set the compression algorithm. We default to LZMA.
  SetCompressor /SOLID "{{compression}}"
!endif

!include MUI2.nsh
!include FileFunc.nsh
!include x64.nsh
!include WordFunc.nsh
!include "utils.nsh"
!include "FileAssociation.nsh"
!include "Win\COM.nsh"
!include "Win\Propkey.nsh"

{{#if installer_hooks}}
!include "{{installer_hooks}}"
{{/if}}

!define WEBVIEW2APPGUID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

!define MANUFACTURER "{{manufacturer}}"
!define PRODUCTNAME "{{product_name}}"
!define VERSION "{{version}}"
!define VERSIONWITHBUILD "{{version_with_build}}"
!define HOMEPAGE "{{homepage}}"
!define INSTALLMODE "{{install_mode}}"
!define LICENSE "{{license}}"
!define INSTALLERICON "{{installer_icon}}"
!define SIDEBARIMAGE "{{sidebar_image}}"
!define HEADERIMAGE "{{header_image}}"
!define MAINBINARYNAME "{{main_binary_name}}"
!define MAINBINARYSRCPATH "{{main_binary_path}}"
!define BUNDLEID "{{bundle_id}}"
!define COPYRIGHT "{{copyright}}"
!define OUTFILE "{{out_file}}"
!define ARCH "{{arch}}"
!define ADDITIONALPLUGINSPATH "{{additional_plugins_path}}"
!define ALLOWDOWNGRADES "{{allow_downgrades}}"
!define DISPLAYLANGUAGESELECTOR "{{display_language_selector}}"
!define INSTALLWEBVIEW2MODE "{{install_webview2_mode}}"
!define WEBVIEW2INSTALLERARGS "{{webview2_installer_args}}"
!define WEBVIEW2BOOTSTRAPPERPATH "{{webview2_bootstrapper_path}}"
!define WEBVIEW2INSTALLERPATH "{{webview2_installer_path}}"
!define MINIMUMWEBVIEW2VERSION "{{minimum_webview2_version}}"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}"
!define MANUKEY "Software\${MANUFACTURER}"
!define MANUPRODUCTKEY "${MANUKEY}\${PRODUCTNAME}"
!define UNINSTALLERSIGNCOMMAND "{{uninstaller_sign_cmd}}"
!define ESTIMATEDSIZE "{{estimated_size}}"
!define STARTMENUFOLDER "{{start_menu_folder}}"
!define FYAGENT_FILE_ATTRIBUTE_DIRECTORY 0x10
!define FYAGENT_FILE_ATTRIBUTE_REPARSE_POINT 0x400
!define FYAGENT_DELETE 0x00010000
!define FYAGENT_FILE_READ_ATTRIBUTES 0x80
!define FYAGENT_FILE_SHARE_READ 0x1
!define FYAGENT_FILE_SHARE_WRITE 0x2
!define FYAGENT_OPEN_EXISTING 3
!define FYAGENT_INVALID_HANDLE_VALUE -1
!define FYAGENT_FILE_FLAG_BACKUP_SEMANTICS 0x02000000
!define FYAGENT_FILE_FLAG_OPEN_REPARSE_POINT 0x00200000
!define FYAGENT_BY_HANDLE_FILE_INFORMATION_SIZE 52
!define FYAGENT_FILE_DISPOSITION_INFO_CLASS 4
!define FYAGENT_FILE_DISPOSITION_INFO_SIZE 1
!define FYAGENT_OBJ_CASE_INSENSITIVE 0x40
!define FYAGENT_OBJ_DONT_REPARSE 0x1000
!define FYAGENT_FILE_OPEN 0x1
!define FYAGENT_FILE_DIRECTORY_FILE 0x1
!define FYAGENT_FILE_NON_DIRECTORY_FILE 0x40
!define FYAGENT_NSIS_SYSTEM_POINTER_SIZE 4
!define FYAGENT_UNICODE_STRING_SIZE 8
!define FYAGENT_UNICODE_STRING_BUFFER_OFFSET 4
!define FYAGENT_OBJECT_ATTRIBUTES_SIZE 24
!define FYAGENT_OBJECT_ATTRIBUTES_ROOT_DIRECTORY_OFFSET 4
!define FYAGENT_IO_STATUS_BLOCK_SIZE 8
!define FYAGENT_LEGACY_WIX_REGISTRY_KEY "Software\fyagent\FyAgent"
!define FYAGENT_INSTALLSTATE_UNKNOWN -1
!define FYAGENT_MSI_SUCCESS 0
!define FYAGENT_MSI_UNKNOWN_PRODUCT 1605
!define FYAGENT_MSI_PRODUCT_UNINSTALLED 1614
!define FYAGENT_MSI_REBOOT_REQUIRED 3010
!if "${ARCH}" == "x64"
  !define FYAGENT_LEGACY_WIX_PRODUCT_CODE "{D50D8CE2-B49A-41DE-839D-6574FB69ADC1}"
!else if "${ARCH}" == "arm64"
  !define FYAGENT_LEGACY_WIX_PRODUCT_CODE "{78F69296-A73D-40CA-A2BA-11D117AA2C9B}"
!else
  !error "FyAgent's frozen v0.3.0 MSI migration supports only x64 and arm64"
!endif

Var PassiveMode
Var UpdateMode
Var NoShortcutMode
Var OldMainBinaryName
Var LegacyWixInstallDir
Var FyAgentUpdateProcessRetries

; Never force-terminate a process that may own an admitted installer job or its
; verified package handle. Interactive users may close it normally and retry;
; passive/silent callers fail before any migration, cleanup, or payload write.
; Keep this definition above PageLeaveReinstall, its first expansion site.
!macro FyAgentRequireProcessStopped ExecutableName DisplayName Label
  StrCpy $FyAgentUpdateProcessRetries 0
  fyagent_${Label}_process_retry:
    !if "${INSTALLMODE}" == "currentUser"
      nsis_tauri_utils::FindProcessCurrentUser "${ExecutableName}"
    !else
      nsis_tauri_utils::FindProcess "${ExecutableName}"
    !endif
    Pop $R0
    ${If} $R0 = 0
      ; The updater starts NSIS before its parent process exits. Only /UPDATE
      ; waits for that ordering window: 20 x 250ms, then the normal safe abort.
      ; Ordinary install/uninstall remains immediate and never terminates a PID.
      ${If} $UpdateMode = 1
      ${AndIf} $FyAgentUpdateProcessRetries < 20
        IntOp $FyAgentUpdateProcessRetries $FyAgentUpdateProcessRetries + 1
        Sleep 250
        Goto fyagent_${Label}_process_retry
      ${EndIf}
      IfSilent fyagent_${Label}_process_silent fyagent_${Label}_process_interactive

      fyagent_${Label}_process_interactive:
        ${If} $PassiveMode = 1
          Goto fyagent_${Label}_process_silent
        ${EndIf}
        MessageBox MB_ICONEXCLAMATION|MB_RETRYCANCEL "Close ${DisplayName} normally before continuing. Choose Retry after it has exited." IDRETRY fyagent_${Label}_process_retry IDCANCEL fyagent_${Label}_process_cancel

      fyagent_${Label}_process_cancel:
        Abort "${DisplayName} is still running. No installer changes were made."

      fyagent_${Label}_process_silent:
        Abort "${DisplayName} is running. Close it normally, then run setup again."
    ${EndIf}
!macroend

Name "${PRODUCTNAME}"
BrandingText "${COPYRIGHT}"
OutFile "${OUTFILE}"

; We don't actually use this value as default install path,
; it's just for nsis to append the product name folder in the directory selector
; https://nsis.sourceforge.io/Reference/InstallDir
!define PLACEHOLDER_INSTALL_DIR "placeholder\${PRODUCTNAME}"
InstallDir "${PLACEHOLDER_INSTALL_DIR}"

VIProductVersion "${VERSIONWITHBUILD}"
VIAddVersionKey "ProductName" "${PRODUCTNAME}"
VIAddVersionKey "FileDescription" "${PRODUCTNAME}"
VIAddVersionKey "LegalCopyright" "${COPYRIGHT}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

# additional plugins
!addplugindir "${ADDITIONALPLUGINSPATH}"

; Uninstaller signing command
!if "${UNINSTALLERSIGNCOMMAND}" != ""
  !uninstfinalize '${UNINSTALLERSIGNCOMMAND}'
!endif

; Handle install mode, `perUser`, `perMachine` or `both`
!if "${INSTALLMODE}" == "perMachine"
  RequestExecutionLevel admin
!endif

!if "${INSTALLMODE}" == "currentUser"
  RequestExecutionLevel user
!endif

!if "${INSTALLMODE}" == "both"
  !define MULTIUSER_MUI
  !define MULTIUSER_INSTALLMODE_INSTDIR "${PRODUCTNAME}"
  !define MULTIUSER_INSTALLMODE_COMMANDLINE
  !if "${ARCH}" == "x64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !else if "${ARCH}" == "arm64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !endif
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_KEY "${UNINSTKEY}"
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_VALUENAME "CurrentUser"
  !define MULTIUSER_INSTALLMODEPAGE_SHOWUSERNAME
  !define MULTIUSER_INSTALLMODE_FUNCTION RestorePreviousInstallLocation
  !define MULTIUSER_EXECUTIONLEVEL Highest
  !include MultiUser.nsh
!endif

; Installer icon
!if "${INSTALLERICON}" != ""
  !define MUI_ICON "${INSTALLERICON}"
  !define MUI_UNICON "${INSTALLERICON}"
!endif

; Installer sidebar image
!if "${SIDEBARIMAGE}" != ""
  !define MUI_WELCOMEFINISHPAGE_BITMAP "${SIDEBARIMAGE}"
!endif

; Installer header image
!if "${HEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE
  !define MUI_HEADERIMAGE_BITMAP  "${HEADERIMAGE}"
!endif

; Define registry key to store installer language
!define MUI_LANGDLL_REGISTRY_ROOT "HKCU"
!define MUI_LANGDLL_REGISTRY_KEY "${MANUPRODUCTKEY}"
!define MUI_LANGDLL_REGISTRY_VALUENAME "Installer Language"

; Installer pages, must be ordered as they appear
; 1. Welcome Page
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_WELCOME

; 2. License Page (if defined)
!if "${LICENSE}" != ""
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !insertmacro MUI_PAGE_LICENSE "${LICENSE}"
!endif

; 3. Install mode (if it is set to `both`)
!if "${INSTALLMODE}" == "both"
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !insertmacro MULTIUSER_PAGE_INSTALLMODE
!endif

; 4. Custom page to ask user if he wants to reinstall/uninstall
;    only if a previous installation was detected
Var ReinstallPageCheck
Page custom PageReinstall PageLeaveReinstall
Function PageReinstall
  ; Check if there is an existing installation, if not, abort the reinstall page
  ReadRegStr $R0 SHCTX "${UNINSTKEY}" ""
  ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
  ${IfThen} "$R0$R1" == "" ${|} Abort ${|}

  ; Compare this installer version with the existing NSIS installation
  ; and modify the messages presented to the user accordingly
  StrCpy $R4 "$(older)"
  ReadRegStr $R0 SHCTX "${UNINSTKEY}" "DisplayVersion"
  ${IfThen} $R0 == "" ${|} StrCpy $R4 "$(unknown)" ${|}

  nsis_tauri_utils::SemverCompare "${VERSION}" $R0
  Pop $R0
  ; Reinstalling the same version
  ${If} $R0 = 0
    StrCpy $R1 "$(alreadyInstalledLong)"
    StrCpy $R2 "$(addOrReinstall)"
    StrCpy $R3 "$(uninstallApp)"
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$(chooseMaintenanceOption)"
  ; Upgrading
  ${ElseIf} $R0 = 1
    StrCpy $R1 "$(olderOrUnknownVersionInstalled)"
    StrCpy $R2 "$(uninstallBeforeInstalling)"
    StrCpy $R3 "$(dontUninstall)"
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$(choowHowToInstall)"
  ; Downgrading
  ${ElseIf} $R0 = -1
    StrCpy $R1 "$(newerVersionInstalled)"
    StrCpy $R2 "$(uninstallBeforeInstalling)"
    !if "${ALLOWDOWNGRADES}" == "true"
      StrCpy $R3 "$(dontUninstall)"
    !else
      StrCpy $R3 "$(dontUninstallDowngrade)"
    !endif
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$(choowHowToInstall)"
  ${Else}
    Abort
  ${EndIf}

  ; Skip showing the page if passive
  ;
  ; Note that we don't call this earlier at the begining
  ; of this function because we need to populate some variables
  ; related to current installed version if detected and whether
  ; we are downgrading or not.
  ${If} $PassiveMode = 1
    Call PageLeaveReinstall
  ${Else}
    nsDialogs::Create 1018
    Pop $R4
    ${IfThen} $(^RTL) = 1 ${|} nsDialogs::SetRTL $(^RTL) ${|}

    ${NSD_CreateLabel} 0 0 100% 24u $R1
    Pop $R1

    ${NSD_CreateRadioButton} 30u 50u -30u 8u $R2
    Pop $R2
    ${NSD_OnClick} $R2 PageReinstallUpdateSelection

    ${NSD_CreateRadioButton} 30u 70u -30u 8u $R3
    Pop $R3
    ; Disable this radio button if downgrading and downgrades are disabled
    !if "${ALLOWDOWNGRADES}" == "false"
      ${IfThen} $R0 = -1 ${|} EnableWindow $R3 0 ${|}
    !endif
    ${NSD_OnClick} $R3 PageReinstallUpdateSelection

    ; Check the first radio button if this the first time
    ; we enter this page or if the second button wasn't
    ; selected the last time we were on this page
    ${If} $ReinstallPageCheck <> 2
      SendMessage $R2 ${BM_SETCHECK} ${BST_CHECKED} 0
    ${Else}
      SendMessage $R3 ${BM_SETCHECK} ${BST_CHECKED} 0
    ${EndIf}

    ${NSD_SetFocus} $R2
    nsDialogs::Show
  ${EndIf}
FunctionEnd
Function PageReinstallUpdateSelection
  ${NSD_GetState} $R2 $R1
  ${If} $R1 == ${BST_CHECKED}
    StrCpy $ReinstallPageCheck 1
  ${Else}
    StrCpy $ReinstallPageCheck 2
  ${EndIf}
FunctionEnd
Function PageLeaveReinstall
  ${NSD_GetState} $R2 $R1

  ; In update mode, always proceeds without uninstalling
  ${If} $UpdateMode = 1
    Goto reinst_done
  ${EndIf}

  ; $R0 holds whether same(0)/upgrading(1)/downgrading(-1) version
  ; $R1 holds the radio buttons state:
  ;   1 => first choice was selected
  ;   0 => second choice was selected
  ${If} $R0 = 0 ; Same version, proceed
    ${If} $R1 = 1              ; User chose to add/reinstall
      Goto reinst_done
    ${Else}                    ; User chose to uninstall
      Goto reinst_uninstall
    ${EndIf}
  ${ElseIf} $R0 = 1 ; Upgrading
    ${If} $R1 = 1              ; User chose to uninstall
      Goto reinst_uninstall
    ${Else}
      Goto reinst_done         ; User chose NOT to uninstall
    ${EndIf}
  ${ElseIf} $R0 = -1 ; Downgrading
    ${If} $R1 = 1              ; User chose to uninstall
      Goto reinst_uninstall
    ${Else}
      Goto reinst_done         ; User chose NOT to uninstall
    ${EndIf}
  ${EndIf}

  reinst_uninstall:
    !insertmacro FyAgentRequireProcessStopped "${MAINBINARYNAME}.exe" "${PRODUCTNAME}" maintenance_main
    !insertmacro FyAgentRequireProcessStopped "fyagent-user-helper.exe" "${PRODUCTNAME} user helper" maintenance_helper
    HideWindow
    ClearErrors

    ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""
    ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
    ${IfThen} $UpdateMode = 1 ${|} StrCpy $R1 "$R1 /UPDATE" ${|} ; append /UPDATE
    ${IfThen} $PassiveMode = 1 ${|} StrCpy $R1 "$R1 /P" ${|} ; append /P
    StrCpy $R1 "$R1 _?=$4" ; append uninstall directory
    ExecWait '$R1' $0

    BringToFront

    ${IfThen} ${Errors} ${|} StrCpy $0 2 ${|} ; ExecWait failed, set fake exit code

    ${If} $0 <> 0
    ${OrIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
      ; User cancelled NSIS uninstaller? return to select un/reinstall page
      ${If} $0 = 1
        Abort
      ${EndIf}

      ; Other erros? show generic error message and return to select un/reinstall page
      MessageBox MB_ICONEXCLAMATION "$(unableToUninstall)"
      Abort
    ${EndIf}
  reinst_done:
FunctionEnd

; 5. Choose install directory page
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_DIRECTORY

; 6. Start menu shortcut page
Var AppStartMenuFolder
!if "${STARTMENUFOLDER}" != ""
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !define MUI_STARTMENUPAGE_DEFAULTFOLDER "${STARTMENUFOLDER}"
!else
  !define MUI_PAGE_CUSTOMFUNCTION_PRE Skip
!endif
!insertmacro MUI_PAGE_STARTMENU Application $AppStartMenuFolder

; 7. Installation page
!insertmacro MUI_PAGE_INSTFILES

; 8. Finish page
;
; Don't auto jump to finish page after installation page,
; because the installation page has useful info that can be used debug any issues with the installer.
!define MUI_FINISHPAGE_NOAUTOCLOSE
; Use show readme button in the finish page as a button create a desktop shortcut
!define MUI_FINISHPAGE_SHOWREADME
!define MUI_FINISHPAGE_SHOWREADME_TEXT "$(createDesktop)"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateOrUpdateDesktopShortcut
; Show run app after installation.
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION RunMainBinary
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_FINISH

Function RunMainBinary
  nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
FunctionEnd

; Uninstaller Pages
; 1. Confirm uninstall page
!define MUI_PAGE_CUSTOMFUNCTION_PRE un.SkipIfPassive
!insertmacro MUI_UNPAGE_CONFIRM

; 2. Uninstalling Page
!insertmacro MUI_UNPAGE_INSTFILES

;Languages
{{#each languages}}
!insertmacro MUI_LANGUAGE "{{this}}"
{{/each}}
!insertmacro MUI_RESERVEFILE_LANGDLL
{{#each language_files}}
  !include "{{this}}"
{{/each}}

Function .onInit
  ; Tauri ships an x86 NSIS launcher even for native x64/ARM64 payloads. Keep
  ; every per-machine registration in the native 64-bit view on both targets.
  SetRegView 64

  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/NS" $NoShortcutMode
  ${IfNot} ${Errors}
    StrCpy $NoShortcutMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}

  !if "${DISPLAYLANGUAGESELECTOR}" == "true"
    !insertmacro MUI_LANGDLL_DISPLAY
  !endif

  !insertmacro SetContext

  ; Capture the fixed v0.3.0 MSI marker before its uninstaller can remove it.
  ; An explicit /D= value has already replaced the placeholder and stays first.
  StrCpy $LegacyWixInstallDir ""
  ReadRegStr $LegacyWixInstallDir HKLM "${FYAGENT_LEGACY_WIX_REGISTRY_KEY}" "InstallDir"
  ClearErrors

  ${If} $INSTDIR == "${PLACEHOLDER_INSTALL_DIR}"
    ; Set default install location
    !if "${INSTALLMODE}" == "perMachine"
      ${If} ${RunningX64}
        !if "${ARCH}" == "x64"
          StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
        !else if "${ARCH}" == "arm64"
          StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
        !else
          StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
        !endif
      ${Else}
        StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
      ${EndIf}
    !else if "${INSTALLMODE}" == "currentUser"
      StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"
    !endif

    Call RestorePreviousInstallLocation
  ${EndIf}


  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_INIT
  !endif
FunctionEnd

; The public v0.3.0 MSI is the only retired package migrated here. Querying the
; frozen architecture-specific ProductCode avoids starting Windows Installer on
; fresh or same-version NSIS installs. A registered MSI must be synchronously
; removed before this installer creates or overwrites any payload path.
Function FyAgentMigrateLegacyWixInstall
  System::Call '"$SYSDIR\msi.dll"::MsiQueryProductStateW(w "${FYAGENT_LEGACY_WIX_PRODUCT_CODE}") i .r0'
  ${If} $0 == ${FYAGENT_INSTALLSTATE_UNKNOWN}
    Goto fyagent_legacy_wix_migration_accepted
  ${EndIf}

  ClearErrors
  ExecWait '"$SYSDIR\msiexec.exe" /x ${FYAGENT_LEGACY_WIX_PRODUCT_CODE} /qn /norestart' $0
  ${If} ${Errors}
    MessageBox MB_ICONSTOP|MB_OK "FyAgent Setup could not start Windows Installer to remove the previous FyAgent version. No files were changed."
    Abort "Close other installers and run FyAgent Setup again."
  ${EndIf}

  ${If} $0 == ${FYAGENT_MSI_SUCCESS}
  ${OrIf} $0 == ${FYAGENT_MSI_UNKNOWN_PRODUCT}
  ${OrIf} $0 == ${FYAGENT_MSI_PRODUCT_UNINSTALLED}
    Goto fyagent_legacy_wix_migration_accepted
  ${EndIf}

  ${If} $0 == ${FYAGENT_MSI_REBOOT_REQUIRED}
    MessageBox MB_ICONSTOP|MB_OK "The previous FyAgent version requires a Windows restart to finish uninstalling. Restart Windows, then run FyAgent Setup again. No new files were installed."
    Abort "Restart Windows before installing FyAgent."
  ${EndIf}

  MessageBox MB_ICONSTOP|MB_OK "FyAgent Setup could not remove the previous FyAgent version (Windows Installer code $0). No new files were installed."
  Abort "Resolve the previous uninstall error, then run FyAgent Setup again."

  fyagent_legacy_wix_migration_accepted:
    DeleteRegValue HKLM "${FYAGENT_LEGACY_WIX_REGISTRY_KEY}" "InstallDir"
    ClearErrors
FunctionEnd

; A fixed top-level cleanup directory is the only full-path capability lookup.
; Every descendant is opened relative to this held, validated anchor handle.
!macro FyAgentOpenCleanupAnchorDirectory Path Label OutputHandle ValidFlag
  StrCpy ${OutputHandle} 0
  StrCpy ${ValidFlag} 0
  System::Call 'kernel32::CreateFileW(w "${Path}", i ${FYAGENT_DELETE}|${FYAGENT_FILE_READ_ATTRIBUTES}, i ${FYAGENT_FILE_SHARE_READ}, p 0, i ${FYAGENT_OPEN_EXISTING}, i ${FYAGENT_FILE_FLAG_BACKUP_SEMANTICS}|${FYAGENT_FILE_FLAG_OPEN_REPARSE_POINT}, p 0) p .r8'
  ${If} $8 == ${FYAGENT_INVALID_HANDLE_VALUE}
  ${OrIf} $8 == 0
    Goto fyagent_${Label}_done
  ${EndIf}

  System::Alloc ${FYAGENT_BY_HANDLE_FILE_INFORMATION_SIZE}
  Pop $6
  ${If} $6 == 0
    Goto fyagent_${Label}_close
  ${EndIf}
  System::Call 'kernel32::GetFileInformationByHandle(p r8, p r6) i .r7'
  ${If} $7 == 0
    System::Free $6
    Goto fyagent_${Label}_close
  ${EndIf}
  System::Call '*$6(i .r0)'
  System::Free $6
  IntOp $4 $0 & ${FYAGENT_FILE_ATTRIBUTE_DIRECTORY}
  ${If} $4 == 0
    Goto fyagent_${Label}_close
  ${EndIf}
  IntOp $4 $0 & ${FYAGENT_FILE_ATTRIBUTE_REPARSE_POINT}
  ${If} $4 <> 0
    Goto fyagent_${Label}_close
  ${EndIf}

  StrCpy ${OutputHandle} $8
  StrCpy ${ValidFlag} 1
  Goto fyagent_${Label}_done

  fyagent_${Label}_close:
    System::Call 'kernel32::CloseHandle(p r8) i .r4'

  fyagent_${Label}_done:
!macroend

; Tauri's NSIS control process and x86-unicode System plug-in remain PE32 for
; x64 and ARM64 payloads. Lowercase System fields are packed, so measure their
; 32-bit sizes and verify both pointer offsets before crossing the native ABI.
!macro FyAgentOpenDirectoryRelativeToHandle ParentSystemRegister ParentHandle RelativeName Label OutputHandle ValidFlag
  StrCpy ${OutputHandle} 0
  StrCpy ${ValidFlag} 0
  StrCpy $8 0
  StrCpy $6 0
  StrCpy $7 0
  StrCpy $4 0
  StrCpy $0 0
  StrCpy $2 -1

  StrLen $R2 "${RelativeName}"
  ${If} $R2 == 0
    Goto fyagent_${Label}_directory_done
  ${EndIf}
  IntOp $R2 $R2 * 2
  IntOp $R5 $R2 + 2
  System::Call '*(&w${NSIS_MAX_STRLEN} "${RelativeName}") p .r6'
  ${If} $6 == 0
    Goto fyagent_${Label}_directory_native_buffers_done
  ${EndIf}
  System::Call '*(&i2 R2, &i2 R5, p r6, &l.R3) p .r7'
  ${If} $7 == 0
  ${OrIf} $R3 <> ${FYAGENT_UNICODE_STRING_SIZE}
    Goto fyagent_${Label}_directory_native_buffers_done
  ${EndIf}
  IntOp $R4 $7 + ${FYAGENT_UNICODE_STRING_BUFFER_OFFSET}
  System::Call '*$R4(p .R7)'
  ${If} $R7 != $6
    Goto fyagent_${Label}_directory_native_buffers_done
  ${EndIf}
  System::Call '*(&l4, p ${ParentSystemRegister}, p r7, i ${FYAGENT_OBJ_CASE_INSENSITIVE}|${FYAGENT_OBJ_DONT_REPARSE}, p 0, p 0, &l.R3) p .r4'
  ${If} $4 == 0
  ${OrIf} $R3 <> ${FYAGENT_OBJECT_ATTRIBUTES_SIZE}
    Goto fyagent_${Label}_directory_native_buffers_done
  ${EndIf}
  IntOp $R4 $4 + ${FYAGENT_OBJECT_ATTRIBUTES_ROOT_DIRECTORY_OFFSET}
  System::Call '*$R4(p .R7)'
  ${If} $R7 != ${ParentHandle}
    Goto fyagent_${Label}_directory_native_buffers_done
  ${EndIf}
  System::Call '*(p 0, p 0, &l.R3) p .r0'
  ${If} $0 == 0
  ${OrIf} $R3 <> ${FYAGENT_IO_STATUS_BLOCK_SIZE}
    Goto fyagent_${Label}_directory_native_buffers_done
  ${EndIf}
  System::Call 'ntdll::NtCreateFile(*p .r8, i ${FYAGENT_DELETE}|${FYAGENT_FILE_READ_ATTRIBUTES}, p r4, p r0, p 0, i 0, i ${FYAGENT_FILE_SHARE_READ}, i ${FYAGENT_FILE_OPEN}, i ${FYAGENT_FILE_DIRECTORY_FILE}|${FYAGENT_FILE_FLAG_OPEN_REPARSE_POINT}, p 0, i 0) i .r2'

  fyagent_${Label}_directory_native_buffers_done:
    ${If} $0 <> 0
      System::Free $0
    ${EndIf}
    ${If} $4 <> 0
      System::Free $4
    ${EndIf}
    ${If} $7 <> 0
      System::Free $7
    ${EndIf}
    ${If} $6 <> 0
      System::Free $6
    ${EndIf}

  ${If} $2 <> 0
    Goto fyagent_${Label}_directory_done
  ${EndIf}
  ${If} $8 == ${FYAGENT_INVALID_HANDLE_VALUE}
  ${OrIf} $8 == 0
    Goto fyagent_${Label}_directory_done
  ${EndIf}

  System::Alloc ${FYAGENT_BY_HANDLE_FILE_INFORMATION_SIZE}
  Pop $6
  ${If} $6 == 0
    Goto fyagent_${Label}_directory_close
  ${EndIf}
  System::Call 'kernel32::GetFileInformationByHandle(p r8, p r6) i .r7'
  ${If} $7 == 0
    System::Free $6
    Goto fyagent_${Label}_directory_close
  ${EndIf}
  System::Call '*$6(i .r0)'
  System::Free $6
  IntOp $4 $0 & ${FYAGENT_FILE_ATTRIBUTE_DIRECTORY}
  ${If} $4 == 0
    Goto fyagent_${Label}_directory_close
  ${EndIf}
  IntOp $4 $0 & ${FYAGENT_FILE_ATTRIBUTE_REPARSE_POINT}
  ${If} $4 <> 0
    Goto fyagent_${Label}_directory_close
  ${EndIf}

  StrCpy ${OutputHandle} $8
  StrCpy ${ValidFlag} 1
  Goto fyagent_${Label}_directory_done

  fyagent_${Label}_directory_close:
    System::Call 'kernel32::CloseHandle(p r8) i .r4'

  fyagent_${Label}_directory_done:
!macroend

; A candidate name becomes deletable only after it is opened relative to its
; held parent directory, proven to be a regular non-reparse leaf, and marked
; through that same handle. Enumeration text is never used as a full path.
!macro FyAgentDeleteRegularFileRelativeToHandle ParentSystemRegister ParentHandle LeafName Label
  StrCpy $8 0
  StrCpy $6 0
  StrCpy $7 0
  StrCpy $4 0
  StrCpy $0 0
  StrCpy $2 -1

  StrLen $R2 "${LeafName}"
  ${If} $R2 == 0
    Goto fyagent_${Label}_leaf_done
  ${EndIf}
  IntOp $R2 $R2 * 2
  IntOp $R5 $R2 + 2
  System::Call '*(&w${NSIS_MAX_STRLEN} "${LeafName}") p .r6'
  ${If} $6 == 0
    Goto fyagent_${Label}_leaf_native_buffers_done
  ${EndIf}
  System::Call '*(&i2 R2, &i2 R5, p r6, &l.R3) p .r7'
  ${If} $7 == 0
  ${OrIf} $R3 <> ${FYAGENT_UNICODE_STRING_SIZE}
    Goto fyagent_${Label}_leaf_native_buffers_done
  ${EndIf}
  IntOp $R4 $7 + ${FYAGENT_UNICODE_STRING_BUFFER_OFFSET}
  System::Call '*$R4(p .R7)'
  ${If} $R7 != $6
    Goto fyagent_${Label}_leaf_native_buffers_done
  ${EndIf}
  System::Call '*(&l4, p ${ParentSystemRegister}, p r7, i ${FYAGENT_OBJ_CASE_INSENSITIVE}|${FYAGENT_OBJ_DONT_REPARSE}, p 0, p 0, &l.R3) p .r4'
  ${If} $4 == 0
  ${OrIf} $R3 <> ${FYAGENT_OBJECT_ATTRIBUTES_SIZE}
    Goto fyagent_${Label}_leaf_native_buffers_done
  ${EndIf}
  IntOp $R4 $4 + ${FYAGENT_OBJECT_ATTRIBUTES_ROOT_DIRECTORY_OFFSET}
  System::Call '*$R4(p .R7)'
  ${If} $R7 != ${ParentHandle}
    Goto fyagent_${Label}_leaf_native_buffers_done
  ${EndIf}
  System::Call '*(p 0, p 0, &l.R3) p .r0'
  ${If} $0 == 0
  ${OrIf} $R3 <> ${FYAGENT_IO_STATUS_BLOCK_SIZE}
    Goto fyagent_${Label}_leaf_native_buffers_done
  ${EndIf}
  System::Call 'ntdll::NtCreateFile(*p .r8, i ${FYAGENT_DELETE}|${FYAGENT_FILE_READ_ATTRIBUTES}, p r4, p r0, p 0, i 0, i ${FYAGENT_FILE_SHARE_READ}, i ${FYAGENT_FILE_OPEN}, i ${FYAGENT_FILE_NON_DIRECTORY_FILE}|${FYAGENT_FILE_FLAG_OPEN_REPARSE_POINT}, p 0, i 0) i .r2'

  fyagent_${Label}_leaf_native_buffers_done:
    ${If} $0 <> 0
      System::Free $0
    ${EndIf}
    ${If} $4 <> 0
      System::Free $4
    ${EndIf}
    ${If} $7 <> 0
      System::Free $7
    ${EndIf}
    ${If} $6 <> 0
      System::Free $6
    ${EndIf}

  ${If} $2 <> 0
    Goto fyagent_${Label}_leaf_done
  ${EndIf}
  ${If} $8 == ${FYAGENT_INVALID_HANDLE_VALUE}
  ${OrIf} $8 == 0
    Goto fyagent_${Label}_leaf_done
  ${EndIf}

  System::Alloc ${FYAGENT_BY_HANDLE_FILE_INFORMATION_SIZE}
  Pop $6
  ${If} $6 == 0
    Goto fyagent_${Label}_leaf_close
  ${EndIf}
  System::Call 'kernel32::GetFileInformationByHandle(p r8, p r6) i .r7'
  ${If} $7 == 0
    System::Free $6
    Goto fyagent_${Label}_leaf_close
  ${EndIf}
  System::Call '*$6(i .r0)'
  System::Free $6
  IntOp $4 $0 & ${FYAGENT_FILE_ATTRIBUTE_DIRECTORY}
  ${If} $4 <> 0
    Goto fyagent_${Label}_leaf_close
  ${EndIf}
  IntOp $4 $0 & ${FYAGENT_FILE_ATTRIBUTE_REPARSE_POINT}
  ${If} $4 <> 0
    Goto fyagent_${Label}_leaf_close
  ${EndIf}

  System::Alloc ${FYAGENT_FILE_DISPOSITION_INFO_SIZE}
  Pop $6
  ${If} $6 == 0
    Goto fyagent_${Label}_leaf_close
  ${EndIf}
  System::Call '*$6(&i1 1)'
  System::Call 'kernel32::SetFileInformationByHandle(p r8, i ${FYAGENT_FILE_DISPOSITION_INFO_CLASS}, p r6, i ${FYAGENT_FILE_DISPOSITION_INFO_SIZE}) i .r7'
  System::Free $6

  fyagent_${Label}_leaf_close:
    System::Call 'kernel32::CloseHandle(p r8) i .r4'

  fyagent_${Label}_leaf_done:
!macroend

; Empty owned directories are retired only through the already-held directory
; handle. Nonempty, reparse, access-denied, or concurrently changing objects
; simply fail disposition and remain for a later best-effort cleanup.
!macro FyAgentMarkEmptyDirectoryForDeletion HandleSystemRegister Label
  System::Alloc ${FYAGENT_BY_HANDLE_FILE_INFORMATION_SIZE}
  Pop $6
  ${If} $6 == 0
    Goto fyagent_${Label}_directory_disposition_done
  ${EndIf}
  System::Call 'kernel32::GetFileInformationByHandle(p ${HandleSystemRegister}, p r6) i .r7'
  ${If} $7 == 0
    System::Free $6
    Goto fyagent_${Label}_directory_disposition_done
  ${EndIf}
  System::Call '*$6(i .r0)'
  System::Free $6
  IntOp $4 $0 & ${FYAGENT_FILE_ATTRIBUTE_DIRECTORY}
  ${If} $4 == 0
    Goto fyagent_${Label}_directory_disposition_done
  ${EndIf}
  IntOp $4 $0 & ${FYAGENT_FILE_ATTRIBUTE_REPARSE_POINT}
  ${If} $4 <> 0
    Goto fyagent_${Label}_directory_disposition_done
  ${EndIf}

  System::Alloc ${FYAGENT_FILE_DISPOSITION_INFO_SIZE}
  Pop $6
  ${If} $6 == 0
    Goto fyagent_${Label}_directory_disposition_done
  ${EndIf}
  System::Call '*$6(&i1 1)'
  System::Call 'kernel32::SetFileInformationByHandle(p ${HandleSystemRegister}, i ${FYAGENT_FILE_DISPOSITION_INFO_CLASS}, p r6, i ${FYAGENT_FILE_DISPOSITION_INFO_SIZE}) i .r7'
  System::Free $6

  fyagent_${Label}_directory_disposition_done:
!macroend

; A staging job directory is eligible only when its entire direct-child name is
; the lowercase hyphenated UUID form produced by the installer job service.
!macro FyAgentValidateCanonicalUuid Value Label ValidFlag
  StrCpy ${ValidFlag} 0
  StrLen $R3 "${Value}"
  StrCmp $R3 36 0 fyagent_${Label}_uuid_done

  StrCpy $R4 "${Value}" 1 8
  StrCmp $R4 "-" 0 fyagent_${Label}_uuid_done
  StrCpy $R4 "${Value}" 1 13
  StrCmp $R4 "-" 0 fyagent_${Label}_uuid_done
  StrCpy $R4 "${Value}" 1 18
  StrCmp $R4 "-" 0 fyagent_${Label}_uuid_done
  StrCpy $R4 "${Value}" 1 23
  StrCmp $R4 "-" 0 fyagent_${Label}_uuid_done

  StrCpy $R2 0
  fyagent_${Label}_uuid_loop:
    ${If} $R2 == 36
      StrCpy ${ValidFlag} 1
      Goto fyagent_${Label}_uuid_done
    ${EndIf}
    ${If} $R2 == 8
    ${OrIf} $R2 == 13
    ${OrIf} $R2 == 18
    ${OrIf} $R2 == 23
      Goto fyagent_${Label}_uuid_next
    ${EndIf}

    StrCpy $R4 "${Value}" 1 $R2
    StrCmp $R4 "0" fyagent_${Label}_uuid_next
    StrCmp $R4 "1" fyagent_${Label}_uuid_next
    StrCmp $R4 "2" fyagent_${Label}_uuid_next
    StrCmp $R4 "3" fyagent_${Label}_uuid_next
    StrCmp $R4 "4" fyagent_${Label}_uuid_next
    StrCmp $R4 "5" fyagent_${Label}_uuid_next
    StrCmp $R4 "6" fyagent_${Label}_uuid_next
    StrCmp $R4 "7" fyagent_${Label}_uuid_next
    StrCmp $R4 "8" fyagent_${Label}_uuid_next
    StrCmp $R4 "9" fyagent_${Label}_uuid_next
    StrCmp $R4 "a" fyagent_${Label}_uuid_next
    StrCmp $R4 "b" fyagent_${Label}_uuid_next
    StrCmp $R4 "c" fyagent_${Label}_uuid_next
    StrCmp $R4 "d" fyagent_${Label}_uuid_next
    StrCmp $R4 "e" fyagent_${Label}_uuid_next
    StrCmp $R4 "f" fyagent_${Label}_uuid_next
    Goto fyagent_${Label}_uuid_done

  fyagent_${Label}_uuid_next:
    IntOp $R2 $R2 + 1
    Goto fyagent_${Label}_uuid_loop

  fyagent_${Label}_uuid_done:
!macroend

; Retired runtime names keep their historical wildcard-compatible middle but
; must be a complete direct-child business-*.state or business-*.lock name.
!macro FyAgentValidateLegacyRuntimeName Value Label ValidFlag
  StrCpy ${ValidFlag} 0
  StrLen $R3 "${Value}"
  ${If} $R3 < 14
    Goto fyagent_${Label}_legacy_name_done
  ${EndIf}
  StrCpy $R4 "${Value}" 9
  StrCmp $R4 "business-" 0 fyagent_${Label}_legacy_name_done
  StrCpy $R4 "${Value}" 5 -5
  StrCmp $R4 ".lock" fyagent_${Label}_legacy_name_valid
  ${If} $R3 < 15
    Goto fyagent_${Label}_legacy_name_done
  ${EndIf}
  StrCpy $R4 "${Value}" 6 -6
  StrCmp $R4 ".state" 0 fyagent_${Label}_legacy_name_done

  fyagent_${Label}_legacy_name_valid:
    StrCpy ${ValidFlag} 1

  fyagent_${Label}_legacy_name_done:
!macroend

; Install and uninstall may retire only exact staging artifacts below canonical
; direct-child UUID directories. Unknown names/content and every reparse point
; survive; only now-empty owned ancestors are removed, without recursion.
!macro FyAgentCleanupKnownCodexInstallerStaging Label
  ClearErrors
  !insertmacro FyAgentOpenCleanupAnchorDirectory "$INSTDIR\cache" ${Label}_cache $5 $9
  ${If} $9 <> 1
    Goto fyagent_${Label}_staging_done
  ${EndIf}

  !insertmacro FyAgentOpenDirectoryRelativeToHandle r5 $5 "codex-installer" ${Label}_staging $3 $2
  ${If} $2 <> 1
    Goto fyagent_${Label}_staging_close_cache
  ${EndIf}

  ClearErrors
  FindFirst $R0 $R1 "$INSTDIR\cache\codex-installer\*"
  IfErrors fyagent_${Label}_staging_close_root

  fyagent_${Label}_staging_entry:
    StrCmp $R1 "." fyagent_${Label}_staging_next
    StrCmp $R1 ".." fyagent_${Label}_staging_next
    !insertmacro FyAgentValidateCanonicalUuid "$R1" ${Label}_staging_entry $R5
    ${If} $R5 == 1
      !insertmacro FyAgentOpenDirectoryRelativeToHandle r3 $3 "$R1" ${Label}_staging_child $1 $R6
      ${If} $R6 == 1
        !insertmacro FyAgentDeleteRegularFileRelativeToHandle r1 $1 "installer.msix" ${Label}_staging_msix
        !insertmacro FyAgentDeleteRegularFileRelativeToHandle r1 $1 "installer.msix.part" ${Label}_staging_part
        !insertmacro FyAgentMarkEmptyDirectoryForDeletion r1 ${Label}_staging_child
        System::Call 'kernel32::CloseHandle(p r1) i .r4'
      ${EndIf}
    ${EndIf}

  fyagent_${Label}_staging_next:
    ClearErrors
    FindNext $R0 $R1
    IfErrors fyagent_${Label}_staging_close_find
    Goto fyagent_${Label}_staging_entry

  fyagent_${Label}_staging_close_find:
    FindClose $R0

  fyagent_${Label}_staging_close_root:
    !insertmacro FyAgentMarkEmptyDirectoryForDeletion r3 ${Label}_staging_root
    System::Call 'kernel32::CloseHandle(p r3) i .r4'

  fyagent_${Label}_staging_close_cache:
    !insertmacro FyAgentMarkEmptyDirectoryForDeletion r5 ${Label}_staging_cache
    System::Call 'kernel32::CloseHandle(p r5) i .r4'

  fyagent_${Label}_staging_done:
    ; Cleanup is observational only; do not leak a failed enumeration,
    ; native disposition, or enumeration flag into later payload operations.
    ClearErrors
!macroend

; Legacy runtime cleanup is deliberately not a provisioning or admission
; boundary. It removes only the two retired filename patterns from fixed,
; no-follow directories and never aborts install or uninstall.
!macro FyAgentCleanupLegacyMachineRuntime Label
  ClearErrors
  !insertmacro FyAgentOpenCleanupAnchorDirectory "$COMMONPROGRAMDATA\FyAgent" ${Label}_parent $5 $9
  ${If} $9 <> 1
    Goto fyagent_${Label}_done
  ${EndIf}

  !insertmacro FyAgentOpenDirectoryRelativeToHandle r5 $5 "runtime" ${Label}_runtime $3 $2
  ${If} $2 <> 1
    Goto fyagent_${Label}_close_parent
  ${EndIf}

  ClearErrors
  FindFirst $R0 $R1 "$COMMONPROGRAMDATA\FyAgent\runtime\*"
  IfErrors fyagent_${Label}_close_runtime

  fyagent_${Label}_legacy_entry:
    StrCmp $R1 "." fyagent_${Label}_legacy_next
    StrCmp $R1 ".." fyagent_${Label}_legacy_next
    !insertmacro FyAgentValidateLegacyRuntimeName "$R1" ${Label}_legacy_entry $R5
    ${If} $R5 == 1
      !insertmacro FyAgentDeleteRegularFileRelativeToHandle r3 $3 "$R1" ${Label}_legacy_file
    ${EndIf}

  fyagent_${Label}_legacy_next:
    ClearErrors
    FindNext $R0 $R1
    IfErrors fyagent_${Label}_legacy_close_find
    Goto fyagent_${Label}_legacy_entry

  fyagent_${Label}_legacy_close_find:
    FindClose $R0

  fyagent_${Label}_close_runtime:
    !insertmacro FyAgentMarkEmptyDirectoryForDeletion r3 ${Label}_legacy_runtime
    System::Call 'kernel32::CloseHandle(p r3) i .r4'

  fyagent_${Label}_close_parent:
    !insertmacro FyAgentMarkEmptyDirectoryForDeletion r5 ${Label}_legacy_parent
    System::Call 'kernel32::CloseHandle(p r5) i .r4'

  fyagent_${Label}_done:
    ; Cleanup is observational only; do not leak a failed enumeration or
    ; native disposition flag into later installer hooks or payload operations.
    ClearErrors
!macroend

Section EarlyChecks
  !insertmacro FyAgentRequireProcessStopped "${MAINBINARYNAME}.exe" "${PRODUCTNAME}" early_main
  !insertmacro FyAgentRequireProcessStopped "fyagent-user-helper.exe" "${PRODUCTNAME} user helper" early_helper

  ; Abort silent installer if downgrades is disabled
  !if "${ALLOWDOWNGRADES}" == "false"
  ${If} ${Silent}
    ; If downgrading
    ${If} $R0 = -1
      System::Call 'kernel32::AttachConsole(i -1)i.r0'
      ${If} $0 <> 0
        System::Call 'kernel32::GetStdHandle(i -11)i.r0'
        System::call 'kernel32::SetConsoleTextAttribute(i r0, i 0x0004)' ; set red color
        FileWrite $0 "$(silentDowngrades)"
      ${EndIf}
      Abort
    ${EndIf}
  ${EndIf}
  !endif

  ; The frozen MSI bridge must finish before WebView2 or any new NSIS payload
  ; section can mutate the machine.
  Call FyAgentMigrateLegacyWixInstall

SectionEnd

Section WebView2
  ; Check if Webview2 is already installed and skip this section
  ${If} ${RunningX64}
    ReadRegStr $4 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${Else}
    ReadRegStr $4 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}
  ${If} $4 == ""
    ReadRegStr $4 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}

  ${If} $4 == ""
    ; Webview2 installation
    ;
    ; Skip if updating
    ${If} $UpdateMode <> 1
      !if "${INSTALLWEBVIEW2MODE}" != "downloadBootstrapper"
        !error "FyAgent requires the reviewed secure downloadBootstrapper flow"
      !endif

      DetailPrint "$(webview2Downloading)"
      !insertmacro FyAgentSetWebView2CommandEnvironment
      ${If} $7 <> 1
        !insertmacro FyAgentClearWebView2CommandEnvironment
        DetailPrint "$(webview2DownloadError)"
        Abort "$(webview2AbortError)"
      ${EndIf}

      ClearErrors
      ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${FYAGENT_WEBVIEW2_LOADER_BASE64}' $1
      ${If} ${Errors}
        StrCpy $1 90
      ${EndIf}
      !insertmacro FyAgentClearWebView2CommandEnvironment
      ${If} $6 <> 1
        StrCpy $1 91
      ${EndIf}

      ${If} $1 = 0
        DetailPrint "$(webview2DownloadSuccess)"
        DetailPrint "$(webview2InstallSuccess)"
      ${Else}
        DetailPrint "$(webview2InstallError)"
        Abort "$(webview2AbortError)"
      ${EndIf}
    ${EndIf}
  ${Else}
    !if "${MINIMUMWEBVIEW2VERSION}" != ""
      ${VersionCompare} "${MINIMUMWEBVIEW2VERSION}" "$4" $R0
      ${If} $R0 = 1
        update_webview:
          DetailPrint "$(installingWebview2)"
          ${If} ${RunningX64}
            ReadRegStr $R1 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate" "path"
          ${Else}
            ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 == ""
            ReadRegStr $R1 HKCU "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 != ""
            ; Chromium updater docs: https://source.chromium.org/chromium/chromium/src/+/main:docs/updater/user_manual.md
            ; Modified from "HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Microsoft EdgeWebView\ModifyPath"
            ExecWait `"$R1" /install appguid=${WEBVIEW2APPGUID}&needsadmin=true` $1
            ${If} $1 = 0
              DetailPrint "$(webview2InstallSuccess)"
            ${Else}
              MessageBox MB_ICONEXCLAMATION|MB_ABORTRETRYIGNORE "$(webview2InstallError)" IDIGNORE ignore IDRETRY update_webview
              Quit
              ignore:
            ${EndIf}
          ${EndIf}
      ${EndIf}
    !endif
  ${EndIf}
SectionEnd

Section Install
  !insertmacro FyAgentRequireProcessStopped "${MAINBINARYNAME}.exe" "${PRODUCTNAME}" install_main
  !insertmacro FyAgentRequireProcessStopped "fyagent-user-helper.exe" "${PRODUCTNAME} user helper" install_helper

  SetOutPath $INSTDIR

  !ifmacrodef NSIS_HOOK_PREINSTALL
    !insertmacro NSIS_HOOK_PREINSTALL
  !endif

  ; Retire only known files from the obsolete machine runtime. Cleanup is
  ; intentionally best-effort and never becomes an install admission gate.
  !insertmacro FyAgentCleanupLegacyMachineRuntime install_legacy_runtime

  ; Retire only canonical completed/incomplete Codex staging artifacts left by
  ; an older installation. Unknown cache content survives an upgrade.
  !insertmacro FyAgentCleanupKnownCodexInstallerStaging install_codex_staging

  ; Copy main executable
  File "${MAINBINARYSRCPATH}"

  ; Copy resources
  {{#each resources_dirs}}
    CreateDirectory "$INSTDIR\\{{this}}"
  {{/each}}
  {{#each resources}}
    File /a "/oname={{this.[1]}}" "{{no-escape @key}}"
  {{/each}}

  ; Copy external binaries
  {{#each binaries}}
    File /a "/oname={{this}}" "{{no-escape @key}}"
  {{/each}}

  ; Create file associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
       !insertmacro APP_ASSOCIATE "{{ext}}" "{{or association.name ext}}" "{{association-description association.description ext}}" "$INSTDIR\${MAINBINARYNAME}.exe,0" "Open with ${PRODUCTNAME}" "$INSTDIR\${MAINBINARYNAME}.exe $\"%1$\""
    {{/each}}
  {{/each}}

  ; Register deep links
  {{#each deep_link_protocols as |protocol| ~}}
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "URL Protocol" ""
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "" "URL:${BUNDLEID} protocol"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  {{/each}}

  ; Create uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Save $INSTDIR in registry for future installations
  WriteRegStr SHCTX "${MANUPRODUCTKEY}" "" $INSTDIR

  !if "${INSTALLMODE}" == "both"
    ; Save install mode to be selected by default for the next installation such as updating
    ; or when uninstalling
    WriteRegStr SHCTX "${UNINSTKEY}" $MultiUser.InstallMode 1
  !endif

  ; Remove old main binary if it doesn't match new main binary name
  ReadRegStr $OldMainBinaryName SHCTX "${UNINSTKEY}" "MainBinaryName"
  ${If} $OldMainBinaryName != ""
  ${AndIf} $OldMainBinaryName != "${MAINBINARYNAME}.exe"
    Delete "$INSTDIR\$OldMainBinaryName"
  ${EndIf}

  ; Save current MAINBINARYNAME for future updates
  WriteRegStr SHCTX "${UNINSTKEY}" "MainBinaryName" "${MAINBINARYNAME}.exe"

  ; Registry information for add/remove programs
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayIcon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr SHCTX "${UNINSTKEY}" "Publisher" "${MANUFACTURER}"
  WriteRegStr SHCTX "${UNINSTKEY}" "InstallLocation" "$\"$INSTDIR$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoModify" "1"
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoRepair" "1"

  ${GetSize} "$INSTDIR" "/M=uninstall.exe /S=0K /G=0" $0 $1 $2
  IntOp $0 $0 + ${ESTIMATEDSIZE}
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD SHCTX "${UNINSTKEY}" "EstimatedSize" "$0"

  !if "${HOMEPAGE}" != ""
    WriteRegStr SHCTX "${UNINSTKEY}" "URLInfoAbout" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "URLUpdateInfo" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "HelpLink" "${HOMEPAGE}"
  !endif

  ; Create start menu shortcut
  !insertmacro MUI_STARTMENU_WRITE_BEGIN Application
    Call CreateOrUpdateStartMenuShortcut
  !insertmacro MUI_STARTMENU_WRITE_END

  ; Create desktop shortcut for silent and passive installers
  ; because finish page will be skipped
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    Call CreateOrUpdateDesktopShortcut
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTINSTALL
    !insertmacro NSIS_HOOK_POSTINSTALL
  !endif

  ; Auto close this page for passive mode
  ${If} $PassiveMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

Function .onInstSuccess
  ; Check for `/R` flag only in silent and passive installers because
  ; GUI installer has a toggle for the user to (re)start the app
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    ${GetOptions} $CMDLINE "/R" $R0
    ${IfNot} ${Errors}
      ${GetOptions} $CMDLINE "/ARGS" $R0
      nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" "$R0"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function un.onInit
  SetRegView 64
  !insertmacro SetContext

  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_UNINIT
  !endif

  !insertmacro MUI_UNGETLANGUAGE

  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
FunctionEnd

Section Uninstall

  !insertmacro FyAgentRequireProcessStopped "${MAINBINARYNAME}.exe" "${PRODUCTNAME}" uninstall_main
  !insertmacro FyAgentRequireProcessStopped "fyagent-user-helper.exe" "${PRODUCTNAME} user helper" uninstall_helper

  !ifmacrodef NSIS_HOOK_PREUNINSTALL
    !insertmacro NSIS_HOOK_PREUNINSTALL
  !endif

  ; The same fixed, no-follow, known-name cleanup is safe to retry during
  ; uninstall. Unknown content and cleanup failures are preserved.
  !insertmacro FyAgentCleanupLegacyMachineRuntime uninstall_legacy_runtime
  !insertmacro FyAgentCleanupKnownCodexInstallerStaging uninstall_codex_staging

  ; Delete the app directory and its content from disk
  ; Copy main executable
  Delete "$INSTDIR\${MAINBINARYNAME}.exe"

  ; Delete resources
  {{#each resources}}
    Delete "$INSTDIR\\{{this.[1]}}"
  {{/each}}

  ; Delete external binaries
  {{#each binaries}}
    Delete "$INSTDIR\\{{this}}"
  {{/each}}

  ; Delete app associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
      !insertmacro APP_UNASSOCIATE "{{ext}}" "{{or association.name ext}}"
    {{/each}}
  {{/each}}

  ; Delete deep links
  {{#each deep_link_protocols as |protocol| ~}}
    ReadRegStr $R7 SHCTX "Software\Classes\\{{protocol}}\shell\open\command" ""
    ${If} $R7 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
      DeleteRegKey SHCTX "Software\Classes\\{{protocol}}"
    ${EndIf}
  {{/each}}


  ; Delete uninstaller
  Delete "$INSTDIR\uninstall.exe"

  {{#each resources_ancestors}}
  RMDir /REBOOTOK "$INSTDIR\\{{this}}"
  {{/each}}
  RMDir "$INSTDIR"

  ; Remove shortcuts if not updating
  ${If} $UpdateMode <> 1
    !insertmacro DeleteAppUserModelId

    ; Remove start menu shortcut
    !insertmacro MUI_STARTMENU_GETFOLDER Application $AppStartMenuFolder
    !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      RMDir "$SMPROGRAMS\$AppStartMenuFolder"
    ${EndIf}
    !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}

    ; Remove desktop shortcuts
    !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$DESKTOP\${PRODUCTNAME}.lnk"
      Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
  ${EndIf}

  ; Remove registry information for add/remove programs
  !if "${INSTALLMODE}" == "both"
    DeleteRegKey SHCTX "${UNINSTKEY}"
  !else if "${INSTALLMODE}" == "perMachine"
    DeleteRegKey HKLM "${UNINSTKEY}"
  !else
    DeleteRegKey HKCU "${UNINSTKEY}"
  !endif

  ; Remove installer-owned location/language markers without touching the
  ; application's per-user ${BUNDLEID} stores or ~/.fyagent data.
  DeleteRegKey SHCTX "${MANUPRODUCTKEY}"
  DeleteRegKey /ifempty SHCTX "${MANUKEY}"
  DeleteRegValue HKCU "${MANUPRODUCTKEY}" "Installer Language"
  DeleteRegKey /ifempty HKCU "${MANUPRODUCTKEY}"
  DeleteRegKey /ifempty HKCU "${MANUKEY}"

  ; Removes the Autostart entry for ${PRODUCTNAME} from the HKCU Run key if it exists.
  ; This ensures the program does not launch automatically after uninstallation if it exists.
  ; If it doesn't exist, it does nothing.
  ; We do this when not updating (to preserve the registry value on updates)
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTUNINSTALL
    !insertmacro NSIS_HOOK_POSTUNINSTALL
  !endif

  ; Auto close if passive mode or updating
  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

Function RestorePreviousInstallLocation
  ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""
  ${If} $4 != ""
    StrCpy $INSTDIR $4
  ${ElseIf} $LegacyWixInstallDir != ""
    StrCpy $INSTDIR $LegacyWixInstallDir
  ${EndIf}
FunctionEnd

Function Skip
  Abort
FunctionEnd

Function SkipIfPassive
  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}
FunctionEnd
Function un.SkipIfPassive
  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}
FunctionEnd

Function CreateOrUpdateStartMenuShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  StrCpy $R0 0

  !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R0 1
  ${EndIf}

  !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R0 1
  ${EndIf}

  ${If} $R0 = 1
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ${If} $UpdateMode = 1
  ${OrIf} $NoShortcutMode = 1
    Return
  ${EndIf}

  !if "${STARTMENUFOLDER}" != ""
    CreateDirectory "$SMPROGRAMS\$AppStartMenuFolder"
    CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  !else
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !endif
FunctionEnd

Function CreateOrUpdateDesktopShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ${If} $UpdateMode = 1
  ${OrIf} $NoShortcutMode = 1
    Return
  ${EndIf}

  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
FunctionEnd
