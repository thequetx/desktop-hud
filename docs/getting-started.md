# Getting started

## Install

Desktop HUD runs on Windows 10 and 11. It installs for your Windows user only and doesn't need an administrator.

1. Download the installer from the project's GitHub Releases page.
2. Run it. The installer isn't code-signed yet, so Windows SmartScreen may say it "protected your PC". Choose **More info**, then **Run anyway**.
3. Desktop HUD starts and opens its set-up window.

## Set-up: three steps

The set-up window has three steps. Each one has **Skip this step**, and **Skip set-up** skips the lot. Nothing you skip is lost: everything is in **Display & HUD** later. If you close the window, set-up opens again the next time Desktop HUD starts.

### 1. Notes

Where do your tasks and notes live?

- **Start fresh** (the default). Desktop HUD keeps a small folder of plain Markdown notes for you. Choose this if you only want your calendar.
- **Use my notes folder.** Choose a folder of Markdown notes or an Obsidian vault. Desktop HUD looks inside and suggests where your weekly notes, daily notes and backlog are; check the suggestions and correct them if needed. Your folder is **read-only** unless you switch on **Let Desktop HUD write here**. See [Notes](notes.md).

### 2. Calendar

Paste your calendar's private link (an address ending in `.ics`) and press **Next**. Desktop HUD checks the link before it moves on. You can add more calendars later.

Don't know where your link is? The step shows where to find it for Google Calendar, Outlook, Apple iCloud and Canvas. There's more in [Calendars](calendars.md). No link? Choose an `.ics` file instead.

### 3. Corners

Choose what sits in the corners of your screen:

| Preset | Shows | Good for |
|---|---|---|
| **Minimal** | Clock, Next up, Today radar | A calendar and nothing else |
| **Focus** | Minimal, plus Intentions, Week and this week's tasks | Planning your week in notes |
| **Full** | Every bubble | Seeing everything; empty bubbles stay hidden |

Then choose the **backdrop**: what sits behind the text (see [Bubbles](bubbles.md#backdrop)). The bubbles on your screen change as you choose, so look at the corners of your screen to see how they look over your own desktop.

Press **Finish**. If you chose a notes folder, Desktop HUD needs one restart to read it, and offers to do it.

## Afterwards

Desktop HUD lives in the **notification area** (the tray) at the right of the taskbar. Right-click its icon for:

- **Show HUD / Hide HUD**
- **Arrange HUD…**: move bubbles around on the screen itself
- **Display & HUD…**: every setting, in three tabs: **Bubbles**, **Screens** and **Integrations**
- **Focus on…**: a countdown for the calendar event happening now
- **Open this week**: this week's note
- **Quick capture**: jot a line into your backlog
- **Start on login**
- **Quit**

If the icon is hidden, click the small arrow beside the clock in the taskbar to show it.
