# The v2 port, in full — evidence, history and the reasoning behind each rule

AGENTS.md keeps the **rules** and points here for the **evidence and the story**: what was
measured, on which host build, which claim was later falsified and by what, and why a
decision was taken the way it was. This split exists because AGENTS.md is loaded into every
session — prose there is paid for per request — while this file costs nothing until someone
reads it, which is the same rule the prompts follow (see "subtraction philosophy" in
AGENTS.md).

Nothing was rewritten when it moved here: the section below is byte-exact from AGENTS.md as
of 2026-09-26. New findings append to the section that owns them, with a date and the
evidence tag (`[B]` binary read, `[L]` live host, `[R]` our own measured code, `[D]` docs).
Related: `docs/research/plugin-loader-contract.md` (how the host loads a plugin),
`docs/research/host-subagent-injection.md` (the background child's three moments),
`docs/research/v2-builtin-tools.md`, `docs/research/browser-pane.md`,
`docs/research/agent-data-exchange.md`, and `docs/installation-v2.md` for the install flow.

## The v2 delta (2026-09-25, in force)


The goals above were written against OpenCode 1.18.x. These are the places where
the 2.x port changes the business claim rather than the implementation — read
this before treating any sentence above as platform-neutral.

- **Everything the plugin changes is Team-scoped (user requirement, 2026-09-25).**
  Every v2 hook fires for EVERY session on the host, so `src/host/v2-scope.ts` is the
  one answer each layer asks before it writes: the per-role tool trim, `temperature`
  0.2, the board note, the compaction survival list, the native-result offload, the
  R6/egress permission strictening, and the forced `background: true` all no-op for
  `build`, `plan`, or any agent that is not one of our six — those modes must look
  exactly like a freshly installed OpenCode. A session also becomes "ours" when one of
  our own tools serves it (`bindV2Tool`'s `onCall` → `learn`), because the host does not
  promise `agent` on every event. The third verdict, `unknown`, is deliberately NOT
  treated as ours: isolation outranks coverage, so an unresolved call is left completely
  alone — and it is COUNTED (`scope_unknown`) and printed by `tm_stats` with the sentence
  "没资格治理", because a governance layer that silently stopped applying after a host
  upgrade is the overstated claim this product exists to refuse. The consequence is said
  out loud in the boot notes rather than hidden: outside Team the red lines we inject
  (metadata/private addresses, R6 classification) do NOT apply either — that floor is the
  host's or the user's own config's job. (v1 cannot be scoped this way: its `config` hook
  and bash escalation sit in the FROZEN personality.)
- **Goal 1's injection is gone on v2.** `AgentEditor` has no `add`, and
  `ctx.command.transform.add` was measured NOT to reach the UI, so the six roles
  and the six `/team-*` commands are config files —
  `~/.config/opencode/agents/*.md` and `commands/*.md`, written by the installer
  and projected from `dist/` by `scripts/gen-v2-config.mjs` — never hand-copied,
  or the prompts drift. The
  plugin still owns the permission matrix (it merges its triples onto whatever
  the config declares) and still ATTEMPTS the Team-default promotion on every boot
  -- but `editor.default("team")` is measurably a no-op against a live host (see
  the v2-default-agent gap below), so the requirement is satisfied by the
  INSTALLER writing `default_agent: "team"`, not by this call.
- **Goal 5's "ask the user" does not exist on v2.** A plugin cannot raise the
  host's official dialog (live-probed: declaring `options.permission` on our own
  tool triggered no evaluation and no prompt). Governed calls therefore **fail
  closed** with a v2-worded refusal instead of asking, and the only dialog left
  is one the host raises on its own (`effect:"ask"` from a permission rule or
  `permission.hook("evaluate")`). Anything that reads the v1 ask path as a model
  for v2 is wrong.
- **Goal 4 is now the hard floor, and it has to cover the host's own tools.**
  `tool.hook("execute.after")` takes a mutable `result` (docs example reassigns
  it; a live probe confirmed the write lands), so offload + ≤80-token preview +
  HMAC handle must extend to native `read`/`grep`/`shell`/`webfetch`. A promise
  that only holds while the model happens to pick `tm_*` is not a promise.
  **Both halves are now in:** `src/host/v2-session.ts` removes every tool a role
  is denied from the assembled request (and the whole `browser_*` catalog where
  `tm_browser` is denied), restores the 0.2 temperature, carries the resolved
  board root to the lead, and starts the blackboard sweeper v2 silently lacked;
  `src/host/v2-offload.ts` governs the NATIVE results through
  `tool.hook("execute.after")` — measured on a live host: native `shell` 12 902
  tokens arriving as a 78-token preview, `execute` 15 000 as 58.
  **The governed name list is now every tool a Team role can call** (user
  requirement #2: coverage may not depend on which tool the model picked):
  `read grep glob shell bash webfetch websearch execute edit write patch question
  subagent` plus the whole `browser_*` namespace matched BY PREFIX, because the host
  has 45 of them and a 45-name list goes stale on the 46th without notice. Safety did
  not move with the names — the decision to rewrite is per payload (an unrecognised
  shape is left byte-exact), which is what the closed name list was really protecting.
  And coverage is now a NUMBER: the report separates `ours` (every call resolved to a
  Team session), `seen` (on the governed surface), `unmatched` (ours, but a tool we do
  not touch) and `offloaded`; `tm_stats` prints them, so "most calls are JIT-governed"
  can be checked and can also admit what it missed.
- **Done (1.7.0 line): `tm_read` / `tm_grep` / `tm_bash` retired on v2 only.**
  The ordering AGENTS.md demanded held: governance moved down FIRST
  (`permission.hook("evaluate")` for the address + R6 red lines,
  `execute.after` for the offload), and only then did the aliases go.  Where the
  third piece of v1's P2 went: the host has its own `external_directory`
  permission action, observed live answering `effect:"ask"` with a real
  `permission.asked` behind it — so the native ladder is scoped by a dialog
  rather than by our hard throw, which is stricter, not looser.  The retirement
  has TWO halves and both are pinned by `test-v2-adapter` group 3: the trio is
  not registered and gets no permission triples (`V1_ONLY_TOOLS`, now also the
  `mergeTriples` reclaim set, so a stale `tm_read` rule from an earlier boot is
  collected), AND v1's matrix denies native `read`/grep/glob for every role —
  projecting those denies would have left a v2 role with NO file access at all,
  which is why `V2_LADDER_ACTIONS` exempts them in both the triple translation
  and `toolsToRemove()`.  v1 keeps all three because it cannot rewrite a tool
  result at all.  The two personalities now ship different tool surfaces, and
  the prompt fork is real: `V2_TEXT` in `gen-v2-config.mjs` rewrites every
  sentence that named the trio or called the shell `bash` (a key that stops
  matching throws the build), which is why the v2 config files say `read` /
  `grep` / `shell`.
- **The bloat number, and what it is NOT.** Summing the thirteen `tm_*`
  definitions through our own `estimateTokens` gives **9 528 tokens**
  (descriptions 6 639 + schemas 2 889) — that is the size of OUR definition set,
  measured offline against `dist/`. **It is not a per-request cost, and a live
  2.0.16 session says so:** the `team` agent's assembled request carried
  **6 tools** (`edit`/`question`/`shell`/`subagent`/`write`/`execute`) and
  **zero `tm_*`**, while the model's 61 calls in that session went to
  `shell`(42)/`execute`(14)/`edit`(4)/`write`(1). So either plugin tools are
  delivered only through the Code Mode catalog (the way `browser_*` is) or the v2
  **RESOLVED (2026-09-25, read out of the 2.0.16 binary): the catalog explanation is
  the right one, and it is our own doing.** Visibility is decided by
  `options.codemode` — a tool whose value is not `false` is offered ONLY inside the
  Code Mode catalog, where the host keeps `≤120 chars` of the description's FIRST
  line under a ~2 000-token budget. `bindV2Tool` never sent `options`, so every
  `tm_*` we register was catalog-only from the start: the tools WERE live (callable
  from inside `execute`), and almost none of the governance text written for them
  ever reached the model. `TM_V2_CODEMODE=direct` now sends the flag, and the cost is
  MEASURED per role through our own `estimateTokens` (definitions + schemas, after
  the request-layer trim): architect / implementer / reviewer **2 660** tokens,
  tester **5 448**, researcher **7 113**, team **8 515** — i.e. direct delivery is
  affordable for the three build-class roles and expensive for the two network roles
  plus the lead, where `tm_browser` alone contributes 2 788. **DECIDED (user,
  2026-09-25): slim first, then default to direct.** `tm_browser`'s description went
  from a narrative of every lesson to what the model cannot recover from a result —
  729 tokens (its parameter table is the other 1 337, and those descriptors are
  per-parameter truth, not prose), and with `tm_pty` retired too the measured cost is
  now **2 660 for architect/implementer/reviewer, 4 726 tester, 6 391 researcher,
  7 366 lead**, which is what `direct` was supposed to buy per request. **FALSIFIED
  2026-09-26 by the user's own desktop session**: with `options.codemode:false` sent for
  all ten tools, 2.0.16 still delivered every `tm_*` inside the host's Code Mode catalog
  ("They cannot be called directly…"), and the model's own callable list was the nine
  native tools. So the flag changes what WE send and nothing else, the default now sends
  nothing (`TM_V2_CODEMODE=direct` is an opt-in experiment for a build that honours it),
  and the outcome is an OBSERVATION — `tools_in_request`, derived from whether a `tm_*`
  name ever appears in an assembled request's own tool map — printed by `tm_stats` beside
  the sent flag. The token figures above stand as measurements of OUR definition set;
  what turned out to be fiction was the claim that the model receives them.
  The history did not disappear — it stayed in AGENTS.md and CHANGELOG.md
  where it costs nothing per request, which is the rule this repo applies to prompts
  generally (see the subtraction philosophy).
  What the live session DID confirm: the per-role trim works (the native
  read/grep/glob/list/webfetch/websearch/skill/patch the matrix denies were
  gone from the request).
- **Goal 4 gains a third outcome besides "in context" and "offloaded": CAPPED.** A
  live session caught the generic offload eating a report: a `tm_stats` answer called
  through Code Mode arrived as the `execute` result at 2 917 tokens and came back as an
  80-token preview, so the lead spent the round paging a table back in and the user got
  prose about numbers. Two payloads are structurally unreadable once previewed — a
  browser snapshot (its `[ref=…]` lines ARE the next click's arguments) and a report
  (a table with a row missing is not a smaller table, it is a broken one) — so
  `capKeepingAddressing()` and `capKeepingTables()` keep the structural lines and drop
  the prose instead, up to `budget × 4`, and say how much did not fit. `reportCapped` /
  `capped` / `offloaded` are three separate counters in `tm_stats`, because they answer
  three different questions about what entered the context.
- **The two personalities now ship different tool surfaces, and the prompt fork
  has a home.** `V1_ONLY_TOOLS` (in `v2-permissions.ts`) is the single source for
  what v2 does not register; `v2.ts` skips those when registering and
  `gen-v2-config.mjs` drops their permission triples, because an `allow` for an
  action the host never heard of claims a capability that does not exist. The
  sentences that name them are rewritten by the `V2_TEXT` table in the same
  generator -- exact strings, and **it throws if a key stops matching**, so
  editing a prompt without updating the table fails the build instead of
  silently shipping a v2 model a rule about a tool it cannot call. The lead's delegation
  section is the SECOND instance of that bug class and is forked the same way: on v2
  the host's tool is `subagent` (measured -- `execute.before {tool:"subagent"}` and
  `permission.evaluate {action:"subagent"}`), background needs no operator flag
  because the plugin forces it, so both the "pick a synchronous `task`" rule and the
  `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` sentence are v1 text that would
  have a v2 lead checking a switch that does not exist.  This is the
  mechanism the `tm_read`/`tm_grep`/`tm_bash` retirement (done, 1.7.0 line) and
  the v2-only `tm_ledger` (also done — the generator throws on a key that stops
  matching, which is what keeps a v2 prompt from naming a tool v2 does not have).
- **`tm_browser` is probe-gated, not decided.** The host ships 45 `browser_*`
  tools and a `browser` deny rule with `resource:"*"` removes the whole catalog,
  so the shape worth testing is "thin door over the host's own panel" via
  `ctx.rpc("experimental.browser")` — whether a plugin can drive that
  user-visible panel has never been verified live. If it cannot, playwright-core
  stays and the tax is real. What is already known as lost either way: no
  subresource policy on the native side, no headless ("screenshots require a
  focused visible tab"), and no per-target consent.
- **`tm_search` survives because native `websearch` needs a key.** All four
  providers (Exa / Firecrawl / Parallel / Tavily) require an API key or
  `/connect`, while the governed front's whole premise is zero-key and
  CN-reachable. **The hole this section recorded is now closed:** native
  `webfetch` had no egress red line, so a Build-class agent could fetch
  `169.254.169.254` past `checkWebUrl` -- `src/host/v2-guard.ts` now asks the
  address question at `permission.hook("evaluate")` regardless of R6 (metadata /
  link-local / reserved = deny with no consent path, IPv4-mapped and DNS64
  carriers unwrapped first, private = the host's own ask, env-file URL = deny),
  and it only ever gets STRICTER than whatever the host or a user rule already
  chose. The same hook carries R6's per-command classification, and it is now IN
  CHARGE: a live `--standalone` run recorded `{action:"shell", resourceCount:1}`
  reaching `permission.evaluate` for a real `git status --short`, which is the
  proof the coarse config-level `shell -> ask` was being kept for. So the blanket
  escalation is the FALLBACK, reached either by `TM_R6_FINE_ASK=off` or by the host
  not exposing `permission.hook` at all — and the boot note names WHICH of the two
  applies, because two causes sharing one message is how a fallback gets mistaken
  for a setting. The hook keeps counting what it sees (`shellMatched`) so the
  classifier's own hit rate stays measurable rather than assumed.
- **What the Team agent is actually OFFERED on v2 (measured, not documented).**
  Six tools in the request: `edit execute question shell subagent write`. That list
  is the ground truth for three otherwise-guessed things. ① `read`, `grep`, `glob`,
  `webfetch`, `websearch`, `skill`, `patch` are absent **because our own matrix
  denies them and the request layer deletes denied tools** — the host has those
  actions (it names them in `permission.evaluate` and in our triples), so retiring
  `tm_read`/`tm_grep` is a permission flip plus governance, not a search for a
  missing tool; and inside `execute` (Code Mode) the native names genuinely do not
  exist — `tools.read`/`tools.shell`/`tools.webfetch` return `Unknown tool` while
  `typeof` reports `"function"` for all three, so a probe that trusts `typeof` gets
  a false positive. ② `todowrite` is gone, and the LEDGER rule now has a home anyway:
  `tm_ledger` keeps the lead's list in the host's own `ctx.storage`, and
  `tm_join`'s goal tripwire reads it (an empty list answers `ledger_empty`, never a
  silent pass).
  Measured facts about that domain (live 2.0.16 probe, `docs/research/agent-data-exchange.md`): it is shared across sessions, agents AND projects — the only namespace is the plugin id — which is why the session id is part of the key and a call without one is refused; and it has no TTL and no quota, which is why `LEDGER_MAX_ITEMS` (default 200, `TM_LEDGER_MAX_ITEMS`) REFUSES rather than truncating — silently dropping the oldest asks would be the same overstated claim wearing a new uniform. ③ `execute.after` sees a native `shell` result with keys
  `content / metadata / output`, which is the precondition for putting JIT offload
  over the native tools (#5) — without that observation the retirement of
  `tm_bash` would have been an assumption.
- **Goal 5 is REPLACED on v2: no domain gate at all, address red line only.** The
  user's instruction (2026-09-25) is that nothing on the network may be blocked
  except sensitive and internal addresses. On v1 the 22-host seed list was livable
  because the plugin could raise the host's official per-request dialog; on v2 it
  cannot raise one, so an allowlist became a set of pages nobody can approve -- a
  gate with no door. v2 therefore resolves its tool config from a COPY of the env
  with `TM_WEBFETCH_ALLOWED_DOMAINS` defaulting to `"*"` (an explicit user value
  always wins; `createTmTools` gained an `env` option precisely so v1 keeps its
  shipped default in the same process). What still holds, hardest: `checkWebUrl`'s
  address policy -- link-local/metadata/reserved ranges are a deny no config can
  open, and private space (loopback, RFC1918, CGNAT, `.localhost`) stays refused
  through our tools, which have no dialog to ask with. Verified against the built
  runtime: `https://example.com` (in no seed) returns the page, while
  `169.254.169.254`, `192.168.1.1` and `localhost:3000` are refused before any
  request. The refusal wording is pinned too: a v2 refusal may not promise "只能逐次
  经用户批准" without also saying the host cannot open that dialog.
  **What this does NOT buy: per-target visibility inside the native browser.** The
  Team's direct surface is six tools (`edit execute question shell subagent write`),
  so `tools.browser.*` output reaches context ONLY as the aggregate return of one
  Code Mode program -- which is why `execute` is on the governed-tool list:
  measured live, a 15,000-token program return arrived as `offloaded:true /
  preview_tokens:58` + a `tm_fetch` handle. Governing the native browser means
  governing that door.
- **Goal 6 gains one more instance.** `inputSchemaFor` now reports `source`,
  because a table *derived by regex from a descriptor string* and a table
  *translated by zod* are both `exact` but are not the same claim — the boot log
  names which tools got which.
- **The "all agents 0.2" invariant cannot live in agent config on v2**
  (`temperature` is a documented legacy field and the runner "preserves these
  values but does not yet send them with model requests"); it must go through
  `session.hook("context").options`. Background subagents, by contrast, are
  native on v2 (`subagent {background:true}`, default nesting depth one = T3's
  "only the lead dispatches" for free), so the
  `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` env hack in the installers is
  v1-only and must fork rather than delete.
- **The installer's v2 job is TWO things, and the plugin half of it is one config
  key.** Reverse-engineered from the host binary and confirmed on live 2.0.16/2.0.18
  (`docs/research/plugin-loader-contract.md` is the evidence page): the key is
  **`plugins` (plural)** — a 2.x host never reads the 1.18.x singular `plugin` key, which
  is why an install that wrote there looked complete and did nothing; an entry is
  **installed by the host itself at startup** (`Bun.add` inside `PluginModule.load`, then
  `msg="loading plugin" id=… entrypoint=file:///…/.cache/opencode/npm/<pkg>@latest/<ts>/
  node_modules/<pkg>/dist/index.js`), so `opencode plugin add` is a convenience that
  writes the same key and v1's cache-purge / npm-re-resolve machinery is obsolete; a
  **directory** target resolves only as `<dir>/index` (hence the root `index.js` this
  package ships) and an unresolvable one is dropped with **no message at all**, so the
  only proof of an install is that log line or our own `v2-boot` row; and
  `plugin add` **refuses a path** ("Plugin target must be an npm registry package or Git
  package specifier"), which is why local mode is a config edit. The second measured fact
  is the one that bites: `opencode.json` and `opencode.jsonc` are **both parsed and
  merged** while the host's dedupe matches only an identical string, so the same plugin
  under two spellings or in both files **loads twice** (two personalities, the same hooks
  bound twice) — which is exactly what the old 1.18.x "migrate `.json` forward to `.jsonc`"
  rule produced, so that migration is gone and the installers now write one entry into
  the `.jsonc` (user requirement: keep the file previous installs used) and RECLAIM their
  own entry from the legacy `.json`. Both front-ends call one
  `scripts/lib/config-surgery.cjs` so they cannot drift, and it matches Team entries
  case- and hyphen-insensitively because a working tree is `Opencode-TeamMode`. What
  nothing else can do remains: write `agents/*.md`, `commands/*.md`, and `default_agent`
  (which must come last — a default naming a missing agent makes the host fall back to
  `build` silently).
- **The host's own background children are collectable (`babfcb8`).** On v2 every
  dispatch IS the host's `subagent` tool, and `tm_join` had no record of them, so it
  answered 没有待收集的派发 about work the user could watch on screen and a bounded wait
  could never end. `src/host/v2-subagent.ts` pairs the two seams the user's own exported
  session shows (`docs/research/host-subagent-injection.md`): `execute.before` carries
  `{agent, background, description}` and `execute.after` carries
  `result.metadata.sessionID` + `status:"running"`, with the ack sentence as a second
  source since no field shape survives an upgrade unchanged. Two honesty rules come with
  it: the child's BODY is the host's injected message, which v2 never hands a plugin
  before persisting, so a host child with nothing readable says where the text actually
  arrives instead of printing a reply we never read; and settle provenance is printed —
  the child's own `session.idle` is `event`, while "its parent went idle so the host has
  collected it" is labelled 推定 (the timestamps prove the ordering, once). A synchronous
  child has no id and registers nothing, which is the correct answer, not a failure.


### 2026-09-26 (later the same day) — that BODY sentence was our decode miss `[L]`

The paragraph above says the child's body is something v2 never hands a plugin. It is true of
the INJECTION (there is still no v2 equivalent of `chat.message`, so the message cannot be
rewritten before it persists) and false of the BODY, which is readable: `ctx.session.context
({sessionID})` answers with an array of flat `{id, time:{created}, text, type}` items, measured
against a real background child (`array(5)`, first item `type:"user"`). The bridge had been
calling that seam all along and handing the array to `lastAssistantMessage`, which returns no
text for a shape it does not recognise — so the call SUCCEEDED, the report was discarded, and the
user-visible sentence blamed the host. Flat items are normalised at the seam now
(`normaliseContextMessages`, no invented `time.completed`), the reply credits
`正文来源=ctx.session.context`, and the trajectory writes `child_body` / `child_body_missing`
with the seam name only.

Two adjacent findings from the same zero-token probe (`--standalone --model nope/nope`, a plugin
that only inspects its own ctx): the plugin ctx carries `permission.list/get/reply` and
`experimental.terminal.read`, all decoding `{sessionID}`; and `ctx.rpc` is a function of arity 1
whose convention has NOT been read. `permission.reply` remains uncalled by design — answering a
dialog for the user is self-allowing. Recorded in `docs/research/host-http-api.md` §4/§6.


### 2026-09-28 — the stop seam, and why `false` is an answer `[D]` `[R]`

The user's complaint was "the background child cannot be stopped by the lead". The diagnosis was
not a missing feature: `tm_join` has had `cancel: true` (and `ids`) since it was written against
v1's `client.session.abort`. What was missing is that the v2 bridge (`v2-session-client.ts`)
wrapped `create/get/messages/context` and never wrapped a stop, so every cancel on 2.x fell into
the `no abort seam` branch and printed 宿主无 abort 接口，未取消 — an honest sentence about our
bridge that left the user with no way out. The host HAS the seam: `[D]` the v2 API page's
`session.interrupt`, and the downloaded `/v2/openapi.json` spells the whole contract —

```
POST /api/session/{sessionID}/interrupt      (sessionID pattern ^ses; optional ?resume=true|false)
  200 SessionInterruptResponse
      "Interrupt active execution owned by this OpenCode process. Returns interrupted=true when
       an active execution was interrupted and false for the idle no-op. When resume=true,
       execution resumes pending steering input and next-in-line control items (manual
       compaction, moves) while queued prompts remain parked."
  400 InvalidRequestErrorEncoded   401 UnauthorizedErrorEncoded
  404 SessionNotFoundErrorEncoded
```

Three things were read out of that text and shaped the implementation.

- `interrupted:false` is a SUCCESS response meaning "nothing was running". `[R]` It is therefore
  neither 已停止 nor a failure: our registry row was stale. That single sentence is why the fix is
  five verdicts (`stopped/idle/unknown/no-seam/threw`) instead of a boolean, and why an `idle`
  child settles to `state:"idle"` while everything else goes to `error` with the host's own words
  in `r.error`. Collapsing them would be goal #6's exact failure mode — one success word for five
  different facts.
- The `{path:{id}}` fallback that the read methods carry was NOT extended here. `[R]` A wrong key
  on `context` yields an empty read; a wrong key on a STOP can interrupt whichever session the
  host resolved instead. So `interrupt` sends the flat `{sessionID}` — the shape every other
  `te`-wrapped ctx method decodes (measured for `create/get/context`) — and nothing else.
- `resume=true` is deliberately never sent. `[D]` It continues pending steering input, which is
  the opposite intent of a caller who just asked to cancel; a caller who wants that has the host's
  own UI.

The probe that was NOT done, and the claim that therefore does not exist: no live 2.0.x host was
reachable from the sandbox where this was written, so `interrupted:true` for a real background
child is the API page's promise, not our measurement. That is why the capability row starts
`declared`, why `ok` requires `confirmed > 0`, and why `tm_stats`'s stop row appends 本进程没人用
过 cancel:true，这一行还证明不了宿主真能停 when the counter is zero. The first live round that
stops a child is the evidence; until then the fake-ctx test proves only that the call leaves us
with the CHILD's id and that the verdicts stay distinct on the way back.

The frozen-personality half came out of the same file: v1's `abort` branch stays first and
byte-exact (`aborted on request`), and `test-v2-adapter.mjs` group 14 asserts
`interruptReached === 0` on a client that has both seams. That ordering is the guard — a test that
only checked "cancel works on v2" would still pass if v1 had silently been rerouted.

### 2026-09-30 — the same seam missed 2.0.20's MESSAGE shape; both are normalised now `[L][D][R]`

Today's full-suite run on OpenCode 2.0.20 exported the symptom rather than a hypothesis: a child's
trajectory row read `child_body_missing child=ses_f0e3bf4c0ffe… via="ctx.session.context"`, and
`正文来源=ctx.session.context` — the sentence the entry above advertises — printed for nobody, not
once. The name-level probe (`TM_V2_PROBE`) recorded the reason in the same breath: the items this
host answers with are `{keys:["content","id","metadata","role"], content:["array(1)"]}`.

That is the shape the published contract describes (`GET /api/session/{sessionID}/context` →
`{data: Session.Message.Info[]}`, `Session.Message.Assistant = {id ^msg_, metadata,
time:{created, streamed?, completed?}, type:"assistant", agent, model, content:(Text|Reasoning|Tool)[],
snapshot}`) — with one documented-vs-observed difference a plugin cannot afford to read as a version
number: the contract puts the discriminator on `type`, this host's plugin ctx puts it on `role`, and
carries no `time` at all. The 2026-09-26 normaliser treated any item that already had `content` as
"already message-shaped" and passed it through; `lastAssistantMessage` then found neither `parts`
nor a top-level `text` and returned no text. The seam answered, the body was dropped a second time,
and the reply blamed the host — the same failure shape one host build later, which is why the fix
goes at the seam and not into the collect path.

What `normaliseContextMessages` (`src/host/v2-session-client.ts`) does now, by SHAPE and never by a
host-version test:
 · `content[]` → renamed to `parts[]`; `info.role` is read from `role` OR `type`, and only when the
   value is one of the contract's message kinds (`user assistant system synthetic skill shell
   compaction idle`). An unrecognised value leaves the role OFF instead of guessing one, because a
   guessed role is how a user turn ships as the child's report;
 · flat `{type:"text", text}` items (2.0.18) → the rule that already shipped, unchanged;
 · v1's `[{info,parts[]}]` → passed through untouched, same object identity;
 · `time` is COPIED when the host wrote it and never invented — 2.0.20's ctx gives no `time`, so a
   body with no completion time still settles nothing, and tm_join's settle source stays
   `event` / `injection` / 推定, printed as such;
 · `reasoning` and `tool` parts are kept exactly as the host wrote them and are never counted as
   the reply; several `text` parts are joined in order.

The three conclusions are still three. `contextShapeEvidence` reports names and counts only (the R6
口径 binds a diagnostic) and tm_join's row now carries it: a real body logs `child_body`; a seam
that answered with nothing readable logs `child_body_missing` with
`shape=items=1 keys=[id+role+metadata+content] content=0 kinds=[] text=0`; a seam that never
answered logs `no-context-method` / `no-session-domain` / `context-threw`. `正文来源=` is printed
only when text was actually delivered, so normalisation cannot launder a miss into a read — pinned
by `test-v2-adapter.mjs` group 14, which drives both the 2.0.20 item and an empty `content[]`
through a booted personality and reads the trajectory rows back off disk.

Adjacent and still unread: `Session.Message.Assistant.snapshot {start,end,files}` and
`Text.state?: ProviderState` are in the contract and are not consumed here — nothing needs
them yet, and since the probe records key names only, the next reader must re-measure rather than
trust this paragraph.

### 2026-10-06 — the 1.7.0 cut: four measurements that shaped it `[L][R][D]`

The v1 personality was deleted outright for the 1.7.0 line (`src/host/v1.ts`, `src/tm/ptc/`,
`src/tm/ptc.ts`, `src/tm/pty.ts`, `src/tool-coerce.ts`, `src/approval-gate.ts`,
`src/host-hooks.ts`, `src/tm/bash-timeout.ts`), and four live/measured facts decided how the
survivors were written. Each is recorded here so the next reader does not re-derive it.

- **`permission.evaluate` DOES fire for the file tools, not just `shell`.** A live session's
  guard tally read `guard_actions: read=152 grep=86 edit=246 external_directory=38` — so the
  R6 env-file path face (`pathGuard`, #44) can deny `read` / `write` / `edit` / `glob` /
  `grep` on an env-file path, and the earlier assumption that only the shell command line
  reached this hook was wrong. `[L]`
- **Context usage lives ONLY in the `session.usage.updated` event.** `session.hook("context")`
  hands over the assembled messages, and those messages carry no token counts: a second turn
  that DID contain an assistant message still logged `source=no_usage messages=3`. The
  denominator is `ctx.model.list()`'s `limit.context`; the numerator is the event. This is
  why `v2-compaction.ts` taps the event feed rather than reading the request payload. `[L]`
- **win32 `statSync` is case-insensitive on the identity, `realpathSync` is not on the
  spelling.** For the same file, `statSync` returns the SAME `dev`+`ino` for both casings,
  while `realpathSync` echoes back the casing it was handed. So the generator's
  "did we generate this file" check uses `statSync`'s `dev`+`ino` (a rename leftover like the
  old `agents/team.md` is recognised), and a file it cannot identify is **left alone** rather
  than deleted. `[R]`
- **A plugin cannot name a config-file role.** `ctx.agent.list()` shows only the 7 built-ins,
  and `agent.get({agentID:"team"})` answers `Agent not found: team` — the config directory's
  roles are not visible to the plugin. Since the desktop picker renders `Agent.Info.name` and
  a config role's name is its id verbatim (`Config.Agent` has no `name` key), the only lever
  was the id: the lead role is `Team`. Identity comparisons go through `src/identity.ts`
  (case-insensitive), so `team` / `Team` / `TEAM` are all the lead and an existing install or
  in-flight session is not broken. `agents_default` in the trajectory keeps the lower-case
  value — that field is a measurement, not a label. `[L][R]`
- **The self-built browser is gone; the host's own is the only one** (user decision
  2026-10-06, commit `d668817`, a breaking change, −6 337 lines). `src/tm/browser.ts`
  (playwright/cdp engines, profile isolation, pid ledger, `browsers.jsonl` orphan
  reaper, subresource gate, `allow_host`, the per-caller lease table),
  `src/tm/serp-loop.ts` and `test-browser.mjs` were deleted, along with every
  `TM_BROWSER_*` knob and `tm_join`'s browser-lease tripwire (a lease warning with no
  leases left can never fire). What stays is the **enforcement for the native path**:
  `src/host/v2-browser-gate.ts` polices the host's `browser_*` catalog at
  `execute.before` (URL and address red lines, env-file paths, a leak-detected
  fallback that replaces the page with the refusal). The test suite count drops
  9 → 8; `test-v2-adapter` still pins the native snapshot's addressability and the
  gate's teeth. Known cost, accepted: on CLI / standalone there is now no browser at
  all, and the prompts require the agent to report that gap rather than simulate it.
  `[L]`
- **Native browser calling convention, which differs from the deleted tool.**
  `browser_evaluate` takes `{tabID, script}` where `script` is an **expression** (not
  a function source) and the return value must be a scalar you `JSON.stringify`
  yourself; snapshot addressable tokens read `@e8 [link]` (not the deleted tool's
  `[uid=eN]`). `[L]`
- **Plugin options on 2.x are the `{package, options}` object shape.** The 1.x tuple
  `["spec", {…}]` is rejected with `path=$.plugins.1 kind=invalid`; the object form is
  delivered. Measured 2026-10-06. `[L]`
- **The host's config has NO session layer.** `opencode.ai/v2/docs/config` is
  authoritative: global `~/.config/opencode/opencode.json(c)`, project
  `<dir>/opencode.json(c)` or `<dir>/.opencode/opencode.json(c)`, merged
  farthest→closest with every `.opencode/` dir overriding every direct config — and
  no per-session layer. So a layered `team-mode` config can only be global + project.
  `[L]`

- **The env-FILE red line leaked on `grep` until #58** (measured on 2.0.24). `pathGuard` reads
  `permission.evaluate`'s `resources`, and the host's `grep` reports the **pattern**, not the
  search path, as its resource (the tools page says so verbatim). So `read .env` was denied while
  `grep SECRET .env` returned `SECRET_TOKEN=abc123`. The check now also runs on
  `tool.hook("execute.before")`, the only seam that sees the whole input, over the path-bearing
  fields per tool — and the field names were read out of the host binary rather than guessed
  (`read`/`write`/`edit` → `filePath`; `glob` → `pattern`; `grep` → `path`/`include`).
  `grep`'s own pattern is deliberately NOT judged: it is a regex, and `isEnvFilePath` would
  misfire on a search for the text `.env`. Residual boundary, stated rather than papered over: a
  `grep` that passes only a pattern and no `path`/`include` cannot be judged at this seam.
  `[L]`

- **`tools_in_request` was unobservable in a CLI run** (measured on 2.0.24): it was written only
  on `v2-shutdown`, and a CLI process never reaches dispose. It now rides the throttled
  `v2-surface` row too, which is the row a CLI run actually writes. `[L]`

- **The context-hook part inventory on 2.0.24** (measured 2026-10-06, three real turns with a
  probe plugin on `session.hook("context")`, plus a read-only scan of the host binary's
  `LLM.Content` union). Message shape is `{id, role, metadata, content:[…]}`; the part types
  that actually appeared, with their key names: `text` → `type,text,providerMetadata`;
  `reasoning` → `type,text,providerMetadata`; `tool-call` → `type,id,name,input,
  providerExecuted,providerMetadata`; `tool-result` → `type,id,name,namespace,result,
  providerExecuted,cache,metadata,providerMetadata`; `media` → `type,media,filename,metadata`.
  The binary's union also names `compaction` and `effort`, which were never observed in a turn.
  This is why the prune layer's first version was inert: it accepted only `type:"text"`, and the
  bulk of a real request is `tool-result`/`tool-call`. `[L]`

### 2026-10-07 — the 1.7.1 cut: the 75% trigger is gone, and why the readers stayed `[L][R][D]`

**Decision (user, 2026-10-07).** The early-compaction trigger shipped in 1.7.0 was removed
outright: the host owns when a conversation is summarized, and a plugin that summarizes a live
session on its own takes a context-losing action the user did not ask for. This is a
`[D]`+product decision, not a measurement — recorded here because the *other* two facts below
are measurements, and a future reader will otherwise look for a falsified claim that does not
exist.

**What was removed.** `src/host/v2-compaction.ts` (the whole layer: `applyV2EarlyCompaction`,
`resolveCompactConfig`, `CompactReport`, the `session.hook("context")` registration and the
`observeUsage` tap), the `onUsage` option on `applyV2EventFeed`, the `compact` input and the
`ctx.session.compact` capability row in `v2-capabilities.ts`, the `compact_*` counters on both
the `v2-surface` and `v2-shutdown` rows, the `v2-compact` trajectory line, the three
file-overridable registry keys (`compactTrigger` / `compactAtPercent` / `compactMinMs`), and
the `compact` seam on the test fake. An operator's `team-mode.jsonc` that still names those
keys now collects them as UNKNOWN keys (a boot warning), which is the honest outcome: a knob
whose feature is gone must not keep reading as if it did something. `[R]`

**What was kept, and it is not sentiment.** The four pure usage readers (`readUsedTokens` /
`readModelKey` / `lastUsageOf` / `percentOf`) moved to `src/host/v2-usage.ts` because
`src/host/v2-prune.ts` still computes ITS OWN threshold from the same formula and the same
`ctx.model.list()` → `limit.context` denominator. Copying them into the prune layer instead
would have left two definitions of "how full is this window" free to drift, and the evidence
below is the reason each branch of those readers exists. `[R]`

**The evidence that shaped them (unchanged, re-stated so it is not lost with the module).**
- Context usage lives ONLY in the `session.usage.updated` event. `session.hook("context")`
  hands over the assembled messages and those messages carry no token counts: a second turn
  that DID contain an assistant message still logged `source=no_usage messages=3` (run
  `r-20261005-235343-114738`). The denominator is `ctx.model.list()`'s `limit.context`; the
  numerator is the event. `[L]`
- The readers therefore accept every location the host has actually used (`tokens` /
  `metadata.tokens` / `info.tokens` / `usage`) and return `null` — never `0` — when they
  find none, because "we did not find them" and "usage is zero" must not collapse into one
  number. A model the catalog does not describe gets `percentOf` = 0, never a guessed window. `[R]`

**What 1.7.1 does NOT change.** The host's own compaction is still supported, not intercepted:
`TM_COMPACTION_CONTEXT` (the survival list on `session.hook("compaction")`) and
`TM_COMPACTION_AUTOCONTINUE` are untouched, `compaction_lines` still rides `tm_stats`, and the
`ctx.session.compact` seam stays declared in `src/host/v2-types.ts` with a "DECLARED, NOT
CALLED" note — a future layer would otherwise have to re-probe a seam the 2.0.23 probe already
settled. Context Pruning (`TM_PRUNE`, default 70%) is a different mechanism: it rewrites settled
message BODIES into pointers inside an outgoing request and never asks the host to summarize
anything. `[R]`
