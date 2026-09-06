# ─────────────────────────────────────────────────────────────────────────────
# OpenCode TeamMode — one-click installer for Windows
#
# Usage:
#   irm https://ghproxy.net/https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/scripts/install.ps1 | iex
#
# What it does:
#   Adds @te-river/opencode-team-mode@latest to ~/.config/opencode/opencode.jsonc.
#   OpenCode will auto-install the package on next startup (via Bun).
# ─────────────────────────────────────────────────────────────────────────────

#Requires -Version 5.1

$ErrorActionPreference = "Stop"

$PKG = "@te-river/opencode-team-mode@latest"

Write-Host ""
Write-Host "OpenCode TeamMode Installer" -ForegroundColor Cyan
Write-Host "==========================" -ForegroundColor Cyan
Write-Host ""

# ── patch config ────────────────────────────────────────────────────────────
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
    "$PKG"
  ]
}
"@
    [IO.File]::WriteAllText($CFG_FILE, $newCfg, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "✔  Created $CFG_FILE" -ForegroundColor Green
} else {
    Write-Host "Found config: $CFG_FILE" -ForegroundColor Green

    $content = [IO.File]::ReadAllText($CFG_FILE, [Text.Encoding]::UTF8)

    if ($content -match [regex]::Escape($PKG)) {
        Write-Host "✔  Plugin already registered" -ForegroundColor Green
    } elseif ($content -match '"plugin"\s*:\s*\[') {
        Write-Host "Adding plugin to config ..." -ForegroundColor Yellow
        $newContent = $content -replace '(?s)("plugin"\s*:\s*\[)', "`$1`n    `"$PKG`","
        [IO.File]::WriteAllText($CFG_FILE, $newContent, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "✔  Plugin added" -ForegroundColor Green
    } else {
        Write-Host "✖  No plugin array found. Please add manually:" -ForegroundColor Red
        Write-Host "  `"plugin`": [`"$PKG`"]"
        exit 1
    }
}

# ── done ────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "✔  Done! Restart OpenCode Desktop to activate." -ForegroundColor Green
Write-Host ""
