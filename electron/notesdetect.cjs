'use strict';
// Detect-and-suggest for a notes folder the user picks (Phase 9.5): where its
// weekly notes, daily notes and backlog probably are, so the wizard can
// suggest settings instead of asking for paths. Read-only, bounded (depth and
// folder count), never follows a link (electron/safepath.cjs rules).

const fs = require('node:fs/promises');
const path = require('node:path');
const { SKIP_DIRS } = require('./safepath.cjs');

const MAX_DEPTH = 4;
const MAX_DIRS = 2000;
const WEEK_RE = /^\d{4}-W\d{2}\.md$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}\.md$/;
const BACKLOG_RE = /^backlog\.md$/i;

const rel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

/**
 * `{ obsidian, weeklyDir, dailyDir, backlogPath, weeks, days }`, each folder
 * vault-relative ('' = the root) or null when nothing looked like it. The
 * folder with the most matching notes wins; ties go to the shallower one.
 */
async function detectConventions(root) {
  const base = path.resolve(root);
  let obsidian = false;
  const weeks = new Map();
  const days = new Map();
  let backlog = null;
  let dirs = 0;
  async function walk(dir, depth) {
    if (depth > MAX_DEPTH || ++dirs > MAX_DIRS) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (e.name === '.obsidian' && dir === base) obsidian = true;
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
        await walk(path.join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        const r = rel(base, dir);
        if (WEEK_RE.test(e.name)) weeks.set(r, (weeks.get(r) || 0) + 1);
        else if (DAY_RE.test(e.name)) days.set(r, (days.get(r) || 0) + 1);
        else if (BACKLOG_RE.test(e.name)) {
          const p = rel(base, path.join(dir, e.name));
          if (!backlog || p.split('/').length < backlog.split('/').length) backlog = p;
        }
      }
    }
  }
  await walk(base, 0);
  const best = (m) => {
    let pick = null;
    for (const [k, n] of m) {
      if (!pick || n > pick[1] || (n === pick[1] && k.split('/').length < pick[0].split('/').length)) pick = [k, n];
    }
    return pick;
  };
  const w = best(weeks);
  const d = best(days);
  return {
    obsidian,
    weeklyDir: w ? w[0] : null,
    dailyDir: d ? d[0] : null,
    backlogPath: backlog,
    weeks: w ? w[1] : 0,
    days: d ? d[1] : 0,
  };
}

/** A vault-relative folder or file as a setting: forward slashes, no leading
 *  slash, never absolute or climbing out. '' is the root. Null when unusable. */
function cleanRel(v, { file = false } = {}) {
  if (typeof v !== 'string') return null;
  const p = v.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (p.length > 200 || /^[a-z]:/i.test(p) || p.split('/').some((s) => s === '..' || s === '.')) return null;
  if (/[\0<>:"|?*]/.test(p)) return null;
  if (file && !p.toLowerCase().endsWith('.md')) return null;
  return p;
}

/** `#thisweek`: a tag with its hash, letters, digits, `-`, `_`, `/`. Null otherwise. */
function cleanTag(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/^#?/, '#');
  return /^#[\p{L}\p{N}_/-]{1,40}$/u.test(t) ? t : null;
}

module.exports = { detectConventions, cleanRel, cleanTag };
