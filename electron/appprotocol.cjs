'use strict';
// The app's own pages over app://hud/ instead of file:// (Phase 9.4, trust
// model S10). A file:// page can read any file the user can, given the
// GrantFileProtocolExtraPrivileges fuse that file:// loading needs; with the
// pages here the fuse is off, and a page can reach only dist/.
//
// Requests are answered from dist/ (inside app.asar when packaged; Electron's
// fs reads it transparently). Anything outside it, or any other host, is a 404.

const fs = require('node:fs/promises');
const path = require('node:path');

const SCHEME = 'app';
const HOST = 'hud';
const ORIGIN = `${SCHEME}://${HOST}`;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.yaml': 'text/yaml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** Before app ready: app:// behaves like a normal secure web origin. */
function registerScheme(protocol) {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
  ]);
}

/** The file under `root` a request names, or null (another host, or outside root). */
function fileFor(url, root) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${SCHEME}:` || u.host !== HOST) return null;
  let rel;
  try {
    rel = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  if (rel.includes('\0')) return null;
  const base = path.resolve(root);
  const abs = path.resolve(base, `.${rel.endsWith('/') ? `${rel}index.html` : rel}`);
  return abs === base || !abs.startsWith(base + path.sep) ? null : abs;
}

/** After app ready: answer app://hud/ from `root`. `extra` maps a path to an
 *  HTML string (the design-shots harness's blank page). */
function serve(protocol, root, extra = {}) {
  protocol.handle(SCHEME, async (req) => {
    try {
      const p = new URL(req.url).pathname;
      if (Object.prototype.hasOwnProperty.call(extra, p)) {
        return new Response(extra[p], { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
    } catch {
      // fall through to the 404 below
    }
    const abs = fileFor(req.url, root);
    if (!abs) return new Response('not found', { status: 404 });
    try {
      const body = await fs.readFile(abs);
      return new Response(body, {
        status: 200,
        headers: { 'content-type': TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream' },
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

/** The URL of one of the app's pages, with its query. */
function pageUrl(page, query) {
  const qs = query && Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : '';
  return `${ORIGIN}/${page}${qs}`;
}

module.exports = { registerScheme, serve, pageUrl, fileFor, SCHEME, HOST, ORIGIN };
