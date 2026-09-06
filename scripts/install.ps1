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
        # Use Node.js for safe JSON manipulation (embedded script)
        $nodeScript = @'
const fs = require('fs');
const path = process.argv[2];
const pkg = process.argv[3];
let content = fs.readFileSync(path, 'utf8');

if (content.includes(pkg)) {
  console.log('OK  Plugin already registered');
} else if (/"plugin"\s*:\s*\[/.test(content)) {
  const match = content.match(/"plugin"\s*:\s*\[/);
  if (!match) { console.error('ERR Cannot parse plugin array'); process.exit(1); }
  let idx = match.index + match[0].length;
  let depth = 1;
  while (depth > 0 && idx < content.length) {
    if (content[idx] === '[') depth++;
    if (content[idx] === ']') depth--;
    idx++;
  }
  idx--;
  const before = content.slice(0, idx).trimEnd();
  const after = content.slice(idx);
  const needsComma = before.endsWith(',') ? '' : ',';
  content = before + needsComma + '\n    "' + pkg + '"\n  ' + after;
  fs.writeFileSync(path, content);
  console.log('OK  Plugin added');
} else {
  console.error('ERR No plugin array found. Please add manually:');
  console.error('  "plugin": ["' + pkg + '"]');
  process.exit(1);
}
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

# ── done ────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "✔  Done! Restart OpenCode Desktop to activate." -ForegroundColor Green
Write-Host ""
