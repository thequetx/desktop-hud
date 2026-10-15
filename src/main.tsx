import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';

// Phase 9.3 — the owner's private add-ons, composed at build time:
// src/addons-private is a git-ignored link to thequetx/desktop-hud-addons. The
// glob matches nothing in a public checkout, so the public build has no add-on
// code. Imported before the first render so their bubbles are registered.
import.meta.glob('./addons-private/index.tsx', { eager: true });

// Bundled fonts (offline) — replaces the Google Fonts @import. Latin subset only.
import '@fontsource/rajdhani/latin-500.css';
import '@fontsource/rajdhani/latin-600.css';
import '@fontsource/rajdhani/latin-700.css';
import '@fontsource/barlow/latin-400.css';
import '@fontsource/barlow/latin-500.css';
import '@fontsource/barlow/latin-600.css';

import './styles/tokens.css';
import './styles/base.css';
import './styles/setup.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
