'use strict';
// Every IPC argument checked against a declared shape (Phase 9.6, trust model
// S3 and S10). The windows draw text other people wrote (calendar events,
// notes), so main treats what arrives over IPC as untrusted:
//
// - the sender must be one of the app's own pages (app://hud/, or the dev
//   server in a dev run);
// - each argument must match its channel's spec below: type, size, and
//   whether it may be missing. Anything else is refused before the handler
//   runs, and logged by channel name only (never the argument);
// - a channel with no spec can't be registered at all, so a new handler
//   can't skip this by accident (test/ipcguard.test.ts also checks main.cjs
//   and preload.cjs against the table).
//
// Handlers still check meaning (a week id, a vault-relative path); this layer
// only guarantees the shape and size they receive.

const KB = 1024;

const str = (max, optional = false) => ({ t: 'string', max, optional });
const bool = (optional = false) => ({ t: 'boolean', optional });
const num = (optional = false) => ({ t: 'number', optional });
const obj = (maxBytes, optional = false) => ({ t: 'object', maxBytes, optional });
const json = (maxBytes, optional = false) => ({ t: 'json', maxBytes, optional });

/** channel -> argument specs (after the event). [] = takes nothing. */
const SCHEMAS = {
  'power:state': [],
  // add-ons (Phase 9.3)
  'addon:call': [str(64), str(64), json(64 * KB, true)],
  // your data (Phase 9.6)
  'data:diagnostics': [],
  'data:export': [],
  'data:remove-all': [],
  // set-up and notes (Phase 9.4–9.5)
  'app:restart': [],
  'onboarding:status': [],
  'onboarding:finish': [],
  'notes:choose-folder': [],
  'notes:settings': [],
  'notes:status': [],
  'notes:apply': [obj(8 * KB)],
  'notes:set-write': [bool()],
  // calendars (Phase 9.4)
  'cal:status': [],
  'events:list': [obj(1 * KB)],
  'events:sources': [],
  'events:add-link': [obj(8 * KB)],
  'events:add-file': [obj(1 * KB, true)],
  'events:remove': [str(64)],
  'events:rename': [str(64), str(200)],
  'events:refresh': [str(64, true)],
  'google:status': [],
  'google:connect': [],
  'google:disconnect': [],
  // focus, HUD, arrange mode
  'focus:get': [],
  'hud:imminent': [str(512)],
  'hud:arrange-get': [],
  'hud:arrange-set': [bool()],
  'hud:arrange-action': [obj(4 * KB)],
  'hud:arrange-drag': [obj(256)],
  'hud:resize': [num()],
  // now playing
  'nowplaying:get': [],
  'nowplaying:settings': [],
  'nowplaying:set-player': [str(64)],
  // presentation
  'presentation:read': [],
  'presentation:displays': [],
  'presentation:write': [obj(512 * KB)],
  'presentation:preview': [obj(512 * KB)],
  'presentation:revert': [],
  'presentation:reset': [],
  'presentation:preview-ambient': [],
  'presentation:end-preview': [],
  'settings:hide': [],
  // skeleton, vault, widgets, capture
  'skeleton:read': [],
  'skeleton:write': [str(256 * KB)],
  'vault:read-week': [str(16, true)],
  'vault:read-backlog': [],
  'vault:append-backlog': [str(4000)],
  'widgets:read': [obj(64 * KB)],
  'widgets:notes': [],
  'widgets:describe': [obj(8 * KB)],
  'capture:hide': [],
};

function sizeOf(v) {
  try {
    return JSON.stringify(v ?? null).length;
  } catch {
    return Infinity; // cyclic or otherwise not plain data
  }
}

/** Why `args` don't fit `specs`, or null when they do. */
function problem(specs, args) {
  if (args.length > specs.length) return `takes ${specs.length} argument(s), got ${args.length}`;
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    const v = args[i];
    if (v === undefined || v === null) {
      if (s.optional) continue;
      return `argument ${i + 1} is missing`;
    }
    if (s.t === 'string' && (typeof v !== 'string' || v.length > s.max)) return `argument ${i + 1} is not a string up to ${s.max}`;
    if (s.t === 'boolean' && typeof v !== 'boolean') return `argument ${i + 1} is not a boolean`;
    if (s.t === 'number' && (typeof v !== 'number' || !Number.isFinite(v))) return `argument ${i + 1} is not a number`;
    if (s.t === 'object' && (typeof v !== 'object' || Array.isArray(v) || sizeOf(v) > s.maxBytes)) {
      return `argument ${i + 1} is not an object up to ${s.maxBytes} bytes`;
    }
    if (s.t === 'json' && sizeOf(v) > s.maxBytes) return `argument ${i + 1} is over ${s.maxBytes} bytes`;
  }
  return null;
}

/**
 * Patch `ipcMain.handle` and `ipcMain.on` so every registration is guarded.
 * `isAppSender(url)` says whether a frame URL is one of the app's pages.
 * Call once, before any handler is registered.
 */
function installIpcGuard(ipcMain, { isAppSender, log = console.warn }) {
  const handle = ipcMain.handle.bind(ipcMain);
  const on = ipcMain.on.bind(ipcMain);
  const check = (channel, e, args) => {
    const url = e && e.senderFrame ? e.senderFrame.url : '';
    if (!isAppSender(url)) return 'the sender is not one of the app’s pages';
    return problem(SCHEMAS[channel], args);
  };
  const specFor = (channel) => {
    if (!Object.prototype.hasOwnProperty.call(SCHEMAS, channel)) {
      throw new Error(`ipc: no argument spec for "${channel}" (electron/ipcguard.cjs)`);
    }
  };
  ipcMain.handle = (channel, fn) => {
    specFor(channel);
    return handle(channel, (e, ...args) => {
      const why = check(channel, e, args);
      if (why) {
        log(`[wd] ipc: refused ${channel} (${why})`);
        return { ok: false, error: 'refused' };
      }
      return fn(e, ...args);
    });
  };
  ipcMain.on = (channel, fn) => {
    specFor(channel);
    return on(channel, (e, ...args) => {
      const why = check(channel, e, args);
      if (why) {
        log(`[wd] ipc: refused ${channel} (${why})`);
        return;
      }
      fn(e, ...args);
    });
  };
}

module.exports = { installIpcGuard, problem, SCHEMAS };
