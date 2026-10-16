import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { makeIcsFeed, normaliseUrl, fetchIcs } = require_('../electron/icsfeed.cjs') as any;

const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';
const SECRET = 'https://calendar.example.com/calendar/ical/me/private-0123456789abcdef/basic.ics';

/** A fetch stand-in: `routes` maps a URL to a Response or a function. */
function fakeFetch(routes: Record<string, Response | (() => Response)>) {
  const seen: string[] = [];
  const impl = async (url: string) => {
    seen.push(url);
    const r = routes[url];
    if (!r) throw new TypeError('fetch failed');
    return typeof r === 'function' ? r() : r;
  };
  return { impl, seen };
}

describe('normaliseUrl — which links are fetched at all', () => {
  it('accepts https and rewrites webcal to https', () => {
    expect(normaliseUrl(SECRET)?.href).toBe(SECRET);
    expect(normaliseUrl('webcal://cal.example.com/a.ics')?.href).toBe('https://cal.example.com/a.ics');
  });
  it('accepts plain http (its status warns), refuses file and junk', () => {
    expect(normaliseUrl('http://cal.example.com/a.ics')?.href).toBe('http://cal.example.com/a.ics');
    const feed = makeIcsFeed({ url: 'http://cal.example.com/a.ics' });
    expect(feed.status().warning).toMatch(/not encrypted/);
    expect(makeIcsFeed({ url: SECRET }).status().warning).toBeNull();
    expect(normaliseUrl('file:///C:/x.ics')).toBeNull();
    expect(normaliseUrl('not a url')).toBeNull();
    expect(normaliseUrl('')).toBeNull();
  });
});

describe('fetchIcs — the safety rules (trust model S3)', () => {
  it('returns an iCalendar body', async () => {
    const { impl } = fakeFetch({ [SECRET]: new Response(ICS) });
    expect(await fetchIcs(new URL(SECRET), { fetchImpl: impl })).toBe(ICS);
  });

  it('follows an https redirect but refuses one to http', async () => {
    const ok = fakeFetch({
      [SECRET]: new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/b.ics' } }),
      'https://cdn.example.com/b.ics': new Response(ICS),
    });
    expect(await fetchIcs(new URL(SECRET), { fetchImpl: ok.impl })).toBe(ICS);

    const bad = fakeFetch({
      [SECRET]: new Response(null, { status: 302, headers: { location: 'http://cdn.example.com/b.ics' } }),
    });
    await expect(fetchIcs(new URL(SECRET), { fetchImpl: bad.impl })).rejects.toThrow(/away from https/);
    expect(bad.seen).toEqual([SECRET]); // never requested the http URL
  });

  it('stops after five redirects', async () => {
    const loop = fakeFetch({ [SECRET]: () => new Response(null, { status: 302, headers: { location: SECRET } }) });
    await expect(fetchIcs(new URL(SECRET), { fetchImpl: loop.impl })).rejects.toThrow(/too many redirects/);
  });

  it('refuses a body over the cap, and one that is not iCalendar', async () => {
    const big = fakeFetch({ [SECRET]: new Response('BEGIN:VCALENDAR\n' + 'x'.repeat(2000)) });
    await expect(fetchIcs(new URL(SECRET), { fetchImpl: big.impl, maxBytes: 1000 })).rejects.toThrow(/larger than/);
    const html = fakeFetch({ [SECRET]: new Response('<html>sign in</html>') });
    await expect(fetchIcs(new URL(SECRET), { fetchImpl: html.impl })).rejects.toThrow(/did not return an iCalendar/);
  });

  it('keeps the timeout through a stalled response body', async () => {
    const never = new ReadableStream<Uint8Array>({ start() {} });
    const { impl } = fakeFetch({ [SECRET]: new Response(never) });
    await expect(fetchIcs(new URL(SECRET), { fetchImpl: impl, timeoutMs: 25 })).rejects.toThrow(/timed out/);
  });

  it('never puts the URL in an error', async () => {
    const cases = [
      fakeFetch({}), // network
      fakeFetch({ [SECRET]: new Response('nope', { status: 404 }) }),
      fakeFetch({ [SECRET]: new Response(null, { status: 302, headers: { location: 'http://x.example/private-abc' } }) }),
    ];
    for (const c of cases) {
      const err = await fetchIcs(new URL(SECRET), { fetchImpl: c.impl }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(String(err.message)).not.toMatch(/private-|calendar\.example\.com|x\.example/);
    }
  });
});

describe('makeIcsFeed — cache and refresh', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wd-icsfeed-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('does nothing without a usable link', () => {
    const feed = makeIcsFeed({ url: 'ftp://insecure.example/a.ics', cacheFile: path.join(dir, 'c.ics'), log: () => {} });
    expect(feed.configured).toBe(false);
    feed.start();
    expect(feed.text()).toBeNull();
    expect(feed.status().lastError).toMatch(/not an https/);
    feed.stop();
  });

  it('fetches, caches, and keeps the last good copy when a refresh fails', async () => {
    const cacheFile = path.join(dir, 'c.ics');
    let fail = false;
    const { impl } = fakeFetch({ [SECRET]: () => (fail ? new Response('down', { status: 503 }) : new Response(ICS)) });
    const logs: string[] = [];
    const feed = makeIcsFeed({ url: SECRET, cacheFile, fetchImpl: impl, log: (m: string) => logs.push(m) });
    await feed.refresh();
    expect(feed.text()).toBe(ICS);
    expect(await readFile(cacheFile, 'utf8')).toBe(ICS);

    fail = true;
    await feed.refresh();
    expect(feed.text()).toBe(ICS);
    expect(feed.status().lastError).toMatch(/HTTP 503/);
    expect(logs.join('\n')).not.toContain('private-');
    feed.stop();
  });

  it('tells the windows when the text changes, and only then', async () => {
    let body = ICS;
    const { impl } = fakeFetch({ [SECRET]: () => new Response(body) });
    let changes = 0;
    const feed = makeIcsFeed({ url: SECRET, cacheFile: path.join(dir, 'c.ics'), fetchImpl: impl, log: () => {}, onChange: () => changes++ });
    await feed.refresh();
    await feed.refresh();
    expect(changes).toBe(1);
    body = ICS.replace('VERSION:2.0', 'VERSION:2.0\r\nX-WR-CALNAME:new');
    await feed.refresh();
    expect(changes).toBe(2);
    feed.stop();
  });

  it('notifies on error and recovery even when the successful text is unchanged', async () => {
    let fail = false;
    let changes = 0;
    const { impl } = fakeFetch({ [SECRET]: () => fail ? new Response('down', { status: 503 }) : new Response(ICS) });
    const feed = makeIcsFeed({ url: SECRET, fetchImpl: impl, log: () => {}, onChange: () => changes++ });
    await feed.refresh();
    expect(changes).toBe(1);
    fail = true;
    await feed.refresh();
    expect(feed.status().lastError).toMatch(/HTTP 503/);
    expect(changes).toBe(2);
    await feed.refresh();
    expect(changes).toBe(2);
    fail = false;
    await feed.refresh();
    expect(feed.status().lastError).toBeNull();
    expect(changes).toBe(3);
    feed.stop();
  });

  it('starts from the cache before the first fetch lands', async () => {
    const cacheFile = path.join(dir, 'c.ics');
    await writeFile(cacheFile, ICS, 'utf8');
    const { impl } = fakeFetch({}); // offline
    const feed = makeIcsFeed({ url: SECRET, cacheFile, fetchImpl: impl, log: () => {} });
    feed.start();
    expect(feed.text()).toBe(ICS);
    await feed.refresh();
    expect(feed.text()).toBe(ICS);
    feed.stop();
  });

  it('is idempotent across repeated starts and cancels a request on stop', async () => {
    let calls = 0;
    const feed = makeIcsFeed({
      url: SECRET,
      fetchImpl: async (_url: string, { signal }: { signal: AbortSignal }) => {
        calls++;
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
      },
      refreshMs: 10,
      log: () => {},
    });
    feed.start();
    feed.start();
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toBe(1);
    feed.stop();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
    expect(feed.text()).toBeNull();
  });
});
