$ErrorActionPreference = 'Stop'
$appUrl = 'http://localhost:3000/'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Test-LogiAuthRunning {
  try {
    $response = Invoke-WebRequest -Uri $appUrl -TimeoutSec 2
    return $response.StatusCode -eq 200 -and $response.Content.Contains('LogiAuth')
  } catch {
    return $false
  }
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js and npm are required. Install Node.js, then run this launcher again.' -ForegroundColor Red
  exit 1
}

if (-not (Test-LogiAuthRunning)) {
  Write-Host 'Starting LogiAuth...' -ForegroundColor Cyan
  Start-Process -FilePath $env:ComSpec -WorkingDirectory $projectRoot -ArgumentList '/k', 'npm start'
}

$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  if (Test-LogiAuthRunning) {
    Start-Process $appUrl
    exit 0
  }
  Start-Sleep -Milliseconds 750
}

Write-Host 'LogiAuth did not respond on http://localhost:3000 within 60 seconds.' -ForegroundColor Red
Write-Host 'Check the LogiAuth server window for startup errors, then run this launcher again.'
exit 1
