# Code Audit — session_manager

Automated review 2026-06-10. Items for the dev to address when time permits.

> **Status: all 8 resolved 2026-06-12.** Fixes below.
> *(Historical note, 2026-09: `agentChatHistory.js` referenced in item 6 was later
> deleted along with the whole group-chat feature — the bulletin board replaced it.)*
> 1. `apiServer.js` — dropped wildcard CORS, removed `?t=` query-token, Bearer-only with `crypto.timingSafeEqual`. Desk_Deck client already used the Bearer header (no client code change needed); `DESK_DECK_INTEGRATION.md` updated.
> 2. `main.js`/`sessionWatcher.js` — `'update'` listener registered once at module scope; `start()` now calls `stop()` first (re-entry guard).
> 3. `ptyManager.start` wraps `pty.spawn`; `spawnTerminal` try/catches the invoke, shows the error inline, then disposes the terminal + removes the pane.
> 4. `renderer.js` — `statusText`/`version` (list + grid) now set via `textContent`, not interpolated into `innerHTML`.
> 5. `transcript:open` validates `sessionId` against `/^[A-Za-z0-9-]+$/` before path use.
> 6. `agentChatHistory.js` — added `res.on('error')`/`'aborted'` + single-resolve guard so a mid-body socket death can't hang the promise.
> 7. `main.js` — transcript watchers freed (with pending debounce cleared) on `transcript:close`, `'error'`/file-gone, window `closed`, `window-all-closed`, and `before-quit`.
> 8. `seshman.bat` — removed `ELECTRON_DISABLE_SANDBOX=1`.

## 1. Local HTTP API sends `Access-Control-Allow-Origin: *` and accepts the token in the query string — Medium

**File:** `src/main/apiServer.js` lines 32–34 and 54–55

The control API on `127.0.0.1:7374` responds to every request with `Access-Control-Allow-Origin: *`, so any web page open in the user's browser can issue cross-origin requests to it and read responses. The unauthenticated `/api/status` endpoint (line 47) is therefore probeable by arbitrary websites (app presence + version fingerprinting), and if the token ever leaks the wildcard CORS lets a hostile page drive `/api/sessions` and `focus` directly. Accepting the token as `?t=<token>` (line 54) makes leakage more likely: query strings end up in browser history, shell history, and any proxy/server logs.

**Fix:** Drop the CORS headers entirely (Desk_Deck and other native controllers don't need CORS), or echo a specific allowed origin. Require the token only via the `Authorization: Bearer` header, and consider `crypto.timingSafeEqual` for the comparison.

## 2. `createWindow()` re-registers the watcher listener and restarts the watcher on every call — Medium

**File:** `src/main/main.js` lines 101–106 (with `app.on('activate', …)` at 265–267) and `src/main/sessionWatcher.js` lines 238–244

`watcher.on('update', …)` and `watcher.start()` live inside `createWindow()`. On macOS, closing the window fires `window-all-closed` (which calls `watcher.stop()`), and re-activating the app calls `createWindow()` again: a second `'update'` listener is added every time (the old ones are never removed), so each session update is sent to the renderer N times after N reopens. `SessionWatcher.start()` also has no re-entry guard — if it is ever called twice without an intervening `stop()`, the previous `setInterval` handles are overwritten and leak, polling forever.

**Fix:** Register the `'update'` listener once at module scope (it already checks `mainWindow && !mainWindow.isDestroyed()`), call `watcher.start()` once from `app.whenReady()`, and make `start()` call `this.stop()` first as a guard.

## 3. PTY spawn failure is completely unhandled — orphaned pane and silent failure — Medium

**File:** `src/renderer/renderer.js` lines 771–796 (`spawnTerminal`), `src/main/main.js` line 143, `src/main/ptyManager.js` line 37

If `pty.spawn` throws in the main process (e.g. `claude.exe` not on PATH, ConPTY init failure), the `pty:start` invoke rejects. `spawnTerminal` has no try/catch and none of its callers (`resume here` at line 711, the new-session button at line 1350, `openLogView`'s resume path) handle the rejection. The pane `div` and the xterm `Terminal` were already created and appended before the `await` (lines 772–789), so the user is left with an orphaned, unfocusable pane that is not in the `terms` map (it cannot be closed via the UI), a leaked Terminal instance, and no error message — the failure only shows up in `seshman.log` via the global `unhandledrejection` hook.

**Fix:** Wrap the `await window.api.startPty(...)` in try/catch; on failure dispose the terminal, remove the pane, and show a visible error (e.g. write the message into the pane or a toast). In `ptyManager.start`, wrap `pty.spawn` and return/throw a structured error.

## 4. Unescaped values interpolated into `innerHTML` in list and grid rendering — Low

**File:** `src/renderer/renderer.js` lines 299–310 (`${ds.statusText}`, `${'v' + s.version}`) and 641–652 (`${ds.statusText}` in grid cards)

The renderer is otherwise careful to use `textContent` for titles, projects, and message text, but `ds.statusText` and `s.version` are template-interpolated into `innerHTML`. `statusText` derives from the `status` field of `~/.claude/sessions/<pid>.json` and `version` from arbitrary lines of the transcript `.jsonl` — both external files this app merely reads. A crafted value (e.g. an `<img onerror=…>` payload in a `version` field) would execute in the renderer, which has IPC access to spawn PTYs and send keystrokes to them. CSP blocks remote script but not inline event-handler-free injection vectors entirely, and defense-in-depth says don't trust these files.

**Fix:** Set these via `textContent` like the neighboring fields (add `<span class="session-status"></span>` empty in the template and assign `el.querySelector('.session-status').textContent = ds.statusText`), same for the version badge and grid card status.

## 5. `transcript:open` joins an unvalidated `sessionId` into a filesystem path — Low

**File:** `src/main/main.js` line 163; `src/main/sessionWatcher.js` lines 36–49 (`findTranscript`)

`sessionId` and `cwd` arrive from the renderer over IPC and are joined directly: `path.join(PROJECTS_DIR, encodeCwd(cwd), sessionId + '.jsonl')` and `path.join(PROJECTS_DIR, dir, sessionId + '.jsonl')`. A `sessionId` like `..\..\..\foo` escapes `~/.claude/projects` and lets a compromised renderer read (and `fs.watch`) any `*.jsonl` on disk. The renderer is local code behind contextIsolation, so this is hardening rather than an active hole, but IPC inputs should be validated in the main process.

**Fix:** Validate `sessionId` against the expected UUID shape (e.g. `/^[A-Za-z0-9-]+$/`) before using it in any path, and reject otherwise.

## 6. `fetchHistory` promise can hang forever on a mid-body connection error — Low

**File:** `src/main/agentChatHistory.js` lines 23–41

Errors are handled on `req` (`req.on('error')`) and via the timeout, but there is no `res.on('error')` handler. If the socket dies after headers arrive but before `end` (common with a flaky LAN host, which the comments say this is), Node emits `'error'`/`'aborted'` on the response, neither `res.on('end')` nor `req.on('error')` necessarily fires, and the promise returned to the renderer never resolves. The group-history poll re-fires every 4 s so the UI mostly recovers, but each hang leaks a pending IPC invoke and the "loading…" state can stick.

**Fix:** Add `res.on('error', () => resolve({ ok: false, offline: true, messages: [] }))` (and/or `res.on('aborted', …)`).

## 7. Transcript `fs.watch` handles are only freed by explicit `transcript:close` — Low

**File:** `src/main/main.js` lines 12, 166–185, 238–248

Watchers in `transcriptWatchers` are closed only when the renderer sends `transcript:close` for that exact session. If the window is closed/reloaded while log views are open, or the watched file is deleted, the `FSWatcher` handles (plus their pending debounce timers) persist for the life of the process and keep firing `webContents.send` attempts. Each watcher also holds the file/directory handle open on Windows.

**Fix:** Iterate and close all entries in `transcriptWatchers` in the window's `closed` handler (and on `before-quit`); also `clearTimeout(debounce)` when closing, and self-remove the watcher on `'error'`/file-gone.

## 8. Launcher disables the Chromium sandbox — Low

**File:** `seshman.bat` line 5

`set ELECTRON_DISABLE_SANDBOX=1` turns off the Chromium sandbox for all renderer/GPU processes. The app only loads local content with contextIsolation on, so the practical risk is low today, but it removes the last line of defense if any rendered content is ever attacker-influenced (see item 4) and does not appear necessary on Windows (sandbox issues the comment alludes to are typically Linux SUID problems).

**Fix:** Remove the env var; if it was added to work around a specific crash, document the reason next to it and scope it to that case.
