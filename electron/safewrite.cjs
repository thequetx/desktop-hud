'use strict';
// Writing to someone's notes (Phase 9.4, trust model S1). A bad write is data
// loss in the one place users care about most, so every write:
//
// - re-reads the file first and refuses if it changed since the caller read
//   it (`expect`): Obsidian or a sync tool may have written in between, and
//   refusing beats guessing, as Weekfit does;
// - backs the current version up before replacing it, keeping the last
//   MAX_VERSIONS per file (and at most MAX_FILE_BACKUP_BYTES of them) in
//   userData, so a write can always be undone by hand;
// - is atomic: a dot-named temp file in the same folder (sync tools and
//   Obsidian ignore it), then a rename. While Obsidian, OneDrive or an
//   antivirus holds the file, Windows fails the rename with EPERM or EBUSY:
//   it is retried with backoff, then refused, and the temp file removed;
// - writes a hardlinked file in place (after the backup), because a rename
//   would split it from its other names.
//
// It never deletes or renames a user's file.

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_VERSIONS = 20;
const MAX_FILE_BACKUP_BYTES = 20 * 1024 * 1024;
const RETRY_MS = [50, 100, 200, 400, 800];
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

class WriteConflict extends Error {
  constructor(message) {
    super(message);
    this.name = 'WriteConflict';
    this.code = 'ECONFLICT';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, '-');

async function readOrNull(abs) {
  try {
    return await fs.readFile(abs, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * @param {{ backupsDir: string, root: string, rename?: typeof fs.rename, now?: () => Date }} o
 *   `root` names the backup folders (by vault-relative path); `rename` is
 *   injectable so tests can hold the file the way Obsidian does.
 */
function makeSafeWriter({ backupsDir, root, rename = fs.rename, now = () => new Date() }) {
  const dirFor = (abs) => {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    const id = crypto.createHash('sha1').update(rel.toLowerCase()).digest('hex').slice(0, 16);
    return { dir: path.join(backupsDir, id), rel };
  };

  async function backup(abs, text) {
    const { dir, rel } = dirFor(abs);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'file.json'), JSON.stringify({ rel }), 'utf8');
    await fs.writeFile(path.join(dir, `${stamp(now())}.md`), text, 'utf8');
    // Newest first; keep MAX_VERSIONS and the byte budget.
    const names = (await fs.readdir(dir)).filter((n) => n.endsWith('.md')).sort().reverse();
    let bytes = 0;
    for (const [i, n] of names.entries()) {
      const p = path.join(dir, n);
      const size = (await fs.stat(p)).size;
      bytes += size;
      if (i >= MAX_VERSIONS || (i > 0 && bytes > MAX_FILE_BACKUP_BYTES)) await fs.rm(p, { force: true });
    }
  }

  async function renameWithRetry(from, to) {
    for (let i = 0; ; i++) {
      try {
        await rename(from, to);
        return;
      } catch (err) {
        if (!RETRYABLE.has(err.code) || i >= RETRY_MS.length) throw err;
        await sleep(RETRY_MS[i]);
      }
    }
  }

  /**
   * Replace `abs` with `body`. `expect` is the text the caller based its edit
   * on: null means "the file must not exist yet"; undefined skips the check
   * (only for files this app alone owns). Throws WriteConflict when the file
   * changed, or the last rename error once retries run out.
   */
  async function write(abs, body, { expect } = {}) {
    const current = await readOrNull(abs);
    if (expect !== undefined && current !== expect) {
      throw new WriteConflict(current == null ? 'the note was removed since it was read' : 'the note changed since it was read; nothing was written');
    }
    let st = null;
    if (current != null) {
      st = await fs.stat(abs);
      await backup(abs, current);
    } else {
      await fs.mkdir(path.dirname(abs), { recursive: true });
    }
    if (st && st.nlink > 1) {
      await fs.writeFile(abs, body, 'utf8');
      return { ok: true, inPlace: true };
    }
    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.dhud-tmp`);
    try {
      await fs.writeFile(tmp, body, 'utf8');
      await renameWithRetry(tmp, abs);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    return { ok: true };
  }

  /** Backed-up versions of `abs`, newest first: `{ file, at, size }`. */
  async function versions(abs) {
    const { dir } = dirFor(abs);
    let names = [];
    try {
      names = (await fs.readdir(dir)).filter((n) => n.endsWith('.md')).sort().reverse();
    } catch {
      return [];
    }
    return Promise.all(
      names.map(async (n) => ({ file: path.join(dir, n), at: n.slice(0, -3), size: (await fs.stat(path.join(dir, n))).size })),
    );
  }

  return { write, versions };
}

module.exports = { makeSafeWriter, WriteConflict, MAX_VERSIONS, MAX_FILE_BACKUP_BYTES };
