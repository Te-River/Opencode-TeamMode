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
#
# On OpenCode 2.x the script takes a DIFFERENT path (install_v2 below):
#   `opencode plugin add` (first-party: installs AND writes the global config,
#   which is why steps 2 and 3 are obsolete there) → run the generator shipped
#   INSIDE the installed package (a 2.x plugin cannot create an agent, so the
#   six roles + six /team-* commands must be config files) → `default_agent:
#   "team"`, LAST. The 2.x path also does not set
#   OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: background sub-agents are native
#   there and the plugin forces `background: true` on every dispatch.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PKG="@te-river/opencode-team-mode@latest"
PKG_NAME="@te-river/opencode-team-mode"

echo ""
echo "OpenCode TeamMode Installer"
echo "=========================="
echo ""

# ── which host generation are we installing into? ───────────────────────────
# Read-only probes ONLY (`opencode --version`, `opencode plugin --help`); this
# script never asks the host to do anything but talk about itself.
# Anything that does not read as a version means the 1.18.x path, which is the
# behaviour this installer has always had — an unprobeable host is never left
# with a half-done 2.x install. A major of 2 or MORE takes install_v2: the one
# assumption in this branch, made because everything the 2.x path needs
# (`plugin add`, and a config dir the host reads agents/ and commands/ from)
# only gets more standard in later majors, and every step there fails loudly
# instead of quietly doing nothing.
OPENCODE_VERSION=""
OPENCODE_MAJOR=1
OPENCODE_WHY="opencode is not on PATH"
if command -v opencode >/dev/null 2>&1; then
  OPENCODE_WHY="'opencode --version' did not print a version we could read"
  OPENCODE_VERSION="$(opencode --version 2>&1 | tr -d '\r' | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)"
  if [ -n "$OPENCODE_VERSION" ]; then
    OPENCODE_WHY=""
    OPENCODE_MAJOR="${OPENCODE_VERSION%%.*}"
    case "$OPENCODE_MAJOR" in ''|*[!0-9]*) OPENCODE_MAJOR=1 ;; esac
  fi
fi
# The DESKTOP app does not put `opencode` on PATH — it ships the same server as a
# bundled binary under its resources directory, and `command -v opencode` fails on a
# machine that is running 2.0.16 right now. Falling back to "assume v1" there would
# install the wrong thing on the user's own machine, so probe the app itself:
#   opencode-cli.version  — a file whose whole content is the bundled server version
#   opencode-cli.exe      — the binary, asked the same read-only question
# (both paths verified against the installed desktop app; nothing is written)
if [ -z "$OPENCODE_VERSION" ]; then
  for CAND in \
    "$LOCALAPPDATA/Programs/@opencode-aidesktop/resources" \
    "$HOME/AppData/Local/Programs/@opencode-aidesktop/resources" \
    "$HOME/.local/share/opencode" \
    "$HOME/.opencode/bin"
  do
    [ -n "$CAND" ] || continue
    if [ -f "$CAND/opencode-cli.version" ]; then
      OPENCODE_VERSION="$(tr -d '\r\n' < "$CAND/opencode-cli.version" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)"
      if [ -n "$OPENCODE_VERSION" ]; then
        OPENCODE_WHY=""
        OPENCODE_MAJOR="${OPENCODE_VERSION%%.*}"
        case "$OPENCODE_MAJOR" in ''|*[!0-9]*) OPENCODE_MAJOR=1 ;; esac
        break
      fi
    fi
    for EXE in "$CAND/opencode-cli.exe" "$CAND/opencode-cli"; do
      [ -x "$EXE" ] || [ -f "$EXE" ] || continue
      OPENCODE_VERSION="$("$EXE" --version 2>&1 | tr -d '\r' | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)"
      if [ -n "$OPENCODE_VERSION" ]; then
        OPENCODE_WHY=""
        OPENCODE_MAJOR="${OPENCODE_VERSION%%.*}"
        case "$OPENCODE_MAJOR" in ''|*[!0-9]*) OPENCODE_MAJOR=1 ;; esac
        break 2
      fi
    done
  done
fi

# ── the OpenCode 2.x install path ───────────────────────────────────────────
# Why a separate branch (AGENTS.md, "The installer's v2 job is three things"):
#   * a 2.x plugin CANNOT create an agent, so the six roles and six /team-*
#     commands are config FILES the installer must write — generated from the
#     INSTALLED package by scripts/gen-v2-config.mjs, never hand-copied, or the
#     v2 prompts drift away from what v1 injects;
#   * `opencode plugin add` is first-party and writes the global config itself,
#     so v1's cache purge and npm re-resolve are NOT run here: purging would
#     delete a directory a 2.x host never loads from, and re-resolving would
#     fight the host's own install;
#   * `default_agent: "team"` is written LAST, after the role files are on disk
#     — a default naming a missing agent makes the host fall back to `build`
#     silently, with nothing on screen explaining why Team stopped. The value is
#     read back off the file afterwards, because a write is not an arrival;
#   * OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS is NOT set (v1-only hack).
install_v2() {
  # The target directory honours OPENCODE_CONFIG_DIR. Ignoring it was a footgun with
  # teeth: an agent that redirects the config dir (the documented way to test a plugin
  # without touching the user's machine) and leaves HOME alone would otherwise write
  # straight into the real global config — which is exactly what happened on 2026-09-26
  # while testing this branch. The resolved path is printed before anything is written,
  # because a silent install into the user's live config is indistinguishable from a
  # sandboxed one until something is overwritten.
  local cfg_dir="${OPENCODE_CONFIG_DIR:-${HOME}/.config/opencode}"
  local cfg="${cfg_dir}/opencode.jsonc"
  local legacy="${cfg_dir}/opencode.json"
  local node_js role cmd PLUGIN_ENTRY="" pkg_dir=""
  echo "→  2.x config target: ${cfg_dir}"
  if [ "$cfg_dir" = "${HOME}/.config/opencode" ]; then
    echo "   (this is your LIVE global config; to try the installer without touching it,"
    echo "    set OPENCODE_CONFIG_DIR=<dir> — the installer writes agents/, commands/ and"
    echo "    vendor/ under whichever directory it names)"
  fi


  echo ""
  echo "── OpenCode ${OPENCODE_VERSION:-?} detected: the 2.x path ──────────────────────"
  echo "   Deliberately NOT run here (both are 1.18.x machinery):"
  echo "     - the plugin-cache purge — 'plugin add' resolves the package itself, so a"
  echo "       v1 cache entry is a directory this host does not load from;"
  echo "     - the npm re-resolve in ${cfg_dir} — it would fight the host's install."
  echo ""

  # ── 1. the plugins entry (this IS the plugin install) ─────────────────────
  # Measured live on 2.0.16, in the order the claims below depend on:
  #   * `plugins` is PLURAL. The host's loader reads `config.plugins`; a 2.x host
  #     never reads the singular `plugin` key the 1.18.x config used — which is why
  #     an install that wrote there looked complete and did nothing.
  #   * an entry is INSTALLED BY THE HOST at startup:
  #       msg="loading plugin" id=@te-river/opencode-team-mode@latest
  #       entrypoint=file:///…/.cache/opencode/npm/@te-river/opencode-team-mode@latest/
  #                       <ts>/node_modules/@te-river/opencode-team-mode/dist/index.js
  #     so there is no cache for us to purge and nothing to pre-install.
  #   * `opencode plugin add <spec>` does exactly that write, into
  #     `~/.config/opencode/opencode.json`, and prints the file it touched.
  #   * opencode.json and opencode.jsonc are BOTH read and MERGED — measured with the
  #     spec in one file, then in the other, then in both. In the third case the host
  #     logged "loading plugin" TWICE for the same id: no dedupe. So the 1.18.x rule
  #     "jsonc overrides json, migrate the old file forward" is not merely unnecessary
  #     here, it is the double-registration bug: two personalities registering the
  #     same tools and the same hooks. Everything below writes ONE file, and the
  #     read-back counts Team entries across BOTH.
  #
  # TEAMMODE_LOCAL_DIR=<dir> is the development spelling: the tree is copied to
  # <cfg_dir>/vendor/team-mode and referenced as "./vendor/team-mode" (a relative path
  # the host resolves against the config file's own directory). A root `index.js` is
  # mandatory — for a directory whose entrypoint the host cannot resolve it skips the
  # plugin with NO message at all. It is also the only path that works today: 1.6.1 is
  # not published, and the published 1.6.0 exports no `setup`, so npm mode loads and
  # fails with "Plugin must export a default definition with an id and an effect or
  # setup function" (loudly, unlike the silent directory skip).
  local src_dir="${TEAMMODE_LOCAL_DIR:-}"
  PLUGIN_ENTRY="${PKG}"
  if [ -n "$src_dir" ]; then
    if [ ! -f "${src_dir}/index.js" ] || [ ! -f "${src_dir}/dist/index.js" ] ||
       [ ! -f "${src_dir}/scripts/gen-v2-config.mjs" ]; then
      echo "!  TEAMMODE_LOCAL_DIR=${src_dir} is missing index.js, dist/index.js or"
      echo "   scripts/gen-v2-config.mjs. A directory the host cannot resolve an"
      echo "   entrypoint for is skipped SILENTLY, so writing it into plugins would"
      echo "   report an install that is nothing. Build the tree first"
      echo "   (npm run build), or unset the variable to install from npm."
      exit 1
    fi
    mkdir -p "${cfg_dir}/vendor"
    rm -rf "${cfg_dir}/vendor/team-mode"
    cp -R "${src_dir%/}/." "${cfg_dir}/vendor/team-mode/" 2>/dev/null || {
      echo "!  Could not copy ${src_dir} to ${cfg_dir}/vendor/team-mode"; exit 1; }
    rm -rf "${cfg_dir}/vendor/team-mode/node_modules"
    PLUGIN_ENTRY="./vendor/team-mode"
    pkg_dir="${cfg_dir}/vendor/team-mode"
    echo "✔  Copied the package to ${cfg_dir}/vendor/team-mode (root index.js verified)"
  fi

  mkdir -p "$cfg_dir"
  # ONE mechanism for both modes, and the file written is opencode.jsonc — the file
  # every previous version of this installer used, so an upgrade edits the config the
  # user's entries already live in instead of splitting them over two. Why that matters
  # is measured, not assumed: opencode.json and opencode.jsonc are BOTH parsed and
  # MERGED, and the host's own dedupe in writePluginConfig only recognises the
  # identical string (element equals the spec, or an object whose package equals it) —
  # so one plugin written under two spellings in two files is LOADED TWICE (two
  # "loading plugin" lines for one id, no warning). Hence: ensure in the .jsonc, then
  # reclaim a Team entry of ours from the legacy .json if one is sitting there.
  #
  # `opencode plugin add` is deliberately NOT called. It cannot do either job: it
  # refuses a path ("Plugin target must be an npm registry package or Git package
  # specifier"), and in npm mode the host installs the package itself at startup
  # because of the entry we just wrote.
  local cfg="${cfg_dir}/opencode.jsonc"
  local other="$legacy"
  mkdir -p "$cfg_dir"
  if [ ! -s "$cfg" ]; then
    printf '{\n  "$schema": "https://opencode.ai/config.json"\n}\n' > "$cfg"
    echo "✔  Created ${cfg}"
  fi

  # The surgery lives in ONE file shared with install.ps1 (scripts/lib/config-surgery.cjs)
  # so the two installers cannot drift into two different definitions of "installed", and
  # so a `.cjs` name is under our control — a bare mktemp name has no extension, and Node
  # decides the module format by walking up for a package.json, so a Temp/package.json
  # with "type":"module" (present on this machine) makes it throw
  # ERR_UNKNOWN_FILE_EXTENSION and the install dies before it writes anything.
  local self_dir="" surgery=""
  case "${BASH_SOURCE[0]:-}" in
    */*|*\\*) self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)" ;;
  esac
  [ -n "$self_dir" ] && surgery="${self_dir}/lib/config-surgery.cjs"
  if [ ! -f "$surgery" ]; then
    echo "!  Cannot find ${surgery:-scripts/lib/config-surgery.cjs}."
    echo "   The 2.x installer is not a standalone file: it edits the config through that"
    echo "   script, and a copy fetched without it (curl | bash) cannot do the job. Run it"
    echo "   from a clone or from the installed package:"
    echo "     node <package>/scripts/gen-v2-config.mjs   and   bash <package>/scripts/install.sh"
    exit 1
  fi
  local node_js="$surgery"


  # Always run: in npm mode WE are the ones installing (the host auto-installs the
  # package because of this entry), so there is no "the host already wrote it" case
  # to skip. The script refuses to report success unless the value reads back.
  if ! node "${node_js}" "${cfg}" plugins "${PLUGIN_ENTRY}" "${other}"; then
    echo "!  The plugins entry is not in ${cfg}. Nothing further is attempted — without"
    echo "   the entry the host never loads the plugin, so a default agent naming our"
    echo "   roles would fall back to 'build' silently. Add it by hand:"
    echo "     \"plugins\": [\"${PLUGIN_ENTRY}\"]"
    exit 1
  fi

  # ── 2. the six roles and six commands, from the INSTALLED package ────────
  # Candidates only, no recursive search. The npm cache layout is the one the host
  # installed into in the live probe above (a timestamped wrapper whose EXECUTED code
  # is the nested node_modules copy), the v1 cache layouts stay as a fallback for a
  # machine that ran the 1.18.x installer, and the vendor copy is first because
  # TEAMMODE_LOCAL_DIR already put it there.
  local gen="" candidate
  for candidate in \
    "${pkg_dir}" \
    "${cfg_dir}/node_modules/${PKG_NAME}" \
    "${HOME}/.cache/opencode/npm/${PKG_NAME}@latest"/*/node_modules/${PKG_NAME} \
    "${HOME}/.cache/opencode/packages/${PKG_NAME}@latest/node_modules/${PKG_NAME}" \
    "${HOME}/.cache/opencode/packages/@te_river+opencode-team-mode@latest/node_modules/${PKG_NAME}"
  do
    if [ -f "${candidate}/scripts/gen-v2-config.mjs" ] && [ -f "${candidate}/dist/agents.js" ]; then
      pkg_dir="$candidate"; gen="${candidate}/scripts/gen-v2-config.mjs"; break
    fi
  done

  if [ -z "$gen" ]; then
    echo "!  Could not find a package tree, so the roles/commands cannot be generated."
    echo "   Looked for scripts/gen-v2-config.mjs + dist/agents.js under:"
    for candidate in \
      "${cfg_dir}/vendor/team-mode" \
      "${cfg_dir}/node_modules/${PKG_NAME}" \
      "${HOME}/.cache/opencode/npm/${PKG_NAME}@latest/*/node_modules/${PKG_NAME}" \
      "${HOME}/.cache/opencode/packages/${PKG_NAME}@latest/node_modules/${PKG_NAME}" \
      "${HOME}/.cache/opencode/packages/@te_river+opencode-team-mode@latest/node_modules/${PKG_NAME}"
    do
      echo "     - ${candidate}"

    done
    echo "   Next step: install the package where the host reads it, then re-run this script:"
    echo "     opencode plugin add ${PKG}"
    echo "   (or: cd ${cfg_dir} && npm install ${PKG} --no-fund --no-audit)"
    echo "   Nothing was set as the default agent — a default is only safe once the roles exist."
    exit 1
  fi
  echo "↻  Generating agents/ + commands/ from ${pkg_dir} ..."
  if ! node "${gen}" --dir "${cfg_dir}"; then
    echo "!  The generator failed (its own output is above). Common cause: the package's"
    echo "   prompts and its gen-v2-config.mjs are from different versions — the fork table"
    echo "   throws rather than shipping a v2 model a rule about a tool it cannot call."
    echo "   Nothing was set as the default agent."
    exit 1
  fi

  # ── 3. verify the twelve files actually arrived (the generator printing a
  #        path is the claim; the file on disk is the evidence) ───────────────
  local roles_missing="" cmds_missing=""
  for role in team architect implementer reviewer tester researcher; do
    if [ -f "${cfg_dir}/agents/${role}.md" ]; then
      echo "✔  role    ${role}"
    else
      roles_missing="${roles_missing} ${role}"
      echo "!  MISSING role ${cfg_dir}/agents/${role}.md"
    fi
  done
  for cmd in team-plan team-implement team-review team-test team-research team-run; do
    if [ -f "${cfg_dir}/commands/${cmd}.md" ]; then
      echo "✔  command ${cmd}"
    else
      cmds_missing="${cmds_missing} ${cmd}"
      echo "!  MISSING command ${cfg_dir}/commands/${cmd}.md"
    fi
  done
  if [ -n "$cmds_missing" ]; then
    echo "!  Commands missing:${cmds_missing} — the roles still work; re-run the generator"
    echo "   after 'opencode plugin update ${PKG_NAME}' if the list stays short."
  fi

  if [ -n "$roles_missing" ]; then
    echo "!  Roles missing:${roles_missing} — refusing to write default_agent."
    echo "   A default naming an agent the host cannot find makes it fall back to 'build'"
    echo "   with no explanation on screen. Re-run this installer once the six role files"
    echo "   exist under ${cfg_dir}/agents/."
    exit 1
  fi

  # ── 4. default_agent, LAST, and read back ─────────────────────────────────
  echo "↻  Setting default_agent = team (last, because the roles are on disk now) ..."
  if ! node "${node_js}" "${cfg}" default-agent team; then
    echo "!  Could not set default_agent. Add it by hand at the top level of ${cfg}:"
    echo "     \"default_agent\": \"team\""
    exit 1
  fi

  # ── 5. the 2.x checklist ──────────────────────────────────────────────────
  local cmd_count
  cmd_count="$(find "${cfg_dir}/commands" -maxdepth 1 -name 'team-*.md' 2>/dev/null | grep -c . || true)"
  echo ""
  echo "── 2.x checklist ─────────────────────────────────────────────────────────────"
  echo "   roles    : 6/6 files under ${cfg_dir}/agents/"
  echo "   commands : ${cmd_count:-0}/6 found under ${cfg_dir}/commands/team-*.md (a hand-written"
  echo "              file the generator refused to overwrite would show short here)"
  echo "   default  : default_agent = team, read back from ${cfg}"
  echo "   env vars : NONE needed. OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS is a 1.18.x"
  echo "              workaround; on 2.x sub-agents are background natively and the plugin"
  echo "              forces background:true on every dispatch, so setting it changes"
  echo "              nothing here and only makes the picture harder to read."
  if [ -n "${OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS:-}" ]; then
    echo "              It IS set in your environment (that is what 'changes nothing' refers"
    echo "              to) — unset it when convenient; it matters only to a 1.18.x host."
  fi
  echo ""
  echo "✔  Done! Restart OpenCode (or run: opencode reload) to activate."
  echo "   Then check, in this order:"
  echo "     1. opencode agents            → team, architect, implementer, reviewer,"
  echo "                                     tester, researcher"
  echo "     2. a NEW session is Team      → ask it to run tm_stats and read 启动与人格"
  echo "                                     (a default_agent does not move an existing session)"
  echo "     3. tm_ledger {action:\"add\",text:\"smoke\"} → an id + 已写入 ctx.storage"
  echo ""
}

if [ "$OPENCODE_MAJOR" -ge 2 ]; then
  install_v2
  exit 0
fi
if [ -n "$OPENCODE_WHY" ]; then
  echo "ℹ  ${OPENCODE_WHY} — taking the 1.18.x path (the one this installer always had)."
else
  echo "ℹ  OpenCode ${OPENCODE_VERSION} detected — taking the 1.18.x path."
fi

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
  # Same .cjs reason as the 2.x path above: a bare mktemp name inherits whatever module
  # format a package.json in an ancestor directory declares, and CommonJS then throws
  # ERR_UNKNOWN_FILE_EXTENSION.
  NODE_SCRIPT="$(mktemp -d "${TMPDIR:-/tmp}/tm-surgery-XXXXXX")/surgery.cjs"
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
