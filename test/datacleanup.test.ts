import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
const C = require_('../electron/datacleanup.cjs');
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'dhud-cleanup-')); });
afterEach(() => { if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('dhud-cleanup-')) throw Error('unsafe cleanup'); fs.rmSync(root, { recursive: true, force: true }); });
const put = (name: string) => fs.writeFileSync(path.join(root, name), 'test');
describe('durable data removal', () => {
  it('retains a locked secret and retries before clearing the marker', () => {
    put('config.json'); put('secrets.bin'); put('Notes');
    C.begin(root);
    const first = C.retry(root, { remove: (p: string) => { if (p.endsWith('secrets.bin')) throw Error('held'); fs.rmSync(p); } });
    expect(first.pending).toEqual(['secrets.bin']);
    expect(C.read(root)).toEqual(['secrets.bin']);
    expect(fs.existsSync(path.join(root, 'Notes'))).toBe(true);
    expect(C.retry(root).pending).toEqual([]);
    expect(fs.existsSync(path.join(root, '.remove-on-start'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'secrets.bin'))).toBe(false);
  });
  it('defers Chromium and preserves the reset marker even with no work left', () => {
    put('Cache'); C.begin(root); C.retry(root, { deferChromium: true });
    expect(C.read(root)).toEqual(['Cache']);
    expect(C.retry(root).requested).toBe(true);
    C.begin(root); C.retry(root, { deferChromium: true });
    expect(C.retry(root).requested).toBe(true);
  });
  it('honors explicit built-in deletion while protecting a chosen folder', () => {
    put('Notes'); put('MyNotes'); C.begin(root, { notes: true, protect: ['MyNotes'] }); C.retry(root);
    expect(fs.existsSync(path.join(root, 'Notes'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'MyNotes'))).toBe(true);
  });
  it.each(['../outside', '..', '.. ', 'C:escape', 'nested/file', 'nested\\file', '.remove-on-start'])('refuses unsafe pending name %s before any deletion', name => {
    put('config.json'); fs.writeFileSync(path.join(root, '.remove-on-start'), JSON.stringify({ v: 1, pending: ['config.json', name] }));
    expect(() => C.retry(root)).toThrow();
    expect(fs.existsSync(path.join(root, 'config.json'))).toBe(true);
  });
  it('unlinks a junction without following it', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dhud-cleanup-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'keep.md'), 'keep');
      fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
      C.begin(root); C.retry(root);
      expect(fs.readFileSync(path.join(outside, 'keep.md'), 'utf8')).toBe('keep');
    } finally {
      if (path.dirname(outside) !== path.resolve(os.tmpdir()) || !path.basename(outside).startsWith('dhud-cleanup-outside-')) throw Error('unsafe cleanup');
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
