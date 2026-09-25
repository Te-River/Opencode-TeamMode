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
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import plugin from "./dist/index.js"
import { agents } from "./dist/agents.js"
import { commands } from "./dist/commands.js"
import { createV2Client } from "./dist/host/v2-client.js"
import { applyV2Probe, probeSummary } from "./dist/host/v2-probe.js"
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
/** v1's roster minus what v2 deliberately does not register. */
const V2_NAMES = TM_NAMES.filter((n) => n !== "tm_ptc_run")
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
for (const name of V2_NAMES) {
  assert.ok(registered.includes(name), `${name} is registered on the v2 tool surface`)
}
assert.ok(!registered.includes("tm_dispatch"), "tm_dispatch stays unregistered on v2 too")
assert.ok(
  !registered.includes("tm_ptc_run"),
  "tm_ptc_run is NOT registered on v2 — the host's own execute (Code Mode) covers it, and v1 keeps the tool",
)
assert.equal(
  registered.filter((n) => n.startsWith("tm_")).length,
  V2_NAMES.length,
  `exactly the twelve governed tools v2 ships arrive (got ${registered.filter((n) => n.startsWith("tm_")).join(",")})`,
)
for (const name of V2_NAMES) {
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

console.log("1b. Team owns the default slot")
assert.equal(
  fake.agents.__default,
  "team",
  "editor.default('team') runs on every boot — v2 has no getter, so 'only if the user left it alone' is not expressible and the standing instruction wins",
)
const optedOut = makeFakeCtx({ directory: ws, agents: sixAgents, options: { defaultAgent: false } })
const oo = await withCapturedConsole(() => plugin.setup(optedOut.ctx))
assert.equal(
  optedOut.agents.__default,
  undefined,
  "defaultAgent:false opts out of the promotion, the same knob v1 documents",
)
await oo.value?.()
// …and the claim is only made when it can be OBSERVED.  A live 2.0.16 standalone
// boot showed the editor holding 7 agents with build and plan present and NONE of
// ours — the transform receives the agent set from before the config directory
// merges — while `--agent team` was nonetheless executing as Team.  "get() found
// nothing" is therefore not evidence the host lacks the role, and it is certainly
// not evidence the promotion landed.  The call is still attempted (it is the only
// channel there is), but an unverifiable promotion must not print as a success.
{
  const builtinOnly = makeFakeCtx({
    directory: ws,
    agents: [{ id: "build", name: "build" }, { id: "plan", name: "plan" }],
  })
  const b = await withCapturedConsole(() => plugin.setup(builtinOnly.ctx))
  assert.equal(builtinOnly.agents.__default, "team", "the promotion is still attempted against a host whose editor lacks our roles")
  const line = (b.warns ?? []).join(" ") + (b.errors ?? []).join(" ")
  assert.ok(/无法核验/.test(line) && /default_agent/.test(line), "…and says out loud that it could not be verified, pointing at the installer key that does work")
  assert.ok(!/Team 已经是默认/.test(line), "no all-clear is printed for an unobserved promotion")
  await b.value?.()
}

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

console.log("4. the v2 network policy: nothing gated by domain, everything gated by address")
// The user's instruction for v2 (2026-09-25): do not block network access at all
// EXCEPT sensitive and internal addresses.  On v1 the 22-host seed list was bearable
// because the plugin could raise the host's official per-request dialog; on v2 it
// cannot, so an allowlist became a set of pages nobody can approve — a gate with no
// door.  Hence the default flips to "*" for THIS personality only (v1 keeps its
// shipped default; the fork goes through createTmTools' `env`, never by mutating
// process.env).  What must still hold, and hold hardest, is the address policy.
const pub = await byName.tm_webfetch.execute({ url: "https://example.com/" }, CTX)
const pubText = textOf(pub)
// Judged on the ERROR PHASE, not a substring: example.com's own copy reads
// "…without needing permission", so content matching would make a passing fetch
// look like a refusal.
assert.ok(!/phase=permission/.test(pubText), "a public host outside every seed is NOT refused by policy")
assert.match(pubText, /Example Domain|正文|http/i, "…and is actually fetched (DNS/网络错误可以，门禁错误不行)")
for (const [url, why] of [
  ["http://169.254.169.254/latest/meta-data/", "元数据"],
  ["http://192.168.1.1/", "私网"],
  ["http://localhost:3000/", "回环"],
]) {
  const r = textOf(await byName.tm_webfetch.execute({ url }, CTX))
  assert.match(r, new RegExp(why), `${url} is still refused as ${why}`)
  assert.ok(!/正文|<html/i.test(r), `${url} was refused before anything was fetched`)
  // Goal 6, applied to the refusal itself: on v2 there is no ask bridge, so a
  // sentence promising "只能逐次经用户批准" would send the agent waiting for a dialog
  // that can never open.  The v2 wording names the absence.
  if (/用户批准|逐次经/.test(r) && !/不给插件弹出确认窗|无法弹出/.test(r)) {
    assert.fail(`${url}: the refusal promises user approval without saying v2 cannot open that dialog`)
  }
}
console.log("   OK (public hosts unpoliced by default, metadata/private/loopback refused, no promise of a dialog that cannot open)")

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
const prevFine = process.env.TM_R6_FINE_ASK
delete process.env.TM_R6_FINE_ASK
process.env.TM_ENV_PROTECT = "on"
const r6 = await withCapturedConsole(() => plugin.setup(r6Fake.ctx))
process.env.TM_ENV_PROTECT = prevEnv
const r6Team = r6Fake.agents.get("team")
// The classifier is in charge by default now (a live host proved
// permission.evaluate fires for shell), so the config must NOT blanket-ask every
// command — that would mask the very hook the evidence was gathered for.
assert.ok(
  !r6Team.permissions.some((p) => p.action === "shell" && p.effect === "ask"),
  "R6 on + the evaluate hook installed → no blanket `ask` on shell; the per-command classifier decides",
)
assert.ok(
  !r6.warns.some((w) => /每条命令都问/.test(w)),
  "and the coarse-escalation note is not printed when nothing was escalated",
)
await r6.value?.()

process.env.TM_R6_FINE_ASK = "off"
process.env.TM_ENV_PROTECT = "on"
const r6Coarse = await withCapturedConsole(() => plugin.setup(r6Fake.ctx))
process.env.TM_ENV_PROTECT = prevEnv
delete process.env.TM_R6_FINE_ASK
assert.ok(
  r6Fake.agents.get("team").permissions.some((p) => p.action === "shell" && p.effect === "ask"),
  "TM_R6_FINE_ASK=off is the explicit way back: shell escalates to `ask` and the host opens its dialog",
)
assert.ok(
  r6Coarse.warns.some((w) => /每条命令都问/.test(w) && /off/.test(w)),
  "and the note names the knob as the cause, not the host",
)
await r6Coarse.value?.()

const noHook = makeFakeCtx({ directory: wsR6, options: { envProtect: true }, agents: sixAgents.map((a) => ({ ...a, permissions: [] })) })
delete noHook.ctx.permission
process.env.TM_ENV_PROTECT = "on"
const r6NoHook = await withCapturedConsole(() => plugin.setup(noHook.ctx))
process.env.TM_ENV_PROTECT = prevEnv
assert.ok(
  noHook.agents.get("team").permissions.some((p) => p.action === "shell" && p.effect === "ask"),
  "a host with no permission.hook falls back to coarse REGARDLESS of the knob — fail-closed",
)
assert.ok(
  r6NoHook.warns.some((w) => /没给 permission.hook/.test(w)),
  "and says WHICH reason applies, because two causes with one message is how a fallback gets mistaken for a setting",
)
await r6NoHook.value?.()
if (prevFine !== undefined) process.env.TM_R6_FINE_ASK = prevFine

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
// This used to assert the OPPOSITE — that the promotion is withheld when
// editor.get('team') finds nothing.  A live 2.0.16 boot falsified the premise: the
// transform's editor holds only the built-ins (the config directory has not merged
// yet), so gating on that look-up suppressed the promotion in the ordinary case and
// did so silently.  The call is made regardless now, and what is guaranteed instead
// is that an unverified promotion is SAID, not hidden.
assert.equal(
  bare.agents.__default,
  "team",
  "the promotion is attempted even against an editor that has not merged the config roles",
)
assert.ok(
  second.warns.some((w) => /无法核验/.test(w) && /default_agent/.test(w)),
  "…and the boot says the promotion could not be verified, pointing at the installer key that can",
)
assert.ok(
  second.warns.some((w) => /没装过安装器就别假定/.test(w)),
  `and the note tells the user not to assume the default holds: ${second.warns.join(" | ")}`,
)
console.log("   OK (a v2 plugin cannot create agents, so it says which are missing)")
await second.value?.()

console.log("7. the request layer — the whitelist decides what the model SEES")
const SURFACE = [
  "read", "grep", "glob", "list", "edit", "write", "patch", "shell", "webfetch", "websearch",
  "skill", "question", "todowrite", "subagent", "browser_navigate", "browser_tabs_list",
  "tm_read", "tm_grep", "tm_bash", "tm_fetch", "tm_memory", "tm_board_write", "tm_ptc_run",
  "tm_stats", "tm_join", "tm_pty", "tm_browser", "tm_search", "tm_webfetch",
]
const event = (agent, options = {}) => ({
  agent,
  system: [],
  messages: [],
  options,
  tools: Object.fromEntries(SURFACE.map((n) => [n, { description: "d", input: {} }])),
})

const arch = event("architect")
await fake.hook("session.context").fire(arch)
const archLeft = Object.keys(arch.tools)
for (const gone of [
  "read", "grep", "glob", "list", "edit", "write", "shell", "webfetch", "websearch", "question",
  "todowrite", "subagent", "browser_navigate", "browser_tabs_list",
  "tm_webfetch", "tm_search", "tm_browser", "tm_join", "tm_pty",
]) {
  assert.ok(!archLeft.includes(gone), `architect is not even OFFERED ${gone} (v1 left its description in every request)`)
}
for (const keep of ["tm_read", "tm_grep", "tm_bash", "tm_fetch", "tm_memory", "tm_board_write", "tm_ptc_run", "tm_stats"]) {
  assert.ok(archLeft.includes(keep), `architect keeps its governed ${keep}`)
}
assert.equal(
  arch.options.temperature,
  0.2,
  "the all-agents-0.2 invariant rides the request — agent config cannot carry it on v2 (legacy field, and the runner does not send it)",
)
assert.ok(
  !arch.system.some((p) => String(p?.text ?? "").includes("## Team Blackboard")),
  "the resolved board root goes to the lead only, exactly as v1 appends it",
)

const lead = event("team")
await fake.hook("session.context").fire(lead)
const leadLeft = Object.keys(lead.tools)
assert.ok(leadLeft.includes("subagent"), "the lead keeps the dispatch lever")
assert.ok(leadLeft.includes("question") && leadLeft.includes("todowrite"), "and the todo/blocking-question grants its prompt mandates need")
assert.ok(leadLeft.includes("browser_navigate"), "a network role keeps the host's browser catalog")
assert.ok(leadLeft.includes("tm_webfetch") && leadLeft.includes("tm_browser"), "granted with an ask-map, so still offered")
assert.ok(!leadLeft.includes("read"), "the lead has no native read either — tm_read is the governed door")

const preset = event("tester", { temperature: 0.7 })
await fake.hook("session.context").fire(preset)
assert.equal(preset.options.temperature, 0.7, "a temperature already on the request is never overwritten — the user's model variant outranks our default")
assert.ok(Object.keys(preset.tools).includes("browser_navigate"), "the tester keeps the browser for UI verification")
assert.ok(!Object.keys(preset.tools).includes("tm_search"), "…but not the open web")

const comp = event("team")
await fake.hook("session.compaction").fire(comp)
assert.equal(comp.system.length, 6, "the must-survive list is pushed onto the summary request")
await fake.hook("session.compaction").fire(comp)
assert.equal(comp.system.length, 6, "and re-firing does not duplicate it (the hook runs before every request)")
// This fake has been booted TWICE on purpose (the idempotence group above), which
// is what the live host does when it reloads a plugin in-process — so two
// handlers are attached to session.context right now, and the note guard is the
// only thing standing between that and a note repeated every round.
const reloaded = event("team")
await fake.hook("session.context").fire(reloaded)
assert.equal(
  reloaded.system.filter((p) => String(p?.text ?? "").includes("## Team Blackboard")).length,
  1,
  "two registered handlers ran over one request and the board note still landed exactly once",
)
console.log("   OK (surface trimmed per role, 0.2 restored, board root and survival list on the request)")

console.log("7b. the permission guard — the red line below the allowlist, on the HOST's own web path")
const { webGuard, shellGuard, needsCoarseShellAsk } = await import("./dist/host/v2-guard.js")

const meta = webGuard(["http://169.254.169.254/latest/meta-data/iam/"])
assert.equal(meta?.effect, "deny", "native webfetch to the cloud metadata endpoint is DENIED, not asked")
assert.ok(!meta?.message?.includes("批准"), "and the message offers no consent path — a credential leak is never consentable")
assert.equal(
  webGuard(["http://[::ffff:169.254.169.254]/x"]).effect,
  "deny",
  "the IPv4-mapped carrier is unwrapped before the policy reads it (changing notation is not a way around)",
)
assert.equal(webGuard(["http://127.0.0.1:9/"]).effect, "ask", "loopback stays ASKABLE — private is the user's call, not ours")
assert.equal(webGuard(["https://example.com/docs"]), null, "a public host is untouched")
assert.equal(webGuard(["https://example.com/.env"]).effect, "deny", "the remote env-file red line rides along")

assert.equal(shellGuard("npm test", "off"), null, "R6 off classifies nothing")
assert.equal(shellGuard("Get-ChildItem env:PATH", "audit")?.why, "r6-env", "the env face is recognised per command line")
assert.equal(shellGuard("rm -rf build", "audit")?.why, "r2-danger", "and so is the R2 danger face")
assert.equal(shellGuard("npm test", "audit"), null, "an ordinary command gets no verdict — the guard is a floor, not a tax")

const ev = { sessionID: "ses_1", agent: "team", action: "webfetch", resources: ["http://169.254.169.254/"], effect: "allow" }
await fake.hook("permission.evaluate").fire(ev)
assert.equal(ev.effect, "deny", "the hook is wired and flips the host's own decision")
assert.ok(/元数据|保留/.test(String(ev.message)), "with a message naming the rule the agent can read back")
const loose = { sessionID: "ses_1", agent: "team", action: "webfetch", resources: ["http://127.0.0.1:9/"], effect: "deny" }
await fake.hook("permission.evaluate").fire(loose)
assert.equal(loose.effect, "deny", "the guard only ever gets STRICTER — a user rule that already denied is not softened to ask")
const plain = { sessionID: "ses_1", agent: "team", action: "webfetch", resources: ["https://example.com/"], effect: "allow" }
await fake.hook("permission.evaluate").fire(plain)
assert.equal(plain.effect, "allow", "a public fetch is left exactly as the host decided")

// The live probe settled this: `{action:"shell", resourceCount:1}` reached
// permission.evaluate for a real command, so the classifier is the DEFAULT and the
// every-command config ask is the fallback.  A default that flipped because nobody
// remembered why it was conservative is worse than the conservative default, so the
// reason is pinned in both directions.
assert.equal(needsCoarseShellAsk({}, true), false, "hook installed → the per-command classifier decides, no blanket config ask")
assert.equal(needsCoarseShellAsk({ TM_R6_FINE_ASK: "off" }, true), true, "TM_R6_FINE_ASK=off is the explicit way back to coarse")
assert.equal(needsCoarseShellAsk({ TM_R6_FINE_ASK: "0" }, true), true, "and the 0/false/no spellings mean the same")
assert.equal(needsCoarseShellAsk({ TM_R6_FINE_ASK: "on" }, false), true, "no hook → nothing to hand it to, so coarse regardless of the knob")
assert.equal(needsCoarseShellAsk({ TM_R6_FINE_ASK: "garbage" }, true), false, "an unparseable value keeps the supported configuration rather than silently degrading")
console.log("   OK (metadata denied-not-asked, notation carriers unwrapped, never loosens, classifier-in-charge by default)")

console.log("7c. every sub-agent dispatch runs in the background")
const bg = { tool: "subagent", sessionID: "ses_1", agent: "team", input: { agent: "researcher", prompt: "x" } }
await fake.hook("tool.execute.before").fire(bg)
assert.equal(bg.input.background, true, "an omitted background becomes true — a foreground child blocks the lead for its whole run")
const bgFalse = { tool: "subagent", sessionID: "ses_1", agent: "team", input: { agent: "tester", background: false } }
await fake.hook("tool.execute.before").fire(bgFalse)
assert.equal(bgFalse.input.background, true, "even an explicit false is overridden — v2 needs no env flag for this")
const bgStr = { tool: "subagent", sessionID: "ses_1", agent: "team", input: { agent: "reviewer", background: "True" } }
await fake.hook("tool.execute.before").fire(bgStr)
assert.strictEqual(bgStr.input.background, true, "the string form becomes the real boolean, not a truthy string")
const untouched = { tool: "shell", sessionID: "ses_1", agent: "team", input: { command: "npm test" } }
await fake.hook("tool.execute.before").fire(untouched)
assert.deepEqual(untouched.input, { command: "npm test" }, "other tools are never rewritten")
const noObj = { tool: "subagent", sessionID: "ses_1", agent: "team", input: null }
await fake.hook("tool.execute.before").fire(noObj)
assert.equal(noObj.input, null, "an input that is not an object is left alone rather than invented")
console.log("   OK (background forced on every subagent call, nothing else touched)")

console.log("7d. JIT governance over the HOST's own tools")
const { applyV2NativeOffload, renderNativeOffload, NATIVE_GOVERNED_TOOLS } = await import("./dist/host/v2-offload.js")
const BIG = "x".repeat(9000)
// A stub pipeline so this group tests THIS layer's decisions (which tool, which
// part, what shape survives); the threshold/preview/store machinery it calls is
// the same instance tm_* uses and is covered in test-tm-tools.
function offloadHarness({ govern, env } = {}) {
  const f = makeFakeCtx({ directory: workspace("off"), agents: [] })
  const calls = []
  const pipelines = {
    nextStepId: (() => { let n = 0; return () => `s${String(++n).padStart(4, "0")}` })(),
    govern: (stepId, tool, content, opts) => {
      calls.push({ stepId, tool, len: content.length, contentType: opts.contentType })
      return govern ? govern(stepId, tool, content, opts) : content
    },
  }
  const o = applyV2NativeOffload(f.ctx, { pipelines, env: env ?? {} })
  return { f, o, calls }
}
const handled = (tool, result) => {
  const { f, o } = offloadHarness({ govern: () => ({ offloaded: true, ref: "tm://runs/r/steps/s0001/result", access_token: "tok", expire_at: 1777000000000, tokens: 2400, preview: "PREVIEW≤80" }) })
  const ev = { tool, result }
  const hook = f.hook("tool.execute.after")
  return { ev, run: () => hook.handlers.forEach((h) => h(ev)), o }
}
{
  const img = { type: "file", uri: "file:///a.png", mime: "image/png", name: "shot" }
  const t = handled("shell", { content: [{ type: "text", text: BIG }, img, { type: "text", text: "tail" }], metadata: { cwd: "/w" }, output: BIG })
  t.run()
  assert.equal(t.o.report.offloaded, 1, "an oversized native shell result is offloaded")
  assert.equal(t.o.report.seen, 1, "and counted as seen whether or not it needed it")
  const parts = t.ev.result.content
  assert.ok(parts[0].text.includes("tm_fetch") && parts[0].text.includes("tm://runs/r/steps/s0001/result"), "the text part becomes preview + handle")
  assert.ok(!parts[0].text.includes(BIG.slice(0, 40)), "the full body is NOT still in the part the model reads")
  assert.deepEqual(parts[1], img, "a screenshot attachment is never dropped to save tokens")
  assert.equal(parts[2].text, "", "a second text part is blanked rather than left carrying the payload")
  assert.deepEqual(t.ev.result.metadata, { cwd: "/w" }, "metadata passes through untouched")
  // 9000 ASCII chars ≈ 2250 tokens by the CJK-aware口径, preview "PREVIEW≤80" is a
  // handful — so the saving is measured off the body minus what actually arrived.
  assert.ok(t.o.report.tokensSaved > 2100 && t.o.report.tokensSaved <= 2250, "the saving is net of the preview, not the payload size")
}
{
  const t = handled("write", { content: [{ type: "text", text: BIG }] })
  t.run()
  assert.equal(t.ev.result.content[0].text, BIG, "a tool outside the closed list is not interpreted at all")
  assert.equal(t.o.report.seen, 0, "and not counted — the list is the boundary")
}
{
  const t = handled("read", { stdout: BIG })
  t.run()
  assert.equal(t.o.report.considered, 0, "an UNRECOGNIZED result shape is left alone rather than guessed at")
}
{
  const { f } = offloadHarness({ govern: () => { throw new Error("store down") } })
  const ev = { tool: "shell", result: { content: [{ type: "text", text: BIG }] } }
  f.hook("tool.execute.after").handlers.forEach((h) => h(ev))
  assert.ok(ev.result.content[0].text === BIG || ev.result.content[0].text.length > 1000, "a governance failure degrades to the host's verbatim result")
}
{
  const off = offloadHarness({
    env: { TM_NATIVE_OFFLOAD: "off" },
    govern: () => ({ offloaded: true, ref: "r", access_token: "a", expire_at: 1, tokens: 1, preview: "p" }),
  })
  const ev = { tool: "shell", result: { content: [{ type: "text", text: BIG }] } }
  off.f.hook("tool.execute.after").handlers.forEach((h) => h(ev))
  assert.equal(ev.result.content[0].text, BIG, "TM_NATIVE_OFFLOAD=off restores the host's verbatim injection")
  assert.equal(off.o.report.seen, 1, "it still sees the call, so tm_stats can say the switch is why nothing moved")
  assert.equal(off.o.active, false, "and reports itself inactive so the boot note can say so out loud")
}
{
  const noHook = { tool: {} }
  const o = applyV2NativeOffload(noHook, { pipelines: { nextStepId: () => "s1", govern: () => "" } })
  assert.equal(o.registrations.length, 0, "a host with no tool.hook yields no seam — reported, not assumed")
  assert.equal(o.active, false, "and `active` means governance IS running, not merely that the switch is on")
  assert.equal(applyV2NativeOffload({ tool: { hook: () => Promise.resolve({ dispose: async () => {} }) } }, { pipelines: { nextStepId: () => "s1", govern: () => "" }, env: { TM_NATIVE_OFFLOAD: "off" } }).active, false, "switching it off reads the same because the effect is the same: nothing is governed")
}
const rendered = renderNativeOffload("shell", { offloaded: true, ref: "tm://runs/r/steps/s0001/result", access_token: "tok", expire_at: 1777000000000, tokens: 2400, preview: "PREVIEW" })
assert.ok(/2400 token 没有进入上下文/.test(rendered), "the sentence states how much did NOT arrive")
assert.ok(/mode:"structure" \| "lines"/.test(rendered), "and names the two ways to page the body back")
assert.ok(/不要为了看一眼把全文读回来/.test(rendered), "it tells the model not to page the whole body back just to look once")
assert.deepEqual(
  [...NATIVE_GOVERNED_TOOLS].sort(),
  ["bash", "execute", "glob", "grep", "read", "shell", "subagent", "webfetch"],
  "the governed list stays closed -- and `execute` is on it because that is the ONLY door native browser output has into the context (the Team surface is edit/execute/question/shell/subagent/write)",
)
assert.ok(![...NATIVE_GOVERNED_TOOLS].some((t) => ["agent", "patch", "question", "write", "edit"].includes(t)), "shapes nobody has observed are still not interpreted (`subagent` earns its place: execute.after was measured carrying {content,metadata,output})")
console.log("   OK (closed tool list, unknown shapes untouched, attachments and metadata preserved, failure degrades, off restores verbatim)")

console.log("8. the config projection — what the installer copies onto disk")
const genRoot = workspace("gen")
const GEN = fileURLToPath(new URL("./scripts/gen-v2-config.mjs", import.meta.url))
const gen = () => execFileSync(process.execPath, [GEN, "--dir", genRoot], { encoding: "utf8" })
gen()

const agentFiles = fs.readdirSync(path.join(genRoot, "agents")).sort()
const cmdFiles = fs.readdirSync(path.join(genRoot, "commands")).sort()
assert.deepEqual(
  agentFiles,
  Object.keys(agents).map((id) => `${id}.md`).sort(),
  `all six roles are projected as markdown (got ${agentFiles.join(",")})`,
)
assert.deepEqual(
  cmdFiles,
  Object.keys(commands).map((n) => `${n}.md`).sort(),
  `every /team-* command is projected (got ${cmdFiles.join(",")})`,
)

const teamMd = fs.readFileSync(path.join(genRoot, "agents", "team.md"), "utf8")
const archMd = fs.readFileSync(path.join(genRoot, "agents", "architect.md"), "utf8")
assert.match(teamMd, /^mode: "primary"$/m, "the lead is selectable as a primary agent")
assert.match(archMd, /^mode: "subagent"$/m, "the specialists are subagent-mode")
assert.match(
  archMd,
  /action: "subagent"\s*\n\s*resource: "\*"\s*\n\s*effect: "deny"/,
  "T3 rides the projection: a specialist may not launch children — the lead is the only dispatcher",
)
assert.ok(
  archMd.includes(agents.architect.prompt.trimEnd().slice(0, 80)),
  "the body IS the projected prompt, not a paraphrase of it",
)

const planMd = fs.readFileSync(path.join(genRoot, "commands", "team-plan.md"), "utf8")
assert.match(planMd, /^agent: "architect"$/m, "the command selects its role")
assert.ok(planMd.includes("$ARGUMENTS"), "the v1 placeholder survives — v2 expands the same tokens")
assert.ok(
  !/^template:/m.test(planMd.split("---")[1] ?? ""),
  "no `template` key in frontmatter — the docs forbid it because the body supplies it",
)

assert.match(gen(), /已是最新/, "re-running writes nothing (the installer may run it on every update)")
fs.writeFileSync(path.join(genRoot, "agents", "team.md"), "# my own team agent\n", "utf8")
assert.match(gen(), /不是我生成的文件/, "a hand-written agents/team.md is refused, never clobbered")
assert.equal(
  fs.readFileSync(path.join(genRoot, "agents", "team.md"), "utf8"),
  "# my own team agent\n",
  "and its bytes are untouched",
)
// The personality fork: v2 does not register tm_ptc_run, so a v2 role must not
// be told to use it.  gen() above already throws if a V2_TEXT key stops
// matching (the source was edited and the table was not), so these two
// assertions are the other half — the substitution landed in the bytes on disk.
const allRoles = agentFiles.map((f) => fs.readFileSync(path.join(genRoot, "agents", f), "utf8")).join("\n")
assert.ok(!allRoles.includes("tm_ptc_run"), "no v2 role is told to call a tool v2 does not register")
assert.ok(allRoles.includes("`execute` (Code Mode)"), "the batching mandate names the tool v2 actually has")
assert.ok(allRoles.includes("## Recon batching (Code Mode first)"), "and so does the specialist section heading")
console.log("   OK (12 files, modes + triples projected, idempotent, foreign files respected, prompt forked)")

console.log("8b. the surface probe — names in, values never")
const probeDir = workspace("probe")
const probeFile = path.join(probeDir, "surface.jsonl")
const summaries = []
const pfake = makeFakeCtx({ directory: probeDir, agents: [] })
const probe = await applyV2Probe(pfake.ctx, {
  env: { TM_V2_PROBE: probeFile },
  flushMs: 60_000,
  onSummary: (s) => summaries.push(s),
})
assert.equal(probe.enabled, true, "the probe says whether TM_V2_PROBE reached it — an empty file otherwise has two causes")
// The host's convention is ctx.session.hook("context"): the POINT name, not
// "session.context".  Registering the dotted form attaches a hook nothing ever
// fires, and the probe would then report an empty host surface as a fact.
for (const want of ["session.context", "tool.execute.before", "tool.execute.after", "permission.evaluate"]) {
  assert.ok(pfake.hookNames().includes(want), `the probe attaches ${want} under the name the host actually calls`)
}
// (a legitimate point like `execute.before` already carries a dot, so the check is
// on the DOMAIN being spelled twice, not on the dot count)
assert.ok(
  !pfake.hookNames().some((n) => /^(session|tool|permission)\.\1\./.test(n)),
  "no hook is registered with the domain spelled into its own name (that attaches a hook nothing fires)",
)
await pfake.hook("session.context").fire({ agent: "team", tools: { browser_tabs_open: {}, read: {} } })
assert.deepEqual(probe.report.toolNames, ["browser_tabs_open", "read"], "the tool surface is recorded BY NAME")
assert.equal(probeSummary(probe.report).probe_browser_tools, "browser_tabs_open", "the native browser namespace is separable from the rest")
await pfake.hook("tool.execute.before").fire({ tool: "read", input: { path: "/tmp/private/notes.md" } })
await pfake.hook("permission.evaluate").fire({ action: "shell", resources: ["Get-ChildItem env:SECRET_TOKEN"] })
await pfake.hook("permission.evaluate").fire({ action: "webfetch", resources: ["https://internal.example/x?token=abc"] })
assert.equal(probe.report.evaluations, 2, "every evaluation is counted, named or not")
assert.equal(probe.report.urlResources, 1, "a URL-bearing resource is counted as a BOOLEAN, never as the URL")
const rawProbe = fs.readFileSync(probeFile, "utf8")
for (const secret of ["SECRET_TOKEN", "internal.example", "token=abc", "private/notes.md"]) {
  assert.ok(!rawProbe.includes(secret), `the probe file never carries the value ${secret} — the R6口径 applies to diagnostics too`)
}
assert.ok(rawProbe.includes("shell") && rawProbe.includes("webfetch"), "but the action names land, which is the whole point")
assert.ok(rawProbe.includes('"inputKeys":["path"]'), "an input's KEY names are recorded, not its argument values")
assert.equal(summaries.length, 1, "one snapshot at attach — an idle session re-running the context hook must not append per request")
probe.flush(true)
assert.equal(summaries.length, 2, "a forced flush is how the final state still lands")
assert.equal(summaries[1].probe_evaluations, 2, "and it carries the counters, which is what #12 needs")
const noPerm = makeFakeCtx({ directory: probeDir, agents: [] })
delete noPerm.ctx.permission
const probe2 = await applyV2Probe(noPerm.ctx, { env: {} })
assert.equal(probe2.enabled, false, "with no TM_V2_PROBE the probe observes without writing a file")
assert.ok(
  probe2.report.hooksMissing.some((h) => h === "permission.evaluate"),
  "a seam the host does not expose is NAMED — otherwise 'no browser tools' and 'nobody was listening' are one answer",
)
for (const r of probe.registrations) await r.dispose()
assert.equal(probe.registrations.length, 4, "all four observations are registered as disposables")
console.log(`   OK (4 hooks under host names, names/counts only, ${(rawProbe.match(/\n/g) ?? []).length} probe lines, missing seam reported)`)

console.log("9. teardown")
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
console.log("\ntest-v2-adapter.mjs: ALL PASS (11 groups)")
