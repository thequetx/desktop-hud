// The first-run wizard (Phase 9.5, v0.9's three steps): notes, calendar,
// corners. Main opens Display & HUD with `{ onboarding: true }` on a new
// profile until `finishOnboarding()` is called; Settings.tsx draws this then.
//
// Every step can be skipped, and nothing a step chose happens until the end,
// except a calendar, which is added (and checked) the moment you add it, as
// on the Integrations page. Step 3 previews on the real HUD as you choose, the
// way Display & HUD always has, and is saved only by Finish. A new notes folder
// is read when the app starts, so finishing with one explains the restart and
// offers it.
//
// The goal it is measured against (Phase 9 plan, 9.5 gate): someone with a
// calendar link and no notes reaches a useful HUD in three steps or fewer and
// under five minutes. "Start fresh", paste, Minimal: three Nexts.

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  addCalendarFile,
  addCalendarLink,
  applyNotes,
  calendarSources,
  chooseNotesFolder,
  finishOnboarding,
  notesSettings,
  onEventsChange,
  previewPresentation,
  readPresentation,
  restartApp,
  revertPresentation,
  writePresentation,
} from '../lib/shell';
import type { CalendarSource, FolderPick } from '../lib/shell';
import { BG_OPACITY_DEFAULT, PRESETS, applyPreset, presetLayout } from '../lib/presentation';
import type { Anchor, Backdrop, PresentationPrefs, Preset } from '../lib/presentation';
import { widgetMeta } from '../lib/widgets';
import { Segmented, Toggle } from './controls';
import { IcsHelp, NotesFields, StatusDot, agoLabel, detectedLine, formFromPick, writeHint } from './Integrations';
import type { NotesForm } from './Integrations';
import { BACKDROP_HINT } from './PresentationEditor';
import { IconCheck, IconClose } from './icons';

const STEPS = ['Notes', 'Calendar', 'Corners'] as const;

const PRESET_COPY: Record<Preset, { name: string; who: string }> = {
  minimal: { name: 'Minimal', who: 'The time, what’s next, and today at a glance. Best with just a calendar.' },
  focus: { name: 'Focus', who: 'Adds this week’s intentions, how the week is going, and its tasks. For planning in notes.' },
  full: { name: 'Full', who: 'Every bubble. Anything without data stays hidden until it has some.' },
};

/** The names of a preset's bubbles, as the HUD titles them. */
function presetNames(preset: Preset): string[] {
  return presetLayout(preset).map(([id]) => (id === 'b-weeknote' ? 'This week’s tasks' : widgetMeta(id)?.label ?? id));
}

/** A tiny screen with a preset's bubbles stacked in their corners. */
function PresetScreen({ preset }: { preset: Preset }) {
  const by: Record<Anchor, number> = { 'top-left': 0, 'top-right': 0, 'bottom-left': 0, 'bottom-right': 0 };
  for (const [, a] of presetLayout(preset)) by[a] += 1;
  return (
    <span className="onb-screen" aria-hidden="true">
      {(Object.keys(by) as Anchor[]).map((a) =>
        by[a] ? (
          <span key={a} className={`onb-screen__stack onb-screen__stack--${a}`}>
            {Array.from({ length: by[a] }, (_, i) => (
              <i key={i} />
            ))}
          </span>
        ) : null,
      )}
    </span>
  );
}

export function Onboarding({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restart, setRestart] = useState(false);
  const saved = useRef(false);
  const appliedNotes = useRef(false);

  // Step 1 — notes. Nothing is applied until Finish.
  const [notesChoice, setNotesChoice] = useState<'builtin' | 'folder'>('builtin');
  const [pick, setPick] = useState<FolderPick | null>(null);
  const [form, setForm] = useState<NotesForm | null>(null);
  const [notesSkipped, setNotesSkipped] = useState(false);

  // Step 2 — calendars, added as you go.
  const [sources, setSources] = useState<CalendarSource[]>([]);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [calMsg, setCalMsg] = useState<string | null>(null);

  // Step 3 — corners, previewed live.
  const [base, setBase] = useState<PresentationPrefs | null>(null);
  const [preset, setPreset] = useState<Preset>('minimal');
  const [presetTouched, setPresetTouched] = useState(false);
  const [backdrop, setBackdrop] = useState<Backdrop>('panel');
  const [opacity, setOpacity] = useState(BG_OPACITY_DEFAULT);
  const [weeklyDir, setWeeklyDir] = useState('Weekly');

  useEffect(() => {
    readPresentation().then((p) => {
      setBase(p);
      setBackdrop(p.hud.backdrop);
      setOpacity(p.hud.bgOpacity);
    });
    notesSettings().then((s) => {
      if (s?.weeklyDir) setWeeklyDir(s.weeklyDir);
    });
    const loadSources = () => void calendarSources().then(setSources);
    loadSources();
    const off = onEventsChange(loadSources);
    return () => {
      off();
      // Closed before Finish: the HUD goes back to what's saved.
      if (!saved.current) void revertPresentation();
    };
  }, []);

  // Focus suits someone who chose a notes folder; Minimal everyone else —
  // until they pick one themselves.
  useEffect(() => {
    if (!presetTouched) setPreset(notesChoice === 'folder' && !notesSkipped ? 'focus' : 'minimal');
  }, [notesChoice, notesSkipped, presetTouched]);

  const cornersPrefs = (): PresentationPrefs | null => {
    if (!base) return null;
    const dir = notesChoice === 'folder' && form ? form.weeklyDir : weeklyDir;
    const p = applyPreset(base, preset, { weeklyDir: dir });
    return { ...p, hud: { ...p.hud, backdrop, bgOpacity: opacity } };
  };
  // Step 3 is shown on the real HUD as you choose.
  useEffect(() => {
    if (step !== 2) return;
    const p = cornersPrefs();
    if (!p) return;
    const t = window.setTimeout(() => void previewPresentation(p), 120);
    return () => window.clearTimeout(t);
    // cornersPrefs reads only the state listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, base, preset, backdrop, opacity, notesChoice, form, weeklyDir]);

  // ---- step actions ----

  const choose = async () => {
    setError(null);
    const p = await chooseNotesFolder();
    if (!p.ok) {
      if (!p.canceled) setError('Could not open that folder.');
      return;
    }
    setPick(p);
    setForm(formFromPick(p));
  };

  const addLink = async (): Promise<boolean> => {
    if (!url.trim()) return true;
    setBusy(true);
    setCalMsg(null);
    const r = await addCalendarLink(name, url);
    setBusy(false);
    if (!r.ok) {
      setCalMsg(r.error ?? 'Could not add that calendar.');
      return false;
    }
    setUrl('');
    setName('');
    setSources(await calendarSources());
    return true;
  };
  const addFile = async () => {
    setCalMsg(null);
    const r = await addCalendarFile('');
    if (!r.ok && !r.canceled) setCalMsg(r.error ?? 'Could not add that file.');
    setSources(await calendarSources());
  };

  const finish = async (corners: boolean) => {
    setBusy(true);
    setError(null);
    if (corners) {
      const p = cornersPrefs();
      if (p) {
        const r = await writePresentation(p);
        if (!r.ok) {
          setBusy(false);
          return setError('Could not save the corners.');
        }
      }
    } else {
      await revertPresentation();
    }
    let needsRestart = appliedNotes.current;
    if (!appliedNotes.current && !notesSkipped && notesChoice === 'folder' && pick && form) {
      const r = await applyNotes({
        use: 'picked',
        weeklyDir: form.weeklyDir.trim(),
        dailyDir: form.dailyDir.trim(),
        backlogPath: form.backlogPath.trim(),
        taskTag: form.taskTag.trim(),
        write: form.write,
      });
      if (!r.ok) {
        setBusy(false);
        setStep(0);
        return setError(r.error ?? 'Could not save the notes folder.');
      }
      appliedNotes.current = true;
      needsRestart = true;
    }
    const completed = await finishOnboarding();
    setBusy(false);
    if (!completed.ok) return setError(completed.error ?? 'Could not finish set-up. Please try again.');
    saved.current = true;
    if (needsRestart) setRestart(true);
    else onClose();
  };

  const skipAll = async () => {
    setBusy(true);
    await revertPresentation();
    const completed = await finishOnboarding();
    setBusy(false);
    if (!completed.ok) return setError(completed.error ?? 'Could not save set-up. Please try again.');
    saved.current = true;
    onClose();
  };

  const next = async () => {
    setError(null);
    if (step === 0) {
      setNotesSkipped(false);
      setStep(1);
    } else if (step === 1) {
      if (await addLink()) setStep(2);
    } else {
      await finish(true);
    }
  };
  const skip = async () => {
    setError(null);
    if (step === 0) {
      setNotesSkipped(true);
      setStep(1);
    } else if (step === 1) {
      setUrl('');
      setCalMsg(null);
      setStep(2);
    } else {
      await finish(false);
    }
  };

  const canNext = step !== 0 || notesChoice === 'builtin' || Boolean(pick);

  if (restart) {
    return (
      <Frame onClose={onClose} step={3}>
        <div className="onb__body onb__body--done">
          <section className="onb__step">
            <p className="eyebrow">All set</p>
            <h3 className="onb__h">One restart to read your notes</h3>
            <p className="onb__lede">
              Desktop HUD reads your notes folder when it starts. Restart it now and your notes appear on the HUD. Your
              calendar and corners are already saved.
            </p>
            <div className="onb__actions">
              <button className="btn btn--primary" onClick={() => void restartApp()}>
                Restart now
              </button>
              <button className="btn btn--quiet" onClick={onClose}>
                Later
              </button>
            </div>
          </section>
        </div>
      </Frame>
    );
  }

  return (
    <Frame onClose={onClose} step={step}>
      <div className="onb__body">
        {step === 0 && (
          <section className="onb__step" aria-label="Step 1, notes">
            <p className="eyebrow">Step 1 of 3 · Notes</p>
            <h3 className="onb__h">Where do your tasks and notes live?</h3>
            <p className="onb__lede">
              Desktop HUD can show this week’s intentions and tasks from Markdown notes. Only want your calendar? Start
              fresh, or skip this step.
            </p>
            <div className="onb-choice" role="radiogroup" aria-label="Notes">
              <button
                role="radio"
                aria-checked={notesChoice === 'builtin'}
                className={notesChoice === 'builtin' ? 'onb-choice__card is-on' : 'onb-choice__card'}
                onClick={() => setNotesChoice('builtin')}
              >
                <span className="onb-choice__tick">{notesChoice === 'builtin' && <IconCheck size={13} />}</span>
                <span className="onb-choice__name">Start fresh</span>
                <span className="onb-choice__hint">
                  Desktop HUD keeps a small folder of plain Markdown notes for you. Nothing to set up.
                </span>
              </button>
              <button
                role="radio"
                aria-checked={notesChoice === 'folder'}
                className={notesChoice === 'folder' ? 'onb-choice__card is-on' : 'onb-choice__card'}
                onClick={() => setNotesChoice('folder')}
              >
                <span className="onb-choice__tick">{notesChoice === 'folder' && <IconCheck size={13} />}</span>
                <span className="onb-choice__name">Use my notes folder</span>
                <span className="onb-choice__hint">
                  A folder of Markdown notes, or an Obsidian vault. Read-only unless you allow writing.
                </span>
              </button>
            </div>
            {notesChoice === 'folder' && (
              <div className="onb-folder">
                <div className="onb-folder__pick">
                  <button className={pick ? 'btn btn--ghost' : 'btn btn--primary'} onClick={choose}>
                    {pick ? 'Choose another folder…' : 'Choose folder…'}
                  </button>
                  {pick && (
                    <span className="onb-folder__found">
                      <b>“{pick.name}”</b> · {detectedLine(pick)} Check the suggestions below.
                    </span>
                  )}
                </div>
                {pick && form && (
                  <>
                    <NotesFields form={form} set={(patch) => setForm({ ...form, ...patch })} />
                    <div className="onb-write">
                      <Toggle checked={form.write} ariaLabel="Let Desktop HUD write to your notes" onChange={(on) => setForm({ ...form, write: on })}>
                        Let Desktop HUD write here
                      </Toggle>
                      <p className="onb-write__hint">{writeHint(form)}</p>
                    </div>
                  </>
                )}
              </div>
            )}
          </section>
        )}

        {step === 1 && (
          <section className="onb__step" aria-label="Step 2, calendar">
            <p className="eyebrow">Step 2 of 3 · Calendar</p>
            <h3 className="onb__h">Add your calendar</h3>
            <p className="onb__lede">
              Paste your calendar’s private link (an address ending in .ics) to see what’s next. Desktop HUD only reads it,
              every 15 minutes.
            </p>
            {sources.length > 0 && (
              <ul className="onb-cals">
                {sources.map((c) => (
                  <li key={c.id}>
                    <StatusDot health={c.lastError ? 'bad' : c.fetchedAt ? 'ok' : 'off'} />
                    <span className="onb-cals__name">{c.name}</span>
                    <span className="onb-cals__hint">
                      {c.lastError
                        ? `Not updating — ${c.lastError}`
                        : c.fetchedAt
                          ? `${c.count} event${c.count === 1 ? '' : 's'} · read ${agoLabel(c.fetchedAt)}`
                          : 'Reading…'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="onb-link">
              <input
                type="password"
                value={url}
                placeholder="Calendar link (https://… or webcal://…)"
                aria-label="Calendar link"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && url.trim()) void addLink();
                }}
              />
              <input
                type="text"
                value={name}
                placeholder="Name (optional)"
                aria-label="Calendar name"
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
              />
              <button className="btn btn--ghost" onClick={() => void addLink()} disabled={busy || !url.trim()}>
                {busy ? 'Checking…' : sources.length ? 'Add another' : 'Add'}
              </button>
            </div>
            <p className="onb__fine">
              The link is stored encrypted on this PC and never shown again. No link?{' '}
              <button className="linkbtn" onClick={addFile}>
                Choose an .ics file instead
              </button>
              .
            </p>
            {calMsg && <p className="banner banner--warn">{calMsg}</p>}
            <IcsHelp open />
          </section>
        )}

        {step === 2 && (
          <section className="onb__step" aria-label="Step 3, corners">
            <p className="eyebrow">Step 3 of 3 · Corners</p>
            <h3 className="onb__h">Choose what sits in the corners</h3>
            <p className="onb__lede">
              Look at the corners of your screen: the HUD is showing your choice now, over your own desktop.
            </p>
            <div className="onb-presets" role="radiogroup" aria-label="Preset">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  role="radio"
                  aria-checked={preset === p}
                  className={preset === p ? 'onb-preset is-on' : 'onb-preset'}
                  onClick={() => {
                    setPreset(p);
                    setPresetTouched(true);
                  }}
                >
                  <PresetScreen preset={p} />
                  <span className="onb-preset__name">
                    {PRESET_COPY[p].name}
                    {preset === p && <IconCheck size={13} />}
                  </span>
                  <span className="onb-preset__who">{PRESET_COPY[p].who}</span>
                  <span className="onb-preset__list">{presetNames(p).join(' · ')}</span>
                </button>
              ))}
            </div>
            <div className="onb-backdrop">
              <div className="onb-backdrop__row">
                <span className="onb-backdrop__label">Backdrop</span>
                <Segmented
                  ariaLabel="Backdrop"
                  value={backdrop}
                  onChange={setBackdrop}
                  options={[
                    { value: 'none', label: 'None' },
                    { value: 'scrim', label: 'Scrim' },
                    { value: 'panel', label: 'Panel' },
                  ]}
                />
                {backdrop !== 'none' && (
                  <span className="slider">
                    <input
                      type="range"
                      min={0}
                      max={95}
                      step={5}
                      value={opacity}
                      onChange={(e) => setOpacity(Number(e.target.value))}
                      aria-label="Backdrop strength"
                    />
                    <span className="slider__value">{opacity === 0 ? 'Clear' : `${opacity}%`}</span>
                  </span>
                )}
              </div>
              <p className="onb-backdrop__hint">
                {BACKDROP_HINT[backdrop]}
                {backdrop !== 'none' && opacity < BG_OPACITY_DEFAULT && ` Below ${BG_OPACITY_DEFAULT}%, small text can be hard to read over a white window.`}
              </p>
            </div>
            <p className="onb__fine">
              Change any of this later in Display &amp; HUD: right-click the Desktop HUD icon in the taskbar’s tray.
            </p>
          </section>
        )}
      </div>

      {error && <p className="banner banner--warn">{error}</p>}
      <footer className="modal__foot pres__foot onb__foot">
        <button className="btn btn--quiet" onClick={() => void skipAll()} disabled={busy}>
          Skip set-up
        </button>
        <span className="modal__spacer" />
        {step > 0 && (
          <button className="btn btn--ghost" onClick={() => setStep(step - 1)} disabled={busy}>
            Back
          </button>
        )}
        <button className="btn btn--ghost" onClick={() => void skip()} disabled={busy}>
          {step === 2 ? 'Skip and finish' : 'Skip this step'}
        </button>
        <button className="btn btn--primary modal__primary" onClick={() => void next()} disabled={busy || !canNext}>
          {busy ? 'One moment…' : step === 2 ? 'Finish' : step === 1 && url.trim() ? 'Add and continue' : 'Next'}
        </button>
      </footer>
    </Frame>
  );
}

/** The window: a draggable title bar with the three steps, and a way out. */
function Frame({ step, onClose, children }: { step: number; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal modal--window">
      <section className="modal__panel pres pres--wide onb" aria-label="Set up Desktop HUD">
        <header className="modal__head pres__head is-drag">
          <h2 className="q-title">Set up Desktop HUD</h2>
          <ol className="onb__steps" aria-label="Steps">
            {STEPS.map((s, i) => (
              <li key={s} className={i === step ? 'is-now' : i < step ? 'is-past' : undefined} aria-current={i === step ? 'step' : undefined}>
                <span className="onb__num q-num">{i + 1}</span>
                {s}
              </li>
            ))}
          </ol>
          <span className="modal__spacer" />
          <button className="btn btn--icon" onClick={onClose} title="Close (set-up opens again next time)" aria-label="Close set-up">
            <IconClose />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

