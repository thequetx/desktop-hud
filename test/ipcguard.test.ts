import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// The IPC guard (Phase 9.6, trust model S3/S10): every call comes from an app
// page, with arguments of the declared shape, or the handler never runs.

const require_ = createRequire(import.meta.url);
const { installIpcGuard, problem, SCHEMAS } = require_('../electron/ipcguard.cjs') as any;

function fakeIpc() {
  const handlers = new Map<string, (...a: any[]) => any>();
  return {
    handlers,
    handle(ch: string, fn: any) {
      handlers.set(ch, fn);
    },
    on(ch: string, fn: any) {
      handlers.set(ch, fn);
    },
  };
}
const APP = { senderFrame: { url: 'app://hud/index.html' } };
const WEB = { senderFrame: { url: 'https://evil.example/' } };

describe('installIpcGuard', () => {
  const setup = () => {
    const ipc = fakeIpc();
    const logs: string[] = [];
    installIpcGuard(ipc, { isAppSender: (u: string) => u.startsWith('app://hud/'), log: (m: string) => logs.push(m) });
    let ran = 0;
    ipc.handle('events:remove', (_e: any, id: string) => {
      ran++;
      return { ok: true, id };
    });
    return { ipc, logs, ran: () => ran };
  };

  it('runs the handler for a well-formed call from an app page', () => {
    const { ipc, ran } = setup();
    expect(ipc.handlers.get('events:remove')!(APP, 'cal1')).toEqual({ ok: true, id: 'cal1' });
    expect(ran()).toBe(1);
  });

  it('refuses a call from any other page, without running the handler', () => {
    const { ipc, logs, ran } = setup();
    expect(ipc.handlers.get('events:remove')!(WEB, 'cal1')).toEqual({ ok: false, error: 'refused' });
    expect(ipc.handlers.get('events:remove')!({}, 'cal1')).toEqual({ ok: false, error: 'refused' });
    expect(ran()).toBe(0);
    expect(logs[0]).toMatch(/refused events:remove \(the sender/);
  });

  it('refuses the wrong shape, logging the channel but never the argument', () => {
    const { ipc, logs, ran } = setup();
    const secret = 'https://calendar.example.com/private-abc/basic.ics';
    expect(ipc.handlers.get('events:remove')!(APP, { url: secret })).toEqual({ ok: false, error: 'refused' });
    expect(ipc.handlers.get('events:remove')!(APP, 'x'.repeat(65))).toEqual({ ok: false, error: 'refused' });
    expect(ipc.handlers.get('events:remove')!(APP, 'a', 'b')).toEqual({ ok: false, error: 'refused' });
    expect(ran()).toBe(0);
    expect(logs.join(' ')).not.toContain('private-abc');
  });

  it('will not register a channel with no spec', () => {
    const ipc = fakeIpc();
    installIpcGuard(ipc, { isAppSender: () => true });
    expect(() => ipc.handle('made:up', () => 1)).toThrow(/no argument spec/);
  });
});

describe('problem', () => {
  it('checks types, sizes and optional arguments', () => {
    expect(problem(SCHEMAS['hud:resize'], [120])).toBeNull();
    expect(problem(SCHEMAS['hud:resize'], [NaN])).toMatch(/not a number/);
    expect(problem(SCHEMAS['hud:arrange-set'], ['yes'])).toMatch(/boolean/);
    expect(problem(SCHEMAS['events:refresh'], [])).toBeNull(); // optional
    expect(problem(SCHEMAS['events:list'], [[]])).toMatch(/not an object/);
    expect(problem(SCHEMAS['skeleton:write'], ['x'.repeat(300 * 1024)])).toMatch(/string up to/);
    const cyclic: any = {};
    cyclic.self = cyclic;
    expect(problem(SCHEMAS['widgets:read'], [cyclic])).toMatch(/not an object/);
    expect(problem(SCHEMAS['app:restart'], [1])).toMatch(/takes 0/);
  });
});

describe('the table covers every channel', () => {
  const main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const preload = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  const registered = [...main.matchAll(/ipcMain\.(?:handle|on)\('([a-z:-]+)'/g)].map((m) => m[1]);
  const called = [...preload.matchAll(/ipcRenderer\.(?:invoke|send)\('([a-z:-]+)'/g)].map((m) => m[1]);

  it('every channel main registers has a spec', () => {
    expect(registered.length).toBeGreaterThan(40);
    expect(registered.filter((c) => !(c in SCHEMAS))).toEqual([]);
  });

  it('every channel the preload calls has a spec and a handler, and the table has no strays', () => {
    expect(called.filter((c) => !(c in SCHEMAS))).toEqual([]);
    expect(called.filter((c) => !registered.includes(c))).toEqual([]);
    expect(Object.keys(SCHEMAS).filter((c) => !registered.includes(c))).toEqual([]);
  });
});
