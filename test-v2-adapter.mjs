/**
 * v2 adapter — the personality that speaks to an OpenCode 2.x host.
 *
 * Runs against the BUILT output like every other suite, against the fake v2
 * context in scripts/lib/fake-ctx.mjs.  Store roots are fresh mkdtemp dirs, so
 * nothing here touches the user's real ~/.opencode-team or any repo .git, and no
 * network call is expected to succeed — the one web assertion checks the
 * OPPOSITE: that a governed call refuses when the host offers no dialog.
 *
 * Coverage — each group exists because a live host probe measured the failure:
 *   1. registration: all thirteen tm_* land on the v2 tool surface, tm_dispatch
 *      still does not, and each carries a real description + a JSON Schema
 *   2. the result shape: no bare `output` anywhere (the host answers that with
 *      "Tool result declared output without an output schema")
 *   3. the filesystem client shim: tm_read/tm_grep work with no host client,
 *      the P2 path scope still refuses, and a bounded scan says it truncated
 *   4. consent: with no ask bridge an off-allowlist fetch FAILS CLOSED and the
 *      refusal names the v2 reason rather than 旧版协议
 *   5. permissions: the v1 flat map becomes {action,resource,effect} triples,
 *      a user's unrelated rule survives, and booting twice changes nothing more
 *   6. the gaps are SAID — a config that lacks our roles is logged, because a
 *      v2 plugin cannot create an agent and silence looks like no plugin at all
 *   7. teardown disposes every registration
 */

import assert from "node:assert"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import plugin from "./dist/index.js"
import { agents } from "./dist/agents.js"
import { createV2Client } from "./dist/host/v2-client.js"
import { makeFakeCtx, withCapturedConsole } from "./scripts/lib/fake-ctx.mjs"

const mktmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `tm-v2-${name}-`))
const made = []
function workspace(name) {
  const dir = mktmp(name)
  made.push(dir)
  return dir
}

const TM_NAMES = [
  "tm_read", "tm_grep", "tm_bash", "tm_fetch", "tm_memory", "tm_search",
  "tm_webfetch", "tm_browser", "tm_ptc_run", "tm_join", "tm_pty", "tm_stats",
  "tm_board_write",
]
const CTX = { sessionID: "ses_v2", agent: "team", messageID: "msg_1", id: "call_1" }
const textOf = (res) =>
  (res?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join("\n")

// ── 1-5: one full boot, then inspect it ─────────────────────────────────────
const ws = workspace("boot")
fs.writeFileSync(path.join(ws, "sample.txt"), "hello from the v2 adapter test\nsecond line with NEEDLE\n")

const sixAgents = Object.keys(agents).map((id) => ({ id, name: id, permissions: [] }))
sixAgents[0].permissions = [
  // an action our matrix does not mention at all — a user's own MCP tool
  { action: "my_mcp_thing", resource: "*", effect: "allow" },
  // an action our matrix DENIES for this role: the whitelist must win, or the
  // "no network for architect/implementer/reviewer/tester" promise is a
  // suggestion a stray config line can break.
  { action: "websearch", resource: "*", effect: "allow" },
]

const fake = makeFakeCtx({ directory: ws, agents: sixAgents })
const { value: cleanup, warns, errors } = await withCapturedConsole(() => plugin.setup(fake.ctx))

assert.equal(errors.length, 0, `setup must not throw into the host: ${errors.join(" | ")}`)
assert.equal(typeof cleanup, "function", "setup hands the host an awaitable cleanup")

const byName = Object.fromEntries(fake.tools.list().map((t) => [t.id ?? t.name, t]))
const registered = Object.keys(byName)

console.log("1. registration")
for (const name of TM_NAMES) {
  assert.ok(registered.includes(name), `${name} is registered on the v2 tool surface`)
}
assert.ok(!registered.includes("tm_dispatch"), "tm_dispatch stays unregistered on v2 too")
assert.equal(
  registered.filter((n) => n.startsWith("tm_")).length,
  TM_NAMES.length,
  `exactly the thirteen governed tools arrive (got ${registered.filter((n) => n.startsWith("tm_")).join(",")})`,
)
for (const name of TM_NAMES) {
  assert.ok(String(byName[name].description ?? "").length > 40, `${name} carries a real description`)
  assert.equal(byName[name].input?.type, "object", `${name}'s input is a JSON Schema object`)
}
assert.ok(
  Object.keys(byName.tm_read.input.properties ?? {}).includes("path"),
  "tm_read's parameter names survive the zod→JSON Schema translation",
)

// tm_join / tm_pty / tm_stats build their args WITHOUT zod, so their shape
// arrives as `{ key: { descriptor: "name: type (guidance)" } }`.  Handing that
// to z.object() throws `undefined is not an object (evaluating 'schema._zod.def')`
// — measured live, where all three reached the model as a permissive
// `{additionalProperties:true}` with no parameter guidance at all.  The
// descriptor branch has to recover names AND types, because a schema that says
// "string" for an enum parameter is the same guidance-free shape in disguise.
for (const name of ["tm_join", "tm_pty", "tm_stats"]) {
  const input = byName[name].input
  assert.notEqual(input.additionalProperties, true, `${name} is not the permissive fallback`)
  assert.ok(Object.keys(input.properties ?? {}).length >= 3, `${name} carries properties`)
}
assert.equal(byName.tm_join.input.properties.ids.type, "array", "tm_join.ids reads `string[]` as an array")
assert.equal(
  byName.tm_join.input.properties.ids.items?.type,
  "string",
  "tm_join.ids says of what",
)
assert.equal(byName.tm_join.input.properties.waitMs.type, "number", "tm_join.waitMs reads as a number")
assert.equal(byName.tm_join.input.properties.cancel.type, "boolean", "tm_join.cancel reads as a boolean")
assert.ok(
  (byName.tm_pty.input.properties.action.enum ?? []).includes("kill"),
  "tm_pty.action keeps its verb enum instead of flattening to a string",
)
assert.equal(byName.tm_stats.input.properties.runs.type, "number", "tm_stats.runs reads as a number")
for (const name of ["tm_join", "tm_pty", "tm_stats"]) {
  const first = Object.values(byName[name].input.properties ?? {})[0]
  assert.ok(String(first?.description ?? "").length > 10, `${name} keeps the guidance text, not just names`)
}
assert.match(
  warns.join("\n"),
  /描述符/,
  "the boot log names which schemas were DERIVED from descriptors (exact≠zod-grade)",
)
console.log(`   OK (${registered.length} tools, parameter surfaces translated)`)

console.log("2. the v2 result shape")
const readRes = await byName.tm_read.execute({ path: path.join(ws, "sample.txt") }, CTX)
assert.ok(!("output" in readRes), "no bare `output` key — the host rejects it without an output schema")
assert.ok(Array.isArray(readRes.content) && readRes.content[0].type === "text", "text arrives as a content part")
assert.match(textOf(readRes), /v2 adapter test/, "tm_read reaches the file through the fs shim")
console.log("   OK (content parts, attachments ride as file entries)")

console.log("3. the fs client shim, guards intact")
const outside = await byName.tm_read.execute({ path: path.resolve(os.tmpdir(), "..", "definitely-outside-tree") }, CTX)
assert.match(textOf(outside), /失败 · phase=permission/, "P2 path scope still refuses — the shim did not bypass governance")
const grepRes = await byName.tm_grep.execute({ pattern: "NEEDLE", path: ws }, CTX)
assert.match(textOf(grepRes), /sample\.txt/, "tm_grep finds the hit through the shim")
assert.ok(!textOf(grepRes).includes("扫描被截断"), "a two-file tree is not reported as truncated")

const wide = workspace("trunc")
for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(wide, `f${i}.txt`), "NEEDLE\n".repeat(400))
const shim = createV2Client()
const { MAX_TOTAL_LINES } = { MAX_TOTAL_LINES: 500 }
const many = await shim.find.text({ query: { pattern: "NEEDLE", directory: wide } })
assert.ok(Array.isArray(many.data), "find.text answers in the host's array-of-matches shape")
const hitLines = many.data.reduce((n, m) => n + (m.lines?.length ?? 0), 0)
assert.ok(hitLines <= MAX_TOTAL_LINES + 1, `the scan stays bounded (${hitLines} lines)`)
assert.ok(
  JSON.stringify(many.data).includes("扫描被截断"),
  "a partial answer announces itself instead of reading complete",
)
console.log(`   OK (bounded scan, ${hitLines} lines, truncation stated)`)

console.log("4. consent fails closed with the v2 reason")
const web = await byName.tm_webfetch.execute({ url: "https://definitely-not-allowlisted.invalid/page" }, CTX)
const webText = textOf(web)
assert.match(webText, /不给插件弹出确认窗/, "the refusal names the v2 absence, not 旧版协议")
assert.match(webText, /拒绝|白名单/, "and it refuses rather than implying someone approved")
assert.ok(!/正文|http 200/i.test(webText), "nothing was fetched")
console.log("   OK (no ask bridge → refuse, and the sentence is true)")

console.log("5. permission triples, user rules, idempotency")
const team = fake.agents.get("team")
const find = (a) => team.permissions.filter((p) => p.action === a)
assert.ok(find("tm_read").some((p) => p.effect === "allow" && p.resource === "*"), "the whitelist reaches v2 as triples")
assert.ok(find("shell").some((p) => p.effect === "allow"), "v1 `bash` is emitted under v2's action name `shell`")
assert.equal(find("bash").length, 0, "no v1-only action name is left behind as a phantom rule")
assert.ok(find("subagent").some((p) => p.effect === "allow"), "the lead's delegation grant reaches v2 as `subagent`")
assert.ok(
  fake.agents.get("researcher").permissions.some((p) => p.action === "subagent" && p.effect === "deny"),
  "and the no-specialist-delegation deny survives the translation",
)
assert.ok(find("websearch").some((p) => p.effect === agents.team.permission.websearch), "the matrix decides a network action, not a stray config line (the user's value is replaced by what our whitelist says)")
assert.ok(
  find("my_mcp_thing").some((p) => p.effect === "allow" && p.resource === "*"),
  "an action the matrix never mentions — a user's own MCP tool — passes through untouched",
)
assert.ok(
  warns.some((w) => /没有对应动作/.test(w)),
  "keys with no v2 counterpart (list/todowrite/lsp) are reported, not silently emitted as dead rules",
)
const before = JSON.stringify(team.permissions)
const reboot = await withCapturedConsole(() => plugin.setup(fake.ctx))
assert.equal(JSON.stringify(fake.agents.get("team").permissions), before, "booting again on an already-normalized config adds no duplicate (the host DOES reload plugins)")
await reboot.value?.()

const wsR6 = workspace("r6")
const r6Fake = makeFakeCtx({ directory: wsR6, options: { envProtect: true }, agents: sixAgents.map((a) => ({ ...a, permissions: [] })) })
const prevEnv = process.env.TM_ENV_PROTECT
process.env.TM_ENV_PROTECT = "on"
const r6 = await withCapturedConsole(() => plugin.setup(r6Fake.ctx))
process.env.TM_ENV_PROTECT = prevEnv
const r6Team = r6Fake.agents.get("team")
assert.ok(
  r6Team.permissions.some((p) => p.action === "shell" && p.effect === "ask"),
  "with R6 on, shell escalates to `ask` — the host opens a real dialog (probed: it honors ask)",
)
assert.ok(
  r6.warns.some((w) => /每条命令都问/.test(w)),
  "and the coarser-than-v1 shape of that escalation is said out loud, not passed off as parity",
)
await r6.value?.()

const shape = JSON.parse(before)
assert.equal(
  shape.filter((p) => p.action === "tm_read").length,
  1,
  "applying the matrix twice does not duplicate a rule",
)
assert.ok(
  shape.every((p) => ["allow", "deny", "ask"].includes(p.effect)),
  "no rule carries an effect the host cannot parse",
)
console.log("   OK (names mapped, dead keys reported, ask escalation honest, idempotent)")

console.log("6. the gaps are said out loud")
const bare = makeFakeCtx({ directory: ws, agents: [] })
const second = await withCapturedConsole(() => plugin.setup(bare.ctx))
assert.equal(typeof second.value, "function", "a config with no roles still boots (tools are ours to register)")
assert.ok(
  second.warns.some((w) => /配置里缺角色/.test(w)),
  `missing config-declared agents are logged, not swallowed: ${second.warns.join(" | ")}`,
)
assert.ok(
  second.warns.some((w) => Object.keys(agents).every((id) => w.includes(id))),
  "the log names all six roles the installer must provide",
)
console.log("   OK (a v2 plugin cannot create agents, so it says which are missing)")
await second.value?.()

console.log("7. teardown")
await cleanup()
const undisposed = fake.registrations.filter((r) => !r.disposed)
assert.equal(undisposed.length, 0, `every registration is disposed on teardown (${undisposed.map((r) => r.label).join(",")})`)
assert.ok(
  fake.registrations.some((r) => r.label === "tool.transform") &&
    fake.registrations.some((r) => r.label === "agent.transform"),
  "both transforms went through the host's registrar (so they can be undone)",
)
console.log(`   OK (${fake.registrations.length} registrations released)`)

for (const dir of made) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* temp dir */
  }
}
console.log("\ntest-v2-adapter.mjs: ALL PASS (7 groups)")
