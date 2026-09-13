# OpenCode TeamMode

**[English](./README.md)** | **[中文](./README.zh-CN.md)**

[![npm version](https://img.shields.io/npm/v/@te-river/opencode-team-mode.svg)](https://www.npmjs.com/package/@te-river/opencode-team-mode)
[![npm downloads](https://img.shields.io/npm/dm/@te-river/opencode-team-mode.svg)](https://www.npmjs.com/package/@te-river/opencode-team-mode)
[![license](https://img.shields.io/npm/l/@te-river/opencode-team-mode.svg)](./LICENSE)

> 🤝 **Your OpenCode just hired a team.**
>
> Six specialized agents — a Lead, an Architect, an Implementer, a Reviewer, a Tester and a Researcher — with governed tools, structured handoffs, and a plan-first approval gate. One plugin, zero config files to copy.

---

## TL;DR — skip the docs

> **The lazy path:** paste this to any coding agent and let it do the work:
>
> ```text
> Install the OpenCode plugin @te-river/opencode-team-mode following
> https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/docs/installation.md
> Then verify the install using the checks in that guide.
> ```
>
> **The one command to remember afterwards:** `/team-run <task>` — the Team Lead
> plans it, shows you the plan, waits for your approval, then runs the whole team.

Everything else below is detail. When you're ready for it, here's the map:

**[Why](#-why-teammode) · [The team](#-the-team) · [Install](#-install) · [Usage](#-usage) · [Tools & security](#-governed-tools--security) · [Search](#-web-search-that-actually-works-in-china) · [Config](#️-configuration) · [How it works](#-how-the-team-works) · [FAQ](#-faq) · [Uninstall](#-uninstall)**

---

## 🤔 Why TeamMode?

Because a single agent doing everything is how you get: a context window stuffed
with 5000-line file dumps, twenty round-trips to `bash` for what one script could
do, sub-agents that silently read `.env`, and web "research" that is really just
the model's imagination.

TeamMode's answer to each:

| Pain | TeamMode's answer |
|---|---|
| 🔥 **Context flooding** | Every governed tool output over 2000 tokens is offloaded to a local run store and replaced by an 80-token preview + an HMAC handle. The agent pages through what it needs — the window never drowns. |
| 🐌 **Round-trip overhead** | `tm_ptc_run`: the agent writes ONE program that makes N governed calls in a single turn. Zero LLM round-trips during the run. |
| 🕳️ **Silent side effects** | R6/R2 approval gate: env-var reads and dangerous ops route through OpenCode's official confirmation dialog, auto-rejected after 10 unanswered minutes. The plugin never approves on its own — it only ever rejects. |
| 🌫️ **Hallucinated research** | Web access is a two-role grant with an allowlisted, governed tool chain. A fact that couldn't be fetched is reported as a gap — never fabricated. |

And the workflow discipline underneath: deterministic routing, a ≤30-line plan
you approve before ≥2 dispatches execute, structured `STATUS/CHANGES/FINDINGS/
EVIDENCE/HANDOFF` replies between agents, and static verification (build /
typecheck / tests) instead of vibes.

---

## 👥 The team

| Agent | Role | When to use |
|---|---|---|
| 🎯 **Team Lead** (`@team`) | Orchestrator | Complex tasks that need planning + multi-step execution |
| 🏗️ **Architect** | System designer | Design docs, module structure, API contracts |
| 💻 **Implementer** | Code writer | Building features, writing production code |
| 🔍 **Reviewer** | Dimension-focused auditor | Single-dimension review by default; 3 in parallel only for high-risk changes |
| 🧪 **Tester** | Test engineer | Tests with real edge cases; static verification (build / typecheck / lint) |
| 🔎 **Researcher** | Knowledge finder | Local repo first, then the web — one of the two network roles (with the Lead) |

Out of the box, **Team is your default agent** — new chats open straight into the
orchestrator (opt-out in [Configuration](#-configuration)).

---

## 📦 Install

### Option 1 — Let your agent do it (recommended)

Copy this into any coding agent — it will edit your config, restart-remind you, and verify:

```text
Install the OpenCode plugin @te-river/opencode-team-mode following
https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/docs/installation.md
Then verify the install using the checks in that guide.
```

(The guide is the complete manual procedure — config file locations, plugin
entry, restart, verification, update and uninstall. Your agent reads it and
executes it faithfully; there is nothing else it needs.)

### Option 2 — One-line script

macOS / Linux (bash):

```bash
curl -fsSL https://ghproxy.net/https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/scripts/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://ghproxy.net/https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/scripts/install.ps1 | iex
```

### Option 3 — Manual

Add the plugin to your `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@te-river/opencode-team-mode@latest"
  ]
}
```

OpenCode installs the plugin on next startup.

### ⚠️ Read this once, save yourself an hour later

- **Restart to activate.** After touching `opencode.json`, fully quit and restart OpenCode (Desktop: quit from tray, not just the window).
- **Plugin updates are manual.** OpenCode caches plugins by spec string and does NOT re-resolve `@latest` when a new version publishes (upstream limitation). To update: delete the cache dir and restart —

  | OS | Cache location |
  |---|---|
  | macOS / Linux | `rm -rf ~/.cache/opencode/packages/@te_river+opencode-team-mode@latest` |
  | Windows | `Remove-Item -Recurse -Force "$env:LOCALAPPDATA\opencode\cache\packages\@te_river+opencode-team-mode@latest"` |

  If you also npm-installed the plugin into `~/.config/opencode`, its package-lock pins the version — run `npm install @te-river/opencode-team-mode@latest` there too. Full recipe: [installation guide, Updating](./docs/installation.md).
- **Prerequisites:** [OpenCode](https://opencode.ai) (Desktop or CLI) and Node ≥ 18.

### Verify

Restart, open the agent picker, and look for **team, architect, implementer,
reviewer, tester, researcher**. That's it — the team is hired.

---

## 📖 Usage

### Slash commands

| Command | Agent | Description |
|---|---|---|
| `/team-plan <task>` | Architect | Implementation plan with architecture, file manifest, task breakdown |
| `/team-implement <task>` | Implementer | Production code for a feature or task |
| `/team-review [scope]` | Reviewer | Audit for bugs, security issues, quality problems |
| `/team-test [scope]` | Tester | Comprehensive tests with edge-case coverage |
| `/team-research <topic>` | Researcher | Local repo first; web via the governed tools |
| `/team-run <task>` | Team Lead | **The full workflow** — plan → approval → orchestration → verification |

Or `@`-mention agents directly: `@team`, `@architect`, `@implementer`,
`@reviewer`, `@tester`, `@researcher`.

### What a run feels like

Team is the default agent out of the box, so you just type into a fresh chat:

> **You:** Add token-bucket rate limiting to our Express API — 100 requests per minute per user, return 429 when exceeded. Don't touch anything under `src/legacy/`.

```text
team   Route: product behavior change → implementer → tester → reviewer
       (3 dispatches → approval gate applies)

       PLAN
       Goal: token-bucket limiter, 100 req/min/user, 429 + Retry-After
       Scope: src/middleware/rateLimit.ts (new), src/app.ts (+3 lines)
       Pipeline: implementer → tester → reviewer (correctness)
       Assumption: in-memory bucket, not Redis — say the word to change
       Boundary: src/legacy/** untouched
       Approve to proceed?

you    approved, go

team   ▸ @implementer — STATUS: done
       CHANGES: src/middleware/rateLimit.ts (new) · src/app.ts (+3)
       EVIDENCE: tsc clean

       ▸ @tester — STATUS: done · VERDICT: pass (14/14)
       FINDINGS: burst edge, window expiry, concurrent refill covered;
                 src/legacy/** byte-identical

       ▸ @reviewer — STATUS: done · VERDICT: approve (correctness)

team   Done. rateLimit.ts (new) · app.ts (+3) · 14 tests green
       review: approve · assumption: in-memory only · src/legacy/ untouched
```

You typed the task and four words. The plan was a routing-table lookup,
execution waited for your approval, and every handoff between agents traveled
as a structured skeleton — nothing landed in your repo, nothing was guessed.

---

## 🧰 Governed tools & security

Every tool TeamMode adds runs under ONE governance pipeline: outputs above
`TM_OFFLOAD_THRESHOLD` tokens never enter the context window — they are
offloaded to a run store and replaced by a content-aware preview plus an
HMAC-signed handle that the agent pages through with `tm_fetch` when it
genuinely needs the payload.

| Tool | What it does | Roles |
|---|---|---|
| `tm_read` / `tm_grep` / `tm_bash` / `tm_fetch` | Governed file read / regex search / read-only shell (allowlist) / paged handle retrieval | all six agents |
| `tm_memory` | Project + global memory store (Markdown + frontmatter): add / search / list / forget | all six agents |
| `tm_ptc_run` | Batch orchestration: one program, N governed calls, zero LLM round-trips | all six agents |
| `tm_search` | Multi-engine web search with extracted, deduplicated hit lists | Lead + Researcher |
| `tm_webfetch` | Single governed GET of an allowlisted page (search pages auto-extracted) | Lead + Researcher |
| `tm_browser` | Interactive browser session (headful CDP): open / navigate / read / screenshot / close | Lead + Researcher |

> **Fixed tool priority ladder (every task): ① TeamMode governed tools
> (`tm_*`) → ② user MCP/plugin tools → ③ the model's own reasoning.**
> It doubles as the fallback chain: when a governed tool errors (no browser
> on this host, blocked host), the agent says so and drops to the next rung.

All governed tools are **parallel-safe**: the host may run a batch of
`tm_search` / `tm_webfetch` / `tm_fetch` calls concurrently — each call gets
its own step id and its own payload, and nothing cross-contaminates
(proven by the parallel test suite).

### Context governance: offload, handles, previews

Large tool outputs are context cost's main driver — every step re-sends the
whole window. So results above `TM_OFFLOAD_THRESHOLD` tokens are written to a
local run store (`<repo>/.git/opencode-team/`, never your working tree) and
replaced by a handle with a content-aware preview: JSON keys / CSV header +
shape / log ERROR×N stats / code signatures / binary metadata, hard-capped at
80 tokens. When the agent actually needs the payload, it pages through with
`tm_fetch` using an HMAC-signed, run-scoped, expiring handle. `tm_bash` only
allows read-only commands (allowlist), and failures come back as structured
errors instead of raw dumps.

### Project + global memory (tm_memory)

Durable facts — build commands, environment quirks, architecture decisions,
your conventions — live as human-editable Markdown with frontmatter:

- **`project`** (default): `<repo>/.git/opencode-team/memories/…` — per checkout, git-adjacent.
- **`global`**: `~/.opencode-team/memories/global/` (override `TM_MEMORY_GLOBAL_DIR`) — **follows you across ALL projects**.

Actions: `add` / `search` (deterministic keyword scoring) / `list` / `forget`;
4000 chars per memory. Agents are prompted to search before assuming
conventions and to save hard-won facts for the next conversation.

### 🌐 Web search that actually works (in China)

`tm_search` is the open-ended-lookup front: **one call, one query, clean
results**. The engine URL is built for you, fetched through the governed
pipeline, and collapsed into a numbered title+URL hit list — the agent never
sees raw SERP chrome.

| Engine | Notes |
|---|---|
| `bing` (default) | cn.bing.com; `bing-int` forces international results (`ensearch=1`) |
| `sogou` / `so` (360) | CN-native engines, good for CJK content |
| `baidu` | flakiest (anti-bot) but sometimes the only CN-specific index; failures name alternatives |
| `bilibili` | video search |
| `npm` | registry search → name@version + description, structured |
| `github` | repo search API → stars + description, structured |

All eight engines are reachable from mainland China **without API keys**, and
every one of them sits on the seeded domain allowlist. On an empty result
(an anti-bot shell), the error names the alternative engines instead of
leaving the agent stuck. Two more channels complete the surface:

- `tm_webfetch` — a known URL, one governed GET. Search-engine pages it
  fetches are auto-extracted to hit lists too. JSON endpoints like
  `registry.npmjs.org/<pkg>/latest` pass through untouched.
- `tm_browser` — JS-rendered pages: your own Chromium-family browser, headful
  via CDP pipe, isolated temp profile, **domain allowlist enforced at the
  network layer** per request (`Fetch.requestPaused` → non-allowlisted hosts
  get `BlockedByClient`).

Seeded allowlist (both tools): `mobile.moegirl.org.cn`, `search.bilibili.com`,
`cn.bing.com`, `www.bing.com`, `www.baidu.com`, `www.sogou.com`, `www.so.com`,
`registry.npmjs.org`, `api.github.com` — extend via
`TM_WEBFETCH_ALLOWED_DOMAINS` (`"*"` opens every host). The other four agents
(architect / implementer / reviewer / tester) have NO network grant — web
questions come back as a reported gap, never simulated.

### Security: the R6 + R2 approval gate

**R6 environment protection.** With TeamMode active, the model cannot read
environment variables silently. Env reads (`printenv`, `env`, `Get-ChildItem
env:`, …) and env files (`.env`, shell rc) route through OpenCode's official
confirmation dialog; unanswered prompts are **auto-rejected after
`TM_ASK_TIMEOUT_MIN` (default 10 min)**. Env reads no wildcard can express
(embedded `$VAR` / `${VAR}` / `$env:` inside another command, command
substitution) and the `tm_*` wrapper channel stay a **hard block** — no dialog
to slip through. The audit log records only tool name + pattern category +
verdict — never command text, paths, variable names or values.

**R2 dangerous operations (same dialog).** Delete, git publish, network
fetch, package install/publish, process/system, privilege changes — none are
silently allowed. The normal verification stack (`npm test`, `tsc`,
`git status`) is NOT gated, so day-to-day work runs uninterrupted.

> ⚠️ **When you approve a dialog, pick "once" — not "always".** Verified on
> the live host, "always" records a far broader rule than the command you
> saw: approving `Get-ChildItem env:PATH` with "always" stores `Get-ChildItem
> *`, so every later `Get-ChildItem` runs with no dialog at all.

> Deferral to the dialog is per-session: env reads only route to the dialog
> in sessions running TeamMode's injected agents. In any other session the
> guard keeps hard-blocking env reads. `headless opencode run` auto-rejects
> unanswered `ask`s immediately (there is no human to prompt).

### Repo hygiene

The offload/trajectory/memory stores live under `<repo>/.git/opencode-team/`
(or the OS temp dir outside a git repo) — **never your working tree**. Every
agent is instructed to delete scratch files before reporting done and to keep
throwaway work in the OS temp dir. A TTL sweeper reclaims old task dirs at
startup + hourly; the Team Lead never deletes boards itself, so you can audit
any run.

---

## ⚙️ Configuration

The plugin injects everything at startup — no agent files to copy.

> **Model choice matters.** Every judgment — triage, decomposition, dispatch
> briefs, synthesis, review verdicts — flows through the Team Lead. A weak
> model in that seat degrades the whole pipeline no matter how strong the
> specialists are. Pin your best reasoning model to `team`:

```jsonc
{
  "agent": {
    "team": { "model": "anthropic/claude-opus-4-5" },      // Lead earns your best model
    "implementer": { "model": "anthropic/claude-sonnet-4-6" } // specialists tolerate cheaper
  }
}
```

**Global install** — put the plugin entry in `~/.config/opencode/opencode.jsonc` and every project gets the team.

**Keep Team off the default slot:**

```jsonc
{
  "plugin": [
    ["@te-river/opencode-team-mode@latest", { "defaultAgent": false }]
  ]
}
```

Your own agents named `team` / `architect` / … always take precedence; the
plugin never clobbers user definitions. See [Customization](#-customization)
for overrides, extra agents and disabling roles.

### Environment variables

| Env var | Default | Purpose |
|---|---|---|
| `TM_ENV_PROTECT` | `strict` | R6 mode: `strict` / `standard` / `off` (off also disarms the approval timer) |
| `TM_ASK_TIMEOUT_MIN` | `10` | minutes before an unanswered dialog is auto-rejected (hard floor 3 — the host's reply event reaches the plugin ~120 s late) |
| `TM_ENV_PROTECT_EXTRA_DENY` | — | extra block patterns (regex; always hard block, never dialog-governed) |
| `TM_OFFLOAD_THRESHOLD` | `2000` | offload threshold (tokens, CJK-aware estimate) |
| `TM_PREVIEW_MAX_TOKENS` | `80` | preview hard cap |
| `TM_FETCH_MAX_LINES` | `2000` | tm_fetch page cap |
| `TM_BLACKBOARD_DIR` / `TM_TRAJECTORY_DIR` | `<repo>/.git/opencode-team/…` | offload store / trajectory ledger (tmpdir fallback; explicit = absolute or project-relative) |
| `TM_BLACKBOARD_TTL` | `7` | store retention (days) |
| `TM_BASH_READONLY_ALLOWED` | built-in table | tm_bash allowlist |
| `TM_WEBFETCH_ALLOWED_DOMAINS` | the nine seeded hosts | tm_webfetch / tm_search / tm_browser allowlist (`"*"` opens all; empty = deny all) |
| `TM_BROWSER_PATH` | auto-detect | tm_browser executable override (Edge/Chrome/Chromium per OS) |
| `TM_BROWSER_HEADLESS` | `auto` | `1` headless (CI) / `0` headful / `auto` (headless only on display-less Linux) |
| `TM_MEMORY_GLOBAL_DIR` | `~/.opencode-team/memories/global/` | tm_memory GLOBAL scope store |
| `TM_PTC_MAX_PROGRAM_CHARS` | `4000` | PTC program source cap |
| `TM_PTC_MAX_CALLS` | `20` | PTC per-run bridge-call budget (1–200) |
| `TM_PTC_MAX_ERRORS` | `3` | PTC per-run error budget (1–50) |
| `TM_PTC_TIMEOUT_MS` | `60000` | PTC per-run wall-clock timeout (5s–10min) |
| `TM_PTC_ENGINE` | `auto` | `auto` (worker→inline degrade) / `worker` / `inline` |

---

## 🏗️ How the team works

Sub-agents can't message each other live (platform limitation), so TeamMode
coordinates them through a **structured reply skeleton** — every specialist
reply is `STATUS: / CHANGES: / FINDINGS: / EVIDENCE: / HANDOFF:`, ≤50 lines,
relayed verbatim by the Lead into the next dispatch. Files are the exception,
not the rule: a deliverable over ~50 lines goes to ONE named board file under
`<repo>/.git/opencode-team/` (round-suffixed, working tree untouched).

- **Routing table:** question → direct answer; docs-only → implementer;
  product change → implementer → tester → reviewer; multi-module →
  architect → implementer → tester → reviewer(s); unknown tech → researcher
  first. Fixed minimums — a product change routed below 3 dispatches is a
  routing bug.
- **Approval gate (count-based):** ≥2 dispatches → plan (≤30 lines) → **your
  approval** → execute. Blocking questions are batched and asked immediately.
- **Adaptive review:** one reviewer by default; three parallel dimensions
  only for high-risk profiles (auth/security, cross-module contracts, public APIs).
- **Static verification:** build / typecheck / lint / tests. Improvised
  browser automation is banned; unverified UI work ends with
  `UI NOT VERIFIED: <what to check>`.
- **Evidence standard:** "done / fixed / passed" claims need verifiable
  evidence — output, logs, diffs.

---

## 🔧 Customization

**Override an agent** — same name in your config wins:

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

**Add your own agents** alongside the team:

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

**Disable one:** `"researcher": { "disable": true }`.

**Board retention** via the tuple form: `["@te-river/opencode-team-mode@latest", { "ttlDays": 7 }]` (valid range (0, 365], invalid values fall back to 5).

---

## ❓ FAQ

**Will this eat my tokens?**
The opposite is the point. Offload + 80-token previews + PTC batch programs
exist because a five-agent pipeline naively bolted onto one context window
*would* eat your tokens. The governance is the token-saver.

**Is the web access safe?**
It's the most guarded surface in the plugin: two roles only, domain
allowlist, redirects re-checked per hop, network-layer enforcement in the
browser, env-file URL refusal, and every payload rides the same offload
governance. No allowlisted page can bounce the fetch off-site.

**Why doesn't the plugin auto-update?**
OpenCode caches plugins by spec string and never re-resolves `@latest`
(upstream limitation, not ours). Delete the cache dir and restart — recipe
above and in the [installation guide](./docs/installation.md).

**Can agents run tools in parallel?**
Yes — and they're *engineered* for it: parallel `tm_search` / `tm_webfetch` /
`tm_fetch` calls get distinct step ids and isolated payloads. A regression
here fails the test suite before it ever reaches you.

**Does it work in the CLI (TUI), or only Desktop?**
Both. Desktop adds the color-coded picker and panels; the governed tools and
the whole workflow are host-agnostic. On display-less Linux, `tm_browser`
runs headless automatically.

**What happens if I don't answer a confirmation dialog?**
It auto-rejects after `TM_ASK_TIMEOUT_MIN` (default 10). The plugin never
self-approves — the only side it can take is yours or nobody's.

---

## 🗑️ Uninstall

1. Remove the entry from the `"plugin"` array in your config file.
2. Delete the cache dir (table in [Install](#-read-this-once-save-yourself-an-hour-later)) if you want the disk space back.
3. Restart OpenCode. The agents, commands and tools are gone; the stores under `<repo>/.git/opencode-team/` (and `~/.opencode-team/` for global memories) are plain files you can delete whenever.

No DLLs were harmed. Nothing was written to your working tree.

---

## 🏛️ Architecture (for the curious)

```
opencode-team-mode/
├── src/
│   ├── index.ts          ← Plugin entry (config + R6 guard + approval gate + tool segment)
│   ├── agents.ts         ← Agent structure (modes, colors, temperatures, whitelist matrix)
│   ├── prompts/          ← Agent prompts (lead / specialists / shared) — pinned by tests
│   ├── commands.ts       ← Slash command definitions
│   ├── blackboard.ts     ← Shared blackboard + TTL sweeper
│   ├── envprotect.ts     ← R6 facade (patterns / classifiers / gate predicates / hook)
│   ├── approval-gate.ts  ← Unified approval gate (dialog timeout auto-reject)
│   ├── tm/               ← Governed tools: pipelines / store / preview / guard / refs /
│   │                        webfetch / search / memory / browser / shell-bridge / ptc/ (9 modules)
│   └── types.ts          ← Loader-contract types (1.18.x)
├── docs/installation.md  ← The agent-consumable install guide
├── scripts/              ← One-line installers (bash / PowerShell)
├── pt07/                 ← PT-07 baseline suite (seeded A/B token measurement)
└── README.*.md           ← You are here (twice)
```

The loader calls `server(input, options)` once: the `config` hook injects the
six agents and six commands, the same call installs the R6
`tool.execute.before` guard, arms the approval gate through an `event` hook,
and registers the `tm_*` tools. User-defined agents with the same name always
win — the plugin never clobbers.

---

## 🤝 Contributing

Issues and PRs welcome. Especially wanted: localization of agent prompts,
more agent roles, more command templates, and real-world reports of the
search engines' behavior (they rearrange their markup; the extractor filters
are intentionally loose but not psychic).

---

## 📄 License

[Apache License 2.0](./LICENSE)

---

## 🔗 Links

- [npm Package](https://www.npmjs.com/package/@te-river/opencode-team-mode) — `@te-river/opencode-team-mode`
- [Installation guide](./docs/installation.md) — the complete manual / agent-consumable procedure
- [OpenCode Desktop](https://opencode.ai) — Official website & download
- [OpenCode Docs](https://opencode.ai/docs) — Configuration & plugin documentation
- [OpenCode Plugin API](https://opencode.ai/docs/plugins) — Build your own plugins
