import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { PRESENTATION_DEFAULTS, WIDGET_IDS, newBubbleId } from '../src/lib/presentation';
import { WIDGETS } from '../src/lib/widgets';

const require_ = createRequire(import.meta.url);
const {
  defaults,
  normalise,
  resolveDisplay,
  syncDisplayHints,
  hudBounds,
  nearestAnchor,
  activeAnchors,
  isPrivate,
  applyArrange,
} = require_('../electron/presentation.cjs') as any;
const displays = [
  { id: 1, primary: true, workArea: { x: 0, y: 0, width: 1000, height: 800 } },
  { id: 2, primary: false, workArea: { x: 1000, y: 0, width: 1200, height: 900 } },
];
const ids = (p: any, anchor?: string) =>
  p.hud.bubbles.filter((b: any) => !anchor || (b.anchor === anchor && b.enabled)).map((b: any) => b.id);
const byId = (p: any, id: string) => p.hud.bubbles.find((b: any) => b.id === id);

/** What the installed Phase 7 build wrote (the owner's real file, 2026-09-23). */
const V1 = {
  v: 1,
  ambient: { enabled: true, idleSeconds: 600, display: 'primary' },
  hud: {
    display: '4036119867',
    corner: 'top-right',
    scale: 'large',
    upcomingRows: 4,
    showStreaks: false,
    showWeekStrip: true,
  },
};

describe('presentation preferences', () => {
  it('uses the shipped behaviour as its safe fallback', () => {
    expect(normalise(null)).toEqual(defaults());
    expect(normalise({ v: 9 })).toEqual(defaults());
    expect(normalise({ v: 3, ambient: { idleSeconds: 2 } }).ambient.idleSeconds).toBe(60);
    expect(normalise({ v: 3, hud: { upcomingRows: 99, scale: 'huge' } }).hud).toMatchObject({
      upcomingRows: 4,
      scale: 'standard',
    });
  });

  it('clamps the bubble background opacity', () => {
    // 85 since Phase 9.5: the measured default for text over a white window.
    expect(defaults().hud.bgOpacity).toBe(85);
    const at = (v: unknown) => normalise({ v: 3, hud: { bgOpacity: v } }).hud.bgOpacity;
    expect(at(30)).toBe(30);
    expect(at(0)).toBe(0);
    expect(at(120)).toBe(95);
    expect(at(-5)).toBe(0);
    expect(at(42.6)).toBe(43);
    expect(at('lots')).toBe(85);
    expect(at(null)).toBe(85);
    expect(at(65)).toBe(65); // a stored value is kept
    expect(normalise(structuredClone(V1)).hud.bgOpacity).toBe(85); // older files get the default
  });

  it('keeps the renderer defaults and registry in step with the main process', () => {
    expect(PRESENTATION_DEFAULTS).toEqual(defaults());
    expect(ids(defaults())).toEqual([...WIDGET_IDS]);
    for (const id of WIDGET_IDS) expect(WIDGETS[id]).toBeTruthy();
    expect(normalise(defaults())).toEqual(defaults());
  });

  it('falls back temporarily without forgetting a missing monitor', () => {
    expect(resolveDisplay('2', displays).id).toBe(2);
    expect(resolveDisplay('gone', displays).id).toBe(1);
    expect(normalise(structuredClone(V1)).hud.display).toBe('4036119867');
  });

  describe('a monitor Windows has renumbered (2026-10-01)', () => {
    // the owner's three monitors as Electron saw them after a reconnect.
    const real = [
      { id: 838104902, label: 'Q27G4N', primary: true, bounds: { x: 0, y: 0, width: 2560, height: 1440 } },
      { id: 909889281, label: 'XG258', primary: false, bounds: { x: 2560, y: -337, width: 1080, height: 1920 } },
      { id: 3445209159, label: 'LEN L1950wD', primary: false, bounds: { x: 3640, y: 314, width: 600, height: 1024 } },
    ].map((d) => ({ ...d, workArea: d.bounds }));
    const xgHint = { label: 'XG258', x: 2560, y: -337, width: 1080, height: 1920 };
    const withHud = (display: string, displayHint?: unknown) => {
      const p = defaults();
      p.hud.display = display;
      if (displayHint) (p.hud as any).displayHint = displayHint;
      return p;
    };

    it('finds the old choice by model name when its id is gone', () => {
      expect(resolveDisplay('4036119867', real, xgHint).id).toBe(909889281);
      // …and by place and size when the label is unknown.
      expect(resolveDisplay('4036119867', real, { ...xgHint, label: '' }).id).toBe(909889281);
      // A hint that matches nothing still falls back to primary.
      expect(resolveDisplay('4036119867', real, { label: 'Gone', x: 9, y: 9, width: 9, height: 9 }).id).toBe(838104902);
      // An id that exists always wins over the hint.
      expect(resolveDisplay('3445209159', real, xgHint).id).toBe(3445209159);
      // 'primary' never consults a hint.
      expect(resolveDisplay('primary', real, xgHint).id).toBe(838104902);
    });

    it('tells identical models apart by where they sit', () => {
      const twins = [
        { id: 1, label: 'Same', primary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
        { id: 2, label: 'Same', primary: false, bounds: { x: 1920, y: 0, width: 1920, height: 1080 } },
      ];
      expect(resolveDisplay('old', twins, { label: 'Same', x: 1920, y: 0, width: 1920, height: 1080 }).id).toBe(2);
    });

    it('places the HUD on the re-found monitor', () => {
      expect(hudBounds(withHud('4036119867', xgHint), 200, real, 'top-right')).toMatchObject({
        x: 2560 + 1080 - 384 - 22,
        y: -337 + 22,
      });
    });

    it('heals the saved id and stamps hints, and is a no-op when current', () => {
      const healed = syncDisplayHints(withHud('4036119867', xgHint), real);
      expect(healed.hud.display).toBe('909889281');
      expect(healed.hud.displayHint).toEqual(xgHint);
      expect(syncDisplayHints(healed, real)).toBe(healed);

      // A freshly picked display gains its hint.
      const picked = syncDisplayHints(withHud('3445209159'), real);
      expect(picked.hud.displayHint).toEqual({ label: 'LEN L1950wD', x: 3640, y: 314, width: 600, height: 1024 });

      // No hint, nothing to match: left alone for the owner to re-pick.
      const lost = withHud('4036119867');
      expect(syncDisplayHints(lost, real)).toBe(lost);
      // Primary is never rewritten.
      const prim = defaults();
      expect(syncDisplayHints(prim, real)).toBe(prim);
    });

    it('keeps a valid hint through normalise and drops a bad or pointless one', () => {
      expect(normalise(withHud('4036119867', xgHint)).hud.displayHint).toEqual(xgHint);
      expect(normalise(withHud('4036119867', { label: 'X', x: 'no' })).hud).not.toHaveProperty('displayHint');
      expect(normalise(withHud('primary', xgHint)).hud).not.toHaveProperty('displayHint');
    });
  });

  it('anchors all corners to the selected work area', () => {
    for (const [corner, x, y] of [
      ['top-left', 1022, 22],
      ['top-right', 1794, 22],
      ['bottom-left', 1022, 538],
      ['bottom-right', 1794, 538],
    ] as const) {
      const p = defaults();
      p.hud.display = '2';
      expect(hudBounds(p, 340, displays, corner)).toMatchObject({ x, y, width: 384, height: 340 });
    }
  });
});

describe('migrations', () => {
  it('v1 → v3 keeps every choice and the old panel where its owner put it', () => {
    const p = normalise(structuredClone(V1));
    expect(p.v).toBe(3);
    expect(p.ambient).toEqual(V1.ambient);
    expect(p.hud).toMatchObject({ scale: 'large', upcomingRows: 4 });
    expect(byId(p, 'streaks')).toMatchObject({ anchor: 'top-right', enabled: false, type: 'builtin' });
    expect(byId(p, 'weekstrip')).toMatchObject({ anchor: 'top-right', enabled: true });
    // No stream rule by default since streaming became a private add-on (plan decision 9).
    expect(byId(p, 'daily')).toMatchObject({ anchor: 'bottom-left', show: { hideDuring: [] } });
  });

  it('v1 with a different corner moves the old panel there', () => {
    const p = normalise({ ...structuredClone(V1), hud: { ...V1.hud, corner: 'bottom-left' } });
    expect(byId(p, 'clock').anchor).toBe('bottom-left');
    expect(byId(p, 'upcoming').anchor).toBe('bottom-left');
    expect(byId(p, 'placed').anchor).toBe('top-right'); // new, at its default
  });

  it('v2 (widgets) → v3 (bubbles) keeps order and stream rules', () => {
    const p = normalise({
      v: 2,
      hud: {
        widgets: [
          { id: 'daily', enabled: true, anchor: 'top-right', hideDuring: ['gym'] },
          { id: 'clock', enabled: false, anchor: 'top-left', hideDuring: [] },
        ],
      },
    });
    expect(ids(p).slice(0, 2)).toEqual(['daily', 'clock']);
    expect(byId(p, 'daily').show.hideDuring).toEqual(['gym']);
    expect(byId(p, 'clock')).toMatchObject({ enabled: false, anchor: 'top-left' });
  });
});

describe('bubbles', () => {
  it('keeps stored order, drops malformed and duplicate ids, appends missing built-ins', () => {
    const p = normalise({
      v: 3,
      hud: {
        bubbles: [
          { id: 'daily', anchor: 'top-right' },
          { id: 'Not An Id!', type: 'builtin' },
          { id: 'clock', enabled: false, anchor: 'middle', show: { hideDuring: ['STREAM!', 'gym', 'gym'] } },
          { id: 'daily', enabled: false, anchor: 'top-left' },
        ],
      },
    });
    expect(ids(p).slice(0, 2)).toEqual(['daily', 'clock']);
    expect(ids(p)).toHaveLength(WIDGET_IDS.length);
    expect(byId(p, 'clock')).toMatchObject({ enabled: false, anchor: 'top-right', show: { hideDuring: ['gym'] } });
  });

  it("keeps an add-on's bubble when this build doesn't have the add-on (Phase 9.3)", () => {
    // A build without the owner's private add-ons must not delete their
    // bubbles from presentation.json: the bubble is kept as stored, not drawn.
    const p = normalise({ v: 3, hud: { bubbles: [{ id: 'hollowbot', type: 'builtin', enabled: true, anchor: 'bottom-right' }] } });
    expect(byId(p, 'hollowbot')).toMatchObject({ type: 'builtin', enabled: true, anchor: 'bottom-right' });
    expect(ids(p)).toHaveLength(WIDGET_IDS.length + 1);
  });

  it('validates an owner-defined bubble, field by field', () => {
    const p = normalise({
      v: 3,
      hud: {
        bubbles: [
          {
            id: 'b-hq1',
            type: 'note',
            title: '  Side Project  ',
            rows: 40,
            anchor: 'top-left',
            source: { path: '\\Projects\\Board', heading: 'Now', items: 'weird' },
            show: { days: [0, 9, 2, 2], hours: { from: 1320, to: 120 }, onlyDuring: ['stream'], inFocus: true },
          },
          { id: 'b-bad', type: 'note', source: { path: 'C:/Windows/x' } },
          { id: 'b-up', type: 'fields', source: { path: '../outside', keys: ['a', 'a', 7] } },
          { id: 'NOT-VALID', type: 'text' },
          { id: 'b-tsk', type: 'tasks', source: { due: 'someday', priority: 'high', includeDone: 'yes' } },
          { id: 'b-typ', type: 'script' },
        ],
      },
    });
    expect(byId(p, 'b-hq1')).toEqual({
      id: 'b-hq1',
      type: 'note',
      enabled: true,
      anchor: 'top-left',
      title: 'Side Project',
      rows: 12,
      width: 'full',
      bgOpacity: null,
      show: { hideDuring: [], onlyDuring: ['stream'], days: [0, 2], hours: { from: 1320, to: 120 }, inFocus: true },
      source: { path: 'Projects/Board', heading: 'Now', items: 'open' },
    });
    expect(byId(p, 'b-bad').source.path).toBe('');
    expect(byId(p, 'b-up').source).toEqual({ path: '', keys: ['a'] });
    expect(byId(p, 'NOT-VALID')).toBeUndefined();
    expect(byId(p, 'b-typ')).toBeUndefined();
    expect(byId(p, 'b-tsk').source).toEqual({ folder: '', tag: '', due: 'any', priority: 'high', includeDone: false });
  });

  it('keeps a bubble\'s width choice, defaulting built-ins to their own', () => {
    expect(byId(defaults(), 'nowplaying').width).toBe('fit');
    expect(byId(defaults(), 'clock').width).toBe('full');
    const p = normalise({
      v: 3,
      hud: {
        bubbles: [
          { id: 'clock', width: 'fit' },
          { id: 'b-w1', type: 'text', width: 'huge' },
          { id: 'b-w2', type: 'text', width: 'fit' },
        ],
      },
    });
    expect(byId(p, 'clock').width).toBe('fit');
    expect(byId(p, 'b-w1').width).toBe('full');
    expect(byId(p, 'b-w2').width).toBe('fit');
    // A file from before this existed: Now playing still fits.
    expect(byId(normalise(structuredClone(V1)), 'nowplaying').width).toBe('fit');
  });

  it('lets a bubble override the HUD background, or follow it', () => {
    expect(byId(defaults(), 'nowplaying').bgOpacity).toBe(85);
    expect(byId(defaults(), 'clock').bgOpacity).toBeNull();
    const p = normalise({
      v: 3,
      hud: {
        bubbles: [
          { id: 'nowplaying', bgOpacity: null }, // owner chose "HUD default"
          { id: 'clock', bgOpacity: 140 },
          { id: 'b-o1', type: 'text', bgOpacity: 'solid' },
          { id: 'b-o2', type: 'text', bgOpacity: 30 },
        ],
      },
    });
    expect(byId(p, 'nowplaying').bgOpacity).toBeNull();
    expect(byId(p, 'clock').bgOpacity).toBe(95);
    expect(byId(p, 'b-o1').bgOpacity).toBeNull();
    expect(byId(p, 'b-o2').bgOpacity).toBe(30);
    // Older files: Now playing gets its more solid default.
    expect(byId(normalise(structuredClone(V1)), 'nowplaying').bgOpacity).toBe(85);
  });

  it('makes ids the store accepts', () => {
    for (let i = 0; i < 20; i++) {
      const id = newBubbleId();
      expect(byId(normalise({ v: 3, hud: { bubbles: [{ id, type: 'text' }] } }), id)).toBeTruthy();
    }
  });

  it('opens a window only for corners with an enabled bubble', () => {
    expect(activeAnchors(defaults())).toEqual(['top-right', 'top-left', 'bottom-right', 'bottom-left']);
    const p = defaults();
    for (const b of p.hud.bubbles) b.enabled = b.id === 'clock';
    expect(activeAnchors(p)).toEqual(['top-right']);
  });

  it('keeps the personal corner private by default, and only known corners', () => {
    expect(isPrivate(defaults(), 'bottom-left')).toBe(true);
    expect(isPrivate(defaults(), 'top-right')).toBe(false);
    expect(normalise({ v: 3, hud: { privateAnchors: ['top-left', 'centre'] } }).hud.privateAnchors).toEqual([
      'top-left',
    ]);
  });
});

describe('arrange mode', () => {
  it('moves a bubble to the end of another corner', () => {
    const p = applyArrange(defaults(), { type: 'move', id: 'clock', anchor: 'bottom-right' });
    expect(ids(p, 'bottom-right')).toEqual(['nowplaying', 'clock']);
    const q = applyArrange(p, { type: 'move', id: 'daily', anchor: 'bottom-right' });
    expect(ids(q, 'bottom-right')).toEqual(['nowplaying', 'clock', 'daily']);
  });

  it('reorders within a corner, stepping over switched-off bubbles', () => {
    const d = defaults();
    expect(ids(d, 'top-left')).toEqual(['intention', 'health', 'streaks']);
    const p = applyArrange(d, { type: 'reorder', id: 'streaks', dir: -1 });
    expect(ids(p, 'top-left')).toEqual(['intention', 'streaks', 'health']);
    // `backlog` is off and sits in top-left after streaks; moving streaks down
    // past it would be a step that looks like it did nothing.
    expect(ids(applyArrange(d, { type: 'reorder', id: 'streaks', dir: 1 }), 'top-left')).toEqual(
      ids(d, 'top-left'),
    );
    expect(applyArrange(d, { type: 'reorder', id: 'clock', dir: -1 })).toEqual(d);
  });

  it('switches bubbles off and back on, optionally into a corner', () => {
    const p = applyArrange(defaults(), { type: 'hide', id: 'health' });
    expect(ids(p, 'top-left')).toEqual(['intention', 'streaks']);
    const q = applyArrange(p, { type: 'show', id: 'backlog', anchor: 'bottom-right' });
    expect(byId(q, 'backlog')).toMatchObject({ enabled: true, anchor: 'bottom-right' });
  });

  it('ignores unknown ids and actions', () => {
    const d = defaults();
    expect(applyArrange(d, { type: 'move', id: 'nope', anchor: 'top-left' })).toEqual(d);
    expect(applyArrange(d, { type: 'explode', id: 'clock' })).toEqual(d);
  });

  it('drops onto the nearest corner of the HUD display', () => {
    const p = defaults();
    p.hud.display = '2';
    expect(nearestAnchor(p, { x: 1100, y: 50 }, displays)).toBe('top-left');
    expect(nearestAnchor(p, { x: 2100, y: 850 }, displays)).toBe('bottom-right');
    // Released off the display entirely: still the nearest corner of it.
    expect(nearestAnchor(p, { x: 5000, y: -40 }, displays)).toBe('top-right');
  });
});

describe('extras', () => {
  const EXTRAS_REQ = require_('../electron/presentation.cjs').EXTRAS as string[];

  it('are all off by default, and the renderer agrees on the list', async () => {
    const { EXTRA_IDS, EXTRAS_OFF } = await import('../src/lib/presentation');
    expect(EXTRAS_REQ).toEqual([...EXTRA_IDS]);
    expect(defaults().extras).toEqual(EXTRAS_OFF);
    expect(Object.values(defaults().extras).every((v) => v === false)).toBe(true);
  });

  it('load from a file written before they existed', () => {
    const old = defaults();
    delete old.extras;
    expect(normalise(old).extras).toEqual(defaults().extras);
    expect(normalise(structuredClone(V1)).extras).toEqual(defaults().extras);
  });

  it('keep a real true, drop anything else and any unknown key', () => {
    const p = normalise({
      v: 3,
      extras: { bossBar: true, upNext: 'yes', dayNight: false, confetti: true },
    });
    expect(p.extras.bossBar).toBe(true);
    expect(p.extras.upNext).toBe(false);
    expect(p.extras.dayNight).toBe(false);
    expect(p.extras).not.toHaveProperty('confetti');
    expect(Object.keys(p.extras)).toEqual(EXTRAS_REQ);
    expect(normalise({ v: 3, extras: 'all' }).extras).toEqual(defaults().extras);
  });

  it('survive an arrange action and a round trip', () => {
    const p = normalise({ v: 3, extras: { streakLevels: true } });
    expect(normalise(p)).toEqual(p);
    const q = applyArrange(p, { type: 'hide', id: 'clock' });
    expect(q.extras.streakLevels).toBe(true);
  });

  it('the renderer fills extras on an older object and leaves a whole one alone', async () => {
    const { asPresentation, asExtras, EXTRAS_OFF } = await import('../src/lib/presentation');
    const old = defaults();
    delete old.extras;
    expect(asPresentation(old).extras).toEqual(EXTRAS_OFF);
    const whole = defaults();
    expect(asPresentation(whole)).toBe(whole);
    expect(asExtras({ bossBar: true, junk: true })).toEqual({ ...EXTRAS_OFF, bossBar: true });
  });

  it('Up next takes over the old radioLog switch', async () => {
    expect(normalise({ v: 3, extras: { radioLog: true } }).extras.upNext).toBe(true);
    expect(normalise({ v: 3, extras: { radioLog: false } }).extras.upNext).toBe(false);
    // Once the new key is written, it wins.
    expect(normalise({ v: 3, extras: { radioLog: true, upNext: false } }).extras.upNext).toBe(false);
    expect(normalise({ v: 3, extras: { radioLog: true } }).extras).not.toHaveProperty('radioLog');
    const { asExtras } = await import('../src/lib/presentation');
    expect(asExtras({ radioLog: true }).upNext).toBe(true);
    expect(asExtras({ radioLog: true, upNext: false }).upNext).toBe(false);
  });

  it("keeps an add-on's section it doesn't know, within a size cap (Phase 9.3)", () => {
    const p = normalise({ v: 3, addons: { cat: { hud: true, anchor: 'bottom-right' }, 'Bad Id': { x: 1 }, big: { s: 'x'.repeat(5000) } } });
    expect(p.addons).toEqual({ cat: { hud: true, anchor: 'bottom-right' } });
    expect(normalise({ v: 3 }).addons).toEqual({});
  });

  it('lets a registered add-on normalise its section and keep a corner open (Phase 9.3)', async () => {
    const { registerPresentationExtension } = require_('../electron/presentation.cjs');
    registerPresentationExtension({
      id: 'test-deco',
      normalise: (sec: any, raw: any) => ({ on: sec ? sec.on === true : raw?.extras?.legacyDeco === true, corner: 'bottom-left' }),
      activeAnchors: (sec: any) => (sec && sec.on ? [sec.corner] : []),
    });
    // Migrated from a legacy field the first time, then its own section wins.
    expect(normalise({ v: 3, extras: { legacyDeco: true } }).addons['test-deco']).toEqual({ on: true, corner: 'bottom-left' });
    expect(normalise({ v: 3, extras: { legacyDeco: true }, addons: { 'test-deco': { on: false } } }).addons['test-deco'].on).toBe(false);
    const base = defaults();
    const bubbles = base.hud.bubbles.map((b: any) => (b.anchor === 'bottom-left' ? { ...b, enabled: false } : b));
    const off = normalise({ ...base, hud: { ...base.hud, bubbles } });
    expect(activeAnchors(off)).not.toContain('bottom-left');
    const on = normalise({ ...off, addons: { 'test-deco': { on: true } } });
    expect(activeAnchors(on)).toContain('bottom-left');
  });

  it('hover fade is on at 20% by default and reaches files written before it', async () => {
    expect(defaults().hud).toMatchObject({ hoverFade: true, hoverOpacity: 20 });
    expect(PRESENTATION_DEFAULTS.hud).toMatchObject({ hoverFade: true, hoverOpacity: 20 });
    // A v1 file and a v3 file without the keys both get the defaults.
    expect(normalise(structuredClone(V1)).hud).toMatchObject({ hoverFade: true, hoverOpacity: 20 });
    expect(normalise({ v: 3, hud: { bgOpacity: 40 } }).hud).toMatchObject({ hoverFade: true, hoverOpacity: 20 });
    expect(normalise({ v: 3, hud: { hoverFade: false, hoverOpacity: 35 } }).hud).toMatchObject({ hoverFade: false, hoverOpacity: 35 });
    const { asPresentation } = await import('../src/lib/presentation');
    const old = defaults();
    delete old.hud.hoverFade;
    delete old.hud.hoverOpacity;
    expect(asPresentation(old).hud).toMatchObject({ hoverFade: true, hoverOpacity: 20 });
  });

  it('validates the hover fade switch and clamps its amount to 5–60', async () => {
    expect(normalise({ v: 3, hud: { hoverFade: 'no' } }).hud.hoverFade).toBe(true);
    expect(normalise({ v: 3, hud: { hoverFade: 0 } }).hud.hoverFade).toBe(true);
    expect(normalise({ v: 3, hud: { hoverOpacity: 0 } }).hud.hoverOpacity).toBe(5);
    expect(normalise({ v: 3, hud: { hoverOpacity: 100 } }).hud.hoverOpacity).toBe(60);
    expect(normalise({ v: 3, hud: { hoverOpacity: 17.6 } }).hud.hoverOpacity).toBe(18);
    expect(normalise({ v: 3, hud: { hoverOpacity: 'faint' } }).hud.hoverOpacity).toBe(20);
    expect(normalise({ v: 3, hud: { hoverOpacity: '' } }).hud.hoverOpacity).toBe(20);
    expect(normalise({ v: 3, hud: { hoverOpacity: null } }).hud.hoverOpacity).toBe(20);
    const { asPresentation, hudAlphaStyle } = await import('../src/lib/presentation');
    const withHud = (hud: object) => ({ ...defaults(), hud: { ...defaults().hud, ...hud } });
    expect(asPresentation(withHud({ hoverOpacity: 45 })).hud.hoverOpacity).toBe(45);
    expect(asPresentation(withHud({ hoverOpacity: 12.4 })).hud.hoverOpacity).toBe(12);
    expect(asPresentation(withHud({ hoverOpacity: 90 })).hud.hoverOpacity).toBe(20);
    expect(asPresentation(withHud({ hoverFade: 'yes' })).hud.hoverFade).toBe(true);
    expect(asPresentation(withHud({ hoverFade: false })).hud.hoverFade).toBe(false);
    // An already-whole object passes through untouched.
    const whole = withHud({});
    expect(asPresentation(whole)).toBe(whole);
    expect(hudAlphaStyle(withHud({ hoverOpacity: 25 }))['--hud-hover-opacity']).toBe('0.25');
  });

  it('the Today radar is a built-in, off by default, and reaches older files', () => {
    expect(byId(defaults(), 'radar')).toMatchObject({ type: 'builtin', enabled: false, anchor: 'top-right' });
    expect(byId(normalise(structuredClone(V1)), 'radar')).toMatchObject({ enabled: false });
    const onlyRadar = normalise({ v: 3, hud: { bubbles: [{ id: 'radar', enabled: true, anchor: 'bottom-left' }] } });
    expect(ids(onlyRadar, 'bottom-left')).toContain('radar');
  });
});
