'use strict';
// Reading inside a notes folder someone else owns (Phase 9.4, trust model S3).
//
// - Containment is checked on real paths. `path.resolve` alone follows a
//   junction or symlink inside the folder to anywhere on the disk (Bug Log
//   #66), so a lexical check is only the first gate.
// - The walker never follows a link, skips app and tool folders, and stops at
//   a depth and a file count, so a huge or looping tree costs bounded work.
// - A note over MAX_NOTE_BYTES is not read: nothing the HUD shows needs it,
//   and a planted multi-gigabyte ".md" would otherwise be read whole.

const fs = require('node:fs/promises');
const path = require('node:path');

const SKIP_DIRS = new Set(['.git', '.obsidian', '.trash', 'node_modules']);
const MAX_DEPTH = 16;
const MAX_NOTE_BYTES = 2 * 1024 * 1024;

const isInside = (root, abs) => abs === root || abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/**
 * A containment checker for `root`. `lexical(rel)` is the absolute path, or
 * null if it would leave the root by name; `real(rel)` also resolves links and
 * is null if the file doesn't exist or really lives outside.
 */
function makeContainment(root) {
  const base = path.resolve(root);
  let realBase = null;
  const lexical = (rel) => {
    const abs = path.resolve(base, String(rel ?? ''));
    return isInside(base, abs) ? abs : null;
  };
  async function real(rel) {
    const abs = lexical(rel);
    if (!abs) return null;
    try {
      if (!realBase) realBase = await fs.realpath(base);
      const r = await fs.realpath(abs);
      return isInside(realBase, r) ? r : null;
    } catch {
      return null;
    }
  }
  return { root: base, lexical, real };
}

/** Markdown files under `dir`, without following links, to MAX_DEPTH. */
async function* walkMd(dir, depth = 0) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name) || e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkMd(full, depth + 1);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) yield full;
  }
}

/** A note's text, or null if it is missing, not a file, or over the cap. */
async function readNote(abs) {
  try {
    const st = await fs.stat(abs);
    if (!st.isFile() || st.size > MAX_NOTE_BYTES) return null;
    return await fs.readFile(abs, 'utf8');
  } catch {
    return null;
  }
}

module.exports = { makeContainment, walkMd, readNote, isInside, SKIP_DIRS, MAX_DEPTH, MAX_NOTE_BYTES };
