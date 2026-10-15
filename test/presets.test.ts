import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import {
  PRESENTATION_DEFAULTS,
  PRESET_NOTE_ID,
  applyPreset,
  asPresentation,
  presetLayout,
  presetOf,
} from '../src/lib/presentation';
import type { Bubble, PresentationPrefs } from '../src/lib/presentation';

const require_ = createRequire(import.meta.url);
const { defaults, normalise, BACKDROPS } = require_('../electron/presentation.cjs') as any;

const on = (p: PresentationPrefs, anchor?: string) =>
  p.hud.bubbles.filter((b) => b.enabled && (!anchor || b.anchor === anchor)).map((b) => b.id);

describe('bubble backdrop (Phase 9.5)', () => {
  it('defaults to the panel, the look the HUD always had', () => {
    expect(defaults().hud.backdrop).toBe('panel');
    expect(PRESENTATION_DEFAULTS.hud.backdrop).toBe('panel');
    expect(BACKDROPS).toEqual(['none', 'scrim', 'panel']);
  });

  it('keeps a known choice and drops anything else', () => {
    const at = (v: unknown) => normalise({ v: 3, hud: { backdrop: v } }).hud.backdrop;
    expect(at('none')).toBe('none');
    expect(at('scrim')).toBe('scrim');
    expect(at('panel')).toBe('panel');
    expect(at('glass')).toBe('panel');
    expect(at(1)).toBe('panel');
    expect(at(null)).toBe('panel');
    expect(at(undefined)).toBe('panel');
  });

  it('reaches a file written before it, keeping that file\'s own background', () => {
    const old = { v: 3, hud: { bgOpacity: 65 } };
    expect(normalise(old).hud).toMatchObject({ backdrop: 'panel', bgOpacity: 65 });
  });

  it('survives a round trip, and the renderer fills it on an older object', () => {
    const p = normalise({ v: 3, hud: { backdrop: 'scrim', bgOpacity: 40 } });
    expect(normalise(JSON.parse(JSON.stringify(p))).hud).toMatchObject({ backdrop: 'scrim', bgOpacity: 40 });
    const older = defaults();
    delete older.hud.backdrop;
    expect(asPresentation(older).hud.backdrop).toBe('panel');
    const bad = { ...defaults(), hud: { ...defaults().hud, backdrop: 'glass' } };
    expect(asPresentation(bad).hud.backdrop).toBe('panel');
    const whole = defaults();
    expect(asPresentation(whole)).toBe(whole);
  });
});

describe('presets (Phase 9.5)', () => {
  const base = (): PresentationPrefs => structuredClone(PRESENTATION_DEFAULTS);

  it('Minimal: the clock, Next up and the Today radar, top right, and nothing else', () => {
    const p = applyPreset(base(), 'minimal');
    expect(on(p)).toEqual(['clock', 'upcoming', 'radar']);
    expect(on(p, 'top-right')).toEqual(['clock', 'upcoming', 'radar']);
  });

  it('Focus adds intentions, the week and this week\'s note section, top left', () => {
    const p = applyPreset(base(), 'focus');
    expect(on(p, 'top-right')).toEqual(['clock', 'upcoming', 'radar']);
    expect(on(p, 'top-left')).toEqual(['intention', 'health', PRESET_NOTE_ID]);
    const note = p.hud.bubbles.find((b) => b.id === PRESET_NOTE_ID)!;
    expect(note).toMatchObject({ type: 'note', title: 'This week', source: { path: 'Weekly/{week}', heading: 'Tasks', items: 'open' } });
  });

  it('puts the note section in the owner\'s weekly folder', () => {
    const p = applyPreset(base(), 'focus', { weeklyDir: 'Journal/Weeks/' });
    expect(p.hud.bubbles.find((b) => b.id === PRESET_NOTE_ID)!.source.path).toBe('Journal/Weeks/{week}');
    expect(applyPreset(base(), 'focus', { weeklyDir: '' }).hud.bubbles.find((b) => b.id === PRESET_NOTE_ID)!.source.path).toBe('{week}');
  });

  it('Full turns on every built-in of the public catalogue', () => {
    const p = applyPreset(base(), 'full');
    const builtins = PRESENTATION_DEFAULTS.hud.bubbles.map((b) => b.id);
    for (const id of builtins) expect(on(p)).toContain(id);
    expect(on(p)).toContain(PRESET_NOTE_ID);
    expect(on(p, 'bottom-right')).toEqual(['nowplaying']);
  });

  it('is pure, and the main process accepts what it makes', () => {
    const before = base();
    const copy = structuredClone(before);
    for (const preset of ['minimal', 'focus', 'full'] as const) {
      const p = applyPreset(before, preset);
      expect(before).toEqual(copy);
      expect(normalise(p)).toEqual(p);
    }
  });

  it('leaves the owner\'s own bubbles and the screen settings alone', () => {
    const mine: Bubble = {
      ...structuredClone(PRESENTATION_DEFAULTS.hud.bubbles[0]),
      id: 'b-mine',
      type: 'text',
      anchor: 'bottom-left',
      source: { text: 'hello' },
    };
    const p0 = base();
    p0.hud.bubbles.push(mine);
    p0.hud.backdrop = 'scrim';
    p0.hud.bgOpacity = 30;
    const p = applyPreset(p0, 'minimal');
    expect(p.hud.bubbles.find((b) => b.id === 'b-mine')).toEqual(mine);
    expect(p.hud).toMatchObject({ backdrop: 'scrim', bgOpacity: 30, scale: 'standard' });
  });

  it('switching back from Focus to Minimal switches the note section off, keeping it', () => {
    const p = applyPreset(applyPreset(base(), 'focus'), 'minimal');
    expect(p.hud.bubbles.find((b) => b.id === PRESET_NOTE_ID)?.enabled).toBe(false);
    expect(on(p)).toEqual(['clock', 'upcoming', 'radar']);
    // ...and applying Focus again brings back the same one, not a second.
    const again = applyPreset(p, 'focus');
    expect(again.hud.bubbles.filter((b) => b.id === PRESET_NOTE_ID)).toHaveLength(1);
  });

  it('every preset bubble exists in the defaults (or is the note section)', () => {
    const ids = new Set(PRESENTATION_DEFAULTS.hud.bubbles.map((b) => b.id));
    for (const preset of ['minimal', 'focus', 'full'] as const) {
      for (const [id] of presetLayout(preset)) expect(ids.has(id) || id === PRESET_NOTE_ID).toBe(true);
    }
  });

  it('recognises a preset layout, and not one of the owner\'s own', () => {
    expect(presetOf(applyPreset(base(), 'minimal'))).toBe('minimal');
    expect(presetOf(applyPreset(base(), 'focus'))).toBe('focus');
    expect(presetOf(applyPreset(base(), 'full'))).toBe('full');
    expect(presetOf(base())).toBeNull();
  });
});
