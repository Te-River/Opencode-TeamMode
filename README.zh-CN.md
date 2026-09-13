# OpenCode TeamMode

**[English](./README.md)** | **[中文](./README.zh-CN.md)**

[![npm version](https://img.shields.io/npm/v/@te-river/opencode-team-mode.svg)](https://www.npmjs.com/package/@te-river/opencode-team-mode)
[![npm downloads](https://img.shields.io/npm/dm/@te-river/opencode-team-mode.svg)](https://www.npmjs.com/package/@te-river/opencode-team-mode)
[![license](https://img.shields.io/npm/l/@te-river/opencode-team-mode.svg)](./LICENSE)

> 🤝 **[OpenCode 桌面版](https://opencode.ai) 多 Agent 团队协作插件**
>
> 为你的 OpenCode 桌面版添加一整支 AI 专家团队 —— 架构师、实现者、审查员、测试员、调研员，由 Team Lead 统一调度，通过简单的斜杠命令即可调用。

---

## ✨ TeamMode 是什么？

TeamMode 将 OpenCode 桌面版从一个单 Agent 编码助手，升级为**一整个开发团队**。每个 Agent 拥有独立的角色定位、专业领域和行为风格 —— 就像真实的工程团队。

不再是一个 Agent 包揽所有事，你将获得：

| Agent | 角色 | 使用场景 |
|---|---|---|
| 🎯 **Team Lead** | 调度者 | 需要规划 + 多步执行的复杂任务 |
| 🏗️ **Architect** | 系统设计师 | 设计文档、模块结构、API 契约 |
| 💻 **Implementer** | 代码实现者 | 编写生产代码、实现功能 |
| 🔍 **Reviewer** | 单维审查员 | 单维度审查（完整性 / 正确性 / 影响面）——默认 1 路；仅高风险变更升级为 3 路并行 |
| 🧪 **Tester** | 测试工程师 | 单元测试、集成测试、边界覆盖、静态验证（构建 / 类型检查 / lint / API 测试） |
| 🔎 **Researcher** | 知识调研员 | 本地仓库调研优先（代码、配置、已安装依赖、随包文档）；联网经用户 MCP 工具或受治理的 `tm_webfetch`——与 Team Lead 并列的两个网络角色之一 |

---

## 🚀 快速开始

### 前置条件

1. **安装 OpenCode 桌面版**（如果还没有）：

   | 平台 | 安装命令 |
   |---|---|
   | macOS (Apple Silicon) | `brew install --cask opencode-desktop` |
   | macOS (Intel) | `brew install --cask opencode-desktop` |
   | Windows | `scoop bucket add extras && scoop install extras/opencode-desktop` |
   | Linux | 从 [opencode.ai/download](https://opencode.ai/download) 下载 |

   或安装 **CLI/TUI** 版本：
   ```bash
   # 一键脚本（全平台）
   curl -fsSL https://opencode.ai/install | bash

   # 或通过 npm
   npm install -g opencode-ai
   ```

2. **Node.js ≥ 18**（用于 npm）

### 安装 TeamMode

**方式 A — 一键安装脚本：**

macOS / Linux（bash）：
```bash
curl -fsSL https://ghproxy.net/https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/scripts/install.sh | bash
```

Windows（PowerShell）：
```powershell
irm https://ghproxy.net/https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/scripts/install.ps1 | iex
```

**方式 B — 手动配置：**

在你的 `opencode.jsonc` 中添加插件：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@te-river/opencode-team-mode@latest"
  ]
}
```

OpenCode 启动时会自动安装插件。

> ⚠️ **插件更新是手动的。** OpenCode 按 spec 字符串缓存插件
> （`~/.cache/opencode/packages/<name>@latest`），发布新版本后**不会**自动
> 重新解析 `@latest`（上游已知限制）。两种更新方式：
>
> 1. **缓存安装**——删除对应缓存目录后重启：
>    `rm -rf ~/.cache/opencode/packages/<name>@latest`
> 2. **npm 安装的副本**（如 `~/.config/opencode`）——package-lock 会钉住
>    旧版，需显式重新解析：在该目录执行 `npm install <name>@latest`
>    （或 `npm update <name>`）。
>
> 在配置中钉一个明确版本可以避免意外。

> **提示：** 修改 `opencode.json` 后，**重启 OpenCode Desktop** 使配置生效。

---

## ⚙️ 配置

插件会在 OpenCode 启动时自动注入所有团队 Agent 和命令，**无需手动复制任何 Agent 文件或命令定义**。

> ⚠️ **模型选择很重要。** 工作流里的每一个判断——分诊、拆解、派单、
> 整合、审查/测试闭环裁决——都经过 **Team Lead**。这个位置上放弱模型，
> 专家再强也救不回整条流水线。如需自定义，还请给你的 `team` agent 钉上你能负担的最强
> 推理模型（配方见下方「自定义」节）。

### 全局安装（所有项目生效）

要在所有项目中启用 TeamMode，将插件添加到全局配置：

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@te-river/opencode-team-mode@latest"
  ]
}
```

---

## 📖 使用方法

### 斜杠命令

TeamMode 为 OpenCode 添加了六个斜杠命令，在聊天输入框中输入：

| 命令 | Agent | 说明 |
|---|---|---|
| `/team-plan <任务>` | Architect | 创建详细的实现计划：架构、文件清单、任务拆解 |
| `/team-implement <任务>` | Implementer | 为功能或任务编写生产代码 |
| `/team-review [范围]` | Reviewer | 审查代码的 Bug、安全问题和质量问题 |
| `/team-test [范围]` | Tester | 生成全面的测试，覆盖边界场景 |
| `/team-research <主题>` | Researcher | 本地仓库调研优先；联网走受治理的 `tm_browser` / `tm_webfetch`（先），再用户 MCP 工具 |
| `/team-run <任务>` | Team Lead | **完整工作流** — 端到端调度所有 Agent |

#### 示例工作流

```bash
# 1. 规划功能
/team-plan 添加基于 OAuth2 和 JWT 的用户认证

# 2. 审查计划后，开始实现
/team-implement 按计划实现认证模块

# 3. 审查代码
/team-review src/auth/

# 4. 编写测试
/team-test src/auth/

# 或者让 Team Lead 全程调度：
/team-run 添加基于 OAuth2 和 JWT 的用户认证
```

### Agent 选择器

你也可以在 OpenCode 桌面版中使用 `@` 直接调用 Agent：

- `@team` — 调度复杂任务
- `@architect` — 设计系统或模块
- `@implementer` — 编写代码
- `@reviewer` — 审查代码质量
- `@tester` — 编写测试
- `@researcher` — 调研主题

### 演示

以下是一段会话实录的还原。Team 出厂即默认代理（退出方法见下方配置），
用户开新会话直接输入：

> **用户：** 给我们的 Express API 加令牌桶限流——每用户每分钟 100 请求，
> 超限返回 429。不要动 `src/legacy/` 下的任何东西。

```text
team   路由：产品行为变更 → implementer → tester → reviewer
       （3 次派发 → 触发审批门）

       调研：已读 README、src/app.ts、src/middleware/*
       阻塞性问题：无 —— 1 条假设列在下方

       计划
       目标：令牌桶限流，100 请求/分/用户，429 + Retry-After
       范围：src/middleware/rateLimit.ts（新增）、src/app.ts（+3 行）
       流水线：implementer → tester → reviewer（correctness）
       假设：内存桶而非 Redis —— 要改说一声
       边界：src/legacy/** 不动
       批准后开工？

用户   批准，开始

team   ▸ @implementer — STATUS: done
       CHANGES: src/middleware/rateLimit.ts（新增）· src/app.ts（+3）
       HANDOFF: bucket {tokens, lastRefill}；refill() 单次原子完成
       EVIDENCE: tsc 无错误（输出见上）

       ▸ @tester — STATUS: done · VERDICT: pass（14/14）
       FINDINGS: 覆盖突发边界、窗口过期、并发回充；
                 src/legacy/** 逐字节未变
       EVIDENCE: vitest 14 passed

       ▸ @reviewer — STATUS: done · VERDICT: approve（correctness）
       FINDINGS: 无 Critical/Major；1 条 Minor（日志噪音）已记录

team   完成。
       限流器已交付：rateLimit.ts（新增）· app.ts（+3）· 14 测试全绿
       审查：通过 · 假设：仅内存存储 · src/legacy/ 未动
```

用户只输入了任务本身和"批准，开始"。流水线是路由表查表的结果；执行在
计划获批前一步不动；每次交接都是结构化骨架——零文件仪式。

### 桌面版专属特性

在 **OpenCode 桌面版** 中，你还能获得额外的 UX 体验：

- 🎨 **Agent 颜色标识** — 每个 Agent 在聊天 UI 中有独立颜色，便于识别
- 📋 **Agent 选择器** — 点击 Agent 下拉菜单，可视化切换团队 Agent
- 🔀 **并行子任务** — Team Lead 可同时调度多个子 Agent，结果在并行面板中展示
- 📊 **会话历史** — 所有团队交互都保存在桌面版侧边栏，可搜索回溯

---

## 🧰 受治理工具与安全

TeamMode 新增的每一个工具都跑在同一条治理管线上：超过 `TM_OFFLOAD_THRESHOLD`
token 的输出绝不进入上下文——全量卸载到 run 存储，只回传内容感知预览 +
HMAC 签名句柄，agent 确实需要全文时经 `tm_fetch` 分页取回。安全、记忆与
联网能力在 v1.5.1–v1.5.6 间陆续交付，历史见 [CHANGELOG.md](./CHANGELOG.md)。

| 工具 | 作用 | 角色 |
|---|---|---|
| `tm_read` / `tm_grep` / `tm_bash` / `tm_fetch` | 受治理的文件读取 / 正则搜索（宿主索引）/ 只读 shell（白名单）/ 句柄分页取回 | 全部六个 Agent |
| `tm_memory` | 项目记忆库（Markdown + frontmatter）：add / search / list / forget | 全部六个 Agent |
| `tm_webfetch` | 单个白名单页面的受治理 GET | Lead + Researcher |
| `tm_browser` | 交互式浏览器会话（有头 CDP）：open / navigate / read / screenshot / close | Lead + Researcher |
| `tm_ptc_run` | 批量编排：一个程序、N 次受治理调用、零 LLM 往返 | 全部六个 Agent |

> **固定工具优先级梯子（所有任务）：① TeamMode 受治理工具（`tm_*`）→
> ② 用户 MCP/插件工具 → ③ 模型自行推理（能力缺失按缺口上报，绝不伪装）。**
> 梯子同时是回退链：受治理工具报错（本机无浏览器、主机被拦）时，Agent
> 会如实说明并落到下一级，而不是放弃。

所有 Agent 都被要求把每次查询路由到这些工具——先扫描工具面、规划具体
调用，再把口语化/缩写/别名称呼展开为规范名、两种写法都查——而不是凭
记忆作答或伪装被移除工具的输出。

### 上下文治理：卸载、句柄、预览

**JIT 层 2 工具（`tm_read` / `tm_grep` / `tm_bash` / `tm_fetch`）。**
大体积工具输出是上下文成本的主要来源：智能体每走一步都要重发整个窗口。
tm_* 工具先用受治理的管线执行内置能力：超过 `TM_OFFLOAD_THRESHOLD`
token 的结果**不进窗口**——全量写入本地 run 存储，模型只拿一张句柄
“提货单”，附内容感知预览（JSON 键结构 / CSV 表头+形状 / 日志
ERROR×N 统计 / 代码签名清单 / 二进制元信息，硬上限 80 token）。
确实需要全文时，用 HMAC 签名、限本 run、带有效期的句柄经 `tm_fetch`
分段取回。`tm_bash` 仅放行只读命令白名单，失败以结构化错误返回。
所有 Agent 都被要求把每次查询优先路由到这些工具——先扫描自己的工具面、
规划具体调用，再把口语化/缩写/别名称呼展开为规范名、两种写法都查——
而不是凭记忆作答或伪装被移除工具的输出。

### 项目记忆（tm_memory）

**项目记忆（`tm_memory`）——全部 Agent 可用。** 跨会话持久的事实
（构建命令、环境怪癖、架构决策、长期有效的用户约定）以带 frontmatter 的
Markdown 文件存放，两个作用域——人类可直接编辑，绝不进你的工作树：
- **`project`**（默认）：`<repo>/.git/opencode-team/memories/<项目slug>/<分类>/`
  ——随仓库走，每个 checkout 一套。
- **`global`**：`~/.opencode-team/memories/`（可用 `TM_MEMORY_GLOBAL_DIR`
  覆盖）——**跟随你跨所有项目**；个人偏好与跨项目约定放这里。
动作：`add` / `search`（确定性关键词评分，取前
5）/ `list` / `forget`；单条内容上限 4000 字符——任务状态归 todo list，
超长文档归黑板文件。所有 Agent 都被要求：在凭空假设项目约定之前先
search，踩过坑后把结论 add 给下一次会话。

### 联网访问（tm_browser + tm_webfetch）——仅网络角色

1. **受治理联网工具。** `tm_browser`——交互式浏览器会话，经 CDP 管道协议
   驱动**你本机的 Chromium 系浏览器**（Windows 优先探测 Edge）有头运行：
   open → navigate → read（页面正文，与 tm_read 同阈值治理）→ screenshot
   （PNG 落 run store，进上下文的只有路径）→ close。隔离临时配置（绝不碰
   你的真实配置）；**域名白名单在网络层逐请求强制**（CDP
   `Fetch.requestPaused`——白名单外主机直接 `BlockedByClient`）。无显示器
   的 Linux 主机自动转无头；`TM_BROWSER_HEADLESS` 可强制，`TM_BROWSER_PATH`
   可指定可执行文件。`tm_webfetch`——单个白名单页面的受治理 GET。两者与
   所有 tm_* 工具走同一套治理（阈值卸载 + 内容感知预览 + `tm_fetch`
   句柄），网页永远冲不爆上下文。
2. **用户 MCP/插件工具。** 用户配置的 MCP 服务器提供的浏览器自动化、搜索、
   抓取类工具，作为受治理工具覆盖不到时的回退，白名单不干预。
3. 其余四个角色（architect / implementer / reviewer / tester）**没有**
   网络授权——联网问题按缺口上报，绝不伪装结果。内置 webfetch/websearch
   工具保持移除；远程 `.env` 类 URL 拒绝（R6 红线）。

白名单预置主机（两个联网工具共用）：`mobile.moegirl.org.cn`（词条）、
`search.bilibili.com`、`cn.bing.com`、`www.baidu.com`（搜索 URL 模板）；
通过 `TM_WEBFETCH_ALLOWED_DOMAINS` 扩展（`"*"` 放开全部主机）。

白名单预置主机（两个联网工具共用）：`mobile.moegirl.org.cn`（词条）、
`search.bilibili.com`、`cn.bing.com`、`www.baidu.com`（搜索 URL 模板）；
通过 `TM_WEBFETCH_ALLOWED_DOMAINS` 扩展（`"*"` 放开全部主机）。

### 安全：R6 + R2 审批门

**R6 环境变量保护（现已升级为审批门控）。** TeamMode 激活时，模型无法
静默读取环境变量。env 导出命令（`printenv`、`env`、`Get-ChildItem env:`
等）与环境文件（`.env`、shell rc 文件）会走 OpenCode **官方确认弹窗**：
你会在桌面收到一次原生确认，超过 `TM_ASK_TIMEOUT_MIN`（默认 10 分钟）
无人响应即**自动拒绝**——插件超时只会拒绝，绝不为模型自我放行。通配符
表达不了的形态（命令里内嵌的 `$VAR` / `${VAR}` / `$env:`、命令替换、
子 shell/转义写法）以及 `tm_*` 包装通道仍维持**代码级硬拦**（没有弹窗
可钻）。tm_* 包装工具同样过这套检查（不给包装层留后门）。审计日志只记
工具名 + 模式类别 + 裁决事件（`ask` / `allowed-once` / `allowed-always` /
`rejected` / `timeout-rejected` / `degraded`）——绝不记录命令文本、路径、
变量名或值。

**R2 危险操作（同一个确认弹窗）。** 删除（`rm`/`del`/`Remove-Item`/
`rmdir`）、git 发布（`git push`/`git commit`）、网络（`curl`/`wget`/
`Invoke-WebRequest`/`Invoke-RestMethod`）、包安装与发布（`npm install`/
`npm publish`/`pip install`/`winget`/`choco`）、进程/系统（`taskkill`/
`Stop-Process`/`kill`/`shutdown`/`format`）、权限（`chmod`/`takeown`/
`icacls`）——都不再静默放行，而是弹同一个官方确认框，超时未响应即自动
拒绝。日常验证栈（`npm test`、`tsc`、`git status`/`diff`）**不在**门控
之列，团队协作照常无打扰运行。

> ⚠️ **批准弹窗时请选 once（仅此一次），不要选 always。** 真实宿主实测：
> always 记录的泛化规则远比当次命令宽——对 `Get-ChildItem env:PATH` 选
> always 会记下 `Get-ChildItem *`，此后所有 `Get-ChildItem` 都不再弹窗。
> 只有 once 能让每次危险操作继续单独过人手。
> （如果确实对 env 弹窗选了 always，TeamMode 会把它收敛为**当前会话**级；
> 且 env 文件读取（如 `cat .env`）无论如何保持硬拦——它们从无弹窗兜底，
> 任何 always 都不曾为其授权。）

> 延后是**按会话**生效的：只有运行 TeamMode 注入角色的会话（或已弹过这类
> 确认框的会话）里的 env 读取才会被放行给弹窗；其他会话（如原生
> `build`/`plan`）里守护仍然直接硬拦——那里根本没有弹窗兜底。同一会话中，
> 一条路由到非注入角色的用户消息会**撤销**该会话的放行资格（按回合的
> agent 信号来自 message.updated；宿主传给 tool.execute.before 的入参经实测
> 不含 agent 字段）。宿主对复合命令（`a; b`）按段评估、单次弹窗批准整条；
> 任一子段是 env 读取时守护整条拦截。

> 权限协议已在真实 `opencode serve` 宿主（1.18.29）上经 SSE 事件捕获实测
> 核验；桌面弹窗的渲染本身仍需在真实 Desktop 会话里目视确认一次。非交互
> `opencode run` 下，无人应答的 `ask` 会被立即自动拒绝（没有人类可弹）。

### 仓库卫生与路径语义

> **仓库卫生。** 卸载载荷与轨迹账本存储在 `<repo>/.git/opencode-team/` 下
> （非 git 仓库回退系统临时目录）——绝不污染你的工作树。所有 Agent 都被
> 要求在汇报完成前**删除自己创建的临时/草稿文件**，一次性工作直接放到系统
> 临时目录，从源头避免落进仓库。`tm_read` / `tm_grep` 的路径相对**项目根目录**
> （而非 Agent 的工作目录）。

### 环境变量

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `TM_ENV_PROTECT` | `strict` | R6 模式：`strict` / `standard` / `off`（off 同时解除审批计时器） |
| `TM_ASK_TIMEOUT_MIN` | `10` | R6/R2 确认弹窗无人应答后自动拒绝的分钟数；最小 3 分钟（宿主的 `permission.replied` 经事件总线到达插件约延迟 ~120 秒——更小的值会把刚获批的请求误拒） |
| `TM_ENV_PROTECT_EXTRA_DENY` | — | 追加拦截正则（分号分隔；始终硬拦，不走弹窗） |
| `TM_OFFLOAD_THRESHOLD` | `2000` | 卸载阈值（token，CJK≈1 token/字、其余 chars/4 估算） |
| `TM_PREVIEW_MAX_TOKENS` | `80` | 预览硬上限 |
| `TM_FETCH_MAX_LINES` | `2000` | tm_fetch 单段上限 |
| `TM_BLACKBOARD_DIR` | `<repo>/.git/opencode-team/blackboard/` | 卸载载荷存储（非 git 仓库回退 tmpdir；显式值支持绝对或项目相对路径） |
| `TM_TRAJECTORY_DIR` | `<repo>/.git/opencode-team/trajectory/` | 只追加工具调用账本（非 git 仓库回退 tmpdir） |
| `TM_BLACKBOARD_TTL` | `7` | 存储保留天数 |
| `TM_BASH_READONLY_ALLOWED` | 内置表 | tm_bash 只读白名单 |
| `TM_WEBFETCH_ALLOWED_DOMAINS` | `mobile.moegirl.org.cn, search.bilibili.com, cn.bing.com, www.baidu.com` | tm_webfetch/tm_browser 白名单（`"*"` 放开全部主机；显式留空 = 全拒绝） |
| `TM_BROWSER_PATH` | 自动探测 | tm_browser 可执行文件覆盖（按 Edge/Chrome/Chromium 逐 OS 探测） |
| `TM_BROWSER_HEADLESS` | `auto` | tm_browser：`1` 无头（服务器/CI） / `0` 有头 / `auto`（仅无显示器的 Linux 自动无头） |
| `TM_MEMORY_GLOBAL_DIR` | `~/.opencode-team/memories/global/` | tm_memory GLOBAL 作用域存储（用户级，跨项目） |
| `TM_PTC_MAX_PROGRAM_CHARS` | `4000` | PTC 程序源码长度上限（字符） |
| `TM_PTC_MAX_CALLS` | `20` | PTC 单次运行桥接调用数上限（1–200） |
| `TM_PTC_MAX_ERRORS` | `3` | PTC 单次运行错误数上限（1–50） |
| `TM_PTC_TIMEOUT_MS` | `60000` | PTC 单次运行墙钟超时（5 秒–10 分钟） |
| `TM_PTC_ENGINE` | `auto` | PTC 引擎：`auto`（worker→inline 整体重跑降级）/ `worker` / `inline` |

### 批量编排（tm_ptc_run）

`tm_ptc_run` 让专家代理编写**一个异步程序**，在单次回合中执行 N 次受治理的
`tm_*` 调用——运行期间零 LLM 往返，仅将聚合摘要返回上下文。设计用于批量
只读任务：多文件侦察、批量 grep + read 聚合、交叉引用搜索结果。

#### 工作原理

代理使用 `tm.read(args)`、`tm.grep(args)`、`tm.bash(args)`、`tm.fetch(args)`
编写程序体——参数与四个受治理工具相同。每次调用返回 `{ok:true, data}`（已受
治理：内联文本或卸载句柄）或 `{ok:false, error:{tool,phase,line?,message}}`。
程序 `return` 一个值；它会被 JSON 序列化进聚合摘要。

包含 `require`、`import`、`process`、`globalThis`、`Deno`、`Bun`、`fs`、`net`
或 `child_process` 的程序会在执行前被拒绝（静态预扫描，辅助防护）。

#### 预算（仅收紧）

调用方可收紧 `max_calls`、`max_errors` 和 `timeout_ms`——超过 `TM_PTC_*` 上限
的值会被钳制到上限；低于下限的值会被钳制到下限。触达任一预算即整体停止运行；
已产出的输出不会丢失。

#### 引擎（`TM_PTC_ENGINE`）

| 模式 | 行为 |
|---|---|
| `auto`（默认） | 优先尝试 `worker_threads`；引擎失败时**整体重跑**程序到 `node:vm`，摘要标记 `degraded-engine`（桥接调用均为只读，重跑安全；回退运行在相同墙钟期限内使用全新预算） |
| `worker` | 强制使用 worker 引擎（失败时返回 engine-error） |
| `inline` | 强制使用 `node:vm` 引擎（脚本超时可斩杀**首个 await 之前**的同步忙等；await 之后的忙等会不可恢复地阻塞宿主事件循环——生产环境请用 worker/auto） |

worker 引擎在专用线程中运行程序，`env:{}` 清空 process.env、`resourceLimits`
限量、硬墙钟 `terminate()`。所有治理（P2 路径范围、P3 白名单、R6、阈值卸载、
TTL）对每次桥接调用生效——PTC 不是绕过层。

#### 访问权限

**全部六个**代理的白名单中都包含 `tm_ptc_run`（`team` lead 也包含——v1.5.4
修订了最初的拒绝裁定）。每次桥接调用仍然运行完整的 tm_* 治理管线（P2 路径
域、P3 白名单、R6、阈值卸载 + 句柄、TTL），批量编排只是效率增益，不是治理缺口。

---

## 🏗️ 架构

```
opencode-team-mode/
├── package.json          ← npm 包定义
├── tsconfig.json         ← TypeScript 配置
├── src/
│   ├── index.ts          ← 插件入口（server()：config + R6 tool.execute.before + 审批门 event 钩子 + tool 段）
│   ├── agents.ts         ← Agent 结构（模式、颜色、温度、白名单矩阵）
│   ├── prompts/          ← Agent 提示词原文（lead / specialists / shared）——由测试钉死
│   ├── commands.ts       ← 命令定义（模板、Agent 绑定）
│   ├── blackboard.ts     ← 共享黑板 + TTL 自动清理清扫器
│   ├── envprotect.ts     ← R6 门面 → envprotect/（patterns / bash-classify / path-classify / gate-predicates / hook）
│   ├── approval-gate.ts  ← 统一审批门：官方弹窗超时自动拒绝（绝不自我放行）
│   ├── tm/               ← JIT 层 2 工具：pipelines / result / client-unwrap / shell-bridge / args-schema / tools / guard / preview / store / refs / config / webfetch / memory / browser / ptc/（9 模块）
│   └── types.ts          ← 加载器契约类型定义（1.18.x）
├── scripts/
│   ├── install.sh        ← 一键安装脚本（bash）
│   └── install.ps1       ← 一键安装脚本（PowerShell）
├── pt07/                 ← PT-07 基线任务集（种子化 A/B token 测量）
├── LICENSE               ← Apache 2.0
└── README.md             ← 英文文档
    README.zh-CN.md       ← 中文文档
```

### 工作原理

1. OpenCode 桌面版启动，加载 `opencode.json(c)`
2. 检测到 `plugin` 数组中的 `"@te-river/opencode-team-mode@latest"`，加载 npm 包
3. 加载器调用插件的 `server(input, options)`，注册 `config` hook；hook 向合并后的配置注入 6 个 Agent 和 6 个命令。同一次调用还会安装 R6 的 `tool.execute.before` 防护、武装 R6/R2 统一审批门（官方确认弹窗 + `TM_ASK_TIMEOUT_MIN` 超时自动拒绝，经 `event` 钩子驱动），并注册受治理的 `tm_*` 工具（见下文“上下文治理”）
4. 插件的 `id: "team-mode"` 作为插件名显示在桌面版 UI
5. Agent 和命令立即在桌面版 UI 中可用 —— 无需复制任何文件；同名 Agent 以用户自定义优先（插件绝不覆盖）

---

## 🤖 团队如何运作

子代理之间无法实时互发消息（平台限制），TeamMode 通过**结构化回复骨架**协调它们，
文件黑板只保留给超大产出：

- **回复骨架（主通道）**：每个专家的最终回复以
  `STATUS: / CHANGES: / FINDINGS: / EVIDENCE: / HANDOFF:` 开头，全文 ≤50 行。
  这个尺寸的产出直接内联传递——零文件 I/O，没有"文件没写上"这种故障面。
  Lead 把 `HANDOFF` 原文转贴进下一次派单，并对骨架做机器校验
  （缺失 → 带 skeleton 原文重试一次 → 仍违规则降级记入报告）。
- **黑板文件（仅例外）**：完整产出确实超过 ~50 行时（如完整架构设计文档），
  派单点名唯一文件：
  `<repo>/.git/opencode-team/<session-key>/<task-slug>/NN-<role>-<topic>.md`
  ——位于 `.git/` 内，**绝不污染**工作区和 commit（非 git 工作区回退系统临时目录）。
  写入即冻结：修订 = 新的轮次后缀文件（`…-r2.md`）；会话目录层让新对话
  不会撞上尚未清扫的旧黑板。
- **没有 MANIFEST.md**：lead 的状态记忆就是它的 todo list。
- **反馈闭环**：Critical/Major 发现和产品 bug 自动转化为跟踪的修复任务，
  直到交付物收敛（最多 2 轮，之后升级给用户）。

### 确定性路由、审批门与自适应评审

- **路由表**：lead 按任务形状查固定流水线行——提问 → 直接回答；纯文档 →
  implementer；产品行为变更 → implementer → tester → reviewer；多模块/跨接口
  功能 → architect → implementer → tester → reviewer(s)；未知外部技术 →
  researcher 前置。流水线有固定下限：产品变更路由到少于 3 次派发即是路由 bug；
  把一个请求拆成多个 <2 派发的子任务以规避审批门 = 协议违规。
- **审批门（按计数触发）**：预计派发 ≥2 → lead 先调研（亲自读仓库；仅未知外部
  技术才派 researcher），呈交 ≤30 行计划，然后**等待你的批准**才执行任何东西。
  0-1 次派发的小任务以 1-2 行通报直接开工。执行中发现需要第 2 次派发 →
  暂停等批准。阻塞性不确定**立即批量问一次**——不猜测、不挤牙膏。
- **自适应评审**：默认 1 个 reviewer 派单（correctness 维度）；仅高风险画像
  ——鉴权/安全面、跨模块数据契约、≥3 文件的公共 API 变更——才升级为
  3 维并行（完整性 / 正确性 / 影响面）。
- **静态验证**：tester 通过构建、类型检查、静态分析、API/单元测试验证。
  禁止即兴发明浏览器自动化（headless 截图、DOM stub）；用户可见前端改动
  以 `UI NOT VERIFIED: <待人工检查项>` 如实收尾，除非项目本身已带真实
  浏览器测试设施。
- **无仪式捷径**：lead 已亲自验证的根因（file:line 证据）直接变成修复规格
  派给 implementer——调查性派单服务于未知，不服务于仪式感。
- **简明纪律**：路由选择是查表；用户可见的计划性文字 ≤5 行。
- **证据标准（保留）**："完成 / 修复 / 通过"的声明必须附可验证证据——命令
  输出、日志、diff。纯叙述只是进度说明，不是证明。
- **逐字契约（保留）**：需要互通的并行实现代理，其数据契约（端点、字段名、
  类型）逐字贴进每个相关派单——契约错配是集成 bug 之首。
- **文档同步（CHANGELOG + AGENTS.md）**：交付的改动在 CHANGELOG.md 存在时按
  Keep a Changelog 风格追加条目；当改动会影响 AGENTS.md 所记录的内容
  （构建/测试命令、约定、项目结构、agent 指引）时同步更新它；任一文件缺失
  时提议代建。阅读去重：README 由 lead 亲自阅读（宿主不会注入）；
  AGENTS.md/CLAUDE.md 若宿主已注入则直接使用上下文中的副本——仅在确实缺失时
  才打开文件；专家不会自己去重读这些文档——约定由 lead 蒸馏进派单。

### Triage —— 提问不会变成代码修改

Team Lead 对每条消息先分类再行动：咨询/提问只得到回答（零文件改动，发现缺陷
仅**提议**修复并等待你放行）；只有明确的行动指令才进入工作流。并且一旦你写明
了哪些能碰哪些不能碰，**这些边界高于一切规则**——lead 会在每次派发中原样重申。

### 清理 —— 只有 TTL 清扫器一条路

| 责任方 | 时机 |
|---|---|
| 插件代码（进程内清扫器） | 启动时 + 每小时：清除空闲超过 **TTL** 的任务目录 |

Team Lead 不再删除任务目录 —— 跑完的黑板原地留给你回看审计；回收由纯代码
完成，从不依赖模型"记得删"，崩溃/强杀留下的残骸同样会被清扫。清扫器对活跃
会话内的过期任务逐个回收，对整个闲置的会话目录一次性收走。TTL 可用
`ttlDays` 调节。

### 自定义 TTL

默认为 **5 天**。想自定义，在 `opencode.jsonc` 中使用元组形式的插件声明：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["@te-river/opencode-team-mode@latest", { "ttlDays": 7 }]
  ]
}
```

`ttlDays` 接受 `(0, 365]` 内的天数；非法值静默回退到 5 天。

### 默认代理

TeamMode 默认**把 Team 设为你的默认代理**——新会话直接由团队调度者接管。
占默认槽附带一个排序效应：选择器会把**默认代理钉在第一位**、其余按名称
字母升序，所以顺序为 **team, build, plan**。（想让 Team 排在 Plan 之下？
那必须放弃默认槽——见下方退出开关；按服务端的排序规则二者不可兼得。）

不想占用默认代理槽（`build` 保持默认，顺序 **build, plan, team**）则退出：

```jsonc
{
  "plugin": [
    ["@te-river/opencode-team-mode@latest", { "defaultAgent": false }]
  ]
}
```

用户显式配置的非 `build` 默认代理永远原样保留——插件从不覆写。

**升级提示**：v1.4.4 曾短暂改为 opt-in（默认不占用）；v1.4.5 恢复
Team-as-default 出厂行为。若你在 v1.4.4 期间加过 `{ "defaultAgent": true }`，
现在可以删掉该选项（或改为 `false` 主动退出）。

---

## 🔧 自定义

### Team Lead 的模型最关键

Lead 是编排大脑：它给每条消息分类、按路由表查流水线、写每份派单、裁决
reviewer/tester 的发现、合成最终交付。这里的质量问题会**沿流水线放大**——
平庸的 Lead 拆错任务、给专家的指令含糊、放走劣质产出；没有任何专家能
救回一份从一开始就派错的工单。

所以：自定义模型时**Lead 位上请放你负担得起的最强模型**。其他角色可以用便宜模型——
它们拿到的指令书精确、阅读范围受限，容错更高。按 agent 钉模型：

```jsonc
{
  "agent": {
    // Team Lead —— 编排值得最好的模型
    "team": { "model": "anthropic/claude-opus-4-5" },
    // 专家角色 —— 便宜一档通常够用
    "implementer": { "model": "anthropic/claude-sonnet-4-6" }
  }
}
```

（以上模型 ID 仅为示例，换成你服务商实际提供的即可。你自定义的
`agent.team` 永远优先于插件注入的版本。）

### 覆盖某个 Agent

在 `opencode.json` 中添加同名 Agent —— 你的定义会优先生效：

```jsonc
{
  "agent": {
    "reviewer": {
      "model": "anthropic/claude-sonnet-4-6",
      "prompt": "你是一个极其严格的审查员。任何 lint 警告都必须打回。"
    }
  }
}
```

### 添加自己的 Agent

TeamMode 不阻止你添加更多 Agent，与团队 Agent 并存：

```jsonc
{
  "agent": {
    "devops": {
      "mode": "subagent",
      "description": "处理 CI/CD、Docker 和部署任务",
      "prompt": "你是 DevOps 工程师..."
    }
  }
}
```

### 禁用某个 Agent

```jsonc
{
  "agent": {
    "researcher": { "disable": true }
  }
}
```

---

## 📦 发布到 npm

如果你想发布自己的 fork：

```bash
npm run build        # 编译 TypeScript → dist/
npm version patch    # 更新版本号
npm publish          # 发布到 npm 仓库
```

---

## 🤝 贡献

欢迎贡献！以下方向特别需要帮助：

- 🌐 **本地化** — 将 Agent prompt 翻译为其他语言
- 🎨 **更多 Agent 角色** — DevOps、DBA、安全专家、UX 设计师
- 🔧 **更多命令** — `/team-deploy`、`/team-docs`、`/team-refactor`
- 📝 **更好的 Prompt** — 通过 Prompt 工程优化 Agent 行为

---

## 📄 许可证

[Apache License 2.0](./LICENSE)

---

## 🔗 链接

- [npm 包](https://www.npmjs.com/package/@te-river/opencode-team-mode) — `@te-river/opencode-team-mode`
- [OpenCode 桌面版](https://opencode.ai) — 官网 & 下载
- [OpenCode 文档](https://opencode.ai/docs) — 配置 & 插件文档
- [OpenCode 插件 API](https://opencode.ai/docs/plugins) — 构建你自己的插件
- [OpenCode GitHub](https://github.com/anomalyco/opencode) — OpenCode 源码
