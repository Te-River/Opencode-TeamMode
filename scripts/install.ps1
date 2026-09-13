# ─────────────────────────────────────────────────────────────────────────────
# OpenCode TeamMode — one-click installer for Windows (idempotent: re-run to UPDATE)
#
# Usage:
#   irm https://ghproxy.net/https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/scripts/install.ps1 | iex
#
# What it does:
#   1. Adds @te-river/opencode-team-mode@latest to ~/.config/opencode/opencode.jsonc
#      (falls back to opencode.json when only that one exists).
#   2. Purges the stale plugin cache — OpenCode caches plugins by spec string
#      and NEVER re-resolves @latest on its own, so a re-run is the update.
#   3. Re-resolves an npm-installed copy inside the config dir (package-lock
#      pins would otherwise keep the old version).
#   Restart OpenCode afterwards.
# ─────────────────────────────────────────────────────────────────────────────

#Requires -Version 5.1

$ErrorActionPreference = "Stop"

$PKG = "@te-river/opencode-team-mode@latest"

Write-Host ""
Write-Host "OpenCode TeamMode Installer" -ForegroundColor Cyan
Write-Host "==========================" -ForegroundColor Cyan
Write-Host ""

# ── patch config ────────────────────────────────────────────────────────────
# opencode.jsonc is the canonical name and OVERRIDES opencode.json when both
# exist — so we ALWAYS target the .jsonc: patch it when present, and when only
# an opencode.json exists, migrate its content into a new opencode.jsonc first
# (writing the .json instead would risk our entry being shadowed).
$CFG_DIR = Join-Path $env:USERPROFILE ".config\opencode"
$CFG_FILE = Join-Path $CFG_DIR "opencode.jsonc"
$LEGACY = Join-Path $CFG_DIR "opencode.json"

if (-not (Test-Path $CFG_DIR)) {
    New-Item -ItemType Directory -Path $CFG_DIR -Force | Out-Null
}
if ((-not (Test-Path $CFG_FILE)) -and (Test-Path $LEGACY)) {
    Copy-Item $LEGACY $CFG_FILE
    Write-Host "ℹ  Migrated opencode.json → opencode.jsonc (jsonc takes precedence; the original .json is left untouched)" -ForegroundColor Yellow
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
        # Use Node.js for safe JSON manipulation (embedded script)
        $nodeScript = @'
const fs = require('fs');
const file = process.argv[2];
const pkg = process.argv[3];
let content = fs.readFileSync(file, 'utf8');

if (content.includes(pkg)) {
  console.log('OK  Plugin already registered');
  process.exit(0);
}
const m = content.match(/"plugin"\s*:\s*\[/);
if (!m) {
  console.error('ERR No plugin array found. Please add manually:');
  console.error('  "plugin": ["' + pkg + '"]');
  process.exit(1);
}
// String- and comment-aware scan: find the array's closing bracket and the
// end of its last element (handles nested tuples, // and block comments).
const open = m.index + m[0].length;
let i = open, depth = 1, lastValEnd = -1;
let inStr = false, esc = false, lineC = false, blockC = false;
while (i < content.length) {
  const c = content[i];
  if (lineC) { if (c === '\n') lineC = false; }
  else if (blockC) { if (c === '*' && content[i + 1] === '/') { blockC = false; i++; } }
  else if (inStr) {
    if (esc) esc = false;
    else if (c === '\\') esc = true;
    else if (c === '"') { inStr = false; if (depth === 1) lastValEnd = i + 1; }
  }
  else if (c === '/' && content[i + 1] === '/') lineC = true;
  else if (c === '/' && content[i + 1] === '*') { blockC = true; i++; }
  else if (c === '"') inStr = true;
  else if (c === '[' || c === '{') depth++;
  else if (c === ']' || c === '}') {
    depth--;
    if (depth === 0) break;
    if (depth === 1) lastValEnd = i + 1;
  }
  i++;
}
if (depth !== 0) { console.error('ERR Unbalanced plugin array'); process.exit(1); }
if (lastValEnd >= 0) {
  let j = lastValEnd;
  const close = i;
  while (j < close && /\s/.test(content[j])) j++;
  const at = (j < close && content[j] === ',') ? j + 1 : lastValEnd;
  const comma = at === lastValEnd ? ',' : '';
  content = content.slice(0, at) + comma + '\n    "' + pkg + '"' + content.slice(at);
} else {
  content = content.slice(0, open) + '\n    "' + pkg + '"' + content.slice(open);
}
fs.writeFileSync(file, content);
console.log('OK  Plugin added');
'@
        $nodeScriptPath = "$env:TEMP\install-teammode.js"
        [IO.File]::WriteAllText($nodeScriptPath, $nodeScript, (New-Object System.Text.UTF8Encoding($false)))
        try {
            node $nodeScriptPath $CFG_FILE $PKG
        } finally {
            Remove-Item $nodeScriptPath -ErrorAction SilentlyContinue
        }
    }
}

# ── update: purge the stale plugin cache (OpenCode never re-resolves @latest) ──
$cacheRoots = @(
    (Join-Path $env:USERPROFILE ".cache\opencode\packages"),
    (Join-Path $env:LOCALAPPDATA "opencode\cache\packages")
)
foreach ($root in $cacheRoots) {
    if (Test-Path $root) {
        $stale = Get-ChildItem -Path $root -Directory -Filter "*opencode-team-mode*" -ErrorAction SilentlyContinue
        foreach ($d in $stale) {
            Remove-Item -Recurse -Force $d.FullName -ErrorAction SilentlyContinue
            Write-Host "✔  Purged stale plugin cache: $($d.Name)" -ForegroundColor Green
        }
    }
}

# ── update: npm-installed copy in the config dir? re-resolve its pinned lock ──
$nmCopy = Join-Path $CFG_DIR "node_modules\@te-river\opencode-team-mode"
if (Test-Path $nmCopy) {
    Write-Host "↻  Re-resolving npm-installed plugin in $CFG_DIR ..." -ForegroundColor Yellow
    Push-Location $CFG_DIR
    try {
        npm install "@te-river/opencode-team-mode@latest" --no-fund --no-audit
        if ($LASTEXITCODE -eq 0) { Write-Host "✔  npm copy updated" -ForegroundColor Green }
        else { Write-Host "!  npm re-resolve failed (non-fatal — cache purge + restart is usually enough)" -ForegroundColor Yellow }
    } finally {
        Pop-Location
    }
}

# ── done ────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "✔  Done! Restart OpenCode Desktop to activate." -ForegroundColor Green
Write-Host ""
