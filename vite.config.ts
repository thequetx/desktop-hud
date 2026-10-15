import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Calendars are read by the main process since Phase 9.4, and nothing reads
// public/data/*.ics any more. Vite copies all of public/ into dist/, so this
// stays as a guard: an .ics left there by an old checkout must never end up
// in an installer.
function stripDevCalendar(): Plugin {
  let outDir = 'dist';
  return {
    name: 'strip-dev-calendar',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    writeBundle() {
      const dataDir = join(outDir, 'data');
      let names: string[] = [];
      try {
        names = readdirSync(dataDir);
      } catch {
        return;
      }
      for (const name of names) {
        if (name.toLowerCase().endsWith('.ics')) rmSync(join(dataDir, name), { force: true });
      }
    },
  };
}

// Phase 9.0 (S10): a strict Content-Security-Policy on every built page. The
// HUD renders calendar and note text other people may have written, so the
// pages may run only their own bundled scripts and fetch only their own files.
// Build-only: the dev server needs inline scripts and a websocket for HMR.
//
// img-src: the now-playing cover is a data: URL (S11, Phase 9.3); https is
// kept for queue covers an add-on may supply. style-src keeps 'unsafe-inline'
// for React style attributes and SVG; scripts never get it.
// 'self' is app://hud, where the built pages load from since Phase 9.4;
// file: is no longer allowed anywhere.
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

// Entry points, one codebase:
//   index.html   -> settings mode (Display & HUD window, from the tray)
//   ambient.html -> ambient mode  (full-screen idle overlay)
//   hud.html     -> HUD mode      (compact persistent corner panel, Ctrl+Alt+H)
export default defineConfig({
  plugins: [react(), stripDevCalendar(), contentSecurityPolicy()],
  // Electron loads the bundle via loadFile() -> file:// URLs, so asset paths
  // must be relative. Vite's default base of '/' resolves them to the drive
  // root (file:///C:/assets/...) and every window renders blank.
  base: './',
  // src/addons-private is a link (a junction) to the private add-ons repo.
  // Keep its files at their linked path, so their imports of core modules and
  // of react resolve inside this project.
  resolve: { preserveSymlinks: true },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        ambient: resolve(__dirname, 'ambient.html'),
        hud: resolve(__dirname, 'hud.html'),
        capture: resolve(__dirname, 'capture.html'),
      },
    },
  },
});
