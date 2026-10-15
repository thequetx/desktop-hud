import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { registerAddon } from '../src/lib/addons';
import type { ClockExtraProps } from '../src/lib/addons';
import { WIDGET_COMPONENTS } from '../src/components/hud/widgets';
import type { WidgetProps } from '../src/components/hud/widgets';
import { PRESENTATION_DEFAULTS } from '../src/lib/presentation';

// Phase 9.3: an add-on's Clock extra is drawn at the end of the Clock's line,
// with its own presentation section. Without one the Clock is unchanged.
const clockHtml = (presentation = PRESENTATION_DEFAULTS) =>
  renderToStaticMarkup(
    createElement('div', null, WIDGET_COMPONENTS.clock({
      now: new Date(2026, 9, 15, 13, 40),
      events: [],
      skeleton: [],
      presentation,
    } as unknown as WidgetProps)),
  );

describe('Clock extras', () => {
  it('draws nothing extra without an add-on', () => {
    expect(clockHtml()).not.toContain('probe');
  });

  it("draws a registered add-on's extra with its section", () => {
    const Probe = ({ section, now }: ClockExtraProps) =>
      section?.on === true ? createElement('span', { className: 'probe' }, `at ${now.getHours()}`) : null;
    registerAddon({ id: 'probe-clock', clockExtra: Probe });
    expect(clockHtml()).not.toContain('probe');
    const html = clockHtml({ ...PRESENTATION_DEFAULTS, addons: { 'probe-clock': { on: true } } });
    expect(html).toContain('<span class="probe">at 13</span>');
    expect(html.indexOf('hud__time')).toBeLessThan(html.indexOf('probe'));
  });
});
