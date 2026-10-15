'use strict';
// Settings (Phase 9.2): one versioned config.json plus an encrypted secrets
// file in userData, in place of the developer-style .env.
//
// - A packaged build reads config.json and secrets only. Never .env, never
//   environment variables: a planted .env beside the exe could otherwise set
//   an add-on's program path and have the app launch it (trust model S12).
// - A dev run (unpacked) also reads the repo's .env and environment variables,
//   DHUD_<NAME> first, then the old WD_<NAME>, over config.json.
// - A config.json written by a newer version is read but never overwritten,
//   so running an older build can't destroy settings (S7).
// - Secrets are encrypted with safeStorage. With encryption unavailable they
//   are refused, never written in plain text (S13).
// - importLegacy() moves a Week Dashboard install's settings in once: it
//   copies files and leaves the old folder untouched, so running the old
//   build again is a complete rollback.

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const SECTION_VERSION = 1;

/**
 * Every setting: its config path (`section.key` or `section.sub.key`), the
 * environment names it was known by (dev overrides, and the legacy import),
 * whether it is a secret, and whether only a dev run may set it.
 */
const FIELDS = [
  { key: 'vault.path', env: ['VAULT_PATH', 'VITE_VAULT_PATH'] },
  { key: 'vault.weeklyDir', env: ['WEEKLY_DIR'] },
  { key: 'vault.taskFolders', env: ['TASK_FOLDERS'] },
  { key: 'vault.backlogPath', env: ['BACKLOG_PATH'] },
  { key: 'vault.dailyDir', env: ['DAILY_DIR'] },
  { key: 'vault.taskTag', env: ['TASK_TAG'] },
  { key: 'calendar.icsUrl', env: ['ICS_URL'], secret: true },
  { key: 'nowplaying.player', env: ['NOWPLAYING_PLAYER'] },
  { key: 'dev.origin', env: ['DEV_ORIGIN'], devOnly: true },
];

/**
 * Global hotkeys. None is registered until it has a value (S6): a new
 * profile has none, and the legacy import brings the old ones across. The
 * debug, test and quit hotkeys are not settings: they exist in dev runs only.
 */
const HOTKEYS = {
  hud: 'CommandOrControl+Alt+H',
  focus: 'CommandOrControl+Alt+F',
  week: 'CommandOrControl+Alt+W',
  capture: 'CommandOrControl+Alt+N',
};

/** `KEY=value` lines, as the old .env files were written. Quotes are stripped. */
function parseEnv(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function getPath(obj, key) {
  return key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

function setPath(obj, key, value) {
  const parts = key.split('.');
  let o = obj;
  for (const k of parts.slice(0, -1)) {
    if (!o[k] || typeof o[k] !== 'object') o[k] = { v: SECTION_VERSION };
    o = o[k];
  }
  o[parts.at(-1)] = value;
}

function emptyConfig() {
  return { schemaVersion: SCHEMA_VERSION };
}

/**
 * Read config.json defensively. Missing: an empty config. Unreadable: the bad
 * file is kept beside it as `config.json.bad-<time>` and an empty config is
 * used. Written by a newer schema: used as-is, but `readOnly`, so nothing here
 * will overwrite it.
 */
function readConfig(file, now = Date.now()) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { config: emptyConfig(), readOnly: false, existed: false, error: null };
  }
  try {
    const config = JSON.parse(text);
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('not an object');
    const version = Number(config.schemaVersion) || 0;
    return { config, readOnly: version > SCHEMA_VERSION, existed: true, error: null };
  } catch (err) {
    try {
      fs.copyFileSync(file, `${file}.bad-${now}`);
    } catch {
      // keep going with defaults; the original is still on disk
    }
    return { config: emptyConfig(), readOnly: false, existed: true, error: `config.json unreadable (${err.message}); using defaults` };
  }
}

/** Write config.json atomically. Refuses when the file came from a newer schema. */
function writeConfig(file, config, { readOnly = false } = {}) {
  if (readOnly) return { ok: false, reason: 'config.json was written by a newer version; not overwriting it' };
  const out = { ...config, schemaVersion: SCHEMA_VERSION };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  fs.renameSync(`${file}.tmp`, file);
  return { ok: true };
}

/**
 * The secrets file: one JSON object, encrypted as a whole with safeStorage.
 * `set` refuses rather than store anything in plain text.
 */
function makeSecrets({ file, safeStorage }) {
  let cache = null;
  const available = () => {
    try {
      return Boolean(safeStorage && safeStorage.isEncryptionAvailable());
    } catch {
      return false;
    }
  };
  function load() {
    if (cache) return cache;
    cache = {};
    if (!available()) return cache;
    try {
      cache = JSON.parse(safeStorage.decryptString(fs.readFileSync(file))) || {};
    } catch {
      cache = {};
    }
    return cache;
  }
  return {
    available,
    get(key) {
      const v = load()[key];
      return typeof v === 'string' && v ? v : null;
    },
    set(key, value) {
      if (!available()) return { ok: false, reason: 'Windows encryption is unavailable, so the secret was not saved' };
      const next = { ...load(), [key]: String(value) };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, safeStorage.encryptString(JSON.stringify(next)));
      fs.renameSync(`${file}.tmp`, file);
      cache = next;
      return { ok: true };
    },
    delete(key) {
      const cur = load();
      if (!(key in cur)) return { ok: true };
      if (!available()) return { ok: false, reason: 'Windows encryption is unavailable' };
      const next = { ...cur };
      delete next[key];
      fs.writeFileSync(`${file}.tmp`, safeStorage.encryptString(JSON.stringify(next)));
      fs.renameSync(`${file}.tmp`, file);
      cache = next;
      return { ok: true };
    },
  };
}

/**
 * The settings the app runs on, flat by key. Packaged: config.json and
 * secrets only. Dev: those, then `env` (process environment plus the repo's
 * .env), DHUD_<NAME> before WD_<NAME>.
 */
function resolveSettings({ config, secrets = null, env = {}, packaged, fields = FIELDS }) {
  const out = {};
  for (const f of fields) {
    let value = f.secret ? (secrets ? secrets.get(f.key) : null) : getPath(config, f.key);
    if (f.devOnly && packaged) value = undefined;
    if (!packaged) {
      for (const name of f.env) {
        const v = env[`DHUD_${name}`] ?? env[`WD_${name}`] ?? (name === 'VITE_VAULT_PATH' ? env[name] : undefined);
        if (v !== undefined && v !== '') {
          value = v;
          break;
        }
      }
    }
    out[f.key] = value == null ? '' : String(value);
  }
  const hk = (config && config.hotkeys) || {};
  out.hotkeys = Object.fromEntries(Object.keys(HOTKEYS).map((k) => [k, typeof hk[k] === 'string' ? hk[k] : '']));
  return out;
}

/** Files carried across from a Week Dashboard userData folder (copied, never moved). */
const LEGACY_FILES = ['presentation.json', 'week-skeleton.yaml', 'ics-cache.ics'];

/**
 * Build the first config.json from a Week Dashboard install. Returns the
 * config to write, the secrets to store once encryption is ready, and what
 * was copied. Does nothing (returns null) unless `legacyDir` exists: a
 * machine that never had the old app imports nothing, whatever .env files
 * happen to be lying around.
 *
 * `envFiles` are read in order; the first file to set a name wins.
 */
function importLegacy({ legacyDir, newDir, envFiles, now = Date.now(), fields = FIELDS }) {
  if (!legacyDir || !fs.existsSync(legacyDir)) return null;
  const env = {};
  const read = [];
  for (const f of envFiles) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    read.push(f);
    for (const [k, v] of Object.entries(parseEnv(text))) if (!(k in env)) env[k] = v;
  }
  const config = emptyConfig();
  const secrets = {};
  for (const f of fields) {
    if (f.devOnly) continue;
    const name = f.env.find((n) => env[`WD_${n}`] || (n === 'VITE_VAULT_PATH' && env[n]));
    if (!name) continue;
    const value = env[`WD_${name}`] || env[name];
    if (f.secret) secrets[f.key] = value;
    else setPath(config, f.key, value);
  }
  config.hotkeys = { v: SECTION_VERSION, ...HOTKEYS };
  const copied = [];
  fs.mkdirSync(newDir, { recursive: true });
  for (const name of LEGACY_FILES) {
    const from = path.join(legacyDir, name);
    const to = path.join(newDir, name);
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      fs.copyFileSync(from, to);
      copied.push(name);
    }
  }
  config.imported = {
    v: SECTION_VERSION,
    from: legacyDir,
    at: new Date(now).toISOString(),
    envFiles: read,
    files: copied,
    secretsPending: Object.keys(secrets),
  };
  return { config, secrets, copied };
}

/**
 * Store the import's secrets once encryption is available, and clear the
 * config's `imported.secretsPending` once they are in. If a previous run
 * couldn't store them (encryption unavailable, a crash), they are read again
 * from the same .env files the import used. Returns what it did, for the log.
 */
function finishLegacySecrets({ config, pending, secrets, fields = FIELDS }) {
  const imp = config && config.imported;
  const wanted = imp && Array.isArray(imp.secretsPending) ? imp.secretsPending : [];
  if (!wanted.length) return { stored: [], failed: [], changed: false };
  let values = pending;
  if (!values) {
    values = {};
    const env = {};
    for (const f of imp.envFiles || []) {
      let text = '';
      try {
        text = fs.readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      for (const [k, v] of Object.entries(parseEnv(text))) if (!(k in env)) env[k] = v;
    }
    for (const field of fields.filter((x) => x.secret && wanted.includes(x.key))) {
      const name = field.env.find((n) => env[`WD_${n}`]);
      if (name) values[field.key] = env[`WD_${name}`];
    }
  }
  const stored = [];
  const failed = [];
  for (const key of wanted) {
    if (!values[key]) {
      stored.push(key); // nothing left to carry across
      continue;
    }
    const r = secrets.set(key, values[key]);
    (r.ok ? stored : failed).push(key);
  }
  imp.secretsPending = failed;
  return { stored, failed, changed: true };
}

/**
 * A private add-on's own settings (Phase 9.3), as FIELDS entries under
 * `addons.<id>.`: an add-on declares `settings: [{ key, env, secret?, devOnly? }]`
 * so the core's list never names an add-on. The legacy import and dev
 * overrides treat them exactly like the core's.
 */
function addonFields(addons) {
  const out = [];
  for (const a of addons || []) {
    for (const f of (a && a.settings) || []) {
      if (!f || !/^[a-zA-Z][a-zA-Z0-9]{0,31}$/.test(String(f.key))) continue;
      out.push({ key: `addons.${a.id}.${f.key}`, env: Array.isArray(f.env) ? f.env : [], secret: Boolean(f.secret), devOnly: Boolean(f.devOnly) });
    }
  }
  return out;
}

module.exports = {
  addonFields,
  finishLegacySecrets,
  SCHEMA_VERSION,
  FIELDS,
  HOTKEYS,
  LEGACY_FILES,
  parseEnv,
  readConfig,
  writeConfig,
  makeSecrets,
  resolveSettings,
  importLegacy,
  getPath,
};
