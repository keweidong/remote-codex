param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$taskData = if ($env:CODEX_REMOTE_DATA) { $env:CODEX_REMOTE_DATA } else { Join-Path $env:LOCALAPPDATA 'CodexRemoteWeb' }
$taskRuntimePath = Join-Path $taskData 'runtime.json'
$taskNode = (Get-Command node.exe -ErrorAction Stop).Source
$taskVersion = & $taskNode --version
if ([int]($taskVersion.TrimStart('v').Split('.')[0]) -lt 24) { throw 'Node.js 24 or newer is required.' }
if (-not $env:CODEX_CLI_PATH) { $env:CODEX_CLI_PATH = (Get-Command codex.exe -ErrorAction Stop).Source }
if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'node_modules\qrcode\package.json'))) {
  Push-Location $taskRoot
  try { & npm.cmd install --ignore-scripts --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' } } finally { Pop-Location }
}
New-Item -ItemType Directory -Path $taskData -Force | Out-Null
$taskRuntime = $null
if (Test-Path -LiteralPath $taskRuntimePath) {
  try {
    $taskCandidate = Get-Content -LiteralPath $taskRuntimePath -Raw | ConvertFrom-Json
    $taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$taskCandidate.pid)" -ErrorAction SilentlyContinue
    if ($taskProcess -and $taskCandidate.projectDir -eq $taskRoot -and $taskProcess.CommandLine.Contains((Join-Path $taskRoot 'src\main.js'))) { $taskRuntime = $taskCandidate }
  } catch { }
}
if (-not $taskRuntime) {
  $taskStarted = Start-Process -FilePath $taskNode -ArgumentList @('"' + (Join-Path $taskRoot 'src\main.js') + '"') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskData 'stdout.log') -RedirectStandardError (Join-Path $taskData 'stderr.log') -PassThru
  for ($taskAttempt = 0; $taskAttempt -lt 50; $taskAttempt++) {
    Start-Sleep -Milliseconds 200
    if (Test-Path -LiteralPath $taskRuntimePath) {
      try { $taskCandidate = Get-Content -LiteralPath $taskRuntimePath -Raw | ConvertFrom-Json; if ($taskCandidate.pid -eq $taskStarted.Id) { $taskRuntime = $taskCandidate; break } } catch { }
    }
    if ($taskStarted.HasExited) { break }
  }
  if (-not $taskRuntime) { throw "Startup failed. See $taskData\stderr.log" }
}
Write-Host "Codex Remote Web ready: $($taskRuntime.adminUrl)"
if (-not $NoBrowser) {
  $taskToken = (Get-Content -LiteralPath (Join-Path $taskData 'admin-key') -Raw).Trim()
  Start-Process -FilePath ($taskRuntime.adminUrl + '/#token=' + $taskToken)
}
