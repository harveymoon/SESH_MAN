const fs = require('fs');
const js = fs.readFileSync('C:/code/session_manager/src/renderer/renderer.js', 'utf8');
const html = fs.readFileSync('C:/code/session_manager/src/renderer/index.html', 'utf8');

// 1. every getElementById target must exist in the HTML (static ids only;
// dynamically created elements don't use getElementById here)
const wanted = [...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
const missingDom = [...new Set(wanted)].filter((id) => !html.includes(`id="${id}"`));
console.log('ids referenced but missing from HTML:', missingDom.length ? missingDom : 'none');

// 2. every <xxx>El identifier used must be declared somewhere
const used = new Set([...js.matchAll(/\b([a-zA-Z]+El)\b/g)].map((m) => m[1]));
const undeclared = [...used].filter((n) => !new RegExp(`(const|let)\\s+${n}\\b`).test(js));
console.log('El identifiers used but never declared:', undeclared.length ? undeclared : 'none');
