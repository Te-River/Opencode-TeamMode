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
  # Download and run Node.js script for safe JSON manipulation
  NODE_SCRIPT_URL="https://ghproxy.net/https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/scripts/install-node.js"
  NODE_SCRIPT=$(mktemp)
  
  trap "rm -f ${NODE_SCRIPT}" EXIT
  
  curl -fsSL "${NODE_SCRIPT_URL}" -o "${NODE_SCRIPT}"
  node "${NODE_SCRIPT}" "${CFG}" "${PKG}"
fi

echo ""
echo "✔  Done! Restart OpenCode Desktop to activate."
echo ""
