'use strict';

const os = require('os');
const fs = require('fs');
const pty = require('@homebridge/node-pty-prebuilt-multiarch');

const IS_WINDOWS = process.platform === 'win32';

// Resolve the claude executable. On PATH in most installs; node-pty will
// search PATH for a bare name on Windows when using the conpty backend.
const CLAUDE_BIN = process.env.CLAUDE_BIN || (IS_WINDOWS ? 'claude.exe' : 'claude');

let nextId = 1;

// Recent output kept per pty so a reloaded renderer (after a renderer crash)
// can reattach to sessions that kept running and repaint their panes.
const SCROLLBACK_CHARS = 1024 * 1024;

const dim = (v, dflt) => (Number.isFinite(v) && v >= 1 ? Math.min(Math.floor(v), 1000) : dflt);

class PtyManager {
  constructor() {
    this._procs = new Map(); // id -> { proc, sessionId, cwd, label, chunks, size }
  }

  // Spawn a Claude instance. If sessionId is given we resume it; otherwise a
  // fresh session starts in the given cwd.
  start({ sessionId, cwd, label, cols, rows }, { onData, onExit }) {
    cols = dim(cols, 80); // NaN/0 from a hidden pane can crash the native pty
    rows = dim(rows, 24);
    if (typeof cwd !== 'string') cwd = '';
    const id = nextId++;
    const args = sessionId ? ['--resume', sessionId] : [];

    // Launch in the session's own directory. If it's missing (moved/deleted),
    // fall back to home so the spawn can't crash on a stale path.
    let workdir = os.homedir();
    if (cwd && cwd.length) {
      try {
        if (fs.statSync(cwd).isDirectory()) workdir = cwd;
      } catch (_) {
        /* stale path -> keep home fallback */
      }
    }

    let proc;
    try {
      proc = pty.spawn(CLAUDE_BIN, args, {
        name: 'xterm-color',
        cols,
        rows,
        cwd: workdir,
        env: process.env,
        useConpty: IS_WINDOWS, // ConPTY on Windows 11 gives a real TTY
      });
    } catch (e) {
      // claude not on PATH, ConPTY init failure, etc. Surface a clean message
      // to the renderer (the invoke rejects) so it can show it and clean up.
      throw new Error('Failed to start "' + CLAUDE_BIN + '": ' + (e && e.message ? e.message : e));
    }

    const rec = {
      proc,
      sessionId: sessionId || null,
      cwd,
      label: typeof label === 'string' ? label.slice(0, 200) : '',
      chunks: [],
      size: 0,
    };
    proc.onData((data) => {
      rec.chunks.push(data);
      rec.size += data.length;
      while (rec.size > SCROLLBACK_CHARS && rec.chunks.length > 1) rec.size -= rec.chunks.shift().length;
      onData(id, data);
    });
    proc.onExit(({ exitCode }) => {
      this._procs.delete(id);
      onExit(id, exitCode);
    });

    this._procs.set(id, rec);
    return { id, pid: proc.pid }; // pid lets the UI read sessions/<pid>.json status
  }

  // Live ptys with their recent output, for a renderer that is reattaching.
  list() {
    return [...this._procs.entries()].map(([id, r]) => ({
      id,
      pid: r.proc.pid,
      sessionId: r.sessionId,
      cwd: r.cwd,
      label: r.label,
      scrollback: r.chunks.join(''),
    }));
  }

  write(id, data) {
    const entry = this._procs.get(id);
    if (!entry) return;
    try {
      entry.proc.write(data);
    } catch (_) {
      /* pty already gone */
    }
  }

  resize(id, cols, rows) {
    const entry = this._procs.get(id);
    if (!entry) return;
    // Bad dimensions (NaN/0 from fitting a hidden pane) can crash native pty.
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return;
    try {
      entry.proc.resize(Math.floor(cols), Math.floor(rows));
    } catch (_) {
      /* resize can race with exit */
    }
  }

  kill(id) {
    const entry = this._procs.get(id);
    if (entry) {
      try {
        entry.proc.kill();
      } catch (_) {
        /* already gone */
      }
      this._procs.delete(id);
    }
  }

  killAll() {
    for (const id of [...this._procs.keys()]) this.kill(id);
  }
}

module.exports = { PtyManager };
