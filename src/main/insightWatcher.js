'use strict';

// Insight extraction for ONE session at a time (whichever the renderer's
// insight pane is following). Surfaces the transcript layers the terminal
// hides: thinking blocks, the tool-call feed, subagent launches, and the
// latest TodoWrite state. Incremental tail-parsing, same discipline as
// sessionWatcher: only appended bytes are read on change.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { findTranscript } = require('./sessionWatcher');

const KEEP_TOOLS = 40;
const KEEP_THINK = 6;
const KEEP_AGENTS = 12;

let current = null; // { sessionId, file, watcher, debounce, offset, state, pending, push }

function newState(sessionId) {
  return {
    sessionId,
    todos: [], // latest TodoWrite: [{content, status}]
    thinking: [], // last few thinking blocks: [{ts, side, text}]
    tools: [], // last tool calls: [{ts, side, name, detail, status, err?}]
    agents: [], // subagent launches: [{ts, side, desc, type, status}]
    counts: { tools: 0, thinking: 0, agents: 0 },
  };
}

function textOf(c) {
  // tool_result content is a string or an array of {type:'text', text} blocks
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

function toolDetail(b) {
  const i = b.input || {};
  const d = i.description || i.file_path || i.path || i.command || i.pattern || i.url || i.skill || '';
  return String(d).slice(0, 140);
}

function foldLine(line) {
  const { state, pending } = current;
  let r;
  try {
    r = JSON.parse(line);
  } catch (_) {
    return;
  }
  const m = r.message;
  if (!m || !Array.isArray(m.content)) return;
  const ts = r.timestamp ? Date.parse(r.timestamp) : 0;
  const side = !!r.isSidechain; // subagent turns recorded inline
  for (const b of m.content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'thinking') {
      if (b.thinking && String(b.thinking).trim()) {
        state.counts.thinking++;
        state.thinking.push({ ts, side, text: String(b.thinking).slice(0, 1500) });
        if (state.thinking.length > KEEP_THINK) state.thinking.shift();
      }
    } else if (b.type === 'tool_use') {
      if (b.name === 'TodoWrite' && b.input && Array.isArray(b.input.todos)) {
        state.todos = b.input.todos.map((t) => ({
          content: String((t && t.content) || '').slice(0, 200),
          status: (t && t.status) || '',
        }));
      } else if (b.name === 'Task' || b.name === 'Agent') {
        state.counts.agents++;
        const a = {
          ts,
          side,
          desc: String((b.input && b.input.description) || 'subagent').slice(0, 120),
          type: (b.input && b.input.subagent_type) || '',
          status: 'running',
        };
        state.agents.push(a);
        if (state.agents.length > KEEP_AGENTS) state.agents.shift();
        if (b.id) trackPending(b.id, a);
      } else {
        state.counts.tools++;
        const t = { ts, side, name: b.name || '?', detail: toolDetail(b), status: 'pending' };
        state.tools.push(t);
        if (state.tools.length > KEEP_TOOLS) state.tools.shift();
        if (b.id) trackPending(b.id, t);
      }
    } else if (b.type === 'tool_result' && b.tool_use_id) {
      const t = pending.get(b.tool_use_id);
      if (t) {
        t.status = b.is_error ? 'error' : 'ok';
        if (b.is_error) t.err = textOf(b.content).slice(0, 200);
        pending.delete(b.tool_use_id);
      }
    }
  }
}

// pending maps tool ids to their feed rows until the result lands; results
// essentially always arrive, but cap it so an aborted run can't grow it.
function trackPending(id, row) {
  const { pending } = current;
  pending.set(id, row);
  if (pending.size > 300) pending.delete(pending.keys().next().value);
}

function completePrefixBytes(text) {
  const lastNl = text.lastIndexOf('\n');
  return lastNl === -1 ? 0 : Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8');
}

function foldChunk(text) {
  const lastNl = text.lastIndexOf('\n');
  if (lastNl === -1) return 0;
  const complete = text.slice(0, lastNl + 1);
  for (const line of complete.split('\n')) if (line) foldLine(line);
  return Buffer.byteLength(complete, 'utf8');
}

function snapshot() {
  return JSON.parse(JSON.stringify(current.state));
}

function onFileChange() {
  if (!current) return;
  clearTimeout(current.debounce);
  current.debounce = setTimeout(() => {
    if (!current) return;
    try {
      const st = fs.statSync(current.file);
      if (st.size < current.offset) {
        // shrink (rewrite): rebuild from scratch
        const c = current;
        openInsight(c.sessionId, c.cwd, c.push);
        return;
      }
      if (st.size === current.offset) return;
      const fd = fs.openSync(current.file, 'r');
      let chunk = '';
      try {
        const buf = Buffer.alloc(st.size - current.offset);
        const got = fs.readSync(fd, buf, 0, buf.length, current.offset);
        chunk = buf.toString('utf8', 0, got);
      } finally {
        fs.closeSync(fd);
      }
      current.offset += foldChunk(chunk);
      current.push(snapshot());
    } catch (_) {
      /* transient read error; next change retries */
    }
  }, 300);
}

// Static-ish environment info for the pane footer: MCP servers and hooks
// visible to a session running in `cwd`. Read once per open.
function readEnvInfo(cwd) {
  const mcp = [];
  const hooks = [];
  const addMcp = (obj, scope) => {
    for (const name of Object.keys(obj || {})) mcp.push({ name, scope });
  };
  try {
    const cj = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    addMcp(cj.mcpServers, 'global');
    if (cwd && cj.projects && cj.projects[cwd]) addMcp(cj.projects[cwd].mcpServers, 'project');
  } catch (_) {}
  if (cwd) {
    try {
      addMcp(JSON.parse(fs.readFileSync(path.join(cwd, '.mcp.json'), 'utf8')).mcpServers, 'repo');
    } catch (_) {}
  }
  const readHooks = (file, scope) => {
    try {
      const h = JSON.parse(fs.readFileSync(file, 'utf8')).hooks || {};
      for (const [event, arr] of Object.entries(h)) {
        hooks.push({ event, count: Array.isArray(arr) ? arr.length : 1, scope });
      }
    } catch (_) {}
  };
  readHooks(path.join(os.homedir(), '.claude', 'settings.json'), 'user');
  if (cwd) {
    readHooks(path.join(cwd, '.claude', 'settings.json'), 'repo');
    readHooks(path.join(cwd, '.claude', 'settings.local.json'), 'local');
  }
  return { mcp, hooks };
}

// Open (or retarget) the single insight watcher. Returns the first snapshot
// plus env info; subsequent updates flow through push(snapshot).
function openInsight(sessionId, cwd, push) {
  closeInsight();
  const file = findTranscript(sessionId, cwd);
  const env = readEnvInfo(cwd || '');
  if (!file) return { state: newState(sessionId), env };
  current = {
    sessionId,
    cwd,
    file,
    watcher: null,
    debounce: null,
    offset: 0,
    state: newState(sessionId),
    pending: new Map(),
    push,
  };
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {}
  current.offset = foldChunk(raw);
  try {
    current.watcher = fs.watch(file, onFileChange);
    current.watcher.on('error', () => closeInsight());
  } catch (_) {
    /* file vanished; snapshot still useful */
  }
  return { state: snapshot(), env };
}

function closeInsight() {
  if (!current) return;
  clearTimeout(current.debounce);
  try {
    if (current.watcher) current.watcher.close();
  } catch (_) {}
  current = null;
}

module.exports = { openInsight, closeInsight };
