# Troubleshooting

## I can't see the HUD

- Right-click the tray icon and choose **Show HUD**. If you can't find the icon, click the small arrow beside the clock in the taskbar.
- Check **Display & HUD → Screens → HUD → Display**: the HUD may be on another monitor. If the chosen monitor is unplugged, it moves to your main one.
- Check that some bubbles are switched on in **Display & HUD → Bubbles**. A bubble with nothing to show hides, so a corner can look empty.

## The bubbles are hard to read

Raise **Background** in **Display & HUD → Screens → HUD**, or choose the **Panel** backdrop. 85% keeps text readable over a white window. **None** is meant for dark wallpapers.

## Next up says "No calendar yet"

You haven't added a calendar or a recurring block. Add one in **Display & HUD → Integrations → Calendars**.

## My calendar isn't updating

Open **Display & HUD → Integrations → Calendars**. A calendar that isn't updating has a red light and says why:

- **HTTP 404**: the link was reset or unpublished. Get a new link and use **Fix…**.
- **HTTP 401 or 403**: the link is no longer allowed. For Outlook, publish the calendar again; for Google, use the *secret* address.
- **Can't reach the server**: you're offline, or a firewall is blocking it. It keeps your last good copy and tries again every 15 minutes. **Refresh now** tries straight away.
- **Too large or too many events**: Desktop HUD caps very large calendars so they can't freeze it. Share a smaller calendar if you can.

A new event can take up to 15 minutes to appear, longer if your calendar service only updates its shared link every few hours (some do).

## Times are wrong by an hour

Desktop HUD uses Windows' time zone. Check **Settings → Time & language → Date & time** in Windows. To change 12- or 24-hour time, or the first day of the week, see **Display & HUD → Screens → Date and time**.

## My notes don't show

- Check **Display & HUD → Integrations → Notes**: a red light means the folder can't be found.
- Check the **Weekly notes folder** and that this week's note is named like `2026-W42.md`.
- Intentions and tasks must be checkbox lines (`- [ ] …`) under `## Intentions` and `## Tasks`.
- After changing a notes setting, Desktop HUD has to restart: use **Apply and restart**.

## Quick capture says writing is off

Your own notes folder is read-only until you allow writing. Turn on **Let Desktop HUD write here** in **Display & HUD → Integrations → Notes**. See [what gets written](notes.md#what-gets-written).

## Now playing shows the wrong app, or nothing

Now playing reads what apps publish to Windows media controls. Some apps do not publish a session. To show only one app, choose **One app only** in **Display & HUD → Integrations → Now playing** and type its name (like `spotify`), then **Apply and restart**. For Spotify and MusicBee, choose **Spotify + MusicBee**. MusicBee needs a compatible SMTC plugin such as mb_MediaControl; follow the [MusicBee setup steps](now-playing.md#musicbee). For an installed copy, use the per-user plugin folder `%APPDATA%\MusicBee\Plugins`; the guide has the portable-install location too. If its session appears in Windows media controls but the HUD still omits it, choose **Selected apps** and enter the app identity Windows reports; the preset uses `musicbee`. You can also enter a comma-separated list there.

If your antivirus quarantined a file called `smtc-reader.exe`, that is Desktop HUD's small helper for reading the media controls. It only reads what is playing and never connects to anything. Restore it, or allow it, and restart Desktop HUD. Everything else works without it; only Now playing stays empty. Please also report it in the issue tracker, so it can be reported to the antivirus maker as a false positive.

## Windows says the installer is from an unknown publisher

The installer isn't code-signed yet. Choose **More info**, then **Run anyway**. Only download Desktop HUD from the project's GitHub Releases page.

## Set-up keeps coming back

Set-up opens every time Desktop HUD starts until you press **Finish** or **Skip set-up**.

## Something else

Desktop HUD keeps a log on your PC only. When you report a problem on GitHub, describe what you did and what you saw. Never paste a calendar link: it's a password for your calendar.
