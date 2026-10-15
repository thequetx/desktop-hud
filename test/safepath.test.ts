import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// Reading inside a notes folder (Phase 9.4, trust model S3, Bug Log #66): a
// junction inside the vault must not lead a bubble or the sweep outside it.
// Junctions need no admin rights on Windows, so this runs everywhere here.

const require_ = createRequire(import.meta.url);
const { makeContainment, walkMd, readNote, MAX_NOTE_BYTES } = require_('../electron/safepath.cjs') as any;
const { makeWidgetSources } = require_('../electron/widgets.cjs') as any;

let tmp: string;
let vault: string;
let outside: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'dhud-safe-'));
  vault = path.join(tmp, 'vault');
  outside = path.join(tmp, 'outside');
  await mkdir(path.join(vault, 'Notes'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(vault, 'Notes', 'Plan.md'), '# Plan\n\n## Today\n\n- [ ] Inside task\n');
  await writeFile(path.join(outside, 'secret.md'), '# Secret\n\n## Today\n\n- [ ] Outside task\n');
  await symlink(outside, path.join(vault, 'link'), 'junction');
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const collect = async (it: AsyncIterable<string>) => {
  const out: string[] = [];
  for await (const f of it) out.push(path.relative(vault, f).split(path.sep).join('/'));
  return out.sort();
};

describe('makeContainment', () => {
  it('allows real files inside, refuses names that leave, and refuses a junction out', async () => {
    const c = makeContainment(vault);
    expect(await c.real('Notes/Plan.md')).toBeTruthy();
    expect(c.lexical('../outside/secret.md')).toBeNull();
    // By name this is inside the vault; really it is not.
    expect(c.lexical('link/secret.md')).toBeTruthy();
    expect(await c.real('link/secret.md')).toBeNull();
    expect(await c.real('Notes/missing.md')).toBeNull();
  });
});

describe('walkMd', () => {
  it('never follows a junction', async () => {
    expect(await collect(walkMd(vault))).toEqual(['Notes/Plan.md']);
  });

  it('stops at its depth limit', async () => {
    let d = vault;
    for (let i = 0; i < 20; i++) d = path.join(d, `d${i}`);
    await mkdir(d, { recursive: true });
    await writeFile(path.join(d, 'deep.md'), 'x');
    expect(await collect(walkMd(vault))).toEqual(['Notes/Plan.md']);
  });
});

describe('readNote', () => {
  it('skips a file over the size cap', async () => {
    const big = path.join(vault, 'Notes', 'big.md');
    await writeFile(big, Buffer.alloc(MAX_NOTE_BYTES + 1, 'a'));
    expect(await readNote(big)).toBeNull();
    expect(await readNote(path.join(vault, 'Notes', 'Plan.md'))).toContain('Inside task');
  });
});

describe('custom bubbles through a junction (Bug Log #66)', () => {
  const ctx = { today: '2026-10-15' };

  it('a note bubble cannot read a note behind a junction', async () => {
    const w = makeWidgetSources({ root: vault, dailyDir: '' });
    const r = await w.read(
      {
        custom: [
          { id: 'in', type: 'note', source: { path: 'Notes/Plan.md', heading: 'Today', items: 'open' } },
          { id: 'out', type: 'note', source: { path: 'link/secret.md', heading: 'Today', items: 'open' } },
        ],
      },
      ctx,
    );
    expect(r.custom.in.exists).toBe(true);
    expect(JSON.stringify(r.custom.in)).toContain('Inside task');
    expect(r.custom.out.exists).toBe(false);
    expect(JSON.stringify(r.custom.out)).not.toContain('Outside task');
  });

  it('a tasks query cannot be pointed at a junction, and skips it when walking', async () => {
    const w = makeWidgetSources({ root: vault, dailyDir: '' });
    const r = await w.read(
      {
        custom: [
          { id: 'all', type: 'tasks', source: { folder: '', due: 'any' } },
          { id: 'link', type: 'tasks', source: { folder: 'link', due: 'any' } },
        ],
      },
      ctx,
    );
    expect(r.custom.all.items.map((t: any) => t.text)).toEqual(['Inside task']);
    expect(r.custom.link).toEqual({ items: [], total: 0 });
  });

  it('the editor picker and describe() do not see through it', async () => {
    const w = makeWidgetSources({ root: vault, dailyDir: '' });
    expect(await w.listNotes()).toEqual(['Notes/Plan.md']);
    expect((await w.describe('link/secret', ctx.today)).exists).toBe(false);
  });
});
