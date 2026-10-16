import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const script = path.join(ROOT, 'scripts', 'release-check.mjs');
let fixture: string | undefined;

afterEach(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
  fixture = undefined;
});

function sourceFixture() {
  fixture = mkdtempSync(path.join(os.tmpdir(), 'release-check-test-'));
  writeFileSync(path.join(fixture, 'sample.md'), 'A safe public note.\r\n');
  execFileSync('git', ['init', '-q'], { cwd: fixture, windowsHide: true });
  execFileSync('git', ['add', 'sample.md'], { cwd: fixture, windowsHide: true });
  return fixture;
}

function run(cwd: string, extraEnv: Record<string, string | undefined>, ...args: string[]) {
  const env = { ...process.env, ...extraEnv };
  delete env.RELEASE_CHECK_PERSONAL;
  if (extraEnv.RELEASE_CHECK_PERSONAL !== undefined) env.RELEASE_CHECK_PERSONAL = extraEnv.RELEASE_CHECK_PERSONAL;
  return spawnSync(process.execPath, [script, '--source', ...args], {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
}

describe('release-check personal gate', () => {
  it('keeps generic source checks usable without a personal list', () => {
    const r = run(sourceFixture(), {}, '');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('no personal list');
  });

  it('fails the explicit release gate when the secret is missing or blank', () => {
    const cwd = sourceFixture();
    for (const value of [undefined, '  \n']) {
      const r = run(cwd, { RELEASE_CHECK_PERSONAL: value }, '--require-personal');
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('needs a non-empty RELEASE_CHECK_PERSONAL');
    }
  });

  it('uses a supplied personal list without printing the matched text', () => {
    const cwd = sourceFixture();
    writeFileSync(path.join(cwd, 'sample.md'), 'PRIVATE-MATRIX-MARKER\r\n');
    execFileSync('git', ['add', 'sample.md'], { cwd, windowsHide: true });
    const r = run(cwd, { RELEASE_CHECK_PERSONAL: 'PRIVATE-MATRIX-MARKER' }, '--require-personal');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('personal string #1');
    expect(r.stdout).not.toContain('PRIVATE-MATRIX-MARKER');
  });
});


it('can scan new non-ignored files before staging', () => {
  const cwd = sourceFixture();
  writeFileSync(path.join(cwd, 'accidental.reg'), 'synthetic fixture');
  const r = run(cwd, {}, '--include-untracked');
  expect(r.status).toBe(1);
  expect(r.stdout).toContain('registry export');
});
