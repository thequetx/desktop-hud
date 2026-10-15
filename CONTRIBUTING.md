# Contributing

Thanks for wanting to help. Desktop HUD is maintained in spare time, so please
read this first. It saves us both a round trip.

## Before you start

- **Bugs:** open an issue with the bug template, and attach the diagnostics
  file (**Display & HUD → Integrations → Your data → Save diagnostics…**). It
  has links, paths and email addresses removed.
- **Features:** start a Discussion before writing code. The project keeps a
  small scope on purpose (see the README); a quick "would this fit?" can save
  you a pull request that can't be merged.
- **Security problems:** never in a public issue; see [SECURITY.md](SECURITY.md).

## Setting up

You need Windows 10 or 11 and Node.js 24.

```bash
npm ci
# npm 11 holds back install scripts; these two are needed:
node node_modules/esbuild/install.js
node node_modules/electron/install.js
npm run app
```

`npm run app` runs the Vite dev server and Electron with hot reload.

When running from source (never in an installed build), settings can be
overridden with environment variables or a git-ignored `.env` file in the repo
root, using these names:

| Variable | Setting |
|---|---|
| `DHUD_VAULT_PATH` | a notes folder (absolute path) |
| `DHUD_WEEKLY_DIR`, `DHUD_DAILY_DIR`, `DHUD_BACKLOG_PATH` | folders and backlog note, relative to it |
| `DHUD_TASK_TAG`, `DHUD_TASK_FOLDERS` | the `#thisweek` tag, and the folders it is looked for in |
| `DHUD_ICS_URL` | a calendar link (a secret: keep it out of commits) |
| `DHUD_NOWPLAYING_PLAYER` | show music from one app only |
| `DHUD_DEV=1` | load pages from the dev server |

Use `--profile <folder>` to run with a separate settings folder, so a test run
never touches your real one.

## Checks

Run these before opening a pull request. CI runs them too.

```bash
npx tsc --noEmit -p .        # types
npx vitest run               # unit tests
npm run build && npm run smoke   # every page renders under the release CSP
npm run pack && npm run matrix   # the built app, seven set-ups, zero console errors
node scripts/release-check.mjs --source   # nothing personal in the source
node scripts/notices.mjs --check          # third-party notices are current
```

UI changes: run `npx electron scripts/design-shots.mjs before` on `master` and
`after` on your branch. Then put the before and after screenshots in the pull
request.

## House rules

- **No new runtime dependencies** without a Discussion first. Everything that
  ships must be MIT-compatible; `scripts/notices.mjs` checks this.
- **Trust model:** the renderer never names a file path; main resolves paths
  and checks them. Every new IPC channel needs an argument spec in
  `electron/ipcguard.cjs`, a preload entry, and stubs in `scripts/smoke.mjs`
  and `scripts/design-shots.mjs`.
- **Notes are other people's data.** Nothing writes to a notes folder except
  through `electron/safewrite.cjs`, and only when writing is on.
- **Copy** is short and plain, for someone who has never seen the app.
- **Colours** come from `src/styles/tokens.css`: cobalt is the accent, gold
  means done, crimson means urgent and nothing else. Text over the desktop must
  reach 4.5:1 (design-shots measures it).

By contributing you agree your work is released under the [MIT licence](LICENSE).
