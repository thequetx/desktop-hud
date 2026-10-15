'use strict';

// Reads the Obsidian vault: the current weekly note (## Intentions / ## Tasks)
// and a vault-wide `#thisweek` checklist sweep. Also toggles a checkbox in place.
// Runs in the Electron main process — the renderer reaches it over IPC.
//
// Phase 3 §2b: one recursive fs.watch on the vault root feeds every window, and
// the sweep is mtime-keyed, so a `#thisweek` pass stats the vault instead of
// reading all of it. Between them they replace the per-renderer 5-minute polls.
//
// Phase 5 §2/§3: the weekly note also carries the week's own numbers in its
// frontmatter (so Obsidian Bases can table them without any dashboard code),
// and the sweep can be pointed at a few folders instead of the whole vault.

const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');

const CHECK_RE = /^(\s*)-\s\[([ xX])\]\s+(.*)$/;
const SKIP_DIRS = new Set(['.git', '.obsidian', '.trash', 'node_modules']);

// ---- Phase 5 §3: what the `#thisweek` sweep is allowed to look at ---------
//
// Default exclusions. These are planning documents — an Action Plan phase note
// and a project handoff log are wall-to-wall `- [ ]` lines that are somebody's
// *roadmap*, not the user's week. One `#thisweek` anywhere in them and 70-odd
// checkboxes land in the Unscheduled rail.
//
// They are matched against the path **below** whatever folder the sweep was
// pointed at, so naming one explicitly in `WD_TASK_FOLDERS` opts back in: the
// exclusions are a default, not a wall.
const EXCLUDE_DIRS = new Set(['action plan']);
const EXCLUDE_FILE_RE = /handoff log\.md$/i;

/** True for a path the sweep skips by default. `rel` is relative to the folder
 *  being swept (the vault root, when no folders are configured). */
function isExcludedRel(rel) {
  const parts = String(rel).split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return false;
  if (EXCLUDE_FILE_RE.test(parts[parts.length - 1])) return true;
  return parts.slice(0, -1).some((p) => EXCLUDE_DIRS.has(p.toLowerCase()));
}

/** `WD_TASK_FOLDERS` (or the skeleton's `task_folders:`) as a list of clean,
 *  vault-relative, forward-slashed folders. Empty in, empty out — and empty
 *  means the whole vault, which is what the sweep did before this existed. */
function parseTaskFolders(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  const out = [];
  for (const item of list) {
    const clean = String(item ?? '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\.?\//, '')
      .replace(/\/+$/, '');
    if (!clean || clean === '.' || out.includes(clean)) continue;
    out.push(clean);
  }
  return out;
}

// ---- live-sync tuning -----------------------------------------------------

// Obsidian saves noisily: a single save can fire several change/rename events
// (and Windows often reports the same file twice), so events are coalesced.
const WATCH_DEBOUNCE_MS = 300;
// How long the fingerprint of a write we made stays worth checking against.
// This is cache hygiene, not the suppression rule — the rule is "the file still
// holds exactly the bytes we left there" (see isSelfWrite). A blanket time
// window used to swallow a genuine Obsidian save that landed on the same file
// a few hundred ms after an in-app toggle.
const SELF_WRITE_MS = 2000;
// Floor between two fallback rescans — window show/focus can fire in bursts
// (the ambient overlay shows and hides on every idle transition).
const RESCAN_MIN_GAP_MS = 15_000;
// A watcher that errors out (network drive hiccup, permissions) is re-armed,
// but not forever; past this the slow fallback pass is the safety net.
const WATCH_REARM_MS = 5_000;
const WATCH_MAX_ARMS = 5;

// ---- task-line fields ------------------------------------------------------
//
// Deliberate duplicates of src/lib/taskid.ts and src/lib/duration.ts. The main
// process can't import the renderer's ESM, and this file already carries a
// mirrored copy of src/lib/week.ts's ISO-week maths for the same reason — one
// established precedent beats a build step. Anything changed here changes there.
//
// Phase 5 §1: the mirror is now the whole task-line parser (src/lib/taskmeta.ts
// — both flavours of the Obsidian Tasks standard, plus our `wd:est`), because
// the main process needs the same three answers the renderer does: what is this
// task called, is it recurring, and which flavour do I write back in.
// test/taskmeta.test.ts runs one table through both copies and asserts they
// agree field for field, so a change to one that isn't made to the other fails
// rather than drifting quietly.

/** Obsidian Tasks' own id / dependsOn fields (Phase 4 §3). */
const TASK_ID_RE = /🆔\s*([A-Za-z0-9_-]+)/;
const DEPENDS_ON_RE = /⛔\s*([A-Za-z0-9_-]+(?:\s*,\s*[A-Za-z0-9_-]+)*)?/;
const TAG_RE = /(?:^|\s)#[A-Za-z0-9_\-/]+/g;

const DATE_FIELDS = ['due', 'scheduled', 'start', 'completion', 'cancelled', 'created'];
const PRIORITIES = ['highest', 'high', 'medium', 'none', 'low', 'lowest'];
const PRIORITY_RANK = {
  highest: 0,
  high: 1,
  medium: 2,
  none: 3,
  low: 4,
  lowest: 5,
};
const PRIORITY_BY_GLYPH = {
  '🔺': 'highest',
  '⏫': 'high',
  '🔼': 'medium',
  '🔽': 'low',
  '⏬': 'lowest',
};
const SIGNIFIERS = '📅📆🗓⏳⌛🛫✅❌➕🔺⏫🔼🔽⏬🆔⛔🏁🔁';
const VS = '\\uFE0F?';
const DATE_EMOJI = {
  due: '📅📆🗓',
  scheduled: '⏳⌛',
  start: '🛫',
  completion: '✅',
  cancelled: '❌',
  created: '➕',
};
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const inlineRe = (name) =>
  new RegExp(`[[(]\\s*(?:${name})\\s*::\\s*([^\\])]*?)\\s*[\\])]`, 'i');

const DATE_RE = {};
for (const f of DATE_FIELDS) {
  DATE_RE[f] = {
    emoji: new RegExp(`[${DATE_EMOJI[f]}]${VS}\\s*(\\d{4}-\\d{2}-\\d{2})`, 'u'),
    inline: inlineRe(f),
  };
}

const PRIORITY_EMOJI_RE = /(🔺|⏫|🔼|🔽|⏬)️?/u;
const PRIORITY_INLINE_RE = inlineRe('priority');
const RECURRENCE_EMOJI_RE = new RegExp(`🔁${VS}\\s*([^${SIGNIFIERS}\\[(#]*)`, 'u');
const RECURRENCE_INLINE_RE = inlineRe('repeat|recurrence');
const ON_COMPLETION_EMOJI_RE = new RegExp(`🏁${VS}\\s*(keep|delete|ignore)?`, 'iu');
const ON_COMPLETION_INLINE_RE = inlineRe('onCompletion');

/** `wd:est`, both flavours (Phase 4 §1) — ours, not the standard's. */
const EST_TILDE_RE =
  /(?<=^|\s)~(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)(?![~\w])/i;
const EST_INLINE_RE = inlineRe('est');
const VALUE_RE = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/i;
const MIN_ESTIMATE_MINUTES = 5;
const MAX_ESTIMATE_MINUTES = 12 * 60;

const CHECKBOX_RE = /^\s*-\s\[[ xX]\]\s+/;
const COMPLETION_CLEAR_EMOJI = /✅️?(?:\s*\d{4}-\d{2}-\d{2})?/u;
const COMPLETION_CLEAR_INLINE = inlineRe('completion');

function parseDurationValue(raw) {
  const n =
    typeof raw === 'number'
      ? raw
      : (() => {
          const m = String(raw ?? '').trim().match(VALUE_RE);
          if (!m) return NaN;
          const v = Number(m[1]);
          return (m[2] ?? 'm').toLowerCase().startsWith('h') ? v * 60 : v;
        })();
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < MIN_ESTIMATE_MINUTES || rounded > MAX_ESTIMATE_MINUTES) return null;
  return rounded;
}

function applyCuts(text, cuts) {
  if (!cuts.length) return text.trim();
  const sorted = [...cuts].sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const c of sorted) {
    if (c.start < at) continue;
    out += text.slice(at, c.start);
    at = c.end;
  }
  out += text.slice(at);
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

/** Mirrors `parseTaskMeta` in src/lib/taskmeta.ts. See the note above. */
function parseTaskMeta(text) {
  const src = String(text ?? '').replace(CHECKBOX_RE, '');
  const cuts = [];
  let emojiHits = 0;
  let inlineHits = 0;
  const keep = (m, flavour) => {
    if (m && m.index !== undefined) cuts.push({ start: m.index, end: m.index + m[0].length });
    if (flavour === 'emoji') emojiHits++;
    else inlineHits++;
  };

  const dates = {};
  for (const name of DATE_FIELDS) {
    const em = src.match(DATE_RE[name].emoji);
    if (em) {
      dates[name] = { date: em[1], flavour: 'emoji', raw: em[0] };
      keep(em, 'emoji');
    }
    const im = src.match(DATE_RE[name].inline);
    if (im && ISO_DATE.test(im[1].trim())) {
      if (!dates[name]) dates[name] = { date: im[1].trim(), flavour: 'inline', raw: im[0] };
      keep(im, 'inline');
    }
  }

  let priority;
  const pe = src.match(PRIORITY_EMOJI_RE);
  if (pe) {
    const level = PRIORITY_BY_GLYPH[pe[1]];
    priority = { level, rank: PRIORITY_RANK[level], flavour: 'emoji', raw: pe[0] };
    keep(pe, 'emoji');
  }
  const pi = src.match(PRIORITY_INLINE_RE);
  if (pi) {
    const word = pi[1].trim().toLowerCase();
    const level = word === 'normal' ? 'none' : word;
    if (PRIORITIES.includes(level)) {
      if (!priority) {
        priority = { level, rank: PRIORITY_RANK[level], flavour: 'inline', raw: pi[0] };
      }
      keep(pi, 'inline');
    }
  }

  let recurrence;
  const re_ = src.match(RECURRENCE_EMOJI_RE);
  if (re_) {
    recurrence = { rule: re_[1].trim(), flavour: 'emoji', raw: re_[0].trimEnd() };
    keep(re_, 'emoji');
  }
  const ri = src.match(RECURRENCE_INLINE_RE);
  if (ri) {
    if (!recurrence) recurrence = { rule: ri[1].trim(), flavour: 'inline', raw: ri[0] };
    keep(ri, 'inline');
  }

  let onCompletion;
  const oe = src.match(ON_COMPLETION_EMOJI_RE);
  if (oe) {
    onCompletion = { value: (oe[1] ?? '').toLowerCase(), flavour: 'emoji', raw: oe[0].trimEnd() };
    keep(oe, 'emoji');
  }
  const oi = src.match(ON_COMPLETION_INLINE_RE);
  if (oi) {
    if (!onCompletion) {
      onCompletion = { value: oi[1].trim().toLowerCase(), flavour: 'inline', raw: oi[0] };
    }
    keep(oi, 'inline');
  }

  let id = null;
  const idm = src.match(TASK_ID_RE);
  if (idm) {
    id = idm[1];
    keep(idm, 'emoji');
  }
  let dependsOn = [];
  const dm = src.match(DEPENDS_ON_RE);
  if (dm) {
    dependsOn = (dm[1] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    keep(dm, 'emoji');
  }

  let est;
  const ei = src.match(EST_INLINE_RE);
  if (ei) {
    const minutes = parseDurationValue(ei[1]);
    if (minutes != null) {
      est = { minutes, raw: ei[0], flavour: 'inline' };
      keep(ei, 'inline');
    }
  }
  const et = src.match(EST_TILDE_RE);
  if (et) {
    const minutes = parseDurationValue(`${et[1]}${et[2]}`);
    if (minutes != null) {
      if (!est) est = { minutes, raw: et[0], flavour: 'tilde' };
      keep(et, 'emoji');
    }
  }

  const flavour =
    emojiHits === 0 && inlineHits === 0 ? null : inlineHits > emojiHits ? 'inline' : 'emoji';

  return {
    title: applyCuts(src, cuts),
    dates,
    priority,
    recurrence,
    onCompletion,
    id,
    dependsOn,
    fields: est ? { 'wd:est': est } : {},
    flavour,
    hasMeta: cuts.length > 0,
  };
}

/**
 * Does this line belong to the Tasks plugin's recurrence machinery?
 *
 * The one question `rollWeek` asks. A recurring line is **not** rolled: moving
 * it both duplicates it (the plugin regenerates the next instance itself) and
 * fights whatever `🏁` says should happen next.
 */
function isRecurring(text) {
  return Boolean(parseTaskMeta(text).recurrence);
}

/** `✅ 2026-09-04` or `[completion:: 2026-09-04]`. */
function completionRaw(date, flavour) {
  return flavour === 'inline' ? `[completion:: ${date}]` : `✅ ${date}`;
}

/** Remove any completion stamp, in either flavour. Ticking twice must not
 *  stack two dates, and unticking has to take the old one away. */
function clearCompletion(text) {
  return String(text ?? '')
    .replace(COMPLETION_CLEAR_INLINE, ' ')
    .replace(COMPLETION_CLEAR_EMOJI, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/, '');
}

/**
 * Stamp a completion date on a line, in the line's own flavour — the **only**
 * field this app writes (Phase 5 §1 Tier 2). `🔁` and `🏁` are untouched by
 * construction: nothing here goes near them.
 */
function withCompletion(text, date) {
  const flavour = parseTaskMeta(text).flavour === 'inline' ? 'inline' : 'emoji';
  const base = clearCompletion(text).replace(/\s+$/, '');
  return `${base} ${completionRaw(date, flavour)}`;
}

/**
 * A task line reduced to the words a human would call it, so the replan tally
 * written under `## Review` can be matched back to the task line that produced
 * it. Both sides go through this, so an estimate, a tag or an id added between
 * the replan and the roll can't break the link.
 */
function normaliseTitle(text) {
  return parseTaskMeta(text)
    .title.replace(DAY_PLANNER_RE, '')
    .replace(TAG_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ---- Phase 5 §5: the Day Planner range -----------------------------------
// Mirrors src/lib/source.ts (the renderer can't be imported here — same split
// as the task-line parser above). `- [ ] 09:00 - 10:30 Fix badge alpha` is the
// format the Day Planner plugin parses, and the nearest thing Obsidian has to
// an agreed timeblocking convention.
//
// Deliberately *not* one of `parseTaskMeta`'s fields: it is a placement, not
// metadata, and it belongs in the title where Day Planner and a human reader
// both expect it. `normaliseTitle` strips it only because scheduling a task
// must not change what the task is *called* — otherwise rescheduling would lose
// the line it was matching against.
const DAY_PLANNER_RE = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s+/;

function withDayPlannerRange(text, range) {
  const body = String(text ?? '').replace(DAY_PLANNER_RE, '');
  return range ? `${range} ${body}` : body;
}

/** `- Replanned: Edit video A ×2` under `## Review` — the running tally §4
 *  feeds the retrospective from. Greedy title so a task whose own name contains
 *  a `×3` still parses on the trailing count. */
const REPLAN_RE = /^-\s+Replanned:\s+(.+)\s+×(\d+)\s*$/;

/**
 * `- Audit: Stream — 12h planned / 9h kept — down 3h on W35` under `## Review`
 * — Phase 4 §5's planned-vs-actual rows.
 *
 * The rows themselves are computed in `src/lib/audit.ts` (pure, testable, and
 * the only place the ±90-minute match lives); this file only writes the lines
 * and reads them back, because "what did last week actually keep" has no source
 * other than last week's note. The two numbers survive the round trip at
 * `fmtHours`' own resolution — one decimal, so ±3 minutes — which is plenty for
 * a week-on-week difference and keeps the line something a human wrote.
 *
 * The trailing `— …` clause is optional so a line written before a previous
 * week existed still parses.
 */
const AUDIT_RE =
  /^-\s+Audit:\s+(.+?)\s+—\s+(\d+(?:\.\d+)?)h planned \/ (\d+(?:\.\d+)?)h kept(?:\s+—\s+.*)?$/;
/** Ceiling on the rows one review may write — mirrors AUDIT_ROWS in
 *  src/lib/audit.ts. A renderer asking for forty rows gets four. */
const AUDIT_MAX_ROWS = 4;
/** Replanning twice inside one week is the signal worth surfacing. A first
 *  replan is a normal week; a second says the plan, not the day, is wrong. */
const REPLAN_FLAG_AT = 2;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripTag(text, tag) {
  return text.replace(new RegExp(`\\s*${escapeRe(tag)}\\b`, 'g'), '').trim();
}

/**
 * Does this line really carry `tag`, as a tag?
 *
 * The sweep used to be `line.includes(tag)`, which meant any line *mentioning*
 * the tag counted — including documentation. This project's own design notes
 * describe the `#thisweek` sweep constantly, and one of them
 * (`Week Planner Plugin/Plugin Design.md`) is a checklist, so a line reading
 * "unscheduled tasks from the weekly note + \`#thisweek\`, with estimates"
 * turned up in the user's rail as a task. Phase 5 §3 anticipated the *folder*
 * version of this problem; this is the *code-span* version.
 *
 * So: blank out inline code spans first, then require the tag to end at a
 * non-word character, so `#thisweekly` is not `#thisweek`.
 */
function mentionsTag(line, tag) {
  const bare = String(line ?? '').replace(/`[^`]*`/g, ' ');
  let from = 0;
  for (;;) {
    const at = bare.indexOf(tag, from);
    if (at === -1) return false;
    const after = bare[at + tag.length];
    if (after === undefined || !/[\w/-]/.test(after)) return true;
    from = at + tag.length;
  }
}

/** A file's own line ending. Every write joins with the ending the file it is
 *  writing already uses — never a neighbour's. Obsidian leaves a note's endings
 *  alone, so rewriting them all is churn a human sees in a diff. */
function eolOf(text) {
  return String(text ?? '').includes('\r\n') ? '\r\n' : '\n';
}

/** [headingLine, contentEnd) for a `## <heading>` section. contentEnd is the
 *  index of the next heading (or lines.length). Returns null if not found. */
function sectionBounds(lines, heading) {
  const headRe = new RegExp(`^#{1,6}\\s+${escapeRe(heading)}\\s*$`, 'i');
  let head = -1;
  for (let i = 0; i < lines.length; i++) {
    if (head === -1) {
      if (headRe.test(lines[i])) head = i;
      continue;
    }
    if (/^#{1,6}\s/.test(lines[i])) return { head, end: i };
  }
  return head === -1 ? null : { head, end: lines.length };
}

/** Non-empty checklist items under a `## <heading>` section. */
function parseSection(lines, heading, file) {
  const b = sectionBounds(lines, heading);
  if (!b) return [];
  const items = [];
  for (let i = b.head + 1; i < b.end; i++) {
    const m = lines[i].match(CHECK_RE);
    if (m && m[3].trim()) {
      items.push({
        text: m[3].trim(),
        done: m[2].toLowerCase() === 'x',
        file,
        line: i,
        raw: lines[i],
      });
    }
  }
  return items;
}

// ---- Phase 4 §5: the planned-vs-actual rows under ## Review --------------

/** Every `- Audit:` row in a note's `## Review`, as minutes. This is the read
 *  half of "compare against last week" — the previous week's note is the only
 *  record of what that week kept. */
function auditRows(lines) {
  const b = sectionBounds(lines, 'Review');
  const out = [];
  if (!b) return out;
  for (let i = b.head + 1; i < b.end; i++) {
    const m = lines[i].match(AUDIT_RE);
    if (!m) continue;
    out.push({
      label: m[1].trim(),
      plannedMin: Math.round(Number(m[2]) * 60),
      keptMin: Math.round(Number(m[3]) * 60),
    });
  }
  return out;
}

/** Lines handed over IPC, reduced to ones this file is willing to write: a
 *  single line each, in the documented shape, capped. A renderer can compose
 *  the wording (it owns the arithmetic); it can't smuggle arbitrary markdown
 *  into the vault. */
function normaliseAuditLines(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const line = String(item ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!AUDIT_RE.test(line)) continue;
    out.push(line);
    if (out.length >= AUDIT_MAX_ROWS) break;
  }
  return out;
}

/**
 * Put `auditLines` under `## Review`, replacing whatever rows are already
 * there. **Idempotent**: every existing `- Audit:` line comes out before the
 * new set goes in, at the position the first one held, so reviewing the same
 * week twice rewrites the rows rather than stacking a second copy — the same
 * rule §4's `putStamp` follows for its one-line stamps.
 *
 * Mutates `lines` in place, like the rest of this file's note editing.
 */
function replaceAuditLines(lines, auditLines) {
  if (!auditLines.length) return false;
  let b = sectionBounds(lines, 'Review');
  if (!b) {
    lines.push('', '## Review', '');
    b = sectionBounds(lines, 'Review');
  }
  const hits = [];
  for (let i = b.head + 1; i < b.end; i++) {
    if (AUDIT_RE.test(lines[i])) hits.push(i);
  }
  let at;
  if (hits.length) {
    at = hits[0];
    for (let k = hits.length - 1; k >= 0; k--) lines.splice(hits[k], 1);
  } else {
    at = appendPointIn(lines, b);
  }
  lines.splice(at, 0, ...auditLines);
  return true;
}

/**
 * Where a new line goes in a section: after its last line with anything on it,
 * so an addition joins the list instead of landing past the section's trailing
 * blank lines — or, for a stamp, above them.
 *
 * Shared so `## Review`'s two writers agree. They used to differ: the roll's
 * stamps spliced at `head + 1`, eating the blank line under the heading, while
 * the audit rows appended at the end. Nothing broke, but a section written by
 * two hands reads like one.
 */
function appendPointIn(lines, b) {
  let at = b.head + 1;
  for (let i = b.head + 1; i < b.end; i++) {
    if (lines[i].trim()) at = i + 1;
  }
  return at;
}

// ---- Phase 5 §2: the weekly note's frontmatter ---------------------------
//
// Obsidian Bases reads **frontmatter**, and Obsidian Tasks reads **task
// lines**. §1 put this app's metadata on the task lines; this puts the week's
// aggregate numbers in the properties, which is the only surface a `.base`
// table can see (Weekly/Weekly.base is that table).
//
// Every writer here is idempotent and conservative. A weekly note is a file
// the user edits by hand: a key already in the block is rewritten **where it
// stands**, so nothing is reordered and nothing hand-written is disturbed, and
// keys this app doesn't know about are never touched. Reviewing the same week
// twice rewrites the values rather than growing a second block — the same rule
// `replaceAuditLines` and `putStamp` follow for the prose half.

/** A top-level `key: value` line inside the frontmatter block. Anchored with no
 *  leading whitespace, so the indented lines of a nested map are not keys. */
const FM_KEY_RE = /^([A-Za-z_][\w-]*):(.*)$/;

/** How many habits the streak map will carry. A Sunday reflection, not a
 *  telemetry sink — the same reasoning behind AUDIT_MAX_ROWS. */
const STREAK_MAX_KEYS = 8;

/** `{ start, end }` line indexes of the `---` fences, or null. Frontmatter is
 *  only frontmatter at the very top of the file: a `---` further down a note is
 *  a horizontal rule, and treating it as a fence would rewrite prose. */
function frontmatterBounds(lines) {
  if (!lines.length || lines[0].trim() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return { start: 0, end: i };
  }
  return null; // an unterminated fence isn't a block; leave it alone
}

/** The top-level `key: value` pairs, as raw strings. A key owning a nested map
 *  comes back with an empty value — enough to know the key is taken. */
function readFrontmatter(lines) {
  const b = frontmatterBounds(lines);
  const out = {};
  if (!b) return out;
  for (let i = b.start + 1; i < b.end; i++) {
    const m = lines[i].match(FM_KEY_RE);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** True when the line after `i` is indented, i.e. `i` heads a nested block. */
function ownsBlock(lines, i) {
  return /^\s+\S/.test(lines[i + 1] ?? '');
}

/**
 * Write scalar `updates` into the frontmatter, in place. Returns true if
 * anything actually changed.
 *
 * A note with **no** frontmatter gets none — this never invents a block on a
 * file that didn't have one. A key that heads a nested map is left alone:
 * replacing the scalar would orphan the indented lines under it (that's what
 * `setFrontmatterMap` is for). New keys go in just above the closing fence.
 */
function setFrontmatter(lines, updates) {
  const b = frontmatterBounds(lines);
  if (!b) return false;
  let end = b.end;
  let changed = false;
  for (const [key, value] of Object.entries(updates)) {
    if (value == null) continue;
    const text = `${key}: ${value}`;
    let at = -1;
    for (let i = b.start + 1; i < end; i++) {
      const m = lines[i].match(FM_KEY_RE);
      if (m && m[1] === key) {
        at = i;
        break;
      }
    }
    if (at === -1) {
      lines.splice(end, 0, text);
      end += 1;
      changed = true;
    } else if (!ownsBlock(lines, at) && lines[at] !== text) {
      lines[at] = text;
      changed = true;
    }
  }
  return changed;
}

/**
 * Write a nested map (`streaks:` and its indented lines) into the frontmatter,
 * replacing whatever block the key already owns. An empty map collapses back to
 * `key: {}` so the property still exists for Bases rather than vanishing from
 * the schema on a week with no habits in it.
 */
function setFrontmatterMap(lines, key, map) {
  const b = frontmatterBounds(lines);
  if (!b) return false;
  const entries = Object.entries(map || {})
    .filter(([k]) => /^[A-Za-z_][\w-]*$/.test(k))
    .sort((a, z) => (a[0] < z[0] ? -1 : 1));
  const next = entries.length
    ? [`${key}:`, ...entries.map(([k, v]) => `  ${k}: ${v}`)]
    : [`${key}: {}`];

  let at = -1;
  for (let i = b.start + 1; i < b.end; i++) {
    const m = lines[i].match(FM_KEY_RE);
    if (m && m[1] === key) {
      at = i;
      break;
    }
  }
  if (at === -1) {
    lines.splice(b.end, 0, ...next);
    return true;
  }
  let last = at;
  while (last + 1 < b.end && /^\s+\S/.test(lines[last + 1])) last += 1;
  const cur = lines.slice(at, last + 1);
  if (cur.length === next.length && cur.every((l, i) => l === next[i])) return false;
  lines.splice(at, last - at + 1, ...next);
  return true;
}

/** Minutes as the hours a property should hold — one decimal, so `hours_kept`
 *  sorts and sums in Bases instead of being a string like `9h`. */
function hoursOf(min) {
  return Math.round((Number(min) || 0) / 6) / 10;
}

/**
 * The renderer's per-habit `kept / slots` counts — src/lib/audit.ts's `kind`
 * rows, the same numbers behind the rail's `GYM 3/5` — reduced to what this
 * file is willing to write: a slug and two small integers. A renderer composes
 * the week; it doesn't get to put arbitrary YAML in the vault.
 *
 * Null (rather than `{}`) when there is nothing to say, so the caller can leave
 * an existing map alone instead of blanking it.
 */
function normaliseStreaks(raw) {
  if (!Array.isArray(raw)) return null;
  const out = {};
  for (const item of raw) {
    if (Object.keys(out).length >= STREAK_MAX_KEYS) break;
    const name = String(item?.name ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!/^[a-z]/.test(name)) continue;
    const slots = Math.max(0, Math.round(Number(item?.slots) || 0));
    if (!slots) continue; // a habit with nothing planned isn't a streak
    const kept = Math.min(slots, Math.max(0, Math.round(Number(item?.kept) || 0)));
    out[name] = `${kept}/${slots}`;
  }
  return out;
}

// ---- ISO-week helpers (mirrors src/lib/week.ts) --------------------------

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DOWS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

function isoWeekMonday(year, week) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dow = (jan4.getUTCDay() + 6) % 7; // Mon=0
  const wk1Mon = new Date(jan4);
  wk1Mon.setUTCDate(jan4.getUTCDate() - dow);
  const d = new Date(wk1Mon);
  d.setUTCDate(wk1Mon.getUTCDate() + (week - 1) * 7);
  return d;
}

/**
 * A week note's ID, `2026-W42`: the only thing that may name a weekly note.
 * Phase 9.0 (trust model S3) — the ID arrives from the renderer over IPC and
 * is joined into a path, so `..\..\x` must never get that far.
 */
const WEEK_ID_RE = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;

function isWeekId(id) {
  return typeof id === 'string' && WEEK_ID_RE.test(id);
}

function isoWeekId(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3); // Thursday
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const ftDay = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - ftDay + 3);
  const week = 1 + Math.round((t - firstThu) / (7 * 86400000));
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function nextWeekId(weekId) {
  const m = weekId.match(/^(\d{4})-W(\d{2})$/);
  if (!m) throw new Error(`bad week id: ${weekId}`);
  const mon = isoWeekMonday(+m[1], +m[2]);
  mon.setUTCDate(mon.getUTCDate() + 7);
  return isoWeekId(mon);
}

function weekRange(weekId) {
  const m = weekId.match(/^(\d{4})-W(\d{2})$/);
  const mon = isoWeekMonday(+m[1], +m[2]);
  const sun = new Date(mon);
  sun.setUTCDate(mon.getUTCDate() + 6);
  return { mon, sun };
}

const iso = (d) => d.toISOString().slice(0, 10); // for UTC-constructed dates
const dMon = (d) =>
  `${DOWS[(d.getUTCDay() + 6) % 7]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;

/** Today's date in the machine's local timezone (not UTC). */
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/** The ISO week the machine is in right now. Built from `todayLocal()` rather
 *  than handing `new Date()` to `isoWeekId` — that reads UTC fields, which put
 *  a Sydney Monday morning in the previous week. */
function currentWeekId() {
  const [y, m, d] = todayLocal().split('-').map(Number);
  return isoWeekId(new Date(Date.UTC(y, m - 1, d)));
}

// The sweep's walker: never follows a link, bounded depth (Phase 9.4, S3).
const { walkMd, MAX_NOTE_BYTES } = require('./safepath.cjs');

/** walkMd()'s skip rules, applied to the vault-relative path fs.watch hands
 *  back. Anything that wouldn't have been swept isn't worth waking three
 *  renderers for — `.obsidian/workspace.json` alone changes constantly. */
function isWatchableRel(rel) {
  const parts = String(rel).split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return false;
  for (const p of parts) {
    if (p.startsWith('.') || SKIP_DIRS.has(p)) return false;
  }
  return parts[parts.length - 1].toLowerCase().endsWith('.md');
}

/**
 * Where the weekly notes were before Phase 5 §4 promoted them to a vault-root
 * `Weekly/`. Kept as a fallback so the promotion is a *file move and nothing
 * else*: whichever of the two folders actually holds notes is the one used, so
 * moving them doesn't require editing `.env` in lockstep, and a build that
 * hasn't been reinstalled yet doesn't come up staring at an empty week.
 *
 * Delete this once the move is done and settled.
 */
const LEGACY_WEEKLY_DIR = 'Claude Conversations/Week Dashboard/Weekly';
/** Where Phase 5 §4 promotes them to — the vault root. The owner made this move on
 *  2026-08-30 so the Weekfit plugin (which defaults here) would see the notes. */
const PROMOTED_WEEKLY_DIR = 'Weekly';

/** The configured weekly folder, or the pre-§4 one when that's where the notes
 *  still are. Only ever falls back when the configured folder is absent or has
 *  no weekly notes in it — an empty *new* folder must not silently resurrect
 *  the old location once the move has happened. */
function resolveWeeklyAbs(root, weeklyDir) {
  const hasNotes = (dir) => {
    try {
      return fss.readdirSync(dir).some((f) => /^\d{4}-W\d{2}\.md$/i.test(f));
    } catch {
      return false;
    }
  };

  const configured = path.resolve(root, weeklyDir);

  // Follow the notes, whichever way the move went.
  //
  // The first version of this only handled "the config was updated but the files
  // haven't moved yet". the owner did the opposite on 2026-08-30 — moved the folder
  // to the vault root and left `.env` alone — and because the configured path
  // *was* the legacy path, an early return handed back a directory that no
  // longer existed. The app went blind: `notePath: null`, zero tasks, silently.
  //
  // So: prefer wherever the notes actually are, and only fall back to the
  // configured path (which is where `createWeek` would put a new one).
  for (const candidate of [
    configured,
    path.resolve(root, PROMOTED_WEEKLY_DIR),
    path.resolve(root, LEGACY_WEEKLY_DIR),
  ]) {
    if (hasNotes(candidate)) return candidate;
  }
  return configured;
}

function makeVault({
  vaultPath,
  weeklyDir,
  tag = '#thisweek',
  taskFolders = [],
  // Phase 5 §6 — the holding pen. Configurable like the weekly dir rather than
  // hardcoded, since it moves with the notes it sits beside.
  backlogPath = 'Backlog.md',
  // Phase 9.4 (trust model S1): a user's own folder is read-only unless they
  // turn writing on; the built-in store always writes. `writer` is
  // electron/safewrite.cjs (re-read, backup, atomic replace).
  canWrite = false,
  writer = null,
} = {}) {
  const root = path.resolve(vaultPath);
  const weeklyAbs = resolveWeeklyAbs(root, weeklyDir);

  /** The note for `weekId`, refusing anything that isn't a week ID. */
  function weekNoteAbs(weekId) {
    const id = String(weekId);
    if (!isWeekId(id)) throw new Error(`not a week id: ${JSON.stringify(id.slice(0, 24))}`);
    return path.join(weeklyAbs, `${id}.md`);
  }
  const ready = fss.existsSync(root);

  // ---- Phase 5 §3: sweep scope --------------------------------------------
  /** @type {string[]} vault-relative folders; empty = the whole vault */
  let folders = parseTaskFolders(taskFolders);

  // ---- mtime-keyed sweep cache -------------------------------------------
  // `#thisweek` used to mean reading every .md in the vault, on every call,
  // from every renderer. Now a pass stats each file and re-reads only the ones
  // whose mtime (or size) moved: steady state is N stats and zero reads.
  /** @type {Map<string, {mtimeMs:number,size:number,hasTag:boolean,items:object[]}>} */
  const sweepCache = new Map();
  /** @type {Promise<boolean> | null} */ let sweepInFlight = null;
  let lastSweepAt = 0;
  /** true once the watcher has given up for good and only rescan() is left */
  let watchDegraded = false;

  // ---- self-write suppression --------------------------------------------
  // Our own toggle / roll / create writes wake the watcher too, and
  // re-broadcasting them would only buy a second render of identical content.
  // The trick is to suppress *our write* and not *the path*: the user ticks a
  // `#thisweek` box in the rail while the same note is open in Obsidian, and
  // Obsidian flushes its own autosave a few hundred ms later. A blanket
  // 2-second window ate that edit and left the board wrong until the 4-minute
  // rescan. So a path is only suppressed while it still holds exactly what we
  // left there — anything else has written since, and that's news.

  /** abs path -> writes currently in flight (an event can fire mid-write, before
   *  there is anything to fingerprint) */
  const writing = new Map();
  /** abs path -> { mtimeMs, size, at } of the last write we finished */
  const wrote = new Map();

  function beginSelfWrite(abs) {
    const p = path.resolve(abs);
    writing.set(p, (writing.get(p) || 0) + 1);
    return p;
  }

  async function endSelfWrite(p) {
    let st = null;
    try {
      st = await fs.stat(p);
    } catch {
      /* written then removed — nothing to fingerprint */
    }
    if (st) wrote.set(p, { mtimeMs: st.mtimeMs, size: st.size, at: Date.now() });
    else wrote.delete(p);
    const left = (writing.get(p) || 1) - 1;
    if (left > 0) writing.set(p, left);
    else writing.delete(p);
  }

  /** Write a file and fingerprint it, so the watcher can tell our write apart
   *  from someone else's write to the same path a moment later. */
  async function selfWrite(abs, body, opts) {
    const p = beginSelfWrite(abs);
    try {
      if (writer) await writer.write(p, body, opts);
      else await fs.writeFile(p, body, 'utf8');
    } finally {
      await endSelfWrite(p);
    }
  }

  /** The answer for a write while writing is off. */
  const READ_ONLY = { ok: false, readOnly: true, error: 'Writing to this notes folder is turned off' };

  async function isSelfWrite(abs) {
    if (writing.has(abs)) return true; // still mid-write; the echo is ours
    const w = wrote.get(abs);
    if (!w) return false;
    if (Date.now() - w.at > SELF_WRITE_MS) {
      wrote.delete(abs); // stale fingerprint, stop carrying it around
      return false;
    }
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      return false; // gone since — that's a real change
    }
    if (st.mtimeMs === w.mtimeMs && st.size === w.size) return true;
    wrote.delete(abs); // someone has written since; stop suppressing this path
    return false;
  }

  /** `#thisweek`-tagged checklist lines in one file's text. */
  function taggedItems(text, rel) {
    const out = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(CHECK_RE);
      if (m && mentionsTag(lines[i], tag)) {
        out.push({
          text: stripTag(m[3], tag),
          done: m[2].toLowerCase() === 'x',
          file: rel,
          line: i,
        });
      }
    }
    return out;
  }

  /**
   * The folders the sweep walks: every configured one that resolves inside the
   * vault, or the vault root when none are configured. A folder nested inside
   * another configured folder is dropped rather than walked twice.
   */
  function sweepRoots() {
    if (!folders.length) return [root];
    const out = [];
    for (const f of folders) {
      let abs;
      try {
        abs = insideVault(f);
      } catch {
        continue; // `../elsewhere` is a typo, not a scope
      }
      if (!out.includes(abs)) out.push(abs);
    }
    if (!out.length) return [];
    return out.filter(
      (a, i) => !out.some((b, j) => j !== i && (a === b ? j < i : a.startsWith(b + path.sep))),
    );
  }

  async function runSweep() {
    let changed = false;
    const seen = new Set();
    for (const base of sweepRoots()) {
      for await (const file of walkMd(base)) {
        // Excluded against the path *below* the swept folder, so pointing
        // WD_TASK_FOLDERS straight at an excluded folder opts back into it.
        if (isExcludedRel(path.relative(base, file))) continue;
        if (seen.has(file)) continue;
        seen.add(file);
        let st;
        try {
          st = await fs.stat(file);
        } catch {
          continue; // vanished between the readdir and the stat
        }
        const hit = sweepCache.get(file);
        // Size as well as mtime: coarse filesystem timestamps (FAT, some
        // network shares) can round two quick edits onto the same millisecond.
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) continue;
        if (st.size > MAX_NOTE_BYTES) continue; // not a note anyone wrote by hand
        let text;
        try {
          text = await fs.readFile(file, 'utf8');
        } catch {
          continue;
        }
        const hasTag = text.split(/\r?\n/).some((l) => mentionsTag(l, tag));
        const rel = path.relative(root, file).replace(/\\/g, '/');
        sweepCache.set(file, {
          mtimeMs: st.mtimeMs,
          size: st.size,
          hasTag,
          items: hasTag ? taggedItems(text, rel) : [],
        });
        changed = true;
      }
    }
    for (const k of [...sweepCache.keys()]) {
      if (!seen.has(k)) {
        sweepCache.delete(k);
        changed = true;
      }
    }
    return changed;
  }

  /** One pass over the vault; resolves true when anything actually moved.
   *  Concurrent callers (three renderers reacting to the same push) share it. */
  function refreshSweep() {
    if (sweepInFlight) return sweepInFlight;
    sweepInFlight = runSweep().finally(() => {
      sweepInFlight = null;
      lastSweepAt = Date.now();
    });
    return sweepInFlight;
  }

  /** Fallback pass, for watch events the OS dropped (or that happened while
   *  the machine was asleep). Cheap — it stats rather than reads — and floored
   *  to one pass per RESCAN_MIN_GAP_MS unless forced. True if something moved. */
  async function rescan({ force } = {}) {
    if (!ready) return false;
    if (!force && Date.now() - lastSweepAt < RESCAN_MIN_GAP_MS) return false;
    return refreshSweep();
  }

  // ---- file watcher -------------------------------------------------------
  // Recursive watching is native on Windows and macOS — the only platforms this
  // app targets — so there's no chokidar here. Everything fails soft: a missing
  // vault, a network drive going away or a permissions error logs and leaves
  // rescan() as the safety net rather than taking the main process down.

  /** Watch the vault for `.md` changes. `onChange(paths)` fires at most once
   *  per WATCH_DEBOUNCE_MS. `opts.onDegraded(reason)` fires if the watcher gives
   *  up for good, so the app can say that live vault sync has dropped back to
   *  the slow pass. `rearmMs` / `maxArms` exist so the tests don't have to sit
   *  through 25 seconds of retries. Returns a stop function. */
  function watch(onChange, opts = {}) {
    const rearmMs = opts.rearmMs ?? WATCH_REARM_MS;
    const maxArms = opts.maxArms ?? WATCH_MAX_ARMS;
    const onDegraded = opts.onDegraded;
    let watcher = null;
    let debounce = null;
    let rearm = null;
    let arms = 0;
    let closed = false;
    const pending = new Set();

    const flush = async () => {
      debounce = null;
      const paths = [...pending];
      pending.clear();
      // Our own toggle / roll / create writes land here too. The window that
      // made them has already re-read; re-broadcasting would just buy a second
      // render of identical content. Suppression is per *write*, not per path
      // and not for a window of time — see isSelfWrite.
      const external = [];
      for (const p of paths) {
        if (p !== '*' && (await isSelfWrite(p))) continue;
        external.push(p);
      }
      if (closed || external.length === 0) return;
      try {
        onChange(external);
      } catch (err) {
        console.error('[wd] vault watch: onChange threw', err);
      }
    };

    const scheduleFlush = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        flush().catch((err) => console.error('[wd] vault watch: flush threw', err));
      }, WATCH_DEBOUNCE_MS);
    };

    const onEvent = (_evt, filename) => {
      if (filename == null) {
        pending.add('*'); // no name to filter on — assume it mattered
      } else {
        const rel = String(filename);
        if (!isWatchableRel(rel)) return;
        pending.add(path.resolve(root, rel));
      }
      scheduleFlush();
    };

    const degrade = (reason) => {
      watchDegraded = true;
      console.warn(
        `[wd] vault watch: live vault sync is OFF — ${reason}. Changes now only ` +
          'appear on the slow rescan (minutes, not seconds).',
      );
      if (onDegraded) {
        try {
          onDegraded(reason);
        } catch (err) {
          console.error('[wd] vault watch: onDegraded threw', err);
        }
      }
    };

    const retry = (err) => {
      // Both failure paths re-arm. The synchronous throw is the one that fires
      // when the vault lives on a network / OneDrive path that isn't mounted
      // yet at app-ready — exactly the case where waiting and trying again
      // works, and where returning silently left the app on the 4-minute poll
      // for the rest of the session with nothing said about it.
      if (closed || rearm) return;
      if (arms >= maxArms) {
        degrade(`gave up after ${arms} attempts (${err && err.message ? err.message : err})`);
        return;
      }
      rearm = setTimeout(arm, rearmMs);
    };

    const arm = () => {
      rearm = null;
      if (closed) return;
      arms += 1;
      try {
        watcher = fss.watch(root, { recursive: true }, onEvent);
      } catch (err) {
        watcher = null;
        console.error('[wd] vault watch: could not start — retrying', err);
        retry(err);
        return;
      }
      watchDegraded = false;
      watcher.on('error', (err) => {
        console.error('[wd] vault watch: error — re-arming', err);
        try {
          watcher.close();
        } catch {
          /* already gone */
        }
        watcher = null;
        retry(err);
      });
    };

    if (!ready) {
      degrade('vault path not found');
    } else {
      arm();
    }

    return () => {
      closed = true;
      if (debounce) clearTimeout(debounce);
      if (rearm) clearTimeout(rearm);
      if (watcher) {
        try {
          watcher.close();
        } catch {
          /* already gone */
        }
      }
      watcher = null;
    };
  }

  async function readWeek(weekId) {
    const noteAbs = weekNoteAbs(weekId);
    const notePath = path.relative(root, noteAbs).replace(/\\/g, '/');

    let intentions = [];
    let tasks = [];
    let noteExists = false;
    try {
      const lines = (await fs.readFile(noteAbs, 'utf8')).split(/\r?\n/);
      noteExists = true;
      intentions = parseSection(lines, 'Intentions', notePath);
      tasks = parseSection(lines, 'Tasks', notePath);
    } catch {
      /* weekly note not created yet */
    }

    // `#thisweek` sweep across the vault, excluding the current weekly note.
    // The pass itself is mtime-gated (refreshSweep); this just assembles the
    // cached result, in a stable order so the rail doesn't reshuffle.
    await refreshSweep();
    const skip = path.resolve(noteAbs);
    const thisweek = [];
    for (const [abs, entry] of sweepCache) {
      if (!entry.hasTag || abs === skip) continue;
      thisweek.push(...entry.items);
    }
    thisweek.sort((a, b) =>
      a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1,
    );

    return {
      weekId,
      notePath: noteExists ? notePath : null,
      weeklyDir,
      // Phase 5 §5 — `obsidian://open?vault=…` needs the vault's *name*, which
      // is its folder name. Sent with the week so the renderer can build the
      // link without knowing anything about the filesystem.
      vaultName: path.basename(root),
      intentions,
      tasks,
      thisweek,
      // True when the file watcher gave up and vault changes only arrive on the
      // slow rescan. Rides the payload every window already reads, so the
      // degradation is visible somewhere other than a console line.
      watchDegraded,
    };
  }


  // ---- Phase 5 §6: the backlog as a real holding pen -----------------------
  // `Backlog.md`'s "Someday / unsorted" has held exactly one blank checkbox
  // since it was created. The plan's diagnosis is that the third leg of the
  // task model was never given an inbox: without somewhere frictionless to put
  // a thought, the holding pen stays empty. Hence two operations and no more —
  // append a line, and move one up into this week.

  /** The section a backlog item lives in. */
  const BACKLOG_SECTION = 'Someday / unsorted';

  function backlogAbs() {
    return insideVault(backlogPath);
  }

  /** The open items in `Backlog.md`'s holding-pen section. */
  async function readBacklog() {
    const abs = backlogAbs();
    if (!fss.existsSync(abs)) return { ok: true, file: backlogPath, items: [] };
    const lines = (await fs.readFile(abs, 'utf8')).split(/\r?\n/);
    // `parseSection` already drops empty checkboxes, which is what the
    // section's lone placeholder is: the *absence* of a backlog, not an item.
    const items = parseSection(lines, BACKLOG_SECTION, backlogPath);
    return { ok: true, file: backlogPath, items };
  }

  /** Quick capture: append one line to the holding pen. Creates the file and
   *  the section if they aren't there — the inbox has to work on the first
   *  keystroke or it won't be used at all. */
  async function appendBacklog(text) {
    if (!canWrite) return READ_ONLY;
    const body = String(text ?? '').trim();
    if (!body) return { ok: false, error: 'empty' };
    const abs = backlogAbs();
    const exists = fss.existsSync(abs);
    const raw = exists ? await fs.readFile(abs, 'utf8') : '';
    // What the edit is based on: the write refuses if the note moved since.
    const expect = exists ? raw : null;
    const eol = exists ? eolOf(raw) : '\n';
    const lines = exists ? raw.split(/\r?\n/) : ['# Backlog', ''];
    let b = sectionBounds(lines, BACKLOG_SECTION);
    if (!b) {
      lines.push('', `## ${BACKLOG_SECTION}`, '');
      b = sectionBounds(lines, BACKLOG_SECTION);
    }
    // A captured line is one this app creates from nothing, so it uses the
    // emoji flavour by convention (Phase 5 §1) — which for a bare capture means
    // no metadata at all. Just the words, and a checkbox.
    lines.splice(appendPointIn(lines, b), 0, `- [ ] ${body}`);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await selfWrite(abs, lines.join(eol), { expect });
    return { ok: true, file: backlogPath };
  }

  /** Resolve a vault-relative path, refusing anything outside the vault. */
  function insideVault(file) {
    const abs = path.resolve(root, file);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error('refused: path outside the vault');
    }
    return abs;
  }



  /** Returns `{ lines, eol }` — the template's own line ending travels with the
   *  note it seeds, so a generated note doesn't silently adopt someone else's. */
  async function noteLinesFromTemplate(weekId) {
    const tpl = await fs.readFile(path.join(weeklyAbs, '_Template.md'), 'utf8');
    const { mon, sun } = weekRange(weekId);
    return {
      eol: eolOf(tpl),
      lines: tpl
        .replace(/week:\s*YYYY-WWW/, `week: ${weekId}`)
        .replace(/range:\s*YYYY-MM-DD to YYYY-MM-DD/, `range: ${iso(mon)} to ${iso(sun)}`)
        .replace(/last_updated:\s*YYYY-MM-DD/, `last_updated: ${todayLocal()}`)
        // Phase 5 §2 — `status` is seeded, not left on the template's word: a
        // note made for the week we're in is already being lived in, and one
        // made ahead (the roll's next-week note) is still being planned.
        .replace(
          /^status:.*$/m,
          `status: ${weekId === currentWeekId() ? 'active' : 'planning'}`,
        )
        .replace(
          /^#\s+Week\s+YYYY-WWW.*$/m,
          `# Week ${weekId}  ·  ${dMon(mon)} – ${dMon(sun)}`,
        )
        .split(/\r?\n/),
    };
  }


  /**
   * Phase 5 §3 — repoint the sweep. Called at startup from `WD_TASK_FOLDERS`
   * and again whenever the skeleton's `task_folders:` is saved, so narrowing
   * the scope doesn't need a restart. Returns true if the scope moved; the
   * next `refreshSweep` then prunes whatever fell out of it, because a file
   * that is no longer walked is no longer `seen`.
   */
  function setTaskFolders(next) {
    const parsed = parseTaskFolders(next);
    if (parsed.length === folders.length && parsed.every((f, i) => f === folders[i])) {
      return false;
    }
    folders = parsed;
    lastSweepAt = 0; // the floor on rescan() must not sit on a stale scope
    return true;
  }

  const relPath = (abs) => path.relative(root, abs).replace(/\\/g, '/');

  async function createWeek(weekId) {
    const abs = weekNoteAbs(weekId);
    if (fss.existsSync(abs)) return { ok: true, created: false, notePath: relPath(abs) };
    if (!canWrite) return { ...READ_ONLY, notePath: relPath(abs) };
    const { lines, eol } = await noteLinesFromTemplate(weekId);
    await fs.mkdir(weeklyAbs, { recursive: true });
    await selfWrite(abs, lines.join(eol), { expect: null });
    return { ok: true, created: true, notePath: relPath(abs) };
  }

  return {
    get canWrite() {
      return canWrite;
    },
    /** Turn writing on or off (Display & HUD → Notes). */
    setCanWrite(v) {
      canWrite = Boolean(v);
    },
    readWeek,
    readBacklog,
    appendBacklog,
    backlogPath,
    createWeek,
    watch,
    rescan,
    setTaskFolders,
    /** The sweep's current scope, for the startup log line. */
    get taskFolders() {
      return folders.slice();
    },
    root,
    weeklyAbs,
    ready,
    /** Live vault sync is off and only the slow rescan is covering changes. */
    get watchDegraded() {
      return watchDegraded;
    },
  };
}

module.exports = {
  isWeekId,
  makeVault,
  // Pure helpers, exported for the unit tests (test/vault.test.ts). The app
  // itself only ever reaches this file through makeVault().
  CHECK_RE,
  parseSection,
  sectionBounds,
  stripTag,
  mentionsTag,
  isWatchableRel,
  normaliseTitle,
  DAY_PLANNER_RE,
  withDayPlannerRange,
  // Phase 5 §4 — the promotion fallback, so moving the notes is a move and
  // nothing else.
  LEGACY_WEEKLY_DIR,
  PROMOTED_WEEKLY_DIR,
  resolveWeeklyAbs,
  // Phase 5 §1 — the mirrored task-line parser. test/taskmeta.test.ts runs the
  // same table through these and through src/lib/taskmeta.ts.
  parseTaskMeta,
  isRecurring,
  withCompletion,
  clearCompletion,
  completionRaw,
  parseDurationValue,
  PRIORITY_RANK,
  TASK_ID_RE,
  REPLAN_RE,
  REPLAN_FLAG_AT,
  AUDIT_RE,
  AUDIT_MAX_ROWS,
  auditRows,
  normaliseAuditLines,
  replaceAuditLines,
  isoWeekId,
  isoWeekMonday,
  nextWeekId,
  weekRange,
  currentWeekId,
  // Phase 5 §2 — the frontmatter layer (test/vault.test.ts).
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
};
