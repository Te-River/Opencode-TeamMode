# PT-07 Baseline Task Set (task book §11)

Fixed tasks + fixtures for the A/B comparison **baseline (no `tm_*` tools, current state)** vs **retest (`tm_*` enabled)**. Same tasks, same fixtures, same judge — reproducibility is the hard requirement. This directory is test infrastructure; it contains no runtime behavior and no product code.

## Layout

| File | Role |
|---|---|
| `generate.mjs` | Seeded fixture generator → rebuilds `workspace/` + `groundtruth.json` (same seed ⇒ byte-identical) |
| `tasks.json` | Task manifest: id / category / exact agent prompt / success criteria / judge ref / expected steps |
| `judge.mjs` | Per-task judge; recomputes expectations from the fixture, outputs pass/fail + evidence. Importable or CLI re-judge |
| `runner.mjs` | Executes tasks via `opencode run`, captures events/tokens/tool sequence, writes `results/*.json` |
| `workspace/` | Generated fixture (gitignored): 9-file synthetic codebase, 6.3k log lines, 1.5k-row CSV |
| `groundtruth.json` | Deterministic expected values (committed for review; regenerated identically by `generate.mjs`) |
| `results/` | Run artifacts (gitignored): `baseline.json`, `events/<task>.jsonl`, `logs/<task>.stderr.log` |

## Task set (8 tasks, six categories)

| id | category | judged by | expected steps |
|---|---|---|---|
| `t01-read-codeqa` | read 主导 | reply markers (`PT07_ANSWER_*`) | 5–10 |
| `t02-grep-locate` | grep 主导 | TODO(pt07) `file:line` set equality (5 markers) | 5–10 |
| `t03-bash-logagg` | bash 主导 | `answers/t03.txt` == log count (17) | 5–10 |
| `t04-bash-csvagg` | bash 主导 | `answers/t04.txt` == CSV delivered+west count | 5–12 |
| `t05-write-feature` | write/edit 主导 | `node -e` behavior check of `applyBulkDiscount` (4 cases) | 6–15 |
| `t06-mixed-refactor` | 混合（多文件重构） | rename completeness + behavior preserved (`regionRevenue`) | 6–18 |
| `t07-task-orchestration` | task 编排（两步 + 子任务委派） | `answers/t07.md` region + revenue (tol 0.05); task-tool usage = non-blocking evidence | 8–20 |
| `t08-read-logqa` | read 主导 | peak ERROR hour reply marker (unique max by construction) | 5–9 |

Fixture scale (seed `20260907`): 8 `src/*.js` files + README (5 planted `TODO(pt07)` markers), `logs/app-2026-09-0{1,2,3}.log` (2400+2100+1800 = 6300 lines, ERROR/WARN distribution patterns incl. exactly 17 `ERROR [payment] timeout` on day 01 and a unique peak-ERROR hour on day 02), `data/orders.csv` (1500 rows: `order_id,status,region,total`).

## Reproduce

```bash
# 1. generate fixtures (idempotent, deterministic)
node pt07/generate.mjs

# 2. run baseline (all tasks)
node pt07/runner.mjs

#    ...or a subset / smoke run
node pt07/runner.mjs --only t03 --out results/smoke.json

# 3. re-judge any stored results (no model calls)
node pt07/judge.mjs --results results/baseline.json [--write]
```

### Runner flags

| flag | default | meaning |
|---|---|---|
| `--only <ids>` | all tasks | comma-separated task ids |
| `--out <path>` | `results/baseline.json` | results file |
| `--timeout <s>` | `900` | per-task wall-clock limit (cold start ~35s included) |
| `--model <p/m>` | `zai/glm-4.5-air` | provider/model (deepseek had empty balance; zai/glm-4.5-air verified) |
| `--oc <path>` | isolated CLI in `%TEMP%\opencode\tm-probe\runtime\...` (or `OC_PATH`) | opencode executable (1.18.29) |

### Isolation model (verified)

- Runner sets `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_STATE_HOME` to `pt07/.oc-*` → **global config is not loaded** (no gov-mode/quota tool leakage), **global state is never written**. `auth.json` is copied once from `~/.local/share/opencode/auth.json` into the isolated data dir.
- Tool-face snapshot per task: sidecar `opencode serve --port 471x` (same isolated env, `OPENCODE_SERVER_PASSWORD` auth) → `GET /experimental/tool/ids?directory=<workspace>` → kill. Recorded in `tasks[].toolFace`. Baseline snapshot: `["invalid","question","bash","read","glob","grep","edit","write","task","webfetch","todowrite","websearch","skill","apply_patch"]` — no `tm_*` tools. (`invalid` is opencode's shim entry for unknown/unregistered tools surfaced by the ids endpoint — harmless, not a real tool.)
- For the **retest** (tm_* enabled): add the team-mode plugin to the isolated config (`pt07/.oc-config/opencode/plugins/` or workspace `.opencode/`) and re-run with `--out results/retest.json`. Everything else must stay identical (same seed, same model, same flags).
- R6 env-protection is a team-mode plugin concern; it is *not* active in the baseline's isolated config. If the model probes env vars during any run, that shows up in the tool sequence — the runner records it, it never blocks.

## Results schema (per task)

```
id, category, status(pass|fail|timeout|error), sessionID, durationMs,
llmSteps, toolCalls, toolSequence[{tool,callID,status}],
tokens{ totals{input,output,reasoning,cacheRead,cacheWrite,cost}, perStep[...] },
replyText, toolFace[], judge{pass,evidence[]}, eventsFile
```

Token source: each `step_finish` event from `opencode run --format json` carries
`part.tokens = {input, output, reasoning, cache:{read, write}}` — all four required items (input / output / cache read / cache creation) come from there; `tokens.totals` is their sum. Verified against opencode 1.18.29 (see smoke run in `results/`).

## Determinism guarantees

- `generate.mjs` uses a mulberry32 seeded RNG (seed 20260907), no wall-clock, no `Math.random`; verified byte-identical across consecutive rebuilds (SHA-256 over all fixture files).
- `groundtruth.json` values are recomputed from the generated artifacts by the generator itself, and the judge re-derives expectations from the fixture at judging time — a drifted fixture fails loudly instead of silently passing.
- Prompts contain no double quotes (passed as argv to the CLI); answer formats embed stable markers (`PT07_*`).
