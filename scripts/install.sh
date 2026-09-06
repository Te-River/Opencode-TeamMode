#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# OpenCode TeamMode — one-click installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/scripts/install.sh | bash
#
# What it does:
#   1. Queries the latest version from npm.
#   2. Adds @te-river/opencode-team-mode@<version> to ~/.config/opencode/opencode.jsonc.
#   3. OpenCode will auto-install the package on next startup (via Bun).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PKG="@te-river/opencode-team-mode"

echo ""
echo "OpenCode TeamMode Installer"
echo "=========================="
echo ""

# ── query latest version ────────────────────────────────────────────────────
if ! command -v npm &>/dev/null; then
  echo "✖  npm not found. Install Node.js >= 18 first: https://nodejs.org"
  exit 1
fi

VERSION=$(npm view "$PKG" version 2>/dev/null) || {
  echo "✖  Failed to query npm registry"
  exit 1
}
PINNED="${PKG}@${VERSION}"
echo "✔  Latest version: ${VERSION}"

# ── patch config with Node.js (safe JSON manipulation) ──────────────────────
CFG_DIR="${HOME}/.config/opencode"
CFG="${CFG_DIR}/opencode.jsonc"
mkdir -p "$CFG_DIR"

if [ ! -f "$CFG" ]; then
  cat > "$CFG" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "plugin": [
    "${PINNED}"
  ]
}
EOF
  echo "✔  Created ${CFG}"
else
  node -e "
const fs = require('fs');
const path = '${CFG}';
const pkg = '${PKG}';
const pinned = '${PINNED}';
let content = fs.readFileSync(path, 'utf8');

if (content.includes(pkg)) {
  // already registered — update version
  content = content.replace(new RegExp(pkg.replace(/[.*+?^\${}()|[\]\\\\]/g, '\\\\$&') + '@[^\"\\s]+', 'g'), pinned);
  fs.writeFileSync(path, content);
  console.log('✔  Updated to ${VERSION}');
} else if (/\"plugin\"\\s*:\\s*\\[/.test(content)) {
  // plugin array exists — insert after opening bracket
  content = content.replace(/(\"plugin\"\\s*:\\s*\\[)/, '$1\\n    \"' + pinned + '\",');
  fs.writeFileSync(path, content);
  console.log('✔  Plugin added');
} else {
  // no plugin array — add before final closing brace
  const idx = content.lastIndexOf('}');
  if (idx < 0) { console.error('✖  Cannot parse config'); process.exit(1); }
  const head = content.slice(0, idx);
  const tail = content.slice(idx);
  const sep = /\\S\\s*$/.test(head) ? ',\\n' : '\\n';
  content = head + sep + '  \"plugin\": [\\n    \"' + pinned + '\"\\n  ]\\n' + tail;
  fs.writeFileSync(path, content);
  console.log('✔  Plugin array added');
}
"
fi

# ── done ────────────────────────────────────────────────────────────────────
echo ""
echo "✔  Done! Pinned: ${PINNED}"
echo ""
echo "Next steps:"
echo "  1. Open (or restart) OpenCode Desktop"
echo "  2. Try:  /team-plan <your task>"
echo "           /team-run  <your task>"
echo ""
