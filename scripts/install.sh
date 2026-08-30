#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# OpenCode TeamMode — one-click installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/scripts/install.sh | bash
#   # or locally:
#   bash scripts/install.sh
#
# What it does:
#   1. Installs the opencode-team-mode npm package globally.
#   2. Adds the plugin reference to your project's opencode.json (if present).
#   3. Prints next steps.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PLUGIN_NAME="@te-river/opencode-team-mode@latest"
CONFIG_FILE="opencode.json"

# ── colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { printf "${CYAN}ℹ${NC}  %s\n" "$*"; }
ok()    { printf "${GREEN}✔${NC}  %s\n" "$*"; }
warn()  { printf "${YELLOW}⚠${NC}  %s\n" "$*"; }
err()   { printf "${RED}✖${NC}  %s\n" "$*" >&2; }

# ── 0. preflight ─────────────────────────────────────────────────────────────
if ! command -v npm &>/dev/null; then
  err "npm is not installed.  Install Node.js ≥ 18 first: https://nodejs.org"
  exit 1
fi

# ── 1. install the plugin package globally ───────────────────────────────────
info "Installing ${PLUGIN_NAME} globally via npm …"
npm install -g "${PLUGIN_NAME}" 2>/dev/null || {
  warn "Global install failed — falling back to local install in current project."
  npm install --save-dev "${PLUGIN_NAME}"
}
ok "npm package installed."

# ── 2. patch opencode.json ───────────────────────────────────────────────────
# Find the nearest opencode.json (walk up to 3 levels).
CONFIG_PATH=""
for dir in . .. ../.. ../../..; do
  candidate="${dir}/${CONFIG_FILE}"
  if [[ -f "${candidate}" ]]; then
    CONFIG_PATH="${candidate}"
    break
  fi
done

if [[ -z "${CONFIG_PATH}" ]]; then
  warn "No ${CONFIG_FILE} found in the current directory tree."
  info "Creating a minimal ${CONFIG_FILE} in the current directory …"
  CONFIG_PATH="./${CONFIG_FILE}"
  cat > "${CONFIG_PATH}" <<'JSON'
{
  "$schema": "https://opencode.ai/config.json"
}
JSON
fi

# Use node (always available) to safely merge the plugin entry.
info "Adding '${PLUGIN_NAME}' to plugin list in ${CONFIG_PATH} …"
node -e "
const fs   = require('fs');
const path = '${CONFIG_PATH}';
const cfg  = JSON.parse(fs.readFileSync(path, 'utf8'));
if (!Array.isArray(cfg.plugin)) cfg.plugin = [];
if (!cfg.plugin.includes('${PLUGIN_NAME}')) {
  cfg.plugin.push('${PLUGIN_NAME}');
}
fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
"
ok "Plugin registered in ${CONFIG_PATH}."

# ── 3. done ──────────────────────────────────────────────────────────────────
echo ""
ok "OpenCode TeamMode installed successfully!"
echo ""
info "Next steps:"
echo "   1. Open your project in OpenCode Desktop."
echo "   2. Restart OpenCode to load the new plugin."
echo "   3. Try a command:  /team-plan  <your task>"
echo "                      /team-run   <your task>"
echo ""
info "Available agents:  @team  @architect  @implementer  @reviewer  @tester  @researcher"
info "Available commands: /team-plan  /team-implement  /team-review  /team-test  /team-research  /team-run"
echo ""
