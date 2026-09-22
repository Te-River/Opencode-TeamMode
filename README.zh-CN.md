# OpenCode TeamMode

**[English](./README.md)** | **[中文](./README.zh-CN.md)**

[![npm version](https://img.shields.io/npm/v/@te-river/opencode-team-mode.svg)](https://www.npmjs.com/package/@te-river/opencode-team-mode)
[![npm downloads](https://img.shields.io/npm/dm/@te-river/opencode-team-mode.svg)](https://www.npmjs.com/package/@te-river/opencode-team-mode)
[![license](https://img.shields.io/npm/l/@te-river/opencode-team-mode.svg)](./LICENSE)

> 🤝 **你的 OpenCode 刚刚招了一个团队。**
>
> 六个专职 agent——主脑（Lead）、架构师、实现者、评审、测试、研究员——配上受治理的工具、结构化交接和"先出计划等你批准"的门禁。一个插件，零配置文件要拷。

> 💡 **建议在中或大型项目下使用该模式。** 治理层（审批门禁、上下文卸载、工具白名单）在代码库有真实体量时是资产，在小脚本和一次性问答上则主要是开销。把团队用在配得上它的地方。

---

## 太长不看

> **懒人路径：** 把下面这段话粘给任意编码 agent，让它替你装：
>
> ```text
> 安装 OpenCode 插件 @te-river/opencode-team-mode：按照
> https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/docs/installation.md
> 的指引完成安装，并按该指南里的检查项验证。
> ```
>
> **装好后只需要记住一条命令：** `/team-run <任务>` —— Team Lead 会先出计划、
> 等你批准、然后调度整个团队干活。

剩下的都是细节。想看的时候按图索骥：

**[为什么](#-为什么是-teammode) · [团队阵容](#-团队阵容) · [安装](#-安装) · [使用](#-使用) · [工具与安全](#-受治理的工具与安全) · [搜索](#-真正好用的网络搜索中国可用) · [配置](#️-配置) · [运作方式](#️-团队怎么运作) · [FAQ](#-faq) · [卸载](#️-卸载)**

---

## 🤔 为什么是 TeamMode？

单个 agent 包打一切的下场你多半见过：上下文窗口塞满 5000 行的文件转储，
一个脚本能干的事跟 bash 磨二十个回合，子 agent 悄悄读你的 `.env`，以及
所谓的"联网调研"——其实全靠模型编。

TeamMode 对每一个的回应：

| 痛点 | TeamMode 的回答 |
|---|---|
| 🔥 **上下文爆炸** | 所有受治理工具的输出超过内容分档阈值（散文 4000 / 数据 2000 token，CJK 感知）就卸载到本地 run 存储，换成 80 token 的预览 + HMAC 句柄。agent 需要什么再分页取什么——窗口永远淹不了。 |
| 🐌 **回合开销** | `tm_ptc_run`：agent 写**一个程序**，单回合内发起 N 次受治理调用。运行期间零 LLM 回合。 |
| 🕳️ **静默副作用** | R6/R2 审批门禁：环境变量读取和危险操作走 OpenCode 官方确认弹窗，1 分钟没人理自动拒绝。插件从不代替你批准——它只会拒绝。 |
| 🌫️ **幻觉式调研** | 联网是双角色的授权 + 白名单受治理工具链。抓不到的事实就报告为缺口——绝不编造。 |
| 🧭 **纯文本墙** | 回复被引导成宿主渲染得最快的形状：逐文件 / 逐用例 / 逐条发现用 markdown 表格，diff 和配置用围栏代码块，浏览器截图只在你明确要求时才内联附上。宿主不画 mermaid，所以没有 agent 会假装它在画。 |
| 🎯 **目标漂移** | lead 开局必须用你自己的措辞写下 `GOAL:` 和可验证的 `ACCEPTANCE:` 判据，判据没有证据支撑这一轮就不算结束——合法的停止只有两种（卡在你这里，或有证据地证明做不到）。一轮收完但宿主 todolist 上还有未完成项时，`tm_join` 会直接说"目标未达成"并列出条目；目标本身随上下文压缩一起存活，摘要不能悄悄把它换掉。 |

底下还有流程纪律：确定性路由表、≥2 次派工先出 ≤30 行计划等你批、agent
之间用 `STATUS/CHANGES/FINDINGS/EVIDENCE/HANDOFF` 结构化交接、以及静态
验证（构建 / 类型检查 / 测试）说了算，不靠感觉。

这套纪律也正是"**建议中大型项目使用**"的原因：两三个文件的小脚本，团队
本来就没多少可治理的东西。

---

## 👥 团队阵容

| Agent | 角色 | 什么时候用 |
|---|---|---|
| 🎯 **Team Lead** (`@team`) | 编排者 | 需要规划 + 多步执行的复杂任务 |
| 🏗️ **Architect** | 系统设计 | 设计文档、模块结构、API 契约 |
| 💻 **Implementer** | 写代码 | 做功能、写生产代码 |
| 🔍 **Reviewer** | 维度审计 | 默认单维度评审；高风险变更才三维度并行 |
| 🧪 **Tester** | 测试工程师 | 带真边界条件的测试；静态验证（构建 / 类型检查 / lint）；经 `tm_browser` 的治理化 UI 验证 |
| 🔎 **Researcher** | 找资料 | 本地仓库优先，然后才是网络——两个联网角色之一（另一个是 Lead） |

开箱即用时 **Team 就是你的默认 agent**——新会话直接进编排者（可在
[配置](#️-配置)里关掉）。

---

## 📦 安装

### 方式一：让 agent 替你装（推荐）

把这段话粘给任意编码 agent——它会改配置、提醒你重启、并完成验证：

```text
安装 OpenCode 插件 @te-river/opencode-team-mode：按照
https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/docs/installation.md
的指引完成安装，并按该指南里的检查项验证。
（若该 URL 无法访问——中国大陆网络常见——改用镜像前缀重试：
https://ghproxy.net/ + 原路径。）
```

（该指南就是完整的手动流程——配置文件位置、插件条目、重启、验证、更新、
卸载。你的 agent 会忠实执行，不需要其他任何东西。）

### 方式二：一行脚本

macOS / Linux（bash）：

```bash
curl -fsSL https://ghproxy.net/https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/scripts/install.sh | bash
```

Windows（PowerShell）：

```powershell
irm https://ghproxy.net/https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/scripts/install.ps1 | iex
```

### 方式三：手动

把插件加进 `opencode.jsonc`：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@te-river/opencode-team-mode@latest"
  ]
}
```

OpenCode 下次启动时装好。

### ⚠️ 现在读一遍，以后省一小时

- **改完配置要重启。** 碰了 `opencode.json` 之后，完全退出再启动 OpenCode（桌面版从托盘退出，不是只关窗口）。
- **插件更新：重跑安装脚本即可。** 安装器是幂等的——重跑会补齐配置（已存在则跳过）、清掉过期插件缓存、并重解析 npm 安装的副本。之所以需要这一步：OpenCode 按 spec 字符串缓存插件，新版本发布后不会重新解析 `@latest`（上游已知问题）。想手动操作的话：

  | 系统 | 缓存位置 |
  |---|---|
  | macOS / Linux | `find ~/.cache/opencode/packages -type d -name '*opencode-team-mode*' -prune -exec rm -rf {} +` |
  | Windows (PowerShell) | `foreach ($r in "$HOME\.cache\opencode\packages", "$env:LOCALAPPDATA\opencode\cache\packages") { if (Test-Path $r) { Get-ChildItem $r -Directory -Recurse -Filter '*opencode-team-mode*' -EA SilentlyContinue | Sort-Object { $_.FullName.Length } | Remove-Item -Recurse -Force -EA SilentlyContinue } }` |

  ⚠️ OpenCode 是从 `~/.cache/opencode/packages/` 加载插件的（可能嵌套在 `@te-river/` 作用域目录里），**不是** `~/.config/opencode/node_modules`——所以删除必须递归：只删顶层会静默漏掉作用域式的缓存副本。

  如果插件还被 npm 装进了 `~/.config/opencode`，package-lock 会钉住版本——在那里再跑一次 `npm install @te-river/opencode-team-mode@latest`。完整配方（含 agent 更新提示词）见[安装指南·更新](./docs/installation.md)。
- **前置条件：** [OpenCode](https://opencode.ai)（桌面版或 CLI）+ Node ≥ 18。

### 验证

重启后打开 agent 选择器，看到 **team、architect、implementer、reviewer、
tester、researcher** 就齐了——团队已就位。

---

## 📖 使用

### 斜杠命令

| 命令 | Agent | 说明 |
|---|---|---|
| `/team-plan <任务>` | Architect | 带架构、文件清单、任务拆解的实施计划 |
| `/team-implement <任务>` | Implementer | 为功能或任务写生产代码 |
| `/team-review [范围]` | Reviewer | 审计 bug、安全问题、质量隐患 |
| `/team-test [范围]` | Tester | 带边界条件的全面测试 |
| `/team-research <主题>` | Researcher | 本地仓库优先；网络走受治理工具 |
| `/team-run <任务>` | Team Lead | **完整流程**——计划 → 批准 → 编排 → 验证 |

也可以直接 `@` 提及：`@team`、`@architect`、`@implementer`、`@reviewer`、
`@tester`、`@researcher`。

### 一次运行长什么样

Team 默认就是默认 agent，所以你只管在全新会话里打字：

> **你：** 给我们的 Express API 加令牌桶限流——每用户每分钟 100 次，超了返回 429。别碰 `src/legacy/` 底下任何东西。

```text
team   路由：产品行为变更 → implementer → tester → reviewer
       （3 次派工 → 触发审批门禁）

       计划
       目标：令牌桶限流，100 req/min/user，429 + Retry-After
       范围：src/middleware/rateLimit.ts（新增）、src/app.ts（+3 行）
       流水线：implementer → tester → reviewer（正确性）
       假设：内存桶，不上 Redis——要改就说
       边界：src/legacy/** 不碰
       批准后开工？

你     批准，干

team   ▸ @implementer — STATUS: done
       CHANGES: src/middleware/rateLimit.ts (new) · src/app.ts (+3)
       EVIDENCE: tsc 干净

       ▸ @tester — STATUS: done · VERDICT: pass (14/14)
       FINDINGS: 突发边沿、窗口过期、并发补充已覆盖；
                 src/legacy/** 逐字节未动

       ▸ @reviewer — STATUS: done · VERDICT: approve（正确性）

team   完成。rateLimit.ts (new) · app.ts (+3) · 14 测试全绿
       评审：approve · 假设：仅内存 · src/legacy/ 未动
```

你输入了任务和四个字。计划是查路由表，执行等你的批准，agent 之间的交接
全部走结构化骨架——没有文件仪式，没有靠猜。

---

## 🧰 受治理的工具与安全

TeamMode 加的每个工具都跑在**同一条治理管线**下：超过卸载阈值的输出永不
进入上下文窗口——阈值按内容分档：散文（text/log/markdown）走
`TM_OFFLOAD_THRESHOLD_TEXT`（4000），结构化数据（json/csv/code/binary）走
`TM_OFFLOAD_THRESHOLD_DATA`（2000），内容类别未知时回退全局
`TM_OFFLOAD_THRESHOLD`。超限输出卸载到 run 存储，换成内容感知预览 +
HMAC 句柄，agent 真需要 payload 时用 `tm_fetch` 分页取。

| 工具 | 功能 | 角色 |
|---|---|---|
| `tm_read` / `tm_grep` / `tm_bash` / `tm_fetch` | 受治理的文件读 / 正则搜索 / 只读 shell（白名单）/ 句柄分页（JSON 句柄支持 `fields` 点路径投影——刻意小的 jq 子集，如 `items[].name`） | 全部六个 agent |
| `tm_memory` | 会话 + 项目 + 全局三层记忆库（Markdown + frontmatter）：add / search / list / forget / compact | 全部六个 agent |
| `tm_ptc_run` | 批量编排：一个程序、N 次受治理调用、零 LLM 回合；联网角色还能在程序里调 `tm.search` / `tm.webfetch` | 全部六个 agent |
| `tm_search` | 多引擎网络搜索，返回提取、去重、RRF 融合后的命中列表 | Lead + Researcher |
| `tm_webfetch` | 白名单页面的单次受治理 GET（搜索页自动提取） | Lead + Researcher |
| `tm_join` | **子代理回收**——插件侧的派发器已经没有了（`tm_dispatch` 被移除：插件创建的子会话，用户既打不开也停不掉）。派活统一走宿主自己的 `task` / `task { background: true }`，`tm_join` 是它的读端：不带参数=状态快照，`waitMs`=有界等待，`cancel:true` 取消跑飞的子任务，`tm_join { ids: ["ses_…"] }` 则把某个子代理的**整篇**回复经卸载管线取回（句柄 + ≤80 token 预览），而不是几千 token 直接压进上下文。插件重启后它还会从宿主会话树重建登记，遗留的子代理被"接管"而不是丢失 | 仅 Lead |
| `tm_pty` | 在宿主自己的终端会话上**非阻塞执行命令**（`start`/`status`/`list`/`kill`）：独立的构建与测试各自一个会话并行跑，不再串成一条 120 秒的 bash 调用。它不抓输出（命令自己 tee 日志，用 `tm_read` 读），且每次启动都先过 R6 分类器、R2 危险面 glob，再走官方确认窗，才真的建进程 | 仅 Lead |
| `tm_stats` | **插件把自己的 trajectory 读回来**：卸载挡在上下文之外的 token（扣掉确实回来的预览）、派发重叠省下的秒数（串行代价减去子代理实际占用的墙钟）、PTC 内部量、治理计数（被拦子资源、`tm_pty` 拒绝、bash 超时夹顶、缓存命中、脱敏次数）——外加**宿主能力矩阵**（每个宿主接口标 `已验证/存在未用/待观察/缺失/需人眼`）。只读本插件自己写的文件；OpenCode 升级后第一个跑它。`{ recent: 20 }` 追加一份逐条调用清单——每次卸载结果的句柄和落盘路径都在里面，这就是"看看刚才那个工具到底返回了什么"的办法（宿主不给插件工具卡片留展开位） | 全角色 |
| `tm_browser` | 交互式浏览器会话（**驱动你的默认浏览器**）：16 个 Playwright 动词（快照优先：`take_snapshot` → 按 uid 寻址的 `click`/`fill`/`drag`…）+ 5 个旧版兼容动词（open/navigate/read/screenshot/close）；Playwright 引擎需 Node ≥ 20，不满足或导入失败时自动降级到旧版 CDP 引擎。它开的是**你自己的默认浏览器渠道**（默认装 Edge Beta 就开 Beta），除操作者设 `TM_BROWSER_HEADLESS` 外保持有头；页面自家图片/CSS/JS 靠 `same-site` 子资源策略正常加载；`take_screenshot { image:true }` 会附一张 JPEG，让模型真能看见画面 | Lead + Researcher + Tester（仅 UI 验证） |

> **固定工具优先级阶梯（每个任务都适用）：① 用户自己的 MCP/插件工具
> → ② TeamMode 受治理工具（`tm_*`） → ③ 模型自己的推理。** 它同时是回退链：某个受治理
> 工具报错（这台机器没浏览器、主机被拦），agent 会说明情况降到下一级，
> 而不是躺平；第 ③ 级里缺失的能力只能如实报"缺口"，绝不编造。
> 一个会当场说明的例外：**网络**这一路仍是 `tm_search` / `tm_webfetch` /
> `tm_browser` 优先，因为只有这条线带着域名白名单、逐次确认窗和 R6 红线，
> 换用户的抓取工具去看同一个页面，等于把这三样治理一起绕掉。

> **宿主 UI 看不到的一部分。** OpenCode 只给"它自己内置的工具"渲染可展开的
> 详情卡片，插件工具（我们的 `tm_*`）永远是一行点不开的条目——它的渲染器注册表
> 是封闭的，外接层加不进去。但结果并没丢：超过卸载阈值的内容都落成了句柄 +
> 磁盘文件，`tm_stats { recent: 20 }` 会把最近每一次调用连同句柄和文件路径
> 列出来。想知道"刚才那个工具到底返回了什么"，直接这么问你的 agent。

> **派活只有一条路：宿主的 `task`，两种形态。** OpenCode 自带的 `task` 是唯一
> 能在界面上**给你看**的子代理——它的卡片直接链到那个子会话，用户也能停掉它；
> 再加 `background: true`，它同时也不阻塞了：子任务跑完，宿主会把你的 lead 唤醒。
> 这个开关是实验性的，要你自己打开：
>
> ```
> OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true
> ```
>
> （给宿主进程设好——Windows 用 `setx`，或从带这个变量的终端启动——然后重启
> OpenCode；安装脚本会替你做好）。打开之后 TeamMode 负责把它压在 token 预算内：
> 注入进来的整篇回复会被换成"预览 + 取回方式"，并且**不会另存一份到磁盘**
> （`TM_TASK_OFFLOAD=off` 就恢复宿主的原样注入）。这条路的代价也说明白：每个后台
> 任务完成都会唤醒 lead 一次、花一轮。留在原地的读端是 `tm_join`：按 id 把某个
> 子代理的整篇回复经卸载管线取回、取消跑飞的子任务、插件重启后从宿主会话树重建登记。
>
> 这里**刻意没有插件侧派发器**：早先的 `tm_dispatch` 创建的子会话，用户既打不开
> 也停不掉，这个代价比它换来的批量收益更大。移除它不影响任何功能——宿主的 `task`
> 一直是那条可见的路。

所有受治理工具都**支持并行**：宿主可以把一批 `tm_search` / `tm_webfetch` /
`tm_fetch` 调用并发执行——每次调用拿到自己的 step id 和自己的 payload，
互不串扰（并行测试套件钉死了这一点）。

### 上下文治理：卸载、句柄、预览

大的工具输出是上下文成本的主要来源——每一步都要重发整个窗口。所以超过
内容分档阈值的（散文 → `TM_OFFLOAD_THRESHOLD_TEXT`，结构化数据 →
`TM_OFFLOAD_THRESHOLD_DATA`，未知类别 → 全局 `TM_OFFLOAD_THRESHOLD`）
结果写进本地 run 存储（`<repo>/.git/opencode-team/`，永不污染工作树），
换成带内容感知预览的句柄：JSON 键 / CSV 表头+形状 / 日志 ERROR×N 统计 /
代码签名 / 二进制元数据，硬顶 80 token。agent 真需要 payload 时用
`tm_fetch`（HMAC 签名、run 域、带过期）分页读；JSON 句柄还可以直接要
`fields` 点路径投影（刻意小的 jq 子集：`items[].name`、
`[].stargazers_count`），大 API 转储只留需要的字段、原文从不进窗口。
`tm_bash` 只放行只读命令（白名单），失败以结构化错误返回，不糊原始转储。

### 会话 + 项目 + 全局三层记忆（tm_memory）

耐久的事实——构建命令、环境怪癖、架构决策、你的约定——以人可编辑的
Markdown + frontmatter 存放，共三层：

- **`session`**：仅本次会话的瞬时事实——进程内、按 TTL 清扫（`TM_MEMORY_SESSION_TTL_MIN`，默认 240 分钟），对其他会话不可见；除非 `TM_MEMORY_SESSION_PERSIST=1` 才落盘到 `memories/sessions/<sid>/`。
- **`project`**（默认）：`<repo>/.git/opencode-team/memories/…` —— 每 checkout 一份，贴近 git。存放本仓库的事实：构建命令、环境怪癖、架构决策。
- **`global`**：`~/.opencode-team/memories/global/`（可用 `TM_MEMORY_GLOBAL_DIR` 覆盖）——**跟着你走遍所有项目**。存放用户级约定：偏好的包管理器、提交风格、工具习惯。

动作：`add` / `search`（确定性关键词打分）/ `list` / `forget` / `compact`；
每条记忆上限 4000 字符。`search` 走全部三层，**会话 > 项目 > 全局**优先：
项目条目获得 +2 的近似同分加权，同名上层条目遮蔽下层（永不浮出）。
近重复从不堆积：`add` 命中同层同分类的既有条目（去重键，或
title+keywords 的 Jaccard ≥ 0.6）时**并入既有条目**——新内容胜出、
keywords 取并集、旧 slug 进 `supersedes:`、答复标注"已合并"（这是正常
现象，别再换个变体标题重复添加）。某层到达 `TM_MEMORY_MAX_ENTRIES`
（每作用域 200）时 add 故意失败：先跑 `compact`——默认 dry-run 只报合并
计划，带 `apply:true` 重跑才执行，执行前所有原件先复制进带时间戳的
`.compact-backup` 树（回滚路径）。超过 `TM_MEMORY_STALE_DAYS`（30 天）的
条目在搜索结果里标 `[stale Nd]`。agent 被要求先搜记忆再做项目假设，
也把来之不易的事实存下来留给下个会话。

### 🌐 真正好用的网络搜索（中国可用）

`tm_search` 是开放式查询的前锋：**一次调用、一个 query、干净结果**。引擎
URL 替你拼好、走受治理管线抓取、压缩成编号的"标题+链接"命中列表——
agent 永远看不到原始搜索页的噪音。

| 引擎 | 说明 |
|---|---|
| `auto`（默认） | 给查询分类，**并行**扇出匹配的引擎（每条路由至少 2 条腿），按 host+path 去重后做加权 RRF 融合，产出标有来源引擎的 top-10 列表。排序按命中与查询词的真实重叠度打折（地板 `TM_SEARCH_RELEVANCE_FLOOR`），高权重引擎的无关结果不再压过别的引擎最好的一条。路由：报错/camelCase API → `stackoverflow`+`github`+`bing`；开发生态（发布、框架、开源）→ `hn`+`github`+`npm`；中文 → `bing`+`moegirl`+`stackoverflow`+`hn`；其它 → `bing`+`stackoverflow`+`hn`+`github`。用 `TM_SEARCH_DEFAULT_ENGINE` 钉别的默认 |
| `bing` | cn.bing.com——唯一活着的中文 HTML SERP；多词 CJK 查询自动保护短语边界（加引号），markup 洗牌拆不散结果列表 |
| `stackoverflow` | api.stackexchange.com 问题搜索（免 Key，300 次/天/IP）→ 带复合摘要的编号问题列表；`auto` 跟踪配额，耗尽自动换 `bing` 顶上 |
| `hn` | Hacker News（Algolia API，免 Key）→ 帖子标题 + 摘要与原文链接 |
| `bilibili` | 视频搜索 |
| `moegirl` | MediaWiki 搜索 API——词条标题 + 摘要，结构化 |
| `npm` | registry 搜索 → name@version + 描述，结构化 |
| `github` | 仓库搜索 API → star 数 + 描述，结构化；`org:` / `user:` / `stars:` / `language:` 限定符透传折进查询（如 `vector db stars:>500 language:rust`） |

七个引擎在中国大陆**全部免 Key 可达**，且全部在种子域名白名单内。旧的
中文 HTML SERP（`sogou` / `so` / `baidu` / `bing-int`）已被**移除**——
实测定标（2026-09-14）显示它们只返回反爬壳或 100% 空结果，连手动选择
都不再提供。空结果时错误信息会点名替代引擎，不让 agent 卡死。另两条
通道补全能力面：

- `tm_webfetch` —— 已知 URL，单次受治理 GET。它抓到的搜索引擎页面同样
  自动提取为命中列表。`registry.npmjs.org/<pkg>/latest` 这类 JSON 端点
  原样透传。
- `tm_browser` —— JS 渲染页：**驱动你的默认浏览器**（Windows 读注册表 /
  Linux 读 xdg-settings；仅限 Chromium 系——默认是 Firefox 时回退到
  Edge/Chrome 探测顺序，因为 CDP 是 Chromium 专有协议；`TM_BROWSER_PATH`
  可强制指定），默认有头运行，隔离临时 profile，**域名白名单在网络层
  逐请求、逐重定向跳强制**。动作面与 chrome-devtools-mcp 对齐：**16 个
  Playwright 动词**（`navigate_page` · `take_snapshot` · `click` · `fill` ·
  `hover` · `drag` · `press_key` · `select_page` · `upload_file` · `wait_for`
  · `evaluate_script` · `list_console_messages` · `list_network_requests` ·
  `list_pages` · `take_screenshot` · `handle_dialog`）+ 5 个旧版兼容动词
  （`open` / `navigate` / `read` / `screenshot` / `close`）。快照优先：
  `take_snapshot` 返回注入了 `[uid=eN]` 标记的 aria 快照，后续动作按 uid
  寻址节点而不是猜定位器；快照受
  `TM_BROWSER_SNAPSHOT_MAX_TOKENS`（默认 1200）硬顶。
  **引擎分工：** 主引擎是 `playwright-core`（optionalDependencies——
  需 **Node ≥ 20**；旧版 Node 或导入失败时，整个插件实例自动降级到零依赖
  `cdp-legacy` 引擎，只保留核心动词；可用 `TM_BROWSER_ENGINE=playwright|cdp-legacy`
  钉死）。从不下载浏览器——Playwright 按路径启动**你自己装的**浏览器，
  `npx playwright install` 不属于用户流程（依赖本体在 npm
  install/发布时解析）。默认隔离临时 profile：登录态想跨会话保留，只有
  显式设置 `TM_BROWSER_USER_DATA_DIR` 这一条路。

**伪装浏览器请求头后仍收到 403** 时，错误信息是一条指令：该站点的门槛是
JS 挑战 / TLS 指纹级别，只有真实浏览器能过——会直接让 agent 调 `tm_browser`
（`action:"open"` → `action:"read"`）打开该 URL。搜索结果提取同时过滤已知
噪音：引擎自身包装链接（`so.com/link?`、`ai.so.com`）和同名不同站的域名
（`maimai.cn` 脉脉 ≠ maimai DX 游戏）不会混入命中列表——用
`TM_HIT_BLACKLIST` 可扩展命中黑名单。

种子白名单（三个联网工具共用，23 个主机；baidu/moegirl/bilibili 用的是父域，
所有兄弟子域——baike.baidu.com、mzh.moegirl.org.cn、space.bilibili.com——
一并覆盖）：`baidu.com`、`moegirl.org.cn`、`bilibili.com`、`www.sogou.com`、
`www.so.com`、`cn.bing.com`、`www.bing.com`、`zhihu.com`、`juejin.cn`、
`csdn.net`、`cnblogs.com`、`gitee.com`、`github.com`、`api.github.com`、
`raw.githubusercontent.com`、`gist.githubusercontent.com`、`ghproxy.net`
（github raw 的大陆镜像）、`stackoverflow.com`、`api.stackexchange.com`
+ `hn.algolia.com`（两个 JSON 搜索引擎）、`npmjs.org`、`pypi.org`、
`learn.microsoft.com`——用
`TM_WEBFETCH_ALLOWED_DOMAINS` 扩展（`"*"` 放开全部主机；自定义列表是
**替换**种子，保留引擎主机否则 `tm_search` 没了目标）。architect /
implementer / reviewer **没有**联网授权——网络问题会报告为缺口，绝不编造。
tester 仅持有 `tm_browser`，用于本项目的治理化 UI 验证（本地开发服务器、
预览路由）；开放网络抓取仍归两个联网角色。

**白名单外是门，不是墙。** 当抓取 / 搜索 / 浏览器打开的目标主机不在白名单
内时，工具会把 URL 交给 OpenCode 的**官方确认弹窗**——由你裁决，每次一个
目标（无人应答照常走 1 分钟自动拒绝，插件依旧绝不代你批准）。每个弹窗
同时触发一条**系统 toast 通知**，即使你没盯着屏幕也知道有待批准的操作。
env 文件 URL 和非 http(s) 协议保持硬拦截、无弹窗——R6 红线不可被"同意"。

### 安全：R6 + R2 审批门禁

**R6 环境变量保护。** TeamMode 激活时，模型不能悄悄读环境变量。env 读取
（`printenv`、`env`、`Get-ChildItem env:` 等）和 env 文件（`.env`、shell rc）
走 OpenCode **官方确认弹窗**；没人应答的弹窗在 `TM_ASK_TIMEOUT_MIN`（默认
1 分钟）后**自动拒绝**。通配符表达不了的 env 读取（命令内嵌 `$VAR` /
`${VAR}` / `$env:`、命令替换）和 `tm_*` 包装通道保持**硬拦截**——没有弹窗
可钻。审计日志只记录工具名 + 模式类别 + 裁决——绝不记录命令文本、路径、
变量名或值。裁决现在还解释"弹窗已无法应答"的情形：应答打到**已关闭**的
弹窗（宿主 404——计时器早已自动拒绝）记为 `already-closed`、不触发降级；
插件侧应答形状错误记为 `rejected-shape-bug`；用户在自动拒绝**之后**才到的
回复记为 `late-<verdict>`（仅可观测——拒绝已成事实，插件依旧绝不代你批准）。
自动拒绝的地板为 1 分钟，可用 `TM_ASK_TIMEOUT_FLOOR_MIN` 调节。短默认值是安全
的：抢在计时器之后的应答会良性记为 `already-closed`（宿主对已关闭弹窗返回
404——不触发门禁降级），实测约 120 秒的滞后是宿主→插件事件总线的**投递**
延迟，并非点击解析延迟。

**R2 危险操作（同一个弹窗）。** 删除、git 发布、网络抓取、包安装/发布、
进程/系统、提权——统统不允许静默放行。日常验证栈（`npm test`、`tsc`、
`git status`）**不在**门禁内，日常开发不受打扰。

> ⚠️ **批准弹窗时选"一次"，别选"总是"。** 在真实宿主上验证过，"总是"记录
> 的规则远比你看到的那条命令宽：用"总是"批准 `Get-ChildItem env:PATH`
> 会存下 `Get-ChildItem *`，之后所有 `Get-ChildItem` 都不再弹窗。

> 弹窗改道是按会话的：env 读取只在运行 TeamMode 注入 agent 的会话里才走
> 弹窗；其他会话里守卫保持硬拦截。`headless opencode run` 会立即自动拒绝
> 没人应答的 `ask`（没有人可问）。

### 仓库卫生

卸载/轨迹/记忆存储都在 `<repo>/.git/opencode-team/`（非 git 目录则进系统临时
目录，并按工作区路径哈希分片成 `opencode-team/w-<hash>/`，一个项目读不到另一个
项目的产物）——**永不进工作树**。每个 agent 被要求完工前删掉自己的临时文件，
一次性产物进系统临时目录。TTL 清扫器在启动时 + 每小时回收过期任务目录；
Team Lead 自己从不删黑板，你可以随时审计任何一次运行。

---

## ⚙️ 配置

插件在启动时注入一切——没有 agent 文件要拷。

> **模型选择很关键。** 分诊、拆解、派工简报、汇总、评审裁决——全从 Team
> Lead 一点上过。那个座位坐个弱模型，专家再强也白搭。把你能拿到的最强
> 推理模型钉在 `team` 上：

```jsonc
{
  "agent": {
    "team": { "model": "anthropic/claude-opus-4-5" },         // Lead 配最强
    "implementer": { "model": "anthropic/claude-sonnet-4-6" } // 专家角色便宜模型够用
  }
}
```

**全局安装** —— 把插件条目放进 `~/.config/opencode/opencode.jsonc`，每个项目都有团队。

**不想让 Team 占默认位：**

```jsonc
{
  "plugin": [
    ["@te-river/opencode-team-mode@latest", { "defaultAgent": false }]
  ]
}
```

你自己定义的同名 agent 永远优先；插件从不覆盖用户定义。覆盖、加人、停用
见[自定义](#-自定义)。

### 环境变量

| 环境变量 | 默认 | 用途 |
|---|---|---|
| `TM_ENV_PROTECT` | `strict` | R6 模式：`strict` / `standard` / `off`（off 同时解除审批计时器） |
| `TM_ASK_TIMEOUT_MIN` | `1` | 无人应答弹窗自动拒绝前等待的分钟数（地板 1 分钟——安全：抢跑应答良性记为 `already-closed`；宿主应答事件到插件晚约 120 秒是事件总线投递延迟，非点击解析延迟）。此外每个受治理工具都会在"这个值 + 15 秒"处自己结束等待——审批闸只在 R6 开启且宿主能回复时才武装，而一个永不返回的工具在界面上读起来就是卡死，不是在请你确认 |
| `TM_ASK_TIMEOUT_FLOOR_MIN` | `1` | 上述自动拒绝的强制最小时长 |
| `TM_ENV_PROTECT_EXTRA_DENY` | — | 额外拦截模式（正则；永远硬拦截，不走弹窗） |
| `TM_OFFLOAD_THRESHOLD` | `2000` | 全局卸载兜底阈值（token，CJK 感知估算）——内容类别未知时使用 |
| `TM_OFFLOAD_THRESHOLD_TEXT` | `4000` | 散文类（text / log / markdown）卸载阈值 |
| `TM_OFFLOAD_THRESHOLD_DATA` | `2000` | 结构化载荷（json / csv / code / binary）卸载阈值 |
| `TM_PREVIEW_MAX_TOKENS` | `80` | 预览硬顶 |
| `TM_FETCH_MAX_LINES` | `2000` | tm_fetch 单页行数上限 |
| `TM_BLACKBOARD_DIR` / `TM_TRAJECTORY_DIR` | `<repo>/.git/opencode-team/…` | 卸载存储 / 轨迹账本（tmpdir 回退按工作区路径哈希分片，所以 `tm_stats` 的窗口只含本工作区流量；显式值 = 绝对或项目相对） |
| `TM_BLACKBOARD_TTL` | `7` | 存储保留天数 |
| `TM_BASH_READONLY_ALLOWED` | 内置表 | tm_bash 白名单 |
| `TM_SEARCH_DEFAULT_ENGINE` | `auto` | tm_search 未显式给 `engine` 时的默认引擎（`auto` = 分类 + 并行扇出 + RRF 融合；也可钉表中任一引擎） |
| `TM_SEARCH_WEIGHTS` | 未设 | 按引擎覆盖融合权重，如 `bing=0.3,hn=0.25`；未列出的沿用内置表 |
| `TM_SEARCH_RELEVANCE_FLOOR` | `0.35` | 与查询词零重叠的命中只保留该比例的权重（压垃圾，不删引擎） |
| `TM_SEARCH_MAX_HITS` | `10` | 每引擎腿与融合列表保留的命中数 |
| `TM_SEARCH_DISABLED_ENGINES` | 未设 | 从引擎表与所有 `auto` 路由中移除的引擎（`sogou,baidu` 写法） |
| `TM_BROWSER_SUBRESOURCE` | `same-site` | 顶层导航过白名单后，页面子资源的策略：`same-site` = 图/媒体/字体/样式表一律放行，脚本/XHR 仅当属于本次会话真正打开过的站点；`passive` = 只放被动资源；`off` = 旧行为（逐请求过白名单）。被拦掉的请求会在下一次快照以"N 个子资源请求被拦截"告知 |
| `TM_BROWSER_IDLE_MS` | `180000` | 无人触碰的浏览器会话超过该毫秒数自动关闭并提示用户（0 关闭该回收）——没人负责的窗口是打扰用户的 bug |
| `TM_BROWSER_ASK_EVAL` | `on` | `evaluate_script` 在**你的**浏览器里跑任意 JS——这是域白名单管不住的唯一动词（白名单限制我们去哪儿导航，管不了已加载的页面交回什么）。每个浏览器会话走一次官方确认窗；没有 ask 桥就拒绝。`off` 恢复旧行为；结果脱敏（JWT/bearer/cookie/api-key 形状）不可关闭 |
| `TM_WEB_CACHE_TTL_SEC` | `300` | 受治理抓取在同一 URL 上可复用多久（0 = 关）。tm_webfetch / tm_search / PTC 桥共用一份缓存；条目以哈希命名（带令牌的查询串不落盘），且只在**静态白名单**放行的那一跳读写——弹窗授权仍是逐请求的，复用命中会标注 缓存命中 |
| `TM_BROWSER_IMAGE_MAX_BYTES` | `400000` | `take_screenshot { image:true }` 内联给模型的 JPEG 上限；超过则只回路径并说明原因 |
| `TM_BASH_TIMEOUT_PROBE_MS` | `60000` | 对只读探针命令（P3 白名单内）强制夹顶模型自设的 `timeout`（0 关闭） |
| `TM_BASH_TIMEOUT_MAX_MS` | `0` | 其它 bash 命令的可选全局上限——默认关闭，真实构建保留它要的超时 |
| `TM_PTY_MAX` | `4` | 本插件同时最多保持多少个 `tm_pty` 终端会话 |
| `TM_JOIN_MAX_WAIT_MS` | `60000` | `tm_join { waitMs }` 的上限。过去是 300 000，于是有了一次"连续两次各等 5 分钟、期间 lead 什么都没做"的实测——等待不是并行，所以默认改成"看一眼就去干活"。上一次没等到任何结算时，第二次等待被截到 10 秒并附替代动作 |
| `TM_TASK_OFFLOAD` | `on` | 把宿主的后台子代理压在 token 预算内：`task { background: true }` 完成时宿主会把子代理全文注入你的会话，这里把超限的正文换成预览 + 取回指针（`tm_join { ids: [...] }`）。**只碰**同时满足三条的 part：`synthetic === true`、正文精确匹配宿主自己的 `<task id=… state="completed">` 信封、且超过文本卸载阈值；任一不满足就原样放过。不往磁盘复制任何东西——全文本来就写在子会话里。`off` 恢复宿主原样注入 |
| `TM_TOOL_HINTS` | `on` | 通过 `tool.definition` 把本插件的调用点纪律追加到内置 `bash` / `task` 的**描述**后面（只追加、幂等，绝不替换宿主原文） |
| `TM_AGENT_TEMPERATURE` | `off` | `on` 时按角色分档采样（architect 0.35 / researcher 0.3 / reviewer 0.1 / 其余 0.2）经 `chat.params` 生效；也可写 `reviewer=0.05;team=0.4`。默认关闭＝守住"所有 agent 0.2"这条既定原则 |
| `TM_COMPACTION_CONTEXT` | `on` | 在宿主压缩前追加"必须存活清单"（回复骨架、offload 句柄、未回收的子会话 id、出处、板上路径）。只做追加——宿主自己的压缩提示词不被替换 |
| `TM_COMPACTION_AUTOCONTINUE` | `on` | 设 `off` 则压缩后不让宿主静默续跑，先由人复核状态 |
| `TM_SHELL_NO_COLOR` | `on` | 经 `shell.env` 给每个子 shell 注入 `NO_COLOR`/`TERM=dumb`（ANSI 进度条纯属上下文税）。绝不覆盖宿主已设的值 |
| `TM_SHELL_ENV` | — | 显式 `KEY=VALUE;KEY2=VALUE2` 透传进子 shell——刻意用白名单，避免这个钩子变成父环境泄露通道 |
| `TM_WEBFETCH_ALLOWED_DOMAINS` | 23 个种子主机 | tm_webfetch / tm_search / tm_browser 白名单（`"*"` 全开；空 = 全拒；自定义值**替换**种子——保留引擎主机） |
| `TM_BROWSER_PATH` | 自动探测 | tm_browser 可执行文件覆盖（默认用你的默认浏览器——Chromium 系时；否则回退 Edge/Chrome 探测） |
| `TM_BROWSER_HEADLESS` | `auto` | `1` 无头（CI）/ `0` 有头 / `auto`（仅无显示的 Linux 用无头） |
| `TM_BROWSER_ENGINE` | `playwright` | `playwright`（需 Node ≥ 20；导入失败自动降级）/ `cdp-legacy`（零依赖 CDP pipe，仅核心动词） |
| `TM_BROWSER_SNAPSHOT_MAX_TOKENS` | `1200` | `take_snapshot` 载荷硬顶 |
| `TM_BROWSER_USER_DATA_DIR` | —（隔离临时 profile） | 显式持久 profile 目录——登录态跨会话保留的唯一途径 |
| `TM_MEMORY_GLOBAL_DIR` | `~/.opencode-team/memories/global/` | tm_memory GLOBAL 层存储 |
| `TM_MEMORY_SESSION_TTL_MIN` | `240` | session 层条目 TTL（惰性 + 启动清扫） |
| `TM_MEMORY_MAX_ENTRIES` | `200` | 每作用域条目上限；超限 add 故意失败——先跑 `compact` |
| `TM_MEMORY_STALE_DAYS` | `30` | 超过此天数的条目在搜索结果标 `[stale Nd]`（`0` 关闭） |
| `TM_MEMORY_SESSION_PERSIST` | —（瞬态） | `1` 时 session 条目同时落盘 `memories/sessions/<sid>/` |
| `TM_HIT_BLACKLIST` | `maimai.cn` | 永不进入搜索命中列表的额外域名（逗号/分号分隔；过滤同名不同站噪音） |
| `TM_PTC_MAX_PROGRAM_CHARS` | `4000` | PTC 程序源码上限 |
| `TM_PTC_MAX_CALLS` | `20` | PTC 单次运行桥接调用预算（1–200） |
| `TM_PTC_MAX_ERRORS` | `3` | PTC 单次运行错误预算（1–50） |
| `TM_PTC_TIMEOUT_MS` | `60000` | PTC 单次运行墙钟超时（5s–10min） |
| `TM_PTC_ENGINE` | `auto` | `auto`（worker→inline 降级）/ `worker` / `inline` |
| `TM_PTC_WEB_BRIDGE` | `on` | 向 PTC 程序暴露 `tm.search` / `tm.webfetch`（`off` 从桥接集移除） |

---

## ⚙️ 团队怎么运作

子 agent 之间不能实时互发消息（平台限制），所以 TeamMode 用**结构化回复
骨架**协调——每个专家的回复都是 `STATUS: / CHANGES: / FINDINGS: / EVIDENCE:
/ HANDOFF:`，≤50 行，Lead 原文转投给下一次派工。文件是例外不是常规：超过
约 50 行的交付物写**一个**指名的黑板文件，放在 `<repo>/.git/opencode-team/`
下（round 后缀，工作树分毫不动）。

- **路由表：** 提问 → 直接回答；纯文档 → implementer；产品行为变更 →
  implementer → tester → reviewer；多模块 → architect → implementer →
  tester → reviewer(s)；陌生技术 → researcher 先行。固定下限——产品变更
  路由低于 3 次派工就是路由 bug。
- **审批门禁（计数式）：** ≥2 次派工 → 计划（≤30 行）→ **等你批准** → 执行。
  阻塞性问题立刻批量问，不猜、不挤牙膏。
- **并发派工：** 互相独立的派工批进**同一轮**并行执行（多 implementer 各带
  文件所有权 + 原文数据契约、三维度评审、分包 tester 同时跑）；派工权 Team
  Lead 独有——专家角色已收回 `task`，子代理不再生子代理。
- **自适应评审：** 默认一名评审；高风险画像（鉴权/安全面、跨模块契约、
  公共 API）才三维度并行。
- **静态验证：** 构建 / 类型检查 / lint / 测试。禁止临时起意的浏览器自动化；
  未验证的 UI 工作以 `UI NOT VERIFIED: <待人工检查项>` 收尾。
- **证据标准：** "完成 / 修好 / 通过"必须带可验证证据——输出、日志、diff。

---

## 🔧 自定义

**覆盖某个 agent** —— 同名即覆盖：

```jsonc
{
  "agent": {
    "reviewer": {
      "model": "anthropic/claude-sonnet-4-6",
      "prompt": "你是个极严格的评审。有 lint 警告一律打回。"
    }
  }
}
```

**在团队旁加自己的 agent：**

```jsonc
{
  "agent": {
    "devops": {
      "mode": "subagent",
      "description": "负责 CI/CD、Docker 和部署任务。",
      "prompt": "你是 DevOps 工程师……"
    }
  }
}
```

**停用一个：** `"researcher": { "disable": true }`。

**黑板保留期** 用元组形式：`["@te-river/opencode-team-mode@latest", { "ttlDays": 7 }]`（有效区间 (0, 365]，非法值回退 5）。

---

## ❓ FAQ

**会不会很烧 token？**
恰恰相反，省 token 就是设计目标。卸载 + 80 token 预览 + PTC 批量程序的存在
理由就是：五 agent 流水线要是裸接一个上下文窗口，那才叫烧 token。治理本身
就是省 token 的机制。

**联网安全吗？**
这是全插件防守最严的面：两个完整联网角色 + 仅浏览器的 tester 授权、域名
白名单（白名单外走官方弹窗由你批准，并带 toast 通知）、重定向逐跳复检、
浏览器
网络层强制、env 文件 URL 拒绝，且每个 payload 都走同一套卸载治理。白名单
页面不可能把抓取弹到站外。

**插件为什么不自动更新？**
OpenCode 按 spec 字符串缓存插件，从不重新解析 `@latest`（上游问题，不是
我们的）。**重跑安装脚本就是更新**（它会清缓存、重解析 npm 副本）；或者
手动删缓存目录。配方在上面和[安装指南](./docs/installation.md)里。

**agent 能并行调工具吗？**
能——而且是为并行**专门设计**的：并行的 `tm_search` / `tm_webfetch` /
`tm_fetch` 拿到互不相同的 step id 和互相隔离的 payload。这里出回归，测试
套件会在它到你面前之前先红。

**CLI（TUI）能用吗，还是只有桌面版？**
都能。桌面版多了彩色 agent 选择器和并行面板；受治理工具和整个工作流与
宿主无关。无显示的 Linux 上 `tm_browser` 自动转无头。

**确认弹窗我不理会会怎样？**
`TM_ASK_TIMEOUT_MIN`（默认 1 分钟）后自动拒绝。插件从不自我批准——它
能站的队只有"你"或者"没人"。

---

## 🗑️ 卸载

1. 从配置文件的 `"plugin"` 数组里移除该条目。
2. 想回收磁盘就删缓存目录（见[安装](#-现在读一遍以后省一小时)里的表格）。
3. 重启 OpenCode。agent、命令、工具全部消失；`<repo>/.git/opencode-team/`
   下的存储（全局记忆在 `~/.opencode-team/`）都是普通文件，随时可删。

没有 DLL 受伤。工作树什么都没写。

---

## 🏛️ 架构（给好奇的人）

```
opencode-team-mode/
├── src/
│   ├── index.ts          ← 插件入口（config + R6 守卫 + 审批门禁 + 工具段）
│   ├── agents.ts         ← Agent 结构（mode、颜色、温度、白名单矩阵）
│   ├── prompts/          ← Agent 提示词（lead / specialists / shared）——测试钉死
│   ├── commands.ts       ← 斜杠命令定义
│   ├── blackboard.ts     ← 共享黑板 + TTL 清扫
│   ├── envprotect.ts     ← R6 门面（patterns / 分类器 / 门禁谓词 / hook）
│   ├── approval-gate.ts  ← 统一审批门禁（弹窗超时自动拒绝）
│   ├── tm/               ← 受治理工具：pipelines / store / preview / guard / refs /
│   │                        webfetch / search / memory / browser / shell-bridge / ptc/（9 模块）
│   └── types.ts          ← 加载器契约类型（1.18.x）
├── docs/installation.md  ← agent 可消费的安装指南
├── scripts/              ← 一行安装脚本（bash / PowerShell）
├── pt07/                 ← PT-07 基线套件（种子化 A/B token 测量）
└── README.*.md           ← 你在这里（有两个版本）
```

加载器只调一次 `server(input, options)`：`config` 钩子注入六个 agent 和六个
命令，同一次调用装上 R6 `tool.execute.before` 守卫、通过 `event` 钩子布防
审批门禁、注册 `tm_*` 工具。用户自定义的同名 agent 永远赢——插件从不覆盖。

---

## 🤝 参与贡献

欢迎 issue 和 PR。特别需要：agent 提示词的多语言化、更多角色、更多命令
模板，以及各搜索引擎真实行为的实测报告（它们经常改版；提取器的过滤故意
放宽，但不会读心术）。

---

## 📄 许可

[Apache License 2.0](./LICENSE)

---

## 🔗 链接

- [npm 包](https://www.npmjs.com/package/@te-river/opencode-team-mode) — `@te-river/opencode-team-mode`
- [安装指南](./docs/installation.md) — 完整的手动 / agent 可消费流程
- [OpenCode Desktop](https://opencode.ai) — 官网与下载
- [OpenCode 文档](https://opencode.ai/docs) — 配置与插件文档
- [OpenCode 插件 API](https://opencode.ai/docs/plugins) — 开发你自己的插件
