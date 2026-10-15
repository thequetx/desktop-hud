import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require_ = createRequire(import.meta.url);
const { isAppUrl, safeForLog } = require_('../electron/guards.cjs') as any;
const { fileFor, pageUrl } = require_('../electron/appprotocol.cjs') as any;

// A packaged install path with a space in it, like the real one.
const DIST = path.resolve('C:/Users/you/AppData/Local/Programs/Desktop HUD/resources/app.asar/dist');
// The app's pages load over app://hud/ since Phase 9.4.
const page = (rel: string) => `app://hud/${rel}`;
const filePage = (rel: string) => pathToFileURL(path.join(DIST, rel)).href;

describe('isAppUrl — which navigations a window may make', () => {
  const prod = { distDir: DIST, devOrigin: null };
  const dev = { distDir: DIST, devOrigin: 'http://127.0.0.1:5173' };

  it("allows the app's own pages, with a query or hash", () => {
    expect(isAppUrl(page('hud.html'), prod)).toBe(true);
    expect(isAppUrl(`${page('index.html')}?mode=settings#bubbles`, prod)).toBe(true);
  });

  it('no longer treats the same pages over file:// as the app’s (Phase 9.4)', () => {
    expect(isAppUrl(filePage('hud.html'), prod)).toBe(false);
  });

  it('only the hud host', () => {
    expect(isAppUrl('app://other/hud.html', prod)).toBe(false);
  });

  it('refuses web pages, other schemes and other local files', () => {
    expect(isAppUrl('https://example.com/', prod)).toBe(false);
    expect(isAppUrl('http://127.0.0.1:5173/hud.html', prod)).toBe(false); // dev origin only in dev
    expect(isAppUrl('obsidian://open?vault=x', prod)).toBe(false);
    expect(isAppUrl('javascript:alert(1)', prod)).toBe(false);
    expect(isAppUrl(pathToFileURL('C:/Windows/win.ini').href, prod)).toBe(false);
    expect(isAppUrl('not a url', prod)).toBe(false);
  });

  it('cannot be escaped with .. or a sibling folder that shares the prefix', () => {
    // The URL parser collapses .. before the path is resolved: these stay in dist.
    expect(fileFor(`${page('')}../../secrets.html`, DIST)).toBe(path.join(DIST, 'secrets.html'));
    expect(fileFor('app://hud/%2e%2e/%2e%2e/secrets.html', DIST)).toBe(path.join(DIST, 'secrets.html'));
    expect(isAppUrl('app://hud/..%5c..%5csecrets.html', prod)).toBe(false);
  });

  it('allows the dev server only while running against it', () => {
    expect(isAppUrl('http://127.0.0.1:5173/hud.html?x=1', dev)).toBe(true);
    expect(isAppUrl('http://127.0.0.1:5174/hud.html', dev)).toBe(false);
    expect(isAppUrl('http://localhost:5173/hud.html', dev)).toBe(false);
  });
});

describe('safeForLog — a blocked URL is logged without its path or query', () => {
  it('keeps only the scheme and host', () => {
    expect(safeForLog('https://calendar.example.com/private-abc123/basic.ics?token=x')).toBe(
      'https://calendar.example.com',
    );
    expect(safeForLog(pathToFileURL('C:/Users/you/notes/secret.md').href)).toBe('file:');
    expect(safeForLog('nonsense')).toBe('unparseable URL');
  });
});

describe('the app:// protocol (Phase 9.4)', () => {
  it('maps a page to its file in dist, and nothing outside it', () => {
    expect(fileFor('app://hud/assets/main.js', DIST)).toBe(path.join(DIST, 'assets', 'main.js'));
    expect(fileFor('app://hud/hud.html?anchor=top-right', DIST)).toBe(path.join(DIST, 'hud.html'));
    expect(fileFor('app://hud/', DIST)).toBe(path.join(DIST, 'index.html'));
    expect(fileFor('app://hud/%2e%2e/secrets.json', DIST)).toBe(path.join(DIST, 'secrets.json')); // collapsed, still inside
    expect(fileFor('app://hud/..%5Csecrets.json', DIST)).toBeNull();
    expect(fileFor('app://hud/a%00.html', DIST)).toBeNull();
    expect(fileFor('app://elsewhere/hud.html', DIST)).toBeNull();
    expect(fileFor('file:///C:/Windows/win.ini', DIST)).toBeNull();
  });

  it('builds page URLs with their query', () => {
    expect(pageUrl('hud.html', { anchor: 'top-right', shown: '0' })).toBe('app://hud/hud.html?anchor=top-right&shown=0');
    expect(pageUrl('index.html')).toBe('app://hud/index.html');
  });
});
