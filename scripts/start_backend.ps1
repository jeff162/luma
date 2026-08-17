param(
  [string]$LogPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $scriptDir
$backendDir = Join-Path $rootDir 'backend'
$envPath = Join-Path $rootDir '.env'
$envExamplePath = Join-Path $rootDir '.env_example'
$venvDir = Join-Path $backendDir 'venv'
$venvPython = Join-Path $venvDir 'Scripts\python.exe'

if (-not [string]::IsNullOrWhiteSpace($LogPath)) {
  if (Test-Path $LogPath) {
    Remove-Item -LiteralPath $LogPath -Force
  }
  Start-Transcript -Path $LogPath -Force | Out-Null
}

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

function Set-EnvValue([string]$Path, [string]$Key, [string]$Value) {
  $escapedKey = [regex]::Escape($Key)
  $lines = if (Test-Path $Path) { Get-Content $Path } else { @() }
  $updated = $false

  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^\s*$escapedKey=") {
      $lines[$i] = "$Key=$Value"
      $updated = $true
      break
    }
  }

  if (-not $updated) {
    if ($lines.Count -gt 0 -and $lines[-1] -ne '') {
      $lines += ''
    }
    $lines += "$Key=$Value"
  }

  Set-Content -LiteralPath $Path -Value $lines
}

function New-SessionSecret() {
  $bytes = New-Object byte[] 36
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function New-AppMasterKey() {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return [Convert]::ToBase64String($bytes)
}

function Get-DefaultSessionCookieName([string]$RootPath) {
  $name = Split-Path $RootPath -Leaf
  $sanitized = ($name.ToLowerInvariant().ToCharArray() | ForEach-Object {
    if ([char]::IsLetterOrDigit($_)) { $_ } else { '_' }
  }) -join ''
  $sanitized = $sanitized.Trim('_')
  if ([string]::IsNullOrWhiteSpace($sanitized)) {
    $sanitized = 'luma'
  }
  return "${sanitized}_session"
}

function Test-InvalidSessionSecret([string]$Value) {
  $normalized = if ($null -eq $Value) { '' } else { $Value.Trim() }
  return [string]::IsNullOrWhiteSpace($normalized) -or
    $normalized -eq 'change_me_to_a_long_random_value' -or
    $normalized -eq 'dev-session-secret-change-me'
}

if (-not (Test-Path $envPath) -and (Test-Path $envExamplePath)) {
  Copy-Item -LiteralPath $envExamplePath -Destination $envPath
  Write-Host "Created .env from .env_example"
}

if (Test-Path $envPath) {
  $sessionSecret = Get-EnvValue $envPath 'SESSION_SECRET'
  $appMasterKey = Get-EnvValue $envPath 'APP_MASTER_KEY'
  $sessionCookieName = Get-EnvValue $envPath 'SESSION_COOKIE_NAME'
  $updatedEnv = $false

  if (Test-InvalidSessionSecret $sessionSecret) {
    Set-EnvValue $envPath 'SESSION_SECRET' (New-SessionSecret)
    $updatedEnv = $true
  }
  $appMasterKeyNormalized = if ($null -eq $appMasterKey) { '' } else { $appMasterKey.Trim() }
  if ([string]::IsNullOrWhiteSpace($appMasterKeyNormalized)) {
    Set-EnvValue $envPath 'APP_MASTER_KEY' (New-AppMasterKey)
    $updatedEnv = $true
  }
  $sessionCookieNameNormalized = if ($null -eq $sessionCookieName) { '' } else { $sessionCookieName.Trim() }
  if ([string]::IsNullOrWhiteSpace($sessionCookieNameNormalized) -or $sessionCookieNameNormalized -eq 'session') {
    Set-EnvValue $envPath 'SESSION_COOKIE_NAME' (Get-DefaultSessionCookieName $rootDir)
    $updatedEnv = $true
  }

  if ($updatedEnv) {
    Write-Host "Updated .env with secure startup defaults"
  }
}

if (-not (Test-Path $venvPython)) {
  Write-Host "Creating backend virtual environment (first run only)..."
  Push-Location $backendDir
  try {
    if (Get-Command py -ErrorAction SilentlyContinue) {
      & py -3.12 -m venv venv
    } elseif (Get-Command python -ErrorAction SilentlyContinue) {
      & python -m venv venv
    } else {
      throw "Python was not found. Install Python 3.12+ and try again."
    }
    & $venvPython -m pip install --upgrade pip | Out-Null
  } finally {
    Pop-Location
  }
}

$backendPort = Get-EnvValue $envPath 'BACKEND_PORT'
if ([string]::IsNullOrWhiteSpace($backendPort)) {
  $backendPort = '8000'
}

if (Test-PortInUse ([int]$backendPort)) {
  throw "Backend port $backendPort is already in use. Stop the running backend before starting another one."
}

Push-Location $rootDir
try {
  Write-Host "Checking/installing backend dependencies. This can take a minute on first run..."
  & $venvPython -m pip install -r backend/requirements.txt
  Write-Host "Starting backend on port $backendPort"
  # This intentionally does not match the Linux launcher, which sets WATCHFILES_FORCE_POLLING=false.
  # watchfiles force-enables stat-polling only when the kernel release contains "microsoft-standard"
  # AND the platform is Linux, i.e. on WSL, where it costs a measured ~28% of a core polling the whole
  # --reload-dir. On Windows the platform test fails, so watchfiles uses ReadDirectoryChangesW and
  # there is nothing to disable. Setting it here anyway would be inert rather than harmful — it is
  # simply not needed.
  #
  # The exception is running this script under PowerShell on Linux or WSL, which it is not written for.
  # If that ever happens, add:  $env:WATCHFILES_FORCE_POLLING = 'false'
  & $venvPython -m uvicorn backend.main:app --reload --reload-dir backend --host 0.0.0.0 --port $backendPort
} finally {
  Pop-Location
  if (-not [string]::IsNullOrWhiteSpace($LogPath)) {
    Stop-Transcript | Out-Null
  }
}
