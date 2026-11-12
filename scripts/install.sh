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

# --computer-use is OFF by default and is not part of the plugin install: it wires the
# optional `computeruse` MCP server (step 5 of install_v2). The `curl | bash` path cannot
# pass arguments, so TEAMMODE_COMPUTER_USE=1 is the equivalent for a piped run — the same
# shape TEAMMODE_SKIP_BACKGROUND_SUBAGENTS already uses.
COMPUTER_USE=0
CU_WHEEL_ARG=""
CU_SHA_ARG=""
# Reclaims the per-version release directories without installing anything. The Windows
# front-end has the same switch (-ComputerUseReclaim); both do ONLY the cleanup, so a
# cleanup run writes zero config bytes.
CU_RECLAIM=0
while [ $# -gt 0 ]; do
  case "$1" in
    --computer-use) COMPUTER_USE=1 ;;
    --computer-use-wheel) shift; CU_WHEEL_ARG="${1:-}" ;;
    --computer-use-wheel-sha256) shift; CU_SHA_ARG="${1:-}" ;;
    --computer-use-reclaim) CU_RECLAIM=1 ;;
  esac
  shift
done
case "$(printf '%s' "${TEAMMODE_COMPUTER_USE:-}" | tr 'A-Z' 'a-z')" in
  1|true|yes|on) COMPUTER_USE=1 ;;
esac

# ── the optional computer-use server (a GitHub Release ASSET, not an npm artifact) ──
# Same two constants as install.ps1, and the same rule: the hash below is the released
# 0.0.1 asset's, and a wheel whose hash does not match is never installed — an unverified
# binary is exactly what that constant exists to prevent. Publishing a new asset and
# filling this in belong in the SAME commit; a stale hash fails closed.
CU_VERSION="0.0.7"
CU_WHEEL_SHA256="53dc835e864a5346ad31e18bde780d802d7d074fe7cbd2ac0929be8e936a5887"
CU_RELEASE_URL="https://github.com/Te-River/Opencode-TeamMode/releases/download/computeruse-v${CU_VERSION}/computeruse_mcp-${CU_VERSION}-py3-none-any.whl"

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
# ── the release layout that made the upgrade ONE restart instead of two ─────────────
# Same skeleton as install.ps1's CU-* helpers, same files on disk:
#
#   <releases>/current.json                    which version the mcp entry points at
#   <releases>/<version>/receipt.json          that dir passed --selftest, with the wheel hash
#   <releases>/<version>/computeruse-mcp/…     the venv `uv tool install` wrote (dist name, fixed)
#   <releases>/<version>/bin/                  uv's shim dir, kept INSIDE the version dir
#
# `uv tool install` writes into `<UV_TOOL_DIR>/<dist name>/` and replaces the console script
# in place, so upgrading a server the host is still running asks the OS to overwrite a
# loaded image — on Windows `os error 32`, which is why the old procedure was TWO restarts.
# The dist-name directory is not ours to rename (it comes from the wheel's metadata, and uv
# reads name/version/tag out of the FILENAME too), so what carries the version is its
# PARENT: UV_TOOL_DIR becomes <releases>/<version>, the new version lands where nothing is
# looking, and the upgrade is the single edit that repoints `mcp.computeruse.command`.
#
# On POSIX a running executable is not locked, so this layout is not strictly needed there —
# it is used anyway, because the two front-ends must not disagree about where a version
# lives, what the entry points at, or how the old directories are reclaimed.
cu_releases_root() {
  if [ -n "${TEAMMODE_CU_RELEASE_DIR:-}" ]; then printf '%s' "$TEAMMODE_CU_RELEASE_DIR"; return; fi
  local base="${XDG_DATA_HOME:-${HOME}/.local/share}"
  printf '%s' "${base}/te-river/computeruse/releases"
}

# Reads one flat string key out of the installer's own runtime JSON. node is already a hard
# requirement of the 2.x path (config-surgery.cjs), so this adds no dependency. A missing
# file or an unparseable one returns 1 — the CALLERS decide what an unreadable record means,
# and for the reclaim pass "unreadable" always means "keep".
cu_json_get() {
  [ -f "$1" ] || return 1
  node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=j[process.argv[2]];if(v==null)process.exit(1);process.stdout.write(String(v))}catch(e){process.exit(1)}' "$1" "$2" 2>/dev/null
}

cu_json_write() {
  local file="$1"; shift
  node -e 'const fs=require("fs");const file=process.argv[1];const o={};for(let i=2;i<process.argv.length;i+=2)o[process.argv[i]]=String(process.argv[i+1]);fs.writeFileSync(file,JSON.stringify(o,null,2)+"\n")' "$file" "$@"
}

# The console script inside one version directory. The venv is a CHILD of the version dir
# (uv names it after the distribution — measured `computeruse-mcp`, not `computeruse`), so
# children are scanned before the version dir itself, which only ever holds uv's shim.
cu_find_exe() {
  local vd="$1" c
  [ -d "$vd" ] || return 1
  for c in "$vd"/*/Scripts/computeruse.exe "$vd"/*/bin/computeruse "$vd"/*/Scripts/computeruse \
           "$vd/Scripts/computeruse.exe" "$vd/bin/computeruse" "$vd/Scripts/computeruse"; do
    if [ -f "$c" ]; then printf '%s' "$c"; return 0; fi
  done
  return 1
}

# THREE-way verdict, because "a process was hit", "nothing matched" and "we could not look"
# are three different sentences, and the third one may not borrow the first one's words:
#   0 = HIT — a running process names this directory (CU_INUSE_PID + CU_INUSE_REASON set)
#   1 = PROVABLY IDLE — `ps` answered with lines and none of them names the directory
#   2 = NO EVIDENCE — no `ps` on PATH, a `ps` that FAILED, or a `ps` that answered with
#       nothing at all. CU_INUSE_REASON names which one it was.
# Every caller keeps on 0 AND 2 and moves only on 1: the conservative direction is UNCHANGED
# (this is install.ps1's InUse=true with a reason that says "no hit evidence"), and what got
# fixed is the wording — a keep that came from not being able to look used to be printed as
# "有进程从这个目录跑着", which is a claim about a process nobody ever hit. The old shape also
# leaked `set -o pipefail`: a `ps` that failed fell through to "not in use" and the directory
# was MOVED — the fail-open this function's header always said it did not do.
# The needle travels through the ENVIRONMENT because a grep/awk command line carrying the
# path would match ITSELF in `ps` output and every directory would look busy forever.
cu_dir_in_use() {
  local dir="$1" out="" rc=0 hit=""
  CU_INUSE_REASON=""
  CU_INUSE_PID=""
  [ -d "$dir" ] || return 1
  if ! command -v ps >/dev/null 2>&1; then
    CU_INUSE_REASON="本机没有 ps 可用：未获得命中证据，保守保留"
    return 2
  fi
  rc=0
  out="$(ps -A -o pid=,args= 2>/dev/null)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    CU_INUSE_REASON="ps 查询失败（exit ${rc}）：未获得命中证据，保守保留"
    return 2
  fi
  if [ -z "$out" ]; then
    CU_INUSE_REASON="ps 返回空输出（列不到任何进程）：未获得命中证据，保守保留"
    return 2
  fi
  hit="$(printf '%s\n' "$out" | CU_NEEDLE="$dir" awk '
    BEGIN { d = tolower(ENVIRON["CU_NEEDLE"]) }
    { if (h == "" && index(tolower($0), d) > 0) h = $1 }
    END { if (h != "") print h }')"
  if [ -n "$hit" ]; then
    CU_INUSE_PID="$hit"
    CU_INUSE_REASON="有进程从这个目录跑着：命令行命中 pid ${hit}"
    return 0
  fi
  return 1
}

# Does either global config file still name this directory? Raw text, case-insensitive,
# because the stored spelling is JSON-escaped. An unreadable file answers "mentioned":
# not being able to rule it out is not evidence that deleting it is safe.
cu_config_mentions() {
  local dir="$1"; shift
  local f
  for f in "$@"; do
    [ -n "$f" ] || continue
    [ -e "$f" ] || continue
    if CU_NEEDLE="$dir" awk '
      BEGIN { d = tolower(ENVIRON["CU_NEEDLE"]) }
      { if (index(tolower($0), d) > 0) found = 1 }
      END { exit found ? 0 : 1 }' "$f" 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

# Keeps what the entry points at, what either config still names, and what anything is
# running from; the rest is MOVED ASIDE into <root>/.pending-delete and only then deleted.
# The move is not ceremony: `rm -rf` on a tree something has open deletes what it can reach
# and fails on the rest, leaving a HALF-DELETED release behind. Here `mv` renames INSIDE the
# same parent (the pending dir lives in the releases root), so it is a same-directory
# rename — all-or-nothing. install.ps1 has to reach for [IO.Directory]::Move for the same
# guarantee, because PowerShell's Move-Item falls back to copy-then-delete when the rename is
# refused, and that fallback measured its way into this design. Every skip prints
# its reason. Nothing here kills a process, and nothing here touches uv's own tool dir.
# usage: cu_reclaim_releases <root> <current-version> <cfg file> [more cfg files…]
# An EMPTY <current-version> (no current.json to read, or one that does not answer) keeps
# EVERYTHING, the already-moved-aside entries included: not being able to prove which
# version the entry points at is not evidence that deleting anything is safe — so this is
# the rule, and the console line says exactly this.
cu_reclaim_releases() {
  local root="$1" cur="$2"; shift 2
  [ -d "$root" ] || return 0
  if [ -z "$cur" ]; then
    echo "   没有 current.json：证明不了条目指向哪一版，本次一个目录都不动（全部保留，.pending-delete 也不清）"
    return 0
  fi
  local pending="${root}/.pending-delete"
  # Every tree MOVED ASIDE by this pass, as an ARRAY compared by whole-element membership.
  # The old string form ("|a|b" against a case pattern) did not do that job: the unquoted |
  # between the two quoted groups parsed as ALTERNATION, so the guard matched only the LAST
  # moved entry and a release this pass had just moved aside was deleted by this pass — the
  # one outcome the two-phase design forbids (install.ps1 compares $movedNow with
  # -contains, and this now says the same thing in bash).
  local moved_now=()
  local d name stamped name_ok moved_hit m rc_use
  for d in "$root"/*/; do
    [ -d "$d" ] || continue
    d="${d%/}"; name="${d##*/}"
    if [ "$name" = ".pending-delete" ]; then continue; fi
    # The SAME ANCHORED filter as install.ps1 ('^[0-9][A-Za-z0-9._+-]*$'): the whole name
    # must be version-shaped. A bare [0-9]* made "0.0.5 (old)" a reclaim candidate here
    # while the Windows front-end refused to touch it — two installers disagreeing about
    # the same directory is the drift this pair of scripts exists to prevent.
    name_ok=0
    case "$name" in
      [0-9]*) case "$name" in *[!A-Za-z0-9._+-]*) ;; *) name_ok=1 ;; esac ;;
    esac
    if [ "$name_ok" != "1" ]; then
      echo "   keep    ${name} — 不是版本号目录，不是这套机制装的"; continue
    fi
    if [ -n "$cur" ] && [ "$name" = "$cur" ]; then
      echo "   keep    $d — current.json：MCP 条目就指向它"; continue
    fi
    if cu_config_mentions "$d" "$@"; then
      echo "   keep    $d — 全局配置里仍然出现这个路径，不能断定条目不在用它"; continue
    fi
    # 0 (a process was hit) and 2 (no evidence to look at) both KEEP; only 1 (provably idle)
    # moves. The reason clause comes from the verdict itself, so a keep without hit evidence
    # can never be printed as "有进程从这个目录跑着".
    rc_use=0; cu_dir_in_use "$d" || rc_use=$?
    if [ "$rc_use" -ne 1 ]; then
      echo "   keep    $d — ${CU_INUSE_REASON}（不杀进程，下次安装再来回收）"; continue
    fi
    if [ ! -d "$pending" ]; then mkdir -p "$pending" 2>/dev/null || true; fi
    stamped="${pending}/${name}.$(date -u +%Y%m%d-%H%M%S)"
    # `mv` here is a same-filesystem rename (the pending dir lives inside the releases root),
    # so it is all-or-nothing: install.ps1 uses [IO.Directory]::Move for exactly this reason,
    # because Move-Item falls back to copy-then-delete and leaves a held release half-moved.
    if mv "$d" "$stamped" 2>/dev/null; then
      moved_now+=("$stamped")
      echo "   move    $d → ${stamped}"
    else
      echo "   keep    $d — 挪不动：里面有文件被打开了"
    fi
  done
  [ -d "$pending" ] || return 0
  # A tree this pass moved aside is NOT deleted by this pass: the rename proves nothing about
  # the files inside it, and half-deleting a live release is the one outcome the two-phase
  # design exists to prevent. The NEXT pass deletes it — by then either the process is gone,
  # or its path still shows up in `ps` and it is kept again.
  for d in "$pending"/*/; do
    [ -d "$d" ] || continue
    d="${d%/}"
    moved_hit=0
    if [ "${#moved_now[@]}" -gt 0 ]; then
      for m in "${moved_now[@]}"; do
        if [ "$m" = "$d" ]; then moved_hit=1; break; fi
      done
    fi
    if [ "$moved_hit" = "1" ]; then
      echo "   keep    $d — 本次刚挪进来，删除留给下一趟（下次安装或下一次 --computer-use-reclaim）"; continue
    fi
    rc_use=0; cu_dir_in_use "$d" || rc_use=$?
    if [ "$rc_use" -ne 1 ]; then
      echo "   keep    $d — ${CU_INUSE_REASON}（不杀进程）"; continue
    fi
    if rm -rf "$d" 2>/dev/null; then
      echo "  ✔ reclaim $d — 已不再被指向、无人运行"
    else
      echo "!  reclaim failed: $d（留着，不强删）"
    fi
  done
}

# ── the computer-use MCP server (OPT-IN, default off) ───────────────────────
# Same order as install.ps1, failing closed at every step:
#   verify sha256 → uv tool install → `--selftest` must exit 0 → mcp-set.
# No config byte is written until a server that actually runs exists, and any failure
# after the install rolls it back. A `mcp` entry whose command the host cannot spawn is a
# server that never starts; the host reports it as a timeout, which reads as our bug.
# usage: install_computer_use <config file> <surgery helper> [legacy config file]
install_computer_use() {
  local cfg="$1" surgery="$2" legacy_cfg="${3:-}"
  local src want got wheel="" downloaded=0 candidate="" exe="" tool_name="" exe_status=0
  local leaf base rest fields cu_ver="" cu_root cu_ver_dir cu_cur_ver cu_exe_prev cu_still=""
  local cu_exe_now="" cu_rec_ver="" cu_rec_sha="" already=0 created_dir=0 inst=0 cu_now=""
  echo ""
  echo "↻  computer-use MCP server (opt-in) ..."
  if ! command -v uv >/dev/null 2>&1; then
    echo "!  uv is not on PATH, so there is no way to install the server."
    echo "   Nothing was written. Install uv (https://docs.astral.sh/uv/), then re-run:"
    echo "     bash install.sh --computer-use"
    return 1
  fi

  # ── (a) which wheel, and the only hash we will accept ─────────────────────
  src="${CU_WHEEL_ARG:-$CU_RELEASE_URL}"
  want="${CU_SHA_ARG:-$CU_WHEEL_SHA256}"
  if ! printf '%s' "$want" | grep -Eq '^[0-9a-fA-F]{64}$'; then
    echo "!  wheel 尚未发布，无法安装 — there is no sha256 to verify against, and this installer"
    echo "   never installs a binary it could not check. Nothing was written."
    echo "   With a wheel you built yourself (computer-use/scripts/build-wheel.ps1):"
    echo "     bash install.sh --computer-use \\"
    echo "       --computer-use-wheel <wheel path or https url> \\"
    echo "       --computer-use-wheel-sha256 <sha256 of that file>"
    return 1
  fi

  # ── (b) materialise it: a path as-is; an https asset downloaded to a temp file ──
  if printf '%s' "$src" | grep -Eq '^https?://'; then
    # Keep the ASSET'S FILENAME: `uv tool install` reads the distribution name, version and
    # python tag out of the filename and rejects anything else ("The wheel filename ... is
    # invalid: Must have a Python tag").  A bare mktemp name fails even when the bytes and
    # the sha256 are perfect — that is exactly how the first 0.0.2 install failed.
    asset="${src##*/}"
    case "$asset" in
      *.whl) ;;
      *) asset="computeruse_mcp-${CU_VERSION}-py3-none-any.whl" ;;
    esac
    wheel_dir="$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}")"
    wheel="${wheel_dir}/${asset}"
    echo "↓  downloading ${src}"
    if command -v curl >/dev/null 2>&1; then
      if ! curl -fsSL -o "$wheel" "$src"; then
        rm -f "$wheel"
        echo "!  download failed. Nothing was written and nothing was installed."
        return 1
      fi
    elif command -v wget >/dev/null 2>&1; then
      if ! wget -q -O "$wheel" "$src"; then
        rm -f "$wheel"
        echo "!  download failed. Nothing was written and nothing was installed."
        return 1
      fi
    else
      echo "!  neither curl nor wget is available to download the wheel."
      return 1
    fi
    downloaded=1
  else
    wheel="$src"
    if [ ! -f "$wheel" ]; then
      echo "!  No such wheel: ${wheel}"
      echo "   Nothing was written and nothing was installed."
      return 1
    fi
  fi

  # ── (c) the hash decides. A mismatch deletes the download and stops here. ──
  if command -v sha256sum >/dev/null 2>&1; then
    got="$(sha256sum "$wheel" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    got="$(shasum -a 256 "$wheel" | awk '{print $1}')"
  else
    got="$(node -e 'const c=require("crypto"),f=require("fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$wheel")"
  fi
  got="$(printf '%s' "$got" | tr 'A-Z' 'a-z')"
  want="$(printf '%s' "$want" | tr 'A-Z' 'a-z')"
  if [ "$got" != "$want" ]; then
    if [ "$downloaded" = "1" ]; then rm -f "$wheel"; fi
    echo "!  sha256 mismatch — refusing to install:"
    echo "     expected ${want}"
    echo "     got      ${got}"
    echo "   Nothing was written and nothing was installed."
    return 1
  fi
  echo "✔  sha256 verified: ${got}"

  # ── (d) which version is this wheel? The FILENAME says, and uv agrees ──────
  # uv reads name / version / python tag out of the wheel FILENAME and refuses anything
  # else, so that filename is the honest source for the version that names the directory —
  # and a filename uv would reject is rejected HERE first, before a single directory is
  # created. A wheel's distribution name carries no dash (PEP 427 normalises it), so the
  # version is the field after the first dash: five dash-separated fields before `.whl`.
  leaf="$(basename "$wheel")"
  cu_ver=""
  base="${leaf%.whl}"
  if [ "$base" != "$leaf" ]; then
  fields=$(printf '%s\n' "$base" | awk -F'-' '{print NF}')
  if [ "${fields:-0}" -ge 5 ]; then rest="${base#*-}"; cu_ver="${rest%%-*}"; fi
  fi
  case "$cu_ver" in
    [0-9]*) ;;
    *) cu_ver="" ;;
  esac
  if [ -z "$cu_ver" ]; then
    if [ "$downloaded" = "1" ]; then rm -f "$wheel"; fi
    echo "!  读不出 wheel 的版本号：${leaf}"
    echo "   「一个版本一个目录」是这套升级机制的骨架，而版本只能取自文件名（uv 自己也是这么读的）。"
    echo "   保持发行资产的文件名：computeruse_mcp-<版本>-py3-none-any.whl"
    echo "   Nothing was written and nothing was installed."
    return 1
  fi

  cu_root="$(cu_releases_root)"
  cu_ver_dir="${cu_root}/${cu_ver}"
  cu_cur_ver="$(cu_json_get "${cu_root}/current.json" version || true)"
  cu_still="（配置里还没有 mcp.computeruse 条目）"
  if [ -n "$cu_cur_ver" ]; then
    cu_exe_prev="$(cu_json_get "${cu_root}/current.json" exe || true)"
    cu_still="${cu_cur_ver} → ${cu_exe_prev:-（current.json 没有 exe 字段）}"
  fi
  echo "   releases: ${cu_root}"
  echo "   本次目标: ${cu_ver_dir}"

  # ── (e) install into <releases>/<version>, a directory NOTHING is holding ───
  # UV_TOOL_DIR IS the version directory now, so this path no longer honours a caller's
  # UV_TOOL_DIR: nesting a non-tool directory inside uv's own tool dir is how `uv tool list`
  # learned to print "Ignoring malformed tool `bin`". The override it does honour is
  # TEAMMODE_CU_RELEASE_DIR, and everything it writes — venv, shim, receipt — stays under
  # that one root, so the undo and the reclaim are both "delete a directory", never "reach
  # into the user's real uv state".
  cu_exe_now="$(cu_find_exe "$cu_ver_dir" || true)"
  cu_rec_ver="$(cu_json_get "${cu_ver_dir}/receipt.json" version || true)"
  cu_rec_sha="$(cu_json_get "${cu_ver_dir}/receipt.json" wheel_sha256 || true)"
  already=0
  if [ -n "$cu_exe_now" ] && [ "$cu_rec_ver" = "$cu_ver" ] && \
     [ "$(printf '%s' "${cu_rec_sha:-}" | tr 'A-Z' 'a-z')" = "$got" ]; then
    already=1
  fi
  created_dir=0
  inst=0
  if [ "$already" = "1" ]; then
    # Idempotence, and it is a real skip: no uv run, no new files. The config still goes
    # through mcp-set below, because the helper itself writes NOTHING when the entry already
    # carries these exact bytes and says 已存在，未改动 when it did.
    echo "OK  already at ${cu_ver} — 该版本目录已有通过 --selftest 的 receipt、wheel 哈希一致：不重跑 uv tool install"
    if [ "$downloaded" = "1" ]; then rm -f "$wheel"; downloaded=0; fi
  else
    if [ ! -d "$cu_ver_dir" ]; then mkdir -p "$cu_ver_dir"; created_dir=1; fi
    export UV_TOOL_DIR="$cu_ver_dir"
    # ALWAYS set together with UV_TOOL_DIR: uv's own default shim dir is where the user's
    # other tools' launchers live, and a computeruse shim landing there is the pollution
    # this layout exists to avoid. Inside the version dir it costs nothing.
    export UV_TOOL_BIN_DIR="${cu_ver_dir}/bin"
    uv tool install --force "$wheel" || inst=$?
    if [ "$downloaded" = "1" ]; then rm -f "$wheel"; downloaded=0; fi
    if [ "$inst" -ne 0 ]; then
      echo "!  uv tool install failed (exit ${inst}) — no config byte was written."
      echo "   新机制只在「同一个版本号被重复构建、而旧进程正是从这个目录跑起来的」时才可能撞上占用；"
      echo "   那一种情况先 opencode service restart 释放它，或按新版本号重新构建，再重跑本条命令。"
      echo "   mcp.computeruse 没有改动，仍在跑的是：${cu_still}"
      return 1
    fi
  fi

  # ── (f) the entry point must EXIST and ANSWER `--selftest`, and only then does
  #        the config move ──────────────────────────────────────────────────────
  # The tool directory inside the version dir is named after the DISTRIBUTION
  # (`computeruse-mcp`, measured), not after the console script, so scan instead of
  # guessing one spelling.
  exe="$(cu_find_exe "$cu_ver_dir" || true)"
  tool_name=""
  if [ -n "$exe" ]; then tool_name="$(basename "$(dirname "$(dirname "$exe")")")"; fi
  # Rollback is stated once and used by both failure legs. It is a DIRECTORY delete scoped
  # to the version directory THIS run created — deliberately NOT `uv tool uninstall`: that
  # resolves UV_TOOL_DIR itself, and in the `already at` leg we never set it, so it would
  # reach the user's REAL tool dir and remove the server that currently works. Nothing here
  # kills a process; a directory something is running from is left exactly as it is.
  cu_rollback() {
    local rc_use
    if [ "$created_dir" = "1" ] && [ -d "$cu_ver_dir" ]; then
      # Same three-way contract: a `ps` we could not run is NO evidence, so the directory is
      # left alone — and the line says which face it was instead of claiming a process runs here.
      rc_use=0; cu_dir_in_use "$cu_ver_dir" || rc_use=$?
      if [ "$rc_use" -ne 1 ]; then
        echo "   版本目录留着不动（${CU_INUSE_REASON}）：${cu_ver_dir}"
      elif rm -rf "${cu_ver_dir}" 2>/dev/null; then
        echo "   本次新建的版本目录已删除：${cu_ver_dir}"
      else
        echo "!  版本目录删不掉，留着不动：${cu_ver_dir}"
      fi
    elif [ "$already" = "1" ]; then
      # The receipt claimed "this directory passes --selftest", and it just did not.
      # Dropping the claim is what makes the NEXT run reinstall and re-verify instead of
      # trusting a record this machine contradicted.
      if [ -f "${cu_ver_dir}/receipt.json" ]; then
        rm -f "${cu_ver_dir}/receipt.json"
        echo "   receipt 已删除（${cu_ver} 的 --selftest 这次没通过）：下一次安装会重装并重新验证"
      fi
      echo "   版本目录本身保持原样：${cu_ver_dir}（${tool_name:-无工具名}）"
    fi
    echo "   Nothing was written to ${cfg} — 仍在跑的仍是：${cu_still}"
  }
  if [ -z "$exe" ]; then
    echo "!  Installed, but no computeruse entry point appeared under ${cu_ver_dir}"
    cu_rollback
    return 1
  fi
  echo "   entry: ${exe}"
  "$exe" --selftest || exe_status=$?
  if [ "$exe_status" -ne 0 ]; then
    echo "!  ${exe} --selftest exited ${exe_status}, so this server does not work on this machine"
    echo "   (its own output is above; the usual cause is a session without a real desktop)."
    echo "   Nothing was written."
    echo "   配置条目未改动 —— 仍是旧版本在跑：${cu_still}"
    cu_rollback
    return 1
  fi
  echo "✔  --selftest exited 0: the server runs here"
  # Built by node, not by string concatenation: an absolute path carrying quotes or
  # spaces must not be able to break the JSON (or smuggle a second key into it).
  json="$(node -e 'process.stdout.write(JSON.stringify({type:"local",command:[process.argv[1],"--budget","200"],environment:{},enabled:true,timeout:60000}))' "$exe")" || {
    echo "!  Could not build the mcp entry JSON — nothing was written."
    return 1
  }
  echo "   entry: ${exe}"
  # Same channel as install.ps1 (TM_MCP_SPEC) so the two front-ends call the helper in ONE
  # way. bash could pass the JSON as an argument; PowerShell measurably cannot, and a
  # second spelling is a second thing to keep right.
  if ! TM_MCP_SPEC="$json" node "$surgery" "$cfg" mcp-set computeruse; then
    echo "!  The mcp.computeruse entry is not in ${cfg} — nothing further is claimed."
    echo "   条目没落地，所以 current.json / receipt.json 都不写：下一次安装会把这目录当作未验证的重装。"
    return 1
  fi
  # The two runtime records, written only after the helper's own read-back passed:
  # receipt.json = "this directory is a verified install of these wheel bytes" (the
  # idempotence key), current.json = "the config entry points here" (the reclaim's
  # do-not-touch marker). Neither one reads or rewrites the host config.
  cu_now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cu_json_write "${cu_ver_dir}/receipt.json" version "$cu_ver" exe "$exe" wheel "$leaf" \
    wheel_sha256 "$got" selftest "exit 0" installed_at "$cu_now"
  cu_json_write "${cu_root}/current.json" version "$cu_ver" exe "$exe" wheel_sha256 "$got" \
    config "$cfg" updated_at "$cu_now"
  # An upgrade cleans up after itself. The previous version is now unreferenced and usually
  # STILL LOADED by the running host, which the pass reports as a keep with a reason — the
  # next install, after the restart, is what takes it.
  echo "↻  回收旧版本目录 …"
  cu_reclaim_releases "$cu_root" "$cu_ver" "$cfg" "$legacy_cfg"
  echo ""
  echo "✔  computer-use ${cu_ver} 已就位 —— 只差一次重启（不是两次）"
  echo "   opencode service restart   # 旧进程随宿主退出，新条目指向上面那个 exe"
  # A thing this script wrote must be removable without re-reading its source.
  echo ""
  echo "   撤销 computer-use:"
  echo "     1. 删掉 ${cfg} 里的 mcp.computeruse 那一项："
  echo "        node ${surgery} ${cfg} mcp-remove computeruse"
  echo "     2. 删掉这套机制装的全部版本：rm -rf \"${cu_root}\""
  echo "        （只回收旧版本： bash install.sh --computer-use-reclaim —— 逐条报理由，运行中的目录绝不删）"
  echo "        （旧布局的安装在 uv 自己的工具目录里： uv tool uninstall computeruse-mcp）"
  echo "     3. 重启 OpenCode：opencode service restart"
  echo "        （可选，清掉审计轨：rm -rf \"\${XDG_DATA_HOME:-\${HOME}/.local/share}/te-river/computeruse\"）"
  return 0
}

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

  # ── --computer-use-reclaim alone does ONLY the cleanup ──────────────────────
  # It returns BEFORE the plugin install so a cleanup run writes zero config bytes and
  # never touches a wheel: no uv run, no mcp-set, nothing. It deletes nothing that
  # current.json says the entry points at, nothing a process is running from, and nothing
  # whose path still appears in either global config file. With no readable current.json it
  # deletes NOTHING at all (the .pending-delete queue included). With --computer-use as well,
  # the install path runs the same pass at its end, so this only says so instead of doing it
  # twice. Same shape as install.ps1's block of the same name.
  if [ "${CU_RECLAIM:-0}" = "1" ]; then
    cu_root_r="$(cu_releases_root)"
    if [ "$COMPUTER_USE" = "1" ]; then
      echo "   （--computer-use-reclaim：安装成功后自动跑同一趟回收，这里不再单独跑一遍）"
    else
      echo ""
      echo "↻  computer-use 版本目录回收（只回收，不安装）..."
      if [ ! -d "$cu_root_r" ]; then
        echo "   没有回收对象：${cu_root_r} 不存在"
        echo "   （旧布局装在 uv 自己的工具目录里，那条路用：uv tool uninstall computeruse-mcp）"
        return 0
      fi
      cur_ver="$(cu_json_get "${cu_root_r}/current.json" version || true)"
      if [ -n "$cur_ver" ]; then
        echo "   releases: ${cu_root_r} · current: ${cur_ver}"
      else
        echo "   releases: ${cu_root_r} · current: （没有 current.json：确认不了条目指向哪一版，本次一个目录都不动 — 全部保留）"
      fi
      echo "   配置参照: ${cfg}"
      cu_reclaim_releases "$cu_root_r" "$cur_ver" "$cfg" "$legacy"
      return 0
    fi
  fi
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
  for role in Team architect implementer reviewer tester researcher ComputerUser; do
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
  echo "↻  Setting default_agent = Team (last, because the roles are on disk now) ..."
  if ! node "${node_js}" "${cfg}" default-agent Team; then
    echo "!  Could not set default_agent. Add it by hand at the top level of ${cfg}:"
    echo "     \"default_agent\": \"Team\""
    exit 1
  fi

  # ── 5. the computer-use MCP server (OPT-IN, default off) ──────────────────
  if [ "$COMPUTER_USE" = "1" ]; then
    if ! install_computer_use "${cfg}" "${node_js}" "${legacy}"; then
      exit 1
    fi
  fi

  # ── 6. the 2.x checklist ──────────────────────────────────────────────────
  local cmd_count
  cmd_count="$(find "${cfg_dir}/commands" -maxdepth 1 -name 'team-*.md' 2>/dev/null | grep -c . || true)"
  echo ""
  echo "── 2.x checklist ─────────────────────────────────────────────────────────────"
  echo "   roles    : 7/7 files under ${cfg_dir}/agents/"
  echo "   commands : ${cmd_count:-0}/6 found under ${cfg_dir}/commands/team-*.md (a hand-written"
  echo "              file the generator refused to overwrite would show short here)"
  echo "   default  : default_agent = Team, read back from ${cfg}"
  echo "   env vars : NONE needed. OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS is a 1.18.x"
  echo "              workaround; on 2.x sub-agents are background natively and the plugin"
  echo "              forces background:true on every dispatch, so setting it changes"
  echo "              nothing here and only makes the picture harder to read."
  if [ -n "${OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS:-}" ]; then
    echo "              It IS set in your environment (that is what 'changes nothing' refers"
    echo "              to) — unset it when convenient; it matters only to a 1.18.x host."
  fi
  echo ""
  echo "✔  Done! Restart OpenCode to activate (or run: opencode service restart)."
  echo "   Then check — all session-free (no 'opencode run', no new session):"
  echo "     1. opencode agents            → Team, architect, implementer, reviewer,"
  echo "                                     tester, researcher, computerUser"
  echo "     2. boot evidence              → the host log's 'loading plugin' line, or the"
  echo "                                     newest v2-boot row in the workspace's"
  echo "                                     .git/opencode-team/trajectory/runs/*/steps.jsonl"
  echo "                                     (tools_registered / hooks / storage_probe)."
  echo "   Optional, only if the user wants it: in a session THEY start themselves"
  echo "   (it creates a session), tm_stats 启动与人格 + a tm_ledger smoke test."
  echo "   (a default_agent does not move an existing session)."
  echo ""
}

if [ "$OPENCODE_MAJOR" -ge 2 ]; then
  install_v2
  exit 0
fi
if [ "$COMPUTER_USE" = "1" ]; then
  echo ""
  echo "!  --computer-use is implemented on the OpenCode 2.x path only (this machine takes"
  echo "   the 1.18.x path). mcp.computeruse is a 2.x config shape with no measured 1.18.x"
  echo "   equivalent, so NOTHING was written. Re-run with --computer-use once the host is 2.x."
  exit 1
fi
if [ "${CU_RECLAIM:-0}" = "1" ]; then
  echo ""
  echo "!  --computer-use-reclaim 同样是 2.x 路径的功能：它回收的是本安装器写的"
  echo "   <releases>/<版本>/ 目录，而 1.18.x 路径从不装它们。这台机器走 1.18.x，所以一个"
  echo "   文件都没有读、没有删。宿主升到 2.x 后再跑一次即可。"
  exit 1
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
echo "   Self-check after the restart — session-free: read the host log for the plugin's"
echo "   'loading plugin' line (no 'opencode run', no new session needed)."
echo "   Optional: in a session YOU start yourself (it creates a session), tm_stats shows"
echo "   '宿主后台 task 注入' — which plugin build loaded / whether the background"
echo "   sub-agent channel is live."
echo ""
