# OpenCode TeamMode

**[English](./README.md)** | **[中文](./README.zh-CN.md)**

[![npm version](https://img.shields.io/npm/v/@te-river/opencode-team-mode.svg)](https://www.npmjs.com/package/@te-river/opencode-team-mode)
[![npm downloads](https://img.shields.io/npm/dm/@te-river/opencode-team-mode.svg)](https://www.npmjs.com/package/@te-river/opencode-team-mode)
[![license](https://img.shields.io/npm/l/@te-river/opencode-team-mode.svg)](./LICENSE)

> 🤝 **你的 OpenCode 刚刚招了一个团队。** 主脑（Lead）、架构师、实现者、评审、测试、研究员，六个专职 agent，配上受治理的工具、结构化交接和「先出计划、等你批准」的门禁。一个插件，没有文件要拷。

> 💡 **建议在中大型项目里用。** 审批门禁、上下文卸载、工具白名单这层治理，在代码库有真实体量时是资产；在两三个文件的小脚本和一次性问答上，它主要是开销。把团队用在该用的地方。

---

## 📑 目录

- [太长不看](#太长不看)
- [为什么是 TeamMode？](#-为什么是-teammode)
- [快速开始](#-快速开始)
- [团队阵容](#-团队阵容)
- [1.9.2 新增](#-192-新增)
- [团队怎么运作](#-团队怎么运作)
- [工具](#-工具)
- [治理与安全](#-治理与安全)
- [配置](#️-配置)
- [故障排查](#-故障排查)
- [卸载](#️-卸载)
- [许可](#-许可)

---

## 太长不看

> **懒人路径：** 把下面这段话粘给任意编码 agent，让它替你装：
>
> ```text
> 安装 OpenCode 插件 @te-river/opencode-team-mode：本包**只支持 OpenCode 2.x**——1.18.x 人格已在 1.7.0 线里整体移除。
> 按 https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/docs/installation-v2.md 操作
> （2.x 的插件不能创建 agent，六个角色和六条 `/team-*` 命令要靠那份指南里的生成步骤落到配置目录——
> 这一步不是可选的）。然后跑一遍该指南里的验证检查。
> URL 打不开（国内网络常见）就在同一路径前加镜像前缀 https://ghproxy.net/；npm 慢或不通就先
> `npm config set registry https://registry.npmmirror.com`。
> ```
>
> **装好之后只需要记住一条命令：** `/team-run <任务>` —— Team Lead 先出计划给你看，等你批准，然后调度整个团队。

---

## 🤔 为什么是 TeamMode？

单个 agent 包打一切，结局你都见过：上下文窗口塞满五千行的文件转储，一个脚本能做完的事跟 shell 磨二十个回合，子 agent 悄悄读你的 `.env`，以及所谓的「联网调研」——其实全靠模型编。每一条都得有对应的机制，而不是一句承诺：

| 痛点 | 真正被强制的东西 |
|---|---|
| 🔥 **上下文爆炸** | 任何结果超过按内容分档的边界（散文 4000 / 数据 2000 token，CJK 感知）就卸载到本地 run 存储，换成约 80 token 的预览 + HMAC 句柄。需要什么，`tm_fetch` 再分页取什么。 |
| 🐌 **回合开销** | 宿主自己的 `execute`（Code Mode）：写一个程序，里面跑 N 次受治理调用，中间零 LLM 回合。 |
| 🕳️ **静默副作用** | R6：Team 角色读 `.env` **直接拒绝**，没有同意路径；读环境变量的 shell 命令走宿主自己的权限提示。每个守卫只能把规则改得更严——插件从不代替你批准。 |
| 🌫️ **幻觉式调研** | 联网是两个角色的授权 + 白名单受治理工具，重定向逐跳复检；抓不到的事实报成缺口，绝不模拟。 |
| 🎯 **目标漂移** | Lead 开局用你自己的措辞写 `GOAL:`，再加可验证的 `ACCEPTANCE:` 判据；每一条新要求先变成账本条目；清单上还有未完成项时，`tm_join` 会直说「目标未达成」。至于宿主自带的目标功能，由 `tm_goal` 桥接，而不是重写一遍。 |
| 🗣️ **用你没选的语言回话** | 受治理工具回的是中文；每个角色都带一条回复语言规则——散文用你的语言，中文字符串只在「它本身就是证据」时逐字引用。 |
| ⏱️ **为了显得认真而烧掉的轮次** | 效率至上：一次宽调用代替三次窄调用、互不依赖的调用并到同一轮、≥3 个探测合成一个 `execute` 程序。边界同样写死：效率不能拿去赎回证据规则。 |

表下面是流程纪律：确定性路由、≥2 次派工前先出 ≤30 行计划等你批准、`STATUS/CHANGES/FINDINGS/EVIDENCE/HANDOFF` 结构化回复，以及静态验证（构建 / 类型检查 / 测试）说了算，不靠感觉。

---

## ⚡ 快速开始

**第一步 · 安装。** 用[太长不看](#太长不看)那段话、跑安装脚本，或者照 [docs/installation-v2.md](./docs/installation-v2.md) 手动来。成败只取决于两件事：

- 键名是 **`plugins`（复数）**，2.x 的条目是字符串或 `{ "package": …, "options": { … } }`。多个配置文件里的条目是**由低到高叠加、不是互相替换**，所以 Team 只能有一条——同时写进 `opencode.json` 和 `opencode.jsonc` 就是加载两遍。
- 2.x 的插件**不能创建 agent**，所以 `node <pkg>/scripts/gen-v2-config.mjs` 负责把六个角色和六条 `/team-*` 命令写进配置目录。安装器替你做这一步；手动装就等于自己做这一步。

然后 `opencode service restart` 重启（桌面版从托盘退出，光关窗口不算）。会话中途重启是安全的：对话还在，只有正在跑的那次工具调用会被中断、需要重发。

**第二步 · Team 就是默认角色。** 安装器在角色文件落盘**之后**才写 `default_agent: "Team"`——默认值指向一个不存在的 agent 时，宿主会安静地退回 `build`，所以顺序有讲究，boot 行也会报它到底读到了什么。Team 是选择器的默认项；五个专家以子代理运行（由 Lead 派发），不会出现在选择器里。`/team-*` 命令以 Team 身份运行，再派发给对应专家。

**第三步 · 提问。** `/team-run <任务>`，或者 `@team <任务>`。需要 ≥2 次派工时，你会先拿到一份 ≤30 行的计划，它等你批准。

更新：**重跑安装脚本**（它会重新生成角色/命令文件）。2.x 下包由宿主自己安装，`@latest` 不会原地重新解析；如果宿主一直加载旧版本，清掉它的按包缓存（本平台是 `~/.cache/opencode/npm/@te-river`）再重启。`~/package.json` 钉住另一份副本的坑和 `entrypoint=` 诊断在[故障排查](#-故障排查)。

<details>
<summary><b>安装会在你机器上改什么</b></summary>

改动全在仓库之外；安装器会打印改了什么，并把值读回来：

- **配置条目** → `~/.config/opencode/opencode.jsonc`（不存在就创建；我们会把 Team 条目从 `opencode.json` 收回——两个文件会合并，所以只保留一个 Team 条目）——直到你删掉那一行。
- **六个角色 + 六条命令** → `~/.config/opencode/agents/*.md` 和 `~/.config/opencode/commands/*.md`，由已安装的包生成（2.x 插件不能创建 agent，所以这一步不是可选的）。
- **默认角色** → 在角色文件落盘之后才写 `default_agent: "Team"`，并从磁盘读回。
- **不会碰：** 宿主的 npm 缓存和 `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`——2.x 原生支持后台子代理，不设任何环境变量。
- **撤销：** 删掉 `plugins` 那一行（可选：删掉生成的 `agents/` / `commands/` 文件）再重启。

</details>

---

## 👥 团队阵容

| Agent | 角色 | 什么时候出场 |
|---|---|---|
| 🎯 **Team Lead**（`@team`） | 调度者 | 所有复杂任务：出计划、派工、验收、汇报 |
| 🏗️ **Architect** 架构师 | 系统设计 | 设计文档、模块结构、API 契约——**只在设计真的未知时** |
| 💻 **Implementer** 实现者 | 写代码 | 做功能、写生产代码 |
| 🔍 **Reviewer** 评审 | 单维度审计 | 默认一个维度；高风险变更才三维度并行 |
| 🧪 **Tester** 测试 | 测试工程 | 真实边界用例、静态验证，以及用宿主的 `browser_*` 做 UI 验证 |
| 🔎 **Researcher** 研究员 | 找知识 | 先本地仓库、后联网——两个联网角色之一 |

授权按职责走，不按资历：Lead `task / edit / write / shell / question`；Implementer 和 Tester `edit / write / shell`；Reviewer 只有 `shell`；Architect 和 Researcher 除了受治理工具**什么都没有**。只有 Lead 能派工——专家不可能再生专家。

六条斜杠命令对应同样这六个角色：`/team-plan`（架构师）、`/team-implement`（实现者）、`/team-review`（评审）、`/team-test`（测试）、`/team-research`（研究员）、`/team-run`（Team Lead）。

---

## ✨ 1.9.2 新增

*1.9.2 是当前发布版本。*

**`tm_goal` —— 宿主自带 goal 功能的桥。** 宿主 2.2.x 自带一个 `opencode.goal` 插件，只注册一个 RPC（`get`），目标状态存在**它自己的** storage 命名空间里，`ctx.storage` 读不到。所以那个 RPC 是唯一的读缝，而且**根本没有写 RPC**。这些 TeamMode 一条都不重写：

- `status` 读宿主目标（objective、status、rounds、reason）。在子会话里会向上找父会话的目标（最多 5 层、带环保护）——那是这条工作线继承下来的契约。
- `set` / `pause` / `resume` / `clear` **转投给宿主自己的 `/goal` 命令**，并且不 await：那条命令会跑完一整轮宿主流程，await 它等于把调用方挂在那儿。所以答复写的是**「已提交」，不是「已生效」**——只有下一轮宿主自己报的 `status:"active"` 才算凭证。
- 写只有 **Lead 能发**；读对六个角色开放。`set` 会拒绝空目标、拒绝宿主**实测**的 4000 字符上限、拒绝恰好是 `pause`/`resume`/`clear` 三个词之一的目标（宿主会把它当子命令执行），并且在已有目标且状态不是 `complete` 时要求 `replace:true`。
- 目标跑起来之后的事归宿主：**它**跑 goal reviewer 和续跑轮次，**它**在重启时暂停活跃目标（带自己的原因行）。一个活跃目标会花掉你没要求的模型轮次——所以 Lead 只在你明确要一个持久目标时才设。

**v2 现在注册九个受治理工具：** `tm_fetch`、`tm_webfetch`、`tm_search`、`tm_memory`、`tm_join`、`tm_stats`、`tm_board_write`、`tm_ledger`、`tm_goal`。

---

## 🏗️ 团队怎么运作

子 agent 之间不能实时互发消息，所以协调靠**结构化回复骨架**——每个专家的回复都是 `STATUS: / CHANGES: / FINDINGS: / EVIDENCE: / HANDOFF:`，≤50 行，由 Lead 原文转投进下一次派工。超过约 50 行的交付写成**一个**黑板文件（`tm_board_write`），落在 `<repo>/.git/opencode-team/` 下——带轮次后缀、绝不覆盖、工作树分毫不动。

- **路由表（确定性）：** 提问 → 直接答；纯文档 → 实现者；产品行为变更 → 实现者 → 测试 → 评审；多模块 → 架构师 → 实现者 → 测试 → 评审（可并行）；陌生技术 → 研究员先行。产品变更路由低于三次派工就是路由 bug。
- **一次派工，一个可独立验证的交付** —— Lead 说不出一份子代理的结果要如何**单独**被验证，它就还是愿望，不是派工。架构师是条件性的：根因已经定位（有 file:line 证据）就跳过它。
- **能并行就并行：** 测试与评审同一轮；各自持有不相交文件的多个实现者同一轮；分包到不相交包的多个测试同一轮。
- **审批门禁（计数式）：** ≥2 次派工 → 计划（≤30 行）→ **等你批准** → 执行。阻塞性问题立刻批量问。把一个要求拆成若干不足 2 次派工的小块来躲门禁，是协议违规。
- **账本：** 每一条新要求在动手**之前**先变成 `tm_ledger` 条目；中途插进来的事是插入，不是替换。`blocked` 是一种状态，不是退出口。
- **黑板：** 文件是例外不是常规。一份交付一个文件，名字由工具决定（`NN-<role>-<topic>[-rN].md`），角色取自会话——子代理没法用借来的名字归档。
- **静态验证：** 构建 / 类型检查 / lint / 测试。临时起意的浏览器自动化不算验证；未验证的 UI 工作以 `UI NOT VERIFIED: <待人工检查项>` 收尾，且每一句「完成 / 修好 / 通过」都要带输出、日志或 diff。
- **截断：** 用户喊停是范围变更，不是放弃在途工作的许可。先把已打开的东西落盘，不开新工作，跳过验证，按四段交接——已落盘 / 未开始 / 验证 / 提交与发布。

---

## 🧰 工具

**宿主原生工具排在前面。** read / grep / glob / edit / write / shell 都是宿主自己的，JIT 治理通过 `tool.execute.after` 覆盖它们——实测里一个 12,902 token 的 `shell` 结果，到手是 78 token 的预览加一个句柄。**Code Mode（`execute`）** 是宿主「一个程序、多次调用」的入口，也是回合成本的正解：多次受治理调用，一轮，只回一份汇总。

| 受治理工具 | 一句话 | 角色 |
|---|---|---|
| `tm_fetch` | 按句柄分页取回被卸载的结果；JSON 句柄支持 `fields` 点路径投影（`items[].name`）。 | 六个角色 |
| `tm_webfetch` | 对白名单页面做一次受治理 GET；重定向逐跳复检，被拒时报出整条链。 | Lead + 研究员 |
| `tm_search` | 多引擎搜索：并行扇出、按 host+path 去重、加权 RRF 融合，输出可提取的命中列表。 | Lead + 研究员 |
| `tm_memory` | 会话 / 项目 / 全局三层记忆：add / search / list / forget / compact，近乎重复的条目会折叠。 | 六个角色 |
| `tm_join` | 子代理工作的读侧：状态、有界 `waitMs`、`cancel:true`（五种互不冒充的裁决）、指名子代理的完整回复。 | 仅 Lead |
| `tm_stats` | 把插件自己的轨迹读回来：省下的 token、派工重叠、能力矩阵、分层配置来源。 | 六个角色 |
| `tm_board_write` | 黑板的写侧：新增一个 `NN-<role>-<topic>[-rN].md`，名字由工具决定，绝不覆盖。 | 六个角色 |
| `tm_ledger` | Lead 的任务账本，存在宿主的 `ctx.storage` 里——2.x 不给插件 `todowrite`。 | 仅 Lead |
| `tm_goal` | 读宿主目标；把 set / pause / resume / clear 转投 `/goal`。**已提交 ≠ 已生效。** | 读：六个角色 · 写：仅 Lead |

**插件侧没有派发器。** `tm_dispatch` 已移除：插件自己创建的子会话，你既不能从卡片打开，也不能从界面停掉。派工走宿主自己的 `task` / `task { background: true }`——看得见的卡片、宿主的急停开关——`tm_join` 是收集侧。

**浏览器与联网授权。** 交互式浏览是宿主的 `browser_*` 目录。Tester 带着它是为了验证你的项目的 UI；开放联网属于 Lead 和研究员。架构师、实现者、评审**没有联网授权**——那边出现联网问题，报成缺口，绝不模拟。没有原生浏览器目录的宿主（CLI / standalone）就没有浏览器，agent 会直说。

---

## 🔒 治理与安全

所有工具调用走同一条流水线。流水线下面是守卫，**每个守卫只能把规则改得更严**：

- **R6 环境防护**（默认开启，`strict`）：Team 角色读环境**文件**是硬拒绝，没有同意路径——覆盖 `read`/`edit`/`glob`/`grep`，包括宿主只把**模式串**当权限资源上报的情况（`grep SECRET .env` 也过不去）。模板文件（`*.env.example` / `.sample` / `.template` / `.dist`）照常可读。**写在 shell 命令里**的环境变量读取走宿主自己的权限提示，按命令逐条判断——`git status` 什么都不问。通配符表达不了的环境读取直接拒绝、不弹窗；审计日志只记工具名 + 类别 + 裁决。
- **R2 危险操作：** 删除、发布、安装、杀进程、提权——没有一个会被静默放行，而正常的验证动作（`npm test`、`tsc`、`git status`）不被拦。
- **地址红线**（任何设置都打不开）：云元数据、link-local、多播、保留段与基准测试段，以及它们的 IPv4-mapped 与 DNS64 写法——换个记法不是绕过。
- **联网白名单**（是门，不是墙）：2.x 上域名门默认是 `["*"]`——也就是开着——因为插件弹不出受限制名单所需的同意对话框，而没有门可走的「门禁」不叫门禁。一旦你设了 `webfetchAllowedDomains`，它才成为真名单：种子是 22 个宿主，加上默认种子生效期间的 2 个引擎种子；父域覆盖子域，自定义名单会**替换**种子，白名单外的调用**失败关闭**，拒绝语给出出口（`privateSpace: "allow"`，或把那个主机名加进名单）。
- **卸载（offload）：** 三种结局而不是两种——卸载（载荷 + 预览 + 句柄）、**保留寻址的截断**（浏览器快照保留每一条 `[ref=…]` 行，丢掉散文，预算 1200 token）、**保留表格的截断**（报告保留行，预算 1600 token）。少一行的表格不是更小，是坏了。
- **上下文裁剪：** 越过窗口 70% 后，已结算的消息体变成一行指针——但先卸载过，所以桩里带的是真 `tm_fetch` 句柄。回复骨架、GOAL/ACCEPTANCE、来源、系统消息和黑板注记永不被裁。
- **重试：** 限流按名字和文本分类，然后按请求给阶梯——5s / 10s / 20s / 40s / 60s，跨请求不共享；宿主自己有倒计时就以宿主为准。硬配额只认计费那一族，且不给等待秒数。
- **作用域：** 宿主的 hook 对每个会话都触发，所以每一层先问「这是我们六个角色之一吗」。`build`、`plan` 和你自己写的 agent 保持全新安装的样子；认不出归属的调用原样放过**并计数**，`tm_stats` 会打印 作用域：我们 · 他人 · 未判定。

> ⚠️ **批宿主自己的对话框时，选「once」，别选「always」。** 实测：「always」记下的规则比你看的那条宽得多（批准 `Get-ChildItem env:PATH`，存下的是 `Get-ChildItem *`）；联网也一样，一条保存下来的规则对**那个项目里的每个 agent 会话**都算数。所以回复会说明这次页面是走静态白名单、走你刚答的对话框、还是走一条毫秒级就答完的保存规则——分不清这三者的 agent 会把「没弹窗」报成「那个站点是允许的」。

临时文件一律放系统临时目录、跑完前删掉；卸载 / 轨迹 / 记忆存储都在 `<repo>/.git/opencode-team/` 下（不在 git 仓库里就在系统临时目录、按工作区分片）——**永远不是你的工作树**。

---

## ⚙️ 配置

**配置就是 JSON，只有 JSON。** `team-mode.jsonc` 是唯一来源。没有环境层：你为配置设的 `TM_*` 变量是惰性的。

| 层 | 路径 | 优先级 |
|---|---|---|
| **global** | `~/.config/opencode/team-mode.jsonc`（认 `OPENCODE_CONFIG_DIR`） | 最低——对所有项目生效 |
| **project** | `<dir>/team-mode.jsonc`，从工作区**一路走到文件系统根** | 中间——直连文件由远及近合并 |
| **project** | `<dir>/.opencode/team-mode.jsonc`，同样走法 | 每个 `.opencode/` 文件压过每个直连文件 |
| **system** | `%ProgramData%\opencode\team-mode.jsonc`（Windows）/ `/etc/opencode/team-mode.jsonc`（POSIX） | **最高**——宿主的托管设置层 |

这个走法和优先级是宿主自己的配置分层规则，照抄而不是自创。JSONC 注释在字节层被掩掉，所以注释掉的行不会被当成生效；某一层解析失败就**整层**跳过；单个坏键只损失它自己，未知键会告警且永不应用。

**它会自己写一份。** 全局文件不存在时，插件在启动时创建它——原子写、绝不覆盖已有文件——把**全部 66 个**注册表键各写成一行带说明的**注释**。它解析出来是 `{}`，你取消注释之前什么都不设。`autoCreate: false`（或 `TM_CONFIG_AUTOCREATE=off`）可关。

**红线键**（`envProtect`、`r6FineAsk`、`privateSpace`、`webfetchAllowedDomains`、`bashReadonlyAllowed`）**只在 global 或 `system` 层被认**。项目文件可以写，但值会被忽略并报出来——一份提交进仓库的项目配置，不该替所有 clone 的人关掉守卫。这个集合从注册表推导，所以新加的红线键天然就是红线。

**插件选项**写在插件条目上，不在 `team-mode.jsonc` 里：

```jsonc
{
  "plugins": [
    { "package": "@te-river/opencode-team-mode@latest",
      "options": { "defaultAgent": true, "autoCreate": true, "envProtect": true } }
  ]
}
```

| 选项 | 默认 | 含义 |
|---|---|---|
| `defaultAgent` | `true` | 检查并报告安装器写的 `default_agent` 指向谁。2.x 插件 ctx 没有 `agent.default`，插件没法替你设默认角色；`false` 只是跳过这项检查。 |
| `autoCreate` | `true` | 全局文件缺失时，启动写一份惰性模板。 |
| `envProtect` | `true` | 全插件总开关；`false` 把 R6 模式解析成 `off`。 |

2.x 的条目是字符串**或**带 `package`、`options` 的对象；1.x 的元组写法会被直接拒绝。选项确实送得到——boot 行读的就是对象形式。保留期属于配置而不是插件选项：`blackboardTtlDays`（默认 7）同时决定黑板和句柄的 TTL。

**模型选择。** 每一次判断——分诊、拆解、派工 brief、综合、评审结论——都过 Lead，所以那儿的模型弱，整条流水线都弱。把你最强的推理模型钉给 `team`：

```jsonc
{
  "agent": {
    "team": { "model": "anthropic/claude-opus-4-5" },          // Lead 值得最强的模型
    "implementer": { "model": "anthropic/claude-sonnet-4-6" }, // 专家可以便宜些
    "researcher": { "disable": true }                          // 或者直接去掉一个角色
  }
}
```

你自己的定义优先，插件绝不覆盖。让这层配置值得信任的只有一条规则：**`CONFIG_KEYS` 就是注册表，也是唯一事实来源**——不在里面的键会被报成未知且永不应用；`tm_stats` 会渲染每个键的来源、被跳过的层、未知键，以及被它忽略掉的红线尝试。

**三个 `TM_*` 名字作为内部 / 测试开关存活，它们不是配置：** `TM_STORE_RECLAIM`（覆盖 `storeReclaim`）、`TM_V2_PROBE`（一个 JSONL 路径，表面探针把宿主真实的工具 id、权限动作名和参数键**名**记进去——只有名字和计数，绝不记命令行、路径、URL 或值）、`TM_CONFIG_AUTOCREATE`（`off` 抑制惰性模板的创建）。

---

## ❓ 故障排查

**会不会很烧 token？** 恰恰相反，省 token 才是目的。卸载、约 80 token 的预览、Code Mode，全都是因为六个 agent 的流水线要是裸接一个上下文窗口，那才叫烧 token。治理层是省的那一方，省了多少 `tm_stats` 会写出来。

**我设的 `TM_*` 变量没反应。** 正常——配置已经搬到 JSON 了。把值搬进 `team-mode.jsonc` 里对应的注册表键，再跑一次 `tm_stats`：它的分层配置小节会点名每个键的来源文件，于是你以为被认了的那个值，来源栏会显示不是你改的那个文件。

**我在项目文件里设的红线键被忽略了。** 这是设计。那五个键只在 global 或 `system` 层被认，`tm_stats` 会按名字报出那次尝试，而不是静默丢掉。

**插件为什么不自己更新？** OpenCode 按 spec 字符串缓存插件，`@latest` 不会原地重新解析（上游问题，不是我们的）。重跑安装脚本会重新生成角色/命令文件；如果宿主一直加载旧版本，清掉它的按包缓存（`~/.cache/opencode/npm/@te-river`）再重启。如果 boot 探针的 `entrypoint=` 一行指向宿主缓存之外，那就是一份 `~/package.json` 在钉另一份副本——这一行才是诊断手段，不是去猜缓存层。

**`AGENT NOT FOUND: "Team"`。** 文件名就是 agent id，而 Windows / APFS 在一次写入经由另一个文件打开时会**保留**既有拼写——于是 1.7.2 之前的 `team.md` 每次安装都活下来，宿主把领队注册成小写。用 `--agent team`；安装器的回收步骤在证明是同一个文件之后，会把只有大小写不同的条目改名。

**agent 能并行调工具吗？** 能，而且是为并行设计的：并行的 `tm_search` / `tm_webfetch` / `tm_fetch` 拿到互不相同的 step id 和互相隔离的载荷，这里出回归，套件会在它到你面前之前先红。

**只有桌面版能用吗？** 都能。桌面版多了彩色角色选择器，受治理工具和整套工作流与宿主无关。交互式浏览是宿主自己的目录，所以 CLI / standalone 没有浏览器——报成缺口，绝不模拟。

**宿主权限提示我不理会会怎样？** 那是宿主的计时器，不是本插件的。插件只能拒绝：它从不自我放行，装的每个守卫只能把规则改得更严；它不认作自己角色的会话，原样留给宿主行为。

---

## 🗑️ 卸载

1. 从 **`plugins`** 数组里移除 Team 条目。2.x 上还要删掉生成的 `~/.config/opencode/agents/*.md` 与 `commands/team-*.md`，以及你不再需要的 `default_agent: "Team"` 那一行。
2. 想回收磁盘就删缓存目录（命令见[快速开始](#-快速开始) / [故障排查](#-故障排查)）。
3. 重启 OpenCode。agent、命令、工具全部消失。`<repo>/.git/opencode-team/` 下的存储和 `~/.opencode-team/` 下的全局记忆都是普通文件，随时可删。全局 `team-mode.jsonc` 留不留随你；删掉的话，下次安装会重新写一份惰性模板。

没有 DLL 受伤。工作树从来没被写过。

---

## 📄 许可

[Apache License 2.0](./LICENSE)

- [npm 包](https://www.npmjs.com/package/@te-river/opencode-team-mode) — `@te-river/opencode-team-mode`
- [安装指南（**OpenCode 2.x**）](./docs/installation-v2.md) — 受支持的装法；2.x 插件不能创建 agent，六个角色和六条命令要生成到配置目录
- [安装指南（1.18.x）](./docs/installation.md) — **仅历史**：那个人格已在 1.7.0 线里移除
- [OpenCode](https://opencode.ai) · [文档](https://opencode.ai/docs) · [插件 API](https://opencode.ai/docs/plugins)
- 模块地图、每层接缝和所有实测到的宿主事实：[AGENTS.md](./AGENTS.md)；每条 v2 论断背后的带日期证据：[docs/v2-port-notes.md](./docs/v2-port-notes.md)

欢迎 issue 和 PR——尤其欢迎搜索引擎真实行为的实测报告（它们改版很勤，而提取器是故意放宽的，不是会读心术）。
