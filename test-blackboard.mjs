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

const bb = await import("./dist/blackboard.js")
const plugin = (await import("./dist/index.js")).default
const ep = await import("./dist/envprotect.js")

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

/* ---------- 4. loader contract: server(input, options) -> config hook ---------- */
const cfg = { $schema: "https://opencode.ai/config.json", plugin: [] }
assert.equal(plugin.id, "team-mode", "display id")
assert.equal(typeof plugin.server, "function", "v1 loader gate: server() present")
assert.ok(!("setup" in plugin), "no dead setup property (1.18.x loader ignores it)")
/* the approval gate only arms for a client with a permission-reply path —
 * the v1 surface is postSessionIdPermissionsPermissionId (live-probed);
 * without it the config hook drops the R6 env ask face (dead-popup guard),
 * so the full ask-object contract below is pinned on a capable client */
const capableClient = () => ({
  app: { log() {} },
  postSessionIdPermissionsPermissionId: () => Promise.resolve({ data: true }),
})
const hooks = await plugin.server({ directory: process.cwd(), project: process.cwd(), client: capableClient() }, { ttlDays: 9, envProtect: true })
assert.equal(typeof hooks.config, "function", "server returns { config } hooks")
await hooks.config(cfg)

const lead = cfg.agent["team"]
const leadPrompt = lead.prompt
assert.ok(leadPrompt.includes("opencode-team"), "board root injected")
assert.ok(leadPrompt.includes("idle for more than 9 days"), "custom TTL in note")
assert.ok(leadPrompt.includes("Hybrid blackboard"), "hybrid blackboard protocol present")
assert.ok(leadPrompt.includes("TodoList discipline"), "v1.2 todolist hard rule")
assert.ok(leadPrompt.includes("BLACKBOARD WRITE FAILED"), "lead fallback rule")
assert.equal(lead.mode, "primary", "team visible in Desktop switcher")
assert.ok(cfg.command["team-run"].template.includes("Approval gate"), "team-run template updated")
assert.ok(cfg.command["team-plan"].agent === "architect", "command agent binding")

/* v1 config shapes: prompt (string) + permission (object) */
for (const [name, a] of Object.entries(cfg.agent)) {
  assert.equal(typeof a.prompt, "string", name + ": v1 prompt field set")
  assert.equal(a.system, undefined, name + ": no stray v2 system field")
  assert.ok(a.permission && typeof a.permission === "object", name + ": v1 permission object")
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
// Execution roles no longer get a bare `bash: "allow"`: the config hook
// escalates it to a pattern object so the host confirmation dialog gates the
// R6 env face + R2 danger face (default `*` stays allow — the T2.1 grant is
// preserved, only dangerous shapes now ask).  Same builder the runtime uses.
const BASH_ASK = ep.bashAskPatterns("strict")
for (const expert of EXPERTS) {
  const a = cfg.agent[expert]
  assert.equal(a.mode, "subagent", expert + " is subagent")
  assert.ok(a.prompt.includes("## Blackboard rules"), expert + " has blackboard rules")
  assert.ok(a.prompt.includes("STATUS:"), expert + " reply skeleton opener")
  assert.ok(a.prompt.includes("HANDOFF:"), expert + " handoff field")
  assert.ok(a.prompt.includes("Never hand the full deliverable back"), expert + " blocks transcribe-escape")
  assert.equal(
    a.permission.edit,
    EDIT_GRANTED.includes(expert) ? "allow" : "deny",
    expert + " edit slot matches whitelist (board writes only where granted)",
  )
  assert.deepStrictEqual(
    a.permission.bash,
    BASH_GRANTED.includes(expert) ? BASH_ASK : "deny",
    expert + " bash slot matches execution-role matrix (ask-object on exec roles)",
  )
  assert.equal(a.permission["tm_*"], "allow", expert + " governed tm_* tools whitelisted")
  assert.equal(a.temperature, 0.2, expert + " low-temperature format discipline")
}
assert.equal(cfg.agent["architect"].permission.bash, "deny", "architect stays bash-denied")
assert.deepStrictEqual(cfg.agent["team"].permission.bash, BASH_ASK, "lead bash escalated to the ask object (discovery-gate probes stay allow, dangerous shapes ask)")
/* dead-popup guard (round-fix): with NO reply-capable client the gate cannot
 * arm, so the config hook drops the R6 env ask face (the R6 hook would
 * hard-throw every env read before such a dialog could ever be satisfied)
 * while the R2 danger face stays — its dialog is its own gate */
const hooksNoGate = await plugin.server({ directory: process.cwd(), project: process.cwd() }, { ttlDays: 9, envProtect: true })
const cfgNoGate = {}
await hooksNoGate.config(cfgNoGate)
assert.equal(cfgNoGate.agent.team.permission.bash["printenv *"], undefined, "no R6 env ask face while the gate cannot arm")
assert.equal(cfgNoGate.agent.team.permission.bash["rm *"], "ask", "R2 danger face independent of gate arming")
assert.equal(cfgNoGate.agent.team.permission.bash["*"], "allow", "T2.1 grant intact either way")
assert.equal(cfg.agent["team"].permission.edit, "allow", "lead edit allowed (<=10-line non-product edits)")
assert.equal(cfg.agent["team"].permission.task, "allow", "lead task dispatch allowed")
assert.deepEqual(cfg.agent["team"].permission.tm_webfetch, { "*": "ask" }, "lead: web channel carries the ask-map (out-of-allowlist targets pop the official dialog)")
assert.equal(cfg.agent["implementer"].permission.tm_webfetch, "deny", "implementer is NOT a network role")
assert.deepEqual(cfg.agent["researcher"].permission.tm_webfetch, { "*": "ask" }, "researcher: web channel carries the ask-map")
assert.deepEqual(cfg.agent["team"].permission.tm_browser, { "*": "ask" }, "lead: browser carries the ask-map")
assert.equal(cfg.agent["implementer"].permission.tm_browser, "deny", "implementer is NOT a network role (browser)")
assert.equal(cfg.agent["implementer"].permission.tm_memory, "allow", "memory store: all roles (not a network channel)")
assert.equal(cfg.agent["team"].permission.todowrite, "allow", "lead: todowrite granted (TodoList discipline is a prompt mandate)")
assert.equal(cfg.agent["team"].permission.question, "allow", "lead: question granted (batched blocking questions)")
assert.equal(cfg.agent["implementer"].permission.todowrite, "deny", "specialists: todowrite denied (lead-only)")
assert.equal(Object.keys(cfg.agent).length, 6, "exactly 6 agents injected")
assert.equal(Object.keys(cfg.command).length, 6, "exactly 6 commands injected")

/* idempotence + user override respected */
cfg.agent["reviewer"] = { description: "user's own", mode: "subagent", prompt: "mine" }
const hooks2 = await plugin.server({ directory: process.cwd() }, undefined)
await hooks2.config(cfg)
assert.equal(cfg.agent["reviewer"].prompt, "mine", "existing user agent not clobbered")
assert.ok(cfg.agent["team"].prompt.includes("idle for more than 9 days"), "already-injected entry kept")

/* fresh config without options -> default 5d TTL */
const cfg2 = {}
const hooks3 = await plugin.server({ directory: process.cwd() }, undefined)
await hooks3.config(cfg2)
assert.ok(cfg2.agent["team"].prompt.includes("idle for more than 5 days"), "default TTL 5d without options")

/* v1.4.5: Team default-agent promotion is opt-OUT again (defaultAgent:false disables) */
assert.equal(cfg2.default_agent, "team", "no options -> team becomes the default agent")
const cfg3 = { default_agent: "build" }
const hooks4 = await plugin.server({ directory: process.cwd() }, undefined)
await hooks4.config(cfg3)
assert.equal(cfg3.default_agent, "team", "build default is replaced by the promotion")
const cfgF = {}
const hooksF = await plugin.server({ directory: process.cwd() }, { defaultAgent: false })
await hooksF.config(cfgF)
assert.ok(!("default_agent" in cfgF), "defaultAgent:false -> key must not be written")
const cfgFB = { default_agent: "build" }
const hooksFB = await plugin.server({ directory: process.cwd() }, { defaultAgent: false })
await hooksFB.config(cfgFB)
assert.equal(cfgFB.default_agent, "build", "defaultAgent:false keeps build default")
const cfgU = { default_agent: "my-custom-agent" }
const hooksU = await plugin.server({ directory: process.cwd() }, undefined)
await hooksU.config(cfgU)
assert.equal(cfgU.default_agent, "my-custom-agent", "explicit non-build default respected under promotion")

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

/* T3: dispatch-concurrency guidance + pre-commit hygiene (lead side) */
assert.ok(leadPrompt.includes("## Dispatch concurrency"), "lead: dispatch concurrency section present")
assert.ok(
  leadPrompt.indexOf("## Routing table") < leadPrompt.indexOf("## Dispatch concurrency") &&
    leadPrompt.indexOf("## Dispatch concurrency") < leadPrompt.indexOf("## Approval gate"),
  "lead: dispatch concurrency section sits between routing table and approval gate",
)
assert.ok(leadPrompt.includes("you and your team run AT THE SAME TIME"), "lead: concurrency section states the real-parallel contract")
assert.ok(leadPrompt.includes("tm_dispatch is the parallel lever"), "lead: tm_dispatch taught as the non-blocking dispatch lever")
assert.ok(leadPrompt.includes("blocks you until that child finishes"), "lead: WHY task is the serial path is stated, not just banned")
assert.ok(leadPrompt.includes("Write a SELF-CONTAINED brief"), "lead: dispatch briefs must stand alone (child sees no history)")
assert.ok(leadPrompt.includes("quick / standard /\n  deep"), "lead: the brief carries an expected thoroughness level")
assert.ok(leadPrompt.includes("While they run, keep working — on lead work only"), "lead: the leader works during the wait, and only on lead work")
assert.ok(leadPrompt.includes("Do NOT pull big payloads into your\n  own context while waiting"), "lead: leader context discipline — delegated bulk stays delegated")
assert.ok(leadPrompt.includes("Collect with **tm_join**"), "lead: tm_join is the collection path")
assert.ok(leadPrompt.includes("Never end a turn with a dispatched child uncollected"), "lead: no orphaned dispatches at end of turn")
assert.ok(leadPrompt.includes("cancel: true"), "lead: a runaway child is abortable")
assert.ok(leadPrompt.includes("your context is the team's scarce"), "lead: division of labour framed as context economy")
assert.ok(leadPrompt.includes("blocking on `task`"), "lead: blocking on task for independent work is named an anti-pattern")
// async dispatch makes multi-in_progress normal, and order is negotiable
assert.ok(leadPrompt.includes("SEVERAL items"), "lead: parallel dispatch explicitly licenses several in_progress items")
assert.ok(leadPrompt.includes("ORDER IS A DEFAULT, NOT A LAW"), "lead: todo-list order yields to parallelism")
assert.ok(leadPrompt.includes("fire every package whose inputs already exist"), "lead: scan the whole list for dispatchable work each round")
assert.ok(leadPrompt.includes("Partition before you parallelize"), "lead: file-ownership partition is the precondition for parallel work")
assert.ok(leadPrompt.includes("never let two agents edit one file"), "lead: children must not collide")
assert.ok(leadPrompt.includes("Reuse before you build"), "lead: existing dependencies are checked before designing a new module")
assert.ok(leadPrompt.includes("already available,"), "lead: 'already available, use it' is stated as the better outcome")
assert.ok(leadPrompt.includes("The team exists to be FASTER"), "lead: throughput is the justification for the team")
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
assert.ok(!leadPrompt.includes("DELETE the task directory"), "lead: no manual-delete instruction left")
assert.ok(leadPrompt.includes("TTL sweeper"), "lead: TTL sweeper is sole cleanup path")
assert.ok(leadPrompt.includes("VERBATIM CONTRACTS"), "lead: api-contract verbatim rule (kept)")
assert.ok(leadPrompt.includes("## Evidence standard"), "lead: evidence standard (kept)")
assert.ok(leadPrompt.includes("## Docs sync"), "lead: docs-sync rule (CHANGELOG + AGENTS.md)")
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
  assert.ok(cfg2.agent[expert].prompt.includes("All file reads / searches / enumeration go through tm_read / tm_grep / tm_bash"), expert + ": removed-tools rule routes reads/search/enumeration to tm_*")
  assert.ok(cfg2.agent[expert].prompt.includes("removed from the tool surface"), expert + ": anti-retry warning for removed built-ins")
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
    cfg2.agent[expert].prompt.includes("Web lookups are NOT yours unless tm_search / tm_webfetch / tm_browser"),
    expert + ": web boundary rule (network roles are lead + researcher only)",
  )
  assert.ok(
    cfg2.agent[expert].prompt.includes("the tester carries tm_browser for UI verification"),
    expert + ": web boundary rule names the tester's browser-only exception",
  )
  assert.ok(cfg2.agent[expert].prompt.includes("1. TeamMode governed tools (tm_*)"), expert + ": priority ladder rung 1 (tm_* first)")
  assert.ok(cfg2.agent[expert].prompt.includes("2. User MCP/plugin tools"), expert + ": priority ladder rung 2 (MCP second)")
  assert.ok(cfg2.agent[expert].prompt.includes("3. Your own reasoning"), expert + ": priority ladder rung 3 (reasoning, never fabricate)")
  assert.ok(
    cfg2.agent[expert].prompt.includes("Plan-time rule: the moment your plan lists ≥3") &&
      cfg2.agent[expert].prompt.includes("your FIRST move is ONE tm_ptc_run program"),
    expert + ": PTC trigger is plan-time (plan lists ≥3 probes → FIRST move is ONE tm_ptc_run program)",
  )
  assert.ok(cfg2.agent[expert].prompt.includes("OR built-in bash alike"), expert + ": PTC trigger counts built-in bash chains, not just tm_* calls")
  assert.ok(cfg2.agent[expert].prompt.includes("ONE compound built-in bash command"), expert + ": plain-shell batches prescribe one compound command, not N round-trips")
  assert.ok(cfg2.agent[expert].prompt.includes("aggregated value at the end of the program"), expert + ": PTC return-data rule (unreturned inline results are lost)")
assert.ok(cfg2.agent["researcher"].prompt.includes("Recon batching (PTC-first)"), "researcher: PTC-first recon section present")
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
assert.ok(cfg2.agent["researcher"].prompt.includes("个子资源请求被拦截"), "researcher: a trimmed page is reported as gate action, not 'the site has no images'")
assert.ok(cfg2.agent["researcher"].prompt.includes("已确认关闭 vs 警告：关闭未完全成功"), "researcher: close claims must quote the tool's verified verdict")
assert.ok(cfg2.agent["researcher"].prompt.includes("there is no headless parameter for you"), "researcher: headless is an operator setting, not a model arg")
assert.ok(/independent web calls: two unrelated tm_search queries belong in/.test(cfg2.agent["researcher"].prompt), "researcher: independent web calls batch into one round")
assert.ok(cfg2.agent["researcher"].prompt.includes("Command time budget"), "researcher: command time budget section present")
assert.ok(cfg2.agent["researcher"].prompt.includes("does not make anything finish"), "researcher: a big timeout is explained as dead air, not speed")
assert.ok(cfg2.agent["researcher"].prompt.includes("compound form is for CHEAP probes only"), "researcher: slow independent steps must NOT be chained into one serial command")
assert.ok(cfg2.agent["implementer"].prompt.includes("Independent calls in the SAME round"), "implementer: same-round independent-call rule is shared")
assert.ok(cfg2.agent["implementer"].prompt.includes("never a 120-second command"), "implementer: probes must not carry a 120s timeout")
assert.ok(cfg2.agent["implementer"].prompt.includes("Never wait inside a command"), "implementer: no sleep/polling inside a bash command")
assert.ok(cfg2.agent["researcher"].prompt.includes("registry.npmjs.org/-/v1/search"), "researcher: npm search endpoint documented")
assert.ok(cfg2.agent["researcher"].prompt.includes("mobile.moegirl.org.cn"), "researcher: seeded web hosts documented")
assert.ok(cfg2.agent["team"].prompt.includes("tm_search"), "lead: governed search front referenced")
assert.ok(cfg2.agent["team"].prompt.includes("tm_webfetch"), "lead: governed web fallback referenced")
assert.ok(cfg2.agent["tester"].prompt.includes("## UI verification (tm_browser"), "tester: governed UI verification section present")
assert.ok(cfg2.agent["tester"].prompt.includes("UI NOT VERIFIED"), "tester: honest-gap fallback kept alongside the browser grant")
assert.ok(cfg2.agent["team"].prompt.includes("tm_memory search"), "lead: memory consulted during research phase")
assert.ok(cfg2.agent["team"].prompt.includes("project layer first, global layer for cross-repo conventions"), "lead: memory layering (project layer first, global for cross-repo conventions)")
assert.ok(cfg2.agent["team"].prompt.includes("Batch the recon in one tm_ptc_run program"), "lead: research-phase recon batched via PTC")
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

console.log("4. loader contract + v1 config injection: OK (server->config, 6 agents, 6 commands, override-safe)")
console.log("5. v1.4.7 contract: OK (routing, approval gate, skeleton, hybrid board, adaptive review, static verify)")
console.log("6. opt-out default-agent promotion + triage/boundaries: OK")
console.log("7. TTL-only reclamation + session-partitioned boards: OK")

console.log("\nALL BLACKBOARD TESTS PASSED ✅")
