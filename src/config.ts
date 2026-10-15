export const SKELETON_URL = './config/week-skeleton.yaml';

// (The vault path lives only in the main process — WD_VAULT_PATH, read in
// electron/main.cjs. The renderer never sees a filesystem path; it goes through
// the vault:* IPC.)

// Week-grid geometry.
export const GRID = {
  startHour: 5, // first hour row shown
  endHour: 24, // last hour row shown (exclusive-ish)
  pxPerHour: 46,
} as const;

// How often the unattended views (ambient / HUD) re-read the recurring-blocks
// yaml — which can be edited outside the app — and the `.ics` fallback when
// Google isn't connected (ms). Neither of the two live paths is on this timer:
// the main process pushes calendar deltas (electron/calstore.cjs) and vault
// changes off a file watcher (electron/vault.cjs).
export const AMBIENT_REFRESH_MS = 5 * 60 * 1000;
