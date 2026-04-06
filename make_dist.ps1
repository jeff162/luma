<#
make_dist.ps1 - Package FinTrack source files for distribution

Run this from inside your installed FinTrack directory:
  .\make_dist.bat
  or
  powershell -File .\make_dist.ps1

Or point it at a different install:
  .\make_dist.bat C:\path\to\fintrack
  or
  powershell -File .\make_dist.ps1 -SourceDir C:\path\to\fintrack

Output: fintrack-dist-YYYYMMDD.zip in the current working directory.
The zip contains only the files needed to build and run FinTrack -
no database, no node_modules, no __pycache__, no .env secrets.
#>

param(
  [string]$SourceDir = (Get-Location).Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-FinTrackRoot([string]$Path) {
  return (Test-Path (Join-Path $Path 'docker-compose.yml')) -and
         (Test-Path (Join-Path $Path 'backend')) -and
         (Test-Path (Join-Path $Path 'frontend'))
}

function Get-RelativePath([string]$BasePath, [string]$FullPath) {
  $baseUri = [Uri]((Resolve-Path $BasePath).Path.TrimEnd('\') + '\')
  $fullUri = [Uri](Resolve-Path $FullPath).Path
  return [Uri]::UnescapeDataString($baseUri.MakeRelativeUri($fullUri).ToString()).Replace('/', '\')
}

function Test-ExcludedPath([string]$RelativePath) {
  $normalized = $RelativePath.Replace('/', '\')
  $parts = $normalized -split '\\'
  $filename = [System.IO.Path]::GetFileName($normalized)

  if ($parts -contains '__pycache__' -or
      $parts -contains '.pytest_cache' -or
      $parts -contains 'node_modules' -or
      $parts -contains 'dist' -or
      $parts -contains 'build' -or
      $parts -contains '.idea' -or
      $parts -contains '.vscode' -or
      $parts -contains '.git' -or
      $parts -contains 'data') {
    return $true
  }

  if ($filename -in @('fintrack.db', 'control.db', '.env', 'credentials.json', '.DS_Store', 'Thumbs.db', '.gitignore')) {
    return $true
  }

  if ($filename -like '.env.*' -or
      $filename -like '*.log' -or
      $filename -like '*.pyc' -or
      $filename -like '*.pyo') {
    return $true
  }

  return $false
}

$resolvedSource = (Resolve-Path $SourceDir).Path
if (-not (Test-FinTrackRoot $resolvedSource)) {
  throw "ERROR: '$resolvedSource' doesn't look like a FinTrack directory. Expected docker-compose.yml, backend/, frontend/."
}

$dateStamp = Get-Date -Format 'yyyyMMdd'
$outputDir = (Get-Location).Path
$baseName = "fintrack-dist-$dateStamp"
$outPath = Join-Path $outputDir "$baseName.zip"
$counter = 1
while (Test-Path $outPath) {
  $outPath = Join-Path $outputDir "$baseName-$counter.zip"
  $counter += 1
}

$include = @(
  'docker-compose.yml',
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'LICENSE',
  '.env_example',
  'make_dist.bat',
  'make_dist.sh',
  'make_dist.ps1',
  'docs',
  'backend/main.py',
  'backend/runtime_config.py',
  'backend/requirements.txt',
  'backend/pyproject.toml',
  'backend/.python-version',
  'backend/Dockerfile',
  'backend/db',
  'backend/routers',
  'backend/services',
  'frontend/index.html',
  'frontend/vite.config.js',
  'frontend/package.json',
  'frontend/package-lock.json',
  'frontend/.nvmrc',
  'frontend/nginx.conf',
  'frontend/Dockerfile',
  'frontend/src',
  'scripts'
)

$stageRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("fintrack-dist-stage-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stageRoot | Out-Null

try {
  Write-Host "Packaging FinTrack from: $resolvedSource"
  Write-Host "Output:                  $outPath"
  Write-Host ""

  $copiedFiles = New-Object System.Collections.Generic.List[string]

  foreach ($item in $include) {
    $sourcePath = Join-Path $resolvedSource $item
    if (-not (Test-Path $sourcePath)) {
      Write-Host ("  WARN: '{0}' not found - skipping" -f $item)
      continue
    }

    $entry = Get-Item $sourcePath
    if ($entry.PSIsContainer) {
      Get-ChildItem -Path $sourcePath -File -Recurse | ForEach-Object {
        $relative = Get-RelativePath $resolvedSource $_.FullName
        if (Test-ExcludedPath $relative) {
          return
        }
        $destPath = Join-Path $stageRoot $relative
        $destDir = Split-Path $destPath -Parent
        if (-not (Test-Path $destDir)) {
          New-Item -ItemType Directory -Path $destDir -Force | Out-Null
        }
        Copy-Item -LiteralPath $_.FullName -Destination $destPath -Force
        $copiedFiles.Add($relative) | Out-Null
      }
    } else {
      $relative = Get-RelativePath $resolvedSource $sourcePath
      if (Test-ExcludedPath $relative) {
        continue
      }
      $destPath = Join-Path $stageRoot $relative
      $destDir = Split-Path $destPath -Parent
      if (-not (Test-Path $destDir)) {
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
      }
      Copy-Item -LiteralPath $sourcePath -Destination $destPath -Force
      $copiedFiles.Add($relative) | Out-Null
    }
  }

  if ($copiedFiles.Count -eq 0) {
    throw "ERROR: No source files found in '$resolvedSource'."
  }

  if (Test-Path $outPath) {
    Remove-Item -LiteralPath $outPath -Force
  }

  Compress-Archive -Path (Join-Path $stageRoot '*') -DestinationPath $outPath -CompressionLevel Optimal

  Write-Host ""
  Write-Host "Done. First entries:"
  $copiedFiles |
    Sort-Object |
    Select-Object -First 60 |
    ForEach-Object { Write-Host "  $_" }

  $size = [Math]::Round(((Get-Item $outPath).Length / 1MB), 2)
  Write-Host ""
  Write-Host ("  Files: {0}   Size: {1} MB" -f $copiedFiles.Count, $size)
  Write-Host ("  -> {0}" -f $outPath)
}
finally {
  if (Test-Path $stageRoot) {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force
  }
}
