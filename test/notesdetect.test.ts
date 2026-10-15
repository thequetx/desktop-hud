import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// Detect-and-suggest for a picked notes folder, and the checks on the paths
// and tag the wizard and Integrations page save (Phase 9.5).

const require_ = createRequire(import.meta.url);
const { detectConventions, cleanRel, cleanTag } = require_('../electron/notesdetect.cjs') as any;

let tmp: string;
let root: string;
const put = async (rel: string, text = '# x\n') => {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), text);
};

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'dhud-detect-'));
  root = path.join(tmp, 'vault');
  await mkdir(root);
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('detectConventions', () => {
  it('finds the weekly and daily folders, the backlog, and an Obsidian vault', async () => {
    await mkdir(path.join(root, '.obsidian'));
    await put('Planning/Weekly/2026-W41.md');
    await put('Planning/Weekly/2026-W42.md');
    await put('Archive/2025-W01.md');
    await put('Journal/2026-10-14.md');
    await put('Journal/2026-10-15.md');
    await put('Projects/App/Backlog.md');
    await put('Backlog.md');
    expect(await detectConventions(root)).toEqual({
      obsidian: true,
      weeklyDir: 'Planning/Weekly',
      dailyDir: 'Journal',
      backlogPath: 'Backlog.md',
      weeks: 2,
      days: 2,
    });
  });

  it('says nothing for a folder with none of them', async () => {
    await put('Ideas.md');
    expect(await detectConventions(root)).toEqual({ obsidian: false, weeklyDir: null, dailyDir: null, backlogPath: null, weeks: 0, days: 0 });
  });

  it('does not follow a junction out of the folder', async () => {
    const outside = path.join(tmp, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, '2026-W42.md'), '# W42\n');
    await symlink(outside, path.join(root, 'link'), 'junction');
    expect((await detectConventions(root)).weeklyDir).toBeNull();
  });
});

describe('cleanRel and cleanTag', () => {
  it('keeps vault-relative paths and refuses the rest', () => {
    expect(cleanRel('Weekly')).toBe('Weekly');
    expect(cleanRel('\\Planning\\Weekly\\')).toBe('Planning/Weekly');
    expect(cleanRel('')).toBe('');
    expect(cleanRel('../outside')).toBeNull();
    expect(cleanRel('D:\\notes')).toBeNull();
    expect(cleanRel('a/./b')).toBeNull();
    expect(cleanRel('bad|name')).toBeNull();
    expect(cleanRel('Backlog.md', { file: true })).toBe('Backlog.md');
    expect(cleanRel('Backlog.txt', { file: true })).toBeNull();
    expect(cleanRel(42)).toBeNull();
  });

  it('normalises a tag and refuses one that is not a tag', () => {
    expect(cleanTag('thisweek')).toBe('#thisweek');
    expect(cleanTag('#this-week/now')).toBe('#this-week/now');
    expect(cleanTag('#diese_Woche')).toBe('#diese_Woche');
    expect(cleanTag('#two words')).toBeNull();
    expect(cleanTag('')).toBeNull();
  });
});
