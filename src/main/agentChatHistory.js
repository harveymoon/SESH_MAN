'use strict';

// Fetches group-chat history from the (remote, LAN) agent-chat dashboard logger.
// Pure Node http — never throws; on any error returns an offline shape so the
// UI can degrade gracefully (the LAN host is often unreachable).
const http = require('http');

// The NanoClaw dashboard logger is bound to LOOPBACK on the dashboard host
// (to avoid WSL->LAN port-forwarding), so it only answers on 127.0.0.1 — the
// same default the agent-chat skill uses. Override via env if it moves.
const HISTORY_BASE = process.env.AGENTCHAT_HISTORY_API || 'http://127.0.0.1:4444';

function fetchHistory(group, limit = 200) {
  return new Promise((resolve) => {
    if (!group) return resolve({ ok: false, offline: false, messages: [] });
    let url;
    try {
      url = new URL('/api/dashboard/agent-chat/messages', HISTORY_BASE);
      url.searchParams.set('group', group);
      url.searchParams.set('limit', String(limit));
    } catch (_) {
      return resolve({ ok: false, offline: true, messages: [] });
    }

    // resolve at most once even if several error/end paths race.
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const offline = () => finish({ ok: false, offline: true, messages: [] });

    const req = http.get(url, { timeout: 3000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return offline();
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      // A socket that dies after headers but before 'end' (common on a flaky
      // LAN host) emits 'error'/'aborted' on the response — without these the
      // promise would never resolve and the IPC invoke would leak.
      res.on('error', offline);
      res.on('aborted', offline);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          finish({ ok: true, offline: false, messages: Array.isArray(data.messages) ? data.messages : [] });
        } catch (_) {
          offline();
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', offline);
  });
}

module.exports = { fetchHistory };
