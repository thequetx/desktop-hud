import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// electron/vault.cjs is CommonJS and runs in the main process; it pulls in
// nothing from Electron, so it can be required straight into a test.
const require_ = createRequire(import.meta.url);
const vaultMod = require_('../electron/vault.cjs');
const {
  CHECK_RE,
  isWatchableRel,
  isoWeekId,
  isoWeekMonday,
  makeVault,
  resolveWeeklyAbs,
  LEGACY_WEEKLY_DIR,
  PROMOTED_WEEKLY_DIR,
  normaliseTitle,
  nextWeekId,
  REPLAN_FLAG_AT,
  AUDIT_RE,
  AUDIT_MAX_ROWS,
  auditRows,
  normaliseAuditLines,
  replaceAuditLines,
  parseSection,
  sectionBounds,
  stripTag,
  mentionsTag,
  weekRange,
  // Phase 5 §2 — the frontmatter layer.
  frontmatterBounds,
  readFrontmatter,
  setFrontmatter,
  setFrontmatterMap,
  normaliseStreaks,
  hoursOf,
  STREAK_MAX_KEYS,
  // Phase 5 §3 — the sweep's scope.
  isExcludedRel,
  parseTaskFolders,
  currentWeekId,
} = vaultMod as any;

const lines = (s: string) => s.split('\n');

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('CHECK_RE — the checklist line shape', () => {
  const text = (l: string) => (l.match(CHECK_RE) ?? [])[3];

  it('matches the markdown task syntax Obsidian writes', () => {
    expect(text('- [ ] Buy milk')).toBe('Buy milk');
    expect(text('- [x] Buy milk')).toBe('Buy milk');
    expect(text('- [X] Buy milk')).toBe('Buy milk');
    expect(text('    - [ ] A nested one')).toBe('A nested one');
  });

  it('rejects things that only look like tasks', () => {
    expect(CHECK_RE.test('- [] Missing the space')).toBe(false);
    expect(CHECK_RE.test('- [~] Not a checkbox state')).toBe(false);
    expect(CHECK_RE.test('* [ ] Asterisk bullet')).toBe(false);
    expect(CHECK_RE.test('Buy milk')).toBe(false);
    expect(CHECK_RE.test('- Buy milk')).toBe(false);
  });
});

describe('sectionBounds', () => {
  const doc = lines(
    ['# Title', '', '## Intentions', '- [ ] a', '', '## Tasks', '- [ ] b', '## Review', '- x'].join(
      '\n',
    ),
  );

  it('runs from the heading to the next heading of any level', () => {
    expect(sectionBounds(doc, 'Intentions')).toEqual({ head: 2, end: 5 });
    expect(sectionBounds(doc, 'Tasks')).toEqual({ head: 5, end: 7 });
  });

  it('runs to the end of the file for the last section', () => {
    expect(sectionBounds(doc, 'Review')).toEqual({ head: 7, end: doc.length });
  });

  it('is case-insensitive but will not match a partial heading', () => {
    expect(sectionBounds(doc, 'intentions')).toEqual({ head: 2, end: 5 });
    expect(sectionBounds(doc, 'Intent')).toBeNull();
    expect(sectionBounds(doc, 'Nope')).toBeNull();
  });
});

describe('parseSection', () => {
  const doc = lines(
    [
      '## Tasks',
      '',
      'Some instructional prose that is not a task.',
      '- [ ] Open one',
      '- [x] Closed one',
      '  - [ ] An indented one',
      '- [ ]   ',
      '- Not a checklist item',
      '',
      '## Review',
      '- [ ] Should not be picked up',
    ].join('\n'),
  );

  it('returns only the checklist items in the section', () => {
    const out = parseSection(doc, 'Tasks', 'Weekly/2026-W35.md');
    expect(out.map((t: any) => t.text)).toEqual(['Open one', 'Closed one', 'An indented one']);
  });

  it('records the done state, the file and the 0-indexed line', () => {
    const out = parseSection(doc, 'Tasks', 'Weekly/2026-W35.md');
    expect(out[0]).toEqual({
      text: 'Open one',
      done: false,
      file: 'Weekly/2026-W35.md',
      line: 3,
      raw: '- [ ] Open one',
    });
    expect(out[1].done).toBe(true);
    expect(out[2].line).toBe(5);
  });

  it('drops an empty checkbox — a blank template row is not a task', () => {
    const out = parseSection(doc, 'Tasks', 'f');
    expect(out.some((t: any) => t.text === '')).toBe(false);
  });

  it('returns nothing for a section that is not there', () => {
    expect(parseSection(doc, 'Intentions', 'f')).toEqual([]);
  });
});

describe('stripTag', () => {
  it('removes the tag and tidies the surrounding whitespace', () => {
    expect(stripTag('Book the dentist #thisweek', '#thisweek')).toBe('Book the dentist');
    expect(stripTag('#thisweek Book the dentist', '#thisweek')).toBe('Book the dentist');
    expect(stripTag('Book #thisweek the dentist', '#thisweek')).toBe('Book the dentist');
  });

  it('leaves a longer tag that merely starts with it alone', () => {
    // The \b guard is what stops `#thisweekend` losing its tail.
    expect(stripTag('Plan it #thisweekend', '#thisweek')).toBe('Plan it #thisweekend');
  });
});

describe('isWatchableRel — which fs.watch events are worth waking three windows for', () => {
  it('accepts markdown anywhere in the vault', () => {
    expect(isWatchableRel('Backlog.md')).toBe(true);
    expect(isWatchableRel('Weekly/2026-W36.md')).toBe(true);
    expect(isWatchableRel('Weekly\\2026-W36.md')).toBe(true); // Windows separators
    expect(isWatchableRel('Notes/DEEP/Nested.MD')).toBe(true);
  });

  it('rejects everything that the sweep would have skipped anyway', () => {
    expect(isWatchableRel('.obsidian/workspace.json')).toBe(false);
    expect(isWatchableRel('.obsidian/plugins/x/data.md')).toBe(false);
    expect(isWatchableRel('.git/COMMIT_EDITMSG')).toBe(false);
    expect(isWatchableRel('node_modules/pkg/readme.md')).toBe(false);
    expect(isWatchableRel('.trash/Deleted.md')).toBe(false);
    expect(isWatchableRel('Attachments/photo.png')).toBe(false);
    expect(isWatchableRel('Weekly')).toBe(false); // the directory itself
    expect(isWatchableRel('')).toBe(false);
  });
});

describe('ISO week ids (the main-process copy)', () => {
  const at = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

  it('agrees with the renderer copy on the awkward year boundaries', () => {
    expect(isoWeekId(at(2027, 1, 3))).toBe('2026-W53');
    expect(isoWeekId(at(2027, 1, 4))).toBe('2027-W01');
    expect(isoWeekId(at(2025, 12, 29))).toBe('2026-W01');
  });

  it('isoWeekMonday is the inverse', () => {
    expect(isoWeekMonday(2026, 36).toISOString().slice(0, 10)).toBe('2026-08-31');
    expect(isoWeekMonday(2026, 1).toISOString().slice(0, 10)).toBe('2025-12-29');
    expect(isoWeekMonday(2026, 53).toISOString().slice(0, 10)).toBe('2026-12-28');
    for (const id of ['2026-W01', '2026-W36', '2026-W53', '2027-W01']) {
      const [y, w] = id.split('-W').map(Number);
      expect(isoWeekId(isoWeekMonday(y, w))).toBe(id);
    }
  });

  it('nextWeekId rolls the year over at W52/W53', () => {
    expect(nextWeekId('2026-W35')).toBe('2026-W36');
    expect(nextWeekId('2026-W52')).toBe('2026-W53'); // 2026 is a 53-week year
    expect(nextWeekId('2026-W53')).toBe('2027-W01');
    expect(nextWeekId('2025-W52')).toBe('2026-W01'); // 2025 is not
    expect(() => nextWeekId('nonsense')).toThrow(/bad week id/);
  });

  it('weekRange spans Monday to Sunday', () => {
    const { mon, sun } = weekRange('2026-W40');
    expect(mon.toISOString().slice(0, 10)).toBe('2026-09-28');
    expect(sun.toISOString().slice(0, 10)).toBe('2026-10-04');
  });
});

// ---------------------------------------------------------------------------
// The file-writing half, against a throwaway vault. Never the real one.
// ---------------------------------------------------------------------------

// Phase 3 §4 + Phase 5 §2 — a verbatim copy of the vault's `_Template.md`
// after the trim: frontmatter (now carrying the Bases-facing fields) plus the
// three `##` headings, and none of the instructional prose that used to be
// copied word-for-word into every generated note.
const TEMPLATE = [
  '---',
  'tags: [week-dashboard, weekly-note]',
  'week: YYYY-WWW',
  'range: YYYY-MM-DD to YYYY-MM-DD',
  'status: planning',
  'intentions_total: 0',
  'intentions_done: 0',
  'tasks_total: 0',
  'tasks_done: 0',
  'hours_planned: 0',
  'hours_kept: 0',
  'streaks: {}',
  'last_updated: YYYY-MM-DD',
  '---',
  '',
  'Related: [[Week Dashboard]]',
  '',
  '# Week YYYY-WWW  ·  Mon DD Mon – Sun DD Mon',
  '',
  '## Intentions',
  '',
  '- [ ] ',
  '',
  '## Tasks',
  '',
  '- [ ] ',
  '',
  '## Review',
  '',
].join('\n');

const W35 = [
  '---',
  'tags: [week-dashboard, weekly-note]',
  'week: 2026-W35',
  'range: 2026-08-24 to 2026-08-30',
  'last_updated: 2026-08-25',
  '---',
  '',
  '# Week 2026-W35  ·  Mon 24 Aug – Sun 30 Aug',
  '',
  '## Intentions',
  '',
  '- [ ] Ship Phase 3',
  '- [x] Seed the week',
  '',
  '## Tasks',
  '',
  '- [x] Already done',
  '- [ ] Still open',
  '- [ ] Also still open',
  '',
  '## Review',
  '',
  '- Wins:',
  '',
].join('\n');

describe('mentionsTag — a documented tag is not a tag', () => {
  const TAG = '#thisweek';

  it('matches a real tag on a task line', () => {
    expect(mentionsTag('- [ ] Book dentist #thisweek', TAG)).toBe(true);
    expect(mentionsTag('- [ ] #thisweek Book dentist', TAG)).toBe(true);
  });

  it('ignores the tag inside an inline code span', () => {
    // The one that actually bit: a checklist line in Plugin Design.md reading
    // "unscheduled tasks from the weekly note + `#thisweek`, with estimates"
    // turned up in the user's rail as a task (2026-08-30).
    expect(
      mentionsTag('- [ ] The rail: tasks from the weekly note + `#thisweek`, with estimates', TAG),
    ).toBe(false);
    expect(mentionsTag('Documented as `#thisweek` in the design note.', TAG)).toBe(false);
  });

  it('still matches when a code span appears elsewhere on the line', () => {
    expect(mentionsTag('- [ ] Fix `parseTaskMeta` #thisweek', TAG)).toBe(true);
  });

  it('does not match a longer tag that merely starts the same', () => {
    expect(mentionsTag('- [ ] Plan #thisweekly review', TAG)).toBe(false);
    expect(mentionsTag('- [ ] Plan #thisweek/admin', TAG)).toBe(false);
  });

  it('matches at the very end of a line', () => {
    expect(mentionsTag('- [ ] Book dentist #thisweek', TAG)).toBe(true);
  });
});

describe('resolveWeeklyAbs — follow the notes, whichever way the move went', () => {
  let root: string;

  const seed = async (rel: string) => {
    const dir = path.join(root, rel);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '2026-W36.md'), '# week\n', 'utf8');
    return dir;
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wd-resolve-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('uses the configured folder when the notes are there', async () => {
    const dir = await seed(LEGACY_WEEKLY_DIR);
    expect(resolveWeeklyAbs(root, LEGACY_WEEKLY_DIR)).toBe(dir);
  });

  it('finds notes promoted to the vault root while the config still points at the old path', async () => {
    // The regression. The owner moved Weekly/ to the vault root on 2026-08-30 and left
    // WD_WEEKLY_DIR alone. The first version early-returned when configured ===
    // legacy, handing back a directory that no longer existed — so the app went
    // blind: notePath null, zero tasks, no error.
    const promoted = await seed(PROMOTED_WEEKLY_DIR);
    expect(resolveWeeklyAbs(root, LEGACY_WEEKLY_DIR)).toBe(promoted);
  });

  it('finds notes still in the old path while the config points at the root', async () => {
    // The direction the first version *did* handle — kept so it stays handled.
    const legacy = await seed(LEGACY_WEEKLY_DIR);
    expect(resolveWeeklyAbs(root, PROMOTED_WEEKLY_DIR)).toBe(legacy);
  });

  it('falls back to the configured path when there are no notes anywhere', async () => {
    // That is where createWeek should put the first one.
    expect(resolveWeeklyAbs(root, PROMOTED_WEEKLY_DIR)).toBe(
      path.join(root, PROMOTED_WEEKLY_DIR),
    );
  });

  it('prefers the configured folder over the others when several have notes', async () => {
    await seed(PROMOTED_WEEKLY_DIR);
    const configured = await seed(LEGACY_WEEKLY_DIR);
    expect(resolveWeeklyAbs(root, LEGACY_WEEKLY_DIR)).toBe(configured);
  });
});

describe('makeVault against a throwaway vault', () => {
  let root: string;
  let weeklyAbs: string;
  let junctionTarget: string | null = null;
  let vault: any;

  const weekly = (id: string) => path.join(weeklyAbs, `${id}.md`);
  const read = (p: string) => readFile(p, 'utf8');

  beforeEach(async () => {
    // A fresh directory per test under the OS temp dir — never the owner's notes.
    root = await mkdtemp(path.join(os.tmpdir(), 'wd-vault-test-'));
    junctionTarget = null;
    weeklyAbs = path.join(root, 'Weekly');
    await mkdir(weeklyAbs, { recursive: true });
    await writeFile(path.join(weeklyAbs, '_Template.md'), TEMPLATE, 'utf8');
    await writeFile(weekly('2026-W35'), W35, 'utf8');
    vault = makeVault({ vaultPath: root, weeklyDir: 'Weekly', canWrite: true });
    expect(path.resolve(vault.root).toLowerCase()).not.toContain('quetx');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    if (junctionTarget) await rm(junctionTarget, { recursive: true, force: true });
  });

  describe('week IDs never become arbitrary paths (Phase 9.0, S3)', () => {
    it('accepts real ISO week IDs only', () => {
      for (const ok of ['2026-W01', '2026-W35', '2026-W53']) expect(vaultMod.isWeekId(ok)).toBe(true);
      for (const bad of [
        '2026-W00',
        '2026-W54',
        '2026-w35',
        '2026-W5',
        '2026-W35.md',
        '../2026-W35',
        '..\\..\\secrets',
        '2026-W35/../../x',
        '',
        null,
        35,
      ]) {
        expect(vaultMod.isWeekId(bad)).toBe(false);
      }
    });

    it('refuses a traversal ID instead of reading the file it points at', async () => {
      // A note outside the weekly folder that a `..` ID would otherwise reach.
      await writeFile(path.join(root, 'secret.md'), '## Tasks\n- [ ] private\n', 'utf8');
      await expect(vault.readWeek('../secret')).rejects.toThrow(/not a week id/);
      await expect(vault.createWeek('..\\secret')).rejects.toThrow(/not a week id/);
      expect(await read(path.join(root, 'secret.md'))).toContain('private');
    });
  });

  describe('readWeek', () => {
    it('reads the two sections of the weekly note', async () => {
      const w = await vault.readWeek('2026-W35');
      expect(w.weekId).toBe('2026-W35');
      expect(w.notePath).toBe('Weekly/2026-W35.md');
      expect(w.intentions.map((t: any) => t.text)).toEqual(['Ship Phase 3', 'Seed the week']);
      expect(w.tasks.map((t: any) => [t.text, t.done])).toEqual([
        ['Already done', true],
        ['Still open', false],
        ['Also still open', false],
      ]);
    });

    it('reports a missing weekly note rather than failing', async () => {
      const w = await vault.readWeek('2026-W44');
      expect(w.notePath).toBeNull();
      expect(w.tasks).toEqual([]);
    });

    it('refuses a weekly note reached through a junction outside the vault', async () => {
      const outside = (junctionTarget = path.join(path.dirname(root), `${path.basename(root)}-outside-read`));
      await mkdir(outside);
      await writeFile(path.join(outside, '2026-W36.md'), '## Tasks\n- [ ] private\n');
      await rm(weeklyAbs, { recursive: true });
      await symlink(outside, weeklyAbs, 'junction');
      const w = await vault.readWeek('2026-W36');
      expect(w.notePath).toBeNull();
      expect(w.tasks).toEqual([]);
    });

    it('does not sweep a configured folder that is a junction outside the vault', async () => {
      const outside = (junctionTarget = path.join(path.dirname(root), `${path.basename(root)}-outside-scan`));
      await mkdir(outside);
      await writeFile(path.join(outside, 'private.md'), '- [ ] private #thisweek\n');
      await symlink(outside, path.join(root, 'escape'), 'junction');
      const scoped = makeVault({ vaultPath: root, weeklyDir: 'Weekly', taskFolders: 'escape' });
      expect((await scoped.readWeek('2026-W35')).thisweek).toEqual([]);
    });

    it('sweeps #thisweek across the vault, tag stripped', async () => {
      await mkdir(path.join(root, 'Projects'), { recursive: true });
      await writeFile(
        path.join(root, 'Projects', 'Twitch.md'),
        ['# Twitch', '- [ ] Fix the overlay #thisweek', '- [ ] Not tagged'].join('\n'),
        'utf8',
      );
      await writeFile(
        path.join(root, 'Backlog.md'),
        ['- [x] Order the mic #thisweek', '- [ ] Someday'].join('\n'),
        'utf8',
      );
      const w = await vault.readWeek('2026-W35');
      expect(w.thisweek.map((t: any) => [t.file, t.text, t.done])).toEqual([
        ['Backlog.md', 'Order the mic', true],
        ['Projects/Twitch.md', 'Fix the overlay', false],
      ]);
    });

    it('excludes the current weekly note from the sweep — it has its own section', async () => {
      await writeFile(
        weekly('2026-W35'),
        W35.replace('- [ ] Still open', '- [ ] Still open #thisweek'),
        'utf8',
      );
      const w = await vault.readWeek('2026-W35');
      expect(w.thisweek).toEqual([]);
      expect(w.tasks.map((t: any) => t.text)).toContain('Still open #thisweek');
    });

    it('skips .obsidian and other excluded directories', async () => {
      await mkdir(path.join(root, '.obsidian'), { recursive: true });
      await writeFile(
        path.join(root, '.obsidian', 'notes.md'),
        '- [ ] Plugin note #thisweek\n',
        'utf8',
      );
      expect((await vault.readWeek('2026-W35')).thisweek).toEqual([]);
    });

    it('picks up an edit made after the first pass (the mtime cache invalidates)', async () => {
      const note = path.join(root, 'Backlog.md');
      await writeFile(note, '- [ ] First #thisweek\n', 'utf8');
      expect((await vault.readWeek('2026-W35')).thisweek.map((t: any) => t.text)).toEqual([
        'First',
      ]);
      await writeFile(note, '- [ ] First #thisweek\n- [ ] Second #thisweek\n', 'utf8');
      expect((await vault.readWeek('2026-W35')).thisweek.map((t: any) => t.text)).toEqual([
        'First',
        'Second',
      ]);
      await rm(note);
      expect((await vault.readWeek('2026-W35')).thisweek).toEqual([]);
    });
  });

  describe('createWeek', () => {
    it('creates the note from the template with the placeholders filled in', async () => {
      const r = await vault.createWeek('2026-W40');
      expect(r).toEqual({ ok: true, created: true, notePath: 'Weekly/2026-W40.md' });
      const text = await read(weekly('2026-W40'));
      expect(text).toContain('week: 2026-W40');
      expect(text).toContain('range: 2026-09-28 to 2026-10-04');
      expect(text).toContain('# Week 2026-W40  ·  Mon 28 Sep – Sun 4 Oct');
      expect(text).toMatch(/^last_updated: \d{4}-\d{2}-\d{2}$/m);
      expect(text).not.toContain('YYYY');
      // And the app can read it straight back.
      const w = await vault.readWeek('2026-W40');
      expect(w.notePath).toBe('Weekly/2026-W40.md');
    });

    it('is a no-op when the note already exists', async () => {
      const before = await read(weekly('2026-W35'));
      expect(await vault.createWeek('2026-W35')).toEqual({
        ok: true,
        created: false,
        notePath: 'Weekly/2026-W35.md',
      });
      expect(await read(weekly('2026-W35'))).toBe(before);
    });

    it('creates a minimal ISO week note when the fresh folder has no template', async () => {
      await rm(path.join(weeklyAbs, '_Template.md'));
      const r = await vault.createWeek('2026-W40');
      expect(r.created).toBe(true);
      const text = await read(weekly('2026-W40'));
      expect(text).toContain('week: 2026-W40');
      expect(text).toContain('range: 2026-09-28 to 2026-10-04');
      expect(text.match(/^## .*$/gm)).toEqual(['## Intentions', '## Tasks', '## Review']);
      expect(text).not.toContain('YYYY');
    });

    it('refuses an existing template linked outside the vault instead of using the fallback', async () => {
      const outside = (junctionTarget = path.join(path.dirname(root), `${path.basename(root)}-outside-template`));
      await mkdir(outside);
      await rm(path.join(weeklyAbs, '_Template.md'));
      await symlink(outside, path.join(weeklyAbs, '_Template.md'), 'junction');
      await expect(vault.createWeek('2026-W40')).rejects.toThrow(/template/);
      expect(await readFile(weekly('2026-W40')).catch(() => null)).toBeNull();
    });

    it('refuses to create a week through a weekly-folder junction outside the vault', async () => {
      const outside = (junctionTarget = path.join(path.dirname(root), `${path.basename(root)}-outside-write`));
      await mkdir(outside);
      await rm(weeklyAbs, { recursive: true });
      await symlink(outside, weeklyAbs, 'junction');
      await expect(vault.createWeek('2026-W40')).rejects.toThrow(/outside the vault/);
      expect(await readFile(path.join(outside, '2026-W40.md')).catch(() => null)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Phase 4 §3 — the shared task id
  // -------------------------------------------------------------------------

  describe('line endings — each file keeps its own', () => {
    // A roll touches two notes. Joining the second with the *first* note's
    // ending rewrote every line of an LF note as CRLF (and the reverse stripped
    // every CR): whole-file churn, in a note the user may have open in Obsidian,
    // for an edit of two lines.
    const CRLF = '\r\n';

    it('createWeek follows the template rather than assuming LF', async () => {
      await writeFile(
        path.join(weeklyAbs, '_Template.md'),
        TEMPLATE.replace(/\n/g, CRLF),
        'utf8',
      );
      await vault.createWeek('2026-W40');
      expect(await read(weekly('2026-W40'))).toContain(CRLF);
    });
  });

  /** The 0-indexed line a task sits on in a week's note — the anchor the
   *  Phase 5 §5 tests need, without hardcoding a line number that shifts every
   *  time the fixture changes. */
  const lineOf = async (text: string) => {
    const lines = (await read(weekly('2026-W35'))).split(/\r?\n/);
    const i = lines.findIndex((l) => l.includes(text));
    if (i < 0) throw new Error(`no line containing "${text}"`);
    return i;
  };

  describe('the backlog — Phase 5 §6', () => {
    const BACKLOG = 'Backlog.md'; // the default since Phase 9.4
    const backlogAbs = () => path.join(root, BACKLOG);

    const seed = async (items: string[]) => {
      await mkdir(path.dirname(backlogAbs()), { recursive: true });
      await writeFile(
        backlogAbs(),
        ['# Backlog', '', '## Someday / unsorted', '', ...items, ''].join('\n'),
        'utf8',
      );
    };

    it('reads the open items, ignoring the placeholder checkbox', async () => {
      // The section has held exactly one blank `- [ ]` since it was created —
      // that is the absence of a backlog, not an item in it.
      await seed(['- [ ] ', '- [ ] Learn the harmonica', '- [x] Already done']);
      const r = await vault.readBacklog();
      expect(r.ok).toBe(true);
      expect(r.items.map((i: { text: string }) => i.text)).toEqual([
        'Learn the harmonica',
        'Already done',
      ]);
    });

    it('is empty, not an error, when there is no backlog file at all', async () => {
      const r = await vault.readBacklog();
      expect(r).toMatchObject({ ok: true });
      expect(r.items).toEqual([]);
    });

    it('captures a line, creating the file and section if needed', async () => {
      expect(await vault.appendBacklog('Try the new ramen place')).toMatchObject({
        ok: true,
      });
      const out = await read(backlogAbs());
      expect(out).toContain('## Someday / unsorted');
      expect(out).toContain('- [ ] Try the new ramen place');
    });

    it('refuses an empty capture', async () => {
      expect(await vault.appendBacklog('   ')).toMatchObject({ ok: false });
    });

    it('appends into an existing section without disturbing it', async () => {
      await seed(['- [ ] First thing']);
      await vault.appendBacklog('Second thing');
      const lines = (await read(backlogAbs())).split('\n');
      expect(lines.filter((l: string) => l.startsWith('- [ ]'))).toEqual([
        '- [ ] First thing',
        '- [ ] Second thing',
      ]);
    });

  });

  // -------------------------------------------------------------------------
  // Phase 4 §4 — the replan tally and the twice-replanned signal
  // -------------------------------------------------------------------------

  describe('normaliseTitle', () => {
    it('reduces a task line to the words a human would call it', () => {
      expect(normaliseTitle('- [ ] Edit video A ~4h #content 🆔 dg1st4')).toBe(
        'edit video a',
      );
      expect(normaliseTitle('Edit video A [est:: 90m]')).toBe('edit video a');
      expect(normaliseTitle('  Edit   video  A  ')).toBe('edit video a');
    });

    it('is the same on both sides of the tally, however the line grows', () => {
      // The point of the helper: a tag or an id added between the replan and
      // the roll must not break the link between the two.
      expect(normaliseTitle('- [ ] Edit video A')).toBe(
        normaliseTitle('- [ ] Edit video A #content 🆔 dg1st4 ~2h'),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Phase 4 §5 — the planned-vs-actual rows under ## Review
  // -------------------------------------------------------------------------

});

// ---------------------------------------------------------------------------
// Phase 4 §5's pure helpers — the note shape, without touching a disk.
// ---------------------------------------------------------------------------

describe('AUDIT_RE — the ## Review row shape', () => {
  const parse = (l: string) => l.match(AUDIT_RE);

  it('matches a row with and without a comparison tail', () => {
    expect(parse('- Audit: Stream — 12h planned / 9h kept')?.slice(1)).toEqual([
      'Stream',
      '12',
      '9',
    ]);
    expect(
      parse('- Audit: Meal Prep — 6.5h planned / 4h kept — down 3h on W35')?.slice(1),
    ).toEqual(['Meal Prep', '6.5', '4']);
  });

  it('rejects anything else', () => {
    expect(parse('- Audit: Stream — 12h planned')).toBeNull();
    expect(parse('- Rolled to next week: 2 task(s)')).toBeNull();
    expect(parse('- [ ] Audit: Stream — 12h planned / 9h kept')).toBeNull();
  });
});

describe('normaliseAuditLines', () => {
  it('collapses a line and keeps only rows in the documented shape', () => {
    expect(
      normaliseAuditLines([
        '  - Audit: Gym  —  5h planned / 3h kept  ',
        '- Audit: broken',
        '- [ ] a task',
        42,
        null,
      ]),
    ).toEqual(['- Audit: Gym — 5h planned / 3h kept']);
  });

  it('cannot smuggle a second line into the note', () => {
    expect(
      normaliseAuditLines(['- Audit: Gym — 5h planned / 3h kept\n## Review\n- [ ] oops']),
    ).toEqual([]);
  });

  it('caps the rows a review may write', () => {
    const many = Array.from(
      { length: 9 },
      (_, i) => `- Audit: K${i} — ${i}h planned / ${i}h kept`,
    );
    expect(normaliseAuditLines(many)).toHaveLength(AUDIT_MAX_ROWS);
  });

  it('is empty for anything that isn’t a list', () => {
    expect(normaliseAuditLines(undefined)).toEqual([]);
    expect(normaliseAuditLines('- Audit: Gym — 5h planned / 3h kept')).toEqual([]);
  });
});

describe('replaceAuditLines', () => {
  const rows = ['- Audit: Gym — 5h planned / 3h kept'];

  it('creates ## Review when the note has none', () => {
    const doc = ['# Week', '', '## Tasks', '- [ ] a'];
    expect(replaceAuditLines(doc, rows)).toBe(true);
    expect(doc.indexOf('## Review')).toBeGreaterThan(-1);
    expect(doc.indexOf(rows[0])).toBeGreaterThan(doc.indexOf('## Review'));
  });

  it('joins the existing list rather than landing after its blank lines', () => {
    const doc = ['## Review', '', '- Wins:', '', '## Notes', '- keep me'];
    replaceAuditLines(doc, rows);
    expect(doc).toEqual([
      '## Review',
      '',
      '- Wins:',
      rows[0],
      '',
      '## Notes',
      '- keep me',
    ]);
  });

  it('replaces an existing block in place, however many rows it had', () => {
    const doc = [
      '## Review',
      '- Wins:',
      '- Audit: Gym — 9h planned / 9h kept',
      '- Audit: Stream — 9h planned / 9h kept',
      '- Note to self:',
      '## Notes',
    ];
    replaceAuditLines(doc, ['- Audit: A — 1h planned / 1h kept', '- Audit: B — 2h planned / 0h kept']);
    expect(doc).toEqual([
      '## Review',
      '- Wins:',
      '- Audit: A — 1h planned / 1h kept',
      '- Audit: B — 2h planned / 0h kept',
      '- Note to self:',
      '## Notes',
    ]);
  });

  it('does nothing at all with no rows to write', () => {
    const doc = ['## Review', '- Wins:'];
    expect(replaceAuditLines(doc, [])).toBe(false);
    expect(doc).toEqual(['## Review', '- Wins:']);
  });

  it('only ever touches the Review section', () => {
    const doc = ['## Tasks', '- Audit: Stray — 1h planned / 1h kept', '## Review', '- Wins:'];
    replaceAuditLines(doc, rows);
    expect(doc[1]).toBe('- Audit: Stray — 1h planned / 1h kept');
    expect(auditRows(doc)).toEqual([{ label: 'Gym', plannedMin: 300, keptMin: 180 }]);
  });
});

// ---------------------------------------------------------------------------
// Phase 5 §2 — the weekly note's frontmatter (what Obsidian Bases reads)
// ---------------------------------------------------------------------------

describe('frontmatterBounds', () => {
  it('finds the block at the top of the file', () => {
    expect(frontmatterBounds(lines('---\nweek: 2026-W35\n---\n\n# Week'))).toEqual({
      start: 0,
      end: 2,
    });
  });

  it('is not fooled by a horizontal rule further down', () => {
    expect(frontmatterBounds(lines('# Week\n\n---\n\nsome prose'))).toBeNull();
  });

  it('refuses an unterminated fence rather than swallowing the note', () => {
    expect(frontmatterBounds(lines('---\nweek: 2026-W35\n\n# Week'))).toBeNull();
  });

  it('has none to find in a note without frontmatter', () => {
    expect(frontmatterBounds(lines('# Week\n\n## Tasks'))).toBeNull();
    expect(frontmatterBounds([])).toBeNull();
  });
});

describe('readFrontmatter', () => {
  it('reads the top-level keys, and only those', () => {
    const doc = lines(
      [
        '---',
        'tags: [a, b]',
        'week: 2026-W35',
        'streaks:',
        '  gym: 4/5',
        '  stream: 3/4',
        '---',
        'week: not-this-one',
      ].join('\n'),
    );
    const fm = readFrontmatter(doc);
    expect(fm.week).toBe('2026-W35');
    expect(fm.tags).toBe('[a, b]');
    expect(fm.streaks).toBe('');
    // The indented map entries are not keys of their own.
    expect(fm.gym).toBeUndefined();
  });
});

describe('setFrontmatter — idempotent, and blind to what it does not own', () => {
  const doc = () =>
    lines(
      [
        '---',
        'tags: [week-dashboard, weekly-note]',
        'week: 2026-W35',
        'mood: hopeful',
        'last_updated: 2026-08-25',
        '---',
        '',
        '# Week 2026-W35',
      ].join('\n'),
    );

  it('rewrites a key where it stands, without reordering anything', () => {
    const d = doc();
    expect(setFrontmatter(d, { week: '2026-W36' })).toBe(true);
    expect(d[2]).toBe('week: 2026-W36');
    expect(d[3]).toBe('mood: hopeful');
    expect(d[4]).toBe('last_updated: 2026-08-25');
  });

  it('appends unknown keys just above the closing fence', () => {
    const d = doc();
    setFrontmatter(d, { status: 'reviewed', hours_kept: 12 });
    expect(d.slice(0, 8)).toEqual([
      '---',
      'tags: [week-dashboard, weekly-note]',
      'week: 2026-W35',
      'mood: hopeful',
      'last_updated: 2026-08-25',
      'status: reviewed',
      'hours_kept: 12',
      '---',
    ]);
  });

  it('leaves hand-written keys it was not asked about alone', () => {
    const d = doc();
    setFrontmatter(d, { status: 'reviewed' });
    expect(d.join('\n')).toContain('mood: hopeful');
  });

  it('is idempotent — writing the same values twice changes nothing', () => {
    const d = doc();
    setFrontmatter(d, { status: 'reviewed', tasks_done: 2 });
    const once = d.join('\n');
    expect(setFrontmatter(d, { status: 'reviewed', tasks_done: 2 })).toBe(false);
    expect(d.join('\n')).toBe(once);
  });

  it('will not flatten a key that owns a nested block', () => {
    const d = lines('---\nstreaks:\n  gym: 4/5\n---\n');
    expect(setFrontmatter(d, { streaks: '{}' })).toBe(false);
    expect(d[2]).toBe('  gym: 4/5');
  });

  it('never invents a block on a note that has none', () => {
    const d = lines('# Week 2026-W35\n\n## Tasks');
    expect(setFrontmatter(d, { status: 'reviewed' })).toBe(false);
    expect(d.join('\n')).toBe('# Week 2026-W35\n\n## Tasks');
  });
});

describe('setFrontmatterMap — the streak map', () => {
  it('replaces the whole block rather than stacking a second one', () => {
    const d = lines('---\nweek: 2026-W35\nstreaks:\n  gym: 4/5\n  stream: 1/4\n---\n');
    setFrontmatterMap(d, 'streaks', { gym: '5/5' });
    expect(d.slice(0, 5)).toEqual(['---', 'week: 2026-W35', 'streaks:', '  gym: 5/5', '---']);
  });

  it('collapses an empty map back to `{}` so the property still exists', () => {
    const d = lines('---\nstreaks:\n  gym: 4/5\n---\n');
    setFrontmatterMap(d, 'streaks', {});
    expect(d.slice(0, 3)).toEqual(['---', 'streaks: {}', '---']);
  });

  it('grows a block out of the seeded `streaks: {}`', () => {
    const d = lines('---\nweek: 2026-W35\nstreaks: {}\n---\n');
    setFrontmatterMap(d, 'streaks', { stream: '3/4', gym: '4/5' });
    // Sorted, so a week-on-week diff is about the numbers and not the order.
    expect(d.slice(0, 6)).toEqual([
      '---',
      'week: 2026-W35',
      'streaks:',
      '  gym: 4/5',
      '  stream: 3/4',
      '---',
    ]);
  });

  it('is idempotent', () => {
    const d = lines('---\nstreaks:\n  gym: 4/5\n---\n');
    expect(setFrontmatterMap(d, 'streaks', { gym: '4/5' })).toBe(false);
  });
});

describe('normaliseStreaks — what a renderer is allowed to put in the vault', () => {
  it('slugs the name and clamps the counts', () => {
    expect(normaliseStreaks([{ name: 'Meal Prep', kept: 2, slots: 2 }])).toEqual({
      meal_prep: '2/2',
    });
    expect(normaliseStreaks([{ name: 'gym', kept: 9, slots: 5 }])).toEqual({ gym: '5/5' });
    expect(normaliseStreaks([{ name: 'gym', kept: -3, slots: 5 }])).toEqual({ gym: '0/5' });
  });

  it('drops habits with nothing planned, and names that are not names', () => {
    expect(normaliseStreaks([{ name: 'gym', kept: 0, slots: 0 }])).toEqual({});
    expect(normaliseStreaks([{ name: '  ', kept: 1, slots: 1 }])).toEqual({});
    expect(normaliseStreaks([{ name: '2026', kept: 1, slots: 1 }])).toEqual({});
  });

  it('caps the map, and says "nothing to write" rather than "write nothing"', () => {
    const many = Array.from({ length: STREAK_MAX_KEYS + 4 }, (_, i) => ({
      name: `k${i}`,
      kept: 1,
      slots: 1,
    }));
    expect(Object.keys(normaliseStreaks(many))).toHaveLength(STREAK_MAX_KEYS);
    expect(normaliseStreaks(null)).toBeNull();
    expect(normaliseStreaks('gym')).toBeNull();
  });
});

describe('hoursOf', () => {
  it('is one decimal place, so Bases can sum and sort it', () => {
    expect(hoursOf(720)).toBe(12);
    expect(hoursOf(90)).toBe(1.5);
    expect(hoursOf(50)).toBe(0.8);
    expect(hoursOf(0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 5 §3 — the sweep's scope
// ---------------------------------------------------------------------------

describe('isExcludedRel — the planning notes the sweep skips by default', () => {
  it('skips handoff logs anywhere', () => {
    expect(isExcludedRel('Claude Conversations/Twitch/quetx Handoff Log.md')).toBe(true);
    expect(
      isExcludedRel('Claude Conversations/Week Dashboard/Week Dashboard Handoff Log.md'),
    ).toBe(true);
    expect(isExcludedRel('Week Dashboard Handoff Log.md')).toBe(true);
  });

  it('skips anything inside an Action Plan folder', () => {
    expect(isExcludedRel('Claude Conversations/Week Dashboard/Action Plan/Phase 5.md')).toBe(true);
    expect(isExcludedRel('Claude Conversations/Week Dashboard/action plan/Phase 5.md')).toBe(true);
    expect(isExcludedRel('Action Plan/deep/er/note.md')).toBe(true);
  });

  it('leaves ordinary notes — and the weekly notes — alone', () => {
    expect(isExcludedRel('Claude Conversations/Week Dashboard/Backlog.md')).toBe(false);
    expect(isExcludedRel('Claude Conversations/Week Dashboard/Weekly/2026-W35.md')).toBe(false);
    expect(isExcludedRel('Action Plan.md')).toBe(false); // a note, not a folder
  });
});

describe('parseTaskFolders', () => {
  it('splits, trims and normalises the separators', () => {
    expect(parseTaskFolders('Weekly, Projects/Active ')).toEqual(['Weekly', 'Projects/Active']);
    expect(parseTaskFolders(['.\\Weekly\\', 'Weekly'])).toEqual(['Weekly']);
  });

  it('is empty for empty — which is the whole vault', () => {
    expect(parseTaskFolders('')).toEqual([]);
    expect(parseTaskFolders(undefined)).toEqual([]);
    expect(parseTaskFolders(', , .')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 5 §2 / §3 against a throwaway vault — the seeded fields, the review
// flow filling them in, and the sweep's scope.
// ---------------------------------------------------------------------------

describe('Phase 5 §2 — the weekly note as a Bases row', () => {
  let root: string;
  let weeklyAbs: string;
  let vault: any;

  const weekly = (id: string) => path.join(weeklyAbs, `${id}.md`);
  const read = (p: string) => readFile(p, 'utf8');
  const fm = (text: string) => readFrontmatter(text.split('\n'));

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wd-vault-fm-'));
    weeklyAbs = path.join(root, 'Weekly');
    await mkdir(weeklyAbs, { recursive: true });
    await writeFile(path.join(weeklyAbs, '_Template.md'), TEMPLATE, 'utf8');
    vault = makeVault({ vaultPath: root, weeklyDir: 'Weekly', canWrite: true });
    expect(path.resolve(vault.root).toLowerCase()).not.toContain('quetx');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('createWeek seeds every field the Weekly.base table reads', async () => {
    await vault.createWeek('2026-W40');
    const f = fm(await read(weekly('2026-W40')));
    expect(f.week).toBe('2026-W40');
    expect(f.range).toBe('2026-09-28 to 2026-10-04');
    expect(f.intentions_total).toBe('0');
    expect(f.intentions_done).toBe('0');
    expect(f.tasks_total).toBe('0');
    expect(f.tasks_done).toBe('0');
    expect(f.hours_planned).toBe('0');
    expect(f.hours_kept).toBe('0');
    expect(f.streaks).toBe('{}');
    expect(f.tags).toBe('[week-dashboard, weekly-note]');
  });

  it('a note made for the week we are in is `active`, one made ahead is `planning`', async () => {
    const now = currentWeekId();
    const ahead = nextWeekId(nextWeekId(now));
    await vault.createWeek(now);
    await vault.createWeek(ahead);
    expect(fm(await read(weekly(now))).status).toBe('active');
    expect(fm(await read(weekly(ahead))).status).toBe('planning');
  });

  it('createWeek leaves nothing of the template behind — the trim held', async () => {
    await vault.createWeek('2026-W40');
    const text = await read(weekly('2026-W40'));
    expect(text).not.toContain('YYYY');
    // Phase 3 §4 — the instructional prose that used to be copied verbatim.
    expect(text).not.toContain('Copy this file to');
    expect(text).not.toContain('Keep it to 3–5');
    expect(text).not.toContain('committed task pool');
    expect(text.match(/^##.*$/gm)).toEqual(['## Intentions', '## Tasks', '## Review']);
  });

});

describe('Phase 5 §3 — scoping the #thisweek sweep', () => {
  let root: string;
  let vault: any;

  const TAGGED = '- [ ] Do the thing #thisweek\n';

  const build = async (taskFolders?: string) => {
    vault = makeVault({ vaultPath: root, weeklyDir: 'Weekly', taskFolders });
    expect(path.resolve(vault.root).toLowerCase()).not.toContain('quetx');
    return (await vault.readWeek('2026-W35')).thisweek.map((t: any) => t.file);
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wd-vault-scope-'));
    // A miniature of the real vault, including the two shapes §3 calls out.
    for (const [rel, body] of [
      ['Weekly/_Template.md', TEMPLATE],
      ['Weekly/2026-W35.md', TAGGED],
      ['Projects/Active.md', TAGGED],
      ['Archive/Old.md', TAGGED],
      ['Claude Conversations/Week Dashboard/Backlog.md', TAGGED],
      ['Claude Conversations/Week Dashboard/Week Dashboard Handoff Log.md', TAGGED],
      ['Claude Conversations/Week Dashboard/Action Plan/Phase 5.md', TAGGED],
    ] as [string, string][]) {
      await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await writeFile(path.join(root, rel), body, 'utf8');
    }
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('sweeps a vault opened through another name for the same folder (Bug Log #94)', async () => {
    // A junction to the vault stands in for any non-canonical spelling of the
    // root: an 8.3 short path (the GitHub Actions runner's temp folder is one),
    // a redirected Documents folder, a subst drive. The sweep walks real paths,
    // so it must not measure them against the unresolved root.
    const alias = `${root}-alias`;
    await symlink(root, alias, 'junction');
    try {
      vault = makeVault({ vaultPath: alias, weeklyDir: 'Weekly', taskFolders: 'Projects' });
      const files = (await vault.readWeek('2026-W35')).thisweek.map((t: any) => t.file);
      expect(files).toEqual(['Projects/Active.md']);
    } finally {
      await rm(alias, { recursive: true, force: true });
    }
  });

  it('walks the whole vault when nothing is configured — the old behaviour', async () => {
    expect(await build('')).toEqual([
      'Claude Conversations/Week Dashboard/Backlog.md',
      'Projects/Active.md',
      'Archive/Old.md',
    ].sort());
  });

  it('excludes handoff logs and the Action Plan folder by default', async () => {
    const files = await build('');
    expect(files).not.toContain('Claude Conversations/Week Dashboard/Week Dashboard Handoff Log.md');
    expect(files).not.toContain('Claude Conversations/Week Dashboard/Action Plan/Phase 5.md');
    // This is the live bug §3 names: without the exclusion they are both in.
    expect(files).toContain('Claude Conversations/Week Dashboard/Backlog.md');
  });

  it('walks only the configured folders when there are some', async () => {
    expect(await build('Projects')).toEqual(['Projects/Active.md']);
    expect(await build('Projects, Archive')).toEqual(['Archive/Old.md', 'Projects/Active.md']);
  });

  it('still skips an excluded note inside a configured folder', async () => {
    expect(await build('Claude Conversations')).toEqual([
      'Claude Conversations/Week Dashboard/Backlog.md',
    ]);
  });

  it('opts an excluded folder back in when it is named explicitly', async () => {
    expect(await build('Claude Conversations/Week Dashboard/Action Plan')).toEqual([
      'Claude Conversations/Week Dashboard/Action Plan/Phase 5.md',
    ]);
  });

  it('ignores a folder that does not exist, or that points outside the vault', async () => {
    expect(await build('Nope, ../elsewhere')).toEqual([]);
  });

  it('setTaskFolders repoints the sweep without a restart, and prunes what fell out', async () => {
    await build('');
    expect(vault.setTaskFolders('Projects')).toBe(true);
    expect(vault.taskFolders).toEqual(['Projects']);
    expect((await vault.readWeek('2026-W35')).thisweek.map((t: any) => t.file)).toEqual([
      'Projects/Active.md',
    ]);
    // Same scope in, no change out — the caller can skip the broadcast.
    expect(vault.setTaskFolders(['Projects'])).toBe(false);
    expect(vault.setTaskFolders('')).toBe(true);
    expect((await vault.readWeek('2026-W35')).thisweek.length).toBe(3);
  });
});
