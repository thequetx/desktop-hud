// Compiles native/smtc-reader.cs → electron/bin/smtc-reader.exe.
//
// Uses the C# compiler that ships with .NET Framework 4 in every Windows
// install, referencing the OS's own WinRT metadata — no .NET SDK needed.
// Run by `npm run smtc`, and by pack/dist before electron-builder.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const win = process.env.WINDIR || 'C:\\Windows';
const fw = path.join(win, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const csc = path.join(fw, 'csc.exe');
const winmd = path.join(win, 'System32', 'WinMetadata');
const src = path.join(root, 'native', 'smtc-reader.cs');
const out = path.join(root, 'electron', 'bin', 'smtc-reader.exe');

if (!existsSync(csc)) {
  console.error(`[smtc] no C# compiler at ${csc}`);
  process.exit(1);
}
mkdirSync(path.dirname(out), { recursive: true });

const refs = [
  path.join(fw, 'System.Runtime.dll'),
  path.join(winmd, 'Windows.Foundation.winmd'),
  path.join(winmd, 'Windows.Media.winmd'),
  path.join(winmd, 'Windows.Storage.winmd'),
];

execFileSync(
  csc,
  ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu', `/out:${out}`, ...refs.map((r) => `/r:${r}`), src],
  { stdio: 'inherit' },
);
console.log(`[smtc] built ${path.relative(root, out)}`);
