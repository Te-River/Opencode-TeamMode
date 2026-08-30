/**
 * Blackboard end-to-end verification (run with node after `npm run build`).
 */
import assert from "node:assert"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const bb = await import("./dist/blackboard.js")
const plugin = (await import("./dist/index.js")).default

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
const hooks = await plugin.server({ directory: process.cwd(), project: process.cwd() }, { ttlDays: 9 })
assert.equal(typeof hooks.config, "function", "server returns { config } hooks")
await hooks.config(cfg)

const lead = cfg.agent["team"]
const leadPrompt = lead.prompt
assert.ok(leadPrompt.includes("opencode-team"), "board root injected")
assert.ok(leadPrompt.includes("idle for more than 9 days"), "custom TTL in note")
assert.ok(leadPrompt.includes("Shared blackboard"), "blackboard protocol present")
assert.ok(leadPrompt.includes("TodoList discipline"), "v1.2 todolist hard rule")
assert.ok(leadPrompt.includes("BLACKBOARD WRITE FAILED"), "lead fallback rule")
assert.equal(lead.mode, "primary", "team visible in Desktop switcher")
assert.ok(cfg.command["team-run"].template.includes("blackboard"), "team-run template updated")
assert.ok(cfg.command["team-plan"].agent === "architect", "command agent binding")

/* v1 config shapes: prompt (string) + permission (object) */
for (const [name, a] of Object.entries(cfg.agent)) {
  assert.equal(typeof a.prompt, "string", name + ": v1 prompt field set")
  assert.equal(a.system, undefined, name + ": no stray v2 system field")
  assert.ok(a.permission && typeof a.permission === "object", name + ": v1 permission object")
}
for (const expert of ["architect", "implementer", "reviewer", "tester", "researcher"]) {
  const a = cfg.agent[expert]
  assert.equal(a.mode, "subagent", expert + " is subagent")
  assert.ok(a.prompt.includes("Blackboard write guarantee"), expert + " has write guarantee")
  assert.ok(a.prompt.includes("NEVER reply \"append this verbatim"), expert + " blocks transcribe-escape")
  assert.equal(a.permission.edit, "allow", expert + " edit allowed (for blackboard)")
}
assert.equal(cfg.agent["architect"].permission.bash, "deny", "architect stays bash-denied")
assert.equal(cfg.agent["team"].permission.task, "allow", "lead task dispatch allowed")
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
console.log("5. loader contract + v1 config injection: OK (server->config, 6 agents, 6 commands, override-safe)")

console.log("\nALL BLACKBOARD TESTS PASSED ✅")
