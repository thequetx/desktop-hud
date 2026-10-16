import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

// Diagnostics (Phase 9.6, trust model S5): nothing personal in a bug report.

const require_ = createRequire(import.meta.url);
const { redact, buildReport, captureConsole, removableNow, _lines } = require_('../electron/diagnostics.cjs') as any;

describe('redact', () => {
  it('keeps a link’s scheme and host only', () => {
    expect(redact('fetch https://calendar.example.com/calendar/ical/me/private-abc123/basic.ics failed')).toBe(
      'fetch https://calendar.example.com/… failed',
    );
    expect(redact('webcal://p01-caldav.icloud.com/published/2/SECRET')).toBe('webcal://p01-caldav.icloud.com/…');
    expect(redact('https://user:pass@example.com/x')).toBe('https://example.com/…');
  });

  it('removes file paths, spaces and all', () => {
    expect(redact('[wd] profile: C:\\Users\\you\\AppData\\Roaming\\Desktop HUD')).toBe('[wd] profile: <path>');
    expect(redact('reading C:\\Users\\you\\vault\\Weekly\\2026-W42.md (ok)')).toBe('reading <path>(ok)');
    expect(redact('opened D:/Notes/Journal/2026-10-16.md, then')).toBe('opened <path>, then');
    expect(redact('share \\\\server\\home\\someone\\notes')).toBe('share <path>');
    expect(redact('file:///C:/Users/you/x.md')).toBe('file:<path>');
  });

  it('removes email addresses', () => {
    expect(redact('signed in as someone.else+hud@example.com')).toBe('signed in as <email>');
  });

  it('leaves ordinary log text alone', () => {
    expect(redact('[wd] add-ons: none; 3 calendars, 213 events')).toBe('[wd] add-ons: none; 3 calendars, 213 events');
  });
});

describe('buildReport', () => {
  it('includes recent log lines, redacted, and the facts it was given', () => {
    const fake: any = { log: (..._a: unknown[]) => {}, warn: (..._a: unknown[]) => {}, error: (..._a: unknown[]) => {} };
    captureConsole(fake);
    fake.warn('[wd] ics: calendar fetch failed for https://example.com/private/abc');
    fake.log('[wd] notes folder: C:\\Users\\you\\My Vault');
    const r = buildReport({ app: { version: '0.1.0' }, settings: { calendars: 2, notes: 'folder', write: false } });
    expect(r).toContain('version: 0.1.0');
    expect(r).toContain('calendars: 2');
    expect(r).toContain('https://example.com/…');
    expect(r).not.toContain('private/abc');
    expect(r).not.toContain('My Vault');
    expect(_lines.length).toBeGreaterThanOrEqual(2);
  });
});

describe('removableNow — what Remove all my data deletes', () => {
  const entries = ['config.json', 'secrets.bin', 'presentation.json', 'cal-cache', 'backups', 'Notes', 'google-calendar.json', 'Local State', 'Cache', 'lockfile', '.remove-on-start'];
  it('everything of the app’s, not Electron’s own files, and not the built-in notes unless asked', () => {
    expect(removableNow(entries)).toEqual(['config.json', 'secrets.bin', 'presentation.json', 'cal-cache', 'backups', 'google-calendar.json']);
    expect(removableNow(entries, { notes: true })).toContain('Notes');
  });
});


describe('diagnostics URL edge cases', () => {
  it.each(['https://example.com?token=SECRET', 'https://example.com#SECRET', 'webcal://user:SECRET@example.com?key=SECRET'])('removes root query, fragments and credentials from %s', url => {
    const text = redact(url);
    expect(text).not.toContain('SECRET');
    expect(text).toContain('example.com');
  });
  it('redacts an invalid URL conservatively', () => {
    expect(redact('https://[broken?token=SECRET')).toBe('<link>');
  });
});
