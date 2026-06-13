'use strict';

const os = require('os');
const fs = require('fs');
const pty = require('@homebridge/node-pty-prebuilt-multiarch');

const IS_WINDOWS = process.platform === 'win32';

// Resolve the claude executable. On PATH in most installs; node-pty will
// search PATH for a bare name on Windows when using the conpty backend.
const CLAUDE_BIN = process.env.CLAUDE_BIN || (IS_WINDOWS ? 'claude.exe' : 'claude');

let nextId = 1;

class PtyManager {
  constructor() {
    this._procs = new Map(); // id -> { proc, sessionId }
  }

  // Spawn a Claude instance. If sessionId is given we resume it; otherwise a
  // fresh session starts in the given cwd.
  start({ sessionId, cwd, cols = 80, rows = 24 }, { onData, onExit }) {
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

    proc.onData((data) => onData(id, data));
    proc.onExit(({ exitCode }) => {
      this._procs.delete(id);
      onExit(id, exitCode);
    });

    this._procs.set(id, { proc, sessionId });
    return { id, pid: proc.pid }; // pid lets the UI read sessions/<pid>.json status
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
