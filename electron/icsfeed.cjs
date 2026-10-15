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
async function readCapped(res, max) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
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
async function fetchIcs(url, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(current.href, { redirect: 'manual', signal: ctrl.signal });
    } catch (err) {
      throw new Error(err && err.name === 'AbortError' ? 'calendar fetch timed out' : 'calendar fetch failed (network)');
    } finally {
      clearTimeout(timer);
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
    const text = await readCapped(res, maxBytes);
    if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 2048))) throw new Error('calendar link did not return an iCalendar file');
    return text;
  }
  throw new Error('calendar fetch: too many redirects');
}

/**
 * The feed for one link. `start()` loads the cache and fetches; `text()` is
 * the newest good copy (or null). Nothing runs until start(), and stop()
 * clears the timer.
 */
function makeIcsFeed({ url, cacheFile, log = console.log, fetchImpl, refreshMs = REFRESH_MS, onChange = () => {} }) {
  const target = normaliseUrl(url);
  let text = null;
  let fetchedAt = null;
  let lastError = target ? null : url ? 'calendar link is not an https, http or webcal URL' : null;
  const warning = target && target.protocol === 'http:' ? 'This link is not encrypted (http). Use https if your calendar offers it.' : null;
  let timer = null;
  let inFlight = null;

  async function refresh() {
    if (!target) return;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const next = await fetchIcs(target, { fetchImpl });
        const changed = next !== text;
        text = next;
        fetchedAt = Date.now();
        lastError = null;
        if (cacheFile) {
          await fsp.writeFile(`${cacheFile}.tmp`, next, 'utf8');
          await fsp.rename(`${cacheFile}.tmp`, cacheFile);
        }
        if (changed) onChange();
      } catch (err) {
        lastError = err.message;
        log(`[wd] ics: ${err.message} (keeping the last good copy)`);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  return {
    configured: !!target,
    start() {
      if (!target) return;
      if (cacheFile && text == null) {
        try {
          text = fs.readFileSync(cacheFile, 'utf8');
          fetchedAt = fs.statSync(cacheFile).mtimeMs;
        } catch {
          // no cache yet
        }
      }
      refresh();
      timer = setInterval(refresh, refreshMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    refresh,
    text: () => text,
    status: () => ({ configured: !!target, fetchedAt, lastError, warning }),
  };
}

module.exports = { makeIcsFeed, normaliseUrl, fetchIcs, MAX_BYTES };
