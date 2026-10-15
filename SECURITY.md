# Security

## Reporting a problem

Please report security problems **privately**, through GitHub's
[private vulnerability reporting](../../security/advisories/new) for this
repository. Don't open a public issue for them.

Say what you found, how to reproduce it, and what version you tested. You'll
get an acknowledgement when the report is read. This is a hobby project, so
that may take a few weeks, not days. Fixes go into the next release, and the
advisory credits you if you'd like.

Only the latest release is supported.

## What Desktop HUD defends against

Desktop HUD runs on your PC, shows text that other people may have written
(calendar events, notes), and fetches your calendar links. It is built to stay
safe when that input is hostile.

**In scope:**

- **Hostile calendar and note content.** Calendars are parsed in a separate
  process with a time limit and caps. Pages may run only their own bundled
  scripts (a strict Content Security Policy), can't navigate away or open
  windows, and every message they send the main process is checked against a
  declared shape. Note reads stay inside the chosen folder, links included.
- **Web pages reaching local ports.** The app runs no local web server. Its
  pages are served from an internal `app://` origin, not from files.
- **Planted files** beside the app or in its data folder. An installed build
  never reads `.env` files or environment variables, runs Windows tools by full
  path, and loads code only from its own signed-in-place archive (Electron's
  integrity fuses are on).
- **The update and release channel.** Releases are built only by GitHub
  Actions from tags, with actions pinned to exact commits, and a person reviews
  each draft before it's published. Each release lists SHA-256 checksums.
  Checksums help you check a download; they don't protect against a takeover of
  the release account. The installer isn't code-signed yet.
- **Your secrets.** Calendar links are bearer secrets: they are stored
  encrypted with Windows' data protection, never logged, never shown again
  after entry, and left out of diagnostics and exports.
- **Your notes.** A folder you point it at is read-only unless you turn writing
  on. Every write re-reads the file first and refuses if it changed, keeps a
  backup, and replaces the file atomically. It never deletes or renames your
  files.

**Out of scope:**

- Malware already running as your Windows user. It can read anything you can,
  including Desktop HUD's data.
- Someone with physical access to your unlocked PC.

## Data the app keeps

Settings, encrypted calendar links, a calendar cache, backups of notes it wrote
to, and its built-in notes all live in `%APPDATA%\Desktop HUD`. "Remove all my
data" in the app, or the uninstaller, deletes them. See
[docs/uninstall.md](docs/uninstall.md).
