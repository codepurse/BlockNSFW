# build-firefox.ps1
# Builds a clean Firefox extension bundle into dist/firefox/ from this folder.
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\build-firefox.ps1
#   powershell -ExecutionPolicy Bypass -File .\build-firefox.ps1 -Zip

[CmdletBinding()]
param(
    [switch]$Zip
)

$ErrorActionPreference = "Stop"

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$SrcDir      = $ScriptDir
$OutDir      = Join-Path $ScriptDir "dist\firefox"
$ManifestSrc = Join-Path $SrcDir "manifest.firefox.json"
$ManifestDst = Join-Path $OutDir "manifest.json"

$RuntimeFolders = @(
    "icons",
    "rules",
    "shared",
    "vendor",
    "nsfwjs",
    "models"
)
$RuntimeFiles   = @(
    "background.js",
    "content.js",
    "ai-image-blocker-core.js",
    "ai-image-blocker.js",
    "popup.html",
    "popup.js",
    "options.html",
    "options.js",
    "blocked.html",
    "blocked.js",
    "changelog.html",
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

Write-Host "==> Building static declarativeNetRequest ruleset" -ForegroundColor Cyan
# Generated from data\HOSTS.txt. Committed, but rebuilt here so a stale
# ruleset can never ship: it enforces the blocklist at the network layer,
# where a wrong entry is invisible to the user.
node scripts/build-dnr-ruleset.mjs
if ($LASTEXITCODE -ne 0) { throw "Failed to build the static DNR ruleset" }

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

Write-Host "==> Copying data files" -ForegroundColor Cyan
# Only the public suffix list ships. data\HOSTS.txt and data\WHITELIST.txt
# are the published sources the extension fetches at runtime, not package
# content, so they are deliberately left out of the bundle.
$DataOut = Join-Path $OutDir "data"
New-Item -ItemType Directory -Path $DataOut -Force | Out-Null
Copy-Item -Path (Join-Path $SrcDir "data\public-suffixes.txt") -Destination (Join-Path $DataOut "public-suffixes.txt") -Force

$BuildTimestampToken = "__BLOCKNSFW_BUILD_TIMESTAMP_MS__"
$BuildTimestampMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
$BackgroundDst = Join-Path $OutDir "background.js"
$BackgroundSource = [System.IO.File]::ReadAllText($BackgroundDst)
if (-not $BackgroundSource.Contains($BuildTimestampToken)) {
    throw "Missing bundled blocklist build timestamp token in Firefox background.js"
}
[System.IO.File]::WriteAllText(
    $BackgroundDst,
    $BackgroundSource.Replace($BuildTimestampToken, $BuildTimestampMs)
)

$RequiredAssets = @(
    "data\public-suffixes.txt",
    "rules\blocklist-rules.json",
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
        throw "Missing required asset in Firefox build: $asset"
    }
}

if ($Zip) {
    $ZipPath = Join-Path $ScriptDir "dist\blocknsfw-firefox.zip"
    if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
    Write-Host "==> Creating $ZipPath" -ForegroundColor Cyan

    # Use .NET ZipFile so entry paths use forward slashes (Firefox rejects backslashes)
    [System.Reflection.Assembly]::LoadWithPartialName("System.IO.Compression.FileSystem") | Out-Null
    # ZipFile.Open with mode "Create" returns a ZipArchive instance
    $ZipStream = [System.IO.Compression.ZipFile]::Open($ZipPath, "Create")
    try {
        $files = Get-ChildItem -Path $OutDir -Recurse -File
        foreach ($f in $files) {
            $rel = $f.FullName.Substring($OutDir.Length).TrimStart('\', '/') -replace '\\', '/'
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($ZipStream, $f.FullName, $rel, "Optimal") | Out-Null
        }
    } finally {
        $ZipStream.Dispose()
    }
}

Write-Host "==> Firefox build complete: $OutDir" -ForegroundColor Green
if ($Zip) { Write-Host "==> Zip: $ZipPath" -ForegroundColor Green }
