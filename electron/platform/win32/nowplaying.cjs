'use strict';

// Now playing, from Windows' own media controls (Phase 9.3: in-process).
//
// Windows-only (platform/win32/, Phase 9.4). Any player by default; config
// nowplaying.player names one ("spotify") for a desk where a browser video
// shouldn't take over the HUD.
//
// native/smtc-reader.cs -> electron/bin/smtc-reader.exe writes one JSON line
// per change; this keeps the latest and hands the HUD a ready NowPlaying object
// over IPC (current()). The cover comes along as a data: URL and its accent
// colour is worked out here, so the renderer loads nothing from anywhere
// (trust model S11).
//
// Until Phase 9.3 this also ran a local HTTP server for the renderer to read.
// The core has none now; a private add-on that needs the raw state (and the
// cover image) reads snapshot() instead.

const { spawn } = require('node:child_process');
const readline = require('node:readline');

const RESTART_WINDOW_MS = 10 * 60 * 1000;
const MAX_RESTARTS = 5;
const RESTART_DELAY_MS = 3000;
/** A reader that says nothing for this long is treated as stuck (it heartbeats every 5 s). */
const STALE_MS = 20 * 1000;

/** PNG or JPEG by magic bytes; Spotify's thumbnails are PNG today. */
function imageType(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  return null;
}

/** Width/height from a PNG header (IHDR), else null. */
function pngSize(buf) {
  if (imageType(buf) !== 'image/png' || buf.length < 24) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslToHex(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * A cover's accent colour, from raw BGRA pixels (Electron's toBitmap order).
 *
 * Not the average — an average of a colourful cover is mud. Pixels are
 * weighted by saturation (and away from near-black/near-white), so the
 * colour that makes the cover recognisable wins. The result is then pulled
 * into a range that reads as a glow on the HUD's dark card: lightness
 * 0.55–0.68, saturation at least 0.45. A grey cover gives a quiet slate.
 */
function accentFromBgra(buf, width, height) {
  let r = 0;
  let g = 0;
  let b = 0;
  let w = 0;
  const n = Math.min(buf.length / 4, width * height);
  for (let i = 0; i < n; i++) {
    const B = buf[i * 4];
    const G = buf[i * 4 + 1];
    const R = buf[i * 4 + 2];
    const [, s, l] = rgbToHsl(R, G, B);
    const weight = s * s * (1 - Math.abs(l - 0.5) * 1.6);
    if (weight <= 0) continue;
    r += R * weight;
    g += G * weight;
    b += B * weight;
    w += weight;
  }
  if (w < 1e-3) return '#8a94a6';
  const [h, s] = rgbToHsl(r / w, g / w, b / w);
  if (s < 0.12) return '#8a94a6';
  return hslToHex(h, Math.max(0.45, Math.min(0.85, s)), 0.62);
}

/**
 * The reader's latest line -> the HUD's NowPlaying, or null when nothing is
 * playing. Position is extrapolated from when Windows sampled it, so the
 * progress bar moves between Spotify's infrequent timeline updates, and never
 * past the end.
 */
function toNowPlaying(state, { now, cover = null, accent = null }) {
  if (!state || !state.ok || !state.title) return null;
  const total = state.durationMs > 0 ? state.durationMs : 0;
  let progress = Math.max(0, Number(state.positionMs) || 0);
  if (state.playing && state.sampledAt > 0) progress += Math.max(0, now - state.sampledAt);
  if (total) progress = Math.min(progress, total);
  const playing = Boolean(state.playing);
  return {
    playing,
    sourceAppId: state.sourceAppId == null ? '' : String(state.sourceAppId),
    title: String(state.title).slice(0, 200),
    artist: state.artist ? String(state.artist).slice(0, 200) : '',
    cover,
    progressMs: Math.round(progress),
    totalMs: total || null,
    accent: playing ? accent : null,
    queue: [],
  };
}

/**
 * @param {{ exe: string, log?: (m: string) => void, decode?: (buf: Buffer) => { bitmap: Buffer, width: number, height: number } | null }} cfg
 *   `decode` turns a cover into a small bitmap for the accent colour; the
 *   default uses Electron's nativeImage.
 */
/** Normalize the saved player filter. Null means invalid; '' and '*' mean any player. */
function normalizePlayerFilter(v) {
  if (typeof v !== 'string') return null;
  const raw = v.trim();
  if (raw === '' || raw === '*') return raw;
  if (raw.length > 64) return null;
  const names = raw.split(',').map((name) => name.trim().toLowerCase());
  if (names.length > 4 || names.some((name) => !/^[a-z0-9][a-z0-9._ -]{0,39}$/.test(name))) return null;
  return names.join(',');
}

function coverIdentity(sourceAppId, coverKey) {
  return `${String(sourceAppId || '')}\u001f${String(coverKey || '')}`;
}

/** The reader's argument, with the legacy invalid-input fallback kept for runtime config. */
function playerArg(v) {
  const normalized = normalizePlayerFilter(v);
  return normalized == null || normalized === '' ? '*' : normalized;
}

function makeNowPlaying({ exe, player = '*', log = (m) => console.log(`[wd] nowplaying: ${m}`), decode = decodeWithElectron, thumb = thumbWithElectron, spawnReader = spawn }) {
  let child = null;
  let stopped = false;
  let restartTimer = null;
  const restarts = [];
  let state = null;
  let lastLineAt = 0;
  let cover = null; // { key, buf, type, size, dataUrl, accent }

  function onLine(line) {
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      return;
    }
    lastLineAt = Date.now();
    if (j.ok && typeof j.cover === 'string' && j.cover) {
      const buf = Buffer.from(j.cover, 'base64');
      const type = imageType(buf);
      if (type) {
        const identity = coverIdentity(j.sourceAppId, j.coverKey);
        if (!cover || cover.identity !== identity) {
          let accent = null;
          try {
            const img = decode(buf);
            if (img) accent = accentFromBgra(img.bitmap, img.width, img.height);
          } catch {
            accent = null; // the bubble falls back to cobalt
          }
          // The HUD draws the art at 46 px, and the cover rides along on every
          // poll: a small JPEG, not the ~170 KB original.
          let dataUrl = null;
          try {
            dataUrl = thumb(buf);
          } catch {
            dataUrl = null;
          }
          if (!dataUrl) dataUrl = `data:${type};base64,${buf.toString('base64')}`;
          cover = { key: String(j.coverKey || ''), identity, sourceAppId: String(j.sourceAppId || ''), buf, type, size: pngSize(buf) || { width: 300, height: 300 }, dataUrl, accent };
        }
      }
    }
    if (j.ok) delete j.cover;
    state = j;
  }

  function startReader() {
    if (stopped || child) return;
    try {
      child = spawnReader(exe, [playerArg(player)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      log(`reader failed to start: ${err.message}`);
      child = null;
      return scheduleRestart();
    }
    const c = child;
    readline.createInterface({ input: c.stdout }).on('line', onLine);
    readline.createInterface({ input: c.stderr }).on('line', (l) => log(`reader: ${l}`));
    c.on('error', (err) => log(`reader error: ${err.message}`));
    c.on('exit', (code) => {
      if (child === c) child = null;
      state = null;
      if (!stopped) {
        log(`reader exited (${code})`);
        scheduleRestart();
      }
    });
  }

  function scheduleRestart() {
    if (stopped || restartTimer) return;
    const now = Date.now();
    while (restarts.length && now - restarts[0] > RESTART_WINDOW_MS) restarts.shift();
    if (restarts.length >= MAX_RESTARTS) {
      log(`reader died ${MAX_RESTARTS} times in ${RESTART_WINDOW_MS / 60000} min — leaving it stopped`);
      return;
    }
    restarts.push(now);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      startReader();
    }, RESTART_DELAY_MS);
  }

  /** The live reader state and its cover, or nulls. For the owner's stream add-on. */
  function snapshot(now = Date.now()) {
    const live = state && now - lastLineAt < STALE_MS ? state : null;
    const coverOk = Boolean(live && live.ok && cover && cover.key === live.coverKey && cover.sourceAppId === String(live.sourceAppId || ''));
    return { state: live, cover: coverOk ? cover : null, now };
  }

  /** The HUD's NowPlaying, or null (nothing playing, no session, stuck reader). */
  function current(now = Date.now()) {
    const s = snapshot(now);
    return toNowPlaying(s.state, { now, cover: s.cover ? s.cover.dataUrl : null, accent: s.cover ? s.cover.accent : null });
  }

  function start() {
    if (!exe || child) return;
    stopped = false;
    startReader();
  }

  function stop() {
    stopped = true;
    clearTimeout(restartTimer);
    restartTimer = null;
    if (child) child.kill();
    child = null;
  }

  return { start, stop, current, snapshot };
}

/** A 144 px JPEG data: URL of a cover, or null; enough for the 46 px art at 3x. */
function thumbWithElectron(buf) {
  const { nativeImage } = require('electron');
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) return null;
  return `data:image/jpeg;base64,${img.resize({ width: 144, height: 144, quality: 'good' }).toJPEG(85).toString('base64')}`;
}

/** A cover as a 32 x 32 BGRA bitmap, decoded by Electron's own image stack. */
function decodeWithElectron(buf) {
  const { nativeImage } = require('electron');
  const img = nativeImage.createFromBuffer(buf).resize({ width: 32, height: 32 });
  const size = img.getSize();
  return { bitmap: img.toBitmap(), width: size.width, height: size.height };
}

module.exports = {
  playerArg, normalizePlayerFilter, coverIdentity, makeNowPlaying, toNowPlaying, imageType, pngSize, accentFromBgra };
