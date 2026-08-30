# OpenCode TeamMode

**[English](./README.md)** | **[中文](./README.zh-CN.md)**

[![npm version](https://img.shields.io/npm/v/@te-river/opencode-team-mode.svg)](https://www.npmjs.com/package/@te-river/opencode-team-mode)
[![npm downloads](https://img.shields.io/npm/dm/@te-river/opencode-team-mode.svg)](https://www.npmjs.com/package/@te-river/opencode-team-mode)
[![license](https://img.shields.io/npm/l/@te-river/opencode-team-mode.svg)](./LICENSE)

> 🤝 **Multi-agent team collaboration plugin for [OpenCode Desktop](https://opencode.ai)**
>
> Adds a complete team of specialized AI agents — Architect, Implementer, Reviewer, Tester, Researcher — orchestrated by a Team Lead, all accessible via simple slash commands.

---

## ✨ What is TeamMode?

TeamMode transforms OpenCode Desktop from a single-agent coding assistant into a **full development team**. Each agent has a distinct role, expertise, and personality — just like a real engineering team.

Instead of one agent trying to do everything, you get:

| Agent | Role | When to use |
|---|---|---|
| 🎯 **Team Lead** | Orchestrator | Complex tasks that need planning + multi-step execution |
| 🏗️ **Architect** | System designer | Design docs, module structure, API contracts |
| 💻 **Implementer** | Code writer | Building features, writing production code |
| 🔍 **Reviewer** | Code auditor | Bug hunting, security review, quality checks |
| 🧪 **Tester** | Test engineer | Unit tests, integration tests, edge-case coverage |
| 🔎 **Researcher** | Knowledge finder | Library evaluation, API docs, best practices |

---

## 🚀 Quick Start

### Prerequisites

1. **Install OpenCode Desktop** (if you haven't already):

   | Platform | Install command |
   |---|---|
   | macOS (Apple Silicon) | `brew install --cask opencode-desktop` |
   | macOS (Intel) | `brew install --cask opencode-desktop` |
   | Windows | `scoop bucket add extras && scoop install extras/opencode-desktop` |
   | Linux | Download from [opencode.ai/download](https://opencode.ai/download) |

   Or install the **CLI/TUI** version:
   ```bash
   # one-line script (all platforms)
   curl -fsSL https://opencode.ai/install | bash

   # or via npm
   npm install -g opencode-ai
   ```

2. **Node.js ≥ 18** (for npm)

### Install TeamMode

**Option A — One-line installer (recommended):**

macOS / Linux (bash):
```bash
curl -fsSL https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/scripts/install.sh | bash
```

Windows (PowerShell):
```powershell
irm https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/scripts/install.ps1 | iex
```

These scripts install the npm package and automatically register the plugin in your `opencode.jsonc`.

**Option B — Manual npm install:**

```bash
# 1. Install the plugin package
npm install -g @te-river/opencode-team-mode

# 2. Add the plugin to your opencode.jsonc
#    (see "Configuration" below)
```

**Option C — Local dev install (from this repo):**

```bash
git clone https://github.com/Te-River/Opencode-TeamMode.git
cd Opencode-TeamMode
npm install
npm run build
npm link
```

---

## ⚙️ Configuration

After installing, add the plugin to your `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@te-river/opencode-team-mode"
  ]
}
```

That's it. The plugin automatically injects all team agents and commands when OpenCode starts. **No need to manually copy agent files or command definitions.**

> 💡 **Tip:** After modifying `opencode.json`, **restart OpenCode Desktop** for changes to take effect.

### Global install (all projects)

To enable TeamMode in every project, add the plugin to your global config:

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

## 📖 Usage

### Slash Commands

TeamMode adds six slash commands to OpenCode. Type them in the chat input:

| Command | Agent | Description |
|---|---|---|
| `/team-plan <task>` | Architect | Create a detailed implementation plan with architecture, file manifest, and task breakdown |
| `/team-implement <task>` | Implementer | Write production code for a feature or task |
| `/team-review [scope]` | Reviewer | Audit code for bugs, security issues, and quality problems |
| `/team-test [scope]` | Tester | Generate comprehensive tests with edge-case coverage |
| `/team-research <topic>` | Researcher | Investigate libraries, APIs, or best practices |
| `/team-run <task>` | Team Lead | **Full workflow** — orchestrates all agents end-to-end |

#### Example workflow

```
# 1. Plan the feature
/team-plan Add user authentication with OAuth2 and JWT tokens

# 2. Review the plan, then implement
/team-implement Implement the auth module as planned

# 3. Review the code
/team-review src/auth/

# 4. Write tests
/team-test src/auth/

# Or let the team lead handle everything:
/team-run Add user authentication with OAuth2 and JWT tokens
```

### Agent Picker

You can also invoke agents directly using the `@` mention in OpenCode Desktop:

- `@team-lead` — Orchestrate a complex task
- `@architect` — Design a system or module
- `@implementer` — Write code
- `@reviewer` — Review code quality
- `@tester` — Write tests
- `@researcher` — Research a topic

### Desktop-specific features

In **OpenCode Desktop**, you get additional UX benefits:

- 🎨 **Color-coded agents** — Each agent has a distinct color in the chat UI for easy identification.
- 📋 **Agent picker** — Click the agent dropdown to switch between team agents visually.
- 🔀 **Parallel sub-tasks** — The Team Lead can dispatch multiple sub-agents simultaneously, with results shown in parallel panels.
- 📊 **Session history** — All team interactions are saved and searchable in the Desktop session sidebar.

---

## 🏗️ Architecture

```
opencode-team-mode/
├── package.json          ← npm package definition
├── tsconfig.json         ← TypeScript config
├── src/
│   ├── index.ts          ← Plugin entry (v2 format, id: "team-mode")
│   ├── agents.ts         ← Agent definitions (prompts, modes, colors)
│   ├── commands.ts       ← Command definitions (templates, agent bindings)
│   ├── blackboard.ts     ← Shared blackboard + TTL auto-cleanup sweeper
│   └── types.ts          ← v2 Plugin API type definitions
├── scripts/
│   ├── install.sh        ← One-click installer (bash)
│   └── install.ps1       ← One-click installer (PowerShell)
├── LICENSE               ← Apache 2.0
├── README.md             ← English documentation
└── README.zh-CN.md       ← Chinese documentation
```

### How it works

1. OpenCode Desktop starts and loads `opencode.json`.
2. It sees `"@te-river/opencode-team-mode"` in the `plugin` array and loads the npm package.
3. The plugin's v2 `setup` function runs, using `ctx.agent.transform()` and `ctx.command.transform()` to inject 6 agents and 6 commands.
4. The plugin's `id: "team-mode"` is displayed as the plugin name in the Desktop UI.
5. Agents and commands are immediately available in the Desktop UI — no file copying needed.

---

## 🗂️ Shared Blackboard (with automatic cleanup)

Sub-agents cannot message each other live (platform limitation), so TeamMode coordinates them through a **file blackboard**:

- Each multi-agent task gets its own directory under
  `<repo>/.git/opencode-team/<task-slug>/` — inside `.git/`, so your working
  tree and commits are **never polluted**. (Non-git workspaces fall back to
  the OS temp dir.)
- Every agent writes its full deliverable to a designated artifact
  (`01-architect-design.md`, `03-review-findings.md`, …); the Team Lead
  relays *summary + file path* in each dispatch and keeps `MANIFEST.md` as
  the index. Full documents are shared verbatim — no lossy telephone game,
  and fewer tokens.
- The Team Lead also enforces a review/test **feedback loop**: Critical/Major
  findings and product bugs automatically become tracked fix tasks until the
  deliverable converges.

### Cleanup — two layers

| Layer | Who | When |
|---|---|---|
| Fast path | Team Lead (prompt rule) | Deletes the task directory right after the final report |
| Safety net | Plugin code (in-process sweeper) | At startup + every hour: removes task directories idle **beyond the TTL** |

The sweeper is pure code — it never relies on the model remembering to
delete, and it also cleans up leftovers from crashes or force-kills.

### Configure the TTL

Default is **5 days**. To choose your own, use the tuple plugin form in
`opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["@te-river/opencode-team-mode", { "ttlDays": 7 }]
  ]
}
```

`ttlDays` accepts any number of days in `(0, 365]`; invalid values silently
fall back to 5.

---

## 🔧 Customization

### Override an agent

Add an agent with the same name in your `opencode.json` — your definition takes precedence:

```jsonc
{
  "agent": {
    "reviewer": {
      "model": "anthropic/claude-sonnet-4-6",
      "prompt": "You are an extremely strict reviewer. Reject anything with a lint warning."
    }
  }
}
```

### Add your own agents

TeamMode does not prevent you from adding more agents. Define them alongside the team:

```jsonc
{
  "agent": {
    "devops": {
      "mode": "subagent",
      "description": "Handles CI/CD, Docker, and deployment tasks.",
      "prompt": "You are the DevOps engineer..."
    }
  }
}
```

### Disable an agent

```jsonc
{
  "agent": {
    "researcher": { "disable": true }
  }
}
```

---

## 📦 Publishing to npm

If you want to publish your own fork:

```bash
npm run build        # compile TypeScript → dist/
npm version patch    # bump version
npm publish          # publish to npm registry
```

---

## 🤝 Contributing

Contributions are welcome! Areas where we need help:

- 🌐 **Localization** — Translate agent prompts to other languages
- 🎨 **More agent roles** — DevOps, DBA, Security Specialist, UX Designer
- 🔧 **Additional commands** — `/team-deploy`, `/team-docs`, `/team-refactor`
- 📝 **Better prompts** — Improve agent behavior through prompt engineering

---

## 📄 License

[Apache License 2.0](./LICENSE)

---

## 🔗 Links

- [npm Package](https://www.npmjs.com/package/@te-river/opencode-team-mode) — `@te-river/opencode-team-mode` on npm
- [OpenCode Desktop](https://opencode.ai) — Official website & download
- [OpenCode Docs](https://opencode.ai/docs) — Configuration & plugin documentation
- [OpenCode Plugin API](https://opencode.ai/docs/plugins) — Build your own plugins
- [OpenCode GitHub](https://github.com/anomalyco/opencode) — Source code for OpenCode itself
