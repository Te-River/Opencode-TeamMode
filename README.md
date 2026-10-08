# OpenCode TeamMode

**[English](./README.md)** | **[中文](./README.zh-CN.md)**

[![npm version](https://img.shields.io/npm/v/@te-river/opencode-team-mode.svg)](https://www.npmjs.com/package/@te-river/opencode-team-mode)
[![npm downloads](https://img.shields.io/npm/dm/@te-river/opencode-team-mode.svg)](https://www.npmjs.com/package/@te-river/opencode-team-mode)
[![license](https://img.shields.io/npm/l/@te-river/opencode-team-mode.svg)](./LICENSE)

> 🤝 **Your OpenCode just hired a team.**
>
> Six specialized agents — a Lead, an Architect, an Implementer, a Reviewer, a Tester and a Researcher — with governed tools, structured handoffs, and a plan-first approval gate. One plugin, no files to copy.

> 💡 **Best for medium-to-large projects.** The governance layer (approval gate, context offload, tool allowlists) is an asset once a codebase has real surface area — and mostly overhead on tiny scripts and one-off questions. Use it where the work is.

---

## TL;DR — skip the docs

> **The lazy path:** paste this to any coding agent and let it do the work:
>
> ```text
> Install the OpenCode plugin @te-river/opencode-team-mode. This package supports **OpenCode 2.x
> only** — the 1.18.x personality was removed in the 1.7.0 line:
> 2.x → https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/docs/installation-v2.md
> (a 2.x plugin cannot create an agent, so the six roles and six `/team-*` commands come
> from a generator step in that guide — that step is not optional.) Then verify the install
> using the checks in that guide.
> ```
>
> **The one command to remember afterwards:** `/team-run <task>` — the Team Lead
> plans it, shows you the plan, waits for your approval, then runs the whole team.

Everything else below is detail. When you're ready for it, here's the map:

**[Why](#-why-teammode) · [The team](#-the-team) · [Install](#-install) · [Usage](#-usage) · [Tools & security](#-governed-tools--security) · [Configuration](#️-configuration) · [How it works](#-how-the-team-works) · [Troubleshooting](#-troubleshooting) · [Uninstall](#-uninstall)**

---

## 🤔 Why TeamMode?

Because a single agent doing everything is how you get: a context window stuffed
with 5000-line file dumps, twenty round-trips to `shell` for what one script could
do, sub-agents that silently read `.env`, and web "research" that is really just
the model's imagination.

TeamMode's answer to each:

| Pain | TeamMode's answer |
|---|---|
| 🔥 **Context flooding** | Every governed result over its content-class offload boundary (prose 4000 / data 2000 tokens, CJK-aware) is offloaded to a local run store and replaced by an 80-token preview + an HMAC handle. The agent pages through what it needs — the window never drowns. |
| 🐌 **Round-trip overhead** | The host's own `execute` (Code Mode): the agent writes ONE program that makes N governed calls in a single turn. Zero LLM round-trips during the run. |
| 🕳️ **Silent side effects** | The R6 env-protection face: a Team role's `read` of a `.env` is **denied** with no consent path, and a shell command that reads the environment goes to the host's own permission prompt. The plugin never approves on its own — it can only reject. |
| 🌫️ **Hallucinated research** | Web access is a two-role grant with an allowlisted, governed tool chain. A fact that couldn't be fetched is reported as a gap — never fabricated. |
| 🧭 **Walls of text** | Replies are steered into the shape the host renders fastest: a markdown table for per-file / per-case / per-finding results, fenced code for diffs and configs, a browser screenshot attached as an inline image only when you ask for one. The renderer's supported set is measured rather than assumed, and the prompts carry the negative half of that measurement — footnotes, `==highlight==`, a bare `---` rule and `$…$` math reach you as literal text, so agents are told not to use them, while `mermaid` diagrams are offered because this host does draw them. |
| 🎯 **Goal drift** | The lead opens with `GOAL:` in your own words plus checkable `ACCEPTANCE:` criteria, and the run does not end while a criterion lacks evidence — the only legitimate stops are named (blocked on you, or provably unachievable). When a round settles with items still open on the lead's ledger, `tm_join` says 目标未达成 and lists them, and the goal is carried through context compaction so a summarized transcript cannot redefine it. |
| 🗣️ **Replies in a language you never chose** | The governed tools answer in Chinese, and an agent left to its own devices mirrors that straight back at you. Every role carries a reply-language rule: your own language wins, and a Chinese string is quoted verbatim only where it IS the evidence (a close verdict, a refusal line) — translating a verdict is how an unchecked claim starts looking checked. |
| ⏱️ **Rounds spent for the sake of looking careful** | 效率至上 is written into the lead and all five specialists: one wide call instead of three narrow ones, independent calls in the same round, ≥3 probes collapsed into one `execute` (Code Mode) program, no re-running a check to watch it pass again — with the boundary stated too: efficiency never buys its way out of the evidence rule, because an unverified "done" costs you the round *and* the bug. |

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
| 🏗️ **Architect** | System designer | Design docs, module structure, API contracts — **dispatched only when the design is genuinely unknown** |
| 💻 **Implementer** | Code writer | Building features, writing production code |
| 🔍 **Reviewer** | Dimension-focused auditor | Single-dimension review by default; 3 in parallel only for high-risk changes |
| 🧪 **Tester** | Test engineer | Tests with real edge cases; static verification (build / typecheck / lint); governed UI verification via the host's native `browser_*` tools |
| 🔎 **Researcher** | Knowledge finder | Local repo first, then the web — one of the two network roles (with the Lead) |

Out of the box, **Team is your default agent** — new chats open straight into the
orchestrator (opt-out in [Configuration](#️-configuration)).

---

## 📦 Install

### Option 1 — Let your agent do it (recommended)

Copy this into any coding agent — it will edit your config, restart-remind you, and verify:

```text
Install the OpenCode plugin @te-river/opencode-team-mode. This package supports **OpenCode 2.x
only** — the 1.18.x personality was removed in the 1.7.0 line:
2.x → https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/docs/installation-v2.md
(a 2.x plugin cannot create an agent, so the six roles and six `/team-*` commands come from
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
  "plugins": [
    "@te-river/opencode-team-mode@latest"
  ]
}
```

OpenCode installs the plugin on next startup.

> **The key is `plugins` (plural).** A 2.x host never reads the singular `plugin`
> key, and it installs the package itself from the entry at startup. Entries
> across config files are **applied lowest→highest rather than replacing one
> another**, so keep exactly one Team entry — writing ours into both
> `opencode.json` and `opencode.jsonc` loads the plugin twice. See
> [docs/installation-v2.md](./docs/installation-v2.md) for the 2.x flow (a plugin
> cannot create an agent there, so the six roles and six commands are generated
> config files);
> `docs/research/plugin-loader-contract.md` has the host's own loader code.

### ⚠️ Read this once, save yourself an hour later

- **Restart to activate.** After touching the OpenCode config, fully quit and restart OpenCode (Desktop: quit from tray, not just the window).
- **Plugin updates: re-run the installer.** It is idempotent — a re-run re-patches the config (no-op when present), purges the stale plugin cache, and re-resolves any npm-installed copy. This exists because OpenCode caches plugins by spec string and does NOT re-resolve `@latest` when a new version publishes (upstream limitation). Manual recipe, if you prefer:

  | OS | Purge command — recursive, covers BOTH cache layouts |
  |---|---|
  | macOS / Linux | `find ~/.cache/opencode/packages -type d -name '*opencode-team-mode*' -prune -exec rm -rf {} +` |
  | Windows (PowerShell) | `foreach ($r in "$HOME\.cache\opencode\packages", "$env:LOCALAPPDATA\opencode\cache\packages") { if (Test-Path $r) { Get-ChildItem $r -Directory -Recurse -Filter '*opencode-team-mode*' -EA SilentlyContinue | Sort-Object { $_.FullName.Length } | Remove-Item -Recurse -Force -EA SilentlyContinue } }` |

  ⚠️ OpenCode loads the plugin from `~/.cache/opencode/packages/` — possibly nested inside the scoped `@te-river/` directory — **not** from `~/.config/opencode/node_modules`, which is why the delete must recurse (a top-level-only `rm -rf` silently misses the scoped copy).

  ⚠️ **A published version can be shadowed by your HOME.** For a package spec the host resolves the entrypoint through the nearest `node_modules` walk starting at HOME, so a stray `~/package.json` with a `devDependencies` entry pinning `@te-river/opencode-team-mode` makes the host load *that* copy. The diagnostic is the boot probe's `entrypoint=` line, not a guess about cache layers. Full recipe (including an agent-driven update prompt): [installation guide, Updating](./docs/installation-v2.md).
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
blocks the lead and its card stays non-background. (On 2.x the plugin forces
`background: true` on every `subagent` call regardless — this flag is about the
*host's* `task` tool, which is the channel a human can watch.)

Undo it:

```powershell
# Windows — remove it from your user profile
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
content-class aware (`offloadThresholdText` = 4000 for prose: text/log/markdown;
`offloadThresholdData` = 2000 for json/csv/code/binary; an unknown class falls
back to the global `offloadThreshold`) — and oversized results are offloaded to a
run store and replaced by a content-aware preview plus an HMAC-signed handle that
the agent pages through with `tm_fetch` when it genuinely needs the payload.

| Tool | What it does | Roles |
|---|---|---|
| `tm_fetch` | Paged handle retrieval for offloaded results (JSON handles take a `fields` dot-path projection — a deliberately small jq subset like `items[].name`) | all six agents |
| `tm_memory` | Session + project + global memory store (Markdown + frontmatter): add / search / list / forget / compact | all six agents |
| `tm_board_write` | **The blackboard's write side**: places ONE new Markdown file at `<board-root>/<session-key>/<task-slug>/NN-<role>-<topic>[-rN].md` and chooses the name itself — a revision is a new round-suffixed file, never an overwrite, and the reply carries the path plus the byte count, never the content. It exists because the board used to need a file tool, and `architect` / `researcher` own none (no `write`, no `edit`, no `shell` even to stamp the session folder), so every oversized deliverable from those roles came back as `BLACKBOARD WRITE FAILED` plus the whole document pasted inline — the reply shape this team mandates was un-followable exactly where it mattered. Scope is enforced rather than asked: segments sanitized, target realpath-verified against the board root (a symlinked task dir is refused), the name always ends in `.md` so no `.env`/rc file can be produced, capped by `boardMaxChars` + a per-session file limit | All six agents |
| `tm_search` | Multi-engine web search with extracted, deduplicated, RRF-fused hit lists | Lead + Researcher |
| `tm_webfetch` | Single governed GET of an allowlisted page (search pages auto-extracted). Manual redirects, re-checked per hop, and a refusal names the WHOLE chain (`跳转链: a → b（停在第 2 跳）`) — an allowlisted shortener that bounces off-site used to report only the off-site host, which read as "that site will not fetch" and sent the agent back to retry the entry URL it had just watched fail. A 429/503 carries its own `Retry-After` when the server sends delta-seconds (an HTTP-date is deliberately not laundered into a countdown), so "come back later" never looks like "no content here". The page GET also asks for Markdown first (`Accept: text/markdown,…`) — measured on `learn.microsoft.com`: 60,778 B of HTML becomes 11,449 B of Markdown, and every other host tried returns the same document either way, so the preference is free where it is ignored | Lead + Researcher |
| `tm_ledger` | **The lead's task ledger** (`add` / `doing` / `done` / `blocked` / `list`), stored in the host's own `ctx.storage` per session — the landing spot for the LEDGER rule, since OpenCode 2.x gives a plugin no `todowrite`. A repeated ask is ONE item, an id that matches two is refused with both printed, `blocked` carries the reason, and a write that did not reach storage is reported as a failure rather than as recorded | Lead only |
| `tm_join` | **Sub-agent collection** — there is no plugin-side dispatcher any more (`tm_dispatch` is removed: a child a plugin creates is a session the user can neither open nor stop from the interface). Delegation goes through the host's own `task` / `task { background: true }`, and `tm_join` is the read side: a status snapshot, a bounded `waitMs`, `cancel:true` to stop a runaway, and `claimNamedChild` so `tm_join { ids: ["ses_…"] }` pulls one child's WHOLE reply back through the offload pipeline (handle + ≤80-token preview) instead of kilotokens inline. It also rebuilds its registry from the host session tree after a restart, so leftover children are 接管 rather than lost. **On 2.x it also registers the children the host's own `subagent` tool created** (the ack's `metadata.sessionID` is the seam), so a background dispatch is never reported as "nothing to collect" while the user watches it run — and such a row says where its reply actually arrives (the host's injected message) and whether it settled by event or by inference. **Stopping one is a real call:** `cancel: true` goes to the host's own `ctx.session.interrupt` on 2.x (`tm_join { ids: ["ses_…"], cancel: true }` stops ONE named child; without `ids` it stops every still-running one). The host's own contract is `interrupted=true` for an active execution and `false` for the idle no-op, so the answer comes back as **five distinct verdicts** — 已由宿主中断 / 空闲未中断（it wasn't running: our row was stale, not failed）/ 未确认（the call worked, no boolean came back）/ 无中断缝 / 被宿主拒绝（with the host's reason) — counted in the reply and written to the trajectory (`stop_tried` / `stop_confirmed` / `stop_refused` / `stop_unknown`, readable via `tm_stats`). It will not summarise five different facts as one "已取消", and `resume` is never sent, because resuming pending steering is the opposite of cancelling | Lead only |
| `tm_stats` | **The plugin reads its own trajectory back**: tokens kept out of the context window by offloading (net of the preview that arrived), seconds saved by dispatch overlap (serial cost minus the wall window the children actually used), governance counts (blocked subresources, clamped shell timeouts, cache hits, redactions) — plus the **host capability matrix** (`已验证/存在未用/待观察/缺失/需人眼` per host surface) and the **layered-config section** (per-key source, red-line keys a file tried to set and lost, unknown keys, skipped layers, auto-create state). Read-only over files this plugin wrote; run it first after an OpenCode upgrade. `{ recent: 20 }` appends a call-by-call recap — handle + payload path for every offloaded result, which is how you see what a governed tool actually returned (the host gives plugin tools no expandable card) | All agents |

> **The v1 (1.18.x) personality was removed in full for the 1.7.0 line.** The package
> exports `{id, setup}` and nothing else, so `tm_read` / `tm_grep` / `tm_bash` /
> `tm_ptc_run` / `tm_pty` are gone with it — the host's own `read` / `grep` / `glob` /
> `shell` and its `execute` (Code Mode) do that work now. The governance did NOT
> disappear with them: an oversized native result is offloaded through
> `tool.execute.after` (measured: `shell` 12,902 tokens arriving as a 78-token
> preview), and the address red line plus R6's per-command classification ride the
> host's `permission.evaluate`. `tm_ledger` is the lead's list where the host gives a
> plugin no `todowrite`.
> **Nothing we change reaches outside Team.** Every v2 hook fires for every session on
> the host, so the tool-surface trim, the 0.2 temperature, the blackboard note, the offload
> of native results, the R6/address strictening and the forced-background dispatch all ask
> "is this one of our six roles?" first — `build`, `plan` and your own agents stay as a
> fresh install leaves them. Calls whose owner the host did not tell us are left alone too,
> and counted (`tm_stats` prints `作用域：我们 · 他人 · 未判定`).
> The installer writes the six
> role prompts, which name `read` / `grep` / `shell` instead of the removed aliases.

> **On OpenCode 2.x, interactive browsing is the host's, and it stays ours.** The
> desktop renders a browser in its side panel, and that panel attaches to the
> server's own browser service — a plugin cannot register a page of its own into it
> (forensics: `docs/research/browser-pane.md`). So the three roles with network
> grants (lead, researcher, tester) are pointed at the host's `browser_*` tools
> — the self-built `tm_browser` was removed in 1.7.0, so the host's catalog is the
> only browser. On a host with no native browser catalog (CLI, standalone) there is
> now no browser at all, and the agent reports that gap rather than simulating one.
> Handing browsing over did not mean handing
> governance over: `permission.evaluate` was observed NOT firing for `browser_*`, so
> our gate sits on `tool.execute.before` instead — it classifies the URL of every
> navigate/open, the path of every `browser_preview`, and every browser URL named
> inside an `execute` program, refuses the ones out of policy, and if the host runs a
> refused call anyway it replaces the page with the same refusal, so no
> out-of-policy content reaches the context, the store or the trajectory. What we
> cannot do is un-make a request the host already performed, and the reply says so
> rather than claiming a block; `tm_stats` prints the two numbers apart (refused /
> leaked past the refusal). One exception to the offload rule lives here: a
> `browser_snapshot` is an addressing table, not a document, so it is CAPPED (every
> `[ref=…]` line kept, static text dropped, budget `nativeSnapshotMaxTokens`
> default 1 200) rather than replaced by a
> handle. Measured on a 261-ref page: a head cut keeps 118 refs, this keeps 261 of
> them using 1 044 of 11 326 tokens.

> **Fixed tool priority ladder (every task): ① the user's own MCP/plugin
> tools → ② TeamMode governed tools (`tm_*`) → ③ the model's own reasoning.**
> It doubles as the fallback chain: when a tool errors (no browser on this
> host, blocked host), the agent says so and drops to the next rung — and
> rung ③ is where a missing capability gets reported, never fabricated.
> One stated exception: on the **web** channel `tm_search` / `tm_webfetch` come
> first, because that path is the only one carrying the
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
> (`taskOffload: "off"` restores the host's verbatim text). Cost of the host
> path, stated plainly: each finished background task wakes the lead and costs a
> turn. `tm_join` is the read side that stays — it pulls a named child's whole
> reply back through the offload pipeline, stops a runaway, and rebuilds its
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
`offloadThresholdText`, structured data → `offloadThresholdData`,
unknown → global `offloadThreshold`) are written to a local run store
(`<repo>/.git/opencode-team/`, never your working tree) and replaced by a
handle with a content-aware preview: JSON keys / CSV header + shape / log
ERROR×N stats / code signatures / binary metadata, hard-capped at 80 tokens
(`previewMaxTokens`). When the agent actually needs the payload, it pages
through with `tm_fetch` using an HMAC-signed, run-scoped, expiring handle — and
on a JSON handle it can ask for a `fields` dot-path projection instead (a
deliberately small jq subset: `items[].name`, `[].stargazers_count`), so a big
API dump narrows to just the values needed without the raw body ever entering
the window.

The same pipeline governs the **host's own tools**, not just ours — an
oversized native result is rewritten at `tool.execute.after` into the same
preview + handle shape. Report-shaped results are the third outcome: a table
with a hole in it is not a table, so a result carrying a Markdown table is
**capped keeping its table lines** (`nativeReportMaxTokens`) and the prose
between them is what goes.

### Session + project + global memory (tm_memory)

Durable facts — build commands, environment quirks, architecture decisions,
your conventions — live as human-editable Markdown with frontmatter, in
THREE tiers:

- **`session`**: this conversation's transients only — in-process, TTL-swept
  (`memorySessionTtlMin`, default 240 min), invisible to other
  sessions; ephemeral unless `memorySessionPersist: "1"` writes them under
  `memories/sessions/<sid>/`.
- **`project`** (default): `<repo>/.git/opencode-team/memories/…` — per checkout, git-adjacent. Facts about THIS repo: build commands, environment quirks, architecture decisions.
- **`global`**: `~/.opencode-team/memories/global/` (override `memoryGlobalDir`) — **follows you across ALL projects**. User-level conventions: preferred package manager, commit style, tooling habits.

Actions: `add` / `search` (deterministic keyword scoring) / `list` / `forget` /
`compact`; 4000 chars per memory. `search` walks ALL tiers with **session >
project > global precedence** — project entries get a +2 near-tie weight and a
same-title higher-layer twin shadows the lower one (it never surfaces).
Near-duplicates never pile up: an `add` that hits an existing entry in the same
tier and category (dedup key, or title+keywords Jaccard ≥ 0.6) **folds into
it** — new content wins, keywords union, the old slug moves to `supersedes:`,
and the answer says 已合并 (that is normal; don't re-add under a variant title).
When a tier reaches `memoryMaxEntries` (200 per scope) the add fails on
purpose: run `compact` first — it dry-runs the merge plan by default, and
re-running with `apply:true` performs it after copying every original to a
timestamped `.compact-backup` tree (the rollback path). Entries older than
`memoryStaleDays` (30) surface tagged `[stale Nd]` in search. Agents
are prompted to search before assuming conventions and to save hard-won
facts for the next conversation.

### 🌐 Web search that actually works (in China)

`tm_search` is the open-ended-lookup front: **one call, one query, clean
results**. The engine URL is built for you, fetched through the governed
pipeline, and collapsed into a numbered title+URL hit list — the agent never
sees raw SERP chrome.

| Engine | Notes |
|---|---|
| `auto` (default) | Classifies the query, fans the matching engines out **in parallel** (every route has ≥2 legs, because a hit two engines agree on is worth more than one engine's opinion of itself), dedupes by host+path and fuses them with weighted RRF into a top-10 list tagged with each hit's source engine(s). Ranking is scaled by real query-token overlap (floor `searchRelevanceFloor`), so a trusted engine's off-topic junk no longer outranks another engine's best hit. Routing: errors / camelCase APIs → `stackoverflow`+`github`+`bing`; dev-ecosystem (releases, frameworks, open source) → `hn`+`github`+`npm`; Chinese → `bing`+`moegirl`+`stackoverflow`+`hn`; other → `bing`+`stackoverflow`+`hn`+`github`. Pin another default via `searchDefaultEngine` |
| `bing` | cn.bing.com — the only live CN HTML SERP; multi-word CJK queries get their phrase boundary protected (quoted) so markup shuffle can't split the result list |
| `bing-int` | The same host with `&ensearch=1` for English results. It is deliberately **out of every `auto` route** — two layouts of one index would give bing a double vote |
| `stackoverflow` | api.stackexchange.com question search (no key, 300/day/IP) → numbered questions with composite snippets; `auto` tracks the quota and swaps in `bing` once spent |
| `hn` | Hacker News via Algolia API (no key) → story titles + snippets with direct article URLs |
| `bilibili` | video search |
| `moegirl` | MediaWiki search API — entry titles + snippets, structured |
| `npm` | registry search → name@version + description, structured |
| `github` | repo search API → stars + description, structured; `org:` / `user:` / `stars:` / `language:` qualifiers fold into the query (e.g. `vector db stars:>500 language:rust`) |

All the HTML engines are reachable from mainland China **without API keys**, and
every one of them sits on the seeded domain allowlist. The previous CN HTML
SERPs (`sogou` / `so` / `baidu`) were **removed** — a live
benchmark (2026-09-14) showed them serving anti-bot shells or 100% empty
results; they are not even manually selectable. On an empty result,
the error names the alternative engines instead of leaving the agent stuck.
Two more channels complete the surface:

- `tm_webfetch` — a known URL, one governed GET. Search-engine pages it
  fetches are auto-extracted to hit lists too. JSON endpoints like
  `registry.npmjs.org/<pkg>/latest` pass through untouched.
- **Interactive browsing is the host's own `browser_*` tools** (`browser_tabs_open`
  · `browser_navigate` · `browser_snapshot` · `browser_click` · `browser_evaluate`
  …). The self-built `tm_browser` was **removed in 1.7.0** (a breaking change):
  the desktop renders a browser in its side panel and that panel attaches to the
  server's own browser service, so a plugin cannot register a page of its own
  (forensics: `docs/research/browser-pane.md`). The host catalog is policed by
  `src/host/v2-browser-gate.ts` at `execute.before` — the URL of every navigate/open,
  the path of every `browser_preview`, and every browser URL named inside an
  `execute` program are classified against the address red lines and the env-file
  rule, and a refused call the host runs anyway has its page replaced with the same
  refusal, so no out-of-policy content reaches the context, the store or the
  trajectory. Calling convention differs from the deleted tool: `evaluate` takes
  `{tabID, script}` where `script` is an **expression** (not function source) and
  the return value must be a scalar you `JSON.stringify` yourself; snapshot tokens
  read `@e8 [link]`. **Known cost, accepted:** on a host with no native browser
  catalog (CLI / standalone) there is now no browser at all — the agent reports that
  gap rather than simulating one.

When a fetch still returns **403 after the real-Chrome headers**, the error
is a DIRECTIVE: the gate is JS-challenge / TLS-fingerprint based and only a
real browser passes — the agent is told to open that URL with the host's
native `browser_navigate` (and read it with `browser_snapshot`). Search hit lists also
filter known noise: engine-internal wrappers (`so.com/link?`, `ai.so.com`)
and same-name-different-site domains (`maimai.cn` 脉脉 vs the maimai DX
game) never ride along — extend the hit blacklist with `hitBlacklist`.

Seeded allowlist (all three web tools; 22 hosts — baidu/moegirl/bilibili are
PARENT domains, so every sibling subdomain — baike.baidu.com,
mzh.moegirl.org.cn, space.bilibili.com — is covered):
`baidu.com`, `bdimg.com` (Baidu's own script + asset CDN — not a baidu
subdomain, and a page whose bundle we block is a blank page we would then
report as "no content"), `moegirl.org.cn`, `bilibili.com`, `www.sogou.com`,
`www.so.com`, `cn.bing.com`, `www.bing.com`, `zhihu.com`, `juejin.cn`,
`csdn.net`, `cnblogs.com`, `gitee.com`, `github.com`, `api.github.com`,
`raw.githubusercontent.com`, `gist.githubusercontent.com`, `ghproxy.net`
(mainland mirror for github raw), `stackoverflow.com`, `npmjs.org`, `pypi.org`,
`learn.microsoft.com` — plus the two JSON search-engine hosts
(`api.stackexchange.com`, `hn.algolia.com`) while the default seed is in play,
so 24 effective. Extend via `webfetchAllowedDomains` (`"*"` opens every host; a
custom list REPLACES the seed, so keep the engine hosts or `tm_search` loses its
targets). Architect / implementer / reviewer have NO network grant — web
questions come back as a reported gap, never simulated. The tester carries the
host's native `browser_*` tools ONLY, for governed UI verification of the project
(local dev servers, preview routes); open web fetching stays with the two
network roles.

**Out-of-allowlist targets are a gate, not a wall.** When a fetch / search /
browser-open points at a host outside the allowlist, the governed call **fails
closed with a refusal naming the exits** — on 2.x a plugin cannot raise the
host's dialog, so there is no window to wait for and a gate with no door is not
a gate. Your doors are `privateSpace: "allow"` in `team-mode.jsonc`, or that one
hostname in `webfetchAllowedDomains`. Below that gate sit the classes no config
opens: cloud-metadata / link-local / multicast / reserved / benchmarking ranges
are refused outright with no consent path, including their IPv4-mapped and
DNS64 spellings (changing the notation is not a bypass), and env-file URLs and
non-http(s) schemes are hard-rejected.

### Security: R6 env protection + R2 dangerous operations

**R6 is armed by default, and it is a `strict` default.** `envProtect` accepts
`strict` / `standard` / `off` and resolves to `strict` by default. With TeamMode
active:

- **Env-FILE reads are a hard `deny`** — a Team role's native `read` /
  `edit` / `glob` / `grep` of a `.env` is refused with no consent path. The
  host's `grep` reports the *pattern* as its permission resource rather than the
  path, so the same rule also runs on the whole tool input (`grep SECRET .env`
  cannot slip through). Templates (`*.env.example` / `.sample` / `.template` /
  `.dist`) stay readable.
- **Env-variable reads in a shell command go to the host's permission prompt**
  (`ask`). The per-command classifier decides, so an ordinary `git status` asks
  nothing and an env dump still does; env reads no wildcard can express
  (embedded `$VAR` / `${VAR}` / `$env:` inside another command, command
  substitution) are **never** asked — they are refused. The audit log records
  only tool name + pattern category + verdict — never command text, paths,
  variable names or values.

**R2 dangerous operations (the same face).** Delete, git publish, network
fetch, package install/publish, process/system, privilege changes — none are
silently allowed. The normal verification stack (`npm test`, `tsc`,
`git status`) is NOT gated, so day-to-day work runs uninterrupted.

**The plugin never self-allows.** Every hook it registers can only make a rule
*stricter*; a permission it is asked about is replied `deny` or left alone, never
`allow`.

> ⚠️ **When you approve the host's own dialog, pick "once" — not "always".**
> Verified on the live host, "always" records a far broader rule than the command
> you saw: approving `Get-ChildItem env:PATH` with "always" stores `Get-ChildItem
> *`, so every later `Get-ChildItem` runs with no dialog at all. The web channel
> has the same trap and it is easier to fall into: one "always" on a host lets
> **every agent session in that project** open it. The reply says which path let
> a page in (static allowlist / the dialog you just answered / a saved rule that
> answered in milliseconds), because an agent that cannot tell them apart reports
> "no dialog" as "that site is allowed".

> Deferral is per-session: the env face only applies in sessions running
> TeamMode's generated roles. In any other session the plugin leaves the host's
> behaviour exactly as it found it.

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

**Configuration is JSON, and only JSON.** `team-mode.jsonc` is the single
configuration source. There is no environment layer, and **no `TM_*`
configuration environment variable exists any more** — the ones you may still
find in old configs are simply unknown keys, reported at boot and never applied.
(Three `TM_*` names survive as internal/test switches, listed at the end of
this section.)

### Where the file lives

| Layer | Path | Precedence |
|---|---|---|
| **global** | `~/.config/opencode/team-mode.jsonc` (honours the host's `OPENCODE_CONFIG_DIR`) | lowest — applies to every project |
| **project** | `<dir>/team-mode.jsonc`, for every directory from the workspace **up to the filesystem root** | higher — direct files merge farthest→closest |
| **project** | `<dir>/.opencode/team-mode.jsonc`, same walk | **highest** — every `.opencode/` file overrides every direct file |

That walk and precedence are the host's own config-layering rule, copied rather
than invented. JSONC is supported: `//` and `/* */` comments are masked at the
byte level, so a commented-out key cannot read as a live one. A layer that fails
to parse is skipped **whole** (half a config is worse than none) while a single
bad key loses only itself; unknown keys are warned about and never applied.
`tm_stats` renders the result: per-key source, skipped layers, unknown keys, and
the auto-create state.

### It writes itself

When the global file is **absent**, the plugin creates it at boot — atomically,
idempotently, and **never overwriting an existing file**. What it writes is an
**inert** template: all **59** registry keys, each as a *comment* under a
one-line description, so the file parses to `{}` and sets nothing until you
uncomment what you want.

```jsonc
// 全局配置。取消注释即可生效；默认全部注释 = 什么都不设置。
{
  // "offloadThreshold": 2000,            // 卸载阈值（估算 token；等于阈值也卸载）。
  // "envProtect": "strict",              // R6 环境防护模式（strict/standard/off）。（红线：仅全局）
  // …共 59 个键，每个都带一行说明
}
```

Turn it off with the plugin option `autoCreate: false`, or the internal switch
`TM_CONFIG_AUTOCREATE=off`.

### Red-line keys

Five keys are **honored only in the global file**: `envProtect`, `r6FineAsk`,
`privateSpace`, `webfetchAllowedDomains`, `bashReadonlyAllowed`. A project file
may set them, but the value is **ignored and reported** — a committed project
config must not be able to switch off a guard for everyone who clones the repo.
The rule is derived from the registry itself (`redLine: true` on the spec), so a
new red-line key is red-line by declaration.

### Plugin options

Options live on the plugin entry, not in `team-mode.jsonc`:

```jsonc
{
  "plugins": [
    { "package": "@te-river/opencode-team-mode@latest",
      "options": { "defaultAgent": true, "autoCreate": true, "ttlDays": 7, "envProtect": true } }
  ]
}
```

| Option | Default | Meaning |
|---|---|---|
| `defaultAgent` | `true` | Promote Team to the default agent slot. Opt out with `false`. |
| `autoCreate` | `true` | Write the inert global `team-mode.jsonc` at boot when absent. |
| `ttlDays` (alias `blackboardTtlDays`) | `5` | Blackboard retention, valid range (0, 365]. |
| `envProtect` | `true` | Plugin-wide kill switch; `false` resolves the R6 mode to `off`. |
| `temperature` | `false` | `false` = the documented 0.2 invariant; a number overrides it. |

On 2.x a plugin entry is either a **string** or an **object** with `package` and
`options`. The 1.x tuple form `["@te-river/…", { … }]` is rejected
(`path=$.plugins.1 kind=invalid`, measured 2026-10-06). Options do arrive — with
the object form the boot row reads `board_ttl_days=9` for `{ "ttlDays": 9 }`, so
this is measured, not documented-and-hoped.

### Model choice

Every judgment — triage, decomposition, dispatch briefs, synthesis, review
verdicts — flows through the Team Lead. A weak model in that seat degrades the
whole pipeline no matter how strong the specialists are. Pin your best reasoning
model to `team`:

```jsonc
{
  "agent": {
    "team": { "model": "anthropic/claude-opus-4-5" },      // Lead earns your best model
    "implementer": { "model": "anthropic/claude-sonnet-4-6" } // specialists tolerate cheaper
  }
}
```

Your own agents named `team` / `architect` / … always take precedence; the
plugin never clobbers user definitions. See [Customization](#-customization)
for overrides, extra agents and disabling roles.

### Key reference (all 59)

**Offload, previews and the store**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `offloadThreshold` | number | `2000` | Global offload boundary (estimated tokens, CJK-aware), used when the content class is unknown. A result AT the threshold offloads. |
| `offloadThresholdText` | number | `4000` | Boundary for prose (text / log / markdown). Inherits the global value unless set. |
| `offloadThresholdData` | number | `2000` | Boundary for structured payloads (json / csv / code / binary). Same inheritance. |
| `previewLines` | number | `20` | Raw lines a preview builder may scan. |
| `previewMaxTokens` | number | `80` | Hard preview cap. |
| `fetchMaxLines` | number | `2000` | `tm_fetch` per-segment line cap. |
| `blackboardDir` | string | auto | Run-payload store dir. Empty = `<repo>/.git/opencode-team/blackboard`. Explicit = absolute or project-relative. |
| `trajectoryDir` | string | auto | Trajectory store dir. Empty = `<repo>/.git/opencode-team/trajectory`. |
| `blackboardTtlDays` | number | `7` | Handle TTL and the physical sweep period for expired run dirs. |
| `storeReclaim` | `on`/`off` | `on` | At boot, reclaim what an upgrade left behind: a per-workspace shard idle past the TTL, and the pre-shard `blackboard/` + `trajectory/` at the temp-dir fallback. **Only TTL-expired entries are ever removed** — a fresh run dir survives, because a session started before the upgrade may still be writing there. `off` leaves the disk exactly as found. |
| `taskOffload` | `on`/`off` | `on` | Keep the host's background sub-agent inside the context budget: when it finishes, the injected full reply is replaced by a preview + a `tm_join` pointer. Touches only synthetic parts carrying the host's own `<task id=… state="completed">` / `<subagent … state="completed">` envelope and over the text threshold — a typed message is never touched even if it contains a perfect envelope, and a `state="error"` child is never rewritten. **Nothing is copied to disk**: the text stays where the child session already wrote it. `off` restores the host's verbatim injection. |
| `boardMaxChars` | number | `200000` | `tm_board_write` per-file character cap — over it the write **refuses** (with a "split the topic" hint) rather than truncating a deliverable. |
| `boardMaxFiles` | number | `200` | Markdown files allowed per session folder. The TTL sweeper is the only reclaim path, so the refusal names it. |
| `joinMaxWaitMs` | number | `60000` | Ceiling on `tm_join { waitMs }`. Was 300 000, and a lead parked in it twice in a row (19 min of nothing) while its children worked — waiting is not parallelism, so the default now says "check, then work". A second consecutive wait after nothing settled is cut to 10 s and answered with what to do instead. |
| `ledgerMaxItems` | number | `200` | Ceiling on `tm_ledger` items per session. The host's `ctx.storage` has no TTL and no quota (measured), so the list refuses to grow past this instead of quietly dropping the oldest asks — and a refusal is something the lead can act on, while a silent truncation is a claim nobody can re-check. |

**Memory**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `memoryGlobalDir` | string | auto | GLOBAL tier store. Empty = `~/.opencode-team/memories/global`. |
| `memorySessionTtlMin` | number | `240` | Session-tier entry TTL (lazy + boot sweep). |
| `memoryMaxEntries` | number | `200` | Per-scope entry cap; over it `add` fails on purpose — run `compact`. |
| `memoryStaleDays` | number | `30` | Age after which search hits are tagged `[stale Nd]` (`0` disables). |
| `memorySessionPersist` | string | `""` | `""` = in-process only; `"1"` also writes session entries under `memories/sessions/<sid>/`. |

**Web and search**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `webfetchAllowedDomains` | string[] | 22-host seed | **red line.** Outbound allowlist (`"*"` = any host; `[]` = deny all). A custom list **replaces** the seed — keep the engine hosts. `"*"` does **not** cover private space: loopback / RFC1918 / CGNAT / `.localhost` still need `privateSpace: "allow"`, and non-routable ranges (169.254.0.0/16 metadata, 0.0.0.0/8, multicast, reserved, plus the IPv4-mapped and DNS64 spellings of the same target) are a hard red line no setting opens. |
| `searchDefaultEngine` | string | `auto` | Engine when no `engine` arg is given (`auto` = classify + parallel fan-out + RRF fusion; any table name also pins a manual default). |
| `searchMaxHits` | number | `10` | Hits kept per engine leg and in the fused list. |
| `searchWeights` | record | `{}` | Per-engine fusion weight overrides, e.g. `{"bing": 0.3}`; anything unset keeps the built-in table. |
| `searchDisabledEngines` | string[] | `[]` | Engines removed from the roster AND from every `auto` route. |
| `searchRelevanceFloor` | number | `0.35` | Weight fraction kept by a hit sharing no query token with its title/snippet/host (demotes junk without deleting an engine). |
| `hitBlacklist` | string[] | `[maimai.cn]` | Extra domains never listed as search hits (same-name-different-site noise like 脉脉). Merged with the built-in entry. |
| `webCacheTtlSec` | number | `300` | How long a governed fetch may re-serve the same URL (`0` = off). One store shared by `tm_webfetch` / `tm_search`; entries are hash-named (a token-bearing query never hits disk) and are only read or written for hops the STATIC allowlist admitted — so a hit can neither resurrect a removed host nor substitute for consent. A re-served page says 缓存命中. |

**Rounds, dispatch and context**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `maxConcurrentSubagents` | number | `3` | Hard cap on concurrent `subagent` calls (`0` disables). Measured: `permission.evaluate` really fires for that action, so this is a gate and not a suggestion. |
| `prune` | `on`/`off` | `on` | Context pruning: replace a SETTLED message body with a self-explaining pointer (an offload handle, a child id, a note). Evidence is never destroyed — the reply skeleton, GOAL/ACCEPTANCE, provenance, system messages, a still-running child and an uncollected child id are protected whole, and the untouched messages stay byte-exact. `off` disables. |
| `pruneAtPercent` | number | `70` | Prune once the request reaches this share of the model's window, derived from `limit.context` — never a hard-coded token count. **Clamped to 40–90.** |
| `pruneKeepTailPercent` | number | `40` | Share of the window kept verbatim at the tail; the newest message is always kept. |
| `splitAdvice` | `on`/`off` | `on` | Inject a split suggestion when a dispatch brief carries too many acceptance criteria. `off` stops the hint (the prompt discipline stays). |
| `splitBriefTokens` | number | `4000` | The brief token threshold that triggers it. **Clamped to ≥200.** |
| `splitMaxCriteria` | number | `3` | More acceptance criteria than this is a signal to split. |
| `retry` | `on`/`off` | `on` | Retry governor: classify a quota / rate / transient / unknown error **by name and text only**, compute jittered backoff, and inject ONE directive naming the exact seconds to wait. After `retryBreakAfter` consecutive errors a cooldown denies new `subagent` dispatches. Honest boundary: there is no seam to intercept the model's own retry — it identifies, states the wait, and refuses new work; it does not wait for the model. |
| `retryBaseMs` | number | `5000` | First backoff; doubles per consecutive error. |
| `retryMaxMs` | number | `60000` | Ceiling for that backoff. |
| `retryJitter` | number | `0.3` | ± fraction applied to the wait, so parallel sessions do not re-fire together. |
| `retryBreakAfter` | number | `5` | Consecutive errors before the breaker trips. |
| `retryCooldownMs` | number | `60000` | How long new sub-agent dispatches are refused once it has. |

**Host-surface governance (2.x)**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `nativeOffload` | `on`/`off` | `on` | Govern the HOST's own `read`/`grep`/`glob`/`shell` results through the same pipeline. `off` restores the host behavior; the boot line distinguishes "you turned it off" from "this host has no execute.after". |
| `nativeSnapshotMaxTokens` | number | `1200` | Budget a native `browser_snapshot` keeps in context. Addressing lines win it before static text does; past `budget × 4` the reply states how many ref lines did not fit, and kept + dropped always equals the total. |
| `nativeReportMaxTokens` | number | `1600` | Budget a report-shaped native result (anything carrying a Markdown table) keeps. Table lines and their headings win the space; the full text still rides the handle. |
| `probeChain` | `on`/`off` | `on` | After a run of native `read`/`grep`/`glob`/`shell` passes, append ONE line naming `execute` (Code Mode) and what it saves. A hint, never a gate: the original body is preserved verbatim, nothing is rejected, and the append is idempotent. |
| `probeChainAfter` | number | `3` | How many consecutive native calls before the hint starts (`0` = off). |
| `v2BrowserGate` | `on`/`off` | `on` | The gate over the host's `browser_*` catalog (URLs and preview paths at `execute.before`, plus the browser URLs named inside an `execute` program). `off` restores ungoverned browsing; the boot line and `tm_stats` say which world is running. |
| `v2CodeMode` | string | `""` | `direct` sends `options.codemode=false`; empty = catalog mode. We used to send `direct` by default and claim direct delivery — **a live 2.0.16 desktop session disproved it**: with the flag sent, every `tm_*` still arrived inside the host's Code Mode catalog, so the default now sends nothing. The observable truth is `tools_in_request` in `tm_stats` (请求内实际可见=…), never the flag we sent. |
| `bashTimeoutProbeMs` | number | `60000` | Ceiling forced onto a `timeout` the model set for a read-only probe command. Applies ONLY to a command the read-only allowlist already accepts, and never invents a timeout the model omitted (`0` disables). |
| `bashTimeoutMaxMs` | number | `0` | Optional global ceiling for every other shell command. `0` = off, so a real build keeps the timeout it asked for. |
| `envProtect` | `strict`/`standard`/`off` | `strict` | **red line.** R6 mode. `off` also disarms the shell escalation. Any unrecognised value resolves to `strict`. |
| `r6FineAsk` | string | classifier | **red line.** `off` falls back to asking about EVERY shell command — which is also what happens automatically on a host that does not expose the per-action evaluation hook, and the boot note says which of the two caused it. |
| `privateSpace` | `allow`/`deny`/`ask` | `deny` | **red line.** Private space (loopback, RFC1918, ULA, CGNAT, `.localhost`) through our tools. The default is `deny` because a 2.x plugin cannot raise a dialog — telling the agent to wait for a window that will never open is not a gate with a procedure, so `ask` is the honest spelling of "not answerable" and an unrecognised value falls back to it. Never conflated with the FORBIDDEN ranges. |
| `bashReadonlyAllowed` | string[] | built-in | **red line.** The P3 read-only command allowlist. `tasklist` / `ps` / `findstr` are seeded in, because `已确认关闭` is only checkable if the agent can ask the OS for the pid — a user-facing verification with no read path is the same defect as a lie. |

**Legacy keys** — kept listed and parseable so an old config still loads, with
**no v2 reader**, and reported as such:

| Key | Default | Status |
|---|---|---|
| `askTimeoutFloorMin` | `1` | **Orphaned.** Its only consumer was the v1 approval gate, which was deleted (a 2.x plugin cannot raise a dialog, so there was nothing to time out on). Say so rather than leaving a knob that does nothing. |
| `agentTemperature` | `""` | v1-only |
| `compactionContext` | `on` | v1-only |
| `shellEnv` | `""` | v1-only |
| `ptcWebBridge` | `on` | v1-only |

> **Compaction timing belongs to the host, not to this plugin.** An earlier
> release triggered its own summarization at 75% of the window; that was removed
> by user decision — a plugin that summarizes a live conversation by itself
> takes a context-losing action you did not ask for. What remains is additive and
> runs only when the HOST compacts: the must-survive list (reply skeleton,
> offload handles, open sub-agent session ids, provenance, board paths) rides the
> host's own `session.hook("compaction")`, and the host's summarizer prompt is
> never replaced.

### The three surviving `TM_*` names

These are **internal / test switches**, not configuration — they are read from
the environment because a test or a diagnostic needs them without a config file:

| Name | Effect |
|---|---|
| `TM_STORE_RECLAIM` | Overrides the `storeReclaim` key (`off` = leave the disk exactly as found). The test runner sets it, because suites boot real runtimes in temp dirs. |
| `TM_V2_PROBE` | Path to a JSONL file where the surface probe records the host's real tool ids, permission action names and argument key **names**. Names and counts only — never a command line, path, URL or env value. It is how "does the host actually have X?" gets answered from the running build instead of from a doc. |
| `TM_CONFIG_AUTOCREATE` | `off` suppresses the inert global-file auto-create. |

Any **other** `TM_*` name in your environment is inert. If you have been setting
one, move it into `team-mode.jsonc` under the matching key above.

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
- **One dispatch, one verifiable deliverable.** A dispatch is a unit of
  VERIFIABLE work, not a bucket for everything related. If the lead cannot say
  how a child's result will be verified *on its own*, it is not a dispatch yet —
  it is a wish. Cutting one deliverable into pieces that only make sense
  together is chopping, not splitting, and it costs you more rounds than it
  saves.
- **The architect is conditional.** Dispatch it only when the design is
  genuinely unknown. With the root cause already verified (file:line evidence),
  skip it and dispatch the implementer with the exact fix spec; if the fix moves
  a contract or the strategy is undecided, keep the architect. The ceremony
  serves unknowns, not multi-file diffs.
- **Tester and reviewer may run in the SAME round** — verification and review
  are independent of each other. Serialise them only when a fix invalidates
  both. Same for multiple implementers (each carrying its exact file ownership
  and verbatim data contracts) and testers on disjoint packages.
- **Approval gate (count-based):** ≥2 dispatches → plan (≤30 lines) → **your
  approval** → execute. Blocking questions are batched and asked immediately.
  Splitting one ask into sub-2-dispatch pieces to dodge the gate is a protocol
  violation, not a trick.
- **Only the Team Lead dispatches.** Specialists no longer hold the host's
  `task`/`subagent` capability, so no sub-agent spawns a sub-agent.
- **Adaptive review:** one reviewer by default; three parallel dimensions
  only for high-risk profiles (auth/security, cross-module contracts, public APIs).
- **Static verification:** build / typecheck / lint / tests. Improvised
  browser automation is banned; unverified UI work ends with
  `UI NOT VERIFIED: <what to check>`.
- **Evidence standard:** "done / fixed / passed" claims need verifiable
  evidence — output, logs, diffs.
- **Your language, not the tool's.** The governed tools answer in Chinese; the
  reply-language rule keeps your own language in the prose and quotes a Chinese
  string verbatim only where it IS the evidence.

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

Board retention, auto-create, the default slot and the R6 kill switch are
plugin-entry `options` — see
[Configuration](#️-configuration).

---

## ❓ Troubleshooting

**Will this eat my tokens?**
The opposite is the point. Offload + 80-token previews + the host's Code Mode
`execute` exist because a five-agent pipeline naively bolted onto one context window
*would* eat your tokens. The governance is the token-saver.

**Is the web access safe?**
It's the most guarded surface in the plugin: two full web roles plus a
browser-only tester grant, a domain allowlist whose off-list calls fail closed,
redirects re-checked per hop with the whole chain reported, env-file URL
refusal, address red lines no setting opens, and every payload rides the same
offload governance. No allowlisted page can bounce the fetch off-site.

**Why doesn't the plugin auto-update?**
OpenCode caches plugins by spec string and never re-resolves `@latest`
(upstream limitation, not ours). **Re-run the installer — that IS the
update** (it purges the cache and re-resolves npm copies); or delete the
cache dir by hand. If the boot probe's `entrypoint=` line names a path outside
`~/.cache/opencode/npm` or `~/.config/opencode/node_modules`, a `~/package.json`
is pinning a different copy — that is the diagnostic, not a guess. Recipe above
and in [docs/installation-v2.md](./docs/installation-v2.md).

**A knob I set in an env var does nothing.**
Configuration is JSON now. Any `TM_*` variable other than the three internal
switches is inert; move the value into `team-mode.jsonc` under the registry key.
Run `tm_stats` and read the layered-config section: it names the per-key source,
so a value you expected to be honored shows up with a source that is not the file
you edited.

**A red-line key I set in the project file is ignored.**
By design. The five red-line keys are honored only in the **global** file, and
`tm_stats` reports the ignored attempt by name rather than dropping it silently.

**My `AGENT NOT FOUND: "Team"`.**
The file name IS the agent id, and Windows/APFS keep the existing spelling when
a write opens that file through another one — so a pre-1.7.2 `team.md` survives
every install and the host registers the lead as lowercase. Use `--agent team`.
The installer's reclaim pass renames a case-only entry it has proven is the same
file; a manual install may need the same rename.

**Can agents run tools in parallel?**
Yes — and they're *engineered* for it: parallel `tm_search` / `tm_webfetch` /
`tm_fetch` calls get distinct step ids and isolated payloads. A regression
here fails the test suite before it ever reaches you.

**Does it work in the CLI (TUI), or only Desktop?**
Both. Desktop adds the color-coded picker and panels; the governed tools and
the whole workflow are host-agnostic. Interactive browsing is the host's own
`browser_*` catalog, so a host with no native browser (CLI / standalone) has
none — the agent reports that gap rather than simulating one.

**What happens if I don't answer the host's permission prompt?**
The host decides that, not this plugin. The plugin can only refuse: it never
self-allows, and every guard it installs can only make a rule stricter. A
session it does not recognize as one of its own is left exactly as the host
behaved.

---

## 🗑️ Uninstall

1. Remove the entry from the `"plugins"` array in your config file; if you installed on 2.x, delete the generated `~/.config/opencode/agents/*.md` and `commands/team-*.md` too, and any `default_agent: "team"` you no longer want.
2. Delete the cache dir (table in [Install](#-read-this-once-save-yourself-an-hour-later)) if you want the disk space back.
3. Restart OpenCode. The agents, commands and tools are gone; the stores under `<repo>/.git/opencode-team/` (and `~/.opencode-team/` for global memories) are plain files you can delete whenever. The global `team-mode.jsonc` is yours to keep or delete — the plugin will simply write a fresh inert one if you remove it.

No DLLs were harmed. Nothing was written to your working tree.

---

## 🏛️ Architecture (for the curious)

```
opencode-team-mode/
├── src/
│   ├── index.ts          ← Plugin entry ({id, setup} — v2 only)
│   ├── agents.ts         ← Agent structure (modes, colors, temperatures, whitelist matrix)
│   ├── prompts/          ← Agent prompts (lead / specialists / shared) — pinned by tests
│   ├── commands.ts       ← Slash command definitions
│   ├── blackboard.ts     ← Shared blackboard + TTL sweeper
│   ├── envprotect.ts     ← R6 facade (patterns / classifiers / gate predicates / hook)
│   ├── identity.ts       ← Agent-name identity (case-insensitive lead match)
│   ├── tm/               ← Governed tools: pipelines / store / preview / guard / refs /
│   │                        config-layers (the 59-key registry) / config-files (the two
│   │                        layers) / config-template (the inert auto-created file) /
│   │                        webfetch / search / memory / board / ledger / dispatch
│   ├── host/             ← v2 personality (setup / guard / offload / session / events / …)
│   └── types.ts          ← Loader-contract types
├── docs/installation.md  ← Historical 1.18.x guide (no longer supported)
├── docs/installation-v2.md ← The 2.x install guide (roles arrive as generated config files)
├── scripts/              ← One-line installers (bash / PowerShell)
├── pt07/                 ← PT-07 baseline suite (seeded A/B token measurement)
└── README.*.md           ← You are here (twice)
```

The loader calls `setup(ctx)` once: it registers the `tm_*` tools, resolves the
two config layers, installs the R6/address guard on `permission.evaluate`, attaches
the JIT offload on `tool.execute.after`, and publishes the blackboard note. User-defined
agents with the same name always win — the plugin never clobbers.

The one rule that makes the config layer trustworthy: **`CONFIG_KEYS` is the
registry and the single source of truth.** A key absent from it is reported as
unknown and never applied; the red-line set is derived from that registry rather
than hand-listed; and the auto-created global file is rendered *from* the
registry, so it cannot drift from what the code actually reads.

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
- [Installation guide, **OpenCode 2.x**](./docs/installation-v2.md) — the supported install: a 2.x plugin cannot create an agent, so the six roles and six commands are generated into the config directory
- [Installation guide, 1.18.x](./docs/installation.md) — **historical only**: the 1.18.x personality was removed in the 1.7.0 line, so this page is kept for reference and is not a working install path
- [OpenCode Desktop](https://opencode.ai) — Official website & download
- [OpenCode Docs](https://opencode.ai/docs) — Configuration & plugin documentation
- [OpenCode Plugin API](https://opencode.ai/docs/plugins) — Build your own plugins
