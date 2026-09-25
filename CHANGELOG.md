# Changelog

All notable changes to `@te-river/opencode-team-mode` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning is semver (the 1.4.x train shipped under working labels; the
registry saw 1.5.0 as the install-script fix release).

## [Unreleased]

### Changed

- **`tm_*` are delivered as real tools by default on v2, after paying for the text
  first.** The decision was "slim the description, then go direct", and both halves
  happened: `tm_browser`'s description went from a narrative of every lesson to the
  things the model cannot recover from a result (729 tokens; its parameter table is a
  separate 1 337 of per-parameter truth), and `tm_pty` is no longer registered on v2 at
  all — with no `client.pty` in the plugin context the tool could only ever answer that
  its own seam is missing, which is a promise the surface should not make. What
  `options.codemode:false` now costs per request, measured through our own token口径
  after the request-layer trim: build-class specialists 2 660 tokens, tester 4 726,
  researcher 6 391, the lead 7 366. `TM_V2_CODEMODE=off` buys the tokens back and the
  boot note says which world is running, because in catalog mode the host keeps
  ≤120 characters of each first description line and most of our governance text is
  simply never delivered. The v1 prompt text that named `tm_pty` is forked to plain
  "one slow step per `shell` call" — and deliberately does NOT claim native background
  shell works, because #28 has not measured that round-trip yet.
- **The prompts no longer prescribe Chinese wording (user rule).** What the agent
  writes follows the language of the request; that was already the rule in
  `## Reply language`, but three prompt templates contradicted it by handing the
  model Chinese sentences to emit (`Only the first may become "浏览器已关闭" …`,
  `the other two are "窗口可能还在，请用户确认"`, `never write "该网站没有内容"`), and
  the `效率至上` heading gloss invited the same mirroring. All of it is now English
  prose — and what stays Chinese is Chinese on purpose: the tool's own verdict
  strings (`已确认关闭 / 进程未核验 / 警告：关闭未完全成功 / 无人应答 / 已合并 / N 个
  可寻址节点 / 域名不在白名单`) quoted verbatim, because those bytes ARE the evidence
  and a translated verdict is a claim nobody can grep for.  `test-blackboard` now
  scans every injected prompt and command template for Han characters against a
  CLOSED allowlist, so a new prescribed-Chinese sentence fails the suite and names
  itself rather than quietly becoming the product's behavior.
- **On v2, everything the plugin changes is now scoped to Team mode** (user
  requirement).  Every v2 hook fires for every session on the host, so the per-role tool
  trim, the 0.2 temperature, the board note, the compaction survival list, the native
  result offload, the R6/address permission strictening and the forced
  `background: true` each ask one shared question first — is this one of our six roles?
  `build`, `plan` and any agent the user installed are now left exactly as a fresh
  OpenCode would leave them.  A session also counts as ours once one of our tools serves
  it, since the host does not promise `agent` on every event; when it cannot be resolved
  the call is treated as NOT ours (isolation beats coverage) and counted, and
  `tm_stats` prints `作用域：我们 N · 他人 N · 未判定 N` plus what the last number means
  out loud — "没资格治理".  The boundary is stated in the boot notes rather than papered
  over: outside Team the red lines we inject do not apply either, so that floor is now
  explicitly the host's or the user's own config's job.
- **JIT coverage in Team mode is now every tool that role can call — and it is a
  number.** The governed name list grew from eight to thirteen (`websearch`, `edit`,
  `write`, `patch`, `question` joined the file/shell/web set), and the host's browser
  catalog is matched by the `browser_` **prefix** rather than by name — 45 tools today,
  and a list that has to be re-enumerated every release is a list that silently misses
  the 46th.  What made widening safe is that the decision to rewrite was never really
  about the name: an unrecognised result shape is still left byte-exact.  And the
  accounting now separates `本会话族共 N 次调用` from `治理面内 M 次` and `不在治理面 K 次`,
  printed by `tm_stats`, so "most tool calls are governed" is checkable — and can say
  what it missed instead of implying it caught everything.
- **On v2 the network policy is: no domain gate, address red line only.** The user's
  instruction is that nothing may be blocked on the network except sensitive and
  internal addresses.  On v1 the 22-host seed list was tolerable because a plugin
  could raise the host's per-request dialog; on v2 it cannot raise one, so an
  allowlist became a list of pages nobody can approve.  v2 now resolves its tool
  config from a copy of the environment with `TM_WEBFETCH_ALLOWED_DOMAINS` defaulting
  to `"*"` — an explicit user value still wins, and `createTmTools` gained an `env`
  option so that v1 keeps its shipped default inside the same process.  What still
  holds underneath, and is not configurable: link-local / metadata / reserved ranges
  are denied with no consent path, and private space (loopback, RFC1918, CGNAT,
  `.localhost`) is refused through our tools since there is no dialog to ask with.
  Verified against the built runtime: `https://example.com` — in no seed list —
  returns its page, while `169.254.169.254`, `192.168.1.1` and `localhost:3000` are
  refused before any request.  A v2 refusal may no longer promise "只能逐次经用户批准"
  without also saying the host cannot open that dialog.
- **`execute` (Code Mode) is now governed for output size, which is what JIT over
  the native browser means here.**  The Team's direct surface on v2 is six tools
  (`edit execute question shell subagent write`), so every `tools.browser.*`
  snapshot, tab list and evaluate result reaches the context window ONLY as the
  aggregate return of one Code Mode program.  Measured live: a 15,000-token program
  return arrived as `offloaded:true / preview_tokens:58` plus a `tm_fetch` handle.

- **`tm_read` / `tm_grep` / `tm_bash` are retired on v2, and the native file ladder
  takes their place with its governance intact.** The order AGENTS.md demanded was
  kept: `execute.after` offload and the `permission.evaluate` red lines landed
  FIRST, so deleting the aliases did not open a window with neither.  The half that
  would have been missed is the DENIES: v1's matrix refuses native `read`/`grep`/
  `glob` to every role (they were the shadow of the governed aliases) and
  `v2-session.ts` deletes anything the config denies — so projecting those rules
  onto a host where the aliases are unregistered would have left a role with no way
  to open a file at all.  `V2_LADDER_ACTIONS` now exempts them in both the triple
  translation and the removal plan, and group 3 of the v2 suite pins all three
  facts together (aliases absent, native ladder kept, `execute.after` attached).
  Nothing was lost on the red-line side either: v1's P2 path scope is the host's own
  `external_directory` permission action on v2, observed answering `effect:"ask"`
  with a real `permission.asked` behind it — a dialog where our code used to throw.
  The same commit drops permission triples for any v1-only action (so a boot can no
  longer write an `allow tm_read` rule the host cannot honor, and `mergeTriples`
  collects a stale one from an earlier boot), deletes the fs client shim that only
  those two tools used, and forks the v2 prompts through `V2_TEXT`: every sentence
  that named the trio, or called the shell tool `bash`, is rewritten or the build
  throws.  v1 keeps all three tools and its prompts unchanged.
- **On v2 the per-command R6 classifier is in charge; the blanket `shell → ask` is
  the fallback.** It was kept as the default only because no live host had been
  seen to call `permission.evaluate` for `shell`, and the probe now records exactly
  that (`{action:"shell", resourceCount:1}` for a real `git status --short`). A
  config that asks about every command would mask the hook the evidence was
  gathered for. Coarse remains reachable — `TM_R6_FINE_ASK=off`, or any host that
  does not expose `permission.hook` — and the boot note now says **which** of the
  two causes applies, since one message covering two causes is how a fallback gets
  mistaken for a setting.
- **`tm_ptc_run` is v1-only: v2 does not register it.** The host's own
  `execute` (Code Mode) already runs "one program, N tool calls, zero
  round-trips, only the aggregate entering the context", and a live v2 session
  both used it that way (`Promise.all` over `tm_webfetch` + three `tm_search`)
  and showed our governed results still come back as
  `offloaded:true / tokens:41511 / preview_tokens:79 / tm://…` handles. Shipping
  a second batch runner would hand the model two tools for one job, so v2
  registers twelve governed tools while v1 — which has no Code Mode — keeps the
  thirteenth. The module stays in the tree for the frozen v1 personality.
  `V1_ONLY_TOOLS` is now the single source: the v2 runtime skips those names when
  registering, and the generated `agents/*.md` drops their permission triples,
  because an `allow` for an action the host never heard of claims a capability
  that does not exist.
- **The v2 prompts no longer name a tool v2 cannot call.** Eight sentences across
  the lead and the shared rules told every role to collapse ≥3 probes into one
  `tm_ptc_run`; on v2 that is a mandate pointing at a missing tool, which costs
  exactly the round it exists to save. `scripts/gen-v2-config.mjs` now carries a
  `V2_TEXT` table of exact source strings rewritten to name `execute` (Code Mode)
  instead, and **it throws if a key stops matching**, so editing a prompt without
  updating the table fails the generator rather than silently shipping the stale
  sentence. This is the first use of the personality fork the
  `tm_read`/`tm_grep`/`tm_bash` retirement will need.

### Added

- **`docs/installation-v2.md` — OpenCode 2.x gets its own installation page** (#4).  The
  v1 guide is not a shorter version of the same job: on 2.x a plugin cannot create an
  agent, so the six roles and the six `/team-*` commands have to be GENERATED into
  `~/.config/opencode/agents/` and `commands/`, `default_agent` must be set after those
  files exist (a default naming a missing agent makes the host fall back to `build` with
  no complaint), and several v1 mechanisms simply do not exist — no plugin dialog, no
  `todowrite` (hence `tm_ledger`), no `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` to
  enable.  Both READMEs now point an installing agent at `opencode --version` first, and
  the v1 page opens by saying it is the 1.18.x path.  To make the documented command true
  for an INSTALLED copy, `scripts/gen-v2-config.mjs` is now in npm's `files` (verified by
  running the generator out of a copied-out package tree).  The 2.x branch in the
  installers landed in the same release line (see the installer bullet), with its
  not-yet-run-on-a-live-host status stated instead of smoothed over.
- **The installers have an OpenCode 2.x branch** (#10, #11).  `install.sh` /
  `install.ps1` detect the host major version and, on 2.x, run the three things only an
  installer can do: write the plugin entry, generate the six roles and six `/team-*`
  commands **from the installed package**, and write `default_agent: "team"` LAST,
  reading it back from disk with JSONC comments masked so a commented-out key cannot read
  as active.  If any role file is missing the default is refused, because a default
  naming a missing agent makes the host fall back to `build` silently.  v1's cache-purge
  and npm-re-resolve machinery is skipped on 2.x (it would delete a directory that host
  never loads from), and the `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` block is
  **forked, not deleted**: the v1 path is line-for-line what it was (both files are pure
  insertions — 392 and 425 added lines, zero removed), and the v2 path prints that the
  flag is not needed together with its undo command.  The version probe also asks the
  desktop app — `resources/opencode-cli.version`, then the bundled
  `opencode-cli.exe --version` — because a desktop install puts no `opencode` on `PATH`,
  so a PATH-only probe answers "not found" on a machine running 2.0.16 (verified on one).
  What is NOT claimed: this branch has not been run end-to-end on a live 2.x host — both
  scripts parse clean and the probe is checked against the installed version file, which
  is not the same statement — so `docs/installation-v2.md` says that out loud and keeps
  the manual steps as the verified path.
- **`tm_ledger` — the LEDGER rule finally has a place to live on v2** (#16).  The
  lead's prompt mandates the list before the work (every new ask becomes an item,
  an interruption is an insertion, `blocked` is a state and not an exit, a
  compaction resumes by re-reading the list), and v2 gives a plugin no
  `todowrite` to do that with — so the mandate was prose and `tm_join`'s goal
  tripwire had nothing to check.  The list now lives in the host's own
  `ctx.storage` (the domain the boot self-check proves by writing a marker and
  reading it back), keyed per session, with `add` / `doing` / `done` / `blocked` /
  `list`.  Four decisions worth naming: a repeat of the same ask is ONE item and
  says so; an `id` that matches two items is refused with both candidates printed
  rather than guessed; only the lead may use it (a specialist answers in STATUS —
  and because the v2 request layer knows a non-lead may not `tm_join`, the tool is
  not even offered to it); and a reply about the list says whether the write
  REACHED storage — a store that throws is reported as a failure, never as
  已记录, because goal #6 is exactly this class of lie.  `tm_join`'s goal tripwire
  now reads the same store, so a settled round on v2 gets a real
  `⚠ 目标未达成 …` naming the blocked item instead of `goal_unchecked reason=no_seam`;
  an empty ledger is its own answer (`ledger_empty`), never a silent pass.  v1
  registers nothing: the tool appears only when a host hands in a store, and the
  v1 personality is frozen with its own `todowrite`.
- **JIT context governance now covers the host's OWN tools.** The offload promise
  — an oversized tool result never reaches the context window; it lands in the run
  store and the model gets an ≤80-token preview plus a handle — held only inside
  `tm_*`, which is what made `tm_read`/`tm_grep`/`tm_bash` load-bearing rather than
  merely better. Governance therefore moved to the seam that does not care what the
  model picked: `tool.hook("execute.after")` sees every finished result, so
  `src/host/v2-offload.ts` reuses the SAME thresholds, preview builder, store and
  HMAC handles as the tm_* path and replaces an oversized text part with preview +
  `tm_fetch` handle. Verified on a live host: a native `shell` reading a 50 KB file
  produced `native:shell offloaded:true tokens:12902 preview_tokens:78
  ref:tm://runs/…/steps/s0001/result`, and the boot snapshot carried
  `native_offloaded:1 / native_tokens_saved:12824`.
  Deliberate limits, all tested: the governed tool list is CLOSED
  (`read grep glob shell bash webfetch`) because agent/patch/execute have result
  shapes nobody has observed and rewriting a shape you guessed at is content
  destruction; an unrecognized shape is left alone rather than interpreted;
  `metadata` and non-text parts (a screenshot) pass through untouched — dropping an
  image to save tokens is a bad trade; a governance throw degrades to the host's
  verbatim result; and `TM_NATIVE_OFFLOAD=off` restores the host's behavior, with
  the boot note saying whether the switch or a missing seam is why nothing is
  governed.
- **`src/host/v2-probe.ts` asks the running host what it actually exposes.** Every
  v2 decision up to now was made against a *description* of the host — and the
  type package this repo installs is 1.18.25 while the host that runs is 2.0.16,
  so reading node_modules could not answer "does `permission.evaluate` fire for
  `shell`?", "what are the native browser tools named?", or "does an oversized
  native `read` result reach `execute.after` at all?". The probe registers the
  same four hooks the guards do, mutates nothing, and records only NAMES: tool
  ids, agent ids, action ids, an input's key names, the count of resources plus
  whether any parses as a URL. It never writes a resource value, command line,
  path or env face — the R6 privacy 口径 applies to a diagnostic too, and a probe
  file that leaked the user's commands would be a worse bug than the one it
  answers. `TM_V2_PROBE=<file>` adds a JSONL dump; without it the name sets still
  fill and a throttled snapshot rides the trajectory as `v2-surface`. Two lessons
  are encoded in its shape because both were hit while writing it: a snapshot has
  to be taken **while the process is alive** (the first version only wrote from
  `dispose`, and a run that gets interrupted never reaches teardown — one live run
  left a boot line and nothing else), and the probe has to report **whether it was
  listening at all** (`probe_target`), otherwise "the host has no browser tools"
  and "nobody handed me an env var" are the same answer.
- **On v2 every sub-agent dispatch runs in the background.** A foreground
  `subagent` call blocks the lead for the child's entire run, which is the one
  thing the throughput mandate cannot survive, and on v2 background needs no
  environment flag at all. So `applyV2BackgroundForce` sits on the mutable
  `execute.before` input and sets `background: true` — overriding an explicit
  `false` and the `"True"` string form alike — and leaves an input that is not an
  object alone rather than inventing one. v1 keeps its opt-in flag because there
  the host genuinely rejects `task {background:true}` without
  `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`.
- **The egress red line now covers the host's own web tool.** Native `webfetch`
  on v2 has no notion of `169.254.169.254` — the cloud metadata endpoint whose
  response is temporary credentials — and it is available to agents we do not
  configure, so the red line that `checkWebUrl` enforces inside `tm_webfetch`
  was bypassable simply by not using our tool. `src/host/v2-guard.ts` asks the
  address question at `permission.hook("evaluate")`, independent of R6:
  metadata / link-local / reserved is **denied with no consent path offered** (a
  credential leak is never consentable), IPv4-mapped and DNS64 carriers are
  unwrapped before the policy reads them, loopback and RFC1918 fall to the
  host's own `ask`, and a URL pointing at an env file is denied. The hook only
  ever makes a decision **stricter** — a user rule that already denied is not
  softened back to ask.
- **R6's per-command classifier is installed but not trusted yet.** v2's closest
  equivalent to v1's pattern-object escalation was "ask on every shell command",
  honest but coarse. The classifier now rides the same `evaluate` hook and counts
  what it sees, yet the coarse config-level escalation **stays on** until a live
  host proves `evaluate` is actually called for `shell` — a guard that fails open
  because we assumed an unproven hook is the opposite of this product.
  `TM_R6_FINE_ASK=on` hands shell to the classifier; with the hook absent the
  coarse path wins regardless.
- **The six `/team-*` commands work on v2, as config files.**
  `ctx.command.transform.add` was measured NOT to reach the UI on 2.0.16, so the
  commands take the same route the roles now take:
  `~/.config/opencode/commands/<name>.md`, frontmatter `description` / `agent`,
  body = the template. v2 expands `$ARGUMENTS` and `$1..$n` exactly as v1 did, so
  the templates port verbatim — and the generator (`scripts/gen-v2-config.mjs`,
  renamed from `gen-v2-agents.mjs` now that it emits both) reads them out of
  `dist/commands.js`, so nobody can edit one file and silently leave the other
  behind. Pinned by `test-v2-adapter` group 8: twelve files, the lead's
  `mode: primary` and the specialists' `subagent` deny triples, a body that is
  the real prompt rather than a paraphrase, no `template` key in frontmatter
  (the docs forbid it), a re-run that writes nothing, and a hand-written
  `team.md` refused rather than clobbered. **One thing this cannot verify from
  here**: v1 runs `/team-plan` as `agent: architect`, while v2 documents
  `mode: subagent` as "runs only in a child session" — if the live host refuses
  that, the fix is `mode: "all"` in `src/agents.ts`, since T3 is held by the
  `subagent: deny` rule and not by `mode`.
- **On v2 the whitelist now decides what the model is OFFERED, not just what it
  may call.** A permission `deny` on 1.18.x stopped the call but left the tool's
  description and schema in every request, so a role paid tokens for capabilities
  it was forbidden to use — measured offline against dist/ at 9 528 tokens across the
  thirteen governed tools alone, before the host's own catalog. v2 can `delete
  event.tools.<name>` inside `session.hook("context")`, so `src/host/v2-session.ts`
  now removes every denied tool from the assembled request: native
  `read`/`grep`/`glob`/`list`/`edit`/`write`/`shell`/`webfetch`/`websearch`, the
  denied `tm_*` doors, and — where `tm_browser` is denied — the host's entire
  `browser_*` catalog as well. Only a literal `deny` removes; an `{"*":"ask"}`
  entry means "callable, gated" and stays offered, or the dialog would have
  nothing to gate.
- **Two v1 behaviors that had no v2 home got one.** `temperature` 0.2 rides the
  request (it is a documented legacy agent field on v2 and the runner "preserves
  these values but does not yet send them"), and the resolved blackboard root
  goes into the lead's system parts per request — a v2 agent is a config FILE, so
  it cannot carry a per-workspace path the way v1's config hook could. Neither
  overwrites what is already there: a temperature the request already carries (a
  user's model variant) outranks our default, and the note and the compaction
  survival list land once even though the host reloads plugins in-process and the
  hook runs before every single model call.
- **v2 starts the blackboard TTL sweeper it previously lacked.** The workspace
  note the lead receives promises "the plugin sweeps task directories idle for
  more than N days (at startup and hourly)". On v2 nothing called
  `startBlackboardMaintenance`, so that promise was false — and a cleanup claim
  with no mechanism behind it is the same overstated "done" this product exists
  to refuse. It now runs, unref'd and idempotent as on v1.
- **Team is the default agent on v2 only through the installer's config key — the
  plugin cannot do it, and now says so.** An earlier draft of this entry claimed
  `editor.default("team")` promoted Team on every boot and called it live-verified.
  A controlled experiment falsified that: with `default_agent` set to `build` in
  `opencode.jsonc`, a standalone boot ran the promotion without error and the key
  stayed `build`, while `editor.get("team")` returned nothing both before and after.
  The reason showed up in the same probe — `ctx.agent.transform` receives the agent
  set from BEFORE the config directory merges, so the editor holds only the seven
  built-ins, and any look-up of our roles is a look-up at a snapshot.  `agent.reload()`
  to force a second pass changed nothing the callback could see.  Two consequences,
  both handled: the promotion is attempted regardless (reading a missing `get()` as
  "the role does not exist" had been silently suppressing it in the ordinary case),
  and an unverified promotion is reported as unverified with the pointer that does
  work — the installer writes `default_agent: "team"`.  The boot record carries
  `called-unverified` instead of a confident `team`.  One boundary unchanged by any of
  this: `default_agent` does not rewrite the agent already stored on an existing
  session, so an old conversation still opens as Build.
- **`scripts/gen-v2-config.mjs` projects the six roles into v2 agent files.** A
  v2 plugin cannot create an agent — `AgentEditor` exposes only
  `list/get/default/update/remove` — so the roles have to reach the host the same
  way the built-in Build and Plan agents do: `~/.config/opencode/agents/<name>.md`
  (or the `agents` config key). The generator reads `dist/agents.js` rather than
  copying any prompt text, so the markdown body is the same string the v1
  personality injects, `REPLY_CONTRACT` and `SHARED_RULES` included, and the
  permission triples come from `triplesFromAgentPermission` — the same
  translation the runtime applies, which is what keeps the two from drifting.
  Running it against this repo's roles is also what proved the T3 invariant
  survives the projection: `team` gets `subagent: allow`, all five specialists
  get `deny`. Files it did not generate are refused unless `--force`, and
  `--print` previews without writing.
- **`tm_stats` now answers "which half of the plugin is running, and what did it
  see".** The v2 boot record was written to the trajectory and never read back,
  so "the plugin loaded" stayed a claim the user could not check from inside a
  session — and the question the v2 line actually needs answered (does
  `permission.evaluate` fire for `shell`? that is what gates retiring the coarse
  `shell → ask` escalation) is only observable as a *count*, which exists in the
  process and vanishes with it. v2 now writes a `v2-shutdown` line carrying the
  guard's per-action tally, the shell-classifier hit count, how many `subagent`
  calls were forced to the background, and how many tools were removed from
  requests, and `renderStats` prints the newest four boot/shutdown lines under
  `启动与人格` — including what the personality said was *missing* (`agents_missing`,
  `tools_missing`) rather than only what it said was present.

### Fixed

- **Our governed tools never reached the model as tools.** Reading the 2.0.16
  binary for something else turned up the switch: tool visibility is decided by
  `options.codemode`, and a tool whose value is not `false` is offered ONLY through
  the Code Mode catalog, where the host keeps ≤120 characters of the description's
  first line. `bindV2Tool` never sent `options`, so every `tm_*` was catalog-only —
  callable from inside `execute`, and with almost none of the governance text we
  wrote for it (the offload contract, the handle rules, the close verdicts, the
  "don't retry removed tools" boundary) ever arriving. That is the real explanation
  for a live session that registered thirteen tools and then showed the lead six
  tools and zero `tm_*`. `TM_V2_CODEMODE=direct` sends the flag, and the cost is
  measured rather than argued — per role, after the request-layer trim: build-class
  specialists 2 660 tokens, tester 5 448, researcher 7 113, the lead 8 515 (of which
  `tm_browser` alone is 2 788). The default is unchanged until that trade is decided;
  what changed is that the boot note now says, in both directions, which world this
  process is delivering.
- **A role denied `tm_browser` could still browse on v2.** The host's 45 `browser_*`
  tools share one permission action named `browser` and never appear in the direct
  tool surface, so deleting `browser_*` from `event.tools` removed a catalog the
  assembled request did not contain — while the role kept reaching every one of them
  from inside `execute`. The whitelist now also projects
  `{action:"browser", resource:"*", effect:"deny"}` for exactly those roles: the only
  lever that speaks the host's name for them, since what was broken here was goal 5's
  network-role restriction, not a nicety.
- **A `ctx.storage` self-check that never ran is `declared`, not `not-seen`** — and
  one that threw or read back something different is `missing`, not `not-seen`
  either.  `not-seen` means "registered, the host hasn't called it", so wearing it
  for a failed probe hides exactly the fact the LEDGER (#16) depends on, and
  wearing it for an untried domain understates a seam that is there.  The row now
  reads `round-trip → ok`, `absent / threw / read-back-mismatch → missing`,
  nothing-yet → `declared` when the domain exists.
- **The v2 no-dialog refusal no longer points at a domain allowlist that v2 does
  not run.**  With `TM_WEBFETCH_ALLOWED_DOMAINS` defaulting to `"*"`, telling the
  agent to "改用白名单内的源" sent it looking for a gate that was never the reason,
  and stayed silent about the one red line that has no consent path at all (the
  metadata / private-range address policy).
- **The lead's delegation mandate names `subagent` on v2, not `task`.** Same defect
  shape as the `tm_ptc_run` fork: a rule pointing at a tool the role cannot call
  costs exactly the round it exists to save.  The name is from measurement, not
  inference — a live dispatch reached `execute.before {tool:"subagent"}` and
  `permission.evaluate {action:"subagent"}`.  Two more v1-isms went with it: the
  instruction to pick "a plain synchronous `task`" (on v2 the plugin forces
  `background: true` on every dispatch, so that is not a choice the model has) and
  the sentence telling the lead that background needs
  `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` (it does not exist here, and a
  lead that goes looking for it wastes a turn checking a switch that was never
  needed).  `V2_TEXT` throws if a key stops matching, so editing the lead prompt
  without updating the table fails the generator rather than shipping the stale
  sentence.

- **`tm_join` now says when the goal check COULD NOT RUN.**  The tripwire read the
  host todo list only `if (settled && typeof api?.todo === "function" && parent)`,
  so on a host without that seam — v2's client shim has no `session` domain at all —
  a settled round carried no goal statement whatsoever, and silence reads as
  "checked and clean" precisely at the moment a lead is deciding to wrap up. Two
  more details of the same class: the escape hatch told the lead to call
  `todowrite`, a tool v2 does not expose (the third instance of a mandate pointing
  at a missing tool, after `tm_ptc_run` and `task`), and a throwing endpoint was
  swallowed indistinguishably from an absent one. There are now three sayable
  outcomes — checked-and-open names the items, checked-and-clean says nothing, and
  unchecked states which of the two failed (`goal_unchecked` with
  `reason: no_seam | endpoint_failed`) and refuses to let `所有子代理已结算` stand in
  for `目标已达成`.

- **The sub-agent envelope is now recognised in the shape THIS host emits, and the
  counter that hid that is fixed.**  Read out of the host's own result mapping
  (read-only; the binary was never touched), v2 wraps a child's reply as
  `<subagent sessionID="…" state="completed">…</subagent>` — and, for the background
  completion, with a `description="…"` attribute and a dynamic `state`.  The v1
  string `<task id=` occurs **zero times** in 2.0.16, so `parseTaskEnvelope` could
  never fire there: every metric said `task_envelopes: 0`, which read as "no child
  reply was big enough" and actually meant "the matcher is for another host".  That
  is the fail-loud rule turned on our own telemetry, and it was the reason a real
  gap was argued as closed.  `parseHostEnvelope` now recognises both spellings, the
  offload of a `subagent` result **reproduces the wrapper and swaps only the body**
  (the sessionID inside it is the pointer the lead needs, and the host/UI key on
  that element), and a `state="error"` child is deliberately left alone — hiding why
  a child failed to save tokens is the wrong trade.  `native_envelopes` (recognised)
  is reported beside `native_offloaded` (rewritten) so the two can never be confused.
- **A probe hook body can no longer break the request it observes, and says so when
  it throws.**  One of these callbacks referenced a `const` declared further down the
  module, so it hit its temporal dead zone while the host was mid-hook: the shape
  recorder reported nothing, and the missing data was being read as a fact about the
  host rather than a crash in the observer.  Every callback is now wrapped — the
  throw is swallowed and recorded as `session.context:callback-threw`, which is also
  what the message-shape recording needed to be trusted.  Related: the envelope scan
  walked `JSON.stringify(parts)`, whose escaped quotes mean an envelope never
  matches its own parser — it reads each part's `text` now, which is how the real v2
  message shape (`{info, parts[]}`) finally showed up.

- **The v2 surface probe now records the `ctx` domains and the shape of the message
  list**, because two open decisions were being argued from assumptions.  What it
  measured on a live 2.0.16 host:
  - the context carries **21 domains including `event`, `session`, `mcp`, `rpc`,
    `storage` and `websearch`** — so rebuilding `tm_join`/Plan B on v2 has a real
    door, and "the host gives us nothing" is not the reason it is unwritten;
  - a `subagent` dispatch reaches all three seams (`execute.before` with
    `{agent,background,description,prompt}`, `permission.evaluate action=subagent`,
    `execute.after` with `{content,metadata,output}`), so a synchronous child's
    reply is governable exactly like a native `shell` result — `subagent` joins the
    closed governed list;
  - nested `tm_*` calls made **inside** a Code Mode program each produce their own
    `execute.before`/`execute.after` pair (`execute.after tm_read {content}`), so
    one hook governs both worlds rather than only the aggregate;
  - but `session.hook("context")` showed 0–1 messages and **no
    `<task id=… state="completed">` envelope in any observed run**, so v1's
    `chat.message` offload has NO anchor on v2.  Since v2 forces every dispatch to
    `background`, the child's report arrives through a channel this plugin has not
    yet been shown to see — which is recorded as a gap rather than papered over with
    a rewrite against a guessed message shape (the same reason
    `host-hooks.ts` refuses `experimental.chat.messages.transform`).

- **`tm_join` no longer reports "there is nothing to adopt" on a host it could not
  query.**  Three outcomes collapsed into one sentence: the host surface is absent
  (v2's client shim exposes only `file.read`/`find.text`, so there is no
  `session.children`), the call failed, and "we asked and the tree had nothing".
  The empty-round answer asserted the third — `宿主会话树里也没有可认领的子会话` — in all
  three cases, which is a claim about the host's session tree that nobody measured.
  A lead that believes it stops waiting for a report that exists, i.e. the exact
  silent loss the adoption path was written to prevent.  `adoptFromHost` now returns
  `{adopted, looked, why}` and the sentence is chosen from it: an unqueried tree says
  so and names the missing seam, a failed query carries the host's own error text,
  and a genuinely empty tree keeps the old confirmed wording.  The reason text names
  the missing SEAM rather than "v2", since the same absence occurs on a v1-shaped
  client without `session.messages`.

- **The store-shard reclaim pass could not fire for the users who needed it.**
  Sharding moved each non-git workspace's store to `<tmpdir>/opencode-team/w-<hash>`
  and added a boot prune for siblings idle past the TTL — but the call passed
  `sharedBase`, which inside a repository is `<repo>/.git/opencode-team` (a directory
  that can never contain a shard), *and* skipped the pass unless the current
  workspace was non-git.  Two independent reasons for the same outcome: someone who
  works mostly inside repositories booted the plugin in a git workspace every time
  and so never swept the bucket their throwaway sessions had been filling — 2,067
  orphaned directories on the machine this was found on.  The prune now names the
  tmpdir bucket explicitly (the way the legacy-bucket reclaim already correctly did)
  and takes `keep: null` to mean "this workspace has no live shard", so the TTL — not
  the current workspace's identity — is what spares a session in another window.
  Proven end to end: a boot in a sandboxed git workspace removes a 40-day-old shard
  and keeps a fresh sibling.
- **The test runner no longer grows the developer's Temp bucket.** Overriding
  `TM_BLACKBOARD_DIR`/`TM_TRAJECTORY_DIR` redirected only those two trees, so every
  throwaway workspace a suite created still left a permanent `w-*` shard in the real
  bucket — and `TM_STORE_RECLAIM=off`, added precisely to keep tests out of that
  bucket, is also what stopped anything cleaning it up.  Children now get the run's
  sandbox AS their `TMPDIR`/`TEMP`/`TMP`, so run stores, shards, browser profiles and
  memory mirrors all live inside the directory the runner deletes at exit.  Measured:
  2,067 → 2,067 shards across a full run (was ~+16), and serial wall time fell from
  ~130 s to ~49 s — the bucket was being scanned at boot, so the leak was slowing
  every session, not just occupying directories.
- **The prompts stopped promising Markdown the host does not render.** The
  presentation sections told every role that replies support footnotes and KaTeX
  `$…$` / `$$…$$`, and that mermaid is NOT drawn. Measured against the host's
  renderer, all three claims are wrong: `$`-math and `[^1]` footnotes arrive as
  **literal text**, while `mermaid` draws (11 diagram types pass). The first two
  are the worse kind of stale claim — an agent that trusts the prompt ships a
  reply whose structure the user reads as backslash noise, and nothing in the
  session says the tool lied rather than the model. `## Presentation`
  (shared rules) and `## Output shape` (lead) now carry the **negative** half of
  the measurement: `==highlight==`, footnotes, a lone `---` rule and `<hr>`,
  definition lists, `~x~`/`^x^`, `$`-delimited math (inline math takes
  backslash-parenthesis), an image wrapped in a link, `:short_code:` emoji and an
  unescaped `|` in a table cell are each named with the shape to use instead, and
  mermaid is offered as a real artifact while the screenshot stays the answer to
  "what does this page actually look like". The rule behind the list is stated in
  the lead's words: a shape you did not confirm renders is a defect you shipped.
  `README.md` / `README.zh-CN.md` carried the same false claim ("the host does not
  draw mermaid") in the feature table and now describe the measured set instead.
- **An engine that stops listening is now refused, not just described.**
  `dupe-guard` has reported `collapse` (same result set, different question)
  since 1.5.x, and a live session showed the advisory form does not work: the
  counter climbed 2 → 3 → 4 → 5 → 6 while the model kept rephrasing at bing,
  ending at ≈50 `tm_search` calls and 424K input tokens for a three-term lookup.
  Past `DUPE_BLOCK_AFTER` (3 collapses in a row) the engine is refused outright —
  in the explicit path before any fetch, and in the `auto` route by dropping that
  leg so the remaining engines still vote. The streak resets when the result set
  changes, so one bad stretch cannot mute an engine for the life of the process.
  The only escalation a model cannot skip is not making the call.
- **`tm_browser` is no longer a searchable-by-loop escape hatch.** The same
  session opened roughly thirty search-results pages through the browser instead
  of calling `tm_search` once — each costing a round trip plus a snapshot budget,
  and each returning a worse list than the fused one the governed front would
  have produced. `src/tm/serp-loop.ts` recognizes a SERP URL by its engine host
  and `/search` path shape, and after `SERP_NAV_LIMIT` (3) visits to the same
  engine with the same query refuses the navigation and names `tm_search` as the
  next move. The first few still pass on purpose: bing's HTML is sometimes an
  anti-bot shell, and then a real browser genuinely is the only way through.
- **The v2 argument table for `tm_join` / `tm_pty` / `tm_stats` now says what
  its parameters are.** Those three build their `args` without zod, so the shape
  reaches the v2 adapter as `{ key: { descriptor: "name: type (guidance)" } }`.
  Handed to `z.object()` it threw
  `undefined is not an object (evaluating 'schema._zod.def')`, the adapter caught
  the throw and returned `{additionalProperties: true}` — so the model saw three
  tools with **no parameter guidance at all**, which is the round-trip cost the
  descriptor exists to prevent. The adapter now recognizes the descriptor shape
  and derives a JSON Schema from it. Deriving it the obvious way was still
  wrong: the type was read off the first token of the whole line, which is the
  parameter NAME plus its colon (`ids:`, `action:`, `runs:`), so every enum,
  array and number flattened to `string` and the schema looked populated while
  teaching nothing. The type is read from what follows `name:` and the guidance
  text is kept verbatim as the description. `inputSchemaFor` also reports
  `source`, and the boot log names the tools whose table was **derived from a
  descriptor** rather than translated by zod — `exact` is true for both, but
  they are not the same claim.

## [1.6.0] - 2026-09-25

> The architectural change 1.5.13 held `1.6.0` back for: the plugin-side
> dispatcher is gone, and delegation belongs to the host. Everything merged on
> `main` since 1.5.15 ships in this release.

### Added

- **A wait has to be said out loud.** From the outside, a lead parked in
  `tm_join` and a lead that finished look identical — the tool call is one line
  the user cannot open. So the lead must now state, before any blocking
  collection and again whenever it ends a turn with children open, who is still
  working and that the task is not delivered. `tm_join`'s unsettled header
  carries the same instruction at the moment of
  decision (a prompt rule thousands of tokens earlier is not the same thing),
  and the compaction must-survive list now records uncollected children as a
  **not-finished state**, so a summary mid-wait cannot leave the lead believing
  it had delivered.
- **The installers now enable the host's visible sub-agent for you.**
  `task { background: true }` is the only sub-agent OpenCode can show (its card
  links to the live child session, it does not block, and the host wakes the
  parent on completion), and it rides an experimental host flag a plugin cannot
  set: `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`. `install.ps1` writes it at
  user scope (`-NoBackgroundSubagents`, or
  `TEAMMODE_SKIP_BACKGROUND_SUBAGENTS=1`, opts out; the revert command is
  printed), `install.sh` uses `launchctl setenv` / `systemctl --user
  set-environment` where they exist and otherwise prints the `export` line.
  Without it nothing breaks — `task` simply blocks the lead, and `tm_join`
  still collects whatever children exist.
- **Built-in tool arguments the host rejects now get repaired**
  (`src/tool-coerce.ts`). Live evidence: a lead following our own advice burned
  two `task` calls — `"background": "True"`, then `"background": "true"` —
  before it sent a real boolean, because the host's schema is `Schema.Boolean`
  and models serialize booleans as text. Same mutable-args surface as the bash
  timeout clamp: one known boolean per known tool, only the strings true/false
  convert, anything else left byte-exact, an omitted flag never invented — and
  the repair is counted in `tm_stats`, because a silent fix would hide how often
  the host would have failed the call.
- **`tm_stats` counts every background-task envelope it sees**, not only the ones
  it rewrote. A counter that moves only on a rewrite cannot distinguish "the
  channel is alive and nothing was big enough" from "a host upgrade stopped
  routing injections through `chat.message`" — and the second is the one that
  would otherwise go unnoticed.


- **The host's own visible sub-agent, inside our token budget.** OpenCode's
  built-in `task { background: true }` is the only delegation the interface can
  SHOW — its card links to the live child session, it does not block the lead,
  and the host wakes the parent when the child finishes. It is gated behind
  `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` (operator-set; a plugin
  cannot reach the host's own flags). The catch is that the wake injects the
  child's FULL reply into the parent session. `TM_TASK_OFFLOAD` (default on)
  takes the other half of the deal: `src/task-offload.ts` rewrites an oversized
  injection into a preview plus a `tm_join { ids: [...] }` pointer, under three
  locks that must all hold — the part is `synthetic` (a message you typed never
  is), the text matches the host's own `<task id=… state="completed">` envelope
  exactly, and the body is over the text offload threshold. Nothing is copied to
  disk; `off` restores the host's verbatim text; every rewrite is counted, and
  `tm_stats` prints the count with an explicit warning when it is 0 — because a
  host that stops routing through `chat.message` would otherwise look exactly
  like a quiet day.
- **`tm_join` can collect a host `task` child by explicit id** (parentage read
  back from the host, never assumed). That is how the lead gets the whole reply
  after we replaced it with a pointer; automatic adoption from the session tree
  still requires our ` ·tm` marker, so a `task` child is never claimed on
  speculation.
- **Delegation now has a routing rule, not a preference.** The lead picks
  `task { background: true }` when several independent children run at once AND
  it will keep working meanwhile, and a plain synchronous `task` when its very
  next step needs that answer in hand — "background for anything else" was how a
  lead ended up parking on a single child it could not act on until it landed.
  The same split now decides which `task` footer the host shows the model
  (`tool.definition` reads `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` the way
  the host does, so the hint cannot advertise a shape the host would reject).
- **tm_browser can hold several tabs.** `new_page { url? }` opens a tab and
  makes it current; `close_page { index? }` closes one and moves you to a
  survivor; `list_pages` numbers them and `select_page` switches. The new tab
  clears the SAME allowlist gate and official dialog as any navigation, so a
  second tab cannot become a way around consent, and closing the LAST tab says
  the browser is still running instead of implying the session ended. Both are
- **One browser per agent, addressed by an id.** Three agents carry
  `tm_browser` (lead and researcher for the web, tester for UI verification) and
  host `task` children run in the SAME plugin process — so they shared one
  window, one "current tab" and one uid registry. `SnapshotIndex.annotate`
  clears and renumbers from `e1` on every snapshot, which means A's
  `take_snapshot` invalidated every uid B was holding, and B's next
  `click { uid }` landed on a different element while still reporting 已点击.
  Nothing in the reply could show it, because it was the same browser and the
  same page. Each caller now holds a LEASE: `open` returns an id (`b1`) and that
  window — its own uid numbering, its own current tab, its own dialog-approved
  hosts — belongs to that caller's session. Every reply is prefixed with the id
  it ran on, so the model is never without it. The id is required as soon as it
  could mean more than one thing (a single live browser that is yours may be
  omitted), and an id is a NAME, not a capability token: another agent's is
  refused with the owner named, because `b1` is guessable and guessing is
  exactly what must not work. `close { id: "all" }` closes every browser the
  CALLER owns and never anybody else's; the idle reaper is per lease, so one
  agent going quiet neither keeps another's window alive nor closes it mid-flow;
  a dead instance drops only its own lease; `dispose` closes all of them.
  Dialog-approved hosts moved from one process-wide set to per-caller — consent
  the user gave one agent is not a pass for another (pinned: the same document
  request continues for the approver and aborts for everyone else). A host that
  passes no sessionID keeps the old single-shared-browser behaviour, because
  then there is only one caller to confuse.
- **The blackboard finally has a write side: `tm_board_write`.** The board is
  where an oversized deliverable is supposed to go, and reaching it required a
  file tool — which `architect` and `researcher` do not have: no `write`, no
  `edit`, and no `bash` even to create the session folder the documented layout
  needs. So every "write the design doc to the board" dispatch from those two
  roles ended the same way, `BLACKBOARD WRITE FAILED` followed by the whole
  document pasted inline — the reply shape this team exists to enforce was
  un-followable for exactly the roles that produce the longest artifacts. The
  tool places ONE new Markdown file under the board root, chooses
  `NN-<role>-<topic>[-rN].md` itself, and NEVER overwrites: a revision is a new
  round-suffixed file, because the board's history is the audit trail the lead
  reads back. The role in that name comes from the host's `ctx`, not from what
  the caller claims, and the reply is a path plus a byte count — the content
  does not ride back through the context window, which is the point. It is
  scoped rather than polite: segments sanitized, target realpath-verified
  against the root (a symlinked task dir is refused before a byte moves), the
  name always ends in `.md` so no `.env`/rc file can be produced,
  `TM_BOARD_MAX_CHARS` refuses instead of truncating, and `TM_BOARD_MAX_FILES`
  caps a session folder with a refusal that names the TTL sweeper as the only
  reclaim path. All six roles carry it.
- **`tm_webfetch` now asks for Markdown before HTML** on the page-GET path, and
  the reply says which one arrived. Measured on the user's own connection, three
  samples per host: `learn.microsoft.com` answers the markdown-preferring header
  with `text/markdown` at **11 449 B where the browser-shaped request gets
  60 778 B of HTML** — a 5.3× cut on a seeded documentation host, for free.
  MDN, docs.python.org, `cn.bing.com`'s SERP, csdn and zhihu return the same
  document either way, so the preference costs nothing where it is ignored, and
  the header's browser-shaped tail (`image/avif`, `image/webp`) is left
  byte-identical because that shape is part of the fingerprint the UA disguise
  buys. `tm_search`'s engine legs keep the old default verbatim — the 2026-09-14
  anti-bot benchmark calibrated that exact string, and a SERP is not a document.
  One page keeps ONE cache entry (the sharing is pinned); the reader routes on
  the stored content-type instead of assuming the format it asked for.
- **`tm_search` states the date it ran on, and no prompt may hard-code one.**
  ZCode re-renders its search description (`get description()`) for exactly this
  reason: a long-lived desktop process that baked "the current month is
  September 2026" into a string at startup keeps serving that sentence into
  November, and a stale anchor is worse than none — the model trusts it.  We
  cannot copy the surface (the plugin has no evidence the host re-reads a tool
  description after registration, which `capabilities.ts` would grade
  `unverified`), so the date rides the one thing we render per call: the hit-list
  header — on BOTH renderers, the per-engine one and the `auto` fused one, which
  builds its own line (that split is the drift this repo keeps getting caught
  by).  ~20 tokens per search.  A new `test-blackboard.mjs` guard fails the
  suite if any injected agent prompt or command template ever contains an
  absolute date.
- **A blocked script host now has a way out that is not an env edit.**
  `tm_browser { action: "allow_host", host }` takes ONE bare domain (a wildcard, a
  URL, a path or a port is refused as an argument error before any dialog), puts it
  in front of the host's official confirmation dialog as that exact string, and
  files the grant under the calling session's browser for the length of the session
  — nothing is written to any config, one agent's approval is still not another's
  pass, and a host already on the static allowlist is answered 不用批准 rather than
  turned into a dialog the user can learn nothing from. Re-navigating afterwards is
  part of the reply, because the gate decides per request. Before this, the only
  remedy for a page our own gate had blanked was "ask the user to edit an env var
  and restart" — which no agent can do mid-task, so it reported the site as empty.
- **Two rules now sit in every role's prompt: 效率至上, and your language is the
  user's.** The efficiency mandate (`## Efficiency first` in the lead, the same
  duty inside `SHARED_RULES`) prices work in ROUNDS rather than in diligence: one
  wide call beats three narrow ones, independent calls batch into the same round,
  ≥3 probes collapse into a single `tm_ptc_run`, and a step is never re-run just
  to watch it pass again — with its boundary written next to it, because an
  efficiency rule that outranks the evidence rule is exactly how an unverified
  "done" becomes the cheap option.  The language rule came out of a measurement,
  not a hunch: the prompts are English (13 Chinese lines in `src/prompts/`, every
  one of them QUOTING a tool string), while 555 Chinese literal lines in `src/tm/`
  flow into the context on every tool call — so an agent mirrors the tool and an
  English request came back in Chinese.  The reply is now written in the language
  of the user's own message, and a Chinese string is quoted VERBATIM only where it
  IS the evidence (a close verdict, a refusal line, 无人应答), because a translated
  verdict is a claim nobody can re-check.  Localising those 555 strings was
  weighed and left as its own item: it would rewrite ~414 test assertions that pin
  the exact sentences users see, and the prompt rule costs none of them.
- **A forgotten browser window is now reported, not hoped away.** The complaint
  was that agents forget to `close`, and the existing answers were all
  faith-based: a line in the tool description (which a long-lived host never
  re-reads — the same finding that moved the date onto the search header), and a
  180 s idle reaper that fixes it *after* the user has been staring at the
  window. Three layers now, cheapest first:
  1. `open` states the duty in its own reply, with the real number
     (`用完必须 action:"close"…空闲 180s 我会替你关掉`), and says 没有空闲回收
     instead of promising a cleanup when `TM_BROWSER_IDLE_MS=0`;
  2. the reply contract gained a section for *things the user can still see* —
     a role that opened a window must carry the tool's own verdict in EVIDENCE
     (已确认关闭 / 进程未核验 / 警告) or name why it is left open, because the
     skeleton is the one moment the agent is forced to ask itself whether it is
     finished;
  3. `tm_join` reads the browser's live lease table (new `leases()` seam, one
     shared instance so there is no second source of truth) and appends
     `⚠ N 个浏览器还开着（子代理已结算，但它没 close）` with the id, the owning
     role and how long it has sat — the same tripwire shape as the goal check,
     because a settled child holding a window is a fact, not a suspicion.
  The lead's enforcement list gained the matching duty: bounce such a reply once
  instead of relaying "已关闭" the tool never said.

### Changed

- **`TM_JOIN_MAX_WAIT_MS` default 300 000 → 60 000, and chained waits are cut
  short.** A live session parked twice in a row for five minutes each — 19 of
  its 26 minutes spent inside `tm_join` with zero output — while the tool's own
  closing line ("可再次 tm_join") invited the next park. Waiting is not
  parallelism: your turn is blocked either way. A second wait after nothing
  settled now costs 10 s and is answered with the three things worth doing
  instead, and the lead's total blocked time became a measured row in tm_stats.
- **The goal tripwire no longer traps a lead that has finished.** It fires when
  the host's todo list still has open items, which is right — but a lead that
  just collected every child and has not re-marked its list got "不要把这轮当成收尾"
  for a stale list. The line now says to update `todowrite` first if the items
  really are done.


### Removed

- **`tm_dispatch` is gone; every agent is denied it and the tool is not
  registered.** It existed because the host's `task` blocks the lead, and it
  bought real overlap — but the children it created were sessions the user could
  neither open from a card nor stop from the interface. A lead-side
  `tm_join { cancel: true }` is not the same thing as the user being able to
  pull the plug, and invisible, unstoppable sessions are not a trade this team
  will make on the user's machine. So: `create`/`promptAsync` calls deleted, the
  consent dialog (`TM_DISPATCH_ASK`), the depth ceiling (`TM_SUBAGENT_DEPTH`),
  the serial switch (`TM_PARALLEL_DISPATCH`) and the concurrency cap
  (`TM_DISPATCH_MAX`) went with it — all four were guards around a door that
  should not have been there. The host's `task` (plus `background: true`) is now
  the only delegation channel: governed by the host's own permission set, shown
  as a card that links to the live child, and killable by the user.
  `tm_join` stays and gains the read-back path, because collecting a child the
  host created is the half that was never the problem — including children
  dispatched by an older version, which are still adopted, settled and cancelled
  exactly as before. The lead's prompt states the removal out loud, so a model
  that remembers the old tool from a previous session finds the door closed in
  writing rather than by trial.


### Fixed

- **`docs/installation.md` said the cache was authoritative but not where inside
  it.** The scoped cache directory is a *wrapper* whose `package.json` only
  declares the dependency; the executed code is the nested
  `…@latest/node_modules/@te-river/opencode-team-mode/dist`. Documented, with
  `tm_stats` as the definitive "which build is running" probe (registry
  `npm view` and a `package.json` read both prove less than they look).


Three defects from one real session (a Go repo, 2026-09-21), each reproduced
before it was changed — and two of the session's five complaints turned out to
be the tools answering correctly, which is recorded here because "the tool is
broken" and "the answer is not what I expected" must not be conflated.
- **A confirmation dialog nobody answers now ends.** `tm_webfetch` of an
  off-allowlist URL calls `ctx.ask` and waits — with no deadline of its own.
  The approval gate's `TM_ASK_TIMEOUT_MIN` auto-reject only covers it when R6 is
  on AND the client can reply; where it is not armed, the tool hung until the
  user interrupted the turn, and the card read `Tool execution aborted` with
  nothing to explain it. `askUserForTarget` now races its own timer
  (`TM_ASK_TIMEOUT_MIN` + 15 s, so the gate stays authoritative when it can
  fire) and returns a fourth verdict, `timed-out`, whose message says 无人应答
  rather than 用户未批准 — a refusal means stop, a timeout means go and look at
  the screen. All seven ask sites (webfetch, search, browser navigation,
  `evaluate_script` consent, `tm_pty`, the PTC web bridge) share the one note.
- **`evaluate_script` was silently discarding the model's function.** Every
  browser tool documents `function: "() => …"`, but `evaluate()` treats a
  STRING as an expression: a function source evaluates to a function object,
  which cannot be serialized, so the call resolved to `undefined` and we
  rendered `执行结果：null` — the model spent six rounds wondering whether the
  page had the links, when our call had thrown them away. A function-shaped
  source is now INVOKED (`(() => …)()`; an expression the model already
  invoked is not double-wrapped, and `awaitPromise` carries async results out),
  and the reply names the value's TYPE so `undefined` / `null` / `""` / `array(0)`
  are four different sentences. On the legacy CDP engine a page-side throw now
  surfaces as 页面内抛出异常 instead of `null`.
- **An empty result is now an answer.** `tm_bash` returned the empty string for
  a command that printed nothing — indistinguishable from "the tool never ran" —
  and `tm_grep` returned nothing at all for 0 matches, so the agent's next move
  was to distrust the tool. Both self-report now: bash says
  `stdout 为空 = 0 行输出 · cwd=…` and points at `tm_read` for file content
  (PowerShell 5.1 decodes a CJK UTF-8 file by the machine's ANSI codepage, so
  the same file is 187 lines to `wc`/`tm_grep` and 168 to `Get-Content` —
  measured, and the reason a line-range read silently came back empty); grep
  says `（0 命中）pattern=… · 范围=…` and states that 0 in that directory does not
  prove absence, with the widening moves. Non-empty results are returned
  byte-exact — the note never rides along.
- **tm_stats' window is now THIS workspace's window.** Outside a git repo the
  store falls back to the OS temp dir — and that fallback was ONE global
  bucket, so every non-git workspace shared a trajectory ledger with every
  other one, including the plugin's own test runs. A user's read-only
  self-check printed "窗口 10 个 run · 墙钟 81370s" of traffic that belonged to
  neither their session nor their project, which makes the one number that
  justifies Team unreadable. The run/trajectory/blackboard trees are now
  sharded per workspace (`opencode-team/w-<hash>`). The key is a hash, not a
  slug: `projectSlug` strips non-ASCII, so `D:\扒取数据` and `D:\文档` both
  collapse to `d` and would share a shard — the same collision still exists
  for the memory tier's project slug and is called out rather than papered
  over. `memories/` deliberately did NOT move: its project tier is already
  slug-keyed, and relocating it would strand memories the user already wrote.
  Shards are reclaimed at boot: `pruneStaleStoreShards()` removes a sibling
  `w-*` that has produced nothing inside the TTL and never touches the live
  one — without it the fix itself leaks a directory per throwaway workspace,
  which is exactly what 64 of them in the user's Temp after one dev session
  were made of.
- **An upgrade no longer leaves 503 MB behind.** Sharding the store moved the
  run/trajectory trees, which silently orphaned the pre-shard `blackboard/`
  (runs + webcache) and `trajectory/` at the temp-dir fallback — no code reads
  them and no sweeper points at them, so they would have sat there forever.
  `reclaimLegacyStoreBuckets()` drains them at boot under the same TTL rule as
  the live store: expired is deletable, fresh survives (a session that started
  before the upgrade may still be writing), and the shell goes only once
  nothing lives under it. `memories/` and the team blackboard are still live at
  that base and are explicitly out of scope. Both sweeps sit behind
  `TM_STORE_RECLAIM` (default on), which the test runner now sets to `off` —
  before that knob existed, running the suite reclaimed 503 MB of the
  developer's real Temp mid-test, which is correct product behaviour and
  entirely wrong as a test side effect.
- **tm_join now counts as a call.** The token table reads calls off
  `event:"call"`, and tm_join only ever wrote its governed result — so the row
  read "0 调用 / 2 结果", which looks like a broken counter rather than a tool
  that ran. It now logs one call at entry, after the lead lock, so a
  governance-refused call is still not counted.



- **A dead browser is no longer retried forever.** A live session hit
  `page.goto: Target page, context or browser has been closed` three times
  in a row on `action:"open"`, while `close` and `evaluate_script` each
  insisted there was no session at all — the cached instance was never
  dropped, so the agent had no way out except repeating itself. An action
  that reports a closed browser now clears the session, logs `session_dead`,
  and says so: the next `open` really launches a new instance, and the
  reply names the two ways out (close the competing browser window, or
  `TM_BROWSER_ENGINE=cdp-legacy`) plus the instruction not to try a third
  time. An ordinary navigation timeout is still reported as itself — the
  label is not applied to every failure.
- **`evaluate_script` no longer asks about an empty host.** On a
  `chrome-error://` tab the consent pattern became `evaluate_script:` with
  nothing after the colon, and the refusal read 未获批准（目标站点 ）— a
  dialog no user can judge. A hostless current page is now refused outright
  with the reason and the way out, and no dialog is opened for it.
- **The timeout note now reads as a measurement.** It said
  "确认窗 75s 内无人应答", which is the configured cap, and the agent
  reasonably doubted whether it had waited at all — then spent a round on
  `Get-Date`. It now says 等满了 N 秒（本机 ask 的等待上限）, which answers
  the question the model was actually asking.
- **`close` no longer lies about the browser being gone.** It verified
  `pages === 0 && !isConnected()` and printed 已确认关闭 — while an msedge
  process tree was measurably still running under OpenCode.exe. A dropped CDP
  connection is not an exited process. The first fix read the pid from
  `browser.process()`, and the real-host test written for it proved that
  accessor **does not exist** on playwright-core 1.63's `Browser` (it belongs to
  `ElectronApplication` and `BrowserServer`): `typeof browser.process` measured
  `undefined`, so the pid had been `0` on every real session, the orphan ledger
  had never recorded a launch, and 已确认关闭 had never checked a process at all.
  A mock that faked the accessor is what let that ship as fixed. The pid now
  comes from the OS — the browser is a child of this process and runs the
  executable we resolved — and which route answered (`playwright` /
  `child-scan` / `none`) is written to the trajectory, because a silent `0` is
  what hid this for a release. With no pid there is now a THIRD verdict,
  `进程未核验`, which says nothing was checked instead of borrowing the verified
  sentence; the researcher/tester prompt names all three, since a model that
  only knows two turns "unverified" into "浏览器已关闭".
- **Orphan browsers are reclaimed.** A plugin process that dies leaves its
  browser running (nine msedge processes under a scoped temp profile, parent
  pid long gone, on the machine this was found on). Each launch now records
  `{pid, ownerPid, exe}` in a per-workspace ledger and the next boot terminates
  only entries whose owner is dead while the browser lives — so a second
  OpenCode window's tabs are never ours to kill. Nothing scans the system by
  process name or profile prefix; `TM_BROWSER_REAP=off` turns it off. The kill
  is a TREE kill: `process.kill(pid)` signals the root only, and the real-host
  test measured exactly that — the browser went down and all nine children
  stayed up, which is the leftover the reaper exists to remove. win32 runs
  `taskkill /PID n /T /F`, POSIX enumerates descendants and signals
  deepest-first. Because this force-kills a whole tree and an OS pid is a
  recyclable number, the recorded `exe` is checked against what that pid
  actually is before anything is signalled, and a line written before the `exe`
  column existed is still reclaimed — an upgrade must not strand the browsers a
  user already orphaned.
- **A mistyped browser verb offered a menu that had not heard of the new verbs.**
  The unknown-action list was a hand-written copy of the action table, so it
  never gained `new_page`/`close_page` — and that refusal line is the only place
  an agent that forgot a verb can find it. It is derived from the same table the
  gate reads now (pinned: all 23 registered verbs, exactly once each).
- **`click` no longer reports a success the page did not have.** It answered
  `已点击 uid "e33"` on the strength of "playwright delivered a mouse event",
  which is not the same fact as "the page did something". Measured on a Next.js
  documentation site: the same locator, clicked through playwright directly,
  expands the disclosure; through `tm_browser` it is a no-op at
  `document.readyState === "interactive"` (300 ms and 1500 ms after `open`) and
  works at `"complete"` (4 s, once the framework's own globals exist). Every
  actionability check playwright makes — visible, stable, enabled, receives
  events — passes on a button whose bundle has not run yet, so the event lands
  on a node with no handler and the tool used to say it clicked. `click` now
  reads the target's observable state in ONE round-trip before and after
  (`aria-expanded`/`-checked`/`-selected`/`-pressed`, `disabled`, `value`, the
  URL, a DOM node count, `readyState`) and reports the delta:
  `已点击 … · aria-expanded: false → true`, `… · 已跳转 → <url>`, `… · DOM 节点
  1200 → 1290`. Nothing changed earns ONE bounded retry after the page settles —
  safe precisely because nothing changed, so a toggle is never flipped twice,
  and never retried when the click opened a dialog, which is proof it landed.
  Still nothing: the reply says 页面没有任何可观测变化 with the `readyState`
  that explains it, and names the next move (`wait_for` the text you meant to
  click, or re-snapshot) instead of leaving the agent to reason from a state
  change that never happened. Every outcome is audited as
  `click_verified {effective, retried, probed, ready}`. A detached element is
  not treated as a failure either — a navigating click is recognised from the
  URL independently of the probe.
- **Closing the last tab no longer costs you the browser (found by a live
  1.6.0 test session, and it was our own regression).** `close_page` left
  `state.page` pointing at the tab it had just closed while the reply promised
  "浏览器仍在运行"; the next action then threw playwright's
  `Target page, context or browser has been closed`, the dead-instance recovery
  read that as a dead BROWSER and dropped the lease — so `close` reported
  "no browser open" about a window still on the user's screen, and the only
  thing left to reclaim it was the boot orphan reaper. Two separate fixes: an
  empty window now answers with its own sentence ("0 个标签页，窗口和进程都还在，
  用 new_page 开一个") that never mentions a closed browser, and the recovery
  distinguishes a closed TAB from a dead BROWSER by asking the browser object
  (`alive()`), dropping the lease only for the latter. The audit says which:
  `page_dead_browser_alive` vs `session_dead`.
- **`wait_for { text }` no longer throws playwright's internals at the agent.**
  A visible label like a sidebar category matches several nodes, and strict mode
  answered with the full report (`resolved to 2 elements`, the `aka getByRole`
  hints, a Call log) — measured live, on the very recovery step our own click
  message had just recommended, so the way out was blocked. It now waits for the
  FIRST match and says so (`这个文本命中 3 个元素，等的是第一个——要更准就用 uid`).
- **"Nothing changed" now names the right reason.** The first version of the
  click verdict blamed load timing unconditionally, and a page at
  `readyState=complete` with 15 blocked subresources was told to `wait_for` —
  which then threw, per the entry above. The no-change reply now splits three
  ways: blocked subresources are named with their hosts and the real remedy
  (allowlist the host / approve it in the dialog, then re-open), a fully loaded
  page that ignores the click is reported as that element not responding (and
  told so plainly, `这不是加载时机问题`), and only a page that really is still
  loading gets the `wait_for` advice.
- **A snapshot failure no longer blames playwright when nothing is wrong with
  it.** Every `take_snapshot` failure appended "locator.ariaSnapshot needs
  playwright-core ≥1.49 …" regardless of the underlying error, so a closed page
  sent an agent to audit its dependencies. The version sentence now appears only
  when the accessor itself is missing (`not a function`); anything else is
  reported as what it is.
- **One failed OS query no longer forfeits a browser forever.** The parallel
  test runner caught this: `test-browser`'s real leg sometimes failed "the orphan
  ledger recorded the pid this session launched".  It is not a visibility race (a
  probe measured the first scan itself taking ~2.8 s, by which point any launched
  browser is long enumerable) — it is `childProcRows` folding EVERY PowerShell/CIM
  failure (non-zero exit, the 6 s timeout killing it, a JSON parse miss) into an
  empty list, asked exactly once at launch.  pid 0 then skips the ledger entry, so
  the next boot cannot reclaim that browser and `close` can never verify the
  process: a transient query became a permanent condition.  Reproducing it through
  the test seam also exposed something worse — an exception escaping the lookup
  failed `open` outright, reporting a successfully launched browser as a tool
  error.  `resolveLaunchPid` now retries a bounded three times, swallows every
  throw into the retry counter, and never lets the pid question cost the session;
  when it still cannot answer, `via: "none"` stays in the trajectory and `close`
  keeps refusing 已确认关闭.

- **`tasklist` and `ps` joined the tm_bash read-only allowlist.** A live session
  was told to check for leftover browser processes after a close, and this allowlist
  refused the command — which made 已确认关闭 unverifiable by the one party who
  cared. Listing is now allowed; `taskkill` still is not (pinned both ways), and
  the refusal hint names the commands that ARE allowed.
- **`baike.baidu.com` rendered as a blank page and the tool said nothing about
  why.** The `same-site` subresource policy passes a page's own scripts by
  registrable site, and Baidu serves its bundle — including the antispam challenge
  script — from `bdimg.com`, which shares no brand suffix with `baidu.com`, so no
  amount of same-site logic could infer it. Measured on one machine with one
  executable: `baike.baidu.com/` came back with **0 addressable nodes behind the
  gate and 260 with `bdimg.com` allowed** (274 with everything allowed), i.e. the
  blank was ours, and an agent reading "0 个可寻址节点" reported 该网站没有内容.
  Three changes: `bdimg.com` joins the seeded hosts (a site's own CDN on an
  unrelated brand domain has to be seeded — the new `allow_host` verb covers what a
  seed cannot anticipate); a page that comes back with nothing addressable WHILE
  script hosts were blocked now says out loud that the blankness is our gate, names
  the host and gives both remedies; and a thin page that is really a
  human-verification wall (百度安全验证 / Cloudflare's Just a moment / access
  denied) is reported as a wall, because the move there is another source or the
  user's own hands — never another retry. Baidu's item pages defeat a fourth thing
  we do not own: with every resource allowed they still serve 安全验证 to an
  automated client, which is their anti-bot policy rather than our defect (plain
  playwright measures 0 characters there too).

- **A refused redirect named only the host it stopped at.** An allowlisted
  shortener that bounces off-site produced `主机 "x" 不在白名单` with no mention of
  the URL the agent had actually asked for — which reads as "that site will not
  fetch", and sent agents back to retry the entry URL they had just watched
  fail. `fetchWebText` now tracks every hop and appends
  `跳转链: a → b（停在第 N 跳）` to the refusals, the 403/418 directive and the
  generic HTTP-error line. A 429/503 also carries the server's own
  `Retry-After` when (and only when) it is delta-seconds, so "come back later"
  is never reported as "nothing here"; an HTTP-date is deliberately not
  laundered into a countdown, because this toolset has no way to honor one.
- **`"*"` used to open the instance-metadata endpoint.** The domain allowlist
  answered "is this host on the list", and with `TM_WEBFETCH_ALLOWED_DOMAINS="*"`
  (a documented setting) it answered yes for every string — including
  `http://169.254.169.254/latest/meta-data/…`, whose response is a set of
  temporary cloud credentials that would then have ride into the model context,
  the run store and the trajectory. Loopback and RFC1918 were silently open on
  the same path. `src/tm/egress.ts` is the missing question — *what does this IP
  literal actually point at* — asked before the allowlist, so no configuration
  answers for it: non-routable ranges (link-local/metadata, `0.0.0.0/8`,
  multicast, reserved, benchmarking, `100::/64`, `2001:2::/48`, ORCHIDv2/AMT,
  `ff00::/12`, `::`) are a hard red line that never reaches a dialog, while
  private space (loopback, RFC1918, ULA, `fe80::/10`, CGNAT, `.localhost`) stays
  reachable but only by the user's own approval, every time — a local dev API is
  a legitimate target and `*` is not allowed to decide on the user's behalf. The
  IPv4-mapped and DNS64/NAT64 carrier forms are unwrapped before the policy runs
  (`::ffff:169.254.169.254` and `64:ff9b::a9fe:a9fe` are the same target as
  `169.254.169.254`), because a policy that reads only the outer notation is a
  policy that can be bypassed by changing it. Zero dependency, and it applies on
  every redirect hop since `fetchWebText` re-checks per hop.

- **The blackboard rule named the wrong roles as the ones that could not
  write.** It said "(architect / reviewer)" and omitted `researcher` — the role
  that actually hit the failure — while `reviewer`'s only theoretical route
  (`bash` with a redirect) was refused by the read-only gate anyway. A rule about
  who can write is only as good as the permission matrix behind it, so the
  rewritten rule names `tm_board_write` as the channel every role has and states
  the three that own no file tool at all.

- **A site permission bubble could wedge a browser nobody was watching.**
  Edge/Chrome raise their OWN modal for device-level permissions ("…想要 访问此
  设备上的其他应用和服务", 阻止/允许) when a page's script asks. That dialog is not
  our `ctx.ask` channel, so nothing in this plugin can bound it: `perm-ask`'s
  bounded wait and the approval gate's `TM_ASK_TIMEOUT_MIN` auto-reject both
  supervise OUR requests, and a native bubble has no timeout at all. Measured on
  a real Edge Beta against `npmjs.com/package/zod`: without any handling
  `page.goto` never reached `domcontentloaded` inside **45 s** (the tab kept
  spinning behind the bubble); with `--deny-permission-prompts` the same page
  reported `readyState=complete` in **10.7 s** with its body rendered. Since the
  documented deployment style is "leave it running on a server", one
  unanswered bubble meant one permanently wedged browser lease and one burned
  task. Both engines now pass the switch (pinned, because "one engine got the
  fix" is this repo's most-repeated defect), and the direction is deliberate:
  the plugin auto-**denies** and never auto-allows a site permission — no
  `permissions:` in the context options, no `grantPermissions` anywhere — since
  letting a site reach device services on the plugin's say-so is exactly the
  self-allowing the rest of the codebase refuses. A page that genuinely needs a
  permission now fails visibly at the feature instead of invisibly at the modal,
  which is the honest trade.

- **The reply now says WHICH path let a page in.** From the 1.6.0 host
  re-verification export: `developer.mozilla.org` is not in the 22 seeded hosts,
  no config overrode the allowlist, and the gate code was correct
  (`checkWebUrl` → `ok:false, askable:true`) — yet lead and researcher both
  opened it with no dialog, because the user had once clicked 始终允许 and the
  host answers from its saved rule. Two things were wrong with that. Per-agent
  consent (#58) is not consulted by a project-wide rule, so one click in one
  session is a pass for all of them; and nothing in the reply distinguished the
  three cases, so the researcher reported "免弹窗直接成功" and inferred "该 URL
  在白名单内" — a correct observation exported as a wrong conclusion, written
  into its deliverable. `askUserForTargetDetailed` now reports how fast the host
  answered, and an approval that arrived faster than a human can click is
  labelled as what it is (saved rule, project-wide, how to revoke it); a slow one
  is labelled as the user's own verdict. Trajectory gains `silent_grant` vs
  `dialog_approved`, and the researcher prompt forbids the inference explicitly.
- **`fresh: true` stopped throwing away the page it had just fetched**
  (`tm_webfetch`). It skipped the whole cache object, so it neither read NOR
  wrote: two calls to the same URL, 7 408 bytes each, and the second one still
  said nothing about a cache — measured in the same export. `fresh` means "do not
  hand me a past observation", which the fresh fetch satisfies for itself while
  leaving the fresh body to the next caller; the read is now skipped alone
  (`noCacheRead`) and the write stands, still under the existing rule that only a
  statically-allowed hop may ever touch the cache.
- **`close` no longer sends the user to hunt a window that cannot exist.** When
  the pid was verified gone but a tab reference lingered, the warning branch
  printed "窗口很可能仍在前台，请用户手动关闭（pid 33560）" in the same sentence as
  "进程 33560 早已不在". It now splits three ways: pid confirmed exited (no window
  to find, and the leftover count is OUR stale route reference), pid alive (close
  the window yourself), pid never obtained (nothing was verified — say so and
  leave the judgement to the user). Same discipline as #25's rule that an
  unverified close may not borrow the verified sentence, in the other direction.
- **The lease tripwire had a blind spot, and the live recheck walked straight
  into it.** Item 8 of the 12-item checklist: the lead opened a browser, kept it
  on purpose, dispatched a researcher, and collected the round — `tm_join`
  reported the settled children and the open todos, and said nothing about the
  window the user was looking at. The filter was `owner ∈ settled children`, so
  the caller's OWN lease could never be named, which is the single most common
  case: the lead is the role that opens a browser and finishes talking. It now
  splits two groups with different wording — a settled child still holding a
  window is a violation to bounce, the caller's own window is a reminder to close
  or explain (keeping one across rounds is legitimate, so it is not accused).
- **…and the tripwire then missed the second case, on a different branch.** The
  re-check of the fix above ran the same scenario and again reported nothing —
  this time because the lead had used a SYNCHRONOUS `task`. The host collects
  that one inline, so the child never enters this plugin's registry, `tm_join`
  took its "nothing to collect" early return, and the lease check lived in the
  header assembly BELOW it. Two defects in one line: the warning was attached to
  some answers and not others, and the answer it did give asserted something we
  had not measured — "那说明派发生本身没成功" told the lead its dispatch had
  failed, while a completed child reply with a full deliverable was sitting in
  the transcript. The lease line is now computed once, before any return, and
  rides every one this tool gives; the empty-round answer names the real reason
  instead (a sync `task` is never registered here — only `task {background:
  true}`, or an explicit `ids`, needs this tool to collect).
- **`findstr` joined the tm_bash read-only allowlist.** The verification checklist
  asked for `tasklist | findstr /i msedge`, tm_bash refused `findstr`, and the
  agent spent a second call on `Select-String` to do one read-only lookup — the
  same class as #62: a self-check the user can run by hand should not cost a
  round-trip.

- **A browser profile is now named as the session has one, not as the
  environment says.** Reported from a live session ("the agent's browser doesn't
  have my cookies"), and checking it turned up two separate falsehoods:
  1. the tool description claimed *"the real profile is never touched"* while
     nothing enforced it — `TM_BROWSER_USER_DATA_DIR` went straight into
     `launchPersistentContext`. Pointing it at the browser's own data dir is not
     neutral: with the browser open the new process hands its URL to the running
     instance and exits (the confusing "本机已有同品牌浏览器在跑" failure), and
     with it closed the agent browses **as you**, with every cookie and session,
     while the orphan reaper force-kills (`taskkill /T /F`) any browser whose
     owner died — a real route to corrupting a profile. `classifyProfileDir` now
     refuses that shape (Edge/Chrome/Chromium `User Data`, `google-chrome`,
     Firefox `Profiles`) BEFORE any engine starts and says what to do instead: a
     dedicated empty directory, logged into once by hand.
  2. `cdp-legacy` never read the variable at all — its profile was always a
     throwaway `mkdtemp` — while the `open` reply re-read the environment and
     announced 持久登录配置. So a degraded session promised its logins would
     survive and they could not. Both engines now resolve the profile through the
     same function, the session carries `persistentProfile` and the reply reads
     it from there (the same fix `headless` already had, for the same reason),
     and legacy close deletes ONLY a directory it created itself — a
     user-named persistent dir is never removed.

### Known gap (found while fixing the above, deliberately NOT changed)

- `projectSlug()` — the tier that names a tm_memory `project` directory —
  lowercases and strips every non-ASCII character, so `D:\扒取数据` and
  `D:\文档` both resolve to `d`, and two CJK-named workspaces can share one
  project memory folder. The new store shard avoids this by hashing the path;
  the memory tier still has it. It is left alone because fixing it changes
  where existing memories are read from — that is a migration the user should
  decide on, not a side effect of a bug fix.
- **tm_stats' parallelism table survived the removal by measuring what is still
  observable.** "派发 / 完成" became "子代理结算 / 失败 / 取消（派活走宿主 task）"
  plus a claim count, and the overlap number is now derived from each child's
  own (settle − duration) window instead of a dispatch line that no longer
  exists — a dead row is worse than a narrower one, because the throughput
  claim is the only reason this team exists.

## [1.5.15] - 2026-09-20

### Added
- **Goal directive — the user's own ask decides when the run may end.** The
  lead must now open with `GOAL:` in the user's terms plus checkable
  `ACCEPTANCE:` criteria, and keep working while any criterion lacks EVIDENCE;
  the only legitimate stops are named (blocked on the user with the exact
  criterion, or a criterion proven unachievable, with the attempts that show
  it).  Reframing a partial result as the deliverable is called out as the
  failure mode it is, the goal may be neither shrunk nor grown unilaterally,
  and user-stated boundaries still outrank it.  The same list is what
  specialists carry in their reply contract (`not done: <part> — <why>`).
- **tm_join enforces it with the host's own state, not a shadow copy.**
  `GET /session/{id}/todo` is read-only in the plugin surface (there is no
  write body — writing stays the built-in `todowrite` tool's job), so when a
  round settles with items still open, tm_join appends
  `⚠ 目标未达成：宿主 todolist 还有 N 项未完成 …` at exactly the moment a lead
  tends to wrap up.  The goal line also joins the compaction must-survive list,
  so a summarized transcript cannot quietly redefine it.
- **tm_dispatch now carries the governance the built-in `task` tool applies.**
  Forensics on the desktop binary showed `task` doing four things the public
  session API does not do for you: it asks the user (`ctx.ask({permission:
  "task", patterns:[subagent_type]})`), enforces `subagent_depth` by walking
  the parentID chain, creates the child session WITH an agent and a derived
  permission set, and inherits the model.  A plugin-side dispatcher that
  skipped them is a way around the user's own rules, so tm_dispatch now
  re-imposes what it can: `TM_DISPATCH_ASK=on` (one official-dialog consent
  per dispatch, refused when there is no ask bridge — tm_pty's rule),
  `TM_SUBAGENT_DEPTH=1` (same 口径 as the host), and the model inherited from
  the parent transcript into `prompt_async`'s `model` field.  What the public
  surface cannot do: `POST /session` accepts only `{parentID,title}`, so the
  child's derived permission set stays the host's own business — the T3
  lead-only deny in `agents.ts` is what keeps nesting closed here.
- **Ledger discipline in the prompts.** Every new ask — a mid-task
  interruption, an "analyze this too", a screenshot, a one-line aside —
  becomes a list item BEFORE the work starts; an interruption is an insertion,
  not a replacement; `blocked` is a state, not an exit; and after a resume or
  compaction the lead re-reads the list and continues the unfinished items
  instead of reporting the last thing it did.  Specialists get the same habit
  in their reply contract (`not done: <part> — <why>`), since they have no
  todo tool of their own.
- **tm_webfetch `{ fresh: true }`** bypasses the URL cache — the escape hatch
  for "I need this page as it is NOW", which a TTL cache otherwise removes.
- **`npm test` runs the suites in parallel** (`scripts/run-tests.mjs`): tsc
  still runs first (the suites import `dist/`, so a stale build produces
  phantom failures), then the seven `test-*.mjs` suites run concurrently with
  per-suite buffered output and an aggregated exit code — measured 151 s wall
  against 401 s serial. The two suites that launch a REAL browser never
  overlap. `npm run test:serial` keeps the old one-at-a-time behaviour, and
  positional filters (`node scripts/run-tests.mjs browser`) run a subset.
  Dev-side only: `scripts/` is not part of the published package.
- **`TM_PARALLEL_DISPATCH` (default `on`)** — the sub-agent parallelism switch.
  `off` makes a second dispatch while any child of the session is still running
  a refusal that names the live children and points at `tm_join`, enforced in
  the dispatcher (before the consent dialog, the same ordering as `TM_PTY_MAX`)
  and stated in the tool description, so the lead never discovers the mode by
  hitting it.  For a machine or a provider quota that cannot carry N sessions.
- **`tm_stats { recent: N }`** — a call-by-call recap appended to the stats
  table: tool, step, tokens, and for every offloaded result its `tm_fetch`
  handle plus the payload file path on disk, newest first.  This exists because
  the desktop renders a plugin tool call as a one-line card with no body (its
  tool-renderer registry holds only the built-in names and a plugin cannot add
  to it), so the paths are the only details a human can actually open.
- **A dispatched child announces itself.** The child session is now titled in
  the host's own subagent shape — `<description> (@<agent> subagent ·tm)` — so
  it reads as a sub-agent in the session tree instead of a mystery row
  (` ·tm` is what still keeps a `task`-spawned child out of restart recovery,
  and pre-1.5.15 `tm:<agent>:<label>` titles keep parsing), and one toast per
  dispatch names the live child and where to watch it.

### Changed
- **The tool priority ladder now puts the user's own tools first**: user
  MCP/plugin tools → TeamMode `tm_*` → the model's own reasoning (was
  tm_* → MCP → own).  The web channel keeps `tm_search`/`tm_webfetch`/
  `tm_browser` first and says why in the same breath: that path is the only one
  carrying the domain allowlist, the per-request dialog and the R6 red lines,
  and an MCP fetcher of the same page silently skips all three plus the offload.
- **`tm_dispatch`'s `label` argument is renamed `description`** — the key the
  desktop actually reads as a tool card's subtitle (and the built-in `task`
  tool's own name for it), so a dispatch shows as "Called tm_dispatch ·
  修登录页" instead of a raw argument chip.

### Added
### Fixed
- **A host error never renders as `[object Object]` again.** `session.error`
  payloads are nested (`{name, data:{message, ref}}`), and the old rendering
  stringified the object — so a lead told three failed researchers "they died"
  with no reason, and the one diagnostic in the flow was destroyed by our own
  formatting.  `describeHostError` digs `message`/`data`/`error`/`ref` and
  falls back to a shape dump; the same treatment now covers the collect path
  (a child whose last assistant message carries an `error` reports it).
- **`tm_join { ids }` accepts what models actually send.** The live host
  delivered `ids` as a JSON-array STRING (`'["ses_x"]'`), `Array.isArray` said
  no, and the filter silently degraded into "report every child" — the lead
  asked for one and got four.  `parseIdList` handles arrays, JSON strings and
  comma lists.
- **The "no readable reply" line stopped pointing at the wrong tool.** It told
  the agent to inspect a child SESSION with `tm_read`, which reads files.  It
  now says the session is not a file and names the real fallback.

### Changed
- `pipelines` records `preview_tokens` on an offload event, so tm_stats can
  report the saving net of what actually entered the context.
- `test-tm-tools` keeps the URL cache OFF through `clearTmEnv()` — several
  blocks call it, and a wire-inspection assertion that hits a cached leg
  fails depending on what a previous process left in the shared tmpdir store.

## [1.5.14] - 2026-09-19

### Added
### Fixed
- **tm_dispatch crashed on the live host: `Cannot read properties of undefined
  (reading 'client')`.** Every `client.session.*` endpoint was captured as a
  bare function reference (`const createApi = api.create` … `createApi({...})`),
  which drops the SDK's receiver binding — so every async dispatch died before
  a child session existed and the lead had to fall back to the blocking `task`
  tool.  All six call sites (create / promptAsync / messages / status / abort /
  children) are now property-access calls, the rule `approval-gate.ts` already
  documents for permission replies and `pty.ts` already follows.  The test
  fake's session namespace now REQUIRES `this`, so the bug class fails the
  suite instead of shipping (found in a user-reported Desktop session).
- **bing's international layout was mis-classified as a dead engine.** The
  2026-09-14 benchmark removed `bing-int` as "100% empty"; the real cause was
  ours — that layout wraps every result in
  `https://www.bing.com/ck/a?...&u=a1<base64>` and `extractSearchHits` dropped
  every wrapped anchor.  The wrapper is now decoded (`decodeEngineWrapperUrl`,
  bing-only, falls back to the old skip when undecodable), re-probed live at
  10 real hits, and `bing-int` is selectable again.  It stays OUT of the `auto`
  routes on purpose: two layouts of one index would double bing's vote, which
  is the weight 1.5.13 deliberately removed.

### Added
- **tm_stats — the plugin reads its own trajectory back.** Until now
  `steps.jsonl` was write-only, so "Team is faster" was unfalsifiable.  It
  reports tokens kept out of the context window by offloading (net of the
  preview that DID arrive), seconds saved by dispatch overlap (sum of each
  child's own duration minus the wall window they occupied), PTC internals,
  and the governance counts (blocked subresources, refused tm_pty starts,
  clamped bash timeouts, cache hits, redactions) — plus the capability matrix
  below, in one call.  Read-only over files this plugin wrote.  Allowed for
  all six agents.
- **Host-capability probe (`src/capabilities.ts`) — an OpenCode upgrade now
  fails loud.** The plugin leans on surfaces with no stability promise
  (`ctx.ask`, `permission.asked`, `session.create/promptAsync/children`,
  `client.pty`, `tui.showToast`, the hook set, `attachments`).  Each feature
  already degraded silently when one disappeared; the probe classifies every
  seam as 已验证 / 存在未用 / 待观察 / 缺失 / 需人眼, logs one trajectory line at
  boot, and raises exactly one toast when a REQUIRED seam is gone.
  `attachments` is permanently 需人眼 — we emit the shape and cannot observe
  whether the desktop paints it.
- **tm_join recovers a dispatch across a restart.** The child registry was an
  in-process Map, so a plugin restart answered "没有待收集的派发" while a
  finished report sat in the host — the exact silent loss tm_dispatch exists
  to prevent.  tm_join now falls back to `client.session.children`, adopts only
  sessions whose title matches the `tm:<agent>:<label>` shape we write (a
  `task`-spawned child is never claimed), settles adopted rows from
  `AssistantMessage.time.completed`, and marks the line 接管.
- **URL-level TTL cache for the web channel** (`TM_WEB_CACHE_TTL_SEC`, default
  300 s, `0` = off): one store shared by tm_webfetch, tm_search's engine legs
  and the PTC bridge, keyed by URL, entries named by hash so a token-bearing
  query string never lands on disk.  Governance is the point: an entry is read
  and written ONLY for a hop the STATIC allowlist admitted, so a hit can never
  resurrect a removed host or replace per-request dialog consent (pinned by
  test); a served page says 缓存命中.
- **`evaluate_script` now has its own consent and result redaction**
  (`TM_BROWSER_ASK_EVAL`, default on).  It is the one browser verb the network
  gate cannot cover — the allowlist limits where we navigate, not what a
  loaded page hands back, and with a persistent profile that page may be
  signed in.  One official-dialog consent per browser session, refused when
  there is no ask bridge (tm_pty's rule), and the result is scanned for
  JWT/bearer/cookie/api-key/token shapes before it can reach the context, the
  run store or the trajectory — masking is not switchable and the reply says
  what was masked.
- **The search engine that ignores you now says so** (`src/tm/dupe-guard.ts`).
  In a real Desktop session the lead burned 66 tool calls / 25 steps / 2.8 M
  input tokens on a three-term lookup because bing answered two DIFFERENT
  quoted queries with a byte-identical list about the single character 舞, and
  nothing in the reply admitted the collapse.  tm_search now fingerprints each
  result set: identical set under a different query → 引擎忽略了你的限定词,
  zero query-token overlap across every hit → 结果与查询无关（不要把无结果当结论）,
  and at the third collapse the directive sends the work to `tm_dispatch`
  instead of another serial retry.

### Changed
- `access_token` is now OPTIONAL on tm_fetch (and the PTC handle reads): it is
  a run constant, not a per-handle secret, and a real session was re-typing the
  same 64 hex characters into every call.  Omitting it resolves against the
  current run; the run-match and HMAC checks are unchanged, so a handle from
  another run is still refused.
- `pipelines` records `preview_tokens` on an offload event, so tm_stats can
  report the saving net of what actually entered the context.

## [1.5.13] - 2026-09-19

> Patch train by choice: this release carries new tools, but `1.6.0` is held
> back for the next architectural change.

### Added
- **tm_dispatch / tm_join — real lead/sub-agent parallelism.** The host's
  built-in `task` tool blocks the calling session until the child finishes,
  so a batch of three dispatches cost the sum of the three and every full
  reply landed in the lead's context.  The two new governed tools ride the
  official plugin client (`client.session.create` with `parentID` +
  `promptAsync`, which returns immediately): the lead fires a self-contained
  brief, keeps working the same round, and collects with `tm_join`
  (status snapshot, bounded `waitMs`, `cancel:true` to abort a runaway
  child).  Collected replies go through the SAME offload pipeline as every
  other tm_* tool, so a fat sub-agent report arrives as a handle +
  ≤80-token preview.  Lead-only: the five specialists carry an explicit
  `deny` (the `tm_*` wildcard would otherwise re-open the nesting T3
  closed), and the tool re-checks `ctx.agent` at runtime.  A host without
  the async session API degrades with an explicit "use `task`" directive.
- **tm_browser can show the model the page.** `take_screenshot { image:true }`
  now attaches a quality-70 JPEG of the view to the tool result via the
  official `attachments` contract (`{type:"file", mime, url}`), while the
  PNG stays in the run store as the evidence artifact.  Opt-in by design —
  pixels are the one thing this plugin's token economy cannot give away —
  and capped by `TM_BROWSER_IMAGE_MAX_BYTES` (default 400 000).
- **New knobs:** `TM_BROWSER_SUBRESOURCE` (`same-site` default | `passive` |
  `off`), `TM_BROWSER_IDLE_MS` (default 180 000; 0 disables the reaper),
  `TM_BROWSER_IMAGE_MAX_BYTES`, `TM_SEARCH_WEIGHTS="bing=0.3,…"`,
  `TM_SEARCH_MAX_HITS`, `TM_SEARCH_DISABLED_ENGINES`,
  `TM_SEARCH_RELEVANCE_FLOOR`, `TM_BASH_TIMEOUT_PROBE_MS` (default 60 000),
  `TM_BASH_TIMEOUT_MAX_MS` (default 0 = off).
- **Host-hook leverage beyond the tool surface** (`src/host-hooks.ts`), all additive, individually switchable and unable to throw into the host: `tool.definition` appends our call-site discipline to the built-in `bash`/`task` descriptions (`TM_TOOL_HINTS=on`, idempotent, the host text is never replaced); `chat.params` can apply a per-role sampling table (`TM_AGENT_TEMPERATURE`, default `off` — "all agents at 0.2" stays the invariant until the user opts in, or passes `reviewer=0.05;team=0.4`); `experimental.session.compacting` pushes the must-survive list (reply skeleton, offload handles, uncollected tm_dispatch child ids, provenance, board paths) into `output.context` and NEVER touches `output.prompt` (`TM_COMPACTION_CONTEXT=on`); `experimental.compaction.autocontinue` stays hands-off unless `TM_COMPACTION_AUTOCONTINUE=off`; `shell.env` injects `NO_COLOR`/`TERM=dumb` plus an explicitly allowlisted `TM_SHELL_ENV=K=V;K2=V2`, never clobbering a value the host set — so it cannot become a parent-env side channel. `experimental.chat.messages.transform` is deliberately NOT wired: rewriting the outgoing message array means guessing the live shape of tool results at that layer, and a wrong guess silently deletes the EVIDENCE it depends on.
- **tm_pty — non-blocking command execution on the host’s own terminal sessions** (issue #6’s other half): `client.pty.create/get/list/remove`, actions `start|status|list|kill`, so three independent test suites stop being one blocked 120 s bash call. It captures NO output (the REST surface has no stdin/transcript endpoint; terminal I/O is a websocket this plugin does not speak) — the command tees its own log and the agent reads that file. Governance is the point: every start passes the R6 classifier and the R2 danger-face globs (rm/del, git push/commit, npm install/publish are REFUSED, not asked) and then the OFFICIAL dialog with the exact command line as the pattern; no ask bridge ⇒ refuse, rejected ⇒ refuse, the plugin never self-allows. Lead-only (`tm_pty` = {`*`:`ask`} for the team, denied for the five), `TM_PTY_MAX=4` concurrent cap enforced before any dialog, and a session id we did not start is never ours to kill.
- **Presentation discipline in the prompts** (the audit found what the desktop actually renders): GFM tables for per-file/per-case/per-finding results, fenced code for transcripts, KaTeX for math, `tm_browser take_screenshot { image:true }` or a real artifact path for anything visual — and an explicit rule that mermaid is NOT drawn by this host (only syntax-highlighted), so a diagram block can never be passed off as a picture.

### Added
### Fixed
- **tm_browser rendered pages WITHOUT images, CSS or JS.** The network gate
  ran `checkWebUrl` over *every* request, and the 21-host content allowlist
  contains no CDN at all, so each `<img>`/font/stylesheet was silently
  `route.abort()`ed (both engines).  Subresources now follow
  `TM_BROWSER_SUBRESOURCE`: passive types (image/media/font/stylesheet)
  load, an executable type (script/xhr/fetch/document) loads when it
  belongs to a site the session actually navigated to, and anything else is
  still gated — with the R6/scheme red lines hard under every policy.  When
  the gate does trim a page, the next snapshot says so
  ("N 个子资源请求被拦截" + hosts), so an agent reports the gate instead of
  concluding "this site has no pictures".
- **Headless could no longer be triggered by the model.** `headless` was a
  model-facing arg and `Boolean("false")` is `true`, so one sloppy call
  pinned the whole plugin process to a headless browser — which every
  anti-bot gate in the run then rejected.  The parameter is gone (mode is
  `TM_BROWSER_HEADLESS` only), the sticky reused session now reports the
  mode the running instance is ACTUALLY in, and `open` names the engine +
  executable it launched.
- **A browser window could stay open while the agent claimed it closed.**
  `close` swallowed engine errors and returned "已关闭" unconditionally;
  `dispose` was fire-and-forget behind a synchronous hook chain; and there
  was no cleanup path at all besides the agent remembering.  `close` now
  verifies (pages released, browser disconnected, child exited) and answers
  either "已确认关闭" or "警告：关闭未完全成功" with what is left; `dispose`
  awaits; and an untouched session reaps itself after `TM_BROWSER_IDLE_MS`
  with a toast so the user learns why a window went away.
- **The default browser was detected, then ignored — and only stable Edge
  was findable.** Discovery read the `http` UserChoice from HKCU only, so a
  machine-wide Edge Beta install (HKLM\SOFTWARE\Classes, association on
  `https`) resolved to null and fell through to the stable candidate list;
  then `channel:"msedge"` made playwright resolve the STABLE install and
  discard the path we discovered anyway.  Both are fixed (http+https,
  HKCU+HKLM, ProgId→channel dirs, and `executablePath` is now the primary
  launch with the channel only as a fallback for a stable-shaped install):
  an Edge Beta default now opens `Microsoft\Edge Beta\Application\msedge.exe`
  (verified on the reporting Windows 11 host).
- **Search quality: `auto` was a bing mirror.** The `cjk` and `general`
  routes went to bing ALONE (no consensus leg, no fusion), and with bing at
  weight 0.4 vs 0.2 the arithmetic guaranteed bing's WORST hit (0.4/70 =
  0.0057) outranked every other engine's BEST (0.2/61 = 0.0033) — bing owned
  ranks 1-10 regardless of relevance.  Every route now has ≥2 legs, bing
  dropped to the default weight, and each hit's contribution is scaled by
  real query-token overlap (floor `TM_SEARCH_RELEVANCE_FLOOR`, default 0.35)
  with ties broken by agreement, not route order.  Bing is still in the
  table (it remains the only live CN HTML SERP) — it now has to earn rank.
- **SERP chrome and lost snippets.** bing's own pages (`/images`, `/dict`,
  `/news`, …) and sponsored slots are filtered out of the hit list, and the
  caption window now ends at the next organic result instead of at a nested
  `<a>` inside the caption — which had been cutting CN snippets off before
  the text started, leaving agents with 10 bare titles.
- **Bash timeouts: the 120 s the user waited for.** The host's shell tool
  defaults to `bashDefaultTimeoutMs ?? 2 * 60 * 1e3`, and models routinely
  passed 120 000+ for `Get-ChildItem` — three serialised probes in one
  PowerShell script then cost six minutes of dead air.  The plugin now
  clamps `args.timeout` through the official `tool.execute.before` hook for
  commands the P3 read-only allowlist already accepts (`TM_BASH_TIMEOUT_PROBE_MS`,
  60 s by default), leaves a real build alone, and offers
  `TM_BASH_TIMEOUT_MAX_MS` for a global ceiling.  It never INVENTS a timeout
  the model did not supply, and never widens what may run.
- **Prompt anchors that were actively harmful:** the researcher was told
  tm_search is "ONE call" with dead engines (bing-int / sogou / so / baidu)
  and no `auto`; `shared.ts` told agents to fold probes into one
  `a; b; c` serial command (now cheap-probe-only, slow independent steps get
  their own call); the built-in `bash` guidance contradicted the architect /
  researcher tool matrix.

### Changed
- **Lead prompts rewritten for the async model:** concurrency (you and the
  team run at the same time, `task` is the serial path), self-contained
  dispatch briefs with an expected thoroughness level, division of labour
  (bulk search / aggregation / long logs go to the child, routing and the
  final merge stay with you), a "collect before you close" rule, a
  **Command time budget** section shared by every specialist, and
  todo-list rules that license out-of-order execution, several
  `in_progress` items, file-ownership partitioning before parallel work, and
  "reuse before you build" (check the dependency set before designing a new
  module).  The evidence rule now demands a failure in the first lines
  rather than a narrative that hides it.
- **Installer cache purge now recurses**, so the scoped copy
  `@te-river/opencode-team-mode@latest` nested under `packages/@te-river/` is
  deleted too (the old top-level-only glob missed it) — re-running the
  installer is now a reliable update on both platforms; the purge also
  re-enumerates after deleting and warns instead of printing a false-green
  ✔ when a removal fails (locked by a running OpenCode). `docs/installation.md`
  and both READMEs carry the corrected manual recipe (POSIX
  `find … -prune -exec rm -rf {} +` — the previous `xargs -r` form is GNU-only
  and broke on macOS; Test-Path-guarded PowerShell snippet) plus the
  "verify the running version" step.

## [1.5.12] - 2026-09-16

### Added
- **tm_memory three tiers + self-maintenance (T1)**: a SESSION tier
  (in-process, keyed by session, TTL-swept via `TM_MEMORY_SESSION_TTL_MIN`
  default 240 min, ephemeral unless `TM_MEMORY_SESSION_PERSIST=1` mirrors to
  `memories/sessions/<sid>/`); near-duplicate merge on add (dedupKey in the
  same tier+category or title∪keywords Jaccard ≥ 0.6 folds into the existing
  entry -- content wins, keywords union, old slug moves to `supersedes:`,
  "已合并" answer, no second file); per-scope entry cap
  `TM_MEMORY_MAX_ENTRIES` (200) -- add fails on purpose over it, pointing at
  compact/forget; `[stale Nd]` tagging past `TM_MEMORY_STALE_DAYS` (30,
  `0` off); new `compact` action -- dry-run by DEFAULT, `apply:true`
  performs it after copying every original into a timestamped
  `.compact-backup/` tree (rollback path).
- **tm_search becomes a multi-engine front (T4)**: `stackoverflow`
  (api.stackexchange.com 2.3 keyless JSON; 300/day/IP quota tracked
  per-process -- `auto` swaps in bing on exhaustion) and `hn` (hn.algolia.com
  story JSON) engines; new `auto` DEFAULT engine
  (`TM_SEARCH_DEFAULT_ENGINE`): query classification (error-code /
  dev-ecosystem / cjk / general), parallel fan-out, host+path dedup,
  weighted-RRF fusion (stackoverflow/bing 0.4, others 0.2) into a top-10
  list tagged with source engine(s); `protectCjkPhrase` guards multi-word
  CJK queries on bing against markup-shuffle splitting; github engine folds
  whitelisted `org:/user:/stars:/language:` qualifiers; SO/HN/npm/github
  renders now carry per-hit snippets. `api.stackexchange.com` +
  `hn.algolia.com` join the seeded domain allowlist (21 -> 23 hosts, only
  while the default seed is in play).
- **tm_fetch `fields` projection**: `fields: "<dot-path>"` serves JSON
  handles through a deliberately small jq subset (`items[].name`,
  `[].stargazers_count`) -- the raw body never pages into context.
- **Content-class offload thresholds (T4)**: prose (text/log) ->
  `TM_OFFLOAD_THRESHOLD_TEXT` (4000), json/csv/code/binary ->
  `TM_OFFLOAD_THRESHOLD_DATA` (2000); an unknown/absent class falls back to
  the global `TM_OFFLOAD_THRESHOLD` (2000) -- unset env knobs are fully
  backward-compatible.
- **tm_browser gains the playwright engine (T5)**: dynamic-imported
  `playwright-core`, chrome-devtools-mcp-aligned 16 verbs (navigate_page,
  take_snapshot, click, fill, hover, drag, press_key, select_page,
  upload_file, wait_for, evaluate_script, list_console_messages,
  list_network_requests, list_pages, take_screenshot, handle_dialog) + the 5
  compat verbs; snapshot-first -- `take_snapshot` injects `[uid=eN]` tokens
  into the ariaSnapshot YAML and follow-up actions address nodes by uid
  instead of guessed locators; snapshots hard-capped by
  `TM_BROWSER_SNAPSHOT_MAX_TOKENS` (1200); `TM_BROWSER_ENGINE` pins
  `playwright|cdp-legacy`; any import failure or Node < 20 auto-degrades the
  instance to the unchanged zero-dep cdp-legacy transport (core verbs);
  persistent login ONLY via explicit `TM_BROWSER_USER_DATA_DIR`.
- **tm_ptc_run web bridge (T6)**: `tm.search` / `tm.webfetch` facades inside
  PTC programs (`TM_PTC_WEB_BRIDGE=on|off`), with per-call ctx rebind so the
  host evaluates every bridge call against the CALLING agent's ruleset --
  non-web roles are auto-denied, no new gating mechanism; GET idempotency
  makes the client/execute/store phases retryable.
- **Approval-gate reply-failure taxonomy (T2)**: `classifyReplyFailure`
  splits a failed dialog reply -- host 404/NotFound = the dialog was
  already closed (`already-closed` verdict, NO degraded flip), 400 /
  BadRequest = our reply shape is wrong (`rejected-shape-bug`, flips),
  transport/5xx/empty body = degraded as before; a closed-request tombstone
  map lets a user reply landing AFTER the auto-reject audit as
  `late-<verdict>` (observability only -- the reject stands, nothing is
  re-run, the plugin still never self-allows); the auto-reject floor becomes
  a knob `TM_ASK_TIMEOUT_FLOOR_MIN` (default 1) and the default ask timeout
  drops from 10 min to **1 min** -- the benign `already-closed` reply
  classification makes short timeouts safe (a reply racing the timer hits a
  closed request = host 404, no degrade flip; the observed ~120 s is the
  host->plugin event-bus delivery lag, not click-resolution latency). A
  real-host probe is still recommended to confirm the closed-request 404
  stays identifiable.
- **Lead `## Dispatch concurrency` prompt section (T3)**: independent
  dispatches batch into ONE round (parallel implementers with per-file
  ownership + verbatim contracts, 3-dimension reviews, split test suites);
  serial only where scopes overlap; anti-patterns named (gate-splitting,
  two implementers on one file). Pinned by test-blackboard.
- PTC sandbox hardening: `staticPscan` strips template/string/comment
  literals before scanning (a grep string naming `require`/`process` no
  longer kills the whole program); the worker sandbox object is
  null-prototype (the constructor -> outer `Function` leak is closed).
- New suites `test-memory.mjs` (three tiers / merge / caps / compaction /
  stale) and `test-browser.mjs` (engine selection + auto-degrade + the
  16-verb mapping against a MOCK playwright module; the real smoke SKIPS
  while the optional dep is absent); the `npm test` chain runs both.

### Changed
- tm_memory search now enforces project > global precedence: same-title global entries are shadowed by project entries, project entries get a +2 near-tie weight; tool description and agent prompts document the project/global layer split.
- tm_ptc_run intent: the PTC batching rule is now a plan-time trigger ("plan lists ≥3 probes → FIRST move is ONE tm_ptc_run"); researcher prompt gains a PTC-first recon section.
- **Architect and reviewer lost `task` (T3 task-reclaim)**: `task` /
  `todowrite` / `question` are LEAD-only grants now -- only the Team Lead
  dispatches, no sub-agent spawns a sub-agent (the whitelist deny is
  zero-bypass, live-verified).
- **`playwright-core` moved from `dependencies` to `optionalDependencies`**:
  the lockfile was out of sync (CI `npm ci` failed), and with
  `engines: node>=18` vs playwright's own `node>=20`, Node 18/19 hosts died
  on `npm install --engine-strict` before the auto-degrade could even run --
  plus a hard dep taxed every install with ~9 MB. Now npm skips the optional
  on old/unreachable hosts and the tested cdp-legacy fallback drives the
  browser regardless. No browser binaries are ever downloaded: playwright
  launches the user's own discovered Chromium-family browser by path, so
  `npx playwright install` stays a publisher-side action and never enters
  the user flow.

### Removed
- Dead CN HTML SERPs `sogou` / `so` (360) / `baidu` / `bing-int` are gone
  from the tm_search engine table (2026-09-14 live benchmark: anti-bot
  shells / 100% empty results) -- not even manually selectable; their
  webfetch seed DOMAINS stay on the allowlist for page fetches.
- The in-repo `test/` exam build and the `ptc-test.js` scratch harness were
  cleaned out of the repository; the governed `test-*.mjs` suites at the
  root are the only test surface.

## [1.5.11] - 2026-09-13

### Added
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

### Added
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

### Added
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

### Added
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

### Added
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

### Added
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

### Added
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

### Added
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

### Added
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

### Added
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

### Added
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
