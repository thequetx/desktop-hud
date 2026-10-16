// The on/off matrix (Phase 9.6): the built app, each integration on and off,
// on fresh profiles. For each combination it launches release/win-unpacked
// with its own --profile and debugging port, waits, reads every window over
// CDP, and checks: zero console errors and warnings, and the state that
// combination should show (the wizard, an empty state, a calendar, notes).
//
// Run after `npm run pack` (it needs the debugging port, which only the
// owner's pack allows). Never touches the installed app: every instance is
// started and stopped here by PID, on a profile under the OS temp folder.
//
//   node scripts/matrix.mjs            all combinations
//   node scripts/matrix.mjs --source   current public source via Electron
//   node scripts/matrix.mjs --keep     leave the profiles for inspection

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = process.argv.includes('--source');
const EXE = SOURCE
  ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(ROOT, 'release', 'win-unpacked', 'Desktop HUD.exe');
const KEEP = process.argv.includes('--keep');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function notesStatusProblem(expected, actual) {
  if (!expected) return null;
  if (!actual || typeof actual !== 'object') return 'notes status was unavailable';
  if (actual.kind !== expected.kind || actual.canWrite !== expected.canWrite) {
    return `notes ${JSON.stringify({ kind: actual.kind, canWrite: actual.canWrite })}`;
  }
  return null;
}

export function isSafeTempDir(dir, tempRoot = os.tmpdir()) {
  if (!path.isAbsolute(dir)) return false;
  const absolute = path.resolve(dir);
  const parent = path.resolve(tempRoot);
  return path.dirname(absolute) === parent && path.basename(absolute).startsWith('dhud-matrix-');
}

export function taskkillExecutable(systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows') {
  return path.join(systemRoot, 'System32', 'taskkill.exe');
}

async function stopProcessTree(child) {
  if (!child.pid) return;
  await new Promise((resolve) => {
    const killer = spawn(taskkillExecutable(), ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', resolve);
    killer.once('close', resolve);
  });
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('close', resolve);
    setTimeout(resolve, 3000).unref();
  });
}

function removeTempDir(dir) {
  if (!isSafeTempDir(dir)) throw new Error(`refusing to remove unsafe matrix temp directory: ${dir}`);
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

process.on('uncaughtException', (e) => {
  console.error('[matrix] crashed:', e);
  process.exit(1);
});

// ---- fixtures ------------------------------------------------------------------

const day = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
function icsFile(dir) {
  const now = new Date();
  const s = new Date(now.getTime() + 60 * 60 * 1000);
  const e = new Date(s.getTime() + 60 * 60 * 1000);
  const stamp = (d) => `${day(d)}T${d.toISOString().slice(11, 19).replace(/:/g, '')}Z`;
  const text = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:m1', 'SUMMARY:Matrix meeting', `DTSTART:${stamp(s)}`, `DTEND:${stamp(e)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const f = path.join(dir, 'matrix.ics');
  writeFileSync(f, text);
  return f;
}
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dow = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dow + 3);
  const first = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const w = 1 + Math.round(((t - first) / 864e5 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
  return `${t.getUTCFullYear()}-W${String(w).padStart(2, '0')}`;
}
function vault(dir) {
  const v = path.join(dir, 'vault');
  mkdirSync(path.join(v, 'Weekly'), { recursive: true });
  writeFileSync(path.join(v, 'Weekly', `${isoWeek(new Date())}.md`), '## Intentions\n\n- [ ] Matrix intention\n\n## Tasks\n\n- [ ] Matrix task\n\n## Review\n');
  writeFileSync(path.join(v, 'Backlog.md'), '# Backlog\n\n## Someday / unsorted\n\n- [ ] Matrix backlog item\n');
  return v;
}
const configFor = (o) => JSON.stringify({ schemaVersion: 1, onboarding: { v: 1, done: true }, ...o }, null, 2);

// ---- combinations ------------------------------------------------------------------

const COMBOS = [
  {
    name: 'new user: nothing set up',
    setup: () => null, // no config at all
    expect: { wizard: true, onboardingDone: false },
  },
  {
    name: 'interrupted onboarding resumes on next launch',
    setup: () => null,
    expect: { wizard: true, onboardingDone: false, restartBeforeCheck: true },
  },
  {
    name: 'built-in notes, no calendar',
    setup: () => configFor({}),
    expect: { wizard: false, text: ['No calendar yet'] },
  },
  {
    name: 'built-in notes, an .ics file',
    setup: (dir) => configFor({ calendar: { v: 1, sources: [{ id: 'file1', kind: 'ics-file', name: 'Matrix', path: icsFile(dir) }] } }),
    expect: { text: ['Matrix meeting'] },
  },
  {
    name: 'a notes folder, read-only, with a calendar',
    setup: (dir) =>
      configFor({
        vault: { v: 1, path: vault(dir), weeklyDir: 'Weekly', backlogPath: 'Backlog.md' },
        calendar: { v: 1, sources: [{ id: 'file1', kind: 'ics-file', name: 'Matrix', path: icsFile(dir) }] },
      }),
    expect: { text: ['Matrix intention'], notes: { kind: 'folder', canWrite: false }, refuseWrite: true },
  },
  {
    name: 'a notes folder, writable; one player; Sunday week; 24-hour',
    setup: (dir) =>
      configFor({
        vault: { v: 1, path: vault(dir), weeklyDir: 'Weekly', write: true },
        nowplaying: { v: 1, player: 'nosuchplayer' },
      }),
    presentation: { locale: { weekStart: 'sun', clock: '24h' } },
    expect: { notes: { kind: 'folder', canWrite: true }, clock24: true },
  },
  {
    name: 'a notes folder that is missing',
    setup: (dir) => configFor({ vault: { v: 1, path: path.join(dir, 'gone'), weeklyDir: 'Weekly' } }),
    expect: { text: ['Notes folder not found'] },
  },
  {
    name: 'a calendar file that is missing',
    setup: (dir) => configFor({ calendar: { v: 1, sources: [{ id: 'file1', kind: 'ics-file', name: 'Gone', path: path.join(dir, 'gone.ics') }] } }),
    expect: { wizard: false },
  },
];

// ---- CDP -------------------------------------------------------------------------

async function pages(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const p = list.filter((x) => x.type === 'page');
      if (p.length >= 3) return p;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  return [];
}

async function inspect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r);
    ws.addEventListener('error', j);
  });
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
    if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) logs.push(m.params.entry.text);
    if (m.method === 'Runtime.exceptionThrown') logs.push(`exception: ${m.params.exceptionDetails.text}`);
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) logs.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  });
  const send = (method, params = {}) =>
    new Promise((res) => {
      const my = ++id;
      pending.set(my, res);
      ws.send(JSON.stringify({ id: my, method, params }));
    });
  await send('Runtime.enable');
  await send('Log.enable');
  const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;
  return { ev, logs, close: () => ws.close() };
}

async function onboardingSnapshot(port) {
  const list = await pages(port);
  if (!list.length) throw new Error('no windows came up during onboarding restart check');
  await sleep(6000);
  let wizard = false;
  let onboarding = null;
  for (const p of list) {
    const x = await inspect(p);
    const hasApi = await x.ev('!!window.wd');
    if (hasApi && onboarding === null) onboarding = await x.ev('window.wd.onboardingStatus()');
    if (p.url.includes('index.html')) wizard ||= Boolean(await x.ev(`!!document.querySelector('.onb, .onboarding, [class*="onb__"]')`));
    x.close();
  }
  return { wizard, onboarding };
}

// ---- run ---------------------------------------------------------------------------

async function runCombo(c, i) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dhud-matrix-'));
  const profile = path.join(dir, 'profile');
  mkdirSync(profile);
  const config = c.setup(dir);
  if (config) writeFileSync(path.join(profile, 'config.json'), config);
  if (c.presentation) writeFileSync(path.join(profile, 'presentation.json'), JSON.stringify({ v: 3, ...c.presentation }));
  const readOnlyBacklog = c.expect.refuseWrite ? path.join(dir, 'vault', 'Backlog.md') : null;
  const originalBacklog = readOnlyBacklog ? readFileSync(readOnlyBacklog) : null;
  const problems = [];
  const basePort = 9350 + i;
  const port = basePort + (c.expect.restartBeforeCheck ? 1000 : 0);
  const argsFor = (debugPort) => [...(SOURCE ? [ROOT] : []), '--profile', profile, '--hud', `--remote-debugging-port=${debugPort}`];
  if (c.expect.restartBeforeCheck) {
    const first = spawn(EXE, argsFor(basePort), { stdio: 'ignore', windowsHide: true });
    try {
      const firstState = await onboardingSnapshot(basePort);
      if (!firstState.wizard || firstState.onboarding?.done !== false) {
        problems.push(`first onboarding launch did not remain unfinished: ${JSON.stringify(firstState)}`);
      }
    } catch (err) {
      problems.push(`first onboarding launch: ${err.message}`);
    } finally {
      await stopProcessTree(first);
    }
  }
  const childArgs = argsFor(port);
  const child = spawn(EXE, childArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let mainLog = '';
  child.stdout.on('data', (d) => (mainLog += d));
  child.stderr.on('data', (d) => (mainLog += d));
  try {
    const list = await pages(port);
    if (!list.length) throw new Error('no windows came up');
    await sleep(6000); // let calendars and notes load
    const seen = { text: '', wizard: false, notes: null, onboarding: null, clock: null };
    const logs = [];
    for (const p of list) {
      const x = await inspect(p);
      await sleep(300);
      seen.text += ` ${(await x.ev('document.body.innerText')) || ''}`;
      const hasApi = await x.ev('!!window.wd');
      if (hasApi && seen.notes === null) seen.notes = await x.ev('window.wd.notesStatus()');
      if (hasApi && seen.onboarding === null) seen.onboarding = await x.ev('window.wd.onboardingStatus()');
      if (p.url.includes('index.html')) seen.wizard ||= Boolean(await x.ev(`!!document.querySelector('.onb, .onboarding, [class*="onb__"]')`));
      if (p.url.includes('top-right')) seen.clock = await x.ev(`document.querySelector('.hud__time')?.textContent ?? null`);
      logs.push(...x.logs.map((l) => `${p.url.replace(/^.*\/\/hud\//, '')}: ${l}`));
      x.close();
    }
    if (logs.length) problems.push(...logs.slice(0, 5).map((l) => `console: ${l}`));
    if (/\[wd\] ipc: refused|Error:/.test(mainLog)) problems.push('main log: ' + mainLog.split('\n').find((l) => /refused|Error:/.test(l)));
    const e = c.expect;
    if (e.wizard !== undefined && seen.wizard !== e.wizard) problems.push(`wizard ${seen.wizard ? 'shown' : 'not shown'}`);
    if (e.onboardingDone !== undefined && seen.onboarding?.done !== e.onboardingDone) {
      problems.push(`onboarding status ${JSON.stringify(seen.onboarding)}`);
    }
    for (const t of e.text || []) if (!seen.text.includes(t)) problems.push(`missing text "${t}"`);
    const statusProblem = notesStatusProblem(e.notes, seen.notes);
    if (statusProblem) problems.push(statusProblem);
    if (e.refuseWrite) {
      const result = await (async () => {
        for (const p of list) {
          const x = await inspect(p);
          const hasApi = await x.ev('!!window.wd && typeof window.wd.appendBacklog === "function"');
          const value = hasApi ? await x.ev(`window.wd.appendBacklog('Matrix read-only write probe')`) : null;
          x.close();
          if (hasApi) return value;
        }
        return null;
      })();
      if (!result || result.ok !== false) problems.push(`read-only write was not refused: ${JSON.stringify(result)}`);
      if (readOnlyBacklog && !readFileSync(readOnlyBacklog).equals(originalBacklog)) {
        problems.push('read-only write probe changed the synthetic backlog file');
      }
    }
    if (e.clock24 && !/^\d{2}:\d{2}$/.test(seen.clock || '')) problems.push(`clock "${seen.clock}" is not 24-hour`);
  } catch (err) {
    problems.push(err.message);
  } finally {
    await stopProcessTree(child);
    if (!KEEP) removeTempDir(dir);
  }
  return problems;
}

async function main() {
  if (SOURCE) {
    const { spawnSync } = await import('node:child_process');
    const check = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'assert-public.mjs')], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
    if (check.status !== 0) throw new Error('public-source assertion failed');
  }
  if (!existsSync(EXE)) throw new Error(`missing ${SOURCE ? 'Electron runtime' : 'packaged app'} at ${EXE}`);
  let failed = 0;
  for (const [i, c] of COMBOS.entries()) {
    const p = await runCombo(c, i);
    if (p.length) failed++;
    console.log(`${p.length ? 'FAIL' : 'ok  '}  ${c.name}${p.length ? `\n        ${p.join('\n        ')}` : ''}`);
  }
  console.log(failed ? `\n${failed} of ${COMBOS.length} combinations failed` : `\nAll ${COMBOS.length} combinations pass`);
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('[matrix] failed:', e.message);
    process.exitCode = 1;
  });
}
