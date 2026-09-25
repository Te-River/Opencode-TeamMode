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
  local cfg_dir="${HOME}/.config/opencode"
  local cfg="${cfg_dir}/opencode.jsonc"
  local legacy="${cfg_dir}/opencode.json"
  local node_js role cmd

  echo ""
  echo "── OpenCode ${OPENCODE_VERSION:-?} detected: the 2.x path ──────────────────────"
  echo "   Deliberately NOT run here (both are 1.18.x machinery):"
  echo "     - the plugin-cache purge — 'plugin add' resolves the package itself, so a"
  echo "       v1 cache entry is a directory this host does not load from;"
  echo "     - the npm re-resolve in ${cfg_dir} — it would fight the host's install."
  echo ""

  # ── 1. the plugin package ─────────────────────────────────────────────────
  # The probe is a text grep, so either answer is survivable: a false positive
  # runs `plugin add`, whose failure falls through to the config edit below; a
  # false negative does the config edit, which is what v1 has always done.
  local have_add=0 via_add=0 plugin_help=""
  if command -v opencode >/dev/null 2>&1; then
    plugin_help="$(opencode plugin --help 2>&1 | head -c 4000 || true)"
  fi
  if grep -qE '(^|[[:space:]])add([[:space:]<]|$)' <<<"$plugin_help"; then
    have_add=1
  fi

  if [ "$have_add" = 1 ]; then
    echo "↻  opencode plugin add ${PKG} ..."
    if opencode plugin add "$PKG"; then
      via_add=1
      echo "✔  Installed via 'opencode plugin add' (the host wrote the global config entry)"
    else
      echo "!  'opencode plugin add' failed — the host's own message is above."
      echo "   Falling back to editing the config entry by hand."
    fi
  else
    echo "ℹ  No 'opencode plugin add' subcommand found — editing the config entry instead."
  fi

  # The config FILE is where default_agent goes, so it must be the one that
  # wins: .jsonc takes precedence over a legacy .json, hence the same migration
  # rule the v1 path uses (and never writing into the .json, which would be
  # shadowed). Runs even on the plugin-add path: if the host wrote only a
  # .json, this copy is what keeps our later .jsonc from shadowing it.
  mkdir -p "$cfg_dir"
  if [ ! -f "$cfg" ] && [ -f "$legacy" ]; then
    cp "$legacy" "$cfg"
    echo "ℹ  Migrated opencode.json → opencode.jsonc (jsonc takes precedence; the original .json is left untouched)"
  fi
  if [ ! -f "$cfg" ]; then
    cat > "$cfg" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "plugin": [
    "${PKG}"
  ]
}
EOF
    echo "✔  Created ${cfg}"
  fi

  node_js="$(mktemp)"
  trap "rm -f ${node_js}" EXIT
  cat > "${node_js}" <<'NODEJS2'
// 2.x config surgery: adds the plugin entry and/or sets default_agent, then
// READS THE VALUE BACK from disk before reporting success. Comments are masked
// to spaces at identical offsets, so a commented-out key can never be mistaken
// for a live one (the read-back would pass while the config said nothing).
// usage: node this.js <file> <plugin|default-agent> <value>
const fs = require("fs");
const [file, mode, value] = process.argv.slice(2);
if (!file || !mode || !value) {
  console.error("ERR usage: node this.js <file> <plugin|default-agent> <value>");
  process.exit(1);
}

const mask = (s) => {
  let out = "", i = 0, inStr = false, esc = false;
  while (i < s.length) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false;
      i++; continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === "/" && s[i + 1] === "/") { while (i < s.length && s[i] !== "\n") { out += " "; i++; } continue; }
    if (c === "/" && s[i + 1] === "*") {
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) { out += s[i] === "\n" ? "\n" : " "; i++; }
      out += "  "; i += 2; continue;
    }
    out += c; i++;
  }
  return out;
};

const lineOf = (s, idx) => s.slice(0, idx).split("\n").length;
let src = fs.readFileSync(file, "utf8");
const open = mask(src).indexOf("{");
if (open < 0) { console.error("ERR no top-level object in " + file); process.exit(1); }
const nextNonWs = (s, i) => { while (i < s.length && /\s/.test(s[i])) i++; return i; };
/** insert one member right after the object's opening brace (top level by
 *  definition: in a JSONC config the first '{' IS the document's own). */
const insertMember = (s, member) => {
  const after = nextNonWs(s, open + 1);
  const comma = s[after] === "}" ? "" : ",";   // an empty object takes none
  return s.slice(0, open + 1) + "\n  " + member + comma + s.slice(open + 1);
};
const lineNo = (s, idx) => " (line " + lineOf(s, idx) + " of " + file + ")";

if (mode === "plugin") {
  if (src.includes('"' + value + '"')) {
    console.log("OK  plugin entry already present");
  } else {
    const m = /"plugin"\s*:\s*\[/.exec(mask(src));
    let out;
    if (!m) {
      out = insertMember(src, '"plugin": [\n    "' + value + '"\n  ]');
    } else {
      // walk to the array's own closing bracket; strings are masked, so the
      // scan sees structure only.
      const masked = mask(src);
      let i = m.index + m[0].length, depth = 1, lastValEnd = -1;
      while (i < masked.length) {
        const c = masked[i];
        if (c === '"') {
          const j = masked.indexOf('"', i + 1);
          if (j < 0) break;
          i = j + 1;
          if (depth === 1) lastValEnd = i;
          continue;
        }
        if (c === "[" || c === "{") depth++;
        else if (c === "]" || c === "}") {
          depth--;
          if (depth === 0) break;
          if (depth === 1) lastValEnd = i + 1;
        }
        i++;
      }
      if (depth !== 0) { console.error("ERR unbalanced plugin array in " + file); process.exit(1); }
      const at = lastValEnd >= 0 ? lastValEnd : m.index + m[0].length;
      const head = lastValEnd >= 0 ? ",\n    \"" : "\n    \"";
      out = src.slice(0, at) + head + value + "\"" + src.slice(at);
    }
    fs.writeFileSync(file, out);
    console.log("OK  plugin entry added");
  }
} else if (mode === "default-agent") {
  const lit = JSON.stringify(value);
  const re = /"default_agent"(\s*:\s*)("(?:[^"\\]|\\.)*"|[^,}\s][^,}\n]*)/;
  const m = re.exec(mask(src));
  if (m) {
    const vStart = m.index + m[0].length - m[2].length;
    if (m[2].trim() === lit) {
      console.log("OK  default_agent already " + lit + lineNo(src, m.index));
    } else {
      fs.writeFileSync(file, src.slice(0, vStart) + lit + src.slice(vStart + m[2].length));
      console.log("OK  default_agent rewritten (was " + m[2].trim() + ")");
    }
  } else {
    fs.writeFileSync(file, insertMember(src, '"default_agent": ' + lit));
    console.log("OK  default_agent added");
  }
  // Read it back — a fresh read of the file from disk, comments masked again.
  src = fs.readFileSync(file, "utf8");
  const chk = re.exec(mask(src));
  const got = chk ? chk[2].trim() : null;
  if (got !== lit) {
    console.error("ERR default_agent read back as " + (got === null ? "(key absent)" : got) + ", not " + lit);
    console.error("    Add it by hand at the top level of " + file + ":  \"default_agent\": " + lit);
    process.exit(1);
  }
  console.log("OK  read back: " + lit + lineNo(src, chk.index));
} else {
  console.error("ERR unknown mode '" + mode + "'");
  process.exit(1);
}
NODEJS2

  if [ "$via_add" = 0 ]; then
    node "${node_js}" "${cfg}" plugin "${PKG}"
  fi

  # ── 2. the six roles and six commands, from the INSTALLED package ────────
  # Candidates only, no recursive search: the documented one plus the v1 cache
  # layouts (whose executed code is the NESTED node_modules copy), each checked
  # for BOTH halves the generator imports.
  local gen="" pkg_dir="" candidate
  for candidate in \
    "${cfg_dir}/node_modules/${PKG_NAME}" \
    "${HOME}/.cache/opencode/packages/${PKG_NAME}@latest/node_modules/${PKG_NAME}" \
    "${HOME}/.cache/opencode/packages/@te_river+opencode-team-mode@latest/node_modules/${PKG_NAME}"
  do
    if [ -f "${candidate}/scripts/gen-v2-config.mjs" ] && [ -f "${candidate}/dist/agents.js" ]; then
      pkg_dir="$candidate"; gen="${candidate}/scripts/gen-v2-config.mjs"; break
    fi
  done

  if [ -z "$gen" ]; then
    echo "!  Could not find the installed package, so the roles/commands cannot be generated."
    echo "   Looked for scripts/gen-v2-config.mjs + dist/agents.js under:"
    for candidate in \
      "${cfg_dir}/node_modules/${PKG_NAME}" \
      "${HOME}/.cache/opencode/packages/${PKG_NAME}@latest/node_modules/${PKG_NAME}" \
      "${HOME}/.cache/opencode/packages/@te_river+opencode-team-mode@latest/node_modules/${PKG_NAME}"
    do
      echo "     - ${candidate}"
    done
    echo "   Next step: install the package where the host reads it, then re-run this script:"
    echo "     opencode plugin add ${PKG}"
    echo "   (or: cd ${cfg_dir} && npm install ${PKG} --no-fund --no-audit)"
    echo "   Nothing was set as the default agent — a default is only safe once the roles exist."
    rm -f "${node_js}"
    exit 1
  fi
  echo "↻  Generating agents/ + commands/ from ${pkg_dir} ..."
  if ! node "${gen}" --dir "${cfg_dir}"; then
    echo "!  The generator failed (its own output is above). Common cause: the package's"
    echo "   prompts and its gen-v2-config.mjs are from different versions — the fork table"
    echo "   throws rather than shipping a v2 model a rule about a tool it cannot call."
    echo "   Nothing was set as the default agent."
    rm -f "${node_js}"
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
    rm -f "${node_js}"
    exit 1
  fi

  # ── 4. default_agent, LAST, and read back ─────────────────────────────────
  echo "↻  Setting default_agent = team (last, because the roles are on disk now) ..."
  if ! node "${node_js}" "${cfg}" default-agent team; then
    echo "!  Could not set default_agent. Add it by hand at the top level of ${cfg}:"
    echo "     \"default_agent\": \"team\""
    rm -f "${node_js}"
    exit 1
  fi
  rm -f "${node_js}"
  trap - EXIT

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
