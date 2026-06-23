#requires -version 5
<#
  Builds all BlockNSFW Guard release artifacts into desktop\release\:
    - guard.exe              (CLI + service + watchdog)
    - blocknsfw-status.exe   (Wails status window)
    - BlockNSFW-Guard-Setup.exe (Inno Setup installer that bundles both)

  Signing is intentionally skipped (see docs/pc-version.md for the SignPath plan).
  Run from anywhere:  powershell -ExecutionPolicy Bypass -File desktop\build.ps1
#>
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$root    = $PSScriptRoot                       # ...\desktop
$release = Join-Path $root "release"

function Find-Tool($name, $candidates) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  throw "Could not find '$name' on PATH or at: $($candidates -join ', ')"
}

$go    = Find-Tool "go"    @("C:\Program Files\Go\bin\go.exe")
$wails = Find-Tool "wails" @("$env:USERPROFILE\go\bin\wails.exe")
$iscc  = Find-Tool "ISCC"  @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "C:\Program Files (x86)\Inno Setup 6\ISCC.exe")

# Wails shells out to 'go' and to node/npm, so both must be on PATH.
$goDir = Split-Path $go
if ($env:PATH -notlike "*$goDir*") { $env:PATH = "$goDir;$env:PATH" }
$nodeDir = "C:\Program Files\nodejs"
if ((Test-Path $nodeDir) -and ($env:PATH -notlike "*$nodeDir*")) { $env:PATH = "$nodeDir;$env:PATH" }

Write-Host "== go test ==" -ForegroundColor Cyan
& $go -C $root test ./...; if ($LASTEXITCODE -ne 0) { throw "tests failed" }

Write-Host "== go vet ==" -ForegroundColor Cyan
& $go -C $root vet ./...; if ($LASTEXITCODE -ne 0) { throw "vet failed" }

Write-Host "== build guard.exe ==" -ForegroundColor Cyan
& $go -C $root build -ldflags "-s -w" -o guard.exe ./cmd/guard; if ($LASTEXITCODE -ne 0) { throw "guard build failed" }

Write-Host "== build status UI (wails) ==" -ForegroundColor Cyan
Push-Location (Join-Path $root "statusui")
try { & $wails build; if ($LASTEXITCODE -ne 0) { throw "wails build failed" } } finally { Pop-Location }

Write-Host "== build installer (ISCC) ==" -ForegroundColor Cyan
& $iscc (Join-Path $root "installer\BlockNSFW-Guard.iss"); if ($LASTEXITCODE -ne 0) { throw "installer build failed" }

Write-Host "== collect release artifacts ==" -ForegroundColor Cyan
if (Test-Path $release) { Remove-Item $release -Recurse -Force }
New-Item -ItemType Directory -Path $release | Out-Null
Copy-Item (Join-Path $root "guard.exe") $release
Copy-Item (Join-Path $root "statusui\build\bin\blocknsfw-status.exe") $release
Copy-Item (Join-Path $root "installer\output\BlockNSFW-Guard-Setup.exe") $release
# Ship the config next to the binaries so they find it without walking the tree.
Copy-Item (Join-Path (Split-Path $root) "shared\extension-ids.json") $release

Write-Host "`nRelease artifacts in $release :" -ForegroundColor Green
Get-ChildItem $release | ForEach-Object { "  {0,-32} {1,8:N0} KB" -f $_.Name, ($_.Length / 1KB) }
Write-Host "`nNOTE: these binaries are UNSIGNED - signing intentionally skipped for now." -ForegroundColor Yellow
