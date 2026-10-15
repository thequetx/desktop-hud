// Small presentational controls shared by Display & HUD, the Integrations page
// and the set-up wizard. Each wraps a native input or button, so the values and
// events are exactly what a plain checkbox or select would produce.

import type { ReactNode } from 'react';

/** A switch. Still a checkbox underneath (keyboard, forms, screen readers). */
export function Toggle({
  checked,
  onChange,
  children,
  title,
  ariaLabel,
  small,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  children?: ReactNode;
  title?: string;
  ariaLabel?: string;
  small?: boolean;
}) {
  return (
    // Clicks stop here so toggling a row's switch doesn't also select the row
    // (the old checkbox did the same with its own stopPropagation).
    <label className={small ? 'tgl tgl--sm' : 'tgl'} title={title} onClick={(e) => e.stopPropagation()}>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="tgl__track" aria-hidden="true" />
      {children && <span className="tgl__label">{children}</span>}
    </label>
  );
}

/** A row of mutually exclusive buttons — for short choices a select hides. */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <span className={`seg${className ? ` ${className}` : ''}`} role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          className={o.value === value ? 'is-on' : undefined}
          aria-pressed={o.value === value}
          title={o.title}
          onClick={(e) => {
            e.preventDefault();
            onChange(o.value);
          }}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}


export function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="srow">
      <span className="srow__text">
        <span className="srow__label">{label}</span>
        {hint && <span className="srow__hint">{hint}</span>}
      </span>
      <span className="srow__control">{children}</span>
    </div>
  );
}

