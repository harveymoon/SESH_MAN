# Detached one-shot builder: waits for every seshMan.exe to exit, waits for
# any process still executing from release\ to let go (and NAMES it in the
# log), then runs `npm run pack` with escalating retries. Logs to build.log.
$ErrorActionPreference = 'Continue'
$repo = 'C:\code\session_manager'
$log = Join-Path $repo 'build.log'
$relDir = Join-Path $repo 'release\seshMan-win32-x64'
$exe = Join-Path $relDir 'seshMan.exe'

function Log($m) { "$(Get-Date -Format 'HH:mm:ss')  $m" | Out-File -FilePath $log -Append -Encoding utf8 }

"=== build-when-closed started $(Get-Date) ===" | Out-File -FilePath $log -Encoding utf8
Set-Location $repo
$deadline = (Get-Date).AddMinutes(120)

function Wait-ForClose {
  Log 'waiting for seshMan.exe to exit (checking every 3s)...'
  while ((Get-Date) -lt $script:deadline) {
    if (-not (Get-Process -Name 'seshMan' -ErrorAction SilentlyContinue)) { return $true }
    Start-Sleep -Seconds 3
  }
  return $false
}

# Anything still EXECUTING from the release folder (crashpad handler, zombie
# renderer, etc.) blocks the packager's folder delete with EBUSY.
function Get-Holders {
  Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -and $_.Path -like "$relDir*"
  }
}

function Wait-ForHolders {
  $until = (Get-Date).AddMinutes(4)
  while ((Get-Date) -lt $until) {
    $h = @(Get-Holders)
    if (-not $h.Count) { return $true }
    Log ("release folder still held by: " + (($h | ForEach-Object { "$($_.ProcessName) pid=$($_.Id)" }) -join ', '))
    Start-Sleep -Seconds 10
  }
  return $false
}

for ($attempt = 1; $attempt -le 5; $attempt++) {
  if (-not (Wait-ForClose)) { Log 'TIMED OUT waiting for seshMan to close.'; exit 1 }
  Log "seshMan closed (attempt $attempt/5). Grace 15s..."
  Start-Sleep -Seconds 15
  if (Get-Process -Name 'seshMan' -ErrorAction SilentlyContinue) {
    Log 'seshMan RELAUNCHED - back to waiting. Close it again when ready.'
    continue
  }
  if (-not (Wait-ForHolders)) {
    Log 'holders never released the folder; see names above - close/kill them and keep this builder running.'
    continue
  }
  Log 'folder clear. running: npm run pack'
  cmd /c "npm run pack >> `"$log`" 2>&1"
  $code = $LASTEXITCODE
  if ($code -eq 0 -and (Test-Path $exe) -and (Get-Item $exe).LastWriteTime -gt (Get-Date).AddMinutes(-15)) {
    $st = Get-Item $exe
    Log "RESULT: SUCCESS - $exe  ($([math]::Round($st.Length/1mb,1)) MB, built $($st.LastWriteTime))"
    exit 0
  }
  Log "pack attempt $attempt failed (exit $code) - backing off $(20 * $attempt)s..."
  Start-Sleep -Seconds (20 * $attempt)
}
Log 'RESULT: FAILED after 5 attempts. See errors above; run npm run pack manually with seshMan closed.'
exit 1
