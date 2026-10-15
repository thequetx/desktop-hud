'use strict';
// iCalendar to wire events, with hard caps (Phase 9.4, trust model S3).
//
// Runs inside the ICS worker (electron/ics-worker.cjs, a utilityProcess), never
// in the main process: one hostile recurrence rule there would freeze the tray
// and the hide-all hotkey, which are the user's way out. The worker also has a
// time limit; these caps bound the work it can be asked to do at all.
//
// Moved from the renderer (src/lib/ics.ts), with three changes:
// - caps on events, total recurrence steps and occurrences, across the file;
// - the per-event step limit is generous enough to walk a daily rule that
//   started years ago into the window (the old limit of 1000 silently dropped
//   any rule older than about three years);
// - events come out as wire events (ISO strings), tagged with their source.

const ICAL = require('ical.js');

const LIMITS = {
  /** VEVENTs in one file. */
  maxEvents: 50_000,
  /** Recurrence steps for one rule, from its start into the window. */
  maxStepsPerEvent: 50_000,
  /** Recurrence steps across the whole file. */
  maxSteps: 500_000,
  /** Occurrences returned across the whole file. */
  maxOccurrences: 20_000,
};

/**
 * Concrete occurrences in `text` that overlap [minMs, maxMs]. Recurring events
 * are expanded and RECURRENCE-ID overrides applied. Returns
 * `{ events, truncated }`; `truncated` names the cap that was hit, if any.
 */
function parseIcs(text, minMs, maxMs, limits = LIMITS) {
  const comp = new ICAL.Component(ICAL.parse(String(text)));
  const vevents = comp.getAllSubcomponents('vevent');
  let truncated = null;
  if (vevents.length > limits.maxEvents) truncated = 'events';

  const masters = [];
  const exceptions = [];
  for (const v of vevents.slice(0, limits.maxEvents)) {
    const ev = new ICAL.Event(v);
    if (ev.isRecurrenceException()) exceptions.push(ev);
    else masters.push(ev);
  }
  const byUid = new Map();
  for (const m of masters) if (!byUid.has(m.uid)) byUid.set(m.uid, m);
  for (const ex of exceptions) {
    const master = byUid.get(ex.uid);
    if (master) master.relateException(ex);
  }

  const out = [];
  let steps = 0;
  const full = () => {
    if (out.length >= limits.maxOccurrences) {
      truncated = truncated || 'occurrences';
      return true;
    }
    return false;
  };

  outer: for (const master of masters) {
    if (full()) break;
    if (!master.startDate) continue;
    if (master.isRecurring()) {
      const iter = master.iterator();
      let next;
      let local = 0;
      while ((next = iter.next())) {
        if (++steps > limits.maxSteps) {
          truncated = truncated || 'steps';
          break outer;
        }
        if (++local > limits.maxStepsPerEvent) {
          truncated = truncated || 'steps';
          break;
        }
        if (next.toJSDate().getTime() > maxMs) break;
        const det = master.getOccurrenceDetails(next);
        const s = det.startDate.toJSDate();
        const e = det.endDate.toJSDate();
        if (e.getTime() < minMs) continue;
        out.push(wire(det.item, s, e));
        if (full()) break outer;
      }
    } else {
      const s = master.startDate.toJSDate();
      const e = master.endDate ? master.endDate.toJSDate() : s;
      if (e.getTime() < minMs || s.getTime() > maxMs) continue;
      out.push(wire(master, s, e));
    }
  }

  out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return { events: out, truncated };
}

function wire(ev, start, end) {
  const description = ev.description ? String(ev.description).slice(0, 4000) : undefined;
  return {
    uid: String(ev.uid || ''),
    title: String(ev.summary || '(untitled)').slice(0, 500),
    description,
    start: start.toISOString(),
    end: end.toISOString(),
    allDay: Boolean(ev.startDate && ev.startDate.isDate),
  };
}

module.exports = { parseIcs, LIMITS };
