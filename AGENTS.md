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
| `src/agents.ts` | Agent definitions -- prompts, modes, colors, permissions, temperature |
| `src/commands.ts` | Slash command templates (`/team-plan`, `/team-run`, etc.) |
| `src/blackboard.ts` | Shared blackboard + TTL auto-cleanup sweeper |
| `src/envprotect.ts` | R6 env protection -- code-level `tool.execute.before` interception (bash/PS env commands, `$env:`/`${VAR}`/`$ALLCAPS` expansion, env-file paths) + audit log; tm_* tools alias onto this surface (anti-backdoor) |
| `src/tm/` | JIT layer-2 tools (tm_read/tm_grep/tm_bash/tm_fetch) -- `config.ts` env knobs + token口径, `refs.ts` run ids + HMAC handles, `store.ts` run store + append-only trajectory + TTL sweep, `preview.ts` 5-branch previews (80-token cap) + structure summaries, `guard.ts` P2 path scope + P3 readonly allowlist, `tools.ts` governed pipelines, `index.ts` assembly |
| `src/index.ts` | Plugin entry -- `server()` + `config` hook + `tool.execute.before` hook + `tool` segment (tm_* registration), id `"team-mode"` |
| `src/types.ts` | Loader-contract type definitions (1.18.x) |
| `test-blackboard.mjs` | Blackboard + prompt contract assertions |
| `test-default-agent.mjs` | Default-agent promotion + isolation tests |
| `test-envprotect.mjs` | R6 pattern/mode/audit assertions (incl. privacy red line) |
| `test-tm-tools.mjs` | JIT tool assertions (threshold boundary, previews, HMAC/refs, P3, R6 reuse, degradation, trajectory append-only) |

## Code conventions
- TypeScript, ES modules -- all relative imports use `.js` suffix
- Agent prompts are template literals; specialists get `REPLY_CONTRACT` + `SHARED_RULES` appended programmatically
- `dist/` is gitignored -- never commit build output
- Prompt edits: preserve the subtraction philosophy (v1.4.7) -- deterministic routing, structured skeleton, count-based gate, hybrid blackboard

## Development rules
- **Do not bump version or publish** unless explicitly asked
- **R6 privacy red line**: the env-protection audit log (`team-mode-env-protect`) records ONLY tool name + pattern category -- never command text, paths, variable names or values; never weaken the interception patterns without an approved spec
- Commit messages: `feat(scope): ...` / `fix(scope): ...` / `docs(scope): ...`
- CHANGELOG.md: Keep a Changelog style; git-only changes go under `[Unreleased]`
- README.md + README.zh-CN.md: keep the bilingual pair in sync when user-facing features, commands, or config change (both ship inside the npm package); if a feature is merged on main but not yet published, mark it as such in the READMEs
- **AGENTS.md**: keep this file in sync when commands, structure, or conventions change
- When adding a new prompt rule, add a matching assertion in `test-blackboard.mjs`
- When changing agent/command injection, update `test-default-agent.mjs`
- When changing env-protection patterns or modes, add a matching assertion in `test-envprotect.mjs`

## Prompt design principles (v1.4.7)
1. Deterministic routing table -- no free-form scheduling deliberation
2. Structured reply skeleton (`STATUS/CHANGES/FINDINGS/EVIDENCE/HANDOFF`) -- primary inter-agent channel
3. Count-based approval gate -- >=2 dispatches -> plan + wait for user
4. Hybrid blackboard -- files only for >~50 line deliverables
5. Adaptive review -- 1 reviewer default; 3 dimensions only for high-risk
6. Static verification -- build/typecheck/lint/tests; no improvised browser automation
7. All agents at temperature 0.2
