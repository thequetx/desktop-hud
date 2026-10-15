'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** @type {boolean | null} the HUD's last shown/hidden state, once told */
let lastHudShown = null;
ipcRenderer.on('hud:shown', (_e, shown) => {
  lastHudShown = shown === true;
});

contextBridge.exposeInMainWorld('wd', {
  isElectron: true,
  // The Display & HUD window closes itself; main reverts any unsaved preview.
  hideSettings: () => ipcRenderer.send('settings:hide'),
  // HUD asks the shell to shrink its window to the rendered content height.
  resizeHud: (height) => ipcRenderer.send('hud:resize', Math.ceil(height)),
  // The HUD was shown or hidden (Ctrl+Alt+H, the tray, an escalation). A
  // window created while the HUD is hidden still reports visibilityState
  // 'visible' until it has been shown and hidden once, so the page can't tell
  // on its own; decorations and lean idle pause on this.
  // The last value is kept here, from before any page script runs, so a
  // message that lands before React has subscribed is not lost.
  hudShown: () => lastHudShown,
  onHudShown: (cb) => {
    const handler = (_e, shown) => cb(shown === true);
    ipcRenderer.on('hud:shown', handler);
    return () => ipcRenderer.removeListener('hud:shown', handler);
  },
  // Debug: Ctrl+Alt+Shift+H cycles the HUD's placeholder row count.
  onHudDebugCycle: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('hud:debug-cycle', handler);
    return () => ipcRenderer.removeListener('hud:debug-cycle', handler);
  },
  presentationRead: () => ipcRenderer.invoke('presentation:read'),
  presentationDisplays: () => ipcRenderer.invoke('presentation:displays'),
  presentationWrite: (prefs) => ipcRenderer.invoke('presentation:write', prefs),
  presentationReset: () => ipcRenderer.invoke('presentation:reset'),
  previewAmbient: () => ipcRenderer.invoke('presentation:preview-ambient'),
  endAmbientPreview: () => ipcRenderer.invoke('presentation:end-preview'),
  onDisplaysChange: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('presentation:displays-changed', handler);
    return () => ipcRenderer.removeListener('presentation:displays-changed', handler);
  },
  onPresentationChange: (cb) => {
    const handler = (_e, prefs) => cb(prefs);
    ipcRenderer.on('presentation:changed', handler);
    return () => ipcRenderer.removeListener('presentation:changed', handler);
  },
  // Phase 8 — vault notes behind the HUD bubbles, and the editor's pickers.
  widgetsRead: (req) => ipcRenderer.invoke('widgets:read', req),
  widgetsNotes: () => ipcRenderer.invoke('widgets:notes'),
  nowPlaying: () => ipcRenderer.invoke('nowplaying:get'),
  addonCall: (id, name, arg) => ipcRenderer.invoke('addon:call', id, name, arg),
  widgetsDescribe: (req) => ipcRenderer.invoke('widgets:describe', req),
  // Live preview without saving; revert to what's on disk.
  presentationPreview: (prefs) => ipcRenderer.invoke('presentation:preview', prefs),
  presentationRevert: () => ipcRenderer.invoke('presentation:revert'),
  // Phase 8 — arrange mode: the HUD's one interactive state.
  arrangeSet: (on) => ipcRenderer.invoke('hud:arrange-set', on),
  arrangeGet: () => ipcRenderer.invoke('hud:arrange-get'),
  arrangeAction: (action) => ipcRenderer.invoke('hud:arrange-action', action),
  arrangeDrag: (point) => ipcRenderer.send('hud:arrange-drag', point),
  // Hover fade: where the cursor is inside this corner window, or null.
  onHudHover: (cb) => {
    const handler = (_e, point) => cb(point && typeof point === 'object' ? { x: Number(point.x), y: Number(point.y) } : null);
    ipcRenderer.on('hud:hover', handler);
    return () => ipcRenderer.removeListener('hud:hover', handler);
  },
  onArrange: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('hud:arrange', handler);
    return () => ipcRenderer.removeListener('hud:arrange', handler);
  },
  onArrangeTarget: (cb) => {
    const handler = (_e, anchor) => cb(anchor);
    ipcRenderer.on('hud:arrange-target', handler);
    return () => ipcRenderer.removeListener('hud:arrange-target', handler);
  },
  onPresentationOpen: (cb) => {
    const handler = (_e, target) => cb(target);
    ipcRenderer.on('presentation:open', handler);
    return () => ipcRenderer.removeListener('presentation:open', handler);
  },
  // Obsidian vault: weekly note (Intentions / Tasks) + #thisweek sweep.
  readWeek: (weekId) => ipcRenderer.invoke('vault:read-week', weekId),
  // Phase 5 §6 — the backlog holding pen and its quick-capture window.
  readBacklog: () => ipcRenderer.invoke('vault:read-backlog'),
  appendBacklog: (text) => ipcRenderer.invoke('vault:append-backlog', text),
  hideCapture: () => ipcRenderer.invoke('capture:hide'),
  // Phase 6 §2 — focus mode. Held in the main process (tray, Ctrl+Alt+F); the
  // HUD shows it.
  focusGet: () => ipcRenderer.invoke('focus:get'),
  onFocusChange: (cb) => {
    const handler = (_e, session) => cb(session);
    ipcRenderer.on('focus:changed', handler);
    return () => ipcRenderer.removeListener('focus:changed', handler);
  },
  hudImminent: (key) => ipcRenderer.invoke('hud:imminent', key),
  // The main process watches the vault (one recursive fs.watch) and pushes this
  // to every window, so every window shares one watcher instead of each
  // re-walking the vault on its own timer.
  onVaultChange: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('vault:changed', handler);
    return () => ipcRenderer.removeListener('vault:changed', handler);
  },

  // Your data (Phase 9.6): diagnostics, export, remove everything.
  saveDiagnostics: () => ipcRenderer.invoke('data:diagnostics'),
  exportSettings: () => ipcRenderer.invoke('data:export'),
  removeAllData: () => ipcRenderer.invoke('data:remove-all'),

  // Set-up (Phase 9.5): the wizard and the Integrations page.
  onboardingStatus: () => ipcRenderer.invoke('onboarding:status'),
  onboardingFinish: () => ipcRenderer.invoke('onboarding:finish'),
  notesChooseFolder: () => ipcRenderer.invoke('notes:choose-folder'),
  notesSettings: () => ipcRenderer.invoke('notes:settings'),
  notesApply: (a) => ipcRenderer.invoke('notes:apply', a),
  nowPlayingSettings: () => ipcRenderer.invoke('nowplaying:settings'),
  nowPlayingSetPlayer: (p) => ipcRenderer.invoke('nowplaying:set-player', p),
  restartApp: () => ipcRenderer.invoke('app:restart'),

  // The notes provider (Phase 9.4): its kind and whether the app may write.
  notesStatus: () => ipcRenderer.invoke('notes:status'),
  notesSetWrite: (on) => ipcRenderer.invoke('notes:set-write', on),

  // Recurring "week skeleton" (userData/week-skeleton.yaml), read-only here.
  skeletonRead: () => ipcRenderer.invoke('skeleton:read'),
  skeletonWrite: (yaml) => ipcRenderer.invoke('skeleton:write', yaml),
  onSkeletonChange: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('skeleton:changed', handler);
    return () => ipcRenderer.removeListener('skeleton:changed', handler);
  },

  // Google Calendar (OAuth + API), read-only: connect lives in Display & HUD.
  googleStatus: () => ipcRenderer.invoke('google:status'),
  connectGoogle: () => ipcRenderer.invoke('google:connect'),
  disconnectGoogle: () => ipcRenderer.invoke('google:disconnect'),
  calStatus: () => ipcRenderer.invoke('cal:status'),
  // The events slot (Phase 9.4): every calendar, merged in main. Links go in
  // and never come back out; files come only from the main process's dialog.
  eventsList: (range) => ipcRenderer.invoke('events:list', range),
  eventsSources: () => ipcRenderer.invoke('events:sources'),
  eventsAddLink: (a) => ipcRenderer.invoke('events:add-link', a),
  eventsAddFile: (a) => ipcRenderer.invoke('events:add-file', a),
  eventsRemove: (id) => ipcRenderer.invoke('events:remove', id),
  eventsRename: (id, name) => ipcRenderer.invoke('events:rename', id, name),
  eventsRefresh: (id) => ipcRenderer.invoke('events:refresh', id),
  onEventsChange: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('events:changed', handler);
    return () => ipcRenderer.removeListener('events:changed', handler);
  },
  onGoogleChange: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('google:changed', handler);
    return () => ipcRenderer.removeListener('google:changed', handler);
  },
  // The main process pushes this to every window after each sync pass, so the
  // windows share one delta loop instead of polling on their own.
  onCalendarChange: (cb) => {
    const handler = (_e, sync) => cb(sync);
    ipcRenderer.on('cal:changed', handler);
    return () => ipcRenderer.removeListener('cal:changed', handler);
  },
});

// Let the stylesheet know it's running inside the Electron shell (transparent
// window) vs a plain browser tab (opaque page background).
window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.classList.add('is-electron');
});
