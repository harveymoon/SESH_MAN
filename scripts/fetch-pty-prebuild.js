// Fetches the node-pty prebuilt binary matching the installed Electron's ABI.
// node-pty's bundled winpty fails to compile from source on Windows, so we
// download a prebuilt instead of running electron-rebuild.
const { execFileSync } = require('child_process');
const path = require('path');

let electronVersion;
try {
  electronVersion = require('electron/package.json').version;
} catch (_) {
  console.log('[fetch-pty-prebuild] electron not installed yet; skipping');
  process.exit(0);
}

const moduleDir = path.dirname(
  require.resolve('@homebridge/node-pty-prebuilt-multiarch/package.json')
);
const prebuildInstall = require.resolve('prebuild-install/bin.js');

console.log(`[fetch-pty-prebuild] electron ${electronVersion} -> downloading pty prebuild`);
try {
  execFileSync(
    process.execPath,
    [prebuildInstall, '--runtime=electron', `--target=${electronVersion}`, '--arch=' + process.arch],
    { cwd: moduleDir, stdio: 'inherit' }
  );
  console.log('[fetch-pty-prebuild] done');
} catch (e) {
  console.error('[fetch-pty-prebuild] failed:', e.message);
  process.exit(1);
}
