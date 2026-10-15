import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { link, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// Writing to someone's notes (Phase 9.4, trust model S1): electron/safewrite.cjs,
// and the vault's write switch.

const require_ = createRequire(import.meta.url);
const { makeSafeWriter, WriteConflict, MAX_VERSIONS } = require_('../electron/safewrite.cjs') as any;
const { makeVault } = require_('../electron/vault.cjs') as any;

let tmp: string;
let root: string;
let backups: string;
let note: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'dhud-write-'));
  root = path.join(tmp, 'vault');
  backups = path.join(tmp, 'backups');
  await mkdir(root, { recursive: true });
  note = path.join(root, 'Backlog.md');
  await writeFile(note, 'v1\n');
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const allBackups = async () => {
  const out: string[] = [];
  for (const d of await readdir(backups).catch(() => [] as string[])) {
    for (const f of await readdir(path.join(backups, d))) if (f.endsWith('.md')) out.push(await readFile(path.join(backups, d, f), 'utf8'));
  }
  return out;
};

describe('makeSafeWriter', () => {
  it('replaces the file, backs up what was there, and leaves no temp file', async () => {
    const w = makeSafeWriter({ backupsDir: backups, root });
    await w.write(note, 'v2\n', { expect: 'v1\n' });
    expect(await readFile(note, 'utf8')).toBe('v2\n');
    expect(await allBackups()).toEqual(['v1\n']);
    expect((await readdir(root)).filter((n) => n.includes('dhud-tmp'))).toEqual([]);
  });

  it('refuses when the file changed since it was read, and writes nothing', async () => {
    const w = makeSafeWriter({ backupsDir: backups, root });
    await writeFile(note, 'edited in Obsidian\n');
    await expect(w.write(note, 'v2\n', { expect: 'v1\n' })).rejects.toBeInstanceOf(WriteConflict);
    expect(await readFile(note, 'utf8')).toBe('edited in Obsidian\n');
    expect(await allBackups()).toEqual([]);
  });

  it('refuses to create a file that appeared in the meantime', async () => {
    const w = makeSafeWriter({ backupsDir: backups, root });
    await expect(w.write(note, 'new\n', { expect: null })).rejects.toBeInstanceOf(WriteConflict);
    await w.write(path.join(root, 'Weekly', '2026-W42.md'), '# W42\n', { expect: null });
    expect(await readFile(path.join(root, 'Weekly', '2026-W42.md'), 'utf8')).toBe('# W42\n');
  });

  it('retries a rename while the file is held, then succeeds', async () => {
    let fails = 2;
    const rename = async (a: string, b: string) => {
      if (fails-- > 0) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return fsp.rename(a, b);
    };
    const w = makeSafeWriter({ backupsDir: backups, root, rename });
    await w.write(note, 'v2\n', { expect: 'v1\n' });
    expect(await readFile(note, 'utf8')).toBe('v2\n');
  });

  it('gives up on a file held too long, keeps the original, and removes the temp file', async () => {
    const rename = async () => {
      throw Object.assign(new Error('held'), { code: 'EPERM' });
    };
    const w = makeSafeWriter({ backupsDir: backups, root, rename });
    await expect(w.write(note, 'v2\n', { expect: 'v1\n' })).rejects.toThrow(/held/);
    expect(await readFile(note, 'utf8')).toBe('v1\n');
    expect((await readdir(root)).filter((n) => n.includes('dhud-tmp'))).toEqual([]);
  }, 10_000);

  it('writes a hardlinked file in place, so its other name sees the change', async () => {
    const other = path.join(tmp, 'elsewhere.md');
    await link(note, other);
    const w = makeSafeWriter({ backupsDir: backups, root });
    const r = await w.write(note, 'v2\n', { expect: 'v1\n' });
    expect(r.inPlace).toBe(true);
    expect(await readFile(other, 'utf8')).toBe('v2\n');
    expect((await stat(note)).nlink).toBe(2);
  });

  it('keeps the last MAX_VERSIONS backups of a file', async () => {
    let t = Date.parse('2026-10-15T00:00:00Z');
    const w = makeSafeWriter({ backupsDir: backups, root, now: () => new Date((t += 1000)) });
    let prev = 'v1\n';
    for (let i = 2; i < MAX_VERSIONS + 6; i++) {
      const next = `v${i}\n`;
      await w.write(note, next, { expect: prev });
      prev = next;
    }
    const v = await w.versions(note);
    expect(v).toHaveLength(MAX_VERSIONS);
    expect(await readFile(v[0].file, 'utf8')).toBe(`v${MAX_VERSIONS + 4}\n`);
  });
});

describe('the vault write switch', () => {
  it('a read-only vault refuses capture and week creation and touches nothing', async () => {
    await mkdir(path.join(root, 'Weekly'));
    const before = await readFile(note, 'utf8');
    const vault = makeVault({ vaultPath: root, weeklyDir: 'Weekly' });
    expect(vault.canWrite).toBe(false);
    expect(await vault.appendBacklog('An idea')).toMatchObject({ ok: false, readOnly: true });
    expect(await vault.createWeek('2026-W42')).toMatchObject({ ok: false, readOnly: true });
    expect(await readFile(note, 'utf8')).toBe(before);
    expect(await readdir(path.join(root, 'Weekly'))).toEqual([]);
  });

  it('once turned on, a capture goes through the safe writer (and is backed up)', async () => {
    const writer = makeSafeWriter({ backupsDir: backups, root });
    const vault = makeVault({ vaultPath: root, weeklyDir: 'Weekly', writer });
    vault.setCanWrite(true);
    expect((await vault.appendBacklog('An idea')).ok).toBe(true);
    expect(await readFile(note, 'utf8')).toContain('- [ ] An idea');
    expect(await allBackups()).toEqual(['v1\n']);
  });
});

describe('a write interrupted part-way (Phase 9.6)', () => {
  it('a temp file left by a crash does not block or leak into the next write', async () => {
    // A crash between writing the temp file and the rename leaves it behind.
    await writeFile(path.join(root, '.Backlog.md.dhud-tmp'), 'half a write');
    const w = makeSafeWriter({ backupsDir: backups, root });
    await w.write(note, 'v2\n', { expect: 'v1\n' });
    expect(await readFile(note, 'utf8')).toBe('v2\n');
    expect((await readdir(root)).filter((n) => n.includes('dhud-tmp'))).toEqual([]);
  });

  it('a note the user saved during a failed write is never overwritten by the retry', async () => {
    const w = makeSafeWriter({ backupsDir: backups, root, rename: async () => { throw Object.assign(new Error('held'), { code: 'EBUSY' }); } });
    await expect(w.write(note, 'mine\n', { expect: 'v1\n' })).rejects.toThrow();
    await writeFile(note, 'saved in Obsidian meanwhile\n');
    const ok = makeSafeWriter({ backupsDir: backups, root });
    await expect(ok.write(note, 'mine\n', { expect: 'v1\n' })).rejects.toBeInstanceOf(WriteConflict);
    expect(await readFile(note, 'utf8')).toBe('saved in Obsidian meanwhile\n');
  }, 10_000);
});
