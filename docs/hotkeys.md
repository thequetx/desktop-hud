# Hotkeys

Desktop HUD registers **no hotkeys** until you choose them, so it can't clash with your other apps. Everything a hotkey does is also in the tray menu.

## The four hotkeys

| Name in config | Does | Suggested keys |
|---|---|---|
| `hud` | Shows or hides the HUD | Ctrl+Alt+H |
| `focus` | Starts or ends focus mode for the event happening now | Ctrl+Alt+F |
| `week` | Opens this week's note (and creates it, if writing is allowed) | Ctrl+Alt+W |
| `capture` | Opens quick capture | Ctrl+Alt+N |

## Turning them on

In v0.9 hotkeys are set in Desktop HUD's settings file. A settings page for them is planned.

1. Quit Desktop HUD (tray icon → **Quit**).
2. Open `%APPDATA%\Desktop HUD\config.json` in a text editor (paste the path into File Explorer's address bar to find it).
3. Add a `hotkeys` section, or fill in the one that's there, with the keys you want:

   ```json
   "hotkeys": {
     "v": 1,
     "hud": "CommandOrControl+Alt+H",
     "focus": "CommandOrControl+Alt+F",
     "week": "CommandOrControl+Alt+W",
     "capture": "CommandOrControl+Alt+N"
   }
   ```

   Leave a value empty (`""`) to keep that hotkey off. Keys are written like `CommandOrControl+Alt+H` or `CommandOrControl+Shift+F9`.
4. Save the file and start Desktop HUD again.

If another app already uses a combination, Windows gives it to whichever app asked first. Pick a different one.

## Inside the app

- **Esc** closes Display & HUD without saving, and ends arrange mode.
- **Enter** adds a calendar link once you've pasted it.
- In quick capture, **Enter** saves the line and **Esc** closes it.

## Focus mode

Focus mode turns Next up into a countdown for the calendar event happening now, and hides the bubbles that compete with it. Start it from the tray (**Focus on: …**) or its hotkey. It ends by itself when the event does, or from the tray or the hotkey.
