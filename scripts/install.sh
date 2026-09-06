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
  if grep -q "$PKG" "$CFG"; then
    echo "✔  Plugin already registered"
  elif grep -q '"plugin"' "$CFG"; then
    sed -i.bak "/\"plugin\"\s*:\s*\[/a\\
    \"${PKG}\"," "$CFG" && rm -f "${CFG}.bak"
    echo "✔  Plugin added"
  else
    echo "✖  No plugin array found. Please add manually:"
    echo "  \"plugin\": [\"${PKG}\"]"
    exit 1
  fi
fi

echo ""
echo "✔  Done! Restart OpenCode Desktop to activate."
echo ""
