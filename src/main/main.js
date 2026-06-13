'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, Menu, dialog, clipboard } = require('electron');
const { SessionWatcher, findTranscript, readTranscriptMessages } = require('./sessionWatcher');
const { PtyManager } = require('./ptyManager');
const apiServer = require('./apiServer');
const agentChatHistory = require('./agentChatHistory');

// Live read-only transcript views: sessionId -> { watcher, debounce }.
const transcriptWatchers = new Map();

// Session ids are UUID-ish; reject anything else before it touches a filesystem
// path so a compromised renderer can't traverse out of ~/.claude/projects.
function isValidSessionId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9-]+$/.test(id) && id.length <= 128;
}

// Close + forget one transcript watcher (also clears its pending debounce).
function closeTranscriptWatcher(sessionId) {
  const rec = transcriptWatchers.get(sessionId);
  if (!rec) return;
  clearTimeout(rec.debounce);
  try {
    rec.watcher.close();
  } catch (_) {
    /* already closed */
  }
  transcriptWatchers.delete(sessionId);
}

function closeAllTranscriptWatchers() {
  for (const id of [...transcriptWatchers.keys()]) closeTranscriptWatcher(id);
}

// Latest deck snapshot pushed from the renderer; served over the local API.
let deckSnapshot = { items: [], current: null };
let api = null;

// ---- Crash / error logging ----
// Write to userData (always writable) — NOT next to main.js, which is inside the
// read-only app.asar in the packaged build (so crash logs were being discarded).
function logFile() {
  try {
    return path.join(app.getPath('userData'), 'seshman.log');
  } catch (_) {
    return path.join(__dirname, 'seshman.log');
  }
}
function logLine(s) {
  try {
    fs.appendFileSync(logFile(), new Date().toISOString() + '  ' + s + '\n');
  } catch (_) {
    /* ignore */
  }
}
process.on('uncaughtException', (e) => logLine('MAIN uncaughtException: ' + ((e && e.stack) || e)));
process.on('unhandledRejection', (e) => logLine('MAIN unhandledRejection: ' + ((e && e.stack) || e)));
logLine('--- app start ---');

// This machine shows GPU driver instability (WER LiveKernelEvent 141/193 video
// TDRs + bugchecks), which kills Electron's GPU process and takes the window
// down. Render in software so a flaky graphics driver can't crash us.
app.disableHardwareAcceleration();
// Windows taskbar grouping / stable identity (esp. important when run unpackaged).
if (process.platform === 'win32') app.setAppUserModelId('com.harveymoon.seshman');
app.on('child-process-gone', (_e, details) => logLine('CHILD gone: ' + JSON.stringify(details)));
app.on('gpu-process-crashed', (_e, killed) => logLine('GPU crashed killed=' + killed));

let mainWindow = null;
const watcher = new SessionWatcher({ pollMs: 1500 });
const ptys = new PtyManager();

// Register the session-update listener ONCE at module scope. (If this lived in
// createWindow(), re-activating the app on macOS would stack a new listener
// every time and each update would be sent to the renderer N times.)
watcher.on('update', (sessions) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sessions:update', sessions);
  }
});

function createWindow() {
  // No native menu — clipboard is handled explicitly in the renderer so menu
  // accelerators (Ctrl+A/C/Z…) never hijack the terminal's control keys.
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    backgroundColor: '#0a0a0b',
    title: 'seshMan',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    autoHideMenuBar: true, // no visible menu bar; shortcuts still work
    // Frameless: no OS title bar / border. Keep native min/max/close as an
    // overlay drawn into our custom top bar.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0e0f11', symbolColor: '#c4c8cf', height: 38 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Capture renderer crashes and console errors.
  mainWindow.webContents.on('render-process-gone', (_e, details) =>
    logLine('RENDERER gone: ' + JSON.stringify(details))
  );
  mainWindow.webContents.on('unresponsive', () => logLine('RENDERER unresponsive'));
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) logLine('RENDERER console: ' + message + '  @' + sourceId + ':' + line);
  });
  // Hard guard: a stray file drop / link must never navigate away from the app.
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Local HTTP API for external controllers (Desk_Deck etc.), 127.0.0.1 only.
  if (!api) {
    api = apiServer.start({
      port: 7374,
      tokenFile: path.join(app.getPath('userData'), 'api_token.txt'),
      version: app.getVersion(),
      getSnapshot: () => deckSnapshot,
      onFocus: (id) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.send('deck:focus', id);
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      },
      log: logLine,
    });
  }

  // Start (or restart, on macOS re-activate) the session watcher. start() is
  // self-guarding (stops any prior timers first), so this is idempotent.
  watcher.start();

  mainWindow.on('closed', () => {
    // Free any live transcript watchers tied to this window (see below).
    closeAllTranscriptWatchers();
    mainWindow = null;
  });
}

// ---- IPC: sessions ----
ipcMain.handle('sessions:get', () => watcher.list());
ipcMain.handle('session:live', (_evt, sessionId) => watcher.isLive(sessionId));
// Agent-chat group history (remote LAN logger; offline-safe).
ipcMain.handle('groupHistory:fetch', (_evt, { group, limit }) =>
  agentChatHistory.fetchHistory(group, limit)
);
// Renderer pushes the computed deck view; the local API serves it verbatim.
ipcMain.on('deck:publish', (_evt, snapshot) => {
  if (snapshot && Array.isArray(snapshot.items)) deckSnapshot = snapshot;
});
// Clipboard — done in main because the sandboxed renderer/preload can't access
// the clipboard module. Sync read so callers can insert at the cursor inline.
ipcMain.on('clipboard:read', (e) => {
  e.returnValue = clipboard.readText();
});
ipcMain.on('clipboard:write', (_e, text) => {
  clipboard.writeText(typeof text === 'string' ? text : '');
});

// Folder picker for "new session here".
ipcMain.handle('dialog:pickFolder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a folder for the new session',
    properties: ['openDirectory'],
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

// ---- IPC: pty lifecycle ----
ipcMain.handle('pty:start', (_evt, opts) => {
  return ptys.start(opts, {
    onData: (id, data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pty:data', { id, data });
      }
    },
    onExit: (id, exitCode) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pty:exit', { id, exitCode });
      }
    },
  });
});

ipcMain.on('pty:input', (_evt, { id, data }) => ptys.write(id, data));
ipcMain.on('pty:resize', (_evt, { id, cols, rows }) => ptys.resize(id, cols, rows));
ipcMain.on('pty:kill', (_evt, id) => ptys.kill(id));

// ---- IPC: read-only transcript log ----
ipcMain.handle('transcript:open', (_evt, { sessionId, cwd }) => {
  if (!isValidSessionId(sessionId)) return { messages: [] };
  const file = findTranscript(sessionId, cwd);
  if (!file) return { messages: [] };
  if (!transcriptWatchers.has(sessionId)) {
    const push = () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('transcript:data', {
          sessionId,
          messages: readTranscriptMessages(file),
        });
      }
    };
    try {
      const w = fs.watch(file, () => {
        const rec = transcriptWatchers.get(sessionId);
        if (!rec) return;
        clearTimeout(rec.debounce);
        rec.debounce = setTimeout(push, 250);
      });
      // Self-remove if the file is deleted or the handle errors, so dead
      // watchers don't linger and keep firing for the life of the process.
      w.on('error', () => closeTranscriptWatcher(sessionId));
      transcriptWatchers.set(sessionId, { watcher: w, debounce: null });
    } catch (_) {
      /* file vanished */
    }
  }
  return { messages: readTranscriptMessages(file) };
});

// ---- IPC: per-session prompt queues (persisted to disk) ----
function queueFile() {
  return path.join(app.getPath('userData'), 'queues.json');
}
ipcMain.handle('queue:load', () => {
  try {
    return JSON.parse(fs.readFileSync(queueFile(), 'utf8'));
  } catch (_) {
    return {};
  }
});
function writeQueues(data) {
  try {
    fs.writeFileSync(queueFile(), JSON.stringify(data));
  } catch (e) {
    logLine('queue save failed: ' + e);
  }
}
ipcMain.on('queue:save', (_evt, data) => writeQueues(data));
ipcMain.on('queue:save-sync', (evt, data) => {
  writeQueues(data);
  evt.returnValue = true; // lets the renderer flush synchronously on close
});

// ---- IPC: persisted UI settings (font size, etc.) ----
function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}
ipcMain.handle('settings:load', () => {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch (_) {
    return {};
  }
});
ipcMain.on('settings:save', (_evt, partial) => {
  let cur = {};
  try {
    cur = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch (_) {
    /* no file yet */
  }
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(Object.assign(cur, partial)));
  } catch (e) {
    logLine('settings save failed: ' + e);
  }
});

ipcMain.on('transcript:close', (_evt, sessionId) => closeTranscriptWatcher(sessionId));

// Single instance: a second launch quits immediately and just focuses the
// existing window (also avoids fighting over the API port 7374).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(createWindow);
}

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  ptys.killAll();
  watcher.stop();
  closeAllTranscriptWatchers();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  ptys.killAll();
  watcher.stop();
  closeAllTranscriptWatchers();
  if (api) {
    try {
      api.close();
    } catch (_) {
      /* not listening */
    }
  }
});
