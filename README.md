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

## 📑 Contents

- [Why TeamMode](#-why-teammode)
- [The team](#-the-team)
- [Install](#-install)
- [Usage](#-usage)
- [JIT context and retry](#-jit-context-and-retry)
- [Governed tools & security](#-governed-tools--security)
- [Configuration](#️-configuration)
- [How the team works](#-how-the-team-works)
- [Customization](#-customization)
- [Troubleshooting](#-troubleshooting)
- [Uninstall](#️-uninstall)

---

## TL;DR — skip the docs

> **The lazy path:** paste this to any coding agent and let it do the work:
>
> ```text
> Install the OpenCode plugin @te-river/opencode-team-mode. This package supports **OpenCode 2.x
> only** — the 1.18.x personality was removed in the 1.7.0 line. Follow
> https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/docs/installation-v2.md
> (a 2.x plugin cannot create an agent, so the six roles and six `/team-*` commands come from
> a generator step in that guide — that step is not optional.) Then run its verification checks.
> ```
>
> **The one command to remember afterwards:** `/team-run <task>` — the Team Lead plans it, shows you the plan, waits for your approval, then runs the whole team.

**[Why](#-why-teammode) · [The team](#-the-team) · [Install](#-install) · [Usage](#-usage) · [Tools & security](#-governed-tools--security) · [Configuration](#️-configuration) · [How it works](#-how-the-team-works) · [Troubleshooting](#-troubleshooting) · [Uninstall](#-uninstall)**

---

## 🤔 Why TeamMode?

A single agent doing everything ends the way you have seen: a context window stuffed with 5000-line file dumps, twenty `shell` round-trips for what one script could do, sub-agents that silently read `.env`, and web "research" that is the model's imagination. TeamMode answers each one with a mechanism, not a promise:

| Pain | What is actually enforced |
|---|---|
| 🔥 **Context flooding** | Every result over its content-class boundary (prose 4000 / data 2000 tokens, CJK-aware) is offloaded to a local run store and replaced by an 80-token preview plus an HMAC handle. The agent pages through what it needs. |
| 🐌 **Round-trip overhead** | The host's own `execute` (Code Mode): one program, N governed calls, zero LLM round-trips. |
| 🕳️ **Silent side effects** | R6: a Team role's `read` of a `.env` is **denied** with no consent path; an env-reading shell command goes to the host's own prompt. The plugin never approves on its own — it can only reject. |
| 🌫️ **Hallucinated research** | Web access is a two-role grant over allowlisted, governed tools. A fact that could not be fetched is reported as a gap. |
| 🎯 **Goal drift** | The lead opens with `GOAL:` in your words plus checkable `ACCEPTANCE:` criteria; `tm_join` reports 目标未达成 while the ledger still has open items, and the goal survives compaction. |
| 🗣️ **Replies in a language you never chose** | The tools answer in Chinese; every role carries a reply-language rule — your language in the prose, a Chinese string quoted verbatim only where it IS the evidence. |
| ⏱️ **Rounds spent looking careful** | 效率至上: one wide call over three narrow ones, independent calls in one round, ≥3 probes folded into one `execute` program — and efficiency never buys its way out of the evidence rule. |

Under the table sits the workflow discipline: deterministic routing, a ≤30-line plan you approve before ≥2 dispatches, structured `STATUS/CHANGES/FINDINGS/EVIDENCE/HANDOFF` replies, and static verification (build / typecheck / tests) instead of vibes. That discipline is also why the recommendation is **medium-to-large projects** — a two-file script leaves the team little to govern.

---

## 👥 The team

| Agent | Role | When to use |
|---|---|---|
| 🎯 **Team Lead** (`@team`) | Orchestrator | Complex tasks that need planning + multi-step execution |
| 🏗️ **Architect** | System designer | Design docs, module structure, API contracts — **dispatched only when the design is genuinely unknown** |
| 💻 **Implementer** | Code writer | Building features, writing production code |
| 🔍 **Reviewer** | Dimension-focused auditor | Single-dimension review by default; 3 in parallel only for high-risk changes |
| 🧪 **Tester** | Test engineer | Real edge-case tests; static verification; governed UI verification via the host's native `browser_*` tools |
| 🔎 **Researcher** | Knowledge finder | Local repo first, then the web — one of the two network roles (with the Lead) |

Out of the box, **Team is your default agent** — the installer writes `default_agent: "Team"`, so new chats open straight into the orchestrator (see [Configuration](#️-configuration)).

---

## 📦 Install

| Way | One command | Use it when |
|---|---|---|
| **Let your agent do it** (recommended) | paste the block below into any coding agent | you want the config edited, the restart handled and the install verified |
| **One-line script** | `curl -fsSL https://ghproxy.net/https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/scripts/install.sh \| bash` (macOS / Linux)<br>`irm https://ghproxy.net/https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/scripts/install.ps1 \| iex` (Windows) | you trust the script and want one step |
| **Manual** | add `"@te-river/opencode-team-mode@latest"` to the **`plugins`** array in `opencode.jsonc` | you want to control the config yourself |

```text
Install the OpenCode plugin @te-river/opencode-team-mode. This package supports **OpenCode 2.x
only** — the 1.18.x personality was removed in the 1.7.0 line. Follow
https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/docs/installation-v2.md
(a 2.x plugin cannot create an agent, so the six roles and six `/team-*` commands come from
a generator step in that guide — that step is not optional.)
If a URL is unreachable — common on mainland-China networks — retry with the mirror prefix
https://ghproxy.net/ + the same path. If `npm` is slow or blocked, run `npm config set registry https://registry.npmmirror.com`, or add
`--registry https://registry.npmmirror.com` to the one command that needs it.
Then verify the install using the checks in that guide.
```

> **The key is `plugins` (plural).** A 2.x host never reads the singular `plugin` key, and it installs the package itself from the entry at startup. Entries across config files are **applied lowest→highest rather than replacing one another**, so keep exactly one Team entry — writing ours into both `opencode.json` and `opencode.jsonc` loads the plugin twice. The 2.x flow is [docs/installation-v2.md](./docs/installation-v2.md); the host's own loader code is [docs/research/plugin-loader-contract.md](./docs/research/plugin-loader-contract.md).

### ⚠️ Read this once, save yourself an hour later

- **Restart to activate.** After touching the config, restart with `opencode service restart` (or quit Desktop from the tray, not just the window). A restart is safe mid-session: the conversation survives, and only an in-flight tool call is aborted and has to be re-issued.
- **Updates: re-run the installer — that IS the update.** It is idempotent (re-patches the config, purges the stale cache, re-resolves npm copies), because OpenCode caches plugins by spec string and never re-resolves `@latest` (upstream limitation). The manual purge commands and the `~/package.json` shadowing trap are in [Troubleshooting](#-troubleshooting).
- **The manual path needs the generator:** a 2.x plugin cannot create an agent, so `node <pkg>/scripts/gen-v2-config.mjs` writes the six roles and six `/team-*` commands into the config directory, and `default_agent: "team"` is written LAST — then restart. That step is not optional.
- **Prerequisites:** [OpenCode](https://opencode.ai) (Desktop or CLI) and Node ≥ 18.

### 🖥️ What the installer changes on your machine

All of it is outside this repo; the installer prints what it changed and reads the value back:

- **Config entry** → `~/.config/opencode/opencode.jsonc` (created if missing; an existing `opencode.json` is migrated into the `.jsonc`, original left untouched) — until you delete the line.
- **Plugin cache purge** → `~/.cache/opencode/packages/*opencode-team-mode*`, including the nested copy that actually runs — re-downloaded on next start.
- **User env var** `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` → Windows `setx` writes it into your user profile (survives reboot, visible to every program you start); macOS `launchctl setenv` / Linux `systemctl --user set-environment` last this login session. It exists because `task { background: true }` is the only sub-agent the interface can **show** you (a card linking to the child you can stop), and the host reads that flag from **its own process** — a plugin cannot set flags there. Without it nothing breaks; `task` simply blocks the lead.
- **Undo / skip:** `[Environment]::SetEnvironmentVariable("OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS", $null, "User")` (Windows) · `launchctl unsetenv OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` (macOS) · `systemctl --user unset-environment OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` (Linux) · `.\install.ps1 -NoBackgroundSubagents` or `TEAMMODE_SKIP_BACKGROUND_SUBAGENTS=1 bash install.sh` at install time.

Then restart, open the agent picker, and look for **team, architect, implementer, reviewer, tester, researcher**. That's it — the team is hired.

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

Or `@`-mention agents directly: `@team`, `@architect`, `@implementer`, `@reviewer`, `@tester`, `@researcher`.

### What a run feels like

Team is the default agent — here a product change that earns three dispatches, so the approval gate:

```text
you    Add token-bucket rate limiting to our Express API — 100 req/min/user, 429 over the
       limit. Don't touch anything under src/legacy/.
team   PLAN  goal · scope · pipeline (implementer → tester → reviewer) · assumptions ·
       boundaries — approve to proceed?
you    approved, go
team   ▸ implementer done · tester 14/14 · reviewer approve — src/legacy/ untouched
```

---

## 🧠 JIT context and retry

*New in this release:* layered request-side context keeps a long session inside the window without deleting evidence, plus a retry ladder that says what it cannot do.

- **State card (lead only).** ≤300 tokens of ledger doing/blocked/todo items, running sub-agents and the board root, injected once per request. Hash-gated: an unchanged state re-emits the same bytes, so the prefix stays cacheable (`stateCard: "off"` removes the layer).
- **Lossless pruning.** Past 70% of the window (`pruneAtPercent`) a settled body becomes a one-line pointer — but only after it was offloaded and deduplicated against the run store, so the stub carries a real `tm_fetch` handle (`pruneOffload`). Reply skeleton, GOAL/ACCEPTANCE, provenance, system messages and the board note are never cut; `pruneProtectPatterns` lets your regexes outrank the budget.
- **Window entry.** A separate `[Team 窗口占用]` line reports `<bucket>% · model <id>`, bucketed to the nearest 5% so one bucket stays byte-identical. An unreadable window means the line is absent — never "0%".
- **Dynamic tail.** State card, window entry, retry directive and split advice merge into ONE message at the request's end, so `system` stops changing and prefix caching survives; `dynamicTail: "off"` restores the previous system injection.
- **Cache metering.** Each request that reports usage writes one `v2-cache` row (read / write / input / rate); `tm_stats` renders the **缓存命中** section with its denominator. No row means usage was never read — not a 0% hit.
- **Retry.** A throttle is classified by name and text, then answered by a per-request ladder — 5s / 10s / 20s / 40s / 60s, five rungs, never shared across requests; the host's own countdown wins when it has one. A sub-agent that spends its budget hands the work back; the main agent stops, reports and offers options. A hard quota is the billing family only and names no wait. When nothing continues by itself, one `session.synthetic` re-drive is admitted per rung.
- **A user stop is a scope change.** Land in-flight work first, skip verification, then hand over in four sections: 已落盘 / 未开始 / 验证 / 提交与发布.

---

## 🧰 Governed tools & security

Every tool the team calls runs under ONE governance pipeline. A result above its content-class boundary (`offloadThresholdText` = 4000 for prose, `offloadThresholdData` = 2000 for json/csv/code/binary, unknown → the global `offloadThreshold`) is written to a local run store and replaced by a content-aware preview (≤80 tokens) plus an HMAC handle that `tm_fetch` pages back on demand. The same pipeline governs the **host's own** `read` / `grep` / `glob` / `shell` through `tool.execute.after`. Under it sit **R6** (env protection: an env-FILE read is a hard deny with no consent path; an env read inside a shell command is asked) and **R2** (delete / publish / install / kill / privilege). Every hook can only make a rule stricter — the plugin never self-allows — and nothing it changes reaches a session that is not one of the six roles.

| Tool | In one line | Roles |
|---|---|---|
| `tm_fetch` | Paged retrieval of an offloaded result; JSON handles take a `fields` dot-path projection (`items[].name`). | all six |
| `tm_memory` | Session / project / global memory (Markdown + frontmatter): add / search / list / forget / compact. | all six |
| `tm_board_write` | The board's write side: ONE new `NN-<role>-<topic>[-rN].md` under the board root, named by the tool, never overwritten, path + byte count returned. | all six |
| `tm_search` | Multi-engine search: extracted, deduplicated, RRF-fused hit lists. | Lead + Researcher |
| `tm_webfetch` | One governed GET of an allowlisted page, redirects re-checked per hop. | Lead + Researcher |
| `tm_ledger` | The lead's task ledger in the host's `ctx.storage` (2.x gives a plugin no `todowrite`). | Lead only |
| `tm_join` | Sub-agent collection: status, bounded `waitMs`, `cancel:true`, a named child's whole reply through the offload pipeline. | Lead only |
| `tm_stats` | Reads this plugin's own trajectory back: tokens kept out, dispatch overlap, capability matrix, layered-config sources. | all |

<details>
<summary><b>All the detail — every tool, every guard, every path</b></summary>

#### Tools in full

- **`tm_fetch`** — pages a handle (HMAC-signed, run-scoped, expiring). A JSON handle also takes `fields` (a deliberately small jq subset: `items[].name`, `[].stargazers_count`), so a big API dump narrows to the values needed without the raw body entering the window.
- **`tm_memory`** — three tiers: **session** (this conversation only, in-process, TTL `memorySessionTtlMin` = 240 min, invisible elsewhere; `memorySessionPersist: "1"` mirrors it under `memories/sessions/<sid>/`), **project** (default; `<repo>/.git/opencode-team/memories/…` — build commands, environment quirks, architecture decisions for THIS checkout) and **global** (`~/.opencode-team/memories/global/`, override `memoryGlobalDir` — conventions that follow you across projects). Search walks all tiers with **session > project > global** precedence, +2 weight on project entries, and a same-title higher-layer twin shadows the lower one. A near-duplicate add (same tier + category, or title+keywords Jaccard ≥ 0.6) **folds into** the existing entry (content wins, keywords union, old slug into `supersedes:`, answer says 已合并). `memoryMaxEntries` = 200 per scope: over it `add` fails on purpose — run `compact` (dry-run by default; `apply:true` performs it after copying every original to a timestamped `.compact-backup` tree). Entries past `memoryStaleDays` (30) surface tagged `[stale Nd]`. 4000 chars per memory.
- **`tm_board_write`** — the blackboard layout `<board-root>/<session-key>/<task-slug>/NN-<role>-<topic>[-rN].md`. It exists because architect / researcher own no file tool, so their oversized deliverables used to end as `BLACKBOARD WRITE FAILED` plus the whole document inline. Segments sanitized, target realpath-verified against the board root (a symlinked task dir is refused), always `.md` so no `.env` can be produced, capped by `boardMaxChars` (200000) and `boardMaxFiles` (200 per session).
- **`tm_search`** — one call, one query, clean results; the engine URL is built for you and collapsed into a numbered title+URL list. Engines: `auto` (default — classifies the query, fans the matching engines out **in parallel**, dedupes by host+path and fuses with weighted RRF; ranking scaled by real query-token overlap with floor `searchRelevanceFloor` = 0.35; every route has ≥2 legs), `bing` (cn.bing.com, the only live CN HTML SERP; multi-word CJK phrase-protected), `bing-int` (`&ensearch=1`, deliberately outside every `auto` route — two layouts of one index would double bing's vote), `stackoverflow` (keyless API, 300/day/IP; `auto` tracks the quota and swaps in `bing` once spent), `hn` (Algolia), `bilibili`, `moegirl` (MediaWiki API), `npm` (registry JSON), `github` (repo search; `org:` / `user:` / `stars:` / `language:` qualifiers fold into the query). All CN-reachable without API keys and all on the seeded allowlist; `sogou` / `so` / `baidu` were removed after the 2026-09-14 benchmark (anti-bot shells or 100% empty), and an empty result names the alternative engines.
- **`tm_webfetch`** — a known URL, one governed GET. Search pages are auto-extracted to hit lists; JSON endpoints pass through untouched. Redirects are followed manually and re-checked per hop, and a refusal names the WHOLE chain (`跳转链: a → b（停在第 2 跳）`) — an allowlisted shortener that bounces off-site must not read as "that site will not fetch". A 429/503 carries its own `Retry-After` when the server sends delta-seconds (an HTTP-date is never laundered into a countdown). The page GET asks for Markdown first (`Accept: text/markdown,…`): measured on `learn.microsoft.com`, 60,778 B of HTML becomes 11,449 B of Markdown, and other hosts return the same document either way. A 403/418 after real-Chrome headers is a DIRECTIVE: the gate is a JS challenge / TLS fingerprint, so open it with the host's `browser_navigate`.
- **`tm_ledger`** — `add` / `doing` / `done` / `blocked` / `list` in the host's `ctx.storage` per session. A repeated ask is ONE item, an ambiguous id is refused with both candidates printed, `blocked` carries its note, and a write that did not reach storage is reported as a failure rather than as recorded.
- **`tm_join`** — there is deliberately no plugin-side dispatcher (`tm_dispatch` is removed): a child a plugin creates is a session the user can neither open from a card nor stop from the interface. Delegation goes through the host's own `task` / `task { background: true }`, and `tm_join` is the read side: status snapshot, bounded `waitMs`, `cancel: true` (`tm_join { ids: ["ses_…"], cancel: true }` stops ONE named child; without `ids` it stops every still-running one), and `claimNamedChild` so an explicit id pulls that child's whole reply back through the offload pipeline. On 2.x it also registers children the host's own `subagent` tool created (the ack's `metadata.sessionID`), so a background dispatch is never reported as "nothing to collect", and the row says where the reply arrives and how it settled. Stopping one goes to `ctx.session.interrupt`, with **five distinct verdicts** — 已由宿主中断 / 空闲未中断（it was not running: our row was stale, not failed）/ 未确认（the call worked, no boolean came back）/ 无中断缝 / 被宿主拒绝 — counted as `stop_tried` / `stop_confirmed` / `stop_refused` / `stop_unknown`; `resume` is never sent.
- **`tm_stats`** — tokens kept out of the window (net of the preview that arrived), seconds saved by dispatch overlap, governance counts (blocked subresources, clamped timeouts, cache hits, redactions), the capability matrix, and the layered-config section (per-key source, red-line keys a file tried to set and lost, unknown keys, skipped layers). Read-only over files this plugin wrote. `tm_stats { recent: 20 }` appends a call-by-call recap with handle + payload path — the answer to "what did that tool actually return?", since the host renders a plugin tool call as a one-line card with no expandable body.

#### Scope, and what the 1.7.0 cut changed

The v1 (1.18.x) personality was removed in full: the package exports `{id, setup}` and nothing else, so `tm_read` / `tm_grep` / `tm_bash` / `tm_ptc_run` / `tm_pty` are gone — the host's own `read` / `grep` / `glob` / `shell` and its `execute` (Code Mode) do that work. The governance did not disappear with them: an oversized native result is offloaded through `tool.execute.after` (measured: `shell` 12,902 tokens arriving as a 78-token preview), and the address red line plus R6's per-command classification ride `permission.evaluate`. Every v2 hook fires for every session on the host, so each layer asks "is this one of our six roles?" first — `build`, `plan` and your own agents stay as a fresh install leaves them, and calls whose owner was not identified are left alone and counted (`tm_stats` prints 作用域：我们 · 他人 · 未判定).

#### Interactive browsing, and the web channel

Interactive browsing is the host's own `browser_*` catalog (`browser_tabs_open`, `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_evaluate` …). The desktop renders that panel from the server's own browser service, so a plugin cannot register a page of its own; the self-built `tm_browser` was removed in 1.7.0. `permission.evaluate` was observed NOT firing for `browser_*`, so the gate sits on `tool.execute.before`: the URL of every navigate/open, the path of every `browser_preview`, and every browser URL named inside an `execute` program are classified, refused ones are blocked, and if the host runs a refused call anyway its page is replaced with the same refusal — the reply never claims a block we did not perform. A snapshot is an addressing table, so it is CAPPED rather than offloaded: every `[ref=…]` line kept, static text dropped, budget `nativeSnapshotMaxTokens` (1200) — measured on a 261-ref page, 261 refs kept in 1,044 of 11,326 tokens. Calling convention: `evaluate` takes `{tabID, script}` where `script` is an **expression** (not function source) and the return value must be a scalar you stringify; snapshot tokens read `@e8 [link]`. On a host with no native browser catalog (CLI / standalone) there is no browser at all, and the agent reports that gap rather than simulating one.

**The allowlist** (all web tools) seeds 22 hosts: `baidu.com`, `bdimg.com` (Baidu's own script + asset CDN), `moegirl.org.cn`, `bilibili.com`, `www.sogou.com`, `www.so.com`, `cn.bing.com`, `www.bing.com`, `zhihu.com`, `juejin.cn`, `csdn.net`, `cnblogs.com`, `gitee.com`, `github.com`, `api.github.com`, `raw.githubusercontent.com`, `gist.githubusercontent.com`, `ghproxy.net`, `stackoverflow.com`, `npmjs.org`, `pypi.org`, `learn.microsoft.com` — plus `api.stackexchange.com` and `hn.algolia.com` while the default seed is in play (24 effective). Parent domains cover their subdomains (`baike.baidu.com`, `mzh.moegirl.org.cn`, `space.bilibili.com`), and `bdimg.com` must be seeded explicitly because a page whose script CDN we block is a blank page we would then report as "no content". Extend via `webfetchAllowedDomains`; a custom list REPLACES the seed, so keep the engine hosts or `tm_search` loses its targets. Architect / implementer / reviewer have NO network grant; the tester carries the host's `browser_*` tools ONLY, for UI verification of the project; open web stays with the two network roles. Search hit lists filter engine wrappers (`so.com/link?`, `ai.so.com`) and same-name-different-site noise (`maimai.cn`), extensible via `hitBlacklist`. Governed fetches cache per URL for `webCacheTtlSec` (300 s), hash-named (a token-bearing query never hits disk), and only for hops the STATIC allowlist admitted — a hit can neither resurrect a removed host nor substitute for consent.

**Out-of-allowlist is a gate, not a wall.** The call fails closed with a refusal naming the exits — `privateSpace: "allow"` in `team-mode.jsonc`, or that one hostname in `webfetchAllowedDomains` — because a 2.x plugin cannot raise the host's dialog, and a gate with no door is not a gate. Below that sit classes no config opens: cloud-metadata / link-local / multicast / reserved / benchmarking ranges, including their IPv4-mapped and DNS64 spellings (changing the notation is not a bypass), plus env-file URLs and non-http(s) schemes, are hard-rejected. **Tool priority ladder, every task:** ① your own MCP/plugin tools → ② TeamMode governed tools → ③ the model's own reasoning; a missing capability is reported at rung ③, never fabricated (web is the one exception — governed `tm_search` / `tm_webfetch` come first there, because that path carries the allowlist and the red lines).

#### R6 env protection + R2 dangerous operations

R6 is armed by default, in `strict` mode (`envProtect` accepts `strict` / `standard` / `off`, and any unrecognised value resolves to `strict`).

- **Env-FILE reads are a hard deny** — a Team role's native `read` / `edit` / `glob` / `grep` of a `.env` is refused with no consent path. The host's `grep` reports the *pattern* as its permission resource, so the same rule also runs on the whole tool input (`grep SECRET .env` cannot slip through). Templates (`*.env.example` / `.sample` / `.template` / `.dist`) stay readable.
- **Env-variable reads in a shell command go to the host's prompt** (`ask`): the per-command classifier decides, so `git status` asks nothing and an env dump still does. Env reads no wildcard can express (embedded `$VAR` / `${VAR}` / `$env:` inside another command, command substitution) are **refused**, never asked. The audit log records only tool name + pattern category + verdict — never command text, paths, variable names or values.
- **Deferral is per-session:** the env face applies only in sessions running TeamMode's generated roles; anywhere else the plugin leaves the host's behaviour exactly as it found it.

**R2** covers delete, git publish, network fetch, package install/publish, process/system and privilege changes — none silently allowed, while the normal verification stack (`npm test`, `tsc`, `git status`) is not gated. **The plugin never self-allows:** every hook can only make a rule stricter; a permission it is asked about is replied `deny` or left alone.

> ⚠️ **When you approve the host's own dialog, pick "once" — not "always".** Verified live: "always" records a far broader rule than the command you saw (approving `Get-ChildItem env:PATH` stores `Get-ChildItem *`), so every later `Get-ChildItem` runs with no dialog. The web channel has the same trap: one "always" on a host lets **every agent session in that project** open it. The reply says which path let a page in (static allowlist / the dialog you just answered / a saved rule that answered in milliseconds), because an agent that cannot tell them apart reports "no dialog" as "that site is allowed".

#### Repo hygiene

The offload / trajectory / memory stores live under `<repo>/.git/opencode-team/` — outside a git repo, the OS temp dir, sharded per workspace as `opencode-team/w-<hash>/` so one project never reads another's payloads. **Never your working tree.** Every agent is told to delete scratch files before reporting done and to keep throwaway work in the OS temp dir. A TTL sweeper reclaims old task dirs at startup and hourly; the Team Lead never deletes boards itself, so you can audit any run.

</details>

---

## ⚙️ Configuration

**Configuration is JSON, and only JSON.** `team-mode.jsonc` is the single source; there is no environment layer, and **no `TM_*` configuration environment variable exists any more** — old ones are unknown keys, reported at boot and never applied. (Three `TM_*` names survive as internal/test switches, at the end of this section.)

### Where the file lives

| Layer | Path | Precedence |
|---|---|---|
| **global** | `~/.config/opencode/team-mode.jsonc` (honours `OPENCODE_CONFIG_DIR`) | lowest — every project |
| **project** | `<dir>/team-mode.jsonc`, walking from the workspace **up to the filesystem root** | middle — direct files merge farthest→closest |
| **project** | `<dir>/.opencode/team-mode.jsonc`, same walk | highest user layer — every `.opencode/` file overrides every direct file |
| **system** | `%ProgramData%\opencode\team-mode.jsonc` (Windows) / `/etc/opencode/team-mode.jsonc` (POSIX) | **highest overall** — the host's managed-settings layer outranks every user layer |

So there are **three** file layers (`global < project < system`), and that walk and precedence are the host's own config-layering rule, copied rather than invented; on a platform with no derivable root (Windows without `PROGRAMDATA`) the system layer does not exist and the report says so. JSONC comments are masked at the byte level, so a commented-out key cannot read as live. A layer that fails to parse is skipped **whole**; a single bad key loses only itself; unknown keys are warned about and never applied. `tm_stats` renders the result: per-key source, skipped layers, unknown keys, auto-create state.

### It writes itself

When the global file is **absent**, the plugin creates it at boot — atomically, idempotently, **never overwriting an existing file**. What it writes is **inert**: all **64** registry keys, each as a *comment* under a one-line description, so the file parses to `{}` and sets nothing until you uncomment what you want.

```jsonc
// 全局配置。取消注释即可生效；默认全部注释 = 什么都不设置。
{
  // "offloadThreshold": 2000,            // 卸载阈值（估算 token；等于阈值也卸载）。
  // "envProtect": "strict",              // R6 环境防护模式（strict/standard/off）。（红线：仅全局或 system）
  // …共 64 个键，每个都带一行说明
}
```

Turn it off with the plugin option `autoCreate: false`, or the internal switch `TM_CONFIG_AUTOCREATE=off`.

### Red-line keys

Five keys are **honored only in the global or `system` file**: `envProtect`, `r6FineAsk`, `privateSpace`, `webfetchAllowedDomains`, `bashReadonlyAllowed`. A project file may set them, but the value is **ignored and reported** — a committed project config must not switch off a guard for everyone who clones the repo; the `system` layer is the admin-managed one, so it MAY set them. The set is derived from the registry (`redLine: true`), so a new red-line key is red-line by declaration.

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
| `defaultAgent` | `true` | Check and report which agent the installer's `default_agent` names. The 2.1.x plugin ctx has no `agent.default`, so the plugin cannot promote anything; `false` skips the check. |
| `autoCreate` | `true` | Write the inert global `team-mode.jsonc` at boot when absent. |
| `ttlDays` (alias `blackboardTtlDays`) | `5` | Blackboard retention, valid range (0, 365]. |
| `envProtect` | `true` | Plugin-wide kill switch; `false` resolves the R6 mode to `off`. |

On 2.x an entry is either a **string** or an **object** with `package` and `options`; the 1.x tuple form is rejected (`path=$.plugins.1 kind=invalid`, measured 2026-10-06). Options do arrive: with the object form, `{ "ttlDays": 9 }` reads back as `board_ttl_days=9` in the boot row.

### Model choice

Every judgment — triage, decomposition, dispatch briefs, synthesis, review verdicts — flows through the Team Lead, so a weak model there degrades the whole pipeline. Pin your best reasoning model to `team`:

```jsonc
{
  "agent": {
    "team": { "model": "anthropic/claude-opus-4-5" },      // Lead earns your best model
    "implementer": { "model": "anthropic/claude-sonnet-4-6" } // specialists tolerate cheaper
  }
}
```

Your own agents named `team` / `architect` / … always take precedence; the plugin never clobbers user definitions. See [Customization](#-customization).

### Key reference (all 64)

<details>
<summary>All 64 keys — click to expand</summary>

| Key | Type | Default | Meaning |
|---|---|---|---|
| **Offload, previews and the store** | | | |
| `offloadThreshold` | number | `2000` | Global offload boundary (estimated tokens, CJK-aware) when the content class is unknown. A result AT the threshold offloads. |
| `offloadThresholdText` | number | `4000` | Boundary for prose (text / log / markdown). Inherits the global value unless set. |
| `offloadThresholdData` | number | `2000` | Boundary for structured payloads (json / csv / code / binary). Same inheritance. |
| `previewLines` | number | `20` | Raw lines a preview builder may scan. |
| `previewMaxTokens` | number | `80` | Hard preview cap. |
| `fetchMaxLines` | number | `2000` | `tm_fetch` per-segment line cap. |
| `blackboardDir` | string | auto | Run-payload store; empty = `<repo>/.git/opencode-team/blackboard`; explicit = absolute or project-relative. |
| `trajectoryDir` | string | auto | Trajectory store; empty = `<repo>/.git/opencode-team/trajectory`. |
| `blackboardTtlDays` | number | `7` | Handle TTL and the physical sweep period for expired run dirs. |
| `storeReclaim` | `on`/`off` | `on` | At boot, reclaim what an upgrade left behind (a shard idle past the TTL, the pre-shard dirs at the temp fallback). **Only TTL-expired entries**; `off` leaves the disk exactly as found. |
| `taskOffload` | `on`/`off` | `on` | Replace the host's injected background-sub-agent reply with a preview + `tm_join` pointer. Only synthetic parts carrying the host's own envelope and over the threshold; a `state="error"` child is never rewritten; nothing copied to disk; `off` restores the verbatim injection. |
| `subagentConcurrency` | number | `8` | Ceiling on **running + in-flight** dispatches per caller, so a burst in one message is capped too; `0` disables. |
| `boardMaxChars` | number | `200000` | `tm_board_write` per-file cap — over it the write refuses (with a split-the-topic hint) rather than truncating a deliverable. |
| `boardMaxFiles` | number | `200` | Markdown files per session folder; the TTL sweeper is the only reclaim path, so the refusal names it. |
| `joinMaxWaitMs` | number | `60000` | Ceiling on `tm_join { waitMs }`; a second consecutive wait that settled nothing is cut to 10 s with a "stop waiting" directive. |
| `ledgerMaxItems` | number | `1000` | `tm_ledger` items per session; past it the oldest DONE items are archived to `team-mode/ledger-archive` (and reported), and only when nothing is left to archive does the list refuse — it never quietly drops an ask. |
| **Memory** | | | |
| `memoryGlobalDir` | string | auto | GLOBAL tier store; empty = `~/.opencode-team/memories/global`. |
| `memorySessionTtlMin` | number | `240` | Session-tier entry TTL (lazy + boot sweep). |
| `memoryMaxEntries` | number | `200` | Per-scope entry cap; over it `add` fails on purpose — run `compact`. |
| `memoryStaleDays` | number | `30` | Age after which search hits are tagged `[stale Nd]` (`0` disables). |
| `memorySessionPersist` | string | `""` | `""` = in-process only; `"1"` also writes session entries under `memories/sessions/<sid>/`. |
| **Web and search** | | | |
| `webfetchAllowedDomains` | string[] | 22-host seed | **red line.** Outbound allowlist (`"*"` = any host; `[]` = deny all). A custom list **replaces** the seed — keep the engine hosts. `"*"` does **not** cover private space: loopback / RFC1918 / CGNAT / `.localhost` still need `privateSpace: "allow"`, and non-routable ranges are a hard red line no setting opens. |
| `searchDefaultEngine` | string | `auto` | Engine when no `engine` arg is given (`auto` = classify + parallel fan-out + RRF fusion). |
| `searchMaxHits` | number | `10` | Hits kept per engine leg and in the fused list. |
| `searchWeights` | record | `{}` | Per-engine fusion weight overrides, e.g. `{"bing": 0.3}`. |
| `searchDisabledEngines` | string[] | `[]` | Engines removed from the roster AND from every `auto` route. |
| `searchRelevanceFloor` | number | `0.35` | Weight kept by a hit sharing no query token (demotes junk without deleting an engine). |
| `hitBlacklist` | string[] | `[maimai.cn]` | Extra domains never listed as hits; merged with the built-in entry. |
| `webCacheTtlSec` | number | `300` | How long a governed fetch may re-serve the same URL (`0` = off). One store shared by `tm_webfetch` / `tm_search`; entries hash-named and only read/written for hops the STATIC allowlist admitted; a re-served page says 缓存命中. |
| **Rounds, dispatch and context** | | | |
| `prune` | `on`/`off` | `on` | Replace a SETTLED message body with a self-explaining pointer. Evidence is never destroyed: reply skeleton, GOAL/ACCEPTANCE, provenance, system messages, a running child and an uncollected child id are protected whole. |
| `pruneAtPercent` | number | `70` | Prune at this share of `limit.context` — never a hard-coded token count. **Clamped 40–90.** |
| `pruneKeepTailPercent` | number | `40` | Share of the window kept verbatim at the tail; the newest message is always kept. |
| `pruneOffload` | `on`/`off` | `on` | Offload a message body BEFORE its text is replaced, so the stub carries a full `tm_fetch { ref, access_token, expire_at }`; an already-stored body reuses its handle, and a failed offload falls back to the echo note and is counted (`prune_offload_failed`). |
| `pruneProtectPatterns` | regex list (comma separated) | `""` | A message whose text matches ANY entry is never pruned; hits are counted (`prune_protect_matched`); an invalid entry is ignored; empty = off. |
| `stateCard` | `on`/`off` | `on` | 任务状态卡 — ONE ≤300-token lead-only system entry: ledger counts + open items, this session's running children, a shortened board root, last round's offloaded count. Unchanged bytes write nothing. |
| `dynamicTail` | `on`/`off` | `off` | Volatile context (state card / window entry / retry directive / split advice) merges into ONE message at the END of the request (`[Team 动态上下文]`, `### <name>` sections), so `system` stays prefix-cacheable; a reused array has its old tail stripped; empty sink writes nothing. **Defaults to `off`**: host 2.1.x persists the appended message as a real user message and replays it as the last user input (measured 2026-10-22); the feature stays, opt in only after confirming the host behaviour is safe. `off` = per-producer system entries. |
| `splitAdvice` | `on`/`off` | `on` | Suggest splitting a brief that carries too many acceptance criteria. |
| `splitBriefTokens` | number | `4000` | Brief token threshold for that hint. **Clamped ≥200.** |
| `splitMaxCriteria` | number | `3` | More acceptance criteria than this is a split signal. |
| `retry` | `on`/`off` | `on` | Retry governance on both surfaces. **(1) Per-request provider ladder:** each failing request earns `retryMaxRetries` retries at 5s/10s/20s/40s/60s, isolated per session, ending on `session.idle`, `retryChainGapMs` of quiet or budget exhaustion; a child that spends its budget hands work back and the lead is told to run that step; a **hard quota** (billing family only: `insufficient balance` / `insufficient_quota` / 余额不足 / 欠费) names NO wait and trips the breaker on the second consecutive error, while alibaba's per-minute token-limit throttle rides the ladder; a structured `retryAfterMs` sets the wait floor. **(2) HTTP layer:** a failed `tm_webfetch` / `tm_search` leg (network throw, timeout, 429/5xx) is re-asked up to 3 times on the same rungs and labelled (`第N次重试后成功` / `重试3次…仍失败`); policy refusals are never re-asked. **The host's own retries win** (`session.retry.scheduled`), and ③ `ctx.session.synthetic` re-drives a dead session once per rung. |
| `retryBaseMs` | number | `5000` | First rung: retry #1 waits 5 s, then doubles. |
| `retryMaxMs` | number | `60000` | Backoff ceiling (rungs 4/5 rest at 40 s/60 s). |
| `retryMaxRetries` | number | `5` | How many retries ONE request earns (5 → 5s/10s/20s/40s/60s). |
| `retryChainGapMs` | number | `600000` | A session quiet this long starts a NEW chain. |
| `retryJitter` | number | `0` | ± fraction on the wait; `0` = NO jitter, so the ladder is exact. |
| `retryBreakAfter` | number | `5` | Consecutive errors before the dispatch breaker trips. |
| `retryCooldownMs` | number | `60000` | How long new sub-agent dispatches are refused once it has. |
| **Host-surface governance** | | | |
| `nativeOffload` | `on`/`off` | `on` | Govern the HOST's `read`/`grep`/`glob`/`shell` through the same pipeline; `off` restores host behavior, and the boot line distinguishes "you turned it off" from "this host has no execute.after". |
| `nativeSnapshotMaxTokens` | number | `1200` | Budget a native `browser_snapshot` keeps; addressing lines win over static text; past `budget × 4` the reply states how many ref lines did not fit. |
| `nativeReportMaxTokens` | number | `1600` | Budget a report-shaped native result keeps: table lines and headings win the space; the full text still rides the handle. |
| `probeChain` | `on`/`off` | `on` | After a run of native `read`/`grep`/`glob`/`shell`, append ONE line naming `execute` and what it saves — a hint, never a gate; body preserved verbatim; idempotent. |
| `probeChainAfter` | number | `3` | Consecutive native calls before the hint starts (`0` = off). |
| `v2BrowserGate` | `on`/`off` | `on` | Gate over the host's `browser_*` catalog (navigate/open URLs, preview paths, browser URLs inside an `execute` program). `off` restores ungoverned browsing and the boot line says which world runs. |
| `v2CodeMode` | string | `""` | `direct` sends `options.codemode=false`; empty = catalog mode. A live 2.0.16 session disproved the flag's effect, so the truth is `tools_in_request` in `tm_stats`, never the flag sent. |
| `bashTimeoutProbeMs` | number | `60000` | Ceiling forced onto a model-set timeout for a command the read-only allowlist already accepts; never invents a timeout; `0` disables. |
| `bashTimeoutMaxMs` | number | `0` | Optional global ceiling for every other shell command; `0` = off, so a real build keeps its timeout. |
| `envProtect` | `strict`/`standard`/`off` | `strict` | **red line.** R6 mode; `off` also disarms the shell escalation; any unrecognised value resolves to `strict`. |
| `r6FineAsk` | string | classifier | **red line.** `off` asks about EVERY shell command — also what happens on a host without the per-action evaluation hook; the boot note says which of the two caused it. |
| `privateSpace` | `allow`/`deny`/`ask` | `deny` | **red line.** Loopback / RFC1918 / ULA / CGNAT / `.localhost` through our tools. `deny` by default because a 2.x plugin cannot raise a dialog. Never conflated with the FORBIDDEN ranges. |
| `bashReadonlyAllowed` | string[] | built-in | **red line.** P3 read-only allowlist; `tasklist` / `ps` / `findstr` are seeded because `已确认关闭` is only checkable if the agent can ask the OS for the pid. |

**Legacy keys** — listed and parseable so an old config still loads, with **no v2 reader**, and reported as such:

| Key | Default | Status |
|---|---|---|
| `askTimeoutFloorMin` | `1` | **Orphaned.** Its only consumer was the v1 approval gate, which was deleted. |
| `compactionContext` | `on` | v1-only |
| `shellEnv` | `""` | v1-only |
| `ptcWebBridge` | `on` | v1-only |

</details>

> **Compaction timing belongs to the host, not to this plugin.** An earlier release triggered its own summarization at 75% of the window; that was removed by user decision — a plugin that summarizes a live conversation by itself takes a context-losing action you did not ask for. What remains runs only when the HOST compacts: the must-survive list (reply skeleton, offload handles, open sub-agent ids, provenance, board paths) rides `session.hook("compaction")`, and the host's summarizer prompt is never replaced.

### The three surviving `TM_*` names

These are **internal / test switches**, not configuration — read from the environment so a test or diagnostic needs no config file:

| Name | Effect |
|---|---|
| `TM_STORE_RECLAIM` | Overrides the `storeReclaim` key (`off` = leave the disk exactly as found). The test runner sets it. |
| `TM_V2_PROBE` | Path to a JSONL file where the surface probe records the host's real tool ids, permission action names and argument key **names** — names and counts only, never a command line, path, URL or env value. |
| `TM_CONFIG_AUTOCREATE` | `off` suppresses the inert global-file auto-create. |

Any **other** `TM_*` name in your environment is inert. If you have been setting one, move it into `team-mode.jsonc` under the matching key above.

---

## 🏗️ How the team works

Sub-agents cannot message each other live, so coordination is a **structured reply skeleton** — every specialist reply is `STATUS: / CHANGES: / FINDINGS: / EVIDENCE: / HANDOFF:`, ≤50 lines, relayed verbatim into the next dispatch. A deliverable over ~50 lines goes to ONE board file under `<repo>/.git/opencode-team/` (round-suffixed; working tree untouched). The package exports `{id, setup}`: `setup(ctx)` registers the `tm_*` tools, resolves the two config layers, arms the R6 / address guard, attaches JIT governance on `tool.execute.after` and publishes the blackboard note. `CONFIG_KEYS` is the single source of truth, so a key absent from it is reported and never applied.

- **Routing table:** question → direct answer; docs-only → implementer; product change → implementer → tester → reviewer; multi-module → architect → implementer → tester → reviewer(s); unknown tech → researcher first. Fixed minimums — a product change routed below 3 dispatches is a routing bug.
- **One dispatch, one verifiable deliverable** — if the lead cannot say how a child's result will be verified *on its own*, it is a wish, not a dispatch.
- **The architect is conditional:** only when the design is genuinely unknown. With a verified root cause (file:line evidence), skip it and spec the fix.
- **Tester and reviewer may run in the SAME round**; likewise implementers with disjoint file ownership and testers on disjoint packages.
- **Approval gate (count-based):** ≥2 dispatches → plan (≤30 lines) → **your approval** → execute. Blocking questions are batched and asked immediately.
- **Only the Team Lead dispatches** — specialists hold no `task`/`subagent` grant, so no sub-agent spawns a sub-agent.
- **Adaptive review:** one reviewer by default; three parallel dimensions only for auth/security, cross-module contracts or public APIs.
- **Static verification:** build / typecheck / lint / tests; improvised UI work ends with `UI NOT VERIFIED: <what to check>`, and every done / fixed / passed claim needs output, logs or diffs.

Module map, per-layer seams and every measured host fact: [AGENTS.md](./AGENTS.md). Dated evidence behind each v2 claim: [docs/v2-port-notes.md](./docs/v2-port-notes.md). `pt07/` holds the PT-07 baseline suite; `scripts/` the one-line installers.

## 🔧 Customization

**Override an agent** — the same name in your config wins:

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

**Disable one:** `"researcher": { "disable": true }`. Board retention, auto-create, the default-agent check and the R6 kill switch are plugin-entry `options` — see [Configuration](#️-configuration).

## ❓ Troubleshooting

**Will this eat my tokens?** The opposite is the point. Offload + 80-token previews + the host's Code Mode `execute` exist because a five-agent pipeline naively bolted onto one context window *would* eat your tokens. The governance is the token-saver.

**Is the web access safe?** It is the most guarded surface in the plugin: two full web roles plus a browser-only tester grant, an allowlist whose off-list calls fail closed, redirects re-checked per hop with the whole chain reported, env-file URL refusal, address red lines no setting opens, and every payload under the same offload governance.

**Why doesn't the plugin auto-update?** OpenCode caches plugins by spec string and never re-resolves `@latest` (upstream limitation). **Re-run the installer — that IS the update**; or delete the cache by hand:

| OS | Purge command — recursive, covers BOTH cache layouts |
|---|---|
| macOS / Linux | `find ~/.cache/opencode/packages -type d -name '*opencode-team-mode*' -prune -exec rm -rf {} +` |
| Windows (PowerShell) | `foreach ($r in "$HOME\.cache\opencode\packages", "$env:LOCALAPPDATA\opencode\cache\packages") { if (Test-Path $r) { Get-ChildItem $r -Directory -Recurse -Filter '*opencode-team-mode*' -EA SilentlyContinue | Sort-Object { $_.FullName.Length } | Remove-Item -Recurse -Force -EA SilentlyContinue } }` |

A top-level-only delete silently misses the scoped `@te-river/` copy: OpenCode loads from `~/.cache/opencode/packages/`, **not** `~/.config/opencode/node_modules`. And **a published version can be shadowed by your HOME** — the host resolves a package spec through the nearest `node_modules` walk from HOME, so a stray `~/package.json` with a `devDependencies` pin loads *that* copy. The diagnostic is the boot probe's `entrypoint=` line, not a guess.

**A knob I set in an env var does nothing.** Configuration is JSON now; any `TM_*` variable other than the three internal switches is inert. Run `tm_stats` and read the layered-config section — it names the per-key source, so a value you expected shows a source that is not the file you edited.

**A red-line key I set in the project file is ignored.** By design: the five red-line keys are honored only in the **global** file, and `tm_stats` reports the ignored attempt by name.

**My `AGENT NOT FOUND: "Team"`.** The file name IS the agent id, and Windows/APFS keep the existing spelling when a write opens the file through another one — so a pre-1.7.2 `team.md` survives every install and the host registers the lead as lowercase. Use `--agent team`; the installer's reclaim pass renames a case-only entry it has proven is the same file.

**Can agents run tools in parallel?** Yes, and they are engineered for it: parallel `tm_search` / `tm_webfetch` / `tm_fetch` calls get distinct step ids and isolated payloads, and a regression fails the suite before it reaches you.

**Does it work in the CLI (TUI), or only Desktop?** Both. Desktop adds the color-coded picker and panels; the governed tools and the workflow are host-agnostic. Interactive browsing is the host's own `browser_*` catalog, so CLI / standalone has none — reported as a gap, never simulated.

**What happens if I don't answer the host's permission prompt?** The host decides that, not this plugin. The plugin can only refuse: it never self-allows, every guard can only make a rule stricter, and a session it does not recognize as one of its own is left exactly as the host behaved.

---

## 🗑️ Uninstall

1. Remove the entry from the `"plugins"` array in your config file; on 2.x also delete the generated `~/.config/opencode/agents/*.md` and `commands/team-*.md`, and any `default_agent: "team"` you no longer want.
2. Delete the cache dir (purge commands in [Troubleshooting](#-troubleshooting)) if you want the disk space back.
3. Restart OpenCode. The agents, commands and tools are gone; the stores under `<repo>/.git/opencode-team/` (and `~/.opencode-team/` for global memories) are plain files you can delete whenever. The global `team-mode.jsonc` is yours to keep or delete — the plugin writes a fresh inert one if you remove it.

No DLLs were harmed; nothing was written to your working tree.

## 🤝 Contributing

Issues and PRs welcome. Especially wanted: localization of agent prompts, more agent roles, more command templates, and real-world reports of the search engines' behavior (they rearrange their markup; the extractor filters are intentionally loose but not psychic).

## 📄 License

[Apache License 2.0](./LICENSE)

## 🔗 Links

- [npm Package](https://www.npmjs.com/package/@te-river/opencode-team-mode) — `@te-river/opencode-team-mode`
- [Installation guide, **OpenCode 2.x**](./docs/installation-v2.md) — the supported install: a 2.x plugin cannot create an agent, so the six roles and six commands are generated into the config directory
- [Installation guide, 1.18.x](./docs/installation.md) — **historical only**: the 1.18.x personality was removed in the 1.7.0 line
- [OpenCode Desktop](https://opencode.ai) — Official website & download
- [OpenCode Docs](https://opencode.ai/docs) — Configuration & plugin documentation
- [OpenCode Plugin API](https://opencode.ai/docs/plugins) — Build your own plugins
