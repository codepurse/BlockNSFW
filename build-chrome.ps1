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

$RuntimeFolders = @(
    "icons",
    "shared",
    "vendor",
    "nsfwjs"
)
$RuntimeFiles   = @(
    "background.js",
    "content.js",
    "ai-image-blocker-core.js",
    "ai-image-blocker.js",
    "classify.worker.js",
    "offscreen.html",
    "offscreen.js",
    "popup.html",
    "popup.js",
    "options.html",
    "options.js",
    "blocked.html",
    "blocked.js",
    "onboarding.html",
    "onboarding.js",
    "audit.html",
    "audit.js",
    "stats.html",
    "stats.js",
    "community.html",
    "community.js",
    "appwrite-client.js",
    "blocklist.json",
    "text-model.json",
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
        Copy-Item -Path $src -Destination $OutDir -Recurse -Force
    }
}

Write-Host "==> Copying runtime files" -ForegroundColor Cyan
foreach ($file in $RuntimeFiles) {
    $src = Join-Path $SrcDir $file
    if (Test-Path $src) {
        Copy-Item -Path $src -Destination (Join-Path $OutDir $file) -Force
    }
}

$RequiredAssets = @(
    "vendor\tfjs\tf.es2017.js",
    "vendor\nsfwjs\nsfwjs.runtime.js",
    "nsfwjs\model.json",
    "nsfwjs\group1-shard1of1.bin",
    "text-model.json"
)

Write-Host "==> Verifying AI runtime assets" -ForegroundColor Cyan
foreach ($asset in $RequiredAssets) {
    $assetPath = Join-Path $OutDir $asset
    if (-not (Test-Path $assetPath)) {
        throw "Missing required asset in Chrome build: $asset"
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
