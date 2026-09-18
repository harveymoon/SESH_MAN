# seshMan — project conventions

## Lifecycle rules (hard)
- **Never launch, close, restart, or kill seshMan or any running Claude
  session.** The user owns app lifecycle. If a restart or relaunch is needed,
  ask the user to do it.
- **Never run `npm run pack` while seshMan.exe is running** — the packager
  overwrites `release\`, the folder the live exe runs from. Confirm nothing is
  running first (only build when the user says the app is closed).
- Sessions in `~/.claude` belong to the user; read freely, never delete
  transcripts. Stale `sessions/<pid>.json` files may be retired (rename to
  a `.bak`) only after verifying the pid is not a claude.exe.

## Architecture
- Plain JS, no bundler. `src/main/` (Electron main: watchers, pty, local API,
  bulletin store, insight watcher), `src/renderer/` (one renderer.js,
  index.html, styles.css), preload with contextIsolation+sandbox.
- **Transcript parsing is incremental** — `sessionWatcher.js` and
  `insightWatcher.js` read only appended bytes (offset up to the last
  newline; partial tails deferred). Never regress to full re-reads on change.
- Activity semantics: `lastMessageActivity` (real user/assistant messages
  only) drives sorting/unread/notifications. Records flagged
  `isCompactSummary`/`isMeta`, and `system` records (away_summary recaps),
  must never count as messages.
- The renderer renders external strings via `textContent` only — session
  titles, transcripts, board notes, statuses are never interpolated into
  innerHTML.
- Colors/theming ride CSS tokens on `:root` with a `body.light` remap; new UI
  must use the tokens (`--accent`, `--danger`, etc.), both themes for free.
- Overlay z-index stack: grid 10 < board 20 < usage 25 < modals 50-70 <
  menus 120-150.
- The local HTTP API (`apiServer.js`) is loopback-only, Bearer-token, no CORS;
  fields are only ever added, never renamed (see DESK_DECK_INTEGRATION.md).

## Workflow
- Commit after each feature with a descriptive body; push to
  github.com/harveymoon/SESH_MAN when the user asks (they usually want it).
- `node --check` every edited JS file; test main-process modules directly with
  `node -e` against real `~/.claude` data where possible (read-only).
- The bulletin-board skill lives at `~/.claude/skills/bulletin-board/`
  (outside this repo); its slugify/id/schema contracts are mirrored in
  `src/main/bulletinStore.js` and must stay byte-identical.
