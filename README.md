# seshMan

A small, sharp Electron app that gives you one window to see and drive **every
running coding-agent session** on your machine.

- **Live dashboard** — watches `~/.claude/sessions/*.json` (the per-PID registry
  Claude maintains) and shows each instance's project, title, status
  (busy / idle), and last prompt. Updates in real time.
- **Terminal host** — click a session to attach a real terminal
  (`xterm.js` + `node-pty`) that resumes it via `claude --resume <id>`. Multiple
  sessions live side-by-side as tabs.

## How it works

| Source | What we read |
|--------|--------------|
| `~/.claude/sessions/<pid>.json` | live instance registry: pid, sessionId, cwd, status, version |
| `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` | transcript → aiTitle, lastPrompt, message count |

Liveness is confirmed with a `process.kill(pid, 0)` probe so stale files drop off.

## Run

```bash
npm install      # also rebuilds node-pty against Electron's ABI (postinstall)
npm start
```

If the native build fails (needs Visual Studio Build Tools on Windows), run:

```bash
npm run rebuild
```

## Notes / caveats

- These `~/.claude` files are **undocumented internals**; the shape varies
  between Claude versions, so parsing is defensive.
- The app *hosts* terminals (spawns Claude itself). It does not inject input
  into Claude tabs already running in other terminals — those still show in the
  dashboard as read-only status, and clicking them opens a fresh attached
  terminal that resumes the same session.

## Layout

```
src/
  main/
    main.js           Electron entry, window + IPC wiring
    sessionWatcher.js  reads + watches ~/.claude/sessions
    ptyManager.js      node-pty spawn/IO of claude
    preload.js         contextBridge API
  renderer/
    index.html         shell + xterm script tags
    renderer.js        sidebar + terminal tabs
    styles.css
```
