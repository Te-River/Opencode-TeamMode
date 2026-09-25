# OpenCode TeamMode

**[English](./README.md)** | **[中文](./README.zh-CN.md)**

[![npm version](https://img.shields.io/npm/v/@te-river/opencode-team-mode.svg)](https://www.npmjs.com/package/@te-river/opencode-team-mode)
[![npm downloads](https://img.shields.io/npm/dm/@te-river/opencode-team-mode.svg)](https://www.npmjs.com/package/@te-river/opencode-team-mode)
[![license](https://img.shields.io/npm/l/@te-river/opencode-team-mode.svg)](./LICENSE)

> 🤝 **Your OpenCode just hired a team.**
>
> Six specialized agents — a Lead, an Architect, an Implementer, a Reviewer, a Tester and a Researcher — with governed tools, structured handoffs, and a plan-first approval gate. One plugin, zero config files to copy.

> 💡 **Best for medium-to-large projects.** The governance layer (approval gate, context offload, tool allowlists) is an asset once a codebase has real surface area — and mostly overhead on tiny scripts and one-off questions. Use it where the work is.

---

## TL;DR — skip the docs

> **The lazy path:** paste this to any coding agent and let it do the work:
>
> ```text
> Install the OpenCode plugin @te-river/opencode-team-mode. First run `opencode --version`:
> 1.18.x → https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/docs/installation.md
> 2.x → https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/docs/installation-v2.md
> (on 2.x a plugin cannot create an agent, so the six roles and six `/team-*` commands come
> from a generator step in that guide — that step is not optional.) Then verify the install
> using the checks in that guide.
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
| 🔥 **Context flooding** | Every governed tool output over its content-class offload threshold (prose 4000 / data 2000 tokens, CJK-aware) is offloaded to a local run store and replaced by an 80-token preview + an HMAC handle. The agent pages through what it needs — the window never drowns. |
| 🐌 **Round-trip overhead** | `tm_ptc_run`: the agent writes ONE program that makes N governed calls in a single turn. Zero LLM round-trips during the run. |
| 🕳️ **Silent side effects** | R6/R2 approval gate: env-var reads and dangerous ops route through OpenCode's official confirmation dialog, auto-rejected after 1 unanswered minute (default). The plugin never approves on its own — it only ever rejects. |
| 🌫️ **Hallucinated research** | Web access is a two-role grant with an allowlisted, governed tool chain. A fact that couldn't be fetched is reported as a gap — never fabricated. |
| 🧭 **Walls of text** | Replies are steered into the shape the host renders fastest: a markdown table for per-file / per-case / per-finding results, fenced code for diffs and configs, a browser screenshot attached as an inline image only when you ask for one. The renderer's supported set is measured rather than assumed, and the prompts carry the negative half of that measurement — footnotes, `==highlight==`, a bare `---` rule and `$…$` math reach you as literal text, so agents are told not to use them, while `mermaid` diagrams are offered because this host does draw them. |
| 🎯 **Goal drift** | The lead opens with `GOAL:` in your own words plus checkable `ACCEPTANCE:` criteria, and the run does not end while a criterion lacks evidence — the only legitimate stops are named (blocked on you, or provably unachievable). When a round settles with items still open on the host's todo list, `tm_join` says 目标未达成 and lists them, and the goal is carried through context compaction so a summarized transcript cannot redefine it. |

| 🗣️ **Replies in a language you never chose** | The governed tools answer in Chinese, and an agent left to its own devices mirrors that straight back at you. Every role now carries a reply-language rule: your own language wins, and a Chinese string is quoted verbatim only where it IS the evidence (a close verdict, a refusal line) — translating a verdict is how an unchecked claim starts looking checked. |
| ⏱️ **Rounds spent for the sake of looking careful** | 效率至上 is written into the lead and all five specialists: one wide call instead of three narrow ones, independent calls in the same round, ≥3 probes collapsed into one `tm_ptc_run`, no re-running a check to watch it pass again — with the boundary stated too: efficiency never buys its way out of the evidence rule, because an unverified "done" costs you the round *and* the bug. |

And the workflow discipline underneath: deterministic routing, a ≤30-line plan
you approve before ≥2 dispatches execute, structured `STATUS/CHANGES/FINDINGS/
EVIDENCE/HANDOFF` replies between agents, and static verification (build /
typecheck / tests) instead of vibes.

That discipline is also why the recommendation is **medium-to-large
projects**: on a two-file script the team simply has less to govern.

---

## 👥 The team

| Agent | Role | When to use |
|---|---|---|
| 🎯 **Team Lead** (`@team`) | Orchestrator | Complex tasks that need planning + multi-step execution |
| 🏗️ **Architect** | System designer | Design docs, module structure, API contracts |
| 💻 **Implementer** | Code writer | Building features, writing production code |
| 🔍 **Reviewer** | Dimension-focused auditor | Single-dimension review by default; 3 in parallel only for high-risk changes |
| 🧪 **Tester** | Test engineer | Tests with real edge cases; static verification (build / typecheck / lint); governed UI verification via `tm_browser` |
| 🔎 **Researcher** | Knowledge finder | Local repo first, then the web — one of the two network roles (with the Lead) |

Out of the box, **Team is your default agent** — new chats open straight into the
orchestrator (opt-out in [Configuration](#-configuration)).

---

## 📦 Install

### Option 1 — Let your agent do it (recommended)

Copy this into any coding agent — it will edit your config, restart-remind you, and verify:

```text
Install the OpenCode plugin @te-river/opencode-team-mode. First run `opencode --version`:
1.18.x → https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/docs/installation.md
2.x → https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/docs/installation-v2.md
(on 2.x a plugin cannot create an agent, so the six roles and six `/team-*` commands come from
a generator step in that guide — that step is not optional.)
(If a URL is unreachable — common on mainland-China networks — retry with
the mirror prefix: https://ghproxy.net/ + the same path.)
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
- **Plugin updates: re-run the installer.** It is idempotent — a re-run re-patches the config (no-op when present), purges the stale plugin cache, and re-resolves any npm-installed copy. This exists because OpenCode caches plugins by spec string and does NOT re-resolve `@latest` when a new version publishes (upstream limitation). Manual recipe, if you prefer:

  | OS | Purge command — recursive, covers BOTH cache layouts |
  |---|---|
  | macOS / Linux | `find ~/.cache/opencode/packages -type d -name '*opencode-team-mode*' -prune -exec rm -rf {} +` |
  | Windows (PowerShell) | `foreach ($r in "$HOME\.cache\opencode\packages", "$env:LOCALAPPDATA\opencode\cache\packages") { if (Test-Path $r) { Get-ChildItem $r -Directory -Recurse -Filter '*opencode-team-mode*' -EA SilentlyContinue | Sort-Object { $_.FullName.Length } | Remove-Item -Recurse -Force -EA SilentlyContinue } }` |

  ⚠️ OpenCode loads the plugin from `~/.cache/opencode/packages/` — possibly nested inside the scoped `@te-river/` directory — **not** from `~/.config/opencode/node_modules`, which is why the delete must recurse (a top-level-only `rm -rf` silently misses the scoped copy).

  If you also npm-installed the plugin into `~/.config/opencode`, its package-lock pins the version — run `npm install @te-river/opencode-team-mode@latest` there too. Full recipe (including an agent-driven update prompt): [installation guide, Updating](./docs/installation.md).
- **Prerequisites:** [OpenCode](https://opencode.ai) (Desktop or CLI) and Node ≥ 18.

### 🖥️ What the installer changes on your machine

Three things, all outside this repo — listed because a plugin that edits your
environment without saying so is not one you can trust.

| What | Where it lands | How long it stays |
|---|---|---|
| A plugin entry in the OpenCode config | `~/.config/opencode/opencode.jsonc` (created if missing; an existing `opencode.json` is **migrated into** the `.jsonc`, the original file left untouched) | until you delete the line |
| A purged plugin cache | `~/.cache/opencode/packages/*opencode-team-mode*` (including the nested `node_modules` copy that actually runs) | re-downloaded on next start — it is a cache, nothing to restore |
| **A user-level environment variable** | `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` | **Windows: `setx` writes it into your user profile — it survives reboot and is visible to EVERY program you start afterwards, not just OpenCode.** macOS `launchctl setenv` / Linux `systemctl --user set-environment`: this login session only (re-run the installer after a reboot) |

Why that third one is there: `task { background: true }` is the only sub-agent
the OpenCode interface can **show** you — a card linking to the live child
session, which you can stop. The host turns it on through a flag on **its own
process**, and a plugin cannot set flags in the process that loads it, so the
flag has to come from the environment. Without it nothing breaks: `task` simply
blocks the lead and its card stays non-background.

Undo it:

```powershell
# Windows — remove it from the user profile
[Environment]::SetEnvironmentVariable("OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS", $null, "User")
```

```bash
launchctl unsetenv OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS          # macOS
systemctl --user unset-environment OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS   # Linux
```

Or skip it at install time, and the installer touches only the two files above:

```powershell
.\install.ps1 -NoBackgroundSubagents                     # or $env:TEAMMODE_SKIP_BACKGROUND_SUBAGENTS="1"
```

```bash
TEAMMODE_SKIP_BACKGROUND_SUBAGENTS=1 bash install.sh
```

Either way the installer prints what it changed, and reads the value back
instead of trusting its own exit code.

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
the offload threshold never enter the context window — the boundary is
content-class aware (`TM_OFFLOAD_THRESHOLD_TEXT` = 4000 for prose:
text/log/markdown; `TM_OFFLOAD_THRESHOLD_DATA` = 2000 for json/csv/code/
binary; an unknown class falls back to the global `TM_OFFLOAD_THRESHOLD`) —
and oversized results are offloaded to a run store and replaced by a
content-aware preview plus an HMAC-signed handle that the agent pages
through with `tm_fetch` when it genuinely needs the payload.

| Tool | What it does | Roles |
|---|---|---|
| `tm_read` / `tm_grep` / `tm_bash` / `tm_fetch` | Governed file read / regex search / read-only shell (allowlist) / paged handle retrieval (JSON handles take a `fields` dot-path projection — a deliberately small jq subset like `items[].name`) | all six agents — **except on OpenCode 2.x, where the first three are not registered; see the note under this table** |
| `tm_memory` | Session + project + global memory store (Markdown + frontmatter): add / search / list / forget / compact | all six agents |
| `tm_board_write` | **The blackboard's write side**: places ONE new Markdown file at `<board-root>/<session-key>/<task-slug>/NN-<role>-<topic>[-rN].md` and chooses the name itself — a revision is a new round-suffixed file, never an overwrite, and the reply carries the path plus the byte count, never the content. It exists because the board used to need a file tool, and `architect` / `researcher` own none (no `write`, no `edit`, no `bash` even to stamp the session folder), so every oversized deliverable from those roles came back as `BLACKBOARD WRITE FAILED` plus the whole document pasted inline — the reply shape this team mandates was un-followable exactly where it mattered. Scope is enforced rather than asked: segments sanitized, target realpath-verified against the board root (a symlinked task dir is refused), the name always ends in `.md` so no `.env`/rc file can be produced, caps via `TM_BOARD_MAX_CHARS` + a per-session file limit | All six agents |
| `tm_ptc_run` | Batch orchestration: one program, N governed calls, zero LLM round-trips; web roles also get `tm.search` / `tm.webfetch` inside the program | all six agents |
| `tm_search` | Multi-engine web search with extracted, deduplicated, RRF-fused hit lists | Lead + Researcher |
| `tm_webfetch` | Single governed GET of an allowlisted page (search pages auto-extracted). Manual redirects, re-checked per hop, and a refusal names the WHOLE chain (`跳转链: a → b（停在第 2 跳）`) — an allowlisted shortener that bounces off-site used to report only the off-site host, which read as "that site will not fetch" and sent the agent back to retry the entry URL it had just watched fail. A 429/503 carries its own `Retry-After` when the server sends delta-seconds (an HTTP-date is deliberately not laundered into a countdown), so "come back later" never looks like "no content here". The page GET also asks for Markdown first (`Accept: text/markdown,…`) — measured on `learn.microsoft.com`: 60,778 B of HTML becomes 11,449 B of Markdown, and every other host tried returns the same document either way, so the preference is free where it is ignored | Lead + Researcher |
| `tm_ledger` | **The lead's task ledger** (`add` / `doing` / `done` / `blocked` / `list`), stored in the host's own `ctx.storage` per session — the landing spot for the LEDGER rule on OpenCode 2.x, which gives a plugin no `todowrite`. A repeated ask is ONE item, an id that matches two is refused with both printed, `blocked` carries the reason, and a write that did not reach storage is reported as a failure rather than as recorded. **v2 only** — v1 keeps the host's `todowrite` | Lead only |
| `tm_join` | **Sub-agent collection** — there is no plugin-side dispatcher any more (`tm_dispatch` is removed: a child a plugin creates is a session the user can neither open nor stop from the interface). Delegation goes through the host's own `task` / `task { background: true }`, and `tm_join` is the read side: a status snapshot, a bounded `waitMs`, `cancel:true` to abort, and `claimNamedChild` so `tm_join { ids: ["ses_…"] }` pulls one child's WHOLE reply back through the offload pipeline (handle + ≤80-token preview) instead of kilotokens inline. It also rebuilds its registry from the host session tree after a restart, so leftover children are 接管 rather than lost | Lead only |
| `tm_pty` | **Non-blocking command execution** on the host's own terminal sessions (`start`/`status`/`list`/`kill`) — independent builds and test suites overlap instead of queueing behind one 120 s bash call. Captures no output (the command tees its own log; read it with `tm_read`), and every start passes the R6 classifier, the R2 danger-face globs **and** the official confirmation dialog before a process exists | Lead only |
| `tm_stats` | **The plugin reads its own trajectory back**: tokens kept out of the context window by offloading (net of the preview that arrived), seconds saved by dispatch overlap (serial cost minus the wall window the children actually used), PTC internals, governance counts (blocked subresources, refused `tm_pty` starts, clamped bash timeouts, cache hits, redactions) — plus the **host capability matrix** (`已验证/存在未用/待观察/缺失/需人眼` per host surface). Read-only over files this plugin wrote; run it first after an OpenCode upgrade. `{ recent: 20 }` appends a call-by-call recap — handle + payload path for every offloaded result, which is how you see what a governed tool actually returned (the host gives plugin tools no expandable card) | All agents |
| `tm_browser` | Interactive browser session (**your default browser**): 18 Playwright verbs (snapshot-first `take_snapshot` → uid-addressed `click`/`fill`/`drag`/…, **including multi-tab `new_page` / `close_page`** so you can hold two pages at once) + 5 legacy compat verbs (open/navigate/read/screenshot/close); Playwright engine needs Node ≥ 20, below that (or on any import failure) it auto-degrades to the legacy CDP engine. It drives YOUR default browser channel (an Edge Beta default opens Edge Beta), stays headful unless the operator sets `TM_BROWSER_HEADLESS`, loads a page's own images/CSS/JS via the `same-site` subresource policy, and `take_screenshot { image:true }` attaches a JPEG so the model can actually see the screen. **One browser per agent**: `open` returns an id (`b1`) and every reply is tagged with it — that window, its uid numbering and its dialog-approved hosts belong to YOUR session; another agent's id is refused with the owner named (an id is a name, not a key), and `close { id:"all" }` closes only your own. `click` reports what the PAGE did, not merely that a mouse event was sent: it reads the target's observable state before and after (`aria-expanded`, URL, DOM node count) and answers `已点击 … · aria-expanded: false → true`, retries once if the page had not finished loading — the measured cause of a click that lands on a node with no handler — and says 页面没有任何可观测变化 rather than implying success. `close` will not say 已确认关闭 until the browser's OS process is gone — it waits on the pid, terminates it once if it lingers, and prints the pid either way, because a dropped connection is not a closed browser; when no pid could be resolved it says 进程未核验 rather than borrowing that sentence. A browser this process launched but could not reap is recorded in a per-workspace ledger (pid, owner pid, executable) and reclaimed by the next boot — only entries whose owner process is dead *and* whose pid still is that executable, terminated as a whole tree (`taskkill /T` on Windows), never another window's live tab. **A blank page now explains itself**: `same-site` cannot know that a site's own bundle lives on a brand-unrelated CDN (Baidu serves its scripts from `bdimg.com`), so when a page comes back with `0 个可寻址节点` while a script host was blocked, the reply says the blankness is **our gate**, names the host, and offers `allow_host { host }` — one official dialog for one bare domain, for your browser only, for this session, nothing written to config (re-navigate afterwards, the gate decides per request). A page that is really a human-verification wall (百度安全验证 / Cloudflare / access denied) is reported as a wall, because the move there is another source, not another retry | Lead + Researcher + Tester (UI verification) |

> **On OpenCode 2.x, four of those tools are deliberately not registered.**
> `tm_read` / `tm_grep` / `tm_bash` are replaced by the host's own `read` / `grep` /
> `glob` / `shell`, and `tm_ptc_run` by the host's `execute` (Code Mode) — the same
> job, one fewer tool for the model to choose between.  The governance did NOT
> disappear with them: an oversized native result is offloaded through
> `tool.execute.after` (measured: `shell` 12,902 tokens arriving as a 78-token
> preview), and the address red line plus R6's per-command classification ride the
> host's `permission.evaluate`.  `tm_ledger` is the one tool that exists ONLY on v2 (the lead's list needs a home where
> `todowrite` does not).
> The installer writes the v2 variants of the six
> role prompts, which name `read` / `grep` / `shell` instead of the aliases.
> Everything above this note describes the v1 (1.18.x) surface, which still ships
> all thirteen.

> **Fixed tool priority ladder (every task): ① the user's own MCP/plugin
> tools → ② TeamMode governed tools (`tm_*`) → ③ the model's own reasoning.**
> It doubles as the fallback chain: when a tool errors (no browser on this
> host, blocked host), the agent says so and drops to the next rung — and
> rung ③ is where a missing capability gets reported, never fabricated.
> One stated exception: on the **web** channel `tm_search` / `tm_webfetch` /
> `tm_browser` come first, because that path is the only one carrying the
> domain allowlist, the per-request confirmation dialog and the R6 red lines.

> **What the host UI cannot show you.** OpenCode renders a *plugin* tool call
> as a one-line card with no expandable body — its tool-renderer registry
> holds only the built-in tool names, and an extension cannot add to it. The
> governed output still exists: anything over the offload boundary is written
> to disk as a handle, and `tm_stats { recent: 20 }` prints the call-by-call
> recap with those handles and file paths, which you can open. Ask your agent
> for it — "what did that tool actually return?"

> **Delegation goes through the host's `task` — one channel, two shapes.**
> OpenCode's own `task` tool is the only sub-agent the interface can SHOW you:
> its card links to the live child session, and the user can stop it. Add
> `background: true` and it is also non-blocking — the host wakes your lead when
> the child finishes. That flag is experimental, so you turn it on yourself:
>
> ```
> OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true
> ```
>
> (set it for the app process — `setx` on Windows, or launch from a shell that
> exports it — then restart OpenCode; the installers do it for you, and that is
> a **persistent user-scope write**, so see
> [What the installer changes on your machine](#-what-the-installer-changes-on-your-machine)
> for the exact value, its lifetime and the undo command). TeamMode
> then keeps that channel inside your token budget: the injected full reply is
> replaced by a preview plus a pointer, and nothing is copied to disk
> (`TM_TASK_OFFLOAD=off` restores the host's verbatim text). Cost of the host
> path, stated plainly: each finished background task wakes the lead and costs a
> turn. `tm_join` is the read side that stays — it pulls a named child's whole
> reply back through the offload pipeline, aborts a runaway, and rebuilds its
> registry from the host session tree after a restart.
>
> There is deliberately **no plugin-side dispatcher**: an earlier `tm_dispatch`
> created children the user could neither open from a card nor stop from the
> interface, which is a worse trade than the batching it bought. Remove it,
> and nothing breaks — the host's `task` was always the visible path.

All governed tools are **parallel-safe**: the host may run a batch of
`tm_search` / `tm_webfetch` / `tm_fetch` calls concurrently — each call gets
its own step id and its own payload, and nothing cross-contaminates
(proven by the parallel test suite).

### Context governance: offload, handles, previews

Large tool outputs are context cost's main driver — every step re-sends the
whole window. So results above the content-class offload boundary (prose →
`TM_OFFLOAD_THRESHOLD_TEXT`, structured data → `TM_OFFLOAD_THRESHOLD_DATA`,
unknown → global `TM_OFFLOAD_THRESHOLD`) are written to a local run store
(`<repo>/.git/opencode-team/`, never your working tree) and replaced by a
handle with a content-aware preview: JSON keys / CSV header + shape / log
ERROR×N stats / code signatures / binary metadata, hard-capped at 80 tokens.
When the agent actually needs the payload, it pages through with `tm_fetch`
using an HMAC-signed, run-scoped, expiring handle — and on a JSON handle it
can ask for a `fields` dot-path projection instead (a deliberately small jq
subset: `items[].name`, `[].stargazers_count`), so a big API dump narrows to
just the values needed without the raw body ever entering the window.
`tm_bash` only allows read-only commands (allowlist), and failures come back
as structured errors instead of raw dumps.

### Session + project + global memory (tm_memory)

Durable facts — build commands, environment quirks, architecture decisions,
your conventions — live as human-editable Markdown with frontmatter, in
THREE tiers:

- **`session`**: this conversation's transients only — in-process, TTL-swept
  (`TM_MEMORY_SESSION_TTL_MIN`, default 240 min), invisible to other
  sessions; ephemeral unless `TM_MEMORY_SESSION_PERSIST=1` writes them under
  `memories/sessions/<sid>/`.
- **`project`** (default): `<repo>/.git/opencode-team/memories/…` — per checkout, git-adjacent. Facts about THIS repo: build commands, environment quirks, architecture decisions.
- **`global`**: `~/.opencode-team/memories/global/` (override `TM_MEMORY_GLOBAL_DIR`) — **follows you across ALL projects**. User-level conventions: preferred package manager, commit style, tooling habits.

Actions: `add` / `search` (deterministic keyword scoring) / `list` / `forget` /
`compact`; 4000 chars per memory. `search` walks ALL tiers with **session >
project > global precedence** — project entries get a +2 near-tie weight and a
same-title higher-layer twin shadows the lower one (it never surfaces).
Near-duplicates never pile up: an `add` that hits an existing entry in the same
tier and category (dedup key, or title+keywords Jaccard ≥ 0.6) **folds into
it** — new content wins, keywords union, the old slug moves to `supersedes:`,
and the answer says 已合并 (that is normal; don't re-add under a variant title).
When a tier reaches `TM_MEMORY_MAX_ENTRIES` (200 per scope) the add fails on
purpose: run `compact` first — it dry-runs the merge plan by default, and
re-running with `apply:true` performs it after copying every original to a
timestamped `.compact-backup` tree (the rollback path). Entries older than
`TM_MEMORY_STALE_DAYS` (30) surface tagged `[stale Nd]` in search. Agents
are prompted to search before assuming conventions and to save hard-won
facts for the next conversation.

### 🌐 Web search that actually works (in China)

`tm_search` is the open-ended-lookup front: **one call, one query, clean
results**. The engine URL is built for you, fetched through the governed
pipeline, and collapsed into a numbered title+URL hit list — the agent never
sees raw SERP chrome.

| Engine | Notes |
|---|---|
| `auto` (default) | Classifies the query, fans the matching engines out **in parallel** (every route has ≥2 legs), dedupes by host+path and fuses them with weighted RRF into a top-10 list tagged with each hit's source engine(s).  Ranking is scaled by real query-token overlap (floor `TM_SEARCH_RELEVANCE_FLOOR`), so a trusted engine's off-topic junk no longer outranks another engine's best hit. Routing: errors / camelCase APIs → `stackoverflow`+`github`+`bing`; dev-ecosystem (releases, frameworks, open source) → `hn`+`github`+`npm`; Chinese → `bing`+`moegirl`+`stackoverflow`+`hn`; other → `bing`+`stackoverflow`+`hn`+`github`. Pin another default via `TM_SEARCH_DEFAULT_ENGINE` |
| `bing` | cn.bing.com — the only live CN HTML SERP; multi-word CJK queries get their phrase boundary protected (quoted) so markup shuffle can't split the result list |
| `stackoverflow` | api.stackexchange.com question search (no key, 300/day/IP) → numbered questions with composite snippets; `auto` tracks the quota and swaps in `bing` once spent |
| `hn` | Hacker News via Algolia API (no key) → story titles + snippets with direct article URLs |
| `bilibili` | video search |
| `moegirl` | MediaWiki search API — entry titles + snippets, structured |
| `npm` | registry search → name@version + description, structured |
| `github` | repo search API → stars + description, structured; `org:` / `user:` / `stars:` / `language:` qualifiers fold into the query (e.g. `vector db stars:>500 language:rust`) |

All seven engines are reachable from mainland China **without API keys**, and
every one of them sits on the seeded domain allowlist. The previous CN HTML
SERPs (`sogou` / `so` / `baidu` / `bing-int`) were **removed** — a live
benchmark (2026-09-14) showed them serving anti-bot shells or 100% empty
results; they are not even manually selectable. On an empty result,
the error names the alternative engines instead of leaving the agent stuck.
Two more channels complete the surface:

- `tm_webfetch` — a known URL, one governed GET. Search-engine pages it
  fetches are auto-extracted to hit lists too. JSON endpoints like
  `registry.npmjs.org/<pkg>/latest` pass through untouched.
- `tm_browser` — JS-rendered pages: **your DEFAULT browser** (Windows
  registry / Linux `xdg-settings`; Chromium-family only — Firefox falls back
  to the Edge/Chrome probe order because CDP is Chromium-proprietary;
  `TM_BROWSER_PATH` overrides), headful by default, isolated temp profile,
  **domain allowlist enforced at the network layer** per request and per
  redirect hop. The action surface is chrome-devtools-mcp aligned: **16
  Playwright verbs** (`navigate_page` · `take_snapshot` · `click` · `fill` ·
  `hover` · `drag` · `press_key` · `select_page` · `upload_file` · `wait_for`
  · `evaluate_script` · `list_console_messages` · `list_network_requests` ·
  `list_pages` · `take_screenshot` · `handle_dialog`) plus 5 legacy compat
  verbs (`open` / `navigate` / `read` / `screenshot` / `close`).
  Snapshot-first: `take_snapshot` returns the aria snapshot with injected
  `[uid=eN]` tokens, follow-up actions address nodes by uid instead of
  guessed locators; snapshots are hard-capped by
  `TM_BROWSER_SNAPSHOT_MAX_TOKENS` (default 1200).
  **Engine split:** the primary engine is `playwright-core` (an optional
  dependency — needs **Node ≥ 20**; on older Node, or if the import fails,
  the session auto-degrades per instance to the zero-dep `cdp-legacy`
  engine, which keeps the core verbs only; pin either via
  `TM_BROWSER_ENGINE=playwright|cdp-legacy`). No browser download is ever
  involved — Playwright launches YOUR installed browser by path, so
  `npx playwright install` is not part of the user flow (the dependency
  itself resolves at npm install/publish time). Isolated temp profile by
  default: persistent logins only if you explicitly set
  `TM_BROWSER_USER_DATA_DIR`. No cookies by design — the agent opens a blank
  profile, which is also why a risk-scored site (Baidu) may hand it a
  verification wall your own window walks past. Want it logged in: point the
  variable at a DEDICATED directory and log in once by hand. The browser's **own** site-permission bubble
  ("…wants to access other apps and services on this device") is
  auto-**denied** at launch: that modal is not our confirmation channel, it has
  no timeout, and on a machine left running unattended it would hang the page
  indefinitely. Nothing is ever auto-allowed — a page that truly needs such a
  permission fails visibly at that feature instead of invisibly at a dialog. A
  window an agent forgets is now **reported**, not merely reaped: `open` states
  the close duty in its own reply (with the real idle seconds), the reply
  contract requires the tool's close verdict in `EVIDENCE`, and `tm_join` tells
  the lead `⚠ N 个浏览器还开着` when a sub-agent settled while still holding one
  — so you are never the only one who notices.

When a fetch still returns **403 after the real-Chrome headers**, the error
is a DIRECTIVE: the gate is JS-challenge / TLS-fingerprint based and only a
real browser passes — the agent is told to call `tm_browser`
(`action:"open"` → `action:"read"`) for that URL. Search hit lists also
filter known noise: engine-internal wrappers (`so.com/link?`, `ai.so.com`)
and same-name-different-site domains (`maimai.cn` 脉脉 vs the maimai DX
game) never ride along — extend the hit blacklist with `TM_HIT_BLACKLIST`.

Seeded allowlist (all three web tools; 23 hosts — baidu/moegirl/bilibili are
PARENT domains, so every sibling subdomain — baike.baidu.com,
mzh.moegirl.org.cn, space.bilibili.com — is covered):
`baidu.com`, `moegirl.org.cn`, `bilibili.com`, `www.sogou.com`, `www.so.com`,
`cn.bing.com`, `www.bing.com`, `zhihu.com`, `juejin.cn`, `csdn.net`,
`cnblogs.com`, `gitee.com`, `github.com`, `api.github.com`,
`raw.githubusercontent.com`, `gist.githubusercontent.com`, `ghproxy.net`
(mainland mirror for github raw), `stackoverflow.com`, `api.stackexchange.com`
+ `hn.algolia.com` (the two JSON search engines), `npmjs.org`, `pypi.org`,
`learn.microsoft.com` — extend via
`TM_WEBFETCH_ALLOWED_DOMAINS` (`"*"` opens every host; a custom list REPLACES
the seed, so keep the engine hosts or `tm_search` loses its targets). Architect /
implementer / reviewer have NO network grant — web questions come back as a
reported gap, never simulated. The tester carries `tm_browser` ONLY, for
governed UI verification of the project (local dev servers, preview routes);
open web fetching stays with the two network roles.

**Out-of-allowlist targets are a gate, not a wall.** When a fetch / search /
browser-open points at a host outside the allowlist, the tool hands the URL
to OpenCode's **official confirmation dialog** — you decide, once per
target (an unanswered dialog is auto-rejected on the usual 1-minute timer,
and the plugin still never self-allows). Every dialog also fires a
**system toast notification**, so you know something is waiting even when
you're not staring at the screen. Env-file URLs and non-http(s) schemes
remain hard-rejected with no dialog — R6 red lines are never consentable.

### Security: the R6 + R2 approval gate

**R6 environment protection.** With TeamMode active, the model cannot read
environment variables silently. Env reads (`printenv`, `env`, `Get-ChildItem
env:`, …) and env files (`.env`, shell rc) route through OpenCode's official
confirmation dialog; unanswered prompts are **auto-rejected after
`TM_ASK_TIMEOUT_MIN` (default 1 min)**. Env reads no wildcard can express
(embedded `$VAR` / `${VAR}` / `$env:` inside another command, command
substitution) and the `tm_*` wrapper channel stay a **hard block** — no dialog
to slip through. The audit log records only tool name + pattern category +
verdict — never command text, paths, variable names or values. Verdicts now
also explain a dialog that cannot be answered anymore: a reply that hits an
**already-closed** dialog (host 404 — the timer already auto-rejected) audits
as `already-closed` without degrading the gate, a plugin-side bad reply shape
audits as `rejected-shape-bug`, and a user reply that arrives *after* the
auto-reject is recorded as `late-<verdict>` for observability only (the
rejection stands — the plugin still never self-allows). The 1-minute auto-reject
floor is tunable via `TM_ASK_TIMEOUT_FLOOR_MIN`; the short default is safe
because a reply that races the timer audits as benign `already-closed` (host
404 on a closed dialog — no gate degrade), and the observed ~120 s is the
host-to-plugin event-bus *delivery* lag, not click-resolution latency.

**R2 dangerous operations (same dialog).** Delete, git publish, network
fetch, package install/publish, process/system, privilege changes — none are
silently allowed. The normal verification stack (`npm test`, `tsc`,
`git status`) is NOT gated, so day-to-day work runs uninterrupted.

> ⚠️ **When you approve a dialog, pick "once" — not "always".** Verified on
> the live host, "always" records a far broader rule than the command you
> saw: approving `Get-ChildItem env:PATH` with "always" stores `Get-ChildItem
> *`, so every later `Get-ChildItem` runs with no dialog at all. The web
> channel has the same trap and it is easier to fall into: one "always" on a
> host lets **every agent session in that project** open it, so the per-agent
> browser consent never gets asked again. The reply now says which path let a
> page in (static allowlist / the dialog you just answered / a saved rule that
> answered in milliseconds), because an agent that cannot tell them apart
> reports "no dialog" as "that site is allowed".

> Deferral to the dialog is per-session: env reads only route to the dialog
> in sessions running TeamMode's injected agents. In any other session the
> guard keeps hard-blocking env reads. `headless opencode run` auto-rejects
> unanswered `ask`s immediately (there is no human to prompt).

### Repo hygiene

The offload/trajectory/memory stores live under `<repo>/.git/opencode-team/`
(outside a git repo: the OS temp dir, sharded per workspace as
`opencode-team/w-<hash>/`, so one project never reads another's payloads) —
**never your working tree**. Every
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
| `TM_R6_FINE_ASK` | classifier (v2 only) | On **v2** the command line is judged per-call by the host's `permission.evaluate` hook, so an ordinary `git status` asks nothing and an env dump still does. `off` falls back to asking about EVERY shell command — which is also what happens automatically on a host that does not expose the hook, and the boot note says which of the two caused it. v1 is unaffected: it classifies in the tool-call hook either way |
| `TM_V2_PROBE` | — (v2 only) | Path to a JSONL file where the surface probe records the host's real tool ids, permission action names and argument key names. Names and counts only — never a command line, path, URL or env value. It is how "does the host actually have X?" gets answered from the running build instead of from a doc; without it the same name sets still ride the trajectory so `tm_stats` can show them |
| `TM_ASK_TIMEOUT_MIN` | `1` | minutes before an unanswered dialog is auto-rejected (floored at 1 min — safe: a racing reply audits as benign `already-closed`; the host's reply event reaching the plugin ~120 s late is event-bus delivery lag, not a click delay). Every governed tool ALSO ends the wait itself at this + 15 s, because the gate is only armed when R6 is on and the client can reply — and a tool that waits forever reads as a hang, not as a request for your attention |
| `TM_ASK_TIMEOUT_FLOOR_MIN` | `1` | minimum enforced for the ask timeout above |
| `TM_ENV_PROTECT_EXTRA_DENY` | — | extra block patterns (regex; always hard block, never dialog-governed) |
| `TM_OFFLOAD_THRESHOLD` | `2000` | global offload fallback (tokens, CJK-aware estimate) — used when the content class is unknown |
| `TM_OFFLOAD_THRESHOLD_TEXT` | `4000` | offload boundary for prose (text / log / markdown) |
| `TM_OFFLOAD_THRESHOLD_DATA` | `2000` | offload boundary for structured payloads (json / csv / code / binary) |
| `TM_PREVIEW_MAX_TOKENS` | `80` | preview hard cap |
| `TM_FETCH_MAX_LINES` | `2000` | tm_fetch page cap |
| `TM_BLACKBOARD_DIR` / `TM_TRAJECTORY_DIR` | `<repo>/.git/opencode-team/…` | offload store / trajectory ledger (tmpdir fallback, sharded per workspace by a path hash so `tm_stats's window is only THIS workspace's traffic; explicit = absolute or project-relative) |
| `TM_BLACKBOARD_TTL` | `7` | store retention (days) |
| `TM_BOARD_MAX_CHARS` | `200000` | tm_board_write: one board file's character cap — over it the write refuses (with a "split the topic" hint) instead of truncating a deliverable |
| `TM_BOARD_MAX_FILES` | `200` | tm_board_write: markdown files allowed per session folder; the TTL sweeper is the only reclaim path, so the refusal names it and the `ttlDays` option |
| `TM_BASH_READONLY_ALLOWED` | built-in table | tm_bash allowlist |
| `TM_SEARCH_DEFAULT_ENGINE` | `auto` | tm_search engine when no `engine` arg is given (`auto` = classify + parallel fan-out + RRF fusion; any table name also pins a manual default) |
| `TM_WEBFETCH_ALLOWED_DOMAINS` | the 24 seeded hosts on v1; `"*"` on **v2** | tm_webfetch / tm_search / tm_browser allowlist (`"*"` opens all; empty = deny all; a custom list REPLACES the seed — keep the engine hosts). A site's own asset CDN has to be seeded or `tm_browser` renders it blank — `bdimg.com` is there for exactly that reason; per-session gaps go through `tm_browser { action:"allow_host", host }` instead of an env edit. `"*"` does **not** cover private space: loopback / RFC1918 / CGNAT / `.localhost` still need the dialog on every use, and non-routable ranges (169.254.0.0/16 metadata, 0.0.0.0/8, multicast, reserved, plus the IPv4-mapped and DNS64 spellings of the same target) are a hard red line no setting can open |
| `TM_BROWSER_PATH` | auto-detect | tm_browser executable override (default: your DEFAULT browser when Chromium-family, else Edge/Chrome probes) |
| `TM_BROWSER_HEADLESS` | `auto` | `1` headless (CI) / `0` headful / `auto` (headless only on display-less Linux) |
| `TM_BROWSER_ENGINE` | `playwright` | `playwright` (needs Node ≥ 20; any import failure auto-degrades) / `cdp-legacy` (zero-dep CDP pipe, core verbs only) |
| `TM_BROWSER_SNAPSHOT_MAX_TOKENS` | `1200` | hard cap on `take_snapshot` payloads |
| `TM_BROWSER_SUBRESOURCE` | `same-site` | what a page may load after its navigation was allowed: `same-site` = images/media/fonts/stylesheets always, scripts/XHR only for a site this session actually opened; `passive` = only the passive types; `off` = the legacy every-request gate. Blocked requests surface as a "N 个子资源请求被拦截" note on the next snapshot, and when the page has nothing addressable left the note says the blankness is ours and points at `allow_host` / this env var |
| `TM_BROWSER_IDLE_MS` | `180000` | an untouched browser session closes itself after this many ms (0 disables) and tells the user — a window nobody owns is a user-facing bug |
| `TM_BROWSER_ASK_EVAL` | `on` | `evaluate_script` runs arbitrary JS in YOUR browser — the one verb the domain allowlist can't cover (it limits where we navigate, not what a loaded page hands back). One official-dialog consent per browser session; no ask bridge ⇒ refused. `off` restores the old behaviour; the result redaction (JWT/bearer/cookie/api-key shapes) is NOT switchable |
| `TM_WEB_CACHE_TTL_SEC` | `300` | how long a governed fetch may re-serve the same URL (0 = off). One store shared by tm_webfetch / tm_search / the PTC bridge; entries are hash-named (a token-bearing query never hits disk) and are only read or written for hops the STATIC allowlist admitted — dialog consent stays per-request, and a re-served page says 缓存命中 |
| `TM_BROWSER_IMAGE_MAX_BYTES` | `400000` | ceiling on the JPEG `take_screenshot { image:true }` inlines into the model's context (above it the reply stays path-only and says why) |
| `TM_SEARCH_WEIGHTS` | unset | per-engine fusion weight overrides, e.g. `bing=0.3,hn=0.25`; anything unset keeps the built-in table |
| `TM_SEARCH_RELEVANCE_FLOOR` | `0.35` | weight fraction kept by a hit that shares no query token with its title/snippet/host (demotes junk without deleting an engine) |
| `TM_SEARCH_MAX_HITS` | `10` | hits kept per engine leg and in the fused list |
| `TM_SEARCH_DISABLED_ENGINES` | unset | engines removed from the roster AND from every `auto` route (`sogou,baidu` style) |
| `TM_BASH_TIMEOUT_PROBE_MS` | `60000` | ceiling forced onto a `timeout` the model set for a read-only probe command (0 disables) |
| `TM_BASH_TIMEOUT_MAX_MS` | `0` | optional global ceiling for every other bash command — off by default so a real build keeps the timeout it asked for |
| `TM_PTY_MAX` | `4` | concurrent `tm_pty` terminal sessions this plugin may keep running at once |
| `TM_JOIN_MAX_WAIT_MS` | `60000` | ceiling on `tm_join { waitMs }`. Was 300 000, and a lead parked in it twice in a row (19 min of nothing) while its children worked — waiting is not parallelism, so the default now says "check, then work". A second consecutive wait after nothing settled is cut to 10 s and answered with what to do instead |
| `TM_STORE_RECLAIM` | `on` | at boot, reclaim what an upgrade left behind: a per-workspace store shard idle past the TTL, and the pre-shard `blackboard/` + `trajectory/` under the temp-dir fallback (503 MB of expired runs on one real machine, with no sweeper pointed at them any more). Only TTL-expired entries are ever removed — a fresh run dir survives, because a session started before the upgrade may still be writing there. `off` leaves the disk exactly as found (the test runner sets it) |
| `TM_TASK_OFFLOAD` | `on` | keep the HOST's background sub-agent inside the context budget: when `task { background: true }` finishes, the host injects the child's full reply into your session; this replaces an oversized body with a preview + a `tm_fetch`-style pointer (`tm_join { ids: [...] }`), touching ONLY synthetic parts that carry the host's own `<task id=… state="completed">` envelope and exceed the text offload threshold. Nothing is copied to disk — the text stays where it was written (the child session). `off` restores the host's verbatim injection |
| `TM_TOOL_HINTS` | `on` | append TeamMode's call-site discipline to the built-in `bash` / `task` tool DESCRIPTIONS via `tool.definition` (append-only, idempotent — the host text is never replaced) |
| `TM_AGENT_TEMPERATURE` | `off` | `on` applies a per-role sampling table (architect 0.35 / researcher 0.3 / reviewer 0.1 / rest 0.2) via `chat.params`; or give it `reviewer=0.05;team=0.4`. Off = the documented "all agents at 0.2" invariant stands |
| `TM_COMPACTION_CONTEXT` | `on` | on the host's pre-compaction hook, add the must-survive list (reply skeleton, offload handles, open sub-agent session ids, provenance, board paths). Additive — the host's own summarizer prompt is never replaced |
| `TM_COMPACTION_AUTOCONTINUE` | `on` | `off` stops the host from silently resuming the turn after a compaction, so a human re-reads state first |
| `TM_SHELL_NO_COLOR` | `on` | inject `NO_COLOR`/`TERM=dumb` into every child shell via `shell.env` (ANSI progress bars are pure context tax). Never overwrites a value the host already set |
| `TM_SHELL_ENV` | — | explicit `KEY=VALUE;KEY2=VALUE2` passthrough into child shells — deliberately allowlisted, so this hook can't become a side channel for the parent environment |
| `TM_BROWSER_USER_DATA_DIR` | — (isolated temp profile) | explicit persistent profile dir — the ONLY way logins survive between sessions, and honored by BOTH engines (playwright and cdp-legacy). Use a DEDICATED directory (e.g. `D:\tm-browser-profile`) and log in by hand the first time; pointing it at your browser's own data dir (`…\Microsoft\Edge\User Data`, `google-chrome`, Firefox `Profiles`) is refused before anything spawns, because that would have the agent browse as you while a force-kill reaper owns the process |
| `TM_MEMORY_GLOBAL_DIR` | `~/.opencode-team/memories/global/` | tm_memory GLOBAL tier store |
| `TM_MEMORY_SESSION_TTL_MIN` | `240` | session-tier entry TTL (lazy + boot sweep) |
| `TM_MEMORY_MAX_ENTRIES` | `200` | per-scope entry cap; over it `add` fails on purpose — run `compact` |
| `TM_MEMORY_STALE_DAYS` | `30` | age after which search hits are tagged `[stale Nd]` (`0` disables) |
| `TM_MEMORY_SESSION_PERSIST` | — (ephemeral) | `1` also writes session entries under `memories/sessions/<sid>/` |
| `TM_HIT_BLACKLIST` | `maimai.cn` | extra domains never listed as search hits (comma/semicolon separated; same-name-different-site noise like 脉脉) |
| `TM_PTC_MAX_PROGRAM_CHARS` | `4000` | PTC program source cap |
| `TM_PTC_MAX_CALLS` | `20` | PTC per-run bridge-call budget (1–200) |
| `TM_PTC_MAX_ERRORS` | `3` | PTC per-run error budget (1–50) |
| `TM_PTC_TIMEOUT_MS` | `60000` | PTC per-run wall-clock timeout (5s–10min) |
| `TM_PTC_ENGINE` | `auto` | `auto` (worker→inline degrade) / `worker` / `inline` |
| `TM_PTC_WEB_BRIDGE` | `on` | expose `tm.search` / `tm.webfetch` to PTC programs (`off` removes them from the bridge set) |

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
- **Concurrent dispatch:** independent dispatches batch into the SAME round
  (parallel implementers with per-file ownership + verbatim contracts,
  3-dimension reviews, split test suites); only the Team Lead dispatches —
  specialists no longer hold `task`, so no sub-agent spawns a sub-agent.
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
It's the most guarded surface in the plugin: two full web roles plus a
browser-only tester grant, a domain
allowlist with dialog-gated escapes (you approve any out-of-allowlist
target in OpenCode's official dialog, with a toast notification), redirects
re-checked per hop, network-layer enforcement in the browser, env-file URL
refusal, and every payload rides the same offload governance. No allowlisted
page can bounce the fetch off-site.

**Why doesn't the plugin auto-update?**
OpenCode caches plugins by spec string and never re-resolves `@latest`
(upstream limitation, not ours). **Re-run the installer — that IS the
update** (it purges the cache and re-resolves npm copies); or delete the
cache dir by hand. Recipe above and in the
[installation guide](./docs/installation.md).

**Can agents run tools in parallel?**
Yes — and they're *engineered* for it: parallel `tm_search` / `tm_webfetch` /
`tm_fetch` calls get distinct step ids and isolated payloads. A regression
here fails the test suite before it ever reaches you.

**Does it work in the CLI (TUI), or only Desktop?**
Both. Desktop adds the color-coded picker and panels; the governed tools and
the whole workflow are host-agnostic. On display-less Linux, `tm_browser`
runs headless automatically.

**What happens if I don't answer a confirmation dialog?**
It auto-rejects after `TM_ASK_TIMEOUT_MIN` (default 1). The plugin never
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
├── docs/installation.md  ← The agent-consumable install guide (1.18.x)
├── docs/installation-v2.md ← The 2.x install guide (roles arrive as generated config files)
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
- [Installation guide, 1.18.x](./docs/installation.md) — the complete manual / agent-consumable procedure
- [Installation guide, **OpenCode 2.x**](./docs/installation-v2.md) — a different install: a 2.x plugin cannot create an agent, so the six roles and six commands are generated into the config directory
- [OpenCode Desktop](https://opencode.ai) — Official website & download
- [OpenCode Docs](https://opencode.ai/docs) — Configuration & plugin documentation
- [OpenCode Plugin API](https://opencode.ai/docs/plugins) — Build your own plugins
