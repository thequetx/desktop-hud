/**
 * The integration interface (Phase 9.0) — the seam every optional feature sits
 * behind: calendars, notes folders, now playing, and the owner's private
 * add-ons. Types only; nothing implements it yet. The design is in the vault:
 * `Phase 9 Universal Release.md`, "Architecture".
 *
 * Rules the types encode:
 * - An integration says what it `provides`, not one category: a future
 *   Todoist or Microsoft provider gives both events and tasks.
 * - `enable(ctx)` returns the only way to stop it, so there is no
 *   half-stopped state. Disabled means nothing runs: no timer, watcher, child
 *   process, server or tray entry.
 * - Bubbles are declarative. An integration returns data in one of a few
 *   shapes the core draws; it never ships UI, and an add-on returns JSON only,
 *   which keeps the door open to running community add-ons in isolation.
 * - Paths never cross from the renderer. A bubble asks for data by
 *   integration id and bubble id; the main process resolves everything else.
 * - Versions are separate per layer: this API, the config schema, and each
 *   integration's own settings.
 */

/** This API's major version. An add-on declaring another major is refused. */
export const INTEGRATION_API_VERSION = 1;

/** What a slot can be filled with. A slot may hold several sources. */
export type Capability = 'events' | 'tasks' | 'notes' | 'nowplaying';

/** The platforms an integration runs on; Windows only in v1. */
export type Platform = 'win32' | 'darwin' | 'linux';

/** One source in a slot: the user can add the same provider more than once. */
export interface SourceInstance<S = Record<string, unknown>> {
  /** Stable for the life of the source; namespaces its events and tasks. */
  instanceId: string;
  /** The integration that serves it, e.g. `ics`. */
  providerId: string;
  /** User-facing name, e.g. "Work calendar". */
  label: string;
  settings: S;
}

/** A settings field, deliberately minimal: core panels are hand-built. */
export type SettingField =
  | { key: string; label: string; kind: 'text' | 'folder' | 'file'; required?: boolean; help?: string }
  | { key: string; label: string; kind: 'secret'; required?: boolean; help?: string }
  | { key: string; label: string; kind: 'number'; min?: number; max?: number; help?: string }
  | { key: string; label: string; kind: 'toggle'; help?: string }
  | { key: string; label: string; kind: 'choice'; options: { value: string; label: string }[]; help?: string };

export interface SettingsSchema {
  /** The integration's own settings version; migrations run per section. */
  v: number;
  fields: SettingField[];
}

/** Shown on the Integrations page as a status dot and one line. */
export type IntegrationStatus =
  | { state: 'ok'; detail?: string; updatedAt?: number }
  | { state: 'needs-setup'; reason: string }
  | { state: 'stale'; reason: string; updatedAt: number }
  | { state: 'error'; reason: string }
  | { state: 'off' };

// ---- bubbles ----------------------------------------------------------------

/** The shapes the core knows how to draw. */
export type BubbleShape = 'list' | 'text' | 'fields' | 'media' | 'status';

export interface ListRow {
  text: string;
  done?: boolean;
  /** Right-aligned detail, e.g. a time. */
  meta?: string;
  /** Accent for urgency or state; the core maps it to its own palette. */
  tone?: 'normal' | 'muted' | 'warn' | 'alert';
}

export type BubbleData =
  | { shape: 'list'; rows: ListRow[]; empty?: string }
  | { shape: 'text'; text: string }
  | { shape: 'fields'; fields: { label: string; value: string }[] }
  | {
      shape: 'media';
      playing: boolean;
      title?: string;
      artist?: string;
      /** A data: URL only; the core never loads remote art (trust model S11). */
      cover?: string | null;
      queue?: { title: string; artist?: string }[];
    }
  | { shape: 'status'; label: string; value: string; tone?: ListRow['tone'] };

export interface BubbleSpec {
  /** Unique within the integration; the core namespaces it as `id:bubble`. */
  id: string;
  label: string;
  shape: BubbleShape;
  /** What the "add bubble" menu says it reads, naming the slot, not a product. */
  source: string;
  /** Focus mode: keep, hide, or replace this bubble. */
  focus: 'keep' | 'hide' | 'replace';
}

// ---- the integration itself ---------------------------------------------------

/** What the core hands an integration when it is enabled. */
export interface IntegrationContext<S = Record<string, unknown>> {
  /** This integration's sources (for slot providers) or its one settings block. */
  sources: SourceInstance<S>[];
  /** Encrypted with safeStorage; `set` refuses rather than store plaintext (S13). */
  secrets: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  };
  /** A folder of its own under userData, for caches. */
  dataDir: string;
  /** Logs are redacted by the core: never pass event titles, note text or URLs (S5). */
  log(level: 'info' | 'warn' | 'error', message: string): void;
  /** Tell the core that this integration's bubbles have new data. */
  changed(bubbleId?: string): void;
  /** The core's lifecycle signals, so nothing polls while the PC sleeps. */
  power: { onSuspend(fn: () => void): void; onResume(fn: () => void): void };
}

export interface Integration<S = Record<string, unknown>> {
  id: string;
  name: string;
  /** INTEGRATION_API_VERSION this was built against. */
  apiVersion: number;
  /** The lowest core version it runs on, e.g. `0.9.0`. */
  minCore: string;
  provides: Capability[];
  platforms: Platform[];
  settingsSchema: SettingsSchema;
  bubbles: BubbleSpec[];
  /** Start everything; return the only way to stop it. */
  enable(ctx: IntegrationContext<S>): Promise<() => Promise<void>>;
  status(): IntegrationStatus;
  /** Data for one of `bubbles`, as JSON. Called through `integration:read`. */
  read(bubbleId: string): Promise<BubbleData | null>;
}

// ---- slot providers -----------------------------------------------------------

/** An event, namespaced by source so several calendars can be merged. */
export interface SourcedEvent {
  sourceId: string;
  /** Unique within the source; the core dedupes on `sourceId:uid`. */
  uid: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
}

export interface EventsProvider extends Integration {
  /** Occurrences overlapping [from, to), recurrences expanded and capped. */
  events(sourceId: string, from: Date, to: Date): Promise<SourcedEvent[]>;
}

/**
 * What a notes provider can do. Every bubble and action is gated on the one it
 * needs, so a read-only folder (the default for a user's own folder, S1)
 * simply lacks the write capabilities.
 */
export type NotesCapability = 'read' | 'write' | 'roll' | 'taskIds' | 'query' | 'frontmatter';

/** A note, named by an id the provider resolves; never a path from the renderer. */
export type NoteRef = { kind: 'week'; weekId: string } | { kind: 'daily'; date: string } | { kind: 'note'; noteId: string };

export interface NoteTask {
  text: string;
  done: boolean;
  /** Opaque to the core: where the provider can find this line again. */
  ref: string;
  due?: string;
  priority?: 'highest' | 'high' | 'medium' | 'low' | 'lowest';
  minutes?: number;
}

export interface NotesProvider extends Integration {
  capabilities(sourceId: string): NotesCapability[];
  readWeek(sourceId: string, weekId: string): Promise<{ intentions: NoteTask[]; tasks: NoteTask[] } | null>;
  readList(sourceId: string, note: NoteRef, heading: string): Promise<NoteTask[] | null>;
  frontmatter?(sourceId: string, note: NoteRef): Promise<Record<string, string> | null>;
  /** Only when `write` is a capability. Refuses rather than guesses if the line moved. */
  setDone?(sourceId: string, task: NoteTask, done: boolean): Promise<{ ok: true } | { ok: false; reason: string }>;
  append?(sourceId: string, note: NoteRef, heading: string, text: string): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface NowPlayingProvider extends Integration {
  nowPlaying(): Promise<Extract<BubbleData, { shape: 'media' }> | null>;
}

// ---- add-on manifests ---------------------------------------------------------

/** `manifest.json` beside an add-on's `index.cjs` in the add-ons folder. */
export interface AddonManifest {
  id: string;
  name: string;
  apiVersion: number;
  minCore: string;
  main: 'index.cjs';
  platforms: Platform[];
}
