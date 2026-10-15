import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { loadPrivateAddons, callAddon } = require_('../electron/addon-host.cjs') as any;

const missing = () => {
  const err: any = new Error("Cannot find module './addons-private/index.cjs'");
  err.code = 'MODULE_NOT_FOUND';
  throw err;
};

describe('loadPrivateAddons — build-time composition (Phase 9.3)', () => {
  it('is empty in the public build, which has no addons-private folder', () => {
    const logs: string[] = [];
    expect(loadPrivateAddons({ load: missing, log: (m: string) => logs.push(m) })).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('reports a broken add-on rather than crashing the app', () => {
    const logs: string[] = [];
    const broken = () => {
      throw new Error('boom');
    };
    expect(loadPrivateAddons({ load: broken, log: (m: string) => logs.push(m) })).toEqual([]);
    expect(logs[0]).toMatch(/could not load/);
  });

  it('keeps add-ons with a valid, unique id', () => {
    const list = loadPrivateAddons({
      load: () => [{ id: 'one' }, { id: 'one' }, { id: 'Bad Id' }, null, { id: 'two' }],
      log: () => {},
    });
    expect(list.map((a: { id: string }) => a.id)).toEqual(['one', 'two']);
  });
});

describe('callAddon — what a renderer can reach', () => {
  const addons = [{ id: 'one', handlers: { feed: (arg: unknown) => ({ ok: true, arg }) } }];

  it('calls a named handler of a known add-on', () => {
    expect(callAddon(addons, 'one', 'feed', 3)).toEqual({ ok: true, arg: 3 });
  });

  it('returns null for anything else: unknown add-on or handler, inherited names, non-strings', () => {
    expect(callAddon(addons, 'two', 'feed')).toBeNull();
    expect(callAddon(addons, 'one', 'nope')).toBeNull();
    expect(callAddon(addons, 'one', 'constructor')).toBeNull();
    expect(callAddon(addons, 'one', '__proto__')).toBeNull();
    expect(callAddon(addons, { toString: () => 'one' }, 'feed')).toBeNull();
  });
});
