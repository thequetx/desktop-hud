'use strict';

// Phase 8 — vault readers for HUD bubbles.
//
// Two families:
//
//   - **Built-in readers** (`daily`) behind the built-in widgets of the
//     same name. Their note paths come from `.env`.
//   - **Custom bubble readers** (`note`, `tasks`, `fields`) behind the bubbles
//     the user defines in Display & HUD. Their paths come from the bubble itself,
//     so they are validated twice: by presentation.cjs when stored (no
//     absolute paths, no `..`), and by `inside()` here when read, which
//     checks the real path, so a junction can't lead out (Phase 9.4, #66).
//
// Everything here is **read-only** — the HUD is click-through, so nothing it
// shows may need a write to be correct. Every reader returns plain data and
// every failure comes back as null, so one broken note can't blank the others.
//
// Adding a reader: write a pure `parseX(text)` (exported, unit-tested), add it
// to BUILTIN or CUSTOM below, and add its data type to src/lib/widgets.ts.

const fs = require('node:fs/promises');
const path = require('node:path');
const {
  CHECK_RE,
  sectionBounds,
  readFrontmatter,
  frontmatterBounds,
  parseTaskMeta,
  mentionsTag,
  isoWeekId,
} = require('./vault.cjs');
const { makeContainment, walkMd, readNote } = require('./safepath.cjs');

/** A folder-wide tasks query stops walking here — a bubble, not an indexer. */
const MAX_SCAN_FILES = 4000;
const MAX_ITEMS = 50;

// ---- pure parsers ------------------------------------------------------------

/** A slider value from the daily note's frontmatter (`energy: 6`), or null for
 *  a blank one — the template ships the keys empty. */
function scoreOf(raw) {
  const n = Number(String(raw ?? '').trim());
  return String(raw ?? '').trim() !== '' && Number.isFinite(n) ? n : null;
}

/**
 * `<daily folder>/YYYY-MM-DD.md` → today's goals and how the day feels.
 *
 * Goals are the non-empty checkboxes under `## Goals` (the template seeds
 * blank ones, which are the absence of a goal, not a goal). The raw line text
 * is returned untouched so the renderer's task-line parser can strip the Tasks
 * metadata and read the priority, the same way the rail does.
 */
function parseDailyNote(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const fm = readFrontmatter(lines);
  const goals = parseNoteSection(text, 'Goals', 'tasks').items.map(({ text: t, done }) => ({ text: t, done }));
  return { goals, energy: scoreOf(fm.energy), motivation: scoreOf(fm.motivation) };
}

/**
 * Markdown → the plain words a HUD line should show: links become their
 * labels, emphasis and inline code lose their markers. Not a renderer — just
 * enough that `**Minimum:** [[Week 02|this]]` reads as "Minimum: this".
 */
function plainText(s) {
  return String(s ?? '')
    .replace(/!\[\[[^\]]*\]\]/g, '') // embeds
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, (_, t) => path.posix.basename(t.split('#')[0]))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|~~|==|`)(.+?)\1/g, '$2')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/**
 * One section of a note (or the whole body when `heading` is empty) as HUD
 * items.
 *
 *   `open`  — unchecked tasks only (the default: a HUD is for what's left);
 *   `tasks` — every task, done ones marked;
 *   `lines` — the section's text: list items, tasks and paragraphs, as lines.
 *
 * Code blocks (dataview, templater, meta-bind…) and headings are skipped —
 * they are machinery, not content, and would print as noise.
 */
function parseNoteSection(text, heading, items = 'open') {
  const lines = String(text ?? '').split(/\r?\n/);
  let start = 0;
  let end = lines.length;
  const fm = frontmatterBounds(lines);
  if (fm) start = fm.end + 1;
  if (heading) {
    const b = sectionBounds(lines, heading);
    if (!b) return { found: false, items: [] };
    start = b.head + 1;
    end = b.end;
  }
  const out = [];
  let fence = false;
  for (let i = start; i < end && out.length < MAX_ITEMS; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence || /^\s*$/.test(line)) continue;
    const task = line.match(CHECK_RE);
    if (task) {
      if (!task[3].trim()) continue; // a template's empty checkbox
      const done = task[2].toLowerCase() === 'x';
      if (items === 'open' && done) continue;
      out.push({ kind: 'task', text: task[3].trim(), done, line: i });
      continue;
    }
    if (items !== 'lines') continue;
    if (/^\s*#{1,6}\s/.test(line) || /^\s*(---|\*\*\*|___)\s*$/.test(line) || /^\s*%%/.test(line)) continue;
    const body = plainText(line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/^\s*>\s?/, ''));
    if (body) out.push({ kind: 'text', text: body, done: false, line: i });
  }
  return { found: true, items: out };
}

/** Selected frontmatter keys, as display strings. A key that owns a nested
 *  list is shown as its items joined, since that is usually what it means. */
function parseFields(text, keys) {
  const lines = String(text ?? '').split(/\r?\n/);
  const fm = readFrontmatter(lines);
  const b = frontmatterBounds(lines);
  const out = [];
  for (const key of keys) {
    if (!(key in fm)) {
      out.push({ key, value: null });
      continue;
    }
    let value = fm[key].replace(/^["']|["']$/g, '');
    if (value === '' && b) {
      const at = lines.findIndex((l, i) => i > b.start && i < b.end && l.startsWith(`${key}:`));
      const items = [];
      for (let i = at + 1; at >= 0 && i < b.end && /^\s+-\s/.test(lines[i]); i++) {
        items.push(lines[i].replace(/^\s+-\s+/, '').trim());
      }
      value = items.join(', ');
    }
    out.push({ key, value: value === '' ? null : plainText(value) });
  }
  return out;
}

/** The headings in a note, for the editor's section picker. */
function listHeadings(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.match(/^#{1,6}\s+(.+?)\s*#*\s*$/))
    .filter(Boolean)
    .map((m) => m[1])
    .slice(0, 100);
}

// ---- dates and tokens ----------------------------------------------------------

function isoDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseDay(iso) {
  const m = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/**
 * Tokens a bubble's path may use, so one bubble can follow the calendar:
 * `{today}` `{yesterday}` `{tomorrow}` (YYYY-MM-DD), `{week}` (2026-W39),
 * `{year}`, `{month}` (09). Unknown tokens are left as typed, which makes a
 * typo visible as a missing note rather than silently reading another one.
 */
function resolveTokens(p, today) {
  const t = parseDay(today) || new Date();
  const shift = (n) => {
    const d = new Date(t);
    d.setDate(d.getDate() + n);
    return isoDay(d);
  };
  const tokens = {
    today: isoDay(t),
    yesterday: shift(-1),
    tomorrow: shift(1),
    week: isoWeekId(new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()))),
    year: String(t.getFullYear()),
    month: String(t.getMonth() + 1).padStart(2, '0'),
  };
  return String(p ?? '').replace(/\{(\w+)\}/g, (all, k) => tokens[k] ?? all);
}

/** Does a task's due date pass a bubble's `due` filter? */
function dueMatches(filter, due, today) {
  if (filter === 'any') return true;
  if (!due) return false;
  if (filter === 'overdue') return due < today;
  if (filter === 'today') return due <= today;
  // 'week': overdue, or due within the next seven days.
  const limit = parseDay(today);
  if (!limit) return false;
  limit.setDate(limit.getDate() + 6);
  return due <= isoDay(limit);
}

const PRIORITY_FLOOR = { any: 99, medium: 2, high: 1, highest: 0 };

// ---- the reader ----------------------------------------------------------------

/** A note's text, or null: missing, not a file, or over the size cap. */
const readText = readNote;

/**
 * @param {{ root: string, dailyDir: string }} cfg
 *   vault root (absolute) and the daily-note folder, vault-relative. (The art
 *   and meal readers moved to private add-ons in Phase 9.3.)
 */
function makeWidgetSources({ root, dailyDir }) {
  /** Absolute path for a vault-relative one, or null if it would leave the
   *  vault, by name or through a link, or doesn't exist. */
  const contain = makeContainment(root);
  const inside = async (rel) => ((await contain.real(rel)) ? contain.lexical(rel) : null);
  /** A note path as typed: tokens resolved, `.md` optional. */
  const notePath = (p, today) => {
    const r = resolveTokens(p, today).replace(/\\/g, '/');
    return r.toLowerCase().endsWith('.md') ? r : `${r}.md`;
  };

  // mtime-keyed parse cache for tasks queries — a folder-wide bubble re-reads
  // only the files that changed, the same trick as the #thisweek sweep.
  /** @type {Map<string, {mtimeMs:number,size:number,tasks:object[]}>} */
  const taskCache = new Map();

  // Never follows a link; bounded depth (electron/safepath.cjs).
  const walk = walkMd;

  async function tasksIn(abs) {
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      return [];
    }
    const hit = taskCache.get(abs);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.tasks;
    const text = (await readText(abs)) ?? '';
    const rel = path.relative(root, abs).split(path.sep).join('/');
    const tasks = [];
    text.split(/\r?\n/).forEach((line, i) => {
      const m = line.match(CHECK_RE);
      if (m && m[3].trim()) tasks.push({ text: m[3].trim(), done: m[2].toLowerCase() === 'x', file: rel, line: i });
    });
    taskCache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, tasks });
    return tasks;
  }

  const BUILTIN = {
    async daily({ today }) {
      if (!dailyDir || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
      const file = path.posix.join(dailyDir.replace(/\\/g, '/'), `${today}.md`);
      const abs = await inside(file);
      const text = abs && (await readText(abs));
      if (text == null) return { file, exists: false, goals: [], energy: null, motivation: null };
      return { file, exists: true, ...parseDailyNote(text) };
    },
  };

  const CUSTOM = {
    async note(src, { today }) {
      if (!src.path) return { exists: false, file: '', found: false, items: [] };
      const file = notePath(src.path, today);
      const abs = await inside(file);
      const text = abs && (await readText(abs));
      if (text == null) return { exists: false, file, found: false, items: [] };
      return { exists: true, file, ...parseNoteSection(text, src.heading, src.items) };
    },

    async tasks(src, { today }) {
      const folder = resolveTokens(src.folder || '', today);
      const abs = await inside(folder);
      if (!abs) return { items: [], total: 0 };
      const tag = src.tag ? (src.tag.startsWith('#') ? src.tag : `#${src.tag}`) : '';
      const floor = PRIORITY_FLOOR[src.priority] ?? 99;
      const out = [];
      let files = 0;
      const one = folder.toLowerCase().endsWith('.md') ? [abs] : null;
      for await (const f of one ?? walk(abs)) {
        if (++files > MAX_SCAN_FILES) break;
        for (const t of await tasksIn(f)) {
          if (t.done && !src.includeDone) continue;
          if (tag && !mentionsTag(t.text, tag)) continue;
          const meta = parseTaskMeta(t.text);
          const rank = meta.priority ? meta.priority.rank : 3;
          if (floor !== 99 && rank > floor) continue;
          const due = meta.dates && meta.dates.due ? meta.dates.due.date : null;
          if (!dueMatches(src.due, due, today)) continue;
          out.push({ ...t, due, rank });
        }
      }
      // Most urgent first: overdue/soonest due, then priority, then file order.
      out.sort(
        (a, b) =>
          Number(a.done) - Number(b.done) ||
          (a.due ?? '9999').localeCompare(b.due ?? '9999') ||
          a.rank - b.rank,
      );
      return { items: out.slice(0, MAX_ITEMS), total: out.length };
    },

    async fields(src, { today }) {
      if (!src.path) return { exists: false, file: '', fields: [] };
      const file = notePath(src.path, today);
      const abs = await inside(file);
      const text = abs && (await readText(abs));
      if (text == null) return { exists: false, file, fields: [] };
      return { exists: true, file, fields: parseFields(text, src.keys || []) };
    },
  };

  /**
   * Read what the renderer's bubbles need.
   * @param {{ ids?: string[], custom?: {id:string,type:string,source:object}[] }} req
   * @param {{ today: string }} ctx
   */
  async function read(req, ctx) {
    const out = {};
    const run = async (key, fn) => {
      try {
        out[key] = await fn();
      } catch (err) {
        console.error(`[wd] widgets: ${key} failed`, err);
        out[key] = null;
      }
    };
    for (const id of Array.isArray(req.ids) ? req.ids : []) {
      if (Object.prototype.hasOwnProperty.call(BUILTIN, id)) await run(id, () => BUILTIN[id](ctx));
    }
    const custom = {};
    for (const b of Array.isArray(req.custom) ? req.custom.slice(0, 40) : []) {
      if (!b || !Object.prototype.hasOwnProperty.call(CUSTOM, b.type)) continue;
      try {
        custom[String(b.id)] = await CUSTOM[b.type](b.source || {}, ctx);
      } catch (err) {
        console.error(`[wd] widgets: bubble ${b.id} failed`, err);
        custom[String(b.id)] = null;
      }
    }
    out.custom = custom;
    return out;
  }

  /** Every note in the vault (vault-relative), for the editor's path picker. */
  async function listNotes() {
    const out = [];
    for await (const f of walk(root)) {
      out.push(path.relative(root, f).split(path.sep).join('/'));
      if (out.length >= MAX_SCAN_FILES) break;
    }
    return out.sort((a, b) => a.localeCompare(b));
  }

  /** What the editor needs to offer for one note: does it exist, its
   *  headings, its frontmatter keys. Tokens resolved against `today`. */
  async function describe(p, today) {
    const file = notePath(p, today);
    const abs = await inside(file);
    const text = abs && (await readText(abs));
    if (text == null) return { exists: false, file, headings: [], keys: [] };
    return { exists: true, file, headings: listHeadings(text), keys: Object.keys(readFrontmatter(text.split(/\r?\n/))) };
  }

  return { read, listNotes, describe };
}

module.exports = {
  makeWidgetSources,
  parseDailyNote,
  parseNoteSection,
  parseFields,
  listHeadings,
  plainText,
  resolveTokens,
  dueMatches,
};
