Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $scriptDir
$envPath = Join-Path $rootDir '.env'
$backendScript = Join-Path $scriptDir 'start_backend.ps1'
$frontendScript = Join-Path $scriptDir 'start_frontend.ps1'
$backendLog = Join-Path $scriptDir 'backend.log'
$frontendLog = Join-Path $scriptDir 'frontend.log'

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

function Test-Truthy([string]$Value, [bool]$DefaultValue = $false) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return $DefaultValue }
  switch ($Value.Trim().ToLowerInvariant()) {
    '1' { return $true }
    'true' { return $true }
    'yes' { return $true }
    'on' { return $true }
    '0' { return $false }
    'false' { return $false }
    'no' { return $false }
    'off' { return $false }
    default { return $DefaultValue }
  }
}

function Find-CommandPath([string]$Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }
  return $null
}

function Get-IntValue([string]$Value, [int]$DefaultValue) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return $DefaultValue }
  $parsed = 0
  if ([int]::TryParse($Value.Trim(), [ref]$parsed) -and $parsed -gt 0) {
    return $parsed
  }
  return $DefaultValue
}

function Wait-BackendReady([string]$Url, [int]$TimeoutSeconds = 60) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $attempt = 0
  while ((Get-Date) -lt $deadline) {
    $attempt += 1
    try {
      $resp = Invoke-WebRequest -Uri $Url -Method Get -UseBasicParsing -TimeoutSec 2
      if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300) {
        return $true
      }
    } catch {
      if ($attempt -eq 1) {
        Write-Host "Backend is still starting. Waiting for it to become ready..."
      } elseif ($attempt % 5 -eq 0) {
        Write-Host "Still waiting for backend startup..."
      }
      Start-Sleep -Seconds 1
    }
  }
  return $false
}

if (-not (Test-Path $backendScript)) {
  throw "Backend launcher not found: $backendScript"
}
if (-not (Test-Path $frontendScript)) {
  throw "Frontend launcher not found: $frontendScript"
}

$powerShellExe = Find-CommandPath 'powershell'
if (-not $powerShellExe) {
  $powerShellExe = Find-CommandPath 'pwsh'
}
if (-not $powerShellExe) {
  throw "PowerShell executable not found."
}

$useLogFiles = Test-Truthy (Get-EnvValue $envPath 'FINTRACK_USE_LOG_FILES') $false
$backendPort = Get-EnvValue $envPath 'BACKEND_PORT'
if ([string]::IsNullOrWhiteSpace($backendPort)) {
  $backendPort = '8000'
}
$backendReadyTimeout = Get-IntValue (Get-EnvValue $envPath 'FINTRACK_BACKEND_READY_TIMEOUT') 180
$backendHealthUrl = "http://127.0.0.1:$backendPort/api/health"

Write-Host "Starting FinTrack backend in a new window..."
$backendArgs = @(
  '-NoExit',
  '-ExecutionPolicy', 'Bypass',
  '-File', $backendScript
)
if ($useLogFiles) {
  $backendArgs += @('-LogPath', $backendLog)
}
Start-Process -FilePath $powerShellExe -ArgumentList $backendArgs

Write-Host "Waiting for backend to respond on $backendHealthUrl ..."
if (Wait-BackendReady -Url $backendHealthUrl -TimeoutSeconds $backendReadyTimeout) {
  Write-Host "Backend is ready."
} else {
  Write-Host "Backend did not become ready within $backendReadyTimeout seconds. Starting the frontend anyway."
}

Write-Host "Starting FinTrack frontend in a new window..."
$frontendArgs = @(
  '-NoExit',
  '-ExecutionPolicy', 'Bypass',
  '-File', $frontendScript
)
if ($useLogFiles) {
  $frontendArgs += @('-LogPath', $frontendLog)
}
Start-Process -FilePath $powerShellExe -ArgumentList $frontendArgs

Write-Host ""
Write-Host "FinTrack launch requested."
Write-Host "Two terminal windows should open: one for the backend and one for the frontend."
if ($useLogFiles) {
  Write-Host "Logs are overwritten on each launch:"
  Write-Host "  $backendLog"
  Write-Host "  $frontendLog"
} else {
  Write-Host "Log files are disabled by FINTRACK_USE_LOG_FILES in .env."
}
