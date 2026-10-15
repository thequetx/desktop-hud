'use strict';
// Runs calendar parses in the ICS worker (electron/ics-worker.cjs) with a time
// limit (Phase 9.4, trust model S3). One worker, started on first use, one
// parse at a time. A parse that runs past the limit kills the worker and
// fails; the next parse starts a fresh one. An idle worker stops after
// IDLE_MS (Phase 9.6, Bug Log #62): parses come every 15 minutes, and a
// fresh worker starts in well under a second.
//
// `fork` is injected so tests can stand in for Electron's utilityProcess.

const path = require('node:path');

const TIME_LIMIT_MS = 10_000;
const IDLE_MS = 30_000;

function makeParserHost({ fork, script = path.join(__dirname, 'ics-worker.cjs'), timeLimitMs = TIME_LIMIT_MS, idleMs = IDLE_MS, log = console.log }) {
  let child = null;
  let seq = 0;
  let queue = Promise.resolve();
  let running = 0;
  let idleTimer = null;
  const pending = new Map();

  function stopChild() {
    try {
      if (child) child.kill();
    } catch {
      // already gone
    }
    child = null;
  }
  function armIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (running === 0 && pending.size === 0) stopChild();
    }, idleMs);
    if (idleTimer.unref) idleTimer.unref();
  }

  function spawn() {
    child = fork(script, [], { serviceName: 'Desktop HUD calendar reader' });
    const me = child;
    child.on('message', (msg) => {
      const p = msg && pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      p.resolve(msg);
    });
    child.on('exit', () => {
      if (child === me) child = null;
      // Only this worker's requests. A worker killed for running long exits
      // after its replacement has started on the next calendar.
      for (const [id, p] of pending) {
        if (p.child !== me) continue;
        pending.delete(id);
        p.resolve({ id, ok: false, error: 'the calendar reader stopped' });
      }
    });
  }

  function once(text, minMs, maxMs) {
    if (!child) spawn();
    const id = ++seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        log('[wd] ics: a calendar took too long to read; stopped');
        try {
          if (child) child.kill();
        } catch {
          // already gone
        }
        child = null;
        resolve({ id, ok: false, error: 'the calendar took too long to read' });
      }, timeLimitMs);
      pending.set(id, {
        child,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
      child.postMessage({ id, text, minMs, maxMs });
    });
  }

  return {
    /** `{ ok, events, truncated }` or `{ ok: false, error }`. Never throws. */
    parse(text, minMs, maxMs) {
      running++;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      const run = queue.then(() => once(text, minMs, maxMs)).finally(() => {
        running--;
        if (running === 0) armIdle();
      });
      queue = run.catch(() => {});
      return run;
    },
    stop() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      stopChild();
    },
    /** For tests: whether a worker is running now. */
    get alive() {
      return child != null;
    },
  };
}

module.exports = { makeParserHost, TIME_LIMIT_MS };
