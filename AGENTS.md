# Opencode-TeamMode — Agent Guide

## What this is
OpenCode Desktop plugin that injects a multi-agent team (6 agents, 6 commands) into the user's workspace. Published as `@te-river/opencode-team-mode` on npm.

## Commands
| Action | Command |
|---|---|
| Build | `npm run build` (tsc -> dist/) |
| Test | `npm test` (tsc + test-blackboard.mjs) |
| Test (full) | `npm test` then `node test-default-agent.mjs` |
| Dev watch | `npm run dev` |

Both test suites must pass before committing.

## Project structure
| File | Role |
|---|---|
| `src/agents.ts` | Agent definitions -- prompts, modes, colors, permissions, temperature |
| `src/commands.ts` | Slash command templates (`/team-plan`, `/team-run`, etc.) |
| `src/blackboard.ts` | Shared blackboard + TTL auto-cleanup sweeper |
| `src/index.ts` | Plugin entry -- `server()` + `config` hook, id `"team-mode"` |
| `src/types.ts` | Loader-contract type definitions (1.18.x) |
| `test-blackboard.mjs` | Blackboard + prompt contract assertions |
| `test-default-agent.mjs` | Default-agent promotion + isolation tests |

## Code conventions
- TypeScript, ES modules -- all relative imports use `.js` suffix
- Agent prompts are template literals; specialists get `REPLY_CONTRACT` + `SHARED_RULES` appended programmatically
- `dist/` is gitignored -- never commit build output
- Prompt edits: preserve the subtraction philosophy (v1.4.7) -- deterministic routing, structured skeleton, count-based gate, hybrid blackboard

## Development rules
- **Do not bump version or publish** unless explicitly asked
- Commit messages: `feat(scope): ...` / `fix(scope): ...` / `docs(scope): ...`
- CHANGELOG.md: Keep a Changelog style; git-only changes go under `[Unreleased]`
- **AGENTS.md**: keep this file in sync when commands, structure, or conventions change
- When adding a new prompt rule, add a matching assertion in `test-blackboard.mjs`
- When changing agent/command injection, update `test-default-agent.mjs`

## Prompt design principles (v1.4.7)
1. Deterministic routing table -- no free-form scheduling deliberation
2. Structured reply skeleton (`STATUS/CHANGES/FINDINGS/EVIDENCE/HANDOFF`) -- primary inter-agent channel
3. Count-based approval gate -- >=2 dispatches -> plan + wait for user
4. Hybrid blackboard -- files only for >~50 line deliverables
5. Adaptive review -- 1 reviewer default; 3 dimensions only for high-risk
6. Static verification -- build/typecheck/lint/tests; no improvised browser automation
7. All agents at temperature 0.2
