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
| 🔍 **Reviewer** | Dimension-focused auditor | Single-dimension review (completeness / correctness / impact) — ONE reviewer by default; 3 in parallel only for high-risk changes |
| 🧪 **Tester** | Test engineer | Unit tests, integration tests, edge-case coverage, static verification (build / typecheck / lint / API tests) |
| 🔎 **Researcher** | Knowledge finder | Local-repo investigation first (code, configs, installed packages, shipped docs); web lookups via user MCP tools or the governed `tm_webfetch` — one of the two network roles (with the Team Lead) |

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

**Option A — One-line installer:**

macOS / Linux (bash):
```bash
curl -fsSL https://ghproxy.net/https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/scripts/install.sh | bash
```

Windows (PowerShell):
```powershell
irm https://ghproxy.net/https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/scripts/install.ps1 | iex
```

**Option B — Manual config:**

Add the plugin to your `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@te-river/opencode-team-mode@latest"
  ]
}
```

OpenCode will automatically install the plugin on startup.

> ⚠️ **Plugin updates are manual.** OpenCode caches plugins by spec string
> (`~/.cache/opencode/packages/<name>@latest`) and does NOT re-resolve
> `@latest` when a new version publishes (known upstream limitation).
> To update: delete the cached package dir and restart, or pin an
> explicit version in your config. If you also npm-installed the plugin
> into `~/.config/opencode`, remember its package-lock pins too.

> **Tip:** After modifying `opencode.json`, **restart OpenCode Desktop** for changes to take effect.

---

## ⚙️ Configuration

The plugin automatically injects all team agents and commands when OpenCode starts. **No need to manually copy agent files or command definitions.**

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
| `/team-research <topic>` | Researcher | Investigate the local repository first; web lookups via the governed `tm_browser` / `tm_webfetch`, then user MCP tools |
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

## 🧰 Governed tools & security

Every tool TeamMode adds runs under ONE governance pipeline: outputs above
`TM_OFFLOAD_THRESHOLD` tokens never enter the context window — they are
offloaded to a run store and replaced by a content-aware preview plus an
HMAC-signed handle that the agent pages through with `tm_fetch` when it
genuinely needs the payload. Security, memory and web access shipped
across v1.5.1–v1.5.6; see [CHANGELOG.md](./CHANGELOG.md) for the history.

| Tool | What it does | Roles |
|---|---|---|
| `tm_read` / `tm_grep` / `tm_bash` / `tm_fetch` | Governed file read / regex search (host index) / read-only shell (allowlist) / paged handle retrieval | all six agents |
| `tm_memory` | Project memory store (Markdown + frontmatter): add / search / list / forget | all six agents |
| `tm_webfetch` | Single governed GET of an allowlisted web page | Lead + Researcher |
| `tm_browser` | Interactive browser session (headful CDP): open / navigate / read / screenshot / close | Lead + Researcher |
| `tm_ptc_run` | Batch orchestration: one program, N governed calls, zero LLM round-trips | all six agents |

> **Fixed tool priority ladder (every task): ① TeamMode governed tools
> (`tm_*`) → ② user MCP/plugin tools → ③ the model's own reasoning
> (a missing capability is reported as a gap, never fabricated).**  The
> ladder is also a fallback chain: when a governed tool errors (no browser
> on this host, blocked host), the agent says so and drops to the next
> rung instead of giving up.

Agents are prompted to route every lookup through these tools — scan the
tool surface, plan the concrete call, expand colloquial or abbreviated
terms to canonical forms and search both spellings — instead of answering
from memory or simulating removed tools.

### Context governance: offload, handles, previews

**JIT layer-2 tools (`tm_read` / `tm_grep` / `tm_bash` / `tm_fetch`).**
Large tool outputs are context cost's main driver: every step re-sends the
whole window. The tm_* tools run the built-in capability under governance
first: results above `TM_OFFLOAD_THRESHOLD` tokens never enter the window —
they are written to a local run store and replaced by a handle with a
content-aware preview (JSON keys / CSV header+shape / log ERROR×N stats /
code signatures / binary metadata, hard-capped at 80 tokens). When the agent
actually needs the payload it pages through it with `tm_fetch`, using an
HMAC-signed, run-scoped, expiring handle. `tm_bash` only allows read-only
commands (allowlist), and failures come back as structured errors instead of
raw dumps. Agents are prompted to route every lookup through these tools —
scan the tool surface, plan the concrete call, expand colloquial or
abbreviated terms to canonical forms and search both spellings — instead of
answering from memory or simulating removed tools.

### Project memory (tm_memory)

**Project memory (`tm_memory`) — all agents.**  Durable facts (build
commands, environment quirks, architecture decisions, user conventions
that outlive one conversation) live as Markdown files with frontmatter in
two scopes — human-editable, never in your working tree:
- **`project`** (default): `<repo>/.git/opencode-team/memories/<project-slug>/<category>/` — per checkout, git-adjacent.
- **`global`**: `~/.opencode-team/memories/` (override
  `TM_MEMORY_GLOBAL_DIR`) — **follows you across ALL projects**; use it
  for personal preferences and cross-project conventions.
Actions: `add` / `search` (deterministic keyword scoring, top 5) /
`list` / `forget`; content is capped at 4000 chars per memory — task
state belongs to the todo list, oversized docs to board files.  Agents
are prompted to search before assuming project conventions and to save
hard-won facts for the next conversation.

### Web access (tm_browser + tm_webfetch) — network roles only

1. **Governed web tools.**  `tm_browser` — an interactive browser session
   driving **your own Chromium-family browser** (Edge probed first on
   Windows) headful via the CDP pipe protocol: open → navigate → read
   (page text, threshold-governed like tm_read) → screenshot (PNG saved
   to the run store, only the path enters context) → close.  Isolated
   temp profile (never your real one); the **domain allowlist is enforced
   at the network layer** per request (CDP `Fetch.requestPaused` —
   non-allowlisted hosts get `BlockedByClient`).  Display-less Linux
   hosts run headless automatically; `TM_BROWSER_HEADLESS` forces either
   way, `TM_BROWSER_PATH` points at a specific executable.  `tm_webfetch`
   — a single governed GET of an allowlisted page.  Both ride the same
   governance as every tm_* tool (threshold offload + content-aware
   preview + `tm_fetch` handle), so a web page can never flood the
   context.
2. **User MCP/plugin tools.**  Browser automation, search or fetch tools
   from user-configured MCP servers are the fallback for what the
   governed tools cannot do — the whitelist never touches them.
3. The other four agents (architect / implementer / reviewer / tester)
   have NO network grant — web questions are reported as a gap, never
   simulated.  The built-in webfetch/websearch tools stay removed; remote
   `.env`-style URLs are refused (R6 red line).

Seeded allowlist hosts (both web tools): `mobile.moegirl.org.cn` (wiki
term), `search.bilibili.com`, `cn.bing.com`, `www.baidu.com` (search URL
templates); extend via `TM_WEBFETCH_ALLOWED_DOMAINS` (`"*"` opens every
host).

Seeded allowlist hosts (both web tools): `mobile.moegirl.org.cn` (wiki
term), `search.bilibili.com`, `cn.bing.com`, `www.baidu.com` (search URL
templates); extend via `TM_WEBFETCH_ALLOWED_DOMAINS` (`"*"` opens every
host).

### Security: R6 + R2 approval gate

**R6 environment protection (now an approval gate).** With TeamMode active,
the model cannot read environment variables silently. Env-var reads
(`printenv`, `env`, `Get-ChildItem env:`, …) and env files (`.env`, shell rc
files) route through OpenCode's **official confirmation dialog**: you get a
native prompt to approve or deny, and an unanswered prompt is **auto-rejected
after `TM_ASK_TIMEOUT_MIN` (default 10 min)** — the plugin only ever rejects
on timeout, never approves on the model's behalf. Env reads that no wildcard
can express (embedded `$VAR` / `${VAR}` / `$env:` inside another command,
command substitution, subshell/escaped forms) and the `tm_*` wrapper channel
stay a **hard block** (no dialog to slip through). tm_* wrappers route through
the same checks (no backdoor via the wrappers). Audit lines record only tool
name + pattern category + the verdict (`ask` / `allowed-once` /
`allowed-always` / `rejected` / `timeout-rejected` / `degraded`) — never
command text, paths, variable names or values.

**R2 dangerous operations (same dialog).** Delete (`rm`/`del`/`Remove-Item`/
`rmdir`), git publishing (`git push`/`git commit`), network fetch (`curl`/
`wget`/`Invoke-WebRequest`/`Invoke-RestMethod`), package installs/publishes
(`npm install`/`npm publish`/`pip install`/`winget`/`choco`), process/system
(`taskkill`/`Stop-Process`/`kill`/`shutdown`/`format`) and privilege changes
(`chmod`/`takeown`/`icacls`) — none are silently allowed. They pop the same
official dialog and are auto-rejected if you don't answer within the timeout.
The normal verification stack (`npm test`, `tsc`, `git status`/`diff`) is NOT
gated, so day-to-day team work runs without interruption.

> ⚠️ **When you approve a dialog, pick "once" — not "always".** Verified on
> the live host, "always" records a far broader rule than the command you
> saw: approving `Get-ChildItem env:PATH` with "always" stores `Get-ChildItem
> *`, so every later `Get-ChildItem` runs with no dialog at all. Only the
> once-verdict keeps each gated operation individually human-checked.
> (If you do pick "always" on an env dialog, TeamMode scopes it to the
> current session — and env-FILE reads such as `cat .env` stay hard-blocked
> regardless: no dialog ever backs them, so no "always" can consent to them.)

> Deferral is per-session: env reads only route to the dialog in sessions
> running TeamMode's injected agents (or after such a session has shown one
> of these dialogs). In any other session (e.g. a stock `build`/`plan` chat)
> TeamMode's guard keeps hard-blocking env reads, since no dialog would back
> them there. Within one session, a user prompt routed to a non-injected
> agent REVOKES that eligibility (the per-turn agent signal rides
> `message.updated`; the verified host passes NO agent to
> `tool.execute.before`). Compound commands (`a; b`) are evaluated per segment by the
> host and approved through one dialog; the guard blocks them outright
> whenever any segment is an env read.

> The permission protocol was verified against a live `opencode serve` host
> (1.18.29) via SSE event capture; the Desktop dialog rendering itself is the
> one leg that still needs eyeballing in a real Desktop session. Headless
> `opencode run` auto-rejects an unanswered `ask` immediately (there is no
> human to prompt).

### Repo hygiene & path semantics

> **Repo hygiene.** The offload/trajectory stores live under
> `<repo>/.git/opencode-team/` (or the OS temp dir outside a git repo) —
> never your working tree. Every agent is instructed to delete scratch /
> temporary files it created before reporting done, and to keep throwaway
> work in the OS temp dir so nothing lands in the repo at all. `tm_read` /
> `tm_grep` paths are relative to the **project root** (not the agent's
> working directory).

### Environment variables

| Env var | Default | Purpose |
|---|---|---|
| `TM_ENV_PROTECT` | `strict` | R6 mode: `strict` / `standard` / `off` (off also disarms the approval timer) |
| `TM_ASK_TIMEOUT_MIN` | `10` | minutes before an unanswered R6/R2 confirmation dialog is auto-rejected; minimum 3 minutes (the host's `permission.replied` reaches the plugin ~120 s late on the event bus — shorter values would auto-reject a just-approved request) |
| `TM_ENV_PROTECT_EXTRA_DENY` | — | extra block patterns (regex list; always a hard block, never dialog-governed) |
| `TM_OFFLOAD_THRESHOLD` | `2000` | offload threshold (tokens, CJK-aware estimate) |
| `TM_PREVIEW_MAX_TOKENS` | `80` | preview hard cap |
| `TM_FETCH_MAX_LINES` | `2000` | tm_fetch page cap |
| `TM_BLACKBOARD_DIR` | `<repo>/.git/opencode-team/blackboard/` | offloaded payload store (tmpdir fallback outside a git repo; explicit value = absolute or project-relative) |
| `TM_TRAJECTORY_DIR` | `<repo>/.git/opencode-team/trajectory/` | append-only tool-call ledger (tmpdir fallback outside a git repo) |
| `TM_BLACKBOARD_TTL` | `7` | store retention (days) |
| `TM_BASH_READONLY_ALLOWED` | built-in table | tm_bash allowlist |
| `TM_WEBFETCH_ALLOWED_DOMAINS` | `mobile.moegirl.org.cn, search.bilibili.com, cn.bing.com, www.baidu.com` | tm_webfetch/tm_browser allowlist (`"*"` opens every host; explicit empty = deny all) |
| `TM_BROWSER_PATH` | auto-detect | tm_browser executable override (Edge/Chrome/Chromium probed per OS) |
| `TM_BROWSER_HEADLESS` | `auto` | tm_browser: `1` headless (servers/CI) / `0` headful / `auto` (headless only on display-less Linux) |
| `TM_MEMORY_GLOBAL_DIR` | `~/.opencode-team/memories/global/` | tm_memory GLOBAL scope store (user-level, cross-project) |
| `TM_PTC_MAX_PROGRAM_CHARS` | `4000` | PTC program source length cap (chars) |
| `TM_PTC_MAX_CALLS` | `20` | PTC per-run bridge-call budget (1–200) |
| `TM_PTC_MAX_ERRORS` | `3` | PTC per-run error budget (1–50) |
| `TM_PTC_TIMEOUT_MS` | `60000` | PTC per-run wall-clock timeout (5s–10min) |
| `TM_PTC_ENGINE` | `auto` | PTC engine: `auto` (worker→inline degrade) / `worker` / `inline` |

### Batch orchestration (tm_ptc_run)

`tm_ptc_run` lets a specialist agent write **one async program** that makes N
governed `tm_*` calls in a single turn — zero LLM round-trips during the run,
only an aggregation summary returns to context.  It is designed for batch
read-only tasks: multi-file reconnaissance, bulk grep + read aggregation,
cross-referencing search results.

#### How it works

The agent writes a program body using `tm.read(args)`, `tm.grep(args)`,
`tm.bash(args)`, `tm.fetch(args)` — same args as the four governed tools.
Each call returns `{ok:true, data}` (governed: inline text or an offload
handle) or `{ok:false, error:{tool,phase,line?,message}}`.  The program
`return`s a value; it is JSON-serialized into the aggregation summary.

Programs containing `require`, `import`, `process`, `globalThis`, `Deno`,
`Bun`, `fs`, `net`, or `child_process` are rejected before execution (static
pre-scan, auxiliary guard).

#### Budgets (tighten-only)

The caller may tighten `max_calls`, `max_errors`, and `timeout_ms` — values
above the `TM_PTC_*` ceilings are clamped down; values below the floor are
clamped up.  Hitting any budget stops the whole run; produced output is NOT
lost.

#### Engine (`TM_PTC_ENGINE`)

| Mode | Behavior |
|---|---|
| `auto` (default) | Tries `worker_threads` first; on engine failure it re-runs the WHOLE program on `node:vm` with a `degraded-engine` mark in the summary (bridged calls are read-only, so a re-run is safe; the fallback starts with fresh budgets under the same wall-clock deadline) |
| `worker` | Forces the worker engine (engine-error on failure) |
| `inline` | Forces the `node:vm` engine (script timeout kills pre-await synchronous busy-loops; a busy loop after the first `await` blocks the host event loop irrecoverably — prefer worker/auto) |

The worker engine runs the program in a dedicated thread with `env:{}`
(process.env emptied), `resourceLimits`, and hard wall-clock `terminate()`.
All governance (P2 path scope, P3 allowlist, R6, threshold offload, TTL)
applies to every bridged call — PTC is not a bypass layer.

#### Access

`tm_ptc_run` is in the whitelist of **all six** agents (the `team` lead
included — v1.5.4 revised the original deny ruling).  Every bridged call
still runs the full governed tm_* pipeline (P2 path scope, P3 allowlist, R6,
threshold offload + handles, TTL), so batch orchestration is a convenience
gain, not a governance gap.

---

## 🏗️ Architecture

```
opencode-team-mode/
├── package.json          ← npm package definition
├── tsconfig.json         ← TypeScript config
├── src/
│   ├── index.ts          ← Plugin entry (server(): config + R6 tool.execute.before + approval-gate event + tool segment)
│   ├── agents.ts         ← Agent structure (modes, colors, temperatures, whitelist matrix)
│   ├── prompts/          ← The agent prompt strings (lead / specialists / shared) — pinned by tests
│   ├── commands.ts       ← Command definitions (templates, agent bindings)
│   ├── blackboard.ts     ← Shared blackboard + TTL auto-cleanup sweeper
│   ├── envprotect.ts     ← R6 facade → envprotect/ (patterns / bash-classify / path-classify / gate-predicates / hook)
│   ├── approval-gate.ts  ← Unified approval gate: host-dialog timeout auto-reject (never self-allows)
│   ├── tm/               ← JIT layer-2 tools: pipelines / result / client-unwrap / shell-bridge / args-schema / tools / guard / preview / store / refs / config / webfetch / memory / browser / ptc/ (9 modules)
│   └── types.ts          ← Loader-contract type definitions (1.18.x)
├── scripts/
│   ├── install.sh        ← One-click installer (bash)
│   └── install.ps1       ← One-click installer (PowerShell)
├── pt07/                 ← PT-07 baseline suite (seeded A/B token measurement)
├── LICENSE               ← Apache 2.0
├── README.md             ← English documentation
└── README.zh-CN.md       ← Chinese documentation
```

### How it works

1. OpenCode Desktop starts and loads `opencode.json(c)`.
2. It sees `"@te-river/opencode-team-mode@latest"` in the `plugin` array and loads the npm package.
3. The loader calls the plugin's `server(input, options)`, which registers a `config` hook; the hook injects 6 agents and 6 commands into the merged config. The same call installs the R6 `tool.execute.before` guard, arms the unified R6/R2 approval gate (official dialog + `TM_ASK_TIMEOUT_MIN` auto-reject, wired through an `event` hook), and registers the governed `tm_*` tools (see [Governed tools & security](#-governed-tools--security) below).
4. The plugin's `id: "team-mode"` is displayed as the plugin name in the Desktop UI.
5. Agents and commands are immediately available in the Desktop UI — no file copying needed. User-defined agents with the same name always win (the plugin never clobbers them).

---

## 🤖 How the team works

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

### Deterministic routing, approval gate & adaptive review

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
