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

> ⚠️ **模型选择很重要。** 工作流里的每一个判断——分诊、拆解、派发清单、
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

### 演示

以下是一段会话实录的还原。用户在代理选择器中选中 `team`（或按下方配置开启
`defaultAgent`），开新会话直接输入：

> **用户：** 给我们的 Express API 加令牌桶限流——每用户每分钟 100 请求，
> 超限返回 429。不要动 `src/legacy/` 下的任何东西。

```text
team   拆解任务：设计 → 实现 → 审查 → 测试。
       任务黑板：.git/opencode-team/20260831-143012/rate-limiter/（会话目录 + 任务板，都在 .git/ 内，闲置超 TTL 自动清理）

       ▸ @architect — 设计中（写入 01-architect-design.md）
       ✓ 内存令牌桶、按用户键控、429 + Retry-After
         聊天里只有摘要，设计全文在黑板上

       ▸ @implementer — 实现中（Reads: 01；写 02-implementer-middleware.md）
       ✓ src/middleware/rateLimit.ts（新增），接入 src/app.ts（+3 行）

       ▸ @reviewer — 审查改动（Reads: 01、02；写 03-reviewer-findings-r1.md）
       ⚠ 1 个 MAJOR — 桶回充分两步读-改-写，并发下有竞态
         → 已自动转为修复任务，发现原文随任务书派给 @implementer
           （这一步没有要求用户拍板）

       ▸ @implementer r2 — 修竞态（Reads: 03-r1 §MAJOR；写 04-implementer-r2.md）
       ✓ 回充重构为单次原子更新

       ▸ @reviewer r2 — 只复审改动范围
       ✓ 通过 — r1 发现已解决，无回归

       ▸ @tester — 覆盖限流器与边界（写 05-tester-report.md）
       ✓ 14/14 通过 — 突发边界、窗口过期、并发回充、
         src/legacy/** 逐字节未变（用户边界写进了测试断言）

team   完成。
       限流器已交付：rateLimit.ts（新增）· app.ts（+3）· 14 测试全绿
       审查闭环：1 个 major → 已修 → 清零
       假设：仅内存存储——要接 Redis 说一声
       src/legacy/ 未动
       任务黑板留在原地，TTL 到期自动回收
```

用户输入的消息只有第一条。reviewer 的发现直接变成 implementer 的下一张
工单；每份制品都留在黑板上而不是聊天里，只被需要它的那次派发读取。

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

- **会话隔离：** 每个会话拥有一个时间戳会话目录，多 Agent 任务在其内再各自
  独立建任务目录：`<repo>/.git/opencode-team/<session-key>/<task-slug>/` ——
  位于 `.git/` 内，**绝不污染**你的工作区和 commit（非 git 工作区自动回退到系统临时目录）。
  正因为黑板现在会留到 TTL 清扫才消失，会话层让新对话几乎不可能撞上（或误读到）
  上一场还没被收走的旧黑板 —— 时间戳精确到秒，理论上只有同一秒开跑的两个会话才会重名。
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

TeamMode 默认**不再占用默认代理槽**——新会话仍从内建 `build` 开始。这是刻意的
排序取舍：选择器会把**默认代理钉在第一位**，其余按名称字母升序，因此
「Team 排默认（首位）」与「Team 显示在 Plan 之后」不可兼得。不占槽时顺序为
**build, plan, team**。

若希望新会话直接由团队调度者接管（Team 被钉在首位，顺序变为
**team, build, plan**），开启 `defaultAgent`：

```jsonc
{
  "plugin": [
    ["@te-river/opencode-team-mode@latest", { "defaultAgent": true }]
  ]
}
```

即使用户显式配置了非 `build` 默认代理，也永远原样保留（开启与否都不覆写）。

**升级提示**：自 v1.4.4 起，插件默认不再占用默认代理槽。此前依赖 Team 作为
默认代理（v1.4.2+）的用户，请在插件选项中添加 `{ "defaultAgent": true }`。

---

## 🔧 自定义

### Team Lead 的模型最关键

Lead 是编排大脑：它给每条消息分类、把工作切成包、写每份派发清单、裁决
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
