# build-chrome.ps1
# Builds a clean Chrome extension bundle into dist/chrome/ from this folder.
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\build-chrome.ps1
#   powershell -ExecutionPolicy Bypass -File .\build-chrome.ps1 -Zip

[CmdletBinding()]
param(
    [switch]$Zip
)

$ErrorActionPreference = "Stop"

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$SrcDir      = $ScriptDir
$OutDir      = Join-Path $ScriptDir "dist\chrome"
$ManifestSrc = Join-Path $SrcDir "manifest.json"
$ManifestDst = Join-Path $OutDir "manifest.json"

$RuntimeFolders = @("icons")
$RuntimeFiles   = @(
    "background.js",
    "content.js",
    "popup.html",
    "popup.js",
    "options.html",
    "options.js",
    "blocked.html",
    "blocked.js",
    "audit.html",
    "audit.js",
    "stats.html",
    "stats.js",
    "appwrite-client.js",
    "blocklist.json",
    "LICENSE"
)

Write-Host "==> Cleaning $OutDir" -ForegroundColor Cyan
if (Test-Path $OutDir) {
    Remove-Item -Path $OutDir -Recurse -Force
}
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

Write-Host "==> Copying manifest" -ForegroundColor Cyan
Copy-Item -Path $ManifestSrc -Destination $ManifestDst -Force

Write-Host "==> Copying runtime folders" -ForegroundColor Cyan
foreach ($folder in $RuntimeFolders) {
    $src = Join-Path $SrcDir $folder
    if (Test-Path $src) {
        $dst = Join-Path $OutDir $folder
        New-Item -ItemType Directory -Path $dst -Force | Out-Null
        Copy-Item -Path (Join-Path $src "*") -Destination $dst -Recurse -Force
    }
}

Write-Host "==> Copying runtime files" -ForegroundColor Cyan
foreach ($file in $RuntimeFiles) {
    $src = Join-Path $SrcDir $file
    if (Test-Path $src) {
        Copy-Item -Path $src -Destination (Join-Path $OutDir $file) -Force
    }
}

if ($Zip) {
    $ZipPath = Join-Path $ScriptDir "dist\blocknsfw-chrome.zip"
    if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
    Write-Host "==> Creating $ZipPath" -ForegroundColor Cyan
    Compress-Archive -Path (Join-Path $OutDir "*") -DestinationPath $ZipPath
}

Write-Host "==> Chrome build complete: $OutDir" -ForegroundColor Green
if ($Zip) { Write-Host "==> Zip: $ZipPath" -ForegroundColor Green }
