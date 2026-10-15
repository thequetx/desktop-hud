import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// The events slot (Phase 9.4): electron/calsources.cjs and the ICS worker's
// host, electron/icsparse-host.cjs. The worker is stood in for by an
// in-process fake that runs the real parser, or one that never answers.

const require_ = createRequire(import.meta.url);
const { makeCalendarSources, normaliseSources, windowFor } = require_('../electron/calsources.cjs') as any;
const { makeParserHost } = require_('../electron/icsparse-host.cjs') as any;
const { parseIcs } = require_('../electron/icsparse.cjs') as any;

/** A utilityProcess stand-in. `mode` 'ok' parses in-process; 'hang' never answers. */
function fakeFork(mode: { value: 'ok' | 'hang'; delay?: number }) {
  const spawned: any[] = [];
  const fork = () => {
    const child: any = new EventEmitter();
    child.killed = false;
    // A real worker exits a moment after it is killed.
    child.kill = () => {
      child.killed = true;
      setTimeout(() => child.emit('exit', 1), 5);
    };
    child.postMessage = ({ id, text, minMs, maxMs }: any) => {
      if (mode.value === 'hang') return;
      setTimeout(() => {
        try {
          const r = parseIcs(text, minMs, maxMs);
          child.emit('message', { id, ok: true, events: r.events, truncated: r.truncated });
        } catch {
          child.emit('message', { id, ok: false, error: 'the calendar file could not be read' });
        }
      }, mode.delay ?? 0);
    };
    spawned.push(child);
    return child;
  };
  return { fork, spawned };
}

const NOW = Date.parse('2026-10-15T03:00:00Z');
const ev = (uid: string, title: string, start: string, end: string) =>
  `BEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${title}\r\nDTSTART:${start}\r\nDTEND:${end}\r\nEND:VEVENT`;
const cal = (...e: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...e, 'END:VCALENDAR'].join('\r\n');
const A = cal(ev('a1', 'Dentist', '20261015T220000Z', '20261015T230000Z'), ev('shared', 'Team sync', '20261016T000000Z', '20261016T010000Z'));
const B = cal(ev('b1', 'Gym', '20261016T200000Z', '20261016T210000Z'), ev('other-uid', 'Team sync', '20261016T000000Z', '20261016T010000Z'));
const LINK_A = 'https://cal.example.com/a/private-secret.ics';
const LINK_B = 'https://cal.example.com/b/private-secret.ics';

describe('makeParserHost — the idle worker stops (Phase 9.6)', () => {
  it('stops after idleMs without parses, and starts again for the next one', async () => {
    const f = fakeFork({ value: 'ok' });
    const host = makeParserHost({ fork: f.fork, idleMs: 40 });
    expect((await host.parse(A, 0, NOW * 2)).ok).toBe(true);
    expect(host.alive).toBe(true);
    await new Promise((r) => setTimeout(r, 80));
    expect(host.alive).toBe(false);
    expect(f.spawned[0].killed).toBe(true);
    expect((await host.parse(A, 0, NOW * 2)).ok).toBe(true);
    expect(f.spawned).toHaveLength(2);
    host.stop();
  });
});

describe('makeParserHost — the time limit', () => {
  it('parses through the worker', async () => {
    const host = makeParserHost({ fork: fakeFork({ value: 'ok' }).fork });
    const r = await host.parse(A, NOW - 864e5, NOW + 7 * 864e5);
    expect(r.ok).toBe(true);
    expect(r.events.map((e: any) => e.uid)).toEqual(['a1', 'shared']);
  });

  it('kills a worker that runs past the limit, fails that parse, and recovers', async () => {
    const mode = { value: 'hang' as 'ok' | 'hang' };
    const f = fakeFork(mode);
    const logs: string[] = [];
    const host = makeParserHost({ fork: f.fork, timeLimitMs: 50, log: (m: string) => logs.push(m) });
    const r = await host.parse(A, 0, NOW * 2);
    expect(r).toMatchObject({ ok: false, error: 'the calendar took too long to read' });
    expect(f.spawned[0].killed).toBe(true);
    expect(logs.join(' ')).not.toContain('secret');
    mode.value = 'ok';
    expect((await host.parse(A, 0, NOW * 2)).ok).toBe(true);
    expect(f.spawned).toHaveLength(2);
  });

  it('the killed worker exiting late does not fail the next parse on its replacement', async () => {
    const mode: { value: 'ok' | 'hang'; delay?: number } = { value: 'hang' };
    const f = fakeFork(mode);
    const host = makeParserHost({ fork: f.fork, timeLimitMs: 30, log: () => {} });
    const first = host.parse(A, 0, NOW * 2);
    const second = host.parse(B, 0, NOW * 2);
    expect((await first).ok).toBe(false);
    mode.value = 'ok';
    mode.delay = 25; // the replacement answers after the old worker's exit (5 ms)
    const r = await second;
    expect(f.spawned).toHaveLength(2);
    expect(r.ok).toBe(true);
  });
});

describe('makeCalendarSources', () => {
  let dir: string;
  let stored: any[];
  let secrets: Record<string, string>;
  let changes: number;
  let fetched: string[];

  const routes: Record<string, string> = { [LINK_A]: A, [LINK_B]: B };
  const fetchImpl = async (url: string) => {
    fetched.push(url);
    if (!routes[url]) throw new TypeError('fetch failed');
    return new Response(routes[url]);
  };

  function make(fork = fakeFork({ value: 'ok' }).fork) {
    return makeCalendarSources({
      dir,
      getSources: () => stored,
      saveSources: (s: any[]) => {
        stored = s;
      },
      urlFor: (id: string) => secrets[id] ?? null,
      setUrl: (id: string, url: string) => {
        secrets[id] = url;
        return { ok: true };
      },
      deleteUrl: (id: string) => {
        delete secrets[id];
        return { ok: true };
      },
      parser: makeParserHost({ fork }),
      log: () => {},
      onChange: () => {
        changes++;
      },
      fetchImpl,
      now: () => NOW,
    });
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'dhud-cal-'));
    stored = [];
    secrets = {};
    changes = 0;
    fetched = [];
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const range = ['2026-10-12T00:00:00.000Z', '2026-10-20T00:00:00.000Z'];

  it('starts empty: no sources, no events, nothing fetched', async () => {
    const s = make();
    await s.start();
    expect(s.list()).toEqual([]);
    expect(s.eventsInRange(range[0], range[1])).toEqual([]);
    expect(fetched).toEqual([]);
    s.stop();
  });

  it('adds two links, merges them, and shows the same meeting once', async () => {
    const s = make();
    await s.start();
    const a = await s.add({ kind: 'ics-url', name: 'Home', url: LINK_A });
    const b = await s.add({ kind: 'ics-url', name: 'Work', url: LINK_B });
    expect(a.ok && b.ok).toBe(true);
    // The URLs went to the secret store only.
    expect(JSON.stringify(stored)).not.toContain('private-secret');
    expect(JSON.stringify(s.list())).not.toContain('private-secret');
    const evs = s.eventsInRange(range[0], range[1]);
    expect(evs.map((e: any) => e.title)).toEqual(['Dentist', 'Team sync', 'Gym']);
    expect(evs[0]).toMatchObject({ uid: `${a.id}:a1`, sourceId: a.id });
    expect(s.list().map((x: any) => [x.name, x.count, x.lastError])).toEqual([
      ['Home', 2, null],
      ['Work', 2, null],
    ]);
    s.stop();
  });

  it('merges a provider’s events and lets them win a duplicate', async () => {
    const s = make();
    await s.start();
    await s.add({ kind: 'ics-url', name: 'Home', url: LINK_A });
    const google = [{ uid: 'g1', sourceId: 'google', title: 'Team sync', start: '2026-10-16T00:00:00.000Z', end: '2026-10-16T01:00:00.000Z', allDay: false }];
    const evs = s.eventsInRange(range[0], range[1], google);
    expect(evs.filter((e: any) => e.title === 'Team sync')).toEqual(google);
    s.stop();
  });

  it('refuses a link that is not a calendar link, and stores nothing', async () => {
    const s = make();
    await s.start();
    expect(await s.add({ kind: 'ics-url', name: 'x', url: 'file:///C:/x.ics' })).toMatchObject({ ok: false });
    expect(stored).toEqual([]);
    expect(secrets).toEqual({});
    s.stop();
  });

  it('removes a source with its secret and its cache', async () => {
    const s = make();
    await s.start();
    const a = await s.add({ kind: 'ics-url', name: 'Home', url: LINK_A });
    expect(s.remove(a.id).ok).toBe(true);
    expect(stored).toEqual([]);
    expect(secrets).toEqual({});
    expect(s.eventsInRange(range[0], range[1])).toEqual([]);
    s.stop();
  });

  it('reads a picked file and re-reads it when it changes', async () => {
    const file = path.join(dir, 'term.ics');
    await writeFile(file, A);
    const s = make();
    await s.start();
    const f = await s.add({ kind: 'ics-file', name: 'Term', file });
    expect(s.eventsInRange(range[0], range[1])).toHaveLength(2);
    expect(s.list()[0]).toMatchObject({ kind: 'ics-file', file: 'term.ics', count: 2 });
    await writeFile(file, B);
    const later = new Date(Date.now() + 5000);
    await import('node:fs/promises').then((m) => m.utimes(file, later, later));
    await s.refresh(f.id);
    expect(s.eventsInRange(range[0], range[1]).map((e: any) => e.title)).toEqual(['Team sync', 'Gym']);
    s.stop();
  });

  it('keeps the last good events when a refresh fails, and says why', async () => {
    const s = make();
    await s.start();
    const a = await s.add({ kind: 'ics-url', name: 'Home', url: LINK_A });
    routes[LINK_A] = '';
    delete routes[LINK_A];
    await s.refresh(a.id);
    expect(s.eventsInRange(range[0], range[1])).toHaveLength(2);
    expect(s.list()[0].lastError).toMatch(/network/);
    routes[LINK_A] = A;
    s.stop();
  });

  it('a hostile calendar fails with an error and leaves the others working', async () => {
    const mode = { value: 'ok' as 'ok' | 'hang' };
    const f = fakeFork(mode);
    const s = makeCalendarSources({
      dir,
      getSources: () => stored,
      saveSources: (x: any[]) => {
        stored = x;
      },
      urlFor: (id: string) => secrets[id] ?? null,
      setUrl: (id: string, url: string) => {
        secrets[id] = url;
        return { ok: true };
      },
      deleteUrl: () => ({ ok: true }),
      parser: makeParserHost({ fork: f.fork, timeLimitMs: 50 }),
      log: () => {},
      fetchImpl,
      now: () => NOW,
    });
    await s.start();
    await s.add({ kind: 'ics-url', name: 'Home', url: LINK_A });
    mode.value = 'hang';
    await s.add({ kind: 'ics-url', name: 'Hostile', url: LINK_B });
    mode.value = 'ok';
    const [home, hostile] = s.list();
    expect(home).toMatchObject({ count: 2, lastError: null });
    expect(hostile.lastError).toMatch(/too long/);
    expect(s.eventsInRange(range[0], range[1]).map((e: any) => e.title)).toEqual(['Dentist', 'Team sync']);
    s.stop();
  });

  it('starts sources already in config, from their cache, before any fetch lands', async () => {
    stored = [{ id: 'link', kind: 'ics-url', name: 'Calendar' }];
    secrets = { link: LINK_A };
    await import('node:fs/promises').then(async (m) => {
      await m.mkdir(path.join(dir, 'cal-cache'), { recursive: true });
      await m.writeFile(path.join(dir, 'cal-cache', 'link.ics'), B);
    });
    delete routes[LINK_A];
    const s = make();
    await s.start();
    expect(s.eventsInRange(range[0], range[1]).map((e: any) => e.title)).toEqual(['Team sync', 'Gym']);
    routes[LINK_A] = A;
    s.stop();
  });
});

describe('normaliseSources and the window', () => {
  it('drops unknown kinds, bad ids, duplicates and relative file paths', () => {
    expect(
      normaliseSources([
        { id: 'cal1', kind: 'ics-url', name: 'A' },
        { id: 'cal1', kind: 'ics-url', name: 'dup' },
        { id: 'Bad Id', kind: 'ics-url' },
        { id: 'x1', kind: 'caldav' },
        { id: 'file1', kind: 'ics-file', path: 'relative.ics' },
        { id: 'file2', kind: 'ics-file', path: 'C:\\cal\\term.ics', name: '' },
        null,
      ]),
    ).toEqual([
      { id: 'cal1', kind: 'ics-url', name: 'A' },
      { id: 'file2', kind: 'ics-file', name: 'Calendar', path: 'C:\\cal\\term.ics' },
    ]);
  });

  it('parses thirteen weeks back (streak levels) to three ahead, from Monday', () => {
    const w = windowFor(NOW);
    const monday = new Date(w.minMs + 13 * 7 * 864e5);
    expect(monday.getDay()).toBe(1);
    expect(monday.getHours()).toBe(0);
    expect((w.maxMs - w.minMs) / (7 * 864e5)).toBe(16);
  });
});
