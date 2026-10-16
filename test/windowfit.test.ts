import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

// The Display & HUD / set-up window must fit the work area of the display it
// opens on (Bug Log #92: 1180×840 overflowed a 1366×768 laptop and, at 150%,
// spilled onto the next monitor and under the taskbar).

const require_ = createRequire(import.meta.url);
const { fitToWorkArea, MARGIN } = require_('../electron/windowfit.cjs') as any;

const WANT = { width: 1180, height: 840, minWidth: 960, minHeight: 620 };

describe('fitToWorkArea', () => {
  it('keeps the preferred size on a large display, centred in the work area', () => {
    const fit = fitToWorkArea(WANT, { x: 0, y: 0, width: 2560, height: 1392 });
    expect(fit).toMatchObject({ width: 1180, height: 840, minWidth: 960, minHeight: 620 });
    expect(fit.x).toBe(690);
    expect(fit.y).toBe(276);
  });

  it('shrinks the height on a 1366×768 laptop at 100% (work area 1366×720)', () => {
    const fit = fitToWorkArea(WANT, { x: 0, y: 0, width: 1366, height: 720 });
    expect(fit.width).toBe(1180);
    expect(fit.height).toBe(720 - 2 * MARGIN);
    expect(fit.minHeight).toBe(620);
    expect(fit.y).toBe(MARGIN);
  });

  it('shrinks both sides and the minimums at 150% on a small screen (the VM case)', () => {
    const work = { x: 0, y: 0, width: 683, height: 464 };
    const fit = fitToWorkArea(WANT, work);
    expect(fit.width).toBe(683 - 2 * MARGIN);
    expect(fit.height).toBe(464 - 2 * MARGIN);
    expect(fit.minWidth).toBe(fit.width);
    expect(fit.minHeight).toBe(fit.height);
    expect(fit.x).toBeGreaterThanOrEqual(work.x);
    expect(fit.x + fit.width).toBeLessThanOrEqual(work.x + work.width);
    expect(fit.y + fit.height).toBeLessThanOrEqual(work.y + work.height);
  });

  it('places the window on a secondary display with a non-zero origin', () => {
    const work = { x: 1920, y: -200, width: 1280, height: 984 };
    const fit = fitToWorkArea(WANT, work);
    expect(fit.x).toBeGreaterThanOrEqual(1920);
    expect(fit.x + fit.width).toBeLessThanOrEqual(1920 + 1280);
    expect(fit.y).toBeGreaterThanOrEqual(-200);
  });

  it('keeps a size the user chose when it still fits', () => {
    const fit = fitToWorkArea({ ...WANT, width: 1000, height: 700 }, { x: 0, y: 0, width: 1920, height: 1040 });
    expect(fit).toMatchObject({ width: 1000, height: 700 });
  });
});
