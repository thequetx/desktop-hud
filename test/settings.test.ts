import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const S = require_('../electron/settings.cjs') as any;

/** A stand-in for Electron's safeStorage: reversible, and switchable off. */
function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s: string) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`),
    decryptString: (b: Buffer) => Buffer.from(String(b).replace(/^enc:/, ''), 'base64').toString(),
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'dhud-settings-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('resolveSettings — where each value comes from', () => {
  const config = { schemaVersion: 1, vault: { v: 1, path: 'C:/vault', weeklyDir: 'Weekly' }, hotkeys: { v: 1, hud: 'Ctrl+H' } };
  const env = { WD_VAULT_PATH: 'C:/from-env', DHUD_WEEKLY_DIR: 'Dhud', WD_WEEKLY_DIR: 'Wd', WD_SONGIFY_EXE: 'C:/evil.exe', WD_DEV_ORIGIN: 'http://127.0.0.1:9999' };

  it('packaged: config and secrets only, never the environment (S12)', () => {
    // An add-on's program path too: a planted env var must never set it.
    const fields = [...S.FIELDS, ...S.addonFields([{ id: 'songify', settings: [{ key: 'exe', env: ['SONGIFY_EXE'] }] }])];
    const s = S.resolveSettings({ config, env, packaged: true, fields });
    expect(s['vault.path']).toBe('C:/vault');
    expect(s['vault.weeklyDir']).toBe('Weekly');
    expect(s['addons.songify.exe']).toBe('');
    expect(s['dev.origin']).toBe('');
  });

  it('dev: the environment overrides config, DHUD_ before WD_', () => {
    const s = S.resolveSettings({ config, env, packaged: false });
    expect(s['vault.path']).toBe('C:/from-env');
    expect(s['vault.weeklyDir']).toBe('Dhud');
    expect(s['dev.origin']).toBe('http://127.0.0.1:9999');
  });

  it('hotkeys are only the ones set; nothing else is registered (S6)', () => {
    const s = S.resolveSettings({ config, env: {}, packaged: true });
    expect(s.hotkeys).toEqual({ hud: 'Ctrl+H', focus: '', week: '', capture: '' });
    expect(S.resolveSettings({ config: {}, env: {}, packaged: true }).hotkeys.hud).toBe('');
  });

  it('secrets come from the secrets store, not config.json', () => {
    const secrets = { get: (k: string) => (k === 'calendar.icsUrl' ? 'https://cal.example/x.ics' : null) };
    const s = S.resolveSettings({ config: { calendar: { icsUrl: 'https://plain.example/leak.ics' } }, secrets, packaged: true });
    expect(s['calendar.icsUrl']).toBe('https://cal.example/x.ics');
  });
});

describe('readConfig / writeConfig — defensive, versioned (S7)', () => {
  it('a missing file is an empty config', () => {
    const r = S.readConfig(path.join(dir, 'config.json'));
    expect(r).toMatchObject({ readOnly: false, existed: false, error: null });
  });

  it('an unreadable file is kept aside and defaults are used', async () => {
    const file = path.join(dir, 'config.json');
    await writeFile(file, '{ not json', 'utf8');
    const r = S.readConfig(file, 123);
    expect(r.error).toMatch(/unreadable/);
    expect(await readFile(`${file}.bad-123`, 'utf8')).toBe('{ not json');
  });

  it('a newer schema is read but never overwritten', async () => {
    const file = path.join(dir, 'config.json');
    await writeFile(file, JSON.stringify({ schemaVersion: 99, vault: { path: 'X' } }), 'utf8');
    const r = S.readConfig(file);
    expect(r.readOnly).toBe(true);
    expect(r.config.vault.path).toBe('X');
    expect(S.writeConfig(file, { vault: { path: 'Y' } }, { readOnly: r.readOnly }).ok).toBe(false);
    expect(JSON.parse(await readFile(file, 'utf8')).vault.path).toBe('X');
  });

  it('writes atomically and stamps the schema version', async () => {
    const file = path.join(dir, 'sub', 'config.json');
    expect(S.writeConfig(file, { vault: { v: 1, path: 'Z' } }).ok).toBe(true);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ schemaVersion: 1, vault: { path: 'Z' } });
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
});

describe('makeSecrets — encrypted, or refused (S13)', () => {
  it('round-trips through the encrypted file', () => {
    const file = path.join(dir, 'secrets.bin');
    const a = S.makeSecrets({ file, safeStorage: fakeSafeStorage() });
    expect(a.set('calendar.icsUrl', 'https://cal.example/p.ics')).toEqual({ ok: true });
    const b = S.makeSecrets({ file, safeStorage: fakeSafeStorage() });
    expect(b.get('calendar.icsUrl')).toBe('https://cal.example/p.ics');
  });

  it('never writes plain text when encryption is unavailable', async () => {
    const file = path.join(dir, 'secrets.bin');
    const s = S.makeSecrets({ file, safeStorage: fakeSafeStorage(false) });
    const r = s.set('calendar.icsUrl', 'https://cal.example/p.ics');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/encryption is unavailable/);
    expect(existsSync(file)).toBe(false);
  });

  it('the file holds no readable secret', async () => {
    const file = path.join(dir, 'secrets.bin');
    S.makeSecrets({ file, safeStorage: fakeSafeStorage() }).set('calendar.icsUrl', 'https://cal.example/private-abc.ics');
    expect(await readFile(file, 'utf8')).not.toContain('private-abc');
  });
});

describe('importLegacy — a Week Dashboard install, carried across once', () => {
  async function legacyInstall() {
    const legacyDir = path.join(dir, 'week-dashboard');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(path.join(legacyDir, 'presentation.json'), '{"v":3}', 'utf8');
    await writeFile(path.join(legacyDir, 'week-skeleton.yaml'), 'blocks: []\n', 'utf8');
    await writeFile(path.join(legacyDir, 'wd-google-token.bin'), 'opaque', 'utf8');
    const repoEnv = path.join(dir, 'repo.env');
    await writeFile(
      repoEnv,
      ['WD_VAULT_PATH=C:\\vault', 'WD_WEEKLY_DIR=Weekly', 'WD_ICS_URL="https://cal.example/private-x.ics"', 'WD_GOOGLE_CLIENT_SECRET=s3cret', 'WD_MEAL_PREVIEW=1', 'VITE_VAULT_PATH=C:\\ignored'].join('\n'),
      'utf8',
    );
    return { legacyDir, repoEnv };
  }

  it('does nothing on a machine that never had the old app', () => {
    expect(S.importLegacy({ legacyDir: path.join(dir, 'nope'), newDir: path.join(dir, 'new'), envFiles: [] })).toBeNull();
  });

  it('maps .env into config and secrets, copies files, and leaves the old folder alone', async () => {
    const { legacyDir, repoEnv } = await legacyInstall();
    const before = (await readdir(legacyDir)).sort();
    const newDir = path.join(dir, 'Desktop HUD');
    // The add-ons' own settings come in as fields, as electron/main.cjs passes them.
    const fields = [...S.FIELDS, ...S.addonFields([{ id: 'google', settings: [{ key: 'clientSecret', env: ['GOOGLE_CLIENT_SECRET'], secret: true }] }])];
    const r = S.importLegacy({ legacyDir, newDir, envFiles: [path.join(legacyDir, '.env'), repoEnv], now: 0, fields });

    expect(r.config.vault).toMatchObject({ path: 'C:\\vault', weeklyDir: 'Weekly' });
    // Secrets are returned for the encrypted store, never put in config.json.
    expect(JSON.stringify(r.config)).not.toContain('private-x');
    expect(JSON.stringify(r.config)).not.toContain('s3cret');
    expect(r.secrets).toEqual({ 'calendar.icsUrl': 'https://cal.example/private-x.ics', 'addons.google.clientSecret': 's3cret' });
    // Dev-only switches don't come across.
    expect(r.config.addons?.meal?.preview).toBeUndefined();
    // The old hotkeys come across; a new profile would have none.
    expect(r.config.hotkeys).toMatchObject(S.HOTKEYS);
    expect(r.config.imported).toMatchObject({ envFiles: [repoEnv], files: ['presentation.json', 'week-skeleton.yaml'] });

    expect(await readFile(path.join(newDir, 'presentation.json'), 'utf8')).toBe('{"v":3}');
    // The Google token is not copied: it is sealed with the old folder's key.
    expect(existsSync(path.join(newDir, 'wd-google-token.bin'))).toBe(false);
    expect((await readdir(legacyDir)).sort()).toEqual(before);
  });

  it("doesn't overwrite a file already in the new folder", async () => {
    const { legacyDir } = await legacyInstall();
    const newDir = path.join(dir, 'Desktop HUD');
    await mkdir(newDir, { recursive: true });
    await writeFile(path.join(newDir, 'presentation.json'), '{"v":3,"mine":true}', 'utf8');
    const r = S.importLegacy({ legacyDir, newDir, envFiles: [] });
    expect(r.copied).toEqual(['week-skeleton.yaml']);
    expect(await readFile(path.join(newDir, 'presentation.json'), 'utf8')).toContain('mine');
  });
});

describe('addonFields — an add-on declares its own settings (Phase 9.3)', () => {
  it("maps them under addons.<id>, so the core's list never names an add-on", () => {
    const fields = S.addonFields([
      { id: 'example', settings: [{ key: 'file', env: ['EXAMPLE_FILE'] }, { key: 'token', env: ['EXAMPLE_TOKEN'], secret: true }, { key: 'bad key!' }] },
      { id: 'none' },
    ]);
    expect(fields).toEqual([
      { key: 'addons.example.file', env: ['EXAMPLE_FILE'], secret: false, devOnly: false },
      { key: 'addons.example.token', env: ['EXAMPLE_TOKEN'], secret: true, devOnly: false },
    ]);
    const all = [...S.FIELDS, ...fields];
    const s = S.resolveSettings({ config: { addons: { example: { file: 'C:/x.json' } } }, env: {}, packaged: true, fields: all });
    expect(s['addons.example.file']).toBe('C:/x.json');
    expect(S.FIELDS.some((f: { key: string }) => /hollow/i.test(f.key))).toBe(false);
  });
});


describe('setup state survives interruption', () => {
  it('persists unfinished setup before later startup saves and keeps it on restart', () => {
    const file = path.join(dir, 'config.json');
    const first = S.readConfig(file);
    expect(S.initialiseOnboarding(first)).toBe(true);
    first.config.calendar = { sources: [] };
    S.writeConfig(file, first.config);
    const second = S.readConfig(file);
    expect(S.initialiseOnboarding(second)).toBe(false);
    expect(second.config.onboarding.done).toBe(false);
  });
  it('keeps established legacy installations out of the wizard', () => {
    const state = { config: { vault: { path: 'X' } }, existed: true };
    S.initialiseOnboarding(state);
    expect((state.config as any).onboarding.done).toBe(true);
  });
  it('does not treat an empty or damaged config as completed setup', () => {
    const state = { config: {}, existed: true, error: 'bad config' };
    S.initialiseOnboarding(state);
    expect((state.config as any).onboarding.done).toBe(false);
  });
  it('does not modify a newer config', () => {
    const state = { config: { schemaVersion: 99 }, existed: true, readOnly: true };
    expect(S.initialiseOnboarding(state)).toBe(false);
    expect(state.config).toEqual({ schemaVersion: 99 });
  });
  it('distinguishes an absent weekly setting from an explicitly chosen root', () => {
    expect(S.resolveSettings({ config: {}, packaged: true })['vault.weeklyDir']).toBe('Weekly');
    expect(S.resolveSettings({ config: { vault: { weeklyDir: '' } }, packaged: true })['vault.weeklyDir']).toBe('');
  });
});


describe('task scope migration', () => {
  it('preserves the effective legacy skeleton scope over an imported environment seed', () => {
    const config = { vault: { taskFolders: 'Old' } };
    expect(S.migrateTaskScope(config, ['Current'], 'Old').folders).toEqual(['Current']);
    expect(S.migrateTaskScope(config, ['Later'], 'Old').folders).toEqual(['Current']);
  });
  it('keeps an explicit empty Settings scope and falls back when no skeleton exists', () => {
    expect(S.migrateTaskScope({ vault: { scopeVersion: 1, taskFolders: '' } }, ['Ignored'], '').folders).toEqual([]);
    expect(S.migrateTaskScope({}, null, 'One, Two').folders).toEqual(['One', 'Two']);
  });
});
