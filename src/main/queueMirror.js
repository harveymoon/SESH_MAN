'use strict';

// Two-way mirror between a session's prompt queue and a `queue.md` checklist
// in its project folder, so the user can tell an agent "do the tasks in
// queue.md" and the agent can read/edit the same list the seshMan UI shows.
//
// UI -> file: the renderer pushes items after every queue save; identical
// content is skipped (also the echo-loop breaker). File -> UI: a watcher
// parses edits and notifies the renderer. "- [x]" (checked) and deleted
// items leave the queue; new "- [ ]" lines join it. On the FIRST write for a
// cwd, an existing file that differs wins over the UI (agent may have edited
// it while seshMan was closed).

const fs = require('fs');
const path = require('path');

const FILE = 'queue.md';
const mirrors = new Map(); // cwd -> { watcher, debounce, lastContent }
let onChangeCb = null;

const HEADER = `# Prompt Queue — synced by seshMan

<!-- This file mirrors the seshMan prompt queue for this project.
     "- [ ]" lines are queued prompts; continuation lines are indented
     two spaces. Check an item off ("- [x]") or delete its lines to
     remove it from the queue; add new "- [ ] ..." lines to queue new
     prompts. seshMan rewrites this file whenever the queue changes in
     the UI, and picks up your edits within a second. -->
`;

function compose(items) {
  const lines = [HEADER];
  for (const t of items) {
    const parts = String(t).split('\n');
    lines.push('- [ ] ' + parts[0]);
    for (const c of parts.slice(1)) lines.push('  ' + c);
  }
  return lines.join('\n') + '\n';
}

function parse(content) {
  const items = [];
  let cur = null;
  let checked = false;
  const flush = () => {
    if (cur !== null && !checked) {
      const text = cur.join('\n').replace(/\s+$/, '');
      if (text.trim()) items.push(text);
    }
    cur = null;
  };
  for (const raw of String(content).split(/\r?\n/)) {
    const m = /^-\s*\[([ xX])\]\s?(.*)$/.exec(raw);
    if (m) {
      flush();
      cur = [m[2]];
      checked = m[1] !== ' ';
    } else if (cur !== null && raw.startsWith('  ')) {
      cur.push(raw.slice(2)); // continuation line of a multi-line prompt
    } else {
      flush();
    }
  }
  flush();
  return items;
}

function arm(cwd) {
  const rec = mirrors.get(cwd);
  if (!rec || rec.watcher) return;
  const file = path.join(cwd, FILE);
  try {
    rec.watcher = fs.watch(file, () => {
      clearTimeout(rec.debounce);
      rec.debounce = setTimeout(() => {
        let content;
        try {
          content = fs.readFileSync(file, 'utf8');
        } catch (_) {
          return; // deleted/mid-save; next event retries
        }
        if (content === rec.lastContent) return; // our own write echoing back
        rec.lastContent = content;
        if (onChangeCb) onChangeCb(cwd, parse(content));
      }, 400);
    });
    rec.watcher.on('error', () => {
      try {
        rec.watcher.close();
      } catch (_) {}
      rec.watcher = null; // re-armed by the next writeMirror
    });
  } catch (_) {
    /* file missing; armed on next successful write */
  }
}

function writeMirror(cwd, items) {
  if (!cwd) return;
  let rec = mirrors.get(cwd);
  if (!rec) {
    rec = { watcher: null, debounce: null, lastContent: null };
    mirrors.set(cwd, rec);
  }
  const file = path.join(cwd, FILE);
  // First contact for this cwd: an existing file that disagrees wins (the
  // agent may have edited it while seshMan was closed).
  if (rec.lastContent === null) {
    try {
      const existing = fs.readFileSync(file, 'utf8');
      rec.lastContent = existing;
      arm(cwd);
      const theirs = parse(existing);
      if (JSON.stringify(theirs) !== JSON.stringify(items)) {
        if (onChangeCb) onChangeCb(cwd, theirs);
        return;
      }
    } catch (_) {
      /* no file yet — fall through and create it */
    }
  }
  const content = compose(items);
  if (content === rec.lastContent) return;
  try {
    if (!fs.existsSync(cwd)) return; // project folder gone
    fs.writeFileSync(file, content);
    rec.lastContent = content;
    arm(cwd);
  } catch (_) {
    /* unwritable folder — mirror silently off for this cwd */
  }
}

function watchAll(cb) {
  onChangeCb = cb;
}

function closeAll() {
  for (const r of mirrors.values()) {
    clearTimeout(r.debounce);
    try {
      if (r.watcher) r.watcher.close();
    } catch (_) {}
  }
  mirrors.clear();
  onChangeCb = null;
}

module.exports = { writeMirror, watchAll, closeAll, parse, compose };
