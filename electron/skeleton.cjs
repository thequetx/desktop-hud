'use strict';

// The recurring "week skeleton" lives at <userData>/week-skeleton.yaml so it
// survives packaging and stays editable. On first run it's seeded from the
// bundled default (dist/config or public/config).

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { app, shell } = require('electron');

let userFile = null;

/** A top-level `key:` line, e.g. `durations:` or `windows:` (not `  - name:`). */
const TOP_LEVEL = /^[A-Za-z_][\w-]*\s*:/;

/**
 * One top-level section of a skeleton file — the `key:` line, its body, and the
 * comment block that introduces it. Bounded by the next top-level key (whose
 * own leading comments go with it), so pulling `durations:` out of a file that
 * also has `windows:` gets `durations:` alone. Null if the key isn't there.
 */
function sectionOf(text, key) {
  const lines = String(text).split(/\r?\n/);
  const at = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
  if (at === -1) return null;
  let start = at;
  while (start > 0 && /^\s*#/.test(lines[start - 1])) start -= 1;
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    if (TOP_LEVEL.test(lines[i])) {
      end = i;
      while (end > at + 1 && /^\s*#/.test(lines[end - 1])) end -= 1;
      break;
    }
  }
  return lines.slice(start, end).join('\n').replace(/\s+$/, '');
}

/**
 * Top up a skeleton file written before a section existed — `durations:`
 * (Phase 4 §1) or `windows:` (§2). The user's copy is authoritative: it is only
 * appended to, never rewritten, so a file that already has the section comes
 * back untouched. Returns null when there's nothing to do, so the caller can
 * skip the write.
 */
function withSeededSection(current, seed, key) {
  if (sectionOf(current, key) != null) return null;
  const section = sectionOf(seed || '', key);
  if (section == null) return null;
  const body = String(current).replace(/\s*$/, '');
  return `${body}\n\n${section.replace(/^\s*\n/, '')}\n`;
}

/**
 * Phase 5 §3 — the `task_folders:` list, without a YAML parser.
 *
 * The main process doesn't `require('yaml')`: only runtime dependencies are
 * packaged, and this one shape doesn't need a parser. This reads the one shape the editor writes —
 * a block list of quoted-or-bare strings, or an inline `[]` — which is all
 * `stringifySkeleton` ever produces for it.
 *
 * Returns null when the key is **absent**, which is different from an empty
 * list: absent means "no opinion, use WD_TASK_FOLDERS", empty means "the whole
 * vault", and that distinction is the only way the editor can clear the scope.
 */
function taskFolders(text) {
  const section = sectionOf(text, 'task_folders');
  if (section == null) return null;
  const lines = section.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
  const head = lines.shift() || '';
  const inline = head.slice(head.indexOf(':') + 1).trim();
  if (inline && inline !== '[]') {
    return splitFolders(inline.replace(/^\[|\]$/g, '').split(','));
  }
  return splitFolders(
    lines.filter((l) => /^\s*-\s/.test(l)).map((l) => l.replace(/^\s*-\s*/, '')),
  );
}

/** Trim the quotes and blanks off a list of folder strings. */
function splitFolders(items) {
  return items
    .map((s) => String(s).trim().replace(/^["']|["']$/g, '').trim())
    .filter(Boolean);
}

// Phase 4 §1's names, kept so the shape of that change stays readable.
const durationsSection = (text) => sectionOf(text, 'durations');
const withSeededDurations = (current, seed) =>
  withSeededSection(current, seed, 'durations');

function readSeed({ distDir, devDir }) {
  const seed = [
    path.join(distDir, 'config', 'week-skeleton.yaml'),
    path.join(devDir, 'config', 'week-skeleton.yaml'),
  ].find((p) => fs.existsSync(p));
  return seed ? fs.readFileSync(seed, 'utf8') : '';
}

const TASK_FOLDERS_DOC = [
  '# Which folders the `#thisweek` sweep walks (Phase 5 §3), relative to the',
  '# vault. An empty list means the whole vault — what the sweep did before',
  '# this existed. `…Handoff Log.md` files and any `Action Plan` folder are',
  "# skipped by default: they are planning documents whose `- [ ]` lines are",
  '# not the week\'s tasks. Naming one here explicitly opts it back in.',
  '#',
  '# Seeded once from WD_TASK_FOLDERS; this file is authoritative afterwards,',
  '# which is what lets the skeleton editor change the scope.',
];

/** Append a `task_folders:` section built from `list`. Only ever called when
 *  the file has no such key — the user's copy is never rewritten. */
function withTaskFolders(text, list) {
  const body = (list || []).length
    ? ['task_folders:', ...list.map((f) => `  - "${f}"`)]
    : ['task_folders: []'];
  const doc = [...TASK_FOLDERS_DOC, ...body].join('\n');
  return `${String(text).replace(/\s*$/, '')}\n\n${doc}\n`;
}

function init({ distDir, devDir, taskFolders: seedFolders = [] }) {
  userFile = path.join(app.getPath('userData'), 'week-skeleton.yaml');
  let seed;
  try {
    seed = readSeed({ distDir, devDir });
  } catch (err) {
    console.error('[wd] skeleton: could not read the bundled default', err);
    seed = '';
  }

  if (!fs.existsSync(userFile)) {
    try {
      fs.mkdirSync(path.dirname(userFile), { recursive: true });
      fs.writeFileSync(userFile, seed, 'utf8');
    } catch (err) {
      console.error('[wd] skeleton: seed failed', err);
    }
  } else {
    // Already-installed copies predate `durations:` (Phase 4 §1) and `windows:`
    // (§2). Without this every task would sit on the 60m fallback and the gap
    // engine would have no time map at all, until the file was hand-edited.
    for (const key of ['durations', 'windows']) {
      try {
        const merged = withSeededSection(fs.readFileSync(userFile, 'utf8'), seed, key);
        if (merged != null) {
          fs.writeFileSync(userFile, merged, 'utf8');
          console.log(`[wd] skeleton: added the ${key}: section to the existing file`);
        }
      } catch (err) {
        console.error(`[wd] skeleton: ${key} top-up failed`, err);
      }
    }
  }

  // Phase 5 §3 — the sweep's scope, seeded from WD_TASK_FOLDERS the first time
  // and owned by this file from then on. Not part of the loop above: it isn't
  // copied out of the bundled default, it's built from the environment, which
  // is the only chance the env var gets to be heard.
  try {
    const cur = fs.readFileSync(userFile, 'utf8');
    if (taskFolders(cur) == null) {
      fs.writeFileSync(userFile, withTaskFolders(cur, seedFolders), 'utf8');
      console.log('[wd] skeleton: added the task_folders: section to the existing file');
    }
  } catch (err) {
    console.error('[wd] skeleton: task_folders top-up failed', err);
  }
}

async function read() {
  if (!userFile) throw new Error('skeleton store not initialised');
  return fsp.readFile(userFile, 'utf8');
}

/** Replace the file (the editor in Display & HUD). App-owned, so atomic is enough. */
async function write(yaml) {
  if (!userFile) throw new Error('skeleton store not initialised');
  await fsp.writeFile(`${userFile}.tmp`, yaml, 'utf8');
  await fsp.rename(`${userFile}.tmp`, userFile);
}

function openInEditor() {
  if (userFile) shell.openPath(userFile);
}

module.exports = {
  init,
  read,
  write,
  openInEditor,
  // Pure helpers, exported for the unit tests (test/duration.test.ts,
  // test/gaps.test.ts).
  sectionOf,
  withSeededSection,
  durationsSection,
  withSeededDurations,
  // Phase 5 §3 — the sweep's scope, read without a YAML parser.
  taskFolders,
  withTaskFolders,
};
