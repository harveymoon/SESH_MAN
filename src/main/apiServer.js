'use strict';

// Tiny local HTTP API for external controllers (e.g. Desk_Deck).
// Pure Node (http/fs/crypto) — Electron-specific bits are passed in, so this
// module is unit-testable standalone. Binds 127.0.0.1 only.
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

// Constant-time token comparison (avoids leaking length/prefix via timing).
function tokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function ensureToken(file) {
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t) return t;
  } catch (_) {
    /* not created yet */
  }
  const t = crypto.randomBytes(32).toString('base64url');
  try {
    fs.writeFileSync(file, t, { mode: 0o600 });
  } catch (_) {
    /* best effort */
  }
  return t;
}

// opts: { port, tokenFile, version, getSnapshot(), onFocus(id), log(msg) }
function start(opts) {
  const { port = 7374, tokenFile, version = '0', getSnapshot, onFocus, log = () => {} } = opts;
  const token = ensureToken(tokenFile);

  const server = http.createServer((req, res) => {
    // No CORS headers: this is a loopback control surface for native clients
    // (Desk_Deck etc.), not a browser API. Omitting Access-Control-Allow-Origin
    // means a web page in the user's browser can't read our responses, so it
    // can't fingerprint the app or (if the token leaked) drive it.
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    // status — no auth (availability probe)
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return json(200, { ok: true, version, features: ['sessions', 'switch'] });
    }

    // Everything else gates on the token via the Authorization: Bearer header
    // only. We deliberately do NOT accept the token in the query string — query
    // strings leak into browser history, shell history, and proxy/server logs.
    const auth = req.headers['authorization'] || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!tokenEqual(bearer, token)) {
      return json(401, { error: 'bad_token', message: 'invalid or missing token' });
    }

    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      const snap = getSnapshot() || { items: [], current: null };
      // Default: only live sessions (this is a "what's active" surface).
      // Pass ?all=1 to include stopped/resumable ones too.
      const all = ['1', 'true', 'yes'].includes((url.searchParams.get('all') || '').toLowerCase());
      const items = all ? snap.items : snap.items.filter((it) => it.running);
      return json(200, { items, current: snap.current });
    }

    const m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/focus$/);
    if (req.method === 'POST' && m) {
      const id = decodeURIComponent(m[1]);
      try {
        onFocus(id);
      } catch (e) {
        log('onFocus failed: ' + e.message);
      }
      res.writeHead(204);
      return res.end();
    }

    json(404, { error: 'not_found', message: 'unknown endpoint' });
  });

  server.on('error', (e) => log('API server error: ' + e.message));
  server.listen(port, '127.0.0.1', () => log('API listening on http://127.0.0.1:' + port));
  return server;
}

module.exports = { start, ensureToken };
