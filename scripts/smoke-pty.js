// Headless check: does the prebuilt pty load under Electron's ABI, and can it
// spawn a process and stream output? Exits 0 on success, 1 on failure.
const { app } = require('electron');

app.disableHardwareAcceleration();

app.whenReady().then(() => {
  let pty;
  try {
    pty = require('@homebridge/node-pty-prebuilt-multiarch');
    console.log('[ok] pty module loaded under Electron', process.versions.electron);
  } catch (e) {
    console.error('[FAIL] require pty:', e.message);
    app.exit(1);
    return;
  }

  try {
    const shell = process.platform === 'win32' ? 'cmd.exe' : 'bash';
    const p = pty.spawn(shell, [], { cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
    let out = '';
    p.onData((d) => {
      out += d;
      if (out.length > 20) {
        console.log('[ok] pty produced output:', JSON.stringify(out.slice(0, 40)));
        p.kill();
        app.exit(0);
      }
    });
    p.onExit(() => app.exit(0));
    setTimeout(() => {
      console.error('[FAIL] no pty output within 5s');
      app.exit(1);
    }, 5000);
  } catch (e) {
    console.error('[FAIL] spawn:', e.message);
    app.exit(1);
  }
});
