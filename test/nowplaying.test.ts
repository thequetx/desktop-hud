import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { PRESENTATION_DEFAULTS } from '../src/lib/presentation';
import { nowPlayingState, PAUSE_LINGER_MS, progressTarget, trackKey, visibleBubbles } from '../src/lib/widgets';

const require_ = createRequire(import.meta.url);
const { toNowPlaying, imageType, pngSize, accentFromBgra, normalizePlayerFilter, coverIdentity, playerArg, makeNowPlaying } = require_('../electron/platform/win32/nowplaying.cjs') as any;

/** One line from smtc-reader.exe, cover already split off. */
const line = (over: object = {}) => ({
  ok: true,
  title: 'CODEINE',
  artist: 'ero808',
  album: 'CODEINE',
  playing: true,
  positionMs: 71_000,
  durationMs: 220_000,
  sampledAt: 1_000_000,
  coverKey: '02ebfd45',
  ...over,
});
const DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

describe('Windows media feed -> the HUD, in-process (Phase 9.3, S11)', () => {
  it('gives the track, a data: cover and the extrapolated position', () => {
    expect(toNowPlaying(line(), { now: 1_004_000, cover: DATA_URL, accent: '#d23a4c' })).toEqual({
      playing: true,
      sourceAppId: '',
      title: 'CODEINE',
      artist: 'ero808',
      cover: DATA_URL,
      progressMs: 75_000,
      totalMs: 220_000,
      accent: '#d23a4c',
      queue: [],
    });
  });

  it('extrapolates position only while playing, and never past the end', () => {
    expect(toNowPlaying(line({ playing: false }), { now: 1_004_000 }).progressMs).toBe(71_000);
    expect(toNowPlaying(line(), { now: 9_999_999 }).progressMs).toBe(220_000);
  });

  it('has an accent only while playing, and no total for an unknown length', () => {
    expect(toNowPlaying(line({ playing: false }), { now: 1_004_000, accent: '#d23a4c' }).accent).toBeNull();
    expect(toNowPlaying(line({ durationMs: 0 }), { now: 1_004_000 }).totalMs).toBeNull();
  });

  it('carries the selected Windows app identity through to the HUD', () => {
    expect(toNowPlaying(line({ sourceAppId: 'MusicBee.exe' }), { now: 1_004_000 }).sourceAppId).toBe('MusicBee.exe');
    expect(toNowPlaying(line({ sourceAppId: null }), { now: 1_004_000 }).sourceAppId).toBe('');
  });

  it('changes cover identity when the source app changes on the same track', () => {
    expect(coverIdentity('Spotify.exe', 'same-track')).not.toBe(coverIdentity('MusicBee.exe', 'same-track'));
  });

  it('hides stale cover art on a source switch, then loads that source art even with the same cover key', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter() as any;
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => {};
    let decodeCalls = 0;
    let thumbCalls = 0;
    const feed = makeNowPlaying({
      exe: 'reader.exe',
      spawnReader: () => child,
      log: () => {},
      decode: () => {
        decodeCalls++;
        return { bitmap: Buffer.from([0, 0, 255, 255]), width: 1, height: 1 };
      },
      thumb: () => `data:image/jpeg;base64,source-${++thumbCalls}`,
    });
    feed.start();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    const emit = (sourceAppId: string, withArt: boolean) => stdout.write(`${JSON.stringify({ ...line({ sourceAppId }), ...(withArt ? { cover: png } : {}) })}\n`);
    emit('Spotify.exe', true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(feed.current().cover).toBe('data:image/jpeg;base64,source-1');
    expect(feed.snapshot().cover.key).toBe('02ebfd45');
    emit('MusicBee.exe', false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(feed.current().cover).toBeNull();
    expect(feed.snapshot().cover).toBeNull();
    expect(feed.current().sourceAppId).toBe('MusicBee.exe');
    expect(decodeCalls).toBe(1);
    expect(thumbCalls).toBe(1);
    emit('MusicBee.exe', true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(feed.current().cover).toBe('data:image/jpeg;base64,source-2');
    expect(feed.snapshot().cover.key).toBe('02ebfd45');
    expect(feed.snapshot().cover.sourceAppId).toBe('MusicBee.exe');
    expect(decodeCalls).toBe(2);
    expect(thumbCalls).toBe(2);
    feed.stop();
    stdout.destroy();
    stderr.destroy();
  });

  it('is null when nothing is playing, so the bubble hides', () => {
    expect(toNowPlaying({ ok: false }, { now: 0 })).toBeNull();
    expect(toNowPlaying(null, { now: 0 })).toBeNull();
    expect(toNowPlaying(line({ title: '' }), { now: 0 })).toBeNull();
  });

  it('sniffs the image type and PNG size', () => {
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(png);
    png.writeUInt32BE(300, 16);
    png.writeUInt32BE(300, 20);
    expect(imageType(png)).toBe('image/png');
    expect(pngSize(png)).toEqual({ width: 300, height: 300 });
    expect(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(imageType(Buffer.from('GIF8'))).toBeNull();
  });
});

describe('Progress', () => {
  it('shows where the song is now, and clamps', () => {
    expect(progressTarget({ playing: true, progressMs: 50_000, totalMs: 200_000 })).toBeCloseTo(0.25);
    expect(progressTarget({ playing: false, progressMs: 50_000, totalMs: 200_000 })).toBeCloseTo(0.25);
    expect(progressTarget({ playing: true, progressMs: 199_000, totalMs: 200_000 })).toBeCloseTo(0.995);
    expect(progressTarget({ playing: true, progressMs: 250_000, totalMs: 200_000 })).toBe(1);
    expect(progressTarget({ playing: true, progressMs: null, totalMs: 200_000 })).toBeNull();
  });
});

describe('Paused state', () => {
  const track = { title: 'Mural', artist: 'Lupe Fiasco', cover: null, progressMs: 1, totalMs: 2, accent: null };
  const now = 1_000_000_000;

  it('shows playing tracks, and paused ones for a while after a pause', () => {
    expect(nowPlayingState({ ...track, playing: true }, now)).toBe('playing');
    expect(nowPlayingState({ ...track, playing: false, pausedAt: now - 30_000 }, now)).toBe('paused');
    expect(nowPlayingState({ ...track, playing: false, pausedAt: now - PAUSE_LINGER_MS - 1 }, now)).toBe('hidden');
  });

  it('never shows a pause it didn\'t see happen (e.g. Spotify paused at startup)', () => {
    expect(nowPlayingState({ ...track, playing: false, pausedAt: null }, now)).toBe('hidden');
    expect(nowPlayingState({ ...track, playing: false }, now)).toBe('hidden');
    expect(nowPlayingState(null, now)).toBe('hidden');
  });
});

describe('Now playing track identity', () => {
  it('treats the same track from different apps as separate tracks', () => {
    const track = { title: 'Mural', artist: 'Lupe Fiasco' };
    expect(trackKey({ ...track, sourceAppId: 'Spotify.exe' })).not.toBe(trackKey({ ...track, sourceAppId: 'MusicBee.exe' }));
    expect(trackKey(track)).toBe(trackKey({ ...track }));
  });
});

describe('Now playing bubble', () => {
  it('is on by default, bottom-right', () => {
    const at = (kinds: string[]) =>
      visibleBubbles(PRESENTATION_DEFAULTS, 'bottom-right', { now: new Date(2026, 8, 24, 19), kinds, titles: [], focus: false }).map(
        (b) => b.id,
      );
    expect(at([])).toEqual(['nowplaying']);
    // Streaming is a private add-on (plan decision 9): no stream rule by default.
    expect(at(['stream'])).toEqual(['nowplaying']);
  });
});

describe('Accent colour (from the cover, in the main process)', () => {
  it("picks the cover's signature colour, not its muddy average", () => {
    // 8 px: mostly near-black, one strong red, one grey. BGRA order.
    const px = (r: number, g: number, b: number) => [b, g, r, 255];
    const buf = Buffer.from([
      ...px(8, 8, 10), ...px(10, 10, 12), ...px(6, 6, 8), ...px(9, 9, 9),
      ...px(12, 10, 10), ...px(210, 30, 40), ...px(128, 128, 128), ...px(7, 7, 7),
    ]);
    const hex = accentFromBgra(buf, 8, 1);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    expect(r).toBeGreaterThan(g + 60); // red wins
    expect(r).toBeGreaterThan(b + 60);
    // A grey cover gives the quiet slate fallback.
    expect(accentFromBgra(Buffer.from([...px(90, 90, 90), ...px(140, 140, 140)]), 2, 1)).toBe('#8a94a6');
  });
});

describe('playerArg — what the reader is told to follow (Phase 9.4)', () => {
  it('any player by default; a plain word names one; anything else is any player', () => {
    expect(playerArg(undefined)).toBe('*');
    expect(playerArg('')).toBe('*');
    expect(playerArg('Spotify')).toBe('spotify');
    expect(playerArg('--evil "x"')).toBe('*');
    expect(playerArg('a'.repeat(60))).toBe('*');
  });

  it('normalizes one to four app filters and rejects malformed or oversized lists', () => {
    expect(normalizePlayerFilter(' Spotify, MusicBee ')).toBe('spotify,musicbee');
    expect(normalizePlayerFilter('')).toBe('');
    expect(normalizePlayerFilter('*')).toBe('*');
    for (const invalid of ['spotify,', ',spotify', 'spotify,,musicbee', 'a,b,c,d,e', 'a'.repeat(41), 'a'.repeat(65), '--bad']) {
      expect(normalizePlayerFilter(invalid)).toBeNull();
      expect(playerArg(invalid)).toBe('*');
    }
  });
});
