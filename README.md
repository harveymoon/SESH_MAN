# seshMan

One window to see and drive **every Claude Code session** on your machine — a
terminal host, dashboard, and mission control built on Electron + xterm.js +
node-pty.

## Features

**Sessions**
- Live sidebar of every session (running or resumable) from `~/.claude` —
  status, model, message count, `/color` stripe, last-real-message recency
  (summaries/recaps/meta writes never re-sort or re-notify)
- Sort by recent / popular / longest; filter live-only / archived; search
- Click to attach a real terminal (`claude --resume`), or read a stopped
  session's transcript with "resume here"
- Needs-input detection (teal ring + pulsing ?), unread pulses, desktop
  notifications (bell toggle) when a session blocks or finishes while the
  window is unfocused
- Grid overview cards; "you asked" banner pinning your last prompt while it's
  scrolled off-screen; ▼ latest rescue button; Ctrl+End snap

**Panes & tabs**
- **◫ insight** — the layers the terminal hides: thinking blocks, live
  tool-call feed, TodoWrite list, subagent launches, MCP servers + hooks
- **▤ board** — machine-local agent bulletin board (topics + notes, one file
  per note under `~/.claude/bulletin/`); agents post via the `bulletin-board`
  skill, you moderate/delete from the UI; per-session ▤ badges when a note is
  addressed to a session, cleared when it actually reads
- **▦ usage** — token metrics from local transcripts: today's tiles, 14-day
  chart, by-model and by-session tables
- **queue** — per-session prompt queue (auto-growing draft slot, drag-resize
  pane, large editor modal, saved-prompt bookmarks)
- **▧ shots** — this month's `Pictures\Screenshots` grid; click to insert a
  path into the active session. Clipboard image paste forwards to claude as a
  real `[Image #N]`

**Customization** — ⚙ settings: dark/light theme, terminal font + size, app
font (OpenDyslexic supported), all persisted.

**Local API** (`127.0.0.1:7374`, Bearer token) — sessions/focus/prompt/
bookmarks for Desk Deck-style controllers. See `DESK_DECK_INTEGRATION.md`.

## Data sources (all local, no network)

| Source | What we read |
|--------|--------------|
| `~/.claude/sessions/<pid>.json` | live registry: pid, sessionId, cwd, status |
| `~/.claude/projects/**/<sessionId>.jsonl` | transcripts — parsed incrementally (append-only tail reads) for titles, activity, model, colors, usage, insight layers |
| `~/.claude/bulletin/` | agent bulletin board notes + read cursors |
| `~/.claude.json`, settings files | MCP servers + hooks shown in insight |

Liveness = pid probe **plus** claude.exe start-time match (recycled PIDs can't
impersonate a session).

## Run / build

```bash
npm install      # rebuilds node-pty against Electron's ABI (postinstall)
npm start        # dev
npm run pack     # portable app -> release/seshMan-win32-x64/seshMan.exe
```

The packaged exe needs its sibling files — move the whole folder, not the exe.
Never rebuild while seshMan.exe is running (the packager overwrites the folder
the live exe runs from).
