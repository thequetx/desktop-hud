// Packaged-render smoke test. Run under Electron, not Node: `npm run smoke`
// (and automatically at the end of `npm run dist`).
//
// Why this exists: the Vite `base` bug lived through Phases 0–2 and a packaging
// pass because every check ran against the dev server. `npm run dev` serves over
// http://, the shipped app loads over file:// — different programs. A clean
// build, a passing typecheck and a `did-finish-load` event were all true the
// whole time every window painted nothing.
//
// So this loads the *built* pages the way the app does (loadFile + the real
// preload) and asserts the one thing none of those signals covered: `#root`
// actually has content in it. Before the fix that read 0; after, ~1970.

import { app, BrowserWindow, ipcMain, protocol } from 'electron';
import { createRequire } from 'node:module';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = path.join(ROOT, 'dist');
// The pages load over app://hud/, as the app loads them (Phase 9.4).
const appProtocol = createRequire(import.meta.url)('../electron/appprotocol.cjs');
appProtocol.registerScheme(protocol);
const PRELOAD = path.join(ROOT, 'electron', 'preload.cjs');

// Phase 8 — each HUD corner is its own window loading hud.html?anchor=…. The
// bottom-left one holds only vault widgets, so it is checked with fixture data
// (`widgets:read` below): a corner that renders nothing would otherwise be
// indistinguishable from one that has nothing to say.
const PAGES = [
  'index.html',
  'ambient.html',
  'hud.html',
  { page: 'hud.html', query: { anchor: 'bottom-left' } },
  { page: 'hud.html', query: { anchor: 'bottom-right' } },
  'capture.html',
];
const pageName = (p) => (typeof p === 'string' ? p : `${p.page}?${new URLSearchParams(p.query)}`);

// The real preload is loaded (a broken bridge is the same class of ship-blind
// bug), but this isn't the real main process, so the channels it invokes are
// answered with the "nothing is connected" shapes rather than left to reject.
//
// Channels are read out of preload.cjs and every one of them must appear here.
// A nudge was not enough: `vault:read-audit` was added to the bridge and not to
// this list, and the gate went on passing while printing a real "no handler
// registered" error on every run. This test exists precisely so its output can
// be trusted over "the build was clean", so drift fails it.
const IPC_STUBS = {
  'vault:read-week': null,
  'vault:read-backlog': { ok: true, items: [] },
  'vault:append-backlog': { ok: false },
  'capture:hide': true,
  'focus:get': null,
  'hud:imminent': { ok: true, shown: false },
  // No recurring blocks and an empty (connected) calendar, so no 'hide during
  // stream' rule can fire: the gate used to fail every stream evening, because
  // the fallbacks it hit — the bundled skeleton and the synced .ics — both
  // have a Mon/Tue/Thu/Fri 18:30 stream in them.
  'skeleton:read': { ok: true, yaml: 'blocks: []\n' },
  // A v1 file on purpose: the renderer must cope with the pre-Phase-8 shape
  // until the main process has normalised it (it always does in the real app).
  'presentation:read': { v: 1, ambient: { enabled: true, idleSeconds: 180, display: 'primary' }, hud: { display: 'primary', corner: 'top-right', scale: 'standard', upcomingRows: 4, showStreaks: true, showWeekStrip: true } },
  'widgets:notes': [],
  // A playing track with no cover, so the bottom-right corner renders offline.
  // Private add-ons (Phase 9.3): no data, so their bubbles draw nothing.
  'addon:call': null,
  'nowplaying:get': { playing: true, title: 'Disgruntled', artist: 'Chase & Status, J Hus', cover: null },
  'widgets:describe': { exists: false, file: '', headings: [], keys: [] },
  'presentation:preview': { ok: true },
  'presentation:revert': { ok: true },
  'hud:arrange-set': false,
  'hud:arrange-get': { on: false, canUndo: false },
  'hud:arrange-action': { ok: true },
  'widgets:read': {
    daily: {
      file: 'Daily/2026-09-20.md',
      exists: true,
      goals: [
        { text: 'Build the narrow day view ~4h ⏫', done: false },
        { text: 'Decide the narrow breakpoint 🔺', done: true },
      ],
      energy: 6,
      motivation: 7,
    },
    art: {
      label: 'Week 02 — Build objects from simple shapes',
      file: 'Art/Week 02/Weekly Plan.md',
      goal: 'See objects as boxes, cylinders, and spheres.',
      minimum: 'One 30-minute still life built from simple forms.',
    },
    // The Meal bubble, in design-preview form so it renders at a fixed moment: a dinner with one
    // prep step. Enough to exercise the component without depending on the real feed.
    meal: {
      preview: { now: '2026-10-16T16:00:00+11:00' },
      feeds: [
        {
          meal_week: '2026-W42',
          timezone: 'Australia/Melbourne',
          meals: [
            {
              meal_id: 'dinner-2026-10-16',
              date: '2026-10-16',
              meal_type: 'dinner',
              title: 'Basa Fish Tacos with Crunchy Slaw',
              portion_description: '1 plated serving',
              cook_start_at: '2026-10-16T17:30:00+11:00',
              ready_at: '2026-10-16T18:10:00+11:00',
              ready_at_is_estimate: true,
              total_time_minutes: 40,
              macros: { calories_kcal: 760, protein_g: 58, provisional: false },
              advance_prep: [
                {
                  step_id: 'p1',
                  target_meal_id: 'dinner-2026-10-16',
                  kind: 'thaw',
                  action: 'Move the sealed basa to the refrigerator',
                  due_at: '2026-10-15T17:30:00+11:00',
                },
              ],
              batch: null,
              preparation_mode: null,
            },
          ],
        },
      ],
    },
  },
  'presentation:displays': [],
  'presentation:write': { ok: true },
  'presentation:reset': { ok: true },
  'presentation:preview-ambient': { ok: true },
  'presentation:end-preview': { ok: true },
  'google:status': { configured: false, connected: false, email: null },
  'google:connect': { ok: false, error: 'smoke test' },
  'google:disconnect': undefined,
  'events:list': { ok: true, events: [] },
  'events:sources': [],
  'data:diagnostics': { ok: false, canceled: true },
  'data:export': { ok: false, canceled: true },
  'data:remove-all': { ok: false, canceled: true },
  'onboarding:status': { done: true, notes: 'builtin', calendars: 0 },
  'onboarding:finish': { ok: true },
  'notes:choose-folder': { ok: false, canceled: true },
  'notes:settings': { kind: 'builtin', name: 'Built-in notes', weeklyDir: 'Weekly', dailyDir: 'Daily', backlogPath: 'Backlog.md', taskTag: '#thisweek', taskFolders: '', write: true },
  'notes:apply': { ok: false },
  'nowplaying:settings': { player: '' },
  'nowplaying:set-player': { ok: false },
  'app:restart': { ok: true },
  'skeleton:write': { ok: true },
  'notes:status': { kind: 'builtin', name: 'Built-in notes', ready: true, canWrite: true, backlog: 'Backlog.md', weekly: 'Weekly' },
  'notes:set-write': { ok: false },
  'events:add-link': { ok: false, error: 'smoke test' },
  'events:add-file': { ok: false, canceled: true },
  'events:remove': { ok: true },
  'events:rename': { ok: true },
  'events:refresh': { ok: true },
  'cal:status': null,
};

function stubBridge() {
  const src = readFileSync(PRELOAD, 'utf8');
  const missing = [];
  for (const m of src.matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)) {
    const channel = m[1];
    if (!(channel in IPC_STUBS)) {
      if (!missing.includes(channel)) missing.push(channel);
      continue;
    }
    ipcMain.handle(channel, () => IPC_STUBS[channel]);
  }
  if (missing.length) {
    console.error(
      `\n  FAIL  preload.cjs invokes ${missing.length} channel(s) this smoke test ` +
        `does not stub: ${missing.join(', ')}\n` +
        `        Add them to IPC_STUBS in scripts/smoke.mjs, or the gate reports ` +
        `a page as rendering while the console fills with handler errors.\n`,
    );
    return false;
  }
  return true;
}

// React's initial render is scheduled, not synchronous, so `did-finish-load` is
// too early to read #root. Poll instead: a page that renders gets there in a
// frame or two, and a blank bundle stays at 0 for the whole window.
const RENDER_TIMEOUT_MS = 10_000;
const POLL_MS = 100;
// A blank #root is the failure this test is for, but a nearly-blank one is the
// same bug wearing a hat — an outer shell with nothing in it, or a rendered
// error message, is a few hundred characters and would sail straight past the
// old `>= 1`. Measured on a good build, the HUD is the floor: it reads ~1059 on
// the first pass that clears this bar and settles around 1970 (index ~20-25k,
// ambient ~1400-2100). 600 sits comfortably under the smallest real page and
// comfortably over a bare wrapper.
const MIN_HTML = 600;
// …except quick capture, which is a label, one input and a hint line — about
// 300 characters when it is working perfectly. Lowering the shared floor to fit
// it would blind the gate to a half-rendered HUD, so the small window gets its
// own number instead. Both are still far above a bare wrapper.
const MIN_HTML_BY_PAGE = {
  'capture.html': 200,
  'hud.html?anchor=bottom-left': 400,
  'hud.html?anchor=bottom-right': 250,
};
const floorFor = (page) => MIN_HTML_BY_PAGE[page] ?? MIN_HTML;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Load one built page and return what ended up inside #root. */
/** A console message as { severe, text }, from either Electron's old
 *  positional arguments (level 0-3) or the event object (Electron 35+, where
 *  `level` is 'info' | 'warning' | 'error' | 'debug'). */
function consoleMessage(e, level, message) {
  const lvl = e && typeof e.level === 'string' ? e.level : level;
  const text = String((e && typeof e.message === 'string' ? e.message : message) ?? '');
  const severe = lvl === 'warning' || lvl === 'error' || (typeof lvl === 'number' && lvl >= 2);
  return { severe, text };
}

async function checkPage(entry) {
  const page = pageName(entry);
  const floor = floorFor(page);
  const file = path.join(DIST_DIR, typeof entry === 'string' ? entry : entry.page);
  const query = typeof entry === 'string' ? undefined : entry.query;
  if (!existsSync(file)) {
    return { page, ok: false, len: 0, reason: `dist/${page} does not exist — run \`npm run build\`` };
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Anything the page shouts on the way up — a missing asset under file:// is
  // exactly how the base bug announced itself, once anyone looked.
  const notes = [];
  win.webContents.on('console-message', (e, level, msg) => {
    const { severe, text } = consoleMessage(e, level, msg);
    // Electron's own CSP nag fires on every unpackaged page and would bury the
    // one line that actually says what went wrong.
    if (severe && !text.includes('Electron Security Warning')) {
      notes.push(text.replace(/\s+/g, ' ').slice(0, 200));
    }
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    notes.push(`did-fail-load ${code} ${desc} ${url}`);
  });

  try {
    await win.loadURL(appProtocol.pageUrl(path.relative(DIST_DIR, file).split(path.sep).join('/'), query));
  } catch (err) {
    win.destroy();
    return { page, ok: false, len: 0, reason: `loadURL threw: ${err.message}`, notes };
  }

  let len = 0;
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      len = await win.webContents.executeJavaScript(
        "(() => { const r = document.getElementById('root'); return r ? r.innerHTML.length : -1; })()",
      );
    } catch (err) {
      win.destroy();
      return { page, ok: false, len: 0, reason: `executeJavaScript threw: ${err.message}`, notes };
    }
    if (len >= floor) break;
    await sleep(POLL_MS);
  }

  win.destroy();

  if (len < 0) return { page, ok: false, len, reason: 'no #root element in the document', notes };
  if (len < floor) {
    return {
      page,
      ok: false,
      len,
      reason:
        `#root holds ${len} chars after ${RENDER_TIMEOUT_MS / 1000}s (expected ≥ ${floor}) — ` +
        'the window would render blank or near-blank',
      notes,
    };
  }
  // Phase 9.0 (S10): the built pages carry a strict CSP. A page that renders
  // while the CSP blocks one of its own scripts, styles or images is still a
  // broken page, so any violation fails the gate.
  const csp = notes.filter((n) => /Content Security Policy|Refused to (load|execute|connect|apply|evaluate)/i.test(n));
  if (csp.length) {
    return { page, ok: false, len, reason: `${csp.length} CSP violation(s)`, notes: csp };
  }
  return { page, ok: true, len, notes };
}

async function main() {
  app.disableHardwareAcceleration();
  // Each page is checked in its own window and then destroyed, which leaves the
  // app with no windows between pages. Electron's default `window-all-closed`
  // would quit out from under the run after the first one.
  app.on('window-all-closed', () => {});
  await app.whenReady();
  appProtocol.serve(protocol, DIST_DIR);
  if (!stubBridge()) {
    app.exit(1);
    return;
  }

  const results = [];
  for (const page of PAGES) results.push(await checkPage(page));

  console.log('');
  for (const r of results) {
    console.log(
      r.ok
        ? `  ok    dist/${r.page}  #root innerHTML = ${r.len} chars`
        : `  FAIL  dist/${r.page}  ${r.reason}`,
    );
    if (!r.ok) for (const n of (r.notes ?? []).slice(0, 5)) console.log(`          ${n}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (failed.length) {
    console.error(
      `Smoke test FAILED: ${failed.length}/${results.length} built page(s) render blank.\n` +
        'The bundle would ship windows that paint nothing. Check vite.config.ts `base`\n' +
        "(must be './' for file:// loads) and dist/assets before releasing this build.",
    );
    return 1;
  }
  console.log(`Smoke test passed — all ${results.length} built pages render.`);
  return 0;
}

main()
  .then((code) => app.exit(code))
  .catch((err) => {
    console.error('Smoke test crashed:', err);
    app.exit(1);
  });
