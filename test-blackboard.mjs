/**
 * Blackboard end-to-end verification (run with node after `npm run build`).
 *
 * v1.4.7: sections 1-3 still pin the TTL sweeper semantics (unchanged code).
 * Section 4's prompt assertions now pin the v1.4.7 contract: deterministic
 * routing, count-based approval gate, structured reply skeleton (hybrid
 * blackboard), adaptive review, static verification, MANIFEST/Ultra-Review
 * removal, and temperature discipline.
 */
import assert from "node:assert"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const repoRoot = path.dirname(fileURLToPath(import.meta.url))
const bb = await import("./dist/blackboard.js")
const plugin = (await import("./dist/index.js")).default
const ep = await import("./dist/envprotect.js")
const v2perm = await import("./dist/host/v2-permissions.js")

/* ---------- 1. resolveTtlMs ---------- */
assert.equal(bb.resolveTtlMs(), bb.DEFAULT_TTL_MS, "default = 5d")
assert.equal(bb.DEFAULT_TTL_MS, 5 * 86400_000)
assert.equal(bb.resolveTtlMs({ ttlDays: 7 }), 7 * 86400_000, "custom ttlDays")
assert.equal(bb.resolveTtlMs({ blackboardTtlDays: 10 }), 10 * 86400_000, "alias")
assert.equal(bb.resolveTtlMs({ ttlDays: 0 }), bb.DEFAULT_TTL_MS, "0 -> default")
assert.equal(bb.resolveTtlMs({ ttlDays: -3 }), bb.DEFAULT_TTL_MS, "neg -> default")
assert.equal(bb.resolveTtlMs({ ttlDays: "7" }), bb.DEFAULT_TTL_MS, "string -> default")
assert.equal(bb.resolveTtlMs({ ttlDays: 999 }), bb.DEFAULT_TTL_MS, "over cap -> default")
console.log("1. resolveTtlMs: OK (default 5d, custom, alias, invalid-guard)")

/* ---------- 2. sweepStale with 5-day TTL ---------- */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bb-test-"))
const makeTask = (name, idleDays) => {
  const dir = path.join(root, name)
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, "01-design.md"), "x")
  const t = new Date(Date.now() - idleDays * 86400_000)
  fs.utimesSync(path.join(dir, "01-design.md"), t, t)
  fs.utimesSync(dir, t, t)
}
makeTask("stale-task", 6)      // 6 days idle  -> should be removed
makeTask("fresh-task", 1)      // 1 day idle   -> keep
makeTask("edge-task", 4.9)     // just under   -> keep
fs.writeFileSync(path.join(root, "stray-file.txt"), "ignore me") // non-dir -> untouched

const removed = bb.sweepStale(root)
assert.equal(removed, 1, "exactly 1 removed")
assert.ok(!fs.existsSync(path.join(root, "stale-task")), "stale deleted")
assert.ok(fs.existsSync(path.join(root, "fresh-task")), "fresh kept")
assert.ok(fs.existsSync(path.join(root, "edge-task")), "edge kept")
assert.ok(fs.existsSync(path.join(root, "stray-file.txt")), "stray file kept")

/* file newer than dir counts as activity */
const t2 = path.join(root, "touch-test")
fs.mkdirSync(t2)
const old = new Date(Date.now() - 6 * 86400_000)
fs.utimesSync(t2, old, old)
fs.writeFileSync(path.join(t2, "new-entry.md"), "y") // new file resets activity
assert.equal(bb.sweepStale(root), 0, "recent inner file keeps dir")

/* custom ttl: fresh(1d) + edge(4.9d) exceed 0.5d; touch-test has a just-now file */
assert.equal(bb.sweepStale(root, 0.5 * 86400_000), 2, "0.5d ttl sweeps idle ones, keeps active")
assert.ok(fs.existsSync(path.join(root, "touch-test")), "recently-written dir survives short ttl")
fs.rmSync(path.join(root, "touch-test"), { recursive: true, force: true })

/* session-partitioned layout: root/<session-key>/<task> */
const mkTaskUnder = (sess, name, idleDays) => {
  const dir = path.join(root, sess, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "01-artifact.md"), "x")
  const t = new Date(Date.now() - idleDays * 86400_000)
  fs.utimesSync(path.join(dir, "01-artifact.md"), t, t)
  fs.utimesSync(dir, t, t)
}
mkTaskUnder("sess-dead", "old-a", 6)
mkTaskUnder("sess-dead", "old-b", 6)
{
  const t = new Date(Date.now() - 6 * 86400_000)
  fs.utimesSync(path.join(root, "sess-dead"), t, t) // whole session idle
}
mkTaskUnder("sess-alive", "dead-task", 6)
mkTaskUnder("sess-alive", "live-task", 1) // its creation bumped sess-alive's mtime
assert.equal(bb.sweepStale(root), 3, "2 tasks of fully-idle session + 1 stale task under live session")
assert.ok(!fs.existsSync(path.join(root, "sess-dead")), "fully-idle session folder reclaimed")
assert.ok(!fs.existsSync(path.join(root, "sess-alive", "dead-task")), "stale task pruned in place")
assert.ok(fs.existsSync(path.join(root, "sess-alive", "live-task")), "live task kept")
assert.ok(fs.existsSync(path.join(root, "sess-alive")), "session with live tasks kept")

/* regression (reviewer C2): in-place artifact rewrite under old dirs is the
   ONLY fresh signal — session-level staleness must look 2 levels deep */
mkTaskUnder("sess-edit", "t", 6)
{
  const t = new Date(Date.now() - 6 * 86400_000)
  fs.utimesSync(path.join(root, "sess-edit"), t, t) // session dir as idle as its task
}
fs.writeFileSync(path.join(root, "sess-edit", "t", "01-artifact.md"), "v2") // fresh file, old dirs
assert.equal(bb.sweepStale(root), 0, "live session must NOT be reclaimed wholesale")
assert.ok(fs.existsSync(path.join(root, "sess-edit", "t", "01-artifact.md")), "edited board survives")

/* missing root -> no throw */
assert.equal(bb.sweepStale(path.join(root, "nope")), 0, "missing root safe")
fs.rmSync(root, { recursive: true, force: true })
console.log("2. sweepStale: OK (5d default, activity detection, custom ttl, edge cases)")

/* ---------- 3. path resolution ---------- */
const repo = bb.findRepoRoot(process.cwd())
assert.ok(repo && fs.existsSync(path.join(repo, ".git")), "findRepoRoot finds repo")
assert.ok(bb.teamRootFor(process.cwd()).endsWith(path.join(".git", "opencode-team")), "board under .git")
const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "bb-nogit-"))
assert.ok(bb.teamRootFor(nonGit).includes("opencode-team"), "non-git falls back to tmpdir")
fs.rmSync(nonGit, { recursive: true, force: true })
console.log("3. paths: OK (.git/opencode-team, tmpdir fallback)")

/* ---------- 4. loader contract: v2-only export + the definition surface ---------- */
// 1.7.0 cut: the v1 personality is deleted, so there is no plugin.server() and no
// v1 `config` hook to run. On 2.x the host receives what scripts/gen-v2-config.mjs
// projects from these SAME dist modules, so the content contract below is pinned at
// the source the generator actually reads — and the export shape is pinned as
// v2-only, because a resurrected `server` would mean the cut was quietly undone.
const { agents } = await import("./dist/agents.js")
const { commands } = await import("./dist/commands.js")
const { blackboardNote } = await import("./dist/host/note.js")
const cfg = { agent: agents, command: commands }
/* The board note is no longer appended to a prompt by a config hook: v2 pushes it
 * into the system context for the lead only (pinned by test-v2-adapter's request
 * layer group), so what this suite owns is the note's own content. */
const note9 = blackboardNote("/board/root", 9)
assert.equal(plugin.id, "@te-river/opencode-team-mode", "display id — the host plugin list shows the npm package name (#45)")
assert.equal(plugin.server, undefined, "the v1 entry point is GONE — this is the cut, not a refactor")
/* #45: the plugin's DISPLAY id is the npm name, but the storage/audit names are
 * DATA keys and must stay the old literals — renaming them would orphan every
 * existing ledger and audit trail.  This pin exists so a future "replace all
 * team-mode" sweep fails HERE instead of silently breaking data. */
{
  const ledgerSrc = fs.readFileSync(path.join(repoRoot, "src", "tm", "ledger.ts"), "utf8")
  assert.ok(
    ledgerSrc.includes('"team-mode/ledger/"'),
    "the ledger storage prefix stays team-mode/ledger/ — renaming it orphans every existing list",
  )
  const patternsSrc = fs.readFileSync(path.join(repoRoot, "src", "envprotect", "patterns.ts"), "utf8")
  assert.ok(
    patternsSrc.includes('"team-mode-env-protect"'),
    "the audit service name stays team-mode-env-protect — it is a data key, not a display name",
  )
}
// The failure this used to guard — a plugin exporting `setup` and no `server`
// loading as NOTHING on the 1.18.x host — is now the product: 2.x is the only host
// and `setup` is the only entry. So the invariant flipped to setup-present,
// server-absent, and a re-added server() has to fail here rather than pass silently.
assert.equal(typeof plugin.setup, "function", "v2 host gate: setup() is the only entry point")
/* cfg2 was v1's second config-hook run (default TTL, no options). On 2.x there is
 * nothing to re-run — the definitions ARE the definitions — so groups 5-7 below keep
 * asserting prompt content against the same surface. That content is this suite's
 * actual subject (the static-date guard, the Han-char scan, the reply skeleton, the
 * ledger rule), and none of it depended on the loader, only on the handle to it. */
const cfg2 = { agent: agents, command: commands }

const lead = cfg.agent["Team"]
const leadPrompt = lead.prompt
assert.ok(note9.includes("/board/root"), "the board note carries the resolved root it was handed")
assert.ok(note9.includes("idle for more than 9 days"), "…and the TTL the sweep promise names")
assert.ok(leadPrompt.includes("Hybrid blackboard"), "hybrid blackboard protocol present")
assert.ok(leadPrompt.includes("TodoList discipline"), "ledger hard rule stays a prompt mandate")
assert.ok(leadPrompt.includes("BLACKBOARD WRITE FAILED"), "lead fallback rule")
assert.equal(lead.mode, "primary", "team visible in Desktop switcher")
assert.ok(cfg.command["team-run"].template.includes("Approval gate"), "team-run template updated")
assert.ok(cfg.command["team-plan"].agent === "architect", "command agent binding")

/* the definition shapes gen-v2-config.mjs projects into agents/*.md */
for (const [name, a] of Object.entries(cfg.agent)) {
  assert.equal(typeof a.prompt, "string", name + ": prompt is a string (the generator writes it as the file body)")
  assert.equal(a.system, undefined, name + ": no stray system field — the body IS the prompt")
  assert.ok(a.permission && typeof a.permission === "object", name + ": permission map present (becomes action/resource/effect triples)")
}
const EXPERTS = ["architect", "implementer", "reviewer", "tester", "researcher"]
/* T2.1 whitelist (as revised by the T2.1 review): edit/write granted only
 * to implementer + tester; bash granted to the execution roles
 * (implementer / reviewer / tester, plus the team lead) so npm test / tsc /
 * --help probes actually run; architect + researcher stay bash-free —
 * intentional trimming, their work is pure reading.  Roles without
 * edit/write ride the BLACKBOARD WRITE FAILED inline fallback for
 * oversized board artifacts. */
const EDIT_GRANTED = ["implementer", "tester"]
const BASH_GRANTED = ["implementer", "reviewer", "tester"]
// v1 escalated the bash slot here to a pattern OBJECT so the host's dialog gated
// the R6 env face + R2 danger face while the default `*` stayed allow. The v1
// loader is cut; on 2.x the same protection is the guard's per-command classifier
// plus one coarse `shell -> ask` triple when that hook is not installed (both
// pinned by test-v2-adapter, the pattern builder itself by test-envprotect). So
// the definition matrix carries the plain grant and asserting the ask-object here
// would assert a shape the product no longer produces.
for (const expert of EXPERTS) {
  const a = cfg.agent[expert]
  assert.equal(a.mode, "subagent", expert + " is subagent")
  assert.ok(a.prompt.includes("## Blackboard rules"), expert + " has blackboard rules")
  // The board used to require a file tool, so for architect/researcher (no
  // write, no edit, not even bash) every oversized deliverable was forced
  // inline.  The writer is now named in every role's own rules.
  assert.ok(a.prompt.includes("tm_board_write"), expert + " is told how to reach the board without a file tool")
  assert.ok(!a.prompt.includes("(architect / reviewer)"), expert + ": the stale 'who cannot write' list is gone — it named the wrong roles")
  assert.ok(a.prompt.includes("STATUS:"), expert + " reply skeleton opener")
  assert.ok(a.prompt.includes("HANDOFF:"), expert + " handoff field")
  assert.ok(a.prompt.includes("Never hand the full deliverable back"), expert + " blocks transcribe-escape")
  assert.equal(
    a.permission.edit,
    EDIT_GRANTED.includes(expert) ? "allow" : "deny",
    expert + " edit slot matches whitelist (WORKSPACE edits only where granted; the board has its own writer)",
  )
  assert.equal(
    a.permission.bash,
    BASH_GRANTED.includes(expert) ? "allow" : "deny",
    expert + " bash slot matches the execution-role matrix (the ask escalation lives in the v2 permission layer now)",
  )
  assert.equal(a.permission["tm_*"], "allow", expert + " governed tm_* tools whitelisted")
  assert.equal(a.temperature, 0.2, expert + " low-temperature format discipline")
}
assert.equal(cfg.agent["architect"].permission.bash, "deny", "architect stays bash-denied")
assert.equal(cfg.agent["Team"].permission.bash, "allow", "lead bash granted — the R6/R2 gate is the guard's job, not the definition's")
/* dead-popup guard retired with the v1 config hook. The rule it protected (never
 * promise a dialog that cannot arm) is alive on 2.x in a different place: the
 * guard fails CLOSED with a v2-worded refusal instead of asking, and the R6/R2
 * classification itself is pinned per command line in test-envprotect §7. */
console.log("4b. dead-popup guard: SKIPPED — v1 config hook removed; 2.x fails closed (test-envprotect §7, test-v2-adapter consent group)")
assert.equal(cfg.agent["Team"].permission.edit, "allow", "lead edit allowed (<=10-line non-product edits)")
assert.equal(cfg.agent["Team"].permission.task, "allow", "lead task dispatch allowed")
assert.deepEqual(cfg.agent["Team"].permission.tm_webfetch, { "*": "ask" }, "lead: web channel carries the ask-map (out-of-allowlist targets pop the official dialog)")
assert.equal(cfg.agent["implementer"].permission.tm_webfetch, "deny", "implementer is NOT a network role")
assert.deepEqual(cfg.agent["researcher"].permission.tm_webfetch, { "*": "ask" }, "researcher: web channel carries the ask-map")
assert.equal(cfg.agent["Team"].permission.browser, undefined, "lead: the native browser catalog is left to the host (no blanket deny)")
assert.equal(cfg.agent["implementer"].permission.browser, "deny", "implementer is NOT a network role (native browser denied)")
assert.equal(cfg.agent["implementer"].permission.tm_memory, "allow", "memory store: all roles (not a network channel)")
assert.equal(cfg.agent["Team"].permission.tm_ledger, undefined, "the ledger is NOT named in the matrix — v2-permissions grants tm_ledger by role name, so a second source of the rule would drift")
assert.equal(cfg.agent["Team"].permission.question, "allow", "lead: question granted (batched blocking questions)")
assert.equal(cfg.agent["implementer"].permission.question, "deny", "specialists: question denied (lead-only)")
assert.equal(Object.keys(cfg.agent).length, 6, "exactly 6 agents injected")
assert.equal(Object.keys(cfg.command).length, 6, "exactly 6 commands injected")

/* v1's config-hook idempotence and default-agent promotion retired with the
 * loader. The 2.x equivalents are real and pinned where they now live: the
 * generator refuses files it did not write (marker check, --force to override) and
 * `editor.default("Team")` owns the default slot — test-v2-adapter's generation and
 * default-slot groups. What stays here is this suite's own subject: the note. */
assert.ok(blackboardNote("/board/root", 5).includes("idle for more than 5 days"), "default TTL 5d in the note the lead is handed")
console.log("4c. default-agent promotion (v1 config hook): SKIPPED — 2.x promotion is editor.default(\"team\"), pinned by test-v2-adapter")

/* v1.4.3 (kept): triage gate + user boundaries */
assert.ok(leadPrompt.includes("Triage — classify before acting"), "lead: triage gate")
assert.ok(leadPrompt.includes("Question ≠ work order"), "lead: question-not-workorder rule")
assert.ok(leadPrompt.includes("USER-STATED BOUNDARIES ARE SUPREME"), "lead: user boundary supremacy")

/* v1.4.7: deterministic routing table */
assert.ok(leadPrompt.includes("## Routing table"), "lead: routing table present")
assert.ok(leadPrompt.includes("PRODUCT BEHAVIOR CHANGE"), "lead: product-change definition")
assert.ok(leadPrompt.includes("implementer → tester → reviewer"), "lead: fixed minimum pipeline")
assert.ok(leadPrompt.includes("FIXED MINIMUM PIPELINES"), "lead: pipeline minimums")
assert.ok(leadPrompt.includes("ANTI-SPLITTING"), "lead: anti-splitting rule")
assert.ok(leadPrompt.includes("Discovery gate"), "lead: pre-implementation discovery (kept)")
assert.ok(leadPrompt.includes("Brevity discipline"), "lead: <=5-line planning text")

/* T3: delegation guidance + pre-commit hygiene (lead side) */
assert.ok(leadPrompt.includes("## Delegation"), "lead: delegation section present")
assert.ok(
  leadPrompt.indexOf("## Routing table") < leadPrompt.indexOf("## Delegation") &&
    leadPrompt.indexOf("## Delegation") < leadPrompt.indexOf("## Approval gate"),
  "lead: delegation section sits between routing table and approval gate",
)
// The removal itself has to be pinned: a model that remembers tm_dispatch from
// a previous session must find the door closed in writing.
assert.ok(leadPrompt.includes("You do not spawn sub-agents"), "lead: the plugin-side dispatcher is closed by rule, not left to preference")
assert.ok(leadPrompt.includes("governed, visible, killable"), "lead: WHY the host's task is the only delegation channel")
assert.ok(leadPrompt.includes("Pick the shape by rule"), "lead: background vs synchronous task is a rule, not a coin flip")
assert.ok(
  leadPrompt.includes("you would only park waiting for it"),
  "lead: background is only for work the lead actually keeps following up on",
)
assert.ok(leadPrompt.includes("the host wakes you with the result"), "lead: the background contract says who delivers the answer")
assert.ok(leadPrompt.includes("Write a SELF-CONTAINED brief"), "lead: dispatch briefs must stand alone (child sees no history)")
assert.ok(leadPrompt.includes("quick / standard /"), "lead: the brief carries an expected thoroughness level")
assert.ok(leadPrompt.includes("While they run, keep working — on lead work only"), "lead: the leader works during the wait, and only on lead work")
assert.ok(leadPrompt.includes("Do NOT pull big payloads into your\n  own context while waiting"), "lead: leader context discipline — delegated bulk stays delegated")
assert.ok(leadPrompt.includes("Slow shell work is parallel too"), "lead: the background shell is named as the shell-side parallel lever")
assert.ok(leadPrompt.includes("Collect with **tm_join**"), "lead: tm_join is the collection path")
assert.ok(leadPrompt.includes("Never end a turn with a child still uncollected"), "lead: no orphaned children at end of turn")
assert.ok(leadPrompt.includes("cancel: true"), "lead: a runaway child is abortable")
assert.ok(leadPrompt.includes("Say who is running"), "lead: a turn that ends with work open must name the live children")
assert.ok(
  leadPrompt.includes("line the user cannot expand"),
  "lead: WHY the tool card cannot be trusted to speak for itself",
)
assert.ok(leadPrompt.includes("your context is the team's scarce"), "lead: division of labour framed as context economy")
assert.ok(
  leadPrompt.includes("A wait is not\n  parallelism"),
  "lead: chained tm_join waits are named as the pattern that throws the parallelism away",
)
assert.ok(
  leadPrompt.includes("OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
  "lead: the host flag that decides whether background is real is named where the choice is made",
)
assert.ok(
  leadPrompt.includes("Say that you are waiting"),
  "lead: a wait must be announced — the user cannot tell a blocked turn from a finished task",
)
assert.ok(
  leadPrompt.includes("is NOT a finished task"),
  "lead: the announcement says explicitly that the task is not finished",
)
assert.ok(leadPrompt.includes("Parallel-safe"), "lead: what may run at once stays enumerated")
assert.ok(leadPrompt.includes("Must serialize"), "lead: what must not stays enumerated")
// async dispatch makes multi-in_progress normal, and order is negotiable
assert.ok(leadPrompt.includes("SEVERAL items"), "lead: parallel dispatch explicitly licenses several in_progress items")
assert.ok(leadPrompt.includes("ORDER IS A DEFAULT, NOT A LAW"), "lead: todo-list order yields to parallelism")
assert.ok(leadPrompt.includes("fire every package whose inputs already exist"), "lead: scan the whole list for dispatchable work each round")
assert.ok(leadPrompt.includes("Partition before you parallelize"), "lead: file-ownership partition is the precondition for parallel work")
assert.ok(leadPrompt.includes("never let two agents edit one file"), "lead: children must not collide")
assert.ok(leadPrompt.includes("Reuse before you build"), "lead: existing dependencies are checked before designing a new module")
// goal directive: the user's own ask is the contract, and it decides when the
// run may end
assert.ok(leadPrompt.includes("Goal directive — the user's own ask is the contract"), "lead: goal directive section present")
assert.ok(leadPrompt.includes("ACCEPTANCE:"), "lead: the goal is stated as checkable acceptance criteria")
assert.ok(leadPrompt.includes("The run ends when the criteria are met, not when it is convenient"), "lead: stopping is gated on evidence, not on effort spent")
assert.ok(leadPrompt.includes("reframing a partial"), "lead: partial-as-final is named as the failure mode")
assert.ok(leadPrompt.includes("Do not shrink the goal, and do not grow it"), "lead: scope is the user's call in both directions")
assert.ok(leadPrompt.includes("USER-STATED BOUNDARIES STILL OUTRANK THE GOAL"), "lead: a goal never licenses crossing a user-set limit")
assert.ok(leadPrompt.includes("EVERY NEW ASK BECOMES A LIST ITEM"), "lead: a new request enters the ledger before the work starts")
assert.ok(leadPrompt.includes("INSERTION, not a replacement"), "lead: an interruption keeps the interrupted item alive")
assert.ok(leadPrompt.includes("Blocked is a state, not an exit"), "lead: blocked items stay in the list with a reason")
assert.ok(leadPrompt.includes("re-read the list FIRST"), "lead: after a resume/compaction the unfinished items come first")
assert.ok(cfg2.agent["implementer"].prompt.includes("Multi-part briefs"), "implementer: the ledger habit reaches the specialist reply contract")
assert.ok(cfg2.agent["tester"].prompt.includes("not done: <part>"), "tester: an unfinished part must be named, not dropped")
assert.ok(leadPrompt.includes("already available,"), "lead: 'already available, use it' is stated as the better outcome")
assert.ok(leadPrompt.includes("The team exists to be FASTER"), "lead: throughput is the justification for the team")
assert.ok(leadPrompt.includes("Slow shell work is parallel too"), "lead: slow independent shell steps go to the host's background shell, not one chained call")
assert.ok(cfg2.agent["implementer"].prompt.includes("Presentation (the host renders Markdown"), "implementer: presentation-shape section present")
// The renderer's supported set was MEASURED on the host, not inferred from
// CommonMark — and the first version of this section got it backwards in both
// directions (it promised footnotes and $-math, which arrive as literal text,
// and it forbade mermaid, which draws).  So the negative half is pinned as
// loudly as the positive: a prompt that names an unsupported shape is a defect
// the user has to find.
assert.ok(cfg2.agent["implementer"].prompt.includes("```mermaid```"), "implementer: mermaid offered as a shape the host draws")
assert.ok(!/Mermaid is NOT drawn/.test(cfg2.agent["implementer"].prompt), "implementer: the stale 'mermaid is not drawn' claim is gone")
assert.ok(!/KaTeX/.test(cfg2.agent["implementer"].prompt), "implementer: no unmeasured KaTeX promise left in the supported list")
assert.ok(!/block quotes, footnotes/.test(cfg2.agent["implementer"].prompt), "implementer: footnotes are no longer promised as a supported shape")
for (const lit of ["footnotes", "==highlight==", "<hr>", "definition lists", ":short_code:", "LITERAL TEXT"]) {
  assert.ok(cfg2.agent["implementer"].prompt.includes(lit), `implementer: the unsupported-shape list names ${lit}`)
}
assert.ok(cfg2.agent["implementer"].prompt.includes("markdown\n  TABLE with stable\n  columns") || /TABLE with stable/.test(cfg2.agent["implementer"].prompt), "implementer: findings/reports use a table shape")
assert.ok(cfg2.agent["implementer"].prompt.includes("`shell` with\n  `background:true`"), "implementer: the time budget names the host's own background shell for slow independent steps")
/* The v1 cut ends at the prompt layer: a role may not be told to reach for a
 * tool this package no longer registers.  The banned set is DERIVED from
 * `V1_ONLY_TOOLS` (src/host/v2-permissions.ts, the one source — five names as
 * of this writing, and a hand-written copy here is exactly how this suite once
 * scanned four while five were retired) plus `todowrite`, which a 2.x host
 * never had.  `task tool` is the v1 name for what v2 calls `subagent`, so it is
 * banned by pattern, and BARE `task` / `bash` are deliberately NOT: they are
 * ordinary prose in these prompts and a word-level ban would only manufacture
 * red.  The scan runs on BOTH layers, because they are not the same text:
 * `V2_TEXT` lives only in the projection, so a source-only scan cannot see a
 * stale sentence that the fork table failed to rewrite — that is precisely how
 * "via the Task tool" reached agents/team.md while this group stayed green.
 * Banned by assertion, not left to chance, because a stale sentence loads fine
 * and costs the round it points at.  And the batching red line must name the
 * tool that replaced it, or the mandate cannot be walked. */
// `tm_browser` is added EXPLICITLY: it is not in V1_ONLY_TOOLS (it was a v2
// tool), but it retired with the native-browser-only route (2026-10-06), so a
// prompt that still names it points at a tool this package no longer ships.
const RETIRED_TOOL_NAMES = [...v2perm.V1_ONLY_TOOLS, "todowrite", "tm_browser"]
const BANNED_RES = [
  ...RETIRED_TOOL_NAMES.map((n) => new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")),
  /task\s+tool/i,
]
/** Whitespace-folded + case-insensitive: the projection re-wraps every line. */
const bannedHit = (text) => {
  const flat = String(text ?? "").replace(/\s+/g, " ")
  const hit = BANNED_RES.find((re) => re.test(flat))
  return hit ? `/${hit.source}/i` : null
}
for (const [id, agent] of Object.entries(cfg2.agent)) {
  const hit = bannedHit(agent.prompt)
  assert.ok(!hit, `${id}: prompt never names a retired tool (${hit ?? ""})`)
  assert.ok(String(agent.prompt ?? "").includes("execute"), `${id}: the batching mandate names the host's Code Mode tool`)
}
for (const [id, cmd] of Object.entries(cfg2.command)) {
  const hit = bannedHit(cmd.template)
  assert.ok(!hit, `${id}: command template never names a retired tool (${hit ?? ""})`)
}
console.log("4d. the v2 projection ON DISK — a retired name may not survive the fork")
{
  const genRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bb-gen-"))
  try {
    execFileSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "gen-v2-config.mjs"), "--dir", genRoot],
      { cwd: repoRoot, stdio: "pipe" },
    )
    const md = ["agents", "commands"].flatMap((sub) =>
      fs.readdirSync(path.join(genRoot, sub)).map((f) => path.join(genRoot, sub, f)),
    )
    assert.equal(md.length, 12, "the generator wrote 6 roles + 6 commands (a vacuous scan is not a pass)")
    for (const file of md) {
      const hit = bannedHit(fs.readFileSync(file, "utf8"))
      assert.ok(!hit, `${path.basename(file)}: the generated markdown on disk never names a retired tool (${hit ?? ""})`)
    }
    console.log("   OK (12 generated .md files scanned for the DERIVED retired set + `task tool`)")
  } finally {
    fs.rmSync(genRoot, { recursive: true, force: true, maxRetries: 3 })
  }
}
assert.ok(cfg2.agent["reviewer"].prompt.includes("backslash") || cfg2.agent["reviewer"].prompt.includes("\\("), "reviewer: the math delimiters that ACTUALLY render are named")
assert.ok(leadPrompt.includes("## Output shape (the host renders Markdown"), "lead: presentation discipline present")
assert.ok(leadPrompt.includes("```mermaid``` diagrams, which this host draws"), "lead: mermaid offered, per the measurement")
assert.ok(!/Mermaid is\nNOT drawn/.test(leadPrompt), "lead: the stale 'mermaid is not drawn' claim is gone")
assert.ok(leadPrompt.includes("it is a defect you shipped"), "lead: guessing at the renderer is named as shipping a defect")
assert.ok(leadPrompt.includes("Pre-commit hygiene"), "lead: hygiene check before ANY commit")

/* v1.4.7: approval gate + uncertainty policy + no-ceremony fast path */
assert.ok(leadPrompt.includes("## Approval gate"), "lead: approval gate present")
assert.ok(leadPrompt.includes("≥2 dispatches"), "lead: gate triggers at 2 dispatches")
assert.ok(leadPrompt.includes("END YOUR TURN"), "lead: waits for user approval")
assert.ok(leadPrompt.includes("MID-RUN UPGRADE"), "lead: mid-run escalation to the gate")
assert.ok(leadPrompt.includes("ask early, ask once"), "lead: batched blocking questions")
assert.ok(leadPrompt.includes("Skip the ceremony"), "lead: verified root cause goes straight to fix")
assert.ok(leadPrompt.includes("≤30 lines"), "lead: plan length cap")

/* v1.4.7: adaptive review replaces fixed Ultra Review */
assert.ok(leadPrompt.includes("## Adaptive review"), "lead: adaptive review present")
assert.ok(leadPrompt.includes("ONE reviewer dispatch"), "lead: single-reviewer default")
assert.ok(leadPrompt.includes("EXACTLY 3 parallel reviewer dispatches"), "lead: 3-dim escalation count")
assert.ok(!leadPrompt.includes("Ultra Review"), "lead: fixed ultra review removed")

/* v1.4.7: reply-skeleton enforcement loop */
assert.ok(leadPrompt.includes("PROTOCOL_VIOLATION"), "lead: skeleton enforcement retry")
assert.ok(leadPrompt.includes("Relay the HANDOFF content verbatim"), "lead: handoff passthrough")

/* v1.4.7: hybrid blackboard (JSON first, files only oversized) */
assert.ok(leadPrompt.includes("NO MANIFEST"), "lead: MANIFEST.md removed")
assert.ok(!leadPrompt.includes("MANIFEST.md is"), "lead: no MANIFEST state board")
assert.ok(leadPrompt.includes("<session-key>"), "lead: session layer in board paths")
/* No absolute date in anything the model reads.  A desktop plugin lives in a
   process that runs for days (the README's restart section is the proof), so a
   "current month" or "as of 2026-09" baked into a prompt/description goes stale
   silently — and the stale one is worse than none, because the model trusts it.
   Recency therefore has exactly one legal home: strings rendered per call
   (tm_search's date line, searchDateLine), never a constant. */
{
  const dated = /20\d{2}-\d{2}-\d{2}|20\d{2}年\d{1,2}月|as of 20\d\d/i
  const offenders = [
    ...Object.entries(cfg2.agent).filter(([, a]) => dated.test(String(a.prompt ?? ""))).map(([n]) => `${n}.prompt`),
    ...Object.entries(cfg2.command).filter(([, c]) => dated.test(String(c.template ?? ""))).map(([n]) => `${n}.template`),
  ]
  assert.deepEqual(offenders, [], "no injected prompt or command template carries an absolute date")
  /* The prompts are English, and the ONLY legal Chinese in one is a verbatim tool
     string.  The user's rule (2026-09-25): nothing in a prompt may prescribe Chinese
     wording for what the agent writes — reply language follows the REQUEST.  The
     verbatim strings stay because they ARE the evidence a later reader can grep for
     (goal 6 / principle 10): a translated close verdict is a claim nobody can re-check.
     So the set is CLOSED: a new Chinese token in a prompt fails here and names itself,
     which is the difference between a rule and a hope. */
  {
    const VERBATIM_TOOL_STRINGS = [
      "已确认关闭", "进程未核验", "警告", "关闭未完全成功", "无人应答", "已合并",
      "个可寻址节点", "域名不在白名单", "需批准", "在白名单内", "静态白名单",
      "你刚批准的窗", "宿主按已记住的", "始终允许", "秒回", "该",
      "个子资源请求被拦截",
    ]
    const strayByRole = []
    for (const [name, a] of Object.entries(cfg2.agent)) {
      const stray = [...new Set(String(a.prompt ?? "").match(/[一-鿿]+/g) ?? [])].filter((t) => !VERBATIM_TOOL_STRINGS.includes(t))
      if (stray.length) strayByRole.push(`${name}: ${stray.join("、")}`)
    }
    for (const [name, c] of Object.entries(cfg2.command)) {
      const stray = [...new Set(String(c.template ?? "").match(/[一-鿿]+/g) ?? [])].filter((t) => !VERBATIM_TOOL_STRINGS.includes(t))
      if (stray.length) strayByRole.push(`command ${name}: ${stray.join("、")}`)
    }
    assert.deepEqual(strayByRole, [], "no prompt prescribes Chinese wording — the only Chinese left is a quoted tool verdict")
  }
  // and the one place a date IS stated is rendered from the clock, per call
  const wfDate = await import("./dist/tm/webfetch.js")
  assert.notEqual(
    wfDate.searchDateLine(new Date(2026, 0, 31)),
    wfDate.searchDateLine(new Date(2026, 1, 1)),
    "the recency line is a function of the clock, not a constant",
  )
}
// The lead names the session folder and the task; the WRITER chooses the file.
// Passing the folder down is load-bearing, because a bash-less role cannot
// invent a timestamp of its own.
assert.ok(
  leadPrompt.includes("tm_board_write") && /PASS IT in every\s+dispatch/.test(leadPrompt),
  "lead: dispatches carry the session folder to the roles that cannot stamp one",
)
assert.ok(!leadPrompt.includes("DELETE the task directory"), "lead: no manual-delete instruction left")
assert.ok(leadPrompt.includes("TTL sweeper"), "lead: TTL sweeper is sole cleanup path")
assert.ok(leadPrompt.includes("VERBATIM CONTRACTS"), "lead: api-contract verbatim rule (kept)")
assert.ok(leadPrompt.includes("## Evidence standard"), "lead: evidence standard (kept)")
assert.ok(leadPrompt.includes("## Docs sync"), "lead: docs-sync rule (CHANGELOG + AGENTS.md)")
assert.ok(leadPrompt.includes("## Efficiency first"), "lead: the efficiency mandate is there, spelled in English like the rest of the prompt")
assert.ok(leadPrompt.includes("## Reply language"), "lead: output language follows the USER, not the tool output")
assert.ok(
  leadPrompt.indexOf("## Efficiency first") < leadPrompt.indexOf("## Routing table"),
  "lead: the efficiency mandate is stated BEFORE the table it justifies (a rule after its exception cannot bind)",
)
// #49 feature 4: the split discipline.  The section must name the ONE property
// that separates splitting from chopping — each piece is independently
// verifiable — because a rule that only says "split big tasks" invites the
// model to cut a deliverable into pieces that only make sense together.
assert.ok(leadPrompt.includes("## Task splitting"), "lead: the task-splitting discipline is a named section")
assert.ok(
  leadPrompt.includes("independently verifiable"),
  "lead: splitting names the property that separates it from chopping (each piece stands on its own)",
)
assert.ok(
  leadPrompt.indexOf("## Task splitting") < leadPrompt.indexOf("## Routing table"),
  "lead: the split rule sits with the efficiency mandate, before the routing table",
)
// The split rule's two load-bearing halves: the >3-criteria trigger and the
// price of ignoring it.  A section that only says "split big tasks" leaves
// the oversized dispatch looking like a saving.  (Both sentences predate the
// speed-lever change — these two are PRE-EXISTING pins, not new ones.)
assert.ok(leadPrompt.includes("more than three acceptance criteria"), "lead: >3 acceptance criteria is the named split trigger (pre-existing pin)")
assert.ok(leadPrompt.includes("paid back with interest"), "lead: the anti-pattern prices the oversized dispatch (pre-existing pin)")
// The architect is conditional, and the routing table has to say so: the
// "Skip the ceremony" fast path and a table that mandates the architect for
// every multi-module change cannot both be true.
assert.ok(leadPrompt.includes("architect (only when the design is genuinely unknown)"), "lead: the routing table makes the architect conditional")
assert.ok(leadPrompt.includes("The architect is CONDITIONAL"), "lead: the conditional-architect rule is stated, not implied")
assert.ok(leadPrompt.includes("dispatch architect/researcher/reviewer"), "lead: the skip-the-ceremony list names the architect too")
assert.ok(
  leadPrompt.includes("if the fix moves a contract or the strategy is undecided, keep the\n  architect"),
  "lead: a proven root cause does not skip the architect when the fix moves a contract",
)
// Verification and review are independent, so they may share a round; the
// serialize rule survives only for the case where a fix invalidates both.
assert.ok(leadPrompt.includes("Tester and\n  reviewer may run in the SAME round"), "lead: tester + reviewer may share a round")
assert.ok(leadPrompt.includes("serialize them only when a fix\n  invalidates both"), "lead: the serialize rule survives for the invalidating-fix case")
// The lead's own recon is rounds too — the measured failure is named, and the
// rule names the SHAPE per tool family: native probes cannot fold into `execute`
// (measured: `tools["read"]` → `Unknown tool 'read'`), so they batch as
// parallel calls in one message; only governed tm_* probes fold into a program.
assert.ok(leadPrompt.includes("≥3 native recon probes"), "lead: native recon batches as parallel calls in one message")
assert.ok(leadPrompt.includes("PARALLEL calls in ONE message"), "lead: the native half of the batching rule names the shape")
assert.ok(leadPrompt.includes("the native file/shell tools are not callable there"), "lead: the batching rule says why native probes cannot fold into execute")
assert.ok(!leadPrompt.includes("when ≥3 of your own reads / greps"), "lead: the old (wrong) batching sentence is gone")
assert.ok(leadPrompt.includes("collapse into ONE `execute` (Code Mode)"), "lead: governed tm_* probes collapse into one Code Mode program")
assert.ok(leadPrompt.includes("~400 narrow calls"), "lead: the batching rule carries the measured failure it prevents")

assert.ok(leadPrompt.includes("update AGENTS.md"), "lead: AGENTS.md sync duty")
assert.ok(leadPrompt.includes("Repo hygiene applies to you too"), "lead: repo hygiene rule (temp files deleted / OS temp dir)")
assert.ok(leadPrompt.includes("Tool-first, memory-second"), "lead: tool-first lookup rule (scan tool surface, concrete call, no simulation)")
assert.ok(leadPrompt.includes("colloquial/abbreviated/aliased terms"), "lead: term-expansion rule (generic, no baked-in examples)")
assert.ok(leadPrompt.includes("CHANGELOG.md"), "lead: changelog maintenance (kept)")
assert.ok(leadPrompt.includes("read the project's README"), "lead: README-first (kept)")
assert.ok(leadPrompt.includes("the host usually injects them"), "lead: AGENTS.md/CLAUDE.md dedup vs host injection")

/* v1.4.7: specialist prompts */
const reviewerP = cfg2.agent["reviewer"].prompt
assert.ok(reviewerP.includes("EXACTLY ONE dimension"), "reviewer: single-dimension role")
assert.ok(reviewerP.includes("completeness") && reviewerP.includes("correctness") && reviewerP.includes("impact"), "reviewer: three dimensions named")
assert.ok(reviewerP.includes("review correctness and say so"), "reviewer: default-dimension fallback")
assert.ok(reviewerP.includes("## Dimension checklists"), "reviewer: per-dimension checklists")
const testerP = cfg2.agent["tester"].prompt
assert.ok(testerP.includes("## Verification stack"), "tester: static verification stack")
assert.ok(testerP.includes("typecheck"), "tester: typecheck layer")
assert.ok(testerP.includes("## Prohibited improvisation"), "tester: no improvised environment hacks")
assert.ok(testerP.includes("headless"), "tester: headless ban explicit")
assert.ok(!testerP.includes("UI verification mode"), "tester: old UI automation mode removed")
assert.ok(testerP.includes("UI NOT VERIFIED:"), "tester: honest no-tooling fallback")
for (const expert of EXPERTS) {
  assert.ok(cfg2.agent[expert].prompt.includes("STATUS: done | blocked | failed"), expert + ": skeleton status line")

  assert.ok(cfg2.agent[expert].prompt.includes("Do not re-open"), expert + ": no README/AGENTS.md re-reading")
  assert.ok(cfg2.agent[expert].prompt.includes("## Evidence rule"), expert + ": evidence rule")
  assert.ok(cfg2.agent[expert].prompt.includes("## Efficiency first"), expert + ": the efficiency mandate is shared by every role, not just the lead")
  assert.ok(cfg2.agent[expert].prompt.includes("## Reply language"), expert + ": output language follows the user, not the tool output")
  // A Chinese tool string must not drag an English conversation into Chinese,
  // and the fix must not cost the evidence its exact wording — the two rules
  // live in the same section for that reason.
  const lang = cfg2.agent[expert].prompt.slice(cfg2.agent[expert].prompt.indexOf("## Reply language"))
  assert.ok(/verbatim/i.test(lang.split("## ")[1] ?? ""), expert + ": quoted tool strings stay verbatim (evidence precision survives translation)")

  assert.ok(cfg2.agent[expert].prompt.includes("File reads / searches / enumeration go through the built-in read / grep /\nglob tools"), expert + ": the file ladder routes reads/search/enumeration to the host's own tools")
  assert.ok(cfg2.agent[expert].prompt.includes("they ARE the governed path"), expert + ": the native ladder is stated as governed, not as an ungoverned fallback")
  assert.ok(cfg2.agent[expert].prompt.includes("## Project conventions"), expert + ": README conventions rule")
  assert.ok(cfg2.agent[expert].prompt.includes("## Repo hygiene (temp files)"), expert + ": repo hygiene rule present")
  assert.ok(cfg2.agent[expert].prompt.includes("DELETED before you report done"), expert + ": scratch/temp files deleted before done (repo never polluted)")
  assert.ok(cfg2.agent[expert].prompt.includes("Prefer the OS temp dir"), expert + ": throwaway work goes to the OS temp dir")
  assert.ok(cfg2.agent[expert].prompt.includes("not owned by the plan"), expert + ": one-off verification tests never enter the repo (plan ownership)")
  assert.ok(cfg2.agent[expert].prompt.includes("## Pre-commit hygiene"), expert + ": pre-commit hygiene section present")
  assert.ok(cfg2.agent[expert].prompt.includes("to `.gitignore` in the same commit"), expert + ": untracked noise auto-ignored before commit")
  assert.ok(cfg2.agent[expert].prompt.includes("Never stage a `.env`-class file without explicit user confirmation"), expert + ": .env git-add guard needs user consent (separate from R6 reads)")
  assert.ok(cfg2.agent[expert].prompt.includes("## Use your tools first"), expert + ": tool-first lookup rule present")
  assert.ok(cfg2.agent[expert].prompt.includes("never answer unverified from memory"), expert + ": memory-second rule explicit")
  assert.ok(cfg2.agent[expert].prompt.includes("Expand colloquial, abbreviated, or aliased terms"), expert + ": term-expansion rule (generic, no baked-in examples)")
  assert.ok(cfg2.agent[expert].prompt.includes("never simulate"), expert + ": removed-tool capability reported as a gap, never simulated")
  assert.ok(cfg2.agent[expert].prompt.includes("## Layered memories (project + global)"), expert + ": layered memory rule present")
  assert.ok(cfg2.agent[expert].prompt.includes("run tm_memory search"), expert + ": memory pull-model instruction (search before assuming)")
  assert.ok(cfg2.agent[expert].prompt.includes("project entries take precedence"), expert + ": layered memories — project entries take precedence over global")
  /* T1: three-tier memory + near-duplicate merge + compaction runbook (shared.ts) */
  assert.ok(cfg2.agent[expert].prompt.includes("## Memory tiers, dedup and compaction"), expert + ": memory tiers/dedup/compaction section present")
  assert.ok(cfg2.agent[expert].prompt.includes("Precedence on retrieval is session > project >"), expert + ": three-tier retrieval precedence spelled out (session > project > global)")
  assert.ok(cfg2.agent[expert].prompt.includes("已合并"), expert + ": near-duplicate add folds and answers 已合并 (do not re-add)")
  assert.ok(cfg2.agent[expert].prompt.includes("apply:true"), expert + ": compact is dry-run by default, apply:true performs it")
  assert.ok(cfg2.agent[expert].prompt.includes(".compact-backup"), expert + ": .compact-backup tree is the compaction rollback path")
  assert.ok(
    cfg2.agent[expert].prompt.includes("Web lookups are NOT yours unless tm_search / tm_webfetch"),
    expert + ": web boundary rule (network roles are lead + researcher only)",
  )
  assert.ok(
    cfg2.agent[expert].prompt.includes("the host's native browser tools for UI verification"),
    expert + ": web boundary rule names the tester's browser-only exception",
  )
  assert.ok(cfg2.agent[expert].prompt.includes("1. The user's OWN tools"), expert + ": priority ladder rung 1 (the user's own MCP/plugin tools come first)")
  assert.ok(cfg2.agent[expert].prompt.includes("2. TeamMode governed tools (tm_*)"), expert + ": priority ladder rung 2 (tm_* is the governed default, not the shadow)")
  assert.ok(cfg2.agent[expert].prompt.includes("3. Your own reasoning"), expert + ": priority ladder rung 3 (reasoning, never fabricate)")
  assert.ok(
    cfg2.agent[expert].prompt.includes("ONE exception, on the web channel"),
    expert + ": the web channel keeps tm_* first (allowlist + dialog + offload are the reason)",
  )
  assert.ok(
    cfg2.agent[expert].prompt.includes("ONE-LINE card with no body") && cfg2.agent[expert].prompt.includes("tm_stats { recent: 20 }"),
    expert + ": the un-openable tool card is named, and tm_stats recent is the way to show details",
  )
  assert.ok(
    cfg2.agent[expert].prompt.includes("Plan-time rule: the moment your plan lists ≥3") &&
      cfg2.agent[expert].prompt.includes("The native tools are NOT callable inside `execute`"),
    expert + ": the batch trigger is plan-time and states the TRUE shape (native probes are parallel calls in one round, not an `execute` program)",
  )
  assert.ok(cfg2.agent[expert].prompt.includes("PARALLEL tool"), expert + ": independent native probes are batched as parallel tool calls in one message")
  assert.ok(cfg2.agent[expert].prompt.includes("typeof tools.read"), expert + ": the `typeof` false positive is named, so a role cannot trust it")
  assert.ok(cfg2.agent[expert].prompt.includes("ITS CATALOG lists"), expert + ": `execute` is scoped to the tools the Code Mode catalog actually lists")
  assert.ok(cfg2.agent[expert].prompt.includes("read / grep / glob / shell alike"), expert + ": the batch trigger counts the host's own tool calls, not only tm_* ones")
  assert.ok(cfg2.agent[expert].prompt.includes("ONE compound `shell`"), expert + ": plain-shell batches prescribe one compound command, not N round-trips")
  assert.ok(cfg2.agent[expert].prompt.includes("aggregated value at the end of the program"), expert + ": the return-data rule (unreturned inline results are lost)")
assert.ok(cfg2.agent["researcher"].prompt.includes("Recon batching (parallel calls first)"), "researcher: the parallel-calls recon section is present")
assert.ok(cfg2.agent["researcher"].prompt.includes("## Web lookups (two channels)"), "researcher: two-channel web policy (governed tools first, MCP fallback)")
assert.ok(cfg2.agent["researcher"].prompt.includes("tm_search (open-ended lookups)"), "researcher: tm_search is the open-ended lookup front")
assert.ok(cfg2.agent["researcher"].prompt.includes("engine:\"auto\" (the default)"), "researcher: tm_search auto fan-out is the documented default")
assert.ok(cfg2.agent["researcher"].prompt.includes("stackoverflow · hn · github · npm · moegirl"), "researcher: the LIVE engine roster is documented")
for (const dead of ["bing-int", "sogou", "baidu", "360"]) {
  assert.ok(
    !new RegExp(`Engines[^\\n]*${dead}`).test(cfg2.agent["researcher"].prompt),
    `researcher: dead engine ${dead} is no longer listed as a selectable engine`,
  )
}
assert.ok(cfg2.agent["researcher"].prompt.includes("never build a search URL there"), "researcher: dead CN SERPs are named as dead ends, not options")
assert.ok(cfg2.agent["researcher"].prompt.includes("ONE SEARCH IS A SAMPLE, NOT A SEARCH"), "researcher: multi-query refinement loop is mandatory (no one-shot search)")
// A thin/empty snapshot is a claim about the page or about our own gate, never
// about the site being empty — and a human-verification wall is a different
// fact again whose move is another source.
assert.ok(
  cfg2.agent["researcher"].prompt.includes("human-verification wall"),
  "researcher: a human-verification wall is a different fact, and its move is another source",
)
assert.ok(
  cfg2.agent["tester"].prompt.includes("never about the site being empty"),
  "tester: the same three-way reading of an empty snapshot, on the UI-verification side",
)
assert.ok(/independent web calls: two unrelated tm_search queries belong in/.test(cfg2.agent["researcher"].prompt), "researcher: independent web calls batch into one round")
assert.ok(cfg2.agent["researcher"].prompt.includes("Command time budget"), "researcher: command time budget section present")
assert.ok(cfg2.agent["researcher"].prompt.includes("does not make anything finish"), "researcher: a big timeout is explained as dead air, not speed")
assert.ok(cfg2.agent["researcher"].prompt.includes("compound form is for CHEAP probes only"), "researcher: slow independent steps must NOT be chained into one serial command")
assert.ok(cfg2.agent["implementer"].prompt.includes("Independent calls in the SAME round"), "implementer: same-round independent-call rule is shared")
assert.ok(cfg2.agent["implementer"].prompt.includes("never a 120-second command"), "implementer: probes must not carry a 120s timeout")
assert.ok(cfg2.agent["implementer"].prompt.includes("Never wait inside a command"), "implementer: no sleep/polling inside a bash command")
assert.ok(cfg2.agent["researcher"].prompt.includes("registry.npmjs.org/-/v1/search"), "researcher: npm search endpoint documented")
assert.ok(cfg2.agent["researcher"].prompt.includes("mobile.moegirl.org.cn"), "researcher: seeded web hosts documented")
assert.ok(cfg2.agent["Team"].prompt.includes("tm_search"), "lead: governed search front referenced")
assert.ok(cfg2.agent["Team"].prompt.includes("tm_webfetch"), "lead: governed web fallback referenced")
assert.ok(cfg2.agent["tester"].prompt.includes("## UI verification (the host's native browser tools"), "tester: governed UI verification section present")
assert.ok(cfg2.agent["tester"].prompt.includes("UI NOT VERIFIED"), "tester: honest-gap fallback kept alongside the browser grant")
assert.ok(cfg2.agent["Team"].prompt.includes("tm_memory search"), "lead: memory consulted during research phase")
assert.ok(cfg2.agent["Team"].prompt.includes("project layer first, global layer for cross-repo conventions"), "lead: memory layering (project layer first, global for cross-repo conventions)")
assert.ok(cfg2.agent["Team"].prompt.includes("Batch the recon as parallel read / grep calls in one round"), "lead: research-phase recon batches as parallel native calls, not inside `execute`")
}
/* v1.4.6 fix (kept): fix-mode append contradiction stays dead, round files stay */
assert.ok(!cfg2.agent["implementer"].prompt.includes("append to the same file"), "implementer: fix-mode append contradiction removed")
assert.ok(cfg2.agent["implementer"].prompt.includes("round-suffixed"), "implementer: fix mode writes new round file")

/* v1.4.7: /team-run template mirrors the new workflow */
const teamRun = cfg.command["team-run"].template
assert.ok(teamRun.includes("routing table"), "team-run: deterministic routing")
assert.ok(teamRun.includes("Approval gate"), "team-run: approval gate step")
assert.ok(teamRun.includes(">=2 sub-agent dispatches"), "team-run: gate trigger count")
assert.ok(teamRun.includes("END TURN"), "team-run: waits for approval")
assert.ok(teamRun.includes("batched into ONE message"), "team-run: uncertainty batching")
assert.ok(teamRun.includes("Skip"), "team-run: no-ceremony fast path")
assert.ok(teamRun.includes("HANDOFF"), "team-run: skeleton handoff relay")
assert.ok(teamRun.includes("PROTOCOL_VIOLATION"), "team-run: contract enforcement")
assert.ok(teamRun.includes("Adaptive review"), "team-run: adaptive review step")
assert.ok(teamRun.includes("UI NOT VERIFIED"), "team-run: honest UI relay")
assert.ok(teamRun.includes("CHANGELOG.md"), "team-run: changelog step")
assert.ok(teamRun.includes("update AGENTS.md"), "team-run: docs sync step")
assert.ok(teamRun.includes("TTL sweeper"), "team-run: TTL-only cleanup")
assert.ok(cfg.command["team-review"].template.includes("Dimension"), "team-review: dimension selector")

console.log("4. loader contract + definition surface: OK (v2-only export, 6 agents, 6 commands, note TTL)")
console.log("5. v1.4.7 contract: OK (routing, approval gate, skeleton, hybrid board, adaptive review, static verify)")
console.log("6. opt-out default-agent promotion + triage/boundaries: OK")
console.log("7. TTL-only reclamation + session-partitioned boards: OK")

// The doc-maintenance rule (user requirement 2026-09-26): README / CHANGELOG /
// AGENTS edits go through the write/edit tool, never through a generated throwaway
// patch script.  It is a prompt rule, so it needs a prompt assertion — a rule with no
// failing test behind it is a hope, and this one exists because a script did in fact
// corrupt a file the way the rule describes.
{
  const { agents } = await import("./dist/agents.js")
  const lead = agents.Team.prompt
  const specialists = Object.entries(agents).filter(([id]) => id !== "Team")
  assert.match(lead, /Docs and business context are maintained with the file write\/edit tool/,
    "the lead carries the rule for the record it owns")
  assert.match(lead, /never by\s+a generated throwaway script/, "and names the forbidden mechanism")
  // Two rules that came out of the live desktop session: a host-injected completion
  // notice must never be reported as tm_join's answer, and a tool card is plain text,
  // so any table the user should read has to be relayed into the reply body.
  assert.match(lead, /answers for itself/, "the lead must quote what tm_join actually returned")
  assert.match(lead, /NOT evidence that/, "and must not pass the host's injection off as collection")
  assert.match(lead, /The chat bubble DOES render GFM tables/, "the lead knows the bubble renders tables (measured, not guessed)")
  assert.match(lead, /a code fence does/, "and knows a fence is what makes a table show as raw pipes")
  for (const [id, cfg] of specialists) {
    assert.match(cfg.prompt, /Editing documentation is a WRITE, not a shell job/, `${id} carries the doc-write rule`)
    assert.match(cfg.prompt, /never by generating a throwaway script/, `${id} is told not to script the edit`)
  }
}

// The host's background ack tells the model "do not poll, or end your response". On v2
// that advice and the GOAL directive collide — the plugin forces background, so a sync
// dispatch is not available — and a lead that follows the ack ends the turn with the
// user's deliverable still in flight (measured in a live round: it wrote 「任务尚未结束」
// and stopped). The lead prompt must therefore own the collection rule explicitly.
{
  const { agents } = await import("./dist/agents.js")
  const lead = agents.Team.prompt
  assert.match(lead, /The host's ack is advice for the general case, not for yours/,
    "the lead is told the host's ack is not the rule for its own task")
  assert.match(lead, /ending the turn is a broken delivery/, "and why: the user re-prompts for work already dispatched")
  assert.match(lead, /tm_join \{ waitMs: … \}` once, bounded/, "with the concrete collection move, bounded")
}

// A5: on a host that delivers the tm_* family only inside Code Mode, a TOP-LEVEL
// call to tm_board_write is not a capability — the answer is `No tool named
// "tm_board_write" is currently available`, and the role that hits it recovers by
// hand-writing the file, which forfeits the three guarantees the writer exists to
// keep (never-overwrite, the NN-<role> ordinal with its -rN revision family, the
// role name read off the host's own context). So the contract names the catalog
// shape, guarded by a clause a role whose surface DOES list the tool never acts
// on — the v1 statement stays the primary one.
// A8: the tool-less roles lack a WRITER, not every tool (measured on the v2
// request surface: architect still carries four tools, without write/edit/shell).
console.log("\n8. board-write call shape (A5) + write-capable wording (A8)")
{
  const { agents } = await import("./dist/agents.js")
  const { commands } = await import("./dist/commands.js")
  const { blackboardNote } = await import("./dist/host/note.js")
  const note = blackboardNote("/board/root", 5)
  const texts = [
    ...Object.entries(agents).map(([id, cfg]) => [id, String(cfg.prompt)]),
    ["board note", note],
  ]
  for (const [id, raw] of texts) {
    const p = raw.replace(/\s+/g, " ")
    assert.match(p, /tools\.tm_board_write\(\{ task, topic, content \}\)/,
      `${id}: names the Code Mode call shape for a tm_* tool that is not top-level`)
    assert.match(p, /Code Mode catalog/, `${id}: says WHERE that tool lives`)
    assert.match(p, /tool list does not name it/,
      `${id}: the catalog move is a guard, so a role that lists the tool keeps the plain call`)
    assert.match(p, /write-capable file tool/, `${id}: the no-file-tool claim is scoped to writing`)
    assert.ok(!/no file tool at all|without a file tool|with no file tool/.test(p),
      `${id}: no prompt claims a role owns no file tool at all`)
  }
  // The v1 statement is not polluted: the tool-call shape is still what a role
  // with a top-level tm_board_write is told to use.
  for (const [id, raw] of texts.filter(([id]) => id !== "Team")) {
    assert.match(raw.replace(/\s+/g, " "), /`tm_board_write \{ task, topic, content/,
      `${id}: the plain tool-call shape is still the primary instruction`)
  }
  // The board note is NOT forked (both personalities append it verbatim), so it
  // may not name a tool one of them does not have.
  assert.ok(!/no bash/.test(note),
    "board note: host-neutral wording — it never names `bash`, which v2 calls `shell`")
  for (const [name, c] of Object.entries(commands)) {
    assert.ok(!/no file tool at all|without a file tool/.test(String(c.template)),
      `command ${name}: carries no tool-less overstatement`)
  }
  // The same overstatement lived in CODE-adjacent text too — the board tool's own
  // DESCRIPTION, its file header, the args-schema notes, and the per-role
  // comments in agents.ts. Nothing pinned those, so A8 fixed the prompts twice (and
  // P2 the descriptions) while the next refactor was free to write it back. Scan the
  // SOURCE, not dist/: dist can be stale, and a test that reads a stale artifact
  // passes while the shipped text is wrong.
  {
    const read = (rel) => fs.readFileSync(new URL(`./${rel}`, import.meta.url), "utf8").replace(/\s+/g, " ")
    const TOOLLESS = /own no file tools|no file tool at all|without a file tool|with no file tool|carry none[^.]{0,40}tool-less/
    const sources = {
      "src/tm/board.ts": read("src/tm/board.ts"),
      "src/tm/args-schema.ts": read("src/tm/args-schema.ts"),
      "src/agents.ts": read("src/agents.ts"),
    }
    for (const [name, body] of Object.entries(sources)) {
      assert.ok(!TOOLLESS.test(body), `${name}: no "role owns no file tools" claim (the writer is what they lack)`)
    }
    assert.match(sources["src/tm/board.ts"], /write-capable file tool/,
      "src/tm/board.ts: states the scoped claim positively, not just the absence")
    // The role comments used to hand-count the tm_* family ("tm_* x4") after TM_TOOLS
    // grew to seven; a number in prose is a number that goes stale.
    assert.ok(!/tm_\* x\d/.test(sources["src/agents.ts"]),
      "src/agents.ts: role comments name TM_TOOLS rather than a hand-written count")
    assert.match(sources["src/agents.ts"], /const TM_TOOLS = \[/, "src/agents.ts: TM_TOOLS is the single source the comments can point at")
  }
  console.log("   OK (catalog shape + guard in all six roles and the board note, v1 call shape intact, no tool-less overstatement left)")
}

console.log("\nALL BLACKBOARD TESTS PASSED ✅")
