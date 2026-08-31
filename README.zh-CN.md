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
| 🔍 **Reviewer** | 代码审查员 | Bug 猎手、安全审查、质量检查 |
| 🧪 **Tester** | 测试工程师 | 单元测试、集成测试、边界覆盖 |
| 🔎 **Researcher** | 知识调研员 | 库评估、API 文档、最佳实践调研 |

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

**方式 A — 一键安装脚本（推荐）：**

macOS / Linux（bash）：
```bash
curl -fsSL https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/scripts/install.sh | bash
```

Windows（PowerShell）：
```powershell
irm https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/scripts/install.ps1 | iex
```

脚本会自动安装 npm 包，并将插件注册到你的 `opencode.jsonc` 中。

**方式 B — 手动 npm 安装：**

```bash
# 1. 安装插件包
npm install -g @te-river/opencode-team-mode

# 2. 将插件添加到 opencode.jsonc
#    （见下方"配置"章节）
```

**方式 C — 本地开发安装（从本仓库）：**

```bash
git clone https://github.com/Te-River/Opencode-TeamMode.git
cd Opencode-TeamMode
npm install
npm run build
npm link
```

---

## ⚙️ 配置

安装后，将插件添加到你的 `opencode.jsonc`：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@te-river/opencode-team-mode@latest"
  ]
}
```

就这么简单。插件会在 OpenCode 启动时自动注入所有团队 Agent 和命令，**无需手动复制任何 Agent 文件或命令定义**。

> 💡 **提示：** 修改 `opencode.json` 后，请**重启 OpenCode 桌面版**使更改生效。

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
| `/team-research <主题>` | Researcher | 调研库、API 或最佳实践 |
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

### 🎬 演示：在 OpenCode 桌面版里跑一次完整的团队工作流

把代理选择器切到 **`team`**（由于它是被提升的默认代理，通常不用切），输入：

> *给我们的 Express API 加令牌桶限流：每用户每分钟 100 请求，超限返回 429。
> 不要动 `src/legacy/` 下的任何东西。*

**① Triage 分诊。** 这是明确的行动指令 → 进入工作流。你划的
`src/legacy/` 红线被记录，并**在每一次派发中原样重申**。

**② 规划。** 聊天窗口出现 todo 清单 —— 每个工作包一项
（设计 → 实现 → 审查 → 修复 → 复审 → 测试 → 汇报），同一时刻只有一项进行中。

**③ 首次派发。** 创建任务目录，architect 拿到的是一份清单而不是滚屏长文：

```
Task:     为 Express API 设计令牌桶限流器 …
          （2–5 行任务书 + 用户边界：src/legacy/** 禁改）
Reads:    （无 —— 这是第一份制品）
Write to: 01-architect-design.md
```

团队干活时，你可以**亲眼看着黑板逐渐写满** ——
`.git/opencode-team/rate-limiter/` 位于 `.git/` 内，
永不污染你的工作区和 commit：

```
.git/opencode-team/rate-limiter/
├── MANIFEST.md                     ← lead 专属索引 + 实时状态头
├── 01-architect-design.md          ← 完整设计原文；聊天里只有摘要
├── 02-implementer-middleware.md
├── 03-reviewer-findings-r1.md      ← 第 1 轮审查 …
├── 04-implementer-fix-notes-r2.md  ← 修订 = 新文件，旧轮次冻结
├── 03-reviewer-findings-r2.md      ← … 仅针对改动范围的复审
└── 05-tester-report.md
```

`MANIFEST.md` 是团队跨长任务的压缩记忆：

```markdown
## Current state
阶段：验证（闭环 2/2）—— 审查已清零，测试运行中
仍然有效的决策：内存令牌桶、按用户键控、429 + Retry-After
边界：src/legacy/** 禁改（用户声明，已随每次派发重申）
下一步：测试结论 → 最终报告 → 删除任务目录
```

**④ 反馈闭环抓到 bug。** reviewer 标出 🟠 **Major**：桶回充非原子、高并发下有
竞态。你没有提任何要求 —— Team 自动把这条发现转成跟踪的修复任务，把发现原文
塞给 implementer，复审只看被改动的范围。

**⑤ 完成。** 聊天里落出一份结构化报告：

> **限流器已交付。** 文件：`src/middleware/rateLimit.ts`（新增）、
> `src/app.ts`（+3 行）、`tests/rateLimit.test.ts`（14 用例，全过）。审查：
> 1 个 Major → 已修复 → 清零。假设：内存存储（未接 Redis）。
> 边界遵守：`src/legacy/` 未动。

……随后任务目录被删除。就算 Team 哪次忘了，插件的清扫器也会在 TTL（默认
5 天）后把闲置黑板一并收走。

### 黑板为什么值钱

| 朴素转述（没有黑板） | TeamMode 黑板 |
|---|---|
| 300 行设计在每次派发时被聊天重打一遍 —— 烧 token 还失真 | 全文只写一次；派发只带精确的 `Reads:` 清单 |
| 修复轮次追加/覆盖，审查员反复读过时结论 | 写入即冻结 —— 修订是 `…-r2.md`，只引用最新轮 |
| "当时是谁定的来着？"在长会话里蒸发 | MANIFEST 的 `## Current state` 全程存活 |
| 子代理甩锅："请帮我把这段逐字贴进去"（我们真见过） | `Write to:` 所有权 —— 每个 agent 自己落盘，失败必须显式报 `BLACKBOARD WRITE FAILED` |

### 桌面版专属特性

在 **OpenCode 桌面版** 中，你还能获得额外的 UX 体验：

- 🎨 **Agent 颜色标识** — 每个 Agent 在聊天 UI 中有独立颜色，便于识别
- 📋 **Agent 选择器** — 点击 Agent 下拉菜单，可视化切换团队 Agent
- 🔀 **并行子任务** — Team Lead 可同时调度多个子 Agent，结果在并行面板中展示
- 📊 **会话历史** — 所有团队交互都保存在桌面版侧边栏，可搜索回溯

---

## 🏗️ 架构

```
opencode-team-mode/
├── package.json          ← npm 包定义
├── tsconfig.json         ← TypeScript 配置
├── src/
│   ├── index.ts          ← 插件入口（server() + config hook，id: "team-mode"）
│   ├── agents.ts         ← Agent 定义（prompts、模式、颜色）
│   ├── commands.ts       ← 命令定义（模板、Agent 绑定）
│   ├── blackboard.ts     ← 共享黑板 + TTL 自动清理清扫器
│   └── types.ts          ← 加载器契约类型定义（1.18.x）
├── scripts/
│   ├── install.sh        ← 一键安装脚本（bash）
│   └── install.ps1       ← 一键安装脚本（PowerShell）
├── LICENSE               ← Apache 2.0
└── README.md             ← 英文文档
    README.zh-CN.md       ← 中文文档
```

### 工作原理

1. OpenCode 桌面版启动，加载 `opencode.json(c)`
2. 检测到 `plugin` 数组中的 `"@te-river/opencode-team-mode@latest"`，加载 npm 包
3. 加载器调用插件的 `server(input, options)`，注册 `config` hook；hook 向合并后的配置注入 6 个 Agent 和 6 个命令
4. 插件的 `id: "team-mode"` 作为插件名显示在桌面版 UI
5. Agent 和命令立即在桌面版 UI 中可用 —— 无需复制任何文件；同名 Agent 以用户自定义优先（插件绝不覆盖）

---

## 🗂️ 共享黑板（带自动清理）

子代理之间无法实时互发消息（平台限制），TeamMode 通过**严格所有权的文件黑板**让它们协作：

- 每个多 Agent 任务在 `<repo>/.git/opencode-team/<task-slug>/` 下拥有独立目录 ——
  位于 `.git/` 内，**绝不污染**你的工作区和 commit（非 git 工作区自动回退到系统临时目录）。
- **文件所有权**：每个制品是一个"一主题一文件"，只由一个 Agent 写
  （`01-architect-auth-design.md`、`03-reviewer-auth-r1.md`）。单文件约 ≤100 行，
  超长就拆主题文件而不是任其膨胀。
- **写入即冻结**：修订 = 新的轮次后缀文件（`…-r2.md`）；绝不追加旧文件，
  后续 Agent 也永远读不到过时轮次。
- **Team Lead 是路由器**：每次 dispatch 携带清单——`Task:`（自包含任务书）、
  `Reads:`（仅列出该工作包需要的文件）、`Write to:`（该 Agent 本次拥有的唯一文件）。
  子代理不读清单之外的任何东西，超长任务因此不会把无关上下文灌进子代理。
- **`MANIFEST.md` 是 lead 的状态板**：文件索引 + 顶部 ≤50 行的 `## Current state`
  节（阶段、仍然有效的决策、下一步），每轮闭环后更新——lead 跨长任务的压缩记忆。
- Team Lead 同时强制执行审查/测试**反馈闭环**：Critical/Major 问题和产品 bug
  自动转化为跟踪的修复任务，直到交付物收敛。

### Triage —— 提问不会变成代码修改

Team Lead 对每条消息先分类再行动：咨询/提问只得到回答（零文件改动，发现缺陷
仅**提议**修复并等待你放行）；只有明确的行动指令才进入工作流。并且一旦你写明
了哪些能碰哪些不能碰，**这些边界高于一切规则**——lead 会在每次派发中原样重申。

### 清理 —— 两层防御

| 层级 | 责任方 | 时机 |
|---|---|---|
| 快速路径 | Team Lead（prompt 规则） | 最终报告交付后立即删除任务目录 |
| 安全网 | 插件代码（进程内清扫器） | 启动时 + 每小时：清除空闲超过 **TTL** 的任务目录 |

清扫器是纯代码实现 —— 从不依赖模型"记得删"，还能兜底清理崩溃/强杀留下的残骸。

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

TeamMode 会将 **`team` 设为默认代理**（替代内建 `build`），新会话直接由团队
调度者接管。若想保持 `build` 或其他代理为默认：

```jsonc
{
  "plugin": [
    ["@te-river/opencode-team-mode@latest", { "defaultAgent": false }]
  ]
}
```

用户显式配置的非 `build` 默认代理永远原样保留。

---

## 🔧 自定义

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
