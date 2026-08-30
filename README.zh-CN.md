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
    "@te-river/opencode-team-mode"
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
    "@te-river/opencode-team-mode"
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

- `@team-lead` — 调度复杂任务
- `@architect` — 设计系统或模块
- `@implementer` — 编写代码
- `@reviewer` — 审查代码质量
- `@tester` — 编写测试
- `@researcher` — 调研主题

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
│   ├── index.ts          ← 插件入口（v2 格式，id: "team-mode"）
│   ├── agents.ts         ← Agent 定义（prompts、模式、颜色）
│   ├── commands.ts       ← 命令定义（模板、Agent 绑定）
│   └── types.ts          ← v2 Plugin API 类型定义
├── scripts/
│   ├── install.sh        ← 一键安装脚本（bash）
│   └── install.ps1       ← 一键安装脚本（PowerShell）
├── LICENSE               ← Apache 2.0
└── README.md             ← 英文文档
    README.zh-CN.md       ← 中文文档
```

### 工作原理

1. OpenCode 桌面版启动，加载 `opencode.json`
2. 检测到 `plugin` 数组中的 `"@te-river/opencode-team-mode"`，加载 npm 包
3. 插件的 `setup` 函数执行，通过 `ctx.agent.transform()` 和 `ctx.command.transform()` 注入 6 个 Agent 和 6 个命令
4. Agent 和命令立即在桌面版 UI 中可用 —— 无需复制任何文件

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
