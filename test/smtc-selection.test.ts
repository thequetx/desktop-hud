import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('native Windows media-session selection', () => {
  it('runs the production selection helper through current/playing/filter priorities', () => {
    if (process.platform !== 'win32') return;
    const root = process.cwd();
    const win = process.env.WINDIR || 'C:\\Windows';
    const fw = path.join(win, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
    const winmd = path.join(win, 'System32', 'WinMetadata');
    const csc = path.join(fw, 'csc.exe');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dhud-smtc-test-'));
    const exe = path.join(dir, 'selection-test.exe');
    try {
      execFileSync(csc, [
        '/nologo', '/optimize+', '/target:exe', '/platform:anycpu', '/main:SelectionHarness', `/out:${exe}`,
        `/r:${path.join(fw, 'System.Runtime.dll')}`,
        `/r:${path.join(winmd, 'Windows.Foundation.winmd')}`,
        `/r:${path.join(winmd, 'Windows.Media.winmd')}`,
        `/r:${path.join(winmd, 'Windows.Storage.winmd')}`,
        path.join(root, 'native', 'smtc-reader.cs'), path.join(root, 'test', 'smtc-selection-harness.cs'),
      ], { stdio: 'pipe' });
      execFileSync(exe, [], { stdio: 'pipe' });
      expect(true).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
