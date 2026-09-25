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
 *   1. registration: the nine tm_* v2 still ships land on the tool surface,
 *      tm_dispatch and the four retired names do not, and each carries a real
 *      description + a JSON Schema
 *   2. the result shape: no bare `output` anywhere (the host answers that with
 *      "Tool result declared output without an output schema")
 *   3. the retirement: tm_read/tm_grep/tm_bash are gone AND the native file tools
 *      are not denied alongside them — the ladder has to arrive, not just shift
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
// v2 registers nine of the thirteen: ptc_run left for the host's Code Mode, and
// read/grep/bash left because the governed native tools replaced them (the
// offload layer is what made that possible, so the order matters).
const V2_RETIRED = ["tm_ptc_run", "tm_read", "tm_grep", "tm_bash"]
/** v2 adds what v1 never had: the LEDGER's home, because a v2 host has no
 *  `todowrite` for the mandate to attach to.  v1 registers no such tool — the
 *  v1 personality is frozen, so this arrives through `ledgerStore` being handed
 *  in by v2 alone (see src/tm/index.ts). */
const V2_ONLY_TOOLS = ["tm_ledger"]
const V2_NAMES = [...TM_NAMES.filter((n) => !V2_RETIRED.includes(n)), ...V2_ONLY_TOOLS]
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
for (const gone of ["tm_read", "tm_grep", "tm_bash"]) {
  assert.ok(
    !registered.includes(gone),
    `${gone} is retired on v2: the native tool plus the execute.after offload govern the same job, and v1 keeps the alias`,
  )
}
assert.equal(
  registered.filter((n) => n.startsWith("tm_")).length,
  V2_NAMES.length,
  `exactly the ten governed tools v2 ships arrive (got ${registered.filter((n) => n.startsWith("tm_")).join(",")})`,
)
for (const name of V2_NAMES) {
  assert.ok(String(byName[name].description ?? "").length > 40, `${name} carries a real description`)
  assert.equal(byName[name].input?.type, "object", `${name}'s input is a JSON Schema object`)
}
assert.ok(
  Object.keys(byName.tm_webfetch.input.properties ?? {}).includes("url"),
  "tm_webfetch's parameter names survive the zod→JSON Schema translation",
)

// tm_join / tm_pty / tm_stats build their args WITHOUT zod, so their shape
// arrives as `{ key: { descriptor: "name: type (guidance)" } }`.  Handing that
// to z.object() throws `undefined is not an object (evaluating 'schema._zod.def')`
// — measured live, where all three reached the model as a permissive
// `{additionalProperties:true}` with no parameter guidance at all.  The
// descriptor branch has to recover names AND types, because a schema that says
// "string" for an enum parameter is the same guidance-free shape in disguise.
for (const name of ["tm_join", "tm_pty", "tm_stats", "tm_ledger"]) {
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
for (const name of ["tm_join", "tm_pty", "tm_stats", "tm_ledger"]) {
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

// How our tools reach the model AT ALL.  The 2.0.16 binary decides it with
// `options.codemode`: not-false means "catalog only", where the host keeps the
// first line of the description (≤120 chars).  That is the real explanation for a
// live session showing six tools and zero tm_* after a clean registration — and the
// reason a knob exists: the other half of the trade is that direct definitions ride
// every request.  Both sides are pinned so nobody has to guess which world they are in.
assert.equal(
  byName.tm_join.options?.codemode,
  undefined,
  "by default we send no codemode flag, and the boot note says what that costs us (the governance text below the first line never arrives)",
)
{
  const direct = makeFakeCtx({ directory: ws, agents: [] })
  process.env.TM_V2_CODEMODE = "direct"
  const dr = await withCapturedConsole(() => plugin.setup(direct.ctx))
  const dt = Object.fromEntries(direct.tools.list().map((t) => [t.id ?? t.name, t]))
  assert.equal(dt.tm_join?.options?.codemode, false, "TM_V2_CODEMODE=direct sends codemode:false, which is the host's own switch for a real tool definition")
  assert.ok(
    warns.some((w) => /Code Mode 目录/.test(w)),
    "the default boot says out loud that only the first line of our descriptions reaches the model",
  )
  assert.ok(
    (dr.warns ?? []).some((w) => /TM_V2_CODEMODE=direct/.test(w)) &&
      !(dr.warns ?? []).some((w) => /只有描述首行/.test(w)),
    "and the direct boot names the world it is in instead of repeating the warning",
  )
  delete process.env.TM_V2_CODEMODE
  await dr.value?.()
}
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
// Driven by tm_join, not by tm_read: the file trio is retired on this
// personality, so the shape claim has to ride a tool v2 actually registers.
const joinRes = await byName.tm_join.execute({}, CTX)
assert.ok(!("output" in joinRes), "no bare `output` key — the host rejects it without an output schema")
assert.ok(Array.isArray(joinRes.content) && joinRes.content[0].type === "text", "text arrives as a content part")
assert.ok(textOf(joinRes).length > 0, "and the answer is the text of a content part, not a field beside it")
console.log("   OK (content parts, attachments ride as file entries)")

console.log("3. the retirement: the ladder moves to the native tools, both halves at once")
// Deleting the aliases is the easy half.  v1's matrix DENIES native
// read/grep/glob for every role (they were the shadow of tm_read), so if the
// translation projected those denies, a v2 role would end up with NO file access
// at all — a retirement that strands the user rather than shifting the door.
// Both layers have to agree, and both are pinned here.
const teamLadder = fake.agents.get("team").permissions.filter((p) => ["read", "grep", "glob"].includes(p.action))
assert.deepEqual(teamLadder.map((p) => p.action), [], "no deny for read/grep/glob is projected into the v2 config")
for (const gone of ["tm_read", "tm_grep", "tm_bash"]) {
  assert.equal(
    fake.agents.get("team").permissions.filter((p) => p.action === gone).length,
    0,
    `${gone} has no permission triple either — a rule for an action the host never registers claims a capability that does not exist`,
  )
}
// The governance that made this legal has to be ATTACHED, not intended: the
// offload reads the native results, so without it the retirement would just stop
// governing file output.
assert.ok(
  fake.hookNames().includes("tool.execute.after"),
  "tool.execute.after is registered — the layer that governs native read/grep/shell results",
)
const offloadTools = fake.hook("tool.execute.after").handlers?.length ?? 0
assert.ok(offloadTools > 0, `the offload handler count is observable (${offloadTools})`)
console.log("   OK (aliases gone, native ladder left in place, governance attached)")

console.log("3b. tm_ledger — the LEDGER rule gets a home when the host has no todowrite")
// The lead's prompt mandates the list BEFORE the work; v2 gives a plugin no
// `todowrite` and no `session.todo` to read, so the mandate had no landing spot
// and tm_join's goal check had nothing to check.  ctx.storage is the host's own
// domain (the boot self-check proves a write comes back), which beats a session
// list left lying in a temp directory.
const led = byName.tm_ledger
const LED_KEY = "team-mode/ledger/ses_v2"
const add1 = await led.execute({ action: "add", text: "把 v2 的 LEDGER 落到 ctx.storage" }, CTX)
assert.match(textOf(add1), /#1 /, "the reply names the id it minted, so a later round can address it")
assert.match(textOf(add1), /已写入 ctx\.storage/, "goal #6: the answer says the write REACHED the host, not that it was noted somewhere")
const afterAdd = await fake.ctx.storage.get(LED_KEY)
assert.equal(afterAdd?.items?.length, 1, "the item is really in the host's storage under this session")
const addDup = await led.execute({ action: "add", text: "把 v2 的 LEDGER 落到 ctx.storage。" }, CTX)
assert.match(textOf(addDup), /已经在清单上/, "the same ask arriving twice is one item, not two the lead has to close twice")
assert.equal((await fake.ctx.storage.get(LED_KEY)).items.length, 1, "and no second line was written")
await led.execute({ action: "add", text: "补 v2 单独的安装文档" }, CTX)
const amb = await led.execute({ action: "done", id: "v2" }, CTX)
assert.match(textOf(amb), /匹配到 2 条/, "an id that matches two items is refused with the candidates named — a list tool that guesses destroys its own point")
assert.ok(!/已写入/.test(textOf(amb)), "and nothing was claimed to be saved on the way to that refusal")
const blk = await led.execute({ action: "blocked", id: 2, note: "等用户拍板文档要不要中英双语" }, CTX)
assert.match(textOf(blk), /#2 → blocked.*等用户拍板/s, "blocked is a state with the reason attached, not an exit")
const list = await led.execute({ action: "list" }, CTX)
assert.match(textOf(list), /未完成 2/, "list counts what is still open")
assert.match(textOf(list), /\[!\] #2/, "and renders the blocked mark rather than folding it into 未开始")
const { ledgerGoalLine, normalizeLedger, openItems } = await import("./dist/tm/ledger.js")
const stored = normalizeLedger(await fake.ctx.storage.get(LED_KEY))
const goalLine = ledgerGoalLine(stored)
assert.ok(goalLine && /目标未达成/.test(goalLine) && /卡住/.test(goalLine), "the tripwire line the settled round rides")
assert.equal(openItems(stored).length, 2, "the ledger survives a storage round-trip through the same parser tm_join uses")
const done1 = await led.execute({ action: "done", id: 1, note: "这一条就是它自己" }, CTX)
assert.match(textOf(done1), /#1 → done/, "…and an exact id does land")
assert.equal(ledgerGoalLine(normalizeLedger(await fake.ctx.storage.get(LED_KEY))).match(/还有 (\d+) 项/u)[1], "1", "the count moves with the list, it is not a constant the tool repeats")
const notLead = await led.execute({ action: "list" }, { ...CTX, agent: "researcher" })
assert.match(textOf(notLead), /领队/, "the list is the lead's instrument; a specialist answers in STATUS instead")
{
  const bad = makeFakeCtx({ directory: ws, agents: [] })
  bad.ctx.storage.set = async () => {
    throw new Error("quota")
  }
  const b = await withCapturedConsole(() => plugin.setup(bad.ctx))
  const badTools = Object.fromEntries(bad.tools.list().map((t) => [t.id ?? t.name, t]))
  const failed = await badTools.tm_ledger.execute({ action: "add", text: "一条写不进去的要求" }, { ...CTX, sessionID: "ses_bad" })
  assert.match(textOf(failed), /没写进/, "a store that refuses the write is reported as a failure")
  assert.ok(!/已写入/.test(textOf(failed)), "and it never says 已写入 on the same breath")
  assert.equal(await bad.ctx.storage.get("team-mode/ledger/ses_bad"), undefined, "nothing reached storage, which is what the sentence claims")
  await b.value?.()
}
// The other half of the seam: tm_join's goal tripwire has to read the SAME store,
// because "所有子代理已结算" says nothing about the user's goal.  Pinned textually —
// a second source of truth for the list would make the warning lie.
const dispatchSrc = fs.readFileSync("src/tm/dispatch.ts", "utf8")
assert.ok(/deps\.ledgerStore/.test(dispatchSrc), "tm_join consults the ledger store")
assert.ok(/ledger_empty/.test(dispatchSrc), "and an empty ledger is its own answer, not a silent pass")
console.log("   OK (host-backed list, ids that cannot be guessed, a write that says whether it landed)")

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
assert.ok(find("tm_join").some((p) => p.effect === "allow" && p.resource === "*"), "the whitelist reaches v2 as triples")
assert.ok(find("shell").some((p) => p.effect === "allow"), "v1 `bash` is emitted under v2's action name `shell`")
assert.equal(find("bash").length, 0, "no v1-only action name is left behind as a phantom rule")
assert.ok(find("subagent").some((p) => p.effect === "allow"), "the lead's delegation grant reaches v2 as `subagent`")
assert.ok(
  fake.agents.get("researcher").permissions.some((p) => p.action === "subagent" && p.effect === "deny"),
  "and the no-specialist-delegation deny survives the translation",
)
assert.ok(find("websearch").some((p) => p.effect === agents.team.permission.websearch), "the matrix decides a network action, not a stray config line (the user's value is replaced by what our whitelist says)")
// The host's 45 browser tools share ONE permission action (`browser`) and never
// appear in the direct tool surface, so the request-layer `browser_*` deletion
// alone left a role that is DENIED tm_browser able to browse from inside `execute`
// — the goal-5 promise broken by an implementation detail nobody had read.
assert.ok(
  fake.agents.get("architect").permissions.some((p) => p.action === "browser" && p.effect === "deny" && p.resource === "*"),
  "a role without tm_browser is denied the host's `browser` action too, not just our door",
)
assert.equal(
  find("browser").length,
  0,
  "and the lead, which carries tm_browser with an ask-map, gets no blanket browser deny (that would deny itself)",
)
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
  shape.filter((p) => p.action === "tm_join").length,
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
// The synthetic surface is the v2 reality: the native catalog plus the ten
// tm_* this personality registers.  tm_read/tm_grep/tm_bash/tm_ptc_run are not
// listed because a v2 host has no such tool to offer — asserting against them
// would be asserting against a v1 surface.
const SURFACE = [
  "read", "grep", "glob", "list", "edit", "write", "patch", "shell", "webfetch", "websearch",
  "skill", "question", "todowrite", "subagent", "browser_navigate", "browser_tabs_list",
  "tm_fetch", "tm_memory", "tm_board_write", "tm_stats", "tm_join", "tm_pty", "tm_ledger",
  "tm_browser", "tm_search", "tm_webfetch",
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
  "list", "edit", "write", "shell", "webfetch", "websearch", "question",
  "todowrite", "subagent", "browser_navigate", "browser_tabs_list",
  "tm_webfetch", "tm_search", "tm_browser", "tm_join", "tm_pty", "tm_ledger",
]) {
  assert.ok(!archLeft.includes(gone), `architect is not even OFFERED ${gone} (v1 left its description in every request)`)
}
// The other half of the retirement: `shell` is denied above (architect owns no
// command channel on either personality) while read/grep/glob are NOT — that is
// where a v2 role reads a file now, and its output is governed by
// `tool.execute.after` rather than by which tool it used.
for (const keep of ["read", "grep", "glob", "tm_fetch", "tm_memory", "tm_board_write", "tm_stats"]) {
  assert.ok(archLeft.includes(keep), `architect keeps its ${keep} — the v2 file ladder`)
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
assert.ok(leadLeft.includes("tm_ledger"), "the lead keeps the list it is mandated to keep — v2 has no todowrite to lean on")
assert.ok(leadLeft.includes("question") && leadLeft.includes("todowrite"), "and the todo/blocking-question grants its prompt mandates need")
assert.ok(leadLeft.includes("browser_navigate"), "a network role keeps the host's browser catalog")
assert.ok(leadLeft.includes("tm_webfetch") && leadLeft.includes("tm_browser"), "granted with an ask-map, so still offered")
assert.ok(leadLeft.includes("read") && leadLeft.includes("shell"), "the lead reads and runs through the native tools — its v1 aliases are retired, not missed")

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

console.log("7e. Team-scope isolation — nothing outside Team may be touched (#22)")
// The user's rule: every change the plugin makes must stay inside Team mode, and
// build/plan/a third-party agent have to look like a fresh install.  Each v2 hook
// fires for EVERY session on the host, so this is not a property the layers can
// get by accident — it is a question each one asks before it writes.
{
  const { createTeamScope } = await import("./dist/host/v2-scope.js")
  const s = createTeamScope(["team", "researcher"])
  assert.equal(s.decide({ agent: "team" }), "ours")
  assert.equal(s.decide({ agent: "build" }), "foreign")
  assert.equal(s.decide({ agent: undefined, sessionID: "ses_x" }), "unknown", "no agent and an unseen session is NOT ours")
  s.learn("researcher", "ses_x")
  assert.equal(s.decide({ sessionID: "ses_x" }), "ours", "a session we served a tool call for is known even if the event omits agent")
  assert.equal(s.decide({ sessionID: "ses_y" }), "unknown", "…and that memory does not generalize to strangers")
  s.count("foreign"); s.count("foreign"); s.count("unknown")
  assert.deepEqual({ ...s.report }, { ours: 0, foreign: 2, unknown: 1 }, "the counts are what tm_stats reads; a skipped call must leave a trace")

  const f = makeFakeCtx({ directory: ws, agents: [] })
  const { applyV2PermissionGuards, applyV2BackgroundForce } = await import("./dist/host/v2-guard.js")
  const { applyV2NativeOffload } = await import("./dist/host/v2-offload.js")
  const scope = createTeamScope(["team", "architect", "implementer", "reviewer", "tester", "researcher"])
  const gg = await applyV2PermissionGuards(f.ctx, { envProtectMode: "off", scope })
  const bgg = await applyV2BackgroundForce(f.ctx, { scope })
  const off = applyV2NativeOffload(f.ctx, {
    pipelines: { nextStepId: () => "s0001", govern: () => ({ offloaded: true, ref: "tm://x", access_token: "t", expire_at: 1, tokens: 900, preview: "P" }) },
    env: {},
    scope,
  })
  const BIG = "y".repeat(9000)
  // ① somebody else's permission decision stays theirs
  const evForeign = { sessionID: "ses_build", agent: "build", action: "webfetch", resources: ["http://169.254.169.254/"], effect: "allow" }
  await f.hook("permission.evaluate").handlers.forEach((h) => h(evForeign))
  assert.equal(evForeign.effect, "allow", "a build session's metadata fetch is not ours to flip — Team-scoped by request")
  assert.equal(gg.report.foreignSkipped, 1, "and the skip is COUNTED, because the size of that hole is a fact the user can act on")
  const evOurs = { sessionID: "ses_team", agent: "team", action: "webfetch", resources: ["http://169.254.169.254/"], effect: "allow" }
  await f.hook("permission.evaluate").handlers.forEach((h) => h(evOurs))
  assert.equal(evOurs.effect, "deny", "the same fetch inside Team is still denied")
  // ② somebody else's dispatch is not converted to background
  const bForeign = { tool: "subagent", sessionID: "ses_build", agent: "build", input: { prompt: "x" } }
  await f.hook("tool.execute.before").handlers.forEach((h) => h(bForeign))
  assert.equal(bForeign.input.background, undefined, "a build agent's synchronous dispatch stays synchronous")
  assert.ok(bgg.report.seen >= 0 && bgg.report.forced === 0, "and nothing was forced")
  const bOurs = { tool: "subagent", sessionID: "ses_team", agent: "team", input: { prompt: "x" } }
  await f.hook("tool.execute.before").handlers.forEach((h) => h(bOurs))
  assert.equal(bOurs.input.background, true, "ours still gets it")
  // ③ somebody else's tool result is never rewritten, and never copied into our store
  const rForeign = { content: [{ type: "text", text: BIG }], metadata: { keep: 1 } }
  await f.hook("tool.execute.after").handlers.forEach((h) => h({ tool: "shell", sessionID: "ses_build", agent: "build", result: rForeign }))
  assert.equal(rForeign.content[0].text, BIG, "a build session's oversized stdout reaches context untouched")
  assert.equal(off.report.seen, 0, "and it is not counted as governed — the coverage number must not lie by omission")
  const rOurs = { content: [{ type: "text", text: BIG }] }
  await f.hook("tool.execute.after").handlers.forEach((h) => h({ tool: "shell", sessionID: "ses_team", agent: "team", result: rOurs }))
  assert.ok(rOurs.content[0].text.includes("tm://x"), "ours does get offloaded")
  // ④ the request layer: a foreign agent's tools, temperature and system prompt are
  //    exactly what the host assembled
  const foreignReq = {
    agent: "build",
    system: [],
    messages: [],
    options: {},
    tools: Object.fromEntries(["read", "shell", "webfetch", "tm_browser"].map((n) => [n, { description: "d", input: {} }])),
  }
  await fake.hook("session.context").fire(foreignReq)
  assert.equal(Object.keys(foreignReq.tools).length, 4, "build is offered every tool the host gave it — we delete nothing for a stranger")
  assert.equal(foreignReq.options.temperature, undefined, "and we do not set its temperature")
  assert.equal(foreignReq.system.length, 0, "no board note in somebody else's system prompt")
  // ⑤ an event with no agent at all is treated as NOT ours (isolation wins over
  //    coverage), and the count is where the loss becomes visible.
  const anon = { content: [{ type: "text", text: BIG }] }
  await f.hook("tool.execute.after").handlers.forEach((h) => h({ tool: "shell", sessionID: "ses_never_seen", result: anon }))
  assert.equal(anon.content[0].text, BIG, "unknown owner → untouched")
  assert.equal(scope.report.unknown >= 1, true, "…but counted as unknown, which is how a host that drops `agent` gets noticed")
  for (const r of [...gg.registrations, ...bgg.registrations, ...(await Promise.all(off.registrations))]) await r.dispose()
}
console.log("   OK (five layers ask who owns the call; foreign untouched, unknown untouched and counted)")

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
  const t = handled("mcp_thing", { content: [{ type: "text", text: BIG }] })
  t.run()
  assert.equal(t.ev.result.content[0].text, BIG, "a tool outside the governed surface is not interpreted at all")
  assert.equal(t.o.report.seen, 0, "…is not counted as governed…")
  assert.equal(t.o.report.unmatched, 1, "…but IS counted as a gap in the coverage (#23: the number must be able to say it missed something)")
}
{
  // `write` joined the surface with #23: coverage may not depend on which tool the
  // model picked. Safety did not move — the rewrite is still decided per payload.
  const t = handled("write", { content: [{ type: "text", text: BIG }] })
  t.run()
  assert.ok(t.ev.result.content[0].text.includes("tm_fetch"), "an oversized native write result is offloaded like any other governed tool")
  assert.equal(t.o.report.seen, 1, "and it counts toward the governed surface")
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
  ["bash", "edit", "execute", "glob", "grep", "patch", "question", "read", "shell", "subagent", "webfetch", "websearch", "write"],
  "every tool a Team role can call is on the list (#23) — coverage may not depend on which tool the model happened to pick",
)
const { isGovernedNative } = await import("./dist/host/v2-offload.js")
assert.ok(isGovernedNative("browser_navigate") && isGovernedNative("browser_tabs_list"), "the host's 45 browser tools are covered BY NAMESPACE: a 45-name list would go stale on the 46th and we would not notice")
assert.ok(!isGovernedNative("todowrite") && !isGovernedNative("mcp_thing"), "and a tool this host does not have is not silently claimed as governed")
// Widening the NAMES is safe only because the decision to rewrite is made per
// PAYLOAD: a shape nobody has observed is left byte-exact and counted, never
// interpreted. Without this, "closed list" was protecting against our own guesswork.
{
  const t = handled("edit", { weirdShape: { deeply: "nested" } })
  t.run()
  assert.deepEqual(t.ev.result, { weirdShape: { deeply: "nested" } }, "an unknown result shape is not interpreted, even for a tool on the list")
  assert.equal(t.o.report.seen, 1, "the call was in the governed surface")
  assert.equal(t.o.report.considered, 0, "…and nothing was rewritten")
  const u = { tool: "mcp_something", agent: "team", sessionID: "ses_cov", result: { content: [{ type: "text", text: BIG }] } }
  const h = offloadHarness()
  await h.f.hook("tool.execute.after").handlers.forEach((fn) => fn(u))
  assert.equal(h.o.report.unmatched, 1, "a tool we do not govern is COUNTED as a gap instead of being invisible in the coverage number")
  assert.equal(h.o.report.ours, 1, "…on a session that is ours; the denominator is every call, not only the recognised ones")
}
// The v2 envelope: read out of the host's own result mapping, and the reason the
// v1 matcher is dead there is measurable — `<task ` occurs zero times in 2.0.16.
// A sub-agent reply arrives wrapped, so governance must swap the BODY and
// reproduce the wrapper: the sessionID inside it is how the lead gets the whole
// reply back, and a generic governed sentence would delete that pointer.
{
  const { parseHostEnvelope } = await import("./dist/task-offload.js")
  const sync = `<subagent sessionID="ses_c1" state="completed">
${BIG.slice(0, 400)}
</subagent>`
  const withDesc = `<subagent sessionID="ses_c2" state="completed" description="读法清单">
body
</subagent>`
  const failed = `<subagent sessionID="ses_c3" state="error">
why it broke
</subagent>`
  assert.equal(parseHostEnvelope(sync)?.form, "v2-subagent", "the synchronous v2 envelope is recognised")
  assert.equal(parseHostEnvelope(withDesc)?.description, "读法清单", "and so is the background form with its description attribute")
  assert.equal(parseHostEnvelope(failed), null, "a FAILED child is not offloaded — hiding why it broke is worse than the tokens")
  assert.equal(parseHostEnvelope("just text"), null, "non-envelope text is left alone")
  const e = offloadHarness({
    govern: () => ({ offloaded: true, ref: "tm://r", access_token: "t", expire_at: 1777000000000, tokens: 3000, preview: "PREVIEW" }),
  })
  const ev = { tool: "subagent", result: { content: [{ type: "text", text: sync }], metadata: { sessionID: "ses_c1" } } }
  e.f.hook("tool.execute.after").handlers.forEach((h) => h(ev))
  const txt = ev.result.content[0].text
  assert.ok(/^<subagent sessionID="ses_c1" state="completed">/.test(txt), "the wrapper survives the rewrite, attributes intact")
  assert.ok(txt.includes("PREVIEW") && txt.includes("tm_join") && txt.includes("ses_c1"), "preview + a pointer naming the child session")
  assert.ok(!txt.includes(BIG.slice(0, 400)), "the body is gone from the context")
  assert.equal(e.o.report.envelopes, 1, "recognised is counted even where nothing was rewritten — a zero must not read as 'nothing was big'")
}
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
// Restore the generated lead file first: the case above left a hand-written stub in
// place precisely to prove the generator refuses to clobber it, and the delegation
// mandate lives only in the lead — asserting against that stub would test the stub.
fs.rmSync(path.join(genRoot, "agents", "team.md"), { force: true })
gen()
const allRoles = agentFiles.map((f) => fs.readFileSync(path.join(genRoot, "agents", f), "utf8")).join("\n")
assert.ok(!allRoles.includes("tm_ptc_run"), "no v2 role is told to call a tool v2 does not register")
// The same rule covers the file trio and the tool NAME the host uses for it: a
// lead told to reach for `tm_read` or "the built-in bash" calls something that is
// not on its surface, and the wasted round is exactly what the prompt exists to
// save.  `bash` survives in ONE place — the markdown code-fence language list,
// where it is a highlighting name and not a tool — so the check is on the two
// shapes that DO name a tool.
for (const gone of ["tm_read", "tm_grep", "tm_bash"]) {
  assert.ok(!allRoles.includes(gone), `the v2 prompts no longer name ${gone}`)
}
assert.ok(!/built-in bash|read-only bash|bash where granted/.test(allRoles), "and they name `shell`, which is what v2 calls it")
assert.ok(allRoles.includes("`execute` (Code Mode)"), "the batching mandate names the tool v2 actually has")
// The delegation mandate, forked by MEASUREMENT: a live dispatch reached
// execute.before {tool:"subagent"} and permission.evaluate {action:"subagent"},
// so a lead told to call `task` is pointed at a tool it does not have — and on v2
// background needs no operator flag (the plugin forces it), so the v1 sentence
// about OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS would have the lead checking a
// switch that does not exist before delegating at all.
assert.ok(allRoles.includes("delegation goes through the host's `subagent`"), "delegation names the tool v2 actually exposes")
assert.ok(!/the host's `task`/.test(allRoles), "no mandate points at `task`, which is not on the v2 surface")
assert.ok(!allRoles.includes("OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS"), "the v1 background flag is not asked of a v2 lead")
assert.ok(allRoles.includes("forces `background: true` on EVERY dispatch"), "and it is told the shape is not its choice")
assert.ok(allRoles.includes("## Recon batching (Code Mode first)"), "and so does the specialist section heading")
// The LEDGER mandate needs the same fork: v2 has no `todowrite`, so a lead told
// to "create a todo list" has no named tool to do it with, and the statuses are a
// different enum than the host's.  A rule with no verb is the rule that quietly
// stops being followed.
const leadMd = fs.readFileSync(path.join(genRoot, "agents", "team.md"), "utf8")
assert.ok(leadMd.includes("`tm_ledger`"), "the v2 lead's LEDGER rule names the tool that holds the list")
assert.ok(!/todo list|TodoList|in_progress/.test(leadMd), "and never names todowrite's vocabulary, which this host does not have")
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
// Three things this suite learned the hard way, now pinned:
// (1) a throwing hook body may never break somebody's model request, and must
//     report that it threw rather than leaving an empty host to be inferred;
// (2) the message KEY NAMES are recorded — the real v2 shape is {info, parts[]} —
//     which is what any envelope detector has to walk into;
// (3) the counter uses the SAME parser the offload uses. Grepping for the v1
//     string made "0 envelopes" mean "wrong matcher", not "nothing was big".
{
  const f2 = makeFakeCtx({ directory: probeDir, agents: [] })
  const p2 = await applyV2Probe(f2.ctx, { env: {} })
  const body = "1：一\n".repeat(40)
  await f2
    .hook("session.context")
    .fire({
      agent: "team",
      tools: { read: {} },
      messages: [{ info: { role: "user" }, parts: [{ type: "text", text: `<subagent sessionID="ses_a" state="completed" description="读法">\n${body}\n</subagent>` }] }],
    })
  assert.deepEqual(p2.report.messageShapes[0]?.keys, ["info", "parts"], "the probe records the host's real message shape as key NAMES")
  assert.equal(p2.report.taskEnvelopes, 1, "a v2 envelope inside a text part is counted")
  assert.deepEqual([...p2.report.envelopeForms], ["v2-subagent"], "and labelled with the form the host actually used")
  assert.ok(p2.report.maxEnvelopeChars > 200, "its length is measured, so a threshold argument has a number behind it")
  await f2.hook("session.context").fire(null)
  assert.ok(
    p2.report.hooksMissing.some((h) => h.includes("callback-threw")),
    "a throwing observer body is swallowed AND reported — an observer that can break what it observes is not an observer",
  )
}
console.log(`   OK (4 hooks under host names, names/counts only, ${(rawProbe.match(/\n/g) ?? []).length} probe lines, missing seam reported)`)

console.log("8c. the capability matrix exists on v2 too, from observations")
{
  const { renderCapabilityMatrix } = await import("./dist/capabilities.js")
  const f3 = makeFakeCtx({ directory: probeDir, agents: [] })
  const p3 = await applyV2Probe(f3.ctx, { env: {} })
  const rows = (await import("./dist/host/v2-capabilities.js")).v2CapabilityRows({
    ctx: f3.ctx,
    probe: p3,
    guardsInstalled: true,
    backgroundForced: true,
    offload: { active: true, registrations: [{}], report: { seen: 3, offloaded: 1 } },
    sessionHooks: 2,
    temperature: 0.2,
    hasTodoSeam: false,
    hasAsk: false,
  })
  const md = renderCapabilityMatrix(rows)
  assert.ok(md.includes("session.hook(\"context\")") && md.includes("execute.after"), "the matrix names the v2 seams, not v1's SDK")
  assert.ok(md.includes("ctx.ask") && !/官方确认框.*\bok\b/.test(md), "the dialog seam is never greened on a host that has none")
  assert.ok(md.includes("todo"), "the missing goal seam is a row, not silence")
  // `declared` must not be wearable as `ok`: a hook that was attached but never
  // called is a different fact from one that ran, and after a host upgrade that
  // difference is the whole report.
  const ctxRow = rows.find((r) => r.seam.includes('session.hook("context")'))
  assert.equal(ctxRow.state, "declared", "with no request observed yet, the context seam is declared, NOT ok")
  await f3.hook("session.context").fire({ agent: "team", tools: { read: {} }, messages: [] })
  const after = (await import("./dist/host/v2-capabilities.js")).v2CapabilityRows({
    ctx: f3.ctx, probe: p3, guardsInstalled: true, backgroundForced: true,
    offload: { active: true, registrations: [{}], report: { seen: 3, offloaded: 1 } },
    sessionHooks: 2, temperature: 0.2, hasTodoSeam: false, hasAsk: false,
  })
  assert.equal(after.find((r) => r.seam.includes('session.hook("context")')).state, "ok", "one real request observed, and the row earns ok")
  assert.equal(after.find((r) => r.seam.includes("ctx.storage")).state, "declared", "a domain we have never written to stays declared, whatever else improved")
}
console.log("   OK (rows derived from observations, declared ≠ ok, missing seams named)")

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
