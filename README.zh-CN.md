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
> 安装 OpenCode 插件 @te-river/opencode-team-mode：本包**只支持 OpenCode 2.x**——1.18.x 人格已在 1.7.0 线里整体移除。
> 2.x → https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/docs/installation-v2.md
> （2.x 的插件不能创建 agent，六个角色和六条 `/team-*` 命令要靠那份指南里的生成步骤落到
> 配置目录——这一步不是可选的。）然后按该指南里的检查项验证。
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
| 🐌 **回合开销** | 宿主自己的 `execute`（Code Mode）：agent 写**一个程序**，单回合内发起 N 次受治理调用。运行期间零 LLM 回合。 |
| 🕳️ **静默副作用** | R6/R2 审批门禁：环境变量读取和危险操作走 OpenCode 官方确认弹窗，1 分钟没人理自动拒绝。插件从不代替你批准——它只会拒绝。 |
| 🌫️ **幻觉式调研** | 联网是双角色的授权 + 白名单受治理工具链。抓不到的事实就报告为缺口——绝不编造。 |
| 🧭 **纯文本墙** | 回复被引导成宿主渲染得最快的形状：逐文件 / 逐用例 / 逐条发现用 markdown 表格，diff 和配置用围栏代码块，浏览器截图只在你明确要求时才内联附上。宿主支持哪些语法是实测出来的、不是照着 CommonMark 猜的，提示词里带着这份实测的否定清单——脚注 `[^1]`、`==高亮==`、单独的 `---` 分隔线和 `$…$` 数学会以字面量形式出现在你面前，所以 agent 被明确告知不要用；而 `mermaid` 图是可以用的，因为这个宿主确实会画。 |
| 🎯 **目标漂移** | lead 开局必须用你自己的措辞写下 `GOAL:` 和可验证的 `ACCEPTANCE:` 判据，判据没有证据支撑这一轮就不算结束——合法的停止只有两种（卡在你这里，或有证据地证明做不到）。一轮收完但宿主 todolist 上还有未完成项时，`tm_join` 会直接说"目标未达成"并列出条目；目标本身随上下文压缩一起存活，摘要不能悄悄把它换掉。 |
| 🗣️ **用你没选的语言回话** | 受治理工具回复的是中文，agent 放任自己就会把这份中文原样反射给你。现在每个角色都带一条回复语言规则：**你用的语言优先**；中文句子只在"它本身就是证据"时逐字引用（close 的三种裁决、拒绝语）——把裁决词翻译掉，正是未经核实的结论看起来像核实过的开始。 |
| ⏱️ **为了"看起来很认真"而烧掉的轮次** | 效率至上写进了 lead 和五个专家：一次宽调用代替三次窄调用、互不依赖的调用并到同一轮、≥3 个探测合成一次 `execute`（Code Mode）程序、不许为了"再看它绿一遍"重跑同一个检查。同时把边界写死：效率不能拿去赎回证据规则——一个没验证过的"done"会让你赔上那一轮 **加上** 那个 bug。 |

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
| 🧪 **Tester** | 测试工程师 | 带真边界条件的测试；静态验证（构建 / 类型检查 / lint）；经宿主原生 `browser_*` 工具的治理化 UI 验证 |
| 🔎 **Researcher** | 找资料 | 本地仓库优先，然后才是网络——两个联网角色之一（另一个是 Lead） |

开箱即用时 **Team 就是你的默认 agent**——新会话直接进编排者（可在
[配置](#️-配置)里关掉）。

---

## 📦 安装

### 方式一：让 agent 替你装（推荐）

把这段话粘给任意编码 agent——它会改配置、提醒你重启、并完成验证：

```text
安装 OpenCode 插件 @te-river/opencode-team-mode：本包**只支持 OpenCode 2.x**——1.18.x 人格已在 1.7.0 线里整体移除。
2.x → https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/docs/installation-v2.md
（2.x 的插件不能创建 agent，六个角色和六条 `/team-*` 命令要靠那份指南里的生成步骤落到配置
目录——这一步不是可选的。）按该指南里的检查项验证。
（若 URL 无法访问——中国大陆网络常见——改用镜像前缀重试：
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

> **OpenCode 2.x 上键名是 `plugins`（复数）**——2.x 宿主完全不读单数的 `plugin`，而且它会
> 在启动时按这个条目自己装包。2.x 的装法见
> [docs/installation-v2.md](./docs/installation-v2.md)（那里插件不能创建 agent，六个角色和
> 六条命令是生成的配置文件）；宿主装载器的原始代码在
> `docs/research/plugin-loader-contract.md`。

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

### 🖥️ 安装会在你机器上改什么

一共三处，都在这个仓库之外——之所以写出来，是因为一个悄悄改你系统环境的插件，
不值得信任。

| 改了什么 | 落在哪 | 存在多久 |
|---|---|---|
| OpenCode 配置里的插件条目 | `~/.config/opencode/opencode.jsonc`（不存在就新建；已有 `opencode.json` 会被**迁移进** `.jsonc`，原文件不动） | 直到你删掉那行 |
| 清掉的插件缓存 | `~/.cache/opencode/packages/*opencode-team-mode*`（含里面真正被加载的嵌套 `node_modules` 副本） | 下次启动重新下载——缓存本就没有"恢复"一说 |
| **一个用户级环境变量** | `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` | **Windows：`setx` 写进你的用户配置——重启后仍在，而且你之后启动的每一个程序都看得到它，不只是 OpenCode。** macOS 用 `launchctl setenv`、Linux 用 `systemctl --user set-environment`：只在本次登录会话内（重启后要再跑一次安装脚本） |

为什么非得动第三个：`task { background: true }` 是唯一能在 OpenCode 界面上
**给你看**的子代理——卡片直接链到那个子会话，你也能停掉它。而宿主是靠**它自己
进程上的一个开关**打开它的，插件没法在加载自己的进程里设标志，所以这个开关只能
从环境里来。不设也不会坏：`task` 只是会挡住 lead，卡片也停在非后台形态。

撤销：

```powershell
# Windows —— 从用户配置里删掉
[Environment]::SetEnvironmentVariable("OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS", $null, "User")
```

```bash
launchctl unsetenv OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS          # macOS
systemctl --user unset-environment OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS   # Linux
```

或者安装时直接跳过，这样脚本只碰上面那两处文件：

```powershell
.\install.ps1 -NoBackgroundSubagents                     # 或 $env:TEAMMODE_SKIP_BACKGROUND_SUBAGENTS="1"
```

```bash
TEAMMODE_SKIP_BACKGROUND_SUBAGENTS=1 bash install.sh
```

无论走哪条，安装脚本都会打印它改了什么，并且**把值读回来核对**，而不是信自己的退出码。

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
| `tm_fetch` | 句柄分页：取回被卸载的结果（JSON 句柄支持 `fields` 点路径投影——刻意小的 jq 子集，如 `items[].name`） | 全部六个 agent |
| `tm_memory` | 会话 + 项目 + 全局三层记忆库（Markdown + frontmatter）：add / search / list / forget / compact | 全部六个 agent |
| `tm_board_write` | **黑板的写入侧**：只在 `<board-root>/<session-key>/<task-slug>/NN-<role>-<topic>[-rN].md` 放下一个**新**的 Markdown 文件，文件名由工具自己决定——修订是一个带 `-rN` 的新文件，绝不覆写；回复只给路径和字节数，绝不回传正文。它存在的理由是：落黑板原本需要一个文件工具，而 `architect` / `researcher` 一个都没有（没有 `write`、没有 `edit`、连用来给会话目录打时间戳的 `bash` 都没有），于是这两类角色的超长交付每次都以 `BLACKBOARD WRITE FAILED` + 整篇文档内联回来收场——本项目最看重的那个回复形态，恰恰在最需要的角色身上无法执行。范围是强制的：路径段做规整、目标用 realpath 对齐黑板根（符号链接的任务目录直接拒写）、文件名永远以 `.md` 结尾（所以造不出 `.env`/rc 文件）、正文受 `TM_BOARD_MAX_CHARS` 与会话文件数上限约束 | 全部六个 agent |
| `tm_search` | 多引擎网络搜索，返回提取、去重、RRF 融合后的命中列表 | Lead + Researcher |
| `tm_webfetch` | 白名单页面的单次受治理 GET（搜索页自动提取）。重定向逐跳手动过检，被拒时会把**整条链**报出来（`跳转链: a → b（停在第 2 跳）`）——以前只会报最后一个主机，一个在白名单内的短链跳到站外时，读起来像"这个站点抓不到"，于是 agent 又回去重试它刚眼睁睁失败的入口 URL。429/503 若带 delta-seconds 的 `Retry-After` 会一并报出（HTTP-date 形式刻意不折算成倒计时），所以"待会儿再来"不会被当成"这里没东西"。读页面时还会优先要 Markdown（`Accept: text/markdown,…`）——实测 `learn.microsoft.com`：60 778 B 的 HTML 变成 11 449 B 的 Markdown，其余站点两种请求返回同一份文档，所以在不支待的地方这个偏好是零成本的 | Lead + Researcher |
| `tm_ledger` | **领队的任务清单**（`add` / `doing` / `done` / `blocked` / `list`），存在宿主自己的 `ctx.storage` 里、按会话分开——OpenCode 2.x 不给插件 `todowrite`，LEDGER 规则从此有了落点。同一个要求重复提出只算一条；编号撞上两条会拒绝并把两条都列出来；`blocked` 带上卡住的原因；写不进存储就报失败，不会说成「已记录」 | 仅领队 |
| `tm_join` | **子代理回收**——插件侧的派发器已经没有了（`tm_dispatch` 被移除：插件创建的子会话，用户既打不开也停不掉）。派活统一走宿主自己的 `task` / `task { background: true }`，`tm_join` 是它的读端：不带参数=状态快照，`waitMs`=有界等待，`cancel:true` 取消跑飞的子任务，`tm_join { ids: ["ses_…"] }` 则把某个子代理的**整篇**回复经卸载管线取回（句柄 + ≤80 token 预览），而不是几千 token 直接压进上下文。插件重启后它还会从宿主会话树重建登记，遗留的子代理被"接管"而不是丢失。**2.x 上它还会登记宿主自己的 `subagent` 工具派出去的子会话**（凭据就是那句确认里的 `metadata.sessionID`），所以用户明明在屏幕上看着子代理跑、`tm_join` 却说"没有待收集的派发"这种事不会再发生；这类行同时说清自己的正文是从哪儿到的（宿主的注入消息），以及它是靠事件结算的还是靠推断结算的。**停掉一个也是真调用**：`cancel: true` 走宿主自己的 `POST /api/session/{id}/interrupt`（`tm_join { ids: ["ses_…"], cancel: true }` 停指定的那一个，不带 `ids` 就停所有还在跑的）。宿主给这个端点写下的契约是"活动执行被中断返回 interrupted=true，空闲时是 no-op 返回 false"，所以回话刻意分成**五种裁决**：已由宿主中断 / 空闲未中断（它当时没在跑——是我们的登记行过时了，不是失败）/ 未确认（调用成功了但宿主没回布尔）/ 无中断缝 / 被宿主拒绝（带上宿主自己的原因），既在回复里计数，也写进轨迹（`stop_tried` / `stop_confirmed` / `stop_refused` / `stop_unknown`，可用 `tm_stats` 读回）。五个不同的事实不会被压成一句"已取消"；`resume` 也刻意从不发送，因为"中断后继续消化排队的引导输入"和"取消"正好相反。*（这项能力目前只在 `main` 上：已发布的 1.6.1 在 2.x 上仍然回一句"宿主无 abort 接口，未取消"。）* | 仅 Lead |
| `tm_stats` | **插件把自己的 trajectory 读回来**：卸载挡在上下文之外的 token（扣掉确实回来的预览）、派发重叠省下的秒数（串行代价减去子代理实际占用的墙钟）、治理计数（被拦子资源、shell 超时夹顶、缓存命中、脱敏次数）——外加**宿主能力矩阵**（每个宿主接口标 `已验证/存在未用/待观察/缺失/需人眼`）。只读本插件自己写的文件；OpenCode 升级后第一个跑它。`{ recent: 20 }` 追加一份逐条调用清单——每次卸载结果的句柄和落盘路径都在里面，这就是"看看刚才那个工具到底返回了什么"的办法（宿主不给插件工具卡片留展开位） | 全角色 |

> **v1（1.18.x）人格已在 1.7.0 线里整体移除。** 包只导出 `{id, setup}`，所以
> `tm_read` / `tm_grep` / `tm_bash` / `tm_ptc_run` / `tm_pty` 一并消失——这些活现在由
> 宿主自己的 `read` / `grep` / `glob` / `shell` 和它的 `execute`（Code Mode）承担。
> 治理没有跟着消失：超大的原生结果照样被 `tool.execute.after` 卸载
> （实测：`shell` 的 12,902 token 变成 78 token 的预览），地址红线和 R6 的按命令分类
> 都跑在宿主的 `permission.evaluate` 上。`tm_ledger` 是领队的清单，落在宿主不给插件
> `todowrite` 的地方。
> **我们改的一切都不会溢到 Team 之外。** v2 的每个钩子对宿主上所有会话都会触发，所以工具面
> 裁剪、0.2 温度、黑板注记、原生结果卸载、R6 与地址红线的收紧、强制后台派发，全都会先问一句
> "这是我们六个角色吗"——`build`、`plan` 和你自己的 agent 保持刚装好时的原样。宿主没告诉我们会话
> 归属的调用同样不碰，并且会计数（`tm_stats` 里是 `作用域：我们 · 他人 · 未判定`）。
> 安装器写出的六个角色提示词，
> 里面点名的是 `read` / `grep` / `shell` 而不是这些已移除的别名。

> **在 OpenCode 2.x 上，交互式浏览交给宿主，治理仍在我们手里。** 桌面端侧边栏挂的是**服务端自己的**浏览器
> 服务——插件没法把自己的页面注册进去（取证：`docs/research/browser-pane.md`）。所以三个有联网授权的角色
> （领队 / researcher / tester）用宿主的 `browser_*` 工具——自建 `tm_browser` 已在 1.7.0 移除，
> 宿主目录是唯一的浏览器；没有原生浏览器目录的宿主（CLI / standalone）从此没有浏览器可用，
> agent 如实报告这个缺口，绝不模拟。交出去的是浏览器，不是治理：活体观测里 `browser_*` **不触发**
> `permission.evaluate`，所以门禁改挂在 `tool.execute.before` 上——判定每次 navigate/open 的 URL、每次
> `browser_preview` 的路径，以及写在 `execute` 程序里的浏览器 URL；不合规则就拒绝，而宿主若把已拒绝的调用
> 照样跑了，就把页面换成同一段拒绝语，越权内容不会进上下文、store 或轨迹。宿主已发出的请求我们撤回不了，
> 这照实说，不谎称拦住过；`tm_stats` 把两个数分开给（拒绝 N 次 / 被放过去 M 次）。卸载规则在此有一条例外：
> `browser_snapshot` 是**寻址表**不是文档，所以它是**截断**（每行 `[ref=…]` 都留、丢静态文字，预算
> `TM_NATIVE_SNAPSHOT_MAX_TOKENS` 默认 1 200）而不是换成句柄。261 个 ref 的页面实测：
> 从头截断只剩 118 个 ref，这种方式 261 个全留，11 326 token 里只占 1 044。

> **固定工具优先级阶梯（每个任务都适用）：① 用户自己的 MCP/插件工具
> → ② TeamMode 受治理工具（`tm_*`） → ③ 模型自己的推理。** 它同时是回退链：某个受治理
> 工具报错（这台机器没浏览器、主机被拦），agent 会说明情况降到下一级，
> 而不是躺平；第 ③ 级里缺失的能力只能如实报"缺口"，绝不编造。
> 一个会当场说明的例外：**网络**这一路仍是 `tm_search` / `tm_webfetch`
> 优先，因为只有这条线带着域名白名单、逐次确认窗和 R6 红线，
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
> OpenCode；安装脚本会替你做好，但那是一次**持久的用户级写入**，具体键名、存活
> 时间和撤销命令见[安装会在你机器上改什么](#️-安装会在你机器上改什么)）。打开之后 TeamMode 负责把它压在 token 预算内：
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
宿主的 `shell` 在它自己的权限规则下跑只读探针，失败以结构化错误返回，不糊原始转储。

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
- **交互式浏览交给宿主自己的 `browser_*` 工具**（`browser_tabs_open` ·
  `browser_navigate` · `browser_snapshot` · `browser_click` · `browser_evaluate`
  …）。自建 `tm_browser` 已在 **1.7.0 移除**（破坏性变更）：桌面端侧边栏挂的是
  **服务端自己的**浏览器服务，插件没法把自己的页面注册进去（取证：
  `docs/research/browser-pane.md`）。原生目录由 `src/host/v2-browser-gate.ts` 在
  `execute.before` 上把关——每次 navigate/open 的 URL、每次 `browser_preview` 的路径、
  以及写在 `execute` 程序里的浏览器 URL，都按地址红线和环境文件规则分类；宿主若把已拒绝的
  调用照样跑了，就把页面换成同一段拒绝语，越权内容不会进上下文、store 或轨迹。
  调用约定与已删除的工具不同：`evaluate` 的参数是 `{tabID, script}`，`script` 是**表达式**
  （不是函数源文本），返回对象要自己 `JSON.stringify` 成标量；快照的可寻址记号形如
  `@e8 [link]`。**已知代价，已接受：** 没有原生浏览器目录的宿主（CLI / standalone）
  从此没有浏览器可用——agent 如实报告这个缺口，绝不模拟。

**伪装浏览器请求头后仍收到 403** 时，错误信息是一条指令：该站点的门槛是
JS 挑战 / TLS 指纹级别，只有真实浏览器能过——会直接让 agent 用宿主原生
`browser_navigate` 打开该 URL（再用 `browser_snapshot` 读）。搜索结果提取同时过滤已知
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
tester 仅持有宿主原生 `browser_*` 工具，用于本项目的治理化 UI 验证（本地开发服务器、
预览路由）；开放网络抓取仍归两个联网角色。

**白名单外是门，不是墙。** 当抓取 / 搜索 / 浏览器打开的目标主机不在白名单
内时，工具会把 URL 交给 OpenCode 的**官方确认弹窗**——由你裁决，每次一个
目标（无人应答照常走 1 分钟自动拒绝，插件依旧绝不代你批准）。每个弹窗
同时触发一条**系统 toast 通知**，即使你没盯着屏幕也知道有待批准的操作。
env 文件 URL 和非 http(s) 协议保持硬拦截、无弹窗——R6 红线不可被"同意"。

### 安全：R6 + R2 审批门禁

**在 OpenCode 2.x 上，R6 默认开启。** Team 角色用原生 `read` 读 `.env` 会被直接拒——没有同意路径；读环境变量的 shell 命令
走宿主自己的权限提示（2.x 上插件弹不出对话框，所以 shell 面是宿主的 `ask`，env-FILE 面是硬 `deny`）。
关闭方式：插件选项 `envProtect: false`，或 `TM_ENV_PROTECT=off`。

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
> 会存下 `Get-ChildItem *`，之后所有 `Get-ChildItem` 都不再弹窗。联网通道有同一个
> 坑，而且更容易踩：对某个域名点一次"总是"，**该项目下所有 agent 会话**就都能打开
> 它，按 agent 隔离的浏览器同意从此不再被询问。现在回复会写明这次是哪条路放行的
> （静态白名单 / 你刚答过的确认窗 / 毫秒内替你答完的已存规则）——分不清这三者的
> agent，会把"没弹窗"报告成"这个站是被允许的"。

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
  "plugins": [
    { "package": "@te-river/opencode-team-mode@latest", "options": { "defaultAgent": false } }
  ]
}
```

注意形状：2.x 的插件条目要么是字符串，要么是带 `package` 与 `options` 的**对象**。1.x 那种
`["@te-river/opencode-team-mode@latest", { … }]` 元组会被直接拒（`path=$.plugins.1 kind=invalid`，
2026-10-06 实测）。选项确实能传进来——用对象形状时 `{ "ttlDays": 7 }` 的 boot 行读出
`board_ttl_days=7`，这是实测不是文档承诺。

你自己定义的同名 agent 永远优先；插件从不覆盖用户定义。覆盖、加人、停用
见[自定义](#-自定义)。

### 环境变量

| 环境变量 | 默认 | 用途 |
|---|---|---|
| `TM_ENV_PROTECT` | `strict` | R6 模式：`strict` / `standard` / `off`（off 同时解除审批计时器）
| `TM_R6_FINE_ASK` | 按命令行判定 | 命令行由宿主的 `permission.evaluate` 钩子逐次判定，所以普通 `git status` 什么都不问、导出环境变量照样问。`off` 退回"每条 shell 命令都问"——宿主不提供该钩子时也会自动走这条路，而且启动日志会说是哪一个原因造成的 |
| `TM_V2_CODEMODE` | catalog（`direct` 需显式开启）——**仅 v2** | 我们的工具怎么送到模型面前。OpenCode 2.x 用 `options.codemode` 决定可见性。我们曾默认发 `codemode:false` 并宣称"以真实定义交付"——**一次 2.0.16 桌面端活体会话把它推翻了**：发了那个标志之后，十个 `tm_*` 仍然只出现在宿主的 Code Mode 目录里（原文："They cannot be called directly…"），模型可直接调用的是那九个原生工具。所以默认什么都不发，`direct` 留给可能认它的构建做实验。能核对的只有关停记录里的 `tools_in_request`（`tm_stats` 渲染成"请求内实际可见=…"），不是我们发出的标志 |
| `TM_PRIVATE_SPACE` | `deny` | 私网（回环、RFC1918、ULA、CGNAT、`.localhost`）经我们工具时的行为：`allow` 放开整段，`deny` 拒绝。默认 `deny`，因为 2.x 插件弹不出窗子——"等用户批准"在一台给不出确认框的宿主上不是闸门，是让 agent 干等。所以拒绝语会印出两条操作者自己走得通的出口（`TM_PRIVATE_SPACE=allow`，或把这一台主机名写进 `TM_WEBFETCH_ALLOWED_DOMAINS`）。元数据 / 链路本地 / 保留段不在这个开关管辖内：任何设置都拒，也没有批准路径 |
| `TM_V2_BROWSER_GATE` | 开——**仅 v2** | 对宿主 `browser_*` 目录的门禁（`execute.before` 判 URL 与 `browser_preview` 路径，也扫 `execute` 程序里出现的浏览器 URL）。`off` 恢复宿主无治理的浏览；启动行与 `tm_stats` 会说清当前是哪种 |
| `TM_NATIVE_SNAPSHOT_MAX_TOKENS` | 1200——**仅 v2** | 原生 `browser_snapshot` / `browser_find` 在上下文里保留的预算。带 ref 的行优先占位，静态文字先被删；超过 `预算 × 4` 时回复会说明有多少 ref 行没装下，kept + dropped 恒等于总行数 |
| `TM_NATIVE_REPORT_MAX_TOKENS` | 1600——**仅 v2** | 报告形原生结果（带 Markdown 表格的那种：经 Code Mode 回来的 `tm_stats`、`tm_join` 汇总）在上下文里保留的预算。表格行和小标题优先占位，被删的是表格之间的散文——缺一行的表格就不是表格；全文仍在句柄里 |
| `TM_LEDGER_MAX_ITEMS` | 200 | 每个会话 `tm_ledger` 的条数上限。宿主的 `ctx.storage` 没有 TTL 也没有配额（实测），所以清单到顶就**拒绝新增**，而不是悄悄丢掉最早的条目——拒绝是领队能据此行动的信号，静默截断则是一条没人能复核的主张 |
| `TM_V2_PROBE` | —（仅 v2） | 表面探针的 JSONL 输出路径，记录宿主真实给出的工具 id、权限动作名、参数键名。只记名字与计数——绝不记命令行、路径、URL、环境变量值。它是"宿主到底有没有 X"这个问句的取证入口（问运行中的构建，而不是问文档）；不设这个变量时，同一批名字集合仍会进轨迹，`tm_stats` 照样能看 | |
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
| `TM_BOARD_MAX_CHARS` | `200000` | tm_board_write：单个黑板文件的字符上限——超了就拒写并提示拆 topic，而不是把交付物截断 |
| `TM_BOARD_MAX_FILES` | `200` | tm_board_write：一个会话目录允许的 markdown 文件数；回收只由 TTL 清扫负责，所以拒绝文案会点出 `ttlDays` |
| `TM_SEARCH_DEFAULT_ENGINE` | `auto` | tm_search 未显式给 `engine` 时的默认引擎（`auto` = 分类 + 并行扇出 + RRF 融合；也可钉表中任一引擎） |
| `TM_SEARCH_WEIGHTS` | 未设 | 按引擎覆盖融合权重，如 `bing=0.3,hn=0.25`；未列出的沿用内置表 |
| `TM_SEARCH_RELEVANCE_FLOOR` | `0.35` | 与查询词零重叠的命中只保留该比例的权重（压垃圾，不删引擎） |
| `TM_SEARCH_MAX_HITS` | `10` | 每引擎腿与融合列表保留的命中数 |
| `TM_SEARCH_DISABLED_ENGINES` | 未设 | 从引擎表与所有 `auto` 路由中移除的引擎（`sogou,baidu` 写法） |
| `TM_WEB_CACHE_TTL_SEC` | `300` | 受治理抓取在同一 URL 上可复用多久（0 = 关）。tm_webfetch / tm_search 共用一份缓存；条目以哈希命名（带令牌的查询串不落盘），且只在**静态白名单**放行的那一跳读写——弹窗授权仍是逐请求的，复用命中会标注 缓存命中 |
| `TM_BASH_TIMEOUT_PROBE_MS` | `60000` | 对只读探针命令（P3 白名单内）强制夹顶模型自设的 `timeout`（0 关闭） |
| `TM_PRUNE` | `on` | `off` 完全关闭上下文裁剪（已结算的消息正文留在请求里） |
| `TM_PRUNE_AT_PERCENT` | `70` | 请求达到模型窗口的这个比例就开始裁；从 `limit.context` 推导，不是写死的 token 数 |
| `TM_PRUNE_KEEP_TAIL_PERCENT` | `40` | 尾部逐字保留的窗口比例；最新一条永远保留 |
| `TM_BASH_TIMEOUT_MAX_MS` | `0` | 其它 bash 命令的可选全局上限——默认关闭，真实构建保留它要的超时 |
| `TM_JOIN_MAX_WAIT_MS` | `60000` | `tm_join { waitMs }` 的上限。过去是 300 000，于是有了一次"连续两次各等 5 分钟、期间 lead 什么都没做"的实测——等待不是并行，所以默认改成"看一眼就去干活"。上一次没等到任何结算时，第二次等待被截到 10 秒并附替代动作 |
| `TM_STORE_RECLAIM` | `on` | 启动时回收“升级留下的遗产”：超过 TTL 没动静的分片，以及临时目录回退点上分片之前的 `blackboard/` + `trajectory/`（一台真实机器上实测滞留 503 MB 过期 run，而搬家后没有任何清扫器指向那里）。只删超过 TTL 的条目——新鲜的 run 一定留着，因为升级前起来的会话可能还在往里写。设 `off` 就完全不碰磁盘（测试执行器会设它） |
| `TM_TASK_OFFLOAD` | `on` | 把宿主的后台子代理压在 token 预算内：`task { background: true }` 完成时宿主会把子代理全文注入你的会话，这里把超限的正文换成预览 + 取回指针（`tm_join { ids: [...] }`）。**只碰**同时满足三条的 part：`synthetic === true`、正文精确匹配宿主自己的 `<task id=… state="completed">` 信封、且超过文本卸载阈值；任一不满足就原样放过。不往磁盘复制任何东西——全文本来就写在子会话里。`off` 恢复宿主原样注入。**OpenCode 2.x 上这一半不适用**：v2 不会把注入后的消息在落盘前交给插件，而我们刻意不改写发出的消息（对那一层形状猜错就是静默删证据，v1 的 `experimental.chat.messages.transform` 就是因此一直没实现）。v2 的补偿是契约而不是改写：超限交付写进黑板文件、回复里带路径，领队读摘要、用 `tm_join` 取全文 |
| `TM_TOOL_HINTS` | `on` | 通过 `tool.definition` 把本插件的调用点纪律追加到内置 `bash` / `task` 的**描述**后面（只追加、幂等，绝不替换宿主原文） |
| `TM_AGENT_TEMPERATURE` | `off` | `on` 时按角色分档采样（architect 0.35 / researcher 0.3 / reviewer 0.1 / 其余 0.2）经 `chat.params` 生效；也可写 `reviewer=0.05;team=0.4`。默认关闭＝守住"所有 agent 0.2"这条既定原则 |
| `TM_COMPACTION_CONTEXT` | `on` | 在宿主压缩前追加"必须存活清单"（回复骨架、offload 句柄、未回收的子会话 id、出处、板上路径）。只做追加——宿主自己的压缩提示词不被替换 |
| `TM_COMPACTION_AUTOCONTINUE` | `on` | 设 `off` 则压缩后不让宿主静默续跑，先由人复核状态 |
| `TM_COMPACT_TRIGGER` | `on` | Team 自己的提前压缩：设 `off` 把时机整个交回宿主 |
| `TM_COMPACT_AT_PERCENT` | `75` | 用量达到模型窗口的百分之多少时，Team 用 `ctx.session.compact` 提交一次压缩（夹在 5–95）。用量数字来自宿主的 `session.usage.updated` 事件，分母来自 `ctx.model.list()` 的 `limit.context` |
| `TM_COMPACT_MIN_MS` | `60000` | 同一会话两次压缩准入之间的最小间隔（上限 600000），免得一个降不下去的比例变成压缩死循环 |
| `TM_SHELL_NO_COLOR` | `on` | 经 `shell.env` 给每个子 shell 注入 `NO_COLOR`/`TERM=dumb`（ANSI 进度条纯属上下文税）。绝不覆盖宿主已设的值 |
| `TM_SHELL_ENV` | — | 显式 `KEY=VALUE;KEY2=VALUE2` 透传进子 shell——刻意用白名单，避免这个钩子变成父环境泄露通道 |
| `TM_WEBFETCH_ALLOWED_DOMAINS` | `"*"` | tm_webfetch / tm_search 白名单（`"*"` 全开；空 = 全拒；自定义值**替换**种子——保留引擎主机）。`"*"` **不覆盖私网**：回环 / RFC1918 / CGNAT / `.localhost` 仍然每次都要弹确认窗；不可路由段（169.254.0.0/16 元数据端点、0.0.0.0/8、组播、保留段，以及这些地址的 IPv4-mapped 与 DNS64 写法）是不可被任何配置打开的硬红线 |
| `TM_MEMORY_GLOBAL_DIR` | `~/.opencode-team/memories/global/` | tm_memory GLOBAL 层存储 |
| `TM_MEMORY_SESSION_TTL_MIN` | `240` | session 层条目 TTL（惰性 + 启动清扫） |
| `TM_MEMORY_MAX_ENTRIES` | `200` | 每作用域条目上限；超限 add 故意失败——先跑 `compact` |
| `TM_MEMORY_STALE_DAYS` | `30` | 超过此天数的条目在搜索结果标 `[stale Nd]`（`0` 关闭） |
| `TM_MEMORY_SESSION_PERSIST` | —（瞬态） | `1` 时 session 条目同时落盘 `memories/sessions/<sid>/` |
| `TM_HIT_BLACKLIST` | `maimai.cn` | 永不进入搜索命中列表的额外域名（逗号/分号分隔；过滤同名不同站噪音） |

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

**黑板保留期** 用插件条目的 `options`：

```jsonc
{
  "plugins": [
    { "package": "@te-river/opencode-team-mode@latest", "options": { "ttlDays": 7 } }
  ]
}
```

有效区间 (0, 365]，非法值回退 5。2026-10-06 实测：这样写时 `ttlDays: 9` 的 boot 行读出
`board_ttl_days=9`。（1.x 的元组形状在 2.x 会被拒：`path=$.plugins.1 kind=invalid`。）

---

## ❓ FAQ

**会不会很烧 token？**
恰恰相反，省 token 就是设计目标。卸载 + 80 token 预览 + 宿主 Code Mode 的 `execute` 的存在
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
宿主无关。交互式浏览是宿主自己的 `browser_*` 目录，所以没有原生浏览器的
宿主（CLI / standalone）就没有浏览器可用——agent 如实报告这个缺口，绝不模拟。

**确认弹窗我不理会会怎样？**
`TM_ASK_TIMEOUT_MIN`（默认 1 分钟）后自动拒绝。插件从不自我批准——它
能站的队只有"你"或者"没人"。

---

## 🗑️ 卸载

1. 从配置文件的 `"plugins"` 数组里移除该条目；如果你是在 2.x 上装的，还要删掉生成的
   `~/.config/opencode/agents/*.md` 与 `commands/team-*.md`，以及你不再需要的
   `default_agent: "Team"`。
2. 想回收磁盘就删缓存目录（见[安装](#-现在读一遍以后省一小时)里的表格）。
3. 重启 OpenCode。agent、命令、工具全部消失；`<repo>/.git/opencode-team/`
   下的存储（全局记忆在 `~/.opencode-team/`）都是普通文件，随时可删。

没有 DLL 受伤。工作树什么都没写。

---

## 🏛️ 架构（给好奇的人）

```
opencode-team-mode/
├── src/
│   ├── index.ts          ← 插件入口（{id, setup}——仅 v2）
│   ├── agents.ts         ← Agent 结构（mode、颜色、温度、白名单矩阵）
│   ├── prompts/          ← Agent 提示词（lead / specialists / shared）——测试钉死
│   ├── commands.ts       ← 斜杠命令定义
│   ├── blackboard.ts     ← 共享黑板 + TTL 清扫
│   ├── envprotect.ts     ← R6 门面（patterns / 分类器 / 门禁谓词 / hook）
│   ├── identity.ts       ← Agent 名身份（大小写不敏感的 lead 判定）
│   ├── tm/               ← 受治理工具：pipelines / store / preview / guard / refs /
│   │                        webfetch / search / memory / browser / shell-bridge / board / ledger
│   ├── host/             ← v2 人格（setup / guard / offload / session / events / …）
│   └── types.ts          ← 加载器契约类型
├── docs/installation.md  ← 历史 1.18.x 指南（已不再支持）
├── docs/installation-v2.md ← 2.x 安装指南（角色以生成的配置文件形式落地）
├── scripts/              ← 一行安装脚本（bash / PowerShell）
├── pt07/                 ← PT-07 基线套件（种子化 A/B token 测量）
└── README.*.md           ← 你在这里（有两个版本）
```

加载器只调一次 `setup(ctx)`：注册 `tm_*` 工具、在 `permission.evaluate` 上装
R6/地址守卫、在 `tool.execute.after` 上挂 JIT 卸载、并发布黑板注记。用户自定义的
同名 agent 永远赢——插件从不覆盖。

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
- [安装指南（**OpenCode 2.x**）](./docs/installation-v2.md) — 受支持的装法：2.x 插件不能创建 agent，六个角色和六条命令要生成到配置目录
- [安装指南（1.18.x）](./docs/installation.md) — **仅历史**：1.18.x 人格已在 1.7.0 线里移除，本页只作参考，不是可用的安装路径
- [OpenCode Desktop](https://opencode.ai) — 官网与下载
- [OpenCode 文档](https://opencode.ai/docs) — 配置与插件文档
- [OpenCode 插件 API](https://opencode.ai/docs/plugins) — 开发你自己的插件
