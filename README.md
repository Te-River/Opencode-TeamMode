# OpenCode TeamMode

**[English](./README.md)** | **[中文](./README.zh-CN.md)**

[![npm version](https://img.shields.io/npm/v/@te-river/opencode-team-mode.svg)](https://www.npmjs.com/package/@te-river/opencode-team-mode)
[![npm downloads](https://img.shields.io/npm/dm/@te-river/opencode-team-mode.svg)](https://www.npmjs.com/package/@te-river/opencode-team-mode)
[![license](https://img.shields.io/npm/l/@te-river/opencode-team-mode.svg)](./LICENSE)

> 🤝 **Your OpenCode just hired a team.** Seven roles — a Lead, an Architect, an Implementer, a Reviewer, a Tester, a Researcher and a **ComputerUser** (dispatched only when a desktop-control MCP is present) — with governed tools, structured handoffs and a plan-first approval gate. One plugin, no files to copy.

> 💡 **Best for medium-to-large projects.** The governance layer (approval gate, context offload, tool allowlists) is an asset once a codebase has real surface area — and mostly overhead on tiny scripts and one-off questions. Use it where the work is.

---

## 📑 Contents

- [TL;DR](#tldr--skip-the-docs)
- [Why TeamMode?](#-why-teammode)
- [Quick start](#-quick-start)
- [The team](#-the-team)
- [What's new in 1.9.7](#-whats-new-in-197)
- [How the team works](#-how-the-team-works)
- [Tools](#-tools)
- [Optional: computer use](#-optional-computer-use-real-desktop)
- [Governance & security](#-governance--security)
- [Configuration](#️-configuration)
- [Troubleshooting](#-troubleshooting)
- [Uninstall](#️-uninstall)
- [License](#-license)

---

## TL;DR — skip the docs

> **The lazy path:** paste this to any coding agent and let it do the work:
>
> ```text
> Install the OpenCode plugin @te-river/opencode-team-mode. This package supports **OpenCode 2.x
> only** — the 1.18.x personality was removed in the 1.7.0 line. Follow
> https://raw.githubusercontent.com/Te-River/Opencode-TeamMode/main/docs/installation-v2.md
> (a 2.x plugin cannot create an agent, so the seven roles and six `/team-*` commands come from
> a generator step in that guide — that step is not optional.) Then run its verification checks.
> If a URL is unreachable — common on mainland-China networks — retry with the mirror prefix
> https://ghproxy.net/ + the same path. If `npm` is slow or blocked, run
> `npm config set registry https://registry.npmmirror.com`.
> ```
>
> **The one command to remember afterwards:** `/team-run <task>` — the Team Lead plans it, shows you the plan, waits for your approval, then runs the whole team.

---

## 🤔 Why TeamMode?

One agent doing everything ends the way you have seen it: a context window stuffed with 5000-line file dumps, twenty `shell` round-trips for what one script could do, sub-agents that quietly read `.env`, and web "research" that is the model's imagination. Each one gets a mechanism, not a promise:

| Pain | What is actually enforced |
|---|---|
| 🔥 **Context flooding** | Every result above its content-class boundary (prose 4000 / data 2000 tokens, CJK-aware) is offloaded to a local run store and replaced by an ~80-token preview plus an HMAC handle. `tm_fetch` pages back only what is needed. |
| 🐌 **Round-trip overhead** | The host's own `execute` (Code Mode): one program, N governed calls, zero LLM round-trips in between. |
| 🕳️ **Silent side effects** | R6: a Team role reading a `.env` is **denied** with no consent path; an env-reading shell command goes to the host's own prompt. Every guard can only make a rule stricter — the plugin never self-allows. |
| 🌫️ **Hallucinated research** | The web is a two-role grant over allowlisted tools with per-hop redirect checks; a fact that could not be fetched is reported as a gap, never simulated. |
| 🎯 **Goal drift** | The Lead opens with `GOAL:` in your words plus checkable `ACCEPTANCE:` criteria, the ledger holds every ask as an item, and `tm_join` says 目标未达成 while items are still open. A host goal, when you ask for one, is bridged by `tm_goal` rather than re-implemented. |
| 🗣️ **Replies in a language you never chose** | The governed tools answer in Chinese; every role carries a reply-language rule — your language in the prose, a Chinese string quoted verbatim only where it *is* the evidence. |
| ⏱️ **Rounds spent looking careful** | 效率至上: one wide call over three narrow ones, independent calls batched into one round, ≥3 probes folded into one `execute` program — and efficiency never buys its way out of the evidence rule. |

Under the table sits the workflow discipline: deterministic routing, a ≤30-line plan you approve before ≥2 dispatches, `STATUS/CHANGES/FINDINGS/EVIDENCE/HANDOFF` replies, and static verification (build / typecheck / tests) instead of vibes.

---

## ⚡ Quick start

**1 · Install.** Paste the [TL;DR](#tldr--skip-the-docs) block, run an installer, or follow [docs/installation-v2.md](./docs/installation-v2.md) by hand. Two things decide whether it works:

- The key is **`plugins` (plural)**, and a 2.x entry is a string or `{ "package": …, "options": { … } }`. Entries across config files are **applied lowest→highest rather than replacing one another**, so keep exactly one Team entry — writing ours into both `opencode.json` and `opencode.jsonc` loads the plugin twice.
- A 2.x plugin **cannot create an agent**, so `node <pkg>/scripts/gen-v2-config.mjs` writes the seven roles and six `/team-*` commands into the config directory. The installer does this; doing it by hand means doing this.

Then restart with `opencode service restart` (or quit Desktop from the tray, not just the window). A restart is safe mid-session: the conversation survives, only an in-flight tool call is aborted.

**2 · Team is your default.** The installer writes `default_agent: "Team"` **last**, after the role files exist — a default naming a missing agent silently falls back to `build`, which is why the order matters and why boot reports what it found. Team is the picker's default; the six specialists run as subagents (dispatched by the Lead) and do not appear in the picker. The `/team-*` commands run as Team and dispatch the named specialist.

**3 · Ask.** `/team-run <task>`, or `@team <task>`. If the run needs ≥2 dispatches you get a ≤30-line plan first and it waits for your approval.

Updates: **re-run the installer** (it regenerates the role/command files). On 2.x the host installs the package itself and a `@latest` spec is not re-resolved in place; if the host keeps loading the previous version, clear its per-package cache (`~/.cache/opencode/npm/@te-river`) and restart. The `~/package.json` shadowing trap and the `entrypoint=` diagnosis are in [Troubleshooting](#-troubleshooting).

<details>
<summary><b>What the installer changes on your machine</b></summary>

All of it is outside this repo; the installer prints what it changed and reads the value back:

- **Config entry** → `~/.config/opencode/opencode.jsonc` (created if missing; our entry is reclaimed from `opencode.json` — the two files merge, so exactly one Team entry is kept) — until you delete the line.
- **Seven roles + six commands** → `~/.config/opencode/agents/*.md` and `~/.config/opencode/commands/*.md`, generated from the installed package (a 2.x plugin cannot create an agent, so this step is not optional).
- **Default agent** → `default_agent: "Team"` written last, after the role files exist, and read back from disk.
- **Not touched:** the host's npm cache and `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` — 2.x runs background sub-agents natively, so no env flag is set.
- **Undo:** delete the `plugins` line (optionally the generated `agents/` / `commands/` files) and restart.

</details>

---

## 👥 The team

| Agent | Role | When it runs |
|---|---|---|
| 🎯 **Team Lead** (`@team`) | Orchestrator | Every complex task: plans, dispatches, verifies, reports |
| 🏗️ **Architect** | System designer | Design docs, module structure, API contracts — **only when the design is genuinely unknown** |
| 💻 **Implementer** | Code writer | Building features, writing production code |
| 🔍 **Reviewer** | Dimension-focused auditor | One dimension by default; 3 in parallel only for high-risk changes |
| 🧪 **Tester** | Test engineer | Real edge-case tests, static verification, UI verification through the host's `browser_*` tools |
| 🔎 **Researcher** | Knowledge finder | Local repo first, then the web — one of the two network roles |
| 🖱️ **ComputerUser** | Desktop operator | Only when a computer-use MCP is installed: drives **one named window**, screenshots before acting, reports the verdict instead of assuming the click landed |

Grants follow the job, not seniority: Lead `task / edit / write / shell / question`, Implementer and Tester `edit / write / shell`, Reviewer `shell` only, Architect, Researcher and ComputerUser **nothing** beyond the governed tools; the desktop MCP itself is gated to Lead and ComputerUser. Only the Lead dispatches — no specialist can spawn a specialist.

Slash commands map onto the same specialists: `/team-plan` (Architect), `/team-implement` (Implementer), `/team-review` (Reviewer), `/team-test` (Tester), `/team-research` (Researcher), `/team-run` (Team Lead).

---

## ✨ What's new in 1.9.7

*1.9.7 is the current release.*

**1.9.7 — the goal feature, both halves.** Host 2.2.x ships an `opencode.goal` plugin whose RPC exposes exactly one method (`get`); a write RPC does not exist (verified by declaring `set`/`clear`/`pause` in a client and calling them — the host answers `Unknown RPC method: opencode.goal.set`). Its state lives in its own storage namespace, which `ctx.storage` cannot read. So:

- `status` reads the host goal (objective, status, rounds, stalls, reason, boot). In a child session it walks up to the parent's goal (≤5 hops, cycle-guarded) — the contract that line of work inherits.
- `set` / `pause` / `resume` / `clear` are **forwarded to the host's `/goal` command** and never awaited: that command runs a whole host turn, so awaiting it would park the caller. The reply therefore says **submitted, never active** — only the host's own `status:"active"` on the next turn is proof.
- **A goal ends two ways, and `clear` is the rarer one.** The host's own reviewer reads your *last message* and may mark the goal `complete` by itself — so a confident "done" is how a user's contract ends. `status` reports that verdict as the host's, never as acceptance.
- **Ending is gated**: `clear`/`pause` refuse while the ledger still has open items and name their ids; `resume` is never gated; an unreadable ledger is announced instead of being treated as empty.
- **The Lead hears the change.** The host emits `events.changed` on every write; `tm_goal` subscribes, dedupes by state (our own `set` echoes back through the same event), writes one trajectory row per transition without the objective text, and leaves one line in the Lead's next state card: *"the host just marked this goal complete (round N) — that is the host's verdict, not your acceptance."*
- Writes are **Lead-only**; reads are open to all roles. `set` refuses an empty objective, the host's measured 4000-character cap, an objective spelled exactly `pause`/`resume`/`clear` (the host would run it as a subcommand), and requires `replace:true` over a goal in any status other than `complete`.

**computer-use 0.0.6 ships alongside**: every tool now accepts `window: "<title substring>"` — `screenshot` crops to that window and **never steals focus**, while `click` / `scroll` / `drag` / `type_text` / `key` focus it, act, and **restore your previous foreground window** afterwards. The tools' first 120 characters now carry the contract, because that is all the Code Mode catalog shows.

**v2 registers nine governed tools:** `tm_fetch`, `tm_webfetch`, `tm_search`, `tm_memory`, `tm_join`, `tm_stats`, `tm_board_write`, `tm_ledger`, `tm_goal`.

**Merged on `main`, not in any published release yet** (the next release after 1.9.7 / computer-use 0.0.6): the six specialists may no longer background their own work — a hard layer rewrites a truthy `background` on a non-lead call to `false` and the call runs in the foreground (enforcement, not a failure; the Lead is exempt); `envProtect: "off"` no longer lifts the env-file path red line — the published 1.9.7 still lets `off` short-circuit it, a bug already fixed on main; the one-restart computer-use upgrade; and the `CU_AUDIT_MAX_BYTES` / `CU_IMAGE_BUDGET_BYTES` knobs, which will ship with computer-use 0.0.7 (the tag does not exist yet). The sections below mark each of these in place.

---

## 🏗️ How the team works

Sub-agents cannot message each other live, so coordination is a **structured reply skeleton** — every specialist reply is `STATUS: / CHANGES: / FINDINGS: / EVIDENCE: / HANDOFF:`, ≤50 lines, relayed verbatim into the next dispatch. A deliverable over ~50 lines goes to one board file (`tm_board_write`) under `<repo>/.git/opencode-team/` — round-suffixed, never overwritten, working tree untouched.

- **Routing table (deterministic):** question → direct answer; docs-only → Implementer; product change → Implementer → Tester → Reviewer; multi-module → Architect → Implementer → Tester → Reviewer(s); unknown tech → Researcher first. A product change routed below three dispatches is a routing bug.
- **One dispatch, one verifiable deliverable** — if the Lead cannot say how a child's result will be verified *on its own*, it is a wish, not a dispatch. The Architect is conditional: with a verified root cause (file:line evidence), skip it.
- **Parallel by default where independence holds:** Tester and Reviewer in the same round; Implementers with disjoint file ownership; Testers on disjoint packages.
- **Approval gate (count-based):** ≥2 dispatches → plan (≤30 lines) → **your approval** → execute. Blocking questions are batched and asked immediately. Splitting one ask into sub-2-dispatch slices to dodge the gate is a protocol violation.
- **Ledger:** every new ask becomes a `tm_ledger` item *before* the work starts; an interruption is an insertion, not a replacement. `blocked` is a state, not an exit.
- **Blackboard:** files are the exception. One file per deliverable, named by the tool (`NN-<role>-<topic>[-rN].md`), role taken from the session — a child cannot file under a borrowed name.
- **Static verification:** build / typecheck / lint / tests. Improvised browser automation is not verification; unverified UI work ends with `UI NOT VERIFIED: <what to check>`, and every done / fixed / passed claim carries output, logs or a diff.
- **Truncation:** a user stop is a scope change, not permission to abandon work in flight. Land what is open, issue no new work, skip verification, and hand over in four sections — 已落盘 / 未开始 / 验证 / 提交与发布.

---

## 🧰 Tools

**Native host tools come first.** Read / grep / glob / edit / write / shell are the host's own, and JIT governance covers them through `tool.execute.after` — a measured 12,902-token `shell` result arrives as a 78-token preview plus a handle. **Code Mode (`execute`)** is the host's one-program-many-calls surface, and it is the answer to round-trip cost: several governed calls, one round, only the aggregate comes back.

| Governed tool | In one line | Roles |
|---|---|---|
| `tm_fetch` | Pages an offloaded result by handle; JSON handles take a `fields` dot-path projection (`items[].name`). | every role |
| `tm_webfetch` | One governed GET of an allowlisted page; redirects re-checked per hop, the whole chain named on refusal. | Lead + Researcher |
| `tm_search` | Multi-engine search: parallel fan-out, host+path dedup, weighted-RRF fusion, an extractable hit list. | Lead + Researcher |
| `tm_memory` | Session / project / global memory: add / search / list / forget / compact, with near-duplicate folding. | every role |
| `tm_join` | The read side of sub-agent work: status, bounded `waitMs`, `cancel:true` with five distinct verdicts, a named child's whole reply. | Lead only |
| `tm_stats` | Reads this plugin's own trajectory back: tokens kept out, dispatch overlap, capability matrix, layered-config sources. | every role |
| `tm_board_write` | The board's write side: one new `NN-<role>-<topic>[-rN].md`, named by the tool, never overwritten. | every role |
| `tm_ledger` | The Lead's task ledger in the host's `ctx.storage` — 2.x gives a plugin no `todowrite`. | Lead only |
| `tm_goal` | Reads the host's goal; forwards set / pause / resume / clear to `/goal`. **已提交 ≠ 已生效.** | read: every role · write: Lead only |

**There is no plugin-side dispatcher.** `tm_dispatch` was removed (this sentence is history, not a current option): a child a plugin creates is a session you can neither open from a card nor stop from the interface. Delegation goes through the host's own `task` — for the Lead, `{ background: true }` is the standard shape (the plugin forces it), the card is visible and stoppable in the host, and `tm_join` is the collect side. From the next release (**merged on `main`, not published yet**) the six specialists may not background their own work: a truthy `background` on a non-lead call is rewritten to `false` and the call proceeds in the foreground — enforcement, not a failure, because once a child settles, its later background wake-up reaches neither side, so the result would have no receiver.

**Browser and network grants.** Interactive browsing is the host's `browser_*` catalog — the plugin stopped policing it with the 2026-11-07 decision that deleted `v2-browser-gate.ts`; who is offered the catalog at all stays the permission matrix's call. The Tester carries it for UI verification of your project; open web belongs to the Lead and the Researcher. Architect, Implementer and Reviewer have **no network grant** — a web question there is reported as a gap, never simulated. A host with no browser catalog (CLI / standalone) has no browser at all, and the agent says so.

---

## 🖱️ Optional: computer use (real desktop)

An **optional** MCP server (`computeruse`, off by default, shipped as its own
[release asset](https://github.com/Te-River/Opencode-TeamMode/releases/tag/computeruse-v0.0.6))
that lets `Team` (the lead) and the **ComputerUser** specialist take screenshots and drive the
mouse/keyboard. `researcher`, `tester`, `architect`, `implementer` and `reviewer` are turned away
at **three** layers — because the first one we built turned out to be a no-op on a live host:
① `permission.evaluate`, which the host **does** fire for MCP tools
(`action=computeruse_control_status`, measured) and where a denied role is answered with
`effect:"deny"`; ② the inner `execute` event the host raises for the call itself (empty input,
role carried on the event); ③ the outer program text, matching `computer[\s._-]?use` — a text
gate, **not** a sandbox.

**Window scope is the point.** Every tool takes `window: "<title substring>"`: `screenshot`
crops to that window and never steals focus, while the five mutating tools focus it, act, and put
*your* previous foreground window back afterwards. Without it a call means "whatever happens to
be on top" — which is how a feature like this loses a user's trust in one click.

What is and is not protected:

- **Elevated (UAC) windows are unreachable.** Only a Windows process can drive the secure
  desktop, so an admin prompt is exactly the place this cannot click.
- **Typed text bypasses this project's R2/R6 classifiers.** `type_text` is delivered as
  keystrokes, not a shell command string, so `shellGuard` / `pathGuard` never see it and the
  env-variable red line does not exist on that path. Never type credentials with it.
- **Screenshots are not JIT-governed.** They arrive as non-text parts, and the offload layer
  only governs text — so an image neither enters the context budget nor gets offloaded.
- **`researcher` is the highest-risk role here.** It is the one that reads untrusted web pages,
  and screen control plus untrusted page content is the worst combination in this feature: a
  page saying "type X into the terminal" is aimed straight at it. The mitigations are the
  server's action budget, its audit trail and a human watching — not a prompt sentence.
- **Three layers, and the honest limit of the last one.** ③ is a text-level gate: a program that
  assembles the name (`"computer"+"use"`) gets past it. When that happens the call is **counted**,
  not silently allowed — one `computeruse_bypass` row on disk naming the role and the tool, so
  "we did not stop it" and "it is allowed" stay different claims. The computer-use section of
  `tm_stats` separates five states: the tool names actually seen, a deny that matched nothing, a
  bypass, "configured but the server never registered", and "configured and connected but absent
  from `event.tools`" — MCP tools live in the Code Mode catalog, which is **not** the same as a
  server that failed to start.
- **The strongest layer is not verified on a live turn.** `permission.evaluate` firing is
  measured; `effect:"deny"` working is measured for `shell` and `read`; the composition on an MCP
  action was deliberately left untested, because a live turn writes a session into your own store.
  Treat the role split as a guardrail under observation, not as an isolation boundary.

Install it explicitly: `.\scripts\install.ps1 -ComputerUse` (POSIX
`bash scripts/install.sh --computer-use`); the installer's main flow never touches it.

**Upgrading takes one restart — and one restart is the floor** *(the versioned-directory mechanism is merged on `main`, not in the published installer yet)*. A new version is written into its
own versioned directory, so no file the host is running gets replaced: the install itself happens
while OpenCode is up. That one restart is only what lets the host load the new command, and a
fully zero-restart upgrade is impossible — the host reads its MCP connections at startup, and this
installer never kills a process.

Two more user-visible knobs are merged on `main` for the **pending computer-use 0.0.7 — the published 0.0.6 does not have them**: `CU_AUDIT_MAX_BYTES` (default 64 MiB — the total-size cap on
the audit trail, `0` = no cap) and `CU_IMAGE_BUDGET_BYTES` (default 4 MiB — the per-process budget
for JPEGs allowed to ride replies; an image left out of a reply is not a blank screen and not
"nothing changed").

Everything else — how the release directory you left behind gets reclaimed, how a "no" is
remembered so you are never asked twice, the audit format and the undo — lives in a page kept
deliberately apart from the install guide:
[`docs/computer-use.md`](./docs/computer-use.md).

## 🔒 Governance & security

Every tool call runs under one pipeline. Under it sit the guards, and **each can only make a rule stricter**:

- **R6 env protection** (armed by default, `strict`): an env-*file* read by a Team role is a hard **deny** with no consent path — for `read`/`edit`/`glob`/`grep`, including the case where the host reports only the *pattern* as the resource (`grep SECRET .env`). Templates (`*.env.example` / `.sample` / `.template` / `.dist`) stay readable. An env read *inside a shell command* goes to the host's own prompt, decided per command — `git status` asks nothing. Env reads no wildcard can express are refused, never asked, and the audit log records only tool name + category + verdict.
- **R2 dangerous operations:** delete, publish, install, kill, privilege changes — none silently allowed, while the normal verification stack (`npm test`, `tsc`, `git status`) is not gated.
- **Address red lines** (no setting opens them): cloud-metadata, link-local, multicast, reserved and benchmarking ranges, in their IPv4-mapped and DNS64 spellings too — changing the notation is not a bypass.
- **Web allowlist** (a gate, not a wall): on 2.x the domain gate defaults to `["*"]` — open — because a plugin cannot raise the dialog a restricted list would need, and a gate with no door is not a gate. Set `webfetchAllowedDomains` and it becomes a real list: the seed is 22 hosts plus 2 engine seeds while the default seed is in play, parent domains cover subdomains, a custom list **replaces** the seed, and an off-list call **fails closed** with a refusal naming the exits (`privateSpace: "allow"`, or that one hostname on the list).
- **Offload:** three outcomes, not two — offload (payload + preview + handle), **cap keeping addressing** (a browser snapshot keeps every `[ref=…]` line, drops prose, 1200-token budget), **cap keeping tables** (a report keeps its rows, 1600-token budget). A table with a row missing is not smaller, it is broken.
- **Context pruning:** past 70% of the window a settled body becomes a one-line pointer — but only after it was offloaded, so the stub carries a real `tm_fetch` handle. Reply skeleton, GOAL/ACCEPTANCE, provenance, system messages and the board note are never cut.
- **Retries:** a throttle is classified by name and text, then answered per request — 5s / 10s / 20s / 40s / 60s, never shared across requests; the host's own countdown wins when it has one. A hard quota is the billing family only and names no wait.
- **Scope:** every hook fires for every session on the host, so each layer asks "is this one of our seven roles?" first. `build`, `plan` and your own agents stay exactly as a fresh install leaves them; calls whose owner was not identified are left alone and **counted**, and `tm_stats` prints 作用域: 我们 · 他人 · 未判定.

> ⚠️ **When you approve the host's own dialog, pick "once" — not "always".** Verified live: "always" records a far broader rule than the command you saw (approving `Get-ChildItem env:PATH` stores `Get-ChildItem *`), and one saved web rule answers for **every agent session in that project**. The reply says which path let a page in — static allowlist, the dialog you just answered, or a saved rule that answered in milliseconds — because an agent that cannot tell them apart reports "no dialog" as "that site is allowed".

Scratch work is told to live in the OS temp dir and be deleted before a run reports done; the offload / trajectory / memory stores sit under `<repo>/.git/opencode-team/` (outside a git repo: the OS temp dir, sharded per workspace) — never your working tree.

---

## ⚙️ Configuration

**Configuration is JSON, and only JSON.** `team-mode.jsonc` is the single source. There is no environment layer: a `TM_*` variable you set for configuration is inert.

| Layer | Path | Precedence |
|---|---|---|
| **global** | `~/.config/opencode/team-mode.jsonc` (honours `OPENCODE_CONFIG_DIR`) | lowest — every project |
| **project** | `<dir>/team-mode.jsonc`, walking from the workspace **up to the filesystem root** | middle — direct files merge farthest→closest |
| **project** | `<dir>/.opencode/team-mode.jsonc`, same walk | every `.opencode/` file overrides every direct file |
| **system** | `%ProgramData%\opencode\team-mode.jsonc` (Windows) / `/etc/opencode/team-mode.jsonc` (POSIX) | **highest** — the host's managed-settings layer |

That walk and precedence are the host's own config-layering rule, copied rather than invented. JSONC comments are masked at the byte level, so a commented-out key cannot read as live; a layer that fails to parse is skipped **whole**; a single bad key loses only itself, and unknown keys are warned about and never applied.

**It writes itself.** When the global file is absent the plugin creates it — atomically, never overwriting an existing file — with all **65** registry keys present as *comments* under a one-line description. It parses to `{}` and sets nothing until you uncomment. `autoCreate: false` (or `TM_CONFIG_AUTOCREATE=off`) turns that off.

**Red-line keys** (`envProtect`, `r6FineAsk`, `privateSpace`, `webfetchAllowedDomains`, `bashReadonlyAllowed`) are honored **only in the global or `system` layer**. A project file may set them; the value is ignored and reported, because a committed project config must not switch off a guard for everyone who clones the repo. The set is derived from the registry, so a new red-line key is red-line by declaration.

**Plugin options** live on the plugin entry, not in `team-mode.jsonc`:

```jsonc
{
  "plugins": [
    { "package": "@te-river/opencode-team-mode@latest",
      "options": { "defaultAgent": true, "autoCreate": true, "envProtect": true } }
  ]
}
```

| Option | Default | Meaning |
|---|---|---|
| `defaultAgent` | `true` | Check and report which agent the installer's `default_agent` names. The 2.x plugin ctx has no `agent.default`, so the plugin cannot promote anything; `false` skips the check. |
| `autoCreate` | `true` | Write the inert global `team-mode.jsonc` at boot when absent. |
| `envProtect` | `true` | Scope of `false`/`"off"`: the R6 **fine-grained ask face + extra-deny**. It does NOT lift the env-file path red line or the address red lines — a red line has no consent path. **That scope is merged on `main` (`65f738f`), not published yet: the current release 1.9.7 still lets `off` short-circuit the path face — a bug, fixed on main.** |

On 2.x an entry is a string **or** an object with `package` and `options`; the 1.x tuple form is rejected outright. Options do arrive — the object form is what the boot row reads back. Retention is configuration rather than an option: `blackboardTtlDays` (default 7) sets the blackboard and handle TTL.

**Model choice.** Every judgement — triage, decomposition, dispatch briefs, synthesis, review verdicts — flows through the Lead, so a weak model there degrades the whole pipeline. Pin your best reasoning model to `team`:

```jsonc
{
  "agent": {
    "team": { "model": "anthropic/claude-opus-4-5" },          // Lead earns your best model
    "implementer": { "model": "anthropic/claude-sonnet-4-6" }, // specialists tolerate cheaper
    "researcher": { "disable": true }                          // or drop a role entirely
  }
}
```

Your own definitions win; the plugin never clobbers them. The one rule that makes the layer trustworthy: **`CONFIG_KEYS` is the registry and the single source of truth** — a key absent from it is reported and never applied, and `tm_stats` renders per-key source, skipped layers, unknown keys and the red-line attempts it ignored.

**Three `TM_*` names survive as internal / test switches — not configuration:** `TM_STORE_RECLAIM` (overrides `storeReclaim`), `TM_V2_PROBE` (a JSONL path where the surface probe records the host's real tool ids, action names and argument key **names** — names and counts only, never a command line, path, URL or value), `TM_CONFIG_AUTOCREATE` (`off` suppresses the inert template).

---

## ❓ Troubleshooting

**Will this eat my tokens?** The opposite is the point. Offload, ~80-token previews and Code Mode exist because a seven-role pipeline naively bolted onto one context window *would* eat your tokens. The governance is the token-saver; `tm_stats` shows the count.

**A `TM_*` variable I set does nothing.** Correct — configuration moved to JSON. Move the value into the matching registry key in `team-mode.jsonc`, then run `tm_stats`: its layered-config section names each key's source file, so a value you thought was accepted shows up as coming from somewhere you did not edit.

**A red-line key in my project file was ignored.** By design. Those five are honored only in the global or `system` layer, and `tm_stats` names the attempt instead of dropping it silently.

**The plugin will not update itself.** OpenCode caches plugins by spec string and a `@latest` spec is not re-resolved in place (upstream limitation). Re-running the installer regenerates the role/command files; if the host keeps loading the previous version, clear its per-package cache (`~/.cache/opencode/npm/@te-river`) and restart. If the boot probe's `entrypoint=` line points outside the host's own cache, a `~/package.json` is pinning a different copy — that line is the diagnosis, not a guess about cache layers.

**`AGENT NOT FOUND: "Team"`.** The file name is the agent id, and Windows / APFS keep the existing spelling when a write opens that file through another one — so a pre-1.7.2 `team.md` survived every install and the host registered a lowercase lead. Use `--agent team`; the installer's reclaim step renames a case-only entry once it has proven it is the same file.

**Can agents call tools in parallel?** Yes, and it is designed for it: concurrent `tm_search` / `tm_webfetch` / `tm_fetch` get distinct step ids and isolated payloads, and a regression there turns the suite red before it reaches you.

**Desktop only, or CLI too?** Both. The desktop adds the coloured role picker; the governed tools and the whole workflow are host-agnostic. Interactive browsing is the host's own catalog, so CLI / standalone has no browser — reported as a gap, never simulated.

**What happens if I ignore a host permission prompt?** That is the host's timer, not this plugin. The plugin can only reject: it never self-allows, every guard it installs only tightens, and a session it does not recognise as one of ours is left exactly as it found it.

---

## 🗑️ Uninstall

1. Remove the Team entry from the **`plugins`** array. On 2.x also delete the generated `~/.config/opencode/agents/*.md` and `commands/team-*.md`, and the `default_agent: "Team"` line if you no longer want it.
2. Delete the cache directory if you want the disk back (commands in [Quick start](#-quick-start) / [Troubleshooting](#-troubleshooting)).
3. Restart OpenCode. Agents, commands and tools are gone. The stores under `<repo>/.git/opencode-team/` and the global memories under `~/.opencode-team/` are ordinary files — delete them whenever. The global `team-mode.jsonc` is yours to keep or remove; delete it and the next install writes a fresh inert one.

No DLLs harmed. Nothing was ever written to your working tree.

---

## 📄 License

[Apache License 2.0](./LICENSE)

- [npm](https://www.npmjs.com/package/@te-river/opencode-team-mode) — `@te-river/opencode-team-mode`
- [Install guide (**OpenCode 2.x**)](./docs/installation-v2.md) — the supported path; a 2.x plugin cannot create an agent, so the seven roles and six commands are generated into the config directory
- [Install guide (1.18.x)](./docs/installation.md) — **historical only**: that personality was removed in the 1.7.0 line
- [OpenCode](https://opencode.ai) · [docs](https://opencode.ai/docs) · [plugin API](https://opencode.ai/docs/plugins)
- Module map, per-layer seams and every measured host fact: [AGENTS.md](./AGENTS.md); dated evidence behind each v2 claim: [docs/v2-port-notes.md](./docs/v2-port-notes.md)

Issues and PRs welcome — especially measured reports of engine behaviour (search engines change shape often, and the extractor is deliberately lenient rather than telepathic).
