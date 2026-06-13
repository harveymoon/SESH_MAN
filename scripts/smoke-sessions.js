const { SessionWatcher } = require('../src/main/sessionWatcher');

(async () => {
  const w = new SessionWatcher();
  await w.proc.refresh();
  const list = w.list();
  console.log('sessions:', list.length, '(recency order)\n');
  for (const s of list.slice(0, 12)) {
    const tag = s.running ? (s.active ? 'RUN ' : 'idle') : 'stop';
    const lm = s.lastMessage ? '[' + s.lastMessage.role + '] ' + s.lastMessage.text.replace(/\s+/g, ' ').slice(0, 44) : '(no msg)';
    console.log('  [' + tag + '] ' + s.source.padEnd(8) + s.project.padEnd(20) + lm);
  }
})();
