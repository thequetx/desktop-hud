'use strict';
// The events slot (Phase 9.4): any number of calendar sources, merged.
//
// A source is `{ id, kind, name }` in config.json `calendar.sources`:
// - `ics-url`: a calendar link. The URL is a bearer secret for the whole
//   calendar, so it lives in secrets.bin (`urlFor(id)`), is never logged and
//   never goes back to a window.
// - `ics-file`: a .ics file the user picked with the file dialog.
//
// Each source is fetched or read here, in main, with the S3 limits
// (electron/icsfeed.cjs), cached in userData (`cal-cache/<id>.ics`) so a
// restart offline still has a week, and parsed in the ICS worker
// (electron/icsparse-host.cjs). Parsed events cover a fixed window around
// this week, wide enough for streak levels (twelve weeks back), and are
// re-parsed when the text changes or the week turns.
//
// A calendar provider from an add-on (Google, Phase 9.3) is merged in by the
// caller. Events are deduplicated per source on uid and start, and across
// sources on title and times, so the same meeting in two calendars shows once.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { makeIcsFeed } = require('./icsfeed.cjs');

const REFRESH_MS = 15 * 60 * 1000;
const BATTERY_REFRESH_MS = 60 * 60 * 1000;
const FILE_CHECK_MS = 60 * 1000;
const BATTERY_FILE_CHECK_MS = 5 * 60 * 1000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SOURCES = 20;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const KINDS = ['ics-url', 'ics-file'];

/** Monday 00:00 local of the week holding `ms`. */
function weekStartMs(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/** The parse window around `now`: 13 weeks back, 3 weeks ahead. */
function windowFor(now) {
  const ws = weekStartMs(now);
  return { minMs: ws - 13 * WEEK_MS, maxMs: ws + 3 * WEEK_MS };
}

/** Sources as stored, cleaned: known kinds, valid unique ids, a name. */
function normaliseSources(raw) {
  const out = [];
  const seen = new Set();
  for (const s of Array.isArray(raw) ? raw : []) {
    if (!s || typeof s !== 'object' || !KINDS.includes(s.kind) || !ID_RE.test(String(s.id)) || seen.has(s.id)) continue;
    seen.add(s.id);
    const src = { id: s.id, kind: s.kind, name: String(s.name || 'Calendar').slice(0, 60) };
    if (s.kind === 'ics-file') {
      if (typeof s.path !== 'string' || !path.isAbsolute(s.path)) continue;
      src.path = s.path;
    }
    out.push(src);
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

/** A local .ics the user picked: read with a size cap, re-read when it changes. */
function makeFileFeed({ file, onChange = () => {} }) {
  let text = null;
  let mtime = 0;
  let lastError = null;
  let fetchedAt = null;
  let timer = null;
  let running = false;
  let paused = false;
  let intervalMs = FILE_CHECK_MS;
  let generation = 0;
  let inFlight = null;
  function arm() {
    if (timer) clearInterval(timer);
    timer = running && !paused ? setInterval(refresh, intervalMs) : null;
  }
  async function refresh() {
    if (paused) return;
    if (inFlight) return inFlight;
    const op = ++generation;
    inFlight = (async () => { try {
      const st = await fsp.stat(file);
      if (op !== generation || paused) return;
      if (!st.isFile()) throw new Error('not a file');
      if (st.size > MAX_FILE_BYTES) throw new Error(`calendar file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
      if (st.mtimeMs === mtime && text != null) {
        if (lastError) { lastError = null; onChange(); }
        return;
      }
      const next = await fsp.readFile(file, 'utf8');
      if (op !== generation || paused) return;
      if (!/BEGIN:VCALENDAR/i.test(next.slice(0, 2048))) throw new Error('that file is not an iCalendar file');
      mtime = st.mtimeMs;
      fetchedAt = Date.now();
      const recovered = lastError != null;
      lastError = null;
      const changed = next !== text;
      text = next;
      if (changed || recovered) onChange();
    } catch (err) {
      if (op !== generation || paused) return;
      const changed = lastError !== (err.code === 'ENOENT' ? 'the calendar file is missing' : err.message);
      lastError = err.code === 'ENOENT' ? 'the calendar file is missing' : err.message;
      if (changed) onChange();
    } })().finally(() => { if (op === generation) inFlight = null; });
    return inFlight;
  }
  return {
    configured: true,
    start() {
      if (running) return;
      running = true;
      refresh();
      arm();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      running = false;
      generation++;
      inFlight = null;
    },
    pause() { if (paused) return; paused = true; generation++; inFlight = null; arm(); },
    resume() { if (!paused) return Promise.resolve(); paused = false; if (running) { const run = refresh(); arm(); return run; } },
    setRefreshMs(ms) { intervalMs = ms; arm(); },
    refresh,
    text: () => text,
    status: () => ({ configured: true, fetchedAt, lastError }),
  };
}

function makeCalendarSources({
  dir,
  getSources,
  saveSources,
  urlFor,
  setUrl,
  deleteUrl,
  parser,
  log = console.log,
  onChange = () => {},
  fetchImpl,
  now = () => Date.now(),
  refreshMs = REFRESH_MS,
  fileCheckMs = FILE_CHECK_MS,
  batteryRefreshMs = BATTERY_REFRESH_MS,
  batteryFileCheckMs = BATTERY_FILE_CHECK_MS,
}) {
  const cacheDir = path.join(dir, 'cal-cache');
  /** id -> { src, feed, parsed: { text, minMs, events, truncated, error } } */
  const live = new Map();
  let started = false;
  let startPromise = null;
  let paused = false;
  let batterySaver = false;

  function feedFor(src) {
    const changed = () => reparse(src.id).then(() => onChange());
    if (src.kind === 'ics-file') return makeFileFeed({ file: src.path, onChange: changed });
    return makeIcsFeed({
      url: urlFor(src.id),
      cacheFile: path.join(cacheDir, `${src.id}.ics`),
      log,
      fetchImpl,
      refreshMs,
      validate: async (text) => {
        const result = await parser.parse(text, windowFor(now()).minMs, windowFor(now()).maxMs);
        if (!result.ok) throw new Error(result.error || 'the calendar file could not be read');
      },
      onChange: changed,
    });
  }

  function open(src) {
    const entry = { src, feed: feedFor(src), parsed: null, parsing: null };
    live.set(src.id, entry);
    if (started) {
      fs.mkdirSync(cacheDir, { recursive: true });
      if (paused) entry.feed.pause();
      entry.feed.start();
      entry.feed.setRefreshMs(src.kind === 'ics-file' ? (batterySaver ? batteryFileCheckMs : fileCheckMs) : (batterySaver ? batteryRefreshMs : refreshMs));
      reparse(src.id).then(() => onChange());
    }
    return entry;
  }

  function close(id) {
    const e = live.get(id);
    if (!e) return;
    e.feed.stop();
    live.delete(id);
  }

  /** Parse a source's newest text for the current window, if either changed. */
  async function reparse(id) {
    const e = live.get(id);
    if (!e) return;
    const text = e.feed.text();
    const win = windowFor(now());
    if (!text) {
      const had = e.parsed != null;
      e.parsed = null;
      return had;
    }
    if (e.parsed && e.parsed.text === text && e.parsed.minMs === win.minMs) return false;
    if (e.parsing) return e.parsing;
    e.parsing = (async () => {
      const r = await parser.parse(text, win.minMs, win.maxMs);
      if (!live.has(id) || live.get(id) !== e) return false;
      if (r.ok) {
        e.parsed = { text, minMs: win.minMs, events: r.events.map((ev) => tag(ev, id)), truncated: r.truncated || null, error: null };
        if (r.truncated) log(`[wd] ics: ${e.src.name}: hit the ${r.truncated} cap; showing what fit`);
      } else {
        // Keep the last good events and show the error.
        e.parsed = { ...(e.parsed || { events: [], truncated: null }), text, minMs: win.minMs, error: r.error };
      }
      return true;
    })().finally(() => {
      e.parsing = null;
    });
    return e.parsing;
  }

  const tag = (ev, sourceId) => ({ ...ev, uid: `${sourceId}:${ev.uid}`, sourceId });

  function status(e) {
    const s = e.feed.status();
    const p = e.parsed;
    return {
      id: e.src.id,
      kind: e.src.kind,
      name: e.src.name,
      configured: s.configured,
      fetchedAt: s.fetchedAt,
      lastError: s.lastError || (p && p.error) || null,
      warning: s.warning || (p && p.truncated ? `This calendar is very large; only part of it is shown (${p.truncated} limit)` : null),
      count: p ? p.events.length : 0,
      ...(e.src.kind === 'ics-file' ? { file: path.basename(e.src.path) } : {}),
    };
  }

  function newId(kind) {
    const base = kind === 'ics-file' ? 'file' : 'cal';
    for (let i = 1; ; i++) {
      const id = `${base}${i}`;
      if (!live.has(id) && !getSources().some((s) => s.id === id)) return id;
    }
  }

  return {
    start() {
      if (started) return startPromise || Promise.resolve();
      started = true;
      fs.mkdirSync(cacheDir, { recursive: true });
      for (const src of normaliseSources(getSources())) open(src);
      for (const e of live.values()) {
        if (paused) e.feed.pause();
        e.feed.start();
        e.feed.setRefreshMs(e.src.kind === 'ics-file' ? (batterySaver ? batteryFileCheckMs : fileCheckMs) : (batterySaver ? batteryRefreshMs : refreshMs));
      }
      startPromise = Promise.all([...live.keys()].map(reparse)).then(() => onChange()).finally(() => { startPromise = null; });
      return startPromise;
    },
    stop() {
      if (!started && live.size === 0) return;
      started = false;
      for (const id of [...live.keys()]) close(id);
      parser.stop();
    },
    setPaused(value) {
      const next = !!value;
      if (paused === next) return;
      paused = next;
      const transitions = [...live.values()].map((e) => next ? e.feed.pause() : e.feed.resume());
      if (!next && started) return Promise.all(transitions).then(() => Promise.all([...live.keys()].map(reparse))).then(() => onChange());
    },
    setBatterySaver(value) {
      batterySaver = !!value;
      for (const e of live.values()) e.feed.setRefreshMs(e.src.kind === 'ics-file' ? (batterySaver ? batteryFileCheckMs : fileCheckMs) : (batterySaver ? batteryRefreshMs : refreshMs));
    },
    list: () => [...live.values()].map(status),
    async add({ kind, name, url, file }) {
      if (!KINDS.includes(kind)) return { ok: false, error: 'unknown calendar kind' };
      if (live.size >= MAX_SOURCES) return { ok: false, error: `at most ${MAX_SOURCES} calendars` };
      const id = newId(kind);
      const src = { id, kind, name: String(name || '').trim().slice(0, 60) || (kind === 'ics-file' ? 'Calendar file' : 'Calendar') };
      if (kind === 'ics-url') {
        const { normaliseUrl } = require('./icsfeed.cjs');
        if (!normaliseUrl(url)) return { ok: false, error: 'That is not a calendar link (https, http or webcal)' };
        const saved = setUrl(id, String(url).trim());
        if (!saved.ok) return { ok: false, error: saved.reason };
      } else {
        if (typeof file !== 'string' || !path.isAbsolute(file)) return { ok: false, error: 'no file chosen' };
        src.path = file;
      }
      saveSources([...normaliseSources(getSources()), src]);
      const e = open(src);
      await e.feed.refresh();
      await reparse(id);
      onChange();
      return { ok: true, id, status: status(e) };
    },
    remove(id) {
      if (!live.has(id)) return { ok: false, error: 'no such calendar' };
      const kind = live.get(id).src.kind;
      close(id);
      saveSources(normaliseSources(getSources()).filter((s) => s.id !== id));
      if (kind === 'ics-url') deleteUrl(id);
      try {
        fs.rmSync(path.join(cacheDir, `${id}.ics`), { force: true });
      } catch {
        // nothing cached
      }
      onChange();
      return { ok: true };
    },
    rename(id, name) {
      const e = live.get(id);
      const clean = String(name || '').trim().slice(0, 60);
      if (!e || !clean) return { ok: false };
      e.src = { ...e.src, name: clean };
      saveSources(normaliseSources(getSources()).map((s) => (s.id === id ? { ...s, name: clean } : s)));
      onChange();
      return { ok: true };
    },
    /** Fetch or re-read one source, or all; then re-parse what changed. */
    async refresh(id) {
      if (paused || !started) return;
      const ids = id ? [id] : [...live.keys()];
      await Promise.all(ids.map(async (k) => {
        const e = live.get(k);
        if (!e) return;
        await e.feed.refresh();
        await reparse(k);
      }));
      onChange();
    },
    /** After sleep or the week turning: refetch stale links, re-parse for the
     *  new window. Tells the windows only when something changed (a new text
     *  already does, through the feed). Cheap enough for every trigger. */
    async catchUp(maxAgeMs) {
      if (paused || !started) return;
      if (maxAgeMs === undefined) maxAgeMs = batterySaver ? batteryRefreshMs : refreshMs;
      const t = now();
      const changed = await Promise.all([...live.entries()].map(async ([k, e]) => {
        const s = e.feed.status();
        if (e.src.kind === 'ics-url' && s.configured && (!s.fetchedAt || t - s.fetchedAt > maxAgeMs)) await e.feed.refresh();
        return reparse(k);
      }));
      if (changed.some(Boolean)) onChange();
    },
    /** Wire events from every source overlapping [minIso, maxIso], plus `extra` (a provider's). */
    eventsInRange(minIso, maxIso, extra = []) {
      const min = Date.parse(minIso);
      const max = Date.parse(maxIso);
      const out = [];
      const byId = new Set();
      const byTimes = new Set();
      const push = (ev) => {
        if (!ev) return;
        const s = Date.parse(ev.start);
        const e = Date.parse(ev.end);
        if (!(e >= min) || !(s <= max)) return;
        const k1 = `${ev.uid}|${s}`;
        const k2 = `${String(ev.title).trim().toLowerCase()}|${s}|${e}|${ev.allDay ? 1 : 0}`;
        if (byId.has(k1) || byTimes.has(k2)) return;
        byId.add(k1);
        byTimes.add(k2);
        out.push(ev);
      };
      for (const ev of extra) push(ev);
      for (const e of live.values()) for (const ev of e.parsed ? e.parsed.events : []) push(ev);
      return out.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    },
  };
}

module.exports = { makeCalendarSources, normaliseSources, windowFor, weekStartMs, MAX_SOURCES };
