# ─────────────────────────────────────────────────────────────────────────────
# OpenCode TeamMode — PowerShell installer for Windows
#
# Usage:
#   irm https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/scripts/install.ps1 | iex
#   # or locally:
#   .\scripts\install.ps1
#
# What it does:
#   1. Installs the @te-river/opencode-team-mode npm package globally.
#   2. Adds the plugin reference to your global opencode.jsonc.
#   3. Prints next steps.
# ─────────────────────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"
$utf8Bom = New-Object System.Text.UTF8Encoding($true)

# Resolve the actual latest version from the npm registry so the plugin
# entry in opencode.jsonc shows a concrete version (e.g. @1.4.8) instead
# of @latest — users can then see which version they have installed.
$VERSION = (npm view @te-river/opencode-team-mode version).Trim()
$PLUGIN_NAME = "@te-river/opencode-team-mode@$VERSION"
$OPENCODE_CONFIG_DIR = Join-Path $env:USERPROFILE ".config" "opencode"
$CONFIG_FILE = Join-Path $OPENCODE_CONFIG_DIR "opencode.jsonc"

function Write-Info  { param($msg) Write-Host "ℹ  " -ForegroundColor Cyan -NoNewline; Write-Host $msg }
function Write-Ok    { param($msg) Write-Host "✔  " -ForegroundColor Green -NoNewline; Write-Host $msg }
function Write-Warn  { param($msg) Write-Host "⚠  " -ForegroundColor Yellow -NoNewline; Write-Host $msg }
function Write-Err   { param($msg) Write-Host "✖  " -ForegroundColor Red -NoNewline; Write-Host $msg }

# Returns an Encoding that matches the file's existing BOM state (preserve as-is).
function Get-ConfigEncoding {
    param([string]$Path)
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        return (New-Object System.Text.UTF8Encoding($true))
    }
    return (New-Object System.Text.UTF8Encoding($false))
}

# ── 0. preflight ─────────────────────────────────────────────────────────────
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Err "npm is not installed. Install Node.js >= 18 first: https://nodejs.org"
    exit 1
}

# ── 1. install the plugin package globally ───────────────────────────────────
Write-Info "Installing $PLUGIN_NAME globally via npm ..."
try {
    npm install -g $PLUGIN_NAME 2>$null
    if ($LASTEXITCODE -ne 0) { throw "global install failed" }
} catch {
    Write-Warn "Global install failed. Trying local install in current project ..."
    npm install --save-dev $PLUGIN_NAME
}
Write-Ok "npm package installed."

# ── 2. patch opencode.jsonc ──────────────────────────────────────────────────
if (-not (Test-Path $OPENCODE_CONFIG_DIR)) {
    New-Item -ItemType Directory -Path $OPENCODE_CONFIG_DIR -Force | Out-Null
}

if (-not (Test-Path $CONFIG_FILE)) {
    Write-Warn "No opencode.jsonc found. Creating a minimal one at $CONFIG_FILE ..."
    $minimalCfg = @"
{
  "`$schema": "https://opencode.ai/config.json",
  "plugin": [
    "$PLUGIN_NAME"
  ]
}
"@
    [IO.File]::WriteAllText($CONFIG_FILE, $minimalCfg, $utf8Bom)
} else {
    Write-Info "Adding '$PLUGIN_NAME' to plugin list in $CONFIG_FILE ..."
    $content = Get-Content -Path $CONFIG_FILE -Raw -Encoding UTF8

    if ($content -match [regex]::Escape($PLUGIN_NAME)) {
        Write-Ok "Plugin already registered. Nothing to do."
    } elseif ($content -match '"plugin"\s*:\s*\[') {
        # String-level insertion right after "plugin": [ — preserves comments & formatting.
        $newContent = $content -replace '(?s)("plugin"\s*:\s*\[)', "`$1`n    `"$PLUGIN_NAME`","
        [IO.File]::WriteAllText($CONFIG_FILE, $newContent, (Get-ConfigEncoding $CONFIG_FILE))
    } else {
        # No plugin array yet — append one before the final closing brace.
        $idx = $content.LastIndexOf('}')
        if ($idx -lt 0) {
            Write-Err "Cannot parse $CONFIG_FILE. Please add `"$PLUGIN_NAME`" to the plugin array manually."
            exit 1
        }
        $head = $content.Substring(0, $idx)
        $tail = $content.Substring($idx)
        $sep = if ($head -match '\S\s*$') { ",`n" } else { "`n" }
        $newContent = $head + $sep + ('  "plugin": [' + "`n" + '    "' + $PLUGIN_NAME + '"' + "`n" + '  ]' + "`n") + $tail
        [IO.File]::WriteAllText($CONFIG_FILE, $newContent, (Get-ConfigEncoding $CONFIG_FILE))
    }
}
Write-Ok "Plugin registered in $CONFIG_FILE."

# ── 3. done ──────────────────────────────────────────────────────────────────
Write-Host ""
Write-Ok "OpenCode TeamMode installed successfully!"
Write-Host ""
Write-Info "Next steps:"
Write-Host "   1. Open your project in OpenCode Desktop."
Write-Host "   2. Restart OpenCode to load the new plugin."
Write-Host "   3. Try a command:  /team-plan  <your task>"
Write-Host "                      /team-run   <your task>"
Write-Host ""
Write-Info "Available agents:  @team  @architect  @implementer  @reviewer  @tester  @researcher"
Write-Info "Available commands: /team-plan  /team-implement  /team-review  /team-test  /team-research  /team-run"
Write-Host ""
