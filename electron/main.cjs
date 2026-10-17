'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  Tray,
  globalShortcut,
  ipcMain,
  nativeImage,
  powerMonitor,
  screen,
  safeStorage,
  session,
  shell,
  utilityProcess,
  protocol,
} = require('electron');
const appProtocol = require('./appprotocol.cjs');
const diagnostics = require('./diagnostics.cjs');
const dataCleanup = require('./datacleanup.cjs');
const { fitToWorkArea } = require('./windowfit.cjs');
// Recent log lines, in memory, for "Save diagnostics…" (Phase 9.6).
diagnostics.captureConsole();

// A packaged public build refuses to run with a debugging port or pipe
// (Phase 9.6, trust model S10): either would let another program drive the app
// and read what it shows. The owner's builds allow it for the live checks
// (`npm run pack` / `dist` set desktopHud.allowDebugPort in the packaged
// package.json); `npm run dist:public` doesn't.
if (app.isPackaged && !((require('../package.json').desktopHud || {}).allowDebugPort === true)) {
  if (process.argv.some((a) => /^--(remote-debugging-port|remote-debugging-pipe|inspect)/.test(a))) {
    console.error('[wd] refusing to start with a debugging port in a release build');
    app.exit(1);
  }
}
// Before ready: the pages are served over app://hud/ (Phase 9.4).
appProtocol.registerScheme(protocol);
const { makeVault, currentWeekId, isWeekId, isoWeekId, sectionBounds } = require('./vault.cjs');
const skeletonStore = require('./skeleton.cjs');
const presentationStore = require('./presentation.cjs');
const hudHover = require('./hudhover.cjs');
const { makeWidgetSources } = require('./widgets.cjs');
const { makeSafeWriter } = require('./safewrite.cjs');
const { detectConventions, cleanRel, cleanTag } = require('./notesdetect.cjs');
const { makeNowPlaying, normalizePlayerFilter } = require('./platform/win32/nowplaying.cjs');
const { makeStartup } = require('./platform/win32/startup.cjs');
const { loadPrivateAddons, callAddon } = require('./addon-host.cjs');
const { pickFocusEvent, obsidianUri } = require('./focus.cjs');
const { installWindowGuards, denyAllPermissions } = require('./guards.cjs');
const { makeCalendarSources, normaliseSources } = require('./calsources.cjs');
const { makeParserHost } = require('./icsparse-host.cjs');

// Phase 9.2 — the app is Desktop HUD, and its data lives in
// %APPDATA%\Desktop HUD (Electron's userData, from package.json's
// productName). It used to pin the name back to "week-dashboard" so the old
// folder kept working; that folder is now imported once by settings.cjs
// (importLegacy, below) and left untouched, so the old build still runs on it.
const settingsLib = require('./settings.cjs');

// Phase 9.0 — `--profile <dir>` (or `--profile=<dir>`) runs the app on a
// separate userData folder, so a clean profile can run beside the installed
// app: Electron's single-instance lock lives in userData, so a different
// folder is a different instance. A profile instance also leaves alone what
// belongs to the real install: it never imports a Week Dashboard install,
// never changes the login item, and its add-ons are told so (ctx.profile).
const PROFILE_DIR = (() => {
  const argv = process.argv;
  const at = argv.findIndex((a) => a === '--profile' || a.startsWith('--profile='));
  if (at === -1) return null;
  const value = argv[at].startsWith('--profile=') ? argv[at].slice('--profile='.length) : argv[at + 1];
  if (!value || value.startsWith('--')) {
    console.error('[wd] --profile needs a folder: --profile <dir>');
    return null;
  }
  return path.resolve(value);
})();
if (PROFILE_DIR) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  app.setPath('userData', PROFILE_DIR);
  console.log(`[wd] profile: ${PROFILE_DIR}`);
}

// Establish ownership before any migration, cleanup or settings write.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
  return;
}

// ---- config -----------------------------------------------------------------
//
// Phase 9.2: config.json and an encrypted secrets file in userData
// (electron/settings.cjs). A packaged build reads nothing else. A dev run
// (unpacked) also reads the repo's .env and the environment (DHUD_<NAME>, then
// the old WD_<NAME>) over config.json.

// Finish removal before migration/providers can recreate data. A completed
// reset must not import the old installation again.
let cleanupWasRequested = false;
try {
  const cleanup = dataCleanup.retry(app.getPath('userData'));
  cleanupWasRequested = cleanup.requested;
  if (cleanup.pending.length) {
    dialog.showErrorBox('Data removal is not finished', 'Some Desktop HUD files are still in use. Close other copies of the app and start it again to retry. Your notes folder has not been changed.');
    app.exit(1);
    return;
  }
} catch (err) {
  dialog.showErrorBox('Data removal needs attention', 'Desktop HUD could not finish its saved cleanup request. Its data has been kept. Check the data folder permissions before trying again.');
  app.exit(1);
  return;
}
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');
const SECRETS_FILE = path.join(app.getPath('userData'), 'secrets.bin');
const LEGACY_DIR = path.join(app.getPath('appData'), 'week-dashboard');
// Where a Week Dashboard install kept its .env: its userData, and the source
// checkout the packaged build used to read. Read once, by the import below.
const LEGACY_ENV_FILES = [path.join(LEGACY_DIR, '.env'), path.join(os.homedir(), 'week-dashboard', '.env')];

// Phase 9.3 — the owner's private add-ons (none in the public build). Loaded
// first: they declare settings of their own, which the import and S include.
const addons = loadPrivateAddons();
const FIELDS = [...settingsLib.FIELDS, ...settingsLib.addonFields(addons)];

let configState = settingsLib.readConfig(CONFIG_FILE);
/** Secrets from the legacy import, stored once encryption is ready (app ready). */
let pendingSecrets = null;
// First run as Desktop HUD on a machine that had Week Dashboard: carry its
// settings across. Never for a --profile run, which is a clean profile.
if (!configState.existed && !PROFILE_DIR && !cleanupWasRequested) {
  const imported = settingsLib.importLegacy({
    legacyDir: LEGACY_DIR,
    newDir: app.getPath('userData'),
    envFiles: LEGACY_ENV_FILES,
    fields: FIELDS,
  });
  if (imported) {
    settingsLib.writeConfig(CONFIG_FILE, imported.config);
    pendingSecrets = imported.secrets;
    configState = settingsLib.readConfig(CONFIG_FILE);
    console.log(`[wd] settings: imported Week Dashboard's settings (${imported.copied.length} files copied)`);
  }
}
if (settingsLib.initialiseOnboarding(configState)) {
  settingsLib.writeConfig(CONFIG_FILE, configState.config);
}
if (configState.error) console.warn(`[wd] settings: ${configState.error}`);
if (configState.readOnly) console.warn('[wd] settings: config.json is from a newer version; it will not be changed');

function readTextIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
/** Dev-run overrides: the repo's .env, then the environment. Empty when packaged. */
const DEV_ENV = app.isPackaged
  ? {}
  : { ...settingsLib.parseEnv(readTextIfExists(path.join(__dirname, '..', '.env'))), ...process.env };
/** Non-secret settings, known at start-up. Secrets need encryption: see SECRETS. */
const S = settingsLib.resolveSettings({ config: configState.config, env: DEV_ENV, packaged: app.isPackaged, fields: FIELDS });

// DEV (load from the Vite dev server) vs prod (load bundled dist/). Packaged:
// always prod. Unpacked: the dev server only when asked for, with `--dev` or
// DHUD_DEV=1 (`npm run app` passes --dev). It used to probe 127.0.0.1:5173 and
// load whatever answered, with the full bridge (trust model S12).
let DEV = false;
const DEV_ORIGIN = S['dev.origin'] || 'http://127.0.0.1:5173';

// Every IPC call is checked before its handler runs (Phase 9.6): it must come
// from one of the app's own pages, with arguments of the declared shape
// (electron/ipcguard.cjs). Installed before any handler is registered.
require('./ipcguard.cjs').installIpcGuard(ipcMain, {
  isAppSender: (url) => {
    const u = String(url || '');
    if (u.startsWith(`${appProtocol.ORIGIN}/`)) return true;
    try {
      return DEV && new URL(u).origin === new URL(DEV_ORIGIN).origin;
    } catch {
      return false;
    }
  },
});

async function pickMode() {
  if (app.isPackaged) return false;
  return process.argv.includes('--dev') || DEV_ENV.DHUD_DEV === '1' || DEV_ENV.WD_DEV === '1';
}
// dist/ ships inside the asar next to electron/ — resolves in dev and packaged.
const DIST_DIR = path.join(__dirname, '..', 'dist');

// The notes provider (Phase 9.4). A folder the user points at (vault.path),
// or, without one, the built-in store: a managed folder in userData in the
// same format, so the app is useful alone. The built-in store always writes; a
// user's own folder writes only once they turn it on (vault.write, trust model
// S1). A folder whose config has no vault.write is read-only. (A one-time 9.4
// migration turned writing on for the owner's install, which wrote before
// 9.4; it was removed in 9.6 after the on/off matrix showed it also caught any
// hand-made config, and the owner's setting is saved.)
const NOTES_BUILTIN = !S['vault.path'];
const VAULT_PATH = S['vault.path'] || path.join(app.getPath('userData'), 'Notes');
if (NOTES_BUILTIN) fs.mkdirSync(VAULT_PATH, { recursive: true });
// Now playing followed only Spotify before 9.4 (the reader was started with a
// Spotify filter). An install from then keeps that, so a browser video doesn't
// take over its HUD; a new install follows any player.
if (!NOTES_BUILTIN && configState.config.nowplaying === undefined && !configState.readOnly) {
  configState.config.nowplaying = { v: 1, player: 'spotify' };
  settingsLib.writeConfig(CONFIG_FILE, configState.config);
  console.log('[wd] now playing: this install followed Spotify only; it still does (nowplaying.player)');
}
const NOTES_CAN_WRITE = NOTES_BUILTIN || Boolean(configState.config.vault && configState.config.vault.write === true);
const WEEKLY_DIR = S['vault.weeklyDir']; // An explicit empty string means the notes root.
// Empty scan scope means the whole vault. The legacy skeleton scope is
// migrated once; subsequent changes belong to the Notes settings screen.
const TASK_FOLDERS = S['vault.taskFolders'];
// Phase 5 §6's holding pen. Configurable because it moves with the project
// folder it sits in — the vault's numbered-folder reorg moved it once already.
const BACKLOG_PATH = S['vault.backlogPath'] || undefined;
// Phase 8 — notes the HUD widgets read (vault-relative). Unset hides the widget.
const DAILY_DIR = S['vault.dailyDir'] || (NOTES_BUILTIN ? 'Daily' : undefined);
const vault = makeVault({
  vaultPath: VAULT_PATH,
  tag: cleanTag(S['vault.taskTag'] || '') || '#thisweek',
  weeklyDir: WEEKLY_DIR,
  taskFolders: TASK_FOLDERS,
  backlogPath: BACKLOG_PATH,
  canWrite: NOTES_CAN_WRITE,
  // Re-read before writing, back up, replace atomically (electron/safewrite.cjs).
  writer: makeSafeWriter({ backupsDir: path.join(app.getPath('userData'), 'backups'), root: path.resolve(VAULT_PATH) }),
});
const widgetSources =
  vault && vault.ready
    ? makeWidgetSources({
        root: path.resolve(VAULT_PATH),
        dailyDir: DAILY_DIR,
      })
    : null;
if (!vault || !vault.ready) {
  console.warn(
    `[wd] notes folder not found (${path.basename(VAULT_PATH)}) — Intentions/Tasks disabled`,
  );
}

// Now playing — read from Windows' media controls (no Spotify Web API calls,
// so no quota to run out of) and handed to the HUD in-process (Phase 9.3,
// trust model S11). Add-ons read it through ctx.nowPlaying, and may add a
// queue for the Up next extra (nowPlayingExtras).
const nowPlayingFeed = makeNowPlaying({
  // Packaged: electron-builder unpacks bin/ beside app.asar (asarUnpack).
  exe: path.join(__dirname, 'bin', 'smtc-reader.exe').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`),
  // A word the player's app id must contain (config nowplaying.player, e.g.
  // "spotify"), or any player (Phase 9.4).
  player: S['nowplaying.player'] || (configState.config.nowplaying || {}).player || '*',
});

/**
 * A calendar provider from a private add-on (`calendar`), or null. The
 * google:* and cal:* channels, the sync triggers and focus mode go through it;
 * without one the HUD reads the calendar link (Phase 9.3).
 */
const calProvider = (addons.find((a) => a.calendar) || {}).calendar || null;
/** What add-ons see as settings: S at first, then with secrets once the app is ready. */
let addonSettings = S;
/** The events slot: the user's calendar links and files (Phase 9.4). */
/** @type {ReturnType<typeof makeCalendarSources> | null} */ let calSources = null;
// Calendar delta poll. Only ticks while a window is actually on screen — a
// hidden background app has nothing to keep fresh.
const CAL_POLL_MS = 90_000;
// Vault fallback sweep, for the watch events Windows drops under load and for
// anything that changed while the machine was asleep. Cheap now that the sweep
// is mtime-gated (electron/vault.cjs) — it stats rather than reads.
const VAULT_POLL_MS = 4 * 60 * 1000;
// Global hotkeys (Phase 9.2, trust model S6): only the ones set in config.json
// are registered; a new profile has none, and the Week Dashboard import brings
// the old four across (settings.cjs HOTKEYS). An empty string means unset.
/** Opens this week's note (in Obsidian for an Obsidian vault, else the default Markdown app). */
const HOTKEY_WEEK = S.hotkeys.week;
/** Focus on the calendar block happening now, or stop the running session. */
const HOTKEY_FOCUS = S.hotkeys.focus;
const HOTKEY_HUD = S.hotkeys.hud;
/** Phase 5 §6 — quick capture straight into the backlog. */
const HOTKEY_CAPTURE = S.hotkeys.capture;
// Developer hotkeys: unpacked runs only, never in an installed build.
const HOTKEY_HUD_DEBUG = 'CommandOrControl+Alt+Shift+H';
const HOTKEY_QUIT = 'CommandOrControl+Alt+Shift+W';
const HOTKEY_AMBIENT_TEST = 'CommandOrControl+Alt+Shift+A';

/** "  (Ctrl+Alt+H)" for a tray label, or nothing when the hotkey is unset. */
function hotkeyHint(accel) {
  return accel ? `  (${accel.replace(/CommandOrControl|CmdOrCtrl/g, 'Ctrl')})` : '';
}

// HUD windows, one per anchor in use (Phase 8). Each is sized to its rendered
// content via the `hud:resize` IPC.
// Phase 9.3 — the private add-ons' bubbles join the built-ins before anything
// reads presentation.json (the add-ons themselves load with the config, above).
for (const a of addons) {
  presentationStore.registerWidgetDefaults(a.widgets);
  if (a.presentation) presentationStore.registerPresentationExtension({ id: a.id, ...a.presentation });
}
if (addons.length) console.log(`[wd] add-ons: ${addons.map((a) => a.id).join(', ')}`);

let presentation = presentationStore.defaults();

/** @type {BrowserWindow | null} */ let settingsWin = null;
// Display & HUD is made when it is first opened and destroyed this long after
// it is hidden: a settings window kept loaded all day cost ~40 MB for a page
// opened a few times a week (Phase 9.6, Bug Log #62).
const SETTINGS_KEEP_MS = 2 * 60 * 1000;
let settingsDropTimer = null;
/** @type {BrowserWindow | null} */ let ambientWin = null;
/** @type {Map<string, BrowserWindow>} anchor → that corner's HUD window */
const hudWins = new Map();
/** @type {WeakMap<BrowserWindow, number>} the content height each HUD window last reported */
const hudHeights = new WeakMap();
/** @type {BrowserWindow | null} */ let captureWin = null;
// Phase 6 §2 — the block the HUD is counting down, if any. Held here rather
// than in a renderer so the tray and the hotkey can start and stop one, and so
// every HUD corner agrees on what is being focused.
/** @type {{uid:string,title:string,start:string,end:string} | null} */
let focusSession = null;
/** Ends the session a little after its block does — nothing else would. */
let focusTimer = null;
/** Blocks already escalated this run, keyed `name@ISO-start`, so the HUD is
 *  summoned once per occurrence and not on every tick — being shown a panel you
 *  just dismissed is worse than not being shown one. */
const escalated = new Set();

/**
 * End the current focus session. Deliberately a plain function and not only an
 * IPC handler: the HUD is click-through, so the panel that *shows* a session
 * can't be the only thing able to end one. The tray, the hotkey and the timer
 * all call this (bug #20/#21).
 */
function endFocus() {
  clearTimeout(focusTimer);
  focusTimer = null;
  if (!focusSession) return false;
  focusSession = null;
  broadcast('focus:changed', null);
  refreshTray();
  return true;
}
/** @type {Tray | null} */ let tray = null;
let ambientVisible = false;
let ambientForced = false; // test-toggle override
let hudVisible = false;
let idleTimer = null;
let trayTimer = null;
let calTimer = null;
let vaultTimer = null;
let stopVaultWatch = null;

// ---- helpers --------------------------------------------------------------

/** Push to every window. `exceptSender` skips the renderer that caused the
 *  change — it has already updated itself, so telling it again only costs a
 *  second render of identical content. */
/**
 * Import the effective legacy skeleton task scope once. Settings owns the
 * scope after migration; a changed scope forces the next scan.
 */
async function applyTaskFolders() {
  if (!vault || !vault.ready) return;
  let list = null;
  try {
    list = skeletonStore.taskFolders(await skeletonStore.read());
  } catch (err) {
    console.error('[wd] skeleton: could not read task_folders', err);
  }
  const migration = settingsLib.migrateTaskScope(configState.config, list, TASK_FOLDERS);
  const next = migration.folders;
  if (migration.changed && !configState.readOnly) {
    settingsLib.writeConfig(CONFIG_FILE, configState.config);
  }
  if (!vault.setTaskFolders(next)) return;
  const scope = vault.taskFolders;
  console.log(
    `[wd] #thisweek sweep scope: ${scope.length ? scope.join(', ') : 'the whole vault'}`,
  );
  if (await vault.rescan({ force: true })) broadcast('vault:changed');
}

function broadcast(channel, payload, exceptSender) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    if (exceptSender && w.webContents === exceptSender) continue;
    w.webContents.send(channel, payload);
  }
}

// A locked screen shows nothing, so nothing polls (Phase 9.6, the CPU
// target): the media reader stops and the calendar and notes timers skip,
// until unlock. On battery those timers run at a third of the rate.
let screenLocked = false;
let systemSuspended = false;
let onBattery = false;
const activityState = () => ({ paused: screenLocked || systemSuspended, battery: onBattery });
function restartPolling() {
  for (const timer of [idleTimer, trayTimer, calTimer, vaultTimer]) clearInterval(timer);
  idleTimer = trayTimer = calTimer = vaultTimer = null;
  const state = activityState();
  Promise.resolve(calSources?.setPaused(state.paused)).catch(err => console.warn('[wd] calendar resume', err.message));
  calSources?.setBatterySaver(state.battery);
  hoverPoll.sync();
  broadcast('power:changed', state);
  if (state.paused) { nowPlayingFeed.stop(); return; }
  nowPlayingFeed.start();
  const factor = state.battery ? 3 : 1;
  idleTimer = setInterval(pollIdle, 1000 * factor);
  trayTimer = setInterval(refreshTray, 60_000 * factor);
  calTimer = setInterval(() => { if (anyWindowVisible()) syncCalendar(); }, CAL_POLL_MS * factor);
  if (vault?.ready) vaultTimer = setInterval(() => { if (anyWindowVisible()) rescanVault(); }, VAULT_POLL_MS * factor);
}

function anyWindowVisible() {
  if (activityState().paused) return false;
  return [settingsWin, ambientWin, ...hudWins.values()].some(
    (w) => w && !w.isDestroyed() && w.isVisible(),
  );
}

// Ask the provider for a delta pass. Cheap and self-throttling (the provider coalesces
// concurrent callers and floors the gap between attempts), so every trigger —
// the poll, window show/focus, wake-from-sleep — can just call this.
function syncCalendar(force) {
  if (activityState().paused) return;
  // The calendar links: refetch any older than their interval, re-parse when
  // the week has turned. Cheap when nothing is due.
  if (calSources) calSources.catchUp(force ? 0 : undefined).catch((err) => console.error('[wd] calendar sources', err));
  if (!calProvider || !calProvider.connected()) return;
  Promise.resolve(calProvider.sync({ force })).catch((err) => console.error('[wd] cal sync', err));
}

/** Wire events in a range from every calendar: the user's sources and an
 *  add-on provider, merged and deduplicated (electron/calsources.cjs). */
function eventsInRange(minIso, maxIso) {
  const extra = calProvider && calProvider.connected() ? calProvider.eventsInRange(minIso, maxIso) : [];
  return calSources ? calSources.eventsInRange(minIso, maxIso, extra) : extra;
}

// The vault equivalent: a stat-only pass that only tells the renderers when a
// file actually moved. Self-throttling (vault.cjs floors the gap), so every
// trigger — the slow timer, window show/focus, wake-from-sleep — just calls it.
function rescanVault(force) {
  if (activityState().paused) return;
  if (!vault || !vault.ready) return;
  vault
    .rescan({ force })
    .then((changed) => {
      if (changed) broadcast('vault:changed');
    })
    .catch((err) => console.error('[wd] vault rescan', err));
}

function loadRoute(win, page, query) {
  if (DEV) {
    const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
    return win.loadURL(`${DEV_ORIGIN}/${page}${qs}`);
  }
  return win.loadURL(appProtocol.pageUrl(page, query));
}

function fadeTo(win, target, ms = 450) {
  if (!win || win.isDestroyed()) return;
  const start = win.getOpacity();
  const steps = Math.max(1, Math.round(ms / 16));
  let i = 0;
  const tick = () => {
    if (!win || win.isDestroyed()) return;
    i += 1;
    const v = start + (target - start) * (i / steps);
    win.setOpacity(Math.min(1, Math.max(0, v)));
    if (i < steps) setTimeout(tick, 16);
    else if (target === 0) win.hide();
  };
  tick();
}

// ---- Display & HUD settings window ------------------------------------------------
//
// The bubble editor and screen settings that used to open over the planner, in
// a window of their own. Made on first open and dropped a while after it is
// hidden (Phase 9.6). showSettings sends its target once the page has loaded,
// so an arrange-mode ✎ still lands on the right bubble the first time.

// The preferred size; fitToWorkArea shrinks it to the display it opens on.
const SETTINGS_SIZE = { width: 1180, height: 840, minWidth: 960, minHeight: 620 };

/** Where Display & HUD should open: the display the pointer is on. */
function settingsWorkArea() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
}

function createSettings() {
  const fit = fitToWorkArea(SETTINGS_SIZE, settingsWorkArea());
  settingsWin = new BrowserWindow({
    x: fit.x,
    y: fit.y,
    width: fit.width,
    height: fit.height,
    minWidth: fit.minWidth,
    minHeight: fit.minHeight,
    show: false,
    frame: false,
    resizable: true,
    title: 'Display & HUD',
    backgroundColor: '#0b1222',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Phase 9.0 (S10): no DevTools in a packaged build.
      devTools: !app.isPackaged,
    },
  });
  // Level with the HUD corners it edits, so a live preview can't cover it.
  settingsWin.setAlwaysOnTop(true, 'floating');
  loadRoute(settingsWin, 'index.html');
  settingsWin.on('close', (e) => {
    // Hide instead of destroy — this is a background app.
    if (!app.isQuitting) {
      e.preventDefault();
      settingsWin.hide();
    }
  });
  // However the window went away (Save, Cancel, Esc, Alt+F4), an unsaved
  // preview must not stay on the HUD, and a "Preview now" of the idle screen
  // must not stay over the desktop. After a Save the revert re-reads what was
  // just written, so it changes nothing.
  settingsWin.on('hide', () => {
    if (settingsDropTimer) clearTimeout(settingsDropTimer);
    settingsDropTimer = setTimeout(() => {
      settingsDropTimer = null;
      const w = settingsWin;
      if (w && !w.isDestroyed() && !w.isVisible()) {
        settingsWin = null;
        w.destroy();
      }
    }, SETTINGS_KEEP_MS);
    endAmbientPreview();
    void revertPreview();
  });
  settingsWin.on('show', () => {
    if (settingsDropTimer) clearTimeout(settingsDropTimer);
    settingsDropTimer = null;
    syncCalendar();
    rescanVault();
  });
}

/** Show Display & HUD — optionally straight at one bubble (`{ bubbleId }`) or
 *  at a new one for a corner (`{ newAt }`), which is how arrange mode's ✎ and
 *  + hand over to the full editor. Every open starts a fresh editor. */
function showSettings(target) {
  if (!settingsWin || settingsWin.isDestroyed()) createSettings();
  const send = () => settingsWin.webContents.send('presentation:open', target || null);
  if (settingsWin.webContents.isLoading()) settingsWin.webContents.once('did-finish-load', send);
  else send();
  if (!settingsWin.isVisible()) {
    // Keep a size the user chose, but never more than the display can show.
    const [width, height] = settingsWin.getSize();
    const fit = fitToWorkArea({ ...SETTINGS_SIZE, width, height }, settingsWorkArea());
    settingsWin.setMinimumSize(fit.minWidth, fit.minHeight);
    settingsWin.setBounds({ x: fit.x, y: fit.y, width: fit.width, height: fit.height });
  }
  settingsWin.show();
  settingsWin.focus();
}

function hideSettings() {
  if (settingsWin && !settingsWin.isDestroyed() && settingsWin.isVisible()) settingsWin.hide();
}

/** Stop forcing the idle screen on (Display & HUD → Preview now). */
function endAmbientPreview() {
  if (!ambientForced) return;
  ambientForced = false;
  hideAmbient();
}

/** Put the HUD back to the saved preferences, dropping any live preview. */
async function revertPreview() {
  try {
    presentation = await presentationStore.read();
    applyPresentation();
  } catch (err) {
    console.error('[wd] revert preview', err);
  }
}

// ---- ambient overlay --------------------------------------------------------

function createAmbient() {
  const target = resolvePresentationDisplay(presentation.ambient);
  const { bounds } = target;
  ambientWin = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    focusable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Phase 9.0 (S10): no DevTools in a packaged build.
      devTools: !app.isPackaged,
    },
  });
  ambientWin.setAlwaysOnTop(true, 'screen-saver');
  ambientWin.setIgnoreMouseEvents(true); // never eats clicks
  ambientWin.setOpacity(0);
  loadRoute(ambientWin, 'ambient.html');
}

function showAmbient() {
  if (!ambientWin || ambientWin.isDestroyed()) createAmbient();
  if (ambientVisible) return;
  ambientVisible = true;
  const { bounds } = resolvePresentationDisplay(presentation.ambient);
  ambientWin.setBounds(bounds);
  ambientWin.setOpacity(0);
  ambientWin.showInactive(); // never steals focus
  fadeTo(ambientWin, 1);
}

function hideAmbient() {
  if (!ambientVisible || !ambientWin || ambientWin.isDestroyed()) return;
  ambientVisible = false;
  fadeTo(ambientWin, 0);
}

function pollIdle() {
  if (ambientForced) return;
  if (!presentation.ambient.enabled) { if (ambientVisible) hideAmbient(); return; }
  const state = powerMonitor.getSystemIdleState(presentation.ambient.idleSeconds);
  if (state === 'idle' && !ambientVisible) showAmbient();
  else if (state !== 'idle' && ambientVisible) hideAmbient();
}

// ---- persistent HUD -------------------------------------------------------
// Stays up while you work (no idle logic). Click-through, never focusable.
//
// Phase 8 — one window per *anchor* (a corner of the work area) that has at
// least one enabled widget, each loading hud.html?anchor=<corner> and drawing
// only its own widgets. Separate windows rather than one full-screen canvas so
// that (a) nothing transparent sits over the whole desktop all day, and (b) a
// private corner can be excluded from screen capture on its own. Visibility is
// still one switch for all of them: Ctrl+Alt+H, the tray, escalation and focus
// mode all show or hide "the HUD", whichever corners that currently means.

/** Every display, marked with whether it is the primary one. Electron's
 *  `Display` has no `primary` field of its own — it has to be asked for
 *  separately — so without this "Primary display" silently meant "whichever
 *  display Windows lists first" (found in Phase 8 against three monitors). */
function presentationDisplays() {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d) => ({ ...d, primary: d.id === primaryId }));
}
/** The display one preference section (`ambient` or `hud`) names, found by id
 *  or, when Windows has renumbered its monitors, by the saved hint. */
function resolvePresentationDisplay(section) {
  return presentationStore.resolveDisplay(section.display, presentationDisplays(), section.displayHint) || screen.getPrimaryDisplay();
}
function hudBounds(anchor, height) {
  return presentationStore.hudBounds(presentation, height, presentationDisplays(), anchor);
}

function liveHudWins() {
  return [...hudWins.entries()].filter(([, w]) => w && !w.isDestroyed());
}

/**
 * Bring the set of HUD windows in line with the preferences: create a window
 * for a newly used anchor, close one nobody uses any more, and re-place and
 * re-protect the rest. Called on start, on every preference write and on every
 * display change, so it has to be idempotent.
 */
function syncHudWindows() {
  // Arrange mode opens every corner, so an empty one can be dropped onto or
  // added to; the rest of the time only corners with something enabled exist.
  const wanted = new Set(arranging ? presentationStore.ANCHORS : presentationStore.activeAnchors(presentation));
  for (const [anchor, w] of liveHudWins()) {
    if (!wanted.has(anchor)) {
      w.destroy();
      hudWins.delete(anchor);
    }
  }
  for (const anchor of wanted) {
    let w = hudWins.get(anchor);
    if (!w || w.isDestroyed()) {
      w = createHud(anchor);
      if (hudVisible) {
        w.showInactive();
        fadeTo(w, 1);
      }
    }
    // Excluded from capture at the OS level (WDA_EXCLUDEFROMCAPTURE on
    // Windows 10 2004+): OBS and screen shares see the desktop behind it.
    w.setContentProtection(presentationStore.isPrivate(presentation, anchor));
    // Click-through except while arranging — the one time the HUD takes clicks.
    w.setIgnoreMouseEvents(!arranging);
    w.setBounds(hudBounds(anchor, hudHeights.get(w)));
  }
  syncHoverPoll();
}

// ---- hover fade --------------------------------------------------------------
//
// The bubble under the cursor fades so the desktop behind it shows through
// (presentation.hud.hoverFade). The windows stay click-through throughout: the
// cursor is polled here and each corner is told where it is inside it. Why
// polling and not forwarded mouse events: electron/hudhover.cjs.

const hoverPoll = hudHover.makeHoverPoll({
  wanted: () => !activityState().paused && hudVisible && !arranging && presentation.hud.hoverFade === true,
  cursor: () => screen.getCursorScreenPoint(),
  windows: () => liveHudWins().map(([, w]) => w),
  onError: (err) => console.error('[wd] hud hover poll', err),
});

/** Start or stop the cursor poll to match the HUD's state. Idempotent; called
 *  from syncHudWindows (every preference write, display change and arrange
 *  toggle) and toggleHud. Stopping clears every corner's hover. */
function syncHoverPoll() {
  hoverPoll.sync();
}

// ---- arrange mode (Phase 8) ------------------------------------------------
//
// The HUD's one interactive state, entered on purpose from the tray or the
// settings window and left with Esc or Done. While it's on, every corner window takes
// clicks and draws each bubble with handles: drag to another corner, ↑/↓ to
// reorder, ✎ to edit, × to switch off, + to add. Every action is applied here,
// through presentation.cjs `applyArrange`, and saved at once — direct
// manipulation commits, like dragging a calendar block does.

let arranging = false;
/**
 * Layouts before each arrange action this session, newest last. Arrange mode
 * turns four corners of a desktop you are still using into buttons, so a
 * stray click is expected, not exceptional (found on 2026-09-23: two × clicks
 * nobody meant switched off Next up and Placed). Undo makes any of them free.
 */
const arrangeHistory = [];
const ARRANGE_HISTORY_MAX = 50;

function arrangeState() {
  return { on: arranging, canUndo: arrangeHistory.length > 0 };
}

function setArrange(on) {
  if (arranging === on) return;
  arranging = on;
  arrangeHistory.length = 0;
  if (on) {
    if (!hudVisible) toggleHud();
    // Esc anywhere ends it. Registered only for the duration, so the rest of
    // the time Esc belongs to whatever app has focus.
    globalShortcut.register('Escape', () => setArrange(false));
  } else {
    globalShortcut.unregister('Escape');
  }
  syncHudWindows();
  broadcast('hud:arrange', arrangeState());
  refreshTray();
}

/** Save, stamping each chosen display's hint so it can be found again. */
function writePresentation(next) {
  return presentationStore.write(presentationStore.syncDisplayHints(presentationStore.normalise(next), presentationDisplays()));
}

async function commitPresentation(next) {
  presentation = await writePresentation(next);
  applyPresentation();
}

/**
 * Read a vault-relative file for an add-on. Resolved against the vault root and
 * refused if it leaves the vault, checked again on the real path, so a link
 * inside the vault can't lead out (trust model S3).
 */
async function readVaultFile(rel) {
  if (!VAULT_PATH || typeof rel !== 'string' || !rel) return null;
  try {
    const root = await fs.promises.realpath(path.resolve(VAULT_PATH));
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep)) return null;
    const real = await fs.promises.realpath(abs);
    if (!real.startsWith(root + path.sep)) return null;
    return await fs.promises.readFile(real, 'utf8');
  } catch {
    return null;
  }
}

/**
 * What a private add-on gets (Phase 9.3): the settings, its own config.json
 * section (`addons.<id>`), a data folder of its own, and a few app actions.
 */
function addonContext(a) {
  return {
    settings: addonSettings,
    config: (configState.config.addons && configState.config.addons[a.id]) || {},
    dataDir: path.join(app.getPath('userData'), 'addons', a.id),
    isPackaged: app.isPackaged,
    profile: PROFILE_DIR,
    log: (m) => console.log(`[wd] ${a.id}: ${m}`),
    /** A vault note's text, or null: missing, unreadable, no vault, or outside it. */
    readVault: (rel) => readVaultFile(rel),
    /** The Windows media reader: current() is the HUD's NowPlaying, snapshot() the raw state and cover. */
    nowPlaying: { current: () => nowPlayingFeed.current(), snapshot: () => nowPlayingFeed.snapshot() },
    /** Core helpers an add-on may use (it can't require core files). */
    lib: { sectionBounds, isoWeekId },
    broadcast,
    refreshTray,
    /** Switch one of the add-on's bubbles on, if it's off. */
    enableBubble: async (id) => {
      const bubbles = presentation.hud.bubbles;
      if (!bubbles.some((b) => b.id === id && !b.enabled)) return;
      await commitPresentation({
        ...presentation,
        hud: { ...presentation.hud, bubbles: bubbles.map((b) => (b.id === id ? { ...b, enabled: true } : b)) },
      });
    },
  };
}

/** Apply one arrange action, remembering the layout it replaced. */
async function commitArrange(next) {
  if (JSON.stringify(next) === JSON.stringify(presentation)) return;
  arrangeHistory.push(presentation);
  if (arrangeHistory.length > ARRANGE_HISTORY_MAX) arrangeHistory.shift();
  await commitPresentation(next);
  broadcast('hud:arrange', arrangeState());
}

function applyPresentation() {
  if (ambientWin && !ambientWin.isDestroyed()) ambientWin.setBounds(resolvePresentationDisplay(presentation.ambient).bounds);
  syncHudWindows();
  broadcast('presentation:changed', presentation);
}

/** Re-point a renumbered display at its new id: in memory (which may be an
 *  unsaved editor preview) and, separately, on disk — so healing never saves
 *  a preview the owner might still cancel. */
async function healDisplayPrefs() {
  const displays = presentationDisplays();
  presentation = presentationStore.syncDisplayHints(presentation, displays);
  try {
    const onDisk = await presentationStore.read();
    const healed = presentationStore.syncDisplayHints(onDisk, displays);
    if (healed !== onDisk) await presentationStore.write(healed);
  } catch (err) {
    console.error('[wd] presentation: display heal failed', err);
  }
}

/**
 * A monitor came, went or changed. Windows reports this before it has finished
 * rearranging — it then moves windows itself — so a single immediate re-place
 * loses the race (found 2026-10-01: three HUD corners left mid-screen after an
 * unplug). Re-apply once things settle, and once more a little later.
 */
let displaySettleTimers = [];
function onDisplaysChanged() {
  for (const t of displaySettleTimers) clearTimeout(t);
  displaySettleTimers = [300, 1500].map((ms) =>
    setTimeout(async () => {
      await healDisplayPrefs();
      applyPresentation();
      broadcast('presentation:displays-changed', null);
    }, ms),
  );
}

/** Put any HUD window that is no longer where it belongs back in its corner.
 *  Debounced so a move in progress settles first; a window already in place
 *  is left alone, so the setBounds this causes cannot loop. */
let hudReplaceTimer;
function scheduleHudReplace() {
  clearTimeout(hudReplaceTimer);
  hudReplaceTimer = setTimeout(() => {
    for (const [anchor, w] of liveHudWins()) {
      const want = hudBounds(anchor, hudHeights.get(w));
      const have = w.getBounds();
      // ±1 px: a scaled display can round a set size, and chasing that would loop.
      const off = (k) => Math.abs(want[k] - have[k]) > 1;
      if (off('x') || off('y') || off('width') || off('height')) {
        w.setBounds(want);
      }
    }
  }, 250);
}

function createHud(anchor) {
  const win = new BrowserWindow({
    ...hudBounds(anchor),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    focusable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Phase 9.0 (S10): no DevTools in a packaged build.
      devTools: !app.isPackaged,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setIgnoreMouseEvents(true);
  win.setOpacity(0);
  win.setContentProtection(presentationStore.isPrivate(presentation, anchor));
  // Nothing but this app places a HUD window. When Windows moves one anyway —
  // it shifts windows proportionally off a monitor that disappears, and back
  // again on reconnect — put it back in its corner.
  win.on('move', () => scheduleHudReplace());
  win.on('resize', () => scheduleHudReplace());
  // The calendar/vault freshness edges, as for the other windows.
  win.on('show', () => {
    syncCalendar();
    rescanVault();
  });
  hudWins.set(anchor, win);
  // A page created while the HUD is hidden reports itself visible until it
  // has been shown once, so it is told: `shown=0` at load, the state again
  // once loaded (a toggle may have landed mid-load), then hud:shown on each
  // toggle. Decorations (and lean idle) pause on it.
  win.webContents.on('did-finish-load', () => {
    if (!win.isDestroyed()) win.webContents.send('hud:shown', hudVisible);
    // A fresh page has no hover; the next poll tells it where the cursor is.
    hoverPoll.forget(win);
  });
  loadRoute(win, 'hud.html', { anchor, shown: hudVisible ? '1' : '0' });
  return win;
}

function toggleHud() {
  if (liveHudWins().length === 0) syncHudWindows();
  // Hiding the HUD mid-arrange ends arrange mode — otherwise the next show
  // would come back clickable.
  if (hudVisible && arranging) setArrange(false);
  hudVisible = !hudVisible;
  for (const [anchor, w] of liveHudWins()) {
    if (hudVisible) {
      w.setBounds(hudBounds(anchor, hudHeights.get(w)));
      w.setOpacity(0);
      w.showInactive();
      fadeTo(w, 1);
    } else {
      fadeTo(w, 0);
    }
    // Decorations pause their timers and animations while the HUD is away.
    w.webContents.send('hud:shown', hudVisible);
  }
  syncHoverPoll();
  if (tray) tray.setContextMenu(buildTrayMenu());
}

// ---- quick capture (Phase 5 §6) -----------------------------------------
//
// The missing inbox. A small centred field on `Ctrl+Alt+N` that appends one
// line to Backlog.md and gets out of the way. Unlike the HUD and the ambient
// overlay it is *focusable* — the whole point is typing into it — and unlike
// the settings window it holds no state worth keeping, so it hides on blur.

function createCapture() {
  captureWin = new BrowserWindow({
    width: 520,
    height: 128,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Phase 9.0 (S10): no DevTools in a packaged build.
      devTools: !app.isPackaged,
    },
  });
  captureWin.setAlwaysOnTop(true, 'floating');
  // Clicking away is the same as pressing Esc: an abandoned capture is not a
  // draft worth preserving, and a stray always-on-top field is worse than none.
  captureWin.on('blur', () => hideCapture());
  loadRoute(captureWin, 'capture.html');
}

/** Centred on the display the cursor is on — the thought arrived where you're
 *  working, not on whichever monitor Windows calls primary. */
function captureBounds() {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const w = 520;
  const h = 128;
  return {
    x: Math.round(d.x + (d.width - w) / 2),
    y: Math.round(d.y + d.height * 0.28),
    width: w,
    height: h,
  };
}

function showCapture() {
  if (!captureWin || captureWin.isDestroyed()) createCapture();
  captureWin.setBounds(captureBounds());
  captureWin.show();
  captureWin.focus();
}

function hideCapture() {
  if (captureWin && !captureWin.isDestroyed() && captureWin.isVisible()) {
    captureWin.hide();
  }
}

function toggleCapture() {
  if (captureWin && !captureWin.isDestroyed() && captureWin.isVisible()) hideCapture();
  else showCapture();
}

// ---- tray + autostart ---------------------------------------------------
// Start on login lives in platform/win32/startup.cjs (Phase 9.4).
const startup = makeStartup({ app, profileDir: PROFILE_DIR, appDir: path.resolve(__dirname, '..') });

// ---- focus mode (Phase 6 §2) -----------------------------------------------
//
// Started from the tray or Ctrl+Alt+F on whatever is on the calendar right now.
// (The planner's grid was the only way in before it was archived; its end-of-
// block question went with it, since only the planner's review read the answer.)

/** How long past its end a session lingers ("ending") before it closes. */
const FOCUS_GRACE_MS = 30 * 1000;

/**
 * Start the events slot. The calendar sources live in config.json
 * `calendar.sources`; each link's URL is a secret. A config from before 9.4
 * has one link, `calendar.icsUrl`: it becomes the source `link`, keeping its
 * secret key and its cache, so nothing is re-entered or re-fetched.
 */
function startCalendarSources(secrets, settings) {
  const userData = app.getPath('userData');
  const cal = () => (configState.config.calendar && typeof configState.config.calendar === 'object' ? configState.config.calendar : {});
  const save = (sources) => {
    configState.config.calendar = { ...cal(), v: 1, sources };
    const w = settingsLib.writeConfig(CONFIG_FILE, configState.config, { readOnly: configState.readOnly });
    if (!w.ok) console.warn(`[wd] settings: ${w.reason}`);
  };
  if (!Array.isArray(cal().sources)) {
    const legacy = settings['calendar.icsUrl'] ? [{ id: 'link', kind: 'ics-url', name: 'Calendar' }] : [];
    if (legacy.length) {
      const dir = path.join(userData, 'cal-cache');
      try {
        fs.mkdirSync(dir, { recursive: true });
        const old = path.join(userData, 'ics-cache.ics');
        if (fs.existsSync(old) && !fs.existsSync(path.join(dir, 'link.ics'))) fs.renameSync(old, path.join(dir, 'link.ics'));
      } catch (err) {
        console.warn('[wd] calendar: could not move the old cache', err.message);
      }
      console.log('[wd] calendar: the calendar link is now the source "link"');
    }
    save(legacy);
  }
  // The legacy link keeps its secret key (and, in dev, its .env override).
  const keyFor = (id) => (id === 'link' ? 'calendar.icsUrl' : `calendar.sources.${id}.url`);
  const sources = makeCalendarSources({
    dir: userData,
    getSources: () => normaliseSources(cal().sources),
    saveSources: save,
    urlFor: (id) => (id === 'link' ? settings['calendar.icsUrl'] : secrets.get(keyFor(id))),
    setUrl: (id, url) => secrets.set(keyFor(id), url),
    deleteUrl: (id) => secrets.delete(keyFor(id)),
    parser: makeParserHost({ fork: (script, args, opts) => utilityProcess.fork(script, args, opts) }),
    onChange: () => broadcast('events:changed'),
  });
  sources.start().catch((err) => console.error('[wd] calendar sources', err));
  return sources;
}

/**
 * The calendar block to focus on right now (electron/focus.cjs), from every
 * calendar (Bug Log #61: it used to read only Google). Calendar only: the
 * recurring blocks are YAML the renderers parse.
 */
function focusCandidate(now = Date.now()) {
  const day = 24 * 60 * 60 * 1000;
  return pickFocusEvent(eventsInRange(new Date(now - day).toISOString(), new Date(now + day).toISOString()), now);
}

function startFocus(ev) {
  if (!ev || !ev.uid) return false;
  focusSession = {
    uid: String(ev.uid),
    title: String(ev.title || 'Focus'),
    start: String(ev.start),
    end: String(ev.end),
  };
  scheduleFocusEnd();
  broadcast('focus:changed', focusSession);
  refreshTray();
  // The one assertive thing in the app, and still only a corner panel appearing.
  if (!hudVisible) toggleHud();
  return true;
}

/**
 * (Re)arm the timer that ends the session a little after its block. Also run
 * on wake: timers don't advance while the machine sleeps, so a session whose
 * block ended during sleep would otherwise run on for as long as it slept.
 */
function scheduleFocusEnd() {
  clearTimeout(focusTimer);
  focusTimer = null;
  if (!focusSession) return;
  const left = Date.parse(focusSession.end) + FOCUS_GRACE_MS - Date.now();
  if (left <= 0) endFocus();
  else focusTimer = setTimeout(() => endFocus(), left);
}

function toggleFocus() {
  if (focusSession) endFocus();
  else if (!startFocus(focusCandidate())) console.log('[wd] focus: nothing on the calendar right now');
}

// ---- diagnostics (Phase 9.6, S5) --------------------------------------------

/** "Save diagnostics…": a redacted report (electron/diagnostics.cjs) where the user chooses. */
async function saveDiagnostics(parent) {
  const pick = await dialog.showSaveDialog(parent && !parent.isDestroyed() ? parent : undefined, {
    title: 'Save diagnostics',
    defaultPath: `desktop-hud-diagnostics-${new Date().toISOString().slice(0, 10)}.txt`,
    filters: [{ name: 'Text', extensions: ['txt'] }],
  });
  if (pick.canceled || !pick.filePath) return { ok: false, canceled: true };
  const sources = calSources ? calSources.list() : [];
  const report = diagnostics.buildReport({
    app: {
      version: app.getVersion(),
      electron: process.versions.electron,
      packaged: app.isPackaged,
      profile: Boolean(PROFILE_DIR),
      addons: addons.length,
    },
    settings: {
      onboarded: Boolean(configState.config.onboarding && configState.config.onboarding.done),
      notes: NOTES_BUILTIN ? 'built-in' : 'folder',
      notesFound: Boolean(vault && vault.ready),
      notesWrite: Boolean(vault && vault.canWrite),
      calendars: sources.map((c) => ({ kind: c.kind, events: c.count, updated: Boolean(c.fetchedAt), error: c.lastError || null })),
      provider: calProvider ? calProvider.status() && { configured: calProvider.status().configured, connected: calProvider.status().connected } : null,
      nowPlayingOneApp: Boolean((configState.config.nowplaying || {}).player),
      hotkeys: Object.keys((configState.config.hotkeys || {})).length,
      bubblesOn: presentation.hud.bubbles.filter((b) => b.enabled).length,
      backdrop: presentation.hud.backdrop,
      locale: presentation.locale,
      displays: screen.getAllDisplays().length,
    },
  });
  fs.writeFileSync(pick.filePath, report, 'utf8');
  return { ok: true };
}

// ---- this week's note -----------------------------------------------------------

/**
 * Ctrl+Alt+W — where the week is planned and reviewed now. Creates the note
 * from the template first if it doesn't exist yet (the archived planner's
 * "create week" did the same), so the hotkey never opens nothing.
 */
async function openThisWeek() {
  if (!vault || !vault.ready) return;
  try {
    const r = await vault.createWeek(currentWeekId());
    // Read-only and no note yet: nothing to open.
    if (!r || !r.notePath || (!r.ok && !fs.existsSync(path.join(vault.root, r.notePath)))) return;
    if (r.created) broadcast('vault:changed');
    // An Obsidian vault opens in Obsidian; any other folder (the built-in
    // store included) in the default Markdown app.
    if (fs.existsSync(path.join(vault.root, '.obsidian'))) {
      await shell.openExternal(obsidianUri(path.basename(vault.root), r.notePath));
    } else {
      await shell.openPath(path.join(vault.root, r.notePath));
    }
  } catch (err) {
    console.error('[wd] open this week', err);
    void dialog.showMessageBox({ type: 'error', title: 'Could not open this week',
      message: 'Desktop HUD could not create or open the weekly note.',
      detail: 'Check the Notes folder and writing permission in Display & HUD → Integrations. The existing note and template have been kept.', buttons: ['OK'] });
  }
}

// ---- tray menu --------------------------------------------------------------

function buildTrayMenu() {
  const candidate = focusSession ? null : focusCandidate();
  return Menu.buildFromTemplate([
    {
      label: (hudVisible ? 'Hide HUD' : 'Show HUD') + hotkeyHint(HOTKEY_HUD),
      click: () => toggleHud(),
    },
    {
      label: arranging ? 'Finish arranging  (Esc)' : 'Arrange HUD…',
      click: () => setArrange(!arranging),
    },
    { label: 'Display & HUD…', click: () => showSettings() },
    { label: 'Save diagnostics…', click: () => saveDiagnostics() },
    { type: 'separator' },
    focusSession
      ? {
          label: `End focus: ${focusSession.title.slice(0, 40)}${hotkeyHint(HOTKEY_FOCUS)}`,
          click: () => endFocus(),
        }
      : {
          label: candidate
            ? `Focus on: ${String(candidate.title).slice(0, 40)}${hotkeyHint(HOTKEY_FOCUS)}`
            : 'Focus: nothing on the calendar now',
          enabled: Boolean(candidate),
          // Asked again on click: the menu can be a minute old.
          click: () => startFocus(focusCandidate()),
        },
    { type: 'separator' },
    {
      label: 'Open this week' + hotkeyHint(HOTKEY_WEEK),
      enabled: Boolean(vault && vault.ready),
      click: () => void openThisWeek(),
    },
    { label: 'Quick capture' + hotkeyHint(HOTKEY_CAPTURE), click: () => showCapture() },
    { label: 'Edit recurring blocks…', click: () => skeletonStore.openInEditor() },
    { type: 'separator' },
    {
      label: 'Start on login (HUD)',
      type: 'checkbox',
      checked: startup.checked(),
      // The login item is per Windows user, not per profile.
      enabled: !PROFILE_DIR,
      click: (item) => {
        startup.set(item.checked);
        tray?.setContextMenu(buildTrayMenu());
      },
    },
    // Private add-ons' tray items (Phase 9.3).
    ...addons.flatMap((a) => {
      try {
        return typeof a.tray === 'function' ? a.tray(addonContext(a)) : [];
      } catch (err) {
        console.error(`[wd] add-on ${a.id}: tray`, err);
        return [];
      }
    }),
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function refreshTray() {
  tray?.setContextMenu(buildTrayMenu());
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip('Desktop HUD');
  tray.on('click', () => toggleHud());
  refreshTray();
}

// ---- lifecycle --------------------------------------------------------------

{
  // 'second-instance' used to be registered here, before whenReady(). But
  // whenReady() below awaits pickMode() — a ~500ms dev-server probe — before
  // creating the windows, and a second launch landing in that gap created a
  // window of its own that was then orphaned (it happened with the planner).
  // Rather than drop a second-instance signal that arrives before we're
  // ready, latch it in a flag and act on it once startup finishes — see below.
  let earlySecondInstance = false;
  const preReadySecondInstance = () => {
    earlySecondInstance = true;
  };
  app.on('second-instance', preReadySecondInstance);

  // Phase 9.0 (S3, S10): windows stay on the app's own pages, open nothing,
  // and get no browser permissions. Installed before the first window exists.
  installWindowGuards(app, () => ({ distDir: DIST_DIR, devOrigin: DEV ? DEV_ORIGIN : null }));

  app.whenReady().then(async () => {
    appProtocol.serve(protocol, DIST_DIR);
    denyAllPermissions(session.defaultSession);
    // Secrets need encryption, which needs the app ready. Store the legacy
    // import's (the calendar link, the Google client secret) first.
    const secrets = settingsLib.makeSecrets({ file: SECRETS_FILE, safeStorage });
    const fin = settingsLib.finishLegacySecrets({ config: configState.config, pending: pendingSecrets, secrets, fields: FIELDS });
    pendingSecrets = null;
    if (fin.changed) {
      settingsLib.writeConfig(CONFIG_FILE, configState.config, { readOnly: configState.readOnly });
      if (fin.failed.length) console.warn(`[wd] settings: could not store ${fin.failed.length} secret(s); encryption unavailable. Will retry next start.`);
    }
    const SECRETS = settingsLib.resolveSettings({ config: configState.config, secrets, env: DEV_ENV, packaged: app.isPackaged, fields: FIELDS });
    addonSettings = SECRETS;
    // The events slot (Phase 9.4): the user's calendar links and files. Before
    // any window, so the first calendar read already has the cached events.
    calSources = startCalendarSources(secrets, SECRETS);
    DEV = await pickMode();
    console.log(`[wd] ${DEV ? 'dev (vite server)' : 'prod (dist/)'}`);

    // Private add-ons start before any window exists, so the first calendar
    // read already finds a provider (Phase 9.3).
    for (const a of addons) {
      try {
        if (typeof a.start === 'function') a.start(addonContext(a));
      } catch (err) {
        console.error(`[wd] add-on ${a.id}: start`, err);
      }
    }
    if (!calProvider || !calProvider.status().configured) {
      console.warn('[wd] no calendar provider — the calendar link is used');
    }

    skeletonStore.init({
      distDir: DIST_DIR,
      devDir: path.join(__dirname, '..', 'public'),
      taskFolders: TASK_FOLDERS.split(','),
    });
    presentationStore.init();
    presentation = await presentationStore.read();
    await healDisplayPrefs();
    await applyTaskFolders();

    // Display & HUD is made on first open (showSettings), not here.
    createAmbient();
    syncHudWindows();
    createTray();
    // First run: the set-up wizard, in Display & HUD (Phase 9.5).
    if (!(configState.config.onboarding && configState.config.onboarding.done)) showSettings({ onboarding: true });

    // A chosen display that is absent falls back to primary without the
    // preference being rewritten, so reconnecting restores it. Windows display
    // ids are NOT stable across a reconnect, driver reset or reboot, so the
    // choice is also found again by its saved hint (model and geometry).
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
      screen.on(event, () => onDisplaysChanged());
    }

    // The HUD *is* the app now, so every start shows it — the login item's
    // `--hud` and a Start-menu launch alike. (While the planner existed a
    // plain start stayed quiet in the tray and the planner was summoned.)
    toggleHud();

    // Swap the placeholder listener for the real one now the windows exist.
    // Launching again brings the HUD up; if it's already up, the launch is
    // asking for the app itself, so open Display & HUD.
    app.removeListener('second-instance', preReadySecondInstance);
    const onSecondInstance = () => {
      if (!hudVisible) toggleHud();
      else showSettings();
    };
    app.on('second-instance', onSecondInstance);

    // Honor a launch attempt that arrived during the startup gap above,
    // using the same rule.
    if (earlySecondInstance) onSecondInstance();

    const hotkeys = [
      [HOTKEY_WEEK, () => void openThisWeek()],
      [HOTKEY_FOCUS, toggleFocus],
      [HOTKEY_HUD, toggleHud],
      [HOTKEY_CAPTURE, toggleCapture],
    ];
    if (!app.isPackaged) {
      hotkeys.push(
        [
          HOTKEY_HUD_DEBUG,
          () => {
            if (!hudVisible) toggleHud();
            for (const [, w] of liveHudWins()) w.webContents.send('hud:debug-cycle');
          },
        ],
        [
          HOTKEY_QUIT,
          () => {
            app.isQuitting = true;
            app.quit();
          },
        ],
        [
          HOTKEY_AMBIENT_TEST,
          () => {
            ambientForced = !ambientForced;
            if (ambientForced) showAmbient();
            else hideAmbient();
          },
        ],
      );
    }
    for (const [key, fn] of hotkeys) {
      if (!key) continue; // unset: nothing registered
      try {
        if (!globalShortcut.register(key, fn)) console.warn(`[wd] hotkey ${key} is taken by another app`);
      } catch {
        console.warn(`[wd] hotkey ${key} is not a valid shortcut`);
      }
    }


    // The now-playing feed (HUD bubble + stream overlay).
    nowPlayingFeed.start();
    startup.migrateLegacy();

    // Calendar freshness triggers. A background app with nothing on screen has
    // no reason to poll, so the timer is gated on visibility and the edges —
    // a window appearing, being focused, or the machine waking — are handled
    // explicitly rather than waited for.
    // (HUD windows attach their own `show` edge in createHud — they come and
    // go as anchors are used, and never take focus.)
    for (const w of [ambientWin]) {
      w.on('show', () => {
        syncCalendar();
        rescanVault();
      });
      w.on('focus', () => {
        syncCalendar();
        rescanVault();
      });
    }
    powerMonitor.on('suspend', () => { systemSuspended = true; restartPolling(); });
    powerMonitor.on('resume', () => {
      systemSuspended = false;
      restartPolling(); syncCalendar(true); rescanVault(true); scheduleFocusEnd();
    });
    powerMonitor.on('lock-screen', () => { screenLocked = true; restartPolling(); });
    powerMonitor.on('unlock-screen', () => {
      screenLocked = false;
      restartPolling(); syncCalendar(); rescanVault();
    });
    powerMonitor.on('on-battery', () => { onBattery = true; restartPolling(); });
    powerMonitor.on('on-ac', () => { onBattery = false; restartPolling(); });
    onBattery = powerMonitor.isOnBatteryPower();
    screenLocked = powerMonitor.getSystemIdleState(1) === 'locked';
    restartPolling();

    // Vault freshness, the same shape as the calendar above: one recursive
    // watcher in the main process pushes `vault:changed` to every window,
    // so an edit made in Obsidian reaches the HUD in about a second instead
    // of each renderer re-walking the vault on its own five-minute timer. The
    // slow pass behind it only exists for events the OS drops.
    if (vault && vault.ready) {
      stopVaultWatch = vault.watch(() => broadcast('vault:changed'), {
        // The watcher has given up (a vault path that never came back). Say so
        // once, and let every window know its vault data is now only as fresh
        // as the slow pass — `watchDegraded` rides the vault:read-week payload.
        onDegraded: () => broadcast('vault:changed'),
      });

    }
  });

  ipcMain.handle('power:state', () => activityState());
  ipcMain.on('settings:hide', () => hideSettings());
  // Each anchor's window reports its own content height; find it by sender.
  ipcMain.on('hud:resize', (e, height) => {
    if (!Number.isFinite(height)) return;
    for (const [anchor, w] of liveHudWins()) {
      if (w.webContents === e.sender) {
        hudHeights.set(w, height);
        w.setBounds(hudBounds(anchor, height));
      }
    }
  });
  // Phase 8 — vault notes behind the HUD widgets (electron/widgets.cjs). The
  // renderer names the sources its enabled widgets need, plus today's date so
  // the answer and the renderer agree on which daily note "today" is.
  ipcMain.handle('widgets:read', async (_e, req) => {
    if (!widgetSources || !req) return {};
    try {
      return await widgetSources.read(
        {
          ids: Array.isArray(req.ids) ? req.ids.map(String) : [],
          // Only what a stored bubble could hold — normalise() is the gate.
          custom: Array.isArray(req.custom)
            ? presentationStore
                .normalise({ v: 3, hud: { bubbles: req.custom.map((b) => ({ ...b, enabled: true })) } })
                .hud.bubbles.filter((b) => b.type !== 'builtin')
            : [],
        },
        { today: String(req.today || '') },
      );
    } catch (err) {
      console.error('[wd] widgets:read', err);
      return {};
    }
  });
  // The editor's pickers: every note, and one note's headings and fields.
  ipcMain.handle('widgets:notes', async () => (widgetSources ? widgetSources.listNotes() : []));
  // The Now playing bubble: the current track, in-process; null = nothing to
  // show. An add-on may add to it (the owner's Up next queue).
  ipcMain.handle('nowplaying:get', async () => {
    const np = nowPlayingFeed.current();
    if (!np) return null;
    for (const a of addons) {
      if (typeof a.nowPlayingExtras !== 'function') continue;
      try {
        const extra = await a.nowPlayingExtras(np);
        if (extra && Array.isArray(extra.queue)) np.queue = extra.queue;
      } catch (err) {
        console.error(`[wd] add-on ${a.id}: nowPlayingExtras`, err);
      }
    }
    return np;
  });
  // Private add-ons' data (Phase 9.3): an add-on id and a handler name, nothing else.
  ipcMain.handle('addon:call', async (_e, id, name, arg) => {
    try {
      return await callAddon(addons, id, name, arg);
    } catch (err) {
      console.error(`[wd] add-on ${String(id).slice(0, 32)}: ${String(name).slice(0, 32)}`, err);
      return null;
    }
  });
  ipcMain.handle('widgets:describe', async (_e, req) =>
    widgetSources && req
      ? widgetSources.describe(String(req.path || ''), String(req.today || ''))
      : { exists: false, file: '', headings: [], keys: [] },
  );

  // Arrange mode.
  ipcMain.handle('hud:arrange-set', (_e, on) => {
    setArrange(Boolean(on));
    return arranging;
  });
  ipcMain.handle('hud:arrange-get', () => arrangeState());
  ipcMain.handle('hud:arrange-action', async (_e, action) => {
    if (!action || typeof action !== 'object') return { ok: false };
    console.log(`[wd] arrange: ${action.type} ${action.id || action.anchor || ''}`);
    try {
      if (action.type === 'undo') {
        const prev = arrangeHistory.pop();
        if (prev) await commitPresentation(prev);
        broadcast('hud:arrange', arrangeState());
        return { ok: Boolean(prev) };
      }
      if (action.type === 'edit' || action.type === 'add') {
        setArrange(false);
        showSettings(
          action.type === 'edit' ? { bubbleId: String(action.id) } : { newAt: String(action.anchor) },
        );
        return { ok: true };
      }
      if (action.type === 'drop') {
        const anchor = presentationStore.nearestAnchor(
          presentation,
          { x: Number(action.x), y: Number(action.y) },
          presentationDisplays(),
        );
        broadcast('hud:arrange-target', null);
        if (!anchor) return { ok: false };
        await commitArrange(presentationStore.applyArrange(presentation, { type: 'move', id: String(action.id), anchor }));
        return { ok: true, anchor };
      }
      await commitArrange(
        presentationStore.applyArrange(presentation, {
          type: String(action.type),
          id: String(action.id || ''),
          anchor: action.anchor == null ? undefined : String(action.anchor),
          dir: Number(action.dir),
        }),
      );
      return { ok: true };
    } catch (err) {
      console.error('[wd] hud:arrange-action', err);
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
  // While a bubble is dragged, the corner it would land in lights up.
  ipcMain.on('hud:arrange-drag', (_e, point) => {
    const anchor =
      point && Number.isFinite(point.x) && Number.isFinite(point.y)
        ? presentationStore.nearestAnchor(presentation, point, presentationDisplays())
        : null;
    broadcast('hud:arrange-target', anchor);
  });

  // The editor previews every change on the real HUD without saving it; Save
  // writes, Cancel reverts to what's on disk.
  ipcMain.handle('presentation:preview', (_e, next) => {
    presentation = presentationStore.normalise(next);
    applyPresentation();
    return { ok: true, prefs: presentation };
  });
  ipcMain.handle('presentation:revert', async () => {
    presentation = await presentationStore.read();
    applyPresentation();
    return { ok: true, prefs: presentation };
  });
  ipcMain.handle('presentation:read', async () => presentation);
  ipcMain.handle('presentation:displays', () =>
    presentationDisplays().map((d) => ({ id: String(d.id), label: d.label || `Display ${d.id}`, primary: d.primary })),
  );
  ipcMain.handle('presentation:write', async (_e, next) => {
    try {
      presentation = await writePresentation(next);
      applyPresentation();
      return { ok: true, prefs: presentation };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });
  ipcMain.handle('presentation:reset', async () => {
    try {
      presentation = await presentationStore.reset();
      applyPresentation();
      return { ok: true, prefs: presentation };
    } catch (err) { return { ok: false, error: String(err && err.message ? err.message : err) }; }
  });
  ipcMain.handle('presentation:preview-ambient', () => {
    ambientForced = true;
    showAmbient();
    return { ok: true };
  });
  ipcMain.handle('presentation:end-preview', () => {
    endAmbientPreview();
    return { ok: true };
  });

  ipcMain.handle('vault:read-week', async (_e, weekId) => {
    if (!vault || !vault.ready) return null;
    // Phase 9.0 (S3): checked where it arrives, as well as in vault.cjs.
    if (!isWeekId(weekId)) return null;
    try {
      return await vault.readWeek(String(weekId));
    } catch (err) {
      console.error('[wd] vault:read-week', err);
      return null;
    }
  });
  // Phase 5 §6 — the holding pen: read it (the Backlog bubble) and capture into
  // it (Ctrl+Alt+N). Vault-only; no calendar is involved.
  ipcMain.handle('vault:read-backlog', async () => {
    if (!vault || !vault.ready) return { ok: false, items: [] };
    try {
      return await vault.readBacklog();
    } catch (err) {
      console.error('[wd] vault:read-backlog', err);
      return { ok: false, items: [], error: String((err && err.message) || err) };
    }
  });
  // ---- your data (Phase 9.6, S5 and S7) ------------------------------------
  ipcMain.handle('data:diagnostics', (e) => saveDiagnostics(BrowserWindow.fromWebContents(e.sender)));
  ipcMain.handle('data:export', async (e) => {
    const parent = BrowserWindow.fromWebContents(e.sender) || undefined;
    const pick = await dialog.showSaveDialog(parent, {
      title: 'Export Desktop HUD settings',
      defaultPath: 'desktop-hud-settings.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (pick.canceled || !pick.filePath) return { ok: false, canceled: true };
    let skeleton = null;
    try {
      skeleton = await skeletonStore.read();
    } catch {
      // none yet
    }
    const out = {
      app: 'Desktop HUD',
      version: app.getVersion(),
      exportedAt: new Date().toISOString(),
      note: 'Settings only. Calendar links are secrets and are not exported: add them again after importing. Notes stay where they are.',
      config: configState.config,
      presentation,
      skeleton,
      calendars: calSources ? calSources.list().map((c) => ({ name: c.name, kind: c.kind, file: c.file })) : [],
    };
    fs.writeFileSync(pick.filePath, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
    return { ok: true };
  });
  ipcMain.handle('data:remove-all', async (e) => {
    const parent = BrowserWindow.fromWebContents(e.sender) || undefined;
    const r = await dialog.showMessageBox(parent, {
      type: 'warning',
      buttons: ['Cancel', 'Remove and quit'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Remove all my data',
      message: 'Remove all of Desktop HUD’s data from this PC?',
      detail:
        'This deletes its settings, your calendar links (encrypted on this PC), the calendar cache, the backups of notes it wrote to, and its caches, then quits. Start on login is turned off.\n\nYour own notes folder is never touched. The app itself stays installed.',
      checkboxLabel: 'Also delete the built-in notes',
      checkboxChecked: false,
    });
    if (r.response !== 1) return { ok: false, canceled: true };
    const ud = app.getPath('userData');
    try {
      startup.set(false);
    } catch (err) {
      console.warn('[wd] data: could not turn start on login off', err.message);
    }
    // Preserve a user-chosen notes folder even if it happens to be nested
    // inside userData. The ordinary external-folder case has nothing here.
    const noteRel = path.relative(ud, VAULT_PATH);
    const protect = !NOTES_BUILTIN && noteRel && !noteRel.startsWith('..') && !path.isAbsolute(noteRel)
      ? [noteRel.split(path.sep)[0]] : [];
    if (!NOTES_BUILTIN && !noteRel) return { ok: false, error: 'Your notes folder is also the app data folder. Move or disconnect it before removing app data.' };
    try {
      dataCleanup.begin(ud, { notes: r.checkboxChecked, protect });
      if (calSources) calSources.stop();
      const result = dataCleanup.retry(ud, { deferChromium: true });
      if (result.pending.length) await dialog.showMessageBox(parent, {
        type: 'info', title: 'Removal will finish on next start', buttons: ['Quit'],
        message: 'Some app files are still in use.',
        detail: 'The remaining files are saved in a cleanup list and will be retried before Desktop HUD starts again. Your selected notes folder is preserved.',
      });
    } catch (err) {
      return { ok: false, error: 'Could not save the cleanup request. Close the app and check its data folder permissions.' };
    }
    // exit, not quit: the quit handlers would write settings straight back.
    setTimeout(() => app.exit(0), 100);
    return { ok: true };
  });

  // ---- set-up (Phase 9.5) ------------------------------------------------
  // The wizard and the Integrations page. Notes settings take effect on a
  // restart (the notes provider is built at start-up); the window asks for it.

  ipcMain.handle('onboarding:status', () => ({
    done: Boolean(configState.config.onboarding && configState.config.onboarding.done),
    notes: NOTES_BUILTIN ? 'builtin' : 'folder',
    calendars: calSources ? calSources.list().length : 0,
  }));
  ipcMain.handle('onboarding:finish', () => {
    configState.config.onboarding = { v: 1, done: true };
    const w = settingsLib.writeConfig(CONFIG_FILE, configState.config, { readOnly: configState.readOnly });
    return { ok: w.ok, error: w.reason };
  });

  // A notes folder comes only from this dialog (S3: the window never names a
  // path). The pick is held here and applied by notes:apply with `use: 'picked'`.
  let pickedFolder = null;
  ipcMain.handle('notes:choose-folder', async (e) => {
    const parent = BrowserWindow.fromWebContents(e.sender) || undefined;
    const pick = await dialog.showOpenDialog(parent, { title: 'Choose your notes folder', properties: ['openDirectory'] });
    if (pick.canceled || !pick.filePaths[0]) return { ok: false, canceled: true };
    pickedFolder = pick.filePaths[0];
    let detected = null;
    try {
      detected = await detectConventions(pickedFolder);
    } catch (err) {
      console.warn('[wd] notes: detect failed', err.message);
    }
    return { ok: true, name: path.basename(pickedFolder), detected };
  });

  /** The notes settings as they stand, for the Integrations page. */
  ipcMain.handle('notes:settings', () => {
    const v = configState.config.vault || {};
    return {
      kind: NOTES_BUILTIN ? 'builtin' : 'folder',
      name: NOTES_BUILTIN ? 'Built-in notes' : path.basename(VAULT_PATH),
      weeklyDir: v.weeklyDir ?? WEEKLY_DIR,
      dailyDir: v.dailyDir ?? DAILY_DIR ?? '',
      backlogPath: v.backlogPath ?? BACKLOG_PATH ?? 'Backlog.md',
      taskTag: cleanTag(v.taskTag || '') || '#thisweek',
      taskFolders: typeof v.taskFolders === 'string' ? v.taskFolders : '',
      write: NOTES_BUILTIN || v.write === true,
    };
  });

  /**
   * Save where notes come from and their conventions. `use`: 'builtin',
   * 'picked' (the folder from notes:choose-folder) or 'current'. Every path is
   * vault-relative and checked; anything unusable is refused, not guessed.
   * Returns { ok, restart } — the change applies after a restart.
   */
  ipcMain.handle('notes:apply', (_e, arg) => {
    const a = arg && typeof arg === 'object' ? arg : {};
    if (!['builtin', 'picked', 'current'].includes(a.use)) return { ok: false, error: 'Choose where your notes are' };
    if (a.use === 'picked' && !pickedFolder) return { ok: false, error: 'Choose a folder first' };
    const v = { ...(configState.config.vault || {}), v: 1 };
    if (a.use === 'builtin') delete v.path;
    if (a.use === 'picked') v.path = pickedFolder;
    for (const [key, file] of [['weeklyDir', false], ['dailyDir', false], ['backlogPath', true]]) {
      if (a[key] === undefined) continue;
      const clean = a[key] === '' && key === 'dailyDir' ? '' : cleanRel(a[key], { file });
      if (clean == null) return { ok: false, error: `That ${key === 'backlogPath' ? 'backlog note' : 'folder'} isn’t a path inside your notes folder` };
      v[key] = clean;
    }
    if (a.taskTag !== undefined) {
      const t = cleanTag(a.taskTag);
      if (!t) return { ok: false, error: 'A tag is a # followed by letters or numbers' };
      v.taskTag = t;
    }
    if (a.taskFolders !== undefined) {
      const list = String(a.taskFolders).split(',').map((f) => f.trim()).filter(Boolean);
      if (list.some((f) => cleanRel(f) == null)) return { ok: false, error: 'Scan folders must be inside your notes folder' };
      v.taskFolders = list.join(',');
      v.scopeVersion = 1;
    }
    // Always explicit, so nothing later has to guess (S1): a newly picked
    // folder is read-only unless the user said otherwise.
    if (typeof a.write === 'boolean') v.write = a.write;
    else if (a.use === 'picked' || typeof v.write !== 'boolean') v.write = false;
    configState.config.vault = v;
    const w = settingsLib.writeConfig(CONFIG_FILE, configState.config, { readOnly: configState.readOnly });
    if (!w.ok) return { ok: false, error: w.reason };
    pickedFolder = null;
    return { ok: true, restart: true };
  });

  // Now playing: any player, or one (config nowplaying.player). The reader is
  // started with it, so a change applies after a restart.
  ipcMain.handle('nowplaying:settings', () => ({ player: (configState.config.nowplaying || {}).player || '' }));
  ipcMain.handle('nowplaying:set-player', (_e, player) => {
    const p = normalizePlayerFilter(player);
    if (p == null) return { ok: false, error: 'Use one to four plain app names, like spotify or spotify,musicbee' };
    configState.config.nowplaying = { v: 1, player: p };
    const w = settingsLib.writeConfig(CONFIG_FILE, configState.config, { readOnly: configState.readOnly });
    return w.ok ? { ok: true, restart: true } : { ok: false, error: w.reason };
  });

  // Restart to apply settings that are read at start-up.
  ipcMain.handle('app:restart', () => {
    app.relaunch();
    app.isQuitting = true;
    app.quit();
    return { ok: true };
  });

  // Display & HUD → Notes: where notes come from and whether the app writes.
  ipcMain.handle('notes:status', () => ({
    kind: NOTES_BUILTIN ? 'builtin' : 'folder',
    name: NOTES_BUILTIN ? 'Built-in notes' : path.basename(VAULT_PATH),
    ready: Boolean(vault && vault.ready),
    canWrite: Boolean(vault && vault.canWrite),
    backlog: BACKLOG_PATH || 'Backlog.md',
    weekly: WEEKLY_DIR,
  }));
  ipcMain.handle('notes:set-write', (_e, on) => {
    if (NOTES_BUILTIN || !vault || typeof on !== 'boolean') return { ok: false };
    configState.config.vault = { ...(configState.config.vault || { v: 1 }), write: on };
    const w = settingsLib.writeConfig(CONFIG_FILE, configState.config, { readOnly: configState.readOnly });
    if (!w.ok) return { ok: false, error: w.reason };
    vault.setCanWrite(on);
    return { ok: true };
  });
  ipcMain.handle('vault:append-backlog', async (e, text) => {
    if (!vault || !vault.ready) return { ok: false, error: 'vault unavailable' };
    try {
      const r = await vault.appendBacklog(text);
      if (r.ok) broadcast('vault:changed', undefined, e.sender);
      return r;
    } catch (err) {
      console.error('[wd] vault:append-backlog', err);
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
  // The capture window closes itself once the line has landed.
  ipcMain.handle('capture:hide', () => {
    hideCapture();
    return true;
  });
  /**
   * Phase 6 §1 — a skeleton block entered its lead window.
   *
   * The escalation only ever changed a row that was already on screen, so with
   * the HUD hidden the whole feature was silent (bug #22). The HUD is hidden by
   * *opacity*, not by closing it, so its renderer keeps ticking and is the thing
   * that knows — it tells us, and we bring the panel up. Once per occurrence.
   */
  ipcMain.handle('hud:imminent', (_e, key) => {
    const k = String(key || '');
    if (!k || escalated.has(k)) return { ok: true, shown: false };
    escalated.add(k);
    // Keep the set from growing forever in a long-running process.
    if (escalated.size > 200) escalated.clear();
    if (hudVisible) return { ok: true, shown: false };
    toggleHud();
    return { ok: true, shown: true };
  });
  // Phase 6 §2 — focus mode. Started and ended from the tray, Ctrl+Alt+F or its
  // own timer (startFocus / endFocus); the HUD only asks what's running.
  ipcMain.handle('focus:get', () => focusSession);

  // The recurring-blocks editor (Phase 9.4). The renderer edits the blocks
  // list and sends the whole file back; main checks only size and type (it is
  // the app's own file, in userData) and tells every window.
  ipcMain.handle('skeleton:write', async (_e, yaml) => {
    if (typeof yaml !== 'string' || yaml.length > 256 * 1024) return { ok: false, error: 'not a skeleton file' };
    try {
      await skeletonStore.write(yaml);
      broadcast('skeleton:changed');
      return { ok: true };
    } catch (err) {
      console.error('[wd] skeleton:write', err);
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });
  ipcMain.handle('skeleton:read', async () => {
    try {
      return { ok: true, yaml: await skeletonStore.read() };
    } catch (err) {
      console.error('[wd] skeleton:read', err);
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });

  const notifyGoogleChange = () => broadcast('google:changed');

  // The channel names predate Phase 9.3; they reach whichever add-on provides
  // a calendar (`calProvider`), and answer "not configured" without one.
  ipcMain.handle('google:status', () =>
    calProvider ? calProvider.status() : { configured: false, connected: false, email: null },
  );
  ipcMain.handle('google:connect', async () => {
    if (!calProvider || !calProvider.status().configured) return { ok: false, error: 'No calendar account is set up' };
    // The consent page opens in the default browser. The settings window is
    // always-on-top (level with the HUD), so it would sit on top of the very
    // page it sent you to — step it down until the sign-in finishes.
    const win = settingsWin && !settingsWin.isDestroyed() ? settingsWin : null;
    if (win) win.setAlwaysOnTop(false);
    try {
      const s = await calProvider.connect();
      notifyGoogleChange();
      syncCalendar(true); // first full sync fills the store in the background
      return { ok: true, ...s };
    } catch (err) {
      console.error('[wd] google:connect', err);
      return { ok: false, error: String(err && err.message ? err.message : err) };
    } finally {
      if (win && !win.isDestroyed()) {
        win.setAlwaysOnTop(true, 'floating');
        if (win.isVisible()) win.focus();
      }
    }
  });
  ipcMain.handle('google:disconnect', () => {
    // The provider also drops its local mirror of the calendar.
    if (calProvider) calProvider.disconnect();
    notifyGoogleChange();
    return { ok: true };
  });

  // The events slot (Phase 9.4): every calendar, merged, already parsed.
  // The first read waits for a connected provider's first sync, as cal:list
  // used to, so the first open isn't blank.
  ipcMain.handle('events:list', async (_e, range) => {
    const r = range && typeof range === 'object' ? range : {};
    const min = typeof r.timeMin === 'string' && !Number.isNaN(Date.parse(r.timeMin)) ? r.timeMin : null;
    const max = typeof r.timeMax === 'string' && !Number.isNaN(Date.parse(r.timeMax)) ? r.timeMax : null;
    if (!min || !max) return { ok: false, error: 'bad range' };
    if (calProvider && calProvider.connected()) {
      try {
        await calProvider.list({ timeMin: min, timeMax: max });
      } catch (err) {
        console.error('[wd] events:list provider', err);
      }
    }
    return { ok: true, events: eventsInRange(min, max) };
  });
  // The sources and their status, for Display & HUD. Never a URL.
  ipcMain.handle('events:sources', () => (calSources ? calSources.list() : []));
  ipcMain.handle('events:add-link', async (_e, arg) => {
    const a = arg && typeof arg === 'object' ? arg : {};
    if (!calSources || typeof a.url !== 'string' || a.url.length > 4096) return { ok: false, error: 'No link given' };
    return calSources.add({ kind: 'ics-url', name: typeof a.name === 'string' ? a.name : '', url: a.url });
  });
  // A local file comes only from the file dialog (S3): the window never names a path.
  ipcMain.handle('events:add-file', async (e, arg) => {
    if (!calSources) return { ok: false, error: 'Not ready' };
    const parent = BrowserWindow.fromWebContents(e.sender) || undefined;
    const pick = await dialog.showOpenDialog(parent, {
      title: 'Choose a calendar file',
      properties: ['openFile'],
      filters: [{ name: 'Calendar', extensions: ['ics'] }],
    });
    if (pick.canceled || !pick.filePaths[0]) return { ok: false, canceled: true };
    const name = arg && typeof arg.name === 'string' && arg.name.trim() ? arg.name : path.basename(pick.filePaths[0], path.extname(pick.filePaths[0]));
    return calSources.add({ kind: 'ics-file', name, file: pick.filePaths[0] });
  });
  ipcMain.handle('events:remove', (_e, id) => (calSources && typeof id === 'string' ? calSources.remove(id) : { ok: false }));
  ipcMain.handle('events:rename', (_e, id, name) =>
    calSources && typeof id === 'string' && typeof name === 'string' ? calSources.rename(id, name) : { ok: false },
  );
  ipcMain.handle('events:refresh', async (_e, id) => {
    if (!calSources) return { ok: false };
    await calSources.refresh(typeof id === 'string' ? id : undefined);
    return { ok: true };
  });
  ipcMain.handle('cal:status', () => (calProvider ? calProvider.storeStatus() : null));

  app.on('window-all-closed', () => {
    /* stay resident — background app */
  });

  app.on('will-quit', () => {
    if (idleTimer) clearInterval(idleTimer);
    if (trayTimer) clearInterval(trayTimer);
    if (calTimer) clearInterval(calTimer);
    if (vaultTimer) clearInterval(vaultTimer);
    if (stopVaultWatch) stopVaultWatch();
    for (const a of addons) {
      try {
        if (typeof a.stop === 'function') a.stop();
      } catch (err) {
        console.error(`[wd] add-on ${a.id}: stop`, err);
      }
    }
    if (calSources) calSources.stop();
    nowPlayingFeed.stop();
    globalShortcut.unregisterAll();
  });
}
