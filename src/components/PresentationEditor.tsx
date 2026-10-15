import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  describeNote,
  endAmbientPreview,
  listVaultNotes,
  presentationDisplays,
  onDisplaysChange,
  previewAmbient,
  previewPresentation,
  readPresentation,
  readWidgets,
  readNowPlaying,
  notesSettings,
  readSkeletonYaml,
  writeSkeletonYaml,
  onSkeletonChange,
  resetPresentation,
  revertPresentation,
  setArrange,
  writePresentation,
} from '../lib/shell';
import type { EditorTarget, NoteDescription } from '../lib/shell';
import { ANCHORS, BG_OPACITY_DEFAULT, EXTRA_IDS, bubbleAlphaStyle, hudAlphaStyle, newBubbleId } from '../lib/presentation';
import type { Backdrop } from '../lib/presentation';
import { IntegrationsTab } from './Integrations';
import { rendererAddons } from '../lib/addons';
import { fmt, systemClockStyle } from '../lib/fmt';
import { blockProblem, kindOf, parseSkeletonDoc, withBlocks } from '../lib/skeleton';
import type {
  Anchor,
  Bubble,
  BubbleType,
  ExtraId,
  PresentationDisplay,
  PresentationPrefs,
  ShowRules,
  WidgetId,
} from '../lib/presentation';
import {
  BUBBLE_TYPES,
  WIDGETS,
  widgetMeta,
  activeKinds,
  activeTitles,
  bubbleState,
  bubbleTitle,
  customRequests,
  fmtMin,
  localIsoDate,
  readersNeeded,
} from '../lib/widgets';
import type { WidgetData } from '../lib/widgets';
import { computeStreaks } from '../lib/streaks';
import { EXTRAS_META } from '../lib/extras';
import { isoWeekId } from '../lib/week';
import type { CalEvent, DurationMap, SkeletonBlock, VaultTask, VaultWeek } from '../lib/types';
import { bubbleDataStyle, renderBubble } from './hud/widgets';
import { Row, Segmented, Toggle } from './controls';
// Kept importable from here, as before (private add-ons' editor sections use them).
export { Row, Toggle };
import {
  IconBuiltin,
  IconCheck,
  IconClose,
  IconCopy,
  IconDown,
  IconEyeOff,
  IconFields,
  IconLock,
  IconMove,
  IconNote,
  IconPlus,
  IconTasks,
  IconText,
  IconTrash,
  IconUp,
} from './icons';

const ANCHOR_LABEL: Record<Anchor, string> = {
  'top-left': 'Top left',
  'top-right': 'Top right',
  'bottom-left': 'Bottom left',
  'bottom-right': 'Bottom right',
};
const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const DAY_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** What each backdrop is, in the words under its switch. */
export const BACKDROP_HINT: Record<Backdrop, string> = {
  none: 'Text only, edged in a dark halo. Best over a dark wallpaper.',
  scrim: 'A soft shade behind the text, with no frame.',
  panel: 'A solid plate with a keyline: the most readable over a busy or white screen.',
};

/** How long typing settles before the live HUD is updated. */
const PREVIEW_DEBOUNCE_MS = 250;

type Template = { label: string; hint: string; type: Exclude<BubbleType, 'builtin'>; title: string; source: Bubble['source'] };

/**
 * Starting points for a new bubble. Every field stays editable afterwards —
 * these only save typing the common shapes. The daily and weekly ones point
 * at the folders set in Integrations → Notes (Phase 9.6: they used to name
 * the owner's folders).
 */
function templatesFor(weekly: string, daily: string): Template[] {
  const w = weekly ? `${weekly}/{week}` : '{week}';
  const d = daily ? `${daily}/{today}` : '{today}';
  return [
  { label: 'Note section', hint: 'Any heading of any note', type: 'note', title: '', source: { path: '', heading: '', items: 'open' } },
  { label: 'Today’s daily note', hint: `${d}, a heading of your choice`, type: 'note', title: 'Today', source: { path: d, heading: 'Notes', items: 'lines' } },
  { label: 'This week’s note', hint: `${w} → Tasks`, type: 'note', title: 'This week', source: { path: w, heading: 'Tasks', items: 'open' } },
  { label: 'Tasks with a tag', hint: 'Open tasks anywhere tagged…', type: 'tasks', title: '', source: { folder: '', tag: '#', due: 'any', priority: 'any', includeDone: false } },
  { label: 'Due this week', hint: 'Overdue or due in the next 7 days', type: 'tasks', title: 'Due soon', source: { folder: '', tag: '', due: 'week', priority: 'any', includeDone: false } },
  { label: 'High priority', hint: '⏫ and 🔺 tasks, anywhere', type: 'tasks', title: 'Priority', source: { folder: '', tag: '', due: 'any', priority: 'high', includeDone: false } },
  { label: 'Note fields', hint: 'Frontmatter values from a note', type: 'fields', title: '', source: { path: w, keys: ['status'] } },
  { label: 'Text', hint: 'A reminder, a rule, a mantra', type: 'text', title: '', source: { text: '' } },
  ];
}

interface Props {
  onClose: () => void;
  /** Open straight at a bubble, or at a new one for a corner (from arrange mode). */
  target?: EditorTarget;
  /** Fill the window rather than float as a dialog (the settings window). */
  standalone?: boolean;
  /** The HUD's live data, so the preview shows what the HUD would. */
  weekStart: Date;
  events: CalEvent[];
  skeleton: SkeletonBlock[];
  durations: DurationMap;
  vault: VaultWeek | null;
}

/**
 * Display & HUD — Phase 7's screen settings, and since Phase 8 the full bubble
 * editor.
 *
 * Every change is **previewed on the real HUD** as you make it (debounced for
 * typing) but only written to disk on Save. Cancel, ✕, Esc or closing the
 * window reverts to what's saved.
 */
export function PresentationEditor({ onClose, target, standalone, weekStart, events, skeleton, durations, vault }: Props) {
  const [draft, setDraft] = useState<PresentationPrefs | null>(null);
  const [tab, setTab] = useState<'bubbles' | 'screen' | 'integrations'>(target?.tab ?? 'bubbles');
  const [selected, setSelected] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<Anchor | null>(null);
  const [displays, setDisplays] = useState<PresentationDisplay[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const saved = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    readPresentation().then((p) => {
      setDraft(p);
      if (target?.bubbleId && p.hud.bubbles.some((b) => b.id === target.bubbleId)) setSelected(target.bubbleId);
      else if (target?.newAt) setChoosing(target.newAt as Anchor);
      else setSelected(p.hud.bubbles[0]?.id ?? null);
    });
    presentationDisplays().then(setDisplays);
    const offDisplays = onDisplaysChange(() => void presentationDisplays().then(setDisplays));
    listVaultNotes().then(setNotes);
    // Closing without Save — including the window going away — drops the preview.
    return () => {
      offDisplays();
      window.clearTimeout(timer.current);
      endAmbientPreview();
      if (!saved.current) void revertPresentation();
    };
  }, [target]);

  if (!draft) return null;

  const change = (next: PresentationPrefs, immediate = false) => {
    setDraft(next);
    window.clearTimeout(timer.current);
    if (immediate) void previewPresentation(next);
    else timer.current = window.setTimeout(() => void previewPresentation(next), PREVIEW_DEBOUNCE_MS);
  };
  const setHud = (hud: Partial<PresentationPrefs['hud']>, immediate = true) =>
    change({ ...draft, hud: { ...draft.hud, ...hud } }, immediate);
  const bubbles = draft.hud.bubbles;
  const updateBubble = (id: string, patch: Partial<Bubble>, immediate = false) =>
    setHud({ bubbles: bubbles.map((b) => (b.id === id ? { ...b, ...patch } : b)) }, immediate);

  const save = async () => {
    const r = await writePresentation(draft);
    if (!r.ok) {
      setError('Could not save display settings.');
      return;
    }
    saved.current = true;
    onClose();
  };
  const cancel = () => onClose(); // the unmount reverts
  const arrange = async () => {
    // Arrange mode edits the saved layout directly, so bring it up to date first.
    const r = await writePresentation(draft);
    if (!r.ok) {
      setError('Could not save display settings.');
      return;
    }
    saved.current = true;
    onClose();
    setArrange(true);
  };
  const reset = async () => {
    const r = await resetPresentation();
    if (r.prefs) {
      setDraft(r.prefs);
      setSelected(r.prefs.hud.bubbles[0]?.id ?? null);
    }
  };

  const addBubble = (anchor: Anchor, t: Template) => {
    const b: Bubble = {
      id: newBubbleId(),
      type: t.type,
      enabled: true,
      anchor,
      title: t.title,
      rows: null,
      width: 'full',
      bgOpacity: null,
      show: { hideDuring: [], onlyDuring: [], days: [], hours: null, inFocus: null },
      source: structuredClone(t.source),
    };
    setHud({ bubbles: [...bubbles, b] });
    setSelected(b.id);
    setChoosing(null);
  };
  const removeBubble = (id: string) => {
    setHud({ bubbles: bubbles.filter((b) => b.id !== id) });
    setSelected(bubbles.find((b) => b.id !== id)?.id ?? null);
  };
  const duplicate = (b: Bubble) => {
    const copy: Bubble = { ...structuredClone(b), id: newBubbleId(), title: `${bubbleTitle(b)} copy` };
    const i = bubbles.findIndex((x) => x.id === b.id);
    setHud({ bubbles: [...bubbles.slice(0, i + 1), copy, ...bubbles.slice(i + 1)] });
    setSelected(copy.id);
  };
  const move = (id: string, dir: -1 | 1) => {
    // Past the neighbouring bubble in the same corner.
    const list = [...bubbles];
    const i = list.findIndex((b) => b.id === id);
    let j = i + dir;
    while (j >= 0 && j < list.length && list[j].anchor !== list[i].anchor) j += dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    setHud({ bubbles: list });
  };

  const current = bubbles.find((b) => b.id === selected) ?? null;
  // Words a show rule is likely to want: the recurring-block kinds, the task
  // kinds the durations map knows.
  const kinds = [
    ...new Set([...skeleton.map((b) => b.kind), ...Object.keys(durations.byKind)]),
  ].filter((k) => k !== 'block' && k !== 'default');

  return (
    <div className={standalone ? 'modal modal--window' : 'modal'}>
      <section className="modal__panel pres pres--wide" aria-label="Display and HUD">
        {/* In its own frameless window the header is the title bar: drag it. */}
        <header className={standalone ? 'modal__head pres__head is-drag' : 'modal__head pres__head'}>
          <h2 className="q-title">Display &amp; HUD</h2>
          <Segmented
            className="pres__tabs"
            ariaLabel="Section"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'bubbles', label: 'Bubbles' },
              { value: 'screen', label: 'Screens' },
              { value: 'integrations', label: 'Integrations' },
            ]}
          />
          <span className="modal__spacer" />
          <button className="btn btn--icon" onClick={cancel} title="Close without saving" aria-label="Close without saving">
            <IconClose />
          </button>
        </header>

        {tab === 'integrations' ? (
          <IntegrationsTab />
        ) : tab === 'screen' ? (
          <ScreenTab draft={draft} displays={displays} change={change} setHud={setHud} />
        ) : (
          <div className="bub-ed">
            <aside className="bub-ed__list">
              <div className="bub-ed__actions">
                <button className="btn btn--primary" onClick={() => setChoosing(current?.anchor ?? 'top-right')}>
                  <IconPlus /> New bubble
                </button>
                <button
                  className="btn btn--ghost"
                  onClick={arrange}
                  title="Save, then move bubbles around on the screen itself"
                >
                  <IconMove /> Arrange on screen
                </button>
              </div>
              {ANCHORS.map((a) => {
                const inCorner = bubbles.filter((b) => b.anchor === a);
                const priv = draft.hud.privateAnchors.includes(a);
                return (
                  <section key={a} className="bub-ed__corner">
                    <header>
                      <span className="bub-ed__cornername">
                        <CornerGlyph anchor={a} />
                        {ANCHOR_LABEL[a]}
                      </span>
                      <Toggle
                        small
                        checked={priv}
                        title="Hide this corner from OBS and screen sharing"
                        onChange={(on) =>
                          setHud({
                            privateAnchors: on
                              ? [...draft.hud.privateAnchors, a]
                              : draft.hud.privateAnchors.filter((x) => x !== a),
                          })
                        }
                      >
                        <IconLock size={13} /> Private
                      </Toggle>
                    </header>
                    <ul>
                      {inCorner.map((b, i) => (
                        <li
                          key={b.id}
                          className={`${b.id === selected ? 'is-sel' : ''}${b.enabled ? '' : ' is-off'}`}
                          onClick={() => {
                            setSelected(b.id);
                            setChoosing(null);
                          }}
                        >
                          <Toggle
                            small
                            checked={b.enabled}
                            ariaLabel={`Show ${bubbleTitle(b)}`}
                            onChange={(on) => updateBubble(b.id, { enabled: on }, true)}
                          />
                          {/* A real button so the list can be walked with the keyboard;
                              the row's own click does the same thing for the mouse. */}
                          <button
                            className="bub-ed__pick"
                            aria-current={b.id === selected ? 'true' : undefined}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelected(b.id);
                              setChoosing(null);
                            }}
                          >
                            <span className="bub-ed__name">{bubbleTitle(b)}</span>
                            <span className="bub-ed__kind">
                              {b.type === 'builtin' ? 'Built-in' : BUBBLE_TYPES[b.type].label}
                            </span>
                          </button>
                          <span className="bub-ed__order">
                            <button
                              className="btn btn--icon btn--sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                move(b.id, -1);
                              }}
                              disabled={i === 0}
                              aria-label="Move up"
                              title="Move up"
                            >
                              <IconUp />
                            </button>
                            <button
                              className="btn btn--icon btn--sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                move(b.id, 1);
                              }}
                              disabled={i === inCorner.length - 1}
                              aria-label="Move down"
                              title="Move down"
                            >
                              <IconDown />
                            </button>
                          </span>
                        </li>
                      ))}
                      {inCorner.length === 0 && <li className="bub-ed__empty">Nothing here yet</li>}
                    </ul>
                  </section>
                );
              })}
            </aside>

            <div className="bub-ed__form">
              {choosing ? (
                <TemplatePicker anchor={choosing} onPick={(t) => addBubble(choosing, t)} onCancel={() => setChoosing(null)} />
              ) : current ? (
                <BubbleForm
                  key={current.id}
                  bubble={current}
                  kinds={kinds}
                  notes={notes}
                  privateAnchors={draft.hud.privateAnchors}
                  update={(patch, immediate) => updateBubble(current.id, patch, immediate)}
                  onDelete={current.type === 'builtin' ? undefined : () => removeBubble(current.id)}
                  onDuplicate={current.type === 'builtin' ? undefined : () => duplicate(current)}
                  preview={
                    <BubblePreview
                      bubble={current}
                      prefs={draft}
                      weekStart={weekStart}
                      events={events}
                      skeleton={skeleton}
                      vault={vault}
                    />
                  }
                />
              ) : (
                <p className="bub-ed__none">Choose a bubble on the left, or make a new one.</p>
              )}
            </div>
          </div>
        )}

        {error && <p className="banner banner--warn">{error}</p>}
        <footer className="modal__foot pres__foot">
          <button className="btn btn--quiet" onClick={reset} title="Every bubble and screen setting back to the defaults">
            Reset all
          </button>
          <span className="modal__spacer" />
          {tab === 'integrations' ? (
            <span className="pres__note">Integrations save as you change them</span>
          ) : (
            <span className="pres__note">
              <span className="pres__live" aria-hidden="true" />
              Previewing on the HUD · saved when you press Save
            </span>
          )}
          <button className="btn btn--ghost" onClick={cancel}>
            Cancel
          </button>
          <button className="btn btn--primary modal__primary" onClick={save}>
            Save
          </button>
        </footer>
      </section>
    </div>
  );
}

/** A tiny screen with its corner lit — says "where" faster than the words. */
function CornerGlyph({ anchor }: { anchor: Anchor }) {
  return <span className={`cglyph cglyph--${anchor}`} aria-hidden="true" />;
}

/** The four corners as a little screen you click a corner of. */
export function CornerPicker({
  value,
  onChange,
  privateAnchors,
}: {
  value: Anchor;
  onChange: (a: Anchor) => void;
  privateAnchors: Anchor[];
}) {
  // Screen order, not ANCHORS order, so the grid reads like the monitor.
  const order: Anchor[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  return (
    <span className="cpick" role="group" aria-label="Corner">
      {order.map((a) => (
        <button
          key={a}
          type="button"
          className={a === value ? 'is-on' : undefined}
          aria-pressed={a === value}
          onClick={(e) => {
            e.preventDefault();
            onChange(a);
          }}
        >
          {ANCHOR_LABEL[a]}
          {privateAnchors.includes(a) && (
            <span className="cpick__lock" title="Private corner">
              <IconLock size={12} />
            </span>
          )}
        </button>
      ))}
    </span>
  );
}

// ---- the screen tab (Phase 7's settings) -------------------------------------

function ScreenTab({
  draft,
  displays,
  change,
  setHud,
}: {
  draft: PresentationPrefs;
  displays: PresentationDisplay[];
  change: (next: PresentationPrefs, immediate?: boolean) => void;
  setHud: (hud: Partial<PresentationPrefs['hud']>, immediate?: boolean) => void;
}) {
  /** A monitor picker that says so when the stored monitor isn't plugged in,
   *  rather than showing a blank select (Phase 7 §2). */
  const displayPicker = (value: string, onChange: (v: string) => void, label: string) => {
    const missing = value !== 'primary' && !displays.some((d) => d.id === value);
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        <option value="primary">Primary display</option>
        {displays
          .filter((d) => !d.primary)
          .map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        {missing && <option value={value}>Unavailable display (using primary)</option>}
      </select>
    );
  };
  const ambient = (patch: Partial<PresentationPrefs['ambient']>) =>
    change({ ...draft, ambient: { ...draft.ambient, ...patch } }, true);
  return (
    <div className="pres__body">
      <BlocksCard />
      <section className="card">
        <header className="card__head">
          <h3>Idle screen</h3>
          <p>The calm overview that fades in over the wallpaper when you step away.</p>
        </header>
        <Row label="Show when idle">
          <Toggle checked={draft.ambient.enabled} onChange={(on) => ambient({ enabled: on })} ariaLabel="Show when idle" />
        </Row>
        <Row label="Show after" hint="Minutes without mouse or keyboard">
          <select
            value={draft.ambient.idleSeconds}
            onChange={(e) => ambient({ idleSeconds: Number(e.target.value) })}
            aria-label="Show after"
          >
            {[60, 180, 300, 600, 900].map((n) => (
              <option key={n} value={n}>
                {n / 60} minute{n === 60 ? '' : 's'}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Display">{displayPicker(draft.ambient.display, (v) => ambient({ display: v }), 'Idle screen display')}</Row>
        <div className="card__foot">
          <button className="btn btn--ghost" onClick={previewAmbient}>
            Preview now
          </button>
        </div>
      </section>
      <section className="card">
        <header className="card__head">
          <h3>Date and time</h3>
          <p>How the clock, days and week read. Your notes and calendar are not changed.</p>
        </header>
        <Row label="Week starts on" hint="The first day of the week strip, and when the end-of-week review comes round.">
          <Segmented
            ariaLabel="Week starts on"
            value={draft.locale.weekStart}
            onChange={(v) => change({ ...draft, locale: { ...draft.locale, weekStart: v } }, true)}
            options={[
              { value: 'mon', label: 'Monday' },
              { value: 'sun', label: 'Sunday' },
            ]}
          />
        </Row>
        <Row label="Clock" hint={`System follows Windows (${systemClockStyle() === '24h' ? '24-hour' : '12-hour'} here).`}>
          <Segmented
            ariaLabel="Clock"
            value={draft.locale.clock}
            onChange={(v) => change({ ...draft, locale: { ...draft.locale, clock: v } }, true)}
            options={[
              { value: 'auto', label: 'System' },
              { value: '12h', label: '12-hour' },
              { value: '24h', label: '24-hour' },
            ]}
          />
        </Row>
      </section>
      <section className="card">
        <header className="card__head">
          <h3>HUD</h3>
          <p>The corner bubbles that stay on the desktop while you work.</p>
        </header>
        <Row label="Display">{displayPicker(draft.hud.display, (v) => setHud({ display: v }), 'HUD display')}</Row>
        <Row label="Size">
          <Segmented
            ariaLabel="Size"
            value={draft.hud.scale}
            onChange={(v) => setHud({ scale: v })}
            options={[
              { value: 'compact', label: 'Compact' },
              { value: 'standard', label: 'Standard' },
              { value: 'large', label: 'Large' },
            ]}
          />
        </Row>
        <Row label="Backdrop" hint={BACKDROP_HINT[draft.hud.backdrop]}>
          <Segmented
            ariaLabel="Backdrop"
            value={draft.hud.backdrop}
            onChange={(v) => setHud({ backdrop: v })}
            options={[
              { value: 'none', label: 'None' },
              { value: 'scrim', label: 'Scrim' },
              { value: 'panel', label: 'Panel' },
            ]}
          />
        </Row>
        {draft.hud.backdrop !== 'none' && (
        <Row label="Background" hint={`How solid the ${draft.hud.backdrop} is. Lower lets more of the desktop through; ${BG_OPACITY_DEFAULT}% keeps text readable over a white window.`}>
          <span className="slider">
            <input
              type="range"
              min={0}
              max={95}
              step={5}
              value={draft.hud.bgOpacity}
              // Dragging previews on the real HUD, debounced like typing.
              onChange={(e) => setHud({ bgOpacity: Number(e.target.value) }, false)}
              aria-label="HUD background opacity"
            />
            <span className="slider__value">{draft.hud.bgOpacity === 0 ? 'Clear' : `${draft.hud.bgOpacity}%`}</span>
          </span>
        </Row>
        )}
        <Row label="Fade on hover" hint="A bubble under the cursor turns see-through, so you can read what's behind it. Clicks still go to the window underneath.">
          <Toggle
            checked={draft.hud.hoverFade}
            ariaLabel="Fade a bubble under the cursor"
            onChange={(on) => setHud({ hoverFade: on })}
          />
        </Row>
        {draft.hud.hoverFade && (
          <Row label="Hovered bubble" hint="How much of the bubble stays while the cursor is over it.">
            <span className="slider">
              <input
                type="range"
                min={5}
                max={60}
                step={5}
                value={draft.hud.hoverOpacity}
                onChange={(e) => setHud({ hoverOpacity: Number(e.target.value) }, false)}
                aria-label="Hovered bubble opacity"
              />
              <span className="slider__value">{draft.hud.hoverOpacity}%</span>
            </span>
          </Row>
        )}
        <Row label="Rows per list" hint="Default for lists; a bubble can set its own">
          <Segmented
            ariaLabel="Default rows per list"
            value={draft.hud.upcomingRows}
            onChange={(v) => setHud({ upcomingRows: v })}
            options={([1, 2, 3, 4, 5, 6] as const).map((v) => ({ value: v, label: String(v) }))}
          />
        </Row>
      </section>
      <ExtrasCard draft={draft} change={change} setHud={setHud} />
    </div>
  );
}

/**
 * Extras: small optional flourishes, each off until switched on here. They
 * preview on the real HUD like every other setting. The Today radar is a
 * bubble, so its switch here is the same one as its On-the-HUD toggle.
 */
function ExtrasCard({
  draft,
  change,
  setHud,
}: {
  draft: PresentationPrefs;
  change: (next: PresentationPrefs, immediate?: boolean) => void;
  setHud: (hud: Partial<PresentationPrefs['hud']>, immediate?: boolean) => void;
}) {
  const radar = draft.hud.bubbles.find((b) => b.id === 'radar');
  return (
    <section className="card card--wide">
      <header className="card__head">
        <h3>Extras</h3>
        <p>Small optional flourishes for the HUD and the idle screen. All off until you switch them on.</p>
      </header>
      <div className="xgrid">
        {EXTRA_IDS.map((k) => (
          <Row key={k} label={EXTRAS_META[k].label} hint={EXTRAS_META[k].hint}>
            <Toggle
              checked={draft.extras[k]}
              ariaLabel={EXTRAS_META[k].label}
              onChange={(on) => change({ ...draft, extras: { ...draft.extras, [k]: on } }, true)}
            />
          </Row>
        ))}
        {radar && (
          <Row
            label="Today radar"
            hint={`A bubble: today as one thin strip, the next thing named. It sits ${ANCHOR_LABEL[radar.anchor].toLowerCase()}; move or style it on the Bubbles tab.`}
          >
            <Toggle
              checked={radar.enabled}
              ariaLabel="Today radar"
              onChange={(on) =>
                setHud({ bubbles: draft.hud.bubbles.map((b) => (b.id === 'radar' ? { ...b, enabled: on } : b)) })
              }
            />
          </Row>
        )}
      </div>
      {/* Private add-ons' own sections (Phase 9.3). */}
      {rendererAddons().map((a) => {
        const Section = a.editorSection;
        if (!Section) return null;
        const section = (draft.addons ?? {})[a.id] as Record<string, unknown> | undefined;
        const set = (patch: Record<string, unknown>, immediate = true) =>
          change({ ...draft, addons: { ...(draft.addons ?? {}), [a.id]: { ...(section ?? {}), ...patch } } }, immediate);
        return <Section key={a.id} section={section} set={set} draft={draft} />;
      })}
    </section>
  );
}

/**
 * Recurring blocks (Phase 9.4): the week skeleton, edited here instead of by
 * hand in week-skeleton.yaml. Only the blocks list is rewritten; the rest of
 * the file, comments included, is kept (lib/skeleton.ts withBlocks). Days are
 * shown in the user's week order and stored Monday-first.
 */
function BlocksCard() {
  const [text, setText] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<SkeletonBlock[]>([]);
  const [editing, setEditing] = useState<{ index: number | null; block: SkeletonBlock } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = async () => {
    const t = await readSkeletonYaml();
    if (t == null) return;
    setText(t);
    try {
      setBlocks(parseSkeletonDoc(t).blocks);
    } catch {
      setMsg('The recurring-blocks file has a YAML error; fix it in a text editor first.');
    }
  };
  useEffect(() => {
    load();
    return onSkeletonChange(load);
  }, []);
  if (text == null) return null;

  const f = fmt();
  // Display position -> Monday-first index.
  const order = Array.from({ length: 7 }, (_, i) => (f.firstDay === 1 ? i : (i + 6) % 7));
  const dayName = (d: number) => f.dow(new Date(2024, 0, 1 + d)); // 1 Jan 2024 was a Monday
  const daysLabel = (days: number[]) =>
    days.length === 7 ? 'Every day' : order.filter((d) => days.includes(d)).map(dayName).join(' ');

  const save = async (next: SkeletonBlock[]) => {
    setMsg(null);
    let yaml: string;
    try {
      yaml = withBlocks(text, next);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
      return false;
    }
    const r = await writeSkeletonYaml(yaml);
    if (!r.ok) {
      setMsg(r.error ?? 'Could not save.');
      return false;
    }
    setText(yaml);
    setBlocks(next);
    return true;
  };

  const blank: SkeletonBlock = { name: '', kind: 'block', days: [0, 1, 2, 3, 4], startMin: 9 * 60, endMin: 10 * 60 };
  const problem = editing ? blockProblem(editing.block) : null;
  const commit = async () => {
    if (!editing || problem) return;
    const b = { ...editing.block, name: editing.block.name.trim() };
    if (editing.index == null || !b.kind || b.kind === 'block') b.kind = editing.index == null ? kindOf(b.name) : b.kind;
    const next = editing.index == null ? [...blocks, b] : blocks.map((x, i) => (i === editing.index ? b : x));
    if (await save(next)) setEditing(null);
  };
  const toMin = (v: string) => {
    const [h, m] = v.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const toHHMM = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

  return (
    <section className="card">
      <header className="card__head">
        <h3>Recurring blocks</h3>
        <p>The things that happen every week, like work hours, the gym or a class. They drive the warning before a block, streaks and week health. Optional: nothing needs them.</p>
      </header>
      {blocks.length === 0 && !editing && <p className="card__empty">No recurring blocks yet.</p>}
      {blocks.map((b, i) => (
        <Row key={`${b.name}-${i}`} label={b.name} hint={`${daysLabel(b.days)} · ${f.minutes(b.startMin)}–${f.minutes(b.endMin)}`}>
          <button className="btn btn--quiet" onClick={() => setEditing({ index: i, block: { ...b, days: [...b.days] } })}>
            Edit
          </button>
          <button className="btn btn--quiet btn--danger" aria-label={`Remove ${b.name}`} onClick={() => save(blocks.filter((_, j) => j !== i))}>
            Remove
          </button>
        </Row>
      ))}
      {editing && (
        <div className="blk-edit">
          <input
            type="text"
            value={editing.block.name}
            placeholder="Name (e.g. Gym)"
            aria-label="Block name"
            maxLength={60}
            onChange={(e) => setEditing({ ...editing, block: { ...editing.block, name: e.target.value } })}
          />
          <div className="blk-edit__days" role="group" aria-label="Days">
            {order.map((d) => {
              const on = editing.block.days.includes(d);
              return (
                <button
                  key={d}
                  className={`blk-edit__day${on ? ' is-on' : ''}`}
                  aria-pressed={on}
                  onClick={() =>
                    setEditing({
                      ...editing,
                      block: { ...editing.block, days: on ? editing.block.days.filter((x) => x !== d) : [...editing.block.days, d] },
                    })
                  }
                >
                  {dayName(d)}
                </button>
              );
            })}
          </div>
          <span className="blk-edit__times">
            <input
              type="time"
              aria-label="Starts"
              value={toHHMM(editing.block.startMin)}
              onChange={(e) => setEditing({ ...editing, block: { ...editing.block, startMin: toMin(e.target.value) } })}
            />
            <span>to</span>
            <input
              type="time"
              aria-label="Ends"
              value={toHHMM(editing.block.endMin)}
              onChange={(e) => setEditing({ ...editing, block: { ...editing.block, endMin: toMin(e.target.value) } })}
            />
          </span>
          {problem && editing.block.name && <p className="card__note">{problem}</p>}
        </div>
      )}
      {msg && <p className="banner banner--warn">{msg}</p>}
      <div className="card__foot">
        {editing ? (
          <>
            <button className="btn btn--quiet" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button className="btn btn--primary" onClick={commit} disabled={Boolean(problem)}>
              {editing.index == null ? 'Add block' : 'Save block'}
            </button>
          </>
        ) : (
          <button className="btn btn--primary" onClick={() => setEditing({ index: null, block: blank })}>
            Add a block
          </button>
        )}
      </div>
    </section>
  );
}

// ---- new bubble --------------------------------------------------------------

const TYPE_ICON: Record<Exclude<BubbleType, 'builtin'>, () => ReactNode> = {
  note: () => <IconNote />,
  tasks: () => <IconTasks />,
  fields: () => <IconFields />,
  text: () => <IconText />,
};

function TemplatePicker({
  anchor,
  onPick,
  onCancel,
}: {
  anchor: Anchor;
  onPick: (t: Template) => void;
  onCancel: () => void;
}) {
  const [dirs, setDirs] = useState({ weekly: 'Weekly', daily: 'Daily' });
  useEffect(() => {
    notesSettings().then((s) => {
      if (s) setDirs({ weekly: s.weeklyDir, daily: s.dailyDir });
    });
  }, []);
  return (
    <div className="tpl">
      <header className="tpl__head">
        <div>
          <p className="eyebrow">
            <CornerGlyph anchor={anchor} /> New bubble · {ANCHOR_LABEL[anchor]}
          </p>
          <h3>What should it show?</h3>
          <p className="tpl__lede">Start from one of these — everything is editable afterwards.</p>
        </div>
        <button className="btn btn--ghost" onClick={onCancel}>
          Cancel
        </button>
      </header>
      <div className="tpl__grid">
        {templatesFor(dirs.weekly, dirs.daily).map((t) => (
          <button key={t.label} className="tpl__card" onClick={() => onPick(t)}>
            <span className="tpl__icon">{TYPE_ICON[t.type]()}</span>
            <span className="tpl__text">
              <span className="tpl__label">{t.label}</span>
              <span className="tpl__hint">{t.hint}</span>
            </span>
            <span className="tpl__kind">{BUBBLE_TYPES[t.type].label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---- one bubble ----------------------------------------------------------------

function Field({ label, hint, children, wide }: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <label className={wide ? 'fld fld--wide' : 'fld'}>
      <span className="fld__label">{label}</span>
      <span className="fld__control">{children}</span>
      {hint && <span className="fld__hint">{hint}</span>}
    </label>
  );
}

/** A group of fields that isn't one control — a `<label>` would swallow the
 *  clicks meant for the chips and toggles inside it. */
function Group({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="fld" role="group" aria-label={label}>
      <span className="fld__label">{label}</span>
      <span className="fld__control">{children}</span>
      {hint && <span className="fld__hint">{hint}</span>}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="card">
      <header className="card__head">
        <h3>{title}</h3>
        {hint && <p>{hint}</p>}
      </header>
      <div className="card__body">{children}</div>
    </section>
  );
}

const TOKEN_HINT = 'Tokens: {today} {yesterday} {tomorrow} {week} {year} {month}. .md optional.';

function BubbleForm({
  bubble: b,
  kinds,
  notes,
  privateAnchors,
  update,
  onDelete,
  onDuplicate,
  preview,
}: {
  bubble: Bubble;
  kinds: string[];
  notes: string[];
  privateAnchors: Anchor[];
  update: (patch: Partial<Bubble>, immediate?: boolean) => void;
  onDelete?: () => void;
  onDuplicate?: () => void;
  preview: ReactNode;
}) {
  const src = b.source;
  const setSource = (patch: Partial<Bubble['source']>, immediate = false) =>
    update({ source: { ...src, ...patch } }, immediate);
  const setShow = (patch: Partial<ShowRules>) => update({ show: { ...b.show, ...patch } }, true);
  const lists = b.type !== 'text' && b.type !== 'fields' && (b.type !== 'builtin' || widgetMeta(b.id)?.hasRows);
  const folders = useMemo(
    () => [...new Set(notes.map((n) => n.split('/').slice(0, -1).join('/')).filter(Boolean))].sort(),
    [notes],
  );

  // What the chosen note looks like — headings for the section picker, keys
  // for the fields picker, and whether the path resolves at all.
  const [desc, setDesc] = useState<NoteDescription | null>(null);
  const notePathValue = b.type === 'note' || b.type === 'fields' ? src.path ?? '' : '';
  useEffect(() => {
    if (!notePathValue) {
      setDesc(null);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      describeNote(notePathValue, localIsoDate(new Date())).then((d) => {
        if (!cancelled) setDesc(d);
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [notePathValue]);

  const pathStatus =
    notePathValue && desc ? (
      desc.exists ? (
        <span className="ok">
          <IconCheck size={13} /> {desc.file}
        </span>
      ) : (
        <span className="warn">No note at {desc.file} (the bubble hides until it exists)</span>
      )
    ) : (
      TOKEN_HINT
    );

  const typeLabel = b.type === 'builtin' ? 'Built-in' : BUBBLE_TYPES[b.type].label;
  const builtinSource = b.type === 'builtin' ? widgetMeta(b.id)?.source : undefined;
  const typeHint = b.type === 'builtin' ? (builtinSource ? `From ${builtinSource}` : undefined) : BUBBLE_TYPES[b.type].hint;

  return (
    <div className="bform">
      <div className="bform__main">
        <header className="bform__head">
          <div className="bform__id">
            <p className="eyebrow">
              {b.type === 'builtin' ? <IconBuiltin size={14} /> : TYPE_ICON[b.type]()} {typeLabel}
            </p>
            <h3 className="bform__title">{bubbleTitle(b)}</h3>
            <p className="bform__type">{typeHint}</p>
          </div>
          <Toggle checked={b.enabled} onChange={(on) => update({ enabled: on }, true)}>
            {b.enabled ? 'On the HUD' : 'Switched off'}
          </Toggle>
        </header>

        <Section title="Basics">
          <Field label="Title" hint="Leave blank for the default name." wide>
            <input
              value={b.title}
              placeholder={b.type === 'builtin' ? widgetMeta(b.id)?.label : BUBBLE_TYPES[b.type].label}
              onChange={(e) => update({ title: e.target.value })}
              maxLength={60}
            />
          </Field>
          <div className="fld-row">
            <Group label="Corner">
              <CornerPicker value={b.anchor} privateAnchors={privateAnchors} onChange={(a) => update({ anchor: a }, true)} />
            </Group>
            {lists && (
              <Field label="Rows" hint="How many lines at most.">
                <select
                  value={b.rows ?? ''}
                  onChange={(e) => update({ rows: e.target.value ? Number(e.target.value) : null }, true)}
                >
                  <option value="">Default</option>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Group label="Width">
              <Segmented
                ariaLabel="Width"
                value={b.width ?? 'full'}
                onChange={(v) => update({ width: v }, true)}
                options={[
                  { value: 'full', label: 'Full' },
                  { value: 'fit', label: 'Fit' },
                ]}
              />
            </Group>
          </div>
          <Group label="Background">
            <span className="slider slider--bubble">
              <label className="fld-check">
                <input
                  type="checkbox"
                  checked={b.bgOpacity == null}
                  onChange={(e) => update({ bgOpacity: e.target.checked ? null : 85 }, true)}
                />{' '}
                HUD default
              </label>
              {b.bgOpacity != null && (
                <>
                  <input
                    type="range"
                    min={0}
                    max={95}
                    step={5}
                    value={b.bgOpacity}
                    onChange={(e) => update({ bgOpacity: Number(e.target.value) })}
                    aria-label="This bubble's background opacity"
                  />
                  <span className="slider__value">{b.bgOpacity === 0 ? 'Clear' : `${b.bgOpacity}%`}</span>
                </>
              )}
            </span>
          </Group>
        </Section>

        {b.type !== 'builtin' && (
          <Section title="Content">
            {(b.type === 'note' || b.type === 'fields') && (
              <Field label="Note" hint={pathStatus} wide>
                <input
                  list="wd-notes"
                  value={src.path ?? ''}
                  placeholder="e.g. Projects/Dashboard"
                  onChange={(e) => setSource({ path: e.target.value })}
                />
                <datalist id="wd-notes">
                  {notes.map((n) => (
                    <option key={n} value={n.replace(/\.md$/i, '')} />
                  ))}
                </datalist>
              </Field>
            )}

            {b.type === 'note' && (
              <>
                <Field label="Section" wide>
                  <select value={src.heading ?? ''} onChange={(e) => setSource({ heading: e.target.value }, true)}>
                    <option value="">Whole note</option>
                    {(desc?.headings ?? []).map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                    {src.heading && !(desc?.headings ?? []).includes(src.heading) && (
                      <option value={src.heading}>{src.heading} (not in this note)</option>
                    )}
                  </select>
                </Field>
                <Group label="Show">
                  <Segmented
                    ariaLabel="Show"
                    value={src.items ?? 'open'}
                    onChange={(v) => setSource({ items: v }, true)}
                    options={[
                      { value: 'open', label: 'Open tasks' },
                      { value: 'tasks', label: 'All tasks', title: 'Done ones ticked' },
                      { value: 'lines', label: 'Text lines' },
                    ]}
                  />
                </Group>
              </>
            )}

            {b.type === 'tasks' && (
              <>
                <Field label="Folder" hint="Empty = the whole vault. A single note works too." wide>
                  <input
                    list="wd-folders"
                    value={src.folder ?? ''}
                    placeholder="Whole vault"
                    onChange={(e) => setSource({ folder: e.target.value })}
                  />
                  <datalist id="wd-folders">
                    {folders.map((f) => (
                      <option key={f} value={f} />
                    ))}
                  </datalist>
                </Field>
                <div className="fld-row fld-row--3">
                  <Field label="Tag">
                    <input value={src.tag ?? ''} placeholder="#tag (optional)" onChange={(e) => setSource({ tag: e.target.value })} />
                  </Field>
                  <Field label="Due">
                    <select
                      value={src.due ?? 'any'}
                      onChange={(e) => setSource({ due: e.target.value as 'any' | 'overdue' | 'today' | 'week' }, true)}
                    >
                      <option value="any">Any</option>
                      <option value="overdue">Overdue</option>
                      <option value="today">Today or overdue</option>
                      <option value="week">This week or overdue</option>
                    </select>
                  </Field>
                  <Field label="Priority">
                    <select
                      value={src.priority ?? 'any'}
                      onChange={(e) =>
                        setSource({ priority: e.target.value as 'any' | 'medium' | 'high' | 'highest' }, true)
                      }
                    >
                      <option value="any">Any</option>
                      <option value="medium">🔼 medium and up</option>
                      <option value="high">⏫ high and up</option>
                      <option value="highest">🔺 highest</option>
                    </select>
                  </Field>
                </div>
                <Toggle checked={src.includeDone ?? false} onChange={(on) => setSource({ includeDone: on }, true)}>
                  Include done tasks
                </Toggle>
              </>
            )}

            {b.type === 'fields' && (
              <Group label="Fields" hint="Tick the frontmatter keys to show, in order.">
                <span className="chips">
                  {[...new Set([...(src.keys ?? []), ...(desc?.keys ?? [])])].map((k) => {
                    const on = (src.keys ?? []).includes(k);
                    return (
                      <button
                        key={k}
                        type="button"
                        className={on ? 'chip is-on' : 'chip'}
                        aria-pressed={on}
                        onClick={(e) => {
                          e.preventDefault();
                          setSource({ keys: on ? (src.keys ?? []).filter((x) => x !== k) : [...(src.keys ?? []), k] }, true);
                        }}
                      >
                        {on && <IconCheck size={12} />}
                        {k}
                      </button>
                    );
                  })}
                  {!desc?.keys?.length && !(src.keys ?? []).length && <span className="muted">Choose a note first</span>}
                </span>
              </Group>
            )}

            {b.type === 'text' && (
              <Field label="Text" wide>
                <textarea
                  rows={4}
                  value={src.text ?? ''}
                  maxLength={2000}
                  onChange={(e) => setSource({ text: e.target.value })}
                  placeholder="Anything you want in front of you."
                />
              </Field>
            )}
          </Section>
        )}

        <ShowRulesForm show={b.show} kinds={kinds} setShow={setShow} builtinFocus={b.type === 'builtin' ? widgetMeta(b.id)?.focus : undefined} />

        {(onDuplicate || onDelete) && (
          <div className="bform__more">
            {onDuplicate && (
              <button className="btn btn--ghost" onClick={onDuplicate}>
                <IconCopy /> Duplicate
              </button>
            )}
            {onDelete && (
              <button className="btn btn--danger" onClick={onDelete}>
                <IconTrash /> Delete bubble
              </button>
            )}
          </div>
        )}
      </div>
      <aside className="bform__preview" aria-label="Preview">
        <p className="bform__previewhead">
          <span>Preview</span>
          <span className="bform__previewnow">as it looks right now</span>
        </p>
        {preview}
      </aside>
    </div>
  );
}

function Chips({ all, on, set, label }: { all: string[]; on: string[]; set: (next: string[]) => void; label: string }) {
  const [extra, setExtra] = useState('');
  const list = [...new Set([...all, ...on])];
  return (
    <span className="chips">
      {list.map((k) => (
        <button
          key={k}
          type="button"
          className={on.includes(k) ? 'chip is-on' : 'chip'}
          aria-pressed={on.includes(k)}
          onClick={(e) => {
            e.preventDefault();
            set(on.includes(k) ? on.filter((x) => x !== k) : [...on, k]);
          }}
        >
          {on.includes(k) && <IconCheck size={12} />}
          {k}
        </button>
      ))}
      <input
        className="chip-input"
        value={extra}
        placeholder="+ word"
        aria-label={`Add a word to ${label}`}
        onChange={(e) => setExtra(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && extra) {
            e.preventDefault();
            set([...on, extra]);
            setExtra('');
          }
        }}
      />
    </span>
  );
}

const toTime = (m: number) => fmtMin(m);
const fromTime = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : 0;
};

function ShowRulesForm({
  show,
  kinds,
  setShow,
  builtinFocus,
}: {
  show: ShowRules;
  kinds: string[];
  setShow: (patch: Partial<ShowRules>) => void;
  builtinFocus?: string;
}) {
  const focusDefault = builtinFocus ? (builtinFocus === 'hide' ? 'hides' : 'stays') : 'hides';
  return (
    <Section title="When it shows" hint="Every rule narrows it down. Leave them all empty and it’s always up.">
      <Group label="Hide during" hint="While a recurring block of this kind, or a calendar event with this word in its title, is on.">
        <Chips label="Hide during" all={kinds} on={show.hideDuring} set={(v) => setShow({ hideDuring: v })} />
      </Group>
      <Group label="Only during" hint="Empty = any time. Type a word and press Enter to add one.">
        <Chips label="Only during" all={kinds} on={show.onlyDuring} set={(v) => setShow({ onlyDuring: v })} />
      </Group>
      <Group label="Days" hint={show.days.length ? undefined : 'Every day'}>
        <span className="days">
          {DAY_LETTERS.map((d, i) => (
            <button
              key={i}
              type="button"
              className={show.days.includes(i) ? 'day is-on' : 'day'}
              aria-pressed={show.days.includes(i)}
              aria-label={DAY_FULL[i]}
              title={DAY_FULL[i]}
              onClick={(e) => {
                e.preventDefault();
                setShow({ days: show.days.includes(i) ? show.days.filter((x) => x !== i) : [...show.days, i].sort() });
              }}
            >
              {d}
            </button>
          ))}
        </span>
      </Group>
      <Group label="Hours">
        <span className="hours">
          <Toggle
            checked={show.hours == null}
            onChange={(on) => setShow({ hours: on ? null : { from: 9 * 60, to: 17 * 60 } })}
          >
            All day
          </Toggle>
          {show.hours && (
            <span className="hours__range">
              <input
                type="time"
                aria-label="From"
                value={toTime(show.hours.from)}
                onChange={(e) => setShow({ hours: { ...show.hours!, from: fromTime(e.target.value) } })}
              />
              <span className="hours__to">to</span>
              <input
                type="time"
                aria-label="To"
                value={toTime(show.hours.to)}
                onChange={(e) => setShow({ hours: { ...show.hours!, to: fromTime(e.target.value) } })}
              />
            </span>
          )}
        </span>
      </Group>
      <Group label="In focus mode">
        <Segmented
          ariaLabel="In focus mode"
          value={show.inFocus == null ? '' : show.inFocus ? 'keep' : 'hide'}
          onChange={(v) => setShow({ inFocus: v === '' ? null : v === 'keep' })}
          options={[
            { value: '', label: `Default (${focusDefault})` },
            { value: 'keep', label: 'Stays up' },
            { value: 'hide', label: 'Hides' },
          ]}
        />
      </Group>
    </Section>
  );
}

// ---- preview -----------------------------------------------------------------------

/** The bubble drawn exactly as the HUD would draw it, from live data. */
function BubblePreview({
  bubble,
  prefs,
  weekStart,
  events,
  skeleton,
  vault,
}: {
  bubble: Bubble;
  prefs: PresentationPrefs;
  weekStart: Date;
  events: CalEvent[];
  skeleton: SkeletonBlock[];
  vault: VaultWeek | null;
}) {
  const [data, setData] = useState<WidgetData>({});
  const now = useMemo(() => new Date(), []);
  const one = useMemo<PresentationPrefs>(
    () => ({ ...prefs, hud: { ...prefs.hud, bubbles: [{ ...bubble, enabled: true }] } }),
    [prefs, bubble],
  );
  const request = JSON.stringify({ ids: readersNeeded(one), custom: customRequests(one) });
  useEffect(() => {
    let cancelled = false;
    const t = window.setTimeout(() => {
      const { ids, custom } = JSON.parse(request);
      Promise.all([
        readWidgets(ids, custom, localIsoDate(now)),
        bubble.id === 'nowplaying' ? readNowPlaying() : Promise.resolve(null),
      ]).then(([d, np]) => {
        if (!cancelled) setData({ ...d, nowplaying: np });
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [request, now]);

  const streaks = useMemo(() => computeStreaks(weekStart, events, skeleton), [weekStart, events, skeleton]);
  const why = bubbleState(
    { ...bubble, enabled: true },
    { kinds: activeKinds(skeleton, now), titles: activeTitles(events, now), focus: false, now },
  );
  const node = renderBubble({
    bubble,
    now,
    weekStart,
    weekId: isoWeekId(weekStart),
    events,
    skeleton,
    streaks,
    vault,
    audit: null,
    data,
    backlog: [] as VaultTask[],
    focus: null,
    presentation: prefs,
    error: null,
    debugRows: null,
  });
  return (
    <>
      <div
        className={`hudstack hud--${prefs.hud.scale} hud--bd-${prefs.hud.backdrop} pres__previewstack q-brackets${why ? ' is-ruled' : ''}`}
        style={hudAlphaStyle(prefs)}
      >
        <section
        className={`hud bub bub--${bubble.type} bub--${bubble.id}${bubble.width === 'fit' ? ' bub--fit' : ''}`}
        style={{ ...bubbleAlphaStyle(bubble), ...bubbleDataStyle(bubble, data) }}
      >
          {node ?? <p className="arr__empty">Nothing to show right now — the bubble stays hidden until there is.</p>}
        </section>
      </div>
      {why && (
        <p className="pres__why">
          <IconEyeOff size={14} />
          <span>
            Not showing right now — <b>{why}</b>
          </span>
        </p>
      )}
    </>
  );
}
