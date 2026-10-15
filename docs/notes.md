# Notes

Desktop HUD can show this week's intentions and tasks, today's goals and a backlog from **plain Markdown notes**. It works with any folder of `.md` files, including an Obsidian vault. You don't need notes at all: without them, the bubbles that read notes simply stay hidden.

Change notes settings in **Display & HUD → Integrations → Notes**. Desktop HUD reads its notes settings when it starts, so changing the folder or a convention ends with **Apply and restart**.

## Built-in notes or your own folder

**Built-in notes** (the default) is a folder of Markdown notes that Desktop HUD keeps for you, beside its settings. It writes there freely, because the folder is its own.

**Your own folder** is any folder you choose. Desktop HUD looks inside and suggests the conventions below; you can change any of them. Desktop HUD never looks outside the folder you choose, and it never follows shortcuts or links that lead out of it.

To switch back, choose **Disconnect: use built-in notes**. Your folder isn't touched.

## Conventions

| Setting | What it means | Example |
|---|---|---|
| Weekly notes folder | One note per week, named by ISO week | `Weekly/2026-W42.md` |
| Daily notes folder | One note per day, named by date. Leave empty if you don't keep them | `Daily/2026-10-15.md` |
| Backlog note | Where quick capture adds a line | `Backlog.md` |
| This-week tag | A task with this tag anywhere counts as this week's | `#thisweek` |
| Folders to scan | Where to look for tagged tasks; empty means the whole folder | `Projects, Areas` |

Inside a weekly note, Desktop HUD reads tasks (`- [ ] …`) under two headings:

```markdown
## Intentions
- [ ] Finish the report draft
- [x] Three gym sessions

## Tasks
- [ ] Book the dentist
- [ ] 14:00 - 15:00 Review slides ⏳ 2026-10-16
```

A task with a time range and a scheduled date (`⏳`) appears in the **Placed** bubble at that time. Priorities and dates in the Tasks-plugin style (⏫ 🔼 📅 ⏳) are understood.

A daily note can have a `## Goals` heading with tasks, and `energy:` and `motivation:` values (1–10) in its front matter, for the **Today** bubble.

## Read-only by default

Your own folder starts **read-only**: Desktop HUD reads it and writes nothing. The switch **Let Desktop HUD write here** changes that, and says exactly what it allows.

### What gets written

With writing on, Desktop HUD writes **two things only**:

1. **Quick capture** adds the line you type to the end of your backlog note.
2. **Open this week** (in the tray menu, or its hotkey if you've set one) creates this week's note in your weekly folder if there isn't one yet. An existing note is opened, not changed.

It never deletes, renames or moves a file, and it never edits any other note.

With writing off, quick capture tells you writing is off, and Open this week opens the note only if it already exists.

## Backups

Before every write, Desktop HUD:

- reads the file again and refuses to write if it changed since it was read, so it never overwrites an edit you just made in another app;
- keeps a copy of the previous version: the last 20 versions of each file, in the `backups` folder of its data folder (see [Uninstalling and your data](uninstall.md));
- writes to a temporary file first and swaps it in, so a crash or a full disk can't leave a half-written note.

To get an old version back, open the `backups` folder, find the note's folder, and copy the version you want over the note.

## If your folder moves

If you move or rename your notes folder, the Notes card turns red and says it can't find the folder, and the Intentions bubble says so too. Choose **Fix: choose the folder…** and pick it again, then **Apply and restart**.
