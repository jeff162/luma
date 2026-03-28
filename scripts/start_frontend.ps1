param(
  [string]$LogPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $scriptDir
$frontendDir = Join-Path $rootDir 'frontend'
$envPath = Join-Path $rootDir '.env'
$envExamplePath = Join-Path $rootDir '.env_example'

if (-not [string]::IsNullOrWhiteSpace($LogPath)) {
  if (Test-Path $LogPath) {
    Remove-Item -LiteralPath $LogPath -Force
  }
  Start-Transcript -Path $LogPath -Force | Out-Null
}

if (-not (Test-Path $envPath) -and (Test-Path $envExamplePath)) {
  Copy-Item -LiteralPath $envExamplePath -Destination $envPath
  Write-Host "Created .env from .env_example"
}

Push-Location $frontendDir
try {
  Write-Host "Checking/installing frontend dependencies. This can take a minute on first run..."
  & npm install
  Write-Host "Starting frontend"
  & npm run dev
} finally {
  Pop-Location
  if (-not [string]::IsNullOrWhiteSpace($LogPath)) {
    Stop-Transcript | Out-Null
  }
}
