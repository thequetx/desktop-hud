import { describe, expect, it } from 'vitest';
import {
  INTEGRATION_API_VERSION,
  type BubbleData,
  type EventsProvider,
  type Integration,
  type NotesProvider,
} from '../src/lib/integration-api';

// Not a test of behaviour (nothing implements the interface yet) but of shape:
// two example integrations must type-check against it, so the interface is
// shown to be usable before 9.3 and 9.4 build on it. `npm run typecheck`
// covers test/, so a breaking change to the API fails there as well.

function exampleCalendar(): EventsProvider {
  let running = false;
  return {
    id: 'ics',
    name: 'Calendar link (ICS)',
    apiVersion: INTEGRATION_API_VERSION,
    minCore: '0.9.0',
    provides: ['events'],
    platforms: ['win32'],
    settingsSchema: { v: 1, fields: [{ key: 'url', label: 'Calendar link', kind: 'secret', required: true }] },
    bubbles: [],
    async enable() {
      running = true;
      return async () => {
        running = false;
      };
    },
    status: () => (running ? { state: 'ok' } : { state: 'off' }),
    read: async () => null,
    events: async (sourceId, from) => [
      { sourceId, uid: 'a', title: 'Standup', start: from, end: new Date(from.getTime() + 15 * 60_000), allDay: false },
    ],
  };
}

function exampleReadOnlyNotes(): NotesProvider {
  return {
    id: 'markdown',
    name: 'Markdown folder',
    apiVersion: INTEGRATION_API_VERSION,
    minCore: '0.9.0',
    provides: ['tasks', 'notes'],
    platforms: ['win32', 'darwin', 'linux'],
    settingsSchema: { v: 1, fields: [{ key: 'folder', label: 'Folder', kind: 'folder', required: true }] },
    bubbles: [{ id: 'intentions', label: 'Intentions', shape: 'list', source: 'notes: weekly note', focus: 'keep' }],
    enable: async () => async () => {},
    status: () => ({ state: 'needs-setup', reason: 'Choose a folder' }),
    read: async (): Promise<BubbleData> => ({ shape: 'list', rows: [], empty: 'No intentions this week' }),
    // A user's own folder starts read-only (trust model S1): no write ops.
    capabilities: () => ['read', 'query', 'frontmatter'],
    readWeek: async () => ({ intentions: [], tasks: [] }),
    readList: async () => [],
  };
}

describe('integration API (Phase 9.0)', () => {
  it('is version 1', () => {
    expect(INTEGRATION_API_VERSION).toBe(1);
  });

  it('an events provider enables, reports status and stops through its dispose', async () => {
    const cal = exampleCalendar();
    const stop = await cal.enable({} as never);
    expect(cal.status().state).toBe('ok');
    const ev = await cal.events('work', new Date('2026-10-19T09:00:00'), new Date('2026-10-20T00:00:00'));
    expect(ev[0]).toMatchObject({ sourceId: 'work', uid: 'a' });
    await stop();
    expect(cal.status().state).toBe('off');
  });

  it('a read-only notes provider has no write capability or write operations', () => {
    const notes = exampleReadOnlyNotes();
    expect(notes.capabilities('mine')).not.toContain('write');
    expect(notes.setDone).toBeUndefined();
    expect(notes.append).toBeUndefined();
  });

  it('every integration is one shape', () => {
    const all: Integration[] = [exampleCalendar(), exampleReadOnlyNotes()];
    expect(all.every((i) => i.apiVersion === INTEGRATION_API_VERSION && i.provides.length > 0)).toBe(true);
  });
});
