import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DURATIONS,
  EST_FIELD,
  FALLBACK_MINUTES,
  MAX_ESTIMATE_MINUTES,
  MIN_ESTIMATE_MINUTES,
  committedMinutes,
  fmtEstimate,
  fmtHours,
  parseDurationValue,
  parseTaskLine,
  resolveTaskDuration,
  snapToGrid,
  taskKind,
} from '../src/lib/duration';
import { parseDurations, parseSkeletonDoc, stringifySkeleton } from '../src/lib/skeleton';
import type { DurationMap, VaultTask } from '../src/lib/types';
import { createRequire } from 'node:module';

// electron/skeleton.cjs runs in the main process; outside Electron `require
// ('electron')` resolves to the path string, so destructuring it is harmless
// and the pure helpers can be required straight into a test (same trick as
// test/vault.test.ts).
const require_ = createRequire(import.meta.url);
const {
  durationsSection,
  withSeededDurations,
  // Phase 5 §3 — the sweep's scope, as the main process reads it.
  taskFolders: skeletonTaskFolders,
  withTaskFolders,
} = require_(
  '../electron/skeleton.cjs',
) as any;

const MAP: DurationMap = {
  defaultMinutes: 60,
  byKind: { content: 90, admin: 30, errand: 45, 'meal-prep': 120 },
};

const task = (text: string, done = false): VaultTask => ({
  text,
  done,
  file: 'Weekly/2026-W36.md',
  line: 0,
});

// ---------------------------------------------------------------------------
// The value grammar (shared by the yaml map, `~90m` and `[est:: 90m]`)
// ---------------------------------------------------------------------------

describe('parseDurationValue', () => {
  it('reads minutes, in every spelling', () => {
    expect(parseDurationValue('90m')).toBe(90);
    expect(parseDurationValue('90min')).toBe(90);
    expect(parseDurationValue('90mins')).toBe(90);
    expect(parseDurationValue('90 minutes')).toBe(90);
  });

  it('reads hours, including fractional ones', () => {
    expect(parseDurationValue('2h')).toBe(120);
    expect(parseDurationValue('1.5h')).toBe(90);
    expect(parseDurationValue('1.5 hours')).toBe(90);
    expect(parseDurationValue('0.25hr')).toBe(15);
  });

  it('treats a bare number as minutes — yaml writes `90`, not `"90m"`', () => {
    expect(parseDurationValue('45')).toBe(45);
    expect(parseDurationValue(45)).toBe(45);
  });

  it('is case-insensitive and tolerates surrounding space', () => {
    expect(parseDurationValue('  90M ')).toBe(90);
    expect(parseDurationValue('2H')).toBe(120);
  });

  it('rejects a zero or negative estimate rather than making a 0-height block', () => {
    expect(parseDurationValue('0m')).toBeNull();
    expect(parseDurationValue('0')).toBeNull();
    expect(parseDurationValue('-30m')).toBeNull();
  });

  it('rejects an absurd one rather than making a year-long block', () => {
    expect(parseDurationValue('9999h')).toBeNull();
    expect(parseDurationValue('5000m')).toBeNull();
    expect(parseDurationValue(MAX_ESTIMATE_MINUTES + 1)).toBeNull();
    expect(parseDurationValue(MAX_ESTIMATE_MINUTES)).toBe(MAX_ESTIMATE_MINUTES);
  });

  it('rejects anything below the sanity floor', () => {
    expect(parseDurationValue(MIN_ESTIMATE_MINUTES - 1)).toBeNull();
    expect(parseDurationValue(MIN_ESTIMATE_MINUTES)).toBe(MIN_ESTIMATE_MINUTES);
  });

  it('rejects things that are not durations at all', () => {
    expect(parseDurationValue('banana')).toBeNull();
    expect(parseDurationValue('90 bananas')).toBeNull();
    expect(parseDurationValue('')).toBeNull();
    expect(parseDurationValue(null)).toBeNull();
    expect(parseDurationValue(undefined)).toBeNull();
    expect(parseDurationValue('1:30')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rung B — `~90m`, and the strikethrough it must not collide with
// ---------------------------------------------------------------------------

describe('rung B — the `~90m` override', () => {
  it('reads the estimate and strips it from the display title', () => {
    const p = parseTaskLine('Cut the Tuesday VOD ~90m');
    expect(p.fields[EST_FIELD]).toEqual({ minutes: 90, raw: '~90m', flavour: 'tilde' });
    expect(p.title).toBe('Cut the Tuesday VOD');
  });

  it('reads hours and half-hours', () => {
    expect(parseTaskLine('Edit video A ~1.5h').fields[EST_FIELD]?.minutes).toBe(90);
    expect(parseTaskLine('Edit video A ~2h').fields[EST_FIELD]?.minutes).toBe(120);
    expect(parseTaskLine('Quick one ~30min').fields[EST_FIELD]?.minutes).toBe(30);
  });

  it('is typeable anywhere on the line, not only at the end', () => {
    const p = parseTaskLine('~45m Book dentist');
    expect(p.fields[EST_FIELD]?.minutes).toBe(45);
    expect(p.title).toBe('Book dentist');
  });

  it('leaves a doubled tilde alone — `~~` is strikethrough', () => {
    for (const line of ['~~90m~~', '~~Done anyway 90m~~', 'a ~~90m~~ b']) {
      expect(parseTaskLine(line).fields[EST_FIELD]).toBeUndefined();
      expect(parseTaskLine(line).title).toBe(line);
    }
  });

  it('will not eat half of a strikethrough that trails an estimate-shaped run', () => {
    // `~90m~~` is ambiguous markdown; leave the whole thing visible rather than
    // silently removing the opening half and stranding a `~~`.
    expect(parseTaskLine('Old idea ~90m~~').fields[EST_FIELD]).toBeUndefined();
  });

  it('needs whitespace (or the line start) before the tilde', () => {
    // `approx~90m` is a word, not an estimate.
    expect(parseTaskLine('roughly~90m').fields[EST_FIELD]).toBeUndefined();
  });

  it('needs a unit — a lone `~5` is "about five of something"', () => {
    expect(parseTaskLine('Do the thing ~5').fields[EST_FIELD]).toBeUndefined();
    expect(parseTaskLine('Do the thing ~5 times').fields[EST_FIELD]).toBeUndefined();
  });

  it('leaves a malformed estimate in the title, so the typo stays visible', () => {
    expect(parseTaskLine('Book dentist ~0m').title).toBe('Book dentist ~0m');
    expect(parseTaskLine('Edit video ~9999h').title).toBe('Edit video ~9999h');
    expect(parseTaskLine('Edit video ~9999h').fields[EST_FIELD]).toBeUndefined();
  });

  it('tidies the seam it leaves behind', () => {
    expect(parseTaskLine('Book ~30m dentist').title).toBe('Book dentist');
    expect(parseTaskLine('  Book dentist ~30m  ').title).toBe('Book dentist');
  });
});

// ---------------------------------------------------------------------------
// Rung C — `[est:: 90m]`
// ---------------------------------------------------------------------------

describe('rung C — the `[est:: 90m]` inline field', () => {
  it('reads the Dataview flavour and strips it', () => {
    const p = parseTaskLine('Book dentist [est:: 90m]');
    expect(p.fields[EST_FIELD]).toEqual({
      minutes: 90,
      raw: '[est:: 90m]',
      flavour: 'inline',
    });
    expect(p.title).toBe('Book dentist');
  });

  it('accepts the parenthesised flavour and odd spacing', () => {
    expect(parseTaskLine('Book dentist (est:: 1.5h)').fields[EST_FIELD]?.minutes).toBe(90);
    expect(parseTaskLine('Book dentist [est::30m]').fields[EST_FIELD]?.minutes).toBe(30);
    expect(parseTaskLine('Book dentist [EST ::  2h ]').fields[EST_FIELD]?.minutes).toBe(120);
  });

  it('parses regardless of the flavour the rest of the line uses', () => {
    const p = parseTaskLine('Book dentist [due:: 2026-09-02] [est:: 45m] #admin');
    expect(p.fields[EST_FIELD]?.minutes).toBe(45);
    // Phase 5 §1: `[due:: …]` is a field this app understands now, so it comes
    // out of the display title too. Before, only the estimate did, and the rail
    // showed the raw Dataview alongside the name of the work.
    expect(p.title).toBe('Book dentist #admin');
  });

  it('leaves a malformed value alone', () => {
    const p = parseTaskLine('Book dentist [est:: soon]');
    expect(p.fields[EST_FIELD]).toBeUndefined();
    expect(p.title).toBe('Book dentist [est:: soon]');
  });

  it('files the result under a namespaced key — this is not the Tasks standard', () => {
    expect(EST_FIELD).toBe('wd:est');
    expect(Object.keys(parseTaskLine('x ~30m').fields)).toEqual(['wd:est']);
    expect(Object.keys(parseTaskLine('x').fields)).toEqual([]);
  });
});

describe('B and C together', () => {
  it('lets the named inline field win — it is the more deliberate of the two', () => {
    const p = parseTaskLine('Edit video ~30m [est:: 2h]');
    expect(p.fields[EST_FIELD]).toEqual({
      minutes: 120,
      raw: '[est:: 2h]',
      flavour: 'inline',
    });
  });

  it('strips both regardless of which one won', () => {
    expect(parseTaskLine('Edit video ~30m [est:: 2h]').title).toBe('Edit video');
    expect(parseTaskLine('Edit video [est:: 2h] ~30m').title).toBe('Edit video');
  });

  it('falls back to the tilde when the inline field is junk', () => {
    const p = parseTaskLine('Edit video ~30m [est:: soon]');
    expect(p.fields[EST_FIELD]?.minutes).toBe(30);
    expect(p.title).toBe('Edit video [est:: soon]');
  });
});

// ---------------------------------------------------------------------------
// Rung A — default by kind
// ---------------------------------------------------------------------------

describe('taskKind', () => {
  const byKind = MAP.byKind;

  it('matches a tag that names a durations key', () => {
    expect(taskKind('Cut the VOD #content', byKind)).toBe('content');
    expect(taskKind('#admin Book dentist', byKind)).toBe('admin');
  });

  it('is case-insensitive and handles hyphenated kinds', () => {
    expect(taskKind('Sunday cook #Meal-Prep', byKind)).toBe('meal-prep');
  });

  it('falls back to the last segment of a nested tag', () => {
    expect(taskKind('Invoice #work/admin', byKind)).toBe('admin');
  });

  it('ignores tags that name nothing in the map', () => {
    expect(taskKind('Book dentist #thisweek', byKind)).toBeNull();
    expect(taskKind('Book dentist', byKind)).toBeNull();
  });

  it('takes the first matching tag when a line carries several', () => {
    expect(taskKind('Thing #admin #content', byKind)).toBe('admin');
    expect(taskKind('Thing #thisweek #content #admin', byKind)).toBe('content');
  });

  it('needs a real tag, not a mid-word hash', () => {
    expect(taskKind('Fix issue no#content', byKind)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The ladder — precedence
// ---------------------------------------------------------------------------

describe('resolveTaskDuration — override > kind > fallback', () => {
  it('gives every task a size, including a plain untagged line', () => {
    expect(resolveTaskDuration('Book dentist', MAP)).toEqual({
      title: 'Book dentist',
      minutes: 60,
      source: 'default',
    });
  });

  it('uses the kind default when a tag names one', () => {
    expect(resolveTaskDuration('Cut the VOD #content', MAP)).toEqual({
      title: 'Cut the VOD #content',
      minutes: 90,
      source: 'kind',
      kind: 'content',
    });
  });

  it('leaves the kind tag in the title — only the estimate is stripped', () => {
    expect(resolveTaskDuration('Cut the VOD #content ~2h', MAP).title).toBe(
      'Cut the VOD #content',
    );
  });

  it('lets a `~90m` override beat the kind default', () => {
    expect(resolveTaskDuration('Cut the VOD #content ~30m', MAP)).toEqual({
      title: 'Cut the VOD #content',
      minutes: 30,
      source: 'override',
      flavour: 'tilde',
    });
  });

  it('lets an `[est:: …]` override beat the kind default', () => {
    expect(resolveTaskDuration('Cut the VOD #content [est:: 3h]', MAP)).toMatchObject({
      minutes: 180,
      source: 'override',
      flavour: 'inline',
    });
  });

  it('falls past a malformed override to the kind default', () => {
    expect(resolveTaskDuration('Cut the VOD #content ~0m', MAP)).toMatchObject({
      minutes: 90,
      source: 'kind',
    });
  });

  it('falls all the way to the fallback when nothing matches', () => {
    expect(resolveTaskDuration('Book dentist ~9999h #nope', MAP)).toMatchObject({
      minutes: 60,
      source: 'default',
    });
  });

  it('honours a fallback other than 60m', () => {
    const map: DurationMap = { defaultMinutes: 25, byKind: {} };
    expect(resolveTaskDuration('Book dentist', map).minutes).toBe(25);
  });

  it('defaults to 60m with no map at all — exactly the pre-Phase-4 behaviour', () => {
    expect(resolveTaskDuration('Book dentist').minutes).toBe(FALLBACK_MINUTES);
    expect(DEFAULT_DURATIONS.defaultMinutes).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// Consumers: the grid snap and the rail footer
// ---------------------------------------------------------------------------

describe('snapToGrid', () => {
  it('snaps a dropped block to the grid quantum', () => {
    expect(snapToGrid(90)).toBe(90);
    expect(snapToGrid(45)).toBe(60);
    expect(snapToGrid(44)).toBe(30);
    expect(snapToGrid(120)).toBe(120);
  });

  it('never produces a zero-height block', () => {
    expect(snapToGrid(5)).toBe(30);
    expect(snapToGrid(0)).toBe(30);
    expect(snapToGrid(Number.NaN)).toBe(30);
  });
});

describe('committedMinutes', () => {
  it('adds up the open tasks and ignores the done ones', () => {
    const tasks = [
      task('Cut the VOD #content'), // 90 (kind)
      task('Book dentist'), // 60 (fallback)
      task('Invoice #admin ~15m'), // 15 → booked as 30
      task('Already finished #content', true), // ignored
    ];
    expect(committedMinutes(tasks, MAP)).toBe(180);
  });

  it('counts each task as it would actually be booked', () => {
    // The footer's whole job is making over-commitment visible, and it is read
    // against the free hours the gap engine reports. Every path that books a
    // task — the grid drop handler and the gap engine both — snaps to the
    // 30-minute lattice, so a footer that summed the raw estimates would
    // under-report by a quarter-hour per odd task and quietly disagree with the
    // week it is describing.
    expect(committedMinutes([task('Quick note ~15m')], MAP)).toBe(30);
    expect(committedMinutes([task('Errand ~45m')], MAP)).toBe(60);
    // A task already on the lattice is unchanged.
    expect(committedMinutes([task('Cut the VOD #content')], MAP)).toBe(90);
  });

  it('is zero for an empty rail', () => {
    expect(committedMinutes([], MAP)).toBe(0);
  });
});

describe('labels', () => {
  it('formats a chip', () => {
    expect(fmtEstimate(30)).toBe('30m');
    expect(fmtEstimate(60)).toBe('1h');
    expect(fmtEstimate(90)).toBe('1h 30m');
    expect(fmtEstimate(180)).toBe('3h');
  });

  it('formats the footer total to one decimal', () => {
    expect(fmtHours(390)).toBe('6.5h');
    expect(fmtHours(840)).toBe('14h');
    expect(fmtHours(0)).toBe('0h');
    expect(fmtHours(50)).toBe('0.8h');
  });
});

// ---------------------------------------------------------------------------
// The yaml side of rung A
// ---------------------------------------------------------------------------

describe('parseDurations', () => {
  it('reads the map and pulls `default` out as the global fallback', () => {
    expect(parseDurations({ default: '45m', content: '90m', admin: 30 })).toEqual({
      defaultMinutes: 45,
      byKind: { content: 90, admin: 30 },
    });
  });

  it('lowercases the keys so a tag match is case-insensitive', () => {
    expect(parseDurations({ Content: '90m' }).byKind).toEqual({ content: 90 });
  });

  it('drops an unparseable entry rather than resizing that kind by accident', () => {
    const d = parseDurations({ content: 'soon', admin: '30m', errand: '9999h' });
    expect(d.byKind).toEqual({ admin: 30 });
    expect(d.defaultMinutes).toBe(FALLBACK_MINUTES);
  });

  it('falls back to 60m when there is no map at all', () => {
    expect(parseDurations(undefined)).toEqual({ defaultMinutes: 60, byKind: {} });
    expect(parseDurations(null)).toEqual({ defaultMinutes: 60, byKind: {} });
    expect(parseDurations(['nope'])).toEqual({ defaultMinutes: 60, byKind: {} });
  });
});

describe('parseSkeletonDoc / stringifySkeleton', () => {
  const yaml = [
    'blocks:',
    '  - name: Gym',
    '    kind: gym',
    '    days: [mon, wed]',
    '    start: "06:00"',
    '    end: "07:00"',
    'durations:',
    '  default: 60m',
    '  content: 90m',
    '  admin: 30m',
  ].join('\n');

  it('reads blocks and durations out of the same file', () => {
    const doc = parseSkeletonDoc(yaml);
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0]).toMatchObject({ name: 'Gym', days: [0, 2], startMin: 360 });
    expect(doc.durations).toEqual({
      defaultMinutes: 60,
      byKind: { content: 90, admin: 30 },
    });
  });

  it('still reads a file written before durations existed', () => {
    const doc = parseSkeletonDoc(yaml.split('durations:')[0]);
    expect(doc.durations).toEqual({ defaultMinutes: 60, byKind: {} });
  });

  it('round-trips — saving from the editor must not drop the map', () => {
    const doc = parseSkeletonDoc(yaml);
    const out = parseSkeletonDoc(stringifySkeleton(doc));
    expect(out.durations).toEqual(doc.durations);
    expect(out.blocks).toEqual(doc.blocks);
  });

  it('reads the shipped seed file, so the defaults a new profile gets are the tested ones', async () => {
    const { readFile } = await import('node:fs/promises');
    const seed = await readFile('public/config/week-skeleton.yaml', 'utf8');
    const doc = parseSkeletonDoc(seed);
    expect(doc.durations.defaultMinutes).toBe(60);
    expect(doc.durations.byKind).toMatchObject({ content: 90, admin: 30, errand: 45 });
    // A new profile starts with no recurring blocks and no time map: the seed
    // is shipped to strangers, so it must not carry anyone's week.
    expect(doc.blocks).toEqual([]);
    expect(doc.windows).toEqual([]);
    expect(doc.timezone).toBeUndefined();
  });

  it('reads the full example fixture', async () => {
    const { readFile } = await import('node:fs/promises');
    const doc = parseSkeletonDoc(await readFile('test/fixtures/week-skeleton.full.yaml', 'utf8'));
    expect(doc.durations.byKind).toMatchObject({ content: 90, admin: 30, errand: 45 });
    expect(doc.blocks.length).toBeGreaterThan(0);
  });

  it('writes durations back in plain minutes, which is what it can read', () => {
    const text = stringifySkeleton({
      blocks: [],
      durations: { defaultMinutes: 60, byKind: { 'meal-prep': 120 } },
      windows: [],
    });
    expect(text).toContain('default: 60m');
    expect(text).toContain('meal-prep: 120m');
  });
});

// ---------------------------------------------------------------------------
// The installed-copy top-up (electron/skeleton.cjs)
// ---------------------------------------------------------------------------

describe('withSeededDurations — topping up a file written before Phase 4', () => {
  const seed = [
    'blocks:',
    '  - name: Gym',
    '',
    '# How long a task takes, by the #tag written on its line.',
    'durations:',
    '  default: 60m',
    '  content: 90m',
  ].join('\n');

  it('finds the section, comment header and all', () => {
    expect(durationsSection(seed)).toBe(
      [
        '# How long a task takes, by the #tag written on its line.',
        'durations:',
        '  default: 60m',
        '  content: 90m',
      ].join('\n'),
    );
    expect(durationsSection('blocks:\n  - name: Gym')).toBeNull();
  });

  it('appends the map to a file that has none', () => {
    const out = withSeededDurations('blocks:\n  - name: Gym\n', seed);
    expect(out).not.toBeNull();
    expect(parseSkeletonDoc(out).durations.byKind).toEqual({ content: 90 });
    // The user's own blocks survive untouched.
    expect(parseSkeletonDoc(out).blocks[0].name).toBe('Gym');
  });

  it('leaves a file that already has the map alone', () => {
    expect(withSeededDurations(seed, seed)).toBeNull();
  });

  it('does nothing when the bundled default has no map either', () => {
    expect(withSeededDurations('blocks:\n', 'blocks:\n')).toBeNull();
    expect(withSeededDurations('blocks:\n', '')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase 5 §3 — `task_folders:` read out of the skeleton file without a YAML
// parser. The main process can't have one: `dependencies` is empty so that
// node_modules isn't packaged.
// ---------------------------------------------------------------------------

describe('skeletonTaskFolders', () => {
  const withList = (body: string) => `blocks:\n  - name: Gym\n\n${body}\n`;

  it('reads a block list, quoted or bare', () => {
    expect(
      skeletonTaskFolders(
        withList('task_folders:\n  - "Claude Conversations/Week Dashboard"\n  - Projects'),
      ),
    ).toEqual(['Claude Conversations/Week Dashboard', 'Projects']);
  });

  it('reads the inline form too', () => {
    expect(skeletonTaskFolders(withList('task_folders: [Weekly, Projects]'))).toEqual([
      'Weekly',
      'Projects',
    ]);
  });

  it('tells an empty list from an absent key — they mean different things', () => {
    // Empty: "the whole vault", the editor's way of taking the setting over.
    expect(skeletonTaskFolders(withList('task_folders: []'))).toEqual([]);
    expect(skeletonTaskFolders(withList('task_folders:'))).toEqual([]);
    // Absent: no opinion, so WD_TASK_FOLDERS still applies.
    expect(skeletonTaskFolders('blocks:\n  - name: Gym\n')).toBeNull();
  });

  it('skips the comment block that introduces it', () => {
    expect(
      skeletonTaskFolders(withList('# which folders the sweep walks\ntask_folders:\n  - Weekly')),
    ).toEqual(['Weekly']);
  });

  it('stops at the next top-level key', () => {
    expect(
      skeletonTaskFolders('task_folders:\n  - Weekly\n\nwindows:\n  - name: deep\n'),
    ).toEqual(['Weekly']);
  });

  it('withTaskFolders appends the section without touching what is there', () => {
    const cur = 'blocks:\n  - name: Gym\n';
    const next = withTaskFolders(cur, ['Weekly']);
    expect(next.startsWith(cur)).toBe(true);
    expect(skeletonTaskFolders(next)).toEqual(['Weekly']);
    expect(skeletonTaskFolders(withTaskFolders(cur, []))).toEqual([]);
  });
});

describe('task_folders round-tripping through the skeleton doc (Phase 5 §3)', () => {
  it('reads the list, and normalises the separators on the way in', () => {
    expect(parseSkeletonDoc('task_folders:\n  - .\\Weekly\\\n  - Projects/Active/\n').taskFolders)
      .toEqual(['Weekly', 'Projects/Active']);
  });

  it('is undefined when the key is absent — WD_TASK_FOLDERS still applies', () => {
    expect(parseSkeletonDoc('blocks: []\n').taskFolders).toBeUndefined();
    expect(parseSkeletonDoc('task_folders: []\n').taskFolders).toEqual([]);
  });

  it('a save writes the key even when the list is empty — that is how the editor says "the whole vault"', () => {
    const doc = parseSkeletonDoc('task_folders:\n  - Weekly\n');
    expect(stringifySkeleton({ ...doc, taskFolders: [] })).toContain('task_folders: []');
    expect(stringifySkeleton({ ...doc, taskFolders: ['Weekly'] })).toContain('task_folders:');
    // Absent stays absent, so an untouched doc never overrides the environment.
    expect(stringifySkeleton({ ...doc, taskFolders: undefined })).not.toContain('task_folders');
  });
});
