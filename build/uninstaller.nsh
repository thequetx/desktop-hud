; Desktop HUD uninstaller (Phase 9.6, trust model S7). Leftover data is
; sensitive: it holds encrypted calendar links, a calendar cache and copies of
; notes the app wrote to. So a real uninstall offers to delete it. The default
; is No, a silent uninstall (/S) keeps it, and an update (which runs the old
; uninstaller with --updated) never asks. The user's own notes folder is never
; inside this folder and is never touched.
;
; The question is asked in un.onInit, not in the uninstall section: a one-click
; uninstaller switches itself to silent mode at the end of un.onInit, so a
; MessageBox in customUnInstall was answered by its /SD default and never shown
; (Bug Log #91).

!macro customUnInit
  Var /GLOBAL hudDeleteData
  StrCpy $hudDeleteData "0"
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--updated" $R1
  ${If} ${Errors}
    ClearErrors
    ${GetOptions} $R0 "/S" $R1
    ${If} ${Errors}
      SetSilent normal
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete Desktop HUD's data on this PC?$\r$\n$\r$\nThat is its settings, your calendar links (encrypted), the calendar cache, backups of notes it wrote to, and its built-in notes.$\r$\n$\r$\nYour own notes folder is never touched. Choose No to keep everything for a reinstall." IDNO +2
      StrCpy $hudDeleteData "1"
      !ifdef ONE_CLICK
        SetSilent silent
      !endif
    ${EndIf}
  ${EndIf}
  ClearErrors
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; Start on login points at the exe being removed: take it out (the app's
    ; own entry and the dev-run one; see platform/win32/startup.cjs).
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.Desktop HUD"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "electron.app.Desktop HUD"
    ${If} $hudDeleteData == "1"
      RMDir /r "$APPDATA\Desktop HUD"
    ${EndIf}
  ${endIf}
!macroend
