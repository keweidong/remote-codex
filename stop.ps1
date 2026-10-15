$ErrorActionPreference = 'Stop'
$taskData = if ($env:CODEX_REMOTE_DATA) { $env:CODEX_REMOTE_DATA } else { Join-Path $env:LOCALAPPDATA 'CodexRemoteWeb' }
$taskRuntimePath = Join-Path $taskData 'runtime.json'
if (-not (Test-Path -LiteralPath $taskRuntimePath)) { Write-Host 'Codex Remote Web is not running.'; exit 0 }
$taskRuntime = Get-Content -LiteralPath $taskRuntimePath -Raw | ConvertFrom-Json
if ($taskRuntime.projectDir -ne $PSScriptRoot) { throw 'Runtime belongs to another project; refusing to stop it.' }
$taskBase = [Uri]$taskRuntime.adminUrl
if ($taskBase.Host -ne '127.0.0.1' -or $taskBase.Scheme -ne 'http') { throw 'Invalid local management address.' }
$taskToken = (Get-Content -LiteralPath (Join-Path $taskData 'admin-key') -Raw).Trim()
$taskSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$taskHeaders = @{ Origin = $taskRuntime.adminUrl }
Invoke-RestMethod -Uri ($taskRuntime.adminUrl + '/admin/login') -Method Post -ContentType 'application/json' -Headers $taskHeaders -WebSession $taskSession -Body (@{token=$taskToken}|ConvertTo-Json -Compress) | Out-Null
Invoke-RestMethod -Uri ($taskRuntime.adminUrl + '/admin/shutdown') -Method Post -ContentType 'application/json' -Headers $taskHeaders -WebSession $taskSession -Body '{}' | Out-Null
Write-Host 'Codex Remote Web is stopping, including its own tunnel.'
