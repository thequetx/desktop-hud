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
// - for ordinary files, replacement is atomic: a dot-named temp file in the same folder (sync tools and
//   Obsidian ignore it), then a rename. While Obsidian, OneDrive or an
//   antivirus holds the file, Windows fails the rename with EPERM or EBUSY:
//   it is retried with backoff, then refused, and the temp file removed;
// - writes a hardlinked file in place (after the backup), because a rename
//   would split it from its other names.
//
// Conflicts are checked before each retry, but an external process can still
// write between the final check and replacement. Hardlink writes preserve the
// link relationship and are not atomic; backups are the recovery mechanism.

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { canonicalParent, canonicalRoot, makeContainment } = require('./safepath.cjs');

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
function makeSafeWriter({ backupsDir, root: rootIn, rename = fs.rename, now = () => new Date() }) {
  // The same spelling the vault uses, or its paths look outside (Bug Log #94).
  const root = canonicalRoot(rootIn);
  /** Any spelling of a path (short name, junction, redirected folder) in the
   * canonical form, so it gets one queue, one containment check and one
   * backup folder. */
  const spell = (abs) => canonicalParent(abs);
  const containment = makeContainment(root);
  const inFlight = new Map();
  const dirFor = (abs) => {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    const id = crypto.createHash('sha1').update(rel.toLowerCase()).digest('hex').slice(0, 16);
    return { dir: path.join(backupsDir, id), rel };
  };

  async function backup(abs, text) {
    const { dir, rel } = dirFor(abs);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'file.json'), JSON.stringify({ rel }), 'utf8');
    let name = `${stamp(now())}.md`;
    while (true) {
      try {
        await fs.writeFile(path.join(dir, name), text, { encoding: 'utf8', flag: 'wx' });
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        name = `${stamp(now())}-${crypto.randomBytes(4).toString('hex')}.md`;
      }
    }
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

  async function renameWithRetry(from, to, verify) {
    for (let i = 0; ; i++) {
      await verify();
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
    const target = spell(abs);
    const key = process.platform === 'win32' ? target.toLowerCase() : target;
    const prior = inFlight.get(key) || Promise.resolve();
    let release;
    const turn = new Promise((resolve) => { release = resolve; });
    const queued = prior.then(() => turn);
    inFlight.set(key, queued);
    await prior;
    try {
      const rel = path.relative(path.resolve(root), target);
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || !(await containment.realTarget(rel))) {
        throw new WriteConflict('the note path is outside the selected notes folder');
      }
      const verify = async () => {
        if (!(await containment.realTarget(rel))) throw new WriteConflict('the note path moved outside the selected notes folder');
        const current = await readOrNull(target);
        if (expect !== undefined && current !== expect) {
          throw new WriteConflict(current == null ? 'the note was removed since it was read' : 'the note changed since it was read; nothing was written');
        }
      };
      const current = await readOrNull(target);
      if (expect !== undefined && current !== expect) {
        throw new WriteConflict(current == null ? 'the note was removed since it was read' : 'the note changed since it was read; nothing was written');
      }
      let st = null;
      if (current != null) {
        st = await fs.stat(target);
        await backup(target, current);
      } else {
        await fs.mkdir(path.dirname(target), { recursive: true });
      }
      if (st && st.nlink > 1) {
        await verify();
        const fresh = await fs.stat(target);
        if (fresh.nlink <= 1) throw new WriteConflict('the note link changed while it was being written');
        await fs.writeFile(target, body, 'utf8');
        return { ok: true, inPlace: true };
      }
      const tmp = path.join(path.dirname(target), `.${path.basename(target)}.dhud-tmp-${crypto.randomBytes(8).toString('hex')}`);
      try {
        // Remove the fixed-name scratch file used by earlier releases. The
        // current write has a unique name and cannot collide with another run.
        await fs.rm(path.join(path.dirname(target), `.${path.basename(target)}.dhud-tmp`), { force: true });
        await fs.writeFile(tmp, body, { encoding: 'utf8', flag: 'wx' });
        await renameWithRetry(tmp, target, verify);
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      return { ok: true };
    } finally {
      release();
      if (inFlight.get(key) === queued) inFlight.delete(key);
    }
  }

  /** Backed-up versions of `abs`, newest first: `{ file, at, size }`. */
  async function versions(abs) {
    const { dir } = dirFor(spell(abs));
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
