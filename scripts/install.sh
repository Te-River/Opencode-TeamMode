#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# OpenCode TeamMode — one-click installer (idempotent: re-run to UPDATE)
#
# Usage:
#   curl -fsSL https://ghproxy.net/https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/scripts/install.sh | bash
#
# What it does:
#   1. Adds @te-river/opencode-team-mode@latest to ~/.config/opencode/opencode.jsonc
#      (falls back to opencode.json when only that one exists).
#   2. Purges the stale plugin cache — OpenCode caches plugins by spec string
#      under packages/ in the cache dir, possibly NESTED inside a @te-river/
#      scope directory (scoped layout: packages/@te-river/opencode-team-mode@latest)
#      or flattened (packages/@te_river+opencode-team-mode@latest), so the purge
#      RECURSES to catch both layouts. OpenCode NEVER re-resolves @latest on its
#      own, so a re-run is the update.
#   3. Re-resolves an npm-installed copy inside the config dir (package-lock
#      pins would otherwise keep the old version).
#   Restart OpenCode afterwards.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PKG="@te-river/opencode-team-mode@latest"

echo ""
echo "OpenCode TeamMode Installer"
echo "=========================="
echo ""

# ── patch config ────────────────────────────────────────────────────────────
# opencode.jsonc is the canonical name and OVERRIDES opencode.json when both
# exist — so we ALWAYS target the .jsonc: patch it when present, and when only
# an opencode.json exists, migrate its content into a new opencode.jsonc first
# (writing the .json instead would risk our entry being shadowed).
CFG_DIR="${HOME}/.config/opencode"
CFG="${CFG_DIR}/opencode.jsonc"
LEGACY="${CFG_DIR}/opencode.json"
mkdir -p "$CFG_DIR"
if [ ! -f "$CFG" ] && [ -f "$LEGACY" ]; then
  cp "$LEGACY" "$CFG"
  echo "ℹ  Migrated opencode.json → opencode.jsonc (jsonc takes precedence; the original .json is left untouched)"
fi

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
NODEJS
  trap "rm -f ${NODE_SCRIPT}" EXIT
  node "${NODE_SCRIPT}" "${CFG}" "${PKG}"
fi

# ── update: purge the stale plugin cache (OpenCode never re-resolves @latest) ──
# OpenCode loads the plugin from THIS cache, NOT from ~/.config/opencode/node_modules.
# Two cache layouts exist under packages/ — scoped:
# packages/@te-river/opencode-team-mode@latest, and flat:
# packages/@te_river+opencode-team-mode@latest. A top-level glob never sees the
# scoped copy nested below @te-river/ → the upgrade silently keeps loading the old
# cached version. Recurse so BOTH layouts match; the @te-river/ scope dir itself
# is left in place.
CACHE_ROOT="${HOME}/.cache/opencode/packages"
if [ -d "$CACHE_ROOT" ]; then
  # -prune stops find descending into a match, so an inner
  # node_modules/@te-river/opencode-team-mode is never listed — the parent rm
  # already removed it. `|| true` absorbs find ERROR codes (e.g. permission
  # denied) under set -e; a no-match find already exits 0 on its own.
  STALE=$(find "$CACHE_ROOT" -type d -name '*opencode-team-mode*' -prune 2>/dev/null || true)
  if [ -n "$STALE" ]; then
    while IFS= read -r stale_dir; do
      [ -d "$stale_dir" ] || continue
      rm -rf "$stale_dir"
    done <<< "$STALE"
  fi
  # Re-enumerate AFTER deleting (symmetric with install.ps1): a survivor means
  # the rm genuinely failed -> warn, never false-green. Captured via `|| true`
  # rather than `find | grep -q`, whose early-exit + pipefail could flip the
  # check's exit status on a real leftover.
  LEFT=$(find "$CACHE_ROOT" -type d -name '*opencode-team-mode*' -prune 2>/dev/null || true)
  if [ -n "$LEFT" ]; then
    echo "!  Could not fully purge (quit OpenCode and re-run):"
    echo "$LEFT"
  else
    echo "✔  Purged stale plugin cache"
  fi
fi

# ── update: npm-installed copy in the config dir? re-resolve its pinned lock ──
if [ -d "${CFG_DIR}/node_modules/@te-river/opencode-team-mode" ]; then
  echo "↻  Re-resolving npm-installed plugin in ${CFG_DIR} ..."
  if (cd "${CFG_DIR}" && npm install "@te-river/opencode-team-mode@latest" --no-fund --no-audit); then
    echo "✔  npm copy updated"
  else
    echo "!  npm re-resolve failed (non-fatal — cache purge + restart is usually enough)"
  fi
fi

# ── the host's VISIBLE sub-agent: OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS ─
# Same reasoning as install.ps1: `task { background: true }` is the only
# sub-agent OpenCode can show (its card links to the live child session, it
# does not block, and the host wakes the parent with the result), and the flag
# is read from the HOST process environment, so a plugin cannot set it for
# itself. Opt out with TEAMMODE_SKIP_BACKGROUND_SUBAGENTS=1.
BG_FLAG="OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS"
case "$(printf '%s' "${TEAMMODE_SKIP_BACKGROUND_SUBAGENTS:-}" | tr 'A-Z' 'a-z')" in
  1|true|yes|on)
    echo "-  Left $BG_FLAG alone (opt-out). Re-run without it to enable the visible background sub-agent."
    ;;
  *)
    if [ "$(uname -s)" = "Darwin" ] && command -v launchctl >/dev/null 2>&1; then
      # launchctl reaches GUI apps launched from the Finder/Dock for THIS login
      # session; it does not survive a logout, so the line below says so.
      if launchctl setenv "$BG_FLAG" true 2>/dev/null; then
        echo "✔  $BG_FLAG=true set for this login session (launchctl — re-run this installer after a reboot)"
      else
        echo "!  launchctl setenv failed — set it yourself before launching OpenCode:"
        echo "   export $BG_FLAG=true"
      fi
    elif command -v systemctl >/dev/null 2>&1 && [ -n "${XDG_RUNTIME_DIR:-}" ]; then
      if systemctl --user set-environment "$BG_FLAG=true" 2>/dev/null; then
        echo "✔  $BG_FLAG=true set for this systemd user session (re-run after a reboot to re-apply)"
      else
        echo "!  systemctl --user set-environment failed — export $BG_FLAG=true before launching OpenCode"
      fi
    else
      echo "!  No session-scoped mechanism found — export $BG_FLAG=true before launching OpenCode:"
      echo "   export $BG_FLAG=true"
    fi
    ;;
esac

echo ""
echo "✔  Done! Restart OpenCode Desktop to activate."
echo "   Self-check after the restart: ask the agent to run tm_stats and look for"
echo "   the row '宿主后台 task 注入' — it proves which plugin build loaded and whether"
echo "   the background sub-agent channel is live."
echo ""
