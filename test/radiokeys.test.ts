import { describe, expect, it, vi } from 'vitest';
import { radioKeys } from '../src/components/Onboarding';

// Set-up's choice cards are role="radio" buttons. Like a native radio group they
// are one Tab stop, and the arrow keys (plus Home/End) move the choice and focus.

function press(key: string, values: readonly string[], current: string) {
  const focused: number[] = [];
  const buttons = values.map((_, i) => ({ focus: () => focused.push(i) }));
  const chosen: string[] = [];
  const preventDefault = vi.fn();
  radioKeys(values, current, (v) => chosen.push(v))({
    key,
    preventDefault,
    currentTarget: { querySelectorAll: () => buttons },
  } as any);
  return { chosen, focused, prevented: preventDefault.mock.calls.length > 0 };
}

describe('radioKeys', () => {
  const V = ['minimal', 'focus', 'full'] as const;

  it('moves forward with Right/Down and wraps', () => {
    expect(press('ArrowRight', V, 'minimal')).toEqual({ chosen: ['focus'], focused: [1], prevented: true });
    expect(press('ArrowDown', V, 'full')).toEqual({ chosen: ['minimal'], focused: [0], prevented: true });
  });

  it('moves back with Left/Up and wraps', () => {
    expect(press('ArrowLeft', V, 'focus')).toEqual({ chosen: ['minimal'], focused: [0], prevented: true });
    expect(press('ArrowUp', V, 'minimal')).toEqual({ chosen: ['full'], focused: [2], prevented: true });
  });

  it('jumps with Home and End', () => {
    expect(press('Home', V, 'full').chosen).toEqual(['minimal']);
    expect(press('End', V, 'minimal').chosen).toEqual(['full']);
  });

  it('leaves other keys alone (Tab, Enter, Space keep their normal meaning)', () => {
    for (const key of ['Tab', 'Enter', ' ', 'a']) {
      expect(press(key, V, 'focus')).toEqual({ chosen: [], focused: [], prevented: false });
    }
  });
});
