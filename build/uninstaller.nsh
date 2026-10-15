; Desktop HUD uninstaller (Phase 9.6, trust model S7). Leftover data is
; sensitive: it holds encrypted calendar links, a calendar cache and copies of
; notes the app wrote to. So a real uninstall offers to delete it. The default
; is No, a silent uninstall (/S) keeps it, and an update (which runs the old
; uninstaller with --updated) never asks. The user's own notes folder is never
; inside this folder and is never touched.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; Start on login points at the exe being removed: take it out (the app's
    ; own entry and the dev-run one; see platform/win32/startup.cjs).
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.Desktop HUD"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "electron.app.Desktop HUD"
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete Desktop HUD's data on this PC?$\r$\n$\r$\nThat is its settings, your calendar links (encrypted), the calendar cache, backups of notes it wrote to, and its built-in notes.$\r$\n$\r$\nYour own notes folder is never touched. Choose No to keep everything for a reinstall." /SD IDNO IDNO +2
    RMDir /r "$APPDATA\Desktop HUD"
  ${endIf}
!macroend
