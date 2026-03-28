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

function Get-EnvValue([string]$Path, [string]$Key) {
  if (-not (Test-Path $Path)) { return $null }
  foreach ($line in Get-Content $Path) {
    if ($line -match '^\s*#') { continue }
    if ($line -match "^\s*$([regex]::Escape($Key))=(.*)$") {
      return $matches[1].Trim()
    }
  }
  return $null
}

function Test-PortInUse([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(500)) {
      return $false
    }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

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

$frontendPort = Get-EnvValue $envPath 'FRONTEND_PORT'
if ([string]::IsNullOrWhiteSpace($frontendPort)) {
  $frontendPort = '5173'
}

if (Test-PortInUse ([int]$frontendPort)) {
  throw "Frontend port $frontendPort is already in use. Stop the running frontend before starting another one."
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
