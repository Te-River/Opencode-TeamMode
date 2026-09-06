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
    } else {
        # Download and run Node.js script for safe JSON manipulation
        $nodeScriptUrl = "https://ghproxy.net/https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/scripts/install-node.js"
        $nodeScriptPath = "$env:TEMP\install-teammode.js"
        
        try {
            Invoke-WebRequest -Uri $nodeScriptUrl -OutFile $nodeScriptPath -TimeoutSec 30
            node $nodeScriptPath $CFG_FILE $PKG
        } catch {
            Write-Host "Failed to download installer script. Please try again." -ForegroundColor Red
            exit 1
        } finally {
            Remove-Item $nodeScriptPath -ErrorAction SilentlyContinue
        }
    }
}

# ── done ────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "✔  Done! Restart OpenCode Desktop to activate." -ForegroundColor Green
Write-Host ""
