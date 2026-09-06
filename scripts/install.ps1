# ─────────────────────────────────────────────────────────────────────────────
# OpenCode TeamMode — one-click installer for Windows
#
# Usage:
#   irm https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/scripts/install.ps1 | iex
#
# What it does:
#   1. Queries the latest version from npm.
#   2. Adds @te-river/opencode-team-mode@<version> to ~/.config/opencode/opencode.jsonc.
#   3. OpenCode will auto-install the package on next startup (via Bun).
# ─────────────────────────────────────────────────────────────────────────────

#Requires -Version 5.1

$ErrorActionPreference = "Stop"

$PKG = "@te-river/opencode-team-mode"

Write-Host ""
Write-Host "OpenCode TeamMode Installer" -ForegroundColor Cyan
Write-Host "==========================" -ForegroundColor Cyan
Write-Host ""

# ── 0. check Node.js ────────────────────────────────────────────────────────
try {
    $nodeVersion = & node -v 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Node.js not found" }
} catch {
    Write-Host "✖  Node.js is not installed." -ForegroundColor Red
    Write-Host "   Please install Node.js >= 18 from https://nodejs.org/"
    exit 1
}

$majorVersion = [int]($nodeVersion -replace 'v', '' -split '\.' | Select-Object -First 1)
if ($majorVersion -lt 18) {
    Write-Host "✖  Node.js version must be >= 18. Current: $nodeVersion" -ForegroundColor Red
    exit 1
}

Write-Host "✔  Node.js $nodeVersion detected" -ForegroundColor Green

# ── 1. query latest version from npm ────────────────────────────────────────
Write-Host ""
Write-Host "Querying latest version from npm..." -ForegroundColor Yellow
try {
    $ActualVersion = npm view $PKG version 2>$null
    if ([string]::IsNullOrWhiteSpace($ActualVersion)) { throw "Empty version" }
} catch {
    Write-Host "✖  Failed to query npm registry" -ForegroundColor Red
    exit 1
}

$Pinned = "$PKG@$ActualVersion"
Write-Host "✔  Latest version: $ActualVersion" -ForegroundColor Green

# ── 2. patch config ────────────────────────────────────────────────────────
$CFG_DIR = Join-Path $env:USERPROFILE ".config\opencode"
$CFG_FILE = Join-Path $CFG_DIR "opencode.jsonc"

if (-not (Test-Path $CFG_DIR)) {
    New-Item -ItemType Directory -Path $CFG_DIR -Force | Out-Null
}

if (-not (Test-Path $CFG_FILE)) {
    Write-Host "Creating $CFG_FILE ..." -ForegroundColor Yellow
    $newCfg = @"
{
  "`$schema": "https://opencode.ai/config.json",
  "plugin": [
    "$Pinned"
  ]
}
"@
    [IO.File]::WriteAllText($CFG_FILE, $newCfg, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "✔  Created $CFG_FILE" -ForegroundColor Green
} else {
    Write-Host "Found config: $CFG_FILE" -ForegroundColor Green

    $content = [IO.File]::ReadAllText($CFG_FILE, [Text.Encoding]::UTF8)

    if ($content -match [regex]::Escape($PKG)) {
        # Already registered — update version
        Write-Host "Updating plugin version to $ActualVersion ..." -ForegroundColor Yellow
        $content = $content -replace "$([regex]::Escape($PKG))@[^\s`"]+", $Pinned
        [IO.File]::WriteAllText($CFG_FILE, $content, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "✔  Updated to $ActualVersion" -ForegroundColor Green
    } elseif ($content -match '"plugin"\s*:\s*\[') {
        # Plugin array exists — insert after opening bracket
        Write-Host "Adding plugin to config ..." -ForegroundColor Yellow
        $newContent = $content -replace '(?s)("plugin"\s*:\s*\[)', "`$1`n    `"$Pinned`","
        [IO.File]::WriteAllText($CFG_FILE, $newContent, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "✔  Plugin added" -ForegroundColor Green
    } else {
        # No plugin array — add before final closing brace
        Write-Host "Adding plugin array to config ..." -ForegroundColor Yellow
        $idx = $content.LastIndexOf('}')
        if ($idx -lt 0) {
            Write-Host "✖  Cannot parse config. Please add manually:" -ForegroundColor Red
            Write-Host "  `"plugin`": [`"$Pinned`"]"
            exit 1
        }
        $head = $content.Substring(0, $idx)
        $tail = $content.Substring($idx)
        $sep = if ($head -match '\S\s*$') { ",`n" } else { "`n" }
        $newContent = $head + $sep + ('  "plugin": [' + "`n" + '    "' + $Pinned + '"' + "`n" + '  ]' + "`n") + $tail
        [IO.File]::WriteAllText($CFG_FILE, $newContent, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "✔  Plugin array added" -ForegroundColor Green
    }
}

# ── 3. done ──────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "✔  Done! Pinned: $Pinned" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Open (or restart) OpenCode Desktop"
Write-Host "  2. Try:  /team-plan <your task>"
Write-Host "           /team-run  <your task>"
Write-Host ""
