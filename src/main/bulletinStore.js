'use strict';

// Machine-local agent bulletin board: one JSON file per note in
// ~/.claude/bulletin/notes/, written by the bulletin-board skill (agents) and
// by us (user notes from the board tab). Note ids are "<epochMs>-<rand6>", so
// LEXICOGRAPHIC id order == chronological order — sort by id, never by ts.
// Writers use tmp-then-rename, so a plain .json file is never half-written.
//
// Unlike the per-session transcript watchers (which self-remove on error),
// this is a singleton store: on watcher error we re-arm lazily on the next
// list()/post() so the board can survive the directory being recreated.

const fs = require('fs');
const os = require('os');
const path = require('path');

const BULLETIN_DIR = path.join(os.homedir(), '.claude', 'bulletin');
const NOTES_DIR = path.join(BULLETIN_DIR, 'notes');
const CURSORS_DIR = path.join(BULLETIN_DIR, '.cursors');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ID_RE = /^\d{13}-[a-z0-9]{4,8}$/;
const MAX_TEXT = 16 * 1024;

// Byte-identical contract with bulletin.py's slugify().
function slugify(name) {
  const slug = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'agent';
}

function ensureDirs() {
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  fs.mkdirSync(CURSORS_DIR, { recursive: true });
}

function newNoteId() {
  let rand = '';
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 6; i++) rand += chars[Math.floor(Math.random() * chars.length)];
  return `${Date.now()}-${rand}`;
}

// ---------------------------------------------------------------------------
// Watching (both notes/ and .cursors/ -> one debounced payload-free signal)
// ---------------------------------------------------------------------------
let watchers = [];
let debounce = null;
let changeCb = null;

function disarm() {
  for (const w of watchers) {
    try {
      w.close();
    } catch (_) {}
  }
  watchers = [];
  clearTimeout(debounce);
  debounce = null;
}

function arm() {
  if (!changeCb || watchers.length) return;
  ensureDirs();
  const onEvent = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => changeCb && changeCb(), 250);
  };
  try {
    for (const dir of [NOTES_DIR, CURSORS_DIR]) {
      const w = fs.watch(dir, onEvent);
      w.on('error', () => disarm()); // re-armed lazily by the next list()/post()
      watchers.push(w);
    }
  } catch (_) {
    disarm(); // dir vanished mid-arm; next call retries
  }
}

function watch(cb) {
  changeCb = cb;
  arm();
}

function close() {
  changeCb = null;
  disarm();
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
function listNotes() {
  arm(); // self-heal a dead watcher on any read
  const notes = [];
  let files = [];
  try {
    files = fs.readdirSync(NOTES_DIR).filter((f) => f.endsWith('.json'));
  } catch (_) {
    ensureDirs();
    return notes;
  }
  for (const f of files) {
    try {
      const n = JSON.parse(fs.readFileSync(path.join(NOTES_DIR, f), 'utf8'));
      if (n && n.id && n.topic && typeof n.text === 'string') notes.push(n);
    } catch (_) {
      /* mid-write / deleted between readdir and read; next tick heals */
    }
  }
  notes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return notes;
}

// { nameSlug: { topic: lastReadNoteId } } — read from the skill's private
// cursor files so the UI can tell whether a session has SEEN its board mail.
function listCursors() {
  const out = {};
  let files = [];
  try {
    files = fs.readdirSync(CURSORS_DIR).filter((f) => f.endsWith('.json'));
  } catch (_) {
    return out;
  }
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(CURSORS_DIR, f), 'utf8'));
      if (d && typeof d === 'object') out[f.replace(/\.json$/, '')] = d.topics || {};
    } catch (_) {
      /* skip */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writes (user-side)
// ---------------------------------------------------------------------------
function postNote(input) {
  const topic = String((input && input.topic) || '')
    .trim()
    .toLowerCase();
  if (!SLUG_RE.test(topic)) return { error: 'bad_topic' };
  const text = String((input && input.text) || '').replace(/\s+$/, '');
  if (!text) return { error: 'empty' };
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT) return { error: 'too_long' };
  const replyTo = input && input.replyTo ? String(input.replyTo) : null;
  if (replyTo && !ID_RE.test(replyTo)) return { error: 'bad_reply_to' };
  const note = {
    v: 1,
    id: newNoteId(),
    topic,
    title: input && input.title ? String(input.title).slice(0, 200) : null,
    from: 'Harvey',
    kind: 'user',
    sessionId: null,
    ts: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    text,
    replyTo,
    to: input && input.to ? slugify(input.to) : null,
  };
  ensureDirs();
  const file = path.join(NOTES_DIR, note.id + '.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(note, null, 2));
  fs.renameSync(tmp, file); // atomic on same volume
  arm();
  return { ok: true, id: note.id };
}

function deleteNote(id) {
  if (!ID_RE.test(String(id || ''))) return { error: 'bad_id' };
  const file = path.join(NOTES_DIR, id + '.json');
  if (!path.resolve(file).startsWith(path.resolve(NOTES_DIR))) return { error: 'bad_id' };
  try {
    fs.unlinkSync(file);
  } catch (e) {
    if (e.code !== 'ENOENT') return { error: 'unlink_failed' };
  }
  return { ok: true };
}

function deleteTopic(slug) {
  const topic = String(slug || '').trim().toLowerCase();
  if (!SLUG_RE.test(topic)) return { error: 'bad_topic' };
  let removed = 0;
  for (const n of listNotes()) {
    if (n.topic === topic && ID_RE.test(n.id)) {
      const r = deleteNote(n.id);
      if (r.ok) removed++;
    }
  }
  return { ok: true, removed };
}

module.exports = { listNotes, listCursors, postNote, deleteNote, deleteTopic, watch, close, slugify };
