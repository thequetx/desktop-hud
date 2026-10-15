// Generates the app icons — no image dependencies, hand-rolled PNG codec.
//   electron/tray.png   32×32   (tray)
//   build/icon.png     256×256  (electron-builder converts this to .ico)
// Run: node scripts/make-icons.mjs   (or `npm run icons`)
//
// Phase 6 §5 — these were a hand-drawn crimson rounded square standing in for a
// logo. The real quetx mark lives in the vault (Brand Assets), so this now reads
// it and downsamples, falling back to the placeholder when the vault isn't
// reachable — a clone of this repo on another machine still builds.
//
// The PNG work is done by hand rather than with `sharp` deliberately: this
// project has an empty `dependencies` block and a documented npm-install
// friction problem (Phase 3 §5), and an icon script is not worth a native
// module. Both halves are ~60 lines and only ever see one file we control.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync, crc32 } from 'node:zlib';
import path from 'node:path';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Where the mark comes from, best first (Phase 9.7: no path to anyone's files
 * in the public source):
 * 1. DHUD_ICON_SOURCE, a PNG path;
 * 2. icon-source.local.txt in the repo root (git-ignored), holding a PNG path:
 *    the owner's brand file, so local builds keep the real icon;
 * 3. assets/icon-source.png, committed: the public icon.
 * With none of them, the placeholder is drawn.
 */
function markCandidates() {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
  const out = [];
  if (process.env.DHUD_ICON_SOURCE) out.push(process.env.DHUD_ICON_SOURCE);
  const local = path.join(root, 'icon-source.local.txt');
  if (existsSync(local)) {
    for (const line of readFileSync(local, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith('#')) out.push(t);
    }
  }
  out.push(path.join(root, 'assets', 'icon-source.png'));
  return out;
}

// ---- decode ---------------------------------------------------------------

/**
 * Minimal PNG reader: 8-bit RGBA, non-interlaced, which is what the brand mark
 * is (512×512, colour type 6). Anything else throws rather than guessing — a
 * silently mis-decoded icon is worse than falling back to the placeholder.
 */
function decodePng(buf) {
  if (!buf.slice(0, 8).equals(SIG)) throw new Error('not a PNG');
  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString('ascii');
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') ihdr = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr) throw new Error('no IHDR');
  const w = ihdr.readUInt32BE(0);
  const h = ihdr.readUInt32BE(4);
  const depth = ihdr[8];
  const colour = ihdr[9];
  const interlace = ihdr[12];
  if (depth !== 8 || colour !== 6 || interlace !== 0) {
    throw new Error(`unsupported PNG (depth ${depth}, colour ${colour}, interlace ${interlace})`);
  }

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  // Undo the per-scanline filters. Five of them, all defined relative to the
  // pixel to the left (a), the one above (b) and above-left (c).
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y > 0 ? out[dst - stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[dst - stride + x - bpp] : 0;
      const v = raw[src + x];
      let val;
      switch (filter) {
        case 0: val = v; break;
        case 1: val = v + a; break;
        case 2: val = v + b; break;
        case 3: val = v + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          val = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`bad filter ${filter} on row ${y}`);
      }
      out[dst + x] = val & 0xff;
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * Box-downsample to S×S. A box filter (average every source pixel falling in
 * the target cell) rather than nearest-neighbour, because at 32px nearest turns
 * a logo's curves into gravel.
 *
 * Alpha is premultiplied for the average and divided back out, so the colour of
 * a transparent pixel can't bleed into the edge of the mark.
 */
function resize(img, S) {
  const out = Buffer.alloc(S * S * 4);
  const sx = img.width / S;
  const sy = img.height / S;
  for (let y = 0; y < S; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < S; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const o = (yy * img.width + xx) * 4;
          const av = img.data[o + 3];
          r += img.data[o] * av;
          g += img.data[o + 1] * av;
          b += img.data[o + 2] * av;
          a += av;
          n++;
        }
      }
      const o = (y * S + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round(a / n);
      }
    }
  }
  return { width: S, height: S, data: out };
}

// ---- encode ---------------------------------------------------------------

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body) >>> 0, 8 + data.length);
  return out;
}

function encodePng(img) {
  const { width: w, height: h, data } = img;
  const stride = w * 4;
  // Filter 0 (none) on every row: these are tiny, and the deflate does the work.
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The pre-Phase-6 placeholder: a crimson rounded square. Kept as the fallback
 *  so this script still produces icons without the vault. */
function placeholder(S) {
  const data = Buffer.alloc(S * S * 4);
  const rr = S * 0.2;
  const margin = S * 0.08;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const o = (y * S + x) * 4;
      const cx = Math.abs(x - S / 2 + 0.5);
      const cy = Math.abs(y - S / 2 + 0.5);
      const lim = S / 2 - margin;
      const inMargin = cx <= lim && cy <= lim;
      const nearCorner = lim - cx < rr && lim - cy < rr;
      const cornerOk = !nearCorner || Math.hypot(lim - rr - cx, lim - rr - cy) <= rr;
      if (inMargin && cornerOk) {
        data[o] = 0xec;
        data[o + 1] = 0x31;
        data[o + 2] = 0x39;
        data[o + 3] = 255;
      }
    }
  }
  return { width: S, height: S, data };
}

// ---- main -----------------------------------------------------------------

let source = null;
for (const mark of markCandidates()) {
  if (!existsSync(mark)) continue;
  try {
    source = decodePng(readFileSync(mark));
    console.log(`using the quetx mark: ${mark} (${source.width}×${source.height})`);
    break;
  } catch (err) {
    console.warn(`could not read ${mark} — ${err.message}`);
  }
}
if (!source) console.warn('no usable mark in the vault — using the placeholder');

const at = (S) => encodePng(source ? resize(source, S) : placeholder(S));

const tray = at(32);
writeFileSync(new URL('../electron/tray.png', import.meta.url), tray);

mkdirSync(new URL('../build/', import.meta.url), { recursive: true });
const app = at(256);
writeFileSync(new URL('../build/icon.png', import.meta.url), app);

console.log(`wrote electron/tray.png (${tray.length}B) + build/icon.png (${app.length}B)`);
