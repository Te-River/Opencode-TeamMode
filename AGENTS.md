# Opencode-TeamMode — Agent Guide

## What this is
OpenCode Desktop plugin that injects a multi-agent team (6 agents, 6 commands) into the user's workspace. Published as `@te-river/opencode-team-mode` on npm.

## Commands
| Action | Command |
|---|---|
| Build | `npm run build` (tsc -> dist/) |
| Test | `npm test` (tsc + test-blackboard.mjs + test-envprotect.mjs + test-tm-tools.mjs) |
| Test (full) | `npm test` then `node test-default-agent.mjs` |
| Dev watch | `npm run dev` |

All test suites must pass before committing.

## Project structure
| File | Role |
|---|---|
| `src/agents.ts` | Agent definitions -- prompts, modes, colors, tool-whitelist permissions, temperature |
| `src/commands.ts` | Slash command templates (`/team-plan`, `/team-run`, etc.) |
| `src/blackboard.ts` | Shared blackboard + TTL auto-cleanup sweeper |
| `src/envprotect.ts` | R6 env protection -- code-level `tool.execute.before` interception (bash/PS env commands incl. pathed `/usr/bin/env` + `cmd /c` heads, `$env:`/`${VAR}`/`$ALLCAPS` expansion, env-file paths) + audit log; ALSO the unified approval-gate Layer 1/3 surface: the `R6_ENV_BASH_ASK` / `R2_DANGER_BASH_ASK` pattern sets, `bashAskPatterns(mode, envFace)` (R6 face omitted while the gate cannot arm -- dead-popup guard), and `isAskGatedEnvCommand()` (BYTE-EXACT glob = dialog guaranteed -> defers, loose/armed categorize keeps hard throw; per-session scope via `deferToApproval(sessionID)`)/`categorizePermission()` (real `permission.asked` shape: tool in `permission`, `patterns[]`/`metadata.command` inference); tm_* tools alias onto this surface (anti-backdoor, never deferred) |
| `src/approval-gate.ts` | Unified approval gate Layer 2 -- one shared timer over the live host's `permission.asked`/`permission.replied` (legacy `permission.updated` spelling accepted): auto-REJECTS an unanswered R6/R2 dialog after `TM_ASK_TIMEOUT_MIN` (default 10 min); `replied` (which may carry ONLY `{sessionID}`) cancels the session's WHOLE pending set + tombstones ids (ghost asked replays never re-arm, no dead-id double-reject); v1 `{error}` envelope unwrapped -> real SDK failures flip degraded; the plugin NEVER self-allows (reject-only reply); env-face asks + exec-role session registration (`registerExecSession`, `canDefer(sid)`) gate deferral per-session; armed only when R6 is on AND the client can reply |
| `src/tm/` | JIT layer-2 tools (tm_read/tm_grep/tm_bash/tm_fetch) -- `config.ts` env knobs + token口径, `refs.ts` run ids + HMAC handles, `store.ts` run store + append-only trajectory + TTL sweep, `preview.ts` 5-branch previews (80-token cap) + structure summaries, `guard.ts` P2 path scope + P3 readonly allowlist (rejections guide to the bash confirmation dialog), `tools.ts` governed pipelines, `index.ts` assembly |
| `src/index.ts` | Plugin entry -- `server()` + `config` hook (injects agents/commands + escalates execution-role bash to the `ask` pattern object, tracks injected exec agents) + `tool.execute.before` hook (R6, wired to the gate's session-scoped `deferToApproval(sessionID)`) + `event` hook (routes `message.updated` exec-role prompts into the gate's session registry -- pre-tool proof the session carries the ask set -- and feeds permission events to the timer) + `chat.message` (secondary registration) + `dispose` + `tool` segment (tm_* registration), id `"team-mode"` |
| `src/types.ts` | Loader-contract type definitions (1.18.x) incl. `PendingPermission` / `PermissionEvent` / `HostEvent` + `Hooks.event`/`Hooks["chat.message"]`/`Hooks.dispose` |
| `test-blackboard.mjs` | Blackboard + prompt contract assertions (incl. bash ask-object slot matrix on a reply-capable client + dead-popup no-R6-face check) |
| `test-default-agent.mjs` | Default-agent promotion + isolation tests (§6 = permission/ask-object deep-equality incl. bare git/publish keys + no-gate dead-popup guard) |
| `test-envprotect.mjs` | R6 pattern/mode/audit assertions (incl. privacy red line, path/cmd-head dumps) + §7 unified approval gate (REAL host asked/replied shapes, session-wide cancel + ghost tombstones, scoped-deferral registry, timeout parse, ask patterns, expressible/inexpressible + byte-exact split, categorize inference, timer reject-only, never-self-allow, SDK {error}-envelope fail-closed, hook session-scoping, dead-popup guard, tm_bash guidance) |
| `test-tm-tools.mjs` | JIT tool assertions (threshold boundary, previews, HMAC/refs, P3, R6 reuse, degradation, trajectory append-only) |

## Code conventions
- TypeScript, ES modules -- all relative imports use `.js` suffix
- Agent prompts are template literals; specialists get `REPLY_CONTRACT` + `SHARED_RULES` appended programmatically
- `dist/` is gitignored -- never commit build output
- Prompt edits: preserve the subtraction philosophy (v1.4.7) -- deterministic routing, structured skeleton, count-based gate, hybrid blackboard

## Development rules
- **Do not bump version or publish** unless explicitly asked
- **Unified approval gate (R6 + R2)**: dangerous operations (delete / git push+commit / network fetch / package install+publish / process+system / privilege commands) and wildcard-expressible env reads are gated by the host's OFFICIAL confirmation dialog with a hard timeout -- `TM_ASK_TIMEOUT_MIN` (default 10 min) then auto-REJECT; the plugin NEVER self-allows (only rejects). Deferral to the dialog is per-session (`canDefer(sessionID)`: only sessions registered via exec-role prompts or env-faced asks; stock sessions keep the hard throw) and byte-exact on the defer side. Wildcards-inexpressible shapes and the whole `tm_*` channel keep the code-level hard throw. Host "always" replies generalize far beyond the command (observed `Get-ChildItem env:PATH` -> `Get-ChildItem *`) -- the READMEs tell users to prefer "once". Do not weaken either path without an approved spec.
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
