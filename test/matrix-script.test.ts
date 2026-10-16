import { describe, expect, it } from 'vitest';
// @ts-expect-error The release harness is a directly executed .mjs script.
import { isSafeTempDir, notesStatusProblem, taskkillExecutable } from '../scripts/matrix.mjs';

describe('release matrix safety assertions', () => {
  it('fails closed when expected notes status is missing', () => {
    expect(notesStatusProblem({ kind: 'folder', canWrite: false }, null)).toBe('notes status was unavailable');
  });

  it('checks both notes provider and write permission', () => {
    expect(notesStatusProblem({ kind: 'folder', canWrite: false }, { kind: 'folder', canWrite: true })).toContain('canWrite');
    expect(notesStatusProblem({ kind: 'folder', canWrite: false }, { kind: 'builtin', canWrite: false })).toContain('kind');
    expect(notesStatusProblem({ kind: 'folder', canWrite: false }, { kind: 'folder', canWrite: false })).toBeNull();
  });

  it('only permits cleanup of a direct matrix fixture under the OS temp folder', () => {
    expect(isSafeTempDir('C:\\Temp\\dhud-matrix-ab12', 'C:\\Temp')).toBe(true);
    expect(isSafeTempDir('dhud-matrix-ab12', 'C:\\Temp')).toBe(false);
    expect(isSafeTempDir('C:\\Temp\\other-ab12', 'C:\\Temp')).toBe(false);
    expect(isSafeTempDir('C:\\Temp\\nested\\dhud-matrix-ab12', 'C:\\Temp')).toBe(false);
  });

  it('uses taskkill from the configured Windows system directory', () => {
    expect(taskkillExecutable('C:\\Windows')).toBe('C:\\Windows\\System32\\taskkill.exe');
  });
});
