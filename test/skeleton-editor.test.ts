import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { blockProblem, kindOf, parseSkeletonDoc, withBlocks } from '../src/lib/skeleton';
import type { SkeletonBlock } from '../src/lib/types';

// The recurring-blocks editor (Phase 9.4): it rewrites only `blocks:`.

const SEED = readFileSync(new URL('../public/config/week-skeleton.yaml', import.meta.url), 'utf8');
const GYM: SkeletonBlock = { name: 'Gym', kind: 'gym', days: [0, 2, 4], startMin: 7 * 60, endMin: 8 * 60 };

describe('withBlocks', () => {
  it('replaces the list and keeps every comment and other section of the file', () => {
    const out = withBlocks(SEED, [GYM]);
    const doc = parseSkeletonDoc(out);
    expect(doc.blocks).toEqual([{ ...GYM, note: undefined, leadMin: undefined }]);
    // The seed's comments and its durations/windows sections survive.
    for (const line of SEED.split(/\r?\n/).filter((l) => l.startsWith('#'))) expect(out).toContain(line);
    expect(doc.durations).toEqual(parseSkeletonDoc(SEED).durations);
    expect(out).toContain('windows: []');
  });

  it('round-trips: removing the block gives an empty list again', () => {
    const back = withBlocks(withBlocks(SEED, [GYM]), []);
    expect(parseSkeletonDoc(back).blocks).toEqual([]);
    expect(parseSkeletonDoc(back).durations).toEqual(parseSkeletonDoc(SEED).durations);
  });

  it('keeps a block’s lead and note through an edit', () => {
    const b = { ...GYM, leadMin: 0, note: 'bring shoes' };
    expect(parseSkeletonDoc(withBlocks(SEED, [b])).blocks[0]).toMatchObject({ leadMin: 0, note: 'bring shoes' });
  });

  it('writes a file that had nothing in it', () => {
    expect(parseSkeletonDoc(withBlocks('', [GYM])).blocks).toHaveLength(1);
  });

  it('refuses to rewrite a file with a YAML error rather than guess', () => {
    expect(() => withBlocks('blocks: [\n  - name: "unclosed\n', [GYM])).toThrow(/YAML error/);
  });
});

describe('kindOf and blockProblem', () => {
  it('derives a kind from the name', () => {
    expect(kindOf('Gym')).toBe('gym');
    expect(kindOf('Meal prep')).toBe('meal-prep');
    expect(kindOf('  !!  ')).toBe('block');
  });

  it('names what is wrong with a block, or nothing', () => {
    expect(blockProblem({ ...GYM, name: ' ' })).toMatch(/name/);
    expect(blockProblem({ ...GYM, days: [] })).toMatch(/day/);
    expect(blockProblem({ ...GYM, endMin: GYM.startMin })).toMatch(/end after/);
    expect(blockProblem(GYM)).toBeNull();
  });
});
