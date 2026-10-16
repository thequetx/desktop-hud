'use strict';
// A durable, confined deletion queue. Failed entries stay pending; startup must
// finish it before opening settings or starting providers again.
const fs = require('node:fs');
const path = require('node:path');
const { CHROMIUM, REMOVE_MARKER, BUILTIN_NOTES } = require('./diagnostics.cjs');

function validEntry(name) {
  return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..'
    && name !== REMOVE_MARKER && name !== REMOVE_MARKER + '.tmp' && !/[. ]$/.test(name) && !/[\\/\0:]/.test(name) && path.basename(name) === name;
}
function markerFile(root) { return path.join(root, REMOVE_MARKER); }
function save(root, entries) {
  fs.writeFileSync(markerFile(root) + '.tmp', JSON.stringify({ v: 1, pending: [...new Set(entries)] }), 'utf8');
  fs.renameSync(markerFile(root) + '.tmp', markerFile(root));
}
function begin(root, { notes = false, protect = [] } = {}) {
  const entries = fs.readdirSync(root).filter(n => validEntry(n) && (notes || n !== BUILTIN_NOTES) && !protect.includes(n));
  // Commit intent before deleting anything; a crash can safely retry it all.
  save(root, entries);
  return entries;
}
function read(root) {
  const text = fs.readFileSync(markerFile(root), 'utf8');
  if (!text.trim()) return [...CHROMIUM]; // Legacy marker knew only these names.
  const parsed = JSON.parse(text);
  if (parsed.v !== 1 || !Array.isArray(parsed.pending) || parsed.pending.some(n => !validEntry(n))) {
    throw new Error('Invalid cleanup queue; no data was deleted');
  }
  return parsed.pending;
}
function retry(root, { deferChromium = false, remove = removeEntry } = {}) {
  if (!fs.existsSync(markerFile(root))) return { requested: false, pending: [] };
  const entries = read(root); // Reject the whole queue before doing any work.
  const pending = [];
  for (const name of entries) {
    if (deferChromium && CHROMIUM.has(name)) { pending.push(name); continue; }
    const target = path.resolve(root, name);
    if (path.dirname(target) !== path.resolve(root)) throw new Error('Cleanup target escaped its data folder');
    try { remove(target); } catch { pending.push(name); }
  }
  if (pending.length || deferChromium) save(root, pending);
  else fs.rmSync(markerFile(root), { force: true });
  return { requested: true, pending };
}
function removeEntry(target) {
  let st;
  try { st = fs.lstatSync(target); } catch (err) { if (err.code === 'ENOENT') return; throw err; }
  // Unlink a junction itself; never recurse into the directory it points at.
  if (st.isSymbolicLink()) fs.unlinkSync(target);
  else fs.rmSync(target, { recursive: true, force: true });
}
module.exports = { validEntry, begin, retry, read };
