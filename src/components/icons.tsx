// Small stroke icons for the HUD editor and arrange mode.
//
// Inline SVG rather than text glyphs (✎ ↶ ⠿ 🔒): the glyphs came from whatever
// font had them, sat on different baselines, and the emoji ones rendered in
// colour — which is most of why the old controls read as "blocky". These take
// `currentColor`, so a button's hover and disabled states style them for free.

import type { ReactNode } from 'react';

function Svg({ size = 16, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      className="ico"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

type P = { size?: number };

export const IconUp = (p: P) => (
  <Svg {...p}>
    <path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" />
  </Svg>
);
export const IconDown = (p: P) => (
  <Svg {...p}>
    <path d="M8 3.5v9M4.5 9 8 12.5 11.5 9" />
  </Svg>
);
export const IconEdit = (p: P) => (
  <Svg {...p}>
    <path d="M10.5 3.5 12.5 5.5 6 12H4v-2z" />
  </Svg>
);
export const IconClose = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
  </Svg>
);
export const IconPlus = (p: P) => (
  <Svg {...p}>
    <path d="M8 3.5v9M3.5 8h9" />
  </Svg>
);
export const IconUndo = (p: P) => (
  <Svg {...p}>
    <path d="M5.5 4 3 6.5 5.5 9" />
    <path d="M3 6.5h6.5a3 3 0 0 1 0 6H7" />
  </Svg>
);
export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
  </Svg>
);
export const IconLock = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
    <path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7" />
  </Svg>
);
export const IconEyeOff = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 8s2-4 5.5-4c1 0 1.9.3 2.6.8M13.5 8s-2 4-5.5 4c-1 0-1.9-.3-2.6-.8" />
    <path d="M3 13 13 3" />
  </Svg>
);
export const IconGrip = (p: P) => (
  <Svg {...p}>
    <g fill="currentColor" stroke="none">
      <circle cx="6" cy="4" r="1.1" />
      <circle cx="10" cy="4" r="1.1" />
      <circle cx="6" cy="8" r="1.1" />
      <circle cx="10" cy="8" r="1.1" />
      <circle cx="6" cy="12" r="1.1" />
      <circle cx="10" cy="12" r="1.1" />
    </g>
  </Svg>
);
export const IconMove = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="3" width="11" height="10" rx="2" />
    <path d="M9.5 6h2v2" />
  </Svg>
);
export const IconBack = (p: P) => (
  <Svg {...p}>
    <path d="M9.5 4 5.5 8l4 4" />
  </Svg>
);
export const IconCopy = (p: P) => (
  <Svg {...p}>
    <rect x="5.5" y="5.5" width="7" height="7" rx="1.5" />
    <path d="M10.5 5.5V4.5a1 1 0 0 0-1-1h-5a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h1" />
  </Svg>
);
export const IconTrash = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 4.5h9M6.5 4.5V3.5h3v1M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8" />
  </Svg>
);

/** One glyph per bubble type, for the template picker and the list. */
export const IconNote = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 2.5h5l2.5 2.5v8.5h-7.5z" />
    <path d="M6.5 8h3.5M6.5 10.5h3.5" />
  </Svg>
);
export const IconTasks = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="3" width="4" height="4" rx="1" />
    <path d="M3.5 5l.8.8L5.8 4.2M8.5 5h5M8.5 11h5" />
    <rect x="2.5" y="9" width="4" height="4" rx="1" />
  </Svg>
);
export const IconFields = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 4.5h3M2.5 8h3M2.5 11.5h3M7.5 4.5h6M7.5 8h6M7.5 11.5h4" />
  </Svg>
);
export const IconText = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 4h9M8 4v8.5M6 12.5h4" />
  </Svg>
);
export const IconBuiltin = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1.2" />
    <rect x="9" y="2.5" width="4.5" height="4.5" rx="1.2" />
    <rect x="2.5" y="9" width="4.5" height="4.5" rx="1.2" />
    <rect x="9" y="9" width="4.5" height="4.5" rx="1.2" />
  </Svg>
);
