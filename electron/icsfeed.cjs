'use strict';
// One calendar link (ICS), fetched by the main process for the events slot
// (electron/calsources.cjs, Phase 9.4).
//
// Until Phase 9.0 the calendar was a copy of the owner's private feed baked
// into the installer at build time. That put the calendar in every installer
// (9c9e7d2); links are fetched at runtime instead, so nothing personal is a
// build input. The rules (trust model S3):
//
// - https (`webcal:` is rewritten to https). A plain http link works but its
//   status carries a warning. Redirects are followed by hand, at most 5, and
//   never from https to http: the URL is a bearer secret for the whole
//   calendar.
// - a 20 s timeout and a 10 MB cap on the body. fetch() decompresses, so the
//   cap is measured after decompression.
// - the last good copy is cached in userData, so a restart offline still has
//   a week to show, and a failed fetch keeps it.
// - the URL is never logged or returned; errors name only what went wrong.
//
// Parsing happens in the ICS worker (electron/icsparse-host.cjs).

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const TIMEOUT_MS = 20_000;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REFRESH_MS = 30 * 60 * 1000;

/** The URL to fetch, or null when it isn't one we will fetch. */
function normaliseUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  let u;
  try {
    u = new URL(text.replace(/^webcal:/i, 'https:'));
  } catch {
    return null;
  }
  return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
}

/** Read a response body, refusing it once it passes `max` bytes. */
async function readCapped(res, max, signal) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => {
        try { reader.cancel(); } catch { /* the stream may already be closed */ }
        reject(new Error('calendar body read aborted'));
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
    let result;
    try {
      result = await Promise.race([reader.read(), aborted]);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    const { done, value } = result;
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new Error(`calendar is larger than ${Math.round(max / 1024 / 1024)} MB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/** One fetch, following redirects by hand. Throws an error that never contains the URL. */
async function fetchIcs(url, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES, signal: outerSignal } = {}) {
  let current = url;
  const ctrl = new AbortController();
  const abortFromOuter = () => ctrl.abort();
  if (outerSignal?.aborted) ctrl.abort();
  else outerSignal?.addEventListener('abort', abortFromOuter, { once: true });
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (ctrl.signal.aborted) throw new Error(outerSignal?.aborted ? 'calendar fetch cancelled' : 'calendar fetch timed out');
      let res;
      try {
        res = await fetchImpl(current.href, { redirect: 'manual', signal: ctrl.signal });
      } catch (err) {
        if (outerSignal?.aborted) throw new Error('calendar fetch cancelled');
        throw new Error(ctrl.signal.aborted || (err && err.name === 'AbortError') ? 'calendar fetch timed out' : 'calendar fetch failed (network)');
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error(`calendar redirect ${res.status} without a location`);
        const next = new URL(loc, current);
        if (current.protocol === 'https:' && next.protocol !== 'https:') throw new Error('calendar redirected away from https; refused');
        if (next.protocol !== 'https:' && next.protocol !== 'http:') throw new Error('calendar redirected to an unsupported address; refused');
        current = next;
        continue;
      }
      if (!res.ok) throw new Error(`calendar fetch failed: HTTP ${res.status}`);
      let text;
      try {
        text = await readCapped(res, maxBytes, ctrl.signal);
      } catch (err) {
        if (outerSignal?.aborted) throw new Error('calendar fetch cancelled');
        if (ctrl.signal.aborted) throw new Error('calendar fetch timed out');
        throw err;
      }
      if (ctrl.signal.aborted) throw new Error(outerSignal?.aborted ? 'calendar fetch cancelled' : 'calendar fetch timed out');
      if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 2048))) throw new Error('calendar link did not return an iCalendar file');
      return text;
    }
    throw new Error('calendar fetch: too many redirects');
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', abortFromOuter);
  }
}

/**
 * The feed for one link. `start()` loads the cache and fetches; `text()` is
 * the newest good copy (or null). Nothing runs until start(), and stop()
 * clears the timer.
 */
const cacheOwners = new Map();

// Every change to one cache file (a feed's commit, a removal) runs in order on
// one chain per path. The ownership check and the rename sit inside the same
// step, so a rename already under way always lands before a later removal or a
// replacement feed's commit, never after it (Bug Log #89).
const cacheQueues = new Map();
function cacheKey(file) {
  const full = path.resolve(file);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}
function queueCacheOp(file, op) {
  const key = cacheKey(file);
  const run = (cacheQueues.get(key) || Promise.resolve()).then(op);
  const tail = run.catch(() => {});
  cacheQueues.set(key, tail);
  tail.then(() => { if (cacheQueues.get(key) === tail) cacheQueues.delete(key); });
  return run;
}
/** Remove a cache file now, and again after any write already queued for it. */
function removeCache(file) {
  try { fs.rmSync(file, { force: true }); } catch { /* nothing cached */ }
  return queueCacheOp(file, () => fsp.rm(file, { force: true })).catch(() => {});
}
function makeIcsFeed({ url, cacheFile, log = console.log, fetchImpl, validate = () => {}, refreshMs = REFRESH_MS, onChange = () => {} }) {
  const target = normaliseUrl(url);
  let text = null;
  let fetchedAt = null;
  let lastError = target ? null : url ? 'calendar link is not an https, http or webcal URL' : null;
  const warning = target && target.protocol === 'http:' ? 'This link is not encrypted (http). Use https if your calendar offers it.' : null;
  let timer = null;
  let inFlight = null;
  let controller = null;
  let generation = 0;
  let running = false;
  let paused = false;
  let intervalMs = refreshMs;
  const cacheToken = {};
  if (cacheFile) cacheOwners.set(cacheFile, cacheToken);
  let disposed = false;

  function arm() {
    if (timer) clearInterval(timer);
    timer = running && !paused ? setInterval(refresh, intervalMs) : null;
  }

  async function refresh() {
    if (!target || paused || disposed) return;
    if (inFlight) return inFlight;
    const op = ++generation;
    const opController = new AbortController();
    controller = opController;
    inFlight = (async () => {
      try {
        const next = await fetchIcs(target, { fetchImpl, signal: opController.signal });
        await validate(next);
        if (op !== generation || disposed) return;
        const changed = next !== text;
        text = next;
        fetchedAt = Date.now();
        const recovered = lastError != null;
        lastError = null;
        if (cacheFile && cacheOwners.get(cacheFile) === cacheToken) {
          const tmp = `${cacheFile}.${randomUUID()}.tmp`;
          try {
            await fsp.writeFile(tmp, next, { encoding: 'utf8', flag: 'wx' });
            await queueCacheOp(cacheFile, async () => {
              if (op === generation && !disposed && cacheOwners.get(cacheFile) === cacheToken) await fsp.rename(tmp, cacheFile);
            });
          } finally {
            // Each feed owns a unique, exclusively-created temp file, so stale
            // work can never remove a replacement feed's pending cache write.
            await fsp.rm(tmp, { force: true }).catch(() => {});
          }
        }
        if ((changed || recovered) && op === generation && !disposed) onChange();
      } catch (err) {
        if (op !== generation || disposed || (err.message === 'calendar fetch cancelled')) return;
        const changed = lastError !== err.message;
        lastError = err.message;
        log(`[wd] ics: ${err.message} (keeping the last good copy)`);
        if (changed) onChange();
      } finally {
        if (op === generation) {
          inFlight = null;
          controller = null;
        }
      }
    })();
    return inFlight;
  }

  return {
    configured: !!target,
    start() {
      if (!target || disposed) return;
      if (running) return;
      running = true;
      if (cacheFile && text == null) {
        try {
          text = fs.readFileSync(cacheFile, 'utf8');
          fetchedAt = fs.statSync(cacheFile).mtimeMs;
        } catch {
          // no cache yet
        }
      }
      refresh();
      arm();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      running = false;
      generation++;
      if (controller) controller.abort();
      controller = null;
      inFlight = null;
      disposed = true;
      if (cacheFile && cacheOwners.get(cacheFile) === cacheToken) cacheOwners.delete(cacheFile);
    },
    pause() { if (paused) return; paused = true; arm(); generation++; if (controller) controller.abort(); controller = null; inFlight = null; },
    resume() { if (!paused) return Promise.resolve(); paused = false; if (running) { const run = refresh(); arm(); return run; } },
    setRefreshMs(ms) { intervalMs = ms; arm(); },
    refresh,
    text: () => text,
    status: () => ({ configured: !!target, fetchedAt, lastError, warning }),
  };
}

module.exports = { makeIcsFeed, normaliseUrl, fetchIcs, removeCache, MAX_BYTES };
