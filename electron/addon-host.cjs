'use strict';
// Private add-ons, main-process side (Phase 9.3).
//
// The owner's add-ons are composed at build time: `electron/addons-private/`
// is a git-ignored link to the private repo (thequetx/desktop-hud-addons), and
// electron-builder packages whatever it contains. The public build has no such
// folder, so this finds nothing and the app has no add-on code at all. Nothing
// is ever loaded from a folder at runtime (trust model S2).
//
// An add-on is a plain object:
//   { id, widgets?: [WIDGET_DEFAULTS-shaped], start?(ctx), stop?(),
//     handlers?: { name: (arg) => data }, tray?(ctx) => MenuItem[] }
// Its bubbles' components live in the renderer half (src/lib/addons.ts).
// Renderers reach handlers only through `addon:call` with an add-on id and a
// handler name, never a path or code.

const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

/** The private add-ons in this build, or [] (the public build). */
function loadPrivateAddons({ log = console.warn, load = () => require('./addons-private/index.cjs') } = {}) {
  let mods;
  try {
    mods = load();
  } catch (err) {
    // No addons-private folder: the public build. Anything else is a broken add-on.
    if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes('addons-private')) return [];
    log(`[wd] add-ons: could not load (${err && err.message})`);
    return [];
  }
  const list = Array.isArray(mods) ? mods : [];
  const seen = new Set();
  return list.filter((a) => {
    if (!a || !ID_RE.test(String(a.id)) || seen.has(a.id)) {
      log(`[wd] add-ons: skipped an add-on without a valid, unique id`);
      return false;
    }
    seen.add(a.id);
    return true;
  });
}

/** Dispatch `addon:call`: strings only, known add-on and handler only. */
function callAddon(addons, id, name, arg) {
  if (typeof id !== 'string' || typeof name !== 'string') return null;
  const addon = addons.find((a) => a.id === id);
  const handler = addon && addon.handlers && Object.prototype.hasOwnProperty.call(addon.handlers, name) ? addon.handlers[name] : null;
  return typeof handler === 'function' ? handler(arg) : null;
}

module.exports = { loadPrivateAddons, callAddon };
