# ─────────────────────────────────────────────────────────────────────────────
# OpenCode TeamMode — one-click installer for Windows (idempotent: re-run to UPDATE)
#
# Usage:
#   irm https://ghproxy.net/https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/scripts/install.ps1 | iex
#
# What it does:
#   1. Adds @te-river/opencode-team-mode@latest to ~/.config/opencode/opencode.jsonc
#      (falls back to opencode.json when only that one exists).
#   2. Purges the stale plugin cache — OpenCode caches plugins by spec string
#      under packages/ in the cache dir, possibly NESTED inside a @te-river/
#      scope directory (scoped layout: packages\@te-river\opencode-team-mode@latest)
#      or flattened (packages\@te_river+opencode-team-mode@latest), so the purge
#      RECURSES to catch both layouts. OpenCode NEVER re-resolves @latest on its
#      own, so a re-run is the update.
#   3. Re-resolves an npm-installed copy inside the config dir (package-lock
#      pins would otherwise keep the old version).
#   Restart OpenCode afterwards.
#
# On OpenCode 2.x the script takes a DIFFERENT path (Install-V2 below):
#   `opencode plugin add` (first-party: installs AND writes the global config,
#   which is why steps 2 and 3 are obsolete there) → run the generator shipped
#   INSIDE the installed package (a 2.x plugin cannot create an agent, so the
#   six roles + six /team-* commands must be config files) → `default_agent:
#   "team"`, LAST, read back off the file. The 2.x path also does not set
#   OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: background sub-agents are native
#   there and the plugin forces `background: true` on every dispatch.
# ─────────────────────────────────────────────────────────────────────────────

#Requires -Version 5.1

# Piped install (irm ... | iex) cannot pass switches; run the file directly to
# use them, or set TEAMMODE_SKIP_BACKGROUND_SUBAGENTS=1 in the environment.
# -ComputerUse is OFF by default and is not part of the plugin install: it wires the
# optional `computeruse` MCP server (see step 5 of Install-V2).
param(
    [switch]$NoBackgroundSubagents,
    # The optional computer-use MCP server. -ComputerUse is the on/off switch; the two
    # other parameters exist because the wheel has to be VERIFIED before it is installed,
    # and before the release exists the only wheel in the world is one the caller built.
    [switch]$ComputerUse,
    [string]$ComputerUseWheel,
    [string]$ComputerUseWheelSha256,
    # Reclaims the per-version release directories without installing anything (see
    # CU-ReclaimReleases below). Combined with -ComputerUse it is a no-op switch: that
    # path already runs the same pass at the end of a successful install.
    [switch]$ComputerUseReclaim
)

$ErrorActionPreference = "Stop"

$PKG = "@te-river/opencode-team-mode@latest"
$PKG_NAME = "@te-river/opencode-team-mode"

# ── the optional computer-use server (a GitHub Release ASSET, not an npm artifact) ──
# It has its own version line: tag `computeruse-v<version>`, asset
# `computeruse_mcp-<version>-py3-none-any.whl`, released from computer-use/.
# THE SHA256 BELOW IS THE ONE PLACE THE TRUST DECISION LIVES. It is the released 0.0.1
# asset's hash; a wheel whose hash does not match is never installed (Install-V2 step 5a),
# because an unverified binary is exactly what this constant exists to prevent. Publishing
# a new asset and overwriting this value belong in the SAME commit — a stale hash fails
# closed, which is the correct failure.
$CU_VERSION = "0.0.6"
$CU_WHEEL_SHA256 = "fdde2e2df3726c33cdc1fb57adbc5d85b3ab067bb7871df9290eb7f75e21eb91"
$CU_RELEASE_URL = "https://github.com/Te-River/Opencode-TeamMode/releases/download/computeruse-v$($CU_VERSION)/computeruse_mcp-$($CU_VERSION)-py3-none-any.whl"

# ── the release layout that made the upgrade ONE restart instead of two ────────────────
# Every version of the server gets its OWN uv tool directory:
#
#   <releases>/current.json                    which version the mcp entry points at
#   <releases>/<version>/receipt.json          that dir passed --selftest, with the wheel hash
#   <releases>/<version>/computeruse-mcp/…     the venv `uv tool install` wrote (dist name, fixed)
#   <releases>/<version>/bin/                  uv's shim dir, kept INSIDE the version dir
#
# The reason is one sentence long: `uv tool install` writes into `<UV_TOOL_DIR>/<dist name>/`
# and replaces the console script in place, so an upgrade of a server the host is still
# running asks Windows to overwrite a loaded image — `os error 32`. The dist-name directory
# is not ours to rename (it comes from the wheel's metadata, and uv itself reads
# name/version/tag out of the FILENAME), so what carries the version is its PARENT: we set
# UV_TOOL_DIR to <releases>/<version> and the new version lands in a directory nothing is
# holding. The upgrade then IS the single edit that repoints `mcp.computeruse.command`,
# which is why the old directory is left alone afterwards instead of being deleted while
# its process is alive.
#
# The root follows the audit trail's own tree (%LOCALAPPDATA%\te-river\computeruse) so one
# undo removes the whole feature; TEAMMODE_CU_RELEASE_DIR overrides it, which is what makes
# a sandboxed test of this code path possible without touching uv's real tool dir.
function script:CU-ReleasesRoot {
    if ($env:TEAMMODE_CU_RELEASE_DIR) { return $env:TEAMMODE_CU_RELEASE_DIR }
    $local = $env:LOCALAPPDATA
    if (-not $local) { $local = Join-Path $env:USERPROFILE "AppData\Local" }
    return (Join-Path $local "te-river\computeruse\releases")
}

# Runtime DATA written by the installer about its own install (never documentation, never
# the host config): those two stay a single edit through scripts\lib\config-surgery.cjs.
function script:CU-ReadJson([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try { return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json) } catch { return $null }
}
function script:CU-WriteJson([string]$Path, $Object) {
    $json = $Object | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText($Path, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
}

# The console script, inside one version directory. The venv is a CHILD of the version dir
# (uv names it after the distribution — measured `computeruse-mcp`, not `computeruse`), so
# children are scanned before the version dir itself, which only ever holds uv's shim.
function script:CU-FindExe([string]$VerDir) {
    if (-not $VerDir -or -not (Test-Path -LiteralPath $VerDir)) { return $null }
    $tops = @((Get-ChildItem -LiteralPath $VerDir -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }))
    $tops += $VerDir
    foreach ($t in $tops) {
        foreach ($rel in @("Scripts\computeruse.exe", "bin\computeruse", "Scripts\computeruse")) {
            $cand = Join-Path $t $rel
            if (Test-Path -LiteralPath $cand) { return $cand }
        }
    }
    return $null
}

# True when we CANNOT prove the directory is idle. It fails closed on purpose: a throwing
# process list, or a process whose image path we are not allowed to read, keeps the
# directory. TWO things are matched, because an image path alone was measured to be too
# weak — a copied console script can exit and leave its interpreter (whose image lives
# outside the version dir) running from inside it:
#   * the executable path of every process we can see, and
#   * the command line of every process (Win32_Process), which is where the host's own
#     `mcp.computeruse.command` path shows up even for a re-spawned interpreter.
# Deleting a release the host is still running would be the R2 face this installer never
# takes — and there is no kill anywhere in this code path.
# RETURNS A VERDICT, not a bare boolean, because "a process hit this directory" and "nothing
# hit it, but we could not look at everything" are two different sentences, and the second
# may not borrow the first one's words. The directory is kept EITHER WAY (fail closed), but
# the printed reason names the evidence there actually is. Before this, ONE unreadable
# process image — routine for a non-elevated session — made EVERY directory report
# "有进程从这个目录跑着" with no pid behind it: an overstated claim about what happened.
#   @{ InUse = $true/$false; Reason = "<the hit, or the conservative sentence>" }
function script:CU-DirInUse([string]$Dir) {
    if (-not (Test-Path -LiteralPath $Dir)) { return @{ InUse = $false; Reason = "" } }
    $prefix = $Dir.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    $unreadable = 0
    $listFailed = $null
    try {
        foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) {
            $img = $null
            try { $img = $p.Path } catch { $unreadable++; continue }   # no evidence — counted, never a hit
            if ($img -and $img.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
                return @{ InUse = $true; Reason = "有进程从这个目录跑着：映像路径命中 pid $($p.Id)" }
            }
        }
    } catch { $listFailed = $_.Exception.Message }
    try {
        foreach ($pr in @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)) {
            $cl = $pr.CommandLine
            if (-not $cl) { continue }
            if ($cl.IndexOf($Dir, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                return @{ InUse = $true; Reason = "有进程从这个目录跑着：命令行命中 pid $($pr.ProcessId)" }
            }
            if ($cl.IndexOf($Dir.Replace('\', '/'), [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                return @{ InUse = $true; Reason = "有进程从这个目录跑着：命令行命中 pid $($pr.ProcessId)" }
            }
        }
    } catch {
        # No CIM view (service, old box, denied): the image scan above already ran, and a
        # second source of evidence being unavailable is reported, not silently accepted.
        Write-Host "   （进程命令行查不了：$($_.Exception.Message) —— 只能凭映像路径判断）" -ForegroundColor DarkGray
    }
    # Nothing matched. The directory is STILL kept when the scan was incomplete — that is
    # the conservative direction, unchanged — but the sentence says "no hit evidence", not
    # "a process is running from here", because no process was ever hit.
    if ($listFailed) { return @{ InUse = $true; Reason = "进程列表查询失败（$listFailed），未获得命中证据，保守保留" } }
    if ($unreadable -gt 0) { return @{ InUse = $true; Reason = "$unreadable 个进程映像读不到（访问拒绝），未获得命中证据，保守保留" } }
    return @{ InUse = $false; Reason = "" }
}

# Does the config still name this directory? Checked against the RAW file text, because the
# stored spelling is JSON-escaped (`C:\\Users\\…`) and a Windows path comparison is
# case-insensitive. A file we cannot read answers "mentioned": not being able to rule it
# out is not evidence that it is safe to delete.
function script:CU-ConfigMentions([string]$CfgFile, [string]$Dir) {
    if (-not (Test-Path -LiteralPath $CfgFile)) { return $false }
    $text = $null
    try { $text = Get-Content -LiteralPath $CfgFile -Raw -ErrorAction Stop } catch { return $true }
    $norm = $Dir.TrimEnd('\', '/')
    $needles = @($norm, $norm.Replace('\', '\\'), $norm.Replace('\', '/'))
    foreach ($n in $needles) {
        if ($n -and $text.IndexOf($n, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    }
    return $false
}

# Keeps what the entry points at, what either config still names, and what anything is
# running from; the rest is MOVED ASIDE into <root>/.pending-delete and only then deleted.
# The move is not ceremony: `Remove-Item -Recurse` on a tree something has open deletes the
# files it can reach and fails on the one it cannot, leaving a HALF-DELETED release behind.
# A directory rename either succeeds atomically or fails with nothing moved — so a locked
# release stays intact for the next pass, and an unlocked one is gone. Every skip prints its
# reason: a reclaim pass that quietly kept a directory is the overstated "done" this product
# exists to refuse. Nothing here kills a process, and nothing here touches uv's own tool dir.
function script:CU-ReclaimReleases {
    param([string]$Root, [string]$CurrentVersion, [string[]]$CfgFiles)
    if (-not (Test-Path -LiteralPath $Root)) { return }
    # No current.json = no proof of which version the MCP entry points at, and "cannot
    # prove" is not evidence that deleting something is safe: this pass moves NOTHING and
    # deletes NOTHING, the .pending-delete queue included. install.sh's cu_reclaim_releases
    # has the same early return, and the console lines in both front-ends say exactly this.
    if (-not $CurrentVersion) {
        Write-Host "   没有 current.json：证明不了条目指向哪一版，本次一个目录都不动（全部保留，.pending-delete 也不清）" -ForegroundColor DarkGray
        return
    }
    $pending = Join-Path $Root ".pending-delete"
    $movedNow = @()
    foreach ($d in @(Get-ChildItem -LiteralPath $Root -Directory -ErrorAction SilentlyContinue)) {
        if ($d.Name -eq ".pending-delete") { continue }
        if ($d.Name -notmatch '^[0-9][A-Za-z0-9._+-]*$') {
            Write-Host "   keep    $($d.Name) — 不是版本号目录，不是这套机制装的" -ForegroundColor DarkGray
            continue
        }
        if ($CurrentVersion -and $d.Name -eq $CurrentVersion) {
            Write-Host "   keep    $($d.FullName) — current.json：MCP 条目就指向它" -ForegroundColor DarkGray
            continue
        }
        $mentioned = $false
        foreach ($cf in @($CfgFiles)) { if ($cf -and (CU-ConfigMentions $cf $d.FullName)) { $mentioned = $true; break } }
        if ($mentioned) {
            Write-Host "   keep    $($d.FullName) — 全局配置里仍然出现这个路径，不能断定条目不在用它" -ForegroundColor DarkGray
            continue
        }
        $use = CU-DirInUse $d.FullName
        if ($use.InUse) {
            Write-Host "   keep    $($d.FullName) — $($use.Reason)（不杀进程，下次安装再来回收）" -ForegroundColor DarkGray
            continue
        }
        try {
            if (-not (Test-Path -LiteralPath $pending)) { New-Item -ItemType Directory -Path $pending -Force | Out-Null }
            $stamped = Join-Path $pending ($d.Name + "." + (Get-Date).ToString("yyyyMMdd-HHmmss"))
            # [IO.Directory]::Move is a bare Win32 MoveFile. `Move-Item` is NOT usable here:
            # when the rename fails it falls back to copy-then-delete, which is precisely the
            # partial destruction moving aside exists to avoid — measured in the sandbox run,
            # where a held release got copied into .pending-delete anyway.
            [IO.Directory]::Move($d.FullName, $stamped) | Out-Null
            $movedNow += $stamped
            Write-Host "   move    $($d.FullName) → $stamped" -ForegroundColor DarkGray
        } catch {
            Write-Host "   keep    $($d.FullName) — 挪不动（$($_.Exception.Message)）：里面有文件被打开了" -ForegroundColor DarkGray
        }
    }
    if (-not (Test-Path -LiteralPath $pending)) { return }
    # A tree this pass moved aside is NOT deleted by this pass. The move proves nothing about
    # the files inside it, and deleting a release a process is still reading would half-delete
    # it — the one outcome the whole two-phase design exists to prevent. The NEXT pass (the
    # next install, or the next -ComputerUseReclaim) deletes it, by which time either the
    # process is gone or its path still shows up and it is kept again.
    foreach ($p in @(Get-ChildItem -LiteralPath $pending -Directory -ErrorAction SilentlyContinue)) {
        if ($movedNow -contains $p.FullName -or ($movedNow | Where-Object { $_ -ieq $p.FullName })) {
            Write-Host "   keep    $($p.FullName) — 本次刚挪进来，删除留给下一趟（下次安装或下一次 -ComputerUseReclaim）" -ForegroundColor DarkGray
            continue
        }
        $puse = CU-DirInUse $p.FullName
        if ($puse.InUse) {
            Write-Host "   keep    $($p.FullName) — $($puse.Reason)（不杀进程）" -ForegroundColor DarkGray
            continue
        }
        try {
            Remove-Item -LiteralPath $p.FullName -Recurse -Force
            Write-Host "  ✔ reclaim $($p.FullName) — 已不再被指向、无人运行" -ForegroundColor Green
        } catch {
            Write-Host "!  reclaim failed: $($p.FullName) — $($_.Exception.Message)（留着，不强删）" -ForegroundColor Yellow
        }
    }
}

Write-Host ""
Write-Host "OpenCode TeamMode Installer" -ForegroundColor Cyan
Write-Host "==========================" -ForegroundColor Cyan
Write-Host ""

# ── which host generation are we installing into? ──────────────────────────
# Read-only probes ONLY (`opencode --version`, `opencode plugin --help`); this
# script never asks the host to do anything but talk about itself. The probes
# drop to Continue for their duration: in Windows PowerShell a native command
# writing to a redirected stderr under $ErrorActionPreference="Stop" raises a
# terminating NativeCommandError, which would read as "no version" and send a
# 2.x host down the 1.18.x path.
function Get-OpenCodeOut {
    param([string[]]$Words)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { (& opencode @Words 2>&1 | Out-String) } catch { "" } finally { $ErrorActionPreference = $prev }
}

$OpenCodeVersion = ""
$OpenCodeMajor = 1
$OpenCodeWhy = "opencode is not on PATH"
if (Get-Command opencode -ErrorAction SilentlyContinue) {
    $OpenCodeWhy = "'opencode --version' did not print a version we could read"
    $raw = Get-OpenCodeOut @("--version")
    if ("$raw" -match "\d+\.\d+\.\d+") {
        $OpenCodeVersion = $Matches[0]
        $OpenCodeMajor = [int]($OpenCodeVersion.Split(".")[0])
        $OpenCodeWhy = ""
    }
}

# The DESKTOP app never puts `opencode` on PATH: it ships the same server as a
# bundled binary under its resources dir, so a machine running 2.0.16 right now can
# still answer "not on PATH". Assuming v1 there installs the wrong thing on the
# user's own box, which is the exact failure this branch exists to prevent. Ask the
# app instead — first the version file (a whole file is the version string), then the
# bundled binary with the same read-only question. Nothing is written by either probe.
if (-not $OpenCodeVersion) {
    foreach ($dir in @(
        (Join-Path $env:LOCALAPPDATA "Programs\@opencode-aidesktop\resources"),
        (Join-Path $env:APPDATA    "opencode\bin"),
        (Join-Path $env:USERPROFILE ".opencode\bin")
    )) {
        if (-not $dir -or -not (Test-Path $dir)) { continue }
        $vfile = Join-Path $dir "opencode-cli.version"
        if (Test-Path $vfile) {
            $vt = (Get-Content -Raw -ErrorAction SilentlyContinue $vfile)
            if ("$vt" -match "\d+\.\d+\.\d+") {
                $OpenCodeVersion = $Matches[0]
                $OpenCodeMajor = [int]($OpenCodeVersion.Split(".")[0])
                $OpenCodeWhy = ""
                break
            }
        }
        foreach ($exe in @((Join-Path $dir "opencode-cli.exe"), (Join-Path $dir "opencode-cli"))) {
            if (-not (Test-Path $exe)) { continue }
            $raw2 = ""
            $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
            try { $raw2 = (& $exe --version 2>&1 | Out-String) } catch { $raw2 = "" } finally { $ErrorActionPreference = $prev }
            if ("$raw2" -match "\d+\.\d+\.\d+") {
                $OpenCodeVersion = $Matches[0]
                $OpenCodeMajor = [int]($OpenCodeVersion.Split(".")[0])
                $OpenCodeWhy = ""
                break
            }
        }
        if ($OpenCodeVersion) { break }
    }
}

# ── the OpenCode 2.x install path ──────────────────────────────────────────
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
#
# A major of 2 or MORE takes this branch (the one assumption here): everything
# it needs — `plugin add`, and a config dir the host reads agents/ and
# commands/ from — only gets more standard in later majors, and every step
# fails loudly instead of quietly doing nothing.
function Install-V2 {
    # Honour OPENCODE_CONFIG_DIR: an agent testing this branch redirects the config dir,
    # not the profile, and writing the user's LIVE global config from a "sandbox" run is a
    # real defect that fired on 2026-09-26. The resolved target is printed before anything
    # is written so the difference between a trial and an install is visible.
    $cfgDir = if ($env:OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR } else { Join-Path $env:USERPROFILE ".config\opencode" }
    Write-Host "→  2.x config target: $cfgDir" -ForegroundColor DarkGray
    if ($cfgDir -eq (Join-Path $env:USERPROFILE ".config\opencode")) {
        Write-Host "   (this is your LIVE global config; to try the installer without touching" -ForegroundColor DarkGray
        Write-Host "    it, set OPENCODE_CONFIG_DIR=<dir> — agents\, commands\ and vendor\ go" -ForegroundColor DarkGray
        Write-Host "    under whichever directory it names)" -ForegroundColor DarkGray
    }
    $cfgFile = Join-Path $cfgDir "opencode.jsonc"
    $legacy = Join-Path $cfgDir "opencode.json"
    $bgFlag = "OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS"

    # ── -ComputerUseReclaim alone does ONLY the cleanup ─────────────────────────
    # It returns BEFORE the plugin install so a cleanup run writes zero config bytes and
    # never touches a wheel: no uv run, no mcp-set, nothing. It deletes nothing that
    # current.json says the entry points at, nothing a process is running from, and nothing
    # whose path still appears in either global config file. With no readable current.json it
    # deletes NOTHING at all (the .pending-delete queue included). With -ComputerUse as well,
    # the install path runs the same pass at its end, so this only says so instead of doing it
    # twice.
    if ($ComputerUseReclaim) {
        $cuRootEarly = CU-ReleasesRoot
        if ($wantCU) {
            Write-Host "   （-ComputerUseReclaim：安装成功后自动跑同一趟回收，这里不再单独跑一遍）" -ForegroundColor DarkGray
        } else {
            Write-Host ""
            Write-Host "↻  computer-use 版本目录回收（只回收，不安装）..." -ForegroundColor Yellow
            if (-not (Test-Path -LiteralPath $cuRootEarly)) {
                Write-Host "   没有回收对象：$cuRootEarly 不存在" -ForegroundColor DarkGray
                Write-Host "   （旧布局装在 uv 自己的工具目录里，那条路用：uv tool uninstall computeruse-mcp）" -ForegroundColor DarkGray
                return
            }
            $cuCurrentEarly = CU-ReadJson (Join-Path $cuRootEarly "current.json")
            $curVer = ""
            if ($cuCurrentEarly -and $cuCurrentEarly.version) { $curVer = "$($cuCurrentEarly.version)" }
            $curNote = "（没有 current.json：确认不了条目指向哪一版，本次一个目录都不动 — 全部保留）"
            if ($curVer) { $curNote = $curVer }
            Write-Host "   releases: $cuRootEarly · current: $curNote" -ForegroundColor DarkGray
            Write-Host "   配置参照: $cfgFile" -ForegroundColor DarkGray
            CU-ReclaimReleases -Root $cuRootEarly -CurrentVersion $curVer -CfgFiles @($cfgFile, $legacy)
            return
        }
    }

    Write-Host ""
    Write-Host "── OpenCode $($OpenCodeVersion) detected: the 2.x path ─────────────────────────" -ForegroundColor Cyan
    Write-Host "   Deliberately NOT run here (both are 1.18.x machinery):" -ForegroundColor DarkGray
    Write-Host "     - the plugin-cache purge — 'plugin add' resolves the package itself, so a" -ForegroundColor DarkGray
    Write-Host "       v1 cache entry is a directory this host does not load from;" -ForegroundColor DarkGray
    Write-Host "     - the npm re-resolve in $cfgDir — it would fight the host's install." -ForegroundColor DarkGray
    Write-Host ""

    # ── 1. the plugins entry (this IS the plugin install) ───────────────────
    # Measured on 2.0.18 with a redirected HOME, and mirrored one-for-one by
    # scripts/install.sh, which is why both front-ends call the SAME helper
    # (scripts\lib\config-surgery.cjs) instead of two hand-kept copies:
    #   * the key is PLURAL `plugins`; a 2.x host never reads the 1.18.x singular
    #     `plugin` key, which is how an install used to look complete and do nothing;
    #   * the host INSTALLS the package itself at startup from the entry
    #     (msg="loading plugin" … .cache/opencode/npm/<pkg>@latest/<ts>/node_modules/…),
    #     so `opencode plugin add` is not a prerequisite and there is no cache to purge;
    #     `plugin add` cannot help a local directory anyway ("Plugin target must be an
    #     npm registry package or Git package specifier");
    #   * opencode.json and opencode.jsonc are BOTH parsed and MERGED, and the host's
    #     dedupe matches only an identical string, so the same plugin written into both
    #     files is LOADED TWICE (two "loading plugin" lines for one id, no warning).
    #     Hence: write the .jsonc (the file every previous installer used) and reclaim
    #     our own entry from the legacy .json. No migration copy, ever.
    if (-not (Test-Path $cfgDir)) {
        New-Item -ItemType Directory -Path $cfgDir -Force | Out-Null
    }
    $surgery = Join-Path $PSScriptRoot "lib\config-surgery.cjs"
    if (-not (Test-Path $surgery)) {
        Write-Host "!  Cannot find $surgery" -ForegroundColor Yellow
        Write-Host "   The 2.x installer is not a standalone file: it edits the config through that" -ForegroundColor Yellow
        Write-Host "   helper, and a copy fetched without it (iwr | iex) cannot do the job. Run it from" -ForegroundColor Yellow
        Write-Host "   a clone or from the installed package." -ForegroundColor Yellow
        exit 1
    }
    if (-not (Test-Path $cfgFile) -or ((Get-Item $cfgFile).Length -eq 0)) {
        [IO.File]::WriteAllText($cfgFile, "{`n  ""`$schema"": ""https://opencode.ai/config.json""`n}`n", (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "✔  Created $cfgFile" -ForegroundColor Green
    }

    # TEAMMODE_LOCAL_DIR is the development spelling, and the only one that works until
    # 1.6.1 is published: the published 1.6.0 has no `setup` export, so a 2.x host loads
    # it and fails with "Plugin must export a default definition with an id and an effect
    # or setup function". The tree is copied to <cfgDir>\vendor\team-mode and referenced
    # as "./vendor/team-mode" — and a ROOT index.js is mandatory, because the host's
    # directory entrypoint resolution tries `<dir>/index` only, and a directory it cannot
    # resolve is SKIPPED WITH NO MESSAGE AT ALL.
    $PluginEntry = $PKG
    $localDir = $env:TEAMMODE_LOCAL_DIR
    $vendorPkg = $null
    if ($localDir) {
        foreach ($need in @("index.js", "dist\index.js", "scripts\gen-v2-config.mjs")) {
            if (-not (Test-Path (Join-Path $localDir $need))) {
                Write-Host "!  TEAMMODE_LOCAL_DIR=$localDir is missing $need." -ForegroundColor Yellow
                Write-Host "   A directory the host cannot resolve an entrypoint for is skipped" -ForegroundColor Yellow
                Write-Host "   SILENTLY, so writing it into plugins would report an install that is" -ForegroundColor Yellow
                Write-Host "   nothing. Build the tree first (npm run build), or unset the variable." -ForegroundColor Yellow
                exit 1
            }
        }
        $vendorRoot = Join-Path $cfgDir "vendor"
        $vendorPkg = Join-Path $vendorRoot "team-mode"
        New-Item -ItemType Directory -Path $vendorRoot -Force | Out-Null
        if (Test-Path $vendorPkg) { Remove-Item -Recurse -Force $vendorPkg }
        # Create the destination first, then copy each child: `Copy-Item <src>\* <dst>`
        # with a destination that does not exist yet makes PowerShell 5.1 bind the last
        # item to a file name and throw an argument-transformation error mid-copy, which
        # leaves a half-copied package that the host then loads (or fails to) at random.
        New-Item -ItemType Directory -Path $vendorPkg -Force | Out-Null
        Get-ChildItem -Path $localDir -Force | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $vendorPkg -Recurse -Force
        }
        $nm = Join-Path $vendorPkg "node_modules"
        if (Test-Path $nm) { Remove-Item -Recurse -Force $nm }
        $PluginEntry = "./vendor/team-mode"
        Write-Host "✔  Copied the package to $vendorPkg (root index.js verified)" -ForegroundColor Green
    }


    # Runs the node helper with the preference dropped, so a host-side message on
    # stderr cannot abort the install halfway and leave the default unset. The
    # helper returns NOTHING on the success stream (a native command's stdout
    # would otherwise join the return value and make `-ne 0` a filter instead of
    # a comparison); callers read $LASTEXITCODE, which the native call sets.
    function script:Invoke-NodeHelper([string[]]$NodeArgs) {
        $prev = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try { & node @NodeArgs | Out-Host } finally { $ErrorActionPreference = $prev }
    }

        # "plugins" (plural) with the legacy .json passed as the file to scrub — the same
        # helper install.sh calls, so the two front-ends cannot disagree about what an
        # installed plugin looks like. The helper refuses to report success unless the
        # value reads back off the disk.
        Invoke-NodeHelper @($surgery, $cfgFile, "plugins", $PluginEntry, $legacy)
        if ($LASTEXITCODE -ne 0) {
            Write-Host "!  The plugins entry is not in $cfgFile - nothing further is attempted." -ForegroundColor Yellow
            Write-Host "   Without it the host never loads the plugin, and a default agent naming" -ForegroundColor Yellow
            Write-Host "   our roles would fall back to 'build' silently. Add it by hand:" -ForegroundColor Yellow
            Write-Host ('     "plugins": ["' + $PluginEntry + '"]') -ForegroundColor Yellow
            exit 1
        }

        # ── 2. the six roles and six commands, from the INSTALLED package ────
        # Candidates only, no recursive search. The npm cache layout is the one the host
        # installs into at startup (a timestamped wrapper whose EXECUTED code is the
        # nested node_modules\@te-river\ copy), the v1 `packages` layouts stay for a
        # machine that ran the 1.18.x installer, and the vendor copy is first because
        # TEAMMODE_LOCAL_DIR just put it there.
        $cacheRoots = @(
            (Join-Path $env:USERPROFILE ".cache\opencode\packages"),
            (Join-Path $env:USERPROFILE ".cache\opencode\npm"),
            (Join-Path $env:LOCALAPPDATA "opencode\cache\packages")
        )
        $candidates = @()
        if ($vendorPkg) { $candidates += $vendorPkg }
        $candidates += (Join-Path $cfgDir "node_modules\$PKG_NAME")
        foreach ($root in $cacheRoots) {
            $candidates += (Get-ChildItem -Path (Join-Path $root "@te-river") -Filter "opencode-team-mode@latest" -Directory -ErrorAction SilentlyContinue |
                ForEach-Object { Get-ChildItem -Path $_.FullName -Directory -ErrorAction SilentlyContinue |
                    ForEach-Object { Join-Path $_.FullName "node_modules\@te-river\opencode-team-mode" } })
            $candidates += (Join-Path $root "@te-river\opencode-team-mode@latest\node_modules\@te-river\opencode-team-mode")
            $candidates += (Join-Path $root "@te_river+opencode-team-mode@latest\node_modules\@te-river\opencode-team-mode")
        }
        $pkgDir = $null
        $gen = $null
        foreach ($c in $candidates) {
            if ($c -and (Test-Path (Join-Path $c "scripts\gen-v2-config.mjs")) -and (Test-Path (Join-Path $c "dist\agents.js"))) {
                $pkgDir = $c; $gen = Join-Path $c "scripts\gen-v2-config.mjs"; break
            }
        }
        if (-not $gen) {
            Write-Host "!  Could not find a package tree, so the roles/commands cannot be generated." -ForegroundColor Yellow
            Write-Host "   Looked for scripts\gen-v2-config.mjs + dist\agents.js under:" -ForegroundColor Yellow
            foreach ($c in $candidates) { Write-Host "     - $c" -ForegroundColor Yellow }
            Write-Host "   The entry is written, so a host STARTUP will install the package; then re-run" -ForegroundColor Yellow
            Write-Host "   this script (or: cd $cfgDir ; npm install $PKG --no-fund --no-audit)." -ForegroundColor Yellow
            Write-Host "   Nothing was set as the default agent - a default is only safe once the roles exist." -ForegroundColor Yellow
            exit 1
        }
        Write-Host "↻  Generating agents\ + commands\ from $pkgDir ..." -ForegroundColor Yellow
        Invoke-NodeHelper @($gen, "--dir", $cfgDir)
        if ($LASTEXITCODE -ne 0) {
            Write-Host "!  The generator failed (its own output is above). Common cause: the package's" -ForegroundColor Yellow
            Write-Host "   prompts and its gen-v2-config.mjs are from different versions - the fork table" -ForegroundColor Yellow
            Write-Host "   throws rather than shipping a v2 model a rule about a tool it cannot call." -ForegroundColor Yellow
            Write-Host "   Nothing was set as the default agent." -ForegroundColor Yellow
            exit 1
        }

        # ── 3. verify the twelve files actually arrived (the generator printing
        #        a path is the claim; the file on disk is the evidence) ────────
        $rolesMissing = @()
        $cmdsMissing = @()
        foreach ($role in @("Team", "architect", "implementer", "reviewer", "tester", "researcher", "ComputerUser")) {
            if (Test-Path (Join-Path $cfgDir "agents\$role.md")) {
                Write-Host "✔  role    $role" -ForegroundColor Green
            } else {
                $rolesMissing += $role
                Write-Host "!  MISSING role $(Join-Path $cfgDir "agents\$role.md")" -ForegroundColor Yellow
            }
        }
        foreach ($cmd in @("team-plan", "team-implement", "team-review", "team-test", "team-research", "team-run")) {
            if (Test-Path (Join-Path $cfgDir "commands\$cmd.md")) {
                Write-Host "✔  command $cmd" -ForegroundColor Green
            } else {
                $cmdsMissing += $cmd
                Write-Host "!  MISSING command $(Join-Path $cfgDir "commands\$cmd.md")" -ForegroundColor Yellow
            }
        }
        if ($cmdsMissing.Count -gt 0) {
            Write-Host "!  Commands missing: $($cmdsMissing -join ', ') - the roles still work; re-run the" -ForegroundColor Yellow
            Write-Host "   generator after 'opencode plugin update $PKG_NAME' if the list stays short." -ForegroundColor Yellow
        }
        if ($rolesMissing.Count -gt 0) {
            Write-Host "!  Roles missing: $($rolesMissing -join ', ') - refusing to write default_agent." -ForegroundColor Yellow
            Write-Host "   A default naming an agent the host cannot find makes it fall back to 'build'" -ForegroundColor Yellow
            Write-Host "   with no explanation on screen. Re-run this installer once the six role files" -ForegroundColor Yellow
            Write-Host "   exist under $(Join-Path $cfgDir 'agents')." -ForegroundColor Yellow
            exit 1
        }

        # ── 4. default_agent, LAST, and read back ───────────────────────────
        Write-Host "↻  Setting default_agent = Team (last, because the roles are on disk now) ..." -ForegroundColor Yellow
        Invoke-NodeHelper @($surgery, $cfgFile, "default-agent", "Team")
        if ($LASTEXITCODE -ne 0) {
            Write-Host "!  Could not set default_agent. Add it by hand at the top level of $cfgFile :" -ForegroundColor Yellow
            Write-Host '     "default_agent": "Team"' -ForegroundColor Yellow
            exit 1
        }

    # ── 5. the computer-use MCP server (OPT-IN, default off) ────────────────
    # The ORDER is the safety story, and it fails closed at every step:
    #   verify sha256 → uv tool install → `--selftest` must exit 0 → mcp-set.
    # No config byte is written until a server that actually runs exists, and any failure
    # after the install rolls it back. A `mcp` entry whose command the host cannot spawn
    # is a server that never starts, and the host reports it as a timeout — which reads
    # as our bug.
    if ($wantCU) {
        Write-Host ""
        Write-Host "↻  computer-use MCP server (opt-in) ..." -ForegroundColor Yellow
        if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
            Write-Host "!  uv is not on PATH, so there is no way to install the server." -ForegroundColor Yellow
            Write-Host "   Nothing was written. Install uv (https://docs.astral.sh/uv/), then re-run:" -ForegroundColor Yellow
            Write-Host "     .\install.ps1 -ComputerUse" -ForegroundColor Yellow
            exit 1
        }

        # ── 5a. which wheel, and the only hash we will accept ───────────────
        $wheelSrc = $ComputerUseWheel
        if (-not $wheelSrc) { $wheelSrc = $CU_RELEASE_URL }
        $wantSha = $ComputerUseWheelSha256
        if (-not $wantSha) { $wantSha = $CU_WHEEL_SHA256 }
        if ($wantSha -notmatch '^[0-9a-fA-F]{64}$') {
            Write-Host "!  wheel 尚未发布，无法安装 — there is no sha256 to verify against, and this" -ForegroundColor Yellow
            Write-Host "   installer never installs a binary it could not check. Nothing was written." -ForegroundColor Yellow
            Write-Host "   With a wheel you built yourself (computer-use\scripts\build-wheel.ps1):" -ForegroundColor Yellow
            Write-Host "     `$h = (Get-FileHash -Algorithm SHA256 computeruse_mcp-<ver>-py3-none-any.whl).Hash.ToLower()" -ForegroundColor Yellow
            Write-Host "     .\install.ps1 -ComputerUse -ComputerUseWheel <wheel path or https url> -ComputerUseWheelSha256 `$h" -ForegroundColor Yellow
            exit 1
        }

        # ── 5b. materialise it: a path is used as-is; an https asset is downloaded into
        #        the temp dir (never into the repo) and deleted once it is installed ──
        $wheelPath = $wheelSrc
        $downloaded = $false
        if ($wheelSrc -match '^https?://') {
            # The DOWNLOAD MUST KEEP THE ASSET'S FILENAME.  `uv tool install` derives the
            # distribution name, version and Python tag from the FILENAME and refuses
            # anything else ("The wheel filename ... is invalid: Must have a Python tag"),
            # so a guid-named temp file fails even when the bytes and the sha256 are
            # perfect.  That is exactly how the first 0.0.2 install failed: hash verified,
            # install refused, zero config bytes — fail closed, but useless.
            $assetName = ($wheelSrc -split '/')[-1]
            if ($assetName -notmatch '^[A-Za-z0-9_.+-]+\.whl$') { $assetName = "computeruse_mcp-$($CU_VERSION)-py3-none-any.whl" }
            $wheelPath = Join-Path ([IO.Path]::GetTempPath()) $assetName
            Write-Host "↓  downloading $wheelSrc" -ForegroundColor DarkGray
            $prevEap = $ErrorActionPreference
            $ErrorActionPreference = "Continue"
            $okDl = $false
            try { Invoke-WebRequest -Uri $wheelSrc -OutFile $wheelPath -UseBasicParsing; $okDl = $true }
            catch { Write-Host ("!  download failed: " + $_.Exception.Message) -ForegroundColor Yellow }
            finally { $ErrorActionPreference = $prevEap }
            if (-not $okDl) {
                Remove-Item -LiteralPath $wheelPath -Force -ErrorAction SilentlyContinue
                Write-Host "   Nothing was written and nothing was installed." -ForegroundColor Yellow
                exit 1
            }
            $downloaded = $true
        } elseif (-not (Test-Path -LiteralPath $wheelPath)) {
            Write-Host "!  No such wheel: $wheelPath" -ForegroundColor Yellow
            Write-Host "   Nothing was written and nothing was installed." -ForegroundColor Yellow
            exit 1
        }

        # ── 5c. the hash decides. A mismatch deletes the download and stops here. ──
        $gotSha = (Get-FileHash -LiteralPath $wheelPath -Algorithm SHA256).Hash.ToLower()
        if ($gotSha -ne $wantSha.ToLower()) {
            if ($downloaded) { Remove-Item -LiteralPath $wheelPath -Force -ErrorAction SilentlyContinue }
            Write-Host "!  sha256 mismatch — refusing to install:" -ForegroundColor Yellow
            Write-Host "     expected $($wantSha.ToLower())" -ForegroundColor Yellow
            Write-Host "     got      $gotSha" -ForegroundColor Yellow
            Write-Host "   Nothing was written and nothing was installed." -ForegroundColor Yellow
            exit 1
        }
        Write-Host "✔  sha256 verified: $gotSha" -ForegroundColor Green

        # ── 5d. which version is this wheel? The FILENAME says, and uv agrees ──
        # uv reads name / version / python tag out of the wheel FILENAME and refuses anything
        # else, so that filename is the honest source for the version that names the
        # directory — and a filename uv would reject is rejected HERE first, before a single
        # directory is created.
        $cuVer = $null
        $wheelLeaf = Split-Path -Leaf $wheelPath
        $mWheel = [regex]::Match($wheelLeaf, '^(?<name>[A-Za-z0-9](?:[A-Za-z0-9._+-]*[A-Za-z0-9])?)-(?<ver>[0-9][A-Za-z0-9._!+~]*?)-(?<py>[A-Za-z0-9_]+)-(?<abi>[A-Za-z0-9_]+)-(?<plat>[A-Za-z0-9_]+)\.whl$')
        if ($mWheel.Success) { $cuVer = $mWheel.Groups['ver'].Value }
        if (-not $cuVer) {
            if ($downloaded) { Remove-Item -LiteralPath $wheelPath -Force -ErrorAction SilentlyContinue }
            Write-Host "!  读不出 wheel 的版本号：$wheelLeaf" -ForegroundColor Yellow
            Write-Host "   「一个版本一个目录」是这套升级机制的骨架，而版本只能取自文件名（uv 自己也是这么读的）。" -ForegroundColor Yellow
            Write-Host "   保持发行资产的文件名：computeruse_mcp-<版本>-py3-none-any.whl" -ForegroundColor Yellow
            Write-Host "   Nothing was written and nothing was installed." -ForegroundColor Yellow
            exit 1
        }

        $cuRoot = CU-ReleasesRoot
        $cuVerDir = Join-Path $cuRoot $cuVer
        $cuCurrent = CU-ReadJson (Join-Path $cuRoot "current.json")
        $cuStillRunning = "（配置里还没有 mcp.computeruse 条目）"
        if ($cuCurrent -and $cuCurrent.exe) { $cuStillRunning = "$($cuCurrent.version) → $($cuCurrent.exe)" }
        Write-Host "   releases: $cuRoot" -ForegroundColor DarkGray
        Write-Host "   本次目标: $cuVerDir" -ForegroundColor DarkGray

        # ── 5e. install into <releases>/<version>, a directory NOTHING is holding ──
        # UV_TOOL_DIR IS the version directory now, so this path no longer honours a
        # caller's UV_TOOL_DIR: nesting a non-tool directory inside uv's own tool dir is how
        # `uv tool list` learned to print "Ignoring malformed tool `bin`". The override it
        # does honour is TEAMMODE_CU_RELEASE_DIR, and everything it writes — venv, shim,
        # receipt — stays under that one root, so the undo and the reclaim are both "delete a
        # directory", never "reach into the user's real uv state".
        $cuReceipt = CU-ReadJson (Join-Path $cuVerDir "receipt.json")
        $alreadyAt = [bool]((CU-FindExe $cuVerDir) -and $cuReceipt -and
            ("$($cuReceipt.version)" -eq $cuVer) -and
            (("$($cuReceipt.wheel_sha256)").ToLower() -eq $gotSha))
        $cuCreatedDir = $false
        $inst = 0
        if ($alreadyAt) {
            # Idempotence, and it is a real skip: no uv run, no new files. The config still
            # goes through mcp-set below, because the helper itself writes NOTHING when the
            # entry already has these exact bytes and says 已存在，未改动 when it did.
            Write-Host "OK  already at $cuVer — 该版本目录已有通过 --selftest 的 receipt、wheel 哈希一致：不重跑 uv tool install" -ForegroundColor Green
            if ($downloaded) { Remove-Item -LiteralPath $wheelPath -Force -ErrorAction SilentlyContinue; $downloaded = $false }
        } else {
            $prevEap = $ErrorActionPreference
            $ErrorActionPreference = "Continue"
            if (-not (Test-Path -LiteralPath $cuVerDir)) {
                New-Item -ItemType Directory -Path $cuVerDir -Force | Out-Null
                $cuCreatedDir = $true
            }
            $env:UV_TOOL_DIR = $cuVerDir
            # ALWAYS set together with UV_TOOL_DIR: uv's own default shim dir on Windows is
            # `%USERPROFILE%\.local\bin` (measured: `uv tool dir --bin`), and a shim landing
            # there is a second place to clean and the exact pollution this layout avoids.
            $env:UV_TOOL_BIN_DIR = Join-Path $cuVerDir "bin"
            $cuOut = & uv tool install --force $wheelPath 2>&1
            $inst = $LASTEXITCODE
            $ErrorActionPreference = $prevEap
            $cuOut | Out-Host
            if ($downloaded) { Remove-Item -LiteralPath $wheelPath -Force -ErrorAction SilentlyContinue; $downloaded = $false }
            if ($inst -ne 0) {
                if (($cuOut -join "`n") -match 'os error 32|os error 5|另一个程序正在使用|拒绝访问') {
                    Write-Host "!  占用发生在本次的目标目录本身：$cuVerDir" -ForegroundColor Yellow
                    Write-Host "   新机制不会走到这里，除非同一个版本号被重复构建、而旧进程正是从这个目录跑起来的。" -ForegroundColor Yellow
                    Write-Host "   处理：先 opencode service restart 释放它，或按新版本号重新构建，再重跑本条命令。" -ForegroundColor Yellow
                }
                Write-Host "!  uv tool install failed (exit $inst) — no config byte was written." -ForegroundColor Yellow
                Write-Host "   mcp.computeruse 没有改动，仍在跑的是：$cuStillRunning" -ForegroundColor Yellow
                exit 1
            }
        }

        # ── 5f. the entry point must EXIST and ANSWER `--selftest`, and only then
        #        does the config move ─────────────────────────────────────────────
        # The tool directory inside the version dir is named after the DISTRIBUTION
        # (`computeruse-mcp`, measured), not after the console script, so scan instead of
        # guessing one spelling.
        $exe = CU-FindExe $cuVerDir
        $toolName = $null
        if ($exe) { $toolName = Split-Path -Leaf (Split-Path -Parent (Split-Path -Parent $exe)) }
        # Rollback is stated once and used by both failure legs. It is a DIRECTORY delete
        # scoped to the version directory THIS run created — deliberately not
        # `uv tool uninstall`: that command resolves UV_TOOL_DIR itself, and in the
        # `already at` leg we never set it, so it would reach the user's REAL tool dir and
        # remove the server that is currently working. Nothing here kills a process; a
        # directory something is running from is left exactly as it is.
        $cuRollback = {
            if ($cuCreatedDir -and (Test-Path -LiteralPath $cuVerDir)) {
                # CU-DirInUse answers a VERDICT, so the test is on .InUse (a hashtable is
                # always truthy — an if on the raw object would keep every directory and say
                # a process is running when none was hit), and the sentence carries the
                # verdict's own reason: hit-with-pid, or no-hit-evidence-but-conservative.
                $rbUse = CU-DirInUse $cuVerDir
                if ($rbUse.InUse) {
                    Write-Host "   版本目录留着不动（$($rbUse.Reason)）：$cuVerDir" -ForegroundColor Yellow
                } else {
                    try { Remove-Item -LiteralPath $cuVerDir -Recurse -Force; Write-Host "   本次新建的版本目录已删除：$cuVerDir" -ForegroundColor Yellow }
                    catch { Write-Host "!  版本目录删不掉，留着不动：$cuVerDir — $($_.Exception.Message)" -ForegroundColor Yellow }
                }
            } elseif ($alreadyAt) {
                # The receipt claimed "this directory passes --selftest", and it just did
                # not. Dropping the claim is what makes the NEXT run reinstall and
                # re-verify instead of trusting a record this machine contradicted.
                $rc = Join-Path $cuVerDir "receipt.json"
                if (Test-Path -LiteralPath $rc) {
                    Remove-Item -LiteralPath $rc -Force -ErrorAction SilentlyContinue
                    Write-Host "   receipt 已删除（$cuVer 的 --selftest 这次没通过）：下一次安装会重装并重新验证" -ForegroundColor Yellow
                }
                Write-Host "   版本目录本身保持原样：$cuVerDir（$toolName）" -ForegroundColor Yellow
            }
            Write-Host "   Nothing was written to $cfgFile — 仍在跑的仍是：$cuStillRunning" -ForegroundColor Yellow
        }
        if (-not $exe) {
            Write-Host "!  Installed, but no computeruse entry point appeared under $cuVerDir" -ForegroundColor Yellow
            & $cuRollback
            exit 1
        }
        Write-Host "   entry: $exe" -ForegroundColor DarkGray
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        & $exe --selftest | Out-Host
        $st = $LASTEXITCODE
        $ErrorActionPreference = $prevEap
        if ($st -ne 0) {
            Write-Host "!  `"$exe`" --selftest exited $st, so this server does not work on this machine" -ForegroundColor Yellow
            Write-Host "   (its own output is above; the usual cause is a session without a real desktop:" -ForegroundColor Yellow
            Write-Host "    the selftest reports dpi_aware=false there). Nothing was written." -ForegroundColor Yellow
            Write-Host "   配置条目未改动 —— 仍是旧版本在跑：$cuStillRunning" -ForegroundColor Yellow
            & $cuRollback
            exit 1
        }
        Write-Host "✔  --selftest exited 0: the server runs here" -ForegroundColor Green

        # An ABSOLUTE path, never the bare name: the host spawns this argv itself and we do
        # not control its working directory or PATH. timeout 60000 because the host default
        # (5000 ms) is shorter than a cold Python start.
        # THE PATH IS VERSIONED, AND THAT IS THE POINT: this one edit is the upgrade. It is
        # the only thing that has to move, because the new bytes never touch the old
        # directory; after ONE host restart the entry resolves to the new server.
        $mcpJson = ([ordered]@{
            type        = "local"
            command     = @($exe, "--budget", "200")
            environment = @{}
            enabled     = $true
            timeout     = 60000
        } | ConvertTo-Json -Compress -Depth 4)
        # The JSON cannot ride as an argv element here: Windows PowerShell 5.1 strips the
        # embedded double quotes when it re-quotes a native command's arguments, and the
        # helper then reads `{type:local,...}` and refuses (measured, not assumed). The
        # env var carries the same string byte-exactly.
        $env:TM_MCP_SPEC = $mcpJson
        try { Invoke-NodeHelper @($surgery, $cfgFile, "mcp-set", "computeruse") }
        finally { Remove-Item Env:\TM_MCP_SPEC -ErrorAction SilentlyContinue }
        if ($LASTEXITCODE -ne 0) {
            Write-Host "!  The mcp.computeruse entry is not in $cfgFile - nothing further is claimed." -ForegroundColor Yellow
            Write-Host "   Add it by hand under `"mcp`": { `"computeruse`": { `"type`": `"local`", `"command`": [`"$exe`", `"--budget`", `"200`"], `"enabled`": true, `"timeout`": 60000 } }" -ForegroundColor Yellow
            Write-Host "   条目没落地，所以 current.json / receipt.json 都不写：下一次安装会把这目录当作未验证的重装。" -ForegroundColor Yellow
            exit 1
        }
        # The two runtime records, written only after the helper's own read-back passed:
        # receipt.json = "this directory is a verified install of these wheel bytes" (the
        # idempotence key), current.json = "the config entry points here" (the reclaim's
        # do-not-touch marker). Neither one reads or rewrites the host config.
        $cuNow = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        CU-WriteJson (Join-Path $cuVerDir "receipt.json") ([ordered]@{
            version      = $cuVer
            exe          = $exe
            wheel        = $wheelLeaf
            wheel_sha256 = $gotSha
            selftest     = "exit 0"
            installed_at = $cuNow
        })
        CU-WriteJson (Join-Path $cuRoot "current.json") ([ordered]@{
            version      = $cuVer
            exe          = $exe
            wheel_sha256 = $gotSha
            config       = $cfgFile
            updated_at   = $cuNow
        })
        # An upgrade cleans up after itself. The previous version is now unreferenced and
        # usually STILL LOADED by the running host, which the pass reports as a keep with a
        # reason — the next install, after the restart, is what takes it.
        Write-Host "↻  回收旧版本目录 …" -ForegroundColor DarkGray
        CU-ReclaimReleases -Root $cuRoot -CurrentVersion $cuVer -CfgFiles @($cfgFile, $legacy)
        Write-Host ""
        Write-Host "✔  computer-use $cuVer 已就位 —— 只差一次重启（不是两次）" -ForegroundColor Green
        Write-Host "   opencode service restart   # 旧进程随宿主退出，新条目指向上面那个 exe" -ForegroundColor DarkGray
        # A thing this script wrote must be removable without re-reading its source, so the
        # undo is printed as steps, in the order they have to be done.
        Write-Host ""
        Write-Host "   撤销 computer-use:" -ForegroundColor DarkGray
        Write-Host "     1. 删掉 $cfgFile 里的 mcp.computeruse 那一项：" -ForegroundColor DarkGray
        Write-Host "        node `"$surgery`" `"$cfgFile`" mcp-remove computeruse" -ForegroundColor DarkGray
        Write-Host "     2. 删掉这套机制装的全部版本：Remove-Item -Recurse -Force `"$cuRoot`"" -ForegroundColor DarkGray
        Write-Host "        （只回收旧版本： .\install.ps1 -ComputerUseReclaim —— 逐条报理由，运行中的目录绝不删）" -ForegroundColor DarkGray
        Write-Host "        （旧布局的安装在 uv 自己的工具目录里： uv tool uninstall computeruse-mcp）" -ForegroundColor DarkGray
        Write-Host "     3. 重启 OpenCode：opencode service restart" -ForegroundColor DarkGray
        Write-Host "        （可选，清掉审计轨：Remove-Item -Recurse -Force `"$env:LOCALAPPDATA\te-river\computeruse`"）" -ForegroundColor DarkGray
    }

    # No scratch file to clean: the surgery is the shipped scripts\lib\config-surgery.cjs,
    # shared with install.sh. Deleting a temp copy of it used to be the point of a finally
    # block; deleting the shipped helper would not be.

    # ── 6. the 2.x checklist ────────────────────────────────────────────────
    $cmdCount = @(Get-ChildItem (Join-Path $cfgDir "commands") -Filter "team-*.md" -ErrorAction SilentlyContinue).Count
    $staleFlag = [Environment]::GetEnvironmentVariable($bgFlag, "User")
    Write-Host ""
    Write-Host "── 2.x checklist ─────────────────────────────────────────────────────────────" -ForegroundColor Cyan
    Write-Host "   roles    : 7/7 files under $(Join-Path $cfgDir 'agents')" -ForegroundColor DarkGray
    Write-Host "   commands : $cmdCount/6 found under $(Join-Path $cfgDir 'commands\team-*.md') (a hand-" -ForegroundColor DarkGray
    Write-Host "              written file the generator refused to overwrite shows short here)" -ForegroundColor DarkGray
    Write-Host "   default  : default_agent = Team, read back from $cfgFile" -ForegroundColor DarkGray
    Write-Host "   env vars : NONE needed. $bgFlag is a 1.18.x workaround; on 2.x" -ForegroundColor DarkGray
    Write-Host "              sub-agents are background natively and the plugin forces" -ForegroundColor DarkGray
    Write-Host "              background:true on every dispatch, so setting it changes nothing" -ForegroundColor DarkGray
    Write-Host "              here and only makes the picture harder to read." -ForegroundColor DarkGray
    if (@("1", "true", "yes", "on") -contains ("$staleFlag").ToLower()) {
        Write-Host "              It IS set for your user — undo it when convenient:" -ForegroundColor Yellow
        Write-Host "              REG delete HKCU\Environment /v $bgFlag /f" -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "✔  Done! Restart OpenCode to activate (or run: opencode service restart)." -ForegroundColor Green
    Write-Host "   Then check, in this order:" -ForegroundColor DarkGray
    Write-Host "     1. opencode agents            → team, architect, implementer, reviewer," -ForegroundColor DarkGray
    Write-Host "                                     tester, researcher" -ForegroundColor DarkGray
    Write-Host "     2. a NEW session is Team      → ask it to run tm_stats and read its" -ForegroundColor DarkGray
    Write-Host "                                     启动与人格 (boot & personality) section." -ForegroundColor DarkGray
    Write-Host '     3. tm_ledger {action:"add",text:"smoke"} → an id + 已写入 ctx.storage' -ForegroundColor DarkGray
    Write-Host ""
}

# Opt-in twice over: the switch, or TEAMMODE_COMPUTER_USE=1 for the `irm … | iex` path
# that cannot pass a switch at all. Default OFF. Resolved HERE, before the dispatch,
# because Install-V2 reads it and the 1.18.x path has to REFUSE it before writing anything.
$wantCU = [bool]$ComputerUse -or (@("1", "true", "yes", "on") -contains ("$env:TEAMMODE_COMPUTER_USE").ToLower())

if ($OpenCodeMajor -ge 2) {
    Install-V2
    # `return`, not `exit`: the documented entry point is `irm … | iex`, and an
    # exit inside a pasted install would close the window the user is reading
    # the result in. The 1.18.x body below is still never reached from here.
    return
}
if ($wantCU) {
    Write-Host ""
    Write-Host "!  -ComputerUse is implemented on the OpenCode 2.x path only (this machine takes the" -ForegroundColor Yellow
    Write-Host "   1.18.x path). mcp.computeruse is a 2.x config shape with no measured 1.18.x" -ForegroundColor Yellow
    Write-Host "   equivalent, so NOTHING was written. Re-run with -ComputerUse once the host is 2.x." -ForegroundColor Yellow
    exit 1
}
if ($ComputerUseReclaim) {
    Write-Host ""
    Write-Host "!  -ComputerUseReclaim 也是 2.x 路径的功能：它回收的是本安装器写的" -ForegroundColor Yellow
    Write-Host "   <releases>/<版本>/ 目录，而 1.18.x 路径从不装它们。这条机器走 1.18.x，所以" -ForegroundColor Yellow
    Write-Host "   一个文件都没有读、没有删。宿主升到 2.x 后再跑一次即可。" -ForegroundColor Yellow
    exit 1
}
if ($OpenCodeWhy) {
    Write-Host "ℹ  $OpenCodeWhy — taking the 1.18.x path (the one this installer always had)." -ForegroundColor Yellow
} else {
    Write-Host "ℹ  OpenCode $OpenCodeVersion detected — taking the 1.18.x path." -ForegroundColor Yellow
}

# ── patch config ────────────────────────────────────────────────────────────
# opencode.jsonc is the canonical name and OVERRIDES opencode.json when both
# exist — so we ALWAYS target the .jsonc: patch it when present, and when only
# an opencode.json exists, migrate its content into a new opencode.jsonc first
# (writing the .json instead would risk our entry being shadowed).
$CFG_DIR = Join-Path $env:USERPROFILE ".config\opencode"
$CFG_FILE = Join-Path $CFG_DIR "opencode.jsonc"
$LEGACY = Join-Path $CFG_DIR "opencode.json"

if (-not (Test-Path $CFG_DIR)) {
    New-Item -ItemType Directory -Path $CFG_DIR -Force | Out-Null
}
if ((-not (Test-Path $CFG_FILE)) -and (Test-Path $LEGACY)) {
    Copy-Item $LEGACY $CFG_FILE
    Write-Host "ℹ  Migrated opencode.json → opencode.jsonc (jsonc takes precedence; the original .json is left untouched)" -ForegroundColor Yellow
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

# ── update: purge the stale plugin cache (OpenCode never re-resolves @latest) ──
# OpenCode loads the plugin from THIS cache, NOT from ~/.config/opencode/node_modules.
# Two cache layouts exist under packages/ — scoped:
# packages\@te-river\opencode-team-mode@latest, and flat:
# packages\@te_river+opencode-team-mode@latest. A top-level glob never sees the
# scoped copy nested below @te-river\ (the top item is "@te-river", which does
# not contain "opencode-team-mode") → the upgrade silently keeps loading the old
# cached version. Recurse so BOTH layouts match; the @te-river\ scope dir itself
# is left in place.
$cacheRoots = @(
    (Join-Path $env:USERPROFILE ".cache\opencode\packages"),
    (Join-Path $env:LOCALAPPDATA "opencode\cache\packages")
)
foreach ($root in $cacheRoots) {
    if (Test-Path $root) {
        $stale = Get-ChildItem -Path $root -Directory -Recurse -Filter "*opencode-team-mode*" -ErrorAction SilentlyContinue
        # Parents before their nested matches (Sort by path length): a bundled
        # node_modules\@te-river\opencode-team-mode inside a matched dir vanishes
        # with its parent — SilentlyContinue absorbs the vanished child.
        foreach ($d in ($stale | Sort-Object { $_.FullName.Length })) {
            Remove-Item -Recurse -Force $d.FullName -ErrorAction SilentlyContinue
        }
        # Re-enumerate AFTER deleting: a survivor means the delete genuinely
        # failed (e.g. file lock while OpenCode runs) -> warn, never false-green.
        # Children that vanished with their parent are simply absent from this
        # listing, so there is no duplicate or spurious report either.
        $left = Get-ChildItem -Path $root -Directory -Recurse -Filter "*opencode-team-mode*" -ErrorAction SilentlyContinue
        if ($left) {
            Write-Host "!  Could not fully purge (quit OpenCode, then re-run): $($left.FullName -join ', ')" -ForegroundColor Yellow
        } else {
            Write-Host "✔  Purged stale plugin cache" -ForegroundColor Green
        }
    }
}

# ── update: npm-installed copy in the config dir? re-resolve its pinned lock ──
$nmCopy = Join-Path $CFG_DIR "node_modules\@te-river\opencode-team-mode"
if (Test-Path $nmCopy) {
    Write-Host "↻  Re-resolving npm-installed plugin in $CFG_DIR ..." -ForegroundColor Yellow
    Push-Location $CFG_DIR
    try {
        npm install "@te-river/opencode-team-mode@latest" --no-fund --no-audit
        if ($LASTEXITCODE -eq 0) { Write-Host "✔  npm copy updated" -ForegroundColor Green }
        else { Write-Host "!  npm re-resolve failed (non-fatal — cache purge + restart is usually enough)" -ForegroundColor Yellow }
    } finally {
        Pop-Location
    }
}

# ── the host's VISIBLE sub-agent: OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS ─
# Why this is here: `task { background: true }` is the only sub-agent OpenCode
# can show you — its card links to the live child session, it does not block the
# lead, and the host wakes the parent with the result. TeamMode keeps that
# result inside the token budget (TM_TASK_OFFLOAD). The flag is read from the
# HOST process environment at startup, so a plugin cannot set it for itself —
# it has to exist before OpenCode launches. It is an experimental OpenCode
# switch, and this writes a user-level environment variable, so it is said out
# loud here and it is reversible:
#   skip it:   .\install.ps1 -NoBackgroundSubagents   (or set
#              TEAMMODE_SKIP_BACKGROUND_SUBAGENTS=1 for a piped install)
#   undo it:   REG delete HKCU\Environment /v OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS /f
$BG_FLAG = "OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS"
$bgSkip = [bool]$NoBackgroundSubagents -or @("1","true","yes","on") -contains ("$env:TEAMMODE_SKIP_BACKGROUND_SUBAGENTS").ToLower()
if ($bgSkip) {
    Write-Host "-  Left $BG_FLAG alone (opt-out): the host's task tool will block the lead, and its sub-agent cards stay non-background. Re-run without -NoBackgroundSubagents to enable." -ForegroundColor Yellow
} else {
    $cur = [Environment]::GetEnvironmentVariable($BG_FLAG, "User")
    if (@("1","true","yes","on") -contains ("$cur").ToLower()) {
        Write-Host "✔  $BG_FLAG already set for your user" -ForegroundColor Green
    } else {
        Write-Host "↻  Setting $BG_FLAG=true for this user (enables the visible background sub-agent) ..." -ForegroundColor Yellow
        $null = & cmd.exe /c setx $BG_FLAG true 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "!  setx failed (exit $LASTEXITCODE) — set it yourself, or launch OpenCode from a shell that exports it:" -ForegroundColor Yellow
            Write-Host "   `$env:$BG_FLAG='true'; & `"$env:LOCALAPPDATA\Programs\@opencode-aidesktop\OpenCode.exe`"" -ForegroundColor Yellow
        } else {
            $after = [Environment]::GetEnvironmentVariable($BG_FLAG, "User")
            if ($after -eq "true") {
                Write-Host "✔  $BG_FLAG=true written to HKCU\Environment (takes effect on the next full restart of OpenCode)" -ForegroundColor Green
            } else {
                Write-Host "!  setx reported success but the value did not read back — set it manually (System > Advanced > Environment Variables)" -ForegroundColor Yellow
            }
        }
    }
}

# ── done ────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "✔  Done! Restart OpenCode Desktop to activate." -ForegroundColor Green
Write-Host "   Self-check after the restart, in any session: ask the agent to run tm_stats" -ForegroundColor DarkGray
Write-Host "   and look for the row '宿主后台 task 注入' — it proves which plugin build loaded" -ForegroundColor DarkGray
Write-Host "   and whether the background sub-agent channel is live." -ForegroundColor DarkGray
Write-Host ""
