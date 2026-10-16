# Uninstalling and your data

## What is stored where

Everything Desktop HUD keeps is in one folder: `%APPDATA%\Desktop HUD` (paste that into File Explorer's address bar). Nothing is stored anywhere else, and nothing is uploaded.

| In that folder | What it is |
|---|---|
| `config.json` | Your settings: notes folder and conventions, now playing, hotkeys |
| `secrets.bin` | Your calendar links, encrypted for your Windows user only |
| `presentation.json` | Which bubbles are where, the backdrop, the idle screen |
| `week-skeleton.yaml` | Your recurring blocks |
| `cal-cache` | The last good copy of each calendar, so the HUD works offline |
| `Notes` | The built-in notes, if you use them |
| `backups` | Previous versions of notes Desktop HUD changed (the last 20 of each) |

Your own notes folder, if you chose one, stays wherever it is. Desktop HUD doesn't keep a copy of it.

## Uninstall

1. If you turned on **Start on login**, turn it off first (tray icon → **Start on login**).
2. Right-click the tray icon and choose **Quit**.
3. Open Windows **Settings → Apps → Installed apps**, find **Desktop HUD**, and choose **Uninstall**.

The uninstaller asks whether to **also delete Desktop HUD's data**. The answer is **No** unless you choose otherwise: the program is removed and your data folder is kept, so a reinstall picks up where you left off. An update never asks and never deletes anything.

## Remove your data too

Choose **Yes** when the uninstaller asks. That removes your settings, calendar links, cache, built-in notes and backups. Copy anything you want to keep out of `Notes` and `backups` first. Your own notes folder, if you chose one, is never touched.

If you kept your data and change your mind later, delete the `%APPDATA%\Desktop HUD` folder yourself.

## Your calendar links

Deleting the data folder deletes the copy Desktop HUD stored. The links themselves still work for anyone who has them. If you think one has been shared, reset it in your calendar app (Google: **Reset** beside the secret address; Outlook: unpublish and publish again; iCloud: turn **Public Calendar** off).
