'use strict';

/* global Terminal, FitAddon */

const sessionListEl = document.getElementById('session-list');
const sessionCountEl = document.getElementById('session-count');
const sourceFilterEl = document.getElementById('source-filter');
const archivedToggleEl = document.getElementById('archived-toggle');
const searchEl = document.getElementById('search');
const gridToggleEl = document.getElementById('grid-toggle');
const gridViewEl = document.getElementById('grid-view');
const terminalsEl = document.getElementById('terminals');
const emptyStateEl = document.getElementById('empty-state');
const paneHeaderEl = document.getElementById('pane-header');
const paneTitleEl = document.getElementById('pane-title');
const paneSubEl = document.getElementById('pane-sub');
const paneCloseEl = document.getElementById('pane-close');
const groupModalEl = document.getElementById('group-modal');
const groupHeaderEl = document.getElementById('group-header');
const groupHeaderNameEl = document.getElementById('group-header-name');
const groupEndBtn = document.getElementById('group-end');
const groupCloseBtn = document.getElementById('group-close');
const groupHistoryPaneEl = document.getElementById('group-history-pane');
const groupHistoryLogEl = document.getElementById('group-history-log');
const groupHistoryBannerEl = document.getElementById('group-history-banner');
const queuePaneEl = document.getElementById('queue-pane');
const queueToggleEl = document.getElementById('queue-toggle');
const queueListEl = document.getElementById('queue-list');
const queueAddEl = document.getElementById('queue-add');
const queueTargetEl = document.getElementById('queue-target');
const bookmarkSelectEl = document.getElementById('bookmark-select');
const bookmarkManageEl = document.getElementById('bookmark-manage');
const bookmarkModalEl = document.getElementById('bookmark-modal');
const bmListEl = document.getElementById('bm-list');
const bmCloseEl = document.getElementById('bm-close');

// ptyId -> { term, fit, sessionId, pane, tab, exited }
const terms = new Map();
// sessionId -> ptyId  (so re-clicking a session focuses its existing tab)
const sessionToPty = new Map();
let activePtyId = null;
let latestSessions = [];
let sourceFilter = localStorage.getItem('seshman.sourceFilter') || 'both';
let gridMode = localStorage.getItem('seshman.gridMode') === '1';
let searchQuery = '';
let logSeq = 0;
const DEFAULT_FONT = 11;
let termFontSize = DEFAULT_FONT; // restored from disk settings on startup
// Prompt queues are per-session: { sessionId: [prompt, ...] }
// Loaded from disk on startup (see init at bottom), persisted via main process.
let queues = {};
// Saved/bookmarked prompts: [{ id, name, text }] — reusable across sessions.
let bookmarks = [];
// sessionId -> last time we viewed it (ms). Used for "unread" pulse/outline.
let viewed = {};
// Archived sessions (hidden by default). Persisted to disk settings.
let archived = new Set();
let showArchived = false;
// Agent-chat groups: [{ id, name, members:[sessionId], createdAt, active }]
let groups = [];
let currentGroup = null; // group whose side-by-side view is open
let groupHistoryTimer = null;
let groupHistoryCache = [];

function activeSessionId() {
  const e = terms.get(activePtyId);
  return e ? e.sessionId : null;
}
// A session is "waiting for you" when it's running, not busy, and the most
// recent message was Claude's — i.e. it finished its turn and it's your move.
// The session you're currently focused on never counts as waiting.
// The terminal key seshMan is hosting for this session (or null). Matches two
// ways: (1) it was opened by clicking (sessionToPty), or (2) it's a session we
// SPAWNED whose process id equals a hosted terminal's pid — covers "new
// session" and resume-forks where the live id differs from the clicked id.
function hostedKeyFor(session) {
  const sid = typeof session === 'string' ? session : session.sessionId;
  const pid = typeof session === 'string' ? null : session.pid;
  const byId = sessionToPty.get(sid);
  if (byId != null) {
    const e = terms.get(byId);
    if (e && !e.exited && !e.isLog) return byId;
  }
  if (pid) {
    for (const [key, e] of terms) {
      if (!e.isLog && !e.exited && e.osPid === pid) return key;
    }
  }
  return null;
}
function hostedTerminalFor(session) {
  const key = hostedKeyFor(session);
  return key != null ? terms.get(key) : null;
}
function isHosted(s) {
  return !!hostedTerminalFor(s);
}
// Read the live busy/idle/shell status of a hosted terminal by matching the
// spawned process's pid to its sessions/<pid>.json (resume forks a new id, so
// we match on pid rather than the clicked session id).
function hostedStatus(entry) {
  if (!entry || !entry.osPid) return null;
  const live = latestSessions.find((x) => x.pid === entry.osPid && x.running);
  return live ? live.status : null;
}

// A session is "unread" if it has new activity since you last viewed it.
// (Baselined to "read" the first time we see it — see update().)
function isUnread(s) {
  const seen = viewed[s.sessionId];
  if (seen == null) return false;
  return (s.lastActivity || 0) > seen + 1000;
}

// "Waiting / needs you" = a ready session (idle/shell, finished its turn) that
// you haven't viewed since — i.e. UNREAD. Drives the pulse + outline + badges.
// A ready session you've already opened is read → steady, no pulse/outline.
function isWaiting(s) {
  if (s.sessionId === activeSessionId()) return false; // focused = you're on it
  const c = displayState(s).stateClass;
  if (c !== 'idle' && c !== 'shell') return false; // only "ready" states
  return isUnread(s);
}

// Resolve how a row/card should display, accounting for hosted terminals.
function displayState(s) {
  const hosted = hostedTerminalFor(s);
  if (hosted) {
    const st = hostedStatus(hosted);
    if (st === 'busy') return { running: true, stateClass: 'busy', statusText: 'working', active: true };
    if (st === 'idle') return { running: true, stateClass: 'idle', statusText: 'ready', active: true };
    if (st === 'shell') return { running: true, stateClass: 'shell', statusText: 'shell', active: true };
    return { running: true, stateClass: 'busy', statusText: 'live', active: true }; // status not yet known
  }
  if (s.running) return { running: true, stateClass: statusClass(s), statusText: s.status, active: s.active };
  return { running: false, stateClass: 'stopped', statusText: 'stopped', active: false };
}

const THEME = {
  background: '#0a0a0b',
  foreground: '#c4c8cf',
  cursor: '#8fb6ad',
  cursorAccent: '#0a0a0b',
  selectionBackground: '#222428',
  black: '#0a0a0b',
  brightBlack: '#44484f',
};

// ---------- Sidebar rendering ----------
function statusClass(s) {
  if (!s.alive) return 'dead';
  if (s.status === 'busy') return 'busy';
  return s.status || 'idle';
}

// The session's display name: user's /rename title first, then auto-title,
// then last prompt, finally the folder as a last resort.
function displayTitle(s) {
  return s.customTitle || s.aiTitle || s.name || s.lastPrompt || s.project || '(session)';
}

// Age buckets for the sidebar dividers (sessions are sorted newest-first).
const BUCKETS = [
  { maxH: 24, label: 'Last 24 hours' },
  { maxH: 24 * 7, label: 'Older than 24 hours' },
  { maxH: 24 * 30, label: 'Older than a week' },
  { maxH: Infinity, label: 'Older than a month' },
];
function bucketOf(ms) {
  const ageH = (Date.now() - (ms || 0)) / 3600000;
  return BUCKETS.findIndex((b) => ageH < b.maxH);
}

function relTime(ms) {
  if (!ms) return '';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

// Apply source filter + text search. Order (recency) comes from the watcher.
function applyFilters(sessions) {
  const q = searchQuery.trim().toLowerCase();
  return sessions.filter((s) => {
    if (archived.has(s.sessionId) && !showArchived) return false; // hidden by default
    if (sourceFilter !== 'both' && s.source !== sourceFilter) return false;
    if (!q) return true;
    const hay = [
      s.customTitle,
      s.project,
      s.aiTitle,
      s.name,
      s.lastPrompt,
      s.lastMessage && s.lastMessage.text,
      s.cwd,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });
}

// Coarse state for the external API: working | ready | idle | shell | stopped.
function deckState(s) {
  const ds = displayState(s);
  if (!ds.running) return 'stopped';
  const t = ds.statusText;
  if (t === 'ready') return 'ready';
  if (t === 'shell') return 'shell';
  if (t === 'idle') return 'idle';
  return 'working'; // busy / working / live
}
// Compact view served over the local HTTP API (Desk_Deck etc.). Archived hidden.
function buildDeckSnapshot() {
  return {
    items: latestSessions
      .filter((s) => !archived.has(s.sessionId))
      .map((s) => ({
      id: s.sessionId,
      name: displayTitle(s),
      project: s.project,
      state: deckState(s),
      running: displayState(s).running,
      waiting: isWaiting(s),
      source: s.source,
      lastActive: s.lastActivity,
    })),
    current: activeSessionId(),
  };
}

// Master render: refresh whichever views are visible.
function render() {
  const shown = applyFilters(latestSessions);
  renderList(shown);
  if (gridMode) renderGrid(shown);
  refreshEntryLabels(); // keep open tabs' titles current
  paintPaneHeader(); // reflect any title change in the active pane header
  updateQueueTarget();
  window.api.deckPublish(buildDeckSnapshot()); // feed the local API
}

function update(sessions) {
  latestSessions = sessions;
  const activeId = activeSessionId();
  for (const s of sessions) {
    // Baseline newly-seen sessions to "read" (so first sight doesn't pulse).
    if (viewed[s.sessionId] == null) viewed[s.sessionId] = s.lastActivity || 0;
    // The session you're focused on stays read even as it produces output.
    if (s.sessionId === activeId) {
      viewed[s.sessionId] = Math.max(viewed[s.sessionId], s.lastActivity || 0);
    }
    // Adopt sessions we spawned in-app (new/forked) onto their hosting terminal
    // by process id, so clicking them re-focuses instead of opening a log.
    if (s.pid && !sessionToPty.has(s.sessionId)) {
      for (const [key, e] of terms) {
        if (!e.isLog && !e.exited && e.osPid === s.pid) {
          e.sessionId = s.sessionId;
          sessionToPty.set(s.sessionId, key);
          break;
        }
      }
    }
  }
  render();
}

function renderList(shown) {
  const live = shown.filter((s) => displayState(s).running).length;
  const waiting = shown.filter(isWaiting).length;
  sessionCountEl.textContent =
    `${live} running · ${shown.length} total` + (waiting ? ` · ${waiting} waiting` : '');

  sessionListEl.innerHTML = '';
  let lastBucket = -1;
  for (const s of shown) {
    const bucket = bucketOf(s.lastActivity);
    if (bucket !== lastBucket) {
      lastBucket = bucket;
      const divider = document.createElement('div');
      divider.className = 'list-divider';
      divider.textContent = BUCKETS[bucket].label;
      sessionListEl.appendChild(divider);
    }
    const ds = displayState(s);
    const selected = activePtyId != null && s.sessionId === activeSessionId();
    const unread = isWaiting(s); // ready + new-since-you-looked (+ not focused)
    const isArchived = archived.has(s.sessionId);
    const el = document.createElement('div');
    // bg = selection; pulse + green outline only for UNREAD ready sessions.
    el.className =
      'session' + (selected ? ' selected' : '') + (unread ? ' unread' : '') + (isArchived ? ' archived' : '');

    el.innerHTML = `
      <div class="session-top">
        <span class="dot ${ds.stateClass}"></span>
        <span class="session-project"></span>
        <span class="session-status"></span>
      </div>
      <div class="session-title"></div>
      <div class="session-meta">
        <span></span>
        <span></span>
      </div>`;
    // These derive from external files (session/transcript) — assign as text,
    // never interpolate into innerHTML, so a crafted status/version can't inject.
    el.querySelector('.session-status').textContent = ds.statusText;
    const metaSpans = el.querySelectorAll('.session-meta > span');
    metaSpans[0].textContent = relTime(s.lastActivity);
    metaSpans[1].textContent = s.messageCount + ' msgs';
    if (s.version) {
      const v = document.createElement('span');
      v.textContent = 'v' + s.version;
      el.querySelector('.session-meta').appendChild(v);
    }
    el.querySelector('.session-project').textContent = displayTitle(s); // session title (bold)
    el.querySelector('.session-title').textContent = '▸ ' + s.project; // folder (secondary)
    el.title = `${displayTitle(s)}\n${s.cwd}\nsession ${s.sessionId}`;

    // Group-chat link badge(s) for sessions that are members of an active group.
    const meta = el.querySelector('.session-meta');
    for (const g of groupsForSession(s.sessionId)) {
      const badge = document.createElement('span');
      badge.className = 'group-badge';
      badge.textContent = '◇ ' + g.name;
      badge.title = 'group chat: ' + g.name;
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        openGroupView(g);
      });
      meta.appendChild(badge);
    }

    el.addEventListener('click', () => openSession(s));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const items = [];
      if (isHosted(s)) items.push({ label: 'Create group chat…', action: () => openGroupModal(s) });
      for (const g of groupsForSession(s.sessionId)) {
        items.push({ label: 'Open group: ' + g.name, action: () => openGroupView(g) });
        items.push({ label: 'End group: ' + g.name, action: () => endGroup(g) });
      }
      items.push({ label: isArchived ? 'Unarchive' : 'Archive', action: () => toggleArchive(s.sessionId) });
      showContextMenu(e.clientX, e.clientY, items);
    });
    sessionListEl.appendChild(el);
  }
}

// ---------- Archive + lightweight context menu ----------
function saveArchived() {
  window.api.saveSettings({ archived: [...archived] });
}
function toggleArchive(id) {
  if (archived.has(id)) archived.delete(id);
  else archived.add(id);
  saveArchived();
  refreshArchivedToggle();
  render();
}
function closeContextMenu() {
  const m = document.getElementById('context-menu');
  if (m) m.remove();
}
function showContextMenu(x, y, items) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.id = 'context-menu';
  for (const it of items) {
    const mi = document.createElement('div');
    mi.className = 'ctx-item';
    mi.textContent = it.label;
    mi.addEventListener('click', () => {
      closeContextMenu();
      it.action();
    });
    menu.appendChild(mi);
  }
  document.body.appendChild(menu);
  menu.style.left = Math.min(x, window.innerWidth - menu.offsetWidth - 6) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - menu.offsetHeight - 6) + 'px';
}
window.addEventListener('click', closeContextMenu);
window.addEventListener('blur', closeContextMenu);

// ---------- Agent-chat groups ----------
function saveGroups() {
  window.api.saveSettings({ groups });
}
function newGroupId() {
  return 'grp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function sanitizeGroupName(s) {
  return (s || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
}
function activeGroups() {
  return groups.filter((g) => g.active);
}
function groupsForSession(sessionId) {
  return activeGroups().filter((g) => g.members.includes(sessionId));
}
function groupJoinPrompt(name) {
  return (
    `Please use the agent-chat skill to join the group "${name}" and coordinate with the other agent(s) there.\n` +
    `Join:  & "$env:USERPROFILE\\.claude\\skills\\agent-chat\\.venv\\Scripts\\python.exe" "$env:USERPROFILE\\.claude\\skills\\agent-chat\\agentchat.py" join ${name}\n` +
    `Then use the skill to read messages (\`agentchat read ${name} --wait 30\`) and reply (\`agentchat send ${name} "..."\`). Stay in the group until told to conclude.`
  );
}
function groupEndPrompt() {
  return 'Please conclude your chat for now.';
}
function groupLeavePrompt(name) {
  return `You can now leave the agent-chat group: use the skill to run \`agentchat leave ${name}\`.`;
}

// Sessions seshMan currently hosts a live terminal for (unique by sessionId).
function hostedSessionList() {
  const seen = new Set();
  const out = [];
  for (const e of terms.values()) {
    if (e.isLog || e.exited || !e.sessionId || seen.has(e.sessionId)) continue;
    seen.add(e.sessionId);
    out.push(latestSessions.find((x) => x.sessionId === e.sessionId) || { sessionId: e.sessionId, project: e.label, customTitle: e.label });
  }
  return out;
}

function openGroupModal(seed) {
  const hosted = hostedSessionList();
  groupModalEl.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'gm-card';

  const head = document.createElement('div');
  head.className = 'gm-head';
  const title = document.createElement('span');
  title.textContent = 'Create group chat';
  const close = document.createElement('button');
  close.className = 'gm-close';
  close.textContent = '×';
  close.addEventListener('click', () => groupModalEl.classList.add('hidden'));
  head.appendChild(title);
  head.appendChild(close);
  card.appendChild(head);

  const nameInput = document.createElement('input');
  nameInput.className = 'gm-name';
  nameInput.placeholder = 'group name (a–z, 0–9, _)';
  nameInput.value = sanitizeGroupName(seed && seed.project) || 'group';
  card.appendChild(nameInput);

  const listWrap = document.createElement('div');
  listWrap.className = 'gm-list';
  if (hosted.length < 2) {
    listWrap.innerHTML =
      '<div class="gm-empty">Open at least two sessions inside seshMan first — only sessions running here can be grouped.</div>';
  }
  const checks = [];
  for (const s of hosted) {
    const row = document.createElement('label');
    row.className = 'gm-member';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = s.sessionId;
    if (seed && s.sessionId === seed.sessionId) cb.checked = true;
    const txt = document.createElement('span');
    txt.textContent = displayTitle(s) + '  ▸ ' + (s.project || '');
    row.appendChild(cb);
    row.appendChild(txt);
    listWrap.appendChild(row);
    checks.push(cb);
  }
  card.appendChild(listWrap);

  const foot = document.createElement('div');
  foot.className = 'gm-foot';
  const createBtn = document.createElement('button');
  createBtn.className = 'gm-create';
  createBtn.textContent = 'Create & invite';
  createBtn.addEventListener('click', () => {
    const name = sanitizeGroupName(nameInput.value);
    const members = checks.filter((c) => c.checked).map((c) => c.value);
    if (!name) return nameInput.focus();
    if (members.length < 2) {
      listWrap.classList.add('gm-flash');
      setTimeout(() => listWrap.classList.remove('gm-flash'), 600);
      return;
    }
    groupModalEl.classList.add('hidden');
    createGroup(name, members);
  });
  foot.appendChild(createBtn);
  card.appendChild(foot);

  groupModalEl.appendChild(card);
  groupModalEl.classList.remove('hidden');
  nameInput.focus();
  nameInput.select();
}
groupModalEl.addEventListener('click', (e) => {
  if (e.target === groupModalEl) groupModalEl.classList.add('hidden');
});

function createGroup(name, memberSessionIds) {
  const resolved = [];
  for (const sid of memberSessionIds) {
    const key = hostedKeyFor(sid);
    if (key != null) resolved.push({ sessionId: sid, ptyId: key });
  }
  if (resolved.length < 2) return;
  const prompt = groupJoinPrompt(name);
  // Paste into every member, then submit all in one tick (near-simultaneous).
  for (const m of resolved) pastePromptTo(m.ptyId, prompt);
  setTimeout(() => {
    for (const m of resolved) submitTo(m.ptyId);
  }, 80);
  const group = {
    id: newGroupId(),
    name,
    members: resolved.map((m) => m.sessionId),
    createdAt: Date.now(),
    active: true,
  };
  groups.push(group);
  saveGroups();
  render();
  openGroupView(group);
}

// ---------- Group side-by-side view ----------
function refitGroup() {
  for (const [key, e] of terms) {
    if (!e.isLog && !e.exited && e.pane.classList.contains('group-member')) {
      requestAnimationFrame(() => fitActive(key));
    }
  }
}
function setGroupView(group) {
  currentGroup = group || null;
  for (const [, e] of terms) {
    const isMember = !!(group && !e.isLog && !e.exited && group.members.includes(e.sessionId));
    e.pane.classList.toggle('group-member', isMember);
  }
  terminalsEl.classList.toggle('group', !!group);
  document.body.classList.toggle('group-mode', !!group);
  groupHeaderEl.classList.toggle('hidden', !group);
  if (group) {
    groupHeaderNameEl.textContent = '◇ ' + group.name;
    emptyStateEl.style.display = 'none';
    refitGroup();
    startGroupHistory(group);
  } else {
    stopGroupHistory();
    if (activePtyId != null) requestAnimationFrame(() => fitActive(activePtyId));
  }
}
function openGroupView(group) {
  setGroupView(group);
}
function startGroupHistory(group) {
  stopGroupHistory();
  groupHistoryCache = [];
  groupHistoryLogEl.innerHTML = '<div class="log-empty">loading…</div>';
  const poll = () => {
    window.api.fetchGroupHistory(group.name, 200).then((res) => {
      if (currentGroup && currentGroup.id === group.id) renderGroupHistory(res);
    });
  };
  poll();
  groupHistoryTimer = setInterval(poll, 4000);
}
function stopGroupHistory() {
  if (groupHistoryTimer) clearInterval(groupHistoryTimer);
  groupHistoryTimer = null;
}
function renderGroupHistory(res) {
  if (res && res.offline) {
    groupHistoryBannerEl.textContent = 'group history unavailable — logger offline';
    groupHistoryBannerEl.style.display = 'block';
    if (!groupHistoryCache.length) {
      groupHistoryLogEl.innerHTML = '<div class="log-empty">No cached messages.</div>';
      return;
    }
  } else if (res) {
    groupHistoryBannerEl.style.display = 'none';
    groupHistoryCache = res.messages || [];
  }
  groupHistoryLogEl.innerHTML = '';
  if (!groupHistoryCache.length) {
    groupHistoryLogEl.innerHTML = '<div class="log-empty">No group messages yet.</div>';
    return;
  }
  for (const m of groupHistoryCache) {
    const row = document.createElement('div');
    row.className = 'log-msg';
    const role = document.createElement('div');
    role.className = 'log-role';
    role.textContent = m.from || m.type || '·';
    const body = document.createElement('div');
    body.className = 'log-text';
    body.textContent =
      m.type === 'join' ? '(joined)' : m.type === 'leave' ? '(left)' : m.text || '';
    row.appendChild(role);
    row.appendChild(body);
    groupHistoryLogEl.appendChild(row);
  }
  groupHistoryLogEl.scrollTop = groupHistoryLogEl.scrollHeight;
}
function endGroup(group) {
  const keys = [];
  for (const sid of group.members) {
    const key = hostedKeyFor(sid);
    if (key != null) keys.push(key);
  }
  for (const k of keys) pastePromptTo(k, groupEndPrompt());
  setTimeout(() => {
    for (const k of keys) submitTo(k);
  }, 80);
  group.active = false;
  saveGroups();
  if (currentGroup && currentGroup.id === group.id) setGroupView(null);
  render();
}
groupEndBtn.addEventListener('click', () => {
  if (currentGroup) endGroup(currentGroup);
});
groupCloseBtn.addEventListener('click', () => setGroupView(null));

// ---------- Grid overview (full-window cards) ----------
function renderGrid(shown) {
  gridViewEl.innerHTML = '';
  if (!shown.length) {
    const empty = document.createElement('div');
    empty.id = 'grid-empty';
    empty.textContent = searchQuery ? 'No sessions match your search.' : 'No sessions.';
    gridViewEl.appendChild(empty);
    return;
  }
  for (const s of shown) {
    const waitingForYou = isWaiting(s);
    const ds = displayState(s);
    const card = document.createElement('div');
    card.className = 'card ' + ds.stateClass + (waitingForYou ? ' waiting' : '');

    const msg = s.lastMessage;
    card.innerHTML = `
      <div class="card-top">
        <span class="card-project"></span>
        ${waitingForYou ? '<span class="attn-dot"></span>' : ''}
        <span class="card-status"></span>
      </div>
      <div class="card-sub">
        <span class="card-folder"></span>
        <span class="card-time"></span>
        <span class="card-msgs"></span>
      </div>
      <div class="card-msg">${msg ? '<span class="role"></span>' : ''}<span class="card-msg-text"></span></div>`;
    card.querySelector('.card-status').textContent = ds.statusText; // external-derived: text only
    card.querySelector('.card-time').textContent = relTime(s.lastActivity);
    card.querySelector('.card-msgs').textContent = s.messageCount + ' msgs';
    card.querySelector('.card-project').textContent = displayTitle(s);
    card.querySelector('.card-folder').textContent = '▸ ' + s.project;
    if (msg) card.querySelector('.role').textContent = msg.role === 'assistant' ? 'claude' : 'you';
    card.querySelector('.card-msg-text').textContent = msg
      ? msg.text
      : s.lastPrompt || s.aiTitle || '(no messages yet)';
    card.title = `${s.cwd}\nsession ${s.sessionId}`;

    card.addEventListener('click', () => {
      setGridMode(false);
      openSession(s);
    });
    gridViewEl.appendChild(card);
  }
}

function setGridMode(on) {
  gridMode = on;
  localStorage.setItem('seshman.gridMode', on ? '1' : '0');
  gridViewEl.classList.toggle('show', on);
  gridToggleEl.classList.toggle('active', on);
  if (on) renderGrid(applyFilters(latestSessions));
  else if (activePtyId != null) requestAnimationFrame(() => fitActive(activePtyId)); // pane visible again
}

// ---------- Open behavior ----------
// 1. Already open here (terminal or log) -> focus it.
// 2. Otherwise -> open the read-only log first. If the session is NOT live
//    anywhere, the log carries a "resume here" button to start it as a terminal.
//    (We never auto-resume — that avoids forking a session that's live elsewhere.)
async function openSession(session) {
  const hostedKey = hostedKeyFor(session); // matches click-opened AND in-app-spawned terminals
  if (hostedKey != null) {
    focusTab(hostedKey);
    return;
  }
  const live = await window.api.isSessionLive(session.sessionId);
  openLogView(session, live);
}

// ---------- Read-only transcript log (with optional "resume here") ----------
async function openLogView(session, live) {
  const key = 'log-' + logSeq++;

  const pane = document.createElement('div');
  pane.className = 'term-pane log-pane';

  const banner = document.createElement('div');
  banner.className = 'log-banner' + (live ? ' live' : '');
  const bannerText = document.createElement('span');
  bannerText.textContent = live
    ? 'read-only · live in another window'
    : 'stopped · read-only preview';
  banner.appendChild(bannerText);
  if (!live) {
    const resume = document.createElement('button');
    resume.className = 'log-resume';
    resume.textContent = 'resume here ▸';
    resume.addEventListener('click', () => {
      closeTab(key); // drop the log view…
      spawnTerminal({
        sessionId: session.sessionId,
        cwd: session.cwd,
        label: displayTitle(session),
        title: '▸ ' + session.project,
      }); // …and start it live
    });
    banner.appendChild(resume);
  }

  const log = document.createElement('div');
  log.className = 'log-scroll';
  pane.appendChild(banner);
  pane.appendChild(log);
  terminalsEl.appendChild(pane);

  const entry = {
    isLog: true,
    sessionId: session.sessionId,
    pane,
    log,
    label: displayTitle(session),
    title: '▸ ' + session.project,
    exited: false,
  };
  terms.set(key, entry);
  sessionToPty.set(session.sessionId, key);
  focusTab(key);

  const { messages } = await window.api.openTranscript({
    sessionId: session.sessionId,
    cwd: session.cwd,
  });
  renderLog(entry, messages);
}

function renderLog(entry, messages) {
  entry.log.innerHTML = '';
  if (!messages || !messages.length) {
    entry.log.innerHTML = '<div class="log-empty">No readable messages yet.</div>';
    return;
  }
  for (const m of messages) {
    const row = document.createElement('div');
    row.className = 'log-msg ' + m.role;
    const role = document.createElement('div');
    role.className = 'log-role';
    role.textContent = m.role === 'assistant' ? 'claude' : 'you';
    const body = document.createElement('div');
    body.className = 'log-text';
    body.textContent = m.text;
    row.appendChild(role);
    row.appendChild(body);
    entry.log.appendChild(row);
  }
  entry.log.scrollTop = entry.log.scrollHeight;
}

async function spawnTerminal({ sessionId, cwd, label, title }) {
  const pane = document.createElement('div');
  pane.className = 'term-pane';
  terminalsEl.appendChild(pane);

  const term = new Terminal({
    fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
    fontSize: termFontSize,
    lineHeight: 1.15,
    letterSpacing: 0,
    cursorBlink: true,
    cursorStyle: 'bar',
    theme: THEME,
    allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(pane);
  fit.fit();

  // Spawning the pty can fail (claude not on PATH, ConPTY init error). If it
  // does, tear down the half-built pane/terminal and show the error inline
  // instead of leaving an orphaned, uncloseable pane behind.
  let ptyId, osPid;
  try {
    const res = await window.api.startPty({
      sessionId,
      cwd,
      cols: term.cols,
      rows: term.rows,
    });
    ptyId = res.id;
    osPid = res.pid;
  } catch (e) {
    const msg = (e && e.message ? e.message : String(e)).replace(/^Error:\s*/, '');
    term.write('\r\n\x1b[31m  Could not start session:\x1b[0m\r\n  ' + msg + '\r\n');
    term.write('\r\n\x1b[90m  Check that the claude CLI is installed and on your PATH.\x1b[0m\r\n');
    // Keep the message visible briefly, then dispose and remove the pane.
    setTimeout(() => {
      try {
        term.dispose();
      } catch (_) {
        /* already gone */
      }
      pane.remove();
    }, 6000);
    return;
  }

  term.onData((data) => window.api.sendInput(ptyId, data));

  const pasteClipboard = () => {
    const text = window.api.clipboardRead();
    if (text) term.paste(text); // xterm handles bracketed-paste; single insert
  };
  // Clipboard keys. Zoom keys bubble to the window handler. Paste on Ctrl+V or
  // Ctrl+Shift+V. Copy on Ctrl+Shift+C, or Ctrl+C only when text is selected
  // (so a bare Ctrl+C is still the interrupt signal). We preventDefault on the
  // paste/copy keys so xterm's *native* paste doesn't also fire (double-paste).
  term.attachCustomKeyEventHandler((e) => {
    if (isZoomKey(e)) return false;
    if (e.type !== 'keydown' || !(e.ctrlKey || e.metaKey)) return true;
    const k = e.key.toLowerCase();
    if (k === 'v') {
      e.preventDefault();
      pasteClipboard();
      return false;
    }
    if (k === 'c') {
      const sel = term.getSelection();
      if (e.shiftKey || sel) {
        if (sel) window.api.clipboardWrite(sel);
        e.preventDefault();
        return false; // consume — don't also send ^C
      }
      return true; // bare Ctrl+C with no selection -> interrupt
    }
    return true;
  });
  // Right-click: paste (copy the selection first if there is one).
  pane.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const sel = term.getSelection();
    if (sel) window.api.clipboardWrite(sel);
    else pasteClipboard();
    term.focus();
  });

  // Drag a file/image onto the terminal to insert its path (so Claude can read it).
  pane.addEventListener('dragover', (e) => {
    e.preventDefault();
    pane.classList.add('drop-target');
  });
  pane.addEventListener('dragleave', (e) => {
    if (e.target === pane) pane.classList.remove('drop-target');
  });
  pane.addEventListener('drop', (e) => {
    e.preventDefault();
    pane.classList.remove('drop-target');
    const paths = Array.from(e.dataTransfer.files || [])
      .map((f) => f.path) // Electron exposes the absolute path on dropped files
      .filter(Boolean)
      .map((p) => (/\s/.test(p) ? '"' + p + '"' : p)) // quote paths with spaces
      .join(' ');
    if (paths) {
      window.api.sendInput(ptyId, paths + ' '); // insert at cursor, no submit
      term.focus();
    }
  });

  const entry = { term, fit, sessionId, osPid, pane, label: label || 'session', title, exited: false };
  terms.set(ptyId, entry);
  if (sessionId) sessionToPty.set(sessionId, ptyId);

  focusTab(ptyId);
}

// Keep open tabs' titles in sync with the latest session data (so a /rename
// while a session is open updates the header to match the sidebar).
function refreshEntryLabels() {
  const byId = new Map(latestSessions.map((s) => [s.sessionId, s]));
  for (const e of terms.values()) {
    const s = byId.get(e.sessionId);
    if (s) {
      e.label = displayTitle(s);
      e.title = '▸ ' + s.project;
    }
  }
}

// Paint just the header text (cheap; safe to call on every refresh).
function paintPaneHeader() {
  const entry = activePtyId != null ? terms.get(activePtyId) : null;
  if (!entry) {
    paneHeaderEl.classList.add('empty');
    return;
  }
  paneHeaderEl.classList.remove('empty');
  paneTitleEl.textContent = entry.label + (entry.isLog ? '  (log)' : '');
  paneSubEl.textContent = entry.title || '';
}

// Full header update incl. queue (only on focus/close — rebuilds queue items).
function updatePaneHeader() {
  paintPaneHeader();
  updateQueueTarget();
  renderQueue();
}

// Fit + resize a terminal, but ONLY when its pane is actually visible.
// Fitting a hidden/zero-size pane yields NaN/0 dimensions that can crash pty.
function fitActive(key) {
  const entry = terms.get(key);
  if (!entry || entry.isLog) return;
  if (!entry.pane.clientWidth || !entry.pane.clientHeight) return;
  try {
    entry.fit.fit();
  } catch (_) {
    return;
  }
  const { cols, rows } = entry.term;
  if (Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) {
    window.api.resizePty(key, cols, rows);
  }
}

function focusTab(key) {
  const entry = terms.get(key);
  if (!entry) return;
  activePtyId = key;
  if (entry.sessionId) viewed[entry.sessionId] = Date.now(); // opening it = read
  emptyStateEl.style.display = 'none';

  for (const [id, e] of terms) {
    e.pane.classList.toggle('active', id === key);
  }
  updatePaneHeader();

  if (entry.isLog) {
    entry.log.scrollTop = entry.log.scrollHeight;
  } else {
    requestAnimationFrame(() => {
      fitActive(key);
      entry.term.focus();
    });
  }
  render(); // refresh active highlight in sidebar
}

function closeTab(key) {
  const entry = terms.get(key);
  if (!entry) return;
  if (entry.isLog) {
    window.api.closeTranscript(entry.sessionId);
  } else {
    window.api.killPty(key);
    entry.term.dispose();
  }
  entry.pane.remove();
  terms.delete(key);
  if (entry.sessionId) sessionToPty.delete(entry.sessionId);

  if (activePtyId === key) {
    activePtyId = null;
    const next = terms.keys().next();
    if (!next.done) focusTab(next.value);
    else {
      emptyStateEl.style.display = 'flex';
      updatePaneHeader();
    }
  }
  render(); // closing a session un-hosts it
}

// ---------- IPC wiring ----------
window.api.onPtyData(({ id, data }) => {
  const entry = terms.get(id);
  if (entry && !entry.isLog) entry.term.write(data);
});

window.api.onPtyExit(({ id }) => {
  const entry = terms.get(id);
  if (entry && !entry.isLog) {
    entry.exited = true;
    entry.pane.classList.add('exited');
    entry.term.write('\r\n\x1b[90m[process exited — close this tab]\x1b[0m\r\n');
    render(); // reflect that it's no longer live
  }
});

// Live updates for an open read-only log view.
window.api.onTranscriptData(({ sessionId, messages }) => {
  for (const e of terms.values()) {
    if (e.isLog && e.sessionId === sessionId) renderLog(e, messages);
  }
});

window.api.onSessions((sessions) => update(sessions));

// External API asked to switch to a session — same as clicking it.
window.api.onDeckFocus((id) => {
  const s = latestSessions.find((x) => x.sessionId === id);
  if (s) openSession(s);
});

// Source filter dropdown (cli / desktop / both).
sourceFilterEl.value = sourceFilter;
sourceFilterEl.addEventListener('change', () => {
  sourceFilter = sourceFilterEl.value;
  localStorage.setItem('seshman.sourceFilter', sourceFilter);
  render();
});

// Show/hide archived sessions.
function refreshArchivedToggle() {
  archivedToggleEl.classList.toggle('active', showArchived);
  archivedToggleEl.textContent = archived.size ? `archived ${archived.size}` : 'archived';
  archivedToggleEl.style.display = archived.size || showArchived ? '' : 'none';
}
archivedToggleEl.addEventListener('click', () => {
  showArchived = !showArchived;
  refreshArchivedToggle();
  render();
});

// Text search (drives both list and grid).
searchEl.addEventListener('input', () => {
  searchQuery = searchEl.value;
  render();
});

// Grid-mode toggle (full-window card overview).
gridToggleEl.addEventListener('click', () => setGridMode(!gridMode));
setGridMode(gridMode); // restore persisted state

// ---------- Font size (Ctrl +/-/0) ----------
function isZoomKey(e) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
  const k = e.key;
  return k === '=' || k === '+' || k === '-' || k === '_' || k === '0';
}
function setFontSize(px) {
  termFontSize = Math.max(8, Math.min(28, px));
  window.api.saveSettings({ fontSize: termFontSize }); // persisted to disk
  document.documentElement.style.setProperty('--log-font', termFontSize + 'px');
  for (const e of terms.values()) {
    if (!e.isLog) e.term.options.fontSize = termFontSize;
  }
  if (activePtyId != null) fitActive(activePtyId);
}
window.addEventListener('keydown', (e) => {
  if (!isZoomKey(e)) return;
  e.preventDefault();
  if (e.key === '0') setFontSize(DEFAULT_FONT);
  else if (e.key === '-' || e.key === '_') setFontSize(termFontSize - 1);
  else setFontSize(termFontSize + 1);
});
setFontSize(termFontSize); // apply default until disk settings load
// Restore persisted UI settings (font size, bookmarks) from disk.
window.api.loadSettings().then((s) => {
  if (!s) return;
  if (typeof s.fontSize === 'number') setFontSize(s.fontSize);
  if (Array.isArray(s.bookmarks)) bookmarks = s.bookmarks;
  if (Array.isArray(s.archived)) archived = new Set(s.archived);
  if (Array.isArray(s.groups)) groups = s.groups;
  renderBookmarkSelect();
  refreshArchivedToggle();
  render();
});
refreshArchivedToggle();

// ---------- Prompt queue ----------
function activeTermEntry() {
  if (activePtyId == null) return null;
  const e = terms.get(activePtyId);
  return e && !e.isLog && !e.exited ? e : null;
}
function saveQueues() {
  window.api.saveQueues(queues); // persisted to disk by the main process
}
// The queue belongs to the session in the active pane.
function currentSessionId() {
  return activeSessionId();
}
function updateQueueTarget() {
  const e = activeTermEntry();
  if (e) {
    queueTargetEl.innerHTML = 'queue for → <b></b>';
    queueTargetEl.querySelector('b').textContent = e.label;
  } else if (currentSessionId()) {
    queueTargetEl.textContent = 'read-only — draft now, “resume here” to send';
  } else {
    queueTargetEl.textContent = 'open a session to queue prompts';
  }
}
// Type a prompt into a specific pty (bracketed paste) — Enter is sent separately
// by the caller so several sessions can be submitted in one synchronous tick.
function pastePromptTo(ptyId, text) {
  window.api.sendInput(ptyId, '\x1b[200~' + text + '\x1b[201~');
}
function submitTo(ptyId) {
  window.api.sendInput(ptyId, '\r');
}
function sendPromptTo(ptyId, text) {
  pastePromptTo(ptyId, text);
  setTimeout(() => submitTo(ptyId), 40);
}
function sendPrompt(text) {
  const e = activeTermEntry();
  if (!e || !text.trim()) return false;
  sendPromptTo(activePtyId, text);
  return true;
}
function renderQueue() {
  queueListEl.innerHTML = '';
  const sid = currentSessionId();
  if (!sid) {
    queueAddEl.disabled = true;
    queueListEl.innerHTML = '<div class="queue-empty">Open a session to queue prompts for it.</div>';
    return;
  }
  queueAddEl.disabled = false;
  const canSend = !!activeTermEntry(); // only hosted terminals can receive input
  const list = queues[sid] || [];
  if (!list.length) {
    queueListEl.innerHTML =
      '<div class="queue-empty">No queued prompts for this session.<br>Hit “+ add”.</div>';
    return;
  }
  list.forEach((text, i) => {
    const item = document.createElement('div');
    item.className = 'queue-item';

    const ta = document.createElement('textarea');
    ta.className = 'queue-text';
    ta.value = text;
    ta.placeholder = 'Write a prompt…';
    ta.rows = 1;
    const autoGrow = () => {
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
    };
    ta.addEventListener('input', () => {
      queues[sid][i] = ta.value;
      saveQueues();
      autoGrow();
    });
    // Drop a file onto a prompt box -> insert its path at the cursor.
    ta.addEventListener('dragover', (e) => {
      e.preventDefault();
      item.classList.add('drop-target');
    });
    ta.addEventListener('dragleave', () => item.classList.remove('drop-target'));
    ta.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('drop-target');
      const paths = Array.from(e.dataTransfer.files || [])
        .map((f) => f.path)
        .filter(Boolean)
        .map((p) => (/\s/.test(p) ? '"' + p + '"' : p))
        .join(' ');
      if (!paths) return;
      const s = ta.selectionStart ?? ta.value.length;
      const en = ta.selectionEnd ?? ta.value.length;
      ta.value = ta.value.slice(0, s) + paths + ta.value.slice(en);
      ta.selectionStart = ta.selectionEnd = s + paths.length;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const actions = document.createElement('div');
    actions.className = 'queue-actions';

    const star = document.createElement('button');
    star.className = 'q-star';
    star.textContent = '★';
    star.title = 'Save as a reusable prompt';
    star.addEventListener('click', () => {
      if (item.querySelector('.bm-form')) return; // form already open
      const form = document.createElement('div');
      form.className = 'bm-form';
      const nameInput = document.createElement('input');
      nameInput.className = 'bm-name';
      nameInput.placeholder = 'bookmark name';
      nameInput.value = ta.value.trim().slice(0, 24);
      const save = document.createElement('button');
      save.className = 'bm-save';
      save.textContent = 'save ★';
      const cancel = document.createElement('button');
      cancel.textContent = '×';
      const commit = () => {
        if (ta.value.trim()) addBookmark(nameInput.value, ta.value);
        form.remove();
      };
      save.addEventListener('click', commit);
      cancel.addEventListener('click', () => form.remove());
      nameInput.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') commit();
        else if (ev.key === 'Escape') form.remove();
      });
      form.appendChild(nameInput);
      form.appendChild(save);
      form.appendChild(cancel);
      item.appendChild(form);
      nameInput.focus();
      nameInput.select();
    });

    const del = document.createElement('button');
    del.className = 'q-del';
    del.textContent = 'delete';
    del.addEventListener('click', () => {
      queues[sid].splice(i, 1);
      saveQueues();
      renderQueue();
    });
    const send = document.createElement('button');
    send.className = 'q-send';
    send.textContent = 'send ▸';
    send.disabled = !canSend; // read-only/no session: draft only
    send.title = canSend ? 'Send to the active session' : 'Resume the session to send';
    send.addEventListener('click', () => {
      if (sendPrompt(ta.value)) {
        queues[sid].splice(i, 1);
        saveQueues();
        renderQueue();
      }
    });
    actions.appendChild(star);
    actions.appendChild(del);
    actions.appendChild(send);
    item.appendChild(ta);
    item.appendChild(actions);
    queueListEl.appendChild(item);
    autoGrow(); // size to fit existing content now that it's in the DOM
  });
}

queueToggleEl.addEventListener('click', () => {
  const open = !queuePaneEl.classList.toggle('collapsed');
  queueToggleEl.classList.toggle('active', open);
  localStorage.setItem('seshman.queueOpen', open ? '1' : '0');
  if (activePtyId != null) requestAnimationFrame(() => fitActive(activePtyId)); // main width changed
});
queueAddEl.addEventListener('click', () => {
  const sid = currentSessionId();
  if (!sid) return;
  if (!queues[sid]) queues[sid] = [];
  queues[sid].push('');
  saveQueues();
  renderQueue();
  const last = queueListEl.querySelector('.queue-item:last-child .queue-text');
  if (last) last.focus();
});
if (localStorage.getItem('seshman.queueOpen') === '1') {
  queuePaneEl.classList.remove('collapsed');
  queueToggleEl.classList.add('active');
}
// Load persisted queues from disk, then render.
window.api.loadQueues().then((data) => {
  if (data && typeof data === 'object') queues = data;
  renderQueue();
});
updateQueueTarget();
// Flush synchronously on window close so the latest keystrokes aren't lost.
window.addEventListener('beforeunload', () => window.api.saveQueuesSync(queues));

// ---------- Bookmarks (saved/reusable prompts) ----------
function saveBookmarks() {
  window.api.saveSettings({ bookmarks });
}
function newBookmarkId() {
  return 'bm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function renderBookmarkSelect() {
  bookmarkSelectEl.innerHTML = '<option value="">★ insert saved…</option>';
  for (const b of [...bookmarks].sort((a, z) => a.name.localeCompare(z.name))) {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = b.name;
    bookmarkSelectEl.appendChild(opt);
  }
}
function addBookmark(name, text) {
  const clean = (name || '').trim() || text.trim().slice(0, 24) || 'untitled';
  bookmarks.push({ id: newBookmarkId(), name: clean, text });
  saveBookmarks();
  renderBookmarkSelect();
}
function insertBookmark(id) {
  const b = bookmarks.find((x) => x.id === id);
  const sid = currentSessionId();
  if (!b || !sid) return;
  if (!queues[sid]) queues[sid] = [];
  queues[sid].push(b.text);
  saveQueues();
  renderQueue();
}
function renderBookmarkModal() {
  bmListEl.innerHTML = '';
  if (!bookmarks.length) {
    bmListEl.innerHTML =
      '<div class="bm-empty">No saved prompts yet.<br>Star a queued prompt to save it here.</div>';
    return;
  }
  bookmarks.forEach((b, i) => {
    const row = document.createElement('div');
    row.className = 'bm-row';
    const top = document.createElement('div');
    top.className = 'bm-row-top';
    const name = document.createElement('input');
    name.className = 'bm-row-name';
    name.value = b.name;
    name.addEventListener('input', () => {
      bookmarks[i].name = name.value;
      saveBookmarks();
      renderBookmarkSelect();
    });
    const del = document.createElement('button');
    del.className = 'bm-row-del';
    del.textContent = 'delete';
    del.addEventListener('click', () => {
      bookmarks.splice(i, 1);
      saveBookmarks();
      renderBookmarkSelect();
      renderBookmarkModal();
    });
    top.appendChild(name);
    top.appendChild(del);
    const text = document.createElement('textarea');
    text.className = 'bm-row-text';
    text.value = b.text;
    text.addEventListener('input', () => {
      bookmarks[i].text = text.value;
      saveBookmarks();
    });
    row.appendChild(top);
    row.appendChild(text);
    bmListEl.appendChild(row);
  });
}
bookmarkSelectEl.addEventListener('change', () => {
  if (bookmarkSelectEl.value) {
    insertBookmark(bookmarkSelectEl.value);
    bookmarkSelectEl.value = '';
  }
});
bookmarkManageEl.addEventListener('click', () => {
  renderBookmarkModal();
  bookmarkModalEl.classList.remove('hidden');
});
bmCloseEl.addEventListener('click', () => bookmarkModalEl.classList.add('hidden'));
bookmarkModalEl.addEventListener('click', (e) => {
  if (e.target === bookmarkModalEl) bookmarkModalEl.classList.add('hidden');
});

// Close the active session via the pane header.
paneCloseEl.addEventListener('click', () => {
  if (activePtyId != null) closeTab(activePtyId);
});

// New-session button: pick a folder, then start claude fresh there.
document.getElementById('new-session').addEventListener('click', async () => {
  const dir = await window.api.pickFolder();
  if (!dir) return; // cancelled
  const label = dir.split(/[\\/]/).filter(Boolean).pop() || 'new';
  spawnTerminal({ sessionId: null, cwd: dir, label });
});

// Keep the active terminal fitted to the window.
window.addEventListener('resize', () => {
  if (currentGroup) refitGroup();
  else if (activePtyId != null) fitActive(activePtyId);
});

// Prevent a missed file-drop from navigating the window to the file.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// Clear any stuck drag-hover outline if a drag ends anywhere, or as soon as a
// normal (non-drag) pointer move happens — a mousemove means no drag is active.
function clearDropTargets() {
  document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
}
window.addEventListener('dragend', clearDropTargets);
window.addEventListener('drop', clearDropTargets);
window.addEventListener('mousemove', () => {
  if (document.querySelector('.drop-target')) clearDropTargets();
});

// Clipboard for normal text fields (queue, search). The terminal handles its
// own clipboard; this covers everything else now that there's no native menu.
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const el = document.activeElement;
  if (!el || (el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT')) return;
  if (el.classList.contains('xterm-helper-textarea')) return; // terminal handles its own
  const k = e.key.toLowerCase();
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  if (k === 'v') {
    e.preventDefault();
    const text = window.api.clipboardRead();
    if (text == null) return;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    el.selectionStart = el.selectionEnd = start + text.length;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else if ((k === 'c' || k === 'x') && start !== end) {
    e.preventDefault();
    window.api.clipboardWrite(el.value.slice(start, end));
    if (k === 'x') {
      el.value = el.value.slice(0, start) + el.value.slice(end);
      el.selectionStart = el.selectionEnd = start;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
});

// Surface any renderer error to the main-process log (seshman.log).
window.addEventListener('error', (e) =>
  console.error('window.error: ' + e.message + ' ' + ((e.error && e.error.stack) || ''))
);
window.addEventListener('unhandledrejection', (e) =>
  console.error('unhandledrejection: ' + ((e.reason && (e.reason.stack || e.reason)) || ''))
);

// Initial load.
window.api.getSessions().then(update);
