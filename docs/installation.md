# TeamMode Installation Guide / 安装指南

> **For LLM agents:** your user asked you to install `@te-river/opencode-team-mode`. This document is the complete, self-contained procedure. Read it fully, then execute. Do not improvise package names or config locations — everything you need is here.
>
> **面向 LLM 智能体：** 用户要求你安装 `@te-river/opencode-team-mode`。本文档是完整、自包含的安装规程。通读后再执行。不要 improvised 包名或配置路径——所需信息全在这里。

---

## Part A — English

### What you are installing

An OpenCode plugin that injects a **six-agent development team** (Team Lead, Architect, Implementer, Reviewer, Tester, Researcher) plus six slash commands and nine governed `tm_*` tools into the user's OpenCode. npm package: [`@te-river/opencode-team-mode`](https://www.npmjs.com/package/@te-river/opencode-team-mode). It runs entirely locally; no telemetry, no API keys.

### Step 1 — Locate the OpenCode config file

**`opencode.jsonc` is the canonical name and OVERRIDES `opencode.json` when
both exist — always prefer writing the `.jsonc`.**

1. **Global config:** `~/.config/opencode/opencode.jsonc` (Windows: `C:\Users\<user>\.config\opencode\opencode.jsonc`) — patch it when present.
2. If only an `opencode.json` exists in that directory, **migrate**: copy its full content into a new `opencode.jsonc` and add the plugin entry there (leave the original `.json` untouched — the migration guarantees nothing is lost).
3. If neither exists, create the global `opencode.jsonc` fresh so the team is available in every project.

### Step 2 — Add the plugin entry

Merge (do not replace unrelated keys) into the config's `"plugin"` array:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@te-river/opencode-team-mode@latest"
  ]
}
```

If a `"plugin"` array already exists, append the string to it. If the entry is already present, the user may want an **update** instead — see Updating below.

### Step 3 — Restart OpenCode

The plugin is resolved and loaded **once at startup**. The user must fully quit and restart OpenCode (Desktop: quit from the tray/menu, not just close the window; CLI: restart the `opencode` process).

### Network note (mainland China)

This guide is served from `raw.githubusercontent.com`, which is often
unreachable from mainland-China networks. If fetching it fails, retry with
the mirror prefix — `https://ghproxy.net/` + the same full URL. Both hosts
are on TeamMode's seeded `tm_webfetch` allowlist, so the governed fetch tool
can read either. After the plugin is installed and OpenCode restarted, the
same guide also ships inside the package, under whichever cache layout this
machine uses: scoped
`<opencode-cache>/packages/@te-river/opencode-team-mode@<version>/docs/installation.md`
or flat `<opencode-cache>/packages/@te_river+opencode-team-mode@<version>/docs/installation.md`.

### Step 4 — Verify

After restart, verify in this order:

1. The agent picker (`@` mentions) lists: **team, architect, implementer, reviewer, tester, researcher**.
2. Slash commands `/team-plan`, `/team-implement`, `/team-review`, `/team-test`, `/team-research`, `/team-run` autocomplete.
3. Definitive check for the **running** build: ask an agent to run `tm_stats` and look at which rows appear. `npm view … version` queries the registry, not what OpenCode loads, so it misleads after an update; reading a `package.json` proves only the file, not the loaded code. A feature row (e.g. `宿主后台 task 注入`) either renders or it does not — that is the running build. Finally, ask the user to start a chat and confirm the **team** agent responds.

> **Where the loaded copy actually lives.** Under `~/.cache/opencode/packages/` the
> scoped layout is a **wrapper directory**: `packages/@te-river/opencode-team-mode@latest/`
> holds only `package.json` (`{"dependencies": {"@te-river/opencode-team-mode": "<version>"}}`),
> a `package-lock.json` and `node_modules/` — **the real package is the nested
> `…@latest/node_modules/@te-river/opencode-team-mode/`**, and that is the copy
> whose `dist/` executes. Overwriting a `dist/` at the wrapper root, or the one
> under `~/.config/opencode/node_modules/`, does nothing. (Costly to learn: it
> was found by a `tm_stats` row that refused to appear.)

Report which checks passed. If verification fails, see Troubleshooting.

### Step 5 — the visible sub-agent (the installer enables this)

OpenCode's own `task { background: true }` is the only sub-agent its interface
can **show**: the card links to the live child session, it does not block the
lead, and the host wakes the parent with the result. TeamMode then keeps that
result inside the token budget (`TM_TASK_OFFLOAD`).

It rides an OpenCode **experimental flag** read from the host process
environment at startup, so a plugin cannot set it — the installer writes it for
you:

| Platform | What the installer does | Revert |
|---|---|---|
| Windows | `setx OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS true` (user scope, survives reboot) | `REG delete HKCU\Environment /v OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS /f` |
| macOS | `launchctl setenv …` — reaches GUI apps this login, **not** after a logout | `launchctl unsetenv OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` |
| Linux | `systemctl --user set-environment …` when a user session exists, else prints the `export` line | `systemctl --user unset-environment OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` |

Skip it entirely: run `install.ps1 -NoBackgroundSubagents`, or set
`TEAMMODE_SKIP_BACKGROUND_SUBAGENTS=1` for a piped install. Without the flag
nothing breaks — `task` simply blocks the lead, and TeamMode's own
`tm_dispatch` / `tm_join` remains the non-blocking batch path.

Cost, stated plainly: each finished background task wakes the lead and costs a
turn, and the host injects the child's reply verbatim until TeamMode replaces
an oversized one with a preview + pointer.


### Updating

> ⚠️ **OpenCode loads the plugin from this spec-string cache under
> `~/.cache/opencode/packages/` — NOT from the `~/.config/opencode/node_modules`
> copy.** The cache dir has two layouts: **scoped**
> (`packages/@te-river/opencode-team-mode@latest/`, observed on real machines)
> and **flat** (`packages/@te_river+opencode-team-mode@latest/`). A purge that
> only globs the *top level* of `packages/` never sees the scoped copy nested
> inside `@te-river/` — the upgrade then **silently fails** and OpenCode keeps
> loading the old version after restart. **The purge must RECURSE down to the
> `@te-river` scope layer** (both installers now do).

> The installer is idempotent: **re-running it IS the update.** It re-patches
> the config (no-op when present), recursively purges the stale plugin cache
> (both layouts), and re-resolves any npm-installed copy. This exists because
> OpenCode caches plugins by spec string
> (`~/.cache/opencode/packages/<scope>/<name>@latest`) and
> does not re-resolve `@latest` when a new version publishes (upstream
> limitation).

**Path 1 — re-run the one-line installer:**

macOS / Linux (bash):

```bash
curl -fsSL https://ghproxy.net/https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/scripts/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://ghproxy.net/https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/scripts/install.ps1 | iex
```

**Path 2 — let an agent do it.** Paste this to any coding agent:

```text
Update the OpenCode plugin @te-river/opencode-team-mode following
https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/docs/installation.md
(the "Updating" section), then verify the install using the checks in that guide.
```

**Path 3 — manual** (what the scripts automate):

1. Delete the cached package directory — **recursively**, covering BOTH layouts:
   scoped `~/.cache/opencode/packages/@te-river/opencode-team-mode@latest` and
   flat `~/.cache/opencode/packages/@te_river+opencode-team-mode@latest` (the
   scoped one is what a top-level glob misses):

   ```bash
   # macOS / Linux — GNU/BSD-safe POSIX form (`xargs -r` is GNU-only and fails
   # on macOS). -prune lists each match without descending into it, so a
   # bundled node_modules/@te-river/opencode-team-mode never appears (its
   # parent rm already took it)
   find ~/.cache/opencode/packages -type d -name '*opencode-team-mode*' -prune -exec rm -rf {} +
   ```

   ```powershell
   # Windows PowerShell — run for BOTH roots; Test-Path guards each, because
   # the second root often does not exist (avoids red error noise).
   # Sort by path length = parents first; vanished children absorbed by SilentlyContinue.
   foreach ($root in "$HOME\.cache\opencode\packages", "$env:LOCALAPPDATA\opencode\cache\packages") {
     if (Test-Path $root) {
       Get-ChildItem -Path $root -Directory -Recurse -Filter '*opencode-team-mode*' -ErrorAction SilentlyContinue |
         Sort-Object { $_.FullName.Length } |
         Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
     }
   }
   ```

   Both commands delete the `@latest` dirs in either layout and leave the
   `@te-river` scope directory itself in place.
2. If the plugin was also npm-installed into `~/.config/opencode` (check its `package.json` / `package-lock.json`), run `npm install @te-river/opencode-team-mode@latest` there.
3. Restart OpenCode and re-verify — see **Verifying the update actually took
   effect** below.

#### Verifying the update actually took effect

1. Fully quit and restart OpenCode (the plugin loads once at startup).
2. **Do not trust `npm view @te-river/opencode-team-mode version`** — it
   queries the npm registry and reports the latest *published* version even
   when OpenCode is still loading the stale cache. Confirm the **running**
   version instead:
   - Read the `version` field of the cache directory's `package.json` after
     the restart re-resolves it —
     `~/.cache/opencode/packages/@te-river/opencode-team-mode@latest/package.json`
     (scoped) or
     `~/.cache/opencode/packages/@te_river+opencode-team-mode@latest/package.json`
     (flat). That file is what OpenCode just loaded; compare it with `npm view`.
   - Or probe a feature that only exists in the new version — e.g. have an
     agent call `tm_memory` with `action: compact`: builds without the memory
     compaction release reject the unknown action.
3. Still the old version? Re-run the recursive delete from step 1 — a
   non-recursive glob that misses the `@te-river` scope layer is the usual
   culprit — then restart again.

### Manual, script-free procedure (fallback if the installer is unavailable or misbehaves)

The one-line installer only automates the steps below — you can do all of them
by hand. Run the full sequence for a fresh install; for an update, **step 2
(recursive cache purge) is the part that matters** (a stale `@latest` cache is
never re-resolved on its own).

1. **Point the config at the plugin.** Ensure `~/.config/opencode/opencode.jsonc`
   exists (if only `opencode.json` is present, copy it to `.jsonc` first — the
   `.jsonc` wins) and that its `"plugin"` array contains the entry. Merge, don't
   clobber unrelated keys:
   ```jsonc
   { "$schema": "https://opencode.ai/config.json",
     "plugin": ["@te-river/opencode-team-mode@latest"] }
   ```
2. **Purge any stale cache — recursively, both layouts.** OpenCode loads from
   `~/.cache/opencode/packages/` and caches by spec string, so a previously
   cached `@latest` is NOT refreshed on its own. A top-level glob misses the
   scoped copy nested under `@te-river/` — recurse:
   - macOS / Linux (GNU/BSD-safe; `-prune` lists each match without descending):
     ```bash
     find ~/.cache/opencode/packages -type d -name '*opencode-team-mode*' -prune -exec rm -rf {} +
     ```
   - Windows PowerShell (run for BOTH roots; `Test-Path` guards the often-missing
     second; parents deleted before their nested matches):
     ```powershell
     foreach ($root in "$HOME\.cache\opencode\packages", "$env:LOCALAPPDATA\opencode\cache\packages") {
       if (Test-Path $root) {
         Get-ChildItem $root -Directory -Recurse -Filter '*opencode-team-mode*' -ErrorAction SilentlyContinue |
           Sort-Object { $_.FullName.Length } |
           Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
       }
     }
     ```
3. **Resolve it with npm** (also fixes a `package-lock.json` pin in the config
   dir): `cd ~/.config/opencode && npm install @te-river/opencode-team-mode@latest`.
   If that dir has no `package.json`, OpenCode resolves `@latest` from the config
   entry on next start — this step is then optional but harmless.
4. **Fully quit and restart OpenCode** (tray/menu quit, not just closing the
   window) — the plugin loads once at startup.
5. **Verify the RUNNING version** — read the cached `package.json`'s `version`,
   or probe a new-version-only feature (`tm_memory action: compact`). Do **not**
   trust `npm view` alone (it reports the registry, not what OpenCode loaded).

### Uninstalling

1. Remove the entry from the `"plugin"` array in the config file(s) you edited.
2. Delete the cache directory (path above) if you want to reclaim the disk space.
3. Restart OpenCode — the agents, commands and tools disappear.

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Agents don't appear | OpenCode not restarted, or config file is the wrong one | Fully restart; confirm the file you edited is the one OpenCode loads |
| Version is old despite `@latest` | Plugin cache never invalidates | See Updating — delete the cache dir (recursively; both layouts) |
| Still the old version after bumping the version or re-running the installer | The scoped cache `packages/@te-river/opencode-team-mode@latest` is nested below the top-level `packages/*opencode-team-mode*` glob, so the stale copy was never purged | Recursively delete that cache dir (`Get-ChildItem -Recurse -Filter '*opencode-team-mode*'` / `find -type d -name '*opencode-team-mode*' -prune`), then restart — the current installers already recurse |
| Node version error on startup | npm needs Node ≥ 18 | Upgrade Node |
| Env-var commands suddenly prompt for confirmation | That's the plugin's R6 protection working as designed | Approve once per operation, or set `TM_ENV_PROTECT=off` (not recommended) |
| A user-defined agent named `team`/`architect`/… got shadowed | Plugin injects defaults; your own definitions always win | The plugin never clobbers user agents — check for typos in your agent names |

---

## Part B — 中文

### 你在安装什么

一个 OpenCode 插件，向用户的 OpenCode 注入**六人开发团队**（Team Lead、Architect、Implementer、Reviewer、Tester、Researcher）+ 六个斜杠命令 + 九个受治理的 `tm_*` 工具。npm 包：[`@te-river/opencode-team-mode`](https://www.npmjs.com/package/@te-river/opencode-team-mode)。完全本地运行，无遥测、无 API Key。

### 第 1 步 — 找到 OpenCode 配置文件

**`opencode.jsonc` 是规范文件名，与 `opencode.json` 并存时以 jsonc 为准——始终优先写 `.jsonc`。**

1. **全局配置：** `~/.config/opencode/opencode.jsonc`（Windows：`C:\Users\<用户名>\.config\opencode\opencode.jsonc`）——存在则直接改它。
2. 该目录下只有 `opencode.json` 时，**先迁移**：把它的完整内容复制进新的 `opencode.jsonc`，再在 jsonc 里加插件条目（原 `.json` 原样保留——迁移保证什么都不丢）。
3. 两者都不存在时，新建全局 `opencode.jsonc`，让团队在每个项目里都可用。

### 第 2 步 — 加入插件条目

合并（不要动无关的键）进配置的 `"plugin"` 数组：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@te-river/opencode-team-mode@latest"
  ]
}
```

已有 `"plugin"` 数组就把字符串追加进去。如果条目已经存在，用户想要的可能是**更新**——见下文"更新"。

### 第 3 步 — 重启 OpenCode

插件只在**启动时**解析和加载一次。用户需要完全退出并重启 OpenCode（桌面版：从托盘/菜单退出，不是只关窗口；CLI：重启 `opencode` 进程）。

### 网络提示（中国大陆）

本指南托管在 `raw.githubusercontent.com`，中国大陆网络经常无法直达。抓取
失败时改用镜像前缀重试——`https://ghproxy.net/` + 同样的完整 URL。两个主机
都在 TeamMode 的 `tm_webfetch` 种子白名单内，受治理的抓取工具可以直读。
插件装好、OpenCode 重启之后，同一份指南也在包内，路径取决于本机缓存布局——
作用域式：`<opencode-cache>/packages/@te-river/opencode-team-mode@<版本>/docs/installation.md`；
扁平式：`<opencode-cache>/packages/@te_river+opencode-team-mode@<版本>/docs/installation.md`。

### 第 4 步 — 验证

重启后按顺序验证：

1. Agent 选择器（`@` 提及）里出现：**team、architect、implementer、reviewer、tester、researcher**。
2. 斜杠命令 `/team-plan`、`/team-implement`、`/team-review`、`/team-test`、`/team-research`、`/team-run` 可以自动补全。
3. 判定**运行版本**最可靠的办法：让 agent 跑一次 `tm_stats`，看表里出现了哪些行。`npm view … version` 查的是 registry，不是 OpenCode 实际加载的东西，升级后会误判；读 `package.json` 也只证明文件、不证明被执行的代码。而某一行特性（例如 `宿主后台 task 注入`）要么在要么不在——那就是正在运行的构建。最后请用户开一个会话确认 **team** agent 能正常响应。

> **被加载的那份到底在哪。** `~/.cache/opencode/packages/` 下的作用域式目录是一个
> **包装层**：`packages/@te-river/opencode-team-mode@latest/` 里只有 `package.json`
> （内容仅是 `{"dependencies": {"@te-river/opencode-team-mode": "<版本>"}}`）、
> `package-lock.json` 和 `node_modules/`——**真正的包是嵌套在里面的
> `…@latest/node_modules/@te-river/opencode-team-mode/`**，被执行的是它的 `dist/`。
> 覆盖包装层根上的 `dist/`、或覆盖 `~/.config/opencode/node_modules/` 里那份，都不生效。
> （这条是踩出来的：覆盖后 `tm_stats` 里新行死活不出现，才发现还有一层。）

报告哪些检查通过。验证失败时看"故障排查"。

### 第 5 步 — 可见的子代理（安装脚本已默认开启）

OpenCode 自带的 `task { background: true }` 是唯一能在它界面上**看见**的子代理：
卡片直接链到那个子会话、不阻塞 lead、完成时宿主把父会话唤醒。TeamMode 再把
回来的结果压在 token 预算内（`TM_TASK_OFFLOAD`）。

它依赖一个 OpenCode 的**实验性开关**，由宿主进程启动时读环境变量决定，插件无法
自己打开——所以安装脚本替你写：

| 平台 | 安装脚本做什么 | 撤销 |
|---|---|---|
| Windows | `setx OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS true`（用户级，重启仍在） | `REG delete HKCU\Environment /v OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS /f` |
| macOS | `launchctl setenv …`——本次登录对 GUI 生效，**注销后失效** | `launchctl unsetenv OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` |
| Linux | 有用户级 systemd 就 `systemctl --user set-environment …`，否则打印 `export` 那行 | `systemctl --user unset-environment OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` |

不想开：`install.ps1 -NoBackgroundSubagents`，或管道式安装前设
`TEAMMODE_SKIP_BACKGROUND_SUBAGENTS=1`。**不开也不会坏**——`task` 只是会阻塞 lead，
TeamMode 自己的 `tm_dispatch` / `tm_join` 仍是非阻塞的批量路径。

代价说明白：每个后台任务完成都会唤醒 lead 一次、花一轮；而且在 TeamMode 把超限
正文换成"预览 + 取回指针"之前，宿主注入的是全文。


### 更新

> ⚠️ **OpenCode 加载插件用的是这份按 spec 字符串缓存的副本——
> `~/.cache/opencode/packages/` 下的目录，不是 `~/.config/opencode/node_modules`
> 里的那份。** 缓存目录有两种布局：**作用域式**
> （`packages/@te-river/opencode-team-mode@latest/`，本机实测就是这种）和
> **扁平式**（`packages/@te_river+opencode-team-mode@latest/`）。只匹配
> `packages/` **顶层**的清理逻辑扫不到嵌在 `@te-river/` 作用域层里的缓存——
> 升级会**静默失效**，重启后仍从旧版缓存加载。**purge 必须递归到
> `@te-river` 作用域层**（两个安装器现已改为递归清理）。

> 安装器是幂等的：**重跑安装器就是更新。** 它会补齐配置（已存在则跳过）、
> **递归**清掉过期插件缓存（两种布局都清）、并重解析 npm 安装的副本。
> 之所以需要这一步：OpenCode 按 spec 字符串缓存插件
> （`~/.cache/opencode/packages/<scope>/<name>@latest`），
> 新版本发布后不会重新解析 `@latest`（上游已知问题）。

**路径一 —— 重跑一行安装器：**

macOS / Linux（bash）：

```bash
curl -fsSL https://ghproxy.net/https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/scripts/install.sh | bash
```

Windows（PowerShell）：

```powershell
irm https://ghproxy.net/https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/scripts/install.ps1 | iex
```

**路径二 —— 让 agent 更新。** 把这段话粘给任意编码 agent：

```text
更新 OpenCode 插件 @te-river/opencode-team-mode：按照
https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/docs/installation.md
的"更新"章节执行，并按该指南里的检查项验证。
```

**路径三 —— 手动**（脚本自动化的内容）：

1. **递归**删除缓存的包目录，两种布局都要覆盖：作用域式
   `~/.cache/opencode/packages/@te-river/opencode-team-mode@latest` 与扁平式
   `~/.cache/opencode/packages/@te_river+opencode-team-mode@latest`
   （作用域式正是顶层通配符漏掉的那种）：

   ```bash
   # macOS / Linux —— GNU/BSD 双安全的 POSIX 写法（`xargs -r` 是 GNU 专有，macOS 会报错）
   # find -prune 命中即停、不再下钻，
   # 因此包内自带的 node_modules/@te-river/opencode-team-mode 不会被列出
   # （随父目录一起被删）
   find ~/.cache/opencode/packages -type d -name '*opencode-team-mode*' -prune -exec rm -rf {} +
   ```

   ```powershell
   # Windows PowerShell —— 两个根都要跑，并用 Test-Path 逐个包住：
   # 第二个 root 常常不存在，避免红字噪音。
   # 按路径长度排序 = 父目录先删；已随父消失的子项由 SilentlyContinue 兜住。
   foreach ($root in "$HOME\.cache\opencode\packages", "$env:LOCALAPPDATA\opencode\cache\packages") {
     if (Test-Path $root) {
       Get-ChildItem -Path $root -Directory -Recurse -Filter '*opencode-team-mode*' -ErrorAction SilentlyContinue |
         Sort-Object { $_.FullName.Length } |
         Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
     }
   }
   ```

   两条命令都会删掉两种布局的 `@latest` 目录，且不动 `@te-river` 作用域目录本身。
2. 如果插件还被 npm 装进了 `~/.config/opencode`（检查它的 `package.json` / `package-lock.json`），在那里执行 `npm install @te-river/opencode-team-mode@latest`。
3. 重启 OpenCode 并重新验证——见下方**验证升级真的生效**。

#### 验证升级真的生效

1. 完全退出并重启 OpenCode（插件只在启动时加载一次）。
2. **别只看 `npm view @te-river/opencode-team-mode version`**——它查的是
   npm registry，OpenCode 明明还在加载旧缓存时它照样报最新版，会误导你。
   要确认的是**运行版本**：
   - 重启重新拉取后，读缓存目录里的 `package.json` 的 `version`——
     `~/.cache/opencode/packages/@te-river/opencode-team-mode@latest/package.json`
     （作用域式）或
     `~/.cache/opencode/packages/@te_river+opencode-team-mode@latest/package.json`
     （扁平式）。那里才是 OpenCode 刚加载的版本，再与 `npm view` 对比。
   - 或用只存在于新版的特性做探针——例：让 agent 调用 `tm_memory` 的
     `action: compact`，没有该 action 的旧版会直接报错。
3. 仍是旧版？把第 1 步的递归删除再跑一遍（非递归 glob 漏掉 `@te-river`
   作用域层是最常见原因），然后再重启。

### 纯手动流程（安装脚本不可用或出错时的回退方案）

一行安装器只是把下面这些步骤自动化了——你完全可以手动执行。全新安装跑完整序列；**升级时第 2 步（递归清缓存）是关键**（旧的 `@latest` 缓存不会自行刷新）。

1. **让配置指向插件。** 确认 `~/.config/opencode/opencode.jsonc` 存在（若只有
   `opencode.json`，先复制成 `.jsonc`——`.jsonc` 优先），且其 `"plugin"` 数组含该
   条目。合并，别覆盖无关的键：
   ```jsonc
   { "$schema": "https://opencode.ai/config.json",
     "plugin": ["@te-river/opencode-team-mode@latest"] }
   ```
2. **递归清理过期缓存——两种布局都覆盖。** OpenCode 从
   `~/.cache/opencode/packages/` 加载、按 spec 字符串缓存，旧的 `@latest` 不会自行
   刷新。顶层通配符扫不到嵌在 `@te-river/` 下的作用域副本——必须递归：
   - macOS / Linux（GNU/BSD 双安全；`-prune` 命中即停、不下钻）：
     ```bash
     find ~/.cache/opencode/packages -type d -name '*opencode-team-mode*' -prune -exec rm -rf {} +
     ```
   - Windows PowerShell（两个根都跑；`Test-Path` 包住常缺失的第二个；父目录先于其
     嵌套匹配删除）：
     ```powershell
     foreach ($root in "$HOME\.cache\opencode\packages", "$env:LOCALAPPDATA\opencode\cache\packages") {
       if (Test-Path $root) {
         Get-ChildItem $root -Directory -Recurse -Filter '*opencode-team-mode*' -ErrorAction SilentlyContinue |
           Sort-Object { $_.FullName.Length } |
           Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
       }
     }
     ```
3. **用 npm 解析**（同时修掉 config 目录里的 `package-lock.json` 锁版本）：
   `cd ~/.config/opencode && npm install @te-river/opencode-team-mode@latest`。
   若该目录没有 `package.json`，OpenCode 会在下次启动按配置里的 `@latest` 解析——
   此步可跳过但无害。
4. **完全退出并重启 OpenCode**（从托盘/菜单退出，不是只关窗口）——插件只在启动时
   加载一次。
5. **验证运行版本**——读缓存目录里 `package.json` 的 `version`，或用只存在于新版的
   特性探针（`tm_memory action: compact`）。**别只信 `npm view`**（它查 registry，
   不是 OpenCode 实际加载的东西）。

### 卸载

1. 从你编辑过的配置文件里的 `"plugin"` 数组移除该条目。
2. 想回收磁盘空间的话删除上面的缓存目录。
3. 重启 OpenCode——agents、命令和工具全部消失。

### 故障排查

| 症状 | 原因 | 修复 |
|---|---|---|
| Agents 没出现 | OpenCode 没重启，或改错了配置文件 | 完全重启；确认改的文件就是 OpenCode 加载的那个 |
| 用着 `@latest` 版本还是旧的 | 插件缓存永不失效 | 见"更新"——递归删除缓存目录（两种布局） |
| 改了版本/重跑安装器后仍是旧版 | 作用域缓存 `packages/@te-river/opencode-team-mode@latest` 嵌在顶层 `packages/*opencode-team-mode*` 通配符扫不到的下一层，旧副本根本没被清掉 | 递归删除该缓存目录（`Get-ChildItem -Recurse -Filter '*opencode-team-mode*'` / `find -type d -name '*opencode-team-mode*' -prune`）后重启——当前安装器已改为递归清理 |
| 启动报 Node 版本错误 | npm 需要 Node ≥ 18 | 升级 Node |
| 环境变量命令突然弹确认框 | 这是插件的 R6 保护在正常工作 | 每个操作选"一次"，或设 `TM_ENV_PROTECT=off`（不推荐） |
| 用户自定义的 `team`/`architect` 等 agent 被遮蔽 | 插件注入默认值；你的定义永远优先 | 插件从不覆盖用户 agent——检查你的 agent 名字有没有拼错 |
