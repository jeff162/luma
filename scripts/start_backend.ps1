param(
  [string]$LogPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $scriptDir
$backendDir = Join-Path $rootDir 'backend'
$envPath = Join-Path $rootDir '.env'
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

# No .env is created here, and no secrets are written into one. The backend generates its session
# secret on first run and stores it in the control database; .env is only an optional override file
# for values that must be known before the app starts (ports, database locations).

if (-not (Test-Path $venvPython)) {
  Write-Host "Creating backend virtual environment (first run only)..."
  Push-Location $backendDir
  try {
    # The interpreter is chosen by version, not by taking whatever `python` resolves to. The pinned
    # dependencies need 3.12 or newer, and a venv built from an older Python fails partway through
    # installing them, with an error that says nothing about the real cause. `py -3.12` names the
    # version Luma is built on directly; the launcher's default and the bare-`python` fallback have to
    # be asked, because they answer to no particular version.
    $versionGate = 'import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)'
    if (Get-Command py -ErrorAction SilentlyContinue) {
      & py -3.12 -m venv venv
      if (-not (Test-Path $venvPython)) {
        & py -3 -c $versionGate
        if ($LASTEXITCODE -eq 0) {
          & py -3 -m venv venv
        }
      }
    } elseif (Get-Command python -ErrorAction SilentlyContinue) {
      & python -c $versionGate
      if ($LASTEXITCODE -ne 0) {
        throw 'The python on PATH is not a supported version. Luma needs Python 3.12 or newer.'
      }
      & python -m venv venv
    } else {
      throw "Python was not found. Install Python 3.12 or newer and try again."
    }
    # `py` exits non-zero when the version asked for is not installed, and nothing above would notice:
    # the next command would run against a venv python that was never created.
    if (-not (Test-Path $venvPython)) {
      throw "The virtual environment was not created. Install Python 3.12 or newer and try again."
    }
    & $venvPython -m pip install --upgrade pip | Out-Null
  } finally {
    Pop-Location
  }
}

$backendPort = Get-EnvValue $envPath 'BACKEND_PORT'
if ([string]::IsNullOrWhiteSpace($backendPort)) {
  $backendPort = '8011'
}

# This computer only unless BACKEND_HOST widens it: the backend serves the built interface as well as
# the API, so a wide bind is the whole application on the network over plain HTTP.
$backendHost = Get-EnvValue $envPath 'BACKEND_HOST'
if ([string]::IsNullOrWhiteSpace($backendHost)) {
  $backendHost = '127.0.0.1'
}

if (Test-PortInUse ([int]$backendPort)) {
  throw "Backend port $backendPort is already in use. Stop the running backend before starting another one."
}

Push-Location $rootDir
try {
  Write-Host "Checking/installing backend dependencies. This can take a minute on first run..."
  & $venvPython -m pip install -r backend/requirements.txt
  Write-Host "Starting backend on $backendHost port $backendPort"
  # This intentionally does not match the Linux launcher, which sets WATCHFILES_FORCE_POLLING=false.
  # watchfiles force-enables stat-polling only when the kernel release contains "microsoft-standard"
  # AND the platform is Linux, i.e. on WSL, where it costs a measured ~28% of a core polling the whole
  # --reload-dir. On Windows the platform test fails, so watchfiles uses ReadDirectoryChangesW and
  # there is nothing to disable. Setting it here anyway would be inert rather than harmful — it is
  # simply not needed.
  #
  # The exception is running this script under PowerShell on Linux or WSL, which it is not written for.
  # If that ever happens, add:  $env:WATCHFILES_FORCE_POLLING = 'false'
  & $venvPython -m uvicorn backend.main:app --reload --reload-dir backend --host $backendHost --port $backendPort
} finally {
  Pop-Location
  if (-not [string]::IsNullOrWhiteSpace($LogPath)) {
    Stop-Transcript | Out-Null
  }
}
