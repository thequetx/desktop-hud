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
const fss = require('node:fs');
const path = require('node:path');

const SKIP_DIRS = new Set(['.git', '.obsidian', '.trash', 'node_modules']);
const MAX_DEPTH = 16;
const MAX_NOTE_BYTES = 2 * 1024 * 1024;

const isInside = (root, abs) => abs === root || abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/**
 * An absolute path in its real, canonical spelling when it exists (8.3 short
 * names expanded, junctions followed), otherwise just resolved. Notes are
 * read on real paths, so a root spelt any other way makes root-relative
 * comparisons miss (Bug Log #94).
 */
function canonicalRoot(p) {
  const abs = path.resolve(p);
  try {
    return fss.realpathSync.native(abs);
  } catch {
    return abs;
  }
}

/**
 * `p` with its folder in canonical spelling: the nearest existing ancestor is
 * resolved and the rest kept. The last segment is left alone, so a link at the
 * file itself is still the caller's to judge.
 */
function canonicalParent(p) {
  const abs = path.resolve(p);
  const tail = [path.basename(abs)];
  let dir = path.dirname(abs);
  while (true) {
    try {
      return path.join(fss.realpathSync.native(dir), ...tail.reverse());
    } catch {
      const up = path.dirname(dir);
      if (up === dir) return abs;
      tail.push(path.basename(dir));
      dir = up;
    }
  }
}

/**
 * A containment checker for `root`. `lexical(rel)` is the absolute path, or
 * null if it would leave the root by name; `real(rel)` also resolves links and
 * is null if the file doesn't exist or really lives outside.
 */
function makeContainment(root) {
  const base = path.resolve(root);
  let realBase = null;
  async function resolvedBase() {
    if (realBase) return realBase;
    let ancestor = base;
    const suffix = [];
    while (true) {
      try {
        const resolved = await fs.realpath(ancestor);
        realBase = path.resolve(resolved, ...suffix.reverse());
        return realBase;
      } catch (err) {
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw err;
        suffix.push(path.basename(ancestor));
        ancestor = parent;
      }
    }
  }
  const lexical = (rel) => {
    const abs = path.resolve(base, String(rel ?? ''));
    return isInside(base, abs) ? abs : null;
  };
  async function real(rel) {
    const abs = lexical(rel);
    if (!abs) return null;
    try {
      await resolvedBase();
      const r = await fs.realpath(abs);
      return isInside(realBase, r) ? r : null;
    } catch {
      return null;
    }
  }
  /** Resolve an existing or not-yet-created target without allowing an
   * existing junction/symlink ancestor to escape the chosen root. */
  async function realTarget(rel) {
    const abs = lexical(rel);
    if (!abs) return null;
    try {
      await resolvedBase();
      let ancestor = abs;
      const suffix = [];
      while (true) {
        try {
          const resolved = await fs.realpath(ancestor);
          const target = path.resolve(resolved, ...suffix.reverse());
          return isInside(realBase, target) ? target : null;
        } catch (err) {
          if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') return null;
          const parent = path.dirname(ancestor);
          if (parent === ancestor) return null;
          suffix.push(path.basename(ancestor));
          ancestor = parent;
        }
      }
    } catch {
      return null;
    }
  }
  return { root: base, lexical, real, realTarget };
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
  let handle;
  try {
    handle = await fs.open(abs, 'r');
    const st = await handle.stat();
    if (!st.isFile() || st.size > MAX_NOTE_BYTES) return null;
    // Filesystems may return short reads, and a file can grow after stat().
    // Start near its observed size, then grow only as the handle needs space.
    let buffer = Buffer.allocUnsafe(Math.min(Math.max(st.size, 4096), MAX_NOTE_BYTES + 1));
    let total = 0;
    for (;;) {
      if (total === buffer.length) {
        if (total > MAX_NOTE_BYTES) return null;
        const capacity = Math.min(Math.max(buffer.length * 2, 4096), MAX_NOTE_BYTES + 1);
        const larger = Buffer.allocUnsafe(capacity);
        buffer.copy(larger, 0, 0, total);
        buffer = larger;
      }
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_NOTE_BYTES) return null;
    }
    return buffer.subarray(0, total).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

module.exports = { canonicalRoot, canonicalParent, makeContainment, walkMd, readNote, isInside, SKIP_DIRS, MAX_DEPTH, MAX_NOTE_BYTES };
