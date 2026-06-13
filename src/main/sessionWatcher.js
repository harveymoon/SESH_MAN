'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

// A live session is considered "active" (vs idle-but-open) if its file updated
// within this window.
const ACTIVE_MS = 3 * 60 * 1000;

// Claude encodes a cwd into a projects/ folder name by replacing every
// non-alphanumeric character with a dash (C:\CODE\winri -> C--CODE-winri).
function encodeCwd(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

// Instant liveness probe (no process-list refresh) — catches a just-closed
// session immediately, where the cached process list would lag a few seconds.
function isAliveNow(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Locate the transcript .jsonl for a session: try the derived path, then scan.
function findTranscript(sessionId, cwd) {
  if (cwd) {
    const guess = path.join(PROJECTS_DIR, encodeCwd(cwd), `${sessionId}.jsonl`);
    if (fs.existsSync(guess)) return guess;
  }
  try {
    for (const dir of fs.readdirSync(PROJECTS_DIR)) {
      const candidate = path.join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch (_) {
    /* projects dir missing */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Live process tracking. The only trustworthy "is it running" signal is that a
// claude.exe with the recorded pid AND matching start time is currently alive
// (pids get recycled, so start-time must match).
// ---------------------------------------------------------------------------
const PS_LIST =
  `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'claude.exe' } | ` +
  `ForEach-Object { "$($_.ProcessId)|$($_.CreationDate.ToString('o'))" }`;

class ProcessTracker {
  constructor() {
    this.byPid = new Map(); // pid -> creation epoch ms
  }
  refresh() {
    return new Promise((resolve) => {
      if (process.platform !== 'win32') return resolve();
      execFile(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', PS_LIST],
        { windowsHide: true, timeout: 8000 },
        (err, stdout) => {
          if (err || !stdout) return resolve();
          const next = new Map();
          for (const row of stdout.split(/\r?\n/)) {
            const [pid, iso] = row.split('|');
            if (!pid) continue;
            const ms = Date.parse(iso);
            next.set(Number(pid), Number.isNaN(ms) ? 0 : ms);
          }
          this.byPid = next;
          resolve();
        }
      );
    });
  }
  // True if this pid is alive and was started ~when the session recorded.
  matches(pid, startedAt) {
    if (!this.byPid.has(pid)) return false;
    if (!startedAt) return true; // no start time recorded; pid presence is best we have
    return Math.abs(this.byPid.get(pid) - startedAt) < 10000;
  }
}

// ---------------------------------------------------------------------------
// Reading session metadata files (rich live status, keyed by pid).
// ---------------------------------------------------------------------------
function readSessionFiles() {
  const bySession = new Map(); // sessionId -> session file data
  let files = [];
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch (_) {
    return bySession;
  }
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
      if (d && d.sessionId) bySession.set(d.sessionId, d);
    } catch (_) {
      /* file mid-write; skip this pass */
    }
  }
  return bySession;
}

// ---------------------------------------------------------------------------
// Transcript parsing (the authoritative list of sessions), cached by mtime.
// ---------------------------------------------------------------------------
const transcriptCache = new Map(); // file -> { mtimeMs, meta }

// Pull the prose out of a message record. Returns '' for tool-only turns so
// the "most recent message" stays on actual human/assistant text.
function messageText(msg) {
  if (!msg) return '';
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    for (const b of c) if (b && b.type === 'text' && b.text) return b.text;
  }
  return '';
}

function parseTranscript(file) {
  const meta = {
    cwd: null,
    aiTitle: null,
    lastPrompt: null,
    version: '',
    gitBranch: '',
    entrypoint: null,
    customTitle: null, // user's /rename title
    messageCount: 0,
    lastActivity: 0,
    lastMessage: null, // { role, text } of the most recent user/assistant message
  };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return meta;
  }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (r.cwd && !meta.cwd) meta.cwd = r.cwd; // keep the session's original (root) cwd
    if (r.version) meta.version = r.version;
    if (r.gitBranch) meta.gitBranch = r.gitBranch;
    if (r.entrypoint) meta.entrypoint = r.entrypoint; // last seen reflects most recent use
    if (r.type === 'ai-title' && r.aiTitle) meta.aiTitle = r.aiTitle;
    else if (r.type === 'custom-title' && r.customTitle) meta.customTitle = r.customTitle;
    else if (r.type === 'last-prompt' && r.lastPrompt) meta.lastPrompt = r.lastPrompt;
    else if (r.type === 'user' || r.type === 'assistant') {
      meta.messageCount++;
      const text = messageText(r.message);
      if (text && text.trim()) meta.lastMessage = { role: r.type, text: text.trim() };
    }
    if (r.timestamp) {
      const t = Date.parse(r.timestamp);
      if (t > meta.lastActivity) meta.lastActivity = t;
    }
  }
  return meta;
}

function getTranscriptMeta(file, mtimeMs) {
  const cached = transcriptCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.meta;
  const meta = parseTranscript(file);
  transcriptCache.set(file, { mtimeMs, meta });
  return meta;
}

// Read the conversation (user/assistant text turns) for a read-only log view.
function readTranscriptMessages(file, limit = 400) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (r.type !== 'user' && r.type !== 'assistant') continue;
    const text = messageText(r.message);
    if (!text || !text.trim()) continue;
    out.push({ role: r.type, text: text.trim(), ts: r.timestamp ? Date.parse(r.timestamp) : 0 });
  }
  return out.slice(-limit);
}

// Normalize entrypoint into a coarse source: 'desktop' or 'cli'.
function sourceOf(entrypoint) {
  return /desktop/i.test(entrypoint || '') ? 'desktop' : 'cli';
}

function projectNameFromCwd(cwd, dirName) {
  if (cwd) return path.basename(cwd.replace(/[\\/]+$/, ''));
  // Fall back to the encoded folder name (last dash-delimited chunk).
  const parts = dirName.split('-').filter(Boolean);
  return parts[parts.length - 1] || dirName;
}

// ---------------------------------------------------------------------------
class SessionWatcher extends EventEmitter {
  constructor({ pollMs = 2000, procMs = 4000 } = {}) {
    super();
    this.pollMs = pollMs;
    this.procMs = procMs;
    this.proc = new ProcessTracker();
    this._timer = null;
    this._procTimer = null;
    this._last = '';
  }

  async start() {
    // Guard against double-start: without this a second start() without an
    // intervening stop() would overwrite the interval handles and leak them
    // (the old intervals would poll forever).
    this.stop();
    await this.proc.refresh();
    await this.scan();
    this._timer = setInterval(() => this.scan(), this.pollMs);
    this._procTimer = setInterval(() => this.proc.refresh().then(() => this.scan()), this.procMs);
    return this;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    if (this._procTimer) clearInterval(this._procTimer);
    this._timer = this._procTimer = null;
  }

  list() {
    const now = Date.now();
    const sessionFiles = readSessionFiles();
    const sessions = [];

    let projectDirs = [];
    try {
      projectDirs = fs.readdirSync(PROJECTS_DIR);
    } catch (_) {
      return [];
    }

    for (const dirName of projectDirs) {
      const dir = path.join(PROJECTS_DIR, dirName);
      let entries = [];
      try {
        entries = fs.readdirSync(dir);
      } catch (_) {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) continue;
        const file = path.join(dir, entry);
        let st;
        try {
          st = fs.statSync(file);
        } catch (_) {
          continue;
        }
        const sessionId = entry.replace(/\.jsonl$/, '');
        const sf = sessionFiles.get(sessionId);

        // Show every session — no time filter. The UI groups them by age.
        const meta = getTranscriptMeta(file, st.mtimeMs);
        // matches() guards against PID reuse; isAliveNow() flips to dead the
        // instant a process exits (vs. the ~4s process-list cache).
        const running = sf ? this.proc.matches(sf.pid, sf.startedAt) && isAliveNow(sf.pid) : false;
        const updatedAt = sf ? sf.updatedAt || 0 : st.mtimeMs;
        const active = running && now - updatedAt < ACTIVE_MS;

        sessions.push({
          sessionId,
          cwd: meta.cwd || (sf && sf.cwd) || '',
          project: projectNameFromCwd(meta.cwd || (sf && sf.cwd), dirName),
          name: (sf && sf.name) || meta.aiTitle || null,
          customTitle: meta.customTitle || (sf && sf.name) || null,
          source: sourceOf((sf && sf.entrypoint) || meta.entrypoint),
          status: running ? (sf && sf.status) || 'idle' : 'stopped',
          running,
          active,
          alive: running, // back-compat with renderer
          pid: sf ? sf.pid : null,
          version: meta.version || (sf && sf.version) || '',
          gitBranch: meta.gitBranch || '',
          startedAt: sf ? sf.startedAt || 0 : 0,
          updatedAt,
          lastActivity: Math.max(meta.lastActivity || 0, updatedAt, st.mtimeMs),
          aiTitle: meta.aiTitle,
          lastPrompt: meta.lastPrompt,
          lastMessage: meta.lastMessage,
          messageCount: meta.messageCount,
        });
      }
    }

    // Pure recency: most recently active first, regardless of run state.
    sessions.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
    return sessions;
  }

  // Fresh, instant check used at click time to decide resume vs read-only.
  isLive(sessionId) {
    const sf = readSessionFiles().get(sessionId);
    if (!sf || !sf.pid) return false;
    if (!isAliveNow(sf.pid)) return false;
    // pid alive — if we have cached start time, confirm it's the same process.
    if (this.proc.byPid.has(sf.pid)) return this.proc.matches(sf.pid, sf.startedAt);
    return true;
  }

  async scan() {
    const sessions = this.list();
    const snapshot = JSON.stringify(sessions);
    if (snapshot !== this._last) {
      this._last = snapshot;
      this.emit('update', sessions);
    }
  }
}

module.exports = {
  SessionWatcher,
  SESSIONS_DIR,
  PROJECTS_DIR,
  findTranscript,
  readTranscriptMessages,
};
