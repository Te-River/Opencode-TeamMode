# PT-07 Baseline Task Set (task book §11)

Fixed tasks + fixtures for the A/B comparison **baseline (no `tm_*` tools, current state)** vs **retest (`tm_*` enabled)**. Same tasks, same fixtures, same judge — reproducibility is the hard requirement. This directory is test infrastructure; it contains no runtime behavior and no product code.

## Layout

| File | Role |
|---|---|
| `generate.mjs` | Seeded fixture generator → rebuilds `workspace/` + `groundtruth.json` (same seed ⇒ byte-identical) |
| `tasks.json` | Task manifest: id / category / exact agent prompt / success criteria / judge ref / expected steps |
| `judge.mjs` | Per-task judge; recomputes expectations from the fixture, outputs pass/fail + evidence. Importable or CLI re-judge. Resolves each task's judge spec, gates re-judges on the fixture fingerprint, and exits non-zero when the harness itself is broken |
| `runner.mjs` | Executes tasks via `opencode run`, captures events/tokens/tool sequence, writes `results/*.json`. Resets the fixture before running, records a workspace fingerprint per task, and refuses to spend tokens when a measurement item cannot be captured |
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
# 1. generate fixtures (idempotent, deterministic) - the runner does this for you
node pt07/generate.mjs

# 2. run baseline (all tasks). The runner RESETS the fixture first; it will not
#    start from a workspace that still holds a previous run's answers or edits.
node pt07/runner.mjs --out results/baseline-$(Get-Date -Format yyyyMMdd-HHmmss)

#    ...or a subset / smoke run
node pt07/runner.mjs --only t03 --out results/smoke.json

#    ...flags and exit codes without touching anything
node pt07/runner.mjs --help

# 3. re-judge any stored results (no model calls)
node pt07/judge.mjs --results results/baseline.json
```

`--out` refuses to overwrite an existing results file unless `--force`: a stored
result set is evidence, and re-running over it is a decision, not a default.

### Runner flags

| flag | default | meaning |
|---|---|---|
| `--only <ids>` | all tasks | comma-separated task ids |
| `--out <p>` | `results/baseline.json` | results file; refuses an existing file without `--force` |
| `--timeout <s>` | `900` | per-task wall-clock limit (cold start ~35s included) |
| `--model <p/m>` | **`tasks.json` → `meta.defaultModel`** | provider/model. The runner has no built-in default: the value comes from the manifest, and the runner prints which source it used (`modelSource`). The stored `results/baseline.json` was run with `--model zai/glm-5.3-flash`, which is **not** the manifest default (`zai/glm-4.5-air`) — a retest must pass `--model zai/glm-5.3-flash` explicitly or the "same model" premise of the A/B is false |
| `--oc <path>` | isolated CLI in `%TEMP%\opencode\tm-probe\runtime\...` (or `OC_PATH`) | opencode executable. That 1.18.29 isolated CLI does not exist on hosts running the 2.x desktop app; there the CLI is `%LOCALAPPDATA%\Programs\@opencode-aidesktop\resources\opencode-cli.exe` |
| `--toolface-endpoint <p>` | `/experimental/tool/ids` | tool-face HTTP path (1.18.x only, see below) |
| `--toolface-deadline <s>` | `90` | how long to wait for the sidecar to answer |
| `--no-reset` | reset | do not rebuild the fixture; refused when residue of a previous run is detected |
| `--allow-dirty-fixture` | off | with `--no-reset`: accept an already-solved workspace |
| `--no-toolface` | off | skip the sidecar entirely (recorded as `toolFaceStatus: "skipped"`) |
| `--allow-no-toolface` | off | attempt the sidecar, continue when it fails (recorded per task as `toolFaceUnavailable`) |
| `--force` | off | allow `--out` to overwrite an existing file |
| `--help` | — | usage + exit codes; spawns nothing, touches nothing |

Unknown flags, a flag without its value, and stray positionals are refused with
exit 2 — they used to fall through and start all eight paid tasks.

Exit codes: `0` finished · `2` bad flags / fixture or CLI missing / judge harness
error · `4` tool-face could not be captured and was not waived.

### Isolation model (verified)

- Runner sets `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_STATE_HOME` to `pt07/.oc-*` → **global config is not loaded** (no gov-mode/quota tool leakage), **global state is never written**. `auth.json` is copied from `~/.local/share/opencode/auth.json` into the isolated data dir and **refreshed whenever the source's size or mtime moved on** — an `existsSync` short-circuit left the copy at 660 B / 2026-09-05 while the source was 1099 B / 2026-09-24, i.e. the runner was authenticating with a stale credential. Only `stat` metadata is compared; the file's contents are never read, printed or hashed by the runner. The decision and both metadata pairs land in `meta.isolation.authSync`.
- Tool-face snapshot per task: sidecar `opencode serve --port 471x` (same isolated env, `OPENCODE_SERVER_PASSWORD` auth) → `GET /experimental/tool/ids?directory=<workspace>` → kill. Recorded in `tasks[].toolFace`.
  **The endpoint and the snapshot below are valid on opencode 1.18.29 only.**

  Baseline snapshot (1.18.29): `["invalid","question","bash","read","glob","grep","edit","write","task","webfetch","todowrite","websearch","skill","apply_patch"]` — no `tm_*` tools. (`invalid` is opencode's shim entry for unknown/unregistered tools surfaced by the ids endpoint — harmless, not a real tool. On 2.x `bash`/`todowrite`/`apply_patch` are renamed or gone, so this list must not be reused as a 2.x expectation.)

  **Measured on the 2.0.20 desktop CLI:** the route is gone from the binary (197.3 MB scan: 0 hits for `/experimental/tool/ids`, 111 for `/api/session`), and the sidecar still answers that path with **HTTP 200 + the SPA's `index.html`** (a catch-all route). Status alone is therefore not evidence: the runner validates the payload *shape* (a list of tool names) and records `toolFaceStatus` + `toolFaceUnavailable{reason,endpoint,httpStatus,ocVersion}`. No verified 2.x replacement exists yet, so an unwaived failure **aborts the run before the first model call** (exit 4) rather than storing a silent `null` in the core measurement column. Once a 2.x route is verified, pass `--toolface-endpoint <path>`; to accept the gap knowingly, `--allow-no-toolface` (per-task `toolFaceUnavailable`) or `--no-toolface` (status `skipped`).
- For the **retest** (tm_* enabled): add the team-mode plugin to the isolated config (`pt07/.oc-config/opencode/plugins/` or workspace `.opencode/`) and re-run with `--out results/retest.json`. Everything else must stay identical (same seed, same model, same flags).
- R6 env-protection is a team-mode plugin concern; it is *not* active in the baseline's isolated config. If the model probes env vars during any run, that shows up in the tool sequence — the runner records it, it never blocks.

## Results schema (per task)

```
id, category, title, prompt,
judgeSpec{ref,checkId,groundtruthKey?},        <- the spec; judge.mjs reads THIS
expectedSteps,
status(pass|fail|timeout|error), sessionID, exitCode, timedOut, spawnError,
durationMs, llmSteps, toolCalls, toolSequence[{tool,callID,status,title}],
tokens{ totals{input,output,reasoning,cacheRead,cacheWrite,cost}, perStep[...] },
replyText,
toolFace[]|null, toolFaceStatus(ok|unavailable|skipped),
toolFaceUnavailable{reason,endpoint,httpStatus,ocVersion}|null,
fixtureSha256AtStart, fixtureSha256,           <- workspace state this task left
judge{pass,evidence[]},                         <- the verdict, NOT a spec
eventsFile
```

`judgeSpec` and `judge` are different objects: the spec says *how* to judge, the
verdict says *what came out*. Re-judging must read `judgeSpec`; reading
`judge.checkId` yields `undefined` for every task, which is how a stored 8/8 pass
once re-judged as 0/8 with exit 0.

Token source: each `step_finish` event from `opencode run --format json` carries
`part.tokens = {input, output, reasoning, cache:{read, write}}` — all four required items (input / output / cache read / cache creation) come from there; `tokens.totals` is their sum. Verified against opencode 1.18.29 (see smoke run in `results/`).

## Re-judging a stored result (and what it may honestly claim)

```bash
node pt07/judge.mjs --results results/baseline.json                 # gated
node pt07/judge.mjs --results results/baseline.json --task t01-read-codeqa
node pt07/judge.mjs --results results/baseline.json --allow-fixture-drift
node pt07/judge.mjs --results results/baseline.json --write         # .bak first; may be refused
```

Six of the eight checks read the workspace as the run **left** it (`answers/*.txt`,
`src/pricing.js` after t05, `src/**` after the t06 rename). So a re-judge has a
premise: **the fixture must still be the one the run ended on.** `generate.mjs`
rebuilds it and wipes those artifacts, and re-judging after that produced five
false FAILs (`answers/t03.txt missing`, `old-name occurrences under src/: 3`).
The runner therefore records a per-task workspace fingerprint
(`fixtureSha256`) plus `meta.groundtruthSha256`, and the judge compares them
before it pronounces anything:

| verdict | meaning | exit |
|---|---|---|
| `PASS` / `FAIL` | the check ran against a workspace that still matches the run | 0 / 1 |
| `STALE` | the fingerprint (or groundtruth) no longer matches — the check did **not** run, no verdict is claimed | 3 |
| `HARNESS ERROR` | no resolvable judge spec, unknown `checkId`, unreadable results/fixture, bad flag | 2 |

`--allow-fixture-drift` judges anyway and labels every such verdict
`FAIL (非复现 · 前提不成立，仅供参考)`. `--write` is refused while any task is
STALE or has no spec — a re-judge that cannot see the run's workspace must not
overwrite the verdicts that *were* taken against it — and it writes `<file>.bak`
plus a `meta.lastRejudge{fixtureSha256,groundtruthSha256}` stamp before touching
the file. Results produced by the older runner carry no fingerprint, so their
fixture-dependent checks are STALE by construction; re-run them to get a
re-judgeable record.

## Determinism guarantees

- `generate.mjs` uses a mulberry32 seeded RNG (seed 20260907), no wall-clock, no `Math.random`; verified byte-identical across consecutive rebuilds.
- The fixture aggregate is `judge.mjs`'s `fixtureFingerprint()`: every file under `workspace/` (sorted by workspace-relative path, `node_modules`/`.git` excluded) contributing `<relpath>\0<sha256>\n`, hashed once more. A clean seed-20260907 fixture is **14 files / 484 345 B / `fb88cde699d44e7d…`**, identical across consecutive `node pt07/generate.mjs` runs. Empty `answers/` contributes nothing, so any agent-written artifact or edited source file moves it — which is exactly what the re-judge gate needs to see.
- `groundtruth.json` values are recomputed from the generated artifacts by the generator itself, and the judge re-derives expectations from the fixture at judging time — a drifted fixture fails loudly instead of silently passing.
- Prompts contain no double quotes (passed as argv to the CLI); answer formats embed stable markers (`PT07_*`).
