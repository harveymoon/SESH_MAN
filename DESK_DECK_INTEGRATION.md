# seshMan ⇄ Desk_Deck integration

seshMan exposes a tiny **local HTTP API** so an external controller (a
Desk_Deck plugin, a Stream Deck, a script) can **list your Claude Code sessions,
see their state, and switch the focused one** — no mouse/keyboard.

This follows the Desk_Deck `INTEGRATING_YOUR_APP.md` contract: local-only,
one file-on-disk token, flat `GET` for state, short imperative `POST` verbs,
stable JSON shapes.

---

## At a glance

| | |
|---|---|
| **Base URL** | `http://127.0.0.1:7374` (loopback only — not reachable from the LAN) |
| **Auth** | bearer token from a file on disk (see below); `/api/status` is open |
| **Token file** | `%APPDATA%\seshMan\api_token.txt` (generated on first run) |
| **Transport** | HTTP only (state changes at human pace — poll every 1–2 s) |
| **CORS** | none — this is a loopback control surface for native clients, not a browser API. A web page can't read responses, so it can't fingerprint or drive the app. |
| **Lifecycle** | runs whenever seshMan is open; does **not** auto-launch |

---

## Auth

1. On first run seshMan writes a 32-byte URL-safe token to
   `%APPDATA%\seshMan\api_token.txt`.
2. Send it on every request except `/api/status` as the
   `Authorization: Bearer <token>` header. (The token is **only** accepted in
   this header — not as a `?t=` query string, which would leak into browser
   history, shell history, and proxy/server logs.)
3. Bad/missing token → `401 {"error":"bad_token"}`. A client should re-read the
   file and retry (so a seshMan restart self-heals). The comparison is
   constant-time.

There is no pairing UI and no human ever sees the token — read the file.

---

## Endpoints

### `GET /api/status` — availability probe (no auth)

The first call a controller makes; decides whether to render anything.

```json
{ "ok": true, "version": "0.1.0", "features": ["sessions", "switch", "prompt", "bookmarks"] }
```

Check `features` to hide UI an older seshMan build doesn't support. Never 500s.

### `GET /api/sessions` — list + current (auth)

One read renders the whole panel. **By default returns only *running* sessions**
(the live ones a controller cares about). Add **`?all=1`** to include
stopped/resumable sessions too.

```
GET /api/sessions          # running only (default)
GET /api/sessions?all=1    # every session, incl. stopped
```

```json
{
  "items": [
    {
      "id": "69969994-c7d3-4f3e-91eb-ef57a467bedd",
      "name": "winri",
      "project": "winri",
      "cwd": "C:\\CODE\\winri",
      "state": "ready",
      "running": true,
      "hosted": true,
      "waiting": true,
      "attention": "waiting",
      "source": "cli",
      "lastActive": 1780190000000
    }
  ],
  "current": "69969994-c7d3-4f3e-91eb-ef57a467bedd"
}
```

| Field | Meaning |
|-------|---------|
| `id` | opaque session id — echo it back in `focus` / `prompt` |
| `name` | the session's display title (your `/rename`, else auto-title, else folder) |
| `project` | the project folder name |
| `cwd` | full working-directory path (disambiguates same-named projects) |
| `state` | `working` · `ready` · `idle` · `shell` · `stopped` (see below) |
| `running` | is a live process backing it |
| `hosted` | seshMan owns a live PTY for it → **prompt injection is possible** (see `/prompt`). Enable the prompt button only when `hosted == true`. |
| `waiting` | `true` = finished its turn, **your move** (badge these) |
| `attention` | `none` · `waiting` (finished turn) · `question` (blocking on a prompt — most urgent). `error` reserved. Prefer this over deriving from `waiting`. |
| `source` | `cli` or `desktop` (which kind of Claude session) |
| `lastActive` | epoch ms of last activity (sort key) |
| `current` (top-level) | the session currently focused in seshMan |

**`state` values** (exactly what the seshMan sidebar shows):

| state | meaning | suggested color |
|-------|---------|-----------------|
| `working` | Claude is busy | amber |
| `ready` | finished its turn, waiting for you | green |
| `idle` | running, no recent turn | green/dim |
| `shell` | sitting at a shell prompt | green/dim |
| `stopped` | no live process (resumable) | grey |

`waiting:true` overlaps with `ready` but also covers idle/shell background
sessions you haven't switched to — use it to badge "needs you."

### `POST /api/sessions/<id>/focus` — switch (auth)

Switches seshMan to that session and raises the window. Same behavior as
clicking it in the sidebar: focus if already open, otherwise open its
read-only log (and offer resume) — it never silently forks a live session.

- Body: none.
- Returns `204 No Content`.

### `GET /api/bookmarks` — saved prompts (auth)

seshMan's reusable saved prompts, so a controller can render them as buttons.

```json
{ "items": [ { "id": "bm_abc123", "name": "Run tests", "text": "npm test" } ] }
```

Fire one with `/prompt` below using its `id` as `bookmark_id` (recommended — stays
in sync if the user edits it), or send its `text` literally.

### `POST /api/sessions/<id>/prompt` — inject a prompt (auth)

Type a prompt into a session seshMan **hosts** (owns a live PTY for). Use this for
deck buttons / canned prompts.

- Body: `{ "text"?: string, "bookmark_id"?: string, "submit"?: bool, "source"?: string }`
  - `bookmark_id` (if valid) resolves to that bookmark's **current** text and takes
    precedence over `text`. `submit` (default `false`): `false` inserts at the
    cursor (no Enter, user confirms); `true` pastes **and** submits. `source` is a
    free-form origin tag, logged only.
- Responses:
  - `204` — accepted (injected).
  - `409 not_hosted` — session isn't hosted in seshMan (stopped / external). Open &
    resume it first; seshMan never auto-resumes (resume forks a new id).
  - `409 busy` — `submit:true` while the session is working; retry when it's ready.
  - `404 unknown_bookmark` — `bookmark_id` doesn't exist.
  - `429 too_soon` — another prompt hit the same session within 750 ms (debounce).
  - `400 bad_body` / `empty` — bad JSON, or neither `text` nor `bookmark_id`.

> **Hosted-only:** seshMan can only type into its own PTYs. Gate the prompt button
> on `hosted == true`. It cannot detect you typing into a pane by hand, so a deck
> prompt fired mid-typing will clobber partial input — use a per-session deck lock
> if you chain prompts.

---

## Errors

All non-2xx responses are JSON:

```json
{ "error": "stable_code", "message": "human prose" }
```

| code | when |
|------|------|
| `bad_token` (401) | missing/invalid token — re-read the file and retry |
| `not_found` (404) | unknown path/method |

Never returns HTML. `/api/status` never errors.

---

## Quick test (do this before writing the plugin)

```powershell
$t = (Get-Content "$env:APPDATA\seshMan\api_token.txt" -Raw).Trim()

# availability (no auth)
curl http://127.0.0.1:7374/api/status

# list sessions (token only via the Authorization header)
curl -H "Authorization: Bearer $t" http://127.0.0.1:7374/api/sessions

# switch to a session (id from the list above)
curl -X POST -H "Authorization: Bearer $t" `
     http://127.0.0.1:7374/api/sessions/<id>/focus
```

If those four work, the Desk_Deck plugin will work.

---

## The Desk_Deck plugin (the other half)

Per Desk_Deck's guide the wrapper plugin stays tiny because the API does the
work. A `server/providers/seshman.py` sketch:

```python
import time, pathlib, os, requests

BASE = "http://127.0.0.1:7374"
TOKEN_FILE = pathlib.Path(os.environ["APPDATA"]) / "seshMan" / "api_token.txt"

def _tok():                      # re-read each call so a restart self-heals
    try: return TOKEN_FILE.read_text().strip()
    except FileNotFoundError: return ""

def _hdr(): return {"Authorization": f"Bearer {_tok()}"}

def available():                 # cheap render gate
    try: return requests.get(f"{BASE}/api/status", timeout=0.5).json().get("ok")
    except Exception: return False

def sessions():                  # poll ~1–2s to render the grid
    return requests.get(f"{BASE}/api/sessions", headers=_hdr(), timeout=1).json()

def focus(session_id):           # button action
    requests.post(f"{BASE}/api/sessions/{session_id}/focus",
                  headers=_hdr(), timeout=1)
```

Tablet UI: a button per `items[i]` — label `name`, tint by `state`, ring the
one whose `id == current`, dot the `waiting` ones; on tap call `focus(id)`.

---

## Conventions honored (from `INTEGRATING_YOUR_APP.md`)

- **Local only** — binds `127.0.0.1`, never `0.0.0.0`. Desk_Deck is the
  LAN-facing piece; seshMan is not reachable from the network.
- **Simple over RESTful** — one `GET /api/sessions` renders the whole panel.
- **One token, file-on-disk** — no OAuth, no pairing, per-install token.
- **Cheap probe** — `/api/status` is unauthenticated and instant.
- **Stable shapes** — fields are only ever added, never renamed/repurposed;
  bump `version` and extend `features` when the contract grows.
- **Don't auto-launch** — Desk_Deck binds to seshMan if it's running.

---

## Not yet (agreed, pending a later pass)

- **`GET /api/events`** (SSE) for push instead of polling — full snapshot per
  change + 15 s heartbeat, so `attention` transitions land immediately. Agreed
  with Desk_Deck; not yet built.
- **`last_message_preview`** field (~80 chars) on session items, behind a global
  opt-in seshMan setting (default off, privacy). Agreed; not yet built.

---

## Notes

- The API ships inside the packaged app — after pulling changes, rebuild with
  `npm run pack`; the running `seshMan.exe` serves the API on port **7374**.
- Token lives at `%APPDATA%\seshMan\api_token.txt`. Delete it to rotate (a new
  one is generated on next launch; update any client that cached it).
