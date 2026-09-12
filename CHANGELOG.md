# Changelog

All notable changes to `@te-river/opencode-team-mode` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning is semver (the 1.4.x train shipped under working labels; the
registry saw 1.5.0 as the install-script fix release).

## [Unreleased]

### Added
- **Unified approval gate (R6 env face + R2 danger face → the official
  OpenCode confirmation dialog)**: instead of the model's env-var reads and
  dangerous operations being silently hard-thrown in isolation, they now
  route through the host's native permission popup with a hard timeout.
  Three layers, contract pinned against the REAL host (1.18.29, live E2E via
  `opencode serve` + SSE event capture):
  - **Layer 1 (host-native dialog)** — the four execution roles' bash
    permission is escalated from a bare `allow` to a pattern object whose
    default stays `allow` (`"*": "allow"`; the T2.1 grant is preserved).
    The R6 env-command shapes a wildcard can express (`printenv*`, `env*`,
    `set`, `export -p`/`declare -p`/`typeset -p`, the PowerShell `env:`
    drive, `$env:`) and the R2 danger shapes (delete / `git push`/`commit` —
    bare no-arg shapes included / `curl`/`wget`/`Invoke-*Request` /
    `npm install`/`publish`/`pip install`/`winget`/`choco` /
    `taskkill`/`Stop-Process`/`kill`/`shutdown`/`format` /
    `chmod`/`takeown`/`icacls`) are declared `ask`.  The host evaluates
    compound commands per `;`/`&&`-style segment and approves the whole line
    through ONE dialog.  Shapes the grammar cannot express (embedded
    `${VAR}`/`$ALLCAPS`, `$(printenv)`, subshell/escaped/`time` heads,
    `VAR=… env`, split `declare -xp`, env-file paths, pathed dump heads
    like `/usr/bin/env`, and `cmd /c …` launcher heads) KEEP the code-level
    hard throw, as does the whole `tm_*` governed channel.
  - **Layer 2 (`src/approval-gate.ts`, one shared timer)** — watches the
    live host's `permission.asked` events (props carry NO `type` field;
    the tool name rides in `permission`, command segments in `patterns[]`,
    `metadata.command`, and the host's `always[]` generalization proposal —
    the legacy `permission.updated` spelling is also accepted); an
    unanswered governed request is auto-**rejected** via the SDK after
    `TM_ASK_TIMEOUT_MIN` (default 10).  The plugin NEVER self-allows — it
    only ever rejects.  `permission.replied` (which some builds deliver with
    ONLY `{ sessionID }`) cancels the WHOLE pending set of that session —
    an already-approved command can never get a second reject on a dead id.
    Not armed when `TM_ENV_PROTECT=off` or when the client has no
    permission-reply path — and while the gate cannot arm, the config hook
    omits the R6 env ask face entirely (no dead popups).
  - **Session-scoped deferral** — env reads are only passed through to the
    dialog in sessions REGISTERED as carrying the injected ask set: an
    exec-role user prompt (`message.updated` / `chat.message`) or an
    R6-env-classified `asked` event registers the session.  Stock
    build/plan sessions never register and keep the hard throw — closing
    the global-bypass hole the earlier `isArmed()` deferral had.  The
    deferral match is BYTE-EXACT against the injected config globs (no
    case/trim leniency), so a deferred command is guaranteed to pop the
    dialog under any host grammar at least as greedy as ours.
  - **Layer 3 (fallback)** — a failed auto-reject marks the gate degraded,
    so the R6 hook stops deferring and hard-throws env reads again; the
    event is audited `degraded`.  SDK failure detection covers the v1
    `throwOnError:false` `{ error }` envelope (a dead-id 4xx now really
    flips the gate), not just transport rejections.  Probe finding: the v1
    `input.client` exposes `postSessionIdPermissionsPermissionId` (reply)
    but has **no `permission.list` and no create-permission endpoint**
    (those are v2-only), so `tm_bash` rejections stay a hard block +
    guidance text pointing at the bash dialog rather than being upgraded to
    a popup.
  - Config: `TM_ASK_TIMEOUT_MIN` (minutes, default 10).  Audit stays
    privacy-safe (tool + coarse category + verdict only — never
    command/path/var text; out-of-vocabulary reply words are audited
    `degraded`, never silently `rejected`; a reply that carries no verdict
    cancels without inventing one).  ⚠️ Host caveat: choosing **"always"**
    in a dialog records a much BROADER generalization than the command
    (observed: approving `Get-ChildItem env:PATH` with "always" records
    `Get-ChildItem *` — every later `Get-ChildItem` run passes with no
    dialog).  Prefer **"once"**.  Tests: `test-envprotect.mjs` §7
    (real-host event shapes included), `test-default-agent.mjs` §6,
    `test-blackboard.mjs`.  The permission protocol was verified live on a
    1.18.29 `opencode serve` host via SSE capture; Desktop dialog rendering
    remains the one leg to eyeball in a real Desktop session.
- **`tm_ptc_run` M1 contract + aggregation skeleton (git-only, not yet
  published; NOT exposed to any agent until the M3 whitelist wiring)**: the
  foundation for program-mode batch orchestration — a model writes one async
  program that makes N governed `tm_*` calls in a single turn (no LLM round-
  trips during the run; only an aggregation summary returns to context).  This
  milestone lands the frozen contract only:
  - args schema — `program` (≤ `TM_PTC_MAX_PROGRAM_CHARS`, default 4000),
    `label` (≤ 80), and tighten-only `budgets` (`max_calls` / `max_errors` /
    `timeout_ms`) clamped against the `TM_PTC_*` ceilings (`TM_PTC_MAX_CALLS`
    20·1–200, `TM_PTC_MAX_ERRORS` 3·1–50, `TM_PTC_TIMEOUT_MS` 60000·5s–10min);
  - the `PtcEngine` seam + RPC message surface frozen for M2's worker engine,
    with `InlineSequentialEngine` (the direct bridge over the now-exported
    `buildPipelines`, `ctx` passed through untouched) as M1's only engine;
  - StepGate failure governance: error / call / time budgets stop the whole run
    without losing produced output, ≤1 retry on idempotent phases
    (client/execute/store) only, full error text persisted to composite step
    dirs `steps/sXXXX.kNN/`, structured `line` passthrough (T1.4 shape);
  - the five-state status enum (`ok | stopped-error-budget |
    stopped-call-budget | timeout | engine-error`) and the char-pinned
    aggregation summary (design §2 headers verbatim);
  - trajectory shapes (parent `call`/`finish` + child `call`/`result`/`error`
    with the `ptc` parent tag and composite step ids that pass the existing
    `REF_PATTERN` / `STEP_FILE`).
  Governance is reused, never forked: every bridged call runs the full `tm_*`
  pipeline (P2/P3/R6/threshold-offload/TTL), so PTC is not a bypass layer.  The
  program-source static pre-scan is written but deliberately NOT enabled (M2's
  sandbox needs it).  Design:
  `.git/opencode-team/20260907-192627/ptc-run/02-architect-ptc-run-design.md`.
  Tests: `test-tm-tools.mjs` §9.  P1 probe (`node:worker_threads` in the host):
  proven fully-available under Node 24; the live 1.18.x host leg (Bun 1.3.14)
  could not be measured in an offline sandbox — M2 keeps `TM_PTC_ENGINE=auto`
  (worker→inline degrade) and must re-probe on a networked / Desktop host.
- **`tm_ptc_run` M2 engine (git-only, not yet published)**: the sandbox
  layer that actually runs PTC programs.  Three engines behind the same
  `PtcEngine` seam (`PtcEngine.run(program, bridge, signal)`):
  - **WorkerEngine** (primary): runs the program in a dedicated
    `worker_threads.Worker` with `env:{}` (process.env emptied),
    `resourceLimits`, and `terminate()` for hard wall-clock timeout kills.
    Bootstrap source is a build-time string constant (zero runtime file IO,
    zero new deps, passes tsc).  MessagePort RPC carries the M1-frozen
    `PtcRpcRequest/Response/Abort` surface; the driver-side StepGate and
    gate-wrapped bridge are unchanged.  Probe (P1, %TEMP%): ALL-GREEN on
    Node 24/win32 — eval bootstrap, postMessage bidirectional, terminate
    (9 ms), resourceLimits, env:{} all verified.
  - **InlineVmEngine** (fallback): runs the program inside `node:vm` via
    `vm.compileFunction` with a 30-second compile timeout that kills
    synchronous busy-loops.  Await-gap residual (design §3) is documented
    and accepted for the fallback; the primary worker engine does not share
    this limitation (`worker.terminate()` is wall-clock).
  - **InlineSequentialEngine** (M1 legacy, test-only): kept for backward
    compatibility with M1 tests that pass an explicit engine override.
  - `TM_PTC_ENGINE=auto|worker|inline`: auto tries WorkerEngine first; on
    any engine-error (construction or runtime) → degrades to InlineVmEngine
    and marks `degraded-engine` in the summary; `worker` forces the worker
    (engine-error on failure); `inline` forces the vm engine.
  - **Static pre-scan** (`staticPscan`) is now wired as the FIRST gate
    in both `runPtc` and `buildPtcRunTool.execute` — programs containing
    `require|import|process|globalThis|Deno|Bun|fs|net|child_process` are
    rejected before any engine runs (status=engine-error, phase=args, no
    budget burned).  Auxiliary guard, not a security boundary (design §3).
  - `buildPtcRunTool` now accepts `nextStepId: () => string` (generates a
    fresh parent step ID per call) instead of the fixed `parentStepId`
    string — multiple PTC calls no longer collide on the same step dir.
- **`tm_ptc_run` M3 role access (git-only, not yet published)**: the tool
  is now registered in the `tool` segment (five-tool set: tm_read, tm_grep,
  tm_bash, tm_fetch, tm_ptc_run).  Whitelist matrix per design §3/§10:
  - **implementer / tester / architect / reviewer / researcher**: `allow`
    (explicit key overrides the `tm_*` wildcard).
  - **team**: `deny` (the lead orchestrates, it does not run batch programs
    itself; the explicit `deny` overrides the `tm_*` wildcard).
  - Tests: `test-default-agent.mjs` §6 (explicit > wildcard priority),
    `test-tm-tools.mjs` §9i (registered in tool segment, five-tool set).
  - `createTmTools` builds `tm_ptc_run` alongside the four governed tools
    using a separate `buildPipelines` instance (governance reused verbatim;
    store handles any step-id overlap via tool-name-prefixed files).

### Changed
- **Agent tool whitelists (Phase 2 / T2.1, G2 ruling "方案甲")**: all six
  agents now carry an explicit tool whitelist in their permission block,
  using the T0.4③-verified probe shape (a "deny" permission removes the
  built-in from the model's tool surface entirely — zero bypass, zero
  hallucinated calls).  Every whitelist = the four governed `tm_*` tools
  plus per-agent grants: team `task`+`write`; architect / reviewer `task`;
  implementer / tester `edit`+`write`; researcher tm_* only (4 tools — an
  intentional cut below the 5-7 band: pure local research).  glob/list are
  excluded per G2 (file enumeration goes through `tm_bash`); webfetch /
  websearch are excluded network-wide (P5), which also removes
  researcher's dangling `websearch: allow` (T0.3).  The R6 env-protection
  hook aliases onto `tm_*` unchanged, so the anti-backdoor chain is not
  weakened.  Assertions in `test-default-agent.mjs` (§6) and
  `test-blackboard.mjs`.

## [1.5.1] - 2026-09-08

### Changed
- The npm package now also ships `README.zh-CN.md` (the `files` field had
  omitted it; the bilingual README pair is repo convention).

### Added
- **JIT layer-2 tools (T1.2 + T1.3 + T1.4)**: the plugin now statically
  registers four governed tools next to the built-ins (verified loader shape:
  `server()` hooks gain a `tool` segment; agents whitelist untouched — Phase 2):
  - `tm_read` / `tm_grep` / `tm_bash` — governed passthroughs of the built-in
    read / ripgrep-index / bash capabilities with threshold offload: results
    up to `TM_OFFLOAD_THRESHOLD` tokens (default 2000, chars/4 estimate; the
    estimate == threshold boundary ALSO offloads) return inline, larger
    payloads are written to a run store and answered with a handle
    `{offloaded, ref, access_token, expire_at, tokens, preview}` whose
    content-aware preview (JSON keys / CSV header+rows / log stats with
    ERROR×N counts and path:line clues / code signature list / binary
    not-previewable) is hard-capped at `TM_PREVIEW_MAX_TOKENS` (default 80
    tokens) and always embeds retrieval clues plus a fetch-first hint;
  - `tm_fetch` — paged retrieval of offloaded payloads (`ref` +
    `access_token` + `offset`/`limit` capped at `TM_FETCH_MAX_LINES` (default
    2000), or `mode:"structure"` for a ~100-token TOC / key-tree /
    error-line map).  Handles are run-scoped: `access_token` =
    HMAC-SHA256(process-start random key, run_id), `expire_at` aligned with
    `TM_BLACKBOARD_TTL` (default 7 days); foreign-run, tampered or expired
    handles are rejected with "payload cleared or run mismatch — rerun the
    original tool";
  - R1 permission pipeline: P2 path scope for reads (project root + run
    store + trajectory dirs, `..`-escape proof) and a P3 command-level
    read-only allowlist for `tm_bash` (ls/cat/head/tail/grep/rg/find/awk/
    sort/uniq/wc/cut/dir/Get-Content/Get-ChildItem/Select-String/
    Measure-Object, extendable via `TM_BASH_READONLY_ALLOWED`) with
    write/hang-escape hardening (output redirection, `find -delete/-exec`,
    `tail -f`, `awk system()`, `rg --pre` all rejected);
  - **R6 anti-backdoor reuse (HUMAN-approved design)**: tm_read / tm_grep /
    tm_bash run the SAME envprotect matchers inside their own pipelines
    (env-file paths, env dumps), and the R6 `tool.execute.before` hook now
    aliases `tm_*` onto `read`/`grep`/`bash` — two layers, one source; R6
    mode `off` disables both.  The built-in bash interception is unchanged;
  - structured errors (`{error: {tool, phase, message, line?}}`) with
    best-effort line extraction and ANSI/empty-line noise stripping, plus a
    degradation rule: an offload (store) failure returns truncated content
    with a warning instead of failing the task;
  - run store `TM_BLACKBOARD_DIR` (default `.blackboard/`):
    `runs/{run_id}/steps/{step_id}/{seq:03d}-{tool}.md` + `index.jsonl`
    appends; trajectory `TM_TRAJECTORY_DIR` (default `.trajectory/`):
    `runs/{run_id}/steps.jsonl` strictly append-only (`usage.jsonl` path
    reserved for T2.2); startup-only TTL sweep reclaims run dirs past
    `TM_BLACKBOARD_TTL`.  Assertions in the new `test-tm-tools.mjs` (now
    part of `npm test`).
- **R6 environment-variable read protection (privacy red line)**: Team mode
  now installs a code-level `tool.execute.before` hook that intercepts the
  model's env-var read paths regardless of prompt compliance (blocking
  verified live on opencode 1.18.29):
  - bash/PowerShell env commands: standalone `env`, `printenv`, bare `set`
    (sh context only — PowerShell `Set-*` cmdlets never matched),
    `declare -p`, and `env:` drive access (`Get-ChildItem`/`gci`/`dir`/
    `Get-Item`/`gi`/`Get-Content`/`gc`/`cat`/`type`);
  - `$env:` expansion (PowerShell), plus — in strict mode — `${VAR}` and
    `$ALLCAPS_VAR` expansion;
  - env-file paths (`.env`, `.env.*`, `*.env`, `.bashrc`, `.bash_profile`,
    `.profile`, `.zshrc`, `.zprofile`, `.zshenv`) across path-class args of
    read/grep/glob/list (`filePath`/`path`/`pattern`/`include`), and env
    file references inside bash commands.
  Blocked calls fail with a fixed structured message pointing the model at
  HUMAN, tagged with the pattern category (`bash-env-command`,
  `bash-env-expansion`, `env-file-path`, `extra-deny`). Every interception
  is audit-logged via `client.app.log()` (level `warn`, service
  `team-mode-env-protect`) recording ONLY the tool name and category —
  never command text, paths, or values, so the audit trail cannot become a
  secret aggregation point.
  Configuration: `TM_ENV_PROTECT` = `strict` (default; unknown values fail
  closed) / `standard` (explicit env commands + env files, no `$VAR`
  expansion blocking) / `off` (hook installed, everything passes); user
  extra deny-regexes via `TM_ENV_PROTECT_EXTRA_DENY` (semicolon-separated,
  effective in every non-off mode). Assertions in the new
  `test-envprotect.mjs` (now part of `npm test`).

### Fixed
- **Installer scripts hardened** (`scripts/install.sh` /
  `scripts/install.ps1`; shared embedded-Node core is now string- and
  comment-aware): the old bracket-counting + naive `needsComma` splice could
  corrupt configs in two reachable cases — an empty plugin array
  (`"plugin": []` gained a leading comma → invalid JSON) and a trailing
  `//` comment inside the array (the comma landed after the comment →
  missing separator). Nested tuple entries, trailing commas and block
  comments now scan correctly; re-runs are idempotent; a config without a
  plugin array fails clean (exit 1, file untouched). The scripts also fall
  back to `opencode.json` when only that file exists (previously they would
  create a stray `opencode.jsonc` next to it). Verified by a sandbox
  harness: 8/8 fixture cases, sh/ps cores byte-identical.

## [1.5.0]

- Install-script fix release: embedded Node.js config patching, plugin
  appended at array end (no functional plugin changes).

## [1.4.9] — 2026-09-06

### Fixed
- **Install scripts pin actual version**: `install.sh` and `install.ps1` now
  resolve the real latest version from the npm registry (`npm view`) and
  write `@te-river/opencode-team-mode@1.4.9` into `opencode.json(c)` instead
  of `@latest` — users can now see their installed version in the OpenCode
  Desktop plugin page.

## [1.4.8] — 2026-09-06

### Added
- **Project AGENTS.md**: the repo now ships its own AGENTS.md covering
  structure, commands, code conventions, prompt design principles, and
  development rules — so future agent sessions on this project get
  project-specific guidance out of the box.
- **Docs sync (CHANGELOG + AGENTS.md)**: delivered changes append a
  CHANGELOG.md entry when the file exists, and update AGENTS.md in place
  when a change alters what it records (build/test commands, conventions,
  project structure, agent instructions); either file is offered for
  creation when missing, and both are skipped when the user opted out.

### Changed
- **Approval gate threshold lowered from ≥3 to ≥2 planned sub-agent
  dispatches**: a two-dispatch pipeline now also presents a plan and waits
  for approval; only single-dispatch / direct-edit work runs without the
  gate. Anti-splitting (<2-dispatch sub-tasks) and mid-run upgrade (2nd
  dispatch) rules renumbered to match.
- **README/AGENTS.md reading deduplicated against the host**: opencode
  injects AGENTS.md/CLAUDE.md into context, so the lead reads the README
  itself (the host does not inject it) but uses the already-injected
  AGENTS.md/CLAUDE.md copy, opening the file only when genuinely absent;
  specialists never re-open these docs — conventions arrive distilled in
  their dispatches.

## [1.4.7] — 2026-09-04

The "subtraction" release: deterministic routing replaces free-form
scheduling deliberation, a structured reply skeleton replaces the mandatory
file blackboard, a count-based approval gate puts the user back in the loop,
verification returns to static checks, and review depth adapts to risk.
Tuned from a production run log that showed 80% of the effort going to
management and synchronization instead of problem-solving.

### Added — Team Lead
- **Deterministic routing table**: the lead picks a fixed pipeline row by
  task shape (question / docs-only / product change / multi-module feature /
  unknown external tech). Pipelines have FIXED minimums — a product change
  routed below 3 dispatches is a routing bug; splitting one request into
  sub-3-dispatch pieces to dodge the gate is a protocol violation.
- **Approval gate (count-based)**: ≥3 planned dispatches → research, present
  a ≤30-line plan, END TURN, and wait for user approval before executing
  anything. 0-2 dispatches run with a 1-2 line notice. Mid-run growth to a
  third dispatch pauses for approval. Pre-authorized sessions skip the gate.
- **Uncertainty policy**: blocking questions are batched into ONE message
  and asked immediately (never drip-fed, never guessed); non-blocking ones
  become plan assumptions.
- **No-ceremony fast path**: a root cause the lead has already verified
  (file:line evidence) goes straight to the implementer as a fix spec —
  no investigation dispatches to re-derive known answers.
- **Brevity discipline**: route selection is a table lookup; user-visible
  planning text stays ≤5 lines.
- **Reply-skeleton enforcement**: specialist replies must start with
  `STATUS: / CHANGES: / FINDINGS: / EVIDENCE: / HANDOFF:`; a missing
  skeleton is a PROTOCOL_VIOLATION → one re-dispatch with the skeleton
  inline → then downgrade and report.
- **Anti-drift tightening**: direct lead edits are now limited to
  non-product text (≤10 lines); product behavior changes are always
  dispatched.

### Changed
- **Blackboard demoted to hybrid**: the reply skeleton is the primary
  transport (≤50 lines inline, zero file I/O); board files exist only for
  oversized deliverables; `MANIFEST.md` is gone (the lead's todo list is its
  state memory); the `Reads:`/`Write to:` per-dispatch manifest requirement
  is dropped. The TTL sweeper (unchanged code) remains the sole cleanup path.
- **Adaptive review replaces fixed Ultra Review**: default is ONE reviewer
  dispatch (correctness); three parallel dimensions (completeness /
  correctness / impact) only for high-risk profiles — auth/security surface,
  cross-module data contracts, public APIs across ≥3 files.
- **Tester verifies statically**: build + typecheck + static analysis +
  API/unit tests. The UI verification mode is removed; improvised browser
  automation (headless screenshots, DOM stubs) is explicitly banned;
  user-visible frontend changes end with `UI NOT VERIFIED: <what needs
  manual checking>` unless the project already ships real browser-test
  tooling.
- **Anti-transcription rule (kept, relocated)**: specialists never hand full
  deliverables back for the lead to transcribe; the `BLACKBOARD WRITE
  FAILED` fallback is now owned by the lead.
- All six agents run at `temperature: 0.2` for format discipline.
- `/team-run` template mirrors the new workflow (routing, approval gate,
  skeleton relay, adaptive review, static verification, changelog step).
- `test-blackboard.mjs` prompt assertions updated to pin the v1.4.7
  contract (TTL sweeper tests unchanged).

## [1.4.6] — 2026-09-03

Orchestration upgrade: hard pipeline gates, three-dimensional parallel
review, evidence standards, and blackboard contract discipline — tuned to
keep the lead coordinating instead of drifting into hand execution.

### Added — Team Lead
- **Pipeline gates (hard ordering)**: research gates planning; design gates
  code; code gates verify; verify gates review; UI verification gates done
  on user-visible frontend changes; all gates the final report; batch
  independent dispatches in one round; scale/skip phases with a one-line
  rationale.
- **Ultra Review**: every non-trivial change gets EXACTLY 3 parallel
  reviewer dispatches, one dimension each (completeness / correctness /
  impact, mutually ignored), merged by the lead into one severity-grouped
  report before the feedback loop. Trivial changes may skip with a stated
  reason.
- **Evidence standard**: "done / fixed / passed" claims without verifiable
  evidence (command output, logs, diffs, screenshots) are rejected — for
  sub-agents and the lead alike.
- **Discovery gate**: external CLI/API/runtime usage must be verified
  (`--help`, docs, versions) before any implementation dispatch that
  touches it.
- **Verbatim contracts**: when parallel implementers interoperate, the
  exact data contract is written once and pasted verbatim into every
  affected dispatch (mismatches are the #1 source of integration bugs).
- **README-first**: the lead reads the project's README (plus
  AGENTS.md/CLAUDE.md) before anything else and restates binding
  conventions in dispatches.
- **CHANGELOG maintenance**: delivered changes append an entry to the
  project's CHANGELOG.md (Keep-a-Changelog style) when one exists; the
  lead offers to create one when it doesn't.
- **Research perspectives**: 2+ researchers on the same codebase get
  distinct lenses (simplicity & maintainability / minimal-change risk /
  performance & runtime correctness) with file:line evidence required.

### Changed
- **Reviewer** is now a single-dimension reviewer: each dispatch reviews
  exactly one dimension (completeness / correctness / impact) with a
  per-dimension checklist; standalone use without a dimension defaults to
  correctness and says so. Severity scale, verdict lines, blackboard
  protocol and single-dimension re-review retained.
- **Tester** gained a UI verification mode: user-visible frontend changes
  are verified against the real page/flow with screenshot + console
  evidence; when no browser tooling exists the report ends with
  `UI NOT VERIFIED: <what needs manual checking>` instead of pretending.
- All specialists gained a shared **Evidence rule** (no narrative-only
  completions) and a **Project conventions** rule (README/AGENTS.md
  conventions in Reads outrank defaults).
- `/team-run` template mirrors the new workflow (README-first, gates,
  Ultra Review, changelog step); `/team-review` template selects the
  dimension with a correctness default.

### Fixed
- **Implementer fix-mode contradiction resolved:** the fix-mode instruction
  said "append to the same file" while the blackboard guarantee forbids
  appending to existing artifacts (frozen writes). Fix mode now writes a
  NEW round-suffixed file (`02-implementer-auth-r2.md`), consistent with
  the ownership model; the lead's MANIFEST.md is explicitly documented as
  the one artifact updated in place.

## [1.4.5] — 2026-08-28
- Team-as-default restored as shipped behavior: opt-OUT again
  (`defaultAgent: false` releases the slot); picker order is team, build,
  plan by default; mutual exclusion with "Team below Plan" documented both
  ways; test matrices rewritten for the `!== false` gate.

## [1.4.4] — 2026-08-27
- Shipped the working-label-1.5.0 train under the next patch slot:
  opt-in default-agent promotion (`{"defaultAgent": true}`), TTL sweeper as
  the sole board reclamation path, session-partitioned boards
  (`root/<session-key>/<task-slug>/`) with two-level sweep, team-lead
  anti-drift guardrails.

## [1.4.3] — 2026-08-2x
- Blackboard ownership model: per-agent topic files, frozen writes with
  round-suffixed revisions, ~100-line split guideline; lead-issued
  `Reads:`/`Write to:` dispatch manifest; `MANIFEST.md` Current-state
  header; triage Step-0 (question ≠ work order, propose-and-wait);
  user-stated boundaries outrank all rules.

## [1.4.1] — 2026-08-1x
- Renamed orchestrator agent `team-lead` → `team` (matches build/plan
  naming style); prompts, command binding, docs, installers, tests updated.

## [1.4.0] — 2026-08-1x
- Fixed loader contract to the ACTUAL v1 shape used by OpenCode Desktop
  1.18.x (verified by dissecting the shipped binary).

## [1.3.0] — 2026-08-1x
- Fixed Desktop 1.18.x loading (three compounding bugs in the plugin
  manifest/loader path).

## [1.2.1] — 2026-08-1x
- Specialists can write the blackboard themselves — removed the
  verbatim-transcription escape hatch.

## [1.2.0] — 2026-08-1x
- Shared blackboard coordination (file ownership, manifests) + prompt
  hardening.

## [1.0.x–1.1.x] — 2026-08
- Initial plugin: 6 agents (team / architect / implementer / reviewer /
  tester / researcher) + 6 slash commands, v2 plugin API migration,
  Chinese README, scoped package rename.
