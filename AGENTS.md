# Opencode-TeamMode — Agent Guide

## What this is
OpenCode Desktop plugin that injects a multi-agent team (6 agents, 6 commands) into the user's workspace. Published as `@te-river/opencode-team-mode` on npm.

## Design goals (business context)
1. **A complete "Team" mode** — one lead + five specialists orchestrated by a deterministic routing table, a count-based approval gate, and structured STATUS/CHANGES/FINDINGS/EVIDENCE/HANDOFF handoffs.
2. **Parallel efficiency in medium/large projects** — independent dispatches batch into the same round; parallel implementers interoperate through verbatim data contracts; adaptive review escalates to 3 parallel dimensions only for high-risk changes.
3. **Kill the many-bash-round-trips inefficiency** — reads/search/enumeration go through the governed tm_bash (read-only allowlist) instead of ad-hoc shell ping-pong, and tm_ptc_run runs one async program that makes N governed tm_* calls with ZERO LLM round-trips, returning only an aggregation summary.
4. **JIT context governance / token economy** — tool outputs above the token threshold never enter the context window (offload store + 80-token content-aware previews + HMAC expiring handles fetched via tm_fetch); sub-agent context stays minimal (no README re-reads, tm_*-only file access), saving user tokens.
5. **Two-channel web access (network roles: team lead + researcher ONLY)** — user-configured MCP/plugin tools are the HIGH-priority channel; tm_webfetch (domain-allowlisted, threshold-offloaded, seeded with moegirl/bilibili/bing/baidu) is the governed fallback; the other four agents report web questions as gaps, never simulated.

## Commands
| Action | Command |
|---|---|
| Build | `npm run build` (tsc -> dist/) |
| Test | `npm test` (tsc + test-blackboard.mjs + test-envprotect.mjs + test-tm-tools.mjs + test-default-agent.mjs) |
| Dev watch | `npm run dev` |

All test suites must pass before committing.

## Project structure
| File | Role |
|---|---|
| `src/agents.ts` + `src/prompts/` | Agent definitions (structure: roles, modes, colors, temperatures, tool-whitelist matrix incl. tm_ptc_run all-allow + tm_webfetch lead/researcher-only grants); the prompt strings live verbatim in `src/prompts/lead.ts`, `src/prompts/specialists.ts`, `src/prompts/shared.ts` (REPLY_CONTRACT + SHARED_RULES) — pinned by test-blackboard.mjs |
| `src/commands.ts` | Slash command templates (`/team-plan`, `/team-run`, etc.) |
| `src/blackboard.ts` | Shared blackboard + TTL auto-cleanup sweeper |
| `src/envprotect.ts` + `src/envprotect/` | R6 env protection -- facade re-export + 5 modules: `patterns.ts` (the `R6_ENV_BASH_ASK` / `R2_DANGER_BASH_ASK` ask sets, `bashAskPatterns(mode, envFace)` dead-popup guard, mode parsing), `bash-classify.ts` (bash/PS env commands incl. pathed `/usr/bin/env` + `cmd /c` heads, `$env:`/`${VAR}`/`$ALLCAPS` expansion, env-file tokens), `path-classify.ts` (env-file paths), `gate-predicates.ts` (`isAskGatedEnvCommand()` BYTE-EXACT glob = dialog guaranteed -> defers, loose/armed categorize keeps hard throw; per-session scope via `deferToApproval(sessionID)`), `hook.ts` (`categorizePermission()` real `permission.asked` shape: tool in `permission`, `patterns[]`/`metadata.command` inference; tool routing; audit log); tm_* tools alias onto this surface (anti-backdoor, never deferred); the session-wide env-approved pass ("always") NEVER covers env-FILE reads (no dialog ever backs them -- they keep hard-throwing) |
| `src/approval-gate.ts` | Unified approval gate Layer 2 -- one shared timer over the live host's `permission.asked`/`permission.replied` (legacy `permission.updated` spelling accepted): auto-REJECTS an unanswered R6/R2 dialog after `TM_ASK_TIMEOUT_MIN` (default 10 min); `replied` (which may carry ONLY `{sessionID}`) cancels the session's WHOLE pending set + tombstones ids (ghost asked replays never re-arm, no dead-id double-reject); v1 `{error}` envelope unwrapped -> real SDK failures flip degraded; the plugin NEVER self-allows (reject-only reply); env-face asks + exec-role session registration (`registerExecSession`, `revokeExecSession` -- index.ts revokes when a user prompt routes to a NON-exec agent, closing the mixed-agent stale window; `canDefer(sid)`) gate deferral per-session; armed only when R6 is on AND the client can reply |
| `src/tm/` | JIT layer-2 tools (tm_read/tm_grep/tm_bash/tm_fetch/tm_memory/tm_webfetch/tm_ptc_run) -- `config.ts` env knobs + CJK-aware token口径 (CJK ≈ 1 token, other chars/4; `capTokens` truncates by the same cost basis) + shared allowlist parser, git-aware store dirs (AUTO = `<repo>/.git/opencode-team/{blackboard,trajectory}`, tmpdir fallback; explicit `TM_*_DIR` keeps absolute/project-relative semantics), `refs.ts` run ids + HMAC handles, `store.ts` run store + append-only trajectory + TTL sweep, `preview.ts` 5-branch previews (80-token cap) + structure summaries, `guard.ts` P2 path scope + P3 readonly allowlist (rejections guide to the bash confirmation dialog), `pipelines.ts` the four governed pipelines + threshold governance (`TmDeps` incl. `stepPrefix`), `result.ts` structured errors + ToolResult rendering, `client-unwrap.ts` host result unwrapping, `shell-bridge.ts` host `$` bridge, `args-schema.ts` zod raw-shape schemas, `tools.ts` thin assembly (`buildTmTools(deps, pipelines?)` shared-instance injection), `memory.ts` project/global memory mirror (Markdown + frontmatter under `<storeBase>/memories/`, add/search/list/forget, 4000-char cap, deterministic scoring), `webfetch.ts` governed web fallback (domain allowlist seeded with moegirl/bilibili/bing/baidu, `TM_WEBFETCH_ALLOWED_DOMAINS` override, http(s)-only, per-hop redirect re-check, remote env-file URL red line, HTML→text, 2 MB cap, 20 s timeout), `ptc/` 9-module PTC subsystem (contract/budgets/pscan/engines/gate/driver/summary/tool/index), `index.ts` runtime assembly (ONE main pipeline instance shared by the four tools + tm_webfetch + tm_memory; PTC gets a `ptc-` stepPrefix so its step ids can't collide); `src/fs-safe.ts` rmForceSafe -- win32 fs.rmSync silently no-ops on non-ASCII paths (Node 24.12 observed), all destructive call sites (blackboard/store sweeps, memory forget) route through the existence-checked fallback |
| `src/tm/ptc.ts` | `tm_ptc_run` M1-M3 (shipped in the published dist since v1.5.2) -- args schema (program/label/tighten-only budgets clamped to `TM_PTC_*`), three engines behind the frozen `PtcEngine` seam: `WorkerEngine` (primary, `worker_threads` + MessagePort RPC + `env:{}` + `terminate()`, bootstrap as build-time string), `InlineVmEngine` (fallback, `node:vm` runInNewContext -- script timeout kills PRE-await sync busy-loops; a POST-await busy loop blocks the host event loop irrecoverably, documented -- prefer worker/auto), `InlineSequentialEngine` (M1 legacy, test-only); `TM_PTC_ENGINE=auto|worker|inline` selection with auto-degrade (worker→inline, marks `degraded-engine`); `staticPscan` wired as first gate (banned tokens → reject before engine runs); StepGate error/call/time budgets + ≤1 retry on idempotent phases, composite step ids `sXXXX.kNN`, five-state status, char-pinned aggregation summary, trajectory shapes; `buildPtcRunTool` uses `nextStepId()` for fresh parent step IDs per call; role access: all six agents = `allow` (v1.5.4 revision, overrides the `tm_*` wildcard); governance reused via the pipelines -- PTC is not a bypass layer |
| `src/index.ts` | Plugin entry -- `server()` + `config` hook (injects agents/commands + escalates execution-role bash to the `ask` pattern object, tracks injected exec agents) + `tool.execute.before` hook (R6, wired to the gate's session-scoped `deferToApproval(sessionID)`) + `event` hook (routes `message.updated` user prompts into the gate's session registry -- exec-role agents register, any other agent revokes -- and feeds permission events to the timer) + `chat.message` (secondary registration + symmetric revoke) + `dispose` + `tool` segment (tm_* registration incl. tm_ptc_run M3), id `"team-mode"` |
| `src/types.ts` | Loader-contract type definitions (1.18.x) incl. `PendingPermission` / `PermissionEvent` / `HostEvent` + `Hooks.event`/`Hooks["chat.message"]`/`Hooks.dispose` |
| `test-blackboard.mjs` | Blackboard + prompt contract assertions (incl. bash ask-object slot matrix on a reply-capable client + dead-popup no-R6-face check) |
| `test-default-agent.mjs` | Default-agent promotion + isolation tests (§6 = permission/ask-object deep-equality incl. bare git/publish keys + no-gate dead-popup guard) |
| `test-envprotect.mjs` | R6 pattern/mode/audit assertions (incl. privacy red line, path/cmd-head dumps) + §7 unified approval gate (REAL host asked/replied shapes, session-wide cancel + ghost tombstones, scoped-deferral registry, timeout parse, ask patterns, expressible/inexpressible + byte-exact split, categorize inference, timer reject-only, never-self-allow, SDK {error}-envelope fail-closed, hook session-scoping, dead-popup guard, tm_bash guidance) |
| `test-tm-tools.mjs` | JIT tool assertions (threshold boundary, previews, HMAC/refs, P3, R6 reuse, degradation, trajectory append-only, §6k shared $ shell-bridge fallback, §6m tm_webfetch allowlist/red-lines/offload, §6n tm_memory add/update/search/list/forget + fs-safe non-ASCII rm regression) + §9 PTC (config, budgets, arg schema, staticPscan, five statuses + retry, composite step numbers, trajectory shapes, summary shape pin, tool registration with seven-tool set, §9j REAL engine runs: WorkerEngine RPC/throw/terminate/env-isolation/strict + InlineVmEngine compile-timeout kill) |

## Code conventions
- TypeScript, ES modules -- all relative imports use `.js` suffix
- Agent prompts are template literals; specialists get `REPLY_CONTRACT` + `SHARED_RULES` appended programmatically
- `dist/` is gitignored -- never commit build output
- Prompt edits: preserve the subtraction philosophy (v1.4.7) -- deterministic routing, structured skeleton, count-based gate, hybrid blackboard

## Development rules
- **Do not bump version or publish** unless explicitly asked
- **Unified approval gate (R6 + R2)**: dangerous operations (delete / git push+commit / network fetch / package install+publish / process+system / privilege commands) and wildcard-expressible env reads are gated by the host's OFFICIAL confirmation dialog with a hard timeout -- `TM_ASK_TIMEOUT_MIN` (default 10 min) then auto-REJECT; the plugin NEVER self-allows (only rejects). Deferral to the dialog is per-session (`canDefer(sessionID)`: only sessions registered via exec-role prompts or env-faced asks; stock sessions keep the hard throw) and byte-exact on the defer side. Wildcards-inexpressible shapes and the whole `tm_*` channel keep the code-level hard throw. Host "always" replies generalize far beyond the command (observed `Get-ChildItem env:PATH` -> `Get-ChildItem *`) -- the READMEs tell users to prefer "once". The timeout carries a hard 3-minute floor (`MIN_ASK_TIMEOUT_MIN`): the host's `permission.replied` reaches the plugin ~120 s late on the event bus, so shorter values would auto-reject a just-approved request. Do not weaken either path without an approved spec.
- **R6 privacy red line**: the env-protection audit log (`team-mode-env-protect`) records ONLY tool name + pattern category + approval verdict (`ask` / `allowed-once` / `allowed-always` / `rejected` / `timeout-rejected` / `degraded`) -- never command text, paths, variable names or values; never weaken the interception patterns without an approved spec
- Commit messages: `feat(scope): ...` / `fix(scope): ...` / `docs(scope): ...`
- CHANGELOG.md: Keep a Changelog style; git-only changes go under `[Unreleased]`
- README.md + README.zh-CN.md: keep the bilingual pair in sync when user-facing features, commands, or config change (both ship inside the npm package); if a feature is merged on main but not yet published, mark it as such in the READMEs
- **AGENTS.md**: keep this file in sync when commands, structure, or conventions change
- When adding a new prompt rule, add a matching assertion in `test-blackboard.mjs`
- When changing agent/command injection, update `test-default-agent.mjs`
- When changing env-protection patterns, approval-gate behaviour, or modes, add a matching assertion in `test-envprotect.mjs`

## Prompt design principles (v1.4.7)
1. Deterministic routing table -- no free-form scheduling deliberation
2. Structured reply skeleton (`STATUS/CHANGES/FINDINGS/EVIDENCE/HANDOFF`) -- primary inter-agent channel
3. Count-based approval gate -- >=2 dispatches -> plan + wait for user
4. Hybrid blackboard -- files only for >~50 line deliverables
5. Adaptive review -- 1 reviewer default; 3 dimensions only for high-risk
6. Static verification -- build/typecheck/lint/tests; no improvised browser automation
7. All agents at temperature 0.2
8. Repo hygiene -- scratch/temp files deleted before reporting done (throwaway work goes to the OS temp dir); pinned in test-blackboard.mjs
