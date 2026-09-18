# seshMan — Feature Review Walkthrough

Everything added since the June build (~30 commits). Go top to bottom in the
freshly built app; check items off as they pass. Anything broken → note it and
we'll fix in a follow-up pass.

## 0. First launch
- [ ] App opens, sidebar populates, terminals attach (core regression check)
- [ ] Font size is whatever you last set (Ctrl+/−) and **survives a restart**
      (this was silently broken before — the saved size was overwritten at launch)
- [ ] Sidebar rows show a small model tag (`fable 5`, `opus 4.8`…) instead of
      the old `v2.x` CLI version (raw id + CLI version on hover)
- [ ] Pane header shows the model chip next to the session name / folder
- [ ] Pane header's close control reads **END SESSION** (live terminal),
      **CLOSE** (ended), or **CLOSE VIEW** (read-only log)

## 1. Sidebar & sorting
- [ ] Sort select: `recent` / `popular` / `longest` — popular & longest stay
      stable while sessions tick (no more row-jumping)
- [ ] `LIVE` / `ARCH N` filter buttons (the eye dropdown is gone); archived
      count shows in the button label
- [ ] Recency = last **real message**: dormant sessions with auto-recaps
      ("Recap: … disable recaps in /config") no longer jump to the top or pulse
      unread when a recap/summary lands
- [ ] `/color` a session → colored left stripe on its row + grid card, and its
      terminal background gets a faint matching tint (updates live)
- [ ] Running count readout now sits in the titlebar next to search
- [ ] Search box has a working ×-clear

## 2. Terminal QoL
- [ ] Scroll up in a busy session → **▼ latest** button appears bottom-right;
      click snaps to the prompt (Ctrl+End does the same)
- [ ] Long chat + scrolled away → **"YOU ASKED ▸ …"** banner pins your last
      typed prompt at the top; click expands the full text; it hides itself
      whenever the message is actually visible on screen
- [ ] Typing a message containing "do you want to…" does NOT strobe the
      sidebar ring anymore (was matching your own input echo)
- [ ] Ctrl+V with an image on the clipboard → real `[Image #1]` attach (claude
      reads the clipboard itself); text paste unchanged
- [ ] Session blocking on a question → teal ring + pulsing `?`; finished-turn
      sessions pulse green (unchanged behaviors, re-verify)

## 3. ◫ Insight pane (new)
- [ ] Toggle opens the right column; follows whatever session you focus
- [ ] **thinking**: recent reasoning blocks stream in (italic; subagent
      thinking amber-edged); sessions without visible thinking say so
- [ ] **tools**: live feed — green/red/amber dots, tool name + detail; hover
      shows full detail / error text; counts climb as the agent works
- [ ] **todos**: appears when the session uses TodoWrite (✓/▸/○ states)
- [ ] **subagents**: launches listed with type + mission
- [ ] **mcp · hooks**: chips (should show `browsermcp`; scope on hover)
- [ ] Works on a stopped session's log view too (archaeology mode)

## 4. ▤ Bulletin board (new)
- [ ] Board tab opens; `board-selftest` topic shows the seeded notes
- [ ] Post a user note (topic picker, optional "to:" a session, Ctrl+Enter)
- [ ] **Delete a note** → gone (file removed); delete the whole
      `board-selftest` topic via *delete topic…* as the cleanup test
- [ ] Ask any running agent: *"leave a note on the bulletin board about X"* →
      skill triggers, note appears in the tab live
- [ ] Post a note `--to` a session (or reply to its note) → that session's row
      shows a **▤N badge**; after the agent runs `bulletin unread`, the badge
      clears on its own
- [ ] **nudge** button injects the "check topic X" prompt into a hosted session
- [ ] Unseen agent notes light a dot on the board toggle while it's closed

## 5. ▦ Usage panel (new)
- [ ] Tiles: new tokens today / output (thinking share on hover) / cache read /
      hit % / active sessions — sanity-check against a busy day
- [ ] 14-day bar chart; hover a bar for the in/cache-write/out breakdown
- [ ] Today-by-model table matches which models you actually used
- [ ] Top-sessions table: click a row → jumps to that session

## 6. Prompt queue upgrades
- [ ] Always one dashed **draft slot** at the bottom; typing into it queues
      instantly and grows a new slot (no + add button anywhere)
- [ ] **≡ drag-reorder** with accent insertion markers; drop on the draft slot
      = move to end; order survives restart
- [ ] **⤢ expand** opens the big editor modal; edits live-save; *send ▸* fires
      and removes the item
- [ ] Drag the queue pane's **left edge** to resize (persists); terminal
      refits live while dragging
- [ ] File-drop into a prompt box still inserts the quoted path (not confused
      with reordering)

## 7. ▧ Shots + notifications
- [ ] Shots button → thumbnail grid of `Pictures\Screenshots\<this-month>`;
      click inserts the quoted path into the active session, no submit
- [ ] 🔔 bell toggle: with seshMan **unfocused**, a session finishing its turn
      or blocking on a question raises a native Windows toast; clicking it
      raises seshMan on that session; no toasts while the window is focused
      (Claude Code's own Chrome push was disabled — desktop pings should now
      come from seshMan only)

## 8. ⚙ Settings / theming
- [ ] Light mode: whole UI + terminals swap; per-session color tints still read
- [ ] Terminal font: pick `OpenDyslexicMono` (installed) → all panes + logs
      re-render live
- [ ] App font: pick `OpenDyslexic` → sidebar/board/panels change; clear the
      field → default returns
- [ ] Everything persists across restart

## 9. Background / infrastructure (spot-checks)
- [ ] App feels snappier with many sessions (transcript parsing is now
      incremental — startup full-parse once, ~ms per tick after)
- [ ] Desk Deck still connects (Bearer-only API; bookmarks + prompt injection)
- [ ] Crash auditing: `%APPDATA%\seshMan\seshman.log` gets a `--- app start`
      line with versions; renderer crashes would auto-reload with a loop guard
- [ ] Stale-PID lock is dead: a session whose old PID got recycled by another
      app shows *stopped · resume here*, never "live in another window"

## Known follow-ups (deliberately not in this build)
- Desk Deck SSE `/api/events` + opt-in `last_message_preview`
- File-history diff viewer ("what did this session change") & global
  transcript search
- Orphan-session "stop & resume here" affordance
- Taskbar pin ritual: launch the new exe → right-click taskbar icon → Pin
