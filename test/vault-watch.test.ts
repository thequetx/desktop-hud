import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// electron/vault.cjs pulls in nothing from Electron, so watch() can be driven
// against a real (throwaway) directory with a real fs.watch behind it. Never
// the user's vault — every test asserts the root is somewhere under the temp dir.
const require_ = createRequire(import.meta.url);
const { makeVault } = require_('../electron/vault.cjs') as any;
const { makeSafeWriter } = require_('../electron/safewrite.cjs') as any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// watch() debounces at 300 ms; give an event comfortably longer than that to
// arrive and settle before asserting, and use the same value when asserting
// that nothing arrived.
const SETTLE_MS = 900;

const TEMPLATE = [
  '---',
  'week: YYYY-WWW',
  'range: YYYY-MM-DD to YYYY-MM-DD',
  'last_updated: YYYY-MM-DD',
  '---',
  '',
  '# Week YYYY-WWW  ·  Mon DD Mon – Sun DD Mon',
  '',
  '## Intentions',
  '',
  '## Tasks',
  '',
  '## Review',
  '',
].join('\n');

const NOTE = [
  '---',
  'week: 2026-W35',
  'last_updated: 2026-08-25',
  '---',
  '',
  '## Intentions',
  '',
  '- [ ] Ship Phase 3',
  '',
  '## Tasks',
  '',
  '- [ ] Still open',
  '- [ ] Also still open',
  '',
  '## Review',
  '',
].join('\n');

describe('vault watch()', () => {
  let root: string;
  let weeklyAbs: string;
  let vault: any;
  let stop: (() => void) | null = null;
  let fired: string[][];

  const collect = () => {
    fired = [];
    return (paths: string[]) => {
      fired.push(paths);
    };
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wd-watch-test-'));
    weeklyAbs = path.join(root, 'Weekly');
    await mkdir(weeklyAbs, { recursive: true });
    await writeFile(path.join(weeklyAbs, '_Template.md'), TEMPLATE, 'utf8');
    await writeFile(path.join(weeklyAbs, '2026-W35.md'), NOTE, 'utf8');
    vault = makeVault({ vaultPath: root, weeklyDir: 'Weekly', canWrite: true });
    expect(path.resolve(vault.root).toLowerCase()).not.toContain('quetx');
    fired = [];
  });

  afterEach(async () => {
    if (stop) stop();
    stop = null;
    await rm(root, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Filtering + debounce
  // -------------------------------------------------------------------------

  it('coalesces a burst of writes into one callback', async () => {
    stop = vault.watch(collect());
    await sleep(100);

    // Obsidian saves noisily; so does a script. One flush should come out.
    for (let i = 0; i < 5; i++) {
      await writeFile(path.join(root, 'Burst.md'), `- [ ] pass ${i}\n`, 'utf8');
      await sleep(20);
    }
    await sleep(SETTLE_MS);

    expect(fired.length).toBe(1);
    expect(fired[0].some((p) => p.endsWith('Burst.md') || p === '*')).toBe(true);
  });

  it('ignores non-.md files and the skipped directories', async () => {
    stop = vault.watch(collect());
    await sleep(100);

    await mkdir(path.join(root, '.obsidian'), { recursive: true });
    await writeFile(path.join(root, '.obsidian', 'workspace.json'), '{}', 'utf8');
    await writeFile(path.join(root, '.obsidian', 'notes.md'), '- [ ] plugin\n', 'utf8');
    await mkdir(path.join(root, 'node_modules'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'pkg.md'), '# no\n', 'utf8');
    await writeFile(path.join(root, 'Scratch.txt'), 'not markdown\n', 'utf8');
    await sleep(SETTLE_MS);
    expect(fired).toEqual([]);

    // ...and a real note still gets through, so the filter isn't just "off".
    await writeFile(path.join(root, 'Real.md'), '- [ ] yes\n', 'utf8');
    await sleep(SETTLE_MS);
    expect(fired.length).toBe(1);
  });

  it('stops delivering once the returned stop() is called', async () => {
    const s = vault.watch(collect());
    await sleep(100);
    s();
    await writeFile(path.join(root, 'After.md'), '- [ ] nope\n', 'utf8');
    await sleep(SETTLE_MS);
    expect(fired).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Self-write suppression (C3)
  // -------------------------------------------------------------------------

  it('does not bounce the app’s own capture back at the windows', async () => {
    stop = vault.watch(collect());
    await sleep(100);

    expect((await vault.appendBacklog('An idea')).ok).toBe(true);
    await sleep(SETTLE_MS);

    expect(fired).toEqual([]);
  });

  it('nor one made through the safe writer (temp file, then rename)', async () => {
    const writer = makeSafeWriter({ backupsDir: path.join(root, '..', path.basename(root) + '-backups'), root });
    const safe = makeVault({ vaultPath: root, weeklyDir: 'Weekly', canWrite: true, writer });
    stop = safe.watch(collect());
    await sleep(100);

    expect((await safe.appendBacklog('An idea')).ok).toBe(true);
    expect((await safe.appendBacklog('Another')).ok).toBe(true);
    await sleep(SETTLE_MS);

    expect(fired).toEqual([]);
  });

  it('does not bounce createWeek back either', async () => {
    stop = vault.watch(collect());
    await sleep(100);
    await vault.createWeek('2026-W40');
    await sleep(SETTLE_MS);
    expect(fired).toEqual([]);
  });

  it('still reports a real Obsidian save that lands moments after an in-app write', async () => {
    // C3: suppression used to be a blanket 2-second window on the *path*, so
    // the user ticking a box in the rail while the same note was open in Obsidian
    // swallowed Obsidian's own autosave ~500 ms later. The board stayed wrong
    // until the 4-minute rescan.
    stop = vault.watch(collect());
    await sleep(100);

    const note = path.join(root, 'Backlog.md');
    await vault.appendBacklog('An idea');

    // Obsidian flushes its own copy of the buffer, well inside the old window.
    await sleep(400);
    await writeFile(note, '# Backlog\n\n- [ ] Typed in Obsidian\n', 'utf8');

    await sleep(SETTLE_MS);
    expect(fired.length).toBe(1);
    expect(fired[0].some((p) => p === '*' || p.endsWith('Backlog.md'))).toBe(true);
  });

  it('suppresses only the write it made: a second external write still gets through', async () => {
    stop = vault.watch(collect());
    await sleep(100);

    await vault.createWeek('2026-W41');
    const created = path.join(weeklyAbs, '2026-W41.md');
    await sleep(SETTLE_MS);
    expect(fired).toEqual([]);

    await writeFile(created, '# edited elsewhere\n- [ ] one\n', 'utf8');
    await sleep(SETTLE_MS);
    expect(fired.length).toBe(1);

    await writeFile(created, '# edited elsewhere again\n- [ ] one\n- [ ] two\n', 'utf8');
    await sleep(SETTLE_MS);
    expect(fired.length).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Re-arm + degradation (P4)
  // -------------------------------------------------------------------------

  it('re-arms after fs.watch throws on the way up', async () => {
    // P4: a vault on a network / OneDrive path that isn't mounted yet at
    // whenReady makes fss.watch throw synchronously. The old catch logged and
    // returned, so live sync stayed off for the whole session — only the
    // watcher.on('error') path ever retried.
    rmSync(root, { recursive: true, force: true });
    stop = vault.watch(collect(), { rearmMs: 60, maxArms: 40 });

    // The path comes back a moment later, the way a mount does.
    await sleep(150);
    mkdirSync(weeklyAbs, { recursive: true });
    await sleep(400); // a re-arm attempt lands in here

    await writeFile(path.join(root, 'Back.md'), '- [ ] mounted\n', 'utf8');
    await sleep(SETTLE_MS);
    expect(fired.length).toBeGreaterThanOrEqual(1);
    expect(vault.watchDegraded).toBe(false);
  });

  it('says so, once, when it gives up for good', async () => {
    rmSync(root, { recursive: true, force: true });
    const reasons: string[] = [];
    stop = vault.watch(collect(), {
      rearmMs: 20,
      maxArms: 3,
      onDegraded: (why: string) => reasons.push(why),
    });

    await sleep(400);
    expect(reasons.length).toBe(1);
    expect(reasons[0]).toMatch(/gave up after 3 attempts/);
    expect(vault.watchDegraded).toBe(true);
  });

  it('carries the degraded flag on the payload every window already reads', async () => {
    expect((await vault.readWeek('2026-W35')).watchDegraded).toBe(false);

    const dead = path.join(root, 'gone');
    mkdirSync(dead, { recursive: true });
    const orphan = makeVault({ vaultPath: dead, weeklyDir: 'Weekly' });
    rmSync(dead, { recursive: true, force: true });
    const s = orphan.watch(() => {}, { rearmMs: 10, maxArms: 2 });
    await sleep(250);
    s();

    expect(orphan.watchDegraded).toBe(true);
    expect((await orphan.readWeek('2026-W35')).watchDegraded).toBe(true);
  });
});
