# Changelog

All notable changes to `@te-river/opencode-team-mode` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning is semver (the 1.4.x train shipped under working labels; the
registry saw 1.5.0 as the install-script fix release).

## [Unreleased]

### Changed
- tm_memory search now enforces project > global precedence: same-title global entries are shadowed by project entries, project entries get a +2 near-tie weight; tool description and agent prompts document the project/global layer split.
- tm_ptc_run intent: the PTC batching rule is now a plan-time trigger ("plan lists ≥3 probes → FIRST move is ONE tm_ptc_run"); researcher prompt gains a PTC-first recon section.

## [1.5.11] - 2026-09-13

### Fixed
- **tm_browser drives the user's DEFAULT browser**: discovery order was
  TM_BROWSER_PATH -> Edge-first probe list; it now resolves the system
  default browser first (Windows `UserChoice` registry / Linux
  `xdg-settings` + .desktop Exec) and uses it WHEN Chromium-family -- CDP's
  pipe protocol is Chromium-proprietary, so a Firefox default falls back to
  the probe list.  Parsers exported + pinned in test-tm-tools 6o
- **403 after the header disguise is now a DIRECTIVE**: real sessions showed
  baike.baidu.com / zhihu.com returning 403 even with the 1.5.10 Chrome UA --
  the gate is JS-challenge / TLS-fingerprint based, so the error now tells
  the agent exactly what to do: call tm_browser (action:"open" ->
  action:"read") for that URL
- **Search hit lists filter known noise**: engine-internal wrappers
  (`so.com/link?`, `ai.so.com` -- 360 wraps every hit and surfaces its own
  AI tab as a "result") join the tracker blacklist; a hit-domain blacklist
  (default `maimai.cn` -- the professional-networking site 脉脉 that bing
  returned 10/10 for every maimai DX query; extend via TM_HIT_BLACKLIST env)
  drops same-name-different-site collisions before they reach the agent
  (pinned in test-tm-tools 6m-s)

## [1.5.10] - 2026-09-13

### Fixed
- **All web channels send real-browser headers**: tm_webfetch / tm_search
  (via the shared fetch) now send a mainstream Chrome UA + Accept +
  Accept-Language (zh-CN) — a real session collected 403s from
  baike.baidu.com and zhihu.com against the old robot-shaped
  "compatible; TeamMode" UA; tm_browser pins the same Chrome UA via
  --user-agent (defeating the HeadlessChrome token under --headless=new)
  and --accept-lang.  HTTP 403/418 now returns a switch-engine /
  tm_browser hint instead of a bare status line
- **PTC trigger now counts built-in bash chains**: a real version-check run
  fired 3 sequential built-in bash probes (Test-Path ×2 + npm view) without
  batching — the old trigger text said "≥3 tm_read/tm_grep/tm_bash calls",
  which a literal-minded model dodges by using built-in bash.  The rule now
  reads "≥3 read/search/shell probes ... OR built-in bash alike" and
  prescribes the right batch per case: ONE tm_ptc_run program when the
  probes fit the governed tools, else ONE compound built-in bash command
  (a; b; c) — never N round-trips for one question (pinned in
  test-blackboard)
- **Test-Path joins the tm_bash readonly allowlist**: existence probes are
  read-only and were the exact command class the unbatched session ran;
  adding them lets tm_bash / tm_ptc_run carry such probes (embedded $env:
  expansion still trips R6 by design — the tm_* channel never reads env)

## [1.5.9] - 2026-09-13

### Fixed
- **Seed allowlist grows to 21 hosts** (13 -> 21): adds zhihu.com, juejin.cn,
  csdn.net, cnblogs.com, gitee.com (CN sources) and stackoverflow.com,
  npmjs.org (covers registry. + site), pypi.org, learn.microsoft.com
  (international dev sources) — everything a coding agent researches daily,
  reachable from mainland networks without API keys; hosts unreachable from
  CN (wikipedia / reddit / x / youtube) stay OUT (timeouts otherwise) and
  ride the official dialog when the user's network reaches them
- **Seed allowlist uses PARENT domains for baidu + moegirl**: a real session
  showed agents bouncing off `baike.baidu.com` (only `www.baidu.com` was
  seeded) and `mzh.moegirl.org.cn` (only `mobile.` was seeded — moegirl's
  main site is now the mzh subdomain, a SIBLING that subdomain matching can
  never cover).  Seeds are now `baidu.com` and `moegirl.org.cn`, covering
  every sibling (baike./tieba./www./mzh./mobile.) — host count unchanged at
  thirteen
- **tm_webfetch description hardens the tm_search priority**: leads with an
  explicit anti-pattern line ("do NOT hand-build search-engine URLs here —
  that is tm_search's job") after a session where the model hand-rolled
  bing/baidu URLs through tm_webfetch

### Fixed
- **Installers + agent guide target `opencode.jsonc` first**: the .jsonc is
  the canonical name and OVERRIDES opencode.json when both exist — patching
  the .json risked our entry being shadowed.  install.sh / install.ps1 now
  always patch the .jsonc, migrating an existing opencode.json's content
  into a new .jsonc first (original left untouched); the agent-install
  guide's Step 1 documents the same policy

### Added
- **github.com + gist.githubusercontent.com join the seed allowlist** (now
  thirteen hosts): repo pages / issues / gists fetch dialog-free; the
  github.com/<owner>/<repo>/raw/<branch>/<path> redirect chain passes the
  per-hop re-check (the raw host is seeded)

## [1.5.8] - 2026-09-13

### Added
- **Out-of-allowlist web targets now ASK, not reject**: tm_webfetch /
  tm_search / tm_browser hand an unlisted URL to OpenCode's OFFICIAL
  confirmation dialog via the plugin tool ctx's `ask` bridge (verified
  against the 1.18.30 desktop binary: PermissionV2.ask evaluates the
  agent's ruleset with findLast, so the web channels' new `{"*": "ask"}`
  rules beat the tm_* wildcard allow and the dialog always pops; approval
  lets the call proceed, rejection returns a structured permission error,
  and the plugin still never self-allows).  R6 red lines (env-file URLs,
  non-http(s) schemes) stay hard-rejected with no dialog — never
  consentable.  Approved hosts pass the browser's CDP network layer for
  the session (runtime approvedHosts set)
- **Toast notification on every confirmation dialog**: the approval gate
  now fires `tui.showToast` (warning, 15 s, title "OpenCode TeamMode")
  for EVERY permission.asked it observes — bash R2/R6 asks and the new
  tm_* web dialogs alike — naming the pending pattern and the auto-reject
  timeout, deduped by request id (pinned in test-envprotect §7)

### Fixed
- **The agent-install flow could not fetch its own installation guide**: the
  READMEs point agents at
  `raw.githubusercontent.com/.../docs/installation.md`, but that host was
  NOT on the seeded tm_webfetch allowlist — a real session showed the team
  agent rejected by its own tool, then bounced off bash fallbacks
  (Invoke-WebRequest 502 from mainland networks).  Seeds now include
  `raw.githubusercontent.com` AND `ghproxy.net` (the mainland mirror the
  installers already use — eleven hosts total); the install prompt and the
  guide itself document the mirror retry, and the packaged copy of the guide
  under the plugin cache dir is noted for post-install reading

## [1.5.7] - 2026-09-13

### Added
- **tm_search — governed multi-engine web search (new tool)**: one call,
  one query, clean results.  9 engines, all reachable from mainland China
  without API keys: bing (cn.bing.com, default), bing-int (international
  results via ensearch=1), sogou, so (360), baidu (flakiest — failures name
  alternatives), bilibili, moegirl (MediaWiki search API, structured), plus structured JSON from the npm registry search
  (name@version + description) and the GitHub repo search API (stars +
  description).  HTML SERPs are collapsed into numbered title+URL hit lists
  (click-tracker and engine-chrome anchors excluded, entity decoding,
  per-URL dedupe) — the agent never sees raw SERP noise.  Same governance
  as tm_webfetch (allowlist, per-hop redirect re-check, threshold offload)
  over the shared pipelines instance.  Granted to the two network roles
  (lead + researcher) like the other web channels
- **Search-result extraction in tm_webfetch too**: fetching a search-engine
  result page auto-extracts the hit list instead of dumping stripped page
  chrome (`extractSearchHits` / `renderSearchHits`, exported for reuse)
- **Parallel-safety guarantee (pinned by tests)**: the step counter advances
  in one synchronous expression on the single-threaded event loop, so the
  host may Promise.all batches of tm_search / tm_webfetch / tm_fetch calls —
  distinct step ids, per-step payload files, zero cross-contamination
  (test-tm-tools §6p: 4 concurrent searches + 2 concurrent offloads + 6
  concurrent fetch page-ins)
- **docs/installation.md** — agent-consumable install/update/uninstall guide
  (bilingual); the READMEs' "let your agent install it" path points here

### Changed
- **tm_browser granted to the tester (browser-only)**: the tester verifies
  user-visible frontend changes through the governed tm_browser (local dev
  servers / preview routes) instead of ending with `UI NOT VERIFIED` when a
  browser exists; open web fetching (tm_webfetch / tm_search) stays with
  the lead + researcher.  The tester prompt gains a dedicated "UI
  verification (tm_browser)" section; the honest-gap fallback remains
- **Installers are idempotent — re-running them IS the update**:
  scripts/install.sh + install.ps1 now purge the stale plugin cache and
  re-resolve npm-installed copies in the config dir after patching the
  config, so "install" and "update" are the same one-liner (docs/
  installation.md documents three update paths incl. an agent prompt)
- **Search seed allowlist grows to nine CN-reachable hosts**:
  + `www.bing.com` (international), `www.sogou.com`, `www.so.com`,
  `api.github.com` (alongside the existing moegirl / bilibili / cn.bing /
  baidu / npm registry); tm_webfetch + tm_search + tm_browser share it
- README.md + README.zh-CN.md rewritten for humans: TL;DR lazy path, the
  six-agent roster up top, three-track install (let-your-agent / one-line
  script / manual), a search chapter, FAQ, uninstall, and a punchier tone
  throughout — technical chapters preserved (bilingual parity kept)
- Researcher/lead prompts: tm_search is the open-ended-lookup front, the
  seed list documents all nine hosts + the npm/github search endpoints;
  shared web-boundary rule and tool ladder mention tm_search
- tm_bash readonly allowlist gains the PowerShell pipeline formatters
  (Select-Object / Where-Object / Sort-Object / Group-Object)
- **tm_ptc_run adoption**: the tool description now leads with the trigger
  (use INSTEAD of chaining ≥3 tm_read/tm_grep/tm_bash calls) and ships a
  one-line example program; the aggregation summary carries an educator
  line when a program with ok bridged calls returns no data (the #1
  adoption killer — silent result loss); SHARED_RULES states the ≥3
  threshold + return-data rule; the lead's research phase batches recon
  in one tm_ptc_run program
- TmRuntime now exposes the main pipelines instance (tests + tool builders)

## [1.5.6] - 2026-09-13

### Added
- **`tm_browser` — governed interactive browser (Plan C, headful)**: drives
  the user's own Chromium-family browser (Edge probed first on Windows) via
  the CDP **pipe** protocol (`--remote-debugging-pipe`, JSON+NUL framing
  over fds 3/4 — zero deps, no WebSocket).  Actions: open / navigate /
  read (page text, threshold-governed) / screenshot (PNG to the run store,
  only the path enters context) / close.  Hardening ported from the Qoder
  mechanism analysis: isolated temp user-data-dir, domain allowlist
  enforced at the NETWORK layer per request (CDP `Fetch.requestPaused` →
  `BlockedByClient`), hard per-command timeouts, `dispose()` kills the
  child.  Environment-adaptive: headful by default, auto-headless on
  display-less Linux, `TM_BROWSER_PATH` / `TM_BROWSER_HEADLESS` overrides;
  no browser found → structured error with fallback guidance to
  tm_webfetch / user MCP tools.  Network role tool (team + researcher only;
  assert in test-tm-tools §6o, test-default-agent §6)
- **Lead-only `todowrite` + `question` grants**: the lead's prompt
  MANDATES a todo list ("your state memory is the todo list") and batched
  blocking questions — those built-ins were deny-listed, making the
  mandates unfulfillable.  Now granted to the team lead; specialists keep
  the deny (they answer through the lead via `STATUS: blocked`, never
  interrupt the user directly)
- **Project memory (`tm_memory`) — all agents**: durable project facts live
  as Markdown files with YAML-ish frontmatter (title / usage_scenario /
  keywords) under `<repo>/.git/opencode-team/memories/<project-slug>/<category>/`
  (Qoder-inspired design, re-implemented from mechanism analysis; tmpdir
  fallback outside a git repo).  Actions: `add` (4000-char cap, seeded
  category taxonomy from Qoder's seven categories) / `search`
  (deterministic keyword scoring: title ×5 > keywords ×4 > usage_scenario
  ×3 > body ×1, top 5) / `list` (grouped) / `forget` (by title).  Pull-
  model injection: agents are prompted to search before assuming project
  conventions and to save hard-won facts; the lead relays relevant
  memories into dispatches (asserted in test-tm-tools §6n,
  test-blackboard, test-default-agent §6)
- **Two-channel web access (network roles: Team Lead + Researcher ONLY)**:
  - **High priority — user MCP/plugin tools**: browser automation, search
    and fetch tools from user-configured MCP servers pass through the
    whitelist untouched; the agents' prompts now instruct them to scan
    their tool surface and PREFER those tools for web lookups.
  - **Fallback — new `tm_webfetch` tool** (governed): domain-allowlisted
    fetch seeded with `mobile.moegirl.org.cn` / `search.bilibili.com` /
    `cn.bing.com` / `www.baidu.com`; `TM_WEBFETCH_ALLOWED_DOMAINS` extends
    the list (`"*"` opens every host).  Red lines: http(s)-only, redirects
    followed MANUALLY and re-checked against the allowlist per hop, remote
    env-file URLs refused (R6 red line), 2 MB body cap, 20 s timeout, HTML
    stripped to text.  Output rides the SAME governance as the other tm_*
    tools (threshold offload + content-aware preview + tm_fetch handle) —
    a web page can never flood the context.  Permission map: explicit
    `allow` for team + researcher only; architect / implementer / reviewer /
    tester carry an explicit `deny` (overrides the `tm_*` wildcard) — web
    questions are reported as gaps, never simulated.  Built-in
    webfetch/websearch stay removed (asserted in test-tm-tools §6m,
    test-default-agent §6, test-blackboard)

### Fixed
- **win32 fs.rmSync silently no-ops on non-ASCII paths** (observed Node
  24.12: CJK-named files survive `fs.rmSync` with no throw, while
  `fs.unlinkSync` works): new `fs-safe.ts` `rmForceSafe` does rmSync then
  an existence check with a manual depth-first unlink fallback; all
  destructive call sites (blackboard sweeper, run-store TTL sweep,
  tm_memory forget) route through it — a silent no-op deletion could have
  left stale boards/payloads on disk forever (regression-pinned in
  test-tm-tools §6n)
- **PTC step-id namespace collision**: the PTC pipeline instance's step
  counter started at s0001 again — offloaded PTC bridge payloads could
  collide with same-numbered main-pipeline steps inside the shared run
  store (refs ignore seq, so tm_fetch's last-append-wins could return the
  WRONG payload).  PTC now runs under a `ptc-` stepPrefix
  (`ptc-s0001.k01`), giving it a private step-id namespace
- **PTC shell bridge (P0)**: the v1.5.4 Bun-global `$` fallback now reaches the
  PTC pipeline instance too — previously only the main tm_bash path resolved
  `globalThis.$`/`Bun.$`, so on desktops where the loader does not pass `input.$`
  through, every `tm_ptc_run` program using `tm.bash()` died with
  "宿主 shell 桥（$）不可用" (regression-pinned in test-tm-tools §6k)
- **Env "always" blanket excludes env-FILE reads**: a session-wide env approval
  (picking "always" on an env dialog) never covers `CATEGORY_ENV_FILE_PATH` —
  `.env` / shell-rc reads keep hard-throwing even in an env-approved session,
  because env files never open a dialog of their own and no "always" verdict
  can have consented to them (asserted in test-envprotect §7h-2)
- **Mixed-agent stale deferral window closed**: the approval gate gains
  `revokeExecSession(sessionID)`; index.ts now REVOKES a session's exec
  registration whenever a user prompt routes to a non-injected agent
  (message.updated / chat.message).  Verified against the desktop binary: the
  host passes `{tool, sessionID, callID}` with NO agent to
  `tool.execute.before`, so the per-turn agent signal can only ride
  message.updated (UserMessage.agent is a required string).  A later
  exec-role prompt or a real env-classified dialog re-registers (asserted in
  test-envprotect §7f/§7i)

### Changed
- **Tool-first prompt rule**: every agent (lead + all five specialists) is
  instructed to actively scan its tool surface and route lookups through
  the governed tools with a planned concrete call BEFORE answering from
  memory — files/docs via tm_read, code search via tm_grep, enumeration /
  quick probes via tm_bash, multi-file batch recon via tm_ptc_run, command
  behavior via built-in bash where granted.  Colloquial / abbreviated /
  aliased terms are expanded to canonical forms and searched in both
  spellings before concluding "not found"; capabilities that are not on
  the tool surface are reported as gaps, never simulated.  Pinned in
  test-blackboard.mjs
- **Repo hygiene prompt rule**: every agent (lead + all five specialists) is
  now instructed to DELETE scratch/temporary files it created before
  reporting done, and to keep throwaway work in the OS temp dir so nothing
  lands in the user's repo (deliverables — code/tests/docs — are not temp
  files).  Pinned in test-blackboard.mjs
- **Store dirs leave the working tree (P2)**: the tm payload/trajectory stores
  default to `<repo>/.git/opencode-team/blackboard|trajectory` (tmpdir
  fallback outside a git repo; worktree `.git`-file handled) instead of
  `.blackboard/` / `.trajectory/` in the project root — user projects never
  had those gitignore entries.  Explicit `TM_BLACKBOARD_DIR` /
  `TM_TRAJECTORY_DIR` keeps the old absolute/project-relative semantics
- **CJK-aware token口径 (P2)**: `estimateTokens` counts CJK-range code points
  (≥U+2E80) as ≈1 token each, everything else chars/4 — the pure chars/4
  basis under-counted CJK up to 4× and let CJK-heavy payloads ride inline
  past the threshold.  `capTokens` truncates by the same per-char cost basis
  (shared `tokenCostOf`), so the 80-token preview cap stays honest for CJK
- **tm_ptc_run args** use the same ZodRawShape treatment as the four tools
  when the host ships zod (descriptor fallback unchanged); `program` /
  `label` / `budgets` now reach the LLM parameter spec properly
- **PTC engine hygiene**: `selectEngine`'s auto branch no longer pretends
  construction can fail (the real worker→inline degrade re-runs the whole
  program in `runPtc` — documented in the tool description and READMEs);
  the worker program body now compiles in strict mode (parity with the
  inline engines)
- **InlineVmEngine actually kills busy loops now**: measured on Node
  24/win32, `vm.compileFunction`'s `timeout` does NOT interrupt a busy loop
  when the compiled function is invoked — the old engine could freeze the
  host's main thread forever on a `while(true){}` program.  The engine now
  wraps the program in an async IIFE under `vm.runInNewContext` with a
  script timeout, which verifiably kills pre-await synchronous busy-loops
  ("Script execution timed out"); the post-await residual (blocks the host
  event loop, nothing can reclaim the main thread) is now documented
  precisely — prefer worker/auto (asserted in test-tm-tools §9j)

### Tests
- §9j: REAL engine coverage — WorkerEngine RPC round-trip, program-throw
  propagation, wall-clock terminate, `env:{}` isolation, strict-body pin;
  InlineVmEngine compile-timeout busy-loop kill (injectable
  `compileTimeoutMs`, default unchanged 30 s)
- `npm test` now includes test-default-agent.mjs (was "Test (full)" only)
- Docs synced with the v1.5.4 all-six-agent `tm_ptc_run` grant (README ×2,
  AGENTS.md, stale M1-era source comments in ptc.ts / tm/index.ts /
  agents.ts / test-tm-tools.mjs); README agent table fixed to match actual
  behavior (Reviewer: ONE reviewer default, 3 parallel only high-risk;
  Researcher: local-repo only, no web tools); AGENTS.md gained a Design
  goals (business context) section

### Refactor (no behavior change)
- **PTC subsystem split**: the 1092-line `tm/ptc.ts` became 9 single-
  responsibility modules under `tm/ptc/` (contract = the frozen `PtcEngine`
  seam + RPC surface, budgets, pscan, engines, gate, driver, summary,
  tool, index facade).  All historical export names preserved
- **tools.ts hub dissolved**: 868 lines → thin assembly + `pipelines.ts` /
  `result.ts` / `client-unwrap.ts` / `shell-bridge.ts` / `args-schema.ts`
  (the PTC arg schema moved out of tools.ts where it did not belong)
- **envprotect.ts split**: 872 lines → facade + `envprotect/` (patterns,
  bash-classify, path-classify, gate-predicates, hook)
- **agents.ts split**: 801 lines → structure-only module + `prompts/`
  (lead / specialists / shared) — prompt strings moved verbatim, pinned by
  test-blackboard.mjs
- **Duplication removed**: one shared statement segmenter (`shell-text.ts`)
  instead of two drifted copies; one shared allowlist env parser
- All four test suites green after every step; no API, permission, env
  knob, or default changed

## [1.5.5] - 2026-09-12

### Changed
- SHARED_RULES: added "PTC batch orchestration" guideline — agents now prefer tm_ptc_run for multi-step read/search/command sequences
- tm_read / tm_grep descriptions: explicitly state paths are relative to project root (not agent working directory)

## [1.5.4] - 2026-09-12

### Changed
- **tm_ptc_run granted to all six agents** (team included): the M3 permission design originally denied it to the team lead; changed to allow per user request
- **R6 env protection defaults to OFF** via new `envProtect` plugin option (boolean, default false) — opt in: `["@te-river/opencode-team-mode@latest", {"envProtect": true}]`
- **Shell bridge fallback**: tm_bash resolves `$` from Bun globals (`globalThis.$`, `globalThis.Bun.$`) when `input.$` is not passed by the desktop loader (Windows desktop fix)

## [1.5.3] - 2026-09-10

### Fixed
- SHARED_RULES: agents now use built-in bash for R6 protected reads (approval dialog triggers)

## [1.5.2] - 2026-09-10

### Added
- **Session-wide env approval ("always" on env ask)**: when the user picks
  "always" on an env-related permission dialog, the plugin now records that
  session as "env-approved" — all subsequent env reads in that session pass
  silently (no dialog, no throw).  R2 danger commands are NOT affected
  (they still require per-call approval).  The host's own "always"
  generalizes too broadly (e.g. `Get-ChildItem env:PATH` → `Get-ChildItem
  *`), so the plugin interprets "always" on env asks as a precise
  session-scoped blanket instead of relying on the host's pattern.
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

### Fixed
- **Preview could HANG on huge single-line payloads (O(n²) regex)**: the
  path:line ref collector ran a global regex whose `(?:X+[\/])*` group
  backtracks char-by-char at every scan position — measured 100K chars ≈
  23 s, 200K ≈ 127 s, a 2.5 MB minified-JS/JSON page = effectively forever
  (caught by the new tm_webfetch no-body regression test).  collectPathLineRefs
  is now a bounded LINEAR scan (colon-anchored indexOf + local validation,
  240-char path window, 5000-colon probe budget) — 2.5 MB preview now takes
  ~11 ms
- **PTC: no retry past the deadline** — a retryable-phase failure arriving
  at the wall-clock boundary no longer buys extra time (pinned in test-tm-tools §9e); the retry still rides the same call-budget unit
- **tm_memory forget: slug-collision guard** — deletion now validates the
  file's frontmatter title before removing it, so two different titles that
  slug-identically ("API Rate Limits" / "API rate-limits") can no longer
  delete each other (pinned in test-tm-tools §6n)
- **tm_webfetch: the text()-only fallback response path now honors the 2 MB
  cap** (post-read truncation when the host response has no streaming body)
- **tm_search arg errors use phase=args** (missing query / unknown engine
  were mis-filed as permission)
- **tm_bash works on the Desktop sidecar (P0)**: the shell bridge assumed
  the host $ (Bun shell) — but the 1.18.30 desktop runs the plugin in a
  worker on Electron's Node where neither input.$ nor Bun globals exist,
  so every tm_bash / PTC tm.bash call died with 「宿主 shell 桥（$）不可用」
  (caught in a real session transcript).  runShellCommand now falls back
  to spawning the platform shell directly (PowerShell on win32 / bash
  elsewhere) AFTER the $ shapes fail — P3/R6 governance still classifies
  the command first, and a thrown shell error still rethrows (preserving
  line extraction)
- **README: plugin updates are manual** — documented the true semantics
  (OpenCode caches plugins by spec string and never re-resolves @latest;
  upstream issues #25293 / #10546 / #21609) and the update recipe
- **Global memories now actually global**: the tm_memory `global` scope
  wrote into the CURRENT repo's .git store — per-project despite the
  label.  Global memories now live at `~/.opencode-team/memories/global`
  (TM_MEMORY_GLOBAL_DIR override, isolated from any repo) and follow the
  user across projects; the `project` scope is unchanged (asserted in
  test-tm-tools §6n)
