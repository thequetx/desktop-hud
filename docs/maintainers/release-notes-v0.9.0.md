# Desktop HUD v0.9.0 (Preview): release notes

Paste this into the drafted GitHub release, below CI's line about `SHA256SUMS.txt`.

---

**Desktop HUD v0.9 Preview** puts small, see-through bubbles in the corners of your Windows desktop: the time, what's next on your calendar, and, if you keep Markdown notes, this week's priorities. Clicks pass straight through. When you step away, a calm idle screen fades in.

## Install

Download `Desktop HUD Setup 0.9.0.exe` and run it. It installs for your Windows user only and needs no administrator.

The installer isn't code-signed yet, so Windows SmartScreen says "Windows protected your PC" and shows **Unknown publisher**. Choose **More info**, then **Run anyway**. To check the download, compare its SHA-256 with `SHA256SUMS.txt`.

See [Getting started](../getting-started.md).

## What it does

- **Calendars:** private `.ics` links (Google, Outlook, iCloud, Canvas and others) or `.ics` files. Links are stored encrypted for your Windows user. The last good copy is kept for offline use.
- **Notes (optional):** built-in Markdown notes, or your own folder or Obsidian vault. Your folder is read-only unless you allow writing, and every write is checked and backed up first.
- **Corners:** Minimal, Focus or Full presets, each with its own backdrop. Everything is in **Display & HUD** (right-click the tray icon).
- **Private corners** are hidden from screen capture and streaming.
- **Quiet by design:** no hotkeys until you choose them, no notifications, no telemetry. Polling pauses while the screen is locked and slows on battery.

## Uninstalling

The uninstaller asks whether to also delete Desktop HUD's data. The default is **No**, which keeps everything for a reinstall. Your own notes folder is never touched. See [Uninstalling and your data](../uninstall.md).

## Known limitations in this preview

- **Unsigned installer:** expect the SmartScreen warning above until signing arrives after v1.0.
- **Memory:** about 450–550 MB working set when idle (about 190 MB private), across Electron's processes. Reducing this is planned.
- **Windows only:** Windows 10 22H2 and Windows 11, x64. ARM64 isn't supported.
- **Not yet tested on physical hardware for this preview:**
  - battery and sleep/resume behaviour;
  - two monitors with **different** scaling;
  - unplugging the monitor the HUD is on;
  - Windows' "reduce animations" setting.

  They're designed for, but unverified. Please open an issue if anything misbehaves.

## Reporting a problem

Open an issue with what you did and what you saw. **Never paste a calendar link**: it's a password for your calendar. Security issues: see `SECURITY.md`.
