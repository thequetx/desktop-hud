'use strict';
// Diagnostics and the user's data (Phase 9.6, trust model S5 and S7).
//
// - A ring of recent log lines, kept in memory only (no log file is written).
// - "Save diagnostics…": a plain-text report for a bug report. Everything in
//   it is redacted first: a link keeps only its scheme and host (a calendar
//   link is a secret), any file path becomes <path>, an email <email>. It
//   never includes secrets, the calendar cache, note text or backups.
// - The list of what "Remove all my data" deletes, so the dialog and the
//   deletion can't disagree.

const os = require('node:os');

const RING = 500;
const lines = [];

/** Keep the last RING lines of console output (redaction happens on save). */
function captureConsole(con = console) {
  for (const level of ['log', 'warn', 'error']) {
    const orig = con[level].bind(con);
    con[level] = (...args) => {
      try {
        const text = args.map((a) => (a instanceof Error ? `${a.message}` : typeof a === 'string' ? a : safeJson(a))).join(' ');
        lines.push(`${new Date().toISOString()} ${level.padEnd(5)} ${text}`);
        if (lines.length > RING) lines.splice(0, lines.length - RING);
      } catch {
        // never let logging break the app
      }
      orig(...args);
    };
  }
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Text with links, paths and emails taken out. */
function redact(text) {
  return String(text)
    .replace(/\b(https?|webcal|wss?|ftp):\/\/([^\s/'"<>]+)[^\s'"<>]*/gi, (_m, scheme, host) => `${scheme}://${host.replace(/^[^@]*@/, '')}/…`)
    .replace(/\bfile:\/\/\/?[^\s'"<>]*/gi, 'file:<path>')
    // A path may hold spaces ("My Notes"), so it runs to a quote, bracket,
    // comma, semicolon or the end of the line. Over-redacting is the safe side.
    .replace(/\b[a-z]:[\\/][^'"<>|()\[\]\n,;]*/gi, '<path>')
    .replace(/\\\\[^'"<>|()\[\]\n,;]+/g, '<path>')
    .replace(/%USERPROFILE%[^'"<>|()\[\]\n,;]*/gi, '<path>')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>');
}

/**
 * The report. `facts` is what main knows that is safe to share: versions,
 * counts and switches, never names, paths or links.
 */
function buildReport(facts) {
  const out = [
    'Desktop HUD diagnostics',
    `Saved: ${new Date().toISOString()}`,
    '',
    'This file is for a bug report. Links, file paths and email addresses are',
    'removed. It contains no calendar links, no notes, no backups and no secrets.',
    '',
    '## App',
    ...Object.entries(facts.app || {}).map(([k, v]) => `${k}: ${v}`),
    `os: ${os.type()} ${os.release()} (${os.arch()})`,
    '',
    '## Settings',
    ...Object.entries(facts.settings || {}).map(([k, v]) => `${k}: ${typeof v === 'object' ? safeJson(v) : v}`),
    '',
    `## Recent log (last ${lines.length} lines)`,
    ...lines,
  ];
  return redact(out.join('\n')) + '\n';
}

/** Electron's own files in userData: in use while the app runs, so "Remove
 *  all my data" leaves a marker and they go on the next start. */
const CHROMIUM = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache', 'GraphiteDawnCache', 'GPUPersistentCache', 'ShaderCache', 'Local Storage', 'Session Storage', 'Network', 'blob_storage', 'Shared Dictionary', 'DIPS', 'DIPS-wal', 'Local State', 'Preferences', 'lockfile', 'Crashpad', 'DevToolsActivePort', 'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'declarative_performance_observer.db', 'declarative_performance_observer.db-journal']);
const REMOVE_MARKER = '.remove-on-start';
const BUILTIN_NOTES = 'Notes';

/**
 * What "Remove all my data" deletes now: every entry in userData that is the
 * app's (settings, encrypted links, calendar cache, backups, add-on files),
 * except Electron's own (deleted on the next start) and, unless asked, the
 * built-in notes. A user's own notes folder is never inside userData.
 */
function removableNow(entries, { notes = false } = {}) {
  return entries.filter((n) => !CHROMIUM.has(n) && n !== REMOVE_MARKER && (notes || n !== BUILTIN_NOTES));
}

module.exports = { captureConsole, redact, buildReport, removableNow, CHROMIUM, REMOVE_MARKER, BUILTIN_NOTES, _lines: lines };
