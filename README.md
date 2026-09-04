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
| 🔍 **Reviewer** | Dimension-focused auditor | Single-dimension review (completeness / correctness / impact) — the lead runs 3 in parallel |
| 🧪 **Tester** | Test engineer | Unit tests, integration tests, edge-case coverage, static verification (build / typecheck / lint / API tests) |
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

A session transcript, recreated from how the flow actually looks. Team is the
default agent out of the box (see Configuration to opt out), so the user just
types into a fresh chat:

> **User:** Add token-bucket rate limiting to our Express API — 100 requests
> per minute per user, return 429 when exceeded. Don't touch anything under
> `src/legacy/`.

```text
team   Route: product behavior change → implementer → tester → reviewer
       (3 dispatches → approval gate applies)

       Research: read README, src/app.ts, src/middleware/*
       Blocking questions: none — 1 assumption listed below

       PLAN
       Goal: token-bucket limiter, 100 req/min/user, 429 + Retry-After
       Scope: src/middleware/rateLimit.ts (new), src/app.ts (+3 lines)
       Pipeline: implementer → tester → reviewer (correctness)
       Assumption: in-memory bucket, not Redis — say the word to change
       Boundary: src/legacy/** untouched
       Approve to proceed?

user   approved, go

team   ▸ @implementer — STATUS: done
       CHANGES: src/middleware/rateLimit.ts (new) · src/app.ts (+3)
       HANDOFF: bucket {tokens, lastRefill}; refill() is a single atomic pass
       EVIDENCE: tsc clean (output above)

       ▸ @tester — STATUS: done · VERDICT: pass (14/14)
       FINDINGS: burst edge, window expiry, concurrent refill covered;
                 src/legacy/** byte-identical
       EVIDENCE: vitest 14 passed

       ▸ @reviewer — STATUS: done · VERDICT: approve (correctness)
       FINDINGS: no Critical/Major; 1 Minor (log line noise) noted

team   Done.
       rate limiter shipped: rateLimit.ts (new) · app.ts (+3) · 14 tests green
       review: approve · assumption: in-memory only · src/legacy/ untouched
```

The only message the user typed was the task and "approved, go". The
pipeline was a routing-table lookup, execution waited for plan approval,
and every handoff traveled as a structured skeleton — no file ceremony.

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

## 🗂️ Coordination: structured handoffs first, files second (hybrid)

Sub-agents cannot message each other live (platform limitation), so TeamMode
coordinates them through a **structured reply skeleton**, with a file
blackboard reserved for oversized output:

- **Reply skeleton (primary channel):** every specialist's final reply starts
  with `STATUS: / CHANGES: / FINDINGS: / EVIDENCE: / HANDOFF:` and stays ≤50
  lines. Deliverables at that size travel inline — zero file I/O, nothing to
  fall out of sync. The lead relays `HANDOFF` verbatim into the next
  dispatch and machine-checks the skeleton (missing → one retry with it
  inline, then downgrade and note the violation).
- **Board files (exception only):** when a full deliverable exceeds ~50 lines
  (e.g. a complete architecture doc), the dispatch names ONE file:
  `<repo>/.git/opencode-team/<session-key>/<task-slug>/NN-<role>-<topic>.md`
  — inside `.git/`, so your working tree and commits are **never polluted**
  (non-git workspaces fall back to the OS temp dir). Writes are frozen: a
  revision is a new round-suffixed file (`…-r2.md`); session folders keep a
  fresh conversation from touching a not-yet-swept board.
- **No MANIFEST.md:** the lead's state memory is its todo list.
- **Feedback loop:** Critical/Major findings and product bugs automatically
  become tracked fix tasks until the deliverable converges (max 2 loops,
  then escalate to you).

### Deterministic routing, approval gate & adaptive review (v1.4.7)

- **Routing table:** the lead picks a fixed pipeline row by task shape —
  question → direct answer; docs-only → implementer; product behavior
  change → implementer → tester → reviewer; multi-module feature →
  architect → implementer → tester → reviewer(s); unknown external tech →
  researcher first. Pipelines have fixed minimums: a product change routed
  below 3 dispatches is a routing bug, and splitting one request into
  sub-2-dispatch pieces to dodge the gate is a protocol violation.
- **Approval gate (count-based):** ≥2 planned dispatches → the lead
  researches (reading the repo itself; a researcher dispatch only for
  unknown external tech), presents a ≤30-line plan, and **waits for your
  approval** before executing anything. 0-1 dispatches run with a 1-2 line
  notice. A task that grows a second dispatch mid-run pauses for approval.
  Blocking uncertainties are batched and asked immediately — never guessed,
  never drip-fed.
- **Adaptive review:** default is ONE reviewer dispatch (correctness);
  three parallel dimensions (completeness / correctness / impact) only for
  high-risk profiles — auth/security surface, cross-module data contracts,
  public APIs across ≥3 files.
- **Static verification:** testers verify via build, typecheck, static
  analysis, and API/unit tests. Improvised browser automation (headless
  screenshots, DOM stubs) is banned; user-visible frontend changes end with
  `UI NOT VERIFIED: <what needs manual checking>` unless the project
  already ships real browser-test tooling.
- **No-ceremony fast path:** a root cause the lead has already verified
  (file:line evidence) goes straight to the implementer as a fix spec —
  investigation dispatches serve unknowns, not ritual.
- **Brevity discipline:** route selection is a table lookup; user-visible
  planning text stays ≤5 lines.
- **Evidence standard (kept):** "done / fixed / passed" claims need
  verifiable evidence — command output, logs, diffs. Narratives are
  progress notes, not proof.
- **Verbatim contracts (kept):** parallel implementers that must
  interoperate get the exact data contract (endpoints, field names, types)
  pasted verbatim into every affected dispatch.
- **Docs sync (CHANGELOG + AGENTS.md):** delivered changes append a
  CHANGELOG.md entry when one exists, and update AGENTS.md when the change
  alters what it records (build/test commands, conventions, structure,
  agent instructions); either file is offered for creation when missing.
  Reading is deduplicated: the lead reads the README itself (the host does
  not inject it), uses the host-injected AGENTS.md/CLAUDE.md copy already
  in context and opens those files only when genuinely absent — and
  specialists never re-open these docs, since conventions arrive
  distilled inside their dispatches.

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

By default TeamMode **makes Team your default agent** — new chats open
directly in the team orchestrator. One side effect comes with the default
slot: the switcher pins the default agent to the **first position** and
sorts everything else alphabetically, so the picker order is
**team, build, plan**. (Want Team below Plan instead? That requires
giving up the default slot — see the opt-out below; the two are
mutually exclusive by the server's sort.)

To opt out (`build` stays the default, picker order **build, plan,
team**):

```jsonc
{
  "plugin": [
    ["@te-river/opencode-team-mode@latest", { "defaultAgent": false }]
  ]
}
```

An explicitly configured non-`build` `default_agent` in your own config is
always respected untouched — the plugin never clobbers it.

**Upgrade note:** v1.4.4 briefly made this promotion opt-in; v1.4.5 restores
Team-as-default as the shipped behavior. If you pinned `{ "defaultAgent":
true }` during v1.4.4, you can drop that option (or switch it to `false` to
opt out).

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
