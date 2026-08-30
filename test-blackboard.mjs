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

/* ---------- 4. plugin setup injects board + TTL into team-lead prompt ---------- */
const captured = {}
const fakeCtx = {
  directory: process.cwd(),
  options: { ttlDays: 9 },
  agent: {
    transform: async (cb) => cb({
      update: (name, fn) => { const item = {}; fn(item); captured[name] = item },
    }),
    reload: async () => {},
  },
  command: {
    transform: async (cb) => cb({
      update: (name, fn) => { const item = {}; fn(item); captured["cmd:" + name] = item },
    }),
    reload: async () => {},
  },
}
assert.equal(plugin.id, "team-mode", "display id")
await plugin.setup(fakeCtx)

const leadPrompt = captured["team-lead"].prompt
assert.ok(leadPrompt.includes("opencode-team"), "board root injected")
assert.ok(leadPrompt.includes("idle for more than 9 days"), "custom TTL in note")
assert.ok(leadPrompt.includes("Shared blackboard"), "blackboard protocol present")
assert.ok(leadPrompt.includes("TodoList discipline"), "v1.2 todolist hard rule")
assert.ok(leadPrompt.includes("BLACKBOARD WRITE FAILED"), "lead fallback rule")
assert.ok(captured["cmd:team-run"].template.includes("blackboard"), "team-run template updated")

/* v1.2.1: permissions authoritative + no-transcribe guarantee on all experts */
for (const expert of ["architect", "implementer", "reviewer", "tester", "researcher"]) {
  const a = captured[expert]
  assert.ok(a.prompt.includes("Blackboard write guarantee"), expert + " has write guarantee")
  assert.ok(a.prompt.includes("NEVER reply \"append this verbatim"), expert + " blocks transcribe-escape")
  assert.equal(a.permission.edit, "allow", expert + " edit allowed (for blackboard)")
}
assert.equal(captured["architect"].permission.bash, "deny", "architect stays bash-denied")
assert.equal(captured["team-lead"].permission.task, "allow", "lead task dispatch allowed")
console.log("5. permissions + anti-transcribe guarantee: OK (all 6 agents authoritative)")
console.log("4. setup injection: OK (id=team-mode, root + 9d TTL in prompt, protocols wired)")

console.log("\nALL BLACKBOARD TESTS PASSED ✅")
