# Detached one-shot builder: waits for every seshMan.exe to exit, then runs
# `npm run pack` and logs to build.log. Retries on EBUSY (lingering handles on
# release\ right after close), and re-waits if seshMan relaunches mid-attempt.
$ErrorActionPreference = 'Continue'
$repo = 'C:\code\session_manager'
$log = Join-Path $repo 'build.log'

function Log($m) { "$(Get-Date -Format 'HH:mm:ss')  $m" | Out-File -FilePath $log -Append -Encoding utf8 }

"=== build-when-closed started $(Get-Date) ===" | Out-File -FilePath $log -Encoding utf8
Set-Location $repo
$exe = Join-Path $repo 'release\seshMan-win32-x64\seshMan.exe'
$deadline = (Get-Date).AddMinutes(90)

function Wait-ForClose {
  Log "waiting for seshMan.exe to exit (checking every 3s)..."
  while ((Get-Date) -lt $script:deadline) {
    if (-not (Get-Process -Name 'seshMan' -ErrorAction SilentlyContinue)) { return $true }
    Start-Sleep -Seconds 3
  }
  return $false
}

for ($attempt = 1; $attempt -le 4; $attempt++) {
  if (-not (Wait-ForClose)) { Log "TIMED OUT waiting for seshMan to close. Run 'npm run pack' manually."; exit 1 }
  Log "seshMan closed. Waiting 12s for file locks to release (attempt $attempt/4)..."
  Start-Sleep -Seconds 12
  if (Get-Process -Name 'seshMan' -ErrorAction SilentlyContinue) {
    Log "seshMan RELAUNCHED before the build could run - going back to waiting. Close it again."
    continue
  }
  Log "running: npm run pack"
  & npm.cmd run pack *>> $log
  $code = $LASTEXITCODE
  if ($code -eq 0 -and (Test-Path $exe) -and (Get-Item $exe).LastWriteTime -gt (Get-Date).AddMinutes(-10)) {
    $st = Get-Item $exe
    Log "RESULT: SUCCESS - $exe  ($([math]::Round($st.Length/1mb,1)) MB, built $($st.LastWriteTime))"
    exit 0
  }
  Log "pack attempt $attempt failed (exit $code) - retrying after 10s..."
  Start-Sleep -Seconds 10
}
Log "RESULT: FAILED after 4 attempts. See errors above; run 'npm run pack' manually with seshMan closed."
exit 1
