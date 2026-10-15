import type { ComponentType, ReactNode } from 'react';
import type { WidgetProps } from '../components/hud/widgets';
import type { Anchor, PresentationPrefs } from './presentation';
import type { CalEvent, SkeletonBlock, VaultTask } from './types';
import type { NowPlaying } from './widgets';

/**
 * Private add-ons, renderer side (Phase 9.3).
 *
 * The owner's add-ons are composed at build time: `src/addons-private/` is a
 * git-ignored link to the private repo, and `main.tsx` imports its
 * `index.tsx` if it exists, which calls registerAddon(). The public build has
 * no such folder, so nothing registers and no add-on code ships. There is no
 * runtime loading of code from anywhere (trust model S2).
 *
 * This module imports nothing at runtime, so an add-on can import core modules
 * without a cycle back through it.
 */

export interface AddonWidget {
  /** The bubble id; it must match the main process side's registration. */
  id: string;
  label: string;
  /** What the "add bubble" menu says it reads. */
  source: string;
  focus: 'keep' | 'hide' | 'replace';
  hasRows?: boolean;
  /** Called like a built-in: a plain function, so no hooks. Null draws nothing. */
  component: (p: WidgetProps) => ReactNode;
  /** Data from the add-on's main-process handler `name`, polled every `ms`
   *  while the bubble is on in a corner; it arrives as `p.data.addons[id]`. */
  poll?: { name: string; ms: number };
}

/** What a HUD decoration sees: the corner, its state, and the data the HUD has. */
export interface HudDecorationProps {
  anchor: Anchor;
  /** No bubble is drawn in this corner. */
  alone: boolean;
  /** This add-on's section of presentation.json (`addons.<id>`). */
  section: Record<string, unknown> | undefined;
  presentation: PresentationPrefs;
  events: CalEvent[];
  skeleton: SkeletonBlock[];
  tasks: VaultTask[];
  now: Date;
  /** The imminent block this corner shows, if any. */
  imminentKey: string | null;
  nowPlaying: NowPlaying | null;
  /** Now playing has a bubble in this corner. */
  nowPlayingHere: boolean;
  /** The HUD's row-count debug mode is on (dev hotkey). */
  debugging: boolean;
}

/** What a Clock extra sees: drawn at the end of the Clock bubble's line. */
export interface ClockExtraProps {
  /** This add-on's section of presentation.json (`addons.<id>`). */
  section: Record<string, unknown> | undefined;
  presentation: PresentationPrefs;
  events: CalEvent[];
  skeleton: SkeletonBlock[];
  now: Date;
}

/** An add-on's section in Display & HUD → Extras. */
export interface EditorSectionProps {
  section: Record<string, unknown> | undefined;
  /** Change this add-on's section; `immediate` previews at once, else debounced. */
  set: (patch: Record<string, unknown>, immediate?: boolean) => void;
  draft: PresentationPrefs;
}

export interface RendererAddon {
  id: string;
  widgets?: AddonWidget[];
  /** Drawn in every HUD corner (it decides whether it belongs there), as a React element. */
  hudDecoration?: {
    component: ComponentType<HudDecorationProps>;
    /** A label for the corner in arrange mode, or null. */
    arrangeLabel?: (p: { anchor: Anchor; section: Record<string, unknown> | undefined }) => ReactNode;
  };
  /** Drawn at the end of the Clock's line, as a React element; null draws nothing. */
  clockExtra?: ComponentType<ClockExtraProps>;
  /** Drawn on the idle screen, as a React element. */
  ambientDecoration?: ComponentType<{ section: Record<string, unknown> | undefined }>;
  /** True while it draws a live wallpaper behind the idle screen (Phase 9.5).
   *  The overlay then keeps its light scrim; otherwise it dims the desktop. */
  liveWallpaper?: (section: Record<string, unknown> | undefined) => boolean;
  /** Its settings, in Display & HUD → Extras. */
  editorSection?: ComponentType<EditorSectionProps>;
}

const widgets = new Map<string, AddonWidget & { addon: string }>();
const addons: RendererAddon[] = [];

export function registerAddon(addon: RendererAddon): void {
  if (addons.some((a) => a.id === addon.id)) return;
  addons.push(addon);
  for (const w of addon.widgets ?? []) {
    if (!widgets.has(w.id)) widgets.set(w.id, { ...w, addon: addon.id });
  }
}

/** Every registered add-on, in registration order (for the decoration slots). */
export function rendererAddons(): readonly RendererAddon[] {
  return addons;
}

/** The add-on widget with this bubble id, or null (no such add-on in this build). */
export function addonWidget(id: string): (AddonWidget & { addon: string }) | null {
  return widgets.get(id) ?? null;
}

export function addonWidgets(): (AddonWidget & { addon: string })[] {
  return [...widgets.values()];
}
