import { useEffect, useRef, useState } from 'react';
import { appendBacklog, hideCapture } from '../lib/shell';

/**
 * Quick capture — Phase 5 §6's "missing inbox".
 *
 * One line, one hotkey (`Ctrl+Alt+N`), straight into `Backlog.md`. The
 * diagnosis in the plan is that the holding pen has held a single blank
 * checkbox since the day it was created *because* there was nowhere
 * frictionless to put a thought — so the whole design goal here is that it
 * costs nothing: no window to find, no field to click, no save button, and
 * `Esc` gets you out without leaving a trace.
 *
 * Deliberately not a task editor. Metadata (`📅`, `~90m`, a `#tag`) is typeable
 * because it is just text on the line and Phase 5 §1's parser reads it later —
 * but nothing here nudges you toward filling any of it in, because a capture
 * you have to think about is one you don't make.
 */
export function Capture() {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);

  // The window is summoned, so the caret has to already be in the field.
  useEffect(() => {
    ref.current?.focus();
  }, []);

  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 1400);
    return () => window.clearTimeout(t);
  }, [flash]);

  const save = async () => {
    const body = text.trim();
    if (!body || saving) return;
    setSaving(true);
    const r = await appendBacklog(body);
    setSaving(false);
    if (!r.ok) {
      setFlash(r.readOnly ? 'Writing to your notes is off (Display & HUD → Notes)' : "Couldn't write to the backlog");
      return;
    }
    // Cleared rather than closed: a thought rarely arrives alone, and having to
    // press the hotkey again between two of them is exactly the friction this
    // is here to remove. `Esc` closes.
    setText('');
    setFlash('Added to the backlog');
    ref.current?.focus();
  };

  return (
    <div className="capture">
      <label className="capture__label q-label" htmlFor="capture-input">
        Capture
      </label>
      <input
        id="capture-input"
        ref={ref}
        className="capture__input"
        value={text}
        placeholder="Anything — it lands in the backlog"
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void save();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            hideCapture();
          }
        }}
      />
      <p className="capture__hint">
        {flash ?? (saving ? 'Saving…' : 'Enter to add · Esc to close')}
      </p>
    </div>
  );
}
