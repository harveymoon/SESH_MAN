# Detached one-shot builder: waits for every seshMan.exe to exit, then runs
# `npm run pack` and logs to build.log. Launched by a Claude session that was
# itself hosted INSIDE seshMan (so it could not survive the close to build).
$ErrorActionPreference = 'Continue'
$repo = 'C:\code\session_manager'
$log = Join-Path $repo 'build.log'

function Log($m) { "$(Get-Date -Format 'HH:mm:ss')  $m" | Out-File -FilePath $log -Append -Encoding utf8 }

"=== build-when-closed started $(Get-Date) ===" | Out-File -FilePath $log -Encoding utf8
Log "waiting for seshMan.exe to exit (checking every 3s, up to 60 min)..."

$deadline = (Get-Date).AddMinutes(60)
while ((Get-Date) -lt $deadline) {
  $alive = Get-Process -Name 'seshMan' -ErrorAction SilentlyContinue
  if (-not $alive) { break }
  Start-Sleep -Seconds 3
}
if (Get-Process -Name 'seshMan' -ErrorAction SilentlyContinue) {
  Log "TIMED OUT: seshMan still running after 60 min. Re-run this script or 'npm run pack' manually."
  exit 1
}

Log "seshMan closed. Waiting 3s for file locks to release..."
Start-Sleep -Seconds 3

Set-Location $repo
Log "running: npm run pack"
& npm.cmd run pack *>> $log
$code = $LASTEXITCODE

$exe = Join-Path $repo 'release\seshMan-win32-x64\seshMan.exe'
if ($code -eq 0 -and (Test-Path $exe)) {
  $st = Get-Item $exe
  Log "RESULT: SUCCESS - $exe  ($([math]::Round($st.Length/1mb,1)) MB, built $($st.LastWriteTime))"
} else {
  Log "RESULT: FAILED (exit $code). Scroll up in this log for the packager error."
}
