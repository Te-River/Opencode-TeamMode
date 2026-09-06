#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# OpenCode TeamMode — one-click installer
#
# Usage:
#   curl -fsSL https://ghproxy.net/https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/scripts/install.sh | bash
#
# What it does:
#   Adds @te-river/opencode-team-mode@latest to ~/.config/opencode/opencode.jsonc.
#   OpenCode will auto-install the package on next startup (via Bun).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PKG="@te-river/opencode-team-mode@latest"

echo ""
echo "OpenCode TeamMode Installer"
echo "=========================="
echo ""

# ── patch config ────────────────────────────────────────────────────────────
CFG_DIR="${HOME}/.config/opencode"
CFG="${CFG_DIR}/opencode.jsonc"
mkdir -p "$CFG_DIR"

if [ ! -f "$CFG" ]; then
  cat > "$CFG" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "plugin": [
    "${PKG}"
  ]
}
EOF
  echo "✔  Created ${CFG}"
else
  NODE_SCRIPT=$(mktemp)
  cat > "${NODE_SCRIPT}" <<'NODEJS'
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
NODEJS
  trap "rm -f ${NODE_SCRIPT}" EXIT
  node "${NODE_SCRIPT}" "${CFG}" "${PKG}"
fi

echo ""
echo "✔  Done! Restart OpenCode Desktop to activate."
echo ""
