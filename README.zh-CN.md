# OpenCode TeamMode

**[English](./README.md)** | **[中文](./README.zh-CN.md)**

[![npm version](https://img.shields.io/npm/v/@te-river/opencode-team-mode.svg)](https://www.npmjs.com/package/@te-river/opencode-team-mode)
[![npm downloads](https://img.shields.io/npm/dm/@te-river/opencode-team-mode.svg)](https://www.npmjs.com/package/@te-river/opencode-team-mode)
[![license](https://img.shields.io/npm/l/@te-river/opencode-team-mode.svg)](./LICENSE)

> 🤝 **你的 OpenCode 刚刚招了一个团队。**
>
> 六个专职 agent——主脑（Lead）、架构师、实现者、评审、测试、研究员——配上受治理的工具、结构化交接和"先出计划等你批准"的门禁。一个插件，没有文件要拷。

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

**[为什么](#-为什么是-teammode) · [团队阵容](#-团队阵容) · [安装](#-安装) · [使用](#-使用) · [工具与安全](#-受治理的工具与安全) · [配置](#️-配置) · [运作方式](#-团队怎么运作) · [故障排查](#-故障排查) · [卸载](#️-卸载)**

---

## 🤔 为什么是 TeamMode？

单个 agent 包打一切的下场你多半见过：上下文窗口塞满 5000 行的文件转储，
一个脚本能干的事跟 shell 磨二十个回合，子 agent 悄悄读你的 `.env`，以及
所谓的"联网调研"——其实全靠模型编。

TeamMode 对每一个的回应：

| 痛点 | TeamMode 的回答 |
|---|---|
| 🔥 **上下文爆炸** | 所有受治理结果超过内容分档边界（散文 4000 / 数据 2000 token，CJK 感知）就卸载到本地 run 存储，换成 80 token 的预览 + HMAC 句柄。agent 需要什么再分页取什么——窗口永远淹不了。 |
| 🐌 **回合开销** | 宿主自己的 `execute`（Code Mode）：agent 写**一个程序**，单回合内发起 N 次受治理调用。运行期间零 LLM 回合。 |
| 🕳️ **静默副作用** | R6 环境防护面：Team 角色用原生 `read` 读 `.env` 被**直接拒绝**——没有同意路径；读环境变量的 shell 命令走宿主自己的权限提示。插件从不代替你批准——它只会拒绝。 |
| 🌫️ **幻觉式调研** | 联网是双角色的授权 + 白名单受治理工具链。抓不到的事实就报告为缺口——绝不编造。 |
| 🧭 **纯文本墙** | 回复被引导成宿主渲染得最快的形状：逐文件 / 逐用例 / 逐条发现用 markdown 表格，diff 和配置用围栏代码块，浏览器截图只在你明确要求时才内联附上。宿主支持哪些语法是实测出来的、不是照着 CommonMark 猜的，提示词里带着这份实测的否定清单——脚注 `[^1]`、`==高亮==`、单独的 `---` 分隔线和 `$…$` 数学会以字面量形式出现在你面前，所以 agent 被明确告知不要用；而 `mermaid` 图是可以用的，因为这个宿主确实会画。 |
| 🎯 **目标漂移** | lead 开局必须用你自己的措辞写下 `GOAL:` 和可验证的 `ACCEPTANCE:` 判据，判据没有证据支撑这一轮就不算结束——合法的停止只有两种（卡在你这里，或有证据地证明做不到）。一轮收完但领队清单上还有未完成项时，`tm_join` 会直接说"目标未达成"并列出条目；目标本身随上下文压缩一起存活，摘要不能悄悄把它换掉。 |
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
| 🏗️ **Architect** | 系统设计 | 设计文档、模块结构、API 契约——**只在设计真的未知时才派** |
| 💻 **Implementer** | 写代码 | 做功能、写生产代码 |
| 🔍 **Reviewer** | 维度审计 | 默认单维度评审；高风险变更才三维度并行 |
| 🧪 **Tester** | 测试工程师 | 带真边界条件的测试；静态验证（构建 / 类型检查 / lint）；经宿主原生 `browser_*` 工具的治理化 UI 验证 |
| 🔎 **Researcher** | 找资料 | 本地仓库优先，然后才是网络——两个联网角色之一（另一个是 Lead） |

开箱即用时 **Team 就是你的默认 agent**——新会话直接进编排者（可在
[配置](#️-配置)里关掉）。

---

## 📦 安装

### 方式一：让 agent 替你装（推荐）

把下面这段粘给任意编码 agent——它会改你的配置、提醒你重启并验证：

```text
安装 OpenCode 插件 @te-river/opencode-team-mode：本包**只支持 OpenCode 2.x**——1.18.x 人格已在 1.7.0 线里整体移除。
2.x → https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/docs/installation-v2.md
（2.x 的插件不能创建 agent，六个角色和六条 `/team-*` 命令要靠那份指南里的生成步骤落到
配置目录——这一步不是可选的。）
（URL 拉不到时——大陆网络常见——用镜像前缀重试：https://ghproxy.net/ + 同样的路径。）
然后按该指南里的检查项验证。
```

（那份指南是完整的手动流程——配置文件位置、插件条目、重启、验证、更新与
卸载。你的 agent 读它并忠实执行；它不需要别的。）

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

把插件加进你的 `opencode.jsonc`：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "@te-river/opencode-team-mode@latest"
  ]
}
```

OpenCode 会在下次启动时自己安装这个插件。

> **键名是 `plugins`（复数）。** 2.x 宿主从不读单数的 `plugin` 键，它会在启动时
> 自己按条目安装这个包。跨配置文件的条目是**由低到高叠加而不是互相替换**，
> 所以只保留一条 Team 条目——同时写进 `opencode.json` 和 `opencode.jsonc`
> 会把插件加载两次。2.x 流程见
> [docs/installation-v2.md](./docs/installation-v2.md)（那里插件不能创建 agent，
> 六个角色和六条命令是生成的配置文件）；
> `docs/research/plugin-loader-contract.md` 里有宿主自己的加载器代码。

### ⚠️ 现在读一遍，以后省一小时

- **重启才生效。** 改完 OpenCode 配置后要完全退出并重启（桌面版：从托盘退出，而不是只关窗口）。
- **插件更新：重跑安装脚本。** 它是幂等的——重跑会重新改配置（已存在则不动）、
  清掉过期插件缓存、并重新解析任何 npm 安装的副本。之所以要这样做，是因为
  OpenCode 按 spec 字符串缓存插件，新版本发布后**不会**重新解析 `@latest`（上游限制）。
  手动配方（如果你更想自己来）：

  | 系统 | 清理命令——递归，覆盖**两种**缓存布局 |
  |---|---|
  | macOS / Linux | `find ~/.cache/opencode/packages -type d -name '*opencode-team-mode*' -prune -exec rm -rf {} +` |
  | Windows（PowerShell） | `foreach ($r in "$HOME\.cache\opencode\packages", "$env:LOCALAPPDATA\opencode\cache\packages") { if (Test-Path $r) { Get-ChildItem $r -Directory -Recurse -Filter '*opencode-team-mode*' -EA SilentlyContinue | Sort-Object { $_.FullName.Length } | Remove-Item -Recurse -Force -EA SilentlyContinue } }` |

  ⚠️ OpenCode 从 `~/.cache/opencode/packages/` 加载插件——可能还嵌在带 scope 的
  `@te-river/` 目录里——**不是**从 `~/.config/opencode/node_modules`，这就是删除
  必须递归的原因（只删顶层的 `rm -rf` 会静默漏掉那份带 scope 的副本）。

  ⚠️ **已发布的版本可能被你的 HOME 影子化。** 对包形式的 spec，宿主从 HOME 出发做
  最近一次 `node_modules` 查找来决定入口，所以一份带
  `@te-river/opencode-team-mode` 依赖的 `~/package.json` 会让宿主加载**那份**副本。
  诊断手段是 boot 探针的 `entrypoint=` 那一行，不是去猜缓存层。完整配方
  （含一个由 agent 驱动的更新提示）见[安装指南，Updating](./docs/installation-v2.md)。
- **前置条件：**[OpenCode](https://opencode.ai)（桌面版或 CLI）和 Node ≥ 18。

### 🖥️ 安装会在你机器上改什么

三处，全在本仓库之外——列出来是因为一个不吭声就改你环境的插件不值得信任。

| 改了什么 | 落在哪 | 存活多久 |
|---|---|---|
| OpenCode 配置里的一条插件条目 | `~/.config/opencode/opencode.jsonc`（缺失就创建；已存在的 `opencode.json` 会被**迁移进** `.jsonc`，原文件原样保留） | 直到你删掉那一行 |
| 被清理的插件缓存 | `~/.cache/opencode/packages/*opencode-team-mode*`（含真正在跑的那份嵌套 `node_modules` 副本） | 下次启动重新下载——它是缓存，没什么可还原的 |
| **一个用户级环境变量** | `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` | **Windows：`setx` 写进你的用户配置——它能熬过重启，而且对你之后启动的**每一个**程序都可见，不只是 OpenCode。** macOS `launchctl setenv` / Linux `systemctl --user set-environment`：仅本次登录会话（重启后要重跑安装脚本） |

第三项为什么在：宿主自己的 `task { background: true }` 是 OpenCode 界面唯一
**能给你看**的子代理——一张直接链到活动子会话的卡片，你还能停掉它。宿主通过
**它自己进程**上的一个开关来启用它，而插件没法去设置加载它那个进程的开关，
所以开关只能从环境来。没有它什么也不会坏：`task` 只是会阻塞领队，
它的卡片保持非后台。

撤销：

```powershell
# Windows —— 从用户配置里删掉
[Environment]::SetEnvironmentVariable("OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS", $null, "User")
```

```bash
launchctl unsetenv OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS          # macOS
systemctl --user unset-environment OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS   # Linux
```

或者安装时就跳过，那安装脚本只碰上面两个文件：

```powershell
.\install.ps1 -NoBackgroundSubagents                     # 或 $env:TEAMMODE_SKIP_BACKGROUND_SUBAGENTS="1"
```

```bash
TEAMMODE_SKIP_BACKGROUND_SUBAGENTS=1 bash install.sh
```

两种情况安装脚本都会打印它改了什么，并且**读回**那个值，而不是相信自己的
退出码。

### 验证

重启，打开 agent 选择器，找 **team、architect、implementer、reviewer、
tester、researcher**。齐了——团队上岗。

---

## 📖 使用

### 斜杠命令

| 命令 | Agent | 说明 |
|---|---|---|
| `/team-plan <任务>` | Architect | 带架构、文件清单、任务拆解的实施方案 |
| `/team-implement <任务>` | Implementer | 功能或任务的生产代码 |
| `/team-review [范围]` | Reviewer | 审计 bug、安全问题、质量问题 |
| `/team-test [范围]` | Tester | 带边界用例覆盖的完整测试 |
| `/team-research <主题>` | Researcher | 本地仓库优先；网络走受治理工具 |
| `/team-run <任务>` | Team Lead | **完整流程**——计划 → 批准 → 编排 → 验证 |

也可以直接 `@` 提及：`@team`、`@architect`、`@implementer`、
`@reviewer`、`@tester`、`@researcher`。

### 一次运行长什么样

开箱即用时 Team 就是默认 agent，所以你在新会话里直接打字：

> **你：** 给我们的 Express API 加上令牌桶限流——每用户每分钟 100 个请求，超了返回 429。别动 `src/legacy/` 下面任何东西。

```text
team   路由：产品行为变更 → implementer → tester → reviewer
       （3 次派工 → 审批门禁生效）

       计划
       目标：令牌桶限流，每用户每分 100，超限 429 + Retry-After
       范围：src/middleware/rateLimit.ts（新增），src/app.ts（+3 行）
       流水线：implementer → tester → reviewer（正确性）
       假设：内存桶，不是 Redis——要改说一声
       边界：src/legacy/** 不动
       批准后开工？

you    批准，开工

team   ▸ @implementer — STATUS: done
       CHANGES: src/middleware/rateLimit.ts（新增）· src/app.ts（+3）
       EVIDENCE: tsc 干净

       ▸ @tester — STATUS: done · VERDICT: pass (14/14)
       FINDINGS: 突发边界、窗口过期、并发补充均覆盖；
                 src/legacy/** 逐字节一致

       ▸ @reviewer — STATUS: done · VERDICT: approve（正确性）

team   完成。rateLimit.ts（新增）· app.ts（+3）· 14 个测试全绿
       评审：approve · 假设：仅内存 · src/legacy/ 未动
```

你只打了任务和四个字。计划是路由表查出来的，执行等你批准，agent 之间的每次
交接都走结构化骨架——你的仓库里什么都没落，什么都不是猜的。

---

## 🧰 受治理的工具与安全

TeamMode 加的每个工具都跑在**同一条治理管线**下：超过卸载阈值的输出永不
进入上下文窗口——阈值按内容分档：散文（text/log/markdown）走
`offloadThresholdText`（4000），结构化数据（json/csv/code/binary）走
`offloadThresholdData`（2000），内容类别未知时回退全局
`offloadThreshold`。超限输出卸载到 run 存储，换成内容感知预览 +
HMAC 句柄，agent 真需要 payload 时用 `tm_fetch` 分页取。

| 工具 | 功能 | 角色 |
|---|---|---|
| `tm_fetch` | 句柄分页：取回被卸载的结果（JSON 句柄支持 `fields` 点路径投影——刻意小的 jq 子集，如 `items[].name`） | 全部六个 agent |
| `tm_memory` | 会话 + 项目 + 全局三层记忆库（Markdown + frontmatter）：add / search / list / forget / compact | 全部六个 agent |
| `tm_board_write` | **黑板的写入侧**：只在 `<board-root>/<session-key>/<task-slug>/NN-<role>-<topic>[-rN].md` 放下一个**新**的 Markdown 文件，文件名由工具自己决定——修订是一个带 `-rN` 的新文件，绝不覆写；回复只给路径和字节数，绝不回传正文。它存在的理由是：落黑板原本需要一个文件工具，而 `architect` / `researcher` 一个都没有（没有 `write`、没有 `edit`、连用来给会话目录打时间戳的 `shell` 都没有），于是这两类角色的超长交付每次都以 `BLACKBOARD WRITE FAILED` + 整篇文档内联回来收场——本项目最看重的那个回复形态，恰恰在最需要的角色身上无法执行。范围是强制的：路径段做规整、目标用 realpath 对齐黑板根（符号链接的任务目录直接拒写）、文件名永远以 `.md` 结尾（所以造不出 `.env`/rc 文件）、正文受 `boardMaxChars` 与会话文件数上限约束 | 全部六个 agent |
| `tm_search` | 多引擎网络搜索，返回提取、去重、RRF 融合后的命中列表 | Lead + Researcher |
| `tm_webfetch` | 白名单页面的单次受治理 GET（搜索页自动提取）。重定向逐跳手动过检，被拒时会把**整条链**报出来（`跳转链: a → b（停在第 2 跳）`）——以前只会报最后一个主机，一个在白名单内的短链跳到站外时，读起来像"这个站点抓不到"，于是 agent 又回去重试它刚眼睁睁失败的入口 URL。429/503 若带 delta-seconds 的 `Retry-After` 会一并报出（HTTP-date 形式刻意不折算成倒计时），所以"待会儿再来"不会被当成"这里没东西"。读页面时还会优先要 Markdown（`Accept: text/markdown,…`）——实测 `learn.microsoft.com`：60 778 B 的 HTML 变成 11 449 B 的 Markdown，其余站点两种请求返回同一份文档，所以不支持的地方这个偏好是零成本的 | Lead + Researcher |
| `tm_ledger` | **领队的任务清单**（`add` / `doing` / `done` / `blocked` / `list`），存在宿主自己的 `ctx.storage` 里、按会话分开——OpenCode 2.x 不给插件 `todowrite`，LEDGER 规则从此有了落点。同一个要求重复提出只算一条；编号撞上两条会拒绝并把两条都列出来；`blocked` 带上卡住的原因；写不进存储就报失败，不会说成「已记录」 | 仅领队 |
| `tm_join` | **子代理回收**——插件侧的派发器已经没有了（`tm_dispatch` 被移除：插件创建的子会话，用户既打不开也停不掉）。派活统一走宿主自己的 `task` / `task { background: true }`，`tm_join` 是它的读端：不带参数=状态快照，`waitMs`=有界等待，`cancel:true` 取消跑飞的子任务，`tm_join { ids: ["ses_…"] }` 则把某个子代理的**整篇**回复经卸载管线取回（句柄 + ≤80 token 预览），而不是几千 token 直接压进上下文。插件重启后它还会从宿主会话树重建登记，遗留的子代理被"接管"而不是丢失。**2.x 上它还会登记宿主自己的 `subagent` 工具派出去的子会话**（凭据就是那句确认里的 `metadata.sessionID`），所以用户明明在屏幕上看着子代理跑、`tm_join` 却说"没有待收集的派发"这种事不会再发生；这类行同时说清自己的正文是从哪儿到的（宿主的注入消息），以及它是靠事件结算的还是靠推断结算的。**停掉一个也是真调用**：`cancel: true` 走宿主自己的 `ctx.session.interrupt`（`tm_join { ids: ["ses_…"], cancel: true }` 停指定的那一个，不带 `ids` 就停所有还在跑的）。宿主给这个端点写下的契约是"活动执行被中断返回 interrupted=true，空闲时是 no-op 返回 false"，所以回话刻意分成**五种裁决**：已由宿主中断 / 空闲未中断（它当时没在跑——是我们的登记行过时了，不是失败）/ 未确认（调用成功了但宿主没回布尔）/ 无中断缝 / 被宿主拒绝（带上宿主自己的原因），既在回复里计数，也写进轨迹（`stop_tried` / `stop_confirmed` / `stop_refused` / `stop_unknown`，可用 `tm_stats` 读回）。五个不同的事实不会被压成一句"已取消"；`resume` 也刻意从不发送，因为"中断后继续消化排队的引导输入"和"取消"正好相反 | 仅 Lead |
| `tm_stats` | **插件把自己的 trajectory 读回来**：卸载挡在上下文之外的 token（扣掉确实回来的预览）、派发重叠省下的秒数（串行代价减去子代理实际占用的墙钟）、治理计数（被拦子资源、shell 超时夹顶、缓存命中、脱敏次数）——外加**宿主能力矩阵**（每个宿主接口标 `已验证/存在未用/待观察/缺失/需人眼`）和**分层配置小节**（每个键的来源、某文件试图设置却被丢掉的「红线键」、未知键、被跳过的层、自动创建状态）。只读本插件自己写的文件；OpenCode 升级后第一个跑它。`{ recent: 20 }` 追加一份逐条调用清单——每次卸载结果的句柄和落盘路径都在里面，这就是"看看刚才那个工具到底返回了什么"的办法（宿主不给插件工具卡片留展开位） | 全角色 |

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
> `nativeSnapshotMaxTokens` 默认 1 200）而不是换成句柄。261 个 ref 的页面实测：
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
> （`taskOffload: "off"` 就恢复宿主的原样注入）。这条路的代价也说明白：每个后台
> 任务完成都会唤醒 lead 一次、花一轮。留在原地的读端是 `tm_join`：按 id 把某个
> 子代理的整篇回复经卸载管线取回、停掉跑飞的子任务、插件重启后从宿主会话树重建登记。
>
> 这里**刻意没有插件侧派发器**：早先的 `tm_dispatch` 创建的子会话，用户既打不开
> 也停不掉，这个代价比它换来的批量收益更大。移除它不影响任何功能——宿主的 `task`
> 一直是那条可见的路。

所有受治理工具都**支持并行**：宿主可以把一批 `tm_search` / `tm_webfetch` /
`tm_fetch` 调用并发执行——每次调用拿到自己的 step id 和自己的 payload，
互不串扰（并行测试套件钉死了这一点）。

### 上下文治理：卸载、句柄、预览

大的工具输出是上下文成本的主要来源——每一步都要重发整个窗口。所以超过
内容分档边界的（散文 → `offloadThresholdText`，结构化数据 →
`offloadThresholdData`，未知类别 → 全局 `offloadThreshold`）
结果写进本地 run 存储（`<repo>/.git/opencode-team/`，永不污染工作树），
换成带内容感知预览的句柄：JSON 键 / CSV 表头+形状 / 日志 ERROR×N 统计 /
代码签名 / 二进制元数据，硬顶 80 token（`previewMaxTokens`）。agent 真需要
payload 时用 `tm_fetch`（HMAC 签名、run 域、带过期）分页读；JSON 句柄还可以直接要
`fields` 点路径投影（刻意小的 jq 子集：`items[].name`、
`[].stargazers_count`），大 API 转储只留需要的字段、原文从不进窗口。

同一条管线也治理**宿主自己的工具**，而不只是我们的——超大的原生结果会在
`tool.execute.after` 上被改写成同样的预览 + 句柄形状。报告形结果是第三种
结局：缺了一行的表格就不是表格，所以带 Markdown 表格的结果是**按表格行截断**
（`nativeReportMaxTokens`），丢的是它们之间的散文。

### 会话 + 项目 + 全局三层记忆（tm_memory）

耐久的事实——构建命令、环境怪癖、架构决策、你的约定——以人可编辑的
Markdown + frontmatter 存放，共三层：

- **`session`**：仅本次会话的瞬时事实——进程内、按 TTL 清扫（`memorySessionTtlMin`，默认 240 分钟），对其他会话不可见；除非 `memorySessionPersist: "1"` 才落盘到 `memories/sessions/<sid>/`。
- **`project`**（默认）：`<repo>/.git/opencode-team/memories/…` —— 每 checkout 一份，贴近 git。存放本仓库的事实：构建命令、环境怪癖、架构决策。
- **`global`**：`~/.opencode-team/memories/global/`（可用 `memoryGlobalDir` 覆盖）——**跟着你走遍所有项目**。存放用户级约定：偏好的包管理器、提交风格、工具习惯。

动作：`add` / `search`（确定性关键词打分）/ `list` / `forget` / `compact`；
每条记忆上限 4000 字符。`search` 走全部三层，**会话 > 项目 > 全局**优先：
项目条目获得 +2 的近似同分加权，同名上层条目遮蔽下层（永不浮出）。
近重复从不堆积：`add` 命中同层同分类的既有条目（去重键，或
title+keywords 的 Jaccard ≥ 0.6）时**并入既有条目**——新内容胜出、
keywords 取并集、旧 slug 进 `supersedes:`、答复标注"已合并"（这是正常
现象，别再换个变体标题重复添加）。某层到达 `memoryMaxEntries`
（每作用域 200）时 add 故意失败：先跑 `compact`——默认 dry-run 只报合并
计划，带 `apply:true` 重跑才执行，执行前所有原件先复制进带时间戳的
`.compact-backup` 树（回滚路径）。超过 `memoryStaleDays`（30 天）的
条目在搜索结果里标 `[stale Nd]`。agent 被要求先搜记忆再做项目假设，
也把来之不易的事实存下来留给下个会话。

### 🌐 真正好用的网络搜索（中国可用）

`tm_search` 是开放式查询的前锋：**一次调用、一个 query、干净结果**。引擎
URL 替你拼好、走受治理管线抓取、压缩成编号的"标题+链接"命中列表——
agent 永远看不到原始搜索页的噪音。

| 引擎 | 说明 |
|---|---|
| `auto`（默认） | 给查询分类，**并行**扇出匹配的引擎（每条路由至少 2 条腿——两个引擎都认同的一条命中，比一个引擎对自己的看法更值钱），按 host+path 去重后做加权 RRF 融合，产出标有来源引擎的 top-10 列表。排序按命中与查询词的真实重叠度打折（地板 `searchRelevanceFloor`），高权重引擎的无关结果不再压过别的引擎最好的一条。路由：报错/camelCase API → `stackoverflow`+`github`+`bing`；开发生态（发布、框架、开源）→ `hn`+`github`+`npm`；中文 → `bing`+`moegirl`+`stackoverflow`+`hn`；其它 → `bing`+`stackoverflow`+`hn`+`github`。用 `searchDefaultEngine` 钉别的默认 |
| `bing` | cn.bing.com——唯一活着的中文 HTML SERP；多词 CJK 查询自动保护短语边界（加引号），markup 洗牌拆不散结果列表 |
| `bing-int` | 同一个主机加 `&ensearch=1` 出英文结果。它被刻意**排除在所有 `auto` 路由之外**——同一份索引的两种布局会让 bing 拿到双份票 |
| `stackoverflow` | api.stackexchange.com 问题搜索（免 Key，300 次/天/IP）→ 带复合摘要的编号问题列表；`auto` 跟踪配额，耗尽自动换 `bing` 顶上 |
| `hn` | Hacker News（Algolia API，免 Key）→ 帖子标题 + 摘要与原文链接 |
| `bilibili` | 视频搜索 |
| `moegirl` | MediaWiki 搜索 API——词条标题 + 摘要，结构化 |
| `npm` | registry 搜索 → name@version + 描述，结构化 |
| `github` | 仓库搜索 API → star 数 + 描述，结构化；`org:` / `user:` / `stars:` / `language:` 限定符透传折进查询（如 `vector db stars:>500 language:rust`） |

HTML 引擎在中国大陆**全部免 Key 可达**，且全部在种子域名白名单内。旧的
中文 HTML SERP（`sogou` / `so` / `baidu`）已被**移除**——
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
`hitBlacklist` 可扩展命中黑名单。

种子白名单（三个联网工具共用，22 个主机；baidu/moegirl/bilibili 用的是父域，
所有兄弟子域——baike.baidu.com、mzh.moegirl.org.cn、space.bilibili.com——
一并覆盖）：`baidu.com`、`bdimg.com`（百度自己的脚本与静态资源 CDN——它不是
baidu 的子域，页面自己的 bundle 被拦就是一张我们会报成"没有内容"的空白页）、
`moegirl.org.cn`、`bilibili.com`、`www.sogou.com`、
`www.so.com`、`cn.bing.com`、`www.bing.com`、`zhihu.com`、`juejin.cn`、
`csdn.net`、`cnblogs.com`、`gitee.com`、`github.com`、`api.github.com`、
`raw.githubusercontent.com`、`gist.githubusercontent.com`、`ghproxy.net`
（github raw 的大陆镜像）、`stackoverflow.com`、`npmjs.org`、`pypi.org`、
`learn.microsoft.com`——在默认种子生效时再加上两个 JSON 搜索引擎的主机
（`api.stackexchange.com`、`hn.algolia.com`），所以实际 24 个。用
`webfetchAllowedDomains` 扩展（`"*"` 放开全部主机；自定义列表是
**替换**种子，保留引擎主机否则 `tm_search` 没了目标）。architect /
implementer / reviewer **没有**联网授权——网络问题会报告为缺口，绝不编造。
tester 仅持有宿主原生 `browser_*` 工具，用于本项目的治理化 UI 验证（本地开发服务器、
预览路由）；开放网络抓取仍归两个联网角色。

**白名单外是门，不是墙。** 当抓取 / 搜索 / 浏览器打开的目标主机不在白名单
内时，受治理调用会**带出口信息拒绝并失败**——2.x 上插件弹不出宿主的对话框，
所以根本没有窗可等，而没有门的门不是门。你的出口是 `team-mode.jsonc` 里的
`privateSpace: "allow"`，或者把那个主机名写进 `webfetchAllowedDomains`。
门下面还有任何配置都打不开的类别：云元数据 / 链路本地 / 组播 / 保留 / 基准测试
网段一律直接拒绝、没有同意路径，且 IPv4-mapped 与 DNS64 的同义写法同样算
（换个写法不能绕过），env 文件 URL 和非 http(s) 协议保持硬拦截。

### 安全：R6 环境防护 + R2 危险操作

**R6 默认开启，而且默认是 `strict`。** `envProtect` 接受
`strict` / `standard` / `off`，默认落在 `strict`。TeamMode 激活时：

- **env 文件读取是硬 `deny`** —— Team 角色用原生 `read` / `edit` / `glob` /
  `grep` 读 `.env` 会被拒绝，没有同意路径。宿主的 `grep` 上报的权限资源是
  *模式*而不是路径，所以同一条规则也跑在完整工具输入上（`grep SECRET .env`
  钻不过去）。模板文件（`*.env.example` / `.sample` / `.template` / `.dist`）
  仍然可读。
- **shell 命令里的环境变量读取走宿主自己的权限提示**（`ask`）。按命令分类器
  逐条判定，所以普通的 `git status` 什么也不问，而一次环境变量转储照问；
  通配符表达不了的 env 读取（命令内嵌 `$VAR` / `${VAR}` / `$env:`、命令替换）
  **从不**走弹窗——它们是被拒绝的。审计日志只记录工具名 + 模式类别 + 裁决——
  绝不记录命令文本、路径、变量名或值。

**R2 危险操作（同一个面）。** 删除、git 发布、网络抓取、包安装/发布、
进程/系统、提权——统统不允许静默放行。日常验证栈（`npm test`、`tsc`、
`git status`）**不在**门禁内，日常开发不受打扰。

**插件从不自我放行。** 它注册的每个钩子只能把规则改得**更严**；权限问题上
它只回 `deny` 或不动手，绝不回 `allow`。

> ⚠️ **批准宿主自己的弹窗时选"一次"，别选"总是"。** 在真实宿主上验证过，"总是"记录
> 的规则远比你看到的那条命令宽：用"总是"批准 `Get-ChildItem env:PATH`
> 会存下 `Get-ChildItem *`，之后所有 `Get-ChildItem` 都不再弹窗。联网通道有同一个
> 坑，而且更容易踩：对某个域名点一次"总是"，**该项目下所有 agent 会话**就都能打开
> 它。现在回复会写明这次是哪条路放行的（静态白名单 / 你刚答过的确认窗 / 毫秒内替你
> 答完的已存规则）——分不清这三者的 agent，会把"没弹窗"报告成"这个站是被允许的"。

> 改道是按会话的：env 那一面只在运行 TeamMode 生成的角色的会话里生效。
> 任何其它会话里，插件把宿主的行为原样留下不动。

### 仓库卫生

卸载/轨迹/记忆存储都在 `<repo>/.git/opencode-team/`（非 git 目录则进系统临时
目录，并按工作区路径哈希分片成 `opencode-team/w-<hash>/`，一个项目读不到另一个
项目的产物）——**永不进工作树**。每个 agent 被要求完工前删掉自己的临时文件，
一次性产物进系统临时目录。TTL 清扫器在启动时 + 每小时回收过期任务目录；
Team Lead 自己从不删黑板，你可以随时审计任何一次运行。

---

## ⚙️ 配置

**配置就是 JSON，而且只有 JSON。** `team-mode.jsonc` 是唯一的配置来源。
没有环境层，**任何 `TM_*` 配置环境变量都已经不存在**——你在老配置里还能
看到的那些只是未知键，启动时会报出来，永远不会被应用。
（另有三个 `TM_*` 名字作为内部/测试开关存活，见本节末尾。）

### 配置文件在哪

| 层 | 路径 | 优先级 |
|---|---|---|
| **全局** | `~/.config/opencode/team-mode.jsonc`（认宿主的 `OPENCODE_CONFIG_DIR`） | 最低——对所有项目生效 |
| **项目** | `<目录>/team-mode.jsonc`，从工作区**一路向上直到文件系统根**逐级找 | 更高——直系文件由远及近合并 |
| **项目** | `<目录>/.opencode/team-mode.jsonc`，同样的向上查找 | **最高**——每个 `.opencode/` 文件都覆盖每个直系文件 |

这套查找与优先级就是宿主自己的配置分层规则，照抄而不是发明。JSONC 受支持：
`//` 和 `/* */` 注释按字节偏移打掩码，所以被注释掉的键不会被读成生效的键。
解析失败的一层被**整体**跳过（半份配置比没有更糟），而单个坏键只丢自己；
未知键会告警且永不应用。`tm_stats` 会把结果渲染出来：每个键的来源、跳过的层、
未知键和自动创建状态。

### 它会自己写一份

全局文件**不存在**时，插件在启动时创建它——原子、幂等，且**绝不覆盖已存在的
文件**。写进去的是一份**惰性**模板：全部 **59** 个注册表键，每个都以*注释*
形式出现在一行说明下面，所以这个文件解析出来是 `{}`，在你取消注释之前什么
都不设置。

```jsonc
// 全局配置。取消注释即可生效；默认全部注释 = 什么都不设置。
{
  // "offloadThreshold": 2000,            // 卸载阈值（估算 token；等于阈值也卸载）。
  // "envProtect": "strict",              // R6 环境防护模式（strict/standard/off）。（红线：仅全局）
  // …共 59 个键，每个都带一行说明
}
```

关掉它：插件选项 `autoCreate: false`，或内部开关 `TM_CONFIG_AUTOCREATE=off`。

### 红线键

有五个键**只在全局文件里被认**：`envProtect`、`r6FineAsk`、
`privateSpace`、`webfetchAllowedDomains`、`bashReadonlyAllowed`。项目文件
可以写它们，但那个值**被忽略并被报出来**——一份会被提交的项目配置不该能
给所有克隆这份仓库的人关掉某个守卫。这条规则由注册表本身推导（规格上的
`redLine: true`），所以新加的红线键天然就是红线。

### 插件选项

选项在插件条目上，不在 `team-mode.jsonc` 里：

```jsonc
{
  "plugins": [
    { "package": "@te-river/opencode-team-mode@latest",
      "options": { "defaultAgent": true, "autoCreate": true, "ttlDays": 7, "envProtect": true } }
  ]
}
```

| 选项 | 默认 | 含义 |
|---|---|---|
| `defaultAgent` | `true` | 把 Team 提为默认 agent 位。用 `false` 退出。 |
| `autoCreate` | `true` | 全局 `team-mode.jsonc` 缺失时在启动时写入那份惰性模板。 |
| `ttlDays`（别名 `blackboardTtlDays`） | `5` | 黑板保留期，有效区间 (0, 365]。 |
| `envProtect` | `true` | 插件级总开关；`false` 会把 R6 模式解析成 `off`。 |
| `temperature` | `false` | `false` = 保持文档承诺的 0.2；给一个数字则覆盖它。 |

2.x 上插件条目要么是**字符串**，要么是带 `package` 和 `options` 的**对象**。
1.x 的元组形式 `["@te-river/…", { … }]` 会被拒
（`path=$.plugins.1 kind=invalid`，2026-10-06 实测）。选项确实会到达——用对象
形式时 boot 行对 `{ "ttlDays": 9 }` 读出 `board_ttl_days=9`，所以这是实测，
不是"文档写了但希望它能用"。

### 模型选择

每一个判断——分诊、拆解、派工简报、综合、评审裁决——都流经 Team Lead。
那个位置上放一个弱模型，会把整条流水线拖垮，不管专家们多强。把你的最强
推理模型钉给 `team`：

```jsonc
{
  "agent": {
    "team": { "model": "anthropic/claude-opus-4-5" },      // 领队配你最好的模型
    "implementer": { "model": "anthropic/claude-sonnet-4-6" } // 专家可以便宜一点
  }
}
```

你自己叫 `team` / `architect` / … 的 agent 永远优先——插件从不覆盖用户定义。
覆盖、加自己的 agent、停用角色见[自定义](#-自定义)。

### 键参考（共 59 个）

**卸载、预览与存储**

| 键 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `offloadThreshold` | number | `2000` | 全局卸载边界（估算 token，CJK 感知），内容类别未知时使用。等于阈值也卸载。 |
| `offloadThresholdText` | number | `4000` | 散文（text / log / markdown）的边界。不设则继承全局值。 |
| `offloadThresholdData` | number | `2000` | 结构化载荷（json / csv / code / binary）的边界。同样继承。 |
| `previewLines` | number | `20` | 预览构建器最多扫描的原始行数。 |
| `previewMaxTokens` | number | `80` | 预览的硬上限。 |
| `fetchMaxLines` | number | `2000` | `tm_fetch` 单段返回的行数上限。 |
| `blackboardDir` | string | 自动 | run 载荷存储目录。空 = `<repo>/.git/opencode-team/blackboard`。显式值 = 绝对路径或相对项目根。 |
| `trajectoryDir` | string | 自动 | 轨迹存储目录。空 = `<repo>/.git/opencode-team/trajectory`。 |
| `blackboardTtlDays` | number | `7` | 句柄 TTL，也是过期运行目录的物理清扫周期。 |
| `storeReclaim` | `on`/`off` | `on` | 启动时回收升级遗留的东西：空闲超过 TTL 的工作区分片，以及临时目录回退下的前代 `blackboard/` + `trajectory/`。**只删 TTL 已过的条目**——新鲜运行目录会活下来，因为升级前开的会话可能还在往里写。`off` 让磁盘保持原样。 |
| `taskOffload` | `on`/`off` | `on` | 把宿主的后台子代理压进上下文预算：它完成时注入进来的整篇回复被换成"预览 + `tm_join` 指针"。只动那些带宿主的 `<task id=… state="completed">` / `<subagent … state="completed">` 信封且超过文本阈值的合成 part——即使一条真人消息完美地含有那个信封也绝不被碰，`state="error"` 的子代理也绝不改写。**不往磁盘另存副本**：正文本来就在子会话里。`off` 恢复宿主的原样注入。 |
| `boardMaxChars` | number | `200000` | `tm_board_write` 单个文件的字符上限——超过就**拒绝**（并提示"拆成两个主题"），而不是把交付截断。 |
| `boardMaxFiles` | number | `200` | 每个会话目录允许的 Markdown 文件数。TTL 清扫器是唯一的回收路径，所以拒绝时会点名它。 |
| `joinMaxWaitMs` | number | `60000` | `tm_join { waitMs }` 的上限。曾经是 300 000，而有次会话的领队连着两次停在里面（19 分钟什么都不干），子代理却在干活——等待不是并行，所以默认值现在说的是"看一眼，然后干活"。第二次连续等待若仍未结算任何东西，会被砍到 10 秒，并答复接下来该做什么。 |
| `ledgerMaxItems` | number | `200` | 每会话 `tm_ledger` 条目上限。宿主的 `ctx.storage` 没有 TTL 也没有配额（实测），所以这份清单宁可涨不上去，也不悄悄丢掉最早的条目——拒绝是领队能据以行动的东西，静默截断则是一个没人能复核的说法。 |

**记忆**

| 键 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `memoryGlobalDir` | string | 自动 | GLOBAL 层存储。空 = `~/.opencode-team/memories/global`。 |
| `memorySessionTtlMin` | number | `240` | 会话层条目 TTL（惰性 + 启动清扫）。 |
| `memoryMaxEntries` | number | `200` | 每作用域条目上限；超限时 `add` 故意失败——先跑 `compact`。 |
| `memoryStaleDays` | number | `30` | 超过该年龄的搜索命中标 `[stale Nd]`（`0` 关闭）。 |
| `memorySessionPersist` | string | `""` | `""` = 仅进程内；`"1"` 还会把会话条目写到 `memories/sessions/<sid>/`。 |

**网络与搜索**

| 键 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `webfetchAllowedDomains` | string[] | 22 主机种子 | **红线。** 出网白名单（`"*"` = 任意主机；`[]` = 全拒）。自定义列表**替换**种子——记得保留引擎主机。`"*"` **不覆盖**私网：回环 / RFC1918 / CGNAT / `.localhost` 仍然需要 `privateSpace: "allow"`，而不可路由网段（169.254.0.0/16 元数据、0.0.0.0/8、组播、保留，以及同一目标的 IPv4-mapped 和 DNS64 写法）是任何设置都打不开的硬红线。 |
| `searchDefaultEngine` | string | `auto` | 没给 `engine` 参数时的引擎（`auto` = 分类 + 并行扇出 + RRF 融合；表里任何引擎名也能钉成手选默认）。 |
| `searchMaxHits` | number | `10` | 每条引擎腿与最终融合列表保留的命中数。 |
| `searchWeights` | record | `{}` | 按引擎覆盖融合权重，如 `{"bing": 0.3}`；未列出的沿用内置表。 |
| `searchDisabledEngines` | string[] | `[]` | 从引擎名册与所有 `auto` 路由中移除的引擎名。 |
| `searchRelevanceFloor` | number | `0.35` | 命中与查询词零重叠时保留的权重系数（降权保留，不删除引擎）。 |
| `hitBlacklist` | string[] | `[maimai.cn]` | 额外永不列为搜索命中的域名（同名不同站的噪音如 脉脉）。与内置项合并。 |
| `webCacheTtlSec` | number | `300` | 受治理抓取可重发同一 URL 的时长（`0` = 关闭）。`tm_webfetch` / `tm_search` 共用一个存储；条目用哈希命名（带 token 的查询串永不落盘），且只对**静态**白名单放行的跳读写写——所以缓存命中既不能让被移除的主机复活，也不能替代同意。一份重发的页面会说 缓存命中。 |

**回合、派工与上下文**

| 键 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `maxConcurrentSubagents` | number | `3` | 并发 `subagent` 调用的硬上限（`0` 关闭）。实测 `permission.evaluate` 对这个动作真的会触发，所以这是道闸而不是建议。 |
| `prune` | `on`/`off` | `on` | 上下文裁剪：把**已结算**的消息正文替换成一个自解释的指针（卸载句柄、子代理 id、说明）。证据绝不被销毁——回复骨架、GOAL/ACCEPTANCE、来源说明、系统消息、仍在跑的子代理、尚未收集的子代理 id 全部完整保留，被动的消息逐字节不变。`off` 关闭。 |
| `pruneAtPercent` | number | `70` | 请求达到模型窗口的这份占比时开始裁剪，由 `limit.context` 推导——绝不是写死的 token 数。**夹在 40–90。** |
| `pruneKeepTailPercent` | number | `40` | 尾部逐字保留的窗口占比；最新一条消息永远保留。 |
| `splitAdvice` | `on`/`off` | `on` | 派工简报的验收标准过多时注入拆分建议。`off` 停掉这条提示（提示词纪律仍在）。 |
| `splitBriefTokens` | number | `4000` | 触发拆分建议的简报 token 阈值。**夹在 ≥200。** |
| `splitMaxCriteria` | number | `3` | 验收标准多于这个数就是该拆的信号。 |
| `retry` | `on`/`off` | `on` | 错峰重试治理：只按**名字和文本**把错误分类（配额 / 限流 / 瞬时 / 未知），算出带抖动的退避，并注入**一条**写明确切等待秒数的指令。连续 `retryBreakAfter` 次错误后，冷却期拒绝新的 `subagent` 派发。老实的边界：没有哪个缝能拦截模型自己的重试——它识别、说出该等多久、并拒绝新工作；它不会替模型去等。 |
| `retryBaseMs` | number | `5000` | 首次退避；每连续一次错误翻倍。 |
| `retryMaxMs` | number | `60000` | 该退避的上限。 |
| `retryJitter` | number | `0.3` | 施加在等待上的 ± 比例，让并行会话不同时重燃。 |
| `retryBreakAfter` | number | `5` | 触发断路器前的连续错误次数。 |
| `retryCooldownMs` | number | `60000` | 断路器跳闸后拒绝新派发的时长。 |

**宿主表面治理（2.x）**

| 键 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `nativeOffload` | `on`/`off` | `on` | 用同一条管线治理宿主自己的 `read`/`grep`/`glob`/`shell` 结果。`off` 恢复宿主行为；boot 行会区分"是你关的"和"这台宿主没有 execute.after"。 |
| `nativeSnapshotMaxTokens` | number | `1200` | 原生 `browser_snapshot` 在上下文里保留的预算。寻址行比静态文字优先拿到预算；超过 `预算 × 4` 时回复会说明有多少 ref 行没放得下，且"保留 + 丢弃"永远等于总数。 |
| `nativeReportMaxTokens` | number | `1600` | 报告形原生结果（任何带 Markdown 表格的东西）保留的预算。表格行和它的标题赢下空间；完整正文仍随句柄可取。 |
| `probeChain` | `on`/`off` | `on` | 连续走原生 `read`/`grep`/`glob`/`shell` 之后，追加**一行**点名 `execute`（Code Mode）以及它省下什么。是一条提示、不是一道闸：原正文逐字保留，不拒绝任何东西，且追加按标记幂等（宿主会重放钩子）。 |
| `probeChainAfter` | number | `3` | 连续多少次原生调用后开始提示（`0` = 关闭）。 |
| `v2BrowserGate` | `on`/`off` | `on` | 宿主 `browser_*` 目录上的门禁（在 `execute.before` 上判 URL 与预览路径，以及写在 `execute` 程序里的浏览器 URL）。`off` 恢复无治理浏览；boot 行和 `tm_stats` 会说明当前跑的是哪个世界。 |
| `v2CodeMode` | string | `""` | `direct` 会发送 `options.codemode=false`；空 = 目录模式。我们过去默认发 `direct` 并宣称直接交付——**一次 2.0.16 桌面会话把它证伪了**：带着这个开关，每个 `tm_*` 仍然落在宿主的 Code Mode 目录里，所以现在默认什么都不发。可观测的事实是 `tm_stats` 里的 `tools_in_request`（请求内实际可见=…），而不是我们发了什么开关。 |
| `bashTimeoutProbeMs` | number | `60000` | 施加在模型为只读探针命令设的 `timeout` 上的上限。它**只**作用于只读白名单已经接受的命令，且绝不发明模型没写的超时（`0` 关闭）。 |
| `bashTimeoutMaxMs` | number | `0` | 其余 shell 命令的可选全局上限。`0` = 关闭，所以真实构建保留它要的超时。 |
| `envProtect` | `strict`/`standard`/`off` | `strict` | **红线。** R6 模式。`off` 同时解除 shell 升级为 ask。任何无法识别的值都解析成 `strict`。 |
| `r6FineAsk` | string | 分类器 | **红线。** `off` 回退到对**每一条** shell 命令都问——而这在没有暴露按动作评估钩子的宿主上也会自动发生，boot 注记会说明是这两种中的哪一种。 |
| `privateSpace` | `allow`/`deny`/`ask` | `deny` | **红线。** 私网（回环、RFC1918、ULA、CGNAT、`.localhost`）经由我们的工具。默认 `deny`，因为 2.x 插件弹不出对话框——让 agent 去等一个永远不会开的窗，不是一道有流程的门，所以 `ask` 其实是"这个问不了"的诚实写法，无法识别的值也回退到它。绝不与 FORBIDDEN 网段混为一谈。 |
| `bashReadonlyAllowed` | string[] | 内置 | **红线。** P3 只读命令白名单。`tasklist` / `ps` / `findstr` 是种进去的，因为 `已确认关闭` 只有在 agent 能向操作系统问 pid 时才可核查——一个没有读取路径的用户可见验证，和一句谎话是同一个缺陷。 |

**遗留键** —— 保留列出且可解析，好让老配置仍能加载，但
**没有 v2 读取者**，并如实上报：

| 键 | 默认 | 状态 |
|---|---|---|
| `askTimeoutFloorMin` | `1` | **已孤儿。** 它唯一的消费者是 v1 审批门，而那扇门已被删除（2.x 插件弹不出对话框，根本没有可超时的对象）。如实说出来，而不是留一个什么都不干的旋钮。 |
| `agentTemperature` | `""` | 仅 v1 |
| `compactionContext` | `on` | 仅 v1 |
| `shellEnv` | `""` | 仅 v1 |
| `ptcWebBridge` | `on` | 仅 v1 |

> **压缩时机归宿主，不归本插件。** 早先某个版本在窗口 75% 时自己触发摘要；
> 那已按用户决定移除——一个自己给活跃对话做摘要的插件，是在执行一个你没要求的
> 丢上下文动作。留下的是纯增量的部分，且只在**宿主**压缩时运行：必须存活的
> 清单（回复骨架、卸载句柄、未结算的子代理会话 id、来源说明、黑板路径）搭宿主
> 自己的 `session.hook("compaction")`，而宿主自己的摘要提示词永不被替换。

### 存活下来的三个 `TM_*` 名字

它们是**内部 / 测试开关**，不是配置——之所以从环境读，是因为测试或诊断需要
在不配文件的情况下拿到它们：

| 名字 | 作用 |
|---|---|
| `TM_STORE_RECLAIM` | 覆盖 `storeReclaim` 键（`off` = 磁盘保持原样）。测试跑批器会设它，因为套件会在临时目录里真的起运行时。 |
| `TM_V2_PROBE` | 一个 JSONL 文件路径，表面探针把宿主真实的工具 id、权限动作名和参数键**名**记进去。只有名字和计数——绝不记命令行、路径、URL 或环境值。它就是让"这台宿主到底有没有 X？"能从跑起来的构建回答、而不是从文档回答的东西。 |
| `TM_CONFIG_AUTOCREATE` | `off` 抑制全局惰性模板的自动创建。 |

环境里任何**其它** `TM_*` 名字都是惰性的。如果你以前在设某一个，把它搬进
`team-mode.jsonc` 里上面对应的键。

---

## 🏗️ 团队怎么运作

子 agent 之间不能实时互发消息（平台限制），所以 TeamMode 用**结构化回复
骨架**协调——每个专家的回复都是 `STATUS: / CHANGES: / FINDINGS: / EVIDENCE:
/ HANDOFF:`，≤50 行，Lead 原文转投给下一次派工。文件是例外不是常规：超过
约 50 行的交付物写**一个**指名的黑板文件，放在 `<repo>/.git/opencode-team/`
下（round 后缀，工作树分毫不动）。

- **路由表：** 提问 → 直接回答；纯文档 → implementer；产品行为变更 →
  implementer → tester → reviewer；多模块 → architect → implementer →
  tester → reviewer(s)；陌生技术 → researcher 先行。固定下限——产品变更
  路由低于 3 次派工就是路由 bug。
- **一次派工，一个可独立验证的交付。** 派工是**可验证工作**的单位，不是
  "所有相关东西"的筐。领队说不出一份子代理的结果要如何**单独**被验证，
  它就还不是一次派工——它是一个愿望。把一个交付切成只有合起来才有意义的
  碎块是剁不是切，它花掉的用户轮次比省下的多。
- **架构师是条件性的。** 只在设计真的未知时才派。根因已经定位（有 file:line
  证据）时跳过它，直接把精确修复规格交给 implementer；修复会动契约、或策略
  还没定，才保留架构师。仪式服务于未知，不服务于多文件 diff。
- **tester 和 reviewer 可以在同一轮跑**——验证与评审彼此独立。只有当某个
  修复同时让两者失效时才串行化。同样还有多个 implementer（各自带精确的文件
  所有权与逐字数据契约）、以及分包到不相交包的 tester。
- **审批门禁（计数式）：** ≥2 次派工 → 计划（≤30 行）→ **等你批准** → 执行。
  阻塞性问题立刻批量问，不猜、不挤牙膏。把一个要求拆成若干不足 2 次派工的小块
  来躲门禁，是协议违规，不是钻空子。
- **只有 Team Lead 能派工。** 专家角色已收回宿主的 `task`/`subagent` 能力，
  所以子代理不再生子代理。
- **自适应评审：** 默认一名评审；高风险画像（鉴权/安全面、跨模块契约、
  公共 API）才三维度并行。
- **静态验证：** 构建 / 类型检查 / lint / 测试。禁止临时起意的浏览器自动化；
  未验证的 UI 工作以 `UI NOT VERIFIED: <待人工检查项>` 收尾。
- **证据标准：** "完成 / 修好 / 通过"必须带可验证证据——输出、日志、diff。
- **用你的语言，不是工具的语言。** 受治理工具回复的是中文；回复语言规则
  让散文保持你的语言，只在"它本身就是证据"时逐字引用中文字符串。

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

黑板保留期、自动创建、默认 agent 位和 R6 总开关都是插件条目上的 `options`
——见[配置](#️-配置)。

---

## ❓ 故障排查

**会不会很烧 token？**
恰恰相反，省 token 就是设计目标。卸载 + 80 token 预览 + 宿主 Code Mode 的 `execute` 的存在
理由就是：五 agent 流水线要是裸接一个上下文窗口，那才叫烧 token。治理本身
就是省 token 的机制。

**联网安全吗？**
这是全插件防守最严的面：两个完整联网角色 + 仅浏览器的 tester 授权、域名
白名单（白名单外的调用带出口信息失败关闭）、重定向逐跳复检并报出整条链、
env 文件 URL 拒绝、任何设置都打不开的地址红线，且每个 payload 都走同一套
卸载治理。白名单页面不可能把抓取弹到站外。

**插件为什么不自动更新？**
OpenCode 按 spec 字符串缓存插件，从不重新解析 `@latest`（上游问题，不是
我们的）。**重跑安装脚本就是更新**（它会清缓存、重解析 npm 副本）；或者
手动删缓存目录。如果 boot 探针的 `entrypoint=` 一行指向
`~/.cache/opencode/npm` 或 `~/.config/opencode/node_modules` 之外的路径，
那就是一份 `~/package.json` 在钉另一份副本——这才是诊断手段，不是猜。
配方在上面和 [docs/installation-v2.md](./docs/installation-v2.md) 里。

**我在环境变量里设的某个开关没反应。**
配置现在走 JSON 了。除了那三个内部开关，任何 `TM_*` 变量都是惰性的；把值
搬进 `team-mode.jsonc` 里对应的注册表键。跑一次 `tm_stats` 读分层配置小节：
它会点名每个键的来源，所以你以为被认了的那个值，来源栏会显示不是你改的那个
文件。

**我在项目文件里设的红线键被忽略了。**
这是设计。五个红线键**只在全局文件**里被认，`tm_stats` 会按名字报出那次
被忽略的尝试，而不是静默丢掉。

**`AGENT NOT FOUND: "Team"`。**
文件名就是 agent id，而 Windows / APFS 在一次写入经由另一个文件打开时会
**保留**既有拼写——于是 1.7.2 之前的 `team.md` 每次安装都活下来，宿主把
领队注册成小写。用 `--agent team`。安装器的回收步骤会把一个它已证明是同一
个文件的大小写条目改名；手动安装可能需要自己改一次。

**agent 能并行调工具吗？**
能——而且是为并行**专门设计**的：并行的 `tm_search` / `tm_webfetch` /
`tm_fetch` 拿到互不相同的 step id 和互相隔离的 payload。这里出回归，测试
套件会在它到你面前之前先红。

**CLI（TUI）能用吗，还是只有桌面版？**
都能。桌面版多了彩色 agent 选择器和并行面板；受治理工具和整个工作流与
宿主无关。交互式浏览是宿主自己的 `browser_*` 目录，所以没有原生浏览器的
宿主（CLI / standalone）就没有浏览器可用——agent 如实报告这个缺口，绝不模拟。

**宿主权限提示我不理会会怎样？**
那是宿主定的，不是本插件。插件只能拒绝：它从不自我放行，它装的每个守卫
只能把规则改得更严。它不认作自己角色的会话，会被原样留给宿主的行为。

---

## 🗑️ 卸载

1. 从配置文件的 `"plugins"` 数组里移除该条目；如果你是在 2.x 上装的，还要删掉生成的
   `~/.config/opencode/agents/*.md` 与 `commands/team-*.md`，以及你不再需要的
   `default_agent: "team"`。
2. 想回收磁盘就删缓存目录（见[安装](#-现在读一遍以后省一小时)里的表格）。
3. 重启 OpenCode。agent、命令、工具全部消失；`<repo>/.git/opencode-team/`
   下的存储（全局记忆在 `~/.opencode-team/`）都是普通文件，随时可删。全局的
   `team-mode.jsonc` 留不留随你——你删掉的话，插件下次会重新写一份惰性模板。

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
│   │                        config-layers（59 键注册表）/ config-files（那两层）/
│   │                        config-template（自动创建的那份惰性文件）/
│   │                        webfetch / search / memory / board / ledger / dispatch
│   ├── host/             ← v2 人格（setup / guard / offload / session / events / …）
│   └── types.ts          ← 加载器契约类型
├── docs/installation.md  ← 历史 1.18.x 指南（已不再支持）
├── docs/installation-v2.md ← 2.x 安装指南（角色以生成的配置文件形式落地）
├── scripts/              ← 一行安装脚本（bash / PowerShell）
├── pt07/                 ← PT-07 基线套件（种子化 A/B token 测量）
└── README.*.md           ← 你在这里（有两个版本）
```

加载器只调一次 `setup(ctx)`：注册 `tm_*` 工具、解析那两层配置、在
`permission.evaluate` 上装 R6/地址守卫、在 `tool.execute.after` 上挂
JIT 卸载、并发布黑板注记。用户自定义的同名 agent 永远赢——插件从不覆盖。

让这一层配置值得信任的规则只有一条：**`CONFIG_KEYS` 就是注册表，也是唯一
事实来源。** 不在它里面的键会被报成未知且永不应用；红线集合由这个注册表
推导而不是手工列一遍；自动创建的全局文件也是**从**它渲染出来的，所以不可能
与代码真正读取的东西产生漂移。

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
