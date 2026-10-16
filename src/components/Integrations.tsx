// Display & HUD → Integrations (Phase 9.5): where the HUD's data comes from.
//
// One card per slot — Calendars, Notes, Now playing — each with a status
// light, the action that fits (Connect, Disconnect, Fix), and a plain line
// saying what it reads and what it writes. Unlike the other tabs these act at
// once, through main: nothing here is part of the Display & HUD draft, and
// Cancel doesn't undo a calendar you added. Notes and the player are read when
// the app starts, so those two say so and offer a restart.
//
// Trust rules (Phase 9 plan, S1/S3/S13): a calendar link is a secret — it goes
// in once and is never shown back; a notes folder comes only from main's own
// folder dialog, so the window never names a path; a user's folder is
// read-only until they turn writing on, and the switch names the only two
// writes.

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { exportSettings, removeAllData, saveDiagnostics } from '../lib/shell';
import {
  addCalendarFile,
  addCalendarLink,
  applyNotes,
  calendarSources,
  calendarSyncStatus,
  chooseNotesFolder,
  connectGoogle,
  disconnectGoogle,
  googleStatus,
  notesSettings,
  notesStatus,
  nowPlayingSettings,
  onCalendarChange,
  onEventsChange,
  onGoogleChange,
  readNowPlaying,
  refreshCalendars,
  removeCalendar,
  restartApp,
  setNotesWrite,
  setNowPlayingPlayer,
} from '../lib/shell';
import type { CalendarSource, FolderPick, NotesSettings, NotesStatus } from '../lib/shell';
import type { CalSyncStatus, GoogleStatus } from '../lib/types';
import { Row, Segmented, Toggle } from './controls';

/** A status light: on (cobalt), needs fixing (crimson), or off (slate). */
export type Health = 'ok' | 'bad' | 'off';

export function StatusDot({ health, label }: { health: Health; label?: string }) {
  return (
    <span
      className={`cal-state${health === 'ok' ? ' is-ok' : health === 'bad' ? ' is-bad' : ''}`}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

/** A card's head: the light, the name, where it stands, and what it reads and writes. */
function IntegHead({
  title,
  health,
  status,
  reads,
  writes,
}: {
  title: string;
  health: Health;
  status: string;
  reads: ReactNode;
  writes: ReactNode;
}) {
  return (
    <header className="card__head integ__head">
      <div className="integ__title">
        <StatusDot health={health} />
        <h3>{title}</h3>
        <span className={`integ__status integ__status--${health}`}>{status}</span>
      </div>
      <dl className="integ__rw">
        <div>
          <dt>Reads</dt>
          <dd>{reads}</dd>
        </div>
        <div>
          <dt>Writes</dt>
          <dd>{writes}</dd>
        </div>
      </dl>
    </header>
  );
}

/** "2m ago" for the last good read of a calendar. */
export function agoLabel(ms: number, now = Date.now()): string {
  const mins = Math.round((now - ms) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function IntegrationsTab() {
  return (
    <div className="pres__body integ">
      <CalendarCard />
      <NotesCard />
      <NowPlayingCard />
      <DataCard />
    </div>
  );
}

// ---- your data (Phase 9.6) -----------------------------------------------------

/** Diagnostics for a bug report, a settings export, and removing everything
 *  the app keeps on this PC (each asks or picks a place in main first). */
function DataCard() {
  return (
    <section className="card integ__card">
      <IntegHead
        title="Your data"
        health="ok"
        status="On this PC only"
        reads="Nothing is sent anywhere except your calendar links, to fetch them."
        writes="Settings, encrypted calendar links, a calendar cache and note backups, in your Windows profile."
      />
      <Row label="Diagnostics" hint="A text file for a bug report. Links, file paths and email addresses are removed; no notes, links or secrets.">
        <button className="btn btn--ghost" onClick={() => saveDiagnostics()}>
          Save diagnostics…
        </button>
      </Row>
      <Row label="Export settings" hint="Your settings as a file, to keep or move to another PC. Calendar links aren’t included.">
        <button className="btn btn--ghost" onClick={() => exportSettings()}>
          Export…
        </button>
      </Row>
      <Row label="Remove all my data" hint="Deletes everything Desktop HUD keeps on this PC and quits. Your own notes folder is never touched. It asks first.">
        <button className="btn btn--quiet btn--danger" onClick={() => removeAllData()}>
          Remove all my data…
        </button>
      </Row>
    </section>
  );
}

// ---- calendars -------------------------------------------------------------------

/** Where to find a calendar's private link, for the four places most people's
 *  calendars live. Kept short: a stranger needs the menu path, not a manual. */
export function IcsHelp({ open }: { open?: boolean }) {
  return (
    <details className="icshelp" open={open}>
      <summary>Where do I find my calendar link?</summary>
      <dl>
        <div>
          <dt>Google Calendar</dt>
          <dd>
            On a computer, open Google Calendar → Settings (the gear) → Settings. Under <i>Settings for my calendars</i>, pick
            the calendar, then <i>Integrate calendar</i>. Copy the <i>Secret address in iCal format</i>.
          </dd>
        </div>
        <div>
          <dt>Outlook</dt>
          <dd>
            In Outlook on the web: Settings → Calendar → Shared calendars → <i>Publish a calendar</i>. Choose the calendar and{' '}
            <i>Can view all details</i>, press Publish, then copy the <i>ICS</i> link.
          </dd>
        </div>
        <div>
          <dt>Apple iCloud</dt>
          <dd>
            In Calendar on iCloud.com (or on an iPhone), open the calendar’s sharing options and turn on <i>Public Calendar</i>.
            Copy the link it shows (it starts with webcal://). Anyone with that link can see the calendar.
          </dd>
        </div>
        <div>
          <dt>University or Canvas timetable</dt>
          <dd>
            In Canvas, open Calendar and choose <i>Calendar Feed</i> (bottom right), then copy the link. Most timetable sites
            have a similar <i>Subscribe</i> or <i>Export to calendar (iCal)</i> link.
          </dd>
        </div>
      </dl>
      <p className="icshelp__note">Or download the calendar as an .ics file and add the file instead. A file doesn’t update by itself.</p>
    </details>
  );
}

/**
 * Calendars (Phase 9.4, on this tab since 9.5): the events slot's sources —
 * any number of calendar links and .ics files. A link is a secret: it goes in
 * once and is never shown again. An add-on account (Google, in the owner's
 * build) appears below the links when there is one.
 */
function CalendarCard() {
  const [sources, setSources] = useState<CalendarSource[]>([]);
  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const [sync, setSync] = useState<CalSyncStatus | null>(null);
  /** The add-a-link form, and the source it replaces when it's a Fix. */
  const [adding, setAdding] = useState<{ replaces: string | null } | null>(null);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [, bump] = useState(0);

  useEffect(() => {
    const refresh = () => {
      calendarSources().then(setSources);
      googleStatus().then(setGoogle);
      calendarSyncStatus().then(setSync);
    };
    refresh();
    const offEvents = onEventsChange(refresh);
    const offGoogle = onGoogleChange(refresh);
    const offCal = onCalendarChange(setSync);
    // Keep "3m ago" honest while the window sits open.
    const id = window.setInterval(() => bump((t) => t + 1), 30_000);
    return () => {
      offEvents();
      offGoogle();
      offCal();
      window.clearInterval(id);
    };
  }, []);

  const closeForm = () => {
    setAdding(null);
    setUrl('');
    setName('');
  };
  const addLink = async () => {
    setBusy(true);
    setMsg(null);
    const r = await addCalendarLink(name, url);
    if (r.ok && adding?.replaces) await removeCalendar(adding.replaces);
    setBusy(false);
    if (!r.ok) return setMsg(r.error ?? 'Could not add that calendar.');
    closeForm();
    setSources(await calendarSources());
  };
  const addFile = async () => {
    setMsg(null);
    const r = await addCalendarFile('');
    if (!r.ok && !r.canceled) setMsg(r.error ?? 'Could not add that file.');
    setSources(await calendarSources());
  };
  const remove = async (id: string) => {
    await removeCalendar(id);
    setSources(await calendarSources());
  };
  const refreshAll = async () => {
    setBusy(true);
    await refreshCalendars();
    setBusy(false);
    setSources(await calendarSources());
  };
  const connect = async () => {
    setBusy(true);
    setMsg(null);
    const r = await connectGoogle();
    setBusy(false);
    if (!r.ok) setMsg(r.error ? `Could not connect: ${r.error}` : 'Could not connect.');
    setGoogle(await googleStatus());
  };
  const disconnect = async () => {
    await disconnectGoogle();
    setGoogle(await googleStatus());
    setSync(await calendarSyncStatus());
  };

  const sourceHint = (c: CalendarSource) => {
    if (c.lastError) return `Not updating — ${c.lastError}${c.fetchedAt ? ` (last good copy from ${agoLabel(c.fetchedAt)})` : ''}`;
    const what = c.kind === 'ics-file' ? c.file ?? 'File' : 'Calendar link';
    const when = c.fetchedAt ? `updated ${agoLabel(c.fetchedAt)}` : 'not read yet';
    return [`${what} · ${when} · ${c.count} event${c.count === 1 ? '' : 's'}`, c.warning].filter(Boolean).join(' · ');
  };

  const failing = Boolean(google?.connected && sync && (sync.lastError || sync.tokenGone));
  const googleHint = !google?.connected
    ? 'Not connected'
    : failing
      ? `Sync failing — ${sync?.tokenGone ? 'sync token gone' : sync?.lastError}`
      : sync?.lastSyncAt
        ? `Synced ${agoLabel(sync.lastSyncAt)} · ${sync.count} event${sync.count === 1 ? '' : 's'}`
        : sync?.syncing
          ? 'Syncing…'
          : 'Not synced yet';

  const count = sources.length + (google?.connected ? 1 : 0);
  const broken = sources.filter((c) => c.lastError).length + (failing ? 1 : 0);
  const health: Health = broken > 0 ? 'bad' : count > 0 ? 'ok' : 'off';
  const status =
    broken > 0
      ? `${broken} not updating`
      : count === 0
        ? 'None yet'
        : `${count} connected`;

  return (
    <section className="card integ__card">
      <IntegHead
        title="Calendars"
        health={health}
        status={status}
        reads="Your calendar links and .ics files. Links are checked every 15 minutes."
        writes="Nothing. Desktop HUD never changes a calendar."
      />
      <p className="integ__lead">
        Calendars feed Next up, the Today radar, focus mode and the idle screen. Most calendar apps offer a private link (an
        address ending in .ics) in their sharing settings.
      </p>
      {sources.length === 0 && !google?.configured && <p className="card__empty">No calendars yet.</p>}
      {sources.map((c) => (
        <Row key={c.id} label={c.name} hint={sourceHint(c)}>
          <StatusDot health={c.lastError ? 'bad' : c.fetchedAt ? 'ok' : 'off'} />
          {c.lastError && c.kind === 'ics-url' && (
            <button
              className="btn btn--ghost"
              onClick={() => {
                setName(c.name);
                setAdding({ replaces: c.id });
              }}
            >
              Fix…
            </button>
          )}
          <button className="btn btn--quiet btn--danger" onClick={() => remove(c.id)} aria-label={`Remove ${c.name}`}>
            Remove
          </button>
        </Row>
      ))}
      {google?.configured && (
        <Row label={google.connected ? google.email ?? 'Google Calendar' : 'Google Calendar'} hint={googleHint}>
          <StatusDot health={google.connected && !failing ? 'ok' : failing ? 'bad' : 'off'} />
          {google.connected && (
            <button className="btn btn--quiet btn--danger" onClick={disconnect}>
              Disconnect
            </button>
          )}
          <button className={google.connected ? 'btn btn--ghost' : 'btn btn--primary'} onClick={connect} disabled={busy}>
            {busy ? 'Waiting…' : google.connected ? 'Reconnect' : 'Connect'}
          </button>
        </Row>
      )}
      {msg && <p className="banner banner--warn">{msg}</p>}
      {adding && (
        <div className="cal-add">
          {adding.replaces && (
            <p className="card__note">Paste the calendar’s link again (or a new one). The old one is removed once this one works.</p>
          )}
          <input
            type="text"
            value={name}
            placeholder="Name (e.g. Work)"
            aria-label="Calendar name"
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
          />
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
              if (e.key === 'Enter' && url.trim()) addLink();
            }}
          />
          <p className="card__note">The link is stored encrypted on this PC and is never shown again. Anyone with it can read the calendar.</p>
        </div>
      )}
      <div className="card__foot">
        {adding ? (
          <>
            <button className="btn btn--quiet" onClick={closeForm}>
              Cancel
            </button>
            <button className="btn btn--primary" onClick={addLink} disabled={busy || !url.trim()}>
              {busy ? 'Checking…' : adding.replaces ? 'Replace link' : 'Add calendar'}
            </button>
          </>
        ) : (
          <>
            <button className="btn btn--primary" onClick={() => setAdding({ replaces: null })}>
              Add calendar link
            </button>
            <button className="btn btn--ghost" onClick={addFile}>
              Add .ics file…
            </button>
            {sources.length > 0 && (
              <button className="btn btn--quiet" onClick={refreshAll} disabled={busy}>
                {busy ? 'Refreshing…' : 'Refresh now'}
              </button>
            )}
          </>
        )}
      </div>
      <IcsHelp />
    </section>
  );
}

// ---- notes -----------------------------------------------------------------------

/** The note conventions a folder is read with, as the form edits them. */
export interface NotesForm {
  weeklyDir: string;
  dailyDir: string;
  backlogPath: string;
  taskTag: string;
  taskFolders: string;
  write: boolean;
}

/** What detect-and-suggest found in a picked folder, in one plain line. */
export function detectedLine(pick: FolderPick): string {
  const d = pick.detected;
  if (!d) return 'Nothing recognised yet; set the folders below.';
  const bits = [
    d.obsidian ? 'an Obsidian vault' : 'a folder of notes',
    d.weeklyDir ? `${d.weeks} weekly note${d.weeks === 1 ? '' : 's'} in ${d.weeklyDir}` : null,
    d.dailyDir ? `${d.days} daily note${d.days === 1 ? '' : 's'} in ${d.dailyDir}` : null,
    d.backlogPath ? `a backlog in ${d.backlogPath}` : null,
  ].filter(Boolean);
  return `Found ${bits.join(', ')}.`;
}

/** The suggested conventions for a picked folder; writing always starts off. */
export function formFromPick(pick: FolderPick, base?: Partial<NotesForm>): NotesForm {
  const d = pick.detected;
  return {
    weeklyDir: d?.weeklyDir ?? base?.weeklyDir ?? 'Weekly',
    dailyDir: d?.dailyDir ?? base?.dailyDir ?? '',
    backlogPath: d?.backlogPath ?? base?.backlogPath ?? 'Backlog.md',
    taskTag: base?.taskTag || '#thisweek',
    taskFolders: base?.taskFolders ?? '',
    write: false,
  };
}

/** The write switch's words: exactly what gets written, and nothing else. */
export function writeHint(f: Pick<NotesForm, 'backlogPath' | 'weeklyDir'>): string {
  return `Off: Desktop HUD only reads this folder. On: it writes two things only — a line you quick-capture goes into ${
    f.backlogPath || 'your backlog note'
  }, and Open this week (tray menu or Ctrl+Alt+W) creates this week’s note in ${
    f.weeklyDir || 'your weekly folder'
  } if there isn’t one. Each write is checked against the file first and backed up. It never deletes or renames a file.`;
}

/** The conventions as fields. `scan` adds the scan-folders field. */
export function NotesFields({
  form,
  set,
  scan,
}: {
  form: NotesForm;
  set: (patch: Partial<NotesForm>) => void;
  scan?: boolean;
}) {
  return (
    <div className="notes-fields">
      <label className="fld">
        <span className="fld__label">Weekly notes folder</span>
        <span className="fld__control">
          <input value={form.weeklyDir} placeholder="Weekly" maxLength={200} onChange={(e) => set({ weeklyDir: e.target.value })} />
        </span>
        <span className="fld__hint">One note per week, named like 2026-W42.</span>
      </label>
      <label className="fld">
        <span className="fld__label">Daily notes folder</span>
        <span className="fld__control">
          <input value={form.dailyDir} placeholder="None" maxLength={200} onChange={(e) => set({ dailyDir: e.target.value })} />
        </span>
        <span className="fld__hint">Named like 2026-10-15. Leave empty if you don’t keep them.</span>
      </label>
      <label className="fld">
        <span className="fld__label">Backlog note</span>
        <span className="fld__control">
          <input value={form.backlogPath} placeholder="Backlog.md" maxLength={200} onChange={(e) => set({ backlogPath: e.target.value })} />
        </span>
        <span className="fld__hint">Where quick capture puts a line (when writing is on).</span>
      </label>
      <label className="fld">
        <span className="fld__label">This-week tag</span>
        <span className="fld__control">
          <input value={form.taskTag} placeholder="#thisweek" maxLength={64} onChange={(e) => set({ taskTag: e.target.value })} />
        </span>
        <span className="fld__hint">Tasks with this tag anywhere count as this week’s.</span>
      </label>
      {scan && (
        <label className="fld fld--wide">
          <span className="fld__label">Folders to scan for tagged tasks</span>
          <span className="fld__control">
            <input
              value={form.taskFolders}
              placeholder="The whole folder"
              maxLength={500}
              onChange={(e) => set({ taskFolders: e.target.value })}
            />
          </span>
          <span className="fld__hint">Comma-separated, inside your notes folder. Empty scans the whole folder.</span>
        </label>
      )}
    </div>
  );
}

/**
 * Notes (Phase 9.4, rebuilt for 9.5): the built-in store or the user's own
 * folder, its conventions, and the write switch. Changing the folder or a
 * convention applies after a restart; the write switch for the current folder
 * applies at once, as before.
 */
function NotesCard() {
  const [status, setStatus] = useState<NotesStatus | null>(null);
  const [saved, setSaved] = useState<NotesSettings | null>(null);
  const [form, setForm] = useState<NotesForm | null>(null);
  /** A new source waiting for Apply: a picked folder, or the built-in notes. */
  const [next, setNext] = useState<{ use: 'picked'; pick: FolderPick } | { use: 'builtin' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [restartDue, setRestartDue] = useState(false);

  const load = async () => {
    const [st, s] = await Promise.all([notesStatus(), notesSettings()]);
    setStatus(st);
    setSaved(s);
    if (s) setForm({ weeklyDir: s.weeklyDir, dailyDir: s.dailyDir, backlogPath: s.backlogPath, taskTag: s.taskTag, taskFolders: s.taskFolders, write: s.write });
  };
  useEffect(() => {
    void load();
  }, []);
  if (!status || !saved || !form) return null;

  const set = (patch: Partial<NotesForm>) => setForm({ ...form, ...patch });
  const folder = saved.kind === 'folder';
  const showingFolder = next ? next.use === 'picked' : folder;
  const dirty =
    next != null ||
    (folder &&
      (form.weeklyDir !== saved.weeklyDir ||
        form.dailyDir !== saved.dailyDir ||
        form.backlogPath !== saved.backlogPath ||
        form.taskTag !== saved.taskTag ||
        form.taskFolders !== saved.taskFolders));

  const choose = async () => {
    setMsg(null);
    const pick = await chooseNotesFolder();
    if (!pick.ok) {
      if (!pick.canceled) setMsg('Could not open that folder.');
      return;
    }
    setNext({ use: 'picked', pick });
    setForm(formFromPick(pick, form));
  };
  const toggleWrite = async (on: boolean) => {
    if (next?.use === 'picked') return set({ write: on });
    if (await setNotesWrite(on)) {
      set({ write: on });
      setSaved({ ...saved, write: on });
    } else setMsg('Could not change that setting.');
  };
  const apply = async () => {
    setBusy(true);
    setMsg(null);
    const use = next?.use ?? 'current';
    const r = await applyNotes(
      use === 'builtin'
        ? { use }
        : {
            use,
            weeklyDir: form.weeklyDir.trim(),
            dailyDir: form.dailyDir.trim(),
            backlogPath: form.backlogPath.trim(),
            taskTag: form.taskTag.trim(),
            taskFolders: form.taskFolders.trim(),
            write: form.write,
          },
    );
    setBusy(false);
    if (!r.ok) return setMsg(r.error ?? 'Could not save the notes settings.');
    // Saved; the notes provider is built at start-up. If the restart doesn't
    // happen (it can't in a plain browser), say so and offer it again.
    setRestartDue(true);
    await restartApp();
  };
  const revert = () => {
    setNext(null);
    setMsg(null);
    setForm({ weeklyDir: saved.weeklyDir, dailyDir: saved.dailyDir, backlogPath: saved.backlogPath, taskTag: saved.taskTag, taskFolders: saved.taskFolders, write: saved.write });
  };

  const missing = folder && !status.ready && !next;
  const health: Health = missing ? 'bad' : 'ok';
  const statusText = missing
    ? 'Folder not found'
    : folder
      ? `“${saved.name}” · ${status.canWrite ? 'writing on' : 'read-only'}`
      : 'Built-in notes';

  return (
    <section className="card integ__card integ__card--notes">
      <IntegHead
        title="Notes"
        health={health}
        status={statusText}
        reads={
          folder
            ? 'Markdown notes in your folder: this week’s note, today’s note, your backlog and tagged tasks. Nothing leaves this PC.'
            : 'Desktop HUD’s own folder of plain Markdown notes, kept with its settings on this PC.'
        }
        writes={
          folder
            ? status.canWrite
              ? 'Two things only: quick-capture lines into the backlog note, and this week’s note when you open the week.'
              : 'Nothing. Your folder is read-only until you turn writing on below.'
            : 'Its own notes only: quick-capture lines and this week’s note.'
        }
      />

      {missing && (
        <p className="banner banner--warn">
          Desktop HUD can’t find “{saved.name}”. It may have been moved or renamed. Choose it again, or use the built-in notes.
        </p>
      )}

      <div className="notes-src">
        <div className="notes-src__now">
          <span className="notes-src__label">{next ? 'After restart' : 'Using'}</span>
          <span className="notes-src__name">
            {next?.use === 'picked'
              ? `Your folder “${next.pick.name}”`
              : next?.use === 'builtin'
                ? 'Built-in notes'
                : folder
                  ? `Your folder “${saved.name}”`
                  : 'Built-in notes'}
          </span>
          {next?.use === 'picked' && <span className="notes-src__found">{detectedLine(next.pick)}</span>}
        </div>
        <span className="notes-src__actions">
          <button className={missing ? 'btn btn--primary' : 'btn btn--ghost'} onClick={choose}>
            {missing ? 'Fix: choose the folder…' : folder || next ? 'Change folder…' : 'Use my notes folder…'}
          </button>
          {(folder || next?.use === 'picked') && next?.use !== 'builtin' && (
            <button className="btn btn--quiet" onClick={() => setNext({ use: 'builtin' })}>
              {folder ? 'Disconnect: use built-in notes' : 'Use built-in notes'}
            </button>
          )}
        </span>
      </div>

      {showingFolder && (
        <>
          <Row label="Let Desktop HUD write here" hint={writeHint(form)}>
            <Toggle checked={form.write} ariaLabel="Let Desktop HUD write to your notes" onChange={toggleWrite} />
          </Row>
          <NotesFields form={form} set={set} scan />
        </>
      )}

      {msg && <p className="banner banner--warn">{msg}</p>}
      {restartDue ? (
        <div className="restart">
          <p>Saved. Desktop HUD reads notes when it starts, so this applies after a restart.</p>
          <button className="btn btn--primary" onClick={() => void restartApp()}>
            Restart now
          </button>
        </div>
      ) : (
        <div className="card__foot">
          <button className="btn btn--primary" onClick={apply} disabled={!dirty || busy}>
            {busy ? 'Saving…' : 'Apply and restart'}
          </button>
          {dirty && (
            <button className="btn btn--quiet" onClick={revert}>
              Undo changes
            </button>
          )}
        </div>
      )}
    </section>
  );
}

// ---- now playing -------------------------------------------------------------------

/**
 * Now playing (Phase 9.4's any-player reader): what Windows' media controls
 * report, from the playing session first. One app only narrows it to a player
 * by name. Read at start-up, so a change offers a restart.
 */
function NowPlayingCard() {
  const [saved, setSaved] = useState<string | null>(null);
  const [mode, setMode] = useState<'any' | 'one'>('any');
  const [app, setApp] = useState('');
  const [playing, setPlaying] = useState<string | null | undefined>(undefined);
  const [msg, setMsg] = useState<string | null>(null);
  const [restartDue, setRestartDue] = useState(false);

  useEffect(() => {
    nowPlayingSettings().then((s) => {
      const p = s?.player ?? '';
      setSaved(p);
      setMode(p ? 'one' : 'any');
      setApp(p);
    });
    readNowPlaying().then((np) => setPlaying(np ? [np.title, np.artist].filter(Boolean).join(' · ') : null));
  }, []);
  if (saved == null) return null;

  const wanted = mode === 'any' ? '' : app.trim().toLowerCase();
  const dirty = wanted !== saved && !(mode === 'one' && !wanted);
  const apply = async () => {
    setMsg(null);
    const r = await setNowPlayingPlayer(wanted);
    if (!r.ok) return setMsg(r.error ?? 'Could not save that.');
    setSaved(wanted);
    setRestartDue(true);
    await restartApp();
  };

  return (
    <section className="card integ__card">
      <IntegHead
        title="Now playing"
        health="ok"
        status={saved ? `Only ${saved}` : 'Any player'}
        reads="The title, artist, cover and progress your music or video app shows in Windows’ media controls."
        writes="Nothing. It can’t play, pause or skip."
      />
      <p className="integ__lead">
        {playing === undefined ? ' ' : playing ? `Playing now: ${playing}` : 'Nothing is playing right now. The bubble shows while something plays.'}
      </p>
      <Row label="Show music from" hint={mode === 'one' ? 'The app’s name as Windows knows it, like spotify or chrome.' : 'Whichever app is playing.'}>
        <Segmented
          ariaLabel="Show music from"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'any', label: 'Any player' },
            { value: 'one', label: 'One app only' },
          ]}
        />
      </Row>
      {mode === 'one' && (
        <label className="fld">
          <span className="fld__label">App name</span>
          <span className="fld__control">
            <input value={app} placeholder="spotify" maxLength={40} spellCheck={false} onChange={(e) => setApp(e.target.value)} />
          </span>
        </label>
      )}
      {msg && <p className="banner banner--warn">{msg}</p>}
      {restartDue ? (
        <div className="restart">
          <p>Saved. It applies the next time Desktop HUD starts.</p>
          <button className="btn btn--primary" onClick={() => void restartApp()}>
            Restart now
          </button>
        </div>
      ) : (
        <div className="card__foot">
          <button className="btn btn--primary" onClick={apply} disabled={!dirty}>
            Apply and restart
          </button>
        </div>
      )}
    </section>
  );
}
