param(
  [string]$Host = "127.0.0.1",
  [int]$Port = 8000,
  [int]$TimeoutSec = 60
)

$ErrorActionPreference = "Stop"

$health = "http://$Host`:$Port/health"
$home = "http://$Host`:$Port/home"

Write-Host "Starting server..."
Start-Process -FilePath ".\.venv\Scripts\python.exe" -ArgumentList @("-m","uvicorn","app.main:app","--host",$Host,"--port",$Port) -WorkingDirectory $PSScriptRoot | Out-Null

Write-Host "Waiting for $health ..."
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Uri $health -TimeoutSec 2
    if ($resp.StatusCode -eq 200) {
      Write-Host "Server is up. Opening browser..."
      Start-Process $home | Out-Null
      exit 0
    }
  } catch {
    Start-Sleep -Milliseconds 300
  }
}

Write-Host "Timed out waiting for server. You can open $home manually once it's up."
exit 1

