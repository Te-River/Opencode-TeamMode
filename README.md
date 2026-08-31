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
    "@te-river/opencode-team-mode@latest"
  ]
}
```

That's it. The plugin automatically injects all team agents and commands when OpenCode starts. **No need to manually copy agent files or command definitions.**

> 💡 **Tip:** After modifying `opencode.json`, **restart OpenCode Desktop** for changes to take effect.

> ⚠️ **Model choice matters.** Every judgment in the workflow — triage,
> decomposition, dispatch briefs, synthesis, review-loop verdicts — flows
> through the **Team Lead**. A weak model in that seat degrades the whole
> pipeline no matter how strong the specialists are. Pin your best
> reasoning model to the `team` agent (recipe in
> [Customization](#customization) below).

### Global install (all projects)

To enable TeamMode in every project, add the plugin to your global config:

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

- `@team` — Orchestrate a complex task
- `@architect` — Design a system or module
- `@implementer` — Write code
- `@reviewer` — Review code quality
- `@tester` — Write tests
- `@researcher` — Research a topic

### Demo

A session transcript, recreated from how the flow actually looks. The user
picks `team` in the agent switcher (or enables `defaultAgent`, see
Configuration), then just types into a fresh chat:

> **User:** Add token-bucket rate limiting to our Express API — 100 requests
> per minute per user, return 429 when exceeded. Don't touch anything under
> `src/legacy/`.

```text
team   Breaking this down: design → implement → review → test.
       Task board: .git/opencode-team/20260831-143012/rate-limiter/   (session folder + board inside .git/, auto-swept after idle TTL)

       ▸ @architect — designing (writes 01-architect-design.md)
       ✓ in-memory token bucket, per-user key, 429 + Retry-After
         summary above, full design on the board

       ▸ @implementer — building (Reads: 01; writes 02-implementer-middleware.md)
       ✓ src/middleware/rateLimit.ts (new), wired into src/app.ts (+3 lines)

       ▸ @reviewer — auditing the diff (Reads: 01, 02; writes 03-reviewer-findings-r1.md)
       ⚠ 1 MAJOR — bucket refill does read-modify-write in two steps;
         races under concurrent requests
         → converted to a fix task; dispatched to @implementer with the
           finding text (the user was not asked to approve this step)

       ▸ @implementer r2 — fixing the race (Reads: 03-r1 §MAJOR; writes 04-implementer-r2.md)
       ✓ refill restructured to single atomic update

       ▸ @reviewer r2 — re-review of fixed scope only
       ✓ clean — r1 finding resolved, no regressions

       ▸ @tester — covering limiter + boundaries (writes 05-tester-report.md)
       ✓ 14/14 pass — burst edge, window expiry, concurrent refill,
         src/legacy/** byte-identical (user boundary verified in tests)

team   Done.
       rate limiter shipped: rateLimit.ts (new) · app.ts (+3) · 14 tests green
       review loop: 1 major found → fixed → clean
       assumption: in-memory only — say the word if you want Redis
       src/legacy/ untouched
       task board left in place — TTL sweep will reclaim it
```

The only message the user typed was the first one. The reviewer's finding
became the implementer's work order without a prompt; every artifact stayed
out of chat and on the board, read only by the dispatch that needed it.

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
│   ├── index.ts          ← Plugin entry (server() + config hook, id: "team-mode")
│   ├── agents.ts         ← Agent definitions (prompts, modes, colors)
│   ├── commands.ts       ← Command definitions (templates, agent bindings)
│   ├── blackboard.ts     ← Shared blackboard + TTL auto-cleanup sweeper
│   └── types.ts          ← Loader-contract type definitions (1.18.x)
├── scripts/
│   ├── install.sh        ← One-click installer (bash)
│   └── install.ps1       ← One-click installer (PowerShell)
├── LICENSE               ← Apache 2.0
├── README.md             ← English documentation
└── README.zh-CN.md       ← Chinese documentation
```

### How it works

1. OpenCode Desktop starts and loads `opencode.json(c)`.
2. It sees `"@te-river/opencode-team-mode@latest"` in the `plugin` array and loads the npm package.
3. The loader calls the plugin's `server(input, options)`, which registers a `config` hook; the hook injects 6 agents and 6 commands into the merged config.
4. The plugin's `id: "team-mode"` is displayed as the plugin name in the Desktop UI.
5. Agents and commands are immediately available in the Desktop UI — no file copying needed. User-defined agents with the same name always win (the plugin never clobbers them).

---

## 🗂️ Shared Blackboard (with automatic cleanup)

Sub-agents cannot message each other live (platform limitation), so TeamMode coordinates them through a **file blackboard** with strict ownership:

- **Session isolation:** every conversation owns ONE timestamped session
  folder, and each multi-agent task gets its own directory inside it:
  `<repo>/.git/opencode-team/<session-key>/<task-slug>/` — inside `.git/`,
  so your working tree and commits are **never polluted**. (Non-git
  workspaces fall back to the OS temp dir.) Since boards now linger until
  the TTL sweep, the session layer keeps a fresh conversation from bumping
  into — or reading stale artifacts from — a not-yet-swept board (timestamps
  are second-granular, so overlap needs two conversations starting in the
  same second).
- **File ownership:** every artifact is one topic-sized file written by
  exactly one agent (`01-architect-auth-design.md`, `03-reviewer-auth-r1.md`).
  ~100 lines max per file — split topics instead of letting files balloon.
- **Writes are frozen:** a revision is a new round-suffixed file
  (`…-r2.md`); nothing is ever appended to or later agents reading stale rounds.
- **The Team Lead is the router:** every dispatch carries a manifest —
  `Task:` (self-contained brief), `Reads:` (only the files that work package
  needs), `Write to:` (the one file the agent owns). Specialists read nothing
  that isn't listed, so long tasks never drown sub-agents in unnecessary context.
- **`MANIFEST.md` is the lead's state board:** a file index plus a ≤50-line
  `## Current state` section (phase, decisions still valid, next steps),
  updated every converged round — the lead's compressed memory across long tasks.
- The Team Lead also enforces a review/test **feedback loop**: Critical/Major
  findings and product bugs automatically become tracked fix tasks until the
  deliverable converges.

### Triage — questions don't become code edits

The Team Lead classifies every incoming message before acting: a question or
consult gets an answer (zero file changes, fixes merely proposed and awaiting
your go-ahead); only explicit action requests enter the workflow. And whenever
you spell out what may or may not be touched, **those boundaries outrank
everything else** — the lead restates them in every single dispatch.

### Cleanup — the TTL sweeper is the only path

| Who | When |
|---|---|
| Plugin code (in-process sweeper) | At startup + every hour: removes task directories idle **beyond the TTL** |

The Team Lead never deletes task directories — finished boards stay
readable so you can audit how a run went, and reclamation is pure code
that never relies on the model remembering to do anything (crashes and
force-kills leave nothing behind either). The sweeper prunes stale task
dirs individually under a still-live session, and reclaims an entirely
idle session folder in one pass. Set `ttlDays` to taste.

### Configure the TTL

Default is **5 days**. To choose your own, use the tuple plugin form in
`opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["@te-river/opencode-team-mode@latest", { "ttlDays": 7 }]
  ]
}
```

`ttlDays` accepts any number of days in `(0, 365]`; invalid values silently
fall back to 5.

### Default agent

By default TeamMode **does not** touch the default agent — new chats start
on the built-in `build` as before.  This is a deliberate ordering trade-off:
the switcher pins the default agent to the **first slot** and sorts
everything else alphabetically, so "Team pinned as default (first)" and
"Team shown after Plan" are mutually exclusive.  Leaving the default slot
alone gives you the picker order **build, plan, team**.

To promote Team as the default agent anyway (new chats start with the team
orchestrator, and Team is pinned first — order becomes **team, build,
plan**):

```jsonc
{
  "plugin": [
    ["@te-river/opencode-team-mode@latest", { "defaultAgent": true }]
  ]
}
```

An explicitly configured non-`build` `default_agent` in your own config is
always respected untouched, even with `defaultAgent: true`.

**Upgrade note:** since v1.4.4 the plugin no longer claims the default-agent
slot by default.  If you relied on Team being your default agent before
(v1.4.2+), add `{ "defaultAgent": true }` to your plugin options.

---

## 🔧 Customization

### The Team Lead's model matters most

The Lead is the orchestrating brain: it classifies every message, cuts the
work into packages, writes each dispatch manifest, judges reviewer/tester
findings, and synthesizes the final deliverable. Quality failures there
**multiply down the pipeline** — a mediocre Lead mis-decomposes, briefs the
experts vaguely, and waves weak work through; no specialist can rescue an
assignment it was never correctly given.

So run the strongest model you can afford **in the Lead seat**. The other
roles tolerate cheaper models — they work from tight briefs with scoped
reading. Pin models per agent:

```jsonc
{
  "agent": {
    // Team Lead — orchestration earns your best model
    "team": { "model": "anthropic/claude-opus-4-5" },
    // specialists — cheaper models are usually fine
    "implementer": { "model": "anthropic/claude-sonnet-4-6" }
  }
}
```

(Model IDs above are placeholders — use whatever your provider exposes.
Your own `agent.team` definition always takes precedence over the plugin's.)

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
