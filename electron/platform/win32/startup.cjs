'use strict';
// Start on login, on Windows (Phase 9.4: moved out of main.cjs into
// platform/win32/). Electron's own login-item API registers one Run-key
// value per executable identity; this keeps exactly one, and carries the
// pre-9.2 Week Dashboard entry across.

const path = require('node:path');

/**
 * @param {{ app: import('electron').App, profileDir: string|null, appDir: string }} o
 *   `appDir` is the app folder an unpackaged build registers with Electron.
 */
function makeStartup({ app, profileDir, appDir }) {
  //
  // Bug history: with `app.getName()` pinned to "week-dashboard" for both
  // builds (above), the packaged and dev/unpackaged builds still don't share
  // one Windows Run-key entry. Electron's default login-item value name on
  // Windows comes from the *running executable's own* embedded product name
  // (its VERSIONINFO ProductName), not from app.getName() or package.json —
  // the branded "Week Dashboard.exe" registers as
  // "electron.app.Week Dashboard" (matches electron-builder's
  // build.productName), while the raw dev node_modules/electron/dist/electron.exe
  // always registers as "electron.app.Electron" (Electron's own product
  // name), no matter what this app's package.json says. Each build's old
  // setLoginItem() only ever wrote/read its own entry, so enabling one never
  // removed a stale entry left by the other — that's exactly how a dev-mode
  // "Start on login" click years ago left a permanent, invisible-to-the-tray
  // login item that fired alongside the real packaged one on every boot.
  //
  // Fix: track both known identities explicitly. Enabling either build's
  // login item now also scrubs the other's Run + StartupApproved\Run values,
  // and loginItemEnabled() reports true if *either* is present, so the tray
  // checkbox can't lie about a stale entry it doesn't know how to see.
  const { execFileSync } = require('node:child_process');

  const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  const STARTUP_APPROVED_KEY =
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
  const LOGIN_ITEM_NAME_DEV = 'electron.app.Electron';
  // Derived from package.json's productName (electron-builder's own
  // build.productName agrees) rather than hardcoded a second time, so the two
  // stay in sync if the app is ever rebranded.
  const LOGIN_ITEM_NAME_PACKAGED = `electron.app.${require('../../../package.json').productName}`;
  // The app was Week Dashboard until Phase 9.2. Its login item is known too, so
  // enabling Desktop HUD's clears it, and a Week Dashboard user who had start on
  // login keeps it (migrateLegacyLoginItem, below).
  const LOGIN_ITEM_NAME_LEGACY = 'electron.app.Week Dashboard';
  const ALL_LOGIN_ITEM_NAMES = [LOGIN_ITEM_NAME_DEV, LOGIN_ITEM_NAME_PACKAGED, LOGIN_ITEM_NAME_LEGACY];
  // reg.exe by full path: a bare name is searched for in the current folder
  // first (trust model S12).
  const REG_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');

  function regValueExists(key, name) {
    if (process.platform !== 'win32') return false;
    try {
      execFileSync(REG_EXE, ['query', key, '/v', name], { stdio: 'pipe' });
      return true;
    } catch {
      return false; // reg.exe exits non-zero when the value doesn't exist
    }
  }

  function regDeleteValue(key, name) {
    if (process.platform !== 'win32') return;
    try {
      execFileSync(REG_EXE, ['delete', key, '/v', name, '/f'], { stdio: 'pipe' });
    } catch {
      // already absent — fine
    }
  }

  // Remove every known login-item identity for this app except `keep`
  // (pass null/undefined to remove all of them).
  function clearOtherLoginItems(keep) {
    for (const name of ALL_LOGIN_ITEM_NAMES) {
      if (name === keep) continue;
      regDeleteValue(RUN_KEY, name);
      regDeleteValue(STARTUP_APPROVED_KEY, name);
    }
  }

  function loginItemEnabled() {
    if (process.platform !== 'win32') {
      return app.getLoginItemSettings({ args: ['--hud'] }).openAtLogin;
    }
    // True if ANY known identity is registered — covers a stale entry left by
    // the other build variant, which is exactly what made the tray checkbox
    // lie before this fix.
    return ALL_LOGIN_ITEM_NAMES.some((name) => regValueExists(RUN_KEY, name));
  }

  /**
   * The tray's "Start on login" tick. Read from the registry once and then kept
   * here: the tray menu is rebuilt every minute (focus's "Focus on: …" label),
   * and each registry read is two synchronous `reg query` processes on the main
   * thread. Only this app changes the value, through setLoginItem below.
   */
  let loginItemCache = null;
  function loginItemChecked() {
    if (loginItemCache === null) loginItemCache = loginItemEnabled();
    return loginItemCache;
  }

  function setLoginItem(enabled) {
    loginItemCache = enabled;
    const mine = app.isPackaged ? LOGIN_ITEM_NAME_PACKAGED : LOGIN_ITEM_NAME_DEV;
    if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hud'] });
    } else {
      // Unpackaged: register the electron binary + this app dir.
      app.setLoginItemSettings({
        openAtLogin: enabled,
        path: process.execPath,
        args: [appDir, '--hud'],
      });
    }
    // Authoritative: whichever build just wrote its own entry, make sure it's
    // the ONLY one. Disabling clears every known entry outright.
    clearOtherLoginItems(enabled ? mine : null);
  }

  /**
   * Phase 9.2 — a Week Dashboard user who had start on login keeps it: the
   * installed Desktop HUD registers its own entry, which clears the old one
   * (and the old one points at an exe the upgrade removes). Installed builds
   * only, never a --profile run, and only when Desktop HUD has no entry yet.
   */
  function migrateLegacyLoginItem() {
    if (!app.isPackaged || profileDir || process.platform !== 'win32') return;
    if (!regValueExists(RUN_KEY, LOGIN_ITEM_NAME_LEGACY)) return;
    if (regValueExists(RUN_KEY, LOGIN_ITEM_NAME_PACKAGED)) {
      regDeleteValue(RUN_KEY, LOGIN_ITEM_NAME_LEGACY);
      regDeleteValue(STARTUP_APPROVED_KEY, LOGIN_ITEM_NAME_LEGACY);
      return;
    }
    setLoginItem(true);
    console.log('[wd] login item: carried Week Dashboard\'s "start on login" across');
  }

  return { checked: loginItemChecked, set: setLoginItem, migrateLegacy: migrateLegacyLoginItem };
}

module.exports = { makeStartup };
