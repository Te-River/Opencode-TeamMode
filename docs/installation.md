# TeamMode Installation Guide / 安装指南

> **For LLM agents:** your user asked you to install `@te-river/opencode-team-mode`. This document is the complete, self-contained procedure. Read it fully, then execute. Do not improvise package names or config locations — everything you need is here.
>
> **面向 LLM 智能体：** 用户要求你安装 `@te-river/opencode-team-mode`。本文档是完整、自包含的安装规程。通读后再执行。不要 improvised 包名或配置路径——所需信息全在这里。

---

## Part A — English

### What you are installing

An OpenCode plugin that injects a **six-agent development team** (Team Lead, Architect, Implementer, Reviewer, Tester, Researcher) plus six slash commands and nine governed `tm_*` tools into the user's OpenCode. npm package: [`@te-river/opencode-team-mode`](https://www.npmjs.com/package/@te-river/opencode-team-mode). It runs entirely locally; no telemetry, no API keys.

### Step 1 — Locate the OpenCode config file

Check, in order:

1. **Project config:** `opencode.json` or `opencode.jsonc` in the current project root.
2. **Global config:** `~/.config/opencode/opencode.json` (or `.jsonc`) — on Windows typically `C:\Users\<user>\.config\opencode\opencode.json`.

If neither exists, create the global one (`~/.config/opencode/opencode.jsonc`) so the team is available in every project.

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

### Step 4 — Verify

After restart, verify in this order:

1. The agent picker (`@` mentions) lists: **team, architect, implementer, reviewer, tester, researcher**.
2. Slash commands `/team-plan`, `/team-implement`, `/team-review`, `/team-test`, `/team-research`, `/team-run` autocomplete.
3. Optional deeper check: `npm view @te-river/opencode-team-mode version` shows the latest published version; ask the user to start a chat and confirm the **team** agent responds.

Report which checks passed. If verification fails, see Troubleshooting.

### Updating

> The installer is idempotent: **re-running it IS the update.** It re-patches
> the config (no-op when present), purges the stale plugin cache, and
> re-resolves any npm-installed copy. This exists because OpenCode caches
> plugins by spec string (`~/.cache/opencode/packages/<name>@latest`) and
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

1. Delete the cached package directory: `rm -rf ~/.cache/opencode/packages/@te_river+opencode-team-mode@latest` (Windows PowerShell: `Remove-Item -Recurse -Force "$env:LOCALAPPDATA\opencode\cache\packages\@te_river+opencode-team-mode@latest"` — also check `~/.cache/opencode/packages/` under the user profile; remove any directory matching `*opencode-team-mode*`).
2. If the plugin was also npm-installed into `~/.config/opencode` (check its `package.json` / `package-lock.json`), run `npm install @te-river/opencode-team-mode@latest` there.
3. Restart OpenCode and re-verify.

### Uninstalling

1. Remove the entry from the `"plugin"` array in the config file(s) you edited.
2. Delete the cache directory (path above) if you want to reclaim the disk space.
3. Restart OpenCode — the agents, commands and tools disappear.

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Agents don't appear | OpenCode not restarted, or config file is the wrong one | Fully restart; confirm the file you edited is the one OpenCode loads |
| Version is old despite `@latest` | Plugin cache never invalidates | See Updating — delete the cache dir |
| Node version error on startup | npm needs Node ≥ 18 | Upgrade Node |
| Env-var commands suddenly prompt for confirmation | That's the plugin's R6 protection working as designed | Approve once per operation, or set `TM_ENV_PROTECT=off` (not recommended) |
| A user-defined agent named `team`/`architect`/… got shadowed | Plugin injects defaults; your own definitions always win | The plugin never clobbers user agents — check for typos in your agent names |

---

## Part B — 中文

### 你在安装什么

一个 OpenCode 插件，向用户的 OpenCode 注入**六人开发团队**（Team Lead、Architect、Implementer、Reviewer、Tester、Researcher）+ 六个斜杠命令 + 九个受治理的 `tm_*` 工具。npm 包：[`@te-river/opencode-team-mode`](https://www.npmjs.com/package/@te-river/opencode-team-mode)。完全本地运行，无遥测、无 API Key。

### 第 1 步 — 找到 OpenCode 配置文件

按顺序检查：

1. **项目配置：** 当前项目根目录下的 `opencode.json` 或 `opencode.jsonc`。
2. **全局配置：** `~/.config/opencode/opencode.json`（或 `.jsonc`）——Windows 下通常是 `C:\Users\<用户名>\.config\opencode\opencode.json`。

都不存在时，创建全局配置（`~/.config/opencode/opencode.jsonc`），让团队在每个项目里都可用。

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

### 第 4 步 — 验证

重启后按顺序验证：

1. Agent 选择器（`@` 提及）里出现：**team、architect、implementer、reviewer、tester、researcher**。
2. 斜杠命令 `/team-plan`、`/team-implement`、`/team-review`、`/team-test`、`/team-research`、`/team-run` 可以自动补全。
3. 可选的深度检查：`npm view @te-river/opencode-team-mode version` 显示最新发布版本；请用户开一个会话确认 **team** agent 能正常响应。

报告哪些检查通过。验证失败时看"故障排查"。

### 更新

> 安装器是幂等的：**重跑安装器就是更新。** 它会补齐配置（已存在则跳过）、
> 清掉过期插件缓存、并重解析 npm 安装的副本。之所以需要这一步：OpenCode
> 按 spec 字符串缓存插件（`~/.cache/opencode/packages/<name>@latest`），
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

1. 删除缓存的包目录：`rm -rf ~/.cache/opencode/packages/@te_river+opencode-team-mode@latest`（Windows PowerShell：`Remove-Item -Recurse -Force "$env:LOCALAPPDATA\opencode\cache\packages\@te_river+opencode-team-mode@latest"`——用户目录下的 `~/.cache/opencode/packages/` 也要检查；删除所有匹配 `*opencode-team-mode*` 的目录）。
2. 如果插件还被 npm 装进了 `~/.config/opencode`（检查它的 `package.json` / `package-lock.json`），在那里执行 `npm install @te-river/opencode-team-mode@latest`。
3. 重启 OpenCode 并重新验证。

### 卸载

1. 从你编辑过的配置文件里的 `"plugin"` 数组移除该条目。
2. 想回收磁盘空间的话删除上面的缓存目录。
3. 重启 OpenCode——agents、命令和工具全部消失。

### 故障排查

| 症状 | 原因 | 修复 |
|---|---|---|
| Agents 没出现 | OpenCode 没重启，或改错了配置文件 | 完全重启；确认改的文件就是 OpenCode 加载的那个 |
| 用着 `@latest` 版本还是旧的 | 插件缓存永不失效 | 见"更新"——删除缓存目录 |
| 启动报 Node 版本错误 | npm 需要 Node ≥ 18 | 升级 Node |
| 环境变量命令突然弹确认框 | 这是插件的 R6 保护在正常工作 | 每个操作选"一次"，或设 `TM_ENV_PROTECT=off`（不推荐） |
| 用户自定义的 `team`/`architect` 等 agent 被遮蔽 | 插件注入默认值；你的定义永远优先 | 插件从不覆盖用户 agent——检查你的 agent 名字有没有拼错 |
