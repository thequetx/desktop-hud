'use strict';
// Window guards (Phase 9.0, trust model S3 and S10). The HUD draws calendar
// and note text that someone else may have written, so no window may be
// navigated away from the app's own pages, open new windows, embed webviews,
// or be granted a browser permission. None of the app's features need any of
// that: links to Obsidian and the browser go through shell.openExternal in the
// main process.
//
// Navigations the main process starts itself (loadURL) do not raise
// `will-navigate`, so loadRoute is unaffected.

const { fileFor } = require('./appprotocol.cjs');

/**
 * True when `url` is one of the app's own pages: app://hud/ naming a file
 * under `distDir` (Phase 9.4; file:// pages are no longer the app's), or,
 * while running against the Vite dev server, a page on `devOrigin`. Query and
 * hash are ignored; `..` is resolved first, so a path cannot climb out.
 */
function isAppUrl(url, { distDir, devOrigin = null }) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (devOrigin) {
    try {
      if (u.origin === new URL(devOrigin).origin) return true;
    } catch {
      // a malformed dev origin allows nothing extra
    }
  }
  return fileFor(url, distDir) != null;
}

/**
 * Install the guards on every web contents the app creates. `allowed()` returns
 * the current { distDir, devOrigin }, since dev mode is only decided after
 * startup. Call once, before the first window.
 */
function installWindowGuards(app, allowed, log = console.warn) {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      log(`[wd] guard: blocked a new window (${safeForLog(url)})`);
      return { action: 'deny' };
    });
    const block = (event, url) => {
      if (isAppUrl(url, allowed())) return;
      event.preventDefault();
      log(`[wd] guard: blocked navigation (${safeForLog(url)})`);
    };
    contents.on('will-navigate', block);
    contents.on('will-redirect', block);
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
      log('[wd] guard: blocked a webview');
    });
  });
}

/** Deny every permission request and check (camera, notifications, clipboard…). */
function denyAllPermissions(ses) {
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}

/** The scheme and host only: a blocked URL may carry a secret in its path or query. */
function safeForLog(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'file:' ? 'file:' : `${u.protocol}//${u.host}`;
  } catch {
    return 'unparseable URL';
  }
}

module.exports = { isAppUrl, installWindowGuards, denyAllPermissions, safeForLog };
