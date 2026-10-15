// Fails a build that would publish something personal or secret.
//
//   node scripts/release-check.mjs [resourcesDir] [--warn]
//   node scripts/release-check.mjs --source [--warn]
//
// --source (Phase 9.7) scans every file git tracks instead: what a public
// repository would publish. Same rules.
//
// Scans the packaged app (`app.asar` and `app.asar.unpacked`) under
// resourcesDir, default release/win-unpacked/resources. The installer is built
// from exactly these files, so this is what a public download would contain.
//
// Two kinds of check:
//
// 1. Generic patterns, kept in this file because they name no one: files that
//    must never ship (.ics, .env, .reg), user-profile paths, email addresses,
//    iCal secret URLs, Google client secrets and private keys.
// 2. A personal list: names, addresses, folder names. It is NOT in this repo,
//    because a public script that lists them would publish exactly that list.
//    It is read from release-check.local.txt (git-ignored, one string per
//    line, # for comments) and from the RELEASE_CHECK_PERSONAL environment
//    variable (newline-separated; a CI secret).
//
// Reports name the file, the line and the rule, never the matched text, so the
// output is safe to paste or to keep in a CI log.
//
// --warn reports and exits 0. The owner's local `npm run dist` uses it until
// the private add-ons leave the core (Phase 9.3); a public release runs strict.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');

const args = process.argv.slice(2);
const warnOnly = args.includes('--warn');
const sourceMode = args.includes('--source');
const resourcesDir = path.resolve(args.find((a) => !a.startsWith('--')) || 'release/win-unpacked/resources');

/** Files that must never be packaged, whatever they contain. */
const FORBIDDEN_FILES = [
  { rule: 'calendar file', test: (p) => /\.ics$/i.test(p) },
  { rule: 'env file', test: (p) => /(^|[\\/])\.env(\.|$)/i.test(p) },
  { rule: 'registry export', test: (p) => /\.reg$/i.test(p) },
  { rule: 'local release-check list', test: (p) => /release-check\.local/i.test(p) },
];

/** Allowed email addresses: no one's inbox. */
const EMAIL_ALLOW = [/^noreply@/i, /@users\.noreply\.github\.com$/i, /@example\.(com|org)$/i];

/** Generic content rules. `binary: true` also runs on non-text files. */
const RULES = [
  {
    rule: 'user-profile path',
    binary: true,
    // Any real profile; the placeholders used in docs and comments are allowed.
    re: /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}(?!(?:you|user|username|name|<[^>]*>|%[^%]*%|\$\{?\w+\}?|Public|Default)[\\/"'`\s])[^\\/"'`\s]+/gi,
  },
  { rule: 'iCal secret URL', binary: true, re: /calendar\.google\.com\/calendar\/ical\/[^\s"'`]*private-/gi },
  { rule: 'Google client secret', binary: true, re: /GOCSPX-[A-Za-z0-9_-]{10,}/g },
  { rule: 'Google client ID', binary: true, re: /\d{6,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com/gi },
  { rule: 'private key', binary: true, re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  {
    rule: 'email address',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    allow: (m) => EMAIL_ALLOW.some((re) => re.test(m)),
    // Third-party authors' own text: the lockfile's notices (a deprecation
    // message names one) and the licences quoted verbatim in the notices file.
    skipFile: (name) => /(^|\/)(package-lock\.json|THIRD_PARTY_NOTICES\.md)$/.test(name),
  },
];

const TEXT_EXT = /\.(c?js|mjs|json|html?|css|ya?ml|md|txt|svg|map|tsx?|cs|nsh|gitignore|toml|ini)$|(^|\/)\.[a-z]+$/i;

function personalList() {
  const out = [];
  const add = (text) => {
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.trim();
      if (line && !line.startsWith('#')) out.push(line.toLowerCase());
    }
  };
  const local = path.resolve('release-check.local.txt');
  if (existsSync(local)) add(readFileSync(local, 'utf8'));
  if (process.env.RELEASE_CHECK_PERSONAL) add(process.env.RELEASE_CHECK_PERSONAL);
  return [...new Set(out)];
}

/** Every packaged file as { name, buf }: asar entries first, then unpacked files. */
function* packagedFiles() {
  const archive = path.join(resourcesDir, 'app.asar');
  if (!existsSync(archive)) throw new Error(`no app.asar under ${resourcesDir} (run npm run pack first)`);
  for (const entry of asar.listPackage(archive)) {
    const rel = entry.replace(/^[\\/]/, '');
    let buf;
    try {
      buf = asar.extractFile(archive, rel);
    } catch {
      continue; // a directory, or a file that lives in app.asar.unpacked
    }
    yield { name: `app.asar/${rel.replace(/\\/g, '/')}`, buf };
  }
  const unpacked = path.join(resourcesDir, 'app.asar.unpacked');
  if (!existsSync(unpacked)) return;
  const walk = function* (dir) {
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      if (statSync(abs).isDirectory()) yield* walk(abs);
      else yield { name: `app.asar.unpacked/${path.relative(unpacked, abs).replace(/\\/g, '/')}`, buf: readFileSync(abs) };
    }
  };
  yield* walk(unpacked);
}

/** Every file git tracks, for --source. */
function* sourceFiles() {
  const { execFileSync } = require('node:child_process');
  const list = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
  for (const rel of list) {
    let buf;
    try {
      buf = readFileSync(rel);
    } catch {
      continue; // deleted in the working tree
    }
    yield { name: rel, buf };
  }
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

const findings = [];
const personal = personalList();
let files = 0;

for (const { name, buf } of sourceMode ? sourceFiles() : packagedFiles()) {
  files++;
  for (const f of FORBIDDEN_FILES) if (f.test(name)) findings.push({ file: name, rule: f.rule });

  const isText = TEXT_EXT.test(name);
  const text = isText ? buf.toString('utf8') : buf.toString('latin1');
  for (const r of RULES) {
    if (!isText && !r.binary) continue;
    if (r.skipFile && r.skipFile(name)) continue;
    for (const m of text.matchAll(r.re)) {
      if (r.allow && r.allow(m[0])) continue;
      findings.push({ file: name, line: isText ? lineOf(text, m.index) : undefined, rule: r.rule });
    }
  }

  if (personal.length) {
    const lower = text.toLowerCase();
    // UTF-16 too: Windows binaries store many strings that way.
    const lower16 = isText ? '' : buf.toString('utf16le').toLowerCase();
    personal.forEach((p, i) => {
      let at = lower.indexOf(p);
      while (at !== -1) {
        findings.push({ file: name, line: isText ? lineOf(text, at) : undefined, rule: `personal string #${i + 1}` });
        at = lower.indexOf(p, at + p.length);
      }
      if (lower16.includes(p)) findings.push({ file: name, rule: `personal string #${i + 1} (UTF-16)` });
    });
  }
}

// One line per file and rule, with the lines it was found on.
const grouped = new Map();
for (const f of findings) {
  const key = `${f.file}  —  ${f.rule}`;
  if (!grouped.has(key)) grouped.set(key, new Set());
  if (f.line) grouped.get(key).add(f.line);
}

const source = personal.length
  ? `${personal.length} personal strings`
  : 'no personal list (release-check.local.txt / RELEASE_CHECK_PERSONAL); generic rules only';
console.log(`[release-check] scanned ${files} ${sourceMode ? 'tracked source files' : `packaged files under ${resourcesDir}`} (${source})`);

if (!grouped.size) {
  console.log('[release-check] clean');
  process.exit(0);
}
for (const [key, lines] of grouped) {
  const where = lines.size ? `  (line ${[...lines].slice(0, 8).join(', ')}${lines.size > 8 ? ', …' : ''})` : '';
  console.log(`  ${key}${where}`);
}
console.log(`[release-check] ${grouped.size} finding(s) in ${new Set(findings.map((f) => f.file)).size} file(s)`);
if (warnOnly) {
  console.log('[release-check] --warn: not failing the build. A public release must run without --warn.');
  process.exit(0);
}
process.exit(1);
