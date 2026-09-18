'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Sessions
  getSessions: () => ipcRenderer.invoke('sessions:get'),
  isSessionLive: (sessionId) => ipcRenderer.invoke('session:live', sessionId),
  onSessions: (cb) => {
    const handler = (_evt, sessions) => cb(sessions);
    ipcRenderer.on('sessions:update', handler);
    return () => ipcRenderer.removeListener('sessions:update', handler);
  },

  // PTY
  startPty: (opts) => ipcRenderer.invoke('pty:start', opts),
  sendInput: (id, data) => ipcRenderer.send('pty:input', { id, data }),
  resizePty: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  killPty: (id) => ipcRenderer.send('pty:kill', id),
  onPtyData: (cb) => ipcRenderer.on('pty:data', (_evt, payload) => cb(payload)),
  onPtyExit: (cb) => ipcRenderer.on('pty:exit', (_evt, payload) => cb(payload)),

  // Read-only transcript log
  openTranscript: (opts) => ipcRenderer.invoke('transcript:open', opts),
  closeTranscript: (sessionId) => ipcRenderer.send('transcript:close', sessionId),
  onTranscriptData: (cb) => ipcRenderer.on('transcript:data', (_evt, payload) => cb(payload)),

  // Per-session prompt queues (disk-persisted)
  loadQueues: () => ipcRenderer.invoke('queue:load'),
  saveQueues: (data) => ipcRenderer.send('queue:save', data),
  saveQueuesSync: (data) => ipcRenderer.sendSync('queue:save-sync', data),

  // Persisted UI settings
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (partial) => ipcRenderer.send('settings:save', partial),

  // Clipboard — bridged through main (clipboard module is unavailable in the
  // sandboxed renderer). sendSync keeps reads synchronous for inline insert.
  clipboardRead: () => ipcRenderer.sendSync('clipboard:read'),
  clipboardWrite: (text) => ipcRenderer.send('clipboard:write', text),

  // Deck API bridge: publish the computed view, receive focus commands
  deckPublish: (snapshot) => ipcRenderer.send('deck:publish', snapshot),
  onDeckFocus: (cb) => ipcRenderer.on('deck:focus', (_evt, id) => cb(id)),
  // Publish saved prompts for GET /api/bookmarks.
  publishBookmarks: (items) => ipcRenderer.send('deck:bookmarks', items),
  // Deck-driven prompt injection: main forwards a request, renderer replies.
  onDeckPrompt: (cb) => ipcRenderer.on('deck:prompt', (_evt, payload) => cb(payload)),
  deckPromptResult: (reqId, status, body) =>
    ipcRenderer.send('deck:prompt-result', { reqId, status, body }),

  // Folder picker for a new session
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),

  // Agent bulletin board (local files)
  boardList: () => ipcRenderer.invoke('bulletin:list'),
  boardPost: (note) => ipcRenderer.invoke('bulletin:post', note),
  boardDelete: (id) => ipcRenderer.invoke('bulletin:delete', id),
  boardDeleteTopic: (slug) => ipcRenderer.invoke('bulletin:delete-topic', slug),
  onBoardChanged: (cb) => ipcRenderer.on('bulletin:changed', () => cb()),
});
