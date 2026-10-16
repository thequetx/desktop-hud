// electron-builder's winCodeSign package contains macOS .dylib symlinks. On
// Windows without Developer Mode / admin, 7-Zip can't create them and the whole
// build aborts. Pre-extract it here with `-snl-` (skip symlinks) so the cache is
// populated before electron-builder looks. No-op once it's cached.
import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import https from 'node:https';
import { createWriteStream } from 'node:fs';

if (process.platform !== 'win32') process.exit(0);

const require = createRequire(import.meta.url);
const cache = path.join(
  process.env.LOCALAPPDATA || '',
  'electron-builder',
  'Cache',
  'winCodeSign',
);
const outDir = path.join(cache, 'winCodeSign-2.6.0');
if (existsSync(path.join(outDir, 'windows-10'))) {
  console.log('winCodeSign already prepared');
  process.exit(0);
}

// 7zip-bin came with older electron-builder releases and is no longer in the
// lockfile. Without it (a clean CI install), leave winCodeSign to
// electron-builder: CI runners can create symlinks, so the workaround above is
// only needed on a non-admin desktop that already has the package.
let sevenZip;
try {
  sevenZip = require('7zip-bin').path7za;
} catch {
  console.log('7zip-bin not installed; electron-builder will fetch winCodeSign itself');
  process.exit(0);
}
const url =
  'https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z';
const archive = path.join(cache, 'winCodeSign-2.6.0.7z');

mkdirSync(cache, { recursive: true });

function download(u, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    https
      .get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirects > 5) return reject(new Error('too many redirects'));
          res.resume();
          return resolve(download(res.headers.location, dest, redirects + 1));
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        const f = createWriteStream(dest);
        res.pipe(f);
        f.on('finish', () => f.close(resolve));
      })
      .on('error', reject);
  });
}

console.log('downloading winCodeSign-2.6.0.7z …');
await download(url, archive);

try {
  execFileSync(sevenZip, ['x', archive, `-o${outDir}`, '-snl-', '-y'], {
    stdio: 'ignore',
  });
} catch {
  /* exit code 2 from skipped symlinks is expected — the Windows bins extract fine */
}
console.log(
  existsSync(path.join(outDir, 'windows-10'))
    ? 'winCodeSign prepared'
    : 'winCodeSign extract may be incomplete',
);
