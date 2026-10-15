'use strict';
// The ICS worker: a utilityProcess the main process forks to parse calendars
// (Phase 9.4, trust model S3). It parses one request at a time and answers on
// its parent port; electron/icsparse-host.cjs kills it if a parse runs past
// its time limit, so a hostile file can cost seconds, never the tray.

const { parseIcs } = require('./icsparse.cjs');

process.parentPort.on('message', (e) => {
  const { id, text, minMs, maxMs } = e.data || {};
  try {
    const r = parseIcs(text, minMs, maxMs);
    process.parentPort.postMessage({ id, ok: true, events: r.events, truncated: r.truncated });
  } catch (err) {
    process.parentPort.postMessage({ id, ok: false, error: 'the calendar file could not be read' });
  }
});
